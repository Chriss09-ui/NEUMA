import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiProjectAgent, createProjectTools, createProjectAnalyzer } from "../pi-runtime.mjs";
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
    assert.deepEqual(body.tools.map((item) => item.function.name).sort(), ["add_project", "get_runtime_status", "inspect_project", "list_ports", "list_project_failures", "list_projects", "remove_project", "start_project", "stop_project"]);
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
  const settings = agent.sessions.get("fixture-session-12345").session.settingsManager;
  assert.equal(settings.getRetrySettings().enabled, true);
  assert.equal(settings.getRetrySettings().maxRetries, 5);
  assert.equal(settings.getHttpIdleTimeoutMs(), 0);
  assert.equal(first.engine, "pi"); assert.equal(first.projects.length, 1);
  assert.equal(first.actions[0].tool, "add_project"); assert.match(first.reply, /已添加/);
  const second = await agent.prompt({ message: "看看刚才的项目", sessionId: "fixture-session-12345" });
  assert.equal(second.projects.length, 1); assert.match(second.reply, /仍然/);
  assert.ok(requests[2].messages.some((entry) => entry.role === "tool"));
  assert.equal(first.projects[0].allowLaunch, false);
  assert.ok(progress.some((event) => event.type === "text-delta" && event.delta.includes("已添加")));
  assert.ok(progress.some((event) => event.type === "status" && event.label === "正在添加并配置项目…"));
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

test("新项目添加失败不会报告已登记或生成成功操作，也不会自行再试", async () => {
  let listener, calls = 0;
  const manager = { list: async () => [], add: async () => {
    calls++;
    throw Object.assign(new Error("private-api-payload"), { code: "PROJECT_ADD_FAILED", reason: "api_error" });
  } };
  const agent = new PiProjectAgent({ config: { llmConfigured: true }, manager,
    sessionFactory: async ({ turn }) => {
      const add = createProjectTools(manager, turn).find((tool) => tool.name === "add_project");
      return { messages: [{ role: "assistant", stopReason: "aborted" }], subscribe(fn) { listener = fn; return () => {}; },
        dispose() {}, async abort() {},
        async prompt() {
          const result = JSON.parse((await add.execute("add", { path: "/new/project" })).content[0].text);
          assert.equal(result.added, false); assert.equal(result.id, undefined);
          listener({ type: "tool_execution_end" });
          await assert.rejects(add.execute("repeat", { path: "/new/project" }), /等待用户/);
        },
      };
    },
  });
  const result = await agent.prompt({ message: "添加 /new/project", sessionId: "failed-new-project-session" });
  assert.equal(calls, 1); assert.equal(result.projects.length, 0); assert.equal(result.actions.length, 0);
  assert.match(result.reply, /添加失败.*稍后再试/); assert.doesNotMatch(result.reply, /private-api-payload|已经添加|已登记/);
  assert.equal(agent.sessions.size, 0);
});

test("项目助手删除要求明确确认与有效目标，返回已删除记录和文件保留结果", async () => {
  const removed = [], turn = { message: "删除会议纪要", actions: [] };
  const tool = createProjectTools({ list: async () => [{ id: "one", name: "会议纪要" }],
    remove: async (id) => { removed.push(id); return { removed: true }; } }, turn).find((tool) => tool.name === "remove_project");
  await assert.rejects(tool.execute("call", { id: "one", confirm: false }), /先确认/);
  await assert.rejects(tool.execute("call", { id: "missing", confirm: true }), /没有找到/);
  assert.deepEqual(removed, []);
  const result = JSON.parse((await tool.execute("call", { id: "one", confirm: true })).content[0].text);
  assert.deepEqual(removed, ["one"]);
  assert.deepEqual(result, { removed: true, id: "one", name: "会议纪要", filesKept: true });
  assert.equal(turn.actions[0].tool, "remove_project");
});

test("项目助手可以只读查询失败原因，不重新添加项目", async () => {
  const records = [{ name: "示例项目", message: "添加失败：缺少启动入口。项目未加入列表。" }];
  const turn = { actions: [] };
  const tool = createProjectTools({ failures: async ({ limit }) => { assert.equal(limit, 3); return records; } }, turn)
    .find((item) => item.name === "list_project_failures");
  const result = JSON.parse((await tool.execute("failures", { limit: 3 })).content[0].text);
  assert.deepEqual(result.failures, records); assert.deepEqual(turn.actions, []);
});

test("运行查询按快照筛选外部运行与未运行项目，保留不确定性且不记录为操作", async () => {
  const controller = new AbortController();
  const snapshot = { checkedAt: "2026-10-04T00:00:00.000Z", summary: { total: 3, running: 1, stopped: 1, unknown: 1 },
    warnings: ["部分进程不可见"], projects: [
      { id: "outside", status: "stopped", runtime: { state: "running", source: "external" } },
      { id: "idle", runtime: { state: "stopped", source: "none" } },
      { id: "hidden", runtime: { state: "unknown", source: "none" } },
    ] };
  const turn = { actions: [] };
  const tool = createProjectTools({ runtime: async ({ signal }) => {
    assert.equal(signal, controller.signal); return snapshot;
  } }, turn).find((tool) => tool.name === "get_runtime_status");
  const result = JSON.parse((await tool.execute("query", { state: "running" }, controller.signal)).content[0].text);
  assert.deepEqual(result.projects.map((item) => item.id), ["outside"]);
  assert.equal(result.projects[0].runtime.source, "external");
  assert.deepEqual(result.warnings, snapshot.warnings);
  assert.deepEqual(result.summary, snapshot.summary);
  assert.deepEqual(turn.actions, []);
  await assert.rejects(tool.execute("invalid", { state: "invented" }), /有效的项目状态/);
});

