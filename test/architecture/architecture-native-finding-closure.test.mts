import { fixtureText } from "../helpers/m7-test-boundaries.mjs";
import { callFixture } from "../helpers/m7-test-boundaries.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import type { TestFailure } from "../helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { architecturePriorFindings, validateArchitecturePriorFindings } from "../../src/architecture/architecture-prior-findings.mjs";
import { architectureReviewEvidenceContext } from "../../src/architecture/architecture-review-evidence.mjs";
import { designHash, validateReview } from "../../src/architecture/architecture-contract.mjs";
import { ACCEPTANCE_ADAPTERS, ACCEPTANCE_ADAPTER_GUIDE } from "../../src/verification/acceptance-contract.mjs";
import { passingReview, validDesign } from "../helpers/architecture.mjs";
import type { AcceptanceStage } from "../../src/contracts/verification.mjs";

interface FixtureOptions { change?: (...args: never[]) => unknown; sourceChange?: (...args: never[]) => unknown; contextChange?: (...args: never[]) => unknown; referenceChange?: (...args: never[]) => unknown; previous?: unknown }
function fixture({ change, sourceChange, contextChange, referenceChange, previous = null }: FixtureOptions = {}) {
  const requirements = [
    { id: "inputSource", text: "整理用户提供的记录" },
    { id: "externalAction", text: "不执行未经授权的外部动作" },
    { id: "deliverable", text: "生成中文周报" },
  ];
  const original = validDesign(requirements, { schemaVersion: 3 });
  const runtimeCapabilities = { version: 1, hash: "1".repeat(64), capabilities: [] };
  const guide = structuredClone(ACCEPTANCE_ADAPTER_GUIDE);
  const sourceContext = architectureReviewEvidenceContext({ design: original, requirements, runtimeCapabilities, acceptanceAdapterGuide: guide });
  const candidateHash = designHash(original), platformHash = "2".repeat(64);
  const snapshotBody = { version: 1, candidateHash, platformHash, acceptanceAdapterGuide: structuredClone(guide),
    contextManifest: structuredClone(sourceContext.contextManifest) };
  const snapshot = { ...snapshotBody, hash: designHash(snapshotBody) };
  const architecture = { agentId: "synthetic_agent", version: 7, status: "passed", sourceFingerprint: "synthetic_source",
    requirements, design: original, candidateHash, platformHash, runtimeCapabilities,
    confirmedRequirementContext: null, deferredVerifications: null, evidence: [],
    review: passingReview(candidateHash, original), reviewContext: { candidateHash, platformHash },
    reviewEvidence: { version: 2, runtimeCapabilityHash: runtimeCapabilities.hash, snapshot, snapshotHash: snapshot.hash } };
  const source = { agentId: architecture.agentId, runId: "synthetic_failed_planning", runVersion: 1, runRevision: 1,
    architectureRef: { version: architecture.version, candidateHash }, recordHash: "3".repeat(64),
    sourceFingerprint: architecture.sourceFingerprint, requirementHash: designHash(requirements), platformHash,
    runtimeCapabilityHash: designHash(runtimeCapabilities), confirmedContextHash: designHash(null), deferredContextHash: designHash(null) };
  const failureSource = { ...structuredClone(source), bindingHash: "4".repeat(64), sessionHash: "5".repeat(64), leafId: "synthetic_leaf" };
  const diagnostic = { path: "planningFiles.cases[0].kind", reason: "input_rejection_not_rejected",
    remedy: "合成旧用例的448字节未超过131072字节入口限制，不能证明输入拒绝。",
    source: { path: "synthetic-cases.json", localIndex: 0, caseId: "synthetic_case" },
    proposedCaseRef: { id: "synthetic_case", acceptanceId: "valid", kind: "input-rejection", inputTarget: "task-envelope" } };
  const reference = { schemaVersion: 1, trust: "untrusted-reference", status: "available", source, plan: null,
    planningToolFailures: { schemaVersion: 1, trust: "untrusted-reference", current: false, status: "available", source: failureSource,
      omittedFailures: 0, failures: [{ entryId: "synthetic_failure", toolCallId: "synthetic_save", toolName: "save_plan_cases",
        path: "synthetic-cases.json", reason: "planning_case_invalid", saved: false, issues: [diagnostic] }] } };
  const candidate = structuredClone(original);
  if (change) callFixture(change, undefined, [candidate, guide]);
  const evidenceContext = architectureReviewEvidenceContext({ design: candidate, requirements, runtimeCapabilities, acceptanceAdapterGuide: guide });
  const current = { candidateHash: designHash(candidate), guideHash: evidenceContext.contextManifest!.acceptanceAdapterGuide!.sha256,
    contextManifestHash: designHash(evidenceContext.contextManifest) };
  if (sourceChange) callFixture(sourceChange, undefined, [architecture, reference]);
  if (contextChange) callFixture(contextChange, undefined, [evidenceContext]);
  if (referenceChange) callFixture(referenceChange, undefined, [reference]);
  const prior = architecturePriorFindings(previous, current, { developmentRevision: reference, candidate,
    developmentArchitecture: architecture, evidenceContext });
  const review = passingReview(current.candidateHash, candidate, prior!);
  for (const row of review.acceptanceScopeChecks!) { assert.ok("adapterId" in row); row.adapterQuote = fixtureText(objectFields(objectFields(guide.adapters)[row.adapterId]).proves); }
  const finding = prior!.findings!.find((entry): entry is Extract<typeof entry, { diagnostic: unknown }> => entry.kind === "historical-planning-diagnostic");
  const row = review.priorFindingDecisions!.find((entry) => entry.findingId === finding!.findingId!);
  row!.candidatePaths! = [finding!.currentAcceptance!.path ?? "/acceptance/0"];
  const validate = (value = review) => validateArchitecturePriorFindings(validateReview(value,
    { candidateHash: current.candidateHash, schemaVersion: 3, evidenceContext }), prior, candidate);
  return { architecture, reference, candidate, guide, evidenceContext, current, prior, finding, review, row, validate };
}

