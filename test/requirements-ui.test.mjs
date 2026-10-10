import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import * as state from "../public/state.js";
import { renderAgentAvatar } from "../public/agent-avatar.js";

const sources = await Promise.all(["chat-ui.js", "agent-runtime.js", "app.js"].map(async (file) =>
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

function setup(turn, { stored = new Map(), requirements = [], conversations = new Map(), historyConversations = new Map(), storageRequest } = {}) {
  class Events {
    listeners = new Map();
    addEventListener(type, callback) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]); }
    dispatchEvent(event) { return Promise.all((this.listeners.get(event.type) ?? []).map((callback) => callback(event))); }
  }
  const document = new Events();
  class Element extends Events {
    value = ""; textContent = ""; children = []; hidden = false; classes = new Set(); attributes = new Map(); dataset = {};
    scrollTop = 0; scrollHeight = 200; clientHeight = 200; versions = 0;
    classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; this.versions++; }
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
  document.createElement = (tag) => Object.assign(new Element(), { tagName: tag.toUpperCase() });
  class Event { constructor(type, fields = {}) { this.type = type; Object.assign(this, fields); } }
  const requests = [], persistenceRequests = [], serverRequirements = new Map(requirements.map((item) => [item.id, item]));
  const context = vm.createContext({
    ...state, document, window: { confirm: () => true, localStorage: {
      getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key),
    } },
    Event, CustomEvent: Event, AbortController, TextDecoder, TextEncoder, structuredClone, performance,
    crypto: { randomUUID: () => "test-agent" },
    node: (_tag, className = "", textContent = "") => Object.assign(new Element(), { className, textContent }),
    renderAgentAvatar: (target, agent, options) => renderAgentAvatar(target, agent, { ...options, document }),
    fetch: async (path, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      if (path === "/api/requirements/turn") { requests.push({ path, ...options, body }); return turn(options); }
      persistenceRequests.push({ path, ...options, body });
      if (storageRequest) {
        const result = await storageRequest(path, body, options);
        if (result) return result;
      }
      if (path === "/api/agent-requirements") return Response.json({ requirements: [...serverRequirements.values()] });
      const id = decodeURIComponent(path.split("/")[3]);
      if (path.endsWith("/requirements")) {
        const requirement = body.importOnly && serverRequirements.has(id) ? serverRequirements.get(id) : { id, name: body.name, draft: body.draft, updatedAt: body.updatedAt };
        serverRequirements.set(id, requirement);
        return Response.json({ requirement });
      }
      if (path.endsWith("/conversation")) {
        if (body && (!body.importOnly || !conversations.has(id))) conversations.set(id, { schemaVersion: 2, messages: body.messages });
        return Response.json({ conversation: conversations.get(id) ?? null });
      }
      if (path.endsWith("/conversations")) return Response.json({ conversations: [...historyConversations.values()]
        .filter((item) => item.agentId === id && !item.deletedAt) });
      if (path.split("/")[4] === "conversations") {
        const cid = decodeURIComponent(path.split("/")[5]), key = `${id}:${cid}`;
        if (!historyConversations.has(`${id}:legacy-saved`) && conversations.has(id)) {
          const previous = conversations.get(id);
          historyConversations.set(`${id}:legacy-saved`, { schemaVersion: 3, id: "legacy-saved", agentId: id,
            title: "旧对话", createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z",
            saveVersion: 1, mutationId: "legacy-disk", messages: previous.messages });
        }
        const current = historyConversations.get(key);
        if (current?.deletedAt) return Response.json({ conversation: null, deleted: true });
        if (body && (!body.importOnly || !current)) {
          historyConversations.set(key, { schemaVersion: 3, id: cid, agentId: id,
            title: body.messages.find((item) => item.role === "user")?.content.slice(0, 30) || "新对话",
            createdAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z",
            saveVersion: (current?.saveVersion || 0) + 1, mutationId: body.mutationId, messages: body.messages });
        }
        return Response.json({ conversation: historyConversations.get(key) ?? null });
      }
      if (path.endsWith("/remove")) { serverRequirements.delete(id); conversations.delete(id); return Response.json({ removed: true }); }
      throw new Error(`未配置测试接口：${path}`);
    },
  });
  vm.runInContext(sources.join("\n"), context);
  return { get, requests, persistenceRequests, stored, document, serverRequirements, conversations, historyConversations,
    ready: () => vm.runInContext("libraryReady", context),
    session: () => vm.runInContext("session", context),
    agents: () => vm.runInContext("agents", context),
    submit: (text) => { get("message").value = text; return get("chat-form").dispatchEvent({ type: "submit", preventDefault() {} }); },
  };
}

