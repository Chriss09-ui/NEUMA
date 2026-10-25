import type { CollaborationOptions } from "../../src/agents/prototype-port.mjs";
import type { Progress } from "../../src/runtime/pi-port.mjs";
import { isArray, objectFields } from "../../src/runtime/type-boundary.mjs";
import { checkedText } from "../helpers/http-assertions.mjs";
import type { RequestHandler } from "../../src/server.mjs";
import type { RequestHandlerOptions } from "../../src/server.mjs";
import type { IncomingHttpHeaders } from "node:http";
import type { ServerAgents } from "../../src/server-port.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollaborationService } from "../../src/collaboration/groups.mjs";
import { GroupStorage, GroupStore } from "../../src/collaboration/group-store.mjs";
import { createRequestHandler } from "../../src/server.mjs";
import { MainAgent } from "../../src/main/main-agent.mjs";

class Response extends EventEmitter {
  declare status: number | undefined; declare headers: Record<string, unknown>;

  text = ""; writableEnded = false; destroyed = false;
  writeHead(status: number, headers: Record<string, unknown>) { this.status = status; this.headers = headers; }
  write(chunk: string) { this.text += chunk; }
  end(chunk = "") { this.text += chunk; this.writableEnded = true; }
  json() { return JSON.parse(String(this.text)); }
}
const req = (method: string, url: string, body: unknown = undefined, headers: IncomingHttpHeaders = {}) => Object.assign(Readable.from(body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))]), {
  method, url, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
});
async function fixture(t: test.TestContext, { durableMain = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-collaboration-api-"));
  const cards = [{ id: "analyst", name: "分析", ready: true, revision: 1, description: "分析资料", task: "分析", input: "资料", output: "报告", boundaries: [] }];
  const agents = { ready: Promise.resolve(), close: async () => {}, capabilityCards: async () => ({ agents: cards }), activitySnapshot: async () => ({ activities: [] }),
    file: async (_id: unknown, path: unknown) => ({ path, content: "真实文件内容", truncated: false }),
    executeCollaboration: async (input: CollaborationOptions, _progress?: Progress, { signal }: { signal?: AbortSignal | undefined } = {}) => {
      if (input.role === "routing") {
        await input.customTools!.find((tool) => tool.name === "submit_group_route")!.execute("route", { mode: "default" }, signal);
        return { reply: "", turns: 1 };
      }
      const payload = JSON.parse(String(input.message)), tool = input.customTools!.find((value) => value.name === "submit_group_intent" || value.name === "submit_group_turn");
      assert.ok(tool);
      await tool.execute("call-1", tool.name === "submit_group_intent" ? { participate: true, contribution: "读取资料形成报告", willingToIntegrate: true, integratorId: "analyst" }
        : { status: "complete", result: payload.kind === "integration" ? "完成最终报告" : "实际分析结果" }, signal);
      return { reply: "", turns: 1 };
    } };
  const collaboration = new CollaborationService({ dataDir: root, agents });
  const mainAgent = durableMain ? new MainAgent({ config: { llmConfigured: false }, dataDir: root, agents, collaboration })
    : { ready: Promise.resolve(), close: async () => {}, getConversation: async (id: unknown) => ({ conversation: { id, messages: [] } }),
    listConversations: async () => ({ conversations: [] }), createConversation: async () => ({ conversation: { id: "main-test", messages: [] } }),
    activateRequirements: async ({ conversationId, agentId }: Record<string, unknown> = {}) => ({ conversation: { id: conversationId }, context: { type: "requirements", agentId: agentId ?? "new-agent" } }),
    prompt: async ({ conversationId }: Record<string, unknown> = {}, progress?: Progress) => {
      const context = { type: "group", groupId: "group-test", taskId: "task-test" };
      progress?.({ type: "text-delta", delta: "正在查看实际状态" }); progress?.({ type: "context", context });
      return { reply: "实际状态", conversation: { id: conversationId, context }, context };
    }, cancel: async () => ({ cancelled: true }) };
  const handler = createRequestHandler({ dataDir: root, config: {}, providers: {}, projects: { dispose: async () => {} },
    projectAgent: { dispose: async () => {} }, prototypeAgents: agents, collaboration, mainAgent });
  await handler.ready;
  t.after(async () => { await handler.dispose(); await rm(root, { recursive: true, force: true }); });
  const invoke = async (method: string, url: string, body: unknown = undefined, headers: IncomingHttpHeaders = {}) => { const response = new Response(); await handler(req(method, url, body, headers), response); return response; };
  return { root, handler, collaboration, mainAgent, invoke };
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
  assert.equal(JSON.parse(String(ndjson.text.trim().split("\n").at(-1))).type, "done");
  const activity = (await invoke("GET", "/api/activity")).json();
  assert.equal(activity.tasks[0].groupId, groupId); assert.equal(activity.tasks[0].result, "完成最终报告");
  assert.equal((await invoke("GET", "/api/main/conversations")).status, 200);
  const main = await invoke("POST", "/api/main/conversations/main-test/messages", { message: "进度怎么样", mutationId: "main-message" }, { accept: "application/x-ndjson" });
  const result = main.text.trim().split("\n").map((text) => JSON.parse(text));
  assert.equal(result[0].type, "text-delta"); assert.equal(result.at(-1).result.reply, "实际状态");
  assert.deepEqual(result[1], { type: "context", context: { type: "group", groupId: "group-test", taskId: "task-test" } });
  assert.deepEqual(result.at(-1).result.context, result[1].context);
});

