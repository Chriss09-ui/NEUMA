import { applicationApiFixture } from "../helpers/ui-api-fixture.mjs";
import { objectFields } from "../../public/ui-types.js";
import type { Material, ApplicationInstance } from "../../public/ui-types.js";
import type { ApplicationApi } from "../../public/ui-api-types.js";
import type { ApplicationDomEvent } from "../../public/application-dom.js";
import type { BridgeEvent, BridgeMessage } from "../../public/application-bridge.js";
interface FrameReply {requestId:string;result:{materials:Material[];taskId?:string};error:{message:string};type:string;params:{mutationId?:string};[key:string]:unknown}
interface FixtureEvent {type:string;source?:unknown;origin?:string;data?:unknown;detail?:{agentId?:string|null;active?:boolean};preventDefault?:()=>void}
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createApplicationApi } from "../../public/application-api.js";
import { installApplicationHostBridge } from "../../public/application-bridge.js";
import { applicationMode, createApplicationWorkspace } from "../../public/application-workspace.js";
import { connectionStatus, createConnectionView } from "../../public/agent-connections.js";
import { createApplicationTasks } from "../../public/application-tasks.js";

const settle = () => new Promise(setImmediate);
function dom() {
  class Events {
    listeners = new Map<string,unknown[]>();
declare activeElement: Element;
declare getElementById:(id:string)=>Element;
declare defaultView:{URL:Pick<typeof URL,"createObjectURL"|"revokeObjectURL">;setTimeout(callback:()=>void,delay?:number):unknown};
declare parent:Element|null|{postMessage(message:FrameReply,origin:string):unknown};
declare neuma:{actions:{run(action:string,input:unknown,options:unknown):Promise<{taskId:string}>}};
declare createElement: (tag: string) => Element;
declare location: { origin: string; };
declare __NEUMA_APPLICATION__: { parentOrigin: string; instanceId: string; origin: string; url: string; deliveryVersion: string; };


    addEventListener(type:"message",callback:(event:BridgeEvent)=>unknown):void;
    addEventListener(type:string,callback:(event:ApplicationDomEvent)=>unknown):void;
    addEventListener(type:string,callback:unknown) { this.listeners.set(type, [...this.listeners.get(type) || [], callback]); }
    removeEventListener(type:"message",callback:(event:BridgeEvent)=>unknown):void;
    removeEventListener(type:string,callback:(event:ApplicationDomEvent)=>unknown):void;
    removeEventListener(type:string,callback:unknown) { this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== callback)); }
    dispatchEvent(event:FixtureEvent) { return Promise.all((this.listeners.get(event.type) || []).map((callback) => (callback as (event:FixtureEvent)=>unknown)(event))); }
  }
  const document = new Events(), nodes = new Map<string,Element>(), downloads: {href:string;download:string;parent:Element|null}[] = [];
  class Element extends Events {
declare tag: string;
declare parent: Element|null;
declare className:string;
declare href:string;
declare download:string;
declare type:string;
declare name:string;
declare checked:boolean;
declare inert:boolean;
declare title:string;
declare savedDraft:string;
declare dataset:Record<string,string>;
    constructor(tag: string) { super(); this.tag = tag; }
    children: Element[] = []; attributes = new Map(); hidden = false; value = ""; textContent = ""; disabled = false; open = false; classes = new Set<string>();
    classList = { add:(...names:string[])=>names.forEach(name=>this.classes.add(name)), toggle: (name:string, active?:boolean) => active ? this.classes.add(name) : this.classes.delete(name) };
    contentWindow = { postMessage(_message:unknown,_origin?:string):unknown {return undefined;} };
    get parentElement(): Element|null { return this.parent || null; }
    append(...values:Element[]) { for (const value of values) { value.remove(); value.parent = this; this.children.push(value); } }
    replaceChildren(...values:Element[]) { for (const child of this.children) child.parent = null; this.children = []; this.append(...values); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((child: Element) => child !== this); this.parent = null; }
    setAttribute(name:string,value:string) { this.attributes.set(name, value); }
    focus() { document.activeElement = this; }
    click() {
      if (this.disabled) return Promise.resolve();
      if (this.tag === "a") downloads.push({ href: this.href, download: this.download, parent: this.parent });
      return this.dispatchEvent({ type: "click" });
    }
    showModal() { this.open = true; }
    close():Promise<unknown[]>|void { this.open = false; return this.dispatchEvent({ type: "close" }); }
  }
  const get = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Element("div")); return nodes.get(id)!; };
  document.getElementById = get; document.createElement = (tag: string) => new Element(tag);
  get("agent-chat-actions").append(get("agent-conversation-actions"));
  get("agent-conversation-actions").append(get("agent-new-chat"));
  const window = new Events(); window.location = { origin: "http://127.0.0.1:3000" };
  return { document, window, get, downloads };
}
type FixtureElement = ReturnType<ReturnType<typeof dom>["get"]>;
const descendants = (node:FixtureElement):FixtureElement[] => [node, ...node.children.flatMap(descendants)];
const text = (node:FixtureElement) => descendants(node).map((item) => item.textContent).join(" ");
const input = (node:FixtureElement, key: string) => descendants(node).find((item) => item.name === key)!;
const instance = { instanceId: "instance-one", origin: "http://127.0.0.1:4011", url: "http://127.0.0.1:4011/ui/index.html", deliveryVersion: "delivery-7" };
const application = { pageReady: true, deliveryVersion: "delivery-7", manifest: { protocolVersion: 2, page: { entrypoint: "ui/index.html" } }, actions: [{ id: "search", title: "搜寻资料", ready: true }] };

