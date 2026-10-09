import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { APP_VERSION } from "./app-metadata.mjs";
import { acquireDataLock, DataDirectoryBusyError } from "./instance-lock.mjs";
import { getProviderConfig } from "./providers.mjs";

async function readLocalFile(path, maxBytes = 65536) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxBytes) throw new Error();
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const current = await file.stat();
      if (!current.isFile() || current.nlink !== 1 || current.size > maxBytes) throw new Error();
      return await file.readFile("utf8");
    } finally { await file.close(); }
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("本机配置无法读取，请保留原文件并检查文件格式和权限。");
  }
}

export async function readInstallationSettings(dataDir) {
  const content = await readLocalFile(resolve(dataDir, "installation.json"));
  if (content === null) return {};
  try {
    const value = JSON.parse(content);
    if (value.version !== 1 || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error();
    return { port: value.port };
  } catch { throw new Error("启动设置无法读取，请保留 installation.json 并检查后重试。"); }
}

async function saveInstallationSettings(dataDir, port) {
  const path = resolve(dataDir, "installation.json");
  await readLocalFile(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify({ version: 1, port }, null, 2) + "\n"); }
    finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function providerConfig(envPath, env) {
  const content = await readLocalFile(envPath);
  let settings = {};
  try { if (content !== null) settings = parseEnv(content); }
  catch { throw new Error("模型配置文件无法解析，请保留原文件并在设置中重新填写。"); }
  return getProviderConfig({ ...settings, ...env });
}

function closeServer(server) {
  return new Promise((done, reject) => {
    server.close((error) => error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : done());
    server.closeIdleConnections();
  });
}

export async function startLocalApplication({ dataDir, port, envPath = resolve(dataDir, ".env"),
  env = process.env, config, rememberPort = false, createHandler,
  signal } = {}) {
  const instanceId = randomUUID();
  const lock = await acquireDataLock(dataDir, { instance: { instanceId, version: APP_VERSION } });
  let handler;
  let startup = "starting";
  const server = createServer((request, response) => {
    if (handler && startup === "ready") return void handler(request, response);
    response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ ok: false, state: startup, instanceId, version: APP_VERSION }));
  });
  let shutdown;
  const dispose = () => {
    shutdown ??= (async () => {
      startup = "stopping";
      lock.update({ state: "stopping" });
      const errors = [];
      // Stop accepting work before cancelling tasks; active requests receive cancellation.
      const closing = closeServer(server);
      closing.catch(() => {});
      try { await handler?.dispose?.(); } catch (error) { errors.push(error); }
      server.closeAllConnections();
      try { await closing; } catch (error) { errors.push(error); }
      try { await lock.release(); } catch (error) { errors.push(error); }
      startup = "stopped";
      if (errors.length) throw new AggregateError(errors, "关闭 NEUMA 时未能完成全部清理");
    })();
    return shutdown;
  };
  const interrupted = () => { startup = "stopping"; };
  signal?.addEventListener("abort", interrupted, { once: true });
  try {
    signal?.throwIfAborted();
    const settings = await readInstallationSettings(lock.dataDir);
    const selectedPort = port ?? settings.port ?? 3000;
    if (!Number.isInteger(selectedPort) || selectedPort < 0 || selectedPort > 65535) throw new Error("端口必须是 1 到 65535 的整数。");
    await new Promise((done, reject) => {
      const failed = (error) => { server.removeListener("listening", listening); reject(error); };
      const listening = () => { server.removeListener("error", failed); done(); };
      server.once("error", failed);
      server.once("listening", listening);
      server.listen({ host: "127.0.0.1", port: selectedPort, exclusive: true });
    });
    server.on("error", () => {});
    signal?.throwIfAborted();
    // Constructors may recover persisted task states, so they run only after both locks.
    await mkdir(lock.dataDir, { recursive: true, mode: 0o700 });
    signal?.throwIfAborted();
    const actualPort = server.address().port;
    lock.update({ port: actualPort });
    const activeConfig = config ?? await providerConfig(envPath, env);
    const handlerFactory = createHandler ?? (await import("./server.mjs")).createRequestHandler;
    signal?.throwIfAborted();
    handler = handlerFactory({ dataDir: lock.dataDir, envPath,
      config: activeConfig, port: actualPort, instanceId });
    await handler.ready;
    signal?.throwIfAborted();
    if (rememberPort && selectedPort !== 0) await saveInstallationSettings(lock.dataDir, actualPort);
    signal?.throwIfAborted();
    startup = "ready";
    lock.update({ state: "ready" });
    return { server, port: actualPort, url: `http://127.0.0.1:${actualPort}/`,
      dataDir: lock.dataDir, instanceId, dispose };
  } catch (error) {
    await dispose().catch(() => {});
    if (error.code === "EADDRINUSE") throw new Error("这个端口已被其他程序占用，请使用 neuma --port <其他端口>。");
    throw error;
  } finally { signal?.removeEventListener("abort", interrupted); }
}

export function installShutdownSignals({ abort, getApplication, output = process.stderr } = {}) {
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    abort?.();
    output.write("正在保存并关闭 NEUMA…\n");
    Promise.resolve(getApplication()?.dispose()).catch(() => {
      output.write("部分清理未能完成，请保留数据并运行 neuma doctor。\n");
      process.exitCode = 1;
    });
  };
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);
  return () => { for (const signal of ["SIGINT", "SIGTERM"]) process.removeListener(signal, stop); };
}

export async function runSourceApplication({ root, createHandler }) {
  let application;
  const controller = new AbortController();
  const removeSignals = installShutdownSignals({ abort: () => controller.abort(), getApplication: () => application });
  try {
    application = await startLocalApplication({ dataDir: resolve(root, ".neuma"),
      envPath: resolve(root, ".env"), port: Number(process.env.PORT || 3000), signal: controller.signal, createHandler });
    application.server.once("close", removeSignals);
    process.stdout.write(`NUEMA Agent 运行测试版：${application.url}\n`);
  } catch (error) {
    removeSignals();
    process.stderr.write(`${error instanceof DataDirectoryBusyError ? error.message : controller.signal.aborted ? "NEUMA 启动已取消。" : error.message}\n`);
    process.exitCode = controller.signal.aborted ? 0 : 1;
  }
}
