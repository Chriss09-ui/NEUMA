import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevelopmentController } from "../src/development/development.mjs";
import { createDevelopmentPlanningBlocker, samePlanningBlocker, isPlanningBlockerOutcome } from "../src/development/development-planning-blocker.mjs";
import { developmentRevisionReference } from "../src/architecture/architecture-development-revision.mjs";
import { compactDevelopmentContext } from "../src/development/development-context.mjs";
import { hashValue } from "../src/development/development-contract.mjs";
import { createPiSession } from "../src/runtime/pi-runtime.mjs";
import { runtimeCapabilityContract } from "../src/runtime/runtime-capability-contract.mjs";
import { ACCEPTANCE_ADAPTER_GUIDE } from "../src/verification/acceptance-contract.mjs";
import { developmentArchitecture } from "./helpers/development.mjs";

function argumentsFor(contract, design, kind = "architecture") {
  return { subjectHash: contract.subjectHash, summary: "当前方案存在需要先核实的技术阻断", issues: [{ id: "technical_boundary", kind,
    description: "已有交付承诺与当前可验证能力需要重新核对", remedy: "保留原需求和验收，由架构核对所列事实后继续",
    references: [{ source: "design", path: "/instructions", quote: design.instructions }] }] };
}

function record() {
  const architecture = developmentArchitecture();
  return { id: "dev_blocker", agentId: architecture.agentId, architecture,
    architectureRef: { version: architecture.version, candidateHash: architecture.candidateHash }, phase: "planning", status: "running",
    plan: null, planHash: null, tasks: [], feedback: null };
}

test("规划阻断仅接受当前完整来源绑定与逐字路径证据，不接受模型伪造的宿主结果", () => {
  const current = record(), blocker = createDevelopmentPlanningBlocker(current, { acceptanceAdapterGuide: ACCEPTANCE_ADAPTER_GUIDE });
  const value = argumentsFor(blocker.context, current.architecture.design), report = blocker.submit(value);
  assert.equal(report.role, "planner"); assert.equal(report.trust, "untrusted-reference"); assert.equal(report.status, "blocked");
  assert.equal(report.source.designHash, current.architectureRef.candidateHash); assert.equal(report.issues[0].blocking, true);
  assert.equal(report.review, undefined); assert.equal(isPlanningBlockerOutcome({ report }), false);
  assert.ok(samePlanningBlocker({ ...current, status: "blocked", feedback: { report } }, current.architecture, ACCEPTANCE_ADAPTER_GUIDE));
  assert.ok(samePlanningBlocker({ ...current, status: "blocked", plan: { summary: "已有冻结计划" }, planHash: "saved-plan",
    tasks: [{ id: "existing", status: "verified" }], feedback: { report } }, current.architecture, ACCEPTANCE_ADAPTER_GUIDE));
  for (const change of [
    (input) => { input.subjectHash = "0".repeat(64); },
    (input) => { input.issues[0].references[0].quote = "不存在的原文"; },
    (input) => { input.issues[0].references[0].path = "/missing"; },
    (input) => { input.issues[0].references[0].path = "/__proto__/constructor"; },
    (input) => { input.issues[0].references[0].path = "/~2"; },
    (input) => { input.issues[0].kind = "code"; },
    (input) => { input.summary = " "; },
    (input) => { input.issues.push(structuredClone(input.issues[0])); },
  ]) {
    const input = structuredClone(value); change(input); assert.throws(() => blocker.submit(input), /规划阻断尚未接受/);
  }
  for (const change of [
    (item) => { item.agentId += "_other"; }, (item) => { item.id += "_other"; },
    (item) => { item.architectureRef.version++; }, (item) => { item.architecture.sourceFingerprint = "changed"; },
    (item) => { item.architecture.requirements[0].text += " changed"; },
    (item) => { item.architecture.design.instructions += " changed"; },
    (item) => { item.architecture.platformHash = "0".repeat(64); },
    (item) => { item.architecture.runtimeCapabilities = { changed: true }; },
    (item) => { item.architecture.confirmedRequirementContext = { changed: true }; },
    (item) => { item.architecture.deferredVerifications = { changed: true }; },
  ]) {
    const changed = structuredClone(current); change(changed); assert.throws(() => blocker.submit(value, changed), /版本已变化/);
  }
  const changed = structuredClone(report); changed.summary += " changed";
  assert.equal(samePlanningBlocker({ ...current, status: "blocked", feedback: { report: changed } }, current.architecture, ACCEPTANCE_ADAPTER_GUIDE), false);
  const environment = blocker.submit(argumentsFor(blocker.context, current.architecture.design, "environment"));
  assert.equal(samePlanningBlocker({ ...current, status: "blocked", feedback: { report: environment } }, current.architecture, ACCEPTANCE_ADAPTER_GUIDE), false);
});

