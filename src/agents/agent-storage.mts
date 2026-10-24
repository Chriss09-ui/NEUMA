import type { Stats } from "node:fs";
import type { UnknownRecord } from "../contracts/json.mjs";
import type { AgentStoragePort } from "../runtime/storage-port.mjs";
import { objectFields, isArray, isInteger, errorField } from "../runtime/type-boundary.mjs";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { InputError } from "../requirements/core.mjs";
import { hashValue } from "../development/development-contract.mjs";
import { assertRequirementDraftSize } from "../requirements/requirement-limits.mjs";
import { textWithinLimit } from "../runtime/text-length.mjs";
interface MigrationAgent { definition: UnknownRecord | null; architectures: (UnknownRecord & { version: number })[]; runs: (UnknownRecord & { id: string })[]; workspace: string | null; snapshots: Set<string> }

const migrations = new Map<string, Promise<void>>();
const MARKER = "agents-layout.json";

export function agentId(value: unknown): string {
  if (typeof value !== "string" || !/^[\w-]{1,80}$/.test(value)) throw new InputError("Agent 标识无效");
  return value;
}

function parts(path: unknown): string[] {
  if (typeof path !== "string" || path.includes("\\") || path.includes("\0")
    || path.split("/").some((part) => !part || part === "." || part === "..")) throw new InputError("Agent 存储路径无效");
  return path.split("/");
}

async function directory(path: string, create = false) {
  if (create) await mkdir(path, { mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new InputError("Agent 存储目录必须是真实目录");
  return realpath(path);
}

async function ensureDirectory(path: string) {
  try { return await directory(path); }
  catch (error) {
    if (errorField(error, "code") !== "ENOENT") throw error;
    try { return await directory(path, true); }
    catch (error) { if (errorField(error, "code") !== "EEXIST") throw error; return directory(path); }
  }
}

async function checkAtomicReplacement(path: string, previous: Stats, attempt: number, maxBytes: number) {
  const replacement = await lstat(path);
  if (!replacement.isFile() || replacement.isSymbolicLink() || replacement.nlink !== 1
    || replacement.dev !== previous.dev || replacement.ino === previous.ino)
    throw new InputError("Agent 数据只允许普通文件，不允许链接");
  if (replacement.size > maxBytes) throw new InputError("Agent 数据文件超过大小限制");
  if (attempt >= 2) throw new InputError("Agent 数据读取期间连续更新，请稍后重试");
}

async function readFile(path: string, maxBytes = Infinity): Promise<Buffer> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const info = await lstat(path);
    // A path stat can also finish against an inode unlinked by atomic rename.
    if (info.isFile() && !info.isSymbolicLink() && info.nlink === 0) {
      await checkAtomicReplacement(path, info, attempt, maxBytes); continue;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new InputError("Agent 数据只允许普通文件，不允许链接");
    if (info.size > maxBytes) throw new InputError("Agent 数据文件超过大小限制");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const current = await handle.stat();
      // An atomic JSON replacement can unlink the already-open old inode. Reopen
      // only when the path now names a distinct, ordinary, singly-linked file.
      if (current.isFile() && current.nlink === 0) {
        await checkAtomicReplacement(path, current, attempt, maxBytes); continue;
      }
      if (!current.isFile() || current.nlink !== 1) throw new InputError("Agent 数据只允许普通文件");
      if (current.size > maxBytes) throw new InputError("Agent 数据文件超过大小限制");
      const content = await handle.readFile();
      if (content.length > maxBytes) throw new InputError("Agent 数据文件超过大小限制");
      return content;
    } finally { await handle.close(); }
  }
  throw new InputError("Agent 数据读取期间连续更新，请稍后重试");
}

async function readJson(path: string, maxBytes?: number): Promise<UnknownRecord | null> {
  try {
    const value: unknown = JSON.parse((await readFile(path, maxBytes)).toString("utf8"));
    if (!value || typeof value !== "object") throw new InputError("Agent 数据文件格式无效");
    return value as UnknownRecord;
  }
  catch (error) {
    if (errorField(error, "code") === "ENOENT") return null;
    if (error instanceof InputError) throw error;
    throw new InputError("Agent 数据文件无法读取，请保留文件并检查后重试");
  }
}

