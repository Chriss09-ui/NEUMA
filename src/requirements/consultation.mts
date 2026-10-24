import type { RequirementDraft, Consultation, EvidenceMessage, RequirementIssue, PreflightAssessment, IssueDecision, SystemCheck, RequirementDerivation, DeferredIssue, RequirementHandoff, RequirementReceipt, RequirementState, SavedAssessment } from "../contracts/requirements.mjs";
import type { Providers } from "./requirement-provider-port.mjs";
import type { UnknownRecord } from "../contracts/json.mjs";
import { objectFields, isArray } from "../runtime/type-boundary.mjs";
type Gate = { allowed: true; requirementHash: string; platformHash: string; assessmentId: string; reason?: never; message?: never; issue?: never }
  | { allowed: false; reason: string; message: string; issue?: RequirementIssue | undefined; requirementId?: string; requirementHash?: never; platformHash?: never; assessmentId?: never };
const member = <T extends string>(values: readonly T[] | Set<T>, value: unknown): value is T => typeof value === "string" && (values instanceof Set ? values.has(value as T) : values.includes(value as T));
import { contentHash, substantiveRequirementHash, TASK_DIMENSIONS, mergeEvidence, validateTaskEvidence } from "./task-spec.mjs";
import { textWithinLimit } from "../runtime/text-length.mjs";

import { preflightRejection, safePreflightDiagnostic } from "./preflight-diagnostics.mjs";
import { SYSTEM_REQUIREMENT_CHECKS } from "../agents/requirement-verification.mjs";
import { validateRequirementDerivations } from "./requirement-calculations.mjs";

const systemChecks = new Set(SYSTEM_REQUIREMENT_CHECKS);
const stages = new Set(["requirements", "development", "activation", "runtime"]);
export const PREFLIGHT_DIMENSION_STATUSES = Object.freeze(["sufficient", "not_applicable", "unknown"]);
const verdicts = Object.freeze(["sufficient", "needs_input", "blocked"]);
const owners = Object.freeze(["user", "system", "runtime"]);
const deferredStage = (value: unknown) => member(["development", "activation", "runtime"], value);
const approvals = new WeakMap<object, Readonly<RequirementReceipt & { allowed: true }>>();
const ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const HASH = /^[a-f0-9]{64}$/;
const message = (value: unknown, max = 3000): value is string => textWithinLimit(value, max) && Boolean(value.trim());
const copy = <T,>(value: T): T => structuredClone(value);

export function consultationEvidenceHash(consultation: Consultation | null | undefined) {
  return contentHash((consultation?.evidenceMessages ?? []).filter((entry) => ["user", "measurement"].includes(entry.role)));
}

export function mergeConsultationIssues(previous: RequirementIssue[] = [], handoff?: RequirementHandoff | null): RequirementIssue[] {
  const issues = new Map(previous.map((issue) => [issue.id, copy(issue)]));
  if (handoff && !handoff.resolved) for (const issue of handoff.issues ?? []) {
    const prior = issues.get(issue.id);
    issues.set(issue.id, { ...prior, ...copy(issue), owner: issue.owner ?? "user", blocking: issue.blocking !== false,
      status: prior?.handoffId === handoff.id ? prior.status : "open", current: true, handoffId: handoff.id });
  }
  return [...issues.values()];
}

export function newConsultation(): Consultation {
  return { version: 1, revision: 0, evidenceMessages: [], assessments: [], issues: [], receipts: [] };
}

export function separateSystemUnresolved(draft: RequirementDraft, consultation: Consultation | null | undefined) {
  if (!draft.taskSpec || !draft.unresolved?.length || !consultation || consultation.notes !== undefined && !Array.isArray(consultation.notes)) return null;
  const requirementHash = substantiveRequirementHash(draft);
  const assessment = consultation.assessments?.findLast((item) => item.requirementHash === requirementHash
    && item.systemReviewVersion === 1 && !item.failure);
  if (!assessment || !ID.test(assessment.id ?? "") || !HASH.test(assessment.platformHash ?? "")) return null;
  try {
    validatePreflight(assessment, draft);
    validateDeferredAssessment(assessment, draft, { issues: [...(consultation?.issues ?? []), ...assessment.issues!],
      evidenceMessages: consultation?.evidenceMessages ?? [] });
  } catch { return null; }
  const trusted = (consultation?.issues ?? []).filter((issue) => typeof issue.id === "string" && ID.test(issue.id)
    && issue.owner === "system" && issue.current === true && issue.status === "open" && issue.requirementHash === requirementHash
    && issue.resolution?.assessmentId === assessment.id && issue.resolution.owner === "system" && issue.resolution.status === "open")
    .flatMap((issue) => {
      const original = assessment.issues!.find((item) => item.id === issue.id && item.owner === "system");
      const decision = assessment.issueDecisions?.find((item) => item.issueId === issue.id && item.owner === "system" && item.status === "open");
      if (!original || !decision) return [];
      try { validateIssueDecisions([decision], { issues: [original], evidenceMessages: consultation?.evidenceMessages ?? [],
        verification: assessment.systemChecks ?? [], derivations: assessment.derivations ?? [] }); }
      catch { return []; }
      return [issue];
    }).sort((left, right) => right.id.length - left.id.length);
  const notes = copy(consultation.notes ?? []), unresolved = [];
  let moved = false;
  for (const text of draft.unresolved) {
    const issue = trusted.find((item) => text.startsWith(`${item.id}：`) || text.startsWith(`${item.id}:`));
    if (!issue) { unresolved.push(text); continue; }
    const source = { issueId: issue.id, sourceRequirementHash: requirementHash, assessmentId: assessment.id, text };
    const id = `note_${contentHash(source).slice(0, 32)}`;
    // Keep the complete text as pending review data; its prefix only locates an existing issue.
    if (!notes.some((item) => item.id === id)) notes.push({ id, kind: "system_unresolved", ...source });
    moved = true;
  }
  if (!moved || notes.length > 120) return null;
  return { draft: { ...copy(draft), unresolved }, notes };
}

