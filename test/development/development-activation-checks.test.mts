import type { ValueSchema } from "../../src/contracts/application.mjs";
import { fixtureTools, fixtureText, recordArray } from "../helpers/m7-test-boundaries.mjs";
import type { DevelopmentPlan, DevelopmentApplication } from "../../src/contracts/development.mjs";
import { callFixture } from "../helpers/m7-test-boundaries.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import { toolText } from "../helpers/m7-test-boundaries.mjs";
import { listeningAddress } from "../helpers/m7-test-boundaries.mjs";
import type { TestFailure } from "../helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { activationCheckIssues, hashValue, PLAN_V3_SCHEMA, validatePlan } from "../../src/development/development-contract.mjs";
import { diagnosePlanningPlan } from "../../src/development/development-plan-diagnostics.mjs";
import { DevelopmentArtifacts } from "../../src/development/development-artifacts.mjs";
import { submissionIssues } from "../../src/development/development-diagnostics.mjs";
import { DevelopmentController } from "../../src/development/development.mjs";
import { createPiSession } from "../../src/runtime/pi-runtime.mjs";
import type { PathLike } from "fs";
import type { DevelopmentHandle } from "../../src/development/development-controller-types.mjs";

const descriptor = (stage: string, owner: string, adapterId: string) => ({ stage, owner, adapterId });
function fixture() {
  const schema: ValueSchema = { type: "object", properties: { value: { type: "integer", minimum: 0 } }, required: ["value"], additionalProperties: false };
  const architecture = { requirements: ["business", "invalid", "static"].map((id) => ({ id, text: id })),
    design: { schemaVersion: 3, interaction: { page: false, operations: true }, execution: { language: "javascript", hosting: "builtin" }, connections: [],
      acceptance: [
        { id: "calculation", requirementIds: ["business"], verification: descriptor("development", "generated-code", "action") },
        { id: "input_guard", requirementIds: ["invalid"], verification: descriptor("development", "platform", "input-contract") },
        { id: "language_decision", requirementIds: ["static"], verification: descriptor("development", "platform", "delivery-review") },
        { id: "activation_matrix", requirementIds: ["business", "invalid"], verification: descriptor("activation", "platform", "host-business") },
      ] } };
  const plan: DevelopmentPlan & { application: DevelopmentApplication; activationChecks: NonNullable<DevelopmentPlan["activationChecks"]> } = { schemaVersion: 3, summary: "验证同一业务在开发和启用阶段的真实输入输出", runtime: "node-action", entrypoint: "actions.mjs",
    application: { protocolVersion: 2, runtime: "node-action", entrypoint: "actions.mjs", page: null, stateVersion: 1, evidenceIds: [],
      actions: [{ id: "calculate", title: "计算", inputSchema: schema, outputSchema: schema, connectionIds: [] }] },
    tasks: [{ id: "core", title: "实现计算", description: "实现公开动作并验证正常和非法输入", requirementIds: ["business", "invalid"],
      acceptanceIds: ["calculation", "input_guard"], dependsOn: [], files: ["actions.mjs"] }],
    cases: [
      { id: "valid", taskId: "core", acceptanceId: "calculation", kind: "action", actionId: "calculate", mocks: [], input: '{"value":1}', assertions: [{ path: "value", expectedJson: "1" }] },
      { id: "invalid", taskId: "core", acceptanceId: "input_guard", kind: "input-rejection", actionId: "calculate", mocks: [], input: '{"value":-1}', assertions: [{ path: "error", expectedJson: '"invalid_input"' }] },
    ], activationChecks: [{ acceptanceId: "activation_matrix", caseIds: ["valid", "invalid"] }] };
  return { architecture, plan };
}

