import assert from "node:assert/strict";
import test from "node:test";
import { ACCEPTANCE_ADAPTERS, ACCEPTANCE_VERIFICATION_SCHEMA, acceptanceEvidenceHash, assertAcceptanceComplete,
  createAcceptanceLedger, developmentAcceptanceItems, recordDevelopmentAcceptance, recordRuntimeAcceptance,
  activationBusinessAcceptanceItems, recordIndependentAcceptance,
  requiredDevelopmentRequirementIds, summarizeAcceptanceLedger, validateAcceptanceCoverage,
  validateAcceptanceVerification, verifyActivationAcceptance } from "../src/verification/acceptance-contract.mjs";
import { hashValue, validatePlan } from "../src/development/development-contract.mjs";

const hash = (text) => acceptanceEvidenceHash(text);
const descriptor = (adapterId) => ({ adapterId, stage: ACCEPTANCE_ADAPTERS[adapterId].stage, owner: ACCEPTANCE_ADAPTERS[adapterId].owner });
function fixture() {
  const requirements = ["task", "deliverable", "artifact", "conversation"].map((id) => ({ id, text: `需求 ${id}` }));
  const acceptance = [
    { id: "compute", requirementIds: ["task", "deliverable"], verification: descriptor("action") },
    { id: "files", requirementIds: ["artifact"], verification: descriptor("host-files") },
    { id: "missing", requirementIds: ["conversation"], verification: descriptor("conversation") },
  ];
  const architecture = { agentId: "agent_test", version: 1, candidateHash: hash("design"), requirements,
    draft: { interaction: { operations: [] } }, design: { interaction: { operations: true }, acceptance } };
  const plan = { summary: "执行处理", runtime: "node-json", entrypoint: "main.mjs",
    tasks: [{ id: "core", title: "处理", description: "执行实际处理", requirementIds: ["task", "deliverable"],
      acceptanceIds: ["compute"], dependsOn: [], files: ["main.mjs"] }],
    cases: [{ id: "compute_one", taskId: "core", acceptanceId: "compute", input: "one", assertions: [{ path: "", expectedJson: "1" }] }] };
  return { architecture, plan, codeHash: hash("code") };
}
function developmentEvidence(value = fixture()) {
  const report = { id: "report_1", codeHash: value.codeHash, status: "passed", planHash: hashValue(value.plan),
    results: [{ caseId: "compute_one", taskId: "core", acceptanceId: "compute", status: "passed", actionExecuted: true,
      actual: 1, exitCode: 0, stdout: "1", stderr: "" }] };
  return recordDevelopmentAcceptance(createAcceptanceLedger(value), { report, cases: value.plan.cases });
}

test("verification descriptors keep legacy objects unchanged and reject unsupported responsibility combinations", () => {
  const old = { id: "old" };
  assert.deepEqual(validateAcceptanceVerification(old), descriptor("action"));
  assert.deepEqual(old, { id: "old" });
  assert.throws(() => validateAcceptanceVerification(old, { required: true }));
  assert.ok(ACCEPTANCE_VERIFICATION_SCHEMA.allOf.length);
  for (const adapterId of Object.keys(ACCEPTANCE_ADAPTERS)) assert.deepEqual(validateAcceptanceVerification({ verification: descriptor(adapterId) }), descriptor(adapterId));
  for (const value of [null, [], { ...descriptor("action"), skip: true }, { ...descriptor("host-files"), stage: "runtime" },
    { ...descriptor("conversation"), stage: "activation" }, { stage: "activation", owner: "platform", adapterId: "__proto__" }])
    assert.throws(() => validateAcceptanceVerification({ verification: value }));
});

test("development tasks cover only code obligations while all acceptance remains in a frozen ledger", () => {
  const value = fixture();
  assert.deepEqual(requiredDevelopmentRequirementIds(value.architecture), ["task", "deliverable"]);
  assert.deepEqual(developmentAcceptanceItems(value.architecture).map((item) => item.id), ["compute"]);
  assert.deepEqual(validatePlan(value.plan, { architecture: value.architecture }), value.plan);
  const ledger = createAcceptanceLedger(value);
  assert.deepEqual(ledger.items.map((item) => [item.acceptanceId, item.status]), [["compute", "not_run"], ["files", "not_run"], ["missing", "not_run"]]);
  assert.equal(ledger.binding.planHash, hashValue(value.plan));
  const wrong = structuredClone(value.plan); wrong.tasks[0].acceptanceIds.push("files");
  assert.throws(() => validatePlan(wrong, { architecture: value.architecture }), /宿主或运行阶段/);
  const missing = structuredClone(value.architecture); missing.design.acceptance.pop();
  assert.throws(() => createAcceptanceLedger({ ...value, architecture: missing }), /完整验收覆盖/);
});

