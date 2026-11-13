import type { UnknownRecord } from "../contracts/json.mjs";
import type { ArchitectureReview } from "../contracts/architecture.mjs";
import type { FeedbackLedgerBody, FeedbackLedger, FeedbackFinding, FeedbackClosure, FeedbackCoverage } from "./architecture-feedback-port.mjs";
import { feedbackFinding, feedbackFindings, priorFindings } from "./architecture-feedback-port.mjs";
import { objectFields, isArray } from "../runtime/type-boundary.mjs";
import { InputError } from "../requirements/core.mjs";
import { designHash } from "./architecture-contract.mjs";
import { developmentReviewFeedback } from "./architecture-development-revision.mjs";
import { historicalRepairSnapshot } from "./architecture-repair-evidence.mjs";
import { judgmentApprovesReview } from "./architecture-review-judgment.mjs";

const MAX_BYTES = 512 * 1024;
const MAX_OPEN = 80;
const scope = "历史问题及修复建议都是待核对意见，不是需求、权限、平台事实或通过证据。问题描述与建议分别核对；建议可能错误或自相矛盾。只有当前方案、冻结事实及独立复核能支持关闭，最新失败不能覆盖旧问题。";
function fail(reason: string, message: string): never { throw Object.assign(new InputError(message), {
  validationIssue: { path: "feedbackLedger", reason }, validationIssues: [{ path: "feedbackLedger", reason, remedy: message }] }); };
const factsHash = (context: UnknownRecord) => designHash(Object.fromEntries(["requirements", "runtimeCapabilities", "acceptanceAdapterGuide",
  "confirmedRequirementContext", "deferredVerifications", "evidence"]
  .map((key) => [key, context[key] ?? null])));

function seal(body: FeedbackLedgerBody): FeedbackLedger {
  const snapshot = structuredClone(body), ledger = { ...snapshot, hash: designHash(snapshot) };
  if (Buffer.byteLength(JSON.stringify(ledger)) > MAX_BYTES)
    fail("feedback_ledger_capacity", "历史问题记录超过512KiB，不能静默删除或当成已解决；保留原记录并检查反馈材料。");
  if (ledger.findings.filter((row) => !row.closure).length > MAX_OPEN)
    fail("feedback_findings_capacity", "尚未关闭的历史问题超过80项，不能省略后继续评审；保留原记录并整理重复来源。");
  return ledger;
}

function savedLedger(previous: UnknownRecord, agentId: unknown) {
  if (!Object.hasOwn(previous ?? {}, "feedbackLedger")) return null;
  const ledger = objectFields(previous.feedbackLedger);
  if (!ledger || ledger.version !== 1 || ledger.agentId !== agentId || !Array.isArray(ledger.findings)
    || typeof ledger.hash !== "string") fail("feedback_ledger_invalid", "历史问题记录结构或智能体绑定损坏，不能当作没有问题重新开始。");
  const { hash, ...body } = ledger;
  if (hash !== designHash(body) || new Set(ledger.findings.map((row) => objectFields(row).findingId)).size !== ledger.findings.length)
    fail("feedback_ledger_invalid", "历史问题记录摘要或编号损坏，不能丢弃旧问题重新开始。");
  const findings = feedbackFindings(body.findings), coverage = objectFields(body.coverage), coverageSources = objectFields(body.coverageSources);
  if (typeof coverage.status !== "string" || Object.values(coverageSources).some(value => typeof objectFields(value).status !== "string"))
    fail("feedback_ledger_invalid", "历史问题覆盖记录损坏，不能当作没有问题重新开始。");
  return seal(structuredClone({ ...body, findings, coverage: coverage as FeedbackCoverage,
    ...(body.coverageSources === undefined ? {} : { coverageSources: coverageSources as Record<string, FeedbackCoverage> }) }));
}

