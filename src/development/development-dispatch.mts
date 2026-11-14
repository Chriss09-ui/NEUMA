import { basename } from "node:path";
import type { ToolSchema } from "../contracts/tools.mjs";
import type { UnknownRecord } from "../contracts/json.mjs";
import type { RegisteredTool } from "../runtime/execution-port.mjs";
import { createDevelopmentTaskCheckpoint, readDevelopmentTaskCheckpoint, repairHash, runDevelopmentTaskSchedule, type RepairCheckpoint } from "../runtime/repair-scheduler.mjs";
import { objectFields } from "../runtime/type-boundary.mjs";
import { readExecutionHistory } from "../runtime/execution-history.mjs";
import { InputError } from "../requirements/core.mjs";
import type { DevelopmentController } from "./development.mjs";
import type { DevelopmentContext, DevelopmentRole } from "./development-controller-types.mjs";
import { isPlanningBlockerOutcome } from "./development-planning-blocker.mjs";
import { noteDevelopmentRejection, developmentContentLimit } from "./development-policy.mjs";
import { developmentSessionBinding, type DevelopmentSessionReference } from "./development-sessions.mjs";
import { prepareDevelopmentSubmissionReplay, readDevelopmentSubmissionReplays, type DevelopmentSubmissionReplay } from "./development-submission-replay.mjs";
import type { SubmissionIssue } from "./development-diagnostics.mjs";

interface AccountingSnapshot { id: string; remaining?: unknown; omitUnresolved?: true }
interface WorkIdentity { binding: unknown; assignments: { id: string; role: DevelopmentRole; schema: ToolSchema;
  instruction: string; payload: UnknownRecord; allowBlocker: boolean }[]; callLimit: number }
export type DevelopmentWorkCheckpoint = { version: 1; bindingHash: string; dispatch: RepairCheckpoint<null> }
  | { version: 2; bindingHash: string; materialHash: string; originalAccounting?: AccountingSnapshot[];
    submissionReplays?: DevelopmentSubmissionReplay[]; dispatch: RepairCheckpoint<null> };
export interface DevelopmentPart<T> { id: string; role: DevelopmentRole; instruction: string; schema: ToolSchema;
  payload: UnknownRecord; tools?: RegisteredTool[]; allowBlocker?: boolean; validate(value: unknown): T;
  delivery?: UnknownRecord; diagnose?(value: unknown, error: unknown): SubmissionIssue[] }

export function readDevelopmentWorkCheckpoint(value: unknown, sessions?: Record<string, DevelopmentSessionReference>): DevelopmentWorkCheckpoint {
  const raw = objectFields(value);
  const keys = Object.keys(raw).sort().join(), hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const currentKeys = ["bindingHash", "dispatch", "materialHash", "version", ...(Object.hasOwn(raw, "originalAccounting") ? ["originalAccounting"] : []),
    ...(Object.hasOwn(raw, "submissionReplays") ? ["submissionReplays"] : [])].sort().join();
  if (!hash(raw.bindingHash) || !(raw.version === 1 && keys === "bindingHash,dispatch,version"
    || raw.version === 2 && hash(raw.materialHash) && keys === currentKeys))
    throw new InputError("研发分组检查点无效，不能重新领取额度。");
  const dispatch = readDevelopmentTaskCheckpoint(raw.dispatch);
  if (dispatch.bindingHash !== raw.bindingHash) throw new InputError("研发分组绑定不一致。");
  if (raw.version === 1) return { version: 1, bindingHash: String(raw.bindingHash), dispatch };
  if (raw.originalAccounting !== undefined) {
    if (!Array.isArray(raw.originalAccounting) || raw.originalAccounting.length !== dispatch.issues.length
      || repairHash(raw.originalAccounting.map(row => objectFields(row).id).sort()) !== repairHash(dispatch.issues.map(row => row.id).sort())
      || raw.originalAccounting.some(row => { const entry = objectFields(row); return Object.keys(entry).some(key => !["id", "remaining", "omitUnresolved"].includes(key))
        || entry.omitUnresolved !== undefined && (entry.omitUnresolved !== true || !dispatch.previousQuota); })) throw new InputError("研发历史计量绑定无效。");
  } else if (raw.bindingHash !== raw.materialHash) throw new InputError("研发历史计量绑定缺失。");
  const submissionReplays = readDevelopmentSubmissionReplays(raw.submissionReplays, dispatch, sessions);
  return { version: 2, bindingHash: String(raw.bindingHash), materialHash: String(raw.materialHash), dispatch,
    ...(submissionReplays ? { submissionReplays } : {}),
    ...(raw.originalAccounting === undefined ? {} : { originalAccounting: structuredClone(raw.originalAccounting) as AccountingSnapshot[] }) };
}

