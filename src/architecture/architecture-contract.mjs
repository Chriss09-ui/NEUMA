import { createHash } from "node:crypto";
import { InputError, normalizeDraft, decideNext } from "../requirements/core.mjs";

export const ARCHITECTURE_VERSION = 1;
export const CAPABILITIES = Object.freeze([
  { id: "conversation", status: "available", scope: "基于用户提供的文本进行对话与生成；不包含联网检索、外部动作或定时运行。" },
  { id: "list_workspace_files", status: "available", scope: "仅列出当前 Agent 专属工作目录内允许访问的文件。" },
  { id: "read_workspace_file", status: "available", scope: "仅读取当前 Agent 专属工作目录内的 UTF-8 文本；不访问外部目录、隐藏文件或凭据。" },
  { id: "write_workspace_file", status: "available", scope: "仅在当前 Agent 专属工作目录保存文本文件；不包含部署、发送、任意代码执行或外部系统写入。" },
].map(Object.freeze));

const text = (maxLength = 2000) => ({ type: "string", minLength: 1, maxLength });
const identifier = { ...text(80), pattern: "^[A-Za-z][A-Za-z0-9_-]*$" };
const choice = (...values) => ({ type: "string", enum: values });
const list = (items, minItems = 0, maxItems = 80) => ({ type: "array", items, minItems, maxItems });
const object = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const references = (minItems = 0) => ({ ...list(identifier, minItems), uniqueItems: true });
const issueSchema = object({ id: identifier, blocking: { type: "boolean" }, description: text(), remedy: text() });
const REVIEW_CHECKS = ["requirements", "feasibility", "minimality", "interfaces", "failure_handling", "verification"];

export const DESIGN_SCHEMA = object({
  profile: choice("light", "workflow", "custom"),
  rationale: text(4000),
  instructions: text(12_000),
  components: list(object({ id: identifier, purpose: text(), necessity: text(), inputs: text(), outputs: text() }), 1),
  steps: list(object({ id: identifier, componentId: identifier, dependsOn: references(), input: text(), output: text(), completion: text() }), 1),
  capabilities: list(object({ id: identifier, status: choice("available", "needs_connection", "needs_development", "unverified"), reason: text() }), 1),
  state: object({ mode: choice("none", "task", "persistent"), reason: text() }),
  failureHandling: list(object({ scenario: text(), response: text() }), 1),
  decisions: list(object({
    id: identifier, problem: text(), choice: text(),
    alternatives: list(object({ option: text(), reason: text() }), 1),
    reason: text(), evidenceIds: references(), uncertainties: list(text()),
  }), 1),
  coverage: list(object({ requirementId: identifier, componentIds: references(1), verification: text() }), 1),
  acceptance: list(object({
    id: identifier, kind: choice("success", "missing_input", "boundary", "tool_failure"),
    requirementIds: references(1), input: text(), expected: text(),
  }), 3),
  unknowns: list(object({ question: text(), blocking: { type: "boolean" }, resolution: text() })),
});

export const REVIEW_SCHEMA = object({
  candidateHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
  verdict: choice("pass", "revise", "insufficient", "infeasible"),
  checks: list(object({ id: choice(...REVIEW_CHECKS), passed: { type: "boolean" }, evidence: text(4000) }), 6, 6),
  issues: list(issueSchema),
  summary: text(4000),
});

function fail(message) { throw new InputError(`架构契约无效：${message}`); }

function validateSchema(value, schema, path = "design") {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${path} 必须为对象`);
    for (const key of schema.required) if (!Object.hasOwn(value, key)) fail(`${path}.${key} 缺失`);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key)) fail(`${path}.${key} 不受支持`);
      validateSchema(value[key], schema.properties[key], `${path}.${key}`);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems) fail(`${path} 条目数量无效`);
    value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`));
    if (schema.uniqueItems && new Set(value).size !== value.length) fail(`${path} 包含重复引用`);
  } else if (schema.type === "string") {
    if (typeof value !== "string" || !value.trim() || value.includes("\0")
        || (schema.maxLength && value.length > schema.maxLength)
        || (schema.pattern && !new RegExp(schema.pattern).test(value))
        || (schema.enum && !schema.enum.includes(value))) fail(`${path} 文本或取值无效`);
  } else if (typeof value !== "boolean") fail(`${path} 必须为布尔值`);
}

