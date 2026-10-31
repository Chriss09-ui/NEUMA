import { basename, join } from "node:path";
import { InputError, ProviderError } from "../requirements/core.mjs";
import type { ModelConfig } from "../contracts/model.mjs";
import type { ToolSchema } from "../contracts/tools.mjs";
import type { SessionFactory, NeumaTool, ExecutionSession } from "./execution-port.mjs";
import { objectFields } from "./type-boundary.mjs";
import { toolInputValidation } from "./tool-input-diagnostics.mjs";
import { readPiStructuredSubmission, renderPiSubmissionContract } from "./pi-submission-contract.mjs";
import { repairHash, type RepairWorker } from "./repair-scheduler.mjs";
import { createModelContextReader, modelContextValue } from "./model-context.mjs";

const schema: ToolSchema = { type: "object", additionalProperties: false, required: ["baseHash", "issueIds", "summary", "updates"], properties: {
  baseHash: { type: "string" }, issueIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3, uniqueItems: true },
  summary: { type: "string", minLength: 1, maxLength: 4000 }, updates: { type: "array", maxItems: 24, items: {
    type: "object", additionalProperties: false, required: ["path", "value"], properties: { path: { type: "string", minLength: 1, maxLength: 1000 }, value: {} } } } } };
const prompt = `你是本次修复调度中的独立子Agent，仅负责repairAssignment列出的几个问题。
先核对事实和原需求，历史评语可能错误。preparedContext直接提供本组已有字段和必要材料，未内联材料才用read_repair_context读取；只修改本组allowedPaths及其子字段。
以baseHash绑定的base为基底，用submit_repair_patch提交issueIds、summary及updates:[{path:JSON Pointer,value:替换值}]。
必须覆盖本组每个问题，在summary解释修复或原意见不成立的依据。不能删减原需求、已有验收输入和断言、授权或编号。
代码修复的base是{files:{相对路径:完整文本}}，路径中的斜杠须JSON Pointer转义。修改只作为提案，由宿主校验后写入；不能声称验收通过。
原文可按requests批读，使用返回的nextRequest续读，未读取部分不能猜测。最后一次请求只用于正式提交。每组有独立会话和固定剩余额度，提交后结束；不递归创建Agent。`;

