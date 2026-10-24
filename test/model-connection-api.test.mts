import type { RequestHandlerOptions } from "../src/server.mjs";
import type { IncomingHttpHeaders } from "node:http";
import type { ServerAgents } from "../src/server-port.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequestHandler, type RequestHandler } from "../src/server.mjs";
import { InputError, ProviderError } from "../src/requirements/core.mjs";

const deferred = () => { let resolve!: (value?: unknown) => void; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const handler = (options: RequestHandlerOptions = {}) => createRequestHandler({ config: {}, providers: {}, projects: {}, skillManager: {}, projectAgent: {}, prototypeAgents: {}, ...options });
const body = { chatUrl: "https://example.test/v1/chat/completions", model: "unsaved-model", apiKey: "synthetic-new-key" };

function request(method: string, url: string, value: unknown = undefined, headers: IncomingHttpHeaders = {}) {
  const input = Object.assign(Readable.from(value === undefined ? [] : [Buffer.from(JSON.stringify(value))]), { headers: {} as IncomingHttpHeaders, method, url });
  Object.assign(input, { method, url, headers: { ...(value === undefined ? {} : { "content-type": "application/json" }), ...headers } });
  return input;
}

class Response extends EventEmitter {
  declare status: number | undefined; declare headers: Record<string, unknown>;

  text = ""; writableEnded = false; destroyed = false;
  writeHead(status: number, headers: Record<string, unknown>) { this.status = status; this.headers = headers; }
  end(content = "") { this.text += content; this.writableEnded = true; }
  destroy() { this.destroyed = true; }
}

async function invoke(app: RequestHandler, method: string, url: string, value: unknown = undefined, headers: IncomingHttpHeaders = {}) {
  const response = new Response();
  await app(request(method, url, value, headers), response);
  return { status: response.status, text: response.text, json: response.text ? JSON.parse(String(response.text)) : null };
}

test("连接测试转发当前草稿与已存配置，返回模型和耗时但不保存或重建 Agent", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "neuma-model-test-api-")), envPath = join(dir, "fixture-config.txt");
  const original = "# synthetic settings fixture\nNEUMA_LLM_MODEL=saved-model\n";
  await writeFile(envPath, original);
  const config = { chatUrl: "https://saved.example.test/v1/chat/completions", model: "saved-model", apiKey: "synthetic-saved-key", llmConfigured: true };
  const before = structuredClone(config), calls: { active: unknown; input: unknown; signal: AbortSignal }[] = []; let closed = 0;
  const app = handler({ config, envPath, projectAgent: { dispose: async () => { closed++; } }, prototypeAgents: { close: async () => { closed++; } },
    modelConnectionTester: async (active: unknown, input: { model: unknown; }, options: { signal: AbortSignal }) => {
      calls.push({ active, input, signal: options.signal });
      return { ok: true, model: input.model, latencyMs: 125 };
    } });
  t.after(async () => { await app.dispose(); await rm(dir, { recursive: true, force: true }); });
  const result = await invoke(app, "POST", "/api/settings/test-model", body);
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { ok: true, model: "unsaved-model", latencyMs: 125 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.active, before);
  assert.deepEqual(calls[0]!.input, body);
  assert.equal(calls[0]!.signal.aborted, false);
  assert.deepEqual(config, before);
  assert.equal(closed, 0);
  assert.equal(await readFile(envPath, "utf8"), original);
  assert.deepEqual(await readdir(dir), ["fixture-config.txt"]);
  assert.doesNotMatch(result.text, /synthetic-(?:new|saved)-key/);
  const saved = await invoke(app, "GET", "/api/settings");
  assert.equal(saved.json.model, "saved-model");
});

