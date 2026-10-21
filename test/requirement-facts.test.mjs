import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv";
import { projectRequirementFacts, checkedFactProgress, requirementProofScope, trustedFactProgressSchema } from "../src/requirements/requirement-facts.mjs";
import { systemProgressSchema } from "../src/requirements/requirement-progress.mjs";
import { INPUT_FRAMING_FACTS, measureConnectionFraming } from "../src/applications/input-framing.mjs";
import { createRequirementSystemVerifier } from "../src/agents/requirement-verification.mjs";
import { calculateRequirementDerivation } from "../src/requirements/requirement-calculations.mjs";
import { makeProviders } from "../src/requirements/providers.mjs";
import { createPlatformSnapshot } from "../src/architecture/platform-contract.mjs";
import { validDraft } from "./helpers/architecture.mjs";
import { sufficientPreflight } from "./helpers/consultation.mjs";

const snapshot = () => ({ agentId: "alpha", version: 0, profile: "legacy", connections: [] });
const evidence = (value) => ({ source: "platform", reference: "platform.runtime", detail: JSON.stringify(value) });
const checks = () => [{ id: "capacity", status: "verified", evidence: [
  evidence({ type: "input_framing_contract", ...INPUT_FRAMING_FACTS }),
  evidence({ type: "current_connection_framing", ...measureConnectionFraming(snapshot(), "alpha") }),
] }];

test("宿主已知封装事实投影保留类型、稳定编号和适用范围，不提升任意JSON或私密字段", () => {
  const values = projectRequirementFacts(checks()), copy = projectRequirementFacts(structuredClone(checks()));
  assert.deepEqual(values, copy);
  const encoding = values.find((fact) => fact.path === "inputFraming.encoding");
  assert.equal(encoding.status, "available"); assert.equal(encoding.valueType, "string"); assert.equal(encoding.value, INPUT_FRAMING_FACTS.encoding);
  assert.equal(values.find((fact) => fact.path === "inputFraming.api.limitBytes").valueType, "integer");
  assert.deepEqual(values.find((fact) => fact.path === "inputFraming.task.template").value, INPUT_FRAMING_FACTS.task.template);
  const next = checks(), measured = JSON.parse(next[0].evidence[1].detail); measured.configVersion++;
  next[0].evidence[1] = evidence(measured);
  const changed = projectRequirementFacts(next);
  assert.equal(changed.find((fact) => fact.path === encoding.path).id, encoding.id);
  assert.notEqual(changed.find((fact) => fact.path === "currentConnectionFraming.configVersion").id,
    values.find((fact) => fact.path === "currentConnectionFraming.configVersion").id);
  const untrusted = [{ id: "capacity", status: "verified", evidence: [
    evidence({ type: "external_json", secret: "PRIVATE_VALUE" }),
    evidence({ type: "input_framing_contract", ...INPUT_FRAMING_FACTS, encoding: "PRIVATE_VALUE" }),
    evidence({ type: "current_connection_framing", ...measured, secret: "PRIVATE_VALUE" }),
    { ...evidence({ type: "input_framing_contract", ...INPUT_FRAMING_FACTS }), source: "runtime" },
  ] }];
  assert.deepEqual(projectRequirementFacts(untrusted), []);
});

