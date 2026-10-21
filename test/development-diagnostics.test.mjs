import test from "node:test";
import assert from "node:assert/strict";
import { InputError } from "../src/requirements/core.mjs";
import { PLAN_SCHEMA, PLAN_V2_SCHEMA, PLAN_V3_SCHEMA, WORK_SCHEMA, validatePlan } from "../src/development/development-contract.mjs";
import { submissionIssues, planningToolIssues } from "../src/development/development-diagnostics.mjs";
import { DevelopmentController } from "../src/development/development.mjs";
import { developmentArchitecture, developmentPlan, developmentWork } from "./helpers/development.mjs";

const valueSchema = () => ({ type: "object", properties: {}, required: [], additionalProperties: false });
function fixture(managed = false) {
  const architecture = developmentArchitecture();
  Object.assign(architecture.design, { schemaVersion: managed ? 3 : 2, connections: [], interaction: { page: false },
    ...(managed ? { execution: { language: "python", hosting: "managed" } } : {}) });
  const plan = developmentPlan(architecture), runtime = managed ? "managed-service" : "node-action", entrypoint = managed ? "main.py" : "main.mjs";
  Object.assign(plan, { schemaVersion: managed ? 3 : 2, runtime, entrypoint,
    application: { protocolVersion: managed ? 3 : 2, runtime, entrypoint, page: null,
      actions: [{ id: "run", title: "处理", inputSchema: valueSchema(), outputSchema: valueSchema(), connectionIds: [] }], stateVersion: 1, evidenceIds: [],
      ...(managed ? { service: { schemaVersion: 1, language: "python", host: "managed", entrypoint, dataVersion: 1,
        operations: [{ id: "run", inputSchema: valueSchema(), outputSchema: valueSchema(), connectionIds: [] }] } } : {}) } });
  plan.tasks.forEach((task) => { task.files = [entrypoint]; });
  plan.cases.forEach((item) => Object.assign(item, { kind: "action", actionId: "run", mocks: [], input: "{}" }));
  return { architecture, plan, schema: managed ? PLAN_V3_SCHEMA : PLAN_V2_SCHEMA };
}
function rejected(plan, architecture, schema) {
  let error;
  try { validatePlan(plan, { architecture }); } catch (failure) { error = failure; }
  assert.ok(error, "固定错误必须由真实契约拒绝");
  return submissionIssues(plan, schema, { root: "plan", error });
}

test("开发改动声明越权只返回固定字段诊断，不回传错误路径或原始异常", () => {
  const work = developmentWork(developmentPlan().tasks[0], { changedFiles: ["PRIVATE_FILE.mjs"] });
  const error = Object.assign(new InputError("PRIVATE_ERROR_BODY"), { reason: "work_file_unauthorized" });
  const issues = submissionIssues(work, WORK_SCHEMA, { root: "work", error });
  assert.equal(issues[0].path, "work.changedFiles"); assert.equal(issues[0].reason, "work_file_unauthorized");
  assert.match(issues[0].remedy, /task\.files.*原会话/);
  assert.doesNotMatch(JSON.stringify(issues), /PRIVATE_/);
});

test("真实规划契约拒绝映射具体字段及固定修复建议，不再只有plan/contract_invalid", () => {
  for (const [mutate, path, reason] of [
    [(plan) => { delete plan.cases[0].mocks; }, "plan.cases[0].mocks", "required"],
    [(plan) => { plan.cases[0].acceptanceId = plan.tasks[1].acceptanceIds[0]; }, "plan.cases[].acceptanceId", "task_acceptance_mismatch"],
    [(plan) => { plan.tasks[0].dependsOn = [plan.tasks[1].id]; }, "plan.tasks[].dependsOn", "dependency_cycle"],
    [(plan) => { plan.application.entrypoint = "other.mjs"; }, "plan.application.entrypoint", "entrypoint_mismatch"],
  ]) {
    const { plan, architecture, schema } = fixture(); mutate(plan);
    const issues = rejected(plan, architecture, schema);
    assert.equal(issues[0].path, path); assert.equal(issues[0].reason, reason); assert.ok(issues[0].remedy.length > 10);
  }
});

