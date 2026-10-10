import test from "node:test";
import assert from "node:assert/strict";
import { addUserMessage, mountWelcome, readReply, recoverInput } from "../public/chat-ui.js";
import { recentUserMessages } from "../public/state.js";

function streamResponse(parts) {
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
  const events = [];
  const result = await readReply(streamResponse(Array.from(data, (byte) => Uint8Array.of(byte))), (event) => events.push(event));
  assert.equal(result.reply, "你好，我可以帮你管理项目。");
  assert.equal(events.filter((event) => event.type === "text-delta").map((event) => event.delta).join(""), "你好，我可以帮你管理项目。");
  assert.equal(events[0].phase, "thinking");
});

test("流式错误保留已经收到的文字，取消原因能被界面识别", async () => {
  const events = [], encode = (value) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  await assert.rejects(readReply(streamResponse([
    encode({ type: "text-delta", delta: "已经收到的片段" }),
    encode({ type: "error", error: "已停止", diagnostic: { reason: "cancelled" } }),
  ]), (event) => events.push(event)), (error) => error.reason === "cancelled");
  assert.equal(events[0].delta, "已经收到的片段");
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
    (error) => error.diagnostic.reason === "upstream_error" && error.diagnostic.stage === "reply");
});

test("自动配置的完成事件按项目结果判断，无需聊天 reply，断流仍报错", async () => {
  const encode = (event) => new TextEncoder().encode(`${JSON.stringify(event)}\n`);
  const options = { isComplete: (result) => typeof result?.project?.id === "string", incompleteMessage: "项目检查连接中断" };
  const part = encode({ type: "done", result: { project: { id: "fixture", canLaunch: true } } });
  const result = await readReply(streamResponse([part]), () => {}, options);
  assert.equal(result.project.canLaunch, true);
  await assert.rejects(readReply(streamResponse([]), () => {}, options), /项目检查连接中断/);
  await assert.rejects(readReply(streamResponse([part]), () => {}), /回复尚未完成/);
});

test("发送立即加入用户消息，失败重发复用原消息且不污染模型上下文", () => {
  const messages = [{ role: "user", content: "上一轮", delivery: "sent" }];
  const user = addUserMessage(messages, "当前问题");
  assert.equal(messages.at(-1).content, "当前问题");
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
  const container = { children: [], append(child) { this.children.push(child); } };
  const welcome = { title: "欢迎标题", suggestions: ["快捷入口"] };
  const messages = [];
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
