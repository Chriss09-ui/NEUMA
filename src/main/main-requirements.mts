import { checkedConsultation } from "../requirements/consultation-storage.mjs";
import type { MainRequirement, MainRecord, MainSavedRequirement } from "../contracts/main.mjs";
import type { Providers } from "../requirements/requirement-provider-port.mjs";
import type { Consultation, RequirementHandoff } from "../contracts/requirements.mjs";
export interface MainRequirementAgents {
  getRequirements?(): Promise<{ requirements: MainSavedRequirement[] }>;
  get?(agentId: string): Promise<{ name: string; draft?: unknown } | null>;
  getRequirementConsultation?(agentId: string): Promise<Consultation | null>;
  getRequirementHandoff?(agentId: string): Promise<RequirementHandoff | null>;
  saveRequirements?(agentId: string, input: unknown, options?: { confirmation?: unknown; requestId?: unknown; consultation?: unknown }): Promise<{ requirement?: MainSavedRequirement | null; [key: string]: unknown }>;
}
type TurnOptions = NonNullable<Parameters<typeof processTurn>[2]>;
type AdvanceOptions = Pick<TurnOptions, "signal" | "onProgress" | "requestId" | "platform" | "research"> & { agents?: MainRequirementAgents; evidenceMessages?: Parameters<typeof processTurn>[0]["evidenceMessages"] };
import { createHash } from "node:crypto";
import { CONFIRMATION_QUESTION, InputError, decideNext, emptyDraft, normalizeDraft, processTurn } from "../requirements/core.mjs";
import { claimRequirementHandoff, newConsultation } from "../requirements/consultation.mjs";
import { substantiveRequirementHash } from "../requirements/task-spec.mjs";
import { textLength } from "../runtime/text-length.mjs";
import { REQUIREMENT_HISTORY_MAX_MESSAGES, REQUIREMENT_HISTORY_MAX_CHARACTERS } from "../requirements/requirement-limits.mjs";

const stableId = (conversationId: string, mutationId: string) => `agent_${createHash("sha256").update(`${conversationId}:${mutationId}`).digest("hex").slice(0, 32)}`;
export const isMainConfirmation = (message: unknown) => typeof message === "string" && /^(?:确认需求|确认)[\s。！!，,]*$/.test(message.trim());
const recentMessages = (messages: string[]) => {
  const selected = []; let size = 0;
  for (const message of [...messages].reverse()) {
    const characters = textLength(message);
    if (selected.length === REQUIREMENT_HISTORY_MAX_MESSAGES || size + characters > REQUIREMENT_HISTORY_MAX_CHARACTERS) break;
    selected.unshift(message); size += characters;
  }
  return selected;
};

export function requirementContext(requirement: MainRequirement | null | undefined) {
  if (!requirement) return null;
  const { agentId, mode, draft, status, confirmed, lastQuestion, summary, question, confirmationQuestion, savedRequirement, version } = requirement;
  return { type: "requirements", agentId, mode, draft: structuredClone(draft), name: savedRequirement?.name ?? draft.name?.value ?? "",
    status, confirmed, lastQuestion, summary, question, confirmationQuestion, version, needsBuild: status === "needs_build",
    ...(requirement.consultation ? { consultation: { revision: requirement.consultation.revision,
      issues: structuredClone(requirement.consultation.issues),
      lastAssessment: structuredClone(requirement.consultation.assessments.at(-1) ?? null) } } : {}),
    ...(savedRequirement ? { savedRequirement: structuredClone(savedRequirement), requirement: structuredClone(savedRequirement) } : {}) };
}

export function rememberRequirement(record: Pick<MainRecord, "requirement" | "requirements" | "context">, requirement: MainRequirement) {
  record.requirements ??= [];
  const index = record.requirements.findIndex((value) => value.agentId === requirement.agentId);
  if (index < 0) record.requirements.push(structuredClone(requirement));
  else record.requirements[index] = structuredClone(requirement);
  record.requirement = structuredClone(requirement);
  record.context = requirementContext(requirement);
}