test("应用及服务动作结构用现有校验器定位inputSchema/outputSchema，不输出动态字段或参数", () => {
  for (const managed of [false, true]) {
    const { plan, architecture, schema } = fixture(managed);
    const target = managed ? plan.application.service.operations[0] : plan.application.actions[0];
    target.outputSchema = { type: "object", properties: { PRIVATE_FIELD: { type: "string", pattern: "PRIVATE_PATTERN" } },
      required: [], additionalProperties: false };
    const issues = rejected(plan, architecture, schema);
    assert.equal(issues[0].path, managed ? "plan.application.service.operations[0].outputSchema" : "plan.application.actions[0].outputSchema");
    assert.equal(issues[0].reason, "schema_rule_unsupported"); assert.doesNotMatch(JSON.stringify(issues), /PRIVATE_/);
  }
  const { plan, architecture, schema } = fixture(); plan.application.actions[0].inputSchema.additionalProperties = true;
  const issues = rejected(plan, architecture, schema);
  assert.equal(issues[0].path, "plan.application.actions[0].inputSchema"); assert.equal(issues[0].reason, "schema_object_invalid");
});

test("声明式夹具的真实输入拒绝定位到用例，不回显动态输入字段", () => {
  const { plan, architecture, schema } = fixture();
  plan.cases[0].input = { fixture: { op: "object", fields: { PRIVATE_INPUT_FIELD: { op: "value", value: "PRIVATE_INPUT_VALUE" } } } };
  const issues = rejected(plan, architecture, schema);
  assert.equal(issues[0].path, "plan.cases[0].input");
  assert.equal(issues[0].reason, "action_input_invalid");
  assert.doesNotMatch(JSON.stringify(issues), /PRIVATE_/);
});

test("动作完整入参为对象而用例展开成字符串时，反馈根类型而不泄漏字段或业务值", () => {
  for (const input of [JSON.stringify("PRIVATE_BUSINESS_JSON"), { fixture: { op: "value", value: "PRIVATE_BUSINESS_JSON" } }]) {
    const { plan, architecture, schema } = fixture();
    plan.application.actions[0].inputSchema = { type: "object", properties: { PRIVATE_FIELD: { type: "string" } }, required: ["PRIVATE_FIELD"], additionalProperties: false };
    plan.cases[0].input = input;
    const [result] = rejected(plan, architecture, schema);
    assert.equal(result.path, "plan.cases[0].input"); assert.equal(result.reason, "action_input_invalid");
    assert.equal(result.expectedType, "object"); assert.equal(result.receivedType, "string");
    assert.match(result.remedy, /完整动作入参对象.*不能把对象内某个业务JSON文本字段的字符串作为整个input/);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  }
});

test("真实用例JSON值文本错误定位input、替身和预期字段，不重放展开或回显内容", () => {
  for (const [mutate, field] of [
    [(item) => { item.input = "PRIVATE_NOT_JSON"; }, "input"],
    [(item) => { item.mocks = [{ capability: "files.write", argsJson: "PRIVATE_NOT_JSON", resultJson: "{}" }]; }, "mocks[0].argsJson"],
    [(item) => { item.mocks = [{ capability: "files.write", argsJson: "{}", resultJson: "PRIVATE_NOT_JSON" }]; }, "mocks[0].resultJson"],
    [(item) => { item.assertions[0].expectedJson = "PRIVATE_NOT_JSON"; }, "assertions[0].expectedJson"],
  ]) {
    const { plan, architecture, schema } = fixture(); mutate(plan.cases[0]);
    let error; try { validatePlan(plan, { architecture }); } catch (failure) { error = failure; }
    assert.equal(error.reason, "fixture_json_required"); assert.equal(error.fixtureCaseIndex, 0); assert.equal(error.fixtureField, field);
    const [result] = submissionIssues(plan, schema, { root: "plan", error });
    assert.equal(result.path, `plan.cases[0].${field}`); assert.equal(result.reason, "invalid_json");
    assert.match(result.remedy, /字符串预期需JSON字符串编码.*fixture.*原输入与断言/);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_NOT_JSON/);
  }
  const { plan, architecture, schema } = fixture();
  const error = Object.assign(new InputError("PRIVATE_ERROR"), { reason: "fixture_json_required", fixtureCaseIndex: 0, fixtureField: "PRIVATE_FIELD" });
  assert.doesNotMatch(JSON.stringify(submissionIssues(plan, schema, { root: "plan", error })), /PRIVATE_/);
});

