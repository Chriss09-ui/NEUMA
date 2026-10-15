import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CollaborationService } from "../src/collaboration/groups.mjs";
import { GroupStore, fingerprint, message } from "../src/collaboration/group-store.mjs";

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const rejectedConflict = (error) => error.reason === "collaboration_conflict";
const rejectedDeleted = (error) => error.reason === "conversation_deleted";
const task = (id, conversationId, status = "completed") => ({ id, ...(conversationId ? { conversationId } : {}), status,
  goal: id, jobs: [], children: [], participants: [{ id: "analyst", revision: 1 }], requests: [], generation: 1,
  result: "已完成结果", createdAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z" });

async function fixture(t, { execute } = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-group-conversation-removal-"));
  const cards = [{ id: "analyst", name: "分析员", ready: true, revision: 1, boundaries: [] }];
  const agents = { ready: Promise.resolve(), capabilityCards: async () => ({ agents: cards }),
    activitySnapshot: async () => ({ activities: [] }), executeCollaboration: execute };
  const service = new CollaborationService({ dataDir: root, agents }); await service.ready;
  if (!execute) service.start = () => {};
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const create = async (mutationId = "create") => (await service.createGroup({ name: "会话测试群", memberIds: ["analyst"], mutationId })).group;
  const seed = (groupId, tasks) => service.store.change(groupId, (record) => {
    record.tasks.push(...tasks);
    for (const entry of tasks) {
      message(record, { type: "user", id: "user", name: "你" }, `${entry.id}的公开输入`, { taskId: entry.id });
      message(record, { type: "agent", id: "analyst", name: "分析员" }, `${entry.id}的内部消息`, { taskId: entry.id, visibility: "internal" });
    }
  });
  return { root, service, create, seed };
}

test("删除旧群会话的全部轮次与消息，保留其他活跃会话、群材料和成果且重启后不恢复", async (t) => {
  const { root, service, create, seed } = await fixture(t), group = await create();
  const other = await create("other-group");
  await seed(group.id, [task("legacy"), task("second", "legacy", "partial"), task("third", "legacy", "failed"), task("other", "other", "running")]);
  await seed(other.id, [task("legacy")]);
  const material = await service.uploadMaterial(group.id, { name: "资料.txt", source: Buffer.from("保留共享材料") });
  const artifact = await service.store.change(group.id, (record) => {
    record.group.activeTaskId = "other";
    return service.addArtifact(record, "analyst", "second", "报告.txt", "保留已发布成果");
  });
  const output = await service.store.storage.path(group.id, "workspace/outputs/报告.txt", true);
  await writeFile(output, "保留成果目录");
  const before = await service.store.get(group.id), untouched = await service.store.get(other.id);
  assert.deepEqual(await service.removeConversation(group.id, "legacy", { mutationId: "remove" }), { removed: true, conversationId: "legacy" });
  const after = await service.store.get(group.id);
  assert.deepEqual(after.tasks.map((value) => value.id), ["other"]);
  assert.equal(after.messages.length, 2); assert.ok(after.messages.every((value) => value.taskId === "other"));
  assert.ok(after.events.every((value) => !["legacy", "second", "third"].includes(value.taskId)));
  assert.equal(after.events.at(-1).type, "conversation-removed");
  assert.ok(after.group.lastSequence > before.group.lastSequence); assert.equal(after.group.activeTaskId, "other");
  assert.deepEqual(after.artifacts, before.artifacts); assert.deepEqual(after.group.materialIds, before.group.materialIds);
  assert.equal((await service.artifact(group.id, artifact.id)).content, "保留已发布成果");
  assert.equal((await service.requireMaterial(group.id, material.attachment.id)).id, material.attachment.id);
  assert.equal(await readFile(output, "utf8"), "保留成果目录");
  assert.deepEqual(await service.store.get(other.id), untouched);
  const recovered = new GroupStore({ dataDir: root }); await recovered.ready;
  const saved = await recovered.get(group.id);
  assert.deepEqual(saved.tasks.map((value) => value.id), ["other"]);
  assert.deepEqual(saved.deletedConversations[0].taskIds, ["legacy", "second", "third"]);
  assert.ok(saved.messages.every((value) => value.taskId === "other"));
  await recovered.close();
});

test("进行中、排队或等待补充的任一会话轮次阻止删除且不修改原记录", async (t) => {
  const { service, create, seed } = await fixture(t), group = await create();
  for (const status of ["queued", "running", "negotiating", "waiting", "needs_input"]) {
    const conversationId = `conversation-${status}`;
    await seed(group.id, [task(conversationId), task(`later-${status}`, conversationId, status)]);
    const before = await service.store.get(group.id);
    await assert.rejects(service.removeConversation(group.id, conversationId, { mutationId: `remove-${status}` }),
      (error) => rejectedConflict(error) && /停止后再删除/.test(error.message));
    assert.deepEqual(await service.store.get(group.id), before);
  }
});

test("删除重试及已不存在会话幂等，复用删除请求不能误删另一会话或其他群", async (t) => {
  const { service, create, seed } = await fixture(t), group = await create(), other = await create("other-group");
  await seed(group.id, [task("one"), task("two")]); await seed(other.id, [task("one")]);
  const result = { removed: true, conversationId: "one" };
  const attempts = await Promise.all([service.removeConversation(group.id, "one", { mutationId: "remove" }),
    service.removeConversation(group.id, "one", { mutationId: "remove" })]);
  assert.deepEqual(attempts, [result, result]);
  assert.deepEqual(await service.removeConversation(group.id, "one", { mutationId: "another-removal" }), result);
  assert.deepEqual(await service.removeConversation(group.id, "missing", { mutationId: "remove-missing" }), { removed: true, conversationId: "missing" });
  await assert.rejects(service.removeConversation(group.id, "two", { mutationId: "remove" }), rejectedConflict);
  assert.deepEqual((await service.store.get(group.id)).tasks.map((value) => value.id), ["two"]);
  assert.deepEqual((await service.store.get(other.id)).tasks.map((value) => value.id), ["one"]);
});

test("删除持久化失败保留内存与磁盘，使用原请求可重试", async (t) => {
  const { service, create, seed } = await fixture(t), group = await create(); await seed(group.id, [task("one")]);
  const before = await service.store.get(group.id), storage = service.store.storage, write = storage.writeJson.bind(storage);
  storage.writeJson = async () => { throw new Error("disk full"); };
  await assert.rejects(service.removeConversation(group.id, "one", { mutationId: "remove" }), /disk full/);
  assert.deepEqual(await service.store.get(group.id), before);
  assert.deepEqual(await storage.readJson(group.id, "group.json"), before);
  storage.writeJson = write;
  assert.deepEqual(await service.removeConversation(group.id, "one", { mutationId: "remove" }), { removed: true, conversationId: "one" });
});

test("删除标记和提交回执阻止旧会话所有轮次及原始提交的迟到重放", async (t) => {
  const { root, service, create, seed } = await fixture(t), group = await create();
  const original = { content: "原始输入", mutationId: "original" };
  await seed(group.id, [task("one"), task("two", "one")]);
  await service.store.change(group.id, (record) => record.mutations.push({ id: original.mutationId,
    hash: fingerprint({ ...original, source: "user" }), result: { taskId: "one", messageId: record.messages[0].id } }));
  await service.removeConversation(group.id, "one", { mutationId: "remove" });
  for (const input of [original, { content: "迟到补充", taskId: "one", mutationId: "late-one" },
    { content: "迟到续轮", taskId: "two", mutationId: "late-two" }, { content: "旧状态新提交", taskId: "two", newTask: true, mutationId: "late-new" }]) {
    await assert.rejects(service.postMessage(group.id, input), (error) => rejectedDeleted(error) && /已删除/.test(error.message));
  }
  const recoveredStore = new GroupStore({ dataDir: root }); await recoveredStore.ready;
  const recovered = new CollaborationService({ dataDir: root, agents: service.agents, store: recoveredStore }); await recovered.ready;
  await assert.rejects(recovered.postMessage(group.id, original), rejectedDeleted);
  await assert.rejects(recovered.postMessage(group.id, { content: "重启后的旧输入", taskId: "two", mutationId: "late-restart" }), rejectedDeleted);
  assert.deepEqual((await recovered.store.get(group.id)).tasks, []); await recovered.close();
  const fresh = await service.postMessage(group.id, { content: "明确新建的对话", newTask: true, mutationId: "fresh" });
  assert.notEqual(fresh.task.conversationId, "one");
});

test("串行队列先收到的续聊使删除失败，先持久化的删除使后续旧会话提交失败", async (t) => {
  const { service, create, seed } = await fixture(t), group = await create(); await seed(group.id, [task("one")]);
  const entered = deferred(), release = deferred();
  const continuing = service.store.change(group.id, async (record) => { entered.resolve(); await release.promise; record.tasks[0].status = "queued"; });
  await entered.promise;
  const removal = service.removeConversation(group.id, "one", { mutationId: "remove" });
  const rejected = assert.rejects(removal, rejectedConflict);
  release.resolve(); await continuing; await rejected;
  await service.cancelTask(group.id, "one");
  const writing = deferred(), publish = deferred(), storage = service.store.storage, write = storage.writeJson.bind(storage);
  storage.writeJson = async (...args) => {
    if (args[2].deletedConversations?.length) { writing.resolve(); await publish.promise; }
    return write(...args);
  };
  const deleted = service.removeConversation(group.id, "one", { mutationId: "remove" }); await writing.promise;
  const late = assert.rejects(service.postMessage(group.id, { content: "迟到补充", taskId: "one", mutationId: "late" }), rejectedDeleted);
  publish.resolve(); await deleted; await late;
  assert.deepEqual((await service.store.get(group.id)).tasks, []);
});

test("停止后删除允许仍在返回的旧模型结束，但迟到消息与任务不能复活", async (t) => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const { service, create } = await fixture(t, { execute: async (input, _progress, { signal }) => {
    if (input.role === "routing") {
      await input.customTools.find((tool) => tool.name === "submit_group_route").execute("route", { mode: "default" }, signal);
      return { reply: "", turns: 1 };
    }
    entered.resolve(); await release.promise;
    await input.customTools.find((tool) => tool.name === "submit_group_intent").execute("intent",
      { interaction: "conversation", reply: "迟到模型回复", replyStatus: "complete" }, signal);
    return { reply: "", turns: 1 };
  } });
  const group = await create(), initial = await service.postMessage(group.id, { content: "你好", mutationId: "initial" });
  await entered.promise;
  await assert.rejects(service.removeConversation(group.id, initial.task.id, { mutationId: "remove" }), rejectedConflict);
  await service.cancelTask(group.id, initial.task.id);
  await service.removeConversation(group.id, initial.task.id, { mutationId: "remove" });
  release.resolve(); await service.idle(group.id);
  const after = await service.store.get(group.id);
  assert.deepEqual(after.tasks, []); assert.deepEqual(after.messages, []);
  assert.equal(after.events.at(-1).type, "conversation-removed");
});
