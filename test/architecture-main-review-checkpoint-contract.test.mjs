import test from "node:test";
import assert from "node:assert/strict";
import { hashValue } from "../src/development/development-contract.mjs";
import { createMainReviewCheckpoint, readMainReviewCheckpoint, mainReviewCheckpointMatches,
  MAIN_REVIEW_CHECKPOINT_MAX_BYTES } from "../src/architecture/architecture-main-review-checkpoint.mjs";
import { requirementItems, validateReview } from "../src/architecture/architecture-contract.mjs";
import { architectureReviewEvidenceContext } from "../src/architecture/architecture-review-evidence.mjs";
import { validDraft, validDesign, passingReview } from "./helpers/architecture.mjs";

function fixture() {
  const design = { schemaVersion: 3, decisions: [{ id: "one", choice: "synthetic design" }] };
  const candidateHash = hashValue(design);
  const record = { agentId: "synthetic_agent", name: "synthetic", version: 7, sourceFingerprint: "synthetic-source",
    draft: { task: "synthetic" }, requirements: [{ id: "one", text: "synthetic requirement" }], contractVersion: 3,
    candidateHash, design, platformContractVersion: 1, platformHash: "a".repeat(64), platformSnapshot: { version: 1 },
    capabilityCatalogVersion: 1, capabilitySnapshot: [{ id: "synthetic_capability" }], runtimeCapabilities: { version: 1 },
    confirmedRequirementContext: { hash: "confirmed" }, deferredVerifications: { version: 1 },
    evidence: [{ id: "source" }], modules: [{ result: "synthetic module" }], researchGaps: ["synthetic gap"],
    reviewContext: { candidateHash }, reviewEvidence: { version: 2, snapshot: { hash: "synthetic snapshot" } },
    priorFindings: { version: 1 }, issues: [{ id: "program", blocking: false }],
    developmentRevision: { schemaVersion: 1, trust: "untrusted-reference", source: { runId: "synthetic_run" } }, status: "failed", summary: "unfinished",
    review: null, attempts: [] };
  const review = { candidateHash, verdict: "pass", summary: "synthetic review", checks: [{ id: "one", passed: true,
    evidence: "fully resolved public quotation" }], issues: [], acceptanceScopeChecks: [{ acceptanceId: "one", sufficient: true }] };
  return { record, review };
}

test("checkpoint retains the complete resolved review as independent JSON and grants no status", () => {
  const { record, review } = fixture(), before = structuredClone(record);
  const checkpoint = createMainReviewCheckpoint(record, review, 3);
  assert.ok(checkpoint); assert.deepEqual(record, before); assert.deepEqual(checkpoint.review, review);
  assert.deepEqual(checkpoint.source, { agentId: record.agentId, architectureVersion: 7, candidateHash: record.candidateHash });
  assert.equal(checkpoint.reviewHash, hashValue(review)); assert.equal(checkpoint.modelCalls, 3); assert.equal(checkpoint.fidelityStatus, "pending");
  assert.equal(checkpoint.fidelityEvidence, null);
  record.mainReviewCheckpoint = checkpoint;
  const read = readMainReviewCheckpoint(record);
  assert.deepEqual(read, checkpoint); assert.notEqual(read, checkpoint); assert.notEqual(read.review, checkpoint.review);
  read.review.summary = "changed copy"; review.summary = "changed input";
  assert.equal(checkpoint.review.summary, "synthetic review"); assert.equal(record.review, null); assert.deepEqual(record.attempts, []);
});

test("every selected material participates in the complete binding", () => {
  const { record, review } = fixture(), checkpoint = createMainReviewCheckpoint(record, review, 1);
  const fields = ["name", "sourceFingerprint", "draft", "requirements", "contractVersion", "platformContractVersion", "platformHash",
    "platformSnapshot", "capabilityCatalogVersion", "capabilitySnapshot", "runtimeCapabilities", "confirmedRequirementContext",
    "deferredVerifications", "evidence", "modules", "researchGaps", "reviewContext", "reviewEvidence", "priorFindings", "issues", "developmentRevision"];
  for (const field of fields) {
    const changed = structuredClone(record); changed[field] = { changed: field };
    assert.equal(mainReviewCheckpointMatches(checkpoint, changed), false, field);
    changed.mainReviewCheckpoint = checkpoint; assert.equal(readMainReviewCheckpoint(changed), null, field);
  }
  for (const change of [
    (value) => { value.agentId = "other_agent"; },
    (value) => { value.candidateHash = "b".repeat(64); },
    (value) => { value.design.decisions[0].choice = "changed design"; },
    (value) => { value.design.decisions[0].choice = "changed design"; value.candidateHash = hashValue(value.design); },
  ]) {
    const changed = structuredClone(record); change(changed); assert.equal(mainReviewCheckpointMatches(checkpoint, changed), false);
  }
});

