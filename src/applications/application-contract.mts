import type { ApplicationAction, ApplicationManifest, ApplicationSnapshot, ValueKind, ValueSchema } from "../contracts/application.mjs";
import type { JsonValue, UnknownRecord } from "../contracts/json.mjs";
import { isPlainRecord as plain, isArray, isInteger } from "../runtime/type-boundary.mjs";
import { InputError } from "../requirements/core.mjs";
import { isDeepStrictEqual } from "node:util";
import { validateServiceManifest } from "../services/service-contract.mjs";
import { VALUE_SCHEMA_RULES } from "./value-schema-rules.mjs";
import { APPLICATION_ACTION_VALUE_BYTES } from "../runtime/runtime-capability-contract.mjs";
export { VALUE_SCHEMA_RULES, VALUE_SCHEMA_DESCRIPTION } from "./value-schema-rules.mjs";

export const APPLICATION_PROTOCOL_VERSION = 2;
const id = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const hash = /^[a-f0-9]{64}$/;
function fail(message: string): never { throw new InputError(`应用契约无效：${message}`); }
function fields(value: unknown, keys: string[], label: string): asserts value is UnknownRecord {
  if (!plain(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) fail(`${label} 字段无效`);
}
const safePath = (path: unknown): string => {
  if (typeof path !== "string" || path.length > 500 || !path || path.trim() !== path || /[\\\x00-\x1f\x7f:*?"<>|]/.test(path)
    || path.split("/").some((part) => !part || part.startsWith(".") || /^(node_modules|metadata)$/i.test(part))) fail("资源必须使用安全相对路径");
  return path;
};
const unique = (items: unknown[], label: string) => { if (new Set(items).size !== items.length) fail(`${label} 重复`); };

const schemaKeys = new Set(VALUE_SCHEMA_RULES.keywords), schemaPropertyId = new RegExp(VALUE_SCHEMA_RULES.propertyNamePattern);
export function validateValueSchema(schema: unknown, depth = 0): ValueSchema {
  if (depth > 0 && depth <= VALUE_SCHEMA_RULES.limits.depth && plain(schema) && Reflect.ownKeys(schema).length === 0) return schema;
  if (depth > VALUE_SCHEMA_RULES.limits.depth || !plain(schema) || Object.keys(schema).some((key) => !schemaKeys.has(key))
    || !VALUE_SCHEMA_RULES.types.includes(schema.type as ValueKind)) fail("输入输出 schema 无效或含不支持的规则");
  if (schema.description !== undefined && (typeof schema.description !== "string" || schema.description.length > VALUE_SCHEMA_RULES.limits.descriptionLength)) fail("schema 描述无效");
  const allowed = new Set([...VALUE_SCHEMA_RULES.commonKeywords, ...VALUE_SCHEMA_RULES.applicable[schema.type as ValueKind]]);
  if (Object.keys(schema).some((key) => !allowed.has(key))) fail("schema 规则与数据类型不匹配");
  if (schema.type === "object") {
    if (!plain(schema.properties) || Object.keys(schema.properties).length > VALUE_SCHEMA_RULES.limits.properties || !isArray(schema.required)
      || schema.required.some((key) => typeof key !== "string" || !Object.hasOwn(schema.properties as object, key)) || schema.additionalProperties !== false) fail("对象 schema 必须明确字段、required 及 additionalProperties=false");
    unique(schema.required as unknown[], "required");
    for (const [key, child] of Object.entries(schema.properties as UnknownRecord)) {
      if (!schemaPropertyId.test(key) || VALUE_SCHEMA_RULES.forbiddenPropertyNames.includes(key)) fail("schema 属性名称无效");
      validateValueSchema(child, depth + 1);
    }
  } else if (schema.type === "array") validateValueSchema(schema.items, depth + 1);
  for (const key of VALUE_SCHEMA_RULES.lengthKeywords) { const value = schema[key]; if (value !== undefined && (!isInteger(value) || value < 0 || value > VALUE_SCHEMA_RULES.limits.lengthOrCount)) fail("schema 上下限无效"); }
  for (const key of VALUE_SCHEMA_RULES.numericKeywords) if (schema[key] !== undefined && (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))) fail("schema 数值边界无效");
  if (schema.enum !== undefined && (!isArray(schema.enum) || !schema.enum.length || schema.enum.length > VALUE_SCHEMA_RULES.limits.enumItems
    || schema.enum.some((value) => value !== null && !["string", "number", "boolean"].includes(typeof value)))) fail("schema enum 无效");
  for (const [minimum, maximum] of VALUE_SCHEMA_RULES.intervals) {
    if (schema[minimum!] !== undefined && schema[maximum!] !== undefined && (schema[minimum!] as number) > (schema[maximum!] as number)) fail("schema 最小值不能大于最大值");
  }
  if (isArray(schema.enum) && schema.enum.some((value) => schema.type === "null" ? value !== null : schema.type === "integer" ? !isInteger(value)
    : typeof value !== schema.type || typeof value === "number" && !Number.isFinite(value))) fail("enum 与 schema 类型不匹配");
  return schema as ValueSchema;
}

export function validateActionValue(value: unknown, schemaInput: unknown, path = "input"): JsonValue {
  const root = path === "output" ? "output" : "input";
  let schema: ValueSchema;
  try { schema = validateValueSchema(schemaInput); }
  catch (error) {
    if (root === "output" && error instanceof InputError) Object.assign(error, {
      reason: "output_contract_failed", statusCode: 500, validationIssue: { path: root, reason: "invalid_schema" },
    });
    throw error;
  }
  function reject(location: string, reason: string, message: string): never {
    throw Object.assign(new InputError(`应用契约无效：${location} ${message}`), {
      reason: root === "output" ? "output_contract_failed" : "input_contract_rejected",
      statusCode: root === "output" ? 500 : 400, validationIssue: { path: location, reason },
    });
  };
  let jsonNodes = 0;
  function checkJson(item: unknown, location: string, depth = 0): void {
    if (++jsonNodes > VALUE_SCHEMA_RULES.jsonValue.nodes || depth > VALUE_SCHEMA_RULES.jsonValue.depth) reject(location, "json_limit", "JSON数据超过深度或节点限制");
    if (item === null || typeof item === "string" || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) return;
    if (!item || typeof item !== "object" || !(isArray(item) ? Object.getPrototypeOf(item) === Array.prototype : plain(item))) reject(location, "invalid_type", "必须是普通JSON数据");
    const descriptors = Object.getOwnPropertyDescriptors(item), array = isArray(item), keys = Reflect.ownKeys(descriptors);
    if (keys.length > VALUE_SCHEMA_RULES.jsonValue.nodes - jsonNodes || keys.some((key) => typeof key !== "string")
      || array && keys.length !== (item as unknown[]).length + 1) reject(location, "invalid_structure", "JSON数据结构无效");
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (array && key === "length") continue;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value") || array && !/^(0|[1-9][0-9]*)$/.test(key)) reject(location, "invalid_structure", "JSON数据不能包含访问器或隐藏字段");
      checkJson(descriptor.value, array ? `${location}[${key}]` : `${location}[JSON]`, depth + 1);
    }
  }
  function check(item: unknown, definition: ValueSchema, location: string): void {
    if (Reflect.ownKeys(definition).length === 0) return checkJson(item, location);
    const type = definition.type;
    if (type === "object") {
      if (!plain(item)) reject(location, "invalid_type", "必须为对象");
      const missing = definition.required!.find((key) => !Object.hasOwn(item as object, key));
      if (missing !== undefined) reject(`${location}.${missing}`, "required_field", "缺少必填字段");
      if (Object.keys(item as object).some((key) => !Object.hasOwn(definition.properties!, key))) reject(location, "unknown_field", "对象字段不符合契约");
      for (const [key, child] of Object.entries(item as UnknownRecord)) check(child, definition.properties![key]!, `${location}.${key}`);
    } else if (type === "array") {
      if (!isArray(item)) reject(location, "invalid_type", "必须为数组");
      if (item.length < (definition.minItems ?? 0) || item.length > (definition.maxItems ?? 10000)) reject(location, "size_limit", "数组长度无效");
      item.forEach((child, index) => check(child, definition.items!, `${location}.${index}`));
    } else if (type === "null") { if (item !== null) reject(location, "invalid_type", "必须为 null"); }
    else if (type === "integer" ? !isInteger(item) : typeof item !== type) reject(location, "invalid_type", "类型无效");
    if (typeof item === "string") {
      let characters = 0;
      for (const character of item) { characters++; if (characters > (definition.maxLength ?? 1_000_000)) reject(location, "size_limit", "文本长度无效"); }
      if (characters < (definition.minLength ?? 0)) reject(location, "size_limit", "文本长度无效");
    }
    if (typeof item === "number" && (!Number.isFinite(item) || item < (definition.minimum ?? -Infinity) || item > (definition.maximum ?? Infinity))) reject(location, "invalid_value", "数值无效");
    if (definition.enum && !new Set<unknown>(definition.enum).has(item)) reject(location, "invalid_value", "取值无效");
  }
  check(value, schema, root);
  if (Buffer.byteLength(JSON.stringify(value)) > APPLICATION_ACTION_VALUE_BYTES) reject(root, "channel_limit", "超过通道限制，请通过文件引用传递");
  return structuredClone(value) as JsonValue;
}
export const validateActionInput = (action: { inputSchema: unknown }, value: unknown) => validateActionValue(value, action.inputSchema, "input");
export const validateActionOutput = (action: { outputSchema: unknown }, value: unknown) => validateActionValue(value, action.outputSchema, "output");