function dedicatedFixture() {
  const value = fixture();
  value.architecture.requirements.push({ id: "activation_only", text: "仅在激活阶段核对真实宿主业务" });
  value.architecture!.design.acceptance.find((item) => item.id === "activation_matrix")!.requirementIds.push("activation_only");
  const { taskId: _taskId, ...test } = value.plan.cases[0]!;
  const plan: typeof value.plan & { activationCases: NonNullable<DevelopmentPlan["activationCases"]> } = Object.assign(value.plan, { activationCases: [{ ...test, id: "activation_valid", acceptanceId: "activation_matrix", input: '{"value":2}', assertions: [{ path: "value", expectedJson: "2" }] }] });
  value.plan!.activationChecks[0]!.caseIds.push("activation_valid");
  return { ...value, plan };
}

test("激活专属义务由独立冻结用例保留原阶段，不强迫复制到研发映射", () => {
  const { architecture, plan } = dedicatedFixture();
  const checked = validatePlan(plan, { architecture });
  assert.equal(checked.activationCases![0]!.taskId, undefined);
  assert.equal(checked.tasks![0]!.requirementIds.includes("activation_only"), false);
  assert.equal(checked.cases.length, 2);
  assert.deepEqual(activationCheckIssues(checked, { architecture }), []);
  assert.equal(diagnosePlanningPlan(checked, PLAN_V3_SCHEMA, { architecture }).total, 0);
  const lackingDevelopment = structuredClone(plan); lackingDevelopment.cases = lackingDevelopment.cases.filter((item) => item.kind === "input-rejection");
  assert.throws(() => validatePlan(lackingDevelopment, { architecture }), /实际验收用例/);
});

test("激活专用用例拒绝跨项、跨阶段、重号、未映射与两组合计超额", () => {
  for (const change of [
    (value: { activationCases: { id: unknown; }[]; cases: { id: unknown; }[]; }) => { value.activationCases[0]!.id = value.cases[0]!.id; },
    (value: { activationCases: { acceptanceId: string; }[]; }) => { value.activationCases![0]!.acceptanceId = "calculation"; },
    (value: { activationCases: { kind: string; }[]; }) => { value.activationCases![0]!.kind = "node-check"; },
    (value: { activationCases: { actionId: string; }[]; }) => { value.activationCases![0]!.actionId = "not_public"; },
    (value: { activationCases: { taskId: string; }[]; }) => { value.activationCases![0]!.taskId = "not_a_task"; },
    (value: { activationChecks: { caseIds: string[]; }[]; }) => { value.activationChecks![0]!.caseIds = ["valid", "invalid"]; },
  ]) {
    const { architecture, plan } = dedicatedFixture(); callFixture(change, undefined, [plan]);
    assert.throws(() => validatePlan(plan, { architecture }));
  }
  const { architecture, plan } = dedicatedFixture();
  architecture.design.acceptance.push({ id: "another_activation", requirementIds: ["business"], verification: descriptor("activation", "platform", "host-business") });
  plan.activationChecks.push({ acceptanceId: "another_activation", caseIds: ["activation_valid"] });
  assert.ok(activationCheckIssues(plan, { architecture }).some((item) => item.path === "plan.activationChecks[1].caseIds[0]" && item.reason === "activation_case_invalid"));
  const many = dedicatedFixture();
  many.plan.activationCases = Array.from({ length: 199 }, (_, index) => ({ ...structuredClone(many.plan.activationCases[0])!, id: `activation_${index}` }));
  many.plan!.activationChecks[0]!.caseIds = ["valid", "invalid", "activation_0"];
  assert.throws(() => validatePlan(many.plan, { architecture: many.architecture }), (error: TestFailure) => error.developmentIssue?.reason === "case_limit");
});

