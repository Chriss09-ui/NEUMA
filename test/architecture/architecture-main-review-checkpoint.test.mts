import { architectureReviewEvidenceContext } from "../../src/architecture/architecture-review-evidence.mjs";
import { readArchitectureRejectedFidelityReference } from "../../src/architecture/architecture-fidelity-rejected-reference.mjs";
import { callFixture, recordArray, fixtureToolAt } from "../helpers/m7-test-boundaries.mjs";
import { fixtureString } from "../helpers/http-model.mjs";
import type { SessionMessage } from "../../src/runtime/pi-port.mjs";
interface CheckpointPayload extends Record<string, unknown> {
  requirements?: RequirementItem[]; candidateHash?: string; design?: Parameters<typeof passingReview>[1]; priorFindings?: Parameters<typeof passingReview>[2];
  reviewEvidenceIndex?: { acceptanceScope: { acceptanceId: string; adapterRulePaths: string[] }[] };
  revisionSource?: Record<string, unknown>; modelBudget?: { used: number; limit: number; remaining: number };
  rejectedRequirementFidelitySubmission?: { source: { architectureVersion: number }; trust: string; modelCalls: number; submission: { restrictions: { candidatePath: string }[] }; diagnostic: { valid: boolean } };
  requirementFidelityFeedback?: { evidence: unknown; trust: string };
}
function checkpointPayload(value: unknown): CheckpointPayload { return objectFields(value); }
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import { fixtureTools } from "../helpers/m7-test-boundaries.mjs";
import { failureFields } from "../helpers/failure-fields.mjs";
import { toolText } from "../helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchitectureDesigner } from "../../src/architecture/architecture.mjs";
import { designHash } from "../../src/architecture/architecture-contract.mjs";
import { createMainReviewCheckpoint, readMainReviewCheckpoint } from "../../src/architecture/architecture-main-review-checkpoint.mjs";
import { validDraft, validDesign, passingReview } from "../helpers/architecture.mjs";
import { fidelityResult } from "../helpers/fidelity.mjs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createReviewTaskCheckpoint } from "../../src/runtime/repair-scheduler.mjs";
import { designSubmissionCounts, readDesignSubmissionPolicy } from "../../src/architecture/architecture-design-rejections.mjs";
import { architectureStageSubmission, createArchitectureStageSessionFactory } from "../helpers/architecture-stages.mjs";
import type { RequirementItem } from "../../src/contracts/architecture.mjs";
import type { StoredArchitectureRecord } from "../../src/architecture/architecture-controller-port.mjs";
import type { PiSessionOptions } from "../../src/runtime/pi-port.mjs";

