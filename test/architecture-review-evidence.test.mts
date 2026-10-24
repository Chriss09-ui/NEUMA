import { callFixture, recordArray, fixtureTools } from "./helpers/m7-test-boundaries.mjs";
import { fixtureString } from "./helpers/http-model.mjs";
import type { FixtureArchitectureReview } from "./helpers/architecture.mjs";
import type { ArchitectureIssue } from "../src/contracts/architecture.mjs";
function scopeRow(review: FixtureArchitectureReview, index = 0) { return objectFields(review.acceptanceScopeChecks![index]); }
import { objectFields } from "../src/runtime/type-boundary.mjs";
import { failureFields } from "./helpers/failure-fields.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { Ajv } from "ajv";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputError } from "../src/requirements/core.mjs";
import { ArchitectureDesigner } from "../src/architecture/architecture.mjs";
import { designHash, requirementItems, reviewSubmissionSchema, validateReview } from "../src/architecture/architecture-contract.mjs";
import { architectureReviewEvidenceContext, architectureReviewIssues, architectureHistoricalEvidenceCatalog } from "../src/architecture/architecture-review-evidence.mjs";
import { runtimeCapabilityContract, RUNTIME_CAPABILITY_CONTRACT, WORKSPACE_TEXT_WRITE_CODE_UNITS, MANAGED_SERVICE_MESSAGE_BYTES } from "../src/runtime/runtime-capability-contract.mjs";
import { passingReview, validDesign, validDraft } from "./helpers/architecture.mjs";
import { ACCEPTANCE_ADAPTERS, ACCEPTANCE_ADAPTER_GUIDE } from "../src/verification/acceptance-contract.mjs";

function fixture() {
  const requirements = requirementItems(validDraft());
  const design = validDesign(requirements, { schemaVersion: 3 });
  const context = architectureReviewEvidenceContext({ design, requirements, runtimeCapabilities: runtimeCapabilityContract() });
  const review = passingReview(designHash(design), design);
  const issue: ArchitectureIssue = { id: "delivery_choice", blocking: true, description: "交付步骤未明确当前文件路径", remedy: "在当前步骤说明实际保存路径",
    checkId: "interfaces", kind: "design", candidatePaths: ["/steps/0/output"],
    references: [{ source: "candidate", path: "/steps/0/output", quote: design.steps[0]!.output }], factClaims: [] };
  return { requirements, design, context, review, issue, options: { candidateHash: review.candidateHash, schemaVersion: 3, evidenceContext: context } };
}

test("旧评审只用精确冻结目录，新追加资料保留供新修订使用", () => {
  const f = fixture(), catalog = [{ id: "original", excerpt: "原评审依据" }];
  const manifest = architectureReviewEvidenceContext({ ...f.context, design: f.design, evidence: catalog }).contextManifest;
  const previous = { agentId: "same_agent", version: 1, sourceFingerprint: "same", draft: { original: true }, platformHash: "same-platform", evidence: catalog };
  const current = { ...structuredClone(previous), version: 2, evidence: [...catalog, { id: "later", excerpt: "评审结束后追加" }],
    reviewEvidence: { snapshot: { contextManifest: manifest } } };
  const original = structuredClone(current);
  assert.deepEqual(architectureHistoricalEvidenceCatalog(current, [previous]), catalog);
  assert.deepEqual(current, original);
  assert.throws(() => architectureHistoricalEvidenceCatalog(current), /找不到/u, "不能猜测当前目录的前缀");
  Reflect.set(current.reviewEvidence, "frozenEvidence", structuredClone(catalog));
  assert.deepEqual(architectureHistoricalEvidenceCatalog(current), catalog);
  recordArray(objectFields(current.reviewEvidence).frozenEvidence)[0]!.excerpt = "错误来源";
  assert.throws(() => architectureHistoricalEvidenceCatalog(current, [previous]), /不一致/u, "已知快照损坏不能换用旧历史掩盖");
});

test("历史目录不跨智能体、需求、平台或未来版本，长度相同也必须摘要匹配", () => {
  const f = fixture(), catalog = [{ id: "original", excerpt: "原始来源" }];
  const current = { agentId: "same_agent", version: 2, sourceFingerprint: "same", draft: { original: true }, platformHash: "same-platform",
    evidence: [...catalog, { id: "later" }], reviewEvidence: { snapshot: {
      contextManifest: architectureReviewEvidenceContext({ ...f.context, design: f.design, evidence: catalog }).contextManifest } } };
  for (const change of [{ agentId: "other" }, { version: 3 }, { sourceFingerprint: "other" }, { draft: { original: false } },
    { platformHash: "other" }, { evidence: [{ id: "original", excerpt: "篡改来源" }] }]) {
    const previous = { ...structuredClone(current), version: 1, evidence: structuredClone(catalog), ...change };
    assert.throws(() => architectureHistoricalEvidenceCatalog(current, [previous]));
  }
});

