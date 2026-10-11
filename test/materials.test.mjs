import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import { AgentStorage } from "../src/agents/agent-storage.mjs";
import { MaterialStore } from "../src/materials/material-store.mjs";
import { MAX_MATERIAL_BYTES } from "../src/materials/material-formats.mjs";

const fixtures = fileURLToPath(new URL("./fixtures/materials/", import.meta.url));
async function setup(t, runner) {
  const root = await mkdtemp(join(tmpdir(), "neuma-materials-test-"));
  const storage = new AgentStorage({ dataDir: root }); await storage.ready;
  const store = new MaterialStore({ storage, ...(runner ? { runner } : {}) });
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  return { store, storage, root };
}
async function upload(store, name, source, agent = "agent-a") { return (await store.upload(agent, { name, source })).attachment; }

function officeZip(entries) {
  const chunks = [], directory = []; let offset = 0;
  for (const [name, value] of entries) {
    const filename = Buffer.from(name), data = Buffer.isBuffer(value) ? value : Buffer.from(value), checksum = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    chunks.push(header, filename, data); directory.push(central, filename); offset += header.length + filename.length + data.length;
  }
  const size = directory.reduce((sum, buffer) => sum + buffer.length, 0), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...directory, end]);
}

test("uploaded source text is isolated, paginated, redacted, and restored by stable references", async (t) => {
  const { store } = await setup(t);
  const original = `# Research\napi_key = "synthetic-sensitive-value"\n${"def calculate(value): return value + 1\n".repeat(900)}`;
  const attachment = await upload(store, "analysis.py", Buffer.from(original));
  assert.equal(attachment.kind, "text"); assert.equal(attachment.sha256, createHash("sha256").update(original).digest("hex"));
  assert.equal((await store.list("agent-a")).attachments.length, 1);
  const first = await store.preview("agent-a", attachment.id);
  assert.match(first.text, /Research/); assert.match(first.text, /\[已隐藏\]/); assert.doesNotMatch(first.text, /synthetic-sensitive-value/);
  assert.equal(first.text.length, 24000); assert.equal(first.nextOffset, 24000); assert.equal(first.sourceInfo.lineStart, 1);
  const next = await store.preview("agent-a", attachment.id, { offset: first.nextOffset }); assert.equal(next.nextOffset, null);
  assert.ok(next.sourceInfo.lineStart > 1); assert.equal((await store.resolve("agent-a", [{ id: attachment.id }]))[0].id, attachment.id);
  await assert.rejects(store.resolve("agent-b", [{ id: attachment.id }]), /当前 Agent/);
  await assert.rejects(store.resolve("agent-a", Array(11).fill({ id: attachment.id })), /10/);
  await assert.rejects(store.resolve("agent-a", [{ id: attachment.id }, { id: attachment.id }]), /重复/);
});

test("UTF-16 BOM and Chinese GB18030 text are decoded without running code", async (t) => {
  const { store } = await setup(t);
  const utf16 = await upload(store, "notes.md", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("标题\n第二行", "utf16le")]));
  assert.match((await store.preview("agent-a", utf16.id)).text, /标题\n第二行/);
  const gb = await upload(store, "notes.txt", Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
  assert.equal((await store.preview("agent-a", gb.id)).text, "中文");
  const code = await upload(store, "side-effect.mjs", Buffer.from("throw new Error('must never execute uploaded code');"));
  assert.match((await store.preview("agent-a", code.id)).text, /must never execute/);
});

test("redaction keeps original line numbers for multiline credential-like test text", async (t) => {
  const { store } = await setup(t), source = 'first\napi_key = "synthetic\nfixture"\n-----BEGIN PRIVATE KEY-----\nsynthetic-invalid-fixture\n-----END PRIVATE KEY-----\nlast\n';
  const attachment = await upload(store, "analysis.py", Buffer.from(source)), result = await store.preview("agent-a", attachment.id);
  assert.doesNotMatch(result.text, /synthetic/); assert.equal(result.text.split("\n").length, source.split("\n").length);
  const offset = result.text.indexOf("last"), last = await store.preview("agent-a", attachment.id, { offset });
  assert.equal(last.sourceInfo.lineStart, 7);
});