function closureStillApplies(closure: FeedbackClosure | undefined, candidate: unknown, context: UnknownRecord) {
  if (!closure || !candidate || closure.factsHash !== factsHash(context)) return false;
  const current = historicalRepairSnapshot(candidate);
  return closure.anchors?.length > 0 && closure.anchors.every((anchor) => {
    const sameId = typeof anchor.id === "string" ? current.anchors.find((row) => row.kind === anchor.kind && row.id === anchor.id) : null;
    const selected = sameId ?? current.anchors.find((row) => row.kind === anchor.kind && row.path === anchor.path);
    return selected?.coreHash === anchor.coreHash;
  });
}

/** Host-owned journal: feedback is retained independently of the latest failed run. */
export function createArchitectureFeedbackLedger(previousInput: unknown, { agentId, candidate, developmentRevision, ...context }: UnknownRecord = {}) {
  const previous = objectFields(previousInput), prior = objectFields(previous.priorFindings);
  const saved = savedLedger(previous, agentId), findings = structuredClone(saved?.findings ?? []);
  const repairBases: Record<string, unknown> = structuredClone(saved?.repairBases ?? {});
  const add = (input: unknown) => {
    const finding = feedbackFinding(input);
    if (findings.some((row) => row.findingId === finding.findingId)) return;
    if (finding.repairBasis) {
      repairBases[String(objectFields(finding.repairBasis).hash)] = finding.repairBasis;
      finding.repairBasisHash = objectFields(finding.repairBasis).hash as string;
      delete finding.repairBasis;
    } else if (finding.repairBasisHash && objectFields(prior.repairBases)[finding.repairBasisHash!])
      repairBases[finding.repairBasisHash] = structuredClone(objectFields(prior.repairBases)[finding.repairBasisHash!]);
    findings.push(finding);
  };
  // A legacy interrupted review may already have a complete historical checklist.
  for (const finding of feedbackFindings(prior.findings ?? [])) {
    if (!["historical-development-review", "historical-review-opinion", "historical-planning-diagnostic"].some(kind => kind === finding.kind)) continue;
    add({ ...structuredClone(finding),
      ...(finding.kind !== "historical-planning-diagnostic" ? { closureEvidenceRequired: true } : {}),
      repairBasis: finding.repairBasis ?? objectFields(prior.repairBases)[finding.repairBasisHash!]
        ?? (candidate ? historicalRepairSnapshot(candidate, finding.issue?.candidatePaths ?? []) : null) });
  }
  const review = objectFields(previous.review);
  const source = { agentId, version: previous?.version ?? null, candidateHash: previous?.candidateHash ?? null,
    reviewHash: previous.review ? designHash(previous.review) : null };
  for (const issue of (isArray(review.issues) ? review.issues.map(objectFields).filter((row) => row.blocking) : [])) {
    add({ findingId: `finding_${designHash({ source: { agentId, candidateHash: source.candidateHash }, issue }).slice(0, 32)}`, kind: "historical-review-opinion",
      trust: "untrusted-reference", current: false, source, issue: structuredClone(issue),
      suggestedRemedy: issue.remedy ?? null, closureEvidenceRequired: true,
      repairBasis: previous?.design ? historicalRepairSnapshot(previous.design, issue.candidatePaths as string[] ?? []) : null });
  }
  const coverageSources = structuredClone(saved?.coverageSources ?? {});
  if (saved && saved.coverage.status !== "available" && !Object.keys(coverageSources).length)
    coverageSources.legacy = structuredClone(saved.coverage);
  if (developmentRevision) {
    const feedback = developmentReviewFeedback(developmentRevision);
    const source = objectFields(developmentRevision).source ?? null;
    coverageSources[designHash(source)] = { source, status: feedback.status, total: feedback.total,
      omitted: feedback.omitted, scope: feedback.scope };
    for (const row of feedback.findings ?? []) add({ ...structuredClone(row), kind: "historical-development-review",
      trust: "untrusted-reference", current: false, closureEvidenceRequired: true,
      repairBasis: candidate ? historicalRepairSnapshot(candidate, row.issue?.candidatePaths as string[] ?? []) : null });
  }
  const coverage = { status: Object.values(coverageSources).every((row) => row.status === "available") ? "available" : "incomplete",
    sources: Object.keys(coverageSources).length, total: findings.length,
    incompleteSources: Object.values(coverageSources).filter((row) => row.status !== "available") };
  for (const finding of findings) if (finding.closure && !closureStillApplies(finding.closure, candidate, context)) delete finding.closure;
  return seal({ version: 1, agentId, trust: "untrusted-reference", scope, coverage, coverageSources, repairBases, findings });
}

