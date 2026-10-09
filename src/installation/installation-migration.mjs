import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { InputError } from "../requirements/core.mjs";
import { AgentStorage, agentId } from "../agents/agent-storage.mjs";
import { AgentLibrary } from "../agents/agent-library.mjs";
import { hashValue } from "../development/development-contract.mjs";
import { inspectDevelopmentCode } from "../development/development-workspace.mjs";

export const MIGRATION_LIMITS = Object.freeze({ bytes: 256 * 1024 * 1024, fileBytes: 16 * 1024 * 1024,
  jsonBytes: 8 * 1024 * 1024, entries: 20000 });
const credentials = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|credentials?(?:\..*)?|secrets?(?:\..*)?|auth(?:\..*)?|tokens?(?:\..*)?|passwords?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore))$/i;
const transient = /^(?:\.DS_Store|\.pending-.*|\.write-.*|\.agents-migration-.*|\.installation-migration-.*|\.instance(?:[.-].*)?|projects-[\w-]+\.tmp|pending-[\w-]+)$/;
const safeRunId = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
const missing = (error) => error.code === "ENOENT";
const ignored = (name, prefix) => credentials.test(name) || transient.test(name)
  || (name === "pi" && (prefix === "" || /^agents\/[\w-]+\/$/.test(prefix)));
const metadata = (name) => /^(?:agents\.json|architectures\.json|agents-layout\.json|projects\.json|project-add-failures\.json|development\/[^/]+\.json|agents\/[^/]+\/(?:definition\.json|requirements\.json|architecture\.json|deleted\.json|conversations\/saved\.json|development\/records\/[^/]+\.json))$/.test(name);
const abort = (signal) => signal?.throwIfAborted();

function inputPath(value, label) {
  if (typeof value !== "string" || !value || value.includes("\0")) throw new InputError(`${label}路径无效`);
  return resolve(value);
}

async function directory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new InputError("迁移目录必须是真实目录，不能是链接");
  return realpath(path);
}

async function canonicalDestination(path) {
  const tail = [];
  let parent = path;
  while (true) {
    try { return join(await directory(parent), ...tail.reverse()); }
    catch (error) {
      if (!missing(error)) throw error;
      tail.push(basename(parent)); parent = dirname(parent);
    }
  }
}

function contains(root, path) {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(".." + sep) && !isAbsolute(child));
}

function identity(info) {
  return [info.dev, info.ino, info.size, info.mode, info.mtimeMs, info.ctimeMs].join(":");
}

async function inventory(root, limits, signal) {
  const entries = [], counts = { files: 0, bytes: 0, skipped: 0 };
  const visit = async (path, prefix = "") => {
    await directory(path);
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      abort(signal);
      if (ignored(entry.name, prefix)) { counts.skipped++; continue; }
      const from = join(path, entry.name), name = prefix + entry.name, info = await lstat(from);
      if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1)))
        throw new InputError("旧数据包含链接或非普通文件，迁移已停止，原文件保留");
      if (entries.length >= limits.entries) throw new InputError("迁移条目数量超过限制，需要确认更大的迁移预算");
      entries.push({ name, directory: info.isDirectory(), mode: info.mode & 0o777, identity: identity(info), size: info.size });
      if (info.isDirectory()) await visit(from, name + "/");
      else {
        counts.files++; counts.bytes += info.size;
        if (info.size > limits.fileBytes || counts.bytes > limits.bytes)
          throw new InputError("迁移数据超过单文件或总量限制，需要确认更大的迁移预算");
        if (metadata(name) && info.size > limits.jsonBytes) throw new InputError("迁移元数据超过大小限制，需要确认更大的迁移预算");
      }
    }
  };
  await visit(root);
  return { entries, ...counts };
}

