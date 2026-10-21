import test from "node:test";
import assert from "node:assert/strict";
import { hashValue } from "../src/development/development-contract.mjs";
import { reviewSubmissionSchema } from "../src/architecture/architecture-contract.mjs";
import { createArchitectureSubmissionRepair } from "../src/architecture/architecture-submission-repair.mjs";
import { createMainReviewCheckpoint } from "../src/architecture/architecture-main-review-checkpoint.mjs";
import { copyArchitectureReviewJson, architectureReviewRecordBinding } from "../src/architecture/architecture-review-binding.mjs";
import { createReviewProgressCheckpoint, readReviewProgressCheckpoint, reviewProgressCheckpointMatches,
  advanceReviewProgressCheckpoint, readLegacyReviewProgressCheckpoint, REVIEW_PROGRESS_CHECKPOINT_MAX_BYTES } from "../src/architecture/architecture-review-progress.mjs";
import { architectureReviewEvidenceContext } from "../src/architecture/architecture-review-evidence.mjs";
import { passingReview } from "./helpers/architecture.mjs";

function fixture() {
  const design = { schemaVersion: 3, decisions: [{ id: "one", choice: "synthetic design" }], acceptance: [{ id: "one",
    expected: "synthetic output", verification: { stage: "development", owner: "generated-code", adapterId: "action" } }] };
  const candidateHash = hashValue(design);
  const record = { agentId: "synthetic_agent", name: "synthetic", version: 7, sourceFingerprint: "synthetic-source",
    draft: { task: "synthetic" }, requirements: [{ id: "one", text: "synthetic requirement" }], contractVersion: 3,
    candidateHash, design, platformContractVersion: 1, platformHash: "a".repeat(64), platformSnapshot: { version: 1 },
    capabilityCatalogVersion: 1, capabilitySnapshot: [{ id: "synthetic_capability" }], runtimeCapabilities: { version: 1 },
    confirmedRequirementContext: { hash: "confirmed" }, deferredVerifications: { version: 1 },
    evidence: [{ id: "source" }], modules: [{ result: "synthetic module" }], researchGaps: ["synthetic gap"],
    reviewContext: { candidateHash }, reviewEvidence: { version: 2, snapshot: { hash: "synthetic snapshot" } },
    issues: [{ id: "program", blocking: false }], developmentRevision: { schemaVersion: 1, source: { runId: "synthetic_run" } },
    status: "failed", summary: "unfinished", review: null, attempts: [] };
  const review = passingReview(candidateHash, design);
  return { record, review };
}

function rejectedReview(review) {
  const result = structuredClone(review); result.verdict = "revise"; result.checks.find((row) => row.id === "feasibility").passed = false;
  result.issues.push({ id: "bad_quote", blocking: true, description: "Synthetic unresolved semantic finding", remedy: "Check the current quotation",
    checkId: "feasibility", kind: "design", candidatePaths: ["/decisions/0/choice"],
    references: [{ source: "candidate", path: "/decisions/0/choice", quote: "deliberately unmatched quotation" }], factClaims: [] });
  return result;
}

test("progress stores only a complete canonical draft and grants no formal submission or pass", () => {
  const { record, review } = fixture(), before = structuredClone(record);
  const checkpoint = createReviewProgressCheckpoint(record, review, 2, { origin: "unsubmitted",
    diagnostic: { reason: "submission_incomplete", submissionAttempts: 0, submissionContinuations: 1 } });
  assert.ok(checkpoint); assert.equal(checkpoint.origin, "unsubmitted"); assert.equal(checkpoint.reviewHash, hashValue(review));
  assert.deepEqual(record, before); record.reviewProgressCheckpoint = checkpoint;
  const loaded = readReviewProgressCheckpoint(record);
  assert.deepEqual(loaded, checkpoint); assert.notEqual(loaded.review, review); loaded.review.summary = "changed";
  assert.notEqual(checkpoint.review.summary, loaded.review.summary); assert.equal(record.review, null); assert.deepEqual(record.attempts, []);
  assert.equal(Object.hasOwn(checkpoint, "submitted"), false); assert.equal(Object.hasOwn(checkpoint, "fidelityStatus"), false);
});