test("激活专用输入与断言冻结，共享序列不得切换模式、删除或重排", () => {
  const { architecture, plan } = dedicatedFixture();
  plan.activationChecks![0]!.executionScope = "shared";
  for (const change of [
    (value: { activationCases: never[]; activationChecks: { caseIds: void[]; }[]; }) => { value.activationCases = []; value.activationChecks![0]!.caseIds.pop(); },
    (value: { activationCases: { input: string; }[]; }) => { value.activationCases![0]!.input = '{"value":3}'; },
    (value: { activationCases: { assertions: { expectedJson: string; }[]; }[]; }) => { value.activationCases![0]!.assertions[0]!.expectedJson = "3"; },
    (value: { activationChecks: { executionScope: string; }[]; }) => { value.activationChecks![0]!.executionScope = "isolated"; },
    (value: { activationChecks: { caseIds: unknown[]; }[]; }) => { value.activationChecks[0]!.caseIds.reverse(); },
  ]) {
    const next = structuredClone(plan); callFixture(change, undefined, [next]);
    assert.throws(() => callFixture(validatePlan, undefined, [next, { architecture, previousPlan: plan }]));
  }
  const next = structuredClone(plan);
  next.activationCases.push({ ...structuredClone(next.activationCases[0])!, id: "activation_second" });
  next.activationChecks![0]!.caseIds.push("activation_second");
  assert.doesNotThrow(() => validatePlan(next, { architecture, previousPlan: plan }));
});

test("入口拒绝明确选择动作值或完整任务信封，不把合法小输入冒充拒绝", () => {
  const { architecture, plan } = fixture();
  plan.application!.actions[0]!.inputSchema = { type: "object", properties: { value: {} }, required: ["value"], additionalProperties: false };
  plan.cases![1]!.inputTarget = "task-envelope";
  plan.cases![1]!.input = { fixture: { op: "object", fields: { value: { op: "text", value: "x".repeat(20), count: 7000 } } } };
  assert.doesNotThrow(() => validatePlan(plan, { architecture }));
  assert.equal(diagnosePlanningPlan(plan, PLAN_V3_SCHEMA, { architecture }).total, 0);
  const small = structuredClone(plan); small.cases![1]!.input = '{"value":"small"}';
  assert.throws(() => validatePlan(small, { architecture }), /实际违反/);
  assert.ok(diagnosePlanningPlan(small, PLAN_V3_SCHEMA, { architecture }).issues.some((item) => item.reason === "input_rejection_not_rejected"));
  const changedTarget = structuredClone(plan); changedTarget.cases![1]!.inputTarget = "action-value";
  assert.throws(() => validatePlan(changedTarget, { architecture }), /实际违反/);
  const wrongKind = structuredClone(plan); wrongKind.cases![0]!.inputTarget = "task-envelope";
  assert.throws(() => validatePlan(wrongKind, { architecture }), /inputTarget/);
});

test("超过1MiB的真实动作拒绝夹具可原样冻结续接，输入或通道变化仍拒绝", () => {
  const { architecture, plan } = fixture();
  plan.application!.actions[0]!.inputSchema.properties!.value = {};
  plan.cases![1]!.input = { fixture: { op: "object", fields: { value: { op: "text", value: "x".repeat(110), count: 10000 } } } };
  plan.cases![1]!.inputTarget = "action-value";
  assert.doesNotThrow(() => validatePlan(plan, { architecture }));
  assert.doesNotThrow(() => validatePlan(structuredClone(plan), { architecture, previousPlan: plan }));
  assert.equal(diagnosePlanningPlan(plan, PLAN_V3_SCHEMA, { architecture, previousPlan: plan }).total, 0);
  const changed = structuredClone(plan), input = changed.cases[1]!.input;
  assert.ok(typeof input !== "string" && input.fixture.op === "object"); const field = input.fixture.fields.value; assert.ok(field?.op === "text"); field.count--;
  assert.throws(() => callFixture(validatePlan, undefined, [changed, { architecture, previousPlan: plan }]), /不能删除或替换/);
  const channel = structuredClone(plan); channel.cases![1]!.inputTarget = "task-envelope";
  assert.throws(() => callFixture(validatePlan, undefined, [channel, { architecture, previousPlan: plan }]), /不能删除或替换/);
});

