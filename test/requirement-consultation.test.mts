import { fixtureText } from "./helpers/m7-test-boundaries.mjs";
import { callFixture } from "./helpers/m7-test-boundaries.mjs";
import type { ProviderIntegrations } from "../src/requirements/requirement-provider-port.mjs";
import type { FixtureModelRequest } from "./helpers/m7-test-boundaries.mjs";
import type { SystemCheck } from "../src/contracts/requirements.mjs";
import type { TaskSpecV1 } from "../src/contracts/versions.mjs";
interface SourceContext { [key: string]: unknown; evidenceReferences: { referenceId: string; messageId: string; role: string; quote: string }[]; sourcePatchSchema: object }
import { recordArray } from "./helpers/m7-test-boundaries.mjs";
import type { PreflightResponse } from "../src/contracts/requirements.mjs";
import type { RequirementIssue, IssueDecision, EvidenceMessage, RequirementDraft, Consultation } from "../src/contracts/requirements.mjs";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import type { TestFailure } from "./helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { Ajv } from "ajv";
import { processTurn, normalizeDraft, CONFIRMATION_QUESTION } from "../src/requirements/core.mjs";
import { contentHash, emptyTaskSpec, mergeEvidence, substantiveRequirementHash, TASK_DIMENSIONS, validateTaskEvidence, validateTaskSpecTransition } from "../src/requirements/task-spec.mjs";
import { authorizeConfirmedRequirement, claimRequirementHandoff, consultationGate, evaluateConsultation, issueConfirmation, newConsultation, validateRequirementReceipt, validatePreflight, currentDeferredIssues, preflightRequirementIds, preflightSchema } from "../src/requirements/consultation.mjs";
import { makeProviders } from "../src/requirements/providers.mjs";
import { safePreflightDiagnostic } from "../src/requirements/preflight-diagnostics.mjs";
import { MainMaterials } from "../src/main/main-materials.mjs";
import { prepareRequirement } from "../src/main/main-requirements.mjs";
import { validDraft } from "./helpers/architecture.mjs";
import { createPlatformSnapshot } from "../src/architecture/platform-contract.mjs";
import { sufficientPreflight, withPreflight } from "./helpers/consultation.mjs";

const draft = () => ({ ...validDraft("核对提供的材料并交付清单"), taskSpec: emptyTaskSpec() });
const input = (value = draft()) => ({ message: "核对我提供的材料并给出清单", draft: value });
const providers = (value = draft()) => withPreflight({ generateDraft: async () => ({ draft: value, proposedGap: "none", question: "" }) });
const strict = { enforceConsultation: true, platform: { version: 1 }, requestId: "request_1" };

test("旧草稿规范化不补任务字段；名称和展示类型不改变实质需求摘要", () => {
  const legacy = validDraft(); assert.equal("taskSpec" in normalizeDraft(legacy), false);
  const original = draft(), changed = structuredClone(original); changed.name.value = "改名"; changed.agentType.value = "其他展示类型";
  assert.equal(substantiveRequirementHash(original), substantiveRequirementHash(changed));
  changed.task.value = "新的工作"; assert.notEqual(substantiveRequirementHash(original), substantiveRequirementHash(changed));
});

test("来源逐字核实，不能把助手建议或伪造测量写成用户要求", () => {
  const evidence = mergeEvidence([], [{ id: "user_1", role: "user" as EvidenceMessage["role"], content: "每批大约五十份，逐项检查" },
    { id: "assistant_1", role: "assistant" as EvidenceMessage["role"], content: "建议只检查少量样本" }]);
  const spec = { version: 1, items: [{ id: "scale", dimension: "input_scale", content: "每批五十份", critical: true,
    applicability: "applies", source: { kind: "user", evidence: [{ messageId: "user_1", quote: "每批大约五十份" }] } }] };
  assert.deepEqual(validateTaskEvidence(spec, evidence), spec);
  const forged = structuredClone(spec); forged.items![0]!.source.evidence[0]!.quote = "每批只有五份";
  assert.throws(() => validateTaskEvidence(forged, evidence), /无法核对/);
  forged.items![0]!.source.evidence = [{ messageId: "assistant_1", quote: "建议只检查少量样本" }];
  assert.throws(() => validateTaskEvidence(forged, evidence), /用户原话/);
  forged.items![0]!.source.kind = "measured"; assert.throws(() => validateTaskEvidence(forged, evidence), /实际测量/);
});

test("关键未知项不能被删除或降级绕过确认，退休需本轮用户修改依据", () => {
  const previous = { version: 1, items: [{ id: "scale", dimension: "input_scale", content: "规模待确定", critical: true,
    applicability: "unknown", source: { kind: "unknown", evidence: [] as { messageId: string; quote: string }[] } }] };
  assert.throws(() => validateTaskSpecTransition(previous, emptyTaskSpec(), [], "确认"), /不能/);
  const evidence = [{ id: "u", role: "user" as EvidenceMessage["role"], content: "不需要批量处理了" }];
  const next = { ...emptyTaskSpec(), retired: [{ id: "scale", reason: "用户取消批量范围", evidence: [{ messageId: "u", quote: "不需要批量处理了" }] }] };
  assert.doesNotThrow(() => validateTaskSpecTransition(previous, next, evidence, evidence[0]!.content));
  assert.throws(() => callFixture(validateTaskSpecTransition, undefined, [previous, next, evidence, "确认"]), /不能/);
  const lowered = structuredClone(previous); lowered.items![0]!.critical = false;
  lowered.items![0]!.source = { kind: "user", evidence: [{ messageId: "u", quote: evidence[0]!.content }] };
  assert.throws(() => callFixture(validateTaskSpecTransition, undefined, [previous, lowered, evidence, "确认"]), /不能/);
  assert.doesNotThrow(() => validateTaskSpecTransition(previous, lowered, evidence, evidence[0]!.content));
});

test("明确任务经过独立预评估才能确认；确认凭据不可通过 JSON 伪造", async () => {
  const ready = await processTurn(input(), providers(), strict);
  assert.equal(ready.status, "ready"); assert.equal(ready.confirmed, false);
  const confirmed = await processTurn({ message: "确认", draft: ready.draft, consultation: ready.consultation,
    lastQuestion: ready.confirmationQuestion }, { generateDraft: () => assert.fail("明确确认无需重写需求"),
    preflight: () => assert.fail("相同需求不重评估") }, { ...strict, requestId: "request_2" });
  assert.equal(confirmed.confirmed, true);
  const receipt = authorizeConfirmedRequirement(confirmed.draft, confirmed.confirmation);
  assert.equal(validateRequirementReceipt(confirmed.draft, receipt), true);
  assert.throws(() => authorizeConfirmedRequirement(confirmed.draft, structuredClone(confirmed.confirmation)), /服务端/);
  const changed = structuredClone(confirmed.draft); changed.task.value = "改成另一个任务";
  assert.equal(validateRequirementReceipt(changed, receipt), false);
});

test("没有预评估不会放行；模型故障保留草稿且不重复盘问业务问题", async () => {
  const result = await processTurn(input(), { generateDraft: providers().generateDraft }, strict);
  assert.equal(result.status, "needs_input"); assert.equal(result.confirmed, false);
  assert.equal(result.consultation!.assessments[0]!.failure, "preflight_unavailable");
  assert.match(result.question!, /预评估未完成/); assert.equal(result.draft.task.value, draft().task.value);
});

test("预评估的关键用户问题进入下一轮，系统问题不伪装用户选项", async () => {
  const base = await sufficientPreflight();
  const result = await processTurn(input(), { ...providers(), preflight: async () => ({ ...base, verdict: "needs_input" as PreflightResponse["verdict"],
    issues: [{ id: "batch", owner: "user" as RequirementIssue["owner"], blocking: true, question: "通常一次需要处理多少份材料？", impact: "决定批次和恢复方式", requirementIds: ["inputSource"] }] }) }, strict);
  assert.equal(result.question, "通常一次需要处理多少份材料？"); assert.equal(result.status, "needs_input");
  assert.equal(result.confirmationGate!.reason, "needs_input");
});

test("同一次消息最多一次预评估，改变平台或任务后旧结果失效", async () => {
  let calls = 0; const value = draft();
  const args = { draft: value, consultation: newConsultation(), platform: { version: 1 }, requestId: "same",
    preflight: async () => { calls++; return sufficientPreflight(); } };
  const one = await evaluateConsultation(args);
  await evaluateConsultation({ ...args, consultation: one, platform: { version: 2 } });
  assert.equal(calls, 1); assert.equal(consultationGate(value, one, { version: 2 }).allowed, false);
  const changed = structuredClone(value); changed.deliverable.value = "更详细的交付";
  assert.equal(consultationGate(changed, one, args.platform).allowed, false);
});

test("预评估后的取消不产生确认凭据，原协商记录保持不变", async () => {
  const controller = new AbortController(), previous = newConsultation();
  await assert.rejects(callFixture(evaluateConsultation, undefined, [{ draft: draft(), consultation: previous, platform: {}, requestId: "a",
    signal: controller.signal, preflight: async () => { controller.abort(); return sufficientPreflight(); } }]), { name: "AbortError" });
  assert.equal(previous.assessments.length, 0);
});

test("正式架构返需绑定需求版本；重复领取不会增加版本或切换其他需求", () => {
  const requirement = { draft: draft(), version: 1, agentId: "agent", confirmed: true, status: "needs_build", consultation: newConsultation() };
  const handoff = { id: "handoff", requirementHash: substantiveRequirementHash(requirement.draft), architectureVersion: 2,
    issues: [{ id: "history", owner: "user" as RequirementIssue["owner"], blocking: true, question: "需要保留历史吗？", impact: "决定数据保存", requirementIds: ["task"] }] };
  const claimed = claimRequirementHandoff(requirement, handoff); assert.equal(claimed.status, "needs_input");
  assert.equal(claimed.confirmed, false); assert.equal(requirement.confirmed, true);
  assert.deepEqual(claimRequirementHandoff(claimed, handoff), claimed);
  assert.throws(() => callFixture(claimRequirementHandoff, undefined, [requirement, { ...handoff, requirementHash: contentHash("other") }]), /过期/);
});

test("真实预评估 provider 的修复和资料核实共享六回合与两次预算", async () => {
  let modelCalls = 0, researchCalls = 0;
  const real = makeProviders({ llmConfigured: true, chatUrl: "https://model.invalid/chat", model: "fake", apiKey: "test" },
    async () => { modelCalls++; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ research: { query: "official test" } }) } }] }), { status: 200 }); });
  await assert.rejects(real.preflight!({ draft: draft(), platform: {}, evidenceMessages: [], previousIssues: [],
    research: async () => { researchCalls++; return { supported: true }; } }), /预算/);
  assert.equal(modelCalls, 6); assert.equal(researchCalls, 2);
});

test("真实预评估 provider 能修复结构并返回完整六维判断", async () => {
  let calls = 0; const response = await sufficientPreflight();
  const real = makeProviders({ llmConfigured: true, chatUrl: "https://model.invalid/chat", model: "fake", apiKey: "test" },
    async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(++calls === 1 ? { verdict: "sufficient" as PreflightResponse["verdict"] } : response) } }] }), { status: 200 }));
  const { preflightDiagnostic, ...evaluated } = await real.preflight!({ draft: draft(), platform: {}, evidenceMessages: [], previousIssues: [] });
  assert.deepEqual(evaluated, response); assert.equal(objectFields(preflightDiagnostic).modelTurns, 2);
  assert.equal(objectFields(objectFields(objectFields(preflightDiagnostic).events)[0]).reason, "candidate_shape");
  assert.equal(calls, 2);
});

test("即使模型表示充分，仍未知的关键要求也不能确认", async () => {
  const value = draft(); value.taskSpec.items.push({ id: "scale", dimension: "input_scale", content: "材料规模待明确",
    critical: true, applicability: "unknown", source: { kind: "unknown", evidence: [] as { messageId: string; quote: string }[] } });
  const ready = await processTurn(input(value), providers(value), strict);
  assert.equal(ready.status, "needs_input"); assert.equal(ready.confirmationGate!.reason, "critical_requirement_unknown");
});

