import { randomUUID } from "node:crypto";
import { InputError } from "../requirements/core.mjs";
import { AgentStorage, agentId } from "./agent-storage.mjs";
import { connectionJsonRequest } from "../runtime/web-capabilities.mjs";
import { CredentialVault } from "../connections/credential-vault.mjs";
import { httpCall, connectionHeaders, importOpenApi } from "../connections/http-adapter.mjs";
import { MCPAdapter, contractHash } from "../connections/mcp-adapter.mjs";
import { OAuthManager, refreshOAuth } from "../connections/oauth.mjs";

const FILE = "private/connections.json", MAX_RECORD = 8 * 1024 * 1024;
const fail = (reason, message) => Object.assign(new InputError(message), { reason, ...(reason === "connection_conflict" ? { statusCode: 409 } : {}) });
const idValue = (value) => {
  if (typeof value !== "string" || !/^[\w-]{1,80}$/.test(value) || Object.hasOwn(Object.prototype, value)) throw fail("invalid_connection", "连接标识无效");
  return value;
};
const redacted = (value) => ({ id: value.id, kind: value.kind, provider: value.provider, baseUrl: value.baseUrl,
  model: value.model, authType: value.authType, headerName: value.headerName, allowFallback: value.allowFallback,
  protocol: value.protocol ?? "http", username: value.username ?? "", values: value.values ?? {}, oauth: value.oauth,
  configured: true, hasSecret: Boolean(value.secret || value.credentialRef), status: value.status, version: value.version, updatedAt: value.updatedAt,
  testedAt: value.testedAt ?? null, reason: value.reason ?? null });

function requirementsView(requirements) {
  return (Array.isArray(requirements) ? requirements : []).map((item) => ({ id: item.id,
    kind: item.kind ?? item.purpose, protocol: item.protocol ?? "http", configFields: item.configFields ?? [],
    operations: (item.operations ?? []).map(({ id, description, tool, resourceUri, readOnly, safeTest }) => ({ id, description, tool, resourceUri, readOnly, safeTest })),
    label: item.label ?? ({ search: "专属搜索", model: "专属模型", business: "业务接口" }[item.kind ?? item.purpose] ?? "专属连接"), required: item.required === true, description: item.description ?? "" }));
}