function materialIdentity(identity: WorkIdentity) {
  const result = structuredClone(identity);
  for (const part of result.assignments) delete part.payload.remaining;
  return result;
}

function originalIdentity(material: WorkIdentity, accounting: AccountingSnapshot[]) {
  const result = structuredClone(material);
  for (const part of result.assignments) {
    const row = accounting.find(row => row.id === part.id);
    if (!row) throw new InputError("研发历史计量绑定缺少原分组。");
    if (Object.hasOwn(row, "remaining")) part.payload.remaining = structuredClone(row.remaining);
    if (row.omitUnresolved) delete part.payload.unresolvedIssues;
  }
  return result;
}

/** Only recover accounting from a bound native opening; the old full hash must still match. */
async function historicalIdentity(controller: DevelopmentController, ctx: DevelopmentContext, key: string,
  identity: WorkIdentity, checkpoint: DevelopmentWorkCheckpoint): Promise<WorkIdentity> {
  for (const part of identity.assignments) {
    const group = checkpoint.dispatch.groups.find(group => group.issueIds.includes(part.id));
    if (!group?.sessionFile || !group.inputHash) continue;
    const binding = developmentSessionBinding(ctx.record, part.role, { work: key, bindingHash: checkpoint.bindingHash, partId: part.id, baseHash: group.inputHash });
    const sessionKey = repairHash(binding), reference = ctx.record.sessions?.[sessionKey];
    if (!reference || reference.bindingHash !== sessionKey || reference.role !== part.role || reference.file !== group.sessionFile) continue;
    const directory = await controller.storage.directory(ctx.record.agentId, `development/sessions/${ctx.record.id}/${sessionKey}`);
    const cwd = await controller.workspace.workspacePath(ctx.record.agentId, ctx.record.id);
    const native = await readExecutionHistory({ cwd, storage: { directory, file: reference.file, binding }, signal: ctx.signal });
    for (const { message } of native.entries) {
      if (message.role !== "user") continue;
      const content = typeof message.content === "string" ? message.content : Array.isArray(message.content)
        ? message.content.filter(block => block.type === "text").map(block => objectFields(block).text).join("\n") : "";
      let opening: UnknownRecord;
      try { opening = objectFields(JSON.parse(content)); } catch { continue; }
      if (objectFields(opening.workAssignment).id !== part.id) continue;
      const recovered = structuredClone(identity);
      for (const assignment of recovered.assignments) {
        delete assignment.payload.remaining;
        if (Object.hasOwn(opening, "remaining")) assignment.payload.remaining = structuredClone(opening.remaining);
      }
      if (repairHash(recovered) === checkpoint.bindingHash) return recovered;
      break;
    }
  }
  throw new InputError("研发分组材料已变化或原会话计量无法核验，原会话、结果和次数保留。");
}

