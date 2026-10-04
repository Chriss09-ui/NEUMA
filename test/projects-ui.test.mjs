import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { nuemaText } from "../public/project-view.js";

const source = (await readFile(new URL("../public/projects.js", import.meta.url), "utf8")).replace(/^import .*;\n/gm, "");
const settle = () => new Promise(setImmediate);
const fixture = [
  { id: "one", name: "记账工具", path: "/demo/accounts", kind: "web", description: "每月记账", status: "stopped", canLaunch: true },
  { id: "two", name: "会议纪要", path: "/demo/meetings", kind: "node", description: "整理会议", status: "stopped", canLaunch: true },
];

async function setup({ turn, add, pick, inspect, remove, readList, progress = [], confirm = () => true } = {}) {
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
  const requests = [], navigations = [], renders = [], replies = [];
  let list, interval, records = [...fixture];
  const route = (projectView) => {
    get("manage-projects").hidden = projectView !== "list";
    document.dispatchEvent({ type: "neuma:route", detail: { page: "projects", projectView } });
  };
  document.addEventListener("neuma:navigate", ({ detail }) => { navigations.push(detail); route(detail.projectView); });
  class Event { constructor(type, fields = {}) { this.type = type; Object.assign(this, fields); } }
  vm.runInNewContext(source, {
    document, window: { confirm }, crypto: { randomUUID: () => "test-session" }, AbortController, Event, CustomEvent: Event,
    setInterval: (callback) => { interval = callback; },
    node: (_tag, className, textContent) => Object.assign(new Element(), { className, textContent }),
    mountWelcome: (container, welcome) => container.append(welcome),
    renderUserMessage: (message) => message,
    createReplyView: () => ({ row: new Element(), update(reply) { replies.push(reply); } }), nuemaText,
    addUserMessage: (messages, content) => { const message = { role: "user", content }; messages.push(message); return message; },
    readReply: (response, onProgress) => { onProgress?.({ type: "status", label: "正在阅读项目说明与启动入口…" }); for (const event of progress) onProgress?.(event); return response.json(); }, STATUS_LABELS: { stopped: "未运行" }, updateProjectStatus() {},
    renderProjectDetails: (options) => renders.push(options),
    renderProjectList: (options) => { list = options; get("projects-list").versions = (get("projects-list").versions ?? 0) + 1; },
    fetch: async (path, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined; requests.push({ path, body, signal: options.signal });
      if (path.endsWith("/remove")) {
        const id = path.split("/")[3];
        let project;
        try { project = await remove?.(id, body); }
        catch (error) { return { ok: false, json: async () => ({ error: error.message, code: error.code }) }; }
        records = records.filter((project) => project.id !== id);
        return { ok: true, json: async () => ({ project: project ?? { removed: true } }) };
      }
      const result = path === "/api/projects/turn" ? await (turn?.(body) ?? { reply: "收到", projects: fixture, actions: [] })
        : path === "/api/projects/pick-folder" ? await (pick?.(options.signal) ?? { cancelled: true })
          : path.endsWith("/inspect") ? await inspect(body)
            : path === "/api/projects" && body ? await (add?.(body) ?? { project: fixture[1] }) : await (readList?.(records) ?? { projects: records });
      if (path.endsWith("/inspect") && result.project) records = records.map((project) => project.id === result.project.id ? result.project : project);
      return { ok: true, json: async () => result };
    },
  });
  await settle(); route("assistant"); await settle();
  return { get, requests, navigations, renders, replies, route, document, poll: () => interval(), select: (id) => list.onSelect(id),
    remove: (id) => list.onRemove(id), list: () => list,
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

test("旧服务的识别进度和流式回复显示 NUEMA，保留 API 字样", async () => {
  const ui = await setup({ turn: () => ({ reply: "NUEMA 已处理", projects: fixture, actions: [] }), progress: [
    { type: "status", phase: "tool", label: "PI 正在识别项目…" },
    { type: "text-delta", delta: "让 PI " }, { type: "text-delta", delta: "agent 帮你配置，API 正常。" },
  ] });
  ui.get("project-message").value = "查看项目"; await ui.submit("project-chat-form");
  assert.ok(ui.replies.some((reply) => reply.label === "NUEMA 正在识别项目…"));
  assert.ok(ui.replies.some((reply) => reply.content === "让 NUEMA 帮你配置，API 正常。"));
  assert.equal(ui.replies.some((reply) => /\bPI\b/.test(reply.content)), false);
});

test("列表删除针对点击的项目，确认说明保留文件，取消时不发送请求", async () => {
  const cancelled = await setup({ confirm: () => false });
  await cancelled.remove("two");
  assert.equal(cancelled.requests.some((request) => request.path.endsWith("/remove")), false);
  let confirmation;
  const ui = await setup({ confirm: (message) => { confirmation = message; return true; } });
  ui.select("one"); await ui.remove("two");
  assert.match(confirmation, /会议纪要/); assert.match(confirmation, /文件不会删除/);
  assert.deepEqual(ui.requests.find((request) => request.path.endsWith("/remove")),
    { path: "/api/projects/two/remove", body: { confirm: true }, signal: undefined });
  assert.equal(ui.list().projects.map((project) => project.id).join(), "one");
  assert.equal(ui.renders.at(-1).project.id, "one");
});

test("删除当前项目后回到助手、清除关联并保留草稿，迟到轮询不会恢复已删项目", async () => {
  let delay = false, release;
  const ui = await setup({ readList: (records) => delay ? new Promise((done) => { release = () => done({ projects: records }); }) : { projects: records } });
  ui.select("two"); await ui.click("project-ask"); ui.select("two");
  ui.get("project-message").value = "保留的草稿";
  delay = true; ui.document.visibilityState = "visible"; ui.poll(); await settle();
  await ui.remove("two"); release(); await settle();
  assert.equal(ui.navigations.at(-1).projectView, "assistant");
  assert.equal(ui.get("project-context").hidden, true);
  assert.equal(ui.get("project-message").value, "保留的草稿");
  assert.equal(ui.list().projects.map((project) => project.id).join(), "one");
});

test("停止失败后明确确认仅移除记录，取消时保留项目，成功时提示服务可能仍在运行", async () => {
  const remove = async (_id, body) => {
    if (!body.removeOnly) throw Object.assign(new Error("未能停止项目：停止脚本不存在。"), { code: "PROJECT_REMOVE_STOP_FAILED" });
    return { removed: true, servicesMayBeRunning: true };
  };
  let confirmations = 0;
  const cancelled = await setup({ remove, confirm: () => ++confirmations === 1 });
  await cancelled.remove("two");
  assert.equal(confirmations, 2); assert.equal(cancelled.list().projects.length, 2);
  assert.equal(cancelled.requests.filter((request) => request.body?.removeOnly).length, 0);
  assert.match(cancelled.get("manage-error").textContent, /已保留项目/);
  const prompts = [];
  const ui = await setup({ remove, confirm: (message) => { prompts.push(message); return true; } });
  await ui.remove("two");
  assert.match(prompts[1], /停止脚本不存在/); assert.match(prompts[1], /仅从 NUEMA 中移除/);
  assert.deepEqual(ui.requests.filter((request) => request.path.endsWith("/remove")).map((request) => request.body),
    [{ confirm: true }, { confirm: true, removeOnly: true }]);
  assert.equal(ui.list().projects.length, 1); assert.match(ui.get("project-feedback").textContent, /服务可能仍在运行/);
  assert.equal(ui.list().removeDisabled, false);
});

test("只填路径即可添加并配置，检查中阻止重复提交，完成显示可直接启动", async () => {
  let release;
  const ui = await setup({ add: () => new Promise((done) => { release = done; }) });
  ui.get("project-path").value = "/demo/meetings"; ui.route("add");
  const pending = ui.submit("project-add-form");
  assert.equal(ui.get("project-add-submit").textContent, "正在识别…");
  assert.equal(ui.get("project-add-form").attributes.get("aria-busy"), "true");
  await ui.submit("project-add-form");
  assert.equal(ui.requests.filter((request) => request.path === "/api/projects" && request.body).length, 1);
  assert.deepEqual(ui.requests.find((request) => request.path === "/api/projects" && request.body).body, { path: "/demo/meetings" });
  release({ project: { ...fixture[1], canLaunch: true, setup: { status: "ready" } } }); await pending;
  assert.match(ui.get("project-feedback").textContent, /启动方式已配好/);
  assert.equal(ui.get("project-add-submit").textContent, "添加并自动配置");
});

test("添加未配好时保持表单并提示失败，已有项目仍可重新识别", async () => {
  const ui = await setup({ add: async () => ({ project: { ...fixture[1], id: "failed-new", canLaunch: false, setup: { status: "needs_input", summary: "有两个应用，你想打开哪一个？" } } }),
    inspect: async () => ({ project: { ...fixture[0], canLaunch: true, setup: { status: "ready", summary: "已找到网页入口。" } } }) });
  ui.get("project-path").value = "/demo/meetings"; ui.route("add"); await ui.submit("project-add-form");
  assert.equal(ui.get("add-error").textContent, "添加失败：项目检查未完成，请稍后重试。项目未加入列表。");
  assert.equal(ui.get("project-path").value, "/demo/meetings");
  assert.equal(ui.get("project-add-submit").textContent, "重试添加");
  assert.equal(ui.list().projects.some((project) => project.id === "failed-new"), false);
  assert.equal(ui.navigations.length, 0);
  ui.select("one"); await ui.renders.at(-1).onAction("inspect");
  assert.ok(ui.requests.some((request) => request.path === "/api/projects/one/inspect"));
  assert.equal(ui.get("project-feedback").textContent, "NUEMA 已更新启动方式，可以打开项目了。");
});

test("列表重新识别选中对应项目并立即显示进度，不能重复提交，失败仍可重试", async () => {
  let release;
  const ui = await setup({ inspect: () => new Promise((done) => { release = done; }) });
  ui.select("one");
  const pending = ui.list().onInspect("two");
  assert.equal(ui.renders.at(-1).project.id, "two");
  assert.equal(ui.renders.at(-1).project.setup.status, "checking");
  assert.match(ui.renders.at(-1).project.setup.summary, /NUEMA/);
  await ui.list().onInspect("two");
  assert.equal(ui.requests.filter((request) => request.path.endsWith("/inspect")).length, 1);
  assert.equal(ui.requests.at(-1).path, "/api/projects/two/inspect");
  release({ project: { ...fixture[1], canLaunch: false, setup: { status: "failed", summary: "NUEMA 尚未确认新的启动入口。" } } });
  await pending;
  assert.equal(ui.list().removeDisabled, false);
  assert.equal(ui.renders.at(-1).project.setup.status, "failed");
  assert.match(ui.renders.at(-1).project.setup.summary, /尚未确认/);
  assert.equal(ui.requests.some((request) => request.path.endsWith("/start")), false);
  assert.equal(ui.list().projects.length, 2);
});

test("添加失败保留全部输入，不跳入详情，随后可直接重试成功", async () => {
  let calls = 0;
  const ui = await setup({ add: async () => {
    if (++calls === 1) throw new Error("添加失败，请稍后再试。项目未加入列表。");
    return { project: fixture[1] };
  } });
  ui.get("project-path").value = "/demo/meetings";
  ui.get("project-name").value = "我的项目"; ui.get("project-description").value = "我的说明";
  ui.route("add"); await ui.submit("project-add-form");
  assert.equal(ui.get("add-error").hidden, false); assert.match(ui.get("add-error").textContent, /添加失败/);
  assert.equal(ui.get("project-name").value, "我的项目"); assert.equal(ui.get("project-description").value, "我的说明");
  assert.equal(ui.get("project-add-submit").disabled, false); assert.equal(ui.get("project-add-submit").textContent, "重试添加");
  assert.equal(ui.navigations.length, 0); assert.equal(ui.list().projects.length, 2);
  await ui.submit("project-add-form");
  assert.equal(calls, 2); assert.equal(ui.get("add-error").hidden, true);
  assert.equal(ui.get("project-path").value, ""); assert.equal(ui.navigations.at(-1).projectView, "list");
});

test("添加失败显示服务端原因并保留输入，网络故障转换为可读提示", async () => {
  const ui = await setup({ add: async () => { throw Object.assign(new Error("添加失败：未能确认启动脚本。项目未加入列表。"),
    { diagnostic: { stage: "validation", reason: "unsupported_launcher" } }); } });
  ui.get("project-path").value = "/demo/project"; ui.route("add"); await ui.submit("project-add-form");
  assert.equal(ui.get("add-error").textContent, "添加失败：未能确认启动脚本。项目未加入列表。");
  assert.equal(ui.get("project-path").value, "/demo/project"); assert.equal(ui.navigations.length, 0);
  const disconnected = await setup({ add: async () => { throw new TypeError("Failed to fetch"); } });
  disconnected.get("project-path").value = "/demo/project"; disconnected.route("add"); await disconnected.submit("project-add-form");
  assert.match(disconnected.get("add-error").textContent, /与本机服务的连接中断/);
  assert.doesNotMatch(disconnected.get("add-error").textContent, /Failed to fetch/);
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
  const ui = await setup();
  ui.get("project-path").value = "/demo/meetings";
  ui.route("add");
  await ui.submit("project-add-form");
  assert.equal(ui.navigations.at(-1).projectView, "list");
  assert.equal(ui.renders.at(-1).project.id, "two");
  let resolve;
  const dismissed = await setup({ add: () => new Promise((done) => { resolve = done; }) });
  dismissed.get("project-path").value = "/demo/meetings"; dismissed.route("add");
  const pending = dismissed.submit("project-add-form");
  dismissed.route("assistant");
  resolve({ project: fixture[1] }); await pending;
  assert.equal(dismissed.navigations.length, 0);
});

test("添加入口自动选择文件夹，填入路径和名称后才由用户确认登记", async () => {
  let resolve;
  const ui = await setup({ pick: () => new Promise((done) => { resolve = done; }) });
  ui.route("add");
  assert.equal(ui.get("project-choose-folder").disabled, true);
  assert.equal(ui.get("project-add-submit").disabled, true);
  await ui.click("project-choose-folder");
  await ui.submit("project-add-form");
  assert.equal(ui.requests.filter((r) => r.path === "/api/projects/pick-folder").length, 1);
  assert.equal(ui.requests.some((r) => r.path === "/api/projects" && r.body), false);
  resolve({ cancelled: false, path: "/demo/meetings", name: "会议纪要" }); await settle();
  assert.equal(ui.get("project-path").value, "/demo/meetings");
  assert.equal(ui.get("project-name").value, "会议纪要");
  assert.equal(ui.get("project-add-submit").disabled, false);
  assert.equal(ui.get("project-choose-folder").textContent, "重新选择");
  assert.equal(ui.document.activeElement, ui.get("project-add-submit"));
  await ui.submit("project-add-form");
  assert.deepEqual(ui.requests.find((r) => r.path === "/api/projects" && r.body).body,
    { path: "/demo/meetings", name: "会议纪要" });
});

test("取消选取不清空已填写的名称与用途，手动路径仍能添加", async () => {
  const ui = await setup();
  ui.get("project-name").value = "我的工具"; ui.get("project-description").value = "保留说明";
  ui.route("add"); await settle();
  assert.equal(ui.get("add-error").hidden, true);
  assert.match(ui.get("project-folder-status").textContent, /已取消/);
  assert.equal(ui.document.activeElement, ui.get("project-choose-folder"));
  ui.get("project-path").value = "/demo/meetings";
  await ui.submit("project-add-form");
  assert.deepEqual(ui.requests.find((r) => r.path === "/api/projects" && r.body).body,
    { path: "/demo/meetings", name: "我的工具", description: "保留说明" });
});

test("关闭添加窗口会取消选择请求，迟到结果不能覆盖重开的表单", async () => {
  let resolve;
  const ui = await setup({ pick: () => new Promise((done) => { resolve = done; }) });
  ui.route("add");
  const request = ui.requests.find((r) => r.path === "/api/projects/pick-folder");
  ui.route("assistant");
  assert.equal(request.signal.aborted, true);
  ui.get("project-path").value = "/manual/new"; ui.get("project-name").value = "新草稿";
  ui.route("add");
  resolve({ path: "/old/result", name: "旧结果" }); await settle();
  assert.equal(ui.get("project-path").value, "/manual/new");
  assert.equal(ui.get("project-name").value, "新草稿");
  assert.equal(ui.requests.filter((r) => r.path === "/api/projects/pick-folder").length, 1);
});

test("选择失败可以重试，重新选取只更新自动名称，不覆盖用户命名", async () => {
  let count = 0;
  const ui = await setup({ pick: async () => {
    count++;
    if (count === 1) throw new Error("无法打开选择器");
    return { path: `/demo/folder${count}`, name: `folder${count}` };
  } });
  ui.route("add"); await settle();
  assert.equal(ui.get("add-error").hidden, false);
  assert.equal(ui.get("project-path").disabled, false);
  await ui.click("project-choose-folder");
  assert.equal(ui.get("project-name").value, "folder2");
  await ui.click("project-choose-folder");
  assert.equal(ui.get("project-name").value, "folder3");
  ui.get("project-name").value = "自定义名称";
  await ui.click("project-choose-folder");
  assert.equal(ui.get("project-path").value, "/demo/folder4");
  assert.equal(ui.get("project-name").value, "自定义名称");
});
