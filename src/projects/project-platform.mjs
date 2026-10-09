import { spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, extname, join, delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { InputError } from "../requirements/core.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENV_KEYS = new Set(["PATH", "HOME", "USER", "LANG", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATHEXT"]);
const DESKTOP_KEYS = new Set(["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XDG_CURRENT_DESKTOP"]);

export function projectEnvironment(source = process.env, { desktop = false } = {}) {
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => value
    && (ENV_KEYS.has(key.toUpperCase()) || desktop && DESKTOP_KEYS.has(key.toUpperCase()))));
}

export function projectHelperPath({ platform = process.platform, arch = process.arch } = {}) {
  if (!["win32", "linux"].includes(platform) || !["x64", "arm64"].includes(arch)) throw new InputError("当前系统没有可用的项目管理辅助程序。");
  return join(ROOT, "native", "projects", "bin", `${platform}-${arch}`, platform === "win32" ? "neuma-projects.exe" : "neuma-projects");
}

export async function requireProjectHelper(options = {}) {
  const path = options.helperPath || projectHelperPath(options);
  try { await access(path, constants.X_OK); }
  catch { throw new InputError("项目管理辅助程序尚未安装，请使用包含对应平台程序的完整 NEUMA 安装包。"); }
  return path;
}

async function isFile(path) {
  try { await access(path, constants.R_OK); return await realpath(path); } catch { return null; }
}

// Package-manager .cmd shims are not executable files. Prefer their real Node entry point.
export async function resolveProjectProgram(command, args, { platform = process.platform, env = projectEnvironment(), nodePath = process.execPath } = {}) {
  if (command === "node") return { command: nodePath, args };
  if (platform !== "win32" || !["npm", "pnpm", "yarn"].includes(command)) return { command, args };
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] || "";
  const bases = [...new Set([dirname(nodePath), ...pathValue.split(platform === "win32" ? ";" : delimiter).filter(Boolean)])];
  const entries = { npm: ["npm/bin/npm-cli.js", "corepack/dist/npm.js"], pnpm: ["pnpm/bin/pnpm.cjs", "corepack/dist/pnpm.js"], yarn: ["yarn/bin/yarn.js", "corepack/dist/yarn.js"] };
  for (const base of bases) {
    for (const entry of entries[command]) for (const parent of [join(base, "node_modules"), join(base, "..")]) {
      const cli = await isFile(join(parent, entry));
      if (cli) return { command: nodePath, args: [cli, ...args] };
    }
    const executable = await isFile(join(base, `${command}.exe`));
    if (executable) return { command: executable, args };
  }
  throw new InputError(`没有找到 ${command} 的可执行入口，请确认该项目的包管理器已经安装。`);
}

