import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/shell.js", import.meta.url), "utf8");

function setup({ compact = false, reduced = false, transitions = false, hash = "", configured = true, collapsed = false, sidebarCollapsed = false, storageBlocked = false, resizeObserver = false } = {}) {
  class Events {
    listeners = new Map();
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(handler);
    }
    dispatchEvent(event) {
      for (const handler of this.listeners.get(event.type) ?? []) handler(event);
    }
  }
  const document = new Events(), window = new Events();
  const nodes = new Map();
  class Element extends Events {
    constructor(id) {
      super(); this.id = id; this.hidden = false; this.open = false; this.attributes = new Map();
      this.value = ""; this.style = {}; this.scrollHeight = 80; this.dataset = {};
      this.classes = new Set();
      this.classList = { toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) };
      this.form = { requestSubmit: () => { this.submissions = (this.submissions ?? 0) + 1; } };
    }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    querySelector() { return get(`${this.id}-span`); }
    querySelectorAll(selector) {
      const composer = { "page-chat": "main-message", "page-create": "message", "page-projects": "project-message", "page-agent": "agent-message", "page-group": "group-message" }[this.id];
      return composer ? [get(composer)] : [];
    }
    closest() { return this.hidden ? this : null; }
    contains(element) {
      return (this.id === "project-library-body" && element === get("project-search"))
        || (this.id === "sidebar-details" && element === get("sidebar-create-agent"));
    }
    focus() { document.activeElement = this; }
    click() { this.dispatchEvent({ type: "click" }); }
    scrollIntoView(options) { this.scrolled = true; this.scrollOptions = options; }
    showModal() { this.open = true; get("project-path").focus(); }
    close() { this.open = false; }
  }
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, new Element(id));
    return nodes.get(id);
  };
  const inputs = ["message", "project-message", "agent-message", "main-message", "group-message"].map(get);
  const links = ["chat", "projects", "agents", "skills", "settings"].map((page) => {
    const link = get(`nav-${page}`); link.dataset.page = page; return link;
  });
  const groupsManage = get("sidebar-manage-groups"); groupsManage.className = "sidebar-manage"; groupsManage.dataset.page = "groups";
  links.push(groupsManage);
  document.getElementById = (id) => ["llm-dot", "llm-state", "jev-dot", "jev-state"].includes(id) ? null : get(id);
  document.querySelectorAll = (selector) => selector === ".nav-item, .sidebar-manage" ? links : inputs;
  get("setup-banner").firstElementChild = get("banner-text");
  get("project-setup-banner").firstElementChild = get("project-banner-text");
  get("chat-panel-toggle").setAttribute("aria-controls", "requirements-panel");
  get("agent-panel-toggle").setAttribute("aria-controls", "agent-panel");
  const media = new Map();
  window.matchMedia = (query) => {
    const match = new Events(); match.matches = query.includes("reduced") ? reduced : compact;
    media.set(query, match); return match;
  };
  const pending = [];
  if (transitions) document.startViewTransition = (callback) => {
    const item = { callback, ready: Promise.resolve(), skipped: false, skipTransition() { this.skipped = true; } };
    pending.push(item); return item;
  };
  const location = { hash }, history = {
    replaceState: (_state, _title, hash) => { location.hash = hash; },
    pushState: (_state, _title, hash) => { location.hash = hash; },
  };
  class Event { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } }
  const stored = new Map([["neuma-project-library-collapsed", String(collapsed)], ["neuma-sidebar-collapsed", String(sidebarCollapsed)]]);
  const localStorage = {
    getItem(key) { if (storageBlocked) throw new Error("Unavailable"); return stored.get(key); },
    setItem(key, value) { if (storageBlocked) throw new Error("Unavailable"); stored.set(key, value); },
  };
  const resizeObservers = [];
  class WidthObserver {
    constructor(callback) { this.callback = callback; resizeObservers.push(this); }
    observe(target) { this.target = target; }
    notify(width) { this.callback([{ target: this.target, contentRect: { width } }]); }
  }
  vm.runInNewContext(source, { document, window, location, history, localStorage, Event, CustomEvent: Event,
    MutationObserver: class { observe() {} },
    ...(resizeObserver ? { ResizeObserver: WidthObserver } : {}),
    fetch: async () => ({ ok: true, json: async () => ({ llmConfigured: configured, jevConfigured: true }) }),
  });
  const navigate = (detail) => document.dispatchEvent(new Event("neuma:navigate", { detail }));
  return { get, document, window, location, media, pending, navigate, stored, resizeObservers };
}