test("cross-version matching excludes lifecycle fields while strict reads require the original source version", () => {
  const { record, review } = fixture(), checkpoint = createMainReviewCheckpoint(record, review, 12);
  const next = { ...structuredClone(record), version: 8, status: "evaluating", summary: "new round", updatedAt: "later",
    diagnostic: { reason: "changed" }, diagnostics: ["changed"], reviewDiagnostics: ["changed"], requirementFidelity: { verdict: "unproven" },
    mainReviewCheckpoint: checkpoint };
  assert.equal(mainReviewCheckpointMatches(checkpoint, next), true); assert.equal(readMainReviewCheckpoint(next), null);
  next.version = 7;
  assert.deepEqual(readMainReviewCheckpoint(next), checkpoint);
});

test("read and matches reject structural changes, forged hashes and invalid call counts", () => {
  const { record, review } = fixture(), checkpoint = createMainReviewCheckpoint(record, review, 2);
  const mutations = [
    (value) => { value.extra = true; }, (value) => { delete value.modelCalls; },
    (value) => { value.source.extra = true; }, (value) => { value.source.agentId = "other_agent"; },
    (value) => { value.source.candidateHash = "0".repeat(64); }, (value) => { value.source.architectureVersion = 0; },
    (value) => { value.schemaVersion = 2; }, (value) => { value.modelCalls = 0; }, (value) => { value.modelCalls = 13; },
    (value) => { value.fidelityStatus = "preserved"; }, (value) => { value.fidelityStatus = "not_preserved"; },
    (value) => { delete value.fidelityStatus; },
    (value) => { delete value.fidelityEvidence; }, (value) => { value.fidelityEvidence = {}; },
    (value) => { value.modelCalls = 1.5; }, (value) => { value.hash = "0".repeat(64); },
    (value) => { value.bindingHash = "0".repeat(64); }, (value) => { value.reviewHash = "0".repeat(64); },
    (value) => { value.review.summary = "tampered"; }, (value) => { value.review.verdict = "unproven"; },
    (value) => { value.review.candidateHash = "0".repeat(64); },
  ];
  for (const change of mutations) {
    const changed = structuredClone(checkpoint); change(changed);
    assert.equal(mainReviewCheckpointMatches(changed, record), false);
    assert.equal(readMainReviewCheckpoint({ ...record, mainReviewCheckpoint: changed }), null);
  }
  const changed = structuredClone(checkpoint); changed.review.summary = "tampered";
  const { hash: _hash, ...body } = changed; changed.hash = hashValue(body);
  assert.equal(mainReviewCheckpointMatches(changed, record), false, "recomputing the outer hash cannot repair reviewHash");
});

