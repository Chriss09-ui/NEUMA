import type {AttachmentApi,AttachmentViewApi} from "../public/agent-attachments.js";
import type {AttachmentEvent} from "../public/attachment-dom.js";
import type {Material} from "../public/ui-types.js";
interface FixtureEvent {type:string;key?:string;bubbles?:boolean;target?:unknown;defaultPrevented?:boolean;preventDefault?:()=>void;[key:string]:unknown}
import { objectFields } from "../src/runtime/type-boundary.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AgentAttachments, createAgentAttachmentView, MAX_ATTACHMENT_BYTES } from "../public/agent-attachments.js";

const file = (name = "论文.pdf", size = 100) => ({ name, size, type: "application/pdf" });
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error?:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
type FixtureFile=ReturnType<typeof file>;
const descriptor = (id = "material-one", name = "论文.pdf") => ({ id, name, size: 100, mimeType: "application/pdf", kind: "pdf", status: "uploaded" });

test("待发送附件在输入上方，加号菜单保留上传和当前 Agent 材料入口", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const composer = html.match(/<form id="agent-chat-form"[\s\S]*?<\/form>/)?.[0];
  assert.ok(composer);
  const attachments = composer.indexOf('id="agent-attachment-list"'), input = composer.indexOf('id="agent-message"');
  assert.ok(attachments >= 0 && input > attachments);
  const tags = [...composer.matchAll(/<[a-z][\w-]*\b[^>]*>/g)];
  const attribute = (tag: string, key: string) => [...tag.matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/g)].find((match) => match[1] === key)?.[3];
  const element = (id: string) => { const matches = tags.filter(([tag]) => attribute(tag, "id") === id); assert.equal(matches.length, 1); return matches[0]![0]; };
  const toggle = element("agent-attachment-menu-toggle");
  assert.equal(attribute(toggle, "aria-haspopup"), "menu");
  assert.equal(attribute(toggle, "aria-controls"), "agent-attachment-menu");
  assert.equal(attribute(toggle, "aria-expanded"), "false");
  assert.ok(attribute(toggle, "aria-label"));
  assert.equal(attribute(element("agent-attachment-menu"), "role"), "menu");
  assert.match(element("agent-attachment-menu"), /\bhidden\b/);
  assert.equal(attribute(element("agent-attachment-add"), "role"), "menuitem");
  assert.equal(attribute(element("agent-attachment-pick"), "role"), "menuitem");
});

test("上传20MiB和每消息10份材料限制在发请求前校验", async () => {
  let calls = 0;
  const attachments = new AgentAttachments<FixtureFile>({ api: { uploadAttachment: async () => { calls++; return { attachment: descriptor(`material-${calls}`) }; } } });
  await attachments.upload("one", "chat", [file("空.pdf", 0)]);
  await attachments.upload("one", "chat", [file("大.pdf", MAX_ATTACHMENT_BYTES + 1)]);
  await attachments.upload("one", "chat", Array.from({ length: 11 }, () => file()));
  assert.equal(calls, 0);
  await attachments.upload("one", "chat", [file("边界.pdf", MAX_ATTACHMENT_BYTES)]);
  assert.equal(calls, 1);
  assert.deepEqual(attachments.refs("one", "chat"), [{ id: "material-1" }]);
});

test("上传取消后忽略迟到成功，可重试原文件且不污染其他Agent或新对话", async () => {
  const pending = deferred<{attachment:Material}>(); let calls = 0;
  const attachments = new AgentAttachments<FixtureFile>({ api: { uploadAttachment: async () => ++calls === 1 ? pending.promise : { attachment: descriptor() } } });
  const uploading = attachments.upload("one", "old", [file()]);
  const item = attachments.state("one", "old").items[0];
  assert.equal(attachments.blocked("one", "old"), true);
  attachments.cancel("one", "old", item!);
  await attachments.retry("one", "old", item!);
  pending.resolve!({ attachment: descriptor("late-material") }); await uploading;
  assert.deepEqual(attachments.refs("one", "old"), [{ id: "material-one" }]);
  assert.deepEqual(attachments.refs("one", "new"), []);
  assert.deepEqual(attachments.refs("two", "old"), []);
  assert.equal(attachments.material("one", "late-material"), undefined);
});

