import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import * as state from "../public/state.js";

const source = (await Promise.all(["chat-ui.js", "agent-runtime.js", "agents.js"].map((file) =>
  readFile(new URL(`../public/${file}`, import.meta.url), "utf8")))).map((text) =>
  text.replace(/^import .*;\n/gm, "").replace(/^export /gm, "")).join("\n");
const settle = () => new Promise(setImmediate);
const requirements = ["one", "two"].map((id, index) => ({ id, name: index ? "日报助手" : "会议助手", persisted: true,
  draft: { goal: { value: index ? "生成日报" : "整理会议", source: "user" } } }));
const definition = (id = "one", revision = 1) => ({ ...requirements.find((item) => item.id === id), status: "ready", revision });
const completed = (body, reply = "任务已完成") => ({ ...body, reply, status: "complete" });

function stream() {
  let controller;
  return {
    response: new Response(new ReadableStream({ start(value) { controller = value; } }),
      { headers: { "content-type": "application/x-ndjson" } }),
    send(event) { controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`)); },
    close() { controller.close(); },
    fail(error) { controller.error(error); },
  };
}

async function setup({ turn, build, inspect, profiles, stored = new Map() } = {}) {
  class Events {
    listeners = new Map();
    addEventListener(type, callback) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]); }
    dispatchEvent(event) { return Promise.all((this.listeners.get(event.type) ?? []).map((callback) => callback(event))); }
  }
  const document = new Events();
  class Element extends Events {
    value = ""; textContent = ""; children = []; hidden = false; disabled = false; classes = new Set(); attributes = new Map();
    scrollTop = 0; scrollHeight = 200; clientHeight = 200; versions = 0;
    classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    replaceChildren() { this.children = []; this.versions++; }
    replaceWith(next) { this.parent.children[this.parent.children.indexOf(this)] = next; next.parent = this.parent; }
    setAttribute(key, value) { this.attributes.set(key, value); }
    removeAttribute(key) { this.attributes.delete(key); }
    focus() { document.activeElement = this; }
    click() { return this.dispatchEvent({ type: "click" }); }
  }
  const nodes = new Map(), requests = [], runtimeEvents = [], profileEvents = [];
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  document.getElementById = get;
  document.createElement = () => new Element();
  class Event { constructor(type, fields = {}) { this.type = type; Object.assign(this, fields); } }
  document.addEventListener("neuma:agent-runtime-change", (event) => runtimeEvents.push(event.detail));
  document.addEventListener("neuma:agent-profile-changed", (event) => profileEvents.push(event.detail));
  document.addEventListener("neuma:agent-profiles-loaded", (event) => profileEvents.push(event.detail));
  let ids = 0;
  const context = vm.createContext({ ...state, document, AbortController, TextDecoder, TextEncoder, structuredClone, Event, CustomEvent: Event,
    window: { confirm: () => true, localStorage: {
      getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key),
    } },
    crypto: { randomUUID: () => `session-${++ids}` },
    node: (_tag, className = "", textContent = "") => Object.assign(new Element(), { className, textContent }),
    fetch: async (path, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ path, body, signal: options.signal, headers: options.headers });
      if (path === "/api/agent-profiles") return profiles?.() ?? Response.json({ profiles: [] });
      if (path === "/api/agents/turn") return turn?.(body, options) ?? Response.json(completed(body));
      if (path === "/api/agents/build") return build?.(body, options) ?? Response.json({ agent: { ...body, status: "ready", revision: 2 } });
      if (path === "/api/agents/cancel") return Response.json({ cancelled: true });
      return inspect?.(path) ?? Response.json({ agent: definition(path.split("/").at(-1)) });
    },
  });
  vm.runInContext(source, context);
  const emit = (type, detail) => document.dispatchEvent(new Event(type, { detail }));
  await emit("neuma:agents-changed", { items: requirements, busy: false });
  const route = (id) => emit("neuma:route", id ? { page: "agent", agentId: id } : { page: "chat", agentId: null });
  await route("one");
  return { get, requests, stored, emit, route, document, runtimeEvents, profileEvents,
    item: (id = "one") => vm.runInContext(`conversations.get(${JSON.stringify(id)})`, context),
    runtime: (id = "one") => vm.runInContext(`runtimes.get(${JSON.stringify(id)})`, context),
    submit: (text) => { get("agent-message").value = text; return get("agent-chat-form").dispatchEvent({ type: "submit", preventDefault() {} }); },
  };
}

test("旧需求先生成后运行，确认事件可以自动生成，并防止重复构建", async () => {
  let release;
  const ui = await setup({ inspect: () => Response.json({ agent: null }), build: () => new Promise((done) => { release = done; }) });
  assert.equal(ui.get("agent-send").disabled, true);
  await ui.submit("任务草稿");
  assert.equal(ui.get("agent-message").value, "任务草稿");
  assert.equal(ui.requests.some((request) => request.path.endsWith("/turn")), false);
  const pending = ui.emit("neuma:agent-build", { id: "one" });
  assert.equal(ui.get("agent-build").disabled, true);
  await ui.get("agent-build").click();
  assert.equal(ui.requests.filter((request) => request.path.endsWith("/build")).length, 1);
  release(Response.json({ agent: definition() })); await pending;
  assert.equal(ui.get("agent-send").disabled, false);
  await ui.submit("整理会议");
  assert.equal(ui.item().messages.at(-1).content, "任务已完成");
  assert.equal(ui.item().messages[0].delivery, "sent");
  assert.match(ui.get("agent-runtime-status").textContent, /可以开始任务/);
});

test("逐段显示回复且复用气泡，完成前阻止重复任务并保留下一条输入和阅读位置", async () => {
  const partial = stream(), ui = await setup({ turn: () => partial.response });
  const pending = ui.submit("当前任务"); await settle();
  const row = ui.get("agent-messages").children.at(-1), versions = ui.get("agent-messages").versions;
  assert.equal(ui.get("agent-message").value, "");
  assert.equal(ui.get("agent-cancel-reply").hidden, false);
  assert.equal(ui.get("agent-save-chat").disabled, true);
  ui.get("agent-message").value = "下一条草稿";
  await ui.get("agent-chat-form").dispatchEvent({ type: "submit", preventDefault() {} });
  assert.equal(ui.requests.filter((request) => request.path.endsWith("/turn")).length, 1);
  partial.send({ type: "text-start" }); partial.send({ type: "text-delta", delta: "会议" }); await settle();
  assert.equal(row.children[0].textContent, "会议");
  ui.get("agent-messages").scrollHeight = 1000; ui.get("agent-messages").scrollTop = 20;
  partial.send({ type: "text-delta", delta: "已整理" });
  partial.send({ type: "done", result: completed(ui.requests.find((request) => request.path.endsWith("/turn")).body, "会议已整理") });
  partial.close(); await pending;
  assert.equal(row.children[0].textContent, "会议已整理");
  assert.equal(ui.get("agent-messages").versions, versions);
  assert.equal(ui.get("agent-messages").scrollTop, 20);
  assert.equal(ui.get("agent-message").value, "下一条草稿");
  assert.equal(ui.item().messages.at(-1).status, "complete");
  assert.equal(ui.get("agent-cancel-reply").hidden, true);
});

test("停止发送取消请求并保留部分回复，迟到完成不会把任务标为成功", async () => {
  const partial = stream(), ui = await setup({ turn: () => partial.response });
  const pending = ui.submit("当前任务"); await settle();
  partial.send({ type: "text-delta", delta: "部分结果" }); await settle();
  const request = ui.requests.find((item) => item.path.endsWith("/turn"));
  await ui.get("agent-cancel-reply").click();
  assert.equal(request.signal.aborted, true);
  assert.equal(ui.requests.find((item) => item.path.endsWith("/cancel")).body.sessionId, request.body.sessionId);
  partial.send({ type: "text-delta", delta: "迟到内容" });
  partial.send({ type: "done", result: completed(request.body) }); partial.close(); await pending;
  assert.equal(ui.item().messages[0].delivery, "stopped");
  assert.equal(ui.item().messages[1].status, "stopped");
  assert.equal(ui.item().messages[1].content, "部分结果");
  const recovery = ui.get("agent-messages").children[0].children.at(-1).children[1];
  ui.get("agent-message").value = "下一条草稿"; await recovery.click();
  assert.equal(ui.get("agent-message").value, "下一条草稿\n\n当前任务");
});

test("任务结束保留产物栏的操作焦点，发送按钮上的焦点才恢复到输入框", async () => {
  for (const focusedId of ["agent-artifacts-toggle", "agent-send"]) {
    const partial = stream(), ui = await setup({ turn: () => partial.response });
    const pending = ui.submit("当前任务"); await settle();
    ui.get(focusedId).focus();
    partial.send({ type: "done", result: completed(ui.requests.find((request) => request.path.endsWith("/turn")).body) });
    partial.close(); await pending;
    assert.equal(ui.document.activeElement, ui.get(focusedId === "agent-send" ? "agent-message" : focusedId));
  }
});

test("断流保留部分内容与失败标记，恢复输入后重试不复制失败消息和上下文", async () => {
  let calls = 0;
  const partial = stream(), ui = await setup({ turn: (body) => ++calls === 1 ? partial.response : Response.json(completed(body)) });
  const pending = ui.submit("当前任务"); await settle();
  partial.send({ type: "text-delta", delta: "部分结果" }); partial.close(); await pending;
  assert.equal(ui.item().messages.at(-1).content, "部分结果");
  assert.equal(ui.item().messages.at(-1).status, "error");
  assert.equal(ui.get("agent-message").value, "当前任务");
  assert.match(ui.get("agent-error").textContent, /回复尚未完成/);
  await ui.submit("当前任务");
  assert.equal(ui.item().messages.length, 2);
  assert.deepEqual(ui.requests.filter((item) => item.path.endsWith("/turn"))[1].body.history, []);
  assert.equal(ui.item().messages[0].delivery, "sent");
});

test("切换智能体保留各自输入，运行和回复不串到其他智能体", async () => {
  const partial = stream(), ui = await setup({ turn: (body) => body.agentId === "one" ? partial.response : Response.json(completed(body, "日报已完成")) });
  const pending = ui.submit("整理会议"); await settle();
  ui.get("agent-message").value = "会议下一条"; await ui.route("two");
  await ui.submit("生成日报");
  const row = ui.get("agent-messages").children.at(-1);
  partial.send({ type: "text-delta", delta: "会议部分" }); await settle();
  assert.equal(row.children[0].textContent, "日报已完成");
  const turns = ui.requests.filter((item) => item.path.endsWith("/turn"));
  assert.notEqual(turns[0].body.sessionId, turns[1].body.sessionId);
  assert.equal(turns[1].body.history.length, 0);
  partial.send({ type: "done", result: completed(turns[0].body, "会议已完成") }); partial.close(); await pending;
  await ui.route("one");
  assert.equal(ui.get("agent-message").value, "会议下一条");
  assert.equal(ui.get("agent-messages").children.at(-1).children[0].textContent, "会议已完成");
});

test("新对话生成独立会话并停止旧任务，旧任务迟到的失败不能恢复到新对话", async () => {
  const partial = stream(), ui = await setup({ turn: () => partial.response });
  const pending = ui.submit("旧任务"); await settle();
  const oldSession = ui.item().sessionId;
  await ui.get("agent-new-chat").click();
  assert.notEqual(ui.item().sessionId, oldSession);
  assert.equal(ui.item().messages.length, 0);
  assert.equal(ui.get("agent-messages").children[0].className, "welcome");
  partial.close(); await pending;
  assert.equal(ui.get("agent-message").value, "");
  assert.equal(ui.item().messages.length, 0);
});

test("需求修改使产物过期待重新生成，保留可见消息且新版本不恢复旧上下文", async () => {
  const ui = await setup();
  await ui.submit("旧版本任务");
  const original = ui.item().sessionId;
  const updated = requirements.map((item) => item.id === "one" ? { ...item, draft: { goal: { value: "新的会议任务", source: "user" } } } : item);
  await ui.emit("neuma:agents-changed", { items: updated, busy: false });
  assert.equal(ui.get("agent-send").disabled, true);
  assert.match(ui.get("agent-runtime-status").textContent, /需求已更新/);
  await ui.get("agent-build").click();
  assert.notEqual(ui.item().sessionId, original);
  assert.equal(ui.item().messages.length, 2);
  await ui.submit("新版本任务");
  assert.equal(ui.item().messages.at(-1).revision, "2");
  assert.deepEqual(ui.requests.filter((item) => item.path.endsWith("/turn"))[1].body.history, []);
});

test("手动保存真实问答，刷新恢复时仅把同版本成功对话带回后端", async () => {
  const ui = await setup();
  await ui.submit("已保存任务"); await ui.get("agent-save-chat").click();
  const restored = await setup({ stored: ui.stored });
  assert.equal(restored.item().messages.length, 2);
  assert.equal(restored.item().messages[1].status, "complete");
  await restored.submit("追问");
  const history = restored.requests.find((item) => item.path.endsWith("/turn")).body.history;
  assert.deepEqual(history, [
    { role: "user", content: "已保存任务", revision: "1" },
    { role: "assistant", content: "任务已完成", revision: "1" },
  ]);
});

test("重新生成取消后不把迟到结果设为可运行，旧定义仍可见且可重试", async () => {
  const partial = stream(), ui = await setup({ build: () => partial.response });
  const pending = ui.get("agent-build").click(); await settle();
  await ui.get("agent-cancel-reply").click();
  partial.send({ type: "done", result: { agent: definition("one", 2) } }); partial.close(); await pending;
  assert.equal(ui.runtime().definition.revision, 1);
  assert.equal(ui.get("agent-send").disabled, true);
  assert.equal(ui.get("agent-build").disabled, false);
  assert.match(ui.get("agent-error").textContent, /生成已停止/);
});

test("任务期间确认更新先排队，旧任务完成后仅生成一次最新需求", async () => {
  const partial = stream(), ui = await setup({ turn: () => partial.response });
  const pending = ui.submit("旧需求任务"); await settle();
  const updated = requirements.map((item) => item.id === "one" ? { ...item, draft: { goal: { value: "最新需求", source: "user" } } } : item);
  await ui.emit("neuma:agents-changed", { items: updated, busy: false });
  await ui.emit("neuma:agent-build", { id: "one" });
  await ui.emit("neuma:agent-build", { id: "one" });
  assert.equal(ui.requests.some((request) => request.path.endsWith("/build")), false);
  assert.equal(ui.runtime().rebuildRequested, true);
  const request = ui.requests.find((item) => item.path.endsWith("/turn"));
  partial.send({ type: "done", result: completed(request.body, "旧任务结果") }); partial.close(); await pending;
  const builds = ui.requests.filter((item) => item.path.endsWith("/build"));
  assert.equal(builds.length, 1);
  assert.equal(builds[0].body.draft.goal.value, "最新需求");
  assert.equal(ui.item().messages[1].content, "旧任务结果");
  assert.equal(ui.runtime().status, "ready");
  assert.equal(ui.runtime().rebuildRequested, false);
});

test("被新需求中断的构建先收尾再生成最新版本，迟到旧产物不会替换新版本", async () => {
  const partial = stream(); let calls = 0;
  const ui = await setup({ build: (body) => ++calls === 1 ? partial.response : Response.json({ agent: { ...body, status: "ready", revision: 3 } }) });
  const pending = ui.get("agent-build").click(); await settle();
  const updated = requirements.map((item) => item.id === "one" ? { ...item, draft: { goal: { value: "构建中的新需求", source: "user" } } } : item);
  await ui.emit("neuma:agents-changed", { items: updated, busy: false });
  await ui.emit("neuma:agent-build", { id: "one" });
  assert.equal(ui.requests.find((item) => item.path.endsWith("/build")).signal.aborted, true);
  assert.equal(calls, 1);
  partial.send({ type: "done", result: { agent: definition("one", 2) } }); partial.close(); await pending;
  assert.equal(calls, 2);
  assert.equal(ui.runtime().definition.revision, 3);
  assert.equal(ui.runtime().definition.draft.goal.value, "构建中的新需求");
  assert.equal(ui.runtime().status, "ready");
  assert.equal(ui.runtime().rebuildRequested, false);
});

test("展示 overlay 同步标题、简介、emoji和消息标签，不改变构建来源或运行版本", async () => {
  const ui = await setup();
  const profile = { name: "我的会议伙伴", description: "", icon: "📝" };
  await ui.emit("neuma:agents-changed", { items: requirements.map((item) => item.id === "one" ? { ...item, profile } : item), busy: false });
  assert.equal(ui.get("agent-title").textContent, "我的会议伙伴");
  assert.equal(ui.get("agent-subtitle").textContent, "");
  assert.equal(ui.get("agent-icon").textContent, "📝");
  assert.equal(ui.get("sidebar-agent-list").children[0].children[0].textContent, "📝");
  assert.equal(ui.get("sidebar-agent-list").children[0].children[1].children[0].textContent, "我的会议伙伴");
  assert.equal(ui.get("agent-messages").children[0].children[1].textContent, "这里是「我的会议伙伴」的对话");
  assert.equal(ui.runtime().status, "ready");
  assert.equal(ui.runtime().definition.revision, 1);
  assert.equal(ui.requests.some((request) => request.path.endsWith("/build")), false);
  await ui.submit("整理会议");
  assert.equal(ui.get("agent-messages").children.at(-1).attributes.get("aria-label"), "我的会议伙伴的回复");
  assert.equal(ui.requests.find((request) => request.path.endsWith("/turn")).body.agentId, "one");
});

test("面板可以主动请求简洁状态快照，快照独立且递归请求不会重复广播", async () => {
  const ui = await setup();
  await ui.emit("neuma:agent-runtime-request", {});
  const snapshot = ui.runtimeEvents.at(-1);
  assert.equal(snapshot.agentId, "one");
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.busy, false);
  assert.equal(snapshot.messages, undefined);
  snapshot.agent.draft.goal.value = "外部修改";
  snapshot.definition.revision = 99;
  assert.equal(ui.runtime().definition.revision, 1);
  let calls = 0;
  ui.document.addEventListener("neuma:agent-runtime-change", () => {
    calls++;
    ui.emit("neuma:agent-runtime-request", { agentId: "one" });
  });
  await ui.emit("neuma:agent-runtime-request", {});
  assert.equal(calls, 1);
});

test("查询与重新生成返回展示信息时向管理模块同步，迟到列表不覆盖已修改资料", async () => {
  let release;
  const list = new Promise((done) => { release = done; });
  const ui = await setup({ profiles: () => list,
    inspect: () => Response.json({ agent: definition(), profile: { name: "服务端名字", description: "服务端简介", icon: "📚" } }),
    build: (body) => Response.json({ agent: { ...body, status: "ready", revision: 2, profile: { name: "生成后的名字", description: "", icon: "🧠" } } }),
  });
  assert.equal(ui.profileEvents.find((detail) => detail.id === "one").profile.name, "服务端名字");
  await ui.emit("neuma:agent-profile-changed", { id: "one", profile: { name: "刚编辑的名字", description: "", icon: "新" } });
  release(Response.json({ profiles: [{ id: "one", name: "迟到旧名字", description: "旧", icon: "旧" }] })); await settle();
  assert.equal(ui.profileEvents.find((detail) => Array.isArray(detail.profiles)).profiles.length, 0);
  await ui.get("agent-build").click();
  assert.equal(ui.profileEvents.filter((detail) => detail.id === "one").at(-1).profile.name, "生成后的名字");
});

test("展示列表读取失败只显示轻提示，不阻止对话或移除已有资料", async () => {
  const ui = await setup({ profiles: () => Response.json({ error: "列表暂时无法读取" }, { status: 503 }) });
  await settle();
  await ui.emit("neuma:agents-changed", { items: requirements.map((item) => item.id === "one"
    ? { ...item, profile: { name: "已有名字", description: "已有简介", icon: "📝" } } : item), busy: false });
  assert.equal(ui.get("agent-title").textContent, "已有名字");
  assert.equal(ui.get("agent-icon").textContent, "📝");
  assert.equal(ui.get("agent-send").disabled, false);
  assert.equal(ui.get("agent-error").hidden, true);
  assert.match(ui.get("agent-runtime-status").textContent, /名称与图标暂时未加载/);
  assert.equal(ui.profileEvents.filter((detail) => Array.isArray(detail.profiles)).length, 0);
});

test("资料保存后才返回的旧查询不会发送覆盖事件", async () => {
  let release;
  const ui = await setup({ inspect: (path) => path.endsWith("/two")
    ? new Promise((done) => { release = done; }) : Response.json({ agent: definition() }) });
  const pending = ui.route("two"); await settle();
  await ui.emit("neuma:agent-profile-changed", { id: "two", profile: { name: "新的日报名字", description: "", icon: "新" } });
  release(Response.json({ agent: definition("two"), profile: { name: "旧日报名字", description: "旧", icon: "旧" } })); await pending;
  assert.equal(ui.profileEvents.filter((detail) => detail.id === "two").length, 1);
  assert.equal(ui.profileEvents.filter((detail) => detail.id === "two")[0].profile.name, "新的日报名字");
});
