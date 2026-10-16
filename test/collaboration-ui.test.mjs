import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { CollaborationService } from "../src/collaboration/groups.mjs";
import { createCollaborationApi } from "../public/collaboration-api.js";
import { renderAgentAvatar as renderAvatar, resolveAgentAvatar } from "../public/agent-avatar.js";
import { renderGroupAvatar as renderGroup } from "../public/group-avatar.js";
import { conversationDate, groupConversations } from "../public/group-view.js";
import { createSelectMenu } from "../public/select-menu.js";
import { createGroupMentionComposer } from "../public/group-mention-composer.js";
import { createSidebarHistory } from "../public/sidebar-history.js";

const read = async (file) => (await readFile(new URL(`../public/${file}`, import.meta.url), "utf8"))
  .replace(/^import[\s\S]*?;\n/gm, "").replace(/^export /gm, "");
const groupsSource = (await Promise.all(["collaboration-api.js", "group-view.js", "group-materials.js", "group-capabilities.js", "groups.js"].map(read))).join("\n");
const mainSource = (await Promise.all(["chat-ui.js", "agent-runtime.js", "collaboration-api.js", "group-view.js", "main-materials.js", "main-context.js", "main-agent.js"].map(read))).join("\n");
const settle = async () => { for (let index = 0; index < 4; index++) await new Promise(setImmediate); };
const copy = structuredClone;

function setup(source, request, initialStorage = [], { confirm = () => false, panelMotion = false, reduceMotion = false, richText } = {}) {
  class Events {
    listeners = new Map();
    addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); }
    removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== listener)); }
    dispatchEvent(event) { if (!event.target) Object.defineProperty(event, "target", { value: this, configurable: true });
      event.preventDefault ||= function () { this.defaultPrevented = true; };
      event.stopPropagation ||= function () { this.cancelBubble = true; };
      const pending = (this.listeners.get(event.type) || []).map((listener) => listener(event));
      if (event.bubbles && !event.cancelBubble && this !== document) pending.push((this.parent || document).dispatchEvent(event));
      return Promise.all(pending); }
  }
  const document = new Events(), nodes = new Map(), timers = new Map(), stored = new Map(initialStorage), renderedReplies = [], confirmations = [];
  const motion = Object.assign(new Events(), { matches: reduceMotion }), timeouts = [], clearedTimeouts = new Set(), geometryFinishes = [], layoutReads = [];
  let settingsWidth = 0;
  class Element extends Events {
    constructor(tag = "div") { super(); this.tagName = tag.toUpperCase(); }
    children = []; attributes = new Map(); dataset = {}; hidden = false; open = false; disabled = false; checked = false;
    className = ""; textContent = ""; contentValue = ""; scrollHeight = 300; clientHeight = 300; scrollTop = 0;
    style = { values: new Map(), setProperty(name, value) { this.values.set(name, value); }, removeProperty(name) { this.values.delete(name); } };
    classes = new Set(); classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name),
      add: (...names) => names.forEach((name) => this.classes.add(name)), remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name) || this.className.split(/\s+/).includes(name) };
    get value() { return this.contentValue || (this.tagName === "SELECT" ? this.children[0]?.value || "" : ""); }
    set value(value) { this.contentValue = value; this.selectionStart = this.selectionEnd = value.length; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    get childNodes() { return this.children; }
    get firstChild() { return this.children[0] || null; }
    get firstElementChild() { return this.children.find((child) => child instanceof Element) || null; }
    append(...children) { for (const child of children) { child.remove?.(); child.parent = this; this.children.push(child); } }
    prepend(...children) { for (const child of children) { child.remove?.(); child.parent = this; } this.children.unshift(...children); }
    remove() { if (this.parent) { this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; } }
    replaceChildren(...children) { for (const child of this.children) child.parent = null; this.children = []; this.append(...children); }
    setAttribute(name, value) { this.attributes.set(name, value); }
    removeAttribute(name) { this.attributes.delete(name); }
    getAttribute(name) { return this.attributes.get(name); }
    querySelector(selector) { return this.querySelectorAll(selector)[0]; }
    contains(element) { return this === element || this.querySelectorAll("*").includes(element); }
    closest(selector) { return selector === "[hidden]" && this.hidden ? this : this.parent?.closest(selector) || null; }
    querySelectorAll(selector) {
      const all = this.children.flatMap((child) => child instanceof Element ? [child, ...child.querySelectorAll("*")] : []);
      return selector === "input:checked" ? all.filter((item) => item.tagName === "INPUT" && item.checked)
        : selector === "button" ? all.filter((item) => item.tagName === "BUTTON")
          : selector.startsWith(".") ? all.filter((item) => item.classList.contains(selector.slice(1)))
            : selector.startsWith("#") ? all.filter((item) => item.id === selector.slice(1))
              : /^[a-z][\w-]*$/i.test(selector) ? all.filter((item) => item.tagName.toLowerCase() === selector.toLowerCase()) : all;
    }
    showModal() { this.open = true; }
    close() { this.open = false; return this.dispatchEvent({ type: "close" }); }
    focus() { document.activeElement = this; this.dispatchEvent({ type: "focusin", bubbles: true }); }
    click() { return this.dispatchEvent({ type: "click", target: this, bubbles: true }); }
    getBoundingClientRect() {
      layoutReads.push({ target: this, open: get("group-page-shell").classes.has("settings-open"), panelHidden: get("group-panel").hidden });
      return { left: 42, top: 100, right: 300, bottom: 132, width: 258, height: 32 };
    }
    getAnimations() { return this === get("group-page-shell") && panelMotion ? [{ finish() {
      settingsWidth = get("group-page-shell").classes.has("settings-open") ? 400 : 0; geometryFinishes.push(settingsWidth);
    } }] : []; }
  }
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, Object.assign(new Element(id === "group-message" ? "textarea" : id === "group-share-agent" ? "select"
      : ["group-editor", "group-files-dialog", "group-share-dialog", "main-material-dialog"].includes(id) ? "dialog" : "div"), {
      id, ...(["main-history-menu", "group-history-menu"].includes(id) ? { hidden: true } : {}),
      ...(["main-history-delete", "group-history-delete"].includes(id) ? { textContent: "删除对话" } : {}),
      ...(id === "group-panel" ? { hidden: true } : {}),
    }));
    return nodes.get(id);
  };
  document.hidden = false; document.getElementById = get;
  document.createElement = (tag) => new Element(tag);
  document.createElementNS = (_namespace, tag) => document.createElement(tag);
  document.createTextNode = (text) => ({ nodeType: 3, textContent: String(text), children: [],
    remove() { if (this.parent) { this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; } } });
  document.body = new Element("body");
  document.querySelector = (selector) => selector === "dialog[open]" ? [...nodes.values()].find((item) => item.tagName === "DIALOG" && item.open) || null : document.body.querySelector(selector);
  document.body.append(get("page-group"), get("page-chat"));
  get("main-history").append(get("sidebar-main-heading"), get("main-history-body"));
  get("sidebar-main-heading").className = "sidebar-history-heading";
  get("sidebar-main-heading").append(get("sidebar-main-link"), get("main-history-toggle"));
  get("sidebar-main-link").setAttribute("aria-controls", "main-history-body");
  get("sidebar-main-link").append(document.createElement("svg"), document.createElement("span"));
  get("main-history-body").append(get("main-history-list"), get("main-history-status"), get("main-history-more-toggle"));
  get("page-group").hidden = true;
  get("page-group").append(get("group-page-shell"), get("group-editor"), get("group-files-dialog"), get("group-share-dialog"));
  get("group-page-shell").append(get("group-primary"), get("group-panel"));
  get("group-primary").append(get("group-panel-toggle"), get("group-messages"), get("group-chat-form"), get("group-new-task"));
  get("group-panel-toggle").append(get("group-avatar"), get("group-title"));
  get("group-panel").append(get("group-details-close"), get("group-details-avatar"), get("group-details-name"), get("group-purpose"), get("group-files-open"),
    ...["profile", "members", "tasks"].map((tab) => get(`group-details-${tab}-tab`)), ...["profile", "members", "tasks"].map((tab) => get(`group-details-${tab}`)));
  get("group-details-profile").append(get("group-edit"), get("group-archive"), get("group-archived"));
  get("group-details-members").append(get("group-member-count"), get("group-members"));
  get("group-details-tasks").append(get("group-refresh"), get("group-tasks"));
  get("group-chat-form").append(get("group-message"), get("group-send"), get("group-attachment-menu-toggle"), get("group-attachment-menu"), get("group-mention-popup"), get("group-selected-mentions"), get("group-file-input"));
  get("group-attachment-menu").append(get("group-upload"), get("group-share-open"));
  get("group-files-dialog").append(get("group-files-close"), get("group-file-list"), get("group-file-actions"), get("group-file-preview"));
  get("group-share-dialog").append(get("group-share-close"), get("group-share-agent-trigger"), get("group-share-agent-menu"), get("group-share-list"));
  get("group-editor").append(get("group-editor-close"), get("group-editor-form"));
  get("group-editor-form").append(get("group-name"), get("group-purpose-input"), get("group-member-picker"), get("group-editor-save"));
  get("main-history-menu").append(get("main-history-delete"));
  get("group-history-menu").append(get("group-history-delete"));
  class Event { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } }
  document.defaultView = { Event };
  let serial = 0;
  const context = vm.createContext({ document, Event, CustomEvent: Event, crypto: { randomUUID: () => `mutation-${++serial}` },
    window: { innerWidth: 1440, innerHeight: 900, addEventListener() {}, matchMedia: () => motion,
      ...(panelMotion ? { getComputedStyle: () => ({ transitionDuration: motion.matches ? "0s" : "0.42s" }) } : {}),
      confirm(message) { confirmations.push(message); return confirm(message); } },
    renderRichText(container, content) { renderedReplies.push({ container, content });
      if (richText) richText(container, content, document); else container.textContent = content;
      container.classes.add("rich-text"); container.className = [...new Set([...container.className.split(/\s+/).filter(Boolean), "rich-text"])].join(" "); },
    renderAgentAvatar: (target, agent, options = {}) => renderAvatar(target, agent, { ...options, document }),
    resolveAgentAvatar,
    renderGroupAvatar: (target, group, members) => renderGroup(target, group, members, { document }),
    createSelectMenu, createSidebarHistory, createGroupMentionComposer,
    fetch: request, Response, ReadableStream, TextDecoder, TextEncoder, AbortController, structuredClone, URL, Blob,
    setTimeout: panelMotion ? (callback) => timeouts.push(callback) : setTimeout,
    clearTimeout: panelMotion ? (id) => clearedTimeouts.add(id) : clearTimeout,
    localStorage: { getItem: (key) => stored.get(key) || null, setItem: (key, value) => stored.set(key, value) },
    setInterval(callback) { const id = ++serial; timers.set(id, callback); return id; }, clearInterval(id) { timers.delete(id); },
  });
  vm.runInContext(source, context);
  return { get, document, timers, timeouts, clearedTimeouts, motion, geometryFinishes, layoutReads, stored, context, renderedReplies, confirmations,
    settingsWidth: () => settingsWidth, setSettingsWidth: (width) => { settingsWidth = width; },
    endSettings: (fields = {}) => get("group-page-shell").dispatchEvent(new Event("transitionend", { propertyName: "grid-template-columns", ...fields })),
    key: (target, key, fields = {}) => { const event = new Event("keydown", { key, bubbles: true, ...fields }); return target.dispatchEvent(event).then(() => event); },
    route: (detail) => { get("page-group").hidden = detail.page !== "group"; get("page-chat").hidden = detail.page !== "chat";
      return document.dispatchEvent(new Event("neuma:route", { detail })); },
    submit: (id) => get(id).dispatchEvent({ type: "submit", preventDefault() {} }), text: (id) => textOf(get(id)) };
}
async function openMention(ui, value = "@") {
  const input = ui.get("group-message"); input.value = value; input.setSelectionRange(value.length, value.length); input.focus();
  await input.dispatchEvent({ type: "input", bubbles: true });
  return ui.get("group-mention-popup");
}
async function pickMention(ui, id, value = "@") {
  const popup = await openMention(ui, value);
  await popup.children.find((item) => item.dataset.memberId === id).click();
}
const textOf = (node) => `${node.textContent || ""}${(node.children || []).map(textOf).join("")}`;
const isBubble = (node) => node.className.split(/\s+/).includes("bubble");
const groupMessageRows = (ui) => ui.get("group-messages").children.filter((node) => node.classList.contains("message"));
const sidebarGroup = (ui, id = "one") => ui.get("sidebar-group-list").children.find((entry) => entry.dataset.groupId === id);
const sidebarGroupRows = (ui, id = "one") => sidebarGroup(ui, id).querySelector(".sidebar-history-list").querySelectorAll(".sidebar-history-item");
const sidebarGroupMore = (ui, conversationId, id = "one") => sidebarGroup(ui, id).querySelector(".sidebar-history-list")
  .querySelectorAll(".main-history-more").find((button) => button.dataset.conversationId === conversationId);
const removeGroupHistory = async (ui, conversationId, id = "one") => {
  await sidebarGroupMore(ui, conversationId, id).click(); await ui.get("group-history-delete").click(); await settle();
};
const selectedGroupTask = (ui) => vm.runInContext("selectedTask", ui.context);
const mainHistoryItems = (ui) => ui.get("main-history-list").querySelectorAll(".collaboration-history-item");
const mainHistoryMore = (ui, id) => ui.get("main-history-list").children
  .find((row) => row.dataset.conversationId === id)?.querySelector(".main-history-more");
const removeMainHistory = async (ui, id) => { await mainHistoryMore(ui, id).click(); await ui.get("main-history-delete").click(); await settle(); };
const assertDisclosure = (element, visible) => {
  assert.equal(element.getAttribute("aria-hidden"), String(!visible), element.id);
  assert.equal(element.inert, !visible, element.id);
  assert.equal(element.hidden, false, element.id);
};
const group = (id = "one", name = "研究小组") => ({ id, name, purpose: "一起整理研究材料", memberIds: ["writer", "reviewer"], version: 1, lastSequence: 1, activeTaskId: "task-one" });
const member = (id = "writer", name = "写作助手") => ({ id, name, description: "整理清晰的报告", task: "写作", ready: true });
const detail = (id = "one", name = "研究小组") => ({ group: group(id, name), members: [member(), member("reviewer", "检查助手")],
  tasks: [{ id: "task-one", goal: "整理报告", status: "running", children: [{ id: "part-one", title: "整理初稿", status: "running", assigneeId: "writer" }] }],
  messages: [{ id: "message-one", seq: 1, sender: { type: "agent", id: "writer", name: "写作助手" }, content: `${name}的初稿`, taskId: "task-one", status: "complete" }],
  materials: [], artifacts: [], lastSequence: 1 });

async function readyGroup(state = detail(), { request, ...options } = {}) {
  const requests = [], ui = setup(groupsSource, async (path, settings = {}) => {
    requests.push({ path, settings });
    const response = await request?.(path, settings); if (response) return response;
    return Response.json(path === "/api/groups" ? { groups: [state.group] }
      : path === "/api/collaboration/agents" ? { agents: state.members }
        : path.endsWith("/attachments") ? { attachments: [] } : path.endsWith("/files") ? { files: [] }
          : path.includes("/events?") ? { events: [], lastSequence: state.lastSequence }
            : path === "/api/groups/two" ? detail("two", "设计小组") : state);
  }, [], options);
  await settle(); await ui.route({ page: "group", groupId: state.group.id }); await settle();
  return { ...ui, requests };
}

function removableGroup(id = "one", name = "研究小组") {
  const state = detail(id, name); state.group.activeTaskId = null;
  state.tasks = [
    { id: "removed-round-one", conversationId: "history/to-remove", goal: "完整的待删除话题", status: "completed", updatedAt: "2026-10-15T01:00:00Z" },
    { id: "removed-round-two", conversationId: "history/to-remove", goal: "该话题的后续消息", status: "completed", updatedAt: "2026-10-15T02:00:00Z" },
    { id: "kept-round", conversationId: "kept-conversation", goal: "保留的话题", status: "completed", updatedAt: "2026-10-15T03:00:00Z" },
  ];
  state.messages = state.tasks.map((task) => ({ id: `message-${task.id}`, taskId: task.id, sender: { type: "user" }, content: task.goal }));
  return state;
}
function removeGroupConversation(state, conversationId) {
  const removed = new Set(state.tasks.filter((task) => (task.conversationId || task.id) === conversationId).map((task) => task.id));
  state.tasks = state.tasks.filter((task) => !removed.has(task.id));
  state.messages = state.messages.filter((message) => !removed.has(message.taskId)); state.lastSequence++;
}

test("群组胶囊打开非模态设置，身份、完整名称提示、输入提示和分类同步且开合保留草稿", async () => {
  const state = detail(), ui = await readyGroup(state), requests = ui.requests.length;
  assert.equal(ui.get("group-panel").hidden, true);
  assert.equal(ui.get("group-panel-toggle").title, state.group.name);
  assert.equal(ui.get("group-message").placeholder, `给 ${state.group.name} 发消息…`);
  assert.equal(ui.text("group-details-name"), state.group.name);
  assert.equal(ui.text("group-purpose"), state.group.purpose);
  assert.equal(ui.get("group-details-avatar").dataset.memberCount, "2");
  ui.get("group-message").value = "保留群组草稿";
  await ui.get("group-panel-toggle").click();
  assert.equal(ui.get("group-panel").hidden, false); assert.equal(ui.get("group-panel").open, false);
  assert.equal(ui.get("group-panel").inert, false);
  assert.equal(ui.get("group-panel-toggle").getAttribute("aria-expanded"), "true");
  assert.equal(ui.get("group-page-shell").classes.has("settings-open"), true);
  assert.equal(ui.get("group-panel").dataset.view, "profile");
  for (const tab of ["members", "tasks", "profile"]) {
    await ui.get(`group-details-${tab}-tab`).click();
    assert.equal(ui.get(`group-details-${tab}`).hidden, false);
    assert.equal(ui.get(`group-details-${tab}-tab`).getAttribute("aria-pressed"), "true");
  }
  await ui.get("group-details-close").click();
  assert.equal(ui.get("group-panel").hidden, true);
  assert.equal(ui.document.activeElement.id, "group-panel-toggle");
  await ui.get("group-panel-toggle").click(); await ui.get("group-panel-toggle").click();
  assert.equal(ui.get("group-panel-toggle").getAttribute("aria-expanded"), "false");
  assert.equal(ui.get("group-message").value, "保留群组草稿");
  assert.equal(ui.requests.length, requests);
});

test("群设置 Esc 避让编辑和材料模态，文件库关闭后返回仍展开的设置入口", async () => {
  const ui = await readyGroup();
  await ui.get("group-panel-toggle").click(); await ui.get("group-edit").click(); await settle();
  assert.equal(ui.get("group-editor").open, true);
  assert.notEqual((await ui.key(ui.get("group-name"), "Escape")).defaultPrevented, true);
  assert.equal(ui.get("group-panel").hidden, false);
  await ui.get("group-editor").dispatchEvent({ type: "cancel" });
  await ui.get("group-files-open").click();
  assert.equal(ui.get("group-files-dialog").open, true);
  assert.notEqual((await ui.key(ui.get("group-files-close"), "Escape")).defaultPrevented, true);
  await ui.get("group-files-dialog").dispatchEvent({ type: "cancel" });
  assert.equal(ui.document.activeElement.id, "group-files-open");
  assert.equal((await ui.key(ui.get("group-files-open"), "Escape")).defaultPrevented, true);
  assert.equal(ui.get("group-panel").hidden, true); assert.equal(ui.document.activeElement.id, "group-panel-toggle");
});

test("群设置快速反向横移取消旧回调，逻辑关闭立即停用，完成不抢回聊天焦点", async () => {
  const ui = await readyGroup(detail(), { panelMotion: true }), shell = ui.get("group-page-shell"), panel = ui.get("group-panel");
  const initialReads = ui.layoutReads.filter((item) => item.target === shell).length;
  await ui.get("group-panel-toggle").click();
  const opened = shell.listeners.get("transitionend")[0], openingTimer = ui.timeouts.at(-1);
  await ui.get("group-panel-toggle").click();
  const closed = shell.listeners.get("transitionend")[0], closingTimer = ui.timeouts.at(-1);
  assert.equal(panel.hidden, false); assert.equal(panel.inert, true); assert.equal(panel.getAttribute("aria-hidden"), "true");
  assert.equal(ui.get("group-panel-toggle").getAttribute("aria-expanded"), "false");
  assert.notEqual((await ui.key(ui.get("group-message"), "Escape")).defaultPrevented, true);
  await ui.get("group-panel-toggle").click();
  assert.equal(ui.layoutReads.filter((item) => item.target === shell).length, initialReads + 1);
  openingTimer(); closingTimer(); opened({ target: shell, propertyName: "grid-template-columns" }); closed({ target: shell, propertyName: "grid-template-columns" });
  assert.equal(panel.hidden, false); assert.equal(panel.inert, false); assert.equal(shell.classes.has("is-settings-animating"), true);
  await ui.endSettings({ target: ui.get("group-details-profile") });
  assert.equal(shell.classes.has("is-settings-animating"), true);
  await ui.endSettings(); await ui.get("group-details-close").click();
  ui.get("group-message").focus(); ui.timeouts.at(-1)();
  assert.equal(panel.hidden, true); assert.equal(shell.classes.has("is-settings-animating"), false);
  assert.equal(ui.document.activeElement.id, "group-message");
});

test("群设置路由和减少动效立即结束轨道过渡，迟到回调不能影响新群资料和焦点", async () => {
  const ui = await readyGroup(detail(), { panelMotion: true });
  await ui.get("group-panel-toggle").click(); const oldTimer = ui.timeouts.at(-1);
  ui.setSettingsWidth(190); ui.get("group-message").focus();
  await ui.route({ page: "group", groupId: "two" }); await settle(); oldTimer();
  assert.equal(ui.settingsWidth(), 0); assert.equal(ui.get("group-panel").hidden, true);
  assert.equal(ui.document.activeElement.id, "group-message"); assert.equal(ui.text("group-details-name"), "设计小组");
  await ui.get("group-panel-toggle").click();
  ui.setSettingsWidth(180); ui.motion.matches = true; await ui.motion.dispatchEvent({ type: "change" });
  assert.equal(ui.settingsWidth(), 400); assert.equal(ui.get("group-panel").hidden, false);
  assert.equal(ui.get("group-page-shell").classes.has("is-settings-animating"), false);
  await ui.get("group-details-close").click();
  assert.equal(ui.settingsWidth(), 0); assert.equal(ui.get("group-panel").hidden, true);
  ui.motion.matches = false; await ui.get("group-panel-toggle").click(); const pending = ui.timeouts.at(-1);
  ui.get("group-message").focus(); await ui.route({ page: "chat" }); pending();
  assert.equal(ui.get("group-panel").hidden, true); assert.equal(ui.settingsWidth(), 0);
  assert.equal(ui.document.activeElement.id, "group-message");
});

test("群任务选择和刷新保留侧栏成员或任务控件焦点，编辑草稿不被刷新覆盖", async () => {
  const state = detail(), ui = await readyGroup(state);
  await ui.get("group-panel-toggle").click(); await ui.get("group-details-tasks-tab").click();
  ui.get("group-tasks").children[0].children[0].focus(); await ui.get("group-tasks").children[0].children[0].click();
  assert.equal(ui.document.activeElement, ui.get("group-tasks").children[0].children[0]);
  assert.equal(selectedGroupTask(ui), "task-one");
  await ui.get("group-details-members-tab").click();
  ui.get("group-members").children[0].open = true; ui.get("group-members").children[0].children[0].focus();
  state.members.reverse(); await ui.get("group-refresh").click(); await settle();
  const writer = ui.get("group-members").children.find((card) => card.dataset.memberId === "writer");
  assert.equal(writer.open, true); assert.equal(ui.document.activeElement, writer.children[0]);
  await ui.get("group-details-profile-tab").click(); await ui.get("group-edit").click(); await settle();
  ui.get("group-name").value = "尚未保存的群名"; ui.get("group-purpose-input").value = "尚未保存的群目标"; ui.get("group-name").focus();
  state.group.name = "服务端已保存群名"; state.group.purpose = "最新目标";
  await ui.get("group-refresh").click(); await settle();
  assert.equal(ui.document.activeElement.id, "group-name"); assert.equal(ui.get("group-name").value, "尚未保存的群名");
  assert.equal(ui.get("group-purpose-input").value, "尚未保存的群目标");
  assert.equal(ui.text("group-details-name"), state.group.name); assert.equal(ui.text("group-purpose"), state.group.purpose);
  assert.equal(ui.get("group-panel-toggle").title, state.group.name);
  assert.equal(ui.get("group-message").placeholder, `给 ${state.group.name} 发消息…`);
});

test("群发送完成保护侧栏和其他控件焦点，仍在发送按钮时才恢复输入", async () => {
  for (const focused of ["group-edit", "group-panel-toggle", "group-send"]) {
    let release;
    const ui = await readyGroup(detail(), { request: (path) => path.endsWith("/messages")
      ? new Promise((resolve) => { release = () => resolve(Response.json({ message: { id: "sent" } })); }) : undefined });
    ui.get("group-message").value = "整理资料"; ui.get("group-send").focus();
    await ui.submit("group-chat-form"); await settle();
    if (focused === "group-edit") await ui.get("group-panel-toggle").click();
    ui.get(focused).focus(); release(); await settle();
    assert.equal(ui.document.activeElement.id, focused === "group-send" ? "group-message" : focused);
  }
});

test("群材料加号选择本地文件复用当前群上传，忙碌关闭菜单且恢复后可继续使用", async () => {
  let release; const state = detail(), ui = await readyGroup(state, { request: (path, options) => path.endsWith("/materials") && options.method === "POST"
    ? new Promise((resolve) => { release = () => { state.materials.push({ id: "uploaded", name: "本地资料.txt" }); resolve(Response.json({ material: state.materials[0] })); }; }) : undefined });
  let inputClicks = 0; ui.get("group-file-input").addEventListener("click", () => inputClicks++);
  await ui.get("group-attachment-menu-toggle").click();
  assert.equal(ui.document.activeElement.id, "group-upload");
  await ui.get("group-upload").click();
  assert.equal(inputClicks, 1); assert.equal(ui.get("group-attachment-menu").hidden, true);
  assert.equal(ui.document.activeElement.id, "group-attachment-menu-toggle");
  ui.get("group-file-input").files = [{ name: "本地资料.txt", size: 128, type: "text/plain" }];
  await ui.get("group-file-input").dispatchEvent({ type: "change" }); await settle();
  assert.equal(ui.get("group-attachment-menu-toggle").disabled, true);
  assert.equal(ui.get("group-upload").disabled, true); assert.equal(ui.get("group-share-open").disabled, true);
  release(); await settle();
  assert.equal(ui.get("group-attachment-menu-toggle").disabled, false);
  assert.match(ui.text("group-pending-materials"), /本地资料\.txt/);
  assert.equal(ui.requests.find((item) => item.settings.method === "POST").path, "/api/groups/one/materials");
});

test("群材料菜单键盘开合与外部移焦不抢焦点，Esc 只关闭菜单并保留群设置", async () => {
  const ui = await readyGroup(), toggle = ui.get("group-attachment-menu-toggle"), upload = ui.get("group-upload"), share = ui.get("group-share-open");
  await ui.get("group-panel-toggle").click(); toggle.focus();
  await ui.key(toggle, "ArrowDown"); assert.equal(ui.document.activeElement.id, "group-upload");
  await ui.key(upload, "ArrowUp"); assert.equal(ui.document.activeElement.id, "group-share-open");
  await ui.key(share, "ArrowDown"); assert.equal(ui.document.activeElement.id, "group-upload");
  await ui.key(upload, "End"); assert.equal(ui.document.activeElement.id, "group-share-open");
  await ui.key(share, "Home"); assert.equal(ui.document.activeElement.id, "group-upload");
  assert.equal((await ui.key(upload, "Escape")).defaultPrevented, true);
  assert.equal(ui.get("group-attachment-menu").hidden, true); assert.equal(ui.document.activeElement, toggle);
  assert.equal(ui.get("group-panel").hidden, false);
  await ui.key(toggle, "ArrowUp"); assert.equal(ui.document.activeElement.id, "group-share-open");
  assert.notEqual((await ui.key(share, "Tab")).defaultPrevented, true);
  ui.get("group-message").focus(); assert.equal(ui.document.activeElement.id, "group-message");
  await toggle.click(); await ui.get("group-message").click(); assert.equal(ui.get("group-attachment-menu").hidden, true);
});

test("群材料菜单分享仅显式选中文件才提交，分享弹窗返回可见加号且跨群关闭不返旧焦点", async () => {
  const ui = await readyGroup(detail(), { request: (path) => path.endsWith("/attachments")
    ? Response.json({ attachments: [{ id: "private", name: "私人资料.txt" }] }) : undefined });
  await ui.get("group-attachment-menu-toggle").click(); await ui.get("group-share-open").click(); await settle();
  assert.equal(ui.get("group-attachment-menu").hidden, true); assert.equal(ui.get("group-share-dialog").open, true);
  assert.equal(ui.requests.some((item) => item.path.endsWith("/share")), false);
  await ui.get("group-share-dialog").dispatchEvent({ type: "cancel" });
  assert.equal(ui.document.activeElement.id, "group-attachment-menu-toggle");
  await ui.get("group-attachment-menu-toggle").click(); await ui.get("group-share-open").click(); await settle();
  ui.get("group-message").focus(); await ui.route({ page: "group", groupId: "two" }); await settle();
  assert.equal(ui.get("group-share-dialog").open, false); assert.equal(ui.get("group-attachment-menu").hidden, true);
  assert.equal(ui.document.activeElement.id, "group-message"); assert.equal(ui.get("group-attachment-menu-toggle").disabled, false);
});

