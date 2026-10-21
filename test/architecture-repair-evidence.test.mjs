import test from "node:test";
import assert from "node:assert/strict";
import { historicalRepairSnapshot, validateHistoricalRepairDecision } from "../src/architecture/architecture-repair-evidence.mjs";
import { architectureReviewEvidenceContext } from "../src/architecture/architecture-review-evidence.mjs";
import { designHash } from "../src/architecture/architecture-contract.mjs";
import { runtimeCapabilityContract } from "../src/runtime/runtime-capability-contract.mjs";
import { ACCEPTANCE_ADAPTER_GUIDE } from "../src/verification/acceptance-contract.mjs";
import { validDesign } from "./helpers/architecture.mjs";

const factPath = "/adapters/action/executionFacts/dynamicPlaceholders";
const wrongChoice = "写入替身使用<computed-result-json>；执行器会动态展开后匹配真实结果。";
const correctedChoice = "测试前按固定输入构造精确预期文本和完整性值，使用平台支持的常量或夹具；不自动计算业务答案。";

function fixture({ choice = correctedChoice, status = "resolved" } = {}) {
  const oldCandidate = validDesign([], { schemaVersion: 3 });
  oldCandidate.decisions[0].id = "D8_placeholder";
  oldCandidate.decisions[0].choice = wrongChoice;
  const candidate = structuredClone(oldCandidate);
  candidate.decisions[0].id = "D9_placeholder";
  candidate.decisions[0].choice = choice;
  candidate.platformClaims = [{ id: "literal_fixture_contract", source: "acceptanceAdapterGuide", path: factPath,
    expected: false, decisionIds: [candidate.decisions[0].id], acceptanceIds: [] }];
  const finding = { findingId: "historical_finding", kind: "historical-development-review",
    repairBasis: historicalRepairSnapshot(oldCandidate) };
  const row = { findingId: finding.findingId, status, reason: "以本轮实际候选和冻结平台事实核对。",
    checkIds: ["verification"], candidatePaths: ["/decisions/0/choice"] };
  const explanation = { id: finding.findingId, blocking: false, kind: "design", checkId: "verification",
    description: "旧建议未得到平台支持；按当前平台契约核对修订。", remedy: "研发继续冻结独立、可执行的预期数据。",
    candidatePaths: [...row.candidatePaths], references: [
      { source: "candidate", path: "/decisions/0/choice", quote: candidate.decisions[0].choice },
      { source: "acceptanceAdapterGuide", path: factPath, quote: "false" },
    ], factClaims: [] };
  const review = { candidateHash: designHash(candidate), checks: [], issues: [explanation], acceptanceScopeChecks: [] };
  const context = () => architectureReviewEvidenceContext({ design: candidate, requirements: [],
    runtimeCapabilities: runtimeCapabilityContract(), acceptanceAdapterGuide: ACCEPTANCE_ADAPTER_GUIDE });
  const validate = (evidenceContext = context()) => validateHistoricalRepairDecision(row, finding, review, candidate, evidenceContext,
    "review.priorFindingDecisions[0]");
  return { oldCandidate, candidate, finding, row, explanation, review, context, validate };
}

function rejects(f, reason) {
  assert.throws(f.validate, error => error.validationIssue?.reason === reason, reason);
}

test("历史占位符方案只改D8为D9、换序或修改解释均不能声称已修复", () => {
  for (const mutate of [() => {}, f => { f.candidate.decisions[0].reason += " 已重新核对。"; },
    f => { f.candidate.decisions.unshift({ ...f.candidate.decisions[0], id: "unrelated", choice: "新增无关方案" });
      f.row.candidatePaths = ["/decisions/1/choice"]; }]) {
    const f = fixture({ choice: wrongChoice }); mutate(f);
    rejects(f, "repair_basis_unchanged");
  }
});

test("真正修改相关选择并以当前平台值和逐字说明复核可通过机械证据门槛，不修改旧记录", () => {
  const f = fixture(), before = structuredClone({ oldCandidate: f.oldCandidate, finding: f.finding, candidate: f.candidate, review: f.review });
  assert.doesNotThrow(f.validate);
  assert.deepEqual({ oldCandidate: f.oldCandidate, finding: f.finding, candidate: f.candidate, review: f.review }, before);
  const reloaded = structuredClone(f.finding);
  assert.doesNotThrow(() => validateHistoricalRepairDecision(f.row, reloaded, f.review, f.candidate, f.context()));
});

