import test from "node:test";
import assert from "node:assert/strict";
import { renderProjectDetails, renderProjectList, updateProjectStatus } from "../public/project-view.js";

function render(t, project) {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = {}; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    contains(element) { return element === this || this.children.some((child) => child.contains(element)); }
    focus() { document.activeElement = this; }
    querySelectorAll(selector) {
      const selectors = selector.split(",").map((item) => item.trim());
      return this.children.flatMap((child) => [child, ...child.querySelectorAll("*")]).filter((child) =>
        selectors.some((value) => value === "*" || value === child.tag || value === `#${child.id}`));
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  }
  const previous = globalThis.document;
  globalThis.document = { createElement: (tag) => new Element(tag) };
  t.after(() => { globalThis.document = previous; });
  const container = new Element("div");
  renderProjectDetails({ container, project, onAction() {}, onConfigure() {} });
  updateProjectStatus(container, project, false);
  return { container, start: container.querySelectorAll("button").find((button) => button.dataset.projectAction === "start"),
    note: container.querySelector("#project-runtime-note") };
}

const project = { id: "fixture", name: "项目", path: "/fixture", kind: "node", allowLaunch: true, canLaunch: true,
  launch: { command: "npm", args: ["run", "dev"] }, status: "stopped", canStop: false, openingPage: false };

test("项目详情始终没有 iframe 或页面链接，打开操作集中在一个按钮", (t) => {
  const ui = render(t, { ...project, status: "running", canStop: true, url: "http://localhost:8765/", pageOpened: true });
  assert.equal(ui.container.querySelector("iframe"), null);
  assert.equal(ui.container.querySelector("a"), null);
  assert.equal(ui.start.textContent, "打开项目"); assert.equal(ui.start.disabled, false);
  assert.match(ui.note.textContent, /项目已打开/);
  const remove = ui.container.querySelectorAll("button").find((button) => button.dataset.projectAction === "remove");
  assert.equal(remove.textContent, "删除项目"); assert.equal(remove.disabled, false);
});

test("等待窗口时禁用重复打开；失败和停止后可直接重试，不出现空白预览区", (t) => {
  const ui = render(t, { ...project, status: "running", canStop: true, openingPage: true });
  assert.equal(ui.start.textContent, "正在打开…"); assert.equal(ui.start.disabled, true);
  assert.match(ui.note.textContent, /自动打开窗口/);
  updateProjectStatus(ui.container, { ...project, status: "running", canStop: true, openError: "窗口打开失败" }, false);
  assert.equal(ui.start.disabled, false); assert.equal(ui.note.textContent, "窗口打开失败");
  updateProjectStatus(ui.container, project, false);
  assert.equal(ui.start.disabled, false); assert.equal(ui.container.querySelector("iframe"), null);
});

test("旧的暂停状态保留重新识别入口，不允许直接启动", (t) => {
  const ui = render(t, { ...project, canLaunch: false, allowLaunch: false,
    setup: { status: "paused", summary: "检查已暂停。" } });
  const inspect = ui.container.querySelectorAll("button").find((button) => button.dataset.projectAction === "inspect");
  assert.equal(inspect.textContent, "重新识别"); assert.equal(inspect.disabled, false); assert.equal(ui.start.disabled, true);
  assert.ok(ui.container.querySelectorAll("strong").some((element) => element.textContent === "检查已暂停"));
});

test("重新识别在配置卡片独立显示，运行时解释禁用原因，检查时阻止重复操作", (t) => {
  const ui = render(t, project);
  const inspect = ui.container.querySelectorAll("button").find((button) => button.dataset.projectAction === "inspect");
  const setup = ui.container.children.find((child) => child.className === "project-setup");
  assert.ok(setup.contains(inspect)); assert.equal(inspect.disabled, false);
  assert.match(ui.container.querySelector("#project-inspect-hint").textContent, /NUEMA/);
  updateProjectStatus(ui.container, { ...project, canStop: true }, false);
  assert.equal(inspect.disabled, true); assert.match(inspect.title, /先停止/);
  updateProjectStatus(ui.container, { ...project, canLaunch: false, setup: { status: "checking" } }, true);
  assert.equal(inspect.textContent, "识别中…"); assert.equal(inspect.disabled, true);
  assert.equal(inspect.attributes["aria-busy"], "true"); assert.equal(ui.start.disabled, true);
  updateProjectStatus(ui.container, project, false);
  assert.equal(inspect.textContent, "重新识别"); assert.equal(inspect.disabled, false);
});

test("列表的重新识别按钮操作对应项目，运行中的项目不可重配", (t) => {
  const ui = render(t, project);
  let inspected, selected;
  renderProjectList({ container: ui.container, projects: [project, { ...project, id: "running", canStop: true }],
    onSelect: (id) => { selected = id; }, onInspect: (id) => { inspected = id; } });
  const buttons = ui.container.querySelectorAll("button").filter((button) => button.dataset.projectInspectId);
  assert.equal(buttons.length, 2); assert.equal(buttons[0].textContent, "重新识别");
  buttons[0].listeners.click(); assert.equal(inspected, project.id); assert.equal(selected, undefined);
  assert.equal(buttons[1].disabled, true); assert.match(buttons[1].title, /先停止/);
});