test("群发送或归档同步关闭并禁用材料菜单，刷新结束恢复可用入口", async () => {
  let release; const state = detail(), ui = await readyGroup(state, { request: (path) => path.endsWith("/messages")
    ? new Promise((resolve) => { release = () => resolve(Response.json({ message: { id: "sent" } })); }) : undefined });
  await ui.get("group-attachment-menu-toggle").click(); ui.get("group-message").value = "研究材料";
  await ui.submit("group-chat-form"); await settle();
  assert.equal(ui.get("group-attachment-menu").hidden, true); assert.equal(ui.get("group-attachment-menu-toggle").disabled, true);
  release(); await settle(); assert.equal(ui.get("group-attachment-menu-toggle").disabled, false);
  state.group.archived = true; await ui.get("group-refresh").click(); await settle();
  for (const id of ["group-attachment-menu-toggle", "group-upload", "group-share-open"]) assert.equal(ui.get(id).disabled, true);
  await ui.route({ page: "chat" });
  assert.equal(ui.get("group-attachment-menu").hidden, true); assert.equal(ui.get("group-attachment-menu-toggle").disabled, true);
});

test("主聊和群聊共享助理富文本入口，用户原文与独立导航链接保留", async () => {
  const assistant = { role: "assistant", content: "**积分讲解** $x^2$ #group/one", status: "complete",
    actions: [{ href: "#agent/writer", label: "打开写作助手" }] };
  const user = { role: "user", content: "**原始输入** `f(x)=x^2` #group/one", status: "complete" };
  for (const source of [mainSource, groupsSource]) {
    const ui = setup(source, async () => Response.json({ groups: [] }));
    const assistantRow = vm.runInContext(`messageRow(${JSON.stringify(assistant)}, { bubble: true })`, ui.context);
    const userRow = vm.runInContext(`messageRow(${JSON.stringify(user)}, { bubble: true })`, ui.context);
    assert.equal(ui.renderedReplies.length, 1);
    assert.equal(ui.renderedReplies[0].content, "**积分讲解** $x^2$");
    assert.equal(ui.renderedReplies[0].container, assistantRow.children[0]);
    assert.equal(userRow.children[0].textContent, user.content);
    assert.equal(userRow.children[0].classes.has("rich-text"), false);
    assert.deepEqual(assistantRow.children.at(-1).children.map((link) => link.href), ["#group/one", "#agent/writer"]);
  }
});

test("协作请求保留群身份、幂等操作与定向消息，群材料使用独立下载入口", async () => {
  const requests = [], api = createCollaborationApi(async (path, options = {}) => { requests.push({ path, options }); return Response.json({ message: { id: "ok" } }); });
  await api.send("one/two", { content: "检查初稿", recipientId: "reviewer", mutationId: "same" });
  await api.events("one/two", 7);
  assert.equal(requests[0].path, "/api/groups/one%2Ftwo/messages");
  assert.deepEqual(JSON.parse(requests[0].options.body), { content: "检查初稿", recipientId: "reviewer", mutationId: "same" });
  assert.equal(requests[1].path, "/api/groups/one%2Ftwo/events?after=7");
  assert.equal(api.materialUrl("one", "material/one", true), "/api/groups/one/materials/material%2Fone/raw?download=1");
});

test("侧栏群组列表不显示空列表提示，群组入口和群组页引导保持可用", async () => {
  for (const groups of [[], [{ ...group(), archived: true }], [group()]]) {
    const ui = setup(groupsSource, async () => Response.json({ groups }));
    await settle();
    assert.equal(ui.get("sidebar-groups-feedback").hidden, true);
    assert.equal(ui.text("sidebar-groups-feedback"), "");
    assert.equal(ui.get("sidebar-group-list").children.length, groups.filter((item) => !item.archived).length);
    if (!groups.some((item) => !item.archived)) assert.match(ui.text("groups-list"), /创建第一个群组/);
  }
});

test("群头像在侧栏、列表和群标题使用同一静态组合，资料更新不增加读取请求", async () => {
  const requests = [], state = detail();
  state.members[0].profile = { icon: "star:4:1" }; state.members[1].profile = { icon: "star:0:2" };
  const ui = setup(groupsSource, async (path) => { requests.push(path); return Response.json(path === "/api/groups" ? { groups: [state.group] } : state); });
  await settle(); await ui.document.dispatchEvent({ type: "neuma:agents-changed", detail: { items: state.members } });
  await ui.route({ page: "group", groupId: "one" }); await settle();
  const avatars = () => [sidebarGroup(ui).querySelector(".sidebar-group-avatar"),
    ui.get("sidebar-group-rail").children[0].children[0], ui.get("groups-list").children[0].children[0].children[0],
    ui.get("group-avatar"), ui.get("group-details-avatar")];
  for (const avatar of avatars()) {
    assert.equal(avatar.dataset.memberCount, "2");
    assert.deepEqual(avatar.children.map((child) => child.dataset.avatarIcon), ["star:4:1", "star:0:2"]);
    assert.ok(avatar.children.every((child) => child.children[0].dataset.avatarMotion === "false"));
  }
  const before = requests.length;
  await ui.document.dispatchEvent({ type: "neuma:agent-profile-changed", detail: { id: "writer", profile: { icon: "star:1:7" } } });
  for (const avatar of avatars()) assert.equal(avatar.children[0].dataset.avatarIcon, "star:1:7");
  assert.equal(requests.length, before);
  assert.equal(sidebarGroup(ui).querySelector(".sidebar-group-link").href, "#group/one");
  assert.equal(textOf(sidebarGroup(ui).querySelector(".sidebar-group-link")), "研究小组");
});

test("收起栏保留全部未归档群供独立滚动，刷新与滚动范围外的重排不打断焦点", async () => {
  let listed = [group("archived", "归档组"), group("one"), group("two", "设计小组"), group("three", "第三小组"),
    group("four", "第四小组"), group("five", "第五小组"), group("six", "第六小组")];
  listed[0].archived = true;
  const requests = [], ui = setup(groupsSource, async (path) => {
    requests.push(path); return Response.json({ groups: listed });
  });
  await settle();
  const rail = ui.get("sidebar-group-rail"), first = rail.children[0], second = rail.children[1];
  assert.deepEqual(rail.children.map((link) => link.dataset.groupId), ["one", "two", "three", "four", "five", "six"]);
  assert.equal(rail.hidden, false); assert.equal(first.href, "#group/one");
  assert.equal(first.title, "研究小组"); assert.equal(first.getAttribute("aria-label"), "打开研究小组的群聊");
  assert.equal(requests.length, 1);
  first.focus(); await ui.document.dispatchEvent({ type: "neuma:groups-changed" }); await settle();
  assert.equal(rail.children[0], first); assert.equal(rail.children[1], second); assert.equal(ui.document.activeElement, first);
  await ui.document.dispatchEvent({ type: "neuma:agent-profile-changed", detail: { id: "writer", profile: { icon: "star:1:7" } } });
  assert.equal(rail.children[0], first); assert.equal(first.children[0].children[0].dataset.avatarIcon, "star:1:7");
  assert.equal(ui.document.activeElement, first); assert.equal(requests.length, 2);
  listed = [...listed.slice(2), listed[1]];
  await ui.document.dispatchEvent({ type: "neuma:groups-changed" }); await settle();
  assert.deepEqual(rail.children.map((link) => link.dataset.groupId), ["two", "three", "four", "five", "six", "one"]);
  assert.equal(rail.children[0], second); assert.equal(rail.children.at(-1), first); assert.equal(ui.document.activeElement, first);
});

test("收起栏群头像删除或归档时将原头像焦点返回侧栏开关", async () => {
  for (const change of ["delete", "archive"]) {
    let listed = [group("one"), group("two", "设计小组"), group("three", "第三小组")];
    const ui = setup(groupsSource, async () => Response.json({ groups: listed })); await settle();
    const rail = ui.get("sidebar-group-rail"), removed = rail.children[0]; removed.focus();
    if (change === "delete") listed = listed.slice(1);
    else listed[0].archived = true;
    await ui.document.dispatchEvent({ type: "neuma:groups-changed" }); await settle();
    assert.deepEqual(rail.children.map((link) => link.dataset.groupId), ["two", "three"]);
    assert.equal(ui.document.activeElement.id, "sidebar-toggle"); assert.equal(rail.contains(removed), false);
    listed = [];
    await ui.document.dispatchEvent({ type: "neuma:groups-changed" }); await settle();
    assert.equal(rail.hidden, true); assert.equal(rail.children.length, 0);
  }
});

test("收起栏群头像直接进入群聊、保留各群草稿，修饰键保留原生链接行为", async () => {
  const first = detail(), second = detail("two", "设计小组"), requests = [];
  const ui = setup(groupsSource, async (path, options = {}) => {
    requests.push({ path, method: options.method });
    return Response.json(path === "/api/groups" ? { groups: [first.group, second.group] }
      : path === "/api/groups/two" ? second : first);
  });
  await settle();
  const rail = ui.get("sidebar-group-rail"), firstLink = rail.children[0], secondLink = rail.children[1], navigations = [];
  ui.document.addEventListener("neuma:navigate", (event) => { navigations.push(event.detail); return ui.route(event.detail); });
  const body = sidebarGroup(ui).querySelector(".sidebar-history-body"); assert.equal(body.inert, true);
  for (const fields of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }]) {
    const event = { type: "click", target: firstLink, ...fields }; await firstLink.dispatchEvent(event);
    if (!fields.defaultPrevented) assert.notEqual(event.defaultPrevented, true);
  }
  assert.equal(navigations.length, 0); assert.equal(body.inert, true);
  await firstLink.click(); await settle(); assert.equal(firstLink.getAttribute("aria-current"), "page");
  ui.get("group-message").value = "研究小组未发送的草稿";
  await firstLink.click(); await settle(); assert.equal(body.inert, false);
  assert.equal(ui.get("group-message").value, "研究小组未发送的草稿");
  await secondLink.click(); await settle(); assert.equal(secondLink.getAttribute("aria-current"), "page");
  assert.equal(firstLink.getAttribute("aria-current"), undefined); ui.get("group-message").value = "设计小组未发送的草稿";
  await firstLink.click(); await settle(); assert.equal(ui.get("group-message").value, "研究小组未发送的草稿");
  await secondLink.click(); await settle(); assert.equal(ui.get("group-message").value, "设计小组未发送的草稿");
  assert.equal(requests.some((request) => request.method === "POST"), false);
  await ui.route({ page: "chat" }); assert.equal(secondLink.getAttribute("aria-current"), undefined);
});

test("群导航按需读取任务历史，默认最近四条，更多与折叠不会新增任务或清除草稿", async () => {
  const state = detail(), requests = [];
  state.tasks = Array.from({ length: 6 }, (_, index) => ({ id: `topic-${index + 1}`, goal: `讨论 ${index + 1}`, status: "complete" }));
  const ui = setup(groupsSource, async (path, options = {}) => {
    requests.push({ path, method: options.method });
    return Response.json(path === "/api/groups" ? { groups: [state.group] } : state);
  });
  await settle(); const entry = sidebarGroup(ui), toggle = entry.querySelector(".sidebar-history-toggle");
  assert.equal(entry.querySelector(".sidebar-history-new"), undefined);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(requests.length, 1); ui.get("main-message").value = "未发送的主聊天草稿";
  await toggle.click(); await settle();
  assert.equal(requests.filter((request) => request.path === "/api/groups/one").length, 1);
  assert.deepEqual(sidebarGroupRows(ui).map((row) => row.dataset.taskId), ["topic-6", "topic-5", "topic-4", "topic-3"]);
  const more = entry.querySelector(".sidebar-history-show-more"); assert.equal(more.hidden, false);
  await more.click(); assert.equal(sidebarGroupRows(ui).length, 6); assert.equal(more.textContent, "收起");
  await toggle.click(); assert.equal(entry.querySelector(".sidebar-history-body").inert, true);
  await toggle.click(); await ui.route({ page: "groups" }); await settle();
  assert.equal(sidebarGroup(ui), entry); assert.equal(sidebarGroupRows(ui).length, 6);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(requests.filter((request) => request.path === "/api/groups/one").length, 1);
  assert.equal(requests.some((request) => request.method === "POST"), false);
  assert.equal(ui.get("main-message").value, "未发送的主聊天草稿");
  assert.equal(ui.stored.get("neuma.sidebar.history-open.v1.group-one"), "true");
});

test("群导航整行标题、头像和空白可反复折叠，箭头不重复切换且空格支持键盘操作", async () => {
  const ui = await readyGroup(), entry = sidebarGroup(ui), link = entry.querySelector(".sidebar-group-link");
  const heading = entry.querySelector(".sidebar-history-heading"), toggle = entry.querySelector(".sidebar-history-toggle");
  const body = entry.querySelector(".sidebar-history-body"), avatar = entry.querySelector(".sidebar-group-avatar");
  const activate = async (target) => { const event = { type: "click", target, bubbles: true }; await target.dispatchEvent(event); await settle(); return event; };
  const expanded = (open) => {
    assert.equal(body.inert, !open); assert.equal(link.getAttribute("aria-expanded"), String(open));
    assert.equal(toggle.getAttribute("aria-expanded"), String(open));
  };
  assert.equal(link.getAttribute("aria-controls"), body.id); expanded(true);
  ui.get("group-message").value = "整行切换时保留群草稿";
  await ui.get("group-panel-toggle").click(); ui.get("group-edit").focus();
  const requests = ui.requests.length;
  assert.equal((await activate(link)).defaultPrevented, true); expanded(false);
  assert.notEqual((await activate(avatar)).defaultPrevented, true); expanded(true);
  await activate(heading); expanded(false);
  const opening = await ui.key(link, " "); await settle(); assert.equal(opening.defaultPrevented, true); expanded(true);
  const repeating = await ui.key(link, " ", { repeat: true }); assert.equal(repeating.defaultPrevented, true); expanded(true);
  await activate(link.querySelector(".sidebar-history-name")); expanded(false);
  await activate(heading); expanded(true);
  assert.equal(ui.get("group-message").value, "整行切换时保留群草稿");
  assert.equal(ui.get("group-panel").hidden, false); assert.equal(ui.document.activeElement.id, "group-edit");
  await activate(toggle); expanded(false); await activate(toggle); expanded(true);
  assert.equal(ui.requests.length, requests); assert.equal(ui.requests.some((request) => request.settings.method === "POST"), false);
});

test("侧栏群话题保持设置、输入草稿与编辑焦点，父群标题保留当前对话", async () => {
  const state = detail(); state.tasks.push({ id: "task-two", goal: "第二个话题", status: "complete" });
  state.messages.push({ ...state.messages[0], id: "message-two", taskId: "task-two", content: "第二个话题的内容" });
  const ui = await readyGroup(state), entry = sidebarGroup(ui);
  ui.get("group-message").value = "留在当前群的输入草稿";
  await ui.get("group-panel-toggle").click(); ui.get("group-edit").focus();
  await sidebarGroupRows(ui).find((row) => row.dataset.taskId === "task-two").click();
  assert.equal(selectedGroupTask(ui), "task-two");
  assert.match(ui.text("group-messages"), /第二个话题的内容/); assert.doesNotMatch(ui.text("group-messages"), /研究小组的初稿/);
  assert.equal(ui.get("group-message").value, "留在当前群的输入草稿");
  assert.equal(ui.get("group-panel").hidden, false); assert.equal(ui.document.activeElement.id, "group-edit");
  await entry.querySelector(".sidebar-group-link").click();
  assert.equal(entry.querySelector(".sidebar-history-body").inert, true); assert.equal(selectedGroupTask(ui), "task-two");
  assert.doesNotMatch(ui.text("group-messages"), /研究小组的初稿/);
  assert.equal(ui.get("group-message").value, "留在当前群的输入草稿");
  assert.equal(ui.get("group-panel").hidden, false); assert.equal(ui.document.activeElement.id, "group-edit");
  await entry.querySelector(".sidebar-group-link").click();
  assert.equal(selectedGroupTask(ui), "task-two");
  assert.match(ui.text("group-messages"), /第二个话题的内容/); assert.doesNotMatch(ui.text("group-messages"), /研究小组的初稿/);
  assert.equal(ui.get("group-message").value, "留在当前群的输入草稿");
  assert.equal(ui.get("group-panel").hidden, false); assert.equal(ui.document.activeElement.id, "group-edit");
  const row = sidebarGroupRows(ui).find((candidate) => candidate.dataset.taskId === "task-one"); row.focus(); await row.click();
  assert.equal(ui.document.activeElement.dataset.taskId, "task-one"); assert.equal(sidebarGroup(ui), entry);
  assert.equal(sidebarGroupRows(ui).find((candidate) => candidate.dataset.taskId === "task-one").getAttribute("aria-current"), "page");
  assert.equal(ui.requests.filter((request) => request.settings.method === "POST").length, 0);
});

test("从另一群的侧栏话题进入真实群任务，返回原群恢复草稿，群聊顶部新对话清空展示而不发起执行", async () => {
  const first = detail(), second = detail("two", "设计小组");
  second.tasks = [{ id: "design-topic", goal: "讨论页面", status: "complete" }];
  second.messages = [{ ...second.messages[0], taskId: "design-topic", content: "设计话题的历史" }];
  const requests = [], ui = setup(groupsSource, async (path, options = {}) => {
    requests.push({ path, method: options.method });
    return Response.json(path === "/api/groups" ? { groups: [first.group, second.group] }
      : path === "/api/groups/two" ? second : first);
  });
  ui.document.addEventListener("neuma:navigate", (event) => ui.route(event.detail));
  await settle(); await ui.route({ page: "group", groupId: "one" }); await settle();
  ui.get("group-message").value = "研究小组的草稿";
  await sidebarGroup(ui, "two").querySelector(".sidebar-history-toggle").click(); await settle();
  await sidebarGroupRows(ui, "two")[0].click(); await settle();
  assert.equal(ui.text("group-title"), "设计小组"); assert.equal(selectedGroupTask(ui), "design-topic");
  assert.match(ui.text("group-messages"), /设计话题的历史/); assert.equal(ui.get("group-message").value, "");
  ui.get("group-message").value = "设计小组的草稿";
  await sidebarGroup(ui).querySelector(".sidebar-group-link").click(); await settle();
  assert.equal(ui.text("group-title"), "设计小组");
  await sidebarGroup(ui).querySelector(".sidebar-group-link").click(); await settle();
  assert.equal(ui.get("group-message").value, "研究小组的草稿");
  await ui.route({ page: "group", groupId: "two" }); await settle();
  assert.ok(ui.get("sidebar-group-list").children.every((entry) => !entry.querySelector(".sidebar-history-new")));
  await ui.get("group-new-task").click(); await settle();
  assert.equal(selectedGroupTask(ui), ""); assert.equal(ui.get("group-message").value, "设计小组的草稿");
  assert.equal(vm.runInContext("newTask", ui.context), true);
  assert.equal(groupMessageRows(ui).length, 0); assert.doesNotMatch(ui.text("group-messages"), /设计话题的历史/);
  assert.equal(ui.document.activeElement.id, "group-message");
  assert.equal(requests.some((request) => request.method === "POST"), false);
});

test("群加号立即进入空白对话，保留输入与接收者，旧任务刷新不会带回消息或进度", async () => {
  const state = detail(); state.messages[0].createdAt = "2026-10-14T08:00:00Z";
  let holdRead = false, release;
  const ui = await readyGroup(state, { request(path) {
    if (path.includes("/events?")) return Response.json({ events: [{ seq: 2 }], lastSequence: 2 });
    if (path === "/api/groups/one" && holdRead) return new Promise((resolve) => { release = () => resolve(Response.json(state)); });
    return null;
  } });
  assert.equal(groupMessageRows(ui).length, 1); assert.equal(ui.get("group-messages").querySelectorAll("time").length, 1);
  await pickMention(ui, "writer"); ui.get("group-message").value += "新话题的草稿";
  holdRead = true; [...ui.timers.values()][0](); await settle(); assert.ok(release);
  const reads = ui.requests.length;
  await ui.get("group-new-task").click();
  assert.equal(ui.requests.length, reads); assert.equal(ui.document.activeElement.id, "group-message");
  assert.equal(ui.get("group-message").value, "@写作助手 新话题的草稿"); assert.match(ui.text("group-selected-mentions"), /写作助手/);
  assert.equal(groupMessageRows(ui).length, 0); assert.equal(ui.get("group-messages").querySelectorAll("time").length, 0);
  assert.equal(ui.get("group-compose-status").hidden, true); assert.equal(state.tasks[0].status, "running");
  state.messages.push({ ...state.messages[0], id: "later-old-message", content: "旧任务的后续回复" });
  release(); await settle(); holdRead = false;
  await ui.get("group-refresh").click(); await settle();
  assert.equal(groupMessageRows(ui).length, 0); assert.equal(ui.get("group-compose-status").hidden, true);
  assert.doesNotMatch(ui.text("group-messages"), /初稿|后续回复/);
  assert.equal(ui.get("group-message").value, "@写作助手 新话题的草稿"); assert.match(ui.text("group-selected-mentions"), /写作助手/);
  assert.equal(ui.requests.some(({ settings }) => settings.method === "POST"), false);
  await sidebarGroupRows(ui).find((row) => row.dataset.taskId === "task-one").click();
  assert.equal(vm.runInContext("newTask", ui.context), false);
  assert.match(ui.text("group-messages"), /旧任务的后续回复/);
  assert.equal(ui.text("group-compose-status"), "正在处理你的消息…");
});

test("新群对话发送失败与离页返回保留准备态，同请求重试后只显示真实新话题", async () => {
  const state = detail(), writes = [];
  const ui = await readyGroup(state, { request(path, options) {
    if (!path.endsWith("/messages")) return null;
    writes.push(JSON.parse(options.body));
    if (writes.length === 1) return Response.json({ error: "连接暂时断开" }, { status: 503 });
    const task = { id: "task-new", goal: writes.at(-1).content, status: "queued", children: [] };
    const message = { id: "new-message", sender: { type: "user", id: "user" }, content: task.goal, taskId: task.id };
    state.tasks.push(task); state.messages.push(message); state.group.activeTaskId = task.id; state.lastSequence++;
    return Response.json({ task, message });
  } });
  await ui.get("group-new-task").click(); ui.get("group-message").value = "开始新的讨论";
  await ui.submit("group-chat-form"); await settle();
  assert.match(ui.text("group-error"), /连接暂时断开/);
  assert.equal(vm.runInContext("newTask", ui.context), true); assert.equal(groupMessageRows(ui).length, 0);
  assert.equal(ui.get("group-message").value, "开始新的讨论");
  await ui.get("group-refresh").click(); await settle();
  await ui.route({ page: "chat" }); await ui.route({ page: "group", groupId: "one" }); await settle();
  assert.equal(vm.runInContext("newTask", ui.context), true); assert.equal(groupMessageRows(ui).length, 0);
  assert.equal(ui.get("group-message").value, "开始新的讨论");
  await ui.submit("group-chat-form"); await settle();
  assert.deepEqual(writes[1], writes[0]); assert.equal(writes[0].newTask, true); assert.equal(Object.hasOwn(writes[0], "taskId"), false);
  assert.equal(vm.runInContext("newTask", ui.context), false); assert.equal(selectedGroupTask(ui), "task-new");
  assert.equal(ui.get("group-message").value, ""); assert.equal(groupMessageRows(ui).length, 1);
  assert.match(ui.text("group-messages"), /开始新的讨论/); assert.doesNotMatch(ui.text("group-messages"), /研究小组的初稿/);
  assert.equal(sidebarGroupRows(ui).length, 2); assert.equal(state.tasks[0].status, "running");
});

test("新对话准备态随本群草稿恢复，不串到其他群，选择历史后退出准备态", async () => {
  const ui = await readyGroup();
  await ui.get("group-new-task").click(); ui.get("group-message").value = "研究群的新对话草稿";
  await ui.route({ page: "group", groupId: "two" }); await settle();
  assert.equal(vm.runInContext("newTask", ui.context), false); assert.match(ui.text("group-messages"), /设计小组的初稿/);
  ui.get("group-message").value = "设计群的草稿";
  await ui.route({ page: "group", groupId: "one" }); await settle();
  assert.equal(vm.runInContext("newTask", ui.context), true); assert.equal(groupMessageRows(ui).length, 0);
  assert.equal(ui.get("group-message").value, "研究群的新对话草稿");
  await sidebarGroupRows(ui).find((row) => row.dataset.taskId === "task-one").click();
  assert.equal(vm.runInContext("newTask", ui.context), false); assert.match(ui.text("group-messages"), /研究小组的初稿/);
  await ui.route({ page: "chat" }); await ui.route({ page: "group", groupId: "one" }); await settle();
  assert.equal(vm.runInContext("newTask", ui.context), false); assert.match(ui.text("group-messages"), /研究小组的初稿/);
});

test("新对话发送中切群，成功回执只清理源群草稿与已发送材料，不影响当前群", async () => {
  const first = detail(), second = detail("two", "设计小组"), writes = [];
  first.materials = [{ id: "first-material", name: "研究资料.txt", mimeType: "text/plain" }];
  second.materials = [{ id: "second-material", name: "设计资料.txt", mimeType: "text/plain" }];
  let release;
  const ui = await readyGroup(first, { request(path, options) {
    if (path.endsWith("/preview")) return Response.json({ text: "已选文件的正文" });
    if (path === "/api/groups/two") return Response.json(second);
    if (path.endsWith("/messages")) {
      writes.push(JSON.parse(options.body));
      return new Promise((resolve) => { release = () => {
        const task = { id: "new-topic-run", conversationId: "new-topic", goal: "新话题请求", status: "completed" };
        const message = { id: "sent", taskId: task.id, content: "新话题请求", sender: { type: "user" } };
        first.tasks.push(task); first.messages.push(message); first.group.activeTaskId = null;
        resolve(Response.json({ message, task }));
      }; });
    }
    return null;
  } });
  const selectMaterial = async () => {
    await ui.get("group-files-open").click();
    await ui.get("group-file-list").children.find((item) => item.tagName === "BUTTON").click(); await settle();
    await ui.get("group-file-actions").children[1].click();
  };
  await ui.route({ page: "group", groupId: "two" }); await settle();
  await selectMaterial(); ui.get("group-message").value = "另一个群的草稿";
  await ui.route({ page: "group", groupId: "one" }); await settle();
  await selectMaterial(); await ui.get("group-new-task").click(); ui.get("group-message").value = "新话题请求";
  assert.match(ui.text("group-pending-materials"), /研究资料/);
  await ui.submit("group-chat-form"); await settle(); assert.ok(release);
  assert.deepEqual(writes[0].attachmentIds, ["first-material"]); assert.equal(writes[0].newTask, true);
  await ui.route({ page: "group", groupId: "two" }); await settle(); ui.get("group-panel-toggle").focus();
  release(); await settle();
  assert.equal(ui.get("group-message").value, "另一个群的草稿");
  assert.match(ui.text("group-pending-materials"), /设计资料/); assert.equal(ui.get("group-pending-materials").hidden, false);
  assert.equal(ui.document.activeElement.id, "group-panel-toggle");
  await ui.route({ page: "group", groupId: "one" }); await settle();
  assert.equal(ui.get("group-message").value, ""); assert.equal(ui.get("group-pending-materials").hidden, true);
  assert.equal(vm.runInContext("newTask", ui.context), false); assert.equal(writes.length, 1);
  assert.equal(selectedGroupTask(ui), "new-topic"); assert.equal(groupMessageRows(ui).length, 1);
  assert.match(ui.text("group-messages"), /新话题请求/); assert.doesNotMatch(ui.text("group-messages"), /研究小组的初稿/);
});

test("导航懒加载的旧群历史不能覆盖后来打开群页读取的新任务", async () => {
  let release, reads = 0;
  const fresh = detail(); fresh.tasks = [{ id: "fresh-topic", goal: "最新任务", status: "complete" }];
  const ui = setup(groupsSource, async (path) => {
    if (path === "/api/groups") return Response.json({ groups: [fresh.group] });
    if (++reads === 1) return new Promise((resolve) => { release = () => resolve(Response.json(detail())); });
    return Response.json(fresh);
  });
  await settle(); await sidebarGroup(ui).querySelector(".sidebar-history-toggle").click(); await settle();
  assert.match(textOf(sidebarGroup(ui).querySelector(".sidebar-history-status")), /正在读取/);
  await ui.route({ page: "group", groupId: "one" }); await settle(); release(); await settle();
  assert.deepEqual(sidebarGroupRows(ui).map((row) => row.dataset.taskId), ["fresh-topic"]);
  assert.equal(sidebarGroup(ui).querySelector(".sidebar-history-status").hidden, true);
  await ui.route({ page: "chat" }); await sidebarGroup(ui).querySelector(".sidebar-history-toggle").click();
  await sidebarGroup(ui).querySelector(".sidebar-history-toggle").click(); await settle();
  assert.equal(reads, 2); assert.equal(sidebarGroupRows(ui)[0].dataset.taskId, "fresh-topic");
});

test("群页读取未结束就离开时仍完成该群导航历史，不替换当前聊天或留下加载状态", async () => {
  let release;
  const ui = setup(groupsSource, async (path) => path === "/api/groups" ? Response.json({ groups: [group()] })
    : new Promise((resolve) => { release = () => resolve(Response.json(detail())); }));
  await settle(); await ui.route({ page: "group", groupId: "one" }); await settle();
  await ui.route({ page: "chat" }); ui.get("main-message").value = "离开群后编辑的草稿";
  release(); await settle();
  assert.equal(sidebarGroupRows(ui)[0].dataset.taskId, "task-one");
  assert.equal(sidebarGroup(ui).querySelector(".sidebar-history-status").hidden, true);
  assert.equal(ui.get("main-message").value, "离开群后编辑的草稿");
  assert.equal(ui.text("group-title"), "正在读取群组…");
});