export async function runRepairAgent(options: { worker: RepairWorker; context: Record<string, unknown>; binding: unknown;
  config: ModelConfig; cwd: string; dataDir: string; sessionDirectory: string; sessionFactory: SessionFactory;
  maxOutputTokens: number; signal?: AbortSignal | undefined; tools?: NeumaTool[] }): Promise<void> {
  const { worker, signal } = options;
  let submitted = false, accepting = true, calls = worker.group.calls, session: ExecutionSession | undefined;
  const active = () => { signal?.throwIfAborted(); if (!accepting || submitted) throw new InputError("修复子任务已结束。"); };
  const readable = () => { active(); if (calls >= worker.callLimit) throw new InputError("最后一次请求仅用于正式提交，不能继续读取材料。"); };
  const submit: NeumaTool = { name: "submit_repair_patch", label: "提交本组修复", description: "提交本组全部问题的局部补丁，仍须合并和独立验收。",
    executionMode: "sequential", parameters: { ...schema, properties: { ...schema.properties, baseHash: { type: "string", const: worker.baseHash },
      issueIds: { ...schema.properties!.issueIds, items: { type: "string", enum: worker.group.issueIds } } } }, execute: async (_id, value) => {
      active(); await worker.submit(value); submitted = true; session?.setAutoCompactionEnabled?.(false);
      return { content: [{ type: "text", text: '{"submitted":true}' }], details: {}, terminate: true };
    } };
  const sources: Record<string, unknown> = { base: worker.base, ...options.context,
    ...(worker.group.history?.length ? { rejectedRepair: worker.group.history.at(-1) } : {}) };
  const preparedContext: Record<string, unknown> = {}, baseFields: Record<string, unknown> = {};
  let bytes = 0;
  const include = (target: Record<string, unknown>, key: string, value: unknown) => {
    if (value === undefined) return false;
    const size = Buffer.byteLength(JSON.stringify({ [key]: value }));
    if (bytes + size > 64 * 1024) return false;
    bytes += size; target[key] = value; return true;
  };
  for (const path of worker.group.paths) include(baseFields, path, modelContextValue(sources, "base", path));
  preparedContext.baseFields = baseFields;
  for (const section of ["requirements", "candidateSchema", "task", "runtimeCapabilities", "acceptanceAdapterGuide", "rejectedRepair"])
    include(preparedContext, section, sources[section]);
  const ready = worker.group.paths.every(path => Object.hasOwn(baseFields, path))
    && ["requirements", "candidateSchema"].every(section => sources[section] === undefined || Object.hasOwn(preparedContext, section));
  if (!ready && worker.callLimit - calls < 2) throw new InputError("本组必要原文未完整内联，剩余次数不足以读取并正式提交；未新增模型调用。");
  const reader = createModelContextReader(() => sources);
  const read: NeumaTool = { name: "read_repair_context", label: "读取修复原文", description: "按requests批量读取本组固定原文，每项最多10000字符，按nextRequest续读；兼容旧section/pointer读取。",
    executionMode: "sequential", parameters: { type: "object", anyOf: [reader.parameters, { type: "object", additionalProperties: false, required: ["section"], properties: {
      section: { type: "string" }, pointer: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 24000 } } },
    ] },
    execute: async (_id, input) => {
      readable();
      if (Array.isArray(objectFields(input).requests)) return reader.execute(_id, input, signal);
      const { section, pointer = "", offset = 0, limit = 10000 } = objectFields(input);
      if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 24000) throw new InputError("修复原文读取参数无效。");
      const result = await reader.execute(_id, { requests: [{ section, pointer, offset, limit: Math.min(Number(limit), 10000) }] }, signal);
      const text = result.content.find(item => item.type === "text");
      const row = objectFields((JSON.parse(text!.text) as { results: unknown[] }).results[0]);
      if (row.error) throw new InputError(String(objectFields(row.error).message));
      return { content: [{ type: "text", text: JSON.stringify({ ...row, totalChars: row.totalCharacters, baseHash: worker.baseHash }) }], details: {} };
    } };
  const tools = [read, ...(options.tools ?? []).map(tool => ({ ...tool, execute: async (...args: Parameters<NeumaTool["execute"]>) => {
    readable(); const value = await tool.execute(...args); active(); return value;
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
      toolAvailability: ({ retryAttempt }) => calls - (retryAttempt > 0 ? 1 : 0) >= worker.callLimit - 1 ? [submit.name] : tools.map(tool => tool.name),
      onModelCall: async (event = {}) => { active(); await worker.onCall(event.retryAttempt); if (!event.retryAttempt) calls++; } });
    session.setAutoCompactionEnabled?.(false);
    signal?.throwIfAborted();
    if (!session.sessionFile) throw new InputError("修复子会话没有可恢复的历史引用，已停止。");
    await worker.onSession(basename(session.sessionFile));
    const manifest = Object.fromEntries(Object.entries(sources).map(([section, value]) => [section, {
      characters: JSON.stringify(value).length, delivery: Object.hasOwn(preparedContext, section) ? "full" : "paged",
      ...(value && typeof value === "object" ? { keys: Object.keys(value).slice(0, 200) } : {}) }]));
    let message = JSON.stringify({ repairAssignment: { groupId: worker.group.id, issues: worker.issues, allowedPaths: worker.group.paths,
      baseHash: worker.baseHash, modelBudget: { used: calls, limit: worker.callLimit, remaining: worker.callLimit - calls } },
      preparedContext, materialReady: ready, contextManifest: manifest });
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
