import { recordArray, listeningAddress } from "../helpers/m7-test-boundaries.mjs";
import { fixtureChatRequest, type FixtureChatRequest } from "../helpers/http-model.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArchitectureDesigner } from "../../src/architecture/architecture.mjs";
import { createPiSession } from "../../src/runtime/pi-runtime.mjs";
import { developmentRevisionReadTool } from "../../src/architecture/architecture-development-revision.mjs";
import type { ArchitectureRoleDiagnostic } from "../../src/architecture/architecture-controller-port.mjs";

const text = (content: unknown) => typeof content === "string" ? content : recordArray(content).filter((item) => item.type === "text").map((item) => item.text).join("\n");

test("真实SDK只发送精简首包，按需取回完整事实后提交，旧原文不进入新会话或增加提交后请求", { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "neuma-input-projection-")), requests: FixtureChatRequest[] = [];
  const source = { requirements: [{ id: "r", text: "依据真实上限回答" }], runtimeCapabilities: { transport: { inputBytes: 123456 } },
    candidateSchema: { description: "未内联结构说明".repeat(8000) } };
  let session, observedFailure;
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = fixtureChatRequest(Buffer.concat(chunks).toString("utf8")); requests.push(body);
      const payload = JSON.parse(text(body.messages.find((item: { role: string; }) => item.role === "user")!.content));
      assert.equal(payload.candidateSchema, undefined); assert.equal(payload.runtimeCapabilities, undefined);
      assert.deepEqual(payload.requirements, source.requirements);
      assert.ok(payload.contextIndex.some((item: { section: string; }) => item.section === "runtimeCapabilities"));
      let name = "read_model_context", args: unknown = { requests: [{ section: "runtimeCapabilities", pointer: "/transport/missing" },
        { section: "runtimeCapabilities", pointer: "/transport/inputBytes" }] };
      if (requests.length === 2) {
        const result = JSON.parse(text(body.messages.findLast((item: { role: string; }) => item.role === "tool")!.content).split("\n")[0]!);
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
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); await rm(root, { recursive: true, force: true }); });
  const designer = new ArchitectureDesigner({ config: { llmConfigured: true, model: "context-fixture", apiKey: "fixture-only",
    chatUrl: `http://127.0.0.1:${listeningAddress(server).port}/v1/chat/completions` }, cwd: root, dataDir: root,
    sessionFactory: async options => { session = await createPiSession(options); session.setAutoRetryEnabled(false); return session; } });
  await designer.ready;
  const result = await designer.role({ role: "designer", systemPrompt: "完整私有角色规程".repeat(1000), payload: source,
    submitName: "submit_architecture", parameters: { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "integer" } } },
    validate: value => { assert.equal(objectFields(value).value, 123456); return value; }, onProgress() {} });
  assert.ifError(observedFailure); assert.deepEqual(result, { value: 123456 }); assert.equal(requests.length, 2);
  const stored = JSON.parse(text(session!.messages.find((message: { role: string; }) => message.role === "user").content));
  assert.equal(stored.candidateSchema, undefined); assert.ok(stored.contextIndex);
  assert.ok(JSON.stringify(requests[0]).length < JSON.stringify(source).length / 2);
});

