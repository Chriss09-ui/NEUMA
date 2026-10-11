import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiProjectAgent, createProjectTools, createProjectAnalyzer, createPiSession, classifyModelFailure } from "../src/runtime/pi-runtime.mjs";
import { ProjectManager } from "../src/projects/projects.mjs";
import { modelOutputBudget, knownModelLimits } from "../src/runtime/model-limits.mjs";

const mimoConfig = Object.freeze({ chatUrl: "https://api.xiaomimimo.com/v1/chat/completions",
  model: "mimo-v2.6-pro", apiKey: "fixture-only" });

test("模型错误分类区分连接、流协议、上下文和输出上限且不回传原始响应", () => {
  for (const [raw, reason] of [
    ["401 Invalid API key Bearer private-key-fixture", "api_authentication"],
    ["429 too many requests private-key-fixture", "api_rate_limit"],
    ["404 model_not_found private-key-fixture", "api_not_found"],
    ["503 Service unavailable private-key-fixture", "api_unavailable"],
    ["fetch failed private-key-fixture", "api_connection"],
    ["Provider finish_reason: network_error private-key-fixture", "api_connection"],
    ["Context overflow recovery failed private-key-fixture", "api_context"],
    ["Truncated response recovery failed private-key-fixture", "api_output_limit"],
    ["Stream ended without finish_reason private-key-fixture", "api_stream_interrupted"],
    ["terminated private-key-fixture", "api_stream_interrupted"],
    ["invalid stream json private-key-fixture", "api_protocol"],
    ["Provider finish_reason: content_filter private-key-fixture", "api_rejected"],
  ]) {
    const mapped = classifyModelFailure(raw);
    assert.equal(mapped.reason, reason);
    assert.doesNotMatch(JSON.stringify(mapped), /private-key|Bearer/);
  }
});

test("运行时拒绝无效输出预算，避免把预算错误发送到模型接口", async () => {
  for (const maxOutputTokens of [0, 255, 16_385, 4096.5, "8192"]) {
    await assert.rejects(createPiSession({ customTools: [], maxOutputTokens }), /输出预算应为/);
  }
  for (const maxOutputTokens of [131_073, 131_072.5, "131072"])
    await assert.rejects(createPiSession({ config: mimoConfig, customTools: [], maxOutputTokens }), /输出预算应为 256 到 131072/);
});

test("共享输出预算只对已核实的接口与型号调满，其余保留调用方预算", () => {
  assert.equal(modelOutputBudget(mimoConfig), 131_072);
  assert.equal(modelOutputBudget(mimoConfig, 8192), 131_072);
  assert.equal(knownModelLimits(mimoConfig).contextWindow, 1_048_576);
  for (const config of [{ ...mimoConfig, model: "mimo-v2.6" },
    { ...mimoConfig, chatUrl: "https://api.xiaomimimo.com.other.test/v1/chat/completions" },
    { ...mimoConfig, chatUrl: "https://proxy.example.test/v1/chat/completions" },
    { ...mimoConfig, chatUrl: "invalid" }, {}, undefined]) {
    assert.equal(modelOutputBudget(config), 4096);
    assert.equal(modelOutputBudget(config, 8192), 8192);
    assert.equal(knownModelLimits(config), null);
  }
});

