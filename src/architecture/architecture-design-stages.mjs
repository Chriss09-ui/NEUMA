import { isDeepStrictEqual } from "node:util";
import { InputError } from "../requirements/core.mjs";
import { ARCHITECTURE_MODULE_LIMIT, designHash, normalizeArchitectureDecisionReferences } from "./architecture-contract.mjs";
import { copyArchitectureReviewJson } from "./architecture-review-binding.mjs";
import { architectureToolValidation } from "./architecture-tool-diagnostics.mjs";

const PART_FIELDS = ["components", "steps", "capabilities", "failureHandling", "decisions", "coverage", "acceptance", "unknowns", "platformClaims"];
const LOCAL_ID_FIELDS = ["decisions", "acceptance", "platformClaims"];
const DERIVED_FIELDS = new Set(["instructions", "failureHandling", "coverage", "acceptance", "unknowns"]);
const identifier = { type: "string", minLength: 1, maxLength: 80, pattern: "^[A-Za-z][A-Za-z0-9_-]*$" };
const hash = { type: "string", pattern: "^[a-f0-9]{64}$" };
const text = (maxLength) => ({ type: "string", minLength: 1, maxLength });
const list = (items, minItems = 0, maxItems = 80) => ({ type: "array", items, minItems, maxItems, uniqueItems: true });
const object = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const fail = (path, reason, message) => { throw Object.assign(new InputError(message), { validationIssue: { path, reason } }); };

function copy(value, path = "designStage", maxBytes = 512 * 1024) {
  try { return copyArchitectureReviewJson(value, { maxDepth: 32, maxNodes: 100_000, maxBytes }); }
  catch { fail(path, "invalid_type", "架构阶段成果必须是有界普通JSON，不能包含会话、访问器或循环引用。"); }
}

function checked(value, schema, path) {
  const result = copy(value, path), feedback = architectureToolValidation(result, schema, { root: path });
  if (!feedback.valid) throw Object.assign(new InputError("架构阶段提交结构无效：" + JSON.stringify(feedback)), {
    validationIssue: feedback.issues[0], validationIssues: feedback.issues,
  });
  return result;
}

function equalIds(actual, expected, path) {
  if (actual.length !== expected.length || new Set(actual).size !== actual.length
    || actual.some((id) => !expected.includes(id))) fail(path, "invalid_reference", "阶段成果必须完整保留本模块已冻结的编号，不能遗漏、重复或跨模块占用。");
}

function unique(items, path, field = "id") {
  const ids = items.map((entry) => field ? entry[field] : entry);
  const seen = new Map();
  for (const [index, id] of ids.entries()) {
    if (seen.has(id)) fail(`${path}[${index}]${field ? `.${field}` : ""}`, "duplicate_id",
      `${path}的第${seen.get(id) + 1}项与第${index + 1}项编号重复；同一模块内的编号必须唯一。`);
    seen.set(id, index);
  }
  return ids;
}

function scopeLocalIds(modules) {
  const maps = modules.map(() => Object.fromEntries(LOCAL_ID_FIELDS.map(field => [field, new Map()])));
  for (const field of LOCAL_ID_FIELDS) {
    const counts = new Map();
    for (const module of modules) for (const row of module[field] ?? []) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
    const reserved = new Set(counts.keys());
    for (const [index, module] of modules.entries()) for (const row of module[field] ?? []) {
      if (counts.get(row.id) < 2) continue;
      const stem = `${module.moduleId}__${row.id}`;
      let scoped;
      for (let attempt = 0; attempt <= reserved.size; attempt++) {
        const candidate = !attempt && stem.length <= 80 ? stem
          : `${stem.slice(0, 59)}_${designHash({ moduleId: module.moduleId, field, id: row.id, attempt }).slice(0, 20)}`;
        if (!reserved.has(candidate)) { scoped = candidate; break; }
      }
      if (!scoped) fail(`candidate.${field}`, "size_limit", "无法在编号长度限制内分配唯一模块编号。");
      reserved.add(scoped); maps[index][field].set(row.id, scoped);
    }
  }
  for (const [index, module] of modules.entries()) {
    for (const field of LOCAL_ID_FIELDS) for (const row of module[field] ?? []) row.id = maps[index][field].get(row.id) ?? row.id;
    for (const claim of module.platformClaims ?? []) {
      claim.decisionIds = claim.decisionIds.map(id => maps[index].decisions.get(id) ?? id);
      claim.acceptanceIds = claim.acceptanceIds.map(id => maps[index].acceptance.get(id) ?? id);
    }
  }
  return modules;
}

