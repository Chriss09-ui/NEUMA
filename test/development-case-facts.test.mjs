import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { InputError } from "../src/requirements/core.mjs";
import { CASE_FACT_LIMITS, developmentCaseFacts } from "../src/development/development-case-facts.mjs";
import { resolveCaseInput, inputContractMeasurement } from "../src/development/development-fixtures.mjs";
import { hashValue } from "../src/development/development-contract.mjs";
import { DevelopmentController } from "../src/development/development.mjs";
import { planReviewSubject } from "../src/verification/plan-review-subject.mjs";
import { developmentArchitecture, developmentPlan, developmentReview } from "./helpers/development.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const value = (item) => ({ op: "value", value: item });
const makeCase = (overrides = {}) => Object.fromEntries(Object.entries({ id: "sample", taskId: "main", acceptanceId: "input", kind: "action", actionId: "run",
  input: "{}", mocks: [], assertions: [{ path: "", expectedJson: "true" }], ...overrides }).filter(([, item]) => item !== undefined));
const makePlan = (cases = [makeCase()], overrides = {}) => ({ schemaVersion: 2, runtime: "node-action", cases, ...overrides });

test("计划输入事实展开原夹具，绑定计划及用例，不按名称猜测规模", () => {
  const item = makeCase({ id: "named_999", input: { fixture: { op: "object", fields: {
    items: { op: "repeat", count: 200, value: { op: "object", fields: { key: { op: "index", start: 1, step: 1, prefix: "item" } } } },
    events: { op: "array", items: [value("中文😀")] },
  } } } });
  const plan = makePlan([item]), before = structuredClone(plan), report = developmentCaseFacts(plan, { planHash: hashValue(plan) });
  const original = resolveCaseInput(item).value, input = report.cases[0].input;
  assert.equal(report.schemaVersion, 1); assert.equal(report.planSchemaVersion, 2); assert.equal(report.planHash, hashValue(plan));
  assert.equal(report.totalCases, 1); assert.equal(report.measuredInputs, 1); assert.equal(report.unmeasuredInputs, 0);
  assert.equal(report.generatedCodeExecuted, false); assert.equal(report.hostCallsExecuted, false);
  assert.equal(report.cases[0].caseId, "named_999"); assert.equal(report.cases[0].caseHash, hashValue(item));
  assert.equal(report.cases[0].actionId, "run"); assert.equal(report.cases[0].acceptanceId, "input");
  assert.equal(input.encoding, "json-value"); assert.equal(input.utf8Bytes, Buffer.byteLength(JSON.stringify(original)));
  assert.equal(input.sha256, hash(JSON.stringify(original)));
  assert.deepEqual(input.arrayLengths.entries, [{ pointer: "/items", length: 200 }, { pointer: "/events", length: 1 }]);
  assert.doesNotMatch(JSON.stringify(report), /item200|中文😀/u);
  assert.deepEqual(plan, before);
  input.arrayLengths.entries[0].length = 0;
  assert.deepEqual(plan, before);
});

test("JSON文本测实际解析值，顶层数组和专用激活用例保持来源", () => {
  const plan = makePlan([makeCase({ input: ' \n {"a/b~c":[1,2]} \n' })], { schemaVersion: 3,
    activationCases: [makeCase({ id: "activation", kind: "input-rejection", inputTarget: "task-envelope", input: "[1,2,3]" })] });
  const report = developmentCaseFacts(plan);
  assert.equal(report.cases[0].input.utf8Bytes, Buffer.byteLength('{"a/b~c":[1,2]}'));
  assert.deepEqual(report.cases[0].input.arrayLengths.entries, [{ pointer: "/a~1b~0c", length: 2 }]);
  assert.equal(report.cases[1].source, "activationCases"); assert.equal(report.cases[1].caseIndex, 0);
  assert.equal(report.cases[1].kind, "input-rejection"); assert.equal(report.cases[1].inputTarget, "task-envelope");
  assert.deepEqual(report.cases[1].input.arrayLengths.entries, [{ pointer: "", length: 3 }]);
  assert.equal(report.cases[1].input.utf8Bytes, 7, "实际动作值不冒充完整任务信封的字节测量");
});

