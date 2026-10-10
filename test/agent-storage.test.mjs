import test from "node:test";
import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStorage } from "../src/agents/agent-storage.mjs";
import { AgentLibrary } from "../src/agents/agent-library.mjs";
import { DevelopmentStore } from "../src/development/development-store.mjs";
import { DevelopmentWorkspace, inspectDevelopmentCode } from "../src/development/development-workspace.mjs";
import { InputError } from "../src/requirements/core.mjs";

async function fixture(t) {
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), "neuma-agent-storage-")));
  t.after(async () => {
    const writable = async (path) => {
      await chmod(path, 0o700);
      for (const item of await readdir(path, { withFileTypes: true }))
        if (item.isDirectory() && !item.isSymbolicLink()) await writable(join(path, item.name));
    };
    await writable(dataDir); await rm(dataDir, { recursive: true, force: true });
  });
  return dataDir;
}

const date = "2026-10-04T00:00:00.000Z";
const definition = (id = "alpha", overrides = {}) => ({ id, name: "助手", draft: { goal: { value: "旧需求", source: "user" } },
  instructions: "根据材料处理任务", revision: 1, fingerprint: "unchanged", memory: "记忆", createdAt: date, updatedAt: date, ...overrides });
const record = (id = "dev_alpha", overrides = {}) => ({ id, agentId: "alpha", status: "completed", revision: 1,
  createdAt: date, updatedAt: date, budget: { remaining: 3 }, ...overrides });

test("legacy definitions, architecture, code, snapshots and files migrate together without changing sources", async (t) => {
  const dataDir = await fixture(t), definitions = { version: 1, agents: [definition(), definition("beta")] };
  const raw = JSON.stringify(definitions);
  await writeFile(join(dataDir, "agents.json"), raw);
  await writeFile(join(dataDir, "architectures.json"), JSON.stringify({ version: 1, records: [
    { agentId: "alpha", name: "助手", draft: definitions.agents[0].draft, version: 1, status: "passed", createdAt: date },
  ] }));
  await mkdir(join(dataDir, "agent-workspaces/alpha"), { recursive: true });
  await writeFile(join(dataDir, "agent-workspaces/alpha/result.md"), "已生成产物");
  const source = join(dataDir, "development-snapshots/code");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "index.mjs"), "console.log(JSON.stringify({value:process.argv[2]}));\n");
  const code = await inspectDevelopmentCode(source), path = join(dataDir, "development-snapshots", code.hash);
  await rename(source, path); await chmod(join(path, "index.mjs"), 0o444); await chmod(path, 0o555);
  const snapshot = { path, hash: code.hash, files: code.files };
  await mkdir(join(dataDir, "development"));
  for (const id of ["alpha", "beta"]) {
    const run = record(`dev_${id}`, { agentId: id, snapshot, verifiedSnapshot: snapshot, package: { snapshot }, deliveries: [{ package: { snapshot } }] });
    await writeFile(join(dataDir, "development", run.id + ".json"), JSON.stringify(run));
    await mkdir(join(dataDir, "development-workspaces", run.id, "code"), { recursive: true });
    await writeFile(join(dataDir, "development-workspaces", run.id, "code", "index.mjs"), "working code");
  }
  const storage = new AgentStorage({ dataDir }), store = new DevelopmentStore({ dataDir });
  await Promise.all([storage.ready, store.ready]);
  assert.deepEqual(await storage.agentIds(), ["alpha", "beta"]);
  assert.deepEqual((await storage.readJson("alpha", "definition.json")).agent, definitions.agents[0]);
  assert.equal(await readFile(join(dataDir, "agents.json"), "utf8"), raw);
  assert.equal(await readFile(join(await storage.directory("alpha", "workspace"), "result.md"), "utf8"), "已生成产物");
  const workspace = new DevelopmentWorkspace({ dataDir });
  const migrated = await store.getRun("dev_alpha");
  for (const value of [migrated.snapshot, migrated.verifiedSnapshot, migrated.package.snapshot, migrated.deliveries[0].package.snapshot]) {
    assert.equal(value.agentId, "alpha");
    assert.equal(value.path, join(dataDir, "agents/alpha/development/snapshots", code.hash));
    assert.equal((await workspace.validateSnapshot(value, "alpha")).hash, code.hash);
  }
  const other = await store.getRun("dev_beta");
  assert.notEqual(other.snapshot.path, migrated.snapshot.path);
  await assert.rejects(workspace.validateSnapshot(other.snapshot, "alpha"), InputError);
  const executed = await promisify(execFile)(process.execPath, [join(migrated.snapshot.path, "index.mjs"), "迁移后的输入"]);
  assert.deepEqual(JSON.parse(executed.stdout), { value: "迁移后的输入" });
  assert.equal(migrated.budget.remaining, 3);
});

