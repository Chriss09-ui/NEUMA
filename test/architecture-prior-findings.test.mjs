import test from "node:test";
import assert from "node:assert/strict";
import { architecturePriorFindings, validateArchitecturePriorFindings, architectureReviewTransitions } from "../src/architecture/architecture-prior-findings.mjs";
import { architectureReviewEvidenceContext } from "../src/architecture/architecture-review-evidence.mjs";
import { designHash, validateReview, reviewSubmissionSchema } from "../src/architecture/architecture-contract.mjs";
import { passingReview, validDesign } from "./helpers/architecture.mjs";
import { ACCEPTANCE_ADAPTER_GUIDE } from "../src/verification/acceptance-contract.mjs";
import { REVIEW_PROMPT } from "../src/architecture/architecture-prompts.mjs";

function fixture({ changed = false, legacy = false } = {}) {
  const original = validDesign([], { schemaVersion: 3 });
  const candidate = structuredClone(original);
  if (changed) candidate.instructions += " 新增明确的失败停止条件。";
  const manifest = (design) => architectureReviewEvidenceContext({ design, requirements: [], runtimeCapabilities: null }).contextManifest;
  const previousReview = passingReview(designHash(original), original);
  previousReview.verdict = "revise";
  previousReview.checks.find((entry) => entry.id === "verification").passed = false;
  previousReview.issues = [{ id: "old_failure", checkId: "verification", blocking: true,
    description: "旧评审认为失败响应不清晰", remedy: "核对失败停止条件", candidatePaths: ["/failureHandling"] }];
  previousReview.acceptanceScopeChecks[0].sufficient = false;
  const previous = { version: 7, candidateHash: designHash(original), review: previousReview,
    ...(legacy ? {} : { reviewEvidence: { snapshot: { contextManifest: manifest(original) } } }) };
  const current = { candidateHash: designHash(candidate), guideHash: manifest(candidate).acceptanceAdapterGuide.sha256,
    contextManifestHash: designHash(manifest(candidate)) };
  const prior = architecturePriorFindings(previous, current);
  const review = passingReview(current.candidateHash, candidate, prior);
  const validate = (value) => validateArchitecturePriorFindings(validateReview(value,
    { candidateHash: current.candidateHash, schemaVersion: 3 }), prior, candidate);
  return { candidate, previous, prior, review, validate };
}

test("上一轮问题绑定版本及当前对象，历史意见不自动成为新阻断或通过", () => {
  const { prior, review, validate } = fixture();
  assert.equal(prior.source.version, 7);
  assert.equal(prior.sameReviewObject, true);
  assert.equal(prior.historicalOnly, true);
  assert.equal(review.priorFindingDecisions[0].status, "unsupported");
  assert.deepEqual(validate(review), review);
  const missing = structuredClone(review); delete missing.priorFindingDecisions;
  assert.throws(() => validate(missing), (error) => error.validationIssue.reason === "missing_coverage");
  assert.ok(reviewSubmissionSchema({ priorFindingsRequired: true }).required.includes("priorFindingDecisions"));
  assert.equal(reviewSubmissionSchema().required.includes("priorFindingDecisions"), false);
});

test("同一方案和依据未变不能伪称已经修改，原意见不成立须明确说明", () => {
  const { prior, review, validate } = fixture();
  review.priorFindingDecisions[0].status = "resolved";
  assert.throws(() => validate(review), (error) => error.validationIssue.reason === "unchanged_review_object");
  const next = fixture({ changed: true });
  assert.equal(next.prior.sameReviewObject, false);
  assert.equal(next.review.priorFindingDecisions[0].status, "resolved");
  assert.doesNotThrow(() => next.validate(next.review));
  assert.equal(prior.source.candidateHash, prior.current.candidateHash);
});

test("遗留记录缺少规则快照时不宣称比较了相同完整依据", () => {
  const { prior, review, validate } = fixture({ legacy: true });
  assert.equal(prior.sameReviewObject, false);
  assert.equal(prior.source.contextManifestHash, null);
  assert.doesNotThrow(() => validate(review));
});

test("上轮问题不能遗漏、冒名、重复，当前依据路径与检查编号必须真实存在", () => {
  const { review, validate } = fixture();
  for (const mutate of [
    (value) => { value.priorFindingDecisions = []; },
    (value) => { value.priorFindingDecisions.push(structuredClone(value.priorFindingDecisions[0])); },
    (value) => { value.priorFindingDecisions[0].findingId = "finding_other"; },
    (value) => { value.priorFindingDecisions[0].candidatePaths = ["/missing"]; },
    (value) => { value.priorFindingDecisions[0].checkIds = ["verification", "verification"]; },
  ]) {
    const value = structuredClone(review); mutate(value);
    assert.throws(() => validate(value));
  }
});