test("structurally valid rejected reviews remain drafts requiring fresh semantic evaluation", () => {
  const { record, review } = fixture(), invalidSemantics = rejectedReview(review);
  const checkpoint = createReviewProgressCheckpoint(record, invalidSemantics, 6, { origin: "semantic-rejected",
    diagnostic: { reason: "invalid_result", lastSubmissionIssue: { path: "review.issues[0].references[0]", reason: "reference_quote_mismatch" } } });
  assert.ok(checkpoint); assert.deepEqual(checkpoint.review, invalidSemantics); assert.equal(checkpoint.origin, "semantic-rejected");
  assert.equal(record.review, null); assert.equal(record.status, "failed");
  assert.equal(createReviewProgressCheckpoint(record, invalidSemantics, 6, { origin: "semantic-rejected", validateDraft: () => false }), null);
  assert.equal(createReviewProgressCheckpoint(record, invalidSemantics, 6, { origin: "semantic-rejected", validateDraft: () => { throw new Error("invalid structure"); } }), null);
});

test("budget-only progress is saved before a draft exists and never rolls back spent calls", () => {
  const { record } = fixture();
  const initial = advanceReviewProgressCheckpoint(record, 0);
  assert.ok(initial); assert.equal(initial.review, null); assert.equal(initial.reviewHash, null); assert.equal(initial.origin, "none");
  record.reviewProgressCheckpoint = initial;
  const charged = advanceReviewProgressCheckpoint(record, 1, { diagnostic: { reason: "cancelled" } });
  assert.equal(charged.modelCalls, 1); assert.equal(charged.review, null);
  record.reviewProgressCheckpoint = charged;
  assert.equal(advanceReviewProgressCheckpoint(record, 0), null);
  assert.equal(advanceReviewProgressCheckpoint(record, 12).modelCalls, 12);
  for (const count of [undefined, null, false, "1", -1, 13, 1.5, Infinity]) assert.equal(advanceReviewProgressCheckpoint(record, count), null);
});

test("later malformed or short-form submissions preserve the last complete draft while charging budget", () => {
  const { record, review } = fixture(), draft = rejectedReview(review);
  record.reviewProgressCheckpoint = createReviewProgressCheckpoint(record, draft, 4, { origin: "semantic-rejected" });
  for (const invalid of [{}, { ...review, checks: "invalid" }, { ...review, acceptanceScopeChecks: [{ scopeReceiptId: "old-session" }] }]) {
    const next = advanceReviewProgressCheckpoint(record, 5, { review: invalid, origin: "unsubmitted",
      diagnostic: { reason: "schema_rejected", submissionAttempts: 2 } });
    assert.equal(next.modelCalls, 5); assert.deepEqual(next.review, draft); assert.equal(next.origin, "semantic-rejected");
    assert.deepEqual(next.diagnostic, { reason: "schema_rejected", submissionAttempts: 2 });
  }
  const next = advanceReviewProgressCheckpoint(record, 6, { review, origin: "unsubmitted" });
  assert.deepEqual(next.review, review); assert.equal(next.origin, "unsubmitted"); assert.equal(next.modelCalls, 6);
  assert.equal(record.reviewProgressCheckpoint.modelCalls, 4);
  const budgetOnly = { ...record }; delete budgetOnly.reviewProgressCheckpoint;
  assert.equal(advanceReviewProgressCheckpoint(budgetOnly, 2, { review: {}, origin: "unsubmitted" }).review, null);
});

