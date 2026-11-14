import {fixtureNumber} from "../helpers/m7-test-boundaries.mjs";
interface ReaderFeedback {results:ReaderWire[];hostModelBudget:{limit:number;used:number;remaining:number};reviewReadProgress:unknown}
import type {RequirementItem} from "../../src/contracts/architecture.mjs";
interface ModelPayload extends Record<string,unknown> {requirements:RequirementItem[];design:ReturnType<typeof validDesign>;candidateHash:string;reviewEvidenceIndex:ReturnType<typeof createArchitectureEvidenceReader>["index"];modelBudget:{limit:number;used:number;remaining:number};priorFindings:NonNullable<Parameters<typeof passingReview>[2]>}
import {fixturePort,fixtureString,type FixtureChatRequest} from "../helpers/http-model.mjs";
import {recordArray,callFixture} from "../helpers/m7-test-boundaries.mjs";
import type {ToolSchema} from "../../src/contracts/tools.mjs";
interface ReaderWire {found?:boolean;reference?:{quote:string;source:string;path:string};receiptId?:string;scopeReceiptId?:string;quoteHash?:string;contextHash?:string;candidateHash?:string;nextOffset?:number|null;total?:number;offset?:number;reason?:string;availablePaths?:string[];results?:ReaderWire[];quoteBytes?:number;[key:string]:unknown}
import { fixtureChatRequest } from "../helpers/http-model.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import { failureFields } from "../helpers/failure-fields.mjs";
import { toolText } from "../helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { Ajv } from "ajv";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArchitectureEvidenceReader } from "../../src/architecture/architecture-evidence-reader.mjs";
import { ArchitectureDesigner } from "../../src/architecture/architecture.mjs";
import { reviewSubmissionSchema, validateReview, requirementItems, designHash, designSubmissionSchema } from "../../src/architecture/architecture-contract.mjs";
import { architectureReviewEvidenceContext } from "../../src/architecture/architecture-review-evidence.mjs";
import { fixtureMaterialSources } from "../helpers/model-context.mjs";
import { createPiSession } from "../../src/runtime/pi-runtime.mjs";
import { ACCEPTANCE_ADAPTERS } from "../../src/verification/acceptance-contract.mjs";
import { validDesign, validDraft, passingReview } from "../helpers/architecture.mjs";
import type { ArchitectureReview,ArchitectureBase } from "../../src/contracts/architecture.mjs";
import type { ToolResult } from "../../src/contracts/tools.mjs";
import type { SessionMessage } from "../../src/runtime/execution-port.mjs";
import type { CandidateDraft } from "../../src/contracts/architecture-stages.mjs";

const result=(value:ToolResult):ReaderWire=>{const data:unknown=JSON.parse(toolText(value));assert.ok(data&&typeof data==="object");return data as ReaderWire;};
const reader = (overrides = {}) => createArchitectureEvidenceReader({ context: { candidate: { instructions: "A😀BC", hidden: { PRIVATE_PATH: "private" } },
  requirements: [{ id: "goal", text: "完成任务" }], runtimeCapabilities: { hash: "fixed" } }, candidateHash: "a".repeat(64), ...overrides });

function scopeFixture() {
  const draft = validDraft(), requirements = requirementItems(draft), candidate = validDesign(requirements, { schemaVersion: 3 });
  const candidateHash = designHash(candidate), context = architectureReviewEvidenceContext({ design: candidate, requirements,
    runtimeCapabilities: { hash: "fixed", version: 1 } });
  return { draft, requirements, candidate, candidateHash, context,
    current: createArchitectureEvidenceReader({ context, candidateHash, candidateSchema: designSubmissionSchema(draft, { requirements }) }) };
}

test("资料位置附带一致摘录时整理为位置，错误摘录、错适配器及版本仍逐项拒绝", () => {
  const f = scopeFixture(), official = reviewSubmissionSchema({ evidenceRequired: true });
  const review = passingReview(f.candidateHash, f.candidate);
  const mixed = { ...review, acceptanceScopeChecks: review.acceptanceScopeChecks!.map(row => ({ ...row,
    adapterRulePath: `/adapters/${objectFields(row).adapterId}/proves` })) };
  const valid = new Ajv({ strict: false }).compile(f.current.submissionSchema(official));
  assert.equal(new Ajv({ strict: false }).compile(f.current.submissionSchema(official, { strictLocations: true }))(mixed), false);
  assert.equal(valid(mixed), true);
  const before = structuredClone(mixed), resolved = f.current.resolveSubmission(mixed);
  assert.deepEqual(mixed, before);
  assert.ok(resolved.acceptanceScopeChecks.every(row => row.adapterRulePath && !Object.hasOwn(row, "criterionQuote") && !Object.hasOwn(row, "adapterQuote")));
  assert.doesNotThrow(() => validateReview(resolved, { candidateHash: f.candidateHash, schemaVersion: 3, evidenceContext: f.context }));
  for (const field of ["criterionQuote", "adapterQuote"] as const) {
    const wrong = structuredClone(mixed); Object.assign(wrong.acceptanceScopeChecks[0]!, { [field]: "不属于该位置的原文" });
    assert.throws(() => f.current.resolveSubmission(wrong), error => {
      const issue = objectFields(objectFields(error).validationIssue);
      assert.equal(issue.path, `review.acceptanceScopeChecks[0].${field}`); assert.equal(issue.reason, "reference_quote_mismatch"); return true;
    });
  }
  const wrongRule = structuredClone(mixed); wrongRule.acceptanceScopeChecks[0]!.adapterRulePath = "/missing";
  assert.throws(() => f.current.resolveSubmission(wrongRule), error => failureFields(error).validationIssue?.reason === "scope_rule_invalid");
  assert.throws(() => f.current.resolveSubmission({ ...mixed, candidateHash: "b".repeat(64) }), error => failureFields(error).validationIssue?.reason === "candidate_mismatch");
  const withReference = { candidateHash: f.candidateHash, issues: [{ references: [{ file: "candidate.json", path: "/instructions", quote: f.candidate.instructions }] }] };
  assert.deepEqual(f.current.resolveSubmission(withReference).issues[0]!.references, [{ source: "candidate", path: "/instructions" }]);
  withReference.issues[0]!.references[0]!.quote = "错误摘录";
  assert.throws(() => f.current.resolveSubmission(withReference), error => failureFields(error).validationIssue?.path === "review.issues[0].references[0].quote");
});

test("历史关闭缺项按合并草稿的问题编号提供原文，输入换序不误指其他说明", () => {
  const f = scopeFixture(), issueId = "finding_missing_evidence";
  const canonical = { issues: [{ id: "other", references: [] }, { id: issueId, references: [] }] };
  const raw = { issues: canonical.issues.slice().reverse() }, before = structuredClone({ canonical, raw });
  const diagnostics = [1, 2].map(index => ({ path: "review.issues[1].references",
    reason: "repair_candidate_reference_unrelated", candidatePath: `/acceptance/${index}` }));
  const hints = f.current.referenceHints(raw, diagnostics, { canonicalSubmission: canonical });
  assert.equal(hints.length, 4);
  assert.ok(hints.every(hint => hint.issueId === issueId && hint.target === "merged-review-draft"));
  for (const index of [1, 2]) {
    const hint = hints.find(value => value.path === `/acceptance/${index}/expected`);
    assert.equal(hint!.quote, f.candidate.acceptance[index]!.expected);
    const resolved = f.current.resolveSubmission({ candidateHash: f.candidateHash, issues: [{ references: [hint!.reference] }] });
    assert.equal(resolved.issues[0]!.references[0]!.quote, hint!.quote);
    assert.throws(() => createArchitectureEvidenceReader({ context: f.context, candidateHash: f.candidateHash })
      .resolveSubmission({ candidateHash: f.candidateHash, issues: [{ references: [hint!.reference] }] }), /引用回执未知/u);
  }
  assert.deepEqual({ canonical, raw }, before, "建议不能自动改写问题或添加通过结论");
  assert.deepEqual(f.current.referenceHints(raw, [{ ...diagnostics[0], findingId: "unknown" }], { canonicalSubmission: canonical }), []);
  assert.equal(f.current.referenceHints(raw, [...diagnostics, ...diagnostics], { canonicalSubmission: canonical }).length, 4);
});