test("失败材料阻止发送，移除和清理使迟到上传结果失效", async () => {
  const pending = deferred<{attachment:Material}>(); let fail = true;
  const attachments = new AgentAttachments<FixtureFile>({ api: { uploadAttachment: async () => {
    if (fail) throw new Error("上传失败"); return pending.promise;
  } } });
  await attachments.upload("one", "chat", [file()]);
  const item = attachments.state("one", "chat").items[0];
  assert.equal(item!.status, "error"); assert.equal(attachments.blocked("one", "chat"), true);
  fail = false; const retrying = attachments.retry("one", "chat", item!);
  attachments.clear("one"); pending.resolve!({ attachment: descriptor() }); await retrying;
  assert.equal(attachments.material("one", "material-one"), undefined);
  assert.deepEqual(attachments.refs("one", "chat"), []);
});

test("发送消耗当前对话附件，失败恢复去重并保留后续材料", async () => {
  const attachments = new AgentAttachments<FixtureFile>({ api: {} });
  attachments.select("one", "chat", descriptor());
  const refs = attachments.refs("one", "chat"); attachments.consume("one", "chat");
  attachments.select("one", "chat", descriptor("material-two"));
  attachments.restore("one", "chat", refs); attachments.restore("one", "chat", refs);
  assert.deepEqual(attachments.refs("one", "chat"), [{ id: "material-two" }, { id: "material-one" }]);
});

function documentFixture() {
  const nodes = new Map<string,Element>();
  class Events {
    declare parent:Element|null;declare activeElement:Element|null;declare getElementById:(id:string)=>Element;declare createElement:(tag:string)=>Element;
    listeners=new Map<string,unknown[]>();
    addEventListener(type:string,callback:(event:AttachmentEvent<FixtureFile>)=>unknown){this.listeners.set(type,[...(this.listeners.get(type)??[]),callback])}
    dispatchEvent(event:FixtureEvent){event.target??=this;event.preventDefault ||=function(){this.defaultPrevented=true};const pending=(this.listeners.get(event.type)??[]).map(callback=>(callback as (event:FixtureEvent)=>unknown)(event));if(event.bubbles&&this!==document)pending.push((this.parent||document).dispatchEvent(event));return Promise.all(pending)}

  }
  const document = new Events(); document.activeElement = null;
  class Element extends Events {
    declare className:string;declare textContent:string;declare type:string;declare value:string;declare open:boolean;declare tagName:string;declare files:FixtureFile[];declare src:string;declare href:string;declare download:string;declare tabIndex:number;declare alt:string;
    children:Element[] = [];attributes=new Map<string,string>();dataset:Record<string,string>={}; hidden = false; disabled = false;
    classList = { add() {}, remove() {} };
    append(...items:Element[]) { for (const item of items) { item.remove(); item.parent = this; this.children.push(item); } }
    remove() { if (this.parent) { this.parent.children = this.parent.children.filter((item:Element) => item !== this); this.parent = null; } }
    replaceChildren(...items:Element[]) { for (const child of this.children) child.parent = null; this.children = []; this.append(...items); }
    contains(target:unknown):boolean { return this === target || this.children.some((child) => child.contains(target)); }
    setAttribute(name:string,value:string) { this.attributes.set(name, value); }
    click() { if (!this.disabled) return this.dispatchEvent({ type: "click", bubbles: true }); }
    focus() { if (!this.disabled) { document.activeElement = this; this.dispatchEvent({ type: "focusin", bubbles: true }); } }
    showModal() { this.open = true; } close() { this.open = false; }
  }
  document.getElementById = (id:string) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id)!; };
  document.createElement = (tag: string) => Object.assign(new Element(), { tagName: tag.toUpperCase() });
  const get = document.getElementById;
  get("page-agent").append(get("agent-messages"), get("agent-chat-form"), get("agent-material-dialog"));
  get("agent-chat-form").append(get("agent-attachment-list"), get("agent-attachment-error"), get("agent-message"), get("agent-attachment-input"), get("agent-composer-tools"));
  get("agent-composer-tools").append(get("agent-attachment-menu-toggle"), get("agent-attachment-menu"));
  get("agent-attachment-menu").append(get("agent-attachment-add"), get("agent-attachment-pick"));
  get("agent-material-dialog").append(get("agent-material-list"), get("agent-material-preview"), get("agent-material-feedback"), get("agent-material-name"), get("agent-material-download"), get("agent-material-refresh"), get("agent-material-close"));
  return { document, get, key: async (target:Element,key:string,fields={}) => {
    const event:FixtureEvent = { type: "keydown", key, bubbles: true, ...fields };
    await target.dispatchEvent(event); return event;
  } };
}

