import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextReadyDevelopmentTask, taskEntrypointIssues, validatePlan } from "../src/development/development-contract.mjs";
import { diagnosePlanningPlan } from "../src/development/development-plan-diagnostics.mjs";
import { PLAN_V3_SCHEMA } from "../src/development/development-contract.mjs";
import { hashValue } from "../src/development/development-contract.mjs";
import { DevelopmentController } from "../src/development/development.mjs";
import { planReviewSubject } from "../src/verification/plan-review-subject.mjs";

function fixture() {
  const value = { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false };
  const architecture = { requirements: [{ id: "task", text: "完整处理" }], design: { schemaVersion: 3,
    interaction: { page: false, operations: true }, execution: { language: "javascript", hosting: "builtin" }, connections: [],
    acceptance: [{ id: "business", requirementIds: ["task"], verification: { stage: "development", owner: "generated-code", adapterId: "action" } }] } };
  const task = (id, files, dependsOn = []) => ({ id, title: id, description: "可执行增量", files, dependsOn, requirementIds: ["task"], acceptanceIds: ["business"] });
  const check = (id) => ({ id: `case_${id}`, taskId: id, acceptanceId: "business", kind: "action", actionId: "process", mocks: [], input: '{"n":1}', assertions: [{ path: "n", expectedJson: "1" }] });
  const plan = { schemaVersion: 3, summary: "固定执行顺序测试", runtime: "node-action", entrypoint: "actions.mjs",
    tasks: [task("helper", ["lib/core.mjs"]), task("entry", ["actions.mjs"], ["helper"])], cases: [check("helper"), check("entry")],
    application: { protocolVersion: 2, runtime: "node-action", entrypoint: "actions.mjs", page: null, stateVersion: 1, evidenceIds: [],
      actions: [{ id: "process", title: "处理", inputSchema: value, outputSchema: value, connectionIds: [] }] } };
  return { architecture, plan, task, check };
}

test("入口前检拒绝必然缺入口的首helper任务，明确源文件并保留计划不变", () => {
  const { architecture, plan } = fixture(), before = structuredClone(plan);
  assert.throws(() => validatePlan(plan, { architecture, freshWorkspace: true }), (error) => error.developmentIssue?.reason === "task_entrypoint_unavailable");
  const result = diagnosePlanningPlan(plan, PLAN_V3_SCHEMA, { architecture, freshWorkspace: true, indexSource: { path: "index.json" } });
  const issue = result.issues.find((item) => item.reason === "task_entrypoint_unavailable");
  assert.equal(issue.taskId, "helper"); assert.equal(issue.requiredEntrypoint, "actions.mjs"); assert.equal(issue.path, "plan.tasks[0].files");
  assert.deepEqual(issue.source, { path: "index.json" }); assert.deepEqual(plan, before);
});

test("旧冻结计划和非空workspace不被套用fresh假设，previousPlan递归不触发新门槛", () => {
  const { architecture, plan } = fixture();
  assert.deepEqual(validatePlan(plan, { architecture }), plan);
  assert.deepEqual(validatePlan(plan, { architecture, previousPlan: plan, freshWorkspace: false }), plan);
  assert.equal(diagnosePlanningPlan(plan, PLAN_V3_SCHEMA, { architecture, previousPlan: plan }).total, 0);
  const current = structuredClone(plan); current.tasks[0].files.push("actions.mjs");
  assert.deepEqual(validatePlan(current, { architecture, previousPlan: plan, freshWorkspace: true }), current);
});

test("Python同样提前定位首validator/types之后才有service入口的计划，不猜import内容", () => {
  const { plan } = fixture(); plan.runtime = "managed-service"; plan.entrypoint = "service_main.py";
  plan.tasks[0].files = ["src/validator.py", "src/types.py"]; plan.tasks[1].files = ["service_main.py"];
  assert.deepEqual(taskEntrypointIssues(plan), [{ path: "plan.tasks[0].files", reason: "task_entrypoint_unavailable", taskId: "helper", requiredEntrypoint: "service_main.py" }]);
});