test("运行协议冻结真实同步/异步调用、文件单位和权限，调用者不能改写共享事实", () => {
  const value = runtimeCapabilityContract();
  assert.equal(value.methods["files.write"].limits.content, WORKSPACE_TEXT_WRITE_CODE_UNITS);
  assert.equal(value.transport.messageBytes, MANAGED_SERVICE_MESSAGE_BYTES);
  assert.equal(value.methods["files.write"].limits.unit, "utf16_code_units");
  assert.match(value.invocation.python, /synchronous/);
  assert.match(value.methods["files.read"].returns.text, /redacted/);
  assert.match(value.methods["files.write"].behavior, /no append/);
  assert.equal(Object.isFrozen(RUNTIME_CAPABILITY_CONTRACT.methods["files.write"]), true);
  value.methods["files.write"].limits.content = 1;
  assert.equal(runtimeCapabilityContract().methods["files.write"].limits.content, WORKSPACE_TEXT_WRITE_CODE_UNITS);
});

test("组合与正向准入事实不改变旧适配器引文、范围守卫或现有运行协议摘要", () => {
  const { review, options, context } = fixture();
  const runtimeHash = runtimeCapabilityContract().hash;
  assert.equal(ACCEPTANCE_ADAPTER_GUIDE.version, 2);
  assert.equal(ACCEPTANCE_ADAPTER_GUIDE.composition.unit, "acceptance.expected");
  assert.equal(ACCEPTANCE_ADAPTER_GUIDE.composition.sameAdapterMultipleCases, true);
  assert.equal(ACCEPTANCE_ADAPTER_GUIDE.admission["input-contract"].positiveTaskAdmission, false);
  assert.equal(ACCEPTANCE_ADAPTER_GUIDE.admission["host-business"].positiveTaskAdmission, true);
  assert.deepEqual(ACCEPTANCE_ADAPTER_GUIDE.admission["host-business"].actionOutcomeKinds, ["success", "declared-business-rejection"]);
  assert.equal(Object.isFrozen(ACCEPTANCE_ADAPTER_GUIDE.admission["host-business"].actionOutcomeKinds), true);
  assert.equal(Object.isFrozen(ACCEPTANCE_ADAPTER_GUIDE.admission["host-business"].excludedProof), true);
  scopeRow(review).adapterQuote = "真实运行已冻结输入的生成动作，并逐项核对该动作结果和业务断言。";
  assert.deepEqual(validateReview(review, options), review);
  assert.equal(objectFields(objectFields(context.acceptanceAdapterGuide).composition).sameAdapterMultipleCases, true);
  assert.equal(runtimeCapabilityContract().hash, runtimeHash);
  scopeRow(review).adapterId = "host-business";
  assert.throws(() => validateReview(review, options), (error) => failureFields(error).validationIssue?.reason === "scope_mismatch");
});

function adapterFixture(adapterId: keyof typeof ACCEPTANCE_ADAPTERS, guide: unknown = ACCEPTANCE_ADAPTER_GUIDE) {
  const { requirements, design } = fixture(), adapter = ACCEPTANCE_ADAPTERS[adapterId];
  design.acceptance[0]!.verification = { adapterId, stage: adapter.stage, owner: adapter.owner };
  const context = architectureReviewEvidenceContext({ design, requirements, runtimeCapabilities: runtimeCapabilityContract(), acceptanceAdapterGuide: guide });
  const review = passingReview(designHash(design), design);
  return { review, context, options: { candidateHash: review.candidateHash, schemaVersion: 3, evidenceContext: context } };
}

