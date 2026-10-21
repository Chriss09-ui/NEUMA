import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchitectureDesigner } from "../src/architecture/architecture.mjs";
import { createPiSession } from "../src/runtime/pi-runtime.mjs";
import { designSubmissionSchema, requirementItems, validateDesign } from "../src/architecture/architecture-contract.mjs";
import { validDraft, validDesign } from "./helpers/architecture.mjs";

const parameters = { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "string" } } };
const names = { designer: "submit_architecture", reviewer: "submit_architecture_review", specialist: "submit_module_design" };
const messageText = (content) => typeof content === "string" ? content : content.filter((entry) => entry.type === "text").map((entry) => entry.text).join("\n");
const lastUser = (body) => JSON.parse(messageText(body.messages.findLast((entry) => entry.role === "user").content));
const toolText = (body) => {
  const content = body.messages.findLast((entry) => entry.role === "tool").content;
  return typeof content === "string" ? content : content.filter((entry) => entry.type === "text").map((entry) => entry.text).join("\n");
};

async function actualPi(t, respond) {
  const root = await mkdtemp(join(tmpdir(), "neuma-architecture-continuation-")), requests = [], sessions = [], reasoningModes = [];
  const model = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
      const next = await respond(body, requests.length);
      if (next.kind === "http_error") {
        response.writeHead(503, { "content-type": "application/json" }); response.end('{"error":{"message":"fixture model failure"}}'); return;
      }
      const delta = next.kind === "tool" ? { role: "assistant", tool_calls: [{ index: 0, id: `continue_${requests.length}`, type: "function",
        function: { name: next.name, arguments: JSON.stringify(next.args) } }] } : { role: "assistant", content: next.text };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ id: "continuation-fixture", object: "chat.completion.chunk", model: "fixture-model",
        choices: [{ index: 0, delta, finish_reason: next.kind === "tool" ? "tool_calls" : next.finishReason ?? "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    } catch (error) { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: error.message } })); }
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  const designer = new ArchitectureDesigner({ config: { llmConfigured: true, model: "fixture-model", apiKey: "fixture-only",
    chatUrl: `http://127.0.0.1:${model.address().port}/v1/chat/completions` }, cwd: root, dataDir: join(root, "data"),
    sessionFactory: async (options) => {
      reasoningModes.push(options.reasoningMode);
      const session = await createPiSession(options); sessions.push(session);
      session.setAutoCompactionEnabled(false); session.setAutoRetryEnabled(false); return session;
    } });
  await designer.ready;
  t.after(async () => { await designer.persistence; model.closeAllConnections(); await new Promise((resolve) => model.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { designer, requests, sessions, reasoningModes };
}

const role = (designer, roleName = "designer", options = {}) => designer.role({ role: roleName,
  systemPrompt: "固定平台协议测试，保持同一任务及原有正式提交门槛。", payload: {}, onProgress() {}, submitName: names[roleName],
  parameters, validate: (value) => structuredClone(value), ...options });

test("已有完整候选的技术修订及子顾问请求off，新设计与模块保留auto，仍执行原正式提交门槛", async (t) => {
  for (const [roleName, edit, technicalRevision, expected] of [["designer", true, false, "off"], ["designer", false, false, "auto"],
    ["specialist", false, false, "auto"], ["specialist", false, true, "off"], ["reviewer", false, false, "off"]])
    await t.test(`${roleName}:${edit || technicalRevision ? "existing" : "new"}`, async (t) => {
      const f = await actualPi(t, (body) => {
        if (!edit) return { kind: "tool", name: names[roleName], args: { answer: "经过原校验的结果" } };
        const original = lastUser(body); assert.ok(original.editableSubmission?.submissionHash);
        return { kind: "tool", name: "revise_architecture_submission", args: { submissionHash: original.editableSubmission.submissionHash,
          updates: [{ path: "/answer", value: "经过原校验的结果" }] } };
      });
      let diagnostic;
      assert.deepEqual(await role(f.designer, roleName, { technicalRevision, ...(edit ? { editableDesign: { answer: "原技术结果" }, payload: { previousDesign: { answer: "原技术结果" } } } : {}),
        onDiagnostics: (value) => { diagnostic = value; } }), { answer: "经过原校验的结果" });
      assert.deepEqual(f.reasoningModes, [expected]); assert.equal(f.requests.length, 1);
      assert.equal(diagnostic.modelCalls, 1); assert.equal(diagnostic.localRevisions ?? 0, edit ? 1 : 0);
    });
});

for (const roleName of Object.keys(names)) {
  test(`真实Pi ${roleName}自然停在纯文字后仅提醒一次，并在原会话正式提交`, { timeout: 15000 }, async (t) => {
    const text = "仅为本地测试说明文字，不构成正式结果。";
    const f = await actualPi(t, (body, turn) => {
      if (turn === 1) return { kind: "text", text };
      assert.equal(turn, 2);
      const reminder = lastUser(body); assert.equal(reminder.type, "submission_required"); assert.equal(reminder.submitName, names[roleName]);
      assert.deepEqual(reminder.modelBudget, { limit: 5, used: 1, remaining: 4 });
      assert.ok(body.messages.some((entry) => entry.role === "assistant" && messageText(entry.content) === text));
      return { kind: "tool", name: names[roleName], args: { answer: "已正式提交" } };
    });
    let diagnostic;
    assert.deepEqual(await role(f.designer, roleName, { onDiagnostics: (value) => { diagnostic = value; } }), { answer: "已正式提交" });
    assert.equal(f.sessions.length, 1); assert.equal(f.requests.length, 2);
    assert.equal(diagnostic.modelCalls, 2); assert.equal(diagnostic.submissionContinuations, 1);
    assert.doesNotMatch(JSON.stringify(diagnostic), /仅为本地测试说明文字/u);
  });
}

test("真实Pi再次纯文字结束时以提交未完成失败，不能将正常回复当通过或新需求", { timeout: 15000 }, async (t) => {
  const f = await actualPi(t, () => ({ kind: "text", text: "仍只有未正式提交的本地说明" }));
  await assert.rejects(role(f.designer), (error) => error.diagnostic.reason === "submission_incomplete"
    && error.diagnostic.modelCalls === 2 && error.diagnostic.submissionContinuations === 1);
  assert.equal(f.requests.length, 2); assert.equal(f.sessions.length, 1);
});

test("真实Pi原5轮已耗尽的自然结束不再追加提醒或重置预算", { timeout: 15000 }, async (t) => {
  const f = await actualPi(t, (_body, turn) => turn < 5 ? { kind: "tool", name: "inspect_current", args: {} }
    : { kind: "text", text: "预算末轮仍未提交" });
  await assert.rejects(role(f.designer, "designer", { tools: [{ name: "inspect_current", label: "读取既有事实", description: "仅返回固定测试事实",
    parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => ({ content: [{ type: "text", text: "固定事实" }] }) }] }),
  (error) => error.diagnostic.reason === "turn_limit" && error.diagnostic.modelCalls === 5 && error.diagnostic.submissionContinuations === 0);
  assert.equal(f.requests.length, 5); assert.equal(f.sessions.length, 1);
});

for (const fault of ["length", "error", "cancelled"]) {
  test(`真实Pi ${fault}故障不触发自然结束续接`, { timeout: 15000 }, async (t) => {
    const controller = new AbortController();
    const f = await actualPi(t, () => {
      if (fault === "cancelled") controller.abort(new Error("fixture cancelled"));
      return fault === "error" ? { kind: "http_error" } : { kind: "text", text: "不完整测试响应", finishReason: fault === "length" ? "length" : "stop" };
    });
    await assert.rejects(role(f.designer, "designer", { signal: controller.signal }), (error) =>
      error.diagnostic.submissionContinuations === 0 && error.diagnostic.reason === (fault === "length" ? "output_limit"
        : fault === "cancelled" ? "cancelled" : "api_unavailable"));
    assert.equal(f.requests.length, 1); assert.equal(f.sessions.length, 1);
  });
}

test("真实Pi被拒稿后自然结束的提醒保留原CAS，可局部修正且完整语义检查仍生效", { timeout: 15000 }, async (t) => {
  const draft = validDraft(), requirements = requirementItems(draft), candidate = validDesign(requirements);
  candidate.steps[0].componentId = "missing"; let submissionHash;
  const f = await actualPi(t, (body, turn) => {
    if (turn === 1) return { kind: "tool", name: "submit_architecture", args: candidate };
    if (turn === 2) {
      submissionHash = toolText(body).match(/"rejectedSubmission":\{"submissionHash":"([a-f0-9]{64})"\}/u)?.[1];
      assert.ok(submissionHash); return { kind: "text", text: "需按原有反馈修复，但本次尚未提交" };
    }
    assert.equal(turn, 3);
    const reminder = lastUser(body); assert.deepEqual(reminder.rejectedSubmission, { submissionHash });
    assert.deepEqual(reminder.modelBudget, { limit: 5, used: 2, remaining: 3 });
    assert.equal(reminder.submitName, "submit_architecture"); assert.equal(reminder.design, undefined);
    return { kind: "tool", name: "revise_architecture_submission", args: { submissionHash,
      updates: [{ path: "/steps/0/componentId", value: "summarize" }] } };
  });
  let diagnostic;
  const result = await role(f.designer, "designer", { payload: { draft, requirements }, parameters: designSubmissionSchema(draft, { requirements }),
    validate: (value) => validateDesign(value, { draft, requirements }), onDiagnostics: (value) => { diagnostic = value; } });
  assert.equal(result.steps[0].componentId, "summarize"); assert.equal(candidate.steps[0].componentId, "missing");
  assert.equal(diagnostic.submissionContinuations, 1); assert.equal(diagnostic.modelCalls, 3); assert.equal(diagnostic.localRevisions, 1);
  assert.equal(f.sessions.length, 1); assert.equal(f.requests.length, 3);
});

for (const endings of [1, 2]) {
  test(`无原生计费的注入会话每次新prompt重新计费且不重复首个turn_end（每次${endings}轮）`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "neuma-architecture-fallback-")); let prompts = 0, listener = () => {}, options, diagnostic;
    const session = { messages: [], subscribe: (callback) => { listener = callback; return () => {}; }, abort: async () => {}, dispose() {},
      prompt: async () => {
        prompts++;
        if (prompts === 2) await options.customTools.find((tool) => tool.name === "submit_architecture").execute("second", { answer: "正式提交" });
        session.messages.push({ role: "assistant", stopReason: "stop", content: [] });
        for (let index = 0; index < endings; index++) listener({ type: "turn_end" });
      } };
    const designer = new ArchitectureDesigner({ config: {}, cwd: root, dataDir: join(root, "data"),
      sessionFactory: async (value) => { options = value; return session; } });
    await designer.ready; t.after(() => rm(root, { recursive: true, force: true }));
    assert.deepEqual(await role(designer, "designer", { onDiagnostics: (value) => { diagnostic = value; } }), { answer: "正式提交" });
    assert.equal(prompts, 2); assert.equal(diagnostic.modelCalls, 2 * endings); assert.equal(diagnostic.submissionContinuations, 1);
  });
}
