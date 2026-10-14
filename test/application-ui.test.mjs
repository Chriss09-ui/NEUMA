import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createApplicationApi } from "../public/application-api.js";
import { installApplicationHostBridge } from "../public/application-bridge.js";
import { applicationMode, createApplicationWorkspace } from "../public/application-workspace.js";
import { connectionStatus, createConnectionView } from "../public/agent-connections.js";
import { createApplicationTasks } from "../public/application-tasks.js";

const settle = () => new Promise(setImmediate);
function dom() {
  class Events {
    listeners = new Map();
    addEventListener(type, callback) { this.listeners.set(type, [...this.listeners.get(type) || [], callback]); }
    removeEventListener(type, callback) { this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== callback)); }
    dispatchEvent(event) { return Promise.all((this.listeners.get(event.type) || []).map((callback) => callback(event))); }
  }
  const document = new Events(), nodes = new Map();
  class Element extends Events {
    constructor(tag) { super(); this.tag = tag; }
    children = []; attributes = new Map(); hidden = false; value = ""; textContent = ""; disabled = false; open = false; classes = new Set();
    classList = { toggle: (name, active) => active ? this.classes.add(name) : this.classes.delete(name) };
    contentWindow = { postMessage() {} };
    get parentElement() { return this.parent || null; }
    append(...values) { for (const value of values) { value.remove(); value.parent = this; this.children.push(value); } }
    replaceChildren(...values) { for (const child of this.children) child.parent = null; this.children = []; this.append(...values); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    focus() { document.activeElement = this; }
    click() { return this.disabled ? Promise.resolve() : this.dispatchEvent({ type: "click" }); }
    showModal() { this.open = true; }
    close() { this.open = false; return this.dispatchEvent({ type: "close" }); }
  }
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, new Element("div")); return nodes.get(id); };
  document.getElementById = get; document.createElement = (tag) => new Element(tag);
  get("agent-history-heading").append(get("agent-conversation-actions"));
  get("agent-conversation-actions").append(get("agent-new-chat"));
  const window = new Events(); window.location = { origin: "http://127.0.0.1:3000" };
  return { document, window, get };
}
const descendants = (node) => [node, ...node.children.flatMap(descendants)];
const text = (node) => descendants(node).map((item) => item.textContent).join(" ");
const input = (node, key) => descendants(node).find((item) => item.name === key);
const instance = { instanceId: "instance-one", origin: "http://127.0.0.1:4011", url: "http://127.0.0.1:4011/ui/index.html", deliveryVersion: "delivery-7" };
const application = { pageReady: true, deliveryVersion: "delivery-7", manifest: { protocolVersion: 2, page: { entrypoint: "ui/index.html" } }, actions: [{ id: "search", title: "搜寻资料", ready: true }] };

test("页面桥拒绝伪造窗口、来源、实例及版本，身份只由宿主绑定且重复请求只执行一次", async () => {
  const ui = dom(), frame = ui.document.createElement("iframe"), calls = [], replies = [];
  frame.contentWindow.postMessage = (...value) => replies.push(value);
  const detach = installApplicationHostBridge({ window: ui.window, frame, instance, agentId: "one", api: {
    run: async (...args) => { calls.push(args); return { taskId: "stable-task" }; },
  } });
  const request = { channel: "neuma.application", protocolVersion: 1, type: "request", instanceId: instance.instanceId,
    deliveryVersion: instance.deliveryVersion, requestId: "req-1", method: "actions.run", params: { actionId: "search", input: { link: "https://example.com" }, agentId: "other" } };
  const send = (overrides = {}) => ui.window.dispatchEvent({ type: "message", origin: instance.origin, source: frame.contentWindow, data: request, ...overrides });
  await send({ origin: "http://127.0.0.1:4000" }); await send({ source: {} });
  for (const field of ["instanceId", "deliveryVersion", "protocolVersion"]) await send({ data: { ...request, [field]: "forged" } });
  assert.equal(calls.length, 0); assert.equal(replies.length, 0);
  await Promise.all([send(), send()]);
  assert.equal(calls.length, 1); assert.equal(calls[0][0], "one"); assert.equal(calls[0][3], "instance-one-req-1");
  assert.equal(replies[0][1], instance.origin); assert.equal(replies[0][0].result.taskId, "stable-task");
  await send({ data: { ...request, requestId: "req-2", method: "connections.get" } });
  assert.match(replies.at(-1)[0].error.message, /未开放/);
  detach(); await send({ data: { ...request, requestId: "req-3" } }); assert.equal(calls.length, 1);
});