test("长文件和整段位置可提交且不复制正文，不存在的位置仍拒绝", () => {
  const candidateHash = "a".repeat(64), components = [{ purpose: "A".repeat(2305) }];
  const context = architectureReviewEvidenceContext({ design: { components }, requirements: [], runtimeCapabilities: {} });
  const current = reader({ candidateHash, context });
  const submission = { candidateHash, issues: [{ references: [{ file: "candidate.json", path: "/components" }, { file: "candidate.json", path: "" }] }] };
  const before = structuredClone(submission), resolved = current.resolveSubmission(submission);
  assert.deepEqual(resolved.issues[0]!.references, [{ source: "candidate", path: "/components" }, { source: "candidate", path: "" }]);
  assert.deepEqual(submission, before);
  for (const ref of [{ file: "candidate.json", path: "/missing" }, { file: "../candidate.json", path: "" }])
    assert.throws(() => current.resolveSubmission({ candidateHash, issues: [{ references: [ref] }] }));
});

test("原文选择与历史短引用由宿主填入，错候选、错清单、混填及截短长编号拒绝", () => {
  const f = scopeFixture(), findingId = `finding_${"a".repeat(32)}`;
  const priorFindings = { current: { candidateHash: f.candidateHash }, findings: [{ findingId, issue: { description: "原历史问题" } }] };
  const reader = createArchitectureEvidenceReader({ context: f.context, candidateHash: f.candidateHash, priorFindings });
  const official = reviewSubmissionSchema({ evidenceRequired: true, priorFindingsRequired: true }), before = structuredClone(official);
  const schema = reader.submissionSchema(official), valid = new Ajv({ strict: false }).compile(schema);
  const findingRef = reader.index.priorFindings![0]!.findingRef;
  assert.ok(findingRef.length < findingId.length);
  const review = passingReview(f.candidateHash, f.candidate);
  review.priorFindingDecisions = [{ findingRef, status: "unresolved", reason: "待实际修订", checkIds: ["verification"], candidatePaths: ["/instructions"] }];
  review.issues = [{ findingRef, blocking: true, checkId: "verification", kind: "design", description: "边界待明确", remedy: "完善原步骤",
    candidatePaths: ["/instructions"], references: [{ source: "candidate", path: "/instructions" }], factClaims: [] }];
  review.checks.find(row => row.id === "verification")!.passed = false; review.verdict = "revise";
  assert.equal(valid(review), true);
  const input = structuredClone(review), canonical = reader.resolveSubmission(review);
  assert.deepEqual(review, input); assert.deepEqual(official, before);
  assert.equal(canonical.issues[0]!.id, findingId); assert.equal(canonical.priorFindingDecisions![0]!.findingId, findingId);
  assert.deepEqual(canonical.issues[0]!.references![0], { source: "candidate", path: "/instructions" });
  assert.equal(Object.hasOwn(canonical.issues[0]!, "findingRef"), false);
  assert.equal(Object.hasOwn(canonical.priorFindingDecisions![0]!, "findingRef"), false);
  assert.equal(valid(canonical), true);
  assert.doesNotThrow(() => validateReview(canonical, { candidateHash: f.candidateHash, schemaVersion: 3, evidenceContext: f.context }));
  for (const field of ["id", "findingId"]) {
    const mixed = structuredClone(review), row = field === "id" ? mixed.issues[0] : mixed.priorFindingDecisions![0];
    Object.assign(row!,{[field]:findingId}); assert.equal(valid(mixed), false);
    assert.throws(() => reader.resolveSubmission(mixed), e => objectFields(objectFields(e).validationIssue).reason === "invalid_reference");
  }
  const truncated = structuredClone(canonical); truncated.priorFindingDecisions![0]!.findingId = findingId.slice(0, -4);
  assert.equal(valid(truncated), false);
  assert.throws(() => reader.resolveSubmission({ ...review, candidateHash: "b".repeat(64) }));
  const changed = structuredClone(priorFindings); changed.findings[0]!.issue.description = "来源已变化";
  assert.throws(() => createArchitectureEvidenceReader({ context: f.context, candidateHash: f.candidateHash, priorFindings: changed }).resolveSubmission(review));
  const staleQuote = structuredClone(canonical); staleQuote.issues[0]!.references![0]!.quote = "模型改写的原文";
  assert.equal(reader.resolveSubmission(staleQuote).issues[0]!.references![0]!.quote, "模型改写的原文");
  assert.throws(() => validateReview(reader.resolveSubmission(staleQuote), { candidateHash: f.candidateHash, schemaVersion: 3, evidenceContext: f.context }));
});

test("当前规则选择无需预读或回执即可还原原文，原完整覆盖及不足阻断继续校验", () => {
  const { current, candidate, candidateHash, context } = scopeFixture(), review = passingReview(candidateHash, candidate);
  review.acceptanceScopeChecks = candidate.acceptance.map(({ id }) => ({ acceptanceId: id, adapterRulePath: "/adapters/action/proves",
    sufficient: true, reason: "根据当前完整材料独立判断" }));
  const official = reviewSubmissionSchema({ evidenceRequired: true }), schema = current.submissionSchema(official);
  assert.ok(schema.properties!.acceptanceScopeChecks!.items!.anyOf![0]!.required!.includes("adapterRulePath"));
  assert.equal(new Ajv({ strict: false }).compile(schema)(review), true);
  const unchanged = structuredClone(review), normalized = current.resolveSubmission(review);
  assert.deepEqual(review, unchanged);
  assert.ok(normalized.acceptanceScopeChecks!.every(row => row.adapterRulePath === "/adapters/action/proves" && row.criterionQuote === undefined && row.adapterQuote === undefined));
  assert.doesNotThrow(() => validateReview(normalized, { candidateHash, schemaVersion: 3, evidenceContext: context }));
  review.acceptanceScopeChecks![0]!.sufficient = false;
  assert.throws(() => validateReview(current.resolveSubmission(review), { candidateHash, schemaVersion: 3, evidenceContext: context }),
    (error) => failureFields(error).validationIssues!.some((issue) => issue.reason === "missing_scope_issue"));
  review.acceptanceScopeChecks!.pop();
  assert.throws(() => validateReview(current.resolveSubmission(review), { candidateHash, schemaVersion: 3, evidenceContext: context }),
    (error) => failureFields(error).validationIssues!.some((issue) => issue.reason === "missing_coverage"));
});

test("规则选择只解释完整当前材料，拒绝越界、混合、旧候选和坏回执且错误不回显原值", () => {
  const { current, candidate, candidateHash, context } = scopeFixture();
  const review = passingReview(candidateHash, candidate), selector = { acceptanceId: candidate.acceptance[0]!.id,
    adapterRulePath: "/adapters/action/proves", sufficient: true, reason: "固定独立判断" };
  review.acceptanceScopeChecks![0] = selector;
  for (const change of [{ adapterRulePath: "/adapters/host-files/proves" }, { adapterRulePath: "/composition/hostBusinessRule" },
    { adapterRulePath: "/PRIVATE_FALSE_RULE" }, { acceptanceId: "PRIVATE_UNKNOWN_ID" }, { criterionQuote: "PRIVATE_FALSE_QUOTE" },
    { adapterQuote: "PRIVATE_FALSE_QUOTE" }, { adapterId: "host-files" }, { scopeReceiptId: `scope_${"0".repeat(64)}` }]) {
    const bad = structuredClone(review); Object.assign(bad.acceptanceScopeChecks![0]!, change);
    assert.throws(() => current.resolveSubmission(bad), (error) => {
      assert.doesNotMatch(failureFields(error).message!, /PRIVATE|scope_0{64}/u);
      if ("criterionQuote" in change || "adapterQuote" in change) assert.equal(failureFields(error).validationIssue!.reason, "reference_quote_mismatch");
      else assert.ok(["invalid_selector", "invalid_reference", "scope_rule_invalid", "invalid_receipt"].includes(failureFields(error).validationIssue!.reason!));
      if (failureFields(error).validationIssue!.reason === "scope_rule_invalid") {
        const diagnostic = JSON.parse(failureFields(error).message!.slice(failureFields(error).message!.indexOf("{")));
        assert.deepEqual(diagnostic.allowedAdapterRulePaths, current.index.acceptanceScope![0]!.adapterRulePaths);
      }
      return true;
    });
  }
  assert.throws(() => current.resolveSubmission({ ...review, candidateHash: "b".repeat(64) }),
    (error) => failureFields(error).validationIssue!.reason === "candidate_mismatch");
  for (const source of ["candidate", "acceptanceAdapterGuide"]) {
    const incomplete = structuredClone(context); incomplete.contextManifest[source]!.delivery = "partial";
    const limited = createArchitectureEvidenceReader({ context: incomplete, candidateHash });
    assert.throws(() => limited.resolveSubmission(review), (error) => failureFields(error).validationIssue!.reason === "context_not_full");
  }
  const damaged = structuredClone(context); damaged.contextManifest.acceptanceAdapterGuide!.sha256 = "0".repeat(64);
  assert.throws(() => createArchitectureEvidenceReader({ context: damaged, candidateHash }).resolveSubmission(review),
    (error) => failureFields(error).validationIssue!.reason === "context_not_full");
  const guide = structuredClone(context.acceptanceAdapterGuide); objectFields(objectFields(objectFields(guide).adapters).action).proves += " 当前新增的精确说明。";
  const changedContext = architectureReviewEvidenceContext({ design: candidate, requirements: context.requirements,
    runtimeCapabilities: context.runtimeCapabilities, acceptanceAdapterGuide: guide });
  const changed = createArchitectureEvidenceReader({ context: changedContext, candidateHash }).resolveSubmission(review);
  assert.equal(changed.acceptanceScopeChecks![0]!.adapterRulePath, "/adapters/action/proves");
  assert.doesNotThrow(() => validateReview(changed, { candidateHash, schemaVersion: 3, evidenceContext: changedContext }));
});