test("Skills 支持直接访问、导航焦点和折叠侧栏后的页面切换", () => {
  const { get, navigate, location, window, document } = setup({ hash: "#skills", sidebarCollapsed: true });
  assert.equal(get("page-skills").hidden, false);
  assert.equal(get("nav-skills").getAttribute("aria-current"), "page");
  assert.equal(get("app-shell").classes.has("sidebar-collapsed"), true);
  navigate({ page: "chat" });
  assert.equal(get("page-skills").hidden, true);
  navigate({ page: "skills" });
  assert.equal(location.hash, "#skills");
  assert.equal(document.activeElement, get("skills-search"));
  location.hash = "#settings"; window.dispatchEvent({ type: "popstate" });
  assert.equal(get("page-skills").hidden, true);
  assert.equal(get("nav-skills").getAttribute("aria-current"), null);
  location.hash = "#skills"; window.dispatchEvent({ type: "hashchange" });
  assert.equal(get("page-skills").hidden, false);
});

test("旧创建入口统一到主聊天，群详情保持群导航选中且主草稿保留", () => {
  const { get, navigate, location, document } = setup({ hash: "#chat" });
  get("main-message").value = "主助理下一条草稿";
  get("message").value = "正在整理创建需求";
  navigate({ page: "create" });
  assert.equal(get("page-create").hidden, true);
  assert.equal(get("page-create").inert, true);
  assert.equal(location.hash, "#chat");
  assert.equal(document.activeElement.id, "main-message");
  navigate({ page: "group", groupId: "group-one" });
  assert.equal(location.hash, "#group/group-one");
  assert.equal(get("page-group").hidden, false);
  assert.equal(get("sidebar-manage-groups").getAttribute("aria-current"), "page");
  assert.equal(document.activeElement.id, "group-message");
  navigate({ page: "chat" });
  assert.equal(get("main-message").value, "主助理下一条草稿");
  assert.equal(get("message").value, "正在整理创建需求");
  assert.equal(document.activeElement.id, "main-message");
});

test("群组管理从我的群组标题进入，群详情与管理页都选中同一入口", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const navigation = html.match(/<nav class="nav"[\s\S]*?<\/nav>/)[0];
  assert.doesNotMatch(navigation, /data-page="groups"/);
  const manage = html.match(/<a\b[^>]*id="sidebar-manage-groups"[^>]*>/)[0];
  assert.match(manage, /class="sidebar-manage"/); assert.match(manage, /href="#groups"/);
  assert.match(manage, /data-page="groups"/);
  const { get, navigate } = setup();
  navigate({ page: "groups" });
  assert.equal(get("sidebar-manage-groups").getAttribute("aria-current"), "page");
  navigate({ page: "group", groupId: "one" });
  assert.equal(get("sidebar-manage-groups").getAttribute("aria-current"), "page");
  navigate({ page: "chat" });
  assert.equal(get("sidebar-manage-groups").getAttribute("aria-current"), null);
});