test("invalid inputs skip checkpoint creation without throwing or invoking accessors", () => {
  const { record, review } = fixture();
  for (const modelCalls of [undefined, null, false, "1", 0, 13, 1.5, Infinity]) assert.equal(createMainReviewCheckpoint(record, review, modelCalls), null);
  for (const value of [null, [], {}, { ...review, verdict: "revise" }, { ...review, candidateHash: "0".repeat(64) }])
    assert.equal(createMainReviewCheckpoint(record, value, 1), null);
  let touched = 0;
  const getter = () => { touched++; throw new Error("must not access"); };
  const accessorReview = structuredClone(review); Object.defineProperty(accessorReview, "summary", { get: getter, enumerable: true });
  const accessorRecord = { ...record }; Object.defineProperty(accessorRecord, "requirements", { get: getter, enumerable: true });
  assert.equal(createMainReviewCheckpoint(record, accessorReview, 1), null);
  assert.equal(createMainReviewCheckpoint(accessorRecord, review, 1), null);
  assert.equal(readMainReviewCheckpoint(null), null); assert.equal(mainReviewCheckpointMatches(null, record), false);
  const checkpointRecord = { ...record }; Object.defineProperty(checkpointRecord, "mainReviewCheckpoint", { get: getter, enumerable: true });
  assert.equal(readMainReviewCheckpoint(checkpointRecord), null); assert.equal(touched, 0);
  const cyclic = { ...review }; cyclic.self = cyclic; assert.equal(createMainReviewCheckpoint(record, cyclic, 1), null);
  const sparse = { ...review, checks: Array(2) }; assert.equal(createMainReviewCheckpoint(record, sparse, 1), null);
  const proxy = new Proxy(review, { ownKeys: getter }); assert.equal(createMainReviewCheckpoint(record, proxy, 1), null);
  assert.equal(touched, 0);
});

test("not_preserved retains the full material binding and spent model calls without granting fidelity success", () => {
  const { record, review } = fixture(), pending = createMainReviewCheckpoint(record, review, 7);
  const evidence = { contextHash: "f".repeat(64), verdict: "narrowed", checks: [{ requirementId: "one", admissionPreserved: true,
    deliveryPreserved: false, newUnconfirmedRestriction: true }], restrictions: [{ candidatePath: "/decisions/0/choice",
    requirementId: "one", source: "requirements", path: "/0/text", quote: "synthetic requirement", reason: "synthetic restriction" }],
    modelCalls: 2, fidelityDiagnostic: { stopReason: "submitted" } };
  const checkpoint = createMainReviewCheckpoint(record, review, 7, { fidelityStatus: "not_preserved", fidelityEvidence: evidence });
  assert.equal(checkpoint.fidelityStatus, "not_preserved"); assert.equal(checkpoint.modelCalls, 7);
  assert.deepEqual(checkpoint.fidelityEvidence, evidence); assert.notEqual(checkpoint.fidelityEvidence, evidence);
  assert.equal(checkpoint.bindingHash, pending.bindingHash); assert.equal(checkpoint.reviewHash, pending.reviewHash);
  assert.notEqual(checkpoint.hash, pending.hash); assert.deepEqual(checkpoint.review, review);
  assert.deepEqual(readMainReviewCheckpoint({ ...record, mainReviewCheckpoint: checkpoint }), checkpoint);
  assert.equal(mainReviewCheckpointMatches(checkpoint, { ...record, version: record.version + 1 }), true);
  assert.equal(mainReviewCheckpointMatches(checkpoint, { ...record, requirements: [] }), false);
  const unproven = createMainReviewCheckpoint(record, review, 7, { fidelityStatus: "not_preserved",
    fidelityEvidence: { ...evidence, verdict: "unproven", restrictions: [] } });
  assert.equal(unproven.fidelityEvidence.verdict, "unproven");
  for (const fidelityEvidence of [null, [], {}, { ...evidence, verdict: "preserved" }, { ...evidence, contextHash: "invalid" }])
    assert.equal(createMainReviewCheckpoint(record, review, 7, { fidelityStatus: "not_preserved", fidelityEvidence }), null);
  assert.equal(createMainReviewCheckpoint(record, review, 7, { fidelityStatus: "pending", fidelityEvidence: evidence }), null);
  const changedEvidence = structuredClone(checkpoint); changedEvidence.fidelityEvidence.restrictions[0].reason = "tampered";
  assert.equal(mainReviewCheckpointMatches(changedEvidence, record), false);
  assert.equal(readMainReviewCheckpoint({ ...record, mainReviewCheckpoint: changedEvidence }), null);
  const invalidEvidence = { ...checkpoint, fidelityEvidence: { ...evidence, verdict: "preserved" } };
  const { hash: _evidenceHash, ...evidenceBody } = invalidEvidence; invalidEvidence.hash = hashValue(evidenceBody);
  assert.equal(mainReviewCheckpointMatches(invalidEvidence, record), false);
  const oversizedEvidence = { ...evidence, explanation: "中".repeat(MAIN_REVIEW_CHECKPOINT_MAX_BYTES) };
  assert.equal(createMainReviewCheckpoint(record, review, 7, { fidelityStatus: "not_preserved", fidelityEvidence: oversizedEvidence }), null);
  for (const fidelityStatus of [null, false, 0, "", "preserved", "unknown", {}])
    assert.equal(createMainReviewCheckpoint(record, review, 7, { fidelityStatus }), null);
  const invalid = { ...checkpoint, fidelityStatus: "preserved" };
  const { hash: _hash, ...body } = invalid; invalid.hash = hashValue(body);
  assert.equal(mainReviewCheckpointMatches(invalid, record), false);
  assert.equal(readMainReviewCheckpoint({ ...record, mainReviewCheckpoint: invalid }), null);
  assert.equal(createMainReviewCheckpoint(record, review, 7, null), null);
  assert.equal(record.review, null); assert.deepEqual(record.attempts, []);
});

