import type { AgentRequirement, DisplayAgent, RequirementDraft, RequirementSession, Message, AttachmentRef, ConversationRecord, ConversationRequest } from "./ui-types.js";
export type StoragePort = Partial<Pick<Storage, "getItem" | "setItem" | "removeItem">> | null | undefined;
type RequirementInput = { id?: unknown; name?: unknown; draft?: unknown; updatedAt?: unknown; requirementSessionId?: unknown; pendingSync?: unknown; profile?: unknown };
interface RequirementListInput { id: string; persisted?: boolean | undefined; pendingSync?: boolean | undefined; profile?: unknown }
interface NamedDraft { name?: { value?: unknown } }
interface BackupOptions { pendingSync?: boolean | undefined; expectedVersion?: number | undefined; mutationId?: string | undefined; retryRequest?: ConversationRequest | null | undefined }
const STORAGE_KEY = "neuma.requirements.session.optin.v1";
const LEGACY_STORAGE_KEY = "neuma.requirements.session.v1";
const REQUIREMENTS_KEY = "neuma.requirements.saved-list.v1";
const AGENT_PREVIEW_PREFIX = "neuma.agent.preview.v1.";
const AGENT_CONVERSATION_PREFIX = "neuma.agent.conversation.v2.";
const AGENT_HISTORY_PREFIX = "neuma.agent.conversations.v3.";
const ACTIVE_AGENT_CONVERSATION_PREFIX = "neuma.agent.active-conversation.v1.";
const AGENT_HISTORY_MAX_BYTES = 8 * 1024 * 1024;

export function agentDisplayName(agent: DisplayAgent | null | undefined) {
  const name = typeof agent?.profile?.name === "string" && agent.profile.name.trim() ? agent.profile.name : agent?.name;
  return typeof name === "string" && name.trim() ? name.trim() : "未命名 Agent";
}

export function agentDisplayDescription(agent: DisplayAgent | null | undefined) {
  if (typeof agent?.profile?.description === "string") return agent.profile.description;
  return typeof agent?.draft?.goal?.value === "string" ? agent.draft.goal.value : "";
}

export function agentDisplayIcon(agent: DisplayAgent | null | undefined) {
  return typeof agent?.profile?.icon === "string" && agent.profile.icon.trim()
    ? agent.profile.icon.trim() : Array.from(agentDisplayName(agent))[0] || "A";
}

export function blankSession(): RequirementSession {
  return { messages: [], draft: null, status: "idle", confirmed: false, lastQuestion: "", jev: null };
}

export function recentUserMessages(messages: Message[]) {
  const result = [];
  let remaining = 12000;
  for (const item of messages.slice().reverse()) {
    if (item?.role !== "user" || typeof item.content !== "string" || ["pending", "failed", "stopped"].includes(item.delivery!)) continue;
    const content = item.content.trim().slice(0, Math.min(4000, remaining));
    if (content) {
      result.unshift(content);
      remaining -= content.length;
    }
    if (result.length === 12 || remaining === 0) break;
  }
  return result;
}

