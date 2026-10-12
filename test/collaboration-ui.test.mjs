import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createCollaborationApi } from "../public/collaboration-api.js";

const read = async (file) => (await readFile(new URL(`../public/${file}`, import.meta.url), "utf8"))
  .replace(/^import[\s\S]*?;\n/gm, "").replace(/^export /gm, "");
const groupsSource = (await Promise.all(["collaboration-api.js", "group-view.js", "group-materials.js", "groups.js"].map(read))).join("\n");
const mainSource = (await Promise.all(["chat-ui.js", "agent-runtime.js", "collaboration-api.js", "group-view.js", "main-materials.js", "main-context.js", "main-agent.js"].map(read))).join("\n");
const settle = async () => { for (let index = 0; index < 4; index++) await new Promise(setImmediate); };
const copy = structuredClone;

function setup(source, request, initialStorage = []) {
  class Events {
    listeners = new Map();
    addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); }
    dispatchEvent(event) { return Promise.all((this.listeners.get(event.type) || []).map((listener) => listener(event))); }
  }
  const document = new Events(), nodes = new Map(), timers = new Map(), stored = new Map(initialStorage);
  class Element extends Events {
    constructor(tag = "div") { super(); this.tagName = tag.toUpperCase(); }
    children = []; attributes = new Map(); dataset = {}; hidden = false; open = false; disabled = false; checked = false;
    className = ""; textContent = ""; contentValue = ""; scrollHeight = 300; clientHeight = 300; scrollTop = 0; style = {};
    classes = new Set(); classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
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
        : selector === "button" ? all.filter((item) => item.tagName === "BUTTON") : all;
    }
    showModal() { this.open = true; }
    close() { this.open = false; }
    focus() { document.activeElement = this; }
    click() { return this.dispatchEvent({ type: "click", target: this }); }
  }
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, Object.assign(new Element(["group-task-filter", "group-recipient", "group-share-agent"].includes(id) ? "select" : "div"), { id }));
    return nodes.get(id);
  };
  document.hidden = false; document.getElementById = get; document.createElement = (tag) => new Element(tag);
  class Event { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } }
  let serial = 0;
  const context = vm.createContext({ document, Event, CustomEvent: Event, crypto: { randomUUID: () => `mutation-${++serial}` },
    fetch: request, Response, ReadableStream, TextDecoder, TextEncoder, AbortController, structuredClone, URL, Blob, setTimeout, clearTimeout,
    localStorage: { getItem: (key) => stored.get(key) || null, setItem: (key, value) => stored.set(key, value) },
    setInterval(callback) { const id = ++serial; timers.set(id, callback); return id; }, clearInterval(id) { timers.delete(id); },
  });
  vm.runInContext(source, context);
  return { get, document, timers, stored, context, route: (detail) => document.dispatchEvent(new Event("neuma:route", { detail })),
    submit: (id) => get(id).dispatchEvent({ type: "submit", preventDefault() {} }), text: (id) => textOf(get(id)) };
}
const textOf = (node) => `${node.textContent || ""}${(node.children || []).map(textOf).join("")}`;
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

test("群成员自主协作、能力和任务分开显示，离开群页不会取消正在执行的任务", async () => {
  const requests = [], ui = setup(groupsSource, async (path) => {
    requests.push(path);
    return Response.json(path === "/api/groups" ? { groups: [group()] } : path.endsWith("events?after=1") ? { events: [], lastSequence: 1 } : detail());
  });
  await settle(); await ui.route({ page: "group", groupId: "one" }); await settle();
  assert.match(ui.text("group-members"), /写作助手/); assert.match(ui.text("group-members"), /检查助手/);
  assert.match(ui.text("group-tasks"), /整理初稿/);
  assert.equal(ui.get("group-recipient").children[0].textContent, "群内成员自主协作");
  assert.equal(ui.get("group-members").children.length, 2);
  ui.get("group-message").value = "留在这个群的草稿";
  await ui.route({ page: "chat" }); await settle();
  assert.equal(ui.timers.size, 0); assert.equal(requests.some((path) => path.includes("cancel")), false);
  await ui.route({ page: "group", groupId: "one" }); await settle();
  assert.equal(ui.get("group-message").value, "留在这个群的草稿");
});

