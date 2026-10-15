import { randomUUID, createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, lstat, realpath, open, readdir, rename, rm } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { InputError } from "../requirements/core.mjs";

export const GROUP_LIMITS = Object.freeze({ concurrentMembers: 2, negotiationRounds: 2, executionTurns: 48, turnLimit: 12,
  publicReplyDepth: 2, publicReplyCount: 4, publicReplyTurns: 3, recordBytes: 32 * 1024 * 1024 });
export const TERMINAL_TASKS = new Set(["completed", "partial", "failed", "cancelled", "interrupted"]);
export const now = () => new Date().toISOString();
export function id(value, label = "标识") {
  if (typeof value !== "string" || !/^[\w-]{1,80}$/.test(value)) throw new InputError(`${label}无效`);
  return value;
}
export function text(value, label = "内容", limit = 12000, optional = false) {
  if (optional && (value === undefined || value === null)) return "";
  if (typeof value !== "string" || (!optional && !value.trim()) || value.length > limit || value.includes("\0")) throw new InputError(`${label}需为${optional ? "不超过" : "1～"}${limit}字的文本`);
  return value.trim();
}
export function conflict(message) { const error = new InputError(message); error.reason = "collaboration_conflict"; return error; }
export function fingerprint(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
async function directory(path, create = false) {
  if (create) { try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; } }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new InputError("群数据目录不能是链接");
  return realpath(path);
}

// The material service receives the same bounded filesystem interface as AgentStorage,
// rooted in groups instead of any member's private directory.
export class GroupStorage {
  constructor({ dataDir }) {
    this.root = resolve(dataDir, "groups");
    this.ready = this.initialize(dataDir); this.ready.catch(() => {});
  }
  async initialize(dataDir) {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await directory(resolve(dataDir)); await directory(this.root, true);
  }
  async directory(groupId, subpath = "", { create = false } = {}) {
    id(groupId, "群"); await this.ready;
    const parts = subpath ? subpath.split("/") : [];
    if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\\") || part.includes("\0"))) throw new InputError("群存储路径无效");
    let current = await directory(this.root);
    for (const part of [groupId, ...parts]) current = await directory(join(current, part), create);
    return current;
  }
  async path(groupId, file, create = false) {
    if (typeof file !== "string") throw new InputError("群存储路径无效");
    const parts = file.split("/"), name = parts.pop();
    if (!name || name === "." || name === ".." || /[\\\0]/.test(name)) throw new InputError("群存储路径无效");
    return join(await this.directory(groupId, parts.join("/"), { create }), name);
  }
  async readJson(groupId, file, { maxBytes = GROUP_LIMITS.recordBytes } = {}) {
    let handle;
    try {
      const path = await this.path(groupId, file);
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) throw new InputError("群数据文件无效或超过大小限制");
      const bytes = await handle.readFile();
      if (bytes.length > maxBytes) throw new InputError("群数据超过大小限制");
      return JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      if (error instanceof SyntaxError) throw new InputError("群数据无法读取，请保留原文件");
      throw error;
    } finally { await handle?.close(); }
  }
  async writeJson(groupId, file, value, { signal } = {}) {
    const bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > GROUP_LIMITS.recordBytes) throw new InputError("群记录已达到容量限制，请创建新群；现有记录已保留");
    const path = await this.path(groupId, file, true);
    try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new InputError("群数据不能是链接"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const temporary = join(dirname(path), `.pending-${randomUUID()}.json`);
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      signal?.throwIfAborted(); await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }
  async removeDirectory(groupId, subpath) {
    try { await rm(await this.directory(groupId, subpath), { recursive: true }); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  async ids() {
    await this.ready; const result = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      id(entry.name, "群"); await this.directory(entry.name); result.push(entry.name);
    }
    return result;
  }
}

export function event(record, type, details = {}) {
  const value = { ...details, type, groupId: record.group.id, seq: ++record.group.lastSequence, createdAt: now() };
  record.events.push(value); record.group.updatedAt = value.createdAt; return value;
}
export function message(record, sender, content, { taskId = null, recipientId = null, replyTo = null, status = "complete", visibility, kind } = {}) {
  if (visibility !== undefined && !["public", "internal"].includes(visibility)) throw new InputError("群消息展示范围无效");
  if (kind !== undefined && !["negotiation", "coordination", "member_result", "delivery", "reply", "clarification", "status"].includes(kind)) throw new InputError("群消息类型无效");
  const value = { id: randomUUID(), sender, content, taskId, recipientId, replyTo, status, createdAt: now() };
  if (visibility !== undefined) value.visibility = visibility;
  if (kind !== undefined) value.kind = kind;
  value.seq = event(record, "message", { messageId: value.id, taskId, agentId: sender.type === "agent" ? sender.id : null }).seq;
  record.messages.push(value); return value;
}

