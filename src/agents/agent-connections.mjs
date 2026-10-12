import { randomUUID } from "node:crypto";
import { InputError } from "../requirements/core.mjs";
import { AgentStorage, agentId } from "./agent-storage.mjs";
import { connectionJsonRequest } from "../runtime/web-capabilities.mjs";

const FILE = "private/connections.json", MAX_RECORD = 1024 * 1024;
const fail = (reason, message) => Object.assign(new InputError(message), { reason, ...(reason === "connection_conflict" ? { statusCode: 409 } : {}) });
const idValue = (value) => {
  if (typeof value !== "string" || !/^[\w-]{1,80}$/.test(value) || Object.hasOwn(Object.prototype, value)) throw fail("invalid_connection", "连接标识无效");
  return value;
};
const redacted = (value) => ({ id: value.id, kind: value.kind, provider: value.provider, baseUrl: value.baseUrl,
  model: value.model, authType: value.authType, headerName: value.headerName, allowFallback: value.allowFallback,
  configured: true, hasSecret: Boolean(value.secret), status: value.status, version: value.version, updatedAt: value.updatedAt,
  testedAt: value.testedAt ?? null, reason: value.reason ?? null });

function requirementsView(requirements) {
  return (Array.isArray(requirements) ? requirements : []).map((item) => ({ id: item.id,
    kind: item.kind ?? item.purpose, label: item.label ?? ({ search: "专属搜索", model: "专属模型", business: "业务接口" }[item.kind ?? item.purpose] ?? "专属连接"), required: item.required === true, description: item.description ?? "" }));
}

function endpoint(value, kind) {
  let url;
  try { url = new URL(value); } catch { throw fail("invalid_connection", "请填写有效的 HTTP(S) 接口地址"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || value.length > 2048)
    throw fail("invalid_connection", "接口地址不能包含认证信息、查询参数或片段");
  if (kind === "model" && !url.pathname.endsWith("/chat/completions")) url.pathname = `${url.pathname.replace(/\/$/, "")}/chat/completions`;
  return url.href;
}

function config(input, previous) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw fail("invalid_connection", "连接配置无效");
  const id = idValue(input.id), kind = input.kind ?? previous?.kind;
  if (!["search", "model", "business"].includes(kind)) throw fail("invalid_connection", "请选择搜索、模型或业务连接");
  const provider = input.provider ?? previous?.provider ?? ({ model: "openai-compatible", business: "http-json" })[kind];
  if (!(kind === "search" ? ["tavily", "exa"] : kind === "model" ? ["openai-compatible"] : ["http-json"]).includes(provider))
    throw fail("invalid_connection", "这个连接类型暂不支持所选服务");
  const authType = kind === "search" ? "bearer" : input.authType ?? previous?.authType ?? "bearer";
  if (!["none", "bearer", "header"].includes(authType) || kind === "model" && authType === "header")
    throw fail("invalid_connection", "认证方式无效；专属模型使用匿名或 Bearer 认证");
  let secret = typeof input.secret === "string" && input.secret.trim() ? input.secret.trim() : previous?.secret ?? "";
  if (typeof input.secret !== "undefined" && typeof input.secret !== "string" || secret.length > 8192 || /[\r\n\0]/.test(secret))
    throw fail("invalid_connection", "认证信息格式无效");
  if (previous && (kind !== previous.kind || provider !== previous.provider) && !input.secret?.trim() && authType !== "none")
    throw fail("invalid_connection", "切换服务需要重新填写认证信息");
  if (authType === "none") secret = "";
  else if (!secret) throw fail("missing_secret", "请填写这个专属连接的认证信息");
  const headerName = authType === "header" ? input.headerName ?? previous?.headerName : "";
  if (authType === "header" && (typeof headerName !== "string" || !/^[a-zA-Z][a-zA-Z0-9-]{0,79}$/.test(headerName)
    || /^(?:host|content-length|connection|transfer-encoding|cookie|set-cookie|origin|referer|proxy-.*)$/i.test(headerName)))
    throw fail("invalid_connection", "API Key Header 名称无效");
  const model = kind === "model" ? input.model ?? previous?.model : "";
  if (kind === "model" && (typeof model !== "string" || !model.trim() || model.length > 200 || /[\r\n\0]/.test(model)))
    throw fail("invalid_connection", "请填写有效模型名称");
  const baseUrl = kind === "search" ? (provider === "tavily" ? "https://api.tavily.com" : "https://mcp.exa.ai/mcp")
    : endpoint(input.baseUrl ?? previous?.baseUrl, kind);
  return { id, kind, provider, authType, headerName, secret, model, baseUrl,
    allowFallback: kind === "search" && (input.allowFallback ?? previous?.allowFallback ?? false) === true };
}

