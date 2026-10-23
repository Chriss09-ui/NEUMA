import { createHash } from "node:crypto";
import { InputError, normalizeDraft, decideNext } from "../requirements/core.mjs";
import { taskSpecRequirementItems } from "../requirements/task-spec.mjs";
import { CONNECTION_DEFINITION_SCHEMA, validateConnectionDefinition } from "../connections/connection-contract.mjs";
import { REVIEW_ISSUE_EVIDENCE_PROPERTIES, ACCEPTANCE_SCOPE_CHECKS_SCHEMA, validateArchitectureReviewEvidence } from "./architecture-review-evidence.mjs";
import { ACCEPTANCE_VERIFICATION_SCHEMA, ACCEPTANCE_ADAPTER_GUIDE, validateAcceptanceVerification, validateAcceptanceCoverage } from "../verification/acceptance-contract.mjs";
import { hostDeliveryCapabilityCatalog, runtimeCapabilityContract } from "../runtime/runtime-capability-contract.mjs";
import { PLATFORM_CLAIMS_SCHEMA, validateArchitecturePlatformClaims } from "./architecture-platform-claims.mjs";
import { REQUIREMENT_LIMITS } from "../requirements/requirement-limits.mjs";
import { textLength } from "../runtime/text-length.mjs";

export const ARCHITECTURE_VERSION = 1;
export const CURRENT_ARCHITECTURE_VERSION = 3;
/** Live model turns for one architecture role. Resume keeps the count; designer and reviewer each have their own. */
export const ARCHITECTURE_ROLE_TURN_LIMIT = 5;
/** Checkpoints written under the previous ceiling remain readable. Counts from the live limit through this ceiling are already spent. */
export const ARCHITECTURE_STORED_TURN_LIMIT = 12;
export const ARCHITECTURE_MODULE_LIMIT = 3;
export const architectureTurnBudgetSpent = (calls) => Number.isSafeInteger(calls)
  && calls >= ARCHITECTURE_ROLE_TURN_LIMIT && calls <= ARCHITECTURE_STORED_TURN_LIMIT;
export const supportedArchitectureVersion = (record) => [1, 2, 3].includes(record?.contractVersion)
  && record.contractVersion === (record?.design?.schemaVersion ?? 1);
export const requiresDevelopment = (design) => ["workflow", "custom"].includes(design?.profile)
  || design?.interaction?.page === true || design?.interaction?.operations === true
  || ["managed", "docker"].includes(design?.execution?.hosting);
export const CAPABILITY_CATALOG_VERSION = 2;
export const LEGACY_CAPABILITIES = Object.freeze([
  { id: "conversation", status: "available", scope: "基于用户提供的文本进行对话与生成；不包含联网检索、外部动作或定时运行。" },
  { id: "list_workspace_files", status: "available", scope: "仅列出当前 Agent 专属工作目录内允许访问的文件。" },
  { id: "read_workspace_file", status: "available", scope: "仅读取当前 Agent 专属工作目录内的 UTF-8 文本；不访问外部目录、隐藏文件或凭据。" },
  { id: "write_workspace_file", status: "available", scope: "仅在当前 Agent 专属工作目录保存文本文件；不包含部署、发送、任意代码执行或外部系统写入。" },
].map(Object.freeze));
export const PUBLIC_CAPABILITIES = Object.freeze([
  { id: "list_materials", version: 1, status: "available", scope: "仅列出当前 Agent 的上传材料及其实际处理状态；材料在同一 Agent 的不同对话间共享。" },
  { id: "read_material", version: 1, status: "available", scope: "仅按材料 ID 分页读取当前 Agent 上传文档、表格、演示文稿或 PDF 中实际提取的文本及来源位置；不访问任意本地路径。" },
  { id: "read_material_image", version: 1, status: "available", scope: "仅按材料 ID 读取当前 Agent 上传的图片或 PDF 页面图像；图片理解取决于实际模型支持，不包含独立 OCR 服务或联网检索。" },
].map(Object.freeze));
export const PUBLIC_TOOL_IDS = Object.freeze(PUBLIC_CAPABILITIES.map((item) => item.id));
export const CAPABILITIES = Object.freeze([
  ...LEGACY_CAPABILITIES.map((item) => Object.freeze({ ...item, version: 1 })), ...PUBLIC_CAPABILITIES,
]);

