import type { UnknownRecord } from "../contracts/json.mjs";
import type { RequirementItem } from "../contracts/architecture.mjs";
import type { ArchitectureBlueprint, BlueprintAssignment, ArchitectureModule, ResolvedArchitectureModule, CandidateDraft, StageReference, ArchitectureConflict, StageSchema, StageSchemaOptions, StageAssemblyOptions } from "../contracts/architecture-stages.mjs";
import { objectFields } from "../runtime/type-boundary.mjs";
import { isDeepStrictEqual } from "node:util";
import { InputError } from "../requirements/core.mjs";
import { ARCHITECTURE_MODULE_LIMIT, CAPABILITIES, designHash, normalizeArchitectureDecisionReferences, assertStageSemantics } from "./architecture-contract.mjs";
import { architectureGlobalIssues, architectureCapabilityIssues, type StageSemanticIssue } from "./architecture-stage-semantics.mjs";
import { copyArchitectureReviewJson } from "./architecture-review-binding.mjs";
import { architectureToolValidation } from "./architecture-tool-diagnostics.mjs";

const PART_FIELDS = ["components", "steps", "capabilities", "failureHandling", "decisions", "coverage", "acceptance", "unknowns", "platformClaims"] as const;
const LOCAL_ID_FIELDS = ["decisions", "acceptance", "platformClaims"] as const;
const DERIVED_FIELDS = new Set(["instructions", "failureHandling", "coverage", "acceptance", "unknowns"]);
const identifier = { type: "string", minLength: 1, maxLength: 80, pattern: "^[A-Za-z][A-Za-z0-9_-]*$" };
const hash = { type: "string", pattern: "^[a-f0-9]{64}$" };
const text = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const list = <T extends StageSchema>(items: T, minItems = 0, maxItems = 80) => ({ type: "array", items, minItems, maxItems, uniqueItems: true });
const object = <T extends Record<string, StageSchema>>(properties: T, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
function fail(path: string, reason: string, message: string): never { throw Object.assign(new InputError(message), { validationIssue: { path, reason } }); }

function copy<T>(value: T, path = "designStage", maxBytes = 512 * 1024) {
  try { return copyArchitectureReviewJson(value, { maxDepth: 32, maxNodes: 100_000, maxBytes }); }
  catch { fail(path, "invalid_type", "架构阶段成果必须是有界普通JSON，不能包含会话、访问器或循环引用。"); }
}

function checked(value: unknown, schema: StageSchema, path: string) {
  const result = copy(value, path), feedback = architectureToolValidation(result, schema, { root: path });
  if (!feedback.valid) throw Object.assign(new InputError("架构阶段提交结构无效：" + JSON.stringify(feedback)), {
    validationIssue: feedback.issues[0], validationIssues: feedback.issues,
  });
  return result;
}

function equalIds(actual: string[], expected: string[], path: string) {
  if (actual.length !== expected.length || new Set(actual).size !== actual.length
    || actual.some((id) => !expected.includes(id))) fail(path, "invalid_reference", "阶段成果必须完整保留本模块已冻结的编号，不能遗漏、重复或跨模块占用。");
}

/** Bounded diagnostics only: never infer an owner, repair a candidate, or relax validation. */
export function diagnoseBlueprintAssignments(input: unknown, requirements: RequirementItem[], moduleLimit = ARCHITECTURE_MODULE_LIMIT) {
  let value: UnknownRecord;
  try { value = objectFields(copy(input, "blueprint")); } catch { return null; }
  const modules = value.modules;
  const safeId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(id);
  if (!Array.isArray(modules) || !modules.length || modules.length > moduleLimit) return null;
  const owners = new Map<string, number[]>();
  for (const [index, raw] of modules.entries()) {
    const ids = objectFields(raw).requirementIds;
    if (!Array.isArray(ids) || ids.length > Math.max(80, requirements.length) || !ids.every(safeId)) return null;
    for (const id of ids) owners.set(id, [...(owners.get(id) ?? []), index]);
  }
  const expected = new Set(requirements.map(item => item.id));
  const globalIds = objectFields(objectFields(value.global).selectionBasis).requirementIds;
  const global = new Set(Array.isArray(globalIds) ? globalIds.filter(safeId) : []);
  const missing = [...expected].filter(id => !owners.has(id)).map(id => ({ id, referencedGlobally: global.has(id) }));
  const describe = ([id, indexes]: [string, number[]]) => ({ id, moduleIndexes: [...new Set(indexes)], occurrences: indexes.length });
  const duplicates = [...owners].filter(([, indexes]) => indexes.length > 1).map(describe);
  const unknown = [...owners].filter(([id]) => !expected.has(id)).map(describe);
  if (!missing.length && !duplicates.length && !unknown.length) return null;
  // Bound each category independently so a large missing list cannot hide every duplicate/unknown.
  const bounded = <T,>(rows: T[]) => {
    let characters = 0;
    return rows.filter(row => { const size = JSON.stringify(row).length; if (characters + size > 1800) return false; characters += size; return true; });
  };
  const retained = { missing: bounded(missing), duplicates: bounded(duplicates), unknown: bounded(unknown) };
  return { requiredCount: requirements.length, assignedCount: [...owners.values()].reduce((sum, indexes) => sum + indexes.length, 0),
    ...retained, totals: { missing: missing.length, duplicates: duplicates.length, unknown: unknown.length },
    truncated: retained.missing.length < missing.length || retained.duplicates.length < duplicates.length || retained.unknown.length < unknown.length };
}

function unique(items: unknown[], path: string, field: string | null = "id"): string[] {
  const ids = items.map((entry) => field ? objectFields(entry)[field] : entry);
  const seen = new Map<unknown, number>();
  for (const [index, id] of ids.entries()) {
    if (seen.has(id)) fail(`${path}[${index}]${field ? `.${field}` : ""}`, "duplicate_id",
      `${path}的第${seen.get(id)! + 1}项与第${index + 1}项编号重复；同一模块内的编号必须唯一。`);
    seen.set(id, index);
  }
  return ids as string[];
}

function scopeLocalIds(modules: ArchitectureModule[], legacyBlueprint: boolean): ResolvedArchitectureModule[] {
  const fields = legacyBlueprint ? LOCAL_ID_FIELDS : ["components", "steps", ...LOCAL_ID_FIELDS] as const;
  const maps = modules.map(() => Object.fromEntries(fields.map(field => [field, new Map<string, string>()])));
  for (const field of fields) {
    const counts = new Map<string, number>();
    for (const module of modules) for (const row of module[field] ?? []) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
    const reserved = new Set(counts.keys());
    for (const [index, module] of modules.entries()) for (const row of module[field] ?? []) {
      if (counts.get(row.id)! < 2) continue;
      const stem = `${module.moduleId}__${row.id}`;
      let scoped;
      for (let attempt = 0; attempt <= reserved.size; attempt++) {
        const candidate = !attempt && stem.length <= 80 ? stem
          : `${stem.slice(0, 59)}_${designHash({ moduleId: module.moduleId, field, id: row.id, attempt }).slice(0, 20)}`;
        if (!reserved.has(candidate)) { scoped = candidate; break; }
      }
      if (!scoped) fail(`candidate.${field}`, "size_limit", "无法在编号长度限制内分配唯一模块编号。");
      reserved.add(scoped); maps[index]![field]!.set(row.id, scoped);
    }
  }
  const resolve = (index: number, field: "components" | "steps", reference: StageReference) => {
    const owner = typeof reference === "string" ? index : modules.findIndex(module => module.moduleId === reference.moduleId);
    const id = typeof reference === "string" ? reference : reference.id;
    return maps[owner]![field]!.get(id) ?? id;
  };
  for (const [index, module] of modules.entries()) {
    for (const field of fields) for (const row of module[field] ?? []) row.id = maps[index]![field]!.get(row.id) ?? row.id;
    if (!legacyBlueprint) {
      for (const step of module.steps) {
        step.componentId = resolve(index, "components", step.componentId);
        step.dependsOn = step.dependsOn.map(ref => resolve(index, "steps", ref));
      }
      for (const row of module.coverage) row.componentIds = row.componentIds.map(ref => resolve(index, "components", ref));
    }
    for (const claim of module.platformClaims ?? []) {
      claim.decisionIds = claim.decisionIds.map(id => maps[index]!.decisions!.get(id) ?? id);
      claim.acceptanceIds = claim.acceptanceIds.map(id => maps[index]!.acceptance!.get(id) ?? id);
    }
  }
  return modules as ResolvedArchitectureModule[];
}

function acyclic(items: { id: string; dependsOn: string[] }[], path: string) {
  const entries = new Map(items.map((entry) => [entry.id, entry.dependsOn])), visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) fail(path, "invalid_reference", "阶段依赖不能形成循环。");
    if (visited.has(id)) return;
    if (!entries.has(id)) fail(path, "invalid_reference", "阶段依赖只能引用已冻结的编号。");
    visiting.add(id); entries.get(id)!.forEach(visit); visiting.delete(id); visited.add(id);
  };
  entries.forEach((_entry, id) => visit(id));
}

