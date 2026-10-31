import { fixtureTools, callFixture, listeningAddress, recordArray } from "../helpers/m7-test-boundaries.mjs";
import type { PiSessionOptions, NeumaTool } from "../../src/runtime/pi-port.mjs";
import { fixtureChatRequest, type FixtureChatRequest } from "../helpers/http-model.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import { failureFields } from "../helpers/failure-fields.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevelopmentController } from "../../src/development/development.mjs";
import { createPiSession } from "../../src/runtime/pi-runtime.mjs";
import { developmentArchitecture } from "../helpers/development.mjs";

const textOf = (value: unknown) => typeof value === "string" ? value : recordArray(value).filter((entry) => entry.type === "text").map((entry) => entry.text).join("\n");

async function fixture(t: test.TestContext, reply: (body: FixtureChatRequest, count: number) => unknown, { extraTools = [], repeatedCallId = false, turns = 12, boundedWorkload = false }: {extraTools?: NeumaTool[];repeatedCallId?:boolean;turns?:number;boundedWorkload?:boolean} = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-development-tool-inputs-")), requests: FixtureChatRequest[] = [], executed: unknown[] = [];
  let serverError: unknown; const capture: {current?: PiSessionOptions} = {};
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = fixtureChatRequest(Buffer.concat(chunks).toString("utf8")); requests.push(body);
      const replyValue = reply(body, requests.length), calls = Array.isArray(replyValue) ? recordArray(replyValue) : [];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "local-tool-input", choices: [{ index: 0, delta: { role: "assistant", ...(Array.isArray(replyValue) ? { tool_calls: calls.map((call, index) => ({
        index, id: repeatedCallId ? `call_${index}` : `call_${requests.length}_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) },
      })) } : { content: replyValue }) }, finish_reason: Array.isArray(replyValue) ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) { serverError = error; response.writeHead(500, { "content-type": "application/json" }); response.end('{"error":{"message":"local fixture failed"}}'); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const architecture = developmentArchitecture(), record = { id: "dev_inputs", agentId: "inputs", architecture,
    architectureRef: { version: architecture.version, candidateHash: architecture.candidateHash }, phase: "implementing", revision: 0,
    ...(boundedWorkload ? { workloadPolicyVersion: 1 as const } : {}) };
  const controller = Reflect.construct(DevelopmentController, [{ cwd: root, dataDir: join(root, "data"),
    config: { llmConfigured: true, chatUrl: `http://127.0.0.1:${listeningAddress(server).port}/v1/chat/completions`, model: "local-model", apiKey: "local-only" },
    store: { save: async (value: object) => ({ ...value, revision: Number(objectFields(value).revision) + 1 }) },
    sessionFactory: async (options: PiSessionOptions) => { capture.current = options; const session = await createPiSession(options); session.setAutoRetryEnabled(false); return session; } }]);
  assert.ok(controller instanceof DevelopmentController);
  const ctx = { record, signal: new AbortController().signal, writes: Promise.resolve(), handles: new Set() };
  callFixture(controller.active.set, controller.active, [record.agentId, ctx]); await controller.workspace.create(record.agentId, record.id);
  const tool: NeumaTool = { name: "change_input", label: "本地结构测试", description: "只接受文本值", executionMode: "sequential",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    async execute(_id, args) { executed.push(objectFields(args).value); return { content: [{ type: "text", text: "saved" }], details: {} }; } };
  const tools = [tool, ...extraTools], counter = { turns: 0 }, handle = await callFixture(controller.role, controller, [ctx, { kind: "developer", tools, scope: {}, counter, limit: turns, validate: (value: unknown) => value }]);
  t.after(async () => { callFixture(controller.dispose, controller, [ctx, handle]); server.closeAllConnections(); await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())); await rm(root, { recursive: true, force: true }); });
  return { controller, ctx, handle, captured: capture.current, tools, requests, executed, counter, error: () => serverError };
}

test("新研发会话的最后一次真实模型请求只暴露提交工具，不把剩余额度花在读取上", async t => {
  const f = await fixture(t, (body, count) => {
    if (count === 1) return [{ name: "read_development_context", args: { requests: [{ section: "task" }] } }];
    assert.equal(count, 2);
    assert.deepEqual(recordArray(body.tools).map(tool => objectFields(tool.function).name), ["submit_development_work"]);
    return [{ name: "submit_development_work", args: { summary: "完成有界任务", changedFiles: [], knownIssues: [], nextAction: "验收", continue: false } }];
  }, { turns: 2, boundedWorkload: true });
  await callFixture(f.controller.ask, f.controller, [f.ctx, f.handle, { task: { id: "bounded" } }]);
  assert.equal(f.error(), undefined); assert.equal(f.requests.length, 2); assert.equal(f.counter.turns, 2);
});

test("研发真实Pi原始参数不被强转，下一请求包含具体字段诊断，修正后正常提交", async (t) => {
  const f = await fixture(t, (body, count: unknown) => {
    if (count === 1) return [{ name: "change_input", args: { value: 7 } }];
    if (count === 2) {
      const feedback = textOf(body.messages.findLast((entry: { role: string; }) => entry.role === "tool")!.content);
      assert.match(feedback, /change_input\.value/u); assert.match(feedback, /"expectedType":"string"/u); assert.match(feedback, /"receivedType":"number"/u);
      return [{ name: "change_input", args: { value: "corrected" } }];
    }
    if (count === 4) return "已提交本地结果";
    assert.equal(count, 3);
    return [{ name: "submit_development_work", args: { summary: "本地参数已修正", changedFiles: ["main.mjs"], knownIssues: [], nextAction: "提交独立验收", continue: false } }];
  });
  await callFixture(f.controller.ask, f.controller, [f.ctx, f.handle, {}]);
  assert.equal(f.error(), undefined); assert.equal(f.requests.length, 3); assert.deepEqual(f.executed, ["corrected"]);
  assert.equal(f.handle.reference.toolInputFailure, undefined);
  assert.ok(Object.keys(f.captured!.rawInputValidators!).includes("submit_development_work"));
  assert.ok(Object.keys(f.captured!.rawInputValidators!).includes("read_development_context"));
});

test("研发相同错误原参数三次后在下一请求前停止，持久记录不保存参数正文", async (t) => {
  const f = await fixture(t, () => [{ name: "change_input", args: { value: { private: "PRIVATE_INPUT_BODY" } } }]);
  await assert.rejects(callFixture(f.controller.ask, f.controller, [f.ctx, f.handle, {}]), (error) => failureFields(error).diagnostic?.reason === "repeated_tool_error");
  assert.equal(f.error(), undefined); assert.equal(f.requests.length, 3); assert.equal(f.counter.turns, 3); assert.deepEqual<NonNullable<typeof f>["executed"]>(f.executed, []);
  assert.equal(f.handle.reference.toolInputFailure!.count, 3); assert.match(f.handle.reference.toolInputFailure!.fingerprint, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(f.handle.reference), /PRIVATE_INPUT_BODY|"private"/u);
  await assert.rejects(callFixture(f.controller.ask, f.controller, [f.ctx, f.handle, {}]), (error) => failureFields(error).diagnostic?.reason === "repeated_tool_error");
  assert.equal(f.requests.length, 3, "继续原会话不能重新消耗请求");
  callFixture(f.controller.dispose, f.controller, [f.ctx, f.handle]);
  const resumed = await callFixture(f.controller.role, f.controller, [f.ctx, { kind: "developer", tools: f.tools, scope: {}, counter: { turns: 0 }, limit: 12, validate: (value: unknown) => value }]);
  try {
    assert.equal(resumed.counter.turns, 3); assert.equal(resumed.reference.toolInputFailure!.count, 3);
    await assert.rejects(callFixture(f.controller.ask, f.controller, [f.ctx, resumed, {}]), (error) => failureFields(error).diagnostic?.reason === "repeated_tool_error");
    assert.equal(f.requests.length, 3, "重新创建原会话仍保留相同错误止损和原预算");
  } finally { callFixture(f.controller.dispose, f.controller, [f.ctx, resumed]); }
  const changedTools = f.tools.map((tool) => ({ ...tool, parameters: { ...tool.parameters, properties: { value: { type: "string", maxLength: 200 } } } }));
  const changed = await callFixture(f.controller.role, f.controller, [f.ctx, { kind: "developer", tools: changedTools, scope: {}, counter: { turns: 0 }, limit: 12, validate: (value: unknown) => value }]);
  try {
    assert.equal(changed.counter.turns, 3); assert.equal(changed.reference.toolInputFailure, undefined, "公开工具契约改变后旧结构拒绝不再适用，预算仍保留");
  } finally { callFixture(f.controller.dispose, f.controller, [f.ctx, changed]); }
});

test("同回复三次相同错误锁定停止，后排有效工具不能清零或写入", async (t) => {
  const f = await fixture(t, () => [...Array.from({ length: 3 }, () => ({ name: "change_input", args: { value: 7 } })),
    { name: "change_input", args: { value: "queued-valid" } }]);
  await assert.rejects(callFixture(f.controller.ask, f.controller, [f.ctx, f.handle, {}]), (error) => failureFields(error).diagnostic?.reason === "repeated_tool_error");
  assert.equal(f.error(), undefined); assert.equal(f.requests.length, 1); assert.equal(f.handle.reference.toolInputFailure!.count, 3);
  assert.deepEqual<NonNullable<typeof f>["executed"]>(f.executed, []);
});

test("供应商跨请求复用callId仍分别计数，同一回复重复校验保持去重", async (t) => {
  const f = await fixture(t, () => [{ name: "change_input", args: { value: 7 } }], { repeatedCallId: true });
  await assert.rejects(callFixture(f.controller.ask, f.controller, [f.ctx, f.handle, {}]), (error) => failureFields(error).diagnostic?.reason === "repeated_tool_error");
  assert.equal(f.error(), undefined); assert.equal(f.requests.length, 3); assert.equal(f.handle.reference.toolInputFailure!.count, 3);
  assert.deepEqual<NonNullable<typeof f>["executed"]>(f.executed, []);
});

test("不同错误原参数重置连续计数，同callId预检不重复计数，读取其他工具不清零", async (t) => {
  const f = await fixture(t, () => []);
  const validate = f.captured!.rawInputValidators!.change_input!;
  assert.equal((await callFixture(validate, undefined, [{ args: { value: 7 }, toolCallId: "same" }])).valid, false);
  await callFixture(validate, undefined, [{ args: { value: 7 }, toolCallId: "same" }]);
  assert.equal(f.handle.reference.toolInputFailure!.count, 1);
  await callFixture(validate, undefined, [{ args: { value: 8 }, toolCallId: "changed" }]);
  assert.equal(f.handle.reference.toolInputFailure!.count, 1);
  await callFixture(validate, undefined, [{ args: { value: 8 }, toolCallId: "second" }]);
  f.handle.accepting = true; f.handle.payload = { report: { status: "fixed-local-read" } };
  await fixtureTools(f.captured!.customTools).read_development_context!.execute("read", { section: "report", offset: 0, limit: 1000 });
  assert.equal(f.handle.reference.toolInputFailure!.count, 2);
  await callFixture(validate, undefined, [{ args: { value: 8 }, toolCallId: "third" }]);
  await assert.rejects(async () => await f.captured!.onModelCall!({}), (error: unknown) => failureFields(error).diagnostic?.reason === "repeated_tool_error");
  assert.equal(f.counter.turns, 0); assert.equal(f.requests.length, 0);
});

test("大量结构问题回执保留具体字段和截断计数，不超过原始工具拦截消息额度", async (t) => {
  const fields = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`field_${index}_${"a".repeat(60)}`, { type: "string" }]));
  const tool: NeumaTool = { name: "large_input", label: "大结构本地检查", description: "只验证诊断消息额度", executionMode: "sequential",
    parameters: { type: "object", properties: { records: { type: "array", items: { type: "object", properties: fields,
      required: Object.keys(fields), additionalProperties: false } } }, required: ["records"], additionalProperties: false },
    async execute() { assert.fail("无效结构不能执行"); } };
  const f = await fixture(t, () => [], { extraTools: [tool] });
  const result = await callFixture(f.captured!.rawInputValidators!.large_input!, undefined, [{ toolCallId: "oversized", args: { records: Array.from({ length: 12 }, () => ({
    ...Object.fromEntries(Object.keys(fields).map((key) => [key, "PRIVATE_VALUE"])), PRIVATE_FIELD: "PRIVATE_BODY",
  })) } }]);
  assert.equal(result.valid, false); assert.ok(typeof result.reason === "string"); assert.ok(result.reason.length < 16000);
  const feedback = JSON.parse(result.reason);
  assert.equal(feedback.total, 12); assert.equal(feedback.retained, feedback.issues.length); assert.equal(feedback.truncated, true);
  assert.ok(feedback.issues.length > 0); assert.match(feedback.issues[0].path, /^large_input\.records\[0\]$/u);
  assert.equal(feedback.issues[0].allowedFieldsTruncated, true); assert.doesNotMatch(result.reason, /PRIVATE_/u);
});
