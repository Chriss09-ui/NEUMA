import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { agentDisplayDescription, agentDisplayName } from "../public/state.js";
import * as view from "../public/agent-details-view.js";
import * as avatar from "../public/agent-avatar.js";

const source = (await readFile(new URL("../public/agent-details.js", import.meta.url), "utf8")).replace(/^import .*;\n/gm, "");
const settle = () => new Promise(setImmediate);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const agents = {
  one: { id: "one", name: "会议助手", draft: { goal: { value: "整理会议" } } },
  two: { id: "two", name: "周报助手", draft: { goal: { value: "整理周报" } } },
};
const runtimeFor = (id, overrides = {}) => ({ agentId: id, agent: agents[id], definition: { ...agents[id], revision: 1 },
  status: "ready", ready: true, busy: false, error: "", ...overrides });

async function setup({ files, file, memory, saveMemory, saveProfile, initial = "one", stored = new Map(), initialRuntime = {}, reduceMotion = false, panelMotion = false } = {}) {
  class Events {
    listeners = new Map();
    addEventListener(type, callback) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]); }
    removeEventListener(type, callback) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((listener) => listener !== callback)); }
    dispatchEvent(event) { event.target ??= this; return Promise.all((this.listeners.get(event.type) ?? []).map((callback) => callback(event))); }
  }
  const document = new Events(), nodes = new Map(), requests = [], emitted = [], downloads = [], urls = [], timers = [], animations = [];
  const clearedTimers = new Set(), timerDurations = [], layoutReads = [];
  const animationReads = [], geometryFinishes = []; let settingsWidth = 0;
  const motion = Object.assign(new Events(), { matches: reduceMotion });
  class Element extends Events {
    constructor(tag = "div") { super(); this.tag = tag; }
    value = ""; textContent = ""; children = []; disabled = false; open = false; attributes = new Map(); dataset = {};
    classes = new Set();
    classList = { add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)), contains: (name) => this.classes.has(name),
      toggle: (name, enabled = !this.classes.has(name)) => enabled ? this.classes.add(name) : this.classes.delete(name) };
    style = { values: new Map(), setProperty(name, value) { this.values.set(name, value); },
      removeProperty(name) { this.values.delete(name); }, getPropertyValue(name) { return this.values.get(name) ?? ""; } };
    _hidden = false;
    get hidden() { return this._hidden; }
    set hidden(value) { this._hidden = Boolean(value); }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
    replaceChildren(...children) { this.children = children; }
    contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getBoundingClientRect() {
      layoutReads.push({ target: this, settingsOpen: get("agent-page-shell").classes.has("settings-open"), panelHidden: get("agent-panel").hidden });
      return { width: 1200, height: 720 };
    }
    getAnimations() {
      animationReads.push(this);
      return this === get("agent-page-shell") && panelMotion ? [{ finish() {
        settingsWidth = get("agent-page-shell").classes.has("settings-open") ? 400 : 0;
        geometryFinishes.push(settingsWidth);
      } }] : [];
    }
    animate(keyframes, options) {
      const animation = { target: this, keyframes, options, cancelled: false,
        cancel() { this.cancelled = true; } };
      animations.push(animation);
      return animation;
    }
    focus() { document.activeElement = this; }
    modalOpens = 0;
    showModal() {
      assert.equal(this.tag, "dialog", "设置侧栏不能使用模态弹窗");
      assert.equal([...nodes.values()].some((node) => node !== this && node.tag === "dialog" && node.open), false, "不能嵌套模态弹窗");
      this.open = true; this.modalOpens++;
    }
    close() { this.open = false; return this.dispatchEvent({ type: "close" }); }
    async cancel() {
      const event = { type: "cancel", defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      await this.dispatchEvent(event);
      if (!event.defaultPrevented) await this.close();
    }
    click() { if (this.disabled) return; if (this.tag === "a") downloads.push({ href: this.href, download: this.download, parent: this.parent }); return this.dispatchEvent({ type: "click" }); }
  }
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  document.getElementById = get;
  document.createElement = (tag) => new Element(tag);
  document.querySelector = (selector) => selector === "dialog[open]" ? [...nodes.values()].find((node) => node.tag === "dialog" && node.open) ?? null : null;
  get("agent-panel").tag = "aside"; get("agent-panel").hidden = true;
  get("agent-panel-toggle").setAttribute("aria-expanded", "false");
  get("agent-file-dialog").tag = "dialog";
  get("agent-file-dialog").append(get("agent-files-refresh"), get("agent-file-list"), get("agent-file-content"), get("agent-file-close"));
  class Event {
    constructor(type, fields = {}) { this.type = type; this.defaultPrevented = false; Object.assign(this, fields); }
    preventDefault() { this.defaultPrevented = true; }
  }
  const dispatch = document.dispatchEvent.bind(document);
  document.dispatchEvent = (event) => { emitted.push({ type: event.type, detail: event.detail }); return dispatch(event); };
  const emit = (type, detail) => document.dispatchEvent(new Event(type, { detail }));
  let routeId = null;
  const runtimes = new Map(Object.keys(agents).map((id) => [id, runtimeFor(id, initialRuntime[id]) ]));
  // The main Agent module broadcasts first; this module requests the current route again after registering it.
  document.addEventListener("neuma:route", (event) => {
    routeId = event.detail.page === "agent" ? event.detail.agentId : null;
    if (routeId) return emit("neuma:agent-runtime-change", runtimes.get(routeId));
  });
  document.addEventListener("neuma:agent-runtime-request", (event) => {
    const id = event.detail?.agentId ?? routeId;
    if (id) return emit("neuma:agent-runtime-change", runtimes.get(id));
  });
  document.addEventListener("neuma:agent-profile-changed", (event) => {
    const { id, profile } = event.detail;
    if (!runtimes.has(id)) return;
    const previous = runtimes.get(id), detail = { ...previous, agent: { ...previous.agent, profile } };
    runtimes.set(id, detail);
    return emit("neuma:agent-runtime-change", detail);
  });
  const call = (method, args, callback, fallback) => {
    requests.push({ method, args });
    return Promise.resolve(callback?.(...args) ?? fallback);
  };
  const context = vm.createContext({ ...view, ...avatar, agentDisplayName, agentDisplayDescription, document, Event, CustomEvent: Event, Blob,
    renderAgentAvatar: (target, agent, options) => avatar.renderAgentAvatar(target, agent, { ...options, document, motion: false }),
    window: { matchMedia: () => motion, localStorage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
      ...(panelMotion ? { getComputedStyle: () => ({ transitionDuration: motion.matches ? "0s" : "0.42s" }) } : {}) },
    staticArtifactDocument: (content) => `safe-preview:${content}`,
    URL: { createObjectURL: (blob) => { urls.push(blob); return `blob:${urls.length}`; }, revokeObjectURL: (url) => urls.push(url) },
    setTimeout: (callback, duration) => { timerDurations.push(duration); return timers.push(callback); },
    clearTimeout: (id) => clearedTimers.add(id),
    createAgentRuntime: () => ({
      listFiles: (id) => call("listFiles", [id], files, { files: [] }),
      readFile: (id, path) => call("readFile", [id, path], file, { path, content: `${id}的文件内容`, truncated: false }),
      getMemory: (id) => call("getMemory", [id], memory, { memory: `${id}的记忆` }),
      saveMemory: (id, value) => call("saveMemory", [id, value], saveMemory, { memory: value }),
      saveProfile: (id, value) => call("saveProfile", [id, value], saveProfile, { profile: value }),
    }),
  });
  vm.runInContext(source, context);
  const route = (id) => emit("neuma:route", id ? { page: "agent", agentId: id } : { page: "chat", agentId: null });
  await route(initial); await settle();
  return { get, emit, route, requests, emitted, downloads, urls, timers, clearedTimers, timerDurations, layoutReads, animationReads, geometryFinishes, document, stored, animations, motion,
    settingsWidth: () => settingsWidth, setSettingsWidth: (width) => { settingsWidth = width; },
    click: async (id) => { await get(id).click(); await settle(); },
    key: async (key, fields = {}) => { const event = new Event("keydown", { key, ...fields }); await document.dispatchEvent(event); await settle(); return event; },
    endPanelMotion: async (fields = {}) => { await get("agent-page-shell").dispatchEvent(new Event("transitionend", { propertyName: "grid-template-columns", ...fields })); await settle(); },
    input: (id, value) => { get(id).value = value; return get(id).dispatchEvent(new Event("input")); },
    submit: (id) => get(id).dispatchEvent({ type: "submit", preventDefault() {} }),
    broadcast: async (id, overrides = {}) => { const detail = runtimeFor(id, overrides); runtimes.set(id, detail); await emit("neuma:agent-runtime-change", detail); await settle(); },
    item: (id = "one") => vm.runInContext(`states.get(${JSON.stringify(id)})`, context),
    openMemory: async () => { await get("agent-panel-toggle").click(); await get("agent-details-memory-tab").click(); await settle(); },
    openArtifacts: async () => { await get("agent-artifacts-open").click(); await settle(); },
  };
}

