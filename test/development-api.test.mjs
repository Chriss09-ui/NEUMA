import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { createRequestHandler } from "../server.mjs";
import { InputError, ProviderError } from "../core.mjs";

const development = { id: "dev-one", agentId: "agent-one", status: "completed", phase: "packaging",
  architectureRef: { version: 2, candidateHash: "candidate-2" }, delivery: "needs_connection", summary: "研发已完成，等待连接。", tasks: [] };
const architecture = { agentId: "agent-one", status: "passed", delivery: "needs_connection", version: 2, candidateHash: "candidate-2" };
const result = { agent: null, architecture, development };
const path = "/api/agents/agent-one/development";

function input(method, url, body, headers = {}) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]);
  Object.assign(request, { method, url, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers } });
  return request;
}

class ResponseSink extends EventEmitter {
  text = ""; writableEnded = false; destroyed = false;
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  write(content) { this.text += content; }
  end(content = "") { this.text += content; this.writableEnded = true; }
  events() { return this.text.trim().split("\n").filter(Boolean).map(JSON.parse); }
}

function handler(agents = {}) {
  return createRequestHandler({ config: { model: "development-api-fixture" }, providers: {},
    projects: { dispose: async () => {} }, projectAgent: { dispose: async () => {} },
    prototypeAgents: { get: async () => null, getArchitecture: async () => architecture,
      getDevelopment: async () => development, close: async () => {}, ...agents } });
}

async function invoke(handle, method, url, body, headers) {
  const response = new ResponseSink(); await handle(input(method, url, body, headers), response); return response;
}

function deferred() {
  let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve };
}

test("研发JSON入口使用路径Agent身份，默认新建、显式恢复并保留未就绪终态", async () => {
  const seen = [];
  const handle = handler({ develop: async (id, options) => {
    seen.push({ id, resume: options.resume }); assert.equal(options.signal.aborted, false);
    assert.equal(typeof options.onProgress, "function"); return result;
  } });
  for (const [body, resume] of [[{}, false], [{ resume: true }, true], [{ resume: false }, false]]) {
    const response = await invoke(handle, "POST", path, body);
    assert.equal(response.status, 200); assert.match(response.headers["content-type"], /application\/json/);
    assert.deepEqual(JSON.parse(response.text), result); assert.equal(response.listenerCount("close"), 0);
    assert.deepEqual(seen.at(-1), { id: "agent-one", resume });
  }
});

test("研发流可由专属路径或Accept开启，完成前只发送真实阶段进度", async (t) => {
  for (const [url, headers] of [[`${path}/stream`, {}], [path, { accept: "application/x-ndjson" }]]) {
    const entered = deferred(), release = deferred(); t.after(() => release.resolve());
    const progress = { type: "status", phase: "verifying", label: "正在检查验收", development: { ...development, status: "running" } };
    const handle = handler({ develop: async (id, { resume, signal, onProgress }) => {
      assert.equal(id, "agent-one"); assert.equal(resume, true); assert.equal(signal.aborted, false);
      onProgress(progress); entered.resolve(); await release.promise; return result;
    } });
    const response = new ResponseSink(), pending = handle(input("POST", url, { resume: true }, headers), response);
    await entered.promise;
    assert.equal(response.status, 200); assert.match(response.headers["content-type"], /application\/x-ndjson/);
    assert.deepEqual(response.events(), [progress]); assert.equal(response.writableEnded, false);
    release.resolve(); await pending;
    assert.deepEqual(response.events().at(-1), { type: "done", result });
    assert.equal(response.listenerCount("close"), 0);
  }
});

test("研发GET只查询且详情含独立研发记录，GET取消或流路径不能触发写操作", async () => {
  const seen = [];
  const handle = handler({ get: async (id) => { seen.push(["get", id]); return null; },
    getArchitecture: async (id) => { seen.push(["architecture", id]); return architecture; },
    getDevelopment: async (id) => { seen.push(["development", id]); return id === "absent" ? null : development; },
    develop: async () => assert.fail("GET不能开始研发"), cancelDevelopment: async () => assert.fail("GET不能取消研发") });
  assert.deepEqual(JSON.parse((await invoke(handle, "GET", path)).text), { development });
  assert.deepEqual(JSON.parse((await invoke(handle, "GET", "/api/agents/agent-one")).text), result);
  assert.deepEqual(JSON.parse((await invoke(handle, "GET", "/api/agents/absent/development")).text), { development: null });
  const reads = seen.length;
  for (const url of [`${path}/cancel`, `${path}/stream`]) assert.equal((await invoke(handle, "GET", url)).status, 404);
  assert.equal(seen.length, reads);
  assert.deepEqual(seen, [["development", "agent-one"], ["get", "agent-one"], ["architecture", "agent-one"],
    ["development", "agent-one"], ["development", "absent"]]);
});