export function preflightRequirementIds(draft: RequirementDraft) {
  return [...new Set(["goal", "scenario", "inputSource", "task", "deliverable", "successCriteria", "routingCondition", "constraints", "usage", "externalAction", "interaction", "connections",
    ...(draft.constraints ?? []).map((_item, index) => `constraint_${index + 1}`),
    ...(draft.capabilityDependencies ?? []).map((_item, index) => `capability_${index + 1}`),
    ...(draft.interaction?.operations ?? []).map((_item, index) => `operation_${index + 1}`),
    ...(draft.connections ?? []).map((_item, index) => `connection_${index + 1}`),
    ...(draft.taskSpec?.items ?? []).flatMap((item) => [item.id, `spec_${contentHash(item.id).slice(0, 24)}`])])];
}

export function preflightSchema(draft: RequirementDraft) {
  const text = (maxLength = 3000) => ({ type: "string", minLength: 1, maxLength, pattern: "\\S" });
  const blockingIssue = (owner: string) => ({ type: "object", required: ["owner", "blocking"],
    properties: { owner: { const: owner }, blocking: { const: true } } });
  return { type: "object", additionalProperties: false,
    required: ["verdict", "direction", "adequacy", "dimensionChecks", "issues"],
    definitions: {
      requirementIds: { type: "array", maxItems: 120, items: { type: "string", enum: preflightRequirementIds(draft) } },
      dimensionCheck: { type: "object", additionalProperties: false, required: ["dimension", "status", "reason", "requirementIds"], properties: {
        dimension: { type: "string", enum: [...TASK_DIMENSIONS] }, status: { type: "string", enum: [...PREFLIGHT_DIMENSION_STATUSES] },
        reason: text(), requirementIds: { $ref: "#/definitions/requirementIds" },
      }, allOf: [{ if: { properties: { status: { const: "sufficient" } }, required: ["status"] },
        then: { properties: { requirementIds: { type: "array", minItems: 1 } } } }] },
      issue: { type: "object", additionalProperties: false, required: ["id", "owner", "blocking", "question", "impact", "requirementIds"], properties: {
        id: { type: "string", pattern: ID.source }, owner: { type: "string", enum: [...owners] }, blocking: { type: "boolean" },
        question: text(1000), impact: text(), requirementIds: { $ref: "#/definitions/requirementIds" },
        stage: { type: "string", enum: [...stages] }, checks: { type: "array", minItems: 1, maxItems: SYSTEM_REQUIREMENT_CHECKS.length,
          uniqueItems: true, items: { type: "string", enum: [...SYSTEM_REQUIREMENT_CHECKS] } },
      }, allOf: [
        { if: { properties: { owner: { const: "system" } }, required: ["owner"] },
          then: { required: ["stage"], properties: { stage: { type: "string", enum: [...stages] } } } },
        { if: { properties: { owner: { const: "user" } }, required: ["owner"] }, then: { properties: { stage: { type: "string", const: "requirements" } } } },
        { if: { properties: { owner: { const: "runtime" } }, required: ["owner"] }, then: { properties: {
          stage: { type: "string", const: "runtime" }, blocking: { type: "boolean", const: false },
        } } },
        { if: { properties: { stage: { enum: ["development", "activation", "runtime"] } }, required: ["stage"] },
          then: { properties: { blocking: { type: "boolean", const: false } } } },
        { if: { properties: { owner: { enum: ["user", "runtime"] } }, required: ["owner"] },
          then: { not: { properties: { checks: {} }, required: ["checks"] } } },
      ] },
    }, properties: {
      verdict: { type: "string", enum: [...verdicts] }, direction: text(), adequacy: text(),
      dimensionChecks: { type: "array", minItems: TASK_DIMENSIONS.length, maxItems: TASK_DIMENSIONS.length,
        items: { $ref: "#/definitions/dimensionCheck" }, allOf: TASK_DIMENSIONS.map((dimension) => ({
          contains: { type: "object", required: ["dimension"], properties: { dimension: { const: dimension } } },
        })) },
      issues: { type: "array", maxItems: 24, items: { $ref: "#/definitions/issue" } },
    }, allOf: [
      { if: { properties: { verdict: { const: "sufficient" } }, required: ["verdict"] },
        then: { properties: { issues: { type: "array", items: { type: "object", properties: { blocking: { const: false } } } } } } },
      ...["user", "system"].map((owner) => ({ if: { properties: { verdict: { const: owner === "user" ? "needs_input" : "blocked" } }, required: ["verdict"] },
        then: { properties: { issues: { type: "array", contains: blockingIssue(owner) } } } })),
    ] };
}

