import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { InputError } from "./core.mjs";
import { hashValue } from "./development-contract.mjs";

const migrations = new Map();
const MARKER = "agents-layout.json";

export function agentId(value) {
  if (typeof value !== "string" || !/^[\w-]{1,80}$/.test(value)) throw new InputError("Agent 标识无效");
  return value;
}

function parts(path) {
  if (typeof path !== "string" || path.includes("\\") || path.includes("\0")
    || path.split("/").some((part) => !part || part === "." || part === "..")) throw new InputError("Agent 存储路径无效");
  return path.split("/");
}

async function directory(path, create = false) {
  if (create) await mkdir(path, { mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new InputError("Agent 存储目录必须是真实目录");
  return realpath(path);
}

async function ensureDirectory(path) {
  try { return await directory(path); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    try { return await directory(path, true); }
    catch (error) { if (error.code !== "EEXIST") throw error; return directory(path); }
  }
}

async function readFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new InputError("Agent 数据只允许普通文件，不允许链接");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.nlink !== 1) throw new InputError("Agent 数据只允许普通文件");
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function readJson(path) {
  try {
    const value = JSON.parse((await readFile(path)).toString("utf8"));
    if (!value || typeof value !== "object") throw new InputError("Agent 数据文件格式无效");
    return value;
  }
  catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof InputError) throw error;
    throw new InputError("Agent 数据文件无法读取，请保留文件并检查后重试");
  }
}

