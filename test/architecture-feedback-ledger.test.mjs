import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createArchitectureFeedbackLedger, architectureFeedbackContext, architectureFeedbackFindings,
  recordArchitectureFeedbackReview, validateArchitectureFeedbackCoverage } from "../src/architecture/architecture-feedback-ledger.mjs";
import { developmentRevisionReference } from "../src/architecture/architecture-development-revision.mjs";
import { architecturePriorFindings, validateArchitecturePriorFindings, architecturePriorFindingClosureIssues } from "../src/architecture/architecture-prior-findings.mjs";
import { architectureReviewEvidenceContext } from "../src/architecture/architecture-review-evidence.mjs";
import { validateReview, designHash } from "../src/architecture/architecture-contract.mjs";
import { ACCEPTANCE_ADAPTER_GUIDE } from "../src/verification/acceptance-contract.mjs";
import { validDesign, passingReview } from "./helpers/architecture.mjs";

const recorded = JSON.parse(await readFile(new URL("./fixtures/architecture-feedback-recorded-defect.json", import.meta.url), "utf8"));
const facts = () => ({ requirements: [], runtimeCapabilities: { version: 1 }, acceptanceAdapterGuide: structuredClone(ACCEPTANCE_ADAPTER_GUIDE) });
function fixture() {
  const raw = recorded.unchangedDecision, candidate = validDesign([], { schemaVersion: 3 });
  candidate.decisions.push({ id: raw.oldId, problem: raw.problem, choice: raw.choice, reason: raw.reason,
    alternatives: [{ option: "明确固定数据", reason: "去标识历史机制回放" }], evidenceIds: [], uncertainties: [] });
  const context = facts(), architecture = { agentId: "feedback_ledger_agent", version: 1, sourceFingerprint: "same-input",
    platformHash: "same-platform", requirements: [], runtimeCapabilities: context.runtimeCapabilities,
    design: candidate, candidateHash: designHash(candidate) };
  const opinion = recorded.historicalOpinions.at(-1), run = { id: "historical_run", agentId: architecture.agentId, version: 1, revision: 1,
    architectureRef: { version: 1, candidateHash: architecture.candidateHash }, phase: "planning", summary: "旧评审包含互相矛盾建议",
    plan: null, reviews: [{ verdict: "revise", issues: [{ id: opinion.id, blocking: true, kind: "plan",
      description: opinion.descriptionExcerpt, remedy: opinion.remedyExcerpt }] }], reports: [], feedback: { reason: "需要修订旧问题" } };
  const revision = developmentRevisionReference(run, architecture);
  const ledger = createArchitectureFeedbackLedger(null, { agentId: architecture.agentId, candidate, developmentRevision: revision, ...context });
  return { candidate, context, architecture, ledger, revision, agentId: architecture.agentId };
}
function current(f, { fixed = false } = {}) {
  const candidate = structuredClone(f.candidate), decision = candidate.decisions[1];
  decision.id = recorded.unchangedDecision.newId;
  if (fixed) decision.choice = "逐用例冻结独立的精确JSON/CSV原文及其完整性数据，保留严格匹配；公开夹具仅构造明确数据。";
  candidate.platformClaims = [{ id: "strict_fixture", source: "acceptanceAdapterGuide",
    path: "/adapters/action/executionFacts/dynamicPlaceholders", expected: false, decisionIds: [decision.id], acceptanceIds: [] }];
  const evidenceContext = architectureReviewEvidenceContext({ design: candidate, ...f.context });
  const prior = architecturePriorFindings(null, { candidateHash: designHash(candidate),
    guideHash: evidenceContext.contextManifest.acceptanceAdapterGuide.sha256, contextManifestHash: designHash(evidenceContext.contextManifest) },
  { candidate, evidenceContext, feedbackLedger: f.ledger });
  const review = passingReview(designHash(candidate), candidate, prior);
  for (const row of review.priorFindingDecisions) {
    row.status = "resolved"; row.checkIds = ["verification"]; row.candidatePaths = ["/decisions/1/choice"];
    review.issues.push({ id: row.findingId, kind: "design", blocking: false, checkId: "verification", description: "以当前事实核对修订而非沿用旧建议。",
      remedy: "保持独立明确预期与严格匹配", candidatePaths: row.candidatePaths, factClaims: [], references: [
        { source: "candidate", path: "/decisions/1/choice", quote: decision.choice },
        { source: "acceptanceAdapterGuide", path: "/adapters/action/executionFacts/dynamicPlaceholders", quote: "false" },
      ] });
  }
  const complete = (value) => {
    const checked = validateArchitecturePriorFindings(validateReview(value, { candidateHash: designHash(candidate), schemaVersion: 3, evidenceContext }),
      prior, candidate, { evidenceContext });
    if (checked.verdict === "pass") validateArchitectureFeedbackCoverage(f.ledger);
    return recordArchitectureFeedbackReview(f.ledger, prior, checked, candidate, f.context);
  };
  return { candidate, evidenceContext, prior, review, complete };
}

