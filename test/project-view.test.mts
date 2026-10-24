import test from "node:test";
import assert from "node:assert/strict";
import { renderProjectDetails, renderProjectList, updateProjectStatus } from "../public/project-view.js";

function render(t: test.TestContext, project: { status: string; canStop: boolean; url?: string; pageOpened?: boolean; id: string; name: string; path: string; kind: string; allowLaunch: boolean; canLaunch: boolean; launch: { command: string; args: string[]; }; openingPage: boolean; setup?: { status: string; summary?: string; }; }) {
  class Element {
    declare tag:string;declare children:Element[];declare dataset:Record<string,string>;declare attributes:Record<string,string>;declare listeners:Record<string,(event?:unknown)=>unknown>;declare id:string;declare textContent:string;declare disabled:boolean;declare title:string;declare className:string;
    constructor(tag: string) { this.tag = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = {}; }
    append(...children: unknown[]) { this.children.push(...children as Element[]); }
    replaceChildren(...children: unknown[]) { this.children = children as Element[]; }
    setAttribute(key:string|number,value:string) { this.attributes[key] = value; }
    addEventListener(type: string|number, callback:(event?:unknown)=>unknown) { this.listeners[type] = callback; }
    contains(element:unknown):boolean { return element === this || this.children.some((child) => child.contains(element)); }
    focus() { Reflect.set(globalThis.document,"activeElement",this); }
    querySelectorAll(selector:string):Element[] {
      const selectors = selector.split(",").map((item) => item.trim());
      return this.children.flatMap((child) => [child, ...child.querySelectorAll("*")]).filter((child) =>
        selectors.some((value) => value === "*" || value === child.tag || value === `#${child.id}`));
    }
    querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  }
  const previous = globalThis.document;
  Reflect.set(globalThis,"document",{ createElement: (tag:string) => new Element(tag) });
  t.after(() => { globalThis.document = previous; });
  const container = new Element("div");
  renderProjectDetails({ container, project, onAction() {}, onConfigure() {} });
  updateProjectStatus(container, project, false);
  return { container, start: container.querySelectorAll("button").find((button) => button.dataset.projectAction === "start"),
    note: container.querySelector("#project-runtime-note") };
}

const project = { id: "fixture", name: "项目", path: "/fixture", kind: "node", allowLaunch: true, canLaunch: true,
  launch: { command: "npm", args: ["run", "dev"] }, status: "stopped", canStop: false, openingPage: false };
const addition = { id: "11111111-1111-4111-8111-111111111111", name: "待添加项目", path: "/pending-fixture",
  description: "正在识别启动入口…", status: "adding", cancelRequested: false };
interface TextNode {textContent?:string;children:TextNode[]}
const textOf = (element:TextNode):string => `${element.textContent || ""}${element.children.map(textOf).join("")}`;

test("项目详情始终没有 iframe 或页面链接，打开操作集中在一个按钮", (t) => {
  const ui = render(t, { ...project, status: "running", canStop: true, url: "http://localhost:8765/", pageOpened: true });
  assert.equal(ui.container.querySelector("iframe"), null);
  assert.equal(ui.container.querySelector("a"), null);
  assert.equal(ui.start!.textContent, "打开项目"); assert.equal(ui.start!.disabled, false);
  assert.match(ui.note!.textContent, /项目已打开/);
  const remove = ui.container.querySelectorAll("button").find((button) => button.dataset.projectAction === "remove");
  assert.equal(remove!.textContent, "删除项目"); assert.equal(remove!.disabled, false);
});

test("等待窗口时禁用重复打开；失败和停止后可直接重试，不出现空白预览区", (t) => {
  const ui = render(t, { ...project, status: "running", canStop: true, openingPage: true });
  assert.equal(ui.start!.textContent, "正在打开…"); assert.equal(ui.start!.disabled, true);
  assert.match(ui.note!.textContent, /自动打开窗口/);
  updateProjectStatus(ui.container, { ...project, status: "running", canStop: true, openError: "窗口打开失败" }, false);
  assert.equal(ui.start!.disabled, false); assert.equal(ui.note!.textContent, "窗口打开失败");
  updateProjectStatus(ui.container, project, false);
  assert.equal(ui.start!.disabled, false); assert.equal(ui.container.querySelector("iframe"), null);
});

