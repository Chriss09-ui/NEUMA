import { fixtureToolAt, fixtureSchema } from "./helpers/m7-test-boundaries.mjs";
import type { CandidateDraft } from "../src/contracts/architecture-stages.mjs";
import type { ModelConfig } from "../src/contracts/model.mjs";
import { callFixture } from "./helpers/m7-test-boundaries.mjs";
import { recordArray } from "./helpers/m7-test-boundaries.mjs";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import type { PiSessionOptions } from "../src/runtime/pi-port.mjs";
import type { PiSessionPort } from "../src/runtime/pi-port.mjs";
import type { TestFailure } from "./helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { Ajv } from "ajv";
import { normalizeDraft } from "../src/requirements/core.mjs";
import { REQUIREMENT_LIMITS } from "../src/requirements/requirement-limits.mjs";
import { requirementItems, designSubmissionSchema, validateDesign, designHash } from "../src/architecture/architecture-contract.mjs";
import { architectureToolValidation, diagnoseArchitectureReferences } from "../src/architecture/architecture-tool-diagnostics.mjs";
import { diagnoseRequirementFidelitySubmission, verifyRequirementFidelity } from "../src/architecture/requirement-fidelity.mjs";
import { validDraft, validDesign } from "./helpers/architecture.mjs";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { RequirementItem } from "../src/contracts/architecture.mjs";

const ajv = new Ajv({ strict: false, allErrors: true, coerceTypes: false });

function completeDraft() {
  const draft = validDraft();
  draft.routingCondition = { value: "用户明确请求整理", source: "user" };
  draft.constraints = Array.from({ length: 20 }, (_, index) => ({ text: `约束${index}`, source: "user" }));
  draft.capabilityDependencies = Array.from({ length: 20 }, (_, index) => `依赖${index}`);
  draft.connections = Array.from({ length: 40 }, (_, index) => ({ purpose: "business", required: false, description: `连接${index}` }));
  draft.interaction = { defaultEntry: "conversation", page: false, operations: Array.from({ length: 20 }, (_, index) => `操作${index}`),
    inputs: "材料", results: "完整结果", persistentData: "无" };
  draft.taskSpec = { version: 1, items: Array.from({ length: 120 }, (_, index) => ({ id: `task_${index}`, dimension: "processing",
    content: `处理要求${index}`, applicability: "applies", critical: false, source: { kind: "user", evidence: [{ messageId: "m1", quote: "用户要求" }] } })) };
  return normalizeDraft(draft);
}

function currentDesign(requirements: readonly RequirementItem[], schemaVersion: 1 | 2 | 3 = 3) {
  const candidate: CandidateDraft = validDesign(requirements, { ...(schemaVersion > 1 ? { schemaVersion: schemaVersion as 2 | 3,
    interaction: { defaultEntry: "conversation", page: false, operations: true, inputs: "材料", results: "完整结果", persistentData: "无" }, connections: [] } : {}),
  ...(schemaVersion === 3 ? { execution: { language: "javascript", hosting: "managed", reason: "实现已确认操作" },
    selectionBasis: { capacity: "覆盖全部要求", process: "逐项处理", quality: "逐项核对", requirementIds: requirements.map((item) => item.id), assumptions: [] } } : {}) });
  for (const row of candidate.coverage!) row.verification = "核对该条完整要求";
  return candidate;
}

