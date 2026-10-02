import test from "node:test";
import assert from "node:assert/strict";
import { getProviderConfig, makeProviders } from "../providers.mjs";
import { ProviderError } from "../core.mjs";

const config = {
  chatUrl: "https://example.test/v1/chat/completions",
  model: "example-model",
  apiKey: "test-key",
  jevApiKey: "test-jev-key",
  jevModel: "jev-1.13.0",
  llmConfigured: true,
  jevConfigured: true,
};

test("兼容模型返回无效 JSON 时报告错误", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }), {
    status: 200, headers: { "content-type": "application/json" },
  });
  const { generateDraft } = makeProviders(config, fetchImpl);
  await assert.rejects(generateDraft({ message: "创建助手", previousDraft: {}, lastQuestion: "" }), ProviderError);
});

test("Pro 请求默认等待 90 秒，并允许合理范围内配置", () => {
  assert.equal(getProviderConfig({}).llmTimeoutMs, 90_000);
  assert.equal(getProviderConfig({ NEUMA_LLM_TIMEOUT_MS: "120000" }).llmTimeoutMs, 120_000);
  assert.equal(getProviderConfig({ NEUMA_LLM_TIMEOUT_MS: "999999" }).llmTimeoutMs, 90_000);
});

test("通用兼容接口的连接失败与整体超时给出不同提示", async () => {
  let calls = 0;
  const connectionFailed = async () => { calls += 1; throw new TypeError("fetch failed"); };
  await assert.rejects(makeProviders(config, connectionFailed).generateDraft({
    message: "做周报助手", previousDraft: {}, lastQuestion: "",
  }), /兼容模型连接失败，本轮输入已保留/);
  assert.equal(calls, 1);

  const timedOut = async () => { throw new DOMException("timed out", "TimeoutError"); };
  await assert.rejects(makeProviders({ ...config, llmTimeoutMs: 10_000 }, timedOut).generateDraft({
    message: "做周报助手", previousDraft: {}, lastQuestion: "",
  }), /兼容模型响应超过 10 秒/);
});

test("连接阶段超时、响应正文中断和鉴权失败分别报告", async () => {
  const connectTimeout = async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } });
  };
  await assert.rejects(makeProviders(config, connectTimeout).generateDraft({
    message: "做周报助手", previousDraft: {}, lastQuestion: "",
  }), /兼容模型连接超时/);

  const interruptedBody = async () => ({ ok: true,
    text: async () => { throw new DOMException("aborted", "AbortError"); } });
  await assert.rejects(makeProviders(config, interruptedBody).generateDraft({
    message: "做周报助手", previousDraft: {}, lastQuestion: "",
  }), /兼容模型连接中断/);

  const unauthorized = async () => new Response("", { status: 401 });
  await assert.rejects(makeProviders(config, unauthorized).generateDraft({
    message: "做周报助手", previousDraft: {}, lastQuestion: "",
  }), /鉴权失败（HTTP 401）/);
});

test("MiMo 的暂时性连接失败会在同一轮自动恢复", async () => {
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls += 1;
    assert.equal(init.signal.aborted, false);
    if (calls === 1) {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"draft":{}}' } }] }), {
      status: 200,
    });
  };
  const provider = makeProviders({ ...config,
    chatUrl: "https://api.xiaomimimo.com/v1/chat/completions" }, fetchImpl);
  const result = await provider.generateDraft({ message: "做周报助手", previousDraft: {}, lastQuestion: "" });
  assert.deepEqual(result.draft, {});
  assert.equal(calls, 2);
});

test("MiMo 连续连接失败最多请求三次，使用同一总时限并给出具体原因", async () => {
  let calls = 0;
  let firstSignal;
  const fetchImpl = async (_url, init) => {
    calls += 1;
    firstSignal ??= init.signal;
    assert.equal(init.signal, firstSignal);
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
  };
  const provider = makeProviders({ ...config,
    chatUrl: "https://api.xiaomimimo.com/v1/chat/completions" }, fetchImpl);
  await assert.rejects(provider.generateDraft({
    message: "做周报助手", previousDraft: {}, lastQuestion: "",
  }), (error) => {
    assert.match(error.message, /域名暂时无法解析（已自动重试 2 次），本轮输入已保留/);
    assert.deepEqual(error.diagnostic, { stage: "llm", reason: "dns",
      attempts: 3, causeCode: "ENOTFOUND" });
    assert.equal(JSON.stringify(error.diagnostic).includes("test-key"), false);
    return true;
  });
  assert.equal(calls, 3);
});

