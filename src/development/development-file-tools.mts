import type { DevelopmentWorkspace } from "./development-workspace.mjs";
import type { UnknownRecord } from "../contracts/json.mjs";
import { objectFields } from "../runtime/type-boundary.mjs";
import { InputError } from "../requirements/core.mjs";
import { validateCodePath } from "./development-workspace.mjs";
import { restrictedNativeFileTools as nativeFileTools } from "../runtime/pi-file-tools.mjs";
export const restrictedNativeFileTools = (options: Omit<Parameters<typeof nativeFileTools>[0], "validatePath"> & { validatePath?: (path: unknown) => string }) =>
  nativeFileTools({ ...options, validatePath: options.validatePath ?? validateCodePath });

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
