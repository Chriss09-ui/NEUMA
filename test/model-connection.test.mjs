import test from "node:test";
import assert from "node:assert/strict";
import { registerConnectionProbeTests } from "./helpers/connection-probe.mjs";
import { testAgentModelConnection, testModelConnection } from "../src/model-connection.mjs";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { InputError, ProviderError } from "../src/requirements/core.mjs";
import { createPiSession } from "../src/runtime/pi-runtime.mjs";

const config = Object.freeze({
  chatUrl: "https://example.test/v1/chat/completions", model: "example-model", apiKey: "synthetic-test-key",
  jevApiKey: "synthetic-judge-key", jevModel: "judge-model", llmConfigured: true, jevConfigured: true,
});
const reply = (message = { role: "assistant", content: "OK" }) => new Response(JSON.stringify({
  choices: [{ index: 0, finish_reason: "stop", message }],
}));
const success = async () => reply();
const assertSafe = (error, reason, secrets = [config.apiKey, config.jevApiKey, config.chatUrl]) => {
  assert.ok(error instanceof ProviderError);
  assert.equal(error.diagnostic.stage, "llm");
  assert.equal(error.diagnostic.reason, reason);
  for (const secret of secrets) {
    assert.equal(`${error.message} ${JSON.stringify(error.diagnostic)}`.includes(secret), false);
  }
  assert.ok(JSON.stringify(error.diagnostic).length < 200);
  return true;
};

test("模型测试用已保存配置发送短请求，返回耗时而不回传模型正文", async () => {
  const before = { ...config };
  let calls = 0;
  const result = await testModelConnection(config, {}, { fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, config.chatUrl);
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.deepEqual(init.headers, { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` });
    assert.equal(init.signal.aborted, false);
    assert.deepEqual(JSON.parse(init.body), {
      model: config.model, stream: false, max_tokens: 32,
      messages: [{ role: "user", content: "Reply with OK only." }],
    });
    return reply({ content: `OK ${config.apiKey}` });
  } });
  assert.deepEqual(Object.keys(result).sort(), ["latencyMs", "model", "ok"]);
  assert.equal(result.ok, true);
  assert.equal(result.model, config.model);
  assert.ok(Number.isInteger(result.latencyMs) && result.latencyMs >= 0);
  assert.equal(JSON.stringify(result).includes(config.apiKey), false);
  assert.equal(calls, 1);
  assert.deepEqual(config, before);
});

test("模型测试接受未保存的配置，保留已保存配置对象", async () => {
  const draft = { chatUrl: " https://draft.test/v2/chat/completions ", model: " draft-model ", apiKey: " draft-test-key " };
  const result = await testModelConnection(config, draft, { fetchImpl: async (url, init) => {
    assert.equal(url, "https://draft.test/v2/chat/completions");
    assert.equal(JSON.parse(init.body).model, "draft-model");
    assert.equal(init.headers.authorization, "Bearer draft-test-key");
    return reply();
  } });
  assert.equal(result.model, "draft-model");
  assert.equal(config.model, "example-model");
  assert.equal(draft.model, " draft-model ");
});

test("空 API Key 沿用已保存密钥，单独修改模型时也可以测试", async () => {
  for (const body of [{ apiKey: "" }, { model: "other-model", apiKey: "  " }]) {
    const result = await testModelConnection(config, body, { fetchImpl: async (_url, init) => {
      assert.equal(init.headers.authorization, `Bearer ${config.apiKey}`);
      return reply();
    } });
    assert.equal(result.model, body.model || config.model);
  }
});

test("未配置完整模型时给出输入提示且不发请求", async () => {
  let calls = 0;
  for (const saved of [{}, { ...config, apiKey: "" }, { ...config, model: "" }, { ...config, chatUrl: "" }]) {
    await assert.rejects(testModelConnection(saved, {}, { fetchImpl: async () => { calls++; return reply(); } }),
      (error) => error instanceof InputError && /接口地址、模型名和 API Key/.test(error.message));
  }
  assert.equal(calls, 0);
  assert.equal((await testModelConnection({}, {
    chatUrl: config.chatUrl, model: config.model, apiKey: config.apiKey,
  }, { fetchImpl: success })).ok, true);
});

test("模型测试复用保存校验，拒绝非对象、未知字段和无效配置", async () => {
  let calls = 0;
  const invalid = [null, [], "config", 5, { jevApiKey: "unaccepted" }, { clear: ["apiKey"] },
    { timeoutMs: 1 }, { model: null }, { model: 5 }, { model: "" }, { chatUrl: "" }, { apiKey: null },
    { chatUrl: "https://example.test/v1" }, { chatUrl: "file:///v1/chat/completions" },
    { chatUrl: "https://user:password@example.test/v1/chat/completions" },
    { chatUrl: "https://example.test/v1/chat/completions?key=value" },
    { model: "invalid model" }, { model: "a".repeat(201) }, { apiKey: "unsafe\nvalue" }, { apiKey: "a".repeat(501) },
    JSON.parse('{"__proto__":{"model":"inherited"}}'), { [Symbol("secret")]: "ignored" }];
  for (const body of invalid) {
    await assert.rejects(testModelConnection(config, body, { fetchImpl: async () => { calls++; return reply(); } }), InputError);
  }
  await assert.rejects(testModelConnection({ ...config, chatUrl: "https://example.test/wrong" }, {}, { fetchImpl: success }), InputError);
  assert.equal(calls, 0);
});

test("MiMo 禁用思考，其他兼容接口不附加 MiMo 参数", async () => {
  for (const hostname of ["api.xiaomimimo.com", "xiaomimimo.com", "xiaomimimo.com.other.test", "other.test"]) {
    await testModelConnection(config, { chatUrl: `https://${hostname}/v1/chat/completions` }, {
      fetchImpl: async (_url, init) => {
        assert.deepEqual(JSON.parse(init.body).thinking,
          ["api.xiaomimimo.com", "xiaomimimo.com"].includes(hostname) ? { type: "disabled" } : undefined);
        return reply();
      },
    });
  }
});