test("缺口引用不能把已提供事实说成未知，允许明确解释冲突与范围缺口", () => {
  const facts = projectRequirementFacts(checks()), fact = facts[0], detail = "需要解释该事实与当前设计选择之间的关系。";
  assert.throws(() => checkedFactProgress({ missingFacts: [{ factId: fact.id, status: "unknown", detail }] }, facts, { required: true }), /本轮未知事实/);
  assert.throws(() => checkedFactProgress({}, facts, { required: true }), /本轮未知事实/);
  assert.throws(() => checkedFactProgress({ missingFacts: [{ factId: "fact_" + "f".repeat(32), status: "conflict", detail }] }, facts), /本轮未知事实/);
  const conflict = { missingFacts: [{ factId: fact.id, status: "conflict", detail }] };
  assert.deepEqual(checkedFactProgress(conflict, facts, { required: true }), conflict);
  const unsupported = { unsupportedScope: "当前契约尚未覆盖设计正在使用的另一个输入入口。" };
  assert.deepEqual(checkedFactProgress(unsupported, facts, { required: true }), unsupported);
  const unknown = projectRequirementFacts([{ id: "capacity", evidence: [evidence({ type: "current_connection_framing", status: "unknown", reason: "agent_unbound" })] }]);
  assert.ok(unknown.every((item) => item.status === "unknown" && item.value === null));
  assert.doesNotThrow(() => checkedFactProgress({ missingFacts: [{ factId: unknown[0].id, status: "unknown", detail }] }, unknown, { required: true }));
  const basisHash = "a".repeat(64), validate = new Ajv({ strict: false }).compile(trustedFactProgressSchema(systemProgressSchema(basisHash), facts, { required: true }));
  assert.doesNotThrow(() => new Ajv({ strict: false }).compile(trustedFactProgressSchema(systemProgressSchema(basisHash), [])));
  const progress = { basisHash, established: "已读取宿主事实。", missing: detail, nextAction: { kind: "review", detail }, ...conflict };
  assert.equal(validate(progress), true); delete progress.missingFacts; assert.equal(validate(progress), false);
});

test("当前交付范围拒绝把未来连接增长伪装成已知事实冲突，真实相反事实仍须停下核实", () => {
  const draft = { ...validDraft(), taskSpec: { version: 1, items: [] } }, platform = createPlatformSnapshot();
  const facts = projectRequirementFacts(checks()), proofScope = requirementProofScope(draft, platform, facts);
  const fact = facts.find((item) => item.path === "currentConnectionFraming.gatewayTaskMetadataUpperBoundBytes");
  const progress = { proofScopeHash: proofScope.bindingHash, missingFacts: [{ factId: fact.id, status: "conflict",
    detail: "当前574字节只覆盖零连接，不能保证未来任意连接配置，因此要求当前阻断。" }] };
  assert.throws(() => checkedFactProgress(progress, facts, { proofScope, required: true }), /本轮未知事实/);
  const unrelated = facts.find((item) => item.path === "inputFraming.api.limitBytes");
  progress.missingFacts[0].counterFactId = unrelated.id;
  assert.throws(() => checkedFactProgress(progress, facts, { proofScope, required: true }), /本轮未知事实/);
  progress.missingFacts[0].counterFactId = fact.id;
  assert.throws(() => checkedFactProgress(progress, facts, { proofScope, required: true }), /本轮未知事实/);
  const counter = { ...fact, id: "fact_" + "e".repeat(32), value: fact.value + 1 };
  const conflicting = [...facts, counter], conflictScope = requirementProofScope(draft, platform, conflicting);
  progress.proofScopeHash = conflictScope.bindingHash; progress.missingFacts[0].counterFactId = counter.id;
  assert.doesNotThrow(() => checkedFactProgress(progress, conflicting, { proofScope: conflictScope, required: true }));
});