export async function prepareRequirement({ record, conversationId, mutationId, agentId, mode = "continue" }: { record: Pick<MainRecord, "requirement" | "requirements">; conversationId: string; mutationId: string; agentId?: string | undefined; mode?: string }, agents: MainRequirementAgents): Promise<MainRequirement> {
  if (!["new", "continue", "edit"].includes(mode)) throw new InputError("请选择新建、继续或修改需求");
  if (mode === "new" && agentId) throw new InputError("新建需求不能覆盖已有 Agent");
  const existing = agentId ? (record.requirements ?? []).find((value) => value.agentId === agentId) : record.requirement;
  const refresh = mode === "edit" && existing?.confirmed;
  if (mode !== "new" && existing && !refresh) {
    const restored = structuredClone(existing);
    if (mode === "edit") restored.mode = "edit";
    restored.consultation ??= newConsultation();
    const handoff = await agents.getRequirementHandoff?.(restored.agentId);
    return handoff && restored.consultation.handoff?.id !== handoff.id
      ? claimRequirementHandoff(restored, handoff) : restored;
  }
  const targetId = agentId ?? (refresh ? existing.agentId : undefined);
  let draft = emptyDraft(), savedRequirement: MainSavedRequirement | undefined;
  if (targetId) {
    const result = await agents.getRequirements!();
    savedRequirement = result.requirements.find((value) => value.id === targetId);
    if (!savedRequirement) {
      const agent = await agents.get?.(targetId);
      if (!agent?.draft) throw new InputError("没有找到这个 Agent 的需求，请刷新后重试");
      savedRequirement = { id: targetId, name: agent.name, draft: agent.draft };
    }
    draft = normalizeDraft(savedRequirement.draft);
  }
  const decision = decideNext(draft), ready = decision.status === "ready";
  const savedConsultation = targetId ? await agents.getRequirementConsultation?.(targetId) : null;
  const samePriorDraft = existing && substantiveRequirementHash(existing.draft) === substantiveRequirementHash(draft);
  const requirement: MainRequirement = { agentId: targetId ?? stableId(conversationId, mutationId), mode: targetId ? "edit" : "create", draft,
    status: decision.status, confirmed: false, lastQuestion: ready ? CONFIRMATION_QUESTION : decision.question ?? null,
    question: ready ? null : decision.question ?? null, confirmationQuestion: ready ? CONFIRMATION_QUESTION : null, summary: "",
    userMessages: [], consultation: structuredClone(checkedConsultation(savedConsultation ?? (samePriorDraft ? existing.consultation : null) ?? newConsultation())),
    version: refresh ? existing.version + 1 : 1, createdAt: refresh ? existing.createdAt : new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...(savedRequirement ? { savedRequirement: structuredClone(savedRequirement) } : {}) };
  const handoff = targetId && await agents.getRequirementHandoff?.(targetId);
  return handoff ? claimRequirementHandoff(requirement, handoff) : requirement;
}

export async function advanceRequirement(requirement: MainRequirement, message: string, providers: Providers, { signal, onProgress, agents, requestId, evidenceMessages, platform, research }: AdvanceOptions = {}) {
  signal?.throwIfAborted();
  const userMessages = recentMessages([...(requirement.userMessages ?? []), message]);
  const result = await processTurn({ message, draft: requirement.draft, lastQuestion: requirement.lastQuestion, userMessages,
    consultation: requirement.consultation, evidenceMessages }, providers, { signal, onProgress, enforceConsultation: true,
    requestId: requestId ?? `req_${requirement.agentId}_${requirement.version}`, platform, research,
    verificationContext: { agentId: requirement.agentId } });
  signal?.throwIfAborted();
  const next: MainRequirement = { ...structuredClone(requirement), draft: result.draft, status: result.confirmed ? "needs_build" : result.status,
    confirmed: result.confirmed, lastQuestion: result.question ?? result.confirmationQuestion ?? "", question: result.question,
    confirmationQuestion: result.confirmationQuestion, summary: result.summary, userMessages, consultation: result.consultation, version: requirement.version + 1,
    updatedAt: new Date().toISOString() };
  let action, source;
  if (result.confirmed) {
    const saved = await agents!.saveRequirements!(next.agentId, { name: next.draft.name.value || "我的 Agent", draft: next.draft },
      { confirmation: result.confirmation, requestId: result.confirmation!.requestId, consultation: result.consultation });
    if (!saved?.requirement || saved.requirement.id !== next.agentId) throw new InputError("需求未能保存到对应 Agent，请重试；不会创建重复 Agent");
    next.savedRequirement = structuredClone(saved.requirement);
    action = { type: "build_agent", agentId: next.agentId, label: "开始制作智能体", requirement: next.savedRequirement };
    source = { type: requirement.savedRequirement ? "agent_updated" : "agent_created", agentId: next.agentId,
      name: next.savedRequirement!.name, sourceLink: `#agent/${encodeURIComponent(next.agentId)}`, status: "needs_build" };
    try { signal?.throwIfAborted(); }
    catch (error) { if (error && typeof error === "object") Object.assign(error, { mainRequirementSource: source }); throw error; }
  }
  const reply = result.confirmed
    ? "需求已确认并保存。正在打开左侧的这个智能体，开始架构评估与制作。"
    : [result.summary, result.question ?? result.confirmationQuestion].filter(Boolean).join("\n\n");
  return { requirement: next, context: requirementContext(next), reply, action, source };
}
