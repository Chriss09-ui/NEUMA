import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectManager } from "../projects.mjs";
import { createProjectTools } from "../pi-runtime.mjs";

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
  const { InputError } = await import("../core.mjs");
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
