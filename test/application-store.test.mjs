import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStorage } from "../src/agents/agent-storage.mjs";
import { PrototypeAgents } from "../src/agents/agent-prototype.mjs";
import { ApplicationTaskStore } from "../src/applications/task-store.mjs";
const input = (mutationId = "mutation-123") => ({ mutationId, actionId: "search", input: { url: "https://example.com" }, deliveryVersion: "v1", source: { kind: "application", scope: "private" } });
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "neuma-app-store-")); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const storage = new AgentStorage({ dataDir }), store = new ApplicationTaskStore({ storage }); await store.ready; return { storage, store };
}
test("task submission is atomic and idempotent, mismatched replay is rejected", async (t) => {
  const { store } = await fixture(t);
  const submissions = await Promise.all(Array.from({ length: 5 }, () => store.create("agent-a", input())));
  assert.equal(submissions.filter((value) => value.created).length, 1);
  assert.equal(new Set(submissions.map((value) => value.task.id)).size, 1);
  const contextualReplay = await store.create("agent-a", { ...input(), source: { ...input().source,
    applicationContext: { instanceId: "page-new", deliveryVersion: "v1", revision: 1 } } });
  assert.equal(contextualReplay.task.id, submissions[0].task.id); assert.equal(contextualReplay.task.source.applicationContext, undefined);
  await assert.rejects(store.create("agent-a", { ...input(), input: { different: true } }), { reason: "application_conflict" });
  assert.equal((await store.list("agent-a")).length, 1);
  assert.equal((await store.list("agent-b")).length, 0);
  await assert.rejects(store.get("agent-b", submissions[0].task.id), /没有找到/);
});
test("reload retries preserve the original task binding and accept legacy hashes without replaying mutations", async (t) => {
  const { store, storage } = await fixture(t);
  const original = { ...input(), source: { ...input().source, applicationContext: { instanceId: "page-old", deliveryVersion: "v1", revision: 4 } } };
  const first = await store.create("agent-a", original);
  await store.update("agent-a", first.task.id, { status: "completed", result: { saved: true } });
  const record = await store.record("agent-a");
  record.tasks[0].requestHash = createHash("sha256").update(JSON.stringify([original.actionId, original.input, original.deliveryVersion, original.source])).digest("hex");
  await storage.writeJson("agent-a", "application/tasks.json", record);
  const retry = { ...original, source: { ...original.source, applicationContext: { instanceId: "page-reloaded", deliveryVersion: "v1", revision: 1 } } };
  const replay = await store.create("agent-a", retry);
  assert.equal(replay.created, false); assert.equal(replay.task.id, first.task.id);
  assert.deepEqual(replay.task.source.applicationContext, original.source.applicationContext);
  assert.deepEqual(replay.task.result, { saved: true });
  assert.deepEqual(await store.record("agent-a"), record);
  for (const patch of [{ input: { url: "https://example.com/other" } }, { actionId: "different" }, { deliveryVersion: "v2" },
    { source: { ...retry.source, scope: "group:other" } }, { source: { ...retry.source, kind: "conversation" } }])
    await assert.rejects(store.create("agent-a", { ...retry, ...patch }), { reason: "application_conflict" });
});
test("cancelled terminal task refuses late successful receipts, events can be replayed", async (t) => {
  const { store } = await fixture(t), { task } = await store.create("agent-a", input());
  await store.update("agent-a", task.id, { status: "running" });
  await store.update("agent-a", task.id, { progress: { percent: 25 } }, "progress");
  await store.update("agent-a", task.id, { status: "cancelled" });
  const late = await store.update("agent-a", task.id, { status: "completed", result: "late" });
  assert.equal(late.status, "cancelled"); assert.equal(late.result, null);
  const events = await store.events("agent-a", task.id, 2);
  assert.deepEqual(events.events.map((event) => event.type), ["progress", "cancelled"]);
});
test("restart interrupts pending work and retains completed output without replay", async (t) => {
  const { storage, store } = await fixture(t);
  const one = await store.create("agent-a", input()), two = await store.create("agent-a", input("mutation-456"));
  await store.update("agent-a", two.task.id, { status: "completed", result: { rows: 12 } });
  const restarted = new ApplicationTaskStore({ storage }); await restarted.ready;
  assert.equal((await restarted.get("agent-a", one.task.id)).status, "interrupted");
  assert.deepEqual((await restarted.get("agent-a", two.task.id)).result, { rows: 12 });
});
test("page drafts, business state, agents and group tasks have independent atomic versions", async (t) => {
  const { store } = await fixture(t);
  const updates = await Promise.allSettled([store.setState("agent-a", { state: { text: "a" }, expectedVersion: 0 }), store.setState("agent-a", { state: { text: "b" }, expectedVersion: 0 })]);
  assert.equal(updates.filter((value) => value.status === "fulfilled").length, 1);
  assert.equal(updates.find((value) => value.status === "rejected").reason.reason, "application_conflict");
  assert.deepEqual((await store.getState("agent-a", { kind: "business" })).state, {});
  assert.deepEqual((await store.getState("agent-a", { scope: "group:g:t" })).state, {});
  assert.deepEqual((await store.getState("agent-b")).state, {});
  await assert.rejects(store.getState("agent-a", { stateVersion: 2 }), /迁移/);
});
test("failed persistence never publishes task or state", async (t) => {
  const { store, storage } = await fixture(t); const original = storage.writeJson.bind(storage);
  storage.writeJson = async () => { throw new Error("simulated disk full"); };
  await assert.rejects(store.create("agent-a", input()), /disk full/);
  storage.writeJson = original;
  assert.equal((await store.list("agent-a")).length, 0);
});

