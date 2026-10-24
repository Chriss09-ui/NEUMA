import { failureFields } from "./helpers/failure-fields.mjs";
import { fixtureChatRequest, fixtureString } from "./helpers/http-model.mjs";
import type { StageSchema } from "../src/contracts/architecture-stages.mjs";
import { fixtureTools, fixtureDeferred, dispatchModelEvent, listeningAddress, recordArray } from "./helpers/m7-test-boundaries.mjs";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import type { PiSessionOptions, PiSessionPort, SessionFactory, SessionMessage } from "../src/runtime/pi-port.mjs";
import type { ArchitectureOptions, ArchitectureRolePayload } from "../src/architecture/architecture-controller-port.mjs";
import { toolText } from "./helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { Ajv } from "ajv";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchitectureDesigner } from "../src/architecture/architecture.mjs";
import { createPiSession } from "../src/runtime/pi-runtime.mjs";
import { CAPABILITY_CATALOG_VERSION, CAPABILITIES, capabilitySnapshotCompatible, designHash, designSubmissionSchema } from "../src/architecture/architecture-contract.mjs";
import { InputError, ProviderError } from "../src/requirements/core.mjs";
import { validDraft, validDesign, passingReview, withPriorFindingDecisions } from "./helpers/architecture.mjs";
import { WebCapabilities } from "../src/runtime/web-capabilities.mjs";
import { ACCEPTANCE_ADAPTER_GUIDE } from "../src/verification/acceptance-contract.mjs";
import { fidelityChecker } from "./helpers/fidelity.mjs";
import { architectureReviewEvidenceContext } from "../src/architecture/architecture-review-evidence.mjs";
import { architectureStageSubmission } from "./helpers/architecture-stages.mjs";
import type { ArchitectureReview } from "../src/contracts/architecture.mjs";
import type { ArchitectureBase } from "../src/contracts/architecture.mjs";
import type { UnknownRecord } from "../src/contracts/json.mjs";









import type { StoredArchitectureRecord } from "../src/architecture/architecture-controller-port.mjs";



import type { RequirementItem } from "../src/contracts/architecture.mjs";
import type { CandidateDraft } from "../src/contracts/architecture-stages.mjs";


const definition = (id = "weekly") => ({ id, name: "周报助手", draft: validDraft(), fingerprint: "requirements-v1" });
const submissionNames = { designer: "submit_architecture", reviewer: "submit_architecture_review", specialist: "submit_module_design" };

function schemaFields(value: unknown): StageSchema { assert.ok(value && typeof value === "object" && !Array.isArray(value)); return value as StageSchema; }
function moduleSubmission(value: unknown) {
  const fields = objectFields(value); assert.ok(typeof fields.instructions === "string" && Array.isArray(fields.acceptance));
  for (const row of fields.acceptance) assert.ok(row && typeof row === "object" && Array.isArray(row.requirementIds) && row.requirementIds.every((id: unknown) => typeof id === "string"));
  return fields as { instructions: string; acceptance: { requirementIds: string[] }[] };
}
function coverageIssue(value: unknown) {
  const fields = objectFields(value); assert.ok(typeof fields.reason === "string" && Array.isArray(fields.missingReferences) && Array.isArray(fields.allowedReferences));
  for (const id of [...fields.missingReferences, ...fields.allowedReferences]) assert.ok(typeof id === "string");
  return fields as { reason: string; missingReferences: string[]; allowedReferences: string[] };
}
function arrayItems(value: unknown): unknown[] { assert.ok(Array.isArray(value)); return value; }
function moduleFailure(error: unknown) { return recordArray(objectFields(failureFields(error).diagnostic!.delegation).failures)[0]!; }
type FixturePayload = Record<string, unknown> & {
  requirements?: RequirementItem[]; design?: CandidateDraft; candidateHash?: string;
  priorFindings?: Parameters<typeof withPriorFindingDecisions>[1]; reviewContext?: Record<string, unknown>;
  remaining?: { revisions: number; modules: number; searches: number }; evidence?: import("../src/contracts/architecture.mjs").EvidenceItem[];
  issues?: { id: string }[]; modules?: unknown[]; deterministicIssues?: { id: string }[];
  revisionSource?: { version: number; historicalOnly: boolean; issueScope: string; kind: string; moduleCount: number; interruptedVersion?: number; attemptIndex?: number; candidateHash?: string };
};
interface FixtureSessionRecord {
  options: PiSessionOptions; tools: ReturnType<typeof fixtureTools>; role: keyof typeof submissionNames;
  disposed: boolean; aborted: boolean; payload?: FixturePayload; session?: PiSessionPort;
  release?: (() => unknown) | undefined;
}
type FixturePrompt = (context: { record: FixtureSessionRecord; session: PiSessionPort; submit(value: unknown): Promise<unknown>; emit(event: unknown): unknown }) => unknown | Promise<unknown>;
type FixtureOptions = Partial<ArchitectureOptions> & { onPrompt?: FixturePrompt | undefined };

function factory(records: FixtureSessionRecord[], onPrompt?: FixturePrompt): SessionFactory {
  return async (options) => {
    const tools = fixtureTools(options.customTools);
    const role = (Object.keys(submissionNames) as (keyof typeof submissionNames)[]).find((key) => tools[submissionNames[key]]);
    assert.ok(role, "模型会话应有明确的角色提交工具");
    const record: FixtureSessionRecord = { options, tools, role, disposed: false, aborted: false };
    const submit = (value: unknown) => tools[submissionNames[role]]!.execute("fixture-submit", value);
    let listener: Parameters<NonNullable<PiSessionPort["subscribe"]>>[0] | null | undefined;
    const session = {
      messages: [] as SessionMessage[],
      subscribe(fn: Parameters<NonNullable<PiSessionPort["subscribe"]>>[0]) { listener = fn; return () => { listener = null; }; },
      async prompt(message: string) {
        const firstPrompt = record.payload === undefined;
        record.payload = JSON.parse(message);
        if (firstPrompt) assert.equal(options.reasoningMode,
          role === "reviewer" || role === "designer" && record.payload!.editableSubmission
            || role === "specialist" && records.findLast((item) => item.role === "designer")?.options.reasoningMode === "off" ? "off" : "auto");
        if (onPrompt) return onPrompt({ record, session, submit, emit: (event) => dispatchModelEvent(listener, event) });
        if (role === "designer") return submit(validDesign(record.payload!.requirements!));
        if (role === "reviewer") return submit(passingReview(record.payload!.candidateHash!, record.payload!.design));
        throw new Error("测试未请求局部专员");
      },
      async abort() { record.aborted = true; record.release?.(); },
      dispose() { record.disposed = true; },
    };
    record.session = session; records.push(record); return session;
  };
}

async function fixture(t: test.TestContext, options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-architecture-"));
  const sessions: FixtureSessionRecord[] = [];
  const researchCalls: Parameters<NonNullable<ArchitectureOptions["research"]>["search"]>[] = [];
  const config: ArchitectureOptions & { onPrompt?: FixturePrompt | undefined } = { config: { llmConfigured: true }, cwd: root, dataDir: join(root, "data"),
    sessionFactory: factory(sessions, options.onPrompt),
    fidelitySessionFactory: fidelityChecker(),
    research: { async search(...args) { researchCalls.push(args); return { sources: [], gaps: [] }; } },
    ...options };
  delete config.onPrompt;
  const designer = new ArchitectureDesigner(config);
  t.after(async () => { await designer.persistence; await rm(root, { recursive: true, force: true }); });
  return { designer, config, sessions, researchCalls, root };
}

function deferred() { return fixtureDeferred<void>(); }

function currentDesign(requirements: RequirementItem[]) {
  return validDesign(requirements, { schemaVersion: 3, connections: [],
    interaction: { defaultEntry: "conversation" as const, page: false, operations: false, inputs: "工作记录", results: "完整周报", persistentData: "无跨任务持久数据" },
    execution: { language: "none" as const, hosting: "builtin" as const, reason: "使用已有文本能力" },
    selectionBasis: { capacity: "当前明确文本输入", process: "按已确认规则整理", quality: "覆盖全部进展且不编造",
      requirementIds: requirements.map((item) => item.id), assumptions: [] } });
}

function currentReview(candidateHash: string, revise = false, candidate?: Parameters<typeof passingReview>[1], prior?: Parameters<typeof withPriorFindingDecisions>[1]) {
  const value = passingReview(candidateHash, candidate);
  value.checks.push(...["requirement_sufficiency", "acceptance_quality"].filter((id) => !value.checks.some((item) => item.id === id)).map((id) => ({ id, passed: true, evidence: "逐项核对当前需求和验收" })));
  if (revise) {
    value.verdict = "revise";
    value.checks.find((item) => item.id === "verification")!.passed = false;
    value.issues = [{ id: "acceptance_precision", blocking: true, description: "验收仍需明确边界", remedy: "补充当前方案的边界预期",
      checkId: "verification", kind: "design", candidatePaths: ["/acceptance/2/expected"],
      references: [{ source: "candidate", path: "/acceptance/2/expected", quote: "尚未发送" }], factClaims: [] }];
  }
  return withPriorFindingDecisions(value, prior);
}

const historicalModule = (evidenceIds: string[]) => ({ assignment: { question: "核对边界", boundary: "仅本模块", benefit: "避免遗漏" },
  result: { proposal: "按已确认字段核对", interfaces: "固定输入输出", tradeoffs: "采用当前最小方式", evidenceIds, unknowns: [] } });

test("默认只创建两个隔离角色，不搜索或委派；评估通过仍需真实执行定义交付", async (t) => {
  const { designer, sessions, researchCalls, config } = await fixture(t);
  const result = await designer.design(definition());
  assert.equal(result.status, "passed"); assert.equal(result.buildable, true); assert.equal(result.delivery, "blocked");
  assert.equal(result.candidateHash, designHash(result.design));
  assert.equal(result.capabilityCatalogVersion, CAPABILITY_CATALOG_VERSION);
  assert.deepEqual(result.capabilitySnapshot, CAPABILITIES);
  assert.equal(capabilitySnapshotCompatible(result), true);
  assert.deepEqual(sessions.map((item) => item.role), ["designer", "reviewer"]);
  assert.deepEqual(sessions.map((item) => item.options.reasoningMode), ["auto", "off"]);
  assert.doesNotMatch(sessions[1]!.options.systemPrompt!, /当前批保存义务/u);
  assert.deepEqual(sessions.map((item) => item.options.maxOutputTokens), [8192, 4096]);
  assert.notEqual(sessions[0]!.session, sessions[1]!.session);
  assert.deepEqual(sessions[0]!.payload!.candidateSchema, sessions[0]!.tools.submit_architecture!.parameters);
  assert.deepEqual(sessions[1]!.payload!.candidateSchema, sessions[0]!.tools.submit_architecture!.parameters);
  for (const session of sessions) assert.deepEqual(session.payload!.acceptanceAdapterGuide, ACCEPTANCE_ADAPTER_GUIDE);
  assert.deepEqual(Object.keys(sessions[0]!.tools), ["search_technical_sources", "delegate_module", "web_search", "web_fetch", "read_model_context", "request_requirements", "submit_architecture_draft", "revise_architecture_submission", "submit_architecture"]);
  assert.deepEqual(Object.keys(sessions[1]!.tools), ["read_model_context", "request_requirements", "submit_architecture_draft", "revise_architecture_submission", "submit_architecture_review"]);
  assert.deepEqual(researchCalls, []); assert.deepEqual(result.modules, []);
  assert.ok(sessions.every((item) => item.disposed));
  const ready = await designer.markReady(result);
  assert.equal(ready.delivery, "ready");
  const restarted = new ArchitectureDesigner(config);
  assert.deepEqual(await restarted.get("weekly"), await designer.get("weekly"));
});

