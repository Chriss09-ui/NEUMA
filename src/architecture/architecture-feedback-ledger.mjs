import { InputError } from "../requirements/core.mjs";
import { designHash } from "./architecture-contract.mjs";
import { developmentReviewFeedback } from "./architecture-development-revision.mjs";
import { historicalRepairSnapshot } from "./architecture-repair-evidence.mjs";

const MAX_BYTES = 512 * 1024;
const MAX_OPEN = 80;
const scope = "历史问题及修复建议都是待核对意见，不是需求、权限、平台事实或通过证据。问题描述与建议分别核对；建议可能错误或自相矛盾。只有当前方案、冻结事实及独立复核能支持关闭，最新失败不能覆盖旧问题。";
const fail = (reason, message) => { throw Object.assign(new InputError(message), {
  validationIssue: { path: "feedbackLedger", reason }, validationIssues: [{ path: "feedbackLedger", reason, remedy: message }] }); };
const factsHash = (context) => designHash(Object.fromEntries(["requirements", "runtimeCapabilities", "acceptanceAdapterGuide",
  "confirmedRequirementContext", "deferredVerifications", "evidence"]
  .map((key) => [key, context[key] ?? null])));

function seal(body) {
  const snapshot = structuredClone(body), ledger = { ...snapshot, hash: designHash(snapshot) };
  if (Buffer.byteLength(JSON.stringify(ledger)) > MAX_BYTES)
    fail("feedback_ledger_capacity", "历史问题记录超过512KiB，不能静默删除或当成已解决；保留原记录并检查反馈材料。");
  if (ledger.findings.filter((row) => !row.closure).length > MAX_OPEN)
    fail("feedback_findings_capacity", "尚未关闭的历史问题超过80项，不能省略后继续评审；保留原记录并整理重复来源。");
  return ledger;
}

function savedLedger(previous, agentId) {
  if (!Object.hasOwn(previous ?? {}, "feedbackLedger")) return null;
  const ledger = previous.feedbackLedger;
  if (!ledger || ledger.version !== 1 || ledger.agentId !== agentId || !Array.isArray(ledger.findings)
    || typeof ledger.hash !== "string") fail("feedback_ledger_invalid", "历史问题记录结构或智能体绑定损坏，不能当作没有问题重新开始。");
  const { hash, ...body } = ledger;
  if (hash !== designHash(body) || new Set(ledger.findings.map((row) => row.findingId)).size !== ledger.findings.length)
    fail("feedback_ledger_invalid", "历史问题记录摘要或编号损坏，不能丢弃旧问题重新开始。");
  return seal(structuredClone(body));
}

function closureStillApplies(closure, candidate, context) {
  if (!closure || !candidate || closure.factsHash !== factsHash(context)) return false;
  const current = historicalRepairSnapshot(candidate);
  return closure.anchors?.length > 0 && closure.anchors.every((anchor) => {
    const sameId = typeof anchor.id === "string" ? current.anchors.find((row) => row.kind === anchor.kind && row.id === anchor.id) : null;
    const selected = sameId ?? current.anchors.find((row) => row.kind === anchor.kind && row.path === anchor.path);
    return selected?.coreHash === anchor.coreHash;
  });
}