export function validatePreflight(input: unknown, draft: RequirementDraft, { allowLegacySystemStage = false } = {}): PreflightAssessment {
  const value = objectFields(input);
  if (!value || !member(verdicts, value.verdict)
    || !message(value.direction) || !message(value.adequacy) || !Array.isArray(value.dimensionChecks)
    || value.dimensionChecks.length !== TASK_DIMENSIONS.length || !Array.isArray(value.issues) || value.issues.length > 24)
    throw new Error("架构预评估结果格式无效");
  const dimensions = new Set(), issueIds = new Set();
  const requirementIds = new Set(preflightRequirementIds(draft));
  const references = (values: unknown): values is string[] => isArray(values) && values.length <= 120 && values.every((id) => typeof id === "string" && requirementIds.has(id));
  for (const input of value.dimensionChecks as unknown[]) {
    const check = objectFields(input);
    if (!member(TASK_DIMENSIONS, check.dimension) || dimensions.has(check.dimension)
      || !member(PREFLIGHT_DIMENSION_STATUSES, check.status) || !message(check.reason)
      || !references(check.requirementIds) || check.status === "sufficient" && !check.requirementIds.length)
      throw new Error("架构预评估缺少有效的通用维度判断");
    dimensions.add(check.dimension);
  }
  const issues = (value.issues as unknown[]).map((input): RequirementIssue => {
    const issue = objectFields(input);
    if (typeof issue.id !== "string" || !ID.test(issue.id) || issueIds.has(issue.id) || !member(owners, issue.owner)
      || typeof issue.blocking !== "boolean" || !message(issue.question, 1000) || !message(issue.impact)
      || !references(issue.requirementIds)) throw new Error("架构预评估问题格式无效");
    if (issue.owner === "runtime" && issue.blocking) throw new Error("运行时输入问题不能阻断创建");
    if (issue.owner === "system" && issue.stage === undefined && !allowLegacySystemStage)
      throw new Error("系统问题必须明确当前或后续阶段");
    if (issue.stage !== undefined && (!member(stages, issue.stage) || issue.stage !== "requirements" && issue.blocking
      || issue.owner === "user" && issue.stage !== "requirements" || issue.owner === "runtime" && issue.stage !== "runtime"))
      throw new Error("问题阶段或当前阻断状态不一致");
    if (issue.checks !== undefined && (issue.owner !== "system" || !Array.isArray(issue.checks)
      || !issue.checks.length || issue.checks.length > SYSTEM_REQUIREMENT_CHECKS.length || new Set(issue.checks).size !== issue.checks.length
      || issue.checks.some((reference) => !systemChecks.has(reference)))) throw new Error("系统核实引用必须来自受控检查目录，且只用于系统问题");
    issueIds.add(issue.id);
    return { id: issue.id, owner: issue.owner as RequirementIssue["owner"], blocking: issue.blocking, question: issue.question.trim(), impact: issue.impact.trim(), requirementIds: [...issue.requirementIds],
      ...(issue.checks ? { checks: [...issue.checks as string[]] } : {}), ...(issue.stage ? { stage: issue.stage as NonNullable<RequirementIssue["stage"]> } : {}) };
  });
  if (value.verdict === "sufficient" && issues.some((issue) => issue.blocking)
    || value.verdict === "needs_input" && !issues.some((issue) => issue.blocking && issue.owner === "user")
    || value.verdict === "blocked" && !issues.some((issue) => issue.blocking && issue.owner === "system"))
    throw new Error("架构预评估结论与待解决问题不一致");
  return { verdict: value.verdict as PreflightAssessment["verdict"], direction: value.direction.trim(), adequacy: value.adequacy.trim(),
    dimensionChecks: copy(value.dimensionChecks) as PreflightAssessment["dimensionChecks"], issues };
}