function acyclic(items, path) {
  const entries = new Map(items.map((entry) => [entry.id, entry.dependsOn])), visiting = new Set(), visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) fail(path, "invalid_reference", "阶段依赖不能形成循环。");
    if (visited.has(id)) return;
    if (!entries.has(id)) fail(path, "invalid_reference", "阶段依赖只能引用已冻结的编号。");
    visiting.add(id); entries.get(id).forEach(visit); visiting.delete(id); visited.add(id);
  };
  entries.forEach((_entry, id) => visit(id));
}

/** Each wire schema derives its business fields from this build's actual final contract. */
export function createArchitectureStageSchemas({ candidateSchema, requirements = [] }) {
  const source = copy(candidateSchema, "candidateSchema", 2 * 1024 * 1024);
  if (!source.properties || !Array.isArray(source.required)) throw new TypeError("架构阶段需要完整候选提交契约");
  const properties = Object.fromEntries(Object.entries(source.properties).filter(([key]) => !PART_FIELDS.includes(key)));
  properties.instructions = { ...properties.instructions, maxLength: Math.min(2000, properties.instructions?.maxLength ?? 2000) };
  const ids = requirements.map((entry) => entry.id);
  const requirementId = ids.length ? { ...identifier, enum: ids } : identifier;
  const maximum = Math.max(80, ids.length);
  const blueprint = object({ global: object(properties, source.required.filter((key) => !PART_FIELDS.includes(key))), modules: list(object({
    id: identifier, purpose: text(2000), requirementIds: list(requirementId, 1, maximum),
    componentIds: list(identifier, 1, source.properties.components.maxItems ?? 80),
    stepIds: list(identifier, 1, source.properties.steps.maxItems ?? 80),
    dependsOn: list(identifier, 0, ARCHITECTURE_MODULE_LIMIT - 1), inputs: text(2000), outputs: text(2000),
  }), 1, ARCHITECTURE_MODULE_LIMIT) });
  const partProperties = Object.fromEntries(PART_FIELDS.filter((key) => source.properties[key]).map((key) =>
    [key, { ...source.properties[key], minItems: 0 }]));
  const module = object({ moduleId: identifier, blueprintHash: hash, instructions: text(3000), ...partProperties },
    ["moduleId", "blueprintHash", "instructions", ...source.required.filter((key) => PART_FIELDS.includes(key))]);
  const integration = object({ baseHash: hash, updates: { type: "array", minItems: 0, maxItems: 24, items: object({
    path: { type: "string", minLength: 1, maxLength: 500 }, value: {},
  }) } });
  return { blueprint, module, integration };
}

export function validateArchitectureBlueprint(value, { candidateSchema, requirements = [] }) {
  const blueprint = checked(value, createArchitectureStageSchemas({ candidateSchema, requirements }).blueprint, "blueprint");
  const ids = unique(blueprint.modules, "blueprint.modules");
  equalIds(blueprint.modules.flatMap((entry) => entry.requirementIds), requirements.map((entry) => entry.id), "blueprint.modules.requirementIds");
  for (const field of ["componentIds", "stepIds"]) {
    const declared = blueprint.modules.flatMap((entry) => entry[field]);
    unique(declared, `blueprint.modules.${field}`, null);
    const maximum = candidateSchema.properties[field === "componentIds" ? "components" : "steps"].maxItems ?? 80;
    if (declared.length > maximum) fail(`blueprint.modules.${field}`, "size_limit", "蓝图的全部模块编号合计超过最终候选契约的条数限制。");
  }
  for (const [index, assignment] of blueprint.modules.entries()) if (assignment.dependsOn.some((id) => !ids.includes(id) || id === assignment.id))
    fail(`blueprint.modules[${index}].dependsOn`, "invalid_reference", "模块依赖只能引用其他已声明模块。");
  acyclic(blueprint.modules, "blueprint.modules.dependsOn");
  return blueprint;
}

