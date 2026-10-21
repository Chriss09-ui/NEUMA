import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ArchitectureDesigner } from "../src/architecture/architecture.mjs";
import { createArchitectureUnsubmittedDraft } from "../src/architecture/architecture-submission-repair.mjs";
import { architectureToolValidation } from "../src/architecture/architecture-tool-diagnostics.mjs";
import { designHash, requirementItems, reviewSubmissionSchema, validateReview } from "../src/architecture/architecture-contract.mjs";
import { architectureReviewEvidenceContext } from "../src/architecture/architecture-review-evidence.mjs";
import { createPiSession } from "../src/runtime/pi-runtime.mjs";
import { ACCEPTANCE_ADAPTER_GUIDE } from "../src/verification/acceptance-contract.mjs";
import { resolveCaseValues, inputContractMeasurement, inputContractRejection } from "../src/development/development-fixtures.mjs";
import { PLAN_V2_SCHEMA, PLAN_V3_SCHEMA, validatePlan } from "../src/development/development-contract.mjs";
import { diagnosePlanningPlan } from "../src/development/development-plan-diagnostics.mjs";
import { validDraft, validDesign, passingReview } from "./helpers/architecture.mjs";

const fixtureBytes = await readFile(new URL("./fixtures/architecture-recorded-failures.json", import.meta.url));
const recorded = JSON.parse(fixtureBytes);
const freeze = (value) => { for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child); return Object.freeze(value); };
freeze(recorded);

function reviewReplies(candidateHash) {
  const pattern = recorded.unsubmittedReview;
  // Only the observed invalid/valid structural pattern is reconstructed, never a real-case pass.
  const second = { candidateHash, verdict: pattern.secondResponse.verdict,
    checks: ["requirements", "feasibility", "minimality", "interfaces", "failure_handling", "verification"].map((id) => ({
      id, passed: id !== pattern.secondResponse.failedCheck, evidence: "去标识失败模式的结构字段，不是实际业务评审" })),
    issues: [], summary: pattern.secondResponse.summary };
  const first = structuredClone(second);
  delete first.candidateHash; first.checks[0][pattern.firstResponseMutations.unknownCheckField] = "derived-shape-only";
  return [first, second];
}

test("真实失败夹具只保留公开的最小模式，不自称原始回答或真实交付", () => {
  assert.ok(fixtureBytes.length < 8192);
  assert.equal(recorded.provenance.exactTranscript, false); assert.equal(recorded.provenance.deliveryEvidence, false);
  assert.equal(recorded.provenance.kind, "deidentified-minimal-public-failure-patterns");
  assert.equal(recorded.unsubmittedReview.observed.finalReason, "submission_incomplete");
  assert.equal(recorded.unsubmittedReview.observed.formalSubmissionAttempts, 0);
  assert.equal(recorded.inconsistentReview.observedInsufficientAcceptancePositions.length, 2);
});

test("回放首段结构错误和第二段合法正文，结构合法仍不等于正式提交", () => {
  const candidateHash = designHash({ recorded: "candidate" }), schema = reviewSubmissionSchema();
  const replies = reviewReplies(candidateHash), staged = createArchitectureUnsubmittedDraft({ schema, binding: { role: "reviewer", candidateHash } });
  const message = (value) => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify(value) }] });
  assert.equal(staged.captureAssistant(message(replies[0])), null);
  assert.equal(staged.diagnostic().reason, recorded.unsubmittedReview.observed.diagnostics[0].reason);
  for (const reason of recorded.unsubmittedReview.observed.diagnostics[0].reasons)
    assert.ok(staged.diagnostic().issues.some((issue) => issue.reason === reason));
  const reference = staged.captureAssistant(message(replies[1]));
  assert.match(reference.draftHash, /^[a-f0-9]{64}$/u);
  assert.equal(staged.diagnostic().reason, recorded.unsubmittedReview.observed.diagnostics[1].reason);
  assert.deepEqual(staged.consume({ draftHash: reference.draftHash }), replies[1], "只有显式消费宿主引用才能取回候选，不能自行认定通过");
  assert.equal(replies[1].verdict, "revise");
});