test("范围回执短行恢复精确依据，原详细行兼容，充分性和完整覆盖仍由原评审门槛判断", async () => {
  const { current, candidate, candidateHash, context } = scopeFixture();
  const row = current.index.acceptanceScope![0];
  assert.equal(row!.acceptanceId, candidate.acceptance[0]!.id);
  assert.equal(row!.criterionPath, "/acceptance/0/expected");
  const read = result(await current.tool.execute("scope", { source: "acceptanceAdapterGuide", pointer: "/adapters/action/executionRule", acceptanceId: row!.acceptanceId }));
  assert.match(read.scopeReceiptId!, /^scope_[a-f0-9]{64}$/u);
  const official = reviewSubmissionSchema({ evidenceRequired: true }), before = structuredClone(official);
  const schema = current.submissionSchema(official), accepts = new Ajv({ strict: false }).compile(schema);
  assert.deepEqual(official, before);
  const review = passingReview(candidateHash, candidate);
  review.acceptanceScopeChecks![0] = { acceptanceId: row!.acceptanceId, scopeReceiptId: read.scopeReceiptId!, sufficient: true, reason: "独立核对本条实际范围" };
  assert.equal(accepts(review), true);
  assert.equal(new Ajv({ strict: false }).compile(official)(review), false);
  const unchanged = structuredClone(review), normalized = current.resolveSubmission(review);
  assert.deepEqual(review, unchanged);
  assert.equal(normalized.acceptanceScopeChecks![0]!.criterionQuote, undefined);
  assert.equal(normalized.acceptanceScopeChecks![0]!.adapterRulePath, "/adapters/action/executionRule");
  assert.equal(normalized.acceptanceScopeChecks![0]!.adapterId, "action");
  assert.equal(normalized.acceptanceScopeChecks![0]!.scope, ACCEPTANCE_ADAPTERS.action.scope);
  assert.doesNotThrow(() => validateReview(normalized, { candidateHash, schemaVersion: 3, evidenceContext: context }));
  review.acceptanceScopeChecks![0]!.sufficient = false;
  assert.throws(() => validateReview(current.resolveSubmission(review), { candidateHash, schemaVersion: 3, evidenceContext: context }),
    (error) => failureFields(error).validationIssues!.some((issue) => issue.reason === "missing_scope_issue"));
  review.acceptanceScopeChecks!.pop();
  assert.throws(() => validateReview(current.resolveSubmission(review), { candidateHash, schemaVersion: 3, evidenceContext: context }),
    (error) => failureFields(error).validationIssues!.some((issue) => issue.reason === "missing_coverage"));
});

test("范围回执拒绝跨验收、适配器、会话、候选、上下文、角色和篡改混合行", async () => {
  const { current, candidate, candidateHash, context } = scopeFixture(), acceptanceId = candidate.acceptance[0]!.id;
  const request = { source: "acceptanceAdapterGuide", pointer: "/adapters/action/proves", acceptanceId };
  const read = result(await current.tool.execute("scope", request));
  assert.equal(result(await current.tool.execute("again", request)).scopeReceiptId, read.scopeReceiptId);
  const submission = { issues: [], acceptanceScopeChecks: [{ acceptanceId, scopeReceiptId: read.scopeReceiptId!, sufficient: false, reason: "仍需修正" }] };
  const make = (overrides = {}) => createArchitectureEvidenceReader({ context, candidateHash, ...overrides });
  for (const different of [make(), make({ role: "designer" }), make({ candidateHash: "b".repeat(64) }),
    make({ context: { ...context, runtimeCapabilities: { hash: "changed" } } })])
    assert.throws(() => different.resolveSubmission(submission), (error) => failureFields(error).validationIssue!.reason === "invalid_receipt");
  for (const change of [
    { acceptanceId: candidate.acceptance[1]!.id }, { scopeReceiptId: `scope_${"0".repeat(64)}` },
    { adapterId: "host-files" }, { criterionQuote: "PRIVATE_FALSE_QUOTE" }, { adapterQuote: "PRIVATE_FALSE_QUOTE" }, { scope: "artifact-file-roundtrip" },
  ]) {
    const bad = structuredClone(submission); Object.assign(bad.acceptanceScopeChecks[0]!, change);
    assert.throws(() => current.resolveSubmission(bad), (error) => failureFields(error).validationIssue!.reason === "invalid_receipt" && !failureFields(error).message!.includes("PRIVATE_FALSE_QUOTE"));
  }
  for (const bad of [
    { ...request, pointer: "/adapters/host-business/executionRule" }, { ...request, pointer: "/composition/hostBusinessRule" },
    { ...request, pointer: "/adapters/action/scope" }, { ...request, acceptanceId: "unknown" },
    { ...request, source: "candidate", pointer: "/acceptance/0/expected" }, { ...request, offset: 0 },
  ]) await assert.rejects(current.tool.execute("bad_scope", bad), /范围回执|证据读取参数/u);
});

test("九种验证器只能选择自身或通用人类规则路径，签发后仍通过正式原文范围校验", async () => {
  const { requirements } = scopeFixture();
  const candidate = validDesign(requirements, { schemaVersion: 3, acceptance: Object.entries(ACCEPTANCE_ADAPTERS).map(([adapterId, adapter], index) => ({
    id: `scope_${index}`, kind: "success", requirementIds: [requirements[0]!.id], input: "固定范围输入", expected: `核对第${index}项明确承诺`,
    verification: { adapterId, stage: adapter.stage, owner: adapter.owner },
  })) });
  const candidateHash = designHash(candidate), context = architectureReviewEvidenceContext({ design: candidate, requirements, runtimeCapabilities: { hash: "fixed" } });
  const current = createArchitectureEvidenceReader({ context, candidateHash });
  const review = passingReview(candidateHash, candidate);
  for (const [index, row] of current.index.acceptanceScope!.entries()) {
    for (const pointer of row.adapterRulePaths) {
      const read = result(await current.tool.execute("scope", { source: "acceptanceAdapterGuide", pointer, acceptanceId: row.acceptanceId }));
      const scoped = structuredClone(review);
      scoped.acceptanceScopeChecks![index] = { acceptanceId: row.acceptanceId, scopeReceiptId: read.scopeReceiptId!, sufficient: true, reason: "独立核对当前规则与验收" };
      assert.doesNotThrow(() => validateReview(current.resolveSubmission(scoped), { candidateHash, schemaVersion: 3, evidenceContext: context }));
      scoped.acceptanceScopeChecks![index] = { acceptanceId: row.acceptanceId, adapterRulePath: pointer, sufficient: true, reason: "直接选择当前已完整提供的规则" };
      assert.doesNotThrow(() => validateReview(current.resolveSubmission(scoped), { candidateHash, schemaVersion: 3, evidenceContext: context }));
    }
    assert.ok(row.adapterRulePaths.every((pointer) => !pointer.startsWith("/adapters/") || pointer.startsWith(`/adapters/${row.adapterId}/`)));
  }
});

