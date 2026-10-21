import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { AgentStorage } from "../src/agents/agent-storage.mjs";
import { ServiceGateway } from "../src/services/service-gateway.mjs";
import { canonicalGatewayRequest } from "../src/applications/input-framing.mjs";
import { validateActionInput, validateActionOutput } from "../src/applications/application-contract.mjs";

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

test("HTTP admission preserves a safe input field location and distinguishes output defects", async (t) => {
  const { gateway, agents, tasks } = await fixture(t);
  const object = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
  const schema = object({ records: { type: "array", items: object({ bytes: { type: "integer" } }) } });
  const action = { id: "analyze", title: "输入校验", inputSchema: schema, outputSchema: schema };
  agents.applications.descriptor = async () => ({ deliveryVersion: "delivery-one", manifest: { actions: [action] } });
  let generatedCalls = 0;
  agents.applications.submit = async (_id, body) => { validateActionInput(action, body.input); generatedCalls++;
    validateActionOutput(action, { records: [{ bytes: false }] }); };
  const grant = await gateway.configure("alpha", { actionIds: [action.id], deliveryVersion: "delivery-one" });
  const submit = (input) => fetch(`${grant.apiUrl}/tasks`, { method: "POST", headers: headers(grant.token),
    body: JSON.stringify({ actionId: action.id, input, mutationId: "admission_fixture", deliveryVersion: "delivery-one" }) });
  const rejected = await submit({ records: [{ bytes: true }] }); assert.equal(rejected.status, 400);
  const error = await rejected.json(); assert.equal(error.reason, "input_contract_rejected");
  assert.deepEqual(error.validationIssue, { path: "input.records.0.bytes", reason: "invalid_type" });
  assert.match(error.error, /input\.records\.0\.bytes/); assert.equal(generatedCalls, 0); assert.equal(tasks.size, 0);
  const secret = "private_input_key_do_not_echo";
  const unknown = await (await submit({ records: [{ bytes: 1, [secret]: secret }] })).json();
  assert.equal(JSON.stringify(unknown).includes(secret), false); assert.equal(unknown.validationIssue.path, "input.records.0");
  const brokenOutput = await submit({ records: [{ bytes: 1 }] }); assert.equal(brokenOutput.status, 500);
  assert.deepEqual(await brokenOutput.json(), { reason: "gateway_failed", error: "接口调用未完成，请检查操作与运行状态" });
});

