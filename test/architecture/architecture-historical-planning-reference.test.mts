import {fixtureString} from "../helpers/http-model.mjs";
import {callFixture} from "../helpers/m7-test-boundaries.mjs";
import type {DevelopmentRevisionArchitecture,HistoricalDevelopmentRun} from "../../src/architecture/architecture-development-revision.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import { fixtureTools } from "../helpers/m7-test-boundaries.mjs";
import { toolText } from "../helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrototypeAgents } from "../../src/agents/agent-prototype.mjs";
import { designHash } from "../../src/architecture/architecture-contract.mjs";
import { hashValue } from "../../src/development/development-contract.mjs";
import { compactDevelopmentContext } from "../../src/development/development-context.mjs";
import { readHistoricalPlanningReference, developmentRevisionReference, developmentRevisionContext,
  developmentRevisionReadTool, developmentPlanningFailureSummary, developmentReviewFeedback, savedDevelopmentRevisionSource,
  DEVELOPMENT_REVISION_MAX_BYTES } from "../../src/architecture/architecture-development-revision.mjs";
import { validDraft, validDesign, passingReview } from "../helpers/architecture.mjs";
import type { StoredArchitectureRecord } from "../../src/architecture/architecture-controller-port.mjs";

const ref = (architecture:Pick<DevelopmentRevisionArchitecture,"version"|"candidateHash">|null) => ({ version: architecture!.version, candidateHash: architecture!.candidateHash! });
const plan = () => ({ schemaVersion: 2, summary: "仅为历史未接受草稿", runtime: "node-action", tasks: [],
  cases: [{ id: "old_case", input: "HISTORICAL_INPUT", assertions: [] }], activationCases: [{ id: "old_activation" }] });
function run(architecture:DevelopmentRevisionArchitecture|null,id:string,candidate?:unknown) {
  return { id, agentId: architecture!.agentId, version: architecture!.version, revision: 1, architectureRef: ref(architecture),
    architecture: structuredClone(architecture), status: "failed", delivery: "blocked", phase: "planning", summary: "本轮规划未提交",
    plan: null, planHash: null, pendingPlan: candidate ? { plan: candidate, planHash: hashValue(candidate) } : null,
    planAttempts:[] as unknown[],reports:[] as unknown[],reviews:[] as Record<string,unknown>[],deliveries:[] as unknown[],tasks:[] as unknown[],feedback:{reason:"latest_failure"} as Record<string,unknown>,
    sessions: { old: { turns: 12 } }, budgets: { corrections: 0 } };
}
function fixture({summary}:{summary?:string}={}) {
  const originalBase = { agentId: "lineage_agent", version: 1, status: "passed", delivery: "needs_development", sourceFingerprint: "same-input",
    requirements: [{ id: "r_input", text: "保留原需求" }], platformHash: "same-platform", runtimeCapabilities: { version: 1 },
    confirmedRequirementContext: { hash: "confirmed" }, deferredVerifications: { hash: "deferred" }, design: { schemaVersion: 3, instructions: "原设计" } };
  const original=originalBase as typeof originalBase & {candidateHash:string;review:{verdict:string;candidateHash:string};developmentRevision?:unknown};
  original.candidateHash = designHash(original.design); original.review = { verdict: "pass", candidateHash: original.candidateHash };
  const oldPlan = plan(); if (summary) oldPlan.summary = summary;
  const oldRun = run(original, "old_run", oldPlan), reference = developmentRevisionReference(oldRun, original);
  const parent = { ...structuredClone(original), version: 2, design: { schemaVersion: 3, instructions: "当前设计" },
    developmentRevision: reference, revisionSource: { kind: "development-failure", developmentRunId: oldRun.id,
      developmentRecordHash: reference.source.recordHash, developmentArchitectureRef: ref(original) } };
  parent.candidateHash = designHash(parent.design); parent.review = { verdict: "pass", candidateHash: parent.candidateHash };
  const latest=run(parent,"latest_run");
  const reads: (string|number)[][] = [];
  const load = (options = {}) => readHistoricalPlanningReference({ architecture: parent, developmentFailure: latest,
    readRun: async (id) => { reads.push(["run", id]); return oldRun; },
    readArchitecture: async (version) => { reads.push(["architecture", version]); return original; }, ...options });
  return { original, oldRun, parent, latest, reads, load };
}