test("独立评估拒绝时只允许一次带问题的局部修订，耗尽不能自动放行", async (t) => {
  let designs = 0;
  const { designer, sessions } = await fixture(t, { onPrompt: async ({ record, submit }) => {
    if (record.role === "designer") {
      const candidate = validDesign(record.payload!.requirements!);
      candidate.instructions += ` 修订编号 ${designs++}`;
      return submit(candidate);
    }
    const review = passingReview(record.payload!.candidateHash!, record.payload!.design);
    review.verdict = "revise";
    review.checks.find((item) => item.id === "verification")!.passed = false;
    review.issues = [{ id: "acceptance_precision", blocking: true, description: "验收条件还不够明确", remedy: "只补充验收中的具体预期" }];
    review.summary = "需补充验收后重新检查";
    return submit(review);
  } });
  const result = await designer.design(definition());
  assert.equal(result.status, "needs_changes"); assert.equal(result.delivery, "blocked");
  assert.notEqual(result.buildable, true);
  assert.equal(result.attempts.length, 2); assert.equal(sessions.length, 4);
  assert.equal(sessions[0]!.payload!.previousDesign, null);
  assert.deepEqual(sessions[2]!.payload!.previousDesign, result.attempts[0]!.design);
  assert.ok(sessions[2]!.payload!.issues!.some((item: { id: string; }) => item.id === "acceptance_precision"));
  assert.equal(sessions[2]!.payload!.remaining!.revisions, 0);
  assert.equal(sessions[0]!.tools.submit_architecture!.parameters, sessions[2]!.tools.submit_architecture!.parameters,
    "同次build的修订复用同一个提交schema对象");
  assert.deepEqual(sessions[3]!.payload!.candidateSchema, sessions[2]!.tools.submit_architecture!.parameters);
  assert.notEqual(result.attempts[0]!.candidateHash, result.attempts[1]!.candidateHash);
  assert.ok(result.attempts.every((item) => objectFields(item.review).candidateHash === item.candidateHash));
  await assert.rejects(designer.markReady(result), InputError);
});

test("同绑定needs_changes再次构建续接候选与问题，新版本仍从空评审和新预算独立检查", async (t) => {
  let build = 1, designs = 0, previous: StoredArchitectureRecord;
  const { designer, sessions } = await fixture(t, { onPrompt: async ({ record, submit }) => {
    if (record.role === "designer") {
      if (build === 2) {
        assert.deepEqual(record.payload!.previousDesign, previous.design);
        assert.deepEqual(record.payload!.issues, previous.issues);
        assert.equal(record.payload!.revisionSource!.version, previous.version);
        assert.equal(record.payload!.revisionSource!.historicalOnly, true);
        assert.match(record.payload!.revisionSource!.issueScope, /不是新业务要求或授权/);
        assert.equal(record.payload!.remaining!.revisions, 1);
        const current = await designer.get("weekly");
        assert.equal(current!.design, null); assert.equal(current!.candidateHash, null); assert.equal(current!.review, null);
        assert.deepEqual(current!.attempts, []); assert.deepEqual(current!.issues, []);
      }
      const candidate = currentDesign(record.payload!.requirements!); candidate.instructions += ` 候选${++designs}`;
      return submit(candidate);
    }
    if (build === 2) assert.equal(Object.hasOwn(record.payload!, "previousReview"), false);
    return submit(currentReview(record.payload!.candidateHash!, build === 1, record.payload!.design, record.payload!.priorFindings));
  } });
  previous = await designer.design(definition()); assert.equal(previous.status, "needs_changes"); assert.equal(previous.attempts.length, 2);
  const withModule = await designer.getVersion("weekly", previous.version);
  withModule!.modules = [historicalModule([withModule!.evidence[0]!.id])];
  withModule!.researchGaps = ["来源已保存，业务边界仍待验证"];
  await designer.save(withModule!);
  const storedPrevious = await designer.getVersion("weekly", previous.version);
  build = 2;
  const result = await designer.design(definition());
  assert.equal(result.status, "passed"); assert.equal(result.version, previous.version + 1); assert.equal(result.attempts.length, 1);
  assert.equal(result.review!.candidateHash, result.candidateHash); assert.notEqual(result.candidateHash, previous.candidateHash);
  assert.deepEqual(sessions[4]!.payload!.modules, storedPrevious!.modules);
  assert.deepEqual(sessions[4]!.payload!.researchGaps, storedPrevious!.researchGaps);
  assert.equal(sessions[4]!.payload!.revisionSource!.moduleCount, 1);
  assert.deepEqual(await designer.getVersion("weekly", previous.version), storedPrevious);
  assert.deepEqual(sessions.map((item) => item.role), ["designer", "reviewer", "designer", "reviewer", "designer", "reviewer"]);
});

function resealReviewEvidence(metadata: UnknownRecord|undefined) {
  const snapshot = objectFields(metadata!.snapshot);
  const { hash: _hash, ...body } = snapshot;
  snapshot.hash = designHash(body); metadata!.snapshotHash = snapshot.hash;
}

function withEarlierGuide(record: StoredArchitectureRecord|null, { retainExecutionFacts = false } = {}) {
  const guide: { version: number; adapters: Record<string, { executionFacts?: Record<string, unknown>; executionRule?: unknown; [key: string]: unknown }> } = structuredClone(ACCEPTANCE_ADAPTER_GUIDE);
  if (retainExecutionFacts) {
    delete guide.adapters.action!.executionFacts!.dynamicPlaceholders;
    delete guide.adapters.action!.executionFacts!.fixtureConstruction;
    for (const field of ["resultContract", "admissionContract", "expectedEvidence"]) delete guide.adapters["input-contract"]!.executionFacts![field];
  } else for (const adapter of Object.values(guide.adapters)) { delete adapter.executionFacts; delete adapter.executionRule; }
  const context = architectureReviewEvidenceContext({ design: record!.design, requirements: record!.requirements,
    runtimeCapabilities: record!.runtimeCapabilities, evidence: record!.evidence, acceptanceAdapterGuide: guide,
    confirmedRequirementContext: record!.confirmedRequirementContext ?? null, deferredVerifications: record!.deferredVerifications ?? null });
  record!.reviewEvidence!.snapshot = { version: 1, candidateHash: record!.candidateHash, platformHash: record!.platformHash,
    acceptanceAdapterGuide: guide, contextManifest: context.contextManifest };
  resealReviewEvidence(record!.reviewEvidence);
  const reference = { source: "acceptanceAdapterGuide" as const, path: retainExecutionFacts ? "/adapters/action/executionFacts" : "/adapters/action",
    quote: JSON.stringify(retainExecutionFacts ? guide.adapters.action!.executionFacts : guide.adapters.action) };
  record!.review!.issues[0]!.references!.push(reference);
  record!.issues.find((entry) => entry.id === record!.review!.issues[0]!.id)!.references!.push(structuredClone(reference));
  if (retainExecutionFacts) {
    const inputReference = { source: "acceptanceAdapterGuide" as const, path: "/adapters/input-contract/executionFacts",
      quote: JSON.stringify(guide.adapters["input-contract"]!.executionFacts) };
    record!.review!.issues[0]!.references!.push(inputReference);
    record!.issues.find((entry) => entry.id === record!.review!.issues[0]!.id)!.references!.push(structuredClone(inputReference));
  }
  Object.assign(record!.attempts.at(-1)!, { review: structuredClone(record!.review), issues: structuredClone(record!.issues),
    reviewEvidence: structuredClone(record!.reviewEvidence) });
  return record;
}

test("评审前封存精确guide及来源摘要，新添说明字段不破坏历史整对象引文而新候选仍独立评审", async (t) => {
  let first = true, previous: StoredArchitectureRecord|null;
  const { designer, sessions } = await fixture(t, { onPrompt: async ({ record, submit }) => {
    if (record.role === "designer") {
      if (!first) { assert.deepEqual(record.payload!.previousDesign, previous!.design); assert.deepEqual(record.payload!.acceptanceAdapterGuide, ACCEPTANCE_ADAPTER_GUIDE); }
      return submit(currentDesign(record.payload!.requirements!));
    }
    const saved = await designer.get("weekly"), metadata = saved!.reviewEvidence;
    assert.equal(metadata!.version, 2); assert.equal(objectFields(metadata!.snapshot).candidateHash, record.payload!.candidateHash!);
    assert.deepEqual(objectFields(metadata!.snapshot).acceptanceAdapterGuide, record.payload!.acceptanceAdapterGuide);
    assert.deepEqual(objectFields(metadata!.snapshot).contextManifest, record.payload!.contextManifest);
    assert.deepEqual(Object.keys(record.payload!.reviewContext!).sort(), ["candidateHash", "platformHash"]);
    return submit(currentReview(record.payload!.candidateHash!, first, record.payload!.design, record.payload!.priorFindings));
  } });
  await designer.design(definition()); previous = withEarlierGuide(await designer.get("weekly")); await designer.save(previous!);
  const stored = await designer.get("weekly"); previous = stored; first = false;
  assert.notEqual(JSON.stringify(objectFields(objectFields(objectFields(previous!.reviewEvidence!.snapshot).acceptanceAdapterGuide).adapters).action), JSON.stringify(ACCEPTANCE_ADAPTER_GUIDE.adapters.action));
  const result = await designer.design(definition());
  assert.equal(result.status, "passed"); assert.equal(result.revisionSource!.version, previous!.version);
  assert.equal(result.revisionSource!.historicalOnly, true); assert.equal(result.attempts.length, 1);
  assert.deepEqual(objectFields(result.reviewEvidence!.snapshot).acceptanceAdapterGuide, ACCEPTANCE_ADAPTER_GUIDE);
  assert.deepEqual(result.attempts[0]!.reviewEvidence, result.reviewEvidence);
  assert.deepEqual(await designer.getVersion("weekly", previous!.version), stored);
  assert.equal(sessions.filter((item) => item.role === "reviewer").length, 3);
});

test("新增入口输出和fixture事实仍能只读回放旧guide整对象引文，当前两角色收到新同源事实", async (t) => {
  let first = true, previous;
  const { designer, sessions } = await fixture(t, { onPrompt: async ({ record, submit }) => {
    if (record.role === "designer") return submit(currentDesign(record.payload!.requirements!));
    return submit(currentReview(record.payload!.candidateHash!, first, record.payload!.design, record.payload!.priorFindings));
  } });
  await designer.design(definition());
  previous = withEarlierGuide(await designer.get("weekly"), { retainExecutionFacts: true }); await designer.save(previous!);
  const stored = await designer.get("weekly"); first = false;
  const result = await designer.design(definition());
  assert.equal(result.status, "passed"); assert.equal(result.revisionSource!.version, stored!.version);
  assert.equal(result.platformHash, stored!.platformHash); assert.deepEqual(result.runtimeCapabilities, stored!.runtimeCapabilities);
  assert.deepEqual(await designer.getVersion("weekly", stored!.version), stored);
  const roles = sessions.slice(-2);
  assert.deepEqual(roles.map((item) => item.role), ["designer", "reviewer"]);
  assert.deepEqual(roles[0]!.payload!.previousDesign, stored!.design);
  for (const role of roles) {
    assert.deepEqual(role.payload!.acceptanceAdapterGuide, ACCEPTANCE_ADAPTER_GUIDE);
    assert.equal(objectFields(objectFields(objectFields(objectFields(role.payload!.acceptanceAdapterGuide).adapters).action).executionFacts).dynamicPlaceholders, false);
    assert.deepEqual(objectFields(objectFields(objectFields(objectFields(objectFields(role.payload!.acceptanceAdapterGuide).adapters)["input-contract"]).executionFacts).resultContract).value,
      { rejected: true, reason: "input_contract_rejected" });
  }
});