test("仍存在的历史问题必须保留本轮具体阻断，不能关闭后直接通过", () => {
  const { review, validate } = fixture();
  review.priorFindingDecisions[0].status = "unresolved";
  assert.throws(() => validate(review), (error) => error.validationIssue.reason === "missing_open_issue");
  review.verdict = "revise";
  review.checks.find((entry) => entry.id === "verification").passed = false;
  review.issues = [{ id: "current_failure", blocking: true, description: "当前仍缺明确失败响应", remedy: "修正失败处理", checkId: "verification" }];
  assert.doesNotThrow(() => validate(review));
});

test("相同方案与规则下的充分性翻转记录为判断变化，不自动继承任一结论", () => {
  const { prior, review } = fixture();
  const transitions = architectureReviewTransitions(prior, review);
  assert.equal(transitions.unchangedObjectJudgmentChanged, true);
  assert.deepEqual(transitions.scopeJudgmentChanges, [{ acceptanceId: "valid", previousSufficient: false, currentSufficient: true }]);
  assert.equal(architecturePriorFindings({ review: { issues: [] } }, prior.current), null);
  assert.equal(architectureReviewTransitions(null, review), null);
});

test("当前候选摘要不符时拒绝历史问题决议", () => {
  const { candidate, prior, review } = fixture();
  candidate.instructions += " 迟到修改";
  assert.throws(() => validateArchitecturePriorFindings(review, prior, candidate), (error) => error.validationIssue.reason === "candidate_mismatch");
});

function historicalOpinion({ change = () => {}, references, provideCandidate = true } = {}) {
  const original = validDesign([], { schemaVersion: 3, unknowns: [{ question: "历史依赖是否具备？", blocking: false, resolution: "核对公开能力事实" }] });
  const candidate = structuredClone(original); change(candidate);
  const context = (design) => architectureReviewEvidenceContext({ design, requirements: [], runtimeCapabilities: null });
  const previousReview = passingReview(designHash(original), original);
  previousReview.verdict = "revise"; previousReview.checks.find((item) => item.id === "verification").passed = false;
  previousReview.issues = [{ id: "old_claim", blocking: true, checkId: "verification", kind: "design",
    description: "历史评审认为同时包含静态目录检查与动作运行断言。", remedy: "重新核对实际验证范围",
    candidatePaths: ["/acceptance/0/expected"], factClaims: [], references: references ?? [
      { source: "candidate", path: "/acceptance/0/expected", quote: original.acceptance[0].expected },
      { source: "acceptanceAdapterGuide", path: "/adapters/action/proves", quote: ACCEPTANCE_ADAPTER_GUIDE.adapters.action.proves },
    ] }];
  const previous = { version: 5, candidateHash: designHash(original), review: previousReview,
    reviewEvidence: { snapshot: { contextManifest: context(original).contextManifest } } };
  const evidenceContext = context(candidate), current = { candidateHash: designHash(candidate),
    guideHash: evidenceContext.contextManifest.acceptanceAdapterGuide.sha256, contextManifestHash: designHash(evidenceContext.contextManifest) };
  const prior = architecturePriorFindings(previous, current, provideCandidate ? { candidate } : {});
  const review = passingReview(current.candidateHash, candidate, prior);
  const validate = () => validateArchitecturePriorFindings(validateReview(review,
    { candidateHash: current.candidateHash, schemaVersion: 3, evidenceContext }), prior, candidate);
  return { candidate, previous, prior, review, validate, finding: prior.findings[0] };
}

