import { fixtureSchema } from "../helpers/m7-test-boundaries.mjs";
import { toolText } from "../helpers/m7-test-boundaries.mjs";
import { fixtureDeferred } from "../helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { designHash, reviewSubmissionSchema, validateReview } from "../../src/architecture/architecture-contract.mjs";
import { architectureReviewEvidenceContext } from "../../src/architecture/architecture-review-evidence.mjs";
import { createArchitectureEvidenceReader } from "../../src/architecture/architecture-evidence-reader.mjs";
import { createArchitectureReviewParts } from "../../src/architecture/architecture-review-parts.mjs";
import { architectureToolValidation } from "../../src/architecture/architecture-tool-diagnostics.mjs";
import { validDesign, passingReview } from "../helpers/architecture.mjs";
import type { ReviewParts,ReviewDiagnosticIssue,ArchitectureReview } from "../../src/contracts/architecture.mjs";
import type { ToolSchema } from "../../src/contracts/tools.mjs";

function material() {
  const requirements = [{ id: "R1", text: "逐项核对完整文本" }];
  const design = validDesign(requirements, { schemaVersion: 3, connections: [],
    interaction: { defaultEntry: "conversation", page: false, operations: false, inputs: "完整文本", results: "核对结果", persistentData: "无" },
    execution: { language: "none", hosting: "builtin", reason: "复用已有文本能力" },
    selectionBasis: { capacity: "处理全部文本", process: "逐项核对", quality: "保留原文依据", requirementIds: ["R1"], assumptions: [] },
    acceptance: Array.from({ length: 12 }, (_, index) => ({ id: `scope_${String(index + 1).padStart(2, "0")}`,
      kind: ["success", "missing_input", "boundary"][index % 3], requirementIds: ["R1"], input: `合成文本${index + 1}`,
      expected: `保留第${index + 1}项文本的实际依据` })) });
  const candidateHash = designHash(design), context = architectureReviewEvidenceContext({ design, requirements, runtimeCapabilities: {} });
  const priorFindings = { findings: ["prior_a", "prior_b"].map((findingId) => ({ findingId, issue: { checkId: "verification" } })) };
  const schema = reviewSubmissionSchema({ evidenceRequired: true, priorFindingsRequired: true });
  const reader = createArchitectureEvidenceReader({ context, candidateHash, role: "reviewer" });
  const review = passingReview(candidateHash, design, priorFindings);
  const options = { schema, toolSchema: reader.submissionSchema(schema), candidateHash, context, priorFindings,
    resolve: reader.resolveSubmission };
  return { design, candidateHash, context, priorFindings, review, options };
}

type Parts = ReturnType<typeof createArchitectureReviewParts>;
const input = (parts: Pick<Parts, "reference">, rows = {}) => ({ candidateHash: parts.reference().candidateHash, progressHash: parts.reference().progressHash, ...rows });
const savedRows = (f: ReturnType<typeof material>, overrides = {}) => ({ candidateHash: f.candidateHash, checks: structuredClone(f.review.checks), issues: [], acceptanceScopeChecks: structuredClone(f.review.acceptanceScopeChecks), priorFindingDecisions: structuredClone(f.review.priorFindingDecisions), ...overrides });
const rowCount = (batch: { remainingModelCalls: number; reservedModelCalls: number; checks: string[]; acceptanceScopeChecks: string[]; priorFindingDecisions: string[]; stage: string; }|undefined) => batch!.acceptanceScopeChecks!.length + batch!.priorFindingDecisions!.length + batch!.checks!.length;
const issueReason = (reason: string) => (error: { validationIssue: { reason: string; }; }) => error.validationIssue?.reason === reason;
const deferred = fixtureDeferred;

