import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { acquireDataLock, DataDirectoryBusyError } from "../instance-lock.mjs";
import { parseCliArgs } from "../installation-cli.mjs";
import { readInstallationSettings, startLocalApplication } from "../installation-runtime.mjs";

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), "neuma-install-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function stubHandler({ instanceId }) {
  const handler = (_req, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true, state: "ready", instanceId })); };
  handler.ready = Promise.resolve();
  handler.dispose = async () => {};
  return handler;
}

test("CLI 校验端口和迁移参数，独立于启动时所在目录", () => {
  const args = parseCliArgs([], { home: "/test-home" });
  assert.equal(args.command, "start"); assert.equal(args.open, true);
  assert.equal(args.dataDir, join("/test-home", ".neuma"));
  assert.equal(parseCliArgs(["--port", "3010", "--no-open"]).port, 3010);
  assert.equal(parseCliArgs(["--no-open"]).open, false);
  for (const port of ["0", "65536", "3.1", "3000abc", "-1"]) assert.throws(() => parseCliArgs(["--port", port]), /端口/);
  assert.throws(() => parseCliArgs(["migrate"]), /--from/);
  assert.throws(() => parseCliArgs(["unknown"]), /命令/);
  assert.throws(() => parseCliArgs(["--from", "source"]), /迁移/);
  assert.equal(parseCliArgs(["migrate", "--help"]).help, true);
});

test("数据锁在目录创建前互斥，释放后可以再次取得", async (t) => {
  const root = await temporary(t), dataDir = join(root, "尚未创建 空格");
  const first = await acquireDataLock(dataDir, { instance: { instanceId: "first" } });
  t.after(() => first.release());
  await assert.rejects(acquireDataLock(dataDir), (error) => error instanceof DataDirectoryBusyError && error.instance.instanceId === "first");
  assert.deepEqual(await readdir(root), []);
  await first.release();
  const second = await acquireDataLock(dataDir); await second.release();
  await first.release();
});

test("端口冲突时不创建存储，也不修改数据目录", async (t) => {
  const root = await temporary(t), dataDir = join(root, "data");
  const occupying = createServer(); occupying.listen(0, "127.0.0.1"); await once(occupying, "listening");
  t.after(() => new Promise((done) => occupying.close(done)));
  let created = false;
  await assert.rejects(startLocalApplication({ dataDir, port: occupying.address().port,
    env: {}, createHandler() { created = true; return stubHandler({}); } }), /端口/);
  assert.equal(created, false); assert.deepEqual(await readdir(root), []);
  const lock = await acquireDataLock(dataDir); await lock.release();
});

test("就绪前返回503，初始化完成后才可用，关闭只清理一次", async (t) => {
  const root = await temporary(t);
  let release, observedPort, disposed = 0, entered;
  const enteredHandler = new Promise((done) => { entered = done; });
  const ready = new Promise((done) => { release = done; });
  const pending = startLocalApplication({ dataDir: root, port: 0, env: {}, createHandler(options) {
    observedPort = options.port;
    const handler = stubHandler(options); handler.ready = ready;
    handler.dispose = async () => { disposed++; }; entered(); return handler;
  } });
  await enteredHandler;
  assert.equal((await fetch(`http://127.0.0.1:${observedPort}/api/health`)).status, 503);
  release(); const app = await pending; t.after(() => app.dispose());
  assert.equal((await fetch(`${app.url}api/health`)).status, 200);
  await Promise.all([app.dispose(), app.dispose()]); assert.equal(disposed, 1);
  const lock = await acquireDataLock(root); await lock.release();
});

test("初始化失败清理实例锁和端口，原配置不变", async (t) => {
  const root = await temporary(t);
  await writeFile(join(root, "installation.json"), JSON.stringify({ version: 1, port: 3000 }));
  const before = await readFile(join(root, "installation.json"), "utf8");
  let port, disposed = 0;
  await assert.rejects(startLocalApplication({ dataDir: root, port: 0, env: {}, createHandler(options) {
    port = options.port; const handler = stubHandler(options);
    handler.ready = Promise.reject(new Error("合成存储损坏")); handler.dispose = async () => { disposed++; }; return handler;
  } }), /合成存储损坏/);
  assert.equal(disposed, 1); assert.equal(await readFile(join(root, "installation.json"), "utf8"), before);
  const lock = await acquireDataLock(root); await lock.release();
  const server = createServer(); server.listen(port, "127.0.0.1"); await once(server, "listening"); await new Promise((done) => server.close(done));
});

