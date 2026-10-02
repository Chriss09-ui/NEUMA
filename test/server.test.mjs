import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createRequestHandler } from "../server.mjs";
import { emptyDraft, ProviderError } from "../core.mjs";

function request(method, url, body) {
  const input = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  input.method = method;
  input.url = url;
  input.headers = body === undefined ? {} : { "content-type": "application/json" };
  return input;
}

async function invoke(handler, method, url, body) {
  const result = { status: null, headers: null, text: "" };
  const response = {
    writeHead(status, headers) { result.status = status; result.headers = headers; },
    end(content) { result.text = content?.toString() ?? ""; },
  };
  await handler(request(method, url, body), response);
  return result;
}

test("本地服务提供测试页面、配置状态和需求接口", async () => {
  const draft = emptyDraft();
  draft.goal = { value: "整理会议纪要", source: "user" };
  draft.scenario = { value: "会议结束后", source: "inferred" };
  draft.inputSource = { value: "用户提供的转写", source: "user" };
  draft.task = { value: "提取结论与待办", source: "user" };
  draft.deliverable = { value: "结论与待办", source: "user" };
  const handler = createRequestHandler({
    config: { llmConfigured: true, jevConfigured: false, jevModel: "jev-1.13.0" },
    providers: { generateDraft: async () => ({ draft, proposedGap: "none", question: "" }), judgeJev: null },
  });
  const page = await invoke(handler, "GET", "/");
  assert.equal(page.status, 200);
  assert.match(page.text, /需求层测试版/);
  assert.match(page.text, /id="agents-list"/);
  assert.match(page.text, /id="reset"[^>]*>＋ 新对话/);
  assert.match(page.text, /id="diagnostics"[^>]*>导出诊断记录/);

  const health = JSON.parse((await invoke(handler, "GET", "/api/health")).text);
  assert.equal(health.llmConfigured, true);
  assert.equal(health.jevConfigured, false);
  assert.equal("apiKey" in health, false);

  const response = await invoke(handler, "POST", "/api/requirements/turn", { message: "整理会议纪要" });
  assert.equal(response.status, 200);
  const result = JSON.parse(response.text);
  assert.equal(result.status, "ready");
  assert.equal(result.question, null);
  assert.match(result.confirmationQuestion, /这份需求可以确认吗/);
  assert.equal(result.diagnostic.decision.selectedGap, "none");
  assert.equal(result.diagnostic.providerModel, null);
});

test("失败响应提供安全错误类别，不输出密钥或原始接口响应", async () => {
  const handler = createRequestHandler({
    config: { model: "mimo-v2.6-pro", llmConfigured: true, jevConfigured: false },
    providers: { generateDraft: async () => {
      throw new ProviderError("兼容模型域名暂时无法解析",
        { stage: "llm", reason: "dns", attempts: 3, causeCode: "ENOTFOUND" });
    }, judgeJev: null },
  });
  const response = await invoke(handler, "POST", "/api/requirements/turn",
    { message: "做一个助手" });
  const payload = JSON.parse(response.text);
  assert.equal(response.status, 502);
  assert.deepEqual(payload.diagnostic, { stage: "llm", reason: "dns",
    attempts: 3, causeCode: "ENOTFOUND", providerModel: "mimo-v2.6-pro" });
  assert.equal("draft" in payload, false);
});