async function materialPicker(materials: ApplicationApi["materials"]) {
  const ui = dom(), replies:FrameReply[] = [], pending:Promise<unknown[]>[] = [];
  let opened = 0, resource: { instanceId: string; origin: string; url: string; deliveryVersion: string; };
  const view = createApplicationWorkspace<FixtureElement>({ ...ui, api: applicationApiFixture({
    open: async () => (resource = { ...instance, instanceId: `instance-${++opened}` }), close: async () => {},
    tasks: async () => ({ tasks: [] }), materials,
  }) });
  async function enter() { view.route("one"); view.update("one", application); await settle(); }
  function send(requestId:string) {
    const frame = ui.get("agent-application-frame-host").children[0];
    frame!.contentWindow.postMessage = (message) => replies.push(message as FrameReply);
    const request = ui.window.dispatchEvent({ type: "message", origin: resource.origin, source: frame!.contentWindow,
      data: { channel: "neuma.application", protocolVersion: 1, type: "request", instanceId: resource.instanceId,
        deliveryVersion: resource.deliveryVersion, requestId, method: "materials.select", params: {} } });
    pending.push(request); return request;
  }
  await enter();
  return { ...ui, view, enter, send, replies, pending, dialog: ui.get("application-material-dialog"),
    response: (id:string) => replies.find((message) => message.requestId === id)!,
    async choose(index = 0) {
      const checkbox = ui.get("application-material-list").children[index]!.children[0];
      checkbox!.checked = true; await checkbox!.dispatchEvent({ type: "change" });
      await ui.get("application-material-confirm").click(); await settle();
    } };
}

test("材料选择在列表读取前拒绝并发请求，确认仅返回本次勾选", async () => {
  let release!: (value: Awaited<ReturnType<ApplicationApi["materials"]>>) => void, reads = 0;
  const material = { id: "material-one", name: "第一份材料" };
  const ui = await materialPicker(() => { reads++; return new Promise((resolve) => { release = resolve; }); });
  try {
    ui.send("first"); ui.send("second"); await settle();
    assert.equal(reads, 1);
    assert.match(ui.response("second")?.error.message, /已有材料选择/);
    assert.equal(ui.response("first"), undefined);
    release!({ attachments: [material] }); await settle();
    assert.equal(ui.get("application-material-list").children.length, 1);
    await ui.choose(); await Promise.all(ui.pending);
    assert.deepEqual(ui.response("first").result.materials, [material]);
    assert.equal(ui.dialog.open, false);
  } finally { release?.({ attachments: [] }); ui.view.close(); }
});

test("材料选择取消后可重试，旧窗口的迟到关闭事件不清除新选择", async () => {
  const material = { id: "material-one", name: "第一份材料" };
  const ui = await materialPicker(async () => ({ attachments: [material] })), closed: (()=>unknown)[] = [];
  ui.dialog.close = () => { ui.dialog.open = false; closed.push(() => ui.dialog.dispatchEvent({ type: "close" })); };
  try {
    ui.send("cancelled"); await settle();
    await ui.dialog.dispatchEvent({ type: "cancel", preventDefault() {} }); await settle();
    assert.deepEqual(ui.response("cancelled").result.materials, []);
    ui.send("retry"); await settle();
    assert.equal(ui.dialog.open, true);
    await closed.shift()!();
    assert.equal(ui.response("retry"), undefined);
    await ui.choose(); await Promise.all(ui.pending);
    assert.deepEqual(ui.response("retry").result.materials, [material]);
  } finally { ui.view.close(); }
});

test("材料选择切页再返回及关闭重开后丢弃旧实例的迟到列表", async () => {
  const reads: ((arg0: { attachments: { id: string; name: string; }[]; }) => void)[] = [], ui = await materialPicker(() => new Promise((resolve) => reads.push(resolve)));
  const material = { id: "current-material", name: "当前材料" };
  try {
    ui.send("before-route"); await settle();
    ui.view.route("two"); await ui.enter();
    ui.send("before-reopen"); await settle();
    ui.view.close(); await ui.enter();
    ui.send("current"); await settle();
    reads[0]!({ attachments: [{ id: "old-route", name: "旧页面材料" }] });
    reads[1]!({ attachments: [{ id: "old-instance", name: "旧实例材料" }] }); await settle();
    assert.equal(ui.dialog.open, false);
    assert.equal(ui.get("application-material-list").children.length, 0);
    assert.equal(ui.response("current"), undefined);
    reads[2]!({ attachments: [material] }); await settle();
    await ui.choose(); await Promise.all(ui.pending);
    assert.deepEqual(ui.replies.map((message) => message.requestId), ["current"]);
    assert.deepEqual(ui.response("current").result.materials, [material]);
  } finally { for (const resolve of reads) resolve({ attachments: [] }); ui.view.close(); }
});

