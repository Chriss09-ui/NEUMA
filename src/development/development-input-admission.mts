import type { DevelopmentArchitecture, DevelopmentPlan } from "../contracts/development.mjs";
import type { SubmissionIssue } from "./development-diagnostics.mjs";
import { InputError } from "../requirements/core.mjs";
import { isPlainRecord, objectFields } from "../runtime/type-boundary.mjs";
import { validateActionInput } from "../applications/application-contract.mjs";

export class PlanningInputConflict extends InputError {
  constructor(readonly issues: SubmissionIssue[]) {
    super(issues[0]?.reason === "planning_input_conflict"
      ? `planning_input_conflict：${issues.map(row => `${row.referenceId}（${row.inputPath}）`).join("、")} 的原样本会被入口拒绝，无法执行约定的业务代码。请在原规划会话修正输入输出契约，使用平台支持的原始数据容器承接待校验内容，保留业务限制、原验收目标与错误返回。样本及预期按 design.acceptance 对应编号读取。`
      : issues.map(row => `${row.path} [${row.reason}]：${row.remedy}`).join("；"));
  }
}

/** Only literal samples for an unambiguous public input are comparable; prose and transport mappings are not guessed. */
export function checkPlanningInputAdmission(plan: Pick<DevelopmentPlan, "application" | "tasks">, architecture: DevelopmentArchitecture) {
  const actions = plan.application?.actions;
  if (actions?.length !== 1) return;
  const action = actions[0]!, schema = action.inputSchema;
  if (schema.type !== "object") return;
  const assigned = new Set(plan.tasks.flatMap(task => task.acceptanceIds)), issues: SubmissionIssue[] = [];
  for (const entry of architecture.design?.acceptance ?? []) {
    const item = objectFields(entry), verification = objectFields(item.verification);
    if (typeof item.id !== "string" || !assigned.has(item.id) || verification.adapterId !== "action" || verification.stage !== "development"
      || typeof item.input !== "string" || item.input.length > 8000) continue;
    let input: unknown;
    try { input = JSON.parse(item.input); } catch { continue; }
    if (!isPlainRecord(input) || !Object.keys(input).length || Object.keys(input).some(key => !Object.hasOwn(schema.properties ?? {}, key))) continue;
    try { validateActionInput(action, input); }
    catch (error) {
      if (!(error instanceof InputError)) throw error;
      const failure = objectFields(objectFields(error).validationIssue);
      if (typeof failure.path !== "string" || !/^input\.[A-Za-z0-9_.]+$/.test(failure.path)) continue;
      issues.push({ path: "plan.application.actions[0].inputSchema", reason: "planning_input_conflict", referenceId: item.id,
        inputPath: failure.path, inputReason: failure.reason,
        remedy: `验收 ${item.id} 要求业务代码处理输入，但 ${failure.path} 被入口拒绝。由规划者修正输入传递并核对错误返回，保留业务限制和验收目标；原文按 design.acceptance 对应编号读取。` });
      if (issues.length === 12) break;
    }
  }
  if (issues.length) throw new PlanningInputConflict(issues);
}
