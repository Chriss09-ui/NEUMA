import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { agentId } from "../agents/agent-storage.mjs";
import { fileURLToPath } from "node:url";

const FILE = "private/gateway.json";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (reason, message, statusCode = 400) => Object.assign(new Error(message), { reason, statusCode });
const taskView = (task) => ({ taskId: task.id ?? task.taskId, deliveryVersion: task.deliveryVersion, actionId: task.actionId,
  status: task.status, progress: task.progress, result: task.result, error: task.error, artifacts: task.artifacts ?? [], createdAt: task.createdAt, updatedAt: task.updatedAt });
function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(value));
}
async function body(request) {
  if (!request.headers["content-type"]?.split(";")[0].trim().includes("application/json")) throw fail("invalid_request", "请求需要使用 JSON");
  let size = 0; const chunks = [];
  for await (const chunk of request) { size += chunk.length; if (size > 256 * 1024) throw fail("request_too_large", "请求超过大小限制", 413); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks)); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value; }
  catch { throw fail("invalid_request", "请求需要有效 JSON 对象"); }
}
function exact(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((field) => !fields.includes(field))) throw fail("invalid_request", "请求包含无效字段");
}

export class ServiceGateway {
  constructor({ agents, storage = agents.storage }) {
    Object.assign(this, { agents, storage }); this.servers = new Map(); this.errors = new Map(); this.queues = new Map(); this.transports = new Set(); this.closing = false; this.permanent = false; this.suspended = false;
    this.ready = this.restore(); this.ready.catch(() => {});
  }
  async record(id) {
    agentId(id); const value = await this.storage.readJson(id, FILE, { maxBytes: 128 * 1024 });
    if (!value) return { schemaVersion: 1, agentId: id, enabled: false, actionIds: [] };
    if (value.schemaVersion !== 1 || value.agentId !== id || !Array.isArray(value.actionIds) || value.enabled && (!Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535
      || !/^[a-f0-9]{64}$/.test(value.tokenHash ?? "") || typeof value.grantId !== "string" || typeof value.deliveryVersion !== "string")) throw fail("invalid_gateway_record", "接口配置无法读取，请保留文件后重试");
    return value;
  }
  async restore() {
    await this.storage.ready;
    for (const id of await this.storage.agentIds()) {
      const record = await this.record(id); if (!record.enabled) continue;
      try { await this.listen(id, record.port); } catch (error) { this.errors.set(id, { reason: error.reason ?? "gateway_start_failed", message: error.message }); }
    }
  }
  async serial(id, operation) {
    const previous = this.queues.get(id) ?? Promise.resolve(), next = previous.catch(() => {}).then(operation); this.queues.set(id, next);
    try { return await next; } finally { if (this.queues.get(id) === next) this.queues.delete(id); }
  }
  async listen(id, port = 0) {
    if (this.closing) throw fail("gateway_closed", "接口服务正在关闭");
    if (this.servers.has(id)) return this.servers.get(id).address().port;
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw fail("invalid_gateway_port", "接口端口无效");
    const server = createServer((request, response) => this.handle(id, request, response).catch((error) => {
      if (!response.headersSent) json(response, error.statusCode ?? 400, { error: error.reason ? error.message : "接口调用未完成，请检查操作与运行状态", reason: error.reason ?? "gateway_failed" });
      else response.end();
    }));
    server.requestTimeout = 60000; server.headersTimeout = 10000; server.keepAliveTimeout = 1000;
    try { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); }); }
    catch (error) { server.close(); throw fail(error.code === "EADDRINUSE" ? "gateway_port_busy" : "gateway_start_failed", error.code === "EADDRINUSE" ? "原接口端口已被占用，请关闭占用程序后重试" : "本机接口启动失败"); }
    this.servers.set(id, server); this.errors.delete(id); server.unref(); return server.address().port;
  }
  view(record) {
    const address = record.port ? `http://127.0.0.1:${record.port}` : null;
    return { enabled: record.enabled, status: this.suspended && record.enabled ? "suspended" : this.errors.has(record.agentId) ? "failed" : record.enabled ? "running" : "disabled",
      port: record.port ?? null, deliveryVersion: record.deliveryVersion ?? null, actionIds: record.actionIds,
      apiUrl: address ? `${address}/v1/agents/${record.agentId}` : null, mcpUrl: address ? `${address}/mcp/${record.agentId}` : null,
      bridge: address ? { command: process.execPath, args: [fileURLToPath(new URL("./mcp-bridge.mjs", import.meta.url)), `${address}/mcp/${record.agentId}`], env: { NEUMA_MCP_TOKEN: "填入本机接口令牌" } } : null,
      ...(this.errors.get(record.agentId) ?? {}) };
  }
  async config(id) { await this.ready; return this.view(await this.record(id)); }
  async configure(id, input) {
    agentId(id); await this.ready; if (this.suspended) await this.resume();
    return this.serial(id, async () => {
      exact(input, ["actionIds", "deliveryVersion"]);
      const descriptor = await this.agents.applications.descriptor(id);
      if (input.deliveryVersion !== descriptor.deliveryVersion) throw fail("delivery_changed", "交付版本已变化，请刷新后选择需要发布的操作", 409);
      if (!Array.isArray(input.actionIds) || !input.actionIds.length || input.actionIds.length > 80 || new Set(input.actionIds).size !== input.actionIds.length
        || input.actionIds.some((actionId) => !descriptor.manifest.actions.some((action) => action.id === actionId))) throw fail("invalid_gateway_actions", "请选择已交付并允许外部调用的操作");
      const previous = await this.record(id), token = randomBytes(32).toString("base64url"), grantId = randomUUID();
      const port = await this.listen(id, previous.port ?? 0);
      const record = { schemaVersion: 1, agentId: id, enabled: true, port, deliveryVersion: descriptor.deliveryVersion, actionIds: [...input.actionIds], tokenHash: hash(token), grantId, updatedAt: new Date().toISOString() };
      try { await this.storage.writeJson(id, FILE, record); }
      catch { if (!previous.enabled) await this.stop(id); throw fail("gateway_persistence_failed", "接口授权未能保存，请重试"); }
      return { ...this.view(record), token, tokenShownOnce: true };
    });
  }
  async revoke(id) {
    agentId(id); await this.ready;
    return this.serial(id, async () => {
      const record = await this.record(id);
      const next = { schemaVersion: 1, agentId: id, enabled: false, port: record.port, actionIds: [], updatedAt: new Date().toISOString() };
      await this.storage.writeJson(id, FILE, next); await this.stop(id); this.errors.delete(id);
      return this.view(next);
    });
  }
  async authenticate(id, request) {
    const server = this.servers.get(id), port = server?.address()?.port;
    if (!port || ![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(request.headers.host)
      || request.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(request.headers.origin)) throw fail("invalid_gateway_origin", "接口只接受本机已授权调用", 403);
    const record = await this.record(id), match = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
    if (!record.enabled || !match || !/^[a-f0-9]{64}$/.test(record.tokenHash ?? "") || !timingSafeEqual(Buffer.from(hash(match[1]), "hex"), Buffer.from(record.tokenHash, "hex"))) throw fail("gateway_unauthorized", "接口令牌无效或已撤销", 401);
    const descriptor = await this.agents.applications.descriptor(id);
    if (descriptor.deliveryVersion !== record.deliveryVersion) throw fail("delivery_changed", "接口绑定的交付版本已变化，请在 NEUMA 中重新发布", 409);
    return { record, descriptor };
  }
  async currentGrant(id, grant) {
    const current = await this.record(id);
    if (!current.enabled || current.grantId !== grant.grantId) throw fail("gateway_unauthorized", "接口授权已改变或已撤销", 401);
    const descriptor = await this.agents.applications.descriptor(id);
    if (descriptor.deliveryVersion !== grant.deliveryVersion) throw fail("delivery_changed", "接口绑定的交付版本已变化，请刷新授权", 409);
    return descriptor;
  }
  async submit(id, grant, input) {
    exact(input, ["actionId", "input", "mutationId", "deliveryVersion"]);
    await this.currentGrant(id, grant);
    if (input.deliveryVersion !== grant.deliveryVersion) throw fail("delivery_changed", "请求的交付版本已变化，请刷新接口说明", 409);
    if (!grant.actionIds.includes(input.actionId)) throw fail("action_not_shared", "这个操作未被授权给外部调用", 403);
    if (typeof input.mutationId !== "string" || !/^[\w-]{8,100}$/.test(input.mutationId)) throw fail("invalid_request", "请提供稳定的任务请求编号，避免重复执行");
    const result = await this.agents.applications.submit(id, { ...input, mutationId: hash(`${grant.grantId}:${input.mutationId}`) }, { source: { kind: "application", scope: "private", gatewayGrant: grant.grantId } });
    await this.currentGrant(id, grant);
    return { taskId: result.taskId, deliveryVersion: grant.deliveryVersion, status: result.task?.status ?? "queued" };
  }
  async task(id, grant, taskId) {
    await this.currentGrant(id, grant); agentId(taskId);
    const task = await this.agents.applications.store.get(id, taskId);
    if (task.agentId !== id || task.source?.gatewayGrant !== grant.grantId || task.source?.scope !== "private"
      || task.deliveryVersion !== grant.deliveryVersion || !grant.actionIds.includes(task.actionId)) throw fail("task_not_shared", "当前接口无权读取这个任务", 404);
    return task;
  }
  async cancel(id, grant, input) {
    exact(input, ["taskId", "deliveryVersion"]);
    if (input.deliveryVersion !== grant.deliveryVersion) throw fail("delivery_changed", "请求的交付版本已变化", 409);
    await this.task(id, grant, input.taskId); const result = await this.agents.applications.cancel(id, input.taskId);
    await this.currentGrant(id, grant); return taskView(result.task);
  }
  async handle(id, request, response) {
    const { record, descriptor } = await this.authenticate(id, request), url = new URL(request.url, `http://${request.headers.host}`);
    const base = `/v1/agents/${id}`;
    if (url.pathname === `/mcp/${id}`) return this.mcp(id, record, descriptor, request, response);
    if (url.pathname === `${base}/actions` && request.method === "GET") {
      return json(response, 200, { deliveryVersion: record.deliveryVersion, actions: descriptor.manifest.actions.filter((action) => record.actionIds.includes(action.id)).map(({ id, title, inputSchema, outputSchema }) => ({ id, title, inputSchema, outputSchema })) });
    }
    if (url.pathname === `${base}/tasks` && request.method === "POST") return json(response, 202, await this.submit(id, record, await body(request)));
    if (url.pathname === `${base}/tasks` && request.method === "GET") {
      if (url.searchParams.get("deliveryVersion") !== record.deliveryVersion) throw fail("delivery_changed", "读取任务需要当前交付版本", 409);
      const tasks = (await this.agents.applications.store.list(id, { scope: "private" })).filter((task) => task.source.gatewayGrant === record.grantId && record.actionIds.includes(task.actionId) && task.deliveryVersion === record.deliveryVersion);
      return json(response, 200, { deliveryVersion: record.deliveryVersion, tasks: tasks.map(taskView) });
    }
    const match = url.pathname.match(new RegExp(`^${base}/tasks/([\\w-]{1,80})(?:/(cancel))?$`));
    if (match && request.method === "GET" && !match[2]) {
      if (url.searchParams.get("deliveryVersion") !== record.deliveryVersion) throw fail("delivery_changed", "读取任务需要当前交付版本", 409);
      return json(response, 200, taskView(await this.task(id, record, match[1])));
    }
    if (match && request.method === "POST" && match[2] === "cancel") return json(response, 200, await this.cancel(id, record, { ...await body(request), taskId: match[1] }));
    throw fail("gateway_not_found", "接口不存在", 404);
  }
  async mcp(id, grant, descriptor, request, response) {
    const server = new McpServer({ name: `NEUMA-${id}`, version: "1.0.0" });
    const version = { type: "string", const: grant.deliveryVersion }, taskInput = fromJsonSchema({ type: "object", properties: { taskId: { type: "string" }, deliveryVersion: version }, required: ["taskId", "deliveryVersion"], additionalProperties: false });
    const result = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
    const outputSchema = fromJsonSchema({ type: "object", properties: { taskId: { type: "string" }, deliveryVersion: version, status: { type: "string" } }, required: ["taskId", "deliveryVersion", "status"], additionalProperties: true });
    const guarded = (operation) => async (input) => { try { return await operation(input); } catch (error) { throw new Error(error.reason ? error.message : "接口操作未完成，请检查输入与智能体运行状态"); } };
    for (const action of descriptor.manifest.actions.filter((item) => grant.actionIds.includes(item.id))) server.registerTool(`run_${action.id}`, {
      title: action.title || action.id, description: "提交已授权操作，返回任务编号；通过 get_task 查询进度与结果。",
      inputSchema: fromJsonSchema({ type: "object", properties: { input: action.inputSchema, mutationId: { type: "string", pattern: "^[A-Za-z0-9_-]{8,100}$" }, deliveryVersion: version }, required: ["input", "mutationId", "deliveryVersion"], additionalProperties: false }),
      outputSchema,
    }, guarded(async (input) => result(await this.submit(id, grant, { ...input, actionId: action.id }))));
    server.registerTool("get_task", { description: "读取本次授权创建的任务状态和结果。", inputSchema: taskInput, outputSchema }, guarded(async ({ taskId, deliveryVersion }) => {
      if (deliveryVersion !== grant.deliveryVersion) throw fail("delivery_changed", "任务版本已变化");
      return result(taskView(await this.task(id, grant, taskId)));
    }));
    server.registerTool("cancel_task", { description: "停止本次授权创建的任务；已经发生的外部操作不会撤回。", inputSchema: taskInput, outputSchema }, guarded(async (input) => result(await this.cancel(id, grant, input))));
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 256 * 1024 });
    this.transports.add(transport);
    response.once("close", () => { this.transports.delete(transport); void transport.close(); void server.close(); });
    await server.connect(transport); await transport.handleRequest(request, response);
  }
  async stop(id) {
    const server = this.servers.get(id); if (!server) return;
    this.servers.delete(id); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  }
  async resume() {
    await this.closePromise;
    if (this.permanent) throw fail("gateway_closed", "本机接口已随应用关闭");
    if (!this.suspended) { await this.ready; return; }
    this.closing = false; this.suspended = false; this.ready = this.restore(); await this.ready;
  }
  close({ permanent = false } = {}) {
    if (permanent) this.permanent = true;
    if (this.closePromise) return this.closePromise;
    this.closing = true; this.suspended = true;
    this.closePromise = (async () => {
      await this.ready.catch(() => {}); await Promise.allSettled([...this.queues.values()]);
      await Promise.allSettled([...this.transports].map((transport) => transport.close()));
      await Promise.all([...this.servers.keys()].map((id) => this.stop(id)));
    })().finally(() => { this.closePromise = null; });
    return this.closePromise;
  }
}
export { ServiceGateway as Gateway };