export function architectureModuleLayers(blueprint: ArchitectureBlueprint) {
  const pending = [...blueprint.modules], completed = new Set(), layers = [];
  while (pending.length) {
    const ready = pending.filter(module => module.dependsOn.every(id => completed.has(id)));
    if (!ready.length) fail("blueprint.modules.dependsOn", "invalid_reference", "模块依赖不存在或形成循环。");
    layers.push(ready);
    for (const module of ready) { completed.add(module.id); pending.splice(pending.indexOf(module), 1); }
  }
  return layers;
}

/** Allocate final array capacity before independent writers start; the sum never exceeds the final contract. */
export function architectureModuleCapacities(blueprint: ArchitectureBlueprint, candidateSchema: StageSchema, completed: ArchitectureModule[] = []) {
  const allocations: Record<string, Record<string, number>> = Object.fromEntries(blueprint.modules.map(module => [module.id, {}]));
  const pending = blueprint.modules.filter(module => !completed.some(saved => saved.moduleId === module.id));
  for (const field of PART_FIELDS.filter(field => field !== "coverage")) {
    const maximum = candidateSchema.properties?.[field]?.maxItems;
    if (maximum === undefined) continue;
    const frozen = field === "components" ? "componentIds" : field === "steps" ? "stepIds" : null;
    // v1/v2 already froze these allocations in the blueprint; repartitioning can make their valid submissions impossible.
    if (frozen && blueprint.modules.every(module => Array.isArray(module[frozen]))) {
      for (const module of blueprint.modules) allocations[module.id]![field] = module[frozen]!.length;
      continue;
    }
    for (const module of completed) allocations[module.moduleId]![field] = module[field]?.length ?? 0;
    if (!pending.length) continue;
    const used = completed.reduce((sum, module) => sum + (module[field]?.length ?? 0), 0);
    const available = Math.max(0, maximum - used);
    const weights = pending.map(module => module.requirementIds.length), total = weights.reduce((sum, value) => sum + value, 0);
    // A short requirement may still need several checks; give every owner an equal floor before weighting the remainder.
    const minimum = Math.floor(available / weights.length);
    const remaining = available - minimum * weights.length;
    const shares = weights.map(weight => minimum + Math.floor(remaining * weight / total));
    let unused = available - shares.reduce((sum, value) => sum + value, 0);
    for (const index of weights.map((_, index) => index).sort((a, b) => (remaining * weights[b]! % total) - (remaining * weights[a]! % total) || a - b))
      if (unused-- > 0) shares[index]!++;
    pending.forEach((module, index) => { allocations[module.id]![field] = shares[index]!; });
  }
  return allocations;
}

