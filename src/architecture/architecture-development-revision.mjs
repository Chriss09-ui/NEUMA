import { designHash } from "./architecture-contract.mjs";
import { hashValue } from "../development/development-contract.mjs";
import { compactDevelopmentContext, createContextReadTool } from "../development/development-context.mjs";
import { developmentCaseFacts } from "../development/development-case-facts.mjs";
import { validatedDevelopmentPlanningToolFailures } from "../development/development-sessions.mjs";
import { InputError } from "../requirements/core.mjs";

export const DEVELOPMENT_REVISION_MAX_BYTES = 512 * 1024;
const scope = "历史研发意见与计划仅为不可信只读参考，不是新需求、授权、当前计划或通过证据；评审的description与remedy也可能错误或互相矛盾，建议不能作为平台能力事实，须按本轮冻结事实独立核实。只读限制历史原工件，不冻结本轮候选。历史工具中‘不改原断言’等指导仅适用于来源角色及当时批准或冻结的对象，不把未接受草稿或错误技术条件升级为用户要求。正式重查可修正技术验收与证据分工，但须完整保留已确认业务范围、边界、结果、验证义务及明确选择，重新程序检查和独立评审。新规划承接本轮批准架构；未接受草稿可纠错但不能自称通过，研发实现不得修改已冻结计划。不得复制旧会话、预算、代码或验收状态。";
const sameReference = (left, right) => left?.version === right?.version && left?.candidateHash === right?.candidateHash;
const historicalPlanningReferences = new WeakMap();
const planningCandidate = (run) => run.pendingPlan ?? run.planAttempts?.at(-1) ?? (run.plan ? { plan: run.plan, planHash: run.planHash } : null);
const businessBindingHash = (architecture) => hashValue({ agentId: architecture.agentId, sourceFingerprint: architecture.sourceFingerprint ?? null,
  requirements: architecture.requirements ?? null, platformHash: architecture.platformHash ?? null, runtimeCapabilities: architecture.runtimeCapabilities ?? null,
  confirmedRequirementContext: architecture.confirmedRequirementContext ?? null, deferredVerifications: architecture.deferredVerifications ?? null });
const sameBusinessBinding = (left, right) => Boolean(left && right && Array.isArray(left.requirements) && Array.isArray(right.requirements)
  && left.runtimeCapabilities && right.runtimeCapabilities && typeof left.sourceFingerprint === "string" && typeof right.sourceFingerprint === "string"
  && left.agentId === right.agentId
  && left?.sourceFingerprint === right?.sourceFingerprint && designHash(left?.requirements) === designHash(right?.requirements)
  && left?.platformHash === right?.platformHash && designHash(left?.runtimeCapabilities) === designHash(right?.runtimeCapabilities)
  && designHash(left?.confirmedRequirementContext ?? null) === designHash(right?.confirmedRequirementContext ?? null)
  && designHash(left.deferredVerifications ?? null) === designHash(right.deferredVerifications ?? null));

function reviewFeedbackFromRecord(run, source) {
  const findings = [], seenReviews = new Set(), seenIssues = new Set();
  const append = (review, reviewIndex, origin) => {
    if (!review || !Array.isArray(review.issues)) return;
    const reviewHash = hashValue(review);
    if (seenReviews.has(reviewHash)) return;
    seenReviews.add(reviewHash);
    for (const [issueIndex, issue] of review.issues.entries()) {
      if (!issue || typeof issue !== "object" || Array.isArray(issue)) continue;
      const issueHash = hashValue(issue);
      if (seenIssues.has(issueHash)) continue;
      seenIssues.add(issueHash);
      const issueSource = { ...structuredClone(source), origin, reviewIndex, issueIndex };
      findings.push({ findingId: `finding_${hashValue({ kind: "development-review-opinion", source: issueSource, issue }).slice(0, 32)}`,
        source: issueSource, review: { hash: reviewHash, ...Object.fromEntries(["mode", "planHash", "codeHash", "verdict", "summary"]
          .filter((key) => Object.hasOwn(review, key) && review[key] !== undefined).map((key) => [key, structuredClone(review[key])])) },
        issue: structuredClone(issue), suggestedRemedy: issue.remedy ?? null });
    }
  };
  for (const [index, review] of (run.reviews ?? []).entries()) append(review, index, "reviews");
  append(run.feedback?.review, null, "feedback.review");
  return { schemaVersion: 1, trust: "untrusted-reference", current: false, status: "available", scope,
    total: findings.length, retained: findings.length, omitted: 0, findings };
}