test("230项需求加24项后续验证义务，公开设计结构、正式覆盖及验收引用完整相接", () => {
  const draft = completeDraft(), requirements = requirementItems(draft);
  assert.equal(requirements.length, REQUIREMENT_LIMITS.draftItems);
  assert.equal(requirements.length, 230);
  requirements.push(...Array.from({ length: REQUIREMENT_LIMITS.deferredItems }, (_, index) => ({ id: `verification_${index}`, text: `后续验证义务${index}` })));
  assert.equal(requirements.length, REQUIREMENT_LIMITS.formalItems);
  for (const version of [1, 2, 3] as const) {
    const candidate = currentDesign(requirements, version), schema = designSubmissionSchema(version === 3 ? draft : {}, { requirements });
    assert.equal(ajv.compile(schema)(candidate), true);
    assert.equal(architectureToolValidation(candidate, schema).valid, true);
    assert.doesNotThrow(() => validateDesign(candidate, { requirements, ...(version === 3 ? { draft } : {}) }));
    candidate.coverage!.reverse();
    assert.doesNotThrow(() => validateDesign(candidate, { requirements, ...(version === 3 ? { draft } : {}) }), "完整覆盖不限制顺序");
    candidate.coverage!.pop();
    assert.throws(() => validateDesign(candidate, { requirements, ...(version === 3 ? { draft } : {}) }),
      (error: TestFailure) => error.validationIssue?.reason === "missing_coverage");
  }
});

test("引用诊断检查80项之后的覆盖与验收，未裁剪合法大需求集合", () => {
  const draft = completeDraft(), requirements = [...requirementItems(draft), ...Array.from({ length: REQUIREMENT_LIMITS.deferredItems }, (_, index) => ({ id: `verification_${index}`, text: `后续验证义务${index}` }))],
    candidate = currentDesign(requirements), last = requirements.length - 1;
  assert.equal(diagnoseArchitectureReferences(candidate, { requirements }).total, 0);
  candidate.coverage![last]!.componentIds = ["PRIVATE_WRONG_COMPONENT"];
  candidate.selectionBasis!.requirementIds[last] = "PRIVATE_WRONG_REQUIREMENT";
  candidate.acceptance![0]!.requirementIds[last] = "PRIVATE_WRONG_ACCEPTANCE";
  const feedback = diagnoseArchitectureReferences(candidate, { requirements });
  for (const path of [`design.coverage[${last}].componentIds[0]`, `design.selectionBasis.requirementIds[${last}]`, `design.acceptance[0].requirementIds[${last}]`])
    assert.ok(feedback.issues.some((issue) => issue.path === path && issue.reason === "invalid_reference"), path);
  assert.deepEqual(feedback.issues!.find((issue) => issue.path === "design.acceptance")!.missingReferences, [requirements[last]!.id]);
  assert.doesNotMatch(JSON.stringify(feedback), /PRIVATE_/);
});

test("宿主组合的长交互需求和Unicode文字可通过下游，不截断已接受要求", () => {
  const draft = validDraft();
  draft.interaction = { defaultEntry: "application", page: true, operations: [], inputs: "输".repeat(1200), results: "结".repeat(1200),
    persistentData: "数".repeat(1200), assistant: { enabled: true, purpose: "助".repeat(500) } };
  const requirements = requirementItems(draft), candidate = currentDesign(requirements, 1), original = structuredClone(requirements);
  assert.ok(requirements.find!((item) => item.id === "interaction")!.text.length > 4000);
  candidate.rationale = "😀".repeat(3000);
  assert.equal(ajv.compile(designSubmissionSchema(draft, { requirements }))(candidate), true);
  assert.doesNotThrow(() => validateDesign(candidate, { requirements }));
  assert.deepEqual(requirements, original);
  candidate.rationale = "😀".repeat(4001);
  assert.equal(ajv.compile(designSubmissionSchema(draft, { requirements }))(candidate), false);
  assert.throws(() => validateDesign(candidate, { requirements }), /rationale/);
});

function fidelityContext(count: number, full: boolean) {
  return { ...(full ? { fidelityContextVersion: "full-v2" } : {}), requirements: Array.from({ length: count }, (_, index) => ({ id: `r_${index}`, text: `原要求${index}` })),
    candidate: { instructions: "候选新增未确认输入限制" } };
}

