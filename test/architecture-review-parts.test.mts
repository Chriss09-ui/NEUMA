import {fixtureToolAt,recordArray} from "./helpers/m7-test-boundaries.mjs";
import {fixtureString} from "./helpers/http-model.mjs";
import type {ReviewParts,ArchitectureIssue} from "../src/contracts/architecture.mjs";
type PartController=ReturnType<typeof createArchitectureReviewParts>;
type PartReference=ReturnType<PartController["reference"]>;
interface ModelPayload extends Record<string,unknown> {requirements:RequirementItem[];design:ReturnType<typeof validDesign>;candidateHash:string;priorFindings:NonNullable<Parameters<typeof passingReview>[2]>;reviewParts:PartReference & {saved:ReviewParts;rejectedDraft:ReviewParts}}
import { objectFields } from "../src/runtime/type-boundary.mjs";
import { fixtureTools } from "./helpers/m7-test-boundaries.mjs";
import { failureFields } from "./helpers/failure-fields.mjs";
import { toolText } from "./helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchitectureDesigner } from "../src/architecture/architecture.mjs";
import { designHash, reviewSubmissionSchema, validateReview } from "../src/architecture/architecture-contract.mjs";
import { architectureReviewEvidenceContext } from "../src/architecture/architecture-review-evidence.mjs";
import { createArchitectureEvidenceReader } from "../src/architecture/architecture-evidence-reader.mjs";
import { createArchitectureReviewParts, canonicalArchitectureReviewParts } from "../src/architecture/architecture-review-parts.mjs";
import { createReviewProgressCheckpoint, readReviewProgressCheckpoint, reviewProgressCheckpointMatches,
  advanceReviewProgressCheckpoint } from "../src/architecture/architecture-review-progress.mjs";
import { validDraft, validDesign, passingReview } from "./helpers/architecture.mjs";
import { fidelityResult } from "./helpers/fidelity.mjs";
import { createArchitectureStageSessionFactory } from "./helpers/architecture-stages.mjs";
import type { RequirementItem } from "../src/contracts/architecture.mjs";
import type { PiSessionOptions } from "../src/runtime/pi-port.mjs";

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

test("短引用保存为原文，旧会话回执及坏引用不能改写已有成果", async () => {
  const f = material(), parts = createArchitectureReviewParts(f.options);
  const scope = f.reader.index.acceptanceScope![0];
  await parts.save({ candidateHash: f.candidateHash, progressHash: parts.reference().progressHash,
    acceptanceScopeChecks: [{ acceptanceId: scope!.acceptanceId, adapterRulePath: scope!.adapterRulePaths[0], sufficient: true, reason: "核对原范围" }] });
  const before = parts.snapshot();
  assert.ok(before.acceptanceScopeChecks[0]!.criterionQuote); assert.equal(objectFields(before.acceptanceScopeChecks[0]).adapterRulePath, undefined);
  const read = JSON.parse(toolText((await f.reader.tool.execute("quote", { source: "candidate", pointer: "/acceptance/0/expected" }))));
  const otherReader = createArchitectureEvidenceReader({ context: f.context, candidateHash: f.candidateHash, role: "reviewer" });
  const resumed = createArchitectureReviewParts({ ...f.options, initial: before, resolve: otherReader.resolveSubmission });
  await assert.rejects(resumed.save({ candidateHash: f.candidateHash, progressHash: resumed.reference().progressHash,
    issues: [{ id: "precise", blocking: true, description: "核对事实", remedy: "核对当前原文", checkId: "verification", kind: "design",
      candidatePaths: ["/acceptance/0"], references: [{ receiptId: read.receiptId }], factClaims: [] }] }),
  error => failureFields(error).validationIssue!.reason === "invalid_receipt");
  await assert.rejects(resumed.save({ candidateHash: f.candidateHash, progressHash: resumed.reference().progressHash,
    acceptanceScopeChecks: [{ ...before.acceptanceScopeChecks[0], criterionQuote: "不存在的引文" }] }),
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