const incompleteReviewFeedback = (value, reason) => ({ schemaVersion: 1, trust: "untrusted-reference", current: false,
  status: "incomplete", scope, reason, total: value?.total ?? null, retained: 0, omitted: value?.total ?? null, findings: [] });

/** Historical opinions are obligations to recheck, never assertions of platform capability. */
export function developmentReviewFeedback(reference) {
  const groups = [], add = (value, historical = false) => {
    if (!value) return;
    if (value.reviewFeedback) groups.push(value.reviewFeedback);
    else {
      const projected = reviewFeedbackFromRecord(value, value.source);
      if (historical || value.status === "unavailable" || (value.omitted?.reviews ?? 0) > 0) {
        projected.status = "incomplete";
        projected.reason = "historical_review_coverage_unknown";
        projected.total = null;
        projected.omitted = null;
      }
      projected.coverage = "retained-records-only";
      groups.push(projected);
    }
  };
  add(reference);
  add(reference?.historicalPlanningReference, true);
  const findings = [...new Map(groups.flatMap((group) => group.findings ?? []).map((finding) => [finding.findingId, finding])).values()];
  const complete = groups.every((group) => group.status === "available" && group.omitted === 0);
  const knownTotal = groups.every((group) => Number.isSafeInteger(group.total));
  return { schemaVersion: 1, trust: "untrusted-reference", current: false, scope,
    status: complete ? "available" : "incomplete", total: knownTotal ? groups.reduce((sum, group) => sum + group.total, 0) : null,
    retained: findings.length, omitted: knownTotal ? groups.reduce((sum, group) => sum + (group.omitted ?? 0), 0) : null,
    ...(complete ? {} : { reason: "review_feedback_incomplete" }), findings: structuredClone(findings) };
}

/** Select only the latest run of this exact architecture, never an arbitrary older failure. */
export function latestDevelopmentFailure(records, architecture, activeDefinition) {
  if (architecture?.status !== "passed" || architecture.delivery === "ready" || architecture.developmentRef
    || sameReference(activeDefinition?.architectureRef, { version: architecture.version, candidateHash: architecture.candidateHash })) return null;
  const run = records.filter((item) => item.agentId === architecture.agentId
    && sameReference(item.architectureRef, { version: architecture.version, candidateHash: architecture.candidateHash }))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  return run && ["failed", "blocked"].includes(run.status) && run.delivery === "blocked"
    && Array.isArray(run.deliveries) && run.deliveries.length === 0 ? structuredClone(run) : null;
}

function explicitDevelopmentRevisionSource(architecture) {
  const reference = architecture?.developmentRevision, source = reference?.source, binding = architecture?.revisionSource;
  if (reference?.schemaVersion !== 1
    || reference.trust !== "untrusted-reference" || binding?.kind !== "development-failure"
    || source?.agentId !== architecture.agentId || typeof source.runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(source.runId)
    || typeof source.recordHash !== "string" || !/^[a-f0-9]{64}$/.test(source.recordHash)
    || !Number.isSafeInteger(source.architectureRef?.version) || source.architectureRef.version < 1 || source.architectureRef.version >= architecture.version
    || typeof source.architectureRef.candidateHash !== "string" || !/^[a-f0-9]{64}$/.test(source.architectureRef.candidateHash)
    || binding.developmentRunId !== source.runId || binding.developmentRecordHash !== source.recordHash
    || !sameReference(binding.developmentArchitectureRef, source.architectureRef)) return null;
  return structuredClone(source);
}

export function savedDevelopmentRevisionSource(architecture) {
  if (!["failed", "cancelled", "needs_changes"].includes(architecture?.status) || architecture.delivery === "ready" || architecture.developmentRef) return null;
  return explicitDevelopmentRevisionSource(architecture);
}