function refreshSource(f:ReturnType<typeof fixture>) {
  const reference = developmentRevisionReference(f.oldRun, f.original);
  f.parent.developmentRevision = reference;
  f.parent.revisionSource.developmentRecordHash = reference.source.recordHash;
  f.latest.architecture = structuredClone(f.parent);
}

test("最新故障不覆盖更早评审：非阻断旧问题、矛盾建议与原反馈完整续接", async () => {
  const f = fixture();
  f.oldRun.reviews = [{ mode: "plan", planHash: f.oldRun.pendingPlan!.planHash, verdict: "revise", summary: "原评审",
    issues: [{ id: "placeholder_issue", blocking: false, description: "动态占位符无法严格匹配", remedy: "改用受支持的动态占位符" }] },
  ...Array.from({ length: 5 }, (_, index) => ({ mode: "plan", planHash: `other_plan_${index}`, verdict: "revise", issues: [] }))];
  f.oldRun.feedback = { reason: "原失败", review: { ...structuredClone(f.oldRun.reviews[0]), evaluatedAt: "2026-10-20T00:00:00.000Z" } };
  refreshSource(f);
  const oldHash = hashValue(f.oldRun), history = await f.load();
  assert.equal(history!.status, "available");
  assert.deepEqual(history!.feedback, f.oldRun.feedback);
  const projected = developmentRevisionReference(f.latest, f.parent, { historicalPlanningReference: history });
  assert.equal(projected.feedback!.reason, "latest_failure");
  const opinions = developmentReviewFeedback(projected);
  assert.equal(opinions.status, "available"); assert.equal(opinions.total, 1); assert.equal(opinions.omitted, 0);
  assert.equal(opinions.findings[0]!.source.runId, f.oldRun.id);
  assert.equal(opinions.findings[0]!.source.recordHash, oldHash);
  assert.equal(opinions.findings[0]!.source.reviewIndex, 0); assert.equal(opinions.findings[0]!.source.issueIndex, 0);
  assert.equal(opinions.findings[0]!.issue.blocking, false);
  assert.equal(opinions.findings[0]!.suggestedRemedy, "改用受支持的动态占位符");
  assert.match(opinions.scope, /建议不能作为平台能力事实/);
  assert.equal(opinions.findings[0]!.findingId, history!.reviewFeedback!.findings[0]!.findingId);
  const summary = developmentRevisionContext(projected).reviewFeedbackSummary;
  assert.equal(summary.findings[0]!.description, "动态占位符无法严格匹配");
  assert.equal(summary.findings[0]!.detailSection, "historicalPlanningReference");
  assert.equal(hashValue(f.oldRun), oldHash);
});

test("评审意见索引不受最近四条截断或计划变化影响，完整原文可分页读取", async () => {
  const f = fixture();
  f.oldRun.reviews = Array.from({ length: 10 }, (_, index) => ({ mode: "plan", planHash: `old_plan_${index}`, verdict: "revise",
    issues: [{ id: `old_${index}`, blocking: index % 2 === 0, description: `原问题${index}`, remedy: `待核实建议${index}` }] }));
  const reference = developmentRevisionReference(f.oldRun, f.original);
  assert.equal(reference.reviews!.length, 0, "原有当前计划评语投影保持原规则");
  assert.equal(reference.reviewFeedback.total, 10);
  const summary = developmentRevisionContext(reference).reviewFeedbackSummary;
  assert.equal(summary.shown, 8); assert.equal(summary.remaining, 2); assert.equal(objectFields(summary).omitted, 0);
  const page = JSON.parse(toolText((await developmentRevisionReadTool(reference).execute("read", {
    section: "reviewFeedback", offset: 0, limit: 8000 }))));
  assert.match(page.text, /原问题0/);
  assert.equal(developmentReviewFeedback(reference).findings.at(-1)!.source.reviewIndex, 9);
});

