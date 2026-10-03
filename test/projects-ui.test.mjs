import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = (await readFile(new URL("../public/projects.js", import.meta.url), "utf8")).replace(/^import .*;\n/gm, "");
const settle = () => new Promise(setImmediate);
const fixture = [
  { id: "one", name: "记账工具", path: "/demo/accounts", kind: "web", description: "每月记账", status: "stopped" },
  { id: "two", name: "会议纪要", path: "/demo/meetings", kind: "node", description: "整理会议", status: "stopped" },
];

async function setup({ turn, add } = {}) {
  class Events {
    listeners = new Map();
    addEventListener(type, callback) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]); }
    dispatchEvent(event) { return Promise.all((this.listeners.get(event.type) ?? []).map((callback) => callback(event))); }
  }
  const document = new Events();
  class Element extends Events {
    value = ""; dataset = {}; children = []; hidden = false; attributes = new Map();
    scrollTop = 0; scrollHeight = 100; clientHeight = 100;
    append(...children) { this.children.push(...children); }
    replaceChildren() { this.children = []; }
    querySelectorAll() { return []; }
    setAttribute(key, value) { this.attributes.set(key, value); }
    focus() { document.activeElement = this; }
  }
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  document.getElementById = get;
  const requests = [], navigations = [], renders = [];
  let list, interval;
  const route = (projectView) => {
    get("manage-projects").hidden = projectView !== "list";
    document.dispatchEvent({ type: "neuma:route", detail: { page: "projects", projectView } });
  };
  document.addEventListener("neuma:navigate", ({ detail }) => { navigations.push(detail); route(detail.projectView); });
  class Event { constructor(type, fields = {}) { this.type = type; Object.assign(this, fields); } }
  vm.runInNewContext(source, {
    document, window: { confirm: () => true }, crypto: { randomUUID: () => "test-session" }, AbortController, Event, CustomEvent: Event,
    setInterval: (callback) => { interval = callback; },
    node: (_tag, className, textContent) => Object.assign(new Element(), { className, textContent }),
    mountWelcome: (container, welcome) => container.append(welcome),
    renderUserMessage: (message) => message,
    createReplyView: () => ({ row: new Element(), update() {} }),
    addUserMessage: (messages, content) => { const message = { role: "user", content }; messages.push(message); return message; },
    readReply: (response) => response.json(), STATUS_LABELS: { stopped: "未运行" }, updateProjectStatus() {},
    renderProjectDetails: (options) => renders.push(options),
    renderProjectList: (options) => { list = options; get("projects-list").versions = (get("projects-list").versions ?? 0) + 1; },
    fetch: async (path, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined; requests.push({ path, body });
      const result = path === "/api/projects/turn" ? await (turn?.(body) ?? { reply: "收到", projects: fixture, actions: [] })
        : path === "/api/projects" && body ? await (add?.(body) ?? { project: fixture[1] }) : { projects: fixture };
      return { ok: true, json: async () => result };
    },
  });
  await settle(); route("assistant"); await settle();
  return { get, requests, navigations, renders, route, document, poll: () => interval(), select: (id) => list.onSelect(id),
    click: (id) => get(id).dispatchEvent({ type: "click" }),
    submit: (id) => get(id).dispatchEvent({ type: "submit", preventDefault() {} }),
  };
}

test("从项目详情问助手携带明确项目路径，保留草稿且可取消关联", async () => {
  const ui = await setup();
  ui.get("project-message").value = "这个项目怎么启动？";
  ui.select("two"); await ui.click("project-ask");
  assert.equal(ui.get("project-context-open").textContent, "会议纪要");
  assert.equal(ui.get("project-message").value, "这个项目怎么启动？");
  await ui.submit("project-chat-form");
  assert.equal(ui.requests.find((request) => request.path.endsWith("/turn")).body.message,
    "当前项目：会议纪要\n项目路径：/demo/meetings\n\n这个项目怎么启动？");
  await ui.click("project-context-open");
  assert.equal(ui.navigations.at(-1).projectView, "list");
  await ui.click("project-context-clear");
  assert.equal(ui.get("project-context").hidden, true);
});

test("轮询没有变化时不重建列表；切回详情保留未提交的启动配置", async () => {
  const ui = await setup();
  ui.select("one");
  const versions = ui.get("projects-list").versions;
  ui.document.visibilityState = "visible"; ui.poll(); await settle();
  assert.equal(ui.get("projects-list").versions, versions);
  const detailRenders = ui.renders.length;
  ui.route("assistant"); ui.route("list");
  assert.equal(ui.renders.length, detailRenders);
});

test("助手回复期间可以查看项目，结束不跳回对话，也不清空下一条草稿", async () => {
  let resolve;
  const ui = await setup({ turn: () => new Promise((done) => { resolve = done; }) });
  ui.get("project-message").value = "查看状态";
  const pending = ui.submit("project-chat-form");
  assert.equal(ui.get("project-message").value, "");
  assert.equal(ui.get("project-assistant-state").textContent, "正在回复…");
  ui.select("two"); ui.get("project-message").value = "下一条草稿";
  resolve({ reply: "已查看", projects: fixture, actions: [] }); await pending;
  assert.equal(ui.navigations.at(-1).projectView, "list");
  assert.equal(ui.get("manage-projects").hidden, false);
  assert.equal(ui.get("project-message").value, "下一条草稿");
});

test("添加完成选中新项目；提交后离开弹窗时不强行跳转", async () => {
  const ui = await setup(); ui.route("add");
  ui.get("project-path").value = "/demo/meetings";
  await ui.submit("project-add-form");
  assert.equal(ui.navigations.at(-1).projectView, "list");
  assert.equal(ui.renders.at(-1).project.id, "two");
  let resolve;
  const dismissed = await setup({ add: () => new Promise((done) => { resolve = done; }) });
  dismissed.route("add"); dismissed.get("project-path").value = "/demo/meetings";
  const pending = dismissed.submit("project-add-form");
  dismissed.route("assistant");
  resolve({ project: fixture[1] }); await pending;
  assert.equal(dismissed.navigations.length, 0);
});