test("小型阻断契约保留在首包绑定，完整大schema仍分页且不复制平台说明", () => {
  const current = record(), blocker = createDevelopmentPlanningBlocker(current, { acceptanceAdapterGuide: ACCEPTANCE_ADAPTER_GUIDE });
  const prompt = compactDevelopmentContext({ architectureRef: current.architectureRef, design: current.architecture.design,
    planSchema: { long: "x".repeat(100000) }, planningBlockerContract: blocker.context }, 8000);
  assert.deepEqual(prompt.planningBlockerContract, blocker.context);
  assert.deepEqual(blocker.parameters.properties.subjectHash.enum, [blocker.context.subjectHash]);
  assert.equal(prompt.contextSections.find((entry) => entry.section === "planningBlockerContract").delivery, "full");
  assert.equal(prompt.contextSections.find((entry) => entry.section === "planSchema").delivery, "paged");
});

async function fixture(t, { kind = "architecture", onPrompt, sessionFactory } = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-planning-blocker-")), sessions = [], probes = [];
  let architecture = developmentArchitecture({ sourceFingerprint: "fixed-source", runtimeCapabilities: runtimeCapabilityContract() });
  const config = { config: { llmConfigured: true }, cwd: root, dataDir: join(root, "data"),
    getArchitecture: async () => architecture,
    executor: { async probe() { probes.push(true); return { available: true, kind: "synthetic" }; },
      async verify() { assert.fail("阻断后不能执行代码"); } },
    sessionFactory: sessionFactory ?? (async (options) => {
      const tools = Object.fromEntries(options.customTools.map((tool) => [tool.name, tool]));
      const captured = { tools, options }; sessions.push(captured);
      const session = { messages: [], subscribe: () => () => {}, dispose() {}, async abort() {}, async prompt(text) {
        captured.payload = JSON.parse(text);
        if (onPrompt) return onPrompt({ controller, captured, text });
        captured.reply = await tools.submit_development_blocker.execute("blocked", argumentsFor(captured.payload.planningBlockerContract, architecture.design, kind));
      } }; captured.session = session; return session;
    }) };
  const controller = new DevelopmentController(config);
  t.after(async () => { await controller.close(); await rm(root, { recursive: true, force: true }); });
  return { root, controller, config, sessions, probes, get architecture() { return architecture; }, changeArchitecture(value) { architecture = value; } };
}

test("无合法计划即可正式受阻，同架构恢复/重新启动均零新请求且预算不重置", async (t) => {
  const f = await fixture(t), first = await f.controller.run(f.architecture);
  assert.equal(first.status, "blocked"); assert.equal(first.phase, "planning"); assert.equal(first.plan, null);
  assert.equal(first.pendingPlan, undefined); assert.deepEqual(first.planAttempts, []); assert.deepEqual(first.reviews, []);
  assert.equal(first.feedback.report.type, "planning-blocker"); assert.equal(first.diagnostic.trust, "untrusted-reference");
  assert.equal(first.planning.turns, 1); assert.deepEqual(first.budgets, { corrections: 6, planRevisions: 1, integrationRepairs: 2 });
  assert.equal(f.sessions.length, 1); assert.equal(f.sessions[0].reply.terminate, true);
  assert.ok(Object.values(first.sessions).every((reference) => reference.pendingResult === undefined));
  const reference = developmentRevisionReference(first, f.architecture);
  assert.deepEqual(reference.feedback.report, first.feedback.report); assert.equal(reference.plan, null);
  const oldHash = hashValue(first), resumed = await f.controller.run(f.architecture, { resume: true });
  assert.equal(hashValue(resumed), oldHash); assert.equal(f.sessions.length, 1); assert.equal(f.probes.length, 1);
  const restarted = new DevelopmentController(f.config); t.after(() => restarted.close());
  assert.equal(hashValue(await restarted.run(f.architecture, { resume: true })), oldHash);
  assert.equal(f.sessions.length, 1);
  await assert.rejects(f.sessions[0].tools.submit_development_blocker.execute("late", argumentsFor(f.sessions[0].payload.planningBlockerContract, f.architecture.design)), /已提交或失效|失效/);
  const next = { ...structuredClone(f.architecture), version: f.architecture.version + 1 };
  f.changeArchitecture(next); const newer = await f.controller.run(next);
  assert.equal(newer.architectureRef.version, next.version); assert.notEqual(newer.id, first.id);
  assert.equal(f.sessions.length, 2);
  assert.equal(hashValue(await f.controller.store.getRun(first.id)), oldHash);
});