test("真实Pi零范围读取直接选择当前规则，不足判断缺对应阻断仍被拒绝后在原预算修正", { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-architecture-selector-sdk-"));
  const { draft, requirements, candidate, candidateHash, context } = scopeFixture();
  let modelCalls = 0, validations = 0;
  const model = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = fixtureChatRequest(Buffer.concat(chunks).toString("utf8")); modelCalls++;
      assert.ok(modelCalls <= 2);
      const args = passingReview(candidateHash, candidate);
      args.acceptanceScopeChecks = candidate.acceptance.map(({ id }, index) => ({ acceptanceId: id,
        adapterRulePath: "/adapters/action/executionRule", sufficient: index !== 0, reason: index === 0 ? "首项仍需更具体的可观察断言" : "独立核对本条当前范围" }));
      if (modelCalls === 2) {
        const content = body.messages.findLast((message) => message.role === "tool")!.content;
        const text = typeof content === "string" ? content : JSON.stringify(content);
        assert.match(text, /missing_scope_issue/u);
        args.verdict = "revise"; args.checks.find((item) => item.id === "acceptance_quality")!.passed = false;
        args.issues = [{ id: "refine_selector_scope", blocking: true, description: "首项验收需细化", remedy: "补充可观察断言",
          checkId: "acceptance_quality", kind: "design", candidatePaths: ["/acceptance/0"], factClaims: [],
          references: [{ source: "candidate", path: "/acceptance/0/expected", quote: candidate.acceptance[0]!.expected }] }];
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ id: "selector-fixture", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0,
        delta: { role: "assistant", tool_calls: [{ index: 0, id: `selector_${modelCalls}`, type: "function",
          function: { name: "submit_architecture_review", arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    } catch (error) { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: failureFields(error).message } })); }
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const designer = new ArchitectureDesigner({ config: { llmConfigured: true, model: "fixture-model", apiKey: "fixture-only",
    chatUrl: `http://127.0.0.1:${fixturePort(model)}/v1/chat/completions` }, cwd: root, dataDir: join(root, "data"),
    sessionFactory: async (options) => { const session = await createPiSession(options); session.setAutoCompactionEnabled(false); session.setAutoRetryEnabled(false); return session; } });
  t.after(async () => { await designer.persistence; model.closeAllConnections(); await new Promise<void>((resolve,reject)=>model.close(error=>error?reject(error):resolve())); await rm(root, { recursive: true, force: true }); });
  await designer.ready;
  let diagnostic;
  const review = await designer.role({ role: "reviewer", systemPrompt: "固定本地协议测试，不预读范围回执，独立判断不足时给对应阻断。", onProgress() {},
    payload: { requirements, design: candidate, candidateHash, candidateSchema: designSubmissionSchema(draft, { requirements }) },
    submitName: "submit_architecture_review", parameters: reviewSubmissionSchema({ evidenceRequired: true }), reviewEvidenceContext: context,
    validate: (value) => { validations++; assert.ok(recordArray(objectFields(value).acceptanceScopeChecks).every((row) => row.adapterRulePath && !Object.hasOwn(row, "criterionQuote"))); return validateReview(value, { candidateHash, schemaVersion: 3, evidenceContext: context }); },
    onDiagnostics: (value) => { diagnostic = value; } });
  assert.equal(review.verdict, "revise"); assert.equal(review.acceptanceScopeChecks![0]!.sufficient, false);
  assert.equal(validations, 2); assert.equal(modelCalls, 2); assert.equal(diagnostic!.modelCalls, 2); assert.equal(diagnostic!.submissionAttempts, 2);
  assert.equal(diagnostic!.lastSubmissionIssue.reason, "missing_scope_issue");
  assert.equal(diagnostic!.evidenceReads.calls, 0); assert.equal(diagnostic!.evidenceReads.requests, 0);
});

test("真实Pi批量取得范围回执后提交短行，独立不足结论保持原语义且不增加模型预算", { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-architecture-scope-sdk-"));
  const { draft, requirements, candidate, candidateHash, context } = scopeFixture();
  let modelCalls = 0, normalized;
  const model = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = fixtureChatRequest(Buffer.concat(chunks).toString("utf8")); modelCalls++;
      let name, args;
      if (modelCalls === 1) {
        const content = body.messages.findLast((message) => message.role === "user")!.content;
        const payload:ModelPayload = fixtureMaterialSources(JSON.parse(typeof content === "string" ? content : content!.filter((part) => part.type === "text").map((part) => part.text).join(""))) as ModelPayload;
        assert.equal(payload.reviewEvidenceIndex.acceptanceScope!.length, candidate.acceptance.length);
        assert.equal(payload.modelBudget.limit, null);
        name = "read_architecture_evidence";
        args = { requests: payload.reviewEvidenceIndex.acceptanceScope!.map((row) => ({ source: "acceptanceAdapterGuide",
          pointer: "/adapters/action/executionRule", acceptanceId: row.acceptanceId })) };
      } else {
        assert.equal(modelCalls, 2);
        const content = body.messages.findLast((message) => message.role === "tool")!.content;
        const blocks = typeof content === "string" ? [content] : content!.filter((item) => item.type === "text").map((item) => item.text);
        const objects:ReaderFeedback[] = blocks.flatMap((text) => text!.split(/\r?\n/u).filter((line) => line.trim()).map((line) => JSON.parse(line)));
        assert.equal(objects.at(-1)!.hostModelBudget.limit, null);
        assert.equal(objects.at(-1)!.hostModelBudget.used, 1);
        name = "submit_architecture_review"; args = passingReview(candidateHash, candidate);
        args.verdict = "revise"; args.checks.find((item) => item.id === "acceptance_quality")!.passed = false;
        args.acceptanceScopeChecks = objects[0]!.results.map((row, index) => ({ acceptanceId:fixtureString(row.acceptanceId),
          scopeReceiptId:row.scopeReceiptId!, sufficient: index !== 0, reason: index === 0 ? "独立评审认为首项仍需细化实际断言" : "独立核对本条检查范围" }));
        args.issues = [{ id: "refine_scope", blocking: true, description: "首项验收需细化", remedy: "补充可观察断言",
          checkId: "acceptance_quality", kind: "design", candidatePaths: ["/acceptance/0"], factClaims: [],
          references: [{ source: "candidate", path: "/acceptance/0/expected", quote: candidate.acceptance[0]!.expected }] }];
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ id: "scope-fixture", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0,
        delta: { role: "assistant", tool_calls: [{ index: 0, id: `scope_${modelCalls}`, type: "function",
          function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    } catch (error) { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: failureFields(error).message } })); }
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const designer = new ArchitectureDesigner({ config: { llmConfigured: true, model: "fixture-model", apiKey: "fixture-only",
    chatUrl: `http://127.0.0.1:${fixturePort(model)}/v1/chat/completions` }, cwd: root, dataDir: join(root, "data"),
    sessionFactory: async (options) => { const session = await createPiSession(options); session.setAutoCompactionEnabled(false); session.setAutoRetryEnabled(false); return session; } });
  t.after(async () => { await designer.persistence; model.closeAllConnections(); await new Promise<void>((resolve,reject)=>model.close(error=>error?reject(error):resolve())); await rm(root, { recursive: true, force: true }); });
  await designer.ready;
  let diagnostic;
  const review = await designer.role({ role: "reviewer", systemPrompt: "固定本地协议测试，使用范围回执提交独立评审。", onProgress() {},
    payload: { requirements, design: candidate, candidateHash, candidateSchema: designSubmissionSchema(draft, { requirements }) },
    submitName: "submit_architecture_review", parameters: reviewSubmissionSchema({ evidenceRequired: true }), reviewEvidenceContext: context,
    validate: (value) => { normalized = structuredClone(value); return validateReview(value, { candidateHash, schemaVersion: 3, evidenceContext: context }); },
    onDiagnostics: (value) => { diagnostic = value; } });
  assert.equal(review.verdict, "revise"); assert.equal(review.acceptanceScopeChecks![0]!.sufficient, false);
  assert.equal(review.acceptanceScopeChecks!.length, candidate.acceptance.length);
  assert.ok(recordArray(objectFields(normalized).acceptanceScopeChecks).every((row) => row.adapterRulePath && !Object.hasOwn(row, "scopeReceiptId")));
  assert.equal(modelCalls, 2); assert.equal(diagnostic!.modelCalls, 2); assert.equal(diagnostic!.submissionAttempts, 1);
  assert.equal(diagnostic!.evidenceReads.requests, candidate.acceptance.length);
});

test("只读引用回执绑定上下文与角色，原引用兼容且不改变提交对象", async () => {
  const current = reader(), read = result(await current.tool.execute("read", { source: "candidate", pointer: "/instructions" }));
  const submission = { issues: [{ references: [{ receiptId: read.receiptId }, { source: "requirements", path: "/0/text", quote: "任务" }] }] };
  const before = structuredClone(submission), normalized = current.resolveSubmission(submission);
  assert.deepEqual(submission, before);
  assert.deepEqual(normalized.issues[0]!.references, [read.reference, before.issues[0]!.references[1]]);
  for (const different of [reader(), reader({ role: "designer" }), reader({ candidateHash: "b".repeat(64) })])
    assert.throws(() => different.resolveSubmission(submission), (error) => failureFields(error).validationIssue!.reason === "invalid_receipt" && !failureFields(error).message!.includes(read.receiptId!));
  assert.throws(() => current.resolveSubmission({ issues: [{ references: [{ receiptId: read.receiptId, quote: "伪造" }] }] }), /格式混合/);
});

