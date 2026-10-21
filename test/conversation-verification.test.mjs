import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyConversationTurn } from "../src/verification/conversation-verification.mjs";
import { acceptanceEvidenceHash } from "../src/verification/acceptance-contract.mjs";
import { createPiSession } from "../src/runtime/pi-runtime.mjs";

const acceptance = (id = "missing_material") => ({ id, requirementIds: ["input"], input: "用户未提供材料时", expected: "先追问材料，不虚构已经处理", verification: { stage: "runtime", owner: "conversation", adapterId: "conversation" } });
const observed = () => ({ acceptance: [acceptance()], message: "帮我分析一下", reply: "请先提供需要分析的材料。", toolEvidence: [] });
const item = (overrides = {}) => ({ acceptanceId: "missing_material", status: "passed", triggered: true, reason: "本轮没有材料，回复实际追问材料。",
  quotes: [{ source: "message", quote: "帮我分析一下" }, { source: "reply", quote: "请先提供需要分析的材料。" }], ...overrides });

function model(run) {
  const records = [];
  const factory = async (options) => {
    const record = { options, prompts: [], disposed: false, aborted: false }; records.push(record);
    const tool = options.customTools[0];
    const session = { modelCallAccounting: true, setAutoCompactionEnabled(value) { record.compaction = value; },
      async prompt(text) { await options.onModelCall(); record.prompts.push(JSON.parse(text)); await run({ record, session, tool, options }); },
      async abort() { record.aborted = true; record.release?.(); },
      dispose() { record.disposed = true; },
    };
    return session;
  };
  return { factory, records };
}

for (const wrapped of [false, true]) test(`对话验收${wrapped ? "显式包装" : "完整参数"}JSON单轮执行原正式校验，不扩原三轮`, async () => {
  const fake = model(async ({ session }) => {
    const args = { results: [item()] };
    (session.messages ??= []).push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify(wrapped
      ? { submission: { name: "submit_conversation_verification", arguments: args } } : args) }] });
  });
  const output = await verifyConversationTurn({ ...observed(), sessionFactory: fake.factory });
  assert.equal(output.results[0].status, "passed"); assert.equal(fake.records[0].prompts.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(output.evidence.decisions)), [item()]);
  assert.equal(Object.getPrototypeOf(output.evidence.decisions[0]), null);
});

test("结构化语义拒绝在原独立会话反馈，不能把伪造引文保存为验收证据", async () => {
  const fake = model(async ({ record, session }) => {
    const bad = record.prompts.length === 1;
    if (!bad) {
      const feedback = record.prompts.at(-1);
      assert.match(feedback.structuredSubmissionFeedback, /逐字存在/u);
      assert.equal(feedback.observationHash, record.prompts[0].observationHash);
      assert.equal(feedback.remainingModelCalls, 2); assert.doesNotMatch(JSON.stringify(feedback), /PRIVATE_FAKE_QUOTE/u);
    }
    const args = { results: [bad ? item({ quotes: [{ source: "message", quote: "PRIVATE_FAKE_QUOTE" },
      { source: "reply", quote: "请先提供" }] }) : item()] };
    (session.messages ??= []).push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify({
      submission: { name: "submit_conversation_verification", arguments: args } }) }] });
  });
  const input = observed(), before = structuredClone(input), result = await verifyConversationTurn({ ...input, sessionFactory: fake.factory });
  assert.equal(fake.records.length, 1); assert.equal(fake.records[0].prompts.length, 2); assert.equal(result.results[0].status, "passed");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_FAKE_QUOTE/u); assert.deepEqual(input, before);
});

test("重复语义错误的完整JSON只用原三轮，未通过的判断不成为实际验收", async () => {
  const fake = model(async ({ record, session }) => {
    if (record.prompts.length > 1) assert.match(record.prompts.at(-1).structuredSubmissionFeedback, /本轮已触发/u);
    (session.messages ??= []).push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ results: [item({ triggered: false })] }) }] });
  });
  const result = await verifyConversationTurn({ ...observed(), sessionFactory: fake.factory });
  assert.equal(fake.records[0].prompts.length, 3); assert.equal(result.results[0].status, "not_run");
  assert.equal(result.evidence.stopReason, "evaluation_incomplete"); assert.equal(result.evidence.decisions[0].triggered, false);
});