test("MiMo 的 503 可重试，鉴权失败与无效 JSON 不重试", async () => {
  let calls = 0;
  const url = "https://api.xiaomimimo.com/v1/chat/completions";
  const success = () => new Response(JSON.stringify({
    choices: [{ message: { content: '{"draft":{}}' } }],
  }), { status: 200 });
  const transient = async () => {
    calls += 1;
    return calls === 1 ? new Response("unavailable", { status: 503 }) : success();
  };
  await makeProviders({ ...config, chatUrl: url }, transient).generateDraft({
    message: "做周报助手", previousDraft: {}, lastQuestion: "",
  });
  assert.equal(calls, 2);

  for (const response of [new Response("", { status: 401 }),
    new Response(JSON.stringify({ choices: [{ message: { content: "invalid" } }] }))]) {
    calls = 0;
    const fetchImpl = async () => { calls += 1; return response; };
    await assert.rejects(makeProviders({ ...config, chatUrl: url }, fetchImpl).generateDraft({
      message: "做周报助手", previousDraft: {}, lastQuestion: "",
    }), ProviderError);
    assert.equal(calls, 1);
  }
});

test("小米 MiMo 使用 JSON 模式并关闭需求提取时的深度思考", async () => {
  let body;
  const fetchImpl = async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"draft":{}}' } }] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  const { generateDraft } = makeProviders({ ...config,
    chatUrl: "https://api.xiaomimimo.com/v1/chat/completions", model: "mimo-v2.6-pro" }, fetchImpl);
  await generateDraft({ message: "做周报助手", previousDraft: {}, lastQuestion: "" });
  assert.equal(body.model, "mimo-v2.6-pro");
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.match(body.messages[0].content, /scenario/);
  assert.match(body.messages[0].content, /routingCondition/);
});

test("其他兼容接口保持通用请求格式", async () => {
  let body;
  const fetchImpl = async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"draft":{}}' } }] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  const { generateDraft } = makeProviders(config, fetchImpl);
  await generateDraft({ message: "做周报助手", previousDraft: {}, lastQuestion: "" });
  assert.equal("response_format" in body, false);
  assert.equal("thinking" in body, false);
});

test("需求模型与 Jev 都以用户原话和上一问题核对草稿", async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"draft":{}}' } }], answers: {} }), { status: 200 });
  };
  const { generateDraft, judgeJev } = makeProviders(config, fetchImpl);
  const userMessages = ["帮我读懂论文", "最难的是方法"];
  const lastQuestion = "先要简短要点还是详细解释？";
  await generateDraft({ message: "简短要点", previousDraft: {}, lastQuestion, userMessages });
  await judgeJev({ message: "简短要点", draft: {}, lastQuestion, userMessages });
  const modelContext = JSON.parse(bodies[0].messages[1].content);
  assert.deepEqual(modelContext.userMessages, userMessages);
  assert.equal(modelContext.lastQuestion, lastQuestion);
  assert.deepEqual(bodies[1].state.user_messages, userMessages);
  assert.equal(bodies[1].state.last_question, lastQuestion);
});

test("Jev 每轮只发一个含场景与任务判断的结构化请求", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, body: JSON.parse(init.body), authorization: init.headers.authorization };
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers: {} }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  const { judgeJev } = makeProviders(config, fetchImpl);
  await judgeJev({ message: "创建周报助手", draft: {} });
  assert.equal(seen.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(seen.body.model, "jev-1.13.0");
  assert.equal(Object.keys(seen.body.questions).length, 10);
  assert.equal(seen.body.questions.scenario_clear.type, "noul");
  assert.equal(seen.body.questions.task_clear.type, "noul");
  assert.equal(seen.body.questions.boundary_clear.type, "noul");
  assert.equal(seen.body.questions.next_gap.type, "choice");
  assert.equal(seen.authorization, "Bearer test-jev-key");
});