test("群历史读取失败可重新展开重试，归档移除条目后迟到详情不会复活导航", async () => {
  let reads = 0, release, archived = false;
  const ui = setup(groupsSource, async (path) => {
    if (path === "/api/groups") return Response.json({ groups: [{ ...group(), archived }] });
    if (++reads === 1) return Response.json({ error: "历史读取断开" }, { status: 503 });
    return new Promise((resolve) => { release = () => resolve(Response.json(detail())); });
  });
  await settle(); const entry = sidebarGroup(ui), toggle = entry.querySelector(".sidebar-history-toggle");
  await toggle.click(); await settle(); assert.match(textOf(entry.querySelector(".sidebar-history-status")), /历史读取断开/);
  await toggle.click(); await toggle.click(); await settle(); assert.equal(reads, 2);
  archived = true; await ui.document.dispatchEvent({ type: "neuma:groups-changed" }); await settle();
  assert.equal(ui.get("sidebar-group-list").children.length, 0);
  release(); await settle(); assert.equal(ui.get("sidebar-group-list").children.length, 0);
  assert.equal(vm.runInContext("taskHistories.has('one')", ui.context), false);
});

test("群页刷新同步导航任务，更多展开和已聚焦话题保持，移除任务后筛选真实回退", async () => {
  const state = detail(); state.tasks = Array.from({ length: 5 }, (_, index) => ({ id: `task-${index + 1}`, goal: `话题 ${index + 1}`, status: "complete" }));
  const ui = await readyGroup(state), entry = sidebarGroup(ui), more = entry.querySelector(".sidebar-history-show-more");
  await more.click(); const selected = sidebarGroupRows(ui).find((row) => row.dataset.taskId === "task-1");
  selected.focus(); await selected.click(); assert.equal(selectedGroupTask(ui), "task-1");
  state.tasks[0].goal = "话题一的最新名称"; await ui.get("group-refresh").click(); await settle();
  assert.equal(sidebarGroup(ui), entry); assert.equal(sidebarGroupRows(ui).length, 5);
  assert.equal(ui.document.activeElement.dataset.taskId, "task-1"); assert.match(textOf(ui.document.activeElement), /最新名称/);
  state.tasks.shift(); await ui.get("group-refresh").click(); await settle();
  assert.equal(selectedGroupTask(ui), "task-5"); assert.equal(sidebarGroupRows(ui).some((row) => row.dataset.taskId === "task-1"), false);
  assert.equal(more.hidden, true);
});

test("群历史删除菜单支持键盘和独立列表滚动关闭，取消确认不提交删除", async () => {
  const state = removableGroup(), ui = await readyGroup(state), menu = ui.get("group-history-menu"), remove = ui.get("group-history-delete");
  ui.get("group-message").value = "尚未发送的群草稿";
  const more = sidebarGroupMore(ui, "history/to-remove");
  assert.equal(more.getAttribute("aria-haspopup"), "menu"); assert.equal(more.getAttribute("aria-controls"), "group-history-menu");
  assert.match(more.getAttribute("aria-label"), /完整的待删除话题/);
  for (const [openKey, closeKey] of [["ArrowDown", "Escape"], ["ArrowUp", "Tab"]]) {
    await ui.key(more, openKey); assert.equal(menu.hidden, false); assert.equal(ui.document.activeElement, remove);
    await ui.key(remove, closeKey); assert.equal(menu.hidden, true); assert.equal(ui.document.activeElement, more);
  }
  for (const id of ["sidebar-group-list", "sidebar-scroll"]) {
    await more.click(); assert.equal(menu.hidden, false);
    await ui.get(id).dispatchEvent({ type: "scroll" }); assert.equal(menu.hidden, true);
  }
  await removeGroupHistory(ui, "history/to-remove");
  assert.equal(ui.confirmations.length, 1); assert.match(ui.confirmations[0], /完整的待删除话题/);
  assert.equal(ui.requests.some(({ settings }) => settings.method === "POST"), false);
  assert.equal(sidebarGroupRows(ui).length, 2); assert.equal(ui.get("group-message").value, "尚未发送的群草稿");
  assert.equal(selectedGroupTask(ui), "kept-conversation");
});

test("删除群历史按稳定会话移除全部执行轮次，只刷新本群并保留另一话题消息和草稿", async () => {
  const state = removableGroup(), ui = await readyGroup(state, { confirm: () => true, request(path) {
    if (!path.endsWith("/remove")) return null;
    removeGroupConversation(state, "history/to-remove");
    return Response.json({ removed: true, conversationId: "history/to-remove" });
  } });
  ui.get("group-message").value = "当前话题草稿";
  await removeGroupHistory(ui, "history/to-remove");
  const writes = ui.requests.filter(({ settings }) => settings.method === "POST");
  assert.equal(writes.length, 1); assert.equal(writes[0].path, "/api/groups/one/conversations/history%2Fto-remove/remove");
  assert.ok(JSON.parse(writes[0].settings.body).mutationId);
  assert.ok(ui.requests.slice(ui.requests.indexOf(writes[0]) + 1).some(({ path }) => path === "/api/groups/one"), "删除成功后应重新读取本群");
  assert.deepEqual(sidebarGroupRows(ui).map((row) => row.dataset.conversationId), ["kept-conversation"]);
  assert.deepEqual(copy(vm.runInContext("data.tasks.map(task => task.id)", ui.context)), ["kept-round"]);
  assert.equal(selectedGroupTask(ui), "kept-conversation"); assert.match(ui.text("group-messages"), /保留的话题/);
  assert.doesNotMatch(ui.text("group-messages"), /待删除话题|后续消息/);
  assert.equal(ui.get("group-message").value, "当前话题草稿"); assert.equal(ui.get("group-send").disabled, false);
});

test("删除当前群会话选择最新剩余话题，全部删空显示空白新对话且不发起执行", async () => {
  const state = removableGroup(), writes = [], ui = await readyGroup(state, { confirm: () => true, request(path, options) {
    if (!path.endsWith("/remove")) return null;
    writes.push(path); const id = decodeURIComponent(path.split("/").at(-2)); removeGroupConversation(state, id);
    return Response.json({ removed: true, conversationId: id });
  } });
  await sidebarGroupRows(ui).find((row) => row.dataset.conversationId === "history/to-remove").click();
  assert.equal(groupMessageRows(ui).length, 2);
  await removeGroupHistory(ui, "history/to-remove");
  assert.equal(selectedGroupTask(ui), "kept-conversation"); assert.match(ui.text("group-messages"), /保留的话题/);
  await removeGroupHistory(ui, "kept-conversation");
  assert.equal(sidebarGroupRows(ui).length, 0); assert.equal(selectedGroupTask(ui), "");
  assert.equal(groupMessageRows(ui).length, 0); assert.doesNotMatch(ui.text("group-tasks"), /待删除话题|后续消息|保留的话题/);
  assert.equal(ui.stored.get("neuma.group.selected-conversation.one"), ""); assert.equal(ui.get("group-send").disabled, false);
  assert.equal(writes.length, 2); assert.equal(ui.requests.some(({ path }) => path.endsWith("/messages")), false);
});

test("首次群消息回执丢失并删除会话后，确认删除冲突只换一次操作号，第二次断线仍能幂等重试", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "neuma-ui-deleted-message-"));
  const cards = [{ id: "analyst", name: "分析员", ready: true, revision: 1, boundaries: [] }];
  const service = new CollaborationService({ dataDir, agents: { ready: Promise.resolve(),
    capabilityCards: async () => ({ agents: cards }), activitySnapshot: async () => ({ activities: [] }) } });
  t.after(async () => { await service.close(); await rm(dataDir, { recursive: true, force: true }); });
  await service.ready; service.start = () => {};
  const { group } = await service.createGroup({ name: "回执测试群", memberIds: ["analyst"], mutationId: "create" });
  const { attachment } = await service.uploadMaterial(group.id, { name: "重试资料.txt", source: Buffer.from("需要保留的材料") });
  const writes = []; let deletedConversation;
  const ui = setup(groupsSource, async (path, options = {}) => {
    if (path === "/api/groups") return Response.json(await service.listGroups());
    if (path === `/api/groups/${group.id}`) return Response.json(await service.getGroup(group.id));
    if (path.endsWith("/preview")) return Response.json({ text: "需要保留的材料" });
    if (path.endsWith("/remove")) return Response.json(await service.removeConversation(group.id, deletedConversation, JSON.parse(options.body)));
    assert.ok(path.endsWith("/messages"), path);
    const body = JSON.parse(options.body); writes.push(body);
    let result;
    try { result = await service.postMessage(group.id, body); }
    catch (error) { return Response.json({ error: error.message, reason: error.reason }, { status: 409 }); }
    if (writes.length === 1) {
      deletedConversation = result.task.id;
      await service.store.change(group.id, (record) => { record.tasks.find((task) => task.id === result.task.id).status = "completed"; });
      throw new Error("首次发送回执中断");
    }
    if (writes.length === 3) throw new Error("重建后的发送回执中断");
    return Response.json(result);
  }, [], { confirm: () => true });
  await ui.context.list(); await ui.route({ page: "group", groupId: group.id }); await ui.context.load(group.id);
  await ui.get("group-files-open").click();
  await ui.get("group-file-list").children.find((item) => item.tagName === "BUTTON").click(); await settle();
  await ui.get("group-file-actions").children[1].click();
  await pickMention(ui, "analyst"); ui.get("group-message").value += "按原材料重新开始";
  await ui.context.send();
  assert.match(ui.text("group-error"), /首次发送回执中断/);
  await ui.context.load(group.id, { quiet: true });
  await removeGroupHistory(ui, deletedConversation, group.id);
  await ui.context.send();
  assert.equal(writes.length, 3); assert.deepEqual(writes[1], writes[0]);
  assert.notEqual(writes[2].mutationId, writes[0].mutationId);
  assert.deepEqual({ ...writes[2], mutationId: writes[0].mutationId }, writes[0]);
  assert.deepEqual(writes[2].attachmentIds, [attachment.id]); assert.equal(writes[2].mentions[0].memberId, "analyst");
  assert.match(ui.text("group-error"), /重建后的发送回执中断/);
  await ui.context.send();
  assert.equal(writes.length, 4); assert.deepEqual(writes[3], writes[2]);
  const saved = await service.getGroup(group.id);
  assert.equal(saved.tasks.length, 1); assert.equal(saved.messages.length, 1);
  assert.equal(ui.get("group-message").value, ""); assert.equal(ui.get("group-error").hidden, true);
});

test("删除无关群会话后，未知首次发送继续复用原操作号，不重放已创建的任务", async () => {
  const state = removableGroup(), writes = []; let posted;
  const ui = await readyGroup(state, { confirm: () => true, request(path, options) {
    if (path.endsWith("/messages")) {
      writes.push(JSON.parse(options.body));
      if (writes.length === 1) {
        const task = { id: "unknown-round", goal: writes[0].content, status: "completed" };
        const message = { id: "unknown-message", taskId: task.id, sender: { type: "user" }, content: task.goal };
        state.tasks.push(task); state.messages.push(message); posted = { message, task };
        throw new Error("发送回执中断");
      }
      return Response.json(posted);
    }
    if (!path.endsWith("/remove")) return null;
    removeGroupConversation(state, "history/to-remove"); return Response.json({ removed: true, conversationId: "history/to-remove" });
  } });
  await ui.get("group-new-task").click(); ui.get("group-message").value = "未知发送的独立工作";
  await ui.context.send(); await ui.context.load("one", { quiet: true });
  await removeGroupHistory(ui, "history/to-remove"); await ui.context.send();
  assert.equal(writes.length, 2); assert.deepEqual(writes[1], writes[0]);
  assert.equal(state.tasks.filter((task) => task.id === "unknown-round").length, 1);
  assert.equal(ui.get("group-message").value, ""); assert.equal(selectedGroupTask(ui), "unknown-round");
});

test("普通发送冲突保留操作号，连续删除冲突每次提交至多自动重试一次", async () => {
  const state = detail(), writes = []; let reason = "collaboration_conflict";
  const ui = await readyGroup(state, { request(path, options) {
    if (!path.endsWith("/messages")) return null;
    writes.push(JSON.parse(options.body)); return Response.json({ error: "提交被拒绝", reason }, { status: 409 });
  } });
  await ui.get("group-new-task").click(); ui.get("group-message").value = "保留这次提交";
  await ui.context.send(); await ui.context.send();
  assert.equal(writes.length, 2); assert.deepEqual(writes[1], writes[0]);
  reason = "conversation_deleted"; await ui.context.send();
  assert.equal(writes.length, 4); assert.deepEqual(writes[2], writes[0]);
  assert.notEqual(writes[3].mutationId, writes[2].mutationId);
  assert.equal(ui.get("group-message").value, "保留这次提交"); assert.match(ui.text("group-error"), /提交被拒绝/);
});

test("离开群页后迟到的删除冲突不会自动重建或向旧群再发送消息", async () => {
  const state = detail(), writes = []; let release;
  const ui = await readyGroup(state, { request(path, options) {
    if (!path.endsWith("/messages")) return null;
    writes.push(JSON.parse(options.body)); return new Promise((resolve) => { release = () => resolve(
      Response.json({ error: "原会话已删除", reason: "conversation_deleted" }, { status: 409 })); });
  } });
  await ui.get("group-new-task").click(); ui.get("group-message").value = "原群的新工作";
  const pending = ui.context.send(); await settle();
  await ui.route({ page: "group", groupId: "two" }); await settle();
  release(); await pending;
  assert.equal(writes.length, 1); assert.equal(ui.text("group-title"), "设计小组"); assert.equal(ui.get("group-error").hidden, true);
});

test("群历史删除未知结果保留记录、消息和草稿，重试复用操作并清除本群错误", async () => {
  const state = removableGroup(), writes = []; let attempts = 0;
  const ui = await readyGroup(state, { confirm: () => true, request(path, options) {
    if (!path.endsWith("/remove")) return null;
    writes.push(JSON.parse(options.body)); if (++attempts === 1) throw new Error("群历史删除响应中断");
    removeGroupConversation(state, "history/to-remove"); return Response.json({ removed: true, conversationId: "history/to-remove" });
  } });
  await sidebarGroupRows(ui).find((row) => row.dataset.conversationId === "history/to-remove").click();
  ui.get("group-message").value = "删除失败仍保留的草稿";
  await removeGroupHistory(ui, "history/to-remove");
  assert.equal(sidebarGroupRows(ui).length, 2); assert.equal(selectedGroupTask(ui), "history/to-remove");
  assert.equal(groupMessageRows(ui).length, 2); assert.equal(ui.get("group-message").value, "删除失败仍保留的草稿");
  assert.match(textOf(sidebarGroup(ui).querySelector(".sidebar-history-status")), /群历史删除响应中断/);
  assert.equal(ui.get("group-send").disabled, false);
  await removeGroupHistory(ui, "history/to-remove");
  assert.deepEqual(writes[1], writes[0]); assert.equal(sidebarGroupRows(ui).length, 1);
  assert.equal(sidebarGroup(ui).querySelector(".sidebar-history-status").hidden, true);
  assert.equal(selectedGroupTask(ui), "kept-conversation");
});

test("群历史发送和删除进行中阻止重复删除，同组草稿与提交状态保持一致", async () => {
  const state = removableGroup(), writes = []; let releaseSend, releaseRemoval;
  const ui = await readyGroup(state, { confirm: () => true, request(path, options) {
    if (options.method !== "POST") return null;
    writes.push(path);
    if (path.endsWith("/messages")) return new Promise((resolve) => { releaseSend = () => resolve(Response.json({ message: { id: "sent" }, task: state.tasks.at(-1) })); });
    if (path.endsWith("/remove")) return new Promise((resolve) => { releaseRemoval = () => {
      removeGroupConversation(state, "history/to-remove"); resolve(Response.json({ removed: true, conversationId: "history/to-remove" }));
    }; });
    throw new Error(`意外写请求：${path}`);
  } });
  ui.get("group-message").value = "先发送的消息"; await ui.submit("group-chat-form"); await settle();
  assert.equal(typeof releaseSend, "function");
  await removeGroupHistory(ui, "history/to-remove");
  assert.equal(ui.confirmations.length, 0); releaseSend(); await settle();
  ui.get("group-message").value = "删除期间不能重复发送的草稿";
  await sidebarGroupMore(ui, "history/to-remove").click(); const removing = ui.get("group-history-delete").click(); await settle();
  assert.equal(typeof releaseRemoval, "function"); assert.equal(ui.get("group-send").disabled, true);
  await sidebarGroupMore(ui, "history/to-remove").click(); await ui.get("group-history-delete").click();
  await ui.submit("group-chat-form"); await settle();
  assert.equal(writes.filter((path) => path.endsWith("/remove")).length, 1); assert.equal(writes.filter((path) => path.endsWith("/messages")).length, 1);
  assert.equal(ui.get("group-message").value, "删除期间不能重复发送的草稿");
  releaseRemoval(); await removing; await settle(); assert.equal(ui.get("group-send").disabled, false);
});

test("删除群历史期间切到另一群，迟到确认只更新原群导航且保留当前界面与各群草稿", async () => {
  const first = removableGroup(), second = detail("two", "设计小组"); second.tasks[0].status = "completed";
  let release; const writes = [], ui = setup(groupsSource, async (path, options = {}) => {
    if (path.endsWith("/remove")) { writes.push(path); return new Promise((resolve) => { release = () => {
      removeGroupConversation(first, "history/to-remove"); resolve(Response.json({ removed: true, conversationId: "history/to-remove" }));
    }; }); }
    return Response.json(path === "/api/groups" ? { groups: [first.group, second.group] } : path === "/api/groups/two" ? second : first);
  }, [], { confirm: () => true });
  await settle(); await ui.route({ page: "group", groupId: "one" }); await settle();
  ui.get("group-message").value = "原群尚未发送的草稿";
  await sidebarGroupMore(ui, "history/to-remove").click(); const removing = ui.get("group-history-delete").click(); await settle();
  await ui.route({ page: "group", groupId: "two" }); await settle(); ui.get("group-message").value = "另一群正在编辑的草稿";
  assert.equal(ui.get("group-send").disabled, false); release(); await removing; await settle();
  assert.equal(ui.text("group-title"), "设计小组"); assert.match(ui.text("group-messages"), /设计小组的初稿/);
  assert.equal(ui.get("group-message").value, "另一群正在编辑的草稿"); assert.equal(selectedGroupTask(ui), "task-one");
  assert.equal(ui.get("group-error").hidden, true); assert.equal(sidebarGroupRows(ui).length, 1);
  assert.equal(sidebarGroupRows(ui, "two").length, 1); assert.equal(writes.length, 1);
  await ui.route({ page: "group", groupId: "one" }); await settle(); assert.equal(ui.get("group-message").value, "原群尚未发送的草稿");
  await ui.route({ page: "group", groupId: "two" }); await settle(); assert.equal(ui.get("group-message").value, "另一群正在编辑的草稿");
});

test("群历史删除后迟到的旧详情不能复活任何已删除轮次或覆盖当前会话", async () => {
  const state = removableGroup(), original = copy(state); let holdRead = false, release;
  const ui = await readyGroup(state, { confirm: () => true, request(path) {
    if (path.endsWith("/remove")) {
      removeGroupConversation(state, "history/to-remove"); return Response.json({ removed: true, conversationId: "history/to-remove" });
    }
    if (path === "/api/groups/one" && holdRead) { holdRead = false; return new Promise((resolve) => { release = () => resolve(Response.json(original)); }); }
    return null;
  } });
  holdRead = true; const oldLoad = vm.runInContext("load('one', { quiet: true })", ui.context); await settle();
  assert.equal(typeof release, "function"); await removeGroupHistory(ui, "history/to-remove");
  ui.get("group-message").value = "确认删除后继续编辑";
  release(); await oldLoad; await settle();
  assert.deepEqual(sidebarGroupRows(ui).map((row) => row.dataset.conversationId), ["kept-conversation"]);
  assert.deepEqual(copy(vm.runInContext("data.tasks.map(task => task.id)", ui.context)), ["kept-round"]);
  assert.equal(selectedGroupTask(ui), "kept-conversation"); assert.match(ui.text("group-messages"), /保留的话题/);
  assert.doesNotMatch(ui.text("group-messages"), /待删除话题|后续消息/); assert.equal(ui.get("group-message").value, "确认删除后继续编辑");
});

test("群成员自主协作、能力和任务分开显示，离开群页不会取消正在执行的任务", async () => {
  const requests = [], ui = setup(groupsSource, async (path) => {
    requests.push(path);
    return Response.json(path === "/api/groups" ? { groups: [group()] } : path.endsWith("events?after=1") ? { events: [], lastSequence: 1 } : detail());
  });
  await settle(); await ui.route({ page: "group", groupId: "one" }); await settle();
  assert.match(ui.text("group-members"), /写作助手/); assert.match(ui.text("group-members"), /检查助手/);
  assert.match(ui.text("group-tasks"), /整理初稿/);
  assert.equal(ui.get("group-mention-popup").getAttribute("aria-hidden"), "true");
  assert.equal(ui.text("group-compose-status"), "正在处理你的消息…"); assert.equal(ui.get("group-compose-status").hidden, false);
  assert.equal(ui.get("group-members").children.length, 2);
  ui.get("group-message").value = "留在这个群的草稿";
  await ui.route({ page: "chat" }); await settle();
  assert.equal(ui.timers.size, 0); assert.equal(requests.some((path) => path.includes("cancel")), false);
  assert.equal(ui.text("group-compose-status"), ""); assert.equal(ui.get("group-compose-status").hidden, true);
  await ui.route({ page: "group", groupId: "one" }); await settle();
  assert.equal(ui.get("group-message").value, "留在这个群的草稿");
});

test("群输入区只在真实运行状态显示轻量处理反馈，等待补充和终结后停止提示", async () => {
  const state = detail(), ui = await readyGroup(state, { request(path) {
    return path.includes("/events?") ? Response.json({ events: [{ seq: state.lastSequence }], lastSequence: state.lastSequence }) : null;
  } });
  for (const status of ["queued", "running", "negotiating", "waiting", "needs_input", "completed", "complete", "partial", "failed", "cancelled", "interrupted", "unknown"]) {
    state.tasks[0].status = status; state.lastSequence++;
    [...ui.timers.values()][0](); await settle();
    const processing = ["queued", "running", "negotiating", "waiting"].includes(status);
    assert.equal(ui.text("group-compose-status"), processing ? "正在处理你的消息…" : "", status);
    assert.equal(ui.get("group-compose-status").hidden, !processing, status);
    assert.equal(ui.get("group-message").disabled, false, status);
  }
  state.group.activeTaskId = "missing-task"; state.tasks[0].status = "running";
  await ui.get("group-refresh").click(); await settle();
  assert.equal(ui.text("group-compose-status"), "正在处理你的消息…"); assert.equal(ui.get("group-compose-status").hidden, false);
});

test("群处理反馈只对应当前会话，其他会话后台执行不显示到旧完成记录", async () => {
  const state = detail(); state.tasks[0].status = "completed";
  state.tasks.push({ id: "task-two", goal: "后台新任务", status: "running" }); state.group.activeTaskId = "task-two";
  const ui = await readyGroup(state);
  await sidebarGroupRows(ui).find((row) => row.dataset.taskId === "task-one").click();
  assert.equal(selectedGroupTask(ui), "task-one"); assert.equal(ui.text("group-compose-status"), "");
  state.tasks[0].status = "needs_input";
  await ui.get("group-refresh").click(); await settle();
  assert.equal(ui.text("group-compose-status"), ""); assert.equal(ui.get("group-compose-status").hidden, true);
  state.tasks[0].status = "waiting"; state.tasks[1].status = "completed";
  await ui.get("group-refresh").click(); await settle();
  assert.equal(ui.text("group-compose-status"), "正在处理你的消息…");
  state.tasks[0].status = "completed";
  await ui.get("group-refresh").click(); await settle();
  assert.equal(ui.text("group-compose-status"), ""); assert.equal(ui.get("group-compose-status").hidden, true);
});

test("群提交与归档提示优先，切群和离页清除旧群反馈，迟到提交不会在新群残留", async () => {
  const state = detail(), second = detail("two", "另一个群"); second.tasks[0].status = "completed";
  let release;
  const ui = await readyGroup(state, { request(path) {
    if (path.endsWith("/messages")) return new Promise((resolve) => { release = () => resolve(Response.json({ message: { id: "sent" } })); });
    if (path === "/api/groups/two") return Response.json(second);
    return null;
  } });
  assert.equal(ui.text("group-compose-status"), "正在处理你的消息…");
  ui.get("group-message").value = "补充给第一个群"; await ui.submit("group-chat-form"); await settle();
  assert.equal(ui.text("group-compose-status"), "正在提交消息…");
  await ui.route({ page: "chat" });
  assert.equal(ui.text("group-compose-status"), ""); assert.equal(ui.get("group-compose-status").hidden, true);
  await ui.route({ page: "group", groupId: "two" });
  assert.equal(ui.text("group-compose-status"), ""); assert.equal(ui.get("group-compose-status").hidden, true);
  await settle(); assert.equal(ui.text("group-compose-status"), "");
  release(); await settle();
  assert.equal(ui.text("group-compose-status"), ""); assert.equal(ui.get("group-compose-status").hidden, true);
  state.group.archived = true; await ui.route({ page: "group", groupId: "one" }); await settle();
  assert.match(ui.text("group-compose-status"), /群已归档/); assert.doesNotMatch(ui.text("group-compose-status"), /正在处理/);
  assert.equal(ui.get("group-compose-status").hidden, false);
});