/** Derive the current writer's wire contract without changing the checkpoint's frozen stage schema. */
export function architectureModuleSubmissionSchema(schema: StageSchema, assignment: BlueprintAssignment, limits: Record<string, number>): StageSchema {
  const result = copy(schema);
  for (const [field, limit] of Object.entries(limits)) if (result.properties?.[field]) result.properties[field]!.maxItems = limit;
  const coverage = result.properties?.coverage?.items?.properties?.requirementId;
  const acceptance = result.properties?.acceptance?.items?.properties?.requirementIds?.items;
  if (!coverage || !acceptance) throw new TypeError("模块提交契约缺少正式需求引用字段");
  for (const reference of [coverage, acceptance]) {
    reference.enum = [...assignment.requirementIds];
    reference.description = "仅使用本模块assignment.requirementIds中的正式需求编号；其他模块的要求和后续验证义务只供理解与配合，不能在本模块认领。";
  }
  return result;
}

/** Each wire schema derives its business fields from this build's actual final contract. */
export function createArchitectureStageSchemas({ candidateSchema, requirements = [], legacyBlueprint = false, moduleLimit }: StageSchemaOptions) {
  const source = copy(candidateSchema, "candidateSchema", 2 * 1024 * 1024);
  if (!source.properties || !Array.isArray(source.required)) throw new TypeError("架构阶段需要完整候选提交契约");
  const properties: Record<string, StageSchema> = Object.fromEntries(Object.entries(source.properties).filter(([key]) => !PART_FIELDS.some(field => field === key)));
  properties.instructions = { ...properties.instructions, maxLength: Math.min(2000, properties.instructions?.maxLength ?? 2000) };
  const ids = requirements.map((entry) => entry.id);
  const requirementId = ids.length ? { ...identifier, enum: ids } : identifier;
  const maximum = Math.max(80, ids.length);
  const modulesMaximum = moduleLimit ?? ARCHITECTURE_MODULE_LIMIT;
  if (!Number.isSafeInteger(modulesMaximum) || modulesMaximum < 1 || modulesMaximum > 6) throw new TypeError("模块分派上限无效");
  const responsibilityLimit = moduleLimit === undefined ? maximum : Math.min(maximum, Math.max(24, Math.ceil(ids.length / modulesMaximum)));
  const blueprint = object({ global: object(properties, source.required.filter((key) => !PART_FIELDS.some(field => field === key))), modules: list(object({
    id: identifier, purpose: text(2000), requirementIds: list(requirementId, 1, responsibilityLimit),
    ...(legacyBlueprint ? { componentIds: list(identifier, 1, source.properties!.components!.maxItems ?? 80),
      stepIds: list(identifier, 1, source.properties!.steps!.maxItems ?? 80) } : {}),
    dependsOn: list(identifier, 0, modulesMaximum - 1), inputs: text(2000), outputs: text(2000),
  }), 1, modulesMaximum) });
  const partProperties: Record<string, StageSchema> = Object.fromEntries(PART_FIELDS.filter((key) => source.properties![key]).map((key) =>
    [key, { ...source.properties![key], minItems: 0 }]));
  if (!legacyBlueprint) {
    const reference = { anyOf: [identifier, object({ moduleId: identifier, id: identifier })] };
    partProperties.components!.minItems = partProperties.steps!.minItems = 1;
    partProperties.steps!.items!.properties!.dependsOn!.items = reference;
    partProperties.coverage!.items!.properties!.componentIds!.items = reference;
  }
  const module = object({ moduleId: identifier, blueprintHash: hash, instructions: text(3000), ...partProperties } as Record<string, StageSchema> & { moduleId: typeof identifier; blueprintHash: typeof hash; instructions: ReturnType<typeof text> },
    ["moduleId", "blueprintHash", "instructions", ...source.required.filter((key) => PART_FIELDS.some(field => field === key))]);
  const integration = object({ baseHash: hash, updates: { type: "array", minItems: 0, maxItems: 24, items: object({
    path: { type: "string", minLength: 1, maxLength: 500 }, value: {},
  }) } });
  return { blueprint, module, integration };
}