test("历史guide快照的摘要、候选、平台、来源manifest或必需快照损坏均失败关闭", async (t) => {
  for (const mutate of [
    (metadata: UnknownRecord) => { const action = objectFields(objectFields(objectFields(objectFields(metadata.snapshot).acceptanceAdapterGuide).adapters).action); assert.ok(typeof action.proves === "string"); action.proves += " 未经保存的新原文"; },
    (metadata: UnknownRecord) => { objectFields(metadata.snapshot).hash = "0".repeat(64); },
    (metadata: UnknownRecord) => { objectFields(metadata.snapshot).candidateHash = "0".repeat(64); resealReviewEvidence(metadata); },
    (metadata: UnknownRecord) => { objectFields(metadata.snapshot).platformHash = "0".repeat(64); resealReviewEvidence(metadata); },
    (metadata: UnknownRecord) => { objectFields(objectFields(objectFields(metadata.snapshot).contextManifest).acceptanceAdapterGuide).sha256 = "0".repeat(64); resealReviewEvidence(metadata); },
    (metadata: UnknownRecord) => { objectFields(metadata.snapshot).version = 2; resealReviewEvidence(metadata); },
    (metadata: UnknownRecord) => { delete metadata.snapshot; },
  ]) {
    let first = true;
    const { designer, sessions } = await fixture(t, { onPrompt: async ({ record, submit }) => record.role === "designer"
      ? submit(currentDesign(record.payload!.requirements!)) : submit(currentReview(record.payload!.candidateHash!, first, record.payload!.design, record.payload!.priorFindings)) });
    await designer.design(definition()); const broken = await designer.get("weekly"); mutate(broken!.reviewEvidence!);
    broken!.attempts.at(-1)!.reviewEvidence = structuredClone(broken!.reviewEvidence); await designer.save(broken!);
    const before = await designer.get("weekly"); first = false;
    const result = await designer.design(definition()); assert.equal(result.status, "passed");
    assert.equal(sessions.at(-2)!.payload!.previousDesign, null); assert.equal(result.revisionSource, undefined);
    assert.deepEqual(await designer.getVersion("weekly", broken!.version), before);
  }
});

test("旧记录缺快照仅在现有原文仍可核时兼容，不从旧引文逆造guide", async (t) => {
  for (const changedGuide of [false, true]) {
    let first = true;
    const { designer, sessions } = await fixture(t, { onPrompt: async ({ record, submit }) => record.role === "designer"
      ? submit(currentDesign(record.payload!.requirements!)) : submit(currentReview(record.payload!.candidateHash!, first, record.payload!.design, record.payload!.priorFindings)) });
    await designer.design(definition()); const old = await designer.get("weekly"); if (changedGuide) withEarlierGuide(old);
    old!.reviewEvidence = { version: 1, runtimeCapabilityHash: objectFields(old!.runtimeCapabilities).hash };
    for (const attempt of old!.attempts) attempt.reviewEvidence = structuredClone(old!.reviewEvidence);
    await designer.save(old!); const before = await designer.get("weekly"); first = false;
    const result = await designer.design(definition()); assert.equal(result.status, "passed");
    assert.equal(Boolean(sessions.at(-2)!.payload!.previousDesign), !changedGuide);
    assert.deepEqual(await designer.getVersion("weekly", old!.version), before);
  }
});

test("跨构建续接条件任一不符均从空候选开始，旧记录不被修改或当作本轮通过", async (t) => {
  const mutations = [
    (value: StoredArchitectureRecord) => { value.status = "failed"; },
    (value: StoredArchitectureRecord) => { value.sourceFingerprint = "other"; },
    (value: StoredArchitectureRecord) => { value.draft.task.value += " 实际任务变更但伪装相同fingerprint"; },
    (value: StoredArchitectureRecord) => { value.requirements[0]!.text += " 变更"; },
    (value: StoredArchitectureRecord) => { value.platformHash = "0".repeat(64); },
    (value: StoredArchitectureRecord) => { value.contractVersion = 2; },
    (value: StoredArchitectureRecord) => { value.confirmedRequirementContext = { hash: "a".repeat(64), sourceQuotes: [] }; },
    (value: StoredArchitectureRecord) => { value.deferredVerifications = { hash: "b".repeat(64), issues: [] }; },
    (value: StoredArchitectureRecord) => { value.design!.instructions += " 未重算摘要"; },
    (value: StoredArchitectureRecord) => { value.review!.candidateHash = "c".repeat(64); },
    (value: StoredArchitectureRecord) => { value.issues[0]!.description += " 不对应最后评审"; },
    (value: StoredArchitectureRecord) => { value.attempts = []; },
    (value: StoredArchitectureRecord) => { value.modules = [historicalModule(["missing_source"])]; },
    (value: StoredArchitectureRecord) => { value.modules = [historicalModule([value.evidence[0]!.id])]; Reflect.set(value.modules[0]!.assignment, "extra", "未登记字段"); },
    (value: StoredArchitectureRecord) => { value.modules = [historicalModule([value.evidence[0]!.id])]; value.modules[0]!.result.unknowns = [""]; },
    (value: StoredArchitectureRecord) => { Reflect.set(value, "researchGaps", [{ missing: "非字符串" }]); },
    (value: StoredArchitectureRecord) => { value.evidence.push({ id: "unsafe_source", title: "不安全地址", url: "https://user:password@example.com/document",
      versionScope: "历史资料", excerpt: "正文" }); },
    (value: StoredArchitectureRecord) => { value.evidence[0]!.excerpt += " 被修改的平台来源"; },
  ];
  for (const mutate of mutations) {
    let first = true;
    const { designer, sessions } = await fixture(t, { onPrompt: async ({ record, submit }) => {
      if (record.role === "designer") return submit(currentDesign(record.payload!.requirements!));
      return submit(currentReview(record.payload!.candidateHash!, first, record.payload!.design, record.payload!.priorFindings));
    } });
    const previous = await designer.design(definition()); assert.equal(previous.status, "needs_changes");
    const storedPrevious = await designer.getVersion("weekly", previous.version);
    const candidate = structuredClone(previous); mutate(candidate);
    const originalGet = designer.get.bind(designer);
    designer.get = async () => structuredClone(candidate);
    first = false;
    const result = await designer.design(definition()); designer.get = originalGet;
    const next = sessions[4]!.payload;
    assert.equal(next!.previousDesign, null); assert.deepEqual(next!.issues, []); assert.equal(next!.revisionSource, undefined);
    assert.equal(result.revisionSource, undefined); assert.equal(result.attempts.length, 1);
    assert.deepEqual(await designer.getVersion("weekly", previous.version), storedPrevious);
  }
});

test("独立评审正常取消后只读复用当前完整候选，重新独立评审且不重置旧预算", async (t) => {
  let phase = "historical", controller: AbortController, prior, interrupted: StoredArchitectureRecord|null;
  const { designer, sessions } = await fixture(t, { onPrompt: async ({ record, submit }) => {
    if (record.role === "designer") {
      assert.notEqual(phase, "resume", "完整当前候选无需重新设计");
      const candidate = currentDesign(record.payload!.requirements!);
      candidate.instructions += phase === "interrupted" ? " 未完成评审的不同草稿" : " 完整候选";
      return submit(candidate);
    }
    if (phase === "interrupted") { controller.abort(); throw new InputError("测试取消独立评审"); }
    if (phase === "resume") {
      assert.deepEqual(record.payload!.design, interrupted!.design);
      assert.equal(record.payload!.revisionSource!.version, interrupted!.version);
      assert.equal(record.payload!.revisionSource!.kind, "review-continuation");
      assert.equal(record.payload!.revisionSource!.historicalOnly, true);
      const previousCalls = interrupted!.reviewProgressCheckpoint!.modelCalls; assert.ok(typeof previousCalls === "number");
      assert.deepEqual(record.payload!.modelBudget, { limit: 5, used: previousCalls + 1, remaining: 4 - previousCalls });
    }
    return submit(currentReview(record.payload!.candidateHash!, phase === "historical", record.payload!.design, record.payload!.priorFindings));
  } });
  const earliest = await designer.design(definition()); assert.equal(earliest.status, "needs_changes");
  prior = await designer.design(definition()); assert.equal(prior.status, "needs_changes");
  controller = new AbortController(); phase = "interrupted";
  await assert.rejects(designer.design(definition(), { signal: controller.signal }));
  interrupted = await designer.get("weekly");
  assert.equal(interrupted!.status, "cancelled"); assert.equal(interrupted!.review, null);
  assert.equal(interrupted!.diagnostic!.role, "reviewer"); assert.equal(interrupted!.diagnostic!.reason, "cancelled");
  const versions = [earliest.version, prior.version, interrupted!.version];
  const oldRecords = versions.map((version) => JSON.stringify(designer.records.get(`weekly:${version}`)));
  phase = "resume";
  const result = await designer.design(definition());
  assert.equal(result.status, "passed"); assert.equal(result.version, interrupted!.version + 1);
  assert.equal(result.attempts.length, 1); assert.equal(result.review!.candidateHash, result.candidateHash);
  assert.deepEqual(versions.map((version) => JSON.stringify(designer.records.get(`weekly:${version}`))), oldRecords);
  assert.deepEqual(sessions.map((entry) => entry.role), [...Array.from({ length: 5 }, () => ["designer", "reviewer"]).flat(), "reviewer"]);
});

test("中断来源仅限受控独立评审故障，绑定缺失、变化、损坏或已有评审均不回退历史", async (t) => {
  const changes = [
    (record: StoredArchitectureRecord) => { record.diagnostic!.reason = "invalid_result"; record.diagnostic!.modelCalls = 2; },
    (record: StoredArchitectureRecord) => { record.diagnostic!.role = "designer"; },
    (record: StoredArchitectureRecord) => { record.diagnostic!.phase = "designing"; },
    (record: StoredArchitectureRecord) => { record.diagnostic!.stage = "development"; },
    (record: StoredArchitectureRecord) => { record.sourceFingerprint = "changed_requirement"; },
    (record: StoredArchitectureRecord) => { objectFields(record.runtimeCapabilities).hash = "0".repeat(64); },
    (record: StoredArchitectureRecord) => { delete record.runtimeCapabilities; },
    (record: StoredArchitectureRecord) => { record.design!.instructions += " 破坏摘要"; },
    (record: StoredArchitectureRecord) => { Reflect.set(record, "review", currentReview(record.candidateHash!, true, record.design!)); },
  ];
  for (const change of changes) {
    let phase = "historical", controller: AbortController;
    const { designer, sessions } = await fixture(t, { onPrompt: async ({ record, submit }) => {
      if (record.role === "designer") return submit(currentDesign(record.payload!.requirements!));
      if (phase === "interrupted") { controller.abort(); throw new InputError("测试取消独立评审"); }
      return submit(currentReview(record.payload!.candidateHash!, phase === "historical", record.payload!.design, record.payload!.priorFindings));
    } });
    await designer.design(definition()); controller = new AbortController(); phase = "interrupted";
    await assert.rejects(designer.design(definition(), { signal: controller.signal }));
    const interrupted = await designer.get("weekly"), changed = structuredClone(interrupted); change(changed!);
    const originalGet = designer.get.bind(designer); designer.get = async () => structuredClone(changed);
    phase = "resume";
    const result = await designer.design(definition()); designer.get = originalGet;
    const payload = sessions.at(-2)!.payload;
    assert.equal(payload!.previousDesign, null); assert.equal(payload!.revisionSource, undefined);
    assert.equal(result.revisionSource, undefined); assert.equal(result.version, interrupted!.version + 1);
    assert.deepEqual(await designer.getVersion("weekly", interrupted!.version), interrupted);
  }
});

