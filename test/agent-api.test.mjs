import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequestHandler } from "../src/server.mjs";
import { InputError, ProviderError } from "../src/requirements/core.mjs";
import { AgentLibrary } from "../src/agents/agent-library.mjs";

function request(method, url, body) {
  const input = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(input, { method, url, headers: body === undefined ? {} : { "content-type": "application/json" } });
  return input;
}

class StreamingResponse extends EventEmitter {
  text = "";
  writableEnded = false;
  destroyed = false;
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  write(content) { this.text += content; }
  end(content = "") { this.text += content; this.writableEnded = true; }
  events() { return this.text.trim().split("\n").filter(Boolean).map(JSON.parse); }
}

function makeHandler(prototypeAgents, options = {}) {
  return createRequestHandler({ config: {}, providers: {},
    projects: { dispose: async () => {} }, projectAgent: { dispose: async () => {} },
    prototypeAgents: { close: async () => {}, ...prototypeAgents }, ...options });
}

async function invoke(handler, method, url, body) {
  const response = new StreamingResponse();
  await handler(request(method, url, body), response);
  return response;
}

function stream(handler, path, body) {
  const input = request("POST", path, body);
  input.headers.accept = "application/x-ndjson";
  const response = new StreamingResponse();
  return { response, pending: handler(input, response) };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const agent = { id: "agent-1", name: "周报助手", version: 1, status: "ready" };
const buildInput = { id: agent.id, name: agent.name, draft: { goal: { value: "整理周报", source: "user" } } };
const turnInput = { agentId: agent.id, sessionId: "agent-session-1", message: "整理这些记录" };

test("Agent 需求及显式保存对话接口按身份持久化，支持超过旧请求上限的中文对话", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "neuma-agent-library-api-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const library = new AgentLibrary({ dataDir });
  const handler = makeHandler({ getRequirements: () => library.list(),
    saveRequirements: (id, body) => library.saveRequirement(id, body),
    getConversation: (id) => library.getConversation(id), saveConversation: (id, body) => library.saveConversation(id, body),
    remove: (id) => library.remove(id) });
  const requirement = { name: "周报助手", draft: buildInput.draft };
  const saved = await invoke(handler, "POST", `/api/agents/${agent.id}/requirements`, requirement);
  assert.equal(saved.status, 200);
  assert.equal(JSON.parse(saved.text).requirement.id, agent.id);
  const snapshot = { schemaVersion: 2, messages: Array.from({ length: 2 }, () => ({ role: "assistant", content: "文".repeat(32000), status: "complete" })) };
  const chat = await invoke(handler, "POST", `/api/agents/${agent.id}/conversation`, snapshot);
  assert.equal(chat.status, 200);
  assert.deepEqual(JSON.parse((await invoke(handler, "GET", `/api/agents/${agent.id}/conversation`)).text), JSON.parse(chat.text));
  assert.equal(JSON.parse((await invoke(handler, "GET", "/api/agent-requirements")).text).requirements.length, 1);
  assert.equal(JSON.parse(await readFile(join(dataDir, "agents", agent.id, "conversations/saved.json"), "utf8")).messages.length, 2);
  await invoke(handler, "POST", `/api/agents/${agent.id}/remove`, {});
  const imported = await invoke(handler, "POST", `/api/agents/${agent.id}/requirements`, { ...requirement, importOnly: true });
  assert.deepEqual(JSON.parse(imported.text), { requirement: null, deleted: true });
});

test("新增持久化接口继续拒绝外部来源，无效对话不会写入文件", async () => {
  let writes = 0;
  const handler = makeHandler({ saveRequirements: () => { writes++; }, saveConversation: () => { writes++; } });
  for (const action of ["requirements", "conversation"]) {
    const input = request("POST", `/api/agents/${agent.id}/${action}`, {});
    input.headers.host = "127.0.0.1:3000"; input.headers.origin = "https://outside.example";
    const response = new StreamingResponse(); await handler(input, response);
    assert.equal(response.status, 403);
  }
  assert.equal(writes, 0);
});