test("群消息保留成员与用户身份、定向接收者和时间", async () => {
  const state = detail(), createdAt = "2026-10-12T02:00:00.000Z";
  state.messages[0] = { ...state.messages[0], recipientId: "reviewer", createdAt };
  state.messages.push({ id: "message-two", seq: 2, sender: { type: "user", id: "user", name: "用户" },
    content: "请继续检查", taskId: "task-one", status: "complete", createdAt });
  state.lastSequence = 2;
  const ui = setup(groupsSource, async (path) => Response.json(path === "/api/groups" ? { groups: [group()] } : state));
  await settle(); await ui.route({ page: "group", groupId: "one" }); await settle();
  const rows = ui.get("group-messages").children;
  assert.equal(rows.length, 2);
  const identity = rows[0].children.find((item) => item.className === "collaboration-message-heading");
  assert.equal(identity.children[0].className, "collaboration-message-avatar");
  assert.equal(identity.children[0].textContent, "写"); assert.equal(identity.children[1].textContent, "写作助手");
  assert.equal(identity.children[2].textContent, "→ 检查助手");
  assert.equal(identity.children.find((item) => item.tagName === "TIME").dateTime, createdAt);
  const userIdentity = rows[1].children.find((item) => item.className === "collaboration-message-heading");
  assert.equal(userIdentity.children[0].textContent, "我"); assert.equal(userIdentity.children[1].textContent, "你");
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
  await ui.submit("group-chat-form"); await settle();
  assert.equal(writes[0].newTask, true); assert.equal(writes[0].taskId, undefined);
});

test("成员能力展开状态在群进度更新时保留，归档群阻止继续发送", async () => {
  const state = detail(); const ui = setup(groupsSource, async (path) => Response.json(path === "/api/groups" ? { groups: [group()] } : state));
  await settle(); await ui.route({ page: "group", groupId: "one" }); await settle();
  ui.get("group-members").children[0].open = true;
  await ui.get("group-refresh").click(); await settle();
  assert.equal(ui.get("group-members").children[0].open, true);
  state.group.archived = true; await ui.get("group-refresh").click(); await settle();
  assert.equal(ui.get("group-send").disabled, true); assert.match(ui.text("group-compose-status"), /取消归档/);
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
  assert.match(ui.text("group-tasks"), /已完成 · 交付成果/); assert.match(ui.text("group-compose-status"), /新任务/);
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
    if (path.endsWith("/attachments")) return Response.json({ attachments: [{ id: "private-one", name: "私人材料.txt" }] });
    if (path.endsWith("/files")) return Response.json({ files: [{ path: "report.txt" }] });
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
  const row = ui.get("group-share-list").children.find((item) => item.className === "group-share-item");
  await row.children[1].click(); await settle();
  assert.deepEqual(requests.find((item) => item.path.endsWith("/share")).body.attachmentId, "private-one");
});

