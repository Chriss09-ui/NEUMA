import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLibrary } from "../src/agents/agent-library.mjs";
import { InputError } from "../src/requirements/core.mjs";

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "neuma-agent-library-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { dataDir, library: new AgentLibrary({ dataDir }) };
}

const input = (name = "周报助手", goal = "整理周报") => ({ name, draft: { goal: { value: goal, source: "user" } }, updatedAt: "2026-10-08T00:00:00.000Z" });
const snapshot = (content = "已整理") => ({ schemaVersion: 2, messages: [
  { role: "user", content: "整理材料", delivery: "pending", revision: "v1" },
  { role: "assistant", content, status: "complete", revision: "v1" },
] });

test("requirements and explicit conversation snapshots survive restart in the same Agent folder", async (t) => {
  const { dataDir, library } = await fixture(t);
  const saved = await library.saveRequirement("weekly", input());
  assert.equal(saved.requirement.id, "weekly");
  assert.deepEqual(await library.getConversation("weekly"), { conversation: null });
  const conversation = await library.saveConversation("weekly", snapshot());
  assert.equal(conversation.conversation.messages[0].delivery, "stopped");
  const restored = new AgentLibrary({ dataDir });
  assert.deepEqual((await restored.list()).requirements, [saved.requirement]);
  assert.deepEqual(await restored.getConversation("weekly"), conversation);
  assert.equal(JSON.parse(await readFile(join(dataDir, "agents/weekly/requirements.json"), "utf8")).name, input().name);
  assert.equal(JSON.parse(await readFile(join(dataDir, "agents/weekly/conversations/saved.json"), "utf8")).schemaVersion, 2);
  assert.deepEqual(await restored.getConversation("other"), { conversation: null });
});

test("browser imports fill missing data and cannot replace confirmed server records", async (t) => {
  const { library } = await fixture(t);
  await library.saveRequirement("weekly", input());
  await library.saveConversation("weekly", snapshot());
  const imported = await library.saveRequirement("weekly", { ...input("旧浏览器助手", "旧目标"), importOnly: true });
  assert.equal(imported.requirement.name, "周报助手");
  const importedChat = await library.saveConversation("weekly", { ...snapshot("旧回复"), importOnly: true });
  assert.equal(importedChat.conversation.messages[1].content, "已整理");
  await library.saveRequirement("new", { ...input(), importOnly: true });
  assert.equal((await library.list()).requirements.length, 2);
});

test("newer browser requirements can replace legacy fallback but never newer confirmed data", async (t) => {
  const { dataDir, library } = await fixture(t); await library.storage.ready;
  await library.storage.writeJson("weekly", "requirements.json", { id: "weekly", ...input("旧定义", "旧需求"), _legacyFallback: "definition" });
  const newer = await library.saveRequirement("weekly", { ...input("浏览器新版", "新需求"), importOnly: true });
  assert.equal(newer.requirement.draft.goal.value, "新需求");
  assert.equal(JSON.parse(await readFile(join(dataDir, "agents/weekly/requirements.json"), "utf8"))._legacyFallback, undefined);
  await library.storage.writeJson("other", "requirements.json", { id: "other", ...input("最新架构", "已确认新版"), _legacyFallback: "architecture" });
  const older = await library.saveRequirement("other", { ...input("旧浏览器", "旧需求"), updatedAt: "2026-10-04T00:00:00.000Z", importOnly: true });
  assert.equal(older.requirement.draft.goal.value, "已确认新版");
});

test("deletion blocks browser imports and explicit saves while retaining the Agent folder", async (t) => {
  const { library } = await fixture(t);
  await library.saveRequirement("weekly", input()); await library.saveConversation("weekly", snapshot());
  await library.remove("weekly");
  assert.deepEqual(await library.list(), { requirements: [] });
  assert.deepEqual(await library.saveRequirement("weekly", { ...input(), importOnly: true }), { requirement: null, deleted: true });
  assert.deepEqual(await library.saveConversation("weekly", { ...snapshot(), importOnly: true }), { conversation: null, deleted: true });
  await assert.rejects(library.saveRequirement("weekly", input()), InputError);
  await assert.rejects(library.saveConversation("weekly", snapshot()), InputError);
  assert.ok(await library.storage.directory("weekly"));
});

