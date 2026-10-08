import test from "node:test";
import assert from "node:assert/strict";
import { createTechnicalResearch, RESEARCH_PARAMETERS } from "../architecture-research.mjs";

const NOW = "2026-10-04T08:00:00.000Z";
const now = () => new Date(NOW);
const htmlResponse = (text = "实际获取的文档内容") => new Response(
  `<html><title>Fetched documentation</title><main>${text}</main></html>`,
  { headers: { "content-type": "text/html; charset=utf-8" } },
);

test("工具 schema 明确目录范围、允许主题和不可信证据边界", () => {
  assert.deepEqual(RESEARCH_PARAMETERS.required, ["query"]);
  assert.equal(RESEARCH_PARAMETERS.additionalProperties, false);
  assert.deepEqual(RESEARCH_PARAMETERS.properties.topics.items.enum, ["code", "sdk", "langchain", "langgraph"]);
  assert.match(RESEARCH_PARAMETERS.description, /不是全网搜索/);
  assert.match(RESEARCH_PARAMETERS.description, /不可信外部证据/);
});

test("按查询实时读取官方文档，提取正文且保留稳定来源和版本范围", async () => {
  const calls = [];
  const research = createTechnicalResearch({ now, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return htmlResponse('<nav>navigation</nav><script>doBadThings()</script><STYLE>.hide{}</STYLE><p>session &amp; tools &#x4e2d;&#25991;</p><footer>footer</footer>');
  } });
  const result = await research.search({ query: "Pi SDK 会话和工具" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://pi.dev/docs/latest/sdk");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(calls[0].init.signal.aborted, false);
  assert.deepEqual(result.sources, [{ id: "pi-sdk", url: calls[0].url,
    title: "Fetched documentation", retrievedAt: NOW,
    versionScope: "Pi latest 文档；未核实与项目锁定的 SDK 版本兼容。", excerpt: "session & tools 中文" }]);
  assert.match(result.gaps.join(" "), /仅覆盖 Pi/);
  assert.equal(JSON.stringify(calls).includes("Pi SDK 会话和工具"), false);
});

test("优先选择指定主题，并按持久化查询调整 LangGraph 页面顺序", async () => {
  const calls = [];
  const research = createTechnicalResearch({ now, fetchImpl: async (url) => {
    calls.push(url);
    return htmlResponse();
  } });
  const result = await research.search({ query: "SDK 如何实现持久化？", topics: ["langgraph"] });
  assert.deepEqual(result.sources.map((source) => source.id), ["langgraph-js-persistence", "langgraph-js-overview"]);
  assert.ok(calls.every((url) => url.startsWith("https://docs.langchain.com/oss/javascript/langgraph/")));
});

test("跨主题检索单次最多三页，并说明未检索的候选", async () => {
  let calls = 0;
  const research = createTechnicalResearch({ now, fetchImpl: async () => { calls += 1; return htmlResponse(); } });
  const result = await research.search({ query: "技术比较", topics: ["code", "sdk", "langchain", "langgraph"] });
  assert.equal(calls, 3);
  assert.deepEqual(result.sources.map((source) => source.id), ["nodejs-globals", "pi-sdk", "langchain-js-overview"]);
  assert.match(result.gaps.join(" "), /最多检索 3 页.*LangGraph/);
});

test("没有匹配时不请求网络，也不返回静态简介作为证据", async () => {
  const research = createTechnicalResearch({ fetchImpl: async () => { assert.fail("不得请求网络"); } });
  const result = await research.search({ query: "比较餐厅预约方案" });
  assert.deepEqual(result.sources, []);
  assert.match(result.gaps.join(" "), /没有匹配资料/);
});

test("用户网址不会成为请求地址，额外参数和无效主题也不能扩大目录", async () => {
  const calls = [];
  const research = createTechnicalResearch({ now, fetchImpl: async (url) => { calls.push(url); return htmlResponse(); } });
  await research.search({ query: "请查 http://localhost:8080/sdk 和 https://example.test/token", topics: ["sdk"] });
  assert.deepEqual(calls, ["https://pi.dev/docs/latest/sdk"]);
  for (const input of [{ query: "sdk", url: "http://localhost" }, { query: "sdk", topics: ["http://localhost"] },
    { query: "sdk", topics: [] }, { query: "sdk", topics: ["sdk", "sdk"] }, { query: " " },
    { query: "x".repeat(1001) }, null]) {
    await assert.rejects(research.search(input), TypeError);
  }
  assert.equal(calls.length, 1);
});

test("HTTP 与传输失败如实成为证据缺口，保留其他成功来源且不泄露异常详情", async () => {
  const research = createTechnicalResearch({ now, fetchImpl: async (url) => {
    if (url.includes("nodejs")) return new Response("server error", { status: 503 });
    if (url.includes("pi.dev")) throw new Error("private credential in transport message");
    return htmlResponse("可验证内容");
  } });
  const result = await research.search({ query: "选型", topics: ["code", "sdk", "langchain"] });
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].id, "langchain-js-overview");
  assert.match(result.gaps.join(" "), /HTTP 503/);
  assert.match(result.gaps.join(" "), /请求或正文读取失败/);
  assert.doesNotMatch(JSON.stringify(result), /private credential/);
});

