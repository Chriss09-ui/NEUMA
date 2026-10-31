import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionFactory, SessionMessage } from "../../src/runtime/execution-port.mjs";
import { DevelopmentController } from "../../src/development/development.mjs";
import { DevelopmentExecutor } from "../../src/development/development-executor.mjs";
import { validatePlan } from "../../src/development/development-contract.mjs";
import { developmentArchitecture, developmentPlan, developmentReview, developmentWork } from "../helpers/development.mjs";
import { fixtureTools, toolText } from "../helpers/m7-test-boundaries.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import type { TaskProgress } from "../../src/development/development-controller-types.mjs";

async function fixture(t: test.TestContext, mode: "self_test" | "missing_entrypoint" | "other_owner" | "bad_patch" | "repair_budget") {
  const root = await mkdtemp(join(tmpdir(), "neuma-development-routing-")), executor = new DevelopmentExecutor();
  const availability = await executor.probe();
  if (!availability.available) { await rm(root, { recursive: true, force: true }); t.skip(availability.reason); return; }
  const architecture = developmentArchitecture();
  const plan = developmentPlan(architecture);
  // The shared controller and durable repair boundary apply to all plan versions.
  plan.cases = plan.cases.map(item => ({ ...item, input: item.taskId === "core" ? "1" : "2",
    assertions: [{ path: "n", expectedJson: item.taskId === "core" ? "1" : "2" }] }));
  validatePlan(plan, { architecture, freshWorkspace: true });
  const calls = { developer: 0, repair: 0 }, selfTests: string[] = [];
  let missing = mode === "missing_entrypoint", rejected = false, badPatch = mode === "bad_patch";
  const sources = {
    "main.mjs": "const n=Number(process.argv[2]); console.log(JSON.stringify(n===2?{n:(await import('./guard.mjs')).n}:{n}));",
    "guard.mjs": "export const n=2;",
  };
  const factory: SessionFactory = async options => {
    const tools = fixtureTools(options.customTools);
    const session = { messages: [] as SessionMessage[],
      ...(tools.submit_repair_patch ? { sessionFile: options.sessionStorage!.file ?? join(options.sessionStorage!.directory, `child-${calls.repair}.jsonl`) } : {}),
      setAutoCompactionEnabled() {}, async abort() {}, dispose() {},
      async prompt(message: string) {
        if (mode === "repair_budget" && tools.submit_repair_patch) {
          calls.repair++; session.messages.push({ role: "assistant", stopReason: "stop", content: "未提交" }); return;
        }
        const payload = objectFields(JSON.parse(message));
        if (tools.submit_repair_patch) {
          calls.repair++;
          const assignment = objectFields(payload.repairAssignment);
          const paths = assignment.allowedPaths as string[];
          const updates = paths.map(path => ({ path, value: badPatch ? "bad\0text" : sources[path.slice("/files/".length) as keyof typeof sources] + "\n// corrected" }));
          if (badPatch) {
            badPatch = false;
            await assert.rejects(tools.submit_repair_patch.execute("bad", { baseHash: assignment.baseHash,
              issueIds: (assignment.issues as { id: string }[]).map(item => item.id), summary: "不可写文本", updates }), /文本/);
            throw new Error("controlled interruption after rejected patch");
          }
          await tools.submit_repair_patch.execute("repair", { baseHash: assignment.baseHash,
            issueIds: (assignment.issues as { id: string }[]).map(item => item.id), summary: "修复原责任文件", updates });
        } else if (tools.submit_development_plan) await tools.submit_development_plan.execute("plan", plan);
        else if (tools.submit_development_review) {
          const task = objectFields(payload.task);
          const needsRepair = payload.mode === "task" && !rejected && (mode === "other_owner" ? task.id === "guard" : ["bad_patch", "repair_budget"].includes(mode) && task.id === "core");
          if (needsRepair) rejected = true;
          const failed = objectFields(payload.report).status !== "passed" && payload.mode !== "plan";
          const issues = needsRepair || failed ? Array.from({ length: ["bad_patch", "repair_budget"].includes(mode) ? 2 : 1 }, (_, index) => ({ id: `bug_${index}`,
            blocking: true, kind: "code" as const, description: "核心入口需要修复", remedy: "修复 main.mjs 后重验", taskIds: ["core"], files: ["main.mjs"] })) : [];
          await tools.submit_development_review.execute("review", developmentReview(String(payload.subjectHash), { verdict: issues.length ? "revise" : "pass", issues }));
        } else {
          calls.developer++;
          const task = payload.task as TaskProgress;
          if (!missing) for (const path of task.files) await tools.write_code_file!.execute("write", { path, content: sources[path as keyof typeof sources] });
          if (mode === "self_test") selfTests.push(String(objectFields(JSON.parse(toolText(await tools.run_development_checks!.execute("check", {})))).status));
          const changedFiles = missing ? [] : task.files; missing = false;
          await tools.submit_development_work!.execute("work", developmentWork(task, { changedFiles }));
        }
        session.messages.push({ role: "assistant", stopReason: "stop", content: "Controlled model result; execution and persistence are real." });
      } };
    return session;
  };
  const controller = new DevelopmentController({ config: { llmConfigured: true }, cwd: root, dataDir: join(root, "data"),
    sessionFactory: factory, executor, getArchitecture: async () => architecture });
  t.after(async () => {
    await controller.close();
    const unseal = async (path: string) => { await chmod(path, 0o700); for (const entry of await readdir(path, { withFileTypes: true }))
      if (entry.isDirectory()) await unseal(join(path, entry.name)); };
    await unseal(root); await rm(root, { recursive: true, force: true });
  });
  return { controller, architecture, calls, selfTests };
}