test("材料选择列表读取失败释放操作，可重新选择并关闭", async () => {
  let reads = 0;
  const ui = await materialPicker(async () => {
    if (++reads === 1) throw new Error("材料列表读取失败");
    return { attachments: [] };
  });
  try {
    await ui.send("failed");
    assert.match(ui.response("failed").error.message, /材料列表读取失败/);
    assert.equal(ui.dialog.open, false);
    ui.send("retry"); await settle();
    assert.equal(reads, 2); assert.equal(ui.dialog.open, true);
    await ui.get("application-material-close").click(); await Promise.all(ui.pending);
    assert.deepEqual(ui.response("retry").result.materials, []);
  } finally { ui.view.close(); }
});

test("页面桥拒绝伪造窗口、来源、实例及版本，身份只由宿主绑定且重复请求只执行一次", async () => {
  const ui = dom(), frame = ui.document.createElement("iframe"), calls: unknown[][] = [], replies: [FrameReply,string][] = [];
  frame.contentWindow.postMessage = (message,origin) => replies.push([message as FrameReply,origin!]);
  const detach = installApplicationHostBridge({ window: ui.window, frame, instance, agentId: "one", api: applicationApiFixture({
    run: async (...args) => { calls.push(args); return { taskId: "stable-task" }; },
  }) });
  const request = { channel: "neuma.application", protocolVersion: 1, type: "request", instanceId: instance.instanceId,
    deliveryVersion: instance.deliveryVersion, requestId: "req-1", method: "actions.run", params: { actionId: "search", input: { link: "https://example.com" }, agentId: "other" } };
  const send = (overrides = {}) => ui.window.dispatchEvent({ type: "message", origin: instance.origin, source: frame.contentWindow, data: request, ...overrides });
  await send({ origin: "http://127.0.0.1:4000" }); await send({ source: {} });
  for (const field of ["instanceId", "deliveryVersion", "protocolVersion"]) await send({ data: { ...request, [field]: "forged" } });
  assert.equal(calls.length, 0); assert.equal(replies.length, 0);
  await Promise.all([send(), send()]);
  assert.equal(calls.length, 1); assert.equal(calls[0]![0], "one"); assert.equal(calls[0]![3], "instance-one-req-1");
  assert.equal(replies[0]![1], instance.origin); assert.equal(replies[0]![0].result.taskId, "stable-task");
  await send({ data: { ...request, requestId: "req-2", method: "connections.get" } });
  assert.match(replies.at(-1)![0].error.message, /未开放/);
  detach(); await send({ data: { ...request, requestId: "req-3" } }); assert.equal(calls.length, 1);
});

test("页面桥释放后不接受迟到回执，循环消息与超大消息安全忽略", async () => {
  const ui = dom(), frame = ui.document.createElement("iframe"), replies: [FrameReply,string][] = []; let release!: (value: { state: unknown; version: number; } | PromiseLike<{ state: unknown; version: number; }>) => void;
  frame.contentWindow.postMessage = (message,origin) => replies.push([message as FrameReply,origin!]);
  const detach = installApplicationHostBridge({ window: ui.window, frame, instance, agentId: "one", api: applicationApiFixture({
    getState: () => new Promise((resolve) => { release = resolve; }),
  }) });
  const data = { channel: "neuma.application", type: "request", protocolVersion: 1, ...instance, requestId: "one", method: "state.get" };
  const send = (data: { params?: {}|{ huge: string; }; requestId: string; method: string; instanceId: string; origin: string; url: string; deliveryVersion: string; channel: string; type: string; protocolVersion: number; }) => ui.window.dispatchEvent({ type: "message", data, source: frame.contentWindow, origin: instance.origin });
  const circular = { ...data, params: {} as {self?:unknown} }; circular.params.self = circular;
  await send(circular); await send({ ...data, params: { huge: "x".repeat(1_048_577) } }); assert.equal({ release }.release, undefined);
  const pending = send(data); await settle(); detach(); release!({ state: {}, version: 1 }); await pending;
  assert.equal(replies.length, 0);
});