test("对话日期使用持久时间的本地完整年月日和规范 ISO，拒绝缺失或无效时间", () => {
  const value = "2026-10-12T23:30:00+08:00", date = new Date(value);
  assert.deepEqual(conversationDate(value), { label: date.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" }), dateTime: date.toISOString() });
  for (const value of [undefined, null, "", " ", "not-a-date", "2026-13-40T00:00:00Z", 0, new Date()]) assert.equal(conversationDate(value), null);
});

test("群头部日期在首条气泡前，刷新只保留一个且不修改消息数据", async () => {
  const state = detail(), createdAt = "2026-10-12T02:00:00.000Z";
  state.messages[0].createdAt = createdAt;
  state.messages.push({ ...state.messages[0], id: "message-two", seq: 2, createdAt: "2026-10-13T02:00:00.000Z", content: "第二天的回复" });
  state.lastSequence = 2;
  const saved = copy(state.messages), ui = await readyGroup(state), expected = conversationDate(createdAt);
  for (let index = 0; index < 3; index++) {
    const children = ui.get("group-messages").children;
    assert.equal(children[0].tagName, "TIME"); assert.equal(children[0].className, "conversation-date");
    assert.equal(children[0].textContent, expected.label); assert.equal(children[0].dateTime, expected.dateTime);
    assert.equal(children.filter((node) => node.className === "conversation-date").length, 1);
    assert.deepEqual(groupMessageRows(ui).map((row) => row.dataset.messageId), ["message-one", "message-two"]);
    if (index < 2) { await ui.get("group-refresh").click(); await settle(); }
  }
  assert.deepEqual(state.messages, saved);
});

test("群会话日期跟随首条可见消息，默认最近会话且群标题保留选择", async () => {
  const state = detail(), first = "2026-10-11T12:00:00.000Z", second = "2026-10-12T12:00:00.000Z";
  state.messages[0].createdAt = first;
  state.messages.push({ ...state.messages[0], id: "message-two", seq: 2, taskId: "task-two", createdAt: second, content: "另一项任务" });
  state.tasks.push({ id: "task-two", goal: "另一项任务", status: "completed" }); state.lastSequence = 2;
  const ui = await readyGroup(state);
  assert.equal(ui.get("group-messages").children[0].dateTime, conversationDate(second).dateTime);
  await sidebarGroupRows(ui).find((row) => row.dataset.taskId === "task-one").click();
  assert.equal(ui.get("group-messages").children[0].dateTime, conversationDate(first).dateTime);
  await sidebarGroupRows(ui).find((row) => row.dataset.taskId === "task-two").click();
  assert.equal(ui.get("group-messages").children[0].dateTime, conversationDate(second).dateTime);
  assert.deepEqual(groupMessageRows(ui).map((row) => row.dataset.messageId), ["message-two"]);
  await ui.get("group-refresh").click(); await settle();
  assert.equal(ui.get("group-messages").children.filter((node) => node.className === "conversation-date").length, 1);
  await sidebarGroup(ui).querySelector(".sidebar-group-link").click();
  assert.equal(ui.get("group-messages").children[0].dateTime, conversationDate(second).dateTime);
  await sidebarGroup(ui).querySelector(".sidebar-group-link").click();
  assert.equal(ui.get("group-messages").children[0].dateTime, conversationDate(second).dateTime);
  await sidebarGroupRows(ui).find((row) => row.dataset.taskId === "task-one").click();
  assert.equal(ui.get("group-messages").children[0].dateTime, conversationDate(first).dateTime);
});

test("群首条可见消息缺失或无效时间及空对话均不显示伪造日期", async () => {
  for (const createdAt of [undefined, "invalid"]) {
    const state = detail(); state.group.createdAt = "2026-10-10T02:00:00.000Z"; state.messages[0].createdAt = createdAt;
    state.messages.push({ ...state.messages[0], id: "later", seq: 2, createdAt: "2026-10-12T02:00:00.000Z" });
    const ui = await readyGroup(state);
    assert.equal(ui.get("group-messages").children.some((node) => node.className === "conversation-date"), false);
    assert.equal(ui.get("group-messages").children[0].dataset.messageId, "message-one");
  }
  const state = detail(); state.messages = []; const ui = await readyGroup(state);
  assert.equal(ui.get("group-messages").children.some((node) => node.className === "conversation-date"), false);
  assert.equal(ui.get("group-messages").children[0].className, "collaboration-empty");
});

test("群消息隐藏明确内部记录，日期从首条公开消息开始且不修改原记录", async () => {
  const state = detail(), base = state.messages[0], createdAt = "2026-10-12T02:00:00.000Z";
  state.messages = [
    ...["negotiation", "coordination", "member_result"].map((kind, index) => ({ ...base, id: `internal-${kind}`, seq: index + 1,
      visibility: "internal", kind, createdAt: "2026-10-11T02:00:00.000Z", content: `仅供成员内部读取 ${kind}` })),
    { ...base, id: "public-user", seq: 4, sender: { type: "user", id: "person", name: "用户" },
      visibility: "public", kind: "reply", content: "你好", createdAt },
    { ...base, id: "public-reply", seq: 5, visibility: "public", kind: "reply", content: "你好，我在这里。", createdAt: "2026-10-13T02:00:00.000Z" },
  ];
  state.lastSequence = 5;
  const saved = copy(state.messages), ui = await readyGroup(state);
  const raw = Object.freeze(state.messages.map((message) => Object.freeze(message)));
  ui.context.renderMessages(ui.get("group-messages"), raw, "task-one", state.members, state.tasks);
  assert.deepEqual(groupMessageRows(ui).map((row) => row.dataset.messageId), ["public-user", "public-reply"]);
  assert.equal(ui.get("group-messages").children[0].dateTime, conversationDate(createdAt).dateTime);
  assert.equal(ui.get("group-messages").children.filter((item) => item.className === "conversation-date").length, 1);
  assert.doesNotMatch(ui.text("group-messages"), /仅供成员内部读取/);
  assert.equal(ui.renderedReplies.some(({ content }) => content.includes("仅供成员内部读取")), false);
  assert.deepEqual(raw, saved); assert.deepEqual(state.messages, saved);
});

test("群筛选只剩内部消息时保持空态，刷新不产生日期或空气泡", async () => {
  const state = detail();
  state.messages[0] = { ...state.messages[0], visibility: "internal", kind: "negotiation", content: "内部认领", createdAt: "2026-10-11T02:00:00.000Z" };
  state.messages.push({ ...state.messages[0], id: "other-public", seq: 2, visibility: "public", kind: "delivery",
    taskId: "task-two", content: "已整理另一份材料。", createdAt: "2026-10-12T02:00:00.000Z" });
  state.tasks.push({ id: "task-two", goal: "另一项任务", status: "completed" }); state.lastSequence = 2;
  const ui = await readyGroup(state);
  await sidebarGroupRows(ui).find((row) => row.dataset.taskId === "task-one").click();
  for (let index = 0; index < 2; index++) {
    const children = ui.get("group-messages").children;
    assert.equal(children.length, 1); assert.equal(children[0].className, "collaboration-empty");
    assert.equal(groupMessageRows(ui).length, 0);
    assert.doesNotMatch(ui.text("group-messages"), /内部认领|已整理另一份材料/);
    if (!index) { await ui.get("group-refresh").click(); await settle(); }
  }
  state.messages = [state.messages[0]];
  ui.context.renderMessages(ui.get("group-messages"), state.messages);
  assert.equal(ui.get("group-messages").children.length, 1);
  assert.equal(ui.get("group-messages").children[0].className, "collaboration-empty");
  ui.context.renderMessages(ui.get("group-messages"), []);
  assert.equal(ui.get("group-messages").children.length, 1);
  assert.equal(ui.get("group-messages").children[0].className, "collaboration-empty");
});

test("群公开结果和旧消息保留原文、成员身份、提及、文件链接及真实失败提示", async () => {
  const state = detail(), base = state.messages[0];
  state.members[0].name = "用户访谈助手";
  state.messages = [
    ...["reply", "delivery", "clarification", "status"].map((kind, index) => ({ ...base, id: `public-${kind}`, seq: index + 1,
      visibility: "public", kind, sender: { type: "agent", id: "writer", name: state.members[0].name },
      recipientId: "reviewer", content: `我已整理用户访谈结果，代码包含 negotiation / coordination / member_result (${kind})。` })),
    { ...base, id: "legacy", seq: 5, content: "我已核对旧版用户记录。" },
  ];
  Object.assign(state.messages[1], { attachments: [{ id: "report", name: "用户访谈结果.md" }], status: "failed",
    actions: [{ href: "#group/one", label: "查看已保存成果" }] });
  state.lastSequence = 5;
  const ui = await readyGroup(state, { richText(container, content, document) {
    const paragraph = document.createElement("p"), link = document.createElement("a");
    paragraph.append(document.createTextNode(content)); link.textContent = "下载报告";
    link.href = "/api/groups/one/artifacts/report/download"; container.replaceChildren(paragraph, link);
  } });
  const rows = groupMessageRows(ui);
  assert.deepEqual(rows.map((row) => row.dataset.messageId), state.messages.map((message) => message.id));
  for (const [index, row] of rows.entries()) {
    const body = row.children.find(isBubble);
    assert.ok(textOf(body).includes(state.messages[index].content));
    assert.equal(body.querySelector("a").href, "/api/groups/one/artifacts/report/download");
    if (index < 4) {
      assert.equal(row.querySelector(".group-message-sender").textContent, "用户访谈助手");
      assert.equal(body.querySelector(".group-message-mention").getAttribute("aria-label"), "@检查助手");
    }
  }
  assert.match(textOf(rows[1]), /▧ 用户访谈结果\.md/); assert.match(textOf(rows[1]), /失败/);
  assert.equal(rows[1].children.find((item) => item.className === "collaboration-links" && item.children.some((child) => child.tagName === "A"))
    .children[0].href, "#group/one");
});

test("群 Agent 气泡显示静态头像、名称及首句前的接收者，用户气泡保持原文", async () => {
  const state = detail(), createdAt = "2026-10-12T02:00:00.000Z";
  state.members[0].profile = { icon: "star:4:1" }; state.members[1].profile = { icon: "star:0:3" };
  state.messages[0] = { ...state.messages[0], recipientId: "reviewer", createdAt };
  state.messages.push({ id: "message-two", seq: 2, sender: { type: "user", id: "user", name: "用户" },
    content: "请检查写作助手的初稿", recipientId: "writer", taskId: "task-one", status: "complete", createdAt });
  state.lastSequence = 2;
  const ui = await readyGroup(state, { richText(container, content, document) {
    const paragraph = document.createElement("p"); paragraph.append(document.createTextNode(content)); container.replaceChildren(paragraph);
  } });
  const rows = groupMessageRows(ui);
  assert.equal(rows.length, 2);
  for (const [index, role, sender, recipient] of [[0, "assistant", "写作助手", "检查助手"], [1, "user", "你", "写作助手"]]) {
    const row = rows[index], body = row.children.find(isBubble);
    assert.equal(row.className, `message ${role}`); assert.equal(row.classList.contains("group-agent-message"), index === 0);
    assert.equal(row.getAttribute("role"), "group");
    assert.equal(row.getAttribute("aria-label"), `${sender}发送的消息，${index === 0 ? "提及" : "定向发送给"}${recipient}`);
    assert.equal(row.getAttribute("title"), `${sender}${index === 0 ? " · @" : " → "}${recipient}`);
    assert.equal(row.querySelectorAll("*").some((item) => item.className.startsWith("collaboration-message-") || item.tagName === "TIME"), false);
    if (index === 0) {
      const avatar = row.children.find((child) => child.classList.contains("group-message-avatar")), name = row.children.find((child) => child.classList.contains("group-message-sender"));
      assert.equal(avatar.getAttribute("aria-hidden"), "true"); assert.equal(avatar.dataset.avatarIcon, "star:4:1");
      assert.equal(avatar.children[0].dataset.avatarMotion, "false"); assert.equal(name.textContent, sender); assert.equal(name.dataset.avatarColor, "blue");
      assert.ok(row.children.indexOf(name) < row.children.indexOf(body));
      const paragraph = body.firstElementChild, mention = paragraph.firstElementChild;
      assert.equal(paragraph.tagName, "P"); assert.equal(paragraph.childNodes[0], mention); assert.equal(mention.classList.contains("group-message-mention"), true);
      assert.equal(mention.getAttribute("aria-label"), `@${recipient}`); assert.equal(mention.dataset.avatarColor, "purple");
      assert.equal(mention.querySelector(".group-mention-avatar").dataset.avatarIcon, "star:0:3");
      assert.equal(mention.querySelector(".group-mention-avatar").children[0].dataset.avatarMotion, "false");
      assert.match(textOf(mention.querySelector(".group-mention-name")), /检查助手/);
      assert.ok(textOf(paragraph).endsWith(state.messages[index].content));
      assert.equal(paragraph.childNodes.at(-1).textContent, state.messages[index].content);
    } else {
      assert.equal(body.textContent, state.messages[index].content); assert.equal(textOf(row), state.messages[index].content);
      assert.equal(row.querySelector(".group-message-avatar"), undefined); assert.equal(row.querySelector(".group-message-sender"), undefined);
      assert.equal(body.querySelector(".group-message-mention"), undefined);
    }
  }
  assert.match(ui.text("group-members"), /写作助手/); assert.match(ui.text("group-members"), /检查助手/);
});

test("结构化群提及复用星头像名称，去掉同目标前置 @ 和重复称呼，保留正文与其他名字", async () => {
  const state = detail(), base = state.messages[0];
  state.members[1].profile = { icon: "star:0:3" };
  state.messages = [
    { ...base, recipientId: "reviewer", content: "@检查助手 检查助手，用户访谈里的写作助手名字和 `@检查助手` 代码保持原样。" },
    { ...base, id: "different-prefix", recipientId: "reviewer", content: "@写作助手 写作助手，请保留这个称呼。" },
    { ...base, id: "mention-only", recipientId: "reviewer", content: "@检查助手" },
  ];
  const original = copy(state.messages), ui = await readyGroup(state, { richText(container, content, document) {
    const paragraph = document.createElement("p"); paragraph.append(document.createTextNode(content)); container.replaceChildren(paragraph);
  } });
  const [first, other, only] = groupMessageRows(ui).map((row) => row.children.find(isBubble));
  const mention = first.firstElementChild.firstElementChild;
  assert.equal(mention.querySelector(".group-mention-name").textContent, "检查助手");
  assert.equal(mention.querySelector(".group-mention-avatar").dataset.avatarIcon, "star:0:3");
  assert.equal(mention.dataset.avatarColor, "purple");
  assert.equal(first.firstElementChild.childNodes.at(-1).textContent, "用户访谈里的写作助手名字和 `@检查助手` 代码保持原样。");
  assert.equal(first.querySelectorAll(".group-message-mention").length, 1);
  assert.equal(other.firstElementChild.childNodes.at(-1).textContent, state.messages[1].content);
  assert.equal(other.firstElementChild.firstElementChild.dataset.agentId, "reviewer");
  assert.equal(only.hidden, false); assert.equal(only.firstElementChild.firstElementChild.dataset.agentId, "reviewer");
  assert.equal(textOf(only).trim(), "检查助手");
  assert.deepEqual(state.messages, original);
});

test("旧 Agent 消息开头准确 @ 唯一成员时恢复既有提及样式，不伪称实际定向发送", async () => {
  const state = detail(), base = state.messages[0], departed = { id: "former-researcher", name: "离群资料助手" };
  state.tasks[0].participants = [...copy(state.members), departed];
  state.tasks.push({ id: "unrelated-task", goal: "其他会话", status: "completed", participants: [{ id: "outside", name: "检查助手" }] });
  state.messages = [
    { ...base, content: "@检查助手 检查助手，请核对第一句话。" },
    { ...base, id: "departed-mention", content: "@离群资料助手，资料已整理好。" },
  ];
  const ui = await readyGroup(state, { richText(container, content, document) {
    const paragraph = document.createElement("p"); paragraph.append(document.createTextNode(content)); container.replaceChildren(paragraph);
  } });
  ui.context.renderMessages(ui.get("group-messages"), state.messages, "task-one", state.members, state.tasks);
  const rows = groupMessageRows(ui), [current, former] = rows.map((row) => row.children.find(isBubble));
  assert.equal(current.firstElementChild.firstElementChild.dataset.agentId, "reviewer");
  assert.equal(current.firstElementChild.childNodes.at(-1).textContent, "请核对第一句话。");
  assert.equal(rows[0].getAttribute("aria-label"), "写作助手发送的消息，提及检查助手");
  assert.equal(rows[0].getAttribute("title"), "写作助手 · @检查助手");
  assert.equal(former.firstElementChild.firstElementChild.dataset.agentId, departed.id);
  assert.equal(former.firstElementChild.childNodes.at(-1).textContent, "资料已整理好。");
});

test("前置提及不猜测同名或未知成员，不解析代码链接、正文名字或非 Agent 消息", async () => {
  const state = detail(), base = state.messages[0];
  state.members.push(member("same-name", "检查助手"), member("main", "主助手"));
  state.messages = [
    ...["@检查助手 请核对", "@陌生成员 请核对", "`@写作助手` 是代码", "[@写作助手](https://example.test) 是链接",
      "```text\n@写作助手\n```", "@写作助手整理的报告", "正文提到 @写作助手", "@主助手 请处理"].map((content, index) => ({ ...base, id: `literal-${index}`, content })),
    { ...base, id: "unknown-id", recipientId: "missing", content: "@写作助手 请核对" },
    { ...base, id: "main-id", recipientId: "main", content: "@写作助手 请核对" },
    { ...base, id: "user-mention", sender: { type: "user", id: "person" }, mentionIds: ["writer"], content: "@写作助手 请核对" },
    { ...base, id: "system-mention", sender: { type: "system", name: "系统" }, content: "@写作助手 请核对" },
  ];
  const ui = await readyGroup(state), rows = groupMessageRows(ui);
  for (const [index, row] of rows.entries()) {
    assert.equal(row.querySelector(".group-message-mention"), undefined);
    assert.equal(row.children.find(isBubble).textContent, state.messages[index].content);
  }
});

test("前置提及剥离后继续交给富文本渲染，首段格式、代码与后续链接节点保持", async () => {
  const state = detail(); let original;
  state.messages[0].content = "@检查助手 检查助手，请看 **初稿** 与 `@检查助手`。\n\n[参考材料](https://example.test/fixture)";
  const expected = "请看 **初稿** 与 `@检查助手`。\n\n[参考材料](https://example.test/fixture)";
  const ui = await readyGroup(state, { richText(container, content, document) {
    assert.equal(content, expected);
    const paragraph = document.createElement("p"), bold = document.createElement("strong"), code = document.createElement("code"), link = document.createElement("a");
    bold.textContent = "初稿"; code.textContent = "@检查助手"; link.textContent = "参考材料"; link.href = "https://example.test/fixture";
    paragraph.append(document.createTextNode("请看 "), bold, document.createTextNode(" 与 "), code, document.createTextNode("。"));
    container.replaceChildren(paragraph, link); original = { paragraph, bold, code, link };
  } });
  const body = groupMessageRows(ui)[0].children.find(isBubble);
  assert.equal(body.firstElementChild, original.paragraph);
  assert.equal(original.paragraph.firstElementChild.classList.contains("group-message-mention"), true);
  assert.equal(original.paragraph.querySelector("strong"), original.bold); assert.equal(original.paragraph.querySelector("code"), original.code);
  assert.equal(body.children[1], original.link); assert.equal(original.link.href, "https://example.test/fixture");
  assert.equal(original.code.textContent, "@检查助手");
});

test("群 Agent 身份使用当前头像与历史名称，已移除发送者和接收者按持久身份回退", async () => {
  const state = detail(), oldAgent = { type: "agent", id: "former-writer", name: "历史写手" };
  state.members[0].name = "新版写作助手"; state.members[0].profile = { icon: "star:2:7" };
  state.messages = [
    { ...state.messages[0], sender: { type: "agent", id: "writer", name: "旧版写作助手" }, recipientId: oldAgent.id, content: "请核对旧稿" },
    { ...state.messages[0], id: "former", seq: 2, sender: oldAgent, taskId: "historical-task", content: "历史写手留下的意见" },
  ];
  const ui = await readyGroup(state);
  ui.context.renderMessages(ui.get("group-messages"), state.messages, "", state.members, state.tasks);
  const [current, historical] = groupMessageRows(ui), expected = resolveAgentAvatar(oldAgent);
  assert.equal(current.querySelector(".group-message-sender").textContent, "旧版写作助手");
  assert.equal(current.querySelector(".group-message-avatar").dataset.avatarIcon, "star:2:7");
  assert.equal(current.querySelector(".group-message-sender").dataset.avatarColor, "rose");
  const mention = current.querySelector(".group-message-mention");
  assert.equal(mention.getAttribute("aria-label"), "@历史写手"); assert.equal(mention.dataset.agentId, oldAgent.id);
  assert.equal(current.getAttribute("aria-label"), "旧版写作助手发送的消息，提及历史写手");
  assert.equal(current.getAttribute("title"), "旧版写作助手 · @历史写手");
  assert.equal(mention.querySelector(".group-mention-avatar").dataset.avatarIcon, expected.icon);
  assert.equal(mention.dataset.avatarColor, expected.color);
  assert.equal(historical.querySelector(".group-message-sender").textContent, oldAgent.name);
  assert.equal(historical.querySelector(".group-message-avatar").dataset.avatarIcon, expected.icon);
  assert.equal(historical.querySelector(".group-message-avatar").children[0].dataset.avatarMotion, "false");
  assert.equal(historical.querySelector(".group-message-sender").dataset.avatarColor, expected.color);
  await sidebarGroupRows(ui).find((row) => row.dataset.taskId === "task-one").click();
  assert.equal(groupMessageRows(ui).length, 1);
  assert.equal(groupMessageRows(ui)[0].querySelector(".group-message-mention").getAttribute("aria-label"), "@历史写手");
});

test("离群且从未发言的接收者从对应任务参与者恢复，不串用其他任务或主助手身份", async () => {
  const state = detail(), departed = { id: "former-researcher", name: "离群资料助手" }, base = state.messages[0];
  state.tasks[0].participants = [departed, { id: "main", name: "伪成员主助手" }];
  state.tasks.push({ id: "other-task", goal: "另一个任务", status: "completed", participants: [
    { id: departed.id, name: "其他任务里的名称" }, { id: "unrelated-agent", name: "不属于本轮的助手" },
  ] });
  state.messages = [{ ...base, recipientId: departed.id, content: "请核对这一句话" },
    { ...base, id: "wrong-task", recipientId: "unrelated-agent" }, { ...base, id: "to-main", recipientId: "main" }];
  const ui = await readyGroup(state, { richText(container, content, document) {
    const paragraph = document.createElement("p"); paragraph.append(document.createTextNode(content)); container.replaceChildren(paragraph);
  } });
  await sidebarGroupRows(ui).find((row) => row.dataset.taskId === "task-one").click();
  const [row, unrelated, main] = groupMessageRows(ui), paragraph = row.children.find(isBubble).firstElementChild,
    mention = paragraph.firstElementChild, expected = resolveAgentAvatar(departed);
  assert.equal(paragraph.childNodes[0], mention); assert.equal(paragraph.childNodes.at(-1).textContent, "请核对这一句话");
  assert.equal(mention.getAttribute("aria-label"), "@离群资料助手"); assert.equal(mention.dataset.agentId, departed.id);
  assert.equal(mention.querySelector(".group-mention-name").textContent, departed.name);
  assert.equal(mention.querySelector(".group-mention-avatar").dataset.avatarIcon, expected.icon);
  assert.equal(mention.querySelector(".group-mention-avatar").children[0].dataset.avatarMotion, "false");
  assert.equal(mention.dataset.avatarColor, expected.color);
  assert.equal(row.getAttribute("aria-label"), "写作助手发送的消息，提及离群资料助手");
  assert.equal(row.getAttribute("title"), "写作助手 · @离群资料助手");
  assert.equal(unrelated.querySelector(".group-message-mention"), undefined); assert.equal(main.querySelector(".group-message-mention"), undefined);
});

test("只有群 Agent 间已知定向消息显示接收者，用户、系统和未知身份不伪造头像或提及", async () => {
  const state = detail(), base = state.messages[0];
  state.messages = [
    { ...base, id: "unknown-target", recipientId: "missing-agent" },
    { ...base, id: "to-user", recipientId: "person" },
    { ...base, id: "user", sender: { type: "user", id: "person", name: "用户" }, recipientId: "writer", content: "用户原文" },
    { ...base, id: "system", sender: { type: "system", name: "系统通知" }, recipientId: "writer", content: "系统原文" },
    { ...base, id: "untyped", sender: { id: "writer", name: "未标记身份" }, recipientId: "reviewer", content: "未知身份原文" },
  ];
  const ui = await readyGroup(state), rows = groupMessageRows(ui);
  for (const [index, row] of rows.entries()) {
    assert.equal(row.querySelector(".group-message-mention"), undefined);
    assert.equal(row.classList.contains("group-agent-message"), index < 2);
    if (index >= 2) {
      assert.equal(row.querySelector(".group-message-avatar"), undefined); assert.equal(row.querySelector(".group-message-sender"), undefined);
      assert.equal(row.children.find(isBubble).textContent, state.messages[index].content);
    }
  }
});

test("群 @ 接收者插入首段开头且保留段内格式、链接和后续富文本块", async () => {
  const state = detail(); state.messages[0].recipientId = "reviewer"; let original;
  const ui = await readyGroup(state, { richText(container, content, document) {
    const paragraph = document.createElement("p"), bold = document.createElement("strong"), link = document.createElement("a"), list = document.createElement("ul");
    bold.textContent = "初稿"; link.textContent = "参考材料"; link.href = "https://example.test/fixture";
    paragraph.append(document.createTextNode("请核对"), bold, document.createTextNode("及"), link); list.textContent = "保留的列表项";
    container.replaceChildren(paragraph, list); original = { paragraph, bold, link, list };
  } });
  const body = groupMessageRows(ui)[0].children.find(isBubble), mention = body.querySelector(".group-message-mention");
  assert.equal(body.children[0], original.paragraph); assert.equal(body.children[1], original.list);
  assert.equal(original.paragraph.childNodes[0], mention); assert.equal(original.paragraph.childNodes[1].textContent, " ");
  assert.equal(original.paragraph.childNodes[2].textContent, "请核对");
  assert.equal(original.paragraph.querySelector("strong"), original.bold); assert.equal(original.paragraph.querySelector("a"), original.link);
  assert.equal(original.link.href, "https://example.test/fixture"); assert.equal(original.list.textContent, "保留的列表项");
  assert.ok(textOf(original.paragraph).endsWith("请核对初稿及参考材料"));
});

test("群首个富文本块不是段落时新增提及段，并保留原标题和代码块", async () => {
  const state = detail(); state.messages[0].recipientId = "reviewer"; let original;
  const ui = await readyGroup(state, { richText(container, content, document) {
    const heading = document.createElement("h2"), code = document.createElement("pre");
    heading.textContent = "处理步骤"; code.textContent = "fixture();"; container.replaceChildren(heading, code); original = { heading, code };
  } });
  const body = groupMessageRows(ui)[0].children.find(isBubble);
  assert.equal(body.children.length, 3); assert.equal(body.firstElementChild.tagName, "P");
  assert.equal(body.firstElementChild.firstElementChild.classList.contains("group-message-mention"), true);
  assert.equal(body.children[1], original.heading); assert.equal(body.children[2], original.code);
  assert.equal(original.heading.textContent, "处理步骤"); assert.equal(original.code.textContent, "fixture();");
});

test("群纯气泡保留任务过滤、材料引用、成果入口和真实失败停止状态", async () => {
  const state = detail();
  state.messages[0] = { ...state.messages[0], content: "已整理 #agent/writer", status: "failed",
    attachments: [{ id: "material-one", name: "研究资料.txt" }], actions: [{ href: "#group/one", label: "查看协作成果" }] };
  state.messages.push({ id: "stopped", seq: 2, sender: { type: "agent", id: "reviewer" }, recipientId: "former-member",
    content: "已保留检查结果", taskId: "task-one", status: "cancelled" },
  { id: "other-task", seq: 3, sender: { type: "user" }, content: "另一项任务的消息", taskId: "task-two", status: "complete" });
  state.tasks.push({ id: "task-two", goal: "另一项任务", status: "completed" }); state.lastSequence = 3;
  const ui = setup(groupsSource, async (path) => Response.json(path === "/api/groups" ? { groups: [group()] } : state));
  await settle(); await ui.route({ page: "group", groupId: "one" }); await settle();
  assert.equal(ui.get("group-messages").children.length, 1);
  assert.equal(ui.get("group-messages").children[0].dataset.messageId, "other-task");
  await ui.get("group-tasks").children.find((item) => item.children[0].textContent === "整理报告").children[0].click();
  const rows = ui.get("group-messages").children;
  assert.deepEqual(rows.map((row) => row.dataset.messageId), ["message-one", "stopped"]);
  assert.equal(rows[0].children.find(isBubble).textContent, "已整理");
  const material = rows[0].children.find((item) => item.className === "collaboration-links" && item.children.some((child) => child.tagName === "SPAN"));
  assert.equal(material.children[0].textContent, "▧ 研究资料.txt");
  const links = rows[0].children.find((item) => item.className === "collaboration-links" && item.children.some((child) => child.tagName === "A"));
  assert.deepEqual(links.children.map((item) => item.href), ["#agent/writer", "#group/one"]);
  assert.equal(links.children[1].textContent, "查看协作成果");
  assert.match(textOf(rows[0]), /失败/); assert.match(textOf(rows[1]), /已停止/);
  assert.equal(rows[1].getAttribute("aria-label"), "检查助手发送的消息，提及former-member");
  assert.equal(rows[1].children.find(isBubble).textContent, "已保留检查结果");
});

test("输入 @ 选择带头像和彩色名字的真实成员，普通消息自动判断且未就绪成员不可选", async () => {
  const state = detail(), writes = []; state.members[1].ready = false;
  const ui = await readyGroup(state, { request(path, options) {
    if (path.endsWith("/messages")) { writes.push(JSON.parse(options.body)); return Response.json({ message: { id: "sent" } }); }
  } });
  const popup = await openMention(ui);
  assert.equal(popup.getAttribute("aria-hidden"), "false");
  const unavailable = popup.children.find((item) => item.dataset.memberId === "reviewer");
  await unavailable.click(); assert.equal(ui.get("group-message").value, "@");
  const available = popup.children.find((item) => item.dataset.memberId === "writer");
  assert.ok(available.querySelector(".group-compose-mention-avatar").children.length);
  assert.ok(available.dataset.avatarColor);
  await available.click();
  assert.equal(ui.get("group-message").value, "@写作助手 ");
  assert.equal(popup.getAttribute("aria-hidden"), "true");
  ui.get("group-message").value += "请整理报告"; await ui.submit("group-chat-form"); await settle();
  assert.deepEqual(writes[0].mentions, [{ memberId: "writer", start: 0, end: 5, text: "@写作助手" }]);
  assert.equal(Object.hasOwn(writes[0], "recipientId"), false);
  assert.equal(ui.get("group-selected-mentions").hidden, true);
  ui.get("group-message").value = "请自主协作"; await ui.submit("group-chat-form"); await settle();
  assert.equal(Object.hasOwn(writes[1], "mentions"), false);
});

test("用户消息中的已选提及按真实身份显示头像和彩色名称，未知或失效范围仍为安全纯文字", async () => {
  const state = detail();
  state.members[0].profile = { icon: "star:4:1" };
  state.members.push({ ...member("same-name", "写作助手"), profile: { icon: "star:0:2" } });
  const content = "<img src=x> @写作助手 请回复";
  const start = content.indexOf("@");
  state.messages = [{ id: "selected", taskId: "task-one", sender: { type: "user" }, content,
    mentions: [{ memberId: "same-name", start, end: start + 5, text: "@写作助手" }] }];
  const ui = await readyGroup(state);
  const body = groupMessageRows(ui)[0].children.find(isBubble), mention = body.querySelector(".group-user-mention");
  assert.equal(mention.dataset.agentId, "same-name");
  assert.equal(mention.dataset.avatarColor, resolveAgentAvatar(state.members[2]).color);
  assert.equal(mention.querySelector(".group-mention-avatar").dataset.avatarIcon, "star:0:2");
  assert.equal(textOf(body), content); assert.equal(body.querySelectorAll("img").some((image) => image.src === "x"), false);
  for (const invalid of [{ memberId: "unknown", start, end: start + 5, text: "@写作助手" },
    { memberId: "same-name", start: 0, end: 5, text: "@写作助手" }]) {
    state.messages[0].mentions = [invalid];
    ui.context.renderMessages(ui.get("group-messages"), state.messages, "task-one", state.members, state.tasks);
    assert.equal(groupMessageRows(ui)[0].querySelector(".group-user-mention"), undefined);
    assert.equal(textOf(groupMessageRows(ui)[0].children.find(isBubble)), content);
  }
});

test("导航会话选择保留行焦点，刷新保留选择，移除后恢复最近会话而新对话显示空白", async () => {
  const state = detail(); state.tasks.push({ id: "task-two", goal: "第二项任务", status: "completed" });
  state.messages.push({ ...state.messages[0], id: "message-two", taskId: "task-two", content: "第二份材料" });
  const ui = setup(groupsSource, async (path) => Response.json(path === "/api/groups" ? { groups: [group()] } : state));
  await settle(); await ui.route({ page: "group", groupId: "one" }); await settle();
  const row = sidebarGroupRows(ui).find((entry) => entry.dataset.taskId === "task-two"); row.focus(); await row.click();
  assert.equal(selectedGroupTask(ui), "task-two");
  assert.match(ui.text("group-messages"), /第二份材料/); assert.doesNotMatch(ui.text("group-messages"), /研究小组的初稿/);
  assert.equal(ui.document.activeElement.dataset.taskId, "task-two");
  await ui.get("group-refresh").click(); await settle(); assert.equal(selectedGroupTask(ui), "task-two");
  state.tasks.pop(); await ui.get("group-refresh").click(); await settle();
  assert.equal(selectedGroupTask(ui), "task-one"); assert.match(ui.text("group-messages"), /研究小组的初稿/);
  await sidebarGroupRows(ui).find((entry) => entry.dataset.taskId === "task-one").click();
  await ui.get("group-new-task").click(); assert.equal(selectedGroupTask(ui), "");
  assert.equal(groupMessageRows(ui).length, 0); assert.doesNotMatch(ui.text("group-messages"), /研究小组的初稿/);
});

test("发送时关闭提及弹层，跨群保存各自草稿身份，已归档群不能打开补全", async () => {
  const state = detail(); let release;
  const ui = await readyGroup(state, { request(path) {
    if (path.endsWith("/messages")) return new Promise((resolve) => { release = () => resolve(Response.json({ message: { id: "sent" } })); });
  } });
  await pickMention(ui, "writer"); ui.get("group-message").value += "整理报告";
  await ui.submit("group-chat-form"); await settle();
  assert.equal(ui.get("group-message").disabled, true); assert.equal(ui.get("group-mention-popup").getAttribute("aria-hidden"), "true");
  assert.match(ui.text("group-compose-status"), /正在提交/);
  release(); await settle(); assert.equal(ui.get("group-message").disabled, false);
  await pickMention(ui, "reviewer");
  await ui.route({ page: "group", groupId: "two" }); await settle();
  assert.equal(ui.get("group-message").value, ""); assert.equal(ui.get("group-selected-mentions").hidden, true);
  assert.equal(ui.get("group-mention-popup").getAttribute("aria-hidden"), "true");
  await ui.route({ page: "group", groupId: "one" }); await settle();
  assert.equal(ui.get("group-message").value, "@检查助手 "); assert.match(ui.text("group-selected-mentions"), /检查助手/);
  state.group.archived = true; await ui.get("group-refresh").click(); await settle();
  await openMention(ui); assert.equal(ui.get("group-mention-popup").getAttribute("aria-hidden"), "true");
});

test("后台轮询保留 @ 菜单、高亮和滚动，Escape 优先关闭补全不关闭设置", async () => {
  const state = detail();
  const ui = await readyGroup(state, { request(path) {
    if (path.includes("/events?")) return Response.json({ events: [{ seq: 2 }], lastSequence: 2 });
  } });
  await ui.get("group-panel-toggle").click();
  const popup = await openMention(ui), input = ui.get("group-message");
  await ui.key(input, "ArrowDown");
  const active = input.getAttribute("aria-activedescendant"), original = popup.children[0]; popup.scrollTop = 64;
  [...ui.timers.values()][0](); await settle();
  assert.equal(popup.getAttribute("aria-hidden"), "false");
  assert.equal(input.getAttribute("aria-activedescendant"), active); assert.equal(popup.children[0], original);
  assert.equal(popup.scrollTop, 64); assert.equal(input.value, "@");
  await ui.key(input, "Escape");
  assert.equal(popup.getAttribute("aria-hidden"), "true"); assert.equal(ui.get("group-panel").hidden, false);
});

test("群消息发送失败保留输入，重试复用同一个操作，不会重新派发任务", async () => {
  const writes = []; let failed = true;
  const ui = setup(groupsSource, async (path, options = {}) => {
    if (path.endsWith("/messages")) {
      writes.push(JSON.parse(options.body));
      if (failed) { failed = false; throw new Error("连接中断"); }
      return Response.json({ message: { id: "sent" }, task: { id: "task-one" } });
    }
    return Response.json(path === "/api/groups" ? { groups: [group()] } : detail());
  });
  await settle(); await ui.route({ page: "group", groupId: "one" }); await settle();
  await pickMention(ui, "reviewer"); ui.get("group-message").value += "检查初稿";
  await ui.submit("group-chat-form"); await settle();
  assert.equal(ui.get("group-message").value, "@检查助手 检查初稿"); assert.match(ui.text("group-error"), /仍保留/);
  await ui.submit("group-chat-form"); await settle();
  assert.deepEqual(writes[1], writes[0]); assert.equal(writes[0].mentions[0].memberId, "reviewer"); assert.equal(writes[0].taskId, "task-one");
  assert.equal(ui.get("group-message").value, "");
});

test("群成员选择显示各自头像，缺省头像稳定且未就绪状态与已有选择保留", async () => {
  const candidates = [
    { ...member(), profile: { icon: "star:4:1" } },
    { ...member("reviewer", "检查助手"), ready: false, profile: { icon: "star:1:0" } },
    { ...member("new-member", "待加入助手"), ready: false },
    { ...member("legacy", "自定义图标助手"), profile: { icon: "📝" } },
  ];
  const ui = setup(groupsSource, async (path) => Response.json(path === "/api/groups" ? { groups: [group()] }
    : path === "/api/collaboration/agents" ? { agents: candidates } : detail()));
  await settle(); await ui.get("groups-create").click(); await settle();
  const rows = ui.get("group-member-picker").children;
  assert.equal(rows.length, candidates.length);
  for (const [index, candidate] of candidates.entries()) {
    const [input, avatar, copy] = rows[index].children, expected = resolveAgentAvatar(candidate);
    assert.equal(input.value, candidate.id); assert.equal(input.checked, false);
    assert.equal(input.disabled, !candidate.ready);
    assert.equal(avatar.dataset.avatarIcon, expected.icon ?? expected.text);
    assert.equal(avatar.getAttribute("aria-hidden"), "true");
    assert.equal(copy.children[0].textContent, candidate.name);
    assert.equal(copy.children[1].textContent, candidate.ready ? candidate.description : "尚未就绪");
    if (expected.type === "star") {
      assert.equal(avatar.children[0].dataset.shape, expected.shape);
      assert.equal(avatar.children[0].dataset.color, expected.color);
    } else assert.equal(avatar.textContent, "📝");
  }
  const defaultIcon = rows[2].children[1].dataset.avatarIcon;
  await ui.get("group-editor-close").click();
  candidates[2].name = "已改名的待加入助手";
  await ui.route({ page: "group", groupId: "one" }); await settle();
  await ui.get("group-edit").click(); await settle();
  const edited = ui.get("group-member-picker").children;
  assert.equal(edited[2].children[1].dataset.avatarIcon, defaultIcon);
  assert.equal(edited[1].children[0].checked, true);
  assert.equal(edited[1].children[0].disabled, false);
  assert.equal(edited[2].children[0].disabled, true);
});

test("创建群的未知结果可幂等重试，保留名称、用途和成员选择", async () => {
  const writes = []; let fail = true;
  const ui = setup(groupsSource, async (path, options = {}) => {
    if (path === "/api/groups" && options.method === "POST") {
      writes.push(JSON.parse(options.body)); if (fail) { fail = false; throw new Error("保存响应中断"); }
      return Response.json({ group: { ...group(), name: "新的研究群" } });
    }
    return Response.json(path === "/api/groups" ? { groups: [] } : path === "/api/collaboration/agents" ? { agents: [member()] } : detail());
  });
  await settle(); await ui.get("groups-create").click(); await settle();
  ui.get("group-name").value = "新的研究群"; ui.get("group-purpose-input").value = "共同研究";
  ui.get("group-member-picker").children[0].children[0].checked = true;
  await ui.submit("group-editor-form"); await settle();
  assert.equal(ui.get("group-editor").open, true); assert.equal(ui.get("group-name").value, "新的研究群");
  await ui.submit("group-editor-form"); await settle();
  assert.deepEqual(writes[1], writes[0]); assert.deepEqual(writes[0].memberIds, ["writer"]);
  assert.equal(ui.get("group-editor").open, false);
});

test("停止旧群任务的迟到回执不能作废新群加载，随后仍可轮询和发送", async () => {
  const first = detail(), second = detail("two", "新的小组"), requests = [];
  let releaseCancel, releaseSecond;
  const ui = setup(groupsSource, async (path, options = {}) => {
    requests.push(path);
    if (path.endsWith("/cancel")) return new Promise((resolve) => { releaseCancel = () => resolve(Response.json({ cancelled: true })); });
    if (path === "/api/groups/two" && !releaseSecond) return new Promise((resolve) => { releaseSecond = () => resolve(Response.json(second)); });
    if (path.includes("/events?")) return Response.json({ events: [], lastSequence: 1 });
    return Response.json(path === "/api/groups" ? { groups: [first.group, second.group] }
      : path.endsWith("/messages") ? { message: { id: "sent" }, task: second.tasks[0] } : path === "/api/groups/two" ? second : first);
  });
  await settle(); await ui.route({ page: "group", groupId: "one" }); await settle();
  const stopping = ui.get("group-tasks").querySelectorAll("button").find((item) => item.textContent === "停止任务").click();
  await settle(); await ui.route({ page: "group", groupId: "two" }); await settle();
  releaseCancel(); await stopping; await settle(); releaseSecond(); await settle();
  assert.equal(ui.text("group-title"), "新的小组"); assert.match(ui.text("group-messages"), /新的小组的初稿/);
  assert.equal(ui.get("group-message").disabled, false); assert.equal(ui.get("group-send").disabled, false);
  for (const callback of ui.timers.values()) callback(); await settle();
  assert.ok(requests.some((path) => path === "/api/groups/two/events?after=1"));
  ui.get("group-message").value = "继续新群任务"; await ui.submit("group-chat-form"); await settle();
  assert.ok(requests.includes("/api/groups/two/messages"));
});

test("切换群组后迟到的旧群响应不能覆盖新群，新的任务可以独立发起", async () => {
  let release; const writes = [];
  const ui = setup(groupsSource, async (path, options = {}) => {
    if (path === "/api/groups/one") return new Promise((resolve) => { release = () => resolve(Response.json(detail())); });
    if (path.endsWith("/messages")) { writes.push(JSON.parse(options.body)); return Response.json({ message: { id: "sent" }, task: { id: "new-task" } }); }
    return Response.json(path === "/api/groups" ? { groups: [group()] } : detail("two", "新的小组"));
  });
  await settle(); await ui.route({ page: "group", groupId: "one" }); await settle();
  await ui.route({ page: "group", groupId: "two" }); await settle(); release(); await settle();
  assert.equal(ui.text("group-title"), "新的小组"); assert.equal(ui.text("group-messages").includes("研究小组的初稿"), false);
  await ui.get("group-new-task").click(); ui.get("group-message").value = "开始第二份报告";
  assert.equal(ui.text("group-compose-status"), ""); assert.equal(ui.get("group-compose-status").hidden, true);
  await ui.submit("group-chat-form"); await settle();
  assert.equal(writes[0].newTask, true); assert.equal(writes[0].taskId, undefined);
});

test("成员能力使用各自星核，缺省或已移除成员按稳定身份回退，改名不换头像", async () => {
  const state = detail(); state.members[0].profile = { icon: "star:4:1" };
  state.members.push({ id: "removed-member", name: "已移除的 Agent", ready: false });
  const ui = setup(groupsSource, async (path) => Response.json(path === "/api/groups" ? { groups: [group()] } : state));
  await settle(); await ui.route({ page: "group", groupId: "one" }); await settle();
  const cards = ui.get("group-members").children;
  for (const [index, candidate] of state.members.entries()) {
    const [avatar, name, status] = cards[index].children[0].children;
    assert.equal(avatar.dataset.avatarIcon, resolveAgentAvatar(candidate).icon);
    assert.equal(avatar.dataset.avatarKind, "star"); assert.equal(avatar.textContent, "");
    assert.equal(avatar.getAttribute("aria-hidden"), "true");
    assert.equal(name.textContent, candidate.name); assert.equal(status.textContent, candidate.ready ? "已交付" : "未就绪");
    assert.equal(cards[index].children.at(-1).href, `#agent/${candidate.id}`);
  }
  const defaultIcon = cards[1].children[0].children[0].dataset.avatarIcon;
  state.members[1].name = "改名后的检查助手";
  await ui.get("group-refresh").click(); await settle();
  assert.equal(ui.get("group-members").children[1].children[0].children[0].dataset.avatarIcon, defaultIcon);
});

test("成员能力展开状态在群进度更新时保留，归档群阻止继续发送", async () => {
  const state = detail(); const ui = setup(groupsSource, async (path) => Response.json(path === "/api/groups" ? { groups: [group()] } : state));
  state.members[0].profile = { icon: "star:4:1" };
  await settle(); await ui.route({ page: "group", groupId: "one" }); await settle();
  ui.get("group-members").children[0].open = true;
  state.members[0].profile.icon = "star:0:2";
  await ui.get("group-refresh").click(); await settle();
  assert.equal(ui.get("group-members").children[0].open, true);
  assert.equal(ui.get("group-members").children[0].children[0].children[0].dataset.avatarIcon, "star:0:2");
  state.group.archived = true; await ui.get("group-refresh").click(); await settle();
  assert.equal(ui.get("group-send").disabled, true); assert.match(ui.text("group-compose-status"), /取消归档/);
  assert.equal(ui.get("group-compose-status").hidden, false);
});

test("群成员公开卡区分可调用、执行条件、禁止范围和检查记录，完整资料只作为文本展示", async () => {
  const state = detail();
  Object.assign(state.members[0], { capabilitySchemaVersion: 1, capabilityVersion: "internal-card-hash", revision: 23,
    task: "依据共享论文写作", input: ["共享论文", "报告目标"], output: "报告与引用", boundaries: "不能编造来源",
    hardBoundaries: [{ id: "private-data", label: "私人材料", reason: "只能读取明确分享到群里的材料" }],
    capabilities: [
      { id: "read_material", label: "读取群材料", description: "读取已经共享的文档", availability: "callable", scope: "group_task", reason: "材料必须已分享", requirements: ["群材料"], verification: { status: "unverified", checkedAt: null, description: "每次读取后核对实际范围" } },
      { id: "search", label: "专属搜索", description: "按配置查询", availability: "conditional", scope: "group_task", reason: "缺少连接配置", requirements: ["配置搜索连接"], verification: { status: "connection_checked", checkedAt: "2026-10-14T06:00:00Z", description: "仅检查连接，具体业务调用仍需确认" } },
      { id: "write_private", label: "修改其他成员文件", description: "<img src=x onerror=alert(1)>", availability: "forbidden", scope: "group_task", reason: "不能修改他人的私人工作目录", requirements: [], verification: { status: "delivery_checked", checkedAt: null, description: "仅检查已交付程序" } },
    ] });
  const ui = await readyGroup(state), card = ui.get("group-members").children[0], body = card.querySelector(".group-member-profile");
  const abilities = card.querySelector(".group-member-abilities");
  assert.equal(card.open, false); assert.equal(abilities.open, false);
  assert.equal(card.children[0].getAttribute("aria-controls"), body.id);
  assert.equal(card.children[0].getAttribute("aria-expanded"), "false");
  card.open = true; await card.dispatchEvent({ type: "toggle" });
  abilities.open = true; await abilities.dispatchEvent({ type: "toggle" });
  assert.equal(card.children[0].getAttribute("aria-expanded"), "true");
  assert.equal(abilities.children[0].getAttribute("aria-expanded"), "true");
  const rows = card.querySelectorAll(".group-capability-item");
  assert.equal(rows.length, 3);
  assert.equal(textOf(rows[0]).includes("可调用"), true); assert.equal(textOf(rows[0]).includes("尚未验证"), true);
  assert.equal(textOf(rows[1]).includes("需要条件"), true); assert.equal(textOf(rows[1]).includes("缺少连接配置"), true);
  assert.equal(textOf(rows[1]).includes("连接检查通过"), true); assert.equal(textOf(rows[1]).includes("具体业务调用仍需确认"), true);
  assert.equal(textOf(rows[2]).includes("禁止执行"), true); assert.equal(textOf(rows[2]).includes("<img src=x onerror=alert(1)>"), true);
  assert.equal(rows[2].querySelectorAll("img").length, 0);
  const text = ui.text("group-members");
  for (const expected of ["依据共享论文写作", "共享论文；报告目标", "报告与引用", "不能编造来源", "只能读取明确分享到群里的材料"]) assert.ok(text.includes(expected), expected);
  for (const hidden of ["internal-card-hash", "private-data", "read_material", "write_private"]) assert.equal(text.includes(hidden), false, hidden);
});

test("旧群成员卡保留原职责资料并明确具体能力尚未提供，未知状态不会误标可调用", async () => {
  const state = detail(); Object.assign(state.members[0], { input: "说明问题", output: "文字报告", boundaries: ["使用群材料", "不编造结果"] });
  state.members[1].capabilities = [{ id: "future-tool", label: "待确认工具", availability: "a-new-status", verification: { status: "new-check" } }];
  const ui = await readyGroup(state), [legacy, newer] = ui.get("group-members").children;
  assert.match(textOf(legacy), /说明问题/); assert.match(textOf(legacy), /文字报告/); assert.match(textOf(legacy), /使用群材料；不编造结果/);
  assert.match(textOf(legacy), /尚未提供具体能力与检查记录/);
  const unknown = newer.querySelector(".group-capability-item");
  assert.match(textOf(unknown), /尚不明确/); assert.match(textOf(unknown), /尚未验证/);
  assert.equal(unknown.querySelector(".group-capability-status").dataset.availability, "unknown");
});

test("群轮询更新公开能力保留成员和具体能力节点、开合及焦点，能力失效如实更新", async () => {
  const state = detail(); state.members[0].capabilities = [{ id: "search", label: "检索资料", availability: "callable", requirements: [],
    verification: { status: "unverified" } }];
  const ui = await readyGroup(state, { request: (path) => path.includes("/events?")
    ? Response.json({ events: [{ type: "member_updated" }], lastSequence: state.lastSequence }) : null });
  await ui.get("group-panel-toggle").click(); await ui.get("group-details-members-tab").click();
  const card = ui.get("group-members").children[0], abilities = card.querySelector(".group-member-abilities");
  const summary = abilities.children[0], capability = card.querySelector(".group-capability-item"), privateLink = card.children.at(-1);
  card.open = true; abilities.open = true; summary.focus();
  Object.assign(state.members[0].capabilities[0], { availability: "conditional", reason: "连接已撤销", verification: { status: "last_call_failed", description: "上次请求失败" } });
  state.members.reverse(); state.lastSequence++;
  await [...ui.timers.values()][0](); await settle();
  const refreshed = ui.get("group-members").children.find((item) => item.dataset.memberId === "writer");
  assert.equal(refreshed, card); assert.equal(refreshed.querySelector(".group-member-abilities"), abilities);
  assert.equal(refreshed.querySelector(".group-capability-item"), capability);
  assert.equal(card.open, true); assert.equal(abilities.open, true); assert.equal(ui.document.activeElement, summary);
  assert.match(textOf(capability), /需要条件/); assert.match(textOf(capability), /连接已撤销/); assert.match(textOf(capability), /最近调用失败/);
  privateLink.focus(); await ui.get("group-refresh").click(); await settle(); assert.equal(ui.document.activeElement, privateLink);
  state.members = state.members.filter((item) => item.id !== "writer");
  await ui.get("group-refresh").click(); await settle();
  assert.equal(ui.document.activeElement.id, "group-details-members-tab");
});

test("切群或离页重置成员能力展开状态，成员身份相同也不串群资料", async () => {
  const state = detail(); state.members[0].capabilities = [{ id: "search", label: "第一群专属资料", availability: "callable" }];
  const ui = await readyGroup(state), card = ui.get("group-members").children[0];
  card.open = true; card.querySelector(".group-member-abilities").open = true;
  await ui.route({ page: "group", groupId: "two" }); await settle();
  const second = ui.get("group-members").children[0];
  assert.notEqual(second, card); assert.equal(second.open, false); assert.equal(second.querySelector(".group-member-abilities").open, false);
  assert.equal(ui.text("group-members").includes("第一群专属资料"), false);
  await ui.route({ page: "chat" }); assert.equal(ui.get("group-members").children.length, 0);
  await ui.route({ page: "group", groupId: "one" }); await settle();
  assert.equal(ui.get("group-members").children[0].open, false); assert.match(ui.text("group-members"), /第一群专属资料/);
});

test("群闲聊任务阶段显示自然中文，不泄露内部 conversation 标记", async () => {
  const state = detail(); state.tasks[0].status = "completed"; state.tasks[0].phase = "conversation";
  const ui = await readyGroup(state);
  assert.match(ui.text("group-tasks"), /已完成 · 对话/);
  assert.doesNotMatch(ui.text("group-tasks"), /conversation/);
});

test("已完成任务的后续材料请求继续当前对话，真实执行阶段显示中文", async () => {
  const state = detail(); state.tasks[0].status = "completed"; state.tasks[0].phase = "delivery";
  state.materials = [{ id: "material-one", name: "资料.txt", mimeType: "text/plain" }];
  const writes = [], ui = setup(groupsSource, async (path, options = {}) => {
    if (path.endsWith("/preview")) return Response.json({ text: "资料正文" });
    if (path.endsWith("/messages")) { writes.push(JSON.parse(options.body)); return Response.json({ message: { id: "sent" }, task: { id: "new-task" } }); }
    return Response.json(path === "/api/groups" ? { groups: [group()] } : state);
  });
  await settle(); await ui.route({ page: "group", groupId: "one" }); await settle();
  await ui.get("group-tasks").children[0].children[0].click();
  assert.match(ui.text("group-tasks"), /已完成 · 交付成果/); assert.equal(ui.text("group-compose-status"), "");
  assert.equal(ui.get("group-compose-status").hidden, true);
  await ui.get("group-files-open").click();
  await ui.get("group-file-list").children.find((item) => item.tagName === "BUTTON").click(); await settle();
  await ui.get("group-file-actions").children[1].click(); await ui.submit("group-chat-form"); await settle();
  assert.equal(writes[0].newTask, false); assert.equal(writes[0].taskId, "task-one");
  assert.ok(writes[0].content.trim()); assert.deepEqual(writes[0].attachmentIds, ["material-one"]);
});

test("群历史按稳定会话合并执行轮次，保留首轮标题日期、最新状态和更新时间排序，不修改原任务", () => {
  const tasks = Object.freeze([
    Object.freeze({ id: "round-one", conversationId: "conversation-one", goal: "第一句话", createdAt: "2026-10-14T01:00:00Z", updatedAt: "2026-10-14T01:01:00Z", status: "completed" }),
    Object.freeze({ id: "legacy", goal: "旧记录", createdAt: "2026-10-14T02:00:00Z", updatedAt: "2026-10-14T02:01:00Z", status: "completed" }),
    Object.freeze({ id: "round-two", conversationId: "conversation-one", goal: "第二句话", createdAt: "2026-10-14T03:00:00Z", updatedAt: "2026-10-14T03:01:00Z", status: "running" }),
  ]), before = copy(tasks), conversations = groupConversations(tasks);
  assert.deepEqual(conversations.map((item) => item.id), ["legacy", "conversation-one"]);
  assert.equal(conversations[1].taskId, "round-two"); assert.equal(conversations[1].goal, "第一句话");
  assert.equal(conversations[1].createdAt, tasks[0].createdAt); assert.equal(conversations[1].updatedAt, tasks[2].updatedAt);
  assert.equal(conversations[1].status, "running"); assert.deepEqual(conversations[1].tasks.map((task) => task.id), ["round-one", "round-two"]);
  assert.deepEqual(tasks, before);
});

test("群连续三轮发送使用最新真实执行 ID，消息累积在同一会话，只有加号建立另一项历史", async () => {
  const state = detail(); state.tasks = []; state.messages = []; state.group.activeTaskId = null;
  const writes = [], ui = await readyGroup(state, { request(path, options) {
    if (!path.endsWith("/messages")) return null;
    const body = JSON.parse(options.body); writes.push(body);
    const previous = state.tasks.find((task) => task.id === body.taskId), id = `round-${writes.length}`;
    const task = { id, conversationId: body.newTask ? id : previous.conversationId,
      goal: body.content, status: "completed", createdAt: `2026-10-14T0${writes.length}:00:00Z`, updatedAt: `2026-10-14T0${writes.length}:01:00Z` };
    const message = { id: `user-${id}`, sender: { type: "user" }, content: body.content, taskId: id, createdAt: task.createdAt };
    state.tasks.push(task); state.messages.push(message, { ...message, id: `reply-${id}`, sender: { type: "agent", id: "writer", name: "写作助手" }, content: `第 ${writes.length} 轮回复` });
    state.lastSequence++; return Response.json({ message, task });
  } });
  for (let index = 1; index <= 3; index++) {
    ui.get("group-message").value = `第 ${index} 句话`; await ui.submit("group-chat-form"); await settle();
    assert.equal(writes[index - 1].newTask, index === 1);
    assert.equal(writes[index - 1].taskId, index === 1 ? undefined : `round-${index - 1}`);
    assert.equal(selectedGroupTask(ui), "round-1"); assert.equal(groupMessageRows(ui).length, index * 2);
    assert.equal(sidebarGroupRows(ui).length, 1); assert.equal(sidebarGroupRows(ui)[0].title, "第 1 句话");
    assert.equal(ui.get("group-messages").children.filter((item) => item.className === "conversation-date").length, 1);
    assert.equal(ui.get("group-messages").children[0].dateTime, "2026-10-14T01:00:00.000Z");
    assert.equal(ui.get("group-compose-status").hidden, true);
    await ui.get("group-refresh").click(); await settle();
    assert.equal(groupMessageRows(ui).length, index * 2);
  }
  await ui.get("group-new-task").click(); assert.equal(groupMessageRows(ui).length, 0);
  ui.get("group-message").value = "另一个话题"; await ui.submit("group-chat-form"); await settle();
  assert.equal(writes[3].newTask, true); assert.equal(writes[3].taskId, undefined);
  assert.equal(selectedGroupTask(ui), "round-4"); assert.equal(sidebarGroupRows(ui).length, 2); assert.equal(groupMessageRows(ui).length, 2);
  assert.doesNotMatch(ui.text("group-messages"), /第 1 句话|第 2 句话|第 3 句话/);
  await sidebarGroupRows(ui).find((row) => row.dataset.conversationId === "round-1").click();
  assert.equal(groupMessageRows(ui).length, 6); assert.doesNotMatch(ui.text("group-messages"), /另一个话题/);
  assert.equal(ui.get("group-tasks").children.length, 4);
});

test("群连续消息已保存但回包丢失，轮询读到新执行后重试仍复用原执行 ID 与幂等请求", async () => {
  const state = detail(); state.tasks[0].conversationId = "conversation-one"; state.tasks[0].status = "completed";
  state.group.activeTaskId = null;
  const writes = [], receipts = new Map(); let loseResponse = true;
  const ui = await readyGroup(state, { request(path, options) {
    if (path.includes("/events?")) return Response.json({ events: [{ seq: state.lastSequence }], lastSequence: state.lastSequence });
    if (!path.endsWith("/messages")) return null;
    const body = JSON.parse(options.body); writes.push(body);
    if (!receipts.has(body.mutationId)) {
      const task = { id: `followup-${receipts.size + 1}`, conversationId: "conversation-one", goal: body.content, status: "completed" };
      const message = { id: `user-${task.id}`, taskId: task.id, content: body.content, sender: { type: "user" } };
      state.tasks.push(task); state.messages.push(message); state.lastSequence++;
      receipts.set(body.mutationId, { task, message });
    }
    if (loseResponse) { loseResponse = false; throw new Error("响应连接中断"); }
    return Response.json(receipts.get(body.mutationId));
  } });
  ui.get("group-message").value = "继续上一句"; await ui.submit("group-chat-form"); await settle();
  assert.match(ui.text("group-error"), /响应连接中断/); assert.equal(ui.get("group-message").value, "继续上一句");
  [...ui.timers.values()][0](); await settle();
  assert.equal(selectedGroupTask(ui), "conversation-one"); assert.match(ui.text("group-messages"), /继续上一句/);
  assert.equal(ui.get("group-tasks").children[0].dataset.taskId, "followup-1");
  ui.get("group-panel-toggle").focus(); await ui.submit("group-chat-form"); await settle();
  assert.deepEqual(writes[1], writes[0]); assert.equal(writes[0].taskId, "task-one"); assert.equal(writes[0].newTask, false);
  assert.equal(receipts.size, 1); assert.equal(state.tasks.length, 2);
  assert.equal(state.messages.filter((message) => message.sender.type === "user").length, 1);
  assert.equal(ui.document.activeElement.id, "group-panel-toggle"); assert.equal(ui.get("group-message").value, "");
  ui.get("group-message").value = "再继续聊"; await ui.submit("group-chat-form"); await settle();
  assert.equal(writes[2].taskId, "followup-1"); assert.equal(writes[2].newTask, false);
  assert.notEqual(writes[2].mutationId, writes[0].mutationId); assert.equal(receipts.size, 2);
  assert.equal(selectedGroupTask(ui), "conversation-one"); assert.equal(sidebarGroupRows(ui).length, 1);
});

test("首次群消息未知回执后轮询不会改成续聊，显式再次点击加号不复用先前新对话请求", async () => {
  const state = detail(); state.tasks = []; state.messages = []; state.group.activeTaskId = null;
  const writes = [], receipts = new Map(); let loseResponse = true;
  const ui = await readyGroup(state, { request(path, options) {
    if (path.includes("/events?")) return Response.json({ events: [{ seq: state.lastSequence }], lastSequence: state.lastSequence });
    if (!path.endsWith("/messages")) return null;
    const body = JSON.parse(options.body); writes.push(body);
    if (!receipts.has(body.mutationId)) {
      const task = { id: `new-${receipts.size + 1}`, conversationId: `new-${receipts.size + 1}`, goal: body.content, status: "completed" };
      const message = { id: `user-${task.id}`, taskId: task.id, content: body.content, sender: { type: "user" } };
      state.tasks.push(task); state.messages.push(message); state.lastSequence++;
      receipts.set(body.mutationId, { task, message });
    }
    if (loseResponse) { loseResponse = false; throw new Error("首次响应连接中断"); }
    return Response.json(receipts.get(body.mutationId));
  } });
  ui.get("group-message").value = "开始讨论"; await ui.submit("group-chat-form"); await settle();
  [...ui.timers.values()][0](); await settle();
  assert.equal(vm.runInContext("newTask", ui.context), true); assert.equal(selectedGroupTask(ui), "");
  assert.equal(groupMessageRows(ui).length, 0);
  await ui.submit("group-chat-form"); await settle();
  assert.deepEqual(writes[1], writes[0]); assert.equal(receipts.size, 1); assert.equal(selectedGroupTask(ui), "new-1");
  await ui.get("group-new-task").click(); ui.get("group-message").value = "再开讨论"; loseResponse = true;
  await ui.submit("group-chat-form"); await settle();
  await ui.get("group-new-task").click(); await ui.submit("group-chat-form"); await settle();
  assert.equal(writes[3].newTask, true); assert.equal(writes[3].taskId, undefined);
  assert.notEqual(writes[3].mutationId, writes[2].mutationId); assert.equal(receipts.size, 3);
  assert.equal(selectedGroupTask(ui), "new-3"); assert.equal(groupMessageRows(ui).length, 1);
});

test("群会话选择跨页、切群和浏览器刷新恢复，完成清空 activeTaskId 不影响继续发送", async () => {
  const state = detail(); state.group.activeTaskId = null;
  state.tasks = [{ id: "first-run", conversationId: "first-conversation", goal: "旧话题", status: "completed" },
    { id: "latest-run", conversationId: "latest-conversation", goal: "最近话题", status: "completed" }];
  state.messages = state.tasks.map((task) => ({ id: task.id, taskId: task.id, content: task.goal, sender: { type: "user" } }));
  const writes = [], request = (path, options = {}) => {
    if (path.endsWith("/messages")) { writes.push(JSON.parse(options.body)); return Response.json({ message: { id: "sent" }, task: state.tasks[0] }); }
    return Response.json(path === "/api/groups" ? { groups: [state.group] } : path === "/api/groups/two" ? detail("two") : state);
  }, ui = setup(groupsSource, request);
  await settle(); await ui.route({ page: "group", groupId: "one" }); await settle();
  assert.equal(selectedGroupTask(ui), "latest-conversation"); assert.match(ui.text("group-messages"), /最近话题/);
  await sidebarGroupRows(ui).find((row) => row.dataset.conversationId === "first-conversation").click();
  ui.get("group-message").value = "继续旧话题的草稿";
  await ui.route({ page: "chat" }); await ui.route({ page: "group", groupId: "one" }); await settle();
  assert.equal(selectedGroupTask(ui), "first-conversation"); assert.equal(ui.get("group-message").value, "继续旧话题的草稿");
  await ui.route({ page: "group", groupId: "two" }); await settle(); await ui.route({ page: "group", groupId: "one" }); await settle();
  assert.equal(selectedGroupTask(ui), "first-conversation"); assert.doesNotMatch(ui.text("group-messages"), /最近话题/);
  const restored = setup(groupsSource, request, [...ui.stored]);
  await settle(); await restored.route({ page: "group", groupId: "one" }); await settle();
  assert.equal(selectedGroupTask(restored), "first-conversation");
  restored.get("group-message").value = "继续聊"; await restored.submit("group-chat-form"); await settle();
  assert.equal(writes[0].taskId, "first-run"); assert.equal(writes[0].newTask, false);
});

test("群任务侧栏选择旧执行仍打开整段会话，停止按钮使用真实执行 ID，其他会话进度不串入", async () => {
  const state = detail(), calls = []; state.group.activeTaskId = "unrelated-run";
  state.tasks = [{ id: "first-run", conversationId: "conversation-one", goal: "第一轮", status: "completed" },
    { id: "second-run", conversationId: "conversation-one", goal: "第二轮", status: "running" },
    { id: "unrelated-run", conversationId: "conversation-two", goal: "另一个会话", status: "running" }];
  state.messages = state.tasks.map((task) => ({ id: task.id, taskId: task.id, content: task.goal, sender: { type: "user" } }));
  const ui = await readyGroup(state, { request(path) {
    if (path.endsWith("/cancel")) { calls.push(path); state.tasks[1].status = "cancelled"; return Response.json({ task: state.tasks[1] }); }
    return null;
  } });
  await ui.get("group-panel-toggle").click(); await ui.get("group-details-tasks-tab").click();
  const card = (id) => ui.get("group-tasks").children.find((item) => item.dataset.taskId === id);
  await card("first-run").children[0].click();
  assert.equal(selectedGroupTask(ui), "conversation-one"); assert.equal(groupMessageRows(ui).length, 2);
  assert.equal(ui.text("group-compose-status"), "正在处理你的消息…");
  const stopButton = card("second-run").children.at(-1); stopButton.focus(); await stopButton.click(); await settle();
  assert.deepEqual(calls, ["/api/groups/one/tasks/second-run/cancel"]); assert.equal(state.tasks[2].status, "running");
  assert.equal(selectedGroupTask(ui), "conversation-one"); assert.equal(ui.get("group-compose-status").hidden, true);
  assert.doesNotMatch(ui.text("group-messages"), /另一个会话/); assert.equal(ui.document.activeElement.id, "group-details-tasks-tab");
});

test("群材料预览和私人分享只操作明确选中的文件", async () => {
  const state = detail(); state.materials = [{ id: "material-one", name: "资料.txt", mimeType: "text/plain" }];
  const requests = [], ui = setup(groupsSource, async (path, options = {}) => {
    requests.push({ path, body: options.body ? JSON.parse(options.body) : undefined });
    if (path.endsWith("/preview")) return Response.json({ text: "资料正文" });
    if (path === "/api/collaboration/agents") return Response.json({ agents: [member()] });
    if (path.endsWith("/attachments")) return Response.json({ attachments: [{ id: "private-one", name: "私人材料.txt", size: 128 }] });
    if (path.endsWith("/files")) return Response.json({ files: [{ path: "report.txt", size: 2048 }] });
    if (path.endsWith("/share")) return Response.json({ material: { id: "shared" } });
    return Response.json(path === "/api/groups" ? { groups: [group()] } : state);
  });
  await settle(); await ui.route({ page: "group", groupId: "one" }); await settle();
  await ui.get("group-files-open").click();
  await ui.get("group-file-list").children.find((item) => item.tagName === "BUTTON").click(); await settle();
  assert.match(ui.text("group-file-preview"), /资料正文/);
  assert.equal(ui.get("group-file-actions").children[0].href, "/api/groups/one/materials/material-one/raw?download=1");
  await ui.get("group-file-actions").children[1].click();
  assert.match(ui.text("group-pending-materials"), /资料.txt/);
  await ui.get("group-share-open").click(); await settle();
  assert.equal(requests.filter((item) => item.path.endsWith("/share")).length, 0);
  const rows = ui.get("group-share-list").querySelectorAll(".group-share-item");
  assert.equal(ui.text("group-share-count"), "2");
  assert.equal(textOf(rows[0].querySelector(".group-share-file-meta")), "材料 · 128 B");
  assert.equal(textOf(rows[1].querySelector(".group-share-file-meta")), "工作成果 · 2.0 KB");
  await rows[0].querySelector("button").click(); await settle();
  assert.deepEqual(requests.find((item) => item.path.endsWith("/share")).body.attachmentId, "private-one");
});

test("分享来源自定义下拉切换只读取文件，单类失败保留另一类文件", async () => {
  const requests = [], ui = setup(groupsSource, async (path, options = {}) => {
    requests.push({ path, body: options.body ? JSON.parse(options.body) : undefined });
    if (path === "/api/collaboration/agents") return Response.json({ agents: [member(), member("reviewer", "检查助手")] });
    if (path === "/api/agents/reviewer/attachments") return Response.json({ error: "材料读取失败" }, { status: 500 });
    if (path.endsWith("/attachments")) return Response.json({ attachments: [] });
    if (path.endsWith("/files")) return Response.json({ files: [{ path: path.includes("reviewer") ? "review.html" : "draft.txt" }] });
    return Response.json(path === "/api/groups" ? { groups: [group()] } : detail());
  });
  await settle(); await ui.route({ page: "group", groupId: "one" }); await settle();
  await ui.get("group-share-open").click(); await settle();
  await ui.get("group-share-agent-trigger").click();
  assert.equal(ui.get("group-share-agent-menu").hidden, false);
  await ui.get("group-share-agent-menu").children[1].click(); await settle();
  assert.equal(ui.get("group-share-agent").value, "reviewer");
  assert.equal(ui.text("group-share-agent-value"), "检查助手");
  assert.equal(ui.get("group-share-agent-menu").hidden, true);
  assert.equal(requests.filter((item) => item.path.endsWith("/share")).length, 0);
  assert.ok(requests.some((item) => item.path === "/api/agents/reviewer/attachments"));
  assert.ok(requests.some((item) => item.path === "/api/agents/reviewer/files"));
  assert.equal(ui.text("group-share-count"), "1");
  assert.match(ui.text("group-share-list"), /review\.html/);
  assert.doesNotMatch(ui.text("group-share-list"), /draft\.txt/);
  assert.match(ui.text("group-share-status"), /材料读取失败/);
  assert.equal(ui.get("group-share-status").classList.contains("error"), true);
});

test("关闭分享弹窗后，迟到的来源或文件读取不能更新弹窗", async () => {
  for (const delayed of ["agents", "files"]) {
    const requests = []; let release;
    const ui = setup(groupsSource, async (path) => {
      requests.push(path);
      if (path === "/api/collaboration/agents") return delayed === "agents"
        ? new Promise((resolve) => { release = () => resolve(Response.json({ agents: [member()] })); })
        : Response.json({ agents: [member()] });
      if (path.endsWith("/attachments")) return Response.json({ attachments: [] });
      if (path.endsWith("/files")) return new Promise((resolve) => { release = () => resolve(Response.json({ files: [{ path: "late.txt" }] })); });
      return Response.json(path === "/api/groups" ? { groups: [group()] } : detail());
    });
    await settle(); await ui.route({ page: "group", groupId: "one" }); await settle();
    await ui.get("group-share-open").click(); await settle();
    await ui.get("group-share-close").click();
    const before = { list: ui.text("group-share-list"), value: ui.text("group-share-agent-value"), count: ui.text("group-share-count"), status: ui.text("group-share-status") };
    release(); await settle();
    assert.equal(ui.get("group-share-dialog").open, false);
    assert.equal(ui.get("group-share-agent-menu").hidden, true);
    assert.equal(ui.document.activeElement, ui.get("group-attachment-menu-toggle"));
    assert.deepEqual({ list: ui.text("group-share-list"), value: ui.text("group-share-agent-value"), count: ui.text("group-share-count"), status: ui.text("group-share-status") }, before);
    if (delayed === "agents") assert.equal(requests.some((path) => /\/(?:attachments|files)$/.test(path)), false);
  }
});

test("来源切换后旧文件响应不能覆盖当前来源列表", async () => {
  let release;
  const ui = setup(groupsSource, async (path) => {
    if (path === "/api/collaboration/agents") return Response.json({ agents: [member(), member("reviewer", "检查助手")] });
    if (path.endsWith("/attachments")) return Response.json({ attachments: [] });
    if (path === "/api/agents/writer/files") return new Promise((resolve) => { release = () => resolve(Response.json({ files: [{ path: "old.txt" }] })); });
    if (path === "/api/agents/reviewer/files") return Response.json({ files: [{ path: "current.txt" }] });
    return Response.json(path === "/api/groups" ? { groups: [group()] } : detail());
  });
  await settle(); await ui.route({ page: "group", groupId: "one" }); await settle();
  await ui.get("group-share-open").click(); await settle();
  await ui.get("group-share-agent-trigger").click(); await ui.get("group-share-agent-menu").children[1].click(); await settle();
  assert.match(ui.text("group-share-list"), /current\.txt/);
  release(); await settle();
  assert.equal(ui.text("group-share-count"), "1");
  assert.match(ui.text("group-share-list"), /current\.txt/);
  assert.doesNotMatch(ui.text("group-share-list"), /old\.txt/);
  assert.equal(ui.text("group-share-agent-value"), "检查助手");
});

test("文件分享失败可用同一幂等标识重试，成功后不能重复提交", async () => {
  const shares = []; let release;
  const ui = setup(groupsSource, async (path, options = {}) => {
    if (path === "/api/collaboration/agents") return Response.json({ agents: [member()] });
    if (path.endsWith("/attachments")) return Response.json({ attachments: [] });
    if (path.endsWith("/files")) return Response.json({ files: [{ path: "report.html" }] });
    if (path.endsWith("/share")) {
      shares.push(JSON.parse(options.body));
      return shares.length === 1 ? Response.json({ error: "暂时不能分享" }, { status: 503 })
        : new Promise((resolve) => { release = () => resolve(Response.json({ material: { id: "shared" } })); });
    }
    return Response.json(path === "/api/groups" ? { groups: [group()] } : detail());
  });
  await settle(); await ui.route({ page: "group", groupId: "one" }); await settle();
  await ui.get("group-share-open").click(); await settle();
  const action = ui.get("group-share-list").querySelector(".group-share-item").querySelector("button");
  await action.click(); await settle();
  assert.equal(action.disabled, false); assert.equal(action.textContent, "分享");
  assert.match(ui.text("group-share-status"), /暂时不能分享/);
  const secondClick = action.click(); await settle();
  assert.equal(action.disabled, true); assert.equal(action.textContent, "分享中…");
  await action.click(); assert.equal(shares.length, 2);
  release(); await secondClick; await settle();
  assert.equal(shares[0].path, "report.html"); assert.equal(shares[0].agentId, "writer");
  assert.equal(shares[1].mutationId, shares[0].mutationId);
  assert.equal(action.disabled, true); assert.equal(action.dataset.state, "shared");
  assert.equal(action.textContent, "✓ 已分享");
  assert.equal(ui.get("group-share-status").classList.contains("error"), false);
  await action.click(); assert.equal(shares.length, 2);
});

test("主助理历史自动恢复，创建页面和群页不会清除它，来源链接可安全打开", async () => {
  const conversation = { id: "main-one", title: "持续工作", messages: [{ id: "r", role: "assistant", content: "已查看 #group/one #agent/writer", status: "complete",
    actions: [{ type: "create_agent", href: "#create", label: "创建智能体" }, { href: "javascript:alert(1)", label: "不安全链接" }],
    sources: [{ href: "#chat", label: "返回主对话" }, { href: "https://example.com", label: "外部链接" }] }] };
  const ui = setup(mainSource, async (path) => Response.json(path === "/api/main/conversations" ? { conversations: [conversation] }
    : path === "/api/activity" ? { agents: [], groups: [], tasks: [] } : { conversation }));
  await ui.route({ page: "chat" }); await settle();
  assert.equal(ui.get("main-refresh").hidden, true); assert.equal(ui.get("main-recovery").hidden, true);
  assert.equal(ui.get("main-conversation-title").hidden, false);
  assert.match(ui.text("main-messages"), /已查看/);
  const row = ui.get("main-messages").children[0];
  const links = row.children.find((item) => item.className === "collaboration-links");
  assert.deepEqual(links.children.map((item) => item.href), ["#group/one", "#agent/writer", "#create", "#chat"]);
  assert.equal(row.children.find(isBubble).textContent, "已查看");
  ui.get("main-message").value = "未发送的主助理草稿";
  await ui.route({ page: "create" }); await ui.route({ page: "group", groupId: "one" }); await ui.route({ page: "chat" }); await settle();
  assert.equal(ui.get("main-message").value, "未发送的主助理草稿");
  assert.equal(ui.stored.get("neuma.main.active-conversation.v1"), "main-one");
  assert.equal(ui.get("main-refresh").hidden, true); assert.equal(ui.get("main-recovery").hidden, true);
});

test("主历史或详情首次读取失败后显示重新加载，恢复仅读取数据并保留未发送输入", async () => {
  for (const failedSource of ["history", "conversation"]) {
    const conversation = { id: "main-one", title: "已保存的工作", messages: [{ role: "assistant", content: "服务端保存的回复", status: "complete" }] };
    const requests = []; let failing = true;
    const ui = setup(mainSource, async (path, options = {}) => {
      requests.push({ path, method: options.method || "GET" });
      if (failing && (failedSource === "history" ? path === "/api/main/conversations" : path === "/api/main/conversations/main-one")) throw new Error("读取暂时中断");
      return Response.json(path === "/api/main/conversations" ? { conversations: [conversation] } : { conversation });
    });
    await ui.route({ page: "chat" }); await settle();
    assert.equal(ui.get("main-refresh").hidden, false, failedSource); assert.equal(ui.get("main-recovery").hidden, false, failedSource);
    assert.match(ui.text(failedSource === "history" ? "main-history-status" : "main-error"), /读取暂时中断/);
    ui.get("main-message").value = "尚未发送的工作要求";
    failing = false; await ui.get("main-refresh").click(); await settle();
    assert.match(ui.text("main-messages"), /服务端保存的回复/);
    assert.equal(ui.get("main-message").value, "尚未发送的工作要求", failedSource);
    assert.equal(ui.get("main-refresh").hidden, true, failedSource); assert.equal(ui.get("main-recovery").hidden, true, failedSource);
    assert.equal(ui.text("main-history-status"), ""); assert.equal(ui.text("main-error"), "");
    assert.equal(requests.every(({ method, path }) => method === "GET" && ["/api/main/conversations", "/api/main/conversations/main-one"].includes(path)), true);
  }
});

test("主详情和历史的恢复状态独立，另一个读取成功不能隐藏仍然失败的重新加载入口", async () => {
  const conversation = { id: "main-one", title: "持续工作", messages: [{ role: "assistant", content: "服务端已保存的内容", status: "complete" }] };
  const requests = []; let failHistory = false, failConversation = false;
  const ui = setup(mainSource, async (path, options = {}) => {
    requests.push({ path, method: options.method || "GET" });
    if (path.endsWith("/messages")) throw new Error("回复连接中断");
    if (path === "/api/main/conversations" && failHistory) throw new Error("历史读取中断");
    if (path === "/api/main/conversations/main-one" && failConversation) throw new Error("详情读取中断");
    return Response.json(path === "/api/main/conversations" ? { conversations: [conversation] } : { conversation });
  });
  await ui.route({ page: "chat" }); await settle(); ui.get("main-message").value = "继续分析材料";
  failHistory = true; await ui.submit("main-chat-form"); await settle();
  assert.equal(ui.get("main-refresh").hidden, false); assert.equal(ui.get("main-recovery").hidden, false);
  await ui.get("main-refresh").click(); await settle();
  assert.match(ui.text("main-messages"), /服务端已保存的内容/); assert.match(ui.text("main-history-status"), /历史读取中断/);
  assert.equal(ui.get("main-refresh").hidden, false); assert.equal(ui.get("main-recovery").hidden, false);
  failHistory = false; failConversation = true; await ui.get("main-refresh").click(); await settle();
  assert.equal(ui.text("main-history-status"), ""); assert.match(ui.text("main-error"), /详情读取中断/);
  assert.equal(ui.get("main-refresh").hidden, false); assert.equal(ui.get("main-recovery").hidden, false);
  failConversation = false; await ui.get("main-refresh").click(); await settle();
  assert.equal(ui.text("main-history-status"), ""); assert.equal(ui.text("main-error"), "");
  assert.equal(ui.get("main-refresh").hidden, true); assert.equal(ui.get("main-recovery").hidden, true);
  assert.equal(ui.get("main-message").value, "继续分析材料");
  assert.deepEqual(requests.filter(({ method }) => method !== "GET"), [{ path: "/api/main/conversations/main-one/messages", method: "POST" }]);
});

test("主历史使用纯气泡，移除身份与时间但保留正文中的称呼", async () => {
  const conversation = { id: "main-one", title: "持续工作", messages: [
    { id: "u", role: "user", content: "我需要你帮我整理材料", createdAt: "2026-10-12T02:00:00.000Z" },
    { id: "r", role: "assistant", sender: { type: "assistant", name: "不应出现的身份" }, recipientId: "writer",
      content: "NEUMA 可以帮你整理", status: "complete", createdAt: "2026-10-12T02:00:01.000Z" },
  ] };
  const ui = setup(mainSource, async (path) => Response.json(path === "/api/main/conversations" ? { conversations: [conversation] } : { conversation }));
  await ui.route({ page: "chat" }); await settle();
  const rows = ui.get("main-messages").children;
  assert.equal(rows.length, 2);
  for (const [index, role, label] of [[0, "user", "发送的消息"], [1, "assistant", "助理的回复"]]) {
    const row = rows[index], body = row.children.find(isBubble);
    assert.equal(row.className, `message ${role}`); assert.equal(row.getAttribute("role"), "group");
    assert.equal(row.getAttribute("aria-label"), label); assert.equal(body.textContent, conversation.messages[index].content);
    assert.equal(row.querySelectorAll("*").some((item) => item.className.startsWith("collaboration-message-") || item.tagName === "TIME"), false);
    assert.equal(textOf(row), conversation.messages[index].content);
  }
});

test("主流式纯气泡先显示处理占位，再显示增量正文和流式状态", async () => {
  const conversation = { id: "main-one", title: "持续工作", messages: [] };
  let streamController;
  const ui = setup(mainSource, async (path) => {
    if (path.endsWith("/messages")) return new Response(new ReadableStream({ start(controller) { streamController = controller; } }),
      { headers: { "content-type": "application/x-ndjson" } });
    return Response.json(path === "/api/main/conversations" ? { conversations: [conversation] } : { conversation });
  });
  await ui.route({ page: "chat" }); await settle(); ui.get("main-message").value = "整理材料";
  assert.equal(ui.text("main-progress"), ""); assert.equal(ui.get("main-progress").hidden, true);
  await ui.submit("main-chat-form"); await settle();
  assert.equal(ui.get("main-new-chat").disabled, true); assert.equal(ui.get("main-new-chat").hidden, false);
  assert.equal(mainHistoryMore(ui, conversation.id).disabled, true);
  await mainHistoryMore(ui, conversation.id).click();
  assert.equal(ui.get("main-history-menu").hidden, true); assert.equal(ui.confirmations.length, 0);
  let reply = ui.get("main-messages").children.find((item) => item.className === "message assistant");
  assert.equal(reply.children.find(isBubble).textContent, "正在处理…");
  assert.equal(reply.children.some((item) => item.className === "collaboration-message-heading"), false);
  streamController.enqueue(new TextEncoder().encode([
    { type: "status", label: "正在整理材料…" }, { type: "text-start" },
    { type: "text-delta", delta: "已整理" }, { type: "text-delta", delta: "第一份材料" },
  ].map(JSON.stringify).join("\n") + "\n"));
  await settle(); reply = ui.get("main-messages").children.find((item) => item.className === "message assistant");
  const body = reply.children.find(isBubble);
  assert.equal(ui.text("main-progress"), "正在整理材料…"); assert.equal(ui.get("main-progress").hidden, false);
  assert.equal(body.textContent, "已整理第一份材料"); assert.equal(body.classes.has("streaming"), true);
  assert.equal(textOf(reply), "已整理第一份材料");
  streamController.enqueue(new TextEncoder().encode(JSON.stringify({ type: "done", result: { reply: "已整理第一份材料",
    conversation: { ...conversation, messages: [{ role: "user", content: "整理材料" },
      { role: "assistant", content: "已整理第一份材料", status: "complete" }] } } }) + "\n"));
  streamController.close(); await settle();
  const completed = ui.get("main-messages").children.find((item) => item.className === "message assistant");
  assert.equal(completed.children.find(isBubble).classes.has("streaming"), false);
  assert.equal(ui.get("main-new-chat").disabled, false); assert.equal(ui.get("main-new-chat").hidden, false);
  assert.equal(ui.get("main-refresh").hidden, true); assert.equal(ui.get("main-recovery").hidden, true);
  assert.equal(ui.text("main-progress"), ""); assert.equal(ui.get("main-progress").hidden, true);
});

test("主历史异常纯气泡保留部分正文和真实失败、停止及中断状态", async () => {
  const statuses = [["failed", "失败"], ["error", "回复未完成"], ["cancelled", "已停止"], ["interrupted", "已中断"]];
  const conversation = { id: "main-one", title: "持续工作", messages: statuses.map(([status]) => ({
    id: status, role: "assistant", content: `已保留的片段 ${status}`, status,
  })) };
  const ui = setup(mainSource, async (path) => Response.json(path === "/api/main/conversations" ? { conversations: [conversation] } : { conversation }));
  await ui.route({ page: "chat" }); await settle();
  const rows = ui.get("main-messages").children;
  assert.equal(rows.length, statuses.length);
  for (const [index, [status, label]] of statuses.entries()) {
    const row = rows[index]; assert.equal(row.className, "message assistant");
    assert.equal(row.children.find(isBubble).textContent, `已保留的片段 ${status}`);
    assert.equal(row.children.find((item) => item.tagName === "P").textContent, label);
    assert.equal(row.children.some((item) => item.className === "collaboration-message-heading"), false);
  }
});

test("主助理空白页只显示宽对话和可折叠历史，不读取常驻工作概览", async () => {
  const requests = [], ui = setup(mainSource, async (path) => { requests.push(path); return Response.json({ conversations: [] }); });
  await ui.route({ page: "chat" }); await settle();
  assertDisclosure(ui.get("main-context-panel"), false);
  assert.equal(ui.get("main-workspace").classes.has("context-open"), false);
  assert.equal(requests.includes("/api/activity"), false);
  ui.get("main-message").value = "保留的草稿";
  const toggleIcon = ui.document.createElement("svg"); ui.get("main-history-toggle").append(toggleIcon);
  ui.get("main-new-chat").focus();
  await ui.get("main-history-toggle").click();
  assertDisclosure(ui.get("main-history-body"), false); assert.equal(ui.get("main-history-toggle").hidden, false);
  assert.equal(ui.get("main-new-chat").hidden, false); assert.equal(ui.get("main-new-chat").inert === true, false);
  assert.notEqual(ui.get("main-new-chat").getAttribute("aria-hidden"), "true");
  assert.equal(ui.document.activeElement, ui.get("main-new-chat"));
  assert.equal(ui.get("main-conversation-title").hidden, true);
  assert.equal(ui.get("main-history-toggle").title, "展开历史对话");
  assert.equal(ui.get("main-history-toggle").getAttribute("aria-expanded"), "false");
  assert.equal(ui.get("main-history-toggle").children[0], toggleIcon);
  assert.equal(ui.get("main-history").classes.has("history-collapsed"), true);
  assert.equal(ui.get("main-workspace").classes.has("history-collapsed"), false);
  assert.equal(ui.stored.get("neuma.main.history-collapsed.v1"), "true");
  assert.equal(ui.get("main-message").value, "保留的草稿");
  const restored = setup(mainSource, async () => Response.json({ conversations: [] }), [...ui.stored]);
  assertDisclosure(restored.get("main-history-body"), false);
  assert.equal(restored.get("main-new-chat").hidden, false); assert.equal(restored.get("main-new-chat").inert === true, false);
  assert.notEqual(restored.get("main-new-chat").getAttribute("aria-hidden"), "true");
  await restored.get("main-history-toggle").click(); assertDisclosure(restored.get("main-history-body"), true);
  assert.equal(restored.get("main-new-chat").hidden, false);
  assert.equal(restored.get("main-history-toggle").title, "收起历史对话");
});

test("历史连续收起展开即时转移焦点，最终状态和草稿保持一致", async () => {
  const ui = setup(mainSource, async () => Response.json({ conversations: [] }));
  await ui.route({ page: "chat" }); await settle();
  ui.get("main-message").value = "动画期间保留的草稿";
  const toggle = ui.get("main-history-toggle"), historyItem = ui.document.createElement("button");
  ui.get("main-history-body").append(historyItem); historyItem.focus();
  const closing = toggle.click();
  assert.equal(ui.document.activeElement, toggle);
  assertDisclosure(ui.get("main-history-body"), false); assert.equal(ui.get("main-new-chat").hidden, false);
  await closing;
  for (let index = 0; index < 5; index++) {
    ui.get("main-new-chat").focus();
    await toggle.click();
    const visible = index % 2 === 0;
    assertDisclosure(ui.get("main-history-body"), visible); assert.equal(ui.get("main-new-chat").hidden, false);
    assert.equal(ui.get("main-new-chat").inert === true, false); assert.equal(ui.document.activeElement, ui.get("main-new-chat"));
    assert.equal(ui.get("main-history").classes.has("history-collapsed"), !visible);
    assert.equal(ui.get("main-workspace").classes.has("history-collapsed"), false);
    assert.equal(toggle.getAttribute("aria-expanded"), String(visible));
    assert.equal(ui.get("main-message").value, "动画期间保留的草稿");
  }
  assert.equal(ui.stored.get("neuma.main.history-collapsed.v1"), "false");
  assert.equal(toggle.title, "收起历史对话");
});

test("主对话历史保留完整标题提示，选中状态随切换更新", async () => {
  const conversations = [{ id: "main-long", title: "真实模型连通性测试：请用一句话确认你收到了这条消息。", messages: [] },
    { id: "main-empty", title: "", messages: [] }];
  const ui = setup(mainSource, async (path) => Response.json(path === "/api/main/conversations" ? { conversations }
    : { conversation: conversations.find((record) => path.endsWith(record.id)) }));
  await ui.route({ page: "chat" }); await settle();
  let items = mainHistoryItems(ui);
  assert.equal(items[0].title, conversations[0].title); assert.equal(items[0].textContent, conversations[0].title);
  assert.equal(items[0].getAttribute("aria-current"), "true"); assert.equal(items[1].getAttribute("aria-current"), "false");
  assert.equal(items[1].title, "新对话"); assert.equal(items[1].textContent, "新对话");
  await items[1].click(); await settle(); items = mainHistoryItems(ui);
  assert.equal(items[0].getAttribute("aria-current"), "false"); assert.equal(items[1].getAttribute("aria-current"), "true");
  ui.get("main-history-body").append(ui.get("main-history-list"));
  items[1].focus(); await ui.get("main-history-toggle").click();
  assert.equal(ui.document.activeElement, ui.get("main-history-toggle"));
});

test("主导航历史默认只展示前四条，展开全部及收起不改变主对话草稿", async () => {
  const conversations = Array.from({ length: 6 }, (_, index) => ({ id: `main-${index}`, title: `对话 ${index + 1}`, messages: [] }));
  const ui = setup(mainSource, async (path) => Response.json(path === "/api/main/conversations" ? { conversations }
    : { conversation: conversations.find((record) => path.endsWith(record.id)) }));
  await ui.route({ page: "agents" }); await settle();
  const visible = () => ui.get("main-history-list").children.filter((row) => !row.hidden);
  const more = ui.get("main-history-more-toggle");
  assert.equal(visible().length, 4); assert.equal(more.hidden, false); assert.equal(more.getAttribute("aria-expanded"), "false");
  ui.get("main-message").value = "独立的主对话草稿";
  await more.click(); assert.equal(visible().length, 6); assert.equal(more.textContent, "收起显示");
  assert.equal(more.getAttribute("aria-expanded"), "true");
  mainHistoryItems(ui)[5].focus(); await more.click();
  assert.equal(visible().length, 4); assert.equal(ui.document.activeElement, more); assert.equal(more.textContent, "展开显示");
  assert.equal(ui.get("main-message").value, "独立的主对话草稿");
  await ui.get("main-history-toggle").click(); await ui.route({ page: "projects" });
  assertDisclosure(ui.get("main-history-body"), false);
  await ui.get("sidebar-main-link").click(); assertDisclosure(ui.get("main-history-body"), true);
  assert.equal(visible().length, 4); assert.equal(ui.get("main-message").value, "独立的主对话草稿");
});

test("NEUMA整行标题、图标和空白反复折叠，独立箭头只切换一次且空格不因长按重复", async () => {
  const requests = [], ui = setup(mainSource, async (path) => { requests.push(path); return Response.json({ conversations: [] }); });
  await ui.route({ page: "chat" }); await settle();
  const link = ui.get("sidebar-main-link"), heading = ui.get("sidebar-main-heading"), toggle = ui.get("main-history-toggle");
  const activate = async (target) => { const event = { type: "click", target, bubbles: true }; await target.dispatchEvent(event); return event; };
  const expanded = (open) => {
    assertDisclosure(ui.get("main-history-body"), open);
    assert.equal(link.getAttribute("aria-expanded"), String(open)); assert.equal(toggle.getAttribute("aria-expanded"), String(open));
  };
  const reads = requests.length; expanded(true);
  ui.get("main-message").value = "保留NEUMA草稿"; ui.get("main-create-group").focus();
  assert.equal((await activate(link)).defaultPrevented, true); expanded(false);
  assert.notEqual((await activate(link.children[0])).defaultPrevented, true); expanded(true);
  await activate(link.children[1]); expanded(false); await activate(heading); expanded(true);
  await activate(toggle); expanded(false); await activate(toggle); expanded(true);
  const closing = await ui.key(link, " "); assert.equal(closing.defaultPrevented, true); expanded(false);
  const repeating = await ui.key(link, " ", { repeat: true }); assert.equal(repeating.defaultPrevented, true); expanded(false);
  await ui.key(link, " "); expanded(true);
  assert.equal(ui.get("main-message").value, "保留NEUMA草稿"); assert.equal(ui.document.activeElement.id, "main-create-group");
  assert.equal(requests.length, reads); assert.equal(ui.get("main-workspace").classes.has("history-collapsed"), false);
});

test("主导航中的历史离开主聊后仍可打开准确会话，切换保留各自主草稿", async () => {
  const conversations = [{ id: "main-a", title: "主对话 A", messages: [] }, { id: "main-b", title: "主对话 B", messages: [] }], navigations = [], reads = [];
  const ui = setup(mainSource, async (path) => {
    reads.push(path); return Response.json(path === "/api/main/conversations" ? { conversations }
      : { conversation: conversations.find((record) => path.endsWith(record.id)) });
  });
  ui.document.addEventListener("neuma:navigate", (event) => { navigations.push(event.detail); return ui.route(event.detail); });
  await ui.route({ page: "chat" }); await settle(); ui.get("main-message").value = "草稿 A";
  await ui.route({ page: "agents" }); await mainHistoryItems(ui)[1].click(); await settle();
  assert.deepEqual(navigations.map((route) => route.page), ["chat"]);
  assert.equal(ui.stored.get("neuma.main.active-conversation.v1"), "main-b"); assert.equal(ui.get("main-message").value, "");
  ui.get("main-message").value = "草稿 B";
  await ui.route({ page: "projects" }); await mainHistoryItems(ui)[0].click(); await settle();
  assert.equal(ui.get("main-message").value, "草稿 A");
  await mainHistoryItems(ui)[1].click(); await settle(); assert.equal(ui.get("main-message").value, "草稿 B");
  assert.equal(reads.filter((path) => path === "/api/main/conversations").length, 1);
});

test("首次列表仍在读取时主聊顶部新建不会被旧的自动恢复抢走", async () => {
  const original = { id: "main-original", title: "旧对话", messages: [] }, created = { id: "main-created", title: "新对话", messages: [] };
  let release, listReads = 0, createdOnServer = false;
  const details = [], ui = setup(mainSource, async (path, options = {}) => {
    if (path === "/api/main/conversations" && options.method === "POST") { createdOnServer = true; return Response.json({ conversation: created }); }
    if (path === "/api/main/conversations") {
      if (++listReads === 1) return new Promise((resolve) => { release = () => resolve(Response.json({ conversations: [original] })); });
      return Response.json({ conversations: createdOnServer ? [created, original] : [original] });
    }
    details.push(path); return Response.json({ conversation: original });
  });
  ui.document.addEventListener("neuma:navigate", (event) => ui.route(event.detail));
  await ui.route({ page: "chat" }); await settle(); ui.get("main-message").value = "首次未发送草稿";
  await ui.get("main-new-chat").click(); await settle();
  assert.equal(createdOnServer, true); release(); await settle();
  assert.equal(ui.stored.get("neuma.main.active-conversation.v1"), created.id);
  assert.equal(ui.get("main-message").value, ""); assert.deepEqual(details, []);
  assert.equal(mainHistoryItems(ui).find((item) => item.dataset.conversationId === created.id).getAttribute("aria-current"), "true");
});

test("主聊顶部新建完成尊重离页或在主聊中另选控件后的焦点", async () => {
  for (const nextPage of ["projects", "chat"]) {
    const original = { id: "main-original", title: "旧对话", messages: [] }, created = { id: "main-created", title: "新对话", messages: [] };
    let release, createdOnServer = false;
    const ui = setup(mainSource, async (path, options = {}) => {
      if (path === "/api/main/conversations" && options.method === "POST") return new Promise((resolve) => {
        release = () => { createdOnServer = true; resolve(Response.json({ conversation: created })); };
      });
      return Response.json(path === "/api/main/conversations" ? { conversations: createdOnServer ? [created, original] : [original] }
        : { conversation: original });
    });
    await ui.route({ page: "chat" }); await settle(); ui.get("main-new-chat").focus();
    await ui.get("main-new-chat").click(); await settle(); await ui.route({ page: nextPage });
    const target = ui.get(nextPage === "projects" ? "project-message" : "main-create-group"); target.focus();
    release(); await settle();
    assert.equal(ui.stored.get("neuma.main.active-conversation.v1"), created.id);
    assert.equal(ui.document.activeElement, target);
  }
});

test("离页主历史删除失败返回仍可见的操作按钮，用户已移焦时保留外页焦点", async () => {
  for (const moved of [false, true]) {
    const conversation = { id: "main-one", title: "删除未完成的主对话", version: 1, messages: [] };
    let release;
    const ui = setup(mainSource, async (path) => path.endsWith("/remove") ? new Promise((resolve) => {
      release = () => resolve(Response.json({ error: "服务暂时不可用" }, { status: 503 }));
    }) : Response.json(path === "/api/main/conversations" ? { conversations: [conversation] } : { conversation }), [], { confirm: () => true });
    await ui.route({ page: "projects" }); await settle();
    await mainHistoryMore(ui, conversation.id).click();
    const removing = ui.get("main-history-delete").click(); await settle();
    const target = moved ? ui.get("project-message") : ui.document.body; target.focus();
    release(); await removing; await settle();
    assert.match(ui.text("main-history-status"), /删除未完成/);
    assert.equal(ui.document.activeElement, moved ? target : mainHistoryMore(ui, conversation.id));
  }
});

test("主历史删除菜单标识完整对话，键盘关闭归还焦点，取消确认不写入", async () => {
  const conversation = { id: "main-one", title: "完整的历史对话标题", version: 4, messages: [] }, requests = [];
  const ui = setup(mainSource, async (path, options = {}) => {
    requests.push({ path, method: options.method || "GET" });
    return Response.json(path === "/api/main/conversations" ? { conversations: [conversation] } : { conversation });
  });
  await ui.route({ page: "chat" }); await settle(); ui.get("main-message").value = "尚未发送的草稿";
  const more = mainHistoryMore(ui, conversation.id), menu = ui.get("main-history-menu"), remove = ui.get("main-history-delete");
  assert.equal(more.getAttribute("aria-label"), `对话操作：${conversation.title}`);
  assert.equal(more.getAttribute("aria-haspopup"), "menu");
  await more.dispatchEvent({ type: "keydown", key: "ArrowDown", preventDefault() {} });
  assert.equal(menu.hidden, false); assert.equal(ui.document.activeElement, remove);
  assert.equal(remove.textContent, "删除对话");
  await ui.document.dispatchEvent({ type: "keydown", key: "Escape", preventDefault() {} });
  assert.equal(menu.hidden, true); assert.equal(ui.document.activeElement, more);
  await removeMainHistory(ui, conversation.id);
  assert.equal(ui.confirmations.length, 1); assert.match(ui.confirmations[0], /完整的历史对话标题/);
  assert.equal(requests.some(({ method }) => method !== "GET"), false);
  assert.equal(mainHistoryItems(ui).length, 1); assert.equal(ui.get("main-message").value, "尚未发送的草稿");
});

test("删除非当前主历史只移除指定身份，保留当前消息和草稿", async () => {
  let conversations = [{ id: "main-current", title: "当前工作", version: 2,
    messages: [{ role: "assistant", content: "当前工作内容", status: "complete" }] },
  { id: "history/to-remove", title: "要删除的旧工作", version: 7, messages: [] }];
  const requests = [], ui = setup(mainSource, async (path, options = {}) => {
    requests.push({ path, options });
    if (path.endsWith("/remove")) { conversations = conversations.filter((item) => item.id !== "history/to-remove");
      return Response.json({ removed: true, conversationId: "history/to-remove" }); }
    return Response.json(path === "/api/main/conversations" ? { conversations } : { conversation: conversations[0] });
  }, [], { confirm: () => true });
  await ui.route({ page: "chat" }); await settle(); ui.get("main-message").value = "当前草稿";
  await removeMainHistory(ui, "history/to-remove");
  const writes = requests.filter(({ options }) => options.method === "POST");
  assert.equal(writes.length, 1); assert.equal(writes[0].path, "/api/main/conversations/history%2Fto-remove/remove");
  const body = JSON.parse(writes[0].options.body);
  assert.equal(body.confirm, true); assert.equal(body.expectedVersion, 7); assert.ok(body.mutationId);
  assert.match(ui.confirmations[0], /要删除的旧工作/);
  assert.deepEqual(mainHistoryItems(ui).map((item) => item.textContent), ["当前工作"]);
  assert.equal(ui.stored.get("neuma.main.active-conversation.v1"), "main-current");
  assert.match(ui.text("main-messages"), /当前工作内容/); assert.equal(ui.get("main-message").value, "当前草稿");
});

test("删除当前主历史恢复另一会话草稿，删除最后一项回到欢迎页且不创建新记录", async () => {
  let conversations = [{ id: "main-a", title: "工作 A", version: 1,
    messages: [{ role: "assistant", content: "A 的历史", status: "complete" }] },
  { id: "main-b", title: "工作 B", version: 3,
    messages: [{ role: "assistant", content: "B 的历史", status: "complete" }] }];
  const writes = [], ui = setup(mainSource, async (path, options = {}) => {
    if (options.method === "POST") {
      writes.push(path); const id = decodeURIComponent(path.split("/").at(-2));
      conversations = conversations.filter((item) => item.id !== id);
      return Response.json({ removed: true, conversationId: id });
    }
    return Response.json(path === "/api/main/conversations" ? { conversations }
      : { conversation: conversations.find((item) => path.endsWith(item.id)) });
  }, [], { confirm: () => true });
  await ui.route({ page: "chat" }); await settle(); ui.get("main-message").value = "A 的草稿";
  await mainHistoryItems(ui)[1].click(); await settle(); ui.get("main-message").value = "B 的草稿";
  await mainHistoryItems(ui)[0].click(); await settle(); assert.equal(ui.get("main-message").value, "A 的草稿");
  await removeMainHistory(ui, "main-a");
  assert.equal(ui.stored.get("neuma.main.active-conversation.v1"), "main-b");
  assert.match(ui.text("main-messages"), /B 的历史/); assert.doesNotMatch(ui.text("main-messages"), /A 的历史/);
  assert.equal(ui.get("main-message").value, "B 的草稿");
  await removeMainHistory(ui, "main-b");
  assert.equal(mainHistoryItems(ui).length, 0); assert.match(ui.text("main-messages"), /今天，想先完成什么/);
  assert.equal(ui.get("main-message").value, ""); assert.equal(ui.stored.get("neuma.main.active-conversation.v1"), "");
  assert.deepEqual(writes, ["/api/main/conversations/main-a/remove", "/api/main/conversations/main-b/remove"]);
  assert.equal(ui.get("main-send").disabled, false); assert.equal(ui.get("main-new-chat").disabled, false);
});

test("主历史删除失败保留记录和草稿，未知结果重试复用同一删除操作", async () => {
  const conversation = { id: "main-one", title: "保留直到删除确认", version: 5,
    messages: [{ role: "assistant", content: "仍应保留的正文", status: "complete" }] };
  let attempts = 0, conversations = [conversation]; const writes = [];
  const ui = setup(mainSource, async (path, options = {}) => {
    if (path.endsWith("/remove")) {
      writes.push(JSON.parse(options.body));
      if (++attempts === 1) throw new Error("删除响应中断");
      conversations = []; return Response.json({ removed: true, conversationId: conversation.id });
    }
    return Response.json(path === "/api/main/conversations" ? { conversations } : { conversation });
  }, [], { confirm: () => true });
  await ui.route({ page: "chat" }); await settle(); ui.get("main-message").value = "不能丢失的草稿";
  await removeMainHistory(ui, conversation.id);
  assert.match(ui.text("main-history-status"), /删除响应中断/); assert.equal(mainHistoryItems(ui).length, 1);
  assert.equal(ui.get("main-message").value, "不能丢失的草稿"); assert.match(ui.text("main-messages"), /仍应保留的正文/);
  assert.equal(ui.stored.get("neuma.main.active-conversation.v1"), conversation.id);
  await removeMainHistory(ui, conversation.id); assert.deepEqual(writes[1], writes[0]);
  assert.equal(mainHistoryItems(ui).length, 0); assert.match(ui.text("main-messages"), /今天，想先完成什么/);
});

test("主历史服务端拒绝或身份未确认时不能伪造删除成功", async () => {
  for (const outcome of ["busy", "identity"]) {
    const conversation = { id: "main-one", title: "不可误删的历史", version: 2,
      messages: [{ role: "assistant", content: "原消息", status: "complete" }] }, requests = [];
    const ui = setup(mainSource, async (path, options = {}) => {
      requests.push(path);
      if (path.endsWith("/remove")) return outcome === "busy"
        ? Response.json({ error: "请先停止当前任务", reason: "busy" }, { status: 409 })
        : Response.json({ removed: true, conversationId: "other" });
      return Response.json(path === "/api/main/conversations" ? { conversations: [conversation] } : { conversation });
    }, [], { confirm: () => true });
    await ui.route({ page: "chat" }); await settle(); ui.get("main-message").value = "原草稿";
    await removeMainHistory(ui, conversation.id);
    assert.equal(mainHistoryItems(ui).length, 1, outcome); assert.equal(ui.get("main-message").value, "原草稿", outcome);
    assert.match(ui.text("main-messages"), /原消息/); assert.equal(requests.some((path) => path.endsWith("/cancel")), false);
    assert.equal(ui.get("main-send").disabled, false); assert.ok(ui.text("main-history-status"));
  }
});

test("主历史删除待确认期间锁定发送、切换、材料和需求激活，不重复提交", async () => {
  const conversations = [{ id: "main-a", title: "当前工作", version: 1, messages: [] },
    { id: "main-b", title: "删除中的旧工作", version: 2, messages: [] }];
  let finish; const requests = [], ui = setup(mainSource, async (path, options = {}) => {
    requests.push({ path, options });
    if (path.endsWith("/remove")) return new Promise((resolve) => { finish = () => resolve(Response.json({ removed: true, conversationId: "main-b" })); });
    return Response.json(path === "/api/main/conversations" ? { conversations } : { conversation: conversations[0] });
  }, [], { confirm: () => true });
  await ui.route({ page: "chat" }); await settle(); ui.get("main-message").value = "删除期间保留的草稿";
  await mainHistoryMore(ui, "main-b").click(); const removal = ui.get("main-history-delete").click(); await settle();
  assert.equal(typeof finish, "function");
  for (const id of ["main-send", "main-new-chat", "main-refresh", "main-upload", "main-materials-open", "main-history-delete"])
    assert.equal(ui.get(id).disabled, true, id);
  for (const item of mainHistoryItems(ui)) assert.equal(item.disabled, true);
  for (const item of ui.get("main-history-list").querySelectorAll(".main-history-more")) assert.equal(item.disabled, true);
  await ui.submit("main-chat-form"); await ui.get("main-new-chat").click(); await mainHistoryItems(ui)[1].click();
  await ui.get("main-create-agent").click(); await ui.get("main-history-delete").click(); await settle();
  assert.equal(requests.filter(({ options }) => options.method === "POST").length, 1);
  assert.equal(ui.get("main-message").value, "删除期间保留的草稿");
  finish(); await removal; await settle(); assert.equal(ui.get("main-send").disabled, false); assert.equal(mainHistoryItems(ui).length, 1);
  assert.equal(ui.get("main-message").value, "删除期间保留的草稿");
});

test("主历史删除后迟到的旧列表不能复活历史或替换当前会话", async () => {
  const conversation = { id: "main-one", title: "将被删除的旧历史", version: 1, messages: [] };
  let reads = 0, release, removed = false;
  const ui = setup(mainSource, async (path) => {
    if (path.endsWith("/remove")) { removed = true; return Response.json({ removed: true, conversationId: conversation.id }); }
    if (path === "/api/main/conversations") {
      if (++reads === 2) return new Promise((resolve) => { release = () => resolve(Response.json({ conversations: [conversation] })); });
      return Response.json({ conversations: removed ? [] : [conversation] });
    }
    return Response.json({ conversation });
  }, [], { confirm: () => true });
  await ui.route({ page: "chat" }); await settle();
  vm.runInContext("void list()", ui.context); await settle(); assert.equal(typeof release, "function");
  await mainHistoryMore(ui, conversation.id).click(); const removal = ui.get("main-history-delete").click(); await settle();
  release(); await removal; await settle();
  assert.equal(mainHistoryItems(ui).length, 0); assert.equal(ui.stored.get("neuma.main.active-conversation.v1"), "");
  assert.match(ui.text("main-messages"), /今天，想先完成什么/);
  assert.equal(ui.get("main-send").disabled, false);
});

test("主历史详情读取和材料上传期间不能打开删除菜单", async () => {
  const conversation = { id: "main-one", title: "安全保存的对话", version: 1, messages: [] };
  let finishDetail, finishUpload;
  const writes = [], ui = setup(mainSource, async (path, options = {}) => {
    if (options.method === "POST") writes.push(path);
    if (path === "/api/main/conversations/main-one") return new Promise((resolve) => { finishDetail = () => resolve(Response.json({ conversation })); });
    if (path.endsWith("/materials")) return new Promise((resolve) => { finishUpload = () => resolve(Response.json({ attachment: { id: "file", name: "资料.txt" } })); });
    return Response.json({ conversations: [conversation] });
  }, [], { confirm: () => true });
  await ui.route({ page: "chat" }); await settle();
  assert.equal(mainHistoryMore(ui, conversation.id).disabled, true);
  await mainHistoryMore(ui, conversation.id).click(); assert.equal(ui.get("main-history-menu").hidden, true);
  finishDetail(); await settle(); assert.equal(mainHistoryMore(ui, conversation.id).disabled, false);
  const file = Object.assign(new Blob(["资料"], { type: "text/plain" }), { name: "资料.txt" });
  await ui.get("main-file-input").dispatchEvent({ type: "change", target: { files: [file] } }); await settle();
  assert.equal(mainHistoryMore(ui, conversation.id).disabled, true);
  await mainHistoryMore(ui, conversation.id).click(); assert.equal(ui.get("main-history-menu").hidden, true);
  assert.equal(ui.confirmations.length, 0); assert.deepEqual(writes, ["/api/main/conversations/main-one/materials"]);
  finishUpload(); await settle(); assert.equal(mainHistoryMore(ui, conversation.id).disabled, false);
});

test("当前主历史删除使用详情的最新版本，缺少版本时提示重新读取而不提交", async () => {
  for (const version of [9, undefined]) {
    const record = { id: "main-one", title: "版本受保护的对话", version: 1, messages: [] }, writes = [];
    const conversation = { ...record, version };
    const ui = setup(mainSource, async (path, options = {}) => {
      if (path.endsWith("/remove")) { writes.push(JSON.parse(options.body)); return Response.json({ removed: true, conversationId: record.id }); }
      return Response.json(path === "/api/main/conversations" ? { conversations: [record] } : { conversation });
    }, [], { confirm: () => true });
    await ui.route({ page: "chat" }); await settle(); await removeMainHistory(ui, record.id);
    if (version === undefined) {
      assert.equal(writes.length, 0); assert.match(ui.text("main-history-status"), /版本尚未确认/);
      assert.equal(mainHistoryItems(ui).length, 1);
    } else assert.equal(writes[0].expectedVersion, version);
  }
});

test("创建主对话等待旧列表后重新读取，新增记录不会被迟到结果漏掉", async () => {
  const original = { id: "main-old", title: "已有工作", version: 1, messages: [] }, created = { id: "main-new", title: "新工作", version: 1, messages: [] };
  let conversations = [original], reads = 0, release;
  const ui = setup(mainSource, async (path, options = {}) => {
    if (path === "/api/main/conversations" && options.method === "POST") { conversations = [created, original]; return Response.json({ conversation: created }); }
    if (path === "/api/main/conversations") {
      if (++reads === 2) return new Promise((resolve) => { release = () => resolve(Response.json({ conversations: [original] })); });
      return Response.json({ conversations });
    }
    return Response.json({ conversation: original });
  });
  await ui.route({ page: "chat" }); await settle();
  vm.runInContext("void list()", ui.context); await settle(); await ui.get("main-new-chat").click(); await settle();
  release(); await settle();
  assert.equal(reads, 3); assert.deepEqual(mainHistoryItems(ui).map((item) => item.textContent), ["新工作", "已有工作"]);
  assert.equal(ui.stored.get("neuma.main.active-conversation.v1"), created.id);
  assert.equal(mainHistoryItems(ui)[0].getAttribute("aria-current"), "true"); assert.equal(ui.get("main-new-chat").disabled, false);
});

test("另一页面删除当前主历史后刷新切换，不把旧会话草稿带入剩余会话", async () => {
  const original = { id: "main-a", title: "已在另一页删除", version: 1, messages: [] }, remaining = { id: "main-b", title: "仍存在的工作", version: 1,
    messages: [{ role: "assistant", content: "B 的历史记录", status: "complete" }] };
  let conversations = [original, remaining];
  const ui = setup(mainSource, async (path) => Response.json(path === "/api/main/conversations" ? { conversations }
    : { conversation: path.endsWith(original.id) ? original : remaining }));
  await ui.route({ page: "chat" }); await settle(); ui.get("main-message").value = "A 的未发送草稿";
  conversations = [remaining]; await vm.runInContext("list()", ui.context); await settle();
  assert.equal(ui.get("main-message").value, ""); assert.match(ui.text("main-messages"), /B 的历史记录/);
  assert.equal(ui.stored.get("neuma.main.active-conversation.v1"), remaining.id);
  assert.deepEqual(mainHistoryItems(ui).map((item) => item.textContent), [remaining.title]);
});

test("主历史菜单被列表刷新关闭时焦点回到仍存在的对应操作按钮", async () => {
  const conversation = { id: "main-one", title: "可继续操作的历史", version: 1, messages: [] };
  const ui = setup(mainSource, async (path) => Response.json(path === "/api/main/conversations" ? { conversations: [conversation] } : { conversation }));
  await ui.route({ page: "chat" }); await settle();
  await mainHistoryMore(ui, conversation.id).dispatchEvent({ type: "keydown", key: "ArrowDown", preventDefault() {} });
  assert.equal(ui.document.activeElement, ui.get("main-history-delete"));
  await vm.runInContext("list()", ui.context); await settle();
  assert.equal(ui.get("main-history-menu").hidden, true); assert.equal(ui.document.activeElement, mainHistoryMore(ui, conversation.id));
});

test("主助理失败后保留输入并复用消息操作，群外联系不会伪造群成员", async () => {
  const writes = []; let failed = true;
  const conversation = { id: "main-one", title: "持续工作", messages: [] };
  const ui = setup(mainSource, async (path, options = {}) => {
    if (path.endsWith("/messages")) { writes.push(JSON.parse(options.body)); if (failed) { failed = false; throw new Error("连接断开"); }
      return Response.json({ reply: "已创建", conversation: { ...conversation, messages: [{ role: "assistant", content: "已联系 #group/one", status: "complete" }] } }); }
    return Response.json(path === "/api/main/conversations" ? { conversations: [conversation] }
      : path === "/api/activity" ? { groups: [], agents: [], tasks: [] } : { conversation });
  });
  await ui.route({ page: "chat" }); await settle(); ui.get("main-message").value = "帮我联系研究群";
  await ui.submit("main-chat-form"); await settle(); assert.equal(ui.get("main-message").value, "帮我联系研究群");
  await ui.submit("main-chat-form"); await settle(); assert.deepEqual(writes[1], writes[0]); assert.match(ui.text("main-messages"), /已联系/);
});

test("主聊天成功创建群后侧栏立即读取真实列表，不切页或增加模型请求", async () => {
  let savedGroups = [], listReads = 0, turns = 0;
  const navigations = [], conversation = { id: "main-one", title: "长期工作", messages: [] };
  const ui = setup(`(() => {\n${mainSource}\n})();\n(() => {\n${groupsSource}\n})();`, async (path, options = {}) => {
    if (path === "/api/groups") { listReads++; return Response.json({ groups: copy(savedGroups) }); }
    if (path.endsWith("/messages")) {
      turns++; savedGroups = [group("created-group", "新建研究组")];
      return Response.json({ reply: "研究组已创建", context: null, conversation: { ...conversation, messages: [{ role: "assistant", content: "研究组已创建", status: "complete" }] },
        sources: [{ type: "group", groupId: "created-group", operation: "created" }] });
    }
    return Response.json(path === "/api/main/conversations" ? { conversations: [conversation] } : { conversation });
  });
  ui.document.addEventListener("neuma:navigate", (event) => navigations.push(event.detail));
  await ui.route({ page: "chat" }); await settle(); assert.equal(ui.get("sidebar-group-list").children.length, 0);
  ui.get("main-message").value = "帮我创建一个研究组"; await ui.submit("main-chat-form"); await settle();
  assert.equal(listReads, 2); assert.equal(turns, 1); assert.equal(navigations.length, 0);
  assert.equal(textOf(sidebarGroup(ui, "created-group").querySelector(".sidebar-group-link")), "新建研究组");
  assert.equal(sidebarGroup(ui, "created-group").querySelector(".sidebar-group-link").href, "#group/created-group");
  assert.match(ui.text("main-messages"), /研究组已创建/);
});

test("主助理仅在成功的群管理或群任务来源出现时通知群列表，历史恢复不重复通知", async () => {
  for (const [source, expected] of [
    [{ type: "group", groupId: "one", operation: "created" }, 1], [{ type: "group", groupId: "one", operation: "updated" }, 1],
    [{ type: "group", groupId: "one", operation: "archived" }, 1], [{ type: "group_task", groupId: "one", taskId: "task-one", status: "running" }, 1],
    [{ type: "agent_task", agentId: "writer", status: "complete" }, 0], [{ type: "group", groupId: "one", operation: "read" }, 0],
  ]) {
    let notifications = 0;
    const conversation = { id: "main-one", title: "工作", messages: [{ role: "assistant", content: "旧回执", status: "complete", sources: [source] }] };
    const ui = setup(mainSource, async (path) => Response.json(path.endsWith("/messages")
      ? { reply: "当前操作已确认", context: null, conversation, sources: [source] }
      : path === "/api/main/conversations" ? { conversations: [conversation] } : { conversation }));
    ui.document.addEventListener("neuma:groups-changed", () => notifications++);
    await ui.route({ page: "chat" }); await settle(); assert.equal(notifications, 0);
    ui.get("main-message").value = "完成当前操作"; await ui.submit("main-chat-form"); await settle();
    assert.equal(notifications, expected, JSON.stringify(source));
    // Directly invoke the hidden recovery control to isolate history reads from new group actions.
    await ui.get("main-refresh").click(); await settle(); assert.equal(notifications, expected);
  }
});

test("群变更触发的新列表优先于迟到的初始列表，主草稿保持不动", async () => {
  let release, reads = 0;
  const ui = setup(groupsSource, async () => { if (++reads === 1) return new Promise((resolve) => { release = () => resolve(Response.json({ groups: [] })); });
    return Response.json({ groups: [group("new-group", "新的研究组")] }); });
  await settle(); ui.get("main-message").value = "下一条未发送主草稿";
  await ui.document.dispatchEvent({ type: "neuma:groups-changed" }); await settle(); release(); await settle();
  assert.equal(textOf(sidebarGroup(ui, "new-group").querySelector(".sidebar-group-link")), "新的研究组");
  assert.equal(ui.get("main-message").value, "下一条未发送主草稿");
});

test("历史折叠后顶部新对话仍能创建空白会话，旧草稿按会话独立恢复", async () => {
  const conversations = [{ id: "main-a", title: "对话 A", messages: [{ role: "assistant", content: "A 中已保存的工作", status: "complete" }] },
    { id: "main-b", title: "对话 B", messages: [] }];
  const ui = setup(mainSource, async (path, options = {}) => {
    if (path === "/api/main/conversations" && options.method === "POST") {
      const conversation = { id: "main-new", title: "新对话", messages: [] }; conversations.push(conversation); return Response.json({ conversation });
    }
    return Response.json(path === "/api/main/conversations" ? { conversations } : { conversation: conversations.find((item) => path.endsWith(item.id)) });
  });
  const choose = async (title) => { await mainHistoryItems(ui).find((item) => item.textContent === title).click(); await settle(); };
  await ui.route({ page: "chat" }); await settle(); ui.get("main-message").value = "草稿 A";
  assert.equal(ui.get("main-conversation-title").hidden, false);
  await ui.get("main-history-toggle").click(); assertDisclosure(ui.get("main-history-body"), false);
  assert.equal(ui.get("main-new-chat").hidden, false); assert.equal(ui.get("main-new-chat").disabled, false);
  assert.equal(ui.get("main-new-chat").inert === true, false);
  await ui.get("main-new-chat").click(); await settle(); assert.equal(ui.get("main-message").value, "");
  assert.equal(ui.get("main-conversation-title").hidden, true); assert.doesNotMatch(ui.text("main-messages"), /A 中已保存的工作/);
  assertDisclosure(ui.get("main-history-body"), false); await ui.get("main-history-toggle").click();
  await choose("对话 B"); assert.equal(ui.get("main-message").value, ""); ui.get("main-message").value = "草稿 B";
  await choose("对话 A"); assert.equal(ui.get("main-message").value, "草稿 A");
  await choose("对话 B"); assert.equal(ui.get("main-message").value, "草稿 B");
  await choose("新对话"); assert.equal(ui.get("main-message").value, "");
});

test("创建或选择主对话失败保留当前输入，首次自动建对话保留用户第一条要求", async () => {
  const conversation = { id: "main-a", title: "对话 A", messages: [] };
  const ui = setup(mainSource, async (path, options = {}) => {
    if (path === "/api/main/conversations" && options.method === "POST") throw new Error("创建中断");
    if (path.endsWith("main-b")) throw new Error("选择中断");
    return Response.json(path === "/api/main/conversations" ? { conversations: [conversation, { id: "main-b", title: "对话 B", messages: [] }] } : { conversation });
  });
  await ui.route({ page: "chat" }); await settle(); ui.get("main-message").value = "仍属于 A 的草稿";
  await ui.get("main-new-chat").click(); await settle(); assert.equal(ui.get("main-message").value, "仍属于 A 的草稿");
  assert.equal(ui.get("main-refresh").hidden, false); assert.equal(ui.get("main-recovery").hidden, false);
  await mainHistoryItems(ui)[1].click(); await settle(); assert.equal(ui.get("main-message").value, "仍属于 A 的草稿");
  assert.equal(ui.text("main-conversation-title"), "对话 A");
  const writes = []; let created = false;
  const first = setup(mainSource, async (path, options = {}) => {
    if (path === "/api/main/conversations" && options.method === "POST") { created = true; return Response.json({ conversation }); }
    if (path.endsWith("/messages")) { writes.push(JSON.parse(options.body)); return Response.json({ reply: "收到第一条", conversation: { ...conversation, messages: [{ role: "assistant", content: "收到第一条" }] } }); }
    return Response.json(path === "/api/main/conversations" ? { conversations: created ? [conversation] : [] } : { conversation });
  });
  await first.route({ page: "chat" }); await settle(); first.get("main-message").value = "我的第一条工作要求";
  await first.submit("main-chat-form"); await settle(); assert.equal(writes[0].message, "我的第一条工作要求");
});

test("服务器已取消或明确失败后主动重发使用新请求，取消不误报失败", async () => {
  for (const reason of ["cancelled", "request_failed"]) {
    const conversation = { id: "main-one", title: "停止验收", messages: [] }, writes = [];
    const ui = setup(mainSource, async (path, options = {}) => {
      if (path.endsWith("/messages")) {
        writes.push(JSON.parse(options.body));
        if (writes.length === 1) return new Response([
          { type: "status", label: "正在处理…" }, { type: "text-start" }, { type: "text-delta", delta: "已输出的部分内容" },
          { type: "error", error: "服务端已结束本轮", diagnostic: { stage: "main", reason } },
        ].map(JSON.stringify).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } });
        return Response.json({ reply: "新的请求已完成", conversation: { ...conversation, messages: [{ role: "assistant", content: "新的请求已完成", status: "complete" }] } });
      }
      return Response.json(path === "/api/main/conversations" ? { conversations: [conversation] } : { conversation });
    });
    await ui.route({ page: "chat" }); await settle(); ui.get("main-message").value = "继续这个任务";
    await ui.submit("main-chat-form"); await settle();
    assert.equal(ui.get("main-message").value, "继续这个任务");
    assert.equal(ui.text("main-progress"), ""); assert.equal(ui.get("main-progress").hidden, true);
    assert.equal(ui.get("main-refresh").hidden, false); assert.equal(ui.get("main-recovery").hidden, false);
    if (reason === "cancelled") {
      assert.match(ui.text("main-error"), /本轮已停止/); assert.equal(ui.get("main-error").classes.has("error"), false);
      assert.match(ui.text("main-messages"), /已停止/);
    }
    await ui.submit("main-chat-form"); await settle();
    assert.equal(writes.length, 2); assert.notEqual(writes[0].mutationId, writes[1].mutationId);
    assert.equal(writes[0].message, writes[1].message); assert.match(ui.text("main-messages"), /新的请求已完成/);
  }
});

