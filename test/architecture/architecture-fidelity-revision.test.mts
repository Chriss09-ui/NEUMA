import { callFixture, fixtureToolAt, fixtureSchema } from "../helpers/m7-test-boundaries.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import type { PiSessionOptions } from "../../src/runtime/pi-port.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { designHash, requirementItems } from "../../src/architecture/architecture-contract.mjs";
import { createPlatformSnapshot, platformEvidence, PLATFORM_CONTRACT_VERSION } from "../../src/architecture/platform-contract.mjs";
import { runtimeCapabilityContract } from "../../src/runtime/runtime-capability-contract.mjs";
import { architectureReviewEvidenceContext } from "../../src/architecture/architecture-review-evidence.mjs";
import { createMainReviewCheckpoint } from "../../src/architecture/architecture-main-review-checkpoint.mjs";
import { createReviewProgressCheckpoint } from "../../src/architecture/architecture-review-progress.mjs";
import { createArchitectureFidelityProgress } from "../../src/architecture/architecture-fidelity-progress.mjs";
import { readArchitectureFidelityRevision } from "../../src/architecture/architecture-fidelity-revision.mjs";
import { ACCEPTANCE_ADAPTER_GUIDE } from "../../src/verification/acceptance-contract.mjs";
import { validDraft, validDesign, passingReview } from "../helpers/architecture.mjs";
import { fidelityResult } from "../helpers/fidelity.mjs";
import { architectureRecordFidelityContext } from "../../src/architecture/architecture-fidelity-context.mjs";
import { verifyRequirementFidelity } from "../../src/architecture/requirement-fidelity.mjs";

function fixture(verdict = "narrowed", contextVersion?: string, extraRequirements = 0, largeContext = false) {
  const draft = validDraft(), requirements = [...requirementItems(draft), ...Array.from({ length: extraRequirements }, (_, index) => ({ id: `extra_${index}`, text: `额外要求${index}` }))],
    design = validDesign(requirements, { schemaVersion: 3 });
  if (largeContext) design.decisions[0]!.alternatives = Array.from({ length: 40 }, () => ({ option: "a".repeat(2000), reason: "b".repeat(2000) }));
  const confirmedRequirementContext = largeContext ? { accepted: "a".repeat(2 * 1024 * 1024 - 80 * 1024) } : null;
  const candidateHash = designHash(design), runtimeCapabilities = runtimeCapabilityContract(), platformSnapshot = createPlatformSnapshot({ allowNetwork: false }),
    platformHash = designHash(platformSnapshot), evidence = [platformEvidence(platformSnapshot)];
  const context = architectureReviewEvidenceContext({ design, requirements, runtimeCapabilities, evidence, confirmedRequirementContext, acceptanceAdapterGuide: ACCEPTANCE_ADAPTER_GUIDE });
  const snapshotBody = { version: 1, candidateHash, platformHash, acceptanceAdapterGuide: context.acceptanceAdapterGuide, contextManifest: context.contextManifest };
  const snapshot = { ...snapshotBody, hash: designHash(snapshotBody) };
  const baseRecord = { agentId: "fidelity_revision", name: "synthetic", version: 2, sourceFingerprint: "synthetic-source", draft, requirements,
    design, candidateHash, contractVersion: 3, platformContractVersion: PLATFORM_CONTRACT_VERSION, platformSnapshot, platformHash,
    runtimeCapabilities, evidence, confirmedRequirementContext, modules: [], researchGaps: [], issues: [], attempts: [], review: null, status: "failed",
    reviewContext: { candidateHash, platformHash }, reviewEvidence: { version: 2, snapshot, snapshotHash: snapshot.hash } };
  const record: typeof baseRecord & Record<string, unknown> & {
    mainReviewCheckpoint?: ReturnType<typeof createMainReviewCheckpoint>;
    requirementFidelityProgress?: ReturnType<typeof createArchitectureFidelityProgress>;
    reviewProgressCheckpoint?: ReturnType<typeof createReviewProgressCheckpoint>;
  } = baseRecord;
  const current = architectureRecordFidelityContext(record, context, { contextVersion });
  const result = fidelityResult({ ...current, contextHash: designHash(current) }, verdict, { canonical: true });
  const decision = { ...result, ...(contextVersion ? { contextVersion } : {}), modelCalls: 1, fidelityDiagnostic: { schemaVersion: 1,
    ...(contextVersion ? { contextVersion } : {}), contextHash: result.contextHash, modelCalls: 1,
    submissionAttempts: 1, schemaRejections: 0, semanticRejections: 0, stopReason: "submitted" } };
  const review = passingReview(candidateHash, design);
  record.mainReviewCheckpoint = createMainReviewCheckpoint(record, review, 3, { fidelityStatus: "not_preserved", fidelityEvidence: decision });
  return { record, context, decision, review };
}

