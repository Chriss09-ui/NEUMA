import {validDraft} from "./helpers/architecture.mjs";
import {callFixture} from "./helpers/m7-test-boundaries.mjs";
import type {ApplicationAgents,ApplicationResourcesPort} from "../src/applications/application-service.mjs";
import type {ValueSchema,ApplicationAction} from "../src/contracts/application.mjs";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import { toolText } from "./helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AgentStorage } from "../src/agents/agent-storage.mjs";
import { AgentScheduler } from "../src/runtime/agent-scheduler.mjs";
import { ApplicationTaskStore } from "../src/applications/task-store.mjs";
import { ApplicationService } from "../src/applications/application-service.mjs";
import { routeApplication } from "../src/applications/application-api.mjs";

const schema:ValueSchema = { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };
const action:ApplicationAction = { id: "analyze", title: "分析", inputSchema: schema, outputSchema: schema, connectionIds: [] };
const submit = (value = "one", mutationId = "mutation-one") => ({ actionId: "analyze", input: { value }, mutationId, deliveryVersion: "delivery-v1" });
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return {promise,resolve}};
async function fixture(t: test.TestContext, runAction:NonNullable<ApplicationAgents["development"]["executor"]["runAction"]> = async ({ input }) => ({ status: "passed", output: input })) {
  const dataDir = await mkdtemp(join(tmpdir(), "neuma-application-service-")), storage = new AgentStorage({ dataDir });
  const store = new ApplicationTaskStore({ storage }), scheduler = new AgentScheduler();
  let lifecycle!:Parameters<ApplicationAgents["onLifecycle"]>[0];
  const agents:ApplicationAgents = {ready:Promise.resolve(),scheduler,storage,closing:null,agents:new Map(),removing:new Set(),builds:new Map(),
    getArchitecture:async()=>{throw new Error("Unexpected architecture read")},getActiveArchitecture:async()=>null,getActiveRuntime:async()=>null,approvedDefinition:()=>false,services:{run:async()=>{throw new Error("Unexpected managed execution")}},
    onLifecycle: (fn) => { lifecycle = fn; return () => {}; },
    connections: { snapshot: async () => ({agentId:"one",version:1,connections:[]}), assertActive: async (snapshot, id) => {
      if (!snapshot.connections.some((connection) => connection.id === id)) throw new Error("required_connection_missing");
    } },
    development:{store:{getRun:async()=>null},workspace:{validateSnapshot:async()=>{throw new Error("Unexpected snapshot validation")}},executor:{runAction}}, applicationCapabilities: async () => async () => ({ ok: true }),
  };
  const resources:ApplicationResourcesPort&{closed:string[]}={closed:[],closeAgent:async(id)=>{resources.closed.push(id)},closeAll:async()=>{},assertInstance:()=>{throw new Error("Unexpected instance lookup")},open:async()=>{throw new Error("Unexpected page open")},close:async()=>{throw new Error("Unexpected page close")}};
  const service = new ApplicationService({ agents, store, resources });
  service.descriptor = async (id) => ({agent:{id,revision:1,draft:validDraft("应用测试")},architecture:null,record:{id:"development",agentId:id,status:"completed",delivery:"ready",planHash:"plan",architectureRef:{version:1,candidateHash:"architecture"},package:{codeHash:"code",planHash:"plan",application:null,snapshot:null}},snapshot:{path:dataDir},deliveryVersion:"delivery-v1",
    manifest:{protocolVersion:2,runtime:"node-action",evidenceIds:[],entrypoint:"actions.mjs", stateVersion: 1, actions: [action], page:{entrypoint:"index.html",resources:[]} } });
  await service.ready;
  t.after(async () => { await service.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { service, store, agents, scheduler, resources, lifecycle:(...args:Parameters<typeof lifecycle>)=>Promise.resolve(lifecycle(...args)) };
}

test("版本切换等待已开始的页面状态保存，迟到校验不能跨过更新锁", async (t) => {
  const { service, store, agents, lifecycle } = await fixture(t);
  const gate = deferred(), entered = deferred(), original = store.setState.bind(store);
  store.setState = async (...args) => { entered.resolve!(); await gate.promise; return original(...args); };
  const writing = service.saveState("one", { state: { value: "kept" }, expectedVersion: 0, deliveryVersion: "delivery-v1" });
  await entered.promise;
  let interrupted = false;
  const interrupting = lifecycle({ agentId: "one", type: "build" }).then(() => { interrupted = true; });
  await Promise.resolve(); assert.equal(interrupted, false);
  gate.resolve!(); await writing; await interrupting;
  assert.deepEqual((await store.getState("one")).state, { value: "kept" });
  const current = service.descriptor.bind(service);
  service.descriptor = async (...args) => { const value = await callFixture(current,service,args); agents.builds = new Map([["one", {}]]); return value; };
  await assert.rejects(service.saveState("one", { state: { value: "late" }, expectedVersion: 1 }), /正在更新/);
  assert.deepEqual((await store.getState("one")).state, { value: "kept" });
});

test("持久应用任务立即返回且不绑定页面请求取消，同一幂等提交只实际执行一次", async (t) => {
  const gate = deferred(), started = deferred(); let calls = 0;
  const { service, store } = await fixture(t, async ({ input }) => { calls++; started.resolve!(); await gate.promise; return { status: "passed", output: input }; });
  const browser = new AbortController();
  const values = await Promise.all([service.submit("one", submit(), { signal: browser.signal }), service.submit("one", submit())]);
  assert.equal(values[0].taskId, values[1].taskId); await started.promise;
  browser.abort(); assert.equal((await store.get("one", values[0].taskId)).status, "running");
  gate.resolve!(); const task = await service.wait("one", values[0].taskId);
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
    signal = current; started.resolve!(); return new Promise((resolve) => current!.addEventListener("abort", () => resolve({ status: "passed", output: input }), { once: true }));
  });
  const task = await service.submit("one", submit()); await started.promise;
  await lifecycle({ agentId: "one", type: "build" });
  assert.equal(signal!.aborted, true);
  assert.equal((await service.wait("one", task.taskId)).status, "interrupted");
  assert.deepEqual(resources.closed, ["one"]);
});

