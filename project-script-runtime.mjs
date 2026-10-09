import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { InputError } from "./core.mjs";
import { validateScriptCommand } from "./project-inspection.mjs";
import { spawnProject } from "./project-platform.mjs";

function portOccupied(value, signal) {
  if (signal?.aborted) return Promise.resolve(false);
  const url = new URL(value);
  return new Promise((resolve) => {
    let finished = false;
    const socket = createConnection({ host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 80) });
    const finish = (occupied) => {
      if (finished) return;
      finished = true; signal?.removeEventListener("abort", abort); socket.destroy(); resolve(occupied);
    };
    const abort = () => finish(false);
    signal?.addEventListener("abort", abort, { once: true });
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function health(value, signal) {
  if (signal?.aborted) return { ready: false, occupied: false };
  try {
    const response = await fetch(value, { redirect: "manual", signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(750)]) : AbortSignal.timeout(750) });
    await response.body?.cancel();
    return { ready: response.ok, occupied: true };
  } catch {
    return { ready: false, occupied: await portOccupied(value, signal) };
  }
}

function drain(child) {
  child.stdout?.resume(); child.stderr?.resume();
}

function cancelled(run) {
  return run.monitorController?.signal.aborted || run.stopping || run.status === "stopped";
}

async function monitor(project, run, onReady) {
  const signal = run.monitorController.signal;
  while (!signal.aborted && !run.stopping && run.ownsService && !run.startupFailed) {
    const states = await Promise.all(project.launch.healthUrls.map((url) => health(url, signal)));
    if (cancelled(run) || run.startupFailed) return;
    const ready = states.every((state) => state.ready);
    if (ready && run.launcherExited && run.launcherExitCode === 0) {
      run.status = "running"; run.url = project.launch.url; run.error = null;
      if (!run.servicesReadyOnce) {
        run.servicesReadyOnce = true;
        try { await onReady?.(run); }
        catch { run.openError = "项目已运行，但窗口未能打开。请再次点击“打开项目”。"; }
      }
    } else if (run.servicesReadyOnce && !ready) {
      run.status = "failed"; run.url = null;
      run.error = "部分项目服务已停止响应，可以停止项目后重新打开。";
    }
    try { await delay(1000, undefined, { signal, ref: false }); }
    catch { return; }
  }
}

export async function startScriptServices(project, run, { spawnImpl = spawn, env, blockedPort, onReady, platform = process.platform,
  projectSpawn = (command, args, options) => spawnProject(command, args, options, { spawnImpl, platform }) } = {}) {
  run.background = true; run.ownsService = false;
  run.monitorController = new AbortController();
  if (run.stopping || run.status === "stopped") { run.monitorController.abort(); return run; }
  const addresses = [project.launch.url, ...project.launch.healthUrls];
  if (addresses.some((url) => Number(new URL(url).port || 80) === Number(blockedPort))) {
    throw new InputError("项目地址不能使用 NUEMA 自身的服务端口");
  }
  const states = await Promise.all(project.launch.healthUrls.map((url) => health(url, run.monitorController.signal)));
  if (cancelled(run)) return run;
  if (states.every((state) => state.ready)) {
    run.status = "external"; run.url = project.launch.url;
    try { await onReady?.(run); }
    catch { run.openError = "项目已在外部运行，但窗口未能打开。请再次点击“打开项目”。"; }
    return run;
  }
  if (states.some((state) => state.occupied)) throw new InputError("项目的部分端口已被占用。请先关闭已有服务，再重新打开项目。");
  run.ownsService = true;
  let child;
  try {
    const spawned = projectSpawn(project.launch.command, project.launch.args, {
      cwd: project.root, shell: false, detached: platform !== "win32", env, stdio: ["ignore", "pipe", "pipe"],
    });
    child = spawned?.then ? await spawned : spawned;
  } catch {
    run.status = "failed"; run.startupFailed = true; run.ownsService = false;
    throw new InputError("项目启动脚本未能执行，请检查本地运行环境。");
  }
  run.launcher = child; run.launcherExited = false; run.launcherExitCode = null;
  run.launcherDone = new Promise((resolve) => {
    const finish = (code, failed = false) => {
      if (run.launcherExited) return;
      run.launcherExited = true; run.launcherExitCode = code;
      if (failed && !child.pid) run.ownsService = false;
      if ((failed || code !== 0) && !cancelled(run)) {
        run.startupFailed = true; run.status = "failed"; run.url = null;
        const exit = Number.isInteger(code) ? `（退出码 ${code}）` : "";
        run.error = !run.ownsService ? "项目启动进程未能创建，请检查本地运行环境。"
          : Number.isInteger(code) ? `项目自身启动失败${exit}。请检查该项目的启动脚本或运行环境。已启动的服务可用“停止”清理。`
            : "项目启动脚本已中断，已启动的服务可用“停止”清理。";
      }
      resolve();
    };
    child.once("error", () => finish(null, true));
    child.once("launcherExit", (code) => finish(code));
    // Detached services may inherit the pipes, so close can occur much later than the launcher exit.
    child.once("exit", (code) => finish(code));
    child.once("close", (code) => finish(code));
  });
  drain(child);
  if (cancelled(run)) {
    if (child.stopTree) await child.stopTree();
    else await finishLauncher(run);
    return run;
  }
  run.monitorPromise = monitor(project, run, onReady).catch(() => {
    if (!cancelled(run)) {
      run.status = "failed"; run.error = "无法确认项目服务状态，可以停止项目后重试。";
    }
  });
  return run;
}

