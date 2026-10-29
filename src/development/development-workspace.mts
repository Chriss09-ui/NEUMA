import type { BinaryLike } from "node:crypto";
import type { ToolSchema } from "../contracts/tools.mjs";
import type { UnknownRecord } from "../contracts/json.mjs";
import type { NeumaTool } from "../runtime/execution-port.mjs";
import { objectFields, isInteger, errorField } from "../runtime/type-boundary.mjs";
export type DevelopmentSnapshot = { agentId: string; path: string; hash: string; files: { path: string; hash: string; size: number }[] }
interface WorkspaceOptions { signal?: AbortSignal | undefined; readOnly?: boolean; allowedFiles?: string[] }
export type WorkspaceLock = <T>(operation: () => Promise<T>) => Promise<T>;
interface MakeToolsOptions { signal?: AbortSignal | undefined; readOnly?: boolean; allowed?: Set<string>; lock?: WorkspaceLock; check?: () => Promise<unknown> }
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, opendir, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { InputError } from "../requirements/core.mjs";
import { safeRelativePath } from "./development-contract.mjs";
import { AgentStorage } from "../agents/agent-storage.mjs";
import { MAX_RUNTIME_FILE_BYTES } from "../runtime/file-limits.mjs";

export const DEVELOPMENT_LIMITS = Object.freeze({ fileBytes: 2 * 1024 * 1024, totalBytes: 10 * 1024 * 1024, files: 200 });
const digest = (value: BinaryLike) => createHash("sha256").update(value).digest("hex");
const forbidden = /^(?:\..*|metadata|node_modules|credentials?(?:\..*)?|secrets?(?:\..*)?|auth(?:\..*)?|tokens?(?:\..*)?|passwords?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore))$/i;
const schema = (properties: Record<string, ToolSchema>, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const pathSchema = { type: "string", minLength: 1, maxLength: 500, description: "代码根目录内的相对文件路径" };
const checkAbort = (...signals: (AbortSignal | undefined)[]) => { for (const signal of signals) signal?.throwIfAborted(); };

export function validateCodePath(value: unknown) {
  safeRelativePath(value);
  if (typeof value !== "string" || !value || value.length > 500 || isAbsolute(value)
    || value.includes("\\") || /[\x00-\x1f\x7f]/.test(value)
    || value.split("/").some((part) => !part || part === ".." || part === "." || forbidden.test(part)))
    throw new InputError("代码路径无效；不允许绝对路径、凭据、隐藏文件或元数据目录");
  return value;
}

async function safeDirectory(path: string, create = false) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new InputError("代码目录不能是符号链接");
  return realpath(path);
}