test("省略新 Key 时把已保存 Key 留在服务端配置中交由测试服务选择", async (t) => {
  const config = { model: "saved-model", apiKey: "synthetic-saved-key" }; let seen;
  const app = handler({ config, modelConnectionTester: async (active: unknown, input: { model: unknown; }) => {
    seen = { active, input }; return { ok: true, model: input.model, latencyMs: 50 };
  } });
  t.after(() => app.dispose());
  const input = { chatUrl: body.chatUrl, model: "draft-model" };
  const result = await invoke(app, "POST", "/api/settings/test-model", input);
  assert.equal(result.status, 200);
  assert.equal(seen!.active!.apiKey, "synthetic-saved-key");
  assert.deepEqual(seen!.input!, input);
  assert.equal(Object.hasOwn(seen!.input!, "apiKey"), false);
  assert.doesNotMatch(result.text, /synthetic-saved-key/);
});

test("测试接口继承本机来源保护，非 POST 不触发模型测试", async (t) => {
  let calls = 0;
  const app = handler({ modelConnectionTester: () => { calls++; assert.fail("被拒请求不能执行模型测试"); } });
  t.after(() => app.dispose());
  for (const headers of [
    { host: "127.0.0.1:3000", origin: "https://elsewhere.example.test" },
    { host: "elsewhere.example.test:3000" },
    { host: "127.0.0.1:3000", "sec-fetch-site": "cross-site" },
  ]) assert.equal((await invoke(app, "POST", "/api/settings/test-model", body, headers)).status, 403);
  for (const method of ["GET", "DELETE", "PUT"])
    assert.equal((await invoke(app, method, "/api/settings/test-model", body)).status, 404);
  assert.equal(calls, 0);
});

