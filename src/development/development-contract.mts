import type { ToolSchema } from "../contracts/tools.mjs";
import type { UnknownRecord } from "../contracts/json.mjs";
import type { DevelopmentPlan, DevelopmentCase, DevelopmentTask, DevelopmentArchitecture, DevelopmentIssue, DevelopmentReview, DevelopmentWork, FixtureBudget } from "../contracts/development.mjs";
import { objectFields, isInteger } from "../runtime/type-boundary.mjs";
interface PlanOptions { architecture?: DevelopmentArchitecture | undefined; previousPlan?: DevelopmentPlan | undefined; freshWorkspace?: boolean }
import { validateApplicationManifest, validateActionInput, VALUE_SCHEMA_DESCRIPTION } from "../applications/application-contract.mjs";
import { ACTION_CAPABILITIES } from "./node-action-bootstrap.mjs";
import { createHash } from "node:crypto";
import { InputError } from "../requirements/core.mjs";
import { testJsonSchema, resolveTestJson, resolveCaseInput, resolveCaseValues, inputContractRejection } from "./development-fixtures.mjs";
import { acceptanceCaseMatches, activationBusinessAcceptanceItems, developmentAcceptanceItems, requiredDevelopmentRequirementIds, validateAcceptanceCoverage, validateAcceptanceVerification } from "../verification/acceptance-contract.mjs";
import { MATERIAL_CHECKS_SCHEMA, assertCaseMaterials } from "./development-test-material-audit.mjs";
import { REQUIREMENT_LIMITS } from "../requirements/requirement-limits.mjs";
import { textLength, textWithinLimit } from "../runtime/text-length.mjs";

const text = (maxLength = 4000, minLength = 1) => ({ type: "string", minLength, maxLength });
const identifier = { ...text(80), pattern: "^[A-Za-z][A-Za-z0-9_-]*$" };
const choice = (...values: string[]) => ({ type: "string", enum: values });
const list = <T extends ToolSchema>(items: T, minItems = 0, maxItems = 100) => ({ type: "array", items, minItems, maxItems });
const object = <P extends Record<string, ToolSchema>>(properties: P): ToolSchema & { type: "object"; properties: P; required: string[]; additionalProperties: false } => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const references = (minItems = 0) => ({ ...list(identifier, minItems), uniqueItems: true });
const paths = (minItems = 0) => ({ ...list(text(500), minItems), uniqueItems: true });
const openObject = { type: "object", properties: {}, required: [], additionalProperties: true };
const valueSchema = { ...openObject, description: VALUE_SCHEMA_DESCRIPTION };
const applicationPlan = object({
  protocolVersion: { type: "integer", enum: [2, 3] }, runtime: choice("node-action", "managed-service"), entrypoint: text(500),
  page: { anyOf: [{ type: "null" }, object({ entrypoint: text(500), resources: list(object({ path: text(500), sha256: text(64, 0) }), 1, 200) })] },
  actions: list(object({ id: identifier, title: text(200), inputSchema: valueSchema, outputSchema: valueSchema, connectionIds: references() }), 0, 80),
  stateVersion: { type: "integer", minimum: 1 }, evidenceIds: list(text(100), 0, 200), service: openObject,
});
applicationPlan.required = Object.keys(applicationPlan.properties).filter((key) => key !== "service");

export const LEGACY_PLAN_SCHEMA = object({
  summary: text(), runtime: choice("node-json"), entrypoint: text(500),
  tasks: list(object({
    id: identifier, title: text(200), description: text(), requirementIds: { ...references(1), maxItems: REQUIREMENT_LIMITS.formalItems },
    acceptanceIds: { ...references(1), description: "每个任务至少一项本地可执行的development验收，并有taskId及acceptanceId同时匹配、适配器类型一致的具体用例；集成任务的跨任务联合验收不能替代前序任务验收或清空其映射。按可运行增量分配职责，不无谓复制全部条目；只含helper且不能独立运行时应重整任务。delivery-review由独立评审负责，activation/runtime由宿主台账负责，不得伪造代码用例。" }, dependsOn: references(), files: paths(1),
  }), 1, 40),
  cases: list(object({
    id: identifier, taskId: { ...identifier, description: "本用例实际验证的任务编号；与acceptanceId共同覆盖该任务分配的一个验收组合。" },
    acceptanceId: { ...identifier, description: "须属于taskId对应任务的acceptanceIds；每个已分配组合至少一例，不仅是逐任务和逐验收分别覆盖。" }, input: text(12_000, 0),
    assertions: list(object({ path: text(500, 0), expectedJson: text(60_000) }), 1, 40),
  }), 1, 200),
});
Object.assign(LEGACY_PLAN_SCHEMA.properties.cases.items.properties, { materialChecks: MATERIAL_CHECKS_SCHEMA });