function unsupported(f: ReturnType<typeof fixture>) {
  f.row!.status = "unsupported";
  f.row!.reason = "旧负例使用合法任务输入，本轮逐字核对当前验收及实际适配器；历史拒绝仍保留。";
  const path = f.finding!.currentAcceptance.path ?? "/acceptance/0";
  const criterion = f.candidate.acceptance[Number(path.split("/")[2])], adapterId = criterion!.verification!.adapterId;
  f.row!.candidatePaths = [path];
  const issue = { id: f.finding!.findingId, blocking: false, kind: "design", checkId: f.row!.checkIds[0]!,
    description: "旧用例的输入未触发入口拒绝，不足以证明当前验收错误。", remedy: "保留历史诊断，重新规划符合本条验收的冻结用例。",
    candidatePaths: [path], references: [
      { source: "candidate", path: `${path}/expected`, quote: criterion!.expected },
      { source: "acceptanceAdapterGuide", path: `/adapters/${adapterId}/executionRule`, quote: f.guide.adapters[adapterId].executionRule },
    ], factClaims: [{ source: "contextManifest", path: "/acceptanceAdapterGuide/sha256",
      expectedJson: JSON.stringify(f.evidenceContext.contextManifest.acceptanceAdapterGuide!.sha256) }] };
  f.review.issues.push(issue);
  return issue;
}

function reason(f: ReturnType<typeof fixture>, expected: string, label?: string) {
  assert.throws(() => f.validate(), (error: TestFailure) => {
    assert.equal(error.validationIssue?.reason, expected, label!);
    return true;
  }, label!);
}

test("可信冻结来源下旧坏用例可凭当前反证判unsupported，诊断与评审材料均保留", () => {
  const f = fixture(), before = structuredClone({ architecture: f.architecture, reference: f.reference, prior: f.prior });
  assert.equal(f.finding!.resolutionBasis.status, "available");
  assert.equal(f.finding!.resolutionBasis.changed, false);
  assert.equal(f.finding!.issue.blocking, false);
  assert.equal(f.prior!.historicalOnly, true);
  unsupported(f);
  const reviewBefore = structuredClone(f.review), result = f.validate();
  assert.deepEqual(result, reviewBefore);
  assert.equal(result.verdict, "pass");
  assert.match(f.finding!.diagnostic.remedy, /448.*131072/u);
  assert.deepEqual({ architecture: f.architecture, reference: f.reference, prior: f.prior }, before);
  assert.deepEqual(f.review, reviewBefore);
});