test("受控reviewer中断仅复用当前完整候选，旧版历史评审损坏不代表当前候选通过", async (t) => {
  for (const [reason, corruptHistory] of [["turn_limit", false], ["scope_evaluation_incomplete", false], ["turn_limit", true]] as const) {
    let phase = "historical", controller: AbortController, prior;
    const { designer, sessions } = await fixture(t, { onPrompt: async ({ record, submit }) => {
      if (record.role === "designer") return submit(currentDesign(record.payload!.requirements!));
      if (phase === "interrupted") { controller.abort(); throw new InputError("测试中断"); }
      return submit(currentReview(record.payload!.candidateHash!, phase === "historical", record.payload!.design, record.payload!.priorFindings));
    } });
    prior = await designer.design(definition()); phase = "interrupted"; controller = new AbortController();
    await assert.rejects(designer.design(definition(), { signal: controller.signal }));
    const interrupted = await designer.get("weekly"); interrupted!.status = "failed"; interrupted!.diagnostic!.reason = reason;
    await designer.save(interrupted!);
    if (corruptHistory) {
      const broken = await designer.getVersion("weekly", prior.version); broken!.review!.summary += " 不匹配最后评审";
      await designer.save(broken!);
    }
    const before = [...designer.records.values()].map((record) => JSON.stringify(record));
    phase = "resume"; const result = await designer.design(definition());
    assert.equal(result.status, "passed"); assert.equal(result.version, interrupted!.version + 1);
    const source = sessions.at(-1)!.payload!.revisionSource;
    assert.equal(sessions.at(-1)!.role, "reviewer");
    assert.equal(source!.version, interrupted!.version); assert.equal(source!.interruptedVersion, interrupted!.version);
    assert.equal(source!.kind, "review-continuation");
    assert.deepEqual(result.design, interrupted!.design); assert.notEqual(result.review, null);
    assert.deepEqual([...designer.records.values()].filter((record) => record.version <= interrupted!.version).map((record) => JSON.stringify(record)), before);
  }
});

test("正常无提交技术中断只读续接同版最后完整评审attempt，不采用未评审草稿", async (t) => {
  for (const [role, reason] of [["designer", "invalid_result"], ["reviewer", "invalid_result"], ["reviewer", "submission_incomplete"]] as const) {
    let first = true;
    const { designer, sessions } = await fixture(t, { onPrompt: async ({ record, submit }) => {
      if (record.role === "designer") return submit(currentDesign(record.payload!.requirements!));
      return submit(currentReview(record.payload!.candidateHash!, first, record.payload!.design, record.payload!.priorFindings));
    } });
    const previous = await designer.design(definition()), interrupted = structuredClone(previous);
    interrupted.status = "failed"; interrupted.delivery = "blocked";
    interrupted.diagnostic = { stage: "architecture", role, phase: role === "designer" ? "designing" : "evaluating",
      reason: reason!, modelCalls: reason === "invalid_result" ? 1 : 2, submissionAttempts: 0 };
    const complete = structuredClone(interrupted.attempts.at(-1));
    interrupted.attempts.at(-1)!.modules = [historicalModule(["unreviewed_source"])];
    if (role === "reviewer") {
      interrupted.design!.instructions += " 尚未获得评审的新草稿";
      interrupted.candidateHash = designHash(interrupted.design);
      interrupted.reviewContext = { candidateHash: interrupted.candidateHash, platformHash: interrupted.platformHash };
      interrupted.review = null; interrupted.issues = [];
    }
    await designer.save(interrupted!);
    const before = JSON.stringify(designer.records.get(`weekly:${previous.version}`)); first = false;
    const result = await designer.design(definition()), next = sessions.at(-2)!.payload;
    assert.equal(result.status, "passed"); assert.equal(result.version, previous.version + 1);
    assert.deepEqual(next!.previousDesign, complete!.design); assert.deepEqual(next!.issues, complete!.issues);
    assert.equal(next!.revisionSource!.version, previous.version); assert.equal(next!.revisionSource!.interruptedVersion, previous.version);
    assert.equal(next!.revisionSource!.attemptIndex, previous.attempts.length - 1);
    assert.equal(next!.revisionSource!.candidateHash, complete!.candidateHash);
    assert.equal(JSON.stringify(designer.records.get(`weekly:${previous.version}`)), before);
  }
});

test("新设计会话尚无候选就技术中断时，仅从更早完整needs_changes只读续接", async (t) => {
  let first = true, prior;
  const { designer, sessions } = await fixture(t, { onPrompt: async ({ record, submit }) => {
    if (record.role === "designer") return submit(currentDesign(record.payload!.requirements!));
    return submit(currentReview(record.payload!.candidateHash!, first, record.payload!.design, record.payload!.priorFindings));
  } });
  prior = await designer.design(definition());
  const interrupted = { ...structuredClone(prior), version: prior.version + 1, status: "failed", delivery: "blocked",
    attempts: [], design: null, candidateHash: null, review: null, issues: [],
    diagnostic: { stage: "architecture", role: "designer", phase: "designing", reason: "submission_incomplete", modelCalls: 2, submissionAttempts: 0 } };
  delete interrupted.reviewContext;
  await designer.save(interrupted!);
  const before = [...designer.records.values()].map((record) => JSON.stringify(record)); first = false;
  const result = await designer.design(definition()), payload = sessions.at(-2)!.payload;
  assert.equal(result.status, "passed"); assert.equal(result.version, interrupted.version + 1);
  assert.deepEqual(payload!.previousDesign, prior.design); assert.equal(payload!.revisionSource!.version, prior.version);
  assert.equal(payload!.revisionSource!.interruptedVersion, interrupted.version);
  assert.deepEqual([...designer.records.values()].filter((record) => record.version <= interrupted.version).map((record) => JSON.stringify(record)), before);
});

test("同版已完成attempt的引文或绑定损坏不续接，不借错误分类绕过材料重核", async (t) => {
  for (const mutate of [
    (record: StoredArchitectureRecord) => { record.diagnostic!.phase = "evaluating"; },
    (record: StoredArchitectureRecord) => { record.draft.task.value += " 已改变需求"; },
    (record: StoredArchitectureRecord) => { const review = objectFields(record.attempts.at(-1)!.review); recordArray(recordArray(review.issues)[0]!.references)[0]!.quote = "不存在的引用";
      Reflect.set(record, "review", structuredClone(review)); },
    (record: StoredArchitectureRecord) => { objectFields(record.attempts.at(-1)!.reviewContext).platformHash = "0".repeat(64); },
  ]) {
    let first = true;
    const { designer, sessions } = await fixture(t, { onPrompt: async ({ record, submit }) => {
      if (record.role === "designer") return submit(currentDesign(record.payload!.requirements!));
      return submit(currentReview(record.payload!.candidateHash!, first, record.payload!.design, record.payload!.priorFindings));
    } });
    await designer.design(definition());
    const original = await designer.getVersion("weekly", 1), interrupted = structuredClone(original);
    interrupted!.status = "failed"; interrupted!.diagnostic = { stage: "architecture", role: "designer", phase: "designing",
      reason: "invalid_result", modelCalls: 1, submissionAttempts: 0 };
    interrupted!.attempts = [interrupted!.attempts.at(-1)!];
    mutate(interrupted!);
    const get = designer.get.bind(designer); designer.get = async () => structuredClone(interrupted); first = false;
    await designer.design(definition()); designer.get = get;
    assert.equal(sessions.at(-2)!.payload!.previousDesign, null); assert.equal(sessions.at(-2)!.payload!.revisionSource, undefined);
    assert.deepEqual(await designer.getVersion("weekly", original!.version), original);
  }
});

test("infeasible 和 insufficient 不会重试到通过", async (t) => {
  for (const verdict of ["infeasible", "insufficient"] as const) {
    const { designer, sessions } = await fixture(t, { onPrompt: async ({ record, submit }) => {
      if (record.role === "designer") return submit(validDesign(record.payload!.requirements!));
      const review = passingReview(record.payload!.candidateHash!, record.payload!.design);
      review.verdict = verdict;
      review.checks.find((item) => item.id === "feasibility")!.passed = false;
      review.summary = "能力证据不足，不能确认方案可行";
      return submit(review);
    } });
    const result = await designer.design(definition(verdict));
    assert.equal(result.status, verdict === "infeasible" ? "infeasible" : "needs_evidence");
    assert.equal(result.delivery, "blocked"); assert.equal(sessions.length, 2);
  }
});

test("评估必须绑定本次候选 hash，空证据不能成为通过依据", async (t) => {
  for (const invalid of ["hash", "evidence"]) {
    const { designer, sessions } = await fixture(t, { onPrompt: async ({ record, submit }) => {
      if (record.role === "designer") return submit(validDesign(record.payload!.requirements!));
      const review = passingReview(record.payload!.candidateHash!, record.payload!.design);
      if (invalid === "hash") review.candidateHash = "0".repeat(64);
      else review.checks[0]!.evidence = "  ";
      return submit(review);
    } });
    await assert.rejects(designer.design(definition()), InputError);
    const saved = await designer.get("weekly");
    assert.equal(saved!.status, "failed"); assert.equal(saved!.delivery, "blocked");
    assert.notEqual(saved!.buildable, true); assert.equal(sessions.length, 2);
  }
});

test("技术搜索按需调用，真实来源进入设计、评估与持久化证据", async (t) => {
  const source = { id: "sdk_official", title: "SDK 官方说明", url: "https://pi.dev/docs/latest/sdk",
    versionScope: "滚动文档，版本兼容待核对", excerpt: "隔离会话可使用独立的工具目录。" };
  const queries: unknown[] = [];
  const { designer, sessions } = await fixture(t, {
    research: { async search(query) { queries.push(query); return { sources: [source], gaps: ["版本兼容需单独核对"] }; } },
    onPrompt: async ({ record, submit }) => {
      if (record.role === "designer") {
        const result = await record.tools.search_technical_sources!.execute("search", { query: "Pi SDK 独立工具目录", topics: ["sdk"] });
        assert.deepEqual(JSON.parse(toolText(result)).sources, [source]);
        const candidate = validDesign(record.payload!.requirements!);
        candidate.decisions[0]!.evidenceIds = [source.id];
        return submit(candidate);
      }
      return submit(passingReview(record.payload!.candidateHash!, record.payload!.design));
    },
  });
  const result = await designer.design(definition());
  assert.equal(queries.length, 1);
  assert.deepEqual(result.evidence.find((item) => item.id === source.id), source);
  assert.deepEqual(sessions[1]!.payload!.evidence!.find((item: { id: string; }) => item.id === source.id), source);
  assert.deepEqual(result.researchGaps, ["版本兼容需单独核对"]);
  assert.deepEqual((await designer.get("weekly"))!.evidence, result.evidence);
});

test("公共检索按需产生可引用证据，独立评审仍无联网工具", async (t) => {
  let calls = 0;
  const web = new WebCapabilities({ fetchImpl: async () => {
    calls++; return new Response(JSON.stringify({ results: [{ url: "https://example.com/api", title: "API", content: "接口摘要" }] }), { headers: { "content-type": "application/json" } });
  } });
  const { designer, sessions } = await fixture(t, { web, onPrompt: async ({ record, submit }) => {
    if (record.role === "designer") {
      const result = JSON.parse(toolText((await record.tools.web_search!.execute("search", { query: "official API" }))));
      const candidate = validDesign(record.payload!.requirements!); candidate.decisions[0]!.evidenceIds = [result.results[0].evidenceId];
      return submit(candidate);
    }
    assert.equal(record.tools.web_search, undefined);
    return submit(passingReview(record.payload!.candidateHash!, record.payload!.design));
  } });
  const result = await designer.design(definition());
  assert.equal(calls, 1); assert.equal(result.status, "passed");
  assert.equal(sessions[1]!.payload!.evidence!.at(-1)!.url, "https://example.com/api");
  assert.match(fixtureString(result.evidence.at(-1)!.versionScope), /摘要/);
});

