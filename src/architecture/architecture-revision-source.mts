import type { ToolSchema } from "../contracts/tools.mjs";
import type { UnknownRecord } from "../contracts/json.mjs";
import type { ArchitectureDesign, ArchitectureReview, ArchitectureIssue, RequirementItem, ArchitectureEvidenceContext, EvidenceItem } from "../contracts/architecture.mjs";
import type { StoredArchitectureRecord, Definition, ModuleProposal, ModuleConsultation } from "./architecture-controller-port.mjs";
import type { AgentStoragePort } from "../runtime/storage-port.mjs";
import { objectFields, isArray, isInteger } from "../runtime/type-boundary.mjs";
import { InputError } from "../requirements/core.mjs";
import { textWithinLimit } from "../runtime/text-length.mjs";
import { ARCHITECTURE_VERSION, ARCHITECTURE_STORED_TURN_LIMIT, architectureTurnBudgetSpent,
  validateDesign, validateReview, checkDesign, designHash, requiresDevelopment } from "./architecture-contract.mjs";
import { platformEvidence, platformCapabilityCatalog, validatePlatformMetadata } from "./platform-contract.mjs";
import type { createPlatformSnapshot } from "./platform-contract.mjs";
import { architectureReviewEvidenceContext, architectureHistoricalEvidenceCatalog } from "./architecture-review-evidence.mjs";
import { ACCEPTANCE_ADAPTER_GUIDE } from "../verification/acceptance-contract.mjs";
import { checkedStoredArchitectureRecord } from "./architecture-storage-boundary.mjs";
import { readHistoricalDevelopmentRun, latestDevelopmentFailure, savedDevelopmentRevisionSource, developmentFailureFromSavedSource,
  developmentRevisionReference, developmentReviewFeedback } from "./architecture-development-revision.mjs";
import { feedbackLedger, feedbackFindings } from "./architecture-feedback-port.mjs";
import { architectureFeedbackContext } from "./architecture-feedback-ledger.mjs";
import { readMainReviewCheckpoint } from "./architecture-main-review-checkpoint.mjs";
import { readReviewProgressCheckpoint, readLegacyReviewProgressCheckpoint } from "./architecture-review-progress.mjs";
import { readArchitectureFidelityProgress } from "./architecture-fidelity-progress.mjs";
import { readArchitectureFidelityRevision } from "./architecture-fidelity-revision.mjs";
import { readArchitectureRejectedFidelityReference } from "./architecture-fidelity-rejected-reference.mjs";
import type { architectureVerificationContext, architectureConfirmedContext } from "./architecture-input-context.mjs";
import type { runtimeCapabilityContract } from "../runtime/runtime-capability-contract.mjs";

