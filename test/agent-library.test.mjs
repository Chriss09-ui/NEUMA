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