test("兼容文字块及非空 reasoning 回应均证明模型实际响应", async () => {
  for (const message of [{ content: [{ type: "text", text: "OK" }] },
    { content: null, reasoning_content: "brief model reasoning" }, { reasoning: "brief model reasoning" }]) {
    assert.equal((await testModelConnection(config, {}, { fetchImpl: async () => reply(message) })).ok, true);
  }
  const response = new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { reasoning_content: "reasoning" } }] }));
  assert.equal((await testModelConnection(config, {}, { fetchImpl: async () => response })).ok, true);
});

test("HTTP 成功但无有效模型回复不能报告连接成功", async () => {
  const invalid = [{}, { choices: [] }, { choices: [{ delta: { content: "OK" } }] },
    { error: { message: config.apiKey }, choices: [{ message: { content: "OK" } }] },
    ...[{ content: " " }, { content: 3 }, { content: {} }, { reasoning_content: " " },
      { role: "user", content: "OK" }, { content: "OK", tool_calls: [{}] }].map((message) => ({ choices: [{ message }] })),
    { choices: [{ finish_reason: "content_filter", message: { content: "OK" } }] }];
  for (const payload of invalid) {
    await assert.rejects(testModelConnection(config, {}, { fetchImpl: async () => new Response(JSON.stringify(payload)) }),
      (error) => assertSafe(error, "missing_content"));
  }
});

registerConnectionProbeTests({ label: "模型", testConnection: testModelConnection, config, apiKey: config.apiKey, assertSafe });

test("普通模型探针持续收到正文时可超过原总时限，仍只发送一次请求", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 2_000_000_000_000 });
  let body, calls = 0, settled = false;
  const pending = testModelConnection(config, {}, { timeoutMs: 10, fetchImpl: async () => {
    calls++;
    return new Response(new ReadableStream({ start(controller) { body = controller; } }));
  } });
  void pending.then(() => { settled = true; });
  await new Promise((done) => setImmediate(done));
  const chunks = ['{"choices":[', '{"message":', '{"content":"OK"}}]}'];
  for (const chunk of chunks) {
    t.mock.timers.tick(9);
    body.enqueue(new TextEncoder().encode(chunk));
    await new Promise((done) => setImmediate(done));
    assert.equal(settled, false);
  }
  body.close();
  assert.equal((await pending).ok, true);
  assert.equal(calls, 1);
});