test("iframe桥只信任指定父窗口，未匹配响应不能伪造完成", async () => {
  const ui = dom(), sent: {message:FrameReply;origin:string}[] = [], timers = new Map<number,()=>unknown>(); let timerId = 0;
  ui.window.parent = { postMessage: (message, origin) => sent.push({ message, origin }) };
  ui.window.__NEUMA_APPLICATION__ = { ...instance, parentOrigin: "http://127.0.0.1:3000" };
  vm.runInNewContext(await readFile(new URL("../../public/application-frame-bridge.js", import.meta.url), "utf8"), {
    window: ui.window, setTimeout: (callback:()=>unknown) => { timers.set(++timerId, callback); return timerId; }, clearTimeout: (id:number) => timers.delete(id),
  });
  assert.equal(sent.shift()!.message.type, "document.ready");
  const pending = ui.window.neuma.actions.run("search", { link: "https://example.com" }, { mutationId: "retry-key" });
  assert.equal(ui.window.__NEUMA_APPLICATION__, undefined); assert.equal(sent[0]!.origin, ui.window.location.origin);
  assert.equal(sent[0]!.message.params.mutationId, "retry-key");
  const response = { ...sent[0]!.message, type: "response", result: { taskId: "done" } };
  await ui.window.dispatchEvent({ type: "message", source: {}, origin: ui.window.location.origin, data: response });
  assert.equal(timers.size, 1);
  await ui.window.dispatchEvent({ type: "message", source: ui.window.parent, origin: ui.window.location.origin, data: response });
  assert.equal((await pending).taskId, "done"); assert.equal(timers.size, 0);
});

test("应用与助手复用聊天区域，切换保留页面草稿，不取消后台任务，按Agent记住入口", async () => {
  const ui = dom(), calls: unknown[][] = [], stored = new Map();
  const storage = { getItem: (key:string) => stored.get(key) ?? null, setItem: (key:string,value:string) => stored.set(key, value) };
  const view = createApplicationWorkspace<FixtureElement>({ ...ui, storage, api: applicationApiFixture({
    open: async (id) => { calls.push(["open", id]); return instance; }, close: async (...args) => calls.push(["close", ...args]),
    tasks: async () => ({ tasks: [] }),
  }) });
  try {
    view.route("one"); view.update("one", application); await settle();
    assert.equal(ui.get("agent-new-chat").hidden, true);
    assert.equal(ui.get("agent-conversation").inert, true);
    assert.equal(ui.get("agent-conversation").attributes.get("aria-hidden"), "true");
    assert.equal(ui.get("agent-conversation-actions").parentElement, ui.get("agent-chat-actions"));
    const frame = ui.get("agent-application-frame-host").children[0]; frame!.savedDraft = "还未发送的链接";
    assert.equal(frame!.attributes.get("sandbox"), "allow-scripts allow-same-origin");
    ui.get("agent-message").value = "对话草稿";
    await ui.get("agent-view-chat").click();
    assert.equal(ui.get("agent-new-chat").hidden, false);
    assert.equal(ui.get("agent-conversation").inert, false);
    assert.equal(ui.get("agent-conversation").attributes.get("aria-hidden"), "false");
    assert.equal(ui.get("agent-conversation-actions").parentElement, ui.get("agent-chat-actions"));
    await ui.get("agent-view-application").click();
    assert.equal(ui.get("agent-new-chat").hidden, true);
    assert.equal(ui.get("agent-conversation").inert, true);
    assert.equal(ui.get("agent-application-frame-host").children[0], frame);
    assert.equal(frame!.savedDraft, "还未发送的链接"); assert.equal(ui.get("agent-message").value, "对话草稿");
    await ui.get("agent-assistant-toggle").click();
    assert.equal(ui.get("agent-workspace").classes.has("application-assistant-open"), true);
    assert.equal(ui.get("agent-conversation").inert, false);
    assert.equal(ui.get("agent-conversation").attributes.get("aria-hidden"), "false");
    assert.equal(ui.get("agent-new-chat").hidden, false);
    assert.equal(ui.get("agent-conversation-actions").parentElement, ui.get("agent-assistant-actions"));
    assert.equal(ui.document.activeElement, ui.get("agent-message"));
    await ui.get("agent-assistant-toggle").click();
    assert.equal(ui.get("agent-new-chat").hidden, true);
    assert.equal(ui.get("agent-conversation").inert, true);
    assert.equal(ui.get("agent-conversation").attributes.get("aria-hidden"), "true");
    assert.equal(ui.get("agent-conversation-actions").parentElement, ui.get("agent-chat-actions"));
    await ui.get("agent-view-chat").click();
    assert.equal(ui.get("agent-conversation").inert, false);
    assert.equal(ui.get("agent-conversation").attributes.get("aria-hidden"), "false");
    assert.equal(applicationMode(storage, "one"), "chat"); assert.equal(applicationMode(storage, "two"), "application");
    assert.deepEqual(calls, [["open", "one"]]);
    view.route("two"); await settle(); assert.equal(calls[1]![0], "close"); assert.equal(calls[1]![1], "one");
    assert.equal(ui.get("agent-conversation").inert, false);
    assert.equal(ui.get("agent-conversation").attributes.get("aria-hidden"), "false");
    assert.equal(ui.get("agent-new-chat").hidden, false);
    assert.equal(ui.get("agent-conversation-actions").parentElement, ui.get("agent-chat-actions"));
  } finally { view.close(); }
});