test("review和范围证据各保留2MiB来源限额，合包包含两份来源及有界元数据", () => {
  const { record, review } = fixture(), small = { ...review, summary: "" };
  const available = 2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(small));
  const exact = createMainReviewCheckpoint(record, { ...review, summary: "中".repeat(Math.floor(available / 3)) + "x".repeat(available % 3) }, 1);
  assert.ok(exact); assert.equal(Buffer.byteLength(JSON.stringify(exact.review)), 2 * 1024 * 1024);
  assert.equal(createMainReviewCheckpoint(record, { ...exact.review, summary: exact.review.summary + "x" }, 1), null);
  assert.deepEqual(readMainReviewCheckpoint({ ...record, mainReviewCheckpoint: exact }), exact);
  const large = { ...exact, review: { ...exact.review, summary: exact.review.summary + "x" } };
  large.reviewHash = hashValue(large.review); const { hash: _hash, ...body } = large; large.hash = hashValue(body);
  assert.equal(mainReviewCheckpointMatches(large, record), false);
  const evidence = { verdict: "unproven", contextHash: "f".repeat(64), explanation: "" };
  evidence.explanation = "x".repeat(2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(evidence)));
  const aggregate = createMainReviewCheckpoint(record, exact.review, 7, { fidelityStatus: "not_preserved", fidelityEvidence: evidence });
  assert.ok(aggregate); assert.ok(Buffer.byteLength(JSON.stringify(aggregate)) > 4 * 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(aggregate)) <= MAIN_REVIEW_CHECKPOINT_MAX_BYTES);
  assert.deepEqual(readMainReviewCheckpoint({ ...record, mainReviewCheckpoint: aggregate }), aggregate);
  assert.equal(createMainReviewCheckpoint(record, exact.review, 7, { fidelityStatus: "not_preserved", fidelityEvidence: { ...evidence, explanation: evidence.explanation + "x" } }), null);
});

test("正式80项完整评审超过旧512KiB仍可保存读取，验收证据未被删减", () => {
  const { record } = fixture(), requirements = requirementItems(validDraft()), candidate = validDesign(requirements, { schemaVersion: 3 });
  candidate.acceptance = Array.from({ length: 80 }, (_, index) => ({ ...candidate.acceptance[index % 4], id: `case_${index}`, expected: "结".repeat(1000) }));
  record.design = candidate; record.candidateHash = hashValue(candidate); record.requirements = requirements;
  const review = passingReview(record.candidateHash, candidate);
  for (const row of review.acceptanceScopeChecks) row.reason = "核".repeat(1200);
  const evidenceContext = architectureReviewEvidenceContext({ design: candidate, requirements, runtimeCapabilities: null });
  assert.doesNotThrow(() => validateReview(review, { candidateHash: record.candidateHash, schemaVersion: 3, evidenceContext }));
  assert.ok(Buffer.byteLength(JSON.stringify(review)) > 512 * 1024);
  const checkpoint = createMainReviewCheckpoint(record, review, 12);
  assert.ok(checkpoint); assert.deepEqual(checkpoint.review, review); assert.equal(checkpoint.review.acceptanceScopeChecks.length, 80);
  assert.deepEqual(readMainReviewCheckpoint({ ...record, mainReviewCheckpoint: checkpoint }), checkpoint);
});