test("编辑已保存任务从独立协商记录恢复原始证据", async () => {
  const value = draft(), consultation = newConsultation();
  consultation.evidenceMessages = [{ id: "old", role: "user" as EvidenceMessage["role"], content: "必须逐项检查并提供完整清单" }];
  value.taskSpec.items.push({ id: "coverage", dimension: "processing", content: "逐项完整覆盖", critical: true,
    applicability: "applies", source: { kind: "user", evidence: [{ messageId: "old", quote: "必须逐项检查" }] } });
  const prepared = await prepareRequirement({ record: {}, agentId: "existing", mode: "edit", conversationId: "new_chat", mutationId: "edit" }, {
    getRequirements: async () => ({ requirements: [{ id: "existing", name: "已有助手", draft: value }] }),
    getRequirementConsultation: async () => consultation,
  });
  assert.deepEqual(prepared.consultation!.evidenceMessages, consultation.evidenceMessages);
  assert.doesNotThrow(() => validateTaskEvidence(prepared.draft.taskSpec, prepared.consultation!.evidenceMessages));
});

test("材料规模测量使用真实解析结果，区分字符数、截断与解析失败", async () => {
  const store = new MainMaterials({ storage: { ready: Promise.resolve() }, materials: {
    resolve: async () => [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "示例.txt", size: 16, kind: "text" }, { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "不可读.pdf", size: 99, kind: "pdf" }],
    parsed: async (_conversation, descriptor) => {
      if (descriptor.id === "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb") throw new Error("parser failure");
      return { text: "中文🙂", pageCount: 1, status: "parsed", truncated: true };
    },
  } });
  const measured = await store.measure("conversation", ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]);
  const first = JSON.parse(String(measured[0]!.content)), second = JSON.parse(String(measured[1]!.content));
  assert.equal(measured[0]!.role, "measurement"); assert.equal(first.extractedCharacters, 3); assert.equal(first.extractionComplete, false);
  assert.equal(second.status, "extraction_failed"); assert.equal("extractedCharacters" in second, false);
});

test("新任务要求进入用户确认摘要，不能只作为隐藏选型字段", async () => {
  const value = draft(); value.taskSpec.items.push({ id: "quality", dimension: "delivery", content: "每项结果必须标明材料出处", critical: true,
    applicability: "applies", source: { kind: "user", evidence: [{ messageId: "u", quote: "每项结果必须标明材料出处" }] } });
  const ready = await processTurn({ ...input(value), evidenceMessages: [{ id: "u", role: "user" as EvidenceMessage["role"], content: "每项结果必须标明材料出处" }] }, providers(value), strict);
  assert.equal(ready.status, "ready"); assert.match(ready.summary, /交付标准：每项结果必须标明材料出处/);
});

function issue(): RequirementIssue;
function issue<T extends object>(overrides: T): Omit<RequirementIssue, keyof T> & T;
function issue(overrides = {}) { return ({ id: "choice", owner: "user" as RequirementIssue["owner"], blocking: true,
  question: "交付结果需要逐项完整覆盖，还是允许抽样？", impact: "决定质量检查与执行方式", requirementIds: ["task"], ...overrides }); }
const assessmentWith = async (issues: RequirementIssue[]): Promise<PreflightResponse> => ({ ...await sufficientPreflight(),
  verdict: issues.some((entry) => entry.owner === "user" && entry.blocking) ? "needs_input"
    : issues.some((entry) => entry.owner === "system" && entry.blocking) ? "blocked" : "sufficient", issues });
function scriptedPreflight(responses: unknown[], integrations: ProviderIntegrations = {}) {
  const requests: { messages: { role: string; content: string }[]; [key: string]: unknown }[] = [];
  const real = makeProviders({ llmConfigured: true, chatUrl: "https://model.invalid/chat", model: "fake", apiKey: "test" },
    async (_url, options) => {
      requests.push(JSON.parse(String(options!.body!)));
      const scripted = responses[Math.min(requests.length - 1, responses.length - 1)];
      const response = typeof scripted === "function" ? await scripted(requests.at(-1)) : scripted;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }), { status: 200 });
    }, integrations);
  return { ...real, requests };
}

test("草稿不变但加入新回答或实际测量时不足评估失效，同消息重放仍最多评估一次", async () => {
  const value = draft(); let calls = 0;
  const initial = newConsultation(); initial.evidenceMessages = [{ id: "first", role: "user" as EvidenceMessage["role"], content: "按批处理材料" }];
  const args = { draft: value, consultation: initial, platform: {}, requestId: "initial",
    preflight: async () => { calls++; return assessmentWith([issue()]); } };
  const first = await evaluateConsultation(args);
  const answered = structuredClone(first); answered.evidenceMessages.push({ id: "answer", role: "user" as EvidenceMessage["role"], content: "必须逐项覆盖全部材料" });
  assert.equal(consultationGate(value, answered, {}).reason, "assessment_stale");
  const replay = await evaluateConsultation({ ...args, consultation: answered });
  assert.equal(calls, 1); assert.equal(replay.assessments.length, 1);
  const second = await evaluateConsultation({ ...args, consultation: answered, requestId: "answered" });
  assert.equal(calls, 2); assert.equal(second.assessments!.at(-1)!.requestId, "answered");
  const measured = structuredClone(second); measured.evidenceMessages.push({ id: "measured", role: "measurement" as EvidenceMessage["role"], content: "输入共 120 项" });
  await evaluateConsultation({ ...args, consultation: measured, requestId: "measured" }); assert.equal(calls, 3);
  await evaluateConsultation({ ...args, consultation: first, requestId: "unchanged" }); assert.equal(calls, 3);
});

test("独立复核根据完整原话消除已回答问题，并把拒绝降级的决定保存为可追溯记录", async () => {
  const evidence = [{ id: "full", role: "user" as EvidenceMessage["role"], content: "必须逐项覆盖全部材料，不接受只检查样本" }];
  const decisions = [{ issueId: "choice", status: "resolved" as IssueDecision["status"], reason: "用户已明确全量覆盖，并拒绝抽样方案",
    evidence: [{ messageId: "full", quote: "必须逐项覆盖全部材料，不接受只检查样本" }] }];
  const real = scriptedPreflight([await assessmentWith([issue()]), { decisions }, await sufficientPreflight()]);
  const consultation = { ...newConsultation(), evidenceMessages: evidence };
  const result = await evaluateConsultation({ draft: draft(), consultation, platform: {}, requestId: "resolved", preflight: real.preflight });
  assert.equal(result.assessments!.at(-1)!.verdict, "sufficient"); assert.equal(real.requests.length, 3);
  const recorded = result.issues.find((entry) => entry.id === "choice");
  assert.equal(recorded!.status!, "resolved"); assert.deepEqual(recorded!.resolution!.evidence, decisions[0]!.evidence);
  assert.equal(recorded!.resolution!.assessmentId, result.assessments!.at(-1)!.id);
  assert.equal(consultationGate(draft(), result, {}).allowed, true);
  assert.match(real.requests[1]!.messages[0]!.content, /需求实现审查中的问题、证据与阶段复核者/);
});

test("已解决问题不能靠更换编号重问，也不把同一字段下真正的新问题一并删除", async () => {
  const previous = { ...issue(), status: "resolved" as IssueDecision["status"], resolution: { evidenceIds: ["old"] } };
  const evidence = [{ id: "old", role: "user" as EvidenceMessage["role"], content: "逐项全量检查，不接受抽样" }];
  const repeated = issue({ id: "renamed", question: "是否接受仅检查代表性样本？" });
  const newQuestion = issue({ id: "unanswered", question: "发现错误后是否需要人工确认才能继续？" });
  const decisions = [
    { issueId: "renamed", status: "resolved" as IssueDecision["status"], reason: "新编号仍重复了用户已经拒绝的抽样方案", evidence: [{ messageId: "old", quote: "不接受抽样" }] },
    { issueId: "unanswered", status: "open" as IssueDecision["status"], reason: "人工确认是独立的新业务选择，尚无答案", evidence: [] },
  ];
  const real = scriptedPreflight([await assessmentWith([repeated, newQuestion]), { decisions }, await assessmentWith([newQuestion])]);
  const consultation = { ...newConsultation(), evidenceMessages: evidence, issues: [previous] };
  const result = await callFixture(evaluateConsultation, undefined, [{ draft: draft(), consultation, platform: {}, requestId: "changed", preflight: real.preflight }]);
  assert.equal(result.assessments!.at(-1)!.verdict, "needs_input"); assert.equal(real.requests.length, 3);
  assert.equal(consultationGate!(draft(), result, {}).issue!.id, "unanswered");
  assert.equal(result.issues!.find((entry) => entry.id === "renamed")!.status, "resolved");
});

test("重复已解决选择的顽固模型不能被放行，问题复核与修正共同受六回合限制", async () => {
  const question = await assessmentWith([issue()]);
  const decisions = [{ issueId: "choice", status: "resolved" as IssueDecision["status"], reason: "用户明确要求全量覆盖", evidence: [{ messageId: "a", quote: "全量覆盖" }] }];
  const real = scriptedPreflight([question, { decisions }, question]);
  await assert.rejects(real.preflight!({ draft: draft(), platform: {}, previousIssues: [],
    evidenceMessages: [{ id: "a", role: "user" as EvidenceMessage["role"], content: "全量覆盖" }] }), /预算/);
  assert.equal(real.requests.length, 6);
});

test("伪造关闭依据、引用助手建议和无新事实重开已解决问题均被程序拒绝", async () => {
  const evidence = [{ id: "u", role: "user" as EvidenceMessage["role"], content: "所有输入逐项核对" }, { id: "a", role: "assistant" as EvidenceMessage["role"], content: "可以抽样" }];
  const consultation = { ...newConsultation(), evidenceMessages: evidence,
    issues: [{ ...issue(), status: "resolved" as IssueDecision["status"], resolution: { evidenceIds: ["u"] } }] };
  for (const decision of [
    { issueId: "choice", status: "resolved" as IssueDecision["status"], reason: "伪造回答", evidence: [{ messageId: "u", quote: "允许抽样" }] },
    { issueId: "choice", status: "resolved" as IssueDecision["status"], reason: "错误使用建议", evidence: [{ messageId: "a", quote: "可以抽样" }] },
    { issueId: "choice", status: "reopened" as IssueDecision["status"], reason: "没有新事实又重问", evidence: [{ messageId: "u", quote: "逐项核对" }] },
  ]) {
    const result = await callFixture(evaluateConsultation, undefined, [{ draft: draft(), consultation, platform: {}, requestId: "invalid",
      preflight: async () => ({ ...await sufficientPreflight(), issueDecisions: [decision] }) }]);
    assert.equal(result.assessments!.at(-1)!.failure, "preflight_failed");
    assert.equal(consultationGate(draft(), result, {}).allowed, false);
  }
  const changed = { ...consultation, evidenceMessages: [...evidence, { id: "new", role: "user" as EvidenceMessage["role"], content: "现在改为允许抽样" }] };
  const reopened = await callFixture(evaluateConsultation, undefined, [{ draft: draft(), consultation: changed, platform: {}, requestId: "reopen",
    preflight: async () => ({ ...await assessmentWith([issue()]), issueDecisions: [{ issueId: "choice", status: "reopened" as IssueDecision["status"],
      reason: "用户主动改变原要求", evidence: [{ messageId: "new", quote: "现在改为允许抽样" }] }] }) }]);
  assert.equal(reopened.issues![0]!.status, "open"); assert.equal(reopened.assessments!.at(-1)!.failure, undefined);
});