test("研发停止只取消对应Agent，原样返回已持久化状态", async () => {
  const cancelled = { ...development, status: "cancelled", delivery: "blocked" }, ids = [];
  const handle = handler({ cancelDevelopment: async (id) => { ids.push(id); return { cancelled: true, development: cancelled }; },
    develop: async () => assert.fail("取消不能重新进入研发"), cancel: async () => assert.fail("不能误取消工作Agent聊天") });
  const response = await invoke(handle, "POST", `${path}/cancel`, {});
  assert.equal(response.status, 200); assert.deepEqual(JSON.parse(response.text), { cancelled: true, development: cancelled });
  assert.deepEqual(ids, ["agent-one"]);
});

test("研发入口拒绝非法JSON、非布尔恢复参数和额外授权字段，拒绝跨站请求", async () => {
  let mutations = 0;
  const handle = handler({ develop: async () => { mutations++; }, cancelDevelopment: async () => { mutations++; } });
  for (const suffix of ["", "/stream", "/cancel"]) {
    for (const body of ["{broken", "null", "[]", { resume: "true" }, { resume: 1 }, { resume: null },
      { agentId: "another" }, { resume: true, tools: ["bash"] }, { ignoreValidation: true }]) {
      const response = await invoke(handle, "POST", path + suffix, body);
      assert.equal(response.status, 400); assert.equal(JSON.parse(response.text).diagnostic.reason, "invalid_request");
    }
  }
  for (const headers of [{ host: "127.0.0.1:3010", origin: "https://example.invalid" },
    { host: "outside.invalid" }, { "sec-fetch-site": "cross-site" }]) {
    assert.equal((await invoke(handle, "POST", path, {}, headers)).status, 403);
  }
  for (const url of ["/api/agents/one%2Ftwo/development", "/api/agents/agent-one/development/unknown"])
    assert.equal((await invoke(handle, "POST", url, {})).status, 404);
  assert.equal(mutations, 0);
});

test("研发JSON与流断线中止本次signal，迟到进度和成功均不发送", { timeout: 3000 }, async () => {
  for (const streaming of [false, true]) {
    const entered = deferred(); let signal;
    const handle = handler({ develop: async (_id, options) => {
      signal = options.signal; entered.resolve();
      await new Promise((done) => signal.addEventListener("abort", done, { once: true }));
      options.onProgress({ type: "status", phase: "packaging", label: "迟到进度" }); return result;
    } });
    const response = new ResponseSink(), pending = handle(input("POST", path + (streaming ? "/stream" : ""), {}), response);
    await entered.promise; response.destroyed = true; response.emit("close"); await pending;
    assert.equal(signal.aborted, true); assert.equal(response.text, ""); assert.equal(response.listenerCount("close"), 0);
  }
});

test("研发错误沿用安全响应，错误流不发送done或内部异常原文", async () => {
  for (const [error, status, reason] of [[new InputError("请先完成架构评估"), 400, "invalid_request"],
    [new ProviderError("模型连接中断", { stage: "development", reason: "connection" }), 502, "connection"],
    [new Error("PRIVATE_DEVELOPMENT_IMPLEMENTATION"), 500, "internal_error"]]) {
    const handle = handler({ develop: async () => { throw error; } });
    const json = await invoke(handle, "POST", path, {});
    assert.equal(json.status, status); assert.equal(JSON.parse(json.text).diagnostic.reason, reason);
    const stream = await invoke(handle, "POST", `${path}/stream`, {});
    assert.equal(stream.status, 200); assert.equal(stream.events().at(-1).type, "error");
    assert.equal(stream.events().at(-1).diagnostic.reason, reason);
    assert.equal(stream.events().some((event) => event.type === "done"), false);
    assert.doesNotMatch(json.text + stream.text, /PRIVATE_DEVELOPMENT_IMPLEMENTATION/);
  }
});