test("适配器范围引用允许当前通用组合规则与本条准入说明，旧指南三段继续兼容", () => {
  for (const adapterId of (Object.keys(ACCEPTANCE_ADAPTERS) as (keyof typeof ACCEPTANCE_ADAPTERS)[])) {
    const { review, options } = adapterFixture(adapterId);
    for (const field of ["caseSetRule", "requirementCoverageRule", "splitRule"] as const) {
      scopeRow(review).adapterQuote = ACCEPTANCE_ADAPTER_GUIDE.composition[field];
      assert.doesNotThrow(() => validateReview(review, options));
    }
  }
  for (const [adapterId, quotes] of [
    ["input-contract", [ACCEPTANCE_ADAPTER_GUIDE.admission["input-contract"].rule]],
    ["host-business", [ACCEPTANCE_ADAPTER_GUIDE.composition.hostBusinessRule, ACCEPTANCE_ADAPTER_GUIDE.admission["host-business"].rule,
      ACCEPTANCE_ADAPTER_GUIDE.admission["host-business"].measure, ACCEPTANCE_ADAPTER_GUIDE.admission["host-business"].outcomeRule,
      ...ACCEPTANCE_ADAPTER_GUIDE.admission["host-business"].excludedProof]],
  ] as const) {
    const { review, options } = adapterFixture(adapterId);
    for (const quote of quotes!) { scopeRow(review).adapterQuote = quote; assert.doesNotThrow(() => validateReview(review, options)); }
  }
  const legacy = { version: 1, adapters: structuredClone(ACCEPTANCE_ADAPTER_GUIDE.adapters) };
  const { review, options } = adapterFixture("action", legacy);
  assert.deepEqual(validateReview(review, options), review);
});

test("专属准入规则不能跨适配器，未知字段、短编号、函数名及过期原文均不能充当规则", () => {
  const { review, context, options } = adapterFixture("action");
  objectFields(objectFields(context.acceptanceAdapterGuide).composition).injected = "本轮未声明为规则的额外字段原文";
  for (const quote of [ACCEPTANCE_ADAPTER_GUIDE.composition.hostBusinessRule, ACCEPTANCE_ADAPTER_GUIDE.admission["input-contract"].rule,
    ACCEPTANCE_ADAPTER_GUIDE.admission["host-business"].rule, ACCEPTANCE_ADAPTER_GUIDE.admission["host-business"].outcomeRule,
    objectFields(objectFields(context.acceptanceAdapterGuide).composition).injected,
    "host-business", "action", "acceptance.expected", "ApplicationTaskStore.create", "这是上轮已失效的组合说明"]) {
    scopeRow(review).adapterQuote = quote;
    assert.throws(() => validateReview(review, options), (error) => failureFields(error).validationIssue?.reason === "reference_quote_mismatch");
  }
  const business = adapterFixture("host-business");
  objectFields(objectFields(objectFields(business.context.acceptanceAdapterGuide).admission)["host-business"]).extra = "专属准入对象额外字段也不构成规则";
  for (const quote of [ACCEPTANCE_ADAPTER_GUIDE.admission["input-contract"].rule, "ApplicationTaskStore.create", "JSON.stringify",
    "internal-application-task", objectFields(objectFields(objectFields(business.context.acceptanceAdapterGuide).admission)["host-business"]).extra]) {
    scopeRow(business.review).adapterQuote = quote;
    assert.throws(() => validateReview(business.review, business.options), (error) => failureFields(error).validationIssue?.reason === "reference_quote_mismatch");
  }
  scopeRow(business.review).adapterQuote = ACCEPTANCE_ADAPTER_GUIDE.admission["host-business"].rule;
  objectFields(objectFields(objectFields(business.context.acceptanceAdapterGuide).admission)["host-business"]).rule = "本轮已更新的规则；旧摘录不再适用。";
  assert.throws(() => validateReview(business.review, business.options), (error) => failureFields(error).validationIssue?.reason === "reference_quote_mismatch");
});

test("执行规则引用只能使用本条适配器，不把真实宿主限制移植到冻结模拟动作", () => {
  const ids = (Object.keys(ACCEPTANCE_ADAPTERS) as (keyof typeof ACCEPTANCE_ADAPTERS)[]);
  for (const [index, adapterId] of ids.entries()) {
    const { review, context, options } = adapterFixture(adapterId);
    scopeRow(review).adapterQuote = ACCEPTANCE_ADAPTER_GUIDE.adapters[adapterId].executionRule;
    assert.doesNotThrow(() => validateReview(review, options));
    scopeRow(review).adapterQuote = ACCEPTANCE_ADAPTER_GUIDE.adapters[ids[(index + 1) % ids.length]!].executionRule;
    assert.throws(() => validateReview(review, options), (error) => failureFields(error).validationIssue?.reason === "reference_quote_mismatch");
    scopeRow(review).adapterQuote = ACCEPTANCE_ADAPTER_GUIDE.adapters[adapterId].executionRule;
    Reflect.deleteProperty(objectFields(objectFields(objectFields(context.acceptanceAdapterGuide).adapters)[adapterId]), "executionRule");
    assert.throws(() => validateReview(review, options), (error) => failureFields(error).validationIssue?.reason === "reference_quote_mismatch");
  }
});

