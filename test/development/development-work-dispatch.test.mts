import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import * as sdk from "@earendil-works/pi-coding-agent";
import type { ValueSchema } from "../../src/contracts/application.mjs";
import type { SessionFactory, SessionMessage } from "../../src/runtime/execution-port.mjs";
import { DevelopmentController } from "../../src/development/development.mjs";
import { DevelopmentExecutor } from "../../src/development/development-executor.mjs";
import { designHash } from "../../src/architecture/architecture-contract.mjs";
import { developmentArchitecture, developmentReview, developmentWork, developmentJevResponse } from "../helpers/development.mjs";
import { validDesign, passingReview } from "../helpers/architecture.mjs";
import { fixtureTools, toolText, listeningAddress } from "../helpers/m7-test-boundaries.mjs";
import { fixtureChatRequest, type FixtureChatRequest } from "../helpers/http-model.mjs";
import { createPiSession } from "../../src/runtime/pi-runtime.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import { piSessionManager } from "../../src/runtime/pi-session-state.mjs";
import { createDevelopmentTaskCheckpoint, repairHash, runDevelopmentTaskSchedule } from "../../src/runtime/repair-scheduler.mjs";
import { runDevelopmentParts, type DevelopmentPart } from "../../src/development/development-dispatch.mjs";
import { validatePlanningOutline } from "../../src/development/development-planning-dispatch.mjs";
import { developmentSessionBinding } from "../../src/development/development-sessions.mjs";
import type { TaskProgress, PassedDevelopmentArchitecture, DevelopmentContext } from "../../src/development/development-controller-types.mjs";

function fixtureCases(id: string, payload: Record<string, unknown>) {
  const assignment = objectFields(payload.caseAssignments), prefix = `g${id.slice("cases_".length)}_`;
  const cases = (assignment.rows as { taskId: string; acceptanceId: string }[]).map((row, index) => {
    const n = assignment.activation ? 99 : Number(row.acceptanceId.slice("acceptance_".length)) + 1;
    return { id: `${prefix}${index}`, ...(row.taskId ? { taskId: row.taskId } : {}), acceptanceId: row.acceptanceId, kind: "action", actionId: "echo",
      mocks: [], input: JSON.stringify({ n }), assertions: [{ path: "n", expectedJson: String(n) }] };
  });
  return assignment.activation ? { cases: [], activationCases: cases } : { cases, activationCases: [] };
}

