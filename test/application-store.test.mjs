import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStorage } from "../src/agents/agent-storage.mjs";
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
  await assert.rejects(store.create("agent-a", { ...input(), input: { different: true } }), { reason: "application_conflict" });
  assert.equal((await store.list("agent-a")).length, 1);
  assert.equal((await store.list("agent-b")).length, 0);
  await assert.rejects(store.get("agent-b", submissions[0].task.id), /没有找到/);
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