export function capabilitySnapshotCompatible(record, capabilities = CAPABILITIES, publicCapabilities = [], hostCapabilities = []) {
  try {
    const declared = record?.design?.capabilities;
    if (!Array.isArray(declared) || !declared.length || new Set(declared.map((item) => item?.id)).size !== declared.length
      || declared.some((item) => !item || typeof item.id !== "string"
        || !["available", "needs_connection", "needs_development", "unverified"].includes(item.status))) return false;
    const used = declared.filter((item) => item.status === "available");
    if (record.capabilityCatalogVersion === undefined || record.capabilityCatalogVersion === 1) {
      return designHash(record.capabilitySnapshot) === designHash(LEGACY_CAPABILITIES)
        && Array.isArray(capabilities) && used.every((item) => {
          const legacy = LEGACY_CAPABILITIES.find((entry) => entry.id === item.id);
          const current = capabilities.find((entry) => entry?.id === item.id);
          return legacy && current && designHash(current) === designHash({ ...legacy, version: 1 });
        });
    }
    if (record.capabilityCatalogVersion !== CAPABILITY_CATALOG_VERSION || !Array.isArray(record.capabilitySnapshot)
      || !Array.isArray(capabilities) || !Array.isArray(publicCapabilities) || !Array.isArray(hostCapabilities)) return false;
    const hostSnapshot = hostDeliveryCapabilityCatalog(record.runtimeCapabilities);
    const validEntry = (item) => item && typeof item === "object" && !Array.isArray(item)
      && Object.keys(item).length === 4 && ["id", "version", "status", "scope"].every((key) => Object.hasOwn(item, key))
      && typeof item.id === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(item.id)
      && Number.isSafeInteger(item.version) && item.version > 0
      && ["available", "needs_connection", "needs_development", "unverified"].includes(item.status)
      && typeof item.scope === "string" && Boolean(item.scope.trim()) && !item.scope.includes("\0");
    if (record.capabilitySnapshot.some((item) => !validEntry(item)) || capabilities.some((item) => !validEntry(item))
      || publicCapabilities.some((item) => !validEntry(item)) || hostCapabilities.some((item) => !validEntry(item)) || hostSnapshot.some((item) => !validEntry(item))
      || new Set(record.capabilitySnapshot.map((item) => item.id)).size !== record.capabilitySnapshot.length
      || new Set(capabilities.map((item) => item.id)).size !== capabilities.length
      || new Set(publicCapabilities.map((item) => item.id)).size !== publicCapabilities.length
      || new Set(hostCapabilities.map((item) => item.id)).size !== hostCapabilities.length) return false;
    const snapshot = new Map(record.capabilitySnapshot.map((item) => [item.id, item]));
    const current = new Map(capabilities.map((item) => [item.id, item]));
    const publicCurrent = new Map(publicCapabilities.map((item) => [item.id, item]));
    const hostCurrent = new Map(hostCapabilities.map((item) => [item.id, item]));
    const hostSaved = new Map(hostSnapshot.map((item) => [item.id, item]));
    const publicSnapshot = new Map([2, 3, 4].includes(record.platformSnapshot?.version) ? (record.platformSnapshot.publicCapabilities ?? [])
      .map(({ id, version, status, scope }) => [id, { id, version, status, scope }]) : []);
    return used.every(({ id }) => {
      const saved = snapshot.has(id) ? snapshot.get(id) : publicSnapshot.has(id) ? publicSnapshot.get(id) : hostSaved.get(id);
      const active = snapshot.has(id) ? current.get(id) : publicSnapshot.has(id) ? publicCurrent.get(id) : hostCurrent.get(id);
      return saved?.status === "available" && active?.status === "available" && designHash(saved) === designHash(active);
    });
  } catch { return false; }
}

