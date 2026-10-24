import type { ToolSchema } from "../contracts/tools.mjs";
import type { UnknownRecord } from "../contracts/json.mjs";
import type { DevelopmentPlan, DevelopmentArchitecture } from "../contracts/development.mjs";
import { objectFields, isInteger } from "../runtime/type-boundary.mjs";
export interface SubmissionIssue { path: string; reason: string; remedy: string; expectedType?: string | undefined; receivedType?: string; [key: string]: unknown }
interface SubmissionAttempt { sequence: number; role: string; phase: string; taskId?: string; turn: number; stage: string; status: "accepted" | "rejected"; issues: SubmissionIssue[]; at: string }
export interface SubmissionRecord { submissionCounts?: Record<string, { attempts: number; accepted: number; rejected: number }>; submissionAttempts?: SubmissionAttempt[] }
import { toolInputValidation } from "../runtime/tool-input-diagnostics.mjs";
import { validateActionInput, validateValueSchema } from "../applications/application-contract.mjs";
import { resolveCaseValues, inputContractRejection } from "./development-fixtures.mjs";
import { activationCaseEntries } from "./development-contract.mjs";
import { developmentAcceptanceItems, requiredDevelopmentRequirementIds } from "../verification/acceptance-contract.mjs";
import { diagnoseApplicationManifest } from "./application-manifest-diagnostics.mjs";

