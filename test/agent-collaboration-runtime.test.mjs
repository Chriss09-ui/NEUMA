import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrototypeAgents } from "../src/agents/agent-prototype.mjs";
import { ActivityStore } from "../src/runtime/activity-store.mjs";
import { createPiSession } from "../src/runtime/pi-runtime.mjs";
import { CAPABILITIES } from "../src/architecture/architecture-contract.mjs";
import { validDraft, validDesign, passingReview } from "./helpers/architecture.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const input = (id, goal) => ({ id, name: `成员 ${id}`, draft: validDraft(goal) });
const round = (agentId = "a", sessionId = "collaboration-session-12345", overrides = {}) => ({ agentId, revision: 1, sessionId,
  scope: { groupId: "group-one", taskId: "task-one" }, message: "处理当前共享任务", systemContext: "只处理本群本任务", ...overrides });

async function fixture(t, run = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-collaboration-runtime-")), records = [];
  const options = { config: { llmConfigured: true }, cwd: root, dataDir: join(root, "data"), sessionFactory: async (options) => {
    const listeners = new Set(), tools = Object.fromEntries(options.customTools.map((tool) => [tool.name, tool]));
    const record = { options, tools, prompts: [], disposed: false, aborted: false, reply: "已完成当前任务" };
    const session = { messages: [], subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      setAutoCompactionEnabled(value) { record.autoCompaction = value; }, getLastAssistantText: () => record.reply,
      async abort() { record.aborted = true; record.release?.(); }, dispose() { record.disposed = true; },
      async prompt(message) {
        record.prompts.push(message);
        if (tools.submit_architecture) {
          const payload = JSON.parse(message);
          return tools.submit_architecture.execute("build", validDesign(payload.requirements, {
            capabilities: CAPABILITIES.map(({ id, scope }) => ({ id, status: "available", reason: scope })) }));
        }
        if (tools.submit_architecture_review) return tools.submit_architecture_review.execute("review", passingReview(JSON.parse(message).candidateHash));
        const emit = (event) => { for (const listener of listeners) listener(event); };
        emit({ type: "turn_start" });
        await run(record, session, emit);
        emit({ type: "turn_end" });
      } };
    record.session = session; records.push(record); return session;
  } };
  const agents = new PrototypeAgents(options);
  t.after(async () => { await agents.close(); await rm(root, { recursive: true, force: true }); });
  await agents.build(input("a"));
  return { root, records, options, agents, executions: () => records.filter((record) => !record.tools.submit_architecture && !record.tools.submit_architecture_review) };
}

test("群短会话不含私人记忆/材料工具，协商只装群工具，工具提交可以无自然语言", async (t) => {
  const { agents, executions } = await fixture(t, async (record) => {
    if (record.tools.claim_work) { record.reply = ""; await record.tools.claim_work.execute("claim", {}); }
  });
  await agents.setMemory("a", "PRIVATE_MEMORY_FIXTURE");
  const claim = { name: "claim_work", parameters: { type: "object", properties: {} }, execute: async () => ({
    content: [{ type: "text", text: "accepted" }], details: {}, terminate: true }) };
  assert.deepEqual(await agents.executeCollaboration(round("a", undefined, { allowBusinessTools: false, customTools: [claim] })), { reply: "", turns: 1 });
  const first = executions()[0];
  assert.deepEqual(Object.keys(first.tools), ["claim_work"]);
  assert.doesNotMatch(JSON.stringify(first.options.systemPrompt) + first.prompts.join(""), /PRIVATE_MEMORY_FIXTURE|list_materials|read_material/);
  assert.equal(first.disposed, true); assert.equal(first.autoCompaction, false);
  await agents.executeCollaboration(round("a", "second-group-session-12345"));
  assert.deepEqual(Object.keys(executions()[1].tools), ["list_workspace_files", "read_workspace_file", "write_workspace_file", "web_search", "web_fetch"]);
  assert.notEqual(executions()[0].session, executions()[1].session);
  const activity = (await agents.activitySnapshot()).activities;
  assert.equal(activity.length, 2); assert.equal(activity.every((item) => item.status === "complete"), true);
  assert.deepEqual(activity[0].scope, { groupId: "group-one", taskId: "task-one" });
});

