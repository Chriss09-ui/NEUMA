import test from "node:test";
import assert from "node:assert/strict";
import { boundAssistantLayout, createApplicationAssistant } from "../public/application-assistant.js";
import { createApplicationWorkspace, applicationMode } from "../public/application-workspace.js";
import { renderAgentAvatar, setAgentAvatarActivity } from "../public/agent-avatar.js";

function setup() {
  class Events {
    listeners = new Map();
    addEventListener(type, fn) { this.listeners.set(type, [...this.listeners.get(type) || [], fn]); }
    removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter((entry) => entry !== fn)); }
    dispatchEvent(event) { event.currentTarget ||= this; event.target ||= this; event.preventDefault ||= () => {}; return Promise.all((this.listeners.get(event.type) || []).map((fn) => fn(event))); }
  }
  const document = new Events(), nodes = new Map(), values = new Map(), timers = new Map();
  let bounds = { width: 1000, height: 700 };
  class Element extends Events {
    children = []; classes = new Set(); attributes = new Map(); dataset = {}; hidden = false; textContent = ""; value = "";
    style = { setProperty: (key, value) => this.attributes.set(key, value) };
    classList = { toggle: (key, on) => on ? this.classes.add(key) : this.classes.delete(key) };
    contentWindow = { postMessage() {} };
    get parentElement() { return this.parent; }
    getBoundingClientRect() { return bounds; }
    append(...elements) { for (const node of elements) { node.remove(); node.parent = this; this.children.push(node); } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this); this.parent = null; }
    replaceChildren(...elements) { for (const node of this.children) node.parent = null; this.children = []; this.append(...elements); }
    setAttribute(key, value) { this.attributes.set(key, value); }
    setPointerCapture(id) { this.captured = id; }
    releasePointerCapture() { this.captured = null; }
    focus() { document.activeElement = this; }
    close() { return this.dispatchEvent({ type: "close" }); }
    click() { return this.disabled ? Promise.resolve() : this.dispatchEvent({ type: "click" }); }
  }
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  document.getElementById = get; document.createElement = () => new Element();
  const window = new Events(); window.location = { origin: "http://127.0.0.1:3000" };
  window.setTimeout = (fn) => { const id = Symbol(); timers.set(id, fn); return id; };
  window.clearTimeout = (id) => timers.delete(id);
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  return { document, window, storage, get, values, timers, root: get("agent-workspace"), setBounds: (next) => { bounds = next; } };
}
const settle = () => new Promise(setImmediate);
const instance = { instanceId: "instance-1", origin: "http://127.0.0.1:4011", url: "http://127.0.0.1:4011/ui/index.html", deliveryVersion: "delivery-1" };
const application = { pageReady: true, deliveryVersion: instance.deliveryVersion, defaultEntry: "application", assistant: { enabled: true, purpose: "解释当前指标并调整筛选" }, manifest: { page: { entrypoint: "ui/index.html" } }, actions: [] };

test("浮窗限制在工作区内，不接受损坏的持久尺寸", () => {
  const bounded = boundAssistantLayout({ expanded: true, x: -100, y: 9999, width: 9000, height: NaN }, { width: 800, height: 600 });
  assert.deepEqual(bounded, { expanded: true, x: 16, y: 144, width: 768, height: 440 });
  assert.equal(boundAssistantLayout({ expanded: false, height: 800 }, { width: 800, height: 600 }).height, 64);
});

