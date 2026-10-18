import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { agentBuildState } from "../public/agent-runtime.js";
import { validDraft } from "./helpers/architecture.mjs";

const read = async (name) => (await readFile(new URL(`../public/${name}`, import.meta.url), "utf8"))
  .replace(/^import[^\n]*\n/gm, "").replace(/^export /gm, "");
const source = (await Promise.all(["group-view.js", "main-context.js"].map(read))).join("\n");
const settle = async () => { for (let index = 0; index < 4; index++) await new Promise(setImmediate); };

function setup(api) {
  const document = { hidden: false }, nodes = new Map(), timers = new Map(); let serial = 0, conversationId = "main-one";
  class Element {
    constructor(tag = "div") { this.tagName = tag.toUpperCase(); }
    children = []; attributes = new Map(); listeners = new Map(); dataset = {}; classes = new Set();
    textContent = ""; className = ""; hidden = false; inert = false; open = false; isConnected = false;
    classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name),
      add: (...names) => names.forEach((name) => this.classes.add(name)), remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name) || this.className.split(/\s+/).includes(name) };
    contains(value) { return this === value || this.children.some((child) => child.contains(value)); }
    connect(value) { this.isConnected = value; for (const child of this.children) child.connect(value); }
    append(...children) { for (const child of children) { child.connect(this.isConnected); this.children.push(child); } }
    replaceChildren(...children) {
      for (const child of this.children) {
        if (child.contains(document.activeElement)) document.activeElement = document.body;
        child.connect(false);
      }
      this.children = []; this.append(...children);
    }
    querySelectorAll(selector) {
      const all = this.children.flatMap((child) => [child, ...child.querySelectorAll("*")]);
      return selector === "*" ? all : all.filter((child) => selector.startsWith(".") ? child.classList.contains(selector.slice(1)) : child.tagName === selector.toUpperCase());
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    toggle(value) { this.open = value; this.listeners.get("toggle")?.(); }
    focus() { if (this.isConnected) document.activeElement = this; }
  }
  document.body = new Element("body"); document.body.connect(true); document.activeElement = document.body;
  const get = (id) => {
    if (!nodes.has(id)) { const element = new Element(); element.id = id; document.body.append(element); nodes.set(id, element); }
    return nodes.get(id);
  };
  document.getElementById = get; document.createElement = (tag) => new Element(tag);
  const context = vm.createContext({ document, api, agentBuildState, AbortController, structuredClone,
    setInterval(callback) { const id = ++serial; timers.set(id, callback); return id; }, clearInterval: (id) => timers.delete(id),
    current: () => ({ id: conversationId }) });
  vm.runInContext(`${source}\nthis.panel = createMainContext({api,current,submit(){},edit(){},build(){}});`, context);
  const text = (element) => `${element.textContent}${element.children.map(text).join("")}`;
  return { panel: context.panel, document, get, select(id) { conversationId = id; }, button(label) {
    const value = get("main-context-content").querySelectorAll("button").find((item) => item.textContent === label);
    assert.ok(value, `找不到 ${label} 按钮`); return value;
  }, text: () => text(get("main-context-content")), async poll() { for (const callback of timers.values()) callback(); await settle(); } };
}

const groupView = () => ({ group: { id: "research", name: "研究组", purpose: "核对材料" }, members: [],
  tasks: [{ id: "task-one", goal: "核对共同材料", status: "running", phase: "execution", children: [] }],
  messages: [], materials: [], artifacts: [], lastSequence: 1 });

test("相同群状态轮询保留停止按钮节点与键盘焦点", async () => {
  let requests = 0;
  const ui = setup({ group: async () => { requests++; return groupView(); } });
  ui.panel.set({ type: "group", groupId: "research", taskId: "task-one" }, { reveal: true }); await settle();
  const focused = ui.button("停止任务"); focused.focus();
  assert.equal(ui.document.activeElement, focused); assert.equal(focused.isConnected, true);
  await ui.poll();
  assert.equal(requests, 2);
  assert.equal(ui.button("停止任务"), focused, "相同状态不应替换用户正在操作的按钮");
  assert.equal(ui.document.activeElement, focused); assert.equal(focused.isConnected, true); ui.panel.reset(null);
});