for (const initiallyOpen of [false, true]) test(`应用设置临时替换${initiallyOpen ? "已展开" : "已收起"}的助手，关闭恢复并保留页面和聊天草稿`, async () => {
  const ui = dom(), calls: unknown[][] = [];
  const view = createApplicationWorkspace<FixtureElement>({ ...ui, api: applicationApiFixture({
    open: async (id) => { calls.push(["open", id]); return instance; },
    close: async (...args) => calls.push(["close", ...args]), tasks: async () => ({ tasks: [] }),
  }) });
  const settings = (agentId: string, active: boolean) => ui.document.dispatchEvent({ type: "neuma:agent-settings-view", detail: { agentId, active } });
  const assistantVisible = () => ui.get("agent-workspace").classes.has("application-assistant-open");
  try {
    view.route("one"); view.update("one", application); await settle();
    if (initiallyOpen) await ui.get("agent-assistant-toggle").click();
    const frame = ui.get("agent-application-frame-host").children[0]; frame!.savedDraft = "页面草稿";
    ui.get("agent-message").value = "聊天草稿";
    assert.equal(assistantVisible(), initiallyOpen);
    assert.equal(ui.get("agent-conversation").inert, !initiallyOpen);
    assert.equal(ui.get("agent-conversation-actions").parentElement, ui.get(initiallyOpen ? "agent-assistant-actions" : "agent-chat-actions"));
    await settings("two", true);
    assert.equal(assistantVisible(), initiallyOpen);
    assert.equal(ui.get("agent-assistant-toggle").hidden, false);
    await settings("one", true);
    assert.equal(assistantVisible(), false);
    assert.equal(ui.get("agent-conversation").inert, true);
    assert.equal(ui.get("agent-conversation").attributes.get("aria-hidden"), "true");
    assert.equal(ui.get("agent-assistant-toggle").hidden, true);
    assert.equal(ui.get("agent-assistant-toggle").disabled, true);
    assert.equal(ui.get("agent-assistant-toggle").attributes.get("aria-expanded"), "false");
    assert.equal(ui.get("agent-new-chat").hidden, true);
    assert.equal(ui.get("agent-conversation-actions").parentElement, ui.get("agent-chat-actions"));
    ui.get("agent-panel-toggle").focus();
    await ui.get("agent-assistant-toggle").click();
    await settings("two", false);
    assert.equal(assistantVisible(), false);
    assert.equal(ui.get("agent-assistant-toggle").hidden, true);
    await settings("one", false);
    assert.equal(assistantVisible(), initiallyOpen);
    assert.equal(ui.get("agent-conversation").inert, !initiallyOpen);
    assert.equal(ui.get("agent-conversation").attributes.get("aria-hidden"), String(!initiallyOpen));
    assert.equal(ui.get("agent-assistant-toggle").hidden, false);
    assert.equal(ui.get("agent-assistant-toggle").disabled, false);
    assert.equal(ui.get("agent-assistant-toggle").attributes.get("aria-expanded"), String(initiallyOpen));
    assert.equal(ui.get("agent-new-chat").hidden, !initiallyOpen);
    assert.equal(ui.get("agent-conversation-actions").parentElement, ui.get(initiallyOpen ? "agent-assistant-actions" : "agent-chat-actions"));
    assert.equal(ui.document.activeElement, ui.get("agent-panel-toggle"));
    assert.equal(ui.get("agent-application-frame-host").children[0], frame);
    assert.equal(frame!.savedDraft, "页面草稿");
    assert.equal(ui.get("agent-message").value, "聊天草稿");
    assert.deepEqual(calls, [["open", "one"]]);
    await settings("one", true);
    await ui.get("agent-view-chat").click();
    assert.equal(ui.get("agent-conversation").inert, false);
    assert.equal(ui.get("agent-conversation").attributes.get("aria-hidden"), "false");
    assert.equal(ui.document.activeElement, ui.get("agent-message"));
    await ui.get("agent-view-application").click();
    assert.equal(ui.get("agent-conversation").inert, true);
    view.route("two");
    assert.equal(ui.get("agent-conversation").inert, false);
    assert.equal(ui.get("agent-conversation").attributes.get("aria-hidden"), "false");
    view.update("two", application); await settle();
    await settings("one", false);
    assert.equal(ui.get("agent-assistant-toggle").hidden, false);
    assert.equal(ui.get("agent-assistant-toggle").disabled, false);
    assert.equal(assistantVisible(), false);
    assert.equal(ui.get("agent-conversation").inert, true);
    assert.equal(ui.get("agent-conversation-actions").parentElement, ui.get("agent-chat-actions"));
    view.route(null);
    assert.equal(ui.get("agent-conversation").inert, false);
    assert.equal(ui.get("agent-conversation").attributes.get("aria-hidden"), "false");
  } finally { view.close(); }
});

