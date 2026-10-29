import { callFixture } from "../helpers/m7-test-boundaries.mjs";
import { toolText } from "../helpers/m7-test-boundaries.mjs";
import type { PiSessionOptions, PiSessionPort, RegisteredTool, SessionMessage } from "../../src/runtime/pi-port.mjs";
import type { ToolResult } from "../../src/contracts/tools.mjs";
import type { DevelopmentExecutorPort } from "../../src/development/development.mjs";
import type { DevelopmentTask, DevelopmentArchitecture, DevelopmentReport, DevelopmentReview, DevelopmentWork } from "../../src/contracts/development.mjs";
import type { DevelopmentContextPayload } from "../../src/development/development-context.mjs";
import type { DevelopmentRunRecord, TaskProgress, DevelopmentFeedback, PassedDevelopmentArchitecture } from "../../src/development/development-controller-types.mjs";
import type { ExecutionOutcome, IsolationAvailability } from "../../src/development/development-executor.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import { fixtureDeferred, fixtureTools, type FixtureTool } from "../helpers/m7-test-boundaries.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevelopmentController } from "../../src/development/development.mjs";
import { createAcceptanceLedger } from "../../src/verification/acceptance-contract.mjs";
import { readDevelopmentRunRecord } from "../../src/development/development-record.mjs";
import { DevelopmentStore } from "../../src/development/development-store.mjs";
import { DevelopmentWorkspace } from "../../src/development/development-workspace.mjs";
import { hashValue } from "../../src/development/development-contract.mjs";
import { InputError } from "../../src/requirements/core.mjs";
import { createPlatformSnapshot, platformCapabilityCatalog, renderPlatformRules } from "../../src/architecture/platform-contract.mjs";
import { WebCapabilities } from "../../src/runtime/web-capabilities.mjs";
import { developmentArchitecture, developmentPlan, developmentReview, developmentIssue, developmentWork } from "../helpers/development.mjs";
import type { DevelopmentPlan } from "../../src/contracts/development.mjs";
import type { PathLike } from "fs";

const submissionNames = { planner: "submit_development_plan", developer: "submit_development_work", reviewer: "submit_development_review" } as const;
const deferred = fixtureDeferred;

type FixtureRole = keyof typeof submissionNames;
interface ModelPayload extends Omit<DevelopmentContextPayload, "task" | "requirements" | "design" | "handoffs"> {
  task?: TaskProgress | null | undefined; requirements?: PassedDevelopmentArchitecture["requirements"] | undefined; design?: PassedDevelopmentArchitecture["design"] | undefined;
  subjectHash?: string; mode?: string; issues?: { review: DevelopmentReview; rejectedPlan: DevelopmentPlan }; feedback?: Omit<DevelopmentFeedback, "report"> & { report?: import("../../src/development/development-controller-types.mjs").DevelopmentEvidence }; remaining?: { corrections?: number; [key: string]: unknown };
  handoffs?: { taskId: string; codeHash?: string; continue?: boolean }[]; contextSections?: { section: string }[]; contextTruncated?: boolean;
}
interface ModelRecord { role: FixtureRole; options: PiSessionOptions; tools: Record<string, FixtureTool>; prompts: ModelPayload[];
  disposed: boolean; aborted: boolean; usagePercent: number; payload?: ModelPayload; lastSubmission?: ToolResult;
  stopReason?: string; errorMessage?: string; release?: () => void; autoCompactionEnabled?: boolean; session?: ModelSession }
interface ModelSession extends PiSessionPort { messages: SessionMessage[]; getContextUsage(): { percent: number } }
interface PromptContext { record: ModelRecord; session: ModelSession; payload: ModelPayload; submit(value: unknown): Promise<ToolResult>;
  respond(): Promise<ToolResult>; write(): Promise<void>; emit(event: { type: string; [key: string]: unknown }): void }
type PromptHandler = (context: PromptContext) => unknown | Promise<unknown>;
function modelFactory(records: ModelRecord[], onPrompt?: PromptHandler) {
  return async (options: PiSessionOptions) => {
    const tools = fixtureTools(options.customTools);
    const role = (Object.keys(submissionNames) as FixtureRole[]).find((key) => tools[submissionNames[key]]);
    assert.ok(role, "模拟模型会话必须有当前职责的结构化提交工具");
    const record: ModelRecord = { role, options, tools, prompts: [], disposed: false, aborted: false, usagePercent: 10 };
    let listener: Parameters<NonNullable<PiSessionPort["subscribe"]>>[0] | null = null;
    const submit = async (value: unknown) => {
      if (role === "planner" && objectFields(objectFields(tools[submissionNames[role]]!.parameters).properties).indexPath) {
        const { cases, ...index } = objectFields(value);
        await tools.write!.execute("fixture-cases", { path: "cases.json", content: JSON.stringify(cases) });
        await tools.write!.execute("fixture-index", { path: "index.json", content: JSON.stringify({ ...index, caseFiles: ["cases.json"] }) });
        value = { indexPath: "index.json" };
      }
      const result = await tools[submissionNames[role]]!.execute("fixture-submit", value);
      record.lastSubmission = result;
      return result;
    };
    const session: ModelSession = {
      messages: [] as SessionMessage[],
      subscribe(fn: Parameters<NonNullable<PiSessionPort["subscribe"]>>[0]) { listener = fn; return () => { listener = null; }; },
      async prompt(message: string) {
        const payload: ModelPayload = JSON.parse(String(message)); record.payload = payload; record.prompts.push(payload);
        session.messages.push({ role: "user", content: message });
        const write = async () => {
          for (const path of payload.task!.files) await (tools.write ?? tools.write_code_file)!.execute("fixture-write", {
            path, content: `// simulated model task ${payload.task!.id}, prompt ${record.prompts.length}\nconsole.log(JSON.stringify({ok:true}));\n`,
          });
        };
        const respond = async () => {
          if (role === "planner") return submit(developmentPlan({ requirements: payload.requirements!, design: payload.design! }));
          if (role === "reviewer") return submit(developmentReview(payload.subjectHash!));
          await write(); return submit(developmentWork(payload.task!));
        };
        if (onPrompt) await onPrompt({ record, session, payload, submit, respond, write, emit: (event) => listener && callFixture(listener, undefined, [event]) });
        else await respond();
        session.messages.push({ role: "assistant", stopReason: record.stopReason ?? "stop", ...(record.errorMessage === undefined ? {} : { errorMessage: record.errorMessage }),
          content: "模拟回复，完成状态由提交工具决定" });
        listener && callFixture(listener, undefined, [{ type: "turn_end" }]);
      },
      getContextUsage() { return { percent: record.usagePercent }; },
      setAutoCompactionEnabled(value: boolean) { record.autoCompactionEnabled = value; },
      async abort() { record.aborted = true; record.release?.(); },
      dispose() { record.disposed = true; },
    };
    record.session = session; records.push(record); return session;
  };
}

// This executor deliberately simulates results. These tests verify orchestration, not generated program behavior.
type VerifyInput = Parameters<NonNullable<DevelopmentExecutorPort["verify"]>>[0];
type VerifyReport = Awaited<ReturnType<NonNullable<DevelopmentExecutorPort["verify"]>>>;
interface ExecutorHooks { onVerify?: (options: VerifyInput, report: VerifyReport, number: number) => VerifyReport | Promise<VerifyReport>;
  onProbe?: (options: Parameters<DevelopmentExecutorPort["probe"]>[0]) => IsolationAvailability | Promise<IsolationAvailability>;
  onRun?: (options: Parameters<NonNullable<DevelopmentExecutorPort["run"]>>[0]) => ExecutionOutcome | Promise<ExecutionOutcome> }
