import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { InputError } from "../requirements/core.mjs";
import { textLength, textWithinLimit } from "../runtime/text-length.mjs";
import { assertRequirementDraftSize, REQUIREMENT_CONVERSATION_MAX_BYTES, REQUIREMENT_HISTORY_MAX_CHARACTERS, REQUIREMENT_HISTORY_MAX_MESSAGES, REQUIREMENT_MESSAGE_MAX_CHARACTERS } from "../requirements/requirement-limits.mjs";

const MAX_BYTES = REQUIREMENT_CONVERSATION_MAX_BYTES;
const STATES = new Set(["running", "complete", "failed", "cancelled", "interrupted"]);

export function mainId(value, label = "对话") {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new InputError(`${label}标识无效`);
  return value;
}

export function mainConversationFailure(reason, message) {
  const error = new InputError(message ?? (reason === "conversation_deleted"
    ? "这份主对话已删除，请新建对话" : "这份主对话已在其他窗口更新，请刷新后重试"));
  error.reason = reason; return error;
}

async function directory(path) {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new InputError("主 Agent 存储目录必须是真实目录");
}

async function bytes(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_BYTES)
    throw new InputError("主 Agent 对话只允许 32 MiB 以内的普通文件");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.nlink !== 1 || current.size > MAX_BYTES) throw new InputError("主 Agent 对话文件类型无效");
    const result = await handle.readFile();
    if (result.length > MAX_BYTES) throw new InputError("主 Agent 对话超过大小限制");
    return result;
  } finally { await handle.close(); }
}

function checked(value) {
  if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.version) || value.version < 1
    || !textWithinLimit(value.title, 200) || !Array.isArray(value.messages) || !Array.isArray(value.requests)
    || !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt))) throw new InputError("主 Agent 对话记录格式无效");
  mainId(value.id);
  if (value.creationMutationId !== undefined) mainId(value.creationMutationId, "创建请求");
  if (value.deletedAt !== undefined) {
    mainId(value.deletionMutationId, "删除请求");
    if (!Number.isFinite(Date.parse(value.deletedAt)) || !Number.isSafeInteger(value.deletionExpectedVersion) || value.deletionExpectedVersion < 1
      || value.version !== value.deletionExpectedVersion + 1 || value.messages.length || value.requests.length
      || Object.keys(value).some((key) => !["schemaVersion", "id", "title", "version", "messages", "requests", "createdAt", "updatedAt",
        "creationMutationId", "deletedAt", "deletionMutationId", "deletionExpectedVersion"].includes(key))) throw new InputError("主对话删除记录格式无效");
  }
  if (value.requirements !== undefined && !Array.isArray(value.requirements)) throw new InputError("主对话需求目录无效");
  const requirementIds = new Set();
  for (const requirement of value.requirements ?? []) {
    mainId(requirement.agentId, "Agent");
    if (requirementIds.has(requirement.agentId) || !["create", "edit"].includes(requirement.mode)
      || !["needs_input", "ready", "needs_build"].includes(requirement.status) || typeof requirement.confirmed !== "boolean"
      || !requirement.draft || typeof requirement.draft !== "object" || !Array.isArray(requirement.userMessages)
      || requirement.userMessages.length > REQUIREMENT_HISTORY_MAX_MESSAGES
      || requirement.userMessages.some((message) => !textWithinLimit(message, REQUIREMENT_MESSAGE_MAX_CHARACTERS))
      || requirement.userMessages.reduce((total, message) => total + textLength(message), 0) > REQUIREMENT_HISTORY_MAX_CHARACTERS
      || !Number.isSafeInteger(requirement.version) || requirement.version < 1) throw new InputError("主对话需求记录无效");
    try { assertRequirementDraftSize(requirement.draft); }
    catch (error) { throw Object.assign(new InputError(error.reason ? error.message : "主对话需求记录无效"),
      error.reason ? { reason: error.reason, bytes: error.bytes, limitBytes: error.limitBytes } : {}); }
    requirementIds.add(requirement.agentId);
    if (requirement.consultation !== undefined && (requirement.consultation.version !== 1
      || !Number.isSafeInteger(requirement.consultation.revision) || requirement.consultation.revision < 0
      || !Array.isArray(requirement.consultation.evidenceMessages) || !Array.isArray(requirement.consultation.assessments)
      || !Array.isArray(requirement.consultation.issues) || !Array.isArray(requirement.consultation.receipts)))
      throw new InputError("主对话需求协商记录无效");
  }
  if (value.requirement && !requirementIds.has(value.requirement.agentId)) throw new InputError("当前主对话需求不属于已保存草稿");
  const ids = new Set();
  for (const message of value.messages) {
    mainId(message.id, "消息");
    if (ids.has(message.id) || !["user", "assistant"].includes(message.role) || typeof message.content !== "string"
      || (message.role === "assistant" && !STATES.has(message.status)) || !Array.isArray(message.sources) || !Array.isArray(message.actions))
      throw new InputError("主 Agent 消息格式无效");
    if (message.attachments !== undefined) {
      if (message.role !== "user" || !Array.isArray(message.attachments) || message.attachments.length > 10
        || new Set(message.attachments.map((item) => item.id)).size !== message.attachments.length) throw new InputError("主 Agent 材料引用格式无效");
      for (const attachment of message.attachments) {
        mainId(attachment.id, "材料");
        if (typeof attachment.name !== "string" || !attachment.name || !textWithinLimit(attachment.name, 500)) throw new InputError("主 Agent 材料名称无效");
      }
    }
    ids.add(message.id);
  }
  const mutations = new Set();
  for (const request of value.requests) {
    mainId(request.mutationId, "请求");
    if (mutations.has(request.mutationId) || !/^[a-f0-9]{64}$/.test(request.hash) || !STATES.has(request.status)
      || !ids.has(request.userId) || !ids.has(request.assistantId)) throw new InputError("主 Agent 请求记录格式无效");
    mutations.add(request.mutationId);
  }
  const bytes = Buffer.byteLength(JSON.stringify(value, null, 2), "utf8");
  if (bytes > MAX_BYTES) throw Object.assign(new InputError("主 Agent 对话已达 32 MiB，请开始新对话；已有记录保留"),
    { reason: "requirement_conversation_too_large", bytes, limitBytes: MAX_BYTES });
  return structuredClone(value);
}