test("旧模型意见逐条标明非当前来源，同路径的新正文不被旧引文冒充", () => {
  const f = historicalOpinion({ change: (candidate) => { candidate.acceptance[0].expected = "只核对冻结输入的实际执行结果。"; } });
  const before = structuredClone(f.previous), finding = f.finding, comparison = finding.candidateReferenceComparison;
  assert.equal(finding.kind, "historical-review-opinion"); assert.equal(finding.trust, "untrusted-reference"); assert.equal(finding.current, false);
  assert.deepEqual(finding.source, f.prior.source); assert.equal(finding.source.version, 5);
  assert.notEqual(finding.source.candidateHash, f.prior.current.candidateHash);
  assert.deepEqual(finding.issue, f.previous.review.issues[0]); assert.equal(finding.issue.blocking, true, "保留来源严重性，不改写旧意见");
  assert.equal(comparison.status, "available"); assert.equal(comparison.scope, "literal-reference-presence-only");
  assert.equal(comparison.candidateHash, f.prior.current.candidateHash);
  assert.deepEqual(comparison.references, [{ referenceIndex: 0, path: "/acceptance/0/expected", currentPathExists: true,
    oldQuoteStillPresent: false, currentValueHash: designHash(f.candidate.acceptance[0].expected) }]);
  assert.equal(JSON.stringify(comparison).includes(f.candidate.acceptance[0].expected), false, "不重复塞入当前完整字段");
  assert.deepEqual(f.previous, before);
  assert.ok(REVIEW_PROMPT.indexOf("先按当前候选的input、expected、decisions") < REVIEW_PROMPT.indexOf("存在priorFindings时"));
  assert.match(REVIEW_PROMPT, /字面变化或消失不自动表示已修复/u);
});

test("旧引文消失不移除必答问题，也不强制本轮通过或保留旧阻断", () => {
  const f = historicalOpinion({ change: (candidate) => { candidate.acceptance[0].expected = "核对当前冻结输入的执行结果。"; } });
  assert.equal(f.prior.findings.length, 1); assert.equal(f.prior.sameReviewObject, false);
  for (const status of ["resolved", "unsupported"]) {
    f.review.priorFindingDecisions[0].status = status; assert.doesNotThrow(f.validate);
  }
  f.review.priorFindingDecisions = [];
  assert.throws(f.validate, (error) => error.validationIssue.reason === "missing_coverage");
  f.review.priorFindingDecisions = [{ findingId: f.finding.findingId, status: "unresolved", reason: "仍有当前明确缺陷",
    checkIds: ["verification"], candidatePaths: ["/acceptance/0/expected"] }];
  assert.throws(f.validate, (error) => error.validationIssue.reason === "missing_open_issue");
  f.review.verdict = "revise"; f.review.checks.find((item) => item.id === "verification").passed = false;
  f.review.issues = [{ id: "current_issue", blocking: true, checkId: "verification", kind: "design", description: "当前新问题仍须独立处理",
    remedy: "按当前正文核对执行条件", candidatePaths: ["/acceptance/0/expected"], factClaims: [],
    references: [{ source: "candidate", path: "/acceptance/0/expected", quote: f.candidate.acceptance[0].expected }] }];
  assert.doesNotThrow(f.validate);
});

test("历史候选引文对照区分仍存在、路径删除及当前材料不可用", () => {
  const unchanged = historicalOpinion();
  assert.equal(unchanged.finding.candidateReferenceComparison.references[0].oldQuoteStillPresent, true);
  const deleted = historicalOpinion({ change: (candidate) => { candidate.unknowns = []; }, references: [
    { source: "candidate", path: "/unknowns/0/question", quote: "历史依赖是否具备？" },
  ] });
  assert.deepEqual(deleted.finding.candidateReferenceComparison.references, [{ referenceIndex: 0, path: "/unknowns/0/question",
    currentPathExists: false, oldQuoteStillPresent: false, currentValueHash: null }]);
  const unavailable = historicalOpinion({ provideCandidate: false });
  assert.equal(unavailable.finding.candidateReferenceComparison.status, "unavailable");
  assert.equal(unavailable.finding.candidateReferenceComparison.reason, "current_candidate_unavailable");
  assert.equal(unavailable.finding.candidateReferenceComparison.references, undefined);
  const legacy = historicalOpinion({ references: [] });
  assert.equal(legacy.finding.candidateReferenceComparison.reason, "historical_candidate_references_missing");
  assert.doesNotThrow(legacy.validate);
});

function planningReference() {
  const source = { agentId: "agent", runId: "failed_planning", recordHash: "a".repeat(64),
    bindingHash: "b".repeat(64), sessionHash: "c".repeat(64), leafId: "last" };
  const issue = { path: "planningFiles.cases[0].kind", reason: "input_rejection_not_rejected",
    remedy: "实际448字节不超过131072，不能证明输入拒绝。", source: { path: "cases.json", localIndex: 0, caseId: "measure" },
    proposedCaseRef: { id: "measure", acceptanceId: "valid", kind: "input-rejection", inputTarget: "task-envelope" } };
  return { schemaVersion: 1, trust: "untrusted-reference", status: "available", source: structuredClone(source), plan: null,
    planningToolFailures: { schemaVersion: 1, trust: "untrusted-reference", current: false, status: "available", source,
      omittedFailures: 0, failures: [{ entryId: "failure", toolCallId: "save", toolName: "save_plan_cases", issues: [issue] }] } };
}

