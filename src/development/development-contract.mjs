import { createHash } from "node:crypto";
import { InputError } from "../requirements/core.mjs";

const text = (maxLength = 4000, minLength = 1) => ({ type: "string", minLength, maxLength });
const identifier = { ...text(80), pattern: "^[A-Za-z][A-Za-z0-9_-]*$" };
const choice = (...values) => ({ type: "string", enum: values });
const list = (items, minItems = 0, maxItems = 100) => ({ type: "array", items, minItems, maxItems });
const object = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const references = (minItems = 0) => ({ ...list(identifier, minItems), uniqueItems: true });
const paths = (minItems = 0) => ({ ...list(text(500), minItems), uniqueItems: true });

export const PLAN_SCHEMA = object({
  summary: text(), runtime: choice("node-json"), entrypoint: text(500),
  tasks: list(object({
    id: identifier, title: text(200), description: text(), requirementIds: references(1),
    acceptanceIds: references(1), dependsOn: references(), files: paths(1),
  }), 1, 40),
  cases: list(object({
    id: identifier, taskId: identifier, acceptanceId: identifier, input: text(12_000, 0),
    assertions: list(object({ path: text(500, 0), expectedJson: text(60_000) }), 1, 40),
  }), 1, 200),
});

export const REVIEW_SCHEMA = object({
  subjectHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
  verdict: choice("pass", "revise", "blocked"), summary: text(),
  issues: list(object({
    id: identifier, blocking: { type: "boolean" }, kind: choice("code", "plan", "architecture", "environment"),
    description: text(), remedy: text(),
  })),
});

export const WORK_SCHEMA = object({
  summary: text(), changedFiles: paths(), knownIssues: list(text()), nextAction: text(4000, 0),
  continue: { type: "boolean" },
});

function fail(message) { throw new InputError(`研发契约无效：${message}`); }