const remedies: Readonly<Record<string, string>> = Object.freeze({
  required: "补齐提交工具列出的必填字段。", additionalProperties: "移除当前结构没有声明的字段。",
  type: "按提交工具声明的数据类型填写。", enum: "使用提交工具列出的允许值。",
  minLength: "补齐符合最短长度的内容。", maxLength: "缩短该字段，保留其余提交内容。",
  minItems: "补齐必需条目。", maxItems: "减少条目至契约允许数量。", uniqueItems: "移除重复引用。",
  pattern: "按字段声明的格式填写。", minimum: "使用契约允许的最小值或更大数值。",
  maximum: "使用契约允许的最大值或更小数值。", exclusiveMinimum: "使用严格大于契约下限的数值。",
  exclusiveMaximum: "使用严格小于契约上限的数值。", multipleOf: "使用契约规定倍数的数值。",
  const: "使用提交工具声明的固定值。", oneOf: "使用提交工具列出的其中一种完整结构。",
  anyOf: "使用提交工具列出的其中一种完整结构。",
  development_not_required: "返回架构层核对研发分流，不要虚构代码任务。",
  execution_mismatch: "保持架构已经评审的语言和托管方式。",
  invalid_reference: "仅引用当前需求、任务和验收清单中实际存在的编号。",
  missing_coverage: "为所有需求和验收条目补齐实际任务及测试。",
  invalid_json: "将用例输入、断言或替身填写为合法 JSON 文本。",
  invalid_entrypoint: "使用所选语言的入口文件，并将它列入对应任务 files。",
  application_invalid: "按应用清单和服务清单核对协议、字段与动作契约。",
  contract_invalid: "根据本阶段契约核对引用、覆盖、依赖与交付一致性。",
  sdk_validation: "按提交工具公开的结构重新提交，不能用自然语言代替。",
  protocol_mismatch: "计划、应用与已批准架构必须使用同一执行协议和版本。",
  entrypoint_mismatch: "计划入口与应用入口必须一致，并列入对应任务文件。",
  page_mismatch: "保留已评估的页面交付形式；无页面功能使用动作验收。",
  undeclared_connection: "仅引用架构已设计的连接，不自行增加依赖。",
  action_case_invalid: "业务动作验收必须填写 actionId 和 mocks 数组，不得指定其他 entrypoint。",
  node_check_invalid: "node-check 只用于页面验收，使用独立检查入口，不填 actionId 或 mocks。",
  action_missing: "用例 actionId 必须匹配实际动作，并为每个公开动作安排验收。",
  mock_capability_invalid: "只使用平台已列出的能力替身，参数与结果填写合法 JSON。",
  task_acceptance_mismatch: "用例 acceptanceId 必须已分配给其 taskId 对应任务。",
  dependency_cycle: "移除循环依赖，使每个任务可以按前置任务顺序执行。",
  assertion_path_invalid: "断言路径使用空字符串或安全属性路径，禁止原型属性和重复路径。",
  unsafe_path: "使用工作区内安全相对路径，禁止隐藏目录、凭据和依赖目录。",
  revision_frozen: "保留已确认用例的输入、入口、替身和断言；只能补充，不能删除或放宽。",
  workflow_case_invalid: "流程回复只引用冻结流程入口中的真实等待步骤，每个步骤只回复一次。",
  schema_rule_unsupported: "输入输出结构只使用平台支持的规则；不使用 $ref、anyOf、oneOf、pattern 或未支持的关键字。",
  schema_object_invalid: "对象结构必须明确 properties、required 和 additionalProperties=false，required 只列真实字段且不重复。",
  schema_type_mismatch: "结构规则和枚举值必须与 type 一致，嵌套字段也须声明受支持的 type。",
  schema_bounds_invalid: "结构边界使用允许范围内的数值，最小值不能大于最大值。",
  schema_property_invalid: "结构字段名称使用安全标识，不使用原型属性。",
  action_input_invalid: "按所选动作 inputSchema 核对该用例的输入；不要通过修改已确认业务契约绕过校验。",
  input_rejection_not_rejected: "该输入通过了公开 inputSchema。检验业务错误时使用 action 实际运行并断言业务拒绝；只有真正违反 inputSchema 的输入才使用 input-rejection。",
  service_runtime_invalid: "服务须使用支持的语言、托管方式和 schemaVersion。",
  service_entrypoint_invalid: "服务入口必须为安全相对路径，并匹配所选语言扩展名及应用入口。",
  service_limits_invalid: "按服务清单的资源范围填写请求时限、内存、临时空间、日志额度及数据版本。",
  service_operation_invalid: "服务操作须使用唯一安全编号、合法可见性及已声明的连接。",
  dependency_lock_invalid: "依赖须完整锁定版本、可信下载来源、文件名与摘要；直接托管不安装需现场编译的依赖。",
  work_file_unauthorized: "changedFiles 仅列出当前任务 task.files 已授权的文件；修正声明后在原会话重新提交。",
  activation_checks_missing: "在activationChecks为每项host-business启用验收映射已有业务用例，保留原阶段。",
  activation_check_reference_invalid: "只映射当前host-business验收，每项恰好一组；不能用其他宿主或静态验收代替。",
  activation_case_invalid: "引用已有冻结公开动作的action或合法input-rejection用例，不能使用页面脚本或未公开动作。",
  activation_requirement_missing: "所选研发用例或绑定本项host-business的激活专用用例必须共同覆盖全部要求；激活专属义务用activationCases保留原阶段。",
  activation_case_unassigned: "激活专用用例必须被其自身host-business验收的activationChecks引用，不能跨项或冒充研发覆盖。",
  case_limit: "cases与activationCases合计最多200例，保留必要边界及冻结断言。",
  activation_check_frozen: "修订时保留旧启用验收及全部用例映射，只可扩展不能删除或减弱。",
});

