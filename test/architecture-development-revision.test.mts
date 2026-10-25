import type { StoredArchitectureRecord } from "../src/architecture/architecture-controller-port.mjs";
import type { ArchitectureDesigner } from "../src/architecture/architecture.mjs";
import { callFixture } from "./helpers/m7-test-boundaries.mjs";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import type { PiSessionOptions } from "../src/runtime/pi-port.mjs";
import type { SessionMessage } from "../src/runtime/pi-port.mjs";
import { fixtureTools } from "./helpers/m7-test-boundaries.mjs";
import { toolText } from "./helpers/m7-test-boundaries.mjs";
import type { TestFailure } from "./helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrototypeAgents } from "../src/agents/agent-prototype.mjs";
import { designHash } from "../src/architecture/architecture-contract.mjs";
import { latestDevelopmentFailure, developmentRevisionReference, DEVELOPMENT_REVISION_MAX_BYTES } from "../src/architecture/architecture-development-revision.mjs";
import { hashValue } from "../src/development/development-contract.mjs";
import { validDraft, validDesign, passingReview } from "./helpers/architecture.mjs";
import { fidelityChecker } from "./helpers/fidelity.mjs";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { developmentSessionBinding } from "../src/development/development-sessions.mjs";
import type { RequirementItem } from "../src/contracts/architecture.mjs";

function candidate(requirements: readonly RequirementItem[], code = true) {
  return validDesign(requirements, { schemaVersion: 3, profile: code ? "custom" : "light", connections: [],
    interaction: { defaultEntry: "conversation", page: false, operations: code, inputs: "本轮记录", results: "完整结果", persistentData: "无" },
    execution: { language: code ? "javascript" : "none", hosting: "builtin", reason: code ? "专用规则需要代码" : "现有文本工具足够" },
    selectionBasis: { capacity: "按全部输入约束的交集核对", process: "逐项处理", quality: "保留所有已确认边界",
      requirementIds: requirements.map((item) => item.id), assumptions: [] } });
}

async function fixture(t: test.TestContext, { development }: { development?: unknown } = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-development-revision-")), prompts: ({ "payload": (unknown); "tools": (Record<string, import("./helpers/m7-test-boundaries.mjs").FixtureTool>); "isDesign": (boolean); })[] = [];
  const state = { code: true, reject: false, interruptDesign: false, patch: false };
  const agentOptions: Omit<ConstructorParameters<typeof PrototypeAgents>[0], "development"> = { config: { llmConfigured: true }, cwd: root, dataDir: join(root, "data"),
    fidelitySessionFactory: fidelityChecker(), sessionFactory: async (options) => {
      const tools = fixtureTools(options.customTools!), isDesign = Boolean(tools.submit_architecture);
      return { messages: [] as SessionMessage[], subscribe: () => () => {}, async abort() {}, dispose() {}, async prompt(text) {
        const payload = JSON.parse(String(text)); prompts.push({ payload, tools, isDesign });
        if (isDesign) {
          if (state.interruptDesign) throw new Error("fetch failed: offline controlled interruption");
          if (state.patch && payload.editableSubmission) return tools.revise_architecture_submission!.execute("local-design", {
            submissionHash: payload.editableSubmission.submissionHash,
            updates: [{ path: "/instructions", value: payload.previousDesign.instructions + " 本轮重新核对边界。" }],
          });
          const design = payload.previousDesign ? structuredClone(payload.previousDesign) : candidate(payload.requirements, state.code);
          if (payload.previousDesign) design.instructions += " 本轮重新核对边界。";
          return tools.submit_architecture!.execute("design", design);
        }
        const review = passingReview(payload.candidateHash, payload.design, payload.priorFindings);
        if (state.reject) {
          review.verdict = "revise"; review.checks!.find((item) => item.id === "verification")!.passed = false;
          review.issues = [{ id: "current_boundary", blocking: true, description: "本轮边界仍需修正", remedy: "按原需求核对本轮边界",
            checkId: "verification", kind: "design", candidatePaths: ["/instructions"],
            references: [{ source: "candidate", path: "/instructions", quote: payload.design.instructions }], factClaims: [] }];
          for (const decision of review.priorFindingDecisions ?? []) decision.status = "unresolved";
        }
        for (const finding of payload.priorFindings?.findings ?? []) {
          if (finding.kind !== "historical-planning-diagnostic") continue;
          const decision = review.priorFindingDecisions!.find((entry) => entry.findingId === finding.findingId);
          const path = finding.currentAcceptance.path ?? "/acceptance/0";
          const criterion = payload.design.acceptance[Number(path.split("/")[2])], adapterId = criterion.verification.adapterId;
          decision!.status! = state.reject ? "unresolved" : "unsupported"; decision!.checkIds! = ["verification"]; decision!.candidatePaths! = [path];
          decision!.reason! = state.reject ? "合成原生诊断本轮仍待核对，保留现有验证阻断。" : finding.currentAcceptance.path
            ? "合成旧拒绝用例错误选取输入拒绝；当前本条使用动作结果验收，旧负例应纠错且不继承通过。" : "合成旧用例引用不在当前候选的验收编号；保留历史，以本次实际验收及适配器核对，不冒称已修复。";
          if (!state.reject) review.issues.push({ id: finding.findingId, blocking: false, kind: "design", checkId: "verification",
            description: decision!.reason!, remedy: "未接受的旧合成用例需按当前真实验收重新规划；本测试只验证只读参考续接。",
            candidatePaths: [path], references: [{ source: "candidate", path: `${path}/expected`, quote: criterion.expected },
              { source: "acceptanceAdapterGuide", path: `/adapters/${adapterId}/executionRule`,
                quote: payload.acceptanceAdapterGuide.adapters[adapterId].executionRule }], factClaims: [] });
        }
        return tools.submit_architecture_review!.execute("review", review);
      } };
    } };
  if (development) Reflect.set(agentOptions, "development", development);
  const agents = new PrototypeAgents(agentOptions);
  t.after(async () => { await agents.close(); await rm(root, { recursive: true, force: true }); });
  const definition = { id: "revision", name: "固定修订助手", draft: validDraft(), fingerprint: "fixed-requirements" };
  return { agents, designer: agents.architecture as ArchitectureDesigner, prompts, state, definition };
}

