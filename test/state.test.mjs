import test from "node:test";
import assert from "node:assert/strict";
import { blankSession, clearSession, deleteRequirement, hasSavedSession, initializeSession,
  loadSavedRequirements, loadSession, recentUserMessages, saveRequirement, saveSession, startNewConversation,
  upsertConfirmedRequirement } from "../public/state.js";

const SAVED_KEY = "neuma.requirements.session.optin.v1";
const LEGACY_KEY = "neuma.requirements.session.v1";

function storage() {
  const entries = new Map();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: (key) => entries.delete(key),
  };
}

test("模型上下文只取当前对话的用户原话，并限制体积", () => {
  const current = blankSession();
  current.messages = [
    { role: "user", content: "我提供论文" },
    { role: "assistant", content: "我建议写八个章节的报告" },
    { role: "user", content: "我只要简短要点" },
  ];
  assert.deepEqual(recentUserMessages(current.messages), ["我提供论文", "我只要简短要点"]);
  assert.deepEqual(recentUserMessages(blankSession().messages), []);
  const large = Array.from({ length: 15 }, (_, index) => ({ role: "user", content: `${index}:` + "字".repeat(4000) }));
  const recent = recentUserMessages(large);
  assert.ok(recent.reduce((total, item) => total + item.length, 0) <= 12000);
  assert.ok(recent.at(-1).startsWith("14:"));
});

test("刷新从空白开始，手动保存记录只有显式加载才进入当前会话", () => {
  const local = storage();
  const session = blankSession();
  session.messages.push({ role: "user", content: "做一个周报助手" });
  session.draft = { goal: { value: "写周报", source: "user" } };
  session.status = "needs_input";
  session.lastQuestion = "资料从哪里来？";
  assert.equal(hasSavedSession(local), false);
  assert.deepEqual(loadSession(local), blankSession());
  assert.equal(saveSession(local, session), true);
  assert.equal(hasSavedSession(local), true);
  const refreshed = initializeSession(local);
  assert.deepEqual(refreshed.session, blankSession());
  assert.equal(refreshed.hasSavedCopy, true);
  assert.deepEqual(loadSession(local), session);
  session.messages.push({ role: "user", content: "再加一个限制" });
  assert.equal(loadSession(local).messages.length, 1);
  assert.equal(clearSession(local), true);
  assert.equal(hasSavedSession(local), false);
  assert.deepEqual(loadSession(local), blankSession());
});

test("本地草稿损坏时安全地回到初始状态", () => {
  const local = storage();
  local.setItem(SAVED_KEY, "{bad json");
  assert.deepEqual(loadSession(local), blankSession());
});

test("新对话清空当前上下文但保留手动保存的记录", () => {
  const local = storage();
  const saved = blankSession();
  saved.messages.push({ role: "user", content: "做一个周报助手" });
  saved.draft = { goal: { value: "写周报", source: "user" } };
  assert.equal(saveSession(local, saved), true);
  const fresh = startNewConversation(local);
  assert.deepEqual(fresh.session, blankSession());
  assert.equal(fresh.hasSavedCopy, true);
  assert.deepEqual(loadSession(local), saved);
});

test("旧版自动保存记录只移入当前页面内存，并清除本地存储副本", () => {
  const local = storage();
  local.setItem(LEGACY_KEY, JSON.stringify({ messages: [{ role: "user", content: "旧记录" }] }));
  assert.deepEqual(loadSession(local), blankSession());
  const refreshed = initializeSession(local);
  assert.deepEqual(refreshed.session, blankSession());
  assert.equal(refreshed.legacyCleared, true);
  assert.equal(refreshed.legacySession.messages[0].content, "旧记录");
  assert.equal(local.getItem(LEGACY_KEY), null);
  assert.equal(hasSavedSession(local), false);
});

test("手动保存的旧格式草稿保留内容，但要重新补充新增的场景与任务", () => {
  const local = storage();
  local.setItem(SAVED_KEY, JSON.stringify({
    messages: [], draft: { goal: { value: "写周报", source: "user" } },
    status: "ready", lastQuestion: "", jev: null,
  }));
  const restored = loadSession(local);
  assert.equal(restored.status, "needs_input");
  assert.equal(restored.draft.goal.value, "写周报");
  assert.equal(restored.confirmed, false);
});

test("多份已确认需求在列表中独立，修改只更新当前条目", () => {
  const weekly = { name: { value: "周报助手" }, goal: { value: "整理周报" } };
  const meeting = { name: { value: "会议纪要助手" }, goal: { value: "整理纪要" } };
  const first = upsertConfirmedRequirement([], null, weekly, "weekly");
  const second = upsertConfirmedRequirement(first.items, null, meeting, "meeting");
  assert.deepEqual(second.items.map((item) => item.id), ["meeting", "weekly"]);
  const revised = upsertConfirmedRequirement(second.items, "weekly",
    { ...weekly, goal: { value: "整理每周项目进展" } }, "unused");
  assert.equal(revised.items.length, 2);
  assert.equal(revised.activeId, "weekly");
  assert.equal(revised.items[0].draft.goal.value, "整理每周项目进展");
  assert.equal(revised.items[1].draft.goal.value, "整理纪要");
  assert.equal(first.items[0].draft.goal.value, "整理周报");
});

test("只有手动保存的 Agent 需求会留下，删除只影响选中条目且不保存聊天", () => {
  const local = storage();
  const weekly = upsertConfirmedRequirement([], null,
    { name: { value: "周报助手" }, goal: { value: "整理周报" } }, "weekly").items[0];
  const meeting = upsertConfirmedRequirement([], null,
    { name: { value: "会议纪要助手" }, goal: { value: "整理纪要" } }, "meeting").items[0];
  assert.deepEqual(loadSavedRequirements(local), []);
  assert.equal(saveRequirement(local, { ...weekly, messages: [{ content: "不应保存的聊天" }] }), true);
  assert.equal(saveRequirement(local, meeting), true);
  const saved = loadSavedRequirements(local);
  assert.deepEqual(saved.map((item) => item.id), ["meeting", "weekly"]);
  assert.equal(saved.every((item) => item.persisted && !item.dirty), true);
  assert.equal(local.getItem("neuma.requirements.saved-list.v1").includes("不应保存的聊天"), false);
  assert.equal(saveRequirement(local, { ...weekly,
    draft: { ...weekly.draft, goal: { value: "整理项目周报" } } }), true);
  assert.equal(loadSavedRequirements(local).length, 2);
  assert.equal(loadSavedRequirements(local).find((item) => item.id === "weekly").draft.goal.value,
    "整理项目周报");
  assert.equal(deleteRequirement(local, "weekly"), true);
  assert.deepEqual(loadSavedRequirements(local).map((item) => item.id), ["meeting"]);
});
