import { basename } from "node:path";
import type { ToolSchema } from "../contracts/tools.mjs";
import type { UnknownRecord } from "../contracts/json.mjs";
import type { RegisteredTool } from "../runtime/execution-port.mjs";
import { createRepairCheckpoint, readRepairCheckpoint, repairHash, runRepairSchedule, type RepairCheckpoint } from "../runtime/repair-scheduler.mjs";
import { objectFields } from "../runtime/type-boundary.mjs";
import { InputError } from "../requirements/core.mjs";
import type { DevelopmentController } from "./development.mjs";
import type { DevelopmentContext, DevelopmentRole } from "./development-controller-types.mjs";
import { isPlanningBlockerOutcome } from "./development-planning-blocker.mjs";

export interface DevelopmentWorkCheckpoint { version: 1; bindingHash: string; dispatch: RepairCheckpoint }
export interface DevelopmentPart<T> { id: string; role: DevelopmentRole; instruction: string; schema: ToolSchema;
  payload: UnknownRecord; tools?: RegisteredTool[]; allowBlocker?: boolean; validate(value: unknown): T }

export function readDevelopmentWorkCheckpoint(value: unknown): DevelopmentWorkCheckpoint {
  const raw = objectFields(value);
  if (Object.keys(raw).sort().join() !== "bindingHash,dispatch,version" || raw.version !== 1 || typeof raw.bindingHash !== "string")
    throw new InputError("研发分组检查点无效，不能重新领取额度。");
  const dispatch = readRepairCheckpoint(raw.dispatch);
  if (dispatch.version !== 2 || dispatch.bindingHash !== raw.bindingHash) throw new InputError("研发分组绑定不一致。");
  return { version: 1, bindingHash: raw.bindingHash, dispatch };
}

/** Fixed assignments, independent sessions, bounded concurrency, and results accepted before merging. */
export async function runDevelopmentParts<T>(controller: DevelopmentController, ctx: DevelopmentContext, key: string,
  binding: unknown, parts: DevelopmentPart<T>[], callLimit = 6, validateCombined?: (results: T[]) => unknown): Promise<T[]> {
  const identity: unknown = JSON.parse(JSON.stringify({ binding, assignments: parts.map(part => ({ id: part.id, role: part.role, schema: part.schema,
    instruction: part.instruction, payload: part.payload, allowBlocker: part.allowBlocker === true })), callLimit }));
  const bindingHash = repairHash(identity), base = { parts: Object.fromEntries(parts.map(part => [part.id, null])) };
  const issues = parts.map(part => ({ id: part.id, owner: part.id, paths: [`/parts/${part.id}`],
    description: part.instruction, remedy: "只提交本组结果，其他分组由独立会话处理。" }));
  const saved = ctx.record.workDispatches?.[key];
  let checkpoint: DevelopmentWorkCheckpoint;
  if (saved) {
    checkpoint = readDevelopmentWorkCheckpoint(saved);
    if (checkpoint.bindingHash !== bindingHash || !ctx.record.dispatchedWork?.includes(key)
      || repairHash(checkpoint.dispatch.issues) !== repairHash(issues)) throw new InputError("研发分组材料已变化，不能重建会话刷新额度。");
  } else {
    if (ctx.record.dispatchedWork?.includes(key)) throw new InputError("已分派研发的检查点缺失，不能重新领取额度。");
    checkpoint = { version: 1, bindingHash, dispatch: createRepairCheckpoint(identity, base, issues, callLimit, 2) };
  }
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
  let result: unknown;
  for (;;) try {
  result = await runRepairSchedule({ checkpoint: checkpoint.dispatch, binding: identity, base, signal: ctx.signal,
    validateCandidate: validate,
    save: async dispatch => {
      controller.guard(ctx);
      (ctx.record.workDispatches ??= {})[key] = { version: 1, bindingHash, dispatch };
      if (!(ctx.record.dispatchedWork ??= []).includes(key)) ctx.record.dispatchedWork.push(key);
      await controller.save(ctx);
      checkpoint = { version: 1, bindingHash, dispatch };
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
        validate: async value => {
          const checked = part.validate(value);
          await worker.submit({ baseHash: worker.baseHash, issueIds: worker.group.issueIds, summary: `已提交${part.id}，仍需程序合并检查`,
            updates: [{ path: `/parts/${part.id}`, value: checked }] });
          return checked;
        } });
      try {
        if (!handle.session.sessionFile) throw new InputError("研发子会话没有可恢复的历史引用。");
        await worker.onSession(basename(handle.session.sessionFile));
        const accepted = await controller.ask(ctx, handle, { ...part.payload, workAssignment: { id: part.id, instruction: part.instruction },
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
