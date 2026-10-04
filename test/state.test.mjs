import test from "node:test";
import assert from "node:assert/strict";
import { agentDisplayDescription, agentDisplayIcon, agentDisplayName } from "../public/state.js";
import { blankSession, clearSession, deleteRequirement, hasSavedSession, initializeSession,
  loadSavedRequirements, loadSession, recentUserMessages, saveRequirement, saveSession, startNewConversation,
  upsertConfirmedRequirement, appendAgentPreview, deleteAgentPreview, loadAgentPreview,
  saveAgentPreview } from "../public/state.js";

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

test("智能体预览记录按入口隔离，手动保存不会进入主 Agent 的需求上下文", () => {
  const local = storage();
  const main = blankSession();
  const weekly = appendAgentPreview([], "这是周报素材");
  const meeting = appendAgentPreview([], "这是会议素材");
  assert.deepEqual(loadAgentPreview(local, "weekly"), []);
  assert.equal(saveAgentPreview(local, "weekly", weekly), true);
  assert.equal(saveAgentPreview(local, "meeting", meeting), true);
  assert.deepEqual(loadAgentPreview(local, "weekly"), weekly);
  assert.deepEqual(loadAgentPreview(local, "meeting"), meeting);
  assert.deepEqual(recentUserMessages(main.messages), []);
  assert.deepEqual(loadSavedRequirements(local), []);
  assert.equal(deleteAgentPreview(local, "weekly"), true);
  assert.deepEqual(loadAgentPreview(local, "weekly"), []);
  assert.deepEqual(loadAgentPreview(local, "meeting"), meeting);
});

test("预览记录限制输入体积，损坏或执行回复不能被当成预览结果恢复", () => {
  const local = storage();
  const old = [{ role: "user", content: "原始输入" }];
  const next = appendAgentPreview(old, "  新输入  ");
  assert.equal(old.length, 1);
  assert.equal(next.at(-1).content, "新输入");
  assert.throws(() => appendAgentPreview([], " "), /1～4000/);
  assert.throws(() => appendAgentPreview([], "字".repeat(4001)), /1～4000/);
  const many = Array.from({ length: 80 }, (_, i) => ({ role: "user", content: String(i) }));
  assert.equal(appendAgentPreview(many, "最新").length, 80);
  local.setItem("neuma.agent.preview.v1.a", "{broken");
  assert.deepEqual(loadAgentPreview(local, "a"), []);
  local.setItem("neuma.agent.preview.v1.a", JSON.stringify([
    ...old, { role: "assistant", content: "任务已完成" }, { role: "user", content: "字".repeat(4001) },
  ]));
  assert.deepEqual(loadAgentPreview(local, "a"), old);
  const unavailable = { getItem() { throw new Error(); }, setItem() { throw new Error(); }, removeItem() { throw new Error(); } };
  assert.deepEqual(loadAgentPreview(unavailable, "a"), []);
  assert.equal(saveAgentPreview(unavailable, "a", old), false);
  assert.equal(deleteAgentPreview(unavailable, "a"), false);
});

test("真实对话保存角色、版本和结果状态，刷新后将未结束任务标为停止", () => {
  const local = storage();
  const messages = [
    { role: "user", content: "写周报", delivery: "sent", revision: "1" },
    { role: "assistant", content: "本周完成…", status: "complete", revision: "1" },
    { role: "user", content: "再短一点", delivery: "pending", revision: "1" },
    { role: "assistant", content: "本周", status: "writing", revision: "1" },
  ];
  assert.equal(saveAgentPreview(local, "weekly", messages), true);
  const saved = loadAgentPreview(local, "weekly");
  assert.equal(saved[0].delivery, "sent");
  assert.equal(saved[1].status, "complete");
  assert.equal(saved[1].revision, "1");
  assert.equal(saved[2].delivery, "stopped");
  assert.equal(saved[3].status, "stopped");
  assert.equal(loadAgentPreview(local, "meeting").length, 0);
  assert.equal(deleteAgentPreview(local, "weekly"), true);
  assert.deepEqual(loadAgentPreview(local, "weekly"), []);
});

test("展示信息独立于原始需求，简介空串与图标回退具有明确语义", () => {
  const raw = { id: "one", name: "原始名称", draft: { goal: { value: "原始目标" } } };
  assert.equal(agentDisplayName(raw), "原始名称");
  assert.equal(agentDisplayDescription(raw), "原始目标");
  assert.equal(agentDisplayIcon(raw), "原");
  const overlay = { ...raw, profile: { name: "新名称", description: "", icon: "🧠" } };
  assert.equal(agentDisplayName(overlay), "新名称");
  assert.equal(agentDisplayDescription(overlay), "");
  assert.equal(agentDisplayIcon(overlay), "🧠");
  assert.equal(agentDisplayIcon({ ...overlay, profile: { ...overlay.profile, icon: "" } }), "新");
  assert.equal(agentDisplayName({ ...raw, profile: { name: " " } }), "原始名称");
  assert.equal(agentDisplayName(null), "未命名 Agent");
  assert.equal(raw.name, "原始名称");
});

test("需求迭代保留展示 overlay，保存需求只写原始字段", () => {
  const previous = { id: "one", name: "原始名称", draft: { name: { value: "原始名称" }, goal: { value: "原始目标" } },
    profile: { id: "one", name: "展示名称", description: "展示简介", icon: "📚" }, persisted: true };
  const next = upsertConfirmedRequirement([previous], "one", { name: { value: "新需求名称" }, goal: { value: "新目标" } }, "unused").items[0];
  assert.equal(next.id, "one");
  assert.equal(next.name, "新需求名称");
  assert.equal(agentDisplayName(next), "展示名称");
  assert.deepEqual(next.profile, previous.profile);
  assert.notEqual(next.profile, previous.profile);
  const values = new Map(), storage = {
    getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
  };
  assert.equal(saveRequirement(storage, next), true);
  const saved = loadSavedRequirements(storage)[0];
  assert.equal(saved.name, "新需求名称");
  assert.equal(saved.profile, undefined);
  assert.equal(saved.draft.goal.value, "新目标");
});