test("关闭等待初次写盘中的提交并中断记录，关闭期间拒绝新任务且完成后可重用", async (t) => {
  const writing = deferred(), gate = deferred(); let executions = 0, closed = false;
  const { service, agents, store, scheduler } = await fixture(t, async ({ input }) => { executions++; return { status: "passed", output: input }; });
  const write = agents.storage.writeJson.bind(agents.storage); let block = true;
  agents.storage.writeJson = async (...args) => {
    if (block && args[1] === "application/tasks.json") { block = false; writing.resolve!(); await gate.promise; }
    return write(...args);
  };
  const pending = service.submit("one", submit());
  const rejected = assert.rejects(pending, /关闭或已重置/);
  await writing.promise;
  scheduler.cancelAll();
  const closing = service.close(); closing.then(() => { closed = true; }, () => {});
  try {
    assert.equal(service.close(), closing);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    await assert.rejects(service.submit("two", submit("two", "during-close")), /关闭或已重置/);
  } finally { gate.resolve!(); }
  await Promise.all([closing, rejected]);
  assert.equal(executions, 0);
  assert.equal((await store.list("one"))[0]!.status, "interrupted");
  assert.deepEqual(scheduler.snapshot(), { running: 0, queued: 0, agentIds: [] });
  agents.closing = Promise.resolve();
  await assert.rejects(service.submit("two", submit("two", "parent-closing")), /关闭或已重置/);
  agents.closing = null;
  const next = await service.submit("one", submit("after", "after-close"));
  assert.equal((await service.wait("one", next.taskId)).status, "completed");
  assert.equal(executions, 1);
});

test("关闭等待交付或连接读取中的提交，迟到校验不能创建或调度任务", async (t) => {
  for (const boundary of ["descriptor", "connections"]) await t.test(boundary, async (t) => {
    const entered = deferred(), gate = deferred(); let executions = 0, closed = false;
    const { service, agents, store, scheduler } = await fixture(t, async ({ input }) => { executions++; return { status: "passed", output: input }; });
    if (boundary === "descriptor") {
      const descriptor = service.descriptor.bind(service);
      service.descriptor = async (...args) => { entered.resolve!(); await gate.promise; return callFixture(descriptor,service,args); };
    } else {
      const snapshot = agents.connections.snapshot.bind(agents.connections);
      agents.connections.snapshot = async (...args) => { entered.resolve!(); await gate.promise; return snapshot(...args); };
    }
    const rejected = assert.rejects(service.submit("one", submit()), /关闭或已重置/);
    await entered.promise;
    const closing = service.close(); closing.then(() => { closed = true; }, () => {});
    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(closed, false);
    } finally { gate.resolve!(); }
    await Promise.all([closing, rejected]);
    assert.deepEqual(await store.list("one"), []);
    assert.equal(executions, 0);
    assert.deepEqual(scheduler.snapshot(), { running: 0, queued: 0, agentIds: [] });
  });
});

