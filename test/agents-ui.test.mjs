import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import * as state from "../public/state.js";

const source = (await Promise.all(["chat-ui.js", "agent-runtime.js", "agent-details-view.js", "agents.js"].map((file) =>
  readFile(new URL(`../public/${file}`, import.meta.url), "utf8")))).map((text) =>
  text.replace(/^import .*;\n/gm, "").replace(/^export /gm, "")).join("\n");
const settle = () => new Promise(setImmediate);
const requirements = ["one", "two"].map((id, index) => ({ id, name: index ? "日报助手" : "会议助手", persisted: true,
  draft: { goal: { value: index ? "生成日报" : "整理会议", source: "user" } } }));
const definition = (id = "one", revision = 1) => ({ ...requirements.find((item) => item.id === id), status: "ready", revision,
  mode: "designed", architectureRef: { version: revision, candidateHash: `candidate-${revision}` } });
const architecture = (overrides = {}) => ({ agentId: "one", name: requirements[0].name, draft: requirements[0].draft,
  version: 2, candidateHash: "candidate-2", status: "passed", delivery: "ready", summary: "复用现有能力。", issues: [], ...overrides });
const designedDefinition = () => ({ ...definition("one", 2), mode: "designed", architectureRef: { version: 2, candidateHash: "candidate-2" } });
const readyResult = (agent = definition()) => ({ agent, architecture: architecture({ agentId: agent.id,
  name: agent.name, draft: agent.draft, version: agent.architectureRef.version, candidateHash: agent.architectureRef.candidateHash }) });
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

async function setup({ turn, build, develop, cancelDevelopment, inspect, profiles, conversationRequest, savedConversations = new Map(), stored = new Map() } = {}) {
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
    replaceChildren(...children) { this.children = []; this.append(...children); this.versions++; }
    replaceWith(next) { this.parent.children[this.parent.children.indexOf(this)] = next; next.parent = this.parent; }
    setAttribute(key, value) { this.attributes.set(key, value); }
    removeAttribute(key) { this.attributes.delete(key); }
    focus() { document.activeElement = this; }
    click() { return this.dispatchEvent({ type: "click" }); }
  }
  const nodes = new Map(), requests = [], runtimeEvents = [], profileEvents = [], timers = new Map();
  let timerId = 0;
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  document.getElementById = get;
  document.createElement = () => new Element();
  class Event { constructor(type, fields = {}) { this.type = type; Object.assign(this, fields); } }
  document.addEventListener("neuma:agent-runtime-change", (event) => runtimeEvents.push(event.detail));
  document.addEventListener("neuma:agent-profile-changed", (event) => profileEvents.push(event.detail));
  document.addEventListener("neuma:agent-profiles-loaded", (event) => profileEvents.push(event.detail));
  let ids = 0;
  const context = vm.createContext({ ...state, document, AbortController, TextDecoder, TextEncoder, structuredClone, Event, CustomEvent: Event,
    setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id) => timers.delete(id),
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
      if (path === "/api/agents/build") return build?.(body, options) ?? Response.json(readyResult({ ...definition(body.id, 2), ...body }));
      if (path === "/api/agents/cancel") return Response.json({ cancelled: true });
      if (path.endsWith("/conversation")) {
        if (conversationRequest) return conversationRequest(path, body, options);
        const id = decodeURIComponent(path.split("/")[3]);
        if (body && (!body.importOnly || !savedConversations.has(id))) savedConversations.set(id, { schemaVersion: 2, messages: body.messages });
        return Response.json({ conversation: savedConversations.get(id) ?? null });
      }
      if (path.endsWith("/development/stream")) return develop?.(body, options, path) ?? Response.json({ error: "未配置研发响应" }, { status: 503 });
      if (path.endsWith("/development/cancel")) return cancelDevelopment?.(path) ?? Response.json({ cancelled: true });
      return inspect?.(path) ?? Response.json(readyResult(definition(path.split("/").at(-1))));
    },
  });
  vm.runInContext(source, context);
  const emit = (type, detail) => document.dispatchEvent(new Event(type, { detail }));
  await emit("neuma:agents-changed", { items: requirements, busy: false });
  const route = (id) => emit("neuma:route", id ? { page: "agent", agentId: id } : { page: "chat", agentId: null });
  await route("one");
  return { get, requests, savedConversations, stored, emit, route, document, runtimeEvents, profileEvents,
    timers, poll: async () => { const pending = [...timers.values()]; timers.clear(); await Promise.all(pending.map((callback) => callback())); await settle(); },
    item: (id = "one") => vm.runInContext(`conversations.get(${JSON.stringify(id)})`, context),
    runtime: (id = "one") => vm.runInContext(`runtimes.get(${JSON.stringify(id)})`, context),
    submit: (text) => { get("agent-message").value = text; return get("agent-chat-form").dispatchEvent({ type: "submit", preventDefault() {} }); },
  };
}