export function consultationGate(draft: RequirementDraft, consultation: Consultation | null | undefined, platform?: unknown): Gate {
  if (!draft.taskSpec) return { allowed: false, reason: "task_spec_missing", message: "需要补充任务要求评估" };
  try { validateTaskEvidence(draft.taskSpec, consultation?.evidenceMessages); }
  catch (error) { return { allowed: false, reason: "evidence_invalid", message: String(objectFields(error).message) }; }
  const unresolved = draft.taskSpec.items.find((item) => item.critical && (item.applicability === "unknown" || item.source.kind === "unknown"));
  const requirementHash = substantiveRequirementHash(draft);
  const assessment = consultation?.assessments?.findLast((item) => item.requirementHash === requirementHash
    && (platform === undefined || item.platformHash === contentHash(platform)));
  if (!assessment) return { allowed: false, reason: "assessment_missing", message: "需要先检查当前需求能否交付" };
  if (assessment.verdict !== "sufficient" && assessment.evidenceHash !== consultationEvidenceHash(consultation))
    return { allowed: false, reason: "assessment_stale", message: "已有新回答或测量结果，需要重新核对需求。" };
  if (assessment.failure) return { allowed: false, reason: assessment.failure, message: assessment.message || "需求评估未完成，请重试" };
  try { validatePreflight(assessment, draft, { allowLegacySystemStage: assessment.systemReviewVersion !== 1 });
    validateDeferredAssessment(assessment, draft, { platform, issues: [...(consultation?.issues ?? []), ...assessment.issues!], evidenceMessages: consultation?.evidenceMessages ?? [] }); }
  catch { return { allowed: false, reason: "assessment_invalid", message: "需求评估记录无效，需要重新评估" }; }
  if (assessment.verdict !== "sufficient") {
    const issue = assessment.issues!.find((item) => item.blocking && item.owner === "user") ?? assessment.issues!.find((item) => item.blocking);
    return { allowed: false, reason: issue?.owner === "user" ? "needs_input" : "capability_blocked", message: issue?.owner === "user" ? issue.question : "系统尚未完成所需能力的核实，暂时不能确认；你的业务需求已保留。", issue };
  }
  if (unresolved) return { allowed: false, reason: "critical_requirement_unknown", message: `还需要明确：${unresolved.content || unresolved.dimension}`, requirementId: unresolved.id };
  if (consultation?.handoff && !consultation.handoff.resolved)
    return { allowed: false, reason: "handoff_pending", message: consultation.handoff.issues.find((item) => item.blocking && item.owner === "user")?.question ?? "系统正在核实方案评审提出的技术条件。" };
  return { allowed: true, requirementHash, platformHash: assessment.platformHash, assessmentId: assessment.id };
}