function uniqueIds(items, label, key = "id") {
  const ids = items.map((item) => item[key]);
  if (new Set(ids).size !== ids.length) fail(`${label} 包含重复 ID`);
  return new Set(ids);
}

function assertReference(id, ids, label) {
  if (!ids.has(id)) fail(`${label} 引用了不存在的 ID：${id}`);
}

export function requirementItems(value) {
  const draft = normalizeDraft(value);
  if (decideNext(draft).status !== "ready") fail("需求仍有未解决项，请先完成需求确认");
  const fields = [
    ["goal", "目标"], ["scenario", "使用场景"], ["inputSource", "输入来源"],
    ["task", "主要任务"], ["deliverable", "交付物"], ["successCriteria", "完成标准"],
    ["routingCondition", "适用条件"],
  ];
  const items = fields.filter(([key]) => draft[key].value)
    .map(([id, label]) => ({ id, text: `${label}：${draft[id].value}` }));
  items.push(...draft.constraints.map((item, index) => ({ id: `constraint_${index + 1}`, text: `约束：${item.text}` })));
  items.push({ id: "usage", text: `触发方式：${draft.usage.mode}；${draft.usage.detail}` });
  const action = draft.externalAction;
  items.push({ id: "externalAction", text: action.mode === "none" ? "边界：不执行对外动作"
    : `对外动作：${action.operation}；目标：${action.target}；范围：${action.scope}；触发：${action.trigger}` });
  items.push(...draft.capabilityDependencies.map((item, index) => ({ id: `capability_${index + 1}`, text: `能力依赖：${item}` })));
  return items;
}

