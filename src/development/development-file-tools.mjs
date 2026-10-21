import { join, relative, resolve } from "node:path";
import { InputError } from "../requirements/core.mjs";
import { validateCodePath } from "./development-workspace.mjs";

const abort = (...signals) => { for (const signal of signals) signal?.throwIfAborted(); };

/** Pi supplies file rendering and exact edits; the host supplies every filesystem operation. */
export async function restrictedNativeFileTools({ root, readFile, writeFile, validatePath = validateCodePath,
  readOnly = false, signal, check = async () => {}, lock }) {
  const { createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition } = await import("@earendil-works/pi-coding-agent");
  let activeSignal, pending = Promise.resolve();
  const serial = lock ?? ((operation) => {
    const next = pending.then(operation); pending = next.catch(() => {}); return next;
  });
  const file = (absolute) => {
    const path = relative(root, resolve(absolute));
    validatePath(path);
    return path;
  };
  const read = async (absolute) => readFile(file(absolute), { signal: activeSignal });
  const definitions = [createReadToolDefinition(root, { operations: {
    readFile: read, access: async (absolute) => { await read(absolute); }, detectImageMimeType: async () => null,
  } })];
  if (!readOnly) {
    const write = async (absolute, content) => writeFile(file(absolute), content, { signal: activeSignal });
    definitions.push(createWriteToolDefinition(root, { operations: {
      writeFile: write,
      // The atomic host writer creates checked parents. Pi must never create directories itself.
      mkdir: async () => {},
    } }), createEditToolDefinition(root, { operations: {
      readFile: read, writeFile: write, access: async (absolute) => { await read(absolute); },
    } }));
  }
  return definitions.map((definition) => ({ ...definition, executionMode: "sequential",
    description: `${definition.description}\nOnly relative paths in the authorized workspace are accepted. No shell access.`,
    execute: async (id, parameters, toolSignal, onUpdate, context) => serial(async () => {
      abort(signal, toolSignal); await check();
      activeSignal = signal && toolSignal ? AbortSignal.any([signal, toolSignal]) : signal ?? toolSignal;
      const path = validatePath(parameters?.path);
      const result = await definition.execute(id, { ...parameters, path: join(root, path) }, toolSignal, onUpdate,
        { ...context, cwd: root });
      abort(signal, toolSignal); await check();
      return result;
    }),
  }));
}

export async function createDevelopmentFileTools(workspace, agentId, runId, {
  readOnly = false, allowedFiles = [], signal,
} = {}) {
  if (!Array.isArray(allowedFiles)) throw new InputError("任务文件授权必须是明确文件列表");
  const allowed = new Set(allowedFiles.map(validateCodePath));
  const root = await workspace.create(agentId, runId);
  const raw = workspace.makeTools(root, { readOnly, allowed, signal });
  const invoke = async (name, parameters, toolSignal) => JSON.parse((await raw.find((tool) => tool.name === name)
    .execute("native-file-operation", parameters, toolSignal)).content[0].text);
  const native = await restrictedNativeFileTools({ root, signal, readOnly,
    lock: (operation) => workspace.serial(agentId, runId, operation),
    readFile: async (path, { signal: toolSignal }) => {
      let text = "", offset = 0;
      do {
        const page = await invoke("read_code_file", { path, offset, limit: 100000 }, toolSignal);
        text += page.content; offset = page.nextOffset;
      } while (offset !== null);
      return Buffer.from(text, "utf8");
    },
    writeFile: async (path, content, { signal: toolSignal }) => { await invoke("write_code_file", { path, content }, toolSignal); },
  });
  // Character paging remains available when Pi's line-based reader meets an oversized line.
  return [...native, ...(await workspace.tools(agentId, runId, { readOnly: true, signal }))];
}
