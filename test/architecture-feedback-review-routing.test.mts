import { callFixture } from "./helpers/m7-test-boundaries.mjs";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import type { SessionMessage } from "../src/runtime/pi-port.mjs";
import type { PiSessionOptions } from "../src/runtime/pi-port.mjs";
import { fixtureTools } from "./helpers/m7-test-boundaries.mjs";
import type { TestFailure } from "./helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArchitectureDesigner } from "../src/architecture/architecture.mjs";
import { designHash } from "../src/architecture/architecture-contract.mjs";
import { developmentRevisionReference } from "../src/architecture/architecture-development-revision.mjs";
import { createReviewProgressCheckpoint } from "../src/architecture/architecture-review-progress.mjs";
import { validDraft, validDesign, passingReview } from "./helpers/architecture.mjs";
import type { RequirementItem } from "../src/contracts/architecture.mjs";

function candidate(requirements: readonly RequirementItem[]) {
  const design = validDesign(requirements, { schemaVersion: 3, profile: "custom", connections: [],
    interaction: { defaultEntry: "conversation", page: false, operations: true, inputs: "工作记录", results: "完整结果", persistentData: "无" },
    execution: { language: "javascript", hosting: "builtin", reason: "独立确定性处理" },
    selectionBasis: { capacity: "保留输入边界", process: "逐项处理", quality: "核对精确结果", requirementIds: requirements.map((row) => row.id), assumptions: [] } });
  design.decisions!.push({ id: "D9_old", problem: "写入内容如何严格匹配", choice: "执行器自动展开动态占位符",
    reason: "历史错误建议", alternatives: [{ option: "独立预期", reason: "精确匹配" }], evidenceIds: [], uncertainties: [] });
  return design;
}

