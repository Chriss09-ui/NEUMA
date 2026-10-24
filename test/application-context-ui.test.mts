import type {BridgeEvent} from "../public/application-bridge.js";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { activateApplicationContext, setApplicationContext, clearApplicationContext, getApplicationContext,
  releaseApplicationContext, applicationTaskEvent, getApplicationActionContext } from "../public/application-context.js";
import { installApplicationHostBridge } from "../public/application-bridge.js";
import { createApplicationApi } from "../public/application-api.js";

const instance = { instanceId: "page-one", deliveryVersion: "delivery-one", origin: "http://127.0.0.1:4001" };
const snapshot = { viewId: "overview", title: "经营看板", summary: "本月收入与目标", selection: { metric: "revenue" }, values: { period: "month" } };
function surface() {
  const listeners = new Map<string,(event:Omit<BridgeEvent,"type">)=>unknown>(), sent: ({ "data": (unknown); "origin": (unknown); })[] = [];
  type FrameWindow={parent?:unknown;__NEUMA_APPLICATION__?:unknown;neuma?:{tasks:{subscribe(listener:(event:unknown)=>unknown):()=>unknown}}};
  return { listeners, sent, window: { addEventListener: (name:string, fn:(event:Omit<BridgeEvent,"type">)=>unknown) => listeners.set(name, fn), removeEventListener: (name:string) => listeners.delete(name) } as FrameWindow & {addEventListener(name:string,fn:(event:Omit<BridgeEvent,"type">)=>unknown):unknown;removeEventListener(name:string):unknown},
    frame: { contentWindow: { postMessage: (data: unknown, origin: unknown) => sent.push({ data, origin }) } } };
}

test("页面上下文按活跃实例隔离，清除保持递增修订，旧结果不覆盖新筛选", () => {
  activateApplicationContext("dashboard", instance);
  assert.equal(getApplicationActionContext!("dashboard")!.instanceId, instance.instanceId);
  assert.equal(getApplicationContext("dashboard"), undefined);
  assert.equal(setApplicationContext("dashboard", instance.instanceId, snapshot).revision, 1);
  const first = getApplicationContext("dashboard"); objectFields(first!.snapshot!.values).period = "mutated";
  assert.equal(objectFields(getApplicationContext!("dashboard")!.snapshot.values).period, "month");
  assert.equal(getApplicationContext("other"), undefined);
  const task = { id: "task-one", actionId: "filter", sequence: 3, status: "completed", deliveryVersion: instance.deliveryVersion,
    source: { applicationContext: { instanceId: instance.instanceId, deliveryVersion: instance.deliveryVersion, revision: 1 } } };
  assert.equal(applicationTaskEvent!("dashboard", task)!.stale, false);
  assert.equal(applicationTaskEvent("dashboard", { ...task, source: {} }), null);
  setApplicationContext("dashboard", instance.instanceId, { ...snapshot, values: { period: "year" } });
  assert.equal(applicationTaskEvent!("dashboard", task)!.stale, true);
  assert.equal(clearApplicationContext("dashboard", instance.instanceId).revision, 3);
  assert.equal(getApplicationContext("dashboard"), undefined);
  activateApplicationContext("other", { ...instance, instanceId: "page-two" });
  releaseApplicationContext("dashboard", instance.instanceId);
  assert.throws(() => setApplicationContext("dashboard", instance.instanceId, snapshot), /切换/);
  assert.equal(applicationTaskEvent("other", task), null);
  releaseApplicationContext("other", "page-two");
});

test("页面只提供有界JSON参考，拒绝循环、危险字段与过大数据且保留上一快照", () => {
  activateApplicationContext("dashboard", instance);
  setApplicationContext("dashboard", instance.instanceId, snapshot);
  const circular = {}; objectFields(circular).self = circular;
  for (const values of [circular, { invalid: Infinity }, JSON.parse(String('{"__proto__":{}}')), { text: "字".repeat(6000) }, Array(4100).fill(0), { text: "bad\0text" }])
    assert.throws(() => setApplicationContext("dashboard", instance.instanceId, { ...snapshot, values }));
  assert.equal(getApplicationContext!("dashboard")!.revision, 1);
  releaseApplicationContext("dashboard", instance.instanceId);
});

