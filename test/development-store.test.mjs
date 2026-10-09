import assert from "node:assert/strict";
import test from "node:test";
import { link, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputError } from "../src/requirements/core.mjs";
import { DevelopmentStore } from "../src/development/development-store.mjs";

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "neuma-development-store-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new DevelopmentStore({ dataDir });
  await store.ready;
  return { dataDir, store, directory: join(dataDir, "agents", "agent_one", "development", "records") };
}

const record = (id = "dev_first", overrides = {}) => ({ id, agentId: "agent_one", version: 1,
  status: "running", phase: "developing", budget: { remaining: 4 }, tasks: [{ id: "task_one", status: "running" }], ...overrides });

test("stores deep snapshots and returns isolated records", async (t) => {
  const { store, directory } = await fixture(t);
  const input = record(); const pending = store.create(input);
  input.budget.remaining = 0;
  const created = await pending;
  assert.equal(created.revision, 1); assert.equal(created.budget.remaining, 4);
  created.tasks[0].status = "passed";
  const found = await store.getRun(created.id);
  assert.equal(found.tasks[0].status, "running");
  found.budget.remaining = 1;
  assert.equal((await store.get("agent_one")).budget.remaining, 4);
  assert.equal(JSON.parse(await readFile(join(directory, "dev_first.json"), "utf8")).budget.remaining, 4);
});

test("get returns latest created run even if an old run was updated later", async (t) => {
  const { store } = await fixture(t);
  const first = await store.create(record());
  const second = await store.create(record("dev_second"));
  await store.save({ ...first, status: "failed" });
  assert.equal((await store.get("agent_one")).id, second.id);
  assert.deepEqual((await store.list("agent_one")).map((item) => item.id), ["dev_second", "dev_first"]);
  assert.ok(Date.parse(second.createdAt) > Date.parse(first.createdAt));
  assert.equal(await store.get("absent"), null); assert.equal(await store.getRun("absent"), null);
  await assert.rejects(store.create(record()), InputError);
});

test("queued writes enforce revisions so stale results cannot overwrite cancellation", async (t) => {
  const { store, directory } = await fixture(t);
  const initial = await store.create(record());
  const cancelled = store.save({ ...initial, status: "cancelled" });
  const stale = store.save({ ...initial, status: "completed" });
  await assert.rejects(stale, (error) => error instanceof InputError && error.code === "DEVELOPMENT_REVISION_CONFLICT");
  const saved = await cancelled;
  assert.equal(saved.revision, 2); assert.equal((await store.getRun(initial.id)).status, "cancelled");
  assert.equal(JSON.parse(await readFile(join(directory, `${initial.id}.json`), "utf8")).status, "cancelled");
  await assert.rejects(store.save({ ...saved, status: "completed" }, { expectedRevision: 1 }), InputError);
});

test("save maintains immutable identity and creation time", async (t) => {
  const { store } = await fixture(t);
  const initial = await store.create(record());
  await assert.rejects(store.save({ ...initial, agentId: "other" }), InputError);
  await assert.rejects(store.save({ ...initial, version: 2 }), InputError);
  await assert.rejects(store.save({ ...initial, id: "unknown" }), InputError);
  const saved = await store.save({ ...initial, createdAt: "2001-01-01", phase: "verifying" });
  assert.equal(saved.createdAt, initial.createdAt); assert.equal(saved.revision, 2);
  assert.equal(saved.phase, "verifying");
});

test("restart marks active work interrupted and durably preserves checkpoints and budgets", async (t) => {
  const { dataDir, store, directory } = await fixture(t);
  const running = await store.create(record());
  const completed = await store.create(record("dev_complete", { status: "completed" }));
  const restored = new DevelopmentStore({ dataDir }); await restored.ready;
  const found = await restored.getRun(running.id);
  assert.equal(found.status, "interrupted"); assert.equal(found.phase, "developing");
  assert.equal(found.budget.remaining, 4); assert.deepEqual(found.tasks, running.tasks);
  assert.equal(found.revision, running.revision + 1);
  assert.equal((await restored.getRun(completed.id)).status, "completed");
  assert.equal(JSON.parse(await readFile(join(directory, `${running.id}.json`), "utf8")).status, "interrupted");
  const secondRestart = new DevelopmentStore({ dataDir }); await secondRestart.ready;
  assert.equal((await secondRestart.getRun(running.id)).revision, found.revision);
});

test("corrupt records fail closed without modifying other records", async (t) => {
  const { dataDir, store, directory } = await fixture(t);
  const valid = await store.create(record());
  await writeFile(join(directory, "dev_broken.json"), "{broken}");
  const restored = new DevelopmentStore({ dataDir });
  await assert.rejects(restored.ready, /研发记录已损坏/);
  await assert.rejects(restored.get("agent_one"), InputError);
  assert.equal(JSON.parse(await readFile(join(directory, `${valid.id}.json`), "utf8")).status, "running");
  assert.equal(await readFile(join(directory, "dev_broken.json"), "utf8"), "{broken}");
});

test("record filenames must match valid identities and reject symlinks", async (t) => {
  const { dataDir, store, directory } = await fixture(t);
  const valid = await store.create(record());
  await writeFile(join(directory, "dev_alias.json"), JSON.stringify(valid));
  await assert.rejects(new DevelopmentStore({ dataDir }).ready, InputError);
  await rm(join(directory, "dev_alias.json"));
  await symlink(join(directory, `${valid.id}.json`), join(directory, "dev_link.json"));
  await assert.rejects(new DevelopmentStore({ dataDir }).ready, InputError);
});