test("拒绝重定向状态、已跟随的重定向和不匹配的最终地址", async () => {
  for (const response of [new Response("", { status: 302, headers: { location: "http://localhost" } }),
    Object.defineProperty(htmlResponse(), "redirected", { value: true }),
    Object.defineProperty(htmlResponse(), "url", { value: "https://example.test/redirected" })]) {
    const research = createTechnicalResearch({ fetchImpl: async () => response });
    const result = await research.search({ query: "sdk" });
    assert.deepEqual(result.sources, []);
    assert.match(result.gaps.join(" "), /重定向/);
  }
});

test("不支持的媒体和无正文不作为有效来源", async () => {
  for (const response of [new Response("binary", { headers: { "content-type": "image/png" } }), htmlResponse("<script>onlyScript()</script>")]) {
    const research = createTechnicalResearch({ fetchImpl: async () => response });
    const result = await research.search({ query: "sdk" });
    assert.deepEqual(result.sources, []);
    assert.match(result.gaps.join(" "), /正文/);
  }
});

test("响应头声明超过上限时取消正文，未知长度的超大流也会终止", async () => {
  for (const declared of [true, false]) {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      start(controller) {
        if (!declared) controller.enqueue(new Uint8Array(1024 * 1024 + 1));
      },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/plain", ...(declared ? { "content-length": String(1024 * 1024 + 1) } : {}) } });
    const research = createTechnicalResearch({ fetchImpl: async () => response });
    const result = await research.search({ query: "sdk" });
    assert.deepEqual(result.sources, []);
    assert.match(result.gaps.join(" "), /1 MiB/);
    assert.equal(cancelled, true);
  }
});

test("限长摘录明确标注截断，文本来源也由实际响应产生", async () => {
  const research = createTechnicalResearch({ now, fetchImpl: async () => new Response("a".repeat(7000), {
    headers: { "content-type": "text/markdown" },
  }) });
  const result = await research.search({ query: "sdk" });
  assert.equal(result.sources[0].excerpt.length, 6000);
  assert.equal(result.sources[0].title, "Pi SDK");
  assert.match(result.gaps.join(" "), /仅返回前 6000 字符/);
});

test("取消发生在请求前或请求等待中时抛出 AbortError", async () => {
  const before = new AbortController();
  before.abort();
  let calls = 0;
  const research = createTechnicalResearch({ fetchImpl: async () => { calls += 1; return new Promise(() => {}); } });
  await assert.rejects(research.search({ query: "sdk" }, { signal: before.signal }), { name: "AbortError" });
  assert.equal(calls, 0);
  const during = new AbortController();
  const pending = research.search({ query: "sdk" }, { signal: during.signal });
  during.abort(new Error("caller reason"));
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(calls, 1);
});

test("读取正文时取消能中止等待，并释放响应流", async () => {
  const controller = new AbortController();
  let cancelled = false;
  let notifyReading;
  const reading = new Promise((resolve) => { notifyReading = resolve; });
  const response = new Response(new ReadableStream({ pull() { notifyReading(); }, cancel() { cancelled = true; } }), {
    headers: { "content-type": "text/html" },
  });
  const research = createTechnicalResearch({ fetchImpl: async () => response });
  const pending = research.search({ query: "sdk" }, { signal: controller.signal });
  await reading;
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(cancelled, true);
});

test("请求返回拒绝的同时发生取消时，不遗留未处理拒绝", async () => {
  const controller = new AbortController();
  const research = createTechnicalResearch({ fetchImpl: () => {
    controller.abort();
    return Promise.reject(new DOMException("aborted", "AbortError"));
  } });
  await assert.rejects(research.search({ query: "sdk" }, { signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(research.search({ query: "sdk" }, { signal: {} }), TypeError);
});

test("15 秒总时限中止无响应请求，并且不再启动剩余来源", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const research = createTechnicalResearch({ fetchImpl: async () => { calls += 1; return new Promise(() => {}); } });
  const pending = research.search({ query: "LangGraph" });
  t.mock.timers.tick(15_000);
  const result = await pending;
  assert.equal(calls, 1);
  assert.deepEqual(result.sources, []);
  assert.equal(result.gaps.filter((gap) => gap.includes("15 秒")).length, 2);
});