test("UTF-16分页不切断代理对，缺失路径只返回有界安全路径而不回显坏参数", async () => {
  const current = reader();
  const first = result(await current.tool.execute("read", { source: "candidate", pointer: "/instructions", offset: 1, limit: 1 }));
  assert.equal(first.reference!.quote, "😀"); assert.equal(first.offset, 1); assert.equal(first.nextOffset, 3); assert.equal(first.offsetUnit, "UTF-16");
  const middle = result(await current.tool.execute("read", { source: "candidate", pointer: "/instructions", offset: 2, limit: 1 }));
  assert.equal(middle.reference!.quote, "😀");
  const invalid = result(await current.tool.execute("bad", { source: "candidate", pointer: "/PRIVATE_REQUESTED_PATH" }));
  assert.equal(invalid.reason, "reference_path_missing"); assert.ok(invalid.availablePaths!.length <= 24);
  assert.doesNotMatch(JSON.stringify(invalid), /PRIVATE_REQUESTED_PATH|PRIVATE_PATH|private/u);
  assert.equal(result(await current.tool.execute("bad", { source: "candidate", pointer: "/__proto__" })).found, false);
});

test("子组无候选schema也能按唯一编号定位，读取和提交使用同一真实位置", async () => {
  const candidateHash = "a".repeat(64), components = [
    { id: "InputValidator", purpose: "检查输入" }, { id: "FailureHandler", purpose: "返回通用错误并记录日志" },
  ];
  const context = architectureReviewEvidenceContext({ design: { components }, requirements: [{ id: "R1", text: "处理错误" }], runtimeCapabilities: {} });
  const current = reader({ context, candidateHash });
  const named = result(await current.tool.execute("by-id", { source: "candidate", pointer: "/components/FailureHandler/purpose" }));
  assert.equal(named.found, true);
  assert.deepEqual(named.reference, { source: "candidate", path: "/components/1/purpose", quote: components[1]!.purpose });
  const numbered = result(await current.tool.execute("by-position", { source: "candidate", pointer: "/components/1/purpose" }));
  assert.equal(named.receiptId, numbered.receiptId);
  assert.deepEqual(current.index.candidate.components, components.map((item, index) => ({ id: item.id, path: `/components/${index}` })));
  const report = current.resolveSubmission({ candidateHash, issues: [{ candidatePaths: ["/components/FailureHandler"],
    references: [{ file: "candidate.json", path: "/components/FailureHandler/purpose" }] }] });
  assert.deepEqual(report.issues[0]!.candidatePaths, ["/components/1"]);
  assert.deepEqual(report.issues[0]!.references, [{ source: "candidate", path: "/components/1/purpose" }]);
  const source = result(await current.tool.execute("requirement", { source: "requirements", pointer: "/R1/text" }));
  assert.deepEqual(source.reference, { source: "requirements", path: "/0/text", quote: "处理错误" });
});

test("编号查找拒绝重复或近似名称，失败提示限定相关列表且原数字路径仍可读取", async () => {
  const context = architectureReviewEvidenceContext({ design: { components: [
    { id: "FailureHandler", purpose: "第一项" }, { id: "InputValidator", purpose: "其他项" }, { id: "FailureHandler", purpose: "第二项" },
  ] }, requirements: [], runtimeCapabilities: {} });
  const current = reader({ context });
  const ambiguous = result(await current.tool.execute("ambiguous", { source: "candidate", pointer: "/components/FailureHandler" }));
  assert.equal(ambiguous.reason, "reference_id_ambiguous"); assert.equal(ambiguous.receiptId, undefined);
  assert.deepEqual(ambiguous.availablePaths, ["/components/0", "/components/2"]);
  const missing = result(await current.tool.execute("missing", { source: "candidate", pointer: "/components/failurehandler" }));
  assert.equal(missing.reason, "reference_path_missing"); assert.equal(missing.receiptId, undefined);
  assert.ok(missing.availablePaths!.every(path => path.startsWith("/components")));
  assert.deepEqual(result(await current.tool.execute("numeric", { source: "candidate", pointer: "/components/2/purpose" })).reference,
    { source: "candidate", path: "/components/2/purpose", quote: "第二项" });
});

test("能力清单和多写一层 design 的查询均签发实际候选路径的回执", async () => {
  const capabilities = [{ id: "calculate", status: "available" }], candidateHash = "a".repeat(64);
  const context = architectureReviewEvidenceContext({ design: { capabilities }, requirements: [], runtimeCapabilities: {} });
  const current = reader({ context, candidateHash });
  const read = async (pointer: string) => result(await current.tool.execute("read", { source: "candidate", pointer }));
  const repeated = await read("/design/capabilities");
  assert.deepEqual(repeated.reference, { source: "candidate", path: "/capabilities", quote: JSON.stringify(capabilities) });
  const choices = current.index.candidateSections;
  assert.deepEqual(choices["能力清单"], { source: "candidate", pointer: "/capabilities" });
  assert.equal(choices["验收用例"], undefined);
  const batch = result(await current.tool.execute("batch", { requests: [choices["能力清单"], { source: "candidate", pointer: "能力清单" }] }));
  assert.ok(repeated.receiptId);
  assert.deepEqual(batch.results!.map(page => page.receiptId), [repeated.receiptId, repeated.receiptId]);
  const ref = { receiptId: repeated.receiptId };
  const review = current.resolveSubmission({ issues: [{ references: [ref], candidatePaths: [ref] }] });
  assert.deepEqual(review.issues[0]!.references, [repeated.reference]);
  assert.deepEqual(review.issues[0]!.candidatePaths, ["/capabilities"]);
  const direct = current.resolveSubmission({ candidateHash, issues: [{ references: [{ source: "candidate", path: "/design/capabilities" }] }] });
  assert.deepEqual(direct.issues[0]!.references, [{ source: "candidate", path: "/capabilities" }]);
});

test("候选查询优先读取真实 design 分支，缺项或其他来源不能借用候选内容", async () => {
  const current = reader({ context: { candidate: { capabilities: ["顶层"], design: { capabilities: ["内层"] }, steps: [] },
    runtimeCapabilities: { capabilities: ["平台"] } } });
  const read = async (source: string, pointer: string) => result(await current.tool.execute("read", { source, pointer }));
  assert.deepEqual((await read("candidate", "/design/capabilities")).reference,
    { source: "candidate", path: "/design/capabilities", quote: '["内层"]' });
  for (const page of [await read("candidate", "/design/steps"), await read("runtimeCapabilities", "/design/capabilities"),
    await read("runtimeCapabilities", "能力清单")]) {
    assert.equal(page.reason, "reference_path_missing"); assert.equal(page.receiptId, undefined);
  }
  const plain = reader({ context: { candidate: { capabilities: [] } } });
  const bad = result(await plain.tool.execute("batch", { requests: ["/design/design/capabilities", "/design/absent", "/design/__proto__"]
    .map(pointer => ({ source: "candidate", pointer })) }));
  assert.ok(bad.results!.every(page => page.reason === "reference_path_missing" && !page.receiptId));
});

test("提交工具副本只扩展显式回执分支，正式schema和混合引用仍严格", () => {
  const current = reader(), official:ToolSchema = reviewSubmissionSchema({ evidenceRequired: true }), before = structuredClone(official);
  const extended = current.submissionSchema(official);
  assert.deepEqual(official, before);
  const reference = new Ajv({ strict: false }).compile(extended.properties!.issues!.items!.properties!.references!.items!);
  assert.equal(reference({ receiptId: `ref_${"a".repeat(64)}` }), true);
  assert.equal(reference({ receiptId: `ref_${"a".repeat(64)}`, path: "/instructions" }), false);
  assert.equal(reference({ source: "candidate", path: "/instructions", quote: "A" }), true);
  assert.equal(new Ajv({ strict: false }).compile(official.properties!.issues!.items!.properties!.references!.items!)({ receiptId: `ref_${"a".repeat(64)}` }), false);
  const path = new Ajv({ strict: false }).compile(extended.properties!.issues!.items!.properties!.candidatePaths!.items!);
  assert.equal(path({ receiptId: `ref_${"a".repeat(64)}` }), true);
  assert.equal(path("/instructions"), true);
  assert.equal(path({ receiptId: `ref_${"a".repeat(64)}`, path: "/instructions" }), false);
  assert.equal(new Ajv({ strict: false }).compile(official.properties!.issues!.items!.properties!.candidatePaths!.items!)({ receiptId: `ref_${"a".repeat(64)}` }), false);
});