test("未覆盖范围须绑定当前要求原文与当前证明摘要，未知快照不能因规范请求见证而自动通过", () => {
  const draft = { ...validDraft(), taskSpec: { version: 1, items: [] } }, platform = createPlatformSnapshot();
  const facts = projectRequirementFacts(checks()), proofScope = requirementProofScope(draft, platform, facts);
  const options = { proofScope, required: true, requirementIds: ["task"] };
  for (const unsupportedScope of ["未来增加任意连接需要固定上界。",
    { requirementId: "task", quote: "未来任意连接始终可用", target: "required_current_behavior", detail: "无法证明" },
    { requirementId: "task", quote: draft.task.value, target: "future_configuration", detail: "未来变化" },
    { requirementId: "scenario", quote: draft.scenario.value, target: "required_current_behavior", detail: "不是当前问题引用范围" }])
    assert.throws(() => checkedFactProgress({ proofScopeHash: proofScope.bindingHash, unsupportedScope }, facts, options), /本轮未知事实/);
  const unsupportedScope = { requirementId: "task", quote: draft.task.value, target: "required_current_behavior", detail: "该当前任务尚有额外前提需要独立核实，不能仅凭引用就判定成立。" };
  assert.doesNotThrow(() => checkedFactProgress({ proofScopeHash: proofScope.bindingHash, unsupportedScope }, facts, options));
  assert.throws(() => checkedFactProgress({ proofScopeHash: "a".repeat(64), unsupportedScope }, facts, options), /本轮未知事实/);
  const unknown = projectRequirementFacts([{ id: "capacity", evidence: [evidence({ type: "current_connection_framing", status: "unknown", reason: "agent_unbound" })] }]);
  const unknownScope = requirementProofScope(draft, platform, unknown);
  assert.doesNotThrow(() => checkedFactProgress({ proofScopeHash: unknownScope.bindingHash,
    missingFacts: [{ factId: unknown[0].id, status: "unknown", detail: "当前连接快照未测得，当前任务帧仍缺依据。" }] }, unknown, { proofScope: unknownScope, required: true }));
  const schema = trustedFactProgressSchema(systemProgressSchema("b".repeat(64)), facts, options);
  assert.doesNotThrow(() => new Ajv({ strict: false }).compile(schema));
  assert.doesNotThrow(() => new Ajv({ strict: false }).compile(trustedFactProgressSchema(systemProgressSchema("b".repeat(64)), facts,
    { proofScope: requirementProofScope({}, platform, facts), required: true })));
});

test("同编号的基础字段与任务条目均能引用各自原文，但不能借用其他事项的授权", () => {
  const draft = { ...validDraft(), taskSpec: { version: 1, items: [{ id: "task", dimension: "input_scale",
    content: "本次输入最多包含300条文件记录", applicability: "applies", critical: true,
    source: { kind: "user", evidence: [{ messageId: "user_1", quote: "本次输入最多包含300条文件记录" }] } }] } };
  const facts = projectRequirementFacts(checks()), proofScope = requirementProofScope(draft, createPlatformSnapshot(), facts);
  const progress = (requirementId, quote) => ({ proofScopeHash: proofScope.bindingHash,
    unsupportedScope: { requirementId, quote, target: "required_current_behavior", detail: "该当前要求仍需要独立核实容量前提。" } });
  const options = { proofScope, required: true, requirementIds: ["task"] };
  assert.equal(proofScope.statements.filter((item) => item.id === "task").length, 2);
  for (const quote of [draft.task.value, draft.taskSpec.items[0].content])
    assert.doesNotThrow(() => checkedFactProgress(progress("task", quote), facts, options));
  assert.throws(() => checkedFactProgress(progress("task", "未来任意连接均须保证成功"), facts, options), /本轮未知事实/);
  assert.throws(() => checkedFactProgress(progress("task", draft.taskSpec.items[0].content), facts,
    { ...options, requirementIds: ["deliverable"] }), /本轮未知事实/);
  const alias = proofScope.statements.find((item) => item.id.startsWith("spec_") && item.text === draft.taskSpec.items[0].content).id;
  assert.doesNotThrow(() => checkedFactProgress(progress(alias, draft.taskSpec.items[0].content), facts,
    { ...options, requirementIds: [alias] }));
  assert.throws(() => checkedFactProgress(progress(alias, draft.taskSpec.items[0].content), facts, options), /本轮未知事实/);
});

