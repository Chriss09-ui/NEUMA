import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
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
  assert.match(page.text, /id="sidebar-agent-list"/);
  assert.match(page.text, /id="page-agent"/);
  assert.match(page.text, /让主 Agent 帮我迭代/);
  const agentUi = await invoke(handler, "GET", "/agents.js");
  assert.equal(agentUi.status, 200);
  assert.match(agentUi.headers["content-type"], /javascript/);
  assert.equal((await invoke(handler, "GET", "/chat-ui.js")).status, 200);
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

class StreamingResponse extends EventEmitter {
  text = "";
  writableEnded = false;
  destroyed = false;
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  write(content) { this.text += content; }
  end(content = "") { this.text += content; this.writableEnded = true; }
}

test("项目流在整轮结束前送出进度，最后返回完整结果", async () => {
  let release, started;
  const hold = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { started = resolve; });
  const handler = createRequestHandler({ config: {}, projectAgent: {
    async prompt(body, progress) {
      progress({ type: "status", phase: "thinking" }); started();
      await hold;
      progress({ type: "text-delta", delta: "你好" });
      return { reply: "你好", projects: [], actions: [] };
    },
  } });
  const input = request("POST", "/api/projects/turn", { message: "你好", sessionId: "stream-session-12345" });
  input.headers.accept = "application/x-ndjson";
  const response = new StreamingResponse();
  const pending = handler(input, response);
  await ready;
  assert.equal(response.writableEnded, false);
  assert.match(response.headers["content-type"], /ndjson/);
  assert.equal(JSON.parse(response.text.trim()).phase, "thinking");
  release(); await pending;
  const events = response.text.trim().split("\n").map(JSON.parse);
  assert.equal(events[1].delta, "你好");
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.at(-1).result.reply, "你好");
});

test("流中异常只发送安全错误，不泄露 SDK 原始内容", async () => {
  const handler = createRequestHandler({ config: {}, projectAgent: { prompt: async () => { throw new Error("private-provider-payload"); } } });
  const input = request("POST", "/api/projects/turn", { message: "你好" }); input.headers.accept = "application/x-ndjson";
  const response = new StreamingResponse();
  await handler(input, response);
  assert.equal(response.text.includes("private-provider-payload"), false);
  assert.equal(JSON.parse(response.text).type, "error");
  assert.equal(response.writableEnded, true);
});

test("浏览器中断流会取消对应的项目会话", async () => {
  let started, finish;
  const ready = new Promise((resolve) => { started = resolve; });
  const cancelled = [];
  const handler = createRequestHandler({ config: {}, projectAgent: {
    async prompt() { started(); await new Promise((resolve) => { finish = resolve; }); return { reply: "已停止" }; },
    async cancel(id) { cancelled.push(id); finish(); },
  } });
  const input = request("POST", "/api/projects/turn", { message: "你好", sessionId: "stream-session-12345" }); input.headers.accept = "application/x-ndjson";
  const response = new StreamingResponse(), pending = handler(input, response);
  await ready;
  response.destroyed = true; response.emit("close");
  await pending;
  assert.deepEqual(cancelled, ["stream-session-12345"]);
  assert.equal(response.text, "");
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

test("项目接口拒绝外部网页请求与非本机 Host，不执行任何项目操作", async () => {
  let calls = 0;
  const handler = createRequestHandler({ config: {}, projects: { list: async () => { calls++; return []; } } });
  for (const headers of [
    { host: "127.0.0.1:3000", origin: "https://outside.example" },
    { host: "outside.example:3000" },
    { host: "127.0.0.1:3000", origin: "null" },
    { host: "127.0.0.1:3000", "sec-fetch-site": "cross-site" },
  ]) {
    const input = request("GET", "/api/projects"); input.headers = headers;
    const result = { status: null };
    await handler(input, { writeHead(status) { result.status = status; }, end() {} });
    assert.equal(result.status, 403);
  }
  assert.equal(calls, 0);
});

test("项目变更要求 JSON 和明确移除确认，项目对话使用独立接口", async () => {
  let removed = false;
  const handler = createRequestHandler({ config: {},
    projects: { list: async () => [], remove: async () => { removed = true; } },
    projectAgent: { prompt: async (body) => ({ engine: "pi", reply: body.message, projects: [] }) },
  });
  assert.equal((await invoke(handler, "POST", "/api/projects/test/remove", {})).status, 400);
  assert.equal(removed, false);
  assert.equal((await invoke(handler, "POST", "/api/projects/test/start")).status, 400);
  const result = await invoke(handler, "POST", "/api/projects/turn", { message: "查看项目", sessionId: "fixture-session-12345" });
  assert.equal(result.status, 200); assert.equal(JSON.parse(result.text).engine, "pi");
});
