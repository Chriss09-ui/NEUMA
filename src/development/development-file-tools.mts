import type { ToolDefinition, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { DevelopmentWorkspace, WorkspaceLock } from "./development-workspace.mjs";
import type { UnknownRecord } from "../contracts/json.mjs";
import { objectFields } from "../runtime/type-boundary.mjs";
interface FileToolOptions { root: string; readFile(path: string, options: { signal?: AbortSignal | undefined }): Promise<Buffer>;
  writeFile?: ((path: string, content: string, options: { signal?: AbortSignal | undefined }) => Promise<void>) | undefined;
  validatePath?: (path: unknown) => string; readOnly?: boolean; signal?: AbortSignal | undefined; check?: () => Promise<unknown>; lock?: WorkspaceLock }
import { join, relative, resolve } from "node:path";
import { InputError } from "../requirements/core.mjs";
import { validateCodePath } from "./development-workspace.mjs";

const abort = (...signals: (AbortSignal | undefined)[]) => { for (const signal of signals) signal?.throwIfAborted(); };

/** Pi supplies file rendering and exact edits; the host supplies every filesystem operation. */
export async function restrictedNativeFileTools({ root, readFile, writeFile, validatePath = validateCodePath,
  readOnly = false, signal, check = async () => {}, lock }: FileToolOptions) {
  const { createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, defineTool } = await import("@earendil-works/pi-coding-agent");
  let activeSignal: AbortSignal | undefined, pending: Promise<unknown> = Promise.resolve();
  const serial: WorkspaceLock = lock ?? ((operation) => {
    const next = pending.then(operation); pending = next.catch(() => {}); return next;
  });
  const file = (absolute: string) => {
    const path = relative(root, resolve(absolute));
    validatePath(path);
    return path;
  };
  const read = async (absolute: string) => readFile(file(absolute), { signal: activeSignal });
  const definitions: ToolDefinition[] = [defineTool(createReadToolDefinition(root, { operations: {
    readFile: read, access: async (absolute) => { await read(absolute); }, detectImageMimeType: async () => null,
  } }))];
  if (!readOnly) {
    const write = async (absolute: string, content: string) => writeFile!(file(absolute), content, { signal: activeSignal });
    definitions.push(defineTool(createWriteToolDefinition(root, { operations: {
      writeFile: write,
      // The atomic host writer creates checked parents. Pi must never create directories itself.
      mkdir: async () => {},
    } })), defineTool(createEditToolDefinition(root, { operations: {
      readFile: read, writeFile: write, access: async (absolute) => { await read(absolute); },
    } })));
  }
  return definitions.map((definition): ToolDefinition => ({ ...definition, executionMode: "sequential",
    description: `${definition.description}\nOnly relative paths in the authorized workspace are accepted. No shell access.`,
    execute: async (id, parameters, toolSignal, onUpdate, context) => serial(async () => {
      abort(signal, toolSignal); await check();
      activeSignal = signal && toolSignal ? AbortSignal.any([signal, toolSignal]) : signal ?? toolSignal;
      const fields = objectFields(parameters);
      const path = validatePath(fields.path);
      const result = await definition.execute(id, { ...fields, path: join(root, path) }, toolSignal, onUpdate,
        { ...context, cwd: root });
      abort(signal, toolSignal); await check();
      return result;
    }),
  }));
}

export async function createDevelopmentFileTools(workspace: Pick<DevelopmentWorkspace, "create" | "makeTools" | "serial" | "tools">, agentId: string, runId: string, {
  readOnly = false, allowedFiles = [], signal,
}: { readOnly?: boolean; allowedFiles?: string[]; signal?: AbortSignal | undefined } = {}) {
  if (!Array.isArray(allowedFiles)) throw new InputError("任务文件授权必须是明确文件列表");
  const allowed = new Set(allowedFiles.map(validateCodePath));
  const root = await workspace.create(agentId, runId);
  const raw = workspace.makeTools(root, { readOnly, allowed, signal });
  const invoke = async (name: string, parameters: UnknownRecord, toolSignal?: AbortSignal): Promise<UnknownRecord> => {
    const result = await raw.find((tool) => tool.name === name)!.execute("native-file-operation", parameters, toolSignal);
    const content = result.content[0];
    if (content?.type !== "text") throw new InputError("代码文件工具没有返回文本");
    return objectFields(JSON.parse(content.text));
  };
  const native = await restrictedNativeFileTools({ root, signal, readOnly,
    lock: (operation) => workspace.serial(agentId, runId, operation),
    readFile: async (path, { signal: toolSignal }) => {
      let text = "", offset: number | null = 0;
      do {
        const page = await invoke("read_code_file", { path, offset, limit: 100000 }, toolSignal);
        if (typeof page.content !== "string" || page.nextOffset !== null && typeof page.nextOffset !== "number") throw new InputError("代码分页回执无效");
        text += page.content; offset = page.nextOffset;
      } while (offset !== null);
      return Buffer.from(text, "utf8");
    },
    writeFile: async (path, content, { signal: toolSignal }) => { await invoke("write_code_file", { path, content }, toolSignal); },
  });
  // Character paging remains available when Pi's line-based reader meets an oversized line.
  return [...native, ...(await workspace.tools(agentId, runId, { readOnly: true, signal }))];
}