test("主导航折叠保留页面与草稿，隐藏控件归还焦点，露出智能体图标入口", () => {
  const { get, document, location, stored, navigate } = setup({ hash: "#projects/assistant" });
  get("project-message").value = "保留这条草稿";
  get("sidebar-create-agent").focus();
  get("sidebar-toggle").click();
  assert.equal(document.activeElement.id, "sidebar-toggle");
  assert.equal(get("sidebar-details").inert, true);
  assert.equal(get("sidebar-agents-shortcut").inert, false);
  assert.equal(get("sidebar-toggle").getAttribute("aria-label"), "展开主导航");
  assert.equal(stored.get("neuma-sidebar-collapsed"), "true");
  assert.equal(location.hash, "#projects/assistant");
  navigate({ page: "settings" });
  assert.equal(get("app-shell").classes.has("sidebar-collapsed"), true);
  assert.equal(get("page-settings").hidden, false);
  assert.equal(get("project-message").value, "保留这条草稿");
  get("sidebar-agents-shortcut").focus(); get("sidebar-toggle").click();
  assert.equal(document.activeElement.id, "sidebar-toggle");
  assert.equal(get("sidebar-details").inert, false);
  assert.equal(get("sidebar-agents-shortcut").inert, true);
});

test("主导航和项目栏独立恢复、独立折叠，快速切换取最后状态", () => {
  const { get, stored } = setup({ collapsed: true, sidebarCollapsed: true });
  assert.equal(get("app-shell").classes.has("sidebar-collapsed"), true);
  assert.equal(get("sidebar-toggle").getAttribute("aria-expanded"), "false");
  for (let i = 0; i < 5; i++) get("sidebar-toggle").click();
  assert.equal(get("app-shell").classes.has("sidebar-collapsed"), false);
  assert.equal(get("project-workspace").classes.has("library-collapsed"), true);
  assert.equal(stored.get("neuma-project-library-collapsed"), "true");
  assert.equal(stored.get("neuma-sidebar-collapsed"), "false");
  get("sidebar-toggle").click(); get("project-library-toggle").click();
  assert.equal(get("app-shell").classes.has("sidebar-collapsed"), true);
  assert.equal(get("project-workspace").classes.has("library-collapsed"), false);
});

test("主导航在存储受限和减少动态效果下仍可正常展开收起", () => {
  const { get } = setup({ storageBlocked: true, reduced: true });
  get("sidebar-toggle").click();
  assert.equal(get("sidebar-details").inert, true);
  get("sidebar-toggle").click();
  assert.equal(get("sidebar-details").inert, false);
  assert.equal(get("sidebar-toggle").getAttribute("aria-expanded"), "true");
});

test("折叠收走隐藏控件的焦点，保留输入和路由，并记住状态", () => {
  const { get, document, location, navigate, stored } = setup({ hash: "#projects/assistant" });
  get("project-message").value = "未发送的草稿";
  get("project-search").value = "记账"; get("project-search").focus();
  get("project-library-toggle").click();
  assert.equal(get("project-library-body").inert, true);
  assert.equal(document.activeElement.id, "project-library-toggle");
  assert.equal(get("project-library-toggle").getAttribute("aria-expanded"), "false");
  assert.equal(get("project-library-toggle").getAttribute("aria-label"), "展开项目栏");
  assert.equal(stored.get("neuma-project-library-collapsed"), "true");
  assert.equal(location.hash, "#projects/assistant");
  navigate({ page: "projects", projectView: "list" });
  assert.equal(get("project-workspace").classes.has("library-collapsed"), true);
  get("project-assistant-home").click();
  assert.equal(get("project-message").value, "未发送的草稿");
  assert.equal(get("project-search").value, "记账");
});

test("连续折叠展开只取最后状态，查找项目可重新打开侧栏", () => {
  const { get, document, stored } = setup({ collapsed: true });
  assert.equal(get("project-library-body").inert, true);
  for (let i = 0; i < 5; i++) get("project-library-toggle").click();
  assert.equal(get("project-library-body").inert, false);
  get("project-library-toggle").click();
  document.dispatchEvent({ type: "neuma:project-library-open" });
  assert.equal(get("project-library-body").inert, false);
  assert.equal(get("project-workspace").classes.has("library-collapsed"), false);
  assert.equal(get("project-library-toggle").getAttribute("aria-expanded"), "true");
  assert.equal(stored.get("neuma-project-library-collapsed"), "false");
});