function agentProbeSession(script) {
  const state = { aborted: 0, disposed: 0, compaction: [], options: null, emit: () => {} };
  state.factory = async (options) => {
    state.options = options;
    const session = { messages: [], text: "",
      setAutoCompactionEnabled: (enabled) => state.compaction.push(enabled),
      subscribe: (listener) => { state.emit = listener; return () => { state.emit = () => {}; }; },
      abort: async () => { state.aborted++; state.release?.(); },
      dispose: () => { state.disposed++; }, getLastAssistantText: () => session.text,
      prompt: async () => {
        const emit = (event) => state.emit(event);
        if (script) return await script({ options, session, emit, state });
        emit({ type: "turn_start" });
        emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: "{}" } });
        const result = await options.customTools[0].execute("probe", { challenge: "neuma-agent-probe" });
        emit({ type: "turn_start" });
        session.text = `OK ${JSON.parse(result.content[0].text).receipt}`;
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: session.text } });
        session.messages.push({ role: "assistant", stopReason: "stop" });
      } };
    state.session = session;
    return session;
  };
  return state;
}

test("构建能力探针禁用压缩、仅装配无副作用工具，验证流式工具往返并清理会话", async () => {
  const state = agentProbeSession(), before = { ...config };
  const result = await testAgentModelConnection(config, { model: "draft-model", apiKey: "" }, { sessionFactory: state.factory });
  assert.deepEqual(Object.keys(result).sort(), ["latencyMs", "model", "ok", "streaming", "toolRoundTrip", "toolsCalled"]);
  assert.deepEqual({ ...result, latencyMs: 0 }, { ok: true, model: "draft-model", latencyMs: 0, streaming: true, toolsCalled: 1, toolRoundTrip: true });
  assert.ok(result.latencyMs >= 0);
  assert.deepEqual(state.compaction, [false]);
  assert.equal(state.options.maxOutputTokens, 512);
  assert.deepEqual(state.options.customTools.map((tool) => tool.name), ["check_agent_connection"]);
  assert.equal(state.options.config.apiKey, config.apiKey);
  assert.equal(state.options.config.model, "draft-model");
  assert.equal(state.options.config.llmIdleTimeoutMs, 30_000);
  assert.equal(state.disposed, 1);
  assert.equal(state.aborted, 0);
  assert.deepEqual(config, before);
  assert.doesNotMatch(JSON.stringify(result), /receipt|synthetic|neuma-agent-probe/);
});

test("构建能力探针拒绝缺少工具往返、错误回执与非流式结果", async () => {
  for (const [mode, reason] of [["no-tool", "tool_round_trip"], ["bad-receipt", "tool_round_trip"], ["no-stream", "missing_stream"]]) {
    const state = agentProbeSession(async ({ options, session, emit }) => {
      const result = mode === "no-tool" ? null : await options.customTools[0].execute("probe", { challenge: "neuma-agent-probe" });
      session.text = mode === "no-stream" ? `OK ${JSON.parse(result.content[0].text).receipt}` : `private ${config.apiKey}`;
      if (mode !== "no-stream") emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: session.text } });
      session.messages.push({ role: "assistant", stopReason: "stop" });
    });
    await assert.rejects(testAgentModelConnection(config, {}, { sessionFactory: state.factory }), (error) => assertSafe(error, reason));
    assert.equal(state.disposed, 1);
  }
});

test("构建能力探针不会暴露模型原始错误或失败正文", async () => {
  for (const mode of ["throw", "message", "length"]) {
    const state = agentProbeSession(async ({ session }) => {
      if (mode === "throw") throw new Error(`HTTP 401 ${config.apiKey}`);
      session.messages.push({ role: "assistant", stopReason: mode === "length" ? "length" : "error", errorMessage: `HTTP 401 ${config.apiKey}` });
    });
    await assert.rejects(testAgentModelConnection(config, {}, { sessionFactory: state.factory }),
      (error) => assertSafe(error, mode === "length" ? "output_limit" : "api_authentication"));
    assert.equal(state.disposed, 1);
  }
});

