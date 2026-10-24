import { recordArray } from "./helpers/m7-test-boundaries.mjs";
import { callFixture } from "./helpers/m7-test-boundaries.mjs";
import type { DevelopmentPlan, DevelopmentArchitecture, DevelopmentApplication } from "../src/contracts/development.mjs";
import type { ValueSchema } from "../src/contracts/application.mjs";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { Ajv } from "ajv";
import { InputError } from "../src/requirements/core.mjs";
import { PLAN_SCHEMA, PLAN_V3_SCHEMA, REVIEW_SCHEMA, WORK_SCHEMA, hashValue, safeRelativePath,
  validatePlan, validateReview, validateWork } from "../src/development/development-contract.mjs";
import { recordSubmission, submissionIssues } from "../src/development/development-diagnostics.mjs";

function architecture(): DevelopmentArchitecture & { requirements: { id: string; text: string }[]; design: NonNullable<DevelopmentArchitecture["design"]> & { acceptance: { id: string; requirementIds: string[]; verification?: unknown }[] } } {
  return { requirements: [{ id: "goal", text: "提取记录" }, { id: "input", text: "处理空输入" }],
    design: { acceptance: [{ id: "success", requirementIds: ["goal"] }, { id: "empty", requirementIds: ["input"] }] } };
}

function plan(): Extract<DevelopmentPlan, { runtime: "node-json" }> {
  return { summary: "先提取记录，再处理缺少输入", runtime: "node-json", entrypoint: "src/main.mjs",
    tasks: [
      { id: "extract", title: "提取", description: "提取文字", requirementIds: ["goal"], acceptanceIds: ["success"], dependsOn: [], files: ["src/main.mjs"] },
      { id: "guard", title: "输入检查", description: "缺少输入时返回错误码", requirementIds: ["input"], acceptanceIds: ["empty"], dependsOn: ["extract"], files: ["src/main.mjs"] },
    ], cases: [
      { id: "extract_one", taskId: "extract", acceptanceId: "success", input: "本周完成原型", assertions: [{ path: "items.0", expectedJson: '"本周完成原型"' }] },
      { id: "guard_empty", taskId: "guard", acceptanceId: "empty", input: "", assertions: [{ path: "", expectedJson: '{"error":"missing_input"}' }] },
    ] };
}

const check = (value: unknown, options = {}) => validatePlan(value, { architecture: architecture(), ...options });

function pagePlan(): Extract<DevelopmentPlan, { schemaVersion: 2 | 3 }> {
  const base = plan();
  return { ...base, schemaVersion: 2, runtime: "node-action", entrypoint: "actions.mjs",
    tasks: base.tasks.map((task) => ({ ...task, files: ["actions.mjs", "ui/index.html", "checks/page.mjs"] })),
    cases: base.cases.map((item) => ({ ...item, kind: "node-check", entrypoint: "checks/page.mjs" })),
    application: { protocolVersion: 2, runtime: "node-action", entrypoint: "actions.mjs",
      page: { entrypoint: "ui/index.html", resources: [{ path: "ui/index.html", sha256: "" }] },
      actions: [], stateVersion: 1, evidenceIds: [] } };
}

test("page-only plans keep empty public actions and require independent Node checks for every acceptance", () => {
  const value = pagePlan();
  assert.deepEqual(check(value), value);
  for (const mutate of [
    (next: { application: { page: null; }; }) => { next.application.page = null; },
    (next: { cases: void[]; }) => { next.cases.pop(); },
    (next: { cases: { entrypoint: unknown; }[]; entrypoint: unknown; }) => { next.cases[0]!.entrypoint = next.entrypoint; },
    (next: { cases: { entrypoint: string; }[]; }) => { next.cases![0]!.entrypoint = "ui/index.html"; },
    (next: { cases: { entrypoint: string; }[]; }) => { next.cases![0]!.entrypoint = "checks/missing.mjs"; },
    (next: { cases: { actionId: string; }[]; }) => { next.cases![0]!.actionId = "fake"; },
    (next: { cases: { mocks: never[]; }[]; }) => { next.cases![0]!.mocks = []; },
    (next: { cases: { kind: unknown; }[]; }) => { Reflect.deleteProperty(next.cases[0]!, "kind"); },
    (next: { application: { page: { resources: { path: string; sha256: string; }[]; }; }; }) => { next.application.page.resources.push({ path: "checks/page.mjs", sha256: "" }); },
  ] as const) { const next = structuredClone(value); callFixture(mutate, undefined, [next]); assert.throws(() => check(next), InputError); }
});

