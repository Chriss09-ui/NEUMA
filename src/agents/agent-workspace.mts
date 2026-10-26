import type { ToolSchema } from "../contracts/tools.mjs";
import type { UnknownRecord } from "../contracts/json.mjs";
import type { NeumaTool } from "../runtime/execution-port.mjs";
import { objectFields, isInteger, errorField } from "../runtime/type-boundary.mjs";
import { MAX_RUNTIME_FILE_BYTES } from "../runtime/file-limits.mjs";
import { WORKSPACE_TEXT_WRITE_CODE_UNITS, WORKSPACE_TEXT_READ_CODE_UNITS, WORKSPACE_LIST_PAGE_ITEMS } from "../runtime/runtime-capability-contract.mjs";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { InputError } from "../requirements/core.mjs";

export const forbiddenName = /^(?:\..*|node_modules|venv|__pycache__|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*(?:secret|credential|token|password|api[_-]?key|access[_-]?key|private[_-]?key).*|.*\.(?:pem|key|p12|pfx))$/i;
const schema = (properties: Record<string, ToolSchema>, required: string[] = []): ToolSchema => ({ type: "object", properties, required, additionalProperties: false });
const pathParameter = { type: "string", minLength: 1, maxLength: 1000, description: "专属工作目录内的相对路径" };
const offsetParameter = { type: "integer", minimum: 0, description: "分批读取时使用 nextOffset，默认 0" };

export function safeText(source: string) {
  return source.replace(/(\b(?:[\w-]*(?:api[_-]?key|token|secret|password|passwd|authorization)[\w-]*)["']?\s*[:=]\s*)(?:"(?:\\[\s\S]|[^"\\])*"|'[^']*'|[^\r\n,;]+)/gi, "$1[已隐藏]")
    .replace(/Bearer\s+[\w.+\/-]+/gi, "Bearer [已隐藏]")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[已隐藏私钥]");
}

async function directory(path: string) {
  try {
    await mkdir(path);
  } catch (error) { if (errorField(error, "code") !== "EEXIST") throw error; }
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new InputError("Agent 工作目录不能是符号链接或文件");
  return path;
}

export function workspaceTarget(root: string) {
  return async (value: unknown = ".", { createParents = false } = {}) => {
    if (typeof value !== "string" || !value || value.length > 1000 || value.includes("\0") || value.includes("\\") || isAbsolute(value)) throw new InputError("请使用工作目录内的相对路径");
    const parts = value.split("/").filter((part) => part !== "." && part !== "");
    if (parts.some((part) => part === ".." || forbiddenName.test(part))) throw new InputError("不能访问目录外部、隐藏文件或凭据");
    const path = resolve(root, ...parts), suffix = relative(root, path);
    if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) throw new InputError("只能访问当前 Agent 工作目录");
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || await realpath(root) !== root) throw new InputError("Agent 工作目录无效");
    let current = root;
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]!);
      let info;
      try { info = await lstat(current); }
      catch (error) {
        if (errorField(error, "code") !== "ENOENT") throw error;
        if (createParents && index < parts.length - 1) { await directory(current); continue; }
        if (createParents && index === parts.length - 1) return path;
        throw new InputError("没有找到工作目录内的文件或目录");
      }
      if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1)) throw new InputError("工作目录中的链接不可访问");
      if (index < parts.length - 1 && !info.isDirectory()) throw new InputError("文件所在目录无效");
    }
    return path;
  };
}

export async function readWorkspaceBytes(root: string, file: unknown, { signal }: { signal?: AbortSignal | undefined } = {}) {
  signal?.throwIfAborted();
  const handle = await open(await workspaceTarget(root)(file), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_RUNTIME_FILE_BYTES) throw new InputError("只支持读取不超过 20 MiB 的普通文本文件");
    const source = await handle.readFile();
    signal?.throwIfAborted();
    if (source.length > MAX_RUNTIME_FILE_BYTES) throw new InputError("只支持读取不超过 20 MiB 的普通文本文件");
    return source;
  } finally { await handle.close(); }
}