const developmentRecord = (overrides = {}) => ({ id: "dev-one", agentId: "one", status: "running", phase: "implementing",
  architectureRef: { version: 2, candidateHash: "candidate-2" }, codeHash: "code-2", planHash: "plan-2",
  delivery: "needs_development", summary: "正在实现任务。", tasks: [{ id: "task-1", title: "整理资料", status: "active" }],
  currentTaskId: "task-1", ...overrides });
const developmentResult = (record, overrides = {}) => ({ agent: null, architecture: architecture({ delivery: "needs_development" }),
  development: record, ...overrides });
const treeText = (node) => [node.textContent, ...node.children.map(treeText)].join(" ");
const developmentButton = (ui) => ui.get("agent-development").children[0].children.at(-1).children[0];

test("另一个页面的后台研发完成后自动核对，离开页面停轮询并在返回时重新检查", async () => {
  let saved = developmentResult(developmentRecord());
  const ui = await setup({ inspect: (path) => Response.json(path.endsWith("/one") ? saved : readyResult(definition("two"))) });
  assert.equal(ui.runtime().status, "developing");
  assert.equal(ui.timers.size, 1);
  await ui.route("two");
  assert.equal(ui.timers.size, 0);
  saved = developmentResult(developmentRecord({ status: "cancelled" }));
  await ui.route("one");
  assert.equal(ui.runtime().development.status, "cancelled");
  assert.equal(developmentButton(ui).textContent, "继续研发");

  saved = developmentResult(developmentRecord());
  const second = await setup({ inspect: () => Response.json(saved) });
  assert.equal(second.timers.size, 1);
  saved = developmentResult(developmentRecord({ status: "completed", delivery: "ready" }),
    { agent: { ...designedDefinition(), developmentRef: { id: "dev-one", codeHash: "code-2", planHash: "plan-2" } }, architecture: architecture() });
  await second.poll();
  assert.equal(second.runtime().status, "ready");
  assert.equal(second.get("agent-send").disabled, false);
  assert.equal(second.get("agent-build").disabled, false);
  assert.equal(second.timers.size, 0);
  assert.equal(second.requests.some((request) => request.path.endsWith("/development/stream")), false);
});

test("后台架构轮询不能覆盖本地构建或更新后的需求，也不把迟到响应画到别的智能体", async () => {
  for (const change of ["build", "source", "route", "remove"]) {
    let release, reads = 0;
    const building = stream();
    const ui = await setup({ inspect: (path) => path.endsWith("/two") ? Response.json(readyResult(definition("two")))
      : ++reads === 1 ? Response.json({ agent: null, architecture: architecture({ status: "designing", delivery: "blocked" }) })
        : new Promise((done) => { release = done; }), build: () => building.response });
    const polling = ui.poll(); await settle();
    assert.equal(typeof release, "function");
    let pending;
    if (change === "build") pending = ui.get("agent-build").click();
    else if (change === "source") await ui.emit("neuma:agents-changed", { items: requirements.map((agent) => agent.id === "one"
      ? { ...agent, draft: { goal: { value: "新的需求" } } } : agent), busy: false });
    else if (change === "route") await ui.route("two");
    else {
      await ui.emit("neuma:agent-removed", { id: "one" });
      await ui.emit("neuma:agents-changed", { items: requirements.filter((agent) => agent.id !== "one"), busy: false });
    }
    release(Response.json(readyResult(designedDefinition()))); await polling;
    if (change === "build") {
      assert.equal(ui.runtime().status, "building");
      assert.equal(ui.runtime().definition, null);
      assert.equal(ui.timers.size, 0);
      building.send({ type: "done", result: readyResult(designedDefinition()) }); building.close(); await pending;
    } else if (change === "source") {
      assert.equal(ui.runtime().status, "stale");
      assert.equal(ui.runtime().definition, null);
      assert.equal(ui.timers.size, 0);
    } else if (change === "route") {
      assert.equal(ui.get("agent-title").textContent, requirements[1].name);
      assert.equal(ui.runtime("two").status, "ready");
      assert.equal(ui.timers.size, 0);
    } else {
      assert.equal(ui.runtime(), undefined);
      assert.equal(ui.get("agent-missing").hidden, false);
      assert.equal(ui.timers.size, 0);
    }
  }
});