type FixtureElement=ReturnType<ReturnType<typeof documentFixture>["get"]>;
type AttachmentView=ReturnType<typeof createAgentAttachmentView<FixtureFile,FixtureElement>>;
const attachmentNodes = (node:FixtureElement):FixtureElement[] => [node, ...node.children.flatMap(attachmentNodes)];
const attachmentText = (node:FixtureElement):string => [node.textContent || "", ...node.children.map(attachmentText)].join(" ");

function menuFixture(api:AttachmentApi<FixtureFile>&AttachmentViewApi={}) {
  const fixture = documentFixture(); let view:AttachmentView|undefined;
  const attachments = new AgentAttachments<FixtureFile>({ api, onChange: () => view?.render() });
  view = createAgentAttachmentView({ document: fixture.document, api, attachments });
  view.setContext({ agentId: "one", conversationId: "chat", disabled: false });
  return { ...fixture, attachments, view };
}

test("加号选择本地文件关闭菜单并触发原上传输入，上传仍属于当前 Agent 和对话", async () => {
  const calls: ((unknown[]))[] = [], ui = menuFixture({ uploadAttachment: async (agentId: unknown, selected: unknown) => {
    calls.push([agentId, selected]); return { attachment: descriptor() };
  } });
  let chooserClicks = 0;
  ui.get("agent-attachment-input").addEventListener("click", () => chooserClicks++);
  await ui.get("agent-attachment-menu-toggle").click();
  assert.equal(ui.get("agent-attachment-menu").hidden, false);
  assert.equal(ui.get("agent-attachment-menu-toggle").attributes.get("aria-expanded"), "true");
  assert.equal(ui.document.activeElement, ui.get("agent-attachment-add"));
  await ui.get("agent-attachment-add").click();
  assert.equal(chooserClicks, 1);
  assert.equal(ui.get("agent-attachment-menu").hidden, true);
  assert.equal(ui.get("agent-attachment-menu-toggle").attributes.get("aria-expanded"), "false");
  assert.equal(ui.document.activeElement, ui.get("agent-attachment-menu-toggle"));
  const selected = file(); ui.get("agent-attachment-input").files = [selected];
  await ui.get("agent-attachment-input").dispatchEvent({ type: "change", bubbles: true });
  assert.deepEqual(calls, [["one", selected]]);
  assert.deepEqual(ui.attachments.refs("one", "chat"), [{ id: "material-one" }]);
  assert.match(attachmentText(ui.get("agent-attachment-list")), /论文\.pdf/);
});

test("加号的材料选择只读取当前 Agent，选择和关闭材料库返回可见加号", async () => {
  const reads: ((unknown))[] = [], ui = menuFixture({ listAttachments: async (agentId: unknown) => {
    reads.push(agentId); return { attachments: [descriptor(`${agentId}-material`, `${agentId}.pdf`)] };
  } });
  await ui.get("agent-attachment-menu-toggle").click(); await ui.get("agent-attachment-pick").click();
  assert.equal(ui.get("agent-attachment-menu").hidden, true);
  assert.equal(ui.get("agent-material-dialog").open, true);
  assert.equal(ui.get("agent-material-list").children[0]!.children[0]!.textContent, "one.pdf");
  await ui.get("agent-material-list").children[0]!.children[1]!.click();
  assert.deepEqual(ui.attachments.refs("one", "chat"), [{ id: "one-material" }]);
  assert.equal(ui.document.activeElement, ui.get("agent-attachment-menu-toggle"));
  ui.view.setContext({ agentId: "two", conversationId: "other", disabled: false });
  await ui.get("agent-attachment-menu-toggle").click(); await ui.get("agent-attachment-pick").click();
  assert.deepEqual(reads, ["one", "two"]);
  assert.equal(ui.get("agent-material-list").children[0]!.children[0]!.textContent, "two.pdf");
  assert.equal(ui.attachments.material("two", "one-material"), undefined);
  const cancelled:FixtureEvent = { type: "cancel" }; await ui.get("agent-material-dialog").dispatchEvent(cancelled);
  assert.equal(cancelled.defaultPrevented, true);
  assert.equal(ui.get("agent-material-dialog").open, false);
  assert.equal(ui.document.activeElement, ui.get("agent-attachment-menu-toggle"));
  assert.deepEqual(ui.attachments.refs("two", "other"), []);
});