test("研发及激活专用夹具共用原展开额度，不能通过换数组绕过总量", () => {
  const { architecture, plan } = dedicatedFixture();
  plan.application!.actions[0]!.inputSchema.properties!.value = {};
  plan.cases![1]!.input = "{}";
  architecture.design.execution.hosting = "managed";
  plan.runtime = plan.application.runtime = "managed-service"; plan.application.protocolVersion = 3;
  plan.application.service = { schemaVersion: 1, language: "javascript", host: "managed", entrypoint: plan.entrypoint,
    operations: plan.application.actions.map((action) => ({ ...action, connectionIds: action.connectionIds ?? [] })), dependencies: { packages: [] }, capabilities: [], dataVersion: 1 };
  plan.activationCases = Array.from({ length: 20 }, (_, index) => ({ ...structuredClone(plan.activationCases[0])!, id: `large_${index}`,
    input: { fixture: { op: "object", fields: { value: { op: "text", value: "x".repeat(100), count: 9000 } } } } }));
  plan.activationChecks![0]!.caseIds = plan.activationCases.map((item) => item.id);
  assert.throws(() => validatePlan(plan, { architecture }), (error: TestFailure) => error.reason === "fixture_plan_output_limit" && error.fixtureCaseGroup === "activationCases");
  const diagnostics = diagnosePlanningPlan(plan, PLAN_V3_SCHEMA, { architecture });
  assert.ok(diagnostics.issues.some((item) => item.path.startsWith("plan.activationCases[") && item.fixtureReason === "fixture_plan_output_limit"));
});

test("启用业务矩阵引用同需求已有用例，静态决策独立评审而不伪造研发测试", () => {
  const { architecture, plan } = fixture(), original = structuredClone(plan);
  assert.deepEqual(validatePlan(plan, { architecture }), original);
  assert.deepEqual(plan, original); assert.deepEqual(activationCheckIssues(plan, { architecture }), []);
  const withoutActivation = structuredClone(architecture);
  withoutActivation.design.acceptance = withoutActivation.design.acceptance.filter((item) => item.id !== "activation_matrix");
  const old = structuredClone(plan); Reflect.deleteProperty(old, "activationChecks");
  assert.doesNotThrow(() => validatePlan(old, { architecture: withoutActivation }), "没有新适配器的旧计划仍兼容");
  const staticTask = structuredClone(plan); staticTask.tasks![0]!.acceptanceIds.push("language_decision");
  assert.throws(() => validatePlan(staticTask, { architecture }), /不能用研发任务代替/);
});

test("启用映射缺失、重复、非业务目标、悬空用例和未覆盖需求均阻断", () => {
  for (const [change, reason] of [
    [(value: { activationChecks: unknown; }) => { Reflect.deleteProperty(value, "activationChecks"); }, "activation_checks_missing"],
    [(value: { activationChecks: unknown[]; }) => { value.activationChecks.push(structuredClone(value.activationChecks[0])); }, "activation_check_reference_invalid"],
    [(value: { activationChecks: { acceptanceId: string; }[]; }) => { value.activationChecks![0]!.acceptanceId = "language_decision"; }, "activation_check_reference_invalid"],
    [(value: { activationChecks: { caseIds: string[]; }[]; }) => { value.activationChecks![0]!.caseIds = ["PRIVATE_UNKNOWN_CASE"]; }, "activation_case_invalid"],
    [(value: { activationChecks: { caseIds: string[]; }[]; }) => { value.activationChecks![0]!.caseIds = ["valid"]; }, "activation_requirement_missing"],
    [(value: { activationChecks: { caseIds: string[]; }[]; }) => { value.activationChecks![0]!.caseIds = ["valid", "valid"]; }, "activation_case_invalid"],
  ] as const) {
    const { architecture, plan } = fixture(); callFixture(change, undefined, [plan]);
    const issues = activationCheckIssues(plan, { architecture });
    assert.ok(issues.some((item) => item.reason === reason), reason!);
    assert.doesNotMatch(JSON.stringify(issues), /PRIVATE_UNKNOWN_CASE/);
    assert.throws(() => validatePlan(plan, { architecture }));
  }
});