function moduleOptions(blueprint, assignment) {
  const frozen = blueprint.modules.find((entry) => entry.id === assignment?.id);
  if (!frozen || !isDeepStrictEqual(frozen, assignment)) fail("module.assignment", "invalid_reference", "模块分工必须逐字匹配当前冻结蓝图。");
  const dependencies = blueprint.modules.filter((entry) => frozen.dependsOn.includes(entry.id));
  return { frozen, componentIds: [frozen, ...dependencies].flatMap((entry) => entry.componentIds),
    stepIds: [frozen, ...dependencies].flatMap((entry) => entry.stepIds) };
}

export function validateArchitectureModule(value, { blueprint, assignment, candidateSchema, requirements = [] }) {
  const frozenBlueprint = validateArchitectureBlueprint(blueprint, { candidateSchema, requirements });
  const { frozen, componentIds, stepIds } = moduleOptions(frozenBlueprint, assignment);
  const module = checked(value, createArchitectureStageSchemas({ candidateSchema, requirements }).module, "module");
  if (module.moduleId !== frozen.id || module.blueprintHash !== designHash(frozenBlueprint))
    fail("module.blueprintHash", "invalid_reference", "模块成果不属于当前冻结蓝图或指定模块。");
  equalIds(unique(module.components, "module.components"), frozen.componentIds, "module.components");
  equalIds(unique(module.steps, "module.steps"), frozen.stepIds, "module.steps");
  equalIds(unique(module.coverage, "module.coverage", "requirementId"), frozen.requirementIds, "module.coverage");
  for (const field of ["capabilities", "decisions", "acceptance", "platformClaims"]) if (module[field]) unique(module[field], `module.${field}`);
  const usedComponents = new Set();
  for (const [index, step] of module.steps.entries()) {
    if (!frozen.componentIds.includes(step.componentId)) fail(`module.steps[${index}].componentId`, "invalid_reference", "模块步骤只能执行本模块负责的组件。");
    usedComponents.add(step.componentId);
    if (step.dependsOn.some((id) => !stepIds.includes(id)))
      fail(`module.steps[${index}].dependsOn`, "invalid_reference", "步骤只能依赖本模块或蓝图明确依赖模块的已声明步骤。");
  }
  acyclic(module.steps.map((step) => ({ ...step, dependsOn: step.dependsOn.filter((id) => frozen.stepIds.includes(id)) })), "module.steps.dependsOn");
  const unusedComponents = frozen.componentIds.filter(id => !usedComponents.has(id));
  if (unusedComponents.length) {
    const validationIssue = { path: "module.steps.componentId", reason: "component_unused",
      allowedReferences: frozen.componentIds, missingReferences: unusedComponents };
    throw Object.assign(new InputError("模块步骤尚未使用全部已声明组件；请核对步骤与组件职责，保留蓝图编号："
      + JSON.stringify(validationIssue)), { validationIssue });
  }
  for (const [index, row] of module.coverage.entries()) if (row.componentIds.some((id) => !componentIds.includes(id)))
    fail(`module.coverage[${index}].componentIds`, "invalid_reference", "覆盖关系不能引用未授权的其他模块组件。");
  const tested = new Set();
  for (const [index, row] of module.acceptance.entries()) for (const id of row.requirementIds) {
    if (!frozen.requirementIds.includes(id)) fail(`module.acceptance[${index}].requirementIds`, "invalid_reference", "模块验收只能承担本模块负责的正式需求。");
    tested.add(id);
  }
  const missingReferences = frozen.requirementIds.filter((id) => !tested.has(id));
  if (missingReferences.length) {
    const validationIssue = { path: "module.acceptance", reason: "missing_coverage", allowedReferences: frozen.requirementIds, missingReferences };
    throw Object.assign(new InputError("模块验收尚未覆盖全部主责需求：" + JSON.stringify(validationIssue)), { validationIssue });
  }
  equalIds([...tested], frozen.requirementIds, "module.acceptance.requirementIds");
  const decisions = new Set(module.decisions.map((entry) => entry.id)), acceptance = new Set(module.acceptance.map((entry) => entry.id));
  for (const [index, claim] of (module.platformClaims ?? []).entries()) if (claim.decisionIds.some((id) => !decisions.has(id))
    || claim.acceptanceIds.some((id) => !acceptance.has(id)))
    fail(`module.platformClaims[${index}]`, "invalid_reference", "平台依赖声明只能关联本模块的实际决策或验收编号。");
  return module;
}