test("搜索为空时不能引用伪造证据；搜索预算最多三次", async (t) => {
  const { designer, researchCalls } = await fixture(t, { onPrompt: async ({ record, submit }) => {
    for (let i = 0; i < 3; i++) await record.tools.search_technical_sources!.execute(`search_${i}`, { query: "SDK" });
    await assert.rejects(record.tools.search_technical_sources!.execute("search_4", { query: "SDK" }), /预算/);
    const candidate = validDesign(record.payload!.requirements!);
    candidate.decisions[0]!.evidenceIds = ["invented_source"];
    return submit(candidate);
  } });
  await assert.rejects(designer.design(definition()), /不存在的 ID/);
  assert.equal(researchCalls.length, 3);
  assert.equal((await designer.get("weekly"))!.status, "failed");
});

test("允许联网时技术检索和网页工具仍共用三次预算，评审保持无联网工具", async (t) => {
  const requests: string[] = [];
  const web = { async search() { requests.push("web_search"); return { status: "ok", results: [] }; },
    async fetch() { requests.push("web_fetch"); return { status: "ok", results: [] }; } };
  const { designer } = await fixture(t, { web, research: { async search() { requests.push("technical"); return { sources: [], gaps: [] }; } },
    onPrompt: async ({ record, submit }) => {
      if (record.role === "reviewer") {
        for (const id of ["search_technical_sources", "web_search", "web_fetch"]) assert.equal(record.tools[id], undefined);
        return submit(passingReview(record.payload!.candidateHash!, record.payload!.design));
      }
      assert.equal(record.payload!.remaining!.searches, 3);
      await record.tools.search_technical_sources!.execute("research", { query: "official API", topics: ["code"] });
      await record.tools.web_search!.execute("search", { query: "official API" });
      await record.tools.web_fetch!.execute("fetch", { url: "https://example.com/docs" });
      await assert.rejects(record.tools.search_technical_sources!.execute("fourth", { query: "official API", topics: ["code"] }), /预算/);
      return submit(validDesign(record.payload!.requirements!));
    } });
  assert.equal((await designer.design(definition())).status, "passed");
  assert.deepEqual(requests, ["technical", "web_search", "web_fetch"]);
});

test("仅按需委派最多三个局部模块，专员没有搜索或递归委派工具", async (t) => {
  const assignments = [{ question: "如何最小化状态", boundary: "只分析本次任务状态", benefit: "防止不必要持久化" },
    { question: "如何验证缺失输入", boundary: "只分析输入失败场景", benefit: "确保失败可解释" },
    { question: "如何核对交付边界", boundary: "只分析已确认输入和结果", benefit: "避免扩大承诺" }];
  const { designer, sessions } = await fixture(t, { onPrompt: async ({ record, submit }) => {
    if (record.role === "specialist") {
      assert.deepEqual(Object.keys(record.tools), ["read_model_context", "submit_architecture_draft", "submit_module_design"]);
      return submit({ proposal: "只保留任务状态", interfaces: "文本输入和摘要输出", tradeoffs: "不保留跨任务状态",
        evidenceIds: [`neuma-runtime-v${record.payload!.platformContractVersion}`], unknowns: [] });
    }
    if (record.role === "designer") {
      const response = await record.tools.delegate_module!.execute("delegate", { modules: assignments });
      const completed = JSON.parse(toolText(response));
      assert.equal(completed.modules.length, 3); assert.equal(completed.remaining, 0); assert.equal(completed.storedModules.length, 3);
      const exhausted = JSON.parse(toolText((await record.tools.delegate_module!.execute("fourth", { modules: [assignments[0]] }))));
      assert.equal(exhausted.status, "quota_exhausted"); assert.equal(exhausted.remaining, 0); assert.equal(exhausted.storedModules.length, 3);
      assert.match(exhausted.next, /复用已有模块结果/);
      return submit(validDesign(record.payload!.requirements!));
    }
    return submit(passingReview(record.payload!.candidateHash!, record.payload!.design));
  } });
  const result = await designer.design(definition());
  assert.equal(result.status, "passed"); assert.equal(result.modules.length, 3);
  assert.equal(sessions.filter((item) => item.role === "specialist").length, 3);
  for (const session of sessions) {
    const prompt = session.options.systemPrompt, submitName = submissionNames[session.role], contract = prompt!.slice(prompt!.lastIndexOf("宿主提交契约："));
    assert.ok(prompt!.includes(`按实际公开工具schema提交${submitName}`));
    assert.doesNotMatch(prompt!, /首次仍用submit_architecture提交完整工具参数/u);
    assert.ok(contract.startsWith(`宿主提交契约：role=${session.role}，submitName=${submitName}；`));
    assert.ok(contract.includes(`实际发起${submitName}的正式tool_call`));
    assert.match(contract, /结构化结果也是本阶段正式提交通道/u);
    if (session.role === "specialist") assert.doesNotMatch(contract, /revise_architecture_submission|request_requirements/u);
    else { assert.match(contract, /revise_architecture_submission/u); assert.match(contract, /request_requirements/u); }
  }
  for (const specialist of sessions.filter((item) => item.role === "specialist")) {
    assert.deepEqual(specialist.payload!.candidateSchema, sessions.find((item) => item.role === "designer")!.tools.submit_architecture!.parameters);
    assert.deepEqual(specialist.payload!.acceptanceAdapterGuide, ACCEPTANCE_ADAPTER_GUIDE);
  }
  assert.ok(sessions.every((item) => item.disposed));
});

test("修订不重置模块额度，额度用尽后不再提供委派工具", async (t) => {
  let designs = 0, reviews = 0;
  const assignment = { question: "核对局部边界", boundary: "仅已有需求", benefit: "避免重复实现" };
  const { designer, sessions } = await fixture(t, { onPrompt: async ({ record, submit }) => {
    if (record.role === "specialist") return submit({ proposal: "复用已核对规则", interfaces: "固定数据结构", tradeoffs: "不增加范围", evidenceIds: [], unknowns: [] });
    if (record.role === "designer") {
      if (designs++ === 0) {
        assert.equal(record.payload!.remaining!.modules, 3);
        await record.tools.delegate_module!.execute("all", { modules: [assignment, assignment, assignment] });
      } else {
        assert.equal(record.payload!.remaining!.modules, 0); assert.equal(record.tools.delegate_module, undefined);
        assert.equal(record.payload!.modules!.length, 3);
      }
      const candidate = currentDesign(record.payload!.requirements!); candidate.instructions += ` 修订${designs}`;
      return submit(candidate);
    }
    return submit(currentReview(record.payload!.candidateHash!, reviews++ === 0, record.payload!.design, record.payload!.priorFindings));
  } });
  const result = await designer.design(definition());
  assert.equal(result.status, "passed"); assert.equal(designs, 2); assert.equal(result.modules.length, 3);
  assert.equal(sessions.filter((item) => item.role === "specialist").length, 3);
});

test("剩余一个模块时修订工具公开单项上限，专员引用错误返回准确安全编号", async (t) => {
  let designs = 0, reviews = 0, corrected = 0;
  const assignment = { question: "核对固定接口", boundary: "仅当前能力", benefit: "核实引用" };
  const progress: UnknownRecord[] = [];
  const { designer, sessions } = await fixture(t, { onPrompt: async ({ record, submit }) => {
    if (record.role === "specialist") {
      const candidate = { proposal: "按已有接口实现", interfaces: "固定输入输出", tradeoffs: "不扩大功能", evidenceIds: ["unknown_source"], unknowns: [] };
      await assert.rejects(submit(candidate), (error) => {
        assert.equal(failureFields(error).validationIssue!.path, "module.evidenceIds"); assert.equal(failureFields(error).validationIssue!.reason, "invalid_reference");
        assert.deepEqual(failureFields(error).validationIssue!.allowedReferences, record.payload!.evidence!.map((item) => item.id));
        assert.doesNotMatch(failureFields(error).message!, /unknown_source/); return true;
      });
      corrected++; return submit({ ...candidate, evidenceIds: [] });
    }
    if (record.role === "designer") {
      const first = designs++ === 0;
      const remaining = first ? 3 : 1;
      assert.equal(record.payload!.remaining!.modules, remaining);
      assert.equal(record.tools.delegate_module!.parameters.properties!.modules!.maxItems, remaining);
      await record.tools.delegate_module!.execute(first ? "pair" : "single", { modules: first ? [assignment, assignment] : [assignment] });
      const candidate = currentDesign(record.payload!.requirements!); candidate.instructions += ` 修订${designs}`;
      return submit(candidate);
    }
    return submit(currentReview(record.payload!.candidateHash!, reviews++ === 0, record.payload!.design, record.payload!.priorFindings));
  } });
  assert.equal((await designer.design(definition(), { onProgress: (event) => progress.push(event) })).status, "passed");
  assert.equal(corrected, 3);
  assert.deepEqual(sessions.filter((item) => item.role === "specialist").map((item) => item.options.reasoningMode), ["auto", "auto", "off"]);
  assert.ok(progress.some((event) => objectFields(event.validationIssue).path === "module.evidenceIds"));
});

test("专员伪造来源会中止本轮，不继续交付", async (t) => {
  const { designer, sessions } = await fixture(t, { onPrompt: async ({ record, submit }) => {
    if (record.role === "specialist") return submit({ proposal: "局部方案", interfaces: "局部接口", tradeoffs: "局部取舍",
      evidenceIds: ["made_up_source"], unknowns: [] });
    return record.tools.delegate_module!.execute("delegate", { modules: [{ question: "接口是否支持", boundary: "只检查接口", benefit: "确认可行性" }] });
  } });
  await assert.rejects(designer.design(definition()), error => failureFields(error).diagnostic!.reason === "module_failed"
    && moduleFailure(error).reason === "invalid_result"
    && objectFields(moduleFailure(error).submissionIssue).path === "module.evidenceIds"
    && objectFields(moduleFailure(error).submissionIssue).reason === "invalid_reference");
  assert.equal((await designer.get("weekly"))!.status, "failed");
  assert.ok(sessions.every((item) => item.disposed));
});

test("模型阶段取消会终止会话、保存 cancelled，不返回交付结果", async (t) => {
  const entered = deferred();
  const controller = new AbortController();
  const { designer, sessions, config } = await fixture(t, { onPrompt: async ({ record }) => {
    const waiting = deferred(); record.release = waiting.resolve;
    entered.resolve!(); await waiting.promise;
  } });
  const promise = designer.design(definition(), { signal: controller.signal });
  await entered.promise; controller.abort();
  await assert.rejects(promise, (error) => error instanceof ProviderError && error.diagnostic.reason === "cancelled");
  const result = await designer.get("weekly");
  assert.equal(result!.status, "cancelled"); assert.equal(result!.delivery, "blocked");
  assert.ok(sessions[0]!.aborted); assert.ok(sessions[0]!.disposed);
  const stored = JSON.parse(await readFile(join(config.dataDir, "agents/weekly/architecture.json"), "utf8"));
  assert.equal(stored.records[0].status, "cancelled");
});