test("MCP preserves controlled bounded-JSON rejection and hides untrusted error text", async (t) => {
  const { gateway, agents } = await fixture(t);
  const schema = { type: "object", properties: { data: {} }, required: ["data"], additionalProperties: false };
  const action = { id: "analyze", title: "受限JSON", inputSchema: schema, outputSchema: { type: "object" } };
  agents.applications.descriptor = async () => ({ deliveryVersion: "delivery-one", manifest: { actions: [action] } });
  agents.applications.submit = async (_id, body) => { validateActionInput(action, body.input); throw new Error("private_backend_error_do_not_echo"); };
  const grant = await gateway.configure("alpha", { actionIds: [action.id], deliveryVersion: "delivery-one" });
  const client = new Client({ name: "admission-fixture", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(grant.mcpUrl), { requestInit: { headers: headers(grant.token) } }));
  t.after(() => client.close());
  let data = 1; for (let index = 0; index < 35; index++) data = { private_dynamic_key: data };
  const rejected = await client.callTool({ name: "run_analyze", arguments: { input: { data }, mutationId: "mcp_admission_fixture", deliveryVersion: "delivery-one" } });
  assert.equal(rejected.isError, true); const error = JSON.parse(rejected.content[0].text);
  assert.equal(error.reason, "input_contract_rejected"); assert.equal(error.validationIssue.reason, "json_limit");
  assert.match(error.validationIssue.path, /^input\.data(?:\[JSON\])+$/); assert.doesNotMatch(JSON.stringify(error), /private_dynamic_key/);
  const unknown = await client.callTool({ name: "run_analyze", arguments: { input: { data: 1 }, mutationId: "mcp_unknown_fixture", deliveryVersion: "delivery-one" } });
  assert.equal(unknown.isError, true); assert.doesNotMatch(JSON.stringify(unknown), /private_backend_error/);
  agents.applications.submit = async () => { throw Object.assign(new Error("private_forged_error"), { reason: "input_contract_rejected",
    validationIssue: { path: "input.data", reason: "invalid_type" } }); };
  const forged = await (await fetch(`${grant.apiUrl}/tasks`, { method: "POST", headers: headers(grant.token), body: JSON.stringify({ actionId: action.id,
    input: { data: 1 }, mutationId: "forged_error_fixture", deliveryVersion: "delivery-one" }) })).json();
  assert.deepEqual(forged, { reason: "gateway_failed", error: "接口调用未完成，请检查操作与运行状态" });
});

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
  const catalog = await client.listTools(); assert.deepEqual(catalog.tools.map((tool) => tool.name).sort(), ["cancel_task", "get_task", "read_artifact", "run_analyze"]);
  const result = await client.callTool({ name: "run_analyze", arguments: { input: { text: "hello" }, mutationId: "mcp-request-one", deliveryVersion: "delivery-one" } });
  const taskId = result.structuredContent.taskId; assert.ok(tasks.has(taskId)); assert.equal(tasks.get(taskId).source.scope, "private");
  const status = await client.callTool({ name: "get_task", arguments: { taskId, deliveryVersion: "delivery-one" } }); assert.equal(status.structuredContent.status, "queued");
  const cancelled = await client.callTool({ name: "cancel_task", arguments: { taskId, deliveryVersion: "delivery-one" } }); assert.equal(cancelled.structuredContent.status, "cancelled");
  const stale = await client.callTool({ name: "run_analyze", arguments: { input: { text: "hello" }, mutationId: "mcp-request-two", deliveryVersion: "old" } }); assert.equal(stale.isError, true); assert.equal(tasks.size, 1);
});

