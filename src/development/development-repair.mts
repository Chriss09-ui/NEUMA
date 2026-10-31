import type { DevelopmentPlan, DevelopmentReview } from "../contracts/development.mjs";
import type { DevelopmentController } from "./development.mjs";
import type { DevelopmentContext, VerificationFeedback, TaskProgress } from "./development-controller-types.mjs";
import type { DevelopmentSnapshot } from "./development-workspace.mjs";
import { inspectDevelopmentCode } from "./development-workspace.mjs";
import { createRepairCheckpoint, readRepairCheckpoint, runRepairSchedule, repairHash, repairPointer } from "../runtime/repair-scheduler.mjs";
import type { RepairCheckpoint, RepairIssue } from "../runtime/repair-scheduler.mjs";
import { runRepairAgent } from "../runtime/repair-agent.mjs";
import { developmentModelOutputBudget } from "../runtime/model-limits.mjs";
import { InputError } from "../requirements/core.mjs";
import { validatePlan } from "./development-contract.mjs";
import { renderPlatformRules } from "../architecture/platform-contract.mjs";
import { objectFields } from "../runtime/type-boundary.mjs";

export interface DevelopmentRepairBatch { checkpoint: RepairCheckpoint; snapshot?: DevelopmentSnapshot; applied: boolean }
type Feedback = { review: DevelopmentReview; report?: VerificationFeedback["report"] };

function issuesFor(plan: DevelopmentPlan, feedback: Feedback, kind: "plan" | "code", allowedFiles: string[]): RepairIssue[] {
  const rows: { id: string; description: string; remedy: string; taskIds?: string[]; files?: string[]; candidatePaths?: string[] }[] = feedback.review.issues
    .filter(issue => issue.blocking && !["architecture", "environment"].includes(issue.kind));
  const issues = rows.map(issue => ({ ...issue }));
  for (const result of feedback.report?.results ?? []) if (result.status === "failed") {
    const test = plan.cases.find(test => test.id === result.caseId);
    issues.push({ id: `case_${result.caseId}`, description: `冻结用例${result.caseId}未通过：${JSON.stringify(result).slice(0, 6000)}`,
      remedy: "修复实现，使原冻结输入和断言通过。", ...(test ? { taskIds: [test.taskId] } : {}) });
  }
  const owners = issues.map((issue, index) => {
    const tasks = plan.tasks.filter(task => issue.taskIds?.includes(task.id));
    return { tasks, owner: tasks.length ? tasks.map(task => task.id).sort().join("+") : issue.files?.length ? [...issue.files].sort().join("+") : `unassigned_${index}` };
  });
  return issues.map((issue, index) => {
    const tasks = plan.tasks.filter(task => issue.taskIds?.includes(task.id));
    const hintedFiles = [...new Set([...(issue.files ?? []), ...tasks.flatMap(task => task.files)])];
    if (issue.taskIds?.some(id => !plan.tasks.some(task => task.id === id)) || issue.files?.some(file => !plan.tasks.some(task => task.files.includes(file))))
      throw new InputError("修复意见引用了不存在的任务或文件。");
    let paths: string[];
    if (kind === "code") {
      const files = hintedFiles.length ? hintedFiles.filter(file => allowedFiles.includes(file)) : allowedFiles;
      if (!files.length) throw new InputError("修复问题超出当前任务文件授权，需要重新规划任务归属。");
      paths = files.map(file => `/files/${repairPointer(file)}`);
    } else {
      paths = issue.candidatePaths?.length ? issue.candidatePaths : tasks.length
        ? tasks.map(task => `/tasks/${plan.tasks.indexOf(task)}`) : Object.keys(plan).map(key => `/${key}`);
    }
    return { id: `finding_${index + 1}_${issue.id}`, description: issue.description, remedy: issue.remedy, paths,
      owner: owners[index]!.owner,
      afterOwners: owners.filter(other => other.owner !== owners[index]!.owner && other.tasks.some(upstream => tasks.some(task => task.dependsOn.includes(upstream.id)))).map(other => other.owner) };
  });
}