test("最终保存期间取消仍不能返回 passed 或可交付结果", async (t) => {
  const controller = new AbortController();
  const { designer } = await fixture(t);
  const save = designer.save.bind(designer);
  designer.save = async (record) => {
    if (record.status === "passed") controller.abort();
    return save(record);
  };
  await assert.rejects(designer.design(definition(), { signal: controller.signal }),
    (error) => error instanceof ProviderError && error.diagnostic.reason === "cancelled");
  assert.equal((await designer.get("weekly"))!.status, "cancelled");
  assert.equal((await designer.get("weekly"))!.delivery, "blocked");
});

test("重启时在途设计恢复为失败，保留已通过版本的历史", async (t) => {
  const { designer, config } = await fixture(t);
  const passed = await designer.design(definition());
  const interrupted = { ...passed, version: passed.version + 1, status: "evaluating", delivery: "blocked" };
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(join(config.dataDir, "agents/weekly/architecture.json"), JSON.stringify({ version: 1, records: [passed, interrupted] }));
  const restarted = new ArchitectureDesigner(config);
  const result = await restarted.get("weekly");
  assert.equal(result!.status, "failed"); assert.equal(result!.delivery, "blocked");
  assert.match(result!.summary, /中断/);
  assert.equal(restarted.records.get(`weekly:${passed.version}`)!.status, "passed");
});

test("workflow/custom 即使架构通过也不能伪装为当前执行器可运行", async (t) => {
  for (const profile of ["workflow", "custom"]) {
    const { designer } = await fixture(t, { onPrompt: async ({ record, submit }) => {
      if (record.role === "designer") return submit({ ...validDesign(record.payload!.requirements!), profile });
      return submit(passingReview(record.payload!.candidateHash!, record.payload!.design));
    } });
    const result = await designer.design(definition(profile));
    assert.equal(result.status, "passed"); assert.equal(result.buildable, false);
    assert.equal(result.delivery, "needs_development");
    await assert.rejects(designer.markReady(result), InputError);
  }
});

test("后台触发和外部动作的需求事实不能被轻量候选或模型 pass 覆盖", async (t) => {
  for (const mode of ["scheduled", "event", "external_action"] as const) {
    const input = definition(mode);
    if (mode === "external_action") input.draft.externalAction = { mode: "requested", operation: "发送周报",
      target: "指定邮箱", scope: "仅发送本次确认的周报", trigger: "用户明确确认后", source: "user" };
    else input.draft.usage = { mode, detail: mode === "scheduled" ? "每周五九点" : "收到工作记录时", source: "user" };
    const { designer, sessions } = await fixture(t);
    const result = await designer.design(input);
    assert.equal(result.status, "needs_changes"); assert.equal(result.delivery, "blocked");
    assert.notEqual(result.buildable, true);
    assert.ok(result.issues.some((item) => item.id === "unsupported_execution" && item.blocking));
    assert.ok(sessions.filter((item) => item.role === "reviewer").every((item) =>
      item.payload!.deterministicIssues!.some((entry: { id: string; }) => entry.id === "unsupported_execution")));
    assert.equal(sessions.length, 4, "只允许一次局部修订，重复 pass 不能绕过事实门槛");
  }
});

test("设计中的阻断未知项即使被独立评估忽略也不能交付", async (t) => {
  const { designer } = await fixture(t, { onPrompt: async ({ record, submit }) => {
    if (record.role === "designer") return submit(validDesign(record.payload!.requirements!, {
      unknowns: [{ question: "关键输入尚未验证可解析", blocking: true, resolution: "补充代表性输入并验证解析" }],
    }));
    return submit(passingReview(record.payload!.candidateHash!, record.payload!.design));
  } });
  const result = await designer.design(definition());
  assert.equal(result.status, "needs_changes"); assert.equal(result.delivery, "blocked");
  assert.notEqual(result.buildable, true);
  assert.ok(result.issues.some((item) => item.id === "unknown_1" && item.blocking));
});

test("模型与 provider 错误不泄露原始敏感载荷", async (t) => {
  for (const error of [new Error("Bearer private-key-fixture"),
    new ProviderError("upstream raw Bearer private-key-fixture", { stage: "provider", reason: "raw", raw: "private-key-fixture" })]) {
    const progress: UnknownRecord[] = [];
    const { designer } = await fixture(t, { sessionFactory: async () => { throw error; } });
    await assert.rejects(designer.design(definition(), { onProgress: (event) => progress.push(event) }),
      (caught) => caught instanceof ProviderError && !/private-key|Bearer/.test(caught.message + JSON.stringify(caught.diagnostic)));
    assert.doesNotMatch(JSON.stringify(await designer.get("weekly")), /private-key|Bearer/);
    assert.doesNotMatch(JSON.stringify(progress), /private-key|Bearer/);
  }
});

test("当前MiMo架构按角色分配思考输出预算，不自动用满模型上限", async (t) => {
  const { designer, sessions } = await fixture(t);
  designer.config = { llmConfigured: true, chatUrl: "https://api.xiaomimimo.com/v1/chat/completions",
    model: "mimo-v2.6-pro", apiKey: "fixture-only" };
  assert.equal((await designer.design(definition())).status, "passed");
  assert.deepEqual(sessions.map((item) => item.options.maxOutputTokens), [65536, 16384]);
});

test("架构失败保留安全的模型原因、失败阶段和重试数", async (t) => {
  for (const role of ["designer", "reviewer"]) {
    const { designer } = await fixture(t, { onPrompt: async ({ record, session, submit, emit }) => {
      if (record.role !== role) return submit(validDesign(record.payload!.requirements!));
      emit({ type: "auto_retry_start", attempt: 5, errorMessage: "503 Service unavailable Bearer private-key-fixture" });
      emit({ type: "auto_retry_end", success: false, finalError: "503 Service unavailable Bearer private-key-fixture" });
      session.messages!.push({ role: "assistant", stopReason: "error", errorMessage: "503 Service unavailable Bearer private-key-fixture" });
    } });
    await assert.rejects(designer.design(definition()), (error) => {
      assert.equal(failureFields(error).diagnostic!.reason, "api_unavailable");
      assert.equal(failureFields(error).diagnostic!.role, role);
      assert.equal(failureFields(error).diagnostic!.phase, role === "reviewer" ? "evaluating" : "designing");
      assert.equal(failureFields(error).diagnostic!.retries, 5);
      assert.doesNotMatch(failureFields(error).message + JSON.stringify(failureFields(error).diagnostic), /private-key|Bearer/);
      return true;
    });
    const saved = await designer.get("weekly");
    assert.equal(saved!.status, "failed");
    assert.equal(saved!.diagnostic!.reason, "api_unavailable");
    assert.match(saved!.summary, /服务暂时不可用/);
    assert.doesNotMatch(JSON.stringify(saved), /private-key|Bearer/);
  }
});

test("未完成的架构工具参数被截断时不会误报模型连接失败", async (t) => {
  const { designer } = await fixture(t, { onPrompt: async ({ session, emit }) => {
    const truncated = { role: "assistant", stopReason: "length", content: [] };
    session.messages!.push(truncated);
    emit({ type: "message_end", message: truncated });
    session.messages!.push({ role: "assistant", stopReason: "stop", content: [] });
  } });
  await assert.rejects(designer.design(definition()), (error) => error instanceof ProviderError && error.diagnostic.reason === "output_limit");
  const saved = await designer.get("weekly");
  assert.equal(saved!.diagnostic!.phase, "designing");
  assert.match(saved!.summary, /本轮模型输出额度已用完/);
  assert.doesNotMatch(saved!.summary, /连接/);
});

test("角色轮次耗尽显示本阶段预算失败并保留正确原因", async (t) => {
  const { designer, sessions } = await fixture(t, { onPrompt: async ({ emit }) => {
    for (let turn = 0; turn < 13; turn++) emit({ type: "turn_end" });
  } });
  await assert.rejects(designer.design(definition()), (error) => error instanceof ProviderError && error.diagnostic.reason === "turn_limit");
  assert.equal(sessions[0]!.aborted, true);
  assert.equal((await designer.get("weekly"))!.diagnostic!.reason, "turn_limit");
});

test("提交校验失败在轮次耗尽诊断中保留字段原因，不保存候选秘密值", async (t) => {
  const progress: UnknownRecord[] = [], secret = "PRIVATE_PAYLOAD_SENTINEL";
  const { designer } = await fixture(t, { onPrompt: async ({ record, submit, emit }) => {
    const candidate = validDesign(record.payload!.requirements!);
    candidate.instructions = secret; Reflect.deleteProperty(candidate.components[0]!, "inputs");
    await assert.rejects(submit(candidate), InputError);
    for (let turn = 0; turn < 13; turn++) emit({ type: "turn_end" });
  } });
  await assert.rejects(designer.design(definition(), { onProgress: (event) => progress.push(event) }), (error) => {
    assert.equal(failureFields(error).diagnostic!.reason, "turn_limit");
    assert.equal(failureFields(error).diagnostic!.submissionAttempts, 1);
    assert.equal(failureFields(error).diagnostic!.lastSubmissionError, "design.components.[0].inputs: required_field");
    return true;
  });
  assert.deepEqual(progress.find((event) => event.validationIssue)?.validationIssue,
    { path: "design.components.[0].inputs", reason: "required_field" });
  const saved = await designer.get("weekly");
  assert.equal(saved!.diagnostic!.submissionAttempts, 1);
  assert.doesNotMatch(JSON.stringify({ progress, saved }), new RegExp(secret));
});

test("SDK预执行schema拒绝只保留白名单路径原因，忽略参数与其他工具错误", async (t) => {
  const progress: UnknownRecord[] = [], secret = "PRIVATE_PAYLOAD_SENTINEL";
  const { designer } = await fixture(t, { onPrompt: async ({ emit }) => {
    emit({ type: "tool_execution_end", toolName: secret, toolCallId: "other", isError: true,
      result: { content: [{ type: "text", text: `Validation failed for tool "${secret}":\n - instructions: Expected string\nArguments: ${secret}` }] } });
    emit({ type: "tool_execution_start", toolName: "submit_architecture", toolCallId: "submission-one", args: { secret } });
    emit({ type: "tool_execution_end", toolName: "submit_architecture", toolCallId: "submission-one", isError: true,
      result: { content: [{ type: "text", text: `Validation failed for tool "submit_architecture":\n  - components.0.${secret}: Unexpected property ${secret}\n\nReceived arguments:\n{"instructions":"${secret}"}` }] } });
    for (let turn = 0; turn < 13; turn++) emit({ type: "turn_end" });
  } });
  await assert.rejects(designer.design(definition(), { onProgress: (event) => progress.push(event) }), (error) => {
    assert.equal(failureFields(error).diagnostic!.reason, "turn_limit"); assert.equal(failureFields(error).diagnostic!.submissionAttempts, 1);
    assert.equal(failureFields(error).diagnostic!.lastSubmissionError, "components.[0].<field>: unknown_field"); return true;
  });
  assert.equal(progress.filter((event) => event.validationIssue).length, 1);
  assert.doesNotMatch(JSON.stringify({ progress, saved: await designer.get("weekly") }), /PRIVATE_PAYLOAD_SENTINEL|Received arguments|Arguments:/);
});

