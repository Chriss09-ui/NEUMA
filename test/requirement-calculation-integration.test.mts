import { fixtureString } from "./helpers/http-model.mjs";
import type { FixtureChatRequest } from "./helpers/http-model.mjs";
import type { RequirementDraft, RequirementIssue, SystemCheck, PreflightAssessment, PreflightResponse, CalculationRequest, Consultation, RequirementDerivation } from "../src/contracts/requirements.mjs";
import type { ProviderIntegrations } from "../src/requirements/requirement-provider-port.mjs";
import { recordArray } from "./helpers/m7-test-boundaries.mjs";
import { fixtureChatRequest } from "./helpers/http-model.mjs";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import { failureFields } from "./helpers/failure-fields.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { Ajv } from "ajv";
import { makeProviders } from "../src/requirements/providers.mjs";
import { calculateRequirementDerivation } from "../src/requirements/requirement-calculations.mjs";
import { consultationGate, currentDeferredIssues, evaluateConsultation, newConsultation, preflightRequirementIds, validateIssueDecisions } from "../src/requirements/consultation.mjs";
import { safePreflightDiagnostic } from "../src/requirements/preflight-diagnostics.mjs";
import { createPlatformSnapshot } from "../src/architecture/platform-contract.mjs";
import { validDraft } from "./helpers/architecture.mjs";
import { sufficientPreflight } from "./helpers/consultation.mjs";

type CalculationChat = { messages: { content?: FixtureChatRequest["messages"][number]["content"] }[] };
interface CalculationPayload { derivations?: RequirementDerivation[]; systemBases: { basisHash: string }[]; decisionSchema: import("../src/contracts/tools.mjs").ToolSchema; knownIssues: RequirementIssue[] }

const draft = (): RequirementDraft => ({ ...validDraft("完整核对有界记录"), taskSpec: { version: 1, items: [] } });
const problem = (): RequirementIssue => ({ id: "capacity", owner: "system", stage: "requirements", blocking: true,
  question: "实际输入输出结构能否在宿主边界内完整处理？", impact: "决定方案是否有可行承载路径", requirementIds: ["task", "deliverable"], checks: ["platform.runtime"] });
const request = (): CalculationRequest => ({ issueId: "capacity", requirementIds: ["task", "deliverable"],
  premises: [{ id: "items", value: "73", unit: "count", source: { kind: "requirement", reference: "task", detail: "候选数量上界；是否由真实需求支持须独立复核" } }],
  expressions: [{ id: "output", unit: "utf16_units", formula: { op: "multiply", args: [{ ref: "items" }, { value: "19" }] } }] });
const verification = (issues: Pick<RequirementIssue, "id">[]): SystemCheck[] => issues.map((issue) => ({ id: issue.id, status: "verified", message: "只读取平台真实契约，尚未执行生成代码", evidence: [
  { source: "platform", reference: "platform.runtime", detail: "宿主提供受限文件写入和任务处理接口；不证明专属业务已验收" },
] }));
const assessment = async (issues: RequirementIssue[] = []): Promise<PreflightAssessment> => ({ ...await sufficientPreflight(), verdict: issues.some((issue) => issue.blocking && issue.owner === "user")
  ? "needs_input" : issues.some((issue) => issue.blocking) ? "blocked" : "sufficient", issues });