test("结构化通道不执行其他工具、噪声、围栏、额外字段或异常结束的完整JSON", async () => {
  const good = JSON.stringify({ results: [item()] });
  const messages = [
    { text: "说明" + good }, { text: good + "说明" }, { text: "```json\n" + good + "\n```" },
    { text: JSON.stringify({ submission: { name: "read_file", arguments: { results: [item()] } } }) },
    { text: JSON.stringify({ submission: { name: "submit_conversation_verification", arguments: { results: [item()] }, extra: true } }) },
    { text: JSON.stringify({ results: [item()], extra: true }) },
    ...["length", "error", "aborted"].map((stopReason) => ({ text: good, stopReason })),
  ];
  for (const response of messages) {
    const fake = model(async ({ session }) => {
      (session.messages ??= []).push({ role: "assistant", stopReason: response.stopReason ?? "stop", content: [{ type: "text", text: response.text }] });
    });
    const output = await verifyConversationTurn({ ...observed(), sessionFactory: fake.factory });
    assert.equal(output.results[0].status, "not_run"); assert.equal(fake.records[0].prompts.length, 3);
    assert.deepEqual(fake.records[0].options.customTools.map(({ name }) => name), ["submit_conversation_verification"]);
  }
});

test("不读取opaque思考正文，只接受本轮唯一文本且不复用历史回复", async () => {
  let thinkingReads = 0;
  const fake = model(async ({ session }) => {
    (session.messages ??= []).push({ role: "assistant", stopReason: "stop", content: [
      { type: "thinking", get thinking() { thinkingReads++; throw new Error("PRIVATE_THINKING"); } },
      { type: "text", text: JSON.stringify({ results: [item()] }) },
    ] });
  });
  assert.equal((await verifyConversationTurn({ ...observed(), sessionFactory: fake.factory })).results[0].status, "passed");
  assert.equal(thinkingReads, 0); assert.equal(fake.records[0].prompts.length, 1);
  const old = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ results: [item()] }) }] };
  let calls = 0, disposed = false;
  const stale = await verifyConversationTurn({ ...observed(), sessionFactory: async (options) => ({ messages: [old], modelCallAccounting: true,
    async prompt() { calls++; options.onModelCall(); }, dispose() { disposed = true; } }) });
  assert.equal(stale.results[0].status, "not_run"); assert.equal(calls, 3); assert.equal(disposed, true);
  for (const extra of [{ type: "toolCall", name: "submit_conversation_verification" }, { type: "image", data: "PRIVATE_SCREENSHOT" },
    { type: "text", text: "额外说明" }]) {
    const mixed = model(async ({ session }) => {
      (session.messages ??= []).push({ role: "assistant", stopReason: "stop", content: [...old.content, extra] });
    });
    const result = await verifyConversationTurn({ ...observed(), sessionFactory: mixed.factory });
    assert.equal(result.results[0].status, "not_run"); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SCREENSHOT/u);
  }
});

test("结构化结果返回时取消仍优先传播，不形成新的通过记录", async () => {
  const controller = new AbortController();
  const fake = model(async ({ session }) => {
    (session.messages ??= []).push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ results: [item()] }) }] });
    controller.abort();
  });
  await assert.rejects(verifyConversationTurn({ ...observed(), sessionFactory: fake.factory, signal: controller.signal }), { name: "AbortError" });
  assert.equal(fake.records[0].prompts.length, 1); assert.equal(fake.records[0].disposed, true);
});