function managementAvatar(ui) { return ui.get("agents-list").children[0].children[0].children[0]; }
function deliveryAvatar(ui) { return ui.get("messages").children.at(-1).children[0]; }

function assertStarAvatar(target, icon, { shape, color } = {}) {
  assert.equal(target.dataset.avatarKind, "star");
  assert.equal(target.dataset.avatarIcon, icon);
  assert.equal(target.children.length, 1);
  const root = target.children[0];
  assert.equal(root.className, "star-avatar");
  assert.equal(root.dataset.avatarMotion, "true");
  if (shape) assert.equal(root.dataset.shape, shape);
  if (color) assert.equal(root.dataset.color, color);
  const world = root.children[0];
  assert.equal(world.className, "star-avatar-world");
  assert.equal(world.children.length, 2);
  assert.equal(world.children[0].className, "star-avatar-shell");
  assert.match(world.children[0].attributes.get("style"), new RegExp(`/assets/avatars/${root.dataset.shape}-mask\\.png`));
  assert.equal(world.children[1].tagName, "IMG");
  assert.equal(world.children[1].className, "star-avatar-core");
  assert.equal(world.children[1].src, "/assets/avatars/core.png");
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
  assert.equal(managementAvatar(ui).dataset.avatarKind, "text");
  assert.equal(deliveryAvatar(ui).dataset.avatarKind, "text");
  assert.equal(deliveryAvatar(ui).textContent, "📝");
  assert.equal(deliveryAvatar(ui).dataset.avatarIcon, profile.icon);
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

test("默认小星核在管理卡与交付卡一致，重命名和重新加载不改变稳定 ID 的头像", async () => {
  const ui = setup(async () => Response.json(result({ status: "ready", confirmed: true })));
  await ui.submit("确认需求");
  const icon = managementAvatar(ui).dataset.avatarIcon;
  assert.match(icon, /^star:[0-5]:[0-7]$/);
  assertStarAvatar(managementAvatar(ui), icon);
  assertStarAvatar(deliveryAvatar(ui), icon);
  await ui.document.dispatchEvent({ type: "neuma:agent-profile-changed", detail: {
    id: "test-agent", profile: { name: "改名后的伙伴", description: "", icon: "" },
  } });
  assertStarAvatar(managementAvatar(ui), icon);
  assertStarAvatar(deliveryAvatar(ui), icon);
  assert.equal(ui.agents()[0].id, "test-agent");
  assert.equal(ui.agents()[0].draft.name.value, "会议助手");
  const restored = setup(async () => Response.json(result()), { requirements: [{
    id: "test-agent", name: "另一份名称", draft: { goal: { value: "整理会议" } },
    profile: { name: "重新加载的名称", description: "", icon: "" },
  }] });
  await restored.ready();
  assertStarAvatar(managementAvatar(restored), icon);
});

test("当前展示头像的造型和配色同步管理卡、交付卡，继续迭代仍保留选择", async () => {
  const ui = setup(async () => Response.json(result({ status: "ready", confirmed: true })));
  await ui.submit("确认需求");
  const profile = { name: "我的星核伙伴", description: "整理会议", icon: "star:4:7" };
  await ui.document.dispatchEvent({ type: "neuma:agent-profile-changed", detail: { id: "test-agent", profile } });
  for (const avatar of [managementAvatar(ui), deliveryAvatar(ui)]) {
    assertStarAvatar(avatar, profile.icon, { shape: "diamond", color: "rose" });
    assert.match(avatar.children[0].children[0].children[0].attributes.get("style"), /--avatar-shell: #df7caa;/);
  }
  const next = { ...profile, icon: "star:2:0" };
  await ui.document.dispatchEvent({ type: "neuma:agent-profile-changed", detail: { id: "test-agent", profile: next } });
  await ui.submit("继续迭代需求");
  for (const avatar of [managementAvatar(ui), deliveryAvatar(ui)]) {
    assertStarAvatar(avatar, next.icon, { shape: "trapezoid", color: "mint" });
    assert.match(avatar.children[0].children[0].children[0].attributes.get("style"), /--avatar-shell: #24b89a;/);
  }
  assert.equal(ui.agents()[0].profile.icon, next.icon);
  assert.equal(ui.agents()[0].name, "会议助手");
});

test("没有浏览器入口也能从 Agent 文件夹恢复列表，主需求会话仍为空白", async () => {
  const requirement = { id: "saved-one", name: "磁盘助手", draft: { goal: { value: "磁盘需求" } },
    profile: { name: "我的助手", description: "", icon: "📁" }, updatedAt: "2026-10-08T03:00:00Z" };
  const ui = setup(async () => Response.json(result()), { requirements: [requirement] });
  await ui.ready();
  assert.equal(ui.agents().length, 1);
  assert.equal(ui.agents()[0].id, "saved-one");
  assert.equal(ui.agents()[0].persisted, true);
  assert.equal(ui.get("agents-list").children[0].children[1].textContent, "我的助手");
  assert.equal(ui.session().messages.length, 0);
  assert.equal(ui.session().draft, null);
  assert.equal(ui.persistenceRequests.some((request) => request.body), false);
  assert.equal(ui.stored.has("neuma.requirements.session.optin.v1"), false);
  assert.equal(JSON.parse(ui.stored.get("neuma.requirements.saved-list.v1"))[0].id, "saved-one");
});

test("首次接入迁移全部旧需求及手动保存对话，服务器现存版本优先", async () => {
  const stored = new Map();
  const backup = (id, name) => ({ id, name, draft: { goal: { value: name } }, updatedAt: "2026-10-07T03:00:00Z" });
  stored.set("neuma.requirements.saved-list.v1", JSON.stringify([backup("one", "旧浏览器需求"), backup("two", "待迁移需求")]));
  stored.set("neuma.agent.conversation.v2.one", JSON.stringify({ schemaVersion: 2, messages: [{ role: "user", content: "旧浏览器对话" }] }));
  stored.set("neuma.agent.preview.v1.two", JSON.stringify([{ role: "user", content: "旧版手动材料" }]));
  const durable = backup("one", "服务器新需求"), conversations = new Map([["one", { schemaVersion: 2, messages: [{ role: "user", content: "服务器新对话" }] }]]);
  const ui = setup(async () => Response.json(result()), { stored, requirements: [durable], conversations });
  await ui.ready();
  assert.equal(ui.agents().find((item) => item.id === "one").name, "服务器新需求");
  assert.equal(ui.agents().find((item) => item.id === "two").persisted, true);
  assert.equal(ui.serverRequirements.get("two").name, "待迁移需求");
  assert.equal(conversations.get("one").messages[0].content, "服务器新对话");
  assert.equal(ui.historyConversations.get("two:legacy-saved").messages[0].content, "旧版手动材料");
  assert.equal(ui.persistenceRequests.filter((request) => request.body).length, 3);
  assert.equal(ui.persistenceRequests.filter((request) => request.body).every((request) => request.body.importOnly === true), true);
  assert.equal(stored.has("neuma.agent.conversation.v2.one"), false);
  assert.equal(stored.has("neuma.agent.preview.v1.two"), false);
  assert.equal(state.loadAgentConversationBackups({ getItem: (key) => stored.get(key) ?? null }, "one")[0].messages[0].content, "服务器新对话");
  assert.equal(ui.session().messages.length, 0);
  assert.equal(ui.stored.has("neuma.requirements.session.optin.v1"), false);
});

test("确认后的需求保存失败保留浏览器备份，提示真实失败且不自动开始构建", async () => {
  const builds = [], ui = setup(async () => Response.json(result({ status: "ready", confirmed: true })), {
    storageRequest: (path) => path.endsWith("/requirements") ? Response.json({ error: "磁盘写入失败" }, { status: 503 }) : null,
  });
  ui.document.addEventListener("neuma:agent-build", (event) => builds.push(event.detail.id));
  await ui.submit("确认需求");
  assert.equal(ui.agents().length, 1);
  assert.equal(ui.agents()[0].persisted, false);
  assert.equal(ui.agents()[0].dirty, true);
  assert.equal(ui.agents()[0].localBackup, true);
  assert.deepEqual(builds, []);
  assert.match(ui.get("agents-error").textContent, /未保存到文件夹.*磁盘写入失败.*浏览器备份已保留/);
  assert.equal(JSON.parse(ui.stored.get("neuma.requirements.saved-list.v1"))[0].id, "test-agent");
});

test("服务未响应时浏览器入口保留但不标为已保存到磁盘", async () => {
  const stored = new Map([["neuma.requirements.saved-list.v1", JSON.stringify([
    { id: "one", name: "浏览器助手", draft: { goal: { value: "需求" } } },
  ])]]);
  const ui = setup(async () => Response.json(result()), { stored,
    storageRequest: (path) => path === "/api/agent-requirements" ? Promise.reject(new Error("服务未响应")) : null,
  });
  await ui.ready();
  assert.equal(ui.agents().length, 1);
  assert.equal(ui.agents()[0].persisted, false);
  assert.match(ui.get("agents-error").textContent, /文件夹暂时无法读取.*浏览器备份保留.*服务未响应/);
  assert.equal(ui.stored.has("neuma.requirements.saved-list.v1"), true);
});

test("已删除 Agent 的旧浏览器备份不会复活，也不会继续导入其对话", async () => {
  const stored = new Map([["neuma.requirements.saved-list.v1", JSON.stringify([
    { id: "deleted", name: "已删助手", draft: { goal: { value: "需求" } } },
  ])], ["neuma.agent.conversation.v2.deleted", JSON.stringify({ schemaVersion: 2, messages: [{ role: "user", content: "旧对话" }] })]]);
  const ui = setup(async () => Response.json(result()), { stored,
    storageRequest: (path) => path.endsWith("/requirements") ? Response.json({ requirement: null, deleted: true }) : null,
  });
  await ui.ready();
  assert.equal(ui.agents().length, 0);
  assert.equal(stored.has("neuma.requirements.saved-list.v1"), false);
  assert.equal(stored.has("neuma.agent.conversation.v2.deleted"), false);
  assert.equal(ui.persistenceRequests.some((request) => request.path.endsWith("/conversation")), false);
});

test("已删除 Agent 的待同步需求也会清理，探测时不上传尚未确认的版本", async () => {
  const stored = new Map([["neuma.requirements.saved-list.v1", JSON.stringify([
    { id: "deleted", name: "已删助手", draft: { goal: { value: "新需求" } }, pendingSync: true },
  ])], ["neuma.agent.conversation.v2.deleted", JSON.stringify({ schemaVersion: 2, messages: [{ role: "user", content: "旧对话" }] })]]);
  const ui = setup(async () => Response.json(result()), { stored,
    storageRequest: (path) => path.endsWith("/conversations") ? Response.json({ conversations: [], deleted: true }) : null,
  });
  await ui.ready();
  assert.equal(ui.agents().length, 0);
  assert.equal(stored.has("neuma.requirements.saved-list.v1"), false);
  assert.equal(stored.has("neuma.agent.conversation.v2.deleted"), false);
  assert.equal(ui.persistenceRequests.some((request) => request.body), false);
});

test("待同步需求的删除状态读取失败时保留新版备份并提示，不能上传或清理", async () => {
  const pending = { id: "one", name: "未同步需求", draft: { goal: { value: "新目标" } }, pendingSync: true };
  const stored = new Map([["neuma.requirements.saved-list.v1", JSON.stringify([pending])]]);
  const ui = setup(async () => Response.json(result()), { stored,
    storageRequest: (path) => path.endsWith("/conversations") ? Response.json({ error: "删除状态读取失败" }, { status: 503 }) : null,
  });
  await ui.ready();
  assert.equal(ui.agents()[0].name, pending.name);
  assert.equal(ui.agents()[0].pendingSync, true);
  assert.deepEqual(JSON.parse(stored.get("neuma.requirements.saved-list.v1")), [pending]);
  assert.equal(ui.persistenceRequests.some((request) => request.body), false);
  assert.match(ui.get("agents-error").textContent, /浏览器备份保留.*删除状态读取失败/);
});

test("只删除legacy-saved聊天后启动仍保留该Agent尚未同步的需求", async () => {
  const old = { id: "one", name: "已保存助手", draft: { goal: { value: "磁盘目标" } } };
  const pending = { ...old, name: "未同步助手", draft: { goal: { value: "新目标" } }, pendingSync: true };
  const stored = new Map([["neuma.requirements.saved-list.v1", JSON.stringify([pending])]]);
  const historyConversations = new Map([["one:legacy-saved", { schemaVersion: 3, id: "legacy-saved", agentId: "one", deletedAt: "2026-10-09T01:00:00.000Z" }]]);
  const ui = setup(async () => Response.json(result()), { stored, requirements: [old], historyConversations,
    storageRequest: (path) => path.endsWith("/conversation") ? Response.json({ conversation: null, deleted: true }) : null,
  });
  await ui.ready();
  assert.equal(ui.agents().length, 1);
  assert.equal(ui.agents()[0].name, "未同步助手");
  assert.equal(ui.agents()[0].pendingSync, true);
  assert.deepEqual(JSON.parse(stored.get("neuma.requirements.saved-list.v1")), [pending]);
  assert.equal(ui.persistenceRequests.some((request) => request.path.endsWith("/conversation")), false);
});

test("同一需求版本的并发保存只提交一次", async () => {
  const requirement = { id: "one", name: "助手", draft: { goal: { value: "目标" } } };
  let release, writes = 0;
  const ui = setup(async () => Response.json(result()), { requirements: [requirement],
    storageRequest: (path, body) => {
      if (!path.endsWith("/requirements")) return null;
      writes++;
      return new Promise((done) => { release = () => done(Response.json({ requirement: { id: "one", ...body } })); });
    },
  });
  await ui.ready();
  const save = () => ui.document.dispatchEvent({ type: "neuma:agent-action", detail: { action: "save", id: "one" } });
  const first = save(); await settle();
  const second = save(); await settle();
  assert.equal(writes, 1);
  release();
  assert.deepEqual(await first, [true]);
  assert.deepEqual(await second, [true]);
  assert.equal(ui.agents()[0].dirty, false);
});

for (const previousOutcome of ["success", "failure"]) test(`旧需求保存${previousOutcome === "success" ? "成功" : "失败"}后重新保存确认的新需求，不复用旧结果或丢失新版备份`, async () => {
  const old = { id: "one", name: "旧需求 A", draft: { name: { value: "旧需求 A" }, goal: { value: "目标 A" } } };
  const latest = { name: { value: "新需求 B" }, goal: { value: "目标 B" } };
  let release, writes = 0;
  const builds = [], ui = setup(async () => Response.json(result({ status: "ready", confirmed: true, draft: latest })), {
    requirements: [old], storageRequest: (path, body) => {
      if (!path.endsWith("/requirements") || ++writes !== 1) return null;
      return new Promise((done) => { release = () => done(previousOutcome === "success"
        ? Response.json({ requirement: { id: "one", ...body } }) : Response.json({ error: "旧保存中断" }, { status: 503 })); });
    },
  });
  await ui.ready();
  ui.document.addEventListener("neuma:agent-build", (event) => builds.push(event.detail.id));
  const previous = ui.document.dispatchEvent({ type: "neuma:agent-action", detail: { action: "save", id: "one" } });
  await settle();
  await ui.document.dispatchEvent({ type: "neuma:agent-action", detail: { action: "edit", id: "one" } });
  const current = ui.submit("确认新需求 B"); await settle();
  const pendingBackup = JSON.parse(ui.stored.get("neuma.requirements.saved-list.v1"))[0];
  assert.equal(pendingBackup.name, "新需求 B");
  assert.equal(pendingBackup.pendingSync, true);
  assert.deepEqual(builds, []);
  release(); await previous; await current;
  assert.equal(writes, 2);
  assert.equal(ui.serverRequirements.get("one").name, "新需求 B");
  assert.equal(ui.agents()[0].dirty, false);
  assert.equal(ui.agents()[0].pendingSync, false);
  const confirmedBackup = JSON.parse(ui.stored.get("neuma.requirements.saved-list.v1"))[0];
  assert.equal(confirmedBackup.name, "新需求 B");
  assert.equal(confirmedBackup.pendingSync, undefined);
  assert.deepEqual(builds, ["one"]);
});

test("删除等待旧保存时阻止排队的新需求再保存或构建", async () => {
  const old = { id: "one", name: "旧需求", draft: { goal: { value: "旧目标" } } };
  let release, writes = 0;
  const builds = [], ui = setup(async () => Response.json(result({ status: "ready", confirmed: true,
    draft: { name: { value: "新需求" }, goal: { value: "新目标" } } })), {
    requirements: [old], storageRequest: (path, body) => {
      if (!path.endsWith("/requirements")) return null;
      writes++;
      return new Promise((done) => { release = () => done(Response.json({ requirement: { id: "one", ...body } })); });
    },
  });
  await ui.ready();
  ui.document.addEventListener("neuma:agent-build", (event) => builds.push(event.detail.id));
  const previous = ui.document.dispatchEvent({ type: "neuma:agent-action", detail: { action: "save", id: "one" } });
  await settle();
  await ui.document.dispatchEvent({ type: "neuma:agent-action", detail: { action: "edit", id: "one" } });
  const current = ui.submit("确认新需求"); await settle();
  const card = ui.get("agents-list").children[0];
  const removal = card.children.find((node) => node.className === "agent-actions").children.find((node) => node.textContent === "删除").click();
  await settle();
  release(); await Promise.all([previous, current, removal]);
  assert.equal(writes, 1);
  assert.equal(ui.agents().length, 0);
  assert.equal(ui.serverRequirements.has("one"), false);
  assert.equal(ui.stored.has("neuma.requirements.saved-list.v1"), false);
  assert.deepEqual(builds, []);
});

test("服务器已有旧需求时，失败保存的新需求刷新后仍可恢复并显式重试", async () => {
  const old = { id: "one", name: "旧需求 A", draft: { name: { value: "旧需求 A" }, goal: { value: "目标 A" } } };
  const latest = { name: { value: "新需求 B" }, goal: { value: "目标 B" } };
  const ui = setup(async () => Response.json(result({ status: "ready", confirmed: true, draft: latest })), {
    requirements: [old], storageRequest: (path, body) => path.endsWith("/requirements") && !body.importOnly
      ? Response.json({ error: "保存连接中断" }, { status: 503 }) : null,
  });
  await ui.ready();
  await ui.document.dispatchEvent({ type: "neuma:agent-action", detail: { action: "edit", id: "one" } });
  await ui.submit("确认新需求 B");
  assert.equal(ui.serverRequirements.get("one").name, "旧需求 A");
  assert.equal(JSON.parse(ui.stored.get("neuma.requirements.saved-list.v1"))[0].pendingSync, true);
  const restored = setup(async () => Response.json(result()), { requirements: [old], stored: ui.stored });
  await restored.ready();
  assert.equal(restored.agents()[0].name, "新需求 B");
  assert.equal(restored.agents()[0].dirty, true);
  assert.equal(restored.agents()[0].pendingSync, true);
  assert.equal(restored.agents()[0].persisted, true);
  assert.equal(JSON.parse(restored.stored.get("neuma.requirements.saved-list.v1"))[0].name, "新需求 B");
  assert.equal(restored.persistenceRequests.some((request) => request.body), false);
  assert.match(restored.get("agents-error").textContent, /未同步.*再次点击保存/);
  await restored.document.dispatchEvent({ type: "neuma:agent-action", detail: { action: "save", id: "one" } });
  assert.equal(restored.serverRequirements.get("one").name, "新需求 B");
  assert.equal(restored.agents()[0].dirty, false);
  assert.equal(restored.agents()[0].pendingSync, false);
  assert.equal(JSON.parse(restored.stored.get("neuma.requirements.saved-list.v1"))[0].pendingSync, undefined);
});

test("启动迁移将尚未同步的浏览器保存作为独立历史对话，保留磁盘旧对话", async () => {
  const old = { id: "one", name: "助手", draft: { goal: { value: "目标" } } };
  const pending = { schemaVersion: 2, messages: [{ role: "user", content: "未同步对话 B" }], pendingSync: true };
  const stored = new Map([["neuma.requirements.saved-list.v1", JSON.stringify([old])],
    ["neuma.agent.conversation.v2.one", JSON.stringify(pending)]]);
  const conversations = new Map([["one", { schemaVersion: 2, messages: [{ role: "user", content: "磁盘对话 A" }] }]]);
  const ui = setup(async () => Response.json(result()), { stored, requirements: [old], conversations });
  await ui.ready();
  assert.equal(stored.has("neuma.agent.conversation.v2.one"), false);
  assert.equal(conversations.get("one").messages[0].content, "磁盘对话 A");
  assert.equal(ui.historyConversations.get("one:legacy-saved").messages[0].content, "磁盘对话 A");
  assert.equal(ui.historyConversations.get("one:legacy-browser-pending").messages[0].content, "未同步对话 B");
  assert.equal(state.loadAgentConversationBackups({ getItem: (key) => stored.get(key) ?? null }, "one")[0].pendingSync, undefined);
  assert.equal(ui.persistenceRequests.some((request) => request.path.endsWith("/conversation")), false);
  assert.equal(ui.get("agents-error").textContent, "");
});

test("旧对话迁移确认后清旧键，刷新不重复导入且删除标记不会复活", async () => {
  const requirement = { id: "one", name: "助手", draft: { goal: { value: "目标" } } };
  const legacy = { schemaVersion: 2, messages: [{ role: "user", content: "旧消息" }] };
  const stored = new Map([["neuma.requirements.saved-list.v1", JSON.stringify([requirement])],
    ["neuma.agent.conversation.v2.one", JSON.stringify(legacy)]]);
  const historyConversations = new Map();
  const first = setup(async () => Response.json(result()), { stored, requirements: [requirement], historyConversations });
  await first.ready();
  assert.equal(historyConversations.size, 1);
  assert.equal(stored.has("neuma.agent.conversation.v2.one"), false);
  const refreshed = setup(async () => Response.json(result()), { stored, requirements: [requirement], historyConversations });
  await refreshed.ready();
  assert.equal(historyConversations.size, 1);
  assert.equal(refreshed.persistenceRequests.some((request) => request.path.includes("/conversations/")), false);
  stored.set("neuma.agent.conversation.v2.one", JSON.stringify(legacy));
  historyConversations.set("one:legacy-saved", { id: "legacy-saved", deletedAt: "2026-10-09T01:00:00.000Z" });
  const restoredOldBrowser = setup(async () => Response.json(result()), { stored, requirements: [requirement], historyConversations });
  await restoredOldBrowser.ready();
  assert.equal(stored.has("neuma.agent.conversation.v2.one"), false);
  assert.equal(historyConversations.get("one:legacy-saved").messages, undefined);
  assert.equal(restoredOldBrowser.persistenceRequests.some((request) => request.path.includes("/conversations/") && request.body), false);
});

test("旧pending迁移失败保留完整旧备份，服务器删除冲突时只清旧副本", async () => {
  const requirement = { id: "one", name: "助手", draft: { goal: { value: "目标" } } };
  const pending = { schemaVersion: 2, messages: [{ role: "user", content: "未同步内容" }], pendingSync: true };
  const stored = new Map([["neuma.requirements.saved-list.v1", JSON.stringify([requirement])],
    ["neuma.agent.conversation.v2.one", JSON.stringify(pending)]]);
  const failed = setup(async () => Response.json(result()), { stored, requirements: [requirement],
    storageRequest: (path, body) => path.includes("/conversations/") && body
      ? Response.json({ error: "磁盘暂时无法写入" }, { status: 503 }) : null,
  });
  await failed.ready();
  assert.deepEqual(JSON.parse(stored.get("neuma.agent.conversation.v2.one")), pending);
  assert.match(failed.get("agents-error").textContent, /浏览器备份保留.*磁盘暂时无法写入/);
  const deleted = setup(async () => Response.json(result()), { stored, requirements: [requirement],
    storageRequest: (path, body) => path.includes("/conversations/") && body
      ? Response.json({ error: "该对话已删除", reason: "conversation_deleted" }, { status: 409 }) : null,
  });
  await deleted.ready();
  assert.equal(stored.has("neuma.agent.conversation.v2.one"), false);
  assert.equal(deleted.historyConversations.size, 0);
});

test("旧pending与磁盘消息相同时只清迁移键，不产生第二条重复历史", async () => {
  const requirement = { id: "one", name: "助手", draft: { goal: { value: "目标" } } };
  const messages = [{ role: "user", content: "已保存的相同内容" }];
  const stored = new Map([["neuma.requirements.saved-list.v1", JSON.stringify([requirement])],
    ["neuma.agent.conversation.v2.one", JSON.stringify({ schemaVersion: 2, messages, pendingSync: true })]]);
  const conversations = new Map([["one", { schemaVersion: 2, messages }]]);
  const ui = setup(async () => Response.json(result()), { stored, requirements: [requirement], conversations });
  await ui.ready();
  assert.equal(ui.historyConversations.size, 1);
  assert.equal(ui.historyConversations.has("one:legacy-browser-pending"), false);
  assert.equal(stored.has("neuma.agent.conversation.v2.one"), false);
  assert.equal(ui.persistenceRequests.some((request) => request.path.includes("/conversations/") && request.body), false);
});
