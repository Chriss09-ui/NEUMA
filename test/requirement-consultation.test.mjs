import test from "node:test";
import assert from "node:assert/strict";
import { processTurn, normalizeDraft, CONFIRMATION_QUESTION } from "../src/requirements/core.mjs";
import { contentHash, emptyTaskSpec, mergeEvidence, substantiveRequirementHash, validateTaskEvidence, validateTaskSpecTransition } from "../src/requirements/task-spec.mjs";
import { authorizeConfirmedRequirement, claimRequirementHandoff, consultationGate, evaluateConsultation, issueConfirmation, newConsultation, validateRequirementReceipt } from "../src/requirements/consultation.mjs";
import { makeProviders } from "../src/requirements/providers.mjs";
import { MainMaterials } from "../src/main/main-materials.mjs";
import { prepareRequirement } from "../src/main/main-requirements.mjs";
import { validDraft } from "./helpers/architecture.mjs";
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
  const evidence = mergeEvidence([], [{ id: "user_1", role: "user", content: "每批大约五十份，逐项检查" },
    { id: "assistant_1", role: "assistant", content: "建议只检查少量样本" }]);
  const spec = { version: 1, items: [{ id: "scale", dimension: "input_scale", content: "每批五十份", critical: true,
    applicability: "applies", source: { kind: "user", evidence: [{ messageId: "user_1", quote: "每批大约五十份" }] } }] };
  assert.deepEqual(validateTaskEvidence(spec, evidence), spec);
  const forged = structuredClone(spec); forged.items[0].source.evidence[0].quote = "每批只有五份";
  assert.throws(() => validateTaskEvidence(forged, evidence), /无法核对/);
  forged.items[0].source.evidence = [{ messageId: "assistant_1", quote: "建议只检查少量样本" }];
  assert.throws(() => validateTaskEvidence(forged, evidence), /用户原话/);
  forged.items[0].source.kind = "measured"; assert.throws(() => validateTaskEvidence(forged, evidence), /实际测量/);
});

test("关键未知项不能被删除或降级绕过确认，退休需本轮用户修改依据", () => {
  const previous = { version: 1, items: [{ id: "scale", dimension: "input_scale", content: "规模待确定", critical: true,
    applicability: "unknown", source: { kind: "unknown", evidence: [] } }] };
  assert.throws(() => validateTaskSpecTransition(previous, emptyTaskSpec(), [], "确认"), /不能/);
  const evidence = [{ id: "u", role: "user", content: "不需要批量处理了" }];
  const next = { ...emptyTaskSpec(), retired: [{ id: "scale", reason: "用户取消批量范围", evidence: [{ messageId: "u", quote: "不需要批量处理了" }] }] };
  assert.doesNotThrow(() => validateTaskSpecTransition(previous, next, evidence, evidence[0].content));
  assert.throws(() => validateTaskSpecTransition(previous, next, evidence, "确认"), /不能/);
  const lowered = structuredClone(previous); lowered.items[0].critical = false;
  lowered.items[0].source = { kind: "user", evidence: [{ messageId: "u", quote: evidence[0].content }] };
  assert.throws(() => validateTaskSpecTransition(previous, lowered, evidence, "确认"), /不能/);
  assert.doesNotThrow(() => validateTaskSpecTransition(previous, lowered, evidence, evidence[0].content));
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
  assert.equal(result.consultation.assessments[0].failure, "preflight_unavailable");
  assert.match(result.question, /预评估未完成/); assert.equal(result.draft.task.value, draft().task.value);
});

test("预评估的关键用户问题进入下一轮，系统问题不伪装用户选项", async () => {
  const base = await sufficientPreflight();
  const result = await processTurn(input(), { ...providers(), preflight: async () => ({ ...base, verdict: "needs_input",
    issues: [{ id: "batch", owner: "user", blocking: true, question: "通常一次需要处理多少份材料？", impact: "决定批次和恢复方式", requirementIds: ["inputSource"] }] }) }, strict);
  assert.equal(result.question, "通常一次需要处理多少份材料？"); assert.equal(result.status, "needs_input");
  assert.equal(result.confirmationGate.reason, "needs_input");
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
  await assert.rejects(evaluateConsultation({ draft: draft(), consultation: previous, platform: {}, requestId: "a",
    signal: controller.signal, preflight: async () => { controller.abort(); return sufficientPreflight(); } }), { name: "AbortError" });
  assert.equal(previous.assessments.length, 0);
});