export class MainStore {
  constructor({ dataDir }) {
    if (typeof dataDir !== "string" || !dataDir || dataDir.includes("\0")) throw new InputError("主 Agent 存储目录无效");
    this.dataDir = resolve(dataDir); this.root = join(this.dataDir, "main"); this.recordsDir = join(this.root, "conversations");
    this.records = new Map(); this.persistence = Promise.resolve(); this.ready = this.load(); this.ready.catch(() => {});
  }

  async load() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await directory(this.dataDir); await directory(this.root); await directory(this.recordsDir);
    for (const entry of await readdir(this.recordsDir, { withFileTypes: true })) {
      if (entry.name.startsWith(".pending-") || !entry.name.endsWith(".json")) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) throw new InputError("主 Agent 对话文件类型无效，请保留文件并检查");
      let record;
      try { record = checked(JSON.parse((await bytes(join(this.recordsDir, entry.name))).toString("utf8"))); }
      catch (error) { if (error instanceof InputError) throw error; throw new InputError("主 Agent 对话无法读取，请保留文件并检查"); }
      if (entry.name !== `${record.id}.json` || this.records.has(record.id)) throw new InputError("主 Agent 对话身份无效");
      let interrupted = false;
      for (const request of record.requests.filter((item) => item.status === "running")) {
        request.status = "interrupted"; request.diagnostic = { stage: "main", reason: "interrupted" };
        const message = record.messages.find((item) => item.id === request.assistantId);
        message.status = "interrupted"; message.diagnostic = request.diagnostic; interrupted = true;
      }
      if (interrupted) { record.version++; record.updatedAt = new Date().toISOString(); await this.write(record); }
      this.records.set(record.id, record);
    }
  }

  async write(record) {
    await directory(this.recordsDir);
    const path = join(this.recordsDir, `${record.id}.json`), temporary = join(this.recordsDir, `.pending-${randomUUID()}.json`);
    try { await bytes(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(JSON.stringify(record, null, 2), "utf8"); } finally { await handle.close(); }
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }

  queue(operation) {
    const task = this.persistence.then(async () => { await this.ready; return operation(); });
    this.persistence = task.catch(() => {}); return task;
  }

  create({ mutationId, title = "新对话" } = {}) {
    if (mutationId !== undefined) mainId(mutationId, "请求");
    if (typeof title !== "string" || !title.trim() || !textWithinLimit(title, 200)) throw new InputError("对话标题不能超过 200 字");
    return this.queue(async () => {
      const existing = mutationId && [...this.records.values()].find((item) => item.creationMutationId === mutationId);
      if (existing?.deletedAt) throw mainConversationFailure("conversation_deleted");
      if (existing) return structuredClone(existing);
      const now = new Date().toISOString();
      const record = checked({ schemaVersion: 1, id: `main_${randomUUID()}`, title: title.trim(), version: 1,
        messages: [], requests: [], createdAt: now, updatedAt: now, ...(mutationId ? { creationMutationId: mutationId } : {}) });
      await this.write(record); this.records.set(record.id, record); return structuredClone(record);
    });
  }

  async get(id) {
    mainId(id); await this.ready; await this.persistence;
    this.assertAvailable(id); return structuredClone(this.records.get(id));
  }

  assertAvailable(id) {
    mainId(id);
    const record = this.records.get(id); if (!record) throw new InputError("主 Agent 对话不存在，请新建对话");
    if (record.deletedAt) throw mainConversationFailure("conversation_deleted");
  }

  update(id, operation) {
    mainId(id);
    return this.queue(async () => {
      this.assertAvailable(id); const current = this.records.get(id);
      const next = structuredClone(current); operation(next); next.version = current.version + 1; next.updatedAt = new Date().toISOString();
      const saved = checked(next); await this.write(saved); this.records.set(id, saved); return structuredClone(saved);
    });
  }

  remove(id, { confirm, expectedVersion, mutationId } = {}, assertIdle = () => {}) {
    mainId(id); mainId(mutationId, "删除请求");
    if (confirm !== true) throw new InputError("请确认删除这份主对话");
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new InputError("删除主对话需要当前记录版本，请刷新后重试");
    return this.queue(async () => {
      const current = this.records.get(id);
      if (!current) throw new InputError("主 Agent 对话不存在，请刷新后重试");
      if (current.deletedAt) {
        if (current.deletionMutationId !== mutationId) throw mainConversationFailure("conversation_deleted");
        if (current.deletionExpectedVersion !== expectedVersion) throw mainConversationFailure("conversation_conflict");
        return { removed: true, conversationId: id };
      }
      assertIdle();
      if (current.requests.some((request) => request.status === "running"))
        throw mainConversationFailure("conversation_conflict", "这份主对话仍在回复，请停止或等待完成后再删除");
      if (current.version !== expectedVersion) throw mainConversationFailure("conversation_conflict");
      const now = new Date().toISOString();
      const tombstone = checked({ schemaVersion: 1, id, title: "已删除对话", version: current.version + 1, messages: [], requests: [],
        createdAt: current.createdAt, updatedAt: now, deletedAt: now, deletionMutationId: mutationId, deletionExpectedVersion: expectedVersion,
        ...(current.creationMutationId ? { creationMutationId: current.creationMutationId } : {}) });
      await this.write(tombstone); this.records.set(id, tombstone);
      return { removed: true, conversationId: id };
    });
  }

  async list() {
    await this.ready; await this.persistence;
    return [...this.records.values()].filter((record) => !record.deletedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(({ id, title, version, createdAt, updatedAt, messages }) => ({
      id, title, version, createdAt, updatedAt, messageCount: messages.length, status: messages.at(-1)?.status ?? "empty",
      preview: messages.at(-1)?.content.slice(0, 120) ?? "",
    }));
  }
}