function nativeCounterevidence(review, prior, candidate) {
  const row = review.priorFindingDecisions[0];
  row.candidatePaths = ["/acceptance/0"];
  review.issues.push({ id: row.findingId, blocking: false, kind: "design", checkId: row.checkIds[0],
    description: "原生拒绝保留为历史；当前验收和适配器表明旧负例选择不适用。", remedy: "规划应纠正未接受的负例并重新提交，不继承历史通过。",
    candidatePaths: row.candidatePaths, references: [{ source: "candidate", path: "/acceptance/0/expected", quote: candidate.acceptance[0].expected },
      { source: "acceptanceAdapterGuide", path: "/adapters/action/proves", quote: ACCEPTANCE_ADAPTER_GUIDE.adapters.action.proves }], factClaims: [] });
}

test("有来源的原生规划拒绝复用现有历史问题决议，必须逐项解释且不自动成为阻断", () => {
  const { candidate, prior: old } = fixture();
  const reference = planningReference();
  const evidenceContext = architectureReviewEvidenceContext({ design: candidate, requirements: [], runtimeCapabilities: null });
  const prior = architecturePriorFindings(null, old.current, { developmentRevision: reference, candidate, evidenceContext });
  assert.equal(prior.findings.length, 1); assert.equal(prior.sameReviewObject, false);
  assert.equal(prior.findings[0].kind, "historical-planning-diagnostic");
  assert.equal(prior.findings[0].issue.blocking, false);
  assert.equal(prior.findings[0].currentAcceptance.path, "/acceptance/0");
  assert.match(prior.findings[0].diagnostic.remedy, /448.*131072/u);
  assert.equal(prior.findings[0].developmentSource.recordHash, reference.source.recordHash);
  const review = passingReview(old.current.candidateHash, candidate, prior);
  review.priorFindingDecisions[0].status = "unsupported";
  review.priorFindingDecisions[0].reason = "历史用例把合法信封作为拒绝输入；当前验收另用真实任务准入证明，不继承坏用例。";
  nativeCounterevidence(review, prior, candidate);
  assert.doesNotThrow(() => validateArchitecturePriorFindings(review, prior, candidate));
  review.priorFindingDecisions = [];
  assert.throws(() => validateArchitecturePriorFindings(review, prior, candidate), (error) => error.validationIssue.reason === "missing_coverage");
});

test("原生规划反证JSON往返后仅以完整同源上下文恢复校验，不依赖内存闭包", () => {
  const { candidate, prior: old } = fixture();
  const evidenceContext = architectureReviewEvidenceContext({ design: candidate, requirements: [], runtimeCapabilities: null });
  const prior = architecturePriorFindings(null, old.current, { developmentRevision: planningReference(), candidate, evidenceContext });
  const review = passingReview(old.current.candidateHash, candidate, prior);
  review.priorFindingDecisions[0].status = "unsupported";
  nativeCounterevidence(review, prior, candidate);
  const saved = JSON.parse(JSON.stringify({ candidate, prior, review, evidenceContext })), before = designHash(saved);
  assert.throws(() => validateArchitecturePriorFindings(saved.review, saved.prior, saved.candidate),
    error => error.validationIssue.reason === "native_counterevidence_missing");
  assert.doesNotThrow(() => validateArchitecturePriorFindings(saved.review, saved.prior, saved.candidate, { evidenceContext: saved.evidenceContext }));
  assert.equal(designHash(saved), before);
  for (const change of [value => { value.contextManifest.requirements.sha256 = "a".repeat(64); },
    value => { value.acceptanceAdapterGuide.version++; }, value => { value.requirements.push({ id: "new", text: "new fact" }); }]) {
    const changed = structuredClone(saved.evidenceContext); change(changed);
    assert.throws(() => validateArchitecturePriorFindings(saved.review, saved.prior, saved.candidate, { evidenceContext: changed }),
      error => error.validationIssue.reason === "context_mismatch");
  }
  const bad = structuredClone(saved.review); bad.issues[0].references.pop();
  assert.throws(() => validateArchitecturePriorFindings(bad, saved.prior, saved.candidate, { evidenceContext: saved.evidenceContext }));
});

