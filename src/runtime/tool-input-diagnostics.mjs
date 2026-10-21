import Ajv from "ajv";

const ajv = new Ajv({ strict: false, allErrors: true, coerceTypes: false, verbose: true });
const validators = new WeakMap();
const types = new Set(["object", "array", "string", "boolean", "number", "integer", "null"]);
const remedies = Object.freeze({
  required: "补齐这个已声明的必填字段。", additionalProperties: "该对象只保留allowedFields列出的字段；不要重复提交未修改的参数。",
  type: "按expectedType填写；receivedType是本次实际类型，不要把对象、数组或布尔值编码成字符串。",
  enum: "使用allowedValues列出的当前允许值。", const: "使用allowedValues列出的当前固定值。",
  pattern: "按工具声明的字段格式填写。", uniqueItems: "移除该数组中的重复项，保留必要内容。",
  anyOf: "选择alternatives中的一种完整写法，不要混合不同写法的字段。",
  oneOf: "必须且只能符合alternatives中的一种完整写法，不要混合不同写法的字段。",
});
const bounds = new Set(["minLength", "maxLength", "minItems", "maxItems", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minProperties", "maxProperties", "multipleOf"]);
const safeField = value => typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(value)
  && !["__proto__", "prototype", "constructor"].includes(value);
const safeAllowed = value => value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)
  || typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(value);
const valueType = value => value === undefined ? "missing" : value === null ? "null" : Array.isArray(value) ? "array"
  : ["string", "boolean", "number", "object"].includes(typeof value) ? typeof value : "other";
const tokens = pointer => pointer.split("/").slice(1).map(part => part.replaceAll("~1", "/").replaceAll("~0", "~"));

function at(value, parts) {
  for (const part of parts) {
    if (!value || typeof value !== "object") return { type: "missing" };
    const descriptor = Object.getOwnPropertyDescriptor(value, part);
    if (!descriptor) return { type: "missing" };
    if (!Object.hasOwn(descriptor, "value")) return { type: "accessor" };
    value = descriptor.value;
  }
  return { type: valueType(value), value };
}

function branches(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 12) return [];
  return [schema, ...[...schema.anyOf ?? [], ...schema.oneOf ?? [], ...schema.allOf ?? [], schema.then, schema.else]
    .flatMap(branch => branches(branch, depth + 1))];
}

function declaredPath(schema, instancePath, missing) {
  let current = [schema], path = "";
  const parts = [];
  for (const part of [...tokens(instancePath), ...(typeof missing === "string" ? [missing] : [])]) {
    const choices = current.flatMap(entry => branches(entry));
    const arrays = choices.filter(entry => entry.type === "array" && entry.items);
    if (arrays.length && /^(0|[1-9][0-9]{0,5})$/.test(part)) {
      path += `[${part}]`; current = arrays.map(entry => entry.items);
    } else {
      if (!safeField(part)) break;
      const next = choices.flatMap(entry => Object.hasOwn(entry.properties ?? {}, part) ? [entry.properties[part]] : []);
      if (!next.length) break;
      path += `${path ? "." : ""}${part}`; current = next;
    }
    parts.push(part);
  }
  return { path, parts };
}

function fields(schema) {
  const properties = schema?.properties ?? {}, allowed = Object.keys(properties).filter(safeField);
  const required = (schema?.required ?? []).filter(field => safeField(field) && Object.hasOwn(properties, field));
  return { allowedFields: allowed.slice(0, 32), requiredFields: required.slice(0, 32),
    ...(allowed.length > 32 || Object.keys(properties).length > allowed.length ? { allowedFieldsTruncated: true } : {}),
    ...(required.length > 32 || (schema?.required?.length ?? 0) > required.length ? { requiredFieldsTruncated: true } : {}) };
}

function typeHint(schema) {
  const allowed = (Array.isArray(schema?.type) ? schema.type : [schema?.type]).filter(type => types.has(type));
  return allowed.length === 1 ? { expectedType: allowed[0] } : allowed.length ? { expectedTypes: allowed } : {};
}

function choiceHint(schema, detailed = false) {
  const values = (Object.hasOwn(schema ?? {}, "const") ? [schema.const] : schema?.enum ?? []).filter(safeAllowed);
  return { ...typeHint(schema), ...(schema?.properties ? fields(schema) : {}),
    ...(detailed && schema?.properties ? { fields: Object.entries(schema.properties).filter(([field]) => safeField(field)).slice(0, 8)
      .map(([field, property]) => ({ field, ...choiceHint(property) })),
    ...(Object.keys(schema.properties).length > 8 ? { fieldsTruncated: true } : {}) } : {}),
    ...(values.length ? { allowedValues: values.slice(0, 16), ...(values.length > 16 ? { allowedValuesTruncated: true } : {}) } : {}) };
}

