import { callFixture, fixtureText } from "../helpers/m7-test-boundaries.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import type { HttpResponse } from "../../src/runtime/http-port.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentStorage } from "../../src/agents/agent-storage.mjs";
import { PrototypeAgents } from "../../src/agents/agent-prototype.mjs";
import { ApplicationTaskStore } from "../../src/applications/task-store.mjs";
import { routeApplication } from "../../src/applications/application-api.mjs";
import { readTaskArtifactSnapshot, saveTaskArtifact, TASK_ARTIFACT_PAGE_BYTES } from "../../src/applications/task-artifacts.mjs";

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "neuma-task-artifacts-"))), storage = new AgentStorage({ dataDir: join(root, "data") });
  const store = new ApplicationTaskStore({ storage }), workspace = join(root, "workspace");
  await mkdir(workspace); await store.ready;
  const agents = Object.assign(Object.create(PrototypeAgents.prototype) as Pick<PrototypeAgents, "applicationCapabilities" | "readTaskArtifact">, { storage, applications: { store },
    requireAgent: async (id: string) => ({ id }), workspace: async () => workspace });
  const create = async (number: number, scope = "private") => (await store.create("agent_1", { mutationId: `mutation_${number}`, actionId: "compute", input: {},
    deliveryVersion: "delivery_1", revision: 1, source: { kind: "application", scope } })).task;
  const writer = async (task: Parameters<PrototypeAgents["applicationCapabilities"]>[0]["task"], { signal = new AbortController().signal, check = async () => {} } = {}) => callFixture(agents.applicationCapabilities, agents, [{ task,
    descriptor: { manifest: { stateVersion: 1 }, agent: { draft: { constraints: [] } } }, action: { connectionIds: [] },
    connectionSnapshot: {}, materialTools: [], signal, check }]);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return { root, workspace, storage, store, agents, create, writer };
}

test("real files.write snapshots preserve each task's exact bytes after a later task overwrites the same workspace path", async (t) => {
  const { workspace, store, agents, create, writer } = await fixture(t);
  const first = await create(1), original = JSON.stringify({ message: "中文、引号\"和反斜杠\\", rows: [1, 2, 3] });
  await (await writer(first))({ capability: "files.write", args: { file: "reports/output.json", content: original } });
  const firstSaved = await store.get("agent_1", first.id);
  assert.equal(firstSaved.artifacts.length, 1); assert.match(fixtureText(firstSaved.artifacts[0]!.sha256), /^[a-f0-9]{64}$/);
  await store.update("agent_1", first.id, { status: "completed", result: { path: "reports/output.json" } });
  const second = await create(2), replacement = "different later output";
  await (await writer(second))({ capability: "files.write", args: { file: "reports/output.json", content: replacement } });
  assert.equal(await readFile(join(workspace, "reports/output.json"), "utf8"), replacement);
  const firstRead = await agents.readTaskArtifact("agent_1", first.id, 0);
  assert.equal(Buffer.from(firstRead.data, "base64").toString("utf8"), original);
  assert.equal(firstRead.size, Buffer.byteLength(original)); assert.equal(firstRead.nextOffset, null);
  const secondRead = await agents.readTaskArtifact("agent_1", second.id, 0);
  assert.equal(Buffer.from(secondRead.data, "base64").toString("utf8"), replacement);
  assert.notEqual(firstRead.sha256, secondRead.sha256);
  await assert.rejects(agents.readTaskArtifact("agent_2", first.id, 0));
  for (const index of [-1, 1, "0", 0.5]) await assert.rejects(callFixture(agents.readTaskArtifact, agents, ["agent_1", first.id, index]));
});

test("same-task replacement commits the latest snapshot and removes the obsolete private copy", async (t) => {
  const { storage, store, agents, create, writer } = await fixture(t), task = await create(1), capability = await writer(task);
  await capability({ capability: "files.write", args: { file: "same.csv", content: "old" } });
  const old = (await store.get("agent_1", task.id)).artifacts[0];
  await capability({ capability: "files.write", args: { file: "same.csv", content: "new" } });
  const current = (await store.get("agent_1", task.id)).artifacts;
  assert.equal(current.length, 1); assert.notEqual(current[0]!.snapshotId, old!.snapshotId);
  assert.equal((await readdir(await storage.directory("agent_1", `application/artifacts/${task.id}`))).length, 1);
  assert.equal(Buffer.from((await agents.readTaskArtifact("agent_1", task.id, 0)).data, "base64").toString(), "new");
});

test("cancelled or terminal task registration discards an unregistered snapshot and never publishes it", async (t) => {
  for (const boundary of ["check", "registration"]) await t.test(boundary, async (t) => {
    const { storage, store, create, writer } = await fixture(t), task = await create(1), controller = new AbortController(); let checks = 0;
    const check = async () => {
      if (++checks !== 2) return;
      if (boundary === "check") { controller.abort(); controller.signal.throwIfAborted(); }
      await store.update("agent_1", task.id, { status: "cancelled" });
    };
    const capability = await writer(task, { signal: controller.signal, check });
    await assert.rejects(capability({ capability: "files.write", args: { file: "late.json", content: "{}" } }));
    assert.deepEqual((await store.get("agent_1", task.id)).artifacts, []);
    assert.deepEqual(await readdir(await storage.directory("agent_1", `application/artifacts/${task.id}`)), []);
  });
});