test("原验收改名或已删除也保留历史诊断，不允许无声遗漏但可说明旧错误不适用", () => {
  const { candidate, prior: old } = fixture();
  candidate.acceptance[0].id = "renamed";
  const evidenceContext = architectureReviewEvidenceContext({ design: candidate, requirements: [], runtimeCapabilities: null });
  const current = { ...old.current, candidateHash: designHash(candidate), contextManifestHash: designHash(evidenceContext.contextManifest) };
  const prior = architecturePriorFindings(null, current, { developmentRevision: planningReference(), candidate, evidenceContext });
  assert.equal(prior.findings[0].currentAcceptance.path, null);
  assert.deepEqual(prior.findings[0].issue.candidatePaths, ["/acceptance"]);
  const review = passingReview(current.candidateHash, candidate, prior);
  review.priorFindingDecisions[0].status = "unsupported";
  nativeCounterevidence(review, prior, candidate);
  assert.doesNotThrow(() => validateArchitecturePriorFindings(review, prior, candidate));
});

test("原生诊断按用例验收原因去重，主反馈身份不被旧评审意见替代", () => {
  const { candidate, previous, prior: old } = fixture();
  const reference = planningReference(), failure = reference.planningToolFailures.failures[0];
  reference.planningToolFailures.failures.push({ ...structuredClone(failure), entryId: "retry", toolCallId: "retry_call" });
  const prior = architecturePriorFindings(previous, old.current, { developmentRevision: reference, candidate });
  assert.equal(prior.findings.length, 2); assert.equal(prior.source.version, previous.version);
  assert.equal(prior.planningDiagnostics.total, 1); assert.equal(prior.planningDiagnostics.retained, 1);
  assert.equal(prior.findings[1].diagnostic.entryId, "retry");
  assert.equal(prior.findings[0].issue.id, "old_failure");
});

test("未绑定或不是历史的投影不进入必答问题；普通正文内容不读取", () => {
  const { candidate, prior: old } = fixture();
  for (const mutate of [
    (reference) => { reference.source.runId = "other"; },
    (reference) => { reference.planningToolFailures.source.recordHash = "d".repeat(64); },
    (reference) => { reference.planningToolFailures.current = true; },
    (reference) => { reference.planningToolFailures.status = "unavailable"; },
    (reference) => { reference.trust = "passed"; },
  ]) {
    const reference = planningReference(); mutate(reference);
    assert.equal(architecturePriorFindings(null, old.current, { developmentRevision: reference, candidate }), null);
  }
  const reference = planningReference();
  for (const field of ["plan", "input", "mocks", "thinking"])
    Object.defineProperty(reference, field, { enumerable: true, get() { throw new Error("must not read historical bodies"); } });
  Object.defineProperty(reference.planningToolFailures.failures[0].issues[0], "thinking", { get() { throw new Error("must not read thinking"); } });
  assert.equal(architecturePriorFindings(null, old.current, { developmentRevision: reference, candidate }).findings.length, 1);
});

test("复用既有8项摘要并保持总问题80项上限，省略数明确", () => {
  const { candidate, previous, prior: old } = fixture();
  const reference = planningReference(), template = reference.planningToolFailures.failures[0].issues[0];
  reference.planningToolFailures.failures[0].issues = Array.from({ length: 10 }, (_, index) => ({ ...structuredClone(template),
    source: { ...template.source, caseId: `case_${index}`, localIndex: index },
    proposedCaseRef: { ...template.proposedCaseRef, id: `case_${index}` } }));
  let prior = architecturePriorFindings(null, old.current, { developmentRevision: reference, candidate });
  assert.equal(prior.findings.length, 8); assert.equal(prior.planningDiagnostics.total, 10); assert.equal(prior.planningDiagnostics.omitted, 2);
  previous.review.issues = Array.from({ length: 79 }, (_, index) => ({ ...previous.review.issues[0], id: `old_${index}` }));
  prior = architecturePriorFindings(previous, old.current, { developmentRevision: reference, candidate });
  assert.equal(prior.findings.length, 80); assert.equal(prior.planningDiagnostics.retained, 1); assert.equal(prior.planningDiagnostics.omitted, 9);
});

test("历史诊断身份随精确来源变更而变，不随当前验收位置漂移", () => {
  const { candidate, prior: old } = fixture();
  const reference = planningReference();
  const get = () => architecturePriorFindings(null, old.current, { developmentRevision: reference, candidate }).findings[0];
  const original = get();
  candidate.acceptance.reverse();
  assert.equal(get().findingId, original.findingId);
  assert.notEqual(get().currentAcceptance.path, original.currentAcceptance.path);
  reference.planningToolFailures.source.sessionHash = "e".repeat(64);
  assert.notEqual(get().findingId, original.findingId);
});