/** Follow one explicit passed-architecture source only; never search older runs or inherit accepted state. */
export async function readHistoricalPlanningReference({ architecture, developmentFailure: run, readRun, readArchitecture, signal }) {
  signal?.throwIfAborted();
  if (!run || planningCandidate(run) || !architecture?.developmentRevision) return undefined;
  const base = { schemaVersion: 1, trust: "untrusted-reference", current: false, scope };
  const finish = (value) => {
    historicalPlanningReferences.set(value, { runId: run.id, recordHash: hashValue(run),
      architectureRef: { version: architecture.version, candidateHash: architecture.candidateHash },
      businessBindingHash: businessBindingHash(architecture), referenceHash: hashValue(value) });
    return value;
  };
  const unavailable = (reason) => finish({ ...base, status: "unavailable", reason });
  if (architecture.status !== "passed" || !architecture.design || architecture.review?.verdict !== "pass"
    || architecture.candidateHash !== designHash(architecture.design) || !latestDevelopmentFailure([run], architecture)
    || !sameReference(run.architecture, architecture) || !sameBusinessBinding(run.architecture, architecture)
    || !run.architecture.design || designHash(run.architecture.design) !== architecture.candidateHash
    || designHash(run.architecture.review ?? null) !== designHash(architecture.review)) return unavailable("historical_parent_binding_mismatch");
  const source = explicitDevelopmentRevisionSource(architecture);
  if (!source || source.runId === run.id) return unavailable("historical_source_binding_invalid");
  if (typeof readRun !== "function" || typeof readArchitecture !== "function") return unavailable("historical_source_reader_unavailable");
  let originalRun, originalArchitecture;
  try {
    [originalRun, originalArchitecture] = await Promise.all([readRun(source.runId), readArchitecture(source.architectureRef.version)]);
    signal?.throwIfAborted();
  } catch {
    signal?.throwIfAborted();
    return unavailable("historical_source_unavailable");
  }
  if (!originalRun || !originalArchitecture) return unavailable("historical_source_missing");
  if (originalRun.id !== source.runId || originalRun.agentId !== source.agentId || hashValue(originalRun) !== source.recordHash
    || !sameReference(originalRun.architectureRef, source.architectureRef)
    || originalArchitecture.version !== source.architectureRef.version || originalArchitecture.candidateHash !== source.architectureRef.candidateHash
    || originalArchitecture.status !== "passed" || !originalArchitecture.design || originalArchitecture.review?.verdict !== "pass"
    || designHash(originalArchitecture.design) !== source.architectureRef.candidateHash
    || !latestDevelopmentFailure([originalRun], originalArchitecture)
    || !sameReference(originalRun.architecture, originalArchitecture) || !sameBusinessBinding(originalRun.architecture, originalArchitecture)
    || !originalRun.architecture.design || designHash(originalRun.architecture.design) !== originalArchitecture.candidateHash
    || designHash(originalRun.architecture.review ?? null) !== designHash(originalArchitecture.review)
    || !sameBusinessBinding(originalArchitecture, architecture)
    || source.sourceFingerprint !== originalArchitecture.sourceFingerprint || source.requirementHash !== designHash(originalArchitecture.requirements)
    || source.platformHash !== originalArchitecture.platformHash || source.runtimeCapabilityHash !== designHash(originalArchitecture.runtimeCapabilities)
    || source.confirmedContextHash !== designHash(originalArchitecture.confirmedRequirementContext ?? null)
    || source.deferredContextHash !== designHash(originalArchitecture.deferredVerifications ?? null)) return unavailable("historical_source_changed");
  const candidate = planningCandidate(originalRun), declared = architecture.developmentRevision;
  if (!candidate?.plan || typeof candidate.planHash !== "string" || hashValue(candidate.plan) !== candidate.planHash
    || declared.planHash !== candidate.planHash || !declared.plan || hashValue(declared.plan) !== candidate.planHash)
    return unavailable("historical_plan_hash_mismatch");
  const feedback = originalRun.feedback ? Object.fromEntries(["reason", "codeHash", "review", "report"]
    .filter((key) => Object.hasOwn(originalRun.feedback, key)).map((key) => [key, structuredClone(originalRun.feedback[key])])) : null;
  const reviews = (originalRun.reviews ?? []).filter((item) => item.planHash === candidate.planHash);
  const reports = (originalRun.reports ?? []).filter((item) => item.planHash === candidate.planHash);
  const reviewFeedback = reviewFeedbackFromRecord(originalRun, source);
  const reference = { ...base, status: "available", source, viaArchitectureRef: {
    version: architecture.version, candidateHash: architecture.candidateHash }, planHash: candidate.planHash, plan: structuredClone(candidate.plan),
    feedback, reviews: structuredClone(reviews.slice(-4)), reports: structuredClone(reports.slice(-2)), reviewFeedback,
    omitted: { reviews: (originalRun.reviews ?? []).length - Math.min(4, reviews.length), reports: (originalRun.reports ?? []).length - Math.min(2, reports.length) } };
  if (Buffer.byteLength(JSON.stringify(reference)) > DEVELOPMENT_REVISION_MAX_BYTES)
    return finish({ ...base, status: "unavailable", source, reason: "historical_reference_too_large",
      reviewFeedback: incompleteReviewFeedback(reviewFeedback, "historical_reference_too_large") });
  return finish(reference);
}

