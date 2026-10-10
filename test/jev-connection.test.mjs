import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { testJevConnection } from "../src/model-connection.mjs";
import { InputError, ProviderError } from "../src/requirements/core.mjs";

const config = Object.freeze({
  jevApiKey: "synthetic-jev-key", jevModel: "jev-1.13.0", jevConfigured: true,
  apiKey: "synthetic-llm-key", chatUrl: "https://private.example.test/v1/chat/completions", model: "llm-model",
});
const reply = (noul = 1) => new Response(JSON.stringify({
  answers: { connectivity: { type: "noul", noul } },
}));
const success = async () => reply();
function assertSafe(error, reason) {
  assert.ok(error instanceof ProviderError);
  assert.equal(error.diagnostic.stage, "jev");
  assert.equal(error.diagnostic.reason, reason);
  assert.match(error.message, /Jev/);
  const output = `${error.message} ${JSON.stringify(error.diagnostic)}`;
  for (const secret of [config.jevApiKey, config.apiKey, config.chatUrl, "https://api.typesafe.ai/v1/systemone"]) {
    assert.equal(output.includes(secret), false);
  }
  assert.ok(JSON.stringify(error.diagnostic).length < 200);
  return true;
}

test("Jev 测试发送现有 TypeSafe 判断协议，不调用兼容模型", async () => {
  const before = { ...config };
  let calls = 0;
  const result = await testJevConnection(config, {}, { fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.deepEqual(init.headers, { "content-type": "application/json", authorization: `Bearer ${config.jevApiKey}` });
    assert.equal(init.signal.aborted, false);
    assert.deepEqual(JSON.parse(init.body), {
      model: config.jevModel, state: { connection_test: true },
      questions: { connectivity: {
        type: "noul", instructions: "Does the connection_test flag in state equal true?",
        criteria: { true: "The connection_test flag is true.", false: "The connection_test flag is false or absent." },
      } },
    });
    return new Response(JSON.stringify({ answers: { connectivity: { type: "noul", noul: 1 } }, private: config.jevApiKey }));
  } });
  assert.deepEqual(Object.keys(result).sort(), ["latencyMs", "model", "ok"]);
  assert.equal(result.ok, true);
  assert.equal(result.model, config.jevModel);
  assert.ok(Number.isInteger(result.latencyMs) && result.latencyMs >= 0);
  assert.equal(JSON.stringify(result).includes(config.jevApiKey), false);
  assert.equal(calls, 1);
  assert.deepEqual(config, before);
});

test("Jev 不依赖兼容模型配置，缺省 Jev 模型沿用现有默认值", async () => {
  const result = await testJevConnection({ jevApiKey: config.jevApiKey }, {}, { fetchImpl: async (_url, init) => {
    assert.equal(JSON.parse(init.body).model, "jev-1.13.0");
    return reply();
  } });
  assert.equal(result.ok, true);
  assert.equal(result.model, "jev-1.13.0");
});

test("Jev 接受临时模型与密钥，空密钥继续使用保存配置", async () => {
  const draft = Object.freeze({ jevModel: " draft-jev ", jevApiKey: " synthetic-draft-key " });
  const result = await testJevConnection(config, draft, { fetchImpl: async (_url, init) => {
    assert.equal(init.headers.authorization, "Bearer synthetic-draft-key");
    assert.equal(JSON.parse(init.body).model, "draft-jev");
    return reply();
  } });
  assert.equal(result.model, "draft-jev");
  assert.equal(draft.jevModel, " draft-jev ");
  for (const body of [{ jevApiKey: "" }, { jevApiKey: "  ", jevModel: "saved-key-model" }, { clear: [] }]) {
    await testJevConnection(config, body, { fetchImpl: async (_url, init) => {
      assert.equal(init.headers.authorization, `Bearer ${config.jevApiKey}`);
      return reply();
    } });
  }
});

test("Jev 清除密钥后不回退到旧值，clear 保持设置保存语义", async () => {
  let calls = 0;
  for (const body of [{ clear: ["jevApiKey"] }, { jevApiKey: "new-test-key", clear: ["jevApiKey"] }]) {
    await assert.rejects(testJevConnection(config, body, { fetchImpl: async () => { calls++; return reply(); } }),
      (error) => error instanceof InputError && /Jev API Key/.test(error.message));
  }
  assert.equal(calls, 0);
  assert.equal(config.jevApiKey, "synthetic-jev-key");
});

test("缺少 Jev 密钥给出输入提示，临时填入密钥即可测试", async () => {
  await assert.rejects(testJevConnection({}, {}, { fetchImpl: async () => { assert.fail("不能发请求"); } }),
    (error) => error instanceof InputError && /Jev API Key/.test(error.message));
  assert.equal((await testJevConnection({}, { jevApiKey: config.jevApiKey }, { fetchImpl: success })).ok, true);
});

test("Jev 复用设置校验，只接受 Jev 字段和对应清除选项", async () => {
  let calls = 0;
  for (const body of [null, [], "draft", 0, { apiKey: "llm-key" }, { chatUrl: config.chatUrl },
    { model: "other" }, { timeoutMs: 1 }, { jevModel: null }, { jevApiKey: 5 },
    { clear: ["apiKey"] }, { clear: ["jevApiKey", "apiKey"] }, { clear: "jevApiKey" }, { clear: null },
    { jevApiKey: "key\nPORT=1" }, { jevModel: "invalid model" }, { jevModel: "a".repeat(201) },
    { jevApiKey: "a".repeat(501) }, JSON.parse('{"__proto__":{"jevModel":"inherited"}}')]) {
    await assert.rejects(testJevConnection(config, body, { fetchImpl: async () => { calls++; return reply(); } }), InputError);
  }
  assert.equal(calls, 0);
  const resetDefault = await testJevConnection(config, { jevModel: "" }, { fetchImpl: success });
  assert.equal(resetDefault.model, "jev-1.13.0");
});