function endpoint(value, kind) {
  let url;
  try { url = new URL(value); } catch { throw fail("invalid_connection", "请填写有效的 HTTP(S) 接口地址"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || value.length > 2048)
    throw fail("invalid_connection", "接口地址不能包含认证信息、查询参数或片段");
  if (kind === "model" && !url.pathname.endsWith("/chat/completions")) url.pathname = `${url.pathname.replace(/\/$/, "")}/chat/completions`;
  return url.href;
}

function config(input, previous, requirement) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw fail("invalid_connection", "连接配置无效");
  const id = idValue(input.id), kind = input.kind ?? previous?.kind;
  if (!["search", "model", "business"].includes(kind)) throw fail("invalid_connection", "请选择搜索、模型或业务连接");
  const protocol = requirement?.protocol ?? input.protocol ?? previous?.protocol ?? "http";
  if (!["http", "mcp"].includes(protocol)) throw fail("invalid_connection", "连接协议不受支持");
  const provider = kind === "business" && protocol === "mcp" ? "mcp" : input.provider ?? previous?.provider ?? ({ model: "openai-compatible", business: "http-json" })[kind];
  if (!(kind === "search" ? ["tavily", "exa"] : kind === "model" ? ["openai-compatible"] : ["http-json", "mcp"]).includes(provider))
    throw fail("invalid_connection", "这个连接类型暂不支持所选服务");
  const authType = kind === "search" ? "bearer" : input.authType ?? previous?.authType ?? "bearer";
  if (!["none", "bearer", "header", "basic", "oauth"].includes(authType) || kind === "model" && !["none", "bearer"].includes(authType))
    throw fail("invalid_connection", "认证方式无效；专属模型使用匿名或 Bearer 认证");
  let secret = typeof input.secret === "string" && input.secret.trim() ? input.secret.trim() : previous?.secret ?? "";
  if (typeof input.secret !== "undefined" && typeof input.secret !== "string" || secret.length > 8192 || /[\r\n\0]/.test(secret))
    throw fail("invalid_connection", "认证信息格式无效");
  if (previous && (kind !== previous.kind || provider !== previous.provider) && !input.secret?.trim() && !["none", "oauth"].includes(authType))
    throw fail("invalid_connection", "切换服务需要重新填写认证信息");
  if (authType === "none") secret = "";
  else if (!secret && authType !== "oauth") throw fail("missing_secret", "请填写这个专属连接的认证信息");
  const headerName = authType === "header" ? input.headerName ?? previous?.headerName : "";
  if (authType === "header" && (typeof headerName !== "string" || !/^[a-zA-Z][a-zA-Z0-9-]{0,79}$/.test(headerName)
    || /^(?:host|content-length|connection|transfer-encoding|cookie|set-cookie|origin|referer|proxy-.*)$/i.test(headerName)))
    throw fail("invalid_connection", "API Key Header 名称无效");
  const model = kind === "model" ? input.model ?? previous?.model : "";
  if (kind === "model" && (typeof model !== "string" || !model.trim() || model.length > 200 || /[\r\n\0]/.test(model)))
    throw fail("invalid_connection", "请填写有效模型名称");
  const baseUrl = kind === "search" ? (provider === "tavily" ? "https://api.tavily.com" : "https://mcp.exa.ai/mcp")
    : endpoint(input.baseUrl ?? previous?.baseUrl, kind);
  const username = authType === "basic" ? input.username ?? previous?.username : "";
  if (authType === "basic" && (typeof username !== "string" || !username || /[:\r\n\0]/.test(username))) throw fail("invalid_connection", "请填写有效的接口账号");
  const oauth = authType === "oauth" ? { ...(previous?.oauth ?? {}), ...(input.oauth ?? {}) } : undefined;
  if (oauth && (typeof oauth !== "object" || Array.isArray(oauth) || Object.keys(oauth).some((key) => !["issuer", "authorizationUrl", "tokenUrl", "clientId", "scopes", "resource", "registrationUrl", "issuerParameterSupported"].includes(key))
    || oauth.scopes && (!Array.isArray(oauth.scopes) || oauth.scopes.some((scope) => typeof scope !== "string")))) throw fail("invalid_oauth", "登录授权配置无效");
  const values = {}, secretValues = { ...(previous?.secretValues ?? {}) };
  for (const field of requirement?.configFields ?? []) {
    if (!/^[A-Za-z][\w-]{0,79}$/.test(field.key)) throw fail("invalid_connection", "连接配置字段无效");
    let value = input.values?.[field.key] ?? previous?.values?.[field.key];
    if (field.type === "password") { if (value) secretValues[field.key] = String(value); if (field.required && !secretValues[field.key]) throw fail("invalid_connection", `请填写${field.label || field.key}`); continue; }
    if (field.required && !field.optionsFrom && (value === undefined || value === "")) throw fail("invalid_connection", `请填写${field.label || field.key}`);
    if (value === undefined) continue;
    if (field.type === "number") { value = Number(value); if (!Number.isFinite(value)) throw fail("invalid_connection", "连接配置需要有效数字"); }
    else if (typeof value !== "string" && typeof value !== "boolean") throw fail("invalid_connection", "连接配置格式无效");
    if (field.type === "select" && !field.options?.some((option) => (typeof option === "string" ? option : option.value) === value)) throw fail("invalid_connection", "请选择可用的配置选项");
    values[field.key] = value;
  }
  return { id, kind, provider, protocol, authType, headerName, secret, model, baseUrl, username, oauth, values, secretValues,
    allowFallback: kind === "search" && (input.allowFallback ?? previous?.allowFallback ?? false) === true };
}

