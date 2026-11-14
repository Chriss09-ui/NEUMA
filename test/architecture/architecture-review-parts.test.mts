import {fixtureToolAt,recordArray} from "../helpers/m7-test-boundaries.mjs";
import {fixtureString} from "../helpers/http-model.mjs";
import type {ReviewParts,ArchitectureIssue,ReviewDiagnostic} from "../../src/contracts/architecture.mjs";
type PartController=ReturnType<typeof createArchitectureReviewParts>;
type PartReference=ReturnType<PartController["reference"]>;
interface ModelPayload extends Record<string,unknown> {requirements:RequirementItem[];design:ReturnType<typeof validDesign>;candidateHash:string;priorFindings:NonNullable<Parameters<typeof passingReview>[2]>;reviewParts:PartReference & {saved:ReviewParts;rejectedDraft:ReviewParts}}
import { architectureToolValidation } from "../../src/architecture/architecture-tool-diagnostics.mjs";
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
import { designHash, reviewSubmissionSchema, validateReview } from "../../src/architecture/architecture-contract.mjs";
import { legacyReviewSchema, architectureReviewEvidenceContext } from "../../src/architecture/architecture-review-evidence.mjs";
import { createArchitectureEvidenceReader } from "../../src/architecture/architecture-evidence-reader.mjs";
import { createArchitectureReviewParts, canonicalArchitectureReviewParts } from "../../src/architecture/architecture-review-parts.mjs";
import { runArchitectureReviewDispatch, revalidateArchitectureReviewDispatch, shouldDistributeArchitectureReview, architectureReviewDispatchRecovery } from "../../src/architecture/architecture-review-dispatch.mjs";
import { nextReviewRejection } from "../../src/architecture/architecture-review-protocol.mjs";
import { validateArchitecturePriorFindings } from "../../src/architecture/architecture-prior-findings.mjs";
import type { SessionMessage } from "../../src/runtime/execution-port.mjs";
import type { ReviewSliceRole, ReviewDispatchCheckpoint } from "../../src/architecture/architecture-review-dispatch.mjs";
import { createReviewProgressCheckpoint, readReviewProgressCheckpoint, reviewProgressCheckpointMatches,
  advanceReviewProgressCheckpoint } from "../../src/architecture/architecture-review-progress.mjs";
import { validDraft, validDesign, passingReview } from "../helpers/architecture.mjs";
import { fidelityResult } from "../helpers/fidelity.mjs";
import { createArchitectureStageSessionFactory } from "../helpers/architecture-stages.mjs";
import type { RequirementItem } from "../../src/contracts/architecture.mjs";
import type { PiSessionOptions } from "../../src/runtime/pi-port.mjs";

function material() {
  const requirements = [{ id: "R1", text: "逐项检查完整记录" }];
  const design = validDesign(requirements, { schemaVersion: 3, connections: [],
    interaction: { defaultEntry: "conversation", page: false, operations: false, inputs: "完整记录", results: "完整结果", persistentData: "无" },
    execution: { language: "none", hosting: "builtin", reason: "使用已有文本能力" },
    selectionBasis: { capacity: "核对全部输入", process: "完整处理", quality: "逐项检查", requirementIds: ["R1"], assumptions: [] } });
  const candidateHash = designHash(design), context = architectureReviewEvidenceContext({ design, requirements, runtimeCapabilities: {} });
  const schema = reviewSubmissionSchema({ evidenceRequired: true }), reader = createArchitectureEvidenceReader({ context, candidateHash, role: "reviewer" });
  const options = { schema, toolSchema: reader.submissionSchema(schema), candidateHash, context, resolve: reader.resolveSubmission };
  return { design, candidateHash, context, schema, reader, options, review: passingReview(candidateHash, design) };
}

async function pausedMixedScope() {
  const f = material(), record: Record<string, unknown> = { candidateHash: f.candidateHash, status: "failed" };
  const native: SessionMessage[] = [], requests: string[] = [], model = "fixture-model";
  const raw = (node: ReviewSliceRole) => ({ summary: "本组已核对", issues: [], [node.assignment.field]: node.assignment.field === "checks"
    ? f.review.checks.filter(row => node.assignment.ids.includes(row.id))
    : f.review.acceptanceScopeChecks!.filter(row => node.assignment.ids.includes(String(objectFields(row).acceptanceId)))
      .map(row => ({ ...row, adapterRulePath: `/adapters/${objectFields(row).adapterId}/proves` })) });
  const runRole = async (node: ReviewSliceRole) => {
    requests.push(node.worker.group.id);
    await node.worker.onSession(node.worker.group.sessionFile ?? `${node.assignment.id}.jsonl`); await node.worker.onCall();
    const result = node.validate(raw(node));
    await node.worker.submit({ baseHash: node.worker.baseHash, issueIds: node.worker.group.issueIds, summary: result.summary,
      updates: [{ path: node.worker.group.paths[0]!, value: result }] });
  };
  const options = { record, candidateHash: f.candidateHash, platformHash: "a".repeat(64), context: f.context, schema: f.schema,
    model, save: async (_value: ReviewDispatchCheckpoint) => {}, runRole };
  await assert.rejects(runArchitectureReviewDispatch({ ...options, runRole: async node => {
    if (node.assignment.field === "checks" && node.assignment.ids.includes("acceptance_quality")) {
      await node.worker.onSession(`${node.assignment.id}.jsonl`); await node.worker.onCall(); throw new Error("其他组连接中断");
    }
    if (node.assignment.field !== "acceptanceScopeChecks") return runRole(node);
    await node.worker.onSession(`${node.assignment.id}.jsonl`);
    const args = raw(node), feedback = architectureToolValidation(args, node.previousParameters, { root: "review_slice" });
    assert.equal(feedback.valid, false, "原互斥契约确实拒绝混合写法");
    let rejection = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await node.worker.onCall();
      rejection = nextReviewRejection(rejection, designHash({ model, schema: node.previousParameters }), feedback.issues);
      await node.worker.onRejection!(rejection);
      const id = `scope_${attempt}`;
      native.push({ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name: "submit_architecture_review_slice", arguments: structuredClone(args) }] },
        { role: "toolResult", toolCallId: id, toolName: "submit_architecture_review_slice", isError: true,
          content: [{ type: "text", text: JSON.stringify({ ...feedback, formatRecovery: { category: "format", attempt, limit: 3, retry: attempt < 3 } }) }] });
    }
    native.push({ role: "assistant", stopReason: "error", usage: { output: 0 }, content: [] });
    throw new Error("原格式三次停点");
  } }));
  const checkpoint = structuredClone(record.reviewDispatchCheckpoint) as ReviewDispatchCheckpoint;
  const stopped = checkpoint.dispatch.groups.find(group => group.rejection?.count === 3)!;
  const readHistory: Parameters<typeof revalidateArchitectureReviewDispatch>[0]["readHistory"] = async input => {
    assert.equal(input.group.sessionFile, stopped.sessionFile); assert.equal(input.baseHash, stopped.inputHash);
    assert.equal(input.dispatchHash, checkpoint.bindingHash);
    return { entries: native.map((message, i) => ({ type: "message" as const, id: `m${i}`, message })),
      sessionHash: designHash(native), bindingHash: designHash({ file: input.group.sessionFile, baseHash: input.baseHash }), leafId: "last" };
  };
  return { ...f, options, record, checkpoint, stopped, native, requests, readHistory };
}