async function copyFile(source, destination, entry, limits, signal) {
  const from = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let to;
  try {
    const before = await from.stat();
    if (!before.isFile() || before.nlink !== 1 || identity(before) !== entry.identity)
      throw new InputError("旧数据在迁移期间发生变化，请停止旧服务后重试");
    to = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    while (true) {
      abort(signal);
      const { bytesRead } = await from.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > entry.size || bytes > limits.fileBytes) throw new InputError("旧数据在迁移期间发生变化，请停止旧服务后重试");
      let written = 0;
      while (written < bytesRead) written += (await to.write(buffer, written, bytesRead - written, null)).bytesWritten;
    }
    if (bytes !== entry.size || identity(await from.stat()) !== entry.identity)
      throw new InputError("旧数据在迁移期间发生变化，请停止旧服务后重试");
    await to.chmod(entry.mode);
  } finally { await to?.close(); await from.close(); }
}

async function readJson(path, limit) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > limit) throw new InputError("迁移元数据类型无效或超过大小限制");
    const bytes = await handle.readFile();
    if (bytes.length > limit) throw new InputError("迁移元数据超过大小限制");
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("迁移元数据格式无效");
    return value;
  } catch (error) {
    if (missing(error)) return null;
    if (error instanceof InputError) throw error;
    throw new InputError("迁移元数据已损坏，请保留原文件并检查后重试");
  } finally { await handle?.close(); }
}

async function writeJson(path, value, limit, signal) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2));
  if (bytes.length > limit) throw new InputError("迁移后的元数据超过大小限制");
  const temporary = join(dirname(path), `.pending-${randomUUID()}.json`);
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
    abort(signal); await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function relocateRecord(record, id, { sourceDir, staging, dataDir, signal, checkedSnapshots }) {
  const snapshot = async (value) => {
    if (value === null) return null;
    if (!value || value.agentId !== id || typeof value.path !== "string" || !/^[a-f0-9]{64}$/.test(value.hash) || !Array.isArray(value.files)
      || ![sourceDir, staging].some((root) => resolve(value.path) === join(root, "agents", id, "development", "snapshots", value.hash)))
      throw new InputError("研发快照路径或 Agent 身份无效，迁移已停止");
    abort(signal);
    const key = `${id}:${value.hash}`;
    let actual = checkedSnapshots.get(key);
    if (!actual) {
      const inspected = await inspectDevelopmentCode(join(staging, "agents", id, "development", "snapshots", value.hash));
      actual = { hash: inspected.hash, files: inspected.files };
      checkedSnapshots.set(key, actual);
    }
    if (actual.hash !== value.hash || JSON.stringify(actual.files) !== JSON.stringify(value.files))
      throw new InputError("研发快照内容校验失败，迁移已停止");
    return { ...value, path: join(dataDir, "agents", id, "development", "snapshots", value.hash) };
  };
  // Only controller references move; user examples and execution output remain unchanged.
  for (const key of ["snapshot", "verifiedSnapshot"]) if (record[key] !== undefined) record[key] = await snapshot(record[key]);
  const relocatePackage = async (value) => { if (value?.snapshot !== undefined) value.snapshot = await snapshot(value.snapshot); };
  await relocatePackage(record.package);
  if (Array.isArray(record.deliveries)) for (const delivery of record.deliveries) await relocatePackage(delivery?.package);
}