function assertRevisionBase(payload: CheckpointPayload, original: StoredArchitectureRecord|null) {
  assert.equal(payload.baseHash, designHash(payload.baseCandidate));
  const blueprint = objectFields(objectFields(original!.designProgressCheckpoint!.blueprint).result);
  assert.deepEqual(payload.blueprintBoundary, { globalFields: Object.keys(objectFields(blueprint.global)).filter(key => key !== "instructions"),
    modules: blueprint.modules });
  assert.equal(Object.hasOwn(payload, "modules"), false, "整合不重复发送已经拼装的模块正文");
  assert.deepEqual({ ...objectFields(payload.baseCandidate), instructions: original!.design!.instructions }, original!.design,
    "整合仍使用原候选的冻结全局选择和全部模块正文");
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "neuma-main-review-checkpoint-")), calls: { role: string; payload: CheckpointPayload }[] = [], stageCalls: { role: string; payload: CheckpointPayload }[] = [], countsBeforeFidelity: unknown[] = [];
  const state = { fidelity: "interrupt", fidelityPath: "/instructions", acceptanceExpected: "", main: "valid", mainCalls: 1,
    controller: null as AbortController | null, designSuffix: "", interruptDesigner: false, extraIntegrationCalls: 0,
    moduleReads: 0, moduleRejections: 0, moduleTextRejection: false, moduleMalformedText: false, moduleFailures: [] as ("format" | "content")[] };
  const draft = validDraft();
  draft.taskSpec = { version: 1, items: [{ id: "complete", dimension: "processing", content: "完整核对全部记录", applicability: "applies",
    critical: true, source: { kind: "user", evidence: [{ messageId: "source", quote: "完整核对全部记录" }] } }] };
  const definition = { id: "checkpoint", name: "正式主评审阶段检查点", fingerprint: "same-requirements", draft };
  let designer: ArchitectureDesigner;
  const makeCandidate = (payload: CheckpointPayload) => {
    const candidate = validDesign(payload.requirements!, { schemaVersion: 3,
      connections: [], interaction: { defaultEntry: "conversation", page: false, operations: false,
        inputs: "全部记录", results: "完整结果", persistentData: "无" },
      execution: { language: "none", hosting: "builtin", reason: "已有文本能力" },
      selectionBasis: { capacity: "已确认边界", process: "完整处理", quality: "逐项核对",
        requirementIds: payload.requirements!.map((item) => item.id), assumptions: [] } });
    candidate.instructions += state.designSuffix;
    if (state.acceptanceExpected) candidate.acceptance[0]!.expected = state.acceptanceExpected;
    return candidate;
  };
  const stageSessions = createArchitectureStageSessionFactory(makeCandidate, {
    onPrompt: async ({ stage, payload, options, tools }) => {
      stageCalls.push({ role: stage, payload });
      if (stage === "integration") for (let index = 0; index < state.extraIntegrationCalls; index++) await options.onModelCall!();
      if (stage === "module") {
        for (let index = 0; index < state.moduleReads; index++) {
          await tools.read_model_context!.execute(`read_${index}`, { requests: [{ section: "requirements", pointer: "/0" }] });
          await options.onModelCall!();
        }
        const failures = state.moduleFailures.length ? state.moduleFailures : Array.from({ length: state.moduleRejections }, () => "content" as const);
        for (const [index, kind] of failures.entries()) {
          await tools.read_model_context!.execute(`between_${index}`, { requests: [{ section: "requirements", pointer: "/0" }] });
          if (kind === "format") {
            const call = { toolName: "submit_architecture_module", toolCallId: `bad_${index}`, args: {} };
            const feedback = await options.rawInputValidators!.submit_architecture_module!(call);
            assert.equal(feedback.valid, false);
            const output = JSON.parse(toolText(await options.toolErrorResult!(call)));
            assert.equal(output.submissionRecovery, undefined);
            assert.equal(output.formatRecovery.limit, 3);
          } else {
            const submission = architectureStageSubmission({ tools: options.customTools!, payload, candidate: makeCandidate(payload) })!;
            objectFields(recordArray(objectFields(submission.args).steps)[0]).componentId = "missing_component";
            await assert.rejects(tools.submit_architecture_module!.execute(`bad_${index}`, submission.args), error =>
              failureFields(error).validationIssue?.reason === "invalid_reference");
          }
          await options.onModelCall!();
        }
      }
      if (state.interruptDesigner && Number(objectFields(options.sessionStorage!.binding).generation) > 0)
        throw new Error("synthetic interruption before revised stage submission");
    },
  });
  const sessionFactory = async (options: PiSessionOptions) => {
    if ((state.moduleTextRejection || state.moduleMalformedText) && objectFields(options.sessionStorage?.binding).stage === "module") {
      const messages: SessionMessage[] = [];
      let payload: CheckpointPayload;
      return { messages, modelCallAccounting: true, sessionFile: join(options.sessionStorage!.directory, "rejected-text.jsonl"),
        dispose() {}, async abort() {}, async prompt(text: string) {
          await options.onModelCall!();
          const input = checkpointPayload(JSON.parse(text));
          if (input.requirements) payload = input;
          const submission = architectureStageSubmission({ tools: options.customTools!, payload: payload!, candidate: makeCandidate(payload!) })!;
          objectFields(recordArray(objectFields(submission.args).steps)[0]).componentId = "missing_component";
          messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text",
            text: state.moduleMalformedText ? '{"steps": ]}' : JSON.stringify({ submission: { name: submission.name, arguments: submission.args } }) }] });
        } };
    }
    const staged = await stageSessions(options); if (staged) return staged;
    const tools = fixtureTools(options.customTools);
    const role = tools.submit_architecture ? "designer" : "reviewer";
    const session = { messages: [] as SessionMessage[], modelCallAccounting: true, subscribe: () => () => {}, dispose() {}, async abort() {}, async prompt(text: string) {
      const payload = checkpointPayload(JSON.parse(text)); calls.push({ role, payload });
      for (let index = 0; index < (role === "reviewer" ? state.mainCalls : 1); index++) await options.onModelCall!();
      if (role === "designer" && state.interruptDesigner) throw new Error("synthetic interruption before revised candidate submission");
      if (role === "designer") {
        return tools.submit_architecture!.execute("candidate", makeCandidate(payload));
      }
      const review = passingReview(payload.candidateHash!, payload.design, payload.priorFindings);
      review.acceptanceScopeChecks = payload.reviewEvidenceIndex!.acceptanceScope.map((row) => ({ acceptanceId: row.acceptanceId,
        adapterRulePath: row.adapterRulePaths[0]!, sufficient: true, reason: "核对当前冻结执行范围" }));
      if (state.main === "json") {
        session.messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify(review) }] }); return;
      }
      if (state.main === "semantic") {
        review.checks[0]!.passed = false;
        await assert.rejects(tools.submit_architecture_review!.execute("invalid", review));
        session.messages.push({ role: "assistant", stopReason: "stop", content: [] }); return;
      }
      if (state.main === "late-cancel") state.controller!.abort();
      return tools.submit_architecture_review!.execute("formal-review", review);
    } };
    return session;
  };
  const fidelitySessionFactory = async (options: PiSessionOptions) => {
    const native = SessionManager.open(join(options.sessionStorage!.directory, options.sessionStorage!.file!), options.sessionStorage!.directory);
    const messages: SessionMessage[] = native.buildSessionContext().messages;
    const source = messages.filter((message) => message.role === "user").map((message) => {
      try { return JSON.parse(typeof message.content === "string" ? message.content : toolText(message)); } catch { return null; }
    }).find((payload) => payload?.requirements);
    const verdict = ["unproven", "narrowed"].includes(state.fidelity) ? state.fidelity : "preserved";
    const decision = (payload: unknown) => {
      const result = fidelityResult(payload, verdict, { candidatePath: state.fidelityPath });
      if (verdict === "unproven" && state.fidelityPath !== "/instructions")
        result.restrictions = fidelityResult(payload, "narrowed", { candidatePath: state.fidelityPath }).restrictions;
      return result;
    };
    let value = source ? decision(source) : undefined;
    const append = (message: SessionMessage & { timestamp: number }) => { callFixture(native.appendMessage, native, [message]); messages.push(message); };
    const session = { messages, modelCallAccounting: true, setAutoCompactionEnabled() {}, dispose() {}, async abort() {}, async prompt(text: string) {
      append({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
      await options.onModelCall!(); const payload = checkpointPayload(JSON.parse(text)); calls.push({ role: "fidelity", payload });
      const saved = await designer.get(definition.id);
      assert.ok(readMainReviewCheckpoint(saved), "发送复核请求前完整检查点和本次记账必须已保存");
      countsBeforeFidelity.push(saved!.mainReviewCheckpoint!.modelCalls);
      if (payload.requirements) value = decision(payload);
      if (state.fidelity === "cancel") state.controller!.abort();
      if (state.fidelity === "rejected-native") {
        const invalid = fidelityResult(source ?? payload, "narrowed");
        invalid.restrictions[0]!.candidatePath = "acceptance[unknown].expected";
        append({ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "rejected-fidelity", name: "submit_requirement_fidelity", arguments: invalid }], timestamp: Date.now() });
        try { await fixtureToolAt(options.customTools).execute("rejected-fidelity", invalid); }
        catch (error) {
          append({ role: "toolResult", toolCallId: "rejected-fidelity", toolName: "submit_requirement_fidelity", isError: true,
            content: [{ type: "text", text: fixtureString(failureFields(error).message) }], timestamp: Date.now() });
          throw error;
        }
      }
      if (["pass", "pass-cancel", "unproven", "narrowed"].includes(state.fidelity)) {
        append({ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "fidelity", name: "submit_requirement_fidelity", arguments: value }], timestamp: Date.now() });
        const result = await fixtureToolAt(options.customTools).execute("fidelity", value);
        append({ role: "toolResult", toolCallId: "fidelity", toolName: "submit_requirement_fidelity", isError: false, content: result.content, timestamp: Date.now() });
        if (state.fidelity === "pass-cancel") state.controller!.abort();
        return result;
      }
      append({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "复核尚未给出正式判断" }], timestamp: Date.now() });
      if (state.fidelity === "interrupt") throw new Error("synthetic restart after the first fidelity call");
    } };
    return session;
  };
  designer = new ArchitectureDesigner({ config: { llmConfigured: true }, cwd: root, dataDir: join(root, "data"), sessionFactory, fidelitySessionFactory });
  t.after(async () => { await designer.persistence; await rm(root, { recursive: true, force: true }); });
  return { get designer() { return designer; }, state, calls, stageCalls, countsBeforeFidelity, definition,
    reload: async () => {
      await designer.persistence;
      designer = new ArchitectureDesigner({ config: { llmConfigured: true }, cwd: root, dataDir: join(root, "data"), sessionFactory, fidelitySessionFactory });
      await designer.ready;
    },
    run: () => designer.design(definition, { signal: state.controller?.signal }) };
}