test("入口拒绝用例若实际通过输入契约，反馈要求真实运行业务错误检查", () => {
  for (const input of ["{}", { fixture: { op: "object", fields: {} } }]) {
    const { plan, architecture, schema } = fixture();
    Object.assign(plan.cases[0], { kind: "input-rejection", input });
    const issues = rejected(plan, architecture, schema);
    assert.equal(issues[0].path, "plan.cases[0].kind");
    assert.equal(issues[0].reason, "input_rejection_not_rejected");
    assert.match(issues[0].remedy, /实际运行/);
  }
});

test("无页面交付的页面检查使用当前静态契约错误定位用例种类", () => {
  const { plan, architecture, schema } = fixture();
  const item = plan.cases[0];
  Object.assign(item, { kind: "node-check", entrypoint: "check.mjs" });
  delete item.actionId; delete item.mocks;
  plan.tasks[0].files.push("check.mjs");
  const issues = rejected(plan, architecture, schema);
  assert.equal(issues[0].path, "plan.cases[].kind");
  assert.equal(issues[0].reason, "node_check_invalid");
});

test("服务固定错误码保留数值范围诊断，未知异常和伪造详细路径不泄露原文", () => {
  const { plan, architecture, schema } = fixture(true); plan.application.service.resources = { memoryMiB: 1 };
  const issues = rejected(plan, architecture, schema);
  assert.equal(issues[0].path, "plan.application.service.resources.memoryMiB"); assert.equal(issues[0].reason, "invalid_service_limits");
  assert.equal(issues[0].minimum, 32); assert.equal(issues[0].maximum, 8192);
  const error = Object.assign(new Error("PRIVATE_ERROR_BODY"), { reason: "PRIVATE_REASON", developmentIssue: { path: "plan.PRIVATE_FIELD", reason: "invalid_reference" } });
  const safe = submissionIssues(developmentPlan(), PLAN_SCHEMA, { root: "plan", error });
  assert.equal(safe[0].path, "plan"); assert.equal(safe[0].reason, "contract_invalid"); assert.doesNotMatch(JSON.stringify(safe), /PRIVATE_/);
});

test("JSON验收文本超限建议保留规模并使用夹具，普通文案及Node检查不提供无效修复入口", () => {
  const { plan, schema } = fixture();
  plan.summary = "文".repeat(4001); plan.cases[0].input = " ".repeat(12001);
  plan.cases[0].assertions[0].expectedJson = " ".repeat(60001);
  const issues = submissionIssues(plan, schema, { root: "plan", sdk: true });
  assert.match(issues.find((item) => item.path === "plan.summary").remedy, /缩短/);
  for (const path of ["plan.cases[0].input", "plan.cases[0].assertions[0].expectedJson"]) {
    const result = issues.find((item) => item.path === path && item.reason === "maxLength");
    assert.match(result.remedy, /保留测试规模与预期.*声明式夹具.*不删减边界数据/);
  }
  plan.cases[0].kind = "node-check";
  const nodeIssues = submissionIssues(plan, schema, { root: "plan", sdk: true });
  assert.doesNotMatch(nodeIssues.find((item) => item.path === "plan.cases[0].input" && item.reason === "maxLength").remedy, /夹具/);
});

test("覆盖检查给出批准需求与验收编号，规划预检可以一次定位缺失映射", () => {
  const architecture = developmentArchitecture(), plan = developmentPlan(architecture);
  const removed = plan.cases.shift();
  let rejection;
  try { validatePlan(plan, { architecture }); } catch (error) { rejection = error; }
  assert.ok(rejection);
  const issues = submissionIssues(plan, PLAN_SCHEMA, { root: "plan", error: rejection, architecture });
  assert.ok(issues.some((item) => item.reason === "missing_coverage" && item.path === "plan.cases" && item.remedy.includes(removed.acceptanceId)));
  const withoutArchitecture = submissionIssues(plan, PLAN_SCHEMA, { root: "plan", error: rejection });
  assert.equal(withoutArchitecture[0].reason, "missing_coverage");
});