/** Read persisted structural evidence without pretending it passed today's semantic checks. */
export function readArchitectureBlueprintStructure(value: unknown, { candidateSchema, requirements = [], legacyBlueprint = false, moduleLimit }: StageSchemaOptions): ArchitectureBlueprint {
  const allocation = diagnoseBlueprintAssignments(value, requirements, moduleLimit);
  let blueprint: ArchitectureBlueprint;
  try { blueprint = checked(value, createArchitectureStageSchemas({ candidateSchema, requirements, legacyBlueprint, moduleLimit }).blueprint, "blueprint") as ArchitectureBlueprint; }
  catch (error) {
    if (error instanceof InputError && allocation) Object.assign(error, { blueprintAllocation: allocation });
    throw error;
  }
  const ids = unique(blueprint.modules, "blueprint.modules");
  if (allocation) throw Object.assign(new InputError(`蓝图需求主责分配未完成：缺少${allocation.totals.missing}个编号，${allocation.totals.duplicates}个编号重复分配，${allocation.totals.unknown}个编号不属于本轮需求。全局选型依据不能替代模块主责分配。`), {
    validationIssue: { path: "blueprint.modules.requirementIds", reason: "invalid_reference" }, blueprintAllocation: allocation,
  });
  equalIds(blueprint.modules.flatMap((entry) => entry.requirementIds), requirements.map((entry) => entry.id), "blueprint.modules.requirementIds");
  for (const field of legacyBlueprint ? ["componentIds", "stepIds"] as const : []) {
    const declared = blueprint.modules.flatMap((entry) => entry[field]!);
    unique(declared, `blueprint.modules.${field}`, null);
    const maximum = candidateSchema.properties![field === "componentIds" ? "components" : "steps"]!.maxItems ?? 80;
    if (declared.length > maximum) fail(`blueprint.modules.${field}`, "size_limit", "蓝图的全部模块编号合计超过最终候选契约的条数限制。");
  }
  for (const [index, assignment] of blueprint.modules.entries()) if (assignment.dependsOn.some((id) => !ids.includes(id) || id === assignment.id))
    fail(`blueprint.modules[${index}].dependsOn`, "invalid_reference", "模块依赖只能引用其他已声明模块。");
  acyclic(blueprint.modules, "blueprint.modules.dependsOn");
  return blueprint;
}

export function validateArchitectureBlueprint(value: unknown, context: StageSchemaOptions): ArchitectureBlueprint {
  const blueprint = readArchitectureBlueprintStructure(value, context);
  assertStageSemantics(architectureGlobalIssues(blueprint.global, context, "blueprint.global", true));
  return blueprint;
}

function moduleOptions(blueprint: ArchitectureBlueprint, assignment: BlueprintAssignment, dependencyModules: ArchitectureModule[], legacyBlueprint: boolean) {
  const frozen = blueprint.modules.find((entry) => entry.id === assignment?.id);
  if (!frozen || !isDeepStrictEqual(frozen, assignment)) fail("module.assignment", "invalid_reference", "模块分工必须逐字匹配当前冻结蓝图。");
  if (!legacyBlueprint) {
    const dependencies = frozen.dependsOn.map(id => {
      const matches = dependencyModules.filter(module => module.moduleId === id);
      if (matches.length !== 1 || matches[0]!.blueprintHash !== designHash(blueprint))
        fail("module.dependencies", "invalid_reference", "依赖模块尚无绑定当前蓝图的已保存成果，不能猜测其组件或步骤。");
      return matches[0]!;
    });
    return { frozen, dependencies };
  }
  const dependencies = blueprint.modules.filter((entry) => frozen.dependsOn.includes(entry.id));
  return { frozen, componentIds: [frozen, ...dependencies].flatMap((entry) => entry.componentIds!),
    stepIds: [frozen, ...dependencies].flatMap((entry) => entry.stepIds!) };
}