async function validateAndRelocate({ sourceDir, staging, dataDir, limits, signal }) {
  // AgentStorage normalizes copies only; constructing DevelopmentStore would alter running records.
  const storage = new AgentStorage({ dataDir: staging, legacyDataDir: sourceDir });
  await storage.ready;
  const ids = await storage.agentIds(), runIds = new Set(), checkedSnapshots = new Map();
  const library = new AgentLibrary({ dataDir: staging, storage });
  await library.list();
  for (const id of ids) {
    abort(signal); agentId(id);
    const definition = await readJson(join(staging, "agents", id, "definition.json"), limits.jsonBytes);
    const deleted = await readJson(join(staging, "agents", id, "deleted.json"), limits.jsonBytes);
    if (deleted && deleted.id !== id) throw new InputError("删除标记的 Agent 身份无效");
    if (definition && !deleted) {
      const value = definition.agent;
      if (definition.version !== 1 || value?.id !== id || typeof value.name !== "string" || !value.name.trim() || value.name.length > 120
        || typeof value.draft?.goal?.value !== "string" || !value.draft.goal.value.trim() || JSON.stringify(value.draft).length > 60000
        || typeof value.instructions !== "string" || !value.instructions.trim() || value.instructions.length > 12000
        || !Number.isSafeInteger(value.revision) || value.revision < 1
        || (value.memory !== undefined && (typeof value.memory !== "string" || value.memory.length > 12000 || value.memory.includes("\0"))))
        throw new InputError("Agent 定义格式或身份无效");
      if (value.profile !== undefined && (!value.profile || typeof value.profile.name !== "string" || !value.profile.name.trim()
        || value.profile.name.length > 120 || value.profile.name.includes("\0") || typeof value.profile.description !== "string"
        || value.profile.description.length > 240 || value.profile.description.includes("\0") || typeof value.profile.icon !== "string"
        || value.profile.icon.length > 16 || value.profile.icon.includes("\0"))) throw new InputError("Agent 展示资料格式无效");
    }
    const architecture = await readJson(join(staging, "agents", id, "architecture.json"), limits.jsonBytes);
    if (architecture) {
      const versions = new Set();
      if (architecture.version !== 1 || !Array.isArray(architecture.records)) throw new InputError("架构记录格式无效");
      for (const record of architecture.records) {
        if (record?.agentId !== id || !Number.isSafeInteger(record.version) || record.version < 1 || versions.has(record.version))
          throw new InputError("架构记录的 Agent 身份或版本无效");
        versions.add(record.version);
      }
    }
    await library.getConversation(id);
    const records = join(staging, "agents", id, "development", "records");
    let entries;
    try { entries = await readdir(records); } catch (error) { if (missing(error)) continue; throw error; }
    for (const name of entries) {
      if (!name.endsWith(".json") || name.startsWith(".pending-")) continue;
      const path = join(records, name), record = await readJson(path, limits.jsonBytes);
      if (!safeRunId(record?.id) || record.agentId !== id || name !== record.id + ".json" || runIds.has(record.id)
        || (record.version !== undefined && (!Number.isSafeInteger(record.version) || record.version < 1))
        || !Number.isSafeInteger(record.revision) || record.revision < 1 || typeof record.status !== "string" || !record.status.trim()
        || typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))
        || typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt))) throw new InputError("研发记录身份或格式无效");
      hashValue(record); runIds.add(record.id);
      await relocateRecord(record, id, { sourceDir, staging, dataDir, signal, checkedSnapshots });
      await writeJson(path, record, limits.jsonBytes, signal);
    }
  }
  const projects = await readJson(join(staging, "projects.json"), Math.min(limits.jsonBytes, 2_000_000));
  if (projects && (projects.version !== 1 || !Array.isArray(projects.projects)
    || projects.projects.some((item) => !item?.id || typeof item.root !== "string" || !isAbsolute(item.root))))
    throw new InputError("项目记录格式无效，迁移已停止");
  const failures = await readJson(join(staging, "project-add-failures.json"), limits.jsonBytes);
  if (failures && (failures.version !== 1 || !Array.isArray(failures.failures) || failures.failures.some((record) =>
    !record || typeof record.id !== "string" || typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))
    || typeof record.name !== "string" || typeof record.path !== "string" || typeof record.message !== "string"
    || typeof record.diagnostic?.stage !== "string" || typeof record.diagnostic.reason !== "string" || !Number.isSafeInteger(record.diagnostic.retries))))
    throw new InputError("项目失败记录格式无效，迁移已停止");
  return ids.length;
}

