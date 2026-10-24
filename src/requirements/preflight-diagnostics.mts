import { objectFields, isArray, isInteger } from "../runtime/type-boundary.mjs";
import { safeCalculationPath, safeCalculationRejection } from "./requirement-calculations.mjs";

const reasons = new Set([
  "candidate_shape", "dimension_check_invalid", "issue_shape", "runtime_blocking", "system_stage_missing", "system_review_missing", "stage_blocking_conflict", "check_reference_invalid", "verdict_conflict",
  "decision_shape", "decision_reference_invalid", "decision_evidence_channel_invalid", "decision_owner_invalid", "decision_stage_invalid", "decision_evidence_invalid", "decision_evidence_missing",
  "decision_reopen_without_change", "decision_coverage_missing", "stage_requirement_missing", "stage_evidence_missing", "stage_binding_invalid", "system_resolution_invalid",
  "model_invalid_json", "model_api_failed", "system_verification_completed", "system_verification_failed", "system_verification_cancelled", "system_verifier_unavailable", "read_budget_exhausted",
  "research_requested", "research_completed", "research_failed", "research_request_invalid", "research_unavailable", "open_decision_omitted", "resolved_decision_repeated",
  "decision_owner_conflict", "unverified_issue_omitted", "stage_revision_required", "budget_exhausted", "validation_rejected",
  "calculation_requested", "calculation_completed", "calculation_failed", "calculation_shape_invalid", "calculation_size_limit", "calculation_reference_invalid",
  "calculation_value_invalid", "calculation_integer_invalid", "calculation_complexity_limit", "calculation_operator_invalid", "calculation_division_by_zero",
  "calculation_integer_limit", "calculation_binding_invalid",
  "system_basis_stale", "calculation_history_reused", "calculation_history_invalidated",
]);
const paths = new Set(["verdict", "direction", "adequacy", "dimensionChecks", "issues", "issues[].owner", "issues[].stage", "issues[].blocking", "issues[].checks",
  "decisions", "decisions[].issueId", "decisions[].owner", "decisions[].stage", "decisions[].checks", "decisions[].evidence", "decisions[].derivationIds",
  "deferredIssues", "systemChecks", "research", "calculate", "derivations"]);