function expandingValue() {
  let value = Array(50_000).fill(0);
  for (let depth = 0; depth < 10; depth++) value = { values: value };
  return value;
}

test("state limits include persisted indentation and envelope, rejected saves preserve the prior version", async (t) => {
  const { store, storage } = await fixture(t), state = expandingValue();
  assert.ok(Buffer.byteLength(JSON.stringify(state)) < 128_000);
  const previous = await store.setState("agent-a", { state: { text: "keep" }, expectedVersion: 0 });
  const file = await storage.path("agent-a", store.statePath("private", "draft")), bytes = await readFile(file);
  await assert.rejects(store.setState("agent-a", { state, expectedVersion: previous.version }), /大小限制/);
  assert.deepEqual(await readFile(file), bytes);
  assert.deepEqual(await store.getState("agent-a"), previous);
  const restarted = new ApplicationTaskStore({ storage }); await restarted.ready;
  assert.deepEqual(await restarted.getState("agent-a"), previous);
  assert.equal((await restarted.setState("agent-a", { state: { text: "continued" }, expectedVersion: previous.version })).version, 2);
});

test("task history refuses oversized persisted JSON before replacement and remains recoverable", async (t) => {
  const { store, storage } = await fixture(t), result = expandingValue();
  for (let index = 0; index < 5; index++) {
    const { task } = await store.create("agent-a", input(`mutation-${index}`));
    await store.update("agent-a", task.id, { status: "completed", result });
  }
  const { task } = await store.create("agent-a", input("mutation-last"));
  const file = await storage.path("agent-a", "application/tasks.json"), bytes = await readFile(file);
  assert.ok(bytes.length < 16 * 1024 * 1024);
  await assert.rejects(store.update("agent-a", task.id, { status: "completed", result }), /大小限制/);
  assert.deepEqual(await readFile(file), bytes);
  assert.equal((await store.get("agent-a", task.id)).status, "queued");
  const restarted = new ApplicationTaskStore({ storage }); await restarted.ready;
  const tasks = await restarted.list("agent-a");
  assert.equal(tasks.length, 6); assert.equal(tasks.at(-1).status, "interrupted");
  assert.deepEqual(tasks[0].result, result);
});

test("pending tasks reserve space for restart interruption before accepting a near-limit record", async (t) => {
  const { store, storage } = await fixture(t), { task } = await store.create("agent-a", input());
  const file = await storage.path("agent-a", "application/tasks.json"), previous = await readFile(file);
  const record = await store.record("agent-a"), pending = record.tasks[0];
  for (let index = 0; index < 139; index++) store.event(pending, "progress", { progress: "x".repeat(120_000) });
  store.event(pending, "progress", { progress: "" });
  const remaining = 16 * 1024 * 1024 - 50 - Buffer.byteLength(JSON.stringify(record, null, 2));
  assert.ok(remaining > 4096 && remaining < 120_000);
  pending.events.at(-1).progress = "x".repeat(remaining);
  await assert.rejects(store.save("agent-a", record), /大小限制/);
  assert.deepEqual(await readFile(file), previous);
  pending.events.at(-1).progress = pending.events.at(-1).progress.slice(0, -4096);
  await store.save("agent-a", record);
  const restarted = new ApplicationTaskStore({ storage }); await restarted.ready;
  assert.equal((await restarted.get("agent-a", task.id)).status, "interrupted");
  assert.equal((await restarted.events("agent-a", task.id)).latestSequence, pending.sequence + 1);
});

test("concurrent application file writes atomically retain every task artifact and event", async (t) => {
  const { store, storage } = await fixture(t), { task } = await store.create("agent-a", input());
  await store.update("agent-a", task.id, { status: "running" });
  const root = await storage.directory("agent-a", "workspace", { create: true });
  const owner = { applications: { store }, materials: { tools: () => [] } };
  const capability = await PrototypeAgents.prototype.applicationCapabilities.call(owner, {
    task, descriptor: { manifest: { stateVersion: 1 }, agent: { draft: {} } }, action: { connectionIds: [] },
    connectionSnapshot: { connections: [] }, workspaceRoot: root, signal: new AbortController().signal, check: async () => {},
  });
  const files = Array.from({ length: 8 }, (_, index) => `report-${index}.txt`);
  await Promise.all(files.map((file) => capability({ capability: "files.write", args: { file, content: file } })));
  assert.deepEqual((await readdir(root)).sort(), files);
  assert.deepEqual((await store.get("agent-a", task.id)).artifacts.map((file) => file.path).sort(), files);
  await capability({ capability: "files.write", args: { file: files[0], content: "updated" } });
  assert.equal((await store.get("agent-a", task.id)).artifacts.length, files.length);
  const { events } = await store.events("agent-a", task.id);
  const artifacts = events.filter((event) => event.type === "artifact");
  assert.equal(artifacts.length, files.length + 1);
  assert.deepEqual(artifacts.at(-1).artifacts.map((file) => file.path).sort(), files);
  await store.update("agent-a", task.id, { status: "cancelled" });
  const stopped = await store.get("agent-a", task.id);
  await store.appendArtifact("agent-a", task.id, { path: "late.txt" });
  assert.deepEqual(await store.get("agent-a", task.id), stopped);
});