function narrowed(context: unknown, { canonical = false } = {}) {
  const contextHash = diagnoseRequirementFidelitySubmission(context, null).contextHash;
  return { contextHash, verdict: "narrowed", checks: recordArray(objectFields(context).requirements).map(({ id }) => ({ requirementId: id,
    admissionPreserved: false, deliveryPreserved: true, newUnconfirmedRestriction: true })),
  restrictions: recordArray(objectFields(context).requirements).map(({ id, text }, index) => objectFields(context).fidelityContextVersion && !canonical
    ? { candidatePath: "/instructions", claimRef: { source: "requirements", requirementId: id }, reason: "新增未确认限制" }
    : { candidatePath: "/instructions", requirementId: id, source: "requirements", path: `/${index}/text`, quote: text, reason: "新增未确认限制" }) };
}

test("41项及最大254项已成立缩水均可完整交回，详细与短引用共用同一验收", async () => {
  for (const count of [41, REQUIREMENT_LIMITS.formalItems]) for (const full of [false, true]) {
    const context = fidelityContext(count, full), value = narrowed(context);
    assert.equal(diagnoseRequirementFidelitySubmission(context, value).valid, true);
    let schema;
    const result = await verifyRequirementFidelity({ context, config: {}, cwd: "/tmp", dataDir: "/tmp", sessionFactory: async (options) => {
      schema = fixtureToolAt(options.customTools).parameters;
      assert.equal(ajv.compile(schema)(value), true);
      return { modelCallAccounting: true, dispose() {}, async prompt() { await callFixture(options.onModelCall!, options, []); await fixtureToolAt(options.customTools).execute("scope", value); } };
    } });
    assert.equal(schema!.properties!.restrictions.maxItems, count);
    assert.equal(result.restrictions!.length, count); assert.equal(result.verdict, "narrowed");
    const canonical = Object.fromEntries(["contextHash", "verdict", "checks", "restrictions"].map((key) => [key, objectFields(result)[key]]));
    assert.equal(diagnoseRequirementFidelitySubmission(context, canonical, { canonical: true }).valid, true);
    value.restrictions.pop();
    const missing = diagnoseRequirementFidelitySubmission(context, value);
    assert.equal(missing.valid, false); assert.equal(missing.stage, "semantic");
    assert.ok(missing.issues.some((issue) => issue.reason === "restriction_missing_for_requirement" && issue.referenceId === objectFields(context.requirements.at(-1)).id));
  }
});

test("旧40条范围契约只按精确摘要重放，不能把旧拒稿按新契约变成有效结果", async () => {
  const context = fidelityContext(41, true), value = narrowed(context);
  let schema;
  await verifyRequirementFidelity({ context, config: {}, cwd: "/tmp", dataDir: "/tmp", sessionFactory: async (options) => {
    schema = structuredClone(fixtureToolAt(options.customTools).parameters);
    return { modelCallAccounting: true, dispose() {}, async prompt() { await callFixture(options.onModelCall!, options, []); await fixtureToolAt(options.customTools).execute("scope", value); } };
  } });
  const current = diagnoseRequirementFidelitySubmission(context, value);
  schema!.properties!.restrictions.maxItems = 40;
  const oldHash = designHash(schema), old = diagnoseRequirementFidelitySubmission(context, value, { schemaHash: oldHash });
  assert.equal(current.valid, true); assert.equal(old.valid, false); assert.equal(old.stage, "schema");
  assert.equal(old.schemaHash, oldHash); assert.notEqual(current.schemaHash, oldHash);
  assert.throws(() => diagnoseRequirementFidelitySubmission(context, value, { schemaHash: "a".repeat(64) }), /历史契约/);
});