function scripted(responses: (object | ((input: FixtureChatRequest) => unknown | Promise<unknown>))[], integrations: ProviderIntegrations = {}) {
  const requests: FixtureChatRequest[] = [];
  const providers = makeProviders({ llmConfigured: true, chatUrl: "https://model.invalid/chat", model: "fixture", apiKey: "fixture" },
    async (_url, options) => {
      const input = fixtureChatRequest(String(options!.body)); requests.push(input);
      const response = responses[Math.min(requests.length - 1, responses.length - 1)];
      const value = typeof response === "function" ? await response(input) : response;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { status: 200 });
    }, integrations);
  return { ...providers, requests };
}
function reviewWithDerivation(input: CalculationChat, stage = "development") {
  const payload: CalculationPayload = JSON.parse(fixtureString(input.messages[1]!.content));
  assert.ok(payload.derivations?.length);
  const derivation = payload.derivations[0];
  assert.deepEqual(derivation!.premises, request().premises);
  assert.deepEqual(derivation!.expressions[0]!.formula, request().expressions[0]!.formula);
  assert.equal(derivation!.expressions[0]!.unit, "utf16_units"); assert.equal(derivation!.expressions[0]!.value, "1387");
  assert.equal(derivation!.status, "calculated");
  const result = { decisions: [{ issueId: "capacity", owner: "system", stage, status: "open", checks: ["platform.runtime"],
    derivationIds: [derivation!.id], evidence: [], reason: stage === "development"
      ? "已复核给定前提、单位和输出公式与需求相符，平台有承载路径；完整实现及最大边界仍必须研发真实验收"
      : "算术虽正确，但前提覆盖不足，仍缺技术依据，不能解除当前系统阻断" }] };
  const validate = new Ajv({ strict: false }).compile(payload.decisionSchema);
  assert.equal(validate(result), true);
  for (const owner of ["user", "runtime"]) {
    const changed = structuredClone(result); changed.decisions[0]!.owner = owner;
    changed.decisions[0]!.stage = owner === "user" ? "requirements" : "runtime"; Reflect.deleteProperty(changed.decisions[0]!, "checks");
    assert.equal(validate(changed), false, "用户与未来输入决定不能用计算编号替代各自依据");
  }
  return result;
}

test("核实与计算共享两次预算，独立复核看到完整推导；后移义务持久绑定并可重算", async () => {
  const value = draft(), platform = createPlatformSnapshot(), issue = problem(); let checks = 0;
  const real = scripted([await assessment([issue]), { calculate: request() }, await assessment([issue]),
    (input: FixtureChatRequest) => reviewWithDerivation(input), await assessment([{ ...issue, stage: "development", blocking: false }])], {
    verifySystemIssues: async ({ issues }) => { checks++; return verification(issues); },
  });
  let output: PreflightResponse | undefined;
  const result = await evaluateConsultation({ draft: value, consultation: newConsultation(), platform, requestId: "calculated",
    preflight: async (input) => { output = await real.preflight!(input); return output; } });
  assert.equal(real.requests.length, 5); assert.equal(checks, 1);
  const saved = result.assessments.at(-1);
  assert.equal(saved!.failure, undefined); assert.equal(saved!.verdict, "sufficient");
  assert.equal(saved!.derivations![0]!.status, "calculated");
  assert.equal(saved!.systemChecks![0]!.evidence.some((item) => item.source === "calculation"), false);
  assert.equal(saved!.deferredIssues![0]!.stage, "development");
  assert.deepEqual(saved!.deferredIssues![0]!.stageDecision.derivationIds, [saved!.derivations![0]!.id]);
  assert.equal(consultationGate(value, result, platform).allowed, true);
  const deferred = currentDeferredIssues(value, structuredClone(result), platform);
  assert.deepEqual(deferred!.issues[0]!.derivations, saved!.derivations);
  assert.equal(objectFields(output!.preflightDiagnostic).readOnlyCalls, 2); assert.equal(objectFields(output!.preflightDiagnostic).systemVerificationCalls, 1);
  assert.equal(objectFields(output!.preflightDiagnostic).calculationCalls, 1); assert.equal(objectFields(output!.preflightDiagnostic).researchCalls, 0);
  for (const change of [
    (copy: Consultation) => { copy.assessments.at(-1)!.derivations![0]!.expressions[0]!.value = "0"; },
    (copy: Consultation) => { copy.assessments.at(-1)!.derivations![0]!.platformHash = "0".repeat(64); },
    (copy: Consultation) => { copy.assessments.at(-1)!.issueDecisions![0]!.derivationIds = ["missing"]; },
    (copy: Consultation) => { delete copy.assessments.at(-1)!.issueDecisions; },
  ]) {
    const changed = structuredClone(result); change(changed);
    assert.equal(consultationGate(value, changed, platform).reason, "assessment_invalid");
  }
});

test("数值结果不会自动关闭系统问题，独立评审可拒绝不充分的前提", async () => {
  const issue = problem(), value = draft(), platform = createPlatformSnapshot();
  const real = scripted([await assessment([issue]), { calculate: request() }, await assessment([issue]),
    (input: FixtureChatRequest) => reviewWithDerivation(input, "requirements")], { verifySystemIssues: async ({ issues }) => verification(issues) });
  const result = await evaluateConsultation({ draft: value, consultation: newConsultation(), platform, requestId: "still_blocked", preflight: real.preflight });
  assert.equal(real.requests.length, 4); assert.equal(result.assessments.at(-1)!.verdict, "blocked");
  assert.equal(result.issues[0]!.status, "open"); assert.equal(result.issues[0]!.blocking, true);
  assert.equal(consultationGate(value, result, platform).reason, "capability_blocked");
});