function projectHistoricalPlanningReference(reference, run, architecture) {
  try {
    const binding = historicalPlanningReferences.get(reference);
    if (binding && binding.runId === run.id && binding.recordHash === hashValue(run)
      && sameReference(binding.architectureRef, architecture) && binding.businessBindingHash === businessBindingHash(architecture)
      && binding.referenceHash === hashValue(reference)) return structuredClone(reference);
  } catch { /* A changed optional reference cannot invalidate the current failure projection. */ }
  return { schemaVersion: 1, trust: "untrusted-reference", current: false,
    status: "unavailable", reason: "historical_reference_unverified", scope };
}

export function developmentFailureFromSavedSource(run, architecture, activeDefinition) {
  const source = savedDevelopmentRevisionSource(architecture);
  if (!source || !run || run.id !== source.runId || run.agentId !== source.agentId
    || !sameReference(run.architectureRef, source.architectureRef) || hashValue(run) !== source.recordHash) return null;
  return latestDevelopmentFailure([run], run.architecture, activeDefinition);
}

export function developmentRevisionReference(run, architecture, { signal, planningToolFailures, historicalPlanningReference } = {}) {
  signal?.throwIfAborted();
  const source = { agentId: run.agentId, runId: run.id, runVersion: run.version, runRevision: run.revision,
    architectureRef: structuredClone(run.architectureRef), recordHash: hashValue(run),
    sourceFingerprint: architecture.sourceFingerprint, requirementHash: designHash(architecture.requirements),
    platformHash: architecture.platformHash, runtimeCapabilityHash: designHash(architecture.runtimeCapabilities),
    confirmedContextHash: designHash(architecture.confirmedRequirementContext ?? null),
    deferredContextHash: designHash(architecture.deferredVerifications ?? null) };
  const base = { schemaVersion: 1, trust: "untrusted-reference", source, scope, maxBytes: DEVELOPMENT_REVISION_MAX_BYTES };
  const unavailable = (reason) => ({ ...base, status: "unavailable", reason,
    reviewFeedback: incompleteReviewFeedback(undefined, reason) });
  const candidate = planningCandidate(run);
  if (candidate && (!candidate.plan || typeof candidate.planHash !== "string" || hashValue(candidate.plan) !== candidate.planHash))
    return unavailable("historical_plan_hash_mismatch");
  const planHash = candidate?.planHash ?? null;
  const related = (items) => (items ?? []).filter((item) => !planHash || item.planHash === planHash);
  const reviews = related(run.reviews), reports = related(run.reports), checks = run.planDraftChecks ?? [];
  const feedback = run.feedback ? Object.fromEntries(["reason", "codeHash", "review", "report"]
    .filter((key) => Object.hasOwn(run.feedback, key)).map((key) => [key, run.feedback[key]])) : null;
  const reviewFeedback = reviewFeedbackFromRecord(run, source);
  const reference = { ...base, status: "available", phase: run.phase, summary: run.summary,
    planHash, plan: candidate?.plan ?? null, feedback, diagnostic: run.diagnostic ?? null,
    reviews: reviews.slice(-4), reports: reports.slice(-2), reviewFeedback, planDraftChecks: checks.slice(-2),
    omitted: { reviews: (run.reviews ?? []).length - Math.min(4, reviews.length), reports: (run.reports ?? []).length - Math.min(2, reports.length),
      planDraftChecks: checks.length - Math.min(2, checks.length) } };
  if (planningToolFailures !== undefined) reference.planningToolFailures = validatedDevelopmentPlanningToolFailures(planningToolFailures, run);
  if (!candidate && historicalPlanningReference !== undefined) {
    reference.historicalPlanningReference = projectHistoricalPlanningReference(historicalPlanningReference, run, architecture);
    if (Buffer.byteLength(JSON.stringify(reference)) > DEVELOPMENT_REVISION_MAX_BYTES) {
      const priorFeedback = reference.historicalPlanningReference.reviewFeedback;
      reference.historicalPlanningReference = { schemaVersion: 1, trust: "untrusted-reference", current: false,
        status: "unavailable", reason: "historical_reference_total_limit", scope,
        reviewFeedback: incompleteReviewFeedback(priorFeedback, "historical_reference_total_limit") };
    }
  }
  if (reference.historicalPlanningReference && Buffer.byteLength(JSON.stringify(reference)) > DEVELOPMENT_REVISION_MAX_BYTES)
    return unavailable("historical_reference_too_large");
  if (Buffer.byteLength(JSON.stringify(reference)) > DEVELOPMENT_REVISION_MAX_BYTES) return unavailable("historical_reference_too_large");
  if (candidate) {
    try { reference.caseFacts = { ...developmentCaseFacts(candidate.plan, { planHash, signal }), source: "historical-reference" }; }
    catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof InputError)) throw error;
      reference.caseFacts = { status: "unavailable", reason: "historical_plan_facts_unavailable", planHash };
    }
  }
  const settleBytes = () => {
    reference.bytes = 0;
    for (;;) {
      const bytes = Buffer.byteLength(JSON.stringify(reference));
      if (reference.bytes === bytes) break;
      reference.bytes = bytes;
    }
  };
  settleBytes();
  if (reference.bytes > DEVELOPMENT_REVISION_MAX_BYTES && reference.historicalPlanningReference) {
    const priorFeedback = reference.historicalPlanningReference.reviewFeedback;
    reference.historicalPlanningReference = { schemaVersion: 1, trust: "untrusted-reference", current: false,
      status: "unavailable", reason: "historical_reference_total_limit", scope,
      reviewFeedback: incompleteReviewFeedback(priorFeedback, "historical_reference_total_limit") };
    settleBytes();
    if (reference.bytes > DEVELOPMENT_REVISION_MAX_BYTES) return unavailable("historical_reference_too_large");
  }
  if (reference.bytes > DEVELOPMENT_REVISION_MAX_BYTES) return unavailable("historical_reference_too_large");
  return structuredClone(reference);
}

