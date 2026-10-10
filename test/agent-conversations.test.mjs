import test from "node:test";
import assert from "node:assert/strict";
import { AgentConversationHistory } from "../public/agent-conversations.js";
import { agentHistorySnapshot, loadAgentConversationBackups, saveAgentConversationBackup,
  saveActiveAgentConversation } from "../public/state.js";

const settle = () => new Promise(setImmediate);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const messages = (content = "已经整理") => [
  { role: "user", content: "整理工作记录", delivery: "sent" },
  { role: "assistant", content, status: "complete" },
];
const memoryStorage = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
};

function server() {
  const records = new Map(), deleted = new Set(), writes = [];
  let clock = 0;
  const key = (id, cid) => `${id}/${cid}`;
  const failure = (reason) => Object.assign(new Error(reason === "conversation_conflict"
    ? "其他窗口已更新这条对话" : "这条对话已删除"), { reason });
  const commit = (id, cid, request) => {
    writes.push({ id, cid, request: structuredClone(request) });
    if (deleted.has(key(id, cid))) throw failure("conversation_deleted");
    const previous = records.get(key(id, cid));
    const snapshot = agentHistorySnapshot(request.messages);
    if (previous?.mutationId === request.mutationId) {
      if (JSON.stringify(previous.messages) !== JSON.stringify(snapshot.messages)) throw failure("conversation_conflict");
      return { conversation: structuredClone(previous) };
    }
    if (request.expectedVersion !== (previous?.saveVersion ?? 0)) throw failure("conversation_conflict");
    const now = new Date(Date.UTC(2026, 9, 9, 10, 0, ++clock)).toISOString();
    const record = { ...snapshot, id: cid, agentId: id, title: "整理工作记录",
      createdAt: previous?.createdAt || now, updatedAt: now,
      saveVersion: (previous?.saveVersion ?? 0) + 1, mutationId: request.mutationId };
    records.set(key(id, cid), record);
    return { conversation: structuredClone(record) };
  };
  const api = {
    saveHistoryConversation: async (id, cid, request) => commit(id, cid, request),
    listConversations: async (id) => ({ conversations: [...records.values()]
      .filter((record) => record.agentId === id && !deleted.has(key(id, record.id)))
      .map(({ id, title, createdAt, updatedAt, saveVersion }) => ({ id, title, createdAt, updatedAt, saveVersion })) }),
    getHistoryConversation: async (id, cid) => deleted.has(key(id, cid))
      ? { conversation: null, deleted: true } : { conversation: structuredClone(records.get(key(id, cid)) ?? null) },
    removeConversation: async (id, cid) => { deleted.add(key(id, cid)); return { deleted: true, id: cid }; },
  };
  const seed = (id, cid, content = "已经整理") => commit(id, cid,
    { ...agentHistorySnapshot(messages(content)), expectedVersion: 0, mutationId: `seed-${cid}` }).conversation;
  return { api, commit, seed, writes, get: (id, cid) => records.get(key(id, cid)) };
}

function historyFor(t, api, storage = memoryStorage(), options = {}) {
  const history = new AgentConversationHistory({ api, storage, ...options });
  t.after(() => { for (const id of [...history.states.keys()]) history.clear(id); });
  return history;
}

function cache(storage, record) {
  assert.equal(saveAgentConversationBackup(storage, record.agentId, record), true);
  saveActiveAgentConversation(storage, record.agentId, record.id);
}

test("保存按同一对话串行执行，请求期间继续回复最终保存最新完整内容", async (t) => {
  const remote = server(), first = deferred(), requests = [];
  let active = 0, peak = 0;
  const api = { ...remote.api, saveHistoryConversation: async (id, cid, request) => {
    requests.push(structuredClone(request)); active++; peak = Math.max(peak, active);
    try {
      if (requests.length === 1) await first.promise;
      return remote.commit(id, cid, request);
    } finally { active--; }
  } };
  const history = historyFor(t, api), item = history.current("one");
  item.messages = messages("第一部分");
  const saving = history.changed("one", item, { immediate: true });
  item.messages[1].content = "第二部分";
  void history.changed("one", item, { immediate: true });
  item.messages[1].content = "完整的最终回复";
  void history.changed("one", item, { immediate: true });
  assert.equal(requests.length, 1);
  first.resolve(); await saving;
  assert.equal(peak, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].expectedVersion, 0);
  assert.equal(requests[1].expectedVersion, 1);
  assert.equal(requests[0].messages[1].content, "第一部分");
  assert.equal(remote.get("one", item.id).messages[1].content, "完整的最终回复");
  assert.equal(item.pendingSync, false);
  assert.equal(item.saved, true);
});