test("系统只读核实使用可信回调，平台网关能力与生成代码禁监听不混淆", async () => {
  const technical = issue({ id: "gateway", owner: "system" as RequirementIssue["owner"], stage: "requirements" as NonNullable<RequirementIssue["stage"]>, checks: ["platform.deliveryRoutes.managedService"], question: "平台网关能否提供授权后的本机入口？" });
  const platform = createPlatformSnapshot({ allowNetwork: false });
  let checks = 0;
  const real = scriptedPreflight([await assessmentWith([technical]), await sufficientPreflight(), { decisions: [{ issueId: "gateway", owner: "system" as RequirementIssue["owner"], stage: "requirements" as NonNullable<RequirementIssue["stage"]>,
    status: "resolved" as IssueDecision["status"], checks: technical.checks, reason: "同问题平台回执已证明网关路径存在，不代表未来验收通过", evidence: [] }] }], {
    verifySystemIssues: async (request: { platform: unknown; issues: { id: unknown; }[]; }) => {
      checks++; assert.deepEqual(request.platform, platform); assert.equal(request.issues![0]!.id, "gateway");
      return [{ id: "gateway", status: "verified", message: "宿主网关已实现，生成代码仍不监听端口", evidence: [
        { source: "platform", reference: "platform.deliveryRoutes.managedService", detail: "平台网关提供 API 和 MCP，需用户启用授权" },
      ] }];
    },
  });
  const result = await evaluateConsultation({ draft: draft(), consultation: newConsultation(), platform,
    requestId: "system", preflight: real.preflight });
  assert.equal(checks, 1); assert.equal(real.requests.length, 3); assert.equal(result.assessments!.at(-1)!.verdict, "sufficient");
  assert.equal(result.assessments!.at(-1)!.systemChecks![0]!.status, "verified");
});

test("核实失败、缺少结果或证据时不放行，也不把系统问题显示为用户技术盘问", async () => {
  const technical = issue({ owner: "system" as RequirementIssue["owner"], stage: "requirements" as NonNullable<RequirementIssue["stage"]>, question: "请用户核实平台鉴权和隔离实现？" });
  for (const verifySystemIssues of [async () => { throw new Error("private diagnostic"); }, async () => [],
    async () => [{ id: "choice", status: "verified", message: "无证据宣称已验证", evidence: [] }]]) {
    const blocked = await assessmentWith([technical]);
    const real = scriptedPreflight([blocked, blocked, { decisions: [{ issueId: "choice", owner: "system" as RequirementIssue["owner"], stage: "requirements" as NonNullable<RequirementIssue["stage"]>, status: "open" as IssueDecision["status"],
      reason: "缺少可信能力证据，仍是当前系统缺口", evidence: [] }] }], { verifySystemIssues });
    const result = await processTurn(input(), { ...providers(), preflight: real.preflight, verifySystemIssues }, strict);
    assert.equal(result.confirmationGate!.allowed, false); assert.equal(result.confirmationGate!.reason, "capability_blocked");
    assert.match(result.question!, /系统尚未完成/); assert.doesNotMatch(result.question!, /请用户|鉴权|private/);
    assert.equal(result.consultation!.assessments.at(-1)!.systemChecks![0]!.status, "unknown");
  }
});

test("模型不能移除核实为未知的阻断，运行时检查也不能被升级成用户阻断", async () => {
  const technical = issue({ owner: "system" as RequirementIssue["owner"], stage: "requirements" as NonNullable<RequirementIssue["stage"]> });
  const real = scriptedPreflight([await assessmentWith([technical]), await sufficientPreflight()], {
    verifySystemIssues: async () => [{ id: "choice", status: "unknown", message: "环境尚未核实", evidence: [] }],
  });
  await assert.rejects(real.preflight!({ draft: draft(), platform: {}, previousIssues: [], evidenceMessages: [] }), /预算/);
  assert.equal(real.requests.length, 6);
  const runtime = await assessmentWith([issue({ owner: "runtime" as RequirementIssue["owner"], blocking: false })]);
  const result = await processTurn(input(), { ...providers(), preflight: async () => runtime }, strict);
  assert.equal(result.status, "ready"); assert.equal(result.confirmationGate!.allowed, true);
});

test("充分预评估可消除草稿模型臆造的额外问题，系统故障覆盖错误业务问句", async () => {
  const generated = { ...providers(), generateDraft: async () => ({ draft: draft(), proposedGap: "boundary", question: "还要额外增加什么偏好吗？" }) };
  const result = await processTurn(input(), generated, strict);
  assert.equal(result.status, "ready"); assert.equal(result.question, null); assert.equal(result.confirmationQuestion, CONFIRMATION_QUESTION);
  const failed = await processTurn(input(), { ...generated, preflight: async () => { throw new Error("model failed"); } }, strict);
  assert.equal(failed.status, "needs_input"); assert.match(failed.question!, /预评估未完成/); assert.doesNotMatch(failed.question!, /偏好/);
});

test("关键未知与系统阻断并存时显示系统核实状态，可信核实记录成为独立测量依据", async () => {
  const value = draft(); value.taskSpec.items.push({ id: "environment", dimension: "external_conditions", content: "平台运行环境待核实",
    critical: true, applicability: "unknown", source: { kind: "unknown", evidence: [] as { messageId: string; quote: string }[] } });
  const technical = issue({ owner: "system" as RequirementIssue["owner"], stage: "requirements" as NonNullable<RequirementIssue["stage"]>, requirementIds: ["environment"], question: "请用户确认平台是否隔离监听？" });
  const blocked = await processTurn(input(value), { ...providers(value), preflight: async () => ({ ...await assessmentWith([technical]),
    issueDecisions: [{ issueId: technical.id, owner: "system" as RequirementIssue["owner"], stage: "requirements" as NonNullable<RequirementIssue["stage"]>, status: "open" as IssueDecision["status"], reason: "当前平台事实尚未核实", evidence: [] }] }) }, strict);
  assert.equal(blocked.confirmationGate!.reason, "capability_blocked"); assert.match(blocked.question!, /系统尚未完成/);
  const check = { id: "runtime", status: "verified", message: "隔离检查通过", evidence: [
    { source: "runtime", reference: "runtime.managed.javascript", detail: "固定本机测试程序完成隔离探测" },
  ] };
  const evaluated = await evaluateConsultation({ draft: draft(), consultation: newConsultation(), platform: {}, requestId: "facts",
    preflight: async () => ({ ...await sufficientPreflight(), systemChecks: [check] }) });
  const measured = evaluated.evidenceMessages.find((entry) => entry.role === "measurement");
  assert.equal(JSON.parse(String(measured!.content!)).type, "system_verification");
  assert.equal(JSON.parse(String(measured!.content!)).evidence[0].reference, "runtime.managed.javascript");
  assert.equal(consultationGate(draft(), evaluated, {}).allowed, true);
});

test("误分给用户的技术问题由独立复核转回系统，不让用户回答实现细节", async () => {
  const misplaced = issue({ question: "请用户核实宿主支持哪种鉴权接口？" });
  const technical = { ...misplaced, owner: "system" as RequirementIssue["owner"], stage: "requirements" as NonNullable<RequirementIssue["stage"]> };
  const real = scriptedPreflight([await assessmentWith([misplaced]), { decisions: [{ issueId: "choice", owner: "system" as RequirementIssue["owner"], stage: "requirements" as NonNullable<RequirementIssue["stage"]>, status: "open" as IssueDecision["status"],
    reason: "需要核实平台事实，不能要求业务用户猜测", evidence: [] }] }, await assessmentWith([technical]), { decisions: [{ issueId: "choice", owner: "system" as RequirementIssue["owner"],
      stage: "requirements" as NonNullable<RequirementIssue["stage"]>, status: "open" as IssueDecision["status"], reason: "系统尚无可信核实结果，仍需保留", evidence: [] }] }]);
  const result = await processTurn(input(), { ...providers(), preflight: real.preflight }, strict);
  assert.equal(result.confirmationGate!.reason, "capability_blocked"); assert.match(result.question!, /系统尚未完成/);
  assert.equal(result.consultation!.issues[0]!.owner, "system"); assert.equal(real.requests.length, 4);
});

test("独立复核缺项或格式一直失败时不得忽略失败并放行原来的重复问题", async () => {
  const real = scriptedPreflight([await assessmentWith([issue()]), { decisions: [] }]);
  await assert.rejects(real.preflight!({ draft: draft(), platform: {}, previousIssues: [], evidenceMessages: [] }), /预算/);
  assert.equal(real.requests.length, 6);
});

test("系统核实只接受受控引用，不能请求任意属性路径或把检查交给业务用户", async () => {
  const base = await sufficientPreflight();
  assert.doesNotThrow(() => validatePreflight({ ...base, verdict: "blocked" as PreflightResponse["verdict"], issues: [
    issue({ owner: "system" as RequirementIssue["owner"], stage: "requirements" as NonNullable<RequirementIssue["stage"]>, checks: ["platform.deliveryRoutes.managedService", "platform.runtime"] }),
  ] }, draft()));
  for (const bad of [issue({ checks: ["platform.runtime"] }), issue({ owner: "system" as RequirementIssue["owner"], stage: "requirements" as NonNullable<RequirementIssue["stage"]>, checks: ["process.env"] }),
    issue({ owner: "system" as RequirementIssue["owner"], stage: "requirements" as NonNullable<RequirementIssue["stage"]>, checks: ["runtime.managed.python", "runtime.managed.python"] })]) {
    assert.throws(() => validatePreflight({ ...base, verdict: bad.owner === "system" ? "blocked" : "needs_input", issues: [bad] }, draft()), /受控检查/);
  }
});

test("独立复核仍未回答的旧阻断，不能因新预评估漏列它而静默消失", async () => {
  const previous = { ...issue(), status: "open" as IssueDecision["status"] };
  const real = scriptedPreflight([await sufficientPreflight(), { decisions: [
    { issueId: "choice", status: "open" as IssueDecision["status"], reason: "用户没有回答覆盖范围", evidence: [] },
  ] }, await sufficientPreflight()]);
  await assert.rejects(callFixture(real.preflight!, undefined, [{ draft: draft(), platform: {}, previousIssues: [previous], evidenceMessages: [] }]), /预算/);
  assert.equal(real.requests.length, 6);
});

test("首次创建尚未形成任务轮廓时保留具体业务追问，不显示尚未启动的评估门槛", async () => {
  const value = normalizeDraft({ goal: { value: "帮助整理工作资料", source: "user" }, taskSpec: emptyTaskSpec() });
  let evaluations = 0;
  const result = await processTurn({ message: "帮我创建一个整理资料的助手", draft: normalizeDraft({}) }, {
    generateDraft: async () => ({ draft: value, proposedGap: "source", question: "你会提供哪种材料？" }),
    preflight: async () => { evaluations++; return sufficientPreflight(); },
  }, strict);
  assert.equal(evaluations, 0); assert.equal(result.question, "你会提供哪种材料？");
  assert.equal(result.confirmationGate!.reason, "assessment_missing");
  assert.equal(result.status, "needs_input"); assert.equal(result.confirmed, false);
});