test("修改了方案也不能凭一句已修复或复制旧remedy关闭", () => {
  const missing = fixture(); missing.review.issues = [];
  rejects(missing, "repair_counterevidence_missing");
  const copied = fixture(); copied.explanation.references = [{ source: "developmentRevision", path: "/feedback/review/issues/0/remedy", quote: "旧建议" }];
  rejects(copied, "reference_source_invalid");
});

test("错误平台声明被当前事实拒绝，真实但无关的平台引用不能关闭", () => {
  const falseFact = fixture(); falseFact.candidate.platformClaims[0].expected = true;
  rejects(falseFact, "platform_fact_mismatch");
  const unrelated = fixture(); unrelated.explanation.references[1] = {
    source: "acceptanceAdapterGuide", path: "/adapters/action/proves", quote: ACCEPTANCE_ADAPTER_GUIDE.adapters.action.proves,
  };
  rejects(unrelated, "repair_platform_reference_unrelated");
  const noClaim = fixture(); delete noClaim.candidate.platformClaims;
  rejects(noClaim, "repair_platform_basis_missing");
  const wrongTarget = fixture(); wrongTarget.candidate.platformClaims[0].decisionIds = ["unrelated"];
  rejects(wrongTarget, "repair_platform_basis_missing");
});

test("反证必须对应同一缺陷、当前实质候选内容，不能只引用编号或无关说明", () => {
  const alias = fixture(); alias.explanation.id = "another_finding";
  rejects(alias, "repair_counterevidence_missing");
  const id = fixture(); id.row.candidatePaths = ["/decisions/0/id"];
  rejects(id, "repair_candidate_basis_missing");
  const reason = fixture(); reason.row.candidatePaths = ["/decisions/0/reason"];
  rejects(reason, "repair_candidate_basis_missing");
  const unrelated = fixture(); unrelated.explanation.references[0] = { source: "candidate", path: "/instructions", quote: unrelated.candidate.instructions };
  rejects(unrelated, "repair_candidate_reference_unrelated");
  const idQuote = fixture(); idQuote.row.candidatePaths = ["/decisions/0"];
  idQuote.explanation.candidatePaths = ["/decisions/0"];
  idQuote.explanation.references[0] = { source: "candidate", path: "/decisions/0", quote: idQuote.candidate.decisions[0].id };
  rejects(idQuote, "repair_candidate_reference_unrelated");
});

test("原意见确实错误时可用当前双来源反证推翻，无需伪造修改或继承旧建议", () => {
  const f = fixture({ status: "unsupported" });
  f.finding.repairBasis = historicalRepairSnapshot(f.candidate);
  assert.doesNotThrow(f.validate);
  f.explanation.references[1].quote = "true";
  rejects(f, "reference_quote_mismatch");
});

test("缺少或损坏旧依据不能声称改动，缺少当前来源或摘要陈旧不能关闭", () => {
  for (const mutate of [f => { delete f.finding.repairBasis; }, f => { f.finding.repairBasis.anchors[0].coreHash = "0".repeat(64); }]) {
    const f = fixture(); mutate(f); rejects(f, "repair_source_basis_unavailable");
  }
  const f = fixture(), context = f.context(); context.acceptanceAdapterGuide.adapters.action.proves += "变更";
  assert.throws(() => f.validate(context), error => error.validationIssue.reason === "repair_context_unavailable");
  let invoked = false;
  const malformed = {}; Object.defineProperty(malformed, "candidate", { enumerable: true, get() { invoked = true; return f.candidate; } });
  assert.throws(() => f.validate(malformed), error => error.validationIssue.reason === "repair_context_unavailable");
  assert.equal(invoked, false);
});

test("验收内容比较排除编号及顺序，普通computed字面数据不按词语黑名单拒绝", () => {
  const f = fixture(); f.oldCandidate.acceptance[0].input = "用户输入<computed-result-json>普通文本";
  f.finding.repairBasis = historicalRepairSnapshot(f.oldCandidate);
  f.candidate.acceptance[0] = { ...f.oldCandidate.acceptance[0], id: "renamed" };
  f.row.candidatePaths = ["/acceptance/0/input"];
  rejects(f, "repair_basis_unchanged");
  f.candidate.decisions[0].choice = "按用户要求原样输出<computed-result-json>字面文字，不展开。";
  f.row.candidatePaths = ["/decisions/0/choice"];
  f.explanation.references[0].quote = f.candidate.decisions[0].choice;
  assert.doesNotThrow(f.validate);
});