test("MiMo 默认输出调满实际发送 131072，显式短探针仍发送 512", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-pi-max-output-"));
  const requests = [];
  const model = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1,
      model: "mimo-v2.6-pro", choices: [{ index: 0, delta: { role: "assistant", content: "完成" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((done) => model.listen(0, "127.0.0.1", done));
  t.after(async () => { await new Promise((done) => model.close(done)); await rm(root, { recursive: true, force: true }); });
  for (const maxOutputTokens of [undefined, 512]) {
    const session = await createPiSession({ config: mimoConfig, cwd: root, dataDir: join(root, "data"),
      customTools: [], systemPrompt: "fixture", ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) });
    try {
      const expected = maxOutputTokens ?? 131_072;
      assert.equal(session.model.maxTokens, expected);
      assert.equal(session.settingsManager.getCompactionSettings(session.model).reserveTokens,
        maxOutputTokens === undefined ? 135_168 : 16_384);
      // Exercise the real SDK request with the registered MiMo profile against this local fixture.
      await session.setModel({ ...session.model, baseUrl: `http://127.0.0.1:${model.address().port}/v1` });
      await session.prompt("生成方案");
      const body = requests.at(-1);
      assert.equal(body.model, "mimo-v2.6-pro");
      assert.equal(body.max_completion_tokens, expected);
      assert.equal(body.max_tokens, undefined);
      assert.deepEqual(body.thinking, { type: "disabled" });
      assert.equal(session.getLastAssistantText(), "完成");
    } finally { session.dispose(); }
  }
  assert.equal(requests.length, 2);
});

test("真实 SDK 将直接图片和工具页图传给当前模型，不被 text-only 登记省略", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-pi-images-")), requests = [];
  const image = { type: "image", mimeType: "image/png", data: (await readFile(new URL("../public/assets/brand/neuma-mark.png", import.meta.url))).toString("base64") };
  const model = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const toolCall = body.tools?.length && !body.messages.some((message) => message.role === "tool");
    const delta = toolCall ? { role: "assistant", tool_calls: [{ index: 0, id: "page-image", type: "function",
      function: { name: "read_material_image", arguments: JSON.stringify({ page: 3 }) } }] } : { role: "assistant", content: "图像已收到" };
    response.end(`data: ${JSON.stringify({ id: "image-fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model",
      choices: [{ index: 0, delta, finish_reason: toolCall ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((done) => model.listen(0, "127.0.0.1", done));
  t.after(async () => { await new Promise((done) => model.close(done)); await rm(root, { recursive: true, force: true }); });
  const config = { chatUrl: `http://127.0.0.1:${model.address().port}/v1/chat/completions`, model: "fixture-model", apiKey: "fixture-only" };
  const direct = await createPiSession({ config, cwd: root, dataDir: join(root, "direct"), customTools: [], systemPrompt: "fixture" });
  try {
    assert.deepEqual(direct.model.input, ["text", "image"]);
    await direct.prompt("查看当前图片", { images: [image] });
    assert.equal(direct.getLastAssistantText(), "图像已收到");
    const content = requests[0].messages.findLast((message) => message.role === "user").content;
    assert.ok(content.some((value) => value.type === "image_url" && value.image_url.url.startsWith("data:image/png;base64,")));
  } finally { direct.dispose(); }
  const page = await createPiSession({ config, cwd: root, dataDir: join(root, "page"), systemPrompt: "fixture", customTools: [{
    name: "read_material_image", label: "读取页图", description: "读取本地材料页图", parameters: { type: "object", properties: { page: { type: "integer" } }, required: ["page"] },
    execute: async (_id, params) => { assert.equal(params.page, 3); return { content: [{ type: "text", text: "附件 file-1，第 3 页" }, image], details: {} }; },
  }] });
  try {
    await page.prompt("读取第3页图表");
    assert.equal(page.getLastAssistantText(), "图像已收到");
    const body = requests.at(-1);
    assert.ok(body.messages.some((message) => message.role === "tool" && String(message.content).includes("第 3 页")));
    assert.ok(body.messages.some((message) => message.role === "user" && Array.isArray(message.content)
      && message.content.some((value) => value.type === "image_url" && value.image_url.url.startsWith("data:image/png;base64,"))));
    assert.doesNotMatch(JSON.stringify(body.messages), /image omitted/);
  } finally { page.dispose(); }
});

test("运行层只对已核实的 MiMo 型号使用真实上下文和接口参数，未知型号保留保守容量", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-pi-limits-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [chatUrl, model, known] of [
    ["https://api.xiaomimimo.com/v1/chat/completions", "mimo-v2.6-pro", true],
    ["https://api.xiaomimimo.com/v1/chat/completions", "unknown-fixture", false],
    ["http://127.0.0.1:1/v1/chat/completions", "mimo-v2.6-pro", false],
  ]) {
    const session = await createPiSession({ config: { chatUrl, model, apiKey: "fixture-only" },
      cwd: root, dataDir: join(root, "data"), customTools: [], systemPrompt: "fixture", maxOutputTokens: 8192 });
    try {
      assert.equal(session.model.contextWindow, known ? 1_048_576 : 32_768);
      assert.equal(session.model.maxTokens, 8192);
      assert.equal(session.model.compat.maxTokensField, known ? "max_completion_tokens" : "max_tokens");
      assert.equal(session.model.compat.requiresReasoningContentOnAssistantMessages, known ? true : undefined);
      assert.equal(session.model.compat.thinkingFormat, known ? "deepseek" : undefined);
      const compaction = session.settingsManager.getCompactionSettings(session.model);
      assert.equal(compaction.reserveTokens, known ? 16_384 : 12_288);
      assert.equal(compaction.keepRecentTokens, known ? 20_000 : 10_240);
      assert.ok(compaction.keepRecentTokens + session.model.maxTokens < session.model.contextWindow - compaction.reserveTokens);
      assert.equal(session.settingsManager.getHttpIdleTimeoutMs(), 0);
    } finally { session.dispose(); }
  }
});