test("历史产物排序不改原列表，文件描述与预览限制保持明确", () => {
  const files = [{ path: "old.txt", size: 20, updatedAt: "2026-10-02T10:00:00Z" },
    { path: "new.html", size: 2048, updatedAt: "2026-10-04T10:00:00Z" }];
  assert.deepEqual(view.newestFiles(files).map((file) => file.path), ["new.html", "old.txt"]);
  assert.equal(files[0].path, "old.txt");
  assert.match(view.fileDescription(files[1]), /网页.*2\.0 KB/);
  assert.equal(view.agentIconChoices.length > 0, true);
});

test("研发快捷入口沿用当前Agent归属，待连接交付可以重新检查且研发中隐藏重复入口", async () => {
  const ui = await setup({ initialRuntime: { one: { ready: false, status: "needs_development", developmentAction: "开始研发" } } });
  assert.equal(ui.get("agent-build-shortcut").hidden, false);
  assert.equal(ui.get("agent-build-shortcut").textContent, "开始研发");
  await ui.click("agent-build-shortcut");
  assert.equal(ui.emitted.findLast((event) => event.type === "neuma:agent-develop").detail.id, "one");
  await ui.broadcast("one", { ready: false, status: "needs_connection", developmentAction: "重新检查交付" });
  assert.equal(ui.get("agent-build-shortcut").textContent, "重新检查交付");
  await ui.broadcast("one", { ready: false, busy: true, status: "developing", developmentAction: null });
  assert.equal(ui.get("agent-build-shortcut").hidden, true);
});

test("初次路由主动握手并自动读取成果，胶囊展开非模态设置侧栏", async () => {
  const ui = await setup();
  assert.equal(ui.get("agent-panel").hidden, true);
  assert.ok(ui.emitted.some((event) => event.type === "neuma:agent-runtime-request" && event.detail.agentId === "one"));
  await ui.click("agent-panel-toggle");
  assert.equal(ui.get("agent-panel").hidden, false);
  assert.equal(ui.get("agent-page-shell").classes.has("settings-open"), true);
  assert.equal(ui.get("agent-panel-toggle").attributes.get("aria-expanded"), "true");
  assert.equal(ui.get("agent-panel").modalOpens, 0);
  assert.equal(ui.document.activeElement, ui.get("agent-details-close"));
  assert.equal(ui.get("agent-panel").dataset.view, "profile");
  assert.equal(ui.get("agent-profile-name").value, "会议助手");
  assert.equal(ui.get("agent-details-title").textContent, "智能体设置");
  await ui.click("agent-details-close");
  assert.equal(ui.get("agent-panel-toggle").attributes.get("aria-expanded"), "false");
  assert.equal(ui.document.activeElement, ui.get("agent-panel-toggle"));
  assert.equal(ui.requests.some((request) => request.method === "listFiles" && request.args[0] === "one"), true);
  await ui.openMemory();
  assert.equal(ui.get("agent-panel").dataset.view, "memory");
  assert.equal(ui.get("agent-details-title").textContent, "智能体设置");
  assert.equal(ui.get("agent-memory-input").value, "one的记忆");
});

test("胶囊反复开合只更新展示，聊天仍可聚焦且保留双方草稿与设置归属事件", async () => {
  const ui = await setup(), requests = ui.requests.length;
  ui.get("agent-message").value = "尚未发送的任务";
  await ui.click("agent-panel-toggle");
  await ui.input("agent-profile-name", "尚未保存的名字");
  ui.get("agent-message").focus();
  await ui.broadcast("one", { busy: true, ready: false });
  assert.equal(ui.document.activeElement, ui.get("agent-message"));
  assert.equal(ui.get("agent-panel").hidden, false);
  assert.equal(ui.get("agent-message").disabled, false);
  await ui.click("agent-panel-toggle");
  assert.equal(ui.get("agent-panel").hidden, true);
  assert.equal(ui.get("agent-page-shell").classes.has("settings-open"), false);
  assert.equal(ui.get("agent-panel-toggle").attributes.get("aria-expanded"), "false");
  await ui.click("agent-panel-toggle");
  assert.equal(ui.get("agent-profile-name").value, "尚未保存的名字");
  assert.equal(ui.get("agent-message").value, "尚未发送的任务");
  assert.equal(ui.requests.length, requests);
  assert.deepEqual(ui.emitted.filter((event) => event.type === "neuma:agent-settings-view")
    .map(({ detail }) => [detail.agentId, detail.active]), [["one", true], ["one", false], ["one", true]]);
});

test("侧栏横移先提交关闭位置，关闭立即停用控件，结束后隐藏且不再抢焦点", async () => {
  const ui = await setup({ panelMotion: true });
  const previousReads = ui.layoutReads.length;
  await ui.click("agent-panel-toggle");
  const panel = ui.get("agent-panel"), shell = ui.get("agent-page-shell");
  assert.equal(ui.layoutReads.length, previousReads + 1);
  assert.equal(ui.layoutReads.at(-1).target, shell);
  assert.equal(ui.layoutReads.at(-1).settingsOpen, false);
  assert.equal(ui.layoutReads.at(-1).panelHidden, false);
  assert.equal(shell.classes.has("is-settings-animating"), true);
  assert.equal(panel.inert, false); assert.equal(panel.attributes.get("aria-hidden"), "false");
  await ui.endPanelMotion({ target: ui.get("agent-details-profile") });
  await ui.endPanelMotion({ propertyName: "transform" });
  assert.equal(shell.classes.has("is-settings-animating"), true);
  await ui.endPanelMotion();
  assert.equal(shell.classes.has("is-settings-animating"), false);
  assert.equal(panel.hidden, false);
  await ui.click("agent-details-close");
  assert.equal(panel.hidden, false, "关闭过渡期间保留侧栏供 CSS 横移");
  assert.equal(panel.inert, true); assert.equal(panel.attributes.get("aria-hidden"), "true");
  assert.equal(shell.classes.has("settings-open"), false);
  assert.equal(shell.classes.has("is-settings-animating"), true);
  assert.equal(ui.get("agent-panel-toggle").attributes.get("aria-expanded"), "false");
  assert.equal(ui.document.activeElement, ui.get("agent-panel-toggle"));
  const events = ui.emitted.filter((event) => event.type === "neuma:agent-settings-view").length;
  ui.get("agent-message").focus(); await ui.endPanelMotion();
  assert.equal(panel.hidden, true);
  assert.equal(shell.classes.has("is-settings-animating"), false);
  assert.equal(ui.document.activeElement, ui.get("agent-message"));
  assert.equal(ui.emitted.filter((event) => event.type === "neuma:agent-settings-view").length, events);
});

