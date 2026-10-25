import type { AddressInfo } from "node:net";
import { checkedText } from "../helpers/http-assertions.mjs";
import type { RequestHandler } from "../../src/server.mjs";
import type { RequestHandlerOptions } from "../../src/server.mjs";
import type { IncomingHttpHeaders } from "node:http";
import type { ServerAgents } from "../../src/server-port.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createRequestHandler } from "../../src/server.mjs";
import { AgentStorage } from "../../src/agents/agent-storage.mjs";
import { MaterialStore } from "../../src/materials/material-store.mjs";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "neuma-attachment-api-"));
  const store = new MaterialStore({ storage: new AgentStorage({ dataDir: root }) });
  const app = createApp({ config: {}, providers: {}, projects: {}, projectAgent: {}, prototypeAgents: {
    close: () => store.close(), uploadAttachment: (id, value) => store.upload(id, value), listAttachments: (id) => store.list(id),
    getAttachment: async (id, file) => ({ attachment: await store.get(id, file) }), attachmentRaw: (id, file) => store.raw(id, file),
    attachmentPreview: (id, file, options) => store.preview(id, file, options), attachmentImage: (id, file, options) => store.image(id, file, options) } });
  await app.ready; await new Promise<void>((done) => app.listen(0, "127.0.0.1", done));
  t.after(async () => { await app.dispose(); await new Promise<void>((done, reject) => app.close((error) => error ? reject(error) : done())); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const upload = async (agent: unknown, name: string, body: BodyInit) => {
    const response = await fetch(`${base}/api/agents/${agent}/attachments?name=${encodeURIComponent(name)}`, {
      method: "POST", headers: { "content-type": "application/octet-stream" }, body });
    return { status: response.status, result: await response.json() };
  };
  return { base, store, upload };
}

test("二进制上传、附件清单、中文预览和原件下载形成真实 HTTP 闭环", async (t) => {
  const { base, upload } = await fixture(t);
  const content = Buffer.from("# 中文材料\nprint('不执行代码')\n");
  const { status, result: { attachment } } = await upload("paper", "研究笔记.py", content);
  assert.equal(status, 200); assert.equal(attachment.size, content.length); assert.equal(attachment.name, "研究笔记.py");
  const files = await (await fetch(`${base}/api/agents/paper/attachments`)).json();
  assert.equal(files.attachments[0].id, attachment.id);
  const detail = await (await fetch(`${base}/api/agents/paper/attachments/${attachment.id}`)).json();
  assert.equal(detail.attachment.sha256, attachment.sha256);
  const preview = await (await fetch(`${base}/api/agents/paper/attachments/${attachment.id}/preview`)).json();
  assert.match(preview.text, /中文材料/); assert.equal(preview.sourceInfo.lineStart, 1); assert.equal(preview.nextOffset, null);
  const raw = await fetch(`${base}/api/agents/paper/attachments/${attachment.id}/raw?download=1`);
  assert.deepEqual(Buffer.from(await raw.arrayBuffer()), content);
  assert.match(checkedText(raw.headers.get("content-disposition")), /^attachment;/);
  assert.ok(raw.headers!.get("content-disposition")!.includes(encodeURIComponent("研究笔记.py")));
  assert.equal(raw.headers.get("content-type"), "application/octet-stream");
  assert.equal((await fetch(`${base}/api/agents/other/attachments/${attachment.id}`)).status, 400);
  assert.equal((await fetch(`${base}/api/agents/paper/attachments/${attachment.id}/preview?offset=-1`)).status, 400);
});

test("图片预览返回真实 PNG，原始文件不经过文本 JSON 或 MIME 提示改写", async (t) => {
  const { base, upload } = await fixture(t);
  const content = await readFile(new URL("../../public/assets/brand/neuma-mark.png", import.meta.url));
  const { result: { attachment } } = await upload("paper", "图片.png", content);
  const preview = await fetch(`${base}/api/agents/paper/attachments/${attachment.id}/image?page=1`);
  assert.equal(preview.status, 200); assert.equal(preview.headers.get("content-type"), "image/png");
  assert.equal(preview.headers.get("x-material-page-count"), "1");
  assert.equal(preview.headers.get("x-material-page"), "1");
  const pixels = Buffer.from(await preview.arrayBuffer()); assert.deepEqual(pixels.subarray(0, 8), content.subarray(0, 8));
  const raw = await fetch(`${base}/api/agents/paper/attachments/${attachment.id}/raw`);
  assert.deepEqual(Buffer.from(await raw.arrayBuffer()), content);
  assert.match(checkedText(raw.headers.get("content-disposition")), /^inline;/);
  assert.equal((await fetch(`${base}/api/agents/paper/attachments/${attachment.id}/image?page=0`)).status, 400);
  assert.equal((await fetch(`${base}/api/agents/paper/attachments/${attachment.id}/image?page=1`, { headers: { origin: "https://outside.example" } })).status, 403);
});

test("上传继续拒绝跨站、凭据路径、伪装二进制及无效文件名", async (t) => {
  const { base, upload } = await fixture(t);
  for (const name of ["../outside.py", ".env", "password.txt", "unknown.exe"]) assert.equal((await upload("paper", name, Buffer.from("text"))).status, 400);
  assert.equal((await upload("paper", "fake.png", Buffer.from("text"))).status, 400);
  const response = await fetch(`${base}/api/agents/paper/attachments?name=file.py`, { method: "POST", body: "text", headers: { origin: "https://outside.example" } });
  assert.equal(response.status, 403);
});

test("超过 20 MiB 的 Content-Length 在读取和保存之前拒绝", async () => {
  let uploads = 0;
  const handler = createRequestHandler({ config: {}, providers: {}, projects: {}, projectAgent: {},
    prototypeAgents: { uploadAttachment: async () => { uploads++; return assert.fail("oversized upload must not be saved"); }, close: async () => {} } });
  const request = Object.assign(Readable.from([]), { method: "POST", url: "/api/agents/paper/attachments?name=large.pdf",
    headers: { "content-type": "application/pdf", "content-length": String(20 * 1024 * 1024 + 1) } });
  const response = Object.assign(new EventEmitter(), { status: 0, body: undefined as unknown, writableEnded: false, writeHead(status: number) { this.status = status; }, end(value: unknown) { this.body = value; this.writableEnded = true; } });
  await handler(request, response); await handler.dispose();
  assert.equal(response.status, 400); assert.match(JSON.parse(String(response.body)).error, /20 MiB/); assert.equal(uploads, 0);
});