test("真实Pi离线回放第二段合法结构化结果可正式返回修订，仍不自动判通过", { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-recorded-failure-replay-")), requests = [], progress = [];
  const candidateHash = designHash({ recorded: "candidate" }), replies = reviewReplies(candidateHash);
  let diagnostic, fidelityCalls = 0;
  const model = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    const value = replies[requests.length - 1];
    if (!value) { response.writeHead(500); response.end("Recorded replay has no third model answer"); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "recorded-local", choices: [{ index: 0, delta: { role: "assistant", content: JSON.stringify(value) }, finish_reason: "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  const designer = new ArchitectureDesigner({ config: { llmConfigured: true, model: "recorded-local-fixture", apiKey: "local-fixture-only",
    chatUrl: `http://127.0.0.1:${model.address().port}/v1/chat/completions` }, cwd: root, dataDir: join(root, "data"),
    sessionFactory: async (options) => { const session = await createPiSession(options); session.setAutoCompactionEnabled(false); session.setAutoRetryEnabled(false); return session; },
    fidelitySessionFactory: async () => { fidelityCalls++; throw new Error("No recorded formal review permits fidelity evaluation"); } });
  t.after(async () => { await designer.persistence; model.closeAllConnections(); await new Promise((resolve) => model.close(resolve)); await rm(root, { recursive: true, force: true }); });
  await designer.ready;
  const result = await designer.role({ role: "reviewer", systemPrompt: "只回放本地公开失败模式，不证明业务通过。",
    submitName: "submit_architecture_review", parameters: reviewSubmissionSchema(), payload: { candidateHash },
    validate: (value) => validateReview(value, { candidateHash }), onProgress() {}, onDiagnostics: (value) => { diagnostic = value; },
    onReviewProgress: (value) => { progress.push(structuredClone(value)); } });
  assert.equal(result.verdict, "revise");
  assert.equal(requests.length, 2); assert.equal(diagnostic.modelCalls, 2); assert.equal(diagnostic.submissionAttempts, 1);
  assert.equal(diagnostic.unsubmittedDraftDiagnostics.at(-1).reason, "schema_rejected");
  assert.equal(fidelityCalls, 0);
  const retained = progress.findLast((value) => value.origin === "semantic-rejected");
  assert.ok(retained, "第二次正文正式提交后仍须经过原语义校验，拒稿保留且不增加模型回合");
  assert.deepEqual(retained.review, replies[1]); assert.equal(retained.modelCalls, 2);
});

test("错误computed能力假设回放：字面内容允许，但伪造成功回执不能通过材料核验", () => {
  const pattern = recorded.computedPlaceholder;
  const item = { input: "{}", assertions: [], mocks: [{ capability: "files.write",
    argsJson: JSON.stringify(pattern.args), resultJson: JSON.stringify(pattern.receipt) }] };
  assert.throws(() => resolveCaseValues(item), (error) => error.materialIssues.some((issue) => issue.path === "mocks[0].resultJson.integrity.sha256"));
  const receipt = { saved: true, file: pattern.args.file, characters: pattern.args.content.length,
    integrity: { bytes: Buffer.byteLength(pattern.args.content), utf16Units: pattern.args.content.length,
      sha256: createHash("sha256").update(pattern.args.content).digest("hex") } };
  const expanded = resolveCaseValues({ ...item, mocks: [{ ...item.mocks[0], resultJson: JSON.stringify(receipt) }] });
  assert.equal(pattern.claimedDynamicPlaceholders, true);
  assert.equal(ACCEPTANCE_ADAPTER_GUIDE.adapters.action.executionFacts.dynamicPlaceholders, false);
  assert.deepEqual(expanded.mocks[0].args, pattern.args); assert.deepEqual(expanded.mocks[0].value, receipt);
  assert.equal(expanded.mocks[0].args.content, "<computed-result-json>");
  assert.notEqual(expanded.mocks[0].value.integrity.sha256, "<computed-result-json-sha256>");
  assert.equal(ACCEPTANCE_ADAPTER_GUIDE.adapters.action.executionFacts.fixtureConstruction.businessOracle, false);
});

