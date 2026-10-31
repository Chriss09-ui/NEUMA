import type { ArchitectureBlueprint, ArchitectureModule, ArchitectureModuleObligations, StageSchemaOptions } from "../contracts/architecture-stages.mjs";
import type { DevelopmentArchitecture } from "../contracts/development.mjs";
import { requiredArchitectureAcceptanceKinds, type StageSemanticIssue } from "./architecture-stage-semantics.mjs";
import type { ArchitectureAcceptance } from "../contracts/architecture.mjs";
import { requiredActionAcceptanceRequirementIds, requiredAcceptanceStages, validateAcceptanceVerification } from "../verification/acceptance-contract.mjs";

export const MODULE_OBLIGATION_RULE = "moduleObligations由冻结分工与最终校验规则生成，不是新增业务需求。必须完成本模块acceptanceKinds、minimumItems、actionRequirementIds和stageRequirements；验收只引用自己主责编号。conditionalAcceptanceKinds在本模块实际选用对话之外能力时必须补齐；处理办法不能替代具体输入、可观察预期及正确验证阶段的验收用例。其他模块承担的义务不必重复。";

/** Derived obligations have explicit owners without changing the frozen blueprint or its wire schema. */
export function architectureModuleObligations(blueprint: ArchitectureBlueprint, context: StageSchemaOptions, knownModules: readonly ArchitectureModule[] = []) {
  const first = blueprint.modules[0]!.id, last = blueprint.modules.at(-1)!.id;
  const owner = (requirementId: string, fallback: string) => blueprint.modules.find(module => module.requirementIds.includes(requirementId))?.id ?? fallback;
  const input = owner("inputSource", first), task = owner("task", first), delivery = owner("deliverable", owner("task", last));
  const result: Record<string, ArchitectureModuleObligations> = Object.fromEntries(blueprint.modules.map(module => [module.id, {
    moduleId: module.id, acceptanceKinds: [], conditionalAcceptanceKinds: [], minimumItems: {}, actionRequirementIds: [], stageRequirements: [],
  }]));
  const kindOwners: Record<ArchitectureAcceptance["kind"], string> = { success: task, missing_input: input,
    boundary: owner("inputSource", last), tool_failure: delivery };
  const kinds = requiredArchitectureAcceptanceKinds([]);
  const usesCode = blueprint.global.execution?.language !== undefined && blueprint.global.execution.language !== "none";
  const plannedExecution = usesCode || blueprint.global.connections?.some(connection => connection.purpose === "business");
  if (plannedExecution) kinds.push("tool_failure");
  for (const kind of kinds) result[kindOwners[kind]]!.acceptanceKinds.push(kind);
  if (!plannedExecution) for (const assignment of blueprint.modules) {
    const selected = knownModules.find(module => module.moduleId === assignment.id)?.capabilities ?? [];
    (requiredArchitectureAcceptanceKinds(selected).includes("tool_failure")
      ? result[assignment.id]!.acceptanceKinds : result[assignment.id]!.conditionalAcceptanceKinds).push("tool_failure");
  }
  for (const [field, id] of [["capabilities", input], ["decisions", owner("task", last)], ["failureHandling", delivery]] as const) {
    const minimum = context.candidateSchema.properties?.[field]?.minItems ?? 0;
    if (minimum) result[id]!.minimumItems[field] = minimum;
  }
  const coverage: Pick<DevelopmentArchitecture, "requirements" | "draft" | "deferredVerifications"> = {
    requirements: context.requirements ?? [],
    ...(context.draft === undefined ? {} : { draft: context.draft as NonNullable<DevelopmentArchitecture["draft"]> }),
    ...(context.deferredVerifications === undefined ? {} : { deferredVerifications: context.deferredVerifications as Exclude<DevelopmentArchitecture["deferredVerifications"], undefined> }),
  };
  const actionIds = blueprint.global.interaction?.operations ? requiredActionAcceptanceRequirementIds(coverage) : [];
  const stages = requiredAcceptanceStages(coverage);
  for (const assignment of blueprint.modules) {
    result[assignment.id]!.actionRequirementIds = actionIds.filter(id => assignment.requirementIds.includes(id));
    result[assignment.id]!.stageRequirements = stages.filter(item => assignment.requirementIds.includes(item.requirementId));
  }
  return result;
}

export function architectureModuleObligationIssues(module: ArchitectureModule, blueprint: ArchitectureBlueprint, context: StageSchemaOptions,
  knownModules: readonly ArchitectureModule[] = [module]): StageSemanticIssue[] {
  const obligations = architectureModuleObligations(blueprint, context, knownModules)[module.moduleId]!;
  const issues: StageSemanticIssue[] = [];
  const add = (issue: StageSemanticIssue) => issues.push({ ...issue, ownerModuleId: module.moduleId });
  for (const [field, minimum] of Object.entries(obligations.minimumItems)) if (module[field as keyof typeof obligations.minimumItems].length < minimum!)
    add({ path: `module.${field}`, reason: "missing_coverage", message: `本模块负责${field}的至少${minimum}项，当前缺项；请补齐实际内容。` });
  const missingKinds = obligations.acceptanceKinds.filter(kind => !module.acceptance.some(item => item.kind === kind));
  if (missingKinds.length && module.acceptance.length) add({ path: "module.acceptance", reason: "missing_acceptance_kind", missingKinds: [...missingKinds],
    message: `本模块负责的验收类型缺少${missingKinds.join("、")}，需提供具体输入、预期与验证分工。` });
  const actionMissing = obligations.actionRequirementIds.filter(id => !module.acceptance.some(item => {
    const verification = validateAcceptanceVerification(item);
    return item.requirementIds.includes(id) && verification.stage === "development" && verification.adapterId === "action";
  }));
  if (actionMissing.length) add({ path: "module.acceptance", reason: "missing_coverage", missingReferences: actionMissing,
    message: "本模块的业务操作要求缺少研发阶段的真实动作验收，不能全部转成静态评审或运行期对话观察。" });
  const stageMissing = obligations.stageRequirements.filter(required => !module.acceptance.some(item =>
    item.requirementIds.includes(required.requirementId) && validateAcceptanceVerification(item).stage === required.stage));
  if (stageMissing.length) add({ path: "module.acceptance", reason: "missing_coverage", missingReferences: stageMissing.map(item => item.requirementId),
    message: "本模块的后续验证义务缺少原阶段验收，不能仅保留编号而改签阶段。" });
  return issues;
}