async function atomicJson(path, value, signal) {
  try { await readFile(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = join(dirname(path), `.pending-${randomUUID()}.json`);
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify(value, null, 2), "utf8"); }
    finally { await handle.close(); }
    signal?.throwIfAborted();
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function tree(source, destination) {
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

async function entries(path) {
  try { await directory(path); return await readdir(path, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

async function discardStaging(path) {
  const visit = async (current) => {
    await chmod(current, 0o700);
    for (const entry of await readdir(current, { withFileTypes: true }))
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(join(current, entry.name));
  };
  await visit(path);
  await rm(path, { recursive: true, force: true });
}

function relocateSnapshot(value, id, dataDir, snapshots, originalDataDir) {
  if (value === null) return null;
  if (!value || typeof value.path !== "string" || typeof value.hash !== "string" || !Array.isArray(value.files)
    || !/^[a-f0-9]{64}$/.test(value.hash) || ![dataDir, originalDataDir].some((root) => resolve(value.path) === join(root, "development-snapshots", value.hash)))
    throw new InputError("旧研发快照路径无效，迁移已停止，原文件保留");
  snapshots.add(value.hash);
  return { ...value, path: join(dataDir, "agents", id, "development", "snapshots", value.hash), agentId: id };
}

function relocate(value, id, dataDir, snapshots, originalDataDir) {
  const result = structuredClone(value);
  const snapshot = (value) => relocateSnapshot(value, id, dataDir, snapshots, originalDataDir);
  // Business JSON can resemble a snapshot; only controller-owned references are relocated.
  for (const key of ["snapshot", "verifiedSnapshot"]) if (result[key] !== undefined) result[key] = snapshot(result[key]);
  const relocatePackage = (value) => { if (value?.snapshot !== undefined) value.snapshot = snapshot(value.snapshot); };
  relocatePackage(result.package);
  if (Array.isArray(result.deliveries)) for (const delivery of result.deliveries) relocatePackage(delivery?.package);
  return result;
}

function legacyRequirement(value, id, origin) {
  const date = origin === "architecture" ? value.createdAt : value.updatedAt ?? value.createdAt;
  return { id, name: value.name, draft: structuredClone(value.draft),
    updatedAt: Number.isFinite(Date.parse(date)) ? date : "1970-01-01T00:00:00.000Z", _legacyFallback: origin };
}

async function migrate(dataDir) {
  const originalDataDir = dataDir;
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
  if (definitions && (definitions.version !== 1 || !Array.isArray(definitions.agents))) throw new InputError("旧 Agent 定义格式无效，原文件保留");
  if (architectures && (architectures.version !== 1 || !Array.isArray(architectures.records))) throw new InputError("旧架构记录格式无效，原文件保留");
  const agents = new Map(), runIds = new Set(), architectureIds = new Set();
  const recordFor = (id) => {
    agentId(id);
    if (!agents.has(id)) agents.set(id, { definition: null, architectures: [], runs: [], workspace: null, snapshots: new Set() });
    return agents.get(id);
  };
  for (const agent of definitions?.agents ?? []) {
    const item = recordFor(agent?.id);
    if (item.definition || typeof agent.name !== "string" || !agent.name.trim() || agent.name.length > 120
      || typeof agent.draft?.goal?.value !== "string" || !agent.draft.goal.value.trim()
      || typeof agent.instructions !== "string" || !agent.instructions.trim() || agent.instructions.length > 12000
      || !Number.isSafeInteger(agent.revision) || agent.revision < 1
      || !agent.draft || Array.isArray(agent.draft) || JSON.stringify(agent.draft).length > 60000
      || (agent.memory !== undefined && (typeof agent.memory !== "string" || agent.memory.length > 12000 || agent.memory.includes("\0"))))
      throw new InputError("旧 Agent 定义格式无效，原文件保留");
    const profile = agent.profile;
    if (profile !== undefined && (!profile || typeof profile !== "object" || Array.isArray(profile)
      || typeof profile.name !== "string" || !profile.name.trim() || profile.name.length > 120 || profile.name.includes("\0")
      || typeof profile.description !== "string" || profile.description.length > 240 || profile.description.includes("\0")
      || typeof profile.icon !== "string" || profile.icon.length > 16 || profile.icon.includes("\0")))
      throw new InputError("旧 Agent 展示资料格式无效，原文件保留");
    item.definition = agent;
  }
  for (const record of architectures?.records ?? []) {
    const item = recordFor(record?.agentId), key = record.agentId + ":" + record.version;
    if (!Number.isSafeInteger(record.version) || record.version < 1 || architectureIds.has(key)) throw new InputError("旧架构记录格式无效，原文件保留");
    architectureIds.add(key); item.architectures.push(record);
  }
  for (const entry of await entries(join(dataDir, "development"))) {
    if (!entry.name.endsWith(".json")) continue;
    const record = await readJson(join(dataDir, "development", entry.name));
    const item = recordFor(record?.agentId);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(record.id) || entry.name !== record.id + ".json" || runIds.has(record.id)
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(record.agentId)
      || (record.version !== undefined && (!Number.isSafeInteger(record.version) || record.version < 1))
      || !Number.isSafeInteger(record.revision) || record.revision < 1 || typeof record.status !== "string" || !record.status.trim()
      || typeof record.createdAt !== "string" || typeof record.updatedAt !== "string"
      || !Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt))) throw new InputError("旧研发记录格式无效，原文件保留");
    hashValue(record);
    runIds.add(record.id);
    item.runs.push(relocate(record, record.agentId, dataDir, item.snapshots, originalDataDir));
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
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (exists) {
        const completed = await readJson(join(target, ".legacy-migrated.json"));
        if (completed?.version === 1) continue;
        throw new InputError("新旧 Agent 目录冲突，迁移已停止，所有原文件保留");
      }
      const temporary = await ensureDirectory(join(staging, id));
      if (item.definition) await atomicJson(join(temporary, "definition.json"), { version: 1, agent: item.definition });
      if (item.architectures.length) await atomicJson(join(temporary, "architecture.json"), { version: 1, records: item.architectures });
      const architecture = item.architectures.slice().sort((a, b) => b.version - a.version)
        .find((record) => typeof record.name === "string" && record.name.trim() && typeof record.draft?.goal?.value === "string");
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
          catch (error) { if (error.code !== "ENOENT") throw error; }
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

export class AgentStorage {
  constructor({ dataDir }) {
    if (typeof dataDir !== "string" || !dataDir || dataDir.includes("\0")) throw new InputError("Agent 存储目录无效");
    this.dataDir = resolve(dataDir);
    if (!migrations.has(this.dataDir)) {
      const pending = migrate(this.dataDir);
      migrations.set(this.dataDir, pending);
      void pending.finally(() => { if (migrations.get(this.dataDir) === pending) migrations.delete(this.dataDir); }).catch(() => {});
    }
    this.ready = migrations.get(this.dataDir);
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

  async directory(id, subpath = "", { create = false } = {}) {
    agentId(id); await this.ready;
    let current = await directory(this.dataDir);
    for (const part of ["agents", id, ...(subpath ? parts(subpath) : [])]) {
      current = join(current, part);
      current = await (create ? ensureDirectory(current) : directory(current));
    }
    return current;
  }

  async path(id, file, create = false) {
    const names = parts(file), name = names.pop();
    return join(await this.directory(id, names.join("/"), { create }), name);
  }

  async readJson(id, file) {
    try { return await readJson(await this.path(id, file)); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }

  async writeJson(id, file, value, { signal } = {}) {
    await atomicJson(await this.path(id, file, true), value, signal);
  }

  async removeFile(id, file) {
    let path;
    try { path = await this.path(id, file); await readFile(path); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    await rm(path);
  }

  async removeDirectory(id, subpath) {
    let path;
    try { path = await this.directory(id, subpath); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    await rm(path, { recursive: true });
  }
}