test("需求在同一主会话激活与确认，成功的新回复桥接后台制作，恢复历史不重复构建", async () => {
  const writes = [], events = [], requests = [];
  const draft = { name: { value: "研究助手" }, goal: { value: "读资料并给出结论" }, inputSource: { value: "文字材料" } };
  const requirement = { id: "research", name: "研究助手", draft, updatedAt: "2026-10-11T00:00:00Z" };
  let conversation = { id: "main-one", title: "长期工作", messages: [{ role: "assistant", content: "上次的工作已保留", status: "complete" }] };
  const ready = { type: "requirements", agentId: "research", mode: "create", draft, status: "ready", confirmed: false, lastQuestion: "确认这些输入输出吗？" };
  const ui = setup(mainSource, async (path, options = {}) => {
    requests.push(path);
    if (path.endsWith("/requirements")) { writes.push({ path, body: JSON.parse(options.body) }); conversation = { ...conversation, context: ready }; return Response.json({ conversation, context: ready }); }
    if (path.endsWith("/messages")) {
      writes.push({ path, body: JSON.parse(options.body) });
      const context = { ...ready, status: "needs_build", confirmed: true, requirement, needsBuild: true };
      conversation = { ...conversation, context, messages: [...conversation.messages, { role: "user", content: "确认需求" }, { role: "assistant", content: "需求已保存，开始制作", status: "complete" }] };
      return Response.json({ reply: "需求已保存，开始制作", conversation, context, actions: [{ type: "build_agent", agentId: "research", requirement }] });
    }
    if (path === "/api/agents/research") return Response.json({ architecture: { agentId: "research", name: requirement.name, draft, status: "designing" } });
    return Response.json(path === "/api/main/conversations" ? { conversations: [conversation] } : { conversation });
  });
  ui.document.addEventListener("neuma:main-requirement-saved", (event) => events.push(event.detail));
  await ui.route({ page: "chat" }); await settle(); ui.get("main-message").value = "我稍后要补充的主聊天草稿";
  await ui.get("main-create-agent").click(); await settle();
  assert.equal(writes[0].path, "/api/main/conversations/main-one/requirements");
  assert.equal(ui.get("main-message").value, "我稍后要补充的主聊天草稿");
  assert.match(ui.text("main-messages"), /上次的工作已保留/); assert.match(ui.text("main-context-content"), /文字材料|确认这些输入输出吗/);
  assert.match(ui.text("main-context-content"), /导出需求 JSON/); assertDisclosure(ui.get("main-context-panel"), true);
  await ui.get("main-context-content").querySelectorAll("button").find((item) => item.textContent === "确认需求并开始制作").click(); await settle();
  assert.equal(writes[1].path, "/api/main/conversations/main-one/messages"); assert.equal(writes[1].body.message, "确认需求");
  assert.equal(ui.get("main-message").value, "我稍后要补充的主聊天草稿");
  assert.equal(events.filter((event) => event.build).length, 1); assert.deepEqual(events.find((event) => event.build).requirement, requirement);
  assert.match(ui.text("main-context-content"), /正在设计架构/);
  // Re-reading a saved conversation must never replay its build action, even without a visible recovery control.
  await ui.get("main-refresh").click(); await settle(); assert.equal(events.filter((event) => event.build).length, 1);
  assert.equal(requests.includes("/api/requirements/turn"), false);
});