test("32k 未知模型的 18k 输入不会被旧压缩阈值提前摘要或挤占 8192 输出预算", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-pi-input-budget-"));
  const message = "x".repeat(72_000);
  const requests = [];
  const model = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1,
      model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant", content: "完成" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 18_000, completion_tokens: 1, total_tokens: 18_001 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((done) => model.listen(0, "127.0.0.1", done));
  const session = await createPiSession({ config: { chatUrl: `http://127.0.0.1:${model.address().port}/v1/chat/completions`, model: "fixture-model", apiKey: "fixture-only" },
    cwd: root, dataDir: join(root, "data"), customTools: [], systemPrompt: "fixture", maxOutputTokens: 8192 });
  t.after(async () => { session.dispose(); await new Promise((done) => model.close(done)); await rm(root, { recursive: true, force: true }); });
  await session.prompt(message);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].max_tokens, 8192);
  assert.ok(requests[0].messages.some((entry) => entry.role === "user"
    && (typeof entry.content === "string" ? entry.content : entry.content.map((block) => block.text || "").join("")) === message));
  assert.equal(session.getLastAssistantText(), "完成");
});

test("真实 SDK 遇到半截响应会重试当前模型轮，完整提交只执行一次并直接结束", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-pi-stream-retry-"));
  const requests = [];
  let submissions = 0;
  const model = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1,
      model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: "assistant", tool_calls: [{ index: 0, id: `submit-${requests.length}`, type: "function",
      function: { name: "submit_result", arguments: JSON.stringify({ result: requests.length === 1 ? "partial-fixture" : "complete" }) } }] });
    if (requests.length > 1) chunk({}, "tool_calls");
    response.end("data: [DONE]\n\n");
  });
  await new Promise((done) => model.listen(0, "127.0.0.1", done));
  const session = await createPiSession({ config: { chatUrl: `http://127.0.0.1:${model.address().port}/v1/chat/completions`, model: "fixture-model", apiKey: "fixture-only" },
    cwd: root, dataDir: join(root, "data"), systemPrompt: "fixture", customTools: [{ name: "submit_result", label: "提交", description: "提交",
      parameters: { type: "object", properties: { result: { type: "string" } }, required: ["result"] },
      async execute(_id, args) { submissions++; assert.equal(args.result, "complete"); return { content: [{ type: "text", text: "saved" }], details: {}, terminate: true }; } }] });
  t.after(async () => { session.dispose(); await new Promise((done) => model.close(done)); await rm(root, { recursive: true, force: true }); });
  const events = []; session.subscribe((event) => events.push(event));
  await session.prompt("生成方案");
  assert.equal(requests.length, 2); assert.equal(submissions, 1);
  assert.equal(JSON.stringify(requests[1].messages).includes("partial-fixture"), false);
  assert.equal(events.filter((event) => event.type === "auto_retry_start").length, 1);
  assert.ok(events.some((event) => event.type === "auto_retry_end" && event.success));
  assert.equal(session.messages.at(-1).role, "toolResult");
});

