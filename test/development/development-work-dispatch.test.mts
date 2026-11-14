import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import * as sdk from "@earendil-works/pi-coding-agent";
import type { ValueSchema } from "../../src/contracts/application.mjs";
import type { SessionFactory, SessionMessage } from "../../src/runtime/execution-port.mjs";
import { DevelopmentController } from "../../src/development/development.mjs";
import { DevelopmentExecutor } from "../../src/development/development-executor.mjs";
import { designHash } from "../../src/architecture/architecture-contract.mjs";
import { developmentArchitecture, developmentReview, developmentWork, developmentJevResponse } from "../helpers/development.mjs";
import { validDesign, passingReview } from "../helpers/architecture.mjs";
import { fixtureTools, toolText } from "../helpers/m7-test-boundaries.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import { piSessionManager } from "../../src/runtime/pi-session-state.mjs";
import { createDevelopmentTaskCheckpoint, repairHash, runDevelopmentTaskSchedule } from "../../src/runtime/repair-scheduler.mjs";
import { runDevelopmentParts, type DevelopmentPart } from "../../src/development/development-dispatch.mjs";
import { developmentSessionBinding } from "../../src/development/development-sessions.mjs";
import type { TaskProgress, PassedDevelopmentArchitecture, DevelopmentContext } from "../../src/development/development-controller-types.mjs";

async function fixture(t: test.TestContext, interrupt = false, activation = false, objection = false, rejectOutline = false) {
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
  const candidateHash = designHash(design), architecture = developmentArchitecture({ requirements, design, candidateHash, contractVersion: activation ? 3 : 2, review: passingReview(candidateHash) });
  const shape: ValueSchema = { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false };
  const outline = { plan: { schemaVersion: (activation ? 3 : 2) as 2 | 3, summary: "分成两个有依赖的可运行增量", runtime: "node-action" as const, entrypoint: "main.mjs",
    application: { protocolVersion: 2 as const, runtime: "node-action" as const, entrypoint: "main.mjs", page: null, stateVersion: 1, evidenceIds: [],
      actions: [{ id: "echo", title: "返回整数", inputSchema: shape, outputSchema: shape, connectionIds: [] }] },
    tasks: [0, 1].map(index => ({ id: `task_${index}`, title: `整数增量${index}`, description: "用冻结的不同输入验证公开动作",
      requirementIds: requirements.slice(index * 15, index * 15 + 15).map(row => row.id), acceptanceIds: design.acceptance.slice(index * 6, index * 6 + 6).map(row => row.id),
      dependsOn: index ? ["task_0"] : [], files: ["main.mjs"] })) },
    actionOwners: [{ actionId: "echo", taskId: "task_0", acceptanceId: "acceptance_0" }],
    activationScopes: activation ? [{ acceptanceId: "activation_check", executionScope: "shared" }] : [] };
  const calls: { id: string; mode?: string; scope?: { kind: string; ids: string[] } }[] = [], failures: string[] = [];
  let interrupted = false, active = 0, maxActive = 0;
  const factory: SessionFactory = async options => {
    const tools = fixtureTools(options.customTools);
    const scoped = Boolean(tools.submit_development_plan_part || tools.submit_development_review_part);
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
              if (rejectOutline && !interrupted) { interrupted = true; submitted.actionOwners.push({ ...submitted.actionOwners[0]! }); }
              await tools.submit_development_plan_part.execute("outline", submitted);
            }
            else {
              if (interrupt && !interrupted && id === "cases_1") { interrupted = true; throw new Error("controlled planning interruption"); }
              const assignment = objectFields(payload.caseAssignments), prefix = `g${id.slice("cases_".length)}_`;
              const cases = (assignment.rows as { taskId: string; acceptanceId: string }[]).map((row, index) => {
                const n = assignment.activation ? 99 : Number(row.acceptanceId.slice("acceptance_".length)) + 1;
                return { id: `${prefix}${index}`, ...(row.taskId ? { taskId: row.taskId } : {}), acceptanceId: row.acceptanceId, kind: "action", actionId: "echo",
                  mocks: [], input: JSON.stringify({ n }), assertions: [{ path: "n", expectedJson: String(n) }] };
              });
              await tools.submit_development_plan_part.execute("cases", assignment.activation ? { cases: [], activationCases: cases } : { cases, activationCases: [] });
            }
          } else if (tools.submit_development_review_part) {
            const scope = payload.reviewScope as { kind: string; ids: string[] };
            if (scope.kind === "files") for (const path of scope.ids) await tools.read_code_file!.execute("read", { path });
            await tools.submit_development_review_part.execute("review", developmentReview(String(payload.subjectHash), objection ? {
              verdict: "revise", issues: [{ id: "style", kind: "code", blocking: true, description: "建议按评审个人偏好换一种代码写法",
                remedy: "改成另一套命名", taskIds: ["task_0"], files: ["main.mjs"] }] } : {}));
          } else if (tools.submit_development_work) {
            const task = payload.task as TaskProgress;
            await tools.write!.execute("write", { path: "main.mjs", content: "export const actions={async echo(input){return {n:input.n};}};" });
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
    architecture, calls, failures, maxActive: () => maxActive };
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