test("持续流式更新不会一直推迟保存，一秒内合并回复并在结束时立即保存", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const remote = server(), history = historyFor(t, remote.api), item = history.current("one");
  item.messages = messages(""); item.messages[1].status = "streaming";
  for (let part = 1; part <= 4; part++) {
    item.messages[1].content = `回复第 ${part} 部分`;
    history.changed("one", item);
    t.mock.timers.tick(250);
    if (part < 4) assert.equal(remote.writes.length, 0);
  }
  await settle();
  assert.equal(remote.writes.length, 1);
  assert.equal(remote.get("one", item.id).messages[1].content, "回复第 4 部分");
  assert.equal(remote.get("one", item.id).messages[1].status, "stopped");
  item.messages[1].content = "最终完成的回复"; item.messages[1].status = "complete";
  await history.changed("one", item, { immediate: true });
  t.mock.timers.tick(1000); await settle();
  assert.equal(remote.writes.length, 2);
  assert.equal(remote.get("one", item.id).messages[1].status, "complete");
  assert.equal(item.saveVersion, 2);
});

test("服务端成功但连接断开时重试同一请求，不重复递增版本并补存后续回复", async (t) => {
  const remote = server(); let disconnect = true;
  const api = { ...remote.api, saveHistoryConversation: async (id, cid, request) => {
    const result = remote.commit(id, cid, request);
    if (disconnect) { disconnect = false; throw new Error("保存响应连接断开"); }
    return result;
  } };
  const storage = memoryStorage(), history = historyFor(t, api, storage), item = history.current("one");
  item.messages = messages("断线前的内容");
  await history.changed("one", item, { immediate: true });
  assert.equal(item.pendingSync, true);
  assert.equal(item.saveVersion, 0);
  assert.equal(remote.get("one", item.id).saveVersion, 1);
  assert.match(item.storageError, /本机备份已保留/);
  item.messages[1].content = "断线后继续生成的新内容";
  await history.changed("one", item, { immediate: true });
  assert.deepEqual(remote.writes[1].request, remote.writes[0].request);
  assert.notEqual(remote.writes[2].request.mutationId, remote.writes[0].request.mutationId);
  assert.equal(remote.writes[2].request.expectedVersion, 1);
  assert.equal(item.saveVersion, 2);
  assert.equal(item.storageError, "");
  assert.equal(loadAgentConversationBackups(storage, "one")[0].pendingSync, undefined);
  assert.equal(remote.get("one", item.id).messages[1].content, "断线后继续生成的新内容");
});

test("刷新恢复待同步备份，先确认断线请求再保存本机最新内容", async (t) => {
  const remote = server(), storage = memoryStorage();
  const failing = { ...remote.api, saveHistoryConversation: async (id, cid, request) => {
    remote.commit(id, cid, request); throw new Error("响应未到达浏览器");
  } };
  const first = historyFor(t, failing, storage), item = first.current("one");
  item.messages = messages("已经写入服务器");
  await first.changed("one", item, { immediate: true });
  item.messages[1].content = "本秒第一段回复"; first.changed("one", item);
  item.messages[1].content = "刷新前的新回复"; first.changed("one", item);
  first.checkpoint();
  clearTimeout(item.saveTimer); item.saveTimer = null;
  const backup = loadAgentConversationBackups(storage, "one")[0];
  assert.equal(backup.pendingSync, true);
  assert.equal(backup.messages[1].content, "刷新前的新回复");
  assert.equal(backup.retryRequest.messages[1].content, "已经写入服务器");
  const restored = historyFor(t, remote.api, storage), current = restored.current("one");
  assert.equal(current.id, item.id);
  const beforeRestore = remote.writes.length;
  await restored.load({ id: "one", persisted: true }); await settle();
  assert.deepEqual(remote.writes[beforeRestore].request, remote.writes[0].request);
  assert.equal(remote.get("one", item.id).saveVersion, 2);
  assert.equal(remote.get("one", item.id).messages[1].content, "刷新前的新回复");
  assert.equal(current.pendingSync, false);
  assert.equal(current.saved, true);
});

test("刷新检查点同步保留所有 Agent 最后一秒的新回复，不等待或新发网络请求", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const remote = server(), storage = memoryStorage(), history = historyFor(t, remote.api, storage);
  const one = history.current("one"), two = history.current("two");
  one.messages = messages("第一段"); one.messages[1].status = "streaming";
  two.messages = messages("另一个智能体的第一段"); two.messages[1].status = "streaming";
  history.changed("one", one); history.changed("two", two);
  t.mock.timers.tick(400);
  one.messages[1].content = "刷新前最后一段";
  two.messages[1].content = "另一个智能体的最后一段";
  history.changed("one", one); history.changed("two", two);
  assert.equal(loadAgentConversationBackups(storage, "one")[0].messages[1].content, "第一段");
  history.blank("one");
  history.checkpoint();
  assert.equal(remote.writes.length, 0);
  const oneBackup = loadAgentConversationBackups(storage, "one")[0];
  const twoBackup = loadAgentConversationBackups(storage, "two")[0];
  assert.equal(oneBackup.messages[1].content, "刷新前最后一段");
  assert.equal(twoBackup.messages[1].content, "另一个智能体的最后一段");
  assert.equal(oneBackup.messages[1].status, "stopped");
  assert.equal(oneBackup.pendingSync, true);
  assert.equal(twoBackup.pendingSync, true);
});