test("需求快捷确认成功、失败或停止都保留原输入及发送期间的草稿编辑", async (t) => {
  const scenarios = [
    { outcome: "success", edit: "replace" }, { outcome: "success", edit: "clear" },
    { outcome: "error", edit: "unchanged" }, { outcome: "error", edit: "replace" }, { outcome: "error", edit: "clear" },
    { outcome: "cancelled", edit: "unchanged" }, { outcome: "cancelled", edit: "clear" },
    { outcome: "error", edit: "unchanged", original: "" },
  ];
  for (const { outcome, edit, original = "  尚未发送的补充要求\n保留原有格式  " } of scenarios) {
    await t.test(`${outcome} · ${original ? "已有草稿" : "空输入"} · ${edit}`, async () => {
      const ready = { type: "requirements", agentId: "research", status: "ready", confirmed: false,
        draft: { name: { value: "研究助手" } } };
      let conversation = { id: "main-one", title: "需求确认", context: ready, messages: [] }, release;
      const writes = [], ui = setup(mainSource, async (path, options = {}) => {
        if (path.endsWith("/messages")) {
          writes.push(JSON.parse(options.body));
          return new Promise((resolve, reject) => {
            release = resolve;
            options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
          });
        }
        if (path.endsWith("/cancel")) return Response.json({ cancelled: true });
        return Response.json(path === "/api/main/conversations" ? { conversations: [conversation] } : { conversation });
      });
      await ui.route({ page: "chat" }); await settle(); ui.get("main-message").value = original;
      await ui.get("main-context-content").querySelectorAll("button").find((item) => item.textContent === "确认需求并开始制作").click();
      await settle();
      assert.equal(writes.length, 1); assert.equal(writes[0].message, "确认需求");
      assert.equal(ui.get("main-message").value, original, "快捷消息不能覆盖或清空未发送输入");
      assert.equal(ui.get("main-message").disabled, false);
      const expected = edit === "replace" ? "发送期间更新的工作草稿" : edit === "clear" ? "" : original;
      ui.get("main-message").value = expected;
      if (outcome === "success") {
        conversation = { ...conversation, context: null, messages: [
          { role: "user", content: "确认需求" }, { role: "assistant", content: "需求已确认", status: "complete" },
        ] };
        release(Response.json({ reply: "需求已确认", conversation, context: null }));
      } else if (outcome === "error") release(Response.json({ error: "确认暂时失败" }, { status: 500 }));
      else await ui.get("main-cancel").click();
      await settle();
      assert.equal(ui.get("main-message").value, expected, "结束后不能恢复快捷确认串或覆盖后续编辑");
      assert.equal(ui.get("main-send").disabled, false);
      if (outcome === "success") assert.match(ui.text("main-messages"), /需求已确认/);
      else assert.match(ui.text("main-error"), outcome === "cancelled" ? /本轮已停止/ : /确认暂时失败/);
    });
  }
});