test("缺连接时应用可打开并给出配置入口，离开后迟到资源必须释放", async () => {
  const ui = dom(), closed: unknown[] = []; let release!: (value: import("../../public/ui-types.js").ApplicationInstance | PromiseLike<import("../../public/ui-types.js").ApplicationInstance>) => void;
  const view = createApplicationWorkspace<FixtureElement>({ ...ui, api: applicationApiFixture({ open: () => new Promise((resolve) => { release = resolve; }), close: async (...args) => closed.push(args), tasks: async () => ({ tasks: [] }) }) });
  view.route("one"); view.update("one", { ...application, actions: [{ id: "sync", title: "同步资料", ready: false, missingConnections: ["crm"] }] });
  assert.equal(ui.get("agent-application").hidden, false); assert.equal(ui.get("agent-application-configure").disabled, false);
  assert.match(ui.get("agent-application-connection-text").textContent, /同步资料.*配置/);
  view.route("two"); release!(instance); await settle();
  assert.equal(ui.get("agent-application-frame-host").children.length, 0); assert.deepEqual(closed[0], ["one", instance.instanceId]);
  view.close();
});

test("连接保存失败保留认证输入，成功清除秘密且配置不写浏览器备份", async () => {
  const ui = dom(), container = ui.get("connections"), calls: {id:string;body:Record<string,unknown>}[] = []; let failed = true;
  const requirement = { id: "search", kind: "search", label: "专属搜索", required: false };
  const view = createConnectionView<FixtureElement>({ document: ui.document, container, api: applicationApiFixture({
    connections: async () => ({ version: 0, connections: [], requirements: [requirement] }),
    saveConnection: async (id, body) => { calls.push({ id, body:objectFields(body) }); if (failed) throw new Error("磁盘暂时不可写"); return { version: 1, connections: [{ id: "search", configured: true, hasSecret: true, status: "configured" }] }; },
  }) });
  await view.show("one"); const form = descendants(container).find((node) => node.tag === "form"), secret = input(form!, "secret");
  secret.value = "test-fixture-secret"; await secret.dispatchEvent({ type: "input" });
  await form!.dispatchEvent({ type: "submit", preventDefault() {} });
  assert.equal(secret.value, "test-fixture-secret"); assert.match(text(container), /磁盘暂时不可写.*输入已保留/);
  view.hide(); await view.show("one"); assert.equal(input(container, "secret").value, "test-fixture-secret");
  failed = false; await form!.dispatchEvent({ type: "submit", preventDefault() {} });
  assert.equal(secret.value, ""); assert.match(text(container), /已配置，尚未验证/);
  assert.equal(calls[1]!.body.expectedVersion, 0); assert.equal(calls[1]!.id, "one");
  assert.equal(connectionStatus({ required: true }, null), "必需待配置");
  assert.equal(connectionStatus(requirement, { status: "verified" }), "已验证");
  assert.doesNotMatch(await readFile(new URL("../../public/agent-connections.js", import.meta.url), "utf8"), /localStorage|sessionStorage|setItem|indexedDB/);
});

test("连接保存期间的新输入和其他Agent的表单不被迟到回执覆盖", async () => {
  const ui = dom(), container = ui.get("connections"); let release!: (value: import("../../public/ui-api-types.js").ConnectionResult | PromiseLike<import("../../public/ui-api-types.js").ConnectionResult>) => void;
  const view = createConnectionView<FixtureElement>({ document: ui.document, container, api: applicationApiFixture({
    connections: async () => ({ version: 0, connections: [], requirements: [{ id: "model", kind: "model" }] }),
    saveConnection: () => new Promise((resolve) => { release = resolve; }),
  }) });
  await view.show("one"); const form = descendants(container).find((node) => node.tag === "form"), secret = input(form!, "secret");
  secret.value = "first"; await secret.dispatchEvent({ type: "input" });
  const saving = form!.dispatchEvent({ type: "submit", preventDefault() {} });
  secret.value = "newer"; await secret.dispatchEvent({ type: "input" });
  await view.show("two"); const other = input(container, "secret"); other.value = "other-agent"; await other.dispatchEvent({ type: "input" });
  release!({ version: 1, connection: { id: "model", configured: true } }); await saving;
  assert.equal(other.value, "other-agent"); await view.show("one"); assert.equal(input(container, "secret").value, "newer");
});

