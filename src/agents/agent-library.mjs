import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { InputError } from "../requirements/core.mjs";
import { AgentStorage, agentId } from "./agent-storage.mjs";
import { textWithinLimit } from "../runtime/text-length.mjs";
import { assertRequirementDraftSize, REQUIREMENT_MESSAGE_MAX_CHARACTERS, REQUIREMENT_NAME_MAX_CHARACTERS, REQUIREMENT_RECORD_MAX_BYTES } from "../requirements/requirement-limits.mjs";

export const CONVERSATION_BYTES = 8 * 1024 * 1024;
export const CONVERSATION_SCHEMA_VERSION = 4;
const LEGACY_CONVERSATION = "legacy-saved";
const recordPath = (id) => `conversations/records/${agentId(id)}.json`;
const conversationTitle = (messages) => Array.from(messages.find((item) => item.role === "user")?.content.replace(/\s+/gu, " ").trim()
  || (messages.some((item) => item.role === "user" && item.attachments?.length) ? "附件分析" : "新对话")).slice(0, 30).join("");
const validDate = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const validMutation = (value) => typeof value === "string" && /^[\w-]{1,120}$/.test(value);

export function normalizeAttachmentRefs(value = []) {
  if (!Array.isArray(value) || value.length > 10) throw new InputError("每条消息最多附加 10 个有效材料引用");
  const ids = new Set();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).length !== 1
      || !Object.hasOwn(item, "id") || typeof item.id !== "string" || !/^[\w-]{1,80}$/.test(item.id) || ids.has(item.id))
      throw new InputError("材料引用必须是唯一且有效的材料 ID");
    ids.add(item.id);
    return { id: item.id };
  });
}

const hasAttachments = (record) => record?.messages?.some((item) => item.attachments?.length > 0);
const compatibilitySnapshot = (record) => ({ schemaVersion: hasAttachments(record) ? CONVERSATION_SCHEMA_VERSION : 2,
  messages: record.messages });

function rejectLegacyAttachmentOverwrite(input, previous) {
  if (input.schemaVersion < CONVERSATION_SCHEMA_VERSION && hasAttachments(previous)) {
    const error = new InputError("旧版对话格式不能覆盖包含附件的记录，请刷新后重试");
    error.reason = "conversation_schema_upgrade_required";
    throw error;
  }
}

function conversationFailure(reason) {
  const error = new InputError(reason === "conversation_deleted" ? "这份对话已删除，不能再次保存" : "这份对话已在其他窗口更新，当前修改请另存为新对话");
  error.reason = reason;
  return error;
}

function conversationSize(value) {
  if (Buffer.byteLength(JSON.stringify(value, null, 2), "utf8") > CONVERSATION_BYTES)
    throw new InputError("这份对话超过 8 MiB 保存上限，请开启新对话；当前内容仍需保留");
}

function requirement(id, value) {
  agentId(id);
  if (!value || typeof value.name !== "string" || !value.name.trim() || !textWithinLimit(value.name, REQUIREMENT_NAME_MAX_CHARACTERS)
    || !value.draft || typeof value.draft !== "object" || Array.isArray(value.draft)
    || typeof value.draft.goal?.value !== "string" || !value.draft.goal.value.trim()
    || (value.importOnly !== undefined && typeof value.importOnly !== "boolean"))
    throw new InputError("请提供有效的 Agent 名称与需求");
  try { assertRequirementDraftSize(value.draft); }
  catch (error) { throw Object.assign(new InputError(error.reason ? error.message : "需求格式无效"),
    error.reason ? { reason: error.reason, bytes: error.bytes, limitBytes: error.limitBytes } : {}); }
  if (value.updatedAt !== undefined && !Number.isFinite(Date.parse(value.updatedAt))) throw new InputError("需求保存时间无效");
  return { id, name: value.name.trim(), draft: structuredClone(value.draft), updatedAt: value.updatedAt ?? new Date().toISOString() };
}