test("规范API/MCP信封真实进入同一任务服务，任意增长的空白或可选元数据按完整请求拒绝", async (t) => {
  const { gateway, tasks } = await fixture(t), grant = await gateway.configure("alpha", { actionIds: ["analyze"], deliveryVersion: "delivery-one" });
  const input = { text: '中文😀"\\\n'.repeat(1000) };
  const api = canonicalGatewayRequest({ protocol: "api", actionId: "analyze", input, mutationId: "canonical-api", deliveryVersion: "delivery-one" });
  const accepted = await fetch(`${grant.apiUrl}/tasks`, { method: "POST", headers: headers(grant.token), body: JSON.stringify(api) });
  assert.equal(accepted.status, 202); await accepted.json(); assert.equal(tasks.size, 1);
  const tooMuchWhitespace = await fetch(`${grant.apiUrl}/tasks`, { method: "POST", headers: headers(grant.token), body: JSON.stringify(api) + " ".repeat(262144) });
  assert.equal(tooMuchWhitespace.status, 413); await tooMuchWhitespace.text(); assert.equal(tasks.size, 1);
  const mcp = canonicalGatewayRequest({ protocol: "mcp", actionId: "analyze", input, mutationId: "canonical-mcp", deliveryVersion: "delivery-one" });
  const mcpHeaders = { ...headers(grant.token), accept: "application/json, text/event-stream" };
  const mcpAccepted = await fetch(grant.mcpUrl, { method: "POST", headers: mcpHeaders, body: JSON.stringify(mcp) });
  assert.equal(mcpAccepted.status, 200); const result = await mcpAccepted.json(); assert.ok(result.result.structuredContent.taskId); assert.equal(tasks.size, 2);
  const oversized = { ...mcp, params: { ...mcp.params, _meta: { diagnostic: "x".repeat(262144) } } };
  const rejected = await fetch(grant.mcpUrl, { method: "POST", headers: mcpHeaders, body: JSON.stringify(oversized) });
  assert.equal(rejected.status, 413); await rejected.text(); assert.equal(tasks.size, 2);
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

test("configure verifies real authorized HTTP and MCP catalogs without running business actions, and invalidates replaced/revoked evidence", async (t) => {
  const { gateway, agents, tasks } = await fixture(t), verified = [], invalidated = [];
  agents.verifyGatewayAcceptance = async (value) => { verified.push(value); };
  agents.invalidateGatewayAcceptance = async (value) => { invalidated.push(value); };
  const first = await gateway.configure("alpha", { actionIds: ["analyze"], deliveryVersion: "delivery-one" });
  assert.equal(first.verification.status, "passed"); assert.equal(tasks.size, 0);
  assert.equal(verified.length, 1); assert.equal(verified[0].agentId, "alpha");
  assert.deepEqual(verified[0].evidence.api, { actions: ["analyze"], status: 200 });
  assert.deepEqual(verified[0].evidence.mcp.tools, ["cancel_task", "get_task", "read_artifact", "run_analyze"]);
  assert.equal(JSON.stringify(verified).includes(first.token), false);
  const second = await gateway.configure("alpha", { actionIds: ["analyze"], deliveryVersion: "delivery-one" });
  assert.equal(second.verification.status, "passed"); assert.equal(tasks.size, 0); assert.equal(invalidated.length, 1);
  assert.notEqual(verified[0].evidence.grantId, verified[1].evidence.grantId);
  await gateway.revoke("alpha");
  assert.deepEqual(invalidated.map((entry) => entry.grantId), verified.map((entry) => entry.evidence.grantId));
});

test("failed real MCP discovery persists failed acceptance evidence instead of leaving an unconfigured pending exemption", async (t) => {
  const { gateway, agents, tasks } = await fixture(t), calls = [], ledger = { status: "not_run" };
  agents.verifyGatewayAcceptance = async (value) => { calls.push(value); ledger.status = value.evidence.status; };
  gateway.mcp = async (_id, _grant, _descriptor, _request, response) => {
    response.writeHead(503, { "content-type": "application/json" }); response.end('{"error":"local_fixture_unavailable"}');
  };
  const grant = await gateway.configure("alpha", { actionIds: ["analyze"], deliveryVersion: "delivery-one" });
  assert.equal(grant.verification.status, "failed"); assert.equal(ledger.status, "failed"); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].evidence.actionIds, ["analyze"]); assert.equal(calls[0].deliveryVersion, "delivery-one");
  assert.equal(calls[0].evidence.grantId, (await gateway.record("alpha")).grantId);
  assert.equal(calls[0].evidence.mode, "actual"); assert.equal(calls[0].evidence.reason, "gateway_verification_failed");
  assert.equal(JSON.stringify(calls).includes(grant.token), false); assert.equal(tasks.size, 0);
});