async function archivedFailure(f: Awaited<ReturnType<typeof fixture>>) {
  await assert.rejects(f.run());
  const record = (await f.designer.get(f.definition.id))!;
  delete record.reviewRequestPolicy;
  await f.designer.save(record);
  return record;
}

async function archivedRepair(f: Awaited<ReturnType<typeof fixture>>) {
  const record = await archivedFailure(f);
  const context = architectureReviewEvidenceContext({ design: record.design, requirements: record.requirements,
    runtimeCapabilities: record.runtimeCapabilities, evidence: record.evidence,
    confirmedRequirementContext: record.confirmedRequirementContext ?? null, deferredVerifications: record.deferredVerifications ?? null,
    acceptanceAdapterGuide: objectFields(record.reviewEvidence!.snapshot).acceptanceAdapterGuide });
  const feedback = await readArchitectureRejectedFidelityReference(record, context, { cwd: f.designer.cwd,
    directory: await f.designer.storage.directory(record.agentId, "architecture/fidelity") });
  assert.ok(feedback);
  const interrupted = { ...record, contractVersion: 1, version: record.version + 1, design: null, candidateHash: null, attempts: [],
    revisionSource: { kind: "requirement-fidelity-submission-revision", version: record.version, candidateHash: record.candidateHash,
      rejectedFidelitySource: feedback.source, reviewRepair: { candidateHash: record.candidateHash, modelCalls: feedback.modelCalls, reason: "rejected_fidelity_submission" } },
    diagnostic: { stage: "architecture", role: "designer", phase: "designing", reason: "process_interrupted" } };
  // This historical repair had invalidated integration, retaining its earlier real call count.
  const { hash: _hash, ...checkpoint } = record.designProgressCheckpoint!;
  const integration = objectFields(checkpoint.integration);
  const pending = { ...checkpoint, revisionHash: designHash({ candidate: record.design, issues: record.issues }),
    integration: { ...integration, generation: Number(integration.generation) + 1, sessionStartCalls: integration.modelCalls,
      sessionRef: null, result: null, resultHash: null } };
  interrupted.designProgressCheckpoint = { ...pending, hash: designHash(pending) };
  delete interrupted.reviewContext; delete interrupted.reviewEvidence;
  delete interrupted.mainReviewCheckpoint; delete interrupted.reviewProgressCheckpoint; delete interrupted.requirementFidelityProgress;
  await f.designer.save(interrupted);
  return record;
}

test("旧记录第五次请求只有一次正式退回时，在原会话继续范围复核", async t => {
  const f = await fixture(t); f.state.mainCalls = 4; f.state.fidelity = "rejected-native";
  const source = await archivedFailure(f), start = f.calls.length, stages = f.stageCalls.length;
  f.state.fidelity = "pass"; await f.reload();
  const result = await f.run();
  assert.deepEqual(f.calls.slice(start).map(row => row.role), ["fidelity"]);
  assert.equal(f.stageCalls.length, stages); assert.equal(result.status, "passed");
  assert.equal(result.mainReviewCheckpoint!.modelCalls, 6);
  assert.equal(result.candidateHash, source.candidateHash);
  assert.equal(objectFields(result.requirementFidelityProgress!.state).sessionFile, objectFields(source.requirementFidelityProgress!.state).sessionFile);
});

test("已经开始的历史修订可恢复，新候选须重新独立评审与范围复核", async (t) => {
  const f = await fixture(t); f.state.mainCalls = 4; f.state.fidelity = "rejected-native";
  const original = await archivedRepair(f);
  await f.reload(); const start = f.calls.length, stageStart = f.stageCalls.length;
  f.state.mainCalls = 1; f.state.fidelity = "pass"; f.state.designSuffix = "；修正实际技术说明，完整要求保持";
  const result = await f.run();
  assert.deepEqual(f.stageCalls.slice(stageStart).map(({ role }) => role), ["integration"]);
  assert.deepEqual(f.calls.slice(start).map(({ role }) => role), ["reviewer", "fidelity"]);
  assert.equal(result.status, "passed"); assert.notEqual(result.candidateHash, original!.candidateHash);
  assert.equal(result.mainReviewCheckpoint!.modelCalls, 2); assert.equal(result.requirementFidelity!.verdict, "preserved");
});

