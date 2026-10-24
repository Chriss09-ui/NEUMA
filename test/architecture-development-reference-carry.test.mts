import { callFixture } from "./helpers/m7-test-boundaries.mjs";
import { fixtureText } from "./helpers/m7-test-boundaries.mjs";
import { recordArray } from "./helpers/m7-test-boundaries.mjs";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import type { SessionMessage } from "../src/runtime/pi-port.mjs";
import { fixtureTools } from "./helpers/m7-test-boundaries.mjs";
import type { PiSessionOptions } from "../src/runtime/pi-port.mjs";
import type { TestFailure } from "./helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { PrototypeAgents } from "../src/agents/agent-prototype.mjs";
import { ArchitectureDesigner } from "../src/architecture/architecture.mjs";
import { ARCHITECTURE_VERSION } from "../src/architecture/architecture-contract.mjs";
import { hashValue } from "../src/development/development-contract.mjs";
import { developmentSessionBinding } from "../src/development/development-sessions.mjs";
import { validDraft, validDesign, passingReview } from "./helpers/architecture.mjs";
import { fidelityChecker } from "./helpers/fidelity.mjs";
import type { StoredArchitectureRecord } from "../src/architecture/architecture-controller-port.mjs";

const envelopeId = "r_envelope_measure", envelopeAcceptance = "acc_task_framing_capacity_envelope_measure";
const envelopeRemedy = "当前正式任务信封序列化为448字节，上限131072字节，尚未超过大小限制；该目标只检查正式任务信封，不执行业务校验。";