test("后台状态轮询保留聊天气泡和用户阅读位置，完成后停止定时读取", async () => {
  let saved = developmentResult(developmentRecord());
  const ui = await setup({ inspect: () => Response.json(saved) });
  ui.item().messages.push({ role: "user", content: "上次任务", delivery: "sent" },
    { role: "assistant", content: "保留阅读中的结果", status: "complete" });
  await ui.emit("neuma:agents-changed", { items: requirements, busy: false });
  const container = ui.get("agent-messages"), rows = container.children;
  container.scrollHeight = 1000; container.clientHeight = 200; container.scrollTop = 17;
  saved = developmentResult(developmentRecord({ status: "completed", delivery: "ready" }),
    { agent: { ...designedDefinition(), developmentRef: { id: "dev-one", codeHash: "code-2", planHash: "plan-2" } }, architecture: architecture() });
  await ui.poll();
  assert.equal(container.children, rows);
  assert.equal(container.scrollTop, 17);
  assert.equal(ui.get("agent-send").disabled, false);
  assert.equal(ui.timers.size, 0);
});

test("停止后台研发后，之前发出的迟到轮询不能恢复运行中状态", async () => {
  let saved = developmentResult(developmentRecord()), release, reads = 0;
  const ui = await setup({ inspect: () => ++reads === 2 ? new Promise((done) => { release = done; }) : Response.json(saved),
    cancelDevelopment: () => {
      saved = developmentResult(developmentRecord({ status: "cancelled" }));
      return Response.json({ cancelled: true, development: saved.development });
    } });
  const polling = ui.poll(); await settle();
  await developmentButton(ui).click();
  assert.equal(ui.runtime().development.status, "cancelled");
  release(Response.json(developmentResult(developmentRecord()))); await polling;
  assert.equal(ui.runtime().development.status, "cancelled");
  assert.equal(ui.timers.size, 0);
  assert.equal(developmentButton(ui).textContent, "继续研发");
});

test("生成智能体自动贯穿研发五阶段，停止后续接且旧研发结果不能覆盖新需求", async () => {
  const building = stream(), resumed = stream(); let saved = null;
  const ui = await setup({
    inspect: () => Response.json(saved ? developmentResult(saved) : { agent: null, architecture: null, development: null }),
    build: () => building.response, develop: () => resumed.response,
    cancelDevelopment: () => {
      saved = developmentRecord({ status: "cancelled", summary: "已保存当前任务，可以继续研发。" });
      return Response.json({ cancelled: true, development: saved });
    },
  });
  const pending = ui.emit("neuma:agent-build", { id: "one" }); await settle();
  building.send({ type: "status", phase: "planning", label: "架构已通过，正在拆分研发任务。",
    architecture: architecture({ delivery: "needs_development" }), development: developmentRecord({ phase: "planning" }) });
  await settle();
  assert.equal(ui.get("agent-development").hidden, false);
  assert.match(treeText(ui.get("agent-development")), /接收设计.*拆分任务.*开发任务.*检查验收.*整理交付/s);
  assert.equal(developmentButton(ui).textContent, "停止研发");
  assert.equal(ui.get("agent-build").disabled, true);
  assert.equal(ui.get("agent-send").disabled, true);
  assert.equal(ui.requests.filter((request) => request.path === "/api/agents/build").length, 1);
  assert.equal(ui.requests.some((request) => request.path.endsWith("/development/stream")), false);
  building.send({ type: "status", phase: "verifying", label: "正在检查自动研发的任务", development: developmentRecord({ phase: "verifying" }) });
  await settle();
  assert.equal(ui.get("agent-development").children[0].children[1].children[3].attributes.get("aria-current"), "step");
  await developmentButton(ui).click();
  assert.equal(ui.requests.find((request) => request.path === "/api/agents/build").signal.aborted, true);
  building.send({ type: "done", result: developmentResult(developmentRecord({ status: "completed", delivery: "ready" }),
    { agent: designedDefinition(), architecture: architecture() }) }); building.close(); await pending;
  assert.equal(ui.runtime().development.status, "cancelled");
  assert.equal(ui.get("agent-send").disabled, true);
  assert.equal(developmentButton(ui).textContent, "继续研发");
  const continuing = developmentButton(ui).click(); await settle();
  assert.equal(ui.requests.find((request) => request.path.endsWith("/development/stream")).body.resume, true);
  await ui.emit("neuma:agents-changed", { items: requirements.map((agent) => agent.id === "one"
    ? { ...agent, draft: { goal: { value: "新需求不接受旧研发结果" } } } : agent), busy: false });
  resumed.send({ type: "status", phase: "packaging", label: "迟到的旧研发进度", development: developmentRecord() });
  resumed.send({ type: "done", result: developmentResult(developmentRecord({ status: "completed", delivery: "ready" }),
    { agent: designedDefinition(), architecture: architecture() }) }); resumed.close(); await continuing;
  assert.equal(ui.runtime().status, "stale");
  assert.equal(ui.runtime().definition, null);
  assert.equal(ui.get("agent-development").hidden, true);
  assert.equal(ui.get("agent-send").disabled, true);
  assert.doesNotMatch(ui.get("agent-runtime-status").textContent, /迟到/);
});