test("页面桥释放后不接受迟到回执，循环消息与超大消息安全忽略", async () => {
  const ui = dom(), frame = ui.document.createElement("iframe"), replies = []; let release;
  frame.contentWindow.postMessage = (...args) => replies.push(args);
  const detach = installApplicationHostBridge({ window: ui.window, frame, instance, agentId: "one", api: {
    getState: () => new Promise((resolve) => { release = resolve; }),
  } });
  const data = { channel: "neuma.application", type: "request", protocolVersion: 1, ...instance, requestId: "one", method: "state.get" };
  const send = (data) => ui.window.dispatchEvent({ type: "message", data, source: frame.contentWindow, origin: instance.origin });
  const circular = { ...data, params: {} }; circular.params.self = circular;
  await send(circular); await send({ ...data, params: { huge: "x".repeat(1_048_577) } }); assert.equal(release, undefined);
  const pending = send(data); await settle(); detach(); release({ state: {}, version: 1 }); await pending;
  assert.equal(replies.length, 0);
});

test("iframe桥只信任指定父窗口，未匹配响应不能伪造完成", async () => {
  const ui = dom(), sent = [], timers = new Map(); let timerId = 0;
  ui.window.parent = { postMessage: (message, origin) => sent.push({ message, origin }) };
  ui.window.__NEUMA_APPLICATION__ = { ...instance, parentOrigin: "http://127.0.0.1:3000" };
  vm.runInNewContext(await readFile(new URL("../public/application-frame-bridge.js", import.meta.url), "utf8"), {
    window: ui.window, setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; }, clearTimeout: (id) => timers.delete(id),
  });
  const pending = ui.window.neuma.actions.run("search", { link: "https://example.com" }, { mutationId: "retry-key" });
  assert.equal(ui.window.__NEUMA_APPLICATION__, undefined); assert.equal(sent[0].origin, ui.window.location.origin);
  assert.equal(sent[0].message.params.mutationId, "retry-key");
  const response = { ...sent[0].message, type: "response", result: { taskId: "done" } };
  await ui.window.dispatchEvent({ type: "message", source: {}, origin: ui.window.location.origin, data: response });
  assert.equal(timers.size, 1);
  await ui.window.dispatchEvent({ type: "message", source: ui.window.parent, origin: ui.window.location.origin, data: response });
  assert.equal((await pending).taskId, "done"); assert.equal(timers.size, 0);
});

test("应用与助手复用聊天区域，切换保留页面草稿，不取消后台任务，按Agent记住入口", async () => {
  const ui = dom(), calls = [], stored = new Map();
  const storage = { getItem: (key) => stored.get(key), setItem: (key, value) => stored.set(key, value) };
  const view = createApplicationWorkspace({ ...ui, storage, api: {
    open: async (id) => { calls.push(["open", id]); return instance; }, close: async (...args) => calls.push(["close", ...args]),
    tasks: async () => ({ tasks: [] }),
  } });
  try {
    view.route("one"); view.update("one", application); await settle();
    assert.equal(ui.get("agent-new-chat").hidden, true);
    assert.equal(ui.get("agent-conversation").inert, true);
    assert.equal(ui.get("agent-conversation").attributes.get("aria-hidden"), "true");
    assert.equal(ui.get("agent-conversation-actions").parentElement, ui.get("agent-history-heading"));
    const frame = ui.get("agent-application-frame-host").children[0]; frame.savedDraft = "还未发送的链接";
    assert.equal(frame.attributes.get("sandbox"), "allow-scripts allow-same-origin");
    ui.get("agent-message").value = "对话草稿";
    await ui.get("agent-view-chat").click();
    assert.equal(ui.get("agent-new-chat").hidden, false);
    assert.equal(ui.get("agent-conversation").inert, false);
    assert.equal(ui.get("agent-conversation").attributes.get("aria-hidden"), "false");
    assert.equal(ui.get("agent-conversation-actions").parentElement, ui.get("agent-history-heading"));
    await ui.get("agent-view-application").click();
    assert.equal(ui.get("agent-new-chat").hidden, true);
    assert.equal(ui.get("agent-conversation").inert, true);
    assert.equal(ui.get("agent-application-frame-host").children[0], frame);
    assert.equal(frame.savedDraft, "还未发送的链接"); assert.equal(ui.get("agent-message").value, "对话草稿");
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
    assert.equal(ui.get("agent-conversation-actions").parentElement, ui.get("agent-history-heading"));
    await ui.get("agent-view-chat").click();
    assert.equal(ui.get("agent-conversation").inert, false);
    assert.equal(ui.get("agent-conversation").attributes.get("aria-hidden"), "false");
    assert.equal(applicationMode(storage, "one"), "chat"); assert.equal(applicationMode(storage, "two"), "application");
    assert.deepEqual(calls, [["open", "one"]]);
    view.route("two"); await settle(); assert.equal(calls[1][0], "close"); assert.equal(calls[1][1], "one");
    assert.equal(ui.get("agent-conversation").inert, false);
    assert.equal(ui.get("agent-conversation").attributes.get("aria-hidden"), "false");
    assert.equal(ui.get("agent-new-chat").hidden, false);
    assert.equal(ui.get("agent-conversation-actions").parentElement, ui.get("agent-history-heading"));
  } finally { view.close(); }
});