function admissionPlan(managed) {
  const pattern = recorded.legalInputAssignedToRejection, action = { id: "run", title: "处理", connectionIds: [],
    inputSchema: structuredClone(pattern.inputSchema), outputSchema: structuredClone(pattern.inputSchema) };
  const runtime = managed ? "managed-service" : "node-action", entrypoint = managed ? "service.py" : "main.mjs";
  const architecture = { requirements: [{ id: "input_rule" }], design: { schemaVersion: managed ? 3 : 2, connections: [], interaction: { page: false },
    ...(managed ? { execution: { language: "python", hosting: "managed" } } : {}),
    acceptance: [{ id: "input_check", requirementIds: ["input_rule"] }] } };
  const application = { protocolVersion: managed ? 3 : 2, runtime, entrypoint, page: null, stateVersion: 1, evidenceIds: [], actions: [action] };
  if (managed) application.service = { schemaVersion: 1, language: "python", host: "managed", entrypoint,
    operations: [{ ...structuredClone(action), visibility: "public" }], dependencies: { packages: [] }, resources: {}, dataVersion: 1, capabilities: [] };
  const base = { taskId: "core", acceptanceId: "input_check", actionId: action.id, mocks: [], input: JSON.stringify(pattern.input) };
  const plan = { schemaVersion: managed ? 3 : 2, summary: "去标识的合法输入误配拒绝检查器", runtime, entrypoint, application,
    tasks: [{ id: "core", title: "处理", description: "验证输入", requirementIds: ["input_rule"], acceptanceIds: ["input_check"], dependsOn: [], files: [entrypoint] }],
    cases: [{ ...base, id: "positive", kind: "action", assertions: [{ path: "value", expectedJson: "1" }] },
      { ...base, id: "wrong_rejection", kind: "input-rejection", inputTarget: "task-envelope", assertions: structuredClone(pattern.rejectionAssertions) }] };
  return { action, architecture, plan, schema: managed ? PLAN_V3_SCHEMA : PLAN_V2_SCHEMA };
}

test("合法值和合法信封误配拒绝检查器，实际程序拒绝该计划且不运行或改写业务用例", () => {
  for (const managed of [false, true]) {
    const { action, architecture, plan, schema } = admissionPlan(managed), before = structuredClone(plan);
    for (const target of ["action-value", "task-envelope"]) {
      assert.equal(inputContractRejection(action, recorded.legalInputAssignedToRejection.input, { target }).rejected, false);
      const measurement = inputContractMeasurement(action, recorded.legalInputAssignedToRejection.input, { target });
      assert.ok(measurement.bytes < measurement.limit);
      plan.cases[1].inputTarget = target;
      const issues = diagnosePlanningPlan(plan, schema, { architecture }).issues.filter((issue) => issue.reason === recorded.legalInputAssignedToRejection.observedReason);
      assert.equal(issues.length, 1); assert.deepEqual(issues[0].measurement, measurement);
      assert.match(issues[0].remedy, new RegExp(`${measurement.bytes}字节`));
      assert.throws(() => validatePlan(plan, { architecture }));
    }
    assert.deepEqual(plan, before, "诊断不修正输入、类型或原断言，也不把合法样本变成拒绝样本");
  }
});

test("模型评审不自洽回放：失败检查无问题且两项范围不足，实际评审校验同时保留三个问题", () => {
  const draft = validDraft(), requirements = requirementItems(draft), candidate = validDesign(requirements, { schemaVersion: 3 });
  const candidateHash = designHash(candidate), review = passingReview(candidateHash, candidate), pattern = recorded.inconsistentReview;
  review.verdict = "revise"; review.checks.find((item) => item.id === pattern.failedCheckWithoutIssue).passed = false;
  for (const index of pattern.localInsufficientAcceptancePositions) review.acceptanceScopeChecks[index].sufficient = false;
  assert.equal(review.checks.find((item) => item.id === "acceptance_quality").passed, pattern.acceptanceQualityPassed);
  const evidenceContext = architectureReviewEvidenceContext({ design: candidate, requirements, runtimeCapabilities: { version: 1 } });
  const before = structuredClone(review);
  assert.equal(architectureToolValidation(review, reviewSubmissionSchema({ evidenceRequired: true }), { root: "review" }).valid, true,
    "结构合法并不证明模型结论自洽");
  assert.throws(() => validateReview(review, { candidateHash, schemaVersion: 3, evidenceContext }), (error) => {
    assert.ok(error.validationIssues.some((issue) => issue.reason === "missing_check_issue"));
    const scope = error.validationIssues.filter((issue) => issue.reason === "missing_scope_issue");
    assert.equal(scope.length, 2); return true;
  });
  assert.deepEqual(review, before);
});