test("当前方案可以开始研发并显示五阶段与任务进度，完成但待连接仍禁止运行", async () => {
  const partial = stream(); let attempts = 0;
  const delivered = { ...designedDefinition(), developmentRef: { id: "dev-one", codeHash: "code-2", planHash: "plan-2" } };
  const ui = await setup({ inspect: () => Response.json(developmentResult(null)), develop: () => ++attempts === 1 ? partial.response
    : Response.json(developmentResult(developmentRecord({ status: "completed", phase: "packaging", delivery: "ready",
      package: { codeHash: "code-2", planHash: "plan-2" } }), { agent: delivered, architecture: architecture() })) });
  assert.equal(developmentButton(ui).textContent, "开始研发");
  const pending = developmentButton(ui).click(); await settle();
  assert.equal(ui.get("agent-build").disabled, true);
  await ui.emit("neuma:agent-develop", { id: "one" });
  assert.equal(ui.requests.filter((request) => request.path.endsWith("/development/stream")).length, 1);
  partial.send({ type: "status", phase: "verifying", label: "正在验收当前任务", development: developmentRecord({ phase: "verifying" }) });
  await settle();
  assert.match(treeText(ui.get("agent-development")), /接收设计.*拆分任务.*开发任务.*检查验收.*整理交付.*正在验收当前任务/s);
  assert.equal(developmentButton(ui).textContent, "停止研发");
  partial.send({ type: "done", result: developmentResult(developmentRecord({ status: "completed", phase: "packaging", delivery: "needs_connection" })) });
  partial.close(); await pending;
  assert.match(treeText(ui.get("agent-development")), /研发已完成.*待连接/);
  assert.equal(ui.get("agent-send").disabled, true);
  assert.equal(developmentButton(ui).textContent, "重新检查交付");
  assert.equal(ui.runtimeEvents.at(-1).development.status, "completed");
  await developmentButton(ui).click();
  assert.equal(ui.requests.filter((request) => request.path.endsWith("/development/stream")).at(-1).body.resume, true);
  assert.equal(ui.runtime().status, "ready");
  assert.equal(ui.get("agent-send").disabled, false);
  assert.equal(developmentButton(ui), undefined);
});

test("刷新恢复中断记录并明确继续，切换智能体后迟到研发进度不会进入另一会话", async () => {
  const partial = stream(), saved = developmentRecord({ status: "interrupted" });
  const ui = await setup({ inspect: (path) => Response.json(path.endsWith("/one") ? developmentResult(saved) : readyResult(definition("two"))),
    develop: () => partial.response });
  assert.match(treeText(ui.get("agent-development")), /研发已中断/);
  assert.equal(developmentButton(ui).textContent, "继续研发");
  const pending = developmentButton(ui).click(); await settle();
  assert.equal(ui.requests.find((request) => request.path.endsWith("/development/stream")).body.resume, true);
  await ui.route("two");
  partial.send({ type: "status", phase: "verifying", label: "一号正在验收", development: developmentRecord() }); await settle();
  assert.equal(ui.get("agent-development").hidden, true);
  assert.doesNotMatch(ui.get("agent-runtime-status").textContent, /一号/);
  partial.send({ type: "done", result: developmentResult(developmentRecord({ status: "blocked", summary: "缺少开发所需条件。" })) });
  partial.close(); await pending;
  assert.equal(ui.runtime("two").status, "ready");
  await ui.route("one");
  assert.match(treeText(ui.get("agent-development")), /研发受阻.*缺少开发所需条件/s);
  assert.equal(developmentButton(ui).textContent, "继续研发");
});

