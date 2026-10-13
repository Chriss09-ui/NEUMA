import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createCollaborationApi } from "../public/collaboration-api.js";
import { renderAgentAvatar as renderAvatar, resolveAgentAvatar } from "../public/agent-avatar.js";
import { renderGroupAvatar as renderGroup } from "../public/group-avatar.js";
import { createSelectMenu } from "../public/select-menu.js";

const read = async (file) => (await readFile(new URL(`../public/${file}`, import.meta.url), "utf8"))
  .replace(/^import[\s\S]*?;\n/gm, "").replace(/^export /gm, "");
const groupsSource = (await Promise.all(["collaboration-api.js", "group-view.js", "group-materials.js", "groups.js"].map(read))).join("\n");
const mainSource = (await Promise.all(["chat-ui.js", "agent-runtime.js", "collaboration-api.js", "group-view.js", "main-materials.js", "main-context.js", "main-agent.js"].map(read))).join("\n");
const settle = async () => { for (let index = 0; index < 4; index++) await new Promise(setImmediate); };
const copy = structuredClone;

function setup(source, request, initialStorage = [], { confirm = () => false } = {}) {
  class Events {
    listeners = new Map();
    addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); }
    dispatchEvent(event) { if (!event.target) Object.defineProperty(event, "target", { value: this, configurable: true });
      return Promise.all((this.listeners.get(event.type) || []).map((listener) => listener(event))); }
  }
  const document = new Events(), nodes = new Map(), timers = new Map(), stored = new Map(initialStorage), renderedReplies = [], confirmations = [];
  class Element extends Events {
    constructor(tag = "div") { super(); this.tagName = tag.toUpperCase(); }
    children = []; attributes = new Map(); dataset = {}; hidden = false; open = false; disabled = false; checked = false;
    className = ""; textContent = ""; contentValue = ""; scrollHeight = 300; clientHeight = 300; scrollTop = 0; style = {};
    classes = new Set(); classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name),
      add: (...names) => names.forEach((name) => this.classes.add(name)), remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name) || this.className.split(/\s+/).includes(name) };
    get value() { return this.contentValue || (this.tagName === "SELECT" ? this.children[0]?.value || "" : ""); }
    set value(value) { this.contentValue = value; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    removeAttribute(name) { this.attributes.delete(name); }
    getAttribute(name) { return this.attributes.get(name); }
    querySelector(selector) { return this.querySelectorAll(selector)[0]; }
    contains(element) { return this === element || this.querySelectorAll("*").includes(element); }
    querySelectorAll(selector) {
      const all = this.children.flatMap((child) => child instanceof Element ? [child, ...child.querySelectorAll("*")] : []);
      return selector === "input:checked" ? all.filter((item) => item.tagName === "INPUT" && item.checked)
        : selector === "button" ? all.filter((item) => item.tagName === "BUTTON")
          : selector.startsWith(".") ? all.filter((item) => item.classList.contains(selector.slice(1)))
            : selector.startsWith("#") ? all.filter((item) => item.id === selector.slice(1)) : all;
    }
    showModal() { this.open = true; }
    close() { this.open = false; }
    focus() { document.activeElement = this; }
    click() { return this.dispatchEvent({ type: "click", target: this }); }
    getBoundingClientRect() { return { left: 42, top: 100, right: 300, bottom: 132, width: 258, height: 32 }; }
  }
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, Object.assign(new Element(["group-task-filter", "group-recipient", "group-share-agent"].includes(id) ? "select" : "div"), {
      id, ...(id === "main-history-menu" ? { hidden: true } : {}), ...(id === "main-history-delete" ? { textContent: "删除对话" } : {}),
    }));
    return nodes.get(id);
  };
  document.hidden = false; document.getElementById = (id) => id === "group-purpose" ? null : get(id);
  document.createElement = (tag) => new Element(tag);
  class Event { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } }
  document.defaultView = { Event };
  let serial = 0;
  const context = vm.createContext({ document, Event, CustomEvent: Event, crypto: { randomUUID: () => `mutation-${++serial}` },
    window: { innerWidth: 1440, innerHeight: 900, addEventListener() {}, confirm(message) { confirmations.push(message); return confirm(message); } },
    renderRichText(container, content) { renderedReplies.push({ container, content }); container.textContent = content;
      container.classes.add("rich-text"); container.className = [...new Set([...container.className.split(/\s+/).filter(Boolean), "rich-text"])].join(" "); },
    renderAgentAvatar: (target, agent, options = {}) => renderAvatar(target, agent, { ...options, document }),
    renderGroupAvatar: (target, group, members) => renderGroup(target, group, members, { document }),
    createSelectMenu,
    fetch: request, Response, ReadableStream, TextDecoder, TextEncoder, AbortController, structuredClone, URL, Blob, setTimeout, clearTimeout,
    localStorage: { getItem: (key) => stored.get(key) || null, setItem: (key, value) => stored.set(key, value) },
    setInterval(callback) { const id = ++serial; timers.set(id, callback); return id; }, clearInterval(id) { timers.delete(id); },
  });
  vm.runInContext(source, context);
  return { get, document, timers, stored, context, renderedReplies, confirmations, route: (detail) => document.dispatchEvent(new Event("neuma:route", { detail })),
    submit: (id) => get(id).dispatchEvent({ type: "submit", preventDefault() {} }), text: (id) => textOf(get(id)) };
}
const textOf = (node) => `${node.textContent || ""}${(node.children || []).map(textOf).join("")}`;
const isBubble = (node) => node.className.split(/\s+/).includes("bubble");
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
  const avatars = () => [ui.get("sidebar-group-list").children[0].children[0],
    ui.get("groups-list").children[0].children[0].children[0], ui.get("group-avatar")];
  for (const avatar of avatars()) {
    assert.equal(avatar.dataset.memberCount, "2");
    assert.deepEqual(avatar.children.map((child) => child.dataset.avatarIcon), ["star:4:1", "star:0:2"]);
    assert.ok(avatar.children.every((child) => child.children[0].dataset.avatarMotion === "false"));
  }
  const before = requests.length;
  await ui.document.dispatchEvent({ type: "neuma:agent-profile-changed", detail: { id: "writer", profile: { icon: "star:1:7" } } });
  for (const avatar of avatars()) assert.equal(avatar.children[0].dataset.avatarIcon, "star:1:7");
  assert.equal(requests.length, before);
  assert.equal(ui.get("sidebar-group-list").children[0].href, "#group/one");
  assert.equal(ui.text("sidebar-group-list"), "研究小组");
});