test("原生闭合决议重启后按相同冻结context纯重验，不依赖旧对象身份或修改摘要", () => {
  for (const status of ["unsupported", "resolved"]) {
    const f = fixture(status === "resolved" ? { change: (candidate: ReturnType<typeof validDesign>) => { candidate.acceptance![0]!.expected += " 保留本轮真实边界。"; } } : {});
    if (status === "unsupported") unsupported(f);
    else f.row!.status = "resolved";
    const prior = structuredClone(f.prior), before = designHash({ prior, review: f.review, context: f.evidenceContext, candidate: f.candidate });
    assert.throws(() => callFixture(validateArchitecturePriorFindings, undefined, [f.review, prior, f.candidate]),
      (error: TestFailure) => ["native_counterevidence_missing", "native_basis_unavailable"].includes(error.validationIssue!.reason));
    assert.deepEqual(callFixture(validateArchitecturePriorFindings, undefined, [f.review, prior, f.candidate, { evidenceContext: f.evidenceContext }]), f.review);
    assert.equal(designHash({ prior, review: f.review, context: f.evidenceContext, candidate: f.candidate }), before);
  }
});

test("显式坏context即使存在有效live绑定也拒绝，不回退WeakMap或补造通过", () => {
  const f = fixture(); unsupported(f);
  for (const change of [(context: { contextManifest: { acceptanceAdapterGuide: { sha256: string; }; }; }) => { context.contextManifest!.acceptanceAdapterGuide!.sha256 = "e".repeat(64); },
(    context: { candidate: { instructions: string; }; }) => { context.candidate.instructions += "changed"; }, (context: { requirements: { text: string; }[]; }) => { context.requirements[0]!.text += "changed"; },
(    context: { runtimeCapabilities: { version: number; }; }) => { context.runtimeCapabilities.version++; }, (context: { acceptanceAdapterGuide: { adapters: { action: { proves: string; }; }; }; }) => { context.acceptanceAdapterGuide.adapters.action.proves += "changed"; }]) {
    const context = structuredClone(f.evidenceContext); callFixture(change, undefined, [context]);
    assert.throws(() => callFixture(validateArchitecturePriorFindings, undefined, [f.review, f.prior, f.candidate, { evidenceContext: context }]),
      (error: TestFailure) => error.validationIssue!.reason === "context_mismatch");
  }
  for (const evidenceContext of [null, undefined, false, {}])
    assert.throws(() => callFixture(validateArchitecturePriorFindings, undefined, [f.review, f.prior, f.candidate, { evidenceContext }]),
      (error: TestFailure) => error.validationIssue!.reason === "context_mismatch");
  assert.doesNotThrow(f.validate, "没有显式context的旧live调用仍按原绑定校验");
});

test("恢复context不放宽原生反证或真实修复门槛", () => {
  const unchanged = fixture(); unchanged.row!.status = "resolved";
  assert.throws(() => callFixture(validateArchitecturePriorFindings, undefined, [unchanged.review, structuredClone(unchanged.prior), unchanged.candidate, { evidenceContext: unchanged.evidenceContext }]), (error: TestFailure) => error.validationIssue!.reason === "native_basis_unchanged");
  const f = fixture(), issue = unsupported(f); issue.references![0]!.quote = "不属于所选来源的引文";
  assert.throws(() => callFixture(validateArchitecturePriorFindings, undefined, [f.review, structuredClone(f.prior), f.candidate, { evidenceContext: f.evidenceContext }]), (error: TestFailure) => error.validationIssue!.reason === "reference_quote_mismatch");
});

test("unsupported不能凭一句reason、别名问题或不同检查项空口关闭原生诊断", () => {
  for (const [label, mutate] of [
    ["没有问题", (f: ReturnType<typeof fixture>) => { f.row!.status = "unsupported"; }],
    ["问题编号不同", (f: ReturnType<typeof fixture>) => { unsupported(f).id = "unrelated_explanation"; }],
    ["检查项不同", (f: ReturnType<typeof fixture>) => { unsupported(f).checkId = "requirements"; }],
  ] as const) {
    const f = fixture(); callFixture(mutate, undefined, [f]);
    reason(f, "native_counterevidence_missing", label);
  }
});