test("快速反向开合保留当前横移，取消旧回调，迟到结束不能隐藏重新展开的侧栏", async () => {
  const ui = await setup({ panelMotion: true });
  const previousReads = ui.layoutReads.length;
  await ui.click("agent-panel-toggle");
  const shell = ui.get("agent-page-shell"), firstEnd = shell.listeners.get("transitionend")[0], firstTimer = ui.timers[0];
  await ui.input("agent-profile-name", "横移期间的名称草稿");
  await ui.click("agent-panel-toggle");
  const closingEnd = shell.listeners.get("transitionend")[0], closingTimer = ui.timers[1];
  assert.equal((await ui.key("Escape")).defaultPrevented, false, "已经逻辑关闭时 Esc 不应重复关闭");
  await ui.click("agent-panel-toggle");
  assert.equal(ui.layoutReads.length, previousReads + 1, "反向展开不能重新提交零位而跳回起点");
  assert.equal(ui.clearedTimers.has(1), true); assert.equal(ui.clearedTimers.has(2), true);
  assert.equal(shell.listeners.get("transitionend").length, 1);
  firstTimer(); closingTimer();
  firstEnd({ target: shell, propertyName: "grid-template-columns" });
  closingEnd({ target: shell, propertyName: "grid-template-columns" });
  assert.equal(shell.classes.has("settings-open"), true);
  assert.equal(shell.classes.has("is-settings-animating"), true);
  assert.equal(ui.get("agent-panel").hidden, false); assert.equal(ui.get("agent-panel").inert, false);
  assert.equal(ui.get("agent-profile-name").value, "横移期间的名称草稿");
  assert.equal(ui.get("agent-panel-toggle").attributes.get("aria-expanded"), "true");
  await ui.endPanelMotion();
  assert.equal(shell.classes.has("is-settings-animating"), false);
  assert.deepEqual(ui.emitted.filter((event) => event.type === "neuma:agent-settings-view")
    .map(({ detail }) => [detail.agentId, detail.active]), [["one", true], ["one", false], ["one", true]]);
});

test("没有收到横移结束事件时兜底隐藏，计时完成不重复发布关闭或恢复旧焦点", async () => {
  const ui = await setup({ panelMotion: true });
  await ui.click("agent-panel-toggle"); await ui.endPanelMotion();
  await ui.click("agent-details-close");
  const count = ui.emitted.filter((event) => event.type === "neuma:agent-settings-view").length;
  assert.equal(ui.timerDurations.at(-1), 470);
  ui.get("agent-message").focus(); ui.timers.at(-1)();
  assert.equal(ui.get("agent-panel").hidden, true);
  assert.equal(ui.get("agent-page-shell").classes.has("is-settings-animating"), false);
  assert.equal(ui.document.activeElement, ui.get("agent-message"));
  assert.equal(ui.emitted.filter((event) => event.type === "neuma:agent-settings-view").length, count);
});

test("关闭横移途中打开产物先重新启用侧栏，旧计时不能破坏文件库关闭后的焦点", async () => {
  const ui = await setup({ panelMotion: true });
  await ui.click("agent-panel-toggle"); await ui.endPanelMotion();
  await ui.click("agent-details-close");
  const closingTimer = ui.timers.at(-1);
  await ui.openArtifacts();
  closingTimer();
  assert.equal(ui.get("agent-panel").hidden, false); assert.equal(ui.get("agent-panel").inert, false);
  assert.equal(ui.get("agent-panel").attributes.get("aria-hidden"), "false");
  assert.equal(ui.get("agent-file-dialog").open, true);
  assert.equal((await ui.key("Escape")).defaultPrevented, false);
  await ui.get("agent-file-dialog").cancel();
  assert.equal(ui.document.activeElement, ui.get("agent-artifacts-open"));
  await ui.endPanelMotion();
  assert.equal(ui.document.activeElement, ui.get("agent-artifacts-open"));
  assert.equal(ui.get("agent-panel").hidden, false);
});

test("关闭横移期间切 Agent 或离页立即清理，旧回调不影响新侧栏或新页面焦点", async () => {
  const ui = await setup({ panelMotion: true });
  await ui.click("agent-panel-toggle"); await ui.endPanelMotion();
  await ui.click("agent-details-close");
  const oldTimer = ui.timers.at(-1), oldEnd = ui.get("agent-page-shell").listeners.get("transitionend")[0];
  const previousFinishes = ui.geometryFinishes.length;
  ui.setSettingsWidth(170);
  ui.get("agent-message").focus(); await ui.route("two");
  assert.equal(ui.get("agent-panel").hidden, true);
  assert.equal(ui.get("agent-page-shell").classes.has("is-settings-animating"), false);
  assert.equal(ui.document.activeElement, ui.get("agent-message"));
  assert.equal(ui.geometryFinishes.length, previousFinishes + 1);
  assert.equal(ui.settingsWidth(), 0, "路由切换必须立即恢复完整聊天宽度");
  assert.equal(ui.animationReads.every((target) => target === ui.get("agent-page-shell")), true);
  await ui.click("agent-panel-toggle");
  oldTimer(); oldEnd({ target: ui.get("agent-page-shell"), propertyName: "grid-template-columns" });
  assert.equal(ui.get("agent-panel").hidden, false);
  assert.equal(ui.get("agent-details-name").textContent, "周报助手");
  assert.equal(ui.get("agent-page-shell").classes.has("is-settings-animating"), true);
  const newTimer = ui.timers.at(-1);
  ui.get("agent-message").focus(); await ui.route(null); newTimer();
  assert.equal(ui.get("agent-panel").hidden, true);
  assert.equal(ui.document.activeElement, ui.get("agent-message"));
});

test("展开横移途中删除 Agent 立即隐藏和停用，迟到计时不能恢复已删除设置", async () => {
  const ui = await setup({ panelMotion: true });
  await ui.click("agent-panel-toggle");
  const timer = ui.timers.at(-1);
  const previousFinishes = ui.geometryFinishes.length;
  ui.setSettingsWidth(230);
  ui.get("agent-message").focus(); await ui.emit("neuma:agent-removed", { id: "one" }); timer();
  assert.equal(ui.get("agent-panel").hidden, true); assert.equal(ui.get("agent-panel").inert, true);
  assert.equal(ui.get("agent-panel-toggle").attributes.get("aria-expanded"), "false");
  assert.equal(ui.get("agent-page-shell").classes.has("is-settings-animating"), false);
  assert.equal(ui.document.activeElement, ui.get("agent-message"));
  assert.equal(ui.geometryFinishes.length, previousFinishes + 1);
  assert.equal(ui.settingsWidth(), 0, "删除时不能残留关闭中的轨道");
  await ui.click("agent-panel-toggle");
  assert.equal(ui.get("agent-panel").hidden, true);
  assert.equal(ui.item(), undefined);
});