test("群会话删除 API 持久移除全部续轮，保护同群其他会话并拒绝迟到提交和跨来源操作", async (t) => {
  const { invoke, collaboration } = await fixture(t);
  const group = (await invoke("POST", "/api/groups", { name: "删除测试", memberIds: ["analyst"], mutationId: "create" })).json().group;
  const base = `/api/groups/${group.id}`;
  const original = { content: "第一份报告", mutationId: "first" };
  const first = (await invoke("POST", `${base}/messages`, original)).json(); await collaboration.idle(group.id);
  const second = (await invoke("POST", `${base}/messages`, { content: "补充报告结论", taskId: first.task.id, mutationId: "second" })).json();
  await collaboration.idle(group.id);
  const third = (await invoke("POST", `${base}/messages`, { content: "另一段对话", newTask: true, mutationId: "third" })).json();
  await collaboration.idle(group.id);
  const path = `${base}/conversations/${first.task.id}/remove`, input = { mutationId: "remove" };
  assert.equal((await invoke("POST", path, {})).status, 400);
  assert.equal((await invoke("GET", path)).status, 404);
  assert.equal((await invoke("POST", path, input, { host: "127.0.0.1:3000", origin: "https://outside.invalid" })).status, 403);
  await collaboration.store.change(group.id, (record) => { record.tasks!.find((task) => task.id === third.task.id)!.status = "needs_input"; });
  for (let attempt = 0; attempt < 2; attempt++) {
    const removed = await invoke("POST", path, input);
    assert.equal(removed.status, 200); assert.deepEqual(removed.json(), { removed: true, conversationId: first.task.id });
  }
  const current = (await invoke("GET", base)).json();
  assert.deepEqual(current.tasks.map((task: { id: unknown; }) => task.id), [third.task.id]);
  assert.ok(current.messages.every((message: { taskId: unknown; }) => message.taskId === third.task.id));
  const stored = objectFields(await collaboration.store.storage.readJson(group.id, "group.json"));
  assert.ok(isArray(stored.messages));
  assert.ok(stored.messages.every((message) => objectFields(message).taskId === third.task.id));
  assert.ok(isArray(stored.deletedConversations));
  assert.deepEqual(objectFields(stored.deletedConversations[0]).taskIds, [first.task.id, second.task.id]);
  for (const body of [original, { content: "迟到输入", taskId: second.task.id, mutationId: "late" }]) {
    const rejected = await invoke("POST", `${base}/messages`, body);
    assert.equal(rejected.status, 409); assert.match(rejected.json().error, /已删除/);
    assert.equal(rejected.json().reason, "conversation_deleted");
  }
  const busy = await invoke("POST", `${base}/conversations/${third.task.id}/remove`, { mutationId: "remove-third" });
  assert.equal(busy.status, 409); assert.match(busy.json().error, /停止后再删除/);
  const reused = await invoke("POST", `${base}/conversations/${third.task.id}/remove`, input);
  assert.equal(reused.status, 409);
});

test("群与主对话上传均在读取内容前拒绝超过 20 MiB 的请求", async (t) => {
  const { invoke, collaboration } = await fixture(t);
  const group = (await invoke("POST", "/api/groups", { name: "材料限制", purpose: "检查材料", memberIds: ["analyst"], mutationId: "material-limit" })).json().group;
  for (const path of [`/api/groups/${group.id}/materials?name=large.pdf`, "/api/main/conversations/main-test/materials"]) {
    const result = await invoke("POST", path, undefined, { "content-type": "application/pdf", "content-length": String(20 * 1024 * 1024 + 1), "x-file-name": "large.pdf" });
    assert.equal(result.status, 400); assert.match(result.json().error, /20 MiB/);
  }
  assert.deepEqual((await collaboration.getGroup(group.id)).materials, []);
});

