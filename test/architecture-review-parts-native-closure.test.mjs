import test from "node:test";
import assert from "node:assert/strict";
import { designHash, reviewSubmissionSchema, validateReview } from "../src/architecture/architecture-contract.mjs";
import { architectureReviewEvidenceContext } from "../src/architecture/architecture-review-evidence.mjs";
import { architecturePriorFindings, architecturePriorFindingClosureIssues,
  validateArchitecturePriorFindings } from "../src/architecture/architecture-prior-findings.mjs";
import { createArchitectureReviewParts } from "../src/architecture/architecture-review-parts.mjs";
import { createArchitectureEvidenceReader } from "../src/architecture/architecture-evidence-reader.mjs";
import { ACCEPTANCE_ADAPTER_GUIDE } from "../src/verification/acceptance-contract.mjs";
import { passingReview, validDesign } from "./helpers/architecture.mjs";

function fixture(count = 1) {
  const candidate = validDesign([], { schemaVersion: 3 }), candidateHash = designHash(candidate);
  const context = architectureReviewEvidenceContext({ design: candidate, requirements: [], runtimeCapabilities: null });
  const source = { agentId: "native_parts", runId: "failed_planning", recordHash: "a".repeat(64),
    bindingHash: "b".repeat(64), sessionHash: "c".repeat(64), leafId: "last" };
  const issues = Array.from({ length: count }, (_, index) => ({ path: `planningFiles.cases[${index}].kind`,
    reason: "input_rejection_not_rejected", remedy: "旧未接受负例不证明当前入口拒绝。",
    source: { path: "cases.json", localIndex: index, caseId: `old_${index}` },
    proposedCaseRef: { id: `old_${index}`, acceptanceId: candidate.acceptance[index].id, kind: "input-rejection", inputTarget: "task-envelope" } }));
  const reference = { schemaVersion: 1, trust: "untrusted-reference", status: "available", source: structuredClone(source), plan: null,
    planningToolFailures: { schemaVersion: 1, trust: "untrusted-reference", current: false, status: "available", source,
      omittedFailures: 0, failures: [{ entryId: "failure", toolCallId: "save", toolName: "save_plan_cases", issues }] } };
  const prior = architecturePriorFindings(null, { candidateHash, guideHash: context.contextManifest.acceptanceAdapterGuide.sha256,
    contextManifestHash: designHash(context.contextManifest) }, { developmentRevision: reference, candidate, evidenceContext: context });
  const review = passingReview(candidateHash, candidate, prior);
  review.priorFindingDecisions = prior.findings.map((finding) => ({ findingId: finding.findingId, status: "unsupported",
    reason: "独立核对旧未接受负例与当前执行范围。", checkIds: ["verification"], candidatePaths: [finding.currentAcceptance.path] }));
  const options = { candidateHash, schema: reviewSubmissionSchema({ evidenceRequired: true, priorFindingsRequired: true }), context, priorFindings: prior };
  const explanation = (index = 0) => {
    const row = review.priorFindingDecisions[index], root = prior.findings[index].currentAcceptance.path;
    return { id: row.findingId, blocking: false, kind: "design", checkId: "verification", description: "旧负例自身不能证明当前验收有错。",
      remedy: "按当前验收与适配器事实修正未接受规划，不继承旧通过。", candidatePaths: [root], factClaims: [],
      references: [{ source: "candidate", path: `${root}/expected`, quote: candidate.acceptance[index].expected },
        { source: "acceptanceAdapterGuide", path: "/adapters/action/proves", quote: ACCEPTANCE_ADAPTER_GUIDE.adapters.action.proves }] };
  };
  return { candidate, candidateHash, context, prior, review, options, explanation };
}

const input = (parts, value) => ({ candidateHash: parts.reference().candidateHash, progressHash: parts.reference().progressHash, ...value });
const reason = (expected) => (error) => error.validationIssue?.reason === expected;
const unchangedAcceptedReference = (parts, before) => {
  const { rejectedPartsHash, rejectedPartsTrust, rejectedPartsIssues, ...accepted } = parts.reference();
  assert.deepEqual(accepted, before); assert.match(rejectedPartsHash, /^[a-f0-9]{64}$/u);
  assert.equal(rejectedPartsTrust, "untrusted-reference");
  assert.ok(rejectedPartsIssues.length);
};

