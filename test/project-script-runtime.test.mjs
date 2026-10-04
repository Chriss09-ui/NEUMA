import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { validateProjectPlan } from "../project-inspection.mjs";
import { startScriptServices, stopScriptServices } from "../project-script-runtime.mjs";
import { ProjectManager } from "../projects.mjs";

const env = Object.fromEntries(["PATH", "HOME", "LANG", "TMPDIR"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));

async function availablePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(check, timeout = 4000) {
  const until = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() >= until) assert.fail("临时服务未在预期时间内进入目标状态");
    await delay(20);
  }
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nuema-script-runtime-")));
  const ports = [await availablePort(), await availablePort()];
  await writeFile(join(root, "service.mjs"), `import {createServer} from 'node:http'; import {writeFileSync} from 'node:fs';
const server=createServer((req,res)=>res.end('fixture-ready'));
server.listen(Number(process.argv[2]),'127.0.0.1',()=>writeFileSync(process.argv[3],String(process.pid)+'\\n'));
process.on('SIGTERM',()=>{server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),300).unref();});`);
  const node = `'${process.execPath.replaceAll("'", "'\\''")}'`;
  await writeFile(join(root, "start.sh"), `#!/bin/bash
cd -- "$(dirname -- "$0")"
case "$1" in
start)
  ${node} service.mjs ${ports[0]} service1.pid >/dev/null 2>&1 &
  ${node} service.mjs ${ports[1]} service2.pid >/dev/null 2>&1 &
  if [ -f slow-launch ]; then sleep 0.5; fi
  ;;
stop)
  if [ -f fail-stop ]; then exit 1; fi
  for pidFile in service1.pid service2.pid; do
    if [ -f "$pidFile" ]; then read -r servicePID < "$pidFile"; kill "$servicePID" 2>/dev/null || true; fi
  done
  ;;
esac
`);
  const urls = ports.map((port) => `http://127.0.0.1:${port}/health`);
  const project = await validateProjectPlan({ root, kind: "other" }, { status: "ready", summary: "临时双服务测试", kind: "script",
    command: "bash", args: ["start.sh", "start"], background: true, stop: { command: "bash", args: ["start.sh", "stop"] },
    url: `http://127.0.0.1:${ports[0]}/`, healthUrls: urls });
  const run = { status: "starting", url: null };
  t.after(async () => {
    await rm(join(root, "fail-stop"), { force: true });
    try { await stopScriptServices(project, run, { env }); } catch { /* Fallback only targets this fixture's saved PIDs. */ }
    for (const name of ["service1.pid", "service2.pid"]) {
      try { process.kill(Number((await readFile(join(root, name), "utf8")).trim()), "SIGTERM"); } catch { /* Already stopped. */ }
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, project, run, urls, ports };
}

test("后台启动脚本退出后仍管理双服务，全部就绪才打开并使用停止脚本关闭", async (t) => {
  const { project, run, urls } = await fixture(t);
  let opened = 0, stopCalls = 0;
  const spawnImpl = (...args) => { if (args[1].at(-1) === "stop") stopCalls++; return spawn(...args); };
  await startScriptServices(project, run, { env, spawnImpl, onReady: () => { opened++; } });
  await waitFor(() => run.status === "running");
  assert.equal(run.launcherExited, true); assert.equal(run.launcherExitCode, 0);
  assert.equal(run.ownsService, true); assert.equal(opened, 1);
  for (const url of urls) assert.equal(await (await fetch(url)).text(), "fixture-ready");
  await Promise.all([stopScriptServices(project, run, { env, spawnImpl }), stopScriptServices(project, run, { env, spawnImpl })]);
  assert.equal(stopCalls, 1); assert.equal(run.status, "stopped"); assert.equal(run.ownsService, false);
  for (const url of urls) await assert.rejects(fetch(url));
});

test("项目管理器可登记后台脚本、正确显示托管状态并完整停止，编辑配置保留生命周期", async (t) => {
  const { root, project } = await fixture(t);
  let opened = 0;
  const manager = new ProjectManager({ dataDir: join(root, "manager-data"), analyzeProject: async () => project,
    openBrowser: async () => { opened++; },
    scanRuntime: async () => ({ checkedAt: new Date().toISOString(), ports: [], processes: [], warnings: [], complete: true }) });
  try {
    const added = await manager.add({ path: root });
    assert.equal(added.kind, "script"); assert.equal(added.canLaunch, true);
    await manager.start(added.id);
    await waitFor(async () => (await manager.list())[0].status === "running");
    assert.equal((await manager.list())[0].canStop, true); assert.equal(opened, 1);
    assert.equal((await manager.runtime()).projects[0].runtime.source, "nuema");
    await manager.stop(added.id);
    assert.equal((await manager.list())[0].canStop, false);
    const saved = await manager.configure(added.id, { command: added.launch.command, args: added.launch.args, url: added.launch.url, allowLaunch: true });
    assert.equal(saved.launch.background, true); assert.equal(saved.launch.healthUrls.length, 2);
    assert.deepEqual(saved.launch.stop, added.launch.stop);
  } finally { await manager.dispose(); }
});

test("全部外部服务就绪时只打开页面，部分占用时拒绝启动且不停止外部服务", async (t) => {
  const { project, run, urls, ports } = await fixture(t);
  const servers = ports.map(() => createServer((req, res) => res.end("external")));
  t.after(() => Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))));
  await new Promise((resolve) => servers[0].listen(ports[0], "127.0.0.1", resolve));
  let spawned = 0, opened = 0;
  const spawnImpl = () => { spawned++; throw new Error("must not spawn"); };
  await assert.rejects(startScriptServices(project, run, { env, spawnImpl }), /部分端口已被占用/);
  await new Promise((resolve) => servers[1].listen(ports[1], "127.0.0.1", resolve));
  await startScriptServices(project, run, { env, spawnImpl, onReady: () => { opened++; } });
  assert.equal(run.status, "external"); assert.equal(run.ownsService, false); assert.equal(opened, 1); assert.equal(spawned, 0);
  await stopScriptServices(project, run, { env, spawnImpl });
  for (const url of urls) assert.equal(await (await fetch(url)).text(), "external");
});