export function validateIssueDecisions(input: unknown = [], { issues = [], evidenceMessages = [], verification = [], derivations = [], allowPendingVerification = false }: { issues?: RequirementIssue[]; evidenceMessages?: EvidenceMessage[]; verification?: SystemCheck[]; derivations?: RequirementDerivation[]; allowPendingVerification?: boolean } = {}): IssueDecision[] {
  const decisions = input;
  if (!Array.isArray(decisions) || decisions.length > 120) throw new Error("问题解决记录格式无效");
  const known = new Map(issues.map((issue) => [issue.id, issue]));
  const messages = new Map(evidenceMessages.map((entry) => [entry.id, entry]));
  const seen = new Set();
  return (decisions as unknown[]).map((input): IssueDecision => {
    const decision = objectFields(input);
    const previous = known.get(typeof decision.issueId === "string" ? decision.issueId : "");
    if (!previous || seen.has(decision.issueId) || !member(["open", "resolved", "reopened"], decision.status)
      || !message(decision.reason) || !Array.isArray(decision.evidence) || decision.evidence.length > 12)
      throw new Error("问题解决记录缺少对应问题或依据");
    const owner = decision.owner ?? previous.owner;
    const calculated = derivations.filter((item) => item.issueId === decision.issueId);
    if (decision.derivationIds !== undefined && (owner !== "system" || !Array.isArray(decision.derivationIds) || !decision.derivationIds.length
      || decision.derivationIds.length > 2 || new Set(decision.derivationIds).size !== decision.derivationIds.length
      || decision.derivationIds.some((id) => !calculated.some((item) => item.id === id)))
      || owner === "system" && calculated.some((item) => !(isArray(decision.derivationIds) && decision.derivationIds.includes(item.id))))
      throw new Error("计算复核必须引用同问题的有效推导编号");
    if (owner === "system" && decision.stage === undefined) throw new Error("系统决定必须明确当前或后续阶段");
    if (!member(["user", "system", "runtime"], owner) || owner === "runtime" && decision.status !== "open"
      || owner === "system" && decision.status !== "open" && !(decision.status === "resolved" && decision.stage === "requirements"))
      throw new Error("技术事项关闭必须明确当前阶段并有可信核实，运行时事项不能冒充已执行");
    if (owner === "system" && decision.status === "resolved" && previous.owner === "system" && deferredStage(previous.stage))
      throw new Error("后续验收事项不能以平台事实核实关闭");
    if (decision.stage !== undefined && (!member(stages, decision.stage) || owner === "user" && decision.stage !== "requirements"
      || owner === "runtime" && decision.stage !== "runtime")) throw new Error("问题阶段归属无效");
    if (decision.checks !== undefined && (owner !== "system" || !Array.isArray(decision.checks) || !decision.checks.length
      || new Set(decision.checks).size !== decision.checks.length || decision.checks.some((reference) => !systemChecks.has(reference))))
      throw new Error("阶段核实只能引用受控平台检查");
    if (owner === "system" && (deferredStage(decision.stage) || decision.status === "resolved")) {
      if (!decision.checks?.length || !previous.requirementIds?.length) throw new Error("后续验收义务必须绑定需求和平台核实引用");
      const proof = verification.find((check) => check.id === decision.issueId && check.status === "verified");
      if (!allowPendingVerification && (!proof || !proof.evidence.some((entry) => entry.source === "platform")
        || decision.checks.some((reference) => !proof.evidence.some((entry) => entry.reference === reference))))
        throw new Error("尚未核实当前平台可承载，不能把真实能力缺口后移到研发或激活");
    }
    if (owner === "system" && decision.evidence.length) throw new Error("系统事实只能通过checks引用，evidence必须为空数组");
    seen.add(decision.issueId);
    const evidence = (decision.evidence as unknown[]).map((input) => {
      const ref = objectFields(input);
      const entry = messages.get(typeof ref.messageId === "string" ? ref.messageId : "");
      if (!entry || !["user", "measurement"].includes(entry.role) || !message(ref.quote, 4000) || !entry.content.includes(ref.quote))
        throw new Error("问题解决依据无法核对，不能把建议或虚构回答当作决定");
      return { messageId: entry.id, quote: ref.quote };
    });
    if (decision.status !== "open" && owner !== "system" && !evidence.length) throw new Error("关闭或重新打开问题必须保留实际依据");
    if (previous.status === "resolved" && previous.owner === "user" && owner === "user" && decision.status !== "resolved") {
      if (decision.status !== "reopened" || !evidence.some((ref) => !(previous.resolution?.evidenceIds ?? []).includes(ref.messageId)))
        throw new Error("已解决问题只有出现相关新依据才能重新打开");
    }
    return { issueId: previous.id, status: decision.status as IssueDecision["status"], reason: decision.reason.trim(), evidence,
      ...(decision.owner ? { owner: decision.owner as RequirementIssue["owner"] } : {}), ...(decision.stage ? { stage: decision.stage as NonNullable<RequirementIssue["stage"]> } : {}),
      ...(decision.checks ? { checks: [...decision.checks as string[]] } : {}),
      ...(decision.progress ? { progress: copy(decision.progress) as NonNullable<IssueDecision["progress"]> } : {}),
      ...(decision.derivationIds ? { derivationIds: [...decision.derivationIds as string[]] } : {}) };
  });
}

