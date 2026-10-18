import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { AgentStorage } from "../src/agents/agent-storage.mjs";
import { ServiceGateway } from "../src/services/service-gateway.mjs";

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "neuma-gateway-")), storage = new AgentStorage({ dataDir }), tasks = new Map(), mutations = new Map();
  let version = "delivery-one";
  const agents = { storage, applications: {
    descriptor: async () => ({ deliveryVersion: version, manifest: { actions: [
      { id: "analyze", title: "分析", inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } }, outputSchema: { type: "object" } },
      { id: "delete", title: "删除", inputSchema: { type: "object" }, outputSchema: { type: "object" } },
    ] } }),
    submit: async (agentId, body, { source }) => {
      let taskId = mutations.get(body.mutationId);
      if (!taskId) { taskId = randomUUID(); mutations.set(body.mutationId, taskId); tasks.set(taskId, { id: taskId, agentId, ...body, source, status: "queued", result: null }); }
      return { taskId, task: tasks.get(taskId) };
    },
    cancel: async (_id, taskId) => { const task = tasks.get(taskId); task.status = "cancelled"; return { task }; },
    store: { get: async (id, taskId) => { const task = tasks.get(taskId); if (!task || task.agentId !== id) throw new Error("missing task"); return task; },
      list: async (id) => [...tasks.values()].filter((task) => task.agentId === id) },
  } };
  const gateway = new ServiceGateway({ agents }); await gateway.ready;
  t.after(async () => { await gateway.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { gateway, agents, dataDir, tasks, setVersion: (next) => { version = next; } };
}
const headers = (token) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

test("gateway is opt-in and grants only explicit actions with one-time token disclosure", async (t) => {
  const { gateway, dataDir } = await fixture(t);
  assert.equal((await gateway.config("alpha")).enabled, false);
  await assert.rejects(gateway.configure("alpha", { actionIds: ["analyze"], deliveryVersion: "old" }), { reason: "delivery_changed" });
  const configured = await gateway.configure("alpha", { actionIds: ["analyze"], deliveryVersion: "delivery-one" });
  assert.ok(configured.token); assert.equal((await gateway.config("alpha")).token, undefined);
  assert.equal((await readFile(join(dataDir, "agents/alpha/private/gateway.json"), "utf8")).includes(configured.token), false);
  assert.equal((await fetch(`${configured.apiUrl}/actions`)).status, 401);
  const catalog = await (await fetch(`${configured.apiUrl}/actions`, { headers: headers(configured.token) })).json();
  assert.deepEqual(catalog.actions.map((action) => action.id), ["analyze"]); assert.equal(catalog.deliveryVersion, "delivery-one");
  assert.equal((await fetch(`${configured.apiUrl}/tasks`, { method: "POST", headers: headers(configured.token), body: JSON.stringify({ actionId: "delete", input: {}, mutationId: "request-one", deliveryVersion: "delivery-one" }) })).status, 403);
  assert.equal((await fetch(`${configured.apiUrl.replace('/v1/agents/alpha', '')}/api/agents`, { headers: headers(configured.token) })).status, 404);
});

test("REST tasks bind grant, agent, action and delivery version; retry keys do not replay", async (t) => {
  const { gateway, tasks, setVersion } = await fixture(t), grant = await gateway.configure("alpha", { actionIds: ["analyze"], deliveryVersion: "delivery-one" });
  const submit = () => fetch(`${grant.apiUrl}/tasks`, { method: "POST", headers: headers(grant.token), body: JSON.stringify({ actionId: "analyze", input: { text: "hello" }, mutationId: "stable-request-one", deliveryVersion: "delivery-one" }) });
  const task = await (await submit()).json(), retried = await (await submit()).json(); assert.equal(task.taskId, retried.taskId); assert.equal(tasks.size, 1);
  const foreign = randomUUID(); tasks.set(foreign, { id: foreign, agentId: "alpha", actionId: "analyze", deliveryVersion: "delivery-one", source: { kind: "application", scope: "private" }, status: "completed" });
  assert.equal((await fetch(`${grant.apiUrl}/tasks/${foreign}?deliveryVersion=delivery-one`, { headers: headers(grant.token) })).status, 404);
  const list = await (await fetch(`${grant.apiUrl}/tasks?deliveryVersion=delivery-one`, { headers: headers(grant.token) })).json(); assert.equal(list.tasks.length, 1);
  const cancelled = await (await fetch(`${grant.apiUrl}/tasks/${task.taskId}/cancel`, { method: "POST", headers: headers(grant.token), body: JSON.stringify({ deliveryVersion: "delivery-one" }) })).json(); assert.equal(cancelled.status, "cancelled");
  const replacement = await gateway.configure("alpha", { actionIds: ["analyze"], deliveryVersion: "delivery-one" });
  assert.equal((await fetch(`${grant.apiUrl}/actions`, { headers: headers(grant.token) })).status, 401);
  assert.equal((await fetch(`${grant.apiUrl}/tasks/${task.taskId}?deliveryVersion=delivery-one`, { headers: headers(replacement.token) })).status, 404);
  setVersion("delivery-two"); assert.equal((await fetch(`${grant.apiUrl}/actions`, { headers: headers(replacement.token) })).status, 409);
});

test("official MCP client sees published actions and uses the same persistent task service", async (t) => {
  const { gateway, tasks } = await fixture(t), grant = await gateway.configure("alpha", { actionIds: ["analyze"], deliveryVersion: "delivery-one" });
  const client = new Client({ name: "fixture", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(grant.mcpUrl), { requestInit: { headers: headers(grant.token) } }));
  t.after(() => client.close());
  const catalog = await client.listTools(); assert.deepEqual(catalog.tools.map((tool) => tool.name).sort(), ["cancel_task", "get_task", "run_analyze"]);
  const result = await client.callTool({ name: "run_analyze", arguments: { input: { text: "hello" }, mutationId: "mcp-request-one", deliveryVersion: "delivery-one" } });
  const taskId = result.structuredContent.taskId; assert.ok(tasks.has(taskId)); assert.equal(tasks.get(taskId).source.scope, "private");
  const status = await client.callTool({ name: "get_task", arguments: { taskId, deliveryVersion: "delivery-one" } }); assert.equal(status.structuredContent.status, "queued");
  const cancelled = await client.callTool({ name: "cancel_task", arguments: { taskId, deliveryVersion: "delivery-one" } }); assert.equal(cancelled.structuredContent.status, "cancelled");
  const stale = await client.callTool({ name: "run_analyze", arguments: { input: { text: "hello" }, mutationId: "mcp-request-two", deliveryVersion: "old" } }); assert.equal(stale.isError, true); assert.equal(tasks.size, 1);
});

test("gateway rejects browser origins and host rebinding even with valid credentials", async (t) => {
  const { gateway } = await fixture(t), grant = await gateway.configure("alpha", { actionIds: ["analyze"], deliveryVersion: "delivery-one" });
  assert.equal((await fetch(`${grant.apiUrl}/actions`, { headers: { ...headers(grant.token), origin: "https://other.example" } })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => { const req = request(`${grant.apiUrl}/actions`, { headers: { ...headers(grant.token), host: "other.example" } }, (res) => { res.resume(); resolve(res.statusCode); }); req.on("error", reject); req.end(); });
  assert.equal(hostStatus, 403);
  await gateway.revoke("alpha"); assert.equal((await gateway.config("alpha")).enabled, false);
  await assert.rejects(fetch(`${grant.apiUrl}/actions`, { headers: headers(grant.token) }));
});

test("trusted stdio bridge uses the same local MCP grant without exposing the token in arguments", async (t) => {
  const { gateway } = await fixture(t), grant = await gateway.configure("alpha", { actionIds: ["analyze"], deliveryVersion: "delivery-one" });
  assert.equal(JSON.stringify(grant.bridge.args).includes(grant.token), false);
  const client = new Client({ name: "stdio-fixture", version: "1" });
  await client.connect(new StdioClientTransport({ command: grant.bridge.command, args: grant.bridge.args, env: { NEUMA_MCP_TOKEN: grant.token }, stderr: "pipe" }));
  t.after(() => client.close());
  const tools = await client.listTools(); assert.equal(tools.tools.some((tool) => tool.name === "run_analyze"), true);
  const result = await client.callTool({ name: "run_analyze", arguments: { input: { text: "from stdio" }, mutationId: "stdio-request", deliveryVersion: "delivery-one" } });
  assert.equal(result.structuredContent.status, "queued"); assert.equal(result.structuredContent.deliveryVersion, "delivery-one");
});

test("restored gateways retain their port and report conflicts without selecting another port", async (t) => {
  const { gateway, agents } = await fixture(t), grant = await gateway.configure("alpha", { actionIds: ["analyze"], deliveryVersion: "delivery-one" });
  await gateway.close();
  const blocker = createServer((_request, response) => response.end()); await new Promise((resolve) => blocker.listen(grant.port, "127.0.0.1", resolve));
  const restored = new ServiceGateway({ agents }); await restored.ready;
  try {
    const config = await restored.config("alpha"); assert.equal(config.port, grant.port); assert.equal(config.status, "failed"); assert.equal(config.reason, "gateway_port_busy");
    await assert.rejects(restored.configure("alpha", { actionIds: ["analyze"], deliveryVersion: "delivery-one" }), { reason: "gateway_port_busy" });
  } finally { await restored.close(); await new Promise((resolve) => blocker.close(resolve)); }
});

test("temporary close resumes the same instance and port; permanent shutdown cannot resume", async (t) => {
  const { gateway } = await fixture(t), grant = await gateway.configure("alpha", { actionIds: ["analyze"], deliveryVersion: "delivery-one" });
  await gateway.close(); assert.equal((await gateway.config("alpha")).status, "suspended");
  await gateway.resume(); assert.equal((await gateway.config("alpha")).port, grant.port);
  assert.equal((await fetch(`${grant.apiUrl}/actions`, { headers: headers(grant.token) })).status, 200);
  await gateway.close({ permanent: true }); await assert.rejects(gateway.resume(), { reason: "gateway_closed" });
});
