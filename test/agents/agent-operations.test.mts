import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentOperations } from "../../src/agents/agent-operations.mjs";
import { AgentStorage } from "../../src/agents/agent-storage.mjs";
import { createAgentRuntime } from "../../public/agent-runtime.js";
import type { OperationReference } from "../../public/operation-view.js";
import { emptyDraft } from "../../src/requirements/core.mjs";

test("制作任务持久接受、重复提交及旧代次停止共用同一次执行，快照读取不执行业务", async t => {
  const root = await mkdtemp(join(tmpdir(), "neuma-operation-")), storage = new AgentStorage({ dataDir: root });
  let calls = 0, release!: () => void, executionSignal: AbortSignal | undefined;
  let result = { architecture: { version: 1, status: "designing" } };
  const run = async (_input: unknown, options: { signal: AbortSignal }) => {
    calls++; executionSignal = options.signal;
    await new Promise<void>(resolve => { release = resolve; options.signal.addEventListener("abort", () => resolve(), { once: true }); });
    return result;
  };
  const owner = { storage, build: run, develop: run, snapshot: async () => result };
  const operations = new AgentOperations(owner);
  t.after(async () => { await operations.close(); await rm(root, { recursive: true, force: true }); });
  const request = new AbortController();
  const first = await operations.submit("one", "build", { goal: "synthetic" }, "request_one", request.signal);
  request.abort(); assert.equal(executionSignal!.aborted, false);
  const duplicate = await operations.submit("one", "build", { goal: "synthetic" }, "request_one");
  assert.deepEqual(duplicate.operation, first.operation); assert.equal(calls, 1);
  await assert.rejects(operations.submit("one", "build", { goal: "changed" }, "request_one"), /不同任务/);
  const quiet = await operations.view("one", "request_one", first.cursor); assert.equal(quiet.changed, false);
  result = { architecture: { version: 1, status: "evaluating" } };
  const progress = await operations.view("one", "request_one", first.cursor); assert.equal(progress.reset, true); assert.equal(calls, 1);
  release(); await operations.close();
  const restored = new AgentOperations(owner);
  assert.equal((await restored.view("one", "request_one")).snapshot!.running, false);
  assert.equal((await restored.current("one"))!.operationId, "request_one");
  const next = await restored.submit("one", "development", { resume: true }, "request_two");
  await assert.rejects(restored.cancel("one", "request_one", first.operation.generation), /旧窗口/);
  await restored.cancel("one", "request_two", next.operation.generation);
  assert.equal(calls, 2); await restored.close();
});

test("接受记录保存失败阻止执行，已有未结算回执在重建后仅显示中断", async t => {
  const root = await mkdtemp(join(tmpdir(), "neuma-operation-recovery-")), storage = new AgentStorage({ dataDir: root });
  let calls = 0;
  const owner = { storage, build: async () => { calls++; return {}; }, develop: async () => { calls++; return {}; }, snapshot: async () => ({}) };
  const operations = new AgentOperations(owner), write = storage.writeJson.bind(storage);
  t.after(async () => { await operations.close(); await rm(root, { recursive: true, force: true }); });
  storage.writeJson = async () => { throw new Error("synthetic failure"); };
  await assert.rejects(operations.submit("one", "build", {}, "request_one")); assert.equal(calls, 0);
  storage.writeJson = write;
  // Crash between accepting the receipt and launching: no automatic action is authorized.
  await write("one", "operations/request_one.json", { version: 1, id: "request_one", kind: "build", generation: "old", inputHash: "a".repeat(64), revision: 1, acceptedAt: new Date().toISOString() });
  const view = await operations.view("one", "request_one");
  assert.equal(view.snapshot!.interrupted, true); assert.equal(calls, 0);
});

test("前端断线重试不重复执行，确认失败或取消后可用同一输入重新提交", async t => {
  const root = await mkdtemp(join(tmpdir(), "neuma-operation-client-")), storage = new AgentStorage({ dataDir: root });
  let calls = 0, release!: () => void, lostResponse = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const run = async (_input: unknown, { signal }: { signal: AbortSignal }) => {
    const attempt = ++calls;
    if (attempt === 1) { await gate; throw new Error("synthetic execution failure"); }
    if (attempt === 3) {
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
      signal.throwIfAborted();
    }
    return {};
  };
  const operations = new AgentOperations({ storage, build: run, develop: run, snapshot: async () => ({}) });
  t.after(async () => { release(); await operations.close(); await rm(root, { recursive: true, force: true }); });
  const api = createAgentRuntime(async (path, options) => {
    const url = new URL(path, "http://localhost"), match = url.pathname.match(/^\/api\/agents\/([^/]+)\/operations(?:\/([^/]+)(?:\/(cancel))?)?$/);
    assert.ok(match, "请求必须经过任务协议入口");
    const [, id, operationId, cancel] = match;
    if (cancel) {
      const body = JSON.parse(String(options?.body)) as { generation: string };
      return Response.json(await operations.cancel(id!, operationId!, body.generation));
    }
    if (options?.method === "POST") {
      const { kind, mutationId, ...body } = JSON.parse(String(options.body)) as { kind: "build" | "development"; mutationId: string; resume?: boolean };
      const accepted = await operations.submit(id!, kind, body, mutationId);
      if (!lostResponse) { lostResponse = true; throw new TypeError("synthetic response lost"); }
      return Response.json(accepted);
    }
    release();
    return Response.json(await operations.view(id!, operationId!, url.searchParams.get("after")));
  });
  const agent = { id: "one", name: "测试", draft: emptyDraft() };
  await assert.rejects(api.startBuild(agent), /synthetic response lost/);
  assert.equal(calls, 1);
  await assert.rejects(api.startBuild(agent), /任务未完成/);
  assert.equal(calls, 1, "丢失接受回执后仍核对原执行，不能发起第二次业务调用");
  assert.deepEqual(await api.startBuild(agent), {});
  assert.equal(calls, 2, "已确认失败后的显式重试必须真正执行");

  const observer = new AbortController(); let reference: OperationReference | undefined;
  await assert.rejects(api.startDevelopment("one", { resume: true, signal: observer.signal, onProgress(event) {
    if (event.type === "operation") { reference = event.operation as OperationReference; observer.abort(); }
  } }), { name: "AbortError" });
  assert.ok(reference); assert.equal(calls, 3);
  await api.cancelOperation(reference);
  assert.deepEqual(await api.startDevelopment("one", { resume: true }), {});
  assert.equal(calls, 4, "观察已中止时，明确取消的终态回执也必须允许下一次提交");
});