test("减少动效立即达到逻辑目标，中途改变偏好取消横移且不丢失焦点或草稿", async () => {
  const reduced = await setup({ panelMotion: true, reduceMotion: true });
  await reduced.click("agent-panel-toggle"); await reduced.click("agent-details-close");
  assert.equal(reduced.get("agent-panel").hidden, true); assert.equal(reduced.timers.length, 0);
  const ui = await setup({ panelMotion: true });
  await ui.click("agent-panel-toggle");
  const opening = ui.timers.at(-1);
  await ui.input("agent-profile-name", "保留设置草稿");
  ui.setSettingsWidth(180);
  ui.motion.matches = true; await ui.motion.dispatchEvent({ type: "change" }); opening();
  assert.equal(ui.get("agent-panel").hidden, false);
  assert.equal(ui.get("agent-page-shell").classes.has("is-settings-animating"), false);
  assert.equal(ui.get("agent-profile-name").value, "保留设置草稿");
  assert.equal(ui.settingsWidth(), 400, "开启减少动效时立即到达展开位置");
  ui.motion.matches = false; await ui.click("agent-details-close");
  const closing = ui.timers.at(-1);
  ui.setSettingsWidth(240);
  ui.get("agent-message").focus(); ui.motion.matches = true;
  await ui.motion.dispatchEvent({ type: "change" }); closing();
  assert.equal(ui.get("agent-panel").hidden, true);
  assert.equal(ui.get("agent-page-shell").classes.has("is-settings-animating"), false);
  assert.equal(ui.document.activeElement, ui.get("agent-message"));
  assert.equal(ui.settingsWidth(), 0, "关闭途中减少动效应立即释放设置轨道");
});

test("侧栏身份使用已保存资料，编辑预览与后台资料变化不会覆盖当前草稿", async () => {
  const profile = { name: "我的会议伙伴", description: "整理会议与后续行动", icon: "📝" };
  const ui = await setup({ initialRuntime: { one: { agent: { ...agents.one, profile } } } });
  await ui.click("agent-panel-toggle");
  assert.equal(ui.get("agent-details-name").textContent, profile.name);
  assert.equal(ui.get("agent-details-description").textContent, profile.description);
  assert.equal(ui.get("agent-details-description").hidden, false);
  assert.equal(ui.get("agent-details-avatar").textContent, "📝");
  await ui.input("agent-profile-name", "未保存的名字");
  await ui.input("agent-profile-custom-icon", "🌟");
  assert.equal(ui.get("agent-details-name").textContent, profile.name);
  assert.equal(ui.get("agent-details-avatar").textContent, "📝");
  await ui.broadcast("one", { agent: { ...agents.one, profile: { name: "保存后的名字", description: "", icon: "📚" } } });
  assert.equal(ui.get("agent-details-name").textContent, "保存后的名字");
  assert.equal(ui.get("agent-details-description").hidden, true);
  assert.equal(ui.get("agent-details-avatar").textContent, "📚");
  assert.equal(ui.get("agent-profile-name").value, "未保存的名字");
  assert.equal(ui.get("agent-avatar-preview").textContent, "🌟");
});

test("应用配置入口选择连接标签且不重复广播展开，切 Agent 和离页关闭时不抢焦点", async () => {
  const ui = await setup();
  await ui.emit("neuma:agent-connections-open");
  assert.equal(ui.get("agent-panel").hidden, false);
  assert.equal(ui.get("agent-panel").dataset.view, "connections");
  assert.equal(ui.get("agent-details-connections-tab").attributes.get("aria-pressed"), "true");
  await ui.emit("neuma:agent-connections-open");
  assert.equal(ui.emitted.filter((event) => event.type === "neuma:agent-settings-view" && event.detail.active).length, 1);
  ui.get("agent-message").focus(); await ui.route("two");
  assert.equal(ui.get("agent-panel").hidden, true);
  assert.equal(ui.document.activeElement, ui.get("agent-message"));
  assert.deepEqual(ui.emitted.filter((event) => event.type === "neuma:agent-settings-view")
    .map(({ detail }) => [detail.agentId, detail.active]), [["one", true], ["one", false]]);
  await ui.click("agent-panel-toggle");
  assert.equal(ui.get("agent-details-name").textContent, "周报助手");
  ui.get("agent-message").focus(); await ui.route(null);
  assert.equal(ui.get("agent-panel").hidden, true);
  assert.equal(ui.document.activeElement, ui.get("agent-message"));
  assert.equal(ui.emitted.filter((event) => event.type === "neuma:agent-settings-view").at(-1).detail.agentId, "two");
});

test("Esc 优先关闭模态文件库或材料库，已处理按键不折叠设置，之后再关闭侧栏", async () => {
  const ui = await setup(); await ui.openArtifacts();
  const filesEscape = await ui.key("Escape");
  assert.equal(filesEscape.defaultPrevented, false);
  assert.equal(ui.get("agent-panel").hidden, false);
  await ui.get("agent-file-dialog").cancel();
  assert.equal(ui.document.activeElement, ui.get("agent-artifacts-open"));
  const materials = ui.get("agent-material-dialog"); materials.tag = "dialog"; materials.showModal();
  assert.equal((await ui.key("Escape")).defaultPrevented, false);
  assert.equal(ui.get("agent-panel").hidden, false);
  await materials.cancel();
  await ui.key("Escape", { defaultPrevented: true });
  assert.equal(ui.get("agent-panel").hidden, false);
  assert.equal((await ui.key("Escape")).defaultPrevented, true);
  assert.equal(ui.get("agent-panel").hidden, true);
  assert.equal(ui.document.activeElement, ui.get("agent-panel-toggle"));
});

test("资料草稿跨标签保留，切 Agent 后使用各自草稿并忽略后台运行状态", async () => {
  const ui = await setup();
  await ui.click("agent-panel-toggle");
  await ui.input("agent-profile-name", "会议名称草稿");
  await ui.input("agent-profile-description", "会议简介草稿");
  await ui.click("agent-details-memory-tab"); await ui.click("agent-details-profile-tab");
  assert.equal(ui.get("agent-profile-name").value, "会议名称草稿");
  await ui.route("two");
  assert.equal(ui.get("agent-panel").hidden, true);
  await ui.click("agent-panel-toggle"); await ui.input("agent-profile-name", "周报名称草稿");
  await ui.broadcast("one", { busy: true, ready: false });
  assert.equal(ui.get("agent-profile-name").value, "周报名称草稿");
  await ui.route("one"); await ui.click("agent-panel-toggle");
  assert.equal(ui.get("agent-profile-name").value, "会议名称草稿");
  assert.equal(ui.get("agent-profile-description").value, "会议简介草稿");
});