test("generated operations cannot move all task and delivery assertions to runtime or host checks", () => {
  for (const adapterId of ["host-files", "conversation", "input-contract", "page-resources", "host-business", "delivery-review"]) {
    const { architecture } = fixture(); architecture.design.acceptance[0].verification = descriptor(adapterId);
    assert.throws(() => validateAcceptanceCoverage(architecture), /研发动作验收/);
  }
  const { architecture } = fixture();
  architecture.draft.interaction.operations = ["用户确认的操作"];
  architecture.requirements.push({ id: "operation_1", text: "操作" });
  architecture.design.acceptance.push({ id: "operation_check", requirementIds: ["operation_1"], verification: descriptor("host-runtime") });
  assert.throws(() => validateAcceptanceCoverage(architecture), /研发动作验收/);
  architecture.design.acceptance[0].requirementIds.push("operation_1");
  assert.doesNotThrow(() => validateAcceptanceCoverage(architecture));
});

test("static delivery review needs both existing independent current-version reviews and cannot create substitute execution cases", () => {
  const value = fixture();
  value.architecture.requirements.push({ id: "language", text: "交付选定的代码语言" });
  value.architecture.design.acceptance.push({ id: "static_language", requirementIds: ["language"], verification: descriptor("delivery-review") });
  assert.deepEqual(developmentAcceptanceItems(value.architecture).map((item) => item.id), ["compute"]);
  assert.deepEqual(requiredDevelopmentRequirementIds(value.architecture), ["task", "deliverable"]);
  assert.deepEqual(activationBusinessAcceptanceItems(value.architecture), []);
  assert.doesNotThrow(() => validatePlan(value.plan, { architecture: value.architecture }));
  const architectureRef = { version: value.architecture.version, candidateHash: value.architecture.candidateHash };
  const planHash = hashValue(value.plan), report = { id: "report_current", mode: "integration", status: "passed", codeHash: value.codeHash,
    planHash, architectureRef, results: [{ caseId: "compute_one", taskId: "core", acceptanceId: "compute", actionExecuted: true, status: "passed", actual: 1 }] };
  const ledger = recordDevelopmentAcceptance(createAcceptanceLedger(value), { report, cases: value.plan.cases });
  assert.equal(ledger.items.find((item) => item.acceptanceId === "static_language").status, "not_run");
  assert.throws(() => assertAcceptanceComplete(ledger, { ...value, stageScope: ["development"] }));
  const planReview = { mode: "plan", codeHash: null, planHash, verdict: "pass", issues: [], summary: "已有独立计划评审",
    subjectHash: hashValue({ mode: "plan", architectureRef, plan: value.plan, planHash }) };
  const integrationReview = { mode: "integration", codeHash: value.codeHash, planHash, verdict: "pass", issues: [], summary: "已有独立最终代码评审",
    subjectHash: hashValue({ mode: "integration", architectureRef, plan: value.plan, planHash, task: null, report, codeHash: value.codeHash }) };
  const options = { plan: value.plan, planReview, integrationReview, report };
  for (const mutate of [
    (next) => { delete next.planReview; }, (next) => { next.planReview.mode = "task"; },
    (next) => { next.planReview.planHash = hash("old-plan"); }, (next) => { next.planReview.subjectHash = hash("old-subject"); },
    (next) => { next.integrationReview.codeHash = hash("old-code"); }, (next) => { next.report.codeHash = hash("old-code"); },
    (next) => { next.integrationReview.subjectHash = hash("old-subject"); }, (next) => { next.integrationReview.verdict = "revise"; },
  ]) {
    const changed = structuredClone(options); mutate(changed);
    assert.throws(() => recordIndependentAcceptance(ledger, changed));
  }
  const recorded = recordIndependentAcceptance(ledger, options);
  const current = structuredClone(options);
  current.planReview.subjectVersion = 2;
  current.planReview.subjectHash = hashValue({ mode: "plan", architectureRef, plan: value.plan, planHash, admissionFacts: [] });
  assert.doesNotThrow(() => recordIndependentAcceptance(ledger, current));
  const transitional = structuredClone(current); delete transitional.planReview.subjectVersion;
  assert.doesNotThrow(() => recordIndependentAcceptance(ledger, transitional));
  for (const mutate of [(entry) => { entry.planReview.subjectVersion = 3; },
    (entry) => { entry.planReview.subjectHash = planReview.subjectHash; },
    (entry) => { entry.planReview.subjectHash = hashValue({ mode: "plan", architectureRef, plan: value.plan, planHash, admissionFacts: [{ rejected: false }] }); }]) {
    const wrong = structuredClone(current); mutate(wrong); assert.throws(() => recordIndependentAcceptance(ledger, wrong));
  }
  assert.doesNotThrow(() => assertAcceptanceComplete(recorded, { ...value, stageScope: ["development"] }));
  const staticItem = recorded.items.find((item) => item.acceptanceId === "static_language");
  assert.equal(staticItem.evidence.kind, "independent-review"); assert.equal(staticItem.evidence.mode, "actual");
  const tampered = structuredClone(recorded); tampered.items.find((item) => item.acceptanceId === "static_language").evidence.planHash = hash("old-plan");
  assert.throws(() => assertAcceptanceComplete(tampered, { ...value, stageScope: ["development"] }));
  const wrong = structuredClone(value.plan); wrong.tasks[0].acceptanceIds.push("static_language");
  assert.throws(() => validatePlan(wrong, { architecture: value.architecture }));
});