type ModuleContext = StageSchemaOptions & { blueprint: ArchitectureBlueprint; assignment: BlueprintAssignment; dependencyModules?: ArchitectureModule[] };
export function readArchitectureModuleStructure(value: unknown, context: ModuleContext): ArchitectureModule { return readModule(value, context, false); }
function readModule(value: unknown, { blueprint, assignment, candidateSchema, requirements = [], legacyBlueprint = false, dependencyModules = [], capabilities, moduleLimit }: ModuleContext, semantic: boolean): ArchitectureModule {
  const frozenBlueprint = readArchitectureBlueprintStructure(blueprint, { candidateSchema, requirements, legacyBlueprint, moduleLimit });
  const { frozen, componentIds, stepIds, dependencies } = moduleOptions(frozenBlueprint, assignment, dependencyModules, legacyBlueprint);
  const module = checked(value, createArchitectureStageSchemas({ candidateSchema, requirements, legacyBlueprint }).module, "module") as ArchitectureModule;
  const issues: (StageSemanticIssue & { missingReferences?: string[] })[] = [];
  let total = 0;
  const add = (issue: StageSemanticIssue & { missingReferences?: string[] }) => { total++; if (issues.length < 64) issues.push(issue); };
  const check = (action: () => unknown) => {
    try { action(); } catch (error) {
      const issue = objectFields(objectFields(error).validationIssue);
      if (!(error instanceof InputError) || typeof issue.path !== "string" || typeof issue.reason !== "string") throw error;
      add({ path: issue.path, reason: issue.reason, message: error.message });
    }
  };
  if (module.moduleId !== frozen.id || module.blueprintHash !== designHash(frozenBlueprint))
    add({ path: "module.blueprintHash", reason: "invalid_reference", message: "模块成果不属于当前冻结蓝图或指定模块。" });
  const localComponents = module.components.map(row => row.id), localSteps = module.steps.map(row => row.id);
  check(() => unique(module.components, "module.components")); check(() => unique(module.steps, "module.steps"));
  if (legacyBlueprint) {
    check(() => equalIds(localComponents, frozen.componentIds!, "module.components"));
    check(() => equalIds(localSteps, frozen.stepIds!, "module.steps"));
  }
  const validReference = (reference: StageReference, field: "steps" | "components") => typeof reference === "string"
    ? (field === "steps" ? localSteps : localComponents).includes(reference)
    : dependencies!.some(dependency => dependency.moduleId === reference.moduleId && dependency[field].some(row => row.id === reference.id));
  check(() => equalIds(unique(module.coverage, "module.coverage", "requirementId"), frozen.requirementIds, "module.coverage"));
  for (const field of ["capabilities", "decisions", "acceptance", "platformClaims"] as const) if (module[field]) check(() => unique(module[field]!, `module.${field}`));
  const usedComponents = new Set();
  for (const [index, step] of module.steps.entries()) {
    if (!localComponents.includes(step.componentId)) add({ path: `module.steps[${index}].componentId`, reason: "invalid_reference", message: "模块步骤只能执行本模块负责的组件。" });
    usedComponents.add(step.componentId);
    if (step.dependsOn.some(ref => legacyBlueprint ? !stepIds!.some(id => id === ref) : !validReference(ref, "steps")))
      add({ path: `module.steps[${index}].dependsOn`, reason: "invalid_reference", message: "本模块步骤用本地编号引用；跨模块须以{moduleId,id}引用蓝图直接依赖模块已保存的真实步骤。" });
  }
  check(() => acyclic(module.steps.map((step) => ({ ...step, dependsOn: step.dependsOn.filter((id): id is string => typeof id === "string" && localSteps.includes(id)) })), "module.steps.dependsOn"));
  const unusedComponents = localComponents.filter(id => !usedComponents.has(id));
  if (unusedComponents.length) {
    const validationIssue = { path: "module.steps.componentId", reason: "component_unused",
      allowedReferences: localComponents, missingReferences: unusedComponents };
    add({ ...validationIssue, message: "模块步骤尚未使用全部已声明组件；请核对步骤与组件职责。" });
  }
  for (const [index, row] of module.coverage.entries()) if (row.componentIds.some(ref => legacyBlueprint ? !componentIds!.some(id => id === ref) : !validReference(ref, "components")))
    add({ path: `module.coverage[${index}].componentIds`, reason: "invalid_reference", message: "覆盖关系不能引用未授权的其他模块组件。" });
  const tested = new Set<string>();
  for (const [index, row] of module.acceptance.entries()) for (const id of row.requirementIds) {
    if (!frozen.requirementIds.includes(id)) add({ path: `module.acceptance[${index}].requirementIds`, reason: "invalid_reference", message: "模块验收只能承担本模块负责的正式需求。" });
    tested.add(id);
  }
  const missingReferences = frozen.requirementIds.filter((id) => !tested.has(id));
  if (missingReferences.length) {
    const validationIssue = { path: "module.acceptance", reason: "missing_coverage", allowedReferences: frozen.requirementIds, missingReferences };
    add({ ...validationIssue, message: "模块验收尚未覆盖全部主责需求。" });
  }
  const decisions = new Set(module.decisions.map((entry) => entry.id)), acceptance = new Set(module.acceptance.map((entry) => entry.id));
  for (const [index, claim] of (module.platformClaims ?? []).entries()) if (claim.decisionIds.some((id) => !decisions.has(id))
    || claim.acceptanceIds.some((id) => !acceptance.has(id)))
    add({ path: `module.platformClaims[${index}]`, reason: "invalid_reference", message: "平台依赖声明只能关联本模块的实际决策或验收编号。" });
  if (semantic) architectureCapabilityIssues(module.capabilities, capabilities ?? CAPABILITIES, "module").forEach(add);
  if (issues.length) {
    const { message: _message, ...firstIssue } = issues[0]!;
    throw Object.assign(new InputError("模块存在待修正问题：" + [...new Set(issues.map(issue => issue.message))].join("；").slice(0, 8000)), {
      validationIssue: firstIssue, validationIssues: issues, validationIssueTotal: total, validationIssuesTruncated: total > issues.length,
    });
  }
  return module;
}

