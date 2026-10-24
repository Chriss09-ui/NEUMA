import type { VerificationSessionFactory } from "../src/runtime/pi-port.mjs";
import { callFixture } from "./helpers/m7-test-boundaries.mjs";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import { fixtureToolAt } from "./helpers/m7-test-boundaries.mjs";
import type { SessionMessage } from "../src/runtime/pi-port.mjs";
import type { TestFailure } from "./helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyRequirementFidelity } from "../src/architecture/requirement-fidelity.mjs";
import { ArchitectureDesigner } from "../src/architecture/architecture.mjs";
import { designHash, reviewSubmissionSchema, validateReview } from "../src/architecture/architecture-contract.mjs";
import { architectureReviewEvidenceContext } from "../src/architecture/architecture-review-evidence.mjs";
import { REVIEW_PROMPT } from "../src/architecture/architecture-prompts.mjs";
import { ACCEPTANCE_ADAPTER_GUIDE } from "../src/verification/acceptance-contract.mjs";
import { TEST_FIXTURE_SCHEMA } from "../src/development/development-fixtures.mjs";
import { fidelityChecker, fidelityResult } from "./helpers/fidelity.mjs";
import { passingReview } from "./helpers/architecture.mjs";
import { createPlatformSnapshot, PLATFORM_CONTRACT_VERSION } from "../src/architecture/platform-contract.mjs";
import type { PiSessionOptions } from "../src/runtime/pi-port.mjs";

const base = () => ({ requirements: [{ id: "input", text: "保留全部原合法输入和完整交付，不增加交付前提。" }], draft: {},
  confirmedRequirementContext: null, runtimeCapabilities: {}, candidate: { instructions: "保持全部用户约束。",
    decisions: [{ choice: "由平台支持的构造机制生成输入。" }], acceptance: [{ input: "满足全部字段与容量约束的边界样本", expected: "完整处理",
      verification: { stage: "development", owner: "generated-code", adapterId: "action" } }] } });
const invoke = (context: unknown, sessionFactory: VerificationSessionFactory) => verifyRequirementFidelity({ context, sessionFactory, config: {}, cwd: "/tmp", dataDir: "/tmp" });

test("新范围复核默认当前指南并标明来源，显式冻结旧指南不被新事实回填或改写", async () => {
  const current = base(), before = structuredClone(current);
  await invoke(current, fidelityChecker("preserved", { inspect(payload) {
    assert.deepEqual(payload.acceptanceAdapterGuide, ACCEPTANCE_ADAPTER_GUIDE);
    assert.equal(payload.acceptanceAdapterGuideSource, "current-default");
    assert.equal(objectFields(objectFields(objectFields(objectFields(payload.acceptanceAdapterGuide).adapters).action).executionFacts).dynamicPlaceholders, false);
    assert.deepEqual(objectFields(objectFields(objectFields(objectFields(objectFields(payload.acceptanceAdapterGuide).adapters).action).executionFacts).fixtureConstruction).schema, TEST_FIXTURE_SCHEMA);
    assert.deepEqual(objectFields(payload.candidate).decisions, current.candidate.decisions);
    assert.deepEqual(objectFields(payload.candidate).acceptance, current.candidate.acceptance);
  } }));
  assert.deepEqual(current, before);
  const historical = structuredClone(ACCEPTANCE_ADAPTER_GUIDE); Reflect.set(historical, "version", 1);
  Reflect.deleteProperty(historical.adapters!.action!.executionFacts, "fixtureConstruction");
  const supplied = { ...base(), acceptanceAdapterGuide: historical }, original = structuredClone(supplied);
  await invoke(supplied, fidelityChecker("unproven", { inspect(payload) {
    assert.deepEqual(payload.acceptanceAdapterGuide, historical); assert.equal(payload.acceptanceAdapterGuideSource, "provided-context");
    assert.equal(objectFields(objectFields(objectFields(objectFields(payload.acceptanceAdapterGuide).adapters).action).executionFacts).fixtureConstruction, undefined);
  } }));
  assert.deepEqual(supplied, original);
});

