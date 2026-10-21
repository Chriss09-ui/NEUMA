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
    checks: f.review.checks.slice(0, 3), acceptanceScopeChecks: [f.review.acceptanceScopeChecks[0]] });
  assert.equal(outcome.submitted, false); assert.equal(outcome.complete, false); assert.equal(saved.length, 1);
  assert.equal(outcome.missing.checks.length, 5); assert.equal(parts.snapshot().acceptanceScopeChecks.length, 1);
  assert.throws(() => parts.assemble({ candidateHash: f.candidateHash, progressHash: outcome.progressHash, verdict: "pass", summary: "尚不完整" }),
    error => error.validationIssue.reason === "missing_coverage");
  await assert.rejects(parts.save({ candidateHash: f.candidateHash, progressHash: first.progressHash, checks: [f.review.checks[3]] }),
    error => error.validationIssue.reason === "invalid_reference");
  const next = await parts.save({ candidateHash: f.candidateHash, progressHash: outcome.progressHash, checks: f.review.checks.slice(3),
    acceptanceScopeChecks: f.review.acceptanceScopeChecks.slice(1) });
  assert.deepEqual(parts.snapshot().checks.slice(0, 3), f.review.checks.slice(0, 3));
  const assembled = parts.assemble({ candidateHash: f.candidateHash, progressHash: next.progressHash, verdict: "pass", summary: "完整检查" });
  assert.equal(validateReview(assembled, { candidateHash: f.candidateHash, schemaVersion: 3, evidenceContext: f.context }).verdict, "pass");
});

test("短引用保存为原文，旧会话回执及坏引用不能改写已有成果", async () => {
  const f = material(), parts = createArchitectureReviewParts(f.options);
  const scope = f.reader.index.acceptanceScope[0];
  await parts.save({ candidateHash: f.candidateHash, progressHash: parts.reference().progressHash,
    acceptanceScopeChecks: [{ acceptanceId: scope.acceptanceId, adapterRulePath: scope.adapterRulePaths[0], sufficient: true, reason: "核对原范围" }] });
  const before = parts.snapshot();
  assert.ok(before.acceptanceScopeChecks[0].criterionQuote); assert.equal(before.acceptanceScopeChecks[0].adapterRulePath, undefined);
  const read = JSON.parse((await f.reader.tool.execute("quote", { source: "candidate", pointer: "/acceptance/0/expected" })).content[0].text);
  const otherReader = createArchitectureEvidenceReader({ context: f.context, candidateHash: f.candidateHash, role: "reviewer" });
  const resumed = createArchitectureReviewParts({ ...f.options, initial: before, resolve: otherReader.resolveSubmission });
  await assert.rejects(resumed.save({ candidateHash: f.candidateHash, progressHash: resumed.reference().progressHash,
    issues: [{ id: "precise", blocking: true, description: "核对事实", remedy: "核对当前原文", checkId: "verification", kind: "design",
      candidatePaths: ["/acceptance/0"], references: [{ receiptId: read.receiptId }], factClaims: [] }] }),
  error => error.validationIssue.reason === "invalid_receipt");
  await assert.rejects(resumed.save({ candidateHash: f.candidateHash, progressHash: resumed.reference().progressHash,
    acceptanceScopeChecks: [{ ...before.acceptanceScopeChecks[0], criterionQuote: "不存在的引文" }] }),
  error => error.validationIssue.reason === "reference_quote_mismatch");
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
      quote: f.design.acceptance[0].expected }], factClaims: [] };
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