test("Node checks cannot replace action verification and their kind and entrypoint are frozen", () => {
  const value = pagePlan();
  const schema: ValueSchema = { type: "object", properties: {}, required: [], additionalProperties: false };
  value.application.actions.push({ id: "extract", title: "提取", inputSchema: schema, outputSchema: schema, connectionIds: [] });
  assert.throws(() => check(value), /每个动作必须有实际验收/);
  const previousPlan = pagePlan();
  const changed = structuredClone(previousPlan);
  changed.tasks![0]!.files.push("checks/replacement.mjs"); changed.cases![0]!.entrypoint = "checks/replacement.mjs";
  assert.throws(() => check(changed, { previousPlan }), /不能删除或替换/);
  const action = { id: "extract", title: "提取", inputSchema: schema, outputSchema: schema, connectionIds: [] };
  const switched = structuredClone(previousPlan); switched.application.actions.push(action);
  switched.cases[0] = { ...switched.cases[0]!, kind: "action", actionId: "extract", mocks: [], input: "{}" };
  Reflect.deleteProperty(switched.cases![0]!, "entrypoint");
  assert.throws(() => check(switched, { previousPlan }), /不能删除或替换/);
});

test("structured submit schemas disallow extra properties and require all fields", () => {
  for (const schema of [PLAN_SCHEMA, REVIEW_SCHEMA, WORK_SCHEMA]) {
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, Object.keys(schema.properties));
  }
  const original = plan(), checked = check(original);
  assert.equal(checked.cases![1]!.input, "");
  assert.equal(checked.cases![1]!.assertions[0]!.path, "");
  checked.tasks![0]!.title = "changed";
  assert.equal(original.tasks![0]!.title, "提取");
});

test("new plan tools declare complete application fields while retaining arbitrary valid action schemas", () => {
  const application = PLAN_V3_SCHEMA.properties.application;
  assert.deepEqual(application.required, ["protocolVersion", "runtime", "entrypoint", "page", "actions", "stateVersion", "evidenceIds"]);
  assert.equal(application.additionalProperties, false);
  assert.equal(application.properties.service.additionalProperties, true, "共享服务清单仍由正式服务契约校验");
  const current = pagePlan(); current.schemaVersion = 3;
  const approved = architecture(); approved.design = { ...approved.design, schemaVersion: 3,
    execution: { language: "javascript", hosting: "builtin" }, interaction: { page: true } };
  assert.deepEqual(validatePlan(current, { architecture: approved }), current);
  approved.design.execution!.language = "none";
  assert.throws(() => validatePlan(current, { architecture: approved }), /无需代码研发/);
});

test("单个研发任务能完整关联230条源需求和24条验证要求，公开结构与执行校验一致", () => {
  const current = pagePlan(); current.schemaVersion = 3;
  const approved = architecture(), ids = [...Array.from({ length: 230 }, (_, index) => `source_${index}`),
    ...Array.from({ length: 24 }, (_, index) => `verification_${index}`)];
  approved.requirements = ids.map(id => ({ id, text: `已确认要求 ${id}` }));
  approved.design = { ...approved.design, schemaVersion: 3, execution: { language: "javascript", hosting: "builtin" },
    interaction: { page: true }, acceptance: approved.design.acceptance.map((item, index) => ({ ...item,
      requirementIds: index ? [ids[0]!] : ids })) };
  current.tasks![0]!.requirementIds = ids;
  current.tasks![1]!.requirementIds = [ids[0]!];
  const schema = new Ajv({ strict: false, allErrors: true, coerceTypes: false }).compile(PLAN_V3_SCHEMA);
  assert.equal(current.tasks![0]!.requirementIds.length, 254);
  assert.equal(schema(current), true, JSON.stringify(schema.errors));
  assert.deepEqual(validatePlan(current, { architecture: approved }), current);
  const oversized = structuredClone(current); oversized.tasks![0]!.requirementIds.push("extra_requirement");
  assert.equal(schema(oversized), false);
  assert.throws(() => validatePlan(oversized, { architecture: approved }), InputError);
});

