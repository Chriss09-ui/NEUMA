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
import { developmentArchitecture, developmentPlan } from "../helpers/development.mjs";
import { LEGACY_PLAN_SCHEMA, validatePlan } from "../../src/development/development-contract.mjs";
import { ensureDevelopmentPolicy, noteDevelopmentRejection, sealDevelopmentPolicy, readDevelopmentPolicy } from "../../src/development/development-policy.mjs";
import { hashValue } from "../../src/development/development-contract.mjs";
import type { DevelopmentRunRecord } from "../../src/development/development-controller-types.mjs";

const textOf = (value: unknown) => typeof value === "string" ? value : recordArray(value).filter((entry) => entry.type === "text").map((entry) => entry.text).join("\n");

async function fixture(t: test.TestContext, reply: (body: FixtureChatRequest, count: number) => unknown, { extraTools = [], repeatedCallId = false, turns = 12, boundedWorkload = false, failAt, planning = false }: {extraTools?: NeumaTool[];repeatedCallId?:boolean;turns?:number;boundedWorkload?:boolean;failAt?:number;planning?:boolean} = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-development-tool-inputs-")), requests: FixtureChatRequest[] = [], executed: unknown[] = [];
  let serverError: unknown; const capture: {current?: PiSessionOptions} = {};
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = fixtureChatRequest(Buffer.concat(chunks).toString("utf8")); requests.push(body);
      if (requests.length === failAt) { response.writeHead(503, { "content-type": "application/json" }); response.end('{"error":{"message":"temporary fixture failure"}}'); return; }
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
  if (planning) {
    Object.assign(record, { phase: "planning", tasks: [], planAttempts: [], budgets: { corrections: 6, planRevisions: 1, integrationRepairs: 2 } });
    ensureDevelopmentPolicy(record as unknown as DevelopmentRunRecord);
  }
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
  const tools = [tool, ...extraTools], counter = { turns: 0 }, handle = await callFixture(controller.role, controller, [ctx, {
    kind: planning ? "planner" : "developer", tools, scope: {}, counter, limit: turns,
    ...(planning ? { blocker: false, submission: { name: "submit_development_plan", schema: LEGACY_PLAN_SCHEMA, instruction: "提交当前规划" } } : {}),
    validate: (value: unknown) => planning ? validatePlan(value, { architecture }) : value }]);
  t.after(async () => { callFixture(controller.dispose, controller, [ctx, handle]); server.closeAllConnections(); await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())); await rm(root, { recursive: true, force: true }); });
  return { controller, ctx, handle, captured: capture.current, tools, requests, executed, counter, architecture, error: () => serverError };
}

test("规划路径错误只给反馈后三次实际纠正，不扣内容次数，第三次仍可成功且耗尽后不能重领", async t => {
  for (const correctLast of [false, true]) await t.test(correctLast ? "第三次纠正成功" : "三次纠正失败后停止", async t => {
    const seen: unknown[] = [];
    const f = await fixture(t, (body, count) => {
      if (count > 1) seen.push(JSON.parse(textOf(body.messages.findLast(row => row.role === "user")!.content)).formatCorrection);
      const plan = developmentPlan();
      plan.cases[0]!.assertions[0]!.path = correctLast && count === 4 ? "/verified" : "/literal.key";
      return [{ name: "submit_development_plan", args: plan }];
    }, { planning: true });
    if (correctLast) {
      const plan = await callFixture(f.controller.ask, f.controller, [f.ctx, f.handle, {}]);
      assert.equal((plan as ReturnType<typeof developmentPlan>).cases[0]!.assertions[0]!.path, "verified");
    } else {
      await assert.rejects(callFixture(f.controller.ask, f.controller, [f.ctx, f.handle, {}]), error => failureFields(error).diagnostic?.reason === "repeated_tool_error");
      await assert.rejects(callFixture(f.controller.ask, f.controller, [f.ctx, f.handle, {}]), error => failureFields(error).diagnostic?.reason === "repeated_tool_error");
    }
    assert.equal(f.error(), undefined); assert.equal(f.requests.length, 4);
    const declaration = recordArray(f.requests[0]!.tools).map(row => objectFields(row.function)).find(row => row.name === "submit_development_plan")!;
    assert.match(JSON.stringify(declaration.parameters), /result\.items\.0/);
    assert.match(JSON.stringify(declaration.parameters), /\/result\/items\/0/);
    assert.deepEqual(objectFields(objectFields(f.ctx.record).retryPolicy).content, {});
    for (const [index, raw] of seen.entries()) {
      const feedback = objectFields(raw), row = objectFields((feedback.outstanding as unknown[])[0]);
      assert.equal(row.correctionsUsed, index); assert.equal(row.correctionsRemaining, 3-index);
      assert.equal(objectFields((row.issues as unknown[])[0]).path, "plan.cases[0].assertions[0].path");
    }
    const episode = f.handle.reference.formatRecovery!.episodes[0]!;
    assert.equal(episode.corrections.length, 3); assert.equal(Boolean(episode.closed), correctLast);
  });
});