test("多窗口保存冲突保留双方内容，冲突副本只能另存为新对话", async (t) => {
  const remote = server(), record = remote.seed("one", "shared-chat");
  const leftStorage = memoryStorage(), rightStorage = memoryStorage();
  cache(leftStorage, record); cache(rightStorage, record);
  const left = historyFor(t, remote.api, leftStorage), right = historyFor(t, remote.api, rightStorage);
  const leftItem = left.current("one"), rightItem = right.current("one");
  leftItem.messages[1].content = "左窗口的结果";
  await left.changed("one", leftItem, { immediate: true });
  rightItem.messages[1].content = "右窗口独立修改";
  await right.changed("one", rightItem, { immediate: true });
  assert.equal(rightItem.conflict, true);
  assert.equal(rightItem.pendingSync, true);
  assert.equal(rightItem.messages[1].content, "右窗口独立修改");
  assert.equal(remote.get("one", record.id).messages[1].content, "左窗口的结果");
  assert.equal(loadAgentConversationBackups(rightStorage, "one")[0].messages[1].content, "右窗口独立修改");
  const writes = remote.writes.length;
  await right.save("one", rightItem);
  assert.equal(remote.writes.length, writes);
  await right.fork("one", rightItem);
  const fork = right.current("one");
  assert.notEqual(fork.id, record.id);
  assert.equal(remote.get("one", fork.id).messages[1].content, "右窗口独立修改");
  assert.equal(remote.get("one", record.id).messages[1].content, "左窗口的结果");
});

test("删除正在保存的对话后，晚到成功响应不会恢复记录或切回旧对话", async (t) => {
  const remote = server(), selected = remote.seed("one", "selected"), other = remote.seed("one", "other", "其他对话");
  const storage = memoryStorage(); cache(storage, other); cache(storage, selected);
  const response = deferred(); let signal;
  const api = { ...remote.api, saveHistoryConversation: async (id, cid, request, options) => {
    signal = options.signal;
    const result = remote.commit(id, cid, request);
    await response.promise;
    return result;
  } };
  const history = historyFor(t, api, storage), item = history.current("one");
  item.messages[1].content = "即将删除的修改";
  const saving = history.changed("one", item, { immediate: true });
  assert.equal(await history.remove("one", item.id), true);
  assert.equal(signal.aborted, true);
  assert.equal(history.current("one").id, other.id);
  response.resolve(); await saving;
  assert.equal(history.state("one").items.has(item.id), false);
  assert.equal(history.records("one").some((record) => record.id === item.id), false);
  assert.equal(loadAgentConversationBackups(storage, "one").some((record) => record.id === item.id), false);
  assert.equal(history.current("one").id, other.id);
});

test("历史列表和正文迟到返回不覆盖用户刚选择的新对话", async (t) => {
  const remote = server(), record = remote.seed("one", "saved-chat");
  const list = deferred(), body = deferred();
  const api = { ...remote.api, listConversations: () => list.promise,
    getHistoryConversation: () => body.promise };
  const history = historyFor(t, api);
  const loading = history.load({ id: "one", persisted: true });
  const blank = history.blank("one");
  list.resolve(await remote.api.listConversations("one")); await loading;
  assert.equal(history.current("one"), blank);
  assert.deepEqual(blank.messages, []);
  const selecting = history.select("one", record.id);
  const next = history.blank("one");
  body.resolve({ conversation: record }); await selecting;
  assert.equal(history.current("one"), next);
  assert.deepEqual(next.messages, []);
});

test("同一对话在读取期间已保存新内容时，晚到旧正文不回退消息或版本", async (t) => {
  const remote = server(), record = remote.seed("one", "updated-during-read");
  const body = deferred(), api = { ...remote.api, getHistoryConversation: () => body.promise };
  const history = historyFor(t, api), loading = history.load({ id: "one", persisted: true });
  await settle();
  const item = history.current("one");
  item.messages = messages("本机已经保存的新内容"); item.loaded = true;
  await history.changed("one", item, { immediate: true });
  assert.equal(item.saveVersion, 2);
  body.resolve({ conversation: record }); await loading;
  assert.equal(item.messages[1].content, "本机已经保存的新内容");
  assert.equal(item.saveVersion, 2);
  assert.equal(loadAgentConversationBackups(history.storage, "one")[0].messages[1].content, "本机已经保存的新内容");
});

test("刷新发现当前对话已在其他窗口删除时，清理旧备份并打开空白对话", async (t) => {
  const remote = server(), record = remote.seed("one", "deleted-elsewhere");
  const storage = memoryStorage(); cache(storage, record);
  await remote.api.removeConversation("one", record.id);
  const history = historyFor(t, remote.api, storage);
  assert.equal(history.current("one").id, record.id);
  await history.load({ id: "one", persisted: true });
  assert.equal(history.records("one").length, 0);
  assert.notEqual(history.current("one").id, record.id);
  assert.deepEqual(history.current("one").messages, []);
  assert.equal(loadAgentConversationBackups(storage, "one").length, 0);
});