test("独立对话验收仅有提交工具，真实引用与精确冻结验收共同绑定证据摘要", async () => {
  const fake = model(async ({ tool }) => tool.execute("submit", { results: [item()] }));
  const input = observed(), result = await verifyConversationTurn({ ...input, sessionFactory: fake.factory });
  assert.deepEqual(fake.records[0].options.customTools.map((tool) => tool.name), ["submit_conversation_verification"]);
  assert.match(fake.records[0].options.systemPrompt, /role=conversation-verifier，submitName=submit_conversation_verification/u);
  assert.match(fake.records[0].options.systemPrompt, /结构化结果也是本阶段正式提交通道/u);
  assert.match(fake.records[0].options.systemPrompt, /读取、写文件、搜索及外部操作必须实际调用工具/u);
  assert.equal(fake.records[0].options.reasoningMode, "off");
  assert.equal(fake.records[0].options.maxOutputTokens, 4096);
  assert.equal(fake.records[0].options.sessionStorage, undefined); assert.equal(fake.records[0].disposed, true); assert.equal(fake.records[0].compaction, false);
  assert.equal(result.mode, "actual"); assert.equal(result.results[0].status, "passed");
  assert.equal(result.observationHash, acceptanceEvidenceHash({ schemaVersion: 1, observation: input.message && { message: input.message, reply: input.reply, toolEvidence: input.toolEvidence } }));
  assert.equal(result.results[0].evidenceHash, acceptanceEvidenceHash({ schemaVersion: 1, observationHash: result.observationHash, acceptance: input.acceptance[0], decision: item() }));
  const altered = observed(); altered.acceptance[0].expected = "另一个更严格的交付要求";
  const changed = await verifyConversationTurn({ ...altered, sessionFactory: fake.factory });
  assert.equal(changed.observationHash, result.observationHash); assert.notEqual(changed.results[0].evidenceHash, result.results[0].evidenceHash);
});

test("同轮未触发的场景保留not_run，实际失败与通过分别记录", async () => {
  const input = observed(); input.acceptance.push(acceptance("tool_failed"), acceptance("irrelevant"));
  input.toolEvidence = [{ tool: "run_application_action", result: { status: "failed", reason: "input_required" } }];
  const fake = model(async ({ tool }) => tool.execute("submit", { results: [item(), item({ acceptanceId: "tool_failed", status: "failed",
    reason: "实际回执失败。", quotes: [{ source: "message", quote: "分析" }, { source: "toolEvidence", quote: '"status":"failed"' }] }),
  item({ acceptanceId: "irrelevant", status: "not_run", triggered: false, reason: "本轮未触发该场景。", quotes: [] })] }));
  const result = await verifyConversationTurn({ ...input, sessionFactory: fake.factory });
  assert.deepEqual(result.results.map((entry) => entry.status), ["passed", "failed", "not_run"]);
});

test("伪造引文、错误来源、未触发却判通过与重复验收均不能形成通过证据", async () => {
  for (const result of [item({ quotes: [{ source: "message", quote: "PRIVATE_FAKE" }, { source: "reply", quote: "请先提供" }] }),
    item({ triggered: false }), item({ quotes: [{ source: "message", quote: "请先提供" }, { source: "reply", quote: "请先提供" }] }),
    item({ quotes: [{ source: "message", quote: "帮我分析一下" }] }), item({ reason: " " })]) {
    const fake = model(async ({ tool }) => { await assert.rejects(tool.execute("bad", { results: [result] })); });
    const output = await verifyConversationTurn({ ...observed(), sessionFactory: fake.factory });
    assert.equal(fake.records[0].prompts.length, 3); assert.equal(output.results[0].status, "not_run");
    assert.doesNotMatch(JSON.stringify(output), /PRIVATE_FAKE/);
  }
  const input = observed(); input.acceptance.push(acceptance("another"));
  const fake = model(async ({ tool }) => { await assert.rejects(tool.execute("bad", { results: [item(), item()] })); });
  assert.deepEqual((await verifyConversationTurn({ ...input, sessionFactory: fake.factory })).results.map((entry) => entry.status), ["not_run", "not_run"]);
});