test("关闭等待实际程序退出和槽位释放，不能把迟到完成写成成功", async (t) => {
  const started = deferred(), gate = deferred(); let signal, closed = false;
  const { service, scheduler } = await fixture(t, async ({ signal: current, input }) => {
    signal = current; started.resolve!(); await gate.promise; return { status: "passed", output: input };
  });
  const submitted = await service.submit("one", submit()); await started.promise;
  const closing = service.close(); closing.then(() => { closed = true; }, () => {});
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(signal!.aborted, true);
    assert.equal(closed, false);
    assert.equal(scheduler.snapshot().running, 1);
  } finally { gate.resolve!(); }
  await closing;
  assert.equal((await service.wait("one", submitted.taskId)).status, "interrupted");
  assert.deepEqual(scheduler.snapshot(), { running: 0, queued: 0, agentIds: [] });
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
  assert.deepEqual((await service.summary("one")).actions[0]!.missingConnections, ["crm"]);
  await assert.rejects(service.submit("one", submit()), /required_connection_missing/);
  service.descriptor = descriptor;
  let connectionVersion = 1, usedVersion;
  agents.connections.snapshot = async()=>({agentId:"one",version:connectionVersion,connections:[]});
  agents.applicationCapabilities = async ({ connectionSnapshot }) => { usedVersion = connectionSnapshot.version; return async () => ({}); };
  const conversation = await scheduler.acquire({ agentId: "one" });
  const task = await service.submit("one", submit()); connectionVersion = 2; conversation.release();
  await service.wait("one", task.taskId); assert.equal(usedVersion, 1); assert.equal(objectFields(task.task).configVersion, 1);
});

test("嵌套应用动作复用已持有槽位，避免等待同Agent自己释放", async (t) => {
  const { service, scheduler } = await fixture(t);
  const conversation = await scheduler.acquire({ agentId: "one" });
  try {
    const [tool] = await service.tools({ id: "one" });
    const reply = await tool!.execute("tool-call-one", { actionId: "analyze", input: { value: "model-step" } }, new AbortController().signal);
    assert.equal(JSON.parse(toolText(reply)).status, "completed"); assert.equal(scheduler.snapshot().queued, 0);
  } finally { conversation.release(); }
});

test("聊天动作经实际SDK校验保留全部JSON输入类型，执行仍严格校验所选动作", async (t) => {
  const manifestPath = findPackageJSON("@earendil-works/pi-ai", import.meta.resolve("@earendil-works/pi-coding-agent"));
  const manifest = JSON.parse(await readFile(manifestPath!, "utf8"));
  const validationPath = manifest.exports["./utils/*"].import.replace("*", "validation");
  const { validateToolArguments } = await import(new URL(validationPath, pathToFileURL(manifestPath!)).href);
  const cases:{id:string;input:unknown;inputSchema:ValueSchema}[] = [
    { id: "text", input: "0", inputSchema: { type: "string" } },
    { id: "items", input: ["0", ""], inputSchema: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 } },
    { id: "numeric", input: 0, inputSchema: { type: "number", minimum: 0 } },
    { id: "flag", input: false, inputSchema: { type: "boolean" } },
    { id: "empty", input: null, inputSchema: { type: "null" } },
    { id: "record", input: { value: "0" }, inputSchema: schema },
  ];
  const executed:{actionId:string;input:unknown}[] = [];
  const { service, scheduler } = await fixture(t, async ({ actionId, input }) => {
    executed.push({ actionId, input }); return { status: "passed", output: input };
  });
  const descriptor = service.descriptor;
  service.descriptor = async (id) => {
    const value = await descriptor(id);
    return { ...value, manifest: { ...value.manifest, actions: cases.map(({ id, inputSchema }) => ({
      id, title: id, inputSchema, outputSchema: inputSchema, connectionIds: [],
    })) } };
  };
  const lease = await scheduler.acquire({ agentId: "one" });
  try {
    const [tool] = await service.tools({ id: "one" });
    for (const { id, input } of cases) {
      const params = validateToolArguments(tool, { name: tool!.name, arguments: { actionId: id, input } });
      assert.deepEqual(params.input, input);
      const reply = JSON.parse(toolText((await tool!.execute(`typed-input-${id}`, params, lease.signal))));
      assert.equal(reply.status, "completed"); assert.deepEqual(reply.result, input);
    }
    for (const input of ["0", -1]) {
      const params = validateToolArguments(tool, { name: tool!.name, arguments: { actionId: "numeric", input } });
      await assert.rejects(tool!.execute("invalid-numeric-input", params, lease.signal), /应用契约无效/);
    }
  } finally { lease.release(); }
  assert.deepEqual(executed, cases.map(({ id, input }) => ({ actionId: id, input })));
});