test("头像编辑器具有独立预览与有标签的选择组，内部组合值不出现在可见输入", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="agent-profile-icon" type="hidden"/);
  assert.match(html, /id="agent-avatar-preview" class="agent-avatar-preview" role="img" aria-label="头像预览"/);
  assert.match(html, /id="agent-avatar-shapes"[^>]*role="group" aria-labelledby="agent-avatar-shapes-label"/);
  assert.match(html, /id="agent-avatar-colors"[^>]*role="group" aria-labelledby="agent-avatar-colors-label"/);
  assert.match(html, /<details class="agent-avatar-custom">.*id="agent-profile-custom-icon" type="text"/);
  const ui = await setup(); await ui.click("agent-panel-toggle");
  const shapes = ui.get("agent-avatar-shapes").children, colors = ui.get("agent-avatar-colors").children;
  assert.equal(shapes.length, 6); assert.equal(colors.length, 8);
  assert.equal(shapes.every((button) => button.attributes.has("aria-label") && button.attributes.has("aria-pressed")), true);
  assert.equal(colors.every((button) => button.attributes.has("aria-label") && button.attributes.has("aria-pressed")), true);
  assert.equal(shapes.every((button) => button.children[0].dataset.avatarKind === "star"), true);
  assert.equal(ui.get("agent-avatar-preview").dataset.avatarKind, "star");
  assert.equal(ui.get("agent-profile-custom-icon").value, "");
});

test("造型和配色各自保留另一维，固定组合沿原资料接口保存", async () => {
  const ui = await setup(); await ui.click("agent-panel-toggle");
  const automatic = avatar.resolveAgentAvatar(agents.one);
  const shape = ui.get("agent-avatar-shapes").children.find((button) => button.dataset.shape === "shield");
  await shape.click();
  assert.equal(ui.get("agent-profile-icon").value, avatar.avatarIcon({ shape: "shield", color: automatic.color }));
  const color = ui.get("agent-avatar-colors").children.find((button) => button.dataset.color === "coral");
  await color.click();
  const expected = avatar.avatarIcon({ shape: "shield", color: "coral" });
  assert.equal(ui.get("agent-avatar-preview").dataset.avatarIcon, expected);
  assert.equal(shape.attributes.get("aria-pressed"), "true");
  assert.equal(color.attributes.get("aria-pressed"), "true");
  assert.equal(ui.get("agent-avatar-shapes").children.every((button) =>
    button.children[0].dataset.avatarIcon === avatar.avatarIcon({ shape: button.dataset.shape, color: "coral" })), true);
  await ui.submit("agent-profile-form");
  const saved = ui.requests.findLast((request) => request.method === "saveProfile");
  assert.equal(saved.args[0], "one"); assert.equal(saved.args[1].icon, expected);
  assert.equal(ui.item().profileDirty, false);
  await ui.click("agent-details-close"); await ui.click("agent-panel-toggle");
  assert.equal(ui.get("agent-avatar-preview").dataset.avatarIcon, expected);
});

test("头像草稿跨智能体和设置标签隔离，保存中编辑保留新组合", async () => {
  const saved = deferred();
  const ui = await setup({ saveProfile: () => saved.promise }); await ui.click("agent-panel-toggle");
  await ui.get("agent-avatar-shapes").children.find((button) => button.dataset.shape === "diamond").click();
  await ui.get("agent-avatar-colors").children.find((button) => button.dataset.color === "purple").click();
  const submitted = avatar.avatarIcon({ shape: "diamond", color: "purple" });
  const pending = ui.submit("agent-profile-form");
  assert.equal(ui.get("agent-profile-save").disabled, true);
  assert.equal(ui.get("agent-avatar-colors").children.every((button) => !button.disabled), true);
  await ui.get("agent-avatar-colors").children.find((button) => button.dataset.color === "rose").click();
  const current = avatar.avatarIcon({ shape: "diamond", color: "rose" });
  await ui.click("agent-details-memory-tab"); await ui.click("agent-details-profile-tab");
  assert.equal(ui.get("agent-avatar-preview").dataset.avatarIcon, current);
  await ui.route("two"); await ui.click("agent-panel-toggle");
  await ui.get("agent-avatar-shapes").children.find((button) => button.dataset.shape === "trapezoid").click();
  await ui.get("agent-avatar-colors").children.find((button) => button.dataset.color === "orange").click();
  const other = avatar.avatarIcon({ shape: "trapezoid", color: "orange" });
  saved.resolve({ profile: { name: "会议助手", description: "整理会议", icon: submitted } }); await pending;
  assert.equal(ui.get("agent-avatar-preview").dataset.avatarIcon, other);
  await ui.route("one"); await ui.click("agent-panel-toggle");
  assert.equal(ui.get("agent-profile-icon").value, current);
  assert.equal(ui.get("agent-avatar-preview").dataset.avatarIcon, current);
  assert.equal(ui.item("one").profileDirty, true); assert.equal(ui.item("two").profileDirty, true);
});

test("已有文字和 Emoji 可保留或切换小星核，重置恢复 ID 固定默认组合", async () => {
  const profile = { name: "会议助手", description: "整理会议", icon: "📚" };
  const ui = await setup({ initialRuntime: { one: { agent: { ...agents.one, profile } } } });
  await ui.click("agent-panel-toggle");
  assert.equal(ui.get("agent-avatar-preview").dataset.avatarKind, "text");
  assert.equal(ui.get("agent-profile-custom-icon").value, "📚");
  assert.equal(ui.get("agent-avatar-shapes").children.every((button) => button.attributes.get("aria-pressed") === "false"), true);
  const automatic = avatar.resolveAgentAvatar(agents.one);
  await ui.get("agent-avatar-colors").children.find((button) => button.dataset.color === "blue").click();
  assert.equal(ui.get("agent-profile-icon").value, avatar.avatarIcon({ shape: automatic.shape, color: "blue" }));
  assert.equal(ui.get("agent-profile-custom-icon").value, "");
  await ui.input("agent-profile-custom-icon", "日报");
  assert.equal(ui.get("agent-profile-icon").value, "日报");
  assert.equal(ui.get("agent-avatar-preview").dataset.avatarKind, "text");
  await ui.click("agent-avatar-reset");
  assert.equal(ui.get("agent-profile-icon").value, "");
  assert.equal(ui.get("agent-avatar-preview").dataset.avatarIcon, automatic.icon);
  await ui.input("agent-profile-name", "新的展示名称");
  assert.equal(ui.get("agent-avatar-preview").dataset.avatarIcon, automatic.icon);
  await ui.submit("agent-profile-form");
  assert.equal(ui.requests.findLast((request) => request.method === "saveProfile").args[1].icon, "");
  await ui.get("agent-icon-options").children[0].click();
  assert.equal(ui.get("agent-profile-custom-icon").value, view.agentIconChoices[0][0]);
  assert.equal(ui.get("agent-avatar-preview").dataset.avatarKind, "text");
});

test("未生成智能体的头像控件沿原资料权限全部禁用", async () => {
  const ui = await setup({ initialRuntime: { one: { definition: null, ready: false, status: "missing" } } });
  await ui.click("agent-panel-toggle");
  for (const id of ["agent-profile-custom-icon", "agent-avatar-reset", "agent-profile-save"])
    assert.equal(ui.get(id).disabled, true);
  for (const id of ["agent-avatar-shapes", "agent-avatar-colors", "agent-icon-options"])
    assert.equal(ui.get(id).children.every((button) => button.disabled), true);
  await ui.get("agent-avatar-shapes").children[0].click();
  assert.equal(ui.item().profileDirty, false);
});