test("相同独立会话内可纠正一次错误引用，不读取开发或运行会话历史", async () => {
  const fake = model(async ({ record, tool }) => {
    if (record.prompts.length === 1) await assert.rejects(tool.execute("bad", { results: [item({ quotes: [] })] }));
    else await tool.execute("good", { results: [item()] });
  });
  const output = await verifyConversationTurn({ ...observed(), sessionFactory: fake.factory });
  assert.equal(fake.records.length, 1); assert.equal(fake.records[0].prompts.length, 2); assert.equal(output.results[0].status, "passed");
});

test("调用预算覆盖SDK自动续轮与重试，模型故障降级not_run且不暴露异常正文", async () => {
  let actualCalls = 0;
  const fake = model(async ({ options }) => {
    for (let index = 0; index < 5; index++) { await options.onModelCall(); actualCalls++; }
  });
  const output = await verifyConversationTurn({ ...observed(), sessionFactory: fake.factory });
  assert.equal(actualCalls, 2, "prompt已扣除一次，剩余只允许两次续轮"); assert.equal(output.results[0].status, "not_run");
  assert.equal(output.evidence.stopReason, "model_budget_exhausted");
  const failed = await verifyConversationTurn({ ...observed(), sessionFactory: async () => { throw new Error("PRIVATE_PROVIDER_TOKEN"); } });
  assert.equal(failed.results[0].status, "not_run"); assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_PROVIDER_TOKEN/);
});

test("取消传播并清理独立会话；已经取消时不创建新会话", async () => {
  const controller = new AbortController();
  const fake = model(async ({ record }) => {
    await new Promise((resolve) => { record.release = resolve; controller.abort(); });
  });
  await assert.rejects(verifyConversationTurn({ ...observed(), sessionFactory: fake.factory, signal: controller.signal }), { name: "AbortError" });
  assert.equal(fake.records[0].aborted, true); assert.equal(fake.records[0].disposed, true);
  await assert.rejects(verifyConversationTurn({ ...observed(), sessionFactory: fake.factory, signal: controller.signal }), { name: "AbortError" });
  assert.equal(fake.records.length, 1);
});

test("过大观察不截断或发送，错误验收负责方不冒充实际通过", async () => {
  const input = observed(); input.message = "长".repeat(20000);
  let calls = 0;
  const oversized = await verifyConversationTurn({ ...input, sessionFactory: async () => { calls++; } });
  assert.equal(calls, 0); assert.equal(oversized.results[0].status, "not_run"); assert.equal(oversized.evidence.stopReason, "observation_too_large");
  const invalid = observed(); invalid.acceptance[0].verification = { stage: "activation", owner: "platform", adapterId: "host-files" };
  const result = await verifyConversationTurn({ ...invalid, sessionFactory: async () => { calls++; } });
  assert.equal(calls, 0); assert.equal(result.results[0].status, "not_run"); assert.equal(result.evidence.stopReason, "invalid_acceptance_scope");
});