test("误分为用户问题的系统事项核实后可关闭，仍在六回合内完成且有绑定证据", async () => {
  const misplaced = issue({ id: "gateway", question: "平台是否支持本机调用入口？" });
  const technical = { ...misplaced, owner: "system" as RequirementIssue["owner"], stage: "requirements" as NonNullable<RequirementIssue["stage"]>, checks: ["platform.deliveryRoutes.managedService"] };
  let checks = 0;
  const real = scriptedPreflight([await assessmentWith([misplaced]), { decisions: [{ issueId: "gateway", owner: "system" as RequirementIssue["owner"], stage: "requirements" as NonNullable<RequirementIssue["stage"]>, status: "open" as IssueDecision["status"],
    reason: "平台事实应由系统读取", evidence: [] }] }, await assessmentWith([technical]), await sufficientPreflight(), { decisions: [{ issueId: "gateway", owner: "system" as RequirementIssue["owner"], stage: "requirements" as NonNullable<RequirementIssue["stage"]>,
      status: "resolved" as IssueDecision["status"], checks: technical.checks, reason: "同问题可信平台事实已证明本机调用入口存在", evidence: [] }] }], {
    verifySystemIssues: async () => { checks++; return [{ id: "gateway", status: "verified", message: "已核实宿主网关契约", evidence: [
      { source: "platform", reference: "platform.deliveryRoutes.managedService", detail: "宿主网关支持按动作范围启用本机入口" },
    ] }]; },
  });
  const result = await evaluateConsultation({ draft: draft(), consultation: newConsultation(), platform: {}, requestId: "corrected", preflight: real.preflight });
  assert.equal(real.requests.length, 5); assert.equal(checks, 1); assert.equal(consultationGate(draft(), result, {}).allowed, true);
  const recorded = result.issues.find((entry) => entry.id === "gateway");
  assert.equal(recorded!.status!, "resolved"); assert.equal(recorded!.resolution!.status, "resolved"); assert.equal(recorded!.resolution!.stage, "requirements");
  assert.equal(recorded!.resolution!.assessmentId, result.assessments!.at(-1)!.id);
});

test("正式系统返需不能因候选漏列而消失，只有绑定该问题的可信核实才可解决", async () => {
  const technical = issue({ id: "authorization", owner: "system" as RequirementIssue["owner"], stage: "requirements" as NonNullable<RequirementIssue["stage"]>, question: "第三方授权是否具备条件？" });
  const handoff = { id: "formal_system", requirementHash: substantiveRequirementHash(draft()), architectureVersion: 2,
    issues: [technical], resolved: false };
  let calls = 0;
  const uncertain = scriptedPreflight([await sufficientPreflight()], {
    verifySystemIssues: async () => { calls++; return [{ id: technical.id, status: "unknown", message: "尚未取得授权证据", evidence: [] }]; },
  });
  const blocked = await evaluateConsultation({ draft: draft(), consultation: { ...newConsultation(), handoff }, platform: {},
    requestId: "unresolved", preflight: uncertain.preflight });
  assert.equal(calls, 1); assert.equal(uncertain.requests.length, 6); assert.equal(blocked.handoff!.resolved, false);
  assert.equal(consultationGate(draft(), blocked, {}).allowed, false);
  const knownIssue = { ...technical, checks: ["platform.connections"] };
  const verified = scriptedPreflight([await sufficientPreflight(), await sufficientPreflight(), { decisions: [{ issueId: technical.id, owner: "system" as RequirementIssue["owner"],
    stage: "requirements" as NonNullable<RequirementIssue["stage"]>, status: "resolved" as IssueDecision["status"], checks: ["platform.connections"], reason: "当前待核实的指定平台契约已由同问题宿主回执确认", evidence: [] }] }], {
    verifySystemIssues: async () => [{ id: technical.id, status: "verified", message: "指定连接契约已核实", evidence: [
      { source: "platform", reference: "platform.connections", detail: "只证明支持的认证契约，不证明用户已登录第三方" },
    ] }],
  });
  const resolved = await evaluateConsultation({ draft: draft(), consultation: { ...newConsultation(), handoff: { ...handoff, issues: [knownIssue] } },
    platform: {}, requestId: "verified", preflight: verified.preflight });
  assert.equal(verified.requests.length, 3); assert.equal(resolved.handoff!.resolved, true);
  assert.equal(consultationGate(draft(), resolved, {}).allowed, true);
});

test("正式用户返需必须经原文证据关闭，漏列或改稿不能绕过，后续新回答仍能重新评估", async () => {
  const handoff = { id: "formal_user", requirementHash: substantiveRequirementHash(draft()), architectureVersion: 2,
    issues: [issue()], resolved: false };
  const changed = structuredClone(draft()); changed.deliverable.value += "，并附逐项索引";
  assert.notEqual(substantiveRequirementHash(changed), handoff.requirementHash);
  const initial = { ...newConsultation(), handoff }, initialBefore = structuredClone(initial), draftBefore = structuredClone(changed);
  const omitted = await evaluateConsultation({ draft: changed, consultation: initial, platform: {}, requestId: "omitted", preflight: sufficientPreflight });
  assert.equal(omitted.assessments!.at(-1)!.failure, "preflight_failed"); assert.notEqual(omitted.assessments!.at(-1)!.verdict, "sufficient");
  assert.equal(omitted.handoff!.resolved, false); assert.equal(consultationGate(changed, omitted, {}).reason, "preflight_failed");
  assert.deepEqual(omitted.handoff, handoff); assert.deepEqual(initial, initialBefore); assert.deepEqual(changed, draftBefore);
  assert.throws(() => issueConfirmation(changed, omitted, { platform: {} }), /需求预评估未完成/);
  omitted.evidenceMessages.push({ id: "answer", role: "user" as EvidenceMessage["role"], content: "逐项完整覆盖全部输入，不允许抽样" });
  let evaluated = 0;
  const answered = await evaluateConsultation({ draft: changed, consultation: omitted, platform: {}, requestId: "answered",
    preflight: async () => { evaluated++; return { ...await sufficientPreflight(), issueDecisions: [{ issueId: "choice", status: "resolved" as IssueDecision["status"],
      reason: "用户已明确覆盖标准", evidence: [{ messageId: "answer", quote: "逐项完整覆盖全部输入，不允许抽样" }] }] }; } });
  assert.equal(evaluated, 1); assert.equal(answered.handoff!.resolved, true); assert.equal(consultationGate(changed, answered, {}).allowed, true);
});

test("正式返需中的未来输入检查可转入运行时，保留未执行状态但不阻断创建", async () => {
  const deferred = issue({ id: "future_input", question: "未来每次上传的材料是否都能完整读取？" });
  const handoff = { id: "formal_runtime", requirementHash: substantiveRequirementHash(draft()), architectureVersion: 2,
    issues: [deferred], resolved: false };
  const real = scriptedPreflight([await assessmentWith([deferred]), { decisions: [{ issueId: deferred.id, owner: "runtime" as RequirementIssue["owner"], status: "open" as IssueDecision["status"],
    reason: "具体材料尚未出现，使用时检查并如实报告，不能事先要求用户证明所有输入", evidence: [] }] },
  await assessmentWith([{ ...deferred, owner: "runtime" as RequirementIssue["owner"], blocking: false }])]);
  const result = await evaluateConsultation({ draft: draft(), consultation: { ...newConsultation(), handoff }, platform: {},
    requestId: "runtime", preflight: real.preflight });
  assert.equal(result.handoff!.resolved, true); assert.equal(consultationGate(draft(), result, {}).allowed, true);
  const recorded = result.issues.find((entry) => entry.id === deferred.id);
  assert.equal(recorded!.owner!, "runtime"); assert.equal(recorded!.status!, "open"); assert.equal(recorded!.blocking!, false);
});

const verificationFor = (id: string, references: string[]) : SystemCheck => ({ id, status: "verified", message: "指定平台事实已读取，业务验收尚未执行", evidence: references.map((reference) =>
  ({ source: "platform", reference, detail: "只证明受控平台接口和原生限额，专属协议仍需开发及实际验证" })) });

test("当前平台可承载时，独立复核可把未写程序的验收后移并保留正式义务", async () => {
  const technical = issue({ id: "capacity", owner: "system" as RequirementIssue["owner"], stage: "requirements" as NonNullable<RequirementIssue["stage"]>, question: "需要实际验证分段接收和完整输出后才能继续创建吗？",
    checks: ["platform.deliveryRoutes.managedService", "platform.runtime"] });
  const refs = technical.checks;
  const decision = { issueId: technical.id, owner: "system" as RequirementIssue["owner"], stage: "development" as NonNullable<RequirementIssue["stage"]>, status: "open" as IssueDecision["status"], checks: refs,
    reason: "宿主支持受限动作和独立文件状态，可研发分段与完整性协议；原生限额仍保留，完整处理必须开发后真实验收", evidence: [] };
  let checks = 0;
  const real = scriptedPreflight([await assessmentWith([technical]), await assessmentWith([technical]), { decisions: [decision] }, await sufficientPreflight()], {
    verifySystemIssues: async ({ issues }) => { checks++; return issues.map((entry) => verificationFor(entry.id, entry.checks!)); },
  });
  const value = draft(), result = await evaluateConsultation({ draft: value, consultation: newConsultation(), platform: {}, requestId: "staged", preflight: real.preflight });
  assert.equal(real.requests.length, 4); assert.equal(checks, 1); assert.equal(consultationGate(value, result, {}).allowed, true);
  const deferred = currentDeferredIssues!(value, result, {})!.issues[0];
  assert.equal(deferred!.stage!, "development"); assert.equal(deferred!.blocking!, false);
  assert.equal(deferred!.stageDecision!.assessmentId, result.assessments!.at(-1)!.id); assert.equal(deferred!.verification![0]!.id, technical.id);
  assert.deepEqual(deferred!.requirementIds!, technical.requirementIds);
  assert.equal(result.issues!.find((entry) => entry.id === technical.id)!.status, "open");
  const changed = structuredClone(value); changed.task.value += "新增业务";
  assert.throws(() => currentDeferredIssues(changed, result, {}), /过期|通过/);
});

test("旧系统阻断缺少检查引用时，阶段复核可请求第二批受控事实，仍在原六轮预算内", async () => {
  const technical = issue({ id: "delivery_check", owner: "system" as RequirementIssue["owner"], stage: "requirements" as NonNullable<RequirementIssue["stage"]>, question: "尚未写出的动作要在激活前检查实际接口调用" });
  const refs = ["platform.deliveryRoutes.managedService", "platform.runtime"];
  const decision = { issueId: technical.id, owner: "system" as RequirementIssue["owner"], stage: "activation" as NonNullable<RequirementIssue["stage"]>, status: "open" as IssueDecision["status"], checks: refs,
    reason: "平台已有受管调用契约；先开发动作，激活前再核实授权与真实执行，不能声称现在已通过", evidence: [] };
  let checks = 0;
  const real = scriptedPreflight([await assessmentWith([technical]), await assessmentWith([technical]), { decisions: [decision] }, await sufficientPreflight()], {
    verifySystemIssues: async ({ issues }) => { checks++; return issues.map((entry) => entry.checks?.length
      ? verificationFor(entry.id, entry.checks) : { id: entry.id, status: "unknown", message: "缺少具体核实引用", evidence: [] }); },
  });
  const result = await evaluateConsultation({ draft: draft(), consultation: { ...newConsultation(), issues: [{ ...technical, status: "open" as IssueDecision["status"], current: true }] },
    platform: {}, requestId: "old", preflight: real.preflight });
  assert.equal(checks, 2); assert.equal(real.requests.length, 4); assert.equal(consultationGate(draft(), result, {}).allowed, true);
  assert.equal(currentDeferredIssues!(draft(), result, {})!.issues[0]!.stage, "activation");
});

test("真实缺失或未知平台能力不能靠未来阶段、无关问题核实或运行事实绕过", async () => {
  const technical = issue({ id: "missing", owner: "system" as RequirementIssue["owner"], stage: "requirements" as NonNullable<RequirementIssue["stage"]>, question: "当前是否存在必需的外部访问能力？", checks: ["platform.connections"] });
  const decision = { issueId: technical.id, owner: "system" as RequirementIssue["owner"], stage: "development" as NonNullable<RequirementIssue["stage"]>, status: "open" as IssueDecision["status"], checks: technical.checks,
    reason: "未经证实就想把缺口留给后续开发", evidence: [] };
  for (const status of ["unknown", "unavailable"]) {
    const real = scriptedPreflight([await assessmentWith([technical]), await assessmentWith([technical]), { decisions: [decision] }], {
      verifySystemIssues: async () => [{ id: technical.id, status, message: "当前没有足够平台依据", evidence: [] }],
    });
    const result = await evaluateConsultation({ draft: draft(), consultation: newConsultation(), platform: {}, requestId: status, preflight: real.preflight });
    assert.equal(result.assessments!.at(-1)!.failure, "budget_exhausted"); assert.equal(consultationGate(draft(), result, {}).allowed, false);
    assert.equal(real.requests.length, 6);
  }
  for (const proof of [verificationFor("unrelated", technical.checks), { id: technical.id, status: "verified", message: "只知道机器环境", evidence: [
    { source: "runtime", reference: "platform.connections", detail: "机器状态不证明平台连接路径" },
  ] }]) {
    const result = await evaluateConsultation({ draft: draft(), consultation: { ...newConsultation(), issues: [technical] }, platform: {}, requestId: "invalid_proof",
      preflight: async () => ({ ...await sufficientPreflight(), issueDecisions: [decision], systemChecks: [proof] }) });
    assert.equal(result.assessments!.at(-1)!.failure, "preflight_failed");
  }
});