async function fixture(t: test.TestContext, { used = 4, incomplete = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-feedback-route-")), calls: ({ "phase": (string); "role": (string); "payload": (unknown); })[] = [];
  const definition = { id: "feedback_pending", name: "反馈修订路由", fingerprint: "same-business", draft: validDraft() };
  const state = { phase: "baseline", designer: "same", reviewer: "capture" };
  const sessionFactory = async ({ customTools }: PiSessionOptions) => {
    const tools = fixtureTools(customTools), role = tools.submit_architecture ? "designer" : "reviewer";
    return { messages: [] as SessionMessage[], subscribe: () => () => {}, abort() {}, dispose() {}, async prompt(text: string) {
      const payload = JSON.parse(String(text)); calls.push({ phase: state.phase, role, payload });
      if (role === "designer") {
        if (state.phase !== "baseline" && state.designer === "interrupt") throw new Error("fetch failed: fixed offline designer interruption");
        const design = payload.previousDesign ? structuredClone(payload.previousDesign) : candidate(payload.requirements);
        if (state.phase !== "baseline" && state.designer === "fixed") {
          design.decisions[1].choice = "逐用例冻结独立精确预期，保留严格匹配";
          design.platformClaims = [{ id: "fixture_fact", source: "acceptanceAdapterGuide", path: "/adapters/action/executionFacts/dynamicPlaceholders",
            expected: false, decisionIds: [design.decisions[1].id], acceptanceIds: [] }];
        }
        return tools.submit_architecture!.execute("fixed-design", design);
      }
      if (state.phase !== "baseline" && state.reviewer === "capture") throw new Error("fetch failed: fixed offline reviewer capture");
      const review = passingReview(payload.candidateHash, payload.design, payload.priorFindings);
      for (const row of review.priorFindingDecisions ?? []) {
        if (payload.priorFindings.findings.find((finding: { findingId: string; }) => finding.findingId === row.findingId).kind !== "historical-development-review") continue;
        row.status = "resolved"; row.checkIds = ["verification"]; row.candidatePaths = ["/decisions/1/choice"];
        review.issues.push({ id: row.findingId!, kind: "design", checkId: "verification", blocking: false,
          description: "当前方案采用明确独立预期", remedy: "按冻结事实执行", candidatePaths: row.candidatePaths, factClaims: [], references: [
            { source: "candidate", path: "/decisions/1/choice", quote: payload.design.decisions[1].choice },
            { source: "acceptanceAdapterGuide", path: "/adapters/action/executionFacts/dynamicPlaceholders", quote: "false" },
          ] });
      }
      // The baseline deliberately reconstructs a historical wrong approval; it is a fixed answer, not a feasibility proof.
      return tools.submit_architecture_review!.execute("fixed-review", review);
    } };
  };
  let designer = new ArchitectureDesigner({ config: { llmConfigured: true }, cwd: root, dataDir: join(root, "data"), sessionFactory });
  t.after(async () => { await designer.persistence; await rm(root, { recursive: true, force: true }); });
  const original = await designer.design(definition);
  const run = { id: "original_failed_run", agentId: definition.id, version: 1, revision: 1,
    architectureRef: { version: original.version, candidateHash: original.candidateHash }, architecture: structuredClone(original),
    status: "failed", delivery: "blocked", phase: "planning", summary: "原问题未处理", plan: null, planHash: null, planAttempts: [],
    pendingPlan: null, tasks: [], reports: [], deliveries: [], feedback: { reason: "重新核验" },
    reviews: [{ verdict: "revise", issues: [{ id: "strict_placeholder", kind: "plan", blocking: true,
      description: incomplete ? "x".repeat(600000) : "平台不支持动态占位符", remedy: "冻结独立精确预期" }] }] };
  const reference = developmentRevisionReference(run, original);
  const legacy = structuredClone(reference);
  Reflect.deleteProperty(legacy, "reviewFeedback"); legacy.reviews = []; legacy.omitted = { reviews: 0, reports: 0, planDraftChecks: 0 };
  const pending = { ...structuredClone(original), version: 2, status: "failed", delivery: "blocked", review: null, attempts: [],
    developmentRevision: legacy, diagnostic: { stage: "architecture", role: "reviewer", phase: "evaluating", reason: "api_connection", modelCalls: used },
    revisionSource: { version: 1, candidateHash: original.candidateHash, kind: "development-failure", developmentRunId: run.id,
      developmentRecordHash: reference.source.recordHash, developmentArchitectureRef: structuredClone(run.architectureRef) } };
  Reflect.deleteProperty(pending, "feedbackLedger");
  pending.reviewProgressCheckpoint = createReviewProgressCheckpoint(pending, null, used);
  assert.ok(pending.reviewProgressCheckpoint);
  await designer.save(pending); state.phase = "resume";
  return { get designer() { return designer; }, definition, original, source: await designer.getVersion(definition.id, pending.version), run, calls, state,
    reload: async () => {
      await designer.persistence;
      designer = new ArchitectureDesigner({ config: { llmConfigured: true }, cwd: root, dataDir: join(root, "data"), sessionFactory });
      await designer.ready;
    },
    runDesign: (options = {}) => callFixture(designer.design, designer, [objectFields(options).definition ?? definition, { developmentFailure: run, ...options }]),
  };
}

test("旧待评候选新增研发反馈时先修订，同候选评审沿用已花4轮而非重置", async (t) => {
  const f = await fixture(t), before = designHash(f.source), start = f.calls.length;
  await assert.rejects(f.runDesign(), (error: TestFailure) => error.diagnostic!.reason === "api_connection");
  const calls = f.calls.slice(start), record = await f.designer.get(f.definition.id);
  assert.deepEqual(calls.map((row) => row.role), ["designer", "reviewer"]);
  assert.equal(objectFields(objectFields(objectFields(calls[0]!.payload).revisionFeedback).findings).length, 1);
  assert.deepEqual(objectFields(objectFields(calls[0]!.payload).revisionSource).feedbackRepair, { version: f.source!.version, candidateHash: f.source!.candidateHash,
    bindingHash: f.source!.reviewProgressCheckpoint!.bindingHash, modelCalls: 4 });
  assert.equal(objectFields(objectFields(calls[1]!.payload).modelBudget).used, 5); assert.equal(record!.reviewProgressCheckpoint!.modelCalls, 5);
  assert.equal(record!.candidateHash!, f.source!.candidateHash);
  assert.equal(designHash(await f.designer.getVersion(f.definition.id, f.source!.version)), before);
});

test("同候选原12轮已耗尽时只交设计者，原样提交不再启动评审", async (t) => {
  const f = await fixture(t, { used: 12 }), start = f.calls.length;
  await assert.rejects(f.runDesign(), (error: TestFailure) => error.diagnostic!.reason === "turn_limit" && error.diagnostic!.modelCalls === 12);
  assert.deepEqual(f.calls.slice(start).map((row) => row.role), ["designer"]);
  assert.equal((await f.designer.get(f.definition.id))!.reviewProgressCheckpoint!.modelCalls, 12);
});

test("相关新候选独立评审，完整审结清除中断标记且不冻结用户后续新需求", async (t) => {
  const f = await fixture(t); f.state.designer = "fixed"; f.state.reviewer = "pass";
  const record = await f.runDesign();
  assert.equal(record.status, "passed"); assert.notEqual(record.candidateHash, f.source!.candidateHash);
  assert.equal(record.reviewProgressCheckpoint!.modelCalls, 1); assert.equal(record.revisionSource!.feedbackRepair, undefined);
  f.state.designer = "interrupt";
  const start = f.calls.length;
  await assert.rejects(f.runDesign({ definition: { ...f.definition, name: "用户主动修改需求", fingerprint: "new-business" } }),
    (error: TestFailure) => error.diagnostic!.reason === "api_connection");
  assert.equal(f.calls[start]!.role, "designer");
});

test("设计提交前中断并重启后仍从唯一原候选恢复，4轮不丢失", async (t) => {
  const f = await fixture(t); f.state.designer = "interrupt";
  await assert.rejects(f.runDesign());
  const interrupted = await f.designer.get(f.definition.id);
  assert.equal(interrupted!.design!, null); assert.equal(objectFields(interrupted!.revisionSource!.feedbackRepair).modelCalls, 4);
  await f.reload(); f.state.designer = "same"; const start = f.calls.length;
  await assert.rejects(f.runDesign());
  assert.deepEqual(f.calls.slice(start).map((row) => row.role), ["designer", "reviewer"]);
  assert.equal(objectFields(objectFields(f.calls[start + 1]!.payload).modelBudget).used, 5);
});

test("新候选B已有独立预算后检查点损坏，不能回退A或零预算", async (t) => {
  const f = await fixture(t); f.state.designer = "fixed";
  await assert.rejects(f.runDesign());
  const record = await f.designer.get(f.definition.id);
  assert.notEqual(record!.candidateHash!, f.source!.candidateHash); assert.equal(record!.reviewProgressCheckpoint!.modelCalls, 1);
  record!.reviewProgressCheckpoint!.hash = "0".repeat(64); await f.designer.save(record!); await f.reload();
  const start = f.calls.length;
  await assert.rejects(f.runDesign(), (error: TestFailure) => error.validationIssue!.reason === "feedback_repair_source_invalid");
  assert.equal(f.calls.length, start);
});

test("反馈覆盖未知时先保存明确失败，不花模型请求伪造负评", async (t) => {
  const f = await fixture(t, { incomplete: true }), start = f.calls.length;
  await assert.rejects(f.runDesign(), (error: TestFailure) => error.validationIssue!.reason === "feedback_coverage_incomplete");
  assert.equal(f.calls.length, start);
  const record = await f.designer.get(f.definition.id);
  assert.equal(record!.status!, "failed"); assert.equal(record!.review!, null); assert.equal(objectFields(objectFields(record!.feedbackLedger!).coverage).status, "incomplete");
  assert.equal(objectFields(record!.revisionSource!.feedbackRepair).modelCalls, 4, "新旧都不完整且没有问题正文时也封存原预算");
});

test("来源完整重读后从覆盖失败继续，不能把原4轮变成新预算", async (t) => {
  const f = await fixture(t), start = f.calls.length;
  await assert.rejects(f.runDesign({ historicalPlanningReference: { schemaVersion: 1, status: "unavailable" } }),
    (error: TestFailure) => error.validationIssue!.reason === "feedback_coverage_incomplete");
  assert.equal(f.calls.length, start);
  const failed = await f.designer.get(f.definition.id);
  assert.equal(objectFields(failed!.revisionSource!.feedbackRepair).modelCalls, 4);
  await f.reload();
  await assert.rejects(f.runDesign(), (error: TestFailure) => error.diagnostic!.reason === "api_connection");
  assert.deepEqual(f.calls.slice(start).map((row) => row.role), ["designer", "reviewer"]);
  assert.equal(objectFields(objectFields(f.calls.at(-1)!.payload).modelBudget).used, 5);
});

test("新候选首次评审请求前退出也有真实0轮检查点，重启直接续评", async (t) => {
  const f = await fixture(t); f.state.designer = "fixed";
  await assert.rejects(f.runDesign({ onProgress: (event: { type: string; phase: string; }) => {
    if (event.type === "status" && event.phase === "evaluating") throw new Error("fixed interruption before the first reviewer request");
  } }));
  const saved = await f.designer.get(f.definition.id);
  assert.notEqual(saved!.candidateHash!, f.source!.candidateHash); assert.equal(saved!.reviewProgressCheckpoint!.modelCalls, 0);
  await f.reload(); const start = f.calls.length;
  await assert.rejects(f.runDesign(), (error: TestFailure) => error.diagnostic!.reason === "api_connection");
  assert.deepEqual(f.calls.slice(start).map((row) => row.role), ["reviewer"]);
  assert.equal(objectFields(objectFields(f.calls.at(-1)!.payload).modelBudget).used, 1);
});

test("已标记修订的原来源、预算或标记缺失时在新请求前拒绝", async (t) => {
  const changes = {
    "missing-marker": (current: { revisionSource: { feedbackRepair: unknown; }; }) => { Reflect.deleteProperty(current.revisionSource, "feedbackRepair"); },
    "binding": (current: { revisionSource: { feedbackRepair: { bindingHash: string; }; }; }) => { current.revisionSource.feedbackRepair.bindingHash = "0".repeat(64); },
    "used": (current: { revisionSource: { feedbackRepair: { modelCalls: number; }; }; }) => { current.revisionSource.feedbackRepair.modelCalls = 0; },
    "original-material": (_current: unknown, source: { researchGaps: string[]; }) => { source.researchGaps.push("原来源材料已变化"); },
    "original-progress": (_current: unknown, source: { reviewProgressCheckpoint: { hash: string; }; }) => { source.reviewProgressCheckpoint.hash = "0".repeat(64); },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async (t) => {
    const f = await fixture(t); f.state.designer = "interrupt"; await assert.rejects(f.runDesign());
    const current = await f.designer.get(f.definition.id), source = await f.designer.getVersion(f.definition.id, f.source!.version);
    callFixture(change, undefined, [current, source]); await f.designer.save(source!); await f.designer.save(current!); await f.reload();
    f.state.designer = "same"; const start = f.calls.length;
    await assert.rejects(f.runDesign(), (error: TestFailure) => error.validationIssue!.reason === "feedback_repair_source_invalid");
    assert.equal(f.calls.length, start);
  });
});

test("明确提供的原研发记录发生变化，不能只沿旧投影继续评审", async (t) => {
  const f = await fixture(t); f.state.designer = "interrupt";
  await assert.rejects(f.runDesign()); await f.reload();
  f.run.summary += " changed source"; f.state.designer = "same";
  const start = f.calls.length;
  await assert.rejects(f.runDesign(), (error: TestFailure) => error.validationIssue!.reason === "feedback_repair_source_invalid");
  assert.equal(f.calls.length, start);
});

test("宿主明确查不到原研发记录时零请求停止，旧直接省略参数仍只读兼容", async (t) => {
  const f = await fixture(t), beforeMarker = f.calls.length;
  await assert.rejects(f.runDesign({ developmentFailure: null }),
    (error: TestFailure) => error.validationIssue!.reason === "feedback_repair_source_invalid");
  assert.equal(f.calls.length, beforeMarker, "尚无新marker的旧待评版本同样不能忽略宿主明确缺失");
  f.state.designer = "interrupt"; await assert.rejects(f.runDesign()); await f.reload();
  const start = f.calls.length;
  await assert.rejects(f.runDesign({ developmentFailure: null }),
    (error: TestFailure) => error.validationIssue!.reason === "feedback_repair_source_invalid");
  assert.equal(f.calls.length, start);
  f.state.designer = "same";
  await assert.rejects(f.runDesign({ developmentFailure: undefined }), (error: TestFailure) => error.diagnostic!.reason === "api_connection");
  assert.deepEqual(f.calls.slice(start).map((row) => row.role), ["designer", "reviewer"]);
  assert.equal(objectFields(objectFields(f.calls.at(-1)!.payload).modelBudget).used, 5);
});