test("批读取保持顺序、逐项分页和24KiB UTF-8引用上限，参数与取消保持受控", async () => {
  const current = reader({ context: { candidate: { instructions: "中😀".repeat(1000) } } });
  const parameters = new Ajv({ strict: false }).compile(current.tool.parameters);
  const requests = Array.from({ length: 16 }, () => ({ source: "candidate", pointer: "/instructions", limit: 1000 }));
  assert.equal(parameters({ requests }), true);
  assert.equal(parameters({ source: "candidate", pointer: "/instructions" }), true);
  for (const bad of [{ requests: [] }, { requests: [...requests, requests[0]] }, { requests, source: "candidate" },
    { requests: [{ source: "candidate", pointer: "/instructions", limit: 1001 }] }, { requests, secret: "PRIVATE" }]) {
    assert.equal(parameters(bad), false);
    await assert.rejects(current.tool.execute("bad", bad), (error) => !failureFields(error).message!.includes("PRIVATE"));
  }
  const batch = result(await current.tool.execute("batch", { requests }));
  assert.equal(batch.results!.length, 16);
  assert.ok(batch.quoteBytes! <= 24 * 1024);
  assert.equal(batch.quoteBytes, batch.results!.reduce((sum: number, item) => sum + Buffer.byteLength(item.reference?.quote ?? "", "utf8"), 0));
  for (const item of batch.results!.filter((entry) => entry.reference)) {
    assert.ok(item.reference!.quote.length <= 1000);
    assert.doesNotMatch(item.reference!.quote, /[\uD800-\uDBFF]$/u);
    assert.doesNotMatch(item.reference!.quote, /^[\uDC00-\uDFFF]/u);
    assert.ok(item.nextOffset! > 0);
  }
  assert.ok(batch.results!.some((item) => item.reason === "batch_quote_limit"));
  const abort = new AbortController(); abort.abort(new Error("fixture cancelled"));
  await assert.rejects(current.tool.execute("cancel", { requests }, abort.signal), /fixture cancelled/u);
});

test("候选路径回执只解析当前候选非根路径，其他来源、过期和混合回执均拒绝", async () => {
  const current = reader();
  const batch = result(await current.tool.execute("batch", { requests: [
    { source: "candidate", pointer: "/instructions" }, { source: "candidate", pointer: "" },
    { source: "requirements", pointer: "/0/text" },
  ] }));
  const [candidate, root, requirement] = batch.results!;
  const submission = { issues: [{ candidatePaths: [{ receiptId: candidate!.receiptId }, "/instructions"], references: [{ receiptId: requirement!.receiptId }] }] };
  assert.deepEqual(current.resolveSubmission(submission).issues[0]!.candidatePaths, ["/instructions", "/instructions"]);
  for (const reference of [{ receiptId: root!.receiptId }, { receiptId: requirement!.receiptId },
    { receiptId: candidate!.receiptId, path: "/instructions" }])
    assert.throws(() => current.resolveSubmission({ issues: [{ candidatePaths: [reference] }] }), (error) => failureFields(error).validationIssue!.path === "review.issues[0].candidatePaths[0]" && failureFields(error).validationIssue!.reason === "invalid_receipt");
  assert.throws(() => reader().resolveSubmission(submission), (error) => {
    assert.equal(failureFields(error).validationIssue!.path, "review.issues[0].candidatePaths[0]");
    assert.equal(failureFields(error).validationIssue!.reason, "invalid_receipt");
    assert.match(failureFields(error).message!, /填写当前设计稿内的实际路径/u);
    return true;
  });
});

test("恢复旧出处仍拒绝缺少设计位置、唯一依据或历史原文不吻合的提交", async () => {
  const f = scopeFixture(), source = "acceptanceAdapterGuide", path = "/adapters/action/executionRule";
  const read = await f.current.tool.execute("read", { source, pointer: path });
  const { receiptId } = result(read);
  assert.ok(receiptId);
  const misplaced = { receiptId }, submitName = "submit_architecture_review_slice";
  const report = { candidateHash: f.candidateHash, issues: [{ candidatePaths: [misplaced, "/acceptance/0/expected"], references: [{ source, path }] }] };
  const messages: SessionMessage[] = [
    { role: "assistant", content: [{ type: "toolCall", id: "read", name: f.current.tool.name, arguments: { source, pointer: path } }] },
    { role: "toolResult", toolName: f.current.tool.name, toolCallId: "read", isError: false, content: [{ type: "text", text: toolText(read) }] },
    { role: "assistant", content: [{ type: "toolCall", id: "submit", name: submitName, arguments: report }] },
    { role: "toolResult", toolName: submitName, toolCallId: "submit", isError: true, content: [] },
  ];
  const resumed = () => createArchitectureEvidenceReader({ context: f.context, candidateHash: f.candidateHash });
  const current = resumed();
  current.recoverHistory(messages, submitName, value => value);
  const rejectsMisplaced = (error: unknown) => failureFields(error).validationIssue?.path === "review.issues[0].candidatePaths[0]"
    && failureFields(error).validationIssue?.reason === "invalid_receipt";
  for (const issue of [
    { candidatePaths: [misplaced], references: [{ source, path }] },
    { candidatePaths: [misplaced, "/acceptance/0/expected"], references: [{ source, path: "/adapters/action/proves" }] },
  ]) assert.throws(() => current.resolveSubmission({ ...report, issues: [issue] }), rejectsMisplaced);

  const corrupted = structuredClone(messages);
  const wrongPage = result(read);
  wrongPage.reference!.quote = "不匹配的历史摘录";
  corrupted[1]!.content = [{ type: "text", text: JSON.stringify(wrongPage) }];
  const unverified = resumed(), recovery = unverified.recoverHistory(corrupted, submitName, value => value);
  assert.equal(recovery?.reselect[0]?.path, "review.issues[0].candidatePaths[0]");
  assert.equal(JSON.stringify(recovery).includes(receiptId), false);
  assert.throws(() => unverified.resolveSubmission(report), rejectsMisplaced);
});

test("索引只列声明的顶层数组和稳定编号，路径缺失优先返回对应分支邻近路径", async () => {
  const candidate = { components: Array.from({ length: 60 }, (_, index) => ({ id: `component_${index}`, purpose: `body ${index}` })),
    acceptance: [{ id: "acceptance_1", expected: "完整承诺" }, { id: "acceptance_2", expected: "另一承诺" }],
    hidden: [{ id: "PRIVATE_ID", PRIVATE_KEY: "PRIVATE_BODY" }] };
  const current = reader({ context: { candidate, requirements: [{ id: "goal", text: "原文" }] }, candidateSchema: {
    type: "object", properties: { components: { type: "array", items: { type: "object", properties: { id: {}, purpose: {} } } },
      acceptance: { type: "array", items: { type: "object", properties: { id: {}, expected: {} } } } } } });
  assert.equal(current.index.candidate.components!.length, 60);
  assert.deepEqual(current.index.candidate.acceptance, [{ id: "acceptance_1", path: "/acceptance/0" }, { id: "acceptance_2", path: "/acceptance/1" }]);
  assert.deepEqual(current.index.requirements, [{ id: "goal", path: "/0" }]);
  assert.ok(current.index.sources.some((item) => item.source === "candidate" && item.path === ""));
  assert.doesNotMatch(JSON.stringify(current.index), /PRIVATE|完整承诺|body|原文/u);
  const index = current.index; index.candidate.acceptance![0]!.path = "/modified";
  assert.equal(current.index.candidate.acceptance[0]!.path, "/acceptance/0");
  const missing = result(await current.tool.execute("missing", { source: "candidate", pointer: "/acceptance/1/PRIVATE_REQUEST" }));
  assert.ok(missing.availablePaths!.includes("/acceptance/1/expected"));
  assert.ok(missing.availablePaths!.every((path) => path.startsWith("/acceptance/1")));
  assert.doesNotMatch(JSON.stringify(missing), /PRIVATE_REQUEST|PRIVATE_BODY|PRIVATE_KEY/u);
  const branch = result(await current.tool.execute("branch", { source: "candidate", pointer: "/acceptance/99/expected" }));
  assert.ok(branch.availablePaths!.includes("/acceptance/0/expected"));
  assert.ok(branch.availablePaths!.every((path) => path.startsWith("/acceptance")));
});

test("批读取不增加256条回执上限，已有回执可以继续复用", async () => {
  const current = reader({ context: { candidate: { instructions: "a".repeat(300) } } });
  let initial;
  for (let offset = 0; offset < 256; offset += 16) {
    const batch = result(await current.tool.execute("batch", { requests: Array.from({ length: 16 }, (_, index) => ({ source: "candidate", pointer: "/instructions", offset: offset + index, limit: 1 })) }));
    initial ??= batch.results![0];
  }
  await assert.rejects(current.tool.execute("over", { source: "candidate", pointer: "/instructions", offset: 256, limit: 1 }), /回执额度/u);
  const reused = result(await current.tool.execute("again", { source: "candidate", pointer: "/instructions", offset: 0, limit: 1 }));
  assert.equal(reused.receiptId, initial!.receiptId);
});

