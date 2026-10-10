import test from "node:test";
import assert from "node:assert/strict";
import { renderRuntimePorts, renderRuntimeProjects } from "../public/runtime-view.js";

function dom(t) {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.events = {}; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, handler) { this.events[name] = handler; }
    descendants() { return this.children.flatMap((child) => [child, ...child.descendants()]); }
    text() { return [this.textContent, ...this.children.map((child) => child.text())].join(" "); }
  }
  const previous = globalThis.document;
  globalThis.document = { createElement: (tag) => new Element(tag) };
  t.after(() => { globalThis.document = previous; });
  return new Element("div");
}

test("运行筛选保留待确认与外部启动的区别，项目链接打开正确记录", (t) => {
  const container = dom(t), selected = [];
  const projects = [
    { id: "external", name: "已打开的工具", path: "/apps/tool", runtime: { state: "running", source: "external", ports: [5173] } },
    { id: "managed", name: "托管工具", path: "/apps/managed", runtime: { state: "running", source: "nuema", reason: "由 NUEMA 启动的项目进程仍在运行。", ports: [3001] } },
    { id: "stopped", name: "已关闭的工具", path: "/apps/other", runtime: { state: "stopped", source: "none", ports: [] } },
    { id: "unknown", name: "无法核实的工具", path: "/apps/unknown", runtime: { state: "unknown", reason: "进程信息读取不完整" } },
  ];
  renderRuntimeProjects({ container, projects, filter: "running", onSelect: (id) => selected.push(id) });
  assert.match(container.text(), /已打开的工具.*运行中.*外部启动.*5173/);
  assert.match(container.text(), /托管工具.*运行中.*NEUMA 启动.*由 NEUMA 启动/);
  assert.doesNotMatch(container.text(), /NUEMA/);
  assert.doesNotMatch(container.text(), /已关闭的工具|无法核实的工具/);
  container.descendants().find((element) => element.tag === "button").events.click();
  assert.deepEqual(selected, ["external"]);
  renderRuntimeProjects({ container, projects, filter: "unknown", onSelect() {} });
  assert.match(container.text(), /无法核实的工具.*待确认.*进程信息读取不完整/);
  assert.doesNotMatch(container.text(), /未运行/);
});

test("端口可按进程、关联项目和端口搜索，IPv6 原样展示", (t) => {
  const container = dom(t);
  const ports = [
    { port: 5173, pid: 81, protocol: "TCP", processName: "Node", address: "[::1]", projects: [{ id: "p", name: "开发工具" }] },
    { port: 8765, pid: 92, protocol: "TCP", processName: "Python", address: "127.0.0.1", projects: [] },
  ];
  for (const query of ["node", "开发工具", "5173"]) {
    assert.equal(renderRuntimePorts({ container, ports, query, onSelect() {} }), 1);
    assert.match(container.text(), /5173.*Node.*\[::1\].*开发工具/);
    assert.doesNotMatch(container.text(), /8765/);
  }
  assert.equal(renderRuntimePorts({ container, ports, query: "没有这个进程", onSelect() {} }), 0);
  assert.match(container.text(), /没有匹配的端口/);
});