export function validateDesign(value, { requirements, capabilities = CAPABILITIES, evidence = [] } = {}) {
  validateSchema(value, DESIGN_SCHEMA);
  if (!Array.isArray(requirements) || !requirements.length) fail("缺少已确认的需求清单");
  for (const requirement of requirements) validateSchema(requirement, object({ id: identifier, text: text(4000) }), "requirements");
  const requirementIds = uniqueIds(requirements, "requirements");
  const componentIds = uniqueIds(value.components, "components");
  const stepIds = uniqueIds(value.steps, "steps");
  uniqueIds(value.capabilities, "capabilities");
  uniqueIds(value.decisions, "decisions");
  uniqueIds(value.acceptance, "acceptance");
  const covered = uniqueIds(value.coverage, "coverage", "requirementId");
  for (const id of requirementIds) if (!covered.has(id)) fail(`需求 ${id} 未被设计覆盖`);
  for (const coverage of value.coverage) {
    assertReference(coverage.requirementId, requirementIds, "coverage");
    coverage.componentIds.forEach((id) => assertReference(id, componentIds, "coverage.componentIds"));
  }
  const usedComponents = new Set();
  for (const step of value.steps) {
    assertReference(step.componentId, componentIds, "steps.componentId");
    usedComponents.add(step.componentId);
    step.dependsOn.forEach((id) => assertReference(id, stepIds, "steps.dependsOn"));
  }
  for (const id of componentIds) if (!usedComponents.has(id)) fail(`组件 ${id} 未出现在执行步骤中`);
  const steps = new Map(value.steps.map((step) => [step.id, step]));
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) fail(`步骤依赖存在循环：${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    steps.get(id).dependsOn.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  }
  stepIds.forEach(visit);
  if (!Array.isArray(capabilities) || !Array.isArray(evidence)) fail("能力目录与证据目录必须为数组");
  for (const item of [...capabilities, ...evidence]) {
    if (!item || typeof item !== "object") fail("能力或证据条目无效");
    validateSchema(item.id, identifier, "context.id");
  }
  uniqueIds(capabilities, "capability catalog");
  const knownCapabilities = new Set(capabilities.filter((item) => item.status === "available").map((item) => item.id));
  for (const capability of value.capabilities) {
    if (capability.status === "available" && !knownCapabilities.has(capability.id)) fail(`能力 ${capability.id} 未被工具目录证实可用`);
  }
  const evidenceIds = uniqueIds(evidence, "evidence");
  for (const decision of value.decisions) decision.evidenceIds.forEach((id) => assertReference(id, evidenceIds, "decisions.evidenceIds"));
  const kinds = new Set(value.acceptance.map((item) => item.kind));
  for (const kind of ["success", "missing_input", "boundary"]) if (!kinds.has(kind)) fail(`缺少 ${kind} 验收场景`);
  if (value.capabilities.some((item) => item.id !== "conversation") && !kinds.has("tool_failure")) fail("使用工具时必须提供 tool_failure 验收场景");
  const tested = new Set();
  for (const acceptance of value.acceptance) {
    acceptance.requirementIds.forEach((id) => {
      assertReference(id, requirementIds, "acceptance.requirementIds");
      tested.add(id);
    });
  }
  for (const id of requirementIds) if (!tested.has(id)) fail(`需求 ${id} 缺少验收场景`);
  return structuredClone(value);
}

export function checkDesign(value, context) {
  const design = validateDesign(value, context);
  const issues = [];
  design.unknowns.forEach((item, index) => issues.push({
    id: `unknown_${index + 1}`, blocking: item.blocking,
    description: item.question, remedy: item.resolution,
  }));
  for (const capability of design.capabilities) {
    if (capability.status !== "available") issues.push({
      id: `capability_${capability.id}`,
      blocking: capability.status === "unverified" || design.profile === "light",
      description: `能力 ${capability.id} 尚未可用：${capability.reason}`,
      remedy: "明确连接或开发路径并验证实际能力；无法验证时保留为未就绪。",
    });
  }
  if (design.profile === "light" && design.state.mode === "persistent") issues.push({
    id: "persistent_state", blocking: true,
    description: "轻量执行器未提供自主维护的持久状态。",
    remedy: "将状态缩减为任务上下文，或选择 workflow/custom 并说明实现路径。",
  });
  return { issues, runnable: design.profile === "light"
    && design.state.mode !== "persistent"
    && design.capabilities.every((item) => item.status === "available")
    && !issues.some((item) => item.blocking) };
}

export function validateReview(value, { candidateHash } = {}) {
  validateSchema(value, REVIEW_SCHEMA, "review");
  if (value.candidateHash !== candidateHash) fail("评估结果与当前候选版本不匹配");
  const checks = uniqueIds(value.checks, "review.checks");
  for (const id of REVIEW_CHECKS) if (!checks.has(id)) fail(`缺少评估项 ${id}`);
  uniqueIds(value.issues, "review.issues");
  if (value.verdict === "pass" && (value.checks.some((item) => !item.passed)
      || value.issues.some((item) => item.blocking))) fail("评估未全部通过或仍有阻断问题，不能判定 pass");
  if (value.verdict !== "pass" && value.checks.every((item) => item.passed)
      && !value.issues.some((item) => item.blocking)) fail("未通过评估必须说明未通过项或阻断问题");
  return structuredClone(value);
}

export function designHash(value) {
  const seen = new Set();
  function canonical(item) {
    if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || seen.has(item)) fail("候选必须为可序列化 JSON");
    seen.add(item);
    const result = Array.isArray(item) ? `[${item.map(canonical).join(",")}]`
      : `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`).join(",")}}`;
    seen.delete(item);
    return result;
  }
  return createHash("sha256").update(canonical(value)).digest("hex");
}