test("通用连接根据定义显示字段，动态资源发现与授权不丢失用户草稿", async () => {
  const ui = dom(), container = ui.get("connections"), calls: Record<string,unknown>[] = [];
  const requirement = { id: "data", kind: "business", protocol: "mcp", configFields: [
    { key: "library", label: "资料库", type: "select", options: [{ value: "old", label: "原资料库" }] },
    { key: "password", label: "附加密钥", type: "password" },
  ] };
  const connection = { id: "data", kind: "business", protocol: "mcp", authType: "oauth", configured: true };
  const view = createConnectionView<FixtureElement>({ document: ui.document, container, api: applicationApiFixture({
    connections: async () => ({ version: 1, connections: [connection], requirements: [requirement] }),
    discoverConnection: async () => ({ tools: [{ name: "lookup" }], configurationChoices: { library: [{ value: "mine", label: "我的资料" }] } }),
    authorizeConnection: async () => ({ authorizationUrl: "https://login.example/authorize" }),
    saveConnection: async (_id, body) => { calls.push(objectFields(body)); return { version: 2, connection }; },
  }) });
  await view.show("one");
  input(container, "baseUrl").value = "https://service.example/mcp"; await input(container, "baseUrl").dispatchEvent({ type: "input" });
  input(container, "values.password").value = "fixture-only"; await input(container, "values.password").dispatchEvent({ type: "input" });
  await descendants(container).find((node) => node.textContent === "发现工具与资源")!.click();
  assert.equal(input(container, "values.library").children[0]!.textContent, "我的资料");
  await descendants(container).find((node) => node.tag === "button" && node.textContent === "登录授权")!.click();
  assert.equal(descendants(container).find((node) => node.tag === "a")!.href, "https://login.example/authorize");
  assert.equal(input(container, "baseUrl").value, "https://service.example/mcp");
  await descendants(container).find((node) => node.tag === "form")!.dispatchEvent({ type: "submit", preventDefault() {} });
  assert.equal(objectFields(calls[0]!.values).password, "fixture-only"); assert.equal(input(container, "values.password").value, "");
});

test("应用API使用带版本的状态保存、幂等任务提交及专属连接的实际路由", async () => {
  const calls: {path:string;method?:string;body:{mutationId:string;deliveryVersion:string;expectedVersion:number}}[] = [], api = createApplicationApi(async (path, options) => { calls.push({ path, ...options, body: options!.body ? JSON.parse(String(options!.body)) : undefined }); return Response.json({ ok: true }); });
  await api.run("one", "search", { link: "https://example.com" }, "retry-key", "delivery-7");
  await api.saveState("one", { draft: "未提交" }, 4, "delivery-7"); await api.removeConnection("one", "search", 3);
  assert.equal(calls[0]!.body.mutationId, "retry-key"); assert.equal(calls[0]!.body.deliveryVersion, "delivery-7");
  assert.equal(calls[1]!.method, "PUT"); assert.equal(calls[1]!.body.expectedVersion, 4);
  assert.equal(calls[1]!.body.deliveryVersion, "delivery-7");
  assert.equal(calls[2]!.path, "/api/agents/one/connections/search/remove");
  await api.getState("one", "delivery:7"); assert.equal(calls[3]!.path, "/api/agents/one/application/state?deliveryVersion=delivery%3A7");
});

test("任务轮询保留已展开结果与键盘焦点，完成产物只通知一次刷新", async () => {
  const ui = dom(), list = ui.get("tasks"), completed: string[] = [];
  let progress = "读取网页";
  const tasks = createApplicationTasks<FixtureElement>({ document: ui.document, list, status: ui.get("status"), onCompleted: (id) => completed.push(id),
    api: applicationApiFixture({ tasks: async () => ({ tasks: [{ id: "finished", actionId: "search", status: "completed", result: { total: 2 }, artifacts: [{ path: "results.csv" }] },
      { id: "running", actionId: "search", status: "running", progress }] }) }) });
  try {
    tasks.start("one"); await settle();
    const result = descendants(list).find((node) => node.tag === "details"); result!.open = true;
    const summary = descendants(result!).find((node) => node.tag === "summary"); summary!.focus();
    await tasks.refresh(); assert.equal(descendants(list).find((node) => node.tag === "details"), result);
    progress = "筛选结果"; await tasks.refresh();
    const next = descendants(list).find((node) => node.tag === "details");
    assert.equal(next!.open, true); assert.equal(ui.document.activeElement, descendants(next!).find((node) => node.tag === "summary"));
    assert.deepEqual(completed, ["one"]);
  } finally { tasks.stop(); }
});

