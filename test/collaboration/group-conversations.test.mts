import test from "node:test";
import assert from "node:assert/strict";
import { groupConversationId, groupConversationTasks, groupConversationMessages } from "../../src/collaboration/group-conversations.mjs";

test("旧任务各自是会话，续轮沿同一会话读取前序消息，隔离其它会话与后续排队轮", () => {
  const first = { id: "first", status: "completed" }, other = { id: "other", status: "completed" };
  const current = { id: "second", conversationId: "first", status: "running" };
  const queued = { id: "later", conversationId: "first", status: "queued" };
  const record = { tasks: [first, other, current, queued], messages: [
    { id: "greeting", taskId: "first", content: "你好" }, { id: "reply", taskId: "first", content: "你好，我是资料助手。" },
    { id: "unrelated", taskId: "other", content: "另一话题的材料" },
    { id: "followup", taskId: "second", content: "你能帮我做什么？" },
    { id: "future", taskId: "later", content: "不要把我当成前序输入" }
  ] };
  const snapshot = structuredClone(record);
  assert.equal(groupConversationId(first), "first"); assert.equal(groupConversationId(current), "first");
  assert.deepEqual(groupConversationTasks(record, current).map((value) => value.id), ["first", "second"]);
  assert.deepEqual(groupConversationMessages(record, current).map((value) => value.id), ["greeting", "reply", "followup"]);
  assert.deepEqual(groupConversationMessages(record, other).map((value) => value.id), ["unrelated"]);
  assert.deepEqual(groupConversationTasks(record, current, { throughCurrent: false }).map((value) => value.id), ["first", "second", "later"]);
  assert.deepEqual(record, snapshot);
});

test("公开投影可作为会话消息来源，不把后台消息带入直接回复判断", () => {
  const task = { id: "second", conversationId: "first" };
  const record = { tasks: [{ id: "first" }, task], messages: [
    { id: "internal", taskId: "first", visibility: "internal", content: "内部交接" },
    { id: "reply", taskId: "first", visibility: "public", content: "我已经核对好了。" },
    { id: "question", taskId: "second", content: "结论是什么？" }
  ] };
  const publicMessages = record.messages.filter((value) => value.visibility !== "internal");
  assert.deepEqual(groupConversationMessages(record, task, publicMessages).map((value) => value.id), ["reply", "question"]);
  assert.deepEqual(groupConversationMessages({ messages: record.messages }, task).map((value) => value.id), ["question"]);
});