export function validateApplicationManifest(value: unknown, { snapshot, allowUnverified = false }: { snapshot?: ApplicationSnapshot; allowUnverified?: boolean } = {}): ApplicationManifest {
  const managed = plain(value) && value.protocolVersion === 3;
  fields(value, ["protocolVersion", "runtime", "entrypoint", "page", "actions", "stateVersion", "evidenceIds", ...(managed ? ["service"] : [])], "manifest");
  if (!(managed ? value.runtime === "managed-service" : value.protocolVersion === 2 && value.runtime === "node-action")
    || !isInteger(value.stateVersion) || value.stateVersion < 1) fail("协议或状态版本无效");
  const entrypoint = safePath(value.entrypoint);
  // The unchanged service validator is the M5 boundary; only these checked fields are consumed here.
  const service: { entrypoint: string; dataVersion: number; operations: { id: string; visibility?: string; inputSchema: unknown; outputSchema: unknown; connectionIds?: string[] }[] } | null = managed ? validateServiceManifest(value.service) : null;
  if (managed ? service!.entrypoint !== value.entrypoint : !/\.(mjs|js)$/.test(entrypoint)) fail("后端入口与运行协议不一致");
  const files = snapshot ? new Map(snapshot.files.map((file) => [file.path, file])) : null;
  if (files && !files.has(entrypoint)) fail("后端入口不在验收快照中");
  if (value.page !== null) {
    fields(value.page, ["entrypoint", "resources"], "page"); safePath(value.page.entrypoint);
    if (!/\.html$/.test(value.page.entrypoint as string) || !isArray(value.page.resources) || !value.page.resources.length || value.page.resources.length > 200) fail("页面入口或资源数量无效");
    for (const resource of value.page.resources) {
      fields(resource, ["path", "sha256"], "resource"); safePath(resource.path);
      if (!/\.(html|css|js|mjs|png|jpe?g|webp|gif|svg|ico|woff2?)$/i.test(resource.path as string) || resource.path === value.entrypoint) fail("页面资源类型无效或包含后端入口");
      if (typeof resource.sha256 !== "string" || !hash.test(resource.sha256) && !(allowUnverified && resource.sha256 === "")) fail("资源缺少摘要");
      if (files && (!files.has(resource.path as string) || (!allowUnverified && files.get(resource.path as string)!.hash !== resource.sha256))) fail("资源与验收快照不匹配");
    }
    unique(value.page.resources.map((resource) => (resource as UnknownRecord).path), "资源路径");
    if (!value.page.resources.some((resource) => (resource as UnknownRecord).path === (value.page as UnknownRecord).entrypoint)) fail("页面入口未列入资源清单");
  }
  if (!isArray(value.actions) || (!value.actions.length && value.page === null) || value.actions.length > 80) fail("动作清单无效");
  for (const action of value.actions) {
    fields(action, ["id", "title", "inputSchema", "outputSchema", "connectionIds"], "action");
    if (typeof action.id !== "string" || !id.test(action.id) || ["__proto__", "constructor", "prototype"].includes(action.id as string) || typeof action.title !== "string" || !action.title.trim() || action.title.length > 200) fail("动作标识或名称无效");
    validateValueSchema(action.inputSchema); validateValueSchema(action.outputSchema);
    if (!isArray(action.connectionIds) || action.connectionIds.length > 40 || action.connectionIds.some((key) => typeof key !== "string" || !id.test(key))) fail("动作连接依赖无效");
    unique(action.connectionIds as unknown[], "连接依赖");
  }
  unique(value.actions.map((action) => (action as UnknownRecord).id), "动作标识");
  const actions = value.actions as ApplicationAction[];
  const publicOperations = service?.operations.filter((operation) => operation.visibility !== "internal");
  if (service && service.dataVersion !== value.stateVersion) fail("服务数据版本与应用状态版本必须一致");
  if (service && (publicOperations!.length !== value.actions.length || publicOperations!.some((operation) => {
    const action = actions.find((item) => item.id === operation.id);
    return !action || !isDeepStrictEqual(action.inputSchema, operation.inputSchema) || !isDeepStrictEqual(action.outputSchema, operation.outputSchema)
      || !isDeepStrictEqual([...action.connectionIds].sort(), [...(operation.connectionIds ?? [])].sort());
  }))) fail("服务动作与应用公开契约不一致");
  if (!isArray(value.evidenceIds) || (!allowUnverified && !value.evidenceIds.length) || value.evidenceIds.length > 200
    || value.evidenceIds.some((item) => typeof item !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(item))) fail("验收证据引用无效");
  unique(value.evidenceIds, "验收证据");
  return structuredClone(value) as ApplicationManifest;
}

export function bindApplicationManifest(value: unknown, snapshot: ApplicationSnapshot, evidenceIds: string[]) {
  const manifest = validateApplicationManifest(value, { snapshot, allowUnverified: true });
  const files = new Map(snapshot.files.map((file) => [file.path, file]));
  if (manifest.page) manifest.page.resources = manifest.page.resources.map(({ path }) => ({ path, sha256: files.get(path)!.hash }));
  manifest.evidenceIds = [...evidenceIds];
  return validateApplicationManifest(manifest, { snapshot });
}