test("unsupported要求本验收正文和本实际适配器事实，无关真实引用不能代替", () => {
  for (const [label, mutate] of [
    ["决议指向另一验收", (f: ReturnType<typeof fixture>) => { unsupported(f); f.row!.candidatePaths = ["/acceptance/1"]; }],
    ["解释指向另一验收", (f: ReturnType<typeof fixture>) => { unsupported(f).candidatePaths = ["/acceptance/1"]; }],
    ["正文来自另一验收", (f: ReturnType<typeof fixture>) => { unsupported(f).references[0] = { source: "candidate", path: "/acceptance/1/expected", quote: f.candidate.acceptance[1]!.expected }; }],
    ["只引验收编号", (f: ReturnType<typeof fixture>) => { unsupported(f).references[0] = { source: "candidate", path: "/acceptance/0/id", quote: "valid" }; }],
    ["只引需求编号", (f: ReturnType<typeof fixture>) => { unsupported(f).references[0] = { source: "candidate", path: "/acceptance/0/requirementIds/0", quote: "inputSource" }; }],
    ["根对象仅摘录验收编号", (f: ReturnType<typeof fixture>) => { unsupported(f).references[0] = { source: "candidate", path: "/acceptance/0", quote: "valid" }; }],
    ["根对象仅摘录需求编号", (f: ReturnType<typeof fixture>) => { unsupported(f).references[0] = { source: "candidate", path: "/acceptance/0", quote: "inputSource" }; }],
    ["仅摘录verification标识", (f: ReturnType<typeof fixture>) => { unsupported(f).references[0] = { source: "candidate", path: "/acceptance/0/verification/adapterId", quote: "action" }; }],
    ["适配器并未采用", (f: ReturnType<typeof fixture>) => { unsupported(f).references[1] = { source: "acceptanceAdapterGuide", path: "/adapters/host-runtime/proves", quote: f.guide.adapters["host-runtime"]!.proves }; }],
    ["只引适配器标识", (f: ReturnType<typeof fixture>) => { unsupported(f).references[1] = { source: "acceptanceAdapterGuide", path: "/adapters/action/owner", quote: "generated-code" }; }],
  ] as const) {
    const f = fixture(); callFixture(mutate, undefined, [f]);
    reason(f, "native_counterevidence_unrelated", label!);
  }
});

test("unsupported复用正式逐字引用与typed fact校验，不匹配的原文和guide摘要均拒绝", () => {
  for (const [expected, mutate] of [
    ["reference_quote_mismatch", (issue: { references: { quote: string; }[]; }) => { issue.references![0]!.quote = "当前验收中不存在的逐字依据"; }],
    ["reference_quote_mismatch", (issue: { references: { quote: string; }[]; }) => { issue.references![1]!.quote = "当前适配器中不存在的逐字依据"; }],
    ["fact_mismatch", (issue: { factClaims: { expectedJson: string; }[]; }) => { issue.factClaims![0]!.expectedJson = JSON.stringify("0".repeat(64)); }],
  ] as const) {
    const f = fixture(); callFixture(mutate, undefined, [unsupported(f)]); reason(f, expected);
  }
  const f = fixture(); unsupported(f).factClaims = [];
  assert.doesNotThrow(() => f.validate(), "普通设计解释不新增强制typed fact字段");
  for (const field of ["input", "expected"]) {
    const current = fixture(), issue = unsupported(current);
    issue.references[0] = { source: "candidate", path: "/acceptance/0", quote: fixtureText(current.candidate!.acceptance[0]![field]) };
    assert.doesNotThrow(() => current.validate(), `根对象引用真实${field}正文`);
  }
});

test("原生诊断不能把无关说明、验收改名换序、需求换序或其他适配器变化当修复", () => {
  for (const [label, change] of [
    ["未修改", () => {}],
    ["仅改instructions", (candidate: { instructions: string; }) => { candidate.instructions += " 调整说明格式。"; }],
    ["仅改名", (candidate: { acceptance: { id: string; }[]; }) => { candidate.acceptance![0]!.id = "renamed"; }],
    ["仅换序", (candidate: { acceptance: unknown[]; }) => { candidate.acceptance.reverse(); }],
    ["仅需求编号换序", (candidate: { acceptance: { requirementIds: unknown[]; }[]; }) => { candidate.acceptance[0]!.requirementIds.reverse(); }],
    ["仅其他适配器", (_: unknown, guide: { adapters: { [x: string]: { executionRule: string; }; }; }) => { guide.adapters["host-runtime"]!.executionRule += " 合成无关变化。"; }],
  ] as const) {
    const f = fixture({ change });
    assert.equal(f.finding!.resolutionBasis.status, "available", label!);
    assert.equal(f.finding!.resolutionBasis.changed, false, label!);
    f.row!.status = "resolved";
    reason(f, "native_basis_unchanged", label!);
  }
});