const actionCase = object({ ...LEGACY_PLAN_SCHEMA.properties.cases.items.properties,
  input: testJsonSchema(12_000),
  assertions: list(object({ path: text(500, 0), expectedJson: testJsonSchema(60_000) }), 1, 40),
  kind: choice("action", "node-check", "input-rejection"), entrypoint: text(500),
  actionId: identifier,
  inputTarget: choice("action-value", "task-envelope"),
  mocks: list(object({ capability: text(100), argsJson: testJsonSchema(60_000), resultJson: testJsonSchema(60_000) }), 0, 100),
});
actionCase.required = [...LEGACY_PLAN_SCHEMA.properties.cases.items.required];
const caseShapes = Object.freeze([
  { kind: "node-check", required: ["kind", "entrypoint"], forbidden: ["actionId", "mocks"], textOnly: true,
    reason: "node_check_invalid", message: "Node 检查只用于页面验收，使用独立入口与文本输入断言，不能声明业务动作或能力替身" },
  { kind: "action", required: ["actionId", "mocks"], forbidden: ["entrypoint"],
    reason: "action_case_invalid", message: "动作验收必须提供能力替身列表，不能指定其他入口" },
  { kind: "input-rejection", required: ["kind", "actionId", "mocks"], forbidden: ["entrypoint"], empty: ["mocks", "workflowInputs"],
    reason: "action_case_invalid", message: "输入契约拒绝验收不能调用动作、能力或提供流程回复" },
]);
Object.assign(actionCase, { allOf: caseShapes.map((shape) => ({
  if: { properties: { kind: { const: shape.kind } }, ...(shape.kind === "action" ? {} : { required: ["kind"] }) },
  then: { required: shape.required, properties: { ...Object.fromEntries(shape.forbidden.map((key) => [key, false])),
    ...Object.fromEntries((shape.empty ?? []).map((key) => [key, { maxItems: 0 }])),
    ...(shape.kind === "input-rejection" ? {} : { inputTarget: false }),
    ...(shape.textOnly ? { input: { type: "string" }, assertions: { items: { properties: { expectedJson: { type: "string" } } } } } : {}) } },
})) });
export const PLAN_V2_SCHEMA = object({ ...LEGACY_PLAN_SCHEMA.properties,
  schemaVersion: { type: "integer", enum: [2] }, runtime: choice("node-action"),
  application: applicationPlan, cases: list(actionCase, 1, 200),
});
export const PLAN_V3_SCHEMA = object({ ...PLAN_V2_SCHEMA.properties,
  schemaVersion: { type: "integer", enum: [3] }, runtime: choice("node-action", "managed-service"),
  activationChecks: list(object({ acceptanceId: identifier, executionScope: { ...choice("isolated", "shared"),
    description: "默认isolated每例独立作用域；shared按caseIds顺序共享作用域与数据。managed-service同时复用常驻worker，builtin仍逐次隔离执行，不能据此证明常驻内存隔离。模式与原序列随计划冻结。" }, caseIds: { ...references(1),
    description: "仅host-business验收使用，每项恰好一组；引用既有研发cases或绑定本条验收的activationCases，均为公开动作的实际action或合法input-rejection。专用激活用例不计研发覆盖，原输入与断言保持冻结。" } }), 0, 80),
  cases: list({ ...actionCase, properties: { ...actionCase.properties,
    workflowInputs: list(object({ stepId: identifier, inputJson: text(60_000) }), 0, 100) } }, 1, 200),
});
PLAN_V3_SCHEMA.properties.activationChecks.items.required = ["acceptanceId", "caseIds"];
const activationCase = structuredClone(PLAN_V3_SCHEMA.properties.cases.items);
activationCase.required = activationCase.required.filter((key) => key !== "taskId");
activationCase.properties.kind = choice("action", "input-rejection");
Object.assign(PLAN_V3_SCHEMA.properties, { activationCases: list(activationCase, 0, 200) });
PLAN_V3_SCHEMA.required = PLAN_V3_SCHEMA.required.filter((key) => !["activationChecks", "activationCases"].includes(key));
export const PLAN_SCHEMA = LEGACY_PLAN_SCHEMA;

export const REVIEW_SCHEMA = object({
  subjectHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
  verdict: choice("pass", "revise", "blocked"), summary: text(),
  issues: list(object({
    id: identifier, blocking: { type: "boolean" }, kind: choice("code", "plan", "architecture", "environment"),
    description: text(), remedy: text(),
    taskIds: references(), files: paths(), candidatePaths: list(text(1000)),
  })),
});
REVIEW_SCHEMA.properties.issues.items.required = ["id", "blocking", "kind", "description", "remedy"];

export const WORK_SCHEMA = object({
  summary: text(), changedFiles: paths(), knownIssues: list(text()), nextAction: text(4000, 0),
  continue: { type: "boolean" },
});

function fail(message: string, issue?: DevelopmentIssue): never {
  const error = new InputError(`研发契约无效：${message}`);
  if (issue) error.developmentIssue = issue;
  throw error;
}