test("重复计算和格式失败都不能突破原两次只读与六回合预算，诊断不泄露参数", async () => {
  const input = request(); input.premises[0]!.source.detail = "PRIVATE_CALCULATION_DETAIL";
  const real = scripted([{ calculate: input }]);
  await assert.rejects(real.preflight!({ draft: draft(), platform: createPlatformSnapshot(), previousIssues: [problem()] }), (error) => {
    const diagnostic = objectFields(failureFields(error).preflightDiagnostic);
    assert.equal(diagnostic.modelTurns, 6); assert.equal(diagnostic.readOnlyCalls, 2); assert.equal(diagnostic.calculationCalls, 2);
    assert.equal(diagnostic.researchCalls, 0); assert.equal(diagnostic.systemVerificationCalls, 0);
    assert.ok(recordArray(diagnostic.events).some((event) => event.reason === "read_budget_exhausted"));
    assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_CALCULATION_DETAIL|premises|formula/);
    return true;
  });
  assert.equal(real.requests.length, 6);
  const bad = request(); bad.expressions[0]!.formula = { op: "execute", args: [] };
  const invalid = scripted([{ calculate: bad }]);
  await assert.rejects(invalid.preflight!({ draft: draft(), platform: createPlatformSnapshot(), previousIssues: [problem()] }), (error) => {
    assert.equal(objectFields(failureFields(error).preflightDiagnostic).calculationCalls, undefined); assert.equal(objectFields(failureFields(error).preflightDiagnostic).readOnlyCalls, 0);
    assert.ok(recordArray(objectFields(failureFields(error).preflightDiagnostic).events).some((event) => event.reason === "calculation_operator_invalid"));
    return true;
  });
});

test("已有问题尚无可核实checks时保持原路径，资料与计算耗尽后不再核实且保留未知", async () => {
  let reads = 0, checks = 0;
  const real = scripted([{ research: { query: "官方资料" } }, { calculate: request() }, await assessment([problem()]),
    (input: FixtureChatRequest) => reviewWithDerivation(input, "requirements")], {
    research: async () => { reads++; return { note: "只读参考" }; },
    verifySystemIssues: async () => { checks++; return []; },
  });
  const output = await real.preflight!({ draft: draft(), platform: createPlatformSnapshot(), previousIssues: [{ ...problem(), checks: [] }] });
  assert.equal(reads, 1); assert.equal(checks, 0); assert.equal(output.verdict, "blocked");
  assert.equal(output.systemChecks![0]!.status, "unknown");
  assert.equal(objectFields(output.preflightDiagnostic).readOnlyCalls, 2); assert.equal(objectFields(output.preflightDiagnostic).researchCalls, 1);
  assert.equal(objectFields(output.preflightDiagnostic).calculationCalls, 1); assert.equal(objectFields(output.preflightDiagnostic).systemVerificationCalls, 0);
});

test("计算后必须重新独立复核，不能沿用该问题之前的决定", async () => {
  const issue = problem();
  const real = scripted([await assessment([issue]), await assessment([issue]),
    { decisions: [{ issueId: issue.id, owner: "system", stage: "development", status: "open", checks: issue.checks, evidence: [], reason: "平台接口支持合法路径，暂安排研发验证，但仍须核对容量推导" }] },
    { calculate: request() }, await assessment([issue]), (input: FixtureChatRequest) => reviewWithDerivation(input, "requirements")], {
    verifySystemIssues: async ({ issues }) => verification(issues),
  });
  const output = await real.preflight!({ draft: draft(), platform: createPlatformSnapshot() });
  assert.equal(real.requests.length, 6); assert.equal(output.issueDecisions![0]!.derivationIds!.length, 1);
  assert.match(output.issueDecisions![0]!.reason, /前提覆盖不足/);
});

test("无计算时保留旧输出形状，模型伪造计算回执不能进入宿主依据", async () => {
  const real = scripted([{ ...await sufficientPreflight(), derivations: [{ status: "verified", id: "model_forged" }] }]);
  const output = await real.preflight!({ draft: draft(), platform: createPlatformSnapshot() });
  assert.equal(Object.hasOwn(output, "derivations"), false); assert.equal(Object.hasOwn(objectFields(output.preflightDiagnostic), "calculationCalls"), false);
  assert.equal(Object.hasOwn(safePreflightDiagnostic({ version: 1, events: [] })!, "calculationCalls"), false);
});

