import { InputError } from "../requirements/core.mjs";
import { designHash } from "./architecture-contract.mjs";
import { developmentPlanningFailureSummary } from "./architecture-development-revision.mjs";
import { architectureReviewEvidenceContext, validateArchitectureReviewEvidence } from "./architecture-review-evidence.mjs";
import { architectureFeedbackFindings } from "./architecture-feedback-ledger.mjs";
import { validateHistoricalRepairDecision } from "./architecture-repair-evidence.mjs";

const nativeReviewContexts = new WeakMap();
const beneath = (pointer, root) => pointer === root || pointer.startsWith(`${root}/`);
const acceptanceCore = (item) => item ? { kind: item.kind, requirementIds: [...item.requirementIds].sort(),
  input: item.input, expected: item.expected, verification: item.verification ?? null } : null;

function adapterFacts(context, criterion) {
  const id = criterion?.verification?.adapterId;
  const guide = context?.acceptanceAdapterGuide;
  if (!id || !guide?.adapters?.[id]) return null;
  return { adapter: guide.adapters[id], admission: guide.admission?.[id] ?? null,
    composition: Object.fromEntries(["caseSetRule", "requirementCoverageRule", "splitRule", ...(id === "host-business" ? ["hostBusinessRule"] : [])]
      .map((key) => [key, guide.composition?.[key] ?? null])) };
}

function currentReviewContext(context, current, candidate) {
  try {
    if (!context || designHash(context.candidate) !== designHash(candidate)) return null;
    const verified = architectureReviewEvidenceContext({ design: candidate, ...Object.fromEntries(
      ["requirements", "runtimeCapabilities", "evidence", "confirmedRequirementContext", "deferredVerifications", "acceptanceAdapterGuide"]
        .map((key) => [key, context[key]])) });
    return designHash(verified.contextManifest) === current.contextManifestHash
      && designHash(context.contextManifest) === current.contextManifestHash
      && verified.contextManifest.acceptanceAdapterGuide.sha256 === current.guideHash ? verified : null;
  } catch { return null; }
}

function sourceReviewContext(reference, architecture, context) {
  try {
    const source = reference?.source, snapshot = architecture?.reviewEvidence?.snapshot;
    if (!context || !source || architecture?.status !== "passed" || architecture.review?.verdict !== "pass"
      || architecture.review.candidateHash !== architecture.candidateHash
      || architecture.agentId !== source.agentId || architecture.version !== source.architectureRef?.version
      || architecture.candidateHash !== source.architectureRef?.candidateHash || designHash(architecture.design) !== architecture.candidateHash
      || typeof source.sourceFingerprint !== "string" || typeof source.platformHash !== "string"
      || architecture.sourceFingerprint !== source.sourceFingerprint || architecture.platformHash !== source.platformHash
      || ![["requirementHash", architecture.requirements, context.requirements],
        ["runtimeCapabilityHash", architecture.runtimeCapabilities, context.runtimeCapabilities],
        ["confirmedContextHash", architecture.confirmedRequirementContext ?? null, context.confirmedRequirementContext],
        ["deferredContextHash", architecture.deferredVerifications ?? null, context.deferredVerifications]]
        .every(([key, oldValue, currentValue]) => typeof source[key] === "string"
          && designHash(oldValue) === source[key] && designHash(currentValue) === source[key])
      || snapshot?.version !== 1 || snapshot.candidateHash !== architecture.candidateHash || snapshot.platformHash !== architecture.platformHash
      || Object.keys(snapshot).sort().join(",") !== "acceptanceAdapterGuide,candidateHash,contextManifest,hash,platformHash,version"
      || architecture.reviewContext?.candidateHash !== architecture.candidateHash || architecture.reviewContext.platformHash !== architecture.platformHash
      || architecture.reviewEvidence.version !== 2 || architecture.reviewEvidence.snapshotHash !== snapshot.hash) return null;
    const { hash, ...body } = snapshot;
    if (hash !== designHash(body)) return null;
    const original = architectureReviewEvidenceContext({ design: architecture.design, requirements: architecture.requirements,
      runtimeCapabilities: architecture.runtimeCapabilities, evidence: architecture.evidence ?? [],
      confirmedRequirementContext: architecture.confirmedRequirementContext ?? null,
      deferredVerifications: architecture.deferredVerifications ?? null, acceptanceAdapterGuide: snapshot.acceptanceAdapterGuide });
    return designHash(original.contextManifest) === designHash(snapshot.contextManifest) ? original : null;
  } catch { return null; }
}