const text = (maxLength = 2000) => ({ type: "string", minLength: 1, maxLength });
const identifier = { ...text(80), pattern: "^[A-Za-z][A-Za-z0-9_-]*$" };
const choice = (...values) => ({ type: "string", enum: values });
const list = (items, minItems = 0, maxItems = 80) => ({ type: "array", items, minItems, maxItems });
const object = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const references = (minItems = 0, maxItems = 80) => ({ ...list(identifier, minItems, maxItems), uniqueItems: true });
const requirementReferences = (minItems = 0) => references(minItems, REQUIREMENT_LIMITS.formalItems);
const issueSchema = object({ id: identifier, blocking: { type: "boolean" }, description: text(), remedy: text() });
Object.assign(issueSchema.properties, REVIEW_ISSUE_EVIDENCE_PROPERTIES);
const REVIEW_CHECKS = ["requirements", "feasibility", "minimality", "interfaces", "failure_handling", "verification"];
const EXTENDED_REVIEW_CHECKS = [...REVIEW_CHECKS, "requirement_sufficiency", "acceptance_quality"];

export const LEGACY_DESIGN_SCHEMA = object({
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
  coverage: list(object({ requirementId: identifier, componentIds: references(1), verification: text() }), 1, REQUIREMENT_LIMITS.formalItems),
  acceptance: list(object({
    id: identifier, kind: choice("success", "missing_input", "boundary", "tool_failure"),
    requirementIds: requirementReferences(1), input: text(), expected: text(),
  }), 3),
  unknowns: list(object({ question: text(), blocking: { type: "boolean" }, resolution: text() })),
});
LEGACY_DESIGN_SCHEMA.properties.acceptance.items.properties.verification = ACCEPTANCE_VERIFICATION_SCHEMA;

export const INTERACTION_SCHEMA = object({
  defaultEntry: choice("conversation", "application"), page: { type: "boolean" }, operations: { type: "boolean" },
  inputs: text(), results: text(), persistentData: text(),
});
INTERACTION_SCHEMA.properties.assistant = object({ enabled: { type: "boolean" }, purpose: { type: "string", minLength: 0, maxLength: 500 } });
export const CONNECTION_SCHEMA = object({ id: identifier, purpose: choice("search", "model", "business"),
  required: { type: "boolean" }, description: text(), operations: list(object({
    id: identifier, method: choice("GET", "POST", "PUT", "PATCH", "DELETE"), path: text(500), input: text(), output: text(), safeTest: { type: "boolean" },
  }), 0, 40),
});
export const DESIGN_V2_SCHEMA = object({ ...LEGACY_DESIGN_SCHEMA.properties, schemaVersion: { type: "integer", enum: [2] },
  interaction: INTERACTION_SCHEMA, connections: list(CONNECTION_SCHEMA, 0, 40) });
export const DESIGN_V3_SCHEMA = object({ ...DESIGN_V2_SCHEMA.properties, schemaVersion: { type: "integer", enum: [3] },
  connections: list(CONNECTION_DEFINITION_SCHEMA, 0, 40),
  execution: object({ language: choice("none", "javascript", "python"), hosting: choice("builtin", "managed", "docker"), reason: text(4000) }),
  selectionBasis: object({ capacity: text(4000), process: text(4000), quality: text(4000), requirementIds: requirementReferences(1), assumptions: list(text()) }),
});
DESIGN_V3_SCHEMA.properties.platformClaims = PLATFORM_CLAIMS_SCHEMA;
// Legacy callers can submit their original contract; new task specifications use the exact v3 tool below.
export const DESIGN_SCHEMA = { ...DESIGN_V3_SCHEMA,
  properties: { ...Object.fromEntries(Object.entries(DESIGN_V3_SCHEMA.properties).filter(([key]) => key !== "platformClaims")), schemaVersion: { type: "integer", enum: [2, 3] },
    connections: list({ anyOf: [CONNECTION_SCHEMA, CONNECTION_DEFINITION_SCHEMA] }, 0, 40) }, required: LEGACY_DESIGN_SCHEMA.required };

export function designSubmissionSchema(draft, { requirements = [] } = {}) {
  const schema = structuredClone(draft?.taskSpec ? DESIGN_V3_SCHEMA : DESIGN_SCHEMA);
  if (draft?.taskSpec) schema.properties.acceptance.items.required.push("verification");
  const ids = requirements.map((item) => item.id);
  if (ids.length) {
    const reference = { ...identifier, enum: ids };
    const maximum = Math.max(80, ids.length);
    schema.properties.coverage.maxItems = maximum;
    schema.properties.coverage.items.properties.requirementId = reference;
    schema.properties.acceptance.items.properties.requirementIds.maxItems = maximum;
    schema.properties.acceptance.items.properties.requirementIds.items = reference;
    schema.properties.selectionBasis.properties.requirementIds.maxItems = maximum;
    schema.properties.selectionBasis.properties.requirementIds.items = reference;
  }
  return schema;
}