function fakeExecutor({ onVerify, onProbe, onRun }: ExecutorHooks = {}) {
  const calls = { probe: [] as Parameters<DevelopmentExecutorPort["probe"]>[0][], verify: [] as VerifyInput[], run: [] as Parameters<NonNullable<DevelopmentExecutorPort["run"]>>[0][] };
  const executor = {
    calls,
    async probe(options: Parameters<DevelopmentExecutorPort["probe"]>[0]) {
      calls.probe.push(options);
      return onProbe ? onProbe(options) : { available: true, kind: "test-fake", reason: "仅用于控制器测试的模拟隔离执行器" };
    },
    async run(options: Parameters<NonNullable<DevelopmentExecutorPort["run"]>>[0]) {
      calls.run.push(options);
      return onRun ? onRun(options) : { status: "passed", exitCode: 0, stdout: '{"ok":true}', stderr: "", output: { ok: true } };
    },
    async verify(options: VerifyInput) {
      calls.verify.push(options);
      await readFile(join(options.snapshot.path, options.entrypoint), "utf8");
      const report: VerifyReport = { status: "passed", codeHash: options.snapshot.hash, summary: "模拟全部用例通过",
        results: options.cases.map((item) => ({ caseId: item.id, taskId: item.taskId, acceptanceId: item.acceptanceId,
          status: "passed", input: item.input, exitCode: 0, stdout: item.assertions[0]!.expectedJson, stderr: "",
          actual: JSON.parse(String(item.assertions[0]!.expectedJson)),
          expected: item.assertions.map(({ path, expectedJson }) => ({ path, value: JSON.parse(String(expectedJson)) })) })) };
      return onVerify ? onVerify(options, report, calls.verify.length) : report;
    },
  };
  return executor;
}

interface FixtureOptions extends ExecutorHooks { onPrompt?: PromptHandler; architecture?: PassedDevelopmentArchitecture;
 executor?: ReturnType<typeof fakeExecutor>; getArchitecture?: (id: string) => Promise<unknown>; web?: import("../../src/runtime/web-capabilities.mjs").WebCapabilityPort;
 limits?: ConstructorParameters<typeof DevelopmentController>[0]["limits"] }
async function fixture(t: test.TestContext, options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-development-controller-"));
  const dataDir = join(root, "data"), sessions: ModelRecord[] = [], controllers: DevelopmentController[] = [];
  const architecture: PassedDevelopmentArchitecture = options.architecture ?? developmentArchitecture();
  const executor = options.executor ?? fakeExecutor(options);
  const workspace = new DevelopmentWorkspace({ dataDir });
  const config = { config: { llmConfigured: true }, cwd: root, dataDir, workspace, executor,
    sessionFactory: modelFactory(sessions, options.onPrompt), getArchitecture: options.getArchitecture ?? (async () => architecture),
    ...(options.web ? { web: options.web } : {}),
    ...(options.limits ? { limits: options.limits } : {}) };
  const controller = new DevelopmentController(config); controllers.push(controller);
  t.after(async () => {
    await Promise.all(controllers.map((item) => item.close()));
    const unseal = async (path: string) => {
      await chmod(path, 0o700);
      for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await unseal(join(path, entry.name));
    };
    await unseal(root); await rm(root, { recursive: true, force: true });
  });
  return { root, dataDir, sessions, architecture, controller, workspace, executor, config, controllers };
}

const failReport = (report: VerifyReport, marker = "raw-failure") => ({ ...report, status: "failed", summary: "模拟业务断言不匹配",
  results: report.results.map((item, index) => index ? item : { ...item, status: "failed", actual: { error: marker },
    stdout: JSON.stringify({ error: marker }), stderr: `${marker}-stderr`, reason: "assertion_mismatch" }) });

for (const repairNode of ["plan", "task", "integration"] as const) test(`${repairNode}的十条反馈分组进入独立子会话，合并成果后完整复评`, async t => {
  let rejected = false, rechecked = false;
  const f = await fixture(t, { onPrompt: async ({ record, payload, submit, respond }) => {
    const target = record.role === "reviewer" && payload.mode === repairNode && (repairNode !== "task" || payload.task?.id === "core");
    if (target && !rejected) {
      rejected = true;
      const issues = Array.from({ length: 10 }, (_, index) => {
        const task = repairNode === "task" || index < 5 ? "core" : "guard";
        return { ...developmentIssue(repairNode === "plan" ? "plan" : "code", `issue_${index}`),
          description: `补齐独立场景 ${index}`, remedy: `保留修复标记 FIX_${index};`, taskIds: [task],
          files: [task === "core" ? "main.mjs" : "guard.mjs"],
          ...(repairNode === "plan" ? { candidatePaths: [`/tasks/${task === "core" ? 0 : 1}/description`] } : {}) };
      });
      return submit(developmentReview(payload.subjectHash!, { verdict: "revise", issues }));
    }
    if (target && rejected) rechecked = true;
    await respond();
  } });
  const originalFactory = f.controller.sessionFactory, assignments: { count: number; binding: unknown }[] = [];
  f.controller.sessionFactory = async options => {
    const tools = fixtureTools(options.customTools);
    if (!tools.submit_repair_patch) return originalFactory(options);
    return { sessionFile: join(options.sessionStorage!.directory, `child-${assignments.length}-${Math.random().toString(16).slice(2)}.jsonl`),
      async prompt(text) {
        const input = JSON.parse(text), assignment = input.repairAssignment;
        assignments.push({ count: assignment.issues.length, binding: options.sessionStorage!.binding });
        const page = JSON.parse(toolText(await tools.read_repair_context!.execute("read", { section: "base", limit: 24000 })));
        assert.equal(page.nextOffset, null); const base = JSON.parse(page.text);
        const marker = assignment.issues.map((issue: { remedy: string }) => issue.remedy).join(" ");
        const updates = assignment.allowedPaths.map((path: string) => {
          const keys = path.slice(1).split("/").map(key => key.replaceAll("~1", "/").replaceAll("~0", "~"));
          const value = keys.reduce((value: Record<string, unknown>, key: string) => value[key] as Record<string, unknown>, base);
          return { path, value: String(value) + "\n// " + marker };
        });
        await tools.submit_repair_patch!.execute("submit", { baseHash: assignment.baseHash, issueIds: assignment.issues.map((issue: { id: string }) => issue.id), summary: "逐项补充本组场景，等待独立复评", updates });
      }, abort() {}, dispose() {} };
  };
  const result = await f.controller.run(f.architecture);
  assert.equal(result.status, "completed", result.summary);
  assert.ok(rechecked); assert.ok(assignments.length >= 4); assert.ok(assignments.every(group => group.count <= 3));
  assert.equal(new Set(assignments.map(group => JSON.stringify(group.binding))).size, assignments.length);
  const text = repairNode === "plan" ? JSON.stringify(result.plan)
    : (await Promise.all(result.snapshot!.files.map(file => readFile(join(result.snapshot!.path, file.path), "utf8")))).join("\n");
  for (let index = 0; index < 10; index++) assert.ok(text.includes(`FIX_${index};`), `问题${index}的修改必须保留`);
  assert.equal(result.budgets.corrections, 5, "一个修复批次扣一次纠错额度，子组不重复扣减");
});