async function atomicJson(path: string, value: unknown, signal?: AbortSignal) {
  try { await readFile(path); } catch (error) { if (errorField(error, "code") !== "ENOENT") throw error; }
  const temporary = join(dirname(path), `.pending-${randomUUID()}.json`);
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify(value, null, 2), "utf8"); }
    finally { await handle.close(); }
    signal?.throwIfAborted();
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function tree(source: string, destination: string): Promise<void> {
  await directory(source);
  const sourceInfo = await lstat(source);
  await ensureDirectory(destination);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === "." || entry.name === "..") throw new InputError("旧 Agent 文件路径无效");
    const from = join(source, entry.name), to = join(destination, entry.name);
    const info = await lstat(from);
    if (info.isSymbolicLink()) throw new InputError("旧 Agent 文件包含链接，迁移已停止，原文件保留");
    if (info.isDirectory()) await tree(from, to);
    else {
      const content = await readFile(from);
      const handle = await open(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, info.mode & 0o777);
      try { await handle.writeFile(content); } finally { await handle.close(); }
      await chmod(to, info.mode & 0o777);
    }
  }
  await chmod(destination, sourceInfo.mode & 0o777);
}

async function entries(path: string) {
  try { await directory(path); return await readdir(path, { withFileTypes: true }); }
  catch (error) { if (errorField(error, "code") === "ENOENT") return []; throw error; }
}

async function discardStaging(path: string) {
  const visit = async (current: string): Promise<void> => {
    await chmod(current, 0o700);
    for (const entry of await readdir(current, { withFileTypes: true }))
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(join(current, entry.name));
  };
  await visit(path);
  await rm(path, { recursive: true, force: true });
}

function relocateSnapshot(input: unknown, id: string, dataDir: string, snapshots: Set<string>, originalDataDir: string) {
  if (input === null) return null;
  const value = objectFields(input);
  if (!value || typeof value.path !== "string" || typeof value.hash !== "string" || !isArray(value.files)
    || !/^[a-f0-9]{64}$/.test(value.hash) || ![dataDir, originalDataDir].some((root) => resolve(value.path as string) === join(root, "development-snapshots", value.hash as string)))
    throw new InputError("旧研发快照路径无效，迁移已停止，原文件保留");
  snapshots.add(value.hash);
  return { ...value, path: join(dataDir, "agents", id, "development", "snapshots", value.hash), agentId: id };
}

function relocate(value: UnknownRecord, id: string, dataDir: string, snapshots: Set<string>, originalDataDir: string) {
  const result = structuredClone(value);
  const snapshot = (value: unknown) => relocateSnapshot(value, id, dataDir, snapshots, originalDataDir);
  // Business JSON can resemble a snapshot; only controller-owned references are relocated.
  for (const key of ["snapshot", "verifiedSnapshot"]) if (result[key] !== undefined) result[key] = snapshot(result[key]);
  const relocatePackage = (input: unknown) => { const value = objectFields(input); if (value.snapshot !== undefined) value.snapshot = snapshot(value.snapshot); };
  relocatePackage(result.package);
  if (isArray(result.deliveries)) for (const delivery of result.deliveries) relocatePackage(objectFields(delivery).package);
  return result;
}

function legacyRequirement(value: UnknownRecord, id: string, origin: string) {
  const date = origin === "architecture" ? value.createdAt : value.updatedAt ?? value.createdAt;
  return { id, name: value.name, draft: structuredClone(value.draft),
    updatedAt: Number.isFinite(Date.parse(date as string)) ? date : "1970-01-01T00:00:00.000Z", _legacyFallback: origin };
}