async function failedRun(f: Awaited<ReturnType<typeof fixture>>, architecture: StoredArchitectureRecord, overrides = {}) {
  const plan = { schemaVersion: 2, summary: "历史待修计划", runtime: "node-action", entrypoint: "main.mjs", tasks: [{ id: "compute", files: ["main.mjs"] }],
    cases: [{ id: "maximum", acceptanceId: "valid", actionId: "compute", mocks: [], input: { fixture: { op: "value", value: { records: [1, 2] } } },
      assertions: [{ path: "total", expectedJson: "3" }] }] };
  const planHash = hashValue(plan);
  return f.agents.development.store.create({ id: "dev_reference", agentId: architecture.agentId, name: architecture.name, version: 1,
    architectureRef: { version: architecture.version, candidateHash: architecture.candidateHash }, architecture: structuredClone(architecture),
    status: "blocked", delivery: "blocked", phase: "planning", summary: "历史方案中边界组合需要核对",
    pendingPlan: { plan, planHash }, plan: null, planHash: null, planAttempts: [{ plan, planHash, review: { verdict: "blocked" } }],
    reviews: [{ mode: "plan", planHash, verdict: "blocked", summary: "约束交集不可达", issues: [] }], reports: [], deliveries: [], tasks: [],
    diagnostic: { stage: "development", phase: "planning", reason: "contract_rejected" }, feedback: { reason: "核对实际约束交集", rejectedPlan: plan },
    planDraftChecks: [{ total: 1, issues: [{ path: "plan.cases.0", reason: "fixture_bound", measuredBytes: 1234 }] }],
    sessions: { planner: { turns: 9 } }, budgets: { corrections: 0 }, package: null, ...overrides });
}