for (const initiallyOpen of [false, true]) test(`应用设置临时替换${initiallyOpen ? "已展开" : "已收起"}的助手，关闭恢复并保留页面和聊天草稿`, async () => {
  const ui = dom(), calls = [];
  const view = createApplicationWorkspace({ ...ui, api: {
    open: async (id) => { calls.push(["open", id]); return instance; },
    close: async (...args) => calls.push(["close", ...args]), tasks: async () => ({ tasks: [] }),
  } });
  const settings = (agentId, active) => ui.document.dispatchEvent({ type: "neuma:agent-settings-view", detail: { agentId, active } });
  const assistantVisible = () => ui.get("agent-workspace").classes.has("application-assistant-open");
  try {
    view.route("one"); view.update("one", application); await settle();
    if (initiallyOpen) await ui.get("agent-assistant-toggle").click();
    const frame = ui.get("agent-application-frame-host").children[0]; frame.savedDraft = "页面草稿";
    ui.get("agent-message").value = "聊天草稿";
    assert.equal(assistantVisible(), initiallyOpen);
    assert.equal(ui.get("agent-conversation").inert, !initiallyOpen);
    assert.equal(ui.get("agent-conversation-actions").parentElement, ui.get(initiallyOpen ? "agent-assistant-actions" : "agent-history-heading"));
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
    assert.equal(ui.get("agent-conversation-actions").parentElement, ui.get("agent-history-heading"));
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
    assert.equal(ui.get("agent-conversation-actions").parentElement, ui.get(initiallyOpen ? "agent-assistant-actions" : "agent-history-heading"));
    assert.equal(ui.document.activeElement, ui.get("agent-panel-toggle"));
    assert.equal(ui.get("agent-application-frame-host").children[0], frame);
    assert.equal(frame.savedDraft, "页面草稿");
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
    assert.equal(ui.get("agent-conversation-actions").parentElement, ui.get("agent-history-heading"));
    view.route(null);
    assert.equal(ui.get("agent-conversation").inert, false);
    assert.equal(ui.get("agent-conversation").attributes.get("aria-hidden"), "false");
  } finally { view.close(); }
});

test("缺连接时应用可打开并给出配置入口，离开后迟到资源必须释放", async () => {
  const ui = dom(), closed = []; let release;
  const view = createApplicationWorkspace({ ...ui, api: { open: () => new Promise((resolve) => { release = resolve; }), close: async (...args) => closed.push(args), tasks: async () => ({ tasks: [] }) } });
  view.route("one"); view.update("one", { ...application, actions: [{ id: "sync", title: "同步资料", ready: false, missingConnections: ["crm"] }] });
  assert.equal(ui.get("agent-application").hidden, false); assert.equal(ui.get("agent-application-configure").disabled, false);
  assert.match(ui.get("agent-application-connection-text").textContent, /同步资料.*配置/);
  view.route("two"); release(instance); await settle();
  assert.equal(ui.get("agent-application-frame-host").children.length, 0); assert.deepEqual(closed[0], ["one", instance.instanceId]);
  view.close();
});

