import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { ProjectManager } from "../src/projects/projects.mjs";
import { createProjectTools } from "../src/runtime/pi-runtime.mjs";

async function lifecycleFixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "neuma-project-lifecycle-")));
  let spawned = 0;
  const manager = new ProjectManager({ dataDir: join(root, "data"), openBrowser: async () => {}, spawnImpl: () => {
    spawned++;
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = { resume() {} };
    queueMicrotask(() => child.emit("close", 0));
    return child;
  } });
  manager.records = ["target", "other"].map((id) => ({ id, path: root, root, name: id, kind: "node", allowLaunch: true,
    launch: { command: "node", args: ["fixture.mjs"], url: null } }));
  t.after(async () => { await manager.dispose(); await rm(root, { recursive: true, force: true }); });
  return { manager, spawned: () => spawned };
}

test("其他项目保存期间并发启动和删除，不创建失去运行记录的进程", async (t) => {
  const { manager, spawned } = await lifecycleFixture(t);
  const saving = manager.configure("other", { command: "node", args: ["other.mjs"], allowLaunch: true });
  const starting = manager.start("target");
  const removing = manager.remove("target");
  await Promise.all([saving, starting, removing]);
  assert.equal(spawned(), 0);
  assert.deepEqual((await manager.list()).map((project) => project.id), ["other"]);
  assert.equal(manager.runs.size, 0);
});

test("停止可取消尚在等待保存的启动，不等待保存完成也不在稍后创建进程", async (t) => {
  const { manager, spawned } = await lifecycleFixture(t);
  let entered, release;
  const ready = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const saving = manager.change(async () => { entered(); await gate; });
  await ready;
  const starting = manager.start("target");
  try {
    const stopped = await manager.stop("target");
    assert.equal(stopped.status, "stopped");
  } finally { release(); }
  await Promise.all([saving, starting]);
  assert.equal(spawned(), 0);
  assert.equal((await manager.get("target")).id, "target");
});

test("删除已开始后拒绝新启动，关闭管理器也取消并等待尚未开始的启动", async (t) => {
  const { manager, spawned } = await lifecycleFixture(t);
  const removing = manager.remove("target");
  await assert.rejects(manager.start("target"), /删除|移除/);
  await removing;
  const starting = manager.start("other");
  const disposing = manager.dispose();
  await Promise.all([starting, disposing]);
  assert.equal(spawned(), 0);
  await assert.rejects(manager.start("other"), /关闭/);
});

test("已创建进程的启动可以立即停止，删除等待启动收尾后再清除运行记录", async (t) => {
  const { manager } = await lifecycleFixture(t);
  let entered, settled = false;
  const ready = new Promise((resolve) => { entered = resolve; });
  const child = new EventEmitter();
  child.pid = 123456789; child.exitCode = null; child.signalCode = null;
  child.stdout = new EventEmitter(); child.stderr = { resume() {} };
  const signals = [];
  const kill = (pid, signal) => {
    signals.push({ pid, signal }); child.signalCode = signal;
    queueMicrotask(() => child.emit("close", null));
    return true;
  };
  t.mock.method(process, "kill", kill);
  child.kill = (signal) => kill(child.pid, signal);
  manager.spawnImpl = () => { entered(); return child; };
  const starting = manager.start("target").finally(() => { settled = true; });
  await ready;
  const stopped = await manager.stop("target");
  assert.equal(stopped.status, "stopped"); assert.equal(settled, false);
  assert.deepEqual(signals, [{ pid: process.platform === "win32" ? child.pid : -child.pid, signal: "SIGTERM" }]);
  await manager.remove("target");
  assert.equal(settled, true);
  await starting;
  assert.equal(manager.runs.size, 0);
  assert.equal((await manager.list()).some((project) => project.id === "target"), false);
});

test("停止脚本丢失不锁死删除：先保留记录，明确仅移除后清理登记而不执行项目代码", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nuema-remove-")));
  const script = join(root, "start.sh");
  await writeFile(script, "#!/bin/sh\nexit 0\n");
  const manager = new ProjectManager({ dataDir: join(root, "data"), spawnImpl: () => assert.fail("不应执行脚本"),
    analyzeProject: async () => ({ root, kind: "script", setup: { status: "ready" },
      launch: { command: "/bin/sh", args: [script, "start"], background: true,
        stop: { command: "/bin/sh", args: [join(root, "missing-stop.sh"), "stop"] }, healthUrls: [] } }) });
  t.after(async () => { await manager.dispose(); await rm(root, { recursive: true, force: true }); });
  const project = await manager.add({ path: root });
  const run = { status: "failed", background: true, ownsService: true, launcherExited: true, monitorController: new AbortController() };
  manager.runs.set(project.id, run);
  await assert.rejects(manager.remove(project.id, { removeOnly: true }), /先尝试正常删除/);
  await assert.rejects(manager.remove(project.id), (error) => error.code === "PROJECT_REMOVE_STOP_FAILED" && /没有找到/.test(error.message));
  assert.equal((await manager.list()).length, 1); assert.equal(run.ownsService, true);
  const pendingDisk = JSON.parse(await readFile(join(root, "data", "projects.json"), "utf8"));
  assert.equal(pendingDisk.projects.length, 1);
  const result = await manager.remove(project.id, { removeOnly: true });
  assert.deepEqual(result, { removed: true, servicesMayBeRunning: true });
  assert.equal((await manager.list()).length, 0); assert.equal(manager.runs.size, 0);
  assert.equal(run.monitorController.signal.aborted, true);
  assert.match(await readFile(script, "utf8"), /exit 0/);
  const disk = JSON.parse(await readFile(join(root, "data", "projects.json"), "utf8"));
  assert.equal(disk.projects.length, 0);
});

test("助手停止失败后不能在同一轮跳过确认，下一轮仅移除保留真实运行提示", async (t) => {
  const { InputError } = await import("../src/requirements/core.mjs");
  const turn = { actions: [] }, calls = [];
  const manager = { list: async () => [{ id: "fixture", name: "临时项目" }], remove: async (id, options) => {
    calls.push(options);
    if (!options.removeOnly) throw Object.assign(new InputError("停止脚本不存在"), { code: "PROJECT_REMOVE_STOP_FAILED" });
    return { removed: true, servicesMayBeRunning: true };
  } };
  const tool = createProjectTools(manager, turn).find((item) => item.name === "remove_project");
  const first = JSON.parse((await tool.execute("first", { id: "fixture", confirm: true })).content[0].text);
  assert.equal(first.removed, false); assert.equal(first.reason, "stop_failed"); assert.equal(turn.actions.length, 0);
  await assert.rejects(tool.execute("skip", { id: "fixture", confirm: true, removeOnly: true }), /下一轮明确同意/);
  turn.removalNeedsConfirmation = new Set();
  const next = JSON.parse((await tool.execute("next", { id: "fixture", confirm: true, removeOnly: true })).content[0].text);
  assert.equal(next.removed, true); assert.equal(next.servicesMayBeRunning, true);
  assert.equal(turn.actions.length, 1); assert.deepEqual(calls, [{ removeOnly: false }, { removeOnly: true }]);
});