test("任务卡逐个产物按任务和索引预览下载，下载失败可重试且轮询不重开下载", async () => {
  const ui = dom(), previews: unknown[] = [], calls: unknown[][] = [], blobs: Blob[] = [], timers: (()=>void)[] = [];
  ui.document.defaultView = { URL: { createObjectURL(blob:Blob) { blobs.push(blob); return `blob:${blobs.length}`; }, revokeObjectURL() {} },
    setTimeout: (callback:()=>unknown) => timers.push(callback) };
  let resolve!: (value: Blob) => void, reject!: (error:Error)=>void, reads = 0, progress = "一";
  const pending = new Promise<Blob>((yes, no) => { resolve = yes; reject = no; });
  const tasks = createApplicationTasks<FixtureElement>({ document: ui.document, list: ui.get("tasks"), status: ui.get("status"),
    onArtifacts: (detail) => previews.push(detail), api: applicationApiFixture({
      tasks: async () => ({ tasks: [{ id: "task_old", status: "completed", progress,
        artifacts: [{ path: "a.csv" }, { path: "reports/result.csv" }] }] }),
      downloadArtifact: async (...args) => { calls.push(args); return ++reads === 1 ? pending : new Blob(["原始字节😀"]); },
    }) });
  try {
    tasks.start("one"); await settle();
    const buttons = () => descendants(ui.get("tasks")).filter((node) => node.tag === "button");
    const preview = buttons()[2], download = buttons()[3];
    assert.equal(preview!.type, "button"); assert.equal(download!.type, "button");
    assert.equal(preview!.attributes.get("aria-label"), "预览 reports/result.csv");
    await preview!.click(); assert.deepEqual(previews[0], { agentId: "one", taskId: "task_old", index: 1, artifact: { path: "reports/result.csv" } });
    download!.focus(); const first = download!.click(); await settle();
    assert.equal(download!.disabled, true); assert.equal(download!.attributes.get("aria-busy"), "true");
    progress = "二"; await tasks.refresh();
    const replacement = buttons()[3]; assert.equal(replacement!.disabled, true); assert.equal(ui.document.activeElement, replacement);
    await replacement!.click(); assert.equal(calls.length, 1);
    reject!(new Error("完整文件暂时不可读")); await first;
    assert.match(ui.get("status").textContent, /完整文件暂时不可读/); assert.equal(replacement!.disabled, false);
    await replacement!.click();
    assert.deepEqual(calls, [["one", "task_old", 1], ["one", "task_old", 1]]);
    assert.equal(await blobs[0]!.text(), "原始字节😀"); assert.equal(ui.downloads[0]!.download, "result.csv");
    assert.equal(ui.downloads[0]!.parent, ui.get("tasks"));
  } finally { resolve?.(new Blob()); tasks.stop(); }
});

test("无页面智能体在既有产物栏显示任务，开关产物或切换智能体不重复轮询和取消后台任务", async (t) => {
  const ui = dom(), pending = new Map(), calls: string[][] = [], previews: unknown[] = [];
  let timerId = 0;
  t.mock.method(globalThis, "setTimeout", (callback:()=>unknown, ms:number) => { const id = ++timerId; pending.set(id, { callback, ms }); return id; });
  t.mock.method(globalThis, "clearTimeout", (id:number) => pending.delete(id));
  const taskPanel = ui.document.createElement("details"), filePanel = ui.document.createElement("aside");
  taskPanel.append(ui.get("agent-application-task-status"), ui.get("agent-application-task-list"));
  ui.get("agent-application").append(taskPanel); filePanel.append(ui.get("agent-file-list"));
  ui.get("agent-file-dialog").append(filePanel);
  ui.document.addEventListener("neuma:agent-task-artifact-open", (event) => previews.push(event.detail));
  const noPage = { ...application, pageReady: false, defaultEntry: "conversation", manifest: { protocolVersion: 3, page: null } };
  const view = createApplicationWorkspace<FixtureElement>({ ...ui, api: applicationApiFixture({
      tasks: async (id) => { calls.push(["tasks", id]); return { tasks: [{ id: `task_${id}`, title: `${id}的任务`, status: "completed", artifacts: [{ path: "result.csv" }] }] }; },
    cancel: async () => calls.push(["cancel"]), open: async () => { throw new Error("无页面不应打开iframe"); }, close: async () => calls.push(["close"]),
  }) });
  try {
    view.route("one"); view.update("one", noPage); await settle();
    assert.equal(taskPanel.parentElement, filePanel); assert.equal(ui.get("agent-application").hidden, true);
    assert.equal(calls.filter(([name]) => name === "tasks").length, 1); assert.equal(pending.size, 1);
    const preview = descendants(taskPanel).find((node) => node.tag === "button" && node.textContent === "预览");
    preview!.focus(); taskPanel.open = true;
    ui.get("agent-file-dialog").showModal(); await preview!.click(); await ui.get("agent-file-dialog").close();
    assert.deepEqual(previews[0], { agentId: "one", taskId: "task_one", index: 0, artifact: { path: "result.csv" } });
    view.update("one", noPage); ui.get("agent-file-dialog").showModal();
    assert.equal(taskPanel.open, true); assert.equal(calls.length, 1); assert.equal(pending.size, 1);
    await ui.document.dispatchEvent(new CustomEvent("neuma:agent-turn-finished", { detail: { agentId: "one" } })); await settle();
    assert.equal(calls.length, 2); assert.equal(pending.size, 1);
    view.route("two"); assert.equal(ui.get("agent-application-task-list").children.length, 0);
    await preview!.click(); assert.equal(previews.length, 1);
    view.update("two", noPage); await settle();
    assert.equal(pending.size, 1); assert.deepEqual(calls.at(-1), ["tasks", "two"]);
    assert.ok(!text(taskPanel).includes("one的任务")); assert.ok(text(taskPanel).includes("two的任务"));
    assert.equal(calls.some(([name]) => name === "cancel"), false);
    view.route("one"); view.update("one", noPage); await settle(); assert.equal(pending.size, 1);
    assert.deepEqual(calls.at(-1), ["tasks", "one"]);
  } finally { view.close(); }
  assert.equal(pending.size, 0);
});