test("同版通过架构只读复用失败研发参考，新版本仍有独立评审且不改历史或预算", async (t) => {
  const f = await fixture(t), prior = await f.designer.design(f.definition), run = await failedRun(f, prior);
  const oldArchitecture = designHash(await f.designer.getVersion(prior.agentId, prior.version));
  const oldRun = hashValue(await f.agents.development.store.getRun(run.id));
  f.state.patch = true;
  const revised = await f.designer.design(f.definition, { developmentFailure: run });
  const prompt = f.prompts.filter((item) => item.isDesign).at(-1);
  assert.equal(revised.status, "passed"); assert.equal(revised.version, prior.version + 1);
  assert.deepEqual(objectFields(prompt!.payload).previousDesign, prior.design);
  assert.equal(objectFields(objectFields(prompt!.payload).editableSubmission).baseCandidateHash, prior.candidateHash);
  assert.equal(objectFields(objectFields(prompt!.payload).editableSubmission).trust, "untrusted-reference");
  assert.equal(objectFields(prompt!.payload).rejectedSubmission, undefined);
  assert.deepEqual(revised.design, { ...prior.design!, instructions: prior.design!.instructions + " 本轮重新核对边界。" });
  assert.equal(revised.revisionSource!.kind, "development-failure");
  assert.equal(objectFields(revised.developmentRevision).trust, "untrusted-reference");
  assert.deepEqual(objectFields(revised.developmentRevision).plan, run.pendingPlan.plan);
  assert.equal(objectFields(revised.developmentRevision).planHash, run.pendingPlan.planHash);
  assert.equal(objectFields(objectFields(revised.developmentRevision).caseFacts).planHash, run.pendingPlan.planHash);
  assert.equal(objectFields(objectFields(revised.developmentRevision).caseFacts).hostCallsExecuted, false);
  assert.equal(objectFields(objectFields(objectFields(objectFields(objectFields(objectFields(objectFields(objectFields(prompt!.payload).developmentRevision).caseFactsSummary).largestInputs)[0]).arrayLengths).entries)[0]).length, 2);
  assert.equal(objectFields(revised.developmentRevision).sessions, undefined); assert.equal(objectFields(revised.developmentRevision).budgets, undefined);
  assert.equal(objectFields(objectFields(revised.developmentRevision).feedback).rejectedPlan, undefined);
  const read = prompt!.tools.read_architecture_development_reference;
  const page = JSON.parse(String(toolText((await read!.execute("read", { section: "plan", limit: 8000 })))));
  assert.deepEqual(JSON.parse(String(page.text)), run.pendingPlan.plan);
  await assert.rejects(read!.execute("read", { section: "sessions" }), /不存在这个顶层字段/);
  assert.equal(f.prompts.filter((item) => !item.isDesign).length, 2);
  assert.equal(revised.attempts.length, 1); assert.equal(objectFields(revised.attempts![0]!.review).verdict, "pass");
  assert.equal(designHash(await f.designer.getVersion(prior.agentId, prior.version)), oldArchitecture);
  assert.equal(hashValue(await f.agents.development.store.getRun(run.id)), oldRun);
  assert.equal((await f.designer.getVersion(prior.agentId, prior.version))!.status!, "passed");
});

test("研发参考不能穿越身份、需求、平台、确认依据、后续义务或运行能力绑定", async (t) => {
  const changes = [
    (run: { agentId: string; }) => { run.agentId = "other"; },
    (run: { architectureRef: { version: number; }; }) => { run.architectureRef.version++; },
    (run: { architecture: { sourceFingerprint: string; }; }) => { run.architecture.sourceFingerprint += "-changed"; },
    (run: { architecture: { draft: { goal: { value: string; }; }; }; }) => { run.architecture.draft.goal.value += " changed"; },
    (run: { architecture: { requirements: { text: string; }[]; }; }) => { run.architecture!.requirements[0]!.text += " changed"; },
    (run: { architecture: { platformHash: string; }; }) => { run.architecture.platformHash = "0".repeat(64); },
    (run: { architecture: { confirmedRequirementContext: { changed: boolean; }; }; }) => { run.architecture.confirmedRequirementContext = { changed: true }; },
    (run: { architecture: { deferredVerifications: { changed: boolean; }; }; }) => { run.architecture.deferredVerifications = { changed: true }; },
    (run: { architecture: { runtimeCapabilities: { hash: string; }; }; }) => { run.architecture.runtimeCapabilities.hash = "0".repeat(64); },
    (run: { architecture: { runtimeCapabilities: unknown; }; }) => { Reflect.deleteProperty(run.architecture, "runtimeCapabilities"); },
    (run: { architecture: { design: { instructions: string; }; }; }) => { run.architecture.design.instructions += " changed"; },
  ];
  for (const change of changes) {
    const f = await fixture(t), prior = await f.designer.design(f.definition), run = await failedRun(f, prior); callFixture(change, undefined, [run]);
    const directory = f.designer.storage.directory.bind(f.designer.storage); let nativeReads = 0;
    f.designer.storage.directory = (...args) => {
      if (args[1]?.startsWith("development/sessions/")) nativeReads++;
      return directory(...args);
    };
    const next = await f.designer.design(f.definition, { developmentFailure: run });
    assert.equal(objectFields(f.prompts.filter((item) => item.isDesign).at(-1)!.payload).previousDesign, null);
    assert.equal(objectFields(f.prompts.filter((item) => item.isDesign).at(-1)!.payload).editableSubmission, undefined);
    assert.equal(next.developmentRevision, undefined);
    assert.equal(nativeReads, 0, "源绑定未通过时不能读取原生会话");
  }
});