test("批次按真实剩余额度缩并，范围稳定编号优先且保留两次独立复核", () => {
  const f = material(); let used = 0;
  const parts = createArchitectureReviewParts({ ...f.options, remainingModelCalls: () => 12 - used });
  const fresh = parts.reference().batch;
  assert.equal(fresh!.stage!, "save"); assert.equal(fresh!.reservedModelCalls!, 2);
  assert.deepEqual(fresh!.acceptanceScopeChecks!, f.design.acceptance.slice(0, 6).map((row) => row.id));
  assert.deepEqual(fresh!.priorFindingDecisions!, []); assert.deepEqual(fresh!.checks!, []);
  used = 8;
  const nearLimit = parts.reference().batch;
  assert.equal(nearLimit!.remainingModelCalls!, 4); assert.equal(nearLimit!.stage!, "save");
  assert.ok(rowCount(nearLimit) > rowCount(fresh));
  assert.deepEqual(nearLimit!.acceptanceScopeChecks!, f.design.acceptance.slice(0, rowCount(nearLimit)).map((row) => row.id));
  assert.deepEqual(nearLimit!.priorFindingDecisions!, []); assert.deepEqual(nearLimit!.checks!, []);
  used = 9;
  const last = parts.reference().batch;
  assert.equal(last!.stage!, "submit-with-parts"); assert.equal(last!.remainingModelCalls!, 3);
  assert.deepEqual(last!.acceptanceScopeChecks!, f.design.acceptance.map((row) => row.id));
  assert.deepEqual(last!.priorFindingDecisions!, f.priorFindings.findings.map((row) => row.findingId));
  assert.deepEqual(last!.checks!, f.review.checks.map((row) => row.id));
  for (used of [11, 12]) {
    const stopped = parts.reference().batch;
    assert.equal(stopped!.stage!, "final-only"); assert.equal(stopped!.remainingModelCalls!, 12 - used);
    assert.equal(stopped!.reservedModelCalls!, 2);
  }
});

test("同编号实质修改可保存，完全相同或仅换行顺序不推进分项", async () => {
  const f = material(), writes: ({ "candidateHash": (string); "checks": ({ id: string; passed: boolean; evidence: string; }[]); "issues": (import("../../src/contracts/architecture.d.mjs").ArchitectureIssue[]); "acceptanceScopeChecks": ({ acceptanceId: string; adapterId: string; scope: string; sufficient: boolean; reason: string; criterionQuote: string; adapterQuote: string; }[]); "priorFindingDecisions": ({ findingId: string; status: string; reason: string; checkIds: string[]; candidatePaths: string[]; }[]); })[] = [];
  const note = (id: string) => ({ id, blocking: false, description: "保留当前原文说明", remedy: "核对当前候选", checkId: "verification",
    kind: "design", candidatePaths: ["/instructions"], references: [{ source: "candidate", path: "/instructions", quote: f.design.instructions }], factClaims: [] });
  const initial = savedRows(f, { issues: [note("note_a"), note("note_b")] });
  const parts = createArchitectureReviewParts({ ...f.options, initial, remainingModelCalls: () => 12,
    onSave: (value) => writes.push(structuredClone(value)) });
  const before = parts.snapshot(), first = parts.reference();
  await assert.rejects(parts.save(input(parts, { checks: f.review.checks })), issueReason("no_progress"));
  await assert.rejects(parts.save(input(parts, { checks: f.review.checks.slice().reverse() })), issueReason("no_progress"));
  await assert.rejects(parts.save(input(parts, { removeIssueIds: ["note_a"], issues: [note("note_a")] })), issueReason("no_progress"));
  assert.equal(writes.length, 0); assert.deepEqual(parts.snapshot(), before);
  assert.equal(parts.reference().progressHash, first.progressHash);
  const replacement = { ...f.review.checks[0]!, evidence: "重新核对当前原文与需求映射" };
  const result = await parts.save(input(parts, { checks: [replacement] }));
  assert.equal(result.changed, true); assert.equal(result.saved, true); assert.equal(result.submitted, false);
  assert.equal(writes.length, 1); assert.equal(parts.snapshot().checks.length, f.review.checks.length);
  assert.deepEqual(parts.snapshot().checks[0], replacement); assert.deepEqual(result.missing, first.missing);
  assert.notEqual(result.progressHash, first.progressHash); assert.equal(result.batch!.stage, "submit");
});