test("有效否定只提供绑定的技术修改依据，保留原文与实际花费，不伪造主评审", () => {
  for (const verdict of ["narrowed", "unproven"]) {
    const { record, context, decision } = fixture(verdict), before = structuredClone(record);
    const basis = readArchitectureFidelityRevision(record, context);
    assert.ok(basis); assert.equal(basis.trust, "untrusted-technical-reference");
    assert.equal(basis.source.candidateHash, record.candidateHash); assert.equal(basis.source.architectureVersion, record.version);
    assert.equal(basis.source.bindingHash, record.mainReviewCheckpoint!.bindingHash); assert.equal(basis.source.reviewHash, record.mainReviewCheckpoint!.reviewHash);
    assert.equal(basis.source.contextHash, decision.contextHash); assert.match(basis.source.schemaHash, /^[a-f0-9]{64}$/);
    assert.equal(basis.source.evidenceHash, designHash(decision)); assert.equal(basis.modelCalls, 3);
    assert.deepEqual(basis.evidence, decision); assert.notEqual(basis.evidence, decision);
    assert.equal(Object.hasOwn(basis, "review"), false); assert.deepEqual(record, before);
  }
});

test("旧40条契约的有效负评按原摘要兼容读取，不改写41项需求或原预算", async () => {
  for (const contextVersion of [undefined, "full-v2"]) {
    const { record, context, decision } = fixture("narrowed", contextVersion, 33), current = architectureRecordFidelityContext(record, context, { contextVersion });
    let schemaHash;
    await verifyRequirementFidelity({ context: current, config: {}, cwd: "/tmp", dataDir: "/tmp", sessionFactory: async (options: PiSessionOptions) => {
      const schema = fixtureSchema(structuredClone(options.customTools![0]!.parameters)); schema.properties!.restrictions!.maxItems = 40; schemaHash = designHash(schema);
      return { modelCallAccounting: true, dispose() {}, async prompt(text) { await options.onModelCall!();
        await fixtureToolAt(options.customTools).execute("capture", fidelityResult(JSON.parse(text), "narrowed")); } };
    } });
    record.requirementFidelityProgress = createArchitectureFidelityProgress(record, { ...(contextVersion ? { contextVersion } : {}),
      contextHash: decision.contextHash, schemaHash, sessionFile: "legacy.jsonl", sessionBindingHash: "a".repeat(64), calls: 1,
      diagnostic: decision.fidelityDiagnostic }, 12);
    const before = structuredClone(record), reference = readArchitectureFidelityRevision(record, context);
    assert.ok(reference); assert.equal(reference.source.schemaHash, schemaHash); assert.equal(reference.modelCalls, 12);
    assert.equal(objectFields(reference.evidence.checks).length, 41); assert.deepEqual(record, before);
  }
});

test("多份合法来源合并超过2MiB仍能只读恢复，单份原额度保持", () => {
  const { record, context } = fixture("narrowed", "full-v2", 0, true), before = designHash(record);
  assert.ok(Buffer.byteLength(JSON.stringify(context)) > 2 * 1024 * 1024);
  for (const value of Object.values(context)) assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 2 * 1024 * 1024);
  assert.ok(readArchitectureFidelityRevision(record, context)); assert.equal(designHash(record), before);
  const oversized = structuredClone(context); objectFields(oversized.confirmedRequirementContext).accepted = "a".repeat(2 * 1024 * 1024);
  assert.equal(readArchitectureFidelityRevision(record, oversized), null);
});