const contractRules = new Map<string, [string, string]>([
  ["v3 架构必须使用 v3 研发计划", ["plan.schemaVersion", "protocol_mismatch"]],
  ["已批准的 v2 架构必须使用 schemaVersion=2 和 node-action，不能降级为旧执行协议", ["plan.runtime", "protocol_mismatch"]],
  ["计划与应用运行协议不一致", ["plan.application.runtime", "protocol_mismatch"]],
  ["应用入口与研发入口不一致", ["plan.application.entrypoint", "entrypoint_mismatch"]],
  ["页面交付必须匹配已评估的交互形式", ["plan.application.page", "page_mismatch"]],
  ["动作引用了架构未设计的连接", ["plan.application.actions[].connectionIds", "undeclared_connection"]],
  ["动作验收必须提供能力替身列表，不能指定其他入口", ["plan.cases[].mocks", "action_case_invalid"]],
  ["验收用例引用不存在的动作", ["plan.cases[].actionId", "action_missing"]],
  ["每个动作必须有实际验收用例", ["plan.cases[].actionId", "action_missing"]],
  ["测试替身能力无效", ["plan.cases[].mocks[].capability", "mock_capability_invalid"]],
  ["Node 检查只用于页面验收，不能声明业务动作或能力替身", ["plan.cases[].kind", "node_check_invalid"]],
  ["Node 检查只用于页面验收，使用文本输入断言，不能声明业务动作或能力替身", ["plan.cases[].kind", "node_check_invalid"]],
  ["Node 检查入口必须独立且不能作为页面资源或公开后端入口", ["plan.cases[].entrypoint", "node_check_invalid"]],
  ["Node 检查入口必须列入对应任务文件", ["plan.tasks[].files", "invalid_entrypoint"]],
  ["用例引用的验收条目未分配给当前任务", ["plan.cases[].acceptanceId", "task_acceptance_mismatch"]],
  ["任务依赖存在循环", ["plan.tasks[].dependsOn", "dependency_cycle"]],
  ["验收断言路径必须为空或安全的属性路径，如 result.items.0", ["plan.cases[].assertions[].path", "assertion_path_invalid"]],
  ["同一用例包含重复的断言路径", ["plan.cases[].assertions[].path", "assertion_path_invalid"]],
  ["文件必须使用工作区内的安全相对路径，不能访问隐藏文件、依赖目录或凭据", ["plan.tasks[].files", "unsafe_path"]],
  ["页面资源必须包含在任务文件清单中", ["plan.tasks[].files", "invalid_entrypoint"]],
  ["修订计划不能删除或替换已确认的验收用例", ["plan.cases", "revision_frozen"]],
  ["修订计划不能删除或放宽已确认的验收断言", ["plan.cases[].assertions", "revision_frozen"]],
  ...["流程回复只能用于已冻结的流程入口", "流程回复步骤重复", "流程回复引用没有等待输入的步骤"]
    .map((message): [string, [string, string]] => [message, ["plan.cases[].workflowInputs", "workflow_case_invalid"]]),
]);
const valueSchemaRules = new Map<string, string>([
  ["输入输出 schema 无效或含不支持的规则", "schema_rule_unsupported"],
  ["schema 描述无效", "schema_rule_unsupported"], ["schema 规则与数据类型不匹配", "schema_type_mismatch"],
  ["对象 schema 必须明确字段、required 及 additionalProperties=false", "schema_object_invalid"],
  ["required 重复", "schema_object_invalid"], ["schema 属性名称无效", "schema_property_invalid"],
  ...["schema 上下限无效", "schema 数值边界无效", "schema 最小值不能大于最大值"].map((message): [string, string] => [message, "schema_bounds_invalid"]),
  ["schema enum 无效", "schema_type_mismatch"], ["enum 与 schema 类型不匹配", "schema_type_mismatch"],
]);
const serviceRules = new Map<string, [string, string]>([
  ["unsupported_service_runtime", ["plan.application.service", "service_runtime_invalid"]],
  ["invalid_service_entrypoint", ["plan.application.service.entrypoint", "service_entrypoint_invalid"]],
  ["invalid_service_limits", ["plan.application.service", "service_limits_invalid"]],
  ...["invalid_service_operations", "invalid_service_operation", "invalid_service_operation_visibility", "invalid_service_connections", "duplicate_service_operation"]
    .map((reason): [string, [string, string]] => [reason, ["plan.application.service.operations", "service_operation_invalid"]]),
  ...["invalid_service_dependencies", "invalid_dependency_lock", "invalid_dependency_url", "untrusted_dependency_source", "unsupported_dependency_format", "invalid_dependency_path", "duplicate_dependency", "dependency_filename_collision"]
    .map((reason): [string, [string, string]] => [reason, ["plan.application.service.dependencies", "dependency_lock_invalid"]]),
]);

const issue = (path: string, reason: string): SubmissionIssue => ({ path, reason, remedy: remedies[reason] ?? remedies.contract_invalid! });