test("群成员自主协作、能力和任务分开显示，离开群页不会取消正在执行的任务", async () => {
  const requests = [], ui = setup(groupsSource, async (path) => {
    requests.push(path);
    return Response.json(path === "/api/groups" ? { groups: [group()] } : path.endsWith("events?after=1") ? { events: [], lastSequence: 1 } : detail());
  });
  await settle(); await ui.route({ page: "group", groupId: "one" }); await settle();
  assert.match(ui.text("group-members"), /写作助手/); assert.match(ui.text("group-members"), /检查助手/);
  assert.match(ui.text("group-tasks"), /整理初稿/);
  assert.equal(ui.get("group-recipient").children[0].textContent, "群内成员自主协作");
  assert.equal(ui.text("group-compose-status"), ""); assert.equal(ui.get("group-compose-status").hidden, true);
  assert.equal(ui.get("group-members").children.length, 2);
  ui.get("group-message").value = "留在这个群的草稿";
  await ui.route({ page: "chat" }); await settle();
  assert.equal(ui.timers.size, 0); assert.equal(requests.some((path) => path.includes("cancel")), false);
  await ui.route({ page: "group", groupId: "one" }); await settle();
  assert.equal(ui.get("group-message").value, "留在这个群的草稿");
});

test("群消息使用纯气泡，身份与定向接收者仅保留在无障碍标签和提示中", async () => {
  const state = detail(), createdAt = "2026-10-12T02:00:00.000Z";
  state.messages[0] = { ...state.messages[0], recipientId: "reviewer", createdAt };
  state.messages.push({ id: "message-two", seq: 2, sender: { type: "user", id: "user", name: "用户" },
    content: "请检查写作助手的初稿", recipientId: "writer", taskId: "task-one", status: "complete", createdAt });
  state.lastSequence = 2;
  const ui = setup(groupsSource, async (path) => Response.json(path === "/api/groups" ? { groups: [group()] } : state));
  await settle(); await ui.route({ page: "group", groupId: "one" }); await settle();
  const rows = ui.get("group-messages").children;
  assert.equal(rows.length, 2);
  for (const [index, role, sender, recipient] of [[0, "assistant", "写作助手", "检查助手"], [1, "user", "你", "写作助手"]]) {
    const row = rows[index], body = row.children.find(isBubble);
    assert.equal(row.className, `message ${role}`); assert.equal(row.getAttribute("role"), "group");
    assert.equal(row.getAttribute("aria-label"), `${sender}发送的消息，定向发送给${recipient}`);
    assert.equal(row.getAttribute("title"), `${sender} → ${recipient}`);
    assert.equal(body.textContent, state.messages[index].content);
    assert.equal(row.querySelectorAll("*").some((item) => item.className.startsWith("collaboration-message-") || item.tagName === "TIME"), false);
    assert.equal(textOf(row), state.messages[index].content);
  }
  assert.match(ui.text("group-members"), /写作助手/); assert.match(ui.text("group-members"), /检查助手/);
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
  assert.equal(ui.get("group-messages").children.length, 3);
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
  assert.equal(rows[1].getAttribute("aria-label"), "检查助手发送的消息，定向发送给former-member");
  assert.equal(rows[1].children.find(isBubble).textContent, "已保留检查结果");
});