test("真实Pi离线回放三次相同评审引用错误，在第四次请求前停止且同对象恢复不追加请求", { timeout: 15000 }, async (t) => {
  // Repetition extends the recorded quote-error pattern to test the guard; it is not an exact three-response transcript.
  const root = await mkdtemp(join(tmpdir(), "neuma-recorded-stalled-review-")), requests = [];
  const requirements = requirementItems(validDraft()), candidate = validDesign(requirements, { schemaVersion: 3 });
  const candidateHash = designHash(candidate), review = passingReview(candidateHash, candidate);
  review.verdict = "revise"; review.checks.find((item) => item.id === "verification").passed = false;
  review.issues.push({ id: "repeated_quote", blocking: true, checkId: "verification", kind: "design",
    description: "去标识引用错误的重复回放，不是新的业务结论", remedy: "重新核对当前候选原文",
    candidatePaths: ["/instructions"], factClaims: [],
    references: [{ source: "candidate", path: "/instructions", quote: "recorded-quote-not-in-current-candidate" }] });
  const evidenceContext = architectureReviewEvidenceContext({ design: candidate, requirements, runtimeCapabilities: { version: 1 } });
  const validate = (value) => validateReview(value, { candidateHash, schemaVersion: 3, evidenceContext });
  assert.throws(() => validate(review), (error) => error.validationIssue.reason === "reference_quote_mismatch");
  let diagnostic, fidelityCalls = 0;
  const model = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    if (requests.length > 3) { response.writeHead(500); response.end("No fourth recorded repair answer exists"); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "recorded-stalled-local", choices: [{ index: 0, delta: { role: "assistant",
      tool_calls: [{ index: 0, id: `repeated-quote-${requests.length}`, type: "function", function: {
        name: "submit_architecture_review", arguments: JSON.stringify(review) } }] }, finish_reason: "tool_calls" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  const designer = new ArchitectureDesigner({ config: { llmConfigured: true, model: "recorded-local-fixture", apiKey: "local-fixture-only",
    chatUrl: `http://127.0.0.1:${model.address().port}/v1/chat/completions` }, cwd: root, dataDir: join(root, "data"),
    sessionFactory: async (options) => { const session = await createPiSession(options); session.setAutoCompactionEnabled(false); session.setAutoRetryEnabled(false); return session; },
    fidelitySessionFactory: async () => { fidelityCalls++; throw new Error("A rejected review cannot start fidelity evaluation"); } });
  t.after(async () => { await designer.persistence; model.closeAllConnections(); await new Promise((resolve) => model.close(resolve)); await rm(root, { recursive: true, force: true }); });
  await designer.ready;
  const options = { role: "reviewer", systemPrompt: "只回放本地公开引用失败模式，不证明业务通过。",
    submitName: "submit_architecture_review", parameters: reviewSubmissionSchema({ evidenceRequired: true }), validate,
    payload: { candidateHash, design: candidate, requirements, runtimeCapabilities: { version: 1 }, requireAcceptanceVerification: true },
    reviewEvidenceContext: evidenceContext, onProgress() {}, onDiagnostics: (value) => { diagnostic = value; } };
  await assert.rejects(designer.role(options), (error) => error.diagnostic.reason === "review_repair_stalled");
  assert.equal(requests.length, 3); assert.equal(diagnostic.modelCalls, 3); assert.equal(diagnostic.submissionAttempts, 3);
  assert.equal(diagnostic.status, "incomplete"); assert.equal(diagnostic.repeatedFailure.count, 3);
  assert.ok(diagnostic.lastSubmissionDiagnostics.issues.some((issue) => issue.reason === "reference_quote_mismatch"));
  assert.equal(fidelityCalls, 0);
  const savedDiagnostic = structuredClone(diagnostic);
  await assert.rejects(designer.role({ ...options, initialModelCalls: 3,
    resumeReviewProgress: { review: structuredClone(review), modelCalls: 3, origin: "semantic-rejected", diagnostic: savedDiagnostic } }),
  (error) => error.diagnostic.reason === "review_repair_stalled");
  assert.equal(requests.length, 3, "同模型、同提交结构和原停滞计数恢复，不能再请求第四次");
  assert.equal(diagnostic.modelCalls, 3); assert.equal(diagnostic.repeatedFailure.count, 3); assert.equal(fidelityCalls, 0);
});