test("gateway artifact API and MCP read only the grant task's registered immutable snapshots with bounded byte pages", async (t) => {
  const { gateway, agents, tasks } = await fixture(t), grant = await gateway.configure("alpha", { actionIds: ["analyze"], deliveryVersion: "delivery-one" });
  const content = Buffer.from('中文😀\\"\n'.repeat(12000)), digest = createHash("sha256").update(content).digest("hex");
  let reads = 0;
  agents.readTaskArtifact = async (id, taskId, index, { offset, limit }) => {
    reads++; assert.equal(id, "alpha"); assert.equal(index, 0); assert.equal(tasks.get(taskId).artifacts[0].snapshotId, "snapshot_one");
    const end = Math.min(offset + limit, content.length);
    return { name: "report.json", path: "reports/report.json", size: content.length, sha256: digest, offset,
      nextOffset: end < content.length ? end : null, encoding: "base64", data: content.subarray(offset, end).toString("base64") };
  };
  const submitted = await (await fetch(`${grant.apiUrl}/tasks`, { method: "POST", headers: headers(grant.token),
    body: JSON.stringify({ actionId: "analyze", input: { text: "fixture" }, mutationId: "artifact_fixture", deliveryVersion: "delivery-one" }) })).json();
  tasks.get(submitted.taskId).artifacts = [{ path: "reports/report.json", snapshotId: "snapshot_one" }];
  const prefix = `${grant.apiUrl}/tasks/${submitted.taskId}/artifacts/0?deliveryVersion=delivery-one`;
  const parts = []; let offset = 0;
  for (;;) {
    const response = await fetch(`${prefix}&offset=${offset}`, { headers: headers(grant.token) });
    assert.equal(response.status, 200); const page = await response.json();
    assert.equal(page.sha256, digest); assert.equal(page.size, content.length); assert.equal(page.path, undefined);
    assert.equal(page.name, "report.json"); parts.push(Buffer.from(page.data, "base64"));
    if (page.nextOffset === null) break; assert.ok(page.nextOffset > offset); offset = page.nextOffset;
  }
  assert.deepEqual(Buffer.concat(parts), content); assert.ok(reads > 1);
  const before = reads;
  for (const query of ["&offset=-1", "&limit=65537", "&path=reports/report.json", "&offset=NaN"]) {
    assert.equal((await fetch(`${prefix}${query}`, { headers: headers(grant.token) })).status, 400);
  }
  assert.equal(reads, before);
  assert.equal((await fetch(prefix.replace("artifacts/0", "artifacts/1"), { headers: headers(grant.token) })).status, 404);
  assert.equal((await fetch(prefix.replace("delivery-one", "old"), { headers: headers(grant.token) })).status, 409);
  const client = new Client({ name: "artifact-fixture", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(grant.mcpUrl), { requestInit: { headers: headers(grant.token) } }));
  t.after(() => client.close());
  const mcp = await client.callTool({ name: "read_artifact", arguments: { taskId: submitted.taskId, artifactIndex: 0,
    deliveryVersion: "delivery-one", offset: 2, limit: 17 } });
  assert.notEqual(mcp.isError, true); assert.deepEqual(Buffer.from(mcp.structuredContent.data, "base64"), content.subarray(2, 19));
  assert.equal(mcp.structuredContent.nextOffset, 19);
  const replacement = await gateway.configure("alpha", { actionIds: ["analyze"], deliveryVersion: "delivery-one" });
  assert.equal((await fetch(prefix, { headers: headers(replacement.token) })).status, 404);
  assert.equal(reads, before + 1);
});

test("artifact read rechecks revocation after host I/O and never returns a late snapshot", async (t) => {
  const { gateway, agents, tasks } = await fixture(t), grant = await gateway.configure("alpha", { actionIds: ["analyze"], deliveryVersion: "delivery-one" });
  const submitted = await gateway.submit("alpha", await gateway.record("alpha"), { actionId: "analyze", input: { text: "fixture" },
    mutationId: "artifact_race_fixture", deliveryVersion: "delivery-one" });
  tasks.get(submitted.taskId).artifacts = [{ path: "report.json", snapshotId: "snapshot_one" }];
  let start, finish;
  const started = new Promise((resolve) => { start = resolve; }), release = new Promise((resolve) => { finish = resolve; });
  agents.readTaskArtifact = async () => { start(); await release;
    return { name: "report.json", size: 1, sha256: createHash("sha256").update("x").digest("hex"), offset: 0, nextOffset: null, encoding: "base64", data: "eA==" }; };
  const pending = fetch(`${grant.apiUrl}/tasks/${submitted.taskId}/artifacts/0?deliveryVersion=delivery-one`, { headers: headers(grant.token) });
  await started;
  await gateway.configure("alpha", { actionIds: ["analyze"], deliveryVersion: "delivery-one" }); finish();
  const response = await pending; assert.equal(response.status, 401); assert.equal((await response.json()).data, undefined);
});