test("被拒复核触发设计中断后沿原生来源续接，不丢5轮且不退回其他候选", async (t) => {
  const f = await fixture(t); f.state.mainCalls = 4; f.state.fidelity = "rejected-native";
  const original = await archivedRepair(f);
  await f.reload(); f.state.interruptDesigner = true;
  await assert.rejects(f.run()); const interrupted = await f.designer.get(f.definition.id);
  assert.equal(interrupted!.candidateHash, null); assert.equal(interrupted!.revisionSource!.version, original!.version);
  await f.reload(); f.state.interruptDesigner = false; const start = f.calls.length, stageStart = f.stageCalls.length;
  await assert.rejects(f.run(), (error) => failureFields(error).diagnostic!.reason === "review_revision_unchanged");
  assert.deepEqual(f.calls.slice(start).map(({ role }) => role), [], "同候选修订中断不能刷新原评审额度");
  assert.deepEqual(f.stageCalls.slice(stageStart).map(({ role }) => role), ["integration"]);
  assert.equal(f.stageCalls[stageStart]!.payload.rejectedRequirementFidelitySubmission!.source.architectureVersion, original!.version);
  assertRevisionBase(f.stageCalls[stageStart]!.payload, original);
  assert.equal((await f.designer.get(f.definition.id))!.reviewProgressCheckpoint!.modelCalls, 5);
});

test("被拒复核修订已标记时，坏repair不能降级为普通设计刷新原额度", async (t) => {
  const changes = [(record: { revisionSource: Record<string, unknown> }) => { delete record.revisionSource.reviewRepair; },
(    record: { revisionSource: { reviewRepair: { reason: string; }; }; }) => { record.revisionSource.reviewRepair.reason = "unknown_repair"; },
(    record: { revisionSource: { reviewRepair: { modelCalls: number; }; }; }) => { record.revisionSource.reviewRepair.modelCalls = 0; },
(    record: { revisionSource: { reviewRepair: { candidateHash: string; }; }; }) => { record.revisionSource.reviewRepair.candidateHash = "b".repeat(64); },
(    record: { revisionSource: { rejectedFidelitySource: { sessionHash: string; }; }; }) => { record.revisionSource.rejectedFidelitySource.sessionHash = "c".repeat(64); }];
  for (const change of changes) await t.test(change.toString(), async (t) => {
    const f = await fixture(t); f.state.mainCalls = 4; f.state.fidelity = "rejected-native";
    await archivedRepair(f); f.state.interruptDesigner = true;
    await assert.rejects(f.run()); const interrupted = await f.designer.get(f.definition.id);
    callFixture(change, undefined, [interrupted]); await f.designer.save(interrupted!); await f.reload(); const start = f.calls.length, stageStart = f.stageCalls.length;
    f.state.interruptDesigner = false;
    await assert.rejects(f.run(), /被拒复核/u);
    assert.equal(f.calls.length, start, "损坏来源必须在新模型请求前停止");
    assert.equal(f.stageCalls.length, stageStart);
  });
});

test("正式主评审通过宿主验证后复核中断，重启仅续范围复核且累计原预算", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run(), (error) => failureFields(error).diagnostic!.reason === "scope_evaluation_incomplete");
  const source = await f.designer.get(f.definition.id), before = designHash(source);
  assert.equal(source!.review, null); assert.deepEqual<NonNullable<NonNullable<typeof source>>["attempts"]>(source!.attempts, []);
  assert.equal(source!.mainReviewCheckpoint!.modelCalls, 2); assert.equal(source!.mainReviewCheckpoint!.fidelityStatus, "pending");
  assert.ok(recordArray(objectFields(source!.mainReviewCheckpoint!.review).acceptanceScopeChecks).every((row) => row.adapterRulePath && !row.criterionQuote && !row.adapterQuote && !row.scopeReceiptId));
  assert.deepEqual(f.countsBeforeFidelity, [2]);
  await f.reload();
  const calls = f.calls.length, stageCount = f.stageCalls.length; f.state.fidelity = "pass";
  const next = await f.run();
  assert.deepEqual(f.calls.slice(calls).map(({ role }) => role), ["fidelity"]);
  assert.equal(f.stageCalls.length, stageCount, "已完成设计不能因范围复核恢复而重做");
  assert.equal(next.status, "passed"); assert.equal(next.attempts.length, 1); assert.equal(next.mainReviewCheckpoint!.modelCalls, 3);
  assert.equal(next.reviewDiagnostics!.at(-1)!.modelCalls, 3); assert.equal(f.countsBeforeFidelity.at(-1), 3);
  assert.equal(designHash(await f.designer.getVersion(f.definition.id, source!.version)), before);
});

test("结构化JSON通过同一主评审校验，语义错误仍不能保存通过检查点", async (t) => {
  for (const main of ["json", "semantic"]) await t.test(main, async (t) => {
    const f = await fixture(t); f.state.main = main;
    await assert.rejects(f.run());
    const source = await f.designer.get(f.definition.id);
    assert.equal(Boolean(source!.mainReviewCheckpoint), main === "json"); assert.equal(source!.review, null);
    assert.equal(f.calls.filter(({ role }) => role === "fidelity").length, main === "json" ? 1 : 0);
  });
});

test("取消后的迟到提交不保存，取消前已保存检查点可在新显式构建中仅续复核", async (t) => {
  const late = await fixture(t); late.state.controller = new AbortController(); late.state.main = "late-cancel";
  await assert.rejects(late.run()); assert.equal((await late.designer.get(late.definition.id))!.mainReviewCheckpoint, undefined);
  const f = await fixture(t); f.state.controller = new AbortController(); f.state.fidelity = "cancel";
  await assert.rejects(f.run()); const source = await f.designer.get(f.definition.id);
  assert.equal(source!.status, "cancelled"); assert.equal(source!.mainReviewCheckpoint!.modelCalls, 2);
  f.state.controller = null; f.state.fidelity = "pass"; const count = f.calls.length, stageCount = f.stageCalls.length;
  const next = await f.run(); assert.equal(next.status, "passed");
  assert.deepEqual(f.calls.slice(count).map(({ role }) => role), ["fidelity"]); assert.equal(next.mainReviewCheckpoint!.modelCalls, 3);
  assert.equal(f.stageCalls.length, stageCount);
});

test("主评审检查点被篡改时拒绝恢复，保留原记录与用量且不再调用模型", async t => {
  const f = await fixture(t); await assert.rejects(f.run());
  const source = (await f.designer.get(f.definition.id))!;
  objectFields(source.mainReviewCheckpoint!.review).summary += " changed";
  await f.designer.save(source);
  const before = structuredClone(await f.designer.get(f.definition.id)), count = f.calls.length, stageCount = f.stageCalls.length;
  f.state.fidelity = "pass";
  await assert.rejects(f.run(), error => failureFields(error).validationIssue?.reason === "feedback_repair_source_invalid");
  assert.equal(f.calls.length, count); assert.equal(f.stageCalls.length, stageCount);
  assert.deepEqual(await f.designer.get(f.definition.id), before);
});