test("需求、平台、候选、依据或主评审绑定变化时不沿用范围否定", () => {
  const { record, context } = fixture();
  for (const change of [(value: { agentId: string; }) => { value.agentId = "other"; }, (value: { version: number; }) => { value.version++; }, (value: { draft: { task: { value: string; }; }; }) => { value.draft.task.value += "changed"; },
(    value: { requirements: { text: string; }[]; }) => { value.requirements[0]!.text += "changed"; }, (value: { platformHash: string; }) => { value.platformHash = "b".repeat(64); },
(    value: { runtimeCapabilities: { version: number; }; }) => { value.runtimeCapabilities.version++; }, (value: { design: { instructions: string; }; }) => { value.design.instructions += "changed"; }, (value: { evidence: never[]; }) => { value.evidence = []; },
(    value: { reviewEvidence: { snapshot: { acceptanceAdapterGuide: { version: number; }; }; }; }) => { value.reviewEvidence.snapshot.acceptanceAdapterGuide.version++; }, (value: { mainReviewCheckpoint: { reviewHash: string; }; }) => { value.mainReviewCheckpoint.reviewHash = "c".repeat(64); }]) {
    const changed = structuredClone(record); callFixture(change, undefined, [changed]); assert.equal(readArchitectureFidelityRevision(changed, context), null);
  }
  const changed = structuredClone(context); changed.requirements[0]!.text += "different";
  assert.equal(readArchitectureFidelityRevision(record, changed), null);
});

test("完整版本有效否定重建同版事实，删除或改变版本不能沿用旧摘要", () => {
  const { record, context, decision, review } = fixture("unproven", "full-v2");
  const reference = readArchitectureFidelityRevision(record, context);
  assert.ok(reference); assert.equal(reference.source.contextHash, decision.contextHash);
  for (const contextVersion of [undefined, "full-v3", "legacy-v1"]) {
    const changed = structuredClone(record), evidence = structuredClone(decision);
    if (contextVersion === undefined) delete evidence.contextVersion; else evidence.contextVersion = contextVersion;
    changed.mainReviewCheckpoint = createMainReviewCheckpoint(changed, review, 3, { fidelityStatus: "not_preserved", fidelityEvidence: evidence });
    assert.equal(readArchitectureFidelityRevision(changed, context), null);
  }
});

test("重新计算外层检查点也不能把坏范围证据或伪造主评审变成技术修改依据", () => {
  const { record, context, review, decision } = fixture();
  for (const change of [(value: { contextHash: string; }) => { value.contextHash = "e".repeat(64); }, (value: { restrictions: { quote: string; }[]; }) => { value.restrictions[0]!.quote = "UNMATCHED"; },
(    value: { restrictions: { candidatePath: string; }[]; }) => { value.restrictions[0]!.candidatePath = "/missing"; }, (value: { checks: void[]; }) => { value.checks.pop(); },
(    value: ReturnType<typeof fidelityResult>) => { value.checks[1]!.requirementId = value.checks[0]!.requirementId; }, (value: { modelCalls: number; }) => { value.modelCalls = 0; },
(    value: { fidelityDiagnostic: { modelCalls: number; }; }) => { value.fidelityDiagnostic.modelCalls = 2; }, (value: { extra: string; }) => { value.extra = "unknown"; },
(    value: { checks: { admissionPreserved: boolean; }[]; }) => { Reflect.set(value.checks[0]!, "newUnconfirmedRestriction", false); value.checks[0]!.admissionPreserved = true; }]) {
    const changed = structuredClone(record), invalid = structuredClone(decision); callFixture(change, undefined, [invalid]);
    changed.mainReviewCheckpoint = createMainReviewCheckpoint(changed, review, 3, { fidelityStatus: "not_preserved", fidelityEvidence: invalid });
    assert.equal(readArchitectureFidelityRevision(changed, context), null);
  }
  const changed = structuredClone(record), invalidReview = structuredClone(review); invalidReview.checks[0]!.passed = false;
  changed.mainReviewCheckpoint = createMainReviewCheckpoint(changed, invalidReview, 3, { fidelityStatus: "not_preserved", fidelityEvidence: decision });
  assert.equal(readArchitectureFidelityRevision(changed, context), null);
  changed.mainReviewCheckpoint = createMainReviewCheckpoint(changed, review, 3);
  assert.equal(readArchitectureFidelityRevision(changed, context), null);
});

