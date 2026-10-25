import { objectFields } from "../../src/runtime/type-boundary.mjs";
import { listeningAddress } from "../helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentStorage } from "../../src/agents/agent-storage.mjs";
import { PrototypeAgents } from "../../src/agents/agent-prototype.mjs";
import { ApplicationTaskStore } from "../../src/applications/task-store.mjs";
import { saveTaskArtifact, TASK_ARTIFACT_PAGE_BYTES } from "../../src/applications/task-artifacts.mjs";
import { InputError } from "../../src/requirements/core.mjs";
import { MAX_RUNTIME_FILE_BYTES } from "../../src/runtime/file-limits.mjs";
import { createApp } from "../../src/server.mjs";
import { createApplicationApi } from "../../public/application-api.js";
import { createAgentRuntime } from "../../public/agent-runtime.js";
import type { BinaryLike } from "crypto";

const id = "download_agent", otherId = "other_agent";
const sha256 = (bytes: BinaryLike|Buffer<ArrayBuffer>) => createHash("sha256").update(bytes).digest("hex");

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "neuma-artifact-download-")));
  const storage = new AgentStorage({ dataDir: join(root, "data") }), store = new ApplicationTaskStore({ storage });
  const known = new Set([id, otherId]);
  await store.ready;
  const workspace = await storage.directory(id, "workspace", { create: true });
  await storage.directory(otherId, "workspace", { create: true });
  const agents = Object.assign(Object.create(PrototypeAgents.prototype), {
    storage, applications: { store },
    async requireAgent(agentId: string) {
      if (!known.has(agentId)) throw new InputError("没有找到这个 Agent");
      return { id: agentId };
    },
    workspace: (agentId:string) => storage.directory(agentId, "workspace"),
    close: () => store.settle(),
  });
  const server = createApp({ config: {}, providers: {}, dataDir: join(root, "data"), prototypeAgents: agents,
    projects: {}, projectAgent: {}, skillManager: {} });
  t.after(async () => {
    await server.dispose(); server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await server.ready;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${listeningAddress(server).port}`;
  const request = (path: string, options = {}) => fetch(base + path, { ...options, headers: { origin: base, ...objectFields(objectFields(options).headers) } });
  const api = createApplicationApi(request), runtime = createAgentRuntime(request);
  let sequence = 0;
  const createTask = async (scope = "private") => (await store.create(id, {
    actionId: "export", input: {}, mutationId: `download_fixture_${++sequence}`, deliveryVersion: "delivery_1", revision: 1,
    source: { kind: "application", scope },
  })).task;
  const save = async (task: { id: string; }, path: string, bytes: string|NodeJS.ArrayBufferView<ArrayBufferLike>|Iterable<string|NodeJS.ArrayBufferView<ArrayBufferLike>>|AsyncIterable<string|NodeJS.ArrayBufferView<ArrayBufferLike>>) => {
    const target = join(workspace, path);
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes);
    const artifact = await saveTaskArtifact({ storage, id, taskId: task.id, path, data: bytes });
    await store.appendArtifact(id, task.id, artifact);
    await store.update(id, task.id, { status: "completed", result: { path } });
    return artifact;
  };
  const artifactPath = (taskId: unknown, index:string|number = 0, agentId = id) => `/api/agents/${agentId}/tasks/${taskId}/artifacts/${index}`;
  return { root, workspace, store, request, api, runtime, createTask, save, artifactPath };
}

test("real HTTP download preserves full snapshot bytes beyond preview and byte-page limits", async (t) => {
  const f = await fixture(t), task = await f.createTask(), path = "reports/汇总 报告(最终).csv";
  const moduleResponse = await f.request("/artifact-download.js");
  assert.equal(moduleResponse.status, 200); assert.match(moduleResponse.headers.get("content-type")!, /^(?:application|text)\/javascript\b/);
  assert.ok((await moduleResponse.text()).length > 0);
  const fixtureValue = "download-only-fixture-value";
  const bytes = Buffer.from(`\ufeffapi_key="${fixtureValue}"\r\n标题,说明\r\n` + '"中文😀",缠绕"引号"与反斜杠\\\r\n'.repeat(24_000) + "尾部,完整\r\n");
  assert.ok(bytes.length > TASK_ARTIFACT_PAGE_BYTES);
  const artifact = await f.save(task, path, bytes);
  const previewResponse = await f.request(`/api/agents/${id}/file?path=${encodeURIComponent(path)}`);
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.truncated, true); assert.equal(preview.integrity.redacted, true);
  assert.ok(!preview.content.includes(fixtureValue)); assert.notEqual(preview.content, bytes.toString("utf8"));
  assert.equal(preview.integrity.sha256, artifact.sha256); assert.equal(preview.integrity.bytes, bytes.length);

  const firstPageResponse = await f.request(f.artifactPath(task.id));
  assert.equal(firstPageResponse.status, 200);
  const firstPage = await firstPageResponse.json();
  assert.equal(firstPage.nextOffset, TASK_ARTIFACT_PAGE_BYTES);
  assert.equal(Buffer.from(firstPage.data, "base64").length, TASK_ARTIFACT_PAGE_BYTES);
  const artifactPreview = await f.api.artifactPreview(id, task.id, 0);
  assert.equal(artifactPreview.path, path); assert.equal(artifactPreview.truncated, true);
  assert.equal(artifactPreview.integrity.redacted, true); assert.equal(artifactPreview.integrity.sha256, artifact.sha256);
  assert.equal(artifactPreview.integrity.bytes, bytes.length); assert.ok(!artifactPreview.content!.includes(fixtureValue));

  const downloadUrl = f.api.artifactDownloadUrl(id, task.id, 0);
  assert.equal(downloadUrl, `${f.artifactPath(task.id)}?download=1`);
  const response = await f.request(downloadUrl);
  assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.equal(response.headers.get("content-length"), String(bytes.length));
  assert.match(response.headers.get("content-disposition")!, /^attachment;/);
  assert.ok(response.headers!.get("content-disposition")!.includes(encodeURIComponent(artifact.name!).replace(/[()]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)));
  assert.equal(response.headers.get("cache-control"), "no-store"); assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const downloaded = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(downloaded, bytes); assert.equal(sha256(downloaded), artifact.sha256);
  assert.ok(downloaded.toString("utf8").includes(fixtureValue));
  const blob = await f.api.downloadArtifact(id, task.id, 0);
  assert.ok(blob instanceof Blob); assert.deepEqual(Buffer.from(await blob.arrayBuffer()), bytes);
  const workspaceUrl = f.runtime.fileDownloadUrl(id, path);
  assert.equal(workspaceUrl, `/api/agents/${id}/file?path=${encodeURIComponent(path)}&download=1`);
  const workspaceResponse = await f.request(workspaceUrl);
  assert.equal(workspaceResponse.status, 200); assert.equal(workspaceResponse.headers.get("content-length"), String(bytes.length));
  assert.match(workspaceResponse.headers.get("content-disposition")!, /^attachment;/);
  assert.deepEqual(Buffer.from(await workspaceResponse.arrayBuffer()), bytes);
  const workspaceBlob = await f.runtime.downloadFile(id, path);
  assert.ok(workspaceBlob instanceof Blob); assert.deepEqual(Buffer.from(await workspaceBlob.arrayBuffer()), bytes);

  const second = await f.createTask(), replacement = Buffer.from("标题,说明\r\n后一次,同名新内容\r\n");
  await f.save(second, path, replacement);
  assert.deepEqual(await readFile(join(f.workspace, path)), replacement);
  const oldDownload = await f.request(f.api.artifactDownloadUrl(id, task.id, 0));
  const newDownload = await f.request(f.api.artifactDownloadUrl(id, second.id, 0));
  assert.deepEqual(Buffer.from(await oldDownload.arrayBuffer()), bytes);
  assert.deepEqual(Buffer.from(await newDownload.arrayBuffer()), replacement);
  assert.deepEqual(Buffer.from(await (await f.runtime.downloadFile(id, path)).arrayBuffer()), replacement);
});

test("real HTTP artifact downloads stay bound to registered Agent, task, index and private scope", async (t) => {
  const f = await fixture(t), task = await f.createTask();
  await f.save(task, "private.csv", Buffer.from("private fixture artifact"));
  const empty = await f.createTask(), group = await f.createTask("group-tasks/group-one/task-one/download_agent");
  await f.save(group, "group.csv", Buffer.from("group fixture artifact"));
  const denied: [string,number][] = [
    [f.artifactPath(task.id, 0, otherId), 400],
    [f.artifactPath(task.id, 0, "missing_agent"), 400],
    [f.artifactPath("missing_task"), 400],
    [f.artifactPath(empty.id), 400],
    [f.artifactPath(task.id, 1), 400],
    [f.artifactPath(group.id), 400],
    [f.artifactPath(task.id, "-1"), 404],
  ];
  for (const [path, status] of denied) {
    const response = await f.request(`${path}?download=1`);
    assert.equal(response.status, status, path!);
    assert.equal(response.headers.get("content-disposition"), null);
    const failure = await response.json();
    assert.equal(typeof failure.error, "string"); assert.ok(!JSON.stringify(failure).includes("fixture artifact"));
  }
  const invalidOffset = await f.request(`${f.artifactPath(task.id)}?download=1&offset=1`);
  assert.equal(invalidOffset.status, 400); assert.equal(invalidOffset.headers.get("content-disposition"), null);
  for (const query of ["preview=1&download=1", "preview=1&offset=0", "preview=1&limit=10"]) {
    const response = await f.request(`${f.artifactPath(task.id)}?${query}`);
    assert.equal(response.status, 400, query); assert.equal(response.headers.get("content-disposition"), null);
  }
});

test("text preview restrictions never change binary download bytes and preserve UTF-8 at the page boundary", async (t) => {
  const f = await fixture(t);
  for (const bytes of [Buffer.from("text\0binary fixture"), Buffer.from([0xff, 0xfe, 0xc0, 0xaf])]) {
    const task = await f.createTask(); await f.save(task, "result.bin", bytes);
    await assert.rejects(f.api.artifactPreview(id, task.id, 0), (error) => objectFields(error).status === 400);
    const blob = await f.api.downloadArtifact(id, task.id, 0);
    assert.deepEqual(Buffer.from(await blob.arrayBuffer()), bytes);
  }
  const task = await f.createTask();
  const bytes = Buffer.concat([Buffer.alloc(TASK_ARTIFACT_PAGE_BYTES - 1, "a"), Buffer.from("😀尾部")]);
  await f.save(task, "unicode.txt", bytes);
  const preview = await f.api.artifactPreview(id, task.id, 0);
  assert.equal(preview.content, "a".repeat(TASK_ARTIFACT_PAGE_BYTES - 1)); assert.equal(preview.truncated, true);
  assert.equal(preview.integrity.bytes, bytes.length); assert.equal(preview.integrity.sha256, sha256(bytes));
  assert.deepEqual(Buffer.from(await (await f.api.downloadArtifact(id, task.id, 0)).arrayBuffer()), bytes);
});

test("real HTTP workspace downloads reject unsafe paths and links under the same file permissions", async (t) => {
  const f = await fixture(t), outside = join(f.root, "outside.txt"), privateContent = "outside fixture bytes";
  await writeFile(outside, privateContent);
  await symlink(outside, join(f.workspace, "linked.txt"));
  await symlink(f.root, join(f.workspace, "linked-folder"));
  await link(outside, join(f.workspace, "hardlinked.txt"));
  await writeFile(join(f.workspace, ".fixture-hidden"), privateContent);
  await writeFile(join(f.workspace, "private-token.txt"), privateContent);
  for (const path of ["../outside.txt", outside, ".fixture-hidden", "private-token.txt", "linked.txt", "linked-folder/outside.txt", "hardlinked.txt", "missing.txt", "."]) {
    const response = await f.request(f.runtime.fileDownloadUrl(id, path));
    assert.equal(response.status, 400, path); assert.equal(response.headers.get("content-disposition"), null);
    const failure = await response.json(); assert.equal(typeof failure.error, "string");
    assert.ok(!JSON.stringify(failure).includes(privateContent));
    await assert.rejects(f.runtime.downloadFile(id, path));
  }
  const response = await f.request(f.runtime.fileDownloadUrl("missing_agent", "ordinary.txt"));
  assert.equal(response.status, 400); assert.equal(response.headers.get("content-disposition"), null);
});

test("real HTTP workspace downloads accept the exact file-byte limit and reject a larger file", async (t) => {
  const f = await fixture(t), path = "byte-limit.bin", bytes = Buffer.alloc(MAX_RUNTIME_FILE_BYTES, 0x61);
  await writeFile(join(f.workspace, path), bytes);
  const response = await f.request(f.runtime.fileDownloadUrl(id, path));
  assert.equal(response.status, 200); assert.equal(response.headers.get("content-length"), String(MAX_RUNTIME_FILE_BYTES));
  const downloaded = Buffer.from(await response.arrayBuffer());
  assert.equal(downloaded.length, MAX_RUNTIME_FILE_BYTES); assert.equal(sha256(downloaded), sha256(bytes));
  const handle = await open(join(f.workspace, path), "r+");
  try { await handle.truncate(MAX_RUNTIME_FILE_BYTES + 1); } finally { await handle.close(); }
  const oversized = await f.request(f.runtime.fileDownloadUrl(id, path));
  assert.equal(oversized.status, 400); assert.equal(oversized.headers.get("content-disposition"), null);
  await assert.rejects(f.runtime.downloadFile(id, path));
});