export function needsDevelopmentRepairDispatch(ctx: DevelopmentContext, feedback: Feedback): boolean {
  // A failed case and its reviewer explanation may describe the same single defect.
  return ctx.record.repairDispatchVersion === 1 && Math.max(feedback.review.issues.filter(issue => issue.blocking).length,
    feedback.report?.results.filter(result => result.status === "failed").length ?? 0) > 1;
}

async function dispatch(controller: DevelopmentController, ctx: DevelopmentContext, key: string, binding: unknown, base: unknown,
  issues: RepairIssue[], feedback: Feedback, snapshot?: DevelopmentSnapshot, validateCandidate?: (value: unknown) => unknown) {
  const batches = ctx.record.repairBatches ??= {};
  let batch = batches[key];
  if (!batch) {
    if (ctx.record.dispatchedRepairs?.includes(key)) throw new InputError("已分派修复的检查点缺失，不能重新领取额度。");
    batch = { checkpoint: createRepairCheckpoint(binding, base, issues, 12), ...(snapshot ? { snapshot } : {}), applied: false };
    (ctx.record.dispatchedRepairs ??= []).push(key);
    batches[key] = batch; await controller.save(ctx);
  } else {
    readRepairCheckpoint(batch.checkpoint);
    if (repairHash(batch.checkpoint.issues) !== repairHash(issues)) throw new InputError("修复分组与原问题不一致。");
  }
  const result = await runRepairSchedule({ checkpoint: batch.checkpoint, binding, base, signal: ctx.signal, validateCandidate,
    save: async checkpoint => { controller.guard(ctx); batch!.checkpoint = checkpoint; await controller.save(ctx); },
    run: async worker => {
      controller.guard(ctx);
      ctx.onProgress({ type: "status", phase: ctx.record.phase, label: `正在分组修复：${worker.group.id}，${worker.issues.length}个问题…` });
      return runRepairAgent({ worker, binding, config: controller.config, sessionFactory: controller.sessionFactory,
        cwd: await controller.workspace.workspacePath(ctx.record.agentId, ctx.record.id),
        dataDir: await controller.storage.directory(ctx.record.agentId, "", { create: true }),
        sessionDirectory: await controller.storage.directory(ctx.record.agentId, `development/repair-sessions/${ctx.record.id}/${key}`, { create: true }),
        signal: ctx.signal, maxOutputTokens: developmentModelOutputBudget(controller.config, "developer"),
        context: { requirements: ctx.record.architecture.requirements, design: ctx.record.architecture.design,
          runtimeCapabilities: ctx.record.architecture.runtimeCapabilities ?? null,
          platformRules: ctx.record.architecture.platformSnapshot ? renderPlatformRules(ctx.record.architecture.platformSnapshot,
            { runtimeCapabilities: ctx.record.architecture.runtimeCapabilities }) : "以当前需求、架构和真实平台契约为准。",
          plan: ctx.record.plan ?? null, task: ctx.record.tasks.find(task => task.id === ctx.record.currentTaskId) ?? null, feedback } });
    } });
  controller.guard(ctx); return result;
}

