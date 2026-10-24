import { callFixture } from "./helpers/m7-test-boundaries.mjs";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { hashValue } from "../src/development/development-contract.mjs";
import { createMainReviewCheckpoint } from "../src/architecture/architecture-main-review-checkpoint.mjs";
import { createArchitectureFidelityProgress, readArchitectureFidelityProgress, architectureFidelityProgressMatches }
  from "../src/architecture/architecture-fidelity-progress.mjs";

function fixture() {
  const design = { schemaVersion: 3, decisions: [{ id: "one", choice: "synthetic design" }] }, candidateHash = hashValue(design);
  const baseRecord = { agentId: "synthetic_agent", name: "synthetic", version: 7, sourceFingerprint: "synthetic-source",
    draft: { task: "synthetic" }, requirements: [{ id: "one", text: "synthetic requirement" }], contractVersion: 3,
    candidateHash, design, platformContractVersion: 1, platformHash: "a".repeat(64), platformSnapshot: { version: 1 },
    capabilityCatalogVersion: 1, capabilitySnapshot: [{ id: "synthetic_capability" }], runtimeCapabilities: { version: 1 },
    confirmedRequirementContext: { hash: "confirmed" }, deferredVerifications: { version: 1 },
    evidence: [{ id: "source" }], modules: [{ result: "synthetic module" }], researchGaps: ["synthetic gap"],
    reviewContext: { candidateHash }, reviewEvidence: { version: 2, snapshot: { hash: "synthetic snapshot" } },
    priorFindings: { version: 1 }, issues: [{ id: "program", blocking: false }],
    developmentRevision: { source: { runId: "synthetic_run" } }, status: "cancelled", review: null, attempts: [] };
  const review = { candidateHash, verdict: "pass", summary: "synthetic passed review", checks: [], issues: [] };
  const record = Object.assign(baseRecord, { mainReviewCheckpoint: createMainReviewCheckpoint(baseRecord, review, 11) });
  const state = { contextHash: "b".repeat(64), schemaHash: "c".repeat(64), sessionFile: "2026-10-20_fixture.jsonl",
    sessionBindingHash: "d".repeat(64), calls: 1, diagnostic: { contextHash: "b".repeat(64), modelCalls: 1,
      submissionAttempts: 1, schemaRejections: 0, semanticRejections: 1, stopReason: "cancelled",
      lastSubmission: { stage: "semantic", issues: [{ path: "fidelity.restrictions[0].quote", reason: "reference_quote_mismatch",
        remedy: "Use an exact quotation from the bound source." }] } } };
  return { record: record as typeof record & { requirementFidelityProgress?: ReturnType<typeof createArchitectureFidelityProgress> }, review, state };
}

function rehash<T extends { hash?: unknown }>(value: T) {
  const { hash: _hash, ...body } = value;
  return { ...body, hash: hashValue(body) };
}

test("progress keeps only the bound native reference, exact safe feedback and cumulative counts as independent JSON", () => {
  const { record, state } = fixture(), before = structuredClone(record);
  const progress = createArchitectureFidelityProgress(record, state, 11);
  assert.ok(progress); assert.deepEqual(record, before); assert.deepEqual(progress.state, state);
  assert.deepEqual(progress.source, { agentId: record.agentId, architectureVersion: 7, candidateHash: record.candidateHash,
    reviewHash: record.mainReviewCheckpoint!.reviewHash });
  assert.equal(progress.bindingHash, record.mainReviewCheckpoint!.bindingHash); assert.equal(progress.parentModelCalls, 11);
  record.requirementFidelityProgress = progress;
  const read = readArchitectureFidelityProgress(record);
  assert.deepEqual(read, progress); assert.notEqual(read, progress); assert.notEqual(read.state.diagnostic, progress.state.diagnostic);
  state.diagnostic!.lastSubmission.issues[0]!.reason = "changed input"; objectFields(objectFields(objectFields(read.state.diagnostic.lastSubmission).issues)[0]).reason = "changed output";
  assert.equal(progress.state!.diagnostic.lastSubmission.issues[0]!.reason, "reference_quote_mismatch");
  assert.equal(record.status, "cancelled"); assert.equal(record.review, null); assert.deepEqual(record.attempts, []);
  assert.ok(Buffer.byteLength(JSON.stringify(progress)) <= 64 * 1024);
});