test("completed migration and partial publication retry preserve newer Agent data", async (t) => {
  const dataDir = await fixture(t);
  await writeFile(join(dataDir, "agents.json"), JSON.stringify({ version: 1, agents: [definition()] }));
  const first = new AgentStorage({ dataDir }); await first.ready;
  await first.writeJson("alpha", "definition.json", { version: 1, agent: definition("alpha", { memory: "新版记忆" }) });
  await rm(join(dataDir, "agents-layout.json"));
  const resumed = new AgentStorage({ dataDir }); await resumed.ready;
  assert.equal((await resumed.readJson("alpha", "definition.json")).agent.memory, "新版记忆");
  await resumed.removeFile("alpha", "definition.json");
  const restarted = new AgentStorage({ dataDir }); await restarted.ready;
  assert.equal(await restarted.readJson("alpha", "definition.json"), null);
});

test("migration preserves business JSON that resembles snapshot references", async (t) => {
  const dataDir = await fixture(t);
  const business = { path: "manifest.json", hash: "business-hash", files: ["a.txt"] };
  const run = record("dev_alpha", {
    reports: [{ status: "passed", results: [{ caseId: "manifest", status: "passed", actual: business, output: business }] }],
    feedback: { report: { results: [{ actual: business }] } },
    architecture: { draft: { goal: { value: "生成文件清单" }, example: business } },
  });
  await mkdir(join(dataDir, "development"));
  await writeFile(join(dataDir, "development", run.id + ".json"), JSON.stringify(run));
  const storage = new AgentStorage({ dataDir }); await storage.ready;
  assert.deepEqual(await storage.readJson("alpha", "development/records/dev_alpha.json"), run);
});

test("invalid legacy metadata fails before publication and can be corrected and retried", async (t) => {
  for (const invalid of [{ memory: 42 }, { profile: { name: "", description: "", icon: "" } },
    { draft: { goal: { value: "x" }, excess: "x".repeat(60000) } }]) {
    const dataDir = await fixture(t), path = join(dataDir, "agents.json");
    await writeFile(path, JSON.stringify({ version: 1, agents: [definition("alpha", invalid)] }));
    await assert.rejects(new AgentStorage({ dataDir }).ready, InputError);
    await assert.rejects(readFile(join(dataDir, "agents-layout.json")), { code: "ENOENT" });
    await writeFile(path, JSON.stringify({ version: 1, agents: [definition()] }));
    const corrected = new AgentStorage({ dataDir }); await corrected.ready;
    assert.equal((await corrected.readJson("alpha", "definition.json")).agent.memory, "记忆");
  }
  for (const invalid of [{ status: "" }, { version: -1 }, { createdAt: 123 }]) {
    const dataDir = await fixture(t); await mkdir(join(dataDir, "development"));
    const path = join(dataDir, "development/dev_alpha.json");
    await writeFile(path, JSON.stringify(record("dev_alpha", invalid)));
    await assert.rejects(new AgentStorage({ dataDir }).ready, InputError);
    await assert.rejects(readFile(join(dataDir, "agents-layout.json")), { code: "ENOENT" });
  }
});