function resolutionBasis(original, context, acceptanceId) {
  const old = original?.candidate.acceptance?.find((entry) => entry.id === acceptanceId);
  const current = context?.candidate.acceptance?.find((entry) => entry.id === acceptanceId);
  if (!old || !adapterFacts(original, old)) return { status: "unavailable", reason: "source_acceptance_basis_unavailable" };
  const sourceAcceptanceHash = designHash(acceptanceCore(old)), sourceAdapterFactsHash = designHash(adapterFacts(original, old));
  const currentAcceptanceHash = current ? designHash(acceptanceCore(current)) : null;
  const currentAdapterFactsHash = current && adapterFacts(context, current) ? designHash(adapterFacts(context, current)) : null;
  return { status: "available", sourceAcceptanceHash, sourceAdapterFactsHash, currentAcceptanceHash, currentAdapterFactsHash,
    changed: currentAcceptanceHash !== null && currentAdapterFactsHash !== null
      && (sourceAcceptanceHash !== currentAcceptanceHash || sourceAdapterFactsHash !== currentAdapterFactsHash) };
}

function planningFindings(reference, candidate, original, context) {
  const failures = reference?.planningToolFailures, source = reference?.source;
  if (reference?.schemaVersion !== 1 || reference.trust !== "untrusted-reference" || reference.status !== "available"
    || failures?.schemaVersion !== 1 || failures.trust !== "untrusted-reference" || failures.current !== false || failures.status !== "available"
    || !source || !failures.source || !["agentId", "runId", "recordHash"].every((key) => typeof source[key] === "string" && source[key] === failures.source[key])) return null;
  const summary = developmentPlanningFailureSummary(reference);
  const rows = summary.issues.filter((entry) => typeof entry.proposedCaseRef?.acceptanceId === "string");
  return { source: structuredClone(failures.source), total: summary.total, findings: rows.map((entry) => {
    const acceptanceId = entry.proposedCaseRef.acceptanceId;
    const index = candidate?.acceptance?.findIndex((item) => item.id === acceptanceId) ?? -1;
    const diagnostic = { entryId: entry.entryId, toolCallId: entry.toolCallId, toolName: entry.toolName,
      path: entry.path, reason: entry.reason, remedy: entry.remedy, proposedCaseRef: structuredClone(entry.proposedCaseRef) };
    const findingId = `finding_${designHash({ kind: "planning-tool-failure", source: failures.source,
      caseId: entry.proposedCaseRef.id, acceptanceId, reason: entry.reason }).slice(0, 32)}`;
    return { findingId, kind: "historical-planning-diagnostic", developmentSource: structuredClone(failures.source), diagnostic,
      currentAcceptance: { id: acceptanceId, path: index >= 0 ? `/acceptance/${index}` : null },
      resolutionBasis: resolutionBasis(original, context, acceptanceId),
      issue: { id: findingId, blocking: false, checkId: "verification", source: "program",
        description: `历史未接受用例${entry.proposedCaseRef.id}关联验收${acceptanceId}时被程序拒绝：${entry.reason}；${entry.remedy}`,
        remedy: "按当前候选和适配器事实核对技术原因。说明已修复、仍存在，或仅为旧用例自身错误而不适用于当前架构；不能遗漏，也不能把历史拒绝自动当作新需求或本轮阻断。",
        candidatePaths: index >= 0 ? [`/acceptance/${index}`] : ["/acceptance"] } };
  }) };
}