function bindPlatform<A extends PassedDevelopmentArchitecture>(architecture: A, snapshot: ReturnType<typeof createPlatformSnapshot>) {
  const platformHash = hashValue(snapshot);
  return Object.assign(architecture, { platformSnapshot: structuredClone(snapshot), platformContractVersion: snapshot.version,
    platformHash, reviewContext: { candidateHash: architecture.candidateHash, platformHash } });
}

async function contextField<K extends keyof ModelPayload & string>(record: ModelRecord, payload: ModelPayload, section: K): Promise<ModelPayload[K]> {
  if (Object.hasOwn(payload, section)) return payload[section];
  assert.ok(payload.contextSections!.some((item) => item.section === section), `压缩输入必须保留 ${section} 的读取入口`);
  let offset = 0, text = "";
  do {
    const page = JSON.parse(String(toolText((await record.tools.read_development_context!.execute("platform-context", { section, offset, limit: 8000 })))));
    text += page.text; offset = page.nextOffset;
  } while (offset !== null);
  return JSON.parse(String(text));
}

test("纯页面研发保留私有 Node 检查与空动作清单，按现有评审和快照打包", async (t) => {
  const architecture = developmentArchitecture();
  Object.assign(architecture.design, { schemaVersion: 2, profile: "light", connections: [],
    interaction: { defaultEntry: "application", page: true, operations: false, inputs: "本地参数", results: "页面图形",
      persistentData: "无", assistant: { enabled: false, purpose: "" } } });
  architecture.contractVersion = 2; architecture.candidateHash = hashValue(architecture.design);
  architecture.review.candidateHash = architecture.candidateHash;
  bindPlatform(architecture, createPlatformSnapshot());
  const files = { "actions.mjs": "export const actions={};", "ui/index.html": "<!doctype html><title>Tool</title>",
    "checks/page.mjs": "import {readFile} from 'node:fs/promises';console.log(JSON.stringify({ok:(await readFile(new URL('../ui/index.html',import.meta.url),'utf8')).includes('<title>Tool</title>')}));" };
  const { controller, executor } = await fixture(t, { architecture,
    onVerify: async (options, report) => ({ ...report, browserVerified: false, evidenceMode: "node_checks" }),
    onPrompt: async ({ record, payload, submit, respond }) => {
      if (record.role === "planner") {
        const base = developmentPlan(architecture);
        return submit({ ...base, schemaVersion: 2, runtime: "node-action", entrypoint: "actions.mjs",
          tasks: base.tasks.map((task) => ({ ...task, files: Object.keys(files) })),
          cases: base.cases.map((item) => ({ ...item, kind: "node-check", entrypoint: "checks/page.mjs",
            assertions: [{ path: "ok", expectedJson: "true" }] })),
          application: { protocolVersion: 2, runtime: "node-action", entrypoint: "actions.mjs",
            page: { entrypoint: "ui/index.html", resources: [{ path: "ui/index.html", sha256: "" }] },
            actions: [], stateVersion: 1, evidenceIds: [] } });
      }
      if (record.role === "developer") {
        for (const [path, content] of Object.entries(files)) await record.tools.write!.execute("page-write", { path, content });
        return submit(developmentWork(payload.task!));
      }
      await respond();
    } });
  const result = await controller.run(architecture);
  assert.equal(result.status, "completed", result.summary);
  assert.deepEqual(result.package!.application!.actions, []);
  assert.deepEqual(result.package!.application!.page!.resources.map((item) => item.path), ["ui/index.html"]);
  assert.ok(result.package!.snapshot.files.some((item) => item.path === "checks/page.mjs"));
  assert.ok(result.package!.application!.page!.resources.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)));
  assert.ok(executor.calls.verify.every((call) => call.cases.every((item) => item.kind === "node-check" && !item.actionId)));
  assert.equal(result.reports!.at(-1)!.browserVerified, false);
  assert.ok(result.package!.application!.evidenceIds.includes(result.reports!.at(-1)!.id));
});

test("研发规划、开发与独立评审接收同一冻结平台事实，评审仍不能联网", async (t) => {
  const snapshot = createPlatformSnapshot(), architecture = bindPlatform(developmentArchitecture(), snapshot), calls: { input: unknown; options: import("../../src/runtime/web-capabilities.mjs").WebRunOptions | undefined }[] = [];
  const { controller, sessions } = await fixture(t, { architecture,
    web: { async fetch(input, options) { calls.push({ input, options }); return { status: "ok", results: [{ url: objectFields(input).url, content: "模拟技术资料" }] }; } },
    onPrompt: async ({ record, payload, respond }) => {
      assert.deepEqual(await contextField(record, payload, "platformSnapshot"), snapshot);
      assert.equal(await contextField(record, payload, "platformContractVersion"), snapshot.version);
      assert.equal(await contextField(record, payload, "platformHash"), architecture.platformHash);
      assert.deepEqual(await contextField(record, payload, "capabilities"), platformCapabilityCatalog(snapshot));
      assert.equal(await contextField(record, payload, "platformGuide"), renderPlatformRules(snapshot), `${record.role} 应能按需读取同一平台规则`);
      if (record.role === "reviewer") {
        assert.equal(record.tools.web_fetch, undefined); assert.equal(record.tools.web_search, undefined);
      } else {
        for (const name of ["web_search", "web_fetch"])
          assert.equal(record.options.customTools!.filter((tool) => tool.name === name).length, 1);
        const result = JSON.parse(String(toolText((await record.tools.web_fetch!.execute("technical-read", { url: "https://example.com/spec" })))));
        assert.equal(result.status, "ok");
      }
      await respond();
    } });
  const result = await controller.run(architecture);
  assert.equal(result.status, "completed");
  assert.deepEqual([...new Set(sessions.map((item) => item.role))].sort(), ["developer", "planner", "reviewer"]);
  assert.equal(calls.length, 3); assert.ok(calls.every((call) => call.options!.allowNetwork === true));
  assert.deepEqual(result.architecture.platformSnapshot, snapshot);
  assert.equal(result.architecture.platformHash, architecture.platformHash);
});

test("所有研发角色和分页上下文保留版本绑定的完整待验证义务，不将后移事项当作验收通过", async (t) => {
  const snapshot = createPlatformSnapshot(), architecture = bindPlatform(developmentArchitecture(), snapshot);
  const issues = Array.from({ length: 10 }, (_, index) => ({ id: `pending_${index}`, requirementId: `verification_${index}`,
    requirementIds: ["task"], owner: "system", stage: ["development", "activation", "runtime"][index % 3], blocking: false,
    question: `核对第 ${index} 项实际交付能力`, impact: "待实际验证，不能以模拟结果代替。".repeat(150),
    checks: ["platform.deliveryRoutes.managedService"],
    stageDecision: { reason: "当前只核实平台存在受控交付通道，实际功能仍须在指定阶段验证", assessmentId: "pre_frozen" },
    verification: [{ id: `pending_${index}`, status: "verified", message: "仅核实平台通道", evidence: [
      { source: "platform", reference: "platform.deliveryRoutes.managedService", detail: "已提供受控运行通道，不证明本智能体已交付" },
    ] }],
  }));
  const deferred = { assessmentId: "pre_frozen", requirementHash: "d".repeat(64), platformHash: architecture.platformHash,
    hash: hashValue(issues), issues };
  Object.assign(architecture, { deferredVerifications: deferred });
  const roles = new Set();
  const { controller } = await fixture(t, { architecture, onPrompt: async ({ record, payload, respond }) => {
    roles.add(record.role);
    assert.equal(payload.contextTruncated, true, "长待验收记录必须使用分页入口，不能挤占完整上下文预算");
    assert.ok(payload.contextSections!.some((section) => section.section === "deferredVerifications"));
    assert.deepEqual(await contextField(record, payload, "deferredVerifications"), deferred);
    assert.match(record.options.systemPrompt!, /不能当作已验证证据/);
    assert.match(record.options.systemPrompt!, /未知硬件、缺少平台通道或第三方契约不能靠后移阶段放行/);
    if (record.role === "planner") {
      payload.requirements = await contextField(record, payload, "requirements");
      Reflect.deleteProperty(payload, "design"); payload.design = await contextField(record, payload, "design");
    }
    if (record.role === "developer") { Reflect.deleteProperty(payload, "task"); payload.task = await contextField(record, payload, "task"); }
    await respond();
  } });
  const result = await controller.run(architecture);
  assert.equal(result.status, "completed", result.summary);
  assert.deepEqual([...roles].sort(), ["developer", "planner", "reviewer"]);
  assert.deepEqual(result.architecture.deferredVerifications, deferred);
});