test("停止研发使用专属取消入口并忽略迟到完成，不重置任务进度", async () => {
  const partial = stream(); let saved = null;
  const ui = await setup({ inspect: () => Response.json(developmentResult(saved)), develop: () => partial.response,
    cancelDevelopment: () => {
      saved = developmentRecord({ status: "cancelled", summary: "已取消，任务进度保留。" });
      return Response.json({ cancelled: true, development: saved });
    } });
  const pending = developmentButton(ui).click(); await settle();
  partial.send({ type: "status", phase: "implementing", label: "正在开发", development: developmentRecord() }); await settle();
  await developmentButton(ui).click();
  assert.equal(ui.requests.find((request) => request.path.endsWith("/development/stream")).signal.aborted, true);
  const completed = developmentRecord({ status: "completed", delivery: "ready" });
  partial.send({ type: "done", result: developmentResult(completed, { agent: designedDefinition(), architecture: architecture() }) });
  partial.close(); await pending;
  assert.equal(ui.runtime().development.status, "cancelled");
  assert.equal(ui.runtime().development.tasks.length, 1);
  assert.equal(ui.get("agent-send").disabled, true);
  assert.equal(developmentButton(ui).textContent, "继续研发");
  assert.equal(ui.requests.filter((request) => request.path.endsWith("/development/cancel")).length, 1);
  assert.equal(ui.requests.some((request) => request.path === "/api/agents/cancel"), false);
});

test("研发流断开重新核对后端中断状态，新需求使旧研发响应失效", async () => {
  const partial = stream(); let saved = null;
  const ui = await setup({ inspect: () => Response.json(developmentResult(saved)), develop: () => partial.response });
  const pending = developmentButton(ui).click(); await settle();
  saved = developmentRecord({ status: "interrupted", summary: "连接中断，已有进度保留。" });
  partial.close(); await pending;
  assert.equal(ui.runtime().development.status, "interrupted");
  assert.match(treeText(ui.get("agent-development")), /研发已中断/);
  assert.equal(developmentButton(ui).textContent, "继续研发");
  const old = stream();
  const second = await setup({ inspect: () => Response.json(developmentResult(null)), develop: () => old.response });
  const delayed = developmentButton(second).click(); await settle();
  await second.emit("neuma:agents-changed", { items: requirements.map((item) => item.id === "one"
    ? { ...item, draft: { goal: { value: "更新后的需求" } } } : item), busy: false });
  old.send({ type: "done", result: developmentResult(developmentRecord({ status: "completed", delivery: "ready" }),
    { agent: designedDefinition(), architecture: architecture() }) }); old.close(); await delayed;
  assert.equal(second.runtime().status, "stale");
  assert.equal(second.get("agent-send").disabled, true);
  assert.equal(second.get("agent-development").hidden, true);
});

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
  release(Response.json(readyResult())); await pending;
  assert.equal(ui.get("agent-send").disabled, false);
  await ui.submit("整理会议");
  assert.equal(ui.item().messages.at(-1).content, "任务已完成");
  assert.equal(ui.item().messages[0].delivery, "sent");
  assert.match(ui.get("agent-runtime-status").textContent, /可以开始任务/);
});

test("构建返回待补充或需要研发时保留旧定义、展示原因并阻止运行，刷新不能绕过", async () => {
  for (const [status, delivery, expected, label] of [
    ["needs_evidence", "blocked", "needs_evidence", /待补充依据/],
    ["needs_changes", "blocked", "needs_changes", /架构需要调整/],
    ["passed", "needs_connection", "needs_connection", /仍需连接/],
    ["passed", "needs_development", "needs_development", /仍需研发/],
  ]) {
    const result = { agent: definition(), architecture: architecture({ status, delivery,
      summary: "尚不能处理完整任务。", issues: [{ id: "missing", blocking: true, description: "缺少资料来源依据。", remedy: "请补充来源。" }] }) };
    const ui = await setup({ build: () => Response.json(result) });
    await ui.get("agent-build").click();
    assert.equal(ui.runtime().status, expected);
    assert.equal(ui.runtime().definition.revision, 1);
    assert.equal(ui.get("agent-send").disabled, true);
    assert.equal(ui.get("agent-error").hidden, true);
    assert.match(ui.get("agent-runtime-status").textContent, label);
    assert.match(ui.get("agent-runtime-status").textContent, /缺少资料来源依据.*请补充来源/);
    assert.equal(ui.runtimeEvents.at(-1).ready, false);
    const refreshed = await setup({ inspect: () => Response.json(result) });
    assert.equal(refreshed.runtime().status, expected);
    await refreshed.submit("执行任务");
    assert.equal(refreshed.requests.some((request) => request.path.endsWith("/turn")), false);
  }
});