function schemaIssue(input: unknown, path: string, reason: string) {
  const value = objectFields(input);
  const result = issue(path, reason);
  const field = /^plan\.cases\[(\d+)\](\..+)$/.exec(path);
  if (reason === "maxLength" && Number(value?.schemaVersion) >= 2 && field && objectFields(objectFields(value.cases)[Number(field[1])]).kind !== "node-check"
    && /^(?:\.input|\.mocks\[\d+\]\.(?:argsJson|resultJson)|\.assertions\[\d+\]\.expectedJson)$/.test(field[2]!))
    result.remedy = "保留测试规模与预期，使用已公开的声明式夹具；不删减边界数据。按上下文 testFixtureSchema 构造，不能缩小测试来通过。";
  return result;
}

function schemaIssues(value: DevelopmentPlan, root: string) {
  const result = [];
  const groups = [[value?.application?.actions, `${root}.application.actions`], [value?.application?.service?.operations, `${root}.application.service.operations`]] as const;
  for (const [actions, path] of groups) if (Array.isArray(actions)) for (let index = 0; index < Math.min(actions.length, 80); index++) {
    for (const field of ["inputSchema", "outputSchema"] as const) {
      try { validateValueSchema(actions[index]?.[field]); }
      catch (error) { result.push(issue(`${path}[${index}].${field}`, valueSchemaRules.get(String(objectFields(error).message ?? "").replace(/^应用契约无效：/, "")) ?? "schema_rule_unsupported")); }
      if (result.length === 6) return result;
    }
  }
  return result;
}

function actionInputIssues(value: DevelopmentPlan, root: string, { expectRejection = false } = {}) {
  const operations = value?.application?.service?.operations ?? value?.application?.actions;
  if (!Array.isArray(value?.cases) || !Array.isArray(operations)) return [];
  const result = [], fixtureBudget = { bytes: 0 };
  for (const { test, index, source } of activationCaseEntries(value).slice(0, 200)) {
    const group = source === "activation" ? "activationCases" : "cases", action = operations.find((item) => item.id === test.actionId);
    if (!action || test.kind === "node-check" || (expectRejection ? test.kind !== "input-rejection" : test.kind === "input-rejection")) continue;
    let input;
    try { ({ input } = resolveCaseValues(test, { maxInputBytes: value.runtime === "managed-service" ? 1024 * 1024 : 128 * 1024, fixtureBudget })); }
    catch { continue; }
    let accepted = true;
    if (expectRejection) accepted = !inputContractRejection(action, input, { target: test.inputTarget }).rejected;
    else try { validateActionInput(action, input); } catch { accepted = false; }
    if (expectRejection && accepted) result.push(issue(`${root}.${group}[${index}].kind`, "input_rejection_not_rejected"));
    else if (!expectRejection && !accepted) {
      const entry = issue(`${root}.${group}[${index}].input`, "action_input_invalid");
      if (["object", "array", "string", "integer", "number", "boolean", "null"].includes(action.inputSchema?.type ?? "")) {
        entry.expectedType = action.inputSchema.type!;
        entry.receivedType = receivedType(input, "", "");
        if (entry.expectedType === "object" && entry.receivedType === "string")
          entry.remedy = "动作inputSchema根类型为object，当前input展开后根类型为string。input须表示完整动作入参对象，不能把对象内某个业务JSON文本字段的字符串作为整个input。按inputSchema保存完整对象；可用{fixture:{op:'value',value:{...}}}避免手写JSON转义。";
      }
      result.push(entry);
    }
    if (result.length === 6) break;
  }
  return result;
}

