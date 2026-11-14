import { basename, join } from "node:path";
import { InputError, ProviderError } from "../requirements/core.mjs";
import type { UnknownRecord } from "../contracts/json.mjs";
import type { ContextEvent } from "./execution-port.mjs";
import type { ModelConfig } from "../contracts/model.mjs";
import type { ToolSchema } from "../contracts/tools.mjs";
import type { SessionFactory, NeumaTool, ExecutionSession } from "./execution-port.mjs";
import { objectFields } from "./type-boundary.mjs";
import { projectWorkRound, createWorkRoundProjection } from "./work-round-context.mjs";
import { readExecutionHistory } from "./execution-history.mjs";
import { toolInputValidation } from "./tool-input-diagnostics.mjs";
import { modelSubmissionTool, modelSubmissionArguments, modelUpdateBatch, singleUpdateSchema } from "./model-submission-arguments.mjs";
import { readPiStructuredSubmission, renderPiSubmissionContract } from "./pi-submission-contract.mjs";
import { repairHash, type RepairWorker } from "./repair-scheduler.mjs";
import { createModelContextReader, modelContextValue, type ModelContextPointerResolver } from "./model-context.mjs";
import { createFormatRecovery, readFormatRecovery, noteFormatRejection, resolveFormatRecovery, deliverFormatFeedback,
  formatCorrectionFeedback, formatRecoveryExhausted, formatFailureCount, type FormatIssue } from "./format-recovery.mjs";

const schema: ToolSchema = { type: "object", additionalProperties: false, required: ["baseHash", "issueIds", "summary", "updates"], properties: {
  baseHash: { type: "string" }, issueIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3, uniqueItems: true },
  summary: { type: "string", minLength: 1, maxLength: 4000 }, updates: { type: "array", maxItems: 24, items: {
    type: "object", additionalProperties: false, required: ["path", "value"], properties: { path: { type: "string", minLength: 1, maxLength: 1000 }, value: {} } } } } };
const prompt = `你是本次修复调度中的独立子Agent，仅负责repairAssignment列出的几个问题。
先核对事实和原需求，历史评语可能错误。preparedContext直接提供本组已有字段和必要材料，未内联材料才用read_repair_context读取；只修改本组allowedPaths及其子字段。
以baseHash绑定的base为基底，用submit_repair_patch提交issueIds和summary；仅替换一个字段时直接给path和value，多项替换才给updates。
必须覆盖本组每个问题，在summary解释修复或原意见不成立的依据。不能删减原需求、已有验收输入和断言、授权或编号。
代码修复的base是{files:{相对路径:完整文本}}，路径中的斜杠须JSON Pointer转义。修改只作为提案，由宿主校验后写入；不能声称验收通过。
原文可按requests批读，使用返回的nextRequest续读，未读取部分不能猜测。最后一次请求只用于正式提交。每组有独立会话和固定剩余额度，提交后结束；不递归创建Agent。`;

