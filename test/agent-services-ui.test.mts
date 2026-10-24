import { applicationApiFixture } from "./helpers/ui-api-fixture.mjs";
import type { ApplicationApi, ServicesResult } from "../public/ui-api-types.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createServiceView } from "../public/agent-services.js";
import { createApplicationApi } from "../public/application-api.js";

function dom() {
  const document: {hidden:boolean;activeElement?:Element;createElement?:(tag:string)=>Element} = { hidden: false };
  class Element {
declare tag: string;
declare className: string;
declare parent: Element | null;
declare type: string;
declare step: string;
declare placeholder: string;
declare readOnly: boolean;
declare autocomplete: string;
    constructor(tag: string) { this.tag = tag; }
    children: Element[] = []; attributes = new Map(); listeners = new Map<string,(event:{type:string;preventDefault():void})=>unknown>(); value = ""; checked = false; hidden = false; disabled = false; textContent = "";
    get parentElement() { return this.parent; }
    append(...nodes: Element[]) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
    replaceChildren(...nodes: Element[]) { for (const node of this.children) node.parent = null; this.children = []; this.append(...nodes); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((node: Element) => node !== this); this.parent = null; }
    setAttribute(name:string,value:string) { this.attributes.set(name, value); }
    addEventListener(name:string,callback:(event:{type:string;preventDefault():void})=>unknown) { this.listeners.set(name, callback); }
    dispatch(name: string) { return this.listeners.get(name)?.({ type: name, preventDefault() {} }); }
    click() { return this.disabled ? undefined : this.dispatch("click"); }
    focus() { document.activeElement = this; }
  }
  document.createElement = (tag: string) => new Element(tag);
  return { document: Object.assign(document, {createElement: document.createElement!}), container: new Element("div") };
}
type ServiceElement = ReturnType<typeof dom>["container"];
const all = (node: ServiceElement): ServiceElement[] => [node, ...node.children.flatMap(all)];
const text = (node: ServiceElement) => all(node).map((item) => item.textContent).join(" ");
const control = (node: ServiceElement, label: string) => all(node).find((item) => item.tag === "button" && item.textContent === label)!;
const data = (): ServicesResult => ({ environment: { managed: { available: true, javascript: { available: true }, python: { available: false } }, docker: { available: false } },
  service: { language: "python", host: "managed", operations: [{ id: "search", title: "查询资料" }] }, deliveryVersion: "v1", workers: [],
  history: [{ deliveryVersion: "v1", active: true }], gateway: { enabled: false, actionIds: [] }, workflowTasks: [] });

function setup(api: Partial<ApplicationApi> = {}) {
  const ui = dom(); let snapshot = data(); const calls: unknown[][] = [];
  const view = createServiceView({ ...ui, schedule: () => 1, unschedule() {}, api: applicationApiFixture({
    services: async () => structuredClone(snapshot), prepareService: async (...args) => calls.push(["prepare", ...args]),
    startService: async (...args) => calls.push(["start", ...args]), ...api,
  }) });
  return { ...ui, view, calls, snapshot: (value: ServicesResult) => { snapshot = value; } };
}

test("运行页面展示真实环境，普通功能不会要求先安装Docker", async () => {
  const ui = setup(); await ui.view.show("agent");
  assert.match(text(ui.container), /Python/); assert.match(text(ui.container), /Docker（可选）/);
  const prepare = all(ui.container).find((item) => item.tag === "button" && item.textContent === "准备环境" && !item.disabled);
  await prepare!.click(); assert.deepEqual(ui.calls[0], ["prepare", "agent", "python", "managed"]);
  await control(ui.container, "启动").click(); assert.deepEqual(ui.calls[1], ["start", "agent", "v1"]); ui.view.hide();
});

test("后台状态更新保留未保存的动作选择和焦点", async () => {
  const ui = setup(); await ui.view.show("agent");
  const checkbox = all(ui.container).find((item) => item.type === "checkbox"); checkbox!.checked = true; checkbox!.focus(); checkbox!.dispatch("change");
  await ui.view.reload();
  assert.equal(all(ui.container).find((item) => item.type === "checkbox"), checkbox); assert.equal(checkbox!.checked, true);
  assert.equal(ui.document.activeElement, checkbox); ui.view.hide();
});

test("接口默认关闭，仅发送选择的动作；一次性令牌离开后清空", async () => {
  const calls: unknown[][] = [], ui = setup({ configureGateway: async (...args: Parameters<ApplicationApi["configureGateway"]>) => { calls.push(args); return { token: "fixture-token" }; } });
  await ui.view.show("agent");
  await control(ui.container, "开启或更新接口").click(); assert.equal(calls.length, 0); assert.match(text(ui.container), /至少一项/);
  const checkbox = all(ui.container).find((item) => item.type === "checkbox"); checkbox!.checked = true; checkbox!.dispatch("change");
  await control(ui.container, "开启或更新接口").click(); assert.deepEqual(calls, [["agent", ["search"], "v1"]]);
  const token = all(ui.container).find((item) => item.type === "password"); assert.equal(token!.value, "fixture-token");
  ui.view.hide(); assert.equal(token!.value, ""); await ui.view.show("agent"); assert.equal(token!.value, ""); ui.view.hide();
});

