import test from "node:test";
import assert from "node:assert/strict";
import { processTurn, emptyDraft } from "../src/requirements/core.mjs";
import { consultationGate } from "../src/requirements/consultation.mjs";
import { calculateRequirementDerivation } from "../src/requirements/requirement-calculations.mjs";
import { substantiveRequirementHash } from "../src/requirements/task-spec.mjs";
import { makeProviders } from "../src/requirements/providers.mjs";
import { validDraft } from "./helpers/architecture.mjs";
import { sufficientPreflight } from "./helpers/consultation.mjs";

const platform = { version: 1, runtime: {} };
const issue = () => ({ id: "capacity_proof", owner: "system", stage: "requirements", blocking: true,
  question: "核对实际处理和交付边界", impact: "决定可行承载方式", checks: ["platform.runtime"], requirementIds: ["task"] });
const text = "capacity_proof：保留这段与原问题不同的完整说明：转义、Unicode 😀、\n以及需要重新判断的前提。";
const decision = () => ({ issueId: "capacity_proof", owner: "system", stage: "requirements", status: "open", reason: "系统尚需核实", evidence: [] });
const blocked = async (extra = {}) => ({ ...await sufficientPreflight(), verdict: "blocked", issues: [issue()], issueDecisions: [decision()], ...extra });
const options = (requestId, signal) => ({ enforceConsultation: true, platform, requestId, signal });
const noGeneration = async () => assert.fail("可信系统日志的纯续查不应重写整份需求");
const normalGeneration = async () => { throw new Error("normal_generation_selected"); };
const request = (initial, message = "继续", extra = {}) => ({ draft: initial.draft, consultation: initial.consultation,
  lastQuestion: initial.question, message, ...extra });
async function pending({ unresolved = [text], derivation = false } = {}) {
  const value = { ...validDraft("核对有界资料"), taskSpec: { version: 1, items: [] }, unresolved };
  const calculation = derivation ? calculateRequirementDerivation({ issueId: "capacity_proof", requirementIds: ["task"],
    premises: [{ id: "rows", value: "3", unit: "count", source: { kind: "requirement", reference: "task", detail: "测试数量前提" } }],
    expressions: [{ id: "result", unit: "count", formula: { op: "multiply", args: [{ ref: "rows" }, { value: "2" }] } }] },
  { draft: value, platform, issues: [issue()], requirementIds: ["task"] }) : null;
  return processTurn({ message: "帮我核对有界资料", draft: emptyDraft() }, {
    generateDraft: async () => ({ draft: value, proposedGap: "none", question: "" }),
    preflight: async () => blocked(calculation ? { derivations: [calculation], issueDecisions: [{ ...decision(), derivationIds: [calculation.id] }] } : {}),
  }, options("initial"));
}

test("可信系统编号日志仅在新纯继续候选转存，原文/阻断保留且新摘要重新评估", async () => {
  const initial = await pending({ derivation: true }), before = structuredClone(initial), sourceHash = substantiveRequirementHash(initial.draft);
  let calls = 0;
  const result = await processTurn(request(initial), { generateDraft: noGeneration, preflight: async (input) => {
    calls++;
    assert.deepEqual(input.draft.unresolved, []);
    assert.equal(input.previousIssues.find((item) => item.id === "capacity_proof").blocking, true);
    assert.equal(input.consultationNotes.length, 1);
    assert.deepEqual(input.consultationNotes[0], { id: input.consultationNotes[0].id, kind: "system_unresolved", issueId: "capacity_proof",
      sourceRequirementHash: sourceHash, assessmentId: initial.consultation.assessments.at(-1).id, text });
    return blocked();
  } }, options("resume"));
  assert.equal(calls, 1); assert.equal(result.diagnostic.model.reason, "resume_system_assessment");
  assert.notEqual(substantiveRequirementHash(result.draft), sourceHash);
  assert.equal(result.status, "needs_input"); assert.equal(result.confirmed, false); assert.equal(result.confirmation, undefined);
  assert.equal(result.consultation.issues.find((item) => item.id === "capacity_proof").blocking, true);
  assert.equal(result.consultation.assessments.at(-1).derivations, undefined, "旧计算不自动转绑新需求");
  assert.deepEqual(result.consultation.assessments[0], initial.consultation.assessments[0]);
  assert.deepEqual(initial, before);
  const repeated = await processTurn(request(result, "重试"), { generateDraft: noGeneration, preflight: async (input) => {
    assert.deepEqual(input.consultationNotes, result.consultation.notes); return blocked();
  } }, options("again"));
  assert.deepEqual(repeated.consultation.notes, result.consultation.notes);
});

test("清理后的新需求拒绝旧计算回执，不沿用旧评估或确认", async () => {
  const initial = await pending({ derivation: true }), old = initial.consultation.assessments.at(-1);
  const result = await processTurn(request(initial), { generateDraft: noGeneration,
    preflight: async () => blocked({ derivations: old.derivations, issueDecisions: old.issueDecisions }) }, options("stale_receipt"));
  assert.equal(result.consultation.assessments.at(-1).failure, "calculation_binding_invalid");
  assert.equal(consultationGate(result.draft, initial.consultation, platform).reason, "assessment_missing");
  assert.equal(result.confirmed, false); assert.equal(result.confirmation, undefined);
});