test("启用映射拒绝页面脚本、未公开动作、入口未拒绝或不匹配的验收适配器", () => {
  for (const change of [
    (value: { cases: { kind: string; }[]; }) => { value.cases![0]!.kind = "node-check"; },
    (value: { cases: { actionId: string; }[]; }) => { value.cases![0]!.actionId = "not_public"; },
    (value: { cases: { input: string; }[]; }) => { value.cases![1]!.input = '{"value":1}'; },
    (value: { cases: { acceptanceId: string; }[]; }) => { value.cases![0]!.acceptanceId = "language_decision"; },
  ]) {
    const { architecture, plan } = fixture(); callFixture(change, undefined, [plan]);
    assert.ok(activationCheckIssues(plan, { architecture }).some((item) => item.reason === "activation_case_invalid"));
    assert.throws(() => validatePlan(plan, { architecture }));
  }
});

test("修订可扩展启用映射但不能删弱旧映射，原用例和断言仍冻结", () => {
  const { architecture, plan } = fixture();
  plan.cases.push({ ...structuredClone(plan.cases[0])!, id: "valid_second" });
  const extended = structuredClone(plan); extended.activationChecks![0]!.caseIds.push("valid_second");
  assert.doesNotThrow(() => validatePlan(extended, { architecture, previousPlan: plan }));
  const reduced = structuredClone(extended); reduced.activationChecks![0]!.caseIds = ["valid_second", "invalid"];
  assert.throws(() => callFixture(validatePlan, undefined, [reduced, { architecture, previousPlan: extended }]), (error: TestFailure) => error.developmentIssue!.reason === "activation_check_frozen");
  const weaker = structuredClone(extended); weaker.cases![0]!.assertions[0]!.expectedJson = "2";
  assert.throws(() => callFixture(validatePlan, undefined, [weaker, { architecture, previousPlan: extended }]), /不能删除或放宽/);
});

test("独立诊断同时列出启用映射与需求缺项，静态和启用责任保留待验证台账", () => {
  const { architecture, plan } = fixture();
  architecture.design.acceptance.push({ id: "other_activation", requirementIds: ["business"], verification: descriptor("activation", "platform", "host-business") });
  plan.activationChecks![0]!.caseIds = ["PRIVATE_UNKNOWN_CASE"];
  const ledger = diagnosePlanningPlan(plan, PLAN_V3_SCHEMA, { architecture });
  for (const reason of ["activation_checks_missing", "activation_case_invalid", "activation_requirement_missing"])
    assert.ok(ledger.issues.some((item) => item.reason === reason), reason);
  assert.doesNotMatch(JSON.stringify(ledger), /PRIVATE_UNKNOWN_CASE/);
  assert.ok(ledger.verificationAssignments.some((item) => item.adapterId === "delivery-review" && item.status === "not_run"));
  assert.ok(ledger.verificationAssignments.some((item) => item.adapterId === "host-business" && item.status === "not_run"));
});

test("提交失败保留启用映射准确位置，缺研发任务回执不把静态及宿主责任改成任务", () => {
  const { architecture, plan } = fixture(); plan.activationChecks![0]!.caseIds = ["valid"];
  let error; try { validatePlan(plan, { architecture }); } catch (value) { error = value; }
  const issues = submissionIssues(plan, PLAN_V3_SCHEMA, { root: "plan", architecture, error });
  assert.equal(issues[0]!.path, "plan.activationChecks[0].caseIds");
  assert.equal(issues[0]!.reason, "activation_requirement_missing"); assert.equal(issues[0]!.referenceId, "invalid");
  plan.activationChecks![0]!.caseIds.push("invalid"); plan.tasks![0]!.requirementIds = ["business"];
  try { validatePlan(plan, { architecture }); } catch (value) { error = value; }
  const missing = submissionIssues(plan, PLAN_V3_SCHEMA, { root: "plan", architecture, error });
  assert.equal(missing.length, 1); assert.match(missing[0]!.remedy, /invalid/);
  assert.doesNotMatch(JSON.stringify(missing), /language_decision|activation_matrix|static/u);
});

