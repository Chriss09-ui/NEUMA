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
  assert.match(ui.text(), /正在设计研究方案/);
  ui.select("main-two"); ui.panel.reset(context); await settle(); assert.equal(disclosure().open, false);
  ui.select("main-one"); ui.panel.reset(context); await settle(); assert.equal(disclosure().open, true);
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
