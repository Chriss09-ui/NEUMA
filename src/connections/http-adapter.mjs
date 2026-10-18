import Ajv from "ajv";

const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });
const fail = (reason, message) => Object.assign(new Error(message), { reason });
const forbiddenHeaders = /^(?:authorization|host|content-length|connection|transfer-encoding|cookie|set-cookie|origin|referer|proxy-.*)$/i;
export function validateSchema(schema, value, reason = "invalid_input") {
  if (!schema) return;
  let valid;
  try { valid = ajv.compile(schema)(value); } catch { throw fail("invalid_operation", "已设计的接口数据格式无效，请重新检查方案"); }
  if (!valid) throw fail(reason, reason === "invalid_response" ? "接口返回内容不符合已设计的数据格式" : "输入内容不符合已设计的数据格式");
}
export function connectionHeaders(connection) {
  return connection.authType === "bearer" || connection.authType === "oauth" ? { authorization: `Bearer ${connection.secret}` }
    : connection.authType === "header" ? { [connection.headerName]: connection.secret }
      : connection.authType === "basic" ? { authorization: `Basic ${Buffer.from(`${connection.username}:${connection.secret}`).toString("base64")}` } : {};
}
function pick(input, mapping) {
  if (typeof mapping === "string") {
    let value = input;
    for (const key of mapping.split(".")) {
      if (["__proto__", "prototype", "constructor"].includes(key) || !value || !Object.hasOwn(value, key)) return undefined;
      value = value[key];
    }
    return value;
  }
  if (mapping && Object.hasOwn(mapping, "literal")) return mapping.literal;
  if (mapping && typeof mapping.from === "string") return pick(input, mapping.from);
  return undefined;
}
function mapped(input, mappings, connection, allowCredential = false) {
  if (!mappings) return {};
  return Object.fromEntries(Object.entries(mappings).map(([key, from]) => {
    if (from?.credential && !allowCredential) throw fail("invalid_operation", "专属凭据只能注入已评审的请求头");
    return [key, from?.config ? connection.values?.[from.config] : from?.credential ? connection.secretValues?.[from.credential] : pick(input, from)];
  }).filter(([, value]) => value !== undefined));
}
const scalar = (value) => {
  if (value !== null && !["string", "number", "boolean"].includes(typeof value)) throw fail("invalid_input", "接口参数需要文本、数字或布尔值");
  return String(value ?? "");
};
export async function readResponse(response, { maxBytes = 20 * 1024 * 1024, signal } = {}) {
  if (response.status >= 300 && response.status < 400) throw fail("redirect_rejected", "连接接口发生重定向，已停止发送认证信息");
  if (!response.ok) throw Object.assign(fail([401, 403].includes(response.status) ? "authentication_failed" : response.status === 429 ? "rate_limited" : "service_failed", `接口返回 HTTP ${response.status}，未完成调用`), { httpStatus: response.status });
  const reader = response.body?.getReader(); if (!reader) return null;
  const parts = []; let size = 0;
  try {
    while (true) { signal?.throwIfAborted(); const { done, value } = await reader.read(); if (done) break; size += value.byteLength;
      if (size > maxBytes) throw fail("response_limit", "接口结果超过单次接收上限"); parts.push(Buffer.from(value)); }
  } finally { await reader.cancel().catch(() => {}); }
  if (!size) return null;
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { throw fail("invalid_response", "接口未返回有效 JSON 数据"); }
}
export async function httpCall(connection, operation, input, { fetchImpl = fetch, signal, resolveFile } = {}) {
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(operation.method)) throw fail("invalid_operation", "接口方法不受支持");
  validateSchema(operation.inputSchema, input);
  let path = operation.path;
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || /[\\?#]|(?:^|\/)\.\.(?:\/|$)|%2e|%2f|%5c/i.test(path)) throw fail("invalid_operation", "业务动作必须使用已设计的相对路径");
  path = path.replace(/\{([A-Za-z][\w.-]*)\}/g, (_, key) => {
    const mapping = operation.request?.path?.[key] ?? key;
    const value = scalar(mapping?.config ? connection.values?.[mapping.config] : pick(input, mapping));
    if (!value || value === "." || value === ".." || /[\\/\0]|%2e|%2f|%5c/i.test(value)) throw fail("invalid_input", "接口路径参数未填写或无效");
    return encodeURIComponent(value);
  });
  if (/[{}]/.test(path)) throw fail("invalid_operation", "接口路径模板无效");
  const url = new URL(connection.baseUrl), baseOrigin = url.origin;
  url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`;
  if (url.origin !== baseOrigin) throw fail("invalid_operation", "接口来源不可由运行参数修改");
  const request = operation.request, query = request?.query ? mapped(input, request.query, connection) : operation.method === "GET" ? input : {};
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, scalar(value));
  const headers = { accept: "application/json", ...connectionHeaders(connection) };
  for (const [key, value] of Object.entries(mapped(input, request?.headers, connection, true))) {
    if (!/^[A-Za-z][A-Za-z0-9-]{0,79}$/.test(key) || forbiddenHeaders.test(key) || key.toLowerCase() === connection.headerName?.toLowerCase()) throw fail("invalid_operation", "接口参数不能覆盖认证或传输请求头");
    const text = scalar(value); if (/[\r\n\0]/.test(text)) throw fail("invalid_input", "请求头格式无效"); headers[key] = text;
  }
  let body;
  if (!["GET", "HEAD"].includes(operation.method)) {
    const values = request?.bodyFrom ? pick(input, request.bodyFrom) : request?.body ? mapped(input, request.body, connection) : input;
    if (request?.encoding === "form") { body = new URLSearchParams(Object.entries(values).map(([key, value]) => [key, scalar(value)])); headers["content-type"] = "application/x-www-form-urlencoded"; }
    else if (request?.encoding === "multipart") {
      body = new FormData();
      for (const [key, value] of Object.entries(values)) {
        if (value && typeof value === "object" && typeof value.fileRef === "string") {
          if (!resolveFile) throw fail("file_access_unavailable", "当前调用尚未提供已授权的材料或产物读取入口");
          const file = await resolveFile(value.fileRef, { signal });
          if (!file || !Buffer.isBuffer(file.data) || file.data.length > 20 * 1024 * 1024) throw fail("invalid_file", "上传材料不可用或超过大小上限");
          body.append(key, new Blob([file.data], { type: file.contentType || "application/octet-stream" }), file.name || "material");
        } else body.append(key, scalar(value));
      }
    } else { body = JSON.stringify(values); headers["content-type"] = "application/json"; }
  }
  const timeout = Math.min(600000, Math.max(1000, operation.timeoutMs ?? 60000));
  const active = AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
  let response;
  try { response = await fetchImpl(url.href, { method: operation.method, headers, ...(body === undefined ? {} : { body }), redirect: "manual", signal: active }); }
  catch { if (active.aborted) throw active.reason; throw fail("network_failed", "连接服务失败，请检查接口地址及网络"); }
  const result = await readResponse(response, { signal: active }); validateSchema(operation.outputSchema, result, "invalid_response");
  return result;
}

export function importOpenApi(document) {
  if (!document || !/^3\./.test(document.openapi ?? "") || !document.paths) throw fail("invalid_specification", "需要有效的 OpenAPI 3 接口说明");
  const expand = (value, depth = 0, seen = new Set()) => {
    if (depth > 30) throw fail("invalid_specification", "接口说明引用过深，请提供独立的操作定义");
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => expand(item, depth + 1, seen));
    if (value.$ref) {
      if (typeof value.$ref !== "string" || !value.$ref.startsWith("#/") || seen.has(value.$ref)) throw fail("invalid_specification", "请提供没有远端或循环引用的接口说明");
      let referenced = document;
      for (const part of value.$ref.slice(2).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))) {
        if (!referenced || !Object.hasOwn(referenced, part) || ["__proto__", "prototype", "constructor"].includes(part)) throw fail("invalid_specification", "接口说明存在无效引用"); referenced = referenced[part];
      }
      return expand(referenced, depth + 1, new Set([...seen, value.$ref]));
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item, depth + 1, seen)]));
  };
  const operations = [];
  for (const [path, rawMethods] of Object.entries(document.paths)) for (const [method, operation] of Object.entries(expand(rawMethods))) {
    if (!["get", "post", "put", "patch", "delete", "head", "options"].includes(method)) continue;
    const parameters = [...expand(rawMethods.parameters ?? []), ...(operation.parameters ?? [])], properties = {}, required = [], request = { path: {}, query: {}, headers: {} };
    for (const parameter of parameters) {
      if (!parameter.name || !["path", "query", "header"].includes(parameter.in) || parameter.$ref) continue;
      properties[parameter.name] = parameter.schema ?? {}; if (parameter.required) required.push(parameter.name);
      request[parameter.in === "header" ? "headers" : parameter.in][parameter.name] = parameter.name;
    }
    const body = operation.requestBody?.content?.["application/json"]?.schema;
    if (body) { properties.body = body; request.bodyFrom = "body"; }
    operations.push({ id: operation.operationId ?? `operation_${operations.length + 1}`, method: method.toUpperCase(), path,
      description: operation.summary ?? operation.description ?? path, inputSchema: { type: "object", properties, required },
      outputSchema: operation.responses?.["200"]?.content?.["application/json"]?.schema,
      request, safeTest: false, readOnly: ["get", "head"].includes(method) });
  }
  return { operations, requiresReview: true };
}
