import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MainStore } from "../src/main/main-store.mjs";
import { GroupStore } from "../src/collaboration/group-store.mjs";

test("主对话重载保留旧字段缺省和扩展数据，损坏的嵌套来源不覆盖磁盘原文", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "neuma-main-boundary-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new MainStore({ dataDir });
  const created = await store.create({ mutationId: "legacy-create" });
  const file = join(dataDir, "main", "conversations", `${created.id}.json`);
  const legacy = { ...created, extension: { original: "保留" } };
  const original = JSON.stringify(legacy, null, 2);
  await writeFile(file, original);
  const reopened = new MainStore({ dataDir });
  assert.deepEqual(await reopened.get(created.id), legacy);
  assert.equal(Object.hasOwn(await reopened.get(created.id), "requirements"), false);
  assert.equal(await readFile(file, "utf8"), original);

  const now = created.createdAt;
  const damaged = JSON.stringify({ ...legacy, messages: [{ id: "old-message", role: "assistant", content: "已有回复", status: "complete",
    sources: [{ type: "agent", agentId: { id: "不能提升为标识" } }], actions: [], createdAt: now, updatedAt: now }] });
  await writeFile(file, damaged);
  await assert.rejects(new MainStore({ dataDir }).ready, /对话记录格式无效/);
  assert.equal(await readFile(file, "utf8"), damaged);
});

test("群重载保留旧扩展数据，只在内存补已有默认值，嵌套损坏不重写历史", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "neuma-group-boundary-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new GroupStore({ dataDir });
  const group = await store.create({ name: "历史群", purpose: "保留历史", memberIds: ["worker"], mutationId: "legacy-create" });
  const file = join(dataDir, "groups", group.id, "group.json");
  const record = await store.get(group.id);
  const { materialIds: _oldDefault, ...legacyGroup } = record.group;
  const legacy = { ...record, group: legacyGroup, extension: { original: "保留" }, tasks: [{ id: "old-task", status: "completed",
    goal: "历史已完成任务", jobs: [], children: [], participants: [{ id: "worker", revision: 1 }], requests: [], generation: 1,
    result: "已有成果", createdAt: group.createdAt, updatedAt: group.createdAt }] };
  const original = JSON.stringify(legacy);
  await writeFile(file, original);
  const reopened = new GroupStore({ dataDir });
  assert.deepEqual(await reopened.get(group.id), { ...legacy, group: { ...legacy.group, materialIds: [] } });
  assert.equal(Object.hasOwn((await reopened.get(group.id)).tasks[0]!, "intents"), false);
  assert.equal(await readFile(file, "utf8"), original);

  const damaged = JSON.stringify({ ...legacy, messages: [{ id: "old-message", sender: { type: "agent", id: 42, name: "损坏" },
    content: "历史消息", taskId: null, recipientId: null, replyTo: null, status: "complete", createdAt: group.createdAt, seq: 2 }] });
  await writeFile(file, damaged);
  await assert.rejects(new GroupStore({ dataDir }).ready, /群记录格式无效/);
  assert.equal(await readFile(file, "utf8"), damaged);
  await Promise.all([store.close(), reopened.close()]);
});