export const REVIEW_SCHEMA = object({
  candidateHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
  verdict: choice("pass", "revise", "insufficient", "infeasible", "needs_input"),
  checks: list(object({ id: choice(...EXTENDED_REVIEW_CHECKS), passed: { type: "boolean" }, evidence: text(4000) }), 6, 8),
  issues: list(issueSchema, 0, 160),
  summary: text(4000),
});
REVIEW_SCHEMA.properties.acceptanceScopeChecks = ACCEPTANCE_SCOPE_CHECKS_SCHEMA;
REVIEW_SCHEMA.properties.priorFindingDecisions = list(object({ findingId: text(80),
  status: choice("resolved", "unresolved", "unsupported"), reason: text(1200),
  checkIds: list(choice(...EXTENDED_REVIEW_CHECKS), 1, 8), candidatePaths: list({ type: "string", maxLength: 500 }, 1, 12) }), 0, 80);

export function reviewSubmissionSchema({ evidenceRequired = false, priorFindingsRequired = false } = {}) {
  const schema = structuredClone(REVIEW_SCHEMA);
  if (evidenceRequired) {
    schema.properties.issues.items.required.push(...Object.keys(REVIEW_ISSUE_EVIDENCE_PROPERTIES));
    schema.required.push("acceptanceScopeChecks");
  }
  if (priorFindingsRequired) schema.required.push("priorFindingDecisions");
  return schema;
}

function fail(message, validationIssue) {
  throw Object.assign(new InputError(`架构契约无效：${message}`), validationIssue ? { validationIssue } : {});
}

function validateSchema(value, schema, path = "design") {
  if (schema.anyOf) {
    if (!schema.anyOf.some((branch) => { try { validateSchema(value, branch, path); return true; } catch { return false; } })) fail(`${path} 格式无效`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) fail(`${path} 取值不受支持`, { path, reason: "invalid_value" });
  if (!schema.type) return;
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${path} 必须为对象`);
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail(`${path}.${key} 缺失`);
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) validateSchema(value[key], schema.properties[key], `${path}.${key}`);
      else if (schema.additionalProperties === false) fail(`${path}.<field> 不受支持`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object")
        validateSchema(value[key], schema.additionalProperties, `${path}.<field>`);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? 1000)) fail(`${path} 条目数量无效`);
    value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`));
    if (schema.uniqueItems && new Set(value).size !== value.length) fail(`${path} 包含重复引用`);
  } else if (schema.type === "string") {
    if (typeof value !== "string" || (schema.minLength !== 0 && !value.trim()) || value.includes("\0")
        || (schema.maxLength !== undefined && textLength(value) > schema.maxLength)
        || (schema.minLength !== undefined && textLength(value) < schema.minLength)
        || (schema.pattern && !new RegExp(schema.pattern).test(value))
        || (schema.enum && !schema.enum.includes(value))) fail(`${path} 文本或取值无效`);
  } else if (schema.type === "integer") {
    if (!Number.isSafeInteger(value)) fail(`${path} 必须为整数`);
    if (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum)
      fail(`${path} 数值范围无效`);
  } else if (schema.type === "number") { if (typeof value !== "number" || !Number.isFinite(value)) fail(`${path} 数字无效`); }
  else if (schema.type === "null") { if (value !== null) fail(`${path} 必须为空`); }
  else if (typeof value !== "boolean") fail(`${path} 必须为布尔值`);
}

function uniqueIds(items, label, key = "id") {
  const ids = items.map((item) => item[key]);
  if (new Set(ids).size !== ids.length) fail(`${label} 包含重复 ID`);
  return new Set(ids);
}