test("修订来源保留全部已用计数的最高值，坏进度引用不能省略后重置", () => {
  const { record, context, decision } = fixture(), basis = readArchitectureFidelityRevision(record, context);
  record.reviewProgressCheckpoint = createReviewProgressCheckpoint(record, null, 11);
  record.requirementFidelityProgress = createArchitectureFidelityProgress(record, { contextHash: basis!.source.contextHash,
    schemaHash: basis!.source.schemaHash, sessionFile: "synthetic.jsonl", sessionBindingHash: "a".repeat(64), calls: 1,
    diagnostic: decision.fidelityDiagnostic }, 12);
  assert.equal(readArchitectureFidelityRevision(record, context)!.modelCalls, 12);
  record.requirementFidelityProgress!.state.sessionFile = "../bad.jsonl";
  assert.equal(readArchitectureFidelityRevision(record, context), null);
  for (const key of ["reviewProgressCheckpoint", "requirementFidelityProgress"]) for (const bad of [null, false, 0, ""]) {
    const clean = fixture(); clean.record[key] = bad;
    assert.equal(readArchitectureFidelityRevision(clean.record, clean.context), null, `${key}=${String(bad)}`);
  }
});

test("有效负评附带进度必须对应原上下文、提交契约与诊断，不因重新签外层而忽略损坏", () => {
  for (const contextVersion of [undefined, "full-v2"]) {
    const { record, context, decision, review } = fixture("narrowed", contextVersion), reference = readArchitectureFidelityRevision(record, context);
    assert.ok(reference, "无进度的既有有效否定继续兼容");
    const state = { ...(contextVersion ? { contextVersion } : {}), contextHash: reference.source.contextHash,
      schemaHash: reference.source.schemaHash, sessionFile: "bound.jsonl", sessionBindingHash: "a".repeat(64), calls: 1,
      diagnostic: structuredClone(decision.fidelityDiagnostic) };
    record.requirementFidelityProgress = createArchitectureFidelityProgress(record, state, 12);
    assert.equal(readArchitectureFidelityRevision(record, context)!.modelCalls, 12);
    for (const change of [(value: { contextHash: string; }) => { value.contextHash = "b".repeat(64); }, (value: { schemaHash: string; }) => { value.schemaHash = "c".repeat(64); },
(      value: { calls: number; }) => { value.calls = 2; }, (value: { diagnostic: { schemaVersion: number; }; }) => { value.diagnostic.schemaVersion = 2; },
(      value: { diagnostic: { contextHash: string; }; }) => { value.diagnostic.contextHash = "d".repeat(64); }, (value: { diagnostic: { modelCalls: number; }; }) => { value.diagnostic.modelCalls = 2; },
(      value: { diagnostic: { contextVersion: string; }; }) => { value.diagnostic.contextVersion = "unknown"; }, (value: { diagnostic: { contextVersion: string; }; }) => {
        if (contextVersion) Reflect.deleteProperty(value.diagnostic, "contextVersion"); else value.diagnostic.contextVersion = "full-v2";
      }]) {
      const changed = structuredClone(record), progress = structuredClone(state); callFixture(change, undefined, [progress]);
      changed.requirementFidelityProgress = createArchitectureFidelityProgress(changed, progress, 12);
      assert.equal(readArchitectureFidelityRevision(changed, context), null);
    }
    for (const change of [(value: { fidelityDiagnostic: { schemaVersion: number; }; }) => { value.fidelityDiagnostic.schemaVersion = 2; },
(      value: { fidelityDiagnostic: { contextVersion: string; }; }) => { value.fidelityDiagnostic.contextVersion = "unknown"; }]) {
      const changed = structuredClone(record), evidence = structuredClone(decision); callFixture(change, undefined, [evidence]);
      changed.mainReviewCheckpoint = createMainReviewCheckpoint(changed, review, 3, { fidelityStatus: "not_preserved", fidelityEvidence: evidence });
      assert.equal(readArchitectureFidelityRevision(changed, context), null);
    }
  }
});

test("未知或主动对象不会执行getter、产生来源或修改记录", () => {
  const { record, context } = fixture(); let reads = 0;
  const hostile = { ...record }; Object.defineProperty(hostile, "draft", { enumerable: true, get() { reads++; return record.draft; } });
  assert.equal(readArchitectureFidelityRevision(hostile, context), null); assert.equal(reads, 0);
  const hostileContext = { ...context }; Object.defineProperty(hostileContext, "contextManifest", { enumerable: true, get() { reads++; return context.contextManifest; } });
  assert.equal(readArchitectureFidelityRevision(record, hostileContext), null); assert.equal(reads, 0);
  assert.equal(readArchitectureFidelityRevision(null, context), null); assert.equal(readArchitectureFidelityRevision(record, null), null);
});