test("模型直接标后续阶段而无独立决定或验收义务时不能确认", async () => {
  const deferred = issue({ owner: "system" as RequirementIssue["owner"], stage: "activation" as NonNullable<RequirementIssue["stage"]>, blocking: false, checks: ["platform.managedRuntime"] });
  const result = await evaluateConsultation({ draft: draft(), consultation: newConsultation(), platform: {}, requestId: "forged_stage",
    preflight: async () => ({ ...await sufficientPreflight(), issues: [deferred], systemChecks: [verificationFor(deferred.id, deferred.checks)] }) });
  assert.equal(result.assessments!.at(-1)!.failure, "preflight_failed"); assert.equal(consultationGate(draft(), result, {}).allowed, false);
});

test("外部资料核实与宿主事实检查共享两次总预算，不靠追加检查次数后移未知", async () => {
  const technical = issue({ id: "shared_budget", owner: "system" as RequirementIssue["owner"], stage: "requirements" as NonNullable<RequirementIssue["stage"]> });
  const decision = { issueId: technical.id, owner: "system" as RequirementIssue["owner"], stage: "development" as NonNullable<RequirementIssue["stage"]>, status: "open" as IssueDecision["status"],
    checks: ["platform.runtime"], reason: "需平台承载事实才能研发后验收", evidence: [] };
  let research = 0, system = 0;
  const real = scriptedPreflight([{ research: { query: "official contract" } }, await assessmentWith([technical]),
    await assessmentWith([technical]), { decisions: [decision] }], {
    research: async () => { research++; return { found: true }; },
    verifySystemIssues: async ({ issues }) => { system++; return issues.map((entry) => ({ id: entry.id,
      status: "unknown", message: "尚未核实具体承载能力", evidence: [] })); },
  });
  await assert.rejects(real.preflight!({ draft: draft(), platform: {}, evidenceMessages: [], previousIssues: [] }), /预算/);
  assert.equal(research, 1); assert.equal(system, 1); assert.equal(research + system, 2); assert.equal(real.requests.length, 6);
});

test("预评估失败保留受控回合与拒绝点诊断，不保存原始输出或污染用户问题", async () => {
  const secret = "do-not-record-raw-model-content";
  const real = scriptedPreflight([{ verdict: "sufficient" as PreflightResponse["verdict"], direction: secret, extra: { token: secret } }]);
  const result = await processTurn(input(), { ...providers(), preflight: real.preflight }, strict);
  const assessment = result.consultation!.assessments.at(-1);
  assert.equal(assessment!.failure!, "budget_exhausted"); assert.equal(objectFields(assessment!.diagnostic!).modelTurns, 6);
  assert.equal(objectFields(assessment!.diagnostic!).readOnlyCalls, 0);
  assert.equal(recordArray(objectFields(assessment!.diagnostic!).events).filter((event) => event.reason === "candidate_shape").length, 6);
  assert.equal(recordArray(objectFields(assessment!.diagnostic!).events).at(-1)!.reason, "budget_exhausted");
  assert.equal(JSON.stringify(assessment).includes(secret), false);
  assert.match(result.question!, /预评估未完成/); assert.doesNotMatch(result.question!, /candidate_shape|modelTurns/);
});

test("阶段核实与问题证据拒绝点有可观察的固定原因和字段路径", async () => {
  const technical = issue({ id: "proof", owner: "system" as RequirementIssue["owner"], stage: "requirements" as NonNullable<RequirementIssue["stage"]>, checks: ["platform.runtime"] });
  const real = scriptedPreflight([await assessmentWith([technical]), await assessmentWith([technical]), { decisions: [{ issueId: "proof", owner: "system" as RequirementIssue["owner"],
    stage: "development" as NonNullable<RequirementIssue["stage"]>, status: "open" as IssueDecision["status"], checks: ["platform.runtime"], reason: "尝试后移未知平台问题", evidence: [] }] }], {
    verifySystemIssues: async () => [{ id: "proof", status: "unknown", message: "internal details never persisted as diagnostic", evidence: [] }],
  });
  const result = await evaluateConsultation({ draft: draft(), consultation: newConsultation(), platform: {}, requestId: "diagnostic", preflight: real.preflight });
  const diagnostic = result.assessments!.at(-1)!.diagnostic;
  assert.equal(objectFields(diagnostic).modelTurns, 6); assert.equal(objectFields(diagnostic).readOnlyCalls, 1); assert.equal(objectFields(diagnostic).systemVerificationCalls, 1);
  const rejection = recordArray(objectFields(diagnostic).events).find((event) => event.reason === "stage_evidence_missing");
  assert.deepEqual(rejection!.paths, ["decisions[].checks", "systemChecks"]); assert.deepEqual(rejection!.issueIds, ["proof"]);
  assert.equal(JSON.stringify(diagnostic).includes("internal details"), false);
});

test("失败诊断序列化只保留受控字段，非法事件或原始参数不会进入记录", () => {
  const secret = "raw-auth-and-model-text";
  const diagnostic = safePreflightDiagnostic({ version: 1, modelTurns: 6, readOnlyCalls: 2, researchCalls: 1, systemVerificationCalls: 1,
    raw: secret, events: [null, { turn: 6, role: secret, reason: secret, paths: [secret, "issues"], issueIds: ["invalid id\n" + secret], parameters: { value: secret } }] });
  assert.deepEqual(diagnostic!.events!, [{ turn: 6, role: "controller", reason: "validation_rejected", paths: ["issues"], issueIds: [] }]);
  assert.equal(JSON.stringify(diagnostic).includes(secret), false);
});

test("真实模型把checks误提交为对象数组时，精确反馈引导下一回合修正后成功", async () => {
  const technical = issue({ id: "precise_checks", owner: "system" as RequirementIssue["owner"], stage: "requirements" as NonNullable<RequirementIssue["stage"]>, checks: ["platform.deliveryRoutes.managedService", "platform.runtime"] });
  const decision = { issueId: technical.id, owner: "system" as RequirementIssue["owner"], stage: "development" as NonNullable<RequirementIssue["stage"]>, status: "open" as IssueDecision["status"], checks: technical.checks,
    reason: "平台承载路径已核实，专属动作必须在研发阶段真实验证", evidence: [] };
  const malformed = { ...decision, checks: technical.checks.map((check) => ({ check, support: "应写进reason的说明" })) };
  const real = scriptedPreflight([await assessmentWith([technical]), await assessmentWith([technical]), { decisions: [malformed] },
    { decisions: [decision] }, await sufficientPreflight()], {
    verifySystemIssues: async ({ issues }) => issues.map((entry) => verificationFor(entry.id, entry.checks!)),
  });
  const result = await evaluateConsultation({ draft: draft(), consultation: newConsultation(), platform: {}, requestId: "typed_checks", preflight: real.preflight });
  assert.equal(consultationGate(draft(), result, {}).allowed, true); assert.equal(real.requests.length, 5);
  const repair = real.requests[3]!.messages.at(-1)!.content;
  assert.match(repair, /checks必须是字符串数组/); assert.match(repair, /support等解释写入reason字符串/);
  assert.ok(repair.includes('["platform.deliveryRoutes.managedService","platform.runtime"]'));
  assert.ok(repair.includes("runtime.managed.python"));
  assert.deepEqual(result.assessments!.at(-1)!.deferredIssues![0]!.checks, technical.checks);
});

function generatedWithReference(quote: string) {
  const value = draft();
  value.taskSpec.items.push({ id: "ts-delivery-shapes", dimension: "delivery", content: "CSV使用UTF-8并包含固定表头", applicability: "applies", critical: true,
    source: { kind: "user", evidence: [{ messageId: "original", quote }] } });
  return { draft: value, proposedGap: "none", question: "", confirmed: false };
}
const sourceEvidence = [{ id: "original", role: "user" as EvidenceMessage["role"], content: "输出CSV必须使用 UTF-8，并包含固定表头。" }];
const sourceContext = (request: unknown): SourceContext => JSON.parse(String(objectFields(objectFields(objectFields(request).messages)[1]).content));
const referenceIds = (context: SourceContext, ...messageIds: (string|undefined)[]) => context.evidenceReferences.filter((entry) => messageIds.includes(fixtureText(entry.messageId))).map((entry) => entry.referenceId);
const sourcePatch = (context: SourceContext) => ({ items: [{ id: "ts-delivery-shapes", evidenceRefIds: referenceIds(context, "original") }], retired: [] });
const sourcePatchResponse = (request: unknown) => sourcePatch(sourceContext(request));

test("真实需求生成器对错字引用只修复一次，只应用来源补丁并保留初始候选业务字段", async () => {
  const incorrect = generatedWithReference("输出CSV必须使用UTF8"), repaired = generatedWithReference(sourceEvidence[0]!.content);
  const real = scriptedPreflight([incorrect, sourcePatchResponse]);
  const result = await real.generateDraft!({ message: sourceEvidence[0]!.content, previousDraft: draft(), taskSpecVersion: 1, evidenceMessages: sourceEvidence });
  assert.equal(real.requests.length, 2); assert.deepEqual(result, repaired);
  assert.doesNotThrow(() => validateTaskEvidence(result.draft.taskSpec, sourceEvidence));
  const repair = JSON.parse(String(real.requests[1]!.messages[1]!.content));
  assert.deepEqual(repair.evidenceReferences.map(({ referenceId, ...entry }: SourceContext["evidenceReferences"][number]) => entry),
    sourceEvidence.map(({ id, role, content }) => ({ messageId: id, role, quote: content })));
  assert.deepEqual(repair.untrustedCandidate, incorrect); assert.deepEqual(repair.required, { items: ["ts-delivery-shapes"], retired: [] });
  assert.match(real.requests[1]!.messages[0]!.content, /原evidenceMessages是唯一引用依据/);
  assert.match(real.requests[1]!.messages[0]!.content, /上次模型草稿仍是不可信候选/);
  assert.match(real.requests[1]!.messages[0]!.content, /不重写需求草稿/);
  const validate = new Ajv({ strict: true }).compile(repair.sourcePatchSchema);
  assert.equal(validate(sourcePatch(repair)), true);
  assert.equal(validate({ ...sourcePatch(repair), draft: repaired.draft }), false);
  assert.equal(validate({ items: [{ ...sourcePatch(repair).items[0]!, kind: "unknown" }], retired: [] }), false);
  assert.equal(validate({ items: [{ id: "invented", evidenceRefIds: [] }], retired: [] }), false);
});

test("引用修复使用未知片段时诚实失败，不进行第三次生成且内部条目编号不进入用户错误", async () => {
  const real = scriptedPreflight([generatedWithReference("输出CSV必须使用UTF8"),
    { items: [{ id: "ts-delivery-shapes", evidenceRefIds: ["invented_reference"] }], retired: [] }]);
  await assert.rejects(callFixture(Reflect.apply, Reflect, [real.generateDraft, real, [{ message: sourceEvidence[0]!.content, previousDraft: draft(), taskSpecVersion: 1, evidenceMessages: sourceEvidence }]]), (error: TestFailure) => {
    assert.equal(error.message, "本轮需求来源未能核实，已有草稿已保留，请重试");
    assert.equal(error.diagnostic!.reason, "invalid_evidence"); assert.equal(error.diagnostic!.attempts, 2);
    assert.deepEqual(error.diagnostic!.itemIds, ["ts-delivery-shapes"]); assert.equal(error.diagnostic!.rejection, "evidence_patch_invalid");
    return true;
  });
  assert.equal(real.requests.length, 2);
});