test("切换智能体后迟到状态不能替换当前面板，迟到令牌不再显示", async () => {
  let release: (value: ServicesResult | PromiseLike<ServicesResult>) => void, tokenRelease: (value: { token?: string | undefined; } | PromiseLike<{ token?: string | undefined; }>) => void;
  const ui = setup({ services: async (id: string) => id === "old" ? new Promise((resolve) => { release = resolve; }) : data(),
    configureGateway: async () => new Promise((resolve) => { tokenRelease = resolve; }) });
  const old = ui.view.show("old"); await ui.view.show("new"); const root = ui.container.children[0]; release!(data()); await old;
  assert.equal(ui.container.children[0], root);
  const checkbox = all(ui.container).find((item) => item.type === "checkbox"); checkbox!.checked = true; checkbox!.dispatch("change");
  const pending = control(ui.container, "开启或更新接口").click(); ui.view.hide(); tokenRelease!({ token: "late-token" }); await pending;
  await ui.view.show("new"); assert.equal(all(ui.container).find((item) => item.type === "password")!.value, ""); ui.view.hide();
});

test("等待输入的流程按字段填写并使用当前版本继续，刷新不丢输入", async () => {
  const calls: Parameters<ApplicationApi["resumeTask"]>[] = [], ui = setup({ resumeTask: async (...args: Parameters<ApplicationApi["resumeTask"]>) => calls.push(args) });
  const snapshot = data(); snapshot.workflowTasks = [{ id: "task", version: 4, status: "waiting_input", waiting: { prompt: "请补充范围", inputSchema: { type: "object", properties: { range: { type: "string", title: "处理范围" } } } } }];
  ui.snapshot(snapshot); await ui.view.show("agent");
  const field = all(ui.container).find((item) => item.tag === "textarea"); field!.value = "最近一周"; field!.focus(); await ui.view.reload();
  assert.equal(field!.value, "最近一周"); assert.equal(ui.document.activeElement, field);
  await all(ui.container).find((item) => item.tag === "form")!.dispatch("submit");
  assert.equal(calls[0]![0], "agent"); assert.equal(calls[0]![1], "task"); assert.deepEqual(calls[0]![2], { range: "最近一周" }); assert.equal(calls[0]![3], 4); ui.view.hide();
});

test("不确定外部结果的流程必须显式核实，重试发送独立resolution", async () => {
  const calls: Parameters<ApplicationApi["resumeTask"]>[] = [], ui = setup({ resumeTask: async (...args: Parameters<ApplicationApi["resumeTask"]>) => calls.push(args) }); const snapshot = data();
  snapshot.workflowTasks = [{ id: "task", version: 7, status: "needs_review", waiting: { stepId: "send", index: 2, outputSchema: { type: "string" } } }];
  ui.snapshot(snapshot); await ui.view.show("agent"); const form = all(ui.container).find((item) => item.tag === "form");
  await form!.dispatch("submit"); assert.equal(calls.length, 0);
  const choice = all(form!).find((item) => item.tag === "select"); choice!.value = "retry"; choice!.dispatch("change"); await form!.dispatch("submit");
  assert.equal(calls[0]![2], undefined); assert.deepEqual(calls[0]![5], { stepId: "send", index: 2, outcome: "retry", explicitlyApproved: true }); ui.view.hide();
});

test("服务API绑定交付版本，撤销和继续流程走约定入口", async () => {
  const calls: (RequestInit & {path:string})[] = []; const api = createApplicationApi(async (path, options) => { calls.push({ path, ...options }); return Response.json({}); });
  await api.startService("a", "delivery"); await api.revokeGateway("a");
  await api.resumeTask("a", "task", undefined, 7, "request", { stepId: "one", index: 0, outcome: "retry", explicitlyApproved: true });
  assert.equal(calls[0]!.path, "/api/agents/a/services/start"); assert.deepEqual(JSON.parse(String(calls[0]!.body)), { deliveryVersion: "delivery" });
  assert.equal(calls[1]!.method, "DELETE"); assert.equal(calls[1]!.path, "/api/agents/a/gateway");
  const resume = JSON.parse(String(calls[2]!.body)); assert.equal("input" in resume, false); assert.equal(resume.expectedVersion, 7); assert.equal(resume.resolution.outcome, "retry");
  await api.configureGateway("a", ["search"], "delivery");
  assert.deepEqual(JSON.parse(String(calls[3]!.body)), { actionIds: ["search"], deliveryVersion: "delivery" });
});
