import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { request } from "node:http";
import { APP_VERSION } from "./app-metadata.mjs";
import { DataDirectoryBusyError } from "./instance-lock.mjs";
import { installShutdownSignals, startLocalApplication } from "./installation-runtime.mjs";

const HELP = `NEUMA ${APP_VERSION}

用法：
  neuma                         启动服务并打开浏览器；Ctrl+C 停止
  neuma --no-open                启动服务，不自动打开浏览器
  neuma --port 3010              使用并保存指定端口
  neuma --data-dir <目录>        使用独立的数据目录
  neuma doctor                  检查系统与安全执行能力
  neuma migrate --from <源码目录>  复制旧数据；请先关闭旧服务
  neuma --help                  显示帮助
  neuma --version               显示版本

需要 Node.js 22.19 或更新版本。默认数据目录：用户主目录下的 .neuma。
更新后重新启动；更新与卸载程序均不会删除用户数据。
`;

export function parseCliArgs(args, { home = homedir() } = {}) {
  if (args.some((value, index) => value === "--port" && /^-\d/.test(args[index + 1] ?? "")))
    throw new Error("端口必须是 1 到 65535 的整数。");
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: {
      help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" },
      "no-open": { type: "boolean" }, port: { type: "string" },
      "data-dir": { type: "string" }, from: { type: "string" },
    } });
  } catch { throw new Error("命令参数无法识别，请运行 neuma --help 查看用法。"); }
  const { values, positionals } = parsed;
  const command = positionals[0] ?? "start";
  if (positionals.length > 1 || !["start", "doctor", "migrate"].includes(command)) throw new Error("命令无法识别，请运行 neuma --help 查看用法。");
  if (values["data-dir"] !== undefined && (!values["data-dir"].trim() || values["data-dir"].includes("\0"))) throw new Error("请提供有效的数据目录。");
  let port;
  if (values.port !== undefined) {
    if (!/^\d{1,5}$/.test(values.port) || Number(values.port) < 1 || Number(values.port) > 65535) throw new Error("端口必须是 1 到 65535 的整数。");
    port = Number(values.port);
    if (command !== "start") throw new Error("--port 只用于启动服务。");
  }
  if (values.from !== undefined && command !== "migrate") throw new Error("--from 只用于迁移。");
  if (command === "migrate" && !values.help && !values.version && !values.from?.trim()) throw new Error("迁移需要 --from <源码目录>；请先关闭旧服务。");
  return { command, help: values.help, version: values.version, open: !values["no-open"], port,
    dataDir: resolve(values["data-dir"] ?? resolve(home, ".neuma")), from: values.from };
}

async function existingInstanceReady(instance) {
  if (instance.purpose !== "service" || instance.state !== "ready" || !Number.isInteger(instance.port)) return false;
  return new Promise((done) => {
    const client = request({ hostname: "127.0.0.1", port: instance.port, path: "/api/health", agent: false,
      timeout: 1500 }, (response) => {
      const chunks = []; let size = 0;
      response.on("data", (chunk) => { size += chunk.length; if (size > 4096) response.destroy(); else chunks.push(chunk); });
      response.on("error", () => done(false));
      response.on("end", () => {
        try {
          const health = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          done(response.statusCode === 200 && health.ok === true && health.state === "ready" && health.instanceId === instance.instanceId);
        } catch { done(false); }
      });
    });
    const deadline = setTimeout(() => client.destroy(new Error("实例探测超时")), 1500);
    client.once("close", () => clearTimeout(deadline));
    client.on("timeout", () => client.destroy()); client.on("error", () => done(false)); client.end();
  });
}

async function openPage(url, output) {
  try {
    const { openProjectPage } = await import("./projects.mjs");
    await openProjectPage(url);
  } catch { output.write(`浏览器未能自动打开，请访问 ${url}\n`); }
}

export async function runCli(args = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  let options;
  try { options = parseCliArgs(args); }
  catch (error) { stderr.write(`${error.message}\n`); process.exitCode = 1; return; }
  if (options.help) { stdout.write(HELP); return; }
  if (options.version) { stdout.write(`${APP_VERSION}\n`); return; }
  if (options.command === "doctor") {
    const { DevelopmentExecutor } = await import("./development-executor.mjs");
    const executor = new DevelopmentExecutor();
    const isolation = await executor.probe();
    stdout.write(`NEUMA ${APP_VERSION}；Node.js ${process.versions.node}；${process.platform}/${process.arch}\n`);
    stdout.write(`数据目录：${options.dataDir}\n`);
    stdout.write(`安全执行：${isolation.available ? "探测通过" : "不可用，生成程序将被阻止执行"}\n`);
    if (isolation.reason) stdout.write(`${isolation.reason}\n`);
    if (!isolation.available) process.exitCode = 1;
    if (["win32", "linux"].includes(process.platform)) {
      try {
        const { requireProjectHelper } = await import("./project-platform.mjs");
        await requireProjectHelper(); stdout.write("项目与文件夹辅助程序：已安装\n");
      } catch { stdout.write("项目与文件夹辅助程序：缺失，请使用完整安装包。\n"); process.exitCode = 1; }
    }
    return;
  }
  let application;
  const controller = new AbortController();
  const removeSignals = installShutdownSignals({ abort: () => controller.abort(), getApplication: () => application, output: stderr });
  try {
    if (options.command === "migrate") {
      const { migrateInstallation } = await import("./installation-migration.mjs");
      const result = await migrateInstallation({ from: options.from, dataDir: options.dataDir, signal: controller.signal });
      stdout.write(`已复制 ${result.agents} 个 Agent，${result.files} 个文件到 ${result.dataDir}。\n源文件已保留；模型配置请在新设置页重新填写。SDK 临时数据和凭据未复制。\n`);
      removeSignals();
      return;
    }
    try {
      application = await startLocalApplication({ dataDir: options.dataDir, port: options.port,
        rememberPort: options.port !== undefined, signal: controller.signal });
    } catch (error) {
      if (!(error instanceof DataDirectoryBusyError) || controller.signal.aborted ||
        (options.port !== undefined && options.port !== error.instance.port) || !await existingInstanceReady(error.instance)) throw error;
      const url = `http://127.0.0.1:${error.instance.port}/`;
      stdout.write(`这个数据目录的 NEUMA 已在运行：${url}\n`);
      if (options.open) await openPage(url, stderr);
      removeSignals();
      return;
    }
    application.server.once("close", removeSignals);
    stdout.write(`NEUMA ${APP_VERSION}：${application.url}\n数据目录：${application.dataDir}\n保持终端打开，按 Ctrl+C 停止。\n`);
    if (options.open && !controller.signal.aborted) await openPage(application.url, stderr);
  } catch (error) {
    removeSignals();
    stderr.write(`${controller.signal.aborted ? "NEUMA 操作已取消。" : error.message}\n`);
    process.exitCode = controller.signal.aborted ? 0 : 1;
  }
}