test("纯环境意见恢复仍执行原环境探测并可继续规划", async (t) => {
  const f = await fixture(t, { kind: "environment" }), first = await f.controller.run(f.architecture);
  assert.equal(first.status, "blocked");
  const resumed = await f.controller.run(f.architecture, { resume: true });
  assert.equal(resumed.status, "blocked"); assert.equal(f.probes.length, 2); assert.equal(f.sessions.length, 2);
  assert.equal(resumed.planning.turns, 2); assert.equal(resumed.id, first.id);
});

test("取消前未接受阻断，晚到或无证据的文字阻断不能代替正式结果", async (t) => {
  const abort = new AbortController();
  const f = await fixture(t, { onPrompt: async ({ captured }) => {
    abort.abort();
    await captured.tools.submit_development_blocker.execute("cancelled", argumentsFor(captured.payload.planningBlockerContract, f.architecture.design));
  } });
  const cancelled = await f.controller.run(f.architecture, { signal: abort.signal });
  assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.feedback, null);
  const plain = await fixture(t, { onPrompt: async ({ captured }) => {
    captured.session.messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "方案受阻，不能规划。" }] });
  } });
  const failed = await plain.controller.run(plain.architecture);
  assert.equal(failed.status, "failed"); assert.equal(failed.feedback, null); assert.equal(failed.diagnostic.reason, "submission_incomplete");
});

test("报告已保存而工具尚未返回时中断，重启不用WeakSet或pendingResult恢复也不再付费", async (t) => {
  const f = await fixture(t), architecture = f.architecture;
  const saved = f.controller.save.bind(f.controller);
  let persisted;
  f.controller.save = async (ctx) => {
    await saved(ctx);
    if (ctx.record.status === "blocked") {
      persisted = await f.controller.store.getRun(ctx.record.id);
      throw new Error("synthetic crash after durable blocker save");
    }
  };
  const initial = record(); initial.architecture = architecture;
  const created = await f.controller.store.create({ ...initial, name: architecture.name, version: 1, delivery: "blocked", summary: "规划",
    planning: { turns: 0 }, budgets: { corrections: 6, planRevisions: 1, integrationRepairs: 2 }, planAttempts: [], reviews: [], reports: [],
    handoffs: [], deliveries: [], sessions: {}, currentTaskId: null, package: null });
  const ctx = { record: created, signal: new AbortController().signal, writes: Promise.resolve(), handles: new Set(), onProgress() {} };
  f.controller.active.set(created.agentId, ctx);
  await f.controller.workspace.create(created.agentId, created.id);
  await assert.rejects(f.controller.plan(ctx), (error) => error.diagnostic?.reason === "api_error");
  f.controller.active.delete(created.agentId); f.controller.save = saved;
  assert.equal(persisted.status, "blocked"); assert.ok(persisted.feedback.report);
  assert.ok(Object.values(persisted.sessions).every((reference) => reference.pendingResult === undefined));
  const restarted = new DevelopmentController(f.config); t.after(() => restarted.close());
  const result = await restarted.run(architecture, { resume: true });
  assert.equal(hashValue(result), hashValue(persisted)); assert.equal(f.sessions.length, 1);
});

test("真实Pi混合读取与阻断同批提交后不产生额外模型请求，沿用原生循环与原预算", { timeout: 15000 }, async (t) => {
  let calls = 0, serverError;
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); calls++;
      assert.equal(calls, 1, "正式阻断后不能额外发送确认请求");
      const schema = body.tools.find((tool) => tool.function.name === "submit_development_blocker").function.parameters;
      const content = body.messages.findLast((message) => message.role === "user").content;
      const payload = JSON.parse(typeof content === "string" ? content : content.filter((item) => item.type === "text").map((item) => item.text).join("\n"));
      const contract = payload.planningBlockerContract;
      assert.deepEqual(schema.properties.subjectHash.enum, [contract.subjectHash]);
      const args = argumentsFor(contract, payload.design);
      const tools = [{ name: "read_development_context", args: { section: "requirements", offset: 0, limit: 1000 } },
        { name: "submit_development_blocker", args }];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "blocker", choices: [{ index: 0, delta: { role: "assistant", tool_calls: tools.map((tool, index) => ({
        index, id: `blocker_${index}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) },
      })) }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) { serverError = error; response.writeHead(500); response.end("fixture failure"); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const f = await fixture(t, { sessionFactory: async (options) => {
    const session = await createPiSession({ ...options, config: { llmConfigured: true, apiKey: "fixture-only", model: "fixture-model",
      chatUrl: `http://127.0.0.1:${server.address().port}/v1/chat/completions` } });
    session.setAutoRetryEnabled(false); return session;
  } });
  const result = await f.controller.run(f.architecture);
  if (serverError) throw serverError;
  assert.equal(result.status, "blocked"); assert.equal(calls, 1); assert.equal(result.planning.turns, 1);
  assert.equal(result.diagnostic.reason, "planning_blocked"); assert.equal(result.feedback.report.role, "planner");
});