test("仅最新同版失败且未交付记录可进入参考，不穿过取消、已交付或活动版本", async () => {
  const architecture = { agentId: "agent", status: "passed", delivery: "needs_development", version: 2, candidateHash: "candidate" };
  const run = { id: "old", agentId: "agent", status: "failed", delivery: "blocked", architectureRef: { version: 2, candidateHash: "candidate" },
    deliveries: [], createdAt: "2026-01-01T00:00:00.000Z" };
  assert.equal(latestDevelopmentFailure!([run], architecture)!.id, "old");
  const later = { ...run, id: "new", status: "cancelled", createdAt: "2026-01-02T00:00:00.000Z" };
  assert.equal(latestDevelopmentFailure([run, later], architecture), null);
  assert.equal(latestDevelopmentFailure([{ ...run, deliveries: [{ status: "defective" }] }], architecture), null);
  assert.equal(latestDevelopmentFailure([run], { ...architecture, delivery: "ready" }), null);
  assert.equal(latestDevelopmentFailure([run], architecture, { architectureRef: run.architectureRef }), null);
});

test("通过状态仍须重核完整候选和历史评审证据，损坏快照不作为修订来源", async (t) => {
  const f = await fixture(t), prior = await f.designer.design(f.definition), run = await failedRun(f, prior);
  const before = designHash(await f.designer.getVersion(prior.agentId, prior.version));
  const changed = structuredClone(prior); objectFields(changed.reviewEvidence!.snapshot).hash = "0".repeat(64);
  const actualGet = f.designer.get.bind(f.designer); f.designer.get = async () => structuredClone(changed);
  const next = await f.designer.design(f.definition, { developmentFailure: run }); f.designer.get = actualGet;
  assert.equal(objectFields(f.prompts.filter((item) => item.isDesign).at(-1)!.payload).previousDesign, null);
  assert.equal(next.developmentRevision, undefined);
  assert.equal(designHash(await f.designer.getVersion(prior.agentId, prior.version)), before);
});

test("完整计划摘要不匹配或投影超过512KiB时明确不可用，不保留半份计划", async (t) => {
  const f = await fixture(t), prior = await f.designer.design(f.definition), run = await failedRun(f, prior);
  const mismatched = structuredClone(run); mismatched.pendingPlan.planHash = "0".repeat(64);
  const invalid = developmentRevisionReference(mismatched, prior);
  assert.equal(invalid.status, "unavailable"); assert.equal(invalid.reason, "historical_plan_hash_mismatch"); assert.equal(invalid.plan, undefined);
  const large = structuredClone(run); large.pendingPlan.plan.summary = "x".repeat(DEVELOPMENT_REVISION_MAX_BYTES);
  large.pendingPlan.planHash = hashValue(large.pendingPlan.plan);
  const oversized = developmentRevisionReference(large, prior);
  assert.equal(oversized.status, "unavailable"); assert.equal(oversized.reason, "historical_reference_too_large"); assert.equal(oversized.plan, undefined);
  const limited = structuredClone(run); limited.reviews = Array.from({ length: 8 }, () => run.reviews[0]!);
  const projected = developmentRevisionReference(limited, prior);
  assert.equal(projected.reviews!.length, 4); assert.equal(projected.omitted!.reviews, 4);
  assert.equal(Buffer.byteLength(JSON.stringify(projected)), projected.bytes); assert.ok(projected.bytes! <= DEVELOPMENT_REVISION_MAX_BYTES);
});