test("研发不接受与已评估摘要不一致的平台事实，启动模型前阻止篡改快照", async (t) => {
  const architecture = bindPlatform(developmentArchitecture(), createPlatformSnapshot());
  architecture.platformSnapshot.network.allowNetwork = false;
  const { controller, sessions } = await fixture(t, { architecture });
  const result = await controller.run(architecture);
  assert.equal(result.status, "failed"); assert.equal(result.delivery, "blocked");
  assert.match(result.summary, /平台事实契约无效/); assert.equal(sessions.length, 0);
});

test("研发联网必须同时满足冻结平台许可和本轮需求，拒绝前不调用网络底座", async (t) => {
  for (const policy of ["snapshot", "requirements"]) await t.test(policy, async (child) => {
    const snapshot = createPlatformSnapshot({ allowNetwork: policy !== "snapshot" });
    const architecture = bindPlatform(developmentArchitecture(), snapshot);
    if (policy === "requirements") architecture.requirements.push({ id: "offline", text: "禁止联网", ...{ source: "user" } });
    let calls = 0;
    const refusedRequest = async () => { calls++; throw new Error("不允许发出网络请求"); };
    const { controller, sessions } = await fixture(child, { architecture,
      web: new WebCapabilities({ lookup: refusedRequest, requestPublic: refusedRequest, fetchImpl: refusedRequest }),
      onPrompt: async ({ record, payload, respond }) => {
        assert.deepEqual(await contextField(record, payload, "platformSnapshot"), snapshot);
        if (record.role !== "reviewer") {
          assert.ok(record.tools.web_fetch, "宿主在工具入口执行授权判断");
          await assert.rejects(record.tools.web_fetch.execute("offline-read", { url: "https://example.com/spec" }), /不联网/);
        } else assert.equal(record.tools.web_fetch, undefined);
        await respond();
      } });
    const result = await controller.run(architecture);
    assert.equal(result.status, "completed", result.summary);
    assert.equal(calls, 0); assert.ok(sessions.some((item) => item.role === "developer"));
  });
});

test("两个任务使用独立会话，交接保留结果，评审均为全新只读会话", async (t) => {
  const { controller, sessions, architecture, executor, dataDir } = await fixture(t);
  const result = await controller.run(architecture);
  const dataRoot = await realpath(dataDir);
  assert.equal(result.status, "completed"); assert.equal(result.delivery, "needs_development");
  assert.deepEqual(sessions.map((item) => item.role), ["planner", "reviewer", "developer", "reviewer", "developer", "reviewer", "reviewer"]);
  assert.ok(sessions.every((item) => item.options.maxOutputTokens === { planner: 8192, developer: 16384, reviewer: 4096 }[item.role]));
  assert.ok(sessions.every((item) => item.options.reasoningMode === (item.role === "reviewer" ? "off" : "auto")));
  assert.ok(sessions.every((item) => item.lastSubmission?.terminate === true && item.autoCompactionEnabled === false));
  assert.ok(sessions.every((session) => session.options.dataDir === join(dataRoot, "agents", architecture.agentId)));
  assert.ok(sessions.every((session) => session.options.cwd === join(dataRoot, "agents", architecture.agentId, "development", "workspaces", result.id, "code")));
  assert.equal(result.package!.snapshot.agentId, architecture.agentId);
  assert.equal(result.package!.snapshot.path, join(dataRoot, "agents", architecture.agentId, "development", "snapshots", result.package!.codeHash));
  assert.equal(JSON.parse(String(await readFile(join(dataDir, "agents", architecture.agentId, "development", "records", `${result.id}.json`), "utf8"))).id, result.id);
  const developers = sessions.filter((item) => item.role === "developer"), reviews = sessions.filter((item) => item.role === "reviewer");
  assert.notEqual(developers[0]!.session, developers[1]!.session);
  assert.equal(developers[0]!.prompts.length, 1); assert.equal(developers[1]!.prompts.length, 1);
  assert.equal(developers[0]!.payload!.task!.id, "core"); assert.equal(developers[1]!.payload!.task!.id, "guard");
  assert.equal(developers[1]!.payload!.handoffs![0]!.taskId, "core");
  assert.equal(developers[1]!.payload!.handoffs![0]!.codeHash, result.handoffs![0]!.codeHash);
  assert.equal(developers[1]!.session!.messages.filter((item) => item.role === "user").length, 1);
  assert.equal(new Set(reviews.map((item) => item.session)).size, reviews.length);
  assert.ok(reviews.every((item) => !item.tools.write_code_file && !item.tools.run_development_checks));
  assert.ok(!sessions[0]!.tools.write_code_file, "规划会话只读");
  assert.ok(sessions.every((item) => item.disposed));
  assert.deepEqual(executor.calls.verify.map((item) => item.cases.length), [2, 4, 4], "任务验收包含前面任务的回归测试，最后整体验收");
  assert.equal(result.package!.codeHash, result.reports!.at(-1)!.codeHash);
  assert.equal(result.package!.planHash, hashValue(result.plan));
  assert.equal(result.package!.verificationId, result.reports!.at(-1)!.id);
  assert.deepEqual(result.tasks.map((item) => item.status), ["verified", "verified"]);
});

test("思考模型研发按角色选择公共策略，保留原输出额度和调用次数规则", async (t) => {
  const { controller, architecture, sessions } = await fixture(t);
  controller.config = { llmConfigured: true, chatUrl: "https://api.xiaomimimo.com/v1/chat/completions",
    model: "mimo-v2.6-pro", apiKey: "fixture-only" };
  assert.equal((await controller.run(architecture)).status, "completed");
  assert.deepEqual(new Set(sessions.map((item) => item.role)), new Set(["planner", "developer", "reviewer"]));
  for (const item of sessions) {
    assert.equal(item.options.maxOutputTokens, { planner: 32768, developer: 65536, reviewer: 16384 }[item.role]);
    assert.equal(item.options.reasoningMode, item.role === "reviewer" ? "off" : "auto");
  }
});

test("独立研发评审请求关闭可选思考后，长度不足仍不能接受阶段结果", async (t) => {
  const { controller, architecture, sessions, executor } = await fixture(t, { onPrompt: async ({ record, respond }) => {
    if (record.role === "reviewer") { record.stopReason = "length"; return; }
    await respond();
  } });
  const result = await controller.run(architecture);
  assert.equal(result.status, "failed"); assert.equal(result.diagnostic!.reason, "output_limit");
  assert.equal(result.diagnostic!.role, "reviewer"); assert.equal(result.plan, null); assert.equal(result.package, null);
  assert.deepEqual(sessions.map((item) => item.options.reasoningMode), ["auto", "off"] as const);
  assert.equal(sessions[1]!.options.maxOutputTokens, 4096); assert.equal(sessions[1]!.prompts.length, 1);
  assert.equal(executor.calls.verify.length, 0);
});