test("来源补丁拒绝业务字段、kind变化、重复或未知id、缺失修复，不允许绕过校验", async () => {
  for (const [mutate, rejection] of [
    [(value: { items: never[]; }) => { value.items = []; }, "evidence_patch_missing"],
    [(value: { items: { critical: boolean; }[]; }) => { value.items![0]!.critical = false; }, "evidence_patch_invalid"],
    [(value: { draft: { task: { value: string; }; }; }) => { value.draft = { task: { value: "只处理样本即可" } }; }, "evidence_patch_invalid"],
    [(value: { items: { kind: string; }[]; }) => { value.items![0]!.kind = "unknown"; }, "evidence_patch_invalid"],
    [(value: { items: { source: { kind: string; evidence: { messageId: string; quote: string }[]; }; }[]; }) => { value.items![0]!.source = { kind: "unknown", evidence: [] as { messageId: string; quote: string }[] }; }, "evidence_patch_invalid"],
    [(value: { items: { reason: string; }[]; }) => { value.items![0]!.reason = "不能修改非推导来源说明"; }, "evidence_patch_invalid"],
    [(value: { items: unknown[]; }) => { value.items.push(structuredClone(value.items[0])); }, "evidence_patch_invalid"],
    [(value: { items: { id: string; }[]; }) => { value.items![0]!.id = "unknown"; }, "evidence_patch_invalid"],
    [(value: { items: { evidenceRefIds: never[]; }[]; }) => { value.items![0]!.evidenceRefIds = []; }, "evidence_patch_invalid"],
    [(value: { items: { evidenceRefIds: unknown[]; }[]; }) => { value.items[0]!.evidenceRefIds.push(value.items[0]!.evidenceRefIds[0]); }, "evidence_patch_invalid"],
    [(value: { items: { evidenceRefIds: string[]; }[]; }) => { value.items![0]!.evidenceRefIds[0] = "invented"; }, "evidence_patch_invalid"],
    [(value: { items: { evidenceRefIds: unknown[]; }[]; }) => { value.items[0]!.evidenceRefIds[0] = { referenceId: value.items[0]!.evidenceRefIds[0] }; }, "evidence_patch_invalid"],
    [(value: { items: { evidence: { messageId: string; quote: string; }[]; }[]; }) => { value.items![0]!.evidence = [{ messageId: "original", quote: "自造引用" }]; }, "evidence_patch_invalid"],
    [(value: { retired: unknown; }) => { Reflect.deleteProperty(value, "retired"); }, "evidence_patch_invalid"],
  ] as const) {
    const real = scriptedPreflight([generatedWithReference("输出CSV必须使用UTF8"), (request: unknown) => {
      const patch = sourcePatchResponse(request); callFixture(mutate!, undefined, [patch]); return patch;
    }]);
    await assert.rejects(callFixture(Reflect.apply, Reflect, [real.generateDraft, real, [{ message: sourceEvidence[0]!.content, previousDraft: draft(), taskSpecVersion: 1, evidenceMessages: sourceEvidence }]]),
      (error: TestFailure) => error.message === "本轮需求来源未能核实，已有草稿已保留，请重试"
        && error.diagnostic?.reason === "invalid_evidence" && error.diagnostic.rejection === rejection);
    assert.equal(real.requests.length, 2);
  }
});

test("来源补丁同时核实用户接受、实际测量、推导与退休证据，保留各种来源kind及退休说明", async () => {
  const initial = generatedWithReference("输出CSV必须使用 UTF-8");
  const evidenceMessages = [...sourceEvidence, { id: "suggestion", role: "assistant" as EvidenceMessage["role"], content: "建议逐项保留检查状态" },
    { id: "acceptance", role: "user" as EvidenceMessage["role"], content: "同意逐项保留检查状态，不再生成PDF" },
    { id: "measurement", role: "measurement" as EvidenceMessage["role"], content: "实际资料共20份" }];
  const extra = (id: string, kind: TaskSpecV1["items"][number]["source"]["kind"], evidence: { messageId: string; quote: string; }[]) : TaskSpecV1["items"][number] => ({ id, dimension: "processing", content: "业务承诺保持", applicability: "applies", critical: true,
    source: { kind, evidence, ...(kind === "inferred" ? { reason: "从原文直接推导" } : {}) } });
  initial.draft.taskSpec.items.push(extra("accepted", "accepted", [{ messageId: "suggestion", quote: "逐项保留检查状态" }, { messageId: "acceptance", quote: "我同意" }]),
    extra("measured", "measured", [{ messageId: "measurement", quote: "实际资料共二十份" }]),
    extra("inferred", "inferred", [{ messageId: "original", quote: "使用UTF8" }]));
  initial.draft.taskSpec.retired = [{ id: "old_pdf", reason: "用户取消PDF，业务说明不可改", evidence: [{ messageId: "acceptance", quote: "不用生成PDF" }] }];
  const patch = (context: SourceContext) => ({ items: [
    { id: "accepted", evidenceRefIds: referenceIds(context, "suggestion", "acceptance") },
    { id: "measured", evidenceRefIds: referenceIds(context, "measurement") },
    { id: "inferred", evidenceRefIds: referenceIds(context, "original"), reason: "固定表头要求意味着输出字段一致" },
  ], retired: [{ id: "old_pdf", evidenceRefIds: referenceIds(context, "acceptance") }] });
  const real = scriptedPreflight([initial, (request: { messages: { content: string; }[]; }) => patch(sourceContext(request))]);
  const result = await real.generateDraft!({ message: evidenceMessages[2]!.content, previousDraft: draft(), taskSpecVersion: 1, evidenceMessages });
  assert.doesNotThrow(() => validateTaskEvidence(objectFields(result.draft).taskSpec, evidenceMessages));
  assert.deepEqual(recordArray(objectFields(objectFields(result.draft).taskSpec).items).map((item) => objectFields(item.source).kind), ["user", "accepted", "measured", "inferred"]);
  assert.equal(objectFields(objectFields(objectFields(objectFields(result.draft).taskSpec).retired)[0]).reason, initial.draft!.taskSpec.retired[0]!.reason);
  const repair = sourceContext(real.requests[1]!), actualPatch = patch(repair);
  assert.equal(objectFields(objectFields(objectFields(objectFields(objectFields(result.draft).taskSpec).items)[3]).source).reason, actualPatch.items![2]!.reason);
  assert.equal(new Ajv({ strict: true }).compile(repair.sourcePatchSchema)(actualPatch), true);
});

test("宿主片段原样保留引号空格换行和Unicode，长测量分片不截断字符或改变业务候选", async () => {
  const content = `${"测".repeat(3999)}😀\n  “总数” = 20；CSV 字段为 \"count\"。`;
  const evidenceMessages = [{ id: "measurement", role: "measurement" as EvidenceMessage["role"], content }];
  const initial = generatedWithReference("不是原文");
  initial.draft!.taskSpec.items[0]!.source.kind = "measured";
  const before = structuredClone(initial);
  const real = scriptedPreflight([initial, (request: { messages: { content: string; }[]; }) => ({ items: [{ id: "ts-delivery-shapes",
    evidenceRefIds: referenceIds(sourceContext(request), "measurement") }], retired: [] })]);
  const result = await real.generateDraft!({ message: "按实际测量处理", previousDraft: draft(), taskSpecVersion: 1, evidenceMessages });
  const references = sourceContext(real.requests[1]!).evidenceReferences;
  assert.ok(references.length >= 2); assert.equal(references.map((entry) => entry.quote).join(""), content);
  assert.ok(references.every((entry) => entry.quote.length <= 4000 && entry.quote.isWellFormed()));
  assert.equal(recordArray(objectFields(objectFields(objectFields(objectFields(objectFields(result.draft).taskSpec).items)[0]).source).evidence).map((entry) => entry.quote).join(""), content);
  assert.doesNotThrow(() => validateTaskEvidence(objectFields(result.draft).taskSpec, evidenceMessages));
  const restored = structuredClone(result); objectFields(objectFields(objectFields(objectFields(objectFields(restored.draft).taskSpec).items)[0]).source).evidence = before.draft!.taskSpec.items[0]!.source.evidence;
  assert.deepEqual(restored, before); assert.deepEqual(initial, before);
});

test("证据目录优先原始段句边界，可独立选择用户修订而不混入旧句，编号不随消息顺序变化", async () => {
  const evidenceMessages = [{ id: "user", role: "user" as EvidenceMessage["role"], content: "先考虑只做摘要。\n\n  改为逐项检查，不要抽样！ 最后输出 CSV。" },
    { id: "assistant", role: "assistant" as EvidenceMessage["role"], content: "建议只做摘要。" }];
  const catalog: SourceContext["evidenceReferences"][] = [];
  for (const messages of [evidenceMessages, [...evidenceMessages].reverse()]) {
    const real = scriptedPreflight([generatedWithReference("不是原文"), (request: { messages: { content: string; }[]; }) => {
      const context = sourceContext(request);
      const reference = context.evidenceReferences.find((entry) => entry.messageId === "user" && entry.quote.includes("改为逐项检查"));
      assert.equal(reference!.quote, "\n\n  改为逐项检查，不要抽样！");
      assert.equal(reference!.quote.includes("只做摘要"), false);
      catalog.push(context.evidenceReferences);
      return { items: [{ id: "ts-delivery-shapes", evidenceRefIds: [reference!.referenceId] }], retired: [] };
    }]);
    const result = await real.generateDraft!({ message: "改为逐项检查", previousDraft: draft(), taskSpecVersion: 1, evidenceMessages: messages });
    assert.deepEqual(objectFields(objectFields(objectFields(objectFields(objectFields(result.draft).taskSpec).items)[0]).source).evidence, [{ messageId: "user", quote: "\n\n  改为逐项检查，不要抽样！" }]);
  }
  const byId = (entries: SourceContext["evidenceReferences"]) => entries.toSorted((left, right) => left.referenceId.localeCompare(right.referenceId));
  assert.deepEqual(byId(catalog[0]!), byId(catalog[1]!));
});

test("来源片段角色不能越权，接受建议须双角色，schema和实际应用共同拒绝且不增加调用", async () => {
  const evidenceMessages = [{ id: "user", role: "user" as EvidenceMessage["role"], content: "同意生成清单，不再生成PDF" },
    { id: "assistant", role: "assistant" as EvidenceMessage["role"], content: "建议生成清单" }, { id: "measurement", role: "measurement" as EvidenceMessage["role"], content: "实际20项" }];
  for (const [kind, selected] of [["user", "assistant"], ["measured", "user"], ["accepted", "user"], ["accepted", "assistant"], ["retired", "assistant"]] as const) {
    const initial = generatedWithReference("不是原文");
    if (kind === "retired") {
      initial.draft.taskSpec.items = [];
      initial.draft.taskSpec.retired = [{ id: "old_pdf", reason: "用户取消PDF", evidence: [{ messageId: "user", quote: "不是原文" }] }];
    } else initial.draft!.taskSpec.items[0]!.source.kind = kind;
    const before = structuredClone(initial);
    const real = scriptedPreflight([initial, (request: { messages: { content: string; }[]; }) => {
      const context = sourceContext(request), entry = { id: kind === "retired" ? "old_pdf" : "ts-delivery-shapes", evidenceRefIds: referenceIds(context, selected) };
      const patch = kind === "retired" ? { items: [], retired: [entry] } : { items: [entry], retired: [] };
      assert.equal(new Ajv({ strict: true }).compile(context.sourcePatchSchema)(patch), false);
      return patch;
    }]);
    await assert.rejects(callFixture(Reflect.apply, Reflect, [real.generateDraft, real, [{ message: evidenceMessages[0]!.content, previousDraft: draft(), taskSpecVersion: 1, evidenceMessages }]]),
      (error: TestFailure) => error.diagnostic?.reason === "invalid_evidence" && error.diagnostic.rejection === "evidence_patch_invalid");
    assert.equal(real.requests.length, 2); assert.deepEqual(initial, before);
  }
});