test("浏览器存储不可用、减少动态效果时仍可折叠和展开", () => {
  const { get } = setup({ storageBlocked: true, reduced: true });
  get("project-library-toggle").click();
  assert.equal(get("project-library-body").inert, true);
  get("project-library-toggle").click();
  assert.equal(get("project-library-body").inert, false);
});

test("主 Agent 与项目工作区分离，切换保留各自输入", () => {
  const { get, location, navigate } = setup();
  get("message").value = "会议纪要需求";
  get("project-message").value = "项目操作草稿";
  get("project-assistant-home").click();
  assert.equal(location.hash, "#projects/assistant");
  assert.equal(get("page-chat").hidden, true);
  assert.equal(get("page-projects").hidden, false);
  assert.equal(get("chat-projects").hidden, false);
  assert.equal(get("project-assistant-home").getAttribute("aria-pressed"), "true");
  assert.equal(get("project-library").hidden, false);
  navigate({ page: "chat" });
  assert.equal(get("page-chat").hidden, false);
  assert.equal(get("page-projects").hidden, true);
  assert.equal(get("message").value, "会议纪要需求");
  assert.equal(get("project-message").value, "项目操作草稿");
});

test("详情和助手共用右侧区域，项目列表常驻且保留草稿", () => {
  const { get, navigate, document } = setup({ hash: "#projects/assistant" });
  get("project-message").value = "保留这段草稿";
  navigate({ page: "projects", projectView: "list" });
  assert.equal(get("manage-projects").hidden, false);
  assert.equal(get("chat-projects").hidden, true);
  assert.equal(get("project-library").hidden, false);
  get("project-assistant-home").click();
  assert.equal(get("manage-projects").hidden, true);
  assert.equal(get("project-message").value, "保留这段草稿");
  assert.equal(document.activeElement.id, "project-message");
});

test("浏览器返回和前进恢复面板，重复路由事件只通知一次", () => {
  const { get, window, document, location } = setup();
  let updates = 0;
  document.addEventListener("neuma:route", () => updates++);
  location.hash = "#agents";
  window.dispatchEvent({ type: "popstate" });
  window.dispatchEvent({ type: "hashchange" });
  assert.equal(updates, 1);
  assert.equal(get("page-agents").hidden, false);
  assert.equal(get("nav-agents").getAttribute("aria-current"), "page");
  assert.equal(get("nav-projects").getAttribute("aria-current"), null);
  assert.equal(get("page-chat").hidden, true);
  location.hash = "#chat/requirements";
  window.dispatchEvent({ type: "popstate" });
  assert.equal(get("page-create").hidden, true);
  assert.equal(get("page-chat").hidden, false);
  assert.equal(location.hash, "#chat");
});

test("辅助面板的收起不再影响项目列表，项目工作区的 Escape 不隐藏列表", () => {
  const { get, document } = setup();
  get("chat-panel-toggle").click();
  assert.equal(get("requirements-panel").hidden, true);
  assert.equal(get("chat-requirements").classes.has("panel-collapsed"), true);
  get("project-assistant-home").click();
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert.equal(get("project-library").hidden, false);
  assert.equal(document.activeElement.id, "project-message");
});

test("窄屏默认收起辅助信息，展开后滚动到内容", () => {
  const { get } = setup({ compact: true });
  assert.equal(get("requirements-panel").hidden, true);
  get("chat-panel-toggle").click();
  assert.equal(get("requirements-panel").hidden, false);
  assert.equal(get("requirements-panel").scrolled, true);
  assert.equal(get("requirements-panel").scrollOptions.behavior, "smooth");
  assert.equal(get("requirements-panel").scrollOptions.block, "start");
});