test("动态条数不放宽整份证据字节限额，超量反馈要求精简依据而不删除业务判断", () => {
  const context = fidelityContext(REQUIREMENT_LIMITS.formalItems, true), value = narrowed(context);
  for (const row of value.restrictions) row.reason = "理由".repeat(750);
  const feedback = diagnoseRequirementFidelitySubmission(context, value);
  assert.equal(feedback.valid, false); assert.equal(feedback.stage, "schema");
  assert.ok(feedback.issues.some((issue) => issue.path === "fidelity" && issue.reason === "submission_size_limit" && issue.limitBytes === 256 * 1024));
  assert.equal(value.checks.length, REQUIREMENT_LIMITS.formalItems);
  const expanded = fidelityContext(REQUIREMENT_LIMITS.formalItems, true);
  for (const requirement of expanded.requirements) objectFields(requirement).text = "原".repeat(1000);
  const short = narrowed(expanded);
  assert.ok(Buffer.byteLength(JSON.stringify(short)) < 256 * 1024, "短引用本身未超量");
  assert.ok(diagnoseRequirementFidelitySubmission(expanded, short).issues.some((issue) => issue.reason === "submission_size_limit"), "同时核对实际归一后的证据量");
  for (const row of short.restrictions) Object.assign(row.claimRef!, { offset: 0, length: 1 });
  assert.equal(diagnoseRequirementFidelitySubmission(expanded, short).valid, true, "显式选择必要摘录后可完整提交全部项，不自动截断原文");
});

test("范围复核输出按当前条目有界估算且受模型声明额度约束，小需求不增额", async () => {
  for (const [count, limit, expected] of [[8, 65536, 8192], [80, 65536, 10240], [254, 65536, 32768], [254, 8192, 8192]] as const) {
    const context = fidelityContext(count, true), value = narrowed(context), config: ModelConfig = { chatUrl: "http://127.0.0.1:9/v1/chat/completions", model: "fixed" };
    config.modelProfile = { schemaVersion: 1, target: { chatUrl: config.chatUrl, model: config.model }, api: "openai-completions",
      contextWindow: 131072, maxOutputTokens: limit, reasoning: false, input: ["text"], compat: {} };
    const result = await verifyRequirementFidelity({ context, config, cwd: "/tmp", dataDir: "/tmp", sessionFactory: async (options) => {
      assert.equal(options.maxOutputTokens, expected);
      return { modelCallAccounting: true, dispose() {}, async prompt() { await callFixture(options.onModelCall!, options, []); await fixtureToolAt(options.customTools).execute("scope", value); } };
    } });
    assert.equal(result.modelCalls, 1); assert.equal(result.fidelityDiagnostic.requestedMaxOutputTokens, expected);
  }
  const context = fidelityContext(REQUIREMENT_LIMITS.formalItems, true), config: ModelConfig = { chatUrl: "http://127.0.0.1:9/v1/chat/completions", model: "fixed" };
  config.modelProfile = { schemaVersion: 1, target: { chatUrl: config.chatUrl, model: config.model }, api: "openai-completions",
    contextWindow: 131072, maxOutputTokens: 8192, reasoning: false, input: ["text"], compat: {} };
  let requested = 0;
  await assert.rejects(verifyRequirementFidelity({ context, config, cwd: "/tmp", dataDir: "/tmp", sessionFactory: async (options) => {
    assert.equal(options.maxOutputTokens, 8192); let notify: ((event: AgentSessionEvent) => void)|((arg0: { type: string; message: { role: string; stopReason: string; content: never[]; }; }) => void);
    return { modelCallAccounting: true, dispose() {}, subscribe(listener: Parameters<NonNullable<PiSessionPort["subscribe"]>>[0]) { notify = listener; return () => {}; }, async prompt() {
      await callFixture(options.onModelCall!, options, []); requested++; callFixture(notify, undefined, [{ type: "message_end", message: { role: "assistant", stopReason: "length", content: [] } }]);
    } };
  } }), (error: TestFailure) => error.reason === "scope_evaluation_incomplete" && error.fidelityDiagnostic!.stopReason === "output_limit"
    && error.fidelityDiagnostic!.requestedMaxOutputTokens === 8192 && error.modelCalls === 1);
  assert.equal(requested, 1, "供应商额度不足造成截断时停止，不伪造完整提交或盲目续试");
});