test("完整但语义无效的检查点或未知中断原因仍须重新主评审", async (t) => {
  for (const kind of ["semantic-checkpoint", "unknown"]) await t.test(kind, async (t) => {
    const f = await fixture(t); await assert.rejects(f.run());
    const source = await f.designer.get(f.definition.id);
    if (kind === "semantic-checkpoint") {
      const invalid = structuredClone(source!.mainReviewCheckpoint!.review); recordArray(objectFields(invalid).checks)[0]!.passed = false;
      source!.mainReviewCheckpoint = createMainReviewCheckpoint(source, invalid, source!.mainReviewCheckpoint!.modelCalls);
      assert.ok(readMainReviewCheckpoint(source), "完整结构和hash本身不代替review语义校验");
    }
    else source!.diagnostic!.reason = "unrecognized_failure";
    await f.designer.save(source!); f.state.fidelity = "pass";
    const count = f.calls.length; assert.equal((await f.run()).status, "passed");
    assert.ok(f.calls.slice(count).some(({ role }) => role === "reviewer"));
  });
});

test("检查点已用五次时恢复只续范围复核", async (t) => {
  const f = await fixture(t); f.state.mainCalls = 3; f.state.fidelity = "text";
  await assert.rejects(f.run()); assert.equal((await f.designer.get(f.definition.id))!.mainReviewCheckpoint!.modelCalls, 5);
  f.state.fidelity = "pass"; const count = f.calls.length, stageCount = f.stageCalls.length;
  const result = await f.run();
  assert.equal(result.status, "passed"); assert.equal(result.mainReviewCheckpoint!.modelCalls, 6);
  assert.deepEqual(f.calls.slice(count).map(row => row.role), ["fidelity"]);
  assert.equal(f.stageCalls.length, stageCount);
});

test("有效范围否定直接给设计者技术修订，新候选仍经过完整独立评审与范围复核", async (t) => {
  for (const verdict of ["unproven", "narrowed"]) await t.test(verdict, async (t) => {
    const f = await fixture(t); await assert.rejects(f.run());
    f.state.fidelity = verdict; const count = f.calls.length;
    await assert.rejects(f.run(), (error) => failureFields(error).diagnostic!.reason === "scope_not_preserved");
    assert.deepEqual(f.calls.slice(count).map(({ role }) => role), ["fidelity"]);
    const rejected = await f.designer.get(f.definition.id), originalHash = designHash(rejected);
    assert.equal(rejected!.review, null); assert.equal(rejected!.mainReviewCheckpoint!.fidelityStatus, "not_preserved");
    assert.equal(rejected!.mainReviewCheckpoint!.modelCalls, 3); assert.equal(objectFields(rejected!.mainReviewCheckpoint!.fidelityEvidence).verdict, verdict);
    f.state.fidelity = "pass"; f.state.designSuffix = "\n按真实平台事实补充完整处理和验收说明。"; const fresh = f.calls.length, stageStart = f.stageCalls.length;
    const next = await f.run(), resumed = f.calls.slice(fresh);
    assert.deepEqual(f.stageCalls.slice(stageStart).map(({ role }) => role), ["integration"]);
    const revisionPayload = f.stageCalls[stageStart]!.payload;
    assert.deepEqual(resumed.map(({ role }) => role), ["reviewer", "fidelity"]);
    assertRevisionBase(revisionPayload, rejected);
    assert.deepEqual(revisionPayload.requirementFidelityFeedback!.evidence, rejected!.mainReviewCheckpoint!.fidelityEvidence);
    assert.equal(revisionPayload.requirementFidelityFeedback!.trust, "untrusted-technical-reference");
    assert.equal(objectFields(next.revisionSource!.reviewRepair).modelCalls, 3); assert.equal(objectFields(next.revisionSource!.reviewRepair).candidateHash, rejected!.candidateHash);
    assert.notEqual(next.candidateHash, rejected!.candidateHash); assert.equal(resumed[0]!.payload.modelBudget!.used, 0);
    assert.equal(next.status, "passed"); assert.equal(next.mainReviewCheckpoint!.modelCalls, 2);
    assert.equal(designHash(await f.designer.getVersion(f.definition.id, rejected!.version)), originalHash);
  });
});

test("范围否定命中已有验收时退回负责模块，修正真实验收后重新完整评审", async t => {
  for (const verdict of ["narrowed", "unproven"]) await t.test(verdict, async t => {
    const f = await fixture(t);
    f.state.fidelity = verdict; f.state.fidelityPath = "/acceptance/0/expected";
    f.state.acceptanceExpected = "拒绝数字写法3.0";
    await assert.rejects(f.run(), error => failureFields(error).diagnostic?.reason === "scope_not_preserved");
    const original = (await f.designer.get(f.definition.id))!, before = structuredClone(original), start = f.stageCalls.length;
    f.state.fidelity = "pass"; f.state.acceptanceExpected = "接受数值为整数的3.0，与3得到相同结果";
    await f.reload();
    const next = await f.run();
    assert.deepEqual(f.stageCalls.slice(start).map(row => row.role), ["module", "integration"]);
    assert.equal(next.design!.acceptance[0]!.expected, f.state.acceptanceExpected);
    assert.equal(next.status, "passed");
    assert.equal(next.requirementFidelity!.verdict, "preserved");
    assert.deepEqual(await f.designer.getVersion(f.definition.id, before.version), before);
    const oldCheckpoint = before.designProgressCheckpoint!, newCheckpoint = next.designProgressCheckpoint!;
    assert.equal(newCheckpoint.pipelineId, oldCheckpoint.pipelineId);
    assert.deepEqual(newCheckpoint.blueprint, oldCheckpoint.blueprint);
    assert.equal(newCheckpoint.modelCalls, Number(oldCheckpoint.modelCalls) + 2);
    assert.equal(objectFields(recordArray(newCheckpoint.modules)[0]).modelCalls,
      Number(objectFields(recordArray(oldCheckpoint.modules)[0]).modelCalls) + 1);
  });
});