function assertReference(id, ids, path, exposeReferences = false) {
  if (!ids.has(id)) {
    const allowedReferences = [...ids].slice(0, 100);
    fail(exposeReferences ? `${path} 引用了不存在的 ID。允许的编号：${allowedReferences.join("、")}` : `${path} 引用了不存在的 ID`,
      { path, reason: "invalid_reference", ...(exposeReferences ? { allowedReferences } : {}) });
  }
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
  if (draft.interaction) {
    const { operations, ...interaction } = draft.interaction;
    items.push({ id: "interaction", text: `交互：${JSON.stringify(interaction)}` });
    items.push(...operations.map((operation, index) => ({ id: `operation_${index + 1}`, text: `需实现的操作：${operation}` })));
  }
  items.push(...(draft.connections ?? []).map((connection, index) => ({ id: `connection_${index + 1}`, text: `服务依赖：${JSON.stringify(connection)}` })));
  items.push(...taskSpecRequirementItems(draft).map((item) => ({ id: `spec_${designHash(item.id).slice(0, 24)}`,
    text: `任务要求 ${item.id}（${item.dimension}，依据=${item.source}，关键=${item.critical}）：${item.text}` })));
  return items;
}

export function architectureDecisionSources({ evidence = [], confirmedRequirementContext, deferredVerifications, requirements = [] } = {}) {
  const ids = new Set(evidence.map(row => row.id)), aliases = new Map();
  const confirmed = confirmedRequirementContext;
  try {
    const { hash, ...body } = confirmed ?? {};
    if (hash === designHash(body) && Array.isArray(confirmed.sourceQuotes)) {
      const registered = new Set([...confirmed.taskSources ?? [], ...confirmed.resolvedChoices ?? []].flatMap(row => row.quoteIds ?? []));
      const byMessage = new Map();
      for (const quote of confirmed.sourceQuotes) {
        const { id, ...source } = quote;
        if (!registered.has(id) || id !== `quote_${designHash(source).slice(0, 24)}`) continue;
        ids.add(id);
        const matches = byMessage.get(quote.messageId) ?? []; matches.push(id); byMessage.set(quote.messageId, matches);
      }
      for (const [messageId, matches] of byMessage) if (typeof messageId === "string" && messageId.startsWith("msg_") && matches.length === 1)
        aliases.set(`quote_${messageId.slice(4)}`, matches[0]);
    }
  } catch { /* Unverified source snapshots cannot register decision evidence. */ }
  try {
    const deferred = deferredVerifications, issues = deferred?.issues;
    const source = issues?.map(({ id, stage, question, impact, requirementIds, checks }) => ({ id, stage, question, impact, requirementIds, checks }));
    if (Array.isArray(issues) && deferred.hash === designHash(source)) {
      const known = new Set(requirements.map(row => row.id));
      for (const issue of issues) if (known.has(issue.requirementId)) ids.add(issue.id);
    }
  } catch { /* Unknown or changed system findings are not evidence identifiers. */ }
  return { ids, aliases };
}

export function normalizeArchitectureDecisionReferences(decisions, context) {
  const { ids, aliases } = architectureDecisionSources(context);
  return decisions.map(row => ({ ...row, evidenceIds: [...new Set(row.evidenceIds.map(id => ids.has(id) ? id : aliases.get(id) ?? id))] }));
}

export function validateArchitectureDecisionReferences(design, context, root = "design") {
  const { ids, aliases } = architectureDecisionSources(context);
  for (const [index, row] of design.decisions.entries()) for (const [position, id] of row.evidenceIds.entries())
    assertReference(root === "module" && !ids.has(id) ? aliases.get(id) ?? id : id, ids, `${root}.decisions[${index}].evidenceIds[${position}]`, true);
  return design;
}

