import type { ToolDefinition, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { NeumaTool } from "./execution-port.mjs";
import type { ToolSchema } from "../contracts/tools.mjs";
type WorkspaceLock = <T>(operation: () => Promise<T>) => Promise<T>;
import type { UnknownRecord } from "../contracts/json.mjs";
import { objectFields } from "../runtime/type-boundary.mjs";
interface FileToolOptions { root: string; readFile(path: string, options: { signal?: AbortSignal | undefined }): Promise<Buffer>;
  writeFile?: ((path: string, content: string, options: { signal?: AbortSignal | undefined }) => Promise<void>) | undefined;
  validatePath: (path: unknown) => string; readOnly?: boolean; signal?: AbortSignal | undefined; check?: () => Promise<unknown>; lock?: WorkspaceLock }
import { join, relative, resolve } from "node:path";
import { InputError } from "../requirements/core.mjs";


const abort = (...signals: (AbortSignal | undefined)[]) => { for (const signal of signals) signal?.throwIfAborted(); };

/** Pi supplies file rendering and exact edits; the host supplies every filesystem operation. */
export async function restrictedNativeFileTools({ root, readFile, writeFile, validatePath,
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
  return definitions.map((definition): NeumaTool => ({ name: definition.name, label: definition.label,
    parameters: definition.parameters as unknown as ToolSchema, executionMode: "sequential",
    description: `${definition.description}\nOnly relative paths in the authorized workspace are accepted. No shell access.`,
    execute: async (id, parameters, toolSignal) => serial(async () => {
      abort(signal, toolSignal); await check();
      activeSignal = signal && toolSignal ? AbortSignal.any([signal, toolSignal]) : signal ?? toolSignal;
      const fields = objectFields(parameters);
      const path = validatePath(fields.path);
      const result = await definition.execute(id, { ...fields, path: join(root, path) }, toolSignal, undefined,
        { cwd: root } as ExtensionToolContext);
      abort(signal, toolSignal); await check();
      return result;
    }),
  }));
}