function redactResponse(value, secret) {
  if (typeof value === "string") return secret ? value.split(secret).join("[认证信息已隐藏]") : value;
  if (Array.isArray(value)) return value.map((entry) => redactResponse(entry, secret));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    /^(?:authorization|api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token)$/i.test(key) ? "[认证信息已隐藏]" : redactResponse(entry, secret)]));
  return value;
}
function redactConnectionResponse(value, connection) {
  const secrets = [connection.secret, ...Object.values(connection.secretValues ?? {}), ...Object.values(connectionHeaders(connection)),
    ...(connection.authType === "basic" ? [Buffer.from(`${connection.username}:${connection.secret}`).toString("base64")] : [])].filter((entry) => typeof entry === "string" && entry);
  return secrets.reduce((result, secret) => redactResponse(result, secret), redactResponse(value, ""));
}

function headers(connection) {
  return { "content-type": "application/json", ...connectionHeaders(connection) };
}

export class AgentConnectionStore {
  constructor({ dataDir, storage = new AgentStorage({ dataDir }), fetchImpl = fetch, credentialKeySource, vault, resolveFile, openBrowser } = {}) {
    Object.assign(this, { storage, fetchImpl }); this.ready = storage.ready; this.queues = new Map();
    this.vault = vault ?? new CredentialVault({ storage, keySource: credentialKeySource }); this.resolveFile = resolveFile;
    this.mcp = new MCPAdapter({ fetchImpl: (...args) => this.fetchImpl(...args) }); this.refreshes = new Map();
    this.oauth = new OAuthManager({ fetchImpl: (...args) => this.fetchImpl(...args), openBrowser, onAuthorized: async (key, tokens, context, oauth, signal) => {
      const [owner, profile, connectionId] = key.split(":");
      await this.update(owner, async (record, root) => {
        signal?.throwIfAborted();
        const entry = record.connections[connectionId];
        if (!entry || entry.currentVersion !== context.version || entry.generation !== context.generation) throw fail("connection_conflict", "连接已改变，请重新授权");
        entry.grantEpoch = (entry.grantEpoch ?? 0) + 1;
        if (profile === (root.activeProfile ?? "legacy")) { root.revokedGenerations ??= {}; root.revokedGenerations[entry.generation] = true; }
        entry.generation = randomUUID();
        const value = entry.versions[entry.currentVersion], credential = await this.vault.get(owner, value.credentialRef);
        value.credentialRef = await this.vault.put(owner, { ...credential, tokens }); value.oauth = oauth;
        signal?.throwIfAborted();
        value.status = "configured"; value.grantEpoch = entry.grantEpoch; value.generation = entry.generation;
      }, { profile });
    } });
  }
  profile(root, requested) {
    const profile = requested ?? root.activeProfile ?? "legacy";
    if (profile !== "legacy" && !/^[a-f0-9]{64}$/.test(profile)) throw fail("invalid_connection_profile", "连接方案版本无效");
    if (profile === "legacy") return { schemaVersion: 1, agentId: root.agentId, version: root.version, connections: root.connections, profile, revokedGenerations: root.revokedGenerations ?? {} };
    const existing = root.profiles?.[profile];
    if (existing) return { ...existing, profile, revokedGenerations: root.revokedGenerations ?? {} };
    const active = this.profile(root, root.activeProfile ?? "legacy");
    return { schemaVersion: 1, agentId: root.agentId, version: active.version, connections: structuredClone(active.connections), profile, revokedGenerations: root.revokedGenerations ?? {} };
  }
  async readRoot(id) {
    agentId(id); await this.ready;
    const record = await this.storage.readJson(id, FILE, { maxBytes: MAX_RECORD });
    if (!record) return { schemaVersion: 1, agentId: id, version: 0, connections: {} };
    if (record.schemaVersion !== 1 || record.agentId !== id || !Number.isSafeInteger(record.version) || !record.connections)
      throw fail("invalid_connection_record", "连接记录无法读取，请保留文件并重试");
    return record;
  }
  async read(id, { profile } = {}) { return this.profile(await this.readRoot(id), profile); }
  async serial(id, edit) {
    agentId(id); const previous = this.queues.get(id) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const root = await this.readRoot(id), result = await edit(root);
      if (result === false) return;
      for (const section of [root, ...Object.values(root.profiles ?? {})]) for (const entry of Object.values(section.connections)) for (const value of Object.values(entry?.versions ?? {})) {
        if (Object.hasOwn(value, "secret") || Object.hasOwn(value, "secretValues")) {
          const credential = { ...await this.vault.get(id, value.credentialRef), ...(value.secret ? { secret: value.secret } : {}), ...(Object.keys(value.secretValues ?? {}).length ? { secretValues: value.secretValues } : {}) };
          if (Object.keys(credential).length) value.credentialRef = await this.vault.put(id, credential);
          delete value.secret; delete value.secretValues;
        }
      }
      if (Buffer.byteLength(JSON.stringify(root)) > MAX_RECORD) throw fail("connection_limit", "连接版本记录已达到上限，请清除不再使用的连接");
      await this.storage.writeJson(id, FILE, root); return result;
    });
    this.queues.set(id, operation);
    try { return await operation; } finally { if (this.queues.get(id) === operation) this.queues.delete(id); }
  }
  async update(id, edit, { profile } = {}) {
    return this.serial(id, async (root) => {
      const record = this.profile(root, profile), result = await edit(record, root);
      if (result === false) return false;
      if (record.profile === "legacy") { root.version = record.version; root.connections = record.connections; }
      else { root.profiles ??= {}; const { revokedGenerations, ...saved } = record; root.profiles[record.profile] = saved; }
      return result;
    });
  }
  async activateProfile(id, profile) {
    let previousProfile;
    await this.serial(id, (root) => {
      previousProfile = root.activeProfile ?? "legacy";
      const selected = this.profile(root, profile);
      if (profile !== "legacy") { root.profiles ??= {}; const { revokedGenerations, ...saved } = selected; root.profiles[profile] = saved; }
      root.activeProfile = selected.profile;
    });
    return { previousProfile, profile };
  }
  async getActiveProfile(id) { return (await this.readRoot(id)).activeProfile ?? "legacy"; }
  async list(id, requirements = [], { profile } = {}) {
    const record = await this.read(id, { profile });
    const views = requirementsView(requirements);
    for (const requirement of views) {
      const entry = record.connections[requirement.id], configured = entry?.versions[entry.currentVersion];
      requirement.configFields = requirement.configFields.map((field) => ({ ...field,
        ...(configured?.configurationChoices?.[field.key] ? { options: configured.configurationChoices[field.key] } : {}) }));
    }
    return { profile: record.profile, version: record.version, connections: Object.values(record.connections).filter(Boolean).map((item) => {
      const value = redacted(item.versions[item.currentVersion]);
      return { ...value, ...(record.revokedGenerations[item.generation] ? { configured: false, status: "revoked" } : {}), ...(value.authType === "oauth" ? { authorization: this.authorizationStatus(id, item.id, { profile: record.profile }) } : {}) };
    }),
      requirements: views };
  }
  async save(id, input, requirements = [], { profile, expectedActiveProfile } = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw fail("invalid_connection", "连接配置无效");
    idValue(input.id);
    await this.update(id, async (record, root) => {
      if (expectedActiveProfile !== undefined && (root.activeProfile ?? "legacy") !== expectedActiveProfile) throw fail("connection_conflict", "活动交付已经切换，请刷新连接设置后重试");
      if (input.expectedProfile !== undefined && input.expectedProfile !== record.profile) throw fail("connection_conflict", "活动连接方案已改变，请刷新后重试");
      if (input.expectedVersion !== undefined && input.expectedVersion !== record.version) throw fail("connection_conflict", "连接配置已改变，请刷新后重试");
      const old = record.connections[input.id], previous = old?.versions[old.currentVersion], credentials = await this.vault.get(id, previous?.credentialRef);
      const designed = requirements.find((item) => item.id === input.id), definition = designed ? { ...designed, configFields: designed.configFields?.map((field) => ({ ...field,
        ...(previous?.configurationChoices?.[field.key] ? { options: previous.configurationChoices[field.key] } : {}) })) } : undefined;
      const value = config(input, previous ? { ...previous, ...credentials } : undefined, definition);
      if (value.kind === "business" && !requirements.some((item) => item.id === value.id && (item.kind ?? item.purpose) === "business"))
        throw fail("connection_not_designed", "这个业务连接尚未包含在已评审设计中");
      if (["search", "model"].includes(value.kind) && Object.values(record.connections).some((item) => item && item.id !== value.id && item.versions[item.currentVersion].kind === value.kind))
        throw fail("duplicate_connection", "每个 Agent 只能配置一个专属搜索连接和一个专属模型连接");
      const version = ++record.version;
      let generation = old?.generation ?? randomUUID();
      const identityChanged = previous && (previous.baseUrl !== value.baseUrl || previous.authType !== value.authType || previous.username !== value.username
        || JSON.stringify(previous.oauth) !== JSON.stringify(value.oauth) || value.kind === "business" && input.secret?.trim() && input.secret.trim() !== credentials.secret);
      if (identityChanged || root.revokedGenerations?.[generation]) {
        if (record.profile === (root.activeProfile ?? "legacy")) { root.revokedGenerations ??= {}; root.revokedGenerations[generation] = true; }
        generation = randomUUID();
      }
      const grantEpoch = (old?.grantEpoch ?? 0) + (identityChanged ? 1 : 0);
      const next = { ...value, version, generation, grantEpoch, ...(!identityChanged && previous ? { credentialRef: previous.credentialRef, discovery: previous.discovery,
        discoveryRequirementHash: previous.discoveryRequirementHash, configurationChoices: previous.configurationChoices } : {}), status: "configured", updatedAt: new Date().toISOString() };
      record.connections[value.id] = { id: value.id, generation, grantEpoch, currentVersion: version, versions: { ...old?.versions, [version]: next } };
    }, { profile });
    return this.list(id, requirements, { profile });
  }
  async remove(id, connectionId, { expectedVersion, profile, expectedActiveProfile } = {}) {
    idValue(connectionId);
    await this.cancelAuthorization(id, connectionId, { profile });
    await this.update(id, (record, root) => {
      if (expectedActiveProfile !== undefined && (root.activeProfile ?? "legacy") !== expectedActiveProfile) throw fail("connection_conflict", "活动交付已经切换，请刷新连接设置后重试");
      if (expectedVersion !== undefined && expectedVersion !== record.version) throw fail("connection_conflict", "连接配置已改变，请刷新后重试");
      if (!record.connections[connectionId]) return false;
      if (record.profile === (root.activeProfile ?? "legacy")) { root.revokedGenerations ??= {}; root.revokedGenerations[record.connections[connectionId].generation] = true; }
      delete record.connections[connectionId]; record.version++;
    }, { profile });
    return { removed: true, ...await this.list(id, [], { profile }) };
  }
  async snapshot(id, { profile } = {}) {
    const record = await this.read(id, { profile });
    return { agentId: id, profile: record.profile, version: record.version, connections: Object.values(record.connections).filter((item) => item && !record.revokedGenerations[item.generation]).map((item) => ({
      id: item.id, kind: item.versions[item.currentVersion].kind, version: item.currentVersion, generation: item.generation, grantEpoch: item.grantEpoch ?? 0 })) };
  }
  async assertActive(snapshot, connectionId) {
    const reference = snapshot?.connections?.find((item) => item.id === connectionId);
    if (!reference) throw fail("missing_connection", "这个任务没有绑定所需连接，请在设置中配置后重新发起任务");
    let record = await this.read(snapshot.agentId, { profile: snapshot.profile ?? "legacy" }), current = record.connections[connectionId];
    if (!current || record.revokedGenerations[current.generation] || current.generation !== reference.generation || !current.versions[reference.version] || (reference.grantEpoch ?? 0) !== (current.grantEpoch ?? 0))
      throw fail("connection_revoked", "连接已撤销，已阻止后续调用；请重新配置并发起新任务");
    if (Object.values(current.versions).some((value) => Object.hasOwn(value, "secret"))) { await this.update(snapshot.agentId, () => true, { profile: snapshot.profile ?? "legacy" }); record = await this.read(snapshot.agentId, { profile: snapshot.profile ?? "legacy" }); current = record.connections[connectionId]; }
    if (!current || record.revokedGenerations[current.generation] || current.generation !== reference.generation || !current.versions[reference.version] || (reference.grantEpoch ?? 0) !== (current.grantEpoch ?? 0)) throw fail("connection_revoked", "连接授权已改变，请重新开始任务");
    const value = structuredClone(current.versions[reference.version]);
    let credentials = await this.vault.get(snapshot.agentId, value.credentialRef);
    if (value.authType === "oauth") {
      if (!credentials.tokens) throw fail("authorization_required", "请先登录并授权这个连接");
      if (credentials.tokens.expiresAt && credentials.tokens.expiresAt <= Date.now() + 30000) credentials = await this.refreshOAuth(snapshot, connectionId, value, credentials);
      value.secret = credentials.tokens.accessToken;
    } else value.secret = credentials.secret ?? "";
    value.secretValues = credentials.secretValues ?? {}; return value;
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
      }, { profile: snapshot.profile ?? "legacy" });
    } catch { throw fail("connection_persistence_failed", "接口调用后的连接状态未能保存；已有外部操作不会撤销，请检查真实结果后再决定是否重试"); }
  }
  async refreshOAuth(snapshot, connectionId, value, credentials) {
    const key = `${snapshot.agentId}:${value.credentialRef}`;
    if (!this.refreshes.has(key)) this.refreshes.set(key, (async () => {
      const tokens = await refreshOAuth(value.oauth, credentials.tokens, { fetchImpl: (...args) => this.fetchImpl(...args), signal: AbortSignal.timeout(60000) });
      const previousScopes = credentials.tokens.scopes ?? [], narrowed = previousScopes.some((scope) => !tokens.scopes.includes(scope));
      const next = { ...credentials, tokens };
      await this.update(snapshot.agentId, async (record, root) => {
        const entry = record.connections[connectionId];
        if (!entry || entry.generation !== value.generation || (entry.grantEpoch ?? 0) !== (value.grantEpoch ?? 0)) throw fail("connection_revoked", "连接授权已经改变，请重新开始任务");
        const reference = await this.vault.put(snapshot.agentId, next);
        for (const section of [root, ...Object.values(root.profiles ?? {}), record]) for (const candidate of Object.values(section.connections)) {
          const matching = Object.values(candidate.versions).filter((version) => version.credentialRef === value.credentialRef);
          if (!matching.length) continue;
          if (narrowed) candidate.grantEpoch = (candidate.grantEpoch ?? 0) + 1;
          for (const version of matching) { version.credentialRef = reference; version.grantEpoch = candidate.grantEpoch ?? 0; }
        }
      }, { profile: snapshot.profile ?? "legacy" });
      if (narrowed) throw fail("connection_revoked", "授权范围已收紧，请重新开始任务");
      return next;
    })().finally(() => this.refreshes.delete(key)));
    return this.refreshes.get(key);
  }
  async discover(id, connectionId, { requirements = [], signal, document, profile } = {}) {
    const snapshot = await this.snapshot(id, { profile }), connection = await this.assertActive(snapshot, connectionId);
    if (connection.kind !== "business" || !requirements.some((item) => item.id === connectionId)) throw fail("connection_not_designed", "连接尚未包含在已评审设计中");
    const requirement = requirements.find((item) => item.id === connectionId), requirementHash = contractHash(requirement);
    const result = redactConnectionResponse(connection.protocol === "mcp" ? await this.mcp.discover(connection, { signal }) : document ? importOpenApi(document) : { operations: [], requiresReview: true }, connection);
    const choices = {};
    const readPath = (value, path) => {
      for (const part of path?.split(".").filter(Boolean) ?? []) {
        if (!value || ["__proto__", "prototype", "constructor"].includes(part) || !Object.hasOwn(value, part)) return undefined;
        value = value[part];
      }
      return value;
    };
    for (const field of requirement.configFields ?? []) if (field.optionsFrom) {
      const source = field.optionsFrom;
      const operation = requirement.operations?.find((item) => item.id === source.operationId);
      if (!operation || !operation.safeTest || operation.readOnly !== true) throw fail("unsafe_connection_test", "资源选择列表需要已评审的只读操作");
      const response = connection.protocol === "mcp" ? { data: redactConnectionResponse(await this.mcp.call(connection, operation, operation.testInput ?? {}, { signal, discovery: result }), connection) }
        : await this.call(snapshot, { connectionId, operationId: operation.id, input: operation.testInput ?? {} }, { requirements, signal, test: true });
      const entries = readPath(response.data?.structuredContent ?? response.data, source.itemsPath);
      if (!Array.isArray(entries) || entries.length > 200) throw fail("invalid_response", "资源列表未返回有效的有限选项");
      choices[field.key] = entries.map((entry) => ({ value: String(readPath(entry, source.valuePath) ?? ""), label: String(readPath(entry, source.labelPath) ?? "") })).filter((entry) => entry.value && entry.label);
    }
    await this.assertActive(snapshot, connectionId);
    await this.update(id, (record) => {
      const entry = record.connections[connectionId];
      if (entry.currentVersion !== connection.version) throw fail("connection_conflict", "连接已改变，请重新发现");
      const value = entry.versions[connection.version];
      if (connection.protocol === "mcp" && value.discovery && value.discoveryRequirementHash === requirementHash && contractHash(value.discovery) !== contractHash(result)) {
        value.pendingDiscovery = result; value.status = "failed"; value.reason = "connection_contract_changed";
      } else { value.discovery = result; value.discoveryRequirementHash = requirementHash; delete value.pendingDiscovery; }
      value.configurationChoices = choices;
    }, { profile: snapshot.profile });
    return { ...result, configurationChoices: choices, approvedOperations: requirement.operations?.map((item) => item.id) ?? [], requiresReview: true };
  }
  async authorize(id, connectionId, { requirements = [], profile } = {}) {
    const record = await this.read(id, { profile }), entry = record.connections[connectionId], value = entry?.versions[entry.currentVersion];
    if (!value || value.authType !== "oauth" || value.kind !== "business" || !requirements.some((item) => item.id === connectionId)) throw fail("authorization_not_designed", "请先保存已评审连接的登录配置");
    return this.oauth.start(`${id}:${record.profile}:${connectionId}`, value.oauth ?? {}, { context: { version: value.version, generation: value.generation, profile: record.profile }, ...(value.protocol === "mcp" ? { resourceUrl: value.baseUrl } : {}) });
  }
  authorizationStatus(id, connectionId, { profile = "legacy" } = {}) { agentId(id); idValue(connectionId); return this.oauth.status(`${id}:${profile}:${connectionId}`); }
  async cancelAuthorization(id, connectionId, { profile } = {}) { agentId(id); idValue(connectionId); const record = await this.read(id, { profile }); return this.oauth.cancel(`${id}:${record.profile}:${connectionId}`); }
  async call(snapshot, { connectionId, operationId, input = {} }, { requirements = [], signal, test = false, resolveFile, scope = "private" } = {}) {
    if (typeof scope !== "string" || scope === "group" || scope.length > 300 || /[\r\n\0]/.test(scope)) throw fail("invalid_connection_scope", "连接调用范围无效");
    const connection = await this.assertActive(snapshot, connectionId);
    if (connection.kind !== "business") throw fail("invalid_connection", "此操作需要业务连接");
    const requirement = requirements.find((item) => item.id === connectionId && (item.kind ?? item.purpose) === "business");
    const operation = requirement?.operations?.find((item) => item.id === operationId);
    if (!operation) throw fail("operation_not_designed", "请求的业务动作不属于已评审设计");
    for (const field of requirement.configFields ?? []) if (field.required && field.optionsFrom?.operationId !== operationId) {
      const configured = field.type === "password" ? connection.secretValues?.[field.key] : connection.values?.[field.key];
      if (configured === undefined || configured === "" || configured === null) throw fail("connection_configuration_required", "请先完成这个连接的资源选择与必需配置");
    }
    if (test && (!operation.safeTest || !(operation.readOnly === true || operation.readOnly !== false && ["GET", "HEAD"].includes(operation.method)))) throw fail("unsafe_connection_test", "这个连接没有已设计的无副作用读取测试");
    if (!input || typeof input !== "object" || Array.isArray(input) || Buffer.byteLength(JSON.stringify(input)) > 128 * 1024) throw fail("invalid_input", "业务操作输入必须是有效 JSON 对象且不超过 128 KiB");
    try {
      await this.assertActive(snapshot, connectionId); signal?.throwIfAborted();
      const result = connection.protocol === "mcp"
        ? await this.mcp.call(connection, operation, input, { signal, discovery: connection.discovery })
        : await httpCall(connection, operation, input, { fetchImpl: (...args) => this.fetchImpl(...args), signal,
          resolveFile: resolveFile ?? (this.resolveFile ? (reference, options) => this.resolveFile(snapshot.agentId, reference, options) : undefined) });
      await this.assertActive(snapshot, connectionId); signal?.throwIfAborted();
      await this.recordResult(snapshot, connectionId, true);
      const data = redactConnectionResponse(result, connection);
      if (Buffer.byteLength(JSON.stringify(data)) > 128 * 1024) {
        const resultRef = randomUUID();
        const connectionVersion = snapshot.connections.find((item) => item.id === connectionId);
        try { await this.storage.writeJson(snapshot.agentId, `private/connection-results/${resultRef}.json`, { scope, connectionId, operationId,
          profile: snapshot.profile ?? "legacy", connectionVersion, data }); }
        catch { throw fail("connection_persistence_failed", "接口已返回，但大结果保存失败；请核对真实操作结果后再决定是否重试"); }
        return { status: "ok", connectionId, operationId, resultRef, message: "结果较大，已保存，可分段读取" };
      }
      return { status: "ok", connectionId, operationId, data };
    } catch (error) {
      if (error.reason === "connection_persistence_failed") throw error;
      if (!signal?.aborted && error.reason !== "connection_revoked") await this.recordResult(snapshot, connectionId, false, error.reason);
      throw error;
    }
  }
  async readResult(id, resultRef, { offset = 0, length = 32000, scope = "private", connectionIds } = {}) {
    agentId(id); if (!/^[a-f0-9-]{36}$/.test(resultRef)) throw fail("invalid_result", "连接结果标识无效");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 128000) throw fail("invalid_result", "连接结果读取范围无效");
    const result = await this.storage.readJson(id, `private/connection-results/${resultRef}.json`, { maxBytes: 25 * 1024 * 1024 });
    if (!result || result.scope !== scope || connectionIds && !connectionIds.includes(result.connectionId)) throw fail("missing_result", "当前任务无权读取这个连接结果或结果不存在");
    const record = await this.read(id, { profile: result.profile ?? "legacy" }), current = record.connections[result.connectionId], reference = result.connectionVersion;
    if (!reference || !current || record.revokedGenerations[current.generation] || current.generation !== reference.generation
      || (current.grantEpoch ?? 0) !== (reference.grantEpoch ?? 0) || !current.versions[reference.version]) throw fail("connection_revoked", "此结果绑定的连接授权已经撤销，已停止继续读取");
    const content = JSON.stringify(result.data); return { resultRef, offset, content: content.slice(offset, offset + length), totalLength: content.length, hasMore: offset + length < content.length };
  }
  async close() { await Promise.all([this.oauth.close(), this.mcp.close()]); }
  async test(id, connectionId, { requirements = [], signal, profile } = {}) {
    const snapshot = await this.snapshot(id, { profile }), connection = await this.assertActive(snapshot, connectionId);
    let result;
    try {
      if (connection.kind === "business") {
        const operation = requirements.find((item) => item.id === connectionId)?.operations?.find((item) => item.safeTest && (item.readOnly === true || item.readOnly !== false && ["GET", "HEAD"].includes(item.method)));
        if (!operation) return { status: "configured", verified: false, message: "已配置，尚未验证；没有已设计的无副作用测试接口", connection: redacted(connection) };
        await this.call(snapshot, { connectionId, operationId: operation.id, input: operation.testInput ?? {} }, { requirements, signal, test: true });
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
