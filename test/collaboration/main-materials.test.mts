import { toolText } from "../helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MainMaterials } from "../../src/main/main-materials.mjs";
import { GroupStorage } from "../../src/collaboration/group-store.mjs";
import { CollaborationService } from "../../src/collaboration/groups.mjs";
import { MaterialStore, type MaterialUpload } from "../../src/materials/material-store.mjs";
import type { PathLike } from "fs";
import type { FileHandle } from "fs/promises";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "neuma-main-materials-")), receipts = new Map(), imports: ({ "groupId": (string); "name": (unknown); "mimeType": (unknown); "mutationId": (string); })[] = [];
  let parserCloses = 0, loseReply = false;
  const runner = { async run(request: { action: string; path: PathLike|FileHandle; }) {
    if (request.action === "image") return { mimeType: "image/png", data: Buffer.from("image-fixture").toString("base64"), pageCount: 1, warnings: [] };
    const content = await readFile(request.path, "utf8");
    return { text: content, status: "ready", locations: [{ start: 0, end: content.length }], images: [], warnings: [] };
  }, async close() { parserCloses++; } };
  const storage = new GroupStorage({ dataDir: join(root, "main-materials") });
  const materials = new MaterialStore({ storage, runner });
  const groupStorage = new GroupStorage({ dataDir: join(root, "collaboration") });
  const groupMaterials = new MaterialStore({ storage: groupStorage, runner });
  const collaboration = { async importMaterial(groupId: string, options: MaterialUpload & { mutationId: string }, { signal }: { signal?: AbortSignal | undefined }) {
    const key = `${groupId}:${options!.mutationId}`; imports.push({ groupId, name: options!.name, mimeType: options!.mimeType, mutationId: options!.mutationId });
    if (receipts.has(key)) return receipts.get(key);
    const result = await groupMaterials.upload(groupId, { ...options!, signal }); receipts.set(key, result);
    if (loseReply) { loseReply = false; throw new Error("fixture-lost-reply"); }
    return result;
  } };
  const main = new MainMaterials({ dataDir: root, storage, materials, collaboration });
  t.after(async () => { await main.close(); await groupMaterials.close(); await rm(root, { recursive: true, force: true }); });
  await main.ready;
  return { root, main, materials, groupMaterials, imports, receipts, collaboration, parserCloses: () => parserCloses,
    loseNextReply() { loseReply = true; } };
}
const upload = async (main: MainMaterials, conversationId: string, name = "research.txt", source = "共享研究内容") =>
  (await main.upload(conversationId, { name, source: Buffer.from(source) })).attachment;

test("主对话材料按会话隔离，读工具只接受材料ID并保留实际来源", async (t) => {
  const { main } = await fixture(t);
  const attachment = await upload(main, "conversation-one");
  assert.deepEqual((await main.list("conversation-one")).attachments.map((value) => value.id), [attachment.id]);
  assert.deepEqual((await main.list("conversation-two")).attachments, []);
  assert.equal((await main.resolve("conversation-one", [attachment.id]))[0]!.id, attachment.id);
  await assert.rejects(main.resolve("conversation-two", [attachment.id]));
  const tools = Object.fromEntries(main.tools("conversation-one").map((tool) => [tool.name, tool]));
  assert.deepEqual(Object.keys(tools), ["list_main_materials", "read_main_material", "read_main_material_image"]);
  const read = await tools.read_main_material!.execute("read", { id: attachment.id }, new AbortController().signal);
  const result = JSON.parse(String(toolText(read)));
  assert.equal(result.text, "共享研究内容"); assert.equal(result.sourceInfo.id, attachment.id);
  assert.equal("path" in result, false);
  const other = await upload(main, "conversation-two", "other.txt", "另一对话的资料");
  await assert.rejects(tools.read_main_material!.execute("escape", { id: other.id, conversationId: "conversation-two" }, new AbortController().signal));
  for (const conversationId of ["../outside", "/tmp/outside", "bad\\path"]) {
    await assert.rejects(main.list(conversationId)); assert.throws(() => main.tools(conversationId));
  }
});

test("图片工具沿用材料图片能力，群传递得到独立原件副本", async (t) => {
  const { main, materials, groupMaterials } = await fixture(t);
  const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
  const attachment = (await main.upload("conversation-one", { name: "image.png", source: png })).attachment;
  const tools = Object.fromEntries(main.tools("conversation-one").map((tool) => [tool.name, tool]));
  const image = await tools.read_main_material_image!.execute("image", { id: attachment.id }, new AbortController().signal);
  assert.equal(image.content![1]!.type, "image"); assert.equal(image.content![1]!.mimeType, "image/png");
  const forwarded = await main.forward("conversation-one", "research-group", [attachment.id], { mutationId: "forward-image" });
  assert.notEqual(forwarded.attachmentIds[0], attachment.id);
  const original = await materials.raw("conversation-one", attachment.id), copied = await groupMaterials.raw("research-group", forwarded.attachmentIds[0]!);
  assert.notEqual(original.path, copied.path); assert.deepEqual(await readFile(copied.path), png);
  assert.deepEqual(await readFile(original.path), png);
});