test("同任务入口加多个helper、先前无显式依赖任务的入口、前向依赖拓扑都按真实可用文件通过", () => {
  for (const shape of ["vertical", "earlier", "forward"]) {
    const { architecture, plan, task, check } = fixture();
    if (shape === "vertical") { plan.tasks = [task("all", ["actions.mjs", "lib/core.mjs", "lib/format.mjs"])]; plan.cases = [check("all")]; }
    if (shape === "earlier") { plan.tasks[0].files.push("actions.mjs"); plan.tasks[1].dependsOn = []; }
    if (shape === "forward") { plan.tasks[0].dependsOn = ["entry"]; plan.tasks[1].dependsOn = []; }
    assert.deepEqual(taskEntrypointIssues(plan), []); assert.deepEqual(validatePlan(plan, { architecture, freshWorkspace: true }), plan);
  }
});

test("纯输入契约拒绝无需动作代码入口，页面node-check也不被全局动作入口前检误伤", () => {
  const { architecture, plan } = fixture();
  architecture.design.acceptance.push({ id: "guard", requirementIds: ["task"], verification: { stage: "development", owner: "platform", adapterId: "input-contract" } });
  plan.tasks[0].acceptanceIds = ["guard"]; Object.assign(plan.cases[0], { acceptanceId: "guard", kind: "input-rejection", input: '{"n":"bad"}',
    assertions: [{ path: "rejected", expectedJson: "true" }] });
  assert.deepEqual(taskEntrypointIssues(plan), []); assert.deepEqual(validatePlan(plan, { architecture, freshWorkspace: true }), plan);
  const page = { tasks: [{ id: "page", files: ["checks/page.mjs", "ui/index.html"], dependsOn: [] }],
    entrypoint: "actions.mjs", cases: [{ taskId: "page", kind: "node-check", entrypoint: "checks/page.mjs" }] };
  assert.deepEqual(taskEntrypointIssues(page), []);
});

test("共享selector保持verified跳过、前向依赖、失败依赖等待及replan状态语义", () => {
  const tasks = [{ id: "consumer", status: "pending", dependsOn: ["provider"] }, { id: "provider", status: "pending", dependsOn: [] }];
  assert.equal(nextReadyDevelopmentTask(tasks), tasks[1]); tasks[1].status = "verified"; assert.equal(nextReadyDevelopmentTask(tasks), tasks[0]);
  tasks[1].status = "failed"; assert.equal(nextReadyDevelopmentTask(tasks), tasks[1]);
  tasks[1].dependsOn = ["consumer"]; assert.equal(nextReadyDevelopmentTask(tasks), undefined);
  tasks[1].status = "verified"; tasks[0].status = "verified"; assert.equal(nextReadyDevelopmentTask(tasks), undefined);
  tasks[0].status = "pending"; assert.equal(nextReadyDevelopmentTask(tasks), tasks[0]);
});

test("循环与未知依赖继续由原契约拒绝，入口前检不遮挡引用或循环问题", () => {
  for (const dependsOn of [["missing"], ["entry"]]) {
    const { architecture, plan } = fixture(); plan.tasks[0].dependsOn = dependsOn;
    assert.deepEqual(taskEntrypointIssues(plan), []);
    assert.throws(() => validatePlan(plan, { architecture }), dependsOn[0] === "missing" ? /不存在/u : /循环/u);
  }
});