test("测试接口拒绝非 JSON、无效对象和超过 8 KiB 的请求", async (t) => {
  let calls = 0;
  const app = handler({ modelConnectionTester: () => { calls++; assert.fail("无效请求不能执行模型测试"); } });
  t.after(() => app.dispose());
  assert.equal((await invoke(app, "POST", "/api/settings/test-model", undefined)).status, 400);
  for (const invalid of [null, [], "text", { ...body, extra: "x".repeat(8192) }])
    assert.equal((await invoke(app, "POST", "/api/settings/test-model", invalid)).status, 400);
  const input = Object.assign(Readable.from([Buffer.from("{broken")]), { headers: {} as IncomingHttpHeaders, method: "POST", url: "/api/settings/test-model" });
  Object.assign(input, { method: "POST", url: "/api/settings/test-model", headers: { "content-type": "application/json" } });
  const response = new Response(); await app(input, response);
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

test("测试错误遵循安全响应，输入错误可见而内部异常不暴露", async (t) => {
  let calls = 0;
  const app = handler({ modelConnectionTester: () => {
    if (++calls === 1) throw new InputError("请填写模型名");
    throw new Error("synthetic-private-provider-payload");
  } });
  t.after(() => app.dispose());
  const inputError = await invoke(app, "POST", "/api/settings/test-model", body);
  assert.equal(inputError.status, 400);
  assert.equal(inputError.json.error, "请填写模型名");
  const failure = await invoke(app, "POST", "/api/settings/test-model", body);
  assert.equal(failure.status, 500);
  assert.doesNotMatch(failure.text, /synthetic-private-provider-payload/);
  assert.equal(typeof failure.json.error, "string");
});

test("页面断开会取消测试请求，迟到成功不会写入已关闭响应", async (t) => {
  const entered = deferred(), finish = deferred(); let signal!: AbortSignal;
  const app = handler({ modelConnectionTester: async (_config: unknown, _body: unknown, options: { signal: AbortSignal }) => {
    signal = options.signal; entered.resolve!(); return await finish.promise;
  } });
  t.after(() => app.dispose());
  const input = request("POST", "/api/settings/test-model", body), response = new Response();
  const running = app(input, response); await entered.promise;
  response.emit("close");
  assert.equal(signal!.aborted!, true);
  assert.equal(response.destroyed, true);
  finish.resolve!({ ok: true, model: "late-model", latencyMs: 999 }); await running;
  assert.equal(response.text, "");
  assert.equal(response.status, undefined);
});

test("服务关闭取消活动模型测试并等待结束，不发送伪成功", async () => {
  const entered = deferred(); let signal!: AbortSignal;
  const app = handler({ modelConnectionTester: async (_config: unknown, _body: unknown, options: { signal: AbortSignal; }) => {
    signal = options.signal; entered.resolve!();
    await new Promise((done) => signal.addEventListener("abort", done, { once: true }));
    signal.throwIfAborted();
  } });
  const response = new Response(), running = app(request("POST", "/api/settings/test-model", body), response);
  await entered.promise;
  await Promise.all([app.dispose(), running]);
  assert.equal(signal.aborted, true);
  assert.equal(response.text, "");
  assert.equal(response.status, undefined);
  assert.equal((await invoke(app, "POST", "/api/settings/test-model", body)).status, 503);
});

test("Jev 测试独立转发草稿，不依赖主模型配置、不写文件或重建 Agent", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "neuma-jev-test-api-")), envPath = join(dir, "fixture-config.txt");
  const original = "# synthetic Jev settings fixture\nTYPESAFE_MODEL=saved-judge\n";
  await writeFile(envPath, original);
  const config = { chatUrl: "", model: "", apiKey: "", llmConfigured: false,
    jevModel: "saved-judge", jevApiKey: "synthetic-saved-jev-key", jevConfigured: true };
  const before = structuredClone(config), input = { jevModel: "draft-judge", jevApiKey: "synthetic-draft-jev-key" }; let seen, closed = 0;
  const app = handler({ config, envPath,
    projectAgent: { dispose: async () => { closed++; } }, prototypeAgents: { close: async () => { closed++; } },
    modelConnectionTester: () => assert.fail("Jev 测试不能调用主模型测试"),
    jevConnectionTester: async (active: unknown, draft: { jevModel: unknown; }, options: { signal: AbortSignal }) => {
      seen = { active, draft, signal: options.signal };
      return { ok: true, model: draft.jevModel, latencyMs: 80 };
    } });
  t.after(async () => { await app.dispose(); await rm(dir, { recursive: true, force: true }); });
  const result = await invoke(app, "POST", "/api/settings/test-jev", input);
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { ok: true, model: "draft-judge", latencyMs: 80 });
  assert.deepEqual(seen!.active!, before);
  assert.deepEqual(seen!.draft!, input);
  assert.equal(seen!.signal!.aborted, false);
  assert.deepEqual(config, before);
  assert.equal(closed, 0);
  assert.equal(await readFile(envPath, "utf8"), original);
  assert.deepEqual(await readdir(dir), ["fixture-config.txt"]);
  assert.doesNotMatch(result.text, /synthetic-(?:saved|draft)-jev-key/);
});

test("Jev 测试保留 Key 留空与清除意图给测试服务，运行配置保持原值", async (t) => {
  const config = { jevModel: "saved-judge", jevApiKey: "synthetic-saved-jev-key" }, calls: { active: unknown; input: unknown; }[] = [];
  const app = handler({ config, jevConnectionTester: async (active: unknown, input: { jevModel: unknown; }) => {
    calls.push({ active: structuredClone(active), input });
    return { ok: true, model: input.jevModel, latencyMs: 10 };
  } });
  t.after(() => app.dispose());
  for (const input of [
    { jevModel: "draft-judge" },
    { jevModel: "draft-judge", clear: ["jevApiKey"] },
    { jevModel: "draft-judge", jevApiKey: "synthetic-new-jev-key" },
  ]) {
    assert.equal((await invoke(app, "POST", "/api/settings/test-jev", input)).status, 200);
    assert.deepEqual(calls.at(-1)!.input, input);
    assert.deepEqual(calls.at(-1)!.active, config);
    assert.equal(config.jevApiKey, "synthetic-saved-jev-key");
  }
});