test("原JSON文本、规范JSON、内嵌文本和明确验证信封各有独立测量范围", () => {
  const embedded = ' [ {"text":"中😀"} ] ', raw = ' \n{"recordsJson":' + JSON.stringify(embedded) + '} \n';
  const item = makeCase({ input: raw }), plan = makePlan([item]), facts = developmentCaseFacts(plan).cases[0].input;
  assert.equal(facts.sourceText.encoding, "json-source-text"); assert.equal(facts.sourceText.utf8Bytes, Buffer.byteLength(raw));
  assert.equal(facts.sourceText.sha256, hash(raw));
  const canonical = JSON.stringify(JSON.parse(raw));
  assert.equal(facts.canonicalJson.utf8Bytes, Buffer.byteLength(canonical)); assert.equal(facts.utf8Bytes, facts.canonicalJson.utf8Bytes);
  assert.notEqual(facts.sourceText.utf8Bytes, facts.canonicalJson.utf8Bytes);
  const inner = facts.embeddedTexts.entries[0]; assert.equal(inner.pointer, "/recordsJson");
  assert.equal(inner.rawText.utf8Bytes, Buffer.byteLength(embedded)); assert.equal(inner.rawText.sha256, hash(embedded));
  assert.equal(inner.parsedJson.utf8Bytes, Buffer.byteLength(JSON.stringify(JSON.parse(embedded))));
  assert.equal(inner.parsedJson.arrayLengths.entries[0].length, 1);
  assert.equal(facts.taskEnvelope.status, "not_measured"); assert.doesNotMatch(JSON.stringify(facts), /中😀/);
  const action = { id: "run" }, rejected = makeCase({ kind: "input-rejection", inputTarget: "task-envelope", input: raw });
  const measured = developmentCaseFacts(makePlan([rejected], { application: { actions: [action] } })).cases[0].input;
  assert.deepEqual(measured.taskEnvelope, { status: "measured", source: "input-contract-verification-envelope",
    ...inputContractMeasurement(action, JSON.parse(raw), { target: "task-envelope" }), actionExecuted: false });
  assert.ok(measured.taskEnvelope.bytes > measured.canonicalJson.utf8Bytes);
});

test("写文件替身只测参数原文，不把返回值当作真实文件证据或展开占位符", () => {
  const content = '中文😀,引号"\n', placeholder = "<computed-result-json>";
  const item = makeCase({ mocks: [
    { capability: "files.write", argsJson: { fixture: { op: "object", fields: { file: value("output.txt"), content: value(content) } } }, resultJson: "PRIVATE_INVALID_RECEIPT" },
    { capability: "files.write", argsJson: JSON.stringify({ file: "literal.txt", content: placeholder }), resultJson: "PRIVATE_INVALID_RECEIPT" },
    { capability: "files.read", argsJson: "PRIVATE_INVALID_ARGUMENTS", resultJson: "PRIVATE_INVALID_RECEIPT" },
  ] });
  const report = developmentCaseFacts(makePlan([item])), writes = report.cases[0].fileWrites;
  assert.equal(writes.source, "mock-arguments"); assert.equal(writes.hostCallExecuted, false); assert.equal(writes.mockReturnsVerified, false);
  assert.equal(writes.total, 2); assert.equal(writes.retained, 2); assert.equal(writes.truncated, false);
  assert.deepEqual(writes.entries[0], { mockIndex: 0, capability: "files.write", file: "output.txt", content: {
    status: "measured", utf8Bytes: Buffer.byteLength(content), utf16Units: content.length, sha256: hash(content),
  } });
  assert.notEqual(writes.entries[0].content.sha256, hash(JSON.stringify(content)), "正文SHA不包含JSON字符串外壳");
  assert.equal(writes.entries[1].content.sha256, hash(placeholder));
  assert.equal(writes.entries[1].content.utf16Units, placeholder.length);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|computed-result-json|中文😀/u);
});

test("旧文本协议与页面检查按原文本测量，坏夹具明确未测量且不泄露正文", () => {
  const legacy = developmentCaseFacts({ runtime: "node-json", cases: [makeCase({ kind: undefined, actionId: undefined, input: "普通文本😀" })] });
  assert.equal(legacy.planSchemaVersion, 1); assert.equal(legacy.cases[0].kind, "node-json");
  assert.equal(legacy.cases[0].input.utf8Bytes, Buffer.byteLength("普通文本😀"));
  assert.equal(legacy.cases[0].input.encoding, "text");
  const report = developmentCaseFacts(makePlan([makeCase({ kind: "node-check", actionId: undefined, input: "原始页面输入" }),
    makeCase({ id: "bad", input: { fixture: { op: "PRIVATE_UNKNOWN_OPERATION" } }, mocks: [
      { capability: "files.write", argsJson: "PRIVATE_INVALID_ARGUMENTS", resultJson: "true" },
    ] })]));
  assert.equal(report.measuredInputs, 1); assert.equal(report.unmeasuredInputs, 1);
  assert.equal(report.cases[0].input.encoding, "text");
  assert.deepEqual(report.cases[1].input, { status: "unmeasured", reason: "fixture_unknown_operation" });
  assert.deepEqual(report.cases[1].fileWrites.entries[0].content, { status: "unmeasured", reason: "fixture_json_required" });
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_/u);
});