export function submissionIssues(input: unknown, schema: ToolSchema, { root, error: errorInput, sdk = false, architecture }: { root: string; error?: unknown; sdk?: boolean; architecture?: DevelopmentArchitecture | undefined }): SubmissionIssue[] {
  const error = objectFields(errorInput), raw = objectFields(input);
  if (error?.reason === "planning_artifact_invalid") {
    const detail = objectFields(error.artifactIssue), code = detail.parseError;
    const remedies: Record<string, string> = { json: "优先用 save_plan_json 重新保存该文件的结构化对象或小批用例，宿主负责 JSON 序列化；保留其他文件并重新提交索引。",
      missing: "补齐索引引用的文件，再提交同一索引。", duplicate: "移除重复文件引用或用例编号，保留全部验收要求。",
      path: "索引及用例只使用规划目录内安全的 .json 相对路径。", shape: "索引用 caseFiles 有序列表替代 cases；用例文件为对象或非空对象数组。",
      limit: "按已公开的文件、用例和字节额度拆分材料；不得缩小测试边界。" };
    const index = isInteger(detail?.fileIndex) && detail.fileIndex >= 0 && detail.fileIndex < 200 ? `[${detail.fileIndex}]` : "";
    const location = objectFields(detail?.location);
    const numericLocation = code === "json" && location && ["offset", "line", "column"].every((key) => Number.isSafeInteger(location[key]))
      && Number(location.offset) >= 0 && Number(location.offset) <= 2 * 1024 * 1024 && Number(location.line) >= 1 && Number(location.line) <= 2 * 1024 * 1024 + 1
      && Number(location.column) >= 1 && Number(location.column) <= 2 * 1024 * 1024 + 1
      ? { offset: Number(location.offset), line: Number(location.line), column: Number(location.column) } : undefined;
    return [{ path: `planningFiles.${detail?.indexField === "caseFiles" ? "caseFiles" + index : "index"}`,
      reason: "planning_artifact_invalid", ...(numericLocation ? { location: numericLocation } : {}),
      remedy: (numericLocation ? `解析器定位第 ${numericLocation.line} 行、第 ${numericLocation.column} 列（字符偏移 ${numericLocation.offset}）。` : "")
        + (remedies[String(code)] ?? "检查规划索引和所引用文件后重新提交，不改变验收要求。") }];
  }
  if (root === "plan" && Number(raw.schemaVersion) >= 2 && Object.hasOwn(schema.properties ?? {}, "application")) {
    const application = diagnoseApplicationManifest(raw.application, { schema: schema.properties?.application, plan: raw });
    if (!application.valid) return application.issues;
  }
  const structural = toolInputValidation(input, schema, { root });
  if (!structural.valid) return structural.issues.map((entry) => ({ ...entry,
    remedy: schemaIssue(input, entry.path, entry.reason).remedy }));
  // Semantic diagnostics below run only after the registered submission schema accepts the shape.
  const value = input as DevelopmentPlan;
  if (root === "work" && error?.reason === "work_file_unauthorized") return [issue("work.changedFiles", "work_file_unauthorized")];
  if (root === "plan" && error?.reason === "fixture_json_required"
    && isInteger(error.fixtureCaseIndex) && error.fixtureCaseIndex >= 0 && error.fixtureCaseIndex < 200
    && /^(?:input|mocks\[(?:0|[1-9][0-9]?)\]\.(?:argsJson|resultJson)|assertions\[(?:0|[1-9][0-9]?)\]\.expectedJson)$/.test(String(error.fixtureField ?? ""))) {
    return [{ path: `plan.${error.fixtureCaseGroup === "activationCases" ? "activationCases" : "cases"}[${error.fixtureCaseIndex}].${error.fixtureField}`, reason: "invalid_json",
      remedy: "该字段须为合法JSON值文本，字符串预期需JSON字符串编码；也可用{fixture:{op:'value',value:原值}}直接保存结构化值，保留原输入与断言内容。" }];
  }
  if (error?.developmentIssue && Object.hasOwn(remedies, String(objectFields(error.developmentIssue).reason))) {
    const suppliedPath = String(objectFields(error.developmentIssue).path);
    if (["plan.runtime", "plan.application"].includes(suppliedPath)) return [issue(suppliedPath, String(objectFields(error.developmentIssue).reason))];
    if (/^plan\.activationChecks(?:\[(?:0|[1-9][0-9]?)\](?:\.(?:acceptanceId|caseIds)(?:\[(?:0|[1-9][0-9]{0,2})\])?)?)?$/.test(suppliedPath)) {
      const referenceId = objectFields(error.developmentIssue).referenceId;
      const trusted = [...architecture?.requirements ?? [], ...architecture?.design?.acceptance ?? []].some((entry) => entry.id === referenceId);
      return [{ ...issue(suppliedPath, String(objectFields(error.developmentIssue).reason)), ...(trusted ? { referenceId } : {}) }];
    }
  }
  const message = typeof error?.message === "string" ? error.message : "";
  const contractMessage = message.replace(/^研发契约无效：/, "");
  if (architecture && /缺少研发任务|缺少验收用例|缺少实际用例|缺少实际验收用例/.test(contractMessage)) {
    const trusted = (value: unknown) => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(value);
    const missing = [];
    for (const id of requiredDevelopmentRequirementIds(architecture)) if (trusted(id) && !value.tasks?.some((task) => task.requirementIds?.includes(id)))
      missing.push({ path: "plan.tasks", reason: "missing_coverage", remedy: `为已批准需求 ${id} 补齐任务映射和实际测试。` });
    for (const item of developmentAcceptanceItems(architecture)) if (trusted(item.id)) {
      if (!value.tasks?.some((task) => task.acceptanceIds?.includes(item.id)))
        missing.push({ path: "plan.tasks", reason: "missing_coverage", remedy: `为已批准验收 ${item.id} 补齐任务映射。` });
      for (const task of value.tasks ?? []) if (trusted(task.id) && task.acceptanceIds?.includes(item.id)
        && !value.cases?.some((test) => test.taskId === task.id && test.acceptanceId === item.id))
        missing.push({ path: "plan.cases", reason: "missing_coverage", remedy: `为任务 ${task.id} 的已批准验收 ${item.id} 增加具体执行用例。` });
    }
    if (missing.length) return missing.slice(0, 12);
  }
  if (contractMessage === "输入契约拒绝用例必须实际违反动作输入契约") {
    const found = actionInputIssues(value, root, { expectRejection: true });
    return found.length ? found : [issue(`${root}.cases[].kind`, "input_rejection_not_rejected")];
  }
  const rule = contractRules.get(contractMessage) ?? serviceRules.get(String(error?.reason));
  if (rule) return [issue(...rule)];
  if (valueSchemaRules.has(message.replace(/^应用契约无效：/, ""))) {
    const found = schemaIssues(value, root);
    if (found.length) return found;
  }
  if (/^应用契约无效：input(?:\.|\s)/.test(message)) {
    const found = actionInputIssues(value, root);
    if (found.length) return found;
  }
  if (message.startsWith("应用契约无效：") || message.startsWith("服务契约无效：")) return [issue(`${root}.application`, "application_invalid")];
  if (/引用了不存在的 ID/.test(message)) return [issue(root, "invalid_reference")];
  if (/缺少研发任务|缺少验收用例|缺少实际验收用例|缺少实际用例|必须有实际验收用例/.test(message)) return [issue(root, "missing_coverage")];
  if (/必须是合法 JSON/.test(message)) return [issue(root, "invalid_json")];
  if (/运行入口必须匹配/.test(message)) return [issue(`${root}.entrypoint`, "invalid_entrypoint")];
  return [issue(root, sdk ? "sdk_validation" : "contract_invalid")];
}