export async function evaluateConsultation({ draft, consultation, platform, requestId, preflight, research, verifySystemIssues, verificationContext, signal, onProgress }: { draft: RequirementDraft; consultation: Consultation | null; platform: unknown; requestId?: string | undefined; preflight?: Providers["preflight"]; research?: Providers["research"]; verifySystemIssues?: Providers["verifySystemIssues"]; verificationContext?: unknown; signal?: AbortSignal | undefined; onProgress?: ((event: UnknownRecord) => void) | undefined }) {
  const next = copy(consultation ?? newConsultation());
  next.issues = mergeConsultationIssues(next.issues, next.handoff);
  const requirementHash = substantiveRequirementHash(draft), platformHash = contentHash(platform ?? {});
  const evidenceHash = consultationEvidenceHash(next);
  if (requestId && next.assessments.some((item) => item.requestId === requestId)) return next;
  const current = next.assessments.findLast((item) => item.requirementHash === requirementHash && item.platformHash === platformHash);
  const currentGate = consultationGate(draft, next, platform);
  if (current && current.systemReviewVersion === 1 && !current.failure && (current.verdict === "sufficient" ? currentGate.allowed : current.evidenceHash === evidenceHash)
    && currentGate.reason !== "assessment_invalid") return next;
  onProgress?.({ type: "status", phase: "preflight", label: "正在核对实现方式与交付要求…" });
  const id = `pre_${contentHash({ requirementHash, platformHash, requestId, revision: next.revision }).slice(0, 32)}`;
  let assessment: SavedAssessment, observedDiagnostic: unknown;
  try {
    if (typeof preflight !== "function") throw Object.assign(new Error("需求预评估尚未配置，请重试或检查模型设置"), { reason: "preflight_unavailable" });
    const response = await preflight({ draft: copy(draft), platform: copy(platform ?? {}),
      evidenceMessages: copy(next.evidenceMessages), previousIssues: copy(next.issues), handoff: copy(next.handoff ?? null),
      priorDerivations: copy(next.assessments.filter((item) => !item.failure).flatMap((item) => item.derivations ?? []).slice(-60)),
      ...(next.notes?.length ? { consultationNotes: copy(next.notes) } : {}),
      ...(verificationContext ? { verificationContext: copy(verificationContext) } : {}),
      maxTurns: 6, maxResearch: 2, research, verifySystemIssues, signal });
    observedDiagnostic = safePreflightDiagnostic(response.preflightDiagnostic);
    const result = validatePreflight(response, draft);
    if (response.reviewedIssues !== undefined && (!Array.isArray(response.reviewedIssues) || response.reviewedIssues.length > 120))
      throw new Error("问题复核记录格式无效");
    const historicalIds = new Set(next.issues.map((issue) => issue.id));
    // Historical questions keep their original references; model copies cannot replace the trusted ledger.
    const reviewedIssues = ((response.reviewedIssues ?? []) as unknown[]).filter((issue) => !historicalIds.has(String(objectFields(issue).id)))
      .flatMap((input) => { const issue = objectFields(input); return validatePreflight({ ...result,
        verdict: issue.blocking ? issue.owner === "user" ? "needs_input" : "blocked" : "sufficient", issues: [issue] }, draft).issues; });
    const knownIssues = [...next.issues];
    for (const issue of [...result.issues, ...reviewedIssues]) if (!knownIssues.some((old) => old.id === issue.id)) knownIssues.push(issue);
    const derivations = response.derivations === undefined ? [] : validateRequirementDerivations(response.derivations, {
      draft, platform, issues: [...knownIssues, ...reviewedIssues], requirementIds: preflightRequirementIds(draft), verification: response.systemChecks ?? [], signal });
    const decisions = validateIssueDecisions(response.issueDecisions, { issues: knownIssues, evidenceMessages: next.evidenceMessages,
      verification: response.systemChecks ?? [], derivations });
    for (const historical of next.issues.filter((issue) => issue.blocking && issue.status !== "resolved" && issue.current !== false)) {
      const current = result.issues.find((issue) => issue.id === historical.id);
      const decision = decisions.find((item) => item.issueId === historical.id);
      const owner = decision?.owner ?? historical.owner;
      const deferred = decision?.status === "open" && (owner === "runtime" || deferredStage(decision.stage))
        && current?.owner === owner && !current.blocking && current.stage === decision.stage;
      if (!current?.blocking && decision?.status !== "resolved" && !deferred)
        throw new Error("未解决的当前阻断问题不能从评估中省略或静默降级");
    }
    for (const issue of knownIssues.filter((item) => item.owner === "system"
      && (result.issues.some((current) => current.id === item.id) || item.status !== "resolved" && item.current !== false))) {
      const decision = decisions.find((item) => item.issueId === issue.id);
      const current = result.issues.find((item) => item.id === issue.id);
      if (!decision || current?.owner === "system" && ((decision.owner ?? issue.owner) !== "system"
        || decision.stage !== current.stage || decision.status === "resolved"))
        throw new Error("系统事项必须逐项独立复核并保留阶段交接");
    }
    for (const decision of decisions) {
      if (decision.status === "resolved" && result.issues.some((issue) => issue.id === decision.issueId && issue.blocking))
        throw new Error("已解决问题不能同时作为阻断问题");
    }
    signal?.throwIfAborted();
    const measurements = (response.systemChecks ?? []).filter((check) => check.status === "verified").flatMap((check) =>
      check.evidence.map((entry) => {
        const fact = { type: "system_verification", id: check.id, status: check.status, message: check.message, evidence: [entry] };
        return { id: `system_${contentHash(fact).slice(0, 32)}`, role: "measurement", content: JSON.stringify(fact) };
      }));
    next.evidenceMessages = mergeEvidence(next.evidenceMessages, measurements);
    const evaluatedEvidenceHash = consultationEvidenceHash(next);
    const deferredIssues = (response.deferredIssues ?? []).map((issue) => ({ ...copy(issue),
      stageDecision: { ...copy(issue.stageDecision), assessmentId: id } }));
    validateDeferredAssessment({ id, ...result, deferredIssues, ...(derivations.length ? { derivations, issueDecisions: decisions, systemChecks: response.systemChecks ?? [] } : {}) },
      draft, { platform, issues: [...knownIssues, ...reviewedIssues], evidenceMessages: next.evidenceMessages });
    assessment = { id, requestId, requirementHash, platformHash, evidenceHash: evaluatedEvidenceHash, ...result, systemReviewVersion: 1,
      ...(observedDiagnostic ? { diagnostic: observedDiagnostic } : {}),
      ...(response.systemProgress?.length ? { systemProgress: copy(response.systemProgress) } : {}),
      ...(deferredIssues.length ? { deferredIssues } : {}),
      ...(derivations.length ? { derivations } : {}),
      ...(decisions.length ? { issueDecisions: decisions } : {}),
      ...(response.systemChecks ? { systemChecks: copy(response.systemChecks) } : {}), createdAt: new Date().toISOString() };
    const ledger = new Map<string, RequirementIssue>(next.issues.map((issue) => [issue.id, { ...issue, current: false }]));
    for (const issue of result.issues) ledger.set(issue.id, { ...ledger.get(issue.id), ...issue, status: "open", current: true, requirementHash });
    for (const decision of decisions) {
      const issue = ledger.get(decision.issueId) ?? knownIssues.find((item) => item.id === decision.issueId)!;
      ledger.set(decision.issueId, { ...issue, owner: decision.owner ?? issue.owner,
        ...(decision.stage ? { stage: decision.stage } : {}), ...(decision.checks ? { checks: copy(decision.checks) } : {}),
        ...(decision.status === "resolved" ? { current: false } : {}),
        blocking: decision.owner === "runtime" || deferredStage(decision.stage) ? false : issue.blocking, status: decision.status === "reopened" ? "open" : decision.status,
        requirementHash, resolution: { ...decision, assessmentId: id, evidenceHash: evaluatedEvidenceHash,
          evidenceIds: next.evidenceMessages.filter((item) => ["user", "measurement"].includes(item.role)).map((item) => item.id) } });
    }
    next.issues = [...ledger.values()].slice(-120);
    if (next.handoff && !next.handoff.resolved) next.handoff.resolved = next.handoff.issues.filter((issue) => issue.blocking !== false)
      .every((issue) => {
        const recorded = ledger.get(issue.id);
        return recorded?.handoffId === next.handoff!.id && (recorded.status === "resolved"
          || (recorded.owner === "runtime" || deferredStage(recorded.stage)) && !recorded.blocking);
      });
  } catch (caught) {
    const error = objectFields(caught);
    signal?.throwIfAborted();
    const diagnostic = safePreflightDiagnostic(error.preflightDiagnostic ?? observedDiagnostic);
    if (diagnostic && !error.preflightDiagnostic) { const rejection = preflightRejection(error, "stage_binding_invalid");
      diagnostic.events.push({ turn: diagnostic.modelTurns, role: "controller", ...rejection, issueIds: [] }); }
    assessment = { id, requestId, requirementHash, platformHash, evidenceHash,
      ...(diagnostic ? { diagnostic } : {}), failure: String(error.reason ?? objectFields(error.diagnostic).reason ?? "preflight_failed"),
      message: "需求预评估未完成，请重试；已整理的需求保留。", createdAt: new Date().toISOString() };
  }
  next.assessments = [...next.assessments, assessment].slice(-30);
  next.revision++;
  return next;
}