test("引用错误返回准确字段和允许编号，同一角色可按回执修正且不保留候选正文", async (t) => {
  const progress: UnknownRecord[] = [], secret = "PRIVATE_PAYLOAD_SENTINEL";
  const { designer } = await fixture(t, { onPrompt: async ({ record, submit }) => {
    if (record.role === "reviewer") return submit(passingReview(record.payload!.candidateHash!, record.payload!.design));
    const candidate = validDesign(record.payload!.requirements!), invalid = structuredClone(candidate);
    invalid.instructions = secret; invalid.coverage.push({ ...candidate.coverage[0]!, requirementId: secret });
    await assert.rejects(submit(invalid), (error) => {
      assert.match(failureFields(error).message!, /允许引用的编号：/); assert.doesNotMatch(failureFields(error).message!, new RegExp(secret)); return true;
    });
    await submit(candidate);
  } });
  const result = await designer.design(definition(), { onProgress: (event) => progress.push(event) });
  assert.equal(result.status, "passed");
  assert.deepEqual(progress.find((event) => event.validationIssue)?.validationIssue, {
    path: `design.coverage.[${result.requirements.length}].requirementId`, reason: "invalid_reference", allowedReferences: result.requirements.map((item) => item.id),
  });
  assert.doesNotMatch(JSON.stringify({ progress, result }), new RegExp(secret));
});

test("同路径缺项集合改变时更新安全诊断，相同缺项不重复刷进度", async (t) => {
  const progress: UnknownRecord[] = [];
  const { designer } = await fixture(t, { onPrompt: async ({ record, submit }) => {
    if (record.role === "reviewer") return submit(passingReview(record.payload!.candidateHash!, record.payload!.design));
    const original = validDesign(record.payload!.requirements!);
    for (const missing of [["task", "successCriteria"], ["task", "successCriteria"], ["successCriteria"]]) {
      const value = structuredClone(original);
      for (const item of moduleSubmission(value).acceptance) item.requirementIds = item.requirementIds.filter((id) => !missing.includes(id));
      await assert.rejects(submit(value), (error) => missing.every((id) => failureFields(error).message!.includes(id)));
    }
    return submit(original);
  } });
  assert.equal((await designer.design(definition(), { onProgress: (event) => progress.push(event) })).status, "passed");
  const issues = progress.flatMap((event) => event.validationIssue ? [objectFields(event.validationIssue)] : []);
  assert.equal(issues.length, 2);
  assert.ok(issues.every((issue) => issue.path === "design.acceptance" && issue.reason === "missing_coverage"));
  assert.deepEqual(issues.map((issue) => issue.missingReferences), [["task", "successCriteria"], ["successCriteria"]]);
});