test("八项通过却附阻断被拒绝；失败检查必须有精确关联的阻断问题", () => {
  const { review, issue, options } = fixture();
  review.verdict = "revise"; review.issues = [issue];
  assert.throws(() => validateReview(review, options), (error) => failureFields(error).validationIssue?.reason === "contradictory_review");
  review.checks.find((entry) => entry.id === "interfaces")!.passed = false;
  assert.deepEqual(validateReview(review, options), review);
  review.checks.find((entry) => entry.id === "verification")!.passed = false;
  assert.throws(() => validateReview(review, options), (error) => failureFields(error).validationIssue?.reason === "missing_check_issue");
});

test("伪造候选路径、逐字依据和已截断说法不会形成正式架构阻断", () => {
  const { review, issue, options } = fixture();
  review.verdict = "revise"; review.checks.find((entry) => entry.id === "interfaces")!.passed = false;
  review.issues = [issue];
  for (const mutation of [
    (value: { candidatePaths: string[]; }) => { value.candidatePaths = ["/components/0/completion"]; },
    (value: { references: { quote: string; }[]; }) => { value.references[0]!.quote = "PRIVATE_FALSE_QUOTE"; },
    (value: { kind: string; factClaims: { source: string; path: string; expectedJson: string; }[]; }) => { value.kind = "context"; value.factClaims = [{ source: "contextManifest", path: "/requirements/delivery", expectedJson: '"summary"' }]; },
    (value: { kind: string; factClaims: { source: string; path: string; expectedJson: string; }[]; }) => { value.kind = "platform"; value.factClaims = [{ source: "runtimeCapabilities", path: "/methods/files.write/limits/content", expectedJson: "0" }]; },
  ] as const) {
    const changed = structuredClone(review); callFixture(mutation, undefined, [changed.issues[0]]);
    assert.throws(() => validateReview(changed, options), (error) => error instanceof InputError
      && !error.message.includes("PRIVATE_FALSE_QUOTE") && Boolean(error.validationIssue));
  }
  issue.factClaims = [{ source: "runtimeCapabilities", path: "/methods/files.write/limits/content", expectedJson: String(WORKSPACE_TEXT_WRITE_CODE_UNITS) }];
  assert.doesNotThrow(() => validateReview(review, options), "事实引用正确仍允许独立评审指出真实设计缺陷，不自动通过");
});

test("公开新评审结构要求关联元数据，旧记录仍可兼容读取", () => {
  const { review, issue, options } = fixture();
  review.verdict = "revise"; review.checks.find((entry) => entry.id === "interfaces")!.passed = false; review.issues = [issue];
  const schema = new Ajv({ strict: false }).compile(reviewSubmissionSchema({ evidenceRequired: true }));
  assert.equal(schema(review), true);
  const old = structuredClone(review);
  for (const key of ["checkId", "kind", "candidatePaths", "references", "factClaims"]) Reflect.deleteProperty(old.issues[0]!, key);
  assert.equal(schema(old), false);
  assert.deepEqual(validateReview(old, { candidateHash: review.candidateHash, schemaVersion: 3 }), old);
  assert.throws(() => validateReview(old, options), InputError);
});

