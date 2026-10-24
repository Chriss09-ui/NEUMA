import { callFixture } from "./helpers/m7-test-boundaries.mjs";
import type { RequirementIssue, IssueDecision, EvidenceMessage, RequirementDraft, Consultation } from "../src/contracts/requirements.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { consultationGate, evaluateConsultation, newConsultation } from "../src/requirements/consultation.mjs";
import { emptyTaskSpec } from "../src/requirements/task-spec.mjs";
import { validDraft } from "./helpers/architecture.mjs";
import { sufficientPreflight } from "./helpers/consultation.mjs";
import type { PreflightResponse } from "../src/contracts/requirements.mjs";

const answer = { id: "user_answer", role: "user" as EvidenceMessage["role"], content: "只有前三项是专属后台操作，查询状态和下载结果由平台网关提供；不做页面。" };
const historicalIssue = () => ({ id: "operation_classification", owner: "user" as RequirementIssue["owner"], blocking: true,
  question: "五项操作是否都需要页面入口？", impact: "决定专属操作和平台网关的边界", requirementIds: ["operation_4", "operation_5"] });
const currentDraft = () => ({ ...validDraft("反复计算清单并交付文件"), taskSpec: emptyTaskSpec(),
  interaction: { defaultEntry: "conversation" as NonNullable<RequirementDraft["interaction"]>["defaultEntry"], page: false, operations: ["校验输入", "汇总结果", "导出文件"], inputs: "清单", results: "JSON和CSV", persistentData: "" } });
const consultation = () => ({ ...newConsultation(), evidenceMessages: [answer],
  handoff: { id: "arch_handoff", resolved: false, issues: [historicalIssue()] } });
const resolved = () => ({ issueId: "operation_classification", status: "resolved" as IssueDecision["status"], reason: "用户已经明确专属操作与网关职责",
  evidence: [{ messageId: answer.id, quote: answer.content }] });
const assess = async (response: unknown, previous: Consultation = consultation()): Promise<Consultation> =>
  callFixture(evaluateConsultation, undefined, [{ draft: currentDraft(), consultation: previous,
    platform: {}, requestId: "clarification", preflight: async () => response }]);

test("操作数改变后可凭逐字回答关闭原架构返需，历史引用不按当前编号重复判错", async () => {
  const previous = consultation(), before = structuredClone(previous);
  const result = await assess({ ...await sufficientPreflight(), reviewedIssues: [historicalIssue()], issueDecisions: [resolved()] }, previous);
  assert.equal(result.assessments.at(-1)!.failure, undefined);
  assert.equal(consultationGate(currentDraft(), result, {}).allowed, true);
  assert.equal(result.handoff!.resolved, true);
  assert.deepEqual(result.issues[0]!.requirementIds, ["operation_4", "operation_5"]);
  assert.deepEqual(result.issues[0]!.resolution!.evidence, resolved().evidence);
  assert.equal(result.issues[0]!.status, "resolved"); assert.equal(result.issues[0]!.current, false);
  assert.deepEqual(result.assessments.at(-1)!.issues, []); assert.equal(result.assessments.at(-1)!.deferredIssues, undefined);
  assert.deepEqual(previous, before);
});

test("同编号复核副本不能替换可信原问题、归属或引用，关闭仍使用真实用户依据", async () => {
  const forged = { id: "operation_classification", owner: "runtime" as RequirementIssue["owner"], blocking: false, question: "模型改写的问题",
    impact: "模型试图缩小原问题", requirementIds: ["invented_reference"], stage: "runtime" as NonNullable<RequirementIssue["stage"]> };
  const response = { ...await sufficientPreflight(), reviewedIssues: [forged], issueDecisions: [resolved()] };
  const result = await assess(response);
  assert.equal(result.assessments.at(-1)!.failure, undefined);
  assert.equal(result.issues[0]!.owner, "user"); assert.equal(result.issues[0]!.question, historicalIssue().question);
  assert.deepEqual(result.issues[0]!.requirementIds, historicalIssue().requirementIds);
  const withoutProof = await assess({ ...response, issueDecisions: [{ ...resolved(), evidence: [] }] });
  assert.equal(withoutProof.assessments.at(-1)!.failure, "preflight_failed"); assert.equal(withoutProof.handoff!.resolved, false);
  const assistantProof = consultation(); assistantProof.evidenceMessages = [{ ...answer, role: "assistant" as EvidenceMessage["role"] }];
  const withoutUser = await assess(response, assistantProof);
  assert.equal(withoutUser.assessments.at(-1)!.failure, "preflight_failed"); assert.equal(withoutUser.handoff!.resolved, false);
});

test("当前候选即使沿用历史编号仍须当前引用，新复核问题也不能携带过期或伪造编号", async () => {
  const base = await sufficientPreflight();
  for (const response of [
    { ...base, verdict: "needs_input" as PreflightResponse["verdict"], issues: [historicalIssue()], issueDecisions: [] },
    { ...base, reviewedIssues: [{ ...historicalIssue(), id: "new_question" }], issueDecisions: [resolved()] },
    { ...base, reviewedIssues: [{ ...historicalIssue(), id: "new_question", requirementIds: ["invented_reference"] }], issueDecisions: [resolved()] },
  ]) {
    const result = await assess(response);
    assert.equal(result.assessments.at(-1)!.failure, "preflight_failed");
    assert.equal(consultationGate(currentDraft(), result, {}).allowed, false); assert.equal(result.handoff!.resolved, false);
  }
});

test("未解决的活跃旧阻断不能因漏列或伪造非阻断副本而消失，旧交接也保持未解决", async () => {
  const response = { ...await sufficientPreflight(), reviewedIssues: [{ id: "operation_classification", blocking: false }], issueDecisions: [] };
  for (const previous of [consultation(), { ...newConsultation(), evidenceMessages: [answer],
    issues: [{ ...historicalIssue(), status: "open" as IssueDecision["status"], current: true }] }]) {
    const result = await assess(response, previous);
    assert.equal(result.assessments.at(-1)!.failure, "preflight_failed");
    assert.equal(result.issues[0]!.blocking, true); assert.equal(result.issues[0]!.current, true);
    assert.equal(consultationGate(currentDraft(), result, {}).allowed, false);
    if (result.handoff) assert.equal(result.handoff.resolved, false);
  }
});

test("未解决旧阻断可使用当前有效引用继续追问，非当前或已解决历史不自动重新阻断", async () => {
  const current = { ...historicalIssue(), requirementIds: ["interaction"], question: "还需要确认其他交互入口吗？" };
  const continued = await assess({ ...await sufficientPreflight(), verdict: "needs_input" as PreflightResponse["verdict"], issues: [current], reviewedIssues: [historicalIssue()], issueDecisions: [] });
  assert.equal(continued.assessments.at(-1)!.failure, undefined);
  assert.equal(continued.handoff!.resolved, false); assert.equal(consultationGate(currentDraft(), continued, {}).reason, "needs_input");
  for (const historical of [{ ...historicalIssue(), current: false, status: "open" as IssueDecision["status"] }, { ...historicalIssue(), current: true, status: "resolved" as IssueDecision["status"] }]) {
    const result = await assess(await sufficientPreflight(), { ...newConsultation(), evidenceMessages: [answer], issues: [historical] });
    assert.equal(result.assessments.at(-1)!.failure, undefined); assert.equal(consultationGate(currentDraft(), result, {}).allowed, true);
  }
});
