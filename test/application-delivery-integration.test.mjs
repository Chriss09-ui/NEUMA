import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrototypeAgents } from "../src/agents/agent-prototype.mjs";
import { DevelopmentExecutor } from "../src/development/development-executor.mjs";
import { hashValue } from "../src/development/development-contract.mjs";
import { createApp } from "../src/server.mjs";
import { startLinkApplicationModel, linkApplicationDraft, LINK_APPLICATION_WEB, LINK_APPLICATION_FILES } from "./helpers/link-application-fixture.mjs";
async function unseal(path) { await chmod(path, 0o700); for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await unseal(join(path, entry.name)); }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const id = "link-research", route = `/api/agents/${id}`;
async function stopServer(server) {
  await server.dispose(); server.closeAllConnections();
  if (server.listening) await new Promise(done => server.close(done));
}
async function fixture(t, { businessArchive = false, inputRejection = false } = {}) {
  const probe = await new DevelopmentExecutor().probe();
  if (!probe.available) { if (process.env.NEUMA_REQUIRE_ISOLATION === "1") assert.fail(probe.reason); t.skip(probe.reason); return null; }
  const root = await mkdtemp(join(tmpdir(), "neuma-link-delivery-")), dataDir = join(root, "data"), model = await startLinkApplicationModel({ businessArchive, inputRejection });
  const calls = [], servers = [], instances = [], actionInvocations = []; let blocked;
  const web = {
    async fetch(input, options = {}) {
      calls.push({ method: "fetch", input: structuredClone(input), scope: options.scope });
      if (blocked) {
        const gate = blocked; blocked = null;
        options.signal?.addEventListener("abort", () => { gate.aborted = true; gate.release.resolve(); }, { once: true });
        gate.entered.resolve(); await gate.release.promise; options.signal?.throwIfAborted();
      }
      return LINK_APPLICATION_WEB.fetch(input);
    },
    async search(input, options = {}) { calls.push({ method: "search", input: structuredClone(input), scope: options.scope }); return LINK_APPLICATION_WEB.search(input); },
  };
  async function open(agents) {
    const server = createApp({ config: model.config, dataDir, prototypeAgents: agents, providers: {},
      projects: { dispose: async () => {} }, projectAgent: { dispose: async () => {} }, skillManager: { dispose: async () => {} } });
    await server.ready;
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    servers.push(server); const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (path, { method = "GET", body, status = 200, headers = {} } = {}) => {
      const response = await fetch(base + path, { method, headers: { origin: base, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
    };
    return { server, base, api };
  }
  const createAgents = () => {
    const agents = new PrototypeAgents({ config: model.config, cwd: root, dataDir, web });
    if (inputRejection) {
      const execute = agents.development.executor.runAction.bind(agents.development.executor);
      agents.development.executor.runAction = (request) => { actionInvocations.push({ actionId: request.actionId, input: structuredClone(request.input) }); return execute(request); };
    }
    instances.push(agents); return agents;
  };
  const agents = createAgents(), draft = linkApplicationDraft();
  if (businessArchive) {
    draft.task.value += "，用户选择资料后可归档到已配置业务服务";
    draft.externalAction = { mode: "requested", operation: "归档资料", target: "用户配置的归档服务", scope: "用户明确选中的资料", trigger: "用户主动点击归档动作", source: "user" };
    draft.connections.push({ purpose: "business", required: true, description: "用户指定的资料归档服务" });
  }
  t.after(async () => {
    blocked?.release.resolve();
    for (const server of servers) await stopServer(server);
    for (const instance of instances) await instance.close();
    await model.close(); await unseal(root); await rm(root, { recursive: true, force: true });
  });
  const result = await agents.build({ id, name: "链接资料搜寻工具", draft });
  assert.deepEqual(model.errors, []); assert.equal(result.architecture.contractVersion, 2);
  assert.equal(result.architecture.design.profile, "light"); assert.equal(result.development?.status, "completed", JSON.stringify(result.development));
  assert.equal(result.agent.execution.kind, "node-action");
  return { root, dataDir, model, agents, result, calls, actionInvocations, createAgents, open, ...await open(agents),
    blockNext: () => { const gate = { entered: deferred(), release: deferred(), aborted: false }; blocked = gate; return gate; } };
}

// Models and web providers are controlled substitutes. Pi sessions, the five-stage
// controller, OS isolation, task/state persistence, HTTP routes and files are real.
test("input rejection evidence remains serializable through real SDK, packaging and activation without running the rejected action", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, { inputRejection: true }); if (!f) return;
  const record = await f.agents.development.store.get(id);
  assert.equal(record.delivery, "ready"); assert.equal(record.deliveries.at(-1).status, "activated");
  assert.equal(f.result.agent.status, "ready");
  let expectedInvocations = 0;
  for (const report of record.reports) {
    assert.doesNotThrow(() => hashValue(report));
    const rejected = report.results.find((item) => item.caseId === "case_schema_rejection");
    assert.equal(rejected.status, "passed"); assert.equal(rejected.stage, "input-validation"); assert.equal(rejected.actionExecuted, false);
    assert.equal(rejected.exitCode, null); assert.equal(rejected.stdout, ""); assert.equal(rejected.stderr, "");
    assert.deepEqual(rejected.actual, { rejected: true, reason: "input_contract_rejected" });
    expectedInvocations += report.results.filter((item) => item.kind !== "input-rejection").length;
  }
  assert.equal(f.actionInvocations.length, expectedInvocations);
  assert.ok(f.actionInvocations.every((item) => item.actionId !== "analyze" || typeof item.input.url === "string"));
  const deliveryVersion = (await f.api(`${route}/application`)).deliveryVersion;
  const before = f.actionInvocations.length;
  await f.api(`${route}/tasks`, { method: "POST", body: { actionId: "analyze", input: { url: 17, refresh: false }, mutationId: "reject-after-activation", deliveryVersion }, status: 400 });
  assert.equal(f.actionInvocations.length, before, "实际入口拒绝也不启动业务进程");
  const task = await f.api(`${route}/tasks`, { method: "POST", body: { actionId: "analyze", input: { url: "", refresh: false }, mutationId: "business-after-activation", deliveryVersion } });
  assert.equal((await f.agents.applications.wait(id, task.taskId)).result.status, "missing_input");
  assert.equal(f.actionInvocations.length, before + 1, "合法容器中的业务负例真实运行");
});

test("real Pi v2 application delivers and executes through HTTP with progress, idempotency, cancellation, group isolation and restart recovery", { timeout: 30000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const { agents, model, api } = f;
  const record = await agents.development.store.get(id);
  assert.equal(record.planningArtifact.indexPath, "index.json");
  assert.deepEqual((await agents.development.artifacts.validateSnapshot(record.planningArtifact, id)).plan, record.plan);
  assert.equal(record.package.runtime, "node-action"); assert.equal(record.package.application.protocolVersion, 2);
  assert.equal(record.reports.at(-1).evidenceMode, "mock_capabilities"); assert.equal(record.reports.at(-1).connectionVerified, false);
  assert.deepEqual(record.package.application.evidenceIds, [record.package.verificationId]);
  for (const [path, content] of Object.entries(LINK_APPLICATION_FILES)) assert.equal(await readFile(join(record.package.snapshot.path, path), "utf8"), content);
  assert.ok(record.package.application.page.resources.every(item => /^[a-f0-9]{64}$/.test(item.sha256)));
  assert.deepEqual(record.reviews.map(item => item.mode), ["plan", "task", "integration"]);
  assert.ok(model.requests.some(item => item.name === "submit_architecture_review"));
  assert.ok(model.requests.filter(item => item.name === "submit_development_review").every(item => !item.tools.includes("web_fetch")));

  const summary = await api(`${route}/application`), deliveryVersion = summary.deliveryVersion;
  assert.equal(summary.pageReady, true); assert.deepEqual(summary.actions.map(action => [action.id, action.ready]), [["analyze", true], ["exportCsv", true]]);
  assert.equal((await api(route)).application.deliveryVersion, deliveryVersion);
  const firstWindow = await api(`${route}/application/open`, { method: "POST", body: {} });
  const secondWindow = await api(`${route}/application/open`, { method: "POST", body: {} });
  assert.notEqual(firstWindow.origin, f.base); assert.notEqual(firstWindow.instanceId, secondWindow.instanceId);
  const pageResponse = await fetch(firstWindow.url), page = await pageResponse.text();
  assert.equal(pageResponse.status, 200); assert.match(page, /__NEUMA_APPLICATION__/); assert.match(page, /读取并搜寻/);
  assert.match(pageResponse.headers.get("content-security-policy"), /connect-src 'none'/);
  assert.equal((await fetch(`${firstWindow.origin}/${firstWindow.instanceId}/actions.mjs`)).status, 404);

  const initialState = await api(`${route}/application/state`);
  const draft = { url: "https://example.com/article", filter: "公开", refresh: true };
  const savedState = await api(`${route}/application/state`, { method: "PUT", body: { state: draft, expectedVersion: initialState.version, deliveryVersion } });
  assert.deepEqual((await api(`${route}/application/state`)).state, draft);
  await api(`${route}/application/state`, { method: "PUT", body: { state: { url: "stale window" }, expectedVersion: initialState.version, deliveryVersion }, status: 409 });
  assert.equal((await api(`${route}/application/state`)).version, savedState.version);

  const submission = { actionId: "analyze", input: { url: draft.url, refresh: true }, mutationId: "http-link-analysis-001", deliveryVersion };
  const [first, duplicate] = await Promise.all([api(`${route}/tasks`, { method: "POST", body: submission }), api(`${route}/tasks`, { method: "POST", body: submission })]);
  assert.equal(first.taskId, duplicate.taskId);
  const analyzed = await agents.applications.wait(id, first.taskId);
  assert.equal(analyzed.status, "completed", JSON.stringify(analyzed)); assert.equal(analyzed.result.items.length, 2);
  assert.deepEqual(f.calls.map(call => call.method), ["fetch", "search"]);
  assert.equal((await api(`${route}/tasks/${first.taskId}`)).task.result.items[0].url, draft.url);
  const events = await api(`${route}/tasks/${first.taskId}/events`);
  assert.ok(events.events.some(event => event.type === "progress" && event.progress.percent === 55));
  assert.ok(events.events.some(event => event.type === "completed"));
  const replayResponse = await fetch(`${f.base}${route}/tasks/${first.taskId}/events?after=${events.events[1].seq}`, { headers: { accept: "application/x-ndjson", origin: f.base } });
  const replay = (await replayResponse.text()).trim().split("\n").map(JSON.parse);
  assert.equal(replay.at(-1).type, "done"); assert.ok(replay.slice(0, -1).every(event => event.seq > events.events[1].seq));
  assert.equal((await api(`${route}/tasks`)).tasks.filter(task => task.id === first.taskId).length, 1);

  await api(`${route}/tasks`, { method: "POST", body: { ...submission, input: { ...submission.input, url: "https://example.com/other" } }, status: 409 });
  await api(`${route}/tasks`, { method: "POST", body: { ...submission, mutationId: "wrong-version-001", deliveryVersion: "stale-version" }, status: 400 });
  await api(`${route}/tasks`, { method: "POST", body: { ...submission, mutationId: "forged-scope-001", source: { kind: "group", scope: "group/victim" } }, status: 400 });
  await api(`${route}/tasks`, { method: "POST", body: { ...submission, mutationId: "cross-origin-001" }, headers: { origin: "https://outside.example" }, status: 403 });

  const exported = await api(`${route}/tasks`, { method: "POST", body: { actionId: "exportCsv", input: { items: analyzed.result.items }, mutationId: "http-link-export-001", deliveryVersion } });
  const exportTask = await agents.applications.wait(id, exported.taskId);
  assert.equal(exportTask.status, "completed", JSON.stringify(exportTask)); assert.deepEqual(exportTask.artifacts.map((item) => item.path), ["link-results.csv"]);
  const csv = await readFile(join(await agents.workspace(id), "link-results.csv"), "utf8");
  assert.match(csv, /公开网页/); assert.match(csv, /https:\/\/example.com\/related/);
  const frozenCsv = await api(`${route}/tasks/${exportTask.id}/artifacts/0`);
  assert.equal(Buffer.from(frozenCsv.data, "base64").toString("utf8"), csv);
  assert.equal(frozenCsv.size, Buffer.byteLength(csv)); assert.match(frozenCsv.sha256, /^[a-f0-9]{64}$/);
  assert.equal((await api(`${route}/file?path=link-results.csv`)).content, csv);
  assert.ok((await api(`${route}/files`)).files.some(file => file.path === "link-results.csv"));

  // Closing a resource instance only ends viewing; the independently persisted
  // operation keeps its scheduler lease and completes after its capability reply.
  const detached = f.blockNext();
  const detachedTask = await api(`${route}/tasks`, { method: "POST", body: { ...submission, mutationId: "http-detached-001" } });
  await detached.entered.promise;
  await api(`${route}/application/close`, { method: "POST", body: { instanceId: firstWindow.instanceId } });
  await assert.rejects(fetch(firstWindow.url));
  detached.release.resolve(); assert.equal((await agents.applications.wait(id, detachedTask.taskId)).status, "completed");
  assert.equal((await fetch(secondWindow.url)).status, 200);

  const cancelling = f.blockNext();
  const cancelledTask = await api(`${route}/tasks`, { method: "POST", body: { ...submission, mutationId: "http-cancel-001" } });
  await cancelling.entered.promise;
  const cancelled = await api(`${route}/tasks/${cancelledTask.taskId}/cancel`, { method: "POST", body: {} });
  assert.equal(cancelled.task.status, "cancelled");
  const terminal = await agents.applications.wait(id, cancelledTask.taskId);
  assert.equal(terminal.status, "cancelled"); assert.equal(terminal.result, null); assert.equal(cancelling.aborted, true);

  // The conversation/group tools already own the Agent's scheduler lease.
  // Re-acquiring that lease would deadlock; the delivered action uses it directly.
  const scope = "group-tasks/research-group/root-task/link-research";
  const groupRoot = await agents.storage.directory(id, `workspace/${scope}`, { create: true });
  const privateCsv = csv;
  const lease = await agents.scheduler.acquire({ agentId: id });
  let groupReply;
  try {
    const [tool] = await agents.applications.tools(agents.agents.get(id), { scope, workspaceRoot: groupRoot, materialTools: [] });
    groupReply = JSON.parse((await tool.execute("group-export-001", { actionId: "exportCsv", input: { items: [] } }, lease.signal)).content[0].text);
  } finally { lease.release(); }
  assert.equal(groupReply.status, "completed");
  assert.equal(await readFile(join(groupRoot, "link-results.csv"), "utf8"), "标题,网址,正文或摘要,是否截断\n");
  assert.equal(await readFile(join(await agents.workspace(id), "link-results.csv"), "utf8"), privateCsv);
  await api(`${route}/tasks/${groupReply.taskId}`, { status: 400 });
  assert.ok((await api(`${route}/tasks`)).tasks.every(task => task.source.scope === "private"));

  // A real service stop aborts the unfinished action; a fresh Agent/service
  // instance reads the same persisted drafts/results without replaying requests.
  const stopping = f.blockNext();
  const interruptedTask = await api(`${route}/tasks`, { method: "POST", body: { ...submission, mutationId: "http-restart-001" } });
  await stopping.entered.promise; await stopServer(f.server);
  assert.equal(stopping.aborted, true); const callsBeforeRestart = f.calls.length;
  const restoredAgents = f.createAgents(), restarted = await f.open(restoredAgents);
  assert.equal((await restarted.api(`${route}/tasks/${interruptedTask.taskId}`)).task.status, "interrupted");
  assert.equal((await restarted.api(`${route}/tasks/${exported.taskId}`)).task.status, "completed");
  assert.deepEqual((await restarted.api(`${route}/application/state`)).state, draft);
  assert.equal((await restarted.api(`${route}/application`)).pageReady, true);
  assert.equal(f.calls.length, callsBeforeRestart);
  const repeated = await restarted.api(`${route}/tasks`, { method: "POST", body: submission });
  assert.equal(repeated.taskId, first.taskId); assert.equal(f.calls.length, callsBeforeRestart);
});

test("a real v2 delivery with a missing required business connection still opens its page and runs independent actions", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, { businessArchive: true }); if (!f) return;
  const summary = await f.api(`${route}/application`);
  assert.equal(summary.pageReady, true);
  assert.deepEqual(summary.actions.map(action => [action.id, action.ready]), [["analyze", true], ["exportCsv", true], ["archive", false]]);
  assert.deepEqual(summary.actions.find(action => action.id === "archive").missingConnections, ["archive_api"]);
  const instance = await f.api(`${route}/application/open`, { method: "POST", body: {} });
  assert.equal((await fetch(instance.url)).status, 200);
  const connections = await f.api(`${route}/connections`);
  assert.ok(JSON.stringify(connections).includes("archive_api"));
  await f.api(`${route}/tasks`, { method: "POST", body: { actionId: "archive", input: { items: [] }, mutationId: "missing-business-001", deliveryVersion: summary.deliveryVersion }, status: 400 });
  assert.equal((await f.api(`${route}/tasks`)).tasks.length, 0);
  const independent = await f.api(`${route}/tasks`, { method: "POST", body: { actionId: "analyze", input: { url: "https://example.com/article", refresh: false }, mutationId: "independent-web-001", deliveryVersion: summary.deliveryVersion } });
  assert.equal((await f.agents.applications.wait(id, independent.taskId)).status, "completed");
  assert.deepEqual(f.calls.map(call => call.method), ["fetch", "search"]);
});