test("Jev 测试接口继承本机来源、JSON 与 8 KiB 限制，其他方法不触发测试", async (t) => {
  let calls = 0;
  const app = handler({ jevConnectionTester: () => { calls++; assert.fail("被拒请求不能执行 Jev 测试"); } });
  t.after(() => app.dispose());
  const input = { jevModel: "draft-judge" };
  for (const headers of [
    { host: "127.0.0.1:3000", origin: "https://elsewhere.example.test" },
    { host: "elsewhere.example.test:3000" },
    { host: "127.0.0.1:3000", "sec-fetch-site": "cross-site" },
  ]) assert.equal((await invoke(app, "POST", "/api/settings/test-jev", input, headers)).status, 403);
  for (const method of ["GET", "PUT", "DELETE"])
    assert.equal((await invoke(app, method, "/api/settings/test-jev", input)).status, 404);
  for (const invalid of [undefined, null, [], "text", { jevModel: "x".repeat(8192) }])
    assert.equal((await invoke(app, "POST", "/api/settings/test-jev", invalid)).status, 400);
  assert.equal(calls, 0);
});

test("Jev 测试输入错误可见，未预期异常不暴露内部信息", async (t) => {
  let calls = 0;
  const app = handler({ jevConnectionTester: () => {
    if (++calls === 1) throw new InputError("请填写 Jev API Key");
    throw new Error("synthetic-private-jev-payload");
  } });
  t.after(() => app.dispose());
  const inputError = await invoke(app, "POST", "/api/settings/test-jev", { jevModel: "draft-judge" });
  assert.equal(inputError.status, 400);
  assert.equal(inputError.json.error, "请填写 Jev API Key");
  const failure = await invoke(app, "POST", "/api/settings/test-jev", { jevModel: "draft-judge" });
  assert.equal(failure.status, 500);
  assert.doesNotMatch(failure.text, /synthetic-private-jev-payload/);
  assert.equal(typeof failure.json.error, "string");
});

test("页面断开会取消 Jev 请求，迟到返回不发送成功", async (t) => {
  const entered = deferred(), finish = deferred(); let signal!: AbortSignal;
  const app = handler({ jevConnectionTester: async (_config: unknown, _body: unknown, options: { signal: AbortSignal }) => {
    signal = options.signal; entered.resolve!(); return await finish.promise;
  } });
  t.after(() => app.dispose());
  const response = new Response(), running = app(request("POST", "/api/settings/test-jev", { jevModel: "draft-judge" }), response);
  await entered.promise; response.emit("close");
  assert.equal(signal!.aborted!, true);
  assert.equal(response.destroyed, true);
  finish.resolve!({ ok: true, model: "late-judge", latencyMs: 999 }); await running;
  assert.equal(response.text, "");
  assert.equal(response.status, undefined);
});

test("服务关闭取消活动 Jev 测试并等待退出", async () => {
  const entered = deferred(); let signal!: AbortSignal;
  const app = handler({ jevConnectionTester: async (_config: unknown, _body: unknown, options: { signal: AbortSignal; }) => {
    signal = options.signal; entered.resolve!();
    await new Promise((done) => signal.addEventListener("abort", done, { once: true }));
    signal.throwIfAborted();
  } });
  const response = new Response(), running = app(request("POST", "/api/settings/test-jev", { jevModel: "draft-judge" }), response);
  await entered.promise; await Promise.all([app.dispose(), running]);
  assert.equal(signal.aborted, true);
  assert.equal(response.text, "");
  assert.equal(response.status, undefined);
});