test("群业务文件工具与专用程序仅使用当前群/任务子目录，无法读取私人和其他群文件", async (t) => {
  const { agents, executions } = await fixture(t, async (record) => {
    await record.tools.write_workspace_file.execute("file", { file: "result.txt", content: "本任务产物" });
    await assert.rejects(record.tools.read_workspace_file.execute("private", { file: "private.txt" }), /没有找到/);
    await assert.rejects(record.tools.read_workspace_file.execute("escape", { file: "../../../../private.txt" }), /目录外部/);
  });
  const privateRoot = await agents.workspace("a");
  await writeFile(join(privateRoot, "private.txt"), "PRIVATE_FILE_FIXTURE");
  await agents.executeCollaboration(round());
  const firstRoot = join(privateRoot, "group-tasks/group-one/task-one/a");
  assert.equal(executions()[0].options.cwd, firstRoot);
  assert.equal(await readFile(join(firstRoot, "result.txt"), "utf8"), "本任务产物");
  assert.equal(await readFile(join(privateRoot, "private.txt"), "utf8"), "PRIVATE_FILE_FIXTURE");
  await agents.executeCollaboration(round("a", "other-group-session-12345", { scope: { groupId: "group-two", taskId: "task-one" },
    message: "长平台材料".repeat(3000) }));
  const secondRoot = join(privateRoot, "group-tasks/group-two/task-one/a");
  assert.equal(executions()[1].options.cwd, secondRoot); assert.notEqual(firstRoot, secondRoot);
  let workflowRoot;
  agents.agents.set("a", { ...agents.agents.get("a"), execution: { kind: "node-json" } });
  agents.approvedDefinition = () => true;
  agents.developedTools = async (_agent, root) => { workflowRoot = root; return []; };
  await agents.executeCollaboration(round("a", "developed-group-session-12345"));
  assert.equal(workflowRoot, firstRoot);
});

test("协作不接受未就绪/错误版本、工具覆盖、超过次数，执行工具时重新核实版本", async (t) => {
  let changeVersion = false;
  const { agents } = await fixture(t, async (record, _session, emit) => {
    if (record.prompts[0].includes("超过轮次")) { emit({ type: "turn_end" }); emit({ type: "turn_start" }); return; }
    if (changeVersion) {
      agents.agents.set("a", { ...agents.agents.get("a"), revision: 2 });
      await record.tools.write_workspace_file.execute("write", { file: "blocked.txt", content: "不能保存" });
    }
  });
  await assert.rejects(agents.executeCollaboration(round("a", undefined, { revision: 2 })), /定义已改变/);
  await assert.rejects(agents.executeCollaboration(round("a", undefined, { customTools: [{ name: "read_material", execute: async () => ({}) }] })), /权限冲突/);
  await assert.rejects(agents.executeCollaboration(round("a", undefined, { maxTurns: 1, message: "超过轮次" })), (error) => error.diagnostic?.reason === "turn_limit");
  changeVersion = true;
  await assert.rejects(agents.executeCollaboration(round()), /定义已改变/);
});