async function finishLauncher(run) {
  if (run.launcher?.jobManaged) return;
  if (!run.launcher || run.launcherExited) return;
  try { run.launcher.kill("SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  let timer;
  await Promise.race([run.launcherDone, new Promise((resolve) => { timer = setTimeout(resolve, 1000); timer.unref(); })]);
  clearTimeout(timer);
  if (!run.launcherExited) {
    try { run.launcher.kill("SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    await run.launcherDone;
  }
}

async function executeStop(project, launch, projectSpawn, env) {
  let child;
  try {
    const spawned = projectSpawn(launch.command, launch.args, { cwd: project.root, shell: false, detached: false,
      env, stdio: ["ignore", "pipe", "pipe"] });
    child = spawned?.then ? await spawned : spawned;
  }
  catch { throw new InputError("项目停止脚本未能执行，请检查本地运行环境。"); }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* Best effort after timeout; retain ownership for retry. */ }
      reject(new InputError("项目停止脚本超时，仍保留运行记录，可以再次尝试停止。"));
    }, 10_000); timer.unref();
    drain(child);
    child.once("error", () => { clearTimeout(timer); reject(new InputError("项目停止脚本未能执行，请检查本地运行环境。")); });
    child.once("exit", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new InputError("项目停止脚本执行失败，仍保留运行记录，可以再次尝试停止。")); });
  });
}

export async function stopScriptServices(project, run, { spawnImpl = spawn, env, platform = process.platform,
  projectSpawn = (command, args, options) => spawnProject(command, args, options, { spawnImpl, platform }) } = {}) {
  if (run.stopPromise) return run.stopPromise;
  run.stopping = true; run.monitorController?.abort();
  run.stopPromise = (async () => {
    if (!run.ownsService) {
      if (run.status === "starting") { run.status = "stopped"; run.url = null; }
      return run;
    }
    try {
      await finishLauncher(run);
      const stop = await validateScriptCommand(project.root, project.launch.stop, { platform });
      await executeStop(project, stop, projectSpawn, env);
      if (run.launcher?.stopTree) await run.launcher.stopTree();
      for (let attempt = 0; attempt < 5; attempt++) {
        const occupied = await Promise.all(project.launch.healthUrls.map((url) => portOccupied(url)));
        if (occupied.every((value) => !value)) {
          run.status = "stopped"; run.url = null; run.pageOpened = false; run.openError = null; run.error = null; run.ownsService = false;
          return run;
        }
        if (attempt < 4) await delay(150);
      }
      throw new InputError("停止脚本已执行，但仍有项目端口被占用，运行记录已保留，请检查后重试。");
    } catch (error) {
      run.status = "failed";
      run.error = error instanceof InputError ? error.message : "未能停止项目服务，运行记录已保留，可以再次尝试。";
      throw new InputError(run.error);
    }
  })().finally(() => { run.stopping = false; run.stopPromise = null; });
  return run.stopPromise;
}