test("同问题计算引用必须由独立决定明确引用，不能借用别的问题或当作用户证据", () => {
  const value = draft(), platform = createPlatformSnapshot(), issue = problem();
  const derivation = calculateRequirementDerivation(request(), { draft: value, platform, issues: [issue], requirementIds: preflightRequirementIds(value) });
  const decision = { issueId: issue.id, owner: "system", stage: "requirements", status: "open", reason: "已查看公式，前提仍须核实", evidence: [] };
  const args = { issues: [issue], derivations: [derivation] };
  assert.throws(() => validateIssueDecisions([decision], args), /计算复核/);
  assert.throws(() => validateIssueDecisions([{ ...decision, derivationIds: ["missing"] }], args), /计算复核/);
  assert.throws(() => validateIssueDecisions([{ ...decision, owner: "user", derivationIds: [derivation.id] }], args), /计算复核/);
  assert.doesNotThrow(() => validateIssueDecisions([{ ...decision, derivationIds: [derivation.id] }], args));
});

test("系统计算后可独立改归用户选择，算术留存但不替用户作决定", async () => {
  const issue = problem(), value = draft(), platform = createPlatformSnapshot();
  const userIssue: RequirementIssue = { ...issue, owner: "user", question: "不同交付深度需要哪一种？" }; delete userIssue.checks;
  const real = scripted([await assessment([issue]), { calculate: request() }, await assessment([issue]),
    { decisions: [{ issueId: issue.id, owner: "user", stage: "requirements", status: "open", reason: "算术可重算，但真实需求缺少会改变输出范围的业务前提，交给用户选择", evidence: [] }] },
    await assessment([userIssue])], { verifySystemIssues: async ({ issues }) => verification(issues) });
  const result = await evaluateConsultation({ draft: value, consultation: newConsultation(), platform, requestId: "reclassified", preflight: real.preflight });
  assert.equal(real.requests.length, 5); assert.equal(result.assessments.at(-1)!.failure, undefined);
  assert.equal(result.assessments.at(-1)!.derivations![0]!.status, "calculated");
  assert.equal(result.issues[0]!.owner, "user"); assert.equal(result.issues[0]!.status, "open");
  assert.equal(Object.hasOwn(result.issues[0]!.resolution!, "derivationIds"), false);
  assert.equal(consultationGate(value, structuredClone(result), platform).reason, "needs_input");
});

test("系统转用户后不能用算术替代用户原话来关闭，用户问题也不能直接发起计算", async () => {
  const issue = problem(), value = draft(), platform = createPlatformSnapshot();
  const real = scripted([await assessment([issue]), { calculate: request() }, await assessment([issue]),
    { decisions: [{ issueId: issue.id, owner: "user", stage: "requirements", status: "resolved", reason: "已有计算所以视作用户已选择", evidence: [] }] }],
  { verifySystemIssues: async ({ issues }) => verification(issues) });
  const result = await evaluateConsultation({ draft: value, consultation: newConsultation(), platform, requestId: "no_user_evidence", preflight: real.preflight });
  assert.equal(real.requests.length, 6); assert.equal(result.assessments.at(-1)!.failure, "budget_exhausted");
  assert.equal(consultationGate(value, result, platform).allowed, false);
  const user: RequirementIssue = { ...issue, owner: "user" }; delete user.checks;
  const direct = scripted([{ calculate: request() }]);
  await assert.rejects(direct.preflight!({ draft: value, platform, previousIssues: [user] }), (error) => {
    assert.ok(recordArray(objectFields(failureFields(error).preflightDiagnostic).events).some((entry) => entry.reason === "calculation_reference_invalid"));
    assert.equal(objectFields(failureFields(error).preflightDiagnostic).calculationCalls, undefined); assert.equal(objectFields(failureFields(error).preflightDiagnostic).readOnlyCalls, 0); return true;
  });
});