test("uploads reject unsafe names, content type mismatches, and a streamed 50 MiB overflow", async (t) => {
  const { store } = await setup(t);
  for (const name of ["../notes.txt", "sub/notes.txt", "sub\\notes.txt", "sub／notes.txt", ".env", "id_rsa", "password.txt", "api-key.py", "credential.json", "notes.exe"])
    await assert.rejects(store.upload("agent-a", { name, source: Buffer.from("untrusted") }));
  await assert.rejects(store.upload("agent-a", { name: "empty.txt", source: Buffer.alloc(0) }), /空文件/);
  await assert.rejects(store.upload("agent-a", { name: "fake.png", source: Buffer.from("not a PNG") }), /扩展名/);
  const block = Buffer.alloc(1024 * 1024, 97);
  async function* tooLarge() { for (let size = 0; size <= MAX_MATERIAL_BYTES; size += block.length) yield block; }
  await assert.rejects(store.upload("agent-a", { name: "large.txt", source: tooLarge() }), /50 MiB/);
  assert.deepEqual((await store.list("agent-a")).attachments, []);
});

test("cache hits recheck source hashes and reject link replacement", async (t) => {
  const { store, root } = await setup(t);
  const attachment = await upload(store, "notes.txt", Buffer.from("original source"));
  assert.equal((await store.preview("agent-a", attachment.id)).text, "original source");
  const { path } = await store.raw("agent-a", attachment.id);
  await chmod(path, 0o600); await writeFile(path, "modified source");
  await assert.rejects(store.preview("agent-a", attachment.id), /已被修改/); assert.equal((await store.get("agent-a", attachment.id)).status, "failed");
  await writeFile(path, "original source");
  assert.equal((await store.preview("agent-a", attachment.id)).text, "original source"); assert.equal((await store.get("agent-a", attachment.id)).status, "ready");
  const outside = join(root, "outside.txt"); await writeFile(outside, "original source"); await rm(path); await link(outside, path);
  await assert.rejects(store.raw("agent-a", attachment.id), /已被修改/);
  await rm(path); await symlink(outside, path); await assert.rejects(store.preview("agent-a", attachment.id));
});

test("parser cache is lazy, shared, and retained after reusable close", async (t) => {
  let calls = 0;
  const runner = { async run() { calls++; return { text: "parsed fixture", locations: [{ start: 0, end: 14 }], images: [], warnings: [], pageCount: null, status: "ready" }; }, async close() {} };
  const { store } = await setup(t, runner), attachment = await upload(store, "notes.txt", Buffer.from("source fixture"));
  assert.equal(calls, 0);
  const results = await Promise.all([store.preview("agent-a", attachment.id), store.preview("agent-a", attachment.id)]);
  assert.equal(results[0].text, results[1].text); assert.equal(calls, 1);
  await store.close(); await store.preview("agent-a", attachment.id); assert.equal(calls, 1);
});

test("workspace input replacement cannot modify the private original or its parser cache", async (t) => {
  const { store, storage } = await setup(t), attachment = await upload(store, "notes.txt", Buffer.from("trusted original"));
  await store.preview("agent-a", attachment.id);
  const workspacePath = await storage.path("agent-a", `workspace/inputs/${attachment.id}/notes.txt`), replacement = await storage.path("agent-a", "workspace/replacement.txt", true);
  await writeFile(replacement, "modified input"); await rename(replacement, workspacePath);
  assert.equal((await store.preview("agent-a", attachment.id)).text, "trusted original");
  assert.equal((await readFile((await store.raw("agent-a", attachment.id)).path)).toString(), "trusted original");
});

test("an immediate retry starts fresh while a cancelled parser is still closing", async (t) => {
  let calls = 0, started;
  const began = new Promise((resolve) => { started = resolve; });
  const runner = { run(_request, { signal }) { calls++; if (calls > 1) return Promise.resolve({ text: "fresh result", locations: [], images: [], warnings: [], status: "ready" });
    started(); return new Promise((_resolve, reject) => signal.addEventListener("abort", () => setTimeout(() => reject(new DOMException("stopped", "AbortError")), 80), { once: true })); }, async close() {} };
  const { store } = await setup(t, runner), attachment = await upload(store, "notes.txt", Buffer.from("source")), controller = new AbortController();
  const first = store.preview("agent-a", attachment.id, { signal: controller.signal }); await began;
  controller.abort(); await assert.rejects(first, { name: "AbortError" });
  assert.equal((await store.preview("agent-a", attachment.id)).text, "fresh result"); assert.equal(calls, 2);
});