test("full material binding matches the existing validated checkpoint but ignores lifecycle state", () => {
  const { record, review } = fixture(), checkpoint = createReviewProgressCheckpoint(record, review, 2, { origin: "unsubmitted" });
  assert.equal(checkpoint.bindingHash, createMainReviewCheckpoint(record, review, 2).bindingHash);
  const fields = ["name", "sourceFingerprint", "draft", "requirements", "contractVersion", "platformContractVersion", "platformHash",
    "platformSnapshot", "capabilityCatalogVersion", "capabilitySnapshot", "runtimeCapabilities", "confirmedRequirementContext",
    "deferredVerifications", "evidence", "modules", "researchGaps", "reviewContext", "reviewEvidence", "priorFindings", "issues", "developmentRevision"];
  for (const field of fields) {
    const changed = structuredClone(record); changed[field] = { changed: field };
    assert.equal(reviewProgressCheckpointMatches(checkpoint, changed), false, field);
    assert.equal(readReviewProgressCheckpoint({ ...changed, reviewProgressCheckpoint: checkpoint }), null, field);
  }
  for (const modify of [(value) => { value.agentId = "other_agent"; }, (value) => { value.candidateHash = "b".repeat(64); },
    (value) => { value.design.decisions[0].choice = "changed"; },
    (value) => { value.design.decisions[0].choice = "changed"; value.candidateHash = hashValue(value.design); }]) {
    const changed = structuredClone(record); modify(changed); assert.equal(reviewProgressCheckpointMatches(checkpoint, changed), false);
  }
  const next = { ...structuredClone(record), version: 8, status: "evaluating", summary: "new round", diagnostic: { reason: "later" },
    reviewDiagnostics: ["later"], reviewProgressCheckpoint: checkpoint };
  assert.equal(reviewProgressCheckpointMatches(checkpoint, next), true); assert.equal(readReviewProgressCheckpoint(next), null);
  const renewed = createReviewProgressCheckpoint(next, checkpoint.review, checkpoint.modelCalls, checkpoint);
  assert.equal(renewed.source.architectureVersion, 8); assert.deepEqual(renewed.review, checkpoint.review);
  assert.equal(renewed.modelCalls, checkpoint.modelCalls); assert.equal(renewed.bindingHash, checkpoint.bindingHash);
});

test("canonical progress cannot restore short evidence receipts, session nonces, or old submission identifiers", () => {
  const { record, review } = fixture();
  for (const key of ["receiptId", "scopeReceiptId", "adapterRulePath", "nonce", "submissionHash", "draftHash"])
    assert.equal(createReviewProgressCheckpoint(record, { ...review, [key]: "old-session" }, 1, { origin: "unsubmitted" }), null, key);
  const source = createReviewProgressCheckpoint(record, review, 2, { origin: "unsubmitted" });
  const schema = reviewSubmissionSchema({ evidenceRequired: true });
  const first = createArchitectureSubmissionRepair({ schema }), second = createArchitectureSubmissionRepair({ schema });
  const oldRef = first.capture(source.review), freshRef = second.capture(source.review);
  assert.notEqual(oldRef.submissionHash, freshRef.submissionHash);
  assert.throws(() => second.apply({ submissionHash: oldRef.submissionHash, updates: [{ path: "/summary", value: "changed" }] }), /变化|无效/u);
  assert.equal(createReviewProgressCheckpoint(record, { ...review, summary: "The ordinary words nonce and receiptId are explanatory text." }, 1,
    { origin: "unsubmitted" }).review.summary, "The ordinary words nonce and receiptId are explanatory text.");
});