test("仅存在feedback.review的原意见也保留独立来源，不复制成当前已证事实", () => {
  const f = fixture();
  f.oldRun.feedback.review = { mode: "plan", verdict: "revise", summary: "反馈中独有评语",
    issues: [{ id: "feedback_only", blocking: true, description: "原意见", remedy: "未经证明的建议" }] };
  const reference = developmentRevisionReference(f.oldRun, f.original);
  const opinions = developmentReviewFeedback(reference);
  assert.equal(opinions.total, 1); assert.equal(opinions.findings[0]!.source.origin, "feedback.review");
  assert.equal(opinions.findings[0]!.source.reviewIndex, null);
  assert.equal(opinions.findings[0]!.review.verdict, "revise"); assert.equal(opinions.current, false);
  assert.equal(opinions.trust, "untrusted-reference");
});

test("合法旧评语缺mode、verdict或blocking时首包摘要仍可参与真实控制器JSON摘要绑定", () => {
  const f = fixture();
  f.oldRun.reviews = [{ issues: [{ id: "legacy_optional", description: "只有旧问题正文" }] }];
  const context = developmentRevisionContext(developmentRevisionReference(f.oldRun, f.original));
  const payload = { developmentRevision: context };
  const summary = context.reviewFeedbackSummary.findings[0];
  assert.deepEqual(summary!.review, {}); assert.equal(summary!.blocking, null);
  assert.doesNotThrow(() => designHash(payload));
  assert.equal(designHash(payload), designHash(JSON.parse(JSON.stringify(payload))), "序列化不能悄悄丢字段改变控制器摘要");
});

test("历史评审超额或来源未经验证时明确不完整，不能变成没有待核对问题", async () => {
  const f = fixture({ summary: "x".repeat(300000) });
  f.oldRun.reviews = [{ planHash: f.oldRun.pendingPlan!.planHash, verdict: "revise",
    issues: [{ id: "old_issue", blocking: true, description: "旧缺陷", remedy: "按平台规则重验" }] }];
  refreshSource(f); f.latest.feedback.report = { summary: "y".repeat(300000) };
  const history = await f.load();
  const projected = developmentRevisionReference(f.latest, f.parent, { historicalPlanningReference: history });
  assert.equal(projected.status, "available");
  assert.equal(projected.historicalPlanningReference!.reason, "historical_reference_total_limit");
  const feedback = developmentReviewFeedback(projected);
  assert.equal(feedback.status, "incomplete"); assert.equal(feedback.total, 1); assert.equal(feedback.omitted, 1);
  const altered = structuredClone(history);
  const rejected = developmentRevisionReference(f.latest, f.parent, { historicalPlanningReference: altered });
  assert.equal(rejected.historicalPlanningReference!.reason, "historical_reference_unverified");
  assert.equal(developmentReviewFeedback(rejected).status, "incomplete");
  assert.equal(developmentReviewFeedback(rejected).omitted, null);
});

test("最新失败保持主身份，单代显式旧草稿仅作为可分页历史参考", async () => {
  const f = fixture(), oldHash = hashValue(f.oldRun), latestHash = hashValue(f.latest), history = await f.load();
  assert.equal(savedDevelopmentRevisionSource(f.parent), null, "不放宽旧候选恢复入口");
  const projected = developmentRevisionReference(f.latest, f.parent, { historicalPlanningReference: history });
  assert.equal(projected.source.runId, f.latest.id); assert.equal(projected.plan, null); assert.equal(projected.planHash, null);
  assert.deepEqual(projected.feedback, f.latest.feedback); assert.equal(projected.historicalPlanningReference!.current, false);
  assert.equal(projected.historicalPlanningReference!.source!.runId, f.oldRun.id);
  assert.deepEqual(projected.historicalPlanningReference!.plan, f.oldRun.pendingPlan!.plan);
  assert.equal(objectFields(projected.historicalPlanningReference).sessions, undefined); assert.equal(objectFields(projected.historicalPlanningReference).budgets, undefined);
  assert.equal(objectFields(projected.historicalPlanningReference).architecture, undefined);
  assert.deepEqual(f.reads, [["run", "old_run"], ["architecture", 1]]);
  const summary = developmentRevisionContext(projected).historicalPlanningReferenceSummary;
  assert.equal(objectFields(summary).cases, 1); assert.equal(objectFields(summary).activationCases, 1); assert.equal(summary!.current, false);
  const page = JSON.parse(toolText((await developmentRevisionReadTool(projected).execute("read", {
    section: "historicalPlanningReference", offset: 0, limit: 8000 }))));
  assert.equal(JSON.parse(page.text).planHash, history!.planHash);
  assert.equal(hashValue(f.oldRun), oldHash); assert.equal(hashValue(f.latest), latestHash);
});

