import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollaborationService } from "../src/collaboration/groups.mjs";
import { GroupStorage, GroupStore } from "../src/collaboration/group-store.mjs";
import { createRequestHandler } from "../src/server.mjs";

class Response extends EventEmitter {
  text = ""; writableEnded = false; destroyed = false;
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  write(chunk) { this.text += chunk; }
  end(chunk = "") { this.text += chunk; this.writableEnded = true; }
  json() { return JSON.parse(this.text); }
}
const req = (method, url, body, headers = {}) => Object.assign(Readable.from(body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))]), {
  method, url, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "neuma-collaboration-api-"));
  const cards = [{ id: "analyst", name: "分析", ready: true, revision: 1, description: "分析资料", task: "分析", input: "资料", output: "报告", boundaries: [] }];
  const agents = { ready: Promise.resolve(), close: async () => {}, capabilityCards: async () => ({ agents: cards }), activitySnapshot: async () => ({ activities: [] }),
    file: async (_id, path) => ({ path, content: "真实文件内容", truncated: false }),
    executeCollaboration: async (input, _progress, { signal }) => {
      const payload = JSON.parse(input.message), tool = input.customTools.find((value) => value.name === "submit_group_intent" || value.name === "submit_group_turn");
      await tool.execute("call-1", tool.name === "submit_group_intent" ? { participate: true, contribution: "读取资料形成报告", willingToIntegrate: true, integratorId: "analyst" }
        : { status: "complete", result: payload.kind === "integration" ? "完成最终报告" : "实际分析结果" }, signal);
      return { reply: "", turns: 1 };
    } };
  const collaboration = new CollaborationService({ dataDir: root, agents });
  const mainAgent = { ready: Promise.resolve(), close: async () => {}, getConversation: async (id) => ({ conversation: { id, messages: [] } }),
    listConversations: async () => ({ conversations: [] }), createConversation: async () => ({ conversation: { id: "main-test", messages: [] } }),
    activateRequirements: async ({ conversationId, agentId }) => ({ conversation: { id: conversationId }, context: { type: "requirements", agentId: agentId ?? "new-agent" } }),
    prompt: async ({ conversationId }, progress) => {
      const context = { type: "group", groupId: "group-test", taskId: "task-test" };
      progress?.({ type: "text-delta", delta: "正在查看实际状态" }); progress?.({ type: "context", context });
      return { reply: "实际状态", conversation: { id: conversationId, context }, context };
    }, cancel: async () => ({ cancelled: true }) };
  const handler = createRequestHandler({ dataDir: root, config: {}, providers: {}, projects: { dispose: async () => {} },
    projectAgent: { dispose: async () => {} }, prototypeAgents: agents, collaboration, mainAgent });
  await handler.ready;
  t.after(async () => { await handler.dispose(); await rm(root, { recursive: true, force: true }); });
  const invoke = async (method, url, body, headers) => { const response = new Response(); await handler(req(method, url, body, headers), response); return response; };
  return { root, handler, collaboration, invoke };
}