test("资料保存中继续编辑不丢新修改，失败保留草稿且能够重试", async () => {
  const saved = deferred(); let calls = 0;
  const ui = await setup({ saveProfile: (_id, value) => ++calls === 1 ? saved.promise
    : calls === 2 ? Promise.reject(new Error("保存暂时失败")) : { profile: value } });
  await ui.click("agent-panel-toggle"); await ui.input("agent-profile-name", "提交名称");
  const pending = ui.submit("agent-profile-form");
  assert.equal(ui.get("agent-profile-save").disabled, true);
  await ui.input("agent-profile-name", "保存期间的新名称");
  saved.resolve({ profile: { name: "提交名称", description: "整理会议", icon: "" } }); await pending;
  assert.equal(ui.get("agent-profile-name").value, "保存期间的新名称");
  assert.equal(ui.item().profileDirty, true);
  assert.equal(ui.emitted.filter((event) => event.type === "neuma:agent-profile-changed").at(-1).detail.profile.name, "提交名称");
  await ui.submit("agent-profile-form");
  assert.equal(ui.item().profileError, true);
  assert.equal(ui.get("agent-profile-name").value, "保存期间的新名称");
  await ui.submit("agent-profile-form");
  assert.equal(ui.item().profileDirty, false);
});

test("后台 Agent 的资料保存响应仍归属原 ID，不覆盖当前 Agent 的输入", async () => {
  const saved = deferred();
  const ui = await setup({ saveProfile: () => saved.promise });
  await ui.click("agent-panel-toggle"); await ui.input("agent-profile-name", "会议新名称");
  const pending = ui.submit("agent-profile-form");
  await ui.route("two"); await ui.click("agent-panel-toggle"); await ui.input("agent-profile-name", "周报未保存名称");
  saved.resolve({ profile: { name: "会议新名称", description: "整理会议", icon: "📝" } }); await pending;
  assert.equal(ui.get("agent-profile-name").value, "周报未保存名称");
  assert.equal(ui.emitted.filter((event) => event.type === "neuma:agent-profile-changed").at(-1).detail.id, "one");
  assert.equal(ui.item("one").profileDirty, false);
  assert.equal(ui.item("two").profileDirty, true);
});

test("记忆迟到读取不覆盖后一次读取后的编辑，切 Agent 隔离记忆草稿", async () => {
  const first = deferred(), second = deferred(); let reads = 0;
  const ui = await setup({ memory: (id) => id === "two" ? { memory: "周报记忆" } : ++reads === 1 ? first.promise : second.promise });
  await ui.openMemory();
  await ui.click("agent-details-profile-tab"); await ui.click("agent-details-memory-tab");
  second.resolve({ memory: "较新的会议记忆" }); await settle();
  await ui.input("agent-memory-input", "会议记忆草稿");
  first.resolve({ memory: "迟到旧记忆" }); await settle();
  assert.equal(ui.get("agent-memory-input").value, "会议记忆草稿");
  await ui.route("two"); await ui.openMemory(); await ui.input("agent-memory-input", "周报记忆草稿");
  await ui.route("one"); await ui.openMemory();
  assert.equal(ui.get("agent-memory-input").value, "会议记忆草稿");
});

test("记忆保存中编辑和后台响应不丢草稿，保存失败后仍能重试", async () => {
  const saved = deferred(); let saves = 0;
  const ui = await setup({ saveMemory: (_id, value) => ++saves === 1 ? saved.promise
    : saves === 2 ? Promise.reject(new Error("记忆保存失败")) : { memory: value } });
  await ui.openMemory(); await ui.input("agent-memory-input", "提交的记忆");
  const pending = ui.submit("agent-memory-form");
  await ui.input("agent-memory-input", "提交后的新草稿");
  await ui.route("two"); await ui.openMemory(); await ui.input("agent-memory-input", "周报独立记忆");
  saved.resolve({ memory: "提交的记忆" }); await pending;
  assert.equal(ui.get("agent-memory-input").value, "周报独立记忆");
  await ui.route("one"); await ui.openMemory();
  assert.equal(ui.get("agent-memory-input").value, "提交后的新草稿");
  await ui.submit("agent-memory-form");
  assert.equal(ui.item().memoryError, true);
  assert.equal(ui.get("agent-memory-input").value, "提交后的新草稿");
  await ui.submit("agent-memory-form");
  assert.equal(ui.item().memoryDirty, false);
});

test("文件与列表迟到响应不覆盖新选择或其他 Agent 的预览", async () => {
  const firstList = deferred(), firstFile = deferred(); let lists = 0, reads = 0;
  const ui = await setup({ files: (id) => id === "two" ? { files: [{ path: "two.md", size: 20 }] }
    : ++lists === 1 ? firstList.promise : { files: [{ path: "new.md", size: 20 }, { path: "second.md", size: 10 }] },
    file: (_id, path) => ++reads === 1 ? firstFile.promise : { path, content: "新的选择" } });
  await ui.openArtifacts(); await ui.click("agent-files-refresh");
  firstList.resolve({ files: [{ path: "old.md", size: 10 }] }); await settle();
  assert.equal(ui.get("agent-file-list").children[0].children[0].textContent, "new.md");
  await ui.get("agent-file-list").children[0].click(); await settle();
  await ui.get("agent-file-list").children[1].click(); await settle();
  firstFile.resolve({ path: "new.md", content: "迟到旧文件" }); await settle();
  assert.equal(ui.get("agent-file-name").textContent, "second.md");
  await ui.route("two"); await settle(); await ui.openArtifacts();
  assert.equal(ui.get("agent-file-name").textContent, "two.md");
});

test("选中文件消失时清空预览并拒绝迟到文件，截断内容不能下载", async () => {
  const pendingFile = deferred(); let available = true;
  const ui = await setup({ files: () => ({ files: available ? [{ path: "removed.txt", size: 20 }] : [] }), file: () => pendingFile.promise });
  await ui.openArtifacts();
  available = false; await ui.click("agent-files-refresh");
  pendingFile.resolve({ path: "removed.txt", content: "迟到被移除文件" }); await settle();
  assert.equal(ui.item().file, null);
  assert.equal(ui.get("agent-file-name").textContent, "选择一份产物");
  assert.equal(ui.get("agent-file-download").hidden, true);
  const truncated = await setup({ files: () => ({ files: [{ path: "large.html", size: 90_000 }] }),
    file: () => ({ path: "large.html", content: "部分内容", truncated: true }) });
  await truncated.openArtifacts();
  assert.equal(truncated.get("agent-file-content").children[0].tag, "pre");
  assert.equal(truncated.get("agent-file-download").hidden, true);
  await truncated.click("agent-file-download");
  assert.equal(truncated.downloads.length, 0);
});

test("完整网页使用隔离预览，下载文件后释放 URL", async () => {
  const ui = await setup({ files: () => ({ files: [{ path: "报告/page.html", size: 50 }] }),
    file: () => ({ path: "报告/page.html", content: "<p>成果</p>", truncated: false }) });
  await ui.openArtifacts();
  const frame = ui.get("agent-file-content").children[0];
  assert.equal(frame.tag, "iframe");
  assert.equal(frame.attributes.get("sandbox"), "");
  assert.equal(frame.attributes.get("referrerpolicy"), "no-referrer");
  await ui.click("agent-file-download");
  assert.equal(ui.downloads[0].download, "page.html");
  assert.equal(ui.downloads[0].parent, ui.get("agent-file-dialog"));
  ui.timers[0]();
  assert.equal(ui.urls.at(-1), "blob:1");
});