test("群传递真正复制字节，重复或未知返回重试使用同一文件幂等标识", async (t) => {
  const { main, groupMaterials, imports, receipts, loseNextReply } = await fixture(t);
  const first = await upload(main, "conversation-one", "first.txt", "第一份共享资料");
  const second = await upload(main, "conversation-one", "second.txt", "第二份共享资料");
  loseNextReply();
  await assert.rejects(main.forward("conversation-one", "research-group", [first.id, second.id], { mutationId: "forward-batch" }));
  assert.equal(receipts.size, 1);
  const result = await main.forward("conversation-one", "research-group", [first.id, second.id], { mutationId: "forward-batch" });
  const replay = await main.forward("conversation-one", "research-group", [first.id, second.id], { mutationId: "forward-batch" });
  assert.deepEqual(result, replay); assert.equal(result.attachmentIds.length, 2); assert.equal(receipts.size, 2);
  assert.equal(imports[0]!.mutationId, imports[1]!.mutationId); assert.notEqual(imports[1]!.mutationId, imports[2]!.mutationId);
  assert.equal(imports.every((value) => /^[\w-]{1,80}$/.test(value.mutationId)), true);
  const copied = await groupMaterials.raw("research-group", result.attachmentIds[0]!);
  assert.equal(await readFile(copied.path, "utf8"), "第一份共享资料");
  assert.equal((await groupMaterials.list("research-group")).attachments.length, 2);
});

test("转交拒绝其他会话引用、不安全文件名和原件链接，不接受任意路径", async (t) => {
  const { root, main, materials, imports } = await fixture(t);
  const attachment = await upload(main, "conversation-one");
  await assert.rejects(main.forward("conversation-two", "research-group", [attachment.id], { mutationId: "wrong-conversation" }));
  await assert.rejects(main.forward("conversation-one", "research-group", ["../outside.txt"], { mutationId: "wrong-path" }));
  await assert.rejects(main.forward("conversation-one", "research-group", [attachment.id, attachment.id], { mutationId: "duplicate" }));
  for (const name of [".env", "../outside.txt"]) await assert.rejects(main.upload("conversation-one", { name, source: Buffer.from("fixture") }));
  const raw = await materials.raw("conversation-one", attachment.id), outside = join(root, "outside.txt");
  await writeFile(outside, "共享研究内容"); await rm(raw.path); await symlink(outside, raw.path);
  await assert.rejects(main.forward("conversation-one", "research-group", [attachment.id], { mutationId: "link" }));
  assert.equal(imports.length, 0);
});

test("同长度篡改原件也拒绝发布群副本，工作输入副本变化不影响权威原件", async (t) => {
  const { main, materials, groupMaterials } = await fixture(t);
  const attachment = await upload(main, "conversation-one", "notes.txt", "original");
  const copy = await main.storage.path!("conversation-one", `workspace/inputs/${attachment.id}/notes.txt`);
  await chmod(copy, 0o600); await writeFile(copy, "modified");
  const forwarded = await main.forward("conversation-one", "research-group", [attachment.id], { mutationId: "original-only" });
  const result = await groupMaterials.raw("research-group", forwarded.attachmentIds[0]!);
  assert.equal(await readFile(result.path, "utf8"), "original");
  const original = await materials.raw("conversation-one", attachment.id);
  await chmod(original.path, 0o600); await writeFile(original.path, "modified");
  await assert.rejects(main.forward("conversation-one", "new-group", [attachment.id], { mutationId: "changed-original" }), /原件已改变/);
  assert.deepEqual((await groupMaterials.list("new-group")).attachments, []);
});

test("close取消在途转交并关闭解析器，预取消不会调用群导入", { timeout: 5000 }, async (t) => {
  const { main, collaboration, parserCloses, imports } = await fixture(t);
  const attachment = await upload(main, "conversation-one");
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(main.forward("conversation-one", "research-group", [attachment.id], { mutationId: "pre-cancel", signal: cancelled.signal }), { name: "AbortError" });
  assert.equal(imports.length, 0);
  let entered: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  collaboration.importMaterial = async (_groupId, _options, { signal }) => {
    entered(); await new Promise((_resolve, reject) => {
      if (signal!.aborted) return reject(new DOMException("cancelled", "AbortError"));
      signal!.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
    });
  };
  const pending = main.forward("conversation-one", "research-group", [attachment.id], { mutationId: "cancel-flight" });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await started; await main.close(); await rejected;
  assert.equal(main.operations.size, 0); assert.ok(parserCloses() >= 1);
});

test("主对话文件可通过实际群服务导入并发布，重复传递只产生一份共享材料", async (t) => {
  const { root, main } = await fixture(t);
  const collaboration = new CollaborationService({ dataDir: join(root, "actual-groups"), agents: { ready: Promise.resolve(),
    capabilityCards: async () => ({ agents: [{ id: "researcher", name: "研究成员", description: "研究资料", ready: true, revision: 1 }] }) } });
  t.after(() => collaboration.close());
  main.collaboration = collaboration;
  const { group } = await collaboration.createGroup({ name: "研究组", purpose: "研究共享材料", memberIds: ["researcher"], mutationId: "create-research" });
  const original = await upload(main, "conversation-one", "research.md", "# 真实转交的研究内容");
  const forwarded = await main.forward("conversation-one", group.id, [original.id], { mutationId: "forward-actual" });
  const replay = await main.forward("conversation-one", group.id, [original.id], { mutationId: "forward-actual" });
  assert.deepEqual(replay, forwarded);
  const view = await collaboration.getGroup(group.id);
  assert.deepEqual(view.materials.map((value) => value.id), forwarded.attachmentIds);
  const raw = await collaboration.materials.raw!(group.id, forwarded.attachmentIds[0]!);
  assert.equal(await readFile(raw.path, "utf8"), "# 真实转交的研究内容");
});
