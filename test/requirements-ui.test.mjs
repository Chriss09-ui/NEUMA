import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import * as state from "../public/state.js";

const sources = await Promise.all(["chat-ui.js", "app.js"].map(async (file) =>
  (await readFile(new URL(`../public/${file}`, import.meta.url), "utf8"))
    .replace(/^import[\s\S]*?;\n/gm, "").replace(/^export /gm, "")));
const settle = () => new Promise(setImmediate);
const result = (overrides = {}) => ({
  reply: "我理解你的想法。请描述使用场景。", summary: "我理解你的想法。", question: "请描述使用场景。",
  draft: { name: { value: "会议助手", source: "user" }, goal: { value: "整理会议", source: "user" } },
  status: "needs_input", confirmed: false, jev: { used: false, reason: "not_configured" }, ...overrides,
});

function stream() {
  let controller;
  const response = new Response(new ReadableStream({ start(value) { controller = value; } }),
    { headers: { "content-type": "application/x-ndjson" } });
  return {
    response,
    send(event) { controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`)); },
    close() { controller.close(); },
    fail(error) { controller.error(error); },
  };
}

function setup(turn) {
  class Events {
    listeners = new Map();
    addEventListener(type, callback) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]); }
    dispatchEvent(event) { return Promise.all((this.listeners.get(event.type) ?? []).map((callback) => callback(event))); }
  }
  const document = new Events();
  class Element extends Events {
    value = ""; textContent = ""; children = []; hidden = false; classes = new Set(); attributes = new Map();
    scrollTop = 0; scrollHeight = 200; clientHeight = 200; versions = 0;
    classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
    append(...children) { this.children.push(...children); }
    replaceChildren() { this.children = []; this.versions++; }
    setAttribute(key, value) { this.attributes.set(key, value); }
    removeAttribute(key) { this.attributes.delete(key); }
    focus() { document.activeElement = this; }
    click() { return this.dispatchEvent({ type: "click" }); }
  }
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  document.getElementById = get;
  document.createElement = () => new Element();
  class Event { constructor(type, fields = {}) { this.type = type; Object.assign(this, fields); } }
  const stored = new Map(), requests = [];
  const context = vm.createContext({
    ...state, document, window: { confirm: () => true, localStorage: {
      getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key),
    } },
    Event, CustomEvent: Event, AbortController, TextDecoder, structuredClone, performance,
    crypto: { randomUUID: () => "test-agent" },
    node: (_tag, className = "", textContent = "") => Object.assign(new Element(), { className, textContent }),
    fetch: (path, options) => { requests.push({ path, ...options, body: JSON.parse(options.body) }); return turn(options); },
  });
  vm.runInContext(sources.join("\n"), context);
  return { get, requests, stored, document,
    session: () => vm.runInContext("session", context),
    agents: () => vm.runInContext("agents", context),
    submit: (text) => { get("message").value = text; return get("chat-form").dispatchEvent({ type: "submit", preventDefault() {} }); },
  };
}

test("主 Agent 逐段显示且复用气泡，完成前不更新需求说明，并保留下一条草稿", async () => {
  const reply = stream(), ui = setup(async () => reply.response);
  const pending = ui.submit("做一个会议助手");
  assert.equal(ui.get("message").value, "");
  assert.equal(ui.get("cancel-reply").hidden, false);
  assert.equal(ui.get("send").hidden, true);
  assert.equal(ui.get("messages").children.length, 2);
  for (const message of ui.get("messages").children) {
    assert.equal(message.children.some((child) => child.className === "message-label"), false);
    assert.equal(message.children[0].className, "bubble");
  }
  const row = ui.get("messages").children.at(-1), versions = ui.get("messages").versions;
  await settle();
  reply.send({ type: "status", label: "正在核对需求…" });
  reply.send({ type: "text-start" });
  reply.send({ type: "text-delta", delta: "我理解" }); await settle();
  assert.equal(row.children[0].textContent, "我理解");
  assert.equal(ui.session().draft, null);
  assert.equal(ui.get("draft-status").textContent, "等待描述");
  ui.get("message").value = "下一条草稿";
  ui.get("messages").scrollHeight = 1000; ui.get("messages").scrollTop = 20;
  reply.send({ type: "text-delta", delta: "你的想法。" }); await settle();
  assert.equal(row.children[0].textContent, "我理解你的想法。");
  assert.equal(ui.get("messages").versions, versions);
  assert.equal(ui.get("messages").scrollTop, 20);
  reply.send({ type: "done", result: result() }); reply.close(); await pending;
  assert.equal(ui.session().draft.name.value, "会议助手");
  assert.equal(ui.session().lastQuestion, "请描述使用场景。");
  assert.equal(ui.session().messages.at(-1).content, result().reply);
  assert.equal(ui.session().messages.at(-1).status, "complete");
  assert.equal(ui.get("message").value, "下一条草稿");
  assert.equal(ui.get("cancel-reply").hidden, true);
  assert.equal(ui.get("send").hidden, false);
  assert.equal(ui.requests[0].headers.accept, "application/x-ndjson");
  assert.equal(ui.get("messages").scrollTop, 20);
});

test("停止中断请求，保留已显示内容与需求状态，重新编辑不覆盖下一条草稿", async () => {
  const reply = stream(), ui = setup(async ({ signal }) => {
    signal.addEventListener("abort", () => reply.fail(signal.reason));
    return reply.response;
  });
  const pending = ui.submit("当前问题"); await settle();
  reply.send({ type: "text-delta", delta: "已经显示的文字" }); await settle();
  ui.get("message").value = "下一条草稿";
  await ui.get("cancel-reply").click(); await pending;
  assert.equal(ui.requests[0].signal.aborted, true);
  assert.equal(ui.session().draft, null);
  assert.equal(ui.session().messages[0].delivery, "stopped");
  assert.equal(ui.session().messages[1].status, "stopped");
  assert.equal(ui.session().messages[1].content, "已经显示的文字");
  const recovery = ui.get("messages").children[0].children.at(-1).children[1];
  await recovery.click();
  assert.equal(ui.get("message").value, "下一条草稿\n\n当前问题");
});

test("停止后即使传输仍送来完成事件，也不提交本轮需求或确认入口", async () => {
  const reply = stream(), ui = setup(async () => reply.response);
  const pending = ui.submit("确认需求"); await settle();
  reply.send({ type: "text-delta", delta: "部分回复" }); await settle();
  await ui.get("cancel-reply").click();
  reply.send({ type: "text-delta", delta: "不应显示" });
  reply.send({ type: "done", result: result({ status: "ready", confirmed: true }) }); reply.close(); await pending;
  assert.equal(ui.session().draft, null);
  assert.equal(ui.session().confirmed, false);
  assert.equal(ui.agents().length, 0);
  assert.equal(ui.session().messages.at(-1).content, "部分回复");
});

test("断流保留文字、恢复输入，重试复用用户消息且排除失败上下文", async () => {
  const partial = stream(); let turns = 0;
  const ui = setup(async () => ++turns === 1 ? partial.response : Response.json(result()));
  const pending = ui.submit("当前问题"); await settle();
  partial.send({ type: "text-delta", delta: "未完成回复" }); partial.close(); await pending;
  assert.equal(ui.session().draft, null);
  assert.equal(ui.session().messages.at(-1).content, "未完成回复");
  assert.equal(ui.session().messages.at(-1).status, "error");
  assert.equal(ui.get("message").value, "当前问题");
  assert.match(ui.get("error").textContent, /需求说明仍保留/);
  assert.doesNotMatch(ui.get("error").textContent, /项目操作/);
  await ui.submit(ui.get("message").value);
  assert.equal(ui.session().messages.length, 2);
  assert.equal(ui.requests[1].body.userMessages.length, 0);
  assert.equal(ui.session().messages[0].delivery, "sent");
});

test("安全错误保留上轮需求和当前草稿，不把部分输出标为成功", async () => {
  const partial = stream(); let turns = 0;
  const ui = setup(async () => ++turns === 1 ? Response.json(result()) : partial.response);
  await ui.submit("原始需求");
  const original = ui.session().draft;
  const pending = ui.submit("修改需求"); await settle();
  ui.get("message").value = "另一条草稿";
  partial.send({ type: "text-delta", delta: "修改中" });
  partial.send({ type: "error", error: "服务暂时不可用", diagnostic: { reason: "upstream_error" } });
  await pending;
  assert.equal(ui.session().draft, original);
  assert.equal(ui.get("message").value, "另一条草稿");
  assert.equal(ui.session().messages.at(-1).status, "error");
  assert.equal(ui.session().messages.at(-1).content, "修改中");
  assert.match(ui.get("error").textContent, /服务暂时不可用/);
});

test("旧版 JSON 仍按原有确认语义显示，确认完成才创建智能体入口", async () => {
  let turns = 0;
  const builds = [];
  const ui = setup(async () => {
    const payload = result(++turns === 1
      ? { status: "ready", confirmationQuestion: "以上需求是否确认？" }
      : { status: "ready", confirmed: true });
    delete payload.reply;
    return Response.json(payload);
  });
  ui.document.addEventListener("neuma:agent-build", (event) => builds.push(event.detail.id));
  await ui.submit("整理需求");
  assert.match(ui.session().messages.at(-1).content, /我整理出的需求是：[\s\S]*以上需求是否确认/);
  assert.equal(ui.agents().length, 0);
  await ui.submit("确认");
  assert.match(ui.session().messages.at(-1).content, /需求已确认/);
  assert.match(ui.session().messages.at(-1).content, /正在设计与检查.*通过后生成/s);
  assert.equal(ui.agents().length, 1);
  assert.equal(ui.agents()[0].name, "会议助手");
  assert.deepEqual(builds, ["test-agent"]);
  assert.equal(ui.agents()[0].persisted, true);
  await ui.get("reset").click();
  assert.equal(ui.session().messages.length, 0);
  assert.equal(ui.get("messages").children[0].className, "welcome");
});

test("修改展示信息同步管理卡、交付卡与迭代名称，原始需求及ID保持独立", async () => {
  let turns = 0;
  const ui = setup(async () => Response.json(result({ status: "ready", confirmed: true,
    ...(++turns > 1 ? { draft: { name: { value: "新的需求名称" }, goal: { value: "新的目标" } } } : {}) })));
  await ui.submit("确认需求");
  const profile = { name: "我的会议伙伴", description: "", icon: "📝" };
  await ui.document.dispatchEvent({ type: "neuma:agent-profile-changed", detail: { id: "test-agent", profile } });
  const card = ui.get("agents-list").children[0];
  assert.equal(card.children[1].textContent, "我的会议伙伴");
  assert.equal(card.children[2].textContent, "");
  assert.equal(card.children[0].children[0].textContent, "📝");
  assert.equal(ui.get("iteration-agent-name").textContent, "我的会议伙伴");
  assert.equal(ui.get("messages").children.at(-1).children[2].textContent, "我的会议伙伴");
  assert.equal(ui.agents()[0].name, "会议助手");
  assert.equal(ui.agents()[0].draft.name.value, "会议助手");
  await ui.document.dispatchEvent({ type: "neuma:agent-profiles-loaded", detail: { profiles: [{ id: "test-agent", name: "迟到旧名字", description: "旧简介", icon: "旧" }] } });
  assert.equal(ui.get("agents-list").children[0].children[1].textContent, "我的会议伙伴");
  await ui.submit("迭代需求");
  assert.equal(ui.agents()[0].id, "test-agent");
  assert.equal(ui.agents()[0].name, "新的需求名称");
  assert.equal(ui.agents()[0].profile.name, "我的会议伙伴");
  assert.equal(ui.get("iteration-agent-name").textContent, "我的会议伙伴");
});