export async function readWorkspaceText(root: string, file: unknown, { start = 0, limit = WORKSPACE_TEXT_READ_CODE_UNITS }: { start?: number; limit?: number } = {}) {
  const source = await readWorkspaceBytes(root, file);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(source); }
  catch { throw new InputError("只支持读取 UTF-8 文本文件"); }
  const integrity = { sha256: createHash("sha256").update(source).digest("hex"), bytes: source.length, utf16Units: source.toString("utf8").length, redacted: safeText(text) !== text };
  text = safeText(text);
  let end = Math.min(start + limit, text.length);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
  return { file, text: text.slice(start, end), truncated: end < text.length, nextOffset: end < text.length ? end : null, integrity };
}

export function createWorkspaceTools(root: string, { guardWrite = async () => {} }: { guardWrite?: (file: unknown) => Promise<void> } = {}): NeumaTool[] {
  const target = workspaceTarget(root);
  const tool = (name: string, label: string, parameters: ToolSchema, action: (params: UnknownRecord, signal?: AbortSignal) => Promise<unknown>): NeumaTool => ({ name, label, description: label, parameters, executionMode: "sequential",
    execute: async (_id, params, signal) => {
      signal?.throwIfAborted();
      try {
        const result = await action(objectFields(params), signal);
        signal?.throwIfAborted();
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
      } catch (error) {
        if (signal?.aborted) signal.throwIfAborted();
        if (error instanceof InputError) throw error;
        throw new InputError("工作目录文件操作未完成，请检查路径后重试");
      }
    } });
  const offset = (value: unknown = 0): number => {
    if (!isInteger(value) || value < 0) throw new InputError("续读位置无效");
    return value;
  };
  return [
    tool("list_workspace_files", "正在查看任务文件…", schema({ directory: pathParameter, offset: offsetParameter }), async ({ directory: value = ".", offset: start = 0 }) => {
      const path = await target(value), info = await lstat(path);
      if (!info.isDirectory()) throw new InputError("请指定工作目录内的文件夹");
      const entries = (await readdir(path, { withFileTypes: true })).filter((entry) => !entry.isSymbolicLink() && !forbiddenName.test(entry.name)
        && (entry.isDirectory() || entry.isFile())).sort((a, b) => a.name.localeCompare(b.name));
      const end = Math.min(offset(start) + WORKSPACE_LIST_PAGE_ITEMS, entries.length);
      return { directory: value, files: entries.slice(offset(start), end).map((entry) => ({ name: entry.name, directory: entry.isDirectory() })),
        truncated: end < entries.length, nextOffset: end < entries.length ? end : null };
    }),
    tool("read_workspace_file", "正在阅读任务材料…", schema({ file: pathParameter, offset: offsetParameter }, ["file"]), async ({ file, offset: start = 0 }) => {
      return readWorkspaceText(root, file, { start: offset(start) });
    }),
    tool("write_workspace_file", "正在保存任务产物…", schema({ file: pathParameter, content: { type: "string", maxLength: WORKSPACE_TEXT_WRITE_CODE_UNITS, description: "要保存的完整文本内容，存在时替换" } }, ["file", "content"]), async ({ file, content }, signal) => {
      if (typeof content !== "string" || content.length > WORKSPACE_TEXT_WRITE_CODE_UNITS) throw new InputError("只能保存不超过 120000 字的文本文件");
      await guardWrite(file);
      const path = await target(file, { createParents: true });
      if (path === root) throw new InputError("请指定产物的文件名");
      const temporary = `${path}.${randomUUID()}.tmp`;
      let handle;
      try {
        handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        await handle.writeFile(content, "utf8"); await handle.close(); handle = null;
        signal?.throwIfAborted(); await guardWrite(file); await target(file, { createParents: true });
        await rename(temporary, path);
      } finally { await handle?.close(); await rm(temporary, { force: true }).catch(() => {}); }
      return { saved: true, file, characters: content.length, integrity: { sha256: createHash("sha256").update(content, "utf8").digest("hex"), bytes: Buffer.byteLength(content, "utf8"), utf16Units: content.length } };
    }),
  ];
}