test("旧版只改总说明的范围修订停点补派原模块，保留用量并能继续新候选评审", async t => {
  const f = await fixture(t);
  f.state.fidelity = "narrowed"; f.state.fidelityPath = "/acceptance/0/expected";
  f.state.acceptanceExpected = "拒绝数字写法3.0";
  await assert.rejects(f.run());
  const original = (await f.designer.get(f.definition.id))!;
  const staged = f.designer.stagedDesign.bind(f.designer);
  // Reproduce the historical dispatcher through the real stage controller and persistence.
  f.designer.stagedDesign = options => {
    delete options.record.revisionSource!.fidelityRouting;
    const revision = objectFields(options.revision);
    return staged({ ...options, revision: { ...revision,
      issues: recordArray(revision.issues).filter(issue => issue.source !== "requirement-fidelity") } });
  };
  f.state.designSuffix = "\n总说明接受3.0。"; f.state.main = "late-cancel"; f.state.controller = new AbortController();
  await assert.rejects(f.run());
  const legacy = (await f.designer.get(f.definition.id))!;
  assert.notEqual(legacy.candidateHash, original.candidateHash);
  assert.equal(legacy.design!.acceptance[0]!.expected, original.design!.acceptance[0]!.expected);
  assert.deepEqual(legacy.designProgressCheckpoint!.modules, original.designProgressCheckpoint!.modules);
  assert.equal(legacy.revisionSource!.fidelityRouting, undefined);

  const dispatch = createReviewTaskCheckpoint({ candidateHash: legacy.candidateHash }, { slices: { pending: null } },
    [{ id: "pending", owner: "pending", paths: ["/slices/pending"], description: "继续核对原候选", remedy: "保留原会话" }]);
  legacy.reviewDispatchSource = dispatch.bindingHash;
  legacy.reviewDispatchCheckpoint = { version: 1, candidateHash: legacy.candidateHash, bindingHash: dispatch.bindingHash, dispatch };
  await f.designer.save(legacy);
  const legacyHash = designHash(await f.designer.getVersion(f.definition.id, legacy.version));
  await f.reload(); f.state.controller = new AbortController();
  const resumeDesign = f.designer.stagedDesign.bind(f.designer);
  f.designer.stagedDesign = async () => { throw new Error("interrupt before revision starts"); };
  await assert.rejects(f.run());
  const unsubmitted = (await f.designer.get(f.definition.id))!;
  assert.equal(unsubmitted.design, null);
  assert.equal(unsubmitted.reviewDispatchCheckpoint, undefined, "新设计尚未提交时不挂载基底版本的评审");
  assert.deepEqual(unsubmitted.designProgressCheckpoint, legacy.designProgressCheckpoint);
  // Reproduce the old writer's accidental copy without rewriting the base version.
  unsubmitted.reviewDispatchSource = legacy.reviewDispatchSource;
  unsubmitted.reviewDispatchCheckpoint = structuredClone(legacy.reviewDispatchCheckpoint);
  await f.designer.save(unsubmitted); await f.reload();
  assert.equal(objectFields((await f.designer.get(f.definition.id))!.designRecovery).status, "continuing");
  const corrupt = structuredClone(unsubmitted);
  objectFields(corrupt.reviewDispatchCheckpoint).bindingHash = "b".repeat(64);
  await f.designer.save(corrupt); await f.reload();
  const callsBeforeCorruption = f.calls.length;
  await assert.rejects(f.run(), /分组评审进度/);
  assert.equal(f.calls.length, callsBeforeCorruption);
  await f.designer.save(unsubmitted);
  f.designer.stagedDesign = resumeDesign;

  await f.reload(); f.state.controller = new AbortController();
  f.state.acceptanceExpected = "接受数值为整数的3.0，与3得到相同结果";
  const start = f.stageCalls.length;
  await assert.rejects(f.run()); // Interrupt after the corrected candidate, before review completes.
  const corrected = (await f.designer.get(f.definition.id))!;
  assert.deepEqual(f.stageCalls.slice(start).map(row => row.role), ["module", "integration"]);
  assert.equal(corrected.design!.acceptance[0]!.expected, f.state.acceptanceExpected);
  assert.equal(corrected.designProgressCheckpoint!.modelCalls, Number(legacy.designProgressCheckpoint!.modelCalls) + 2);
  assert.equal(designHash(await f.designer.getVersion(f.definition.id, legacy.version)), legacyHash);

  const tampered = structuredClone(corrected);
  objectFields(tampered.revisionSource!.fidelityRouting).baseCandidateHash = "b".repeat(64);
  await f.designer.save(tampered); await f.reload(); f.state.controller = null;
  const callsBeforeInvalidSource = f.calls.length;
  await assert.rejects(f.run(), /原始基底不可恢复/u);
  assert.equal(f.calls.length, callsBeforeInvalidSource);
  await f.designer.save(corrected);
  await f.reload(); f.state.controller = null; f.state.main = "valid"; f.state.fidelity = "pass";
  const stageEnd = f.stageCalls.length;
  const passed = await f.run();
  assert.equal(passed.status, "passed");
  assert.equal(f.stageCalls.length, stageEnd, "已经修正的模块不能在恢复评审时再次派发");
  assert.equal(passed.designProgressCheckpoint!.modelCalls, corrected.designProgressCheckpoint!.modelCalls);
  assert.ok(Number(passed.mainReviewCheckpoint!.modelCalls) > Number(corrected.reviewProgressCheckpoint!.modelCalls));
});