test("linked legacy files abort all publication and retain the sources", async (t) => {
  for (const kind of ["symbolic", "hard"]) {
    const dataDir = await fixture(t);
    await writeFile(join(dataDir, "agents.json"), JSON.stringify({ version: 1, agents: [definition(), definition("beta")] }));
    await mkdir(join(dataDir, "agent-workspaces/beta"), { recursive: true });
    const original = join(dataDir, "original.md"); await writeFile(original, "保留文件");
    const target = join(dataDir, "agent-workspaces/beta/linked.md");
    if (kind === "symbolic") await symlink(original, target); else await link(original, target);
    await assert.rejects(new AgentStorage({ dataDir }).ready, InputError);
    assert.deepEqual(await readdir(join(dataDir, "agents")), []);
    assert.equal(await readFile(original, "utf8"), "保留文件");
    assert.equal((await readdir(dataDir)).some((name) => name.startsWith(".agents-migration-")), false);
    await assert.rejects(readFile(join(dataDir, "agents-layout.json")), { code: "ENOENT" });
  }
});

test("Agent paths and metadata reject traversal, directory links and linked files", async (t) => {
  const dataDir = await fixture(t), storage = new AgentStorage({ dataDir }); await storage.ready;
  await storage.writeJson("alpha", "definition.json", { version: 1, agent: definition() });
  for (const id of ["../outside", ".", "", "beta/other"]) await assert.rejects(storage.directory(id), InputError);
  await assert.rejects(storage.writeJson("alpha", "../outside.json", {}), InputError);
  const outside = join(dataDir, "outside.json"); await writeFile(outside, "{}");
  const file = join(dataDir, "agents/alpha/linked.json");
  await link(outside, file);
  await assert.rejects(storage.readJson("alpha", "linked.json"), InputError);
  await assert.rejects(storage.writeJson("alpha", "linked.json", {}), InputError);
  await symlink(join(dataDir, "agents/alpha"), join(dataDir, "agents/beta"));
  await assert.rejects(storage.directory("beta"), InputError);
  await assert.rejects(storage.agentIds(), InputError);
});

test("conversation enumeration rejects non-files, linked records and unsafe names", async (t) => {
  const dataDir = await fixture(t), storage = new AgentStorage({ dataDir }); await storage.ready;
  assert.deepEqual(await storage.jsonFiles("alpha", "conversations/records"), []);
  await storage.writeJson("alpha", "conversations/records/chat-one.json", {});
  await assert.rejects(storage.readJson("alpha", "conversations/records/chat-one.json", { maxBytes: 1 }), /超过大小限制/);
  const root = await storage.directory("alpha", "conversations/records");
  await writeFile(join(root, ".pending-unfinished.json"), "{ partial");
  assert.deepEqual(await storage.jsonFiles("alpha", "conversations/records"), ["chat-one.json"]);
  await symlink(join(root, "chat-one.json"), join(root, "linked.json"));
  await assert.rejects(storage.jsonFiles("alpha", "conversations/records"), InputError);
  await rm(join(root, "linked.json"));
  await mkdir(join(root, "directory.json"));
  await assert.rejects(storage.jsonFiles("alpha", "conversations/records"), InputError);
  await rm(join(root, "directory.json"), { recursive: true });
  await writeFile(join(root, "unsafe name.json"), "{}");
  await assert.rejects(storage.jsonFiles("alpha", "conversations/records"), InputError);
});

test("deletion retains files and cannot be undone by legacy metadata on restart", async (t) => {
  const dataDir = await fixture(t);
  await writeFile(join(dataDir, "agents.json"), JSON.stringify({ version: 1, agents: [definition()] }));
  const storage = new AgentStorage({ dataDir }), library = new AgentLibrary({ dataDir, storage }); await storage.ready;
  const workspace = await storage.directory("alpha", "workspace", { create: true });
  await writeFile(join(workspace, "result.md"), "保留产物");
  await library.remove("alpha"); await storage.removeFile("alpha", "definition.json");
  const restored = new AgentLibrary({ dataDir });
  assert.deepEqual(await restored.list(), { requirements: [] });
  assert.deepEqual(await restored.saveRequirement("alpha", { ...definition(), importOnly: true }), { requirement: null, deleted: true });
  assert.equal(await readFile(join(workspace, "result.md"), "utf8"), "保留产物");
});