test("invalid snapshots and failed atomic saves preserve the last saved conversation", async (t) => {
  const { library } = await fixture(t);
  await library.saveRequirement("weekly", input()); const original = await library.saveConversation("weekly", snapshot());
  assert.throws(() => library.saveConversation("weekly", { schemaVersion: 2, messages: [{ role: "system", content: "invalid" }] }), InputError);
  assert.throws(() => library.saveRequirement("../other", input()), InputError);
  const write = library.storage.writeJson.bind(library.storage);
  library.storage.writeJson = async () => { throw new InputError("模拟保存失败"); };
  await assert.rejects(library.saveConversation("weekly", snapshot("未保存")), InputError);
  library.storage.writeJson = write;
  assert.deepEqual(await library.getConversation("weekly"), original);
});

const autosave = (content = "已整理", expectedVersion = 0, mutationId = "save-one") => ({
  ...snapshot(content), schemaVersion: 3, expectedVersion, mutationId,
});

test("multiple conversations persist complete transcripts, derive Unicode titles and remain isolated", async (t) => {
  const { dataDir, library } = await fixture(t);
  await library.saveRequirement("weekly", input());
  await library.saveRequirement("other", input());
  const messages = Array.from({ length: 120 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `消息 ${index}`,
    ...(index % 2 ? { status: "complete" } : { delivery: "sent" }) }));
  messages[0].content = "  😀  中文\n标题  " + "😀".repeat(35);
  messages[1].content = "长".repeat(40000);
  const first = await library.saveConversationRecord("weekly", "chat-one", { ...autosave(), messages });
  const second = await library.saveConversationRecord("weekly", "chat-two", autosave("另一个结果"));
  assert.equal(first.conversation.messages.length, 120);
  assert.equal(first.conversation.messages[1].content.length, 40000);
  assert.equal(Array.from(first.conversation.title).length, 30);
  assert.match(first.conversation.title, /^😀 中文 标题 😀/);
  assert.equal(first.conversation.saveVersion, 1);
  const restored = new AgentLibrary({ dataDir });
  assert.deepEqual(await restored.getConversationRecord("weekly", "chat-one"), first);
  assert.deepEqual(await restored.getConversationRecord("weekly", "chat-two"), second);
  const listing = await restored.listConversations("weekly");
  assert.equal(listing.conversations.length, 2);
  assert.deepEqual(Object.keys(listing.conversations[0]), ["id", "title", "createdAt", "updatedAt", "saveVersion"]);
  assert.deepEqual(await restored.listConversations("other"), { conversations: [] });
  assert.deepEqual(await restored.getConversationRecord("other", "chat-one"), { conversation: null });
});

test("autosave retries are idempotent and stale concurrent writers cannot overwrite a later version", async (t) => {
  const { library } = await fixture(t);
  await library.saveRequirement("weekly", input());
  const first = await library.saveConversationRecord("weekly", "chat-one", autosave());
  assert.deepEqual(await library.saveConversationRecord("weekly", "chat-one", autosave()), first);
  await assert.rejects(library.saveConversationRecord("weekly", "chat-one", autosave("换了内容")), { reason: "conversation_conflict" });
  const results = await Promise.allSettled([
    library.saveConversationRecord("weekly", "chat-one", autosave("新版", 1, "save-two")),
    library.saveConversationRecord("weekly", "chat-one", autosave("迟到版", 1, "save-three")),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].reason.reason, "conversation_conflict");
  assert.equal(results[0].value.conversation.saveVersion, 2);
  assert.equal(results[0].value.conversation.createdAt, first.conversation.createdAt);
  await assert.rejects(library.saveConversationRecord("weekly", "chat-one", autosave()), { reason: "conversation_conflict" });
  assert.deepEqual(await library.getConversationRecord("weekly", "chat-one"), results[0].value);
  assert.deepEqual(await library.saveConversationRecord("weekly", "chat-one", { ...autosave("旧浏览器"), importOnly: true }), results[0].value);
});