test("旧详细行的坏逐字引文与旧CAS均保留已有成果", async () => {
  const f = material(), writes: ({ "candidateHash": (string); "checks": ({ id: string; passed: boolean; evidence: string; }[]); "issues": (import("../../src/contracts/architecture.d.mjs").ArchitectureIssue[]); "acceptanceScopeChecks": ({ acceptanceId: string; adapterId: string; scope: string; sufficient: boolean; reason: string; criterionQuote: string; adapterQuote: string; }[]); "priorFindingDecisions": ({ findingId: string; status: string; reason: string; checkIds: string[]; candidatePaths: string[]; }[]); })[] = [], parts = createArchitectureReviewParts({ ...f.options,
    onSave: (value) => writes.push(value) });
  const stale = input(parts);
  await parts.save(input(parts, { acceptanceScopeChecks: [f.review!.acceptanceScopeChecks![0]] }));
  const before = parts.snapshot(), reference = parts.reference();
  await assert.rejects(parts.save(input(parts, { acceptanceScopeChecks: [{ ...f.review!.acceptanceScopeChecks![1]!, criterionQuote: "不存在的逐字引用" }] })),
    issueReason("reference_quote_mismatch"));
  await assert.rejects(parts.save({ ...stale, checks: [f.review.checks[0]] }), issueReason("invalid_reference"));
  assert.equal(writes.length, 1); assert.deepEqual(parts.snapshot(), before);
  const { rejectedPartsHash, rejectedPartsTrust, rejectedPartsIssues, ...acceptedReference } = parts.reference();
  assert.deepEqual(acceptedReference, reference); assert.match(rejectedPartsHash!, /^[a-f0-9]{64}$/u);
  assert.equal(rejectedPartsTrust, "untrusted-reference");
  assert.equal(rejectedPartsIssues![0]!.reason, "reference_quote_mismatch");
  assert.equal(parts.rejectedSnapshot!()!.acceptanceScopeChecks[1]!.criterionQuote, "不存在的逐字引用");
});

