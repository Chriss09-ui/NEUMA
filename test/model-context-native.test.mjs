import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArchitectureDesigner } from "../src/architecture/architecture.mjs";
import { createPiSession } from "../src/runtime/pi-runtime.mjs";

const text = content => typeof content === "string" ? content : content.filter(item => item.type === "text").map(item => item.text).join("\n");

test("真实SDK只发送精简首包，按需取回完整事实后提交，旧原文不进入新会话或增加提交后请求", { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "neuma-input-projection-")), requests = [];
  const source = { requirements: [{ id: "r", text: "依据真实上限回答" }], runtimeCapabilities: { transport: { inputBytes: 123456 } },
    candidateSchema: { description: "未内联结构说明".repeat(8000) } };
  let session, observedFailure;
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
      const payload = JSON.parse(text(body.messages.find(item => item.role === "user").content));
      assert.equal(payload.candidateSchema, undefined); assert.equal(payload.runtimeCapabilities, undefined);
      assert.deepEqual(payload.requirements, source.requirements);
      assert.ok(payload.contextIndex.some(item => item.section === "runtimeCapabilities"));
      let name = "read_model_context", args = { requests: [{ section: "runtimeCapabilities", pointer: "/transport/missing" },
        { section: "runtimeCapabilities", pointer: "/transport/inputBytes" }] };
      if (requests.length === 2) {
        const result = JSON.parse(text(body.messages.findLast(item => item.role === "tool").content).split("\n")[0]);
        assert.equal(result.results[0].error.reason, "path_missing");
        assert.deepEqual(result.results[0].error.availableKeys, ["inputBytes"]);
        const value = JSON.parse(result.results[1].text); assert.equal(value, 123456);
        name = "submit_architecture"; args = { value };
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "context", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0,
        id: `ctx_${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) { observedFailure = error; response.writeHead(400); response.end("fixture assertion failed"); }
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); await rm(root, { recursive: true, force: true }); });
  const designer = new ArchitectureDesigner({ config: { llmConfigured: true, model: "context-fixture", apiKey: "fixture-only",
    chatUrl: `http://127.0.0.1:${server.address().port}/v1/chat/completions` }, cwd: root, dataDir: root,
    sessionFactory: async options => { session = await createPiSession(options); session.setAutoRetryEnabled(false); return session; } });
  await designer.ready;
  const result = await designer.role({ role: "designer", systemPrompt: "完整私有角色规程".repeat(1000), payload: source,
    submitName: "submit_architecture", parameters: { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "integer" } } },
    validate: value => { assert.equal(value.value, 123456); return value; }, onProgress() {} });
  assert.ifError(observedFailure); assert.deepEqual(result, { value: 123456 }); assert.equal(requests.length, 2);
  const stored = JSON.parse(text(session.messages.find(message => message.role === "user").content));
  assert.equal(stored.candidateSchema, undefined); assert.ok(stored.contextIndex);
  assert.ok(JSON.stringify(requests[0]).length < JSON.stringify(source).length / 2);
});
