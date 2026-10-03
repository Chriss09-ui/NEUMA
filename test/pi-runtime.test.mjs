import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiProjectAgent, createProjectTools } from "../pi-runtime.mjs";
import { ProjectManager } from "../projects.mjs";

test("真实 Pi SDK 接通兼容模型流、调用登记工具并连续查询", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-pi-test-"));
  const app = join(root, "app"); await mkdir(app); await writeFile(join(app, "index.html"), "<p>fixture</p>");
  const requests = [];
  const model = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer fixture-only");
    assert.equal(body.messages[0].role, "system");
    assert.deepEqual(body.tools.map((item) => item.function.name).sort(), ["add_project", "list_projects", "start_project", "stop_project"]);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1,
      model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    const count = requests.length;
    if (count === 1 || count === 3) {
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${count}`, type: "function",
        function: { name: count === 1 ? "add_project" : "list_projects", arguments: count === 1 ? JSON.stringify({ path: app, name: "测试网页" }) : "{}" } }] });
      chunk({}, "tool_calls");
    } else { chunk({ role: "assistant", content: count === 2 ? "已添加测试网页。" : "项目仍然在列表中。" }); chunk({}, "stop"); }
    response.end("data: [DONE]\n\n");
  });
  await new Promise((done) => model.listen(0, "127.0.0.1", done));
  const manager = new ProjectManager({ dataDir: join(root, "data") });
  const agent = new PiProjectAgent({ config: { llmConfigured: true, chatUrl: `http://127.0.0.1:${model.address().port}/v1/chat/completions`,
    model: "fixture-model", apiKey: "fixture-only", llmTimeoutMs: 5000 }, manager, cwd: root, dataDir: join(root, "data") });
  t.after(async () => { await agent.dispose(); await manager.dispose(); await new Promise((done) => model.close(done)); await rm(root, { recursive: true, force: true }); });
  const progress = [];
  const first = await agent.prompt({ message: `添加 ${app}`, sessionId: "fixture-session-12345" }, (event) => progress.push(event));
  assert.equal(first.engine, "pi"); assert.equal(first.projects.length, 1);
  assert.equal(first.actions[0].tool, "add_project"); assert.match(first.reply, /已添加/);
  const second = await agent.prompt({ message: "看看刚才的项目", sessionId: "fixture-session-12345" });
  assert.equal(second.projects.length, 1); assert.match(second.reply, /仍然/);
  assert.ok(requests[2].messages.some((entry) => entry.role === "tool"));
  assert.equal(first.projects[0].allowLaunch, false);
  assert.ok(progress.some((event) => event.type === "text-delta" && event.delta.includes("已添加")));
  assert.ok(progress.some((event) => event.type === "status" && event.label === "正在登记项目…"));
});

test("项目进度只发送显示文本与操作状态，不转发思考原文或工具参数", async () => {
  let listener;
  const progress = [];
  const session = {
    subscribe(fn) { listener = fn; return () => {}; },
    async prompt() {
      listener({ type: "message_start", message: { role: "assistant" } });
      listener({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private-thought" } });
      listener({ type: "tool_execution_start", toolName: "list_projects", args: { secret: "private-tool-input" } });
      listener({ type: "tool_execution_end", result: { secret: "private-tool-result" } });
      listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "项目已列出。" } });
    },
    messages: [], getLastAssistantText: () => "项目已列出。", dispose() {}, async abort() {},
  };
  const agent = new PiProjectAgent({ config: { llmConfigured: true }, manager: { list: async () => [] }, sessionFactory: async () => session });
  await agent.prompt({ message: "查看项目", sessionId: "stream-session-12345" }, (event) => progress.push(event));
  assert.equal(JSON.stringify(progress).includes("private-"), false);
  assert.ok(progress.some((event) => event.label === "正在查看项目…"));
  assert.equal(progress.at(-1).delta, "项目已列出。");
  await agent.dispose();
});

test("模型不能借项目文字登记用户本轮没有提供的路径", async () => {
  let added = false;
  const turn = { message: "看看已有项目", toolCalls: 0, actions: [] };
  const tools = createProjectTools({ add: async () => { added = true; } }, turn);
  await assert.rejects(tools.find((item) => item.name === "add_project").execute("call", { path: "/tmp/unrequested" }), /本轮明确提供/);
  assert.equal(added, false);
});

test("Pi 不输出 SDK 原始错误或凭据，未配置时返回明确缺口", async () => {
  const options = { manager: {}, cwd: tmpdir(), dataDir: tmpdir() };
  const unconfigured = new PiProjectAgent({ ...options, config: { llmConfigured: false } });
  await assert.rejects(unconfigured.prompt({ message: "查看项目", sessionId: "fixture-session-12345" }), /先配置/);
  const failing = new PiProjectAgent({ ...options, config: { llmConfigured: true }, sessionFactory: async () => { throw new Error("Bearer fixture-secret"); } });
  await assert.rejects(failing.prompt({ message: "查看项目", sessionId: "fixture-session-12345" }), (error) => {
    assert.equal(error.message.includes("fixture-secret"), false); assert.equal(error.diagnostic.reason, "request_failed"); return true;
  });
});

test("同一对话拒绝并发提交，取消后明确返回已停止并释放会话", async () => {
  let entered, finish;
  const started = new Promise((done) => { entered = done; });
  let disposed = false;
  const agent = new PiProjectAgent({ config: { llmConfigured: true, llmTimeoutMs: 1000 }, manager: {},
    sessionFactory: async () => ({
      subscribe: () => () => {}, messages: [],
      prompt: async () => { entered(); await new Promise((done) => { finish = done; }); },
      abort: async () => { finish?.(); }, dispose: () => { disposed = true; }, getLastAssistantText: () => "已停止",
    }),
  });
  const first = agent.prompt({ message: "查看项目", sessionId: "concurrent-session-12345" });
  const rejected = assert.rejects(first, (error) => error.diagnostic?.reason === "cancelled");
  await started;
  await assert.rejects(agent.prompt({ message: "再查看", sessionId: "concurrent-session-12345" }), /正在处理/);
  await agent.cancel("concurrent-session-12345"); await rejected;
  assert.equal(disposed, true); assert.equal(agent.sessions.size, 0);
});

test("预览地址中的查询凭据不进入模型工具结果", async () => {
  const turn = { message: "查看项目", toolCalls: 0, actions: [] };
  const tools = createProjectTools({ list: async () => [{ id: "fixture", url: "http://127.0.0.1:8888/?token=fixture-private" }] }, turn);
  const result = await tools.find((item) => item.name === "list_projects").execute("call", {});
  assert.equal(result.content[0].text.includes("fixture-private"), false);
  assert.equal(JSON.parse(result.content[0].text)[0].previewReady, true);
});