test("加号菜单支持方向键循环和首尾定位，Esc 返回加号且不传递关闭动作", async () => {
  const ui = menuFixture(), toggle = ui.get("agent-attachment-menu-toggle"), add = ui.get("agent-attachment-add"), pick = ui.get("agent-attachment-pick");
  toggle.focus(); assert.equal((await ui.key(toggle, "ArrowDown")).defaultPrevented, true);
  assert.equal(ui.document.activeElement, add);
  await ui.key(add, "ArrowUp"); assert.equal(ui.document.activeElement, pick);
  await ui.key(pick, "ArrowDown"); assert.equal(ui.document.activeElement, add);
  await ui.key(add, "End"); assert.equal(ui.document.activeElement, pick);
  await ui.key(pick, "Home"); assert.equal(ui.document.activeElement, add);
  assert.equal((await ui.key(add, "Escape")).defaultPrevented, true);
  assert.equal(ui.get("agent-attachment-menu").hidden, true);
  assert.equal(ui.document.activeElement, toggle);
  await ui.key(toggle, "ArrowUp"); assert.equal(ui.document.activeElement, pick);
  await toggle.click(); assert.equal(ui.get("agent-attachment-menu").hidden, true);
  assert.equal(ui.document.activeElement, toggle);
});

test("外部点击、焦点离开和 Tab 关闭菜单，不阻止正常移焦或抢回加号", async () => {
  const ui = menuFixture(), toggle = ui.get("agent-attachment-menu-toggle"), menu = ui.get("agent-attachment-menu"), input = ui.get("agent-message");
  await toggle.click();
  await input.click();
  assert.equal(menu.hidden, true);
  await toggle.click(); input.focus();
  assert.equal(menu.hidden, true); assert.equal(ui.document.activeElement, input);
  await toggle.click();
  assert.notEqual((await ui.key(ui.get("agent-attachment-add"), "Tab")).defaultPrevented, true);
  input.focus(); assert.equal(menu.hidden, true); assert.equal(ui.document.activeElement, input);
  await toggle.click();
  assert.notEqual((await ui.key(ui.get("agent-attachment-add"), "Tab", { shiftKey: true })).defaultPrevented, true);
  input.focus(); assert.equal(ui.document.activeElement, input);
});

test("切 Agent 或新对话关闭菜单和材料库，保留外部焦点且不混入旧材料", async () => {
  const ui = menuFixture({ listAttachments: async () => ({ attachments: [descriptor()] }) });
  await ui.get("agent-attachment-menu-toggle").click();
  ui.view.setContext({ agentId: "one", conversationId: "new", disabled: false });
  assert.equal(ui.get("agent-attachment-menu").hidden, true);
  await ui.get("agent-attachment-menu-toggle").click(); await ui.get("agent-attachment-pick").click();
  ui.get("agent-message").focus();
  ui.view.setContext({ agentId: "two", conversationId: "chat", disabled: false });
  assert.equal(ui.get("agent-material-dialog").open, false);
  assert.equal(ui.get("agent-attachment-menu").hidden, true);
  assert.equal(ui.document.activeElement, ui.get("agent-message"));
  assert.deepEqual(ui.attachments.refs("two", "chat"), []);
  assert.equal(ui.get("agent-attachment-menu-toggle").disabled, false);
});

