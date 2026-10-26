import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentOperations } from "../../src/agents/agent-operations.mjs";
import { AgentStorage } from "../../src/agents/agent-storage.mjs";

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