test("读错工具先反馈再给三次实际纠正，正常读取和连接失败不扣机会，重启沿原会话及计数", { timeout: 30000 }, async t => {
  for (const success of [true, false]) await t.test(success ? "第三次纠正成功" : "三次纠正失败锁定", async t => {
    const root = await mkdtemp(join(tmpdir(), "neuma-read-correction-"));
    let requests = 0, serverError: unknown, contentCharges = 0;
    const sessionFiles: (string | undefined)[] = [], diagnostics: ArchitectureRoleDiagnostic[] = [];
    const controllers: ArchitectureDesigner[] = [];
    const feedback = (body: FixtureChatRequest) => {
      for (const message of [...body.messages].reverse()) if (message.role === "user") {
        try { const value = objectFields(JSON.parse(text(message.content))); if (value.formatCorrection) return objectFields(value.formatCorrection); } catch { /* Other user content is not a feedback packet. */ }
      }
      assert.fail("模型请求必须实际收到具体纠正反馈");
    };
    const server = createServer(async (request, response) => {
      try {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const body = fixtureChatRequest(Buffer.concat(chunks).toString("utf8")); requests++;
        let calls: { name: string; arguments: unknown }[];
        if (requests === 1) calls = ["roleGuide", "runtimeCapabilities", "acceptanceAdapterGuide"].map(section => ({
          name: "read_architecture_development_reference", arguments: { section, pointer: "" } }));
        else {
          if (requests <= 6) {
            const correction = feedback(body), outstanding = recordArray(correction.outstanding);
            assert.equal(outstanding.length, 1); assert.equal(outstanding[0]!.toolName, "read_model_context");
            assert.equal(outstanding[0]!.correctionsUsed, requests <= 3 ? 0 : requests <= 5 ? 1 : 2);
            if (requests === 2) assert.match(JSON.stringify(outstanding), /改用 read_model_context/u);
          }
          if (requests === 4) { response.writeHead(503, { "content-type": "application/json" }); response.end('{"error":{"message":"fixture connection interruption"}}'); return; }
          if (requests === 2) calls = [{ name: "read_architecture_development_reference", arguments: { section: "feedback" } }];
          else if (requests === 6 && success) calls = [{ name: "read_model_context", arguments: { requests: [
            { section: "roleGuide" }, { section: "runtimeCapabilities", pointer: "/transport/inputBytes" }, { section: "acceptanceAdapterGuide" }] } }];
          else if (requests === 7 && success) calls = [{ name: "submit_architecture", arguments: { value: 123456 } }];
          else { assert.ok(requests <= 6); calls = [{ name: "read_model_context", arguments: { requests: [{ section: "runtimeCapabilities", pointer: `/missing_${requests}` }] } }]; }
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`data: ${JSON.stringify({ id: "read-correction", choices: [{ index: 0, delta: { role: "assistant", tool_calls: calls.map((call, index) => ({
          index, id: `read_${requests}_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
      } catch (error) { serverError = error; response.writeHead(400); response.end("fixture assertion failed"); }
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    t.after(async () => { for (const controller of controllers) await controller.persistence;
      server.closeAllConnections(); await new Promise(done => server.close(done)); await rm(root, { recursive: true, force: true }); });
    const execute = async () => {
      const designer = new ArchitectureDesigner({ config: { llmConfigured: true, model: "context-fixture", apiKey: "fixture-only",
        chatUrl: `http://127.0.0.1:${listeningAddress(server).port}/v1/chat/completions` }, cwd: root, dataDir: root,
        sessionFactory: async options => { const session = await createPiSession(options); session.setAutoRetryEnabled(false); sessionFiles.push(session.sessionFile); return session; } });
      controllers.push(designer); await designer.ready;
      return designer.role({ role: "designer", agentId: "reader", systemPrompt: "当前角色工作说明",
        payload: { requirements: [], runtimeCapabilities: { transport: { inputBytes: 123456 } }, acceptanceAdapterGuide: { rule: "按真实证据判断" } },
        tools: [developmentRevisionReadTool({ feedback: { issue: "原研发意见" } })], submitName: "submit_architecture",
        parameters: { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "integer" } } },
        validate: value => { assert.deepEqual(value, { value: 123456 }); return value; }, onProgress() {},
        onDiagnostics: value => { diagnostics.push(value); },
        ...(!success ? { modelCallLimit: null, initialSubmissionRejections: 2, onStageModelCall: async () => {},
          onStageSubmissionRejected: async () => { contentCharges++; return { content: 2 + contentCharges, format: 0 }; } } : {}),
      });
    };
    await assert.rejects(execute()); assert.ifError(serverError); assert.equal(requests, 4);
    if (success) assert.deepEqual(await execute(), { value: 123456 });
    else {
      await assert.rejects(execute(), error => objectFields(objectFields(error).diagnostic).reason === "read_input_correction_limit");
      await assert.rejects(execute(), error => objectFields(objectFields(error).diagnostic).reason === "read_input_correction_limit");
    }
    assert.ifError(serverError); assert.equal(requests, success ? 7 : 6); assert.equal(contentCharges, 0);
    assert.ok(sessionFiles[0]); assert.ok(sessionFiles.every(file => file === sessionFiles[0]), "重启不能换原生会话或重领次数");
    const directory = await controllers[0]!.storage.directory("reader", "architecture-read-recovery");
    const files = (await readdir(directory)).filter(name => name.endsWith(".json")); assert.equal(files.length, 1);
    const saved = JSON.parse(await readFile(join(directory, files[0]!), "utf8"));
    assert.equal(saved.modelCalls, requests);
    assert.deepEqual(saved.recovery.episodes[0].corrections.map((row: { outcome: string }) => row.outcome), success ? ["rejected", "rejected", "accepted"] : ["rejected", "rejected", "rejected"]);
    if (!success) assert.equal(diagnostics.at(-1)!.submissionRejections, 2);
  });
});