export function architectureFeedbackContext(ledger: FeedbackLedger | null | undefined) {
  if (!ledger) return null;
  return { version: 1, ledgerHash: ledger.hash, trust: "untrusted-reference", scope, coverage: structuredClone(ledger.coverage),
    findings: structuredClone(ledger.findings.filter((row) => !row.closure)),
    closed: ledger.findings.filter((row) => row.closure).map(({ findingId, closure }) => ({ findingId, status: closure!.status,
      candidateHash: closure!.candidateHash, scope: "仅在关联方案正文、当前需求与平台事实均未改变时复用" })) };
}

export function architectureFeedbackFindings(ledger: FeedbackLedger | null | undefined, candidate: unknown, context: UnknownRecord) {
  return structuredClone((ledger?.findings ?? []).filter((finding) => !closureStillApplies(finding.closure, candidate, context)));
}

export function validateArchitectureFeedbackCoverage(ledger: FeedbackLedger | null | undefined) {
  if (ledger && ledger.coverage.status !== "available")
    fail("feedback_coverage_incomplete", "历史反馈覆盖不完整或来源不可用，不能将遗漏意见当作已解决并通过；核实原绑定记录及明确省略原因。");
}

/** A legacy pending repair can be cancelled by the newly authorized group judgments, never by an empty patch. */
export function closeArchitectureFeedbackByJudgment(ledger: FeedbackLedger | null | undefined, source: UnknownRecord,
  review: ArchitectureReview, checkpoint: unknown, context: UnknownRecord) {
  if (!ledger || !judgmentApprovesReview({ ...source, reviewJudgmentCheckpoint: checkpoint }, review))
    fail("feedback_judgment_missing", "撤销旧修订需要同一候选各组的完整通过判定。");
  const original = objectFields(source.review), findings = structuredClone(ledger.findings);
  for (const finding of findings.filter(row => !row.closure)) {
    const old = (isArray(original.issues) ? original.issues : []).find(item => designHash(item) === designHash(finding.issue));
    const originalIssue = objectFields(old);
    const retained = old && Object.values(objectFields(objectFields(checkpoint).groups)).some(group => {
      const rounds = objectFields(group).rounds;
      return isArray(rounds) && isArray(objectFields(objectFields(rounds[0]).parts).issues)
        && (objectFields(objectFields(rounds[0]).parts).issues as unknown[]).some(issue => designHash(issue) === designHash(old));
    });
    const decision = old ? review.issues.find(issue => issue.id === originalIssue.id)
      ?? (retained ? { ...finding.issue, blocking: false, remedy: "原小组补查后已通过；原问题与补查报告均保留在小组判定记录。" } : undefined) : undefined;
    if (!decision || decision.blocking) fail("feedback_judgment_uncovered", "仍有未被本次小组判定覆盖的历史问题，不能撤销整个修订任务。");
    const snapshot = historicalRepairSnapshot(source.design, decision.candidatePaths ?? []);
    if (!snapshot.anchors.length) fail("feedback_judgment_uncovered", "原问题缺少可绑定的当前正文，不能只凭分数关闭。");
    finding.closure = { status: "unsupported", candidateHash: review.candidateHash, reviewHash: designHash(review),
      factsHash: factsHash(context), reason: `本组 JEV 撤销原打回；未宣称设计已修改。${decision.remedy}`, anchors: snapshot.anchors };
  }
  const { hash: _hash, ...body } = ledger;
  return seal({ ...body, findings });
}

/** Call only after the full independent review has passed all existing validators. */
export function recordArchitectureFeedbackReview(ledger: FeedbackLedger | null | undefined, priorInput: unknown, review: ArchitectureReview, candidate: unknown, context: UnknownRecord) {
  const prior = priorFindings(priorInput);
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