test("连接保存失败保留认证输入，成功清除秘密且配置不写浏览器备份", async () => {
  const ui = dom(), container = ui.get("connections"), calls = []; let failed = true;
  const requirement = { id: "search", kind: "search", label: "专属搜索", required: false };
  const view = createConnectionView({ document: ui.document, container, api: {
    connections: async () => ({ version: 0, connections: [], requirements: [requirement] }),
    saveConnection: async (id, body) => { calls.push({ id, body }); if (failed) throw new Error("磁盘暂时不可写"); return { version: 1, connections: [{ id: "search", configured: true, hasSecret: true, status: "configured" }] }; },
  } });
  await view.show("one"); const form = descendants(container).find((node) => node.tag === "form"), secret = input(form, "secret");
  secret.value = "test-fixture-secret"; await secret.dispatchEvent({ type: "input" });
  await form.dispatchEvent({ type: "submit", preventDefault() {} });
  assert.equal(secret.value, "test-fixture-secret"); assert.match(text(container), /磁盘暂时不可写.*输入已保留/);
  view.hide(); await view.show("one"); assert.equal(input(container, "secret").value, "test-fixture-secret");
  failed = false; await form.dispatchEvent({ type: "submit", preventDefault() {} });
  assert.equal(secret.value, ""); assert.match(text(container), /已配置，尚未验证/);
  assert.equal(calls[1].body.expectedVersion, 0); assert.equal(calls[1].id, "one");
  assert.equal(connectionStatus({ required: true }, null), "必需待配置");
  assert.equal(connectionStatus(requirement, { status: "verified" }), "已验证");
  assert.doesNotMatch(await readFile(new URL("../public/agent-connections.js", import.meta.url), "utf8"), /localStorage|sessionStorage|setItem|indexedDB/);
});

test("连接保存期间的新输入和其他Agent的表单不被迟到回执覆盖", async () => {
  const ui = dom(), container = ui.get("connections"); let release;
  const view = createConnectionView({ document: ui.document, container, api: {
    connections: async () => ({ version: 0, connections: [], requirements: [{ id: "model", kind: "model" }] }),
    saveConnection: () => new Promise((resolve) => { release = resolve; }),
  } });
  await view.show("one"); const form = descendants(container).find((node) => node.tag === "form"), secret = input(form, "secret");
  secret.value = "first"; await secret.dispatchEvent({ type: "input" });
  const saving = form.dispatchEvent({ type: "submit", preventDefault() {} });
  secret.value = "newer"; await secret.dispatchEvent({ type: "input" });
  await view.show("two"); const other = input(container, "secret"); other.value = "other-agent"; await other.dispatchEvent({ type: "input" });
  release({ version: 1, connection: { id: "model", configured: true } }); await saving;
  assert.equal(other.value, "other-agent"); await view.show("one"); assert.equal(input(container, "secret").value, "newer");
});

test("应用API使用带版本的状态保存、幂等任务提交及专属连接的实际路由", async () => {
  const calls = [], api = createApplicationApi(async (path, options) => { calls.push({ path, ...options, body: options.body ? JSON.parse(options.body) : undefined }); return Response.json({ ok: true }); });
  await api.run("one", "search", { link: "https://example.com" }, "retry-key", "delivery-7");
  await api.saveState("one", { draft: "未提交" }, 4, "delivery-7"); await api.removeConnection("one", "search", 3);
  assert.equal(calls[0].body.mutationId, "retry-key"); assert.equal(calls[0].body.deliveryVersion, "delivery-7");
  assert.equal(calls[1].method, "PUT"); assert.equal(calls[1].body.expectedVersion, 4);
  assert.equal(calls[1].body.deliveryVersion, "delivery-7");
  assert.equal(calls[2].path, "/api/agents/one/connections/search/remove");
  await api.getState("one", "delivery:7"); assert.equal(calls[3].path, "/api/agents/one/application/state?deliveryVersion=delivery%3A7");
});

test("任务轮询保留已展开结果与键盘焦点，完成产物只通知一次刷新", async () => {
  const ui = dom(), list = ui.get("tasks"), completed = [];
  let progress = "读取网页";
  const tasks = createApplicationTasks({ document: ui.document, list, status: ui.get("status"), onCompleted: (id) => completed.push(id),
    api: { tasks: async () => ({ tasks: [{ id: "finished", actionId: "search", status: "completed", result: { total: 2 }, artifacts: [{ path: "results.csv" }] },
      { id: "running", actionId: "search", status: "running", progress }] }) } });
  try {
    tasks.start("one"); await settle();
    const result = descendants(list).find((node) => node.tag === "details"); result.open = true;
    const summary = descendants(result).find((node) => node.tag === "summary"); summary.focus();
    await tasks.refresh(); assert.equal(descendants(list).find((node) => node.tag === "details"), result);
    progress = "筛选结果"; await tasks.refresh();
    const next = descendants(list).find((node) => node.tag === "details");
    assert.equal(next.open, true); assert.equal(ui.document.activeElement, descendants(next).find((node) => node.tag === "summary"));
    assert.deepEqual(completed, ["one"]);
  } finally { tasks.stop(); }
});
