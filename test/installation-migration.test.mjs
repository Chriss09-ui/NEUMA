import test from "node:test";
import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateInstallation } from "../src/installation/installation-migration.mjs";
import { AgentStorage } from "../src/agents/agent-storage.mjs";
import { AgentLibrary } from "../src/agents/agent-library.mjs";
import { DevelopmentWorkspace, inspectDevelopmentCode } from "../src/development/development-workspace.mjs";
import { InputError } from "../src/requirements/core.mjs";

const date = "2026-10-04T00:00:00.000Z";
const definition = (id = "alpha") => ({ id, name: "迁移助手", draft: { goal: { value: "保留需求", source: "user" } },
  instructions: "按照已有需求处理", revision: 3, memory: "保留记忆", createdAt: date, updatedAt: date,
  profile: { name: "我的助手", description: "保留展示资料", icon: "📝" } });
const record = (snapshot, overrides = {}) => ({ id: "run_alpha", agentId: "alpha", version: 2, status: "running", revision: 4,
  createdAt: date, updatedAt: date, snapshot, verifiedSnapshot: snapshot, package: { snapshot },
  deliveries: [{ package: { snapshot } }], budget: { remaining: 3 }, ...overrides });
const noLock = async () => async () => {};

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "neuma-install-migration-")));
  const project = join(root, "旧版 中文 项目"), source = join(project, ".neuma"), dataDir = join(root, "新版 数据");
  await mkdir(source, { recursive: true });
  t.after(async () => {
    const writable = async (path) => {
      await chmod(path, 0o700);
      for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) await writable(join(path, entry.name));
    };
    await writable(root); await rm(root, { recursive: true, force: true });
  });
  return { root, project, source, dataDir, migrate: (options = {}) => migrateInstallation({ from: project, dataDir, acquireLock: noLock, ...options }) };
}

async function json(path, value) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

async function snapshotAt(root, agentId = "alpha", legacy = false) {
  const parent = legacy ? join(root, "development-snapshots") : join(root, "agents", agentId, "development", "snapshots");
  const initial = join(parent, "initial");
  await mkdir(initial, { recursive: true });
  await writeFile(join(initial, "index.mjs"), "console.log(JSON.stringify({value:process.argv[2]}));\n");
  const actual = await inspectDevelopmentCode(initial), path = join(parent, actual.hash);
  await rename(initial, path); await chmod(join(path, "index.mjs"), 0o444); await chmod(path, 0o555);
  return { ...(legacy ? {} : { agentId }), path, hash: actual.hash, files: actual.files };
}

async function noDestination(fixture) {
  await assert.rejects(readdir(fixture.dataDir), { code: "ENOENT" });
  assert.equal((await readdir(fixture.root)).some((name) => name.startsWith(".installation-migration-")), false);
}

const chatRecord = (id = "chat-one") => ({ schemaVersion: 3, id, agentId: "alpha", title: "保存历史", createdAt: date,
  updatedAt: date, saveVersion: 2, mutationId: "second-save", messages: [{ role: "user", content: "保存历史" },
    { role: "assistant", content: "完整结果", status: "complete" }] });

test("installation migration preserves multi-conversation records and tombstones without reviving legacy saved data", async (t) => {
  const f = await fixture(t);
  await json(join(f.source, "agents-layout.json"), { version: 1 });
  await json(join(f.source, "agents/alpha/definition.json"), { version: 1, agent: definition() });
  await json(join(f.source, "agents/alpha/conversations/records/chat-one.json"), chatRecord());
  const tombstone = { schemaVersion: 3, id: "legacy-saved", agentId: "alpha", deletedAt: date };
  await json(join(f.source, "agents/alpha/conversations/records/legacy-saved.json"), tombstone);
  await json(join(f.source, "agents/alpha/conversations/saved.json"), { schemaVersion: 2, messages: [{ role: "user", content: "已删除旧内容" }] });
  await f.migrate();
  const library = new AgentLibrary({ dataDir: f.dataDir });
  assert.deepEqual((await library.listConversations("alpha")).conversations.map((item) => item.id), ["chat-one"]);
  assert.deepEqual(await library.getConversationRecord("alpha", "chat-one"), { conversation: chatRecord() });
  assert.deepEqual(await library.getConversationRecord("alpha", "legacy-saved"), { conversation: null, deleted: true });
  assert.deepEqual(await library.storage.readJson("alpha", "conversations/records/legacy-saved.json"), tombstone);
  assert.deepEqual(JSON.parse(await readFile(join(f.source, "agents/alpha/conversations/records/chat-one.json"), "utf8")), chatRecord());
});

