import type { DesignCheckpoint, DesignPipelineContext } from "./architecture-design-pipeline.mjs";
import type { ArchitectureModule } from "../contracts/architecture-stages.mjs";
import { CAPABILITIES } from "./architecture-contract.mjs";
import { architectureGlobalIssues, architectureCapabilityIssues } from "./architecture-stage-semantics.mjs";
import type { StageSemanticIssue } from "./architecture-stage-semantics.mjs";
import { readArchitectureBlueprintStructure, readArchitectureModuleStructure, architectureModuleLayers, architectureModuleCapacities } from "./architecture-design-stages.mjs";
import { architectureModuleObligationIssues } from "./architecture-module-obligations.mjs";

/** Audit readable old results before deciding who must repair them. Never edits their contents. */
export function architectureStageRepairPlan(checkpoint: DesignCheckpoint, context: DesignPipelineContext) {
  if (checkpoint.blueprint.result === null) return null;
  const blueprint = readArchitectureBlueprintStructure(checkpoint.blueprint.result, context);
  const issues: Record<string, StageSemanticIssue[]> = {};
  const global = architectureGlobalIssues(blueprint.global, context, "blueprint.global", true);
  if (global.length) issues.blueprint = global;
  const verified: ArchitectureModule[] = [];
  for (const layer of architectureModuleLayers(blueprint)) for (const assignment of layer) {
    const entry = checkpoint.modules.find(item => item.key === assignment.id);
    if (!entry || entry.result === null) continue;
    const module = readArchitectureModuleStructure(entry.result, { ...context, blueprint, assignment, dependencyModules: verified });
    verified.push(module);
    const local = architectureCapabilityIssues(module.capabilities, context.capabilities ?? CAPABILITIES, "module");
    if (local.length) issues[assignment.id] = local;
  }
  for (const module of verified) {
    const local = architectureModuleObligationIssues(module, blueprint, context, verified);
    if (local.length) (issues[module.moduleId] ??= []).push(...local);
  }
  const capacity = architectureModuleCapacities(blueprint, context.candidateSchema);
  for (const field of ["components", "steps", "decisions", "acceptance", "platformClaims", "failureHandling", "unknowns"] as const) {
    const maximum = context.candidateSchema.properties?.[field]?.maxItems;
    const reserved = ["components", "steps", "acceptance"].includes(field) ? blueprint.modules.length - verified.length : 0;
    if (maximum === undefined || verified.reduce((sum, module) => sum + (module[field]?.length ?? 0), 0) + reserved <= maximum) continue;
    for (const module of verified) if ((module[field]?.length ?? 0) > capacity[module.moduleId]![field]!)
      (issues[module.moduleId] ??= []).push({ path: `module.${field}`, reason: "size_limit",
        message: `已保存${field}与其他待办的最少${reserved}条预留超出${maximum}条；本模块参考额度为${capacity[module.moduleId]![field]}。合并重复表达并保留完整需求和验收义务，不能截断或删除业务承诺。` });
  }
  if (!Object.keys(issues).length) return null;
  const owners = new Set(Object.keys(issues));
  if (owners.has("blueprint")) blueprint.modules.forEach(item => owners.add(item.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of blueprint.modules) if (!owners.has(item.id) && item.dependsOn.some(id => owners.has(id))) {
      owners.add(item.id); changed = true;
    }
  }
  owners.add("integration");
  return { issues, targets: [checkpoint.blueprint, ...checkpoint.modules, checkpoint.integration].map(item => item.key).filter(key => owners.has(key)) };
}