test("字段和替身明细显式有界，不把省略的测量当完整证明", () => {
  const input = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`list_${i}`, Array(i).fill(null)]));
  input["x".repeat(CASE_FACT_LIMITS.fieldNameChars + 1)] = [1];
  const mocks = Array.from({ length: CASE_FACT_LIMITS.fileWrites + 2 }, () => ({ capability: "files.write", argsJson: '{"file":"a","content":"b"}', resultJson: "true" }));
  const report = developmentCaseFacts(makePlan([makeCase({ input: JSON.stringify(input), mocks })]));
  const facts = report.cases[0];
  assert.equal(facts.input.arrayLengths.total, 21); assert.equal(facts.input.arrayLengths.retained, CASE_FACT_LIMITS.arrayFields);
  assert.equal(facts.input.arrayLengths.truncated, true);
  assert.equal(facts.fileWrites.total, mocks.length); assert.equal(facts.fileWrites.retained, CASE_FACT_LIMITS.fileWrites);
  assert.equal(facts.fileWrites.truncated, true); assert.match(report.notice, /明细截断/u);
});

test("只读展开总量达到原夹具额度后明确停止测量，不缩小原始配方", () => {
  const mocks = [{ capability: "files.write", argsJson: { fixture: { op: "object", fields: {
    file: value("a"), content: { op: "text", value: "x".repeat(100), count: 10000 },
  } } }, resultJson: "true" }];
  const plan = makePlan(Array.from({ length: 18 }, (_, i) => makeCase({ id: `sample_${i}`, mocks })));
  const report = developmentCaseFacts(plan);
  assert.equal(report.measurementBudgetExhausted, true);
  assert.ok(report.measuredValueBytes <= CASE_FACT_LIMITS.measuredValueBytes);
  assert.equal(report.cases.at(-1).input.status, "unmeasured");
  assert.equal(report.cases.at(-1).input.reason, "measurement_budget_exhausted");
  assert.equal(plan.cases[0].mocks[0].argsJson.fixture.fields.content.count, 10000);
});

test("拒绝摘要错配、无界分组和非法身份，取消不继续解析", () => {
  const plan = makePlan();
  assert.throws(() => developmentCaseFacts(plan, { planHash: "0".repeat(64) }), /摘要/u);
  assert.throws(() => developmentCaseFacts(makePlan(Array.from({ length: 201 }, (_, i) => makeCase({ id: `sample_${i}` })))), /200/u);
  assert.throws(() => developmentCaseFacts(makePlan([makeCase({ id: "x".repeat(81) })])), InputError);
  assert.throws(() => developmentCaseFacts(makePlan([], { runtime: "PRIVATE_RUNTIME" })), InputError);
  const controller = new AbortController(); controller.abort();
  assert.throws(() => developmentCaseFacts(plan, { signal: controller.signal }), { name: "AbortError" });
});

test("跨用例输入及替身参数共用原生文本工作额度，小摘要不能重置大原文计算额度", () => {
  const digest = { op: "measure", kind: "sha256", value: { op: "text", value: "x".repeat(100), count: 10000 } };
  const plan = makePlan(Array.from({ length: 9 }, (_, index) => makeCase({ id: `sample_${index}`, input: { fixture: digest }, mocks: [
    { capability: "files.write", argsJson: { fixture: { op: "object", fields: { file: value("a"), content: digest } } }, resultJson: "true" },
  ] })), { runtime: "managed-service" });
  const report = developmentCaseFacts(plan);
  assert.equal(report.measuredInputs, 8); assert.equal(report.unmeasuredInputs, 1);
  assert.equal(report.cases.at(-1).input.reason, "fixture_text_work_limit");
  assert.equal(report.cases.at(-1).fileWrites.entries[0].content.reason, "fixture_text_work_limit");
  assert.equal(report.measurementBudgetExhausted, true); assert.equal(report.measuredTextWorkBytes, 16_000_000);
  assert.ok(report.measuredValueBytes < 10000, "输入与替身的返回摘要很小，仍需累计其实际文本计算工作量");
});