test("私聊与群共用同 Agent 队列，全局两个执行，排队取消不创建模型会话", async (t) => {
  const started = new Map();
  const { agents, executions } = await fixture(t, async (record) => {
    if (record.prompts[0].includes("保持等待")) {
      started.set(record.options.cwd.split("/agents/").at(-1).split("/")[0], record);
      await new Promise((resolve) => { record.release = resolve; });
    }
  });
  await agents.build(input("b")); await agents.build(input("c"));
  const a = agents.prompt({ agentId: "a", sessionId: "private-wait-session-12345", message: "保持等待" });
  const b = agents.executeCollaboration(round("b", "group-wait-session-12345", { message: "保持等待" }));
  while (started.size < 2) await tick();
  const controller = new AbortController();
  const waiting = agents.executeCollaboration(round("a", "queued-cancel-session-12345"), undefined, { signal: controller.signal });
  const rejected = assert.rejects(waiting, (error) => error.diagnostic?.reason === "cancelled");
  const c = agents.executeCollaboration(round("c", "queued-other-session-12345"));
  await tick(); assert.equal(executions().length, 2);
  controller.abort(); await rejected;
  started.get("b").release(); await b; await c;
  assert.equal(executions().length, 3);
  started.get("a").release(); await a;
  assert.equal((await agents.activitySnapshot()).activities.some((item) => item.sessionId === "queued-cancel-session-12345" && item.status === "cancelled"), true);
});

test("能力卡包含未生成成员而不泄露指令/记忆，活动摘要清理并在重启标中断", async (t) => {
  const { agents, options } = await fixture(t);
  await agents.setMemory("a", "PRIVATE_MEMORY_FIXTURE");
  const profile = { name: "成员 a", description: "公开能力简介", icon: "star:4:1" };
  await agents.setProfile("a", profile);
  await agents.saveRequirements("pending", input("pending", "等待开发"));
  const cards = (await agents.capabilityCards()).agents;
  assert.equal(cards.find((item) => item.id === "pending").ready, false);
  assert.equal(cards.find((item) => item.id === "pending").revision, null);
  assert.equal(cards.find((item) => item.id === "a").ready, true);
  assert.deepEqual(cards.find((item) => item.id === "a").profile, { icon: profile.icon });
  assert.doesNotMatch(JSON.stringify(cards), /PRIVATE_MEMORY_FIXTURE|instructions|architectureRef/);
  cards.find((item) => item.id === "a").profile.icon = "star:0:0";
  assert.deepEqual((await agents.get("a")).profile, profile);
  await agents.setProfile("a", { ...profile, icon: "star:2:6" });
  assert.deepEqual((await agents.capabilityCards()).agents.find((item) => item.id === "a").profile, { icon: "star:2:6" });
  const pending = await agents.activities.start({ agentId: "a", sessionId: "interrupted-session-12345", revision: 1,
    scope: { groupId: "group-one", taskId: "task-one" }, message: 'Bearer private-fixture api_key="private-fixture"' });
  assert.doesNotMatch(pending.summary, /private-fixture/);
  const restored = new ActivityStore({ storage: agents.storage });
  const snapshot = await restored.snapshot();
  assert.equal(snapshot.activities.find((item) => item.id === pending.id).status, "interrupted");
  const file = JSON.parse(await readFile(join(options.dataDir, "agents/a/activities.json"), "utf8"));
  assert.equal(file.schemaVersion, 1); assert.equal(file.activities[0].status, "interrupted");
});

test("主 Agent 委派来源只接可信调用参数，普通请求正文不能注入且记录可恢复", async (t) => {
  const { agents } = await fixture(t);
  await agents.prompt({ agentId: "a", sessionId: "main-delegation-session-12345", message: "处理明确委派" }, undefined,
    { activityScope: { kind: "main", conversationId: "main-conversation-one" } });
  await agents.prompt({ agentId: "a", sessionId: "private-normal-session-12345", message: "正常私聊",
    activityScope: { kind: "main", conversationId: "spoofed-main" }, source: { kind: "main", conversationId: "spoofed-main" } });
  const snapshot = (await agents.activitySnapshot()).activities;
  assert.deepEqual(snapshot.find((value) => value.sessionId === "main-delegation-session-12345").scope,
    { kind: "main", conversationId: "main-conversation-one" });
  assert.deepEqual(snapshot.find((value) => value.sessionId === "private-normal-session-12345").scope,
    { kind: "private", sessionId: "private-normal-session-12345" });
  const restored = await new ActivityStore({ storage: agents.storage }).snapshot();
  assert.equal(restored.activities.find((value) => value.scope.kind === "main").scope.conversationId, "main-conversation-one");
  for (const activityScope of [{ kind: "main", conversationId: "../outside" }, { kind: "main", conversationId: "valid", arbitrary: "must-not-save" },
    { kind: "group", groupId: "other-group" }]) await assert.rejects(agents.prompt({ agentId: "a", sessionId: "invalid-source-session-12345", message: "不能执行" },
      undefined, { activityScope }));
});

