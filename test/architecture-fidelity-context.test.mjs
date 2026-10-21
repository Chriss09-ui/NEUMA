import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { designHash, requirementItems, reviewSubmissionSchema, validateReview } from "../src/architecture/architecture-contract.mjs";
import { ArchitectureDesigner } from "../src/architecture/architecture.mjs";
import { createPlatformSnapshot, platformEvidence } from "../src/architecture/platform-contract.mjs";
import { runtimeCapabilityContract } from "../src/runtime/runtime-capability-contract.mjs";
import { architectureReviewEvidenceContext } from "../src/architecture/architecture-review-evidence.mjs";
import { createArchitectureFidelityContext, architectureFidelityContextVersion, architectureRecordFidelityContext }
  from "../src/architecture/architecture-fidelity-context.mjs";
import { createMainReviewCheckpoint } from "../src/architecture/architecture-main-review-checkpoint.mjs";
import { createArchitectureFidelityProgress, readArchitectureFidelityProgress } from "../src/architecture/architecture-fidelity-progress.mjs";
import { validDraft, validDesign, passingReview } from "./helpers/architecture.mjs";
import { fidelityChecker } from "./helpers/fidelity.mjs";

function fixture() {
  const draft = validDraft(), requirements = requirementItems(draft), candidate = validDesign(requirements, { schemaVersion: 3 }),
    runtimeCapabilities = runtimeCapabilityContract(), platformSnapshot = createPlatformSnapshot({ allowNetwork: false });
  const deferredVerifications = { assessmentId: "current_assessment", issues: [{ id: "transport", stage: "activation", checks: [{
    id: "current_connection_framing", status: "verified", detail: JSON.stringify({ framing: "json-value-once", measuredBytes: 73 }),
  }], stageDecision: { stage: "activation", blocking: false, basis: [{ source: "system-check", checkId: "current_connection_framing" }] } }] };
  const evidence = [platformEvidence(platformSnapshot)];
  const source = { requirements, draft, confirmedRequirementContext: null, candidate, runtimeCapabilities,
    acceptanceAdapterGuideSource: "review-evidence-context", deferredVerifications, evidence,
    platformContractVersion: platformSnapshot.version, platformSnapshot, platformHash: designHash(platformSnapshot) };
  const review = architectureReviewEvidenceContext({ design: candidate, requirements, runtimeCapabilities, evidence, deferredVerifications });
  source.acceptanceAdapterGuide = review.acceptanceAdapterGuide; source.contextManifest = review.contextManifest;
  return { source, review };
}

test("历史版本保留原上下文结构和摘要，新事实不会回填旧会话", () => {
  const { source } = fixture();
  const original = Object.fromEntries(["requirements", "draft", "confirmedRequirementContext", "candidate", "runtimeCapabilities",
    "acceptanceAdapterGuide", "acceptanceAdapterGuideSource"].map((key) => [key, source[key]]));
  const legacy = createArchitectureFidelityContext(source);
  assert.deepEqual(legacy, original); assert.equal(designHash(legacy), designHash(original));
  source.deferredVerifications.issues[0].checks[0].detail = "new measurement";
  assert.deepEqual(createArchitectureFidelityContext(source), original);
  assert.equal(architectureFidelityContextVersion({}), undefined);
});

test("完整版本逐字续接阶段决定、连接封装测量、证据清单和冻结平台事实", () => {
  const { source, review } = fixture(), options = { contextVersion: "full-v2" }, context = createArchitectureFidelityContext(source, options);
  assert.equal(context.fidelityContextVersion, "full-v2");
  for (const key of ["deferredVerifications", "evidence", "contextManifest", "platformContractVersion", "platformHash", "platformSnapshot"])
    assert.deepEqual(context[key], source[key], key);
  assert.equal(context.deferredVerifications.issues[0].stageDecision.stage, "activation");
  assert.equal(JSON.parse(context.deferredVerifications.issues[0].checks[0].detail).measuredBytes, 73);
  const record = { ...source, design: source.candidate };
  assert.deepEqual(architectureRecordFidelityContext(record, review, options), context);
  const changed = structuredClone(source); changed.deferredVerifications.issues[0].checks[0].detail = JSON.stringify({ framing: "json-value-once", measuredBytes: 74 });
  changed.contextManifest = architectureReviewEvidenceContext({ ...changed, design: changed.candidate }).contextManifest;
  assert.notEqual(designHash(createArchitectureFidelityContext(changed, options)), designHash(context));
  context.platformSnapshot.network.allowNetwork = true; context.deferredVerifications.issues[0].stageDecision.stage = "runtime";
  assert.equal(source.platformSnapshot.network.allowNetwork, false); assert.equal(source.deferredVerifications.issues[0].stageDecision.stage, "activation");
});