test("同次返回原文、结论矛盾、错编号及独立关闭缺项，正式提交与分项共用预检", async () => {
  const f = fixture(2), saved = [], rejected = [], parts = createArchitectureReviewParts({ ...f.options,
    onSave: value => saved.push(value), onRejected: value => rejected.push(value) });
  const before = parts.snapshot();
  const candidate = structuredClone(f.review);
  candidate.issues = [{ ...f.explanation(), id: "new_problem", blocking: true,
    references: [{ source: "candidate", path: "/instructions", quote: "不是当前原文" }] }];
  candidate.priorFindingDecisions.push({ ...candidate.priorFindingDecisions[0], findingId: "truncated_finding" });
  const verify = error => {
    const reasons = new Set(error.validationIssues.map(issue => issue.reason));
    for (const reason of ["reference_quote_mismatch", "contradictory_review", "invalid_reference", "native_counterevidence_missing"])
      assert.ok(reasons.has(reason), reason);
    assert.equal(error.validationIssueTotal, error.validationIssues.length);
    assert.equal(error.validationIssuesTruncated, false); return true;
  };
  assert.throws(() => parts.validateSubmission(candidate), verify);
  await assert.rejects(parts.save(input(parts, { checks: candidate.checks, issues: candidate.issues,
    priorFindingDecisions: candidate.priorFindingDecisions })), verify);
  assert.deepEqual(parts.snapshot(), before); assert.equal(saved.length, 0); assert.equal(rejected.length, 1);
  assert.ok(parts.reference().rejectedPartsIssues.some(issue => issue.reason === "invalid_reference"));
  candidate.issues = [f.explanation(0), f.explanation(1)]; candidate.priorFindingDecisions = f.review.priorFindingDecisions;
  await parts.save(input(parts, { checks: candidate.checks, issues: candidate.issues, priorFindingDecisions: candidate.priorFindingDecisions }));
  assert.equal(saved.length, 1); assert.equal(parts.rejectedSnapshot(), null);
  assert.doesNotThrow(() => parts.validateSubmission(candidate));
});

test("native unsupported缺对应反证在保存前拒绝，既有分项与落盘回调不受影响", async () => {
  const f = fixture(), saved = [], parts = createArchitectureReviewParts({ ...f.options, onSave: value => saved.push(value) });
  const before = parts.snapshot(), reference = parts.reference();
  await assert.rejects(parts.save(input(parts, { priorFindingDecisions: f.review.priorFindingDecisions })), (error) => {
    assert.equal(error.validationIssue.findingId, f.prior.findings[0].findingId);
    assert.equal(error.validationIssue.path, "review.priorFindingDecisions[0].status");
    assert.equal(error.validationIssue.reason, "native_counterevidence_missing");
    assert.ok(error.message.includes(reference.progressHash));
    return true;
  });
  assert.deepEqual(parts.snapshot(), before); unchangedAcceptedReference(parts, reference); assert.equal(saved.length, 0);
  assert.deepEqual(parts.rejectedSnapshot().priorFindingDecisions, f.review.priorFindingDecisions);
});

test("partial native闭合允许未来checks尚未派发，但最终仍须完整原校验", async () => {
  const f = fixture(), parts = createArchitectureReviewParts(f.options);
  await parts.save(input(parts, { priorFindingDecisions: f.review.priorFindingDecisions, issues: [f.explanation()] }));
  assert.equal(parts.snapshot().checks.length, 0); assert.deepEqual(parts.reference().missing.priorFindingDecisions, []);
  assert.throws(() => parts.assemble(input(parts, { verdict: "pass", summary: "不能把分项当完成" })), reason("missing_coverage"));
  const review = await parts.finalize(input(parts, { checks: f.review.checks, acceptanceScopeChecks: f.review.acceptanceScopeChecks,
    verdict: "pass", summary: "真实齐全后执行原正式门禁" }));
  assert.doesNotThrow(() => validateArchitecturePriorFindings(validateReview(review,
    { candidateHash: f.candidateHash, schemaVersion: 3, evidenceContext: f.context }), f.prior, f.candidate));
  review.issues = [];
  assert.throws(() => validateArchitecturePriorFindings(review, f.prior, f.candidate), reason("native_counterevidence_missing"));
});

test("当前验收或适配器的坏反证不能在partial保存为闭合", async () => {
  for (const change of [issue => { issue.references[0].quote = "不存在的原文"; },
    issue => { issue.candidatePaths = ["/instructions"]; issue.references[0] = { source: "candidate", path: "/instructions", quote: "无关原文" }; },
    issue => { issue.references[1] = { source: "acceptanceAdapterGuide", path: "/adapters/host-files/proves", quote: ACCEPTANCE_ADAPTER_GUIDE.adapters["host-files"].proves }; }]) {
    const f = fixture(), parts = createArchitectureReviewParts(f.options), issue = f.explanation(), before = parts.snapshot();
    change(issue);
    await assert.rejects(parts.save(input(parts, { priorFindingDecisions: f.review.priorFindingDecisions, issues: [issue] })));
    assert.deepEqual(parts.snapshot(), before);
  }
  const f = fixture(), parts = createArchitectureReviewParts({ ...f.options, context: { ...f.context, runtimeCapabilities: { changed: true } } });
  await assert.rejects(parts.save(input(parts, { priorFindingDecisions: f.review.priorFindingDecisions, issues: [f.explanation()] })), reason("native_counterevidence_missing"));
});