function conversation(value, legacy = true) {
  if (!(legacy ? value?.schemaVersion === 2 : [3, CONVERSATION_SCHEMA_VERSION].includes(value?.schemaVersion))
    || !Array.isArray(value.messages) || (legacy && value.messages.length > 80)
    || (value.importOnly !== undefined && typeof value.importOnly !== "boolean")) throw new InputError("保存对话格式无效");
  const messages = value.messages.map((item) => {
    const attachments = normalizeAttachmentRefs(item?.attachments);
    if (!item || !["user", "assistant"].includes(item.role) || typeof item.content !== "string"
      || (item.role === "user" ? !textWithinLimit(item.content, REQUIREMENT_MESSAGE_MAX_CHARACTERS) : legacy && !textWithinLimit(item.content, 32000))
      || (item.role === "user" && !item.content.trim() && !attachments.length)
      || (attachments.length && (item.role !== "user" || value.schemaVersion !== CONVERSATION_SCHEMA_VERSION)))
      throw new InputError("保存对话内容无效");
    const result = { role: item.role, content: item.content };
    if (attachments.length) result.attachments = attachments;
    if (typeof item.revision === "string" && item.revision.length <= 120) result.revision = item.revision;
    if (item.role === "user" && ["sent", "failed", "stopped", "pending"].includes(item.delivery))
      result.delivery = item.delivery === "pending" ? "stopped" : item.delivery;
    if (item.role === "assistant") {
      result.status = ["complete", "error", "stopped"].includes(item.status) ? item.status : "stopped";
      if (typeof item.error === "string") result.error = item.error.slice(0, 2000);
    }
    return result;
  });
  return { schemaVersion: legacy ? 2 : CONVERSATION_SCHEMA_VERSION, messages };
}

export function validateConversationRecord(agent, id, value) {
  agentId(agent); agentId(id);
  if (!value || ![3, CONVERSATION_SCHEMA_VERSION].includes(value.schemaVersion) || value.id !== id || value.agentId !== agent)
    throw new InputError("对话身份与文件夹不一致");
  if (value.deletedAt !== undefined) {
    if (!validDate(value.deletedAt) || Object.keys(value).some((key) => !["schemaVersion", "id", "agentId", "deletedAt"].includes(key)))
      throw new InputError("对话删除标记格式无效");
    return structuredClone(value);
  }
  const messages = conversation(value, false).messages;
  const title = conversationTitle(messages);
  const oldAttachmentTitle = value.schemaVersion === CONVERSATION_SCHEMA_VERSION && value.title === "新对话" && title === "附件分析";
  if (!validDate(value.createdAt) || !validDate(value.updatedAt) || !Number.isSafeInteger(value.saveVersion) || value.saveVersion < 1
    || !validMutation(value.mutationId) || (value.title !== title && !oldAttachmentTitle)) throw new InputError("保存对话元数据无效");
  const result = { schemaVersion: value.schemaVersion, id, agentId: agent, title, createdAt: value.createdAt,
    updatedAt: value.updatedAt, saveVersion: value.saveVersion, mutationId: value.mutationId, messages };
  conversationSize(value);
  return result;
}

export class AgentLibrary {
  constructor({ dataDir, storage = new AgentStorage({ dataDir }), validateAttachments }) {
    if (validateAttachments !== undefined && typeof validateAttachments !== "function") throw new InputError("材料引用校验器无效");
    this.storage = storage;
    this.validateAttachments = validateAttachments;
    this.pending = new Map();
  }

  queue(id, action) {
    agentId(id);
    const result = (this.pending.get(id) ?? Promise.resolve()).then(action);
    const settled = result.catch(() => {});
    this.pending.set(id, settled);
    void settled.then(() => { if (this.pending.get(id) === settled) this.pending.delete(id); });
    return result;
  }

  async deleted(id) { return Boolean(await this.storage.readJson(id, "deleted.json")); }

