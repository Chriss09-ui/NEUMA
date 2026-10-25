import type {Message,StreamEvent,ReplyResult} from "../../public/ui-types.js";
import type {ReplyOptions} from "../../public/chat-ui.js";
import type { TestFailure } from "../helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { addUserMessage, createAttachmentCard, createReplyView, mountWelcome, readReply, recoverInput, renderUserMessage } from "../../public/chat-ui.js";
import { recentUserMessages } from "../../public/state.js";

function streamResponse(parts: Uint8Array<ArrayBuffer>[]) {
  return new Response(new ReadableStream({ start(controller) {
    for (const part of parts) controller.enqueue(part);
    controller.close();
  } }), { headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
}

test("中文流式回复支持跨数据块的 UTF-8 字符和多条事件", async () => {
  const data = new TextEncoder().encode([
    { type: "status", phase: "thinking" }, { type: "text-delta", delta: "你好" },
    { type: "text-delta", delta: "，我可以帮你管理项目。" },
    { type: "done", result: { reply: "你好，我可以帮你管理项目。", projects: [] } },
  ].map((item) => JSON.stringify(item)).join("\r\n"));
  const events: StreamEvent[] = [];
  const result = await readReply(streamResponse(Array.from(data, (byte) => Uint8Array.of(byte))), (event) => events.push(event));
  assert.equal(result.reply, "你好，我可以帮你管理项目。");
  assert.equal(events.filter((event) => event.type === "text-delta").map((event) => event.delta).join(""), "你好，我可以帮你管理项目。");
  assert.equal(events[0]!.phase, "thinking");
});

test("流式错误保留已经收到的文字，取消原因能被界面识别", async () => {
  const events: StreamEvent[] = [], encode = (value: { type: string; delta?: string; error?: string; diagnostic?: { reason: string; }; }) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  await assert.rejects(readReply(streamResponse([
    encode({ type: "text-delta", delta: "已经收到的片段" }),
    encode({ type: "error", error: "已停止", diagnostic: { reason: "cancelled" } }),
  ]), (event) => events.push(event)), (error: TestFailure) => error.reason === "cancelled");
  assert.equal(events[0]!.delta, "已经收到的片段");
});

test("没有完成事件的断流不能被误报为回复成功", async () => {
  const part = new TextEncoder().encode('{"type":"text-delta","delta":"部分回复"}\n');
  await assert.rejects(readReply(streamResponse([part]), () => {}), /回复尚未完成/);
  await assert.rejects(readReply(streamResponse([new TextEncoder().encode('{broken\n')]), () => {}), /回复数据不完整/);
});

test("保持兼容旧版 JSON 回复与安全错误", async () => {
  assert.equal((await readReply(Response.json({ reply: "完整回复" }), () => {})).reply, "完整回复");
  await assert.rejects(readReply(Response.json({ error: "未配置模型" }, { status: 502 }), () => {}), /未配置模型/);
});

test("调用方可区分需求断流提示，并读取后端安全诊断", async () => {
  await assert.rejects(readReply(streamResponse([]), () => {}, { incompleteMessage: "需求回复尚未完成" }), /需求回复尚未完成/);
  await assert.rejects(readReply(Response.json({ error: "回复失败", diagnostic: { reason: "upstream_error", stage: "reply" } }, { status: 502 }), () => {}),
    (error: TestFailure) => error.diagnostic!.reason === "upstream_error" && error.diagnostic!.stage === "reply");
});

test("自动配置的完成事件按项目结果判断，无需聊天 reply，断流仍报错", async () => {
  const encode = (event: { type: string; result: { project: { id: string; canLaunch: boolean; }; }; }) => new TextEncoder().encode(`${JSON.stringify(event)}\n`);
  const options:ReplyOptions<ReplyResult & {project:{id:string;canLaunch:boolean}}> = { isComplete: (result) => typeof result?.project?.id === "string", incompleteMessage: "项目检查连接中断" };
  const part = encode({ type: "done", result: { project: { id: "fixture", canLaunch: true } } });
  const result = await readReply(streamResponse([part]), () => {}, options);
  assert.equal(result.project.canLaunch, true);
  await assert.rejects(Reflect.apply(readReply, undefined, [streamResponse([]), () => {}, options]), /项目检查连接中断/);
  await assert.rejects(readReply(streamResponse([part]), () => {}), /回复尚未完成/);
});

test("发送立即加入用户消息，失败重发复用原消息且不污染模型上下文", () => {
  const messages:Message[] = [{ role: "user", content: "上一轮", delivery: "sent" }];
  const user = addUserMessage(messages, "当前问题");
  assert.equal(messages.at!(-1)!.content, "当前问题");
  assert.deepEqual(recentUserMessages(messages), ["上一轮"]);
  user.delivery = "failed";
  messages.push({ role: "assistant", content: "部分输出", status: "error" });
  assert.equal(addUserMessage(messages, "当前问题"), user);
  assert.equal(messages.length, 2);
  user.delivery = "sent";
  assert.deepEqual(recentUserMessages(messages), ["上一轮", "当前问题"]);
});

test("重新编辑失败消息不会覆盖已经输入的下一条草稿", () => {
  const input = { value: "下一条草稿", dispatchEvent() {}, focus() {} };
  recoverInput(input, "失败消息");
  assert.equal(input.value, "下一条草稿\n\n失败消息");
});

test("首条消息发出即移除欢迎区，失败也不恢复，开启空白新对话后才重新显示", () => {
  const container = { children: [] as unknown[], append(child: unknown) { this.children.push(child); } };
  const welcome = { title: "欢迎标题", suggestions: ["快捷入口"] };
  const messages:Message[] = [];
  const render = () => {
    container.children = [];
    mountWelcome(container, welcome, messages.length > 0);
    container.children.push(...messages);
  };
  render();
  assert.deepEqual(container.children, [welcome]);
  const user = addUserMessage(messages, "第一条需求");
  for (const delivery of ["pending", "sent", "failed", "stopped"]) {
    user.delivery = delivery;
    render();
    assert.deepEqual(container.children, [user]);
  }
  messages.length = 0;
  render();
  assert.deepEqual(container.children, [welcome]);
});

test("仅附件发送和失败重试复用同一组材料，不混淆相同文字的其他附件", () => {
  const messages:Message[] = [], refs = [{ id: "material-one" }];
  const user = addUserMessage(messages, "", refs); user.delivery = "failed";
  messages.push({ role: "assistant", content: "", status: "error" });
  assert.equal(addUserMessage(messages, "", refs), user);
  assert.deepEqual(user.attachments, refs);
  user.delivery = "failed";
  const other = addUserMessage(messages, "", [{ id: "material-two" }]);
  assert.notEqual(other, user);
});

function messageDocument(t: test.TestContext) {
  interface MessageDocument {activeElement:Element|null;createElement(tag:string):Element;createTextNode(content:unknown):Element;createDocumentFragment():Element;asNode(value:unknown):Element}
  const document = { activeElement: null } as MessageDocument;
  class Element {
    children:Element[] = []; attributes = new Map<string,string>(); listeners = new Map<string,(event:unknown)=>unknown>(); dataset:Record<string,string> = {};
declare tagName:string;
declare title:string;
declare type:string;
declare disabled:boolean;
declare hidden:boolean;
declare nodeType:number;
declare ownerDocument:MessageDocument; className = ""; _textContent = "";
    classList = {
      add: (...names:string[]) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
      toggle: (name: string, enabled?:boolean) => { const names = new Set(this.className.split(/\s+/).filter(Boolean));
        if (enabled) names.add(name); else names.delete(name); this.className = [...names].join(" "); },
    };
    get textContent() { return this._textContent; }
    set textContent(value:string) { this._textContent = value; this.children = []; }
    set innerHTML(_value: unknown) { throw new Error("文件卡片必须通过DOM节点呈现文件名"); }
    append(...nodes:Element[]) { this.children.push(...nodes.flatMap((node) => node.nodeType === 11 ? node.children : [node])); }
    replaceChildren(...nodes:Element[]) { this._textContent = ""; this.children = []; this.append(...nodes); }
    setAttribute(name:string,value:string) { this.attributes.set(name, value); }
    addEventListener(name:string,handler:(event:unknown)=>unknown) { this.listeners.set(name, handler); }
    click() { return this.listeners.get("click")?.({}); }
    focus() { document.activeElement = this; }
  }
  document.createElement = (tag: string) => Object.assign(new Element(), { tagName: tag.toUpperCase(), ownerDocument: document });
  document.createTextNode = (content: unknown) => Object.assign(new Element(), { nodeType: 3, textContent: String(content), ownerDocument: document });
  document.createDocumentFragment = () => Object.assign(new Element(), { nodeType: 11, ownerDocument: document });
  document.asNode = (value:unknown) => { assert.ok(value instanceof Element, "渲染器应返回当前测试DOM节点"); return value; };
  const previous = globalThis.document; Reflect.set(globalThis,"document",document);
  t.after(() => { if (previous === undefined) Reflect.deleteProperty(globalThis, "document"); else globalThis.document = previous; });
  return document;
}
type MessageElement = ReturnType<ReturnType<typeof messageDocument>["createElement"]>;
const allMessageNodes = (node:MessageElement):MessageElement[] => [node, ...node.children.flatMap(allMessageNodes)];
const messageText = (node:MessageElement):string => [node.textContent, ...node.children.map(messageText)].join(" ");

test("已发送附件使用独立文件卡片，先显示文件再显示文字并可预览", (t) => {
  const document = messageDocument(t);
  const ref = { id: "material-one" }, material = { ...ref, name: "季度报告.pdf", mimeType: "application/pdf", kind: "pdf", size: 512 };
  let opened;
  const row = document.asNode(renderUserMessage({ role: "user", content: "请分析这份材料", delivery: "sent", attachments: [ref] }, {value:"",dispatchEvent(){},focus(){}}, {
    attachmentInfo: () => material, onAttachment: (selected: unknown) => { opened = selected; },
  }));
  assert.equal(row.children[0]!.className, "message-attachments");
  assert.equal(row.children[1]!.className, "bubble");
  const card = row.children[0]!.children[0];
  assert.match(card!.className, /attachment-card/); assert.match(card!.className, /message-attachment/);
  assert.equal(card!.tagName, "DIV");
  assert.match(messageText(card!), /PDF/); assert.match(messageText(card!), /512\s*(?:B|bytes|字节)/);
  const preview = allMessageNodes(card!).find((node) => node.className.includes("attachment-card-open"));
  assert.equal(preview!.attributes.get("aria-label"), "预览 季度报告.pdf");
  preview!.click(); assert.deepEqual(opened, ref);
});

test("仅附件消息没有空文字气泡，未知大小不伪造零字节", (t) => {
  const document = messageDocument(t);
  const row = document.asNode(renderUserMessage({ role: "user", content: "", delivery: "sent", attachments: [{ id: "material-one" }] }, {value:"",dispatchEvent(){},focus(){}}, {
    attachmentInfo: () => ({ name: "材料.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "document" }),
  }));
  assert.equal(row.children.length, 1);
  assert.equal(row.children[0]!.className, "message-attachments");
  assert.match(messageText(row), /DOCX|Word|WORD/);
  assert.doesNotMatch(messageText(row), /(?:^|\s)0\s*(?:B|bytes|字节)/);
});

test("文件卡片保留长文件名与完整可访问标题，将不安全名称作为普通文本呈现", (t) => {
  const document = messageDocument(t), name = `<img src=x onerror=alert(1)>${"非常长的研究报告".repeat(20)}.pdf`;
  const card = createAttachmentCard(document, { name, kind: "pdf", mimeType: "application/pdf", size: 512 }, { onOpen() {} });
  const nodes = allMessageNodes(card);
  const preview = nodes.find((node) => node.className.includes("attachment-card-open"));
  assert.equal(preview!.title, name);
  assert.equal(preview!.attributes.get("aria-label"), `预览 ${name}`);
  assert.ok(nodes.some((node) => node.textContent === name));
  assert.equal(nodes.some((node) => ["IMG", "SCRIPT"].includes(node.tagName)), false);
});

test("助理格式化回复按原始内容缓存，状态变化保留 DOM 与流式反馈", (t) => {
  const document = messageDocument(t);
  const reply = createReplyView("学习助手"), source = "**几何讲解**\n\n- 第一步\n- 第二步";
  reply.update({ content: source, status: "writing" });
  const [bubble, activity, error] = document.asNode(reply.row).children;
  assert.match(bubble!.className, /rich-text/);
  assert.ok(allMessageNodes(bubble!).some((node) => node.tagName === "STRONG" && messageText(node).includes("几何讲解")));
  assert.ok(allMessageNodes(bubble!).some((node) => node.tagName === "UL"));
  assert.equal(bubble!.attributes.get("aria-live"), "off"); assert.match(bubble!.className, /streaming/);
  const rendered = [...bubble!.children];
  reply.update({ content: source, status: "complete" });
  assert.equal(bubble!.children.length, rendered.length);
  rendered.forEach((node, index) => assert.equal(bubble!.children[index], node, "可访问公式和格式 DOM 不应因状态更新反复重建"));
  assert.equal(bubble!.attributes.get("aria-live"), "polite"); assert.doesNotMatch(bubble!.className, /streaming/);
  assert.equal(activity!.hidden, true);
  reply.update({ content: "**部分回复**", status: "error", error: "连接中断" });
  assert.match(messageText(bubble!), /部分回复/); assert.equal(error!.textContent, "连接中断"); assert.equal(error!.hidden, false);
  reply.update({ content: "", status: "stopped" });
  assert.equal(bubble!.hidden, true); assert.equal(bubble!.children.length, 0);
  assert.match(messageText(activity!), /已停止回复/);
});

test("用户公式和 Markdown 原文保持可编辑文本，不经过助理渲染", (t) => {
  const document = messageDocument(t);
  const source = "**不要改写输入**，公式 `f(x)=x^2` 和 $x^2$";
  const row = document.asNode(renderUserMessage({ role: "user", content: source, delivery: "sent" }, {value:"",dispatchEvent(){},focus(){}}));
  const bubble = row.children[0];
  assert.equal(bubble!.textContent, source); assert.equal(bubble!.children.length, 0);
  assert.doesNotMatch(bubble!.className, /rich-text/);
});