test("同需求旧架构引用不能解锁，新定义绑定通过的版本才可以运行", async () => {
  const record = architecture();
  const result = { agent: { ...designedDefinition(), architectureRef: { version: 1, candidateHash: "candidate-1" } }, architecture: record };
  const ui = await setup({ inspect: () => Response.json(result), build: () => Response.json({ agent: designedDefinition(), architecture: record }) });
  assert.equal(ui.get("agent-send").disabled, true);
  assert.equal(ui.runtime().status, "blocked");
  await ui.get("agent-build").click();
  assert.equal(ui.runtime().status, "ready");
  assert.equal(ui.get("agent-send").disabled, false);
  assert.match(ui.get("agent-runtime-status").textContent, /架构评估已通过/);
  await ui.submit("执行任务");
  assert.equal(ui.requests.filter((request) => request.path.endsWith("/turn")).length, 1);
  await ui.emit("neuma:agent-runtime-request", {});
  const snapshot = ui.runtimeEvents.at(-1);
  snapshot.architecture.status = "failed";
  assert.equal(ui.runtime().architecture.status, "passed");
});

test("旧原型和无mode定义不可发送，保留资料快照并允许重新设计后运行", async () => {
  for (const mode of ["prototype", undefined]) {
    const old = { ...requirements[0], mode, status: "ready", revision: 1,
      memory: "已有偏好", profile: { name: "旧助手", description: "旧资料", icon: "📝" } };
    let builds = 0;
    const ui = await setup({ inspect: () => Response.json({ agent: old }),
      build: () => Response.json(++builds === 1 ? { agent: old } : readyResult(designedDefinition())) });
    assert.equal(ui.runtime().status, "blocked");
    assert.match(ui.get("agent-runtime-status").textContent, /旧原型已停用，请重新设计与检查后运行/);
    assert.equal(ui.get("agent-send").disabled, true);
    assert.equal(ui.get("agent-build").disabled, false);
    await ui.submit("不能直接运行");
    assert.equal(ui.requests.some((request) => request.path.endsWith("/turn")), false);
    await ui.emit("neuma:agent-runtime-request", {});
    const snapshot = ui.runtimeEvents.at(-1);
    assert.equal(snapshot.ready, false);
    assert.equal(snapshot.definition.memory, "已有偏好");
    assert.equal(snapshot.definition.profile.name, "旧助手");
    await ui.get("agent-build").click();
    assert.equal(ui.runtime().status, "blocked");
    await ui.get("agent-build").click();
    assert.equal(ui.runtime().status, "ready");
    assert.equal(ui.get("agent-send").disabled, false);
  }
});

test("服务端非ready定义或不匹配的架构记录不能运行", async () => {
  const unavailable = await setup({ inspect: () => Response.json({ agent: { ...definition(), status: "failed" } }) });
  assert.equal(unavailable.get("agent-send").disabled, true);
  const stale = await setup({ inspect: () => Response.json({ agent: designedDefinition(), architecture: architecture({ draft: { goal: { value: "旧需求" } } }) }) });
  assert.equal(stale.runtime().status, "stale");
  assert.equal(stale.get("agent-send").disabled, true);
});