test("progress rejects tampering, mismatched origin, invalid hashes and extra persisted fields", () => {
  const { record, review } = fixture(), checkpoint = createReviewProgressCheckpoint(record, review, 3, { origin: "unsubmitted" });
  const mutations = [(value) => { value.extra = true; }, (value) => { value.source.extra = true; }, (value) => { value.modelCalls = 13; },
    (value) => { value.modelCalls = -1; }, (value) => { value.origin = "formal"; }, (value) => { value.origin = "none"; },
    (value) => { value.review = null; }, (value) => { value.source.agentId = "other_agent"; }, (value) => { value.source.architectureVersion = 0; },
    (value) => { value.review.candidateHash = "0".repeat(64); }, (value) => { value.review.summary = "tampered"; },
    (value) => { value.hash = "0".repeat(64); }, (value) => { value.reviewHash = "0".repeat(64); }, (value) => { value.bindingHash = "0".repeat(64); }];
  for (const mutate of mutations) {
    const changed = structuredClone(checkpoint); mutate(changed);
    assert.equal(reviewProgressCheckpointMatches(changed, record), false);
    assert.equal(readReviewProgressCheckpoint({ ...record, reviewProgressCheckpoint: changed }), null);
  }
  const changed = structuredClone(checkpoint); changed.review.summary = "changed";
  const { hash: _hash, ...body } = changed; changed.hash = hashValue(body);
  assert.equal(reviewProgressCheckpointMatches(changed, record), false);
  assert.equal(createReviewProgressCheckpoint(record, null, 1, { origin: "unsubmitted" }), null);
  assert.equal(createReviewProgressCheckpoint(record, review, 1, { origin: "none" }), null);
});

test("diagnostics accept bounded public issue codes and counts without retaining model text", () => {
  const { record } = fixture();
  for (const diagnostic of [{ thinking: "private" }, { reason: "full model response with spaces" }, { issues: [{ path: "review", reason: "bad", remedy: "untrusted text" }] },
    { lastSubmissionIssue: { path: "review\nprivate", reason: "invalid_value" } }, { submissionAttempts: -1 },
    { issues: Array.from({ length: 41 }, () => ({ path: "review", reason: "invalid_value" })) }])
    assert.equal(createReviewProgressCheckpoint(record, null, 1, { diagnostic }), null);
  const checkpoint = createReviewProgressCheckpoint(record, null, 1, { diagnostic: { reason: "cancelled", submissionAttempts: 7,
    localRevisions: 6, issues: [{ path: "review.issues[0].references[1]", reason: "reference_quote_mismatch" }] } });
  assert.ok(checkpoint); assert.equal(checkpoint.review, null); assert.doesNotMatch(JSON.stringify(checkpoint), /thinking|private/u);
});

test("untrusted objects, accessors, sparse arrays and excessive JSON depth do not execute or escape validation", () => {
  const { record, review } = fixture(); let touched = 0;
  const getter = () => { touched++; throw new Error("must not invoke"); };
  const accessorRecord = { ...record }; Object.defineProperty(accessorRecord, "requirements", { get: getter, enumerable: true });
  const accessorReview = { ...review }; Object.defineProperty(accessorReview, "summary", { get: getter, enumerable: true });
  const accessorOptions = {}; Object.defineProperty(accessorOptions, "origin", { get: getter, enumerable: true });
  const proxy = new Proxy(review, { ownKeys: getter });
  for (const [value, draft, options] of [[accessorRecord, review, { origin: "unsubmitted" }], [record, accessorReview, { origin: "unsubmitted" }],
    [record, proxy, { origin: "unsubmitted" }], [record, review, accessorOptions], [record, { ...review, checks: Array(8) }, { origin: "unsubmitted" }]])
    assert.equal(createReviewProgressCheckpoint(value, draft, 1, options), null);
  const cyclic = { ...review }; cyclic.self = cyclic;
  assert.equal(createReviewProgressCheckpoint(record, cyclic, 1, { origin: "unsubmitted" }), null);
  const checkpointRecord = { ...record }; Object.defineProperty(checkpointRecord, "reviewProgressCheckpoint", { get: getter, enumerable: true });
  assert.equal(readReviewProgressCheckpoint(checkpointRecord), null); assert.equal(advanceReviewProgressCheckpoint(checkpointRecord, 1), null);
  assert.equal(touched, 0);
  const nested = {}; let cursor = nested; for (let index = 0; index < 65; index++) { cursor.next = {}; cursor = cursor.next; }
  assert.throws(() => copyArchitectureReviewJson(nested), /limits/u);
  assert.throws(() => copyArchitectureReviewJson({ many: [1, 2, 3] }, { maxNodes: 3 }), /limits/u);
  assert.equal(architectureReviewRecordBinding(null), null);
});