test("研发计划、开发交接和独立评审的非BMP文本在公开字符边界通过，多一个字符拒绝", () => {
  const ajv = new Ajv({ strict: false, allErrors: true, coerceTypes: false }), current = plan();
  current.summary = "😀".repeat(4000); current.tasks![0]!.title = "𠀀".repeat(200);
  current.cases![0]!.input = "😀".repeat(12_000);
  current.cases![0]!.assertions[0]!.expectedJson = JSON.stringify("𠀀".repeat(59_998));
  const work = { summary: "😀".repeat(4000), changedFiles: ["main.mjs"], knownIssues: ["𠀀".repeat(4000)],
    nextAction: "😀".repeat(4000), continue: true };
  const subjectHash = hashValue(current), review = { subjectHash, verdict: "revise", summary: "😀".repeat(4000),
    issues: [{ id: "followup", blocking: true, kind: "code", description: "𠀀".repeat(4000), remedy: "😀".repeat(4000) }] };
  for (const [value, schema, validate, fields] of [
    [current, PLAN_SCHEMA, check, [(value: { summary: string; }) => { value.summary += "字"; }, (value: { tasks: { title: string; }[]; }) => { value.tasks[0]!.title += "字"; },
(      value: { cases: { input: string; }[]; }) => { value.cases[0]!.input += "字"; }, (value: { cases: { assertions: { expectedJson: string; }[]; }[]; }) => { value.cases[0]!.assertions[0]!.expectedJson = JSON.stringify("𠀀".repeat(59_999)); }]],
    [work, WORK_SCHEMA, validateWork, [(value: { summary: string; }) => { value.summary += "字"; }, (value: { knownIssues: string[]; }) => { value.knownIssues[0] += "字"; },
(      value: { nextAction: string; }) => { value.nextAction += "字"; }]],
    [review, REVIEW_SCHEMA, (value: unknown) => validateReview(value, { subjectHash }), [(value: { summary: string; }) => { value.summary += "字"; },
(      value: { issues: { description: string; }[]; }) => { value.issues[0]!.description += "字"; }, (value: { issues: { remedy: string; }[]; }) => { value.issues[0]!.remedy += "字"; }]],
  ] as const) {
    const published = ajv.compile(schema);
    assert.equal(published(value), true, JSON.stringify(published.errors));
    assert.deepEqual(validate!(value), value);
    for (const mutate of fields!) {
      const oversized = structuredClone(value); callFixture(mutate, undefined, [oversized]);
      assert.equal(published(oversized), false); assert.throws(() => validate!(oversized), InputError);
    }
  }
});

test("submission diagnostics keep schema paths and fixed remedies without submitted values or dynamic keys", () => {
  const invalid = plan(); invalid.summary = "PRIVATE_RAW_VALUE".repeat(400); Reflect.set(invalid, "PRIVATE_DYNAMIC_KEY", "PRIVATE_SECRET");
  const issues = submissionIssues(invalid, PLAN_SCHEMA, { root: "plan", sdk: true });
  assert.ok(issues.some((item) => item.path === "plan.summary" && item.reason === "maxLength"));
  assert.ok(issues.some((item) => item.path === "plan" && item.reason === "additionalProperties"));
  assert.doesNotMatch(JSON.stringify(issues), /PRIVATE_/);
  const record = {};
  for (let index = 0; index < 30; index++) recordSubmission(record, { role: "planner", phase: "planning", turn: index,
    stage: "sdk", status: "rejected", issues });
  assert.equal(objectFields(objectFields(record).submissionAttempts).length, 24);
  assert.deepEqual(objectFields(objectFields(record).submissionCounts).planner, { attempts: 30, accepted: 0, rejected: 30 });
  assert.equal(recordArray(objectFields(record).submissionAttempts).at(-1)!.sequence, 30);
});

test("plan rejects unsupported fields, runtime, missing data and duplicate references", () => {
  const changes = [
    (value: { skipValidation: boolean; }) => { value.skipValidation = true; },
    (value: { runtime: string; }) => { value.runtime = "python"; },
    (value: { summary: unknown; }) => { Reflect.deleteProperty(value, "summary"); },
    (value: { tasks: { requirementIds: string[]; }[]; }) => { value.tasks![0]!.requirementIds.push("goal"); },
    (value: { tasks: { id: unknown; }[]; }) => { value.tasks[1]!.id = value.tasks[0]!.id; },
    (value: { cases: { id: unknown; }[]; }) => { value.cases[1]!.id = value.cases[0]!.id; },
    (value: { tasks: never[]; }) => { value.tasks = []; },
    (value: { cases: { assertions: never[]; }[]; }) => { value.cases![0]!.assertions = []; },
    (value: { cases: { input: string; }[]; }) => { value.cases![0]!.input = "x".repeat(12_001); },
  ];
  for (const change of changes) { const value = plan(); callFixture(change, undefined, [value]); assert.throws(() => check(value), InputError); }
});

