import { mkdir, readFile, writeFile, link, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { UnknownRecord } from "../contracts/json.mjs";
import type { NeumaTool } from "../runtime/execution-port.mjs";
import { createModelContextReader } from "../runtime/model-context.mjs";
import { objectFields } from "../runtime/type-boundary.mjs";
import { InputError } from "../requirements/core.mjs";
import { architectureMaterialPointer, ARCHITECTURE_ID_READ_RULE } from "./architecture-material-path.mjs";

export interface ArchitectureMaterialFile { file: string; path: string; characters: number }
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const sectionName = /^[A-Za-z_][A-Za-z0-9_]{0,79}$/u;

/** Immutable snapshots, scoped to this node. A filename is resolved only through its published catalog. */
export function createArchitectureMaterialFiles(directory: string) {
  let files = new Map<string, { section: string; path: string; text: string }>();
  let queue: Promise<unknown> = Promise.resolve();
  const publish = (source: UnknownRecord) => {
    const snapshot = structuredClone(source);
    const operation = queue.then(async () => {
      const next = new Map<string, { section: string; path: string; text: string }>();
      for (const [section, value] of Object.entries(snapshot)) {
        if (!sectionName.test(section) || value === undefined) continue;
        const text = JSON.stringify(value), file = `${section}.json`;
        const path = resolve(directory, "architecture-materials", hash(text), file);
        if (files.get(file)?.text !== text) {
          await mkdir(join(path, ".."), { recursive: true });
          const pending = `${path}.${randomUUID()}.tmp`;
          await writeFile(pending, text, { flag: "wx", mode: 0o444 });
          try {
            // Concurrent reviewers can publish the same snapshot; expose only a complete file.
            try { await link(pending, path); }
            catch (error) {
              if (objectFields(error).code !== "EEXIST") throw error;
              if (await readFile(path, "utf8") !== text) throw new InputError("架构资料文件与冻结来源不一致。");
            }
          } finally { await unlink(pending); }
        }
        next.set(file, { section, path, text });
      }
      files = next;
      return [...files].map(([file, entry]) => ({ file, path: entry.path, characters: entry.text.length }));
    });
    queue = operation.catch(() => {});
    return operation;
  };
  const tool: NeumaTool = {
    name: "read_architecture_file", label: "读取架构资料文件",
    description: "只读materialFiles目录中的文件。file使用目录中的文件名或完整路径，path可省略表示整份文件。每项最多10000字符，一批最多8项；nextRequest非空时原样续读。不能读取目录外文件。" + ARCHITECTURE_ID_READ_RULE,
    parameters: { type: "object", additionalProperties: false, required: ["requests"], properties: {
      requests: { type: "array", minItems: 1, maxItems: 8, items: { type: "object", additionalProperties: false,
        required: ["file"], properties: { file: { type: "string", minLength: 1, maxLength: 4096 },
          path: { type: "string", maxLength: 500 }, cursor: { type: "string", maxLength: 4096 } } } },
    } }, executionMode: "sequential",
    execute: async (id, input, signal) => {
      signal?.throwIfAborted();
      const raw = objectFields(input);
      if (Object.keys(raw).join() !== "requests" || !Array.isArray(raw.requests) || !raw.requests.length || raw.requests.length > 8)
        throw new InputError("资料读取须提供1至8项requests。");
      const source: UnknownRecord = {}, selectedFiles = new Map<string, string>();
      const requests = [];
      for (const rawRequest of raw.requests) {
        const request = objectFields(rawRequest);
        if (Object.keys(request).some(key => !["file", "path", "cursor"].includes(key)) || typeof request.file !== "string")
          throw new InputError("资料文件读取参数无效。");
        const pair = [...files].find(([file, entry]) => request.file === file || request.file === entry.path);
        if (!pair) throw new InputError("资料文件不在当前节点目录中，请使用materialFiles中的位置。");
        const [file, entry] = pair;
        const text = await readFile(entry.path, "utf8");
        if (text !== entry.text) throw new InputError("架构资料文件已变化，不能使用与冻结来源不同的内容。");
        source[entry.section] = JSON.parse(text); selectedFiles.set(entry.section, file);
        requests.push({ section: entry.section, ...(request.path !== undefined ? { pointer: request.path } : {}),
          ...(request.cursor !== undefined ? { cursor: request.cursor } : {}) });
      }
      const output = await createModelContextReader(() => source, { resolvePointer: architectureMaterialPointer }).execute(id, { requests }, signal);
      return { ...output, content: output.content.map(block => {
        if (block.type !== "text") return block;
        const result = objectFields(JSON.parse(block.text));
        return { ...block, text: JSON.stringify({ results: (result.results as UnknownRecord[]).map(row => {
          const { section, pointer, nextRequest, ...fields } = row;
          return { ...fields, file: selectedFiles.get(String(section)), path: pointer,
            ...(nextRequest === undefined ? {} : { nextRequest: nextRequest === null ? null
              : { file: selectedFiles.get(String(section)), cursor: objectFields(nextRequest).cursor } }) };
        }) }) };
      }) };
    },
  };
  return { publish, tool };
}