export function validateDesign(value, { requirements, capabilities = CAPABILITIES, evidence = [], draft, deferredVerifications, confirmedRequirementContext, requireAcceptanceVerification = false,
  runtimeCapabilities = runtimeCapabilityContract(), acceptanceAdapterGuide = ACCEPTANCE_ADAPTER_GUIDE, contextManifest } = {}) {
  if (draft?.taskSpec && value?.schemaVersion !== 3) fail("包含任务规格的新需求必须使用 v3 架构，不能绕过规模与验收依据");
  validateSchema(value, value?.schemaVersion === 3 ? DESIGN_V3_SCHEMA : value?.schemaVersion === 2 ? DESIGN_V2_SCHEMA : LEGACY_DESIGN_SCHEMA);
  if (value.schemaVersion >= 2) {
    if (value.interaction.defaultEntry === "application" && !value.interaction.page) fail("应用入口必须交付页面",
      { path: "design.interaction.page", reason: "invalid_contract" });
    if (value.interaction.assistant?.enabled && (!value.interaction.page || !value.interaction.assistant.purpose.trim())) fail("页面助手必须有托管页面及具体用途",
      { path: "design.interaction.assistant", reason: "invalid_contract" });
    uniqueIds(value.connections, "connections");
    for (const [index, connection] of value.connections.entries()) {
      if (value.schemaVersion === 3) {
        try { validateConnectionDefinition(connection); }
        catch { fail(`design.connections[${index}] 的操作定义与所选协议不一致，请补齐 HTTP 的 method/path 或 MCP 的 tool/resourceUri`,
          { path: `design.connections[${index}]`, reason: "invalid_contract" }); }
        continue;
      }
      uniqueIds(connection.operations, "connection.operations");
      if (connection.purpose !== "business" && connection.operations.length) fail("仅业务连接可以声明业务操作");
      if (connection.purpose === "business" && !connection.operations.length) fail("业务连接必须声明实际操作");
      for (const operation of connection.operations) {
        if (!operation.path.startsWith("/") || operation.path.startsWith("//") || /[\\\x00-\x20?#]/.test(operation.path)
          || operation.path.split("/").includes("..")) fail("业务操作必须使用固定安全相对路径");
        if (operation.safeTest && !["GET"].includes(operation.method)) fail("无副作用连接测试只允许 GET");
      }
    }
  }
  if (!Array.isArray(requirements) || !requirements.length || requirements.length > REQUIREMENT_LIMITS.formalItems) fail("已确认的需求清单数量无效");
  for (const requirement of requirements) validateSchema(requirement, object({ id: identifier,
    text: text(REQUIREMENT_LIMITS.formalTextCharacters) }), "requirements");
  const requirementIds = uniqueIds(requirements, "requirements");
  if (value.schemaVersion === 3) {
    value.selectionBasis.requirementIds.forEach((id, index) => assertReference(id, requirementIds, `design.selectionBasis.requirementIds[${index}]`, true));
    if (value.execution.language === "none" && value.execution.hosting !== "builtin") fail("独立服务必须选择实际运行语言",
      { path: "design.execution.language", reason: "invalid_contract" });
    if (value.execution.language === "python" && value.execution.hosting === "builtin") fail("Python 必须通过受管或 Docker 运行器交付",
      { path: "design.execution.hosting", reason: "invalid_contract" });
    if (value.profile === "workflow" && value.execution.hosting === "builtin") fail("新流程必须使用支持持久检查点的受管运行方式",
      { path: "design.execution.hosting", reason: "invalid_contract" });
  }
  const componentIds = uniqueIds(value.components, "components");
  const stepIds = uniqueIds(value.steps, "steps");
  uniqueIds(value.capabilities, "capabilities");
  uniqueIds(value.decisions, "decisions");
  uniqueIds(value.acceptance, "acceptance");
  const covered = uniqueIds(value.coverage, "coverage", "requirementId");
  const missingCoverage = [...requirementIds].filter((id) => !covered.has(id));
  if (missingCoverage.length) fail(`以下正式需求未被设计覆盖：${missingCoverage.join("、")}`,
    { path: "design.coverage", reason: "missing_coverage", allowedReferences: [...requirementIds], missingReferences: missingCoverage });
  for (const [index, coverage] of value.coverage.entries()) {
    assertReference(coverage.requirementId, requirementIds, `design.coverage[${index}].requirementId`, true);
    coverage.componentIds.forEach((id, child) => assertReference(id, componentIds, `design.coverage[${index}].componentIds[${child}]`));
  }
  const usedComponents = new Set();
  for (const [index, step] of value.steps.entries()) {
    assertReference(step.componentId, componentIds, `design.steps[${index}].componentId`, true);
    usedComponents.add(step.componentId);
    step.dependsOn.forEach((id, child) => assertReference(id, stepIds, `design.steps[${index}].dependsOn[${child}]`));
  }
  for (const id of componentIds) if (!usedComponents.has(id)) fail("design.steps 未覆盖所有组件",
    { path: "design.steps", reason: "invalid_reference" });
  const steps = new Map(value.steps.map((step) => [step.id, step]));
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) fail("design.steps.dependsOn 的步骤依赖存在循环", { path: "design.steps.dependsOn", reason: "invalid_reference" });
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
  for (const [index, capability] of value.capabilities.entries()) {
    if (capability.status === "available" && !knownCapabilities.has(capability.id)) fail(`design.capabilities[${index}].id 未被工具目录证实可用`,
      { path: `design.capabilities[${index}].id`, reason: "invalid_reference", allowedReferences: [...knownCapabilities] });
  }
  uniqueIds(evidence, "evidence");
  validateArchitectureDecisionReferences(value, { evidence, confirmedRequirementContext, deferredVerifications, requirements });
  const kinds = new Set(value.acceptance.map((item) => item.kind));
  for (const kind of ["success", "missing_input", "boundary"]) if (!kinds.has(kind)) fail(`缺少 ${kind} 验收场景`);
  if (value.capabilities.some((item) => item.id !== "conversation") && !kinds.has("tool_failure")) fail("使用工具时必须提供 tool_failure 验收场景");
  const tested = new Set();
  for (const [index, acceptance] of value.acceptance.entries()) {
    validateAcceptanceVerification(acceptance, { required: requireAcceptanceVerification });
    acceptance.requirementIds.forEach((id) => {
      assertReference(id, requirementIds, `design.acceptance[${index}].requirementIds`, true);
      tested.add(id);
    });
  }
  const missingAcceptance = [...requirementIds].filter((id) => !tested.has(id));
  if (missingAcceptance.length) fail(`以下正式需求缺少验收场景：${missingAcceptance.join("、")}`,
    { path: "design.acceptance", reason: "missing_coverage", allowedReferences: [...requirementIds], missingReferences: missingAcceptance });
  validateAcceptanceCoverage({ design: value, requirements, draft, deferredVerifications });
  validateArchitecturePlatformClaims(value, { runtimeCapabilities, acceptanceAdapterGuide, ...(contextManifest ? { contextManifest } : {}) });
  return structuredClone(value);
}