test("the complete UTF-8 progress checkpoint, including envelope and hash, has a 256 KiB cap", () => {
  const { record, review } = fixture(), large = rejectedReview(review);
  const issue = large.issues[0]; large.issues = Array.from({ length: 21 }, (_, index) => ({ ...issue, id: `finding_${index}`,
    description: "中".repeat(2000), remedy: "中".repeat(2000) }));
  const small = createReviewProgressCheckpoint(record, large, 2, { origin: "semantic-rejected" });
  assert.ok(small);
  const available = REVIEW_PROGRESS_CHECKPOINT_MAX_BYTES - Buffer.byteLength(JSON.stringify(small));
  assert.ok(available > 0 && available < 12_000);
  const tail = { ...issue, id: "tail", description: "x", remedy: "x" }; large.issues.push(tail);
  const base = createReviewProgressCheckpoint(record, large, 2, { origin: "semantic-rejected" }); assert.ok(base);
  const remaining = REVIEW_PROGRESS_CHECKPOINT_MAX_BYTES - Buffer.byteLength(JSON.stringify(base));
  tail.description += "中".repeat(Math.floor(remaining / 3)); tail.remedy += "x".repeat(remaining % 3);
  const exact = createReviewProgressCheckpoint(record, large, 2, { origin: "semantic-rejected" });
  assert.ok(exact); assert.equal(Buffer.byteLength(JSON.stringify(exact)), REVIEW_PROGRESS_CHECKPOINT_MAX_BYTES);
  assert.deepEqual(readReviewProgressCheckpoint({ ...record, reviewProgressCheckpoint: exact }), exact);
  tail.remedy += "x"; assert.equal(createReviewProgressCheckpoint(record, large, 2, { origin: "semantic-rejected" }), null);
});

function legacyFixture(modelCalls = 1) {
  const { record } = fixture();
  record.diagnostic = { stage: "architecture", role: "reviewer", phase: "evaluating", reason: "cancelled", modelCalls };
  record.reviewContext = { candidateHash: record.candidateHash, platformHash: record.platformHash };
  const current = architectureReviewEvidenceContext({ design: record.design, requirements: record.requirements,
    runtimeCapabilities: record.runtimeCapabilities, evidence: record.evidence,
    confirmedRequirementContext: record.confirmedRequirementContext, deferredVerifications: record.deferredVerifications });
  const body = { version: 1, ...record.reviewContext, acceptanceAdapterGuide: current.acceptanceAdapterGuide, contextManifest: current.contextManifest };
  record.reviewEvidence = { version: 2, snapshot: { ...body, hash: hashValue(body) }, snapshotHash: hashValue(body) };
  return record;
}

test("legacy reviewer counts 1 and 12 become bound budget-only checkpoints without mutating the old record", () => {
  for (const used of [1, 12]) {
    const record = legacyFixture(used), before = structuredClone(record), checkpoint = readLegacyReviewProgressCheckpoint(record);
    assert.ok(checkpoint); assert.equal(checkpoint.modelCalls, used); assert.equal(checkpoint.origin, "none");
    assert.equal(checkpoint.review, null); assert.equal(checkpoint.reviewHash, null); assert.deepEqual(checkpoint.diagnostic, { reason: "cancelled" });
    assert.equal(checkpoint.bindingHash, architectureReviewRecordBinding(record).bindingHash);
    assert.deepEqual(record, before); assert.equal(Object.hasOwn(record, "reviewProgressCheckpoint"), false);
    assert.deepEqual(readReviewProgressCheckpoint({ ...record, reviewProgressCheckpoint: checkpoint }), checkpoint);
    assert.equal(advanceReviewProgressCheckpoint({ ...record, reviewProgressCheckpoint: checkpoint }, used - 1), null);
  }
});