test("关联input、expected、verification及本适配器事实真实变化允许声明resolved但不改评审", () => {
  for (const [label, change] of [
    ["input", (candidate: { acceptance: { input: string; }[]; }) => { candidate.acceptance![0]!.input += " 并明确未完成事项。"; }],
    ["expected", (candidate: { acceptance: { expected: string; }[]; }) => { candidate.acceptance![0]!.expected += " 单独列出尚未完成事项。"; }],
    ["kind", (candidate: { acceptance: { kind: string; }[]; }) => { candidate.acceptance![0]!.kind = "boundary"; }],
    ["requirementIds", (candidate: { acceptance: { requirementIds: string[]; }[]; }) => { candidate.acceptance![0]!.requirementIds = ["inputSource"]; }],
    ["verification", (candidate: { acceptance: { verification: { stage: AcceptanceStage; owner: "conversation"|"generated-code"|"platform"; adapterId: string; }; }[]; }) => {
      const { stage, owner } = ACCEPTANCE_ADAPTERS["input-contract"];
      candidate.acceptance![0]!.verification = { stage, owner, adapterId: "input-contract" };
    }],
    ["本适配器规则", (_: unknown, guide: { adapters: { action: { executionRule: string; }; }; }) => { guide.adapters.action.executionRule += " 合成规则变化。"; }],
    ["本适配器执行事实", (_: unknown, guide: { adapters: { action: { executionFacts: { strictMockConsumption: boolean; }; }; }; }) => { guide.adapters.action.executionFacts.strictMockConsumption = false; }],
    ["本适配器准入", (_: unknown, guide: { admission: { action: { rule: string; }; }; }) => { guide.admission.action = { rule: "合成的当前准入规则。" }; }],
    ["适用组合规则", (_: unknown, guide: { composition: { caseSetRule: string; }; }) => { guide.composition.caseSetRule += " 合成组合变化。"; }],
  ] as const) {
    const f = fixture({ change });
    assert.equal(f.finding!.resolutionBasis.status, "available", label!);
    assert.equal(f.finding!.resolutionBasis.changed, true, label!);
    f.row!.status = "resolved";
    const before = structuredClone(f.review), sourceBefore = structuredClone(f.architecture);
    assert.deepEqual(f.validate(), before, label!);
    assert.deepEqual(f.review, before, label!);
    assert.deepEqual(f.architecture, sourceBefore, label!);
  }
});

test("来源架构及完整摘要或冻结快照绑定被篡改时resolved一律缺少可信basis", () => {
  for (const [label, sourceChange] of [
    ["来源未通过", (architecture: { status: string; }) => { architecture.status = "failed"; }],
    ["来源评审未通过", (architecture: { review: { verdict: string; }; }) => { architecture.review.verdict = "revise"; }],
    ["来源评审指另一候选", (architecture: { review: { candidateHash: string; }; }) => { architecture.review.candidateHash = "0".repeat(64); }],
    ["评审context候选", (architecture: { reviewContext: { candidateHash: string; }; }) => { architecture.reviewContext.candidateHash = "0".repeat(64); }],
    ["评审context平台", (architecture: { reviewContext: { platformHash: string; }; }) => { architecture.reviewContext.platformHash = "0".repeat(64); }],
    ["agent", (architecture: { agentId: string; }) => { architecture.agentId = "other_agent"; }],
    ["version", (architecture: { version: number; }) => { architecture.version++; }],
    ["design", (architecture: { design: { instructions: string; }; }) => { architecture.design.instructions += " 篡改来源。"; }],
    ["candidateHash", (architecture: { candidateHash: string; }) => { architecture.candidateHash = "0".repeat(64); }],
    ["sourceFingerprint", (_: unknown, reference: { source: { sourceFingerprint: string; }; }) => { reference.source.sourceFingerprint = "other_source"; }],
    ["requirements", (_: unknown, reference: { source: { requirementHash: string; }; }) => { reference.source.requirementHash = "0".repeat(64); }],
    ["platform", (_: unknown, reference: { source: { platformHash: string; }; }) => { reference.source.platformHash = "0".repeat(64); }],
    ["runtime", (_: unknown, reference: { source: { runtimeCapabilityHash: string; }; }) => { reference.source.runtimeCapabilityHash = "0".repeat(64); }],
    ["confirmed", (_: unknown, reference: { source: { confirmedContextHash: string; }; }) => { reference.source.confirmedContextHash = "0".repeat(64); }],
    ["deferred", (_: unknown, reference: { source: { deferredContextHash: string; }; }) => { reference.source.deferredContextHash = "0".repeat(64); }],
    ["snapshotHash", (architecture: { reviewEvidence: { snapshotHash: string; }; }) => { architecture.reviewEvidence.snapshotHash = "0".repeat(64); }],
    ["snapshot内容", (architecture: { reviewEvidence: { snapshot: { acceptanceAdapterGuide: { adapters: { action: { executionRule: string; }; }; }; }; }; }) => { architecture.reviewEvidence.snapshot.acceptanceAdapterGuide.adapters.action.executionRule += " 篡改。"; }],
    ["旧格式快照", (architecture: { reviewEvidence: { version: number; }; }) => { architecture.reviewEvidence.version = 1; }],
    ["缺少快照", (architecture: { reviewEvidence: { snapshot: unknown; }; }) => { Reflect.deleteProperty(architecture.reviewEvidence, "snapshot"); }],
  ] as const) {
    const f = fixture({ sourceChange, change: (candidate: ReturnType<typeof validDesign>) => { candidate.acceptance![0]!.expected += " 当前真实修改。"; } });
    assert.equal(f.finding!.resolutionBasis.status, "unavailable", label!);
    f.row!.status = "resolved";
    reason(f, "native_basis_unavailable", label!);
  }
});