test("旧的暂停状态保留重新识别入口，不允许直接启动", (t) => {
  const ui = render(t, { ...project, canLaunch: false, allowLaunch: false,
    setup: { status: "paused", summary: "检查已暂停。" } });
  const inspect = ui.container.querySelectorAll("button").find((button) => button.dataset.projectAction === "inspect");
  assert.equal(inspect!.textContent, "重新识别"); assert.equal(inspect!.disabled, false); assert.equal(ui.start!.disabled, true);
  assert.ok(ui.container.querySelectorAll("strong").some((element) => element.textContent === "检查已暂停"));
});

test("重新识别在配置卡片独立显示，运行时解释禁用原因，检查时阻止重复操作", (t) => {
  const ui = render(t, project);
  const inspect = ui.container.querySelectorAll("button").find((button) => button.dataset.projectAction === "inspect");
  const setup = ui.container.children.find((child: { className: string; }) => child.className === "project-setup");
  assert.ok(setup!.contains(inspect)); assert.equal(inspect!.disabled, false);
  assert.match(ui.container.querySelector("#project-inspect-hint")!.textContent, /NEUMA/);
  updateProjectStatus(ui.container, { ...project, canStop: true }, false);
  assert.equal(inspect!.disabled, true); assert.match(inspect!.title, /先停止/);
  updateProjectStatus(ui.container, { ...project, canLaunch: false, setup: { status: "checking" } }, true);
  assert.equal(inspect!.textContent, "识别中…"); assert.equal(inspect!.disabled, true);
  assert.equal(inspect!.attributes["aria-busy"], "true"); assert.equal(ui.start!.disabled, true);
  updateProjectStatus(ui.container, project, false);
  assert.equal(inspect!.textContent, "重新识别"); assert.equal(inspect!.disabled, false);
});

test("列表的重新识别按钮操作对应项目，运行中的项目不可重配", (t) => {
  const ui = render(t, project);
  let inspected, selected;
  renderProjectList({ container: ui.container, projects: [project, { ...project, id: "running", canStop: true }],
    onSelect: (id) => { selected = id; }, onInspect: (id: unknown) => { inspected = id; } });
  const buttons = ui.container.querySelectorAll("button").filter((button) => button.dataset.projectInspectId);
  assert.equal(buttons.length, 2); assert.equal(buttons[0]!.textContent, "重新识别");
  buttons[0]!.listeners.click!(); assert.equal(inspected, project.id); assert.equal(selected, undefined);
  assert.equal(buttons[1]!.disabled, true); assert.match(buttons[1]!.title, /先停止/);
});

test("空正式项目列表仍显示添加条目，查看进度和取消添加是独立动作", (t) => {
  const ui = render(t, project), actions: (("view") | ("cancel") | ("select") | ("inspect") | ("remove"))[] = [];
  renderProjectList({ container: ui.container, projects: [], addition,
    onViewAddition: () => actions.push("view"), onCancelAddition: () => actions.push("cancel"),
    onSelect: () => actions.push("select"), onInspect: () => actions.push("inspect"), onRemove: () => actions.push("remove"), emptyText: "还没有项目" });
  const row = ui.container.children[0], [view, cancel] = row!.querySelectorAll("button");
  assert.match(textOf(row!), /待添加项目/); assert.match(textOf(row!), /正在识别启动入口…/); assert.match(textOf(row!), /添加中…/);
  assert.equal(view!.attributes["aria-busy"], "true"); assert.equal(cancel!.textContent, "取消添加"); assert.equal(cancel!.disabled, false);
  assert.equal(row!.querySelectorAll("button").length, 2);
  view!.listeners.click!(); assert.deepEqual(actions, ["view"]);
  cancel!.listeners.click!(); assert.deepEqual(actions, ["view", "cancel"]);
});