test("close cancels a stalled upload and the store remains reusable", async (t) => {
  const { store } = await setup(t); let reached;
  const started = new Promise((resolve) => { reached = resolve; });
  const source = { [Symbol.asyncIterator]() { return { async next() { reached(); return new Promise(() => {}); } }; } };
  const request = store.upload("agent-a", { name: "notes.txt", source }); const rejection = assert.rejects(request, { name: "AbortError" });
  await started; await store.close(); await rejection; assert.deepEqual((await store.list("agent-a")).attachments, []);
  assert.equal((await upload(store, "after.txt", Buffer.from("after close"))).status, "uploaded");
});

test("failed parsing persists a real failure and a subsequent successful retry becomes ready", async (t) => {
  let failure;
  const runner = { async run() { if (failure) { const error = new Error("材料无法解析"); error.reason = failure; throw error; }
    return { text: "recovered", locations: [], images: [], warnings: [], status: "ready", pageCount: null }; }, async close() {} };
  const { store } = await setup(t, runner), attachment = await upload(store, "notes.txt", Buffer.from("source fixture"));
  for (const reason of ["material_parse_failed", "material_output_limit"]) {
    failure = reason; await assert.rejects(store.preview("agent-a", attachment.id), { reason });
    const failed = await store.get("agent-a", attachment.id);
    assert.equal(failed.status, "failed"); assert.equal(failed.failureReason, reason);
  }
  failure = false; assert.equal((await store.preview("agent-a", attachment.id)).text, "recovered"); assert.equal((await store.get("agent-a", attachment.id)).status, "ready");
});

test("successful cached and fresh PDF images retain a known scan's vision requirement after failure", async (t) => {
  let failSecondPage = true;
  const runner = { async run(request) {
    if (request.action === "parse") return { text: "native text", locations: [{ start: 0, end: 11, page: 1 }], images: [], warnings: [], status: "needs_vision", visionPages: [2], pageCount: 2 };
    if (request.page === 2 && failSecondPage) { const error = new Error("材料图片无法读取"); error.reason = "material_image_failed"; throw error; }
    return { data: "aW1hZ2U=", mimeType: "image/png", page: request.page, pageCount: 2, warnings: [] };
  }, async close() {} };
  const { store } = await setup(t, runner), attachment = await upload(store, "paper.pdf", await readFile(join(fixtures, "paper.pdf")));
  await store.preview("agent-a", attachment.id); await store.image("agent-a", attachment.id, { page: 1 });
  await assert.rejects(store.image("agent-a", attachment.id, { page: 2 }), { reason: "material_image_failed" });
  assert.equal((await store.get("agent-a", attachment.id)).status, "failed");
  await store.image("agent-a", attachment.id, { page: 1 });
  assert.equal((await store.get("agent-a", attachment.id)).status, "needs_vision");
  await assert.rejects(store.image("agent-a", attachment.id, { page: 2 }), { reason: "material_image_failed" });
  failSecondPage = false; await store.image("agent-a", attachment.id, { page: 2 });
  const recovered = await store.get("agent-a", attachment.id);
  assert.equal(recovered.status, "needs_vision"); assert.deepEqual(recovered.visionPages, [2]);
});

for (const name of ["paper.pdf", "testWORD.docx"]) {
  test(`a truncated real ${name} fails parsing and persists its failure descriptor`, async (t) => {
    const { store } = await setup(t), original = await readFile(join(fixtures, name));
    const attachment = await upload(store, name, original.subarray(0, 64));
    await assert.rejects(store.preview("agent-a", attachment.id), { reason: "material_parse_failed" });
    const failed = await store.get("agent-a", attachment.id);
    assert.equal(failed.status, "failed"); assert.equal(failed.failureReason, "material_parse_failed");
    assert.match(failed.error, /无法解析|损坏|结构无效/);
  });
}