for (const operation of ["task", "list"]) for (const change of ["grant", "delivery"]) {
  test(`${operation} read rechecks ${change} after storage I/O and never returns late task results`, { timeout: 15000 }, async (t) => {
    const { gateway, agents, tasks, setVersion } = await fixture(t);
    const grant = await gateway.configure("alpha", { actionIds: ["analyze"], deliveryVersion: "delivery-one" });
    const submitted = await gateway.submit("alpha", await gateway.record("alpha"), { actionId: "analyze", input: { text: "fixture" },
      mutationId: `${operation}_${change}_race_fixture`, deliveryVersion: "delivery-one" });
    tasks.get(submitted.taskId).result = { privateResult: "must-not-return-after-change" };
    const method = operation === "task" ? "get" : "list", original = agents.applications.store[method];
    let entered, release;
    const started = new Promise((resolve) => { entered = resolve; }), blocked = new Promise((resolve) => { release = resolve; });
    agents.applications.store[method] = async (...args) => {
      const result = await original(...args); entered(); await blocked; return result;
    };
    const url = `${grant.apiUrl}/tasks${operation === "task" ? `/${submitted.taskId}` : ""}?deliveryVersion=delivery-one`;
    const pending = fetch(url, { headers: headers(grant.token) });
    try {
      await started;
      if (change === "grant") await gateway.configure("alpha", { actionIds: ["analyze"], deliveryVersion: "delivery-one" });
      else setVersion("delivery-two");
    } finally { release(); }
    const response = await pending, result = await response.json();
    assert.equal(response.status, change === "grant" ? 401 : 409);
    assert.equal(result.reason, change === "grant" ? "gateway_unauthorized" : "delivery_changed");
    assert.doesNotMatch(JSON.stringify(result), /privateResult|must-not-return-after-change/);
  });
}

const pauseOnce = (target, method, occurrence = 1) => {
  const original = target[method].bind(target);
  let entered, release, calls = 0;
  const started = new Promise((resolve) => { entered = resolve; }), blocked = new Promise((resolve) => { release = resolve; });
  target[method] = async (...args) => {
    const result = await original(...args);
    if (++calls === occurrence) { entered(); await blocked; }
    return result;
  };
  return { started, release };
};

async function memoryGrant(t) {
  const old = { developmentRef: { id: "build-one" }, execution: { kind: "node-action", codeHash: "a".repeat(64) } };
  const version = (agent) => `${agent.developmentRef.id}:${agent.execution.codeHash}`;
  let stored = { schemaVersion: 1, agentId: "alpha", enabled: true, port: 12345, deliveryVersion: version(old),
    actionIds: ["analyze"], tokenHash: "a".repeat(64), grantId: "initial-grant" };
  const storage = { ready: Promise.resolve(), agentIds: async () => [], readJson: async () => structuredClone(stored),
    writeJson: async (_id, _file, value) => { stored = structuredClone(value); } };
  const agents = { storage, agents: new Map([["alpha", old]]), applications: { descriptor: async () => {
    const agent = agents.agents.get("alpha");
    return { agent, deliveryVersion: version(agent), manifest: { actions: [{ id: "analyze" }] } };
  } } };
  const gateway = new ServiceGateway({ agents }); await gateway.ready;
  gateway.listen = async () => 12345;
  gateway.verify = async () => ({ status: "passed", mode: "actual" });
  t.after(() => gateway.close());
  return { gateway, agents, storage, grant: structuredClone(stored) };
}

for (const waitFor of ["record", "descriptor"]) for (const change of ["revoke", "rotate", "delivery"]) {
  test(`central grant check rejects ${change} while ${waitFor} retains an old read`, { timeout: 15000 }, async (t) => {
    const { gateway, agents, grant } = await memoryGrant(t);
    const pause = pauseOnce(waitFor === "record" ? gateway : agents.applications, waitFor);
    const pending = gateway.currentGrant("alpha", grant);
    const rejected = assert.rejects(pending, { reason: change === "delivery" ? "delivery_changed" : "gateway_unauthorized",
      statusCode: change === "delivery" ? 409 : 401 });
    await pause.started;
    try {
      if (change === "revoke") await gateway.revoke("alpha");
      else if (change === "rotate") await gateway.configure("alpha", { actionIds: ["analyze"], deliveryVersion: grant.deliveryVersion });
      else agents.agents.set("alpha", { developmentRef: { id: "build-two" }, execution: { kind: "node-action", codeHash: "b".repeat(64) } });
    } finally { pause.release(); }
    await rejected;
  });
}

