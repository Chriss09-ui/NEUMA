import type { RequirementItem } from "../contracts/architecture.mjs";
import type { RequirementDraft, Consultation } from "../contracts/requirements.mjs";
import { InputError } from "../requirements/core.mjs";
import { validateTaskEvidence } from "../requirements/task-spec.mjs";
import { textWithinLimit } from "../runtime/text-length.mjs";
import { requirementItems, designHash } from "./architecture-contract.mjs";

export async function architectureVerificationContext(draft: RequirementDraft, consultation: Consultation | undefined, platform: unknown, requirements = requirementItems(draft)) {
  if (!consultation?.assessments?.some((item) => item.deferredIssues?.length)) return { context: null, requirements: [] };
  const { currentDeferredIssues } = await import("../requirements/consultation.mjs");
  let current;
  try { current = currentDeferredIssues(draft, consultation, platform); }
  catch { throw new InputError("后续验证义务未绑定当前已确认需求和平台评估，请先重新评估；不能丢弃义务后构建"); }
  if (!current?.issues?.length) return { context: null, requirements: [] };
  const known = new Set(requirements.map((item) => item.id));
  const taskIds = new Map((draft.taskSpec?.items ?? []).map((item) => [item.id, `spec_${designHash(item.id).slice(0, 24)}`]));
  const expand = (id: string) => known.has(id) ? [id] : taskIds.has(id) ? [taskIds.get(id)!]
    : id === "constraints" ? [...known].filter((item) => item.startsWith("constraint_"))
      : id === "connections" ? [...known].filter((item) => item.startsWith("connection_")) : [];
  const issues = current.issues.map((issue) => {
    const references = issue.requirementIds?.flatMap(expand);
    if (!references?.length || issue.requirementIds.some((id) => !expand(id).length) || references.some((id) => !known.has(id)))
      throw new InputError("后续验证义务没有对应的正式需求编号，必须保留需求关联后再构建");
    const requirementIds = [...new Set(references)];
    const requirementId = `verification_${designHash({ id: issue.id, stage: issue.stage, question: issue.question, requirementIds }).slice(0, 24)}`;
    return { ...structuredClone(issue), requirementId, requirementIds };
  });
  const hash = designHash(issues.map(({ id, stage, question, impact, requirementIds, checks }) => ({ id, stage, question, impact, requirementIds, checks })));
  return { context: { assessmentId: current.assessmentId, requirementHash: current.requirementHash,
    platformHash: current.platformHash, hash, issues }, requirements: issues.map((item) => ({ id: item.requirementId,
    text: `待验证义务（${item.stage} 阶段，尚未执行，完整影响与依据见 deferredVerifications）：${item.question}` })) };
}

export async function architectureConfirmedContext(draft: RequirementDraft, consultation: Consultation | undefined, platform: unknown, requirements = requirementItems(draft)) {
  if (!draft.taskSpec || !consultation) return null;
  const { consultationGate, validateIssueDecisions } = await import("../requirements/consultation.mjs");
  const gate = consultationGate(draft, consultation, platform);
  const assessment = consultation.assessments?.find((item) => item.id === gate.assessmentId);
  if (!gate.allowed || assessment?.systemReviewVersion !== 1) return null;
  const spec = validateTaskEvidence(draft.taskSpec, consultation.evidenceMessages);
  const messages = new Map(consultation.evidenceMessages.map((entry) => [entry.id, entry]));
  const known = new Set(requirements.map((item) => item.id));
  const taskIds = new Map(spec.items.map((item) => [item.id, `spec_${designHash(item.id).slice(0, 24)}`]));
  const expand = (id: string) => known.has(id) ? [id] : taskIds.has(id) ? [taskIds.get(id)!]
    : ["constraints", "connections"].includes(id) ? [...known].filter((item) => item.startsWith(id === "constraints" ? "constraint_" : "connection_")) : [];
  const sourceQuotes = new Map<string, { id: string; messageId: string; role: string; quote: string }>();
  const quoteIds = (references: { messageId: string; quote: string }[]) => references.map((reference) => {
    const value = { messageId: reference.messageId, role: messages.get(reference.messageId)!.role, quote: reference.quote };
    const id = `quote_${designHash(value).slice(0, 24)}`;
    sourceQuotes.set(id, { id, ...value });
    return id;
  });
  const taskSources = spec.items.filter((item) => item.applicability === "applies" && item.source.kind !== "unknown")
    .map((item) => ({ requirementId: taskIds.get(item.id), kind: item.source.kind, quoteIds: quoteIds(item.source.evidence),
      ...(item.source.reason ? { reason: item.source.reason } : {}) }));
  const resolvedChoices = [];
  for (const issue of consultation.issues ?? []) {
    if (issue.owner !== "user" || issue.status !== "resolved" || issue.current !== false || issue.requirementHash !== gate.requirementHash
      || issue.resolution?.status !== "resolved" || !/^[A-Za-z0-9_.:-]{1,120}$/.test(issue.id)
      || !textWithinLimit(issue.question, 1000) || !issue.question.trim()
      || !Array.isArray(issue.requirementIds) || !issue.requirementIds.length || issue.requirementIds.length > 120) continue;
    const resolutionSource = issue.resolution;
    const reviewed = consultation.assessments.find((item) => item.id === resolutionSource.assessmentId);
    if (!reviewed || reviewed.failure || reviewed.systemReviewVersion !== 1 || reviewed.requirementHash !== gate.requirementHash
      || reviewed.platformHash !== gate.platformHash || reviewed.evidenceHash !== issue.resolution.evidenceHash) continue;
    const decision = reviewed.issueDecisions?.find((item) => item.issueId === issue.id && item.status === "resolved");
    if (!decision || (decision.owner ?? issue.owner) !== "user" || decision.stage && decision.stage !== "requirements") continue;
    const requirementIds = [...new Set(issue.requirementIds.flatMap(expand))];
    if (!requirementIds.length || requirementIds.some((id) => !known.has(id)) || issue.requirementIds.some((id) => !expand(id).length)) continue;
    try {
      const options = { issues: [issue], evidenceMessages: consultation.evidenceMessages };
      const [checked] = validateIssueDecisions([decision], options);
      const [resolution] = validateIssueDecisions([issue.resolution], options);
      if (designHash(checked) !== designHash(resolution)) continue;
    }
    catch { continue; }
    const references = decision.evidence.filter((reference) => messages.get(reference.messageId)?.role === "user");
    if (!references.length) continue;
    resolvedChoices.push({ id: issue.id, question: issue.question, requirementIds, reason: decision.reason, quoteIds: quoteIds(references) });
  }
  const context = { assessmentId: gate.assessmentId, requirementHash: gate.requirementHash, platformHash: gate.platformHash,
    taskSources, resolvedChoices, sourceQuotes: [...sourceQuotes.values()] };
  return { ...context, hash: designHash(context) };
}
