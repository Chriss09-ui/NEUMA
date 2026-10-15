import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStorage } from "../src/agents/agent-storage.mjs";
import { AgentScheduler } from "../src/runtime/agent-scheduler.mjs";
import { ApplicationTaskStore } from "../src/applications/task-store.mjs";
import { ApplicationService } from "../src/applications/application-service.mjs";
import { routeApplication } from "../src/applications/application-api.mjs";

const schema = { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };
const action = { id: "analyze", title: "分析", inputSchema: schema, outputSchema: schema, connectionIds: [] };
const submit = (value = "one", mutationId = "mutation-one") => ({ actionId: "analyze", input: { value }, mutationId, deliveryVersion: "delivery-v1" });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, runAction = async ({ input }) => ({ status: "passed", output: input })) {
  const dataDir = await mkdtemp(join(tmpdir(), "neuma-application-service-")), storage = new AgentStorage({ dataDir });
  const store = new ApplicationTaskStore({ storage }), scheduler = new AgentScheduler();
  let lifecycle;
  const agents = { ready: Promise.resolve(), scheduler, storage,
    onLifecycle: (fn) => { lifecycle = fn; return () => {}; },
    connections: { snapshot: async () => ({ version: 1, connections: [] }), assertActive: async (snapshot, id) => {
      if (!snapshot.connections.some((connection) => connection.id === id)) throw new Error("required_connection_missing");
    } },
    development: { executor: { runAction } }, applicationCapabilities: async () => async () => ({ ok: true }),
  };
  const resources = { closed: [], closeAgent: async (id) => resources.closed.push(id), closeAll: async () => {} };
  const service = new ApplicationService({ agents, store, resources });
  service.descriptor = async (id) => ({ agent: { id, revision: 1 }, snapshot: { path: dataDir }, deliveryVersion: "delivery-v1",
    manifest: { entrypoint: "actions.mjs", stateVersion: 1, actions: [action], page: { entrypoint: "index.html" } } });
  await service.ready;
  t.after(async () => { await service.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { service, store, agents, scheduler, resources, lifecycle: (...args) => lifecycle(...args) };
}

test("持久应用任务立即返回且不绑定页面请求取消，同一幂等提交只实际执行一次", async (t) => {
  const gate = deferred(), started = deferred(); let calls = 0;
  const { service, store } = await fixture(t, async ({ input }) => { calls++; started.resolve(); await gate.promise; return { status: "passed", output: input }; });
  const browser = new AbortController();
  const values = await Promise.all([service.submit("one", submit(), { signal: browser.signal }), service.submit("one", submit())]);
  assert.equal(values[0].taskId, values[1].taskId); await started.promise;
  browser.abort(); assert.equal((await store.get("one", values[0].taskId)).status, "running");
  gate.resolve(); const task = await service.wait("one", values[0].taskId);
  assert.equal(task.status, "completed"); assert.deepEqual(task.result, { value: "one" }); assert.equal(calls, 1);
});

test("应用与私聊共用调度槽，同Agent排队，取消排队任务不执行后端", async (t) => {
  let calls = 0;
  const { service, scheduler } = await fixture(t, async ({ input }) => { calls++; return { status: "passed", output: input }; });
  const conversation = await scheduler.acquire({ agentId: "one" });
  try {
    const pending = await service.submit("one", submit());
    assert.equal(pending.task.status, "queued");
    assert.equal(scheduler.snapshot().queued, 1);
    const other = await service.submit("two", submit("two", "mutation-two"));
    assert.equal((await service.wait("two", other.taskId)).status, "completed");
    await service.cancel("one", pending.taskId);
    assert.equal((await service.wait("one", pending.taskId)).status, "cancelled"); assert.equal(calls, 1);
  } finally { conversation.release(); }
  assert.equal(scheduler.snapshot().running, 0);
});

test("显式取消传播到运行程序且拒绝迟到成功，Agent生命周期保留中断状态", async (t) => {
  const started = deferred(); let signal;
  const { service, lifecycle, resources } = await fixture(t, ({ signal: current, input }) => {
    signal = current; started.resolve(); return new Promise((resolve) => current.addEventListener("abort", () => resolve({ status: "passed", output: input }), { once: true }));
  });
  const task = await service.submit("one", submit()); await started.promise;
  await lifecycle({ agentId: "one", type: "build" });
  assert.equal(signal.aborted, true);
  assert.equal((await service.wait("one", task.taskId)).status, "interrupted");
  assert.deepEqual(resources.closed, ["one"]);
});

test("未成功写入任务记录时不得开始程序，运行状态保存失败也阻止副作用", async (t) => {
  let calls = 0;
  const { service, store } = await fixture(t, async ({ input }) => { calls++; return { status: "passed", output: input }; });
  const save = store.save.bind(store);
  store.save = async () => { throw new Error("disk_unavailable"); };
  await assert.rejects(service.submit("one", submit()), /disk_unavailable/); assert.equal(calls, 0);
  store.save = async (id, record) => {
    if (record.tasks.some((task) => task.status === "running")) throw new Error("disk_unavailable");
    return save(id, record);
  };
  const value = await service.submit("one", submit());
  assert.equal((await service.wait("one", value.taskId)).status, "failed"); assert.equal(calls, 0);
});

test("旧交付、缺失连接及不符合契约的输入均在执行前拒绝，配置绑定提交版本", async (t) => {
  const { service, agents, scheduler } = await fixture(t);
  await assert.rejects(service.submit("one", { ...submit(), deliveryVersion: "stale" }), /版本/);
  await assert.rejects(service.submit("one", { ...submit(), input: { other: "value" } }), /契约/);
  const descriptor = service.descriptor;
  service.descriptor = async (id) => { const value = await descriptor(id); value.manifest.actions = [{ ...action, connectionIds: ["crm"] }]; return value; };
  assert.equal((await service.summary("one")).pageReady, true);
  assert.deepEqual((await service.summary("one")).actions[0].missingConnections, ["crm"]);
  await assert.rejects(service.submit("one", submit()), /required_connection_missing/);
  service.descriptor = descriptor;
  let connectionVersion = 1, usedVersion;
  agents.connections.snapshot = async () => ({ version: connectionVersion, connections: [] });
  agents.applicationCapabilities = async ({ connectionSnapshot }) => { usedVersion = connectionSnapshot.version; return async () => ({}); };
  const conversation = await scheduler.acquire({ agentId: "one" });
  const task = await service.submit("one", submit()); connectionVersion = 2; conversation.release();
  await service.wait("one", task.taskId); assert.equal(usedVersion, 1); assert.equal(task.task.configVersion, 1);
});

test("嵌套应用动作复用已持有槽位，避免等待同Agent自己释放", async (t) => {
  const { service, scheduler } = await fixture(t);
  const conversation = await scheduler.acquire({ agentId: "one" });
  try {
    const [tool] = await service.tools({ id: "one" });
    const reply = await tool.execute("tool-call-one", { actionId: "analyze", input: { value: "model-step" } }, new AbortController().signal);
    assert.equal(JSON.parse(reply.content[0].text).status, "completed"); assert.equal(scheduler.snapshot().queued, 0);
  } finally { conversation.release(); }
});

test("页面和聊天动作保存经过验证的本轮实例绑定，旧轮快照不进入任务记录", async (t) => {
  const { service, resources, scheduler } = await fixture(t);
  resources.assertInstance = (id, instanceId, version) => {
    assert.equal(id, "one");
    if (instanceId !== "current-page" || version !== "delivery-v1") throw new Error("invalid_instance");
  };
  const context = { instanceId: "current-page", deliveryVersion: "delivery-v1", revision: 1,
    snapshot: { viewId: "entry", title: "练习", summary: "当前选择", selection: ["first"], values: { note: "do-not-persist-snapshot" } } };
  const page = await service.submit("one", { ...submit(), applicationContext: context });
  assert.deepEqual(page.task.source.applicationContext, { instanceId: "current-page", deliveryVersion: "delivery-v1", revision: 1 });
  assert.doesNotMatch(JSON.stringify(page.task), /do-not-persist-snapshot/);
  await service.wait("one", page.taskId);
  const lease = await scheduler.acquire({ agentId: "one" });
  try {
    let current = context;
    const [tool] = await service.tools({ id: "one" }, { getApplicationContext: () => current });
    assert.match(tool.description, /分析.*inputSchema.*outputSchema/s);
    const first = JSON.parse((await tool.execute("conversation-one", { actionId: "analyze", input: { value: "first" } }, lease.signal)).content[0].text);
    assert.equal((await service.store.get("one", first.taskId)).source.applicationContext.revision, 1);
    current = { ...context, revision: 2 };
    const next = JSON.parse((await tool.execute("conversation-two", { actionId: "analyze", input: { value: "next" } }, lease.signal)).content[0].text);
    assert.equal((await service.store.get("one", next.taskId)).source.applicationContext.revision, 2);
    current = null;
    const cleared = JSON.parse((await tool.execute("conversation-clear", { actionId: "analyze", input: { value: "plain" } }, lease.signal)).content[0].text);
    assert.equal((await service.store.get("one", cleared.taskId)).source.applicationContext, undefined);
  } finally { lease.release(); }
  await assert.rejects(service.submit("one", { ...submit("bad", "invalid-context"), applicationContext: { ...context, instanceId: "other-page" } }), /invalid_instance/);
  await assert.rejects(service.conversationContext("one", { ...context, deliveryVersion: "old" }), /版本/);
});

test("应用摘要使用批准设计的入口与助手职责，旧缺省不变成显式禁用", async (t) => {
  const { service } = await fixture(t), descriptor = service.descriptor;
  assert.equal(Object.hasOwn(await service.summary("one"), "assistant"), false);
  service.descriptor = async (id) => ({ ...await descriptor(id), architecture: { design: {
    interaction: { defaultEntry: "conversation", assistant: { enabled: true, purpose: "解释应用及执行已交付动作" } },
  } } });
  const summary = await service.summary("one");
  assert.equal(summary.defaultEntry, "conversation");
  assert.deepEqual(summary.assistant, { enabled: true, purpose: "解释应用及执行已交付动作" });
});

test("纯页面没有动作时不注册空枚举的执行工具", async (t) => {
  const { service } = await fixture(t), descriptor = service.descriptor;
  service.descriptor = async (id) => { const value = await descriptor(id); return { ...value, manifest: { ...value.manifest, actions: [] } }; };
  assert.deepEqual(await service.tools({ id: "one" }), []);
});

test("页面关闭不撤销聊天本轮已验证快照，公开提交仍要求活跃实例", async (t) => {
  const { service, resources, scheduler } = await fixture(t);
  let active = true;
  resources.assertInstance = () => { if (!active) throw new Error("page_closed"); };
  const context = await service.validateContext("one", { instanceId: "page-one", deliveryVersion: "delivery-v1", revision: 1,
    snapshot: { viewId: "overview", title: "看板", summary: "月度", selection: null, values: {} } });
  const lease = await scheduler.acquire({ agentId: "one" });
  try {
    const [tool] = await service.tools({ id: "one" }, { getApplicationContext: () => context });
    active = false;
    const result = JSON.parse((await tool.execute("closed-page-turn", { actionId: "analyze", input: { value: "continued" } }, lease.signal)).content[0].text);
    assert.equal(result.status, "completed");
    assert.equal((await service.store.get("one", result.taskId)).source.applicationContext.instanceId, "page-one");
    await assert.rejects(service.submit("one", { ...submit("external", "closed-page-submit"), applicationContext: context }), /page_closed/);
  } finally { lease.release(); }
});

test("新页面重试同一提交复用原任务且不重绑结果，公开重试仍验证活跃实例", async (t) => {
  let executions = 0;
  const { service, resources } = await fixture(t, async ({ input }) => { executions++; return { status: "passed", output: input }; });
  const active = new Set(["page-original"]);
  resources.assertInstance = (id, instanceId, version) => {
    assert.equal(id, "one"); assert.equal(version, "delivery-v1");
    if (!active.has(instanceId)) throw new Error("page_closed");
  };
  const context = { instanceId: "page-original", deliveryVersion: "delivery-v1", revision: 3,
    snapshot: { viewId: "overview", title: "看板", summary: "月度", selection: null, values: {} } };
  const body = { ...submit(), applicationContext: context };
  const first = await service.submit("one", body); await service.wait("one", first.taskId);
  active.delete("page-original"); active.add("page-reloaded");
  const retry = { ...body, applicationContext: { ...context, instanceId: "page-reloaded", revision: 1 } };
  const replay = await service.submit("one", retry);
  assert.equal(replay.taskId, first.taskId); assert.equal(executions, 1);
  assert.deepEqual(replay.task.source.applicationContext, { instanceId: "page-original", deliveryVersion: "delivery-v1", revision: 3 });
  active.delete("page-reloaded");
  await assert.rejects(service.submit("one", retry), /page_closed/);
  assert.equal(executions, 1); assert.equal((await service.store.list("one")).length, 1);
});

test("公开应用API拒绝页面伪造任务范围，群任务详情不能从私有应用入口读取", async () => {
  let submitted = 0;
  const agents = { requireAgent: async () => {}, applications: { submit: async () => { submitted++; },
    store: { get: async () => ({ source: { scope: "group:g:t" } }) } } };
  const invoke = (path, method, body) => routeApplication({ agents, request: { method, headers: {} }, response: {},
    address: new URL(path, "http://127.0.0.1:3000"), readBody: async () => body, sendJson() {} });
  await assert.rejects(invoke("/api/agents/one/tasks", "POST", { ...submit(), source: { scope: "group:g:t" } }), /身份或任务范围/);
  await assert.rejects(invoke("/api/agents/one/tasks/task-one", "GET"), /群操作任务/); assert.equal(submitted, 0);
});

test("旧窗口不能读取或覆盖新交付页面状态", async (t) => {
  const { service, store } = await fixture(t);
  await assert.rejects(service.state("one", "delivery-old"), /版本/);
  await assert.rejects(service.saveState("one", { state: { old: true }, expectedVersion: 0, deliveryVersion: "delivery-old" }), /版本/);
  assert.equal((await store.getState("one")).version, 0);
  await service.saveState("one", { state: { current: true }, expectedVersion: 0, deliveryVersion: "delivery-v1" });
  assert.deepEqual((await service.state("one", "delivery-v1")).state, { current: true });
});

test("状态和产物持久化失败中止动作，程序捕获错误后也不能继续外部副作用", async (t) => {
  for (const capability of ["state.set", "files.write"]) {
    let sideEffects = 0, runSignal;
    const { service, agents } = await fixture(t, async ({ signal, onCapability, input }) => {
      runSignal = signal;
      await assert.rejects(onCapability({ capability, args: {} }), /disk_unavailable/);
      await assert.rejects(onCapability({ capability: "connection.call", args: {} }));
      return { status: "passed", output: input };
    });
    agents.applicationCapabilities = async () => async (call) => {
      if (call.capability === capability) throw new Error("disk_unavailable");
      sideEffects++; return {};
    };
    const submitted = await service.submit("one", submit());
    assert.equal((await service.wait("one", submitted.taskId)).status, "failed");
    assert.equal(runSignal.aborted, true); assert.equal(sideEffects, 0);
  }
});

test("状态版本冲突允许重新读取后恢复，不伪装成写盘失败", async (t) => {
  let reads = 0;
  const { service, agents } = await fixture(t, async ({ signal, onCapability, input }) => {
    await assert.rejects(onCapability({ capability: "state.set", args: {} }), { reason: "application_conflict" });
    await onCapability({ capability: "state.get", args: {} }); assert.equal(signal.aborted, false);
    return { status: "passed", output: input };
  });
  agents.applicationCapabilities = async () => async (call) => {
    if (call.capability === "state.set") throw Object.assign(new Error("version_conflict"), { reason: "application_conflict" });
    reads++; return { state: {}, version: 2 };
  };
  const submitted = await service.submit("one", submit());
  assert.equal((await service.wait("one", submitted.taskId)).status, "completed"); assert.equal(reads, 1);
});

test("停止记录写盘失败仍中止所有任务、释放调度槽并关闭资源", async (t) => {
  const started = deferred(), signals = []; let closed = false;
  const { service, store, resources, scheduler } = await fixture(t, ({ signal, input }) => {
    signals.push(signal); if (signals.length === 2) started.resolve();
    return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ status: "passed", output: input }), { once: true }));
  });
  await service.submit("one", submit()); await service.submit("two", submit("two", "mutation-two")); await started.promise;
  resources.closeAll = async () => { closed = true; };
  const update = store.update.bind(store);
  store.update = async () => { throw new Error("disk_unavailable"); };
  try {
    await service.close().catch(() => {});
    assert.equal(signals.every((signal) => signal.aborted), true);
    assert.equal(closed, true); assert.equal(scheduler.snapshot().running, 0);
  } finally { store.update = update; }
});