test("installation migration rejects invalid conversation identity, tombstones and byte budgets", async (t) => {
  for (const value of [chatRecord("different-id"), { ...chatRecord(), agentId: "another" },
    { ...chatRecord(), title: "伪造标题" }, { schemaVersion: 3, id: "chat-one", agentId: "alpha", deletedAt: date, messages: [] }]) {
    const f = await fixture(t);
    await json(join(f.source, "agents-layout.json"), { version: 1 });
    await json(join(f.source, "agents/alpha/conversations/records/chat-one.json"), value);
    await assert.rejects(f.migrate(), InputError);
    await noDestination(f);
  }
  const f = await fixture(t);
  await json(join(f.source, "agents-layout.json"), { version: 1 });
  await json(join(f.source, "agents/alpha/conversations/records/chat-one.json"), chatRecord());
  await assert.rejects(f.migrate({ maxJsonBytes: 100 }), /元数据超过大小限制/);
  await noDestination(f);
});

test("current Agent layout migrates controlled references and preserves identities, state and business values", async (t) => {
  const f = await fixture(t), snapshot = await snapshotAt(f.source);
  const business = { path: snapshot.path, hash: snapshot.hash, files: snapshot.files, agentId: "business" };
  const run = record(snapshot, { reports: [{ results: [{ actual: business }] }], architecture: { example: business } });
  await json(join(f.source, "agents-layout.json"), { version: 1 });
  await json(join(f.source, "agents/alpha/definition.json"), { version: 1, agent: definition() });
  await json(join(f.source, "agents/alpha/requirements.json"), { id: "alpha", name: "迁移助手", draft: definition().draft, updatedAt: date });
  await json(join(f.source, "agents/alpha/architecture.json"), { version: 1, records: [{ agentId: "alpha", version: 2, status: "evaluating" }] });
  await json(join(f.source, "agents/alpha/conversations/saved.json"), { schemaVersion: 2, messages: [{ role: "user", content: "已保存对话" }] });
  await json(join(f.source, "agents/alpha/development/records/run_alpha.json"), run);
  await json(join(f.source, "agents/deleted/deleted.json"), { id: "deleted", deletedAt: date });
  await json(join(f.source, "projects.json"), { version: 1, projects: [{ id: "external", root: "/unchanged/external/project" }] });
  await json(join(f.source, "agents/alpha/workspace/business.json"), business);
  await mkdir(join(f.source, "agents/alpha/workspace/pi"));
  await writeFile(join(f.source, "agents/alpha/workspace/pi/user.md"), "用户目录不是 SDK 缓存");
  const original = await readFile(join(f.source, "agents/alpha/development/records/run_alpha.json"));
  const migrated = await f.migrate();
  assert.equal(migrated.agents, 2);
  const storage = new AgentStorage({ dataDir: f.dataDir }); await storage.ready;
  const restored = await storage.readJson("alpha", "development/records/run_alpha.json");
  assert.equal(restored.status, "running"); assert.equal(restored.revision, 4); assert.deepEqual(restored.budget, run.budget);
  for (const reference of [restored.snapshot, restored.verifiedSnapshot, restored.package.snapshot, restored.deliveries[0].package.snapshot]) {
    assert.equal(reference.path, join(f.dataDir, "agents/alpha/development/snapshots", snapshot.hash));
    assert.equal((await new DevelopmentWorkspace({ dataDir: f.dataDir }).validateSnapshot(reference, "alpha")).hash, snapshot.hash);
  }
  assert.deepEqual(restored.reports, run.reports); assert.deepEqual(restored.architecture, run.architecture);
  assert.deepEqual((await storage.readJson("alpha", "definition.json")).agent, definition());
  assert.equal((await storage.readJson("alpha", "architecture.json")).records[0].status, "evaluating");
  assert.deepEqual(await storage.readJson("deleted", "deleted.json"), { id: "deleted", deletedAt: date });
  assert.equal((await storage.readJson("alpha", "conversations/saved.json")).messages[0].content, "已保存对话");
  assert.deepEqual(JSON.parse(await readFile(join(f.dataDir, "agents/alpha/workspace/business.json"), "utf8")), business);
  assert.equal(await readFile(join(f.dataDir, "agents/alpha/workspace/pi/user.md"), "utf8"), "用户目录不是 SDK 缓存");
  assert.equal(JSON.parse(await readFile(join(f.dataDir, "projects.json"), "utf8")).projects[0].root, "/unchanged/external/project");
  assert.deepEqual(await readFile(join(f.source, "agents/alpha/development/records/run_alpha.json")), original);
});