test("a real Apache Tika encrypted PDF reports its password requirement and persists failure", async (t) => {
  const { store } = await setup(t), name = "testPDF_no_extract_no_accessibility_owner_user.pdf";
  const attachment = await upload(store, name, await readFile(join(fixtures, name)));
  await assert.rejects(store.preview("agent-a", attachment.id), { reason: "material_encrypted" });
  const failed = await store.get("agent-a", attachment.id);
  assert.equal(failed.status, "failed"); assert.equal(failed.failureReason, "material_encrypted");
  assert.match(failed.error, /加密|密码/);
});

test("native PDF parsing keeps real page references and renders a scan without OCR", async (t) => {
  const { store } = await setup(t), attachment = await upload(store, "paper.pdf", await readFile(join(fixtures, "paper.pdf")));
  const preview = await store.preview("agent-a", attachment.id);
  assert.match(preview.text, /searchable native text/); assert.equal(preview.attachment.pageCount, 2);
  assert.ok(preview.sourceInfo.locations.some((location) => location.page === 1)); assert.ok(preview.sourceInfo.visionPages.includes(2));
  assert.equal(preview.attachment.status, "needs_vision");
  const image = await store.image("agent-a", attachment.id, { page: 2 });
  assert.equal(image.page, 2); assert.equal(image.mimeType, "image/png"); assert.equal(image.pageCount, 2);
  assert.ok(image.width <= 1600 && image.height <= 1600); assert.equal((await sharp(Buffer.from(image.data, "base64")).metadata()).format, "png");
  await assert.rejects(store.image("agent-a", attachment.id, { page: 3 }), /超出范围/);
  assert.equal((await store.get("agent-a", attachment.id)).status, "needs_vision");
});

test("common raster inputs normalize to model images and TIFF pages remain addressable", async (t) => {
  const { store } = await setup(t);
  const pixels = Buffer.from([...Array(4 * 4)].flatMap(() => [255, 0, 0]).concat([...Array(4 * 4)].flatMap(() => [0, 0, 255])));
  for (const [name, source] of [
    ["photo.png", await sharp({ create: { width: 32, height: 16, channels: 3, background: "white" } }).png().toBuffer()],
    ["photo.jpg", await sharp({ create: { width: 32, height: 16, channels: 3, background: "white" } }).jpeg().toBuffer()],
    ["photo.webp", await sharp({ create: { width: 32, height: 16, channels: 3, background: "white" } }).webp().toBuffer()],
  ]) {
    const attachment = await upload(store, name, source), result = await store.image("agent-a", attachment.id);
    assert.equal(result.mimeType, "image/png"); assert.equal(result.width, 32); assert.equal((await store.get("agent-a", attachment.id)).pageCount, 1);
  }
  const tiff = await upload(store, "pages.tiff", await sharp(pixels, { raw: { width: 4, height: 8, channels: 3, pageHeight: 4 } }).tiff({ compression: "none" }).toBuffer());
  const second = await store.image("agent-a", tiff.id, { page: 2 }); assert.equal(second.pageCount, 2); assert.equal((await store.get("agent-a", tiff.id)).pageCount, 2);
  const secondPixels = await sharp(Buffer.from(second.data, "base64")).raw().toBuffer(); assert.ok(secondPixels[2] > secondPixels[0]);
  const gif = await upload(store, "animation.gif", await sharp(pixels, { raw: { width: 4, height: 8, channels: 3, pageHeight: 4 } }).gif().toBuffer());
  const first = await store.image("agent-a", gif.id); assert.equal(first.pageCount, 1); assert.ok(first.warnings.some((warning) => /第一帧/.test(warning)));
  await assert.rejects(store.image("agent-a", gif.id, { page: 2 }), /超出范围/);
});