test("规划文件索引与封存快照完整保留启用映射，不复制或改写用例", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-activation-plan-"));
  t.after(async () => {
    const unseal = async (path: string) => { await chmod(path, 0o700); for (const item of await readdir(path, { withFileTypes: true }))
      if (item.isDirectory() && !item.isSymbolicLink()) await unseal(join(path, item.name)); };
    await unseal(root); await rm(root, { recursive: true, force: true });
  });
  const { architecture, plan } = fixture(), artifacts = new DevelopmentArtifacts({ dataDir: root });
  const tools = await artifacts.tools("agent", "run", { planSchema: PLAN_V3_SCHEMA, casesSchema: PLAN_V3_SCHEMA.properties.cases, architecture });
  const execute = (name: string, value: unknown) => fixtureTools(tools)[name]!.execute("fixture", value);
  const { cases, ...index } = plan;
  await execute("save_plan_json", { path: "index.json", value: { ...index, caseFiles: ["cases.json"] } });
  await execute("save_plan_cases", { path: "cases.json", cases });
  const frozen = await artifacts.submit("agent", "run", "index.json");
  assert.deepEqual(frozen.plan, plan);
  assert.doesNotThrow(() => validatePlan(frozen.plan, { architecture }));
  assert.equal((await artifacts.diagnose("agent", "run", "index.json", { schema: PLAN_V3_SCHEMA, architecture })).diagnostics.total, 0);
});

test("独立激活用例材料按索引分组保存、全局查重、完整诊断与冻结", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-dedicated-activation-plan-"));
  t.after(async () => {
    const unseal = async (path: string) => { await chmod(path, 0o700); for (const item of await readdir(path, { withFileTypes: true }))
      if (item.isDirectory() && !item.isSymbolicLink()) await unseal(join(path, item.name)); };
    await unseal(root); await rm(root, { recursive: true, force: true });
  });
  const { architecture, plan } = dedicatedFixture(), artifacts = new DevelopmentArtifacts({ dataDir: root });
  const tools = await artifacts.tools("agent", "run", { planSchema: PLAN_V3_SCHEMA, casesSchema: PLAN_V3_SCHEMA.properties.cases, architecture });
  const execute = (name: string, value: unknown) => fixtureTools(tools)[name]!.execute("fixture", value);
  const { cases, activationCases, ...index } = plan;
  await execute("save_plan_json", { path: "index.json", value: { ...index, caseFiles: ["cases.json"], activationCaseFiles: ["activation.json"] } });
  await execute("save_plan_cases", { path: "cases.json", cases });
  const before = await artifacts.diagnose("agent", "run", "index.json", { schema: PLAN_V3_SCHEMA, architecture });
  assert.ok(before.diagnostics.issues.some((item) => item.path === "planningFiles.activationCaseFiles[0]" && item.reason === "planning_material_missing"));
  await assert.rejects(execute("save_plan_cases", { path: "activation.json", cases: [{ ...activationCases[0]!, id: cases[0]!.id }] }), /重复/u);
  await execute("save_plan_cases", { path: "activation.json", cases: activationCases });
  const sourcePath = await artifacts.directory("agent", "run"), bytes = await readFile(join(sourcePath, "activation.json"));
  await assert.rejects(execute("save_plan_cases", { path: "activation.json", cases: [{ ...activationCases[0]!, acceptanceId: "calculation" }] }), /尚不符合/u);
  assert.deepEqual(await readFile(join(sourcePath, "activation.json")), bytes);
  const complete = await artifacts.diagnose("agent", "run", "index.json", { schema: PLAN_V3_SCHEMA, architecture });
  assert.equal(complete.diagnostics.total, 0);
  const frozen = await artifacts.submit("agent", "run", "index.json");
  assert.deepEqual(frozen.plan, plan);
  assert.deepEqual(validatePlan(frozen.plan, { architecture }), plan);
  assert.deepEqual((await artifacts.validateSnapshot(frozen.snapshot)).plan, plan);
  assert.ok(frozen.snapshot.files.some((item) => item.path === "activation.json"));
  const frozenTools = await artifacts.tools("agent", "run", { planSchema: PLAN_V3_SCHEMA, casesSchema: PLAN_V3_SCHEMA.properties.cases, architecture, previousPlan: plan });
  const read = JSON.parse(String(toolText((await fixtureTools(frozenTools).read_plan_file!.execute("read", { path: "activation.json", offset: 0, limit: 1000 })))));
  await assert.rejects(fixtureTools(frozenTools).edit_plan_cases!.execute("edit", { path: "activation.json", expectedHash: read.hash,
    changes: [{ op: "remove", id: "activation_valid" }] }), /冻结/u);
});