test("central grant check rejects in-place delivery mutation and failed authorization writes do not revoke a valid grant", async (t) => {
  {
    const { gateway, agents, grant } = await memoryGrant(t), pause = pauseOnce(agents.applications, "descriptor");
    const pending = gateway.currentGrant("alpha", grant), rejected = assert.rejects(pending, { reason: "delivery_changed", statusCode: 409 });
    await pause.started; agents.agents.get("alpha").execution.codeHash = "b".repeat(64); pause.release(); await rejected;
  }
  {
    const { gateway, agents, storage, grant } = await memoryGrant(t), pause = pauseOnce(agents.applications, "descriptor");
    const pending = gateway.currentGrant("alpha", grant); await pause.started;
    storage.writeJson = async () => { throw new Error("fixture-only write failure"); };
    try { await assert.rejects(gateway.configure("alpha", { actionIds: ["analyze"], deliveryVersion: grant.deliveryVersion }), { reason: "gateway_persistence_failed" }); }
    finally { pause.release(); }
    assert.equal((await pending).deliveryVersion, grant.deliveryVersion);
  }
});

test("revocation during a descriptor failure still returns the controlled authorization status", async (t) => {
  const { gateway, agents, grant } = await memoryGrant(t);
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; }), blocked = new Promise((resolve) => { release = resolve; });
  agents.applications.descriptor = async () => { entered(); await blocked; throw new Error("private fixture descriptor failure"); };
  const pending = gateway.currentGrant("alpha", grant), rejected = assert.rejects(pending,
    (error) => error.reason === "gateway_unauthorized" && error.statusCode === 401 && !error.message.includes("private fixture"));
  await started;
  try { await gateway.revoke("alpha"); } finally { release(); }
  await rejected;
});

for (const waitFor of ["record", "descriptor"]) for (const change of ["grant", "delivery"]) {
  test(`HTTP authentication rejects ${change} during its central ${waitFor} check`, { timeout: 15000 }, async (t) => {
    const { gateway, agents } = await fixture(t);
    agents.agents = new Map([["alpha", { developmentRef: { id: "build-one" }, execution: { kind: "node-action", codeHash: "a".repeat(64) } }]]);
    const original = agents.applications.descriptor;
    agents.applications.descriptor = async () => {
      const descriptor = await original(), agent = agents.agents.get("alpha");
      return { ...descriptor, agent, deliveryVersion: `${agent.developmentRef.id}:${agent.execution.codeHash}` };
    };
    const deliveryVersion = `build-one:${"a".repeat(64)}`;
    const grant = await gateway.configure("alpha", { actionIds: ["analyze"], deliveryVersion });
    assert.equal(grant.verification.status, "passed");
    const pause = pauseOnce(waitFor === "record" ? gateway : agents.applications, waitFor, waitFor === "record" ? 2 : 1);
    const pending = fetch(`${grant.apiUrl}/actions`, { headers: headers(grant.token) });
    await pause.started;
    try {
      if (change === "grant") await gateway.configure("alpha", { actionIds: ["analyze"], deliveryVersion });
      else agents.agents.set("alpha", { developmentRef: { id: "build-two" }, execution: { kind: "node-action", codeHash: "b".repeat(64) } });
    } finally { pause.release(); }
    const response = await pending, result = await response.json();
    assert.equal(response.status, change === "grant" ? 401 : 409);
    assert.equal(result.reason, change === "grant" ? "gateway_unauthorized" : "delivery_changed");
    assert.equal(result.actions, undefined);
  });
}