export function validateArchitectureModule(value: unknown, context: StageSchemaOptions & { blueprint: ArchitectureBlueprint; assignment: BlueprintAssignment; dependencyModules?: ArchitectureModule[] }): ArchitectureModule {
  validateArchitectureBlueprint(context.blueprint, context);
  return readModule(value, context, true);
}

/** Merge verified partial results without asking another model to retype a complete design. */
export function assembleArchitectureCandidate(options: StageAssemblyOptions) { return assembleCandidate(options, true); }
export function readArchitectureAssemblyStructure(options: StageAssemblyOptions) { return assembleCandidate(options, false); }
function assembleCandidate({ blueprint, modules, candidateSchema, requirements = [], mergeCapabilityReasons = true,
  evidence = [], confirmedRequirementContext, deferredVerifications, legacyBlueprint = false, draft, capabilities, moduleLimit }: StageAssemblyOptions, semantic: boolean) {
  const checkBlueprint = semantic ? validateArchitectureBlueprint : readArchitectureBlueprintStructure;
  const checkModule = semantic ? validateArchitectureModule : readArchitectureModuleStructure;
  const frozen = checkBlueprint(blueprint, { candidateSchema, requirements, legacyBlueprint, draft, capabilities, moduleLimit });
  const source = copy(modules, "modules", 2 * 1024 * 1024);
  equalIds(unique(source, "modules", "moduleId"), frozen.modules.map((entry) => entry.id), "modules");
  const verified: ArchitectureModule[] = [];
  // Validate upstream results before using their actual interfaces for downstream references.
  for (const layer of architectureModuleLayers(frozen)) for (const assignment of layer)
    verified.push(checkModule(source.find(entry => entry.moduleId === assignment.id), {
      blueprint: frozen, assignment, candidateSchema, requirements, legacyBlueprint, dependencyModules: verified, draft, capabilities, moduleLimit,
    }));
  const ordered = scopeLocalIds(frozen.modules.map(assignment => verified.find(module => module.moduleId === assignment.id)!), legacyBlueprint);
  if (mergeCapabilityReasons) for (const module of ordered)
    module.decisions = normalizeArchitectureDecisionReferences(module.decisions, { evidence, confirmedRequirementContext, deferredVerifications, requirements });
  const candidate: Partial<CandidateDraft> = copy(frozen.global), conflicts: ArchitectureConflict[] = [];
  candidate.instructions = [frozen.global.instructions, ...ordered.map((entry) => entry.instructions)].join("\n");
  for (const field of PART_FIELDS.filter((key) => candidateSchema.properties![key])) {
    if (!candidateSchema.required!.includes(field) && !ordered.some((entry) => Object.hasOwn(entry, field))) continue;
    objectFields(candidate)[field] = ordered.flatMap((entry): unknown[] => entry[field] ?? []);
    if (field === "capabilities") {
      const rows: CandidateDraft["capabilities"] = [], known = new Map<string, { row: CandidateDraft["capabilities"][number]; reasons: string[]; index: number; moduleId: string }>();
      for (const entry of ordered) for (const row of entry.capabilities) {
        const previous = known.get(row.id);
        if (previous && isDeepStrictEqual(previous.row, row)) continue;
        if (mergeCapabilityReasons && previous?.row.status === row.status) {
          const reasons = [...new Set([...previous.reasons, row.reason])], reason = reasons.join("\n");
          const limit = candidateSchema.properties!.capabilities!.items!.properties!.reason!.maxLength!;
          if (Array.from(reason).length <= limit) {
            previous.row = { ...previous.row, reason }; previous.reasons = reasons;
            rows[previous.index] = previous.row; continue;
          }
        }
        if (previous) conflicts.push({ path: "/capabilities", reason: "capability_conflict",
          relatedPaths: [`/capabilities/${previous.index}`, `/capabilities/${rows.length}`], moduleIds: [previous.moduleId, entry.moduleId] });
        else known.set(row.id, { row, reasons: [row.reason], index: rows.length, moduleId: entry.moduleId });
        rows.push(row);
      }
      candidate[field] = rows;
    } else if (["components", "steps", "decisions", "acceptance", "platformClaims"].includes(field)) unique(candidate[field] as unknown[], `candidate.${field}`);
  }
  if (legacyBlueprint) {
    const componentOrder = frozen.modules.flatMap((entry) => entry.componentIds!), stepOrder = frozen.modules.flatMap((entry) => entry.stepIds!);
    candidate.components!.sort((a, b) => componentOrder.indexOf(a.id) - componentOrder.indexOf(b.id));
    candidate.steps!.sort((a, b) => stepOrder.indexOf(a.id) - stepOrder.indexOf(b.id));
  }
  acyclic(candidate.steps!, "candidate.steps.dependsOn");
  const feedback = architectureToolValidation(candidate, candidateSchema, { root: "candidate" });
  for (const issue of feedback.issues) {
    const field = issue.path.match(/^candidate\.([A-Za-z]+)/u)?.[1];
    if (!field || !DERIVED_FIELDS.has(field)) fail(issue.path, issue.reason, "模块合并后超过最终候选的结构限制，请修正负责模块。");
    if (!conflicts.some((entry) => entry.path === `/${field}` && entry.reason === issue.reason))
      conflicts.push({ path: `/${field}`, reason: issue.reason, relatedPaths: [`/${field}`], moduleIds: frozen.modules.map((entry) => entry.id) });
  }
  if (conflicts.length > 64) fail("integration.conflicts", "size_limit", "跨模块冲突超过一次可安全整合的范围，请先修正模块设计。");
  return { candidate: copy(candidate) as CandidateDraft, conflicts };
}