async function recoveryFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "neuma-review-parts-recovery-")), calls = [];
  const draft = validDraft();
  draft.taskSpec = { version: 1, items: [{ id: "complete", dimension: "processing", content: "完整核对全部记录", applicability: "applies",
    critical: true, source: { kind: "user", evidence: [{ messageId: "source", quote: "完整核对全部记录" }] } }] };
  const definition = { id: "parts", name: "分项评审续接", fingerprint: "same-source", draft };
  const state = { resumed: false, oldReference: null, firstParts: null, fidelity: 0 };
  const sessionFactory = async (options) => {
    const tools = Object.fromEntries(options.customTools.map(tool => [tool.name, tool])), role = tools.submit_architecture ? "designer" : "reviewer";
    return { messages: [], modelCallAccounting: true, subscribe: () => () => {}, async abort() {}, dispose() {}, async prompt(text) {
      const payload = JSON.parse(text); calls.push({ role, resumed: state.resumed, payload }); await options.onModelCall();
      if (role === "designer") return tools.submit_architecture.execute("candidate", validDesign(payload.requirements, {
        schemaVersion: 3, connections: [], interaction: { defaultEntry: "conversation", page: false, operations: false, inputs: "全部记录", results: "完整结果", persistentData: "无" },
        execution: { language: "none", hosting: "builtin", reason: "已有文本能力" },
        selectionBasis: { capacity: "已确认边界", process: "完整处理", quality: "逐项核对", requirementIds: payload.requirements.map(row => row.id), assumptions: [] } }));
      const review = passingReview(payload.candidateHash, payload.design, payload.priorFindings);
      const scopeRows = review.acceptanceScopeChecks.map(({ acceptanceId, adapterId, sufficient, reason }) => ({
        acceptanceId, adapterRulePath: `/adapters/${adapterId}/proves`, sufficient, reason }));
      assert.ok(tools.save_architecture_review_parts); assert.ok(tools.submit_architecture_review_parts);
      const reference = payload.reviewParts;
      if (!state.resumed) {
        state.oldReference = reference;
        const saved = await tools.save_architecture_review_parts.execute("first", { candidateHash: payload.candidateHash,
          progressHash: reference.progressHash, checks: review.checks.slice(0, 3), acceptanceScopeChecks: scopeRows.slice(0, 1) });
        assert.equal(saved.terminate, undefined); state.firstParts = JSON.parse(saved.content[0].text);
        throw new Error("fetch failed");
      }
      assert.notEqual(reference.progressHash, state.firstParts.progressHash, "重启生成新的宿主CAS编号");
      assert.deepEqual(reference.saved.checks, review.checks.slice(0, 3));
      assert.equal(reference.missing.checks.length, 5);
      assert.equal(reference.missing.acceptanceScopeChecks.length, review.acceptanceScopeChecks.length - 1);
      await assert.rejects(tools.submit_architecture_review_parts.execute("stale", { candidateHash: payload.candidateHash,
        progressHash: state.firstParts.progressHash, verdict: "pass", summary: "旧编号不能提交" }));
      await assert.rejects(tools.submit_architecture_review_parts.execute("missing", { candidateHash: payload.candidateHash,
        progressHash: reference.progressHash, verdict: "pass", summary: "缺项不能提交" }));
      const saved = JSON.parse((await tools.save_architecture_review_parts.execute("remaining", { candidateHash: payload.candidateHash,
        progressHash: reference.progressHash, checks: review.checks.slice(3), acceptanceScopeChecks: scopeRows.slice(1),
        ...(review.priorFindingDecisions ? { priorFindingDecisions: review.priorFindingDecisions } : {}) })).content[0].text);
      return tools.submit_architecture_review_parts.execute("formal", { candidateHash: payload.candidateHash,
        progressHash: saved.progressHash, verdict: "pass", summary: "已完整核对当前方案" });
    } };
  };
  const fidelitySessionFactory = async (options) => ({ messages: [], modelCallAccounting: true, subscribe: () => () => {},
    async abort() {}, dispose() {}, setAutoCompactionEnabled() {}, async prompt(text) {
      await options.onModelCall(); state.fidelity++; return options.customTools[0].execute("scope", fidelityResult(JSON.parse(text)));
    } });
  const make = () => new ArchitectureDesigner({ config: { llmConfigured: true }, cwd: root, dataDir: join(root, "data"), sessionFactory, fidelitySessionFactory });
  let designer = make();
  t.after(async () => { await designer.persistence; await rm(root, { recursive: true, force: true }); });
  return { state, calls, definition, get designer() { return designer; }, reload: async () => { await designer.persistence; designer = make(); await designer.ready; } };
}

test("离线端到端：保存部分评审后重启，只补缺项并正式独立复核，累计预算不重置", async (t) => {
  const f = await recoveryFixture(t);
  await assert.rejects(f.designer.design(f.definition), error => error.diagnostic.reason === "api_connection");
  const source = await f.designer.get(f.definition.id), before = designHash(source);
  const checkpoint = readReviewProgressCheckpoint(source);
  assert.equal(checkpoint.schemaVersion, 2); assert.equal(checkpoint.modelCalls, 1); assert.equal(checkpoint.review, null);
  assert.equal(source.review, null); assert.deepEqual(source.attempts, []); assert.equal(f.state.fidelity, 0);
  const charged = advanceReviewProgressCheckpoint(source, 2);
  assert.deepEqual(charged.parts, checkpoint.parts); assert.equal(charged.modelCalls, 2);
  const altered = structuredClone(source);
  altered.reviewProgressCheckpoint.parts.acceptanceScopeChecks[0].criterionQuote = "不存在的逐字依据";
  altered.reviewProgressCheckpoint.partsHash = designHash(altered.reviewProgressCheckpoint.parts);
  const { hash: _hash, ...body } = altered.reviewProgressCheckpoint;
  altered.reviewProgressCheckpoint.hash = designHash(body);
  assert.equal(readReviewProgressCheckpoint(altered), null, "即使重算摘要，错误原文也不能恢复为已保存分项");
  assert.equal(advanceReviewProgressCheckpoint({ ...source, reviewProgressCheckpoint: charged }, 1), null);
  for (const key of ["platformHash", "runtimeCapabilities", "confirmedRequirementContext", "deferredVerifications", "sourceFingerprint", "priorFindings"])
    assert.equal(reviewProgressCheckpointMatches(checkpoint, { ...source, [key]: { changed: true } }), false, key);
  const changed = structuredClone(source); changed.design.instructions += " changed"; changed.candidateHash = designHash(changed.design);
  assert.equal(reviewProgressCheckpointMatches(checkpoint, changed), false);
  await f.reload(); f.state.resumed = true;
  const result = await f.designer.design(f.definition);
  assert.deepEqual(f.calls.filter(row => row.resumed).map(row => row.role), ["reviewer"]);
  assert.equal(result.status, "passed"); assert.equal(result.review.verdict, "pass"); assert.equal(f.state.fidelity, 1);
  assert.equal(result.reviewProgressCheckpoint.modelCalls, 3); assert.equal(result.attempts.length, 1);
  assert.equal(designHash(await f.designer.getVersion(f.definition.id, source.version)), before);
});