test("approved v2 architecture requires node-action and cannot bypass the application contract with a legacy plan", () => {
  const approved = architecture();
  approved.design.schemaVersion = 2;
  approved.design.interaction = { page: true };
  const legacy = plan();
  assert.deepEqual(check(legacy), legacy);
  assert.throws(() => validatePlan(legacy, { architecture: approved }), /v2 架构必须使用/);
  const inputSchema = { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false };
  const outputSchema = { type: "object", properties: { items: { type: "array", items: { type: "string" } }, error: { type: "string" } }, required: [], additionalProperties: false };
  const current = { ...legacy, schemaVersion: 2, runtime: "node-action",
    tasks: legacy.tasks.map((task) => ({ ...task, files: [...task.files, "ui/index.html"] })),
    cases: legacy.cases.map((item) => ({ ...item, actionId: "extract", input: JSON.stringify({ text: item.input }), mocks: [] })),
    application: { protocolVersion: 2, runtime: "node-action", entrypoint: legacy.entrypoint,
      page: { entrypoint: "ui/index.html", resources: [{ path: "ui/index.html", sha256: "" }] },
      actions: [{ id: "extract", title: "提取", inputSchema, outputSchema, connectionIds: [] }],
      stateVersion: 1, evidenceIds: [] } };
  assert.deepEqual(validatePlan(current, { architecture: approved }), current);
  assert.throws(() => validatePlan({ ...current, runtime: "node-json" }, { architecture: approved }), /v2 架构必须使用/);
  assert.throws(() => validatePlan({ ...current, application: { ...current.application, page: null } }, { architecture: approved }), /页面交付必须匹配/);
});

test("every requirement and acceptance is assigned and has real test cases", () => {
  for (const change of [
    (value: { tasks: { requirementIds: string[]; }[]; }) => { value.tasks![1]!.requirementIds = ["goal"]; },
    (value: { tasks: { acceptanceIds: string[]; }[]; }) => { value.tasks![1]!.acceptanceIds = ["success"]; },
    (value: { cases: void[]; }) => { value.cases.pop(); },
    (value: { cases: { acceptanceId: string; }[]; }) => { value.cases![0]!.acceptanceId = "unknown"; },
    (value: { tasks: { requirementIds: string[]; }[]; }) => { value.tasks![0]!.requirementIds = ["unknown"]; },
    (value: { cases: { taskId: string; }[]; }) => { value.cases![0]!.taskId = "unknown"; },
    (value: { cases: { taskId: string; }[]; }) => { value.cases![0]!.taskId = "guard"; },
    (value: { tasks: { acceptanceIds: string[]; }[]; }) => { value.tasks![0]!.acceptanceIds.push("empty"); },
  ] as const) { const value = plan(); callFixture(change, undefined, [value]); assert.throws(() => check(value), InputError); }
  for (const value of [undefined, {}, { requirements: [] }, { requirements: [null], design: { acceptance: [{}] } }]) {
    assert.throws(() => check(plan(), { architecture: value }), InputError);
  }
});

test("task dependencies must exist and form an acyclic graph", () => {
  for (const deps of [["unknown"], ["extract"], ["guard"]]) {
    const value = plan(); value.tasks![0]!.dependsOn = deps;
    assert.throws(() => check(value), InputError);
  }
});

test("entrypoint must be a supported source file declared by a task", () => {
  for (const entrypoint of ["main.py", "other.mjs", "/tmp/main.mjs", "../main.mjs", ".hidden/main.mjs"]) {
    const value = plan(); value.entrypoint = entrypoint;
    assert.throws(() => check(value), InputError);
  }
  const value = plan(); value.entrypoint = "main.py"; value.tasks![0]!.files.push("main.py");
  assert.throws(() => check(value), InputError);
});

test("files are safe relative paths in both plans and work submissions", () => {
  for (const path of ["../outside.mjs", "/tmp/outside.mjs", "a/../main.mjs", "a//main.mjs", "a/./main.mjs", "src/", "C:/file.mjs", "a\\file.mjs", ".env", ".git/config", "node_modules/a.mjs", "config/credentials.json", "api-key.txt", "access-key.json", "private_key.txt", "token.json", "id_rsa", "private.pem", "a\0.txt", "a\n.txt"]) {
    assert.throws(() => safeRelativePath(path), InputError, path);
    const value = plan(); value.tasks![0]!.files.push(path);
    assert.throws(() => check(value), InputError, path);
    assert.throws(() => validateWork({ summary: "编写完成", changedFiles: [path], knownIssues: [], nextAction: "等待验收", continue: false }), InputError, path);
  }
  for (const path of ["main.mjs", "src/records.js", "package.json", "文档/说明.md"]) assert.equal(safeRelativePath(path), path);
});

