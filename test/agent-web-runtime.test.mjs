import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrototypeAgents } from "../src/agents/agent-prototype.mjs";
import { AgentConnectionStore } from "../src/agents/agent-connections.mjs";
import { LEGACY_CAPABILITIES, designHash } from "../src/architecture/architecture-contract.mjs";
import { WebCapabilities } from "../src/runtime/web-capabilities.mjs";
import { createPiSession } from "../src/runtime/pi-runtime.mjs";
import { validDraft, validDesign, passingReview } from "./helpers/architecture.mjs";

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const turn = (agentId = "alpha", message = "处理资料") => ({ agentId, sessionId: `runtime-${agentId}-conversation`, message });
const textResult = { status: "ok", results: [{ url: "https://example.com", title: "Example", content: "真实摘录" }] };

async function fixture(t, { work = async () => {}, web, draft = validDraft(), design = validDesign } = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-agent-web-")), records = [], roles = [];
  const sessionFactory = async (options) => {
    const tools = Object.fromEntries(options.customTools.map((tool) => [tool.name, tool]));
    const role = tools.submit_architecture ? "designer" : tools.submit_architecture_review ? "reviewer" : "worker";
    const record = { options, tools, role, disposed: false, prompts: [] };
    const session = { messages: [], subscribe: () => () => {},
      async prompt(message) {
        record.prompts.push(message);
        if (role === "designer") return tools.submit_architecture.execute("design", design(JSON.parse(message).requirements));
        if (role === "reviewer") return tools.submit_architecture_review.execute("review", passingReview(JSON.parse(message).candidateHash));
        await options.beforeModelRequest?.({});
        await work(record, message, session);
      },
      getLastAssistantText: () => "处理完成", abort: async () => {}, dispose() { record.disposed = true; } };
    record.session = session; (role === "worker" ? records : roles).push(record); return session;
  };
  const options = { config: { llmConfigured: true, chatUrl: "https://platform.example/v1/chat/completions", model: "platform-model", apiKey: "fixture-platform" },
    cwd: root, dataDir: join(root, "data"), sessionFactory, ...(web ? { web } : {}) };
  const agents = new PrototypeAgents(options);
  t.after(async () => { await agents.close(); await rm(root, { recursive: true, force: true }); });
  await agents.build({ id: "alpha", name: "资料助手", draft });
  return { agents, records, roles, root, options };
}

test("链接与PDF助手从公共能力架构交付、重新加载到私聊和群工作，工具装配与逐次结果分开", async (t) => {
  const url = "https://example.com/paper", calls = [], body = "# Introduction\n模拟论文正文\n# Results\n模拟结果";
  const web = new WebCapabilities({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    requestPublic: async (target, options) => {
      assert.equal(target, url); assert.equal(options.method, "HEAD"); calls.push({ kind: "head", target });
      return new Response(null, { status: 200 });
    },
    fetchImpl: async (target, options) => {
      assert.equal(target, "https://api.tavily.com/extract");
      assert.deepEqual(JSON.parse(options.body).urls, [url]); calls.push({ kind: "extract", target });
      return new Response(JSON.stringify({ results: [{ url, title: "Fixture paper", raw_content: body }] }),
        { headers: { "content-type": "application/json" } });
    },
  });
  const draft = validDraft("按主要章节概括用户提供的论文链接或PDF");
  draft.inputSource = { value: "公开论文链接或上传PDF", source: "user" };
  const design = (requirements) => validDesign(requirements, {
    schemaVersion: 2, connections: [], interaction: { defaultEntry: "conversation", page: false, operations: false,
      inputs: "论文链接或PDF", results: "章节概括与真实读取范围", persistentData: "无" },
    instructions: "链接输入先用 web_fetch 读取正文；PDF用 read_material/read_material_image。按实际读取顺序概括主要章节，保留来源与读取范围；读取失败请改传PDF，不虚构章节或完整性。",
    capabilities: ["conversation", "web_fetch", "read_material", "read_material_image"].map((id) => ({ id, status: "available",
      reason: "平台已装配的工具；具体论文的读取和图像效果仍需本次调用验证" })),
    unknowns: [{ question: "具体论文站点是否可读并包含完整主要章节？", blocking: false,
      resolution: "业务执行时核对 web_fetch 实际返回正文、截断状态和章节读取范围" }],
  });
  let workCalls = 0;
  const { agents, records, roles, options } = await fixture(t, { draft, design, web, work: async (record) => {
    workCalls++;
    for (const name of ["web_search", "web_fetch"])
      assert.equal(record.options.customTools.filter((tool) => tool.name === name).length, 1);
    if (workCalls === 1) assert.ok(record.tools.read_material && record.tools.read_material_image);
    const result = JSON.parse((await record.tools.web_fetch.execute("paper-read", { url })).content[0].text);
    assert.equal(result.status, "ok"); assert.equal(result.results[0].content, body);
    assert.equal(result.results[0].url, url); assert.equal(result.results[0].truncated, false);
  } });
  const architecture = await agents.getArchitecture("alpha"), before = await agents.get("alpha");
  assert.equal(architecture.status, "passed"); assert.equal(architecture.delivery, "ready");
  assert.equal(architecture.design.profile, "light"); assert.equal(architecture.design.interaction.page, false);
  const fetchFact = architecture.platformSnapshot.publicCapabilities.find((item) => item.id === "web_fetch");
  assert.equal(fetchFact.status, "available"); assert.equal(fetchFact.configuration, "not_required");
  assert.equal(fetchFact.verification, "per_call"); assert.deepEqual(calls, [], "架构通过不要求提前读取未来业务网址");
  assert.equal(architecture.issues.some((issue) => issue.blocking), false);
  assert.equal(architecture.design.unknowns[0].blocking, false);
  assert.equal(roles.length, 2); assert.ok(!roles.find((record) => record.role === "reviewer").tools.web_fetch);
  await agents.close();
  const restored = new PrototypeAgents(options); t.after(() => restored.close());
  assert.deepEqual(await restored.get("alpha"), before);
  assert.equal((await restored.getArchitecture("alpha")).candidateHash, designHash(architecture.design));
  assert.equal((await restored.capabilityCards()).agents.find((agent) => agent.id === "alpha").ready, true);
  assert.equal((await restored.prompt(turn())).status, "complete");
  await restored.executeCollaboration({ agentId: "alpha", revision: before.revision, sessionId: "runtime-group-alpha-conversation",
    message: "概括提供的论文链接", scope: { groupId: "study", taskId: "paper" } });
  assert.equal(records.length, 2); assert.equal(workCalls, 2);
  assert.deepEqual(calls.map((call) => call.kind), ["head", "extract", "head", "extract"], "私聊与群范围分别取得实际正文，不共享缓存结果");
  const after = await restored.getArchitecture("alpha");
  assert.equal(after.candidateHash, architecture.candidateHash); assert.equal(after.platformHash, architecture.platformHash);
  assert.deepEqual(after.design.unknowns, architecture.design.unknowns, "调用成功不自动声称完整论文业务验收通过或改写历史评估");
});