test("停止脚本失败保留服务所有权和再次停止入口", async (t) => {
  const { root, project, run, urls } = await fixture(t);
  await startScriptServices(project, run, { env });
  await waitFor(() => run.status === "running");
  await writeFile(join(root, "fail-stop"), "fixture");
  await assert.rejects(stopScriptServices(project, run, { env }), /停止脚本执行失败/);
  assert.equal(run.status, "failed"); assert.equal(run.ownsService, true); assert.equal(run.stopPromise, null);
  for (const url of urls) assert.equal((await fetch(url)).ok, true);
  await rm(join(root, "fail-stop"));
  await stopScriptServices(project, run, { env });
  assert.equal(run.status, "stopped"); assert.equal(run.ownsService, false);
});

test("启动脚本尚未退出时保持启动中，预检查阶段停止后不会再启动进程", async (t) => {
  const { root, project, run, urls } = await fixture(t);
  await writeFile(join(root, "slow-launch"), "fixture");
  await startScriptServices(project, run, { env });
  await waitFor(async () => { try { return (await Promise.all(urls.map((url) => fetch(url)))).every((response) => response.ok); } catch { return false; } });
  assert.equal(run.status, "starting"); assert.equal(run.launcherExited, false);
  await waitFor(() => run.status === "running");
  await stopScriptServices(project, run, { env });
  const cancelled = { status: "starting", url: null };
  let spawned = 0;
  const starting = startScriptServices(project, cancelled, { env, spawnImpl: () => { spawned++; throw new Error("must not spawn"); } });
  await stopScriptServices(project, cancelled, { env }); await starting;
  assert.equal(cancelled.status, "stopped"); assert.equal(spawned, 0);
  await assert.rejects(startScriptServices(project, { status: "starting" }, { env, blockedPort: new URL(urls[0]).port }), /NUEMA 自身/);
});

test("未创建进程的启动失败不保留所有权，已创建脚本的非零退出保留停止入口并报告退出码", async (t) => {
  const { project, run } = await fixture(t);
  await assert.rejects(startScriptServices(project, run, { env, spawnImpl: () => { throw new Error("fixture-private-error"); } }), /启动脚本未能执行/);
  assert.equal(run.ownsService, false);
  const initialError = { status: "starting", url: null };
  await startScriptServices(project, initialError, { env, spawnImpl: () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("error", new Error("fixture-private-error")));
    return child;
  } });
  await initialError.launcherDone;
  assert.equal(initialError.ownsService, false); assert.equal(initialError.status, "failed");
  assert.doesNotMatch(initialError.error, /fixture-private-error/);
  const exited = { status: "starting", url: null };
  await startScriptServices(project, exited, { env, spawnImpl: () => {
    const child = new EventEmitter(); child.pid = 123;
    queueMicrotask(() => child.emit("exit", 7));
    return child;
  } });
  await exited.launcherDone;
  assert.equal(exited.ownsService, true); assert.equal(exited.status, "failed");
  assert.match(exited.error, /退出码 7/);
  initialError.monitorController.abort(); exited.monitorController.abort();
  await Promise.all([initialError.monitorPromise, exited.monitorPromise]);
});
