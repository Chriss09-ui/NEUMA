import type { UnknownRecord } from "../contracts/json.mjs";
import type { ToolSchema, ToolInputIssue } from "../contracts/tools.mjs";
import type { Capability, EvidenceItem, RequirementItem } from "../contracts/architecture.mjs";
import { objectFields, isArray } from "../runtime/type-boundary.mjs";
interface ReferenceIssue { path: string; reason: string; remedy: string; allowedReferences?: string[]; allowedReferencesTotal?: number; allowedReferencesTruncated?: boolean; allowedReferencePaths?: string[]; relatedPaths?: string[]; missingReferences?: string[]; missingKinds?: string[] }
import { toolInputValidation } from "../runtime/tool-input-diagnostics.mjs";
import { ACCEPTANCE_ADAPTERS } from "../verification/acceptance-contract.mjs";
import { CAPABILITIES } from "./architecture-contract.mjs";
import { REQUIREMENT_LIMITS } from "../requirements/requirement-limits.mjs";
import { requiredArchitectureAcceptanceKinds } from "./architecture-stage-semantics.mjs";

const reasons = Object.freeze({ required: "required_field", additionalProperties: "unknown_field", type: "invalid_type", invalid_json: "invalid_type",
  enum: "invalid_value", const: "invalid_value", pattern: "invalid_value", minLength: "size_limit", maxLength: "size_limit",
  minItems: "size_limit", maxItems: "size_limit", minimum: "size_limit", maximum: "size_limit", exclusiveMinimum: "size_limit",
  exclusiveMaximum: "size_limit", minProperties: "size_limit", maxProperties: "size_limit", multipleOf: "size_limit", uniqueItems: "invalid_reference" });
export const ARCHITECTURE_FORMAT_SUBMISSION_LIMIT = 10;
// Historical design-revision allowances retain their original container-only classification.
const formatReasons = new Set(["required_field", "unknown_field", "invalid_type", "invalid_contract"]);
export function isArchitectureFormatSubmissionIssue(issue: unknown) {
  const reason = objectFields(issue).reason;
  return Boolean(issue && typeof reason === "string" && formatReasons.has(reason));
}
const remedies = Object.freeze({ required_field: "补齐这个已声明的必填字段，再在当前会话重新提交。",
  unknown_field: "移除该对象中工具未声明的字段，保留其他内容。", invalid_type: "按当前工具声明的字段类型填写，不将对象、数组或布尔值编码成字符串。",
  invalid_value: "使用当前工具字段允许的取值；验收适配器、负责方和阶段必须遵循同一个固定映射。",
  size_limit: "按当前字段的条目或长度额度组织内容，保留全部必要要求与验收边界。",
  invalid_reference: "只引用工具和当前上下文实际列出的编号，不能重复或虚构引用。",
  invalid_contract: "核对当前工具公开结构及具体字段，修正后继续当前会话。" });

function malformedContainerText(value: unknown, issue: ToolInputIssue, root: string) {
  if (issue.reason !== "type" || issue.receivedType !== "string" || !["array", "object"].includes(issue.expectedType ?? "")) return false;
  const parts = issue.path.slice(root.length).replace(/\[([0-9]+)\]/g, ".$1").split(".").filter(Boolean);
  for (const part of parts) {
    if (!value || typeof value !== "object") return false;
    value = Object.getOwnPropertyDescriptor(value, part)?.value;
  }
  if (typeof value !== "string" || value.length > 256 * 1024 || Buffer.byteLength(value, "utf8") > 256 * 1024
    || !value.trimStart().startsWith(issue.expectedType === "array" ? "[" : "{")) return false;
  try { JSON.parse(value); return false; } catch { return true; }
}

