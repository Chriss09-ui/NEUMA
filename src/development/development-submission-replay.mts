import type { FormatRecovery } from "../runtime/format-recovery.mjs";
import type { RepairCheckpoint } from "../runtime/repair-scheduler.mjs";
import type { DevelopmentController } from "./development.mjs";
import type { DevelopmentContext } from "./development-controller-types.mjs";
import type { DevelopmentPart, DevelopmentWorkCheckpoint } from "./development-dispatch.mjs";
import type { DevelopmentSessionReference } from "./development-sessions.mjs";
import { InputError } from "../requirements/core.mjs";
import { objectFields } from "../runtime/type-boundary.mjs";
import { formatRecoveryExhausted, readFormatRecovery, resolveFormatRecovery } from "../runtime/format-recovery.mjs";
import { applyRepairUpdates, readDevelopmentTaskCheckpoint, repairHash, validateRepairResult } from "../runtime/repair-scheduler.mjs";
import { inspectModelSubmissionArguments } from "../runtime/model-submission-arguments.mjs";
import { readExecutionHistory } from "../runtime/execution-history.mjs";
import { toolInputValidation } from "../runtime/tool-input-diagnostics.mjs";
import { developmentSessionBinding } from "./development-sessions.mjs";
import { submissionIssues } from "./development-diagnostics.mjs";

export interface DevelopmentSubmissionReplay {
  version: 1; groupId: string; sessionKey: string; sessionFile: string; turn: number; toolName: string; toolCallId: string;
  sourceCheckpointHash: string; sessionHash: string; schemaHash: string; rawHash: string; normalizedHash: string; resultHash: string;
  previousFormatRecovery: FormatRecovery;
}
function failure(message: string): never { throw new InputError(`原提交无法安全恢复：${message}。原会话、结果和次数保留。`); }

export function readDevelopmentSubmissionReplays(input: unknown, dispatch: RepairCheckpoint<null>, sessions?: Record<string, DevelopmentSessionReference>) {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > 400) failure("接受凭据无效");
  const replays = input as DevelopmentSubmissionReplay[], calls = new Set<string>();
  for (const receipt of replays) {
    if (!receipt || Object.keys(receipt).sort().join() !== "groupId,normalizedHash,previousFormatRecovery,rawHash,resultHash,schemaHash,sessionFile,sessionHash,sessionKey,sourceCheckpointHash,toolCallId,toolName,turn,version"
      || receipt.version !== 1 || !Number.isSafeInteger(receipt.turn) || receipt.turn < 1
      || !["submit_development_plan_part", "submit_development_review_part"].includes(receipt.toolName)
      || typeof receipt.toolCallId !== "string" || !receipt.toolCallId || receipt.toolCallId.length > 512
      || typeof receipt.sessionFile !== "string" || !/^[\w.-]+\.jsonl$/u.test(receipt.sessionFile)
      || [receipt.sessionKey, receipt.sourceCheckpointHash, receipt.sessionHash, receipt.schemaHash, receipt.rawHash, receipt.normalizedHash, receipt.resultHash]
        .some(value => typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))) failure("接受凭据字段无效");
    const identity = `${receipt.sessionKey}:${receipt.toolCallId}`;
    if (calls.has(identity)) failure("同次提交的接受凭据重复");
    calls.add(identity);
    const before = readFormatRecovery(receipt.previousFormatRecovery), exhausted = formatRecoveryExhausted(before);
    if (!exhausted || exhausted.toolName !== receipt.toolName || exhausted.failures.at(-1)!.turn !== receipt.turn
      || exhausted.failures.at(-1)!.callHash !== repairHash({ toolName: receipt.toolName, toolCallId: receipt.toolCallId, turn: receipt.turn })) failure("原格式退回无法核验");
    const group = dispatch.groups.find(group => group.id === receipt.groupId);
    const accepted = group && [group, ...group.history ?? []].some(entry => entry.sessionFile === receipt.sessionFile && entry.calls >= receipt.turn
      && entry.result && repairHash(entry.result) === receipt.resultHash);
    if (!accepted) failure("接受结果与原分组不一致");
    if (sessions) {
      const reference = sessions[receipt.sessionKey], expected = structuredClone(before);
      resolveFormatRecovery(expected, receipt.toolName, receipt.turn, true);
      if (!reference || reference.bindingHash !== receipt.sessionKey || reference.file !== receipt.sessionFile || reference.turns < receipt.turn
        || !reference.formatRecovery || repairHash(reference.formatRecovery.episodes.slice(0, expected.episodes.length)) !== repairHash(expected.episodes)
        || repairHash(reference.formatRecovery.legacy ?? null) !== repairHash(before.legacy ?? null)) failure("原会话或纠正记录已变化");
    }
  }
  return structuredClone(replays);
}

