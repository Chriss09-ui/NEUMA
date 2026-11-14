import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentOperations } from "../../src/agents/agent-operations.mjs";
import { AgentStorage } from "../../src/agents/agent-storage.mjs";
import { createAgentRuntime } from "../../public/agent-runtime.js";
import type { OperationReference } from "../../public/operation-view.js";
import { emptyDraft, InputError } from "../../src/requirements/core.mjs";
import { createServer } from "node:http";
import { createRequestHandler } from "../../src/server.mjs";
import { continueDevelopmentOperation, classifyDevelopmentToolError } from "../../scripts/development-operation.mjs";
import { developmentDiagnostic, observeDevelopmentSessions } from "../../scripts/development-observer.mjs";
import type { ExecutionSession, SessionEvent } from "../../src/runtime/execution-port.mjs";

test("续测观察器按实际输入错误类型允许重交，额度停止和执行故障仍终止", () => {
  assert.equal(classifyDevelopmentToolError(new InputError("提交未通过")), "validation");
  assert.equal(classifyDevelopmentToolError(Object.assign(new Error("存储失败"), { name: "InputError" })), "execution");
  for (const reason of ["content_rejection_limit", "repeated_tool_error", "review_judgment_format", "read_input_correction_limit"])
    assert.equal(classifyDevelopmentToolError(Object.assign(new InputError("已达到控制器上限"), { diagnostic: { reason } })), "limit");
  assert.equal(classifyDevelopmentToolError(Object.assign(new InputError("资料来源损坏"), { diagnostic: { reason: "context_source_failed" } })), "execution");
  assert.equal(classifyDevelopmentToolError(Object.assign(new InputError("纠正次数落盘失败"), { diagnostic: { reason: "read_recovery_persistence" } })), "execution");
});

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

