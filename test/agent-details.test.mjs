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

async function setup({ files, file, memory, saveMemory, saveProfile, initial = "one", stored = new Map(), initialRuntime = {}, reduceMotion = false } = {}) {
  class Events {
    listeners = new Map();
    addEventListener(type, callback) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]); }
    dispatchEvent(event) { return Promise.all((this.listeners.get(event.type) ?? []).map((callback) => callback(event))); }
  }
  const document = new Events(), nodes = new Map(), requests = [], emitted = [], downloads = [], urls = [], timers = [], animations = [];
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
    getBoundingClientRect() { return { height: this.presentedHeight ?? (get("agent-details-profile").hidden ? 500 : 640) }; }
    animate(keyframes, options) {
      const animation = { target: this, keyframes, options, cancelled: false,
        cancel() { this.cancelled = true; delete this.target.presentedHeight; } };
      animations.push(animation);
      return animation;
    }
    focus() { document.activeElement = this; }
    modalOpens = 0;
    showModal() {
      assert.equal([...nodes.values()].some((node) => node !== this && node.open), false, "不能嵌套设置与产物弹窗");
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
  get("agent-file-dialog").append(get("agent-files-refresh"), get("agent-file-list"), get("agent-file-content"), get("agent-file-close"));
  class Event { constructor(type, fields = {}) { this.type = type; Object.assign(this, fields); } }
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
    window: { matchMedia: () => motion, localStorage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) } },
    staticArtifactDocument: (content) => `safe-preview:${content}`,
    URL: { createObjectURL: (blob) => { urls.push(blob); return `blob:${urls.length}`; }, revokeObjectURL: (url) => urls.push(url) },
    setTimeout: (callback) => timers.push(callback),
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
  return { get, emit, route, requests, emitted, downloads, urls, timers, document, stored, animations, motion,
    click: async (id) => { await get(id).click(); await settle(); },
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

test("初次路由主动握手并自动读取成果，设置默认关闭且只有资料和记忆", async () => {
  const ui = await setup();
  assert.equal(ui.get("agent-panel").open, false);
  assert.ok(ui.emitted.some((event) => event.type === "neuma:agent-runtime-request" && event.detail.agentId === "one"));
  await ui.click("agent-identity-edit");
  assert.equal(ui.get("agent-panel").open, true);
  assert.equal(ui.get("agent-panel").dataset.view, "profile");
  assert.equal(ui.get("agent-profile-name").value, "会议助手");
  assert.equal(ui.get("agent-details-title").textContent, "智能体设置");
  await ui.click("agent-details-close");
  assert.equal(ui.requests.some((request) => request.method === "listFiles" && request.args[0] === "one"), true);
  await ui.openMemory();
  assert.equal(ui.get("agent-panel").dataset.view, "memory");
  assert.equal(ui.get("agent-details-title").textContent, "智能体设置");
  assert.equal(ui.get("agent-memory-input").value, "one的记忆");
});

test("资料草稿跨标签保留，切 Agent 后使用各自草稿并忽略后台运行状态", async () => {
  const ui = await setup();
  await ui.click("agent-panel-toggle");
  await ui.input("agent-profile-name", "会议名称草稿");
  await ui.input("agent-profile-description", "会议简介草稿");
  await ui.click("agent-details-memory-tab"); await ui.click("agent-details-profile-tab");
  assert.equal(ui.get("agent-profile-name").value, "会议名称草稿");
  await ui.route("two");
  assert.equal(ui.get("agent-panel").open, false);
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

test("产物从顶栏打开，默认预览最新文件，同一弹窗切换并保留各 Agent 的选择", async () => {
  const ui = await setup({ files: (id) => ({ files: id === "one" ? [
    { path: "旧产物.md", size: 20, updatedAt: "2026-10-08T10:00:00Z" },
    { path: "最新产物.md", size: 20, updatedAt: "2026-10-09T10:00:00Z" },
  ] : [{ path: "周报.md", size: 20 }] }) });
  assert.equal(ui.get("agent-file-dialog").open, false);
  assert.equal(ui.get("agent-artifacts-count").textContent, "2");
  assert.equal(ui.requests.some((request) => request.method === "readFile"), false);
  await ui.openArtifacts();
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
  assert.equal(ui.get("agent-panel").open, false);
});

test("产物关闭和原生 Esc 取消均返回顶栏按钮，设置与文件库不嵌套", async () => {
  const ui = await setup({ files: () => ({ files: [{ path: "成果.md", size: 20 }] }) });
  await ui.click("agent-panel-toggle"); await ui.openArtifacts();
  assert.equal(ui.get("agent-file-dialog").open, true);
  assert.equal(ui.get("agent-panel").open, false);
  await ui.click("agent-file-close");
  assert.equal(ui.document.activeElement, ui.get("agent-artifacts-open"));
  await ui.openArtifacts(); await ui.get("agent-file-dialog").cancel();
  assert.equal(ui.get("agent-file-dialog").open, false);
  assert.equal(ui.document.activeElement, ui.get("agent-artifacts-open"));
  await ui.openArtifacts(); await ui.click("agent-panel-toggle");
  assert.equal(ui.get("agent-file-dialog").open, false);
  assert.equal(ui.get("agent-panel").open, true);
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
  await ui.click("agent-file-close"); await ui.click("agent-panel-toggle");
  composer.focus(); await ui.route("one");
  assert.equal(ui.document.activeElement, composer);
});

test("删除 Agent 或离开页面关闭产物库，迟到文件不恢复已删除状态", async () => {
  const pending = deferred(), ui = await setup({ files: () => ({ files: [{ path: "成果.md", size: 20 }] }), file: () => pending.promise });
  await ui.openArtifacts();
  const composer = ui.get("agent-message"); composer.focus();
  await ui.emit("neuma:agent-removed", { id: "one" });
  assert.equal(ui.get("agent-file-dialog").open, false);
  assert.equal(ui.document.activeElement, composer);
  pending.resolve({ path: "成果.md", content: "迟到文件" }); await settle();
  await ui.click("agent-file-download");
  assert.equal(ui.item(), undefined);
  assert.equal(ui.downloads.length, 0);
  await ui.route("two"); await ui.openArtifacts();
  composer.focus(); await ui.route(null);
  assert.equal(ui.get("agent-file-dialog").open, false);
  assert.equal(ui.document.activeElement, composer);
});

test("快速切换设置标签取消旧过渡，从当前高度续接并保留草稿，关闭后清理动画", async () => {
  const ui = await setup();
  await ui.click("agent-panel-toggle");
  await ui.input("agent-profile-name", "尚未保存的新名字");
  await ui.click("agent-details-memory-tab");
  const previous = [...ui.animations];
  assert.equal(previous.length, 2);
  ui.get("agent-panel").presentedHeight = 586;
  await ui.click("agent-details-profile-tab");
  assert.equal(previous.every((animation) => animation.cancelled), true);
  assert.equal(ui.animations.at(-2).keyframes[0].height, "586px");
  assert.equal(ui.get("agent-details-profile").hidden, false);
  assert.equal(ui.get("agent-details-memory").hidden, true);
  assert.equal(ui.get("agent-profile-name").value, "尚未保存的新名字");
  await ui.click("agent-details-profile-tab");
  assert.equal(ui.animations.length, 4);
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
  assert.equal(ui.animations.length, 2);
  ui.motion.matches = true;
  await ui.motion.dispatchEvent({ type: "change" });
  assert.equal(ui.animations.every((animation) => animation.cancelled), true);
  ui.motion.matches = false;
  await ui.click("agent-details-memory-tab");
  await ui.route("two");
  assert.equal(ui.get("agent-panel").open, false);
  assert.equal(ui.animations.every((animation) => animation.cancelled), true);
});