test("新评审逐条核对验收与实际适配器范围，不完整或伪造引用不能通过", () => {
  const { review, options } = fixture();
  assert.doesNotThrow(() => validateReview(review, options));
  for (const [mutation, reason] of [
    [(value: FixtureArchitectureReview) => { delete value.acceptanceScopeChecks; }, null],
    [(value: { acceptanceScopeChecks: void[]; }) => { value.acceptanceScopeChecks.pop(); }, "missing_coverage"],
    [(value: FixtureArchitectureReview) => { value.acceptanceScopeChecks![1] = structuredClone(value.acceptanceScopeChecks![0]!); }, "invalid_reference"],
    [(value: { acceptanceScopeChecks: { adapterId: string; }[]; }) => { value.acceptanceScopeChecks[0]!.adapterId = "host-files"; }, "scope_mismatch"],
    [(value: { acceptanceScopeChecks: { scope: string; }[]; }) => { value.acceptanceScopeChecks[0]!.scope = "artifact-file-roundtrip"; }, "scope_mismatch"],
    [(value: { acceptanceScopeChecks: { criterionQuote: string; }[]; }) => { value.acceptanceScopeChecks[0]!.criterionQuote = "PRIVATE_FALSE_CRITERION"; }, "reference_quote_mismatch"],
    [(value: { acceptanceScopeChecks: { adapterQuote: string; }[]; }) => { value.acceptanceScopeChecks[0]!.adapterQuote = ACCEPTANCE_ADAPTER_GUIDE.adapters["host-files"].proves; }, "reference_quote_mismatch"],
  ] as const) {
    const changed = structuredClone(review); callFixture(mutation, undefined, [changed]);
    assert.throws(() => validateReview(changed, options), (error) => error instanceof InputError
      && (reason === null ? error.message.includes("acceptanceScopeChecks") : objectFields(error.validationIssue)?.reason === reason)
      && !error.message.includes("PRIVATE_FALSE_CRITERION"));
  }
  const old = structuredClone(review); delete old.acceptanceScopeChecks;
  assert.doesNotThrow(() => validateReview(old, { candidateHash: old.candidateHash, schemaVersion: 3 }), "历史评审读取不回填新逐项判断");
});

test("适配器不足必须对应本条验收的质量阻断，不能八项通过后以宿主探针承诺业务证明", () => {
  const { review, design, options } = fixture();
  scopeRow(review).sufficient = false;
  assert.throws(() => validateReview(review, options), (error) => failureFields(error).validationIssue?.reason === "missing_scope_issue");
  review.verdict = "revise";
  review.checks.find((entry) => entry.id === "acceptance_quality")!.passed = false;
  review.issues = [{ id: "scope_unsupported", checkId: "acceptance_quality", kind: "design", blocking: true,
    description: "这条检查不能覆盖完整承诺", remedy: "拆分验收，并为业务义务提供真实动作断言",
    candidatePaths: ["/acceptance/0/expected"], factClaims: [],
    references: [{ source: "candidate", path: "/acceptance/0/expected", quote: design.acceptance[0]!.expected },
      { source: "acceptanceAdapterGuide", path: "/adapters/action/doesNotProve", quote: ACCEPTANCE_ADAPTER_GUIDE.adapters.action.doesNotProve }] }];
  assert.deepEqual(validateReview(review, options), review);
  review.issues[0]!.candidatePaths = ["/acceptance/1/expected"];
  assert.throws(() => validateReview(review, options), (error) => failureFields(error).validationIssue?.reason === "missing_scope_issue");
});

test("引用诊断区分候选路径、来源路径与摘录，拒绝消息不泄露原文", () => {
  const { review, issue, options } = fixture();
  review.verdict = "revise"; review.checks.find((entry) => entry.id === "interfaces")!.passed = false; review.issues = [issue];
  for (const [mutation, reason] of [
    [(value: { candidatePaths: string[]; }) => { value.candidatePaths = ["/private_absent"]; }, "candidate_path_missing"],
    [(value: { references: { path: string; }[]; }) => { value.references[0]!.path = "/PRIVATE_MISSING_PATH"; }, "reference_path_missing"],
    [(value: { references: { quote: string; }[]; }) => { value.references[0]!.quote = "PRIVATE_UNMATCHED_QUOTE"; }, "reference_quote_mismatch"],
  ] as const) {
    const changed = structuredClone(review); callFixture(mutation, undefined, [changed.issues[0]]);
    assert.throws(() => validateReview(changed, options), (error) => failureFields(error).validationIssue?.reason === reason
      && !/PRIVATE_/u.test(fixtureString(failureFields(error).message)));
  }
});