test("跨版本及JSON重启后旧问题保留，泛化新反馈与D8改D9均不能消除它", () => {
  const f = fixture(), saved = JSON.parse(JSON.stringify({ feedbackLedger: f.ledger })), renamed = structuredClone(f.candidate);
  renamed.decisions[1].id = recorded.unchangedDecision.newId;
  const nextRevision = { schemaVersion: 1, status: "available", source: { agentId: f.agentId, runId: "newer_generic_run" },
    reviews: [], feedback: structuredClone(recorded.latestFailure.feedback), omitted: { reviews: 0 } };
  const next = createArchitectureFeedbackLedger(saved, { agentId: f.agentId, candidate: renamed, developmentRevision: nextRevision, ...f.context });
  const before = structuredClone(f.ledger), open = architectureFeedbackFindings(next, renamed, f.context);
  assert.equal(open.length, 1); assert.equal(open[0].findingId, f.ledger.findings[0].findingId);
  assert.deepEqual(open[0].issue, f.ledger.findings[0].issue);
  assert.equal(open[0].kind, "historical-development-review"); assert.equal(open[0].trust, "untrusted-reference");
  assert.deepEqual(architectureFeedbackContext(next).findings, open);
  assert.deepEqual(f.ledger, before); assert.equal(next.coverage.status, "available");
});

test("分项假关闭和完整假pass均拒绝，遗漏旧问题也不能关闭，失败不改变账本", () => {
  const f = fixture(), c = current(f), before = structuredClone(f.ledger);
  const partial = architecturePriorFindingClosureIssues({ candidateHash: c.review.candidateHash, issues: c.review.issues,
    priorFindingDecisions: c.review.priorFindingDecisions }, c.prior, c.candidate, c.evidenceContext);
  assert.equal(partial[0].reason, "repair_basis_unchanged");
  assert.throws(() => c.complete(c.review), (error) => error.validationIssue.reason === "repair_basis_unchanged");
  const missing = structuredClone(c.review); missing.priorFindingDecisions = [];
  assert.throws(() => c.complete(missing), (error) => error.validationIssue.reason === "missing_coverage");
  assert.deepEqual(f.ledger, before); assert.equal(f.ledger.findings[0].closure, undefined);
});

test("有效关闭跨重启复用，无关编辑不重开，相关内容或平台事实变化则重开", () => {
  const f = fixture(), c = current(f, { fixed: true }), before = structuredClone(f.ledger), closed = c.complete(c.review);
  assert.equal(closed.findings[0].closure.status, "resolved"); assert.deepEqual(f.ledger, before);
  const previous = JSON.parse(JSON.stringify({ feedbackLedger: closed }));
  const unrelated = structuredClone(c.candidate); unrelated.instructions += " 解释展示用语。"; unrelated.decisions[1].reason += " 补充原因。";
  let reopened = createArchitectureFeedbackLedger(previous, { agentId: f.agentId, candidate: unrelated, ...f.context });
  assert.equal(architectureFeedbackFindings(reopened, unrelated, f.context).length, 0);
  assert.equal(architectureFeedbackContext(reopened).closed.length, 1);
  const changed = structuredClone(unrelated); changed.decisions[1].choice = recorded.unchangedDecision.choice;
  reopened = createArchitectureFeedbackLedger(previous, { agentId: f.agentId, candidate: changed, ...f.context });
  assert.equal(architectureFeedbackFindings(reopened, changed, f.context).length, 1);
  const changedFacts = structuredClone(f.context); changedFacts.runtimeCapabilities.version = 2;
  reopened = createArchitectureFeedbackLedger(previous, { agentId: f.agentId, candidate: c.candidate, ...changedFacts });
  assert.equal(architectureFeedbackFindings(reopened, c.candidate, changedFacts).length, 1);
});

test("历史覆盖缺失必须阻断pass，后来的空反馈不能洗掉尚未核实的覆盖缺口", () => {
  const f = fixture(), incomplete = createArchitectureFeedbackLedger({ feedbackLedger: f.ledger }, { agentId: f.agentId, candidate: f.candidate,
    developmentRevision: { schemaVersion: 1, status: "unavailable", source: { agentId: f.agentId, runId: "missing_history_run" }, reviews: [], omitted: { reviews: 1 } }, ...f.context });
  assert.throws(() => validateArchitectureFeedbackCoverage(incomplete), (error) => error.validationIssue.reason === "feedback_coverage_incomplete");
  const after = createArchitectureFeedbackLedger(JSON.parse(JSON.stringify({ feedbackLedger: incomplete })), { agentId: f.agentId, candidate: f.candidate,
    developmentRevision: { schemaVersion: 1, status: "available", source: { agentId: f.agentId, runId: "unrelated_latest_failure" }, reviews: [], omitted: { reviews: 0 } }, ...f.context });
  assert.throws(() => validateArchitectureFeedbackCoverage(after), (error) => error.validationIssue.reason === "feedback_coverage_incomplete");
});

test("账本摘要损坏或跨智能体不能按空历史重新开始", () => {
  const f = fixture(), previous = JSON.parse(JSON.stringify({ feedbackLedger: f.ledger }));
  previous.feedbackLedger.findings[0].issue.remedy = "被改动的建议";
  assert.throws(() => createArchitectureFeedbackLedger(previous, { agentId: f.agentId, candidate: f.candidate, ...f.context }),
    (error) => error.validationIssue.reason === "feedback_ledger_invalid");
  assert.throws(() => createArchitectureFeedbackLedger({ feedbackLedger: f.ledger }, { agentId: "another_agent", candidate: f.candidate, ...f.context }),
    (error) => error.validationIssue.reason === "feedback_ledger_invalid");
});
