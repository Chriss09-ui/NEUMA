import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { InputError } from "../requirements/core.mjs";
import { safeRelativePath } from "./development-contract.mjs";
import { AgentStorage } from "../agents/agent-storage.mjs";

export const DEVELOPMENT_LIMITS = Object.freeze({ fileBytes: 2 * 1024 * 1024, totalBytes: 10 * 1024 * 1024, files: 200 });
const digest = (value) => createHash("sha256").update(value).digest("hex");
const forbidden = /^(?:\..*|metadata|node_modules|credentials?(?:\..*)?|secrets?(?:\..*)?|auth(?:\..*)?|tokens?(?:\..*)?|passwords?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore))$/i;
const schema = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const pathSchema = { type: "string", minLength: 1, maxLength: 500, description: "代码根目录内的相对文件路径" };
const checkAbort = (...signals) => { for (const signal of signals) signal?.throwIfAborted(); };

export function validateCodePath(value) {
  safeRelativePath(value);
  if (typeof value !== "string" || !value || value.length > 500 || isAbsolute(value)
    || value.includes("\\") || /[\x00-\x1f\x7f]/.test(value)
    || value.split("/").some((part) => !part || part === ".." || part === "." || forbidden.test(part)))
    throw new InputError("代码路径无效；不允许绝对路径、凭据、隐藏文件或元数据目录");
  return value;
}

async function safeDirectory(path, create = false) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new InputError("代码目录不能是符号链接");
  return realpath(path);
}

async function target(root, file, createParents = false) {
  validateCodePath(file);
  await safeDirectory(root);
  let current = root;
  const parts = file.split("/");
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (index === parts.length - 1) return current;
      if (!createParents) throw new InputError("代码文件不存在");
      await mkdir(current, { mode: 0o700 });
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())
      || (index === parts.length - 1 && (!info.isFile() || info.nlink !== 1)))
      throw new InputError("代码只允许普通文件；符号链接和硬链接不可访问");
  }
  return current;
}

async function readBytes(root, file) {
  const handle = await open(await target(root, file), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > DEVELOPMENT_LIMITS.fileBytes) throw new InputError("代码文件超出 2 MB 限制或类型无效");
    const value = await handle.readFile();
    if (value.length > DEVELOPMENT_LIMITS.fileBytes) throw new InputError("代码文件超出 2 MB 限制");
    return value;
  } finally { await handle.close(); }
}

/** The same manifest calculation binds tool snapshots and executor evidence. */
export async function inspectDevelopmentCode(root) {
  root = await safeDirectory(root);
  const files = [], contents = new Map();
  let total = 0;
  const walk = async (directory, prefix = "") => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const file = prefix + entry.name;
      validateCodePath(file);
      if (entry.isSymbolicLink()) throw new InputError("代码目录包含符号链接");
      if (entry.isDirectory()) { await walk(join(directory, entry.name), file + "/"); continue; }
      if (!entry.isFile()) throw new InputError("代码目录包含非普通文件");
      const bytes = await readBytes(root, file);
      total += bytes.length;
      if (files.length >= DEVELOPMENT_LIMITS.files || total > DEVELOPMENT_LIMITS.totalBytes) throw new InputError("代码超过 200 个文件或 10 MB 总量限制");
      files.push({ path: file, hash: digest(bytes), size: bytes.length }); contents.set(file, bytes);
    }
  };
  await walk(root);
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { path: root, hash: digest(JSON.stringify(files)), files, contents };
}

export class DevelopmentWorkspace {
  constructor({ dataDir, storage }) {
    if (!dataDir) throw new InputError("缺少研发存储目录");
    this.storage = storage ?? new AgentStorage({ dataDir }); this.operations = new Map();
  }

  async workspacePath(agentId, runId) {
    if (typeof runId !== "string" || !/^[a-zA-Z0-9][\w-]{0,99}$/.test(runId)) throw new InputError("研发批次标识无效");
    const run = await this.storage.directory(agentId, `development/workspaces/${runId}`, { create: true });
    const code = join(run, "code");
    try { await safeDirectory(code); } catch (error) { if (error.code !== "ENOENT") throw error; }
    return code;
  }

  async create(agentId, runId) { const path = await this.workspacePath(agentId, runId); await safeDirectory(path, true); return path; }

  serial(agentId, runId, operation) {
    const key = `${agentId}/${runId}`;
    const pending = (this.operations.get(key) ?? Promise.resolve()).then(operation);
    const settled = pending.catch(() => {}); this.operations.set(key, settled);
    settled.finally(() => { if (this.operations.get(key) === settled) this.operations.delete(key); });
    return pending;
  }

  async tools(agentId, runId, { readOnly = false, allowedFiles = [], signal } = {}) {
    const root = await this.create(agentId, runId);
    if (!Array.isArray(allowedFiles)) throw new InputError("任务文件授权必须是明确文件列表");
    const allowed = new Set(allowedFiles.map(validateCodePath));
    return this.makeTools(root, { signal, readOnly, allowed, lock: (fn) => this.serial(agentId, runId, fn) });
  }