test("真实Pi独立观察的原生工具和结构化结果共用正式校验及原三次请求预算", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-conversation-check-")), requests = [];
  let alwaysInvalid = false, responseMode = "tool", structuredRequests = 0;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
    if (responseMode !== "tool") structuredRequests++;
    const result = alwaysInvalid || requests.length === 1 || responseMode === "repair" && structuredRequests === 1 ? item({ quotes: [] }) : item();
    const args = { results: [result] }, delta = responseMode === "tool"
      ? { role: "assistant", tool_calls: [{ index: 0, id: `submit-${requests.length}`, type: "function", function: {
        name: "submit_conversation_verification", arguments: JSON.stringify(args) } }] }
      : { role: "assistant", content: JSON.stringify(responseMode === "repair" && structuredRequests > 1
        ? { submission: { name: "submit_conversation_verification", arguments: args } } : args) };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "local-verification", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0,
      delta, finish_reason: responseMode === "tool" ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const config = { chatUrl: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, model: "fixture-model", apiKey: "fixture-only" };
  const result = await verifyConversationTurn({ ...observed(), config, cwd: root, dataDir: root });
  assert.equal(result.results[0].status, "passed"); assert.equal(requests.length, 2);
  for (const request of requests) assert.deepEqual(request.tools.map((tool) => tool.function.name), ["submit_conversation_verification"]);
  assert.ok(requests[1].messages.some((message) => message.role === "tool" && message.content.includes("未触发或证据不足")));
  alwaysInvalid = true;
  const incomplete = await verifyConversationTurn({ ...observed(), config, cwd: root, dataDir: root });
  assert.equal(requests.length, 5, "新独立会话只发送3次实际模型请求，不执行第4次");
  assert.equal(incomplete.results[0].status, "not_run"); assert.equal(incomplete.evidence.stopReason, "model_budget_exhausted");
  assert.equal(requests[2].messages.filter((message) => message.role === "tool").length, 0, "新评审不继承前次工具或模型历史");
  alwaysInvalid = false; responseMode = "direct";
  const sessionFactory = async (options) => { assert.equal(options.reasoningMode, "off"); return createPiSession(options); };
  const direct = await verifyConversationTurn({ ...observed(), config, cwd: root, dataDir: root, sessionFactory });
  assert.equal(direct.results[0].status, "passed"); assert.equal(structuredRequests, 1); assert.equal(requests.length, 6);
  responseMode = "repair"; structuredRequests = 0;
  const repaired = await verifyConversationTurn({ ...observed(), config, cwd: root, dataDir: root, sessionFactory });
  assert.equal(repaired.results[0].status, "passed"); assert.equal(structuredRequests, 2); assert.equal(requests.length, 8);
  const correctionMessage = requests[7].messages.findLast((message) => message.role === "user").content;
  const correction = JSON.parse(typeof correctionMessage === "string" ? correctionMessage
    : correctionMessage.filter((entry) => entry.type === "text").map((entry) => entry.text).join("\n"));
  assert.match(correction.structuredSubmissionFeedback, /本轮已触发/u); assert.equal(correction.remainingModelCalls, 2);
  responseMode = "direct"; structuredRequests = 0; alwaysInvalid = true;
  const rejected = await verifyConversationTurn({ ...observed(), config, cwd: root, dataDir: root, sessionFactory });
  assert.equal(rejected.results[0].status, "not_run"); assert.equal(rejected.evidence.stopReason, "evaluation_incomplete");
  assert.equal(structuredRequests, 3); assert.equal(requests.length, 11, "完整JSON语义拒绝仍不能发送本轮第4次请求");
});

test("强制思考模型的off由Pi降至最低支持档，无正文仍在原三轮内保留待验收", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-conversation-forced-thinking-")), requests = [], sessions = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "local-forced-thinking", choices: [{ index: 0,
      delta: { role: "assistant", reasoning_content: "OPAQUE_FORCED_THOUGHT" }, finish_reason: "length" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const target = { chatUrl: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, model: "forced-thinking-fixture" };
  const config = { ...target, apiKey: "fixture-only", modelProfile: { schemaVersion: 1, target, api: "openai-completions",
    contextWindow: 65536, maxOutputTokens: 16384, reasoning: true, input: ["text"],
    compat: { maxTokensField: "max_tokens", thinkingFormat: "deepseek", supportsReasoningEffort: true },
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null } } };
  const result = await verifyConversationTurn({ ...observed(), config, cwd: root, dataDir: root, sessionFactory: async (options) => {
    assert.equal(options.reasoningMode, "off"); assert.equal(options.maxOutputTokens, 16384);
    const session = await createPiSession(options); sessions.push(session);
    assert.equal(session.thinkingLevel, "low"); return session;
  } });
  assert.equal(sessions.length, 1); assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.thinking.type, "enabled"); assert.equal(request.reasoning_effort, "low"); assert.equal(request.max_tokens, 16384);
  }
  assert.equal(result.results[0].status, "not_run"); assert.equal(result.evidence.stopReason, "evaluation_incomplete");
  assert.equal(result.evidence.decisions[0].triggered, false); assert.doesNotMatch(JSON.stringify(result), /OPAQUE_FORCED_THOUGHT/u);
});