export async function repairDevelopmentPlan(controller: DevelopmentController, ctx: DevelopmentContext, plan: DevelopmentPlan, feedback: Feedback) {
  const binding = { runId: ctx.record.id, architectureRef: ctx.record.architectureRef, kind: "plan", planHash: repairHash(plan), feedbackHash: repairHash(feedback) };
  const key = repairHash(binding), issues = issuesFor(plan, feedback, "plan", []);
  const validate = (value: unknown) => validatePlan(value, {
    architecture: ctx.record.architecture, previousPlan: ctx.record.plan ?? undefined, freshWorkspace: ctx.planningWorkspace?.empty === true });
  const candidate = validate(await dispatch(controller, ctx, key, binding, plan, issues, feedback, undefined, validate));
  if (Number(candidate.schemaVersion) >= 2) {
    const saved = await controller.artifacts.saveRepairCandidate(ctx.record.agentId, ctx.record.id, candidate, { signal: ctx.signal });
    if (repairHash(saved.plan) !== repairHash(candidate)) throw new InputError("修复规划材料与候选不一致。");
    ctx.record.planningArtifact = saved.snapshot;
  }
  ctx.record.repairBatches![key]!.applied = true;
  ctx.record.pendingPlan = { plan: candidate, planHash: repairHash(candidate) };
  delete ctx.record.pendingPlanRepair;
  await controller.save(ctx); return candidate;
}

export async function repairDevelopmentCode(controller: DevelopmentController, ctx: DevelopmentContext, task: TaskProgress, feedback: VerificationFeedback) {
  const plan = ctx.record.plan!, binding = { runId: ctx.record.id, architectureRef: ctx.record.architectureRef,
    planHash: ctx.record.planHash, kind: "code", taskId: task.id, feedbackHash: repairHash(feedback) };
  const key = repairHash(binding), saved = ctx.record.repairBatches?.[key];
  const snapshot = saved?.snapshot ?? await controller.workspace.snapshot(ctx.record.agentId, ctx.record.id);
  if (saved && !saved.snapshot) throw new InputError("修复代码基底缺失。");
  const inspected = await inspectDevelopmentCode((await controller.workspace.validateSnapshot(snapshot, ctx.record.agentId)).path);
  const eligible = plan.tasks.filter(entry => entry.id === task.id || ctx.record.tasks.some(progress => progress.id === entry.id && progress.status === "verified"));
  const related = feedback.review.issues.filter(issue => issue.blocking).flatMap(issue => [
    ...(issue.files ?? []), ...plan.tasks.filter(entry => issue.taskIds?.includes(entry.id)).flatMap(entry => entry.files)]);
  for (const result of feedback.report.results.filter(result => result.status === "failed")) {
    const owner = plan.tasks.find(entry => entry.id === plan.cases.find(test => test.id === result.caseId)?.taskId);
    if (owner) related.push(...owner.files);
  }
  const allowedFiles = [...new Set([...task.files, ...related.filter(file => eligible.some(entry => entry.files.includes(file)))])];
  const files = Object.fromEntries([...inspected.contents].map(([path, content]) => [path, content.toString("utf8")]));
  for (const path of allowedFiles) files[path] ??= "";
  const validateFiles = (value: unknown) => {
    const proposed = objectFields(objectFields(value).files);
    if (Object.keys(proposed).length !== Object.keys(files).length || Object.entries(proposed).some(([path, content]) => !Object.hasOwn(files, path) || typeof content !== "string"))
      throw new InputError("修复代码文件集合不合法。");
  };
  const candidate = objectFields(await dispatch(controller, ctx, key, binding, { files }, issuesFor(plan, feedback, "code", allowedFiles), feedback, snapshot, validateFiles));
  const updated = objectFields(candidate.files);
  if (Object.keys(updated).length !== Object.keys(files).length || Object.entries(updated).some(([path, content]) => !Object.hasOwn(files, path) || typeof content !== "string"))
    throw new InputError("修复代码文件集合不合法。");
  const proposed = new Set(ctx.record.repairBatches![key]!.checkpoint.groups.flatMap(group => group.result?.updates.map(update => update.path) ?? []));
  for (const path of allowedFiles) if (!inspected.contents.has(path) && !proposed.has(`/files/${repairPointer(path)}`)) delete updated[path];
  ctx.record.snapshot = await controller.workspace.applyRepair(ctx.record.agentId, ctx.record.id, snapshot, updated as Record<string, string>, allowedFiles, ctx.signal);
  ctx.record.repairBatches![key]!.applied = true;
  task.nextAction = "verify";
  await controller.save(ctx);
}