test("当前已有完整候选计划时不读取或继承祖先", async () => {
  const f = fixture(), historical = await f.load(); f.reads.length = 0;
  f.latest.pendingPlan = { plan: plan(), planHash: hashValue(plan()) };
  assert.equal(await f.load(), undefined); assert.deepEqual<NonNullable<typeof f>["reads"]>(f.reads, []);
  const projected = developmentRevisionReference(f.latest, f.parent, { historicalPlanningReference: historical });
  assert.deepEqual(projected.plan, f.latest.pendingPlan.plan); assert.equal(projected.historicalPlanningReference, undefined);
});

test("显式记录、业务绑定或计划变化时祖先不可用，主失败投影继续保留", async (t) => {
  const changes = {
    "record": (f: { oldRun: { budgets: { corrections: number; }; }; }) => { f.oldRun.budgets.corrections = 1; },
    "architecture-ref": (f: { original: { candidateHash: string; }; }) => { f.original.candidateHash = "0".repeat(64); },
    "agent": (f: { original: { agentId: string; }; }) => { f.original.agentId = "other_agent"; },
    "fingerprint": (f: { original: { sourceFingerprint: string; }; }) => { f.original.sourceFingerprint = "changed"; },
    "requirements": (f: { original: { requirements: { text: string; }[]; }; }) => { f.original.requirements[0]!.text = "changed"; },
    "platform": (f: { original: { platformHash: string; }; }) => { f.original.platformHash = "changed"; },
    "runtime": (f: { original: { runtimeCapabilities: { version: number; }; }; }) => { f.original.runtimeCapabilities.version = 2; },
    "confirmed": (f: { original: { confirmedRequirementContext: { hash: string; }; }; }) => { f.original.confirmedRequirementContext.hash = "changed"; },
    "deferred": (f: { original: { deferredVerifications: { hash: string; }; }; }) => { f.original.deferredVerifications.hash = "changed"; },
    "declared-plan": (f: { parent: { developmentRevision: { plan: { summary: string; }; }; }; }) => { f.parent.developmentRevision.plan.summary = "changed"; },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async () => {
    const f = fixture(); callFixture(change,undefined,[f]); const history = await f.load();
    assert.equal(history!.status, "unavailable");
    const projected = developmentRevisionReference(f.latest, f.parent, { historicalPlanningReference: history });
    assert.equal(projected.status, "available"); assert.equal(projected.source.runId, f.latest.id);
    assert.equal(projected.historicalPlanningReference!.status, "unavailable"); assert.equal(projected.plan, null);
  });
});

test("来源缺失、冲突和旧注入缺reader均不搜索其他run", async () => {
  const f = fixture();
  const missing = await f.load({ readRun: async (id: unknown) => { assert.equal(id, "old_run"); return null; } });
  assert.equal(missing!.reason, "historical_source_missing");
  assert.equal((await f.load({ readRun: undefined }))!.reason, "historical_source_reader_unavailable");
  f.parent.revisionSource.developmentRecordHash = "0".repeat(64); f.reads.length = 0;
  assert.equal((await f.load())!.reason, "historical_source_binding_invalid"); assert.deepEqual<NonNullable<typeof f>["reads"]>(f.reads, []);
  Reflect.deleteProperty(f.parent,"developmentRevision");
  assert.equal(await f.load(), undefined); assert.deepEqual<NonNullable<typeof f>["reads"]>(f.reads, []);
});