test("来源片段选取成功仍须独立需求复核，不能把引用存在当成业务已确认", async () => {
  const initial = generatedWithReference("输出CSV必须使用UTF8");
  const real = scriptedPreflight([initial, sourcePatchResponse]);
  let reviewed = 0;
  const result = await processTurn({ message: sourceEvidence[0]!.content, draft: draft(), evidenceMessages: sourceEvidence }, {
    ...real,
    preflight: async ({ draft: candidate }) => {
      reviewed++;
      assert.doesNotThrow(() => validateTaskEvidence(candidate.taskSpec, sourceEvidence));
      return assessmentWith([issue({ id: "semantic_scope", question: "这些字段是否覆盖你需要的全部结果？" })]);
    },
  }, strict);
  assert.equal(real.requests.length, 2); assert.equal(reviewed, 1);
  assert.equal(result.confirmed, false); assert.equal(result.confirmationGate!.reason, "needs_input");
});

test("真实owner阶段阻断矩阵误提交收到精确反馈后修正，不删除当前真实缺口", async () => {
  const missing = issue({ id: "I2", owner: "system" as RequirementIssue["owner"], stage: "development" as NonNullable<RequirementIssue["stage"]>, blocking: true });
  const activation = issue({ id: "I3", owner: "runtime" as RequirementIssue["owner"], stage: "activation" as NonNullable<RequirementIssue["stage"]>, blocking: false });
  const malformed = { ...await sufficientPreflight(), verdict: "blocked" as PreflightResponse["verdict"], issues: [missing, activation] };
  const corrected = { ...await sufficientPreflight(), verdict: "blocked" as PreflightResponse["verdict"], issues: [
    { ...missing, stage: "requirements" as NonNullable<RequirementIssue["stage"]> }, { ...activation, stage: "runtime" as NonNullable<RequirementIssue["stage"]> },
  ] };
  const real = scriptedPreflight([malformed, corrected, { decisions: [{ issueId: "I2", owner: "system" as RequirementIssue["owner"], stage: "requirements" as NonNullable<RequirementIssue["stage"]>, status: "open" as IssueDecision["status"],
    reason: "当前平台缺口尚未核实，保留原问题", evidence: [] }] }]);
  const result = await evaluateConsultation({ draft: draft(), consultation: newConsultation(), platform: {}, requestId: "matrix", preflight: real.preflight });
  assert.equal(real.requests.length, 3); assert.equal(result.assessments!.at(-1)!.verdict, "blocked");
  const repair = real.requests[1]!.messages.at(-1)!.content;
  assert.match(repair, /user只能stage=requirements/); assert.match(repair, /runtime只能stage=runtime且blocking=false/);
  assert.match(repair, /stage=development、activation、runtime时必须blocking=false/);
  assert.match(repair, /needs_input至少有一条user且blocking=true/); assert.match(repair, /blocked至少有一条system且blocking=true/);
  assert.deepEqual(result.assessments!.at(-1)!.issues!.map((entry) => entry.id), ["I2", "I3"]);
  assert.equal(consultationGate(draft(), result, {}).allowed, false);
});

test("系统平台引用误当消息证据时，明确两通道反馈后修正，动态schema排除伪造来源", async () => {
  const technical = issue({ id: "channels", owner: "system" as RequirementIssue["owner"], stage: "requirements" as NonNullable<RequirementIssue["stage"]>, checks: ["platform.runtime"] });
  const decision = { issueId: technical.id, owner: "system" as RequirementIssue["owner"], status: "open" as IssueDecision["status"], stage: "development" as NonNullable<RequirementIssue["stage"]>, checks: technical.checks,
    reason: "已有合法平台通道，代码仍须开发验收", evidence: [] };
  const malformed = { ...decision, evidence: [{ messageId: "platform.runtime", quote: "不是消息原文的系统事实" }] };
  const evidenceMessages = [{ id: "actual_user", role: "user" as EvidenceMessage["role"], content: "每项都要检查" },
    { id: "actual_measurement", role: "measurement" as EvidenceMessage["role"], content: "实际输入共二十项" }, { id: "assistant_proposal", role: "assistant" as EvidenceMessage["role"], content: "建议抽样" }];
  const real = scriptedPreflight([await assessmentWith([technical]), await assessmentWith([technical]), { decisions: [malformed] },
    { decisions: [decision] }, await sufficientPreflight()], {
    verifySystemIssues: async ({ issues }) => issues.map((entry) => verificationFor(entry.id, entry.checks!)),
  });
  const result = await evaluateConsultation({ draft: draft(), consultation: { ...newConsultation(), evidenceMessages }, platform: {},
    requestId: "two_channels", preflight: real.preflight });
  assert.equal(consultationGate(draft(), result, {}).allowed, true); assert.equal(real.requests.length, 5);
  const repair = real.requests[3]!.messages.at(-1)!.content;
  assert.match(repair, /系统问题owner=system/); assert.match(repair, /evidence必须是\[\]/);
  assert.match(repair, /platform路径、systemChecks条目、check引用、issueId均不是用户消息messageId/);
  const schema = JSON.parse(String(real.requests[2]!.messages[1]!.content)).decisionSchema;
  const validate = new Ajv({ strict: true }).compile(schema);
  assert.equal(validate({ decisions: [decision] }), true);
  assert.equal(validate({ decisions: [malformed] }), false);
  const user = { ...decision, owner: "user" as RequirementIssue["owner"], stage: "requirements" as NonNullable<RequirementIssue["stage"]>, status: "resolved" as IssueDecision["status"], evidence: [{ messageId: "actual_user", quote: "每项都要检查" }] };
  Reflect.deleteProperty(user, "checks");
  assert.equal(validate({ decisions: [user] }), true);
  assert.equal(validate({ decisions: [{ ...user, evidence: [] }] }), false);
  assert.equal(validate({ decisions: [{ ...user, evidence: [{ messageId: "assistant_proposal", quote: "建议抽样" }] }] }), false);
  assert.equal(validate({ decisions: [{ ...user, issueId: "invented" }] }), false);
});

test("用户已解决问题必须保留真实消息引用，平台路径不得冒充messageId或被自动修正", async () => {
  const decided = { issueId: "choice", owner: "user" as RequirementIssue["owner"], stage: "requirements" as NonNullable<RequirementIssue["stage"]>, status: "resolved" as IssueDecision["status"], reason: "用户明确全量处理",
    evidence: [{ messageId: "actual_user", quote: "逐项完整检查" }] };
  const malformed = { ...decided, evidence: [{ messageId: "platform.runtime", quote: "逐项完整检查" }] };
  const real = scriptedPreflight([await assessmentWith([issue()]), { decisions: [malformed] }, { decisions: [decided] }, await sufficientPreflight()]);
  const result = await evaluateConsultation({ draft: draft(), consultation: { ...newConsultation(), evidenceMessages: [
    { id: "actual_user", role: "user" as EvidenceMessage["role"], content: "必须逐项完整检查所有材料" },
  ] }, platform: {}, requestId: "user_evidence", preflight: real.preflight });
  assert.equal(consultationGate(draft(), result, {}).allowed, true); assert.equal(real.requests.length, 4);
  const repair = real.requests[2]!.messages.at(-1)!.content;
  assert.match(repair, /不能通过清空用户resolved的evidence逃过核验/);
  assert.ok(repair.includes('["actual_user"]'));
  assert.deepEqual(result.assessments!.at(-1)!.issueDecisions![0]!.evidence, decided.evidence);
});

test("预评估首次即提供完整动态schema，需求编号与最终校验同源，阶段与核实规则保持严格", async () => {
  const value = draft();
  value.constraints = [{ value: "保留全部记录", source: "user" }]; Reflect.set(value, "capabilityDependencies", [{ id: "files" }]);
  Reflect.set(value, "interaction", { operations: [{ id: "summarize" }] }); Reflect.set(value, "connections", [{ id: "local" }]);
  value.taskSpec.items = [{ id: "stable_scope", dimension: "processing", content: "逐项核对", applicability: "applies", critical: true,
    source: { kind: "user", evidence: [{ messageId: "u", quote: "逐项核对" }] } }];
  const real = scriptedPreflight([await sufficientPreflight()]);
  await real.preflight!({ draft: value, platform: {} });
  const initialContext = JSON.parse(String(real.requests[0]!.messages[1]!.content));
  assert.deepEqual(initialContext.allowedRequirementIds, preflightRequirementIds(value));
  assert.deepEqual(initialContext.preflightSchema, preflightSchema(value));
  const validIds = ["routingCondition", "constraint_1", "capability_1", "operation_1", "connection_1", "stable_scope", `spec_${contentHash("stable_scope").slice(0, 24)}`];
  const validate = new Ajv({ strict: true }).compile(initialContext.preflightSchema);
  const assessment = await sufficientPreflight(); assessment.dimensionChecks![0]!.requirementIds = validIds;
  assert.equal(validate(assessment), true); assert.doesNotThrow(() => validatePreflight(assessment, value));
  for (const invalid of [
    { owner: "runtime" as RequirementIssue["owner"], stage: "activation" as NonNullable<RequirementIssue["stage"]>, blocking: false },
    { owner: "system" as RequirementIssue["owner"], stage: "development" as NonNullable<RequirementIssue["stage"]>, blocking: true },
    { owner: "user" as RequirementIssue["owner"], stage: "requirements" as NonNullable<RequirementIssue["stage"]>, blocking: false, checks: ["platform.runtime"] },
    { owner: "system" as RequirementIssue["owner"], stage: "requirements" as NonNullable<RequirementIssue["stage"]>, blocking: false, checks: [{ check: "platform.runtime" }] },
  ]) {
    const result = { ...assessment, verdict: invalid.blocking ? "blocked" : "sufficient", issues: [issue(invalid)] };
    assert.equal(validate(result), false); assert.throws(() => validatePreflight(result, value));
  }
  const technical = { ...assessment, verdict: "blocked" as PreflightResponse["verdict"], issues: [issue({ owner: "system" as RequirementIssue["owner"], stage: "requirements" as NonNullable<RequirementIssue["stage"]>, checks: ["platform.runtime"] })] };
  assert.equal(validate(technical), true); assert.doesNotThrow(() => validatePreflight(technical, value));
  assert.equal(validate({ ...technical, verdict: "sufficient" as PreflightResponse["verdict"] }), false);
});

test("维度名称、状态、引用或重复维度错误得到精确反馈，下一轮修复不增加预算或改业务", async () => {
  for (const mutate of [
    (checks: { dimension: string; }[]) => { checks[0]!.dimension = "输入与规模"; },
    (checks: { status: string; }[]) => { checks[0]!.status = "ready"; },
    (checks: { requirementIds: string[]; }[]) => { checks[0]!.requirementIds = ["platform.runtime"]; },
    (checks: { requirementIds: never[]; }[]) => { checks[0]!.requirementIds = []; },
    (checks: { dimension: unknown; }[]) => { checks[0]!.dimension = checks[1]!.dimension; },
  ]) {
    const correct = await sufficientPreflight(), incorrect = structuredClone(correct); callFixture(mutate, undefined, [incorrect.dimensionChecks]);
    const real = scriptedPreflight([incorrect, correct]);
    const result = await real.preflight!({ draft: draft(), platform: {} });
    assert.equal(result.verdict, "sufficient"); assert.equal(real.requests.length, 2);
    assert.equal(objectFields(result.preflightDiagnostic).readOnlyCalls, 0);
    assert.equal(objectFields(objectFields(objectFields(result.preflightDiagnostic).events)[0]).reason, "dimension_check_invalid");
    const repair = real.requests[1]!.messages.at(-1)!.content;
    assert.ok(repair.includes(JSON.stringify(TASK_DIMENSIONS))); assert.ok(repair.includes('["sufficient","not_applicable","unknown"]'));
    assert.ok(repair.includes(JSON.stringify(preflightRequirementIds(draft()))));
    assert.match(repair, /每个准确出现一次/); assert.match(repair, /status=sufficient必须至少引用一个有效编号/);
    assert.match(repair, /保留真实问题和业务承诺/);
    const schema = JSON.parse(String(real.requests[0]!.messages[1]!.content)).preflightSchema;
    const validate = new Ajv({ strict: true }).compile(schema);
    assert.equal(validate(incorrect), false); assert.equal(validate(correct), true);
  }
});