test("摘录拒绝只提供当前已存在来源路径的可选回执，不修改提交或回显错误原文", () => {
  const current = reader();
  const submission = { issues: [{ references: [
    { source: "candidate", path: "/instructions", quote: "PRIVATE_MODEL_QUOTE" },
    { source: "requirements", path: "/0/text", quote: "PRIVATE_MODEL_QUOTE" },
    { source: "candidate", path: "/PRIVATE_UNKNOWN_PATH", quote: "PRIVATE_MODEL_QUOTE" },
    { source: "not_a_source", path: "/instructions", quote: "PRIVATE_MODEL_QUOTE" },
  ] }] };
  const before = structuredClone(submission), issues = Array.from({ length: 6 }, (_, index) => ({
    path: `review.issues[0].references[${index}]`, reason: "reference_quote_mismatch",
  }));
  issues.push({ path: "review.issues[0].references[0]", reason: "reference_quote_mismatch" },
    { path: "review.issues[0].references[0].quote", reason: "reference_quote_mismatch" },
    { path: "review.issues[0].references[0]", reason: "reference_path_missing" });
  const hints = current.referenceHints(submission, issues);
  assert.deepEqual(submission, before); assert.equal(hints.length, 2);
  assert.deepEqual(hints.map((item) => item.quote), ["A😀BC", "完成任务"]);
  assert.ok(hints.every((item) => item.offset === 0 && item.nextOffset === null && item.offsetUnit === "UTF-16"));
  assert.doesNotMatch(JSON.stringify(hints), /PRIVATE|not_a_source/u);
  assert.deepEqual(current.resolveSubmission({ issues: [{ references: hints.map((item) => item.reference) }] }).issues[0]!.references,
    [{ source: "candidate", path: "/instructions", quote: "A😀BC" }, { source: "requirements", path: "/0/text", quote: "完成任务" }]);
  assert.equal(current.referenceHints(submission, issues)[0]!.reference.receiptId, hints[0]!.reference.receiptId);
  assert.throws(() => reader({ candidateHash: "b".repeat(64) }).resolveSubmission({ issues: [{ references: [hints[0]!.reference] }] }), /引用回执未知/u);
});

test("摘录提示有12条与500单元分页边界，不增加回执额度或掩盖原拒绝", async () => {
  const current = reader({ context: { candidate: { instructions: "a".repeat(1000), rationale: "新的当前原文" } } });
  const submission = { issues: [{ references: Array.from({ length: 20 }, () => ({ source: "candidate", path: "/instructions", quote: "wrong" })) }] };
  const issues = submission.issues[0]!.references.map((_item, index) => ({ path: `review.issues[0].references[${index}]`, reason: "reference_quote_mismatch" }));
  const hints = current.referenceHints(submission, issues);
  assert.equal(hints.length, 12); assert.equal(new Set(hints.map((item) => item.reference.receiptId)).size, 1);
  assert.ok(hints.every((item) => item.quote.length === 500 && item.total === 1000 && item.nextOffset === 500));
  for (let offset = 0; offset < 255; offset++) await current.tool.execute("fill", { source: "candidate", pointer: "/instructions", offset, limit: 1 });
  const additional = { issues: [{ references: [{ source: "candidate", path: "/rationale", quote: "wrong" }] }] };
  assert.deepEqual(current.referenceHints(additional, [issues[0]]), []);
  assert.equal(current.referenceHints(submission, [issues[0]])[0]!.reference.receiptId, hints[0]!.reference.receiptId);
});

test("真实Pi从摘录拒绝的宿主提示选择回执后纠正，其他来源路径错误仍被正式校验拒绝", { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-architecture-hint-sdk-"));
  const draft = validDraft(), requirements = requirementItems(draft), candidate = validDesign(requirements, { schemaVersion: 3 });
  const candidateHash = designHash(candidate), context = architectureReviewEvidenceContext({ design: candidate, requirements,
    runtimeCapabilities: { hash: "fixed", version: 1 } });
  let modelCalls = 0, hint: { source: string; path: string; quote: string; };
  const model = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = fixtureChatRequest(Buffer.concat(chunks).toString("utf8")); modelCalls++;
      assert.ok(body.tools!.some((item) => item.function.name === "submit_architecture_review"));
      const args = passingReview(candidateHash, candidate);
      args.verdict = "revise"; args.checks.find((item) => item.id === "verification")!.passed = false;
      args.issues = [{ id: "refine_processing", blocking: true, description: "处理说明需要完善", remedy: "在原范围完善处理说明",
        checkId: "verification", kind: "design", candidatePaths: ["/instructions"], factClaims: [],
        references: [{ source: "candidate", path: "/instructions", quote: "PRIVATE_BAD_MODEL_QUOTE" }] }];
      if (modelCalls === 2) {
        const feedback = body.messages.findLast((item) => item.role === "tool")!.content;
        const text = typeof feedback === "string" ? feedback : feedback!.filter((item) => item.type === "text").map((item) => item.text).join("\n");
        assert.match(text, /reference_quote_mismatch/u); assert.doesNotMatch(text, /PRIVATE_BAD_MODEL_QUOTE/u);
        const offset = text.indexOf('{"referenceHints":'); assert.ok(offset >= 0);
        const hints = JSON.parse(text.slice(offset).split(/\r?\n/u)[0]!).referenceHints;
        assert.equal(hints.length, 1); assert.equal(hints[0].quote, candidate.instructions);
        assert.equal(hints[0].path, "/instructions"); hint = hints[0].reference;
        args.issues[0]!.references = [hint, { source: "requirements", path: "/instructions", quote: "路径属于另一来源" }];
      } else if (modelCalls === 3) {
        const feedback = body.messages.findLast((item) => item.role === "tool")!.content;
        const text = typeof feedback === "string" ? feedback : JSON.stringify(feedback);
        assert.match(text, /reference_path_missing/u); assert.doesNotMatch(text, /referenceHints/u);
        args.issues[0]!.references = [hint];
      } else assert.equal(modelCalls, 1);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ id: "hint-fixture", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0,
        delta: { role: "assistant", tool_calls: [{ index: 0, id: `hint_${modelCalls}`, type: "function",
          function: { name: "submit_architecture_review", arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    } catch (error) { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: failureFields(error).message } })); }
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const designer = new ArchitectureDesigner({ config: { llmConfigured: true, model: "fixture-model", apiKey: "fixture-only",
    chatUrl: `http://127.0.0.1:${fixturePort(model)}/v1/chat/completions` }, cwd: root, dataDir: join(root, "data"),
    sessionFactory: async (options) => { const session = await createPiSession(options); session.setAutoCompactionEnabled(false); session.setAutoRetryEnabled(false); return session; } });
  t.after(async () => { await designer.persistence; model.closeAllConnections(); await new Promise<void>((resolve,reject)=>model.close(error=>error?reject(error):resolve())); await rm(root, { recursive: true, force: true }); });
  await designer.ready;
  let diagnostic;
  const review = await designer.role({ role: "reviewer", systemPrompt: "固定本地协议测试，仅提交指定独立评审。", onProgress() {},
    payload: { requirements, design: candidate, candidateHash, candidateSchema: designSubmissionSchema(draft, { requirements }) },
    submitName: "submit_architecture_review", parameters: reviewSubmissionSchema({ evidenceRequired: true }), reviewEvidenceContext: context,
    validate: (value) => validateReview(value, { candidateHash, schemaVersion: 3, evidenceContext: context }),
    onDiagnostics: (value) => { diagnostic = value; } });
  assert.equal(review.verdict, "revise"); assert.equal(modelCalls, 3); assert.equal(diagnostic!.modelCalls, 3);
  assert.deepEqual(review.issues[0]!.references, [{ source: "candidate", path: "/instructions", quote: candidate.instructions }]);
  assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_BAD_MODEL_QUOTE|referenceHints|根据用户提供的材料/u);
});