test("真实 SDK 对 429 暂时限流重试，对认证错误直接结束，均不叠加底层重试", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-pi-http-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const status of [429, 401]) {
    let requests = 0;
    const model = createServer(async (request, response) => {
      for await (const _chunk of request) {} requests++;
      if (requests === 1) {
        response.writeHead(status, { "content-type": "application/json" });
        return response.end(JSON.stringify({ error: { message: status === 429 ? "rate limit exceeded" : "authentication failed", type: "fixture-error" } }));
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model",
        choices: [{ index: 0, delta: { role: "assistant", content: "完成" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise((done) => model.listen(0, "127.0.0.1", done));
    const session = await createPiSession({ config: { chatUrl: `http://127.0.0.1:${model.address().port}/v1/chat/completions`, model: "fixture-model", apiKey: "fixture-only" },
      cwd: root, dataDir: join(root, "data"), customTools: [], systemPrompt: "fixture" });
    try {
      const events = []; session.subscribe((event) => events.push(event));
      await session.prompt("生成方案");
      assert.equal(requests, status === 429 ? 2 : 1);
      assert.equal(events.filter((event) => event.type === "auto_retry_start").length, status === 429 ? 1 : 0);
      assert.equal(session.messages.at(-1).stopReason, status === 429 ? "stop" : "error");
    } finally { session.dispose(); await new Promise((done) => model.close(done)); }
  }
});

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
    assert.equal(body.max_tokens, 4096);
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
  assert.equal(count, 3); assert.equal(project.canLaunch, true); assert.equal(project.launch.command, "pnpm");
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

test("更新设置关闭旧会话后，迟到的会话不调用模型并且不删除同标识的新会话", async () => {
  let entered, release, factories = 0, oldPrompts = 0, oldDisposals = 0, newDisposals = 0;
  const ready = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const currentSession = { subscribe: () => () => {}, messages: [], async prompt() {},
    getLastAssistantText: () => "新配置已生效", async abort() {}, dispose() { newDisposals++; } };
  const agent = new PiProjectAgent({ config: { llmConfigured: true }, manager: { list: async () => [] },
    sessionFactory: async () => {
      factories++;
      if (factories > 1) return currentSession;
      entered(); await gate;
      return { subscribe: () => () => {}, messages: [], async prompt() { oldPrompts++; },
        getLastAssistantText: () => "旧会话", async abort() {}, dispose() { oldDisposals++; } };
    } });
  const sessionId = "settings-late-session-12345";
  const pending = agent.prompt({ message: "查看项目", sessionId });
  const stopped = assert.rejects(pending, (error) => error.diagnostic?.reason === "cancelled");
  await ready;
  await agent.dispose();
  const fresh = await agent.prompt({ message: "再查看项目", sessionId });
  assert.equal(fresh.reply, "新配置已生效");
  release(); await stopped;
  assert.equal(oldPrompts, 0); assert.equal(oldDisposals, 1);
  assert.equal(agent.sessions.get(sessionId).session, currentSession);
  assert.equal(newDisposals, 0);
  await agent.dispose();
  assert.equal(newDisposals, 1);
});

for (const operation of ["dispose", "cancel"]) for (const failedOperation of [false, true]) {
  test(`获取项目列表期间 ${operation}，${failedOperation ? "操作失败" : "正常回复"}分支不返回迟到成功`, async () => {
    let entered, release, disposals = 0;
    const ready = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const agent = new PiProjectAgent({ config: { llmConfigured: true },
      manager: { list: async () => { entered(); await gate; return []; } },
      sessionFactory: async ({ turn }) => ({ subscribe: () => () => {}, messages: [],
        async prompt() { if (failedOperation) turn.failedOperation = { setup: { summary: "操作未完成" } }; },
        getLastAssistantText: () => "项目已列出", async abort() {}, dispose() { disposals++; } }),
    });
    const sessionId = "late-project-list-session-12345";
    const pending = agent.prompt({ message: "查看项目", sessionId });
    const stopped = assert.rejects(pending, (error) => error.diagnostic?.reason === "cancelled");
    await ready;
    if (operation === "dispose") await agent.dispose();
    else assert.equal((await agent.cancel(sessionId)).cancelled, true);
    release(); await stopped;
    assert.equal(disposals, 1); assert.equal(agent.sessions.size, 0);
    await agent.dispose();
  });
}