async function migrate(dataDir: string, legacyDataDir = dataDir) {
  const originalDataDir = resolve(legacyDataDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  dataDir = await directory(dataDir);
  const marker = await readJson(join(dataDir, MARKER));
  if (marker) {
    if (marker.version !== 1) throw new InputError("Agent 存储版本无效");
    await directory(join(dataDir, "agents"));
    return;
  }
  const definitions = await readJson(join(dataDir, "agents.json"));
  const architectures = await readJson(join(dataDir, "architectures.json"));
  if (definitions && (definitions.version !== 1 || !isArray(definitions.agents))) throw new InputError("旧 Agent 定义格式无效，原文件保留");
  if (architectures && (architectures.version !== 1 || !isArray(architectures.records))) throw new InputError("旧架构记录格式无效，原文件保留");
  const agents = new Map<string, MigrationAgent>(), runIds = new Set<string>(), architectureIds = new Set<string>();
  const recordFor = (input: unknown): MigrationAgent => {
    const id = agentId(input);
    if (!agents.has(id)) agents.set(id, { definition: null, architectures: [], runs: [], workspace: null, snapshots: new Set() });
    return agents.get(id)!;
  };
  for (const raw of (definitions?.agents ?? []) as unknown[]) {
    const agent = objectFields(raw);
    const item = recordFor(agent?.id);
    if (item.definition || typeof agent.name !== "string" || !agent.name.trim() || !textWithinLimit(agent.name, 120)
      || typeof objectFields(objectFields(agent.draft).goal).value !== "string" || !(objectFields(objectFields(agent.draft).goal).value as string).trim()
      || typeof agent.instructions !== "string" || !agent.instructions.trim() || !textWithinLimit(agent.instructions, 12000)
      || !isInteger(agent.revision) || agent.revision < 1
      || !agent.draft || isArray(agent.draft)
      || (agent.memory !== undefined && (typeof agent.memory !== "string" || !textWithinLimit(agent.memory, 12000) || agent.memory.includes("\0"))))
      throw new InputError("旧 Agent 定义格式无效，原文件保留");
    try { assertRequirementDraftSize(agent.draft); }
    catch (error) { throw Object.assign(new InputError(String(errorField(error, "message"))), { reason: errorField(error, "reason"), bytes: errorField(error, "bytes"), limitBytes: errorField(error, "limitBytes") }); }
    const profile = agent.profile;
    if (profile !== undefined && (!profile || typeof profile !== "object" || isArray(profile)
      || typeof objectFields(profile).name !== "string" || !(objectFields(profile).name as string).trim() || !textWithinLimit(objectFields(profile).name, 120) || (objectFields(profile).name as string).includes("\0")
      || typeof objectFields(profile).description !== "string" || !textWithinLimit(objectFields(profile).description, 240) || (objectFields(profile).description as string).includes("\0")
      || typeof objectFields(profile).icon !== "string" || !textWithinLimit(objectFields(profile).icon, 16) || (objectFields(profile).icon as string).includes("\0")))
      throw new InputError("旧 Agent 展示资料格式无效，原文件保留");
    item.definition = agent;
  }
  for (const raw of (architectures?.records ?? []) as unknown[]) {
    const record = objectFields(raw);
    const item = recordFor(record?.agentId), key = String(record.agentId) + ":" + String(record.version);
    if (!isInteger(record.version) || record.version < 1 || architectureIds.has(key)) throw new InputError("旧架构记录格式无效，原文件保留");
    architectureIds.add(key); item.architectures.push(record as UnknownRecord & { version: number });
  }
  for (const entry of await entries(join(dataDir, "development"))) {
    if (!entry.name.endsWith(".json")) continue;
    const raw = await readJson(join(dataDir, "development", entry.name));
    const record = objectFields(raw);
    const item = recordFor(record?.agentId);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(record.id as string) || entry.name !== record.id + ".json" || runIds.has(record.id as string)
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(record.agentId as string)
      || (record.version !== undefined && (!isInteger(record.version) || record.version < 1))
      || !isInteger(record.revision) || record.revision < 1 || typeof record.status !== "string" || !record.status.trim()
      || typeof record.createdAt !== "string" || typeof record.updatedAt !== "string"
      || !Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt))) throw new InputError("旧研发记录格式无效，原文件保留");
    hashValue(record);
    runIds.add(record.id as string);
    item.runs.push(relocate(record, record.agentId as string, dataDir, item.snapshots, originalDataDir) as UnknownRecord & { id: string });
  }
  for (const entry of await entries(join(dataDir, "agent-workspaces"))) {
    const item = recordFor(entry.name);
    await directory(join(dataDir, "agent-workspaces", entry.name));
    item.workspace = join(dataDir, "agent-workspaces", entry.name);
  }
  const root = await ensureDirectory(join(dataDir, "agents"));
  const staging = join(dataDir, `.agents-migration-${randomUUID()}`);
  await ensureDirectory(staging);
  try {
    for (const [id, item] of agents) {
      const target = join(root, id);
      let exists = false;
      try { await directory(target); exists = true; }
      catch (error) { if (errorField(error, "code") !== "ENOENT") throw error; }
      if (exists) {
        const completed = await readJson(join(target, ".legacy-migrated.json"));
        if (completed?.version === 1) continue;
        throw new InputError("新旧 Agent 目录冲突，迁移已停止，所有原文件保留");
      }
      const temporary = await ensureDirectory(join(staging, id));
      if (item.definition) await atomicJson(join(temporary, "definition.json"), { version: 1, agent: item.definition });
      if (item.architectures.length) await atomicJson(join(temporary, "architecture.json"), { version: 1, records: item.architectures });
      const architecture = item.architectures.slice().sort((a, b) => b.version - a.version)
        .find((record) => typeof record.name === "string" && record.name.trim() && typeof objectFields(objectFields(record.draft).goal).value === "string");
      const requirement = architecture ?? item.definition;
      if (requirement) await atomicJson(join(temporary, "requirements.json"), legacyRequirement(requirement, id, architecture ? "architecture" : "definition"));
      if (item.workspace) await tree(item.workspace, join(temporary, "workspace"));
      if (item.runs.length) {
        const development = await ensureDirectory(join(temporary, "development"));
        const records = await ensureDirectory(join(development, "records"));
        const workspaces = await ensureDirectory(join(development, "workspaces"));
        for (const run of item.runs) {
          await atomicJson(join(records, run.id + ".json"), run);
          const source = join(dataDir, "development-workspaces", run.id);
          let found = false;
          try { await directory(join(dataDir, "development-workspaces")); await directory(source); found = true; }
          catch (error) { if (errorField(error, "code") !== "ENOENT") throw error; }
          if (found) await tree(source, join(workspaces, run.id));
        }
        if (item.snapshots.size) {
          const snapshots = await ensureDirectory(join(development, "snapshots"));
          await directory(join(dataDir, "development-snapshots"));
          for (const hash of item.snapshots) await tree(join(dataDir, "development-snapshots", hash), join(snapshots, hash));
        }
      }
      await atomicJson(join(temporary, ".legacy-migrated.json"), { version: 1 });
    }
    // Publish complete Agent directories only after every source was copied successfully.
    for (const entry of await readdir(staging)) await rename(join(staging, entry), join(root, entry));
    await atomicJson(join(dataDir, MARKER), { version: 1 });
  } finally { await discardStaging(staging); }
}