test("主助理历史自动恢复，创建页面和群页不会清除它，来源链接可安全打开", async () => {
  const conversation = { id: "main-one", title: "持续工作", messages: [{ id: "r", role: "assistant", content: "已查看 #group/one #agent/writer", status: "complete",
    actions: [{ type: "create_agent", href: "#create", label: "创建智能体" }, { href: "javascript:alert(1)", label: "不安全链接" }],
    sources: [{ href: "#chat", label: "返回主对话" }, { href: "https://example.com", label: "外部链接" }] }] };
  const ui = setup(mainSource, async (path) => Response.json(path === "/api/main/conversations" ? { conversations: [conversation] }
    : path === "/api/activity" ? { agents: [], groups: [], tasks: [] } : { conversation }));
  await ui.route({ page: "chat" }); await settle();
  assert.match(ui.text("main-messages"), /已查看/);
  const row = ui.get("main-messages").children[0];
  const links = row.children.find((item) => item.className === "collaboration-links");
  assert.deepEqual(links.children.map((item) => item.href), ["#group/one", "#agent/writer", "#create", "#chat"]);
  assert.equal(row.children.find((item) => item.className === "bubble").textContent, "已查看");
  ui.get("main-message").value = "未发送的主助理草稿";
  await ui.route({ page: "create" }); await ui.route({ page: "group", groupId: "one" }); await ui.route({ page: "chat" }); await settle();
  assert.equal(ui.get("main-message").value, "未发送的主助理草稿");
  assert.equal(ui.stored.get("neuma.main.active-conversation.v1"), "main-one");
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
    const row = rows[index], body = row.children.find((item) => item.className === "bubble");
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
  await ui.submit("main-chat-form"); await settle();
  let reply = ui.get("main-messages").children.find((item) => item.className === "message assistant");
  assert.equal(reply.children.find((item) => item.className === "bubble").textContent, "正在处理…");
  assert.equal(reply.children.some((item) => item.className === "collaboration-message-heading"), false);
  streamController.enqueue(new TextEncoder().encode([
    { type: "text-start" }, { type: "text-delta", delta: "已整理" }, { type: "text-delta", delta: "第一份材料" },
  ].map(JSON.stringify).join("\n") + "\n"));
  await settle(); reply = ui.get("main-messages").children.find((item) => item.className === "message assistant");
  const body = reply.children.find((item) => item.className === "bubble");
  assert.equal(body.textContent, "已整理第一份材料"); assert.equal(body.classes.has("streaming"), true);
  assert.equal(textOf(reply), "已整理第一份材料");
  streamController.enqueue(new TextEncoder().encode(JSON.stringify({ type: "done", result: { reply: "已整理第一份材料",
    conversation: { ...conversation, messages: [{ role: "user", content: "整理材料" },
      { role: "assistant", content: "已整理第一份材料", status: "complete" }] } } }) + "\n"));
  streamController.close(); await settle();
  const completed = ui.get("main-messages").children.find((item) => item.className === "message assistant");
  assert.equal(completed.children.find((item) => item.className === "bubble").classes.has("streaming"), false);
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
    assert.equal(row.children.find((item) => item.className === "bubble").textContent, `已保留的片段 ${status}`);
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
  assertDisclosure(ui.get("main-new-chat"), false);
  assert.equal(ui.document.activeElement, ui.get("main-history-toggle"));
  assert.equal(ui.get("main-history-toggle").title, "展开历史对话");
  assert.equal(ui.get("main-history-toggle").getAttribute("aria-expanded"), "false");
  assert.equal(ui.get("main-history-toggle").children[0], toggleIcon);
  assert.equal(ui.get("main-workspace").classes.has("history-collapsed"), true);
  assert.equal(ui.stored.get("neuma.main.history-collapsed.v1"), "true");
  assert.equal(ui.get("main-message").value, "保留的草稿");
  const restored = setup(mainSource, async () => Response.json({ conversations: [] }), [...ui.stored]);
  assertDisclosure(restored.get("main-history-body"), false);
  assertDisclosure(restored.get("main-new-chat"), false);
  await restored.get("main-history-toggle").click(); assertDisclosure(restored.get("main-history-body"), true);
  assertDisclosure(restored.get("main-new-chat"), true);
  assert.equal(restored.get("main-history-toggle").title, "收起历史对话");
});

test("历史连续收起展开即时转移焦点，最终状态和草稿保持一致", async () => {
  const ui = setup(mainSource, async () => Response.json({ conversations: [] }));
  await ui.route({ page: "chat" }); await settle();
  ui.get("main-message").value = "动画期间保留的草稿";
  const toggle = ui.get("main-history-toggle"); ui.get("main-new-chat").focus();
  const closing = toggle.click();
  assert.equal(ui.document.activeElement, toggle);
  assertDisclosure(ui.get("main-history-body"), false); assertDisclosure(ui.get("main-new-chat"), false);
  await closing;
  for (let index = 0; index < 5; index++) {
    await toggle.click();
    const visible = index % 2 === 0;
    assertDisclosure(ui.get("main-history-body"), visible); assertDisclosure(ui.get("main-new-chat"), visible);
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
  let items = ui.get("main-history-list").children;
  assert.equal(items[0].title, conversations[0].title); assert.equal(items[0].textContent, conversations[0].title);
  assert.equal(items[0].getAttribute("aria-current"), "true"); assert.equal(items[1].getAttribute("aria-current"), "false");
  assert.equal(items[1].title, "新对话"); assert.equal(items[1].textContent, "新对话");
  await items[1].click(); await settle(); items = ui.get("main-history-list").children;
  assert.equal(items[0].getAttribute("aria-current"), "false"); assert.equal(items[1].getAttribute("aria-current"), "true");
  ui.get("main-history-body").append(ui.get("main-history-list"));
  items[1].focus(); await ui.get("main-history-toggle").click();
  assert.equal(ui.document.activeElement, ui.get("main-history-toggle"));
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
  assert.equal(ui.get("sidebar-group-list").children[0].textContent, "新建研究组");
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
    await ui.get("main-refresh").click(); await settle(); assert.equal(notifications, expected);
  }
});