test("需求激活未知结果保持主草稿和同一个幂等操作，迭代保持稳定智能体 ID", async () => {
  const writes = []; let fail = true;
  const conversation = { id: "main-one", title: "长期工作", messages: [] };
  const context = { type: "requirements", mode: "edit", agentId: "existing-agent", draft: { name: { value: "既有助手" } }, status: "needs_input", confirmed: false };
  const ui = setup(mainSource, async (path, options = {}) => {
    if (path.endsWith("/requirements")) { writes.push(JSON.parse(options.body)); if (fail) { fail = false; throw new Error("响应丢失"); } return Response.json({ conversation: { ...conversation, context }, context }); }
    return Response.json(path === "/api/main/conversations" ? { conversations: [conversation] } : { conversation });
  });
  await ui.route({ page: "chat" }); await settle(); ui.get("main-message").value = "保留原主聊天输入";
  await ui.document.dispatchEvent({ type: "neuma:main-requirements", detail: { agentId: "existing-agent" } }); await settle();
  assert.equal(ui.get("main-message").value, "保留原主聊天输入"); assert.match(ui.text("main-error"), /原对话与输入已保留/);
  assert.equal(ui.get("main-refresh").hidden, false); assert.equal(ui.get("main-recovery").hidden, false);
  await ui.document.dispatchEvent({ type: "neuma:main-requirements", detail: { agentId: "existing-agent" } }); await settle();
  assert.deepEqual(writes[1], writes[0]); assert.equal(writes[0].agentId, "existing-agent"); assert.match(ui.text("main-context-content"), /既有助手/);
  assert.equal(ui.get("main-refresh").hidden, true); assert.equal(ui.get("main-recovery").hidden, true);
});