test("研发模型重试、截断和半截流保存各自原因，不再统称连接失败", async (t) => {
  for (const [outcome, reason] of [["retry", "api_unavailable"], ["truncated", "output_limit"], ["stream", "api_stream_interrupted"]])
    await t.test(outcome, async (child) => {
      const { controller, architecture } = await fixture(child, { onPrompt: async ({ record, emit }) => {
        assert.equal(record.role, "planner");
        if (outcome === "stream") throw new Error("Stream ended without finish_reason private-key-fixture");
        if (outcome === "truncated") { record.stopReason = "length"; return; }
        emit({ type: "auto_retry_start", attempt: 5, errorMessage: "503 Service unavailable private-key-fixture" });
        emit({ type: "auto_retry_end", success: false, finalError: "503 Service unavailable private-key-fixture" });
      } });
      const result = await controller.run(architecture);
      assert.equal(result.status, "failed");
      assert.equal(result.diagnostic!.reason, reason);
      assert.equal(result.diagnostic!.role, "planner");
      assert.equal(result.diagnostic!.phase, "planning");
      assert.doesNotMatch(result.summary, /检查连接/);
      assert.doesNotMatch(JSON.stringify(result), /private-key-fixture/);
      assert.deepEqual((await controller.get(architecture.agentId))!.diagnostic!, result.diagnostic);
    });
});

test("规划、开发与评审均记录执行前拒绝，并且不保存SDK回执中的原始内容", async (t) => {
  for (const role of ["planner", "developer", "reviewer"]) await t.test(role, async (child) => {
    const { controller, architecture } = await fixture(child, { onPrompt: async ({ record, emit, respond }) => {
      if (record.role === role) {
        const toolName = submissionNames[role];
        emit({ type: "tool_execution_start", toolName, toolCallId: "sdk-rejected", args: { summary: "PRIVATE_ARGUMENT_VALUE" } });
        emit({ type: "tool_execution_end", toolName, toolCallId: "sdk-rejected", isError: true,
          result: { content: [{ type: "text", text: 'Validation failed\nReceived arguments: PRIVATE_ARGUMENT_VALUE' }] } });
      }
      await respond();
    } });
    const result = await controller.run(architecture);
    assert.equal(result.status, "completed", result.summary);
    assert.ok(result.submissionCounts![role]!.rejected > 0);
    assert.ok(result.submissionCounts![role]!.accepted > 0);
    assert.ok(result.submissionAttempts!.some((item) => item.role === role && item.stage === "sdk"));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ARGUMENT_VALUE|Received arguments/);
    const stored = readDevelopmentRunRecord(await controller.store.getRun(result.id));
    assert.deepEqual(stored!.submissionCounts!, result.submissionCounts);
    assert.doesNotMatch(JSON.stringify(stored), /PRIVATE_ARGUMENT_VALUE|Received arguments/);
  });
});

test("同一任务失败修复保留开发会话，原始测试证据完整进入修复输入", async (t) => {
  const { controller, sessions, architecture } = await fixture(t, {
    onVerify: (_options, report, number) => number === 1 ? failReport(report, "unique-actual-output") : report,
    onPrompt: async ({ record, respond, payload }) => {
      if (record.role === "reviewer" && payload.mode === "task") {
        const developer = sessions.findLast((item) => item.role === "developer" && item.payload!.task!.id === payload.task!.id);
        assert.equal(developer!.disposed!, false, "验收期间保留当前开发会话");
        await assert.rejects(developer!.tools!.write_code_file!.execute("late-write", { path: "main.mjs", content: "late" }), /当前阶段/);
      }
      await respond();
    },
  });
  const result = await controller.run(architecture);
  assert.equal(result.status, "completed");
  const developers = sessions.filter((item) => item.role === "developer");
  assert.equal(developers.length, 2); assert.equal(developers[0]!.prompts.length, 2);
  assert.deepEqual(developers[0]!.prompts[1]!.feedback!.report, result.reports[0]);
  assert.equal(developers[0]!.prompts[1]!.feedback!.report!.results[0]!.stderr, "unique-actual-output-stderr");
  assert.deepEqual(developers[0]!.prompts[1]!.feedback!.report!.results[0]!.actual, { error: "unique-actual-output" });
  assert.equal(result.reviews![1]!.verdict, "pass", "模拟评审误判通过也不能覆盖真实测试失败");
  assert.equal(result.tasks![0]!.repairs, 1); assert.equal(result.tasks![0]!.attempts, 2);
  assert.equal(result.budgets.corrections, 5);
});

test("整体验收失败创建新修复任务与新会话，携带完整失败证据再做整体验收", async (t) => {
  const { controller, sessions, architecture, executor } = await fixture(t, {
    onVerify: (_options, report, number) => number === 3 ? failReport(report, "integration-regression") : report,
  });
  const result = await controller.run(architecture);
  assert.equal(result.status, "completed");
  const developers = sessions.filter((item) => item.role === "developer");
  assert.equal(developers.length, 3); assert.equal(new Set(developers.map((item) => item.session)).size, 3);
  assert.equal(developers[2]!.payload!.task!.integration, true);
  assert.deepEqual(developers[2]!.payload!.feedback!.report, result.reports[2]);
  assert.equal(developers[2]!.payload!.feedback!.report!.mode, "integration");
  assert.equal(result.tasks.length, 3); assert.ok(result.tasks.every((item) => item.status === "verified"));
  assert.equal(result.budgets.integrationRepairs, 1); assert.equal(result.budgets.corrections, 5);
  assert.equal(executor.calls.verify.length, 5); assert.equal(result.reports!.at(-1)!.mode, "integration");
});

test("交付启动失败把原始证据交给新修复会话，扣一次预算并重新完整验收", async (t) => {
  const { controller, sessions, architecture, executor } = await fixture(t);
  const activations: DevelopmentRunRecord[] = [];
  const smoke = { status: "failed", summary: "模拟交付入口输出不符合协议", results: [{
    caseId: "runtime_start", input: "实际启动输入", status: "failed", exitCode: 1,
    stdout: "unique-smoke-stdout", stderr: "unique-smoke-stderr", reason: "stdout_must_be_one_json_value",
    actual: { output: "wrong" }, expected: { output: "structured-json" },
  }] };
  const result = await controller.run(architecture, { activate: async (record) => {
    activations.push(record);
    if (activations.length === 1) return { delivery: "blocked", summary: "需要修复启动问题", repair: smoke };
    return { delivery: "ready", summary: "模拟运行检查通过", runtimeCheck: { status: "passed", codeHash: record.package!.codeHash } };
  } });
  assert.equal(result.status, "completed"); assert.equal(result.delivery, "ready"); assert.equal(activations.length, 2);
  const developers = sessions.filter((item) => item.role === "developer");
  assert.equal(developers.length, 3); assert.equal(new Set(developers.map((item) => item.session)).size, 3);
  const repair = developers[2]!.payload;
  assert.equal(repair!.task!.integration, true); assert.equal(repair!.feedback!.report!.mode, "runtime");
  assert.deepEqual(repair!.feedback!.report!.results, smoke.results);
  assert.equal(repair!.feedback!.report!.codeHash, activations[0]!.package!.codeHash);
  assert.equal(repair!.remaining!.corrections, 5); assert.equal(repair!.remaining!.integrationRepairs, 1);
  assert.equal(result.budgets.corrections, 5); assert.equal(result.budgets.integrationRepairs, 1);
  assert.equal(result.reports.filter((report) => report.mode === "runtime").length, 1);
  assert.equal(executor.calls.verify.length, 5);
  assert.deepEqual(executor.calls.verify.slice(-2).map((call) => call.cases.map((item) => item.id)),
    [result.plan!.cases.map((item) => item.id), result.plan!.cases.map((item) => item.id)]);
  assert.equal(result.reports!.at(-1)!.mode, "integration"); assert.equal(result.reports!.at(-1)!.status, "passed");
  assert.equal(result.package!.verificationId, result.reports!.at(-1)!.id);
  assert.notEqual(activations[0]!.package!.codeHash, result.package!.codeHash);
  assert.equal(objectFields(result.runtimeCheck).codeHash, result.package!.codeHash);
});