async function fixture(t: test.TestContext, interrupt = false, activation = false, objection = false, rejectOutline = false,
  legacy?: { url: string; part: string }, inputConflict = false) {
  const root = await mkdtemp(join(tmpdir(), "neuma-development-dispatch-")), executor = new DevelopmentExecutor();
  const availability = await executor.probe();
  if (!availability.available) { await rm(root, { recursive: true, force: true }); t.skip(availability.reason); return; }
  const requirements = Array.from({ length: 30 }, (_, index) => ({ id: `requirement_${index}`, text: `第${index + 1}项：输出实际整数值，不存储业务状态` }));
  const design: PassedDevelopmentArchitecture["design"] = validDesign(requirements, { schemaVersion: 2, profile: "custom", connections: [],
    interaction: { defaultEntry: "conversation", page: false, operations: true, inputs: "整数对象", results: "原整数", persistentData: "不保存" },
    acceptance: Array.from({ length: 12 }, (_, index) => ({ id: `acceptance_${index}`, kind: "success" as const,
      requirementIds: requirements.slice(index < 6 ? 0 : 15, index < 6 ? 15 : 30).map(row => row.id), input: String(index + 1), expected: `返回整数${index + 1}` })) });
  if (activation) {
    Object.assign(design, { schemaVersion: 3, execution: { language: "javascript", hosting: "builtin", reason: "独立整数动作" } });
    design.acceptance = design.acceptance.map(row => ({ ...row, verification: { stage: "development", owner: "generated-code", adapterId: "action" } }));
    design.acceptance.push({ id: "activation_check", kind: "success", requirementIds: requirements.map(row => row.id), input: "99", expected: "启用前真实验证整数返回值",
      verification: { stage: "activation", owner: "platform", adapterId: "host-business" } });
  }
  if (inputConflict) Object.assign(design.acceptance[0]!, { input: '{"n":"bad"}', expected: "返回明确的非整数错误",
    verification: { stage: "development", owner: "generated-code", adapterId: "action" } });
  const candidateHash = designHash(design), architecture = developmentArchitecture({ requirements, design, candidateHash, contractVersion: activation ? 3 : 2, review: passingReview(candidateHash) });
  const shape: ValueSchema = { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false };
  const outline = { plan: { schemaVersion: (activation ? 3 : 2) as 2 | 3, summary: "分成两个有依赖的可运行增量", runtime: "node-action" as const, entrypoint: "main.mjs",
    application: { protocolVersion: 2 as const, runtime: "node-action" as const, entrypoint: "main.mjs", page: null, stateVersion: 1, evidenceIds: [],
      actions: [{ id: "echo", title: "返回整数", inputSchema: shape, outputSchema: shape, connectionIds: [] }] },
    tasks: [0, 1].map(index => ({ id: `task_${index}`, title: `整数增量${index}`, description: "用冻结的不同输入验证公开动作",
      requirementIds: requirements.slice(index * 15, index * 15 + 15).map(row => row.id), acceptanceIds: design.acceptance.slice(index * 6, index * 6 + 6).map(row => row.id),
      dependsOn: index ? ["task_0"] : [], files: ["main.mjs"] })) },
    actionOwners: [{ actionId: "echo", taskId: "task_0", acceptanceId: "acceptance_0" }],
    activationScopes: activation ? [{ acceptanceId: "activation_check", executionScope: "shared" as const }] : [] };
  const calls: { id: string; mode?: string; scope?: { kind: string; ids: string[] } }[] = [], failures: string[] = [];
  let interrupted = false, active = 0, maxActive = 0, legacyEnabled = Boolean(legacy);
  const factory: SessionFactory = async options => {
    const tools = fixtureTools(options.customTools);
    const scoped = Boolean(tools.submit_development_plan_part || tools.submit_development_review_part);
    if (legacyEnabled && objectFields(objectFields(options.sessionStorage?.binding).scope).partId === legacy!.part) {
      // Reproduce the old adapter boundary: malformed container text reaches SDK validation unchanged.
      const native = await createPiSession({ ...options, config: { ...options.config, chatUrl: legacy!.url, model: "local-model", apiKey: "local-only" },
        customTools: (options.customTools ?? []).map(tool => ({ ...tool, prepareArguments: (value: unknown) => value })) });
      native.setAutoRetryEnabled(false); return native;
    }
    const binding = objectFields(options.sessionStorage?.binding), session = { messages: [] as SessionMessage[],
      ...(scoped ? { sessionFile: options.sessionStorage!.file ?? join(options.sessionStorage!.directory, `${String(binding.bindingHash).slice(0, 20)}.jsonl`) } : {}),
      setAutoCompactionEnabled() {}, async abort() {}, dispose() {}, async prompt(message: string) {
        const payload = objectFields(JSON.parse(message)), assignment = objectFields(payload.workAssignment), id = String(assignment.id ?? "developer");
        calls.push({ id, ...(typeof payload.mode === "string" ? { mode: payload.mode } : {}), ...(payload.reviewScope ? { scope: payload.reviewScope as { kind: string; ids: string[] } } : {}) });
        active++; maxActive = Math.max(maxActive, active);
        try {
          await new Promise<void>(resolve => setImmediate(resolve));
          if (scoped) {
            const page = JSON.parse(toolText(await tools.read_development_context!.execute("guide", { section: "roleGuide", limit: 10000 })));
            const guide = JSON.parse(page.text) as string;
            const terminal = tools.submit_development_plan_part ? "submit_development_plan_part" : "submit_development_review_part";
            assert.ok(guide.includes(terminal));
            assert.doesNotMatch(guide, /\bsubmit_development_plan\b|\bsubmit_development_review\b|save_plan_cases|save_plan_json/);
          }
          if (tools.submit_development_plan_part) {
            if (id === "outline") {
              const submitted = structuredClone(outline);
              if (inputConflict && calls.filter(row => row.id === "outline").length > 1) {
                submitted.plan.application.actions[0]!.inputSchema.properties!.n = {};
                submitted.plan.application.actions[0]!.outputSchema = { type: "object", properties: { n: { type: "integer" }, error: { type: "string" } }, required: [], additionalProperties: false };
              }
              if (rejectOutline && !interrupted) { interrupted = true; submitted.actionOwners.push({ ...submitted.actionOwners[0]! }); }
              await tools.submit_development_plan_part.execute("outline", submitted);
            }
            else {
              if (inputConflict) assert.equal(calls.filter(row => row.id === "outline").length, 2, "确定的输入冲突须在分派用例前交回规划者");
              if (interrupt && !interrupted && id === "cases_1") { interrupted = true; throw new Error("controlled planning interruption"); }
              const part = fixtureCases(id, payload);
              if (inputConflict) for (const row of part.cases) if (row.acceptanceId === "acceptance_0") {
                row.input = '{"n":"bad"}'; row.assertions = [{ path: "/error", expectedJson: '"invalid_integer"' }];
              }
              await tools.submit_development_plan_part.execute("cases", part);
            }
          } else if (tools.submit_development_review_part) {
            const scope = payload.reviewScope as { kind: string; ids: string[] };
            if (scope.kind === "files") for (const path of scope.ids) await tools.read_code_file!.execute("read", { path });
            await tools.submit_development_review_part.execute("review", developmentReview(String(payload.subjectHash), objection ? {
              verdict: "revise", issues: [{ id: "style", kind: "code", blocking: true, description: "建议按评审个人偏好换一种代码写法",
                remedy: "改成另一套命名", taskIds: ["task_0"], files: ["main.mjs"] }] } : {}));
          } else if (tools.submit_development_work) {
            const task = payload.task as TaskProgress;
            await tools.write!.execute("write", { path: "main.mjs", content: inputConflict
              ? "export const actions={async echo(input){return Number.isInteger(input.n)?{n:input.n}:{error:'invalid_integer'};}};"
              : "export const actions={async echo(input){return {n:input.n};}};" });
            await tools.submit_development_work.execute("work", developmentWork(task));
          } else throw new Error("Unexpected unpartitioned model call");
          session.messages.push({ role: "assistant", stopReason: "stop", content: "controlled role; real controller validation and isolated execution" });
        } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); throw error; }
        finally { active--; }
      } };
    return session;
  };
  const options = { config: { llmConfigured: true }, cwd: root, dataDir: join(root, "data"), executor, sessionFactory: factory, getArchitecture: async () => architecture };
  const controllers = [new DevelopmentController(options)];
  t.after(async () => {
    for (const controller of controllers) await controller.close();
    const unseal = async (path: string) => { await chmod(path, 0o700); for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await unseal(join(path, entry.name)); };
    await unseal(root); await rm(root, { recursive: true, force: true });
  });
  return { controller: controllers[0]!, restart() { const controller = new DevelopmentController(options); controllers.push(controller); return controller; },
    architecture, outline, calls, failures, useCurrentAdapter() { legacyEnabled = false; }, maxActive: () => maxActive };
}