test("群API提供独立持久任务、能力卡、事件续读和全局活动，群外主Agent可使用相同事实", async (t) => {
  const { invoke, collaboration } = await fixture(t);
  assert.equal((await invoke("GET", "/api/collaboration/agents")).json().agents[0].id, "analyst");
  const created = await invoke("POST", "/api/groups", { name: "研究组", purpose: "研究资料", memberIds: ["analyst"], mutationId: "create-one" });
  assert.equal(created.status, 200); const groupId = created.json().group.id;
  const post = await invoke("POST", `/api/groups/${groupId}/messages`, { content: "完成一份报告", mutationId: "message-one" });
  assert.equal(post.status, 200); await collaboration.idle(groupId);
  const view = (await invoke("GET", `/api/groups/${groupId}`)).json();
  assert.equal(view.tasks[0].status, "completed");
  const events = (await invoke("GET", `/api/groups/${groupId}/events?after=0`)).json();
  const after = events.lastSequence;
  assert.deepEqual((await invoke("GET", `/api/groups/${groupId}/events?after=${after}`)).json().events, []);
  const ndjson = await invoke("GET", `/api/groups/${groupId}/events?after=0`, undefined, { accept: "application/x-ndjson" });
  assert.equal(JSON.parse(ndjson.text.trim().split("\n").at(-1)).type, "done");
  const activity = (await invoke("GET", "/api/activity")).json();
  assert.equal(activity.tasks[0].groupId, groupId); assert.equal(activity.tasks[0].result, "完成最终报告");
  assert.equal((await invoke("GET", "/api/main/conversations")).status, 200);
  const main = await invoke("POST", "/api/main/conversations/main-test/messages", { message: "进度怎么样", mutationId: "main-message" }, { accept: "application/x-ndjson" });
  const result = main.text.trim().split("\n").map(JSON.parse);
  assert.equal(result[0].type, "text-delta"); assert.equal(result.at(-1).result.reply, "实际状态");
  assert.deepEqual(result[1], { type: "context", context: { type: "group", groupId: "group-test", taskId: "task-test" } });
  assert.deepEqual(result.at(-1).result.context, result[1].context);
});

test("主对话在原会话中打开创建或迭代需求，保留本机来源保护", async (t) => {
  const { invoke } = await fixture(t);
  const module = await invoke("GET", "/main-context.js");
  assert.equal(module.status, 200);
  assert.match(module.headers["content-type"], /javascript/);
  assert.match(module.text, /export function createMainContext/);
  const fresh = await invoke("POST", "/api/main/conversations/main-test/requirements", { mutationId: "start-new" });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.json().conversation.id, "main-test");
  assert.deepEqual(fresh.json().context, { type: "requirements", agentId: "new-agent" });
  const edit = await invoke("POST", "/api/main/conversations/main-test/requirements", { agentId: "analyst", mutationId: "edit" });
  assert.equal(edit.json().context.agentId, "analyst");
  const outside = await invoke("POST", "/api/main/conversations/main-test/requirements", {}, { host: "127.0.0.1:3000", origin: "https://outside.invalid" });
  assert.equal(outside.status, 403);
});

test("群管理保留本机来源保护和版本冲突，过期保存不覆盖成员", async (t) => {
  const { invoke } = await fixture(t);
  const forbidden = await invoke("POST", "/api/groups", {}, { host: "127.0.0.1:3000", origin: "https://outside.invalid" });
  assert.equal(forbidden.status, 403);
  const { group } = (await invoke("POST", "/api/groups", { name: "研究组", memberIds: ["analyst"], mutationId: "create-one" })).json();
  const input = { name: "新的研究组", expectedVersion: group.version, mutationId: "rename" };
  const renamed = await invoke("POST", `/api/groups/${group.id}`, input); assert.equal(renamed.status, 200);
  const repeat = await invoke("POST", `/api/groups/${group.id}`, input); assert.equal(repeat.status, 200);
  const conflict = await invoke("POST", `/api/groups/${group.id}`, { ...input, name: "旧请求", mutationId: "old" });
  assert.equal(conflict.status, 409);
  assert.equal((await invoke("GET", `/api/groups/${group.id}`)).json().group.name, "新的研究组");
  assert.equal((await invoke("GET", `/api/groups/${group.id}/events?after=-1`)).status, 400);
  assert.equal((await invoke("POST", `/api/groups/${group.id}/messages`, { content: "联系群外成员", recipientId: "main", mutationId: "outside" })).status, 400);
});