test("页面桥绑定上下文提交动作，仅可信页面可以打开助手和更新上下文", async () => {
  const s = surface(), calls: ((unknown))[] = [], opened: ((true))[] = [];
  activateApplicationContext("dashboard", instance);
  const bridge = installApplicationHostBridge({ ...s, agentId: "dashboard", instance, api: { run: async (...args) => { calls.push(args); return { taskId: "task-one" }; } },
    getContext: () => getApplicationContext("dashboard"),
    onAssistantContext: (value: unknown) => setApplicationContext("dashboard", instance.instanceId, value),
    onAssistantOpen: () => { opened.push(true); return { opened: true }; } });
  let seq = 0;
  const send = (method: string, params = {}, overrides = {}) => s.listeners.get("message")!({ origin: instance.origin, source: s.frame.contentWindow,
    data: { channel: "neuma.application", type: "request", protocolVersion: 1, ...instance, requestId: `request-${++seq}`, method, params }, ...overrides });
  await send("assistant.setContext", { snapshot }, { source: {} }); assert.equal(getApplicationContext("dashboard"), undefined);
  await send("assistant.setContext", { snapshot });
  await send("assistant.open"); assert.equal(opened.length, 1);
  await send("actions.run", { actionId: "filter", input: { period: "month" } });
  assert.deepEqual(objectFields(calls[0]!)[5], getApplicationContext("dashboard"));
  bridge.notifyTask({ taskId: "task-one", sequence: 3, deliveryVersion: instance.deliveryVersion });
  assert.equal(objectFields(s.sent.at(-1)!.data).event, "tasks.changed");
  await send("assistant.clearContext"); assert.equal(getApplicationContext("dashboard"), undefined);
  bridge(); const count = s.sent.length;
  bridge.notifyTask({ taskId: "task-one", sequence: 4, deliveryVersion: instance.deliveryVersion }); assert.equal(s.sent.length, count);
  releaseApplicationContext("dashboard", instance.instanceId);
});

test("iframe任务订阅校验宿主和交付版本，去重并支持取消订阅", async () => {
  const s = surface(), parent = { postMessage() {} }, received: ((unknown))[] = [];
  s.window.parent = parent; s.window.__NEUMA_APPLICATION__ = { ...instance, parentOrigin: "http://127.0.0.1:3000" };
  vm.runInNewContext(await readFile(new URL("../public/application-frame-bridge.js", import.meta.url), "utf8"), { window: s.window, setTimeout, clearTimeout });
  const unsubscribe = s.window.neuma!.tasks.subscribe((event: unknown) => received.push(event));
  const notify = (sequence: number, overrides = {}) => s.listeners.get("message")!({ source: parent, origin: "http://127.0.0.1:3000",
    data: { channel: "neuma.application", type: "event", protocolVersion: 1, ...instance, event: "tasks.changed",
      data: { taskId: "task-one", sequence, deliveryVersion: instance.deliveryVersion, stale: true } }, ...overrides });
  notify(1, { source: {} }); notify(1); notify(1); notify(0); notify(2);
  assert.deepEqual(received.map((event) => objectFields(event).sequence), [1, 2]); assert.equal(objectFields(received[0]).stale, true);
  unsubscribe(); notify(3); assert.equal(received.length, 2);
});

test("iframe文档重载先清旧参考，旧文档的在途响应不发送给新文档", async () => {
  const s = surface(); let release;
  activateApplicationContext("dashboard", instance);
  setApplicationContext("dashboard", instance.instanceId, snapshot);
  const bridge = installApplicationHostBridge({ ...s, agentId: "dashboard", instance,
    api: { getState: () => new Promise((resolve) => { release = resolve; }) },
    onAssistantContext: (value: unknown) => setApplicationContext("dashboard", instance.instanceId, value) });
  const send = (data: { type: string; requestId?: string; method?: string; params?: { snapshot: { viewId: string; title: string; summary: string; selection: { metric: string; }; values: { period: string; }; }; }; }) => s.listeners.get("message")!({ origin: instance.origin, source: s.frame.contentWindow,
    data: { channel: "neuma.application", protocolVersion: 1, ...instance, ...data } });
  const pending = send({ type: "request", requestId: "old-state", method: "state.get" });
  await new Promise(setImmediate);
  await send({ type: "document.ready" }); assert.equal(getApplicationContext("dashboard"), undefined);
  await send({ type: "request", requestId: "new-context", method: "assistant.setContext", params: { snapshot } });
  assert.equal(getApplicationContext!("dashboard")!.revision, 3);
  release!({ state: { stale: true } }); await pending;
  assert.equal(s.sent.some((item) => objectFields(item.data).requestId === "old-state"), false);
  bridge(); releaseApplicationContext("dashboard", instance.instanceId);
});

test("HTTP任务请求只在有页面上下文时增加可选字段", async () => {
  const calls: ((unknown))[] = [], api = createApplicationApi(async (_path, options) => { calls.push(JSON.parse(String(options!.body!))); return Response.json({ taskId: "task-one" }); });
  await api.run("dashboard", "filter", {}, "mutation-one", "delivery-one");
  assert.equal(Object.hasOwn(objectFields(calls[0]), "applicationContext"), false);
  const context = { ...instance, revision: 1, snapshot };
  await api.run("dashboard", "filter", {}, "mutation-two", "delivery-one", context);
  assert.deepEqual(objectFields(calls[1]).applicationContext, context);
});