test("禁用或达到十份材料立即关闭菜单并同步禁用入口，移除后恢复且空上下文不留旧附件", async () => {
  const ui = menuFixture(), toggle = ui.get("agent-attachment-menu-toggle"), add = ui.get("agent-attachment-add"), pick = ui.get("agent-attachment-pick");
  await toggle.click();
  ui.view.setContext({ agentId: "one", conversationId: "chat", disabled: true });
  assert.equal(ui.get("agent-attachment-menu").hidden, true);
  assert.equal(toggle.disabled, true); assert.equal(add.disabled, true); assert.equal(pick.disabled, true);
  ui.view.setContext({ agentId: "one", conversationId: "chat", disabled: false });
  assert.equal(toggle.disabled, false); assert.equal(add.disabled, false); assert.equal(pick.disabled, false);
  await toggle.click();
  ui.attachments.restore("one", "chat", Array.from({ length: 10 }, (_unused, index) => ({ id: `saved-${index}` })));
  assert.equal(ui.get("agent-attachment-menu").hidden, true);
  assert.equal(toggle.disabled, true); assert.equal(add.disabled, true); assert.equal(pick.disabled, true);
  assert.equal(ui.document.activeElement, ui.get("agent-message"));
  await toggle.click(); assert.equal(ui.get("agent-attachment-menu").hidden, true);
  ui.attachments.remove("one", "chat", ui.attachments.state("one", "chat").items[0]!);
  assert.equal(toggle.disabled, false); assert.equal(add.disabled, false); assert.equal(pick.disabled, false);
  ui.view.setContext(null);
  assert.equal(toggle.disabled, true); assert.equal(ui.get("agent-attachment-list").hidden, true);
  assert.equal(ui.get("agent-attachment-list").children.length, 0);
});

test("材料选择达到十份后加号不可用，关闭文件库返回可用输入框", async () => {
  const ui = menuFixture({ listAttachments: async () => ({ attachments: [descriptor()] }) });
  ui.attachments.restore("one", "chat", Array.from({ length: 9 }, (_unused, index) => ({ id: `saved-${index}` })));
  await ui.get("agent-attachment-menu-toggle").click(); await ui.get("agent-attachment-pick").click();
  await ui.get("agent-material-list").children[0]!.children[1]!.click();
  assert.equal(ui.attachments.refs("one", "chat").length, 10);
  assert.equal(ui.get("agent-attachment-menu-toggle").disabled, true);
  assert.equal(ui.get("agent-material-dialog").open, false);
  assert.equal(ui.document.activeElement, ui.get("agent-message"));
});

test("待发送材料使用文件卡片，显示真实类型大小且上传取消操作独立可用", async () => {
  const { document, get } = documentFixture(), pending = deferred<{attachment:Material}>();
  let view:AttachmentView|undefined;
  const api:AttachmentApi<FixtureFile>&AttachmentViewApi = { uploadAttachment: async () => pending.promise };
  const attachments = new AgentAttachments<FixtureFile>({ api, onChange: () => view?.render() });
  view = createAgentAttachmentView({ document, api, attachments });
  view.setContext({ agentId: "one", conversationId: "chat", disabled: false });
  const uploading = attachments.upload("one", "chat", [file("待分析.pdf", 512)]);
  const card = get("agent-attachment-list").children[0];
  assert.match(card!.className, /attachment-card/);
  assert.match(attachmentText(card!), /待分析\.pdf/); assert.match(attachmentText(card!), /PDF/);
  assert.match(attachmentText(card!), /512\s*(?:B|bytes|字节)/);
  const actions = attachmentNodes(card!).find((node) => node.className.includes("attachment-card-actions"));
  assert.ok(actions);
  const cancel = actions.children.find((node) => node.textContent.includes("取消"));
  assert.equal(cancel!.tagName, "BUTTON"); cancel!.click();
  assert.equal(attachments.state("one", "chat").items[0]!.status, "cancelled");
  assert.match(attachmentText(get("agent-attachment-list")), /上传已取消/);
  pending.resolve!({ attachment: descriptor() }); await uploading;
  assert.equal(attachments.refs("one", "chat").length, 0);
});