test("添加条目排在正式项目之前，全局忙碌仍可取消，取消请求发出后禁用重复操作", (t) => {
  const ui = render(t, project), actions: (("view") | ("cancel") | ("select") | ("inspect") | ("remove"))[] = [], options = { container: ui.container, projects: [project], busy: true, removeDisabled: true,
    onViewAddition: () => actions.push("view"), onCancelAddition: () => actions.push("cancel"),
    onSelect: () => actions.push("select"), onInspect: () => actions.push("inspect"), onRemove: () => actions.push("remove") };
  renderProjectList({ ...options, addition });
  const [pending, saved] = ui.container.children, [view, cancel] = pending!.querySelectorAll("button");
  assert.match(textOf(pending!), /待添加项目/); assert.equal(saved!.querySelectorAll("button")[0]!.dataset.projectId, project.id);
  assert.equal(cancel!.disabled, false); cancel!.listeners.click!(); assert.deepEqual(actions, ["cancel"]);
  assert.equal(view!.disabled, false); view!.listeners.click!(); assert.deepEqual(actions, ["cancel", "view"]);
  assert.ok(saved!.querySelectorAll("button").every((button: { disabled: unknown; }) => button.disabled));
  cancel!.focus();
  renderProjectList({ ...options, addition: { ...addition, description: "正在核对启动配置…" } });
  const updatedCancel = ui.container.children[0]!.querySelectorAll("button")[1];
  assert.equal(updatedCancel!.dataset.projectAdditionId, addition.id);
  assert.equal(document.activeElement, updatedCancel);
  assert.match(textOf(ui.container.children[0]!), /正在核对启动配置…/);
  renderProjectList({ ...options, addition: { ...addition, cancelRequested: true } });
  const [cancellingView, cancellingAction] = ui.container.children[0]!.querySelectorAll("button");
  assert.match(textOf(cancellingView!), /取消中…/); assert.equal(cancellingView!.attributes["aria-busy"], "true");
  assert.equal(cancellingAction!.textContent, "取消添加"); assert.equal(cancellingAction!.disabled, true);
});

test("添加失败或取消条目可独立重试或移除记录，不触发正式项目识别、删除或选择", (t) => {
  const ui = render(t, project), actions: ((string) | ("cancel") | ("select") | ("inspect") | ("remove"))[] = [];
  for (const [status, label] of [["failed", "添加失败"], ["cancelled", "已取消"]] as const) {
    renderProjectList({ container: ui.container, projects: [], addition: { ...addition, status }, busy: true, removeDisabled: true,
      onViewAddition: () => actions.push(`view-${status}`), onCancelAddition: () => actions.push("cancel"),
      onDismissAddition: () => actions.push(`dismiss-${status}`),
      onSelect: () => actions.push("select"), onInspect: () => actions.push("inspect"), onRemove: () => actions.push("remove") });
    const row = ui.container.children[0], buttons = row!.querySelectorAll("button"), view = buttons[0],
      retry = buttons.find((button: { textContent: string; }) => button.textContent === "重试添加"), dismiss = buttons.find((button: { textContent: string; }) => button.textContent === "移除");
    assert.match(textOf(view!), new RegExp(label)); assert.equal(view!.attributes["aria-busy"], "false");
    assert.equal(buttons.length, 3); assert.ok(retry); assert.ok(dismiss);
    assert.equal(dismiss.className, "project-list-delete"); assert.equal(dismiss.attributes["aria-label"], `移除添加记录 ${addition.name}`);
    assert.equal(view!.disabled, false); assert.equal(retry.disabled, false);
    view!.listeners.click!(); retry.listeners.click!(); dismiss.listeners.click!();
  }
  assert.deepEqual(actions, ["view-failed", "view-failed", "dismiss-failed", "view-cancelled", "view-cancelled", "dismiss-cancelled"]);
});