test("规划JSON诊断只传解析器行列数字，不回显文件内容且拒绝伪造位置", () => {
  const error = Object.assign(new InputError("PRIVATE_BODY"), { reason: "planning_artifact_invalid",
    artifactIssue: { indexField: "caseFiles", fileIndex: 1, parseError: "json", location: { offset: 1433, line: 25, column: 17, extra: "PRIVATE_BODY" } } });
  const [result] = submissionIssues({}, PLAN_V2_SCHEMA, { root: "plan", error });
  assert.deepEqual(result.location, { offset: 1433, line: 25, column: 17 });
  assert.equal(result.path, "planningFiles.caseFiles[1]");
  assert.match(result.remedy, /第 25 行.*第 17 列.*save_plan_json/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_BODY/);
  for (const location of [{ offset: "1433", line: 25, column: 17 }, { offset: -1, line: 25, column: 17 }, { offset: 1433, line: Infinity, column: 17 }]) {
    error.artifactIssue.location = location;
    assert.equal(submissionIssues({}, PLAN_V2_SCHEMA, { root: "plan", error })[0].location, undefined);
  }
});

test("结构化规划工具的SDK拒绝反馈具体字段与收到类型，不输出参数正文", () => {
  const schema = { type: "object", properties: { path: { type: "string" }, value: { anyOf: [{ type: "object" }, { type: "array" }, { type: "string" }] } }, required: ["path", "value"], additionalProperties: false };
  const save = planningToolIssues({ path: "index.json", value: 7 }, schema, "save_plan_json");
  assert.equal(save.length, 1); assert.equal(save[0].path, "save_plan_json.value"); assert.equal(save[0].receivedType, "number");
  assert.match(save[0].remedy, /不接受数值/); assert.doesNotMatch(JSON.stringify(save), /PRIVATE_JSON_BODY/);
  const casesSchema = { type: "object", properties: { path: { type: "string" }, cases: PLAN_V2_SCHEMA.properties.cases }, required: ["path", "cases"], additionalProperties: false };
  const [batch] = planningToolIssues({ path: "cases.json", cases: "PRIVATE_JSON_BODY" }, casesSchema, "save_plan_cases");
  assert.equal(batch.path, "save_plan_cases.cases"); assert.equal(batch.receivedType, "string");
  assert.match(batch.remedy, /cases须直接传非空JSON数组.*不要JSON.stringify成字符串/);
  assert.doesNotMatch(JSON.stringify(batch), /PRIVATE_JSON_BODY/);
  const updateSchema = { type: "object", properties: { path: { type: "string" }, updates: { type: "array", items: {
    type: "object", properties: { pointer: { type: "string" }, value: {} }, required: ["pointer", "value"], additionalProperties: false } } }, required: ["path", "updates"], additionalProperties: false };
  for (const [updates, path, type, remedy] of [
    ["PRIVATE_JSON_BODY", "update_plan_json.updates", "string", /更新数组/],
    [[{ pointer: 1, value: "safe" }], "update_plan_json.updates[0].pointer", "number", /JSON Pointer字符串/],
    [[{ pointer: "/0/input" }], "update_plan_json.updates[0].value", "missing", /必须提供value/],
    [["PRIVATE_JSON_BODY"], "update_plan_json.updates[0]", "string", /包含pointer和value的JSON对象/],
  ]) {
    const [result] = planningToolIssues({ path: "case.json", updates }, updateSchema, "update_plan_json");
    assert.equal(result.path, path); assert.equal(result.receivedType, type); assert.match(result.remedy, remedy);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_JSON_BODY/);
  }
});