export function clearLegacySession(storage: StoragePort) {
  if (!storage) return true;
  try {
    storage!.removeItem!(LEGACY_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function hasSavedSession(storage: StoragePort) {
  try {
    return storage!.getItem!(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

function readSession(storage: StoragePort, key: string): RequirementSession {
  try {
    const value: RequirementSession | null = JSON.parse(storage!.getItem!(key) ?? "null");
    if (!value || typeof value !== "object" || !Array.isArray(value.messages)) {
      return blankSession();
    }
    const priorStatus = ["idle", "needs_input", "ready"].includes(value.status) ? value.status : "idle";
    const status = priorStatus === "ready" && (!value.draft?.scenario || !value.draft?.task)
      ? "needs_input" : priorStatus;
    return {
      messages: value.messages.filter((item) => item && ["user", "assistant"].includes(item.role)
        && typeof item.content === "string").slice(-80),
      draft: value.draft && typeof value.draft === "object" ? value.draft : null,
      status,
      confirmed: status === "ready" && value.confirmed === true,
      lastQuestion: typeof value.lastQuestion === "string" ? value.lastQuestion : "",
      jev: value.jev && typeof value.jev === "object" ? value.jev : null,
      ...(typeof value.requirementSessionId === "string" ? { requirementSessionId: value.requirementSessionId,
        requirementVersion: Number.isSafeInteger(value.requirementVersion) ? value.requirementVersion : 0 } : {}),
      ...(value.pendingRequest && typeof value.pendingRequest.id === "string" && typeof value.pendingRequest.message === "string"
        ? { pendingRequest: value.pendingRequest } : {}),
    };
  } catch {
    return blankSession();
  }
}

export function loadSession(storage: StoragePort) {
  return readSession(storage, STORAGE_KEY);
}

export function takeLegacySession(storage: StoragePort) {
  const session = readSession(storage, LEGACY_STORAGE_KEY);
  return { session, cleared: clearLegacySession(storage) };
}

export function initializeSession(storage: StoragePort) {
  const legacy = takeLegacySession(storage);
  return {
    session: blankSession(),
    legacySession: legacy.session,
    legacyCleared: legacy.cleared,
    hasSavedCopy: hasSavedSession(storage),
  };
}

export function startNewConversation(storage: StoragePort) {
  return { session: blankSession(), hasSavedCopy: hasSavedSession(storage) };
}

export function saveSession(storage: StoragePort, session: unknown) {
  try {
    storage!.setItem!(STORAGE_KEY, JSON.stringify(session));
    return true;
  } catch {
    return false;
  }
}

export function clearSession(storage: StoragePort) {
  if (!storage) return true;
  try {
    storage!.removeItem!(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function loadSavedRequirements(storage: StoragePort): AgentRequirement[] {
  try {
    const items: AgentRequirement[] = JSON.parse(storage!.getItem!(REQUIREMENTS_KEY) ?? "[]");
    if (!Array.isArray(items)) return [];
    return items.filter((item) => item && typeof item.id === "string"
      && typeof item.name === "string" && item.draft && typeof item.draft === "object")
      .map((item) => ({ id: item.id, name: item.name, draft: item.draft,
        updatedAt: item.updatedAt, persisted: true, dirty: item.pendingSync === true,
        ...(typeof item.requirementSessionId === "string" ? { requirementSessionId: item.requirementSessionId } : {}),
        ...(item.pendingSync === true ? { pendingSync: true } : {}) }));
  } catch {
    return [];
  }
}

export function normalizeAgentRequirement<T extends RequirementInput & { id: string; name: string; draft: object }>(item: T | null | undefined): { id: string; name: string; draft: T["draft"]; updatedAt: T["updatedAt"]; requirementSessionId?: string; persisted: boolean; dirty: boolean; profile?: T["profile"] | undefined } | null;
export function normalizeAgentRequirement(item: unknown): { id: string; name: string; draft: object; updatedAt: unknown; requirementSessionId?: string; persisted: boolean; dirty: boolean; profile?: unknown } | null;
export function normalizeAgentRequirement(input: unknown) {
  const item = input as RequirementInput | null | undefined;
  if (!item || typeof item.id !== "string" || typeof item.name !== "string" || !item.draft
    || typeof item.draft !== "object" || Array.isArray(item.draft)) return null;
  return { id: item.id, name: item.name, draft: structuredClone(item.draft), updatedAt: item.updatedAt,
    ...(typeof item.requirementSessionId === "string" ? { requirementSessionId: item.requirementSessionId } : {}),
    persisted: true, dirty: false, ...(item.profile ? { profile: structuredClone(item.profile) } : {}) };
}

export function upsertConfirmedRequirement<T extends RequirementListInput, D extends NamedDraft>(items: T[], activeId: string | null, draft: D, newId: string) {
  const previous = items.find((item) => item.id === activeId);
  const id = previous?.id ?? newId;
  const name = typeof draft.name?.value === "string" && draft.name.value.trim()
    ? draft.name.value.trim() : "未命名 Agent";
  const item = { id, name, draft: structuredClone(draft), updatedAt: new Date().toISOString(),
    persisted: previous?.persisted ?? false, dirty: true,
    ...(previous?.pendingSync ? { pendingSync: true } : {}),
    ...(previous?.profile ? { profile: structuredClone(previous.profile) as T["profile"] } : {}) };
  return { items: [item, ...items.filter((entry) => entry.id !== id)], activeId: id };
}

export function saveRequirement<T extends RequirementInput>(storage: StoragePort, item: T | null | undefined) {
  if (!item || typeof item.id !== "string" || typeof item.name !== "string" || !item.draft) {
    return false;
  }
  try {
    const record = requirementBackup(item);
    const others = loadSavedRequirements(storage).filter((entry) => entry.id !== item.id)
      .map(requirementBackup);
    storage!.setItem!(REQUIREMENTS_KEY, JSON.stringify([record, ...others]));
    return true;
  } catch {
    return false;
  }
}

function requirementBackup({ id, name, draft, updatedAt, pendingSync, requirementSessionId }: RequirementInput) {
  return { id, name, draft, updatedAt, ...(pendingSync === true ? { pendingSync: true } : {}),
    ...(typeof requirementSessionId === "string" ? { requirementSessionId } : {}) };
}

export function deleteRequirement(storage: StoragePort, id: string) {
  try {
    const remaining = loadSavedRequirements(storage).filter((item) => item.id !== id)
      .map(requirementBackup);
    if (remaining.length) storage!.setItem!(REQUIREMENTS_KEY, JSON.stringify(remaining));
    else storage!.removeItem!(REQUIREMENTS_KEY);
    return true;
  } catch {
    return false;
  }
}

function previewMessages(messages: unknown): Message[] {
  if (!Array.isArray(messages)) return [];
  return messages.filter((item) => item?.role === "user" && typeof item.content === "string"
    && item.content.trim() && item.content.length <= 4000)
    .slice(-80).map((item) => ({ role: "user", content: item.content }));
}

export function agentAttachmentRefs(value: AttachmentRef[] = []) {
  if (!Array.isArray(value) || value.length > 10 || value.some((ref) => !ref || typeof ref.id !== "string"
    || !/^[A-Za-z0-9_-]{1,120}$/.test(ref.id)) || new Set(value.map((ref) => ref.id)).size !== value.length) {
    throw new Error("附件引用格式无效，每条消息最多添加 10 份材料。");
  }
  return value.map(({ id }) => ({ id }));
}

function conversationMessages(messages: Message[], { complete = false } = {}): Message[] {
  if (!Array.isArray(messages)) return [];
  const valid = (item: Message) => item && ["user", "assistant"].includes(item.role)
    && typeof item.content === "string" && (item.role === "user" ? item.content.length <= 4000 : complete || item.content.length <= 32_000)
    && (item.content.trim() || item.role === "assistant" || (Array.isArray(item.attachments) && item.attachments.length));
  if (complete && messages.some((item) => !valid(item))) throw new Error("对话消息格式无效，完整内容未保存。");
  const selected = complete ? messages : messages.filter(valid).slice(-80);
  return selected.map((item) => {
    const result: Message = { role: item.role, content: item.content };
    if (item.role === "user" && item.attachments !== undefined) {
      const attachments = agentAttachmentRefs(item.attachments);
      if (attachments.length) result.attachments = attachments;
    }
    if (typeof item.revision === "string" && item.revision.length <= 120) result.revision = item.revision;
    if (item.role === "user" && ["sent", "failed", "stopped", "pending"].includes(item.delivery!)) {
      result.delivery = item.delivery === "pending" ? "stopped" : item.delivery;
    }
    if (item.role === "assistant") {
      result.status = ["complete", "error", "stopped"].includes(item.status!) ? item.status : "stopped";
      if (typeof item.error === "string") result.error = item.error.slice(0, 2000);
    }
    return result;
  });
}

export function agentConversationSnapshot(messages: Message[]) {
  return { schemaVersion: 2, messages: conversationMessages(messages) };
}

export function agentHistorySnapshot(messages: Message[]) {
  if (!Array.isArray(messages)) throw new Error("对话消息格式无效，完整内容未保存。");
  const snapshot = { schemaVersion: 4, messages: conversationMessages(messages, { complete: true }) };
  if (new TextEncoder().encode(JSON.stringify(snapshot)).length > AGENT_HISTORY_MAX_BYTES) {
    throw new Error("单条对话超过 8 MiB，完整内容未保存；请保留当前内容并开启新对话。");
  }
  return snapshot;
}

function agentConversationBackup(agentId: string, record: Omit<ConversationRecord, "mutationId"> & { mutationId?: string | undefined }, options: BackupOptions = {}): ConversationRecord {
  if (!record || ![2, 3, 4].includes(record.schemaVersion) || typeof record.id !== "string" || !record.id
    || record.agentId !== agentId || typeof record.title !== "string"
    || typeof record.createdAt !== "string" || typeof record.updatedAt !== "string"
    || !Number.isSafeInteger(record.saveVersion) || record.saveVersion < 0) {
    throw new Error("对话备份格式无效。");
  }
  const expectedVersion = options.expectedVersion ?? record.saveVersion;
  const mutationId = options.mutationId ?? record.mutationId;
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0
    || typeof mutationId !== "string" || !mutationId) throw new Error("对话保存版本无效。");
  const value: ConversationRecord = { ...agentHistorySnapshot(record.messages), id: record.id, agentId,
    title: record.title, createdAt: record.createdAt, updatedAt: record.updatedAt,
    saveVersion: record.saveVersion, expectedVersion, mutationId,
    ...(options.pendingSync === true ? { pendingSync: true } : {}) };
  if (record.inputDraft !== undefined) {
    if (typeof record.inputDraft !== "string" || record.inputDraft.length > 4000 || record.inputDraft.includes("\0")) throw new Error("输入草稿格式无效。");
    if (record.inputDraft) value.inputDraft = record.inputDraft;
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > AGENT_HISTORY_MAX_BYTES) {
    throw new Error("单条对话超过 8 MiB，完整内容未保存。");
  }
  const retryRequest = options.retryRequest ?? record.retryRequest;
  if (retryRequest !== undefined) {
    if (![2, 3, 4].includes(retryRequest?.schemaVersion!) || !Number.isSafeInteger(retryRequest!.expectedVersion)
      || retryRequest!.expectedVersion < 0 || typeof retryRequest!.mutationId !== "string" || !retryRequest!.mutationId) {
      throw new Error("待同步对话请求无效。");
    }
    agentHistorySnapshot(retryRequest!.messages);
    if (new TextEncoder().encode(JSON.stringify(retryRequest)).length > AGENT_HISTORY_MAX_BYTES) {
      throw new Error("单条对话超过 8 MiB，待同步请求未保存。");
    }
    value.retryRequest = structuredClone(retryRequest);
  }
  return value;
}

export function loadAgentConversationBackups(storage: StoragePort, agentId: string): ConversationRecord[] {
  try {
    const stored: ConversationRecord[] = JSON.parse(storage!.getItem!(AGENT_HISTORY_PREFIX + agentId) ?? "[]");
    if (!Array.isArray(stored)) return [];
    return stored.flatMap((record) => {
      try { return [agentConversationBackup(agentId, record, record)]; } catch { return []; }
    }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } catch {
    return [];
  }
}

export function saveAgentConversationBackup(storage: StoragePort, agentId: string, record: Omit<ConversationRecord, "mutationId"> & { mutationId?: string | undefined },
  { pendingSync = false, expectedVersion = record?.saveVersion, mutationId = record?.mutationId, retryRequest = record?.retryRequest }: BackupOptions = {}) {
  try {
    const value = agentConversationBackup(agentId, record, { pendingSync, expectedVersion, mutationId, retryRequest });
    const stored: ConversationRecord[] = JSON.parse(storage!.getItem!(AGENT_HISTORY_PREFIX + agentId) ?? "[]");
    if (!Array.isArray(stored)) return false;
    const others = stored.filter((item) => item?.id !== value.id);
    storage!.setItem!(AGENT_HISTORY_PREFIX + agentId, JSON.stringify([value, ...others]));
    return true;
  } catch {
    return false;
  }
}

export function deleteAgentConversationBackup(storage: StoragePort, agentId: string, conversationId: string) {
  try {
    const stored: ConversationRecord[] = JSON.parse(storage!.getItem!(AGENT_HISTORY_PREFIX + agentId) ?? "[]");
    if (!Array.isArray(stored)) return false;
    const remaining = stored.filter((item) => item?.id !== conversationId);
    if (remaining.length) storage!.setItem!(AGENT_HISTORY_PREFIX + agentId, JSON.stringify(remaining));
    else storage!.removeItem!(AGENT_HISTORY_PREFIX + agentId);
    if (loadActiveAgentConversation(storage, agentId) === conversationId) {
      storage!.removeItem!(ACTIVE_AGENT_CONVERSATION_PREFIX + agentId);
    }
    return true;
  } catch {
    return false;
  }
}

export function deleteAgentConversationBackups(storage: StoragePort, agentId: string) {
  try {
    storage!.removeItem!(AGENT_HISTORY_PREFIX + agentId);
    storage!.removeItem!(ACTIVE_AGENT_CONVERSATION_PREFIX + agentId);
    return true;
  } catch {
    return false;
  }
}

export function loadActiveAgentConversation(storage: StoragePort, agentId: string) {
  try {
    const id = storage!.getItem!(ACTIVE_AGENT_CONVERSATION_PREFIX + agentId);
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

export function saveActiveAgentConversation(storage: StoragePort, agentId: string, conversationId: string | null) {
  try {
    if (conversationId === null) storage!.removeItem!(ACTIVE_AGENT_CONVERSATION_PREFIX + agentId);
    else {
      if (typeof conversationId !== "string" || !conversationId) return false;
      storage!.setItem!(ACTIVE_AGENT_CONVERSATION_PREFIX + agentId, conversationId);
    }
    return true;
  } catch {
    return false;
  }
}

export function loadSavedAgentConversation(storage: StoragePort, id: string): { schemaVersion: number; messages: Message[]; pendingSync?: boolean | undefined } | null {
  try {
    const current: { schemaVersion: number; messages: Message[]; pendingSync?: boolean } | null = JSON.parse(storage!.getItem!(AGENT_CONVERSATION_PREFIX + id) ?? "null");
    if (current?.schemaVersion === 2) return { ...agentConversationSnapshot(current.messages),
      ...(current.pendingSync === true ? { pendingSync: true } : {}) };
    const previous = storage!.getItem!(AGENT_PREVIEW_PREFIX + id);
    return previous === null ? null : agentConversationSnapshot(previewMessages(JSON.parse(previous)));
  } catch {
    return null;
  }
}

export function loadAgentPreview(storage: StoragePort, id: string) {
  return loadSavedAgentConversation(storage, id)?.messages ?? [];
}

export function appendAgentPreview(messages: Message[], content: string) {
  if (typeof content !== "string" || !content.trim() || content.length > 4000) {
    throw new Error("任务输入需为 1～4000 字");
  }
  return [...conversationMessages(messages), { role: "user", content: content.trim() }].slice(-80);
}

export function saveAgentPreview(storage: StoragePort, id: string, messages: Message[], { pendingSync = false } = {}) {
  try {
    storage!.setItem!(AGENT_CONVERSATION_PREFIX + id, JSON.stringify({ ...agentConversationSnapshot(messages),
      ...(pendingSync ? { pendingSync: true } : {}) }));
    return true;
  } catch {
    return false;
  }
}

export function deleteAgentPreview(storage: StoragePort, id: string) {
  try {
    storage!.removeItem!(AGENT_PREVIEW_PREFIX + id);
    storage!.removeItem!(AGENT_CONVERSATION_PREFIX + id);
    return true;
  } catch {
    return false;
  }
}