test("uncompressed 24-bit BMP is converted without an extra system decoder", async (t) => {
  const { store } = await setup(t), bytes = Buffer.alloc(62);
  bytes.write("BM"); bytes.writeUInt32LE(bytes.length, 2); bytes.writeUInt32LE(54, 10); bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(2, 18); bytes.writeInt32LE(1, 22); bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(24, 28);
  bytes.set([0, 0, 255, 0, 255, 0], 54);
  const attachment = await upload(store, "diagram.bmp", bytes), image = await store.image("agent-a", attachment.id);
  assert.equal(image.width, 2); assert.equal(image.height, 1);
  const pixels = await sharp(Buffer.from(image.data, "base64")).raw().toBuffer(); assert.equal(pixels[0], 255); assert.equal(pixels[4], 255);
});

test("PPTX slide order and embedded picture references follow the package relationships", async (t) => {
  const { store } = await setup(t), picture = await sharp({ create: { width: 5, height: 3, channels: 3, background: "blue" } }).png().toBuffer();
  const namespace = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const source = officeZip([
    ["[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>'],
    ["_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rPresentation" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>'],
    ["ppt/presentation.xml", `<p:presentation ${namespace}><p:sldIdLst><p:sldId id="256" r:id="rTwo"/><p:sldId id="257" r:id="rOne"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`],
    ["ppt/_rels/presentation.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rOne" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rTwo" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>'],
    ["ppt/slides/slide1.xml", `<p:sld ${namespace}><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Second visible slide</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`],
    ["ppt/slides/slide2.xml", `<p:sld ${namespace}><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>First visible slide &amp; diagram</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:blipFill><a:blip r:embed="rPicture"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>`],
    ["ppt/slides/_rels/slide2.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rPicture" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>'],
    ["ppt/media/image1.png", picture],
  ]);
  const attachment = await upload(store, "slides.pptx", source), result = await store.preview("agent-a", attachment.id);
  assert.ok(result.text.indexOf("First visible slide & diagram") < result.text.indexOf("Second visible slide"));
  assert.equal(result.attachment.pageCount, 2); assert.equal(result.sourceInfo.locations[0].slide, 1);
  assert.equal(result.sourceInfo.locations[0].part, "ppt/slides/slide2.xml");
  const image = await store.image("agent-a", attachment.id, { imageId: result.attachment.images[0].id });
  assert.equal(image.sourceInfo.page, 1); assert.equal(image.sourceInfo.part, "ppt/media/image1.png"); assert.deepEqual(image.sourceInfo.slides, [1]);
});

for (const [name, expected] of [["testWORD.doc", /Sample Word Document/], ["testWORD.docx", /Sample Word Document/], ["testEXCEL.xls", /Sample Excel Worksheet/], ["testEXCEL.xlsx", /Sample Excel Worksheet/], ["testPPT.ppt", /Sample Powerpoint Slide/i], ["testPPT.pptx", /Attachment Test/]]) {
  test(`real Apache Tika ${name} is parsed by the pinned native dependency`, async (t) => {
    const { store } = await setup(t), attachment = await upload(store, name, await readFile(join(fixtures, name)));
    const result = await store.preview("agent-a", attachment.id); assert.match(result.text, expected); assert.equal(result.attachment.status, "ready");
    if (/\.xlsx?$/.test(name)) {
      assert.ok(result.attachment.sheetNames.length > 0);
      assert.match(result.text, /^\|\s*\|\s*Number\s*\|\s*Square\s*\|$/m);
      assert.match(result.text, /^\|\s*\|\s*14\s*\|\s*196\s*\|$/m);
      assert.match(result.text, /^\|\s*\|\s*15\s*\|\s*225\s*\|$/m);
      assert.ok(result.sourceInfo.locations.some((location) => location.sheet === "Feuil1"));
    }
    if (/\.pptx$/.test(name)) assert.ok(result.sourceInfo.locations.some((location) => location.slide === 1));
  });
}

test("RTF and quoted CSV/TSV values remain readable through the real parser", async (t) => {
  const { store } = await setup(t);
  for (const [name, source, expected] of [["notes.rtf", "{\\rtf1\\ansi A document fixture with \\b bold\\b0 text.}", /document fixture/],
    ["data.csv", 'Name,Description,Value\nExample,"quoted, value",196\n', /quoted, value/], ["data.tsv", "Name\tValue\nExample\t196\n", /196/]]) {
    const attachment = await upload(store, name, Buffer.from(source)); assert.match((await store.preview("agent-a", attachment.id)).text, expected);
  }
});