test("研发结构诊断提供当前字段类型、枚举和上限，联合结构保留嵌套位置", () => {
  const submit = { type: "object", properties: { indexPath: { type: "string" } }, required: ["indexPath"], additionalProperties: false };
  const [index] = submissionIssues({ indexPath: 7 }, submit, { root: "plan", sdk: true });
  assert.equal(index.path, "plan.indexPath"); assert.equal(index.expectedType, "string"); assert.equal(index.receivedType, "number");
  const extra = submissionIssues({ indexPath: "index.json", schemaVersion: 3 }, submit, { root: "plan", sdk: true });
  assert.equal(extra[0].path, "plan"); assert.equal(extra[0].reason, "additionalProperties");
  assert.deepEqual(extra[0].allowedFields, ["indexPath"], "文件引用提交不能误按完整计划应用清单解释");
  const edit = { type: "object", properties: { changes: { type: "array", items: { type: "object", properties: {
    op: { type: "string", enum: ["add", "replace", "remove", "move"] }, localIndex: { type: "integer", maximum: 199 },
  }, required: ["op"], additionalProperties: false } } }, required: ["changes"], additionalProperties: false };
  const problems = planningToolIssues({ changes: [{ op: "PRIVATE_INVALID_OP", localIndex: 200 }] }, edit, "edit_plan_cases");
  assert.deepEqual(problems.find((entry) => entry.reason === "enum").allowedValues, ["add", "replace", "remove", "move"]);
  const maximum = problems.find((entry) => entry.path === "edit_plan_cases.changes[0].localIndex");
  assert.equal(maximum.reason, "maximum"); assert.equal(maximum.constraints.maximum, 199);
  const branch = { type: "object", properties: { value: { anyOf: [{ type: "string" }, { type: "object", properties: {
    fixture: { type: "object", properties: { count: { type: "integer", minimum: 1 } }, required: ["count"], additionalProperties: false },
  }, required: ["fixture"], additionalProperties: false }] } }, required: ["value"], additionalProperties: false };
  const nested = planningToolIssues({ value: { fixture: { count: "PRIVATE_INVALID_COUNT" } } }, branch, "save_plan_json");
  assert.ok(nested.some((entry) => entry.path === "save_plan_json.value.fixture.count" && entry.expectedType === "integer" && entry.receivedType === "string"));
  assert.doesNotMatch(JSON.stringify([...problems, ...nested]), /PRIVATE_/u);
});

test("提交工具向模型反馈同份安全诊断，同时保存拒绝且不泄露原始异常或放宽预算", async () => {
  let options;
  const architecture = developmentArchitecture(), record = { id: "dev_diagnostics", agentId: "diagnostics", architecture,
    architectureRef: { version: architecture.version, candidateHash: architecture.candidateHash }, phase: "planning", revision: 0 };
  const controller = new DevelopmentController({ config: {}, cwd: "/tmp", dataDir: "/tmp",
    workspace: { workspacePath: async () => "/tmp" }, storage: { directory: async () => "/tmp" },
    store: { save: async (value) => ({ ...value, revision: value.revision + 1, updatedAt: "fixture" }) },
    sessionFactory: async (input) => { options = input; return { subscribe: () => () => {}, dispose() {} }; } });
  const ctx = { record, signal: new AbortController().signal, writes: Promise.resolve(), handles: new Set() };
  controller.active.set(record.agentId, ctx);
  const counter = { turns: 3 };
  const handle = await controller.role(ctx, { kind: "planner", scope: {}, counter, limit: 12, validate() { throw new InputError("PRIVATE_ERROR_BODY"); } });
  handle.accepting = true;
  const tool = options.customTools.find((item) => item.name === "submit_development_plan");
  await assert.rejects(tool.execute("rejected", developmentPlan()), (error) => {
    assert.ok(error instanceof InputError); assert.match(error.message, /plan \[contract_invalid\]/);
    assert.doesNotMatch(error.message, /PRIVATE_|Received arguments/); return true;
  });
  assert.equal(record.submissionCounts.planner.rejected, 1); assert.equal(handle.submitted, false); assert.equal(counter.turns, 3);
  assert.doesNotMatch(JSON.stringify(record.submissionAttempts), /PRIVATE_/);
  controller.dispose(ctx, handle);
  const semantic = fixture(); record.architecture = semantic.architecture;
  delete semantic.plan.cases[0].mocks; semantic.plan.summary = "PRIVATE_SUBMITTED_VALUE";
  controller.artifacts = { submit: async () => ({ plan: semantic.plan, snapshot: {} }), diagnose: async () => ({ diagnostics: { total: 0 } }) };
  const next = await controller.role(ctx, { kind: "planner", scope: {}, counter, limit: 12,
    validate: (value) => validatePlan(value, { architecture: semantic.architecture }) });
  next.accepting = true;
  const semanticTool = options.customTools.find((item) => item.name === "submit_development_plan");
  await assert.rejects(semanticTool.execute("semantic-rejected", { indexPath: "index.json" }), (error) => {
    assert.match(error.message, /plan\.cases\[0\]\.mocks \[required\]/);
    assert.match(error.message, /必填字段/); assert.doesNotMatch(error.message, /PRIVATE_/); return true;
  });
  assert.equal(record.submissionCounts.planner.rejected, 2); assert.equal(next.submitted, false); assert.equal(counter.turns, 3);
  controller.dispose(ctx, next);
});