test("缺失旧验收仍保留诊断且只能用当前替代验收反证，缺少当前可信context不能关闭", () => {
  const f = fixture({ change: (candidate: ReturnType<typeof validDesign>) => { candidate.acceptance.shift(); } });
  assert.equal(f.finding!.currentAcceptance.path, null);
  assert.equal(f.finding!.resolutionBasis.status, "available");
  assert.equal(f.finding!.resolutionBasis.changed, false);
  unsupported(f);
  assert.doesNotThrow(() => f.validate());
  const broken = fixture({ contextChange: (context: ReturnType<typeof architectureReviewEvidenceContext>) => { context.contextManifest!.acceptanceAdapterGuide!.sha256 = "0".repeat(64); } });
  broken.row!.status = "resolved";
  assert.equal(broken.finding!.resolutionBasis.status, "unavailable");
  reason(broken, "native_basis_unavailable");
  const altered = fixture({ change: (candidate: ReturnType<typeof validDesign>) => { candidate.acceptance![0]!.input += " 当前修改。"; } });
  objectFields(objectFields(altered.prior!.findings[0]).resolutionBasis).changed = false;
  altered.row!.status = "resolved";
  reason(altered, "native_basis_unavailable", "投影生成后被改不能复用私有上下文");
});

test("原生finding只读取公开诊断和可信架构，不读取历史plan/input/mocks/thinking正文", () => {
  let reads = 0;
  const forbidden = { enumerable: true, get() { reads++; throw new Error("forbidden historical body"); } };
  const f = fixture({ referenceChange: (reference: { planningToolFailures: { failures: { issues: unknown[] }[] } }) => {
    for (const key of ["plan", "input", "mocks", "thinking"]) Object.defineProperty(reference, key, forbidden);
    const failure = reference.planningToolFailures.failures[0];
    for (const target of [failure, objectFields(objectFields(failure).issues)[0]]) for (const key of ["input", "mocks", "thinking"])
      Object.defineProperty(target, key, { ...forbidden, enumerable: false });
  } });
  assert.equal(f.finding!.resolutionBasis.status, "available");
  unsupported(f);
  assert.doesNotThrow(() => f.validate());
  assert.equal(reads, 0);
});

test("旧普通review历史问题维持原有决议边界，不被原生反证门槛影响", () => {
  const original = validDesign([], { schemaVersion: 3 });
  const previous = { version: 4, candidateHash: designHash(original), review: { issues: [
    { id: "ordinary_failure", checkId: "verification", blocking: true, description: "普通旧评审意见", remedy: "核对当前处理", candidatePaths: ["/instructions"] },
  ] } };
  const candidate = structuredClone(original); candidate.instructions += " 当前已经澄清处理方式。";
  const evidenceContext = architectureReviewEvidenceContext({ design: candidate, requirements: [], runtimeCapabilities: null });
  const current = { candidateHash: designHash(candidate), guideHash: evidenceContext.contextManifest!.acceptanceAdapterGuide!.sha256,
    contextManifestHash: designHash(evidenceContext.contextManifest) };
  const prior = architecturePriorFindings(previous, current, { candidate, evidenceContext });
  assert.equal(prior!.findings![0]!.kind, "historical-review-opinion");
  for (const status of ["resolved", "unsupported"]) {
    const review = passingReview(current.candidateHash, candidate, prior!);
    review.priorFindingDecisions![0]!.status = status;
    assert.doesNotThrow(() => validateArchitecturePriorFindings(validateReview(review,
      { candidateHash: current.candidateHash, schemaVersion: 3, evidenceContext }), prior, candidate));
  }
});
