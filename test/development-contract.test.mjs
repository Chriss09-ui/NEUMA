import assert from "node:assert/strict";
import test from "node:test";
import { InputError } from "../core.mjs";
import { PLAN_SCHEMA, REVIEW_SCHEMA, WORK_SCHEMA, hashValue, safeRelativePath,
  validatePlan, validateReview, validateWork } from "../development-contract.mjs";

function architecture() {
  return { requirements: [{ id: "goal", text: "提取记录" }, { id: "input", text: "处理空输入" }],
    design: { acceptance: [{ id: "success", requirementIds: ["goal"] }, { id: "empty", requirementIds: ["input"] }] } };
}

function plan() {
  return { summary: "先提取记录，再处理缺少输入", runtime: "node-json", entrypoint: "src/main.mjs",
    tasks: [
      { id: "extract", title: "提取", description: "提取文字", requirementIds: ["goal"], acceptanceIds: ["success"], dependsOn: [], files: ["src/main.mjs"] },
      { id: "guard", title: "输入检查", description: "缺少输入时返回错误码", requirementIds: ["input"], acceptanceIds: ["empty"], dependsOn: ["extract"], files: ["src/main.mjs"] },
    ], cases: [
      { id: "extract_one", taskId: "extract", acceptanceId: "success", input: "本周完成原型", assertions: [{ path: "items.0", expectedJson: '"本周完成原型"' }] },
      { id: "guard_empty", taskId: "guard", acceptanceId: "empty", input: "", assertions: [{ path: "", expectedJson: '{"error":"missing_input"}' }] },
    ] };
}

const check = (value, options = {}) => validatePlan(value, { architecture: architecture(), ...options });

test("structured submit schemas disallow extra properties and require all fields", () => {
  for (const schema of [PLAN_SCHEMA, REVIEW_SCHEMA, WORK_SCHEMA]) {
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, Object.keys(schema.properties));
  }
  const original = plan(), checked = check(original);
  assert.equal(checked.cases[1].input, "");
  assert.equal(checked.cases[1].assertions[0].path, "");
  checked.tasks[0].title = "changed";
  assert.equal(original.tasks[0].title, "提取");
});

test("plan rejects unsupported fields, runtime, missing data and duplicate references", () => {
  const changes = [
    (value) => { value.skipValidation = true; },
    (value) => { value.runtime = "python"; },
    (value) => { delete value.summary; },
    (value) => { value.tasks[0].requirementIds.push("goal"); },
    (value) => { value.tasks[1].id = value.tasks[0].id; },
    (value) => { value.cases[1].id = value.cases[0].id; },
    (value) => { value.tasks = []; },
    (value) => { value.cases[0].assertions = []; },
    (value) => { value.cases[0].input = "x".repeat(12_001); },
  ];
  for (const change of changes) { const value = plan(); change(value); assert.throws(() => check(value), InputError); }
});

test("every requirement and acceptance is assigned and has real test cases", () => {
  for (const change of [
    (value) => { value.tasks[1].requirementIds = ["goal"]; },
    (value) => { value.tasks[1].acceptanceIds = ["success"]; },
    (value) => { value.cases.pop(); },
    (value) => { value.cases[0].acceptanceId = "unknown"; },
    (value) => { value.tasks[0].requirementIds = ["unknown"]; },
    (value) => { value.cases[0].taskId = "unknown"; },
    (value) => { value.cases[0].taskId = "guard"; },
    (value) => { value.tasks[0].acceptanceIds.push("empty"); },
  ]) { const value = plan(); change(value); assert.throws(() => check(value), InputError); }
  for (const value of [undefined, {}, { requirements: [] }, { requirements: [null], design: { acceptance: [{}] } }]) {
    assert.throws(() => check(plan(), { architecture: value }), InputError);
  }
});

test("task dependencies must exist and form an acyclic graph", () => {
  for (const deps of [["unknown"], ["extract"], ["guard"]]) {
    const value = plan(); value.tasks[0].dependsOn = deps;
    assert.throws(() => check(value), InputError);
  }
});

test("entrypoint must be a supported source file declared by a task", () => {
  for (const entrypoint of ["main.py", "other.mjs", "/tmp/main.mjs", "../main.mjs", ".hidden/main.mjs"]) {
    const value = plan(); value.entrypoint = entrypoint;
    assert.throws(() => check(value), InputError);
  }
  const value = plan(); value.entrypoint = "main.py"; value.tasks[0].files.push("main.py");
  assert.throws(() => check(value), InputError);
});

test("files are safe relative paths in both plans and work submissions", () => {
  for (const path of ["../outside.mjs", "/tmp/outside.mjs", "a/../main.mjs", "a//main.mjs", "a/./main.mjs", "src/", "C:/file.mjs", "a\\file.mjs", ".env", ".git/config", "node_modules/a.mjs", "config/credentials.json", "api-key.txt", "access-key.json", "private_key.txt", "token.json", "id_rsa", "private.pem", "a\0.txt", "a\n.txt"]) {
    assert.throws(() => safeRelativePath(path), InputError, path);
    const value = plan(); value.tasks[0].files.push(path);
    assert.throws(() => check(value), InputError, path);
    assert.throws(() => validateWork({ summary: "编写完成", changedFiles: [path], knownIssues: [], nextAction: "等待验收", continue: false }), InputError, path);
  }
  for (const path of ["main.mjs", "src/records.js", "package.json", "文档/说明.md"]) assert.equal(safeRelativePath(path), path);
});

test("test assertions validate JSON values and reject prototype access and duplicate paths", () => {
  for (const path of ["constructor.name", "items.__proto__", "prototype", "items[0]", "a..b", ".a", "a.", "a.01"]) {
    const value = plan(); value.cases[0].assertions[0].path = path;
    assert.throws(() => check(value), InputError, path);
  }
  for (const expectedJson of ["undefined", "NaN", "{bad}", "", "1 trailing"]) {
    const value = plan(); value.cases[0].assertions[0].expectedJson = expectedJson;
    assert.throws(() => check(value), InputError);
  }
  const value = plan(); value.cases[0].assertions.push({ ...value.cases[0].assertions[0] });
  assert.throws(() => check(value), InputError);
});

test("plan revisions preserve confirmed inputs, references and assertion values", () => {
  const previousPlan = plan();
  for (const change of [
    (value) => { value.cases[0].id = "renamed"; },
    (value) => { value.cases[0].input = "easier input"; },
    (value) => { value.cases[0].assertions = [{ path: "items", expectedJson: "[]" }]; },
    (value) => { value.cases[0].assertions[0].expectedJson = '"easier output"'; },
  ]) { const value = plan(); change(value); assert.throws(() => check(value, { previousPlan }), InputError); }
  const extended = plan(); extended.tasks[1].description = "更准确的实现方法";
  extended.cases[0].assertions.push({ path: "count", expectedJson: "1" });
  extended.cases[1].assertions[0].expectedJson = '{ "error": "missing_input" }';
  extended.cases.push({ ...structuredClone(extended.cases[0]), id: "extract_extra" });
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
  const circular = {}; circular.self = circular;
  for (const value of [undefined, NaN, Infinity, 1n, new Date(), new Map(), { a: undefined }, new Array(2), circular]) {
    assert.throws(() => hashValue(value), InputError);
  }
  const shared = { a: 1 };
  assert.equal(hashValue([shared, shared]), hashValue([{ a: 1 }, { a: 1 }]));
});