function validateDeferredAssessment(assessment: Pick<SavedAssessment, "id" | "issues" | "derivations" | "platformHash" | "issueDecisions" | "systemChecks" | "deferredIssues"> | (PreflightAssessment & { id: string; platformHash?: string; derivations?: RequirementDerivation[]; issueDecisions?: IssueDecision[]; systemChecks?: SystemCheck[]; deferredIssues?: DeferredIssue[] }), draft: RequirementDraft, { platform, issues = assessment.issues ?? [], evidenceMessages = [] }: { platform?: unknown; issues?: RequirementIssue[]; evidenceMessages?: EvidenceMessage[] } = {}) {
  const derivations: RequirementDerivation[] = assessment.derivations === undefined ? [] : validateRequirementDerivations(assessment.derivations,
    { draft, platform, platformHash: assessment.platformHash ?? (platform === undefined ? undefined : contentHash(platform)),
      issues, requirementIds: preflightRequirementIds(draft), verification: assessment.systemChecks ?? [] });
  for (const issueId of new Set(derivations.map((item) => item.issueId))) {
    const decision = assessment.issueDecisions?.find((item) => item.issueId === issueId);
    if (!decision)
      throw new Error("计算推导必须保留独立复核决定");
    validateIssueDecisions([decision], { issues, evidenceMessages, verification: assessment.systemChecks ?? [], derivations });
  }
  const deferred = assessment.deferredIssues ?? [];
  if (!Array.isArray(deferred) || deferred.length > 24) throw new Error("后续验收义务记录格式无效");
  const ids = new Set();
  for (const item of deferred) {
    if (ids.has(item?.id)) throw new Error("后续验收义务重复");
    const issue = validatePreflight({ ...assessment, verdict: "sufficient", issues: [item] }, draft).issues[0]!;
    if (issue.owner !== "system" || !deferredStage(issue.stage) || !issue.requirementIds.length
      || !message(item.stageDecision?.reason) || item.stageDecision.stage !== issue.stage
      || item.stageDecision.assessmentId !== assessment.id || !Array.isArray(item.verification))
      throw new Error("后续验收义务缺少独立阶段判断或版本绑定");
    validateIssueDecisions([{ issueId: issue.id, owner: "system", status: "open", stage: issue.stage,
      checks: item.stageDecision.checks, reason: item.stageDecision.reason, evidence: [],
      ...(item.stageDecision.derivationIds ? { derivationIds: item.stageDecision.derivationIds } : {}) }],
    { issues: [issue], verification: item.verification, derivations });
    if (!assessment.issues!.some((current) => current.id === issue.id && current.stage === issue.stage && !current.blocking))
      throw new Error("后续验收义务与当前评估不一致");
    ids.add(issue.id);
  }
  if (assessment.issues!.some((issue) => issue.owner === "system" && deferredStage(issue.stage) && !ids.has(issue.id)))
    throw new Error("后移技术验收必须保留证据和正式交接义务");
  return deferred;
}

