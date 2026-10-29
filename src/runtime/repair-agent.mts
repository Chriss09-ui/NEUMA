import { basename, join } from "node:path";
import { InputError, ProviderError } from "../requirements/core.mjs";
import type { ModelConfig } from "../contracts/model.mjs";
import type { ToolSchema } from "../contracts/tools.mjs";
import type { SessionFactory, NeumaTool, ExecutionSession } from "./execution-port.mjs";
import { objectFields } from "./type-boundary.mjs";
import { toolInputValidation } from "./tool-input-diagnostics.mjs";
import { readPiStructuredSubmission, renderPiSubmissionContract } from "./pi-submission-contract.mjs";
import { repairHash, type RepairWorker } from "./repair-scheduler.mjs";

const schema: ToolSchema = { type: "object", additionalProperties: false, required: ["baseHash", "issueIds", "summary", "updates"], properties: {
  baseHash: { type: "string" }, issueIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3, uniqueItems: true },
  summary: { type: "string", minLength: 1, maxLength: 4000 }, updates: { type: "array", maxItems: 24, items: {
    type: "object", additionalProperties: false, required: ["path", "value"], properties: { path: { type: "string", minLength: 1, maxLength: 1000 }, value: {} } } } } };
const prompt = `你是本次修复调度中的独立子Agent，仅负责repairAssignment列出的几个问题。
先核对事实和原需求，历史评语可能错误。使用read_repair_context读取必要原文；只修改本组allowedPaths及其子字段。
以baseHash绑定的base为基底，用submit_repair_patch提交issueIds、summary及updates:[{path:JSON Pointer,value:替换值}]。
必须覆盖本组每个问题，在summary解释修复或原意见不成立的依据。不能删减原需求、已有验收输入和断言、授权或编号。
代码修复的base是{files:{相对路径:完整文本}}，路径中的斜杠须JSON Pointer转义。修改只作为提案，由宿主校验后写入；不能声称验收通过。
原文可分页读取，未读取部分不能猜测。每组有独立会话和固定剩余额度，提交后结束；不递归创建Agent。`;