  makeTools(root, { signal, readOnly = true, allowed = new Set(), lock = (fn) => fn(), check = async () => {} } = {}) {
    const tool = (name, label, parameters, action) => ({ name, label, description: label, parameters, executionMode: "sequential",
      execute: async (_id, params, toolSignal) => lock(async () => {
        checkAbort(signal, toolSignal); await check();
        const value = await action(params ?? {}, () => checkAbort(signal, toolSignal));
        checkAbort(signal, toolSignal);
        return { content: [{ type: "text", text: JSON.stringify(value) }], details: {} };
      }) });
    const tools = [
      tool("list_code_files", "列出当前代码文件", schema({}), async () => ({ files: (await inspectDevelopmentCode(root)).files.map(({ path, size }) => ({ path, size })) })),
      tool("read_code_file", "读取当前代码文件", schema({ path: pathSchema, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100000 } }, ["path"]), async ({ path, offset = 0, limit = 24000 }) => {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100000) throw new InputError("代码读取范围无效");
        let content;
        try { content = new TextDecoder("utf-8", { fatal: true }).decode(await readBytes(root, path)); }
        catch (error) { if (error instanceof TypeError) throw new InputError("代码文件必须是 UTF-8 文本"); throw error; }
        if (content.includes("\0")) throw new InputError("代码文件必须是文本");
        const end = Math.min(content.length, offset + limit);
        return { path, content: content.slice(offset, end), truncated: end < content.length, nextOffset: end < content.length ? end : null };
      }),
    ];
    if (!readOnly) tools.push(tool("write_code_file", "保存当前任务授权的代码文件", schema({ path: pathSchema, content: { type: "string", maxLength: DEVELOPMENT_LIMITS.fileBytes } }), async ({ path, content }, abort) => {
      validateCodePath(path);
      if (!allowed.has(path)) throw new InputError("当前任务没有该文件的写入授权");
      if (typeof content !== "string" || content.includes("\0") || Buffer.byteLength(content) > DEVELOPMENT_LIMITS.fileBytes) throw new InputError("代码文本不得超过 2 MB");
      const current = await inspectDevelopmentCode(root), previous = current.files.find((file) => file.path === path);
      if ((!previous && current.files.length >= DEVELOPMENT_LIMITS.files)
        || current.files.reduce((sum, file) => sum + file.size, 0) - (previous?.size ?? 0) + Buffer.byteLength(content) > DEVELOPMENT_LIMITS.totalBytes)
        throw new InputError("代码超过 200 个文件或 10 MB 总量限制");
      const destination = await target(root, path, true);
      const temporary = join(dirname(destination), ".write-" + randomUUID());
      try {
        await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
        abort(); await target(root, path); abort();
        await rename(temporary, destination);
      } finally { await rm(temporary, { force: true }); }
      return { path, size: Buffer.byteLength(content), hash: digest(content), written: true };
    }));
    return tools;
  }

  async snapshot(agentId, runId) {
    return this.serial(agentId, runId, async () => {
      const source = await inspectDevelopmentCode(await this.create(agentId, runId));
      const snapshots = await this.storage.directory(agentId, "development/snapshots", { create: true });
      const destination = join(snapshots, source.hash);
      try {
        const existing = await inspectDevelopmentCode(destination);
        if (existing.hash !== source.hash) throw new InputError("已有代码快照校验失败");
        return { agentId, path: destination, hash: source.hash, files: source.files };
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      const temporary = join(snapshots, "pending-" + randomUUID()); await mkdir(temporary, { mode: 0o700 });
      try {
        for (const file of source.files) {
          const path = join(temporary, file.path); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          await writeFile(path, source.contents.get(file.path), { flag: "wx", mode: 0o444 });
        }
        const seal = async (path) => { for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await seal(join(path, entry.name)); await chmod(path, 0o555); };
        await seal(temporary);
        try { await rename(temporary, destination); }
        catch (error) {
          if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
          if ((await inspectDevelopmentCode(destination)).hash !== source.hash) throw new InputError("并发快照校验失败");
        }
      } finally {
        const unseal = async (path) => { await chmod(path, 0o700); for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await unseal(join(path, entry.name)); };
        try { await unseal(temporary); await rm(temporary, { recursive: true, force: true }); } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      return { agentId, path: destination, hash: source.hash, files: source.files };
    });
  }

  async validateSnapshot(snapshot, agentId = snapshot?.agentId) {
    if (!snapshot || !/^[a-f0-9]{64}$/.test(snapshot.hash) || typeof snapshot.path !== "string" || !Array.isArray(snapshot.files))
      throw new InputError("代码快照标识无效");
    if (snapshot.agentId !== agentId) throw new InputError("代码快照不属于当前 Agent");
    const snapshots = await this.storage.directory(agentId, "development/snapshots");
    const root = join(snapshots, snapshot.hash);
    if (relative(root, resolve(snapshot.path)) !== "") throw new InputError("代码快照不属于当前研发存储");
    const actual = await inspectDevelopmentCode(root);
    if (actual.hash !== snapshot.hash || JSON.stringify(actual.files) !== JSON.stringify(snapshot.files))
      throw new InputError("代码快照内容已改变，不能作为评审证据");
    return { agentId, hash: actual.hash, files: actual.files, path: actual.path };
  }

  async snapshotTools(snapshot, agentId = snapshot?.agentId) {
    const checked = await this.validateSnapshot(snapshot, agentId);
    return this.makeTools(checked.path, { readOnly: true, check: () => this.validateSnapshot(snapshot, agentId) });
  }
}