test("减少动态效果时展开辅助信息使用即时滚动，切换仍聚焦目标输入", () => {
  const { get, pending, navigate, document } = setup({ compact: true, reduced: true, transitions: true });
  get("chat-panel-toggle").click();
  assert.equal(get("requirements-panel").hidden, false);
  assert.equal(get("requirements-panel").scrollOptions.behavior, "instant");
  assert.equal(get("requirements-panel").scrollOptions.block, "start");
  navigate({ page: "projects", projectView: "assistant" });
  assert.equal(pending.length, 0);
  assert.equal(get("chat-projects").hidden, false);
  assert.equal(document.activeElement.id, "project-message");
});

test("在当前页面再次请求创建时仍然聚焦输入框", () => {
  const { get, navigate, document } = setup();
  get("chat-panel-toggle").focus();
  navigate({ page: "create" });
  assert.equal(document.activeElement.id, "main-message");
});

test("快速切换立即显示最后请求的页面，不等待浏览器快照动画", () => {
  const { get, pending, navigate } = setup({ transitions: true });
  navigate({ page: "projects" });
  navigate({ page: "settings" });
  assert.equal(pending.length, 0);
  assert.equal(get("page-settings").hidden, false);
  assert.equal(get("page-projects").hidden, true);
  assert.equal(get("page-chat").hidden, true);
});

test("导航后的新链接在 hashchange 到达时直接生效", () => {
  const { get, navigate, location, window } = setup({ transitions: true });
  navigate({ page: "projects", projectView: "assistant" });
  location.hash = "#projects/add";
  window.dispatchEvent({ type: "hashchange" });
  assert.equal(location.hash, "#projects/add");
  assert.equal(get("project-add-panel").open, true);
  assert.equal(get("chat-projects").hidden, false);
});

test("添加弹窗保留原工作区，取消和浏览器返回保留未提交表单", () => {
  const { get, navigate, document, window, location } = setup({ hash: "#projects/add" });
  assert.equal(get("page-projects").hidden, false);
  assert.equal(get("project-add-panel").open, true);
  assert.equal(get("manage-projects").hidden, true);
  assert.equal(get("chat-projects").hidden, false);
  assert.equal(get("project-library").hidden, false);
  assert.equal(get("nav-projects").getAttribute("aria-current"), "page");
  assert.equal(document.activeElement.id, "project-path");
  get("project-path").value = "/demo/my-project";
  get("project-add-cancel").click();
  assert.equal(get("project-add-panel").open, false);
  assert.equal(location.hash, "#projects/assistant");
  assert.equal(document.activeElement.id, "project-add-link");
  navigate({ page: "projects", projectView: "list" });
  assert.equal(get("manage-projects").hidden, false);
  location.hash = "#projects/add";
  window.dispatchEvent({ type: "popstate" });
  assert.equal(get("project-path").value, "/demo/my-project");
  assert.equal(get("manage-projects").hidden, false);
  get("project-add-panel").dispatchEvent({ type: "cancel", preventDefault() {} });
  assert.equal(location.hash, "#projects/list");
  assert.equal(get("project-add-panel").open, false);
});

test("旧导航链接保持可用，未知项目子路由回到助手", () => {
  for (const [hash, canonical, page, panel] of [
    ["#chat/projects", "#projects/assistant", "projects", "chat-projects"],
    ["#manage/projects", "#projects/list", "projects", "manage-projects"],
    ["#manage", "#projects/list", "projects", "manage-projects"],
    ["#add", "#projects/add", "projects", "project-add-panel"],
    ["#manage/agents", "#agents", "agents", "page-agents"],
    ["#chat/requirements", "#chat", "chat", "page-chat"],
    ["#create", "#chat", "chat", "page-chat"],
    ["#projects/unknown", "#projects/assistant", "projects", "chat-projects"],
  ]) {
    const { get, location } = setup({ hash });
    assert.equal(location.hash, canonical, hash);
    assert.equal(get(`page-${page}`).hidden, false, hash);
    assert.equal(get(panel).hidden, false, hash);
  }
});