test("浮窗星核同步真实活动且重复进度、收起展开和设置隐藏不重建动画节点", () => {
  const ui = setup(), observers = [];
  ui.window.MutationObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { this.disconnected = true; }
  };
  const source = ui.get("agent-icon"), target = ui.get("agent-assistant-avatar");
  const one = { id: "one", profile: { icon: "star:4:1" } };
  renderAgentAvatar(source, one, { document: ui.document });
  const view = createApplicationAssistant(ui); view.select("one"); view.show(true);
  const star = target.children[0], observer = observers[0];
  assert.equal(star.dataset.avatarMotion, "true");
  assert.equal(star.dataset.activity, "idle");
  for (const activity of ["thinking", "thinking", "working", "working", "queued", "idle"]) {
    setAgentAvatarActivity(source, activity);
    observer.callback([{ type: "attributes", attributeName: "data-avatar-activity", target: source }]);
    assert.equal(target.children[0], star);
    assert.equal(star.dataset.activity, activity);
  }
  view.expand(); view.toggle(); view.show(false); view.show(true);
  assert.equal(target.children[0], star);
  renderAgentAvatar(source, { id: "two", profile: { icon: "star:0:0" } }, { document: ui.document, activity: "thinking" });
  view.select("two");
  const second = target.children[0];
  observer.callback([{ type: "attributes", attributeName: "data-avatar-activity", target: source, oldValue: "working" }]);
  assert.equal(target.children[0], second);
  assert.equal(second.dataset.shape, "cut");
  assert.equal(second.dataset.color, "mint");
  assert.equal(second.dataset.activity, "thinking");
  renderAgentAvatar(source, { id: "two", profile: { icon: "☀️" } }, { document: ui.document });
  observer.callback([{ type: "childList", target: source }]);
  assert.equal(target.textContent, "☀️");
  assert.equal(target.children.length, 0);
  renderAgentAvatar(source, one, { document: ui.document, activity: "working" });
  observer.callback([{ type: "attributes", attributeName: "data-avatar-key", target: source }]);
  assert.equal(target.children[0].dataset.activity, "working");
  view.close(); assert.equal(observer.disconnected, true);
});

test("开合动画可连续反向，结束后清理，保留输入和焦点", () => {
  const ui = setup(), view = createApplicationAssistant(ui);
  view.select("one"); view.show(true);
  assert.equal(ui.timers.size, 0);
  ui.get("agent-message").value = "未发送草稿"; ui.get("agent-message").focus();
  view.expand();
  assert.equal(ui.root.classes.has("application-assistant-expanding"), true);
  view.toggle(); view.toggle();
  assert.equal(ui.timers.size, 1);
  assert.equal(view.isExpanded(), true);
  [...ui.timers.values()][0]();
  assert.equal(ui.root.classes.has("application-assistant-animating"), false);
  assert.equal(ui.root.classes.has("application-assistant-expanding"), false);
  assert.equal(ui.timers.size, 0);
  assert.equal(ui.get("agent-message").value, "未发送草稿");
  assert.equal(ui.document.activeElement, ui.get("agent-message"));
});

test("拖动、拉伸、隐藏和切 Agent 立即结束动画，减少动态效果时直接开合", async () => {
  const ui = setup(), view = createApplicationAssistant(ui);
  view.select("one"); view.show(true); view.expand();
  await ui.get("agent-assistant-header").dispatchEvent({ type: "pointerdown", pointerId: 8, button: 0, clientX: 600, clientY: 300 });
  assert.equal(ui.timers.size, 0);
  assert.equal(ui.root.classes.has("application-assistant-animating"), false);
  await ui.window.dispatchEvent({ type: "pointerup", pointerId: 8 });
  view.toggle(); view.expand(); view.show(false);
  assert.equal(ui.timers.size, 0);
  view.show(true); view.toggle(); view.select("two");
  assert.equal(ui.timers.size, 0);
  await ui.get("agent-assistant-resize-se").dispatchEvent({ type: "pointerdown", pointerId: 9, button: 0, clientX: 980, clientY: 680 });
  assert.equal(view.isExpanded(), true); assert.equal(ui.timers.size, 0);
  await ui.window.dispatchEvent({ type: "pointerup", pointerId: 9 });
  ui.window.matchMedia = () => ({ matches: true });
  view.toggle(); view.expand();
  assert.equal(view.isExpanded(), true); assert.equal(ui.timers.size, 0);
  view.close();
});