test("旧目录正式定义自动具备公共联网，候选摘要、指令和业务工具绑定不变", async (t) => {
  const requests = [];
  const { agents, records } = await fixture(t, { web: { async search(input, options) { requests.push({ input, options }); return textResult; } },
    work: async (record) => {
      assert.ok(record.tools.web_search); assert.ok(record.tools.web_fetch);
      assert.equal(JSON.parse((await record.tools.web_search.execute("search", { query: "official source" })).content[0].text).status, "ok");
    } });
  const architecture = await agents.getArchitecture("alpha"), before = await agents.get("alpha");
  delete architecture.capabilityCatalogVersion; architecture.capabilitySnapshot = structuredClone(LEGACY_CAPABILITIES);
  await agents.architecture.save(architecture);
  const candidateHash = architecture.candidateHash;
  await agents.prompt(turn());
  const after = await agents.get("alpha");
  assert.equal(after.instructions, before.instructions); assert.deepEqual(after.toolIds, before.toolIds);
  assert.deepEqual(after.architectureRef, before.architectureRef);
  assert.equal((await agents.getArchitecture("alpha")).candidateHash, candidateHash);
  assert.equal(requests.length, 1); assert.equal(requests[0].options.agentId, "alpha");
  assert.equal(requests[0].options.scope, "private:runtime-alpha-conversation");
  assert.equal(records.length, 1);
});

test("宿主拦截本轮及长期不联网要求，同会话刷新使用当前取消信号", async (t) => {
  const requests = [];
  const { agents, records } = await fixture(t, { web: { async search(input, options) {
    assert.equal(options.signal.aborted, false); requests.push({ input, signal: options.signal }); return textResult;
  } }, work: async (record, message) => {
    if (message.includes("不要联网")) return assert.rejects(record.tools.web_search.execute("search", { query: "example" }), /不联网/);
    await record.tools.web_search.execute("search", { query: "example" });
  } });
  const firstSignal = new AbortController();
  await agents.prompt(turn(), () => {}, { signal: firstSignal.signal });
  firstSignal.abort();
  await agents.prompt(turn("alpha", "刷新最新资料"));
  assert.equal(records.length, 1); assert.equal(requests.length, 2);
  assert.notEqual(requests[0].signal, requests[1].signal); assert.equal(requests[1].input.refresh, true);
  await agents.prompt(turn("alpha", "不要联网，仅整理资料")); assert.equal(requests.length, 2);
  const offlineDraft = validDraft(); offlineDraft.constraints = [{ value: "禁止联网", source: "user" }];
  await agents.build({ id: "offline", name: "离线助手", draft: offlineDraft });
  await assert.rejects(agents.prompt(turn("offline")), /不联网/); assert.equal(requests.length, 2);
});