test("自测仅执行当前可交付增量，未来依赖缺文件不产生虚假失败", async t => {
  const f = await fixture(t, "self_test"); if (!f) return;
  const result = await f.controller.run(f.architecture);
  assert.equal(result.status, "completed", result.summary);
  assert.deepEqual(f.selfTests, ["passed", "passed"]);
});

test("实际缺入口错误进入有限代码修复，保持失败证据并最终完成真实验收", async t => {
  const f = await fixture(t, "missing_entrypoint"); if (!f) return;
  const result = await f.controller.run(f.architecture);
  assert.equal(result.status, "completed", result.summary);
  assert.ok(result.reports.some(report => report.results.some(row => row.reason === "entrypoint_missing" && row.status === "error")));
  assert.equal(result.tasks[0]!.repairs, 1); assert.equal(result.budgets.corrections, 5);
  assert.ok(f.calls.developer + f.calls.repair > 2);
});

test("一个前序任务问题也交给原责任文件的独立修复会话", async t => {
  const f = await fixture(t, "other_owner"); if (!f) return;
  const result = await f.controller.run(f.architecture);
  assert.equal(result.status, "completed", result.summary); assert.equal(f.calls.repair, 1);
  assert.match(await readFile(join(result.snapshot!.path, "main.mjs"), "utf8"), /corrected/);
  assert.equal(result.tasks[1]!.repairs, 1);
});

test("不可写补丁在保存完成结果前拒绝，恢复用原剩余额度重新提交", async t => {
  const f = await fixture(t, "bad_patch"); if (!f) return;
  const stopped = await f.controller.run(f.architecture);
  assert.equal(stopped.status, "failed");
  const before = Object.values(stopped.repairBatches!)[0]!.checkpoint;
  assert.equal(before.calls, 1); assert.equal(before.groups[0]!.result, null);
  const result = await f.controller.run(f.architecture, { resume: true });
  assert.equal(result.status, "completed", result.summary);
  const after = Object.values(result.repairBatches!)[0]!.checkpoint;
  assert.equal(after.calls, 2); assert.equal(after.callLimit, before.callLimit);
  assert.equal(result.budgets.corrections, stopped.budgets.corrections);
});

test("修复子组耗尽后公开为不可直接续跑，重复调用不重领额度", async t => {
  const f = await fixture(t, "repair_budget"); if (!f) return;
  const stopped = await f.controller.run(f.architecture);
  assert.equal(stopped.status, "failed"); assert.equal(f.calls.repair, 12);
  const summary = await f.controller.get(f.architecture.agentId);
  assert.equal(summary!.continuation!.mode, "blocked");
  const resumed = await f.controller.run(f.architecture, { resume: true });
  assert.equal(resumed.status, "failed"); assert.equal(f.calls.repair, 12);
  assert.equal(resumed.budgets.corrections, stopped.budgets.corrections);
});