test("展开中途拖动接住当前画面的位置与尺寸，释放后才恢复最小高度", async () => {
  const ui = setup(), view = createApplicationAssistant(ui);
  ui.root.getBoundingClientRect = () => ({ x: 200, y: 40, width: 1000, height: 700 });
  view.select("one"); view.show(true); view.expand();
  ui.get("agent-conversation").getBoundingClientRect = () => ({ x: 800, y: 600, width: 380, height: 120 });
  await ui.get("agent-assistant-header").dispatchEvent({ type: "pointerdown", pointerId: 10, button: 0, clientX: 820, clientY: 620 });
  assert.deepEqual(view.layout(), { expanded: true, x: 600, y: 560, width: 380, height: 120 });
  assert.equal(ui.timers.size, 0);
  await ui.window.dispatchEvent({ type: "pointermove", pointerId: 10, clientX: 780, clientY: 580 });
  assert.deepEqual(view.layout(), { expanded: true, x: 560, y: 520, width: 380, height: 120 });
  await ui.window.dispatchEvent({ type: "pointerup", pointerId: 10 });
  assert.equal(view.layout().height, 240);
  assert.equal(ui.timers.size, 1);
  view.toggle(); view.expand();
  const destination = view.layout();
  await ui.get("agent-assistant-header").dispatchEvent({ type: "pointerdown", pointerId: 11, button: 0, clientX: 820, clientY: 620 });
  await ui.window.dispatchEvent({ type: "pointerup", pointerId: 11 });
  assert.deepEqual(view.layout(), destination);
  view.close();
});

test("初始玻璃输入条在首次真实消息后展开，设置暂藏与刷新不重建会话和页面", async () => {
  const ui = setup(), calls = [], view = createApplicationWorkspace({ ...ui, api: {
    open: async () => instance, close: async (...args) => calls.push(args), tasks: async () => ({ tasks: [] }),
  } });
  try {
    view.route("dashboard"); view.update("dashboard", application); await settle();
    const frame = ui.get("agent-application-frame-host").children[0];
    assert.equal(ui.root.classes.has("application-assistant-open"), true);
    assert.equal(ui.root.classes.has("application-assistant-compact"), true);
    assert.equal(ui.get("agent-assistant-toggle").attributes.get("aria-expanded"), "false");
    assert.equal(ui.get("agent-conversation").inert, false);
    ui.get("agent-message").value = "为什么本周下降？";
    await ui.document.dispatchEvent({ type: "neuma:agent-message-started", detail: { agentId: "other" } });
    assert.equal(ui.root.classes.has("application-assistant-compact"), true);
    await ui.document.dispatchEvent({ type: "neuma:agent-message-started", detail: { agentId: "dashboard", sessionId: "session-1" } });
    assert.equal(ui.root.classes.has("application-assistant-compact"), false);
    assert.equal(ui.get("agent-assistant-toggle").attributes.get("aria-expanded"), "true");
    await ui.document.dispatchEvent({ type: "neuma:agent-settings-view", detail: { agentId: "dashboard", active: true } });
    assert.equal(ui.get("agent-conversation").inert, true);
    ui.get("agent-panel-toggle").focus();
    await ui.document.dispatchEvent({ type: "neuma:agent-settings-view", detail: { agentId: "dashboard", active: false } });
    assert.equal(ui.get("agent-conversation").inert, false);
    assert.equal(ui.document.activeElement, ui.get("agent-panel-toggle"));
    assert.equal(ui.get("agent-application-frame-host").children[0], frame);
    assert.equal(ui.get("agent-message").value, "为什么本周下降？");
    await ui.get("agent-assistant-collapse").click();
    assert.equal(ui.root.classes.has("application-assistant-compact"), true);
    assert.equal(ui.get("agent-assistant-toggle").attributes.get("aria-expanded"), "false");
    assert.equal(calls.length, 0);
  } finally { view.close(); }
});

test("拖动跨 iframe 有指针捕获与遮层，移出边界会夹紧，切 Agent 取消手势", async () => {
  const ui = setup(), view = createApplicationAssistant(ui);
  view.select("one"); view.show(true);
  await ui.get("agent-assistant-header").dispatchEvent({ type: "pointerdown", pointerId: 7, button: 0, clientX: 700, clientY: 630 });
  assert.equal(ui.get("agent-assistant-pointer-shield").hidden, false);
  assert.equal(ui.get("agent-assistant-header").captured, 7);
  await ui.window.dispatchEvent({ type: "pointermove", pointerId: 7, clientX: -1000, clientY: -1000 });
  assert.equal(view.layout().x, 16); assert.equal(view.layout().y, 16);
  view.select("two");
  assert.equal(ui.get("agent-assistant-pointer-shield").hidden, true);
  const second = view.layout();
  await ui.window.dispatchEvent({ type: "pointermove", pointerId: 7, clientX: 9999, clientY: 9999 });
  assert.deepEqual(view.layout(), second);
  view.select("one"); assert.equal(view.layout().x, 16); assert.equal(view.layout().y, 16);
});

