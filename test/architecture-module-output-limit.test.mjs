import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchitectureDesigner } from "../src/architecture/architecture.mjs";
import { createPiSession } from "../src/runtime/pi-runtime.mjs";
import { validDraft, validDesign } from "./helpers/architecture.mjs";

const assignments = [
  { question: "核对当前算式的单位", boundary: "仅依据已给平台事实", benefit: "避免单位混淆" },
  { question: "核对当前失败处理", boundary: "仅检查现有约束", benefit: "避免遗漏失败响应" },
];
const moduleResult = { proposal: "保留原单位并逐项核对。", interfaces: "沿用当前输入输出契约。", tradeoffs: "不新增依赖。", evidenceIds: [], unknowns: [] };
const text = content => typeof content === "string" ? content : content.filter(entry => entry.type === "text").map(entry => entry.text).join("\n");

async function fixture(t, { parallel = false, cancel = false, usage = true, guard = false, childGuard = false, loop = false, queued = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-module-output-limit-")), requests = [], sessions = [], progress = [], controller = new AbortController();
  const model = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
      const payload = JSON.parse(text(body.messages.findLast(entry => entry.role === "user").content));
      let delta, finish;
      if (loop) {
        delta = { role: "assistant", tool_calls: [{ index: 0, id: `inspect_fixture_${requests.length}`, type: "function", function: {
          name: "inspect_fixed", arguments: "{}" } }] }; finish = "tool_calls";
      } else if (!payload.assignment) {
        assert.equal(requests.length, 1, "子模块失败后不得追加主角色模型请求");
        delta = { role: "assistant", tool_calls: [{ index: 0, id: "delegate_fixture", type: "function", function: {
          name: "delegate_module", arguments: JSON.stringify({ modules: parallel ? assignments : [assignments[0]] }) } }] };
        if (queued) {
          const candidate = validDesign(payload.requirements, { schemaVersion: 3, connections: [],
            interaction: { defaultEntry: "conversation", page: false, operations: false, inputs: "工作记录", results: "完整周报", persistentData: "无跨任务持久数据" },
            execution: { language: "none", hosting: "builtin", reason: "使用已有文本能力" },
            selectionBasis: { capacity: "当前明确文本输入", process: "按已确认规则整理", quality: "覆盖全部进展且不编造",
              requirementIds: payload.requirements.map(item => item.id), assumptions: [] } });
          delta.tool_calls.push({ index: 1, id: "queued_fixture", type: "function", function: {
            name: queued === "delegate" ? "delegate_module" : "submit_architecture",
            arguments: JSON.stringify(queued === "delegate" ? { modules: [assignments[1]] } : candidate) } });
        }
        finish = "tool_calls";
      } else if (parallel && payload.assignment.question === assignments[0].question) {
        delta = { role: "assistant", tool_calls: [{ index: 0, id: "module_fixture", type: "function", function: {
          name: "submit_module_design", arguments: JSON.stringify(moduleResult) } }] };
        finish = "tool_calls";
      } else {
        if (cancel) controller.abort(new Error("fixture explicit cancellation"));
        delta = { role: "assistant", reasoning_content: "fixture-private-thinking-must-not-be-logged" }; finish = "length";
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "module-output-fixture", choices: [{ index: 0, delta, finish_reason: finish }],
        ...(usage && finish === "length" ? { usage: { prompt_tokens: 100, completion_tokens: 16384, total_tokens: 16484 } } : {}) })}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise(done => model.listen(0, "127.0.0.1", done));
  const target = { chatUrl: `http://127.0.0.1:${model.address().port}/v1/chat/completions`, model: "fixture-model" };
  const config = { llmConfigured: true, apiKey: "fixture-only", ...target, modelProfile: { schemaVersion: 1, target,
    api: "openai-completions", contextWindow: 262144, maxOutputTokens: 32768, reasoning: true, input: ["text"],
    compat: { maxTokensField: "max_completion_tokens", thinkingFormat: "zai", supportsReasoningEffort: true } } };
  const designer = new ArchitectureDesigner({ config, cwd: root, dataDir: join(root, "data"), sessionFactory: async options => {
    let calls = 0;
    const session = await createPiSession({ ...options, onModelCall: async event => {
      if (guard && options.customTools.some(tool => tool.name === "delegate_module") && calls > 0
        || childGuard && options.customTools.some(tool => tool.name === "submit_module_design")) throw Object.assign(new Error("fixture-private-guard-message"), {
        requestAdmission: { source: "real_test_guard", reason: "request_limit", used: 2, limit: 2 } });
      await options.onModelCall(event); calls++;
    } }); sessions.push(session);
    session.setAutoCompactionEnabled(false); session.setAutoRetryEnabled(false); return session;
  } });
  await designer.ready;
  t.after(async () => { await designer.persistence; model.closeAllConnections(); await new Promise(done => model.close(done)); await rm(root, { recursive: true, force: true }); });
  const definition = { id: "module_output_case", name: "局部输出中断", fingerprint: "fixed-requirement", draft: validDraft() };
  return { designer, definition, requests, sessions, progress,
    runRole: () => designer.role({ role: "designer", systemPrompt: "固定本地数据，只测试原十二轮限制", payload: {}, submitName: "submit_architecture",
      parameters: { type: "object", required: ["done"], additionalProperties: false, properties: { done: { type: "boolean" } } },
      validate: value => value, onProgress() {}, tools: [{ name: "inspect_fixed", label: "读取本地固定事实", description: "返回测试固定事实",
        parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => ({ content: [{ type: "text", text: "固定事实" }] }) }] }),
    run: () => designer.design(definition, { signal: controller.signal, onProgress: event => progress.push(event) }) };
}