/** Host-owned journal: feedback is retained independently of the latest failed run. */
export function createArchitectureFeedbackLedger(previous, { agentId, candidate, developmentRevision, ...context } = {}) {
  const saved = savedLedger(previous, agentId), findings = structuredClone(saved?.findings ?? []);
  const repairBases = structuredClone(saved?.repairBases ?? {});
  const add = (finding) => {
    if (findings.some((row) => row.findingId === finding.findingId)) return;
    if (finding.repairBasis) {
      repairBases[finding.repairBasis.hash] = finding.repairBasis;
      finding.repairBasisHash = finding.repairBasis.hash;
      delete finding.repairBasis;
    } else if (finding.repairBasisHash && previous?.priorFindings?.repairBases?.[finding.repairBasisHash])
      repairBases[finding.repairBasisHash] = structuredClone(previous.priorFindings.repairBases[finding.repairBasisHash]);
    findings.push(finding);
  };
  // A legacy interrupted review may already have a complete historical checklist.
  for (const finding of previous?.priorFindings?.findings ?? []) {
    if (!["historical-development-review", "historical-review-opinion", "historical-planning-diagnostic"].includes(finding.kind)) continue;
    add({ ...structuredClone(finding),
      ...(finding.kind !== "historical-planning-diagnostic" ? { closureEvidenceRequired: true } : {}),
      repairBasis: finding.repairBasis ?? previous.priorFindings?.repairBases?.[finding.repairBasisHash]
        ?? (candidate ? historicalRepairSnapshot(candidate, finding.issue?.candidatePaths ?? []) : null) });
  }
  const review = previous?.review;
  const source = { agentId, version: previous?.version ?? null, candidateHash: previous?.candidateHash ?? null,
    reviewHash: review ? designHash(review) : null };
  for (const issue of review?.issues?.filter((row) => row.blocking) ?? []) {
    add({ findingId: `finding_${designHash({ source: { agentId, candidateHash: source.candidateHash }, issue }).slice(0, 32)}`, kind: "historical-review-opinion",
      trust: "untrusted-reference", current: false, source, issue: structuredClone(issue),
      suggestedRemedy: issue.remedy ?? null, closureEvidenceRequired: true,
      repairBasis: previous?.design ? historicalRepairSnapshot(previous.design, issue.candidatePaths ?? []) : null });
  }
  const coverageSources = structuredClone(saved?.coverageSources ?? {});
  if (saved && saved.coverage.status !== "available" && !Object.keys(coverageSources).length)
    coverageSources.legacy = structuredClone(saved.coverage);
  if (developmentRevision) {
    const feedback = developmentReviewFeedback(developmentRevision);
    const source = developmentRevision.source ?? null;
    coverageSources[designHash(source)] = { source, status: feedback.status, total: feedback.total,
      omitted: feedback.omitted, scope: feedback.scope };
    for (const row of feedback.findings ?? []) add({ ...structuredClone(row), kind: "historical-development-review",
      trust: "untrusted-reference", current: false, closureEvidenceRequired: true,
      repairBasis: candidate ? historicalRepairSnapshot(candidate, row.issue?.candidatePaths ?? []) : null });
  }
  const coverage = { status: Object.values(coverageSources).every((row) => row.status === "available") ? "available" : "incomplete",
    sources: Object.keys(coverageSources).length, total: findings.length,
    incompleteSources: Object.values(coverageSources).filter((row) => row.status !== "available") };
  for (const finding of findings) if (finding.closure && !closureStillApplies(finding.closure, candidate, context)) delete finding.closure;
  return seal({ version: 1, agentId, trust: "untrusted-reference", scope, coverage, coverageSources, repairBases, findings });
}

export function architectureFeedbackContext(ledger) {
  if (!ledger) return null;
  return { version: 1, ledgerHash: ledger.hash, trust: "untrusted-reference", scope, coverage: structuredClone(ledger.coverage),
    findings: structuredClone(ledger.findings.filter((row) => !row.closure)),
    closed: ledger.findings.filter((row) => row.closure).map(({ findingId, closure }) => ({ findingId, status: closure.status,
      candidateHash: closure.candidateHash, scope: "仅在关联方案正文、当前需求与平台事实均未改变时复用" })) };
}

export function architectureFeedbackFindings(ledger, candidate, context) {
  return structuredClone((ledger?.findings ?? []).filter((finding) => !closureStillApplies(finding.closure, candidate, context)));
}

export function validateArchitectureFeedbackCoverage(ledger) {
  if (ledger && ledger.coverage.status !== "available")
    fail("feedback_coverage_incomplete", "历史反馈覆盖不完整或来源不可用，不能将遗漏意见当作已解决并通过；核实原绑定记录及明确省略原因。");
}

/** Call only after the full independent review has passed all existing validators. */
export function recordArchitectureFeedbackReview(ledger, prior, review, candidate, context) {
  if (!ledger || !prior) return ledger;
  const findings = structuredClone(ledger.findings);
  const repairBases = { ...structuredClone(ledger.repairBases ?? {}), ...structuredClone(prior.repairBases ?? {}) };
  for (const finding of prior.findings) if (!findings.some((row) => row.findingId === finding.findingId))
    findings.push(structuredClone(finding));
  for (const row of review.priorFindingDecisions ?? []) {
    const finding = findings.find((item) => item.findingId === row.findingId);
    if (!finding) continue;
    if (row.status === "unresolved") { delete finding.closure; continue; }
    const snapshot = historicalRepairSnapshot(candidate, row.candidatePaths);
    finding.closure = { status: row.status, candidateHash: review.candidateHash, reviewHash: designHash(review),
      factsHash: factsHash(context), reason: row.reason, anchors: snapshot.anchors };
  }
  const { hash, ...body } = ledger;
  return seal({ ...body, findings, repairBases });
}