test("用户 Agent JSON 接口使用独立后端，返回定义、实际回复与取消/删除结果", async () => {
  const seen = [];
  const reply = { agentId: agent.id, sessionId: turnInput.sessionId, reply: "已整理周报", status: "completed" };
  const handler = makeHandler({
    get: async (id) => { seen.push(["get", id]); return id === agent.id ? agent : null; },
    build: async (body, { signal }) => { seen.push(["build", body]); assert.equal(signal.aborted, false); return { agent }; },
    prompt: async (body) => { seen.push(["prompt", body]); return reply; },
    cancel: async (id) => { seen.push(["cancel", id]); return { cancelled: true }; },
    remove: async (id) => { seen.push(["remove", id]); return { removed: true }; },
  }, { projectAgent: { prompt: async () => assert.fail("工作 Agent 不能调用项目助手") } });
  assert.deepEqual(JSON.parse((await invoke(handler, "GET", `/api/agents/${agent.id}`)).text), { agent, architecture: null });
  assert.deepEqual(JSON.parse((await invoke(handler, "GET", "/api/agents/not-built")).text), { agent: null, architecture: null });
  const localRequest = request("POST", "/api/agents/build", buildInput);
  Object.assign(localRequest.headers, { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" });
  const built = new StreamingResponse(); await handler(localRequest, built);
  assert.equal(built.status, 200);
  assert.match(built.headers["content-type"], /application\/json/);
  assert.deepEqual(JSON.parse(built.text), { agent });
  assert.equal(built.listenerCount("close"), 0);
  assert.deepEqual(JSON.parse((await invoke(handler, "POST", "/api/agents/turn", turnInput)).text), reply);
  assert.deepEqual(JSON.parse((await invoke(handler, "POST", "/api/agents/cancel", { sessionId: turnInput.sessionId })).text), { cancelled: true });
  assert.deepEqual(JSON.parse((await invoke(handler, "POST", `/api/agents/${agent.id}/remove`, {})).text), { removed: true });
  assert.deepEqual(seen, [["get", agent.id], ["get", "not-built"], ["build", buildInput],
    ["prompt", turnInput], ["cancel", turnInput.sessionId], ["remove", agent.id]]);
});

test("构建流先交付状态，构建结束才发送完成定义", async (t) => {
  const ready = deferred(), hold = deferred();
  t.after(() => hold.resolve());
  const handler = makeHandler({ build: async (body, { signal, onProgress }) => {
    assert.deepEqual(body, buildInput);
    assert.equal(signal.aborted, false);
    onProgress({ type: "status", label: "正在生成工作指令…" });
    ready.resolve(); await hold.promise;
    return { agent };
  } });
  const { response, pending } = stream(handler, "/api/agents/build", buildInput);
  await ready.promise;
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"], /application\/x-ndjson/);
  assert.deepEqual(response.events(), [{ type: "status", label: "正在生成工作指令…" }]);
  assert.equal(response.writableEnded, false);
  hold.resolve(); await pending;
  assert.deepEqual(response.events().at(-1), { type: "done", result: { agent } });
  assert.equal(response.listenerCount("close"), 0);
});

test("资料、记忆和产物 API 使用独立 Agent 身份，只交付 JSON 数据", async () => {
  const seen = [], profile = { name: "我的周报", description: "显示简介", icon: "📝" }, files = [{ path: "pages/result.html", size: 42, updatedAt: "2026-10-04T00:00:00.000Z" }];
  const handler = makeHandler({
    getProfiles: async () => ({ profiles: [{ id: agent.id, ...profile }] }),
    setProfile: async (id, value) => { seen.push(["profile", id, value]); return { profile: value }; },
    getMemory: async (id) => { seen.push(["memory", id]); return { memory: "优先简短中文" }; },
    setMemory: async (id, memory) => { seen.push(["save-memory", id, memory]); return { memory }; },
    files: async (id) => { seen.push(["files", id]); return { files, truncated: false }; },
    file: async (id, path) => { seen.push(["file", id, path]); return { path, content: "<script>window.parent.example()</script>", truncated: false }; },
  });
  assert.deepEqual(JSON.parse((await invoke(handler, "GET", "/api/agent-profiles")).text), { profiles: [{ id: agent.id, ...profile }] });
  assert.deepEqual(JSON.parse((await invoke(handler, "POST", `/api/agents/${agent.id}/profile`, profile)).text), { profile });
  assert.deepEqual(JSON.parse((await invoke(handler, "GET", `/api/agents/${agent.id}/memory`)).text), { memory: "优先简短中文" });
  assert.deepEqual(JSON.parse((await invoke(handler, "POST", `/api/agents/${agent.id}/memory`, { memory: "保存后的偏好" })).text), { memory: "保存后的偏好" });
  assert.deepEqual(JSON.parse((await invoke(handler, "GET", `/api/agents/${agent.id}/files`)).text), { files, truncated: false });
  const file = await invoke(handler, "GET", `/api/agents/${agent.id}/file?path=pages%2Fresult.html`);
  assert.match(file.headers["content-type"], /^application\/json/);
  assert.deepEqual(JSON.parse(file.text), { path: "pages/result.html", content: "<script>window.parent.example()</script>", truncated: false });
  assert.equal((await invoke(handler, "GET", `/api/agents/${agent.id}/files/pages/result.html`)).status, 404);
  assert.deepEqual(seen, [["profile", agent.id, profile], ["memory", agent.id], ["save-memory", agent.id, "保存后的偏好"], ["files", agent.id], ["file", agent.id, "pages/result.html"]]);
});

test("辅助接口输入错误沿用安全错误响应，缺少产物路径不产生执行路由", async () => {
  const handler = makeHandler({
    setProfile: async () => { throw new InputError("名称不能为空"); },
    setMemory: async (_id, value) => { assert.equal(value, undefined); throw new InputError("记忆需为文本"); },
    file: async (_id, path) => { assert.equal(path, null); throw new InputError("请提供文件路径"); },
  });
  assert.equal((await invoke(handler, "POST", `/api/agents/${agent.id}/profile`, {})).status, 400);
  const memory = await invoke(handler, "POST", `/api/agents/${agent.id}/memory`, {});
  assert.equal(memory.status, 400); assert.equal(JSON.parse(memory.text).error, "记忆需为文本");
  const file = await invoke(handler, "GET", `/api/agents/${agent.id}/file`);
  assert.equal(file.status, 400); assert.equal(JSON.parse(file.text).error, "请提供文件路径");
});

test("JSON 与流式构建断线都中止构建且不回传迟到成功", async () => {
  for (const streaming of [false, true]) {
    const ready = deferred();
    let signal;
    const handler = makeHandler({ build: async (_body, options) => {
      signal = options.signal; ready.resolve();
      await new Promise((done) => signal.addEventListener("abort", done, { once: true }));
      options.onProgress({ type: "status", label: "迟到进度" });
      return { agent };
    } });
    const input = request("POST", "/api/agents/build", buildInput);
    if (streaming) input.headers.accept = "application/x-ndjson";
    const response = new StreamingResponse();
    const pending = handler(input, response); await ready.promise;
    response.destroyed = true; response.emit("close"); await pending;
    assert.equal(signal.aborted, true);
    assert.equal(response.text, "");
    assert.equal(response.listenerCount("close"), 0);
  }
});

test("工作 Agent 流转发实际文字片段，最终结果保留独立会话标识", async (t) => {
  const ready = deferred(), hold = deferred();
  t.after(() => hold.resolve());
  const reply = { agentId: agent.id, sessionId: turnInput.sessionId, reply: "实际模型回复", status: "completed" };
  const handler = makeHandler({ prompt: async (body, emit) => {
    assert.deepEqual(body, turnInput);
    emit({ type: "status", label: "周报助手正在处理" });
    emit({ type: "text-start" });
    emit({ type: "text-delta", delta: "实际模型" });
    ready.resolve(); await hold.promise;
    emit({ type: "text-delta", delta: "回复" });
    return reply;
  } });
  const { response, pending } = stream(handler, "/api/agents/turn", turnInput);
  await ready.promise;
  assert.equal(response.writableEnded, false);
  assert.equal(response.events().some((event) => event.delta === "实际模型"), true);
  assert.equal(response.events().some((event) => event.type === "done"), false);
  hold.resolve(); await pending;
  const events = response.events();
  assert.equal(events.filter((event) => event.type === "text-delta").map((event) => event.delta).join(""), reply.reply);
  assert.deepEqual(events.at(-1), { type: "done", result: reply });
  assert.equal(response.listenerCount("close"), 0);
});

test("工作 Agent 断线只取消本次会话，已输出文字不被迟到结果覆盖", async () => {
  const ready = deferred(), cancelled = deferred();
  const seen = [];
  const handler = makeHandler({
    prompt: async (_body, emit) => {
      emit({ type: "text-delta", delta: "已经显示" }); ready.resolve();
      await cancelled.promise;
      emit({ type: "text-delta", delta: "迟到文字" });
      return { reply: "不应发送" };
    },
    cancel: async (id) => { seen.push(id); cancelled.resolve(); return { cancelled: true }; },
  });
  const { response, pending } = stream(handler, "/api/agents/turn", turnInput);
  await ready.promise;
  response.destroyed = true; response.emit("close"); await pending;
  assert.deepEqual(seen, [turnInput.sessionId]);
  assert.deepEqual(response.events(), [{ type: "text-delta", delta: "已经显示" }]);
  assert.equal(response.listenerCount("close"), 0);
});

test("构建与执行错误使用安全错误格式，不发送成功事件或内部异常详情", async () => {
  const failures = [
    { error: new InputError("请先确认需求"), status: 400, reason: "invalid_request" },
    { error: new ProviderError("模型暂时不可用", { stage: "llm", reason: "timeout" }), status: 502, reason: "timeout" },
    { error: new Error("PRIVATE_IMPLEMENTATION_DETAIL"), status: 500, reason: "internal_error" },
  ];
  for (const failure of failures) {
    const fail = async () => { throw failure.error; };
    const handler = makeHandler({ build: fail, prompt: fail }, { config: { model: "fixture-model" } });
    for (const path of ["/api/agents/build", "/api/agents/turn"]) {
      const normal = await invoke(handler, "POST", path, {});
      assert.equal(normal.status, failure.status);
      assert.equal(JSON.parse(normal.text).diagnostic.reason, failure.reason);
      const { response, pending } = stream(handler, path, {}); await pending;
      assert.equal(response.events().at(-1).type, "error");
      assert.equal(response.events().some((event) => event.type === "done"), false);
      assert.equal(response.events().at(-1).diagnostic.providerModel, "fixture-model");
      assert.doesNotMatch(normal.text + response.text, /PRIVATE_IMPLEMENTATION_DETAIL/);
      assert.equal(response.listenerCount("close"), 0);
    }
  }
});

test("Agent 接口拒绝跨站/外部 Host 及无效 JSON，删除不能由 GET 触发", async () => {
  let calls = 0;
  const unexpected = async () => { calls++; assert.fail("不合法请求不能进入 Agent 后端"); };
  const handler = makeHandler({ get: unexpected, build: unexpected, prompt: unexpected, cancel: unexpected, remove: unexpected,
    getProfiles: unexpected, setProfile: unexpected, getMemory: unexpected, setMemory: unexpected, files: unexpected, file: unexpected });
  const routes = [["GET", `/api/agents/${agent.id}`], ["POST", "/api/agents/build"],
    ["POST", "/api/agents/turn"], ["POST", "/api/agents/cancel"], ["POST", `/api/agents/${agent.id}/remove`],
    ["GET", "/api/agent-profiles"], ["POST", `/api/agents/${agent.id}/profile`],
    ["GET", `/api/agents/${agent.id}/memory`], ["POST", `/api/agents/${agent.id}/memory`],
    ["GET", `/api/agents/${agent.id}/files`], ["GET", `/api/agents/${agent.id}/file?path=example.html`]];
  for (const [method, path] of routes) {
    for (const headers of [
      { host: "127.0.0.1:3000", origin: "https://unrelated.example" },
      { host: "unrelated.example:3000" },
      { host: "localhost:3000", "sec-fetch-site": "cross-site" },
    ]) {
      const input = request(method, path, method === "POST" ? {} : undefined);
      Object.assign(input.headers, headers);
      const response = new StreamingResponse(); await handler(input, response);
      assert.equal(response.status, 403);
    }
    if (method === "POST") assert.equal((await invoke(handler, method, path)).status, 400);
  }
  for (const body of [null, [], "invalid"]) assert.equal((await invoke(handler, "POST", "/api/agents/build", body)).status, 400);
  const malformed = request("POST", "/api/agents/build");
  malformed.headers["content-type"] = "application/json";
  const response = new StreamingResponse(); await handler(malformed, response);
  assert.equal(response.status, 400);
  assert.equal((await invoke(handler, "GET", `/api/agents/${agent.id}/remove`)).status, 404);
  assert.equal(calls, 0);
});

test("更新模型设置释放旧 Agent 会话，服务销毁同时释放三类资源", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "neuma-agent-api-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const envPath = join(dir, ".env");
  let agentClosed = 0, projectAgentClosed = 0, projectsClosed = 0;
  const config = { model: "old-model" };
  const handler = makeHandler({ close: async () => { agentClosed++; } }, {
    config, envPath,
    projectAgent: { dispose: async () => { projectAgentClosed++; } },
    projects: { dispose: async () => { projectsClosed++; } },
  });
  const saved = await invoke(handler, "POST", "/api/settings", { model: "new-model" });
  assert.equal(saved.status, 200);
  assert.equal(config.model, "new-model");
  assert.match(await readFile(envPath, "utf8"), /^NEUMA_LLM_MODEL=new-model$/m);
  assert.equal(agentClosed, 1);
  assert.equal(projectAgentClosed, 1);
  assert.equal(projectsClosed, 0);
  await handler.dispose();
  assert.equal(agentClosed, 2);
  assert.equal(projectAgentClosed, 2);
  assert.equal(projectsClosed, 1);
});

test("用户 Agent 运行前端资源可加载", async () => {
  const response = await invoke(makeHandler({}), "GET", "/agent-runtime.js");
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"], /javascript/);
  assert.ok(response.text.trim());
});