function target(candidate: unknown, path: string) {
  if (!path.startsWith("/") || /~(?![01])/u.test(path)) fail("integration.updates.path", "invalid_reference", "整合只允许规范JSON Pointer路径。");
  const parts = path.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  let value = candidate, parent: UnknownRecord | undefined, key: string | undefined;
  for (const part of parts) {
    if (["__proto__", "constructor", "prototype"].includes(part) || !value || typeof value !== "object"
      || Array.isArray(value) && (!/^(0|[1-9][0-9]*)$/u.test(part) || Number(part) >= value.length)
      || !Object.hasOwn(value, part)) fail("integration.updates.path", "invalid_reference", "整合只能替换当前候选已有的真实字段。");
    parent = objectFields(value); key = part; value = parent[part];
  }
  return { parent: parent!, key: key!, parts };
}

type IntegrationContext = StageAssemblyOptions & { candidate: CandidateDraft; conflicts?: ArchitectureConflict[] };
export function applyArchitectureIntegration(value: unknown, context: IntegrationContext) { return applyIntegration(value, context, true); }
export function readArchitectureIntegrationStructure(value: unknown, context: IntegrationContext) { return applyIntegration(value, context, false); }
function applyIntegration(value: unknown, { candidate, conflicts = [], candidateSchema, requirements = [], blueprint, modules, mergeCapabilityReasons = true,
  evidence = [], confirmedRequirementContext, deferredVerifications, legacyBlueprint = false, draft, capabilities, moduleLimit }: IntegrationContext, semantic: boolean) {
  const input = checked(value, createArchitectureStageSchemas({ candidateSchema, requirements }).integration, "integration") as { baseHash: string; updates: { path: string; value: unknown }[] };
  const original = copy(candidate), result = copy(candidate);
  if (input.baseHash !== designHash(original)) fail("integration.baseHash", "invalid_reference", "整合结果不属于当前已拼装候选。");
  // Reconstruct the base from its checked owners, rather than trusting a caller-supplied candidate.
  const assembled = assembleCandidate({ blueprint, modules, candidateSchema, requirements, mergeCapabilityReasons,
    evidence, confirmedRequirementContext, deferredVerifications, legacyBlueprint, draft, capabilities, moduleLimit }, semantic);
  if (!isDeepStrictEqual(original, assembled.candidate) || !isDeepStrictEqual(conflicts, assembled.conflicts))
    fail("integration.baseHash", "invalid_reference", "整合基底或冲突清单与当前模块成果不一致。");
  const permitted = new Set(conflicts.map((entry) => entry.path)), changed: string[] = [];
  const conflictAllows = (path: string) => [...permitted].some((allowed) => path === allowed || path.startsWith(allowed + "/"));
  for (const update of input.updates) {
    const location = target(result, update.path), root = location.parts[0]!;
    if (!DERIVED_FIELDS.has(root) && !conflictAllows(update.path))
      fail("integration.updates.path", "invalid_reference", "整合仅能修正明确冲突或派生的总指令、失败处理、覆盖、验收与未知项。");
    if (changed.some((path) => path === update.path || path.startsWith(update.path + "/") || update.path.startsWith(path + "/")))
      fail("integration.updates.path", "invalid_reference", "整合路径不能重复或互相覆盖。");
    changed.push(update.path); location.parent[location.key] = copy(update.value);
  }
  const feedback = architectureToolValidation(result, candidateSchema, { root: "candidate" });
  if (!feedback.valid) throw Object.assign(new InputError("整合后的完整候选仍未满足提交结构：" + JSON.stringify(feedback)), {
    validationIssue: feedback.issues[0], validationIssues: feedback.issues,
  });
  for (const field of Object.keys(blueprint.global).filter((key) => key !== "instructions")) if (!isDeepStrictEqual(objectFields(original)[field], objectFields(result)[field]))
    fail(`integration.${field}`, "invalid_reference", "整合不能改写蓝图中已冻结的全局约束。");
  for (const field of ["components", "steps"] as const) equalIds(result[field]?.map((entry) => entry.id) ?? [], original[field].map((entry) => entry.id), `integration.${field}`);
  for (const field of ["components", "steps"] as const) if (!isDeepStrictEqual(result[field], original[field]))
    fail(`integration.${field}`, "invalid_reference", "组件与步骤的变更须退回负责模块，整合不能重写模块成果。");
  equalIds(result.coverage?.map((entry) => entry.requirementId) ?? [], original.coverage.map((entry) => entry.requirementId), "integration.coverage");
  const components = new Set(result.components.map((entry) => entry.id)), requirementIds = new Set(requirements.map((entry) => entry.id));
  for (const row of original.coverage) {
    const current = result.coverage.find((entry) => entry.requirementId === row.requirementId)!;
    if (current.verification !== row.verification || row.componentIds.some((id) => !current.componentIds.includes(id)))
      fail("integration.coverage", "invalid_reference", "整合须保留模块原有需求覆盖与核验说明，只能补充已声明组件关联。");
  }
  for (const row of result.coverage) if (!Array.isArray(row.componentIds) || row.componentIds.some((id) => !components.has(id)))
    fail("integration.coverage.componentIds", "invalid_reference", "整合覆盖只能引用当前已冻结组件。");
  if (!legacyBlueprint) {
    const owners = new Map<string, string>(); let offset = 0;
    for (const assignment of blueprint.modules) {
      const count = modules.find(module => module.moduleId === assignment.id)!.components.length;
      for (const row of original.components.slice(offset, offset + count)) owners.set(row.id, assignment.id);
      offset += count;
    }
    for (const row of result.coverage) {
      const owner = blueprint.modules.find(module => module.requirementIds.includes(row.requirementId));
      if (!owner || row.componentIds.some(id => ![owner.id, ...owner.dependsOn].includes(owners.get(id) ?? "")))
        fail("integration.coverage.componentIds", "invalid_reference", "整合补充覆盖也必须遵守蓝图的直接模块依赖，不能跨模块越权引用。");
    }
  }
  for (const [index, row] of original.acceptance.entries()) {
    const current = result.acceptance?.find((entry) => entry.id === row.id);
    if (!current || !isDeepStrictEqual(current.requirementIds, row.requirementIds))
      fail("integration.acceptance", "invalid_reference", "整合不能移除模块已有验收或改变其需求归属。");
    if (!conflictAllows(`/acceptance/${index}`) && !isDeepStrictEqual(current, row))
      fail("integration.acceptance", "invalid_reference", "没有明确冲突时，整合必须保留模块已提交验收，只能追加跨模块场景。");
  }
  for (const field of ["failureHandling", "unknowns"] as const) if (!conflictAllows(`/${field}`)) {
    const remaining = [...result[field]];
    for (const row of original[field]) {
      const index = remaining.findIndex((entry) => isDeepStrictEqual(entry, row));
      if (index < 0) fail(`integration.${field}`, "invalid_reference", "没有明确冲突时，整合必须保留模块已保存的失败处理和未知项，只能追加交接说明。");
      remaining.splice(index, 1);
    }
  }
  for (const row of result.acceptance ?? []) if (!Array.isArray(row.requirementIds) || row.requirementIds.some((id) => !requirementIds.has(id)))
    fail("integration.acceptance.requirementIds", "invalid_reference", "跨模块验收只能引用当前正式需求。");
  for (const field of ["capabilities", "decisions", "acceptance", "platformClaims"] as const) if (result[field]) unique(result[field], `candidate.${field}`);
  return copy(result);
}
