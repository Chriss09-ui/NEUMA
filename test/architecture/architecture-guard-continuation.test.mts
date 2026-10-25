import {fixtureToolAt,callFixture} from "../helpers/m7-test-boundaries.mjs";
import {fixturePort,fixtureText} from "../helpers/http-model.mjs";
import type {VerificationSessionFactory,SessionMessage} from "../../src/runtime/pi-port.mjs";
import { fixtureChatRequest } from "../helpers/http-model.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import type { PiSessionOptions } from "../../src/runtime/pi-port.mjs";
import { failureFields } from "../helpers/failure-fields.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { verifyRequirementFidelity, type FidelityOptions } from "../../src/architecture/requirement-fidelity.mjs";
import { verifyArchitectureHandoff } from "../../src/architecture/architecture-handoff-verification.mjs";
import { InputError } from "../../src/requirements/core.mjs";
import { fidelityResult } from "../helpers/fidelity.mjs";

const context = { requirements: [{ id: "input", text: "保留原始输入范围" }], candidate: { instructions: "保留原始输入范围" } };
const proposal = { id: "choice", question: "是否需要更改范围", impact: "改变业务承诺", requirementIds: ["input"],
  references: [{ source: "requirements", path: "/0/text", quote: context.requirements[0]!.text }] };
const guards = [
  { name: "范围复核", invoke: (options: Partial<FidelityOptions>) => verifyRequirementFidelity({ context, config: {}, cwd: "/tmp", dataDir: "/tmp", ...options }),
    result: (payload: unknown) => fidelityResult(payload), incomplete: "scope_evaluation_incomplete" },
  { name: "返需复核", invoke: (options:Partial<FidelityOptions>) => callFixture(verifyArchitectureHandoff,undefined,[{ issues: [proposal], context, config: {}, cwd: "/tmp", dataDir: "/tmp", ...options }]),
    result: (payload:unknown) => ({ contextHash: objectFields(payload).contextHash, decisions: [{ issueId: "choice", classification: "already_answered", reason: "原范围已明确",
      references: proposal.references }] }), incomplete: "handoff_evaluation_incomplete" },
];

for (const guard of guards) {
  test(`${guard.name}正常stop后仅同会话提醒一次，共享原两次额度`, async () => {
    for (const accounting of [true, false]) {
      let sessions = 0, prompts = 0, charges = 0, initial: unknown;
      const result = await guard.invoke({ charge() { charges++; }, sessionFactory: async (options: PiSessionOptions) => {
        sessions++; const messages:SessionMessage[] = [];
        return { modelCallAccounting: accounting, messages, dispose() {}, async prompt(text: string) {
          if (accounting) await options.onModelCall!();
          const payload = JSON.parse(text); prompts++;
          if (prompts === 1) { initial = payload; messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "已阅读" }] }); return; }
          assert.equal(payload.contextHash, objectFields(initial).contextHash); assert.match(payload.correction, /尚未收到/);
          assert.equal(Object.hasOwn(payload, "requirements"), false, "沿用原会话，不重传或改写完整证据");
          await fixtureToolAt(options.customTools!,0).execute("final", guard.result(initial));
        } };
      } });
      assert.equal(result.modelCalls, 2); assert.equal(charges, 2); assert.equal(prompts, 2); assert.equal(sessions, 1);
    }
  });

  test(`${guard.name}连续不提交、错误、截断、取消不无限续接或假通过`, async () => {
    for (const reason of ["stop", "error", "length", "aborted"]) {
      let prompts = 0;
      await assert.rejects(guard.invoke({ sessionFactory: async (options) => {
        const messages: { role: string; stopReason: string; }[] = [];
        return { modelCallAccounting: true, messages, dispose() {}, async prompt() {
          await options.onModelCall!(); prompts++; messages.push({ role: "assistant", stopReason: reason });
        } };
      } }), (error) => failureFields(error).reason === guard.incomplete && failureFields(error).modelCalls === (reason === "stop" ? 2 : 1));
      assert.equal(prompts, reason === "stop" ? 2 : 1);
    }
    const controller = new AbortController(), cancelled = new Error("fixture-cancelled"); let prompts = 0;
    await assert.rejects(guard.invoke({ signal: controller.signal, sessionFactory: async (options) => ({ modelCallAccounting: true,
      messages: [], dispose() {}, async abort() {}, async prompt() { await options.onModelCall!(); prompts++; controller.abort(cancelled); } }) }),
    (error) => error === cancelled);
    assert.equal(prompts, 1);
  });

  test(`${guard.name}提醒请求仍受总预算约束，不将剩余不足当作用户缺口`, async () => {
    let charges = 0, prompts = 0;
    const stop = Object.assign(new InputError("共享预算已用完"), { reason: "turn_limit" });
    await assert.rejects(guard.invoke({ charge() { if (++charges === 2) throw stop; }, sessionFactory: async (options) => {
      const messages: { role: string; stopReason: string; content: never[]; }[] = [];
      return { modelCallAccounting: true, messages, dispose() {},
        async prompt() { await options.onModelCall!(); prompts++; messages.push({ role: "assistant", stopReason: "stop", content: [] }); },
      };
    } }), (error) => error === stop);
    assert.equal(charges, 2); assert.equal(prompts, 1);
  });

  test(`${guard.name}真实Pi正常stop由同一历史续接正式提交`, { timeout: 15000 }, async (t) => {
    let requests = 0, initial: unknown;
    const server = createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = fixtureChatRequest(Buffer.concat(chunks).toString("utf8")); requests++;
      const user = body.messages.findLast((message: { role: string; }) => message.role === "user")!.content;
      const payload = JSON.parse(fixtureText(user));
      let delta, finish;
      if (requests === 1) { initial = payload; delta = { role: "assistant", content: "已核对，尚未正式提交。" }; finish = "stop"; }
      else {
        assert.equal(requests, 2); assert.ok(body.messages.some((message: { role: string; }) => message.role === "assistant"));
        assert.equal(payload.contextHash, objectFields(initial).contextHash);
        delta = { role: "assistant", tool_calls: [{ index: 0, id: "final", type: "function", function: { name: body.tools![0]!.function.name,
          arguments: JSON.stringify(guard.result(initial)) } }] }; finish = "tool_calls";
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "continuation", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
    const result = await guard.invoke({ config: { chatUrl: `http://127.0.0.1:${fixturePort(server)}/v1/chat/completions`, model: "fixture", apiKey: "fixture-only" } });
    assert.equal(result.modelCalls, 2); assert.equal(requests, 2);
  });
}