test("conversation deletion removes its body and prevents late saves, imports and repeated migration from resurrecting it", async (t) => {
  const { dataDir, library } = await fixture(t);
  await library.saveRequirement("weekly", input());
  await library.saveConversation("weekly", snapshot());
  assert.equal((await library.listConversations("weekly")).conversations[0].id, "legacy-saved");
  const savedBytes = await readFile(join(dataDir, "agents/weekly/conversations/saved.json"), "utf8");
  assert.deepEqual(await library.removeConversation("weekly", "legacy-saved"), { deleted: true, id: "legacy-saved" });
  const tombstone = await library.storage.readJson("weekly", "conversations/records/legacy-saved.json");
  assert.deepEqual(Object.keys(tombstone), ["schemaVersion", "id", "agentId", "deletedAt"]);
  assert.deepEqual(await library.getConversation("weekly"), { conversation: null, deleted: true });
  assert.deepEqual(await library.getConversationRecord("weekly", "legacy-saved"), { conversation: null, deleted: true });
  assert.deepEqual(await library.listConversations("weekly"), { conversations: [] });
  await assert.rejects(library.saveConversationRecord("weekly", "legacy-saved", autosave()), { reason: "conversation_deleted" });
  await assert.rejects(library.saveConversation("weekly", snapshot()), { reason: "conversation_deleted" });
  assert.deepEqual(await library.saveConversationRecord("weekly", "legacy-saved", { ...autosave(), importOnly: true }), { conversation: null, deleted: true });
  assert.equal(await readFile(join(dataDir, "agents/weekly/conversations/saved.json"), "utf8"), savedBytes);
  assert.deepEqual(await new AgentLibrary({ dataDir }).listConversations("weekly"), { conversations: [] });
  await library.removeConversation("weekly", "not-yet-saved");
  await assert.rejects(library.saveConversationRecord("weekly", "not-yet-saved", autosave()), { reason: "conversation_deleted" });
});

test("legacy saved snapshot imports once and never replaces an updated active conversation", async (t) => {
  const { dataDir, library } = await fixture(t);
  await library.saveRequirement("weekly", input());
  await library.storage.writeJson("weekly", "conversations/saved.json", snapshot("旧磁盘"));
  const first = await library.getConversationRecord("weekly", "legacy-saved");
  assert.equal(first.conversation.mutationId, "legacy-migration");
  const updated = await library.saveConversationRecord("weekly", "legacy-saved", autosave("新版本", 1, "new-save"));
  assert.deepEqual(await new AgentLibrary({ dataDir }).getConversationRecord("weekly", "legacy-saved"), updated);
  assert.equal((await library.storage.readJson("weekly", "conversations/saved.json")).messages[1].content, "旧磁盘");
});

test("failed compatibility synchronization restores the old saved file and active record", async (t) => {
  const { library } = await fixture(t);
  await library.saveRequirement("weekly", input());
  const old = await library.saveConversation("weekly", snapshot("原内容"));
  const originalRecord = await library.getConversationRecord("weekly", "legacy-saved");
  const write = library.storage.writeJson.bind(library.storage);
  library.storage.writeJson = async (id, file, value) => {
    if (file === "conversations/records/legacy-saved.json") throw new InputError("模拟记录同步失败");
    return write(id, file, value);
  };
  await assert.rejects(library.saveConversation("weekly", snapshot("未保存的新内容")), /同步失败/);
  library.storage.writeJson = write;
  assert.deepEqual(await library.getConversation("weekly"), old);
  assert.deepEqual(await library.getConversationRecord("weekly", "legacy-saved"), originalRecord);
  assert.deepEqual(await library.storage.readJson("weekly", "conversations/saved.json"), old.conversation);
});