async function providerFixture(repeated = false, futureConflict = false) {
  const draft = { ...validDraft(), taskSpec: { version: 1, items: [] } }, platform = createPlatformSnapshot();
  const issue = { id: "capacity", owner: "system", stage: "requirements", blocking: true,
    question: "核对当前输入入口的容量依据", impact: "影响承载方案", requirementIds: ["task", "deliverable"], checks: ["platform.runtime"] };
  const old = calculateRequirementDerivation({ issueId: issue.id, requirementIds: issue.requirementIds,
    premises: [{ id: "amount", value: "3", unit: "count", source: { kind: "requirement", reference: "task", detail: "仅供模拟的待核实数量" } }],
    expressions: [{ id: "bound", unit: "count", formula: { op: "add", args: [{ ref: "amount" }, { value: "2" }] } }],
  }, { draft, platform, issues: [issue], requirementIds: issue.requirementIds });
  const candidate = { ...await sufficientPreflight(), verdict: "blocked", issues: [issue] }, requests = [];
  const verifySystemIssues = createRequirementSystemVerifier({ connections: { snapshot: async () => snapshot() } });
  let reviews = 0;
  const provider = makeProviders({ llmConfigured: true, model: "fixture", apiKey: "local-only", chatUrl: "https://model.invalid/chat" }, async (_url, options) => {
    const request = JSON.parse(options.body); requests.push(request);
    const context = JSON.parse(request.messages[1].content);
    let result = reviews && !repeated ? { ...candidate, verdict: "sufficient", issues: [{ ...issue, blocking: false, stage: "development" }] } : candidate;
    if (context.knownIssues) {
      reviews++;
      const encoding = context.trustedFacts.find((item) => item.path === "inputFraming.encoding"), receipt = context.derivations[0];
      const fact = futureConflict ? context.trustedFacts.find((item) => item.path === "currentConnectionFraming.gatewayTaskMetadataUpperBoundBytes") : encoding;
      assert.equal(encoding.value, INPUT_FRAMING_FACTS.encoding);
      assert.equal(context.hostExecution.calculationCalls, 0); assert.deepEqual(context.hostExecution.issuedReceiptIds, []);
      assert.deepEqual(context.hostExecution.activeReceiptIds, [old.id]);
      result = { decisions: [{ issueId: issue.id, owner: "system", status: "open", stage: reviews > 1 && !repeated ? "development" : "requirements", reason: "当前规范请求有合法路径，代码和边界仍待研发验收。",
        evidence: [], checks: issue.checks, derivationIds: [receipt.id], progress: { basisHash: context.systemBases[0].basisHash,
          proofScopeHash: context.proofScope.bindingHash,
          established: "读取到宿主的规范编码事实，本轮未执行计算工具。", missing: "需要复核设计是否改变了输入表示。",
          missingFacts: [{ factId: fact.id, status: futureConflict ? "conflict" : "unknown",
            detail: futureConflict ? "当前测量只证明当前配置，无法证明未来任意连接和未要求群页面输入，因此称其冲突。" : "事实已经给出，但仍将其误报为未知。",
            ...(futureConflict ? { counterFactId: context.trustedFacts.find((item) => item.path === "inputFraming.task.scope").id } : {}) }],
          nextAction: { kind: "review", detail: "核对设计与已提供编码事实的关系，未解决前继续保留系统阻断。" } } }] };
      assert.equal(new Ajv({ strict: false }).compile(context.decisionSchema)(result), true);
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }), { status: 200 });
  }, { verifySystemIssues });
  return { requests, run: () => provider.preflight({ draft, platform, previousIssues: [issue], priorDerivations: [old], verificationContext: { agentId: "alpha" } }) };
}

test("已知事实误报未知在原预算内纠正，合法当前路径进入研发待验收而不宣称已执行", async () => {
  const fixture = await providerFixture(), result = await fixture.run();
  assert.equal(result.verdict, "sufficient"); assert.equal(result.preflightDiagnostic.modelTurns, 4);
  assert.equal(result.preflightDiagnostic.readOnlyCalls, 1); assert.equal(result.preflightDiagnostic.correctiveContinuations, 1);
  assert.equal(result.deferredIssues[0].stage, "development"); assert.equal(result.deferredIssues[0].blocking, false);
  assert.equal(result.deferredIssues[0].status, undefined);
  const initial = JSON.parse(fixture.requests[0].messages[1].content);
  assert.ok(initial.trustedFacts.length); assert.equal(initial.remainingReadOnlyCalls, 1);
  assert.deepEqual(initial.hostExecution.issuedReceiptIds, []); assert.ok(initial.derivations.length);
});