for (const parallel of [false, true]) test(`原生Pi子模块thinking-only达到length即阻断且不追加请求（并行=${parallel}）`, { timeout: 20000 }, async t => {
  const f = await fixture(t, { parallel }); let diagnostic;
  await assert.rejects(f.run(), error => {
    diagnostic = error.diagnostic;
    return diagnostic.reason === "module_output_limit" && diagnostic.role === "designer" && diagnostic.modelCalls === 1;
  });
  assert.equal(f.requests.length, parallel ? 3 : 2);
  assert.equal(diagnostic.delegation.status, "incomplete"); assert.equal(diagnostic.delegation.retryAllowed, false);
  assert.deepEqual(diagnostic.delegation.failures.map(({ moduleId, ...entry }) => {
    assert.match(moduleId, /^module_[a-f0-9]{24}$/u); return entry;
  }), [{ role: "specialist", reason: "output_limit", validResult: false, stopReason: "length", modelCalls: 1,
    requestedMaxOutputTokens: 16384, outputTokens: 16384, outputUsageReceipts: 1 }]);
  assert.equal(diagnostic.delegation.completedModuleIds.length, parallel ? 1 : 0);
  assert.equal(diagnostic.delegation.savedModuleCount, parallel ? 1 : 0);
  assert.equal(diagnostic.requestAdmission?.requestSent, false);
  const record = await f.designer.get(f.definition.id);
  assert.equal(record.status, "failed"); assert.equal(record.delivery, "blocked"); assert.equal(record.review, null);
  assert.equal(record.design, null); assert.deepEqual(record.attempts, []); assert.deepEqual(record.diagnostic, diagnostic);
  assert.deepEqual(record.modules, parallel ? [{ assignment: assignments[0], result: moduleResult }] : []);
  assert.ok(f.progress.some(entry => entry.delegationFailure?.failures[0].stopReason === "length"));
  assert.doesNotMatch(JSON.stringify({ diagnostic, progress: f.progress }), /fixture-private-thinking|核对当前算式|fixture explicit cancellation/u);
});

test("未收到正数usage不补造子模块消耗；显式取消优先于length诊断", { timeout: 20000 }, async t => {
  await t.test("缺usage", async t => {
    const f = await fixture(t, { usage: false }); let diagnostic;
    await assert.rejects(f.run(), error => { diagnostic = error.diagnostic; return diagnostic.reason === "module_output_limit"; });
    assert.equal(Object.hasOwn(diagnostic.delegation.failures[0], "outputTokens"), false);
    assert.equal(Object.hasOwn(diagnostic.delegation.failures[0], "outputUsageReceipts"), false);
    assert.equal(f.requests.length, 2);
  });
  await t.test("显式取消", async t => {
    const f = await fixture(t, { cancel: true });
    await assert.rejects(f.run(), error => error.diagnostic.reason === "cancelled");
    const record = await f.designer.get(f.definition.id);
    assert.equal(record.status, "cancelled"); assert.deepEqual(record.modules, []); assert.equal(record.review, null);
    assert.equal(f.requests.length, 2);
  });
});