export function validateBatchArguments(args) {
  // cmd expands % variables even inside quoted strings. Refuse such arguments instead of changing their meaning.
  if (args.some((arg) => typeof arg !== "string" || /[%"\r\n\0]/.test(arg))) {
    throw new InputError("Windows 批处理参数不能含百分号、双引号或换行，请使用项目的 Node 或 PowerShell 入口。");
  }
}

function supervisedChild(supervisor, { stopTimeoutMs = 3000, killTimeoutMs = 1000 } = {}) {
  const child = new EventEmitter();
  // A spawn failure can arrive before an asynchronous caller installs its error handler.
  child.on("error", () => {});
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.pid = null; child.exitCode = null; child.signalCode = null;
  child.managedPids = []; child.supervisor = supervisor; child.jobManaged = true;
  let buffer = "", finished = false, launcherExited = false, stopRequested = false, forced = false, treeEmpty = false, stopPromise;
  const stopError = () => new InputError("未能确认项目进程树已全部停止，请重新查询运行状态。");
  const forceSupervisor = () => {
    if (finished || forced) return;
    forced = true;
    try { supervisor.kill("SIGKILL"); } catch { /* A close event is still required; kill success is not termination proof. */ }
  };
  const finish = (code, signal) => {
    if (finished) return;
    finished = true; child.exitCode = code; child.signalCode = signal;
    child.stdout.end(); child.stderr.end(); child.emit("exit", code, signal); child.emit("close", code, signal);
  };
  child.kill = () => {
    if (finished || stopRequested) return false;
    stopRequested = true;
    if (!supervisor.stdin || supervisor.stdin.destroyed || supervisor.stdin.writableEnded) forceSupervisor();
    else {
      try { supervisor.stdin.end("stop\n"); } catch { forceSupervisor(); }
    }
    return true;
  };
  supervisor.stdin?.on("error", () => { if (stopRequested) forceSupervisor(); });
  child.stopTree = () => {
    if (stopPromise) return stopPromise;
    if (finished) return treeEmpty ? Promise.resolve() : Promise.reject(stopError());
    stopPromise = new Promise((resolve, reject) => {
      let deadline;
      const cleanup = () => { clearTimeout(grace); clearTimeout(deadline); child.removeListener("close", closed); };
      const closed = () => { cleanup(); treeEmpty ? resolve() : reject(stopError()); };
      child.once("close", closed);
      const grace = setTimeout(() => {
        forceSupervisor();
        if (finished) return;
        deadline = setTimeout(() => { cleanup(); reject(stopError()); }, killTimeoutMs);
      }, stopTimeoutMs);
      child.kill();
    });
    return stopPromise;
  };
  supervisor.stdout?.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (buffer.length > 256 * 1024) { child.emit("error", new InputError("项目管理辅助程序响应过大。")); child.kill(); return; }
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      let frame;
      try { frame = JSON.parse(line); } catch { child.emit("error", new InputError("项目管理辅助程序返回了无效状态。")); child.kill(); continue; }
      if (frame.event === "started" && Number.isSafeInteger(frame.pid) && frame.pid > 0) { child.pid = frame.pid; child.managedPids = [frame.pid]; child.emit("spawn"); }
      else if (frame.event === "members" && Array.isArray(frame.pids)) child.managedPids = frame.pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0);
      else if (frame.event === "stdout" && typeof frame.data === "string") child.stdout.write(Buffer.from(frame.data, "base64"));
      else if (frame.event === "stderr" && typeof frame.data === "string") child.stderr.write(Buffer.from(frame.data, "base64"));
      else if (frame.event === "launcherExit" && !launcherExited) { launcherExited = true; child.emit("launcherExit", frame.code); }
      else if (frame.event === "treeEmpty") treeEmpty = true;
      else if (frame.event === "error") { child.emit("error", new InputError("项目启动进程未能创建，请检查本地运行环境。")); child.kill(); }
    }
  });
  supervisor.stderr?.resume();
  supervisor.once("error", (error) => { child.emit("error", error); finish(null, null); });
  supervisor.once("close", (code, signal) => finish(code, signal));
  return child;
}

export function spawnProject(command, args, options = {}, { spawnImpl = spawn, platform = process.platform, helperPath, nodePath = process.execPath,
  stopTimeoutMs = 3000, killTimeoutMs = 1000 } = {}) {
  if (platform !== "win32") {
    const child = spawnImpl(command === "node" ? nodePath : command, args, options);
    child.once("close", () => { child.neumaClosed = true; });
    return child;
  }
  return (async () => {
    const resolved = await resolveProjectProgram(command, args, { platform, env: options.env, nodePath });
    if ([".cmd", ".bat"].includes(extname(resolved.command).toLowerCase())) validateBatchArguments([resolved.command, ...resolved.args]);
    const helper = await requireProjectHelper({ platform, helperPath });
    const supervisor = spawnImpl(helper, ["manage", options.cwd, resolved.command, ...resolved.args], {
      ...options, detached: false, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    return supervisedChild(supervisor, { stopTimeoutMs, killTimeoutMs });
  })();
}

export async function stopProjectProcess(child, { platform = process.platform } = {}) {
  if (!child) return;
  if (child.stopTree) return child.stopTree();
  if (!child.pid || child.neumaClosed) return;
  if (platform === "win32") throw new InputError("该项目未由进程树管理器托管，无法安全停止全部服务。");
  let timer;
  const closed = new Promise((resolve) => child.once("close", resolve));
  const kill = (signal) => {
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  kill("SIGTERM");
  timer = setTimeout(() => kill("SIGKILL"), 1500); timer.unref();
  try { await closed; } finally { clearTimeout(timer); }
}
