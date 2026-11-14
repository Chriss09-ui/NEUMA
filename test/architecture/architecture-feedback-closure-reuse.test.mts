import { callFixture } from "../helpers/m7-test-boundaries.mjs";
import type { ArchitectureBase, PlatformClaim } from "../../src/contracts/architecture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createArchitectureFeedbackLedger, architectureFeedbackFindings, recordArchitectureFeedbackReview }
  from "../../src/architecture/architecture-feedback-ledger.mjs";
import { developmentRevisionReference } from "../../src/architecture/architecture-development-revision.mjs";
import { architecturePriorFindings, validateArchitecturePriorFindings } from "../../src/architecture/architecture-prior-findings.mjs";
import { architectureReviewEvidenceContext } from "../../src/architecture/architecture-review-evidence.mjs";
import { designHash, validateReview } from "../../src/architecture/architecture-contract.mjs";
import { ACCEPTANCE_ADAPTER_GUIDE } from "../../src/verification/acceptance-contract.mjs";
import { validDesign, passingReview } from "../helpers/architecture.mjs";
import { createReviewProgressCheckpoint } from "../../src/architecture/architecture-review-progress.mjs";
import { hasNewPendingFeedback } from "../../src/architecture/architecture-revision-source.mjs";

function closedFixture() {
  const context = { requirements: [], runtimeCapabilities: { version: 1 }, acceptanceAdapterGuide: structuredClone(ACCEPTANCE_ADAPTER_GUIDE) };
  const original: ArchitectureBase & { schemaVersion: number; platformClaims?: PlatformClaim[] } = validDesign([], { schemaVersion: 3 });
  original.decisions.push({ id: "original_decision", problem: "冻结预期如何匹配", choice: "使用平台不支持的动态占位符",
    reason: "历史错误建议", alternatives: [{ option: "明确预期", reason: "保留严格匹配" }], evidenceIds: [], uncertainties: [] });
  const architecture = { agentId: "closure_reuse_agent", version: 1, sourceFingerprint: "same-source", platformHash: "same-platform",
    requirements: [], runtimeCapabilities: context.runtimeCapabilities, design: original, candidateHash: designHash(original) };
  const run = { id: "old_review_run", agentId: architecture.agentId, version: 1, revision: 1,
    architectureRef: { version: 1, candidateHash: architecture.candidateHash }, phase: "planning", summary: "待修旧问题", plan: null,
    reviews: [{ verdict: "revise", issues: [{ id: "unsupported_placeholder", blocking: true, kind: "plan",
      description: "实际写入无法匹配动态占位符", remedy: "冻结独立精确预期" }] }], reports: [] };
  const ledger = createArchitectureFeedbackLedger(null, { agentId: architecture.agentId, candidate: original,
    developmentRevision: callFixture(developmentRevisionReference, undefined, [run, architecture]), ...context });
  const candidate = structuredClone(original);
  candidate.decisions![1]!.choice = "逐用例冻结独立精确预期，保留严格匹配";
  candidate.platformClaims = [{ id: "fixture_fact", source: "acceptanceAdapterGuide", path: "/adapters/action/executionFacts/dynamicPlaceholders",
    expected: false, decisionIds: [candidate.decisions![1]!.id], acceptanceIds: [] }];
  const evidenceContext = architectureReviewEvidenceContext({ design: candidate, ...context });
  const prior = architecturePriorFindings(null, { candidateHash: designHash(candidate), guideHash: evidenceContext.contextManifest!.acceptanceAdapterGuide!.sha256,
    contextManifestHash: designHash(evidenceContext.contextManifest) }, { candidate, evidenceContext, feedbackLedger: ledger });
  const review = passingReview(designHash(candidate), candidate, prior!);
  for (const row of review.priorFindingDecisions!) {
    row.status = "resolved"; row.checkIds = ["verification"]; row.candidatePaths = ["/decisions/1/choice"];
    review.issues.push({ id: row.findingId!, blocking: false, kind: "design", checkId: "verification",
      description: "当前决策已改为可执行的精确预期", remedy: "保持独立预期", candidatePaths: row.candidatePaths, factClaims: [], references: [
        { source: "candidate", path: "/decisions/1/choice", quote: candidate.decisions![1]!.choice },
        { source: "acceptanceAdapterGuide", path: "/adapters/action/executionFacts/dynamicPlaceholders", quote: "false" },
      ] });
  }
  const checked = validateArchitecturePriorFindings(validateReview(review, { candidateHash: designHash(candidate), schemaVersion: 3, evidenceContext }),
    prior, candidate, { evidenceContext });
  const closed = recordArchitectureFeedbackReview(ledger, prior, checked, candidate, context);
  assert.equal(closed!.findings![0]!.closure!.status, "resolved");
  const reopen = (next: unknown) => {
    const current = createArchitectureFeedbackLedger({ feedbackLedger: JSON.parse(String(JSON.stringify(closed))) }, {
      agentId: architecture.agentId, candidate: next, ...context });
    return architectureFeedbackFindings(current, next, context);
  };
  return { original, candidate, closed, reopen, context, architecture };
}