async function rejectedNativeFixture(t: test.TestContext, { part = "outline", invalidContent = false } = {}) {
  let f: Awaited<ReturnType<typeof fixture>>, serverError: unknown;
  const requests: FixtureChatRequest[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = fixtureChatRequest(Buffer.concat(chunks).toString("utf8")); requests.push(body);
      assert.ok(f); assert.ok(requests.length <= 4, "旧停点只运行首次错误和三次实际纠正");
      let args: unknown;
      if (part === "outline") {
        const outline = structuredClone(f.outline);
        if (invalidContent) outline.plan.tasks[0]!.requirementIds.shift();
        args = { ...outline, plan: JSON.stringify(outline.plan) + "}" };
      } else {
        const payload = body.messages.map(message => {
          const text = typeof message.content === "string" ? message.content : Array.isArray(message.content)
            ? message.content.filter(block => objectFields(block).type === "text").map(block => objectFields(block).text).join("\n") : "";
          try { return objectFields(JSON.parse(text)); } catch { return {}; }
        }).find(row => row.caseAssignments);
        assert.ok(payload);
        const cases = fixtureCases(part, payload);
        args = { ...cases, cases: JSON.stringify(cases.cases) + "]" };
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "historical-input", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0,
        id: `call_${requests.length}`, type: "function", function: { name: "submit_development_plan_part", arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) { serverError = error; response.writeHead(500); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  f = await fixture(t, false, false, false, false, { url: `http://127.0.0.1:${listeningAddress(server).port}/v1/chat/completions`, part });
  if (!f) return;
  const stopped = await f.controller.run(f.architecture);
  assert.equal(serverError, undefined); assert.equal(stopped.diagnostic?.reason, "repeated_tool_error", stopped.summary);
  assert.equal(requests.length, 4);
  f.useCurrentAdapter();
  return { ...f, stopped, requests };
}

test("复杂研发拆为骨架、独立用例组及完整覆盖的评审组，仍经过实际代码验收", async t => {
  const f = await fixture(t); if (!f) return;
  const result = await f.controller.run(f.architecture);
  assert.equal(result.status, "completed", JSON.stringify({ summary: result.summary, failures: f.failures }));
  assert.equal(result.plan!.cases.length, 12); assert.ok(result.reports.every(report => report.status === "passed"));
  assert.equal(f.calls.filter(call => call.id === "outline").length, 1);
  assert.equal(f.calls.filter(call => call.id.startsWith("cases_")).length, 3);
  assert.ok(f.maxActive() > 1 && f.maxActive() <= 3);
  const planCases = f.calls.filter(call => call.mode === "plan" && call.scope?.kind === "cases").flatMap(call => call.scope!.ids);
  assert.deepEqual(planCases.sort(), result.plan!.cases.map(test => test.id).sort());
  assert.ok(f.calls.filter(call => call.scope?.kind === "cases").every(call => call.scope!.ids.length <= 6));
});

test("明确的业务输入样本被入口挡住时先退回规划，恢复保留已收用例与内容计数", async t => {
  const f = await fixture(t, true, false, false, false, undefined, true); if (!f) return;
  const rejected = await f.controller.run(f.architecture);
  assert.equal(rejected.retryPolicy!.content.plan!.count, 1, JSON.stringify(f.failures));
  assert.ok(rejected.submissionAttempts!.some(row => row.issues.some(issue => issue.reason === "planning_input_conflict")));
  assert.equal(f.calls.filter(row => row.id.startsWith("cases_")).length, 0);
  const stopped = await f.restart().run(f.architecture, { resume: true });
  assert.equal(f.calls.filter(row => row.id === "outline").length, 2, JSON.stringify(f.failures));
  assert.equal(stopped.retryPolicy!.content.plan!.count, 1);
  const accepted = Object.values(stopped.workDispatches!).flatMap(row => row.dispatch.groups).filter(row => row.result && row.issueIds.some(id => id.startsWith("cases_")));
  assert.ok(accepted.length);
  const result = await f.restart().run(f.architecture, { resume: true });
  assert.equal(result.status, "completed", JSON.stringify({ summary: result.summary, failures: f.failures }));
  assert.equal(result.retryPolicy!.content.plan!.count, 1);
  assert.equal(f.calls.filter(row => row.id === "outline").length, 2);
  for (const group of accepted) assert.ok(Object.values(result.workDispatches!).some(row => row.dispatch.groups.some(current =>
    current.sessionFile === group.sessionFile && repairHash(current.result) === repairHash(group.result) && current.calls === group.calls)));
  assert.equal(result.reports.at(-1)!.status, "passed");
  assert.ok(result.plan!.cases.some(row => row.input === '{"n":"bad"}' && row.kind === "action"));
  assert.equal(result.plan!.cases.find(row => row.acceptanceId === "acceptance_0")!.assertions[0]!.path, "error");
});

test("骨架修订允许同步说明及标题，仍阻止权限、验收分配和运行配置越界", async t => {
  const f = await fixture(t); if (!f) return;
  await f.controller.store.ready;
  const original = structuredClone(f.outline), revised = structuredClone(original);
  revised.plan.summary = "接口修订：原始输入由业务代码校验";
  revised.plan.application.actions[0]!.title = "整数检查与返回";
  revised.plan.application.actions[0]!.inputSchema.properties!.n = {};
  for (const task of revised.plan.tasks) { task.title += "（接口同步）"; task.description = "使用当前原始数据输入契约，业务含义和验收归属保持。"; }
  assert.deepEqual(validatePlanningOutline(revised, f.architecture, original), revised);
  assert.deepEqual(f.outline, original);
  const change = (mutate: (draft: typeof revised) => void) => {
    const draft = structuredClone(revised); mutate(draft);
    assert.throws(() => validatePlanningOutline(draft, f.architecture, original), /planning_scope_changed/);
  };
  change(draft => draft.plan.tasks[0]!.files.push("extra.mjs"));
  change(draft => { draft.plan.tasks[1]!.dependsOn = []; });
  change(draft => { draft.actionOwners[0]!.acceptanceId = "acceptance_1"; });
  change(draft => { draft.plan.application.stateVersion = 2; });
});

test("用例组的输入错误用冻结接口定位具体用例，不再误报整个应用配置", async t => {
  const f = await fixture(t); if (!f) return;
  f.outline.plan.application.actions[0]!.inputSchema.properties!.n = { type: "integer", minimum: 100 };
  const result = await f.controller.run(f.architecture);
  const failures = result.submissionAttempts!.filter(row => row.status === "rejected");
  assert.ok(failures.length);
  assert.ok(failures.every(row => row.issues.length && row.issues.every(issue =>
    /^plan\.cases\[\d+\]\.input$/.test(issue.path) && issue.reason === "action_input_invalid")), JSON.stringify(failures));
});

test("每个研发评审小组分别由JEV放行，真实代码通过后汇总，评分中断不重做已收分组", async t => {
  let unavailable = true, attempts = 0;
  const states: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const state = objectFields(JSON.parse(String(init.body)).state); states.push(state); attempts++;
    if (unavailable && attempts > 1) throw new TypeError("fetch failed");
    return Response.json(developmentJevResponse(1, 4));
  });
  const f = await fixture(t, false, false, true); if (!f) return;
  f.controller.config.jevApiKey = "local-jev-fixture";
  const stopped = await f.controller.run(f.architecture);
  assert.equal(stopped.status, "failed"); assert.equal(stopped.phase, "planning");
  const completed = Object.values(stopped.reviewJudgments!).find(row => row.effective)!;
  assert.ok(completed); const archived = structuredClone(completed), callsBefore = f.calls.length;
  const originalReports = structuredClone(stopped.workDispatches);
  unavailable = false;
  const result = await f.restart().run(f.architecture, { resume: true });
  assert.equal(result.status, "completed", result.summary);
  assert.ok(result.reports.every(row => row.status === "passed"));
  assert.ok(result.tasks.every(row => row.repairs === 0));
  assert.deepEqual(Object.values(result.reviewJudgments!).find(row => row.bindingHash === completed.bindingHash), archived);
  for (const [key, checkpoint] of Object.entries(originalReports!)) assert.deepEqual(result.workDispatches![key], checkpoint);
  assert.equal(f.calls.slice(callsBefore).filter(call => call.mode === "plan" || call.id === "outline" || call.id.startsWith("cases_")).length, 0);
  const judged = Object.values(result.reviewJudgments!).filter(row => row.original.issues.length);
  assert.ok(judged.length > 4); assert.ok(judged.every(row => row.original.verdict === "revise" && row.effective!.verdict === "pass"));
  assert.deepEqual(new Set(states.map(state => objectFields(state.scope).kind)), new Set(["requirements", "cases", "files", "interfaces"]));
  assert.ok(judged.some(row => row.receipts.style!.attempts > 1), "连接重试累计保存，恢复不清零");
});

test("规划分组中断后重建控制器仅续跑未完成组，原调用与完成结果保留", async t => {
  const f = await fixture(t, true); if (!f) return;
  const stopped = await f.controller.run(f.architecture);
  assert.equal(stopped.status, "failed", stopped.summary);
  const checkpoint = Object.values(stopped.workDispatches!).find(item => item.dispatch.groups.length === 3)!.dispatch;
  assert.equal(checkpoint.groups.filter(group => group.result).length, 2); assert.equal(checkpoint.calls, 3);
  const result = await f.restart().run(f.architecture, { resume: true });
  assert.equal(result.status, "completed", JSON.stringify({ summary: result.summary, failures: f.failures }));
  assert.equal(f.calls.filter(call => call.id === "outline").length, 1);
  assert.equal(f.calls.filter(call => call.id === "cases_0").length, 1);
  assert.equal(f.calls.filter(call => call.id === "cases_1").length, 2);
  assert.equal(f.calls.filter(call => call.id === "cases_2").length, 1);
  const resumed = Object.values(result.workDispatches!).find(item => item.dispatch.groups.length === 3)!.dispatch;
  assert.equal(resumed.calls, 4); assert.equal(resumed.callLimit, checkpoint.callLimit);
  assert.equal(result.budgets.corrections, stopped.budgets.corrections);
});

test("内容退回改变计数后仍沿原骨架会话恢复，历史退回和实际调用继续累计", async t => {
  const f = await fixture(t, false, false, false, true); if (!f) return;
  const stopped = await f.controller.run(f.architecture);
  assert.equal(stopped.status, "failed");
  assert.equal(stopped.retryPolicy!.content.plan!.count, 1);
  const previous = structuredClone(stopped.workDispatches!.planning_outline!);
  const originalSessions = structuredClone(stopped.sessions);
  const result = await f.restart().run(f.architecture, { resume: true });
  assert.equal(result.status, "completed", result.summary);
  assert.deepEqual(result.retryPolicy!.content, stopped.retryPolicy!.content);
  const current = result.workDispatches!.planning_outline!;
  assert.equal(current.bindingHash, previous.bindingHash);
  assert.equal(current.dispatch.groups[0]!.sessionFile, previous.dispatch.groups[0]!.sessionFile);
  assert.equal(current.dispatch.calls, previous.dispatch.calls + 1);
  for (const [key, session] of Object.entries(originalSessions!)) {
    assert.equal(result.sessions![key]!.file, session.file);
    assert.ok(result.sessions![key]!.turns >= session.turns);
  }
});

test("旧分组从绑定原生开场核验历史计数，保留旧绑定；真实材料变化仍拒绝恢复", async t => {
  const f = await fixture(t, false, false, false, true); if (!f) return;
  const record = await f.controller.run(f.architecture);
  assert.equal(record.retryPolicy!.content.plan!.count, 1);
  const controller = new AbortController(), ctx: DevelopmentContext = { controller, signal: controller.signal, record,
    onProgress() {}, handles: new Set(), writes: Promise.resolve(), done: Promise.resolve(), finish() {} };
  f.controller.active.set(record.agentId, ctx);
  t.after(() => { f.controller.active.delete(record.agentId); });
  const key = "legacy_binding", binding = { architectureRef: record.architectureRef }, part: DevelopmentPart<unknown> = {
    id: "legacy_outline", role: "planner", instruction: "固定历史骨架", schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    payload: { design: { source: "approved" }, remaining: { contentRejections: {} } }, validate: value => value,
  };
  const identity = { binding, assignments: [{ id: part.id, role: part.role, schema: part.schema, instruction: part.instruction,
    payload: part.payload, allowBlocker: false }], callLimit: 6 }, bindingHash = repairHash(identity), base = { parts: { [part.id]: null } };
  const issues = [{ id: part.id, owner: part.id, paths: [`/parts/${part.id}`], description: part.instruction, remedy: "只提交本组结果，其他分组由独立会话处理。" }];
  let nativeFile = "";
  await assert.rejects(runDevelopmentTaskSchedule({ checkpoint: createDevelopmentTaskCheckpoint(identity, base, issues), binding: identity, base,
    validateCandidate: value => value, save: async dispatch => {
      record.workDispatches![key] = { version: 1, bindingHash, dispatch };
      if (!record.dispatchedWork!.includes(key)) record.dispatchedWork!.push(key);
      await f.controller.save(ctx);
    }, run: async worker => {
      const sessionBinding = developmentSessionBinding(record, part.role, { work: key, bindingHash, partId: part.id, baseHash: worker.baseHash });
      const sessionKey = repairHash(sessionBinding), directory = await f.controller.storage.directory(record.agentId, `development/sessions/${record.id}/${sessionKey}`, { create: true });
      const cwd = await f.controller.workspace.workspacePath(record.agentId, record.id);
      const native = await piSessionManager(sdk, { cwd, storage: { directory, binding: sessionBinding } });
      native.manager.appendMessage({ role: "user", content: JSON.stringify({ ...part.payload, workAssignment: { id: part.id } }), timestamp: 0 });
      native.manager.appendMessage({ role: "assistant", api: "openai-completions", provider: "openai", model: "fixture", content: [{ type: "text", text: "合成历史开场" }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1 });
      nativeFile = native.manager.getSessionFile()!;
      record.sessions![sessionKey] = { bindingHash: sessionKey, role: part.role, file: basename(nativeFile), turns: 1 };
      await worker.onSession(basename(nativeFile)); await worker.onCall();
      throw new Error("controlled legacy interruption");
    } }), /controlled legacy interruption/);
  const legacy = structuredClone(record.workDispatches![key]!), before = await readFile(nativeFile), accounting = structuredClone(record.retryPolicy);
  part.payload.remaining = { contentRejections: { plan: 1 } };
  const reached = new Error("reached original role");
  t.mock.method(f.controller, "role", async (_ctx: DevelopmentContext, options: Parameters<DevelopmentController["role"]>[1]) => {
    assert.deepEqual(options.scope, { work: key, bindingHash, partId: part.id, baseHash: legacy.dispatch.baseHash });
    throw reached;
  });
  await assert.rejects(runDevelopmentParts(f.controller, ctx, key, binding, [part]), error => error === reached);
  assert.equal(record.workDispatches![key]!.version, 2);
  assert.equal(record.workDispatches![key]!.bindingHash, bindingHash);
  assert.deepEqual(record.workDispatches![key]!.dispatch, legacy.dispatch);
  assert.deepEqual(record.retryPolicy, accounting);
  assert.deepEqual(await readFile(nativeFile), before);
  await assert.rejects(runDevelopmentParts(f.controller, ctx, key, binding, [part]), error => error === reached);
  part.payload.design = { source: "changed" };
  await assert.rejects(runDevelopmentParts(f.controller, ctx, key, binding, [part]), /材料已变化/);
  record.workDispatches![key] = legacy;
  await assert.rejects(runDevelopmentParts(f.controller, ctx, key, binding, [part]), /材料已变化或原会话计量无法核验/);
  assert.deepEqual(await readFile(nativeFile), before);
});

test("v3分组规划保留独立激活用例及共享作用域，研发通过不冒充启用验证", async t => {
  const f = await fixture(t, false, true); if (!f) return;
  const result = await f.controller.run(f.architecture);
  assert.equal(result.status, "completed", JSON.stringify({ summary: result.summary, failures: f.failures }));
  assert.equal(result.plan!.cases.length, 12); assert.equal(result.plan!.activationCases!.length, 1);
  assert.equal(result.plan!.activationChecks![0]!.executionScope, "shared");
  assert.deepEqual(result.plan!.activationChecks![0]!.caseIds, result.plan!.activationCases!.map(row => row.id));
  const item = result.acceptanceLedger!.items.find(row => row.acceptanceId === "activation_check")!;
  assert.equal(item.status, "not_run"); assert.notEqual(result.delivery, "ready");
});

test("原生格式停点还原后仅继续未完成组，三次纠正和已收结果保留且不新增该组模型请求", async t => {
  const f = await rejectedNativeFixture(t, { part: "cases_1" }); if (!f) return;
  const original = Object.entries(f.stopped.workDispatches!).find(([, work]) => work.dispatch.groups.length === 3)!;
  const finished = original[1].dispatch.groups.filter(group => group.result);
  assert.equal(finished.length, 2);
  const locked = Object.entries(f.stopped.sessions!).find(([, session]) => session.formatRecovery?.episodes.some(row => row.corrections.length === 3))!;
  const before = structuredClone(locked[1]), history = join(await f.controller.storage.directory(f.architecture.agentId,
    `development/sessions/${f.stopped.id}/${locked[0]}`), before.file!), bytes = await readFile(history);
  const resumed = await f.restart().run(f.architecture, { resume: true });
  assert.equal(resumed.status, "completed", resumed.summary); assert.equal(f.requests.length, 4);
  assert.equal(f.calls.filter(row => row.id === "cases_1").length, 0);
  assert.deepEqual(await readFile(history), bytes);
  const work = resumed.workDispatches![original[0]]!;
  assert.equal(work.dispatch.calls, original[1].dispatch.calls);
  for (const old of finished) assert.deepEqual(work.dispatch.groups.find(group => group.id === old.id), old);
  assert.equal(work.version, 2); assert.ok(work.version === 2);
  assert.equal(work.submissionReplays!.length, 1);
  assert.deepEqual(work.submissionReplays![0]!.previousFormatRecovery, before.formatRecovery);
  const recovery = resumed.sessions![locked[0]]!.formatRecovery!;
  assert.deepEqual(recovery.episodes[0]!.corrections, before.formatRecovery!.episodes[0]!.corrections);
  assert.deepEqual(recovery.episodes[0]!.failures, before.formatRecovery!.episodes[0]!.failures);
  assert.ok(recovery.episodes[0]!.closed); assert.equal(resumed.sessions![locked[0]]!.turns, before.turns);
  assert.deepEqual(resumed.retryPolicy!.content, f.stopped.retryPolicy!.content);
});

test("格式还原不能放过缺失需求，原格式停点及次数保持且不发新请求", async t => {
  const f = await rejectedNativeFixture(t, { invalidContent: true }); if (!f) return;
  const original = structuredClone(f.stopped.workDispatches), sessions = structuredClone(f.stopped.sessions);
  const resumed = await f.restart().run(f.architecture, { resume: true });
  assert.equal(resumed.status, "failed"); assert.equal(resumed.diagnostic?.reason, "submission_replay_rejected");
  assert.match(resumed.summary, /requirement_0/);
  assert.deepEqual(resumed.workDispatches, original); assert.deepEqual(resumed.sessions, sessions);
  assert.deepEqual(resumed.retryPolicy!.content, f.stopped.retryPolicy!.content); assert.equal(f.requests.length, 4);
});

test("原生末次退回不对应时拒绝恢复，不回退采用较早的可还原稿", async t => {
  const f = await rejectedNativeFixture(t); if (!f) return;
  const [key, reference] = Object.entries(f.stopped.sessions!).find(([, row]) => row.formatRecovery?.episodes.some(episode => episode.corrections.length === 3))!;
  const file = join(await f.controller.storage.directory(f.architecture.agentId, `development/sessions/${f.stopped.id}/${key}`), reference.file!);
  const lines = (await readFile(file, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
  const lastReply = lines.findLast(row => row.type === "message" && row.message.role === "toolResult");
  assert.ok(lastReply); lastReply.message.toolCallId = "different_submission";
  const changed = lines.map(line => JSON.stringify(line)).join("\n") + "\n";
  await writeFile(file, changed);
  const resumed = await f.restart().run(f.architecture, { resume: true });
  assert.equal(resumed.status, "failed"); assert.match(resumed.summary, /末次提交与退回凭据不匹配/);
  assert.deepEqual(resumed.workDispatches, f.stopped.workDispatches); assert.deepEqual(resumed.sessions, f.stopped.sessions);
  assert.equal(await readFile(file, "utf8"), changed); assert.equal(f.requests.length, 4);
});

test("格式恢复接受凭据落盘失败时不发布成功，重启仍从原停点核验", async t => {
  const f = await rejectedNativeFixture(t); if (!f) return;
  const controller = f.restart(), save = controller.store.save.bind(controller.store);
  let failed = false;
  t.mock.method(controller.store, "save", async (record: Parameters<typeof save>[0]) => {
    if (!failed && Object.values(objectFields(objectFields(record).workDispatches)).some(value => {
      const work = objectFields(value); return work.version === 2 && Array.isArray(work.submissionReplays) && work.submissionReplays.length > 0;
    })) {
      failed = true; throw new Error("controlled replay persistence failure");
    }
    return save(record);
  });
  await assert.rejects(controller.run(f.architecture, { resume: true }), /controlled replay persistence failure/);
  assert.ok(failed);
  const persisted = await controller.store.get(f.architecture.agentId);
  assert.deepEqual(persisted!.workDispatches, f.stopped.workDispatches);
  assert.deepEqual(persisted!.sessions, f.stopped.sessions);
  const resumed = await f.restart().run(f.architecture, { resume: true });
  assert.equal(resumed.status, "completed", resumed.summary); assert.equal(f.requests.length, 4);
});
