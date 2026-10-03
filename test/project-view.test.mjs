import test from "node:test";
import assert from "node:assert/strict";
import { renderProjectDetails, updateProjectStatus } from "../public/project-view.js";

function render(t, project) {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.attributes = {}; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener() {}
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

test("到时暂停显示继续检查，保留已登记项目且不允许直接启动", (t) => {
  const ui = render(t, { ...project, canLaunch: false, allowLaunch: false,
    setup: { status: "paused", summary: "检查已进行 5 分钟，已暂停。" } });
  const inspect = ui.container.querySelectorAll("button").find((button) => button.dataset.projectAction === "inspect");
  assert.equal(inspect.textContent, "继续检查"); assert.equal(inspect.disabled, false); assert.equal(ui.start.disabled, true);
  assert.ok(ui.container.querySelectorAll("strong").some((element) => element.textContent === "检查已暂停"));
});