test("deferred obligations retain their original verification stage and expose every controlled missing reference", () => {
  const value = fixture(), { architecture } = value;
  architecture.requirements.push({ id: "verification_capacity", text: "后续研发容量验证" }, { id: "verification_runtime", text: "后续环境验证" });
  architecture.deferredVerifications = { issues: [
    { requirementId: "verification_capacity", stage: "development" }, { requirementId: "verification_runtime", stage: "activation" },
  ] };
  architecture.design.acceptance.push({ id: "wrong_capacity", requirementIds: ["verification_capacity"], verification: descriptor("host-files") },
    { id: "wrong_runtime", requirementIds: ["verification_runtime"], verification: descriptor("conversation") });
  assert.throws(() => validateAcceptanceCoverage(architecture), (error) => {
    assert.equal(error.validationIssue.path, "design.acceptance"); assert.equal(error.validationIssue.reason, "missing_coverage");
    assert.deepEqual(error.validationIssue.missingReferences, ["verification_capacity", "verification_runtime"]);
    assert.ok(error.validationIssue.allowedReferences.includes("verification_capacity")); return true;
  });
  architecture.design.acceptance[0].requirementIds.push("verification_capacity");
  architecture.design.acceptance.push({ id: "real_runtime", requirementIds: ["verification_runtime"], verification: descriptor("host-runtime") });
  assert.doesNotThrow(() => validateAcceptanceCoverage(architecture), "允许不同阶段补充证据，但不能删除原阶段的责任");
  architecture.design.interaction.operations = false;
  architecture.design.acceptance[0].requirementIds = architecture.design.acceptance[0].requirementIds.filter((id) => id !== "verification_capacity");
  assert.throws(() => validateAcceptanceCoverage(architecture), /原阶段验收/, "没有公开动作也不能把遗留义务静默后移");
  const legacy = structuredClone(architecture);
  legacy.design.acceptance.forEach((item) => { delete item.verification; });
  assert.doesNotThrow(() => validateAcceptanceCoverage(legacy), "历史未声明分工的架构保持兼容读取，不自动改签或重算");
  const invalid = structuredClone(architecture); invalid.deferredVerifications.issues[0].requirementId = "not_declared";
  assert.throws(() => validateAcceptanceCoverage(invalid), (error) => error.validationIssue.reason === "invalid_reference"
    && !error.validationIssue.allowedReferences.includes("not_declared"));
});

test("missing action coverage reports only approved requirement ids rather than a generic root error", () => {
  const { architecture } = fixture();
  architecture.design.acceptance[0].verification = descriptor("conversation");
  assert.throws(() => validateAcceptanceCoverage(architecture), (error) => {
    assert.deepEqual(error.validationIssue.missingReferences, ["task", "deliverable"]);
    assert.equal(error.validationIssue.path, "design.acceptance"); return true;
  });
});