test("相同制作状态轮询保留导出按钮节点与键盘焦点", async () => {
  let requests = 0;
  const draft = validDraft("核对共同材料"), requirement = { id: "analyst", name: "研究助手", draft };
  const ui = setup({ inspectAgent: async () => { requests++; return { agent: null, architecture: null }; } });
  ui.panel.set({ type: "requirements", agentId: requirement.id, draft, requirement, status: "needs_build", confirmed: true }, { reveal: true }); await settle();
  const focused = ui.button("导出需求 JSON");
  const tools = ui.get("main-context-content").querySelectorAll("details").find((item) => /保存与导出/.test(item.querySelector("summary")?.textContent || ""));
  assert.ok(tools); assert.equal(tools.contains(focused), true); tools.toggle(true); focused.focus();
  assert.equal(ui.document.activeElement, focused);
  await ui.poll();
  assert.equal(requests, 2);
  assert.equal(ui.button("导出需求 JSON"), focused, "相同制作状态不应删除聚焦节点");
  assert.equal(ui.document.activeElement, focused); assert.equal(focused.isConnected, true); ui.panel.reset(null);
});

test("保存与导出展开态跨制作状态更新保留，不串入其他主会话", async () => {
  const draft = validDraft("核对共同材料"), requirement = { id: "analyst", name: "研究助手", draft };
  let snapshot = { agent: null, architecture: null };
  const ui = setup({ inspectAgent: async () => structuredClone(snapshot) });
  const context = { type: "requirements", agentId: requirement.id, draft, requirement, status: "needs_build", confirmed: true };
  const disclosure = () => {
    const value = ui.get("main-context-content").querySelectorAll("details").find((item) => /保存与导出/.test(item.querySelector("summary")?.textContent || ""));
    assert.ok(value); return value;
  };
  ui.panel.set(context, { reveal: true }); await settle();
  const original = disclosure(); original.toggle(true);
  snapshot = { agent: null, architecture: { agentId: requirement.id, name: requirement.name, draft, version: 1,
    candidateHash: "fixture-candidate", status: "designing", delivery: "blocked", summary: "正在设计研究方案", issues: [] } };
  await ui.poll();
  assert.notEqual(disclosure(), original); assert.equal(disclosure().open, true);
  assert.match(ui.text(), /正在设计方案/);
  assert.doesNotMatch(ui.text(), /正在设计研究方案/);
  ui.select("main-two"); ui.panel.reset(context); await settle(); assert.equal(disclosure().open, false);
  ui.select("main-one"); ui.panel.reset(context); await settle(); assert.equal(disclosure().open, true);
  ui.panel.reset(null);
});

test("需求说明在智能体就绪后移除状态段，评估详情和更新报告不进入面板", async () => {
  const draft = validDraft("核对共同材料"), requirement = { id: "analyst", name: "研究助手", draft };
  const detail = "内部评估与运行假设。".repeat(100);
  const architecture = { agentId: requirement.id, name: requirement.name, draft, version: 1, candidateHash: "active-candidate",
    status: "passed", delivery: "ready", summary: detail, issues: [{ description: detail, remedy: detail }] };
  const definition = { ...requirement, mode: "designed", status: "ready", revision: 1,
    architectureRef: { version: architecture.version, candidateHash: architecture.candidateHash } };
  let snapshot = { agent: definition, architecture };
  const ui = setup({ inspectAgent: async () => structuredClone(snapshot) });
  ui.panel.set({ type: "requirements", agentId: requirement.id, draft, requirement, confirmed: true, status: "needs_build" }, { reveal: true });
  await settle();
  assert.equal(ui.panel.capture().context.buildState.status, "ready");
  assert.equal(ui.get("main-context-content").querySelectorAll(".main-context-status").length, 0);
  assert.equal(ui.text().includes(detail), false);
  assert.ok(ui.button("制作智能体"));
  snapshot = { agent: definition, architecture: { ...architecture, version: 2, candidateHash: "failed-update", status: "failed", delivery: "blocked" },
    activeRuntime: { architecture, development: null } };
  await ui.poll();
  assert.equal(ui.panel.capture().context.buildState.updateStatus.status, "failed");
  assert.equal(ui.get("main-context-content").querySelectorAll(".main-context-status").length, 0);
  assert.equal(ui.text().includes(detail), false);
  ui.panel.runtime({ agentId: requirement.id, status: "ready", label: detail });
  assert.equal(ui.get("main-context-content").querySelectorAll(".main-context-status").length, 0);
  ui.panel.reset(null);
});