function candidateReferenceComparison(issue, candidate, current) {
  const references = (Array.isArray(issue.references) ? issue.references : [])
    .flatMap((reference, referenceIndex) => reference?.source === "candidate" ? [{ reference, referenceIndex }] : []);
  const base = { candidateHash: current.candidateHash, scope: "literal-reference-presence-only" };
  try {
    if (!candidate || designHash(candidate) !== current.candidateHash)
      return { ...base, status: "unavailable", reason: "current_candidate_unavailable" };
    if (!references.length) return { ...base, status: "unavailable", reason: "historical_candidate_references_missing" };
    return { ...base, status: "available", total: references.length, retained: Math.min(12, references.length), omitted: Math.max(0, references.length - 12),
      references: references.slice(0, 12).map(({ reference, referenceIndex }) => {
        const current = at(candidate, reference.path);
        const text = current.found ? typeof current.value === "string" ? current.value : JSON.stringify(current.value) : null;
        return { referenceIndex, path: reference.path, currentPathExists: current.found,
          oldQuoteStillPresent: typeof reference.quote === "string" && reference.quote.trim() ? typeof text === "string" && text.includes(reference.quote) : null,
          currentValueHash: current.found ? designHash(current.value) : null };
      }) };
  } catch { return { ...base, status: "unavailable", reason: "candidate_reference_comparison_unavailable" }; }
}

export function architecturePriorFindings(previous, current, { developmentRevision, candidate, developmentArchitecture, evidenceContext, feedbackLedger } = {}) {
  const context = currentReviewContext(evidenceContext, current, candidate);
  const carried = architectureFeedbackFindings(feedbackLedger, candidate, context ?? evidenceContext ?? {}).map((finding) => {
    if (finding.kind !== "historical-planning-diagnostic") return finding;
    const id = finding.currentAcceptance.id, index = candidate?.acceptance?.findIndex((item) => item.id === id) ?? -1;
    finding.currentAcceptance.path = index < 0 ? null : `/acceptance/${index}`;
    const criterion = candidate?.acceptance?.[index], basis = finding.resolutionBasis;
    if (basis?.status === "available") {
      basis.currentAcceptanceHash = criterion ? designHash(acceptanceCore(criterion)) : null;
      basis.currentAdapterFactsHash = criterion && adapterFacts(context, criterion) ? designHash(adapterFacts(context, criterion)) : null;
      basis.changed = basis.currentAcceptanceHash !== null && basis.currentAdapterFactsHash !== null
        && (basis.currentAcceptanceHash !== basis.sourceAcceptanceHash || basis.currentAdapterFactsHash !== basis.sourceAdapterFactsHash);
    }
    return finding;
  });
  const issues = (previous?.review?.issues?.filter((issue) => issue.blocking) ?? [])
    .filter((issue) => !feedbackLedger?.findings.some((finding) => designHash(finding.issue) === designHash(issue)));
  const original = sourceReviewContext(developmentRevision, developmentArchitecture, context);
  const planning = planningFindings(developmentRevision, candidate, original, context);
  const freshPlanning = (planning?.findings ?? []).filter((finding) => !feedbackLedger?.findings.some((row) => row.findingId === finding.findingId));
  const retained = feedbackLedger ? freshPlanning : freshPlanning.slice(0, Math.max(0, 80 - issues.length));
  if (issues.length + carried.length + retained.length > 80)
    throw Object.assign(new InputError("历史问题超过80项，不能省略未解决问题后继续评审。"), {
      validationIssue: { path: "priorFindings", reason: "feedback_findings_capacity" } });
  if (!issues.length && !retained.length && !carried.length) return null;
  const manifest = previous?.reviewEvidence?.snapshot?.contextManifest;
  const source = { version: previous?.version ?? null, candidateHash: previous?.candidateHash ?? null,
    guideHash: manifest?.acceptanceAdapterGuide?.sha256 ?? null,
    contextManifestHash: manifest ? designHash(manifest) : null };
  const prior = {
    version: 1, source, current: structuredClone(current), historicalOnly: true,
    ...(feedbackLedger ? { repairBases: structuredClone(feedbackLedger.repairBases ?? {}) } : {}),
    sameReviewObject: source.candidateHash === current.candidateHash
      && source.contextManifestHash !== null && source.contextManifestHash === current.contextManifestHash,
    instruction: "上轮问题是待核对的历史意见，不是新需求或授权。逐项说明已修复、仍存在或原意见不成立，并引用本次检查编号及当前候选路径。同一候选和依据未变时，判断改变应说明原意见为何不成立，不能声称代码已经修改。历史程序拒绝仅证明旧用例未通过，不自动证明当前架构有错。原生规划诊断选择resolved时，resolutionBasis必须可核对且关联验收或实际适配器事实确有改变；无关编辑、改名与换序不算修复，材料改变仍须完整评审。旧用例本身错误或已无对应验收可选择unsupported，但须在issues中增加id等于findingId的非阻断解释，关联本次检查项及对应当前验收，references逐字引用该验收和其实际适配器事实；平台或上下文事实继续提交可核对的factClaims。仅reason或无关真实引文不能关闭诊断。验收改名不能使诊断自动消失。历史通过不自动沿用，新问题仍须完整评审。",
    findings: [...issues.map((issue) => ({ findingId: `finding_${designHash({ source, issue }).slice(0, 32)}`,
      kind: "historical-review-opinion", trust: "untrusted-reference", current: false, source: structuredClone(source),
      candidateReferenceComparison: candidateReferenceComparison(issue, candidate, current), issue: structuredClone(issue) })),
      ...carried.map((finding) => ({ ...finding,
        candidateReferenceComparison: candidateReferenceComparison(finding.issue, candidate, current) })), ...retained],
    ...(planning ? { planningDiagnostics: { source: planning.source, historicalOnly: true, total: planning.total,
      retained: retained.length, omitted: planning.total - retained.length, detailSection: "planningToolFailures" } } : {}),
    scopeChecks: (previous?.review?.acceptanceScopeChecks ?? []).map(({ acceptanceId, adapterId, sufficient }) => ({ acceptanceId, adapterId, sufficient })),
  };
  if (context) nativeReviewContexts.set(prior, { context, priorHash: designHash(prior) });
  return prior;
}