function continuationReview(input: CalculationChat, { stale = false } = {}) {
  const payload: CalculationPayload = JSON.parse(fixtureString(input.messages[1]!.content)), basis = payload.systemBases[0];
  return { decisions: [{ issueId: "capacity", owner: "system", stage: "requirements", status: "open", checks: ["platform.runtime"],
    evidence: [], reason: "本轮算术成立，输出转义的业务前提仍需核对；相同阻断结论可以保留，但依据必须对应本轮事实。",
    ...(payload.derivations?.length ? { derivationIds: payload.derivations.map((item) => item.id) } : {}),
    ...(!stale ? { progress: { basisHash: basis!.basisHash, established: "已核对输入条数及当前宿主能力，算术不代表转义边界已证明。",
      missing: "还缺输出字段编码后字节数的完整上界。", nextAction: { kind: "calculate", detail: "根据实际输出字段和转义规则重算输出上界。" } } } : {}),
  }] };
}

test("协商把完整回执续接给新评估，历史评语单列；正常阻断保存进展和安全诊断", async () => {
  const value = draft(), platform = createPlatformSnapshot(), issue = problem();
  const first = scripted([await assessment([issue]), { calculate: request() }, await assessment([issue]),
    (input: FixtureChatRequest) => reviewWithDerivation(input, "requirements")], { verifySystemIssues: async ({ issues }) => verification(issues) });
  const initial = await evaluateConsultation({ draft: value, consultation: newConsultation(), platform, requestId: "first", preflight: first.preflight });
  assert.equal(objectFields(initial.assessments.at(-1)!.diagnostic).stopReason, "capability_blocked");
  const receipt = initial.assessments.at(-1)!.derivations![0];
  initial.evidenceMessages.push({ id: "continue", role: "user", content: "继续核实，不修改业务要求" });
  const next = scripted([await assessment([issue]), await assessment([issue]), continuationReview], {
    verifySystemIssues: async ({ issues }) => verification(issues),
  });
  const result = await evaluateConsultation({ draft: value, consultation: initial, platform, requestId: "second", preflight: next.preflight });
  const sent = JSON.parse(fixtureString(next.requests[0]!.messages[1]!.content)), saved = result.assessments.at(-1);
  assert.deepEqual(sent.historicalDerivations, [receipt]);
  assert.equal(Object.hasOwn(sent.previousIssues[0], "resolution"), false);
  assert.equal(sent.historicalDecisions[0].historicalOnly, true);
  assert.equal(saved!.verdict, "blocked"); assert.equal(saved!.failure, undefined); assert.equal(objectFields(saved!.diagnostic).modelTurns, 3);
  assert.deepEqual(objectFields(saved!.diagnostic).reusedDerivationIds, [receipt!.id]); assert.equal(objectFields(saved!.diagnostic).readOnlyCalls, 1);
  assert.equal(Object.hasOwn(objectFields(saved!.diagnostic), "calculationCalls"), false, "重算核对旧公式不占新的只读调用");
  assert.equal(saved!.systemProgress![0]!.nextAction.kind, "calculate"); assert.equal(objectFields(saved!.systemProgress![0]!.derivationIds)[0], receipt!.id);
  assert.deepEqual(objectFields(saved!.diagnostic).pendingActions, [{ issueId: "capacity", kind: "calculate" }]);
  assert.equal(consultationGate(value, result, platform).allowed, false);
});

test("旧依据缺少当前进展时至多纠正一次，并在原六轮预算内独立复核", async () => {
  const value = draft(), platform = createPlatformSnapshot(), issue = problem();
  const receipt = calculateRequirementDerivation(request(), { draft: value, platform, issues: [issue],
    requirementIds: preflightRequirementIds(value), verification: verification([issue]) });
  const real = scripted([await assessment([issue]), await assessment([issue]), (input: FixtureChatRequest) => continuationReview(input, { stale: true }),
    await assessment([issue]), continuationReview], { verifySystemIssues: async ({ issues }) => verification(issues) });
  const output = await real.preflight!({ draft: value, platform, previousIssues: [issue], priorDerivations: [receipt] });
  assert.equal(real.requests.length, 5); assert.equal(output.verdict, "blocked");
  assert.equal(objectFields(output.preflightDiagnostic).correctiveContinuations, 1); assert.equal(objectFields(output.preflightDiagnostic).readOnlyCalls, 1);
  assert.ok(recordArray(objectFields(output.preflightDiagnostic).events).some((event) => event.reason === "system_basis_stale"));
  const again = scripted([await assessment([issue]), await assessment([issue]), (input: FixtureChatRequest) => continuationReview(input, { stale: true }),
    await assessment([issue]), (input: FixtureChatRequest) => continuationReview(input, { stale: true })], { verifySystemIssues: async ({ issues }) => verification(issues) });
  await assert.rejects(again.preflight!({ draft: value, platform, previousIssues: [issue], priorDerivations: [receipt] }), (error) => {
    assert.equal(failureFields(error).reason, "system_basis_stale"); assert.equal(objectFields(failureFields(error).preflightDiagnostic).correctiveContinuations, 1);
    assert.equal(objectFields(failureFields(error).preflightDiagnostic).modelTurns, 5); assert.equal(objectFields(failureFields(error).preflightDiagnostic).stopReason, "system_basis_stale"); return true;
  });
});