test("正常build从可信store选定唯一记录，重查失败仍保留旧活动定义", async (t) => {
  const f = await fixture(t), input = { id: f.definition.id, name: f.definition.name, draft: f.definition.draft };
  f.state.code = false;
  const active = await f.agents.build(input);
  const activeVisible = await f.agents.get(input.id);
  f.state.code = true;
  Reflect.set(f.agents, "executeDevelopment", async (architecture: StoredArchitectureRecord) => failedRun(f, architecture));
  const changed = { ...input, draft: validDraft("逐条执行专用规则") };
  const failed = await f.agents.build(changed);
  assert.equal(failed.architecture!.status, "passed"); assert.equal(failed.development!.status, "blocked");
  const run = await f.agents.development.store.getRun(failed.development!.id), before = hashValue(run);
  f.state.reject = true;
  const result = await f.agents.build(changed);
  assert.equal(result.architecture!.status, "needs_changes");
  assert.equal(objectFields(objectFields(result.architecture!.developmentRevision).source).runId, run!.id!);
  assert.deepEqual(result.agent, active.agent); assert.deepEqual(await f.agents.get(input.id), activeVisible);
  assert.equal(hashValue(await f.agents.development.store.getRun(run!.id!)), before);
});

async function interruptedBuild(t: test.TestContext) {
  const f = await fixture(t), input = { id: f.definition.id, name: f.definition.name, draft: f.definition.draft };
  Reflect.set(f.agents, "executeDevelopment", async (architecture: StoredArchitectureRecord) => failedRun(f, architecture));
  const first = await f.agents.build(input), run = await f.agents.development.store.getRun(first.development!.id);
  f.state.interruptDesign = true;
  await assert.rejects(f.agents.build(input), (error: TestFailure) => error.diagnostic!.reason === "api_connection");
  const interrupted = await f.designer.get(input.id);
  assert.equal(interrupted!.status!, "failed"); assert.equal(interrupted!.design!, null); assert.deepEqual(interrupted!.attempts!, []);
  f.state.interruptDesign = false;
  Reflect.set(f.agents, "executeDevelopment", async () => run!);
  return { ...f, input, run, first, interrupted };
}

test("提交前技术中断后正常build只按精确来源续接，原记录与预算不变", async (t) => {
  const f = await interruptedBuild(t), store = f.agents.development.store;
  const oldRun = hashValue(f.run), oldArchitecture = designHash(await f.designer.getVersion(f.input.id, f.first!.architecture!.version));
  const readIds: ((string))[] = [], getRun = store.getRun.bind(store), list = store.list.bind(store);
  store.getRun = async (id) => { readIds.push(id); return getRun(id); };
  store.list = async () => { throw new Error("source continuation must not scan historical runs"); };
  const result = await f.agents.build(f.input); store.list = list; store.getRun = getRun;
  const prompt = f.prompts.filter((item) => item.isDesign).at(-1)!.payload;
  assert.deepEqual(readIds, [f.run!.id]);
  assert.equal(result.architecture!.status, "passed"); assert.equal(result.architecture!.version, f.interrupted!.version + 1);
  assert.deepEqual(objectFields(prompt).previousDesign, f.first!.architecture!.design);
  assert.equal(result.architecture!.revisionSource!.interruptedVersion, f.interrupted!.version);
  assert.deepEqual(objectFields(result.architecture!.developmentRevision).source, objectFields(f.interrupted!.developmentRevision).source);
  assert.equal(hashValue(await getRun(f.run!.id)), oldRun);
  assert.equal(designHash(await f.designer.getVersion(f.input.id, f.first!.architecture!.version)), oldArchitecture);
});