test("阶段性保存继续原会话并保留当前任务和累计回合，不提前验收", async (t) => {
  let continued = false;
  const { controller, sessions, architecture, executor } = await fixture(t, {
    onPrompt: async ({ record, payload, submit, write, respond }) => {
      if (record.role === "developer" && !continued) {
        continued = true; await write();
        return submit(developmentWork(payload.task!, { continue: true, nextAction: "继续完成当前任务的输入检查" }));
      }
      await respond();
    },
  });
  const result = await controller.run(architecture);
  assert.equal(result.status, "completed");
  const developers = sessions.filter((item) => item.role === "developer");
  assert.equal(developers.length, 2);
  assert.equal(developers[0]!.prompts[0]!.task!.id, developers[0]!.prompts[1]!.task!.id);
  assert.equal(developers[0]!.prompts.length, 2);
  assert.equal(developers[0]!.prompts[1]!.handoffs![0]!.continue, true);
  assert.equal(developers[0]!.prompts[1]!.task!.turns, 1, "输入显示提交本轮之前的累计次数，实际调用在请求前记账");
  assert.equal(result.tasks![0]!.turns, 2); assert.equal(result.budgets.corrections, 6);
  assert.equal(executor.calls.verify.length, 3);
});

test("上下文接近上限时仍使用原会话，失败证据和预算保持连续", async (t) => {
  const { controller, sessions, architecture } = await fixture(t, {
    onVerify: (_options, report, number) => number === 1 ? failReport(report, "context-repair") : report,
    onPrompt: async ({ record, respond }) => {
      if (record.role === "developer") record.usagePercent = 70;
      await respond();
    },
  });
  const result = await controller.run(architecture);
  assert.equal(result.status, "completed");
  const developers = sessions.filter((item) => item.role === "developer");
  assert.equal(developers.length, 2); assert.equal(developers[0]!.prompts.length, 2);
  assert.equal(developers[0]!.payload!.task!.id, "core");
  assert.equal(developers[0]!.payload!.task!.turns, 1); assert.equal(developers[0]!.payload!.remaining!.corrections, 5);
  assert.deepEqual(developers[0]!.payload!.feedback!.report, result.reports[0]);
  assert.equal(developers[0]!.disposed, true);
});

test("当前任务回合达到上限后续接不能刷新预算", async (t) => {
  const { controller, architecture, sessions, executor } = await fixture(t, {
    limits: { developerTurns: 2 },
    onPrompt: async ({ record, payload, submit, respond, write }) => {
      if (record.role !== "developer") return respond();
      await write(); return submit(developmentWork(payload.task!, { continue: true, nextAction: "继续同一任务" }));
    },
  });
  const result = await controller.run(architecture);
  assert.equal(result.status, "failed"); assert.match(result.summary, /回合预算/);
  assert.equal(result.tasks![0]!.turns, 2); assert.equal(result.package, null); assert.equal(executor.calls.verify.length, 0);
  assert.equal(sessions.filter((item) => item.role === "developer").flatMap((item) => item.prompts).length, 2);
});

test("一次模型调用内部多回合超限后，即使已经提交也不能推进", async (t) => {
  const { controller, architecture, sessions, executor } = await fixture(t, {
    limits: { developerTurns: 2 },
    onPrompt: async ({ record, respond, emit }) => {
      await respond();
      if (record.role === "developer") for (let index = 0; index < 3; index++) emit({ type: "turn_end" });
    },
  });
  const result = await controller.run(architecture);
  assert.equal(result.status, "failed"); assert.equal(result.package, null); assert.equal(executor.calls.verify.length, 0);
  assert.ok(result.tasks![0]!.turns > 2); assert.equal(sessions.find!((item) => item.role === "developer")!.aborted, true);
});

test("取消中迟到提交和文件写入被拒绝，状态不会变成完成", { timeout: 10_000 }, async (t) => {
  const entered = deferred(), release = deferred(); let rejected = 0;
  const { controller, sessions, architecture } = await fixture(t, {
    onPrompt: async ({ record, payload, submit, respond }) => {
      if (record.role !== "developer") return respond();
      record.release = release.resolve; entered.resolve!(); await release.promise;
      await assert.rejects(submit(developmentWork(payload.task!)), { name: "AbortError" }); rejected++;
      await assert.rejects(record.tools.write_code_file!.execute("late", { path: "main.mjs", content: "late" }), { name: "AbortError" }); rejected++;
    },
  });
  const pending = controller.run(architecture); await entered.promise;
  assert.equal(controller.has(architecture.agentId), true);
  const cancellation = controller.cancel(architecture.agentId);
  const [result, cancelled] = await Promise.all([pending, cancellation]);
  assert.equal(rejected, 2); assert.equal(result.status, "cancelled"); assert.equal(result.delivery, "blocked");
  assert.equal(result.package, null); assert.equal(cancelled.cancelled, true);
  assert.equal((await controller.store.get(architecture.agentId))!.status!, "cancelled");
  assert.equal(controller.has(architecture.agentId), false); assert.ok(sessions.every((item) => item.disposed));
});

test("最终完成记录写入过程中取消，迟到的完成写入不能覆盖取消", { timeout: 10_000 }, async (t) => {
  const entered = deferred(), release = deferred();
  const { controller, architecture } = await fixture(t);
  const save = controller.store.save.bind(controller.store);
  Reflect.set(controller.store, "save", async (record: unknown, options: Parameters<typeof save>[1]) => {
    if (objectFields(record).status === "completed") { entered.resolve!(); await release.promise; }
    return save(record, options);
  });
  const pending = controller.run(architecture); await entered.promise;
  const cancelled = controller.cancel(architecture.agentId); release.resolve!();
  const [result, cancellation] = await Promise.all([pending, cancelled]);
  assert.equal(result.status, "cancelled"); assert.equal(result.delivery, "blocked");
  assert.equal(cancellation.development!.status, "cancelled");
  assert.equal((await controller.store.get(architecture.agentId))!.status!, "cancelled");
});

test("任务修复扣预算与修复调度必须在同一个持久检查点完成", async (t) => {
  const { controller, architecture } = await fixture(t, { onVerify: (_options, report, number) => number === 1 ? failReport(report) : report });
  const checkpoints: DevelopmentRunRecord[] = [], save = controller.store.save.bind(controller.store);
  Reflect.set(controller.store, "save", async (record: unknown, options: Parameters<typeof save>[1]) => {
    const saved = await save(record, options); checkpoints.push(readDevelopmentRunRecord(saved)); return saved;
  });
  const result = await controller.run(architecture);
  assert.equal(result.status, "completed");
  const debited = checkpoints.find((record) => record.tasks[0]?.repairs === 1);
  assert.ok(debited);
  assert.equal(debited.tasks[0]!.nextAction, "implement", "预算已扣时必须已经记录修复，重启不能再次验收并重复扣款");
  assert.equal(debited.tasks[0]!.attempts, 2);
  assert.equal(debited.budgets.corrections, 5);
});

