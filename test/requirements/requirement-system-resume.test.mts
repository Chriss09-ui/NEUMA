import { callFixture } from "../helpers/m7-test-boundaries.mjs";
import { fixtureChatRequest, fixtureString, type FixtureChatRequest } from "../helpers/http-model.mjs";
import type { RequirementDraft, RequirementIssue, IssueDecision, PreflightResponse } from "../../src/contracts/requirements.mjs";
type TurnResult = Awaited<ReturnType<typeof processTurn>>;
import { failureFields } from "../helpers/failure-fields.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { processTurn, emptyDraft, CONFIRMATION_QUESTION } from "../../src/requirements/core.mjs";
import { contentHash, emptyTaskSpec, substantiveRequirementHash } from "../../src/requirements/task-spec.mjs";
import { sufficientPreflight } from "../helpers/consultation.mjs";
import { validDraft } from "../helpers/architecture.mjs";

const platform = { version: 1 };
const options = (requestId: string, signal?: AbortSignal) => ({ enforceConsultation: true, platform, requestId, signal });
const draft = () => ({ ...validDraft("逐项核对清单并交付结果"), taskSpec: emptyTaskSpec() });
const systemIssue = (): RequirementIssue => ({ id: "system_check", owner: "system", stage: "requirements", blocking: true,
  question: "需要核对实际执行能力", impact: "决定当前能否承载", requirementIds: ["task"], checks: ["platform.runtime"] });
const userIssue = (): RequirementIssue => ({ id: "business_choice", owner: "user", stage: "requirements", blocking: true,
  question: "需要逐项明细还是仅总计？", impact: "改变交付标准", requirementIds: ["deliverable"] });
const openSystem = (issue: RequirementIssue): IssueDecision => ({ issueId: issue.id, owner: "system", stage: "requirements", status: "open",
  reason: "技术条件仍需要核实", evidence: [] });
async function pending(value = draft(), issues: RequirementIssue[] = [systemIssue()]) {
  return processTurn({ message: "逐项核对我提交的清单", draft: emptyDraft() }, {
    generateDraft: async () => ({ draft: value, proposedGap: "none", question: "" }),
    preflight: async () => ({ ...await sufficientPreflight(), verdict: issues.some((issue) => issue.owner === "user") ? "needs_input" : "blocked",
      issues, issueDecisions: issues.filter((issue) => issue.owner === "system").map(openSystem) }),
  }, options("initial"));
}
async function resolveSystem(): Promise<PreflightResponse> {
  return { ...await sufficientPreflight(), issueDecisions: [{ issueId: "system_check", owner: "system", stage: "requirements",
    status: "resolved", reason: "受控宿主事实支持当前实现", evidence: [], checks: ["platform.runtime"] }],
    systemChecks: [{ id: "system_check", status: "verified", message: "已读取平台事实", evidence: [
      { source: "platform", reference: "platform.runtime", detail: "实际读取当前运行约束" }] }] };
}
const request = (initial: TurnResult, message = "继续", extra = {}) => ({ message, draft: initial.draft,
  consultation: initial.consultation, lastQuestion: initial.question, ...extra });
const noGeneration = async () => { assert.fail("纯系统续查不应重写需求"); };
const normalGeneration = async () => { throw new Error("normal_generation_selected"); };

test("系统失败的纯继续复核旧稿，成功仅回到待确认，下一次明确确认才发凭据", async () => {
  const initial = await pending(), before = structuredClone(initial);
  assert.equal(initial.status, "needs_input");
  let calls = 0;
  const result = await processTurn(request(initial), { generateDraft: noGeneration,
    preflight: async () => { calls++; return resolveSystem(); } }, options("resume"));
  assert.equal(calls, 1);
  assert.equal(result.diagnostic.model.reason, "resume_system_assessment");
  assert.equal(result.status, "ready"); assert.equal(result.confirmed, false);
  assert.equal(result.confirmationQuestion, CONFIRMATION_QUESTION); assert.equal(result.confirmation, undefined);
  assert.deepEqual(result.draft, initial.draft); assert.deepEqual(initial, before);
  const confirmed = await processTurn({ message: "确认", draft: result.draft, consultation: result.consultation,
    lastQuestion: result.confirmationQuestion }, { generateDraft: noGeneration,
    preflight: async () => { assert.fail("有效续查后的明确确认不应重复预评估"); } }, options("confirm"));
  assert.equal(confirmed.confirmed, true); assert.ok(confirmed.confirmation);
});

test("未解决用户阻断不进入系统捷径", async () => {
  const initial = await pending(draft(), [systemIssue(), userIssue()]);
  await assert.rejects(processTurn(request(initial), { generateDraft: normalGeneration }, options("user_block")), /normal_generation_selected/);
});