test("单条历史依据校验的位置映射回完整报告，不把后续问题的错误标成第一条", () => {
  const f = fixture(), unrelated = { ...f.explanation(), id: "unrelated" }, explanation = f.explanation();
  explanation.references[0].quote = "不是当前原文";
  const issues = architecturePriorFindingClosureIssues({ candidateHash: f.candidateHash,
    issues: [unrelated, explanation], priorFindingDecisions: f.review.priorFindingDecisions }, f.prior, f.candidate, f.context);
  assert.ok(issues.some(issue => issue.path === "review.issues[1].references[0]" && issue.reason === "reference_quote_mismatch"));
  assert.ok(issues.every(issue => !issue.path.startsWith("review.issues[0]")));
});

test("后续删除或替换issues不得拆掉已经闭合的native反证", async () => {
  const f = fixture(), parts = createArchitectureReviewParts(f.options);
  await parts.save(input(parts, { priorFindingDecisions: f.review.priorFindingDecisions, issues: [f.explanation()] }));
  const before = parts.snapshot(), reference = parts.reference();
  await assert.rejects(parts.save(input(parts, { removeIssueIds: [f.prior.findings[0].findingId] })), reason("native_counterevidence_missing"));
  const replaced = f.explanation(); replaced.blocking = true;
  await assert.rejects(parts.save(input(parts, { issues: [replaced] })), reason("native_counterevidence_missing"));
  assert.deepEqual(parts.snapshot(), before); unchangedAcceptedReference(parts, reference);
});

test("旧CP未闭合行保留并重开missing，可分批修复而不重抄其他旧行", async () => {
  const f = fixture(2), initial = { candidateHash: f.candidateHash, checks: [], issues: [],
    acceptanceScopeChecks: f.review.acceptanceScopeChecks, priorFindingDecisions: f.review.priorFindingDecisions };
  const before = structuredClone(initial), saved = [], parts = createArchitectureReviewParts({ ...f.options, initial,
    remainingModelCalls: () => 3, onSave: value => saved.push(value) });
  const reference = parts.reference();
  assert.deepEqual(reference.missing.priorFindingDecisions, f.prior.findings.map(finding => finding.findingId));
  assert.deepEqual(reference.pendingNativeClosures.map(issue => issue.path), ["review.priorFindingDecisions[0].status", "review.priorFindingDecisions[1].status"]);
  assert.equal(reference.batch.remainingModelCalls, 3); assert.deepEqual(initial, before);
  await parts.save(input(parts, { issues: [f.explanation(0)] }));
  assert.deepEqual(parts.reference().missing.priorFindingDecisions, [f.prior.findings[1].findingId]);
  assert.deepEqual(parts.snapshot().priorFindingDecisions, before.priorFindingDecisions);
  await assert.rejects(parts.save(input(parts, { priorFindingDecisions: [f.review.priorFindingDecisions[1]] })), reason("native_counterevidence_missing"));
  await parts.save(input(parts, { issues: [f.explanation(1)] }));
  assert.deepEqual(parts.reference().missing.priorFindingDecisions, []); assert.equal(parts.reference().pendingNativeClosures, undefined);
  assert.equal(parts.reference().batch.remainingModelCalls, 3); assert.deepEqual(initial, before); assert.equal(saved.length, 2);
  await assert.rejects(parts.save(input(parts, { removeIssueIds: [f.prior.findings[0].findingId] })), reason("native_counterevidence_missing"));
});

test("短引用明确重交旧未闭合行时仍重验，不能因完整编号由宿主填回而漏掉关闭门槛", async () => {
  const f = fixture(), reader = createArchitectureEvidenceReader({ context: f.context, candidateHash: f.candidateHash, priorFindings: f.prior });
  const initial = { candidateHash: f.candidateHash, checks: [], issues: [], acceptanceScopeChecks: [], priorFindingDecisions: f.review.priorFindingDecisions };
  const parts = createArchitectureReviewParts({ ...f.options, initial, toolSchema: reader.submissionSchema(f.options.schema), resolve: reader.resolveSubmission });
  const { findingId: _id, ...row } = f.review.priorFindingDecisions[0];
  await assert.rejects(parts.save(input(parts, { priorFindingDecisions: [{ ...row, findingRef: reader.index.priorFindings[0].findingRef }] })),
    reason("native_counterevidence_missing"));
  assert.deepEqual(parts.snapshot(), initial);
});

test("partial resolved使用原真实变化依据，不能靠保存绕过原native门禁", async () => {
  const f = fixture(), parts = createArchitectureReviewParts(f.options), row = { ...f.review.priorFindingDecisions[0], status: "resolved" };
  await assert.rejects(parts.save(input(parts, { priorFindingDecisions: [row] })), reason("native_basis_unavailable"));
  const rows = architecturePriorFindingClosureIssues({ candidateHash: f.candidateHash, issues: [], priorFindingDecisions: [row] },
    f.prior, f.candidate, f.context);
  assert.equal(rows[0].reason, "native_basis_unavailable");
});