test("共享材料以群登记为准，跨群和未发布孤儿材料不可见；提交失败清理新文件", async (t) => {
  const { invoke, collaboration } = await fixture(t);
  const create = async (mutationId) => (await invoke("POST", "/api/groups", { name: "研究组", memberIds: ["analyst"], mutationId })).json().group;
  const one = await create("one"), two = await create("two");
  const upload = await invoke("POST", `/api/groups/${one.id}/materials`, Buffer.from("共享输入"), { "x-file-name": encodeURIComponent("资料.txt"), "content-type": "text/plain" });
  assert.equal(upload.status, 200); const materialId = upload.json().attachment.id;
  assert.equal((await collaboration.requireMaterial(one.id, materialId)).name, "资料.txt");
  assert.equal((await invoke("GET", `/api/groups/${two.id}/materials/${materialId}/preview`)).status, 400);
  const orphan = await collaboration.materials.upload(one.id, { name: "孤儿.txt", source: Buffer.from("未发布") });
  assert.equal((await collaboration.getGroup(one.id)).materials.length, 1);
  await assert.rejects(collaboration.requireMaterial(one.id, orphan.attachment.id));
  const write = collaboration.store.storage.writeJson.bind(collaboration.store.storage);
  collaboration.store.storage.writeJson = async (...args) => { if (args[1] === "group.json") throw new Error("disk full"); return write(...args); };
  await assert.rejects(collaboration.uploadMaterial(one.id, { name: "失败.txt", source: Buffer.from("不能发布") }));
  collaboration.store.storage.writeJson = write;
  assert.equal((await collaboration.materials.list(one.id)).attachments.some((item) => item.name === "失败.txt"), false);
  assert.equal((await collaboration.getGroup(one.id)).materials.length, 1);
});

test("群存储拒绝符号链接和越界路径；提交失败不发布内存状态", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-group-storage-")); t.after(() => rm(root, { recursive: true, force: true }));
  const storage = new GroupStorage({ dataDir: root }); await storage.ready;
  await assert.rejects(storage.path("test", "../outside", true));
  await storage.directory("test", "", { create: true });
  const outside = join(root, "outside.json"); await writeFile(outside, "{}");
  await symlink(outside, join(root, "groups", "test", "group.json"));
  await assert.rejects(storage.writeJson("test", "group.json", {}));
  await assert.rejects(storage.readJson("test", "group.json"));
  assert.equal(await readFile(outside, "utf8"), "{}");
  await rm(join(root, "groups", "test", "group.json"));
  const store = new GroupStore({ dataDir: root, storage });
  const group = await store.create({ name: "群", purpose: "", memberIds: ["one"], mutationId: "new" });
  const write = storage.writeJson; storage.writeJson = async () => { throw new Error("disk full"); };
  await assert.rejects(store.change(group.id, (record) => { record.group.name = "未保存"; }));
  storage.writeJson = write;
  assert.equal((await store.get(group.id)).group.name, "群");
});

test("模型设置重置期间新主请求等待全部运行时关闭，不能抢先使用旧连接", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-settings-collaboration-"));
  let enter, release, entered = new Promise((resolve) => { enter = resolve; }), held = new Promise((resolve) => { release = resolve; });
  let calls = 0, closed = false;
  const config = { model: "old-model" };
  const collaboration = { ready: Promise.resolve(), close: async () => { if (!closed) { closed = true; enter(); await held; } } };
  const mainAgent = { ready: Promise.resolve(), close: async () => {}, prompt: async ({ conversationId }) => {
    calls++; return { reply: config.model, conversation: { id: conversationId } };
  } };
  const handler = createRequestHandler({ dataDir: root, envPath: join(root, "test-config.env"), config, providers: {},
    prototypeAgents: { close: async () => {} }, projectAgent: { dispose: async () => {} }, projects: { dispose: async () => {} }, collaboration, mainAgent });
  t.after(async () => { release(); await handler.dispose(); await rm(root, { recursive: true, force: true }); });
  const settingsResponse = new Response(), mainResponse = new Response();
  const settings = handler(req("POST", "/api/settings", { model: "new-model" }), settingsResponse);
  await entered;
  const main = handler(req("POST", "/api/main/conversations/main-test/messages", { message: "查看状态", mutationId: "test" }), mainResponse);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0); assert.equal(mainResponse.writableEnded, false);
  release(); await Promise.all([settings, main]);
  assert.equal(settingsResponse.status, 200); assert.equal(mainResponse.json().reply, "new-model"); assert.equal(calls, 1);
});