test("真实Pi批读取候选需求和指南并以回执定位修订，非候选和旧候选路径回执在原会话被拒绝", { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-architecture-receipt-sdk-")),calls:string[]=[],receipts:string[]=[];
  let designs = 0, reviewerCalls = 0;
  const model = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = fixtureChatRequest(Buffer.concat(chunks).toString("utf8")), isDesigner = body.tools!.some((item) => item.function.name === "submit_architecture");
      const packets = body.messages.filter(message => message.role === "user").map(message => {
        const content = message.content;
        return JSON.parse(typeof content === "string" ? content : content!.filter(part => part.type === "text").map(part => part.text).join(""));
      });
      const payload = fixtureMaterialSources(packets.findLast(packet => packet.contextIndex)) as ModelPayload;
      let name:string|undefined,args:ReturnType<typeof passingReview>|ReturnType<typeof validDesign>|undefined,toolCalls:{name:string|undefined;args:unknown}[]|undefined;
      if (isDesigner) {
        designs++; calls.push("designer"); name = "submit_architecture";
        args = validDesign(payload.requirements, { schemaVersion: 3, connections: [],
          interaction: { defaultEntry: "conversation", page: false, operations: false, inputs: "记录", results: "汇总", persistentData: "无" },
          execution: { language: "none", hosting: "builtin", reason: "使用已有文本能力" },
          selectionBasis: { capacity: "固定文本", process: "完整核对", quality: "逐项对应", requirementIds: payload.requirements.map((item) => item.id), assumptions: [] } });
        args.instructions = designs === 1 ? "当前处理说明需要完善。" : "完整处理方式和质量核对已经补齐。";
      } else {
        reviewerCalls++; calls.push(`reviewer_${reviewerCalls}`);
        assert.ok(body.tools!.some((item) => item.function.name === "read_architecture_evidence"));
        assert.deepEqual(payload.reviewEvidenceIndex.candidate.acceptance, payload.design.acceptance.map((item, index) => ({ id: item.id, path: `/acceptance/${index}` })));
        assert.ok(payload.reviewEvidenceIndex.requirements.some((item) => item.id === payload.requirements[0]!.id && item.path === "/0"));
        assert.equal(payload.modelBudget.limit, null); assert.equal(payload.modelBudget.remaining, undefined);
        if (reviewerCalls === 1) toolCalls = [{ name: "read_architecture_evidence", args: { requests: [
          { source: "candidate", pointer: "/instructions", limit: 3 }, { source: "requirements", pointer: "/0/text", limit: 3 },
          { source: "acceptanceAdapterGuide", pointer: "/adapters/action/doesNotProve" },
          { source: "candidate", pointer: "/instructions", limit: 3 },
          { source: "candidate", pointer: "/acceptance/999/missing" },
          { source: "candidate", pointer: "/instructions", offset: 999 },
          payload.reviewEvidenceIndex.candidateSections["能力清单"],
        ] } }];
        else {
          name = "submit_architecture_review"; const review = passingReview(payload.candidateHash,payload.design);args=review;
          if (reviewerCalls === 2) {
            const content = body.messages.findLast((item) => item.role === "tool")!.content;
            const blocks = typeof content === "string" ? [content] : content!.filter((item) => item.type === "text").map((item) => item.text);
            const objects:ReaderFeedback[] = blocks.flatMap((text) => text!.split(/\r?\n/u).filter((line) => line.trim()).map((line) => JSON.parse(line)));
            const batch = objects[0];
            assert.equal(batch!.results.length, 7); assert.ok(batch!.results.slice(0, 4).every((item) => item.found));
            assert.equal(batch!.results[4]!.reason, "reference_path_missing");
            assert.equal(batch!.results[5]!.reason, "empty_slice");
            assert.deepEqual(batch!.results[6]!.reference, { source: "candidate", path: "/capabilities", quote: JSON.stringify(payload.design.capabilities) });
            receipts.push(...batch!.results.slice(0, 3).map((item) => item.receiptId!));
            const budget = objects.at(-1)!.hostModelBudget;
            assert.equal(budget.limit, null); assert.equal(budget.remaining, undefined);
            assert.deepEqual(objects.at(-1)!.reviewReadProgress, { calls: 1, requests: 7, found: 6, missing: 1, empty: 1, more: 3, repeated: 1 });
          }
          if ([2, 3, 4].includes(reviewerCalls)) {
            review.verdict = "revise"; review.checks.find((item) => item.id === "verification")!.passed = false;
            review.issues = [{ id: "clarify_execution", blocking: true, description: "需要完善处理说明", remedy: "在现有范围补齐处理说明",
              checkId: "verification", kind: "design", candidatePaths: [{ receiptId: receipts[reviewerCalls === 2 ? 1 : 0]! }], references: receipts.map((receiptId) => ({ receiptId })), factClaims: [] }];
          }
          if (reviewerCalls === 3 || reviewerCalls === 5) {
            const feedback = body.messages.findLast((message) => message.role === "tool")!.content;
            const text = typeof feedback === "string" ? feedback : JSON.stringify(feedback);
            assert.match(text, /invalid_receipt/u);
            assert.match(text, /review\.issues\[0\]\.candidatePaths\[0\]/u);
            assert.ok(receipts.every((id) => !text.includes(id)));
          }
          if (payload.priorFindings) review.priorFindingDecisions = payload.priorFindings.findings.map(({ findingId }) => ({
            findingId, status: review.verdict === "revise" ? "unresolved" : "unsupported",
            reason: review.verdict === "revise" ? "本次固定夹具仍明确提出处理说明问题" : "当前说明已完整表达处理和质量核对，旧夹具意见不再有当前依据",
            checkIds: ["verification"], candidatePaths: ["/instructions"],
          }));
          if (review.verdict === "pass") for (const finding of payload.priorFindings?.findings ?? []) {
            if (!finding.closureEvidenceRequired) continue;
            review.issues.push({ id: finding.findingId, blocking: false, kind: "design", checkId: "verification",
              description: "本轮处理说明已完整表达处理和质量核对，旧问题没有当前依据。", remedy: "保留已明确的处理约定。",
              candidatePaths: ["/instructions"], references: [{ source: "candidate", path: "/instructions", quote: payload.design.instructions }], factClaims: [] });
          }
        }
      }
      toolCalls ??= [{ name, args }];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0,
        delta: { role: "assistant", tool_calls: toolCalls.map((call, index) => ({ index, id: `fixture_${objectFields(calls).length}_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })) },
        finish_reason: "tool_calls" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    } catch (error) { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: failureFields(error).message } })); }
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const designer = new ArchitectureDesigner({ config: { llmConfigured: true, chatUrl: `http://127.0.0.1:${fixturePort(model)}/v1/chat/completions`,
    model: "fixture-model", apiKey: "fixture-only" }, cwd: root, dataDir: join(root, "data"), sessionFactory: async (options) => {
    const session = await createPiSession(options); session.setAutoCompactionEnabled(false); session.setAutoRetryEnabled(false); return session; } });
  t.after(async () => { await designer.ready; await designer.persistence; model.closeAllConnections(); await new Promise<void>((resolve,reject)=>model.close(error=>error?reject(error):resolve())); await rm(root, { recursive: true, force: true }); });
  const value = await designer.design({ id: "receipt", name: "汇总助手", draft: validDraft(), fingerprint: "receipt-test" });
  assert.equal(value.status, "passed"); assert.equal(value.attempts.length, 2);
  assert.deepEqual(calls, ["designer", "reviewer_1", "reviewer_2", "reviewer_3", "designer", "reviewer_4", "reviewer_5"]);
  const expanded=recordArray(recordArray(objectFields(value.attempts[0]!.review).issues)[0]!.references);
  assert.equal(expanded.length, 3); assert.ok(expanded.every((entry) => entry.quote && !Object.hasOwn(entry, "receiptId")));
  assert.deepEqual(recordArray(objectFields(value.attempts[0]!.review).issues)[0]!.candidatePaths, ["/instructions"]);
  assert.equal(value.reviewDiagnostics!.length, 2);
  const reads = value.reviewDiagnostics![0]!.evidenceReads;
  assert.deepEqual(Object.fromEntries(Object.entries(objectFields(reads)).filter(([key]) => key !== "recent")),
    { calls: 1, requests: 7, found: 6, missing: 1, empty: 1, more: 3, repeated: 1 });
  assert.equal(recordArray(objectFields(reads).recent).length, 7); assert.ok(recordArray(objectFields(reads).recent).every((item) => /^[a-f0-9]{64}$/u.test(item.pathHash as string)));
  assert.doesNotMatch(JSON.stringify(reads), /receiptId|quote|\/instructions|\/acceptance|当前处理说明/u);
});

test("证据读取器拒绝损坏索引，保留未验证提交中的原始字段", () => {
  assert.throws(() => reader({ priorFindings: { findings: { hidden: true } } }), /历史问题索引字段无效/);
  assert.throws(() => reader({ context: { candidate: { acceptance: "damaged" } } }), /验收证据索引字段无效/);
  const submission = { candidateHash: "a".repeat(64), acceptanceScopeChecks: [null, 7], issues: [null, "unvalidated"] };
  assert.deepEqual(reader().resolveSubmission(submission), submission);
});