test("设计正式提交前可多次读取，四次退回后可提交，第五次退回停止且重启不清零", async t => {
  for (const rejected of [4, 5]) await t.test(String(rejected), async t => {
    const f = await fixture(t); f.state.fidelity = "pass"; f.state.moduleReads = 6; f.state.moduleRejections = rejected;
    if (rejected === 4) assert.equal((await f.run()).status, "passed");
    else await assert.rejects(f.run(), error => failureFields(error).diagnostic?.reason === "design_repair_stalled");
    const saved = (await f.designer.get(f.definition.id))!, cp = saved.designProgressCheckpoint!;
    assert.deepEqual(designSubmissionCounts(readDesignSubmissionPolicy(cp.submissionPolicy), "core"), { content: rejected, format: 0 });
    assert.equal(objectFields(recordArray(cp.modules)[0]).modelCalls, 11);
    if (rejected === 5) {
      const before = designHash(cp), stageCalls = f.stageCalls.length;
      await f.reload(); f.state.moduleRejections = 0; f.state.moduleReads = 0;
      await assert.rejects(f.run(), /五轮/u);
      assert.equal(f.stageCalls.length, stageCalls);
      assert.equal(designHash((await f.designer.get(f.definition.id))!.designProgressCheckpoint), before);
    }
  });
});

test("五次历史请求不等于五轮退回，范围修订继续实际任务并累计用量", async t => {
  const f = await fixture(t);
  f.state.fidelity = "narrowed"; f.state.fidelityPath = "/acceptance/0/expected"; f.state.extraIntegrationCalls = 4;
  f.state.acceptanceExpected = "拒绝数字写法3.0";
  await assert.rejects(f.run(), error => failureFields(error).diagnostic?.reason === "scope_not_preserved");
  const original = (await f.designer.get(f.definition.id))!, oldCheckpoint = structuredClone(original.designProgressCheckpoint);
  assert.equal(objectFields(oldCheckpoint!.integration).modelCalls, 5);
  f.state.extraIntegrationCalls = 0; f.state.fidelity = "pass";
  f.state.acceptanceExpected = "接受数值为整数的3.0";
  await f.reload();
  const result = await f.run();
  assert.equal(result.status, "passed");
  assert.equal(result.design!.acceptance[0]!.expected, f.state.acceptanceExpected);
  assert.equal(objectFields(result.designProgressCheckpoint!.integration).modelCalls, 6);
  assert.equal(result.designProgressCheckpoint!.modelCalls, Number(oldCheckpoint!.modelCalls) + 2);
  const policy = readDesignSubmissionPolicy(result.designProgressCheckpoint!.submissionPolicy);
  assert.equal(designSubmissionCounts(policy, "core").content, 1, "一批范围负评退回负责模块只算一轮");
  assert.deepEqual(designSubmissionCounts(policy, "integration"), { content: 0, format: 0 }, "正常调用和下游重新整合不算退回");
});

test("完整JSON正文提交被拒也按五轮续交，不在第二轮当成未提交提前停止", async t => {
  const f = await fixture(t); f.state.moduleTextRejection = true;
  await assert.rejects(f.run(), error => failureFields(error).diagnostic?.reason === "design_repair_stalled");
  const checkpoint = (await f.designer.get(f.definition.id))!.designProgressCheckpoint!;
  assert.deepEqual(designSubmissionCounts(readDesignSubmissionPolicy(checkpoint.submissionPolicy), "core"), { content: 5, format: 0 });
  assert.equal(objectFields(recordArray(checkpoint.modules)[0]).modelCalls, 5);
});

test("格式纠错与方案退回分开：正常读取不清格式次数，正文有效后的内容退回开始新的格式纠错", async t => {
  const f = await fixture(t); f.state.fidelity = "pass";
  f.state.moduleFailures = ["content", "format", "format", "content", "format", "format", "content", "content"];
  assert.equal((await f.run()).status, "passed");
  const policy = readDesignSubmissionPolicy((await f.designer.get(f.definition.id))!.designProgressCheckpoint!.submissionPolicy);
  assert.deepEqual(designSubmissionCounts(policy, "core"), { content: 4, format: 0 });
  assert.equal(policy.version, 2);
  if (policy.version === 2) assert.equal(policy.events.core!.filter(row => row.kind === "format").length, 4, "格式错误原记录仍保留");
  const stalled = await fixture(t); stalled.state.moduleFailures = ["content", "format", "format", "format"];
  await assert.rejects(stalled.run(), error => failureFields(error).diagnostic?.reason === "design_format_stalled");
  const stopped = (await stalled.designer.get(stalled.definition.id))!, calls = stalled.stageCalls.length;
  assert.deepEqual(designSubmissionCounts(readDesignSubmissionPolicy(stopped.designProgressCheckpoint!.submissionPolicy), "core"), { content: 1, format: 3 });
  assert.equal(objectFields(stopped.designRecovery).kind, "design_format");
  await stalled.reload(); stalled.state.moduleFailures = [];
  await assert.rejects(stalled.run(), /格式连续三次/);
  assert.equal(stalled.stageCalls.length, calls);
  assert.deepEqual((await stalled.designer.get(stalled.definition.id))!.designProgressCheckpoint, stopped.designProgressCheckpoint);
});

test("无法解析的JSON正文按独立三次格式纠错停止，不扣方案退回次数", async t => {
  const f = await fixture(t); f.state.moduleMalformedText = true;
  await assert.rejects(f.run(), error => failureFields(error).diagnostic?.reason === "design_format_stalled");
  const cp = (await f.designer.get(f.definition.id))!.designProgressCheckpoint!;
  assert.deepEqual(designSubmissionCounts(readDesignSubmissionPolicy(cp.submissionPolicy), "core"), { content: 0, format: 3 });
  assert.equal(objectFields(recordArray(cp.modules)[0]).modelCalls, 3);
});

test("已有有效范围否定的相同候选不能换新评审预算，多次重启仍保留实际spent", async (t) => {
  const f = await fixture(t); f.state.fidelity = "narrowed";
  await assert.rejects(f.run(), (error) => failureFields(error).diagnostic!.reason === "scope_not_preserved");
  const original = await f.designer.get(f.definition.id), spent = original!.mainReviewCheckpoint!.modelCalls;
  f.state.fidelity = "pass";
  for (let retry = 0; retry < 2; retry++) {
    await f.reload(); const count = f.calls.length, stageStart = f.stageCalls.length;
    await assert.rejects(f.run(), (error) => failureFields(error).diagnostic!.reason === "scope_not_preserved" && failureFields(error).diagnostic!.modelCalls === spent);
    assert.deepEqual(f.calls.slice(count).map(({ role }) => role), [], "相同候选不再进入独立评审");
    assert.deepEqual(f.stageCalls.slice(stageStart).map(({ role }) => role), retry === 0 ? ["integration"] : []);
    const next = await f.designer.get(f.definition.id);
    assert.equal(next!.review, null); assert.equal(next!.candidateHash, original!.candidateHash);
    assert.equal(next!.reviewProgressCheckpoint!.modelCalls, spent); assert.equal(next!.revisionSource!.version, original!.version);
  }
});