test("现有说明区域展示可展开的方案依据、检查结论和待接入能力", async () => {
  const record = architecture({ delivery: "needs_connection", summary: "整理指定资料后输出报告。",
    design: { profile: "workflow", rationale: "需要按顺序读取并整理资料。", capabilities: [
      { id: "internal_read_tool", status: "needs_connection", reason: "请连接指定资料来源。" },
      { id: "available_tool", status: "available", reason: "内部能力" },
    ] }, review: { summary: "结构符合需求，等待连接。", internalPrompt: "不可展示的提示词" },
    issues: [{ id: "capability", blocking: true, description: "暂时无法读取资料。", remedy: "连接后重新检查。" }],
  });
  const ui = await setup({ inspect: () => Response.json({ agent: null, architecture: record }) });
  const details = ui.get("agent-brief").children.find((node) => node.className === "agent-requirements-details");
  assert.ok(details);
  assert.equal(details.children[0].textContent, "方案与检查结果");
  const text = (node) => [node.textContent, ...node.children.map(text)].join(" ");
  assert.match(text(details), /流程助手.*需要按顺序读取并整理资料.*结构符合需求，等待连接.*连接后重新检查.*请连接指定资料来源/s);
  assert.doesNotMatch(text(details), /internal_read_tool|available_tool|不可展示的提示词|内部能力/);
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

test("Agent 文件夹的手动对话在清除浏览器后可恢复，任务与新对话不自动写入", async () => {
  const ui = await setup();
  await ui.submit("磁盘保存任务");
  assert.equal(ui.requests.some((request) => request.path.endsWith("/conversation") && request.body), false);
  await ui.get("agent-save-chat").click();
  assert.equal(ui.item().saved, true);
  assert.match(ui.get("agent-storage-note").textContent, /已手动保存到 Agent 文件夹/);
  const restored = await setup({ savedConversations: ui.savedConversations });
  assert.equal(restored.item().messages[0].content, "磁盘保存任务");
  assert.equal(restored.item().messages[1].status, "complete");
  assert.equal(restored.item().saved, true);
  await restored.get("agent-new-chat").click();
  assert.equal(restored.item().messages.length, 0);
  assert.equal(restored.requests.some((request) => request.path.endsWith("/conversation") && request.body), false);
  assert.equal(restored.savedConversations.get("one").messages[0].content, "磁盘保存任务");
});

test("磁盘对话优先于浏览器旧备份，读取不会覆盖服务器已有内容", async () => {
  const stored = new Map([["neuma.agent.conversation.v2.one", JSON.stringify({ schemaVersion: 2,
    messages: [{ role: "user", content: "浏览器旧消息" }] })]]);
  const savedConversations = new Map([["one", { schemaVersion: 2, messages: [{ role: "user", content: "服务器新消息" }] }]]);
  const ui = await setup({ stored, savedConversations });
  assert.equal(ui.item().messages[0].content, "服务器新消息");
  assert.equal(ui.requests.some((request) => request.path.endsWith("/conversation") && request.body), false);
});

test("对话保存失败保留浏览器备份并提示，不能显示已经写入 Agent 文件夹", async () => {
  const ui = await setup({ conversationRequest: (_path, body) => body
    ? Response.json({ error: "磁盘不可写" }, { status: 503 }) : Response.json({ conversation: null }) });
  await ui.submit("需要保留的任务");
  await ui.get("agent-save-chat").click();
  assert.equal(ui.item().saved, false);
  assert.equal(ui.item().localBackup, true);
  assert.equal(JSON.parse(ui.stored.get("neuma.agent.conversation.v2.one")).messages[0].content, "需要保留的任务");
  assert.match(ui.get("agent-error").textContent, /未保存到 Agent 文件夹.*磁盘不可写.*浏览器备份已保留/);
  assert.doesNotMatch(ui.get("agent-storage-note").textContent, /已手动保存到 Agent 文件夹/);
  assert.equal(ui.get("agent-send").disabled, false);
});

test("读取失败保留浏览器备份，随后未保存的任务不会被再次进入时的读取覆盖", async () => {
  const stored = new Map([["neuma.agent.conversation.v2.one", JSON.stringify({ schemaVersion: 2,
    messages: [{ role: "user", content: "备份消息" }] })]]);
  const ui = await setup({ stored, conversationRequest: () => Response.json({ error: "服务未响应" }, { status: 503 }) });
  assert.equal(ui.item().saved, false);
  assert.equal(ui.item().messages[0].content, "备份消息");
  assert.match(ui.get("agent-error").textContent, /保存对话暂时无法读取.*服务未响应.*浏览器备份/);
  await ui.submit("尚未保存的新任务");
  await ui.route(null); await ui.route("one");
  assert.equal(ui.item().messages.at(-2).content, "尚未保存的新任务");
  assert.equal(ui.requests.filter((request) => request.path.endsWith("/conversation")).length, 1);
});

test("迟到的保存对话读取不能覆盖用户开启的新对话", async () => {
  let release, reads = 0;
  const ui = await setup({ conversationRequest: () => ++reads === 1 ? Response.json({ conversation: null })
    : new Promise((done) => { release = done; }) });
  ui.item().loaded = false;
  await ui.route(null);
  const pending = ui.route("one"); await settle();
  assert.equal(ui.get("agent-send").disabled, true);
  const previous = ui.item();
  await ui.get("agent-new-chat").click();
  release(Response.json({ conversation: { schemaVersion: 2, messages: [{ role: "user", content: "迟到旧消息" }] } }));
  await pending;
  assert.notEqual(ui.item(), previous);
  assert.equal(ui.item().messages.length, 0);
  assert.equal(ui.item().saved, false);
  assert.equal(ui.get("agent-send").disabled, false);
});

test("服务器已有旧对话时，失败保存的新对话刷新后仍可恢复并显式重试", async () => {
  const old = { schemaVersion: 2, messages: [{ role: "user", content: "旧对话 A" }] };
  const savedConversations = new Map([["one", old]]);
  const ui = await setup({ savedConversations, conversationRequest: (_path, body) => body
    ? Response.json({ error: "保存连接中断" }, { status: 503 }) : Response.json({ conversation: old }) });
  await ui.get("agent-new-chat").click();
  await ui.submit("新对话 B");
  await ui.get("agent-save-chat").click();
  assert.equal(savedConversations.get("one").messages[0].content, "旧对话 A");
  assert.equal(JSON.parse(ui.stored.get("neuma.agent.conversation.v2.one")).pendingSync, true);
  const restored = await setup({ savedConversations, stored: ui.stored });
  assert.equal(restored.item().messages[0].content, "新对话 B");
  assert.equal(restored.item().saved, false);
  assert.equal(restored.item().pendingSync, true);
  assert.equal(restored.requests.some((request) => request.path.endsWith("/conversation")), false);
  assert.match(restored.get("agent-error").textContent, /未同步的对话.*再次点击保存/);
  assert.equal(JSON.parse(restored.stored.get("neuma.agent.conversation.v2.one")).messages[0].content, "新对话 B");
  await restored.get("agent-save-chat").click();
  assert.equal(savedConversations.get("one").messages[0].content, "新对话 B");
  assert.equal(restored.item().saved, true);
  assert.equal(restored.item().pendingSync, false);
  assert.equal(JSON.parse(restored.stored.get("neuma.agent.conversation.v2.one")).pendingSync, undefined);
});

test("重新生成取消后不把迟到结果设为可运行，旧定义仍可见且可重试", async () => {
  const partial = stream(), ui = await setup({ build: () => partial.response });
  const pending = ui.get("agent-build").click(); await settle();
  await ui.get("agent-cancel-reply").click();
  partial.send({ type: "done", result: readyResult(definition("one", 2)) }); partial.close(); await pending;
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
  const ui = await setup({ build: (body) => ++calls === 1 ? partial.response : Response.json(readyResult({ ...definition(body.id, 3), ...body })) });
  const pending = ui.get("agent-build").click(); await settle();
  const updated = requirements.map((item) => item.id === "one" ? { ...item, draft: { goal: { value: "构建中的新需求", source: "user" } } } : item);
  await ui.emit("neuma:agents-changed", { items: updated, busy: false });
  await ui.emit("neuma:agent-build", { id: "one" });
  assert.equal(ui.requests.find((item) => item.path.endsWith("/build")).signal.aborted, true);
  assert.equal(calls, 1);
  partial.send({ type: "done", result: readyResult(definition("one", 2)) }); partial.close(); await pending;
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
    inspect: () => Response.json({ ...readyResult(), profile: { name: "服务端名字", description: "服务端简介", icon: "📚" } }),
    build: (body) => Response.json(readyResult({ ...definition(body.id, 2), ...body, profile: { name: "生成后的名字", description: "", icon: "🧠" } })),
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
    ? new Promise((done) => { release = done; }) : Response.json(readyResult()) });
  const pending = ui.route("two"); await settle();
  await ui.emit("neuma:agent-profile-changed", { id: "two", profile: { name: "新的日报名字", description: "", icon: "新" } });
  release(Response.json({ ...readyResult(definition("two")), profile: { name: "旧日报名字", description: "旧", icon: "旧" } })); await pending;
  assert.equal(ui.profileEvents.filter((detail) => detail.id === "two").length, 1);
  assert.equal(ui.profileEvents.filter((detail) => detail.id === "two")[0].profile.name, "新的日报名字");
});