test("child and parent call bounds retain zero and exhaustion without allowing reset below child usage", () => {
  const { record, state } = fixture();
  for (const [calls, parentModelCalls] of [[0, 0], [0, 12], [1, 11], [2, 2], [2, 12]]) {
    const progress = createArchitectureFidelityProgress(record, { ...state, calls }, parentModelCalls);
    assert.ok(progress); assert.equal(progress.state.calls, calls); assert.equal(progress.parentModelCalls, parentModelCalls);
    assert.deepEqual(readArchitectureFidelityProgress({ ...record, requirementFidelityProgress: progress }), progress);
  }
  for (const calls of [undefined, null, false, "1", -1, 3, 1.5, Infinity])
    assert.equal(createArchitectureFidelityProgress(record, { ...state, calls }, 12), null);
  for (const parent of [undefined, null, false, "11", -1, 13, 1.5, Infinity, 0])
    assert.equal(createArchitectureFidelityProgress(record, state, parent), null);
  const progress = createArchitectureFidelityProgress(record, { ...state, calls: 2 }, 12);
  for (const parentModelCalls of [0, 1, 13]) {
    const changed = rehash({ ...progress!, parentModelCalls });
    assert.equal(architectureFidelityProgressMatches(changed, record), false);
  }
});

test("all frozen record material and the valid passed main review remain required", () => {
  const { record, review, state } = fixture(), progress = createArchitectureFidelityProgress(record, state, 11);
  const fields = ["name", "sourceFingerprint", "draft", "requirements", "contractVersion", "platformContractVersion", "platformHash",
    "platformSnapshot", "capabilityCatalogVersion", "capabilitySnapshot", "runtimeCapabilities", "confirmedRequirementContext",
    "deferredVerifications", "evidence", "modules", "researchGaps", "reviewContext", "reviewEvidence", "priorFindings", "issues", "developmentRevision"];
  for (const field of fields) {
    const changed = structuredClone(record); Reflect.set(changed, field, { changed: field });
    assert.equal(architectureFidelityProgressMatches(progress, changed), false, field);
    assert.equal(readArchitectureFidelityProgress({ ...changed, requirementFidelityProgress: progress }), null, field);
  }
  for (const change of [
    (value: { agentId: string; }) => { value.agentId = "other_agent"; },
    (value: { candidateHash: string; }) => { value.candidateHash = "e".repeat(64); },
    (value: { design: { decisions: { choice: string; }[]; }; }) => { value.design!.decisions[0]!.choice = "changed candidate"; },
    (value: { design: unknown; candidateHash: string; }) => { objectFields(objectFields(objectFields(value.design).decisions)[0]).choice = "changed candidate"; value.candidateHash = hashValue(value.design); },
    (value: { mainReviewCheckpoint: unknown; }) => { Reflect.deleteProperty(value, "mainReviewCheckpoint"); },
    (value: { mainReviewCheckpoint: { hash: string; }; }) => { value.mainReviewCheckpoint.hash = "e".repeat(64); },
    (value: { mainReviewCheckpoint: { review: { verdict: string; }; }; }) => { value.mainReviewCheckpoint.review.verdict = "revise"; },
    (value: unknown) => { objectFields(value).mainReviewCheckpoint = createMainReviewCheckpoint(value, { ...review, summary: "different passed review" }, 11); },
  ]) {
    const changed = structuredClone(record); callFixture(change, undefined, [changed]);
    assert.equal(architectureFidelityProgressMatches(progress, changed), false);
    assert.equal(createArchitectureFidelityProgress(changed, state, 11) !== null,
      Boolean(changed.mainReviewCheckpoint && changed.mainReviewCheckpoint.reviewHash !== record.mainReviewCheckpoint!.reviewHash
        && changed.mainReviewCheckpoint.review.summary === "different passed review"));
  }
});