async function discard(path) {
  const writable = async (current) => {
    await chmod(current, 0o700);
    for (const entry of await readdir(current, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) await writable(join(current, entry.name));
  };
  try { await writable(path); await rm(path, { recursive: true, force: true }); }
  catch (error) { if (!missing(error)) throw error; }
}

async function defaultLock(dataDir) {
  const { acquireDataLock } = await import("./instance-lock.mjs");
  const lock = await acquireDataLock(dataDir, { purpose: "migration" });
  return () => lock.release();
}

/** Copy source data without loading its live stores or copying model credentials. */
export async function migrateInstallation({ from, dataDir, acquireLock = defaultLock, signal,
  maxBytes = MIGRATION_LIMITS.bytes, maxFileBytes = MIGRATION_LIMITS.fileBytes,
  maxJsonBytes = MIGRATION_LIMITS.jsonBytes, maxFiles = MIGRATION_LIMITS.entries } = {}) {
  let sourceDir = await directory(inputPath(from, "来源"));
  try { sourceDir = await directory(join(sourceDir, ".neuma")); }
  catch (error) { if (!missing(error)) throw error; }
  if (basename(sourceDir) !== ".neuma" && !(await readdir(sourceDir)).some((name) => ["agents", "agents.json", "agents-layout.json", "projects.json"].includes(name)))
    throw new InputError("来源目录中没有找到 NEUMA 数据");
  dataDir = await canonicalDestination(inputPath(dataDir, "目标"));
  if (contains(sourceDir, dataDir) || contains(dataDir, sourceDir)) throw new InputError("迁移来源和目标不能相同或互相包含");
  const limits = { bytes: maxBytes, fileBytes: maxFileBytes, jsonBytes: maxJsonBytes, entries: maxFiles };
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1) || typeof acquireLock !== "function")
    throw new InputError("迁移预算或锁接口无效");
  const releases = [];
  let staging;
  try {
    for (const path of [sourceDir, dataDir].sort()) {
      const release = await acquireLock(path);
      if (typeof release !== "function") throw new InputError("迁移锁接口无效");
      releases.push(release);
    }
    const targetEmpty = async () => {
      try {
        await directory(dataDir);
        if ((await readdir(dataDir)).length) throw new InputError("目标数据目录已有内容，迁移不会覆盖或合并，请选择空目录");
        return true;
      } catch (error) { if (missing(error)) return false; throw error; }
    };
    await targetEmpty();
    const original = await inventory(sourceDir, limits, signal);
    await mkdir(dirname(dataDir), { recursive: true, mode: 0o700 });
    staging = join(dirname(dataDir), `.installation-migration-${randomUUID()}`);
    await mkdir(staging, { mode: 0o700 });
    for (const entry of original.entries) {
      abort(signal);
      if (entry.directory) await mkdir(join(staging, entry.name), { mode: 0o700 });
      else await copyFile(join(sourceDir, entry.name), join(staging, entry.name), entry, limits, signal);
    }
    // Preserve readonly snapshot directories after all descendants have been copied.
    for (const entry of original.entries.slice().reverse()) if (entry.directory) await chmod(join(staging, entry.name), entry.mode);
    const agents = await validateAndRelocate({ sourceDir, staging, dataDir, limits, signal });
    const copied = await inventory(staging, limits, signal);
    const current = await inventory(sourceDir, limits, signal);
    if (JSON.stringify(current.entries) !== JSON.stringify(original.entries))
      throw new InputError("旧数据在迁移期间发生变化，请停止旧服务后重试");
    abort(signal);
    if (await targetEmpty()) await rmdir(dataDir);
    await rename(staging, dataDir); staging = null;
    return { sourceDir, dataDir, files: copied.files, bytes: copied.bytes, agents, skipped: original.skipped };
  } finally {
    try { if (staging) await discard(staging); }
    finally { for (const release of releases.reverse()) await release(); }
  }
}