test("正式计划评审附加实测事实，不改变已有v2评审对象摘要", async () => {
  const plan = makePlan(), architectureRef = { version: 7, candidateHash: "a".repeat(64) }, planHash = hashValue(plan);
  const ctx = { signal: new AbortController().signal, record: { architectureRef, reviews: [] } }, handle = { reference: {} };
  let delivered;
  const controller = { limits: { reviewerTurns: 12 }, save: async () => {}, role: async () => handle, base: () => ({ architectureRef }),
    ask: async (_ctx, _handle, payload) => { delivered = payload; return developmentReview(payload.subjectHash); }, dispose() {} };
  const review = await DevelopmentController.prototype.review.call(controller, ctx, "plan", { plan, planHash });
  assert.equal(review.subjectHash, hashValue(planReviewSubject(architectureRef, plan, planHash, 2)));
  assert.equal(review.subjectVersion, 2);
  assert.equal(delivered.caseFacts.planHash, planHash); assert.equal(delivered.caseFacts.planSource, "plan");
  assert.equal(delivered.caseFacts.cases[0].input.utf8Bytes, 2);
  assert.equal(ctx.record.reviews[0].subjectHash, review.subjectHash);
});

async function planningInput({ rejectedPlan, developmentRevision } = {}) {
  const architecture = developmentArchitecture(), plan = developmentPlan(architecture);
  if (developmentRevision) architecture.developmentRevision = developmentRevision;
  const record = { id: "dev_fixture", agentId: architecture.agentId, architecture, architectureRef: { version: architecture.version, candidateHash: architecture.candidateHash },
    plan: null, planHash: null, planning: { turns: 0 }, tasks: [], planAttempts: [], reviews: [], handoffs: [], budgets: {},
    feedback: rejectedPlan ? { rejectedPlan } : null };
  const ctx = { record, signal: new AbortController().signal }, handle = { reference: {} };
  let delivered;
  const controller = { workspace: { snapshot: async () => ({ hash: "a".repeat(64), files: [] }), tools: async () => [] },
    limits: { reviewerTurns: 12 }, phase: async () => {}, guard() {}, save: async () => {}, role: async () => handle,
    ask: async (_ctx, _handle, payload) => { delivered = payload; return plan; }, review: async () => ({ verdict: "pass" }), dispose() {},
    base: DevelopmentController.prototype.base };
  await DevelopmentController.prototype.plan.call(controller, ctx);
  return { delivered, record, plan };
}

test("规划修订实测当前被拒计划，历史参考不成为冻结基准或替代当前输入", async () => {
  const rejectedPlan = developmentPlan(); rejectedPlan.summary = "当前实际被拒计划";
  const historicalPlan = developmentPlan(); historicalPlan.summary = "旧批次参考";
  const revision = { schemaVersion: 1, status: "available", trust: "untrusted-reference", source: { agentId: "weekly", runId: "old" },
    planHash: hashValue(historicalPlan), plan: historicalPlan, caseFacts: developmentCaseFacts(historicalPlan) };
  const { delivered, record, plan } = await planningInput({ rejectedPlan, developmentRevision: revision });
  assert.equal(delivered.caseFacts.planHash, hashValue(rejectedPlan));
  assert.equal(delivered.caseFacts.planSource, "feedback.rejectedPlan");
  assert.equal(delivered.previousPlan, null);
  assert.deepEqual(delivered.developmentRevision, revision); assert.notEqual(delivered.developmentRevision, revision);
  assert.deepEqual(record.plan, plan); assert.notDeepEqual(record.plan, historicalPlan);
});

test("仅有受控历史参考时测其完整计划，未提供参考的旧路径保持兼容", async () => {
  const historicalPlan = developmentPlan(); historicalPlan.summary = "只能参考，不能自动接受";
  const revision = { schemaVersion: 1, status: "available", trust: "untrusted-reference", source: { agentId: "weekly", runId: "old" },
    planHash: hashValue(historicalPlan), plan: historicalPlan, caseFacts: developmentCaseFacts(historicalPlan) };
  const original = structuredClone(revision);
  const { delivered, record, plan } = await planningInput({ developmentRevision: revision });
  assert.equal(delivered.caseFacts.planHash, revision.planHash); assert.equal(delivered.caseFacts.trust, "untrusted-reference");
  assert.equal(delivered.caseFacts.planSource, "developmentRevision.plan"); assert.equal(delivered.previousPlan, null);
  assert.equal(delivered.developmentRevision.caseFacts, undefined);
  assert.deepEqual(delivered.developmentRevision.caseFactsReference, { section: "caseFacts", planHash: revision.planHash, trust: "untrusted-reference" });
  assert.deepEqual(revision, original, "仅去除投递视图中的重复表，不改持久架构与历史原文");
  assert.deepEqual(record.plan, plan); assert.notDeepEqual(record.plan, historicalPlan);
  assert.equal((await planningInput()).delivered.caseFacts, undefined);
  assert.equal((await planningInput({ developmentRevision: { ...revision, status: "unavailable", plan: undefined } })).delivered.caseFacts, undefined);
  await assert.rejects(planningInput({ developmentRevision: { ...revision, planHash: "0".repeat(64) } }), /摘要/u);
});