test("test assertions validate JSON values and reject prototype access and duplicate paths", () => {
  for (const path of ["constructor.name", "items.__proto__", "prototype", "items[0]", "a..b", ".a", "a.", "a.01"]) {
    const value = plan(); value.cases![0]!.assertions[0]!.path = path;
    assert.throws(() => check(value), InputError, path);
  }
  for (const expectedJson of ["undefined", "NaN", "{bad}", "", "1 trailing"]) {
    const value = plan(); value.cases![0]!.assertions[0]!.expectedJson = expectedJson;
    assert.throws(() => check(value), InputError);
  }
  const value = plan(); value.cases![0]!.assertions.push({ ...value.cases![0]!.assertions[0]! });
  assert.throws(() => check(value), InputError);
});

test("plan revisions preserve confirmed inputs, references and assertion values", () => {
  const previousPlan = plan();
  for (const change of [
    (value: { cases: { id: string; }[]; }) => { value.cases![0]!.id = "renamed"; },
    (value: { cases: { input: string; }[]; }) => { value.cases![0]!.input = "easier input"; },
    (value: { cases: { assertions: { path: string; expectedJson: string; }[]; }[]; }) => { value.cases![0]!.assertions = [{ path: "items", expectedJson: "[]" }]; },
    (value: { cases: { assertions: { expectedJson: string; }[]; }[]; }) => { value.cases![0]!.assertions[0]!.expectedJson = '"easier output"'; },
  ] as const) { const value = plan(); callFixture(change, undefined, [value]); assert.throws(() => check(value, { previousPlan }), InputError); }
  const extended = plan(); extended.tasks![1]!.description = "更准确的实现方法";
  extended.cases![0]!.assertions.push({ path: "count", expectedJson: "1" });
  extended.cases![1]!.assertions[0]!.expectedJson = '{ "error": "missing_input" }';
  extended.cases.push({ ...structuredClone(extended.cases[0])!, id: "extract_extra" });
  assert.deepEqual(check(extended, { previousPlan }), extended);
});

test("review binds the exact subject and cannot pass with blockers", () => {
  const subjectHash = hashValue(plan());
  const valid = { subjectHash, verdict: "pass", summary: "满足要求", issues: [] };
  assert.deepEqual(validateReview(valid, { subjectHash }), valid);
  assert.throws(() => validateReview(valid, { subjectHash: "0".repeat(64) }), InputError);
  const issue = { id: "missing", blocking: true, kind: "code", description: "缺少处理", remedy: "补齐实现" };
  assert.throws(() => validateReview({ ...valid, issues: [issue] }, { subjectHash }), InputError);
  assert.throws(() => validateReview({ ...valid, verdict: "revise" }, { subjectHash }), InputError);
  assert.equal(validateReview({ ...valid, verdict: "blocked", issues: [issue] }, { subjectHash }).verdict, "blocked");
  assert.throws(() => validateReview({ ...valid, verdict: "revise", issues: [issue, issue] }, { subjectHash }), InputError);
});

test("work handoffs are cloned and continuing requires an explicit next action", () => {
  const value = { summary: "已实现提取", changedFiles: ["main.mjs"], knownIssues: ["缺少输入检查"], nextAction: "继续输入检查", continue: true };
  const checked = validateWork(value); checked.knownIssues.push("changed");
  assert.equal(value.knownIssues.length, 1);
  assert.throws(() => validateWork({ ...value, nextAction: "" }), InputError);
  assert.throws(() => validateWork({ ...value, passed: true }), InputError);
  assert.equal(validateWork({ ...value, continue: false, nextAction: "" }).continue, false);
});

test("hashes are stable for object order and reject non-JSON or circular values", () => {
  assert.equal(hashValue({ b: 2, a: [{ z: true, y: null }] }), hashValue({ a: [{ y: null, z: true }], b: 2 }));
  assert.notEqual(hashValue([1, 2]), hashValue([2, 1]));
  const circular = {}; objectFields(circular).self = circular;
  for (const value of [undefined, NaN, Infinity, 1n, new Date(), new Map(), { a: undefined }, new Array(2), circular]) {
    assert.throws(() => hashValue(value), InputError);
  }
  const shared = { a: 1 };
  assert.equal(hashValue([shared, shared]), hashValue([{ a: 1 }, { a: 1 }]));
});