test("中断指针损坏不继承，宿主明确核验失败则在模型前停止", async (t) => {
  for (const kind of ["source-hash", "source-id", "run-changed", "active"]) {
    const f = await interruptedBuild(t), store = f.agents.development.store;
    const promptsBefore = f.prompts.length;
    if (kind === "source-hash" || kind === "source-id") {
      const changed = structuredClone(f.interrupted);
      if (kind === "source-hash") objectFields(objectFields(changed!.developmentRevision!).source).recordHash = "0".repeat(64);
      else objectFields(objectFields(changed!.developmentRevision!).source).runId = "dev_other";
      await f.designer.save(changed!);
      const getRun = store.getRun.bind(store); store.getRun = async () => { throw new Error("tampered source must not be read"); };
      await f.agents.build(f.input); store.getRun = getRun;
    } else if (kind === "run-changed") {
      await store.save({ ...f.run!, summary: "source changed after interruption" });
    } else {
      callFixture(f.agents.agents.set, f.agents.agents, [f.input.id, Object.assign({ id: f.input.id }, f.input, { architectureRef: f.run!.architectureRef, revision: 1 })]);
      f.agents.getActiveRuntime = async () => null;
    }
    if (kind === "run-changed" || kind === "active") {
      await assert.rejects(f.agents.build(f.input), (error: TestFailure) => error.validationIssue?.reason === "feedback_repair_source_invalid", kind);
      assert.equal(f.prompts.length, promptsBefore, kind);
      assert.equal((await f.designer.get(f.input.id))!.version!, f.interrupted!.version, kind);
      continue;
    }
    const prompt = f.prompts.filter((item) => item.isDesign).at(-1)!.payload;
    assert.equal(objectFields(prompt).previousDesign, null, kind); assert.equal(objectFields(prompt).developmentRevision, undefined, kind);
  }
});

test("注入的旧development没有可选store接口时仍按原流程正常build", async (t) => {
  const development = { async close() {}, async get() { return null; }, async run(architecture: { agentId: unknown; name: unknown; version: unknown; candidateHash: unknown; }) {
    return { id: "stub_run", agentId: architecture.agentId, name: architecture.name, version: 1,
      architectureRef: { version: architecture.version, candidateHash: architecture.candidateHash },
      status: "blocked", delivery: "blocked", phase: "planning", summary: "注入实现保留原行为", tasks: [], reports: [], budgets: {} };
  } };
  const f = await fixture(t, { development }), input = { id: f.definition.id, name: f.definition.name, draft: f.definition.draft };
  await f.agents.build(input);
  const second = await f.agents.build(input);
  assert.equal(second.architecture!.status, "passed"); assert.equal(second.architecture!.version, 2);
  assert.equal(objectFields(f.prompts.filter((item) => item.isDesign).at(-1)!.payload).previousDesign, null);
  assert.equal(second.architecture!.developmentRevision, undefined);
});

async function nativePlanningFailure(f: Awaited<ReturnType<typeof fixture>>, architecture: StoredArchitectureRecord) {
  let run = await failedRun(f, architecture, { sessions: {} });
  const binding = developmentSessionBinding(run, "planner", { previousPlanHash: null }), bindingHash = hashValue(binding);
  const storage = f.designer.storage;
  const directory = await storage.directory(run.agentId, `development/sessions/${run.id}/${bindingHash}`, { create: true });
  const cwd = await storage.directory(run.agentId, `development/workspaces/${run.id}/code`, { create: true });
  const file = join(directory, "native.jsonl"), timestamp = new Date().toISOString();
  const proposedCaseRef = { id: "boundary", acceptanceId: "boundary", taskId: "compute", actionId: "compute",
    kind: "input-rejection", inputTarget: "task-envelope" };
  const issue = { path: "planningFiles.cases[0].assertions", reason: "adapter_contract_mismatch",
    remedy: "核对当前公开适配器输出范围，不要求未执行的业务输出。", source: { path: "cases/core.json", localIndex: 0, caseId: "boundary" } };
  const entries = [
    { type: "session", version: CURRENT_SESSION_VERSION, id: "native", timestamp, cwd },
    { type: "custom", id: "binding", parentId: null, timestamp, customType: "neuma.session-binding.v1", data: { version: 1, bindingHash } },
    { type: "message", id: "call", parentId: "binding", timestamp, message: { role: "assistant", content: [
      { type: "toolCall", id: "save-cases", name: "save_plan_cases", arguments: { path: "cases/core.json",
        cases: [{ ...proposedCaseRef, input: "private fixture arguments" }] } },
    ] } },
    { type: "message", id: "result", parentId: "call", timestamp, message: { role: "toolResult", toolCallId: "save-cases",
      toolName: "save_plan_cases", isError: true, content: [{ type: "text", text: "草稿用例尚不符合已保存骨架，原文件未修改："
        + JSON.stringify({ saved: false, issues: [issue] }) }] } },
  ];
  await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  objectFields(run.sessions)[bindingHash] = { bindingHash, role: "planner", turns: 2, file: "native.jsonl" };
  run = await f.agents.development.store.save(run);
  return { run, file, issue: { ...issue, proposedCaseRef } };
}