test("研发超过旧请求上限仍可读取再提交，只有用量累计", async t => {
  const f = await fixture(t, (body, count) => {
    if (count === 1) return [{ name: "read_development_context", args: { requests: [{ section: "task" }] } }];
    const names = recordArray(body.tools).map(tool => objectFields(tool.function).name);
    assert.ok(names.includes("read_development_context")); assert.ok(names.includes("submit_development_work"));
    if (count === 2) return [{ name: "read_development_context", args: { requests: [{ section: "task" }] } }];
    assert.equal(count, 3);
    return [{ name: "submit_development_work", args: { summary: "完成有界任务", changedFiles: [], knownIssues: [], nextAction: "验收", continue: false } }];
  }, { turns: 2, boundedWorkload: true });
  await callFixture(f.controller.ask, f.controller, [f.ctx, f.handle, { task: { id: "bounded" } }]);
  assert.equal(f.error(), undefined); assert.equal(f.requests.length, 3); assert.equal(f.counter.turns, 3);
});

test("明确授权的续测保留五次内容回执，下一次内容退回仍停止且不能重新领取", async t => {
  const f = await fixture(t, () => {
    const plan = developmentPlan(); plan.tasks[0]!.requirementIds = [f.architecture.requirements[0]!.id];
    return [{ name: "submit_development_plan", args: plan }];
  }, { planning: true });
  const record = f.ctx.record as unknown as DevelopmentRunRecord;
  for (let n = 0; n < 5; n++) noteDevelopmentRejection(record, "plan", { rejected: n });
  const policy = record.retryPolicy!, before = structuredClone(policy.content.plan!);
  await assert.rejects(callFixture(f.controller.ask, f.controller, [f.ctx, f.handle, {}]), error => failureFields(error).diagnostic?.reason === "content_rejection_limit");
  assert.equal(f.requests.length, 0);
  Reflect.set(policy, "continuations", [{ owner: "plan", rejectedAt: 5, receiptsHash: hashValue(before.receipts), authorization: "explicit-user-resume" }]);
  sealDevelopmentPolicy(policy);
  const damaged = structuredClone(policy);
  Reflect.set(damaged, "continuations", [{ owner: "plan", rejectedAt: 5, receiptsHash: "0".repeat(64), authorization: "explicit-user-resume" }]);
  sealDevelopmentPolicy(damaged);
  assert.throws(() => readDevelopmentPolicy(damaged), /授权/);
  await assert.rejects(callFixture(f.controller.ask, f.controller, [f.ctx, f.handle, {}]), error => failureFields(error).diagnostic?.reason === "content_rejection_limit");
  assert.equal(f.requests.length, 1);
  assert.equal(policy.content.plan!.count, 6);
  assert.deepEqual(policy.content.plan!.receipts.slice(0, 5), before.receipts);
  assert.equal(f.handle.reference.formatRecovery!.episodes.length, 0);
  await assert.rejects(callFixture(f.controller.ask, f.controller, [f.ctx, f.handle, {}]), error => failureFields(error).diagnostic?.reason === "content_rejection_limit");
  assert.equal(f.requests.length, 1);
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

test("首次错误后明确反馈并给满三次实际纠正机会，重启不重新领取，记录不保存参数正文", async (t) => {
  const f = await fixture(t, (body, count) => {
    if (count > 1) {
      const feedback = JSON.parse(textOf(body.messages.findLast(row => row.role === "user")!.content)).formatCorrection;
      assert.equal(feedback.outstanding[0].toolName, "change_input");
      assert.equal(feedback.outstanding[0].correctionsUsed, count - 2);
      assert.equal(feedback.outstanding[0].issues[0].path, "change_input.value");
      assert.ok(feedback.outstanding[0].issues[0].remedy);
    }
    return [{ name: "change_input", args: { value: { private: "PRIVATE_INPUT_BODY" } } }];
  });
  await assert.rejects(callFixture(f.controller.ask, f.controller, [f.ctx, f.handle, {}]), (error) => failureFields(error).diagnostic?.reason === "repeated_tool_error");
  assert.equal(f.error(), undefined); assert.equal(f.requests.length, 4); assert.equal(f.counter.turns, 4); assert.deepEqual<NonNullable<typeof f>["executed"]>(f.executed, []);
  const recovery = structuredClone(f.handle.reference.formatRecovery!);
  assert.equal(recovery.episodes[0]!.failures.length, 4); assert.equal(recovery.episodes[0]!.corrections.length, 3);
  assert.doesNotMatch(JSON.stringify(f.handle.reference), /PRIVATE_INPUT_BODY|"private"/u);
  await assert.rejects(callFixture(f.controller.ask, f.controller, [f.ctx, f.handle, {}]), (error) => failureFields(error).diagnostic?.reason === "repeated_tool_error");
  assert.equal(f.requests.length, 4, "继续原会话不能重新消耗请求");
  callFixture(f.controller.dispose, f.controller, [f.ctx, f.handle]);
  const resumed = await callFixture(f.controller.role, f.controller, [f.ctx, { kind: "developer", tools: f.tools, scope: {}, counter: { turns: 0 }, limit: 12, validate: (value: unknown) => value }]);
  try {
    assert.equal(resumed.counter.turns, 4); assert.deepEqual(resumed.reference.formatRecovery, recovery);
    await assert.rejects(callFixture(f.controller.ask, f.controller, [f.ctx, resumed, {}]), (error) => failureFields(error).diagnostic?.reason === "repeated_tool_error");
    assert.equal(f.requests.length, 4, "重新创建原会话仍保留相同错误止损和原预算");
  } finally { callFixture(f.controller.dispose, f.controller, [f.ctx, resumed]); }
  const changedTools = f.tools.map((tool) => ({ ...tool, parameters: { ...tool.parameters, properties: { value: { type: "string", maxLength: 200 } } } }));
  const changed = await callFixture(f.controller.role, f.controller, [f.ctx, { kind: "developer", tools: changedTools, scope: {}, counter: { turns: 0 }, limit: 12, validate: (value: unknown) => value }]);
  try {
    assert.equal(changed.counter.turns, 4); assert.deepEqual(changed.reference.formatRecovery, recovery, "修改字段契约不能清零已发生的纠正尝试");
  } finally { callFixture(f.controller.dispose, f.controller, [f.ctx, changed]); }
});

test("同一回复多处错误未收到反馈，不冒充三次纠正机会，合法结果仍可提交", async (t) => {
  const f = await fixture(t, (_body, count) => count === 1
    ? [...Array.from({ length: 3 }, () => ({ name: "change_input", args: { value: 7 } })), { name: "change_input", args: { value: "queued-valid" } }]
    : [{ name: "submit_development_work", args: { summary: "完成", changedFiles: [], knownIssues: [], nextAction: "验收", continue: false } }]);
  await callFixture(f.controller.ask, f.controller, [f.ctx, f.handle, {}]);
  assert.equal(f.error(), undefined); assert.equal(f.requests.length, 2);
  const episode = f.handle.reference.formatRecovery!.episodes[0]!;
  assert.equal(episode.failures.length, 3); assert.equal(episode.corrections.length, 0); assert.ok(episode.closed);
  assert.deepEqual(f.executed, ["queued-valid"]);
});

test("供应商跨请求复用callId仍分别计数，同一回复重复校验保持去重", async (t) => {
  const f = await fixture(t, () => [{ name: "change_input", args: { value: 7 } }], { repeatedCallId: true });
  await assert.rejects(callFixture(f.controller.ask, f.controller, [f.ctx, f.handle, {}]), (error) => failureFields(error).diagnostic?.reason === "repeated_tool_error");
  assert.equal(f.error(), undefined); assert.equal(f.requests.length, 4); assert.equal(f.handle.reference.formatRecovery!.episodes[0]!.corrections.length, 3);
  assert.deepEqual<NonNullable<typeof f>["executed"]>(f.executed, []);
});

test("反馈请求连接失败未得到模型纠正输出，不扣机会；恢复后仍有三次实际尝试", async t => {
  const f = await fixture(t, () => [{ name: "change_input", args: { value: 7 } }], { failAt: 2 });
  await assert.rejects(callFixture(f.controller.ask, f.controller, [f.ctx, f.handle, {}]), error => failureFields(error).diagnostic?.reason === "api_unavailable");
  assert.equal(f.handle.reference.formatRecovery!.episodes[0]!.corrections.length, 0);
  callFixture(f.controller.dispose, f.controller, [f.ctx, f.handle]);
  const resumed = await callFixture(f.controller.role, f.controller, [f.ctx, { kind: "developer", tools: f.tools, scope: {}, counter: { turns: 0 }, limit: null, validate: (value: unknown) => value }]);
  try {
    await assert.rejects(callFixture(f.controller.ask, f.controller, [f.ctx, resumed, {}]), error => failureFields(error).diagnostic?.reason === "repeated_tool_error");
    assert.equal(f.error(), undefined); assert.equal(f.requests.length, 5);
    assert.equal(resumed.reference.formatRecovery!.episodes[0]!.corrections.length, 3);
  } finally { callFixture(f.controller.dispose, f.controller, [f.ctx, resumed]); }
});

test("修好一项后新的读取错误得到自己的反馈和纠正机会，正常读取不扣机会", async (t) => {
  const f = await fixture(t, (body, count) => {
    if (count === 1) return [{ name: "change_input", args: { value: 7 } }];
    if (count === 2) return [{ name: "read_development_context", args: { requests: [{ section: "report" }] } }];
    if (count === 3) {
      const feedback = JSON.parse(textOf(body.messages.findLast(row => row.role === "user")!.content)).formatCorrection;
      assert.equal(feedback.outstanding[0].correctionsUsed, 0);
      return [{ name: "change_input", args: { value: "fixed" } }, { name: "read_development_context", args: { requests: [{ section: "report", pointer: "0" }] } }];
    }
    assert.equal(count, 4);
    const feedback = JSON.parse(textOf(body.messages.findLast(row => row.role === "user")!.content)).formatCorrection;
    assert.equal(feedback.outstanding.length, 1); assert.equal(feedback.outstanding[0].toolName, "read_development_context");
    assert.equal(feedback.outstanding[0].correctionsUsed, 0); assert.match(feedback.outstanding[0].issues[0].remedy, /JSON Pointer/);
    return [{ name: "read_development_context", args: { requests: [{ section: "report", pointer: "/0" }] } },
      { name: "submit_development_work", args: { summary: "完成", changedFiles: [], knownIssues: [], nextAction: "验收", continue: false } }];
  });
  let submitted: unknown;
  try { submitted = await callFixture(f.controller.ask, f.controller, [f.ctx, f.handle, { report: ["current"] }]); }
  catch (error) { throw f.error() ?? error; }
  assert.equal(f.error(), undefined); assert.equal(f.requests.length, 4); assert.equal(f.counter.turns, 4);
  assert.equal(objectFields(submitted).summary, "完成");
  assert.deepEqual(f.handle.reference.formatRecovery!.episodes.map(row => row.corrections.map(value => value.outcome)), [["accepted"], ["accepted"]]);
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