test("新连接事实使相关历史记录失效，旧评语引用不能充当当前容量证明", async () => {
  const value = draft(), platform = createPlatformSnapshot(), issue = problem();
  const input = request(); input.premises.push({ id: "framing", value: "574", unit: "bytes", source: {
    kind: "platform", reference: "platform.runtime", detail: "当前连接封装的只读测量，配置变更必须重算" } });
  const oldChecks = verification([issue]), receipt = calculateRequirementDerivation(input, { draft: value, platform, issues: [issue],
    requirementIds: preflightRequirementIds(value), verification: oldChecks });
  const freshChecks = verification([issue]); freshChecks[0]!.evidence.push({ source: "platform", reference: "platform.runtime",
    detail: JSON.stringify({ type: "current_connection_framing", bytes: 600, snapshotHash: "b".repeat(64) }) });
  const real = scripted([await assessment([issue]), await assessment([issue]), continuationReview], { verifySystemIssues: async () => freshChecks });
  const output = await real.preflight!({ draft: value, platform, previousIssues: [issue], priorDerivations: [receipt] });
  assert.equal(output.verdict, "blocked"); assert.equal(output.derivations, undefined);
  assert.deepEqual(objectFields(output.preflightDiagnostic).invalidatedDerivationIds, [receipt.id]);
  assert.deepEqual(objectFields(output.preflightDiagnostic).reusedDerivationIds, []);
  assert.equal(output.systemProgress![0]!.nextAction.kind, "calculate");
  const firstReview = JSON.parse(fixtureString(real.requests[2]!.messages[1]!.content));
  assert.equal(firstReview.historicalDerivations[0].id, receipt.id);
  assert.equal(firstReview.proofContinuation.invalidated[0].id, receipt.id);
});

test("失效计算的结构化引用只纠正一次；余量不足以重评和独立复核时立即保留未完成", async () => {
  const value = draft(), platform = createPlatformSnapshot(), issue = problem(), input = request();
  input.premises.push({ id: "overhead", value: "574", unit: "bytes", source: { kind: "platform", reference: "platform.runtime", detail: "当前封装" } });
  const receipt = calculateRequirementDerivation(input, { draft: value, platform, issues: [issue],
    requirementIds: preflightRequirementIds(value), verification: verification([issue]) });
  const current = verification([issue]); current[0]!.evidence[0]!.detail += "连接配置已改变";
  const invalidReference = (body: { messages: { content: string; }[]; }) => {
    const result = continuationReview(body); result.decisions[0]!.derivationIds = [receipt.id]; return result;
  };
  const real = scripted([await assessment([issue]), await assessment([issue]), invalidReference, await assessment([issue]), invalidReference],
    { verifySystemIssues: async () => current });
  await assert.rejects(real.preflight!({ draft: value, platform, previousIssues: [issue], priorDerivations: [receipt] }), (error) => {
    assert.equal(failureFields(error).reason, "system_basis_stale"); assert.equal(objectFields(failureFields(error).preflightDiagnostic).modelTurns, 5);
    assert.equal(objectFields(failureFields(error).preflightDiagnostic).correctiveContinuations, 1); return true;
  });
  const late = scripted([{}, {}, await assessment([issue]), await assessment([issue]), (body: { messages: { content: string; }[]; }) => continuationReview(body, { stale: true })],
    { verifySystemIssues: async () => current });
  await assert.rejects(late.preflight!({ draft: value, platform, previousIssues: [issue], priorDerivations: [receipt] }), (error) => {
    assert.equal(failureFields(error).reason, "system_basis_stale"); assert.equal(objectFields(failureFields(error).preflightDiagnostic).modelTurns, 5);
    assert.equal(objectFields(failureFields(error).preflightDiagnostic).correctiveContinuations, undefined, "不能只给候选多一轮却没有独立复核预算"); return true;
  });
});

