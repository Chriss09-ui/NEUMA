import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AgentAttachments, createAgentAttachmentView, MAX_ATTACHMENT_BYTES } from "../public/agent-attachments.js";

const file = (name = "论文.pdf", size = 100) => ({ name, size, type: "application/pdf" });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const descriptor = (id = "material-one", name = "论文.pdf") => ({ id, name, size: 100, mimeType: "application/pdf", kind: "pdf", status: "uploaded" });

test("待发送附件在任务文字输入上方，并保留独立的上传及材料选择操作", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const composer = html.match(/<form id="agent-chat-form"[\s\S]*?<\/form>/)?.[0];
  assert.ok(composer);
  const attachments = composer.indexOf('id="agent-attachment-list"'), input = composer.indexOf('id="agent-message"');
  assert.ok(attachments >= 0 && input > attachments);
  assert.match(composer, /id="agent-attachment-add"/); assert.match(composer, /id="agent-attachment-pick"/);
});

test("上传50MiB和每消息10份材料限制在发请求前校验", async () => {
  let calls = 0;
  const attachments = new AgentAttachments({ api: { uploadAttachment: async () => { calls++; return { attachment: descriptor(`material-${calls}`) }; } } });
  await attachments.upload("one", "chat", [file("空.pdf", 0)]);
  await attachments.upload("one", "chat", [file("大.pdf", MAX_ATTACHMENT_BYTES + 1)]);
  await attachments.upload("one", "chat", Array.from({ length: 11 }, () => file()));
  assert.equal(calls, 0);
  await attachments.upload("one", "chat", [file("边界.pdf", MAX_ATTACHMENT_BYTES)]);
  assert.equal(calls, 1);
  assert.deepEqual(attachments.refs("one", "chat"), [{ id: "material-1" }]);
});

test("上传取消后忽略迟到成功，可重试原文件且不污染其他Agent或新对话", async () => {
  const pending = deferred(); let calls = 0;
  const attachments = new AgentAttachments({ api: { uploadAttachment: async () => ++calls === 1 ? pending.promise : { attachment: descriptor() } } });
  const uploading = attachments.upload("one", "old", [file()]);
  const item = attachments.state("one", "old").items[0];
  assert.equal(attachments.blocked("one", "old"), true);
  attachments.cancel("one", "old", item);
  await attachments.retry("one", "old", item);
  pending.resolve({ attachment: descriptor("late-material") }); await uploading;
  assert.deepEqual(attachments.refs("one", "old"), [{ id: "material-one" }]);
  assert.deepEqual(attachments.refs("one", "new"), []);
  assert.deepEqual(attachments.refs("two", "old"), []);
  assert.equal(attachments.material("one", "late-material"), undefined);
});

test("失败材料阻止发送，移除和清理使迟到上传结果失效", async () => {
  const pending = deferred(); let fail = true;
  const attachments = new AgentAttachments({ api: { uploadAttachment: async () => {
    if (fail) throw new Error("上传失败"); return pending.promise;
  } } });
  await attachments.upload("one", "chat", [file()]);
  const item = attachments.state("one", "chat").items[0];
  assert.equal(item.status, "error"); assert.equal(attachments.blocked("one", "chat"), true);
  fail = false; const retrying = attachments.retry("one", "chat", item);
  attachments.clear("one"); pending.resolve({ attachment: descriptor() }); await retrying;
  assert.equal(attachments.material("one", "material-one"), undefined);
  assert.deepEqual(attachments.refs("one", "chat"), []);
});

test("发送消耗当前对话附件，失败恢复去重并保留后续材料", async () => {
  const attachments = new AgentAttachments({ api: {} });
  attachments.select("one", "chat", descriptor());
  const refs = attachments.refs("one", "chat"); attachments.consume("one", "chat");
  attachments.select("one", "chat", descriptor("material-two"));
  attachments.restore("one", "chat", refs); attachments.restore("one", "chat", refs);
  assert.deepEqual(attachments.refs("one", "chat"), [{ id: "material-two" }, { id: "material-one" }]);
});

function documentFixture() {
  const nodes = new Map();
  const document = { activeElement: null };
  class Element {
    children = []; listeners = new Map(); attributes = new Map(); dataset = {}; hidden = false; disabled = false;
    classList = { add() {}, remove() {} };
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    click() { return this.listeners.get("click")?.({}); }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; } close() { this.open = false; }
  }
  document.getElementById = (id) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  document.createElement = (tag) => Object.assign(new Element(), { tagName: tag.toUpperCase() });
  return { document, get: document.getElementById };
}

const attachmentNodes = (node) => [node, ...node.children.flatMap(attachmentNodes)];
const attachmentText = (node) => [node.textContent || "", ...node.children.map(attachmentText)].join(" ");