test("候选变化后已交给当前评审的旧问题不再冒充新反馈，来源或绑定改变仍拒绝复用", () => {
  const f = closedFixture(), candidate = structuredClone(f.candidate);
  candidate.decisions[1]!.choice += "；补充当前业务说明";
  const candidateHash = designHash(candidate), context = architectureReviewEvidenceContext({ design: candidate, ...f.context });
  const priorFindings = architecturePriorFindings(null, { candidateHash, guideHash: context.contextManifest.acceptanceAdapterGuide!.sha256,
    contextManifestHash: designHash(context.contextManifest) }, { candidate, evidenceContext: context, feedbackLedger: f.closed });
  assert.equal(priorFindings!.findings.length, 1);
  const record = { ...f.architecture, version: 2, design: candidate, candidateHash, feedbackLedger: f.closed, priorFindings };
  const ledger = createArchitectureFeedbackLedger(record, { agentId: record.agentId, candidate, ...f.context });
  assert.equal(callFixture(hasNewPendingFeedback, undefined, [record, ledger]), true, "没有当前评审绑定时仍须处理重开的旧问题");
  const pending = { ...record, reviewProgressCheckpoint: createReviewProgressCheckpoint(record, null, 0) };
  assert.ok(pending.reviewProgressCheckpoint);
  const before = structuredClone(pending);
  assert.equal(callFixture(hasNewPendingFeedback, undefined, [pending, ledger]), false);
  assert.deepEqual(pending, before);
  const changed = structuredClone(record);
  changed.priorFindings!.findings[0]!.issue!.description += "另一种问题";
  const rebound = { ...changed, reviewProgressCheckpoint: createReviewProgressCheckpoint(changed, null, 0) };
  assert.equal(callFixture(hasNewPendingFeedback, undefined, [rebound, ledger]), true, "同编号不同问题不算已经分派");
  pending.reviewProgressCheckpoint!.hash = "0".repeat(64);
  assert.throws(() => callFixture(hasNewPendingFeedback, undefined, [pending, ledger]));
});

test("原决策恢复旧错误时，无关正确副本不能维持历史问题关闭", () => {
  const f = closedFixture(), candidate = structuredClone(f.candidate), before = structuredClone(f.closed);
  candidate.decisions.push({ ...structuredClone(candidate.decisions[1])!, id: "unrelated_copy" });
  candidate.decisions![1]!.choice = f.original!.decisions[1]!.choice;
  const open = f.reopen(candidate);
  assert.equal(open.length, 1); assert.equal(open[0]!.findingId, f.closed!.findings[0]!.findingId);
  assert.deepEqual(f.closed, before, "当前核对不能修改历史关闭记录");
});

test("同一稳定编号只移动位置且技术正文未变时继续复用有效关闭", () => {
  const f = closedFixture(), candidate = structuredClone(f.candidate);
  candidate.decisions.reverse();
  assert.equal(f.reopen(candidate).length, 0);
});

test("仅更名且原位置技术正文未变时继续复用有效关闭", () => {
  const f = closedFixture(), candidate = structuredClone(f.candidate);
  candidate.decisions![1]!.id = "renamed_decision";
  candidate.platformClaims![0]!.decisionIds = [candidate.decisions![1]!.id];
  assert.equal(f.reopen(candidate).length, 0);
});

test("更名又移动且无法明确对应原实体时保守重开，不能全局搜同文代替对应关系", () => {
  const f = closedFixture(), candidate = structuredClone(f.candidate);
  candidate.decisions![1]!.id = "renamed_and_moved";
  candidate.platformClaims![0]!.decisionIds = [candidate.decisions![1]!.id];
  candidate.decisions.reverse();
  assert.equal(f.reopen(candidate).length, 1);
});
