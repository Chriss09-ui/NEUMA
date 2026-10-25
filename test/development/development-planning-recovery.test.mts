import { callFixture, fixtureTools, recordArray, listeningAddress } from "../helpers/m7-test-boundaries.mjs";
import type { DevelopmentPlan } from "../../src/contracts/development.mjs";
import type { PlanningBlockerReport } from "../../src/development/development-planning-blocker.mjs";
import type { ValueSchema } from "../../src/contracts/application.mjs";
import type { PiSessionOptions } from "../../src/runtime/pi-port.mjs";
import { fixtureChatRequest, type FixtureChatRequest } from "../helpers/http-model.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevelopmentController } from "../../src/development/development.mjs";
import { hashValue, PLAN_V3_SCHEMA, validatePlan } from "../../src/development/development-contract.mjs";
import { createPiSession } from "../../src/runtime/pi-runtime.mjs";
import type { PathLike } from "fs";
import type { DevelopmentContext } from "../../src/development/development-controller-types.mjs";
import type { DevelopmentReview } from "../../src/contracts/development.mjs";
import type { DevelopmentHandle } from "../../src/development/development-controller-types.mjs";

test("真实Pi完整诊断后同hash重交只给有界未修改反馈，模型主动改原生fixture及变更hash后仍完整重验", { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-planning-recovery-"));
  const valueSchema: ValueSchema = { type: "object", properties: { value: { type: "integer", minimum: 0, maximum: 10 } }, required: ["value"], additionalProperties: false };
  const architecture = { requirements: [{ id: "business", text: "处理实际值" }], design: { schemaVersion: 3,
    interaction: { page: false, operations: true }, execution: { language: "javascript", hosting: "builtin" }, connections: [],
    acceptance: [{ id: "business_result", requirementIds: ["business"], verification: { stage: "development", owner: "generated-code", adapterId: "action" } }] } };
  const plan: DevelopmentPlan = { schemaVersion: 3, summary: "固定平台恢复测试", runtime: "node-action", entrypoint: "actions.mjs",
    tasks: [{ id: "core", title: "可执行增量", description: "同时产出入口与实际处理", requirementIds: ["business"], acceptanceIds: ["business_result"], dependsOn: [], files: ["actions.mjs"] }],
    application: { protocolVersion: 2, runtime: "node-action", entrypoint: "actions.mjs", page: null, stateVersion: 1, evidenceIds: [],
      actions: [{ id: "process", title: "处理", inputSchema: valueSchema, outputSchema: valueSchema, connectionIds: [] }] },
    cases: [{ id: "valid", taskId: "core", acceptanceId: "business_result", kind: "action", actionId: "process", mocks: [],
      input: JSON.stringify({ fixture: { op: "value", value: { value: 1 } } }), assertions: [{ path: "value", expectedJson: "1" }] }] };
  const changed = structuredClone(plan.cases); changed[0]!.input = JSON.stringify({ fixture: { op: "value", value: { value: 2 } } });
  const good = structuredClone(changed); good[0]!.input = { fixture: { op: "value", value: { value: 2 } } };
  let calls = 0, first: ReturnType<typeof feedback> | undefined, changedFeedback: ReturnType<typeof feedback> | undefined, serverError: unknown, controller: DevelopmentController, handle: DevelopmentHandle<DevelopmentPlan|{report:PlanningBlockerReport}>, ctx: unknown;
  const textOf = (content: unknown) => typeof content === "string" ? content : recordArray(content).filter((item) => item.type === "text").map((item) => item.text).join("\n");
  const feedback = (body: FixtureChatRequest) => {
    const text = textOf(body.messages.findLast((item: { role: string; }) => item.role === "tool")!.content);
    assert.match(text, /^提交未通过：/u); return JSON.parse(text.slice(text.indexOf("{")));
  };
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = fixtureChatRequest(Buffer.concat(chunks).toString("utf8")); calls++; let tools;
      if (calls === 1) tools = [{ name: "submit_development_plan", args: { indexPath: "index.json" } }];
      else if (calls === 2) {
        first = feedback(body); assert.equal(first.submitted, false); assert.equal(first.unchanged, undefined);
        const issue = first.issues.find((item: { reason: string; }) => item.reason === "input_encoding_mismatch"); assert.ok(issue);
        assert.equal(issue.source.path, "cases.json"); assert.equal(issue.source.caseId, "valid");
        assert.equal(first.hostModelBudget.used, 1); assert.match(first.hash, /^[a-f0-9]{64}$/u);
        tools = [{ name: "submit_development_plan", args: { indexPath: "index.json" } }];
      } else if (calls === 3) {
        const repeated = feedback(body); assert.equal(repeated.unchanged, true); assert.equal(repeated.hash, first.hash);
        assert.equal(repeated.issues, undefined); assert.equal(repeated.total, first.total);
        assert.deepEqual(repeated.diagnosticsTool.arguments, { indexPath: "index.json", expectedHash: first.hash, offset: 0, limit: 40 });
        assert.equal(repeated.hostModelBudget.used, 2); assert.ok(JSON.stringify(repeated).length < 2000);
        tools = [{ name: "write", args: { path: "cases.json", content: JSON.stringify(changed) } },
          { name: "submit_development_plan", args: { indexPath: "index.json" } }];
      } else if (calls === 4) {
        changedFeedback = feedback(body); assert.equal(changedFeedback.unchanged, undefined); assert.notEqual(changedFeedback.hash, first.hash);
        assert.ok(changedFeedback.issues.some((item: { reason: string; }) => item.reason === "input_encoding_mismatch"));
        assert.equal(changedFeedback.hostModelBudget.used, 3);
        tools = [{ name: "save_plan_cases", args: { path: "cases.json", cases: good } },
          { name: "submit_development_plan", args: { indexPath: "index.json" } }];
      } else {
        assert.equal(calls, 5); assert.equal(JSON.parse(textOf(body.messages.findLast((item: { role: string; }) => item.role === "tool")!.content)).submitted, true);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`data: ${JSON.stringify({ id: "complete", choices: [{ index: 0, delta: { role: "assistant", content: "阶段正式提交已接收" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`); return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "planning", choices: [{ index: 0, delta: { role: "assistant", tool_calls: tools.map((item, index) => ({
        index, id: `planning_${calls}_${index}`, type: "function", function: { name: item.name, arguments: JSON.stringify(item.args) },
      })) }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) { serverError = error; response.writeHead(500, { "content-type": "application/json" }); response.end('{"error":{"message":"fixture failure"}}'); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    if (handle) callFixture(controller.dispose, controller, [ctx, handle]);
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    const unseal = async (path: string) => { await chmod(path, 0o700); for (const item of await readdir(path, { withFileTypes: true })) if (item.isDirectory()) await unseal(join(path, item.name)); };
    await unseal(root); await rm(root, { recursive: true, force: true });
  });
  controller = Reflect.construct(DevelopmentController, [{ cwd: root, dataDir: join(root, "data"), config: { llmConfigured: true, model: "fixture-model", apiKey: "fixture-only",
    chatUrl: `http://127.0.0.1:${listeningAddress(server).port}/v1/chat/completions` }, store: { save: async (value: object) => ({ ...value, revision: Number(objectFields(value).revision) + 1 }) },
    sessionFactory: async (options: PiSessionOptions) => { const session = await createPiSession(options); session.setAutoRetryEnabled(false); return session; } }]);
  assert.ok(controller instanceof DevelopmentController);
  const record = { id: "dev_recovery", agentId: "recovery", architecture, architectureRef: { version: 1, candidateHash: hashValue(architecture.design) }, phase: "planning", revision: 0 };
  ctx = { record, signal: new AbortController().signal, writes: Promise.resolve(), handles: new Set() }; callFixture(controller.active.set, controller.active, [record.agentId, ctx]);
  await controller.workspace.create(record.agentId, record.id);
  const tools = await controller.artifacts.tools(record.agentId, record.id, { casesSchema: PLAN_V3_SCHEMA.properties.cases, planSchema: PLAN_V3_SCHEMA, architecture });
  const { cases, ...index } = plan;
  await fixtureTools(tools).write!.execute("seed-index", { path: "index.json", content: JSON.stringify({ ...index, caseFiles: ["cases.json"] }) });
  await fixtureTools(tools).write!.execute("seed-cases", { path: "cases.json", content: JSON.stringify(cases) });
  handle = await callFixture((context: DevelopmentContext) => controller.role(context, { kind: "planner", tools, scope: {}, counter: { turns: 0 }, limit: 12, validate: (value: unknown) => validatePlan(value, { architecture }) }), undefined, [ctx]);
  let accepted;
  try { accepted = await callFixture((context: DevelopmentContext) => controller.ask(context, handle, { architecture, planSchema: PLAN_V3_SCHEMA }), undefined, [ctx]); }
  catch (error) { throw serverError ?? error; }
  assert.equal(serverError, undefined); assert.equal(calls, 5); assert.ok(accepted && "cases" in accepted); assert.deepEqual(accepted.cases, good);
  assert.equal(typeof accepted.cases[0]!.input, "object"); assert.deepEqual(validatePlan(accepted, { architecture }), accepted);
  assert.equal(objectFields(objectFields(objectFields(record).submissionCounts).planner).rejected, 3); assert.equal(objectFields(objectFields(objectFields(record).submissionCounts).planner).accepted, 1);
  assert.equal(handle.counter.turns, 5); assert.equal(handle.limit, 12);
  const frozen = await callFixture(controller.artifacts.validateSnapshot, controller.artifacts, [objectFields(record).planningArtifact]);
  assert.deepEqual(frozen.plan, accepted); assert.notEqual(frozen.snapshot.hash, changedFeedback!.hash);
});