test("重复把已提供事实说成未知不会增加纠正轮数或放行", async () => {
  const fixture = await providerFixture(true);
  await assert.rejects(fixture.run(), (error) => {
    assert.equal(error.reason, "system_basis_stale"); assert.equal(error.preflightDiagnostic.modelTurns, 4);
    assert.equal(error.preflightDiagnostic.correctiveContinuations, 1); assert.equal(error.preflightDiagnostic.readOnlyCalls, 1); return true;
  });
});

test("真实失败形态的未来任意配置/未要求入口不构成当前测量反证，纠正后仍经独立复核再进入研发", async () => {
  const fixture = await providerFixture(false, true), result = await fixture.run();
  assert.equal(result.verdict, "sufficient"); assert.equal(result.preflightDiagnostic.modelTurns, 4);
  assert.equal(result.preflightDiagnostic.readOnlyCalls, 1); assert.equal(result.preflightDiagnostic.correctiveContinuations, 1);
  assert.equal(result.deferredIssues[0].stage, "development");
  const correction = fixture.requests.flatMap((request) => request.messages)
    .find((message) => message.role === "user" && message.content.startsWith("上次系统阻断未通过"));
  assert.match(correction.content, /同path、同scope/); assert.match(correction.content, /未来配置不是当前测量的反证/);
  assert.ok(fixture.requests.filter((request) => JSON.parse(request.messages[1].content).knownIssues).length >= 2);
});

test("已有事项首个模型请求即收到当前事实和失效旧回执，激活义务同读且不增加候选回合", async () => {
  const draft = { ...validDraft(), taskSpec: { version: 1, items: [] } }, platform = createPlatformSnapshot();
  const issue = { id: "capacity", owner: "system", stage: "requirements", blocking: true,
    question: "当前容量是否可承载", impact: "决定交付路径", requirementIds: ["task"], checks: ["platform.runtime"] };
  const activation = { ...issue, id: "activation", stage: "activation", blocking: false, checks: ["platform.deliveryRoutes.managedService"] };
  const old = calculateRequirementDerivation({ issueId: issue.id, requirementIds: issue.requirementIds,
    premises: [{ id: "metadata", value: "574", unit: "bytes", source: { kind: "platform", reference: "platform.runtime", detail: "当前连接快照" } }],
    expressions: [{ id: "bound", unit: "bytes", formula: { op: "add", args: [{ ref: "metadata" }, { value: "2" }] } }],
  }, { draft, platform, issues: [issue], requirementIds: issue.requirementIds, verification: checks() });
  let modelCalls = 0, reads = 0;
  const current = { ...snapshot(), version: 1 };
  const verifySystemIssues = createRequirementSystemVerifier({ connections: { snapshot: async () => { reads++; assert.equal(modelCalls, 0); return current; } } });
  const provider = makeProviders({ llmConfigured: true, model: "fixture", apiKey: "local", chatUrl: "https://model.invalid/chat" }, async (_url, options) => {
    modelCalls++; const context = JSON.parse(JSON.parse(options.body).messages[1].content);
    if (modelCalls === 1) {
      assert.deepEqual(new Set(context.systemChecks.map((check) => check.id)), new Set([issue.id, activation.id]));
      assert.ok(context.trustedFacts.some((fact) => fact.path === "currentConnectionFraming.configVersion" && fact.value === 1));
      assert.deepEqual(context.proofContinuation.reusable, []);
      assert.equal(context.proofContinuation.invalidated[0].id, old.id);
      assert.deepEqual(context.hostExecution.activeReceiptIds, []); assert.equal(context.remainingReadOnlyCalls, 1);
      assert.equal(context.historicalDerivations[0].id, old.id);
    }
    const result = context.knownIssues ? { decisions: context.knownIssues.map((item) => ({ issueId: item.id, owner: "system", status: "open",
      stage: item.id === issue.id ? "development" : "activation", checks: item.checks, evidence: [], reason: "当前平台路径成立，仍待研发或激活真实验收。" })) }
      : { ...await sufficientPreflight(), issues: [{ ...issue, stage: "development", blocking: false }, activation] };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }), { status: 200 });
  }, { verifySystemIssues });
  const result = await provider.preflight({ draft, platform, previousIssues: [issue, activation], priorDerivations: [old], verificationContext: { agentId: "alpha" } });
  assert.equal(result.verdict, "sufficient"); assert.equal(modelCalls, 2); assert.equal(reads, 1);
  assert.equal(result.preflightDiagnostic.readOnlyCalls, 1); assert.equal(result.preflightDiagnostic.systemVerificationCalls, 1);
  assert.equal(result.preflightDiagnostic.events[0].turn, 0); assert.equal(result.preflightDiagnostic.events[0].reason, "system_verification_completed");
  assert.equal(result.deferredIssues.length, 2);
});