export function currentDeferredIssues(draft: RequirementDraft, consultation: Consultation | null | undefined, platform?: unknown) {
  if (!consultation?.assessments?.some((assessment) => assessment.deferredIssues?.length
    || assessment.issues?.some((issue) => issue.owner === "system" && deferredStage(issue.stage)))) return null;
  const gate = consultationGate(draft, consultation, platform);
  if (!gate.allowed) throw new Error("后续验收义务的需求评估已过期或尚未通过");
  const assessment = consultation.assessments.find((item) => item.id === gate.assessmentId)!;
  const issues = validateDeferredAssessment(assessment, draft, { platform, issues: [...(consultation?.issues ?? []), ...assessment.issues!], evidenceMessages: consultation?.evidenceMessages ?? [] });
  return issues.length ? { assessmentId: assessment.id, requirementHash: assessment.requirementHash,
    platformHash: assessment.platformHash, issues: copy(issues.map((issue) => ({ ...issue,
      ...(issue.stageDecision.derivationIds?.length ? { derivations: assessment.derivations!.filter((item) => issue.stageDecision.derivationIds!.includes(item.id)) } : {}) }))) } : null;
}

export function issueConfirmation(draft: RequirementDraft, consultation: Consultation | null | undefined, { platform, requestId, displayedHash }: { platform?: unknown; requestId?: string | undefined; displayedHash?: string | undefined } = {}): Readonly<RequirementReceipt & { allowed: true }> {
  const gate = consultationGate(draft, consultation, platform);
  if (!gate.allowed) throw Object.assign(new Error(gate.message), { reason: gate.reason });
  if (displayedHash && displayedHash !== gate.requirementHash) throw Object.assign(new Error("交付范围已改变，请先查看并确认新的需求"), { reason: "confirmation_stale" });
  const approval = Object.freeze({ version: 1, requestId: requestId ?? `confirm_${gate.requirementHash.slice(0, 32)}`,
    ...gate, draftHash: contentHash(draft), confirmedAt: new Date().toISOString() });
  approvals.set(approval, approval);
  return approval;
}

export function authorizeConfirmedRequirement(draft: unknown, confirmation: unknown) {
  const approval = confirmation && typeof confirmation === "object" ? approvals.get(confirmation) : undefined;
  if (!approval || approval.draftHash !== contentHash(draft))
    throw Object.assign(new Error("需求需要通过当前服务端评估并确认后保存"), { reason: "confirmation_required" });
  const { allowed, ...receipt } = approval;
  return copy(receipt);
}

export function validateRequirementReceipt(draft: unknown, input: unknown) {
  const receipt = objectFields(input);
  return Boolean(receipt?.version === 1 && typeof receipt.requestId === "string" && ID.test(receipt.requestId) && typeof receipt.platformHash === "string" && HASH.test(receipt.platformHash)
    && typeof receipt.draftHash === "string" && HASH.test(receipt.draftHash) && receipt.draftHash === contentHash(draft)
    && receipt.requirementHash === substantiveRequirementHash(draft) && typeof receipt.assessmentId === "string" && ID.test(receipt.assessmentId));
}

export function claimRequirementHandoff<T extends RequirementState>(requirement: T, handoff: RequirementHandoff) {
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