test("专属模型仅影响所属 Agent，新任务绑定新配置并重建该会话", async (t) => {
  const { agents, records, roles } = await fixture(t);
  await agents.build({ id: "beta", name: "另一助手", draft: validDraft() });
  await agents.connections.save("alpha", { id: "model", kind: "model", model: "custom-one", baseUrl: "http://localhost:40100/v1", secret: "fixture-one" });
  await agents.prompt(turn()); await agents.prompt(turn("beta"));
  assert.equal(records[0].options.config.model, "custom-one"); assert.equal(records[0].options.config.apiKey, "fixture-one");
  assert.equal(records[1].options.config.model, "platform-model");
  assert.ok(roles.every((record) => record.options.config.model === "platform-model"));
  assert.equal(typeof records[0].options.beforeModelRequest, "function");
  await agents.connections.save("alpha", { id: "model", model: "custom-two", secret: "fixture-two" });
  await agents.prompt(turn()); await agents.prompt(turn("beta"));
  assert.equal(records.length, 3); assert.equal(records[0].disposed, true); assert.equal(records[1].disposed, false);
  assert.equal(records[2].options.config.model, "custom-two");
  assert.doesNotMatch(records.map((record) => record.options.systemPrompt + record.prompts.join("\n")).join("\n"), /fixture-one|fixture-two/);
  assert.doesNotMatch(JSON.stringify(await agents.get("alpha")), /fixture-one|fixture-two/);
});

test("已开始任务保持旧模型配置，撤销后宿主请求钩子拒绝下一次调用", async (t) => {
  const started = deferred(), proceed = deferred(); let stages = 0;
  const { agents, records } = await fixture(t, { work: async (record) => {
    if (++stages === 1) {
      started.resolve(); await proceed.promise;
      assert.equal(record.options.config.model, "old-model");
      await record.options.beforeModelRequest({});
    }
  } });
  await agents.connections.save("alpha", { id: "model", kind: "model", model: "old-model", baseUrl: "http://localhost:40100/v1", secret: "fixture-old" });
  const pending = agents.prompt(turn()); await started.promise;
  await agents.connections.save("alpha", { id: "model", model: "new-model", secret: "fixture-new" });
  await records[0].options.beforeModelRequest({});
  await agents.connections.remove("alpha", "model");
  const rejected = assert.rejects(pending, { reason: "connection_revoked" }); proceed.resolve(); await rejected;
  assert.equal(records[0].disposed, true);
  await agents.prompt(turn()); assert.equal(records[1].options.config.model, "platform-model");
});

test("专属模型原始错误不会暴露凭据，专属失败不自动调用平台模型", async (t) => {
  const secret = "fixture-sensitive-credential";
  const { agents, records } = await fixture(t, { work: async () => { throw new Error(`HTTP 401 Bearer ${secret}`); } });
  await agents.connections.save("alpha", { id: "model", kind: "model", model: "custom", baseUrl: "http://localhost:40100/v1", secret });
  const progress = [];
  await assert.rejects(agents.prompt(turn(), (event) => progress.push(event)), (error) => {
    assert.doesNotMatch(error.message + JSON.stringify(error.diagnostic), /fixture-sensitive-credential/); return true;
  });
  assert.equal(records.length, 1); assert.equal(records[0].options.config.model, "custom");
  assert.doesNotMatch(JSON.stringify(progress), /fixture-sensitive-credential/);
  const view = await agents.connections.list("alpha"); assert.doesNotMatch(JSON.stringify(view), /fixture-sensitive-credential/);
});