test("格式兼容重验原会话末稿，原子接收且保留三次退回、已收结果和未完成组会话", async () => {
  const f = await pausedMixedScope(), oldRecord = structuredClone(f.record), native = structuredClone(f.native), calls = f.requests.length;
  const replay = await revalidateArchitectureReviewDispatch({ ...f.options, readHistory: f.readHistory });
  assert.ok(replay); assert.deepEqual(f.record, oldRecord); assert.deepEqual(f.native, native);
  const recovered = replay.dispatch.groups.find(group => group.id === f.stopped.id)!;
  assert.ok(recovered.result); assert.deepEqual(recovered.rejection, f.stopped.rejection); assert.equal(recovered.calls, f.stopped.calls);
  assert.equal(recovered.submissionReplay!.sourceCheckpointHash, f.checkpoint.dispatch.hash);
  assert.equal(recovered.submissionReplay!.toolCallId, "scope_3");
  await assert.rejects(runArchitectureReviewDispatch({ ...f.options, readHistory: f.readHistory,
    save: async checkpoint => { if (checkpoint.dispatch.groups.some(group => group.submissionReplay)) throw new Error("落盘失败"); } }), /落盘失败/);
  assert.deepEqual(f.record, oldRecord); assert.equal(f.requests.length, calls);
  const result = await runArchitectureReviewDispatch({ ...f.options, readHistory: f.readHistory });
  const saved = f.record.reviewDispatchCheckpoint as ReviewDispatchCheckpoint;
  assert.equal(saved.dispatch.calls, f.checkpoint.dispatch.calls + 1, "只有另一未完成组新增一次请求");
  assert.ok(!f.requests.slice(calls).includes(f.stopped.id));
  for (const previous of f.checkpoint.dispatch.groups) {
    const next = saved.dispatch.groups.find(group => group.id === previous.id)!;
    assert.equal(next.sessionFile, previous.sessionFile);
    if (previous.result) assert.deepEqual(next, previous);
  }
  assert.equal(architectureReviewDispatchRecovery(f.record), null);
  assert.equal(result.parts.acceptanceScopeChecks.length, f.design.acceptance.length);
  assert.deepEqual(f.native, native);
});

test("原评审报告的错误摘录、最新响应或退回绑定无法核对时，保留停点且不启动任何小组", async () => {
  for (const damage of ["quote", "latest", "receipt", "contract", "missing"]) {
    const f = await pausedMixedScope(), calls = f.requests.length;
    const assistant = f.native.at(-3)!;
    assert.ok(Array.isArray(assistant.content) && assistant.content[0]!.type === "toolCall");
    if (damage === "quote") recordArray(objectFields(assistant.content[0]!.arguments).acceptanceScopeChecks)[0]!.adapterQuote = "不属于当前材料的原文";
    if (damage === "latest") f.native.push({ role: "assistant", stopReason: "length", content: [{ type: "text", text: "未完成的新回复" }] });
    if (damage === "receipt") f.native.at(-2)!.toolCallId = "unrelated";
    if (damage === "contract") {
      const cp = f.record.reviewDispatchCheckpoint as ReviewDispatchCheckpoint;
      cp.dispatch.groups.find(group => group.id === f.stopped.id)!.rejection!.modelContractHash = "c".repeat(64);
      const { hash: _hash, ...body } = cp.dispatch; cp.dispatch.hash = designHash(body);
    }
    const before = structuredClone(f.record);
    await assert.rejects(runArchitectureReviewDispatch({ ...f.options,
      readHistory: damage === "missing" ? async () => { throw new Error("原会话缺失"); } : f.readHistory }));
    assert.equal(f.requests.length, calls, damage); assert.deepEqual(f.record, before, damage);
  }
});

