import type { ValidateFunction } from "ajv";
import type { ToolSchema } from "../contracts/tools.mjs";
import type { UnknownRecord, JsonValue } from "../contracts/json.mjs";
import type { DevelopmentPlan, DevelopmentCase, DevelopmentArchitecture, FixtureBudget } from "../contracts/development.mjs";
import type { AcceptanceItem } from "../contracts/verification.mjs";
import { objectFields } from "../runtime/type-boundary.mjs";
export interface PlanDiagnosticSource { path: string; localIndex?: number; fileIndex?: number; caseId?: string; caseHash?: string }
export interface PlanDiagnosticIssue { path: string; reason: string; remedy?: string | undefined; source?: PlanDiagnosticSource; relatedSources?: PlanDiagnosticSource[]; referenceId?: string; [key: string]: unknown }
interface PlanDiagnosticGroup { reason: string; count: number; path: string; source?: PlanDiagnosticSource; remedy: string }
interface PlanDiagnosticOptions { architecture?: DevelopmentArchitecture | undefined; previousPlan?: DevelopmentPlan | undefined; freshWorkspace?: boolean; sources?: PlanDiagnosticSource[]; activationSources?: PlanDiagnosticSource[]; indexSource?: PlanDiagnosticSource; initialIssues?: PlanDiagnosticIssue[] }
import { createHash } from "node:crypto";
import { Ajv } from "ajv";
import { validateActionInput } from "../applications/application-contract.mjs";
import { resolveTestJson, resolveCaseInput, FIXTURE_LIMITS, TEST_FIXTURE_SCHEMA, TEST_FIXTURE_OPERATION_GUIDE, inputContractRejection, inputContractMeasurement } from "./development-fixtures.mjs";
import { ACTION_CAPABILITIES } from "./node-action-bootstrap.mjs";
import { activationCaseEntries, activationCheckIssues, actionExecutionIssues, hashValue, safeRelativePath, taskEntrypointIssues, validatePlan } from "./development-contract.mjs";
import { submissionIssues } from "./development-diagnostics.mjs";
import { diagnoseApplicationManifest } from "./application-manifest-diagnostics.mjs";
import { auditCaseMaterials } from "./development-test-material-audit.mjs";
export { planningAdmissionFacts } from "./development-fixtures.mjs";
import { acceptanceCaseMatches, developmentAcceptanceItems, requiredDevelopmentRequirementIds,
  validateAcceptanceVerification } from "../verification/acceptance-contract.mjs";