export function developmentPlanningFailureSummary(reference) {
  const failures = reference.planningToolFailures;
  const independentIssues = new Map();
  if (failures?.status === "available") for (const failure of failures.failures.toReversed()) for (const issue of failure.issues) {
    const key = JSON.stringify([issue.source?.caseId ?? issue.source?.path ?? issue.path, issue.proposedCaseRef?.acceptanceId ?? null, issue.reason]);
    if (!independentIssues.has(key)) independentIssues.set(key, { entryId: failure.entryId, toolCallId: failure.toolCallId,
      toolName: failure.toolName, ...structuredClone(issue) });
  }
  const issueSummaries = [...independentIssues.values()].slice(0, 8);
  return failures ? { schemaVersion: failures.schemaVersion, trust: failures.trust, current: false,
    status: failures.status, source: structuredClone(failures.source), scope: failures.scope, detailSection: "planningToolFailures",
    ...(failures.status === "available" ? { omittedFailures: failures.omittedFailures, failures: failures.failures.map((failure) => ({
      entryId: failure.entryId, toolCallId: failure.toolCallId, toolName: failure.toolName, path: failure.path, reason: failure.reason,
      saved: false, issueCount: failure.issues.length })),
      total: independentIssues.size, retained: issueSummaries.length, omitted: independentIssues.size - issueSummaries.length, issues: issueSummaries,
      notice: "按用例与验收编号及原因去重，完整保留最多8项独立公开诊断；其余与重复问题按detailSection精确分页读取，不代表已经解决。" }
      : { reason: failures.reason }) } : null;
}