test("定制接收者菜单发送选定成员，自主协作不传成员，未就绪选项不可选", async () => {
  const state = detail(), writes = []; state.members[1].ready = false;
  const ui = setup(groupsSource, async (path, options = {}) => {
    if (path.endsWith("/messages")) { writes.push(JSON.parse(options.body)); return Response.json({ message: { id: "sent" } }); }
    return Response.json(path === "/api/groups" ? { groups: [group()] } : state);
  });
  await settle(); await ui.route({ page: "group", groupId: "one" }); await settle();
  await ui.get("group-recipient-trigger").click();
  await ui.get("group-recipient-menu").children[2].click();
  assert.equal(ui.get("group-recipient").value, "");
  await ui.get("group-recipient-menu").children[1].click();
  assert.equal(ui.get("group-recipient").value, "writer");
  assert.equal(ui.get("group-recipient-value").textContent, "写作助手");
  assert.equal(ui.get("group-recipient-menu").hidden, true);
  ui.get("group-message").value = "请整理报告"; await ui.submit("group-chat-form"); await settle();
  assert.equal(writes[0].recipientId, "writer");
  await ui.get("group-recipient-trigger").click(); await ui.get("group-recipient-menu").children[0].click();
  ui.get("group-message").value = "请自主协作"; await ui.submit("group-chat-form"); await settle();
  assert.equal(Object.hasOwn(writes[1], "recipientId"), false);
});

test("定制任务菜单筛选消息，刷新保留选择，任务移除或新任务恢复全部", async () => {
  const state = detail(); state.tasks.push({ id: "task-two", goal: "第二项任务", status: "completed" });
  state.messages.push({ ...state.messages[0], id: "message-two", taskId: "task-two", content: "第二份材料" });
  const ui = setup(groupsSource, async (path) => Response.json(path === "/api/groups" ? { groups: [group()] } : state));
  await settle(); await ui.route({ page: "group", groupId: "one" }); await settle();
  await ui.get("group-task-trigger").click(); await ui.get("group-task-menu").children[2].click();
  assert.equal(ui.get("group-task-filter").value, "task-two");
  assert.match(ui.text("group-messages"), /第二份材料/); assert.doesNotMatch(ui.text("group-messages"), /研究小组的初稿/);
  assert.equal(ui.document.activeElement, ui.get("group-message"));
  await ui.get("group-refresh").click(); await settle(); assert.equal(ui.get("group-task-filter").value, "task-two");
  state.tasks.pop(); await ui.get("group-refresh").click(); await settle();
  assert.equal(ui.get("group-task-filter").value, ""); assert.equal(ui.get("group-task-value").textContent, "全部消息");
  await ui.get("group-task-trigger").click(); await ui.get("group-task-menu").children[1].click();
  await ui.get("group-new-task").click(); assert.equal(ui.get("group-task-filter").value, "");
});