test("子length之后测试护栏拒发下一请求，保留原子原因并单列本地准入", { timeout: 20000 }, async t => {
  const f = await fixture(t, { guard: true }); let diagnostic;
  await assert.rejects(f.run(), error => { diagnostic = error.diagnostic; return diagnostic.reason === "module_output_limit"; });
  assert.equal(f.requests.length, 2); assert.equal(diagnostic.delegation.failures[0].stopReason, "length");
  assert.deepEqual(diagnostic.requestAdmission, { reason: "request_blocked", requestSent: false, source: "real_test_guard",
    causeReason: "request_limit", purpose: "agent", retryAttempt: 0, used: 2, limit: 2 });
  assert.doesNotMatch(JSON.stringify(diagnostic), /fixture-private-guard-message|api_error|unknown_tool_error/u);
});

test("原生Pi产品原五轮限制保留turn_limit主因，拒发证据单列且不执行第六个请求", { timeout: 20000 }, async t => {
  const f = await fixture(t, { loop: true }); let diagnostic;
  await assert.rejects(f.runRole(), error => { diagnostic = error.diagnostic; return diagnostic.reason === "turn_limit"; });
  assert.equal(f.requests.length, 5); assert.equal(diagnostic.modelCalls, 5);
  assert.deepEqual(diagnostic.requestAdmission, { reason: "request_blocked", requestSent: false, source: "model_call_policy",
    causeReason: "turn_limit", purpose: "agent", retryAttempt: 0 });
});

test("子会话被本地护栏拒发保留子准入来源，不改成供应商接口故障", { timeout: 20000 }, async t => {
  const f = await fixture(t, { childGuard: true }); let diagnostic;
  await assert.rejects(f.run(), error => { diagnostic = error.diagnostic; return diagnostic.reason === "module_failed"; });
  assert.equal(f.requests.length, 1); assert.equal(diagnostic.delegation.failures[0].reason, "request_blocked");
  assert.deepEqual(diagnostic.delegation.failures[0].requestAdmission, { reason: "request_blocked", requestSent: false, source: "real_test_guard",
    causeReason: "request_limit", purpose: "agent", retryAttempt: 0, used: 2, limit: 2 });
  assert.doesNotMatch(JSON.stringify(diagnostic), /fixture-private-guard-message|api_error|unknown_tool_error/u);
});

for (const queued of ["delegate", "submit"]) test(`同一原生回复首个子模块length后不再执行已排队的${queued}`, { timeout: 20000 }, async t => {
  const f = await fixture(t, { queued }); let diagnostic;
  await assert.rejects(f.run(), error => { diagnostic = error.diagnostic; return diagnostic.reason === "module_output_limit"; });
  assert.equal(f.requests.length, 2); assert.equal(f.sessions.length, 2);
  assert.equal(diagnostic.delegation.failures.length, 1); assert.equal(diagnostic.delegation.failures[0].stopReason, "length");
  assert.equal(diagnostic.delegation.failures[0].outputTokens, 16384);
  assert.equal(f.progress.filter(entry => entry.delegationFailure).length, 1);
  const queuedResult = f.sessions[0].messages.find(entry => entry.role === "toolResult" && entry.toolCallId === "queued_fixture");
  assert.ok(queuedResult); assert.equal(queuedResult.isError, true);
  assert.match(text(queuedResult.content), /局部顾问已用完本轮输出额度/u);
  assert.doesNotMatch(text(queuedResult.content), /结构校验|Validation failed|unknown_tool_error/u);
  const record = await f.designer.get(f.definition.id);
  assert.equal(record.status, "failed"); assert.equal(record.design, null); assert.equal(record.review, null);
  assert.deepEqual(record.attempts, []); assert.deepEqual(record.modules, []);
});