test("主聊天群任务上下文显示实际分工与结果，关闭只停止查看，重开恢复轮询", async () => {
  const requests = [], state = detail(); state.tasks[0].result = "实际完成的报告结论";
  const conversation = { id: "main-one", title: "长期工作", messages: [], context: { type: "group", groupId: "one", taskId: "task-one" } };
  const ui = setup(mainSource, async (path) => { requests.push(path); return Response.json(path === "/api/groups/one" ? state
    : path === "/api/main/conversations" ? { conversations: [conversation] } : { conversation }); });
  await ui.route({ page: "chat" }); await settle();
  assert.match(ui.text("main-context-content"), /实际完成的报告结论/); assert.match(ui.text("main-context-content"), /写作助手/);
  assert.equal(ui.timers.size, 1);
  await ui.get("main-context-close").click(); assert.equal(ui.timers.size, 0); assertDisclosure(ui.get("main-context-panel"), false);
  assert.equal(ui.get("main-workspace").classes.has("context-open"), false); assert.equal(ui.get("main-context-open").hidden, false);
  assert.equal(requests.some((path) => path.endsWith("/cancel")), false);
  await ui.get("main-context-open").click(); await settle(); assert.equal(ui.timers.size, 1); assertDisclosure(ui.get("main-context-panel"), true);
  await ui.route({ page: "groups" }); assert.equal(ui.timers.size, 0);
});

test("上下文快速关闭重开即时停止恢复轮询，焦点与最终展开状态一致", async () => {
  const conversation = { id: "main-one", title: "长期工作", messages: [], context: { type: "group", groupId: "one", taskId: "task-one" } };
  const requests = [], ui = setup(mainSource, async (path, options = {}) => {
    requests.push({ path, signal: options.signal });
    return Response.json(path === "/api/groups/one" ? detail() : path === "/api/main/conversations" ? { conversations: [conversation] } : { conversation });
  });
  await ui.route({ page: "chat" }); await settle();
  const panel = ui.get("main-context-panel"), close = ui.get("main-context-close"), open = ui.get("main-context-open");
  panel.append(close); ui.get("main-message").value = "关闭重开仍保留的草稿";
  for (let index = 0; index < 3; index++) {
    close.focus(); const closing = close.click();
    assertDisclosure(panel, false); assert.equal(ui.timers.size, 0);
    assert.equal(ui.document.activeElement, open); assert.equal(open.hidden, false);
    await closing;
    const opening = open.click();
    assertDisclosure(panel, true); assert.equal(ui.timers.size, 1);
    assert.equal(ui.document.activeElement, close); assert.equal(open.hidden, true);
    await opening;
  }
  await settle(); assertDisclosure(panel, true); assert.equal(ui.timers.size, 1);
  assert.equal(ui.get("main-workspace").classes.has("context-open"), true);
  assert.equal(ui.get("main-message").value, "关闭重开仍保留的草稿");
  assert.equal(requests.some(({ path }) => path.endsWith("/cancel")), false);
  await ui.route({ page: "groups" }); assert.equal(ui.timers.size, 0); assertDisclosure(panel, false);
});

test("上下文消失时关闭面板并将面板内焦点交回主输入", async () => {
  let conversation = { id: "main-one", title: "长期工作", messages: [], context: { type: "group", groupId: "one", taskId: "task-one" } };
  const ui = setup(mainSource, async (path) => Response.json(path === "/api/groups/one" ? detail()
    : path === "/api/main/conversations" ? { conversations: [conversation] } : { conversation }));
  await ui.route({ page: "chat" }); await settle();
  const panel = ui.get("main-context-panel"), close = ui.get("main-context-close"); panel.append(close); close.focus();
  ui.get("main-message").value = "上下文消失也保留的草稿";
  conversation = { ...conversation, context: null };
  // Invoke recovery directly to verify that the saved context replaces the open panel without losing the draft.
  await ui.get("main-refresh").click(); await settle();
  assertDisclosure(panel, false); assert.equal(ui.timers.size, 0);
  assert.equal(ui.get("main-context-open").hidden, true); assert.equal(ui.document.activeElement, ui.get("main-message"));
  assert.equal(ui.get("main-message").value, "上下文消失也保留的草稿");
});

test("旧群进度迟到不会覆盖新会话上下文，关闭中的响应不会重新展开面板", async () => {
  let release;
  const conversations = [{ id: "main-one", title: "旧任务", messages: [], context: { type: "group", groupId: "one", taskId: "task-one" } },
    { id: "main-two", title: "新任务", messages: [], context: { type: "group", groupId: "two", taskId: "task-one" } }];
  const ui = setup(mainSource, async (path) => {
    if (path === "/api/groups/one") return new Promise((resolve) => { release = () => resolve(Response.json(detail())); });
    if (path === "/api/groups/two") return Response.json(detail("two", "新的工作群"));
    if (path === "/api/main/conversations") return Response.json({ conversations });
    return Response.json({ conversation: conversations.find((item) => path.endsWith(item.id)) });
  });
  await ui.route({ page: "chat" }); await settle();
  await mainHistoryItems(ui)[1].click(); await settle(); release(); await settle();
  assert.equal(ui.text("main-context-title"), "新的工作群"); assert.equal(ui.text("main-context-content").includes("研究小组"), false);
  await ui.get("main-context-close").click(); await settle(); assertDisclosure(ui.get("main-context-panel"), false); assert.equal(ui.timers.size, 0);
});

test("流式操作展开上下文后用户关闭，晚到的同一完成上下文不能强制重开", async () => {
  const context = { type: "group", groupId: "one", taskId: "task-one" };
  const conversation = { id: "main-one", title: "工作", messages: [] };
  let streamController;
  const ui = setup(mainSource, async (path) => {
    if (path.endsWith("/messages")) return new Response(new ReadableStream({ start(controller) { streamController = controller;
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: "context", context }) + "\n"));
    } }), { headers: { "content-type": "application/x-ndjson" } });
    return Response.json(path === "/api/groups/one" ? detail() : path === "/api/main/conversations" ? { conversations: [conversation] } : { conversation });
  });
  await ui.route({ page: "chat" }); await settle(); ui.get("main-message").value = "查看这个群的任务";
  await ui.submit("main-chat-form"); await settle(); assertDisclosure(ui.get("main-context-panel"), true);
  await ui.get("main-context-close").click(); assert.equal(ui.timers.size, 0);
  streamController.enqueue(new TextEncoder().encode(JSON.stringify({ type: "done", result: { reply: "群任务已读取", context,
    conversation: { ...conversation, context, messages: [{ role: "assistant", content: "群任务已读取", status: "complete" }] } } }) + "\n")); streamController.close();
  await settle(); assertDisclosure(ui.get("main-context-panel"), false); assert.equal(ui.get("main-context-open").hidden, false); assert.equal(ui.timers.size, 0);
  assert.match(ui.text("main-messages"), /群任务已读取/);
});

test("流式需求预览后失败恢复原上下文与开合状态，不同步或制作未完成需求", async () => {
  const original = { type: "group", groupId: "one", taskId: "task-one" };
  const requirement = { id: "new-agent", name: "新助手", draft: { name: { value: "新助手" } } };
  const preview = { type: "requirements", agentId: "new-agent", draft: requirement.draft, confirmed: true, status: "needs_build", requirement };
  const conversation = { id: "main-one", title: "工作", messages: [], context: original }, bridges = [];
  let streamController;
  const ui = setup(mainSource, async (path) => {
    if (path.endsWith("/messages")) return new Response(new ReadableStream({ start(controller) { streamController = controller;
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: "context", context: preview }) + "\n"));
    } }), { headers: { "content-type": "application/x-ndjson" } });
    if (path === "/api/agents/new-agent") return Response.json({ agent: null, architecture: null });
    return Response.json(path === "/api/groups/one" ? detail() : path === "/api/main/conversations" ? { conversations: [conversation] } : { conversation });
  });
  ui.document.addEventListener("neuma:main-requirement-saved", (event) => bridges.push(event.detail));
  await ui.route({ page: "chat" }); await settle(); await ui.get("main-context-close").click();
  ui.get("main-message").value = "做一个新助手"; await ui.submit("main-chat-form"); await settle();
  assertDisclosure(ui.get("main-context-panel"), true); assert.match(ui.text("main-context-title"), /需求/);
  streamController.enqueue(new TextEncoder().encode(JSON.stringify({ type: "error", error: "模型回复中断" }) + "\n")); streamController.close();
  await settle(); assert.equal(bridges.length, 0); assertDisclosure(ui.get("main-context-panel"), false); assert.equal(ui.timers.size, 0);
  assert.equal(ui.get("main-message").value, "做一个新助手");
  await ui.get("main-context-open").click(); await settle(); assert.equal(ui.text("main-context-title"), "研究小组");
});

test("主助理先建对话再上传，发送给群的材料在断线重试中保留，成功后显示下载链接", async () => {
  const writes = [], uploads = []; let failed = true, created = false;
  const attachment = { id: "main-material", name: "研究资料.txt", mimeType: "text/plain", size: 6 };
  const conversation = { id: "main-created", title: "分析材料", messages: [] };
  const ui = setup(mainSource, async (path, options = {}) => {
    if (path === "/api/main/conversations" && options.method === "POST") { created = true; return Response.json({ conversation }); }
    if (path.endsWith("/materials") && options.method === "POST") { uploads.push({ path, headers: options.headers, body: options.body }); return Response.json({ attachment }); }
    if (path.endsWith("/messages")) {
      writes.push(JSON.parse(options.body)); if (failed) { failed = false; throw new Error("响应断开"); }
      return Response.json({ reply: "已把材料交给研究群", conversation: { ...conversation, messages: [
        { role: "user", content: writes.at(-1).message, attachments: [attachment] }, { role: "assistant", content: "已交给 #group/one", status: "complete" }] } });
    }
    return Response.json(path === "/api/main/conversations" ? { conversations: created ? [conversation] : [] }
      : path === "/api/activity" ? { agents: [], groups: [], tasks: [] } : { conversation });
  });
  await ui.route({ page: "chat" }); await settle();
  ui.get("main-message").value = "把这份材料交给研究群分析";
  const file = Object.assign(new Blob(["资料"], { type: "text/plain" }), { name: "研究资料.txt" });
  await ui.get("main-file-input").dispatchEvent({ type: "change", target: { files: [file] } }); await settle();
  assert.equal(created, true); assert.equal(uploads[0].path, "/api/main/conversations/main-created/materials");
  assert.equal(ui.get("main-message").value, "把这份材料交给研究群分析");
  assert.equal(uploads[0].headers["x-file-name"], encodeURIComponent("研究资料.txt")); assert.equal(uploads[0].body, file);
  assert.match(ui.text("main-pending-materials"), /研究资料.txt/);
  ui.get("main-message").value = "把这份材料交给研究群分析";
  await ui.submit("main-chat-form"); await settle(); assert.match(ui.text("main-pending-materials"), /研究资料.txt/);
  await ui.submit("main-chat-form"); await settle(); assert.deepEqual(writes[1], writes[0]); assert.deepEqual(writes[0].attachmentIds, ["main-material"]);
  assert.equal(ui.get("main-pending-materials").hidden, true);
  const row = ui.get("main-messages").children[0];
  const attachments = row.children.find((item) => item.className === "collaboration-links" && item.children.some((link) => link.download));
  assert.equal(attachments.children[0].href, "/api/main/conversations/main-created/materials/main-material/raw");
  assert.equal(attachments.children[0].download, "研究资料.txt");
  assert.equal(row.className, "message user");
  assert.equal(row.children.some((item) => item.className === "collaboration-message-heading"), false);
});

test("桌面主聊天统一需求输入，旧创建表单仅作为隐藏档案保留", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  for (const id of ["page-chat", "page-create", "page-group", "page-groups", "group-editor", "group-files-dialog", "group-share-dialog"]) assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1);
  assert.match(html, /aria-label="主助理历史对话"/); assert.match(html, /id="group-panel"/);
  assert.match(html, /id="main-message"/); assert.match(html, /id="group-message"/); assert.match(html, /id="main-create-agent"/);
  const groupHeader = html.slice(html.indexOf('<section id="page-group"'), html.indexOf('<dialog id="group-editor"')).match(/<header[\s\S]*?<\/header>/)?.[0];
  assert.ok(groupHeader); assert.match(groupHeader, /id="group-title"/);
  assert.doesNotMatch(groupHeader, /id="group-purpose"|page-subtitle/);
  assert.doesNotMatch(html, /id="group-task-(?:filter|trigger|menu|value|label)"/);
  const tags = [...html.matchAll(/<([a-z][\w-]*)\b[^>]*>/g)];
  const attribute = (tag, key) => [...tag.matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/g)].find((match) => match[1] === key)?.[3];
  const element = (id) => { const matches = tags.filter(([tag]) => attribute(tag, "id") === id); assert.equal(matches.length, 1, `${id} 唯一`); return matches[0]; };
  const capsule = element("group-panel-toggle");
  assert.equal(capsule[1], "button"); assert.equal(attribute(capsule[0], "aria-controls"), "group-panel");
  assert.equal(attribute(capsule[0], "aria-expanded"), "false");
  const identity = html.slice(capsule.index, html.indexOf("</button>", capsule.index));
  assert.ok(identity.includes(element("group-avatar")[0])); assert.ok(identity.includes(element("group-title")[0]));
  const panel = element("group-panel"), panelMarkup = html.slice(panel.index, html.indexOf("</aside>", panel.index));
  assert.equal(panel[1], "aside"); assert.match(panel[0], /\bhidden\b/);
  for (const id of ["group-details-close", "group-details-avatar", "group-details-name", "group-purpose", "group-files-open", "group-files-count",
    "group-edit", "group-archive", "group-member-count", "group-members", "group-refresh", "group-tasks"]) assert.ok(panelMarkup.includes(element(id)[0]), `${id} 位于设置栏`);
  for (const tab of ["profile", "members", "tasks"]) {
    assert.ok(panelMarkup.includes(element(`group-details-${tab}-tab`)[0])); assert.ok(panelMarkup.includes(element(`group-details-${tab}`)[0]));
  }
  assert.equal(element("group-editor")[1], "dialog");
  assert.equal(attribute(element("group-files-open")[0], "aria-controls"), "group-files-dialog");
  assert.equal(attribute(element("group-attachment-menu-toggle")[0], "aria-haspopup"), "menu");
  assert.equal(attribute(element("group-attachment-menu")[0], "role"), "menu");
  assert.equal(attribute(element("group-upload")[0], "role"), "menuitem");
  assert.equal(attribute(element("group-share-open")[0], "role"), "menuitem");
  assert.equal(attribute(element("sidebar-manage-groups")[0], "href"), "#groups");
  assert.doesNotMatch(html, /id="sidebar-main-new-chat"/);
  assert.equal(element("sidebar-create-agent")[1], "button");
  assert.equal(element("sidebar-create-group")[1], "button");
  assert.match(html, /id="group-purpose-input"/);
  const formStart = html.indexOf('<form id="group-chat-form"');
  const groupForm = html.slice(formStart, html.indexOf('</form>', formStart));
  assert.doesNotMatch(groupForm, /group-recipient|群内协作/);
  assert.match(groupForm, /id="group-mention-popup"[^>]*role="listbox"/);
  assert.match(groupForm, /id="group-selected-mentions"[^>]*hidden/);
  assert.ok(groupForm.indexOf('id="group-attachment-menu"') >= 0);
  assert.doesNotMatch(groupForm, /group-compose-options/);
  assert.match(html, /id="page-create"[^>]+hidden inert/); assert.match(html, /id="main-context-panel"[^>]+aria-hidden="true" inert/);
  assert.match(html, /class="main-context-slot"[^>]*>\s*<aside id="main-context-panel"/);
  const mainPage = html.slice(html.indexOf('<section id="page-chat"'), html.indexOf('<dialog id="main-material-dialog"'));
  assert.doesNotMatch(mainPage, /class="page-header"|与你持续对话，一起把想法变成可完成的工作。/);
  assert.match(mainPage, /<p id="main-progress"[^>]*\bhidden><\/p>/);
  const actions = mainPage.match(/<div class="main-conversation-actions">([\s\S]*?)<\/div>/)?.[1];
  assert.ok(actions);
  const newChat = mainPage.match(/<button id="main-new-chat"([^>]*)>([\s\S]*?)<\/button>/);
  assert.ok(newChat); assert.equal(newChat[2], "新对话"); assert.match(newChat[1], /class="conversation-new-chat"/);
  assert.doesNotMatch(newChat[1], /\bhidden\b|\binert\b|aria-hidden="true"/);
  assert.match(mainPage, /<div class="conversation-bar">\s*<button id="main-new-chat"/);
  assert.equal((mainPage.match(/id="main-new-chat"/g) || []).length, 1);
  assert.doesNotMatch(mainPage.match(/<div class="main-history-heading">([\s\S]*?)<\/div>/)?.[1] || "", /id="main-new-chat"/);
  assert.match(mainPage, /<span id="main-conversation-title"[^>]*hidden/);
  for (const id of ["main-create-agent", "main-create-group", "main-context-open"]) {
    assert.equal((mainPage.match(new RegExp(`id="${id}"`, "g")) || []).length, 1);
    assert.ok(actions.includes(`id="${id}"`));
  }
  assert.doesNotMatch(actions, /id="main-refresh"/);
  assert.equal((mainPage.match(/id="main-refresh"/g) || []).length, 1);
  assert.match(mainPage, /<div id="main-recovery" class="collaboration-links" hidden>\s*<button id="main-refresh"[^>]*hidden[^>]*>重新加载<\/button>\s*<\/div>/);
  assert.equal(html.includes('id="main-activity"'), false);
  assert.equal(html.includes("主持人"), false);
});