test("构建能力探针最多四轮，超出时停止并清理", async () => {
  const state = agentProbeSession(async ({ emit }) => { for (let index = 0; index < 5; index++) emit({ type: "turn_start" }); });
  await assert.rejects(testAgentModelConnection(config, {}, { sessionFactory: state.factory }), (error) => assertSafe(error, "turn_limit"));
  assert.equal(state.aborted, 1);
  assert.equal(state.disposed, 1);
});

test("构建能力探针三次短暂失败后仍可完成两逻辑轮，输出预算保持 512", async () => {
  const state = agentProbeSession(async ({ options, session, emit }) => {
    assert.equal(options.maxOutputTokens, 512);
    for (let attempt = 1; attempt <= 3; attempt++) {
      emit({ type: "turn_start" });
      emit({ type: "turn_end" });
      emit({ type: "auto_retry_start", attempt });
    }
    emit({ type: "turn_start" });
    emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: "{}" } });
    const result = await options.customTools[0].execute("probe", { challenge: "neuma-agent-probe" });
    emit({ type: "turn_end" });
    emit({ type: "auto_retry_end", success: true });
    emit({ type: "turn_start" });
    session.text = `OK ${JSON.parse(result.content[0].text).receipt}`;
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: session.text } });
    session.messages.push({ role: "assistant", stopReason: "stop" });
  });
  const result = await testAgentModelConnection(config, {}, { sessionFactory: state.factory });
  assert.equal(result.ok, true); assert.equal(result.toolRoundTrip, true);
  assert.equal(state.aborted, 0); assert.equal(state.disposed, 1);
});

test("同一失败轮的重复重试事件只能撤回一次预算，超过四逻辑轮仍停止", async () => {
  const state = agentProbeSession(async ({ emit }) => {
    emit({ type: "turn_start" }); emit({ type: "turn_start" });
    emit({ type: "turn_start" });
    emit({ type: "auto_retry_start", attempt: 1 }); emit({ type: "auto_retry_start", attempt: 1 });
    for (let index = 0; index < 3; index++) emit({ type: "turn_start" });
  });
  await assert.rejects(testAgentModelConnection(config, {}, { sessionFactory: state.factory }), (error) => assertSafe(error, "turn_limit"));
  assert.equal(state.aborted, 1); assert.equal(state.disposed, 1);
});

test("构建能力探针沿用运行层无响应诊断，主动取消仍停止并清理", async () => {
  for (const mode of ["idle", "cancel"]) {
    const controller = new AbortController();
    const state = agentProbeSession(async ({ options, session }) => {
      assert.equal(options.config.llmIdleTimeoutMs, 15);
      if (mode === "idle") session.messages.push({ role: "assistant", stopReason: "error",
        errorMessage: "NEUMA_MODEL_IDLE_TIMEOUT: 连续未收到模型响应数据" });
      else { controller.abort(); await new Promise(() => {}); }
    });
    await assert.rejects(testAgentModelConnection(config, {}, { sessionFactory: state.factory, signal: controller.signal, timeoutMs: 15 }),
      (error) => mode === "idle" ? assertSafe(error, "timeout") && /连续未返回响应数据/.test(error.message) : error.name === "AbortError");
    assert.equal(state.aborted, mode === "idle" ? 0 : 1);
    assert.equal(state.disposed, 1);
  }
});

test("构建能力探针不再用整轮计时器中断有响应的工具往返", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 2_000_000_000_000 });
  const state = agentProbeSession(async ({ options, session, emit }) => {
    assert.equal(options.config.llmIdleTimeoutMs, 10);
    emit({ type: "turn_start" });
    for (let index = 0; index < 4; index++) {
      t.mock.timers.tick(9);
      emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: "{}" } });
    }
    const result = await options.customTools[0].execute("probe", { challenge: "neuma-agent-probe" });
    emit({ type: "turn_start" });
    t.mock.timers.tick(9);
    session.text = `OK ${JSON.parse(result.content[0].text).receipt}`;
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: session.text } });
    session.messages.push({ role: "assistant", stopReason: "stop" });
  });
  assert.equal((await testAgentModelConnection(config, {}, { sessionFactory: state.factory, timeoutMs: 10 })).ok, true);
  assert.equal(state.aborted, 0); assert.equal(state.disposed, 1);
});