test("接收者菜单发送中禁用关闭，完成后恢复，跨群不继承旧收件人", async () => {
  const state = detail(); let release;
  const ui = setup(groupsSource, async (path) => {
    if (path.endsWith("/messages")) return new Promise((resolve) => { release = () => resolve(Response.json({ message: { id: "sent" } })); });
    return Response.json(path === "/api/groups" ? { groups: [group()] } : path === "/api/groups/two" ? detail("two") : state);
  });
  await settle(); await ui.route({ page: "group", groupId: "one" }); await settle();
  await ui.get("group-recipient-trigger").click(); await ui.get("group-recipient-menu").children[1].click();
  await ui.get("group-recipient-trigger").click(); ui.get("group-message").value = "整理报告";
  await ui.submit("group-chat-form"); await settle();
  assert.equal(ui.get("group-recipient-trigger").disabled, true); assert.equal(ui.get("group-recipient-menu").hidden, true);
  assert.equal(ui.get("group-compose-status").hidden, false); assert.match(ui.text("group-compose-status"), /正在提交/);
  release(); await settle(); assert.equal(ui.get("group-recipient-trigger").disabled, false);
  await ui.get("group-recipient-trigger").click(); await ui.route({ page: "group", groupId: "two" }); await settle();
  assert.equal(ui.get("group-recipient-menu").hidden, true); assert.equal(ui.get("group-recipient").value, "");
  state.group.archived = true; await ui.route({ page: "group", groupId: "one" }); await settle();
  assert.equal(ui.get("group-recipient-trigger").disabled, true);
});

test("群任务轮询不收起正在浏览的接收者菜单，也不改变待确认活动项", async () => {
  const state = detail();
  const ui = setup(groupsSource, async (path) => Response.json(path === "/api/groups" ? { groups: [group()] }
    : path.includes("/events?") ? { events: [{ seq: 2 }], lastSequence: 2 } : state));
  await settle(); await ui.route({ page: "group", groupId: "one" }); await settle();
  const trigger = ui.get("group-recipient-trigger"); await trigger.click();
  await trigger.dispatchEvent({ type: "keydown", key: "ArrowDown", preventDefault() {} });
  const active = trigger.getAttribute("aria-activedescendant"); ui.get("group-recipient-menu").scrollTop = 64;
  [...ui.timers.values()][0](); await settle();
  assert.equal(ui.get("group-recipient-menu").hidden, false);
  assert.equal(trigger.getAttribute("aria-activedescendant"), active);
  assert.equal(ui.get("group-recipient-menu").scrollTop, 64); assert.equal(ui.get("group-recipient").value, "");
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
  ui.get("group-message").value = "检查初稿"; ui.get("group-recipient").value = "reviewer";
  await ui.submit("group-chat-form"); await settle();
  assert.equal(ui.get("group-message").value, "检查初稿"); assert.match(ui.text("group-error"), /仍保留/);
  await ui.submit("group-chat-form"); await settle();
  assert.deepEqual(writes[1], writes[0]); assert.equal(writes[0].recipientId, "reviewer"); assert.equal(writes[0].taskId, "task-one");
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
    assert.equal(name.textContent, candidate.name); assert.equal(status.textContent, candidate.ready ? "可工作" : "未就绪");
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

test("已完成任务的后续材料请求自动开启新任务，真实执行阶段显示中文", async () => {
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
  assert.equal(writes[0].newTask, true); assert.equal(writes[0].taskId, undefined);
  assert.ok(writes[0].content.trim()); assert.deepEqual(writes[0].attachmentIds, ["material-one"]);
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
    assert.equal(ui.document.activeElement, ui.get("group-share-open"));
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
  assert.equal(ui.get("main-workspace").classes.has("history-collapsed"), true);
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
    assert.equal(ui.get("main-workspace").classes.has("history-collapsed"), !visible);
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
  assert.equal(ui.text("sidebar-group-list"), "新建研究组");
  assert.equal(ui.get("sidebar-group-list").children[0].href, "#group/created-group");
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
  assert.equal(ui.text("sidebar-group-list"), "新的研究组"); assert.equal(ui.get("main-message").value, "下一条未发送主草稿");
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
  assert.match(html, /aria-label="主助理历史对话"/); assert.match(html, /aria-label="群成员与任务"/);
  assert.match(html, /id="main-message"/); assert.match(html, /id="group-message"/); assert.match(html, /id="main-create-agent"/);
  const groupHeader = html.slice(html.indexOf('<section id="page-group"'), html.indexOf('<dialog id="group-editor"')).match(/<header[\s\S]*?<\/header>/)?.[0];
  assert.ok(groupHeader); assert.match(groupHeader, /id="group-title"/);
  assert.doesNotMatch(groupHeader, /id="group-purpose"|page-subtitle/);
  assert.match(html, /id="group-purpose-input"/);
  const formStart = html.indexOf('<form id="group-chat-form"');
  const groupForm = html.slice(formStart, html.indexOf('</form>', formStart));
  const footerStart = groupForm.indexOf('<div class="composer-footer">');
  assert.ok(footerStart >= 0 && groupForm.indexOf('id="group-recipient-trigger"') > footerStart);
  assert.ok(groupForm.indexOf('id="group-upload"') > footerStart);
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