  async list() {
    const requirements = [];
    for (const id of await this.storage.agentIds()) {
      await this.pending.get(id);
      if (await this.deleted(id)) continue;
      const source = await this.storage.readJson(id, "requirements.json");
      if (!source) continue;
      if (source.id !== id) throw new InputError("Agent 需求身份与文件夹不一致");
      const value = requirement(id, source);
      const definition = await this.storage.readJson(id, "definition.json");
      if (definition?.agent?.profile) value.profile = structuredClone(definition.agent.profile);
      requirements.push(value);
    }
    return { requirements: requirements.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)) };
  }

  saveRequirement(id, input, metadata = {}) {
    const value = requirement(id, input);
    return this.queue(id, async () => {
      if (await this.deleted(id)) {
        if (input.importOnly) return { requirement: null, deleted: true };
        throw new InputError("这个 Agent 已删除，请创建新的 Agent");
      }
      const previous = await this.storage.readJson(id, "requirements.json");
      if (metadata.confirmationReceipt?.requestId && previous?.confirmationReceipt?.requestId === metadata.confirmationReceipt.requestId) {
        if (!isDeepStrictEqual(previous.draft, value.draft) || previous.name !== value.name) throw new InputError("这次确认已用于其他需求内容，请刷新后重试");
        return { requirement: requirement(id, previous) };
      }
      if (input.importOnly && previous) {
        const browserIsNewer = previous._legacyFallback === "definition" || (previous._legacyFallback === "architecture"
          && Date.parse(value.updatedAt) > Date.parse(previous.updatedAt));
        if (!browserIsNewer) return { requirement: requirement(id, previous) };
      }
      const preserved = previous && isDeepStrictEqual(previous.draft, value.draft) && previous.name === value.name ? previous : {};
      const confirmationReceipt = metadata.confirmationReceipt ?? preserved.confirmationReceipt;
      const consultation = metadata.consultation ?? preserved.consultation;
      const saved = { ...value, ...(confirmationReceipt ? { confirmationReceipt: structuredClone(confirmationReceipt) } : {}),
        ...(consultation ? { consultation: structuredClone(consultation) } : {}) };
      const bytes = Buffer.byteLength(JSON.stringify(saved, null, 2), "utf8");
      if (bytes > REQUIREMENT_RECORD_MAX_BYTES) throw Object.assign(new InputError("需求与协商记录超过 8 MiB 保存上限；原记录保留，请整理历史协商后继续"),
        { reason: "requirement_record_too_large", bytes, limitBytes: REQUIREMENT_RECORD_MAX_BYTES });
      await this.storage.writeJson(id, "requirements.json", saved);
      return { requirement: structuredClone(value) };
    });
  }

  async getConversation(id) {
    const result = await this.getConversationRecord(id, LEGACY_CONVERSATION);
    return { ...result, conversation: result.conversation ? compatibilitySnapshot(result.conversation) : null };
  }

  saveConversation(id, input) {
    const value = conversation(input);
    return this.queue(id, async () => {
      if (await this.deleted(id)) {
        if (input.importOnly) return { conversation: null, deleted: true };
        throw new InputError("这个 Agent 已删除，不能保存对话");
      }
      if (!await this.storage.readJson(id, "requirements.json") && !await this.storage.readJson(id, "definition.json"))
        throw new InputError("请先保存这个 Agent 的需求");
      const previous = await this.migrateLegacyConversation(id);
      if (previous?.deletedAt) {
        if (input.importOnly) return { conversation: null, deleted: true };
        throw conversationFailure("conversation_deleted");
      }
      if (input.importOnly && previous) return { conversation: compatibilitySnapshot(previous) };
      rejectLegacyAttachmentOverwrite(input, previous);
      const next = this.newConversationRecord(id, LEGACY_CONVERSATION, value.messages, previous, randomUUID());
      const oldSource = await this.storage.readJson(id, "conversations/saved.json");
      await this.storage.writeJson(id, "conversations/saved.json", value);
      try { await this.storage.writeJson(id, recordPath(LEGACY_CONVERSATION), next); }
      catch (error) {
        if (oldSource) await this.storage.writeJson(id, "conversations/saved.json", oldSource);
        else await this.storage.removeFile(id, "conversations/saved.json");
        throw error;
      }
      return { conversation: structuredClone(value) };
    });
  }

  newConversationRecord(id, cid, messages, previous, mutationId) {
    const now = new Date().toISOString();
    const value = { schemaVersion: CONVERSATION_SCHEMA_VERSION, id: cid, agentId: id, title: conversationTitle(messages),
      createdAt: previous?.createdAt ?? now, updatedAt: now, saveVersion: (previous?.saveVersion ?? 0) + 1, mutationId, messages };
    conversationSize(value);
    return value;
  }

  async readConversationRecord(id, cid) {
    const value = await this.storage.readJson(id, recordPath(cid), { maxBytes: CONVERSATION_BYTES });
    return value ? validateConversationRecord(id, cid, value) : null;
  }

  async migrateLegacyConversation(id) {
    const existing = await this.readConversationRecord(id, LEGACY_CONVERSATION);
    if (existing) return existing;
    const source = await this.storage.readJson(id, "conversations/saved.json");
    if (!source) return null;
    const record = this.newConversationRecord(id, LEGACY_CONVERSATION, conversation(source).messages, null, "legacy-migration");
    await this.storage.writeJson(id, recordPath(LEGACY_CONVERSATION), record);
    return record;
  }

  listConversations(id) {
    return this.queue(id, async () => {
      if (await this.deleted(id)) return { conversations: [], deleted: true };
      await this.migrateLegacyConversation(id);
      const conversations = [];
      for (const file of await this.storage.jsonFiles(id, "conversations/records")) {
        const value = await this.readConversationRecord(id, file.slice(0, -5));
        if (!value.deletedAt) {
          const { id, title, createdAt, updatedAt, saveVersion } = value;
          conversations.push({ id, title, createdAt, updatedAt, saveVersion });
        }
      }
      return { conversations: conversations.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id)) };
    });
  }

  getConversationRecord(id, cid) {
    agentId(cid);
    return this.queue(id, async () => {
      if (await this.deleted(id)) return { conversation: null, deleted: true };
      const value = cid === LEGACY_CONVERSATION ? await this.migrateLegacyConversation(id) : await this.readConversationRecord(id, cid);
      return value?.deletedAt ? { conversation: null, deleted: true } : { conversation: value };
    });
  }

  saveConversationRecord(id, cid, input) {
    agentId(cid);
    const value = conversation(input, false);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || !validMutation(input.mutationId))
      throw new InputError("对话保存版本或操作标识无效");
    return this.queue(id, async () => {
      if (await this.deleted(id)) {
        if (input.importOnly) return { conversation: null, deleted: true };
        throw conversationFailure("conversation_deleted");
      }
      const previous = cid === LEGACY_CONVERSATION ? await this.migrateLegacyConversation(id) : await this.readConversationRecord(id, cid);
      if (previous?.deletedAt) {
        if (input.importOnly) return { conversation: null, deleted: true };
        throw conversationFailure("conversation_deleted");
      }
      if (input.importOnly && previous) return { conversation: previous };
      rejectLegacyAttachmentOverwrite(input, previous);
      if (previous?.mutationId === input.mutationId) {
        if (JSON.stringify(previous.messages) !== JSON.stringify(value.messages)) throw conversationFailure("conversation_conflict");
        return { conversation: previous };
      }
      if (input.expectedVersion !== (previous?.saveVersion ?? 0)) throw conversationFailure("conversation_conflict");
      if (!await this.storage.readJson(id, "requirements.json") && !await this.storage.readJson(id, "definition.json"))
        throw new InputError("请先保存这个 Agent 的需求");
      const refs = [...new Map(value.messages.flatMap((item) => item.attachments ?? []).map((item) => [item.id, item])).values()];
      if (refs.length && !this.validateAttachments) throw new InputError("材料引用尚未接入归属校验，不能保存附件对话");
      for (let offset = 0; offset < refs.length; offset += 10) await this.validateAttachments(id, refs.slice(offset, offset + 10));
      const record = this.newConversationRecord(id, cid, value.messages, previous, input.mutationId);
      await this.storage.writeJson(id, recordPath(cid), record);
      return { conversation: structuredClone(record) };
    });
  }

  removeConversation(id, cid) {
    agentId(cid);
    return this.queue(id, async () => {
      if (!await this.deleted(id)) {
        const previous = await this.readConversationRecord(id, cid);
        if (!previous?.deletedAt) await this.storage.writeJson(id, recordPath(cid), { schemaVersion: CONVERSATION_SCHEMA_VERSION, id: cid, agentId: id, deletedAt: new Date().toISOString() });
      }
      return { deleted: true, id: cid };
    });
  }

  remove(id) {
    return this.queue(id, async () => {
      await this.storage.writeJson(id, "deleted.json", { id, deletedAt: new Date().toISOString() });
      await this.storage.removeFile(id, "requirements.json");
      await this.storage.removeFile(id, "conversations/saved.json");
      await this.storage.removeDirectory(id, "conversations/records");
    });
  }
}