for (const previousFormat of ["legacy", "location"]) test(`${previousFormat}引用契约升级后保留两次失败，第三次格式拒交停止`, async t => {
  const directory = await mkdtemp(join(tmpdir(), "neuma-review-location-counter-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = material(), parameters = f.reader.submissionSchema(f.schema);
  const legacyParameters = f.reader.submissionSchema(f.schema, previousFormat === "legacy" ? { legacy: true } : { strictLocations: true });
  const invalid = { ...f.review, issues: false };
  const originalIssue = architectureToolValidation(invalid, legacyParameters, { root: "review_slice" }).issues;
  const legacyHash = designHash({ model: "fixture-model", schema: legacyParameters });
  assert.equal(originalIssue[0]!.path, "review_slice.issues");
  const previous = { modelContractHash: legacyHash, protocolVersion: 2, count: 2,
    fingerprint: "a54e109fb143d31289d672e3feed37b2a660c1f548408aa1662f6bd0eb8dead3" };
  let calls = 0, rejected: ReviewDiagnostic["repeatedFailure"], verified = false;
  const designer = new ArchitectureDesigner({ config: { model: "fixture-model" }, cwd: directory, dataDir: directory,
    sessionFactory: async options => ({ modelCallAccounting: true, messages: [], subscribe: () => () => {}, dispose() {}, async abort() {},
      async prompt() {
        await options.onModelCall!();
        const feedback = await options.rawInputValidators!.submit_architecture_review_slice!({
          toolName: "submit_architecture_review_slice", toolCallId: "third-rejection", args: invalid });
        assert.equal(feedback.valid, false);
        await assert.rejects(async () => { await options.onModelCall!(); }, /连续三次/);
        verified = true; throw new Error("fixture stopped after rejection");
      } }) });
  await designer.ready;
  await assert.rejects(designer.role({ role: "specialist", systemPrompt: "固定评审协议测试", submitName: "submit_architecture_review_slice",
    payload: { pipelineStage: "review_slice", candidateHash: f.candidateHash }, parameters,
    ...(previousFormat === "legacy" ? { legacyReviewParameters: legacyParameters } : { previousReviewParameters: legacyParameters }),
    modelCallLimit: null, initialModelCalls: 2, previousRejection: previous, onSliceRejection: async value => { rejected = value; },
    onStageModelCall: () => { calls++; }, validate: () => assert.fail("拒交不能进入正式验收") }));
  assert.equal(verified, true); assert.equal(calls, 1); assert.equal(rejected?.count, 3);
  assert.equal(rejected?.protocolVersion, 3);
});

test("复杂评审按主题与验收分组，独立会话最多三并发，中断只续未完成组", async () => {
  const initial = material(), design = structuredClone(initial.design);
  design.acceptance = Array.from({ length: 13 }, (_, i) => ({ ...design.acceptance[i % design.acceptance.length]!, id: `acceptance_${i}` }));
  const candidateHash = designHash(design), context = architectureReviewEvidenceContext({ design, requirements: initial.context.requirements, runtimeCapabilities: {} });
  const priorFindings = { findings: [{ findingId: "previous_check", issue: { checkId: "verification" } }] };
  const schema = reviewSubmissionSchema({ evidenceRequired: true, priorFindingsRequired: true }), review = passingReview(candidateHash, design, priorFindings);
  const record: Record<string, unknown> = { candidateHash, status: "failed" }, started: string[] = [];
  let active = 0, maximum = 0, interrupted = false;
  const runRole = async (node: ReviewSliceRole) => {
    active++; maximum = Math.max(maximum, active); started.push(node.assignment.id);
    try {
      await node.worker.onSession(node.worker.group.sessionFile ?? `${node.assignment.id}.jsonl`); await node.worker.onCall();
      if (!interrupted && node.assignment.ids.includes("interfaces")) { interrupted = true; throw new Error("分项连接中断"); }
      assert.deepEqual(Object.keys(node.parameters.properties!).sort(), ["summary", "issues", node.assignment.field].sort());
      const input = { summary: "核对本组冻结原文", issues: [],
        [node.assignment.field]: node.assignment.field === "checks"
          ? review.checks.filter(row => node.assignment.ids.includes(row.id))
          : node.assignment.field === "acceptanceScopeChecks"
            ? review.acceptanceScopeChecks!.filter(row => "acceptanceId" in row && node.assignment.ids.includes(row.acceptanceId))
            : review.priorFindingDecisions!.filter(row => node.assignment.ids.includes(row.findingId!)) };
      assert.equal(architectureToolValidation(input, node.parameters).valid, true);
      const parts = node.validate(input);
      const other = node.assignment.field === "checks" ? "acceptanceScopeChecks" : "checks";
      assert.deepEqual(parts.parts[other], []);
      assert.deepEqual(node.prepareArguments({ ...input, [other]: [] }), input);
      assert.deepEqual(node.prepareArguments({ ...input, [other]: " [ \n ] " }), input);
      const foreign = { ...input, [other]: other === "checks" ? review.checks : review.acceptanceScopeChecks };
      assert.equal(architectureToolValidation(node.prepareArguments(foreign), node.parameters).valid, false);
      assert.throws(() => node.validate(foreign), /本组编号/);
      await node.worker.submit({ baseHash: node.worker.baseHash, issueIds: node.worker.group.issueIds, summary: parts.summary,
        updates: [{ path: node.worker.group.paths[0]!, value: parts }] });
    } finally { active--; }
  };
  const options = { record, candidateHash, platformHash: "a".repeat(64), context, schema, priorFindings, runRole, save: async (_checkpoint: ReviewDispatchCheckpoint) => {} };
  assert.equal(shouldDistributeArchitectureReview(context, null), true);
  const oldSchema = legacyReviewSchema(schema);
  oldSchema.properties.issues.items.required.push("factClaims");
  await assert.rejects(runArchitectureReviewDispatch({ ...options, schema: oldSchema }), /分项连接中断/u);
  const saved = structuredClone(record.reviewDispatchCheckpoint) as ReviewDispatchCheckpoint;
  assert.equal(saved.dispatch.calls, 3); assert.equal(saved.dispatch.groups.filter(group => group.result).length, 2);
  assert.equal(architectureReviewDispatchRecovery(record)?.status, "continuing");
  const before = started.length;
  await assert.rejects(runArchitectureReviewDispatch({ ...options, platformHash: "b".repeat(64) }), /分组评审的候选、材料或分派已变化/);
  assert.equal(started.length, before);
  const resumed = await runArchitectureReviewDispatch(options);
  assert.equal(record.reviewDispatchSource, saved.bindingHash);
  for (const group of saved.dispatch.groups.filter(group => group.result)) assert.equal(started.slice(before).includes(group.issueIds[0]!), false);
  assert.equal(maximum, 3); assert.equal(resumed.summary.modelCalls, 9);
  assert.equal(resumed.parts.checks.length, 8); assert.equal(resumed.parts.acceptanceScopeChecks.length, 13);
  assert.equal(resumed.parts.priorFindingDecisions.length, 1);
  const parts = createArchitectureReviewParts({ schema, candidateHash, context, priorFindings, initial: resumed.parts });
  const assembled = parts.assemble({ candidateHash, progressHash: parts.reference().progressHash, verdict: "pass", summary: "已逐项汇总" });
  assert.equal(validateReview(assembled, { candidateHash, schemaVersion: 3, evidenceContext: context }).verdict, "pass");
  const calls = started.length;
  await runArchitectureReviewDispatch(options); assert.equal(started.length, calls);
  const broken = { ...record }; delete broken.reviewDispatchCheckpoint;
  await assert.rejects(runArchitectureReviewDispatch({ ...options, record: broken }), /检查点缺失/u);
  assert.equal(started.length, calls);
});

test("历史意见小组先核对关闭依据，明确位置只写一次即可汇总，续接保留兄弟组及计数", async () => {
  const f = material(), findingId = "historical_location", paths = ["/components/0", "/acceptance/0"];
  const priorFindings = { current: { candidateHash: f.candidateHash,
    guideHash: f.context.contextManifest.acceptanceAdapterGuide!.sha256, contextManifestHash: designHash(f.context.contextManifest) },
    sameReviewObject: false, findings: [{ findingId, kind: "historical-review-opinion", closureEvidenceRequired: true, issue: { kind: "design" } }] };
  const schema = reviewSubmissionSchema({ evidenceRequired: true, priorFindingsRequired: true });
  const record: Record<string, unknown> = {}, started: string[] = [];
  let corrected = false;
  const runRole = async (node: ReviewSliceRole) => {
    started.push(node.assignment.id);
    await node.worker.onSession(node.worker.group.sessionFile ?? `${node.assignment.id}.jsonl`);
    await node.worker.onCall();
    const history = node.assignment.field === "priorFindingDecisions";
    const input = { summary: "核对本组当前材料", issues: history ? [{ id: findingId, blocking: false,
      checkId: "verification", kind: "design", description: "当前职责与验收支持撤销旧意见。", remedy: "按现有方案继续验证。",
      candidatePaths: corrected ? paths : ["/instructions"], references: [{ source: "requirements", path: "/0" }] }] : [],
      [node.assignment.field]: node.assignment.field === "checks" ? f.review.checks.filter(row => node.assignment.ids.includes(row.id))
        : node.assignment.field === "acceptanceScopeChecks" ? f.review.acceptanceScopeChecks!.filter(row => node.assignment.ids.includes(row.acceptanceId))
          : [{ findingId, status: "unsupported", reason: "当前两处条款已说明业务要求。", checkIds: ["verification"], candidatePaths: paths }] };
    const value = node.validate(input);
    if (history) assert.deepEqual(value.parts.issues[0]!.references, [{ source: "requirements", path: "/0" }], "读取位置不改写原报告");
    await node.worker.submit({ baseHash: node.worker.baseHash, issueIds: node.worker.group.issueIds, summary: value.summary,
      updates: [{ path: node.worker.group.paths[0]!, value }] });
  };
  const options = { record, candidateHash: f.candidateHash, platformHash: "a".repeat(64), context: f.context, priorFindings,
    schema, runRole, save: async (_checkpoint: ReviewDispatchCheckpoint) => {} };
  await assert.rejects(runArchitectureReviewDispatch(options), error => {
    assert.deepEqual(failureFields(error).validationIssues!.map(issue => issue.candidatePath).sort(), [...paths].sort());
    return true;
  });
  const stopped = structuredClone(record.reviewDispatchCheckpoint) as ReviewDispatchCheckpoint;
  const pending = stopped.dispatch.groups.filter(group => !group.result);
  assert.equal(pending.length, 1); assert.equal(pending[0]!.calls, 1);
  corrected = true;
  const before = started.length, result = await runArchitectureReviewDispatch(options);
  assert.deepEqual(started.slice(before), ["review_priorFindingDecisions_0"]);
  const saved = record.reviewDispatchCheckpoint as ReviewDispatchCheckpoint;
  assert.equal(saved.dispatch.calls, stopped.dispatch.calls + 1);
  for (const previous of stopped.dispatch.groups) {
    const next = saved.dispatch.groups.find(group => group.id === previous.id)!;
    assert.equal(next.sessionFile, previous.sessionFile);
    if (previous.result) assert.deepEqual(next, previous);
  }
  const review = validateReview({ ...result.parts, verdict: "pass", summary: "逐组完整核对" },
    { candidateHash: f.candidateHash, schemaVersion: 3, evidenceContext: f.context });
  assert.doesNotThrow(() => validateArchitecturePriorFindings(review, priorFindings, f.design, { evidenceContext: f.context }));
  const calls = started.length;
  await runArchitectureReviewDispatch(options); assert.equal(started.length, calls, "完成后恢复不重跑小组");
});

test("评审子组不能代交其他组，分项未通过也不能在主评审中被当作整体通过", async () => {
  const f = material(), record: Record<string, unknown> = {};
  const result = await runArchitectureReviewDispatch({ record, candidateHash: f.candidateHash, platformHash: "a".repeat(64), context: f.context,
    schema: f.schema, save: async () => {}, runRole: async node => {
      await node.worker.onSession(`${node.assignment.id}.jsonl`); await node.worker.onCall();
      const input = { summary: "独立核对本组", issues: node.assignment.ids.includes("requirements") ? [{ id: "scope_gap", blocking: true,
        checkId: "requirements", kind: "design", description: "需要核对完整输入范围", remedy: "核对原文对应条目",
        candidatePaths: ["/instructions"], references: [{ source: "candidate", path: "/instructions" }] }] : [], priorFindingDecisions: [],
        checks: node.assignment.field === "checks" ? f.review.checks.filter(row => node.assignment.ids.includes(row.id)).map(row => ({ ...row, passed: row.id !== "requirements" })) : [],
        acceptanceScopeChecks: node.assignment.field === "acceptanceScopeChecks" ? f.review.acceptanceScopeChecks!.filter(row => "acceptanceId" in row && node.assignment.ids.includes(row.acceptanceId)) : [] };
      if (node.assignment.field === "checks") assert.throws(() => node.validate({ ...input,
        checks: f.review.checks.map(row => ({ ...row, passed: row.id !== "requirements" })) }), /本组编号/u);
      const parts = node.validate(input);
      await node.worker.submit({ baseHash: node.worker.baseHash, issueIds: node.worker.group.issueIds, summary: parts.summary,
        updates: [{ path: node.worker.group.paths[0]!, value: parts }] });
    } });
  assert.equal(result.summary.failedChecks.length, 1);
  const parts = createArchitectureReviewParts({ ...f.options, initial: result.parts });
  const reference = parts.reference();
  assert.throws(() => validateReview(parts.assemble({ candidateHash: f.candidateHash, progressHash: reference.progressHash, verdict: "pass", summary: "不能跳过未通过项" }),
    { candidateHash: f.candidateHash, schemaVersion: 3, evidenceContext: f.context }));
});

test("分项保存只更新明确编号，精确校验后仍须完整正式评审", async () => {
  const f = material(), saved = [], parts = createArchitectureReviewParts({ ...f.options, onSave: value => saved.push(value) });
  const first = parts.reference();
  const outcome = await parts.save({ candidateHash: f.candidateHash, progressHash: first.progressHash,
    checks: f.review.checks.slice(0, 3), acceptanceScopeChecks: [f.review.acceptanceScopeChecks![0]] });
  assert.equal(outcome.submitted, false); assert.equal(outcome.complete, false); assert.equal(saved.length, 1);
  assert.equal(outcome.missing.checks.length, 5); assert.equal(parts.snapshot().acceptanceScopeChecks.length, 1);
  assert.throws(() => parts.assemble({ candidateHash: f.candidateHash, progressHash: outcome.progressHash, verdict: "pass", summary: "尚不完整" }),
    error => failureFields(error).validationIssue!.reason === "missing_coverage");
  await assert.rejects(parts.save({ candidateHash: f.candidateHash, progressHash: first.progressHash, checks: [f.review.checks[3]] }),
    error => failureFields(error).validationIssue!.reason === "invalid_reference");
  const next = await parts.save({ candidateHash: f.candidateHash, progressHash: outcome.progressHash, checks: f.review.checks.slice(3),
    acceptanceScopeChecks: f.review.acceptanceScopeChecks!.slice(1) });
  assert.deepEqual(parts.snapshot().checks.slice(0, 3), f.review.checks.slice(0, 3));
  const assembled = parts.assemble({ candidateHash: f.candidateHash, progressHash: next.progressHash, verdict: "pass", summary: "完整检查" });
  assert.equal(validateReview(assembled, { candidateHash: f.candidateHash, schemaVersion: 3, evidenceContext: f.context }).verdict, "pass");
});

test("短引用保存位置，旧会话回执及坏引用不能改写已有成果", async () => {
  const f = material(), parts = createArchitectureReviewParts(f.options);
  const scope = f.reader.index.acceptanceScope![0];
  await parts.save({ candidateHash: f.candidateHash, progressHash: parts.reference().progressHash,
    acceptanceScopeChecks: [{ acceptanceId: scope!.acceptanceId, adapterRulePath: scope!.adapterRulePaths[0], sufficient: true, reason: "核对原范围" }] });
  const before = parts.snapshot();
  assert.equal(before.acceptanceScopeChecks[0]!.criterionQuote, undefined); assert.ok(before.acceptanceScopeChecks[0]!.adapterRulePath);
  const read = JSON.parse(toolText((await f.reader.tool.execute("quote", { source: "candidate", pointer: "/acceptance/0/expected" }))));
  const otherReader = createArchitectureEvidenceReader({ context: f.context, candidateHash: f.candidateHash, role: "reviewer" });
  const resumed = createArchitectureReviewParts({ ...f.options, initial: before, resolve: otherReader.resolveSubmission });
  await assert.rejects(resumed.save({ candidateHash: f.candidateHash, progressHash: resumed.reference().progressHash,
    issues: [{ id: "precise", blocking: true, description: "核对事实", remedy: "核对当前原文", checkId: "verification", kind: "design",
      candidatePaths: ["/acceptance/0"], references: [{ receiptId: read.receiptId }], factClaims: [] }] }),
  error => failureFields(error).validationIssue!.reason === "invalid_receipt");
  await assert.rejects(resumed.save({ candidateHash: f.candidateHash, progressHash: resumed.reference().progressHash,
    acceptanceScopeChecks: [{ ...f.review.acceptanceScopeChecks![0], criterionQuote: "不存在的引文" }] }),
  error => failureFields(error).validationIssue!.reason === "reference_quote_mismatch");
  assert.deepEqual(resumed.snapshot(), before);
  await assert.rejects(resumed.save({ candidateHash: "a".repeat(64), progressHash: resumed.reference().progressHash, checks: [f.review.checks[0]] }));
  assert.deepEqual(resumed.snapshot(), before);
});

test("逐项检查允许暂缺关联项，最终仍拒绝不自洽结论且旧问题只能显式移除", async () => {
  const f = material(), parts = createArchitectureReviewParts(f.options), check = { ...f.review.checks[0], passed: false };
  await parts.save({ candidateHash: f.candidateHash, progressHash: parts.reference().progressHash,
    checks: [check, ...f.review.checks.slice(1)], acceptanceScopeChecks: f.review.acceptanceScopeChecks });
  const review = parts.assemble({ candidateHash: f.candidateHash, progressHash: parts.reference().progressHash, verdict: "revise", summary: "暂缺阻断依据" });
  assert.throws(() => validateReview(review, { candidateHash: f.candidateHash, schemaVersion: 3, evidenceContext: f.context }));
  const issue = { id: "specific", blocking: true, description: "当前设计仍有具体问题", remedy: "核对真实设计", checkId: check.id,
    kind: "design", candidatePaths: ["/acceptance/0/expected"], references: [{ source: "candidate", path: "/acceptance/0/expected",
      quote: f.design.acceptance[0]!.expected }], factClaims: [] };
  await parts.save({ candidateHash: f.candidateHash, progressHash: parts.reference().progressHash, issues: [issue] });
  await assert.rejects(parts.save({ candidateHash: f.candidateHash, progressHash: parts.reference().progressHash, removeIssueIds: ["unknown"] }));
  await parts.save({ candidateHash: f.candidateHash, progressHash: parts.reference().progressHash, checks: [f.review.checks[0]], removeIssueIds: [issue.id] });
  assert.equal(parts.snapshot().issues.length, 0);
});

test("取消或持久化失败不产生新可提交分项，访问器不被执行", async () => {
  const f = material(), controller = new AbortController(), parts = createArchitectureReviewParts({ ...f.options, signal: controller.signal });
  const before = parts.snapshot(); controller.abort();
  await assert.rejects(parts.save({ candidateHash: f.candidateHash, progressHash: parts.reference().progressHash, checks: [f.review.checks[0]] }), { name: "AbortError" });
  assert.deepEqual(parts.snapshot(), before);
  const failed = createArchitectureReviewParts({ ...f.options, onSave: () => { throw new Error("local storage unavailable"); } });
  await assert.rejects(failed.save({ candidateHash: f.candidateHash, progressHash: failed.reference().progressHash, checks: [f.review.checks[0]] }));
  assert.deepEqual(failed.snapshot(), before);
  let invoked = false;
  assert.throws(() => canonicalArchitectureReviewParts({ get candidateHash() { invoked = true; throw new Error("private"); } }, f.options));
  assert.equal(invoked, false);
});

test("被拒分项独立保留，恢复后用新编号仅修正错误行并重验全部草稿", async () => {
  const f = material(), rejected:ReviewParts[] = [], saved:ReviewParts[] = [];
  const parts = createArchitectureReviewParts({ ...f.options, onRejected: value => rejected.push(value), onSave: value => saved.push(value) });
  await parts.save({ candidateHash: f.candidateHash, progressHash: parts.reference().progressHash, checks: [f.review.checks[0]] });
  const accepted = parts.snapshot();
  const issue = { id: "review_note", blocking: false, checkId: "verification", kind: "design", description: "本地测试解释", remedy: "保留要求",
    candidatePaths: ["/instructions"], references: [{ source: "candidate", path: "/instructions", quote: "wrong quotation" }], factClaims: [] };
  await assert.rejects(parts.finalize({ candidateHash: f.candidateHash, progressHash: parts.reference().progressHash,
    verdict: "pass", summary: "尚未通过的报告", checks: f.review.checks, issues: [issue], acceptanceScopeChecks: f.review.acceptanceScopeChecks }),
  error => failureFields(error).validationIssue!.reason === "reference_quote_mismatch" && /rejectedPartsHash/u.test(failureFields(error).message!));
  assert.deepEqual(parts.snapshot(), accepted); assert.equal(saved.length, 1); assert.equal(rejected.length, 1);
  assert.deepEqual(parts.rejectedSnapshot()!.issues, [issue]);
  assert.equal(parts.rejectedSnapshot()!.checks.length, f.review.checks.length);
  const old = parts.reference();
  const resumed = createArchitectureReviewParts({ ...f.options, initial: accepted, initialRejected: rejected[0] });
  const current = resumed.reference(); assert.notEqual(current.rejectedPartsHash, old.rejectedPartsHash);
  assert.equal(current.rejectedPartsIssues![0]!.reason, "reference_quote_mismatch");
  const corrected = { ...issue, references: [{ source: "candidate", path: "/instructions", quote: f.design.instructions }] };
  await assert.rejects(resumed.save({ candidateHash: f.candidateHash, progressHash: current.progressHash,
    rejectedPartsHash: old.rejectedPartsHash, issues: [corrected] }), error => failureFields(error).validationIssue!.path === "reviewParts.rejectedPartsHash");
  assert.deepEqual(resumed.snapshot(), accepted);
  const review = await resumed.finalize({ candidateHash: f.candidateHash, progressHash: current.progressHash,
    rejectedPartsHash: current.rejectedPartsHash, issues: [corrected], verdict: "pass", summary: "重验完整报告" });
  assert.equal(validateReview(review, { candidateHash: f.candidateHash, schemaVersion: 3, evidenceContext: f.context }).verdict, "pass");
  assert.deepEqual(review.checks, f.review.checks); assert.deepEqual(review.acceptanceScopeChecks, f.review.acceptanceScopeChecks);
  assert.equal(resumed.rejectedSnapshot(), null); assert.equal(resumed.reference().rejectedPartsHash, undefined);
  await assert.rejects(resumed.save({ candidateHash: f.candidateHash, progressHash: resumed.reference().progressHash,
    rejectedPartsHash: current.rejectedPartsHash, issues: [corrected] }));
});

test("被拒草稿保存失败锁住后续写入，迟到修正不能替代失败成果", async () => {
  const f = material(); let saved = 0;
  const parts = createArchitectureReviewParts({ ...f.options, onRejected: () => { throw new Error("rejected draft storage failed"); }, onSave: () => saved++ });
  const before = parts.snapshot(), row = { ...f.review.acceptanceScopeChecks![0], criterionQuote: "wrong quotation" };
  await assert.rejects(parts.save({ candidateHash: f.candidateHash, progressHash: parts.reference().progressHash, acceptanceScopeChecks: [row] }), /storage failed/u);
  assert.deepEqual(parts.snapshot(), before); assert.equal(parts.rejectedSnapshot(), null);
  assert.throws(parts.assertActive, /storage failed/u);
  await assert.rejects(parts.save({ candidateHash: f.candidateHash, progressHash: parts.reference().progressHash,
    checks: f.review.checks, acceptanceScopeChecks: f.review.acceptanceScopeChecks }), /storage failed/u);
  assert.equal(saved, 0);
});

async function recoveryFixture(t: test.TestContext, { rejectDraft = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-review-parts-recovery-")), calls: {role:string;resumed:boolean;payload:Record<string,unknown>}[] = [];
  const draft = validDraft();
  draft.taskSpec = { version: 1, items: [{ id: "complete", dimension: "processing", content: "完整核对全部记录", applicability: "applies",
    critical: true, source: { kind: "user", evidence: [{ messageId: "source", quote: "完整核对全部记录" }] } }] };
  const definition = { id: "parts", name: "分项评审续接", fingerprint: "same-source", draft };
  const state: {resumed:boolean;oldReference:PartReference|null;firstParts:PartReference|null;fidelity:number;rejectedIssue?:ArchitectureIssue;rejectedPartsHash?:string|undefined} = { resumed: false, oldReference: null, firstParts: null, fidelity: 0 };
  const stages = createArchitectureStageSessionFactory((payload) => validDesign(payload.requirements, {
    schemaVersion: 3, connections: [], interaction: { defaultEntry: "conversation", page: false, operations: false, inputs: "全部记录", results: "完整结果", persistentData: "无" },
    execution: { language: "none", hosting: "builtin", reason: "已有文本能力" },
    selectionBasis: { capacity: "已确认边界", process: "完整处理", quality: "逐项核对", requirementIds: payload.requirements.map((row) => row.id), assumptions: [] },
  }), { onPrompt: ({ stage, payload }) => calls.push({ role: stage, resumed: state.resumed, payload }) });
  const sessionFactory = async (options: PiSessionOptions) => {
    const staged = await stages(options); if (staged) return staged;
    const tools = fixtureTools(options.customTools!), role = tools.submit_architecture ? "designer" : "reviewer";
    return { messages: [], modelCallAccounting: true, subscribe: () => () => {}, async abort() {}, dispose() {}, async prompt(text: string) {
      const payload:ModelPayload = JSON.parse(text); calls.push({ role, resumed: state.resumed, payload }); await options.onModelCall!();
      if (role === "designer") return tools.submit_architecture!.execute("candidate", validDesign(payload.requirements, {
        schemaVersion: 3, connections: [], interaction: { defaultEntry: "conversation", page: false, operations: false, inputs: "全部记录", results: "完整结果", persistentData: "无" },
        execution: { language: "none", hosting: "builtin", reason: "已有文本能力" },
        selectionBasis: { capacity: "已确认边界", process: "完整处理", quality: "逐项核对", requirementIds: payload.requirements.map((row) => row.id), assumptions: [] } }));
      const review = passingReview(payload.candidateHash, payload.design, payload.priorFindings);
      const scopeRows = review.acceptanceScopeChecks!.map((row) => ({
        acceptanceId:row.acceptanceId, adapterRulePath: `/adapters/${fixtureString(objectFields(row).adapterId)}/proves`, sufficient:row.sufficient, reason:row.reason }));
      assert.ok(tools.save_architecture_review_parts); assert.ok(tools.submit_architecture_review_parts);
      const reference = payload.reviewParts;
      if (!state.resumed) {
        state.oldReference = reference;
        const saved = await tools.save_architecture_review_parts.execute("first", { candidateHash: payload.candidateHash,
          progressHash: reference.progressHash, checks: review.checks.slice(0, 3), acceptanceScopeChecks: scopeRows.slice(0, 1) });
        assert.equal(saved.terminate, undefined); state.firstParts = JSON.parse(toolText(saved));
        if (rejectDraft) {
          state.rejectedIssue = { id: "draft_note", blocking: false, checkId: "verification", kind: "design", description: "本地被拒草稿", remedy: "核对引用",
            candidatePaths: ["/instructions"], references: [{ source: "candidate", path: "/instructions", quote: "unmatched draft quote" }], factClaims: [] };
          await assert.rejects(tools.submit_architecture_review_parts.execute("rejected", { candidateHash: payload.candidateHash,
            progressHash: state.firstParts!.progressHash, checks: review.checks.slice(3), acceptanceScopeChecks: scopeRows.slice(1),
            ...(review.priorFindingDecisions ? { priorFindingDecisions: review.priorFindingDecisions } : {}),
            issues: [state.rejectedIssue], verdict: "pass", summary: "尚未通过的分项报告" }), error => {
            state.rejectedPartsHash = failureFields(error).message!.match(/"rejectedPartsHash":"([a-f0-9]{64})"/u)?.[1];
            return failureFields(error).validationIssue!.reason === "reference_quote_mismatch" && Boolean(state.rejectedPartsHash);
          });
        }
        throw new Error("fetch failed");
      }
      assert.notEqual(reference.progressHash, state.firstParts!.progressHash, "重启生成新的宿主CAS编号");
      assert.deepEqual(reference.saved.checks, review.checks.slice(0, 3));
      assert.equal(reference.missing.checks.length, 5);
      assert.equal(reference.missing.acceptanceScopeChecks.length, review.acceptanceScopeChecks!.length - 1);
      if (rejectDraft) {
        assert.notEqual(reference.rejectedPartsHash, state.rejectedPartsHash);
        assert.equal(reference.rejectedDraft.checks.length, review.checks.length);
        assert.equal(reference.rejectedDraft.acceptanceScopeChecks.length, review.acceptanceScopeChecks!.length);
        assert.deepEqual(reference.rejectedDraft.issues, [state.rejectedIssue]);
        assert.equal(reference.rejectedPartsIssues![0]!.reason, "reference_quote_mismatch");
        return tools.submit_architecture_review_parts.execute("repair-draft", { candidateHash: payload.candidateHash,
          progressHash: reference.progressHash, rejectedPartsHash: reference.rejectedPartsHash,
          issues: [{ ...state.rejectedIssue, references: [{ source: "candidate", path: "/instructions", quote: payload.design.instructions }] }],
          verdict: "pass", summary: "原草稿已逐条重新校验" });
      }
      await assert.rejects(tools.submit_architecture_review_parts.execute("stale", { candidateHash: payload.candidateHash,
        progressHash: state.firstParts!.progressHash, verdict: "pass", summary: "旧编号不能提交" }));
      await assert.rejects(tools.submit_architecture_review_parts.execute("missing", { candidateHash: payload.candidateHash,
        progressHash: reference.progressHash, verdict: "pass", summary: "缺项不能提交" }));
      const saved = JSON.parse(toolText((await tools.save_architecture_review_parts.execute("remaining", { candidateHash: payload.candidateHash,
        progressHash: reference.progressHash, checks: review.checks.slice(3), acceptanceScopeChecks: scopeRows.slice(1),
        ...(review.priorFindingDecisions ? { priorFindingDecisions: review.priorFindingDecisions } : {}) }))));
      return tools.submit_architecture_review_parts.execute("formal", { candidateHash: payload.candidateHash,
        progressHash: saved.progressHash, verdict: "pass", summary: "已完整核对当前方案" });
    } };
  };
  const fidelitySessionFactory = async (options: PiSessionOptions) => ({ messages: [], modelCallAccounting: true, subscribe: () => () => {},
    async abort() {}, dispose() {}, setAutoCompactionEnabled() {}, async prompt(text: string) {
      await options.onModelCall!(); state.fidelity++; return fixtureToolAt(options.customTools!,0).execute("scope", fidelityResult(JSON.parse(text)));
    } });
  const make = () => new ArchitectureDesigner({ config: { llmConfigured: true }, cwd: root, dataDir: join(root, "data"), sessionFactory, fidelitySessionFactory });
  let designer = make();
  t.after(async () => { await designer.persistence; await rm(root, { recursive: true, force: true }); });
  return { state, calls, definition, get designer() { return designer; }, reload: async () => { await designer.persistence; designer = make(); await designer.ready; } };
}

test("离线端到端：保存部分评审后重启，只补缺项并正式独立复核，累计预算不重置", async (t) => {
  const f = await recoveryFixture(t);
  await assert.rejects(f.designer.design(f.definition), error => failureFields(error).diagnostic!.reason === "api_connection");
  const source = await f.designer.get(f.definition.id), before = designHash(source);
  assert.deepEqual(f.calls.filter(row => ["blueprint", "module", "integration"].includes(row.role)).map(row => row.role),
    ["blueprint", "module", "integration"]);
  const checkpoint = readReviewProgressCheckpoint(source);
  assert.equal(checkpoint!.schemaVersion, 2); assert.equal(checkpoint!.modelCalls, 1); assert.equal(checkpoint!.review, null);
  assert.equal(source!.review, null); assert.deepEqual<NonNullable<NonNullable<typeof source>>["attempts"]>(source!.attempts, []); assert.equal(f.state.fidelity, 0);
  const charged = advanceReviewProgressCheckpoint(source, 2);
  assert.deepEqual(charged!.parts, checkpoint!.parts); assert.equal(charged!.modelCalls, 2);
  const altered = structuredClone(source);
  recordArray(objectFields(altered!.reviewProgressCheckpoint!.parts).acceptanceScopeChecks)[0]!.criterionQuote = "不存在的逐字依据";
  altered!.reviewProgressCheckpoint!.partsHash = designHash(altered!.reviewProgressCheckpoint!.parts);
  const { hash: _hash, ...body } = altered!.reviewProgressCheckpoint!;
  altered!.reviewProgressCheckpoint!.hash = designHash(body);
  assert.equal(readReviewProgressCheckpoint(altered), null, "即使重算摘要，错误原文也不能恢复为已保存分项");
  assert.equal(advanceReviewProgressCheckpoint({ ...source, reviewProgressCheckpoint: charged }, 1), null);
  for (const key of ["platformHash", "runtimeCapabilities", "confirmedRequirementContext", "deferredVerifications", "sourceFingerprint", "priorFindings"])
    assert.equal(reviewProgressCheckpointMatches(checkpoint, { ...source, [key]: { changed: true } }), false, key);
  const changed = structuredClone(source); changed!.design!.instructions += " changed"; changed!.candidateHash = designHash(changed!.design);
  assert.equal(reviewProgressCheckpointMatches(checkpoint, changed), false);
  await f.reload(); f.state.resumed = true;
  const result = await f.designer.design(f.definition);
  assert.deepEqual(f.calls.filter(row => row.resumed).map(row => row.role), ["reviewer"]);
  assert.equal(result.status, "passed"); assert.equal(result.review!.verdict, "pass"); assert.equal(f.state.fidelity, 1);
  assert.equal(result.reviewProgressCheckpoint!.modelCalls, 3); assert.equal(result.attempts.length, 1);
  assert.equal(designHash(await f.designer.getVersion(f.definition.id, source!.version)), before);
});

test("离线端到端：被拒报告在重启后可只改错误行，原通过分项和累计预算保持", async t => {
  const f = await recoveryFixture(t, { rejectDraft: true });
  await assert.rejects(f.designer.design(f.definition), error => failureFields(error).diagnostic!.reason === "api_connection");
  const source = await f.designer.get(f.definition.id), checkpoint = readReviewProgressCheckpoint(source), before = designHash(source);
  assert.equal(checkpoint!.schemaVersion, 4); assert.equal(checkpoint!.modelCalls, 1);
  assert.equal(recordArray(recordArray(checkpoint!.rejectedInput!.input.issues)[0]!.references)[0]!.quote, "unmatched draft quote");
  assert.equal(checkpoint!.parts!.checks.length, 3); assert.equal(checkpoint!.parts!.acceptanceScopeChecks.length, 1);
  assert.equal(checkpoint!.rejectedParts!.checks.length, 8);
  assert.equal(checkpoint!.rejectedParts!.issues[0]!.references![0]!.quote, "unmatched draft quote");
  assert.equal(source!.review, null); assert.equal(f.state.fidelity, 0);
  await f.reload(); f.state.resumed = true;
  const result = await f.designer.design(f.definition);
  assert.equal(result.status, "passed"); assert.equal(result.reviewProgressCheckpoint!.modelCalls, 3);
  assert.equal(result.reviewProgressCheckpoint!.rejectedParts, null); assert.equal(result.reviewProgressCheckpoint!.rejectedInput, null);
  assert.equal(f.state.fidelity, 1);
  assert.equal(result.review!.issues[0]!.references![0]!.quote, result.design!.instructions);
  assert.deepEqual(f.calls.filter(row => row.resumed).map(row => row.role), ["reviewer"]);
  assert.equal(designHash(await f.designer.getVersion(f.definition.id, source!.version)), before);
});