test("cross-version matching requires unchanged binding and review while strict reads keep the source version", () => {
  const { record, review, state } = fixture(), progress = createArchitectureFidelityProgress(record, state, 11);
  const next = { ...structuredClone(record), version: 8, status: "evaluating", summary: "new lifecycle", updatedAt: "later",
    diagnostic: { reason: "cancelled" }, requirementFidelity: null, requirementFidelityProgress: progress };
  assert.equal(architectureFidelityProgressMatches(progress, next), true);
  assert.equal(readArchitectureFidelityProgress(next), null);
  assert.equal(createArchitectureFidelityProgress(next, state, 11), null, "a new progress reference needs a valid current-version main checkpoint");
  next.mainReviewCheckpoint = createMainReviewCheckpoint(next, review, 11);
  assert.equal(architectureFidelityProgressMatches(progress, next), true);
  const copied = createArchitectureFidelityProgress(next, state, 11);
  assert.ok(copied); assert.equal(copied.source.architectureVersion, 8); assert.equal(progress!.source!.architectureVersion, 7);
  assert.equal(readArchitectureFidelityProgress!({ ...next, requirementFidelityProgress: copied })!.state.calls, 1);
});

test("malformed references, source metadata and state changes cannot be repaired by the outer hash", () => {
  const { record, state } = fixture(), progress = createArchitectureFidelityProgress(record, state, 11);
  const mutations = [
    (value: { extra: boolean; }) => { value.extra = true; }, (value: { parentModelCalls: unknown; }) => { Reflect.deleteProperty(value, "parentModelCalls"); },
    (value: { schemaVersion: number; }) => { value.schemaVersion = 2; }, (value: { source: { extra: boolean; }; }) => { value.source.extra = true; },
    (value: { source: { architectureVersion: number; }; }) => { value.source.architectureVersion = 0; }, (value: { source: { agentId: string; }; }) => { value.source.agentId = "other_agent"; },
    (value: { source: { candidateHash: string; }; }) => { value.source.candidateHash = "e".repeat(64); }, (value: { source: { reviewHash: string; }; }) => { value.source.reviewHash = "e".repeat(64); },
    (value: { bindingHash: string; }) => { value.bindingHash = "e".repeat(64); }, (value: { state: { calls: number; }; }) => { value.state.calls = 3; },
    (value: { state: { raw: string; }; }) => { value.state.raw = "not a checkpoint field"; }, (value: { state: { draft: {}; }; }) => { value.state.draft = {}; },
    (value: { state: { sessionPath: string; }; }) => { value.state.sessionPath = "/tmp/session.jsonl"; }, (value: { state: { diagnostic: unknown; }; }) => { Reflect.deleteProperty(value.state, "diagnostic"); },
    (value: { state: { diagnostic: never[]; }; }) => { value.state.diagnostic = []; }, (value: { state: { diagnostic: null; }; }) => { value.state.diagnostic = null; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(progress); callFixture(mutate, undefined, [changed]);
    assert.equal(architectureFidelityProgressMatches(rehash(changed!), record), false);
    assert.equal(readArchitectureFidelityProgress({ ...record, requirementFidelityProgress: rehash(changed!) }), null);
  }
  for (const key of ["contextHash", "schemaHash", "sessionBindingHash"])
    for (const bad of [null, "", "A".repeat(64), "a".repeat(63), "g".repeat(64)])
      assert.equal(createArchitectureFidelityProgress(record, { ...state, [key]: bad }, 11), null, key);
  for (const sessionFile of [null, "", ".jsonl", "session.txt", "../session.jsonl", "/tmp/session.jsonl", "folder/session.jsonl",
    "folder\\session.jsonl", "session.jsonl\n", "中.jsonl", "x".repeat(256) + ".jsonl"])
    assert.equal(createArchitectureFidelityProgress(record, { ...state, sessionFile }, 11), null, String(sessionFile));
  const tampered = structuredClone(progress); tampered!.state!.diagnostic.stopReason = "changed";
  assert.equal(architectureFidelityProgressMatches(tampered, record), false);
  assert.equal(architectureFidelityProgressMatches({ ...progress!, hash: "e".repeat(64) }, record), false);
});

test("safe diagnostic JSON stays bounded by UTF-8 bytes, depth and nodes", () => {
  const { record, state } = fixture(), empty = { explanation: "" };
  const available = 32 * 1024 - Buffer.byteLength(JSON.stringify(empty));
  const diagnostic = { explanation: "中".repeat(Math.floor(available / 3)) + "x".repeat(available % 3) };
  assert.equal(Buffer.byteLength(JSON.stringify(diagnostic)), 32 * 1024);
  const progress = createArchitectureFidelityProgress(record, { ...state, diagnostic }, 11);
  assert.ok(progress); assert.deepEqual(readArchitectureFidelityProgress({ ...record, requirementFidelityProgress: progress }), progress);
  assert.equal(createArchitectureFidelityProgress(record, { ...state, diagnostic: { explanation: diagnostic.explanation + "x" } }, 11), null);
  assert.equal(architectureFidelityProgressMatches(rehash({ ...progress, state: { ...progress.state,
    diagnostic: { explanation: diagnostic.explanation + "x" } } }), record), false);
  let nested = null;
  for (let index = 0; index < 16; index++) nested = { child: nested };
  assert.ok(createArchitectureFidelityProgress(record, { ...state, diagnostic: nested }, 11));
  nested = { child: nested };
  assert.equal(createArchitectureFidelityProgress(record, { ...state, diagnostic: nested }, 11), null);
  assert.ok(createArchitectureFidelityProgress(record, { ...state, diagnostic: { nodes: Array(4998).fill(0) } }, 11));
  assert.equal(createArchitectureFidelityProgress(record, { ...state, diagnostic: { nodes: Array(4999).fill(0) } }, 11), null);
});

test("old records and hostile JSON fail closed without inventing history or evaluating accessors", () => {
  const { record, state } = fixture(), before = structuredClone(record);
  assert.equal(readArchitectureFidelityProgress(record), null); assert.deepEqual(record, before);
  for (const bad of [null, [], {}, false, "old result"])
    assert.equal(readArchitectureFidelityProgress({ ...record, requirementFidelityProgress: bad }), null);
  assert.equal(readArchitectureFidelityProgress(null), null); assert.equal(architectureFidelityProgressMatches(null, record), false);
  let touched = 0;
  const getter = () => { touched++; throw new Error("must not execute"); };
  const accessorState = { ...state }; Object.defineProperty(accessorState, "calls", { get: getter, enumerable: true });
  const accessorRecord = { ...record }; Object.defineProperty(accessorRecord, "requirements", { get: getter, enumerable: true });
  const accessorMain = { ...record }; Object.defineProperty(accessorMain, "mainReviewCheckpoint", { get: getter, enumerable: true });
  const accessorProgress = { ...record }; Object.defineProperty(accessorProgress, "requirementFidelityProgress", { get: getter, enumerable: true });
  assert.equal(createArchitectureFidelityProgress(record, accessorState, 11), null);
  assert.equal(createArchitectureFidelityProgress(accessorRecord, state, 11), null);
  assert.equal(createArchitectureFidelityProgress(accessorMain, state, 11), null);
  assert.equal(readArchitectureFidelityProgress(accessorProgress), null);
  const cyclic = {}; objectFields(cyclic).self = cyclic;
  for (const diagnostic of [cyclic, { missing: undefined }, { nonfinite: Infinity }, { sparse: Array(2) },
    new Proxy({}, { ownKeys: getter }), { symbol: Symbol("unsupported") }, { method() {} }])
    assert.equal(createArchitectureFidelityProgress(record, { ...state, diagnostic }, 11), null);
  const hidden = {}; Object.defineProperty(hidden, "hidden", { value: "not inert", enumerable: false });
  assert.equal(createArchitectureFidelityProgress(record, { ...state, diagnostic: hidden }, 11), null);
  assert.equal(createArchitectureFidelityProgress(new Proxy(record, { ownKeys: getter }), state, 11), null);
  assert.equal(touched, 0);
});