function validateSchema(value, schema, path) {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${path} 必须为对象`);
    for (const key of schema.required) if (!Object.hasOwn(value, key)) fail(`${path}.${key} 缺失`);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key)) fail(`${path} 包含不支持的字段`);
      validateSchema(value[key], schema.properties[key], `${path}.${key}`);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems) fail(`${path} 条目数量无效`);
    for (let index = 0; index < value.length; index++) validateSchema(value[index], schema.items, `${path}[${index}]`);
    if (schema.uniqueItems && new Set(value).size !== value.length) fail(`${path} 包含重复引用`);
  } else if (schema.type === "string") {
    if (typeof value !== "string" || value.includes("\0")
      || (schema.minLength && !value.trim()) || value.length < (schema.minLength ?? 0)
      || (schema.maxLength && value.length > schema.maxLength)
      || (schema.pattern && !new RegExp(schema.pattern).test(value))
      || (schema.enum && !schema.enum.includes(value))) fail(`${path} 文本或取值无效`);
  } else if (typeof value !== "boolean") fail(`${path} 必须为布尔值`);
}

const forbiddenPart = /^(?:\..*|node_modules|venv|__pycache__|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*(?:secret|credential|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key).*|.*\.(?:pem|key|p12|pfx))$/i;

export function safeRelativePath(value) {
  if (typeof value !== "string" || !value || value.length > 500 || value.trim() !== value
    || /[\\\x00-\x1f\x7f:*?"<>|]/.test(value)
    || value.split("/").some((part) => !part || forbiddenPart.test(part))) {
    fail("文件必须使用工作区内的安全相对路径，不能访问隐藏文件、依赖目录或凭据");
  }
  return value;
}

function uniqueIds(items, label) {
  const ids = items.map((item) => item.id);
  if (new Set(ids).size !== ids.length) fail(`${label} 包含重复 ID`);
  return new Set(ids);
}

function referenced(id, ids, label) {
  if (!ids.has(id)) fail(`${label} 引用了不存在的 ID`);
}

function parsedExpected(value) {
  try { return JSON.parse(value); }
  catch { fail("验收断言 expectedJson 必须是合法 JSON"); }
}

function safeAssertionPath(value) {
  if (value === "") return;
  if (!/^(?:[A-Za-z_$][A-Za-z0-9_$-]*|0|[1-9][0-9]*)(?:\.(?:[A-Za-z_$][A-Za-z0-9_$-]*|0|[1-9][0-9]*))*$/.test(value)
    || value.split(".").some((part) => ["__proto__", "prototype", "constructor"].includes(part))) {
    fail("验收断言路径必须为空或安全的属性路径，如 result.items.0");
  }
}

export function validatePlan(value, { architecture, previousPlan } = {}) {
  validateSchema(value, PLAN_SCHEMA, "plan");
  const requirements = architecture?.requirements;
  const acceptance = architecture?.design?.acceptance;
  if (!Array.isArray(requirements) || !requirements.length || !Array.isArray(acceptance) || !acceptance.length) {
    fail("缺少已确认的架构需求或验收清单");
  }
  for (const item of [...requirements, ...acceptance]) validateSchema(item?.id, identifier, "architecture.id");
  const requirementIds = uniqueIds(requirements, "architecture.requirements");
  const acceptanceIds = uniqueIds(acceptance, "architecture.acceptance");
  const taskIds = uniqueIds(value.tasks, "plan.tasks");
  uniqueIds(value.cases, "plan.cases");
  const tasks = new Map(value.tasks.map((task) => [task.id, task]));
  const coveredRequirements = new Set();
  const coveredAcceptance = new Set();
  const files = new Set();
  for (const task of value.tasks) {
    for (const id of task.requirementIds) { referenced(id, requirementIds, "task.requirementIds"); coveredRequirements.add(id); }
    for (const id of task.acceptanceIds) { referenced(id, acceptanceIds, "task.acceptanceIds"); coveredAcceptance.add(id); }
    for (const id of task.dependsOn) referenced(id, taskIds, "task.dependsOn");
    for (const file of task.files) files.add(safeRelativePath(file));
  }
  for (const id of requirementIds) if (!coveredRequirements.has(id)) fail(`需求 ${id} 缺少研发任务`);
  for (const id of acceptanceIds) if (!coveredAcceptance.has(id)) fail(`验收 ${id} 缺少研发任务`);
  safeRelativePath(value.entrypoint);
  if (!/\.(?:mjs|js)$/.test(value.entrypoint) || !files.has(value.entrypoint)) fail("Node 入口必须是任务文件清单中的 .mjs 或 .js 文件");
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visiting.has(id)) fail("任务依赖存在循环");
    if (visited.has(id)) return;
    visiting.add(id);
    tasks.get(id).dependsOn.forEach(visit);
    visiting.delete(id); visited.add(id);
  }
  taskIds.forEach(visit);
  const testedTasks = new Set(), testedAcceptance = new Set(), testedPairs = new Set();
  for (const test of value.cases) {
    referenced(test.taskId, taskIds, "case.taskId");
    referenced(test.acceptanceId, acceptanceIds, "case.acceptanceId");
    if (!tasks.get(test.taskId).acceptanceIds.includes(test.acceptanceId)) fail("用例引用的验收条目未分配给当前任务");
    testedTasks.add(test.taskId); testedAcceptance.add(test.acceptanceId);
    testedPairs.add(`${test.taskId}:${test.acceptanceId}`);
    const assertionPaths = new Set();
    for (const assertion of test.assertions) {
      safeAssertionPath(assertion.path); parsedExpected(assertion.expectedJson);
      if (assertionPaths.has(assertion.path)) fail("同一用例包含重复的断言路径");
      assertionPaths.add(assertion.path);
    }
  }
  for (const id of taskIds) if (!testedTasks.has(id)) fail(`任务 ${id} 缺少实际验收用例`);
  for (const id of acceptanceIds) if (!testedAcceptance.has(id)) fail(`验收 ${id} 缺少实际验收用例`);
  for (const task of value.tasks) for (const id of task.acceptanceIds) {
    if (!testedPairs.has(`${task.id}:${id}`)) fail(`任务 ${task.id} 的验收 ${id} 缺少实际用例`);
  }
  if (previousPlan !== undefined) {
    const previous = validatePlan(previousPlan, { architecture });
    const cases = new Map(value.cases.map((test) => [test.id, test]));
    for (const old of previous.cases) {
      const current = cases.get(old.id);
      if (!current || current.acceptanceId !== old.acceptanceId || current.input !== old.input) fail("修订计划不能删除或替换已确认的验收用例");
      for (const assertion of old.assertions) {
        const unchanged = current.assertions.find((entry) => entry.path === assertion.path);
        if (!unchanged || hashValue(parsedExpected(unchanged.expectedJson)) !== hashValue(parsedExpected(assertion.expectedJson))) {
          fail("修订计划不能删除或放宽已确认的验收断言");
        }
      }
    }
  }
  return structuredClone(value);
}

export function validateReview(value, { subjectHash } = {}) {
  validateSchema(value, REVIEW_SCHEMA, "review");
  if (value.subjectHash !== subjectHash) fail("评审结果与当前审查版本不匹配");
  uniqueIds(value.issues, "review.issues");
  const blocking = value.issues.some((issue) => issue.blocking);
  if (value.verdict === "pass" && blocking) fail("仍有阻断问题，不能判定 pass");
  if (value.verdict !== "pass" && !blocking) fail("未通过评审必须说明阻断问题");
  return structuredClone(value);
}

export function validateWork(value) {
  validateSchema(value, WORK_SCHEMA, "work");
  value.changedFiles.forEach(safeRelativePath);
  if (value.continue && !value.nextAction.trim()) fail("续接任务必须说明下一步动作");
  return structuredClone(value);
}

export function hashValue(value) {
  const seen = new Set();
  function canonical(item) {
    if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || seen.has(item)
      || (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))) fail("摘要内容必须为可序列化 JSON");
    seen.add(item);
    const result = Array.isArray(item)
      ? `[${Array.from(item, canonical).join(",")}]`
      : `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`).join(",")}}`;
    seen.delete(item);
    return result;
  }
  return createHash("sha256").update(canonical(value)).digest("hex");
}