test("hardlinked metadata cannot be loaded or replaced and preserves the original checkpoint", async (t) => {
  const { dataDir, store, directory } = await fixture(t);
  const initial = await store.create(record());
  const target = join(directory, `${initial.id}.json`), alias = join(dataDir, "outside-record.json");
  const original = await readFile(target, "utf8");
  await link(target, alias);
  await assert.rejects(new DevelopmentStore({ dataDir }).ready, /研发记录已损坏/);
  await assert.rejects(store.save({ ...initial, status: "completed" }), /未能保存/);
  assert.equal((await store.getRun(initial.id)).status, "running");
  assert.equal(await readFile(target, "utf8"), original);
  assert.equal(await readFile(alias, "utf8"), original);
  await rm(alias);
  assert.equal((await store.save({ ...initial, status: "completed" })).status, "completed");
});

test("unpublished temporary files do not become checkpoints", async (t) => {
  const { dataDir, store, directory } = await fixture(t);
  await store.create(record("dev_complete", { status: "completed" }));
  await writeFile(join(directory, "dev_partial.abcd.tmp"), "{incomplete}");
  await writeFile(join(directory, ".pending-8e4a1763-f71d-4690-b612-5dce58b0eae6.json"), "{incomplete}");
  const restored = new DevelopmentStore({ dataDir }); await restored.ready;
  assert.equal((await restored.list("agent_one")).length, 1);
});

test("remove deletes only that agent metadata and blocks subsequent stale saves", async (t) => {
  const { dataDir, store, directory } = await fixture(t);
  const initial = await store.create(record());
  await store.create(record("dev_another"));
  await store.create(record("dev_other", { agentId: "agent_two", status: "completed" }));
  await mkdir(join(directory, "workspaces"));
  await writeFile(join(directory, "workspaces", "user-file.txt"), "keep");
  await store.remove("agent_one");
  assert.equal(await store.get("agent_one"), null);
  assert.equal((await store.get("agent_two")).id, "dev_other");
  assert.equal(await readFile(join(directory, "workspaces", "user-file.txt"), "utf8"), "keep");
  assert.deepEqual((await readdir(directory)).sort(), ["workspaces"]);
  assert.equal(JSON.parse(await readFile(join(dataDir, "agents", "agent_two", "development", "records", "dev_other.json"), "utf8")).agentId, "agent_two");
  await assert.rejects(store.save(initial), /迟到结果/);
});

test("records are stored inside their Agent folder and reject a mismatched owner on restart", async (t) => {
  const { dataDir, store, directory } = await fixture(t);
  const saved = await store.create(record("dev_one", { status: "completed" }));
  const other = await store.create(record("dev_two", { agentId: "agent_two", status: "completed" }));
  assert.equal(JSON.parse(await readFile(join(directory, `${saved.id}.json`), "utf8")).agentId, saved.agentId);
  const otherDirectory = join(dataDir, "agents", "agent_two", "development", "records");
  assert.equal(JSON.parse(await readFile(join(otherDirectory, `${other.id}.json`), "utf8")).agentId, other.agentId);
  await writeFile(join(otherDirectory, `${saved.id}.json`), JSON.stringify(saved));
  await assert.rejects(new DevelopmentStore({ dataDir }).ready, /研发记录已损坏/);
  assert.equal((await store.get("agent_one")).id, saved.id);
});

test("deleted Agents do not regain leftover development metadata on restart", async (t) => {
  const { dataDir, store, directory } = await fixture(t);
  const deleted = await store.create(record());
  const other = await store.create(record("dev_other", { agentId: "agent_two", status: "completed" }));
  await store.storage.writeJson("agent_one", "deleted.json", { version: 1, deletedAt: new Date().toISOString() });
  const restarted = new DevelopmentStore({ dataDir }); await restarted.ready;
  assert.equal(await restarted.get("agent_one"), null);
  assert.equal(await restarted.getRun(deleted.id), null);
  assert.equal((await restarted.get("agent_two")).id, other.id);
  assert.equal(JSON.parse(await readFile(join(directory, `${deleted.id}.json`), "utf8")).status, "running");
});

test("unsafe IDs and invalid records cannot address arbitrary files", async (t) => {
  const { store } = await fixture(t);
  for (const id of ["../outside", "/tmp/outside", ".hidden", "", "x/y", "x\\y", "x\0y"]) {
    assert.throws(() => store.create(record(id)), InputError);
    assert.throws(() => store.create(record("valid", { agentId: id })), InputError);
    await assert.rejects(store.getRun(id), InputError);
    await assert.rejects(store.list(id), InputError);
    assert.throws(() => store.remove(id), InputError);
  }
  for (const value of [null, {}, record("valid", { version: -1 }), record("valid", { status: "" }), record("valid", { bad: undefined })]) {
    assert.throws(() => store.create(value), InputError);
  }
});

test("failed atomic replacement preserves memory and can be retried", async (t) => {
  const { store, directory } = await fixture(t);
  const initial = await store.create(record());
  const target = join(directory, `${initial.id}.json`);
  await rm(target); await mkdir(target);
  await assert.rejects(store.save({ ...initial, status: "completed" }), /未能保存/);
  assert.equal((await store.getRun(initial.id)).status, "running");
  assert.equal((await readdir(directory)).some((name) => name.endsWith(".tmp") || name.startsWith(".pending-")), false);
  await rm(target, { recursive: true });
  const saved = await store.save({ ...initial, status: "completed" });
  assert.equal(saved.revision, 2); assert.equal(saved.status, "completed");
});