function receivedType(value: unknown, root: string, path: string) {
  const tail = path.slice(root.length);
  for (const part of tail.matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)|\[([0-9]+)\]/g)) {
    if (!value || typeof value !== "object") return "missing";
    const descriptor = Object.getOwnPropertyDescriptor(value, (part[1] ?? part[2])!);
    if (!descriptor) return "missing";
    if (!Object.hasOwn(descriptor, "value")) return "accessor";
    value = descriptor.value;
  }
  return value === undefined ? "missing" : value === null ? "null" : Array.isArray(value) ? "array"
    : ["string", "boolean", "number", "object"].includes(typeof value) ? typeof value : "other";
}

export function planningToolIssues(value: unknown, schema: ToolSchema, toolName: string) {
  const issues = submissionIssues(value, schema, { root: toolName, sdk: true });
  const result = issues.map((entry) => {
    let remedy = entry.remedy;
    if (toolName === "save_plan_json" && entry.path === "save_plan_json.value")
      remedy = "value须传JSON对象、数组或编码对象/数组的完整JSON文本；不接受数值、布尔值或null作为规划文件。JSON文本严格解析一次，文件序列化由宿主完成。";
    if (toolName === "save_plan_cases" && entry.path === "save_plan_cases.cases")
      remedy = "cases须直接传非空JSON数组，按工具公开的每例结构填写，最多200例；不要JSON.stringify成字符串，宿主负责文件编码。";
    if (toolName === "update_plan_json") {
      if (entry.path === "update_plan_json.updates") remedy = "updates须直接传更新数组，每项是包含pointer和value的对象，不要编码成JSON字符串。";
      else if (/^update_plan_json\.updates\[[0-9]+\]\.pointer$/.test(entry.path))
        remedy = "pointer须传JSON Pointer字符串，例如/0/input；它指定已有字段，不传整个对象或数组。";
      else if (/^update_plan_json\.updates\[[0-9]+\]\.value$/.test(entry.path))
        remedy = "每个更新必须提供value，直接填写该字段的新JSON值；字符串、对象、数组、数值、布尔值及null均可按原字段使用。";
      else if (/^update_plan_json\.updates\[[0-9]+\]$/.test(entry.path))
        remedy = "每个更新须直接传包含pointer和value的JSON对象，不要编码成字符串。";
    }
    if (toolName === "edit_plan_cases") {
      if (entry.path === "edit_plan_cases.expectedHash") remedy = "先读取该用例文件，使用宿主回执中的当前原始字节摘要expectedHash；材料改变后重新读取，不猜测摘要。";
      else if (entry.path === "edit_plan_cases.changes") remedy = "changes直接传1至40项数组；按稳定id显式add、replace、remove或move，不把数组编码成JSON字符串。";
      else if (/^edit_plan_cases\.changes\[[0-9]+\]\.case$/.test(entry.path)) remedy = "add或replace须传同id、符合本轮公开结构的完整case对象；remove和move不传case。宿主不改输入或断言。";
      else if (/^edit_plan_cases\.changes\[[0-9]+\]\.(?:id|beforeId)$/.test(entry.path)) remedy = "使用实际用例稳定编号；重复目标须结合诊断中的localIndex或expectedCaseHash明确选择，不自动去重。";
    }
    return { ...entry, remedy, receivedType: receivedType(value, toolName, entry.path) };
  });
  return [...new Map(result.map((entry) => [JSON.stringify(entry), entry])).values()];
}

