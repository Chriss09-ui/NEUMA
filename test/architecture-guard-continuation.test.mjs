import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { verifyRequirementFidelity } from "../src/architecture/requirement-fidelity.mjs";
import { verifyArchitectureHandoff } from "../src/architecture/architecture-handoff-verification.mjs";
import { InputError } from "../src/requirements/core.mjs";
import { fidelityResult } from "./helpers/fidelity.mjs";

const context = { requirements: [{ id: "input", text: "保留原始输入范围" }], candidate: { instructions: "保留原始输入范围" } };
const proposal = { id: "choice", question: "是否需要更改范围", impact: "改变业务承诺", requirementIds: ["input"],
  references: [{ source: "requirements", path: "/0/text", quote: context.requirements[0].text }] };
const guards = [
  { name: "范围复核", invoke: (options) => verifyRequirementFidelity({ context, config: {}, cwd: "/tmp", dataDir: "/tmp", ...options }),
    result: (payload) => fidelityResult(payload), incomplete: "scope_evaluation_incomplete" },
  { name: "返需复核", invoke: (options) => verifyArchitectureHandoff({ issues: [proposal], context, config: {}, cwd: "/tmp", dataDir: "/tmp", ...options }),
    result: (payload) => ({ contextHash: payload.contextHash, decisions: [{ issueId: "choice", classification: "already_answered", reason: "原范围已明确",
      references: proposal.references }] }), incomplete: "handoff_evaluation_incomplete" },
];

for (const guard of guards) {
  test(`${guard.name}正常stop后仅同会话提醒一次，共享原两次额度`, async () => {
    for (const accounting of [true, false]) {
      let sessions = 0, prompts = 0, charges = 0, initial;
      const result = await guard.invoke({ charge() { charges++; }, sessionFactory: async (options) => {
        sessions++; const messages = [];
        return { modelCallAccounting: accounting, messages, dispose() {}, async prompt(text) {
          if (accounting) await options.onModelCall();
          const payload = JSON.parse(text); prompts++;
          if (prompts === 1) { initial = payload; messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "已阅读" }] }); return; }
          assert.equal(payload.contextHash, initial.contextHash); assert.match(payload.correction, /尚未收到/);
          assert.equal(Object.hasOwn(payload, "requirements"), false, "沿用原会话，不重传或改写完整证据");
          await options.customTools[0].execute("final", guard.result(initial));
        } };
      } });
      assert.equal(result.modelCalls, 2); assert.equal(charges, 2); assert.equal(prompts, 2); assert.equal(sessions, 1);
    }
  });

  test(`${guard.name}连续不提交、错误、截断、取消不无限续接或假通过`, async () => {
    for (const reason of ["stop", "error", "length", "aborted"]) {
      let prompts = 0;
      await assert.rejects(guard.invoke({ sessionFactory: async (options) => {
        const messages = [];
        return { modelCallAccounting: true, messages, dispose() {}, async prompt() {
          await options.onModelCall(); prompts++; messages.push({ role: "assistant", stopReason: reason });
        } };
      } }), (error) => error.reason === guard.incomplete && error.modelCalls === (reason === "stop" ? 2 : 1));
      assert.equal(prompts, reason === "stop" ? 2 : 1);
    }
    const controller = new AbortController(), cancelled = new Error("fixture-cancelled"); let prompts = 0;
    await assert.rejects(guard.invoke({ signal: controller.signal, sessionFactory: async (options) => ({ modelCallAccounting: true,
      messages: [], dispose() {}, async abort() {}, async prompt() { await options.onModelCall(); prompts++; controller.abort(cancelled); } }) }),
    (error) => error === cancelled);
    assert.equal(prompts, 1);
  });

  test(`${guard.name}提醒请求仍受总预算约束，不将剩余不足当作用户缺口`, async () => {
    let charges = 0, prompts = 0;
    const stop = Object.assign(new InputError("共享预算已用完"), { reason: "turn_limit" });
    await assert.rejects(guard.invoke({ charge() { if (++charges === 2) throw stop; }, sessionFactory: async (options) => {
      const messages = [];
      return { modelCallAccounting: true, messages, dispose() {},
        async prompt() { await options.onModelCall(); prompts++; messages.push({ role: "assistant", stopReason: "stop", content: [] }); },
      };
    } }), (error) => error === stop);
    assert.equal(charges, 2); assert.equal(prompts, 1);
  });

  test(`${guard.name}真实Pi正常stop由同一历史续接正式提交`, { timeout: 15000 }, async (t) => {
    let requests = 0, initial;
    const server = createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); requests++;
      const user = body.messages.findLast((message) => message.role === "user").content;
      const payload = JSON.parse(typeof user === "string" ? user : user.filter((item) => item.type === "text").map((item) => item.text).join(""));
      let delta, finish;
      if (requests === 1) { initial = payload; delta = { role: "assistant", content: "已核对，尚未正式提交。" }; finish = "stop"; }
      else {
        assert.equal(requests, 2); assert.ok(body.messages.some((message) => message.role === "assistant"));
        assert.equal(payload.contextHash, initial.contextHash);
        delta = { role: "assistant", tool_calls: [{ index: 0, id: "final", type: "function", function: { name: body.tools[0].function.name,
          arguments: JSON.stringify(guard.result(initial)) } }] }; finish = "tool_calls";
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "continuation", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
    const result = await guard.invoke({ config: { chatUrl: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, model: "fixture", apiKey: "fixture-only" } });
    assert.equal(result.modelCalls, 2); assert.equal(requests, 2);
  });
}