test("先请求平台计算也在同一共享预算内先核实事实再绑定，避免本轮晚到事实使新回执过期", async () => {
  const value = draft(), platform = createPlatformSnapshot(), issue = problem(), input = request();
  input.premises.push({ id: "overhead", value: "574", unit: "bytes", source: { kind: "platform", reference: "platform.runtime", detail: "当前封装" } });
  const real = scripted([{ calculate: input }, await assessment([issue]), (body: { messages: { content: string; }[]; }) => continuationReview(body)], {
    verifySystemIssues: async ({ issues }) => verification(issues),
  });
  const result = await evaluateConsultation({ draft: value, consultation: { ...newConsultation(), issues: [issue] }, platform,
    requestId: "calculate_first", preflight: real.preflight });
  assert.equal(result.assessments.at(-1)!.failure, undefined); assert.equal(result.assessments.at(-1)!.verdict, "blocked");
  assert.equal(objectFields(result.assessments.at(-1)!.diagnostic).readOnlyCalls, 2);
  assert.equal(objectFields(result.assessments.at(-1)!.diagnostic).systemVerificationCalls, 1);
  assert.equal(objectFields(result.assessments.at(-1)!.diagnostic).calculationCalls, 1);
});

test("已有平台与激活义务首轮合并核实，无效计算修复不额外占只读预算", async () => {
  const value = draft(), platform = createPlatformSnapshot(), issue = problem(), input = request();
  input.premises.push({ id: "overhead", value: "574", unit: "bytes", source: { kind: "platform", reference: "platform.runtime", detail: "当前封装" } });
  const invalid = structuredClone(input); Reflect.deleteProperty(invalid, "expressions");
  const obligations = ["python-runtime-preparation", "gateway-api-mcp-registration"].map<RequirementIssue>((id) => ({ ...issue, id, blocking: false, stage: "activation" }));
  let verifiedIds: string[] | undefined;
  const real = scripted([{ calculate: invalid }, { calculate: input }, await assessment([issue, ...obligations]), (body: { messages: { content: string; }[]; }) => {
    const payload: CalculationPayload = JSON.parse(fixtureString(body.messages[1]!.content)), receipt = payload.derivations![0];
    return { decisions: payload.knownIssues.map((known) => ({ issueId: known.id, owner: "system", stage: known.stage, status: "open",
      checks: known.checks, evidence: [], reason: known.id === issue.id ? "算术已核对，输出上界的前提仍缺依据" : "平台承载已核实，实际准备与接口授权仍待激活验收",
      ...(known.id === issue.id ? { derivationIds: [receipt!.id] } : {}) })) };
  }], { verifySystemIssues: async ({ issues }) => { verifiedIds = issues.map((item) => item.id); return verification(issues); } });
  const result = await evaluateConsultation({ draft: value, platform, consultation: { ...newConsultation(), issues: [issue, ...obligations] },
    requestId: "batched_facts_after_repair", preflight: real.preflight });
  const saved = result.assessments.at(-1);
  assert.equal(saved!.failure, undefined); assert.equal(saved!.verdict, "blocked"); assert.equal(objectFields(saved!.diagnostic).modelTurns, 4);
  assert.deepEqual(new Set(verifiedIds), new Set([issue.id, ...obligations.map((item) => item.id)]));
  assert.equal(objectFields(saved!.diagnostic).readOnlyCalls, 2); assert.equal(objectFields(saved!.diagnostic).systemVerificationCalls, 1); assert.equal(objectFields(saved!.diagnostic).calculationCalls, 1);
  assert.equal(saved!.deferredIssues!.length, 2); assert.equal(saved!.systemChecks!.length, 3);
  const feedback = JSON.parse(fixtureString(real.requests[1]!.messages.at(-1)!.content));
  assert.equal(feedback.calculation.receiptGenerated, false); assert.equal(feedback.remainingReadOnlyCalls, 1);
  const initial = JSON.parse(fixtureString(real.requests[0]!.messages[1]!.content));
  assert.deepEqual(new Set(recordArray(initial.systemChecks).map((check) => check.id)), new Set([issue.id, ...obligations.map((item) => item.id)]));
  assert.equal(initial.remainingReadOnlyCalls, 1);
  assert.equal(recordArray(objectFields(saved!.diagnostic).events).some((event) => event.reason === "stage_evidence_missing"), false);
});