test("不递归原架构的更老来源，也不把调用者伪造或修改的投影当宿主证明", async () => {
  const f = fixture(); f.original.developmentRevision = { source: { runId: "never_read" } };
  const history = await f.load(); assert.equal(history!.status, "available"); assert.equal(f.reads.length, 2);
  assert.equal(objectFields(history).historicalPlanningReference, undefined);
  const clone = structuredClone(history);
  assert.equal(developmentRevisionReference(f.latest, f.parent, { historicalPlanningReference: clone }).historicalPlanningReference!.reason,
    "historical_reference_unverified");
  objectFields(history!.plan).summary = "late_change";
  assert.equal(developmentRevisionReference(f.latest, f.parent, { historicalPlanningReference: history }).historicalPlanningReference!.reason,
    "historical_reference_unverified");
  const cyclic = await f.load(); objectFields(cyclic!.plan).loop = cyclic;
  assert.equal(developmentRevisionReference(f.latest, f.parent, { historicalPlanningReference: cyclic }).historicalPlanningReference!.reason,
    "historical_reference_unverified");
});

test("合计超过512KiB时仅放弃祖先，保留最新诊断与既有上限", async () => {
  const f = fixture({ summary: "x".repeat(300000) }); f.latest.feedback.report = { summary: "y".repeat(300000) };
  const history = await f.load(); assert.equal(history!.status, "available");
  const projected = developmentRevisionReference(f.latest, f.parent, { historicalPlanningReference: history });
  assert.equal(projected.status, "available"); assert.equal(projected.source.runId, f.latest.id);
  assert.equal(projected.historicalPlanningReference!.reason, "historical_reference_total_limit");
  assert.equal(fixtureString(objectFields(projected.feedback!.report).summary).length, 300000);
  assert.ok(Buffer.byteLength(JSON.stringify(projected)) <= DEVELOPMENT_REVISION_MAX_BYTES);
  assert.equal(projected.bytes, Buffer.byteLength(JSON.stringify(projected)));
});

test("bytes自描述导致最后越界时也只丢祖先，不把原可用主参考改成不可用", async () => {
  const initial = fixture({ summary: "x".repeat(1000) }); initial.latest.feedback.report = { summary: "y".repeat(300000) };
  const first = developmentRevisionReference(initial.latest, initial.parent, { historicalPlanningReference: await initial.load() });
  delete first.bytes;
  const size = 1000 + DEVELOPMENT_REVISION_MAX_BYTES - 2 - Buffer.byteLength(JSON.stringify(first));
  const f = fixture({ summary: "x".repeat(size) }); f.latest.feedback.report = { summary: "y".repeat(300000) };
  const primary = developmentRevisionReference(f.latest, f.parent);
  assert.equal(primary.status, "available");
  const projected = developmentRevisionReference(f.latest, f.parent, { historicalPlanningReference: await f.load() });
  assert.equal(projected.status, "available"); assert.equal(projected.historicalPlanningReference!.reason, "historical_reference_total_limit");
  assert.equal(projected.source.runId, f.latest.id); assert.deepEqual(projected.feedback, primary.feedback);
  assert.equal(projected.bytes, Buffer.byteLength(JSON.stringify(projected))); assert.ok(projected.bytes <= DEVELOPMENT_REVISION_MAX_BYTES);
});

test("独立规划失败摘要不读取计划、输入、替身、事实或思考字段", () => {
  const reference = { planningToolFailures: { schemaVersion: 1, trust: "untrusted-reference", current: false, status: "available",
    source: { agentId: "agent", runId: "run", recordHash: "a".repeat(64) }, failures: [{ entryId: "entry", toolCallId: "call",
      toolName: "save_plan_cases", issues: [{ path: "case.kind", reason: "rejected", remedy: "核对当前事实",
        source: { caseId: "case" }, proposedCaseRef: { id: "case", acceptanceId: "acceptance" } }] }] } };
  for (const key of ["plan", "input", "mocks", "caseFacts", "thinking", "historicalPlanningReference"])
    Object.defineProperty(reference, key, { enumerable: true, get() { throw new Error(`must not read ${key}`); } });
  const summary = developmentPlanningFailureSummary(reference);
  assert.equal(summary!.total, 1); assert.equal(summary!.issues![0]!.reason, "rejected");
});

