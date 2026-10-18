import { contentHash, substantiveRequirementHash, TASK_DIMENSIONS, validateTaskEvidence } from "./task-spec.mjs";

const approvals = new WeakSet();
const ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const HASH = /^[a-f0-9]{64}$/;
const message = (value, max = 3000) => typeof value === "string" && value.trim() && value.length <= max;
const copy = (value) => structuredClone(value);

export function newConsultation() {
  return { version: 1, revision: 0, evidenceMessages: [], assessments: [], issues: [], receipts: [] };
}

export function validatePreflight(value, draft) {
  if (!value || !["sufficient", "needs_input", "blocked"].includes(value.verdict)
    || !message(value.direction) || !message(value.adequacy) || !Array.isArray(value.dimensionChecks)
    || value.dimensionChecks.length !== TASK_DIMENSIONS.length || !Array.isArray(value.issues) || value.issues.length > 24)
    throw new Error("架构预评估结果格式无效");
  const dimensions = new Set(), issueIds = new Set();
  const requirementIds = new Set(["goal", "scenario", "inputSource", "task", "deliverable", "successCriteria", "routingCondition", "constraints", "usage", "externalAction", "interaction", "connections",
    ...(draft.constraints ?? []).map((_item, index) => `constraint_${index + 1}`),
    ...(draft.capabilityDependencies ?? []).map((_item, index) => `capability_${index + 1}`),
    ...(draft.interaction?.operations ?? []).map((_item, index) => `operation_${index + 1}`),
    ...(draft.connections ?? []).map((_item, index) => `connection_${index + 1}`),
    ...(draft.taskSpec?.items ?? []).flatMap((item) => [item.id, `spec_${contentHash(item.id).slice(0, 24)}`])]);
  const references = (values) => Array.isArray(values) && values.length <= 120 && values.every((id) => requirementIds.has(id));
  for (const check of value.dimensionChecks) {
    if (!TASK_DIMENSIONS.includes(check.dimension) || dimensions.has(check.dimension)
      || !["sufficient", "not_applicable", "unknown"].includes(check.status) || !message(check.reason)
      || !references(check.requirementIds) || check.status === "sufficient" && !check.requirementIds.length)
      throw new Error("架构预评估缺少有效的通用维度判断");
    dimensions.add(check.dimension);
  }
  const issues = value.issues.map((issue) => {
    if (!ID.test(issue.id) || issueIds.has(issue.id) || !["user", "system", "runtime"].includes(issue.owner)
      || typeof issue.blocking !== "boolean" || !message(issue.question, 1000) || !message(issue.impact)
      || !references(issue.requirementIds)) throw new Error("架构预评估问题格式无效");
    if (issue.owner === "runtime" && issue.blocking) throw new Error("运行时输入问题不能阻断创建");
    issueIds.add(issue.id);
    return { id: issue.id, owner: issue.owner, blocking: issue.blocking, question: issue.question.trim(), impact: issue.impact.trim(), requirementIds: [...issue.requirementIds] };
  });
  if (value.verdict === "sufficient" && issues.some((issue) => issue.blocking)
    || value.verdict === "needs_input" && !issues.some((issue) => issue.blocking && issue.owner === "user")
    || value.verdict === "blocked" && !issues.some((issue) => issue.blocking && issue.owner === "system"))
    throw new Error("架构预评估结论与待解决问题不一致");
  return { verdict: value.verdict, direction: value.direction.trim(), adequacy: value.adequacy.trim(),
    dimensionChecks: copy(value.dimensionChecks), issues };
}

export function consultationGate(draft, consultation, platform) {
  if (!draft.taskSpec) return { allowed: false, reason: "task_spec_missing", message: "需要补充任务要求评估" };
  try { validateTaskEvidence(draft.taskSpec, consultation?.evidenceMessages); }
  catch (error) { return { allowed: false, reason: "evidence_invalid", message: error.message }; }
  const unresolved = draft.taskSpec.items.find((item) => item.critical && (item.applicability === "unknown" || item.source.kind === "unknown"));
  if (unresolved) return { allowed: false, reason: "critical_requirement_unknown", message: `还需要明确：${unresolved.content || unresolved.dimension}`, requirementId: unresolved.id };
  const requirementHash = substantiveRequirementHash(draft);
  const assessment = consultation?.assessments?.findLast((item) => item.requirementHash === requirementHash
    && (platform === undefined || item.platformHash === contentHash(platform)));
  if (!assessment) return { allowed: false, reason: "assessment_missing", message: "需要先检查当前需求能否交付" };
  if (assessment.failure) return { allowed: false, reason: assessment.failure, message: assessment.message || "需求评估未完成，请重试" };
  try { validatePreflight(assessment, draft); }
  catch { return { allowed: false, reason: "assessment_invalid", message: "需求评估记录无效，需要重新评估" }; }
  if (assessment.verdict !== "sufficient") {
    const issue = assessment.issues.find((item) => item.blocking && item.owner === "user") ?? assessment.issues.find((item) => item.blocking);
    return { allowed: false, reason: issue?.owner === "user" ? "needs_input" : "capability_blocked", message: issue?.question ?? "当前需求存在未解决事项", issue };
  }
  if (consultation?.handoff?.requirementHash === requirementHash && !consultation.handoff.resolved)
    return { allowed: false, reason: "handoff_pending", message: consultation.handoff.issues.find((item) => item.blocking)?.question ?? "需要处理方案评审提出的问题" };
  return { allowed: true, requirementHash, platformHash: assessment.platformHash, assessmentId: assessment.id };
}