test("宿主batch仅派发两种四字段短行，保存为canonical且旧完整提交保持兼容", async () => {
  const f = material(), writes: ({ "candidateHash": (string); "checks": ({ id: string; passed: boolean; evidence: string; }[]); "issues": (import("../../src/contracts/architecture.d.mjs").ArchitectureIssue[]); "acceptanceScopeChecks": ({ acceptanceId: string; adapterId: string; scope: string; sufficient: boolean; reason: string; criterionQuote: string; adapterQuote: string; }[]); "priorFindingDecisions": ({ findingId: string; status: string; reason: string; checkIds: string[]; candidatePaths: string[]; }[]); })[] = [], parts = createArchitectureReviewParts({ ...f.options, remainingModelCalls: () => 12,
    onSave: value => writes.push(value) });
  for (const schema of [parts.saveParameters, parts.submitParameters]) {
    const branches = fixtureSchema(schema).properties!.acceptanceScopeChecks!.items!.anyOf!;
    assert.equal(branches.length, 2);
    assert.deepEqual(branches.map((branch) => Object.keys(branch.properties!).sort()), [
      ["acceptanceId", "adapterRulePath", "reason", "sufficient"], ["acceptanceId", "reason", "scopeReceiptId", "sufficient"],
    ]);
    assert.ok(branches.every((branch) => branch.required!.length === 4 && branch.additionalProperties === false));
  }
  const detailed = f.review!.acceptanceScopeChecks![0]!, before = parts.snapshot(); assert.ok("adapterId" in detailed);
  assert.equal(architectureToolValidation(input(parts, { acceptanceScopeChecks: [detailed] }), parts.saveParameters).valid, false);
  await assert.rejects(parts.save(input(parts, { acceptanceScopeChecks: [detailed] })));
  assert.deepEqual(parts.snapshot(), before); assert.equal(writes.length, 0);
  const short = { acceptanceId: detailed!.acceptanceId!, adapterRulePath: `/adapters/${detailed!.adapterId!}/proves`,
    sufficient: detailed!.sufficient!, reason: detailed!.reason! };
  await parts.save(input(parts, { acceptanceScopeChecks: [short] }));
  assert.deepEqual(parts.snapshot().acceptanceScopeChecks[0], detailed);
  const second = f.review!.acceptanceScopeChecks![1]!; assert.ok("adapterId" in second);
  const reader = createArchitectureEvidenceReader({ context: f.context, candidateHash: f.candidateHash, role: "reviewer" });
  const receipt = JSON.parse(String(toolText((await reader.tool.execute("scope", { source: "acceptanceAdapterGuide", pointer: `/adapters/${second!.adapterId!}/proves`, acceptanceId: second!.acceptanceId! })))));
  const withReceipt = createArchitectureReviewParts({ ...f.options, resolve: reader.resolveSubmission, remainingModelCalls: () => 12 });
  await withReceipt.save(input(withReceipt, { acceptanceScopeChecks: [{ acceptanceId: second!.acceptanceId!,
    scopeReceiptId: receipt.scopeReceiptId, sufficient: true, reason: second!.reason! }] }));
  assert.deepEqual(withReceipt.snapshot().acceptanceScopeChecks[0], second);
  assert.equal(architectureToolValidation(f.review, f.options.toolSchema).valid, true);
  assert.equal(validateReview(f.review, { candidateHash: f.candidateHash, schemaVersion: 3, evidenceContext: f.context }).verdict, "pass");
  const restored = createArchitectureReviewParts({ ...f.options, initial: savedRows(f), remainingModelCalls: () => 12 });
  assert.deepEqual(restored.snapshot(), savedRows(f));
  assert.equal(restored.assemble!(input(restored, { verdict: "pass", summary: "不重写旧详细分项" })).acceptanceScopeChecks!.length, 12);
});

test("保存失败或等待落盘时取消，不发布新分项或新CAS", async () => {
  const f = material();
  const failed = createArchitectureReviewParts({ ...f.options, remainingModelCalls: () => 12,
    onSave: () => { throw new Error("fixture storage failure"); } });
  const beforeFailure = failed.snapshot(), failedReference = failed.reference();
  await assert.rejects(failed.save(input(failed, { checks: [f.review.checks[0]] })), /fixture storage failure/);
  assert.deepEqual(failed.snapshot(), beforeFailure); assert.deepEqual(failed.reference(), failedReference);
  const controller = new AbortController(), entered = deferred(), release = deferred();
  const cancelled = createArchitectureReviewParts({ ...f.options, signal: controller.signal, remainingModelCalls: () => 12,
    onSave: async () => { entered.resolve!(); await release.promise; } });
  const beforeCancel = cancelled.snapshot(), cancelReference = cancelled.reference();
  const pending = cancelled.save(input(cancelled, { checks: [f.review.checks[0]] }));
  await entered.promise;
  assert.deepEqual(cancelled.snapshot(), beforeCancel); assert.deepEqual(cancelled.reference(), cancelReference);
  controller.abort(); release.resolve!();
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(cancelled.snapshot(), beforeCancel); assert.deepEqual(cancelled.reference(), cancelReference);
});

