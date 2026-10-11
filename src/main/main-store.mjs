import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { InputError } from "../requirements/core.mjs";

const MAX_BYTES = 8 * 1024 * 1024;
const STATES = new Set(["running", "complete", "failed", "cancelled", "interrupted"]);

export function mainId(value, label = "对话") {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new InputError(`${label}标识无效`);
  return value;
}

async function directory(path) {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new InputError("主 Agent 存储目录必须是真实目录");
}

async function bytes(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_BYTES)
    throw new InputError("主 Agent 对话只允许 8 MB 以内的普通文件");
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
    || typeof value.title !== "string" || value.title.length > 200 || !Array.isArray(value.messages) || !Array.isArray(value.requests)
    || !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt))) throw new InputError("主 Agent 对话记录格式无效");
  mainId(value.id);
  if (value.requirements !== undefined && !Array.isArray(value.requirements)) throw new InputError("主对话需求目录无效");
  const requirementIds = new Set();
  for (const requirement of value.requirements ?? []) {
    mainId(requirement.agentId, "Agent");
    if (requirementIds.has(requirement.agentId) || !["create", "edit"].includes(requirement.mode)
      || !["needs_input", "ready", "needs_build"].includes(requirement.status) || typeof requirement.confirmed !== "boolean"
      || !requirement.draft || typeof requirement.draft !== "object" || !Array.isArray(requirement.userMessages)
      || requirement.userMessages.length > 12 || requirement.userMessages.some((message) => typeof message !== "string" || message.length > 4000)
      || !Number.isSafeInteger(requirement.version) || requirement.version < 1) throw new InputError("主对话需求记录无效");
    requirementIds.add(requirement.agentId);
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
        if (typeof attachment.name !== "string" || !attachment.name || attachment.name.length > 500) throw new InputError("主 Agent 材料名称无效");
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
  if (Buffer.byteLength(JSON.stringify(value, null, 2)) > MAX_BYTES) throw new InputError("主 Agent 对话已达 8 MB，请开始新对话；已有记录保留");
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
    if (typeof title !== "string" || !title.trim() || title.length > 200) throw new InputError("对话标题不能超过 200 字");
    return this.queue(async () => {
      const existing = mutationId && [...this.records.values()].find((item) => item.creationMutationId === mutationId);
      if (existing) return structuredClone(existing);
      const now = new Date().toISOString();
      const record = checked({ schemaVersion: 1, id: `main_${randomUUID()}`, title: title.trim(), version: 1,
        messages: [], requests: [], createdAt: now, updatedAt: now, ...(mutationId ? { creationMutationId: mutationId } : {}) });
      await this.write(record); this.records.set(record.id, record); return structuredClone(record);
    });
  }

  async get(id) {
    mainId(id); await this.ready; await this.persistence;
    const record = this.records.get(id); if (!record) throw new InputError("主 Agent 对话不存在，请新建对话");
    return structuredClone(record);
  }

  update(id, operation) {
    mainId(id);
    return this.queue(async () => {
      const current = this.records.get(id); if (!current) throw new InputError("主 Agent 对话不存在");
      const next = structuredClone(current); operation(next); next.version = current.version + 1; next.updatedAt = new Date().toISOString();
      const saved = checked(next); await this.write(saved); this.records.set(id, saved); return structuredClone(saved);
    });
  }

  async list() {
    await this.ready; await this.persistence;
    return [...this.records.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(({ id, title, version, createdAt, updatedAt, messages }) => ({
      id, title, version, createdAt, updatedAt, messageCount: messages.length, status: messages.at(-1)?.status ?? "empty",
      preview: messages.at(-1)?.content.slice(0, 120) ?? "",
    }));
  }
}