test("未知版本、缺失或不匹配的完整依据无法降级为旧上下文", () => {
  const { source } = fixture();
  for (const contextVersion of [null, false, 1, 2, "legacy-v1", "full-v3", ""])
    assert.throws(() => createArchitectureFidelityContext(source, { contextVersion }));
  for (const contextVersion of [undefined, null, false, 1, 2, "legacy-v1", "full-v3"])
    assert.throws(() => architectureFidelityContextVersion({ contextVersion }));
  for (const change of [value => { value.contextManifest.deferredVerifications.sha256 = "b".repeat(64); },
    value => { value.deferredVerifications.issues[0].stageDecision.stage = "runtime"; }, value => { value.platformHash = "a".repeat(64); },
    value => { delete value.evidence; }, value => { delete value.platformSnapshot; }]) {
    const changed = structuredClone(source); change(changed);
    assert.throws(() => createArchitectureFidelityContext(changed, { contextVersion: "full-v2" }));
  }
  let touched = 0;
  const hostile = { ...source }; Object.defineProperty(hostile, "deferredVerifications", { enumerable: true, get() { touched++; throw new Error("no"); } });
  assert.throws(() => createArchitectureFidelityContext(hostile, { contextVersion: "full-v2" })); assert.equal(touched, 0);
});

test("进度显式绑定完整上下文版本并保留耗尽预算，未知版本不能通过重签外层摘要", () => {
  const { source } = fixture(), context = createArchitectureFidelityContext(source, { contextVersion: "full-v2" });
  const candidateHash = designHash(source.candidate), record = { ...source, design: source.candidate, agentId: "context_fixture", version: 1, candidateHash };
  record.mainReviewCheckpoint = createMainReviewCheckpoint(record, passingReview(candidateHash, source.candidate), 12);
  const state = { contextVersion: "full-v2", contextHash: designHash(context), schemaHash: "b".repeat(64), sessionFile: "saved.jsonl",
    sessionBindingHash: "c".repeat(64), calls: 2, diagnostic: { schemaVersion: 1, contextHash: designHash(context), modelCalls: 2 } };
  const progress = createArchitectureFidelityProgress(record, state, 12);
  assert.ok(progress); record.requirementFidelityProgress = progress;
  assert.equal(readArchitectureFidelityProgress(record).state.contextVersion, "full-v2");
  assert.equal(readArchitectureFidelityProgress(record).parentModelCalls, 12);
  assert.equal(readArchitectureFidelityProgress(record).state.calls, 2);
  for (const contextVersion of [undefined, null, "legacy-v1", "full-v3"])
    assert.equal(createArchitectureFidelityProgress(record, { ...state, contextVersion }, 12), null);
});

test("主评审实际发送完整同版事实；旧待复核检查点只续原上下文及第12次调用", async (t) => {
  for (const legacy of [false, true]) {
    const { source, review: evidenceContext } = fixture(), candidateHash = designHash(source.candidate), review = passingReview(candidateHash, source.candidate);
    const root = await mkdtemp(join(tmpdir(), "neuma-fidelity-context-integration-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    let inspected = 0, diagnostic, evidence, mainCalls = 0;
    const sessionFactory = async options => ({ modelCallAccounting: true, messages: [], subscribe: () => () => {}, dispose() {}, async abort() {}, async prompt() {
      mainCalls++; await options.onModelCall();
      await options.customTools.find(tool => tool.name === "submit_architecture_review").execute("main", review);
    } });
    const designer = new ArchitectureDesigner({ config: { llmConfigured: true }, cwd: root, dataDir: root, sessionFactory,
      fidelitySessionFactory: fidelityChecker("preserved", { inspect(payload) {
        inspected++;
        if (legacy) {
          assert.equal(Object.hasOwn(payload, "fidelityContextVersion"), false);
          for (const field of ["deferredVerifications", "evidence", "contextManifest", "platformSnapshot"])
            assert.equal(Object.hasOwn(payload, field), false, field);
        } else {
          assert.equal(payload.fidelityContextVersion, "full-v2");
          for (const field of ["deferredVerifications", "evidence", "contextManifest", "platformContractVersion", "platformHash", "platformSnapshot"])
            assert.deepEqual(payload[field], source[field], field);
        }
      } }) });
    await designer.ready;
    const result = await designer.role({ role: "reviewer", systemPrompt: "Synthetic independent review", onProgress() {},
      payload: { ...source, design: source.candidate, candidateHash, requireAcceptanceVerification: true }, reviewEvidenceContext: evidenceContext,
      parameters: reviewSubmissionSchema({ evidenceRequired: true }), submitName: "submit_architecture_review",
      validate: value => validateReview(value, { candidateHash, schemaVersion: 3, evidenceContext }),
      ...(legacy ? { resumeMainReview: { review, modelCalls: 4 }, initialModelCalls: 4 } : {}),
      onFidelity: value => { evidence = value; }, onDiagnostics: value => { diagnostic = value; } });
    assert.equal(result.verdict, "pass"); assert.equal(inspected, 1); assert.equal(mainCalls, legacy ? 0 : 1);
    assert.equal(diagnostic.modelCalls, legacy ? 5 : 2);
    assert.equal(evidence.verdict, "preserved"); assert.equal(evidence.contextVersion, legacy ? undefined : "full-v2");
  }
});