test("同一次拒绝汇总独立的路径、摘录、事实与验证范围错误，不逐个消耗评审回合", () => {
  const { review, issue, options } = fixture();
  review.verdict = "revise"; review.checks.find((entry) => entry.id === "interfaces")!.passed = false;
  issue.candidatePaths = ["/PRIVATE_CANDIDATE_A", "/PRIVATE_CANDIDATE_B"];
  issue.references = [{ source: "candidate", path: "/PRIVATE_REFERENCE", quote: "PRIVATE_QUOTE" },
    { source: "candidate", path: "/steps/0/output", quote: "PRIVATE_UNMATCHED" }];
  issue.factClaims = [{ source: "runtimeCapabilities", path: "/PRIVATE_FACT", expectedJson: "0" },
    { source: "contextManifest", path: "/requirements/delivery", expectedJson: '"summary"' },
    { source: "runtimeCapabilities", path: "/version", expectedJson: "PRIVATE_INVALID_JSON" }];
  review.issues = [issue];
  scopeRow(review).criterionQuote = "PRIVATE_CRITERION";
  const snapshot = structuredClone(review);
  assert.throws(() => validateReview(review, options), (error) => {
    assert.ok(error instanceof InputError);
    assert.deepEqual(error.validationIssue, { path: "review.issues[0].candidatePaths[0]", reason: "candidate_path_missing" });
    assert.deepEqual(recordArray(error.validationIssues).map(({ path, reason }) => ({ path, reason })), [
      { path: "review.issues[0].candidatePaths[0]", reason: "candidate_path_missing" },
      { path: "review.issues[0].candidatePaths[1]", reason: "candidate_path_missing" },
      { path: "review.issues[0].references[0]", reason: "reference_path_missing" },
      { path: "review.issues[0].references[1]", reason: "reference_quote_mismatch" },
      { path: "review.issues[0].factClaims[0]", reason: "fact_mismatch" },
      { path: "review.issues[0].factClaims[1]", reason: "fact_mismatch" },
      { path: "review.issues[0].factClaims[2].expectedJson", reason: "invalid_value" },
      { path: "review.acceptanceScopeChecks[0].criterionQuote", reason: "reference_quote_mismatch" },
    ]);
    assert.equal(error.validationIssueTotal, 8); assert.equal(error.validationIssuesTruncated, false);
    assert.equal(JSON.stringify(Object.assign({ message: error.message }, error)).includes("PRIVATE_"), false);
    assert.ok(recordArray(error.validationIssues).every((entry) => entry.remedy));
    return true;
  });
  assert.deepEqual(review, snapshot, "诊断不修改提交内容或伪造有效引用");
});

test("大量错误只保留64条但报告完整计数，超出部分仍阻止通过", () => {
  const { review, issue, options } = fixture();
  review.verdict = "revise"; review.checks.find((entry) => entry.id === "interfaces")!.passed = false;
  review.issues = Array.from({ length: 8 }, (_, index) => ({ ...structuredClone(issue), id: `reference_${index}`,
    references: Array.from({ length: 12 }, (_, position) => ({ source: "candidate",
      path: `/PRIVATE_${index}_${position}`, quote: "PRIVATE_QUOTE" })) }));
  assert.throws(() => validateReview(review, options), (error) => {
    assert.ok(error instanceof InputError); assert.equal(objectFields(error.validationIssues).length, 64);
    assert.equal(error.validationIssueTotal, 96); assert.equal(error.validationIssuesTruncated, true);
    assert.equal(recordArray(error.validationIssues)[63]!.path, "review.issues[5].references[3]");
    assert.equal(JSON.stringify(Object.assign({ message: error.message }, error)).includes("PRIVATE_"), false);
    return true;
  });
});

test("拒绝错误评审后在同一独立会话纠正，不创建新的角色或重置轮次", async () => {
  const root = await mkdtemp(join(tmpdir(), "neuma-review-evidence-"));
  const { review, issue, options } = fixture();
  review.verdict = "revise"; review.issues = [issue];
  let sessions = 0, disposals = 0;
  const designer = new ArchitectureDesigner({ config: {}, cwd: root, dataDir: root, sessionFactory: async ({ customTools }) => {
    sessions++;
    const submit = fixtureTools(customTools).submit_architecture_review;
    return { abort: async () => assert.fail("该会话不应取消"), subscribe: () => () => {}, prompt: async () => {
      await assert.rejects(submit!.execute("bad", review), (error) => failureFields(error).validationIssue?.reason === "contradictory_review");
      const corrected = structuredClone(review); corrected.checks.find((entry) => entry.id === "interfaces")!.passed = false;
      await submit!.execute("fixed", corrected);
    }, dispose: () => { disposals++; } };
  } });
  try {
    const result = await designer.role({ role: "reviewer", systemPrompt: "test", payload: {}, submitName: "submit_architecture_review",
      parameters: reviewSubmissionSchema({ evidenceRequired: true }), validate: (value) => validateReview(value, options), onProgress: () => {} });
    assert.ok(!("needsInput" in result));
    assert.equal(result.checks.find((entry) => entry.id === "interfaces")!.passed, false);
    assert.equal(result.issues.length, 1); assert.equal(sessions, 1); assert.equal(disposals, 1);
    assert.equal(architectureReviewIssues([], result).length, 1, "同源失败检查不再复制成额外义务");
  } finally { await rm(root, { recursive: true, force: true }); }
});