export const PLAN_DIAGNOSTIC_LIMITS = Object.freeze({ retained: 2048, page: 40 });
const ajv = new Ajv({ strict: false, allErrors: true, coerceTypes: false }), validators = new WeakMap<ToolSchema, ValidateFunction>();
const fixtureShape = ajv.compile(TEST_FIXTURE_SCHEMA);
const safeId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(value);
function list<T>(value: readonly T[] | null | undefined): T[];
function list(value: unknown): unknown[];
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function boundedDraft(value: unknown) {
  const pending: [unknown, number, boolean][] = [[value, 0, false]], seen = new Set<unknown>();
  let nodes = 0;
  while (pending.length) {
    const [entry, depth, leaving] = pending.pop()!;
    if (leaving) { seen.delete(entry); continue; }
    if (++nodes > 100000 || depth > 64) return false;
    if (!entry || typeof entry !== "object") continue;
    if (seen.has(entry) || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(entry))) return false;
    seen.add(entry);
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > 100000 - nodes || keys.some((key) => typeof key !== "string")) return false;
    pending.push([entry, depth, true]);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(entry) && key === "length") continue;
      if (!Object.hasOwn(descriptor, "value")) return false;
      pending.push([descriptor.value, depth + 1, false]);
    }
  }
  return true;
}
const remedies: Readonly<Record<string, string>> = Object.freeze({
  duplicate_id: "逐项核对两个位置的用例和断言；为不同场景使用不同编号。不得自动去重或改变预期来通过。",
  schema_invalid: "按当前公开计划结构修正该字段；其余独立问题也应一并处理。",
  invalid_reference: "只引用当前已批准需求、验收、任务或动作中的真实编号。",
  missing_coverage: "为该需求或验收补齐其负责阶段的任务与实际证据；不能用无关检查代替。",
  action_input_invalid: "输入展开后不符合公开动作契约。核对整个动作入参；若验证入口拒绝，使用input-rejection并断言入口拒绝，不能声称业务动作收到了该输入。",
  input_encoding_mismatch: "input当前是JSON文本，解析一次后仍是fixture配方外壳，且不符合本动作输入契约。若本意为声明式夹具，主动将input保存为原生{fixture:{...}}对象；若本意为普通业务输入，按动作schema修正。宿主不会递归解码、替换输入或改断言。",
  task_entrypoint_unavailable: "按实际任务顺序，此任务需要执行代码，但全局入口不在已完成任务与当前任务的文件授权中。主动重整为含入口及必要helper的可执行增量，或让先前任务产出入口；不能只补验收ID或增加无页面node-check。",
  input_rejection_not_rejected: "该输入通过公开动作契约。业务拒绝应使用实际动作执行与业务断言。",
  assertion_path_invalid: "断言路径只接受点分隔：对象字段如result.total，数组下标如errors.0.code；不接受errors[0].code、引号、通配符或原型字段。空路径表示整个结果。同一用例不能重复同一路径。主动修正路径，保留原预期值。",
  action_missing: "此处引用的动作未声明，或声明的操作没有实际执行用例。核对application.actions、service.operations及用例actionId的精确编号；每个公开操作须有对应的真实动作执行用例。不能用输入拒绝代替实际执行。",
  node_check_invalid: "node-check仅用于真实页面验收；无页面应用不能用独立脚本冒充业务、宿主或对话验收。",
  invalid_json: "修正该字段的JSON文本或声明式夹具，保留原测试规模和预期。",
  dependency_cycle: "修改任务依赖，形成可以按顺序执行的无环关系。",
  revision_frozen: "保留已确认输入、入口、替身和原断言；草稿工具不能删减已冻结验收。",
  activation_checks_missing: "为每项host-business启用验收在activationChecks加入唯一映射，引用已有公开业务用例；保留验收原阶段。",
  activation_check_reference_invalid: "activationChecks只映射当前host-business验收，每项恰好一行；不能把健康探针或静态评审伪装成业务验收。",
  activation_case_invalid: "引用已有冻结的公开动作action或合法input-rejection用例；不能引用页面脚本、未公开动作或无效输入。",
  activation_requirement_missing: "所选研发用例或绑定本项host-business的激活专用用例必须共同覆盖全部要求；激活专属义务用activationCases保留原阶段。",
  activation_case_unassigned: "激活专用用例必须被其自身host-business验收的activationChecks引用，不能跨项或冒充研发覆盖。",
  case_limit: "cases与activationCases合计最多200例，保留必要边界及冻结断言。",
  activation_check_frozen: "保留旧activationChecks的验收和全部用例映射；允许增加证据，不能删除或减弱原映射。",
});

export function encodedFixtureInputMismatch(test: { input?: unknown }, resolvedInput: unknown) {
  return typeof test?.input === "string" && resolvedInput !== null && typeof resolvedInput === "object"
    && !Array.isArray(resolvedInput) && fixtureShape(resolvedInput);
}

export function planningInputFailure(test: { input?: unknown }, resolvedInput: unknown) {
  return encodedFixtureInputMismatch(test, resolvedInput) ? { reason: "input_encoding_mismatch", remedy: remedies.input_encoding_mismatch }
    : { reason: "action_input_invalid", remedy: remedies.action_input_invalid };
}