test("构建能力测试独立转发配置，不保存配置或重建 Agent", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "neuma-agent-model-test-api-")), envPath = join(dir, "fixture-config.txt");
  const original = "NEUMA_LLM_MODEL=saved-model\n"; await writeFile(envPath, original);
  const config = { model: "saved-model", apiKey: "synthetic-saved-key" }, before = { ...config };
  let seen;
  const app = handler({ config, envPath,
    modelConnectionTester: () => assert.fail("构建能力测试不走短文字探针"),
    agentModelConnectionTester: async (active: unknown, input: { model: unknown; }, options: { signal: AbortSignal }) => {
      seen = { active, input, signal: options.signal };
      return { ok: true, model: input.model, latencyMs: 120, toolsCalled: 1, streaming: true, toolRoundTrip: true };
    } });
  t.after(async () => { await app.dispose(); await rm(dir, { recursive: true, force: true }); });
  const result = await invoke(app, "POST", "/api/settings/test-agent-model", body);
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { ok: true, model: body.model, latencyMs: 120, toolsCalled: 1, streaming: true, toolRoundTrip: true });
  assert.deepEqual(seen!.active!, before); assert.deepEqual(seen!.input!, body); assert.equal(seen!.signal!.aborted, false);
  assert.deepEqual(config, before); assert.equal(await readFile(envPath, "utf8"), original);
  assert.deepEqual(await readdir(dir), ["fixture-config.txt"]);
  assert.doesNotMatch(result.text, /synthetic-(?:new|saved)-key/);
});

test("构建能力测试继承本机来源、JSON 与请求大小保护，仅 POST 触发", async (t) => {
  let calls = 0;
  const app = handler({ agentModelConnectionTester: () => { calls++; assert.fail("被拒请求不能执行构建能力测试"); } });
  t.after(() => app.dispose());
  const path = "/api/settings/test-agent-model";
  for (const headers of [{ host: "127.0.0.1:3000", origin: "https://elsewhere.example.test" },
    { host: "elsewhere.example.test:3000" }, { host: "127.0.0.1:3000", "sec-fetch-site": "cross-site" }])
    assert.equal((await invoke(app, "POST", path, body, headers)).status, 403);
  for (const method of ["GET", "PUT", "DELETE"]) assert.equal((await invoke(app, method, path, body)).status, 404);
  for (const invalid of [undefined, null, [], "text", { model: "x".repeat(8192) }])
    assert.equal((await invoke(app, "POST", path, invalid)).status, 400);
  assert.equal(calls, 0);
});

test("构建能力测试返回安全诊断，内部错误不泄漏", async (t) => {
  let calls = 0;
  const app = handler({ agentModelConnectionTester: () => {
    if (++calls === 1) throw new ProviderError("模型未完成工具回传", { stage: "llm", reason: "tool_round_trip" });
    throw new Error("synthetic-private-agent-probe-payload");
  } });
  t.after(() => app.dispose());
  const failure = await invoke(app, "POST", "/api/settings/test-agent-model", body);
  assert.equal(failure.status, 502); assert.equal(failure.json.diagnostic.reason, "tool_round_trip");
  const internal = await invoke(app, "POST", "/api/settings/test-agent-model", body);
  assert.equal(internal.status, 500); assert.doesNotMatch(internal.text, /synthetic-private-agent-probe-payload/);
});

test("断开页面或关闭服务取消活动构建能力测试，迟到结果不发送成功", async () => {
  for (const mode of ["disconnect", "shutdown"]) {
    const entered = deferred(), finish = deferred(); let signal!: AbortSignal;
    const app = handler({ agentModelConnectionTester: async (_config: unknown, _body: unknown, options: { signal: AbortSignal; }) => {
      signal = options.signal; entered.resolve!();
      if (mode === "shutdown") {
        await new Promise((done) => signal.addEventListener("abort", done, { once: true }));
        signal.throwIfAborted();
      }
      return await finish.promise;
    } });
    const response = new Response(), running = app(request("POST", "/api/settings/test-agent-model", body), response);
    await entered.promise;
    if (mode === "disconnect") {
      response.emit("close"); finish.resolve!({ ok: true, model: "late-model", latencyMs: 99 });
      await running; await app.dispose();
    } else await Promise.all([app.dispose(), running]);
    assert.equal(signal.aborted, true); assert.equal(response.text, ""); assert.equal(response.status, undefined);
  }
});
