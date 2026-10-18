import { validateValueSchema } from "../applications/application-contract.mjs";

const fail = (message) => { const error = new Error(message); error.reason = "invalid_workflow"; throw error; };
const plain = (value) => value && typeof value === "object" && !Array.isArray(value);
const identifier = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const pathPattern = /^(?:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)?$/;
const fields = (value, allowed) => { if (!plain(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail("流程字段无效"); };
function templateRefs(value, refs = new Set(), depth = 0) {
  if (depth > 12) fail("流程输入过深");
  if (Array.isArray(value)) { value.forEach((child) => templateRefs(child, refs, depth + 1)); return refs; }
  if (!plain(value)) return refs;
  if (Object.keys(value).some((key) => key.startsWith("$"))) {
    if (Object.hasOwn(value, "$step")) { fields(value, ["$step", "path"]); if (!identifier.test(value.$step) || !pathPattern.test(value.path ?? "")) fail("步骤结果引用无效"); refs.add(value.$step); }
    else if (Object.hasOwn(value, "$input")) { fields(value, ["$input"]); if (typeof value.$input !== "string" || !pathPattern.test(value.$input)) fail("输入引用无效"); }
    else if (value.$item === true) fields(value, ["$item"]);
    else if (value.$response === true) fields(value, ["$response"]);
    else fail("未知流程引用");
  } else for (const child of Object.values(value)) templateRefs(child, refs, depth + 1);
  return refs;
}
export function validateWorkflowDefinition(value, { operationIds } = {}) {
  fields(value, ["schemaVersion", "entryActionId", "steps", "outputs"]);
  if (value.schemaVersion !== 1 || !Array.isArray(value.steps) || !value.steps.length || value.steps.length > 100) fail("流程版本或步骤数量无效");
  if (!identifier.test(value.entryActionId) || operationIds && !operationIds.includes(value.entryActionId)) fail("流程公开入口无效");
  const steps = new Map();
  for (const step of value.steps) {
    fields(step, ["id", "actionId", "dependsOn", "input", "batch", "waitForInput", "idempotent", "maxRetries"]);
    if (!identifier.test(step.id) || steps.has(step.id) || !identifier.test(step.actionId) || step.actionId === value.entryActionId || operationIds && !operationIds.includes(step.actionId)) fail("流程动作或标识无效");
    if (!Array.isArray(step.dependsOn) || step.dependsOn.some((id) => !identifier.test(id)) || new Set(step.dependsOn).size !== step.dependsOn.length || typeof step.idempotent !== "boolean" || !Number.isSafeInteger(step.maxRetries ?? 0) || (step.maxRetries ?? 0) < 0 || (step.maxRetries ?? 0) > 2 || !step.idempotent && step.maxRetries) fail("流程依赖或重试策略无效");
    if (step.batch) { fields(step.batch, ["inputPath", "maxItems"]); if (!pathPattern.test(step.batch.inputPath) || !Number.isSafeInteger(step.batch.maxItems) || step.batch.maxItems < 1 || step.batch.maxItems > 1000) fail("批次输入无效"); }
    if (step.waitForInput) { fields(step.waitForInput, ["prompt", "inputSchema"]); if (typeof step.waitForInput.prompt !== "string" || !step.waitForInput.prompt.trim() || step.waitForInput.prompt.length > 2000) fail("确认说明无效"); validateValueSchema(step.waitForInput.inputSchema); }
    for (const id of templateRefs(step.input)) if (!step.dependsOn.includes(id)) fail("步骤结果只能引用显式依赖");
    steps.set(step.id, step);
  }
  const visited = new Set(), pending = new Set();
  const visit = (id) => { if (!steps.has(id) || pending.has(id)) fail("流程依赖缺失或循环"); if (visited.has(id)) return; pending.add(id); for (const dependency of steps.get(id).dependsOn) visit(dependency); pending.delete(id); visited.add(id); };
  for (const id of steps.keys()) visit(id);
  if (!Array.isArray(value.outputs) || !value.outputs.length || value.outputs.some((id) => !steps.has(id)) || new Set(value.outputs).size !== value.outputs.length) fail("流程输出无效");
  return structuredClone(value);
}
const text = { type: "string" };
export const WORKFLOW_SCHEMA = { type: "object", additionalProperties: false, required: ["schemaVersion", "entryActionId", "steps", "outputs"], properties: {
  schemaVersion: { type: "integer", const: 1 }, entryActionId: text, outputs: { type: "array", items: text },
  steps: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", additionalProperties: false, required: ["id", "actionId", "dependsOn", "idempotent"], properties: {
    id: text, actionId: text, dependsOn: { type: "array", items: text }, input: {}, idempotent: { type: "boolean" }, maxRetries: { type: "integer", minimum: 0, maximum: 2 },
    batch: { type: "object", additionalProperties: false, required: ["inputPath", "maxItems"], properties: { inputPath: text, maxItems: { type: "integer", minimum: 1, maximum: 1000 } } },
    waitForInput: { type: "object", additionalProperties: false, required: ["prompt", "inputSchema"], properties: { prompt: text, inputSchema: { type: "object", additionalProperties: true } } }
  } } }
} };