export function planningInputRejectionFailure(test: { inputTarget?: unknown }, action: { id?: unknown }, resolvedInput: unknown) {
  const measurement = inputContractMeasurement(action, resolvedInput, { target: test.inputTarget });
  return { reason: "input_rejection_not_rejected", measurement,
    remedy: measurement.target === "task-envelope"
      ? `当前正式任务信封序列化为${measurement.bytes}字节，上限${measurement.limit}字节，尚未超过大小限制；该目标只检查正式任务信封，不执行业务校验。主动核对目标与夹具，不缩小要求或改变原断言。`
      : `当前动作值通过所声明的inputSchema；序列化为${measurement.bytes}字节，动作值上限${measurement.limit}字节。核对索引中该actionId的inputSchema是否表达了已批准的入口约束；业务校验应实际执行并断言业务拒绝。宿主不自动修改schema、用例类型或预期。` };
}

export function planningFixtureFailure(reason: unknown) {
  const details: Record<string, string> = {
    fixture_repeat_limit: `repeat和text节点的count都必须为0至${FIXTURE_LIMITS.repeat}的安全整数。需要更长文本时，可用多字符value配合合法count；重新核算展开字节，保留原要求的规模和断言，不能仅缩小负例。`,
    fixture_recipe_limit: `配方原始JSON不得超过${FIXTURE_LIMITS.recipeBytes}字节；使用已有repeat/text/index节点表达重复数据，不逐条展开或删减必要边界。`,
    fixture_complexity_limit: `配方最多${FIXTURE_LIMITS.nodes}节点、${FIXTURE_LIMITS.depth}层；合并冗余结构，保留业务覆盖与断言。`,
    fixture_expansion_limit: `展开最多${FIXTURE_LIMITS.expandedNodes}节点；核对配方结构及数据规模，不把字节限制和节点限制混为一谈。`,
    fixture_output_limit: "展开结果超过当前字段的实际字节额度；核对testFixtureLimits、动作输入与input-rejection的专属诊断额度，不改变原测试边界或预期。",
    fixture_text_work_limit: TEST_FIXTURE_OPERATION_GUIDE,
    fixture_node_shape: "节点字段须符合当前testFixtureSchema；text.value是字符串，repeat.value是节点，object使用fields，array使用items，不自动修复结构。",
    fixture_index_scope: "index必须位于repeat作用域内，索引取最近一层repeat；核对节点位置，不以固定值替代所有不同记录。",
    fixture_index_limit: "index的start、step及展开结果必须为安全整数，保留所需记录身份及边界。",
    fixture_unknown_operation: TEST_FIXTURE_OPERATION_GUIDE,
    fixture_json_required: "普通字符串须是可严格解析一次的完整JSON；声明式夹具直接使用原生{fixture:节点}对象，不将外壳再次编码成JSON字符串。",
  };
  return { reason: "invalid_json", fixtureReason: /^fixture_[a-z_]+$/u.test(typeof reason === "string" ? reason : "") ? reason : "fixture_json_required",
    remedy: details[String(reason)] ?? "修正该字段的JSON或声明式夹具，核对testFixtureSchema与testFixtureLimits，保留原测试规模和预期。" };
}