export function rawPlanningToolIssues(value: unknown, schema: ToolSchema, toolName: string) {
  return toolInputValidation(value, schema, { root: toolName }).valid ? [] : planningToolIssues(value, schema, toolName);
}

export function recordSubmission(record: SubmissionRecord, { role, phase, taskId, turn, stage, status, issues = [] }: { role: string; phase: string; taskId?: string | null | undefined; turn: number; stage: string; status: "accepted" | "rejected"; issues?: SubmissionIssue[] }) {
  const counts = (record.submissionCounts ??= {});
  const count = (counts[role] ??= { attempts: 0, accepted: 0, rejected: 0 });
  count.attempts++; count[status]++;
  const entry = { sequence: Object.values(counts).reduce((sum, item) => sum + item.attempts, 0), role, phase,
    ...(taskId ? { taskId } : {}), turn, stage, status, issues, at: new Date().toISOString() };
  record.submissionAttempts = [...(record.submissionAttempts ?? []), entry].slice(-24);
  return entry;
}

export function lastSubmissionDiagnostic(record: SubmissionRecord, role: string | undefined) {
  const last = record.submissionAttempts?.findLast((item) => item.role === role && item.status === "rejected");
  if (!last) return undefined;
  return { attempts: record.submissionCounts?.[role!]?.attempts ?? 0, rejected: record.submissionCounts?.[role!]?.rejected ?? 0,
    stage: last.stage, issues: last.issues.slice(0, 3) };
}