/** Fixed assignments, independent sessions, bounded concurrency, and results accepted before merging. */
export async function runDevelopmentParts<T>(controller: DevelopmentController, ctx: DevelopmentContext, key: string,
  binding: unknown, parts: DevelopmentPart<T>[], callLimit = 6, validateCombined?: (results: T[]) => unknown): Promise<T[]> {
  const supplied: WorkIdentity = JSON.parse(JSON.stringify({ binding, assignments: parts.map(part => ({ id: part.id, role: part.role, schema: part.schema,
    instruction: part.instruction, payload: part.payload, allowBlocker: part.allowBlocker === true })), callLimit }));
  const material = materialIdentity(supplied), materialHash = repairHash(material);
  let identity = material;
  const base = { parts: Object.fromEntries(parts.map(part => [part.id, null])) };
  const issues = parts.map(part => ({ id: part.id, owner: part.id, paths: [`/parts/${part.id}`],
    description: part.instruction, remedy: "只提交本组结果，其他分组由独立会话处理。" }));
  const saved = ctx.record.workDispatches?.[key];
  let checkpoint: DevelopmentWorkCheckpoint;
  if (saved) {
    checkpoint = readDevelopmentWorkCheckpoint(saved, ctx.record.sessions);
    if (!ctx.record.dispatchedWork?.includes(key) || repairHash(checkpoint.dispatch.issues) !== repairHash(issues))
      throw new InputError("研发分组材料已变化，不能重建会话刷新额度。");
    if (checkpoint.version === 1) {
      identity = supplied;
      let omitUnresolved = false;
      if (repairHash(identity) !== checkpoint.bindingHash && checkpoint.dispatch.previousQuota && ctx.record.retryPolicy) {
        const legacy = structuredClone(supplied);
        for (const part of legacy.assignments) {
          delete part.payload.unresolvedIssues;
          part.payload.remaining = structuredClone(ctx.record.retryPolicy.legacy.budgets);
        }
        if (repairHash(legacy) === checkpoint.bindingHash) { identity = legacy; omitUnresolved = true; }
      }
      if (repairHash(identity) !== checkpoint.bindingHash) identity = await historicalIdentity(controller, ctx, key, supplied, checkpoint);
      const originalAccounting = identity.assignments.map(part => ({ id: part.id,
        ...(Object.hasOwn(part.payload, "remaining") ? { remaining: structuredClone(part.payload.remaining) } : {}),
        ...(omitUnresolved ? { omitUnresolved: true as const } : {}) }));
      checkpoint = { version: 2, bindingHash: checkpoint.bindingHash, materialHash, originalAccounting, dispatch: checkpoint.dispatch };
    } else {
      if (checkpoint.materialHash !== materialHash) throw new InputError("研发分组材料已变化，不能重建会话刷新额度。");
      if (checkpoint.originalAccounting) identity = originalIdentity(material, checkpoint.originalAccounting);
    }
    if (repairHash(identity) !== checkpoint.bindingHash) throw new InputError("研发历史计量与原材料绑定不一致。");
  } else {
    if (ctx.record.dispatchedWork?.includes(key)) throw new InputError("已分派研发的检查点缺失，不能重新领取额度。");
    checkpoint = { version: 2, bindingHash: materialHash, materialHash, dispatch: createDevelopmentTaskCheckpoint(identity, base, issues) };
  }
  const bindingHash = checkpoint.bindingHash;
  const validate = (value: unknown, final = false) => {
    const values = objectFields(objectFields(value).parts);
    if (Object.keys(objectFields(value)).join() !== "parts" || repairHash(Object.keys(values).sort()) !== repairHash(parts.map(part => part.id).sort()))
      throw new InputError("研发分组结果范围不一致。");
    for (const part of parts) if (values[part.id] !== null) part.validate(values[part.id]);
    if (final && validateCombined) try { validateCombined(parts.map(part => part.validate(values[part.id]))); }
    catch (error) {
      if (!(error instanceof InputError)) throw error;
      throw Object.assign(new InputError(`分组规划合并检查未通过：${error.message}`), { reason: "planning_assembly_invalid",
        repairGroupIds: checkpoint.dispatch.groups.map(group => group.id) });
    }
    return values;
  };
  if (saved) {
    const replay = await prepareDevelopmentSubmissionReplay(controller, ctx, key, checkpoint, parts, base, validate);
    if (replay) {
      await controller.current(ctx);
      const previous = ctx.record.workDispatches![key]!, references = Object.fromEntries(Object.keys(replay.sessions).map(id => [id, ctx.record.sessions![id]!]));
      Object.assign(ctx.record.sessions!, replay.sessions);
      ctx.record.workDispatches![key] = replay.checkpoint;
      try { await controller.save(ctx); }
      catch (error) { ctx.record.workDispatches![key] = previous; Object.assign(ctx.record.sessions!, references); throw error; }
      checkpoint = replay.checkpoint;
      ctx.onProgress({ type: "status", phase: ctx.record.phase, label: "原会话最后提交的格式已由程序还原并通过完整校验，原用量和退回记录保留…" });
    }
  }
  let result: unknown;
  for (;;) try {
  result = await runDevelopmentTaskSchedule({ checkpoint: checkpoint.dispatch, binding: identity, base, signal: ctx.signal,
    validateCandidate: validate,
    onInvalidMerge: async (_ids, receiptHash, phase) => {
      // Rechecking an already recorded result is not another formal submission.
      if (phase === "saved" || parts.every(part => part.role === "reviewer")) return;
      const count = noteDevelopmentRejection(ctx.record, "plan", { work: key, receiptHash });
      await controller.save(ctx);
      if (count >= developmentContentLimit(ctx.record, "plan")) throw Object.assign(new InputError(`规划已累计${count}次内容退回，分组结果、会话及用量保留。`),
        { diagnostic: { stage: "development", phase: ctx.record.phase, reason: "content_rejection_limit", owner: "plan", attempts: count } });
    },
    save: async dispatch => {
      controller.guard(ctx);
      checkpoint = { ...checkpoint, dispatch };
      (ctx.record.workDispatches ??= {})[key] = checkpoint;
      if (!(ctx.record.dispatchedWork ??= []).includes(key)) ctx.record.dispatchedWork.push(key);
      await controller.save(ctx);
    },
    run: async worker => {
      const part = parts.find(part => worker.group.issueIds.includes(part.id));
      if (!part) throw new InputError("研发分组责任不存在。");
      ctx.onProgress({ type: "status", phase: ctx.record.phase,
        label: `${part.role === "reviewer" ? "正在分组检查研发成果" : "正在分组规划研发工作"}（${parts.indexOf(part) + 1}/${parts.length}）…` });
      const counter = { turns: worker.group.calls };
      const handle = await controller.role(ctx, { kind: part.role, counter, limit: worker.callLimit,
        scope: { work: key, bindingHash, partId: part.id, baseHash: worker.baseHash },
        submission: { name: part.role === "reviewer" ? "submit_development_review_part" : "submit_development_plan_part",
          schema: part.schema, instruction: part.instruction }, blocker: part.allowBlocker === true, compaction: false, tools: part.tools ?? [],
        onModelCall: event => worker.onCall(event.retryAttempt),
        ...(part.diagnose ? { diagnose: part.diagnose } : {}),
        validate: async value => {
          const checked = part.validate(value);
          await worker.submit({ baseHash: worker.baseHash, issueIds: worker.group.issueIds, summary: `已提交${part.id}，仍需程序合并检查`,
            updates: [{ path: `/parts/${part.id}`, value: checked }] });
          return checked;
        } });
      try {
        if (!handle.session.sessionFile) throw new InputError("研发子会话没有可恢复的历史引用。");
        await worker.onSession(basename(handle.session.sessionFile));
        const accepted = await controller.ask(ctx, handle, { ...part.payload, ...part.delivery, workAssignment: { id: part.id, instruction: part.instruction },
          ...(worker.group.history?.length ? { feedback: { reason: worker.group.history.at(-1)!.reason } } : {}) });
        if (isPlanningBlockerOutcome(accepted)) throw new InputError("规划技术阻断已保存，等待上游条件变化。");
        delete handle.reference.pendingResult;
        await controller.save(ctx);
      } finally { await controller.dispose(ctx, handle); }
    } });
    break;
  } catch (error) {
    controller.guard(ctx);
    if (!(error instanceof InputError) || error.reason !== "planning_assembly_invalid") throw error;
  }
  const values = validate(result);
  return parts.map(part => part.validate(values[part.id]));
}