test("明确指定端口保存为下次默认，不读取模型凭据到测试输出", async (t) => {
  const root = await temporary(t);
  const reserved = createServer(); reserved.listen(0, "127.0.0.1"); await once(reserved, "listening");
  const port = reserved.address().port; await new Promise((done) => reserved.close(done));
  const first = await startLocalApplication({ dataDir: root, port, rememberPort: true, env: {}, createHandler: stubHandler });
  await first.dispose(); assert.deepEqual(await readInstallationSettings(root), { port });
  const second = await startLocalApplication({ dataDir: root, env: {}, createHandler: stubHandler });
  assert.equal(second.port, port); await second.dispose();
});

test("实际CLI从中文空格目录启动，重复启动复用，Ctrl+C退出", {
  timeout: 15000, skip: process.platform === "win32" && "Windows kill(SIGINT) 是强制终止；需要真实控制台 Ctrl+C 验收",
}, async (t) => {
  const root = await temporary(t), dataDir = join(root, "用户 数据");
  const cli = fileURLToPath(new URL("../bin/neuma.cjs", import.meta.url));
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = reservation.address().port; await new Promise((done) => reservation.close(done));
  const childOptions = { cwd: root, env: { PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT, NODE_OPTIONS: "--max-old-space-size=128" }, stdio: ["ignore", "pipe", "pipe"] };
  const child = spawn(process.execPath, [cli, "--no-open", "--data-dir", dataDir, "--port", String(port)], childOptions);
  let output = "", error = "";
  child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { error += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`CLI 未就绪：${error}`)), 8000);
    const data = () => { if (output.includes("Ctrl+C")) { clearTimeout(timer); child.stdout.removeListener("data", data); done(); } };
    child.stdout.on("data", data);
    child.once("exit", (code) => { clearTimeout(timer); if (!output.includes("Ctrl+C")) reject(new Error(`CLI提前退出${code}：${error}`)); });
    data();
  });
  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  assert.equal(health.state, "ready"); assert.equal(health.llmConfigured, false);
  const duplicate = spawn(process.execPath, [cli, "--no-open", "--data-dir", dataDir], childOptions);
  let duplicateOutput = ""; duplicate.stdout.on("data", (chunk) => { duplicateOutput += chunk; });
  assert.equal((await once(duplicate, "exit"))[0], 0); assert.match(duplicateOutput, /已在运行/);
  const ended = once(child, "exit"); child.kill("SIGINT"); assert.equal((await ended)[0], 0);
  assert.equal(await readInstallationSettings(dataDir).then((value) => value.port), port);
});

test("源码入口可以启动，不被循环模块等待卡住", {
  timeout: 15000, skip: process.platform === "win32" && "Windows 真实控制台 Ctrl+C 另行验收",
}, async (t) => {
  const root = await temporary(t);
  const source = fileURLToPath(new URL("../", import.meta.url));
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name.endsWith(".mjs") || entry.name === "package.json"))
      await copyFile(join(source, entry.name), join(root, entry.name));
  }
  const child = spawn(process.execPath, [join(root, "server.mjs")], { cwd: root,
    env: { PATH: process.env.PATH, PORT: "0", NODE_OPTIONS: "--max-old-space-size=128" },
    stdio: ["ignore", "pipe", "pipe"] });
  let output = "", error = "";
  child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { error += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const url = await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`源码入口未启动：${error}`)), 8000);
    const received = () => {
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (match) { clearTimeout(timer); child.stdout.removeListener("data", received); done(match[0]); }
    };
    child.stdout.on("data", received);
    child.once("exit", (code) => { clearTimeout(timer); if (!output.includes("http://")) reject(new Error(`源码提前退出${code}：${error}`)); });
    received();
  });
  assert.equal((await fetch(`${url}api/health`)).status, 200);
  const exited = once(child, "exit"); child.kill("SIGINT"); assert.equal((await exited)[0], 0);
});

test("启动等待期间取消，初始化结束后不发布实例并释放锁", async (t) => {
  const root = await temporary(t), controller = new AbortController();
  let entered, ready, disposed = 0;
  const started = new Promise((done) => { entered = done; });
  const pending = startLocalApplication({ dataDir: root, port: 0, env: {}, signal: controller.signal,
    createHandler(options) {
      const handler = stubHandler(options);
      handler.ready = new Promise((done) => { ready = done; });
      handler.dispose = async () => { disposed++; };
      entered(); return handler;
    } });
  await started; controller.abort(); ready(); await assert.rejects(pending, { name: "AbortError" });
  assert.equal(disposed, 1); const lock = await acquireDataLock(root); await lock.release();
});