export function developmentRevisionContext(reference) {
  const facts = reference.caseFacts;
  const caseFactsSummary = facts?.schemaVersion === 1 ? { schemaVersion: 1, planHash: facts.planHash, source: "historical-reference",
    totalCases: facts.totalCases, measuredInputs: facts.measuredInputs, unmeasuredInputs: facts.unmeasuredInputs,
    scope: facts.scope, generatedCodeExecuted: false, hostCallsExecuted: false, detailSection: "caseFacts", delivery: "summary",
    notice: "仅为历史计划声明输入与替身参数的测量摘要，不证明业务正确或已覆盖最大合法输入；完整明细用read_architecture_development_reference按section=caseFacts读取。",
    largestInputs: facts.cases.filter((item) => item.input.status === "measured").sort((a, b) => b.input.utf8Bytes - a.input.utf8Bytes).slice(0, 3)
      .map((item) => ({ source: item.source, caseId: item.caseId, caseHash: item.caseHash, utf8Bytes: item.input.utf8Bytes,
        arrayLengths: { ...item.input.arrayLengths, retained: Math.min(4, item.input.arrayLengths.retained),
          truncated: item.input.arrayLengths.truncated || item.input.arrayLengths.retained > 4, entries: item.input.arrayLengths.entries.slice(0, 4) } })) } : facts;
  const planningToolFailuresSummary = developmentPlanningFailureSummary(reference);
  const feedback = developmentReviewFeedback(reference);
  const reviewFeedbackSummary = { ...Object.fromEntries(["schemaVersion", "trust", "current", "status", "total", "retained", "omitted", "reason"]
    .filter((key) => Object.hasOwn(feedback, key)).map((key) => [key, feedback[key]])), scope,
    shown: Math.min(8, feedback.findings.length), remaining: Math.max(0, feedback.findings.length - 8),
    findings: feedback.findings.slice(0, 8).map((finding) => ({ findingId: finding.findingId, source: structuredClone(finding.source),
      review: Object.fromEntries(["verdict", "mode"].filter((key) => Object.hasOwn(finding.review, key) && finding.review[key] !== undefined)
        .map((key) => [key, finding.review[key]])), blocking: finding.issue.blocking ?? null,
      description: typeof finding.issue.description === "string" ? finding.issue.description.slice(0, 400) : null,
      suggestedRemedy: typeof finding.suggestedRemedy === "string" ? finding.suggestedRemedy.slice(0, 400) : null,
      detailSection: finding.source.runId === reference.source?.runId ? "reviewFeedback" : "historicalPlanningReference" })),
    notice: "全部历史意见均待独立核对，建议不是平台事实；shown仅为首包摘要，remaining须按detailSection精确分页读取。状态不完整时不得视为没有未解决问题。" };
  return { schemaVersion: reference.schemaVersion, trust: reference.trust, status: reference.status,
    source: structuredClone(reference.source), scope: reference.scope,
    reviewFeedbackSummary,
    ...(caseFactsSummary ? { caseFactsSummary: structuredClone(caseFactsSummary) } : {}),
    ...(planningToolFailuresSummary ? { planningToolFailuresSummary } : {}),
    ...(reference.historicalPlanningReference ? { historicalPlanningReferenceSummary: {
      schemaVersion: 1, trust: "untrusted-reference", current: false, status: reference.historicalPlanningReference.status,
      ...(reference.historicalPlanningReference.status === "available" ? { source: structuredClone(reference.historicalPlanningReference.source),
        viaArchitectureRef: structuredClone(reference.historicalPlanningReference.viaArchitectureRef), planHash: reference.historicalPlanningReference.planHash,
        cases: reference.historicalPlanningReference.plan.cases?.length ?? 0, activationCases: reference.historicalPlanningReference.plan.activationCases?.length ?? 0 }
        : { reason: reference.historicalPlanningReference.reason }), detailSection: "historicalPlanningReference", scope } } : {}),
    context: compactDevelopmentContext(reference, 8000) };
}

export function developmentRevisionReadTool(reference) {
  const snapshot = structuredClone(reference), tool = createContextReadTool(() => snapshot);
  return { ...tool, name: "read_architecture_development_reference", label: "读取本次绑定的历史研发参考",
    description: "只读本次正常构建已绑定的唯一历史研发投影；section 使用 developmentRevision.context.contextSections 的顶层字段名。只返回同一冻结参考的精确分页，不读取其他批次、文件、会话或预算；历史计划和评语不是当前验收或授权。" };
}