test("actual execution evidence must match case, task, action and all frozen version bindings", () => {
  const value = fixture(), ledger = createAcceptanceLedger(value);
  const report = { id: "a38db864-6b3b-4c97-800e-832f8da9bacb", codeHash: value.codeHash, status: "passed", results: [
    { caseId: "compute_one", taskId: "core", acceptanceId: "compute", actionExecuted: true, status: "passed", optional: undefined },
  ] };
  assert.equal(recordDevelopmentAcceptance(ledger, { report, cases: value.plan.cases }).items[0].status, "passed");
  for (const mutate of [
    (entry) => { entry.status = "error"; }, (entry) => { entry.results[0].taskId = "other"; },
    (entry) => { entry.results[0].actionExecuted = false; }, (entry) => { entry.results.push({ ...entry.results[0] }); },
  ]) {
    const wrong = structuredClone(report); mutate(wrong);
    assert.notEqual(recordDevelopmentAcceptance(ledger, { report: wrong, cases: value.plan.cases }).items[0].status, "passed");
  }
  for (const wrong of [{ ...report, codeHash: hash("old") }, { ...report, planHash: hash("old") },
    { ...report, architectureRef: { version: 2, candidateHash: value.architecture.candidateHash } }])
    assert.throws(() => recordDevelopmentAcceptance(ledger, { report: wrong, cases: value.plan.cases }));
});

test("input rejection and static page evidence cannot be presented as executed business code", () => {
  const value = fixture();
  value.architecture.design.interaction.operations = false;
  for (const [adapterId, result] of [["input-contract", { actionExecuted: false, evidenceMode: "input_contract" }],
    ["page-resources", { kind: "node-check", evidenceMode: "node_check", browserVerified: false }]]) {
    value.architecture.design.acceptance[0].verification = descriptor(adapterId);
    const ledger = createAcceptanceLedger(value), report = { id: "report", status: "passed", codeHash: value.codeHash, results: [
      { caseId: "compute_one", taskId: "core", acceptanceId: "compute", status: "passed", ...result },
    ] };
    assert.equal(recordDevelopmentAcceptance(ledger, { report, cases: value.plan.cases }).items[0].status, "passed");
    report.results[0] = { caseId: "compute_one", taskId: "core", acceptanceId: "compute", status: "passed", actionExecuted: true };
    assert.equal(recordDevelopmentAcceptance(ledger, { report, cases: value.plan.cases }).items[0].status, "not_run");
  }
});

test("missing, simulated, stale or wrongly scoped host adapters never count as activation evidence", async () => {
  const value = fixture(), ledger = developmentEvidence(value);
  const pending = await verifyActivationAcceptance(ledger, { architecture: value.architecture });
  assert.equal(pending.items[1].status, "not_run");
  assert.throws(() => assertAcceptanceComplete(pending, { ...value, stageScope: ["development", "activation"] }));
  for (const delta of [{ mode: "mock" }, { bindingHash: hash("old") }, { scope: "all-business-assertions" }, { evidenceHash: "not-a-hash" }]) {
    const next = await verifyActivationAcceptance(ledger, { architecture: value.architecture, adapters: {
      "host-files": async ({ bindingHash }) => ({ status: "passed", bindingHash, mode: "actual", evidenceId: "probe_1", evidenceHash: hash("observations"), scope: "artifact-file-roundtrip", ...delta }),
    } });
    assert.equal(next.items[1].status, "error");
  }
  const failed = await verifyActivationAcceptance(ledger, { architecture: value.architecture, adapters: { "host-files": async () => { throw new Error("PRIVATE_BODY"); } } });
  assert.equal(failed.items[1].status, "error"); assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_BODY/);
});