test("flat layout normalizes only staging and preserves source metadata and workspace files", async (t) => {
  const f = await fixture(t), snapshot = await snapshotAt(f.source, "alpha", true), run = record(snapshot);
  await json(join(f.source, "agents.json"), { version: 1, agents: [definition()] });
  await json(join(f.source, "development/run_alpha.json"), run);
  await mkdir(join(f.source, "agent-workspaces/alpha"), { recursive: true });
  await writeFile(join(f.source, "agent-workspaces/alpha/result.md"), "原产物");
  const sourceBytes = await readFile(join(f.source, "development/run_alpha.json"));
  await f.migrate({ from: f.source });
  await assert.rejects(readdir(join(f.source, "agents")), { code: "ENOENT" });
  assert.deepEqual(await readFile(join(f.source, "development/run_alpha.json")), sourceBytes);
  const storage = new AgentStorage({ dataDir: f.dataDir }); await storage.ready;
  const migrated = await storage.readJson("alpha", "development/records/run_alpha.json");
  assert.equal(migrated.snapshot.agentId, "alpha"); assert.equal(migrated.status, "running");
  assert.equal((await new DevelopmentWorkspace({ dataDir: f.dataDir }).validateSnapshot(migrated.snapshot)).hash, snapshot.hash);
  assert.equal(await readFile(join(f.dataDir, "agents/alpha/workspace/result.md"), "utf8"), "原产物");
});

test("migration excludes model configuration, credentials, Pi caches and pending runtime files", async (t) => {
  const f = await fixture(t);
  await json(join(f.source, "agents-layout.json"), { version: 1 });
  await json(join(f.source, "agents/alpha/definition.json"), { version: 1, agent: definition() });
  for (const path of [".env", ".env.local", ".npmrc", "credentials.json", "pi/auth.json", "agents/alpha/pi/auth.json", ".pending-stale.json"])
    await json(join(f.source, path), { fixture: "not-a-real-key" });
  const result = await f.migrate();
  assert.equal(result.skipped, 7);
  for (const path of [".env", ".env.local", ".npmrc", "credentials.json", "pi", "agents/alpha/pi", ".pending-stale.json"])
    await assert.rejects(readFile(join(f.dataDir, path)), { code: "ENOENT" });
  assert.equal((await readdir(f.source)).includes(".env"), true);
});

test("nonempty target and overlapping roots are rejected without overwriting files", async (t) => {
  const f = await fixture(t);
  await json(join(f.source, "agents.json"), { version: 1, agents: [definition()] });
  await mkdir(f.dataDir); await writeFile(join(f.dataDir, "keep.md"), "已有数据");
  await assert.rejects(f.migrate(), /已有内容/);
  assert.equal(await readFile(join(f.dataDir, "keep.md"), "utf8"), "已有数据");
  for (const dataDir of [f.source, join(f.source, "inside"), f.project]) await assert.rejects(f.migrate({ dataDir }), /互相包含/);
});