test("同绑定原生公开规划工具失败进入架构首包和精确分页，不继承会话或预算", async (t) => {
  const f = await fixture(t), prior = await f.designer.design(f.definition), native = await nativePlanningFailure(f, prior);
  const before = hashValue(native.run), sessionBefore = await readFile(native.file, "utf8");
  const revised = await f.designer.design(f.definition, { developmentFailure: native.run });
  const prompt = f.prompts.filter((item) => item.isDesign).at(-1), reference = objectFields(revised.developmentRevision).planningToolFailures;
  assert.equal(objectFields(reference).status, "available"); assert.equal(objectFields(reference).trust, "untrusted-reference"); assert.equal(objectFields(reference).current, false);
  assert.deepEqual(objectFields(objectFields(objectFields(reference).failures)[0]).issues, [native.issue]);
  assert.equal(objectFields(objectFields(reference).source).recordHash, before);
  assert.equal(objectFields(objectFields(objectFields(prompt!.payload).developmentRevision).planningToolFailuresSummary).status, "available");
  assert.match(JSON.stringify(objectFields(objectFields(prompt!.payload).developmentRevision).planningToolFailuresSummary), /adapter_contract_mismatch/);
  const page = JSON.parse(String(toolText((await prompt!.tools.read_architecture_development_reference!.execute("tool-failures", {
    section: "planningToolFailures", limit: 8000 })))));
  assert.deepEqual(JSON.parse(String(page.text)), reference);
  assert.equal(JSON.stringify(reference).includes("private fixture arguments"), false);
  assert.equal(objectFields(revised.developmentRevision).sessions, undefined); assert.equal(objectFields(revised.developmentRevision).budgets, undefined);
  assert.equal(hashValue(await f.agents.development.store.getRun(native.run.id)), before);
  assert.equal(await readFile(native.file, "utf8"), sessionBefore);
});

test("已保存的架构续接不静默更换历史原生会话，文件改变则参考明确不可用", async (t) => {
  const f = await fixture(t), prior = await f.designer.design(f.definition), native = await nativePlanningFailure(f, prior);
  f.state.interruptDesign = true;
  await assert.rejects(f.designer.design(f.definition, { developmentFailure: native.run }), (error: TestFailure) => error.diagnostic!.reason === "api_connection");
  const interrupted = await f.designer.get(f.definition.id);
  assert.equal(objectFields(objectFields(interrupted!.developmentRevision!).planningToolFailures).status, "available");
  const raw = await readFile(native.file, "utf8");
  await writeFile(native.file, raw + JSON.stringify({ type: "message", id: "later", parentId: "result", timestamp: new Date().toISOString(),
    message: { role: "user", content: "later fixture branch entry" } }) + "\n");
  f.state.interruptDesign = false;
  const resumed = await f.designer.design(f.definition, { developmentFailure: native.run });
  assert.equal(objectFields(objectFields(resumed.developmentRevision).planningToolFailures).status, "unavailable");
  assert.equal(objectFields(objectFields(resumed.developmentRevision).planningToolFailures).reason, "session_changed");
  assert.deepEqual(objectFields(resumed.developmentRevision).source, objectFields(interrupted!.developmentRevision!).source);
  assert.equal(hashValue(await f.agents.development.store.getRun(native.run.id)), hashValue(native.run));
});