test("activation permits clearly pending conversation checks, but full completion requires actual bound runtime evidence", async () => {
  const value = fixture(), ledger = await verifyActivationAcceptance(developmentEvidence(value), { architecture: value.architecture, adapters: {
    "host-files": async ({ bindingHash }) => ({ status: "passed", bindingHash, mode: "actual", evidenceId: "probe_1", evidenceHash: hash("observations"), scope: "artifact-file-roundtrip" }),
  } });
  assert.deepEqual(summarizeAcceptanceLedger(ledger), { status: "not_run", activationComplete: true, activationPermitted: true, pendingActivation: [], outstandingRuntime: ["missing"] });
  assert.equal(assertAcceptanceComplete(ledger, { ...value, stageScope: ["development", "activation"] }), true);
  assert.throws(() => assertAcceptanceComplete(ledger, value));
  const evidence = { bindingHash: ledger.bindingHash, deliveryBinding: { agentId: value.architecture.agentId,
    architectureHash: value.architecture.candidateHash, planHash: hashValue(value.plan), codeHash: value.codeHash, deliveryVersion: `dev_run:${value.codeHash}` },
  taskId: "task_real", evidenceId: "conversation_real", mode: "actual", results: [{ acceptanceId: "missing", status: "passed", evidenceHash: hash("real-observation") }] };
  for (const delta of [{ mode: "mock" }, { bindingHash: hash("old") }, { results: [{ acceptanceId: "compute", status: "passed", evidenceHash: hash("wrong-stage") }] },
    { deliveryBinding: { ...evidence.deliveryBinding, codeHash: hash("old") } }]) assert.throws(() => recordRuntimeAcceptance(ledger, { ...evidence, ...delta }));
  const complete = recordRuntimeAcceptance(ledger, evidence);
  assert.equal(assertAcceptanceComplete(complete, value), true);
  assert.deepEqual(summarizeAcceptanceLedger(complete), { status: "passed", activationComplete: true, activationPermitted: true, pendingActivation: [], outstandingRuntime: [] });
  for (const mutate of [
    (entry) => { entry.items[0].verification = descriptor("conversation"); },
    (entry) => { entry.items[0].requirementIds = ["artifact"]; },
    (entry) => { entry.items[0].evidence.bindingHash = hash("old"); },
  ]) { const wrong = structuredClone(complete); mutate(wrong); assert.throws(() => assertAcceptanceComplete(wrong, value)); }
  assert.throws(() => assertAcceptanceComplete(complete, { ...value, plan: { ...value.plan, summary: "changed" } }));
});

test("only actually inspected unconfigured optional gateways may wait without blocking internal activation", async () => {
  const value = fixture();
  value.architecture.design.acceptance[1].verification = descriptor("host-gateway");
  const pending = await verifyActivationAcceptance(developmentEvidence(value), { architecture: value.architecture, adapters: {
    "host-gateway": async ({ bindingHash }) => ({ status: "not_run", bindingHash, mode: "actual", evidenceId: "gateway_config",
      evidenceHash: hash({ enabled: false }), scope: "gateway-configuration-state", reason: "gateway_configuration_required" }),
  } });
  assert.throws(() => assertAcceptanceComplete(pending, { ...value, stageScope: ["development", "activation"] }));
  const options = { ...value, stageScope: ["development", "activation"], allowPendingActivationAdapters: ["host-gateway"] };
  assert.equal(assertAcceptanceComplete(pending, options), true);
  assert.deepEqual(summarizeAcceptanceLedger(pending, options), { status: "not_run", activationComplete: false, activationPermitted: true,
    pendingActivation: ["files"], outstandingRuntime: ["missing"] });
  for (const mutate of [
    (entry) => { entry.items[1].status = "failed"; }, (entry) => { entry.items[1].status = "error"; },
    (entry) => { entry.items[1].reason = "verification_adapter_unavailable"; },
    (entry) => { delete entry.items[1].evidence; }, (entry) => { entry.items[1].evidence.mode = "mock"; },
    (entry) => { entry.items[1].evidence.evidenceHash = "invalid"; },
  ]) { const wrong = structuredClone(pending); mutate(wrong); assert.throws(() => assertAcceptanceComplete(wrong, options)); }
  assert.throws(() => assertAcceptanceComplete(pending, { ...options, allowPendingActivationAdapters: ["host-files"] }));
  const verified = await verifyActivationAcceptance(pending, { architecture: value.architecture, acceptanceIds: ["files"], adapters: {
    "host-gateway": async ({ bindingHash }) => ({ status: "passed", bindingHash, mode: "actual", evidenceId: "gateway_api_mcp",
      evidenceHash: hash("actual api and mcp observations"), scope: "authorized-gateway-contract" }),
  } });
  assert.equal(verified.items[0].status, "passed");
  assert.equal(assertAcceptanceComplete(verified, { ...value, stageScope: ["development", "activation"] }), true);
  assert.equal(verified.items[2].status, "not_run");
  await assert.rejects(verifyActivationAcceptance(verified, { architecture: value.architecture, acceptanceIds: ["missing"] }));
});

test("cancelled host verification cannot store a late pass", async () => {
  const value = fixture(), controller = new AbortController();
  await assert.rejects(verifyActivationAcceptance(developmentEvidence(value), { architecture: value.architecture, signal: controller.signal,
    adapters: { "host-files": async ({ bindingHash }) => { controller.abort(); return { status: "passed", mode: "actual", bindingHash, evidenceId: "late", evidenceHash: hash("late"), scope: "artifact-file-roundtrip" }; } } }), { name: "AbortError" });
});