test("正式架构返需绑定需求版本；重复领取不会增加版本或切换其他需求", () => {
  const requirement = { draft: draft(), version: 1, agentId: "agent", confirmed: true, status: "needs_build", consultation: newConsultation() };
  const handoff = { id: "handoff", requirementHash: substantiveRequirementHash(requirement.draft), architectureVersion: 2,
    issues: [{ id: "history", owner: "user", blocking: true, question: "需要保留历史吗？", impact: "决定数据保存", requirementIds: ["task"] }] };
  const claimed = claimRequirementHandoff(requirement, handoff); assert.equal(claimed.status, "needs_input");
  assert.equal(claimed.confirmed, false); assert.equal(requirement.confirmed, true);
  assert.deepEqual(claimRequirementHandoff(claimed, handoff), claimed);
  assert.throws(() => claimRequirementHandoff(requirement, { ...handoff, requirementHash: contentHash("other") }), /过期/);
});

test("真实预评估 provider 的修复和资料核实共享六回合与两次预算", async () => {
  let modelCalls = 0, researchCalls = 0;
  const real = makeProviders({ llmConfigured: true, chatUrl: "https://model.invalid/chat", model: "fake", apiKey: "test" },
    async () => { modelCalls++; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ research: { query: "official test" } }) } }] }), { status: 200 }); });
  await assert.rejects(real.preflight({ draft: draft(), platform: {}, evidenceMessages: [], previousIssues: [],
    research: async () => { researchCalls++; return { supported: true }; } }), /预算/);
  assert.equal(modelCalls, 6); assert.equal(researchCalls, 2);
});

test("真实预评估 provider 能修复结构并返回完整六维判断", async () => {
  let calls = 0; const response = await sufficientPreflight();
  const real = makeProviders({ llmConfigured: true, chatUrl: "https://model.invalid/chat", model: "fake", apiKey: "test" },
    async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(++calls === 1 ? { verdict: "sufficient" } : response) } }] }), { status: 200 }));
  assert.deepEqual(await real.preflight({ draft: draft(), platform: {}, evidenceMessages: [], previousIssues: [] }), response);
  assert.equal(calls, 2);
});

test("即使模型表示充分，仍未知的关键要求也不能确认", async () => {
  const value = draft(); value.taskSpec.items.push({ id: "scale", dimension: "input_scale", content: "材料规模待明确",
    critical: true, applicability: "unknown", source: { kind: "unknown", evidence: [] } });
  const ready = await processTurn(input(value), providers(value), strict);
  assert.equal(ready.status, "needs_input"); assert.equal(ready.confirmationGate.reason, "critical_requirement_unknown");
});

test("编辑已保存任务从独立协商记录恢复原始证据", async () => {
  const value = draft(), consultation = newConsultation();
  consultation.evidenceMessages = [{ id: "old", role: "user", content: "必须逐项检查并提供完整清单" }];
  value.taskSpec.items.push({ id: "coverage", dimension: "processing", content: "逐项完整覆盖", critical: true,
    applicability: "applies", source: { kind: "user", evidence: [{ messageId: "old", quote: "必须逐项检查" }] } });
  const prepared = await prepareRequirement({ record: {}, agentId: "existing", mode: "edit", conversationId: "new_chat", mutationId: "edit" }, {
    getRequirements: async () => ({ requirements: [{ id: "existing", name: "已有助手", draft: value }] }),
    getRequirementConsultation: async () => consultation,
  });
  assert.deepEqual(prepared.consultation.evidenceMessages, consultation.evidenceMessages);
  assert.doesNotThrow(() => validateTaskEvidence(prepared.draft.taskSpec, prepared.consultation.evidenceMessages));
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
  const first = JSON.parse(measured[0].content), second = JSON.parse(measured[1].content);
  assert.equal(measured[0].role, "measurement"); assert.equal(first.extractedCharacters, 3); assert.equal(first.extractionComplete, false);
  assert.equal(second.status, "extraction_failed"); assert.equal("extractedCharacters" in second, false);
});

test("新任务要求进入用户确认摘要，不能只作为隐藏选型字段", async () => {
  const value = draft(); value.taskSpec.items.push({ id: "quality", dimension: "delivery", content: "每项结果必须标明材料出处", critical: true,
    applicability: "applies", source: { kind: "user", evidence: [{ messageId: "u", quote: "每项结果必须标明材料出处" }] } });
  const ready = await processTurn({ ...input(value), evidenceMessages: [{ id: "u", role: "user", content: "每项结果必须标明材料出处" }] }, providers(value), strict);
  assert.equal(ready.status, "ready"); assert.match(ready.summary, /交付标准：每项结果必须标明材料出处/);
});