function declaredPath(schema: ToolSchema, instancePath: string, required?: string) {
  let current: ToolSchema | undefined = schema, result = "plan";
  for (const part of instancePath.split("/").slice(1).map((key) => key.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (current?.type === "array" && /^(0|[1-9][0-9]{0,5})$/.test(part)) {
      result += `[${part}]`; current = current.items;
    } else if (Object.hasOwn(current?.properties ?? {}, part)) {
      result += `.${part}`; current = current!.properties![part];
    } else break;
  }
  if (required && Object.hasOwn(current?.properties ?? {}, required)) result += `.${required}`;
  return result;
}

function diagnosticCaseInput(test: UnknownRecord, { maxInputBytes, fixtureBudget, report, reportMaterial }: { maxInputBytes: number; fixtureBudget: FixtureBudget & { bytes: number }; report: (field: string, reason: string) => void; reportMaterial?: (issue: ReturnType<typeof auditCaseMaterials>["issues"][number]) => void }) {
  let caseBytes = 0, input: unknown, inputValid = false;
  const resolve = (value: unknown, field: string, maxBytes?: number) => {
    if (fixtureBudget.bytes > FIXTURE_LIMITS.planBytes) { report(field, "fixture_plan_output_limit"); return; }
    try {
      const result = field === "input" ? resolveCaseInput(test, { maxInputBytes: maxBytes, textWorkBudget: fixtureBudget })
        : resolveTestJson(value, { ...(maxBytes ? { maxBytes } : {}), textWorkBudget: fixtureBudget });
      if (result.fixture) {
        caseBytes += result.fixture.bytes; fixtureBudget.bytes += result.fixture.bytes;
        if (caseBytes > FIXTURE_LIMITS.caseBytes || fixtureBudget.bytes > FIXTURE_LIMITS.planBytes) {
          report(field, caseBytes > FIXTURE_LIMITS.caseBytes ? "fixture_case_output_limit" : "fixture_plan_output_limit"); return;
        }
      }
      return { value: result.value };
    } catch (error) { report(field, /^fixture_[a-z_]+$/.test(String(objectFields(error).reason ?? "")) ? String(objectFields(error).reason) : "fixture_json_required"); }
  };
  const resolved = resolve(test.input, "input", maxInputBytes);
  if (resolved) { input = resolved.value; inputValid = true; }
  const mocks = list(test.mocks).slice(0, 100).map(objectFields).map((mock, index) => ({ capability: mock?.capability,
    args: resolve(mock?.argsJson, `mocks[${index}].argsJson`)?.value,
    value: resolve(mock?.resultJson, `mocks[${index}].resultJson`)?.value }));
  for (const [index, assertion] of list(test.assertions).slice(0, 40).map(objectFields).entries()) resolve(assertion?.expectedJson, `assertions[${index}].expectedJson`);
  for (const issue of auditCaseMaterials(test, { input, inputAvailable: inputValid, mocks }, { budget: fixtureBudget }).issues) reportMaterial?.(issue);
  return { input, inputValid };
}

export function planDiagnosticLedger(initial: PlanDiagnosticIssue[] = []) {
  const issues: (PlanDiagnosticIssue & { remedy: string; issueId: string })[] = [], seen = new Set<string>(), groups = new Map<string, PlanDiagnosticGroup>();
  let total = 0;
  const add = (entry: PlanDiagnosticIssue) => {
    const identitySource = (source: PlanDiagnosticSource | undefined) => source && { path: source.path, caseId: source.caseId,
      ...(entry.reason === "duplicate_id" ? { localIndex: source.localIndex } : {}) };
    const key = JSON.stringify({ reason: entry.reason,
      path: entry.source?.caseId ? entry.path.replace(/^plan\.(cases|activationCases)\[[0-9]+\]/, (_match, group) => `plan.${group}.byId:${entry.source!.caseId}`) : entry.path,
      source: identitySource(entry.source), relatedSources: entry.relatedSources?.map(identitySource), referenceId: entry.referenceId });
    if (seen.has(key)) return;
    seen.add(key); total++;
    const group = groups.get(entry.reason);
    if (group) group.count++;
    else groups.set(entry.reason, { reason: entry.reason, count: 1, path: entry.path,
      ...(entry.source ? { source: entry.source } : {}), remedy: entry.remedy ?? remedies[entry.reason] ?? remedies.schema_invalid! });
    if (issues.length < PLAN_DIAGNOSTIC_LIMITS.retained) issues.push({
      issueId: `plan_issue_${createHash("sha256").update(key).digest("hex").slice(0, 20)}`,
      ...entry, remedy: entry.remedy ?? remedies[entry.reason] ?? remedies.schema_invalid!,
    });
  };
  initial.forEach(add);
  return { add, result: () => ({ issues, total, retained: issues.length, truncated: total > issues.length,
    issueGroups: [...groups.values()].slice(0, 40), issueGroupsTotal: groups.size, issueGroupsTruncated: groups.size > 40 }) };
}

// Diagnostics inspect independently checkable draft facts. Only validatePlan may accept a plan.
export function diagnosePlanningPlan(input: unknown, schema: ToolSchema, { architecture, previousPlan, freshWorkspace = false, sources = [], activationSources = [], indexSource, initialIssues = [] }: PlanDiagnosticOptions = {}) {
  const value = objectFields(input);
  const ledger = planDiagnosticLedger(initialIssues);
  if (!boundedDraft(input)) {
    ledger.add({ path: "plan", reason: "planning_diagnostic_limit", remedy: "规划草稿超过可核对的数据深度或节点额度，或不是普通JSON数据。缩减冗余结构并使用已有声明式夹具；保留业务边界与验收要求。" });
    return { ...ledger.result(), verificationAssignments: [] };
  }
  const sourceFor = (index: number, group = "cases") => (group === "activationCases" ? activationSources : sources)[index]
    && { ...(group === "activationCases" ? activationSources : sources)[index]! };
  const add = (path: string, reason: string, extra: Partial<PlanDiagnosticIssue> = {}) => {
    const match = /^plan\.(cases|activationCases)\[([0-9]+)\]/.exec(path), source = match ? sourceFor(Number(match[2]), match[1]) : indexSource;
    ledger.add({ path, reason, ...(source ? { source } : {}), ...extra });
  };
  let validate = validators.get(schema);
  if (!validate) { validate = ajv.compile(schema); validators.set(schema, validate); }
  let includeAcceptanceIds = false;
  if (!validate(input)) for (const error of validate.errors ?? []) {
    const path = declaredPath(schema, error.instancePath, error.params?.missingProperty);
    const taskAcceptance = /^plan\.tasks\[([0-9]+)\]\.acceptanceIds$/u.exec(path), task = objectFields(taskAcceptance && objectFields(value.tasks)[Number(taskAcceptance[1])]);
    const emptyAcceptance = taskAcceptance && error.keyword === "minItems";
    if (emptyAcceptance) includeAcceptanceIds = true;
    add(path, "schema_invalid", {
      rule: ["required", "type", "enum", "minItems", "maxItems", "uniqueItems", "additionalProperties", "minLength", "maxLength", "pattern", "anyOf", "allOf", "if"].includes(error.keyword) ? error.keyword : "schema",
      ...(emptyAcceptance ? { minimumItems: error.params.limit, actualCount: objectFields(task.acceptanceIds).length,
        ...(safeId(task.id) ? { taskId: task.id } : {}),
        remedy: "每个任务至少分配一项本地可执行的development验收，并有匹配本任务的具体用例；集成任务不能代替此前任务的验收。纯helper不能独立运行时，重整为含真实入口与必要helper的可执行增量，不自动填写编号。" } : {}),
    });
  }
  const tasks = list(value?.tasks).slice(0, 40).map(objectFields), cases = list(value?.cases).slice(0, 200).map(objectFields);
  const allCases = activationCaseEntries(value).slice(0, 400).map(entry => ({ ...entry, test: objectFields(entry.test) }));
  if (activationCaseEntries(value).length > 200) add("plan.activationCases", "case_limit");
  const requirements = list(architecture?.requirements), allAcceptance = list(architecture?.design?.acceptance);
  let acceptance = allAcceptance, developmentRequirements = requirements.map((item) => item.id);
  const verificationAssignments = [];
  try {
    acceptance = developmentAcceptanceItems(architecture); developmentRequirements = requiredDevelopmentRequirementIds(architecture);
    for (const item of allAcceptance) if (safeId(item?.id)) verificationAssignments.push({ acceptanceId: item.id,
      ...validateAcceptanceVerification(item), status: "not_run" });
  } catch { add("architecture.acceptance.verification", "acceptance_verification_invalid", { remedy: "每项验收必须绑定平台支持的负责方、阶段与适配器；未知分工不能被当作研发测试或已完成。" }); }
  const requirementsIds = new Set(requirements.map((item) => item.id)), acceptanceIds = new Set(acceptance.map((item) => item.id));
  const matchesAcceptance = (item: AcceptanceItem | undefined, test: { kind?: unknown }) => { try { return acceptanceCaseMatches(item, test); } catch { return false; } };
  const taskIds = new Set(tasks.map((item) => item?.id));
  const duplicate = (items: UnknownRecord[], group: string) => {
    const found = new Map<string, number>();
    items.forEach((item, index) => {
      if (!safeId(item?.id)) return;
      if (found.has(item.id)) {
        const other = found.get(item.id)!, related = group === "cases" && sourceFor(other);
        let conflict;
        try { conflict = hashValue(items[other]) !== hashValue(item); } catch { /* Schema issues already cover non-JSON caller data. */ }
        add(`plan.${group}[${index}].id`, "duplicate_id", { referenceId: item.id,
          ...(related ? { relatedSources: [related] } : { relatedPaths: [`plan.${group}[${other}].id`] }),
          ...(conflict === undefined ? {} : { duplicateConflict: conflict }) });
      } else found.set(item.id, index);
    });
  };
  duplicate(tasks, "tasks"); duplicate(cases, "cases");
  const allIds = new Map<string, { group: string; index: number }>();
  for (const { test, source, index } of allCases) {
    const group = source === "activation" ? "activationCases" : "cases";
    if (!safeId(test?.id)) continue;
    const old = allIds.get(test.id);
    if (old && (source === "activation" || old.group === "activationCases")) add(`plan.${group}[${index}].id`, "duplicate_id", {
      referenceId: test.id, relatedPaths: [`plan.${old.group}[${old.index}].id`] });
    else allIds.set(test.id, { group, index });
  }
  for (const [index, task] of tasks.entries()) {
    for (const [field, ids] of ([["requirementIds", requirementsIds], ["acceptanceIds", acceptanceIds], ["dependsOn", taskIds]] as [string, Set<unknown>][]) ) {
      for (const id of list(task?.[field])) if (safeId(id) && !ids.has(id)) {
        if (field === "acceptanceIds") includeAcceptanceIds = true;
        add(`plan.tasks[${index}].${field}`, "invalid_reference", { referenceId: id });
      }
    }
    for (const file of list(task?.files)) try { safeRelativePath(file); } catch { add(`plan.tasks[${index}].files`, "unsafe_path"); }
  }
  for (const id of developmentRequirements) if (safeId(id) && !tasks.some((task) => list(task?.requirementIds).includes(id)))
    add("plan.tasks", "missing_coverage", { referenceId: id, coverageKind: "requirement" });
  for (const id of acceptanceIds) if (safeId(id) && !tasks.some((task) => list(task?.acceptanceIds).includes(id)))
    add("plan.tasks", "missing_coverage", { referenceId: id, coverageKind: "acceptance" });
  for (const [index, task] of tasks.entries()) {
    if (!cases.some((test) => test?.taskId === task?.id)) add(`plan.tasks[${index}]`, "missing_coverage", { ...(safeId(task?.id) ? { referenceId: task.id } : {}), coverageKind: "task_case" });
    for (const id of list(task?.acceptanceIds)) if (safeId(id) && !cases.some((test) => test?.taskId === task?.id && test?.acceptanceId === id
      && (!acceptance.find((item) => item.id === id) || matchesAcceptance(acceptance.find((item) => item.id === id), test))))
      add(`plan.tasks[${index}].acceptanceIds`, "missing_coverage", { referenceId: id, ...(safeId(task?.id) ? { taskId: task.id } : {}), coverageKind: "task_acceptance_case" });
  }
  const visiting = new Set(), visited = new Set(), byId = new Map(tasks.filter((item) => safeId(item?.id)).map((item) => [item.id, item]));
  const visit = (id: unknown): void => {
    if (visiting.has(id)) { add(`plan.tasks[${tasks.indexOf(byId.get(id)!)}].dependsOn`, "dependency_cycle", { referenceId: String(id) }); return; }
    if (visited.has(id) || !byId.has(id)) return;
    visiting.add(id); for (const dependency of list(byId.get(id)!.dependsOn)) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
  if (freshWorkspace === true) for (const { path, reason, ...extra } of taskEntrypointIssues(value)) add(path, reason, extra);
  const application = objectFields(value.application);
  const service = objectFields(application.service);
  const operations = list(service.operations ?? application.actions).map(objectFields), fixtureBudget = { bytes: 0 };
  if (Number(value?.schemaVersion) >= 2) for (const { path, reason, ...extra } of diagnoseApplicationManifest(value.application, { schema: schema.properties?.application, plan: value }).issues) add(path, reason, extra);
  for (const { test, index, source } of allCases) {
    const group = source === "activation" ? "activationCases" : "cases", path = `plan.${group}[${index}]`, task = byId.get(test?.taskId);
    if (safeId(test?.taskId) && !task) add(`${path}.taskId`, "invalid_reference", { referenceId: test.taskId });
    const targetAcceptance = (source === "activation" ? allAcceptance : acceptance).find((item) => item.id === test?.acceptanceId);
    if (safeId(test?.acceptanceId) && !targetAcceptance) add(`${path}.acceptanceId`, "invalid_reference", { referenceId: test.acceptanceId });
    else if (source !== "activation" && task && !list(task.acceptanceIds).includes(test?.acceptanceId)) add(`${path}.acceptanceId`, "task_acceptance_mismatch");
    if (targetAcceptance) try {
      if (source === "activation" ? validateAcceptanceVerification(targetAcceptance).adapterId !== "host-business" || ![undefined, "action", "input-rejection"].includes(typeof test.kind === "string" ? test.kind : test.kind === undefined ? undefined : "invalid")
        : !acceptanceCaseMatches(targetAcceptance, test)) add(`${path}.kind`, "acceptance_adapter_mismatch", { remedy: "用例执行方式必须匹配本项验收的负责阶段与适配器；激活专用用例只绑定host-business，不能计入研发覆盖。" });
    } catch { /* The invalid architecture descriptor is already recorded. */ }
    if (test?.kind === "node-check") {
      for (const issue of auditCaseMaterials(test, { input: test.input, mocks: [] }, { budget: fixtureBudget }).issues)
        add(`${path}.${issue.path}`, issue.reason, { remedy: issue.remedy, ...(issue.measurement ? { measurement: issue.measurement } : {}) });
      if (!application.page || Object.hasOwn(test, "actionId") || Object.hasOwn(test, "mocks") || typeof test.input !== "string"
        || list(test.assertions).map(objectFields).some((entry) => typeof entry?.expectedJson !== "string")) add(`${path}.kind`, "node_check_invalid");
      if (task && !list(task.files).includes(test.entrypoint)) add(`${path}.entrypoint`, "invalid_entrypoint");
      continue;
    }
    if (Number(value?.schemaVersion) >= 2) {
      const action = operations.find((item) => item?.id === test?.actionId);
      if (!action) { add(`${path}.actionId`, "action_missing"); continue; }
      if (Object.hasOwn(test ?? {}, "entrypoint") || !Array.isArray(test?.mocks)) add(`${path}.mocks`, "action_case_invalid");
      if (!Array.isArray(test?.assertions) || !Array.isArray(test?.mocks)) continue;
      const resolved = diagnosticCaseInput(test, { maxInputBytes: value.runtime === "managed-service" ? 1024 * 1024 : 128 * 1024, fixtureBudget,
        report: (field, fixtureReason) => { const { reason, ...detail } = planningFixtureFailure(fixtureReason); add(`${path}.${field}`, reason, detail); },
        reportMaterial: (issue) => add(`${path}.${issue.path}`, issue.reason, { remedy: issue.remedy, ...(issue.measurement ? { measurement: issue.measurement } : {}) }) });
      if (resolved.inputValid) {
        let accepted = true;
        if (test.kind === "input-rejection") accepted = !inputContractRejection(action, resolved.input, { target: test.inputTarget }).rejected;
        else try { validateActionInput({ inputSchema: action.inputSchema }, resolved.input); } catch { accepted = false; }
        if (test.kind === "input-rejection" ? accepted : !accepted) {
          const failure: { reason: string; remedy?: string | undefined; measurement?: unknown } = test.kind === "input-rejection" ? planningInputRejectionFailure(test, action, resolved.input) : planningInputFailure(test, resolved.input);
          add(`${path}.${test.kind === "input-rejection" ? "kind" : "input"}`, failure.reason, {
          ...(failure.remedy ? { remedy: failure.remedy } : {}),
          ...(failure.measurement ? { measurement: failure.measurement,
            schemaPath: `plan.application.${service.operations ? "service.operations" : "actions"}[${operations.indexOf(action)}].inputSchema` } : {}),
          ...(typeof objectFields(action.inputSchema).type === "string" && ["object", "array", "string", "integer", "number", "boolean", "null"].includes(String(objectFields(action.inputSchema).type)) ? { expectedType: objectFields(action.inputSchema).type } : {}),
          receivedType: resolved.input === null ? "null" : Array.isArray(resolved.input) ? "array" : typeof resolved.input,
          });
        }
      }
      for (const [mockIndex, mock] of (test.mocks as unknown[]).map(objectFields).entries()) if (!ACTION_CAPABILITIES.includes(typeof mock.capability === "string" ? mock.capability : "")) add(`${path}.mocks[${mockIndex}].capability`, "mock_capability_invalid");
    } else for (const issue of auditCaseMaterials(test, { input: test?.input, mocks: [] }, { budget: fixtureBudget }).issues)
      add(`${path}.${issue.path}`, issue.reason, { remedy: issue.remedy, ...(issue.measurement ? { measurement: issue.measurement } : {}) });
    const paths = new Set();
    for (const [assertionIndex, assertion] of list(test?.assertions).map(objectFields).entries()) {
      const itemPath = assertion?.path;
      if (typeof itemPath !== "string" || itemPath !== "" && (!/^(?:[A-Za-z_$][A-Za-z0-9_$-]*|0|[1-9][0-9]*)(?:\.(?:[A-Za-z_$][A-Za-z0-9_$-]*|0|[1-9][0-9]*))*$/.test(itemPath)
        || itemPath.split(".").some((part) => ["__proto__", "prototype", "constructor"].includes(part))) || paths.has(itemPath)) add(`${path}.assertions[${assertionIndex}].path`, "assertion_path_invalid");
      paths.add(itemPath);
    }
  }
  for (const { path, reason } of actionExecutionIssues(value)) add(path, reason);
  try { for (const entry of activationCheckIssues(value, { architecture, previousPlan })) ledger.add(entry); }
  catch { /* Invalid architecture verification descriptors are already recorded above. */ }
  try { validatePlan(value, { architecture, previousPlan, freshWorkspace }); }
  catch (error) { for (const entry of submissionIssues(value, schema, { root: "plan", error, architecture })) ledger.add(entry); }
  const allowed = [...acceptanceIds].filter(safeId);
  return { ...ledger.result(), verificationAssignments, ...(includeAcceptanceIds ? { allowedDevelopmentAcceptanceIds: allowed.slice(0, 80),
    allowedDevelopmentAcceptanceIdsTotal: allowed.length, allowedDevelopmentAcceptanceIdsTruncated: allowed.length > 80 } : {}) };
}

export function pagePlanDiagnostics<T extends { retained: number; issues: PlanDiagnosticIssue[] }>(ledger: T, { offset = 0, limit = 24 } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > PLAN_DIAGNOSTIC_LIMITS.page)
    throw new TypeError("规划诊断分页范围无效");
  const end = Math.min(ledger.retained, offset + limit);
  return { ...ledger, issues: ledger.issues.slice(offset, end), offset, nextOffset: end < ledger.retained ? end : null };
}