export async function runRepairAgent(options: { worker: RepairWorker; context: Record<string, unknown>; binding: unknown;
  config: ModelConfig; cwd: string; dataDir: string; sessionDirectory: string; sessionFactory: SessionFactory;
  maxOutputTokens: number; signal?: AbortSignal | undefined; tools?: NeumaTool[] }): Promise<void> {
  const { worker, signal } = options;
  let submitted = false, accepting = true, calls = worker.group.calls, session: ExecutionSession | undefined;
  const active = () => { signal?.throwIfAborted(); if (!accepting || submitted) throw new InputError("修复子任务已结束。"); };
  const submit: NeumaTool = { name: "submit_repair_patch", label: "提交本组修复", description: "提交本组全部问题的局部补丁，仍须合并和独立验收。",
    executionMode: "sequential", parameters: { ...schema, properties: { ...schema.properties, baseHash: { type: "string", const: worker.baseHash },
      issueIds: { ...schema.properties!.issueIds, items: { type: "string", enum: worker.group.issueIds } } } }, execute: async (_id, value) => {
      active(); await worker.submit(value); submitted = true; session?.setAutoCompactionEnabled?.(false);
      return { content: [{ type: "text", text: '{"submitted":true}' }], details: {}, terminate: true };
    } };
  const sources: Record<string, unknown> = { base: worker.base, ...options.context };
  const read: NeumaTool = { name: "read_repair_context", label: "读取修复原文", description: "读取本组固定版本的base、需求和证据。长文本按nextOffset继续。",
    executionMode: "sequential", parameters: { type: "object", additionalProperties: false, required: ["section"], properties: {
      section: { type: "string" }, pointer: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 24000 } } },
    execute: async (_id, input) => {
      active(); const { section, pointer = "", offset = 0, limit = 12000 } = objectFields(input);
      if (typeof section !== "string" || !Object.hasOwn(sources, section) || typeof pointer !== "string"
        || pointer && (!pointer.startsWith("/") || /~(?![01])/u.test(pointer)) || !Number.isSafeInteger(offset) || Number(offset) < 0
        || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 24000) throw new InputError("修复原文读取参数无效。");
      let source = sources[section];
      for (const key of pointer ? pointer.slice(1).split("/").map(key => key.replaceAll("~1", "/").replaceAll("~0", "~")) : []) {
        if (!source || typeof source !== "object" || !Object.hasOwn(source, key)) throw new InputError("修复原文路径不存在。");
        source = (source as Record<string, unknown>)[key];
      }
      const text = JSON.stringify(source), end = Math.min(text.length, Number(offset) + Number(limit));
      return { content: [{ type: "text", text: JSON.stringify({ section, pointer, text: text.slice(Number(offset), end),
        totalChars: text.length, nextOffset: end < text.length ? end : null, baseHash: worker.baseHash }) }], details: {} };
    } };
  const tools = [read, ...(options.tools ?? []).map(tool => ({ ...tool, execute: async (...args: Parameters<NeumaTool["execute"]>) => {
    active(); const value = await tool.execute(...args); active(); return value;
  } })), submit];
  const abort = () => { accepting = false; void session?.abort(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    session = await options.sessionFactory({ config: options.config, cwd: options.cwd, dataDir: options.dataDir, reasoningMode: "off",
      maxOutputTokens: options.maxOutputTokens, systemPrompt: prompt + "\n" + renderPiSubmissionContract({ role: "repair", submitName: submit.name, tools, structuredResponse: true }),
      customTools: tools, sessionStorage: { directory: options.sessionDirectory,
        binding: { version: 1, role: "repair", bindingHash: repairHash(options.binding), groupId: worker.group.id, baseHash: worker.baseHash },
        ...(worker.group.sessionFile ? { file: join(options.sessionDirectory, worker.group.sessionFile) } : {}) },
      rawInputValidators: Object.fromEntries(tools.map(tool => [tool.name, ({ args }) => {
        active(); const result = toolInputValidation(args, tool.parameters);
        return result.valid ? { valid: true } : { valid: false, reason: "工具参数不符合本组公开契约。" };
      }])),
      onModelCall: async (event = {}) => { active(); await worker.onCall(event.retryAttempt); if (!event.retryAttempt) calls++; } });
    signal?.throwIfAborted();
    if (!session.sessionFile) throw new InputError("修复子会话没有可恢复的历史引用，已停止。");
    await worker.onSession(basename(session.sessionFile));
    const manifest = Object.fromEntries(Object.entries(sources).map(([section, value]) => [section, {
      characters: JSON.stringify(value).length, ...(value && typeof value === "object" ? { keys: Object.keys(value).slice(0, 200) } : {}) }]));
    let message = JSON.stringify({ repairAssignment: { groupId: worker.group.id, issues: worker.issues, allowedPaths: worker.group.paths,
      baseHash: worker.baseHash, modelBudget: { used: calls, limit: worker.callLimit } }, contextManifest: manifest });
    while (!submitted && calls < worker.callLimit) {
      active();
      if (!session.modelCallAccounting) { await worker.onCall(); calls++; }
      const count = session.messages?.length ?? 0;
      await session.prompt(message); signal?.throwIfAborted();
      const last = session.messages?.slice(count).findLast(entry => entry.role === "assistant");
      if (["error", "aborted", "length"].includes(last?.stopReason ?? "")) throw new ProviderError("修复子Agent未完整结束，已保留进度。", { stage: "repair", reason: last!.stopReason! });
      if (!submitted && last) {
        const structured = readPiStructuredSubmission(last, { tools: [submit] });
        if (structured) await submit.execute("structured", structured.args);
      }
      message = "本组尚未正式提交。继续原会话，仅修复本组问题并调用submit_repair_patch；原额度累计。";
    }
    if (!submitted) throw new InputError("修复子Agent已用完本组额度，尚未正式提交；已保存历史和其他组成果。");
  } finally {
    accepting = false; signal?.removeEventListener("abort", abort); await session?.dispose();
  }
}