test("构建与移除开始通知监听器，移除会取消群执行和队列", async (t) => {
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const { agents } = await fixture(t, async (record) => { started(); await new Promise((resolve) => { record.release = resolve; }); });
  const events = [], stop = agents.onLifecycle((event) => { events.push(event); });
  await agents.build(input("b"));
  assert.deepEqual(events[0], { type: "build", agentId: "b" });
  const running = agents.executeCollaboration(round());
  const failed = assert.rejects(running, (error) => error.diagnostic?.reason === "cancelled");
  await ready;
  const queued = agents.executeCollaboration(round("a", "remove-queued-session-12345"));
  const queueFailed = assert.rejects(queued, (error) => error.diagnostic?.reason === "cancelled");
  await tick(); await agents.remove("a"); await Promise.all([failed, queueFailed]);
  assert.equal(events.some((event) => event.type === "remove" && event.agentId === "a"), true);
  stop();
  assert.equal(agents.scheduler.snapshot().running, 0);
});

test("活动保留最近200条，原子保存失败不发布内存状态", async () => {
  let published, fail = false;
  const store = new ActivityStore({ storage: { agentIds: async () => [], async writeJson(_id, _file, value) {
    if (fail) throw new Error("fixture-storage-failure");
    published = structuredClone(value);
  } } });
  for (let index = 0; index < 201; index++) {
    const record = await store.start({ agentId: "a", sessionId: `session-${index}`, revision: 1,
      scope: { kind: "private", sessionId: `session-${index}` }, message: `任务 ${index}` });
    await store.update("a", record.id, { status: "complete" });
  }
  assert.equal((await store.snapshot()).activities.length, 200); assert.equal(published.activities.length, 200);
  fail = true;
  await assert.rejects(store.start({ agentId: "a", sessionId: "failed-save", revision: 1,
    scope: { kind: "private", sessionId: "failed-save" }, message: "不能发布" }));
  assert.equal((await store.snapshot()).activities.some((item) => item.sessionId === "failed-save"), false);
});

test("真实 Pi 群工具终止无额外回执，上限阻止第二个模型请求", async (t) => {
  const { agents } = await fixture(t);
  let requests = 0;
  const model = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests++;
    assert.deepEqual(body.tools.map((tool) => tool.function.name), ["claim_work"]);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1,
      model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${requests}`, type: "function", function: { name: "claim_work", arguments: "{}" } }] });
    chunk({}, "tool_calls"); response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve, reject) => { model.once("error", reject); model.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve) => model.close(resolve)));
  Object.assign(agents.config, { chatUrl: `http://127.0.0.1:${model.address().port}/v1/chat/completions`, model: "fixture-model", apiKey: "fixture-only" });
  agents.sessionFactory = createPiSession;
  const tool = (terminate) => ({ name: "claim_work", label: "认领任务", description: "提交认领", parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: "text", text: "accepted" }], details: {}, ...(terminate ? { terminate: true } : {}) }) });
  assert.deepEqual(await agents.executeCollaboration(round("a", "real-claim-session-12345", {
    allowBusinessTools: false, maxTurns: 1, customTools: [tool(true)] })), { reply: "", turns: 1 });
  assert.equal(requests, 1);
  await assert.rejects(agents.executeCollaboration(round("a", "real-limit-session-12345", {
    allowBusinessTools: false, maxTurns: 1, customTools: [tool(false)] })), (error) => error.diagnostic?.reason === "turn_limit");
  assert.equal(requests, 2, "两个群轮次各发一个请求，上限不允许自动发第二次请求");
  assert.equal(agents.scheduler.snapshot().running, 0);
});