test("真实Pi SDK一次收到全部验收缺项后可一次修正，不靠逐项失败耗尽回合", { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-architecture-coverage-sdk-")), requests: string[] = [], progress: UnknownRecord[] = [], secret = "PRIVATE_INVALID_CANDIDATE";
  const draft = validDraft();
  draft.taskSpec = { version: 1, items: [{ id: "complete", dimension: "processing", content: "完整核对全部记录", applicability: "applies",
    critical: true, source: { kind: "user", evidence: [{ messageId: "source", quote: "完整核对全部记录" }] } }] };
  let missing!: string[]; let candidate: CandidateDraft;
  const model = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = fixtureChatRequest(Buffer.concat(chunks).toString("utf8")), tool = body.tools!.find((item: { function: { name: string; }; }) => ["submit_architecture_blueprint", "submit_architecture_module",
      "submit_architecture_integration", "submit_architecture_review"].includes(item.function.name));
    const roles: Record<string, string> = { submit_architecture_blueprint: "blueprint", submit_architecture_module: "module",
      submit_architecture_integration: "integration", submit_architecture_review: "reviewer" };
    const role = roles[tool!.function.name]!;
    const attempt = requests.filter((value) => value === role).length + 1; requests.push(role);
    const content = body.messages.findLast((message: { role: string; }) => message.role === "user")!.content;
    const payload: FixturePayload = JSON.parse(typeof content === "string" ? content : content!.filter((part) => part.type === "text").map((part) => part.text).join(""));
    let value: ArchitectureBase | ReturnType<typeof passingReview> | NonNullable<ReturnType<typeof architectureStageSubmission>>["args"];
    if (role !== "reviewer") {
      if (role === "blueprint") candidate = validDesign(payload.requirements!, { schemaVersion: 3, connections: [],
        interaction: { defaultEntry: "conversation" as const, page: false, operations: false, inputs: "记录", results: "完整汇总", persistentData: "无" },
        execution: { language: "none" as const, hosting: "builtin" as const, reason: "已有工具即可" },
        selectionBasis: { capacity: "固定测试记录", process: "完整核对", quality: "逐项对应",
          requirementIds: payload.requirements!.map((item) => item.id), assumptions: [] } });
      const submission = architectureStageSubmission({ tools: body.tools!.map((item) => item.function), payload, candidate });
      assert.equal(submission!.name, tool!.function.name); value = submission!.args;
      if (role === "blueprint") missing = ["task", payload.requirements!.find((item: { id: string; }) => item.id.startsWith("spec_"))!.id];
      if (role === "module" && attempt === 1) {
        moduleSubmission(value).instructions = secret;
        for (const item of moduleSubmission(value).acceptance) item.requirementIds = item.requirementIds.filter((id) => !missing.includes(id));
      } else if (role === "module") {
        assert.equal(attempt, 2, "完整缺项回执应允许一次修正");
        const feedback = body.messages.findLast((message: { role: string; }) => message.role === "tool")!.content;
        const text = typeof feedback === "string" ? feedback : JSON.stringify(feedback);
        assert.ok(missing.every((id: string) => text.includes(id)), "工具错误应一次列出全部正式缺项");
        assert.doesNotMatch(text, new RegExp(secret));
      }
    } else {
      const review = passingReview(payload.candidateHash!, payload.design!, payload.priorFindings); value = review;
      review.checks.push(...["requirement_sufficiency", "acceptance_quality"].filter((id) => !review.checks.some((item: { id: string; }) => item.id === id)).map((id) => ({ id, passed: true, evidence: "核对完整需求与验收" })));
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0,
      delta: { role: "assistant", tool_calls: [{ index: 0, id: `${role}_${attempt}`, type: "function", function: { name: tool!.function.name, arguments: JSON.stringify(value) } }] },
      finish_reason: "tool_calls" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const designer = new ArchitectureDesigner({ config: { llmConfigured: true,
    chatUrl: `http://127.0.0.1:${listeningAddress(model).port}/v1/chat/completions`, model: "fixture-model", apiKey: "fixture-only" }, cwd: root, dataDir: root,
    fidelitySessionFactory: fidelityChecker(),
    sessionFactory: async (options) => { const session = await createPiSession(options); session.setAutoCompactionEnabled(false); session.setAutoRetryEnabled(false); return session; } });
  t.after(async () => { await designer.persistence; model.closeAllConnections(); await new Promise<void>((resolve) => model.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const result = await designer.design({ ...definition(), draft }, { onProgress: (event) => progress.push(event) });
  assert.equal(result.status, "passed"); assert.deepEqual(requests, ["blueprint", "module", "module", "integration", "reviewer"]);
  const issue = coverageIssue(progress.find((event) => event.validationIssue)?.validationIssue);
  assert.equal(issue.reason, "missing_coverage"); assert.deepEqual(issue.missingReferences, missing);
  assert.ok(issue.missingReferences.every((id) => issue.allowedReferences.includes(id)));
  assert.doesNotMatch(JSON.stringify({ progress, result }), new RegExp(secret));
});

test("真实Pi评审语义引用拒绝保留路径和修正说明，原会话修正后才进入修订", { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-architecture-review-reference-sdk-")), requests: string[] = [], progress: UnknownRecord[] = [];
  const feedbacks: string[] = [], sessions: string[] = [], invalidQuote = "PRIVATE_INVALID_REVIEW_QUOTE";
  let designs = 0, firstCandidate;
  const model = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = fixtureChatRequest(Buffer.concat(chunks).toString("utf8")), tool = body.tools!.find((item: { function: { name: string; }; }) => ["submit_architecture", "submit_architecture_review"].includes(item.function.name));
      const role = tool!.function.name === "submit_architecture" ? "designer" : "reviewer";
      const content = body.messages.findLast((message: { role: string; }) => message.role === "user")!.content;
      const payload: FixturePayload = JSON.parse(typeof content === "string" ? content : content!.filter((part) => part.type === "text").map((part) => part.text).join(""));
      requests.push(role);
      let value: ArchitectureBase | ReturnType<typeof passingReview> | NonNullable<ReturnType<typeof architectureStageSubmission>>["args"];
      if (role === "designer") {
        value = currentDesign(payload.requirements!);
        value.instructions = ++designs === 1 ? "当前方案需进一步说明完整处理方式。" : "修订方案已说明完整处理方式与检查结果。";
      } else if (designs === 1) {
        firstCandidate ??= payload.candidateHash!;
        assert.equal(payload.candidateHash!, firstCandidate, "格式修正必须保留同一评审对象");
        const attempt = requests.filter((entry: string) => entry === "reviewer").length;
        if (attempt > 1) {
          const feedback = body.messages.findLast((message: { role: string; }) => message.role === "tool")!.content;
          feedbacks.push(typeof feedback === "string" ? feedback : JSON.stringify(feedback));
        }
        value = passingReview(payload.candidateHash!, payload.design!, payload.priorFindings);
        value.verdict = "revise";
        value.checks.find((item) => item.id === "verification")!.passed = false;
        value.issues = [{ id: "clarify_execution", blocking: true, description: "完整处理方式还需补充", remedy: "在现有方案内补充完整处理说明",
          checkId: "verification", kind: "design", candidatePaths: [attempt === 1 ? "/missing_candidate_path" : "/instructions"],
          references: [{ source: "candidate", path: attempt === 2 ? "/missing_reference_path" : "/instructions",
            quote: attempt === 3 ? invalidQuote : payload.design!.instructions }], factClaims: [] }];
      } else value = passingReview(payload.candidateHash!, payload.design!, payload.priorFindings);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0,
        delta: { role: "assistant", tool_calls: [{ index: 0, id: `${role}_${requests.length}`, type: "function", function: { name: tool!.function.name, arguments: JSON.stringify(value) } }] },
        finish_reason: "tool_calls" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    } catch (error) { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: failureFields(error).message } })); }
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const designer = new ArchitectureDesigner({ config: { llmConfigured: true,
    chatUrl: `http://127.0.0.1:${listeningAddress(model).port}/v1/chat/completions`, model: "fixture-model", apiKey: "fixture-only" }, cwd: root, dataDir: join(root, "data"),
    sessionFactory: async (options) => { const session = await createPiSession(options); sessions.push(options.customTools!.at(-1)!.name);
      session.setAutoCompactionEnabled(false); session.setAutoRetryEnabled(false); return session; } });
  t.after(async () => { await designer.ready; await designer.persistence; model.closeAllConnections(); await new Promise<void>((resolve) => model.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const result = await designer.design(definition(), { onProgress: (event) => progress.push(event) });
  assert.equal(result.status, "passed"); assert.equal(result.attempts.length, 2);
  assert.deepEqual(requests, ["designer", "reviewer", "reviewer", "reviewer", "reviewer", "designer", "reviewer"]);
  assert.deepEqual(sessions, ["submit_architecture", "submit_architecture_review", "submit_architecture", "submit_architecture_review"], "引用修正不创建新评审会话");
  assert.match(feedbacks[0]!, /review\.issues\[0\]\.candidatePaths.*候选路径不存在/u);
  assert.match(feedbacks[1]!, /review\.issues\[0\]\.references\[0\].*引用路径不存在/u);
  assert.match(feedbacks[2]!, /review\.issues\[0\]\.references\[0\].*逐字摘录不匹配/u);
  assert.ok(feedbacks.every((text) => !text.includes(invalidQuote) && !text.includes('"valid":true')), "语义拒绝不能变成空的schema成功回执或回显提交内容");
  assert.deepEqual(progress.flatMap((event) => event.validationIssue ? [objectFields(event.validationIssue).reason] : []),
    ["candidate_path_missing", "reference_path_missing", "reference_quote_mismatch"]);
});

test("无代码方案承诺后台操作即使模型评审通过也不能交给研发", async (t) => {
  const { designer } = await fixture(t, { onPrompt: async ({ record, submit }) => {
    if (record.role === "reviewer") {
      const review = passingReview(record.payload!.candidateHash!, record.payload!.design);
      review.checks.push(...["requirement_sufficiency", "acceptance_quality"].filter((id) => !review.checks.some((item) => item.id === id)).map((id) => ({ id, passed: true, evidence: "固定测试评审" })));
      return submit(review);
    }
    return submit(validDesign(record.payload!.requirements!, { schemaVersion: 3,
      interaction: { defaultEntry: "conversation" as const, page: false, operations: true, inputs: "输入", results: "输出", persistentData: "无" },
      connections: [], execution: { language: "none" as const, hosting: "builtin" as const, reason: "声称不需要代码" },
      selectionBasis: { capacity: "固定输入", process: "固定过程", quality: "可核对", requirementIds: record.payload!.requirements!.map((item) => item.id), assumptions: [] },
    }));
  } });
  const result = await designer.design(definition());
  assert.equal(result.status, "needs_changes"); assert.equal(result.delivery, "blocked");
  assert.notEqual(result.buildable, true);
  assert.ok(result.issues.some((item) => item.id === "execution_consistency" && item.blocking && item.source === "program"));
  assert.equal(result.design!.interaction!.operations, true); assert.equal(result.design!.execution!.language, "none");
});

test("真实Pi阶段工具保留完整v3连接与动态schema，不以多轮修格式绕过", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-architecture-v3-sdk-")), requests: string[] = [];
  let submittedSchema: StageSchema, candidate: CandidateDraft;
  const draft = validDraft();
  draft.taskSpec = { version: 1, items: [{ id: "complete", dimension: "processing", content: "完整核对全部记录", applicability: "applies",
    critical: true, source: { kind: "user", evidence: [{ messageId: "source", quote: "完整核对全部记录" }] } }] };
  const model = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = fixtureChatRequest(Buffer.concat(chunks).toString("utf8")), tool = body.tools!.find((item: { function: { name: string; }; }) => ["submit_architecture_blueprint", "submit_architecture_module",
      "submit_architecture_integration", "submit_architecture_review"].includes(item.function.name));
    const roles: Record<string, string> = { submit_architecture_blueprint: "blueprint", submit_architecture_module: "module",
      submit_architecture_integration: "integration", submit_architecture_review: "reviewer" };
    const role = roles[tool!.function.name]!;
    requests.push(role);
    const source = body.messages.findLast((message: { role: string; }) => message.role === "user")!.content;
    const payload: FixturePayload = JSON.parse(typeof source === "string" ? source : source!.filter((part) => part.type === "text").map((part) => part.text).join(""));
    let value: ArchitectureBase | ReturnType<typeof passingReview> | NonNullable<ReturnType<typeof architectureStageSubmission>>["args"];
    if (role !== "reviewer") {
      if (role === "blueprint") {
        submittedSchema = designSubmissionSchema(draft, { requirements: payload.requirements! });
        assert.equal(payload.candidateSchema, undefined, "首包不再重复实际工具已有的结构");
        const globalSchema = schemaFields(schemaFields(Reflect.get(tool!.function, "parameters")).properties!.global);
        assert.ok(globalSchema.required!.includes("execution"));
        assert.ok(globalSchema.required!.includes("selectionBasis"));
        assert.deepEqual(globalSchema.properties!.schemaVersion!.enum, [3]);
        for (const field of ["interaction", "execution", "selectionBasis", "connections"])
          assert.deepEqual(globalSchema.properties![field], submittedSchema.properties![field], "蓝图全局字段沿用完整候选契约");
        candidate = validDesign(payload.requirements!, { schemaVersion: 3, profile: "custom" as const,
        interaction: { defaultEntry: "conversation" as const, page: false, operations: true, inputs: "用户记录", results: "检索结果", persistentData: "无" },
        execution: { language: "javascript" as const, hosting: "managed" as const, reason: "已确认的专属检索逻辑" },
        selectionBasis: { capacity: "固定材料", process: "每条核对", quality: "逐条对应",
          requirementIds: payload.requirements!.map((item) => item.id), assumptions: [] },
        connections: [{ id: "docs", purpose: "business", protocol: "http", required: false, description: "用户授权的检索接口",
          operations: [{ id: "search", method: "POST", path: "/search", readOnly: true,
            inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"], additionalProperties: false },
            outputSchema: { type: "array", items: { type: "string" } }, request: { body: { query: "q" }, encoding: "json" } }] }],
        });
      }
      const submission = architectureStageSubmission({ tools: body.tools!.map((item) => item.function), payload, candidate });
      assert.equal(submission!.name, tool!.function.name); value = submission!.args;
    } else {
      assert.equal(payload.candidateSchema, undefined);
      assert.ok(recordArray(payload.contextIndex).some(item => item.section === "candidateSchema"), "完整契约仍可按需读取");
      const system = body.messages.filter((message: { role: string; }) => ["system", "developer"].includes(message.role))
        .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
      assert.match(system, /本批编号/u);
      assert.match(system, /完整检查后提交真实结论/u);
      assert.ok(arrayItems(objectFields(objectFields(payload.reviewParts).batch).acceptanceScopeChecks).length > 0, "正常构建首包使用宿主派发的真实范围编号");
      const interactionSchema = submittedSchema.properties!.interaction!;
      assert.deepEqual(interactionSchema.required, ["defaultEntry", "page", "operations", "inputs", "results", "persistentData"]);
      assert.equal(interactionSchema.properties!.operations!.type, "boolean");
      assert.equal(interactionSchema.additionalProperties, false);
      const valid = new Ajv({ strict: false }).compile(interactionSchema), interaction = payload.design!.interaction;
      assert.equal(valid(interaction), true);
      assert.equal(valid({ ...interaction, operations: ["检索"] }), false);
      assert.equal(valid({ ...interaction, operationsList: ["检索"] }), false);
      const incomplete = { ...interaction }; delete incomplete.persistentData;
      assert.equal(valid(incomplete), false);
      const review = passingReview(payload.candidateHash!, payload.design!, payload.priorFindings); value = review;
      review.checks.push(...["requirement_sufficiency", "acceptance_quality"].filter((id) => !review.checks.some((item: { id: string; }) => item.id === id)).map((id) => ({ id, passed: true, evidence: "核对正式需求与操作契约" })));
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0,
      delta: { role: "assistant", tool_calls: [{ index: 0, id: `submit_${role}`, type: "function", function: { name: tool!.function.name, arguments: JSON.stringify(value) } }] },
      finish_reason: "tool_calls" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const designer = new ArchitectureDesigner({ config: { llmConfigured: true,
    chatUrl: `http://127.0.0.1:${listeningAddress(model).port}/v1/chat/completions`, model: "fixture-model", apiKey: "fixture-only" }, cwd: root, dataDir: join(root, "data"),
    fidelitySessionFactory: fidelityChecker(),
    sessionFactory: async (options) => { const session = await createPiSession(options); session.setAutoCompactionEnabled(false); session.setAutoRetryEnabled(false); return session; } });
  t.after(async () => { await designer.persistence; model.closeAllConnections(); await new Promise<void>((resolve) => model.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const result = await designer.design({ ...definition(), draft });
  assert.equal(result.status, "passed"); assert.equal(result.delivery, "needs_development");
  assert.deepEqual(requests, ["blueprint", "module", "integration", "reviewer"]);
  assert.equal(objectFields(objectFields(Reflect.get(result.design!.connections![0]!.operations[0]!, "request")).body).query, "q");
});

test("真实 Pi SDK 按架构角色使用输出预算，并识别截断和不完整流", async (t) => {
  for (const outcome of ["complete", "offline", "truncated", "protocol"]) await t.test(outcome, { timeout: 10_000 }, async (child) => {
    const root = await mkdtemp(join(tmpdir(), "neuma-architecture-sdk-"));
    const requests: { role: string; maxTokens: unknown }[] = [], counts = new Map<string, number>(), allocatedBudgets: (number | undefined)[] = [];
    const model = createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = fixtureChatRequest(Buffer.concat(chunks).toString("utf8"));
      if (outcome === "offline") {
        const names = body.tools!.map((tool) => tool!.function.name);
        for (const name of ["search_technical_sources", "web_search", "web_fetch"]) assert.equal(names.includes(name), false);
      }
      const role = body.tools!.some((tool: { function: { name: string; }; }) => tool!.function.name === "submit_architecture") ? "designer" : "reviewer";
      const count = (counts.get(role) ?? 0) + 1; counts.set(role, count);
      requests.push({ role, maxTokens: body.max_tokens });
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: { role?: string; tool_calls?: { index: number; id: string; type: string; function: { name: string; arguments: string; }; }[]; content?: string; }, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk",
        model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (count === 1) {
        const content = body.messages.findLast((message: { role: string; }) => message.role === "user")!.content;
        const payload: FixturePayload = JSON.parse(typeof content === "string" ? content : content!.filter((part) => part.type === "text").map((part) => part.text).join(""));
        const value = role === "designer" ? validDesign(payload.requirements!, {
          instructions: "依据用户本轮材料完成任务，缺少输入先询问，保留可核对结果。".repeat(180),
        }) : passingReview(payload.candidateHash!, payload.design!, payload.priorFindings);
        const args = JSON.stringify(value);
        if (role === "designer") assert.ok(args.length > 4096, "完整多字段候选不能依赖短文本回复预算");
        chunk({ role: "assistant", tool_calls: [{ index: 0, id: `submit_${role}`, type: "function",
          function: { name: role === "designer" ? "submit_architecture" : "submit_architecture_review",
            arguments: outcome === "truncated" ? args.slice(0, 120) : args } }] });
        if (outcome !== "protocol") chunk({}, outcome === "truncated" ? "length" : "tool_calls");
      } else { chunk({ role: "assistant", content: "本阶段提交已结束。" }); chunk({}, "stop"); }
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
    const designer = new ArchitectureDesigner({ config: { llmConfigured: true,
      chatUrl: `http://127.0.0.1:${listeningAddress(model).port}/v1/chat/completions`, model: "fixture-model", apiKey: "fixture-only" },
      cwd: root, dataDir: join(root, "data"),
      sessionFactory: async (options) => {
        allocatedBudgets.push(options.maxOutputTokens);
        const session = await createPiSession(options);
        session.setAutoCompactionEnabled(false); session.setAutoRetryEnabled(false);
        return session;
      } });
    child.after(async () => { await designer.persistence; model.closeAllConnections(); await new Promise<void>((resolve) => model.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
    if (outcome === "complete" || outcome === "offline") {
      const input = definition();
      if (outcome === "offline") input.draft.constraints = [{ text: "禁止联网", source: "user" }];
      assert.equal((await designer.design(input)).status, "passed");
      assert.deepEqual([...counts.keys()], ["designer", "reviewer"]);
      assert.equal(requests.length, 2, "通过校验的阶段提交后无需额外模型回执");
    } else {
      await assert.rejects(designer.design(definition()), (error) => error instanceof ProviderError
        && error.diagnostic.reason === (outcome === "truncated" ? "output_limit" : "api_stream_interrupted"));
      assert.equal((await designer.get("weekly"))!.diagnostic!.phase, "designing");
    }
    assert.deepEqual(allocatedBudgets, [...counts.keys()].map(role => role === "designer" ? 8192 : 4096));
    assert.ok(requests.every((request) => Number.isSafeInteger(request.maxTokens) && typeof request.maxTokens === "number" && request.maxTokens > 0
      && request.maxTokens <= (request.role === "designer" ? 8192 : 4096)), JSON.stringify(requests));
  });
});