test("整体验收修复扣预算与创建修复任务必须在同一个持久检查点完成", async (t) => {
  const { controller, architecture } = await fixture(t, { onVerify: (_options, report, number) => number === 3 ? failReport(report) : report });
  const checkpoints: DevelopmentRunRecord[] = [], save = controller.store.save.bind(controller.store);
  Reflect.set(controller.store, "save", async (record: unknown, options: Parameters<typeof save>[1]) => {
    const saved = await save(record, options); checkpoints.push(readDevelopmentRunRecord(saved)); return saved;
  });
  const result = await controller.run(architecture);
  assert.equal(result.status, "completed");
  const debited = checkpoints.find((record) => record.budgets.integrationRepairs === 1);
  assert.ok(debited!.tasks!.some((task) => task.integration && task.status === "pending"), "重启时必须能找到已经扣费的修复任务");
  assert.equal(debited!.budgets!.corrections, 5);
});

test("重启恢复已经扣减的修复预算和任务回合，不重做规划或复用旧会话", async (t) => {
  const { controller, sessions, architecture, config, dataDir, controllers } = await fixture(t, {
    onVerify: (_options, report, number) => number === 1 ? failReport(report) : report,
    onPrompt: async ({ record, respond }) => {
      if (record.role === "developer" && record.prompts.length === 2) {
        record.stopReason = "error"; record.errorMessage = "固定模拟进程在修复回合中断"; return;
      }
      await respond();
    },
  });
  const stopped = await controller.run(architecture);
  assert.equal(stopped.status, "failed"); assert.equal(stopped.budgets.corrections, 5);
  assert.equal(stopped.tasks![0]!.repairs, 1); assert.equal(stopped.tasks![0]!.turns, 2);
  // Simulate process loss from the last published retry checkpoint.
  await controller.store.save({ ...stopped, status: "running" });
  const store = new DevelopmentStore({ dataDir }); await store.ready;
  assert.equal((await store.get(architecture.agentId))!.status!, "interrupted");
  const resumedSessions: ModelRecord[] = [];
  const restarted = new DevelopmentController({ ...config, store, executor: fakeExecutor(), sessionFactory: modelFactory(resumedSessions) });
  controllers.push(restarted);
  const result = await restarted.run(architecture, { resume: true });
  assert.equal(result.status, "completed"); assert.equal(result.id, stopped.id);
  assert.equal(result.budgets.corrections, 5); assert.equal(result.tasks![0]!.repairs, 1); assert.equal(result.tasks![0]!.turns, 3);
  assert.equal(resumedSessions.some((item) => item.role === "planner"), false);
  assert.equal(resumedSessions[0]!.role, "developer"); assert.equal(resumedSessions[0]!.payload!.remaining!.corrections, 5);
  assert.equal(resumedSessions[0]!.payload!.task!.id, "core");
  assert.notEqual(resumedSessions[0]!.session, sessions.find!((item) => item.role === "developer")!.session);
});

test("旧版本留下的无代码矛盾计划在中断恢复时受阻，不能跳过计划校验后激活", async (t) => {
  const { controller, architecture, sessions, executor } = await fixture(t);
  const completed = await controller.run(architecture);
  assert.equal(completed.status, "completed");
  Object.assign(architecture.design, { schemaVersion: 3, execution: { language: "none", hosting: "builtin", reason: "现有工具足够" } });
  architecture.contractVersion = 3; architecture.candidateHash = hashValue(architecture.design);
  architecture.review!.candidateHash = architecture.candidateHash;
  const stored = readDevelopmentRunRecord(await controller.store.getRun(completed.id));
  Object.assign(stored, { status: "interrupted", phase: "packaging", delivery: "blocked", architecture: structuredClone(architecture),
    architectureRef: { version: architecture.version, candidateHash: architecture.candidateHash }, package: null });
  Object.assign(stored!.plan!, { schemaVersion: 3, runtime: "node-action" });
  const schema: import("../../src/contracts/application.mjs").ValueSchema = { type: "object", properties: {}, required: [], additionalProperties: false };
  stored!.plan!.application = { protocolVersion: 2, runtime: "node-action", entrypoint: stored!.plan!.entrypoint, page: null,
    actions: [{ id: "legacy_action", title: "旧操作", inputSchema: schema, outputSchema: schema, connectionIds: [] }], stateVersion: 1, evidenceIds: [] };
  for (const item of stored!.plan!.cases) Object.assign(item, { actionId: "legacy_action", input: "{}", mocks: [] });
  stored!.planHash! = hashValue(stored!.plan!);
  await controller.store.save(stored);
  const budgets = structuredClone(stored!.budgets!), sessionCount = sessions.length, probes = executor.calls.probe.length,
    checks = executor.calls.verify.length; let activations = 0;
  const result = await controller.run(architecture, { resume: true, activate: async () => {
    activations++; return { delivery: "ready", summary: "不应发生的激活" };
  } });
  assert.equal(result.status, "blocked"); assert.equal(result.delivery, "blocked");
  assert.equal(result.diagnostic!.reason, "development_not_required");
  assert.equal(activations, 0); assert.equal(sessions.length, sessionCount);
  assert.equal(executor.calls.probe.length, probes); assert.equal(executor.calls.verify.length, checks);
  assert.deepEqual(result.budgets, budgets); assert.deepEqual(result.plan, stored!.plan!);
  assert.equal(await readFile(join(result.snapshot!.path, stored!.plan!.entrypoint), "utf8"),
    await readFile(join(completed.snapshot!.path, completed.plan!.entrypoint), "utf8"));
});

test("恢复时重新检查已有计划的入口，不能用旧检查点绕过当前契约", async (t) => {
  const { controller, architecture, sessions, executor } = await fixture(t);
  const completed = await controller.run(architecture), stored = readDevelopmentRunRecord(await controller.store.getRun(completed.id));
  Object.assign(stored, { status: "interrupted", delivery: "blocked", package: null });
  stored!.plan!.entrypoint = "undeclared.mjs"; stored!.planHash! = hashValue(stored!.plan!);
  await controller.store.save(stored);
  const sessionCount = sessions.length, probes = executor.calls.probe.length; let activations = 0;
  const result = await controller.run(architecture, { resume: true, activate: async () => { activations++; return { delivery: "ready" }; } });
  assert.equal(result.status, "failed"); assert.equal(result.diagnostic!.reason, "invalid_result");
  assert.match(result.summary, /运行入口必须匹配/);
  assert.equal(sessions.length, sessionCount); assert.equal(executor.calls.probe.length, probes); assert.equal(activations, 0);
  assert.equal(result.plan!.entrypoint, "undeclared.mjs", "保留原检查点供核实，不静默改写旧计划");
});

test("缺少已验证隔离环境时阻塞且不调用任何模型", async (t) => {
  const { controller, sessions, architecture } = await fixture(t, { onProbe: () => ({ available: false, kind: "test-fake", reason: "模拟隔离环境不可用" }) });
  const result = await controller.run(architecture);
  assert.equal(result.status, "blocked"); assert.equal(result.delivery, "blocked"); assert.equal(result.package, null);
  assert.match(result.summary, /待准备环境：本机隔离运行检查未通过/); assert.equal(sessions.length, 0);
  assert.equal(result.diagnostic!.stage, "environment"); assert.equal(result.diagnostic!.reason, "模拟隔离环境不可用");
  assert.deepEqual(result.budgets, { corrections: 6, planRevisions: 1, integrationRepairs: 2 });
});