export async function evaluateConsultation({ draft, consultation, platform, requestId, preflight, research, signal, onProgress }) {
  const next = copy(consultation ?? newConsultation());
  const requirementHash = substantiveRequirementHash(draft), platformHash = contentHash(platform ?? {});
  if (next.assessments.some((item) => item.requirementHash === requirementHash && item.platformHash === platformHash && !item.failure)
    && consultationGate(draft, next, platform).reason !== "assessment_invalid") return next;
  if (requestId && next.assessments.some((item) => item.requestId === requestId)) return next;
  onProgress?.({ type: "status", phase: "preflight", label: "正在核对实现方式与交付要求…" });
  const id = `pre_${contentHash({ requirementHash, platformHash, requestId, revision: next.revision }).slice(0, 32)}`;
  let assessment;
  try {
    if (typeof preflight !== "function") throw Object.assign(new Error("需求预评估尚未配置，请重试或检查模型设置"), { reason: "preflight_unavailable" });
    const result = validatePreflight(await preflight({ draft: copy(draft), platform: copy(platform ?? {}),
      evidenceMessages: copy(next.evidenceMessages), previousIssues: copy(next.issues), handoff: copy(next.handoff ?? null),
      maxTurns: 6, maxResearch: 2, research, signal }), draft);
    signal?.throwIfAborted();
    assessment = { id, requestId, requirementHash, platformHash, ...result, createdAt: new Date().toISOString() };
    next.issues = result.issues.map((issue) => ({ ...issue, status: "open", requirementHash }));
    if (next.handoff) next.handoff.resolved = !result.issues.some((issue) => issue.blocking);
  } catch (error) {
    signal?.throwIfAborted();
    assessment = { id, requestId, requirementHash, platformHash, failure: error.reason ?? "preflight_failed",
      message: "需求预评估未完成，请重试；已整理的需求保留。", createdAt: new Date().toISOString() };
  }
  next.assessments = [...next.assessments, assessment].slice(-30);
  next.revision++;
  return next;
}

export function issueConfirmation(draft, consultation, { platform, requestId, displayedHash } = {}) {
  const gate = consultationGate(draft, consultation, platform);
  if (!gate.allowed) throw Object.assign(new Error(gate.message), { reason: gate.reason });
  if (displayedHash && displayedHash !== gate.requirementHash) throw Object.assign(new Error("交付范围已改变，请先查看并确认新的需求"), { reason: "confirmation_stale" });
  const approval = Object.freeze({ version: 1, requestId: requestId ?? `confirm_${gate.requirementHash.slice(0, 32)}`,
    ...gate, draftHash: contentHash(draft), confirmedAt: new Date().toISOString() });
  approvals.add(approval);
  return approval;
}

export function authorizeConfirmedRequirement(draft, confirmation) {
  if (!confirmation || !approvals.has(confirmation) || confirmation.draftHash !== contentHash(draft))
    throw Object.assign(new Error("需求需要通过当前服务端评估并确认后保存"), { reason: "confirmation_required" });
  const { allowed, ...receipt } = confirmation;
  return copy(receipt);
}

export function validateRequirementReceipt(draft, receipt) {
  return Boolean(receipt?.version === 1 && ID.test(receipt.requestId) && HASH.test(receipt.platformHash)
    && HASH.test(receipt.draftHash) && receipt.draftHash === contentHash(draft)
    && receipt.requirementHash === substantiveRequirementHash(draft) && ID.test(receipt.assessmentId));
}

export function claimRequirementHandoff(requirement, handoff) {
  if (!handoff || !ID.test(handoff.id) || handoff.requirementHash !== substantiveRequirementHash(requirement.draft)
    || !Number.isInteger(handoff.architectureVersion) || handoff.architectureVersion < 1 || !Array.isArray(handoff.issues)
    || !handoff.issues.length) throw new Error("需求交接已过期或格式无效，请刷新后重试");
  const next = copy(requirement);
  next.consultation ??= newConsultation();
  if (next.consultation.handoff?.id === handoff.id) return next;
  next.consultation.handoff = { ...copy(handoff), resolved: false };
  next.consultation.assessments = [];
  next.confirmed = false; next.status = "needs_input"; next.confirmationQuestion = null;
  next.question = handoff.issues.find((issue) => issue.owner === "user" && issue.blocking)?.question ?? "正在核实方案需要补充的条件。";
  next.lastQuestion = next.question; next.version++;
  return next;
}