function redactResponse(value, secret) {
  if (typeof value === "string") return secret ? value.split(secret).join("[认证信息已隐藏]") : value;
  if (Array.isArray(value)) return value.map((entry) => redactResponse(entry, secret));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    /^(?:authorization|api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token)$/i.test(key) ? "[认证信息已隐藏]" : redactResponse(entry, secret)]));
  return value;
}

function headers(connection) {
  return { "content-type": "application/json", ...(connection.authType === "bearer" ? { authorization: `Bearer ${connection.secret}` }
    : connection.authType === "header" ? { [connection.headerName]: connection.secret } : {}) };
}

export class AgentConnectionStore {
  constructor({ dataDir, storage = new AgentStorage({ dataDir }), fetchImpl = fetch } = {}) {
    Object.assign(this, { storage, fetchImpl }); this.ready = storage.ready; this.queues = new Map();
  }
  async read(id) {
    agentId(id); await this.ready;
    const record = await this.storage.readJson(id, FILE, { maxBytes: MAX_RECORD });
    if (!record) return { schemaVersion: 1, agentId: id, version: 0, connections: {} };
    if (record.schemaVersion !== 1 || record.agentId !== id || !Number.isSafeInteger(record.version) || !record.connections)
      throw fail("invalid_connection_record", "连接记录无法读取，请保留文件并重试");
    return record;
  }
  async update(id, edit) {
    agentId(id);
    const previous = this.queues.get(id) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const record = await this.read(id), result = await edit(record);
      if (result === false) return;
      if (Buffer.byteLength(JSON.stringify(record)) > MAX_RECORD) throw fail("connection_limit", "连接版本记录已达到上限，请清除不再使用的连接");
      await this.storage.writeJson(id, FILE, record); return result;
    });
    this.queues.set(id, operation);
    try { return await operation; } finally { if (this.queues.get(id) === operation) this.queues.delete(id); }
  }
  async list(id, requirements = []) {
    const record = await this.read(id);
    return { version: record.version, connections: Object.values(record.connections).filter(Boolean).map((item) => redacted(item.versions[item.currentVersion])),
      requirements: requirementsView(requirements) };
  }
  async save(id, input, requirements = []) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw fail("invalid_connection", "连接配置无效");
    idValue(input.id);
    await this.update(id, (record) => {
      if (input.expectedVersion !== undefined && input.expectedVersion !== record.version) throw fail("connection_conflict", "连接配置已改变，请刷新后重试");
      const old = record.connections[input.id], value = config(input, old?.versions[old.currentVersion]);
      if (value.kind === "business" && !requirements.some((item) => item.id === value.id && (item.kind ?? item.purpose) === "business"))
        throw fail("connection_not_designed", "这个业务连接尚未包含在已评审设计中");
      if (["search", "model"].includes(value.kind) && Object.values(record.connections).some((item) => item && item.id !== value.id && item.versions[item.currentVersion].kind === value.kind))
        throw fail("duplicate_connection", "每个 Agent 只能配置一个专属搜索连接和一个专属模型连接");
      const version = ++record.version, generation = old?.generation ?? randomUUID();
      const next = { ...value, version, generation, status: "configured", updatedAt: new Date().toISOString() };
      record.connections[value.id] = { id: value.id, generation, currentVersion: version, versions: { ...old?.versions, [version]: next } };
    });
    return this.list(id, requirements);
  }
  async remove(id, connectionId, { expectedVersion } = {}) {
    idValue(connectionId);
    await this.update(id, (record) => {
      if (expectedVersion !== undefined && expectedVersion !== record.version) throw fail("connection_conflict", "连接配置已改变，请刷新后重试");
      if (!record.connections[connectionId]) return false;
      delete record.connections[connectionId]; record.version++;
    });
    return { removed: true, ...await this.list(id) };
  }
  async snapshot(id) {
    const record = await this.read(id);
    return { agentId: id, version: record.version, connections: Object.values(record.connections).filter(Boolean).map((item) => ({
      id: item.id, kind: item.versions[item.currentVersion].kind, version: item.currentVersion, generation: item.generation })) };
  }
  async assertActive(snapshot, connectionId) {
    const reference = snapshot?.connections?.find((item) => item.id === connectionId);
    if (!reference) throw fail("missing_connection", "这个任务没有绑定所需连接，请在设置中配置后重新发起任务");
    const record = await this.read(snapshot.agentId), current = record.connections[connectionId];
    if (!current || current.generation !== reference.generation || !current.versions[reference.version])
      throw fail("connection_revoked", "连接已撤销，已阻止后续调用；请重新配置并发起新任务");
    return structuredClone(current.versions[reference.version]);
  }
  async resolveKind(snapshot, kind) {
    const reference = snapshot?.connections?.find((item) => item.kind === kind);
    return reference ? this.assertActive(snapshot, reference.id) : null;
  }
  async modelConfig(snapshot, platformConfig) {
    const connection = await this.resolveKind(snapshot, "model");
    const { modelAuthType: _unused, ...platform } = platformConfig;
    return connection ? { ...platform, chatUrl: connection.baseUrl, apiKey: connection.secret, model: connection.model,
      modelAuthType: connection.authType, llmConfigured: true } : platform;
  }
  async recordResult(snapshot, connectionId, success, reason) {
    try {
      await this.update(snapshot.agentId, (record) => {
        const reference = snapshot.connections.find((item) => item.id === connectionId), entry = record.connections[connectionId];
        if (!reference || !entry || entry.generation !== reference.generation || entry.currentVersion !== reference.version) return false;
        Object.assign(entry.versions[reference.version], { status: success ? "verified" : "failed", testedAt: new Date().toISOString(), reason: success ? null : reason ?? "connection_failed" });
      });
    } catch { throw fail("connection_persistence_failed", "接口调用后的连接状态未能保存；已有外部操作不会撤销，请检查真实结果后再决定是否重试"); }
  }
  async call(snapshot, { connectionId, operationId, input = {} }, { requirements = [], signal, test = false } = {}) {
    const connection = await this.assertActive(snapshot, connectionId);
    if (connection.kind !== "business") throw fail("invalid_connection", "此操作需要业务连接");
    const requirement = requirements.find((item) => item.id === connectionId && (item.kind ?? item.purpose) === "business");
    const operation = requirement?.operations?.find((item) => item.id === operationId);
    if (!operation || !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(operation.method))
      throw fail("operation_not_designed", "请求的业务动作不属于已评审设计");
    if (test && (!operation.safeTest || operation.method !== "GET")) throw fail("unsafe_connection_test", "这个连接没有已设计的无副作用读取测试");
    if (typeof operation.path !== "string" || !operation.path.startsWith("/") || operation.path.startsWith("//")
      || operation.path.includes("\\") || operation.path.includes("#") || operation.path.includes("?") || /(?:^|\/)\.\.(?:\/|$)|%2e|%2f|%5c/i.test(operation.path))
      throw fail("invalid_operation", "业务动作必须使用已设计的固定相对路径");
    if (!input || typeof input !== "object" || Array.isArray(input) || Buffer.byteLength(JSON.stringify(input)) > 128 * 1024)
      throw fail("invalid_input", "业务操作输入必须是有效 JSON 对象且不超过 128 KiB");
    const base = new URL(connection.baseUrl), url = new URL(base.href);
    url.pathname = `${base.pathname.replace(/\/$/, "")}${operation.path}`;
    if (operation.method === "GET") for (const [key, value] of Object.entries(input)) {
      if (!["string", "number", "boolean"].includes(typeof value) && value !== null) throw fail("invalid_input", "GET 操作参数只支持简单值");
      url.searchParams.set(key, String(value ?? ""));
    }
    try {
      await this.assertActive(snapshot, connectionId); signal?.throwIfAborted();
      const result = await connectionJsonRequest(url.href, { fetchImpl: this.fetchImpl, signal, method: operation.method, headers: headers(connection),
        ...(operation.method === "GET" ? {} : { body: input }) });
      await this.assertActive(snapshot, connectionId); signal?.throwIfAborted();
      await this.recordResult(snapshot, connectionId, true);
      return { status: "ok", connectionId, operationId, data: redactResponse(result, connection.secret) };
    } catch (error) {
      if (error.reason === "connection_persistence_failed") throw error;
      if (!signal?.aborted && error.reason !== "connection_revoked") await this.recordResult(snapshot, connectionId, false, error.reason);
      throw error;
    }
  }
  async test(id, connectionId, { requirements = [], signal } = {}) {
    const snapshot = await this.snapshot(id), connection = await this.assertActive(snapshot, connectionId);
    let result;
    try {
      if (connection.kind === "business") {
        const operation = requirements.find((item) => item.id === connectionId)?.operations?.find((item) => item.safeTest && item.method === "GET");
        if (!operation) return { status: "configured", verified: false, message: "已配置，尚未验证；没有已设计的无副作用测试接口", connection: redacted(connection) };
        await this.call(snapshot, { connectionId, operationId: operation.id }, { requirements, signal, test: true });
      } else if (connection.kind === "model") {
        const url = new URL(connection.baseUrl); url.pathname = url.pathname.replace(/\/chat\/completions$/, "/models");
        result = await connectionJsonRequest(url.href, { fetchImpl: this.fetchImpl, signal, method: "GET", headers: headers(connection) });
        if (!Array.isArray(result.data)) throw fail("invalid_response", "模型列表接口未返回有效结果，尚未验证模型调用");
        if (!result.data.some((item) => item.id === connection.model)) return { status: "configured", verified: false,
          message: "接口可访问，但未列出所选模型；首次实际调用后确认状态", connection: redacted(connection) };
      } else {
        const { WebCapabilities } = await import("../runtime/web-capabilities.mjs");
        const web = new WebCapabilities({ fetchImpl: this.fetchImpl });
        result = await web.provider("search", { query: "NEUMA connectivity test", maxResults: 1 }, connection.provider, connection.secret, signal);
      }
      await this.assertActive(snapshot, connectionId); await this.recordResult(snapshot, connectionId, true);
      return { status: "verified", verified: true, message: connection.kind === "model" ? "模型列表接口及所选模型已验证；实际生成以运行回执为准" : "连接读取测试通过", connection: redacted(await this.assertActive(snapshot, connectionId)) };
    } catch (error) {
      if (signal?.aborted || ["connection_revoked", "connection_persistence_failed"].includes(error.reason)) throw error;
      if (connection.kind === "model" && [404, 405, 501].includes(error.httpStatus)) return { status: "configured", verified: false,
        message: "已配置，尚未验证；服务没有可用的模型列表测试接口，首次实际调用后确认状态", connection: redacted(connection) };
      await this.recordResult(snapshot, connectionId, false, error.reason);
      return { status: "failed", verified: false, reason: error.reason ?? "connection_failed", message: "连接测试失败，请检查地址、认证信息及服务状态", connection: redacted(await this.assertActive(snapshot, connectionId)) };
    }
  }
}