export class AgentStorage implements AgentStoragePort {
  readonly dataDir: string;
  readonly ready: Promise<void>;
  constructor({ dataDir, legacyDataDir = dataDir }: { dataDir: string; legacyDataDir?: string }) {
    if (typeof dataDir !== "string" || !dataDir || dataDir.includes("\0")) throw new InputError("Agent 存储目录无效");
    if (typeof legacyDataDir !== "string" || !legacyDataDir || legacyDataDir.includes("\0")) throw new InputError("旧 Agent 存储目录无效");
    this.dataDir = resolve(dataDir);
    if (!migrations.has(this.dataDir)) {
      const pending = migrate(this.dataDir, legacyDataDir);
      migrations.set(this.dataDir, pending);
      void pending.finally(() => { if (migrations.get(this.dataDir) === pending) migrations.delete(this.dataDir); }).catch(() => {});
    }
    this.ready = migrations.get(this.dataDir)!;
    this.ready.catch(() => {});
  }

  async agentIds() {
    await this.ready;
    const result = [];
    for (const entry of await entries(join(this.dataDir, "agents"))) {
      if (entry.name.startsWith(".")) continue;
      agentId(entry.name);
      await directory(join(this.dataDir, "agents", entry.name));
      result.push(entry.name);
    }
    return result.sort();
  }

  async directory(id: string, subpath = "", { create = false } = {}) {
    agentId(id); await this.ready;
    let current = await directory(this.dataDir);
    for (const part of ["agents", id, ...(subpath ? parts(subpath) : [])]) {
      current = join(current, part);
      current = await (create ? ensureDirectory(current) : directory(current));
    }
    return current;
  }

  async path(id: string, file: string, create = false) {
    const names = parts(file), name = names.pop()!;
    return join(await this.directory(id, names.join("/"), { create }), name);
  }

  async readJson(id: string, file: string, { maxBytes }: { maxBytes?: number } = {}) {
    try { return await readJson(await this.path(id, file), maxBytes); }
    catch (error) { if (errorField(error, "code") === "ENOENT") return null; throw error; }
  }

  async jsonFiles(id: string, subpath: string) {
    let root;
    try { root = await this.directory(id, subpath); }
    catch (error) { if (errorField(error, "code") === "ENOENT") return []; throw error; }
    const files = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.name.startsWith(".pending-") && entry.name.endsWith(".json")) continue;
      if (!/^[\w-]{1,80}\.json$/.test(entry.name)) throw new InputError("Agent 元数据文件名无效");
      const info = await lstat(join(root, entry.name));
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new InputError("Agent 数据只允许普通文件，不允许链接");
      files.push(entry.name);
    }
    return files.sort();
  }

  async writeJson(id: string, file: string, value: unknown, { signal }: { signal?: AbortSignal | undefined } = {}) {
    await atomicJson(await this.path(id, file, true), value, signal);
  }

  async removeFile(id: string, file: string) {
    let path;
    try { path = await this.path(id, file); await readFile(path); }
    catch (error) { if (errorField(error, "code") === "ENOENT") return; throw error; }
    await rm(path);
  }

  async removeDirectory(id: string, subpath: string) {
    let path;
    try { path = await this.directory(id, subpath); }
    catch (error) { if (errorField(error, "code") === "ENOENT") return; throw error; }
    await rm(path, { recursive: true });
  }
}