test("同候选指南事实改变会改变contextHash，旧范围决定不能绑定到新指南", async () => {
  const original = { ...base(), acceptanceAdapterGuide: structuredClone(ACCEPTANCE_ADAPTER_GUIDE) };
  const first = await invoke(original, fidelityChecker());
  const changed = structuredClone(original); Reflect.set(changed.acceptanceAdapterGuide!.adapters.action!.executionFacts, "evidence", "different-frozen-contract");
  let charges = 0;
  const second = await invoke(changed, async (options: PiSessionOptions) => ({ modelCallAccounting: true, dispose() {}, async prompt(text: string) {
    await options.onModelCall!({}); charges++;
    const payload = JSON.parse(String(text)), current = fidelityResult(payload, "unproven");
    assert.notEqual(payload.contextHash, first.contextHash);
    await assert.rejects(callFixture(fixtureToolAt(options.customTools, 0)!.execute, fixtureToolAt(options.customTools, 0), ["stale", { ...current, contextHash: first.contextHash }]),
      (error: TestFailure) => error.validationIssues!.some((issue) => issue.reason === "invalid_value"));
    await fixtureToolAt(options.customTools, 0)!.execute("current", current);
  } }));
  assert.equal(second.verdict, "unproven"); assert.equal(second.modelCalls, 1); assert.equal(charges, 1);
  assert.notEqual(first.contextHash, second.contextHash);
});

test("显式缺少平台事实时preserved提交被拒，原回合可用unproven保留用户要求", async () => {
  for (const acceptanceAdapterGuide of [null, {}, { version: 1, adapters: { action: null } }, { version: 1, adapters: { unexpected: true } },
    { version: 1, adapters: { conversation: ACCEPTANCE_ADAPTER_GUIDE.adapters.conversation } }]) {
    let calls = 0;
    const result = await invoke({ ...base(), acceptanceAdapterGuide }, async (options: PiSessionOptions) => ({ modelCallAccounting: true, dispose() {}, async prompt(text: string) {
      await options.onModelCall!({}); calls++;
      const payload = JSON.parse(String(text));
      assert.match(options.systemPrompt!, /所需平台事实缺失、与指南矛盾或构造\/容量依据尚不足时不能preserved/u);
      await assert.rejects(callFixture(Reflect.apply, Reflect, [fixtureToolAt(options.customTools, 0)!.execute, fixtureToolAt(options.customTools, 0), ["unsupported-pass", fidelityResult(payload)]]),
        (error: TestFailure) => error.validationIssues!.some((issue) => issue.reason === "platform_facts_unavailable"));
      await fixtureToolAt(options.customTools, 0)!.execute("unproven", fidelityResult(payload, "unproven"));
    } }));
    assert.equal(result.verdict, "unproven"); assert.equal(result.modelCalls, 1); assert.equal(calls, 1);
  }
});