/** Recheck only the last failed call in a bound native session. No model call or historical edit occurs here. */
export async function prepareDevelopmentSubmissionReplay<T>(controller: DevelopmentController, ctx: DevelopmentContext, key: string,
  checkpoint: DevelopmentWorkCheckpoint, parts: DevelopmentPart<T>[], initialBase: unknown,
  validate: (value: unknown, final?: boolean) => unknown) {
  if (checkpoint.version !== 2) return null;
  const copy = structuredClone(checkpoint), dispatch = copy.dispatch, sessions: Record<string, DevelopmentSessionReference> = {};
  let base = structuredClone(initialBase), recovered = 0;
  for (let wave = 1; wave <= Math.max(...dispatch.groups.map(group => group.wave)); wave++) {
    const groups = dispatch.groups.filter(group => group.wave === wave), baseHash = repairHash(base);
    for (const group of groups) {
      if (group.inputHash !== baseHash) failure("分组基底变化");
      if (group.result) { validateRepairResult(group.result, group, base); validate(applyRepairUpdates(base, group.result.updates)); continue; }
      const part = parts.find(part => group.issueIds.length === 1 && group.issueIds[0] === part.id);
      if (!part) continue;
      const binding = developmentSessionBinding(ctx.record, part.role, { work: key, bindingHash: checkpoint.bindingHash, partId: part.id, baseHash });
      const sessionKey = repairHash(binding), reference = ctx.record.sessions?.[sessionKey], exhausted = formatRecoveryExhausted(reference?.formatRecovery);
      if (!exhausted) continue;
      const toolName = part.role === "reviewer" ? "submit_development_review_part" : "submit_development_plan_part";
      if (exhausted.toolName !== toolName) continue;
      if (!reference?.file || reference.bindingHash !== sessionKey || reference.role !== part.role || reference.file !== group.sessionFile
        || reference.turns !== group.calls || reference.pendingResult || exhausted.failures.at(-1)!.turn !== reference.turns) failure("会话、最后提交和用量不对应");
      const directory = await controller.storage.directory(ctx.record.agentId, `development/sessions/${ctx.record.id}/${sessionKey}`);
      const native = await readExecutionHistory({ cwd: await controller.workspace.workspacePath(ctx.record.agentId, ctx.record.id),
        storage: { directory, file: reference.file, binding }, signal: ctx.signal });
      const messages = native.entries.map(entry => entry.message);
      let end = messages.length - 1;
      const last = messages[end];
      if (last?.role === "assistant" && last.stopReason === "error" && last.usage?.output === 0 && Array.isArray(last.content) && !last.content.length) end--;
      const feedback = messages[end], assistant = messages[end - 1];
      const calls = assistant?.role === "assistant" && assistant.stopReason === "toolUse" && Array.isArray(assistant.content)
        ? assistant.content.filter(block => block.type === "toolCall") : [];
      const call = calls[0];
      if (calls.length !== 1 || !call || call.name !== toolName || feedback?.role !== "toolResult" || feedback.toolName !== toolName
        || feedback.toolCallId !== call.id || feedback.isError !== true
        || exhausted.failures.at(-1)!.callHash !== repairHash({ toolName, toolCallId: call.id, turn: reference.turns })) failure("原生末次提交与退回凭据不匹配，不能回退取更早稿件");
      const rejected = Array.isArray(feedback.content) && feedback.content.some(block => {
        if (block.type !== "text") return false;
        try { const body = objectFields(JSON.parse(block.text)); return body.submitted === false && Array.isArray(body.issues) && body.issues.length > 0; }
        catch { return false; }
      });
      if (!rejected) failure("原生错误回执不完整");
      const normalized = inspectModelSubmissionArguments(call.arguments, part.schema), structural = toolInputValidation(normalized.value, part.schema, { root: "submission" });
      const stop = (issues: unknown, message: string): never => { throw Object.assign(new InputError(message), {
        diagnostic: { stage: "development", phase: ctx.record.phase, reason: "submission_replay_rejected", toolName, issues } }); };
      if (!normalized.restored || !structural.valid) stop(structural.valid ? [] : structural.issues,
        `原停点的格式不能明确还原，未接受原稿：${structural.valid ? "没有可核验的格式还原" : structural.issues.map(issue => `${issue.path}：${issue.remedy}`).join("；")}`);
      let value: T;
      try { value = part.validate(normalized.value); }
      catch (error) {
        if (!(error instanceof InputError)) throw error;
        const issues = submissionIssues(normalized.value, part.schema, { root: part.role === "reviewer" ? "review" : "plan", error, architecture: ctx.record.architecture });
        stop(issues, `原稿格式已还原，但完整校验未通过：${issues.map(issue => `${issue.path}：${issue.remedy}`).join("；")}`);
      }
      const result = validateRepairResult({ baseHash, issueIds: group.issueIds, summary: "原会话末次格式提交经程序还原并完整校验，仍须后续合并及独立验收",
        updates: [{ path: group.paths[0], value: value! }] }, group, base);
      validate(applyRepairUpdates(base, result.updates));
      const receipt: DevelopmentSubmissionReplay = { version: 1, groupId: group.id, sessionKey, sessionFile: reference.file,
        turn: reference.turns, toolName, toolCallId: call.id, sourceCheckpointHash: repairHash(ctx.record.workDispatches![key]),
        sessionHash: native.sessionHash, schemaHash: repairHash(part.schema), rawHash: repairHash(call.arguments),
        normalizedHash: repairHash(normalized.value), resultHash: repairHash(result), previousFormatRecovery: structuredClone(reference.formatRecovery!) };
      group.result = result;
      (copy.submissionReplays ??= []).push(receipt);
      const nextReference = structuredClone(reference);
      resolveFormatRecovery(nextReference.formatRecovery!, toolName, reference.turns, true);
      sessions[sessionKey] = nextReference;
      recovered++;
    }
    if (groups.some(group => !group.result)) break;
    base = applyRepairUpdates(base, groups.flatMap(group => group.result!.updates));
    validate(base, dispatch.groups.every(group => group.result));
  }
  if (!recovered) return null;
  const { hash: _hash, ...body } = dispatch;
  copy.dispatch = readDevelopmentTaskCheckpoint({ ...body, hash: repairHash(body) });
  readDevelopmentSubmissionReplays(copy.submissionReplays, copy.dispatch, { ...ctx.record.sessions, ...sessions });
  return { checkpoint: copy, sessions };
}
