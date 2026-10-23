import { toolInputValidation } from "../runtime/tool-input-diagnostics.mjs";
import { ACCEPTANCE_ADAPTERS } from "../verification/acceptance-contract.mjs";
import { CAPABILITIES } from "./architecture-contract.mjs";
import { REQUIREMENT_LIMITS } from "../requirements/requirement-limits.mjs";

const reasons = Object.freeze({ required: "required_field", additionalProperties: "unknown_field", type: "invalid_type",
  enum: "invalid_value", const: "invalid_value", pattern: "invalid_value", minLength: "size_limit", maxLength: "size_limit",
  minItems: "size_limit", maxItems: "size_limit", minimum: "size_limit", maximum: "size_limit", exclusiveMinimum: "size_limit",
  exclusiveMaximum: "size_limit", minProperties: "size_limit", maxProperties: "size_limit", multipleOf: "size_limit", uniqueItems: "invalid_reference" });
export const ARCHITECTURE_FORMAT_SUBMISSION_LIMIT = 10;
const formatReasons = new Set(["required_field", "unknown_field", "invalid_type", "invalid_contract"]);
export function isArchitectureFormatSubmissionIssue(issue) {
  return Boolean(issue && formatReasons.has(issue.reason));
}
const remedies = Object.freeze({ required_field: "补齐这个已声明的必填字段，再在当前会话重新提交。",
  unknown_field: "移除该对象中工具未声明的字段，保留其他内容。", invalid_type: "按当前工具声明的字段类型填写，不将对象、数组或布尔值编码成字符串。",
  invalid_value: "使用当前工具字段允许的取值；验收适配器、负责方和阶段必须遵循同一个固定映射。",
  size_limit: "按当前字段的条目或长度额度组织内容，保留全部必要要求与验收边界。",
  invalid_reference: "只引用工具和当前上下文实际列出的编号，不能重复或虚构引用。",
  invalid_contract: "核对当前工具公开结构及具体字段，修正后继续当前会话。" });

// Derive paths from schema properties only. Neither SDK exception text nor submitted values enter feedback.
export function architectureToolValidation(value, schema, { root = "root" } = {}) {
  const feedback = toolInputValidation(value, schema, { root });
  if (feedback.valid) return feedback;
  const issues = feedback.issues.map(entry => {
    const reason = reasons[entry.reason] ?? "invalid_contract";
    return { ...entry, reason, remedy: entry.alternatives ? entry.remedy : remedies[reason] };
  });
  return { ...feedback, issues, ...(issues.some((entry) => /\.acceptance\[[0-9]+\]\.verification(?:\.|$)/.test(entry.path))
    ? { verificationOptions: Object.entries(ACCEPTANCE_ADAPTERS).map(([adapterId, { stage, owner }]) => ({ adapterId, stage, owner })) } : {}) };
}