const fields = new Map<string, [string, string[]]>([
  ["架构预评估结果格式无效", ["candidate_shape", ["verdict", "direction", "adequacy", "dimensionChecks", "issues"]]],
  ["架构预评估缺少有效的通用维度判断", ["dimension_check_invalid", ["dimensionChecks"]]],
  ["架构预评估问题格式无效", ["issue_shape", ["issues"]]],
  ["运行时输入问题不能阻断创建", ["runtime_blocking", ["issues[].blocking"]]],
  ["系统问题必须明确当前或后续阶段", ["system_stage_missing", ["issues[].stage"]]],
  ["系统决定必须明确当前或后续阶段", ["system_stage_missing", ["decisions[].stage"]]],
  ["系统事项必须逐项独立复核并保留阶段交接", ["system_review_missing", ["issues", "decisions", "deferredIssues"]]],
  ["问题阶段或当前阻断状态不一致", ["stage_blocking_conflict", ["issues[].stage", "issues[].blocking"]]],
  ["系统核实引用必须来自受控检查目录，且只用于系统问题", ["check_reference_invalid", ["issues[].checks"]]],
  ["架构预评估结论与待解决问题不一致", ["verdict_conflict", ["verdict", "issues[].blocking"]]],
  ["问题解决记录格式无效", ["decision_shape", ["decisions"]]],
  ["问题解决记录缺少对应问题或依据", ["decision_reference_invalid", ["decisions[].issueId", "decisions[].evidence"]]],
  ["技术事项关闭必须明确当前阶段并有可信核实，运行时事项不能冒充已执行", ["system_resolution_invalid", ["decisions[].owner", "decisions[].stage"]]],
  ["后续验收事项不能以平台事实核实关闭", ["system_resolution_invalid", ["decisions[].owner", "decisions[].stage"]]],
  ["问题阶段归属无效", ["decision_stage_invalid", ["decisions[].stage"]]],
  ["阶段核实只能引用受控平台检查", ["check_reference_invalid", ["decisions[].checks"]]],
  ["后续验收义务必须绑定需求和平台核实引用", ["stage_requirement_missing", ["decisions[].checks", "deferredIssues"]]],
  ["尚未核实当前平台可承载，不能把真实能力缺口后移到研发或激活", ["stage_evidence_missing", ["decisions[].checks", "systemChecks"]]],
  ["系统事实只能通过checks引用，evidence必须为空数组", ["decision_evidence_channel_invalid", ["decisions[].evidence", "decisions[].checks"]]],
  ["问题解决依据无法核对，不能把建议或虚构回答当作决定", ["decision_evidence_invalid", ["decisions[].evidence"]]],
  ["关闭或重新打开问题必须保留实际依据", ["decision_evidence_missing", ["decisions[].evidence"]]],
  ["已解决问题只有出现相关新依据才能重新打开", ["decision_reopen_without_change", ["decisions[].evidence"]]],
  ["必须复核每一个待解决问题", ["decision_coverage_missing", ["decisions"]]],
  ["计算复核必须引用同问题的有效推导编号", ["calculation_reference_invalid", ["decisions[].derivationIds"]]],
  ["计算推导必须保留独立复核决定", ["calculation_reference_invalid", ["decisions[].derivationIds"]]],
]);
export function preflightRejection(input: unknown, fallback = "validation_rejected") {
  const error = objectFields(input);
  const calculation = typeof error.reason === "string" && reasons.has(error.reason) && error.reason.startsWith("calculation_") ? safeCalculationRejection(error.reject) : null;
  const [reason, rejectedPaths] = fields.get(typeof error.message === "string" ? error.message : "") ?? (typeof error.reason === "string" && reasons.has(error.reason) && error.reason.startsWith("calculation_")
    ? [error.reason, calculation ? [calculation.path] : ["derivations"]] : [fallback, []]);
  return { reason: reasons.has(reason) ? reason : "validation_rejected", paths: rejectedPaths };
}
export function safePreflightDiagnostic(input: unknown) {
  const value = objectFields(input);
  if (!value || value.version !== 1) return null;
  const bounded = (number: unknown, max: number) => isInteger(number) && number >= 0 && number <= max ? number : 0;
  const receipts = (items: unknown) => (isArray(items) ? items : []).filter((id) => typeof id === "string" && /^calculation_[a-f0-9]{32}$/.test(id)).slice(0, 60);
  return { version: 1, modelTurns: bounded(value.modelTurns, 6), readOnlyCalls: bounded(value.readOnlyCalls, 2),
    researchCalls: bounded(value.researchCalls, 2), systemVerificationCalls: bounded(value.systemVerificationCalls, 2),
    ...(typeof value.calculationCalls === "number" && value.calculationCalls > 0 ? { calculationCalls: bounded(value.calculationCalls, 2) } : {}),
    ...(typeof value.correctiveContinuations === "number" && value.correctiveContinuations > 0 ? { correctiveContinuations: bounded(value.correctiveContinuations, 1) } : {}),
    ...(value.reusedDerivationIds ? { reusedDerivationIds: receipts(value.reusedDerivationIds) } : {}),
    ...(value.invalidatedDerivationIds ? { invalidatedDerivationIds: receipts(value.invalidatedDerivationIds) } : {}),
    ...(["system_basis_stale", "capability_blocked", "needs_input", "sufficient", "budget_exhausted", "model_invalid_json", "model_api_failed", "cancelled"].some(reason => reason === value.stopReason) ? { stopReason: value.stopReason } : {}),
    ...(isArray(value.pendingActions) ? { pendingActions: value.pendingActions.map(objectFields).filter((item) => item && typeof item.issueId === "string"
      && /^[A-Za-z0-9_.:-]{1,120}$/.test(item.issueId) && ["calculate", "verify_facts", "research", "review"].some(kind => kind === item.kind))
      .slice(0, 24).map(({ issueId, kind }) => ({ issueId, kind })) } : {}),
    events: (isArray(value.events) ? value.events : []).filter((event) => event && typeof event === "object").slice(-32).map(objectFields).map((event) => ({
      turn: bounded(event.turn, 6), role: ["assessment", "issue_review", "research", "system", "calculation", "controller"].some(role => role === event.role) ? event.role : "controller",
      reason: typeof event.reason === "string" && reasons.has(event.reason) ? event.reason : "validation_rejected",
      paths: (isArray(event.paths) ? event.paths : []).filter((path): path is string => typeof path === "string" && (paths.has(path) || Boolean(safeCalculationPath(path)))).slice(0, 8),
      issueIds: (isArray(event.issueIds) ? event.issueIds : []).filter((id) => typeof id === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(id)).slice(0, 24),
    })) };
}
