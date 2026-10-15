import test from "node:test";
import assert from "node:assert/strict";
import { message } from "../src/collaboration/group-store.mjs";
import { publicGroupMessages } from "../src/collaboration/group-messages.mjs";

const actor = (id = "a") => ({ type: "agent", id, name: `成员 ${id}` });
const system = { type: "system", id: "platform", name: "NEUMA" };
const posted = (id, content, sender = actor(), extra = {}) => ({ id, content, sender, taskId: "task", ...extra });
const record = (messages, extra = {}) => ({ messages, events: [], tasks: [], ...extra });

test("公开投影保留真实回复、成果与失败，内部协作只留在原记录", () => {
  const messages = [posted("user", "你好", { type: "user", id: "user" }),
    posted("intent", "本轮用户的目标是问候", actor(), { visibility: "internal", kind: "negotiation" }),
    posted("work", "处理中间数据", actor(), { visibility: "internal", kind: "member_result" }),
    posted("reply", "你好，我在。", actor(), { visibility: "public", kind: "reply" }),
    posted("clarify", "你希望比较哪些日期？", actor(), { visibility: "public", kind: "clarification" }),
    posted("final", "我已完成比较，结果见文件。", actor(), { visibility: "public", kind: "delivery" }),
    posted("failure", "暂时无法读取文件，已有信息保留。", system, { status: "failed" }),
    posted("unknown", "用户访谈数据如下：`认领` 是字段名。")];
  const source = record(messages), snapshot = structuredClone(source);
  assert.deepEqual(publicGroupMessages(source).map((value) => value.id), ["user", "reply", "clarify", "final", "failure", "unknown"]);
  assert.deepEqual(source, snapshot);
});

test("旧任务按协商事件隐藏早期认领，结果证据和未知消息仍保留", () => {
  const source = record([
    posted("first-intent", "我认为用户只是在打招呼"),
    posted("user", "用户这个词是什么意思？", { type: "user", id: "user" }),
    posted("second-intent", "本轮我暂不认领，有相关问题可以再找我。", actor("b")),
    posted("child-result", "我已完成检查"),
    posted("answer", "资料在共享文件中", actor("b"), { recipientId: "a" }),
    posted("assign", "成员已确定分工，本任务由 成员 a 整合成果。", system),
    posted("final", "我认为用户只是在打招呼"),
    posted("later", "请看最终文件中的用户分组"),
    posted("other", "本轮我暂不认领，有相关问题可以再找我。", actor("a"), { taskId: "other" })
  ], { tasks: [{ id: "task", ownerId: "a", result: "我认为用户只是在打招呼", participants: [{ id: "a", name: "成员 a" }, { id: "b", name: "成员 b" }],
    intents: [{ agentId: "b", participate: false }], children: [{ assigneeId: "a", result: "我已完成检查" }],
    questions: [{ recipientId: "b", answerId: "answer", result: "资料在共享文件中" }] }], events: [
    { type: "task", taskId: "task", phase: "negotiation", seq: 1 },
    { type: "message", taskId: "task", messageId: "first-intent", seq: 2 },
    { type: "message", taskId: "task", messageId: "user", seq: 3 },
    { type: "task", taskId: "task", phase: "negotiation", seq: 4 },
    { type: "message", taskId: "task", messageId: "second-intent", seq: 5 },
    { type: "task", taskId: "task", status: "running", seq: 6 },
    { type: "message", taskId: "task", messageId: "later", seq: 7 }
  ] });
  const snapshot = structuredClone(source);
  // An identical recorded result remains visible even if it also appeared during negotiation.
  assert.deepEqual(publicGroupMessages(source).map((value) => value.id), ["first-intent", "user", "child-result", "answer", "final", "later", "other"]);
  assert.deepEqual(source, snapshot);
});

test("旧协商失败显示必要追问，平台取消和执行失败保留，原历史不改写", () => {
  const reason = "两轮协商后尚未确定整合者，请点名一位成员承担整合，或调整成员后创建新任务";
  const source = record([
    posted("first-intent", "本轮目标仅为问候，你未提供材料"),
    posted("failure-intent", "成员 b 未能提交认领，其他成员可以继续协商。", system),
    posted("clarify", reason, system), posted("cancel", "任务已取消", system),
    posted("failed-work", "成员 a 本轮未完成，已有成果保留。", system),
    posted("explicit", "本轮目标仅为问候，你未提供材料", actor(), { visibility: "public", kind: "reply" })
  ], { tasks: [{ id: "task", reason: "群已归档", participants: [{ id: "b", name: "成员 b" }] }], events: [
    { type: "task", taskId: "task", phase: "negotiation" },
    { type: "message", taskId: "task", messageId: "first-intent" },
    { type: "task", taskId: "task", status: "needs_input" }
  ] });
  const snapshot = structuredClone(source), visible = publicGroupMessages(source);
  assert.deepEqual(visible.map((value) => value.id), ["clarify", "cancel", "failed-work", "explicit"]);
  assert.match(visible[0].content, /你想解决什么/);
  assert.doesNotMatch(visible[0].content, /协商|整合者/);
  assert.deepEqual(source, snapshot);
});