function validateSchema(value: unknown, schema: ToolSchema, path: string): void {
  if (schema.anyOf) {
    for (const option of schema.anyOf) {
      try { validateSchema(value, option, path); return; } catch (error) { if (!(error instanceof InputError)) throw error; }
    }
    fail(`${path} 不符合允许的结构`);
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${path} 必须为对象`);
    for (const key of (schema.required ?? [])) if (!Object.hasOwn(value, key)) fail(`${path}.${key} 缺失`);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties ?? {}, key)) { if (schema.additionalProperties === true) continue; fail(`${path} 包含不支持的字段`); }
      validateSchema(objectFields(value)[key], schema.properties![key]!, `${path}.${key}`);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value) || value.length < Number(schema.minItems) || value.length > Number(schema.maxItems)) fail(`${path} 条目数量无效`);
    for (let index = 0; index < value.length; index++) validateSchema(value[index], schema.items!, `${path}[${index}]`);
    if (schema.uniqueItems && new Set(value).size !== value.length) fail(`${path} 包含重复引用`);
  } else if (schema.type === "string") {
    if (typeof value !== "string" || value.includes("\0")
      || (schema.minLength && !value.trim()) || textLength(value) < Number(schema.minLength ?? 0)
      || (schema.maxLength && !textWithinLimit(value, Number(schema.maxLength)))
      || (schema.pattern && !new RegExp(String(schema.pattern)).test(value))
      || (schema.enum && !schema.enum.includes(value))) fail(`${path} 文本或取值无效`);
  } else if (schema.type === "integer") {
    if (!isInteger(value) || (schema.enum && !schema.enum.includes(value))
      || (schema.minimum !== undefined && value < Number(schema.minimum))) fail(`${path} 版本无效`);
  } else if (schema.type === "null") {
    if (value !== null) fail(`${path} 必须为 null`);
  } else if (typeof value !== "boolean") fail(`${path} 必须为布尔值`);
}

const forbiddenPart = /^(?:\..*|node_modules|venv|__pycache__|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*(?:secret|credential|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key).*|.*\.(?:pem|key|p12|pfx))$/i;

export function safeRelativePath(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 500 || value.trim() !== value
    || /[\\\x00-\x1f\x7f:*?"<>|]/.test(value)
    || value.split("/").some((part) => !part || forbiddenPart.test(part))) {
    fail("文件必须使用工作区内的安全相对路径，不能访问隐藏文件、依赖目录或凭据");
  }
  return value;
}

function uniqueIds(items: { id: string }[], label: string) {
  const ids = items.map((item) => item.id);
  if (new Set(ids).size !== ids.length) fail(`${label} 包含重复 ID`);
  return new Set(ids);
}

function referenced(id: string | undefined, ids: Set<string>, label: string) {
  if (!ids.has(id!)) fail(`${label} 引用了不存在的 ID`);
}

function parsedExpected(value: unknown) {
  try { return resolveTestJson(value).value; }
  catch { fail("验收断言 expectedJson 必须是合法 JSON"); }
}

function validateCaseShape(value: DevelopmentCase) {
  const shape = caseShapes.find((item) => item.kind === (value.kind ?? "action"))!;
  if (value.inputTarget !== undefined && value.kind !== "input-rejection")
    fail("inputTarget只能用于input-rejection用例", { path: "plan.cases[].inputTarget", reason: "action_case_invalid" });
  for (const key of shape.required) if (!Object.hasOwn(value, key)) fail(shape.message, { path: `plan.cases[].${key}`, reason: shape.reason });
  for (const key of shape.forbidden) if (Object.hasOwn(value, key)) fail(shape.message, { path: `plan.cases[].${key}`, reason: shape.reason });
  for (const key of shape.empty ?? []) if (Array.isArray(objectFields(value)[key]) && (objectFields(value)[key] as unknown[]).length) fail(shape.message, { path: `plan.cases[].${key}`, reason: shape.reason });
  if (shape.textOnly && (typeof value.input !== "string" || value.assertions.some((item) => typeof item.expectedJson !== "string")))
    fail(shape.message, { path: "plan.cases[].input", reason: shape.reason });
}

function sameFrozenTestJson(current: unknown, previous: unknown) {
  if (hashValue(current) !== hashValue(previous)) return false;
  return typeof previous === "string" || resolveTestJson(current).fixture!.sha256 === resolveTestJson(previous).fixture!.sha256;
}

function sameFrozenCaseInput(current: DevelopmentCase, previous: DevelopmentCase, maxInputBytes: number) {
  if (hashValue(current.input) !== hashValue(previous.input)) return false;
  if (typeof previous.input === "string") return true;
  const first = resolveCaseInput(current, { maxInputBytes }), second = resolveCaseInput(previous, { maxInputBytes });
  return first.fixture!.sha256 === second.fixture!.sha256;
}

function safeAssertionPath(value: string) {
  if (value === "") return;
  if (!/^(?:[A-Za-z_$][A-Za-z0-9_$-]*|0|[1-9][0-9]*)(?:\.(?:[A-Za-z_$][A-Za-z0-9_$-]*|0|[1-9][0-9]*))*$/.test(value)
    || value.split(".").some((part) => ["__proto__", "prototype", "constructor"].includes(part))) {
    fail("验收断言路径必须为空或安全的属性路径，如 result.items.0");
  }
}

export function activationCaseEntries(value: Pick<DevelopmentPlan, "cases" | "activationCases"> | null | undefined): { test: DevelopmentCase; source: "development" | "activation"; index: number }[];
export function activationCaseEntries(value: unknown): { test: unknown; source: "development" | "activation"; index: number }[];
export function activationCaseEntries(input: unknown): { test: unknown; source: "development" | "activation"; index: number }[] {
  const value = objectFields(input);
  return ([["development", value?.cases], ["activation", value?.activationCases]] as const).flatMap(([source, items]) =>
    (Array.isArray(items) ? items as unknown[] : []).map((test, index) => ({ test, source, index })));
}

export function actionExecutionIssues(input: unknown) {
  const plan = objectFields(input), application = objectFields(plan.application), service = objectFields(application.service);
  const actions = Array.isArray(application.actions) ? (application.actions as unknown[]).map(objectFields) : [];
  const operations = Array.isArray(service.operations) ? (service.operations as unknown[]).map(objectFields) : [];
  const cases = Array.isArray(plan?.cases) ? (plan.cases as unknown[]).map(objectFields) : [];
  const executed = (id: unknown) => cases.some((item) => !["node-check", "input-rejection"].includes(typeof item?.kind === "string" ? item.kind : "") && item?.actionId === id);
  const location = (id: unknown, fallback: string) => {
    const index = operations.findIndex((item) => item?.id === id);
    return index < 0 ? fallback : `plan.application.service.operations[${index}]`;
  };
  const issues = actions.flatMap((action, index) => executed(action?.id) ? [] : [{
    path: location(action?.id, `plan.application.actions[${index}]`), reason: "action_missing", migration: false,
  }]);
  const migration = service.migration;
  if (migration) for (const field of ["actionId", "verifyActionId"] as const) if (!executed(objectFields(migration)[field])) issues.push({
    path: location(objectFields(migration)[field], `plan.application.service.migration.${field}`), reason: "action_missing", migration: true,
  });
  return issues;
}

export function nextReadyDevelopmentTask<T extends { id: string; status: string; dependsOn: string[] }>(tasks: T[]) {
  return tasks.find((task) => task.status !== "verified"
    && task.dependsOn.every((id) => tasks.some((item) => item.id === id && item.status === "verified")));
}

export function taskEntrypointIssues(input: unknown) {
  const plan = objectFields(input);
  if (!Array.isArray(plan?.tasks) || !Array.isArray(plan.cases) || typeof plan.entrypoint !== "string") return [];
  try { safeRelativePath(plan.entrypoint); } catch { return []; }
  const rawTasks = (plan.tasks as unknown[]).map(objectFields);
  const cases = (plan.cases as unknown[]).map(objectFields);
  const ids = new Set(rawTasks.map((task) => task?.id));
  if (ids.size !== plan.tasks.length || rawTasks.some((task) => typeof task?.id !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(task.id)
    || !Array.isArray(task.dependsOn) || (task.dependsOn as unknown[]).some((id) => !ids.has(id!)) || !Array.isArray(task.files))) return [];
  // These three consumed fields were checked above, including dependency membership in string IDs.
  const tasks = rawTasks as { id: string; dependsOn: string[]; files: unknown[] }[];
  const pending = tasks.map((task, index) => ({ id: task.id, dependsOn: task.dependsOn, status: "pending", index })), ordered = [];
  for (let count = 0; count < pending.length; count++) {
    const task = nextReadyDevelopmentTask(pending);
    if (!task) return [];
    ordered.push(task.index); task.status = "verified";
  }
  const availableFiles = new Set(), issues = [];
  for (const index of ordered) {
    const task = tasks[index]!; task.files.forEach((file) => availableFiles.add(file));
    const executesCode = cases.some((test) => test?.taskId === task.id && !["input-rejection", "node-check"].includes(typeof test.kind === "string" ? test.kind : ""));
    if (executesCode && !availableFiles.has(plan.entrypoint)) issues.push({ path: `plan.tasks[${index}].files`, reason: "task_entrypoint_unavailable",
      taskId: task.id, requiredEntrypoint: plan.entrypoint });
  }
  return issues;
}

export function activationCheckIssues(input: unknown, { architecture, previousPlan }: PlanOptions = {}) {
  const value = objectFields(input);
  const application = objectFields(value.application);
  const issues: DevelopmentIssue[] = [], expected = activationBusinessAcceptanceItems(architecture), rows = Array.isArray(value?.activationChecks) ? (value.activationChecks as unknown[]).map(objectFields) : [];
  const acceptance = Array.isArray(architecture?.design?.acceptance) ? architecture.design.acceptance : [], entries = activationCaseEntries(value).map(entry => ({ ...entry, test: objectFields(entry.test) }));
  const publicActions = new Map((Array.isArray(application.actions) ? (application.actions as unknown[]).map(objectFields) : []).filter(Boolean).map((item) => [item.id, item]));
  const add = (path: string, reason: string, referenceId?: string) => issues.push({ path, reason, ...(referenceId ? { referenceId } : {}) });
  for (const [index, row] of rows.entries()) {
    const path = `plan.activationChecks[${index}]`, item = expected.find((entry: { id: string; requirementIds?: string[] }) => entry.id === row?.acceptanceId);
    if (!item || rows.filter((entry) => entry?.acceptanceId === row?.acceptanceId).length !== 1) {
      add(`${path}.acceptanceId`, "activation_check_reference_invalid", item?.id); continue;
    }
    const ids: unknown[] = Array.isArray(row.caseIds) ? row.caseIds : [];
    if (!ids.length || new Set(ids).size !== ids.length) add(`${path}.caseIds`, "activation_case_invalid", item.id);
    const covered = new Set();
    for (const [position, id] of ids.entries()) {
      const matching = entries.filter((entry) => entry.test?.id === id), selected = matching[0], test = selected?.test;
      const target = test && acceptance.find((entry) => entry.id === test.acceptanceId), action = test && publicActions.get(test.actionId);
      let valid = matching.length === 1 && target && action && ["action", "input-rejection"].includes(typeof test.kind === "string" ? test.kind : test.kind == null ? "action" : "");
      if (valid) try {
        valid = selected!.source === "activation" ? target!.id === item.id && validateAcceptanceVerification(target!).adapterId === "host-business"
          : acceptanceCaseMatches(target!, test!);
        const resolved = resolveCaseValues(test!, { maxInputBytes: value.runtime === "managed-service" ? 1024 * 1024 : 128 * 1024 });
        if (test!.kind === "input-rejection") valid &&= inputContractRejection(action!, resolved.input, { target: test!.inputTarget }).rejected;
        else { try { validateActionInput({ inputSchema: action!.inputSchema }, resolved.input); } catch { valid = false; } }
      } catch { valid = false; }
      if (!valid) add(`${path}.caseIds[${position}]`, "activation_case_invalid", item.id);
      else for (const requirementId of target!.requirementIds ?? []) covered.add(requirementId);
    }
    for (const requirementId of item.requirementIds ?? []) if (!covered.has(requirementId))
      add(`${path}.caseIds`, "activation_requirement_missing", requirementId);
  }
  for (const item of expected) if (!rows.some((row) => row?.acceptanceId === item.id))
    add("plan.activationChecks", "activation_checks_missing", item.id);
  for (const { test, source, index } of entries) if (source === "activation") {
    if (!expected.some((item: { id: string }) => item.id === test?.acceptanceId)) add(`plan.activationCases[${index}].acceptanceId`, "activation_check_reference_invalid");
    if (!rows.some((row) => row?.acceptanceId === test?.acceptanceId && (Array.isArray(row.caseIds) && row.caseIds.includes(test?.id))))
      add(`plan.activationCases[${index}].id`, "activation_case_unassigned", typeof test?.id === "string" ? test.id : undefined);
  }
  for (const [index, old] of (Array.isArray(previousPlan?.activationChecks) ? previousPlan.activationChecks : []).entries()) {
    const current = rows.find((row) => row?.acceptanceId === old.acceptanceId);
    if (!current || (current.executionScope ?? "isolated") !== (old.executionScope ?? "isolated")
      || (old.executionScope === "shared" ? !Array.isArray(current.caseIds) || old.caseIds.some((id, position) => objectFields(current.caseIds)[position] !== id)
        : (Array.isArray(old.caseIds) ? old.caseIds : []).some((id) => !Array.isArray(current.caseIds) || !current.caseIds.includes(id))))
      add(`plan.activationChecks[${index}].caseIds`, "activation_check_frozen", old.acceptanceId);
  }
  return issues;
}

export function validatePlan(input: unknown, { architecture, previousPlan, freshWorkspace = false }: PlanOptions = {}): DevelopmentPlan {
  const raw = objectFields(input);
  if (architecture?.design?.schemaVersion === 3 && architecture.design.execution?.language === "none")
    fail("已评审方案无需代码研发，应返回架构层核对交付分流", { path: "plan.runtime", reason: "development_not_required" });
  if (architecture?.design?.schemaVersion === 3 && raw.schemaVersion !== 3) fail("v3 架构必须使用 v3 研发计划");
  if (architecture?.design?.schemaVersion === 2 && (raw.schemaVersion !== 2 || raw.runtime !== "node-action")) {
    fail("已批准的 v2 架构必须使用 schemaVersion=2 和 node-action，不能降级为旧执行协议");
  }
  validateSchema(input, raw.schemaVersion === 3 ? PLAN_V3_SCHEMA : raw.schemaVersion === 2 ? PLAN_V2_SCHEMA : LEGACY_PLAN_SCHEMA, "plan");
  // The schema check above establishes field types; semantic validation below retains all original gates.
  const value = input as DevelopmentPlan;
  const allCases = activationCaseEntries(value);
  if (allCases.length > 200) fail("研发与激活专用用例合计不能超过200例", { path: "plan.activationCases", reason: "case_limit" });
  const fixtureBudget: FixtureBudget = { bytes: 0 };
  for (const { test } of allCases) if (value.runtime === "node-json" || test.kind === "node-check")
    assertCaseMaterials(test, { input: test.input, mocks: [] }, { budget: fixtureBudget });
  if (value.schemaVersion === 2 || value.schemaVersion === 3) {
    validateApplicationManifest(value.application, { allowUnverified: true });
    if (value.runtime !== value.application.runtime) fail("计划与应用运行协议不一致");
    if (architecture?.design?.schemaVersion === 3) {
      const execution = architecture.design.execution!;
      if (execution.hosting === "builtin" ? value.runtime !== "node-action" : value.runtime !== "managed-service"
        || value.application.service?.language !== execution.language || value.application.service?.host !== execution.hosting)
        fail("研发运行语言和托管方式必须保持已评审选择", { path: "plan.application", reason: "execution_mismatch" });
    }
    if (value.application.entrypoint !== value.entrypoint) fail("应用入口与研发入口不一致");
    if (architecture?.design?.interaction && architecture.design.interaction.page !== Boolean(value.application.page)) fail("页面交付必须匹配已评估的交互形式");
    const connections = new Set((architecture?.design?.connections ?? []).map((item) => item.id));
    for (const action of value.application.actions) for (const id of action.connectionIds) if (!connections.has(id)) fail("动作引用了架构未设计的连接");
    for (const { test, index: caseIndex, source } of allCases) {
      validateCaseShape(test);
      if (test.workflowInputs) {
        const workflow = value.application.service?.workflow;
        if (!workflow || test.actionId !== workflow.entryActionId) fail("流程回复只能用于已冻结的流程入口");
        if (new Set(test.workflowInputs.map((item) => item.stepId)).size !== test.workflowInputs.length) fail("流程回复步骤重复");
        for (const reply of test.workflowInputs) {
          const step = workflow.steps.find((step) => step.id === reply.stepId);
          if (!step?.waitForInput) fail("流程回复引用没有等待输入的步骤");
          validateActionInput({ inputSchema: step.waitForInput.inputSchema }, parsedExpected(reply.inputJson));
        }
      }
      if (test.kind === "node-check") {
        if (!value.application.page || typeof test.input !== "string" || test.assertions.some((item) => typeof item.expectedJson !== "string")
          || Object.hasOwn(test, "actionId") || Object.hasOwn(test, "mocks")) fail("Node 检查只用于页面验收，使用文本输入断言，不能声明业务动作或能力替身");
        safeRelativePath(test.entrypoint!);
        if (!/\.(?:mjs|js)$/.test(test.entrypoint!) || test.entrypoint === value.entrypoint
          || value.application.page.resources.some((resource) => resource.path === test.entrypoint!)) fail("Node 检查入口必须独立且不能作为页面资源或公开后端入口");
        continue;
      }
      if (Object.hasOwn(test, "entrypoint") || !Array.isArray(test.mocks)) fail("动作验收必须提供能力替身列表，不能指定其他入口");
      const action = (value.application.service?.operations ?? value.application.actions).find((item) => item.id === test.actionId);
      if (!action) fail("验收用例引用不存在的动作");
      let resolved;
      try { resolved = resolveCaseValues(test!, { maxInputBytes: value.runtime === "managed-service" ? 1024 * 1024 : 128 * 1024, fixtureBudget }); }
      catch (error) {
        if (error instanceof InputError && typeof error.reason === "string" && error.reason.startsWith("fixture_")) {
          error.fixtureCaseIndex = caseIndex;
          if (source === "activation") error.fixtureCaseGroup = "activationCases";
        }
        throw error;
      }
      if (test.kind === "input-rejection") {
        if (test.mocks!.length || test.workflowInputs?.length) fail("输入契约拒绝验收不能调用动作、能力或提供流程回复");
        if (!inputContractRejection(action!, resolved.input, { target: test!.inputTarget }).rejected) fail("输入契约拒绝用例必须实际违反动作输入契约");
      } else validateActionInput(action!, resolved.input);
      for (const mock of test.mocks!) {
        if (!ACTION_CAPABILITIES.includes(mock.capability)) fail("测试替身能力无效");
        parsedExpected(mock.argsJson); parsedExpected(mock.resultJson);
      }
      if (source === "activation" && !value.application.actions.some((item) => item.id === test.actionId))
        fail("激活专用用例只能执行公开动作", { path: `plan.activationCases[${caseIndex}].actionId`, reason: "activation_case_invalid" });
    }
    const missingExecutions = actionExecutionIssues(value);
    if (missingExecutions.some((item) => !item.migration)) fail("每个动作必须有实际验收用例");
    if (missingExecutions.length) fail("迁移与迁移验证动作必须分别有实际验收用例");
  }
  const requirements = architecture?.requirements;
  const acceptance = architecture?.design?.acceptance;
  if (!Array.isArray(requirements) || !requirements.length || !Array.isArray(acceptance) || !acceptance.length) {
    fail("缺少已确认的架构需求或验收清单");
  }
  for (const item of [...requirements, ...acceptance]) validateSchema(item?.id, identifier, "architecture.id");
  const requirementIds = uniqueIds(requirements, "architecture.requirements");
  const acceptanceIds = uniqueIds(acceptance, "architecture.acceptance");
  acceptance.forEach((item) => validateAcceptanceVerification(item));
  validateAcceptanceCoverage(architecture!, { application: value.application });
  const developmentAcceptanceIds = new Set(developmentAcceptanceItems(architecture).map((item: { id: string }) => item.id));
  const developmentRequirementIds = new Set(requiredDevelopmentRequirementIds(architecture));
  const taskIds = uniqueIds(value.tasks, "plan.tasks");
  uniqueIds(value.cases, "plan.cases");
  if (value.activationCases?.length) uniqueIds(allCases.map((entry) => entry.test), "plan.cases/activationCases");
  const tasks = new Map(value.tasks.map((task) => [task.id, task]));
  const coveredRequirements = new Set();
  const coveredAcceptance = new Set();
  const files = new Set();
  for (const task of value.tasks) {
    for (const id of task.requirementIds) { referenced(id, requirementIds, "task.requirementIds"); coveredRequirements.add(id); }
    for (const id of task.acceptanceIds) {
      referenced(id, acceptanceIds, "task.acceptanceIds");
      if (!developmentAcceptanceIds.has(id)) fail(`验收 ${id} 由宿主或运行阶段负责，不能用研发任务代替实际验证`);
      coveredAcceptance.add(id);
    }
    for (const id of task.dependsOn) referenced(id, taskIds, "task.dependsOn");
    for (const file of task.files) files.add(safeRelativePath(file));
  }
  for (const id of developmentRequirementIds) if (!coveredRequirements.has(id)) fail(`需求 ${id} 缺少研发任务`);
  for (const id of developmentAcceptanceIds) if (!coveredAcceptance.has(id)) fail(`验收 ${id} 缺少研发任务`);
  if (value.application?.page) for (const resource of value.application.page.resources) {
    if (!files.has(safeRelativePath(resource.path))) fail("页面资源必须包含在任务文件清单中");
  }
  safeRelativePath(value.entrypoint);
  const entryPattern = value.application?.service?.language === "python" ? /\.py$/ : /\.(?:mjs|js|cjs)$/;
  if (!entryPattern.test(value.entrypoint) || !files.has(value.entrypoint)) fail("运行入口必须匹配所选语言并包含在任务文件清单中");
  const visiting = new Set(), visited = new Set();
  function visit(id: string) {
    if (visiting.has(id)) fail("任务依赖存在循环");
    if (visited.has(id)) return;
    visiting.add(id);
    tasks.get(id)!.dependsOn.forEach(visit);
    visiting.delete(id); visited.add(id);
  }
  taskIds.forEach(visit);
  const unavailableEntrypoint = freshWorkspace === true ? taskEntrypointIssues(value)[0] : null;
  if (unavailableEntrypoint) fail("任务实际执行时入口尚未包含在此前已完成任务或当前任务的文件授权中；请重整为可执行增量", unavailableEntrypoint);
  const testedTasks = new Set(), testedAcceptance = new Set(), testedPairs = new Set();
  for (const test of value.cases) {
    referenced(test.taskId, taskIds, "case.taskId");
    referenced(test.acceptanceId, acceptanceIds, "case.acceptanceId");
    if (!acceptanceCaseMatches(acceptance.find((item) => item.id === test.acceptanceId), test))
      fail(`验收 ${test.acceptanceId} 的测试类型与已批准验证责任不匹配`);
    if (!tasks.get(test.taskId)!.acceptanceIds.includes(test.acceptanceId)) fail("用例引用的验收条目未分配给当前任务");
    if (test.kind === "node-check" && !tasks.get(test.taskId)!.files.includes(test.entrypoint!)) fail("Node 检查入口必须列入对应任务文件");
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
  for (const [index, test] of (value.activationCases ?? []).entries()) {
    if (test.taskId !== undefined) referenced(test.taskId, taskIds, "activationCase.taskId");
    const assertionPaths = new Set();
    for (const assertion of test.assertions) {
      safeAssertionPath(assertion.path); parsedExpected(assertion.expectedJson);
      if (assertionPaths.has(assertion.path)) fail("同一用例包含重复的断言路径", { path: `plan.activationCases[${index}].assertions`, reason: "assertion_path_invalid" });
      assertionPaths.add(assertion.path);
    }
  }
  for (const id of developmentAcceptanceIds) if (!testedAcceptance.has(id)) fail(`验收 ${id} 缺少实际验收用例`);
  for (const task of value.tasks) for (const id of task.acceptanceIds) {
    if (!testedPairs.has(`${task.id}:${id}`)) fail(`任务 ${task.id} 的验收 ${id} 缺少实际用例`);
  }
  const activationIssues = activationCheckIssues(value, { architecture, previousPlan });
  if (activationIssues.length) fail("启用业务验收必须完整映射已有公开业务用例并覆盖同一需求，既有映射不能删除或减弱", activationIssues[0]);
  if (previousPlan !== undefined) {
    const previous = validatePlan(previousPlan, { architecture });
    const cases = new Map(allCases.map((entry) => [entry.test.id, entry]));
    for (const oldEntry of activationCaseEntries(previous)) {
      const old = oldEntry.test, currentEntry = cases.get(old.id), current = currentEntry?.test;
      if (!current || current.acceptanceId !== old.acceptanceId || !sameFrozenCaseInput(current, old, value.runtime === "managed-service" ? 1024 * 1024 : 128 * 1024) || current.actionId !== old.actionId
        || currentEntry!.source !== oldEntry.source || (current.inputTarget ?? "action-value") !== (old.inputTarget ?? "action-value")
        || (current.kind ?? "action") !== (old.kind ?? "action") || current.entrypoint !== old.entrypoint
        || hashValue(current.mocks ?? []) !== hashValue(old.mocks ?? [])
        || (old.mocks ?? []).some((mock, index) => !sameFrozenTestJson(current.mocks![index]!.argsJson, mock.argsJson)
          || !sameFrozenTestJson(current.mocks![index]!.resultJson, mock.resultJson))
        || hashValue(current.workflowInputs ?? []) !== hashValue(old.workflowInputs ?? [])) fail("修订计划不能删除或替换已确认的验收用例");
      if (hashValue(current.materialChecks ?? []) !== hashValue(old.materialChecks ?? []))
        fail("修订计划不能删除或改变已确认的材料事实声明");
      for (const assertion of old.assertions) {
        const unchanged = current.assertions.find((entry) => entry.path === assertion.path);
        if (!unchanged || hashValue(parsedExpected(unchanged.expectedJson)) !== hashValue(parsedExpected(assertion.expectedJson))
          || typeof assertion.expectedJson !== "string" && !sameFrozenTestJson(unchanged.expectedJson, assertion.expectedJson)) {
          fail("修订计划不能删除或放宽已确认的验收断言");
        }
      }
    }
  }
  return structuredClone(value);
}

export function validateReview(input: unknown, { subjectHash, plan }: { subjectHash?: string | undefined; plan?: DevelopmentPlan } = {}): DevelopmentReview {
  validateSchema(input, REVIEW_SCHEMA, "review");
  const value = input as DevelopmentReview;
  if (value.subjectHash !== subjectHash) fail("评审结果与当前审查版本不匹配");
  uniqueIds(value.issues, "review.issues");
  if (plan) for (const issue of value.issues) {
    if (issue.taskIds?.some(id => !plan.tasks.some(task => task.id === id))
      || issue.files?.some(file => !plan.tasks.some(task => task.files.includes(file)))) fail("评审问题必须引用原计划中的真实任务和文件");
    if (issue.kind === "plan") for (const pointer of issue.candidatePaths ?? []) {
      if (!pointer.startsWith("/") || /~(?![01])/u.test(pointer)) fail("评审计划字段路径无效");
      let current: unknown = plan;
      for (const key of pointer.slice(1).split("/").map(key => key.replaceAll("~1", "/").replaceAll("~0", "~"))) {
        if (["__proto__", "constructor", "prototype"].includes(key) || !current || typeof current !== "object" || !Object.hasOwn(current, key)) fail("评审计划字段不存在");
        current = objectFields(current)[key];
      }
    }
  }
  const blocking = value.issues.some((issue) => issue.blocking);
  if (value.verdict === "pass" && blocking) fail("仍有阻断问题，不能判定 pass");
  if (value.verdict !== "pass" && !blocking) fail("未通过评审必须说明阻断问题");
  return structuredClone(value);
}

export function validateWork(input: unknown): DevelopmentWork {
  validateSchema(input, WORK_SCHEMA, "work");
  const value = input as DevelopmentWork;
  value.changedFiles.forEach(safeRelativePath);
  if (value.continue && !value.nextAction.trim()) fail("续接任务必须说明下一步动作");
  return structuredClone(value);
}

export function hashValue(value: unknown) {
  const seen = new Set<object>();
  function canonical(item: unknown): string {
    if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || seen.has(item)
      || (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))) fail("摘要内容必须为可序列化 JSON");
    seen.add(item);
    const result = Array.isArray(item)
      ? `[${Array.from(item, canonical).join(",")}]`
      : `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonical(objectFields(item)[key])}`).join(",")}}`;
    seen.delete(item);
    return result;
  }
  return createHash("sha256").update(canonical(value)).digest("hex");
}