test("需求说明只显示简短制作进度，失败与待连接不展开内部评估正文", async () => {
  const draft = validDraft("核对共同材料"), requirement = { id: "analyst", name: "研究助手", draft };
  const detail = "内部检查依据与修复建议。".repeat(100);
  let architecture = { agentId: requirement.id, name: requirement.name, draft, version: 1, candidateHash: "fixture-candidate",
    status: "designing", delivery: "blocked", summary: detail, issues: [{ description: detail, remedy: detail }] };
  const ui = setup({ inspectAgent: async () => ({ agent: null, architecture: structuredClone(architecture) }) });
  ui.panel.set({ type: "requirements", agentId: requirement.id, draft, requirement, confirmed: true, status: "needs_build" }, { reveal: true });
  await settle();
  const status = () => ui.get("main-context-content").querySelector(".main-context-status").textContent;
  assert.match(status(), /正在设计/); assert.ok(status().length < 50);
  assert.equal(ui.text().includes(detail), false);
  architecture = { ...architecture, status: "failed" }; await ui.poll();
  assert.match(status(), /查看/); assert.ok(status().length < 50);
  assert.equal(ui.text().includes(detail), false);
  ui.panel.runtime({ agentId: requirement.id, status: "needs_connection", label: detail });
  assert.match(status(), /配置连接/); assert.ok(status().length < 50);
  assert.equal(ui.text().includes(detail), false);
  ui.panel.reset(null);
});

test("群任务状态变化仍更新结果并移除已结束任务的停止按钮", async () => {
  let view = groupView();
  const ui = setup({ group: async () => structuredClone(view) });
  ui.panel.set({ type: "group", groupId: "research", taskId: "task-one" }, { reveal: true }); await settle();
  assert.ok(ui.button("停止任务"));
  view.tasks[0].status = "completed"; view.tasks[0].result = "共同材料已核对"; view.lastSequence++;
  await ui.poll();
  assert.match(ui.text(), /已完成/); assert.match(ui.text(), /共同材料已核对/);
  assert.equal(ui.get("main-context-content").querySelectorAll("button").some((item) => item.textContent === "停止任务"), false);
  ui.panel.reset(null);
});

test("具体任务要求默认折叠，刷新保留展开状态，不展示内部评审长文", async () => {
  const draft = validDraft("处理用户材料");
  draft.taskSpec = { version: 1, items: [{ id: "scale", dimension: "input_scale", content: "每批约五十份，支持分批处理", applicability: "applies" }] };
  const ui = setup({ inspectAgent: async () => ({ agent: null }) });
  ui.panel.set({ type: "requirements", agentId: "agent", draft, confirmed: false, status: "ready" }, { reveal: true });
  const detail = ui.get("main-context-content").querySelectorAll("details").find((item) => item.children[0].textContent.includes("具体任务要求"));
  assert.ok(detail); assert.equal(detail.open, false); assert.match(ui.text(), /每批约五十份/);
  detail.toggle(true);
  ui.panel.runtime({ agentId: "agent", status: "evaluating", label: "不能展示的内部评审长文" });
  const refreshed = ui.get("main-context-content").querySelectorAll("details").find((item) => item.children[0].textContent.includes("具体任务要求"));
  assert.equal(refreshed.open, true); assert.doesNotMatch(ui.text(), /不能展示的内部评审长文/); ui.panel.reset(null);
});

test("架构返需提供继续澄清入口，活动旧版不掩盖更新的返需", async () => {
  const draft = validDraft("处理用户材料"), ui = setup({ inspectAgent: async () => ({ agent: null }) });
  ui.panel.set({ type: "requirements", agentId: "agent", draft, confirmed: false, status: "needs_input" }, { reveal: true });
  ui.panel.runtime({ agentId: "agent", status: "ready", updateStatus: { status: "needs_input", handoff: {
    id: "handoff", issues: [{ question: "需要保留历史结果吗？" }] } } });
  assert.ok(ui.button("继续澄清需求"));
  assert.equal(ui.get("main-context-content").querySelectorAll("button").some((item) => item.textContent === "制作智能体"), false);
  ui.panel.reset(null);
});