test("最后一批与正式结论可同次提交，但必须先保存真实行再按新CAS组装", async () => {
  const f = material(), writes: ({ "candidateHash": (string); "checks": ({ id: string; passed: boolean; evidence: string; }[]); "issues": (import("../../src/contracts/architecture.d.mjs").ArchitectureIssue[]); "acceptanceScopeChecks": ({ acceptanceId: string; adapterId: string; scope: string; sufficient: boolean; reason: string; criterionQuote: string; adapterQuote: string; }[]); "priorFindingDecisions": ({ findingId: string; status: string; reason: string; checkIds: string[]; candidatePaths: string[]; }[]); })[] = [], last = f.review.checks.at(-1);
  let parts: Parts;
  parts = createArchitectureReviewParts({ ...f.options, remainingModelCalls: () => 3,
    initial: savedRows(f, { checks: f.review.checks.slice(0, -1) }), onSave: (value) => {
      assert.equal(parts.snapshot().checks.length, f.review.checks.length - 1);
      writes.push(structuredClone(value));
    } });
  const previous = input(parts);
  assert.equal(parts.reference!().batch!.stage, "submit-with-parts");
  const result = await parts.finalize({ ...previous, checks: [last], verdict: "pass", summary: "已逐项核对全部真实分项" });
  assert.equal(writes.length, 1); assert.equal(writes[0]!.checks.length, f.review.checks.length);
  assert.deepEqual(result.checks, writes[0]!.checks); assert.notEqual(parts.reference().progressHash, previous.progressHash);
  assert.throws(() => parts.assemble({ ...previous, verdict: "pass", summary: "旧编号" }), issueReason("invalid_reference"));
  assert.equal(validateReview(result, { candidateHash: f.candidateHash, schemaVersion: 3, evidenceContext: f.context }).verdict, "pass");
  assert.equal(parts.reference!().batch!.stage, "submit"); assert.equal(parts.reference().complete, false);
  await parts.finalize(input(parts, { verdict: "pass", summary: "直接正式提交已有完整分项" }));
  assert.equal(writes.length, 1, "无更新的正式提交无需重复落盘分项");
});

test("最后一批保存中取消不得完成提交，合法部分行也不替代最终完整语义检查", async () => {
  const f = material(), controller = new AbortController(), entered = deferred(), release = deferred();
  const initial = savedRows(f, { checks: f.review.checks.slice(0, -1) });
  const parts = createArchitectureReviewParts({ ...f.options, initial, signal: controller.signal, remainingModelCalls: () => 3,
    onSave: async () => { entered.resolve!(); await release.promise; } });
  const pending = parts.finalize(input(parts, { checks: [f.review.checks.at(-1)], verdict: "pass", summary: "等待真实保存" }));
  await entered.promise; controller.abort(); release.resolve!();
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(parts.snapshot(), initial); assert.equal(parts.reference().missing.checks.length, 1);
  const inconsistent = createArchitectureReviewParts({ ...f.options, initial, remainingModelCalls: () => 3 });
  await assert.rejects(inconsistent.finalize(input(inconsistent, { checks: [{ ...f.review.checks.at(-1)!, passed: false }],
    verdict: "revise", summary: "尚无该失败项的阻断依据" })), issueReason("missing_check_issue"));
  assert.deepEqual(inconsistent.snapshot(), initial);
  assert.equal(inconsistent.reference().missing.checks.length, 1);
  assert.equal(inconsistent.rejectedSnapshot!()!.checks.at(-1)!.passed, false);
});

test("未启用宿主批次的旧调用继续允许同值保存，不增加新无进展限制", async () => {
  const f = material(), writes: ({ "candidateHash": (string); "checks": ({ id: string; passed: boolean; evidence: string; }[]); "issues": (import("../../src/contracts/architecture.d.mjs").ArchitectureIssue[]); "acceptanceScopeChecks": ({ acceptanceId: string; adapterId: string; scope: string; sufficient: boolean; reason: string; criterionQuote: string; adapterQuote: string; }[]); "priorFindingDecisions": ({ findingId: string; status: string; reason: string; checkIds: string[]; candidatePaths: string[]; }[]); })[] = [], parts = createArchitectureReviewParts({ ...f.options, onSave: (value) => writes.push(value) });
  assert.equal(parts.reference().batch, undefined);
  const first = await parts.save(input(parts, { checks: [f.review.checks[0]] }));
  const second = await parts.save(input(parts, { checks: [f.review.checks[0]] }));
  assert.equal(first.changed, true); assert.equal(second.changed, false); assert.equal(second.saved, true);
  assert.equal(second.progressHash, first.progressHash); assert.equal(writes.length, 2);
  assert.equal(parts.snapshot().checks.length, 1);
});