/** Merge verified partial results without asking another model to retype a complete design. */
export function assembleArchitectureCandidate({ blueprint, modules, candidateSchema, requirements = [], mergeCapabilityReasons = true,
  evidence = [], confirmedRequirementContext, deferredVerifications }) {
  const frozen = validateArchitectureBlueprint(blueprint, { candidateSchema, requirements });
  const source = copy(modules, "modules", 2 * 1024 * 1024);
  equalIds(unique(source, "modules", "moduleId"), frozen.modules.map((entry) => entry.id), "modules");
  const ordered = scopeLocalIds(frozen.modules.map((assignment) => validateArchitectureModule(source.find((entry) => entry.moduleId === assignment.id), {
    blueprint: frozen, assignment, candidateSchema, requirements,
  })));
  if (mergeCapabilityReasons) for (const module of ordered)
    module.decisions = normalizeArchitectureDecisionReferences(module.decisions, { evidence, confirmedRequirementContext, deferredVerifications, requirements });
  const candidate = copy(frozen.global), conflicts = [];
  candidate.instructions = [frozen.global.instructions, ...ordered.map((entry) => entry.instructions)].join("\n");
  for (const field of PART_FIELDS.filter((key) => candidateSchema.properties[key])) {
    if (!candidateSchema.required.includes(field) && !ordered.some((entry) => Object.hasOwn(entry, field))) continue;
    candidate[field] = ordered.flatMap((entry) => entry[field] ?? []);
    if (field === "capabilities") {
      const rows = [], known = new Map();
      for (const entry of ordered) for (const row of entry.capabilities) {
        const previous = known.get(row.id);
        if (previous && isDeepStrictEqual(previous.row, row)) continue;
        if (mergeCapabilityReasons && previous?.row.status === row.status) {
          const reasons = [...new Set([...previous.reasons, row.reason])], reason = reasons.join("\n");
          const limit = candidateSchema.properties.capabilities.items.properties.reason.maxLength;
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
    } else if (["components", "steps", "decisions", "acceptance", "platformClaims"].includes(field)) unique(candidate[field], `candidate.${field}`);
  }
  const componentOrder = frozen.modules.flatMap((entry) => entry.componentIds), stepOrder = frozen.modules.flatMap((entry) => entry.stepIds);
  candidate.components.sort((a, b) => componentOrder.indexOf(a.id) - componentOrder.indexOf(b.id));
  candidate.steps.sort((a, b) => stepOrder.indexOf(a.id) - stepOrder.indexOf(b.id));
  acyclic(candidate.steps, "candidate.steps.dependsOn");
  const feedback = architectureToolValidation(candidate, candidateSchema, { root: "candidate" });
  for (const issue of feedback.issues) {
    const field = issue.path.match(/^candidate\.([A-Za-z]+)/u)?.[1];
    if (!field || !DERIVED_FIELDS.has(field)) fail(issue.path, issue.reason, "模块合并后超过最终候选的结构限制，请修正负责模块。");
    if (!conflicts.some((entry) => entry.path === `/${field}` && entry.reason === issue.reason))
      conflicts.push({ path: `/${field}`, reason: issue.reason, relatedPaths: [`/${field}`], moduleIds: frozen.modules.map((entry) => entry.id) });
  }
  if (conflicts.length > 64) fail("integration.conflicts", "size_limit", "跨模块冲突超过一次可安全整合的范围，请先修正模块设计。");
  return { candidate: copy(candidate), conflicts };
}

function target(candidate, path) {
  if (!path.startsWith("/") || /~(?![01])/u.test(path)) fail("integration.updates.path", "invalid_reference", "整合只允许规范JSON Pointer路径。");
  const parts = path.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  let value = candidate, parent, key;
  for (const part of parts) {
    if (["__proto__", "constructor", "prototype"].includes(part) || !value || typeof value !== "object"
      || Array.isArray(value) && (!/^(0|[1-9][0-9]*)$/u.test(part) || Number(part) >= value.length)
      || !Object.hasOwn(value, part)) fail("integration.updates.path", "invalid_reference", "整合只能替换当前候选已有的真实字段。");
    parent = value; key = part; value = value[part];
  }
  return { parent, key, parts };
}

export function applyArchitectureIntegration(value, { candidate, conflicts = [], candidateSchema, requirements = [], blueprint, modules, mergeCapabilityReasons = true,
  evidence = [], confirmedRequirementContext, deferredVerifications }) {
  const input = checked(value, createArchitectureStageSchemas({ candidateSchema, requirements }).integration, "integration");
  const original = copy(candidate), result = copy(candidate);
  if (input.baseHash !== designHash(original)) fail("integration.baseHash", "invalid_reference", "整合结果不属于当前已拼装候选。");
  // Reconstruct the base from its checked owners, rather than trusting a caller-supplied candidate.
  const assembled = assembleArchitectureCandidate({ blueprint, modules, candidateSchema, requirements, mergeCapabilityReasons,
    evidence, confirmedRequirementContext, deferredVerifications });
  if (!isDeepStrictEqual(original, assembled.candidate) || !isDeepStrictEqual(conflicts, assembled.conflicts))
    fail("integration.baseHash", "invalid_reference", "整合基底或冲突清单与当前模块成果不一致。");
  const permitted = new Set(conflicts.map((entry) => entry.path)), changed = [];
  const conflictAllows = (path) => [...permitted].some((allowed) => path === allowed || path.startsWith(allowed + "/"));
  for (const update of input.updates) {
    const location = target(result, update.path), root = location.parts[0];
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
  for (const field of Object.keys(blueprint.global).filter((key) => key !== "instructions")) if (!isDeepStrictEqual(original[field], result[field]))
    fail(`integration.${field}`, "invalid_reference", "整合不能改写蓝图中已冻结的全局约束。");
  for (const field of ["components", "steps"]) equalIds(result[field]?.map((entry) => entry.id) ?? [], original[field].map((entry) => entry.id), `integration.${field}`);
  for (const field of ["components", "steps"]) if (!isDeepStrictEqual(result[field], original[field]))
    fail(`integration.${field}`, "invalid_reference", "组件与步骤的变更须退回负责模块，整合不能重写模块成果。");
  equalIds(result.coverage?.map((entry) => entry.requirementId) ?? [], original.coverage.map((entry) => entry.requirementId), "integration.coverage");
  const components = new Set(result.components.map((entry) => entry.id)), requirementIds = new Set(requirements.map((entry) => entry.id));
  for (const row of original.coverage) {
    const current = result.coverage.find((entry) => entry.requirementId === row.requirementId);
    if (current.verification !== row.verification || row.componentIds.some((id) => !current.componentIds.includes(id)))
      fail("integration.coverage", "invalid_reference", "整合须保留模块原有需求覆盖与核验说明，只能补充已声明组件关联。");
  }
  for (const row of result.coverage) if (!Array.isArray(row.componentIds) || row.componentIds.some((id) => !components.has(id)))
    fail("integration.coverage.componentIds", "invalid_reference", "整合覆盖只能引用当前已冻结组件。");
  for (const [index, row] of original.acceptance.entries()) {
    const current = result.acceptance?.find((entry) => entry.id === row.id);
    if (!current || !isDeepStrictEqual(current.requirementIds, row.requirementIds))
      fail("integration.acceptance", "invalid_reference", "整合不能移除模块已有验收或改变其需求归属。");
    if (!conflictAllows(`/acceptance/${index}`) && !isDeepStrictEqual(current, row))
      fail("integration.acceptance", "invalid_reference", "没有明确冲突时，整合必须保留模块已提交验收，只能追加跨模块场景。");
  }
  for (const field of ["failureHandling", "unknowns"]) if (!conflictAllows(`/${field}`)) {
    const remaining = [...result[field]];
    for (const row of original[field]) {
      const index = remaining.findIndex((entry) => isDeepStrictEqual(entry, row));
      if (index < 0) fail(`integration.${field}`, "invalid_reference", "没有明确冲突时，整合必须保留模块已保存的失败处理和未知项，只能追加交接说明。");
      remaining.splice(index, 1);
    }
  }
  for (const row of result.acceptance ?? []) if (!Array.isArray(row.requirementIds) || row.requirementIds.some((id) => !requirementIds.has(id)))
    fail("integration.acceptance.requirementIds", "invalid_reference", "跨模块验收只能引用当前正式需求。");
  for (const field of ["capabilities", "decisions", "acceptance", "platformClaims"]) if (result[field]) unique(result[field], `candidate.${field}`);
  return copy(result);
}