test("byte paging preserves full Unicode and binary data without the workspace's text redaction or text limits", async (t) => {
  const { storage } = await fixture(t);
  const bytes = Buffer.from("前缀,\"字段\"\r\n" + "中文😀\\".repeat(20_000) + "\0尾部", "utf8");
  const artifact = await saveTaskArtifact({ storage, id: "agent_1", taskId: "task_1", path: "完整.csv", data: bytes });
  const parts = []; let offset = 0;
  for (;;) {
    const page = await readTaskArtifactSnapshot({ storage, id: "agent_1", taskId: "task_1", artifact, offset });
    assert.equal(page.encoding, "base64"); assert.equal(page.offset, offset); assert.equal(page.sha256, artifact.sha256);
    parts.push(Buffer.from(page.data, "base64")); if (page.nextOffset === null) break; offset = page.nextOffset;
  }
  assert.deepEqual(Buffer.concat(parts), bytes);
  for (const options of [{ offset: -1 }, { offset: bytes.length + 1 }, { offset: 0.5 }, { limit: 0 }, { limit: TASK_ARTIFACT_PAGE_BYTES + 1 }])
    await assert.rejects(readTaskArtifactSnapshot({ storage, id: "agent_1", taskId: "task_1", artifact, ...options }));
  await assert.rejects(readTaskArtifactSnapshot({ storage, id: "agent_1", taskId: "task_1", artifact: { path: "legacy.csv" } }), { reason: "artifact_snapshot_unavailable" });
});

test("snapshot reads reject changed bytes, links, missing files and metadata tampering", async (t) => {
  for (const boundary of ["changed", "symlink", "hardlink", "missing", "size", "hash"]) await t.test(boundary, async (t) => {
    const { root, storage } = await fixture(t);
    const artifact = await saveTaskArtifact({ storage, id: "agent_1", taskId: "task_1", path: "result.json", data: Buffer.from("original") });
    const path = await storage.path("agent_1", `application/artifacts/task_1/${artifact.snapshotId}.bin`);
    if (boundary === "changed") { await chmod(path, 0o600); await writeFile(path, "modified"); }
    if (boundary === "symlink") { await rm(path); await writeFile(join(root, "outside"), "original"); await symlink(join(root, "outside"), path); }
    if (boundary === "hardlink") await link(path, join(root, "linked"));
    if (boundary === "missing") await rm(path);
    if (boundary === "size") artifact.size++;
    if (boundary === "hash") artifact.sha256 = "a".repeat(64);
    await assert.rejects(readTaskArtifactSnapshot({ storage, id: "agent_1", taskId: "task_1", artifact }), { reason: "artifact_snapshot_invalid" });
  });
});

test("snapshot allocation failure preserves an existing file and pre-cancelled writes create no snapshot", async (t) => {
  const { root, storage } = await fixture(t), existing = join(root, "existing.bin");
  await writeFile(existing, "keep original");
  await assert.rejects(saveTaskArtifact({ storage: { path: async () => existing }, id: "agent_1", taskId: "task_1", path: "new.csv", data: Buffer.from("new") }), { code: "EEXIST" });
  assert.equal(await readFile(existing, "utf8"), "keep original");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(saveTaskArtifact({ storage, id: "agent_1", taskId: "task_1", path: "new.csv", data: Buffer.from("new"), signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(storage.directory("agent_1", "application/artifacts"), { code: "ENOENT" });
});

test("management task-artifact API downloads full original bytes and denies group task access", async (t) => {
  const { store, agents, create, writer } = await fixture(t), task = await create(1);
  const content = "标题,数值\r\n" + "\"中文😀\",1\r\n".repeat(12_000);
  // Direct fixture snapshot permits a file larger than one write-tool call.
  const artifact = await saveTaskArtifact({ storage: agents.storage, id: "agent_1", taskId: task.id, path: "full.csv", data: Buffer.from(content) });
  await store.appendArtifact("agent_1", task.id, artifact);
  let headers: Record<string, string | number | string[]> | undefined, code: number | undefined, json: unknown; const parts: Uint8Array[] = [];
  const response = { writeHead(status: number, value: Record<string, string | number | string[]>) { code = status; headers = value; }, write(value: Uint8Array) { parts.push(value); }, end() {} };
  const route = (suffix: string, query = "", current = response) => callFixture(routeApplication, undefined, [{ request: { method: "GET" }, response: current,
    address: new URL(`http://127.0.0.1/api/agents/agent_1/tasks/${suffix}${query}`), agents, sendJson(_response: HttpResponse, status: number, value: unknown) { code = status; json = value; } }]);
  assert.equal(await route(`${task.id}/artifacts/0`, "?download=1"), true);
  assert.equal(code, 200); assert.equal(headers!["content-length"], Buffer.byteLength(content));
  assert.match(fixtureText(headers!["content-disposition"]), /attachment/); assert.deepEqual(Buffer.concat(parts), Buffer.from(content));
  await route(`${task.id}/artifacts/0`, "?offset=3&limit=9");
  assert.equal(objectFields(json).offset, 3); assert.equal(Buffer.from(fixtureText(objectFields(json).data), "base64").length, 9);
  const group = await create(2, "group_1"); await (await writer(group))({ capability: "files.write", args: { file: "group.csv", content: "private group" } });
  await assert.rejects(route(`${group.id}/artifacts/0`), /群操作产物/);
  await assert.rejects(route(`${task.id}/artifacts/0`, "?download=1&offset=3"), /完整产物/);
  for (const query of ["?offset=", "?offset=-1", "?offset=0.5", "?limit=0", "?limit=65537"])
    await assert.rejects(route(`${task.id}/artifacts/0`, query), /位置或分页大小/);
});