test("legacy fallback requires both modern checkpoint fields to be absent, including corrupt or undefined own fields", () => {
  for (const field of ["reviewProgressCheckpoint", "mainReviewCheckpoint"]) {
    for (const value of [undefined, null, {}, { modelCalls: 1 }]) {
      const record = legacyFixture(12); record[field] = value;
      assert.equal(readLegacyReviewProgressCheckpoint(record), null, field);
    }
    let reads = 0; const record = legacyFixture(12);
    Object.defineProperty(record, field, { enumerable: true, get() { reads++; throw new Error("private"); } });
    assert.equal(readLegacyReviewProgressCheckpoint(record), null); assert.equal(reads, 0);
  }
});

test("legacy counts use the maximum reviewer history and never add designer or other-role counters", () => {
  const record = legacyFixture(3); let unrelatedReads = 0;
  record.reviewDiagnostics = [{ role: "designer", phase: "designing", get modelCalls() { unrelatedReads++; throw new Error("private"); } },
    { role: "specialist", modelCalls: 99 }, { role: "reviewer", modelCalls: 12 },
    { role: "reviewer", phase: "evaluating", modelCalls: 2 }];
  assert.equal(readLegacyReviewProgressCheckpoint(record).modelCalls, 12); assert.equal(unrelatedReads, 0);
  for (const used of [undefined, null, "12", 0, -1, 13, 1.5, Infinity]) {
    const changed = legacyFixture(); changed.diagnostic.modelCalls = used; assert.equal(readLegacyReviewProgressCheckpoint(changed), null);
  }
  for (const [key, value] of [["stage", "development"], ["role", "designer"], ["phase", "designing"]]) {
    const changed = legacyFixture(12); changed.diagnostic[key] = value; assert.equal(readLegacyReviewProgressCheckpoint(changed), null);
  }
  for (const used of [undefined, null, "12", -1, 13, 1.5]) {
    const changed = legacyFixture(3); changed.reviewDiagnostics = [{ role: "reviewer", phase: "evaluating", modelCalls: used }];
    assert.equal(readLegacyReviewProgressCheckpoint(changed), null);
  }
});

test("legacy source and frozen manifest corruption fail closed without reading private fields or accessors", () => {
  const changes = [(record) => { record.agentId = ""; }, (record) => { record.candidateHash = "0".repeat(64); },
    (record) => { record.design.decisions[0].choice = "changed"; }, (record) => { delete record.requirements; },
    (record) => { delete record.reviewEvidence.snapshot; }, (record) => { record.reviewContext.platformHash = "0".repeat(64); },
    (record) => { record.reviewEvidence.snapshot.contextManifest.candidate.sha256 = "0".repeat(64); },
    (record) => { const snapshot = record.reviewEvidence.snapshot; snapshot.contextManifest.requirements.characters++;
      const { hash: ignored, ...body } = snapshot; snapshot.hash = hashValue(body); record.reviewEvidence.snapshotHash = snapshot.hash; }];
  for (const change of changes) { const record = legacyFixture(12); change(record); assert.equal(readLegacyReviewProgressCheckpoint(record), null); }
  let reads = 0; const fail = () => { reads++; throw new Error("PRIVATE_THINKING"); };
  for (const field of ["diagnostic", "reviewDiagnostics", "reviewEvidence"]) {
    const record = legacyFixture(12); Object.defineProperty(record, field, { enumerable: true, get: fail });
    assert.equal(readLegacyReviewProgressCheckpoint(record), null);
  }
  const record = legacyFixture(12); Object.defineProperty(record.diagnostic, "thinking", { enumerable: true, get: fail });
  assert.ok(readLegacyReviewProgressCheckpoint(record)); assert.equal(reads, 0);
  const sparse = legacyFixture(12); sparse.reviewDiagnostics = Array(1); assert.equal(readLegacyReviewProgressCheckpoint(sparse), null);
  const accessor = legacyFixture(12); accessor.reviewDiagnostics = [];
  Object.defineProperty(accessor.reviewDiagnostics, "0", { enumerable: true, get: fail });
  assert.equal(readLegacyReviewProgressCheckpoint(accessor), null); assert.equal(reads, 0);
});
