import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchitectureDesigner } from "../../src/architecture/architecture.mjs";
import { createExecutionSession } from "../../src/runtime/execution-runtime.mjs";
import { SessionReplay } from "../helpers/session-replay.mjs";
import { fixtureChatRequest, fixturePort } from "../helpers/http-model.mjs";
import type { SessionEvent } from "../../src/runtime/execution-port.mjs";

for (const mode of ["repair", "unsubmitted"]) test(`自有运行接口离线回放 ${mode}，真实控制器决定提交与预算`, { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "neuma-execution-contract-"));
  const answers = mode === "repair" ? [
    { tool_calls: [{ index: 0, id: "invalid", type: "function", function: { name: "submit_architecture", arguments: '{"value":"wrong"}' } }] },
    { tool_calls: [{ index: 0, id: "valid", type: "function", function: { name: "submit_architecture", arguments: '{"value":42}' } }] },
  ] : [{ content: "我已经思考完毕，但没有正式提交。" }];
  const replay = new SessionReplay({ version: 1, kind: "synthetic", complete: true, changes: "合成协议与参数修正轨迹", protocol: "neuma-execution-v1" },
    answers.map(answer => ({ role: "designer", stage: "design", tools: ["submit_architecture"], context: ["synthetic-binding"], answer })));
  let requests = 0, submitted = 0;
  const events: SessionEvent[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk); requests++;
    try {
      const answer = replay.next("designer", "design", fixtureChatRequest(Buffer.concat(chunks).toString()));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "synthetic", choices: [{ index: 0, delta: { role: "assistant", ...answer }, finish_reason: "tool_calls" in answer ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
    } catch { response.writeHead(400); response.end("Replay contract mismatch"); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const designer = new ArchitectureDesigner({ config: { llmConfigured: true, model: "synthetic", modelAuthType: "none", chatUrl: `http://127.0.0.1:${fixturePort(server)}/v1/chat/completions` }, cwd: root, dataDir: root,
    sessionFactory: async options => {
      const session = await createExecutionSession(options);
      assert.equal("sessionManager" in session, false); assert.equal("settingsManager" in session, false);
      session.subscribe!(event => events.push(event)); return session;
    } });
  await designer.ready;
  const run = designer.role({ role: "designer", systemPrompt: "synthetic-binding", payload: { requirements: [{ id: "r", text: "synthetic-binding" }] },
    submitName: "submit_architecture", parameters: { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false },
    initialModelCalls: mode === "unsubmitted" ? 4 : 0,
    validate: value => { submitted++; assert.deepEqual(value, { value: 42 }); return value; }, onProgress() {} });
  if (mode === "repair") { assert.deepEqual(await run, { value: 42 }); assert.equal(submitted, 1); }
  else { await assert.rejects(run); assert.equal(submitted, 0); }
  replay.assertConsumed(); assert.equal(requests, answers.length);
  assert.ok(events.some(event => event.type === "message_end"));
});