test("8 MiB uses actual persisted JSON bytes and failed writes preserve prior versions", async (t) => {
  const { dataDir, library } = await fixture(t);
  await library.saveRequirement("weekly", input());
  const first = await library.saveConversationRecord("weekly", "chat", autosave());
  const file = join(dataDir, "agents/weekly/conversations/records/chat.json"), originalBytes = await readFile(file);
  const maxBytes = 8 * 1024 * 1024;
  const boundaryInput = autosave("", 1, "boundary-save");
  const envelope = { ...first.conversation, saveVersion: 2, mutationId: boundaryInput.mutationId,
    messages: first.conversation.messages.map((message) => message.role === "assistant" ? { ...message, content: "" } : message) };
  const contentBytes = maxBytes - Buffer.byteLength(JSON.stringify(envelope, null, 2));
  const escaped = "\n".repeat(4_200_000);
  assert.ok(Buffer.byteLength(escaped) < maxBytes);
  assert.ok(Buffer.byteLength(JSON.stringify(escaped)) > maxBytes);
  const overEnvelope = { ...boundaryInput, messages: envelope.messages.map((message) => message.role === "assistant"
    ? { ...message, content: "a".repeat(contentBytes + 1) } : message) };
  assert.ok(Buffer.byteLength(overEnvelope.messages.map((message) => message.content).join("")) < maxBytes);
  for (const oversized of [autosave("中文".repeat(1400000), 1, "big-save"), autosave(escaped, 1, "escaped-save"), overEnvelope]) {
    await assert.rejects(library.saveConversationRecord("weekly", "chat", oversized), /8 MiB/);
    assert.deepEqual(await library.getConversationRecord("weekly", "chat"), first);
    assert.deepEqual(await readFile(file), originalBytes);
  }
  const boundary = await library.saveConversationRecord("weekly", "chat", { ...boundaryInput,
    messages: envelope.messages.map((message) => message.role === "assistant" ? { ...message, content: "a".repeat(contentBytes) } : message) });
  assert.equal((await readFile(file)).length, maxBytes);
  assert.equal(boundary.conversation.saveVersion, 2);
  const write = library.storage.writeJson.bind(library.storage);
  library.storage.writeJson = async () => { throw new InputError("模拟磁盘失败"); };
  await assert.rejects(library.saveConversationRecord("weekly", "chat", autosave("未保存", 2, "failed-save")), /模拟磁盘失败/);
  library.storage.writeJson = write;
  assert.deepEqual(await library.getConversationRecord("weekly", "chat"), boundary);
  assert.throws(() => library.saveConversationRecord("weekly", "../outside", autosave()), InputError);
  assert.throws(() => library.saveConversationRecord("weekly", "chat", { ...autosave(), expectedVersion: -1 }), InputError);
});

test("deleting an Agent clears conversation bodies and blocks fresh IDs while retaining workspace files", async (t) => {
  const { library } = await fixture(t);
  await library.saveRequirement("weekly", input());
  await library.saveConversationRecord("weekly", "chat", autosave());
  const workspace = await library.storage.directory("weekly", "workspace", { create: true });
  await writeFile(join(workspace, "result.md"), "保留产物");
  await library.remove("weekly");
  assert.deepEqual(await library.listConversations("weekly"), { conversations: [], deleted: true });
  assert.deepEqual(await library.getConversationRecord("weekly", "chat"), { conversation: null, deleted: true });
  assert.equal(await library.storage.readJson("weekly", "conversations/records/chat.json"), null);
  await assert.rejects(library.saveConversationRecord("weekly", "fresh-chat", autosave()), { reason: "conversation_deleted" });
  assert.equal(await readFile(join(workspace, "result.md"), "utf8"), "保留产物");
});