test("旧创建书签在模块加载后激活需求，重复创建入口在同一主页面继续生效", () => {
  const { get, location, document, navigate } = setup({ hash: "#create" });
  let activated = 0; document.addEventListener("neuma:main-requirements", () => activated++);
  assert.equal(location.hash, "#chat"); assert.equal(get("page-create").hidden, true);
  document.dispatchEvent({ type: "DOMContentLoaded" }); assert.equal(activated, 1);
  navigate({ page: "create" }); navigate({ page: "create" }); assert.equal(activated, 3);
  assert.equal(document.activeElement.id, "main-message");
});

test("侧栏移除服务状态和本机说明后，模型健康检查仍正常更新配置提示", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const sidebar = html.match(/<aside class="sidebar">[\s\S]*?<\/aside>/)[0];
  assert.doesNotMatch(sidebar, /service-status|模型服务|Jev 判断|仅在本机运行/);
  const { get, document } = setup();
  await new Promise(setImmediate);
  assert.equal(get("setup-banner").hidden, true);
  assert.equal(get("project-setup-banner").hidden, true);
  document.dispatchEvent({ type: "neuma:settings-changed" });
  await new Promise(setImmediate);
  assert.equal(get("setup-banner").hidden, true);
});

test("未配置模型时主 Agent 和项目助手都显示配置提示", async () => {
  const { get } = setup({ configured: false });
  await new Promise(setImmediate);
  assert.equal(get("setup-banner").hidden, false);
  assert.equal(get("project-setup-banner").hidden, false);
  assert.match(get("project-banner-text").textContent, /模型服务尚未配置/);
});

test("输入法确认和 Shift+Enter 不提交，普通 Enter 提交一次", () => {
  const { get } = setup();
  const input = get("message");
  for (const extra of [{ isComposing: true }, { keyCode: 229 }, { shiftKey: true }]) {
    input.dispatchEvent({ type: "keydown", key: "Enter", ...extra, preventDefault() { assert.fail("不应拦截输入法或换行"); } });
  }
  assert.equal(input.submissions, undefined);
  input.dispatchEvent({ type: "keydown", key: "Enter", preventDefault() {} });
  assert.equal(input.submissions, 1);
});

test("Agent 与群输入框随宽度重新增高，同宽高度通知不递归，隐藏后恢复仍重新计算", () => {
  const { get, resizeObservers } = setup({ resizeObserver: true });
  assert.equal(resizeObservers.length, 2);
  assert.deepEqual(resizeObservers.map((observer) => observer.target.id), ["agent-message", "group-message"]);
  for (const id of ["agent-message", "group-message"]) {
    const input = get(id), observer = resizeObservers.find((item) => item.target === input);
    let height = 34, reads = 0;
    Object.defineProperty(input, "scrollHeight", { get() { reads++; return height; } });
    input.style.height = "previous"; input.hidden = true;
    observer.notify(0);
    assert.equal(reads, 0); assert.equal(input.style.height, "previous");
    input.hidden = false; observer.notify(420);
    assert.equal(reads, 1); assert.equal(input.style.height, "34px");
    height = 86; observer.notify(300);
    assert.equal(reads, 2); assert.equal(input.style.height, "86px");
    height = 112; observer.notify(300);
    assert.equal(reads, 2); assert.equal(input.style.height, "86px");
    height = 220; observer.notify(280);
    assert.equal(reads, 3); assert.equal(input.style.height, "180px");
    input.hidden = true; observer.notify(0);
    assert.equal(reads, 3); assert.equal(input.style.height, "180px");
    input.hidden = false; height = 34; observer.notify(420);
    assert.equal(reads, 4); assert.equal(input.style.height, "34px");
  }
});

test("智能体说明不再跟随主需求面板展开，进入智能体仍聚焦对话输入", () => {
  const { get, document, navigate } = setup();
  get("agent-panel").hidden = true;
  navigate({ page: "agent", agentId: "paper" });
  assert.equal(document.activeElement.id, "agent-message");
  assert.equal(get("agent-panel").hidden, true);
  assert.equal(get("agent-panel").open, false);
  assert.equal(get("agent-workspace").classes.has("panel-collapsed"), false);
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert.equal(get("agent-panel").open, false);
});