const object = <T extends Record<string, ToolSchema>>(properties: T, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const text = (maxLength = 2000) => ({ type: "string", minLength: 1, maxLength });
export const moduleResultSchema = object({ proposal: text(8000), interfaces: text(4000),
  tradeoffs: text(4000), evidenceIds: { type: "array", items: text(), maxItems: 12 },
  unknowns: { type: "array", items: text(), maxItems: 12 } });

export function checkedModule(input: unknown): ModuleProposal {
  const value = objectFields(input);
  if (!value || (["proposal", "interfaces", "tradeoffs"] as const).some((key) => !textWithinLimit(value[key], moduleResultSchema.properties[key].maxLength) || !String(value[key]).trim())
    || (["evidenceIds", "unknowns"] as const).some((key) => !isArray(value[key]) || value[key].length > 12
      || value[key].some((entry) => !textWithinLimit(entry, 2000)))) throw new InputError("局部设计缺少方案、接口、取舍或证据说明");
  return structuredClone(input) as ModuleProposal;
}

export interface RevisionSeed {
  design?: unknown; evidence?: EvidenceItem[]; evidenceContext?: unknown; modules?: ModuleConsultation[]; researchGaps?: string[]; issues?: ArchitectureIssue[];
  previousReview?: { version: number; candidateHash: string | null; review: ArchitectureReview; reviewEvidence?: unknown } | undefined;
  source: UnknownRecord & { version?: number; candidateHash?: string | null; platformHash?: string; requirementHash?: string; confirmedContextHash?: string | null; deferredContextHash?: string | null;
    kind?: string; interruptedVersion?: number; candidateTrust?: string; reviewRepair?: unknown; feedbackRepair?: unknown; developmentRunId?: string | undefined; developmentRecordHash?: string | undefined; developmentArchitectureRef?: unknown };
  mainReviewCheckpoint?: ReturnType<typeof readMainReviewCheckpoint>; reviewProgressCheckpoint?: ReturnType<typeof readReviewProgressCheckpoint>;
  requirementFidelityProgress?: ReturnType<typeof readArchitectureFidelityProgress>; reviewPending?: boolean; developmentRevision?: unknown;
  fidelityRevision?: ReturnType<typeof readArchitectureFidelityRevision>; rejectedFidelityReference?: Awaited<ReturnType<typeof readArchitectureRejectedFidelityReference>>;
}

function architectureRevisionBindingsMatch(previous: StoredArchitectureRecord | null | undefined, definition: Definition, context: RevisionContext, options?: { allowUnsubmitted?: boolean }): previous is StoredArchitectureRecord;
function architectureRevisionBindingsMatch(previous: unknown, definition: Definition, context: RevisionContext, options?: { allowUnsubmitted?: boolean }): boolean;
function architectureRevisionBindingsMatch(previousInput: unknown, definition: Definition, { requirements, platformContext, deferred, confirmedRequirementContext, runtimeCapabilities }: RevisionContext, { allowUnsubmitted = false } = {}) {
  if (!previousInput) return false;
  const previous = objectFields(previousInput);
  try {
    validatePlatformMetadata(previous);
    const { platformSnapshot, platformHash } = platformContext;
    // No candidate has replaced the record's legacy initialization version yet.
    const unsubmitted = allowUnsubmitted && previous.contractVersion === ARCHITECTURE_VERSION
      && previous.design === null && previous.candidateHash === null && previous.review === null
      && Array.isArray(previous.attempts) && previous.attempts.length === 0;
    if (previous.agentId !== definition.id || previous.name !== definition.name || previous.sourceFingerprint !== definition.fingerprint
      || designHash(previous.draft) !== designHash(definition.draft) || designHash(previous.requirements) !== designHash(requirements)
      || previous.platformHash !== platformHash || previous.platformContractVersion !== platformContext.platformContractVersion
      || previous.contractVersion !== platformSnapshot.architectureSchemaVersion && !unsubmitted
      || previous.design != null && objectFields(previous.design).schemaVersion !== previous.contractVersion
      || designHash(previous.confirmedRequirementContext ?? null) !== designHash(confirmedRequirementContext ?? null)
      || designHash(previous.deferredVerifications ?? null) !== designHash(deferred.context ?? null)
      || previous.runtimeCapabilities && designHash(previous.runtimeCapabilities) !== designHash(runtimeCapabilities)) return false;
    return true;
  } catch { return false; }
}

export function sealArchitectureReviewEvidence(context: ArchitectureEvidenceContext, { candidateHash, platformHash }: { candidateHash: string; platformHash: string }) {
  const body = { version: 1, candidateHash, platformHash, acceptanceAdapterGuide: structuredClone(context.acceptanceAdapterGuide),
    contextManifest: structuredClone(context.contextManifest) };
  return { ...body, hash: designHash(body) };
}

function historicalArchitectureReviewEvidence(previous: StoredArchitectureRecord, options: { design: ArchitectureDesign; requirements: RequirementItem[]; runtimeCapabilities: unknown; evidence: EvidenceItem[]; confirmedRequirementContext?: unknown; deferredVerifications?: unknown; evidenceHistory?: StoredArchitectureRecord[] | undefined }) {
  const snapshotInput = previous.reviewEvidence?.snapshot, snapshot = objectFields(snapshotInput);
  if (snapshotInput === undefined) {
    if ((previous.reviewEvidence?.version as number) >= 2) throw new InputError("历史评审缺少已绑定的说明快照");
    return architectureReviewEvidenceContext({ ...options, acceptanceAdapterGuide: ACCEPTANCE_ADAPTER_GUIDE });
  }
  if (!snapshot || snapshot.version !== 1 || Object.keys(snapshot).sort().join(",")
    !== "acceptanceAdapterGuide,candidateHash,contextManifest,hash,platformHash,version"
    || snapshot.candidateHash !== previous.candidateHash || snapshot.platformHash !== previous.platformHash
    || objectFields(previous.reviewContext).candidateHash !== previous.candidateHash || objectFields(previous.reviewContext).platformHash !== previous.platformHash
    || previous.reviewEvidence?.version !== 2 || previous.reviewEvidence.snapshotHash !== snapshot.hash)
    throw new InputError("历史评审说明快照的版本绑定无效");
  const { hash, ...body } = snapshot;
  if (hash !== designHash(body)) throw new InputError("历史评审说明快照摘要无效");
  const result = architectureReviewEvidenceContext({ ...options,
    evidence: architectureHistoricalEvidenceCatalog(previous, options.evidenceHistory), acceptanceAdapterGuide: snapshot.acceptanceAdapterGuide });
  if (designHash(result.contextManifest) !== designHash(snapshot.contextManifest)) throw new InputError("历史评审材料与冻结来源摘要不一致");
  return result;
}

function architectureMaterialSeed(previous: StoredArchitectureRecord | null | undefined, definition: Definition, context: RevisionContext) {
  if (!architectureRevisionBindingsMatch(previous, definition, context)) return null;
  const { requirements, platformContext, runtimeCapabilities } = context;
  try {
    const { platformSnapshot, platformHash } = platformContext;
    if (!Array.isArray(previous.evidence) || !Array.isArray(previous.modules) || !Array.isArray(previous.researchGaps)) return null;
    const currentPlatformEvidence = platformEvidence(platformSnapshot);
    const shape = (value: unknown, keys: string[]): value is UnknownRecord => value !== null && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).every((key) => keys.includes(key));
    const boundedText = (value: unknown, maximum: number, nonempty = true): value is string => textWithinLimit(value, maximum) && (!nonempty || Boolean(value.trim()));
    for (const source of previous.evidence) {
      if (!shape(source, ["id", "title", "url", "retrievedAt", "versionScope", "excerpt", "truncated", "kind"])) return null;
      if (source.id === currentPlatformEvidence.id) {
        if (designHash(source) !== designHash(currentPlatformEvidence)) return null;
        continue;
      }
      if (source.kind !== undefined || typeof source.id !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(source.id)
        || !boundedText(source.title, 2000) || !boundedText(source.url, 4000) || !boundedText(source.versionScope, 4000)
        || !boundedText(source.excerpt, 6000, false) || source.truncated !== undefined && typeof source.truncated !== "boolean"
        || source.retrievedAt !== undefined && (!boundedText(source.retrievedAt, 80) || !Number.isFinite(Date.parse(source.retrievedAt)))) return null;
      const url = new URL(source.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    }
    const evidence = [currentPlatformEvidence, ...previous.evidence.filter((entry) => entry.id !== currentPlatformEvidence.id)];
    if (previous.researchGaps.some((gap) => !boundedText(gap, 8000))) return null;
    const modules = previous.modules.map((module) => {
      if (!shape(module, ["assignment", "result"]) || !shape(module.assignment, ["question", "boundary", "benefit"])
        || ["question", "boundary", "benefit"].some((key) => !boundedText(objectFields(module.assignment)[key], 2000))
        || !shape(module.result, ["proposal", "interfaces", "tradeoffs", "evidenceIds", "unknowns"])) throw new InputError("历史模块结构无效");
      const result = checkedModule(module.result);
      if (["interfaces", "tradeoffs"].some((key) => !boundedText(objectFields(result)[key], 4000))
        || result.unknowns.some((entry) => !boundedText(entry, 2000))
        || result.evidenceIds.some((id) => !evidence.some((entry) => entry.id === id))) throw new InputError("历史模块证据无法核对");
      return { assignment: structuredClone(module.assignment), result };
    });
    const design = validateDesign(previous.design, { draft: definition.draft, requirements,
      capabilities: platformCapabilityCatalog(platformSnapshot, { runtimeCapabilities }), evidence,
      confirmedRequirementContext: context.confirmedRequirementContext,
      deferredVerifications: context.deferred.context, requireAcceptanceVerification: Boolean(definition.draft.taskSpec), ...platformContext });
    const candidateHash = designHash(design);
    if (candidateHash !== previous.candidateHash) return null;
    const evidenceContext = (design.schemaVersion ?? 1) >= 3 ? historicalArchitectureReviewEvidence(previous, { design, requirements, runtimeCapabilities,
      evidence, evidenceHistory: context.evidenceHistory, confirmedRequirementContext: previous.confirmedRequirementContext ?? null,
      deferredVerifications: previous.deferredVerifications ?? null }) : undefined;
    return { design, evidence: structuredClone(evidence), evidenceContext, modules, researchGaps: structuredClone(previous.researchGaps), source: {
        version: previous.version, candidateHash, platformHash,
        requirementHash: designHash(requirements), confirmedContextHash: context.confirmedRequirementContext?.hash ?? null,
        deferredContextHash: context.deferred.context ? designHash(context.deferred.context) : null,
        historicalOnly: true, materialScope: "沿用上版已保存来源与模块，保留原检索日期、版本范围及截断标记；不是本轮重新核实或评审通过。",
        issueScope: "上轮意见只是待核对的修复建议，不是新业务要求或授权。逐项按当前requirements与平台检查，合并重复意见；不因旧评语扩大交付承诺、权限或业务代码职责。新候选仍须程序校验及独立评审。",
        evidenceIds: previous.evidence.map((entry) => entry.id), moduleCount: previous.modules.length,
      } };
  } catch { return null; }
}

export function reviewedArchitectureSeed(previous: StoredArchitectureRecord | null | undefined, definition: Definition, context: RevisionContext): RevisionSeed | null {
  if (!previous) return null;
  const materials = architectureMaterialSeed(previous, definition, context);
  if (!materials) return null;
  try {
    const last = previous.attempts?.at(-1);
    if (!previous.review || !last || last.candidateHash !== previous.candidateHash
      || designHash(last.design) !== previous.candidateHash || designHash(last.review) !== designHash(previous.review)
      || designHash(last.issues) !== designHash(previous.issues)
      || (previous.reviewEvidence?.version as number) >= 2 && (designHash(last.reviewContext) !== designHash(previous.reviewContext)
        || designHash(last.reviewEvidence) !== designHash(previous.reviewEvidence))) return null;
    validateReview(previous.review, { candidateHash: previous.candidateHash, schemaVersion: materials.design.schemaVersion,
      evidenceContext: materials.evidenceContext });
    const { evidenceContext, ...seed } = materials;
    return { ...seed, issues: structuredClone(previous.issues), previousReview: { version: previous.version, candidateHash: materials.source.candidateHash,
      review: structuredClone(previous.review), ...(previous.reviewEvidence ? { reviewEvidence: structuredClone(previous.reviewEvidence) } : {}) } };
  } catch { return null; }
}

export function architectureRevisionSeed(previous: StoredArchitectureRecord | null | undefined, definition: Definition, context: RevisionContext): RevisionSeed | null {
  return previous?.status === "needs_changes" ? reviewedArchitectureSeed(previous, definition, context) : null;
}

export function fidelityArchitectureRevisionSeed(previous: StoredArchitectureRecord | null | undefined, records: StoredArchitectureRecord[], definition: Definition, context: RevisionContext): RevisionSeed | null {
  if (!previous) return null;
  const reference = objectFields(previous?.revisionSource), repair = objectFields(reference.reviewRepair);
  const continued = repair?.reason === "requirement_fidelity_rejected"
    && ["failed", "cancelled"].includes(previous?.status)
    && (previous.candidateHash === null || previous.candidateHash === repair.candidateHash);
  const original = continued ? [...records].find((record) => record.agentId === definition.id && record.version === reference.version) : previous;
  if (continued && !architectureRevisionBindingsMatch(previous, definition, context, { allowUnsubmitted: true })) return null;
  const materials = architectureMaterialSeed(original, definition, context);
  if (!materials) {
    if (continued) throw new InputError("范围否定的原始来源不可恢复，不能建立替代评审");
    return null;
  }
  if (original?.mainReviewCheckpoint?.fidelityStatus !== "not_preserved") {
    if (continued) throw new InputError("范围否定的原始结论不可恢复，不能建立替代评审");
    return null;
  }
  const fidelityRevision = readArchitectureFidelityRevision(original, materials.evidenceContext);
  if (!fidelityRevision || continued && (designHash(reference.fidelitySource) !== designHash(fidelityRevision.source)
    || repair.candidateHash !== original!.candidateHash || repair.modelCalls !== fidelityRevision.modelCalls))
    throw new InputError("范围否定的原始来源或已用额度无效，不能换用新评审预算");
  const { evidenceContext, ...seed } = materials;
  return { ...seed, issues: structuredClone(original!.issues), fidelityRevision,
    source: { ...materials.source, kind: "requirement-fidelity-revision", fidelitySource: fidelityRevision.source,
      candidateTrust: "unreviewed-reference", reviewRepair: { candidateHash: original!.candidateHash,
        modelCalls: fidelityRevision.modelCalls, reason: "requirement_fidelity_rejected" } } };
}

export async function rejectedFidelityArchitectureRevisionSeed(previous: StoredArchitectureRecord | null | undefined, records: StoredArchitectureRecord[], definition: Definition, context: RevisionContext, { storage, cwd, signal }: { storage: AgentStoragePort; cwd: string; signal?: AbortSignal | undefined }): Promise<RevisionSeed | null> {
  if (!previous) return null;
  const reference = objectFields(previous?.revisionSource), repair = objectFields(reference.reviewRepair);
  const interrupted = ["failed", "cancelled"].includes(previous?.status);
  const marked = reference?.kind === "requirement-fidelity-submission-revision"
    || reference && Object.hasOwn(reference, "rejectedFidelitySource");
  if (marked && interrupted && (previous.candidateHash === null || previous.candidateHash === reference.candidateHash
    || previous.diagnostic?.role === "designer")
    && (repair?.reason !== "rejected_fidelity_submission" || !architectureTurnBudgetSpent(repair.modelCalls)
      || repair.candidateHash !== reference.candidateHash || !isInteger(reference.version) || reference.version >= previous.version))
    throw new InputError("被拒复核的修订来源标记不完整，不能改用新评审预算");
  const continued = repair?.reason === "rejected_fidelity_submission"
    && interrupted
    && (previous.candidateHash === null || previous.candidateHash === repair.candidateHash);
  const original = continued ? [...records].find((record) => record.agentId === definition.id && record.version === reference.version) : previous;
  if (continued && !architectureRevisionBindingsMatch(previous, definition, context, { allowUnsubmitted: true }))
    throw new InputError("被拒复核的修订来源已变化，不能建立替代评审");
  const materials = architectureMaterialSeed(original, definition, context);
  if (!materials) {
    if (continued) throw new InputError("被拒复核的原始材料不可恢复，不能建立替代评审");
    return null;
  }
  let feedback;
  if (original?.mainReviewCheckpoint?.fidelityStatus === "pending" && architectureTurnBudgetSpent(objectFields(original.mainReviewCheckpoint).modelCalls)) {
    try {
      feedback = await readArchitectureRejectedFidelityReference(original, materials.evidenceContext, {
        cwd, directory: await storage.directory(definition.id, "architecture/fidelity"), signal });
    } catch { signal?.throwIfAborted(); }
  }
  if (!feedback) {
    if (continued) throw new InputError("被拒复核的真实会话不可核对，不能建立替代评审");
    return null;
  }
  if (continued && (designHash(reference.rejectedFidelitySource) !== designHash(feedback.source)
    || repair.candidateHash !== original!.candidateHash || repair.modelCalls !== feedback.modelCalls))
    throw new InputError("被拒复核的会话或已用额度已变化，不能建立替代评审");
  const { evidenceContext, ...seed } = materials;
  return { ...seed, issues: structuredClone(original!.issues), rejectedFidelityReference: feedback,
    source: { ...materials.source, kind: "requirement-fidelity-submission-revision", rejectedFidelitySource: feedback.source,
      candidateTrust: "unreviewed-reference", reviewRepair: { candidateHash: original!.candidateHash,
        modelCalls: feedback.modelCalls, reason: "rejected_fidelity_submission" } } };
}

export function developmentArchitectureRevisionSeed(previous: StoredArchitectureRecord | null | undefined, runInput: unknown, definition: Definition, context: RevisionContext, signal: AbortSignal | undefined) {
  try {
    const run = runInput ? readHistoricalDevelopmentRun(runInput) : null;
    if (!run || !previous?.runtimeCapabilities || previous.status !== "passed" || previous.review?.verdict !== "pass"
      || previous.issues?.some((item) => item.blocking) || !requiresDevelopment(previous.design)
      || !latestDevelopmentFailure([run], previous) || !objectFields(run.architecture).runtimeCapabilities
      || !architectureRevisionBindingsMatch(run.architecture, definition, context)
      || objectFields(run.architecture).version !== previous.version || objectFields(run.architecture).candidateHash !== previous.candidateHash
      || designHash(objectFields(run.architecture).design) !== previous.candidateHash
      || designHash(objectFields(run.architecture).review) !== designHash(previous.review)) return null;
    const seed = reviewedArchitectureSeed(previous, definition, context);
    if (!seed) return null;
    const developmentRevision = developmentRevisionReference(run, previous, { signal });
    return { ...seed, developmentRevision, source: { ...seed.source, kind: "development-failure",
      developmentRunId: run.id, developmentRecordHash: developmentRevision.source.recordHash,
      developmentArchitectureRef: structuredClone(run.architectureRef) } };
  } catch { signal?.throwIfAborted(); return null; }
}

export function continuedDevelopmentRevisionSeed(previous: StoredArchitectureRecord | null | undefined, original: StoredArchitectureRecord | null | undefined, run: unknown, definition: Definition, context: RevisionContext, signal: AbortSignal | undefined): RevisionSeed | null {
  try {
    const diagnostic = previous?.diagnostic, phase = ({ designer: "designing", reviewer: "evaluating" } as Record<string, string>)[diagnostic?.role ?? ""];
    if (!previous?.runtimeCapabilities || !architectureRevisionBindingsMatch(previous, definition, context, { allowUnsubmitted: true })
      || !developmentFailureFromSavedSource(run ? readHistoricalDevelopmentRun(run) : null, previous)) return null;
    const seed = developmentArchitectureRevisionSeed(original, run, definition, context, signal);
    if (!seed || designHash(seed.developmentRevision.source) !== designHash(savedDevelopmentRevisionSource(previous))) return null;
    const source = { ...seed.source, interruptedVersion: previous.version };
    // Carrying a checked read-only reference does not qualify an interrupted candidate or review.
    const candidateContinuation = diagnostic?.stage === "architecture" && phase && diagnostic.phase === phase
      && architectureInterruptionReason(diagnostic.reason);
    if (candidateContinuation) return { ...seed, source };
    const materials = architectureMaterialSeed(previous, definition, context);
    if (!materials) return { developmentRevision: seed.developmentRevision, source };
    return { design: materials.design, evidence: materials.evidence, modules: materials.modules, researchGaps: materials.researchGaps,
      developmentRevision: seed.developmentRevision, source: { ...materials.source, kind: source.kind,
        developmentRunId: source.developmentRunId, developmentRecordHash: source.developmentRecordHash,
        developmentArchitectureRef: source.developmentArchitectureRef, interruptedVersion: previous.version, candidateTrust: "unreviewed-reference" } };
  } catch { signal?.throwIfAborted(); return null; }
}

export function interruptedArchitectureRevisionSeed(previous: StoredArchitectureRecord | null | undefined, records: StoredArchitectureRecord[], definition: Definition, context: RevisionContext): RevisionSeed | null {
  if (!previous) return null;
  const diagnostic = previous?.diagnostic;
  const phase = ({ designer: "designing", reviewer: "evaluating" } as Record<string, string>)[diagnostic?.role ?? ""];
  const legacyMissingSubmission = diagnostic?.reason === "invalid_result" && diagnostic.modelCalls === 1 && diagnostic.submissionAttempts === 0;
  if (!["cancelled", "failed"].includes(previous?.status)
    || diagnostic?.stage !== "architecture" || !phase || diagnostic.phase !== phase
    || !previous.runtimeCapabilities
    || !architectureRevisionBindingsMatch(previous, definition, context,
      { allowUnsubmitted: diagnostic.role === "designer" && diagnostic.phase === "designing" })) return null;
  for (let attemptIndex = (previous.attempts?.length ?? 0) - 1; attemptIndex >= 0; attemptIndex--) {
    const attempt = previous.attempts[attemptIndex];
    if (!attempt?.review || !["revise", "pass"].some(verdict => verdict === objectFields(attempt.review).verdict)
      || !Array.isArray(attempt.issues) || !attempt.issues.some((issue) => objectFields(issue).blocking)) continue;
    const reviewed = checkedStoredArchitectureRecord({ ...previous, design: structuredClone(attempt.design), candidateHash: attempt.candidateHash,
      reviewContext: structuredClone(attempt.reviewContext), review: structuredClone(attempt.review), issues: structuredClone(attempt.issues), status: "needs_changes",
      reviewEvidence: structuredClone(attempt.reviewEvidence ?? previous.reviewEvidence),
      attempts: previous.attempts.slice(0, attemptIndex + 1) });
    const seed = architectureRevisionSeed(reviewed, definition, context);
    if (seed) return { ...seed, source: { ...seed.source, attemptIndex, interruptedVersion: previous.version } };
  }
  if (!legacyMissingSubmission && !architectureInterruptionReason(diagnostic.reason)) return null;
  if (previous.review) return null;
  const saved = [...records], reference = objectFields(previous.revisionSource), repair = objectFields(reference.reviewRepair);
  if (diagnostic.role === "designer" && previous.design === null && previous.candidateHash === null
    && isInteger(reference.version) && reference.version < previous.version
    && architectureTurnBudgetSpent(repair.modelCalls) && repair.reason === "native_planning_rejection" && repair.candidateHash === reference.candidateHash) {
    const original = saved.find((record) => record.agentId === definition.id && record.version === reference.version);
    const materials = original && ["failed", "cancelled"].includes(original.status) && original.review === null
      && original!.candidateHash === reference.candidateHash ? architectureMaterialSeed(original, definition, context) : null;
    const used = materials ? Math.max(readMainReviewCheckpoint(original)?.modelCalls ?? 0,
      (readReviewProgressCheckpoint(original) ?? readLegacyReviewProgressCheckpoint(original))?.modelCalls ?? 0) : 0;
    if (materials && used === repair.modelCalls && ["platformHash", "requirementHash", "confirmedContextHash", "deferredContextHash"]
      .every((key) => reference[key] === objectFields(materials.source)[key])) {
      const { evidenceContext, ...seed } = materials;
      return { ...seed, issues: [], source: { ...seed.source, interruptedVersion: previous.version,
        candidateTrust: "unreviewed-reference", reviewRepair: structuredClone(repair) } };
    }
  }
  const historical = saved.filter((record) => record.agentId === definition.id && record.version < previous.version)
    .sort((left, right) => right.version - left.version);
  for (const record of historical) {
    if (!record.runtimeCapabilities) continue;
    const seed = architectureRevisionSeed(record, definition, context);
    if (seed) return { ...seed, source: { ...seed.source, interruptedVersion: previous.version } };
  }
  return null;
}

function architectureInterruptionReason(reason: unknown) {
  return ["turn_limit", "cancelled", "scope_evaluation_incomplete", "handoff_evaluation_incomplete", "submission_incomplete", "review_repair_stalled", "review_slice_incomplete", "process_interrupted",
    "output_limit", "module_output_limit", "module_failed", "request_blocked", "api_authentication", "api_rate_limit", "api_not_found", "api_unavailable", "api_context", "api_output_limit",
    "api_rejected", "api_stream_interrupted", "api_protocol", "api_connection", "api_idle_timeout"].some(value => value === reason);
}

export function interruptedArchitectureReviewSeed(previous: StoredArchitectureRecord | null | undefined, definition: Definition, context: RevisionContext, revisionSeed: RevisionSeed | null | undefined): RevisionSeed | null {
  if (!previous) return null;
  const diagnostic = previous?.diagnostic;
  if (!["failed", "cancelled"].includes(previous?.status) || diagnostic?.stage !== "architecture"
    || diagnostic.role !== "reviewer" || diagnostic.phase !== "evaluating" || !architectureInterruptionReason(diagnostic.reason)
    || previous.review !== null || !previous.runtimeCapabilities || previous.reviewEvidence?.version !== 2
    || !previous.reviewEvidence.snapshot || !Array.isArray(previous.attempts) || !Array.isArray(previous.issues)
    || previous.attempts.some((attempt) => attempt?.review && attempt.candidateHash === previous.candidateHash)) return null;
  const materials = architectureMaterialSeed(previous, definition, context);
  if (!materials) return null;
  try {
    const checks = checkDesign(materials.design, { draft: definition.draft, requirements: context.requirements,
      capabilities: platformCapabilityCatalog(context.platformContext.platformSnapshot, { runtimeCapabilities: context.runtimeCapabilities }),
      evidence: materials.evidence, ...context.platformContext, deferredVerifications: context.deferred.context,
      requireAcceptanceVerification: Boolean(definition.draft.taskSpec) });
    if (checks.issues.some((issue) => issue.blocking) || previous.issues?.some((issue) => issue.blocking)) return null;
    const { evidenceContext, ...seed } = materials;
    const mainReviewCheckpoint = readMainReviewCheckpoint(previous);
    const reviewProgressCheckpoint = readReviewProgressCheckpoint(previous) ?? readLegacyReviewProgressCheckpoint(previous);
    const fidelityProgress = readArchitectureFidelityProgress(previous);
    return { ...seed, issues: checks.issues, reviewPending: true,
      ...(mainReviewCheckpoint ? { mainReviewCheckpoint } : {}),
      ...(reviewProgressCheckpoint ? { reviewProgressCheckpoint } : {}),
      ...(Object.hasOwn(previous, "requirementFidelityProgress") ? { requirementFidelityProgress: fidelityProgress ?? null } : {}),
      ...(revisionSeed?.previousReview ? { previousReview: revisionSeed.previousReview } : {}),
      source: { ...seed.source, kind: "review-continuation", interruptedVersion: previous.version } };
  } catch { return null; }
}

export function feedbackRepairError(message: string) {
  return Object.assign(new InputError(`历史反馈修订来源无效：${message}`), {
    validationIssue: { path: "revisionSource.feedbackRepair", reason: "feedback_repair_source_invalid" },
  });
}

export function reviewRevisionContinuationSeed(previous: StoredArchitectureRecord | null | undefined, definition: Definition, context: RevisionContext, original: RevisionSeed | null | undefined, checkpointInput: unknown): RevisionSeed | null {
  const checkpoint = objectFields(checkpointInput);
  if (!checkpoint.result) return original ?? null;
  if (!previous || !original) throw feedbackRepairError("缺少修订候选的原始绑定来源。");
  if (previous.design === null) {
    if (Object.hasOwn(previous, "reviewProgressCheckpoint") || Object.hasOwn(previous, "mainReviewCheckpoint"))
      throw new InputError("修订候选缺失但已存在评审进度，不能重置评审预算。");
    return { ...original, design: checkpoint.result };
  }
  const materials = architectureMaterialSeed(previous, definition, context);
  if (!materials || previous.candidateHash !== checkpoint.resultHash || previous.review !== null)
    throw new InputError("修订候选或评审来源已变化，不能重开评审。");
  const progress = feedbackReviewCheckpoint(previous);
  if (!progress && previous.diagnostic?.role === "reviewer" && (previous.diagnostic.modelCalls ?? 0) > 0)
    throw new InputError("已开始评审但累计预算不可核验，不能重置评审次数。");
  const fidelity = readArchitectureFidelityProgress(previous);
  if (Object.hasOwn(previous, "requirementFidelityProgress") && !fidelity)
    throw new InputError("修订候选的范围复核进度损坏，不能建立替代会话。");
  const { evidenceContext: _evidenceContext, ...seed } = materials;
  return { ...seed, issues: previous.issues, reviewPending: true, previousReview: original.previousReview,
    ...(readMainReviewCheckpoint(previous) ? { mainReviewCheckpoint: readMainReviewCheckpoint(previous) } : {}),
    ...(readReviewProgressCheckpoint(previous) ? { reviewProgressCheckpoint: readReviewProgressCheckpoint(previous) } : {}),
    ...(fidelity ? { requirementFidelityProgress: fidelity } : {}),
    source: { ...seed.source, kind: "review-continuation", interruptedVersion: previous.version } };
}

export function feedbackReviewCheckpoint(record: StoredArchitectureRecord | null | undefined) {
  const main = readMainReviewCheckpoint(record);
  const progress = readReviewProgressCheckpoint(record) ?? readLegacyReviewProgressCheckpoint(record);
  if (Object.hasOwn(objectFields(record), "mainReviewCheckpoint") && !main
    || Object.hasOwn(objectFields(record), "reviewProgressCheckpoint") && !progress)
    throw feedbackRepairError("已保存的评审检查点损坏，不能重置已用预算。");
  return [main, progress].filter((value): value is NonNullable<typeof value> => value !== null).sort((left, right) => right.modelCalls - left.modelCalls)[0] ?? null;
}

export function feedbackRepairSeed(previous: StoredArchitectureRecord | null | undefined, records: StoredArchitectureRecord[], definition: Definition, context: RevisionContext): RevisionSeed | null {
  if (!previous) return null;
  const reference = objectFields(previous?.revisionSource), repair = objectFields(reference.feedbackRepair);
  if (!Object.hasOwn(reference ?? {}, "feedbackRepair") && reference?.candidateTrust !== "feedback-revision-reference") return null;
  if (!["failed", "cancelled"].includes(previous.status) || previous.sourceFingerprint !== definition.fingerprint) return null;
  if (!repair || Object.keys(repair).sort().join(",") !== "bindingHash,candidateHash,modelCalls,version"
    || !isInteger(repair.version) || repair.version < 1 || repair.version >= previous.version
    || (typeof repair.candidateHash !== "string" || !/^[a-f0-9]{64}$/u.test(repair.candidateHash)) || (typeof repair.bindingHash !== "string" || !/^[a-f0-9]{64}$/u.test(repair.bindingHash))
    || !isInteger(repair.modelCalls) || repair.modelCalls < 0 || repair.modelCalls > ARCHITECTURE_STORED_TURN_LIMIT
    || !architectureRevisionBindingsMatch(previous, definition, context, { allowUnsubmitted: true }))
    throw feedbackRepairError("原版本、候选、完整业务绑定或已用次数不一致。");
  const original = [...records].find((record) => record.agentId === definition.id && record.version === repair.version);
  const materials = original && architectureMaterialSeed(original, definition, context);
  const checkpoint = original && feedbackReviewCheckpoint(original);
  if (!materials || !checkpoint || !["failed", "cancelled"].includes(original.status) || original.review !== null
    || original!.candidateHash !== repair.candidateHash
    || checkpoint.bindingHash !== repair.bindingHash || checkpoint.modelCalls !== repair.modelCalls)
    throw feedbackRepairError("唯一原始候选或评审预算检查点已变化，不能改用新预算。");
  const current = previous.design && architectureMaterialSeed(previous, definition, context);
  if (previous.design !== null && !current) throw feedbackRepairError("当前候选材料损坏，不能回退其他候选刷新预算。");
  const currentCheckpoint = current && feedbackReviewCheckpoint(previous);
  if (previous.diagnostic?.role === "reviewer" && (!current || !currentCheckpoint))
    throw feedbackRepairError("本轮已开始评审但缺少完整候选或累计预算，不能退回原次数。");
  if (previous.candidateHash === repair.candidateHash && currentCheckpoint && currentCheckpoint.modelCalls < repair.modelCalls)
    throw feedbackRepairError("当前同候选的评审预算低于原已用次数，不能倒退。");
  const sourceRepair = previous.candidateHash === repair.candidateHash && currentCheckpoint
    ? { version: previous.version, candidateHash: previous.candidateHash, bindingHash: currentCheckpoint.bindingHash, modelCalls: currentCheckpoint.modelCalls }
    : structuredClone(repair);
  const { evidenceContext, ...seed } = current ?? materials;
  const fidelityProgress = currentCheckpoint && readArchitectureFidelityProgress(previous);
  if (currentCheckpoint && Object.hasOwn(previous, "requirementFidelityProgress") && !fidelityProgress)
    throw feedbackRepairError("当前范围复核进度损坏，不能建立替代会话。");
  return { ...seed, issues: [],
    ...(currentCheckpoint ? { reviewPending: true,
      ...(readMainReviewCheckpoint(previous) ? { mainReviewCheckpoint: readMainReviewCheckpoint(previous) } : {}),
      reviewProgressCheckpoint: readReviewProgressCheckpoint(previous) ?? readLegacyReviewProgressCheckpoint(previous),
      ...(Object.hasOwn(previous, "requirementFidelityProgress") ? { requirementFidelityProgress: fidelityProgress } : {}) } : {}),
    ...(previous.developmentRevision ? { developmentRevision: structuredClone(previous.developmentRevision) } : {}),
    source: { ...seed.source, ...Object.fromEntries(["kind", "developmentRunId", "developmentRecordHash", "developmentArchitectureRef"]
      .filter((key) => Object.hasOwn(reference, key)).map((key) => [key, structuredClone(reference[key])])),
      candidateTrust: "feedback-revision-reference", interruptedVersion: previous.version, feedbackRepair: sourceRepair } };
}

export function hasNewPendingFeedback(previous: StoredArchitectureRecord | null | undefined, ledgerInput: unknown) {
  const ledger = feedbackLedger(ledgerInput);
  if (!ledger) return false;
  if (ledger.coverage.status !== "available") return true;
  const oldDevelopment = previous?.developmentRevision ? developmentReviewFeedback(previous.developmentRevision) : null;
  const before = previous?.feedbackLedger ? architectureFeedbackContext(feedbackLedger(previous.feedbackLedger))!.findings
    : [...(feedbackFindings(objectFields(previous?.priorFindings).findings ?? [])), ...(oldDevelopment?.findings ?? [])];
  const fingerprint = (finding: UnknownRecord) => designHash({ findingId: finding.findingId,
    source: finding.source ?? finding.developmentSource ?? null, issue: finding.issue ?? finding.diagnostic ?? null });
  const known = new Set(before.map(fingerprint));
  return (objectFields(objectFields(previous?.feedbackLedger).coverage).status ?? oldDevelopment?.status ?? "available") !== ledger.coverage.status
    || architectureFeedbackContext(ledger)!.findings.some((finding) => !known.has(fingerprint(finding)));
}

export type RevisionContext = { requirements: RequirementItem[]; platformContext: { platformContractVersion: number; platformSnapshot: ReturnType<typeof createPlatformSnapshot>; platformHash: string }; deferred: Awaited<ReturnType<typeof architectureVerificationContext>>; confirmedRequirementContext: Awaited<ReturnType<typeof architectureConfirmedContext>>; runtimeCapabilities: ReturnType<typeof runtimeCapabilityContract>; evidenceHistory: StoredArchitectureRecord[] };