test("正常controller重规划按真实非空代码快照保留verified任务和全部冻结用例，不从任务排序猜fresh", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-replan-workspace-")), { architecture, plan } = fixture(), prompts = [];
  plan.tasks[1].dependsOn = [];
  const oldPlan = { ...structuredClone(plan), tasks: [structuredClone(plan.tasks[1]), structuredClone(plan.tasks[0])] };
  const controller = new DevelopmentController({ cwd: root, dataDir: join(root, "data"), config: { llmConfigured: true },
    store: { save: async (value) => ({ ...value, revision: value.revision + 1 }) }, sessionFactory: async (options) => {
      const tools = Object.fromEntries(options.customTools.map((tool) => [tool.name, tool])), planner = Boolean(tools.submit_development_plan);
      return { messages: [], subscribe: () => () => {}, async abort() {}, dispose() {}, async prompt(text) {
        const payload = JSON.parse(text);
        if (!payload.planningWorkspace) {
          const page = await tools.read_development_context.execute("workspace-fact", { section: "planningWorkspace" });
          payload.planningWorkspace = JSON.parse(JSON.parse(page.content[0].text).text);
        }
        prompts.push({ planner, payload });
        assert.equal(payload.planningWorkspace.empty, false);
        if (planner) await tools.submit_development_plan.execute("formal-replan", { indexPath: "index.json" });
        else await tools.submit_development_review.execute("independent-plan-review", { subjectHash: payload.subjectHash, verdict: "pass", summary: "固定独立评审已核对", issues: [] });
      } };
    } });
  t.after(async () => {
    const unseal = async (path) => { await chmod(path, 0o700); for (const file of await readdir(path, { withFileTypes: true })) if (file.isDirectory()) await unseal(join(path, file.name)); };
    await unseal(root); await rm(root, { recursive: true, force: true });
  });
  const record = { id: "dev_replan", agentId: "replan", architecture, architectureRef: { version: 1, candidateHash: hashValue(architecture.design) },
    revision: 0, planning: { turns: 0 }, plan: oldPlan, planHash: hashValue(oldPlan), planAttempts: [], reviews: [], handoffs: [], budgets: { planRevisions: 1 },
    tasks: oldPlan.tasks.map((task) => ({ ...task, taskHash: hashValue(task), status: task.id === "entry" ? "verified" : "pending", attempts: 1, turns: 2 })) };
  const ctx = { record, signal: new AbortController().signal, writes: Promise.resolve(), handles: new Set(), onProgress() {} }; controller.active.set(record.agentId, ctx);
  const codeDir = await controller.workspace.create(record.agentId, record.id), code = "export const actions={process:async input=>input};\n";
  await writeFile(join(codeDir, "actions.mjs"), code); const before = await controller.workspace.snapshot(record.agentId, record.id);
  const tools = await controller.artifacts.tools(record.agentId, record.id, { casesSchema: PLAN_V3_SCHEMA.properties.cases, planSchema: PLAN_V3_SCHEMA, architecture, previousPlan: oldPlan });
  const { cases, ...index } = plan;
  await tools.find((tool) => tool.name === "save_plan_json").execute("index", { path: "index.json", value: { ...index, caseFiles: ["cases.json"] } });
  await tools.find((tool) => tool.name === "save_plan_cases").execute("cases", { path: "cases.json", cases });
  await controller.plan(ctx);
  assert.deepEqual(ctx.record.plan, plan); assert.equal(ctx.record.tasks[0].id, "helper");
  assert.equal(ctx.record.tasks.find((task) => task.id === "entry").status, "verified"); assert.equal(nextReadyDevelopmentTask(ctx.record.tasks).id, "helper");
  assert.deepEqual(ctx.record.plan.cases, oldPlan.cases); assert.equal(await readFile(join(codeDir, "actions.mjs"), "utf8"), code);
  assert.equal((await controller.workspace.snapshot(record.agentId, record.id)).hash, before.hash);
  assert.equal(prompts.length, 2); assert.ok(prompts.every(({ payload }) => payload.planningWorkspace.codeHash === before.hash));
  assert.equal(ctx.planningWorkspace, undefined); assert.equal(ctx.record.plan.planningWorkspace, undefined);
  const review = ctx.record.reviews[0];
  assert.equal(review.subjectVersion, 2);
  assert.equal(review.subjectHash, hashValue(planReviewSubject(record.architectureRef, plan, hashValue(plan), 2)));
  assert.deepEqual(validatePlan(oldPlan, { architecture }), oldPlan);
});