test("产物先展开设置侧栏再打开文件库，默认预览最新文件并保留各 Agent 的选择", async () => {
  const ui = await setup({ files: (id) => ({ files: id === "one" ? [
    { path: "旧产物.md", size: 20, updatedAt: "2026-10-08T10:00:00Z" },
    { path: "最新产物.md", size: 20, updatedAt: "2026-10-09T10:00:00Z" },
  ] : [{ path: "周报.md", size: 20 }] }) });
  assert.equal(ui.get("agent-file-dialog").open, false);
  assert.equal(ui.get("agent-artifacts-count").textContent, "2");
  assert.equal(ui.requests.some((request) => request.method === "readFile"), false);
  await ui.openArtifacts();
  assert.equal(ui.get("agent-panel").hidden, false);
  assert.equal(ui.get("agent-panel").modalOpens, 0);
  assert.equal(ui.get("agent-file-name").textContent, "最新产物.md");
  await ui.get("agent-file-list").children[1].click(); await settle();
  assert.equal(ui.get("agent-file-name").textContent, "旧产物.md");
  assert.equal(ui.get("agent-file-dialog").modalOpens, 1);
  await ui.click("agent-file-close"); await ui.openArtifacts();
  assert.equal(ui.get("agent-file-name").textContent, "旧产物.md");
  await ui.route("two"); await ui.openArtifacts();
  assert.equal(ui.get("agent-file-name").textContent, "周报.md");
  await ui.route("one"); await ui.openArtifacts();
  assert.equal(ui.get("agent-file-name").textContent, "旧产物.md");
  assert.equal(ui.stored.has("neuma-agent-artifacts-collapsed"), false);
});

test("打开时文件列表仍在读取，返回后在同一弹窗预览最新文件", async () => {
  const pending = deferred(), ui = await setup({ files: () => pending.promise });
  await ui.openArtifacts();
  assert.equal(ui.get("agent-file-dialog").open, true);
  assert.equal(ui.requests.some((request) => request.method === "readFile"), false);
  pending.resolve({ files: [
    { path: "旧.md", size: 20, updatedAt: "2026-10-08T10:00:00Z" },
    { path: "新.md", size: 20, updatedAt: "2026-10-09T10:00:00Z" },
  ] }); await settle();
  assert.equal(ui.get("agent-file-name").textContent, "新.md");
  assert.equal(ui.get("agent-file-dialog").modalOpens, 1);
});

test("空产物库可关闭，刷新失败保留旧列表和预览，文件读取失败可重试", async () => {
  const empty = await setup(); await empty.openArtifacts();
  assert.equal(empty.get("agent-file-list").children.length, 0);
  assert.match(empty.get("agent-files-feedback").textContent, /还没有保存的产物/);
  assert.equal(empty.get("agent-file-download").hidden, true);
  await empty.click("agent-file-close");
  assert.equal(empty.document.activeElement, empty.get("agent-artifacts-open"));

  let listFails = false, fileFails = false;
  const ui = await setup({ files: () => listFails ? Promise.reject(new Error("目录暂时不可读")) : { files: [{ path: "成果.md", size: 20 }] },
    file: (_id, path) => fileFails ? Promise.reject(new Error("文件暂时不可读")) : { path, content: "已生成的成果" } });
  await ui.openArtifacts();
  const selected = ui.get("agent-file-list").children[0]; selected.focus();
  listFails = true; await ui.click("agent-files-refresh");
  assert.equal(ui.get("agent-file-list").children.length, 1);
  assert.match(ui.get("agent-files-feedback").textContent, /目录暂时不可读.*仍显示上次读取的列表/);
  assert.equal(ui.get("agent-file-content").children[0].textContent, "已生成的成果");
  assert.equal(ui.document.activeElement.dataset.path, "成果.md");
  fileFails = true; await ui.get("agent-file-list").children[0].click(); await settle();
  assert.match(ui.get("agent-file-info").textContent, /文件暂时不可读/);
  assert.equal(ui.get("agent-file-download").hidden, true);
  fileFails = false; await ui.get("agent-file-list").children[0].click(); await settle();
  assert.equal(ui.get("agent-file-content").children[0].textContent, "已生成的成果");
});

test("产物列表位于独立文件库弹窗，历史对话栏不再承载文件", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const start = html.indexOf('<dialog id="agent-file-dialog"');
  const library = html.slice(start, html.indexOf("</dialog>", start));
  assert.match(library, /aria-labelledby="agent-artifacts-title"/);
  for (const id of ["agent-file-list", "agent-files-refresh", "agent-file-content", "agent-file-download"])
    assert.ok(library.includes(`id="${id}"`));
  assert.match(html, /id="agent-history-sidebar"/);
  assert.match(html, /id="agent-artifacts-open"[^>]*aria-controls="agent-file-dialog"/);
  assert.doesNotMatch(html, /id="agent-artifacts-sidebar"|id="agent-save-chat"/);
});

test("胶囊、历史加号和侧栏产物入口唯一且保留 ARIA 关联与对话恢复顺序", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const tags = [...html.matchAll(/<([a-z][\w-]*)\b[^>]*>/g)];
  const attribute = (tag, name) => [...tag[0].matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/g)].find((match) => match[1] === name)?.[3];
  const element = (id) => {
    const matches = tags.filter((tag) => attribute(tag, "id") === id);
    assert.equal(matches.length, 1, `${id} 必须唯一`); return matches[0];
  };
  const header = html.slice(element("page-agent").index).match(/<header\b[^>]*>[\s\S]*?<\/header>/)?.[0];
  assert.ok(header);
  const capsule = element("agent-panel-toggle"), panel = element("agent-panel"), artifacts = element("agent-artifacts-open");
  assert.equal(capsule[1], "button"); assert.ok(header.includes(capsule[0]));
  assert.equal(attribute(capsule, "type"), "button"); assert.equal(attribute(capsule, "aria-controls"), "agent-panel");
  assert.equal(attribute(capsule, "aria-expanded"), "false"); assert.equal(attribute(capsule, "aria-haspopup"), undefined);
  const identity = html.slice(capsule.index, html.indexOf("</button>", capsule.index));
  assert.ok(identity.includes(element("agent-icon")[0])); assert.ok(identity.includes(element("agent-title")[0]));
  assert.equal(panel[1], "aside"); assert.match(panel[0], /\bhidden\b/);
  assert.equal(attribute(panel, "aria-labelledby"), "agent-details-title");
  const settings = html.slice(panel.index, html.indexOf("</aside>", panel.index));
  for (const id of ["agent-details-name", "agent-details-avatar", "agent-details-description", "agent-artifacts-open", "agent-artifacts-count"])
    assert.ok(settings.includes(element(id)[0]));
  assert.equal(artifacts[1], "button"); assert.equal(attribute(artifacts, "type"), "button");
  assert.equal(attribute(artifacts, "aria-haspopup"), "dialog"); assert.equal(attribute(artifacts, "aria-controls"), "agent-file-dialog");
  assert.equal(element("agent-file-dialog")[1], "dialog"); assert.equal(header.includes(artifacts[0]), false);
  assert.doesNotMatch(html, /id="agent-identity-edit"/);
  const start = element("agent-conversation").index;
  const conversation = html.slice(start, html.indexOf("</section>", start));
  const newChat = element("agent-new-chat"), error = element("agent-error"), recovery = element("agent-save-actions");
  assert.equal(newChat[1], "button"); assert.equal(attribute(newChat, "type"), "button");
  assert.ok(attribute(newChat, "aria-label"));
  const history = element("agent-history-sidebar");
  assert.ok(html.slice(history.index, html.indexOf("</aside>", history.index)).includes(newChat[0]));
  for (const control of [error, recovery, element("agent-chat-form")]) assert.ok(conversation.includes(control[0]));
  assert.ok(newChat.index < element("agent-messages").index);
  assert.equal(conversation.includes(element("agent-artifacts-open")[0]), false);
  assert.match(element("agent-conversation-title")[0], /\bhidden\b/);
  assert.equal(attribute(error, "role"), "alert"); assert.equal(attribute(recovery, "role"), "group");
  assert.ok(attribute(recovery, "aria-label"));
  assert.ok(error.index < recovery.index); assert.ok(recovery.index < element("agent-chat-form").index);
});