export class GroupStore {
  constructor({ dataDir, storage = new GroupStorage({ dataDir }) }) {
    this.storage = storage; this.records = new Map(); this.queues = new Map(); this.creation = Promise.resolve();
    this.ready = this.load(); this.ready.catch(() => {});
  }
  async load() {
    for (const groupId of await this.storage.ids()) {
      const record = await this.storage.readJson(groupId, "group.json");
      if (!record) continue;
      if (record.schemaVersion !== 1 || record.group?.id !== groupId || !Array.isArray(record.group.memberIds)
        || !["tasks", "messages", "events", "artifacts", "mutations"].every((key) => Array.isArray(record[key]))
        || !Number.isSafeInteger(record.group.lastSequence)) throw new InputError("群记录格式无效，请保留原文件");
      if (record.deletedConversations !== undefined) {
        if (!Array.isArray(record.deletedConversations)) throw new InputError("群对话删除记录格式无效，请保留原文件");
        for (const removed of record.deletedConversations) {
          if (!removed || !Array.isArray(removed.taskIds) || !Number.isFinite(Date.parse(removed.deletedAt)))
            throw new InputError("群对话删除记录格式无效，请保留原文件");
          id(removed.id, "已删除群对话"); for (const taskId of removed.taskIds) id(taskId, "已删除任务");
        }
      }
      record.group.materialIds ??= [];
      let changed = false;
      for (const task of record.tasks) if (["queued", "running", "negotiating", "waiting"].includes(task.status)) {
        task.status = "interrupted"; task.reason = "服务已重启，请检查已有成果后创建新任务继续"; task.updatedAt = now(); task.generation++;
        for (const job of task.jobs) if (["queued", "running"].includes(job.status)) job.status = "interrupted";
        if (task.replyRelay?.status === "running") {
          task.replyRelay.status = "interrupted";
          for (const request of task.replyRelay.requests) if (["queued", "running"].includes(request.status)) {
            request.status = "interrupted";
            const source = record.messages.find((value) => value.id === request.sourceMessageId);
            if (source) source.replyRequestStatus = "interrupted";
          }
        }
        for (const child of task.children) if (["queued", "running", "waiting"].includes(child.status)) child.status = "interrupted";
        event(record, "task", { taskId: task.id, status: task.status }); changed = true;
      }
      if (changed) { record.group.activeTaskId = null; await this.storage.writeJson(groupId, "group.json", record); }
      this.records.set(groupId, record);
    }
  }
  async get(groupId) { id(groupId, "群"); await this.ready; const value = this.records.get(groupId); if (!value) throw new InputError("没有找到这个群"); return structuredClone(value); }
  async list() { await this.ready; return [...this.records.values()].map((value) => structuredClone(value.group)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  change(groupId, action) {
    id(groupId, "群");
    const previous = this.queues.get(groupId) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      const next = await this.get(groupId), result = await action(next);
      await this.storage.writeJson(groupId, "group.json", next); this.records.set(groupId, next);
      return structuredClone(result);
    });
    this.queues.set(groupId, pending);
    void pending.finally(() => { if (this.queues.get(groupId) === pending) this.queues.delete(groupId); }).catch(() => {});
    return pending;
  }
  create(input) {
    const pending = this.creation.catch(() => {}).then(async () => {
      await this.ready;
      const hash = fingerprint(input);
      const prior = [...this.records.values()].find((value) => value.group.creationId === input.mutationId);
      if (prior) { if (prior.group.creationHash !== hash) throw conflict("创建请求已被用于其他群内容"); return structuredClone(prior.group); }
      const timestamp = now();
      const group = { id: randomUUID(), name: input.name, purpose: input.purpose, memberIds: input.memberIds,
        archived: false, materialIds: [], version: 1, createdAt: timestamp, updatedAt: timestamp, lastSequence: 0, activeTaskId: null, creationId: input.mutationId, creationHash: hash };
      const record = { schemaVersion: 1, group, tasks: [], messages: [], events: [], artifacts: [], mutations: [] };
      event(record, "group", { version: 1 });
      await this.storage.writeJson(group.id, "group.json", record); this.records.set(group.id, record); return structuredClone(group);
    });
    this.creation = pending; return pending;
  }
  async close() { await this.ready; await Promise.allSettled([this.creation, ...this.queues.values()]); }
}