test("同Agent材料选择和只读预览忽略切换后的迟到列表与正文", async () => {
  const pending = deferred<{attachments:Material[]}>(), body = deferred<{text:string;nextOffset:number|null}>(), { document, get } = documentFixture();
  const attachments = new AgentAttachments<FixtureFile>({ api: {} });
  const api = { listAttachments: async () => pending.promise, getAttachment: async () => ({ attachment: { ...descriptor(), kind: "document", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } }),
    previewAttachment: async () => body.promise, attachmentRawUrl: (id: unknown, material: unknown) => `/api/agents/${id}/attachments/${material}/raw` };
  const view = createAgentAttachmentView({ document, api, attachments });
  view.setContext({ agentId: "one", conversationId: "chat", disabled: false });
  const listing = get("agent-attachment-pick").click();
  view.setContext({ agentId: "two", conversationId: "chat", disabled: false });
  pending.resolve!({ attachments: [descriptor()] }); await listing;
  assert.equal(get("agent-material-list").children.length, 0);
  assert.equal(attachments.material("two", "material-one"), undefined);
  view.setContext({ agentId: "one", conversationId: "chat", disabled: false });
  const previewing = view.showPreview("one", "material-one"); await new Promise(setImmediate);
  view.setContext({ agentId: "one", conversationId: "other", disabled: false });
  body.resolve!({ text: "迟到私有正文", nextOffset: null }); await previewing;
  assert.equal(get("agent-material-preview").children.length, 0);
  assert.equal(get("agent-material-dialog").open, false);
});

test("PDF使用有界页图分页，不嵌入受CSP限制的原文件，关闭释放预览URL", async () => {
  const { document, get } = documentFixture(), requested: ((unknown))[] = [], revoked: ((string))[] = [];
  const attachment = descriptor(), attachments = new AgentAttachments<FixtureFile>({ api: {} });
  attachments.remember("one", attachment);
  const api:AttachmentViewApi = { readAttachmentImage: async (_agent, _id, page=1) => {
    requested.push(page); return { blob: new Blob(["fixture"]), page, pageCount: 2 };
  }, attachmentRawUrl: () => "/raw?download=1" };
  let created = 0;
  const view = createAgentAttachmentView({ document, api, attachments,
    urlApi: { createObjectURL: () => `blob:fixture-${++created}`, revokeObjectURL: (url) => revoked.push(url) } });
  view.setContext({ agentId: "one", conversationId: "chat", disabled: false });
  const trigger = document.createElement("button"); get("agent-messages").append(trigger); trigger.focus();
  await view.showPreview("one", attachment.id);
  const first = get("agent-material-preview").children;
  assert.equal(first[0]!.children[0]!.disabled, true);
  assert.equal(first[0]!.children[1]!.textContent, "第 1 / 2 页");
  assert.equal(first[1]!.tagName, "IMG"); assert.equal(first[1]!.src, "blob:fixture-1");
  assert.equal(first.some((node) => node.tagName === "IFRAME"), false);
  first[0]!.children[2]!.focus(); await first[0]!.children[2]!.click();
  const second = get("agent-material-preview").children;
  assert.equal(second[0]!.children[2]!.disabled, true);
  assert.equal(second[0]!.children[1]!.textContent, "第 2 / 2 页");
  assert.deepEqual(requested, [1, 2]); assert.deepEqual(revoked, ["blob:fixture-1"]);
  assert.equal(document.activeElement, second[0]!.children[0]);
  await get("agent-material-close").click();
  assert.deepEqual(revoked, ["blob:fixture-1", "blob:fixture-2"]);
  assert.equal(document.activeElement, trigger);
});

test("切换对话后的迟到PDF页图不创建URL或进入新预览", async () => {
  const { document, get } = documentFixture(), pending = deferred<{blob:Blob;page:number;pageCount:number}>(); let created = 0;
  const attachments = new AgentAttachments<FixtureFile>({ api: {} }); attachments.remember("one", descriptor());
  const view = createAgentAttachmentView({ document, attachments,
    api: { readAttachmentImage: async () => pending.promise, attachmentRawUrl: () => "/raw?download=1" },
    urlApi: { createObjectURL: () => { created++; return "blob:fixture"; }, revokeObjectURL() {} } });
  view.setContext({ agentId: "one", conversationId: "old", disabled: false });
  const reading = view.showPreview("one", "material-one");
  view.setContext({ agentId: "one", conversationId: "new", disabled: false });
  pending.resolve!({ blob: new Blob(["fixture"]), page: 1, pageCount: 1 }); await reading;
  assert.equal(created, 0); assert.equal(get("agent-material-preview").children.length, 0);
});