test("Jev 的有效 noul 判断即为连通，0 和中间值也成功", async () => {
  for (const noul of [0, 0.45, 1]) {
    assert.equal((await testJevConnection(config, {}, { fetchImpl: async () => reply(noul) })).ok, true);
  }
});

test("Jev 成功状态码必须含合法判断，任意成功 JSON 不能冒充连通", async () => {
  const invalid = [{}, { answers: {} }, { choices: [{ message: { content: "OK" } }] },
    { error: { message: config.jevApiKey }, answers: { connectivity: { type: "noul", noul: 1 } } },
    ...[{ type: "noul", noul: -0.1 }, { type: "noul", noul: 1.1 }, { type: "noul", noul: null },
      { type: "noul", noul: "1" }, { type: "noul", noul: true }, { type: "noul", noul: Infinity },
      { type: "noul", noul: NaN }, { type: "boolean", noul: 1 }, { noul: 1 }]
      .map((connectivity) => ({ answers: { connectivity } }))];
  for (const payload of invalid) {
    await assert.rejects(testJevConnection(config, {}, { fetchImpl: async () => new Response(JSON.stringify(payload)) }),
      (error) => assertSafe(error, "missing_content"));
  }
});

test("Jev HTTP 错误固定文案与诊断，不读取失败正文", async () => {
  for (const [status, reason] of [[401, "authentication"], [403, "authentication"], [429, "rate_limit"],
    [404, "not_found"], [500, "service_unavailable"], [503, "service_unavailable"],
    [400, "http_error"], [302, "redirect_rejected"]]) {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(config.jevApiKey)); },
      cancel() { cancelled = true; },
    }), { status, headers: { "x-provider-key": config.jevApiKey } });
    response.text = async () => { assert.fail("不能读取错误正文"); };
    await assert.rejects(testJevConnection(config, {}, { fetchImpl: async () => response }), (error) => {
      assertSafe(error, reason);
      assert.equal(error.diagnostic.httpStatus, status);
      return true;
    });
    assert.equal(cancelled, true);
  }
});

test("Jev 无效 JSON、UTF-8 和超限响应均安全拒绝", async () => {
  for (const content of [config.jevApiKey, "{", new Uint8Array([0xff]), null]) {
    await assert.rejects(testJevConnection(config, {}, { fetchImpl: async () => new Response(content) }),
      (error) => assertSafe(error, "invalid_json"));
  }
  await assert.rejects(testJevConnection(config, {}, { fetchImpl: async () => new Response("x".repeat(65_537)) }),
    (error) => assertSafe(error, "response_too_large"));
});

test("Jev 网络故障分类使用 Jev stage，异常正文和未知代码不泄漏", async () => {
  for (const [code, reason] of [["ENOTFOUND", "dns"], ["ETIMEDOUT", "connect_timeout"],
    ["UND_ERR_BODY_TIMEOUT", "timeout"], ["ECONNRESET", "connection_reset"], [config.jevApiKey, "connection_failed"]]) {
    await assert.rejects(testJevConnection(config, {}, { fetchImpl: async () => {
      throw Object.assign(new Error(config.jevApiKey), { cause: { code } });
    } }), (error) => assertSafe(error, reason));
  }
  await assert.rejects(testJevConnection(config, {}, { fetchImpl: async () => {
    throw new ProviderError(config.jevApiKey, { stage: config.chatUrl, reason: config.apiKey });
  } }), (error) => assertSafe(error, "connection_failed"));
});

test("Jev 超时同时覆盖等待接口和等待正文", async () => {
  let requestSignal;
  await assert.rejects(testJevConnection(config, {}, { timeoutMs: 15, fetchImpl: async (_url, init) => {
    requestSignal = init.signal;
    return new Promise(() => {});
  } }), (error) => assertSafe(error, "timeout"));
  assert.equal(requestSignal.aborted, true);
  let cancelled = false;
  await assert.rejects(testJevConnection(config, {}, { timeoutMs: 15,
    fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) }),
  (error) => assertSafe(error, "timeout"));
  assert.equal(cancelled, true);
});

test("Jev 外部取消不发新请求，也能中止正在等待的 fetch", async () => {
  const alreadyCancelled = new AbortController();
  alreadyCancelled.abort(config.jevApiKey);
  await assert.rejects(testJevConnection(config, {}, { signal: alreadyCancelled.signal,
    fetchImpl: async () => { assert.fail("不能发请求"); } }), (error) => {
    assert.equal(error.name, "AbortError");
    assert.equal(error.message.includes(config.jevApiKey), false);
    return true;
  });
  const controller = new AbortController();
  let requestSignal;
  const probe = testJevConnection(config, {}, { signal: controller.signal, fetchImpl: async (_url, init) => {
    requestSignal = init.signal;
    return new Promise(() => {});
  } });
  controller.abort(config.jevApiKey);
  await assert.rejects(probe, { name: "AbortError" });
  assert.equal(requestSignal.aborted, true);
});

test("Jev 读取响应正文时取消会释放 reader", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const probe = testJevConnection(config, {}, { signal: controller.signal,
    fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
  await delay(0);
  controller.abort();
  await assert.rejects(probe, { name: "AbortError" });
  assert.equal(cancelled, true);
});
