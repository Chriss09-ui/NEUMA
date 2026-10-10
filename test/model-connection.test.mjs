import test from "node:test";
import assert from "node:assert/strict";
import { registerConnectionProbeTests } from "./helpers/connection-probe.mjs";
import { testModelConnection } from "../src/model-connection.mjs";
import { InputError, ProviderError } from "../src/requirements/core.mjs";

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