// AJV reports every failed alternative. Prefer the branch matching the submitted shape,
// so a malformed short reference is not told to add fields from the detailed format.
function relevantErrors(errors) {
  const omitted = new Set(), hints = new Map();
  for (const union of errors.filter(error => ["anyOf", "oneOf"].includes(error.keyword)).sort((a, b) => a.schemaPath.length - b.schemaPath.length)) {
    if (omitted.has(union)) continue;
    const within = error => error.instancePath === union.instancePath || error.instancePath.startsWith(union.instancePath + "/");
    const options = union.parentSchema[union.keyword];
    const discriminatorCounts = new Map();
    for (const option of options) for (const field of new Set(branches(option).flatMap(branch => Object.entries(branch.properties ?? {})
      .filter(([, property]) => Object.hasOwn(property, "const") || Array.isArray(property.enum)).map(([field]) => field))))
      discriminatorCounts.set(field, (discriminatorCounts.get(field) ?? 0) + 1);
    const scored = options.map((schema, index) => {
      const prefix = `${union.schemaPath}/${index}/`, own = errors.filter(error => within(error) && error.schemaPath.startsWith(prefix));
      const score = [0, 0, 0, 0, 0];
      for (const error of own) {
        const direct = error.instancePath === union.instancePath;
        const path = tokens(error.instancePath);
        const discriminator = ["const", "enum"].includes(error.keyword) && path.length === tokens(union.instancePath).length + 1
          && discriminatorCounts.get(path.at(-1)) > 1;
        score[direct && error.keyword === "type" ? 0 : discriminator ? 1
          : direct && error.keyword === "additionalProperties" ? 2 : direct && error.keyword === "required" ? 3 : 4]++;
      }
      return { schema, prefix, score };
    });
    const compare = (left, right) => { for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return left[index] - right[index]; return 0; };
    const best = scored.reduce((left, right) => compare(left.score, right.score) <= 0 ? left : right).score;
    const selected = scored.filter(option => compare(option.score, best) === 0);
    if (selected.length === 1) {
      omitted.add(union);
      for (const error of errors) if (within(error) && scored.some(option => option !== selected[0] && error.schemaPath.startsWith(option.prefix))) omitted.add(error);
    } else {
      for (const error of errors) if (within(error) && scored.some(option => error.schemaPath.startsWith(option.prefix))) omitted.add(error);
      hints.set(union, selected.slice(0, 4).map(option => choiceHint(option.schema, true)));
    }
  }
  return { errors: errors.filter(error => !omitted.has(error) && error.keyword !== "if"), hints };
}

/** Strict, value-free diagnostics derived from the actual registered tool schema. */
export function toolInputValidation(value, schema, { root = "root", limit = 12 } = {}) {
  if (typeof root !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]{0,119}$/.test(root) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new TypeError("工具参数诊断选项无效");
  let validate = validators.get(schema);
  if (!validate) { validate = ajv.compile(schema); validators.set(schema, validate); }
  if (validate(value)) return { valid: true, issues: [] };
  const selected = relevantErrors(validate.errors), issues = [], seen = new Set();
  let total = 0, retainedCharacters = 0;
  for (const error of selected.errors) {
    const location = declaredPath(schema, error.instancePath, error.params?.missingProperty);
    const target = error.keyword === "required" ? error.parentSchema.properties?.[error.params.missingProperty] : error.parentSchema;
    const constraint = bounds.has(error.keyword) && typeof error.parentSchema[error.keyword] === "number" && Number.isFinite(error.parentSchema[error.keyword])
      ? { [error.keyword]: error.parentSchema[error.keyword] } : undefined;
    const entry = { path: root + (location.path ? (location.path.startsWith("[") ? "" : ".") + location.path : ""),
      reason: error.keyword, remedy: remedies[error.keyword] ?? (constraint ? "按constraints中的具体上下限修正该字段，保留必要要求。" : "按当前工具声明修正该字段，再提交修改后的参数。"),
      receivedType: at(value, location.parts).type, ...typeHint(target),
      ...(error.keyword === "type" ? typeHint({ type: error.params.type }) : {}),
      ...(["enum", "const"].includes(error.keyword) ? choiceHint(target) : {}),
      ...(error.keyword === "additionalProperties" ? fields(error.parentSchema) : {}),
      ...(constraint ? { constraints: constraint } : {}),
      ...(selected.hints.has(error) ? { alternatives: selected.hints.get(error), alternativesTruncated: error.parentSchema[error.keyword].length > 4 } : {}) };
    const key = JSON.stringify(entry);
    if (seen.has(key)) continue;
    seen.add(key); total++;
    // Leave room for the controller's budget and domain-specific hints below Pi's 16k ceiling.
    const compact = () => {
      const trim = hint => {
        for (const key of ["allowedFields", "requiredFields", "fields", "allowedValues"])
          if (hint[key]?.length > 4) { hint[key] = hint[key].slice(0, 4); hint[`${key}Truncated`] = true; }
        for (const child of [...hint.alternatives ?? [], ...hint.fields ?? []]) trim(child);
      };
      trim(entry);
    };
    if (JSON.stringify(entry).length > 10000) compact();
    if (JSON.stringify(entry).length > 10000) for (const alternative of entry.alternatives ?? []) {
      if (alternative.fields) { delete alternative.fields; alternative.fieldsTruncated = true; }
    }
    const characters = JSON.stringify(entry).length;
    if (issues.length < limit && retainedCharacters + characters <= 12000) { issues.push(entry); retainedCharacters += characters; }
  }
  if (!total) { total = 1; issues.push({ path: root, reason: "invalid_contract", remedy: "核对当前工具公开结构后修正参数。", receivedType: valueType(value) }); }
  return { valid: false, issues, total, retained: issues.length, truncated: total > issues.length };
}