test("查询先读到旧回执而任务恰好完成时核对最终回执，不误报后台中断", async t => {
  const root = await mkdtemp(join(tmpdir(), "neuma-operation-settlement-")), storage = new AgentStorage({ dataDir: root });
  let release!: () => void, releaseRead!: () => void, readStarted!: () => void, calls = 0;
  const work = new Promise<void>(resolve => { release = resolve; });
  const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
  const opened = new Promise<void>(resolve => { readStarted = resolve; });
  const operations = new AgentOperations({ storage, build: async () => { calls++; await work; return {}; },
    develop: async () => ({}), snapshot: async () => ({}) });
  t.after(async () => { release(); releaseRead(); await operations.close(); await rm(root, { recursive: true, force: true }); });
  await operations.submit("one", "build", {}, "finish_while_reading");
  const read = storage.readJson.bind(storage); let hold = true;
  storage.readJson = async (...args) => {
    const value = await read(...args);
    if (hold && args[1] === "operations/finish_while_reading.json") {
      hold = false; readStarted(); await readGate;
    }
    return value;
  };
  const pendingView = operations.view("one", "finish_while_reading");
  await opened; release();
  while ((await operations.view("one", "finish_while_reading")).snapshot!.running)
    await new Promise<void>(resolve => setImmediate(resolve));
  releaseRead();
  const final = await pendingView;
  assert.equal(final.snapshot!.running, false); assert.equal(final.snapshot!.interrupted, false);
  assert.equal(final.snapshot!.error, null); assert.equal(calls, 1);
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

test("真实HTTP续测丢失接受回执及查看连接后仍沿同一后台任务完成，不重复执行或取消", async t => {
  const root = await mkdtemp(join(tmpdir(), "neuma-live-development-operation-")), storage = new AgentStorage({ dataDir: root });
  let calls = 0, release!: () => void, executionSignal: AbortSignal | undefined, released = false;
  let result = { development: { id: "existing_development", status: "running", requests: 5 } };
  const gate = new Promise<void>(resolve => { release = resolve; });
  const run = async (_id: string, { signal }: { signal: AbortSignal }) => {
    calls++; executionSignal = signal; await gate;
    result = { development: { ...result.development, status: "completed", requests: 6 } }; return result;
  };
  const operations = new AgentOperations({ storage, build: async () => ({}), develop: run, snapshot: async () => result });
  const handler = createRequestHandler({ dataDir: root, config: {}, providers: {},
    projects: { dispose: async () => {} }, projectAgent: { dispose: async () => {} },
    prototypeAgents: { close: () => operations.close(),
      submitOperation: (kind, input, options) => {
        const { mutationId, ...body } = input;
        return operations.submit(String(input.id), kind, body, mutationId, options?.signal);
      }, operation: (id, operationId, after) => operations.view(id, operationId, after) } });
  let lostSubmit = false, lostQueries = 0;
  const server = createServer((request, response) => {
    if (request.method === "POST" && !lostSubmit) {
      lostSubmit = true; response.end = () => { response.destroy(); return response; };
    } else if (request.method === "GET" && lostQueries < 4) {
      lostQueries++; response.end = () => { response.destroy(); return response; };
    }
    void handler(request, response);
  });
  t.after(async () => {
    release(); await handler.dispose(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true });
  });
  await handler.ready;
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const retries: string[] = [], failures: unknown[] = [], observer = new AbortController();
  const options = { baseUrl: `http://127.0.0.1:${address.port}/`, agentId: "one", mutationId: "continue_original" };
  await assert.rejects(continueDevelopmentOperation({ ...options, signal: observer.signal,
    onRequestError(event) { failures.push(developmentDiagnostic(event)); },
    onRetry(event) { retries.push(event.phase); }, onView() {
      assert.equal(executionSignal!.aborted, false);
      if (lostQueries === 4) observer.abort();
    } }), { name: "AbortError" });
  assert.equal(executionSignal!.aborted, false, "断开观察不能取消原任务");
  assert.equal((await operations.view("one", "continue_original")).snapshot!.running, true);
  const completed = await continueDevelopmentOperation({ ...options, onView() {
    if (!released) { released = true; release(); }
  } });
  assert.deepEqual(retries, ["submit", "observe", "observe", "observe", "observe"]); assert.equal(calls, 1);
  assert.equal(failures.length, 5); assert.match(JSON.stringify(failures), /UND_ERR_SOCKET/);
  assert.equal(completed.running, false); assert.equal(completed.interrupted, false); assert.equal(completed.error, null);
  assert.deepEqual(completed.result, { development: { id: "existing_development", status: "completed", requests: 6 } });
  assert.ok((await operations.read("one", "continue_original")).settledAt);
});

test("续测保留 aborted 后真正抛出的底层异常，不提前取消父会话且日志隐藏密钥", async () => {
  let listener: (event: SessionEvent) => void = () => {}, aborts = 0;
  const failures: unknown[] = [], logs: unknown[] = [];
  const root = Object.assign(new Error("socket closed; Bearer private-value"), { code: "UND_ERR_SOCKET" });
  const error = new Error("request failed: configured-key", { cause: new AggregateError([root], "transport failed") });
  const native: ExecutionSession = {
    async prompt() {
      listener({ type: "message_end", message: { role: "assistant", stopReason: "aborted", errorMessage: "aborted" } });
      assert.equal(failures.length, 0); assert.equal(aborts, 0);
      await Promise.resolve(); throw error;
    }, abort() { aborts++; }, dispose() {}, subscribe(callback) { listener = callback; return () => {}; },
  };
  const factory = observeDevelopmentSessions({ factory: () => native, beforeRequest() {}, checkContent() {},
    log(type, details) { logs.push(developmentDiagnostic({ type, ...details }, ["configured-key"])); },
    fail(kind, details) { failures.push(developmentDiagnostic({ kind, ...details }, ["configured-key"])); },
  });
  const session = await factory({ config: {}, cwd: ".", dataDir: "." });
  await assert.rejects(session.prompt("continue"), value => value === error);
  assert.equal(aborts, 0); assert.equal(failures.length, 1);
  assert.match(JSON.stringify(failures), /UND_ERR_SOCKET/);
  const logText = JSON.stringify(logs);
  assert.match(logText, /assistant_end/); assert.match(logText, /prompt_error/);
  assert.doesNotMatch(logText + JSON.stringify(failures), /configured-key|private-value/);
  await session.dispose();
});

test("续测让暂时模型错误完成原重连，合法工具交接后的 aborted 不误判失败", async () => {
  let listener: (event: SessionEvent) => void = () => {}, promptCount = 0;
  const failures: unknown[] = [];
  const native: ExecutionSession = {
    async prompt() {
      if (++promptCount === 1) {
        listener({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "connection lost" } });
        listener({ type: "auto_retry_start", attempt: 1 });
        listener({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
        listener({ type: "auto_retry_end", success: true });
      } else listener({ type: "message_end", message: { role: "assistant", stopReason: "aborted" } });
    }, abort() { assert.fail("观察事件不能取消执行"); }, dispose() {}, subscribe(callback) { listener = callback; return () => {}; },
  };
  const factory = observeDevelopmentSessions({ factory: () => native, beforeRequest() {}, checkContent() {},
    log() {}, fail(kind) { failures.push(kind); },
  });
  const session = await factory({ config: {}, cwd: ".", dataDir: "." });
  await session.prompt("retry"); await session.prompt("handoff");
  assert.deepEqual(failures, []); await session.dispose();
});

test("内容退回通知携带本次提交的具体异常，不拿旧检查点反馈代替原因", async () => {
  let rejected = false;
  const notifications: Record<string, unknown>[] = [], inputError = new InputError("plan.application: execution_mismatch");
  const factory = observeDevelopmentSessions({
    factory: options => ({ async prompt() {
      await assert.rejects(options.customTools![0]!.execute("current_submission", {}), error => error === inputError);
    }, abort() {}, dispose() {} }),
    beforeRequest() {}, log() {}, fail() { assert.fail("输入退回应由原控制器处理"); },
    checkContent(details) { if (rejected && details) notifications.push(details); },
  });
  const session = await factory({ config: {}, cwd: ".", dataDir: ".", customTools: [{
    name: "submit_plan", label: "提交", description: "提交计划", parameters: { type: "object" },
    async execute() { rejected = true; throw inputError; },
  }] });
  await session.prompt("continue");
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]!.toolCallId, "current_submission");
  assert.equal(notifications[0]!.error, inputError);
  await session.dispose();
});