// Derive paths from schema properties only. Neither SDK exception text nor submitted values enter feedback.
export function architectureToolValidation(value: unknown, schema: ToolSchema, { root = "root" } = {}) {
  const feedback = toolInputValidation(value, schema, { root });
  if (feedback.valid) return feedback;
  const issues = feedback.issues.map(entry => {
    const reason = reasons[entry.reason as keyof typeof reasons] ?? "invalid_contract";
    if (entry.location) return { ...entry, reason, remedy: entry.remedy };
    if (reason === "unknown_field" && entry.path === root && schema.properties?.issues?.items?.properties?.factClaims
      && !Object.hasOwn(schema.properties, "factClaims") && Object.hasOwn(objectFields(value), "factClaims")) {
      const destination = schema.properties.issue ? "对应意见的 issues[i].factClaims 或单项 issue.factClaims" : "对应意见的 issues[i].factClaims";
      return { ...entry, path: `${root}.factClaims`, reason, remedy: `把报告外层的证据移到${destination}，保留其中的实际内容。` };
    }
    if (malformedContainerText(value, entry, root)) return { ...entry, reason,
      remedy: "该字段的JSON文字无法解析，请检查内部引号、转义或括号。保留现有内容和编号，直接提交原生数组或对象；条目中的自然语言仍为字符串，然后在当前会话重新提交。" };
    return { ...entry, reason, remedy: entry.alternatives ? entry.remedy : remedies[reason] };
  });
  return { ...feedback, issues, ...(issues.some((entry) => /\.acceptance\[[0-9]+\]\.verification(?:\.|$)/.test(entry.path))
    ? { verificationOptions: Object.entries(ACCEPTANCE_ADAPTERS).map(([adapterId, { stage, owner }]) => ({ adapterId, stage, owner })) } : {}) };
}