test("页面和聊天动作保存经过验证的本轮实例绑定，旧轮快照不进入任务记录", async (t) => {
  const { service, resources, scheduler } = await fixture(t);
  resources.assertInstance = (id: unknown, instanceId: string, version: string) => {
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
    let current:typeof context|null = context;
    const [tool] = await service.tools({ id: "one" }, { getApplicationContext: () => current });
    assert.match(tool!.description, /分析.*inputSchema.*outputSchema/s);
    const first = JSON.parse(toolText((await tool!.execute("conversation-one", { actionId: "analyze", input: { value: "first" } }, lease.signal))));
    assert.equal(objectFields((await service.store.get("one", first.taskId)).source.applicationContext).revision, 1);
    current = { ...context, revision: 2 };
    const next = JSON.parse(toolText((await tool!.execute("conversation-two", { actionId: "analyze", input: { value: "next" } }, lease.signal))));
    assert.equal(objectFields((await service.store.get("one", next.taskId)).source.applicationContext).revision, 2);
    current = null;
    const cleared = JSON.parse(toolText((await tool!.execute("conversation-clear", { actionId: "analyze", input: { value: "plain" } }, lease.signal))));
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
    const result = JSON.parse(toolText((await tool!.execute("closed-page-turn", { actionId: "analyze", input: { value: "continued" } }, lease.signal))));
    assert.equal(result.status, "completed");
    assert.equal(objectFields((await service.store.get("one", result.taskId)).source.applicationContext).instanceId, "page-one");
    await assert.rejects(service.submit("one", { ...submit("external", "closed-page-submit"), applicationContext: context }), /page_closed/);
  } finally { lease.release(); }
});

test("新页面重试同一提交复用原任务且不重绑结果，公开重试仍验证活跃实例", async (t) => {
  let executions = 0;
  const { service, resources } = await fixture(t, async ({ input }) => { executions++; return { status: "passed", output: input }; });
  const active = new Set(["page-original"]);
  resources.assertInstance = (id: unknown, instanceId: string, version: unknown) => {
    assert.equal(id, "one"); assert.equal(version, "delivery-v1");
    if (!active.has(instanceId)) throw new Error("page_closed");
  };
  const context = { instanceId: "page-original", deliveryVersion: "delivery-v1", revision: 3,
    snapshot: { viewId: "overview", title: "看板", summary: "月度", selection: null, values: {} } };
  const body:{actionId:string;input:{value:string};mutationId:string;deliveryVersion:string;applicationContext:typeof context|null} = {...submit(),applicationContext:context};
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
  const invoke = (path: string|URL, method: string, body?:Record<string,unknown>) => callFixture(routeApplication,undefined,[{ agents, request: { method, headers: {} }, response: {},
    address: new URL(path, "http://127.0.0.1:3000"), readBody: async () => body, sendJson() {} }]);
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
      await assert.rejects(callFixture(onCapability!,undefined,[{capability,args:{}}]), /disk_unavailable/);
      await assert.rejects(callFixture(onCapability!,undefined,[{capability:"connection.call",args:{}}]));
      return { status: "passed", output: input };
    });
    agents.applicationCapabilities = async () => async (call: { capability: string; }) => {
      if (call.capability === capability) throw new Error("disk_unavailable");
      sideEffects++; return {};
    };
    const submitted = await service.submit("one", submit());
    assert.equal((await service.wait("one", submitted.taskId)).status, "failed");
    assert.equal(runSignal!.aborted, true); assert.equal(sideEffects, 0);
  }
});

test("状态版本冲突允许重新读取后恢复，不伪装成写盘失败", async (t) => {
  let reads = 0;
  const { service, agents } = await fixture(t, async ({ signal, onCapability, input }) => {
    await assert.rejects(callFixture(onCapability!,undefined,[{capability:"state.set",args:{}}]), { reason: "application_conflict" });
    await callFixture(onCapability!,undefined,[{capability:"state.get",args:{}}]); assert.equal(signal!.aborted, false);
    return { status: "passed", output: input };
  });
  agents.applicationCapabilities = async () => async (call: { capability: string; }) => {
    if (call.capability === "state.set") throw Object.assign(new Error("version_conflict"), { reason: "application_conflict" });
    reads++; return { state: {}, version: 2 };
  };
  const submitted = await service.submit("one", submit());
  assert.equal((await service.wait("one", submitted.taskId)).status, "completed"); assert.equal(reads, 1);
});

test("停止记录写盘失败仍中止所有任务、释放调度槽并关闭资源", async (t) => {
  const started = deferred(), signals:AbortSignal[] = []; let closed = false;
  const { service, store, resources, scheduler } = await fixture(t, ({ signal, input }) => {
    signals.push(signal!); if (signals.length === 2) started.resolve!();
    return new Promise((resolve) => signal!.addEventListener("abort", () => resolve({ status: "passed", output: input }), { once: true }));
  });
  await service.submit("one", submit()); await service.submit("two", submit("two", "mutation-two")); await started.promise;
  resources.closeAll = async () => { closed = true; };
  const update = store.update.bind(store);
  store.update = async () => { throw new Error("disk_unavailable"); };
  try {
    await service.close().catch(() => {});
    assert.equal(signals.every((signal) => signal!.aborted), true);
    assert.equal(closed, true); assert.equal(scheduler.snapshot().running, 0);
  } finally { store.update = update; }
});