test("混杂普通缺口、未知编号和非精确前缀不转存，也不忽略业务澄清", async () => {
  for (const unresolved of [[text, "boundary"], [text, "用户还没有确认保存多久"], ["unknown_issue：未决说明"],
    ["capacity_proof_suffix：不能模糊匹配"], ["capacity_proof 缺少冒号"], ["none"], ["boundary"]]) {
    const initial = await pending({ unresolved }), before = structuredClone(initial);
    await assert.rejects(processTurn(request(initial), { generateDraft: normalGeneration }, options("mixed")), /normal_generation_selected/);
    assert.deepEqual(initial, before);
  }
  const initial = await pending();
  await assert.rejects(processTurn(request(initial, "继续，但改为只交付摘要"), { generateDraft: normalGeneration }, options("changed")), /normal_generation_selected/);
  await assert.rejects(processTurn(request(initial, "继续", { evidenceMessages: [{ id: "new_answer", role: "user", content: "另加长期保存和删除入口" }] }),
    { generateDraft: normalGeneration }, options("unabsorbed")), /normal_generation_selected/);
});

test("用户/运行时归属、失效或缺少独立系统决定都不能迁移编号日志", async () => {
  const base = await pending();
  for (const mutate of [
    (initial) => { initial.consultation.issues[0].owner = "user"; },
    (initial) => { initial.consultation.issues[0].owner = "runtime"; },
    (initial) => { initial.consultation.issues[0].current = false; },
    (initial) => { initial.consultation.issues[0].status = "resolved"; },
    (initial) => { initial.consultation.issues[0].requirementHash = "0".repeat(64); },
    (initial) => { initial.consultation.issues[0].resolution.assessmentId = "different"; },
    (initial) => { delete initial.consultation.assessments[0].issueDecisions; },
    (initial) => { initial.consultation.assessments[0].issueDecisions[0].owner = "user"; },
    (initial) => { initial.consultation.assessments[0].issueDecisions[0].evidence = [{ messageId: "missing", quote: "伪造原文" }]; },
    (initial) => { initial.consultation.assessments[0].failure = "preflight_failed"; },
    (initial) => { delete initial.consultation.assessments[0].systemReviewVersion; },
    (initial) => { initial.consultation.assessments[0].requirementHash = "0".repeat(64); },
    (initial) => { initial.draft.taskSpec.items = [{ id: "unknown", dimension: "input_scale", content: "未知规模", critical: true,
      applicability: "unknown", source: { kind: "unknown", evidence: [] } }]; },
    (initial) => { delete initial.draft.taskSpec; },
  ]) {
    const initial = structuredClone(base); mutate(initial);
    await assert.rejects(processTurn(request(initial), { generateDraft: normalGeneration }, options("invalid")), /normal_generation_selected/);
  }
});

test("转存后的系统问题仍可被新独立评估改判为真正用户阻断；取消不覆盖旧记录", async () => {
  const initial = await pending(), before = structuredClone(initial);
  const result = await processTurn(request(initial), { generateDraft: noGeneration, preflight: async ({ consultationNotes }) => {
    assert.equal(consultationNotes[0].text, text);
    return { ...await sufficientPreflight(), verdict: "needs_input", issues: [{ ...issue(), owner: "user", checks: undefined,
      question: "新增说明仍需哪项业务选择？" }], issueDecisions: [{ ...decision(), owner: "user", reason: "完整转存原文包含真正业务未知" }] };
  } }, options("reclassified"));
  assert.equal(result.confirmationGate.reason, "needs_input"); assert.equal(result.consultation.issues[0].owner, "user");
  assert.equal(result.consultation.issues[0].blocking, true); assert.equal(result.confirmed, false);
  const controller = new AbortController();
  await assert.rejects(processTurn(request(initial), { generateDraft: noGeneration, preflight: async () => {
    controller.abort(); return blocked();
  } }, options("cancelled", controller.signal)), { name: "AbortError" });
  assert.deepEqual(initial, before);
});

test("转存原文同时传给实际provider的预评估与独立复核，旧无notes接口不加空字段", async () => {
  const initial = await pending(), requests = [];
  const responses = [await blocked(), await blocked(), { decisions: [decision()] }];
  const providers = makeProviders({ llmConfigured: true, chatUrl: "https://model.invalid/chat", model: "fixture", apiKey: "fixture" }, async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(responses[requests.length - 1]) } }] }), { status: 200 });
  }, { verifySystemIssues: async () => [{ id: "capacity_proof", status: "verified", message: "读取平台边界，不代表业务已通过", evidence: [
    { source: "platform", reference: "platform.runtime", detail: "当前受控运行契约" }] }] });
  const result = await processTurn(request(initial), { generateDraft: noGeneration, preflight: providers.preflight }, options("provider"));
  assert.equal(requests.length, 3); assert.equal(result.confirmed, false);
  for (const input of [requests[0], requests[2]]) {
    const payload = JSON.parse(input.messages[1].content);
    assert.deepEqual(payload.consultationNotes, result.consultation.notes);
    assert.match(input.messages[0].content, /尾文含义仍须逐项重新判断/);
  }
  const legacyRequests = [];
  const legacy = makeProviders({ llmConfigured: true, chatUrl: "https://model.invalid/chat", model: "fixture", apiKey: "fixture" }, async (_url, options) => {
    legacyRequests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(await sufficientPreflight()) } }] }), { status: 200 });
  });
  await legacy.preflight({ draft: validDraft("普通任务"), platform });
  assert.equal(Object.hasOwn(JSON.parse(legacyRequests[0].messages[1].content), "consultationNotes"), false);
});