test("边缘拉伸展开真实窗口，键盘移动调整尺寸并按 Agent 恢复", async () => {
  const ui = setup(), view = createApplicationAssistant(ui);
  view.select("one"); view.show(true);
  await ui.get("agent-assistant-resize-se").dispatchEvent({ type: "pointerdown", pointerId: 1, button: 0, clientX: 980, clientY: 680 });
  assert.equal(view.isExpanded(), true); assert.equal(view.layout().height, 440);
  await ui.window.dispatchEvent({ type: "pointermove", pointerId: 1, clientX: 900, clientY: 600 });
  await ui.window.dispatchEvent({ type: "pointerup", pointerId: 1 });
  assert.equal(view.layout().width, 320); assert.equal(view.layout().height, 360);
  const before = view.layout();
  await ui.get("agent-assistant-move").dispatchEvent({ type: "keydown", key: "ArrowLeft" });
  await ui.get("agent-assistant-resize-se").dispatchEvent({ type: "keydown", key: "ArrowDown" });
  assert.equal(view.layout().x, before.x - 8); assert.equal(view.layout().height, before.height + 8);
  const saved = view.layout(); view.select("two"); assert.equal(view.isExpanded(), false); view.select("one");
  assert.deepEqual(view.layout(), saved);
  await ui.get("agent-assistant-reset").click();
  assert.deepEqual(view.layout(), { x: 584, y: 244, width: 400, height: 440, expanded: true });
});

test("设置收窄工作区只夹紧当前展示，恢复后保留原位置及尺寸", () => {
  const ui = setup(), view = createApplicationAssistant(ui);
  view.select("one"); view.show(true); view.expand();
  const before = view.layout(); view.show(false); ui.setBounds({ width: 500, height: 500 }); view.show(false);
  ui.setBounds({ width: 1000, height: 700 }); view.show(true);
  assert.deepEqual(view.layout(), before);
});

test("工作区缩小时浮窗仍可触达，恢复宽度后不丢原布局", async () => {
  const ui = setup(), view = createApplicationAssistant(ui);
  view.select("one"); view.show(true); view.expand();
  const before = view.layout(); ui.setBounds({ width: 360, height: 300 });
  await ui.window.dispatchEvent({ type: "resize" });
  assert.deepEqual(view.layout(), { expanded: true, x: 16, y: 16, width: 328, height: 268 });
  ui.setBounds({ width: 1000, height: 700 }); await ui.window.dispatchEvent({ type: "resize" });
  assert.deepEqual(view.layout(), before);
});

test("助手显式关闭不展示浮窗；旧应用只保留手动入口，默认打开方式尊重本地选择", async () => {
  const ui = setup(), view = createApplicationWorkspace({ ...ui, api: { open: async () => instance, close: async () => {}, tasks: async () => ({ tasks: [] }) } });
  try {
    view.route("none"); view.update("none", { ...application, assistant: { enabled: false } }); await settle();
    assert.equal(ui.get("agent-assistant-toggle").hidden, true);
    assert.equal(ui.root.classes.has("application-assistant-open"), false);
    view.route("legacy"); view.update("legacy", { ...application, assistant: undefined }); await settle();
    assert.equal(ui.get("agent-assistant-toggle").hidden, false);
    assert.equal(ui.root.classes.has("application-assistant-open"), false);
    await ui.get("agent-assistant-toggle").click();
    assert.equal(ui.root.classes.has("application-assistant-open"), true);
    assert.equal(ui.root.classes.has("application-assistant-compact"), false);
    view.route("chat"); view.update("chat", { ...application, defaultEntry: "conversation" });
    assert.equal(ui.root.classes.has("is-application"), false);
    await ui.get("agent-view-application").click();
    assert.equal(applicationMode(ui.storage, "chat", "conversation"), "application");
    await ui.get("agent-view-chat").click();
    assert.equal(applicationMode(ui.storage, "chat", "application"), "chat");
  } finally { view.close(); }
});