test("否定后的设计修订中断可沿原来源继续，坏来源不能回退到新评审", async (t) => {
  const f = await fixture(t); f.state.fidelity = "unproven";
  await assert.rejects(f.run()); const original = await f.designer.get(f.definition.id);
  f.state.interruptDesigner = true; await assert.rejects(f.run());
  const interrupted = await f.designer.get(f.definition.id);
  assert.equal(interrupted!.candidateHash, null); assert.equal(interrupted!.revisionSource!.version, original!.version);
  const tampered = structuredClone(interrupted); objectFields(tampered!.revisionSource!.fidelitySource).evidenceHash = "f".repeat(64);
  await f.designer.save(tampered!); await f.reload(); const count = f.calls.length;
  await assert.rejects(f.run(), /原始来源或已用额度无效/u); assert.equal(f.calls.length, count);
  const missing = structuredClone(interrupted); missing!.revisionSource!.version = 9999;
  await f.designer.save(missing!); await f.reload();
  await assert.rejects(f.run(), /原始来源不可恢复/u); assert.equal(f.calls.length, count);
  await f.designer.save(interrupted!); await f.reload(); f.state.interruptDesigner = false;
  f.state.fidelity = "pass"; f.state.designSuffix = "\n依据真实事实修订技术说明，保留全部用户承诺。";
  const next = await f.run(); assert.equal(next.status, "passed"); assert.notEqual(next.candidateHash, original!.candidateHash);
  assert.equal(next.revisionSource!.version, original!.version);
});

test("范围复核中断后可在原会话发出第三次请求", async (t) => {
  const f = await fixture(t); f.state.fidelity = "text";
  await assert.rejects(f.run()); const before = await f.designer.get(f.definition.id);
  assert.equal(objectFields(before!.requirementFidelityProgress!.state).calls, 2); assert.equal(before!.mainReviewCheckpoint!.modelCalls, 3);
  await f.reload(); f.state.fidelity = "pass"; const count = f.calls.length, stageCount = f.stageCalls.length;
  const result = await f.run();
  assert.equal(result.status, "passed"); assert.equal(result.mainReviewCheckpoint!.modelCalls, 4);
  assert.deepEqual(f.calls.slice(count).map(row => row.role), ["fidelity"]);
  assert.equal(objectFields(result.requirementFidelityProgress!.state).sessionFile, objectFields(before!.requirementFidelityProgress!.state).sessionFile);
  assert.equal(f.stageCalls.length, stageCount);
});

test("主预算4与子预算1的真实持久引用重启后只完成原第5次请求", async (t) => {
  const f = await fixture(t); f.state.mainCalls = 3;
  await assert.rejects(f.run()); const saved = await f.designer.get(f.definition.id);
  assert.equal(saved!.mainReviewCheckpoint!.modelCalls, 4); assert.equal(saved!.requirementFidelityProgress!.parentModelCalls, 4);
  assert.equal(objectFields(saved!.requirementFidelityProgress!.state).calls, 1);
  const file = objectFields(saved!.requirementFidelityProgress!.state).sessionFile;
  await f.reload(); f.state.fidelity = "pass"; const count = f.calls.length, stageCount = f.stageCalls.length;
  const result = await f.run();
  assert.deepEqual(f.calls.slice(count).map(({ role }) => role), ["fidelity"]);
  assert.equal(f.stageCalls.length, stageCount);
  assert.equal(result.status, "passed"); assert.equal(result.mainReviewCheckpoint!.modelCalls, 5);
  assert.equal(result.requirementFidelityProgress!.parentModelCalls, 5); assert.equal(objectFields(result.requirementFidelityProgress!.state).calls, 2);
  assert.equal(objectFields(result.requirementFidelityProgress!.state).sessionFile, file);
  assert.equal(f.calls.at(-1)!.payload.remainingModelCalls, undefined); assert.equal(f.calls.at(-1)!.payload.requirements, undefined);
});

test("损坏的范围复核引用不能回退为新的主评审或替代会话", async (t) => {
  const f = await fixture(t); await assert.rejects(f.run());
  const source = await f.designer.get(f.definition.id);
  objectFields(source!.requirementFidelityProgress!.state).sessionFile = "../outside.jsonl";
  await f.designer.save(source!); await f.reload(); const count = f.calls.length, stageCount = f.stageCalls.length;
  await assert.rejects(f.run(), /进度引用无效/u);
  assert.equal(f.calls.length, count);
  assert.equal(f.stageCalls.length, stageCount);
});

test("原第5次复核已有完整原生成功回执时，取消重启只重验结果而不增加请求", async (t) => {
  const f = await fixture(t); f.state.mainCalls = 3;
  await assert.rejects(f.run());
  f.state.fidelity = "pass-cancel"; f.state.controller = new AbortController();
  await assert.rejects(f.run());
  const saved = await f.designer.get(f.definition.id);
  assert.equal(saved!.status, "cancelled"); assert.equal(saved!.review, null);
  assert.equal(saved!.mainReviewCheckpoint!.modelCalls, 5); assert.equal(saved!.mainReviewCheckpoint!.fidelityStatus, "pending");
  assert.equal(objectFields(saved!.requirementFidelityProgress!.state).calls, 2);
  await f.reload(); f.state.controller = null; f.state.fidelity = "pass"; const count = f.calls.length, stageCount = f.stageCalls.length;
  const result = await f.run();
  assert.equal(result.status, "passed"); assert.equal(result.mainReviewCheckpoint!.modelCalls, 5);
  assert.equal(objectFields(result.requirementFidelityProgress!.state).calls, 2); assert.equal(f.calls.length, count);
  assert.equal(f.stageCalls.length, stageCount);
});