test("群变更触发的新列表优先于迟到的初始列表，主草稿保持不动", async () => {
  let release, reads = 0;
  const ui = setup(groupsSource, async () => { if (++reads === 1) return new Promise((resolve) => { release = () => resolve(Response.json({ groups: [] })); });
    return Response.json({ groups: [group("new-group", "新的研究组")] }); });
  await settle(); ui.get("main-message").value = "下一条未发送主草稿";
  await ui.document.dispatchEvent({ type: "neuma:groups-changed" }); await settle(); release(); await settle();
  assert.equal(ui.get("sidebar-group-list").children[0].textContent, "新的研究组"); assert.equal(ui.get("main-message").value, "下一条未发送主草稿");
});

test("主对话草稿按会话独立恢复，主动新对话空白而旧草稿保留", async () => {
  const conversations = [{ id: "main-a", title: "对话 A", messages: [] }, { id: "main-b", title: "对话 B", messages: [] }];
  const ui = setup(mainSource, async (path, options = {}) => {
    if (path === "/api/main/conversations" && options.method === "POST") {
      const conversation = { id: "main-new", title: "新对话", messages: [] }; conversations.push(conversation); return Response.json({ conversation });
    }
    return Response.json(path === "/api/main/conversations" ? { conversations } : { conversation: conversations.find((item) => path.endsWith(item.id)) });
  });
  const choose = async (title) => { await ui.get("main-history-list").children.find((item) => item.textContent === title).click(); await settle(); };
  await ui.route({ page: "chat" }); await settle(); ui.get("main-message").value = "草稿 A";
  await ui.get("main-new-chat").click(); await settle(); assert.equal(ui.get("main-message").value, "");
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
  await ui.get("main-history-list").children[1].click(); await settle(); assert.equal(ui.get("main-message").value, "仍属于 A 的草稿");
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
          { type: "text-start" }, { type: "text-delta", delta: "已输出的部分内容" },
          { type: "error", error: "服务端已结束本轮", diagnostic: { stage: "main", reason } },
        ].map(JSON.stringify).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } });
        return Response.json({ reply: "新的请求已完成", conversation: { ...conversation, messages: [{ role: "assistant", content: "新的请求已完成", status: "complete" }] } });
      }
      return Response.json(path === "/api/main/conversations" ? { conversations: [conversation] } : { conversation });
    });
    await ui.route({ page: "chat" }); await settle(); ui.get("main-message").value = "继续这个任务";
    await ui.submit("main-chat-form"); await settle();
    assert.equal(ui.get("main-message").value, "继续这个任务");
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
  assert.equal(events.filter((event) => event.build).length, 1); assert.deepEqual(events.find((event) => event.build).requirement, requirement);
  assert.match(ui.text("main-context-content"), /正在设计架构/);
  await ui.get("main-refresh").click(); await settle(); assert.equal(events.filter((event) => event.build).length, 1);
  assert.equal(requests.includes("/api/requirements/turn"), false);
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
  await ui.document.dispatchEvent({ type: "neuma:main-requirements", detail: { agentId: "existing-agent" } }); await settle();
  assert.deepEqual(writes[1], writes[0]); assert.equal(writes[0].agentId, "existing-agent"); assert.match(ui.text("main-context-content"), /既有助手/);
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
  await ui.get("main-history-list").children[1].click(); await settle(); release(); await settle();
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
  assert.match(html, /id="page-create"[^>]+hidden inert/); assert.match(html, /id="main-context-panel"[^>]+aria-hidden="true" inert/);
  assert.match(html, /class="main-context-slot"[^>]*>\s*<aside id="main-context-panel"/);
  assert.equal(html.includes('id="main-activity"'), false);
  assert.equal(html.includes("主持人"), false);
});