test("真实 Pi SDK 的工具续轮在模型连接撤销后不会再发 HTTP", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-model-revocation-"));
  const store = new AgentConnectionStore({ dataDir: join(root, "data") }); let requests = 0, checks = 0;
  const model = createServer(async (request, response) => {
    for await (const _ of request) {} requests++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const delta = { role: "assistant", tool_calls: [{ index: 0, id: "revoke-call", type: "function", function: { name: "revoke_for_test", arguments: "{}" } }] };
    response.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model",
      choices: [{ index: 0, delta, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((done) => model.listen(0, "127.0.0.1", done));
  t.after(async () => { model.closeAllConnections(); await new Promise((done) => model.close(done)); await rm(root, { recursive: true, force: true }); });
  await store.save("alpha", { id: "model", kind: "model", model: "fixture-model", baseUrl: `http://127.0.0.1:${model.address().port}/v1`, secret: "fixture-sdk-key" });
  const snapshot = await store.snapshot("alpha"), config = await store.modelConfig(snapshot, {});
  const session = await createPiSession({ config, cwd: root, dataDir: join(root, "pi"), maxOutputTokens: 512, systemPrompt: "test",
    beforeModelRequest: async () => { checks++; await store.resolveKind(snapshot, "model"); },
    customTools: [{ name: "revoke_for_test", label: "test", description: "test", parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
      execute: async () => { await store.remove("alpha", "model"); return { content: [{ type: "text", text: "revoked" }], details: {} }; } }] });
  try {
    session.settingsManager.setRetryEnabled(false);
    await session.prompt("call revoke_for_test");
    assert.equal(requests, 1); assert.equal(checks, 2);
    assert.equal(session.messages.findLast((message) => message.role === "assistant")?.stopReason, "error");
  } finally { session.dispose(); }
});

test("匿名专属模型通过真实 Pi 请求且没有认证头，平台与Bearer不继承匿名标记", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-model-anonymous-")), requests = [];
  const store = new AgentConnectionStore({ dataDir: join(root, "data") });
  const model = createServer(async (request, response) => {
    for await (const _ of request) {} requests.push(request.headers);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model",
      choices: [{ index: 0, delta: { role: "assistant", content: "匿名请求成功" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((done) => model.listen(0, "127.0.0.1", done));
  t.after(async () => { model.closeAllConnections(); await new Promise((done) => model.close(done)); await rm(root, { recursive: true, force: true }); });
  await store.save("alpha", { id: "model", kind: "model", model: "fixture-model", baseUrl: `http://127.0.0.1:${model.address().port}/v1`, authType: "none" });
  const config = await store.modelConfig(await store.snapshot("alpha"), { modelAuthType: "bearer" });
  const session = await createPiSession({ config, cwd: root, dataDir: join(root, "pi"), maxOutputTokens: 512, systemPrompt: "test", customTools: [] });
  try {
    session.settingsManager.setRetryEnabled(false); await session.prompt("测试匿名模型");
    assert.equal(session.getLastAssistantText(), "匿名请求成功"); assert.equal(requests.length, 1);
    assert.equal(requests[0].authorization, undefined);
  } finally { session.dispose(); }
  await store.save("alpha", { id: "model", authType: "bearer", secret: "fixture-bearer" });
  assert.equal((await store.modelConfig(await store.snapshot("alpha"), { modelAuthType: "none" })).modelAuthType, "bearer");
  assert.equal((await store.modelConfig(await store.snapshot("beta"), { modelAuthType: "none", apiKey: "platform" })).modelAuthType, undefined);
});

test("应用业务能力不能绕过本轮不联网要求，拒绝前不发送HTTP", async (t) => {
  const { agents } = await fixture(t); let requests = 0;
  const requirements = [{ id: "orders", purpose: "business", required: true, operations: [{ id: "read", method: "GET", path: "/orders", safeTest: true }] }];
  agents.connections.fetchImpl = async () => { requests++; return new Response(JSON.stringify({ orders: [] }), { headers: { "content-type": "application/json" } }); };
  await agents.connections.save("alpha", { id: "orders", kind: "business", baseUrl: "http://localhost:41000", authType: "none" }, requirements);
  const options = { task: { id: "offline-task", agentId: "alpha", source: { scope: "private" }, allowNetwork: false, input: {} },
    descriptor: { agent: await agents.get("alpha"), architecture: { design: { connections: requirements } }, manifest: { stateVersion: 1 } },
    action: { connectionIds: ["orders"] }, connectionSnapshot: await agents.connections.snapshot("alpha"),
    signal: new AbortController().signal, check: async () => {} };
  const offline = await agents.applicationCapabilities(options);
  const call = { capability: "connection.call", args: { connectionId: "orders", operationId: "read", input: {} } };
  await assert.rejects(offline(call), /不联网/); assert.equal(requests, 0);
  const online = await agents.applicationCapabilities({ ...options, task: { ...options.task, allowNetwork: true } });
  assert.equal((await online(call)).status, "ok"); assert.equal(requests, 1);
});

test("专属模型验证状态保存期间取消不能发布迟到完成", async (t) => {
  const { agents } = await fixture(t), started = deferred(), release = deferred();
  await agents.connections.save("alpha", { id: "model", kind: "model", model: "custom", baseUrl: "http://localhost:41000/v1", secret: "fixture-model" });
  const recordWorkingModel = agents.recordWorkingModel.bind(agents);
  agents.recordWorkingModel = async (snapshot) => { started.resolve(); await release.promise; return recordWorkingModel(snapshot); };
  const request = turn(), pending = agents.prompt(request);
  const rejected = assert.rejects(pending, (error) => error.diagnostic?.reason === "cancelled");
  await started.promise; await agents.cancel(request.sessionId); release.resolve();
  await rejected;
});
