import { InputError } from "../requirements/core.mjs";
import { isDeepStrictEqual } from "node:util";
import { validateServiceManifest } from "../services/service-contract.mjs";

export const APPLICATION_PROTOCOL_VERSION = 2;
const id = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const hash = /^[a-f0-9]{64}$/;
const fail = (message) => { throw new InputError(`应用契约无效：${message}`); };
const plain = (value) => value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fields = (value, keys, label) => {
  if (!plain(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) fail(`${label} 字段无效`);
};
const safePath = (path) => {
  if (typeof path !== "string" || path.length > 500 || !path || path.trim() !== path || /[\\\x00-\x1f\x7f:*?"<>|]/.test(path)
    || path.split("/").some((part) => !part || part.startsWith(".") || /^(node_modules|metadata)$/i.test(part))) fail("资源必须使用安全相对路径");
  return path;
};
const unique = (items, label) => { if (new Set(items).size !== items.length) fail(`${label} 重复`); };

const schemaKeys = new Set(["type", "description", "properties", "required", "additionalProperties", "items", "enum", "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems"]);
export function validateValueSchema(schema, depth = 0) {
  if (depth > 12 || !plain(schema) || Object.keys(schema).some((key) => !schemaKeys.has(key))
    || !["object", "array", "string", "number", "integer", "boolean", "null"].includes(schema.type)) fail("输入输出 schema 无效或含不支持的规则");
  if (schema.description !== undefined && (typeof schema.description !== "string" || schema.description.length > 2000)) fail("schema 描述无效");
  const applicable = { object: ["properties", "required", "additionalProperties"], array: ["items", "minItems", "maxItems"],
    string: ["minLength", "maxLength"], number: ["minimum", "maximum"], integer: ["minimum", "maximum"], boolean: [], null: [] };
  const allowed = new Set(["type", "description", "enum", ...applicable[schema.type]]);
  if (Object.keys(schema).some((key) => !allowed.has(key))) fail("schema 规则与数据类型不匹配");
  if (schema.type === "object") {
    if (!plain(schema.properties) || Object.keys(schema.properties).length > 100 || !Array.isArray(schema.required)
      || schema.required.some((key) => typeof key !== "string" || !Object.hasOwn(schema.properties, key)) || schema.additionalProperties !== false) fail("对象 schema 必须明确字段、required 及 additionalProperties=false");
    unique(schema.required, "required");
    for (const [key, child] of Object.entries(schema.properties)) {
      if (!id.test(key) || ["__proto__", "prototype", "constructor"].includes(key)) fail("schema 属性名称无效");
      validateValueSchema(child, depth + 1);
    }
  } else if (schema.type === "array") validateValueSchema(schema.items, depth + 1);
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"]) if (schema[key] !== undefined && (!Number.isSafeInteger(schema[key]) || schema[key] < 0 || schema[key] > 1_000_000)) fail("schema 上下限无效");
  for (const key of ["minimum", "maximum"]) if (schema[key] !== undefined && (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))) fail("schema 数值边界无效");
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.length > 100
    || schema.enum.some((value) => value !== null && !["string", "number", "boolean"].includes(typeof value)))) fail("schema enum 无效");
  for (const [minimum, maximum] of [["minLength", "maxLength"], ["minItems", "maxItems"], ["minimum", "maximum"]]) {
    if (schema[minimum] !== undefined && schema[maximum] !== undefined && schema[minimum] > schema[maximum]) fail("schema 最小值不能大于最大值");
  }
  if (schema.enum && schema.enum.some((value) => schema.type === "null" ? value !== null : schema.type === "integer" ? !Number.isSafeInteger(value)
    : typeof value !== schema.type || typeof value === "number" && !Number.isFinite(value))) fail("enum 与 schema 类型不匹配");
  return schema;
}

export function validateActionValue(value, schema, path = "input") {
  validateValueSchema(schema);
  function check(item, definition, location) {
    const type = definition.type;
    if (type === "object") {
      if (!plain(item) || definition.required.some((key) => !Object.hasOwn(item, key)) || Object.keys(item).some((key) => !Object.hasOwn(definition.properties, key))) fail(`${location} 对象字段不符合契约`);
      for (const [key, child] of Object.entries(item)) check(child, definition.properties[key], `${location}.${key}`);
    } else if (type === "array") {
      if (!Array.isArray(item) || item.length < (definition.minItems ?? 0) || item.length > (definition.maxItems ?? 10000)) fail(`${location} 数组无效`);
      item.forEach((child, index) => check(child, definition.items, `${location}.${index}`));
    } else if (type === "null") { if (item !== null) fail(`${location} 必须为 null`); }
    else if (type === "integer" ? !Number.isSafeInteger(item) : typeof item !== type) fail(`${location} 类型无效`);
    if (typeof item === "string" && (item.includes("\0") || item.length < (definition.minLength ?? 0) || item.length > (definition.maxLength ?? 1_000_000))) fail(`${location} 文本长度无效`);
    if (typeof item === "number" && (!Number.isFinite(item) || item < (definition.minimum ?? -Infinity) || item > (definition.maximum ?? Infinity))) fail(`${location} 数值无效`);
    if (definition.enum && !definition.enum.includes(item)) fail(`${location} 取值无效`);
  }
  check(value, schema, path);
  if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) fail(`${path} 超过通道限制，请通过文件引用传递`);
  return structuredClone(value);
}
export const validateActionInput = (action, value) => validateActionValue(value, action.inputSchema, "input");
export const validateActionOutput = (action, value) => validateActionValue(value, action.outputSchema, "output");