test("取消不保存祖先，紧缩研发提示只携带独立状态和精确读取位置", async () => {
  const f = fixture({ summary: "x".repeat(20000) }), controller = new AbortController();
  await assert.rejects(f.load({ signal: controller.signal, readRun: async () => { controller.abort(); return f.oldRun; } }), { name: "AbortError" });
  const history = await f.load(), projected = developmentRevisionReference(f.latest, f.parent, { historicalPlanningReference: history });
  const compact = compactDevelopmentContext({ developmentRevision: projected }, 4096);
  assert.ok(JSON.stringify(compact).length <= 4096);
  assert.equal(objectFields(compact.developmentRevision).planHash, undefined);
  assert.deepEqual(objectFields(objectFields(compact.developmentRevision).historicalPlanningReference).detailSection, "developmentRevision");
  assert.equal(objectFields(objectFields(compact.developmentRevision).historicalPlanningReference).detailPath, "historicalPlanningReference");
  assert.equal(objectFields(objectFields(compact.developmentRevision).historicalPlanningReference).cases, 1);
  assert.equal(objectFields(objectFields(compact.developmentRevision).historicalPlanningReference).current, false);
  assert.equal(objectFields(objectFields(compact.developmentRevision).historicalPlanningReference).plan, undefined);
});

test("正常build在新失败无计划时保留已通过架构显式祖先，不恢复旧预算或接受状态", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-single-planning-lineage-")), prompts:Record<string,unknown>[]=[];
  const agents = new PrototypeAgents({ config: { llmConfigured: true }, cwd: root, dataDir: join(root, "data"),
    sessionFactory: async ({ customTools }) => {
      const tools = fixtureTools(customTools!);
      return { messages: [], subscribe: () => () => {}, abort() {}, dispose() {}, async prompt(text) {
        const payload = JSON.parse(text);
        if (tools.submit_architecture) {
          prompts.push(payload);
          const candidate = payload.previousDesign ? structuredClone(payload.previousDesign) : validDesign(payload.requirements, {
            schemaVersion: 3, profile: "custom", connections: [], interaction: { defaultEntry: "conversation", page: false, operations: true,
              inputs: "用户记录", results: "完整结果", persistentData: "无" }, execution: { language: "javascript", hosting: "builtin", reason: "专用规则" },
            selectionBasis: { capacity: "全部边界", process: "逐条处理", quality: "保留已确认要求", requirementIds: payload.requirements.map((x:{id:string}) => x.id), assumptions: [] } });
          candidate.instructions += " 本轮重新核对。";
          return tools.submit_architecture.execute("design", candidate);
        }
        return tools.submit_architecture_review!.execute("review", passingReview(payload.candidateHash, payload.design, payload.priorFindings));
      } };
    } });
  t.after(async () => { await agents.close(); await rm(root, { recursive: true, force: true }); });
  const runs:Awaited<ReturnType<typeof agents.development.store.create>>[]=[];
  Reflect.set(agents,"executeDevelopment",async (architecture:DevelopmentRevisionArchitecture) => {
    const saved = await agents.development.store.create(run(architecture, `lineage_run_${runs.length + 1}`, runs.length ? null : plan()));
    runs.push(saved); return saved;
  });
  const input = { id: "lineage_agent", name: "单代参考助手", draft: validDraft() };
  await agents.build(input); await agents.build(input);
  const sourceHash = hashValue(await agents.development.store.getRun(runs[0]!.id));
  const result = await agents.build(input), payload = prompts.at(-1);
  assert.equal(result.architecture!.status, "passed");
  assert.equal(objectFields(objectFields(payload!.developmentRevision).source).runId, runs[1]!.id);
  assert.equal(objectFields(objectFields(objectFields(payload!.developmentRevision).historicalPlanningReferenceSummary).source).runId, runs[0]!.id);
  const reference = result.architecture!.developmentRevision;
  assert.equal(objectFields(reference).plan, null); assert.equal(objectFields(objectFields(objectFields(reference).historicalPlanningReference).source).runId, runs[0]!.id);
  assert.equal(objectFields(objectFields(reference).historicalPlanningReference).planHash, objectFields(runs[0]!.pendingPlan).planHash);
  assert.equal(objectFields(objectFields(reference).historicalPlanningReference).sessions, undefined); assert.equal(objectFields(objectFields(reference).historicalPlanningReference).budgets, undefined);
  assert.equal(hashValue(await agents.development.store.getRun(runs[0]!.id)), sourceHash);
  assert.equal(runs[2]!.plan, null); assert.equal(runs[2]!.pendingPlan, null);
});