test("旧记录缺少协商证据时保守保留，不按文本或接收者删消息", () => {
  const source = record([posted("unknown", "本轮用户的目标是对比结果", actor(), { recipientId: "b" }),
    posted("quoted", "成员已确定分工，本任务由 成员 a 整合成果。", actor())], { tasks: [{ id: "task" }] });
  assert.deepEqual(publicGroupMessages(source), source.messages);
});

test("旧执行记录按成员各自阶段收起中间成果，早先交付不被后续补充覆盖", () => {
  const source = record([
    posted("coordination", "待用户补充 Q1 到 Q7"),
    posted("child", "材料核查完成", actor("b")),
    posted("answer", "确认为42", actor("b"), { recipientId: "a" }),
    posted("working", "我已经补全日期，结果如下。"),
    posted("integrating", "请另一成员认领核查"),
    posted("first-delivery", "我完成了初稿，但还需要你补充日期。"),
    posted("update", "我收到补充，重新整合"),
    posted("final", "我已经补全日期，结果如下。"),
    posted("unknown", "用户数据中的说明", actor("c"))
  ], { tasks: [{ id: "task", ownerId: "a", result: "我已经补全日期，结果如下。", children: [{ assigneeId: "b", result: "材料核查完成" }],
    questions: [{ recipientId: "b", answerId: "answer", result: "确认为42" }] }], events: [
    { type: "status", taskId: "task", agentId: "a", phase: "work" },
    { type: "status", taskId: "task", agentId: "b", phase: "work" },
    { type: "message", taskId: "task", agentId: "a", messageId: "coordination" },
    { type: "message", taskId: "task", agentId: "b", messageId: "child" },
    { type: "task", taskId: "task", status: "running" },
    { type: "status", taskId: "task", agentId: "b", phase: "question" },
    { type: "message", taskId: "task", agentId: "b", messageId: "answer" },
    { type: "task", taskId: "task", status: "running" },
    { type: "message", taskId: "task", agentId: "a", messageId: "working" },
    { type: "task", taskId: "task", status: "running" },
    { type: "status", taskId: "task", agentId: "a", phase: "integration" },
    { type: "message", taskId: "task", agentId: "a", messageId: "integrating" },
    { type: "task", taskId: "task", childId: "new-child" },
    { type: "message", taskId: "task", agentId: "a", messageId: "first-delivery" },
    { type: "task", taskId: "task", status: "needs_input" },
    { type: "status", taskId: "task", agentId: "a", phase: "update" },
    { type: "message", taskId: "task", agentId: "a", messageId: "update" },
    { type: "task", taskId: "task", status: "running" },
    { type: "status", taskId: "task", agentId: "a", phase: "integration" },
    { type: "message", taskId: "task", agentId: "a", messageId: "final" },
    { type: "task", taskId: "task", status: "completed" }
  ] });
  const snapshot = structuredClone(source);
  assert.deepEqual(publicGroupMessages(source).map((value) => value.id), ["first-delivery", "final", "unknown"]);
  assert.deepEqual(source, snapshot);
});

test("消息展示标记保存到原记录，旧调用保持原结构，非法标记不产生事件", () => {
  const source = { group: { id: "group", lastSequence: 0 }, messages: [], events: [] };
  const internal = message(source, actor(), "后台协调", { taskId: "task", visibility: "internal", kind: "coordination" });
  assert.equal(internal.visibility, "internal"); assert.equal(internal.kind, "coordination");
  const legacy = message(source, system, "任务已取消", { taskId: "task" });
  assert.equal(Object.hasOwn(legacy, "visibility"), false); assert.equal(Object.hasOwn(legacy, "kind"), false);
  assert.deepEqual(publicGroupMessages(source), [legacy]);
  for (const options of [{ visibility: "hidden" }, { kind: "bogus" }]) assert.throws(() => message(source, actor(), "无效", options));
  assert.equal(source.messages.length, 2); assert.equal(source.events.length, 2); assert.equal(source.group.lastSequence, 2);
});