test("端口查询可组合端口和名称条件，空结果保留范围与警告，不执行项目操作", async () => {
  let reads = 0;
  const turn = { actions: [] };
  const tool = createProjectTools({ runtime: async () => {
    reads++;
    return { checkedAt: "2026-10-04T00:00:00.000Z", warnings: ["仅当前用户可见"], ports: [
      { port: 3000, pid: 12, processName: "node", projects: [{ id: "a", name: "网站" }] },
      { port: 5173, pid: 13, processName: "node", projects: [] },
    ] };
  } }, turn).find((tool) => tool.name === "list_ports");
  const matching = JSON.parse((await tool.execute("ports", { port: 3000, query: "网站" })).content[0].text);
  assert.deepEqual(matching.ports.map((item) => item.pid), [12]);
  const empty = JSON.parse((await tool.execute("ports", { port: 3001 })).content[0].text);
  assert.deepEqual(empty.ports, []); assert.match(empty.scope, /TCP 监听/);
  assert.deepEqual(empty.warnings, ["仅当前用户可见"]);
  await assert.rejects(tool.execute("invalid", { port: 65536 }), /端口号/);
  assert.equal(reads, 2); assert.deepEqual(turn.actions, []);
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

test("真实 Pi SDK 检查项目文件、提交方案并自动启用，文件内容回填模型", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-pi-setup-"));
  const app = join(root, "app"); await mkdir(app);
  await writeFile(join(app, "package.json"), JSON.stringify({ scripts: { dev: "vite" }, packageManager: "pnpm@10.0.0" }));
  let count = 0;
  const model = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); count++;
    assert.deepEqual(body.tools.map((item) => item.function.name).sort(), ["list_project_files", "read_project_file", "submit_launch_plan"]);
    if (count === 3) assert.ok(body.messages.some((message) => message.role === "tool" && message.content.includes("pnpm@10.0.0")));
    const call = count === 1 ? ["list_project_files", {}] : count === 2 ? ["read_project_file", { file: "package.json" }]
      : count === 3 ? ["submit_launch_plan", { status: "ready", summary: "已识别 pnpm 开发入口。", command: "pnpm", args: ["run", "dev"] }] : null;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1,
      model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (call) {
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: `setup_${count}`, type: "function", function: { name: call[0], arguments: JSON.stringify(call[1]) } }] });
      chunk({}, "tool_calls");
    } else { chunk({ role: "assistant", content: "已配置。" }); chunk({}, "stop"); }
    response.end("data: [DONE]\n\n");
  });
  await new Promise((done) => model.listen(0, "127.0.0.1", done));
  const config = { llmConfigured: true, chatUrl: `http://127.0.0.1:${model.address().port}/v1/chat/completions`,
    model: "fixture-model", apiKey: "fixture-only", llmTimeoutMs: 5000 };
  const manager = new ProjectManager({ dataDir: join(root, "data"), analyzeProject: createProjectAnalyzer({ config, dataDir: join(root, "data") }) });
  t.after(async () => { await manager.dispose(); await new Promise((done) => model.close(done)); await rm(root, { recursive: true, force: true }); });
  const project = await manager.add({ path: app });
  assert.equal(count, 4); assert.equal(project.canLaunch, true); assert.equal(project.launch.command, "pnpm");
  assert.deepEqual(project.launch.args, ["run", "dev"]); assert.equal(project.setup.status, "ready");
});

test("外层项目对话不再受聊天超时、模型轮数或工具次数上限打断", async () => {
  let listener, calls = 0, aborted = false;
  const manager = { list: async () => { calls++; return []; } };
  const agent = new PiProjectAgent({ config: { llmConfigured: true, llmTimeoutMs: 1 }, manager,
    sessionFactory: async ({ turn }) => {
      const list = createProjectTools(manager, turn).find((tool) => tool.name === "list_projects");
      return { messages: [], getLastAssistantText: () => "检查完成", subscribe(fn) { listener = fn; return () => {}; },
        dispose() {}, async abort() { aborted = true; },
        async prompt() {
          await new Promise((done) => setTimeout(done, 20));
          for (let index = 0; index < 25; index++) {
            listener({ type: "turn_start" });
            await list.execute(`list-${index}`, {});
          }
        },
      };
    },
  });
  const result = await agent.prompt({ message: "仔细查看项目", sessionId: "no-old-limits-session" });
  assert.equal(result.reply, "检查完成"); assert.equal(calls, 26); assert.equal(aborted, false);
  await agent.dispose();
});

test("内部检查连接失败后结束本轮对话，不能自动重复检查绕过重试次数", async () => {
  let listener, aborts = 0;
  const project = { id: "large", name: "大项目", setup: { status: "failed", reason: "api_error", summary: "模型接口已重连 5 次仍未恢复。" } };
  const manager = { add: async () => project, list: async () => [project] };
  const agent = new PiProjectAgent({ config: { llmConfigured: true }, manager,
    sessionFactory: async ({ turn }) => {
      const add = createProjectTools(manager, turn).find((tool) => tool.name === "add_project");
      return { messages: [{ role: "assistant", stopReason: "aborted" }], subscribe(fn) { listener = fn; return () => {}; },
        dispose() {}, async abort() { aborts++; },
        async prompt() {
          await add.execute("add", { path: "/large/project" });
          listener({ type: "tool_execution_end" });
          await assert.rejects(add.execute("repeat", { path: "/large/project" }), /等待用户/);
        },
      };
    },
  });
  const result = await agent.prompt({ message: "添加 /large/project", sessionId: "failed-project-session" });
  assert.match(result.reply, /重连 5 次/); assert.equal(result.projects[0].setup.status, "failed"); assert.equal(aborts, 1);
  assert.equal(agent.sessions.size, 0);
  await agent.dispose();
});