test("普通模型回复不能代替规划、开发或评审的结构化提交", async (t) => {
  for (const omittedRole of ["planner", "developer", "reviewer"]) {
    const { controller, architecture } = await fixture(t, { onPrompt: async ({ record, respond }) => {
      if (record.role !== omittedRole) await respond();
    } });
    const result = await controller.run(architecture);
    assert.equal(result.status, "failed", omittedRole); assert.match(result.summary, /结构化结果/);
    assert.equal(result.package, null); assert.equal(result.delivery, "blocked");
  }
});

test("上游架构变化阻塞旧研发，不能交付旧版本", async (t) => {
  let current = developmentArchitecture();
  const { controller, architecture } = await fixture(t, { getArchitecture: async () => current,
    onVerify: (_options, report) => { current = { ...current, version: 2 }; return report; } });
  const result = await controller.run(architecture);
  assert.equal(result.status, "blocked"); assert.match(result.summary, /架构版本/); assert.equal(result.delivery, "blocked");
  assert.equal(result.package, null);
});

test("运行激活期间架构改变也不能把旧研发结果标为可运行", async (t) => {
  let current = developmentArchitecture();
  const { controller, architecture } = await fixture(t, { getArchitecture: async () => current });
  const result = await controller.run(architecture, { activate: async () => {
    current = { ...current, version: 2 };
    return { delivery: "ready", summary: "模拟运行检查通过" };
  } });
  assert.equal(result.status, "blocked"); assert.equal(result.delivery, "blocked"); assert.match(result.summary, /架构版本/);
});

test("计划评审修订把拒绝版本和具体意见交回同一规划会话", async (t) => {
  let planReviews = 0;
  const { controller, architecture, sessions } = await fixture(t, {
    onPrompt: async ({ record, payload, submit, respond }) => {
      if (record.role === "reviewer" && payload.mode === "plan" && ++planReviews === 1) {
        return submit(developmentReview(payload.subjectHash!, { verdict: "revise", summary: "补充缺失的范围说明", issues: [developmentIssue("plan", "plan_scope")] }));
      }
      if (record.role === "planner" && record.prompts.length === 2) {
        const plan = developmentPlan({ requirements: payload.requirements!, design: payload.design! });
        plan.tasks![1]!.description += "，明确拒绝未授权发送";
        return submit(plan);
      }
      await respond();
    },
  });
  const result = await controller.run(architecture);
  assert.equal(result.status, "completed");
  const planners = sessions.filter((item) => item.role === "planner");
  assert.equal(planners.length, 1); assert.equal(planners[0]!.prompts.length, 2);
  assert.equal(planners[0]!.prompts[1]!.issues!.review.issues[0]!.id, "plan_scope");
  assert.deepEqual(planners[0]!.prompts[1]!.issues!.rejectedPlan, result.planAttempts![0]!.plan);
  assert.equal(result.budgets.planRevisions, 0); assert.equal(result.budgets.corrections, 5);
  assert.notEqual(result.planAttempts![0]!.planHash, result.planAttempts![1]!.planHash);
});

test("测试证据绑定错误代码版本直接失败，不能进入评审或打包", async (t) => {
  const { controller, architecture, sessions } = await fixture(t, { onVerify: (_options, report) => ({ ...report, codeHash: "0".repeat(64) }) });
  const result = await controller.run(architecture);
  assert.equal(result.status, "failed"); assert.match(result.summary, /代码版本不一致/); assert.equal(result.package, null);
  assert.equal(sessions.filter((item) => item.role === "reviewer").length, 1, "只发生计划评审");
});

test("测试未执行或执行异常不能被模型评审放行", async (t) => {
  for (const status of ["not_run", "error"]) {
    const { controller, architecture, sessions } = await fixture(t, { onVerify: (_options, report) => ({ ...report, status, summary: `模拟 ${status}` }) });
    const result = await controller.run(architecture);
    assert.equal(result.status, "blocked"); assert.equal(result.package, null);
    assert.equal(result.reports![0]!.status, status);
    assert.equal(sessions.filter((item) => item.role === "reviewer").length, 1);
  }
});

test("修复预算耗尽保留失败证据，不能自动判定完成或重置预算", async (t) => {
  const { controller, architecture, sessions } = await fixture(t, { limits: { corrections: 1 }, onVerify: (_options, report) => failReport(report) });
  const result = await controller.run(architecture);
  assert.equal(result.status, "failed"); assert.match(result.summary, /预算/); assert.equal(result.package, null);
  assert.equal(result.budgets.corrections, 0); assert.equal(result.tasks![0]!.repairs, 1);
  assert.equal(result.reports.length, 2); assert.ok(result.reports.every((report) => report.status === "failed"));
  assert.equal(sessions.filter((item) => item.role === "developer").length, 1);
  assert.equal(sessions.find!((item) => item.role === "developer")!.prompts.length, 2);
  const resumed = await controller.run(architecture, { resume: true });
  assert.equal(resumed.status, "failed"); assert.equal(resumed.budgets.corrections, 0);
  assert.equal(resumed.tasks![0]!.repairs, 1);
});

test("只有已经绑定独立评审的 workflow/custom 架构可以进入研发", async (t) => {
  const { controller, architecture, sessions } = await fixture(t);
  for (const invalid of [
    { ...architecture, status: "needs_changes" },
    { ...architecture, candidateHash: "0".repeat(64) },
    { ...architecture, contractVersion: 999 },
    { ...architecture, review: { ...architecture.review!, verdict: "revise" } },
    { ...architecture, issues: [developmentIssue("architecture")] },
  ]) await assert.rejects(callFixture(controller.run, controller, [invalid]), InputError);
  assert.equal(sessions.length, 0); assert.equal(await controller.get(architecture.agentId), null);
});

test("恢复边界保留真实研发记录原值，并拒绝损坏的交付清单和验收绑定", async (t) => {
  const { controller, architecture } = await fixture(t);
  const record = await controller.run(architecture);
  assert.equal(record.status, "completed");
  const original = structuredClone(record);
  assert.equal(readDevelopmentRunRecord(record), record);
  assert.deepEqual(record, original);

  const damagedPackage = structuredClone(record);
  Reflect.set(damagedPackage.package!, "application", {});
  assert.throws(() => readDevelopmentRunRecord(damagedPackage), InputError);
  assert.deepEqual(record, original);

  const damagedLedger = structuredClone(record);
  damagedLedger.acceptanceLedger = createAcceptanceLedger({ architecture, plan: record.plan!, codeHash: record.package!.codeHash });
  assert.ok(damagedLedger.acceptanceLedger.items.length);
  assert.equal(readDevelopmentRunRecord(damagedLedger), damagedLedger);
  Reflect.set(damagedLedger.acceptanceLedger!.items[0]!, "evidence", { kind: "independent-review", bindingHash: 42 });
  assert.throws(() => readDevelopmentRunRecord(damagedLedger), /研发检查点字段已损坏/);

  const damagedReport = { ...structuredClone(record), feedback: { report: { status: "passed", results: [] } } };
  assert.throws(() => readDevelopmentRunRecord(damagedReport), /研发检查点字段已损坏/);
  assert.deepEqual(await controller.store.getRun(record.id), original);
});