function at(value, pointer) {
  if (pointer === "") return { found: true, value };
  if (typeof pointer !== "string" || !pointer.startsWith("/") || /~(?![01])/u.test(pointer)) return { found: false };
  let current = value;
  for (const part of pointer.slice(1).split("/").map((entry) => entry.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (["__proto__", "prototype", "constructor"].includes(part) || !current || typeof current !== "object") return { found: false };
    const property = Object.getOwnPropertyDescriptor(current, part);
    if (!property || !Object.hasOwn(property, "value")) return { found: false };
    current = property.value;
  }
  return { found: true, value: current };
}

const exists = (value, pointer) => at(value, pointer).found;

function nativeDecisionEvidence(row, finding, review, candidate, context, path, fail) {
  const selected = finding.currentAcceptance.path;
  const linked = (pointer) => selected ? beneath(pointer, selected) : candidate.acceptance.some((_, index) => beneath(pointer, `/acceptance/${index}`));
  if (!row.candidatePaths.some(linked))
    fail(`${path}.candidatePaths`, "native_counterevidence_unrelated", "必须关联原诊断对应的当前验收；原验收已移除时明确引用当前替代验收，不得只引用无关说明");
  if (row.status === "resolved") {
    if (!context || finding.resolutionBasis?.status !== "available")
      fail(`${path}.status`, "native_basis_unavailable", "缺少可信来源验收及冻结事实，不能声称已经修复；可提供当前反证说明旧用例不适用，或保留本轮问题");
    if (!finding.resolutionBasis.changed)
      fail(`${path}.status`, "native_basis_unchanged", "关联验收及实际适配器事实未改变；无关修改、改名或换序不能作为已修复依据");
    return;
  }
  const explanation = review.issues.find((issue) => issue.id === finding.findingId && issue.blocking === false && row.checkIds.includes(issue.checkId));
  if (!context || !explanation)
    fail(`${path}.status`, "native_counterevidence_missing", "unsupported必须有id等于findingId的非阻断解释问题，提供当前验收和实际适配器事实的逐字反证；仅reason不成立");
  const references = explanation.references ?? [];
  const positions = candidate.acceptance.map((_, index) => `/acceptance/${index}`)
    .filter((root) => (!selected || root === selected) && row.candidatePaths.some((pointer) => beneath(pointer, root))
      && explanation.candidatePaths?.some((pointer) => beneath(pointer, root))
      && references.some((reference) => {
        if (reference.source !== "candidate") return false;
        if ([`${root}/input`, `${root}/expected`].includes(reference.path)) return true;
        if (reference.path !== root || typeof reference.quote !== "string") return false;
        const criterion = candidate.acceptance[Number(root.split("/")[2])];
        return [criterion.input, criterion.expected].some((body) => body.includes(reference.quote) || reference.quote.includes(body));
      }));
  const adapterReference = positions.some((root) => {
    const criterion = candidate.acceptance[Number(root.split("/")[2])], id = criterion.verification?.adapterId;
    const guideRoots = ["proves", "doesNotProve", "splitRule", "executionRule", "executionFacts"]
      .map((field) => `/adapters/${id}/${field}`);
    guideRoots.push(`/admission/${id}`, ...["caseSetRule", "requirementCoverageRule", "splitRule", ...(id === "host-business" ? ["hostBusinessRule"] : [])]
      .map((field) => `/composition/${field}`));
    return references.some((reference) => reference.source === "acceptanceAdapterGuide"
      && guideRoots.some((pointer) => beneath(reference.path, pointer)));
  });
  if (!positions.length || !adapterReference)
    fail(`${path}.status`, "native_counterevidence_unrelated", "反证必须同时逐字引用对应当前验收正文及其实际适配器事实，不能用编号或无关真实材料关闭诊断");
}

/** Check only supplied native closures; partial saves need not contain future checks or a verdict. */
export function architecturePriorFindingClosureIssues(parts, prior, candidate, evidenceContext) {
  if (!prior) return [];
  const byId = new Map(prior.findings.map((finding) => [finding.findingId, finding]));
  const rows = (parts.priorFindingDecisions ?? []).map((row, index) => ({ row, index, finding: byId.get(row.findingId) }))
    .filter(({ row, finding }) => (finding?.kind === "historical-planning-diagnostic" || finding?.closureEvidenceRequired)
      && ["resolved", "unsupported"].includes(row.status));
  if (!rows.length) return [];
  const context = currentReviewContext(evidenceContext, prior.current, candidate), issues = [];
  for (const { row, index, finding } of rows) {
    const path = `review.priorFindingDecisions[${index}]`;
    const fail = (path, reason, remedy) => { throw Object.assign(new InputError(remedy), { validationIssue: { path, reason, remedy } }); };
    try {
      if (!candidate || parts.candidateHash !== prior.current.candidateHash || designHash(candidate) !== prior.current.candidateHash)
        fail(`${path}.findingId`, "candidate_mismatch", "历史问题必须绑定当前候选。");
      if (prior.sameReviewObject && row.status === "resolved")
        fail(`${path}.status`, "unchanged_review_object", "候选和依据均未改变，不能声称已修复。");
      if (finding.closureEvidenceRequired)
        validateHistoricalRepairDecision(row, { ...finding, repairBasis: finding.repairBasis ?? prior.repairBases?.[finding.repairBasisHash] }, parts, candidate, context, path);
      else nativeDecisionEvidence(row, finding, parts, candidate, context, path, fail);
      if (row.status === "unsupported") {
        const explanation = parts.issues.find((issue) => issue.id === row.findingId);
        validateArchitectureReviewEvidence({ checks: [], issues: [explanation], acceptanceScopeChecks: [] }, context, { partial: true });
      }
    } catch (error) {
      if (!(error instanceof InputError) || !error.validationIssue) throw error;
      const explanationIndex = (parts.issues ?? []).findIndex(issue => issue.id === row.findingId);
      for (const issue of error.validationIssues ?? [error.validationIssue])
        issues.push({ findingId: row.findingId,
          path: explanationIndex > 0 ? issue.path.replace(/^review\.issues\[0\](?=\.)/u, `review.issues[${explanationIndex}]`) : issue.path,
          reason: issue.reason,
          ...(issue.candidatePath ? { candidatePath: issue.candidatePath } : {}), remedy: issue.remedy ?? error.message });
    }
  }
  return issues;
}

export function validateArchitecturePriorFindings(review, prior, candidate, options = {}) {
  if (!prior) return review;
  const fail = (path, reason, message) => {
    throw Object.assign(new InputError(`历史问题复核无效：${message}`), { validationIssue: { path, reason } });
  };
  if (review.candidateHash !== prior.current.candidateHash || designHash(candidate) !== prior.current.candidateHash)
    fail("review.priorFindingDecisions", "candidate_mismatch", "必须绑定当前候选");
  const rows = review.priorFindingDecisions;
  if (!Array.isArray(rows) || rows.length !== prior.findings.length)
    fail("review.priorFindingDecisions", "missing_coverage", "必须逐项复核上轮每个问题，不能遗漏或增加历史问题");
  const ids = new Set(prior.findings.map((entry) => entry.findingId)), seen = new Set();
  const byId = new Map(prior.findings.map((entry) => [entry.findingId, entry]));
  const checkIds = new Set(review.checks.map((entry) => entry.id));
  const saved = nativeReviewContexts.get(prior);
  const explicitContext = Object.hasOwn(options, "evidenceContext");
  const context = explicitContext ? currentReviewContext(options.evidenceContext, prior.current, candidate)
    : saved?.priorHash === designHash(prior) ? saved.context : null;
  if (explicitContext && !context)
    fail("review.priorFindingDecisions", "context_mismatch", "历史问题必须绑定同版完整评审事实");
  if (context && rows.some((row) => row.status === "unsupported" && byId.get(row.findingId)?.kind === "historical-planning-diagnostic"))
    validateArchitectureReviewEvidence(review, context);
  for (const [index, row] of rows.entries()) {
    const path = `review.priorFindingDecisions[${index}]`;
    if (!ids.has(row.findingId) || seen.has(row.findingId)) fail(`${path}.findingId`, "invalid_reference", "问题编号必须来自本轮历史清单且不能重复");
    seen.add(row.findingId);
    if (!Array.isArray(row.checkIds) || !row.checkIds.length || new Set(row.checkIds).size !== row.checkIds.length
      || row.checkIds.some((id) => !checkIds.has(id))) fail(`${path}.checkIds`, "invalid_reference", "必须关联本次评审的真实检查项");
    if (!Array.isArray(row.candidatePaths) || !row.candidatePaths.length || row.candidatePaths.some((pointer) => !exists(candidate, pointer)))
      fail(`${path}.candidatePaths`, "candidate_path_missing", "必须指出当前候选实际存在的依据位置");
    if (prior.sameReviewObject && row.status === "resolved")
      fail(`${path}.status`, "unchanged_review_object", "候选和依据均未改变；如新判断认为已无问题，应选择unsupported并解释原意见为何不成立");
    const finding = byId.get(row.findingId);
    if (finding.closureEvidenceRequired && ["resolved", "unsupported"].includes(row.status))
      validateHistoricalRepairDecision(row, { ...finding, repairBasis: finding.repairBasis ?? prior.repairBases?.[finding.repairBasisHash] }, review, candidate, context, path);
    else if (finding.kind === "historical-planning-diagnostic" && ["resolved", "unsupported"].includes(row.status))
      nativeDecisionEvidence(row, finding, review, candidate, context, path, fail);
    if (row.status === "unresolved" && (review.verdict === "pass" || !review.issues.some((issue) => issue.blocking && row.checkIds.includes(issue.checkId))))
      fail(`${path}.status`, "missing_open_issue", "仍存在的问题必须有本次阻断，不能判定整体通过");
  }
  return review;
}

export function architectureReviewTransitions(prior, review) {
  if (!prior) return null;
  const previous = new Map(prior.scopeChecks.map((row) => [row.acceptanceId, row]));
  const changes = (review.acceptanceScopeChecks ?? []).flatMap((row) => {
    const old = previous.get(row.acceptanceId);
    return old && old.adapterId === row.adapterId && old.sufficient !== row.sufficient
      ? [{ acceptanceId: row.acceptanceId, previousSufficient: old.sufficient, currentSufficient: row.sufficient }] : [];
  });
  return { source: structuredClone(prior.source), current: structuredClone(prior.current), sameReviewObject: prior.sameReviewObject,
    decisions: structuredClone(review.priorFindingDecisions), scopeJudgmentChanges: changes,
    unchangedObjectJudgmentChanged: prior.sameReviewObject && changes.length > 0 };
}