test("未解决判断不被强制关闭，旧普通评审路径不新增此门槛", () => {
  const f = fixture(); f.row.status = "unresolved";
  assert.doesNotThrow(() => f.validate(null));
  f.row.status = "resolved"; f.finding.kind = "historical-review-opinion";
  assert.doesNotThrow(() => f.validate(null));
});

test("新宿主账本的普通架构缺陷可在原相关字段修复，不强迫新增无关平台声明", () => {
  for (const [path, value] of [
    ["/failureHandling/0/response", "保留任务并提示重新选择输入"],
    ["/components/0/outputs", "结果和逐项错误清单"],
    ["/steps/0/completion", "所有记录均有处理结果或明确错误"],
    ["/state/mode", "agent"],
    ["/instructions", "逐条处理并保存明确的错误信息"],
  ]) {
    const f = fixture(); f.finding.kind = "historical-review-opinion";
    f.finding.closureEvidenceRequired = true; f.finding.issue = { kind: "design" };
    delete f.candidate.platformClaims;
    const keys = path.slice(1).split("/");
    let target = f.candidate; for (const key of keys.slice(0, -1)) target = target[key];
    target[keys.at(-1)] = value;
    f.row.candidatePaths = [path]; f.explanation.candidatePaths = [path];
    f.explanation.references = [{ source: "candidate", path, quote: value }];
    assert.doesNotThrow(f.validate, path);
    target[keys.at(-1)] = keys.reduce((body, key) => body[key], f.oldCandidate);
    rejects(f, "repair_basis_unchanged");
  }
});

test("普通架构旧意见可被真实反证推翻；显式平台类仍须当前平台证明", () => {
  const f = fixture({ status: "unsupported" });
  f.finding.kind = "historical-review-opinion"; f.finding.closureEvidenceRequired = true;
  f.finding.issue = { kind: "design" }; delete f.candidate.platformClaims;
  f.explanation.references = [f.explanation.references[0]];
  assert.doesNotThrow(f.validate);
  f.finding.issue.kind = "platform";
  rejects(f, "repair_platform_basis_missing");
});

test("步骤关联实体仅改编号、依赖换序及对象属性换序不算实质修改", () => {
  const f = fixture(); f.finding.kind = "historical-review-opinion";
  f.finding.closureEvidenceRequired = true; f.finding.issue = { kind: "design" };
  f.candidate.components[0].id = "renamed_component";
  f.candidate.steps[0].id = "renamed_step"; f.candidate.steps[0].componentId = "renamed_component";
  f.row.candidatePaths = ["/steps/0"]; f.explanation.candidatePaths = ["/steps/0"];
  rejects(f, "repair_basis_unchanged");
  f.row.candidatePaths = ["/acceptance/0"];
  f.candidate.acceptance[0].verification = { adapterId: "action", owner: "generated-code", stage: "development" };
  rejects(f, "repair_basis_unchanged");
});

test("新增无关决策或占用旧位置却把旧错误移到别处，不能冒充对应修订", () => {
  const appended = fixture();
  appended.candidate.decisions[0].choice = wrongChoice;
  appended.candidate.decisions.push({ ...appended.candidate.decisions[0], id: "unrelated", choice: "新增无关功能" });
  appended.row.candidatePaths = ["/decisions/1/choice"];
  rejects(appended, "repair_candidate_basis_unrelated");
  const shifted = fixture(); shifted.candidate.decisions[0].choice = wrongChoice;
  shifted.candidate.decisions.unshift({ ...shifted.candidate.decisions[0], id: "unrelated", choice: "新增无关功能" });
  shifted.row.candidatePaths = ["/decisions/0/choice"];
  rejects(shifted, "repair_basis_unchanged");
});

test("真实修订可保留旧编号后移动，编号优先对应原实体而非占位后的其他决策", () => {
  const f = fixture(); f.candidate.decisions[0].id = f.oldCandidate.decisions[0].id;
  f.candidate.platformClaims[0].decisionIds = [f.oldCandidate.decisions[0].id];
  f.candidate.decisions.unshift({ ...f.candidate.decisions[0], id: "unrelated", choice: "新增独立功能" });
  f.row.candidatePaths = ["/decisions/1/choice"];
  f.explanation.candidatePaths = [...f.row.candidatePaths]; f.explanation.references[0].path = f.row.candidatePaths[0];
  assert.doesNotThrow(f.validate);
});