export async function runRepairAgent(options: { worker: RepairWorker<number | null>; context: Record<string, unknown>; binding: unknown;
  config: ModelConfig; cwd: string; dataDir: string; sessionDirectory: string; sessionFactory: SessionFactory;
  maxOutputTokens: number; signal?: AbortSignal | undefined; tools?: NeumaTool[]; taskInstructions?: string;
  prepareMaterials?: (sources: UnknownRecord) => Promise<{ tool: NeumaTool; project: (input: UnknownRecord) => UnknownRecord | Promise<UnknownRecord>;
    transformContext?: (messages: ContextEvent["messages"]) => Promise<ContextEvent["messages"]>; resolvePointer?: ModelContextPointerResolver }> }): Promise<void> {
  const { worker, signal } = options;
  let submitted = false, accepting = true, calls = worker.group.calls, session: ExecutionSession | undefined;
  let formatFailures = worker.group.rejection?.count ?? 0, fatal: unknown;
  const recovery = worker.onFormatRecovery ? worker.group.formatRecovery ?? createFormatRecovery(worker.group.rejection ? { ...worker.group.rejection } : undefined) : undefined;
  if (recovery) {
    readFormatRecovery(recovery);
    if (!recovery.episodes.length && recovery.legacy) noteFormatRejection(recovery, "submit_repair_patch", calls,
      repairHash({ legacy: recovery.legacy }), [{ path: "submit_repair_patch", reason: "legacy_format_error",
        remedy: "原格式失败次数已归档。请核对当前补丁契约和原会话末次错误回执，按本组baseHash、issueIds及allowedPaths重交；新规则只计收到反馈后的实际纠正。" }]);
  }
  let preparedFeedbackId: string | undefined;
  const feedback = () => { const value = recovery && formatCorrectionFeedback(recovery); preparedFeedbackId = value?.feedbackId; return value; };
  const saveRecovery = async () => { if (recovery) await worker.onFormatRecovery!(recovery); };
  const resolveFormat = async (toolName: string, submitted = false) => {
    if (recovery && resolveFormatRecovery(recovery, toolName, calls, submitted)) await saveRecovery();
  };
  let opening = "";
  let projectHistoryRound: ReturnType<typeof createWorkRoundProjection> | undefined;
  const rejected = new Set<string>();
  const active = () => {
    signal?.throwIfAborted();
    if (fatal) throw fatal;
    const exhausted = formatRecoveryExhausted(recovery);
    if (exhausted || !recovery && worker.callLimit === null && formatFailures >= 3)
      throw Object.assign(new InputError("修复子组收到具体反馈后已实际纠正三次仍未通过，原会话和记录保留。"),
        { diagnostic: { stage: "development", phase: "repair", reason: "repeated_tool_error", attempts: 3,
          ...(exhausted ? { counting: "corrections_after_feedback", toolName: exhausted.toolName, issues: exhausted.failures.at(-1)!.issues } : {}) } });
    if (!accepting || submitted) throw new InputError("修复子任务已结束。");
  };
  const rejectFormat = async (id: string, value: unknown, toolName = "submit_repair_patch", issues: FormatIssue[] = [{ path: toolName,
    reason: "invalid_patch", remedy: "本次调用未通过校验；请按当前工具契约及错误回执修正。补丁须使用本组baseHash、完整issueIds和allowedPaths内的字段。" }]) => {
    const key = `${calls}:${id}`;
    if (worker.callLimit !== null || rejected.has(key)) return;
    if (recovery) {
      rejected.add(key);
      if (noteFormatRejection(recovery, toolName, calls, repairHash({ toolName, id, turn: calls }), issues)) await saveRecovery();
      return;
    }
    rejected.add(key); formatFailures = Math.min(3, formatFailures + 1);
    await worker.onRejection?.({ count: formatFailures, fingerprint: repairHash({ id, value }), modelContractHash: repairHash(schema), protocolVersion: 1 });
  };
  const readable = () => { active(); if (worker.callLimit !== null && calls >= worker.callLimit) throw new InputError("最后一次请求仅用于正式提交，不能继续读取材料。"); };
  const submit = modelSubmissionTool({ name: "submit_repair_patch", label: "提交本组修复", description: "提交本组全部问题的局部补丁，仍须合并和独立验收。",
    executionMode: "sequential", parameters: singleUpdateSchema({ ...schema, properties: { ...schema.properties, baseHash: { type: "string", const: worker.baseHash },
      issueIds: { ...schema.properties!.issueIds, items: { type: "string", enum: worker.group.issueIds } } } }), execute: async (_id, value) => {
      active();
      try { await worker.submit(modelUpdateBatch(value)); }
      catch (error) {
        if (objectFields(objectFields(error).diagnostic).reason === "content_rejection_limit") fatal = error;
        else if (objectFields(error).reason !== "repair_content_rejected") await rejectFormat(_id, { error: error instanceof Error ? error.message : "invalid_patch" });
        else await resolveFormat("submit_repair_patch");
        throw error;
      }
      await resolveFormat("submit_repair_patch", true);
      submitted = true; session?.setAutoCompactionEnabled?.(false);
      return { content: [{ type: "text", text: '{"submitted":true}' }], details: {}, terminate: true };
    } });
  const sources: Record<string, unknown> = { base: worker.base, ...options.context,
    ...(worker.group.history?.length ? { repairHistory: worker.group.history } : {}),
    ...(worker.group.history?.length ? { rejectedRepair: worker.group.history.at(-1) } : {}) };
  const fileDelivery = await options.prepareMaterials?.(sources);
  const projectMessage = async (text: string) => {
    if (!fileDelivery) return text;
    let input: unknown;
    try { input = JSON.parse(text); } catch { return text; }
    return objectFields(input).repairAssignment ? JSON.stringify(await fileDelivery.project(objectFields(input))) : text;
  };
  const projectHistory = (messages: ContextEvent["messages"]) => Promise.all(messages.map(async message => {
    if (message.role !== "user") return message;
    if (typeof message.content === "string") return { ...message, content: await projectMessage(message.content) };
    return { ...message, content: await Promise.all((message.content ?? []).map(async block => block.type === "text" ? { ...block, text: await projectMessage(block.text) } : block)) };
  }));
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
  for (const section of ["requirements", "candidateSchema", "task", "runtimeCapabilities", "acceptanceAdapterGuide", "rejectedRepair",
    ...(worker.callLimit === null ? ["unresolvedIssues", "feedback"] : [])])
    include(preparedContext, section, sources[section]);
  const ready = worker.group.paths.every(path => Object.hasOwn(baseFields, path))
    && ["requirements", "candidateSchema"].every(section => sources[section] === undefined || Object.hasOwn(preparedContext, section));
  if (!ready && worker.callLimit !== null && worker.callLimit - calls < 2) throw new InputError("本组必要原文未完整内联，剩余次数不足以读取并正式提交；未新增模型调用。");
  const reader = createModelContextReader(() => sources, { resolvePointer: fileDelivery?.resolvePointer });
  const read: NeumaTool = modelSubmissionTool({ name: "read_repair_context", label: "读取修复原文", description: "按requests批量读取本组固定原文，每项最多10000字符，按nextRequest续读；兼容旧section/pointer读取。",
    prepareArguments: input => modelSubmissionArguments(input, reader.parameters),
    executionMode: "sequential", parameters: { type: "object", anyOf: [reader.parameters, { type: "object", additionalProperties: false, required: ["section"], properties: {
      section: { type: "string" }, pointer: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 24000 } } },
    ] },
    execute: async (_id, input) => {
      readable();
      const sections = Array.isArray(objectFields(input).requests)
        ? (objectFields(input).requests as unknown[]).map(row => objectFields(row).section) : [objectFields(input).section];
      if (sections.includes("sessionHistory") && sources.sessionHistory === undefined && session?.sessionFile) {
        const history = await readExecutionHistory({ cwd: options.cwd, storage: { directory: options.sessionDirectory, file: basename(session.sessionFile),
          binding: { version: 1, role: "repair", bindingHash: repairHash(options.binding), groupId: worker.group.id, baseHash: worker.baseHash } }, ...(signal ? { signal } : {}) });
        sources.sessionHistory = history.entries.map(entry => ({ id: entry.id, message: { ...entry.message,
          ...(Array.isArray(entry.message.content) ? { content: entry.message.content.filter(block => block.type !== "thinking") } : {}) } }));
      }
      if (Array.isArray(objectFields(input).requests)) {
        const result = await reader.execute(_id, input, signal);
        const content = result.content.find(block => block.type === "text");
        const failures = content?.type === "text" ? (JSON.parse(content.text) as { results: unknown[] }).results.filter(row => objectFields(row).error) : [];
        if (failures.length) await rejectFormat(_id, "修复资料读取位置或续读参数无效", "read_repair_context", [{ path: "read_repair_context.requests",
          reason: "context_read_rejected", remedy: "读取位置或续读参数无效。pointer须以/开头（例如/0），空字符串读取整项；原样使用nextRequest续读。" }]);
        else await resolveFormat("read_repair_context");
        return result;
      }
      const { section, pointer = "", offset = 0, limit = 10000 } = objectFields(input);
      if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 24000) throw new InputError("修复原文读取参数无效。");
      const result = await reader.execute(_id, { requests: [{ section, pointer, offset, limit: Math.min(Number(limit), 10000) }] }, signal);
      const text = result.content.find(item => item.type === "text");
      const row = objectFields((JSON.parse(text!.text) as { results: unknown[] }).results[0]);
      if (row.error) { await rejectFormat(_id, "修复资料读取位置无效", "read_repair_context", [{ path: "read_repair_context.pointer",
        reason: "context_read_rejected", remedy: "pointer须为以/开头的JSON Pointer，例如/0；空字符串读取整项，续读使用nextRequest。" }]); throw new InputError(String(objectFields(row.error).message)); }
      await resolveFormat("read_repair_context");
      return { content: [{ type: "text", text: JSON.stringify({ ...row, totalChars: row.totalCharacters, baseHash: worker.baseHash }) }], details: {} };
    } });
  const tools = [read, ...[...(fileDelivery ? [fileDelivery.tool] : []), ...(options.tools ?? [])].map(tool => ({ ...tool, execute: async (...args: Parameters<NeumaTool["execute"]>) => {
    readable(); const value = await tool.execute(...args); await resolveFormat(tool.name); active(); return value;
  } })), submit];
  const abort = () => { accepting = false; void session?.abort(); };
  signal?.addEventListener("abort", abort, { once: true });
  const activePrompt = worker.callLimit === null ? prompt.replace("最后一次请求只用于正式提交。每组有独立会话和固定剩余额度",
    "模型请求只记用量，无请求次数上限。每轮以最新基底、上轮反馈和全部未解决问题为准；旧repairHistory及sessionHistory可用read_repair_context按需读取。内容退回五次另计；格式错误先反馈，再给三次实际纠正机会，首次错误和正常读取不扣机会。每组保留独立原会话") : prompt;
  try {
    session = await options.sessionFactory({ config: options.config, cwd: options.cwd, dataDir: options.dataDir, reasoningMode: "off",
      maxOutputTokens: options.maxOutputTokens, systemPrompt: (fileDelivery ? activePrompt.replace("preparedContext直接提供本组已有字段和必要材料，未内联材料才用read_repair_context读取", "materialFiles提供本组资料文件目录，先用read_architecture_file读取需要的原文；旧read_repair_context同样可用") : activePrompt) + (options.taskInstructions ? "\n" + options.taskInstructions : "") + "\n" + renderPiSubmissionContract({ role: "repair", submitName: submit.name, tools, structuredResponse: true }),
      ...(fileDelivery ? { preparePrompt: projectMessage, transformContext: fileDelivery.transformContext ?? projectHistory } : {}),
      ...(worker.callLimit === null ? { transformContext: (messages: ContextEvent["messages"]) => {
        const projected = projectHistoryRound?.(messages, opening) ?? projectWorkRound(messages, opening), correction = feedback();
        return correction ? [...projected, { role: "user" as const, content: [{ type: "text" as const, text: JSON.stringify({ formatCorrection: correction }) }] }] : projected;
      } } : {}),
      customTools: tools, stopAfterTurn: () => submitted, sessionStorage: { directory: options.sessionDirectory,
        binding: { version: 1, role: "repair", bindingHash: repairHash(options.binding), groupId: worker.group.id, baseHash: worker.baseHash },
        ...(worker.group.sessionFile ? { file: join(options.sessionDirectory, worker.group.sessionFile) } : {}) },
      rawInputValidators: Object.fromEntries(tools.map(tool => [tool.name, async ({ args, toolCallId }) => {
        active(); const result = toolInputValidation(tool.prepareArguments ? tool.prepareArguments(args) : args, tool.parameters);
        if (!result.valid) await rejectFormat(String(toolCallId), { tool: tool.name, issues: result.issues }, tool.name, result.issues);
        return result.valid ? { valid: true } : { valid: false, reason: "工具参数不符合本组公开契约：" + JSON.stringify(result.issues) };
      }])),
      toolAvailability: ({ retryAttempt }) => worker.callLimit !== null && calls - (retryAttempt > 0 ? 1 : 0) >= worker.callLimit - 1 ? [submit.name] : tools.map(tool => tool.name),
      onModelCall: async (event = {}) => { active(); await worker.onCall(event.retryAttempt); if (!event.retryAttempt) calls++;
        if (recovery && deliverFormatFeedback(recovery, calls, preparedFeedbackId)) await saveRecovery(); } });
    session.setAutoCompactionEnabled?.(false);
    signal?.throwIfAborted();
    if (!session.sessionFile) throw new InputError("修复子会话没有可恢复的历史引用，已停止。");
    await worker.onSession(basename(session.sessionFile));
    await saveRecovery();
    const manifest = Object.fromEntries(Object.entries(sources).map(([section, value]) => [section, {
      characters: JSON.stringify(value).length, delivery: Object.hasOwn(preparedContext, section) ? "full" : "paged",
      ...(value && typeof value === "object" ? { keys: Object.keys(value).slice(0, 200) } : {}) }]));
    let message = JSON.stringify({ repairAssignment: { groupId: worker.group.id, issues: worker.issues, allowedPaths: worker.group.paths,
      baseHash: worker.baseHash, modelBudget: { used: calls, limit: worker.callLimit, remaining: worker.callLimit === null ? null : worker.callLimit - calls,
        ...(worker.callLimit === null ? { accountingOnly: true } : {}) } },
      preparedContext, materialReady: ready, contextManifest: manifest });
    opening = message;
    projectHistoryRound = createWorkRoundProjection(session.messages ?? []);
    while (!submitted && (worker.callLimit === null || calls < worker.callLimit)) {
      active();
      const formatBefore = recovery ? formatFailureCount(recovery) : formatFailures;
      if (!session.modelCallAccounting) {
        const correction = feedback();
        if (correction) message = JSON.stringify({ message, formatCorrection: correction });
        await worker.onCall(); calls++;
        if (recovery && deliverFormatFeedback(recovery, calls, preparedFeedbackId)) await saveRecovery();
      }
      const count = session.messages?.length ?? 0;
      await session.prompt(message); signal?.throwIfAborted();
      const last = session.messages?.slice(count).findLast(entry => entry.role === "assistant");
      if (["error", "aborted"].includes(last?.stopReason ?? "") || worker.callLimit !== null && last?.stopReason === "length")
        throw new ProviderError("修复子Agent未完整结束，已保留进度。", { stage: "repair", reason: last!.stopReason! });
      if (!submitted && last) {
        const structured = readPiStructuredSubmission(last, { tools: [submit] });
        if (structured) try { await submit.execute("structured", structured.args); }
        catch (error) { if (worker.callLimit !== null || !(error instanceof InputError)) throw error; }
      }
      if (!submitted && worker.callLimit === null && ["stop", "length"].includes(last?.stopReason ?? "")
        && formatBefore === (recovery ? formatFailureCount(recovery) : formatFailures))
        await rejectFormat(`incomplete_${calls}`, "本轮没有正式提交补丁", "submit_repair_patch", [{ path: "submit_repair_patch",
          reason: last?.stopReason === "length" ? "output_limit" : "submission_incomplete",
          remedy: "本轮没有可解析的正式补丁。请继续已有稿件，按submit_repair_patch的完整参数提交；进度文字不能替代提交。" }]);
      message = "本组尚未正式提交。继续原会话，仅修复本组问题并调用submit_repair_patch；原额度累计。";
    }
    if (!submitted) throw new InputError("修复子Agent已用完本组额度，尚未正式提交；已保存历史和其他组成果。");
  } finally {
    accepting = false; signal?.removeEventListener("abort", abort); await session?.dispose();
  }
}
