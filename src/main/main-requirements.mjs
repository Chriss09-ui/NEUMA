import { createHash } from "node:crypto";
import { CONFIRMATION_QUESTION, InputError, decideNext, emptyDraft, normalizeDraft, processTurn } from "../requirements/core.mjs";

const stableId = (conversationId, mutationId) => `agent_${createHash("sha256").update(`${conversationId}:${mutationId}`).digest("hex").slice(0, 32)}`;
export const isMainConfirmation = (message) => typeof message === "string" && /^(?:确认需求|确认)[\s。！!，,]*$/.test(message.trim());
const recentMessages = (messages) => {
  const selected = []; let size = 0;
  for (const message of [...messages].reverse()) {
    if (selected.length === 12 || size + message.length > 12_000) break;
    selected.unshift(message); size += message.length;
  }
  return selected;
};

export function requirementContext(requirement) {
  if (!requirement) return null;
  const { agentId, mode, draft, status, confirmed, lastQuestion, summary, question, confirmationQuestion, savedRequirement, version } = requirement;
  return { type: "requirements", agentId, mode, draft: structuredClone(draft), name: savedRequirement?.name ?? draft.name?.value ?? "",
    status, confirmed, lastQuestion, summary, question, confirmationQuestion, version, needsBuild: status === "needs_build",
    ...(savedRequirement ? { savedRequirement: structuredClone(savedRequirement), requirement: structuredClone(savedRequirement) } : {}) };
}

export function rememberRequirement(record, requirement) {
  record.requirements ??= [];
  const index = record.requirements.findIndex((value) => value.agentId === requirement.agentId);
  if (index < 0) record.requirements.push(structuredClone(requirement));
  else record.requirements[index] = structuredClone(requirement);
  record.requirement = structuredClone(requirement);
  record.context = requirementContext(requirement);
}

export async function prepareRequirement({ record, conversationId, mutationId, agentId, mode = "continue" }, agents) {
  if (!["new", "continue", "edit"].includes(mode)) throw new InputError("请选择新建、继续或修改需求");
  if (mode === "new" && agentId) throw new InputError("新建需求不能覆盖已有 Agent");
  const existing = agentId ? (record.requirements ?? []).find((value) => value.agentId === agentId) : record.requirement;
  const refresh = mode === "edit" && existing?.confirmed;
  if (mode !== "new" && existing && !refresh) {
    const restored = structuredClone(existing);
    if (mode === "edit") restored.mode = "edit";
    return restored;
  }
  const targetId = agentId ?? (refresh ? existing.agentId : undefined);
  let draft = emptyDraft(), savedRequirement;
  if (targetId) {
    const result = await agents.getRequirements();
    savedRequirement = result.requirements.find((value) => value.id === targetId);
    if (!savedRequirement) {
      const agent = await agents.get?.(targetId);
      if (!agent?.draft) throw new InputError("没有找到这个 Agent 的需求，请刷新后重试");
      savedRequirement = { id: targetId, name: agent.name, draft: agent.draft };
    }
    draft = normalizeDraft(savedRequirement.draft);
  }
  const decision = decideNext(draft), ready = decision.status === "ready";
  return { agentId: targetId ?? stableId(conversationId, mutationId), mode: targetId ? "edit" : "create", draft,
    status: decision.status, confirmed: false, lastQuestion: ready ? CONFIRMATION_QUESTION : decision.question,
    question: ready ? null : decision.question, confirmationQuestion: ready ? CONFIRMATION_QUESTION : null, summary: "",
    userMessages: [], version: refresh ? existing.version + 1 : 1, createdAt: refresh ? existing.createdAt : new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...(savedRequirement ? { savedRequirement: structuredClone(savedRequirement) } : {}) };
}

export async function advanceRequirement(requirement, message, providers, { signal, onProgress, agents } = {}) {
  signal?.throwIfAborted();
  const userMessages = recentMessages([...(requirement.userMessages ?? []), message]);
  const result = await processTurn({ message, draft: requirement.draft, lastQuestion: requirement.lastQuestion, userMessages }, providers, { signal, onProgress });
  signal?.throwIfAborted();
  const next = { ...structuredClone(requirement), draft: result.draft, status: result.confirmed ? "needs_build" : result.status,
    confirmed: result.confirmed, lastQuestion: result.question ?? result.confirmationQuestion ?? "", question: result.question,
    confirmationQuestion: result.confirmationQuestion, summary: result.summary, userMessages, version: requirement.version + 1,
    updatedAt: new Date().toISOString() };
  let action, source;
  if (result.confirmed) {
    const saved = await agents.saveRequirements(next.agentId, { name: next.draft.name.value || "我的 Agent", draft: next.draft });
    if (!saved?.requirement || saved.requirement.id !== next.agentId) throw new InputError("需求未能保存到对应 Agent，请重试；不会创建重复 Agent");
    next.savedRequirement = structuredClone(saved.requirement);
    action = { type: "build_agent", agentId: next.agentId, label: "开始制作智能体", requirement: next.savedRequirement };
    source = { type: requirement.savedRequirement ? "agent_updated" : "agent_created", agentId: next.agentId,
      name: next.savedRequirement.name, sourceLink: `#agent/${encodeURIComponent(next.agentId)}`, status: "needs_build" };
    try { signal?.throwIfAborted(); }
    catch (error) { error.mainRequirementSource = source; throw error; }
  }
  const reply = [result.summary, result.question ?? result.confirmationQuestion,
    result.confirmed ? "需求已确认并保存，接下来需要完成架构评估与制作。" : null].filter(Boolean).join("\n\n");
  return { requirement: next, context: requirementContext(next), reply, action, source };
}