test("关键来源或适用性未知时仍走正常需求生成", async () => {
  for (const applicability of ["unknown", "applies"] as const) {
    const value = draft(); value.taskSpec.items.push({ id: "unknown_scale", dimension: "input_scale", content: "最大规模未确认",
      critical: true, applicability, source: { kind: "unknown", evidence: [] } });
    const initial = await pending(value);
    await assert.rejects(processTurn(request(initial), { generateDraft: normalGeneration }, options(`unknown_${applicability}`)), /normal_generation_selected/);
  }
});

test("新架构返需沿用旧问题编号，不能被旧handoff已解决记录遮住", async () => {
  const initial = await pending(), choice = userIssue();
  const resolved = { ...choice, status: "resolved", current: false, handoffId: "old_handoff",
    resolution: { assessmentId: "old", evidenceIds: [] } };
  callFixture(initial.consultation!.issues.push, initial.consultation!.issues, [resolved]);
  initial.consultation!.handoff = { id: "new_handoff", resolved: false,
    requirementHash: substantiveRequirementHash(initial.draft), architectureVersion: 2, issues: [choice] };
  await assert.rejects(processTurn(request(initial), { generateDraft: normalGeneration, preflight: resolveSystem }, options("new_handoff")), /normal_generation_selected/);
});

test("当前已解决历史问题不阻挡纯技术续查，已完成handoff不重新打开旧问题", async () => {
  const initial = await pending(), choice = userIssue();
  initial.consultation!.issues.push({ ...choice, status: "resolved", current: false, handoffId: "finished_handoff" });
  initial.consultation!.handoff = { id: "finished_handoff", resolved: true, issues: [choice] };
  const result = await processTurn(request(initial), { generateDraft: noGeneration, preflight: resolveSystem }, options("resolved_history"));
  assert.equal(result.status, "ready"); assert.equal(result.confirmed, false);
});

test("历史刚补进未吸收的业务回答时，短继续也必须先更新需求", async () => {
  const initial = await pending();
  await assert.rejects(processTurn(request(initial, "继续", { evidenceMessages: [
    { id: "failed_business_answer", role: "user", content: "把交付改为逐项明细 CSV，不再只给总计" },
  ] }), { generateDraft: normalGeneration, preflight: resolveSystem }, options("new_answer")), /normal_generation_selected/);
});

test("本轮带业务修改或权限变化的继续不进入系统捷径", async () => {
  const initial = await pending();
  for (const message of ["继续，把交付改为CSV", "继续，不要联网", "继续并改为保留历史"]) {
    await assert.rejects(processTurn(request(initial, message), { generateDraft: normalGeneration }, options(contentHash(message))), /normal_generation_selected/);
  }
});

test("新增实际测量可交给续查评估，保留测量与原要求且不自动确认", async () => {
  const initial = await pending(), measured = { id: "measurement_new", role: "measurement", content: "实际材料共有80项" };
  const result = await processTurn(request(initial, "继续核实", { evidenceMessages: [measured] }), {
    generateDraft: noGeneration, preflight: async ({ evidenceMessages }) => {
      assert.ok(evidenceMessages!.some((entry) => entry.id === measured.id)); return resolveSystem();
    },
  }, options("measurement"));
  assert.equal(result.status, "ready"); assert.equal(result.confirmed, false); assert.deepEqual(result.draft, initial.draft);
});

test("续查仍核对来源与现有阻断，核实失败或取消不会放行或覆盖旧记录", async () => {
  const initial = await pending(), before = structuredClone(initial);
  const failed = await processTurn(request(initial, "重试"), { generateDraft: noGeneration,
    preflight: async () => { throw new Error("host_check_failed"); } }, options("failure"));
  assert.equal(failed.status, "needs_input"); assert.equal(failed.confirmed, false); assert.equal(failed.confirmation, undefined);
  const controller = new AbortController();
  await assert.rejects(processTurn(request(initial), { generateDraft: noGeneration, preflight: async () => {
    controller.abort(); return resolveSystem();
  } }, options("cancel", controller.signal)), { name: "AbortError" });
  assert.deepEqual(initial, before);
  const invalid = structuredClone(initial); invalid.draft.taskSpec!.items.push({ id: "bad_quote", dimension: "processing", content: "模型伪造的规则",
    critical: true, applicability: "applies", source: { kind: "user", evidence: [{ messageId: "invented", quote: "不存在的原话" }] } });
  const assessment = invalid.consultation!.assessments.at(-1); assessment!.requirementHash = substantiveRequirementHash(invalid.draft);
  await assert.rejects(processTurn(request(invalid), { generateDraft: noGeneration,
    preflight: async () => { assert.fail("来源不合法时不能进入技术评估"); } }, options("invalid_evidence")), (error) => failureFields(error).diagnostic?.reason === "invalid_evidence");
});