// This explains rejected candidates. It never accepts, repairs or changes the formal validation order.
export function diagnoseArchitectureReferences(input: unknown, { requirements = [], capabilities = CAPABILITIES, evidence = [], schema, limit = 40, runtimeCapabilities }: { requirements?: Pick<RequirementItem, "id">[]; capabilities?: readonly Pick<Capability, "id" | "status">[]; evidence?: Pick<EvidenceItem, "id">[]; schema?: ToolSchema; limit?: number; runtimeCapabilities?: unknown } = {}) {
  const value = objectFields(input);
  const issues: ReferenceIssue[] = [], seen = new Set<string>();
  let total = 0, retainedCharacters = 0;
  const add = (entry: ReferenceIssue) => {
    const key = JSON.stringify(entry);
    if (seen.has(key)) return;
    seen.add(key); total++;
    const characters = JSON.stringify(entry).length;
    if (issues.length < limit && retainedCharacters + characters <= 24000) { issues.push(entry); retainedCharacters += characters; }
  };
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("架构诊断条目额度无效");
  const entries = (items: unknown): unknown[] => isArray(items) ? items.slice(0, REQUIREMENT_LIMITS.formalItems) : [];
  const safeId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(id);
  const ids = (items: unknown[]) => new Set(items.flatMap((input) => { const item = objectFields(input); return safeId(item.id) ? [item.id] : []; }));
  if (schema) for (const entry of architectureToolValidation(value, schema, { root: "design" }).issues) add(entry);
  const groupNames = ["components", "steps", "capabilities", "decisions", "coverage", "acceptance"] as const;
  const groups = Object.fromEntries(groupNames.map((key) => [key, entries(value[key]).map(objectFields)])) as Record<typeof groupNames[number], UnknownRecord[]>;
  const requirementIds = ids(Array.isArray(requirements) ? requirements : []), componentIds = ids(groups.components), stepIds = ids(groups.steps);
  const declared = { componentIds: "design.components[].id", stepIds: "design.steps[].id", requirementIds: "requirements[].id",
    capabilityIds: "capabilities[].id", evidenceIds: "evidence[].id" };
  const reference = (id: unknown, allowed: Set<string>, path: string, { host = false, declaredPath }: { host?: boolean; declaredPath?: string } = {}) => {
    if (typeof id !== "string" || allowed.has(id)) return;
    add({ path, reason: "invalid_reference", remedy: "仅引用当前已批准或已声明的对应编号；宿主不会替换编号或修改候选。",
      ...(host || declaredPath ? { allowedReferences: [...allowed].slice(0, 100),
        ...(allowed.size > 100 ? { allowedReferencesTotal: allowed.size, allowedReferencesTruncated: true } : {}) } : {}),
      ...(declaredPath ? { allowedReferencePaths: [declaredPath] } : {}) });
  };
  for (const [group, items] of Object.entries(groups)) {
    const first = new Map<string, number>(), field = group === "coverage" ? "requirementId" : "id";
    for (const [index, item] of items.entries()) if (safeId(item?.[field])) {
      if (first.has(item[field])) add({ path: `design.${group}[${index}].${field}`, reason: "duplicate_reference",
        relatedPaths: [`design.${group}[${first.get(item[field])}].${field}`], remedy: "核对两个位置；不同条目使用不同编号，不能自动去重或删除要求。" });
      else first.set(item[field], index);
    }
  }
  if (requirementIds.size) {
    const covered = new Set(groups.coverage.map((item) => item?.requirementId)), tested = new Set(groups.acceptance.flatMap((item) => entries(item?.requirementIds)));
    for (const [field, actual] of [["coverage", covered], ["acceptance", tested]] as const) {
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
  if (requirementIds.size) for (const [index, id] of entries(objectFields(value.selectionBasis).requirementIds).entries())
    reference(id, requirementIds, `design.selectionBasis.requirementIds[${index}]`, { host: true, declaredPath: declared.requirementIds });
  const usedComponents = new Set(), stepIndexes = new Map(groups.steps.flatMap((item, index) => safeId(item?.id) ? [[item.id, index]] : []));
  for (const [index, step] of groups.steps.entries()) {
    reference(step?.componentId, componentIds, `design.steps[${index}].componentId`, { declaredPath: declared.componentIds });
    if (typeof step.componentId === "string" && componentIds.has(step.componentId)) usedComponents.add(step.componentId);
    for (const [child, id] of entries(step?.dependsOn).entries()) reference(id, stepIds, `design.steps[${index}].dependsOn[${child}]`, { declaredPath: declared.stepIds });
  }
  for (const [index, component] of groups.components.entries()) if (safeId(component?.id) && !usedComponents.has(component.id))
    add({ path: `design.components[${index}].id`, reason: "component_unused", allowedReferencePaths: ["design.steps[].componentId"], remedy: "当前步骤尚未覆盖这个已声明组件；核对实际需要和步骤关联，不自动删除组件。" });
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id) || !stepIndexes.has(id)) return;
    visiting.add(id);
    const index = stepIndexes.get(id)!;
    for (const [child, dependency] of entries(groups.steps[index]?.dependsOn).entries()) {
      if (typeof dependency !== "string") continue;
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
  const requiredKinds = requiredArchitectureAcceptanceKinds(groups.capabilities.map(item => ({ id: String(item.id), status: String(item.status) })),
    { runtimeCapabilities, capabilities, connections: entries(value.connections).map(objectFields).map(item => ({ id: String(item.id), purpose: String(item.purpose) })) });
  const missingKinds = requiredKinds.filter((kind) => !kinds.has(kind));
  if (missingKinds.length) add({ path: "design.acceptance", reason: "missing_acceptance_kind", missingKinds, remedy: "补齐这些实际验收场景，不能用重复成功场景代替。" });
  for (const [index, item] of groups.acceptance.entries()) if (requirementIds.size) for (const [child, id] of entries(item?.requirementIds).entries())
    reference(id, requirementIds, `design.acceptance[${index}].requirementIds[${child}]`, { host: true, declaredPath: declared.requirementIds });
  return { issues, total, retained: issues.length, truncated: total > issues.length };
}
