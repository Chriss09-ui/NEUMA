import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InputError } from "./core.mjs";
import { hashValue } from "./development-contract.mjs";

function safeId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value)) throw new InputError("研发记录标识无效");
  return value;
}

function checkedRecord(value, { stored = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new InputError("研发记录必须为对象");
  safeId(value.id); safeId(value.agentId);
  if (value.version !== undefined && (!Number.isSafeInteger(value.version) || value.version < 1)) throw new InputError("研发版本无效");
  if (typeof value.status !== "string" || !value.status.trim()) throw new InputError("研发记录缺少状态");
  if (stored && (!Number.isSafeInteger(value.revision) || value.revision < 1
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)))) throw new InputError("研发记录版本或时间无效");
  hashValue(value);
  return structuredClone(value);
}

export class DevelopmentStore {
  constructor({ dataDir }) {
    if (typeof dataDir !== "string" || !dataDir || dataDir.includes("\0")) throw new InputError("研发存储目录无效");
    this.directory = join(dataDir, "development");
    this.records = new Map();
    this.persistence = Promise.resolve();
    this.ready = this.load();
    this.ready.catch(() => {});
  }

  async ensureDirectory() {
    await mkdir(this.directory, { recursive: true });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new InputError("研发记录目录必须为真实目录");
  }

  async write(record) {
    await this.ensureDirectory();
    const temporary = join(this.directory, `${record.id}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(record, null, 2), { mode: 0o600, flag: "wx" });
      await rename(temporary, join(this.directory, `${record.id}.json`));
    } catch {
      throw new InputError("研发记录未能保存，请检查本机存储后重试；已有记录保留");
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }

  async load() {
    let entries;
    try {
      const info = await lstat(this.directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("invalid directory");
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw new InputError("研发记录目录无法读取，请保留原文件并检查后重试");
    }
    const records = new Map();
    for (const entry of entries.filter((item) => item.name.endsWith(".json"))) {
      try {
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("invalid record file");
        safeId(entry.name.slice(0, -5));
        const record = checkedRecord(JSON.parse(await readFile(join(this.directory, entry.name), "utf8")), { stored: true });
        if (entry.name !== `${record.id}.json` || records.has(record.id)) throw new Error("invalid identity");
        records.set(record.id, record);
      } catch {
        throw new InputError("研发记录已损坏或无法读取，请保留原文件并修复后重试");
      }
    }
    for (const record of records.values()) {
      if (record.status !== "running") continue;
      record.status = "interrupted";
      record.summary = "上次研发在完成前中断，已保留进度和预算，可核实检查点后继续。";
      record.updatedAt = new Date().toISOString();
      record.revision++;
      await this.write(record);
    }
    this.records = records;
  }

  queue(operation) {
    const task = this.persistence.then(async () => { await this.ready; return operation(); });
    this.persistence = task.catch(() => {});
    return task;
  }

  create(value) {
    const snapshot = checkedRecord(value);
    return this.queue(async () => {
      if (this.records.has(snapshot.id)) throw new InputError("这个研发批次已经存在");
      const latest = Math.max(0, ...[...this.records.values()].map((record) => Date.parse(record.createdAt)));
      const now = new Date(Math.max(Date.now(), latest + 1)).toISOString();
      const saved = { ...snapshot, revision: 1, createdAt: now, updatedAt: now };
      await this.write(saved);
      this.records.set(saved.id, saved);
      return structuredClone(saved);
    });
  }

  save(value, { expectedRevision = value?.revision } = {}) {
    const snapshot = checkedRecord(value);
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) throw new InputError("研发记录的预期版本无效");
    return this.queue(async () => {
      const current = this.records.get(snapshot.id);
      if (!current) throw new InputError("研发批次不存在，不能保存迟到结果");
      if (current.agentId !== snapshot.agentId || current.version !== snapshot.version) throw new InputError("研发批次的 Agent 或版本绑定不能改变");
      if (expectedRevision !== undefined && expectedRevision !== current.revision) {
        const error = new InputError("研发记录已更新，不能覆盖较新的状态");
        error.code = "DEVELOPMENT_REVISION_CONFLICT";
        throw error;
      }
      const saved = { ...snapshot, revision: current.revision + 1, createdAt: current.createdAt, updatedAt: new Date().toISOString() };
      await this.write(saved);
      this.records.set(saved.id, saved);
      return structuredClone(saved);
    });
  }

  async get(agentId) { return (await this.list(agentId))[0] ?? null; }

  async getRun(id) {
    safeId(id); await this.ready; await this.persistence;
    return structuredClone(this.records.get(id) ?? null);
  }

  async list(agentId) {
    safeId(agentId); await this.ready; await this.persistence;
    return structuredClone([...this.records.values()].filter((record) => record.agentId === agentId)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)));
  }

  remove(agentId) {
    safeId(agentId);
    return this.queue(async () => {
      const records = [...this.records.values()].filter((record) => record.agentId === agentId);
      for (const record of records) {
        try { await rm(join(this.directory, `${record.id}.json`), { force: true }); }
        catch { throw new InputError("研发记录未能移除，已保留尚未移除的记录和工作目录"); }
        this.records.delete(record.id);
      }
    });
  }
}