test("创建中的构建测试取消后，迟到会话也会停止并清理", async () => {
  let release, entered;
  const creating = new Promise((done) => { release = done; }), ready = new Promise((done) => { entered = done; });
  const controller = new AbortController();
  let aborted = 0, disposed = 0;
  const pending = testAgentModelConnection(config, {}, { signal: controller.signal,
    sessionFactory: async () => { entered(); return await creating; } });
  await ready;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  release({ abort: async () => { aborted++; }, dispose: () => { disposed++; } });
  await new Promise((done) => setImmediate(done));
  assert.equal(aborted, 1);
  assert.equal(disposed, 1);
});

test("构建能力探针沿用输入配置校验，无效或已取消输入不创建会话", async () => {
  let calls = 0;
  const sessionFactory = () => { calls++; assert.fail("无效输入不创建会话"); };
  for (const body of [null, [], { timeoutMs: 2 }, { model: "" }, { apiKey: "unsafe\nvalue" }])
    await assert.rejects(testAgentModelConnection(config, body, { sessionFactory }), InputError);
  await assert.rejects(testAgentModelConnection({}, {}, { sessionFactory }), InputError);
  await assert.rejects(testAgentModelConnection(config, {}, { sessionFactory, timeoutMs: 30_001 }), InputError);
  await assert.rejects(testAgentModelConnection(config, {}, { sessionFactory, signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.equal(calls, 0);
});

test("真实 Pi SDK 构建能力探针持续收到数据时超过旧总时限仍完成两轮工具往返", async (t) => {
  const requests = [], model = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString()); requests.push(payload);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      for (let index = 0; index < 4; index++) {
        response.write(": model-response-active\n\n");
        await delay(30);
      }
      const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: "agent-probe", object: "chat.completion.chunk", created: 1,
        model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (requests.length === 1) {
        chunk({ role: "assistant", tool_calls: [{ index: 0, id: "probe-call", type: "function", function: {
          name: "check_agent_connection", arguments: JSON.stringify({ challenge: "neuma-agent-probe" }) } }] });
        chunk({}, "tool_calls");
      } else {
        const result = payload.messages.findLast((message) => message.role === "tool");
        chunk({ role: "assistant", content: `OK ${JSON.parse(result.content).receipt}` }); chunk({}, "stop");
      }
      response.end("data: [DONE]\n\n");
    } catch { response.writeHead(500); response.end(); }
  });
  model.listen(0, "127.0.0.1"); await once(model, "listening");
  t.after(async () => { model.closeAllConnections(); await new Promise((done) => model.close(done)); });
  const result = await testAgentModelConnection({ ...config, chatUrl: `http://127.0.0.1:${model.address().port}/v1/chat/completions` }, {}, { timeoutMs: 100 });
  assert.equal(result.streaming, true); assert.equal(result.toolRoundTrip, true); assert.equal(result.toolsCalled, 1);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.stream === true && request.max_tokens === 512));
  assert.deepEqual(requests[0].tools.map((tool) => tool.function.name), ["check_agent_connection"]);
  assert.equal(requests[1].messages.findLast((message) => message.role === "tool").tool_call_id, "probe-call");
});

test("真实 Pi SDK 构建能力探针连续无响应会停止，且不泄漏正文", async (t) => {
  let requests = 0;
  const model = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the local mock request. */ }
    requests++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
  });
  model.listen(0, "127.0.0.1"); await once(model, "listening");
  t.after(async () => { model.closeAllConnections(); await new Promise((done) => model.close(done)); });
  await assert.rejects(testAgentModelConnection({ ...config, chatUrl: `http://127.0.0.1:${model.address().port}/v1/chat/completions` }, {}, {
    timeoutMs: 30, sessionFactory: async (options) => {
      const session = await createPiSession(options); session.setAutoRetryEnabled(false); return session;
    },
  }), (error) => assertSafe(error, "timeout") && /连续未返回响应数据/.test(error.message));
  assert.equal(requests, 1);
});