export function checkDesign(value, context) {
  const design = validateDesign(value, context);
  const issues = [];
  const confirmed = context?.draft?.interaction;
  const requiresPage = confirmed?.page === true;
  const requiresOperations = Array.isArray(confirmed?.operations) && confirmed.operations.length > 0;
  if (design.schemaVersion >= 3 && (requiresDevelopment(design) && design.execution.language === "none"
    || !requiresDevelopment(design) && design.execution.language !== "none")) issues.push({
    id: "execution_consistency", blocking: true, source: "program",
    candidateFields: ["execution", "profile", "interaction", "capabilities", "steps", "coverage", "acceptance"],
    description: "候选的代码运行方式与实际交付方式矛盾，不能把无代码方案送入研发，也不能把代码功能作为普通对话交付。",
    remedy: "逐项核对已确认交付：已有工具完成的生成、保存和下载文件使用 none/builtin 且不声明后台代码操作；真实页面、后台操作或 workflow/custom 保留需求并选择实际语言及受支持运行方式。若已确认需求分类本身有误，返回需求层确认，不能自动删除操作或缩减承诺。",
  });
  if ((requiresPage || requiresOperations) && (![2, 3].includes(design.schemaVersion)
    || requiresPage && design.interaction.page !== true
    || requiresOperations && design.interaction.operations !== true)) issues.push({
    id: "confirmed_interaction", blocking: true, source: "program",
    candidateFields: ["schemaVersion", "interaction", "profile", "steps", "coverage", "acceptance"],
    description: "候选没有保留已确认的托管页面或应用操作需求，不能以旧版结构或关闭交付字段缩减需求。",
    remedy: `提交 schemaVersion:${context?.draft?.taskSpec ? 3 : 2}，按已确认需求设置 interaction.page/operations，并通过现有研发通道交付；同步核对步骤、需求覆盖和验收，不能降为普通对话或下载文件。`,
  });
  if (design.schemaVersion >= 2 && (confirmed?.defaultEntry && confirmed.defaultEntry !== design.interaction.defaultEntry
    || confirmed?.assistant && (confirmed.assistant.enabled !== design.interaction.assistant?.enabled
      || confirmed.assistant.purpose !== design.interaction.assistant?.purpose)
    || design.interaction.assistant?.enabled && !confirmed?.assistant?.enabled)) issues.push({
    id: "confirmed_presentation", blocking: true, source: "program", candidateFields: ["interaction", "coverage", "acceptance"],
    description: "候选没有保留已确认的默认入口或页面助手用途，不能擅自添加助手或改写交互选择。",
    remedy: "按已确认需求原样保留 interaction.defaultEntry 和 assistant；未要求 AI 对话的页面不启用助手。",
  });
  design.unknowns.forEach((item, index) => issues.push({
    id: `unknown_${index + 1}`, blocking: item.blocking,
    description: item.question, remedy: item.resolution,
  }));
  for (const capability of design.capabilities) {
    if (context?.platformSnapshot?.publicCapabilities?.some((item) => item.id === capability.id && item.status === "forbidden")) {
      issues.push({ id: `capability_${capability.id}`, blocking: true,
        description: `能力 ${capability.id} 被本轮平台政策禁止，连接配置或研发不能解除该限制。`,
        remedy: "修正 capabilities、steps、coverage 和 acceptance 中的执行路径；若已确认需求必须联网，保留冲突并请求需求方确认变更，不能改平台快照或用未就绪状态绕过禁止联网。" });
      continue;
    }
    const provided = context?.capabilities?.some((item) => item.id === capability.id && item.status === "available");
    if (capability.status !== "available") issues.push({
      id: capability.id.length <= 69 ? `capability_${capability.id}`
        : `capability_${createHash("sha256").update(capability.id).digest("hex").slice(0, 24)}`,
      blocking: capability.status === "unverified" || !requiresDevelopment(design),
      description: provided ? `候选把本轮目录已提供的能力 ${capability.id} 标为 ${capability.status}：${capability.reason}`
        : `能力 ${capability.id} 尚未可用：${capability.reason}`,
      remedy: provided ? "按宿主完整目录修正 capabilities.status 为 available；这只表示工具已提供且允许调用，不代表具体目标读取或业务验收成功。将目标与效果的未知写入 unknowns、失败处理和 acceptance，不改程序标记，也不虚构调用证据。"
        : "先区分实际执行依赖与待验收的业务效果。若只是尚未验收的效果，修正 capabilities 分类，将原义务完整保留在 unknowns、适用的 acceptance 或已有后续验证安排中，保留需求引用、验证阶段和失败处置，不伪改为 available 或宣称已通过。若为实际执行依赖，选择真实可用的替代能力或已有明确实现路径的研发通道，并核对步骤、需求覆盖及验收；真实缺口仍须阻断，不能仅移入 unknowns 或改阶段。若为未采用或未来方案，从 capabilities 移至 decisions，保留缺口事实；不能修改程序检查标记来放行。",
    });
  }
  if (!requiresDevelopment(design) && design.state.mode === "persistent") issues.push({
    id: "persistent_state", blocking: true,
    description: "轻量执行器未提供自主维护的持久状态。",
    remedy: "将状态缩减为任务上下文，或选择 workflow/custom 并说明实现路径。",
  });
  return { issues, runnable: !requiresDevelopment(design)
    && design.state.mode !== "persistent"
    && design.capabilities.every((item) => item.status === "available")
    && !issues.some((item) => item.blocking) };
}

export function validateReview(value, { candidateHash, schemaVersion = 1, evidenceContext } = {}) {
  validateSchema(value, reviewSubmissionSchema({ evidenceRequired: Boolean(evidenceContext) }), "review");
  if (value.candidateHash !== candidateHash) fail("评估结果与当前候选版本不匹配");
  const checks = uniqueIds(value.checks, "review.checks");
  for (const id of schemaVersion >= 3 ? EXTENDED_REVIEW_CHECKS : REVIEW_CHECKS) if (!checks.has(id)) fail(`缺少评估项 ${id}`);
  uniqueIds(value.issues, "review.issues");
  if (value.verdict === "pass" && (value.checks.some((item) => !item.passed)
      || value.issues.some((item) => item.blocking))) fail("评估未全部通过或仍有阻断问题，不能判定 pass");
  if (value.verdict !== "pass" && value.checks.every((item) => item.passed)
      && !value.issues.some((item) => item.blocking)) fail("未通过评估必须说明未通过项或阻断问题");
  if (evidenceContext) validateArchitectureReviewEvidence(value, evidenceContext);
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