test("真实Pi正式提交收到完整有界台账及材料定位，按同hash续页修正后仍走原完整校验", { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-plan-ledger-sdk-")), { architecture, plan } = dedicatedFixture();
  const dataDir = join(root, "data");
  const good = Array.from({ length: 42 }, (_, index) => ({ ...structuredClone(plan.activationCases[0])!, id: `activation_${index}` }));
  plan.activationCases = good.map((item) => ({ ...item, kind: "input-rejection", input: '{"value":2}' }));
  plan.activationChecks![0]!.caseIds = ["valid", "invalid", ...good.map((item) => item.id)];
  let calls = 0, firstLedger: { submitted: unknown; total: number; issues: unknown[]; nextOffset: unknown; hash: string; hostModelBudget: { used: unknown; }; }, nextLedger, serverError, controller: DevelopmentController, handle: DevelopmentHandle<unknown>|undefined, ctx: unknown;
  const textOf = (content: unknown) => typeof content === "string" ? content : recordArray(content).filter((item) => item.type === "text").map((item) => fixtureText(item.text)).join("\n");
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(String(Buffer.concat(chunks))); calls++;
      if (calls === 4) {
        assert.equal(JSON.parse(String(textOf(body.messages.findLast((item: { role: string; }) => item.role === "tool").content))).submitted, true);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`data: ${JSON.stringify({ id: "ledger-complete", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0,
          delta: { role: "assistant", content: "阶段提交已接收。" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      let tools;
      if (calls === 1) tools = [{ name: "submit_development_plan", args: { indexPath: "index.json" } }];
      else if (calls === 2) {
        const error = textOf(body.messages.findLast((item: { role: string; }) => item.role === "tool").content);
        assert.match(error, /^提交未通过：/u);
        firstLedger = JSON.parse(String(error.slice(error.indexOf("{"))));
        assert.equal(firstLedger.submitted, false); assert.equal(firstLedger.total > 40, true);
        assert.equal(firstLedger.issues.length, 40); assert.equal(firstLedger.nextOffset, 40);
        assert.match(firstLedger.hash, /^[a-f0-9]{64}$/u);
        assert.ok(recordArray(firstLedger.issues).every((item) => objectFields(item.source).path === "activation.json" && objectFields(item.source).caseId));
        assert.ok(recordArray(firstLedger.issues).every((item) => item.reason === "input_rejection_not_rejected"));
        assert.equal(firstLedger.hostModelBudget.used, 1);
        tools = [{ name: "read_plan_diagnostics", args: { indexPath: "index.json", expectedHash: firstLedger.hash, offset: firstLedger.nextOffset, limit: 40 } }];
      } else {
        assert.equal(calls, 3, textOf(body.messages.findLast((item: { role: string; }) => item.role === "tool").content));
        const text = textOf(body.messages.findLast((item: { role: string; }) => item.role === "tool").content);
        const parsed = text.split("\n").map((line) => { try { return JSON.parse(String(line)); } catch { return null; } }).filter(Boolean);
        nextLedger = parsed.find((item: { diagnostics: unknown; }) => item.diagnostics);
        assert.equal(nextLedger.hash, firstLedger.hash);
        assert.equal(nextLedger.diagnostics.total, firstLedger.total);
        assert.equal(nextLedger.diagnostics.offset, 40);
        assert.ok(nextLedger.diagnostics.issues.some((item: { reason: string; }) => item.reason === "activation_case_invalid"));
        tools = [{ name: "save_plan_cases", args: { path: "activation.json", cases: good } },
          { name: "submit_development_plan", args: { indexPath: "index.json" } }];
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "ledger-fixture", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0,
        delta: { role: "assistant", tool_calls: tools.map((item, index) => ({ index, id: `ledger_${calls}_${index}`, type: "function",
          function: { name: item.name, arguments: JSON.stringify(item.args) } })) }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      serverError = error; response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: objectFields(error).message } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    if (handle) callFixture(controller.dispose, controller, [ctx, handle]);
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const unseal = async (path: string) => { await chmod(path, 0o700); for (const item of await readdir(path, { withFileTypes: true })) if (item.isDirectory()) await unseal(join(path, item.name)); };
    await unseal(root); await rm(root, { recursive: true, force: true });
  });
  const controllerOptions = { cwd: root, dataDir, config: { llmConfigured: true, model: "fixture-model", apiKey: "fixture-only",
    chatUrl: `http://127.0.0.1:${listeningAddress(server).port}/v1/chat/completions` },
    sessionFactory: async (options: Parameters<typeof createPiSession>[0]) => { const session = await createPiSession(options); session.setAutoRetryEnabled(false); return session; } };
  Reflect.set(controllerOptions, "store", { save: async (value: { revision: number; [key: string]: unknown }) => ({ ...value, revision: value.revision + 1, updatedAt: "fixture" }) });
  controller = new DevelopmentController(controllerOptions);
  const record = { id: "dev_ledger", agentId: "ledger", architecture, architectureRef: { version: 1, candidateHash: hashValue(architecture.design) },
    phase: "planning", revision: 0 };
  ctx = { record, signal: new AbortController().signal, writes: Promise.resolve(), handles: new Set() }; callFixture(controller.active.set, controller.active, [record.agentId, ctx]);
  await controller.workspace.create(record.agentId, record.id);
  const tools = await controller.artifacts.tools(record.agentId, record.id, { casesSchema: PLAN_V3_SCHEMA.properties.cases, planSchema: PLAN_V3_SCHEMA, architecture });
  const { cases, activationCases, ...index } = plan;
  const write = (path: string, value: unknown) => fixtureTools(tools).write!.execute("seed", { path, content: JSON.stringify(value) });
  await write("index.json", { ...index, caseFiles: ["cases.json"], activationCaseFiles: ["activation.json"] });
  await write("cases.json", cases); await write("activation.json", activationCases);
  handle = await callFixture(controller.role, controller, [ctx, { kind: "planner", tools, scope: {}, counter: { turns: 0 }, limit: 12,
    validate: (value: unknown) => validatePlan(value, { architecture }) }]);
  let accepted;
  try { accepted = await callFixture(controller.ask, controller, [ctx, handle, { requirements: architecture.requirements, architecture, planSchema: PLAN_V3_SCHEMA }]); }
  catch (error) { throw serverError ?? error; }
  assert.equal(serverError, undefined); assert.equal(calls, 4); assert.equal(objectFields(objectFields(accepted).activationCases).length, 42);
  assert.deepEqual(objectFields(accepted).activationCases, good);
  assert.equal(objectFields(objectFields(objectFields(record).submissionCounts).planner).rejected, 1); assert.equal(objectFields(objectFields(objectFields(record).submissionCounts).planner).accepted, 1);
  assert.equal(recordArray(recordArray(objectFields(record).submissionAttempts)[0]!.issues).length, 40);
  assert.deepEqual((await callFixture(controller.artifacts.validateSnapshot, controller.artifacts, [objectFields(record).planningArtifact])).plan, accepted);
});