test("symbolic and hard links abort before publication and retain original files", async (t) => {
  for (const kind of ["symbolic", "hard"]) {
    const f = await fixture(t);
    await json(join(f.source, "agents.json"), { version: 1, agents: [definition()] });
    const original = join(f.root, "outside.md"); await writeFile(original, "链接源");
    if (kind === "symbolic") await symlink(original, join(f.source, "linked.md"));
    else await link(original, join(f.source, "linked.md"));
    await assert.rejects(f.migrate(), /包含链接/);
    await noDestination(f); assert.equal(await readFile(original, "utf8"), "链接源");
  }
});

test("bad snapshot content or identity aborts atomically and corrected source can be retried", async (t) => {
  const f = await fixture(t), snapshot = await snapshotAt(f.source);
  await json(join(f.source, "agents-layout.json"), { version: 1 });
  await json(join(f.source, "agents/alpha/development/records/run_alpha.json"), record({ ...snapshot, agentId: "other" }));
  await assert.rejects(f.migrate(), /身份无效/); await noDestination(f);
  await json(join(f.source, "agents/alpha/development/records/run_alpha.json"), record({ ...snapshot, files: [] }));
  await assert.rejects(f.migrate(), /校验失败/); await noDestination(f);
  await json(join(f.source, "agents/alpha/development/records/run_alpha.json"), record(snapshot));
  await mkdir(f.dataDir);
  assert.equal((await f.migrate()).agents, 1);
});

test("snapshot references cannot point to external code even when a matching snapshot exists", async (t) => {
  const f = await fixture(t), snapshot = await snapshotAt(f.source);
  await json(join(f.source, "agents-layout.json"), { version: 1 });
  await json(join(f.source, "agents/alpha/development/records/run_alpha.json"), record({ ...snapshot, path: join(f.root, snapshot.hash) }));
  await assert.rejects(f.migrate(), /路径或 Agent 身份无效/); await noDestination(f);
});

test("resource budgets and damaged metadata stop migration without leaving a target or staging", async (t) => {
  const f = await fixture(t);
  await json(join(f.source, "agents.json"), { version: 1, agents: [definition()] });
  for (const options of [{ maxBytes: 1 }, { maxFileBytes: 1 }, { maxJsonBytes: 1 }, { maxFiles: 1 }]) {
    await assert.rejects(f.migrate(options), InputError); await noDestination(f);
  }
  await writeFile(join(f.source, "agents.json"), "{ damaged");
  await assert.rejects(f.migrate(), InputError); await noDestination(f);
});

test("locks are acquired in path order, both release on failure, and source is never initialized", async (t) => {
  const f = await fixture(t), acquired = [], released = [];
  await json(join(f.source, "agents.json"), { version: 1, agents: [definition()] });
  const acquireLock = async (path) => { acquired.push(path); return async () => { released.push(path); }; };
  await assert.rejects(f.migrate({ acquireLock, maxBytes: 1 }), InputError);
  assert.deepEqual(acquired, [f.source, f.dataDir].sort()); assert.deepEqual(released, acquired.slice().reverse());
  await assert.rejects(readFile(join(f.source, "agents-layout.json")), { code: "ENOENT" });
  await noDestination(f);
});

test("preexisting service lock and cancellation leave all data unmodified", async (t) => {
  const f = await fixture(t), released = [];
  await json(join(f.source, "agents.json"), { version: 1, agents: [definition()] });
  const acquireLock = async (path) => {
    if (path === [f.source, f.dataDir].sort()[1]) throw new InputError("服务仍在运行");
    return async () => { released.push(path); };
  };
  await assert.rejects(f.migrate({ acquireLock }), /仍在运行/); assert.equal(released.length, 1); await noDestination(f);
  const controller = new AbortController(); controller.abort(new Error("取消迁移"));
  await assert.rejects(f.migrate({ signal: controller.signal }), /取消迁移/); await noDestination(f);
});