test("首轮只读故障作为当前unknown交给模型，取消保留零模型及已用核实诊断且不泄露异常", async () => {
  const draft = { ...validDraft(), taskSpec: { version: 1, items: [] } }, platform = createPlatformSnapshot();
  const issue = { id: "capacity", owner: "system", stage: "requirements", blocking: true,
    question: "核实当前封装", impact: "决定路径", requirementIds: ["task"], checks: ["platform.runtime"] };
  const config = { llmConfigured: true, model: "fixture", apiKey: "local", chatUrl: "https://model.invalid/chat" };
  let modelCalls = 0;
  const failed = makeProviders(config, async (_url, options) => {
    modelCalls++; const context = JSON.parse(JSON.parse(options.body).messages[1].content);
    if (modelCalls === 1) { assert.equal(context.systemChecks[0].status, "unknown"); assert.deepEqual(context.trustedFacts, []); }
    const result = context.knownIssues ? { decisions: [{ issueId: issue.id, owner: "system", status: "open", stage: "requirements",
      checks: issue.checks, evidence: [], reason: "当前宿主事实未取得，不能承诺可承载。" }] }
      : { ...await sufficientPreflight(), verdict: "blocked", issues: [issue] };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }), { status: 200 });
  }, { verifySystemIssues: async () => { throw new Error("PRIVATE_VERIFICATION_ERROR"); } });
  const output = await failed.preflight({ draft, platform, previousIssues: [issue] });
  assert.equal(output.verdict, "blocked"); assert.equal(output.preflightDiagnostic.readOnlyCalls, 1); assert.equal(modelCalls, 2);
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE_VERIFICATION_ERROR/);
  const controller = new AbortController(); let reads = 0;
  const cancelled = makeProviders(config, async () => { throw new Error("model must not be called"); }, { verifySystemIssues: async () => {
    reads++; controller.abort(); throw new DOMException("PRIVATE_CANCEL_ERROR", "AbortError");
  } });
  await assert.rejects(cancelled.preflight({ draft, platform, previousIssues: [issue], signal: controller.signal }), (error) => {
    assert.equal(error.name, "AbortError"); assert.equal(error.preflightDiagnostic.modelTurns, 0); assert.equal(error.preflightDiagnostic.readOnlyCalls, 1);
    assert.equal(error.preflightDiagnostic.stopReason, "cancelled");
    assert.equal(error.preflightDiagnostic.events[0].reason, "system_verification_cancelled");
    assert.doesNotMatch(JSON.stringify(error.preflightDiagnostic), /PRIVATE_CANCEL_ERROR/); return true;
  });
  await assert.rejects(cancelled.preflight({ draft, platform, previousIssues: [issue], signal: controller.signal }), (error) => {
    assert.equal(error.preflightDiagnostic.modelTurns, 0); assert.equal(error.preflightDiagnostic.readOnlyCalls, 0); return true;
  });
  assert.equal(reads, 1);
});