// This explains rejected candidates. It never accepts, repairs or changes the formal validation order.
export function diagnoseArchitectureReferences(value, { requirements = [], capabilities = CAPABILITIES, evidence = [], schema, limit = 40 } = {}) {
  const issues = [], seen = new Set();
  let total = 0, retainedCharacters = 0;
  const add = (entry) => {
    const key = JSON.stringify(entry);
    if (seen.has(key)) return;
    seen.add(key); total++;
    const characters = JSON.stringify(entry).length;
    if (issues.length < limit && retainedCharacters + characters <= 24000) { issues.push(entry); retainedCharacters += characters; }
  };
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("架构诊断条目额度无效");
  const entries = (items) => Array.isArray(items) ? items.slice(0, REQUIREMENT_LIMITS.formalItems) : [];
  const safeId = (id) => typeof id === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(id);
  const ids = (items) => new Set(items.flatMap((item) => safeId(item?.id) ? [item.id] : []));
  if (schema) for (const entry of architectureToolValidation(value, schema, { root: "design" }).issues) add(entry);
  const groups = Object.fromEntries(["components", "steps", "capabilities", "decisions", "coverage", "acceptance"].map((key) => [key, entries(value?.[key])]));
  const requirementIds = ids(Array.isArray(requirements) ? requirements : []), componentIds = ids(groups.components), stepIds = ids(groups.steps);
  const declared = { componentIds: "design.components[].id", stepIds: "design.steps[].id", requirementIds: "requirements[].id",
    capabilityIds: "capabilities[].id", evidenceIds: "evidence[].id" };
  const reference = (id, allowed, path, { host = false, declaredPath } = {}) => {
    if (typeof id !== "string" || allowed.has(id)) return;
    add({ path, reason: "invalid_reference", remedy: "仅引用当前已批准或已声明的对应编号；宿主不会替换编号或修改候选。",
      ...(host || declaredPath ? { allowedReferences: [...allowed].slice(0, 100),
        ...(allowed.size > 100 ? { allowedReferencesTotal: allowed.size, allowedReferencesTruncated: true } : {}) } : {}),
      ...(declaredPath ? { allowedReferencePaths: [declaredPath] } : {}) });
  };
  for (const [group, items] of Object.entries(groups)) {
    const first = new Map(), field = group === "coverage" ? "requirementId" : "id";
    for (const [index, item] of items.entries()) if (safeId(item?.[field])) {
      if (first.has(item[field])) add({ path: `design.${group}[${index}].${field}`, reason: "duplicate_reference",
        relatedPaths: [`design.${group}[${first.get(item[field])}].${field}`], remedy: "核对两个位置；不同条目使用不同编号，不能自动去重或删除要求。" });
      else first.set(item[field], index);
    }
  }
  if (requirementIds.size) {
    const covered = new Set(groups.coverage.map((item) => item?.requirementId)), tested = new Set(groups.acceptance.flatMap((item) => entries(item?.requirementIds)));
    for (const [field, actual] of [["coverage", covered], ["acceptance", tested]]) {
      const missing = [...requirementIds].filter((id) => !actual.has(id));
      if (missing.length) add({ path: `design.${field}`, reason: "missing_coverage", allowedReferences: [...requirementIds].slice(0, requirementIds.size > 100 ? 32 : 100),
        ...(requirementIds.size > 100 ? { allowedReferencesTotal: requirementIds.size, allowedReferencesTruncated: true } : {}),
        missingReferences: missing,
        remedy: field === "coverage" ? "为这些已批准需求补齐实际组件覆盖，保留原需求。" : "为这些已批准需求补齐实际验收场景与分工，不能删除需求或把检查标签当作通过。" });
    }
  }
  for (const [index, item] of groups.coverage.entries()) {
    if (requirementIds.size) reference(item?.requirementId, requirementIds, `design.coverage[${index}].requirementId`, { host: true, declaredPath: declared.requirementIds });
    for (const [child, id] of entries(item?.componentIds).entries()) reference(id, componentIds, `design.coverage[${index}].componentIds[${child}]`, { declaredPath: declared.componentIds });
  }
  if (requirementIds.size) for (const [index, id] of entries(value?.selectionBasis?.requirementIds).entries())
    reference(id, requirementIds, `design.selectionBasis.requirementIds[${index}]`, { host: true, declaredPath: declared.requirementIds });
  const usedComponents = new Set(), stepIndexes = new Map(groups.steps.flatMap((item, index) => safeId(item?.id) ? [[item.id, index]] : []));
  for (const [index, step] of groups.steps.entries()) {
    reference(step?.componentId, componentIds, `design.steps[${index}].componentId`, { declaredPath: declared.componentIds });
    if (componentIds.has(step?.componentId)) usedComponents.add(step.componentId);
    for (const [child, id] of entries(step?.dependsOn).entries()) reference(id, stepIds, `design.steps[${index}].dependsOn[${child}]`, { declaredPath: declared.stepIds });
  }
  for (const [index, component] of groups.components.entries()) if (safeId(component?.id) && !usedComponents.has(component.id))
    add({ path: `design.components[${index}].id`, reason: "component_unused", allowedReferencePaths: ["design.steps[].componentId"], remedy: "当前步骤尚未覆盖这个已声明组件；核对实际需要和步骤关联，不自动删除组件。" });
  const visiting = new Set(), visited = new Set();
  const visit = (id) => {
    if (visited.has(id) || !stepIndexes.has(id)) return;
    visiting.add(id);
    const index = stepIndexes.get(id);
    for (const [child, dependency] of entries(groups.steps[index]?.dependsOn).entries()) {
      if (visiting.has(dependency)) add({ path: `design.steps[${index}].dependsOn[${child}]`, reason: "dependency_cycle",
        relatedPaths: [`design.steps[${stepIndexes.get(dependency)}].id`], remedy: "移除步骤依赖环，保留实际阶段与交付要求。" });
      else if (stepIndexes.has(dependency)) visit(dependency);
    }
    visiting.delete(id); visited.add(id);
  };
  for (const id of stepIndexes.keys()) visit(id);
  const available = ids((Array.isArray(capabilities) ? capabilities : []).filter((item) => item?.status === "available"));
  for (const [index, item] of groups.capabilities.entries()) if (item?.status === "available")
    reference(item.id, available, `design.capabilities[${index}].id`, { host: true, declaredPath: declared.capabilityIds });
  const evidenceIds = ids(Array.isArray(evidence) ? evidence : []);
  for (const [index, item] of groups.decisions.entries()) for (const [child, id] of entries(item?.evidenceIds).entries())
    reference(id, evidenceIds, `design.decisions[${index}].evidenceIds[${child}]`, { host: true, declaredPath: declared.evidenceIds });
  const kinds = new Set(groups.acceptance.map((item) => item?.kind));
  const requiredKinds = ["success", "missing_input", "boundary", ...(groups.capabilities.some((item) => item?.id !== "conversation") ? ["tool_failure"] : [])];
  const missingKinds = requiredKinds.filter((kind) => !kinds.has(kind));
  if (missingKinds.length) add({ path: "design.acceptance", reason: "missing_acceptance_kind", missingKinds, remedy: "补齐这些实际验收场景，不能用重复成功场景代替。" });
  for (const [index, item] of groups.acceptance.entries()) if (requirementIds.size) for (const [child, id] of entries(item?.requirementIds).entries())
    reference(id, requirementIds, `design.acceptance[${index}].requirementIds[${child}]`, { host: true, declaredPath: declared.requirementIds });
  return { issues, total, retained: issues.length, truncated: total > issues.length };
}