test("进入已生成 Agent 自动读取文件，首次生成和任务结束刷新，资料变化不重复读取", async () => {
  const ui = await setup({ initialRuntime: { one: { definition: null, ready: false, status: "missing" } },
    files: (id) => ({ files: [{ path: `${id}.md`, size: 20 }] }) });
  assert.equal(ui.requests.filter((request) => request.method === "listFiles").length, 0);
  await ui.broadcast("one");
  assert.equal(ui.get("agent-artifacts-count").textContent, "1");
  assert.equal(ui.requests.filter((request) => request.method === "listFiles").length, 1);
  await ui.broadcast("one", { agent: { ...agents.one, profile: { name: "新的名字", description: "", icon: "" } } });
  assert.equal(ui.requests.filter((request) => request.method === "listFiles").length, 1);
  await ui.broadcast("one", { busy: true, ready: false }); await ui.broadcast("one");
  assert.equal(ui.requests.filter((request) => request.method === "listFiles").length, 2);
  await ui.route("two"); await settle();
  assert.equal(ui.requests.filter((request) => request.method === "listFiles").at(-1).args[0], "two");
  assert.equal(ui.get("agent-file-list").children[0].dataset.path, "two.md");
  assert.equal(ui.get("agent-panel").hidden, true);
});

test("产物关闭和原生 Esc 取消均返回可见侧栏按钮，文件库与非模态设置并存", async () => {
  const ui = await setup({ files: () => ({ files: [{ path: "成果.md", size: 20 }] }) });
  await ui.click("agent-panel-toggle"); await ui.openArtifacts();
  assert.equal(ui.get("agent-file-dialog").open, true);
  assert.equal(ui.get("agent-panel").hidden, false);
  assert.equal(ui.get("agent-page-shell").classes.has("settings-open"), true);
  await ui.click("agent-file-close");
  assert.equal(ui.document.activeElement, ui.get("agent-artifacts-open"));
  await ui.openArtifacts(); await ui.get("agent-file-dialog").cancel();
  assert.equal(ui.get("agent-file-dialog").open, false);
  assert.equal(ui.document.activeElement, ui.get("agent-artifacts-open"));
  await ui.openArtifacts(); await ui.click("agent-panel-toggle");
  assert.equal(ui.get("agent-file-dialog").open, false);
  assert.equal(ui.get("agent-panel").hidden, true);
  assert.equal(ui.document.activeElement, ui.get("agent-panel-toggle"));
});

test("切 Agent 关闭独立预览不抢新页面焦点，迟到读取不覆盖新 Agent 文件", async () => {
  const firstFile = deferred();
  const ui = await setup({ files: (id) => ({ files: [{ path: `${id}.md`, size: 20 }] }),
    file: (id, path) => id === "one" ? firstFile.promise : { path, content: "周报内容" } });
  await ui.openArtifacts();
  const composer = ui.get("agent-message"); composer.focus();
  await ui.route("two"); await settle();
  assert.equal(ui.get("agent-file-dialog").open, false);
  assert.equal(ui.document.activeElement, composer);
  await ui.openArtifacts();
  firstFile.resolve({ path: "one.md", content: "迟到会议内容" }); await settle();
  assert.equal(ui.get("agent-file-name").textContent, "two.md");
  assert.equal(ui.get("agent-file-content").children[0].textContent, "周报内容");
  await ui.click("agent-file-close");
  composer.focus(); await ui.route("one");
  assert.equal(ui.get("agent-panel").hidden, true);
  assert.equal(ui.document.activeElement, composer);
});

test("删除 Agent 或离开页面关闭产物库，迟到文件不恢复已删除状态", async () => {
  const pending = deferred(), ui = await setup({ files: () => ({ files: [{ path: "成果.md", size: 20 }] }), file: () => pending.promise });
  await ui.openArtifacts();
  const composer = ui.get("agent-message"); composer.focus();
  await ui.emit("neuma:agent-removed", { id: "one" });
  assert.equal(ui.get("agent-file-dialog").open, false);
  assert.equal(ui.get("agent-panel").hidden, true);
  assert.equal(ui.document.activeElement, composer);
  pending.resolve({ path: "成果.md", content: "迟到文件" }); await settle();
  await ui.click("agent-file-download");
  assert.equal(ui.item(), undefined);
  assert.equal(ui.downloads.length, 0);
  await ui.click("agent-panel-toggle"); await ui.openArtifacts();
  assert.equal(ui.get("agent-panel").hidden, true);
  assert.equal(ui.get("agent-file-dialog").open, false);
  await ui.route("two"); await ui.openArtifacts();
  composer.focus(); await ui.route(null);
  assert.equal(ui.get("agent-file-dialog").open, false);
  assert.equal(ui.document.activeElement, composer);
});

test("快速切换设置标签只过渡内容且保留草稿，关闭后清理动画", async () => {
  const ui = await setup();
  await ui.click("agent-panel-toggle");
  await ui.input("agent-profile-name", "尚未保存的新名字");
  await ui.click("agent-details-memory-tab");
  const previous = [...ui.animations];
  assert.equal(previous.length, 1);
  assert.equal(previous[0].target, ui.get("agent-details-memory"));
  await ui.click("agent-details-profile-tab");
  assert.equal(previous.every((animation) => animation.cancelled), true);
  assert.equal(ui.animations.every((animation) => animation.target !== ui.get("agent-panel")
    && animation.keyframes.every((frame) => !Object.hasOwn(frame, "height"))), true);
  assert.equal(ui.get("agent-details-profile").hidden, false);
  assert.equal(ui.get("agent-details-memory").hidden, true);
  assert.equal(ui.get("agent-profile-name").value, "尚未保存的新名字");
  await ui.click("agent-details-profile-tab");
  assert.equal(ui.animations.length, 2);
  assert.equal(ui.animations.at(-1).cancelled, false);
  await ui.click("agent-details-close");
  assert.equal(ui.animations.every((animation) => animation.cancelled), true);
  assert.equal(ui.document.activeElement, ui.get("agent-panel-toggle"));
});

test("减少动态效果时标签立即可用，中途更改偏好或离开 Agent 都取消动画", async () => {
  const ui = await setup({ reduceMotion: true });
  await ui.openMemory();
  assert.equal(ui.animations.length, 0);
  assert.equal(ui.get("agent-details-memory").hidden, false);
  assert.equal(ui.get("agent-memory-input").disabled, false);
  ui.motion.matches = false;
  await ui.click("agent-details-profile-tab");
  assert.equal(ui.animations.length, 1);
  ui.motion.matches = true;
  await ui.motion.dispatchEvent({ type: "change" });
  assert.equal(ui.animations.every((animation) => animation.cancelled), true);
  ui.motion.matches = false;
  await ui.click("agent-details-memory-tab");
  await ui.route("two");
  assert.equal(ui.get("agent-panel").hidden, true);
  assert.equal(ui.animations.every((animation) => animation.cancelled), true);
});
