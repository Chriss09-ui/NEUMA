import type { IdleTimeoutDiagnostic } from "../src/runtime/model-idle-timeout.mjs";
import { callFixture } from "./helpers/m7-test-boundaries.mjs";
import { failureFields } from "./helpers/failure-fields.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { modelIdleTimeoutMs, withModelIdleTimeout } from "../src/runtime/model-idle-timeout.mjs";

const settle = () => new Promise(setImmediate);
const bytes = new TextEncoder();

test("模型等待配置沿用旧字段，但只表示连续无响应间隔", () => {
  assert.equal(modelIdleTimeoutMs(), 90_000);
  assert.equal(modelIdleTimeoutMs({ llmTimeoutMs: 300_000 }), 300_000);
  assert.equal(modelIdleTimeoutMs({ llmTimeoutMs: 300_000, llmIdleTimeoutMs: 100 }), 100);
  for (const value of [0, -1, 1.5, Infinity, "100", 2_147_483_648])
    assert.throws(() => callFixture(modelIdleTimeoutMs, undefined, [{ llmIdleTimeoutMs: value }]), /正整数/);
});

test("持续收到数据不受单次总时长限制，结束后计时器清理", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let source: ReadableStreamDefaultController<Uint8Array> | undefined, signal: AbortSignal | null | undefined;
  const diagnostics: IdleTimeoutDiagnostic[] = [];
  const fetch = withModelIdleTimeout(async (_url, init) => {
    signal = init!.signal;
    return new Response(new ReadableStream({ start(value) { source = value; } }));
  }, { idleTimeoutMs: 50, onDiagnostic: value => diagnostics.push(value) });
  const result = fetch("https://fixture.test").then(response => response.text());
  await settle();
  for (let i = 0; i < 6; i++) {
    t.mock.timers.tick(25); source!.enqueue(bytes.encode("x")); await settle();
  }
  source!.close();
  assert.equal(await result, "xxxxxx");
  t.mock.timers.tick(1000); await settle();
  assert.equal(signal!.aborted, false);
  assert.deepEqual<typeof diagnostics>(diagnostics, []);
});

test("首次响应停滞仅在连续无响应时取消，不依赖传输自行响应abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal | null | undefined, calls = 0;
  const fetch = withModelIdleTimeout((_url, init) => {
    signal = init!.signal; calls++; return new Promise<never>(() => {});
  }, { idleTimeoutMs: 50 });
  const rejected = assert.rejects(fetch("https://fixture.test"), error => {
    assert.equal(failureFields(error).reason, "idle_timeout");
    assert.equal(failureFields(error).diagnostic!.phase, "headers");
    assert.equal(failureFields(error).diagnostic!.chunkCount, 0);
    return true;
  });
  await settle(); t.mock.timers.tick(50); await rejected;
  assert.equal(signal!.aborted, true); assert.equal(calls, 1);
});

test("响应中途停滞从最后一块数据计时，诊断不保存内容", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let source: ReadableStreamDefaultController<Uint8Array> | undefined, cancelled = false;
  const diagnostics: IdleTimeoutDiagnostic[] = [];
  const fetch = withModelIdleTimeout(async () => new Response(new ReadableStream({
    start(value) { source = value; }, cancel() { cancelled = true; },
  })), { idleTimeoutMs: 50, onDiagnostic: value => diagnostics.push(value) });
  const response = await fetch("https://fixture.test");
  const rejected = assert.rejects(response.text(), error => failureFields(error).code === "NEUMA_MODEL_IDLE_TIMEOUT");
  t.mock.timers.tick(40); source!.enqueue(bytes.encode("private-fixture-text")); await settle();
  t.mock.timers.tick(49); await settle();
  assert.equal(cancelled, false); assert.equal(diagnostics.length, 0);
  t.mock.timers.tick(1); await rejected;
  assert.equal(cancelled, true); assert.equal(diagnostics[0]!.chunkCount, 1);
  assert.equal(diagnostics[0]!.receivedBytes, bytes.encode("private-fixture-text").byteLength);
  assert.equal(diagnostics[0]!.phase, "body");
  assert.doesNotMatch(JSON.stringify(diagnostics), /private|fixture|content|authorization/i);
});

test("用户取消优先，并清除随后可能触发的空闲超时", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController(), diagnostics: IdleTimeoutDiagnostic[] = [];
  const fetch = withModelIdleTimeout(async () => new Response(new ReadableStream()), {
    idleTimeoutMs: 50, onDiagnostic: value => diagnostics.push(value),
  });
  const response = await fetch("https://fixture.test", { signal: controller.signal });
  const cancelled = new DOMException("用户取消", "AbortError");
  const rejected = assert.rejects(response.text(), error => error === cancelled);
  controller.abort(cancelled); await rejected;
  t.mock.timers.tick(1000); await settle();
  assert.deepEqual<typeof diagnostics>(diagnostics, []);
});

test("消费者提前结束不遗留计时器，也不继续读取响应", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled = false;
  const diagnostics: IdleTimeoutDiagnostic[] = [];
  const fetch = withModelIdleTimeout(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })), {
    idleTimeoutMs: 50, onDiagnostic: value => diagnostics.push(value),
  });
  const response = await fetch("https://fixture.test"); await response.body!.cancel();
  t.mock.timers.tick(1000); await settle();
  assert.equal(cancelled, true); assert.deepEqual<typeof diagnostics>(diagnostics, []);
});

test("HTTP错误不读取响应正文，保留调用者原来的安全错误处理", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const response = { ok: false, status: 401, get body(): never { throw new Error("不应读取失败正文"); } };
  const fetch = withModelIdleTimeout(async () => response, { idleTimeoutMs: 50 });
  assert.equal(await fetch("https://fixture.test"), response);
  t.mock.timers.tick(1000); await settle();
});

test("错误响应正文被SDK读取时仍检测无响应，不自动读取或改写错误内容", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled = false;
  const diagnostics: IdleTimeoutDiagnostic[] = [];
  const fetch = withModelIdleTimeout(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    status: 401, headers: { "content-type": "application/json", "retry-after": "2" },
  }), { idleTimeoutMs: 50, onDiagnostic: value => diagnostics.push(value) });
  const response = await fetch("https://fixture.test");
  assert.equal(response.status, 401); assert.equal(response.headers.get("retry-after"), "2");
  const rejected = assert.rejects(response.text(), error => failureFields(error).reason === "idle_timeout");
  await settle(); t.mock.timers.tick(50); await rejected;
  assert.equal(cancelled, true); assert.equal(diagnostics.length, 1);
});