test("非阻断系统事项省略阶段会被精确拒绝，补activation后即使候选漏列也保留独立验收交接", async () => {
  const technical = issue({ id: "activation_obligation", owner: "system" as RequirementIssue["owner"], stage: "activation" as NonNullable<RequirementIssue["stage"]>, blocking: false,
    question: "激活前配置并真实调用接口，不能以平台存在等同验收通过", checks: ["platform.deliveryRoutes.managedService"] });
  const omitted = { ...technical }; Reflect.deleteProperty(omitted, "stage");
  const decision = { issueId: technical.id, owner: "system" as RequirementIssue["owner"], stage: "activation" as NonNullable<RequirementIssue["stage"]>, status: "open" as IssueDecision["status"], checks: technical.checks,
    reason: "已核实可承载，真实配置和调用仍未执行，进入激活验收", evidence: [] };
  const real = scriptedPreflight([await assessmentWith([omitted]), await assessmentWith([technical]), await sufficientPreflight(), { decisions: [decision] }], {
    verifySystemIssues: async ({ issues }) => issues.map((entry) => verificationFor(entry.id, entry.checks!)),
  });
  const result = await evaluateConsultation({ draft: draft(), consultation: newConsultation(), platform: {}, requestId: "explicit-stage", preflight: real.preflight });
  assert.equal(real.requests.length, 4); assert.equal(consultationGate(draft(), result, {}).allowed, true);
  assert.match(real.requests[1]!.messages.at(-1)!.content, /每个system问题和决定必须显式stage/);
  assert.equal(result.assessments!.at(-1)!.systemReviewVersion, 1);
  const deferred = currentDeferredIssues!(draft(), result, {})!.issues[0];
  assert.equal(deferred!.stage!, "activation"); assert.equal(deferred!.id!, technical.id);
  assert.equal(result.issues!.find((entry) => entry.id === technical.id)!.status, "open");
  assert.equal(deferred!.stageDecision!.assessmentId, result.assessments!.at(-1)!.id);
  const schema = JSON.parse(String(real.requests[0]!.messages[1]!.content)).preflightSchema;
  assert.equal(new Ajv({ strict: true }).compile(schema)(await assessmentWith([omitted])), false);
});

test("系统事实verified既不能代替独立决定，也不能把既定未来验收改名为当前事实后关闭", async () => {
  const technical = issue({ id: "future_check", owner: "system" as RequirementIssue["owner"], stage: "activation" as NonNullable<RequirementIssue["stage"]>, blocking: false, checks: ["platform.managedRuntime"] });
  const previous = { ...newConsultation(), issues: [{ ...technical, status: "open" as IssueDecision["status"], current: true }] };
  for (const response of [
    { ...await sufficientPreflight(), systemChecks: [verificationFor(technical.id, technical.checks)] },
    { ...await assessmentWith([technical]), systemChecks: [verificationFor(technical.id, technical.checks)] },
    { ...await assessmentWith([technical]), systemChecks: [verificationFor(technical.id, technical.checks)], issueDecisions: [{ issueId: technical.id,
      owner: "system" as RequirementIssue["owner"], status: "open" as IssueDecision["status"], checks: technical.checks, reason: "省略阶段也不能绕过", evidence: [] }] },
    { ...await sufficientPreflight(), systemChecks: [verificationFor(technical.id, technical.checks)], issueDecisions: [{ issueId: technical.id,
      owner: "system" as RequirementIssue["owner"], stage: "requirements" as NonNullable<RequirementIssue["stage"]>, status: "resolved" as IssueDecision["status"], checks: technical.checks, reason: "只用平台存在冒充未来激活已通过", evidence: [] }] },
  ]) {
    const result = await evaluateConsultation({ draft: draft(), consultation: previous, platform: {}, requestId: "no-blanket-close", preflight: async () => response });
    assert.equal(result.assessments!.at(-1)!.failure, "preflight_failed"); assert.equal(result.issues![0]!.status, "open");
    assert.equal(consultationGate(draft(), result, {}).allowed, false);
  }
});

test("旧无阶段记录保持只读兼容且不改指纹，新继续请求补一次新评估而原请求重放幂等", async () => {
  const value = draft(), technical = issue({ owner: "system" as RequirementIssue["owner"], blocking: false });
  const legacy = { ...await sufficientPreflight(), id: "legacy", requestId: "old-request", requirementHash: substantiveRequirementHash(value),
    platformHash: contentHash({}), evidenceHash: contentHash([]), issues: [technical] };
  const consultation = { ...newConsultation(), assessments: [legacy] }, original = structuredClone(consultation);
  assert.equal(consultationGate(value, consultation, {}).allowed, true); assert.deepEqual(consultation, original);
  assert.throws(() => validatePreflight(legacy, value), /系统问题必须明确/);
  let calls = 0;
  const preflight = async () => { calls++; return sufficientPreflight(); };
  const replay = await evaluateConsultation({ draft: value, consultation, platform: {}, requestId: "old-request", preflight });
  assert.equal(calls, 0); assert.deepEqual(replay, consultation);
  const continued = await evaluateConsultation({ draft: value, consultation, platform: {}, requestId: "new-request", preflight });
  assert.equal(calls, 1); assert.equal(continued.assessments!.at(-1)!.systemReviewVersion, 1);
  assert.equal(continued.assessments![0]!.requirementHash, legacy.requirementHash);
  assert.deepEqual(continued.assessments[0], legacy);
  await evaluateConsultation({ draft: value, consultation: continued, platform: {}, requestId: "another-request", preflight });
  assert.equal(calls, 1);
});

test("旧系统问题无stage继续时由独立决定补齐阶段，不修改原始问题记录", async () => {
  const original = issue({ id: "old_system", owner: "system" as RequirementIssue["owner"], blocking: false, checks: ["platform.managedRuntime"] });
  const previous = { ...newConsultation(), issues: [{ ...original, status: "open" as IssueDecision["status"], current: true }] };
  const decision = { issueId: original.id, owner: "system" as RequirementIssue["owner"], stage: "activation" as NonNullable<RequirementIssue["stage"]>, status: "open" as IssueDecision["status"], checks: original.checks,
    reason: "旧记录没有阶段；独立复核确认平台承载，实际启动留待激活验收", evidence: [] };
  const real = scriptedPreflight([await sufficientPreflight(), await sufficientPreflight(), { decisions: [decision] }], {
    verifySystemIssues: async ({ issues }) => issues.map((entry) => verificationFor(entry.id, entry.checks!)),
  });
  const result = await evaluateConsultation({ draft: draft(), consultation: previous, platform: {}, requestId: "old-system-continue", preflight: real.preflight });
  assert.equal(consultationGate(draft(), result, {}).allowed, true); assert.equal(real.requests.length, 3);
  assert.equal(currentDeferredIssues!(draft(), result, {})!.issues[0]!.stage, "activation");
  assert.equal(previous.issues![0]!.stage, undefined); assert.equal(previous.issues![0]!.status, "open");
});

test("本轮独立解决的非阻断历史投影出待解决列表，不耗修复回合且完整保存台账和未来验收", async () => {
  const answered = issue({ blocking: false, question: "已确认完整结果通过产物下载，不内嵌状态响应" });
  const future = issue({ id: "future_activation", owner: "system" as RequirementIssue["owner"], stage: "activation" as NonNullable<RequirementIssue["stage"]>, blocking: false, checks: ["platform.managedRuntime"] });
  const assessment = await assessmentWith([answered, future]);
  const evidence = [{ id: "user_choice", role: "user" as EvidenceMessage["role"], content: "完整结果通过产物下载，不内嵌状态响应" }];
  const resolved = { issueId: answered.id, owner: "user" as RequirementIssue["owner"], stage: "requirements" as NonNullable<RequirementIssue["stage"]>, status: "resolved" as IssueDecision["status"], reason: "用户已逐字选择结果交付形式",
    evidence: [{ messageId: "user_choice", quote: evidence[0]!.content }] };
  const pending = { issueId: future.id, owner: "system" as RequirementIssue["owner"], stage: "activation" as NonNullable<RequirementIssue["stage"]>, status: "open" as IssueDecision["status"], checks: future.checks,
    reason: "平台可承载，实际启动仍须激活验收", evidence: [] };
  const real = scriptedPreflight([assessment, assessment, { decisions: [resolved, pending] }], {
    verifySystemIssues: async ({ issues }) => issues.map((entry) => verificationFor(entry.id, entry.checks!)),
  });
  const result = await processTurn({ ...input(), evidenceMessages: evidence }, { ...providers(), preflight: real.preflight }, strict);
  assert.equal(real.requests.length, 3); assert.equal(result.status, "ready");
  const last = result.consultation!.assessments.at(-1);
  assert.equal(last!.direction!, assessment.direction); assert.equal(last!.adequacy!, assessment.adequacy); assert.equal(last!.verdict!, assessment.verdict);
  assert.deepEqual(last!.issues!.map((entry) => entry.id), [future.id]);
  assert.deepEqual(last!.issueDecisions!.find((entry) => entry.issueId === answered.id), resolved);
  const history = result.consultation!.issues.find((entry) => entry.id === answered.id);
  assert.equal(history!.status!, "resolved"); assert.equal(history!.current!, false); assert.deepEqual(history!.resolution!.evidence, resolved.evidence);
  assert.equal(last!.deferredIssues![0]!.id, future.id); assert.equal(last!.deferredIssues![0]!.stage, "activation");
  assert.equal(result.consultation!.issues.find((entry) => entry.id === future.id)!.status, "open");
});

test("历史投影不能移除真实阻断或无效证据，未解决的非阻断项仍保留", async () => {
  const evidenceMessages = [{ id: "actual", role: "user" as EvidenceMessage["role"], content: "逐项完整处理" }];
  const decision = { issueId: "choice", owner: "user" as RequirementIssue["owner"], stage: "requirements" as NonNullable<RequirementIssue["stage"]>, status: "resolved" as IssueDecision["status"], reason: "用户已选择完整处理",
    evidence: [{ messageId: "actual", quote: "逐项完整处理" }] };
  for (const [candidate, resolved] of [
    [issue({ blocking: true }), decision],
    [issue({ blocking: false }), { ...decision, evidence: [{ messageId: "actual", quote: "用户没有说过的话" }] }],
  ] as const) {
    const real = scriptedPreflight([await assessmentWith([candidate]), { decisions: [resolved] }, await assessmentWith([candidate])]);
    await assert.rejects(callFixture(real.preflight!, undefined, [{ draft: draft(), platform: {}, evidenceMessages }]), /预算/);
    assert.equal(real.requests.length, 6);
  }
  const optional = issue({ blocking: false });
  const real = scriptedPreflight([await assessmentWith([optional]), { decisions: [{ ...decision, status: "open" as IssueDecision["status"], evidence: [], reason: "这项暂未决定但不影响当前交付" }] }]);
  const result = await real.preflight!({ draft: draft(), platform: {}, evidenceMessages });
  assert.equal(real.requests.length, 2); assert.deepEqual(result.issues, [optional]);
  assert.equal(result.issueDecisions![0]!.status, "open");
});