test("待发送材料使用文件卡片，显示真实类型大小且上传取消操作独立可用", async () => {
  const { document, get } = documentFixture(), pending = deferred();
  let view;
  const api = { uploadAttachment: async () => pending.promise };
  const attachments = new AgentAttachments({ api, onChange: () => view?.render() });
  view = createAgentAttachmentView({ document, api, attachments });
  view.setContext({ agentId: "one", conversationId: "chat", disabled: false });
  const uploading = attachments.upload("one", "chat", [file("待分析.pdf", 512)]);
  const card = get("agent-attachment-list").children[0];
  assert.match(card.className, /attachment-card/);
  assert.match(attachmentText(card), /待分析\.pdf/); assert.match(attachmentText(card), /PDF/);
  assert.match(attachmentText(card), /512\s*(?:B|bytes|字节)/);
  const actions = attachmentNodes(card).find((node) => node.className.includes("attachment-card-actions"));
  assert.ok(actions);
  const cancel = actions.children.find((node) => node.textContent.includes("取消"));
  assert.equal(cancel.tagName, "BUTTON"); cancel.click();
  assert.equal(attachments.state("one", "chat").items[0].status, "cancelled");
  assert.match(attachmentText(get("agent-attachment-list")), /上传已取消/);
  pending.resolve({ attachment: descriptor() }); await uploading;
  assert.equal(attachments.refs("one", "chat").length, 0);
});

test("同Agent材料选择和只读预览忽略切换后的迟到列表与正文", async () => {
  const pending = deferred(), body = deferred(), { document, get } = documentFixture();
  const attachments = new AgentAttachments({ api: {} });
  const api = { listAttachments: async () => pending.promise, getAttachment: async () => ({ attachment: { ...descriptor(), kind: "document", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } }),
    previewAttachment: async () => body.promise, attachmentRawUrl: (id, material) => `/api/agents/${id}/attachments/${material}/raw` };
  const view = createAgentAttachmentView({ document, api, attachments });
  view.setContext({ agentId: "one", conversationId: "chat", disabled: false });
  const listing = get("agent-attachment-pick").click();
  view.setContext({ agentId: "two", conversationId: "chat", disabled: false });
  pending.resolve({ attachments: [descriptor()] }); await listing;
  assert.equal(get("agent-material-list").children.length, 0);
  assert.equal(attachments.material("two", "material-one"), undefined);
  view.setContext({ agentId: "one", conversationId: "chat", disabled: false });
  const previewing = view.showPreview("one", "material-one"); await new Promise(setImmediate);
  view.setContext({ agentId: "one", conversationId: "other", disabled: false });
  body.resolve({ text: "迟到私有正文", nextOffset: null }); await previewing;
  assert.equal(get("agent-material-preview").children.length, 0);
  assert.equal(get("agent-material-dialog").open, false);
});

test("PDF使用有界页图分页，不嵌入受CSP限制的原文件，关闭释放预览URL", async () => {
  const { document, get } = documentFixture(), requested = [], revoked = [];
  const attachment = descriptor(), attachments = new AgentAttachments({ api: {} });
  attachments.remember("one", attachment);
  const api = { readAttachmentImage: async (_agent, _id, page) => {
    requested.push(page); return { blob: new Blob(["fixture"]), page, pageCount: 2 };
  }, attachmentRawUrl: () => "/raw?download=1" };
  let created = 0;
  const view = createAgentAttachmentView({ document, api, attachments,
    urlApi: { createObjectURL: () => `blob:fixture-${++created}`, revokeObjectURL: (url) => revoked.push(url) } });
  view.setContext({ agentId: "one", conversationId: "chat", disabled: false });
  get("agent-attachment-add").focus();
  await view.showPreview("one", attachment.id);
  const first = get("agent-material-preview").children;
  assert.equal(first[0].children[0].disabled, true);
  assert.equal(first[0].children[1].textContent, "第 1 / 2 页");
  assert.equal(first[1].tagName, "IMG"); assert.equal(first[1].src, "blob:fixture-1");
  assert.equal(first.some((node) => node.tagName === "IFRAME"), false);
  first[0].children[2].focus(); await first[0].children[2].click();
  const second = get("agent-material-preview").children;
  assert.equal(second[0].children[2].disabled, true);
  assert.equal(second[0].children[1].textContent, "第 2 / 2 页");
  assert.deepEqual(requested, [1, 2]); assert.deepEqual(revoked, ["blob:fixture-1"]);
  assert.equal(document.activeElement, second[0].children[0]);
  await get("agent-material-close").click();
  assert.deepEqual(revoked, ["blob:fixture-1", "blob:fixture-2"]);
  assert.equal(document.activeElement, get("agent-attachment-add"));
});

test("切换对话后的迟到PDF页图不创建URL或进入新预览", async () => {
  const { document, get } = documentFixture(), pending = deferred(); let created = 0;
  const attachments = new AgentAttachments({ api: {} }); attachments.remember("one", descriptor());
  const view = createAgentAttachmentView({ document, attachments,
    api: { readAttachmentImage: async () => pending.promise, attachmentRawUrl: () => "/raw?download=1" },
    urlApi: { createObjectURL: () => { created++; return "blob:fixture"; }, revokeObjectURL() {} } });
  view.setContext({ agentId: "one", conversationId: "old", disabled: false });
  const reading = view.showPreview("one", "material-one");
  view.setContext({ agentId: "one", conversationId: "new", disabled: false });
  pending.resolve({ blob: new Blob(["fixture"]), page: 1, pageCount: 1 }); await reading;
  assert.equal(created, 0); assert.equal(get("agent-material-preview").children.length, 0);
});