async function nativeFailure(agents: PrototypeAgents, architecture: StoredArchitectureRecord|null) {
  let run = await agents.development.store.create({ id: "historical_run", agentId: architecture!.agentId!, version: 1,
    architectureRef: { version: architecture!.version!, candidateHash: architecture!.candidateHash! }, architecture: structuredClone(architecture),
    status: "failed", delivery: "blocked", phase: "planning", summary: "原子工具拒绝后尚未提交计划", plan: null, planHash: null,
    tasks: [], deliveries: [], reviews: [], reports: [], sessions: {} as Record<string, import("../src/development/development-sessions.mjs").DevelopmentSessionReference>, budgets: { corrections: 0 }, package: null,
    feedback: { reason: "plan_unsubmitted" } });
  const binding = developmentSessionBinding(run, "planner", { previousPlanHash: null }), bindingHash = hashValue(binding);
  const directory = await agents.storage.directory(run.agentId, `development/sessions/${run.id}/${bindingHash}`, { create: true });
  const cwd = await agents.storage.directory(run.agentId, `development/workspaces/${run.id}/code`, { create: true });
  const cases = Array.from({ length: 5 }, (_, index) => ({ id: index === 3 ? envelopeId : `case_${index}`,
    acceptanceId: index === 3 ? envelopeAcceptance : `acceptance_${index}`, taskId: "compute", actionId: "compute",
    kind: "input-rejection", inputTarget: "task-envelope", input: "SYNTHETIC_CASE_BODY_NOT_IN_REFERENCE" }));
  const issues = cases.map((item, index) => ({ path: `planningFiles.cases[${index}].kind`, reason: "input_rejection_not_rejected",
    source: { path: "cases/input.json", localIndex: index, caseId: item.id }, remedy: index === 3 ? envelopeRemedy : `其他公开诊断${index}` }));
  const timestamp = new Date().toISOString(), entries = [
    { type: "session", version: CURRENT_SESSION_VERSION, id: "native", timestamp, cwd },
    { type: "custom", id: "binding", parentId: null, timestamp, customType: "neuma.session-binding.v1", data: { version: 1, bindingHash } },
    { type: "message", id: "call", parentId: "binding", timestamp, message: { role: "assistant", content: [
      { type: "toolCall", id: "save-cases", name: "save_plan_cases", arguments: { path: "cases/input.json", cases } }] } },
    { type: "message", id: "failure", parentId: "call", timestamp, message: { role: "toolResult", toolCallId: "save-cases", toolName: "save_plan_cases",
      isError: true, content: [{ type: "text", text: "草稿用例尚不符合已保存骨架，原文件未修改：" + JSON.stringify({ saved: false, issues }) }] } },
  ];
  const file = join(directory, "native.jsonl");
  await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  run.sessions[bindingHash] = { bindingHash, role: "planner", turns: 2, file: "native.jsonl" };
  return { run: await agents.development.store.save(run), file };
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "neuma-reference-carry-")), prompts: ({ "designer": (boolean); "payload": (unknown); "systemPrompt": (string | undefined); })[] = [], state = { reject: false, interrupt: false,
    interruptReview: false, draftSuffix: "" };
  const config = { llmConfigured: true }, dataDir = join(root, "data"), fidelitySessionFactory = fidelityChecker();
  const sessionFactory = async (options: PiSessionOptions) => {
    const tools = fixtureTools(options.customTools), designer = Boolean(tools.submit_architecture);
    return { messages: [] as SessionMessage[], subscribe: () => () => {}, dispose() {}, async abort() {}, async prompt(text: string) {
      const payload = JSON.parse(String(text)); prompts.push({ designer, payload, systemPrompt: options.systemPrompt });
      if (designer) {
        if (state.interrupt) throw new Error("fetch failed: synthetic controlled interruption");
        const candidate = payload.previousDesign ? structuredClone(payload.previousDesign) : validDesign(payload.requirements, {
          schemaVersion: 3, profile: "custom", connections: [], interaction: { defaultEntry: "conversation", page: false,
            operations: true, inputs: "原始输入", results: "全部结果", persistentData: "无" },
          execution: { language: "javascript", hosting: "builtin", reason: "专用规则需要代码" },
          selectionBasis: { capacity: "保留原始边界", process: "逐项核对", quality: "精确输出",
            requirementIds: payload.requirements.map((item: { id: unknown; }) => item.id), assumptions: [] } });
        candidate.instructions += state.draftSuffix;
        return tools.submit_architecture!.execute("design", candidate);
      }
      if (state.interruptReview) throw new Error("fetch failed: synthetic controlled review interruption");
      const review = passingReview(payload.candidateHash, payload.design, payload.priorFindings);
      if (state.reject) {
        review.verdict = "revise"; review.checks!.find((item) => item.id === "verification")!.passed = false;
        review.issues = [{ id: "keep_boundary", blocking: true, description: "需核对原边界", remedy: "保留原需求后修正验收",
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
  };
  const agents = new PrototypeAgents({ config, cwd: root, dataDir, sessionFactory, fidelitySessionFactory });
  t.after(async () => { await agents.close(); await rm(root, { recursive: true, force: true }); });
  let native: Awaited<ReturnType<typeof nativeFailure>> | undefined;
  Reflect.set(agents, "executeDevelopment", async (architecture: Parameters<PrototypeAgents["executeDevelopment"]>[0]) => (native ??= await nativeFailure(agents, architecture)).run);
  const input = { id: "carry_agent", name: "只读参考续接", draft: validDraft() };
  const initial = await agents.build(input);
  return { root, config, dataDir, sessionFactory, fidelitySessionFactory, agents, state, prompts, input, initial, native };
}

function assertEnvelopePrompt(prompt: unknown) {
  const summary = objectFields(objectFields(prompt).developmentRevision).planningToolFailuresSummary;
  assert.equal(objectFields(summary).status, "available"); assert.equal(objectFields(summary).current, false); assert.equal(objectFields(summary).trust, "untrusted-reference");
  assert.equal(objectFields(summary).total, 5); assert.equal(objectFields(summary).retained, 5); assert.equal(objectFields(summary).omitted, 0);
  const row = recordArray(objectFields(summary).issues).find((issue) => objectFields(issue.source)?.caseId === envelopeId);
  assert.equal(objectFields(row!.proposedCaseRef).acceptanceId, envelopeAcceptance);
  assert.match(fixtureText(row!.remedy), /448字节/u); assert.match(fixtureText(row!.remedy), /131072字节/u);
  assert.equal(row!.toolCallId, "save-cases"); assert.equal(row!.entryId, "failure");
  assert.doesNotMatch(JSON.stringify(summary), /SYNTHETIC_CASE_BODY_NOT_IN_REFERENCE/u);
}

test("正常needs_changes后再次build沿唯一来源保留五项公开诊断，实际首轮prompt保留第4项验收反证", async (t) => {
  const f = await fixture(t), store = f.agents.development.store, before = hashValue(f.native!.run), raw = await readFile(f.native!.file);
  f.state.reject = true;
  const rejected = await f.agents.build(f.input); assert.equal(rejected.architecture!.status, "needs_changes");
  f.state.reject = false;
  const start = f.prompts.length, reads: ((string))[] = [], getRun = store.getRun.bind(store);
  store.getRun = async (id) => { reads.push(id); return getRun(id); };
  store.list = async () => { throw new Error("must not scan other historical runs"); };
  const next = await f.agents.build(f.input), first = f.prompts[start];
  assert.equal(first!.designer, true); assertEnvelopePrompt(first!.payload);
  assert.match(fixtureText(objectFields(objectFields(first!.payload).developmentRevision).scope), /只读限制历史原工件，不冻结本轮候选/u);
  assert.match(fixtureText(objectFields(objectFields(first!.payload).developmentRevision).scope), /仅适用于来源角色及当时批准或冻结的对象/u);
  assert.match(fixtureText(objectFields(objectFields(first!.payload).developmentRevision).scope), /新规划承接本轮批准架构；未接受草稿可纠错但不能自称通过，研发实现不得修改已冻结计划/u);
  assert.match(first!.systemPrompt!, /正式重查可修正技术验收与证据分工/u);
  assert.match(first!.systemPrompt!, /完整保留已确认业务范围、边界、结果、验证义务及明确选择，重新程序检查和独立评审，不以纠错缩水/u);
  assert.deepEqual(objectFields(first!.payload).previousDesign, rejected.architecture!.design);
  assert.equal(next.architecture!.status, "passed"); assert.deepEqual(reads, [f.native!.run.id]);
  assert.equal(objectFields(objectFields(next.architecture!.developmentRevision).source).recordHash, before);
  assert.equal(hashValue(await getRun(f.native!.run.id)), before); assert.deepEqual(await readFile(f.native!.file), raw);
  assert.equal(objectFields(next.architecture!.developmentRevision).sessions, undefined); assert.equal(objectFields(next.architecture!.developmentRevision).budgets, undefined);
});

test("旧记录无诊断和评审检查点时交设计者局部修订，不能补造续评资格或已用额度", async (t) => {
  const f = await fixture(t); f.state.interruptReview = true; f.state.draftSuffix = " 本轮已提交但未评审的完整草稿。";
  await assert.rejects(f.agents.build(f.input), (error: TestFailure) => error.diagnostic!.reason === "api_connection");
  const interrupted = await f.agents.architecture.get(f.input.id);
  assert.notEqual(interrupted!.candidateHash!, f.initial!.architecture!.candidateHash);
  interrupted!.status! = "evaluating"; delete interrupted!.diagnostic;
  delete interrupted!.reviewProgressCheckpoint; delete interrupted!.mainReviewCheckpoint;
  await f.agents.architecture.save(interrupted!);
  f.agents.architecture = new ArchitectureDesigner({ config: f.config, cwd: f.root, dataDir: f.dataDir,
    storage: f.agents.storage, sessionFactory: f.sessionFactory, fidelitySessionFactory: f.fidelitySessionFactory });
  const loaded = await f.agents.architecture.get(f.input.id);
  assert.equal(loaded!.status!, "failed"); assert.equal(loaded!.diagnostic!, undefined);
  f.state.interruptReview = false; f.state.draftSuffix = "";
  const start = f.prompts.length, next = await f.agents.build(f.input), first = f.prompts[start];
  assert.equal(first!.designer, true); assertEnvelopePrompt(first!.payload);
  assert.deepEqual(objectFields(first!.payload).previousDesign, interrupted!.design!);
  assert.equal(objectFields(objectFields(first!.payload).editableSubmission).baseCandidateHash, interrupted!.candidateHash!);
  assert.equal(objectFields(objectFields(first!.payload).editableSubmission).trust, "untrusted-reference"); assert.equal(objectFields(objectFields(first!.payload).modelBudget).used, 1);
  assert.equal(objectFields(objectFields(first!.payload).revisionSource).candidateTrust, "unreviewed-reference");
  assert.equal(objectFields(objectFields(first!.payload).revisionSource).version, interrupted!.version!); assert.equal(objectFields(objectFields(first!.payload).revisionSource).candidateHash, interrupted!.candidateHash!);
  assert.equal(next.architecture!.status, "passed");
  assert.equal(next.architecture!.attempts.length, 1); assert.equal(objectFields(next.architecture!.attempts[0]!.review).verdict, "pass");
});

async function exhaustedNativeReview(t: test.TestContext, { olderReviewed = false } = {}) {
  const f = await fixture(t);
  if (olderReviewed) {
    f.state.reject = true;
    assert.equal((await f.agents.build(f.input)).architecture!.status, "needs_changes");
    f.state.reject = false;
  }
  f.state.interruptReview = true; f.state.draftSuffix = " 中断前已提交的完整技术草稿。";
  await assert.rejects(f.agents.build(f.input), (error: TestFailure) => error.diagnostic!.reason === "api_connection");
  const source = await f.agents.architecture.get(f.input.id);
  assert.notEqual(source!.candidateHash!, f.initial!.architecture!.candidateHash);
  source!.diagnostic!.modelCalls = 12;
  delete source!.mainReviewCheckpoint; delete source!.reviewProgressCheckpoint;
  await f.agents.architecture.save(source!);
  f.state.interruptReview = false; f.state.draftSuffix = "";
  const runFile = join(await f.agents.storage.directory(source!.agentId!, "development/records"), `${f.native!.run.id}.json`);
  const before = { source: Buffer.from(JSON.stringify(await f.agents.architecture.getVersion(source!.agentId!, source!.version!))),
    original: Buffer.from(JSON.stringify(await f.agents.architecture.getVersion(source!.agentId!, f.initial!.architecture!.version))),
    run: await readFile(runFile), native: await readFile(f.native!.file) };
  const unchanged = async () => {
    assert.deepEqual(Buffer.from(JSON.stringify(await f.agents.architecture.getVersion(source!.agentId!, source!.version!))), before.source);
    assert.deepEqual(Buffer.from(JSON.stringify(await f.agents.architecture.getVersion(source!.agentId!, f.initial!.architecture!.version))), before.original);
    assert.deepEqual(await readFile(runFile), before.run); assert.deepEqual(await readFile(f.native!.file), before.native);
  };
  return { f, source, unchanged };
}

test("有绑定原生拒绝且旧评审12轮耗尽时先交设计者，原样候选在新review请求前受原额度阻断", async (t) => {
  const { f, source, unchanged } = await exhaustedNativeReview(t), start = f.prompts.length;
  await assert.rejects(f.agents.build(f.input), (error: TestFailure) => error.diagnostic!.reason === "turn_limit" && error.diagnostic!.modelCalls === 12);
  const current = f.prompts.slice(start), first = current[0];
  assert.equal(first!.designer, true); assert.deepEqual(objectFields(first!.payload).previousDesign, source!.design!); assertEnvelopePrompt(first!.payload);
  assert.deepEqual(objectFields(objectFields(first!.payload).revisionSource).reviewRepair, { candidateHash: source!.candidateHash!, modelCalls: 12, reason: "native_planning_rejection" });
  assert.equal(current.filter((entry) => !entry.designer).length, 0, "同hash不得再创建花费新请求的评审会话");
  const stopped = await f.agents.architecture.get(f.input.id);
  assert.equal(stopped!.candidateHash!, source!.candidateHash!); assert.equal(stopped!.review!, null); assert.equal(stopped!.attempts!.length, 0);
  assert.equal(stopped!.reviewProgressCheckpoint!.modelCalls, 12); assert.equal(objectFields(stopped!.reviewProgressCheckpoint!.source).candidateHash, source!.candidateHash!);
  await unchanged();
});

test("原生拒绝触发的耗尽评审技术修订须形成新候选并重新独审，历史来源字节不变", async (t) => {
  const { f, source, unchanged } = await exhaustedNativeReview(t), start = f.prompts.length;
  f.state.draftSuffix = " 修正技术验收，按当前平台事实核对证据分工。";
  const next = await f.agents.build(f.input), current = f.prompts.slice(start), first = current[0];
  assert.equal(first!.designer, true); assert.deepEqual(objectFields(first!.payload).previousDesign, source!.design!); assertEnvelopePrompt(first!.payload);
  assert.deepEqual(objectFields(objectFields(first!.payload).revisionSource).reviewRepair, { candidateHash: source!.candidateHash!, modelCalls: 12, reason: "native_planning_rejection" });
  assert.equal(next.architecture!.status, "passed"); assert.notEqual(next.architecture!.candidateHash, source!.candidateHash!);
  const reviewers = current.filter((entry) => !entry.designer);
  assert.equal(reviewers.length, 1); assert.equal(objectFields(reviewers[0]!.payload).candidateHash, next.architecture!.candidateHash);
  assert.equal(objectFields(objectFields(reviewers[0]!.payload).modelBudget).used, 1);
  assert.equal(next.architecture!.attempts.length, 1); assert.equal(objectFields(next.architecture!.attempts[0]!.review).verdict, "pass");
  assert.equal(next.architecture!.attempts[0]!.candidateHash, next.architecture!.candidateHash);
  await unchanged();
});

async function interruptedRepair(t: test.TestContext) {
  const value = await exhaustedNativeReview(t, { olderReviewed: true }), { f, source } = value;
  f.state.interrupt = true;
  await assert.rejects(f.agents.build(f.input), (error: TestFailure) => error.diagnostic!.reason === "api_connection");
  const interrupted = await f.agents.architecture.get(f.input.id);
  assert.equal(interrupted!.design!, null); assert.equal(interrupted!.candidateHash!, null);
  assert.equal(interrupted!.revisionSource!.version, source!.version!);
  assert.equal(objectFields(interrupted!.revisionSource!.reviewRepair).candidateHash, source!.candidateHash!);
  f.state.interrupt = false;
  return { ...value, interrupted };
}

test("耗尽评审后的设计修订再次中断，重启沿显式候选续接且同hash不重置12轮", async (t) => {
  const { f, source, unchanged } = await interruptedRepair(t);
  f.agents.architecture = new ArchitectureDesigner({ config: f.config, cwd: f.root, dataDir: f.dataDir,
    storage: f.agents.storage, sessionFactory: f.sessionFactory, fidelitySessionFactory: f.fidelitySessionFactory });
  f.state.draftSuffix = "";
  const start = f.prompts.length;
  await assert.rejects(f.agents.build(f.input), (error: TestFailure) => error.diagnostic!.reason === "turn_limit" && error.diagnostic!.modelCalls === 12);
  const current = f.prompts.slice(start), first = current[0];
  assert.equal(first!.designer, true); assertEnvelopePrompt(first!.payload);
  assert.deepEqual(objectFields(first!.payload).previousDesign, source!.design!);
  assert.equal(objectFields(objectFields(first!.payload).editableSubmission).baseCandidateHash, source!.candidateHash!);
  assert.equal(objectFields(objectFields(first!.payload).revisionSource).candidateTrust, "unreviewed-reference");
  assert.equal(objectFields(objectFields(first!.payload).revisionSource).version, source!.version!);
  assert.deepEqual(objectFields(objectFields(first!.payload).revisionSource).reviewRepair, { candidateHash: source!.candidateHash!, modelCalls: 12, reason: "native_planning_rejection" });
  assert.equal(current.filter((entry) => !entry.designer).length, 0);
  const stopped = await f.agents.architecture.get(f.input.id);
  assert.equal(stopped!.review!, null); assert.equal(stopped!.attempts!.length, 0);
  assert.equal(stopped!.reviewProgressCheckpoint!.modelCalls, 12);
  await unchanged();
});

test("显式未通过候选续接后仅新hash进入新独立评审，不继承旧结论", async (t) => {
  const { f, source, unchanged } = await interruptedRepair(t);
  f.state.draftSuffix = " 按当前验收方式修正技术证据分工。";
  const start = f.prompts.length, next = await f.agents.build(f.input), current = f.prompts.slice(start);
  assert.deepEqual(objectFields(current[0]!.payload).previousDesign, source!.design!);
  assert.equal(objectFields(objectFields(current[0]!.payload).editableSubmission).trust, "untrusted-reference");
  assert.equal(next.architecture!.status, "passed"); assert.notEqual(next.architecture!.candidateHash, source!.candidateHash!);
  assert.equal(current.filter((entry) => !entry.designer).length, 1);
  assert.equal(objectFields(objectFields(current.find((entry) => !entry.designer)!.payload).modelBudget).used, 1);
  assert.equal(next.architecture!.attempts.length, 1); assert.equal(objectFields(next.architecture!.attempts[0]!.review).verdict, "pass");
  await unchanged();
});

test("显式恢复来源、全部绑定或耗尽依据不符时不复用该候选和旧额度声明", async (t) => {
  const changes = [
    ["pointer-hash", (latest: { revisionSource: { candidateHash: string; reviewRepair: { candidateHash: string; }; }; }) => { latest.revisionSource.candidateHash = latest.revisionSource.reviewRepair.candidateHash = "0".repeat(64); }],
    ["pointer-version", (latest: { revisionSource: { version: number; }; }) => { latest.revisionSource.version = 1; }],
    ["source-requirements", (_latest: unknown, source: { requirements: { text: string; }[]; }) => { source.requirements[0]!.text += " changed"; }],
    ["source-platform", (_latest: unknown, source: { platformHash: string; }) => { source.platformHash = "0".repeat(64); }],
    ["source-runtime", (_latest: unknown, source: { runtimeCapabilities: { extra: boolean; }; }) => { source.runtimeCapabilities.extra = true; }],
    ["source-confirmed", (_latest: unknown, source: { confirmedRequirementContext: { hash: string; }; }) => { source.confirmedRequirementContext = { hash: "changed" }; }],
    ["source-deferred", (_latest: unknown, source: { deferredVerifications: { hash: string; }; }) => { source.deferredVerifications = { hash: "changed" }; }],
    ["source-snapshot", (_latest: unknown, source: { reviewEvidence: { snapshotHash: string; }; }) => { source.reviewEvidence.snapshotHash = "0".repeat(64); }],
    ["source-budget", (_latest: unknown, source: { diagnostic: { modelCalls: number; }; }) => { source.diagnostic.modelCalls = 11; }],
    ["corrupt-new-checkpoint", (_latest: unknown, source: { reviewProgressCheckpoint: null; }) => { source.reviewProgressCheckpoint = null; }],
    ["latest-provenance", (latest: { revisionSource: { requirementHash: string; }; }) => { latest.revisionSource.requirementHash = "0".repeat(64); }],
  ] as const;
  for (const [name, change] of changes) await t.test(name, async (t) => {
    const { f, source, interrupted } = await interruptedRepair(t);
    callFixture(change, undefined, [interrupted, source]);
    f.agents.architecture.records.set(`${source!.agentId!}:${source!.version!}`, source!);
    f.agents.architecture.records.set(`${interrupted!.agentId!}:${interrupted!.version!}`, interrupted!);
    f.state.draftSuffix = "";
    const start = f.prompts.length; await f.agents.build(f.input);
    const first = f.prompts[start];
    assert.equal(first!.designer, true);
    assert.notDeepEqual(objectFields(first!.payload).previousDesign, source!.design!);
    assert.equal(objectFields(objectFields(first!.payload).revisionSource)?.reviewRepair, undefined);
  });
});

test("非续评白名单错误仍只把完整当前草稿交给设计者，不继承评审资格", async (t) => {
  for (const reason of ["unknown_error", "api_error"]) await t.test(reason, async (t) => {
    const f = await fixture(t); f.state.interruptReview = true; f.state.draftSuffix = " 本轮未完成评审的独立稿。";
    await assert.rejects(f.agents.build(f.input));
    const interrupted = await f.agents.architecture.get(f.input.id);
    interrupted!.diagnostic!.reason = reason;
    await f.agents.architecture.save(interrupted!); f.state.interruptReview = false; f.state.draftSuffix = "";
    const start = f.prompts.length, next = await f.agents.build(f.input);
    assert.equal(f.prompts[start]!.designer, true); assertEnvelopePrompt(f.prompts[start]!.payload);
    assert.deepEqual(objectFields(f.prompts[start]!.payload).previousDesign, interrupted!.design!);
    assert.equal(objectFields(objectFields(f.prompts[start]!.payload).editableSubmission).baseCandidateHash, interrupted!.candidateHash!);
    assert.deepEqual(objectFields(f.prompts[start]!.payload).issues, []);
    assert.equal(f.prompts[start + 1]!.designer, false);
    const prior = objectFields(f.prompts[start + 1]!.payload).priorFindings;
    assert.equal(objectFields(objectFields(prior).findings).length, 5); assert.ok(recordArray(objectFields(prior).findings).every((entry) => entry.kind === "historical-planning-diagnostic"));
    assert.equal(objectFields(objectFields(prior).source).version, null); assert.equal(objectFields(objectFields(prior).source).candidateHash, null);
    assert.equal(next.architecture!.attempts.length, 1); assert.equal(objectFields(next.architecture!.attempts[0]!.review).verdict, "pass");
  });
});

test("缺失、结构非法、摘要或快照不匹配的当前草稿不复用，来源metadata损坏时整条拒绝", async (t) => {
  const changes = [
    ["missing", (record: { design: null; candidateHash: null; reviewContext: null; contractVersion: number; }) => { record.design = null; record.candidateHash = null; record.reviewContext = null;
      record.contractVersion = ARCHITECTURE_VERSION; }],
    ["schema", (record: { design: unknown; candidateHash: string; reviewContext: { candidateHash: unknown; }; }) => { objectFields(record.design).components = []; record.candidateHash = hashValue(record.design);
      record.reviewContext.candidateHash = record.candidateHash; }],
    ["hash", (record: { design: { instructions: string; }; }) => { record.design.instructions += " unsaved change"; }],
    ["snapshot", (record: { reviewEvidence: { snapshotHash: string; }; }) => { record.reviewEvidence.snapshotHash = "0".repeat(64); }],
  ] as const;
  for (const [name, change] of changes) await t.test(name, async (t) => {
    const f = await fixture(t); f.state.interruptReview = true;
    await assert.rejects(f.agents.build(f.input));
    const interrupted = await f.agents.architecture.get(f.input.id);
    interrupted!.diagnostic!.reason = "api_error"; callFixture(change, undefined, [interrupted]);
    if (name === "hash") {
      // Normal persistence rejects corrupt metadata; exercise that recovery rejection in memory.
      f.agents.architecture.records.set(`${interrupted!.agentId!}:${interrupted!.version!}`, interrupted!);
    } else await f.agents.architecture.save(interrupted!);
    f.state.interruptReview = false;
    const start = f.prompts.length; await f.agents.build(f.input);
    assert.equal(f.prompts[start]!.designer, true);
    if (name === "hash") assert.equal(objectFields(f.prompts[start]!.payload).developmentRevision, undefined);
    else assertEnvelopePrompt(f.prompts[start]!.payload);
    assert.equal(objectFields(f.prompts[start]!.payload).previousDesign, null); assert.equal(objectFields(f.prompts[start]!.payload).editableSubmission, undefined);
  });
});

test("来源或需求/平台/运行能力/确认/后续义务绑定改变时不得carry旧诊断", async (t) => {
  const mutations = [
    ["source", (record: { developmentRevision: { source: { recordHash: string; }; }; }) => { record.developmentRevision.source.recordHash = "0".repeat(64); }],
    ["requirements", (record: { requirements: { text: string; }[]; }) => { record.requirements![0]!.text += " changed"; }],
    ["platform", (record: { platformHash: string; }) => { record.platformHash = "0".repeat(64); }],
    ["runtime", (record: { runtimeCapabilities: { extra: boolean; }; }) => { record.runtimeCapabilities.extra = true; }],
    ["confirmed", (record: { confirmedRequirementContext: { hash: string; }; }) => { record.confirmedRequirementContext = { hash: "changed" }; }],
    ["deferred", (record: { deferredVerifications: { hash: string; }; }) => { record.deferredVerifications = { hash: "changed" }; }],
  ] as const;
  for (const [name, mutate] of mutations) await t.test(name, async (t) => {
    const f = await fixture(t); f.state.reject = true;
    const rejected = await f.agents.build(f.input), changed = structuredClone(rejected.architecture); callFixture(mutate, undefined, [changed]);
    if (name === "platform") {
      // Keep the intentionally invalid test record in memory; normal save rightly rejects its metadata.
      f.agents.architecture.records.set(`${changed!.agentId!}:${changed!.version!}`, changed!);
    } else await f.agents.architecture.save(changed!);
    f.state.reject = false;
    const start = f.prompts.length; await f.agents.build(f.input);
    assert.equal(objectFields(f.prompts[start]!.payload).developmentRevision, undefined);
  });
});