test("主对话在原会话中打开创建或迭代需求，保留本机来源保护", async (t) => {
  const { invoke } = await fixture(t);
  const module = await invoke("GET", "/main-context.js");
  assert.equal(module.status, 200);
  assert.match(checkedText(module.headers["content-type"]), /javascript/);
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

test("主历史删除 API 校验确认与版本，幂等删除后拒绝所有旧会话入口和材料访问", async (t) => {
  const { invoke, mainAgent } = await fixture(t, { durableMain: true });
  assert.ok(mainAgent instanceof MainAgent);
  const created = (await invoke("POST", "/api/main/conversations", { mutationId: "create_delete_test" })).json().conversation;
  const path = `/api/main/conversations/${created.id}`;
  const input = { confirm: true, expectedVersion: created.version, mutationId: "delete_test" };
  assert.equal((await invoke("POST", `${path}/remove`, { ...input, confirm: false })).status, 400);
  assert.equal((await invoke("POST", `${path}/remove`, { ...input, expectedVersion: 0 })).status, 400);
  assert.equal((await invoke("POST", `${path}/remove`, input, { host: "localhost:3000", origin: "https://outside.invalid" })).status, 403);
  const activated = await invoke("POST", `${path}/requirements`, { mutationId: "changed_in_another_window" });
  assert.equal(activated.status, 200);
  const conflict = await invoke("POST", `${path}/remove`, input);
  assert.equal(conflict.status, 409); assert.equal(conflict.json().reason, "conversation_conflict");
  const upload = await invoke("POST", `${path}/materials`, Buffer.from("保留原材料"), {
    "x-file-name": encodeURIComponent("历史资料.txt"), "content-type": "text/plain",
  });
  assert.equal(upload.status, 200);
  const attachment = upload.json().attachment, raw = await mainAgent.materials.materials!.raw!(created.id, attachment.id);
  const current = (await mainAgent.getConversation(created.id)).conversation;
  const removal = { ...input, expectedVersion: current.version };
  for (let attempt = 0; attempt < 2; attempt++) {
    const removed = await invoke("POST", `${path}/remove`, removal);
    assert.equal(removed.status, 200); assert.deepEqual(removed.json(), { removed: true, conversationId: created.id });
  }
  assert.deepEqual((await invoke("GET", "/api/main/conversations")).json().conversations, []);
  assert.equal(await readFile(raw.path, "utf8"), "保留原材料");
  for (const [method, url, body] of [["GET", path], ["POST", `${path}/messages`, { message: "迟到消息", mutationId: "late_turn" }],
    ["POST", `${path}/requirements`, { mutationId: "late_activation" }], ["GET", `${path}/materials`],
    ["GET", `${path}/materials/${attachment.id}/raw`], ["GET", `${path}/materials/${attachment.id}/preview`],
    ["POST", `${path}/materials`, {}], ["POST", "/api/main/conversations", { mutationId: "create_delete_test" }]] as const) {
    const result = await invoke(method, url, body);
    assert.equal(result.status, 409); assert.equal(result.json().reason, "conversation_deleted");
  }
  assert.equal((await invoke("GET", `${path}/remove`)).status, 404);
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
  const create = async (mutationId: string) => (await invoke("POST", "/api/groups", { name: "研究组", memberIds: ["analyst"], mutationId })).json().group;
  const one = await create("one"), two = await create("two");
  const upload = await invoke("POST", `/api/groups/${one.id}/materials`, Buffer.from("共享输入"), { "x-file-name": encodeURIComponent("资料.txt"), "content-type": "text/plain" });
  assert.equal(upload.status, 200); const materialId = upload.json().attachment.id;
  assert.equal((await collaboration.requireMaterial(one.id, materialId)).name, "资料.txt");
  assert.equal((await invoke("GET", `/api/groups/${two.id}/materials/${materialId}/preview`)).status, 400);
  const orphan = await collaboration.materials.upload!(one.id, { name: "孤儿.txt", source: Buffer.from("未发布") });
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
  let enter!: (value?: unknown) => void, release!: (value?: unknown) => void, entered = new Promise((resolve) => { enter = resolve; }), held = new Promise((resolve) => { release = resolve; });
  let calls = 0, closed = false;
  const config = { model: "old-model" };
  const collaboration = { ready: Promise.resolve(), close: async () => { if (!closed) { closed = true; enter(); await held; } } };
  const mainAgent = { ready: Promise.resolve(), close: async () => {}, prompt: async ({ conversationId }: Record<string, unknown> = {}) => {
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