export function validateApplicationManifest(value, { snapshot, allowUnverified = false } = {}) {
  const managed = value?.protocolVersion === 3;
  fields(value, ["protocolVersion", "runtime", "entrypoint", "page", "actions", "stateVersion", "evidenceIds", ...(managed ? ["service"] : [])], "manifest");
  if (!(managed ? value.runtime === "managed-service" : value.protocolVersion === 2 && value.runtime === "node-action")
    || !Number.isSafeInteger(value.stateVersion) || value.stateVersion < 1) fail("协议或状态版本无效");
  safePath(value.entrypoint);
  const service = managed ? validateServiceManifest(value.service) : null;
  if (managed ? service.entrypoint !== value.entrypoint : !/\.(mjs|js)$/.test(value.entrypoint)) fail("后端入口与运行协议不一致");
  const files = snapshot ? new Map(snapshot.files.map((file) => [file.path, file])) : null;
  if (files && !files.has(value.entrypoint)) fail("后端入口不在验收快照中");
  if (value.page !== null) {
    fields(value.page, ["entrypoint", "resources"], "page"); safePath(value.page.entrypoint);
    if (!/\.html$/.test(value.page.entrypoint) || !Array.isArray(value.page.resources) || !value.page.resources.length || value.page.resources.length > 200) fail("页面入口或资源数量无效");
    for (const resource of value.page.resources) {
      fields(resource, ["path", "sha256"], "resource"); safePath(resource.path);
      if (!/\.(html|css|js|mjs|png|jpe?g|webp|gif|svg|ico|woff2?)$/i.test(resource.path) || resource.path === value.entrypoint) fail("页面资源类型无效或包含后端入口");
      if (!hash.test(resource.sha256) && !(allowUnverified && resource.sha256 === "")) fail("资源缺少摘要");
      if (files && (!files.has(resource.path) || (!allowUnverified && files.get(resource.path).hash !== resource.sha256))) fail("资源与验收快照不匹配");
    }
    unique(value.page.resources.map((resource) => resource.path), "资源路径");
    if (!value.page.resources.some((resource) => resource.path === value.page.entrypoint)) fail("页面入口未列入资源清单");
  }
  if (!Array.isArray(value.actions) || (!value.actions.length && value.page === null) || value.actions.length > 80) fail("动作清单无效");
  for (const action of value.actions) {
    fields(action, ["id", "title", "inputSchema", "outputSchema", "connectionIds"], "action");
    if (!id.test(action.id) || ["__proto__", "constructor", "prototype"].includes(action.id) || typeof action.title !== "string" || !action.title.trim() || action.title.length > 200) fail("动作标识或名称无效");
    validateValueSchema(action.inputSchema); validateValueSchema(action.outputSchema);
    if (!Array.isArray(action.connectionIds) || action.connectionIds.length > 40 || action.connectionIds.some((key) => !id.test(key))) fail("动作连接依赖无效");
    unique(action.connectionIds, "连接依赖");
  }
  unique(value.actions.map((action) => action.id), "动作标识");
  const publicOperations = service?.operations.filter((operation) => operation.visibility !== "internal");
  if (service && service.dataVersion !== value.stateVersion) fail("服务数据版本与应用状态版本必须一致");
  if (service && (publicOperations.length !== value.actions.length || publicOperations.some((operation) => {
    const action = value.actions.find((item) => item.id === operation.id);
    return !action || !isDeepStrictEqual(action.inputSchema, operation.inputSchema) || !isDeepStrictEqual(action.outputSchema, operation.outputSchema)
      || !isDeepStrictEqual([...action.connectionIds].sort(), [...(operation.connectionIds ?? [])].sort());
  }))) fail("服务动作与应用公开契约不一致");
  if (!Array.isArray(value.evidenceIds) || (!allowUnverified && !value.evidenceIds.length) || value.evidenceIds.length > 200
    || value.evidenceIds.some((item) => typeof item !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(item))) fail("验收证据引用无效");
  unique(value.evidenceIds, "验收证据");
  return structuredClone(value);
}

export function bindApplicationManifest(value, snapshot, evidenceIds) {
  const manifest = validateApplicationManifest(value, { snapshot, allowUnverified: true });
  const files = new Map(snapshot.files.map((file) => [file.path, file]));
  if (manifest.page) manifest.page.resources = manifest.page.resources.map(({ path }) => ({ path, sha256: files.get(path).hash }));
  manifest.evidenceIds = [...evidenceIds];
  return validateApplicationManifest(manifest, { snapshot });
}