async function target(root: string, file: string, createParents = false) {
  validateCodePath(file);
  await safeDirectory(root);
  let current = root;
  const parts = file.split("/");
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (errorField(error, "code") !== "ENOENT") throw error;
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

async function readBytes(root: string, file: string) {
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
export async function inspectDevelopmentCode(root: string) {
  root = await safeDirectory(root);
  const files: DevelopmentSnapshot["files"] = [], contents = new Map<string, Buffer>();
  let total = 0;
  const walk = async (directory: string, prefix = ""): Promise<void> => {
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

export async function validateRuntimeWorkspace(root: string, { signal }: { signal?: AbortSignal | undefined } = {}) {
  root = await safeDirectory(root);
  const walk = async (directory: string, prefix = ""): Promise<void> => {
    for await (const entry of await opendir(directory)) {
      signal?.throwIfAborted();
      const file = prefix + entry.name;
      validateCodePath(file);
      const path = join(root, file), info = await lstat(path);
      if (info.isSymbolicLink()) throw new InputError("运行目录包含符号链接");
      if (info.isDirectory()) { await walk(path, file + "/"); continue; }
      if (!info.isFile() || info.nlink !== 1) throw new InputError("运行目录只允许普通文件，不能包含硬链接");
      if (info.size > MAX_RUNTIME_FILE_BYTES) throw Object.assign(new InputError("运行文件不能超过 20 MiB"), { reason: "workspace_file_too_large" });
    }
  };
  await walk(root);
}

export class DevelopmentWorkspace {
  storage: Pick<AgentStorage, "directory">;
  operations: Map<string, Promise<unknown>>;
  constructor({ dataDir, storage }: { dataDir: string; storage?: Pick<AgentStorage, "directory"> }) {
    if (!dataDir) throw new InputError("缺少研发存储目录");
    this.storage = storage ?? new AgentStorage({ dataDir }); this.operations = new Map();
  }

  async workspacePath(agentId: string, runId: string) {
    if (typeof runId !== "string" || !/^[a-zA-Z0-9][\w-]{0,99}$/.test(runId)) throw new InputError("研发批次标识无效");
    const run = await this.storage.directory(agentId, `development/workspaces/${runId}`, { create: true });
    const code = join(run, "code");
    try { await safeDirectory(code); } catch (error) { if (errorField(error, "code") !== "ENOENT") throw error; }
    return code;
  }

  async create(agentId: string, runId: string) { const path = await this.workspacePath(agentId, runId); await safeDirectory(path, true); return path; }

  serial<T>(agentId: string, runId: string, operation: () => Promise<T>): Promise<T> {
    const key = `${agentId}/${runId}`;
    const pending = (this.operations.get(key) ?? Promise.resolve()).then(operation);
    const settled = pending.catch(() => {}); this.operations.set(key, settled);
    settled.finally(() => { if (this.operations.get(key) === settled) this.operations.delete(key); });
    return pending;
  }

  async tools(agentId: string, runId: string, { readOnly = false, allowedFiles = [], signal }: WorkspaceOptions = {}) {
    const root = await this.create(agentId, runId);
    if (!Array.isArray(allowedFiles)) throw new InputError("任务文件授权必须是明确文件列表");
    const allowed = new Set(allowedFiles.map(validateCodePath));
    return this.makeTools(root, { signal, readOnly, allowed, lock: (fn) => this.serial(agentId, runId, fn) });
  }

  makeTools(root: string, { signal, readOnly = true, allowed = new Set<string>(), lock = (fn) => fn(), check = async () => {} }: MakeToolsOptions = {}): NeumaTool[] {
    const tool = (name: string, label: string, parameters: ToolSchema, action: (params: UnknownRecord, abort: () => void) => Promise<unknown>): NeumaTool => ({ name, label, description: label, parameters, executionMode: "sequential",
      execute: async (_id, params, toolSignal) => lock(async () => {
        checkAbort(signal, toolSignal); await check();
        const value = await action(objectFields(params), () => checkAbort(signal, toolSignal));
        checkAbort(signal, toolSignal);
        return { content: [{ type: "text", text: JSON.stringify(value) }], details: {} };
      }) });
    const tools = [
      tool("list_code_files", "列出当前代码文件", schema({}), async () => ({ files: (await inspectDevelopmentCode(root)).files.map(({ path, size }) => ({ path, size })) })),
      tool("read_code_file", "读取当前代码文件", schema({ path: pathSchema, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100000 } }, ["path"]), async ({ path, offset = 0, limit = 24000 }) => {
        if (!isInteger(offset) || offset < 0 || !isInteger(limit) || limit < 1 || limit > 100000) throw new InputError("代码读取范围无效");
        let content;
        try { content = new TextDecoder("utf-8", { fatal: true }).decode(await readBytes(root, validateCodePath(path))); }
        catch (error) { if (error instanceof TypeError) throw new InputError("代码文件必须是 UTF-8 文本"); throw error; }
        if (content.includes("\0")) throw new InputError("代码文件必须是文本");
        const end = Math.min(content.length, offset + limit);
        return { path, content: content.slice(offset, end), truncated: end < content.length, nextOffset: end < content.length ? end : null };
      }),
    ];
    if (!readOnly) tools.push(tool("write_code_file", "保存当前任务授权的代码文件", schema({ path: pathSchema, content: { type: "string", maxLength: DEVELOPMENT_LIMITS.fileBytes } }), async ({ path, content }, abort) => {
      validateCodePath(path);
      if (!allowed.has(validateCodePath(path))) throw new InputError("当前任务没有该文件的写入授权");
      if (typeof content !== "string" || content.includes("\0") || Buffer.byteLength(content) > DEVELOPMENT_LIMITS.fileBytes) throw new InputError("代码文本不得超过 2 MB");
      const current = await inspectDevelopmentCode(root), previous = current.files.find((file) => file.path === path);
      if ((!previous && current.files.length >= DEVELOPMENT_LIMITS.files)
        || current.files.reduce((sum, file) => sum + file.size, 0) - (previous?.size ?? 0) + Buffer.byteLength(content) > DEVELOPMENT_LIMITS.totalBytes)
        throw new InputError("代码超过 200 个文件或 10 MB 总量限制");
      const destination = await target(root, validateCodePath(path), true);
      const temporary = join(dirname(destination), ".write-" + randomUUID());
      try {
        await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
        abort(); await target(root, validateCodePath(path)); abort();
        await rename(temporary, destination);
      } finally { await rm(temporary, { force: true }); }
      return { path, size: Buffer.byteLength(content), hash: digest(content), written: true };
    }));
    return tools;
  }

  async snapshot(agentId: string, runId: string) {
    return this.serial(agentId, runId, async () => {
      const source = await inspectDevelopmentCode(await this.create(agentId, runId));
      const snapshots = await this.storage.directory(agentId, "development/snapshots", { create: true });
      const destination = join(snapshots, source.hash);
      try {
        const existing = await inspectDevelopmentCode(destination);
        if (existing.hash !== source.hash) throw new InputError("已有代码快照校验失败");
        return { agentId, path: destination, hash: source.hash, files: source.files };
      } catch (error) { if (errorField(error, "code") !== "ENOENT") throw error; }
      const temporary = join(snapshots, "pending-" + randomUUID()); await mkdir(temporary, { mode: 0o700 });
      try {
        for (const file of source.files) {
          const path = join(temporary, file.path); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          await writeFile(path, source.contents.get(file.path)!, { flag: "wx", mode: 0o444 });
        }
        const seal = async (path: string): Promise<void> => { for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await seal(join(path, entry.name)); await chmod(path, 0o555); };
        await seal(temporary);
        try { await rename(temporary, destination); }
        catch (error) {
          if (!["EEXIST", "ENOTEMPTY"].includes(String(errorField(error, "code")))) throw error;
          if ((await inspectDevelopmentCode(destination)).hash !== source.hash) throw new InputError("并发快照校验失败");
        }
      } finally {
        const unseal = async (path: string): Promise<void> => { await chmod(path, 0o700); for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await unseal(join(path, entry.name)); };
        try { await unseal(temporary); await rm(temporary, { recursive: true, force: true }); } catch (error) { if (errorField(error, "code") !== "ENOENT") throw error; }
      }
      return { agentId, path: destination, hash: source.hash, files: source.files };
    });
  }

  async validateSnapshot(input: unknown, agentId = objectFields(input).agentId): Promise<DevelopmentSnapshot> {
    const snapshot = objectFields(input);
    if (!snapshot || typeof snapshot.hash !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.hash) || typeof snapshot.path !== "string" || !Array.isArray(snapshot.files))
      throw new InputError("代码快照标识无效");
    if (typeof agentId !== "string" || snapshot.agentId !== agentId) throw new InputError("代码快照不属于当前 Agent");
    const snapshots = await this.storage.directory(agentId, "development/snapshots");
    const root = join(snapshots, snapshot.hash);
    if (relative(root, resolve(snapshot.path)) !== "") throw new InputError("代码快照不属于当前研发存储");
    const actual = await inspectDevelopmentCode(root);
    if (actual.hash !== snapshot.hash || JSON.stringify(actual.files) !== JSON.stringify(snapshot.files))
      throw new InputError("代码快照内容已改变，不能作为评审证据");
    return { agentId, hash: actual.hash, files: actual.files, path: actual.path };
  }

  async snapshotTools(snapshot: DevelopmentSnapshot, agentId = snapshot?.agentId) {
    const checked = await this.validateSnapshot(snapshot, agentId);
    return this.makeTools(checked.path, { readOnly: true, check: () => this.validateSnapshot(snapshot, agentId) });
  }

  async applyRepair(agentId: string, runId: string, snapshot: DevelopmentSnapshot, files: Record<string, string>, allowedFiles: string[], signal?: AbortSignal) {
    const original = await inspectDevelopmentCode((await this.validateSnapshot(snapshot, agentId)).path);
    await this.serial(agentId, runId, async () => {
      checkAbort(signal);
      const root = await this.workspacePath(agentId, runId), current = await inspectDevelopmentCode(root);
      const allowed = new Set(allowedFiles.map(validateCodePath));
      for (const file of new Set([...current.contents.keys(), ...original.contents.keys(), ...Object.keys(files)])) {
        const before = original.contents.get(file)?.toString("utf8"), actual = current.contents.get(file)?.toString("utf8"), desired = files[file];
        if (typeof desired !== "string" || (!allowed.has(file) && desired !== before)
          || actual !== before && actual !== desired) throw new InputError("代码在修复期间发生冲突；保留子任务成果，请检查当前版本。");
      }
      const writer = this.makeTools(root, { allowed, readOnly: false, signal }).find(tool => tool.name === "write_code_file")!;
      for (const file of allowed) if (files[file] !== undefined && files[file] !== current.contents.get(file)?.toString("utf8"))
        await writer.execute("repair", { path: file, content: files[file] }, signal);
    });
    return this.snapshot(agentId, runId);
  }
}