async function reviewRole(t: test.TestContext, { unproven = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-fidelity-facts-")), current = base();
  const platformSnapshot = createPlatformSnapshot({ allowNetwork: false });
  const platform = { platformSnapshot, platformHash: designHash(platformSnapshot), platformContractVersion: PLATFORM_CONTRACT_VERSION };
  if (unproven) current.candidate!.decisions[0]!.choice = "运行时替换冻结参数里的字符串，并假定所有上限能同时触及。";
  const candidateHash = designHash(current.candidate);
  const frozen = structuredClone(ACCEPTANCE_ADAPTER_GUIDE); Reflect.set(frozen, "version", 1);
  Reflect.set(frozen.adapters!.action!.executionFacts, "evidence", "this-review-frozen-contract");
  const evidenceContext = architectureReviewEvidenceContext({ design: current.candidate, requirements: current.requirements,
    runtimeCapabilities: current.runtimeCapabilities, acceptanceAdapterGuide: frozen });
  const original = structuredClone(evidenceContext); let children = 0, childCalls = 0, mainCalls = 0, captured: unknown;
  const designer = new ArchitectureDesigner({ config: { llmConfigured: true }, cwd: root, dataDir: root,
    fidelitySessionFactory: async (options) => {
      children++; return fidelityChecker(unproven ? "unproven" : "preserved", { inspect(payload, options: PiSessionOptions) {
        childCalls++; captured = payload;
        assert.deepEqual(payload.acceptanceAdapterGuide, frozen); assert.equal(payload.acceptanceAdapterGuideSource, "review-evidence-context");
        assert.deepEqual(objectFields(payload.candidate).decisions, current.candidate.decisions);
        assert.deepEqual(objectFields(payload.candidate).acceptance, current.candidate.acceptance);
        assert.deepEqual(payload.acceptanceAdapterGuide.adapters.action.executionFacts.fixtureConstruction.schema, TEST_FIXTURE_SCHEMA);
        assert.deepEqual(options.customTools!.map(({ name }) => name), ["submit_requirement_fidelity", "read_model_context"]);
      } })(options);
    },
    sessionFactory: async (options) => ({ modelCallAccounting: true, messages: [] as SessionMessage[], subscribe: () => () => {}, dispose() {}, async abort() {}, async prompt(text) {
      await callFixture(options.onModelCall!, options, []); mainCalls++;
      const payload = JSON.parse(String(text)); assert.deepEqual(payload.acceptanceAdapterGuide, frozen);
      const tool = options.customTools!.find(({ name }) => name === "submit_architecture_review"), review = passingReview(candidateHash);
      review.acceptanceScopeChecks = [{ acceptanceId: "sample", adapterId: "action", scope: frozen.adapters!.action!.scope,
        sufficient: true, reason: "本地冻结范围行", criterionQuote: current.candidate!.acceptance[0]!.expected, adapterQuote: frozen.adapters!.action!.proves }];
      await fixtureToolAt([tool!]).execute("final", review);
    } }) });
  t.after(async () => { await designer.ready; await designer.persistence; await rm(root, { recursive: true, force: true }); });
  const run = () => designer.role({ role: "reviewer", systemPrompt: REVIEW_PROMPT, submitName: "submit_architecture_review",
    parameters: reviewSubmissionSchema({ evidenceRequired: true }), reviewEvidenceContext: evidenceContext,
    payload: { ...platform, evidence: [], contextManifest: evidenceContext.contextManifest,
      requirements: current.requirements, draft: current.draft, confirmedRequirementContext: null, runtimeCapabilities: current.runtimeCapabilities,
      design: current.candidate, candidateHash: designHash(current.candidate), requireAcceptanceVerification: true, acceptanceAdapterGuide: frozen },
    validate: (value) => validateReview(value, { candidateHash, evidenceContext }), onProgress() {} });
  let result: unknown, diagnostic: TestFailure["diagnostic"];
  if (unproven) await assert.rejects(run(), (error: TestFailure) => { diagnostic = error.diagnostic; return diagnostic!.reason === "scope_not_preserved"; });
  else result = await run();
  assert.deepEqual(evidenceContext, original);
  return { result, diagnostic, children, childCalls, mainCalls, captured };
}

test("主评审和fidelity实际首包使用同版冻结事实，旧schema仍走原评审且不修改历史快照", async (t) => {
  const result = await reviewRole(t);
  assert.equal(objectFields(result.result).verdict, "pass"); assert.equal(result.children, 1); assert.equal(result.childCalls, 1); assert.equal(result.mainCalls, 1);
  assert.equal(objectFields(objectFields(result.captured).acceptanceAdapterGuide).version, 1);
});

test("构造反证或容量依据不足的模拟独立判断不能被主评审pass覆盖，不增会话或模型请求", async (t) => {
  assert.match(REVIEW_PROMPT, /联查该项input、完整expected与关联decisions/u);
  assert.match(REVIEW_PROMPT, /矛盾或依据不足不得pass，应revise或insufficient/u);
  const result = await reviewRole(t, { unproven: true });
  assert.equal(result.result, undefined); assert.equal(result.diagnostic!.requirementFidelity!.verdict, "unproven");
  assert.equal(result.children, 1); assert.equal(result.childCalls, 1); assert.equal(result.mainCalls, 1);
});
