import { fixtureTools, recordArray, callFixture } from "../helpers/m7-test-boundaries.mjs";
import { fixtureString } from "../helpers/http-model.mjs";
import type { ArchitectureRoleOptions } from "../../src/architecture/architecture-controller-port.mjs";
type RecordedProgress = Parameters<NonNullable<ArchitectureRoleOptions["onReviewProgress"]>>[0];
function partIssues(value: unknown) { return recordArray(objectFields(value).issues ?? []); }
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import type { PiSessionOptions } from "../../src/runtime/pi-port.mjs";
import { failureFields } from "../helpers/failure-fields.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchitectureDesigner } from "../../src/architecture/architecture.mjs";
import { designHash, reviewSubmissionSchema } from "../../src/architecture/architecture-contract.mjs";
import { architectureReviewEvidenceContext } from "../../src/architecture/architecture-review-evidence.mjs";
import { validDesign } from "../helpers/architecture.mjs";
import { historicalRepairSnapshot } from "../../src/architecture/architecture-repair-evidence.mjs";
import type { UnknownRecord } from "../../src/contracts/json.mjs";

test("恢复历史关闭缺项用规范草稿定位，仅补说明行即可保存且保留累计次数", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "neuma-closure-hints-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const requirements = [{ id: "R1", text: "完整处理输入" }], old = validDesign(requirements, { schemaVersion: 3 });
  const design = structuredClone(old), paths = ["/acceptance/0", "/acceptance/1", "/acceptance/2"];
  for (const item of design.acceptance.slice(0, 3)) item.expected += "；新增冻结用例真实执行断言。";
  const candidateHash = designHash(design), context = architectureReviewEvidenceContext({ design, requirements, runtimeCapabilities: {} });
  const findingId = "finding_coverage", finding = { findingId, kind: "historical-review-opinion", closureEvidenceRequired: true,
    issue: { kind: "design" }, repairBasis: historicalRepairSnapshot(old, paths) };
  const priorFindings = { current: { candidateHash, guideHash: context.contextManifest.acceptanceAdapterGuide!.sha256,
    contextManifestHash: designHash(context.contextManifest) }, sameReviewObject: false, findings: [finding] };
  const explanation = { id: findingId, blocking: false, checkId: "verification", kind: "design", description: "三条均已修复",
    remedy: "核对实际执行依据", candidatePaths: paths,
    references: [{ source: "candidate", path: "/acceptance/0/expected", quote: design.acceptance[0]!.expected }], factClaims: [] };
  const other = { ...structuredClone(explanation), id: "other", description: "另一项说明" };
  const rejectedParts = { candidateHash, checks: [], issues: [other, explanation], acceptanceScopeChecks: [],
    priorFindingDecisions: [{ findingId, status: "resolved", reason: "三条均有真实修订", checkIds: ["verification"], candidatePaths: paths }] };
  const diagnostics = paths.slice(1).map(candidatePath => ({ path: "review.issues[1].references",
    reason: "repair_candidate_reference_unrelated", candidatePath }));
  const rejectedInput = { toolName: "submit_architecture_review_parts", input: { ...structuredClone(rejectedParts),
    issues: [explanation, other], progressHash: "a".repeat(64), rejectedPartsHash: "b".repeat(64), verdict: "pass", summary: "旧草稿" } };
  const progress: { review?: unknown; origin?: string; parts?: unknown; rejectedParts?: unknown; rejectedInput?: unknown; modelCalls: number; diagnostic?: import("../../src/contracts/architecture.mjs").ReviewDiagnostic; }[] = []; let verified = false, innerFailure, calls = 19;
  const designer = new ArchitectureDesigner({ config: { llmConfigured: true }, cwd, dataDir: join(cwd, "data"),
    sessionFactory: async (options: PiSessionOptions) => ({ modelCallAccounting: true, messages: [], subscribe: () => () => {}, dispose() {}, async abort() {},
      async prompt(text) {
        try {
          await options.onModelCall!(); const payload = JSON.parse(text);
          const hints = recordArray(payload.reviewReferenceHints);
          assert.ok(hints.length > 0 && hints.every((hint) => hint.issueId === findingId));
          const selected = paths.slice(1).map(path => hints.find((hint) => hint.path === `${path}/expected`));
          assert.ok(selected.every(Boolean));
          const tool = fixtureTools(options.customTools).save_architecture_review_parts;
          await assert.rejects(tool!.execute("still-missing-evidence", { candidateHash, progressHash: payload.reviewParts.progressHash,
            rejectedPartsHash: payload.reviewParts.rejectedPartsHash, issues: [explanation] }), error => {
            assert.equal(failureFields(error).validationIssue!.path, "review.issues[1].references");
            const marker = failureFields(error).message!.lastIndexOf('{"referenceHints":');
            assert.ok(marker >= 0);
            const feedback = recordArray(JSON.parse(failureFields(error).message!.slice(marker)).referenceHints);
            assert.ok(feedback.length > 0 && feedback.every((hint) => hint.issueId === findingId));
            assert.ok(progress.every(value => !partIssues(value.parts).length));
            return true;
          });
          await tool!.execute("patch-only-explanation", { candidateHash, progressHash: payload.reviewParts.progressHash,
            rejectedPartsHash: payload.reviewParts.rejectedPartsHash,
            issues: [{ ...explanation, references: [...explanation.references, ...selected.map(hint => hint!.reference)] }] });
          const saved = progress.findLast(value => value.parts);
          assert.equal(saved!.modelCalls, 20);
          assert.deepEqual(partIssues(saved!.parts)[0], other);
          assert.equal(recordArray(partIssues(saved!.parts)[1]!.references).length, 3);
          assert.equal(saved!.rejectedInput, null);
          assert.equal(progress.some(value => value.review), false);
          verified = true;
        } catch (error) { innerFailure = error; throw error; }
        throw new Error("offline stop after partial save");
      } }) });
  await designer.ready;
  await assert.rejects(callFixture(designer.role, designer, [{ role: "reviewer", systemPrompt: "本地检查", submitName: "submit_architecture_review",
    parameters: reviewSubmissionSchema({ evidenceRequired: true, priorFindingsRequired: true }),
    payload: { candidateHash, design, requirements, priorFindings }, reviewEvidenceContext: context,
    initialModelCalls: 19, modelCallLimit: 24, reviewRetry: { schemaVersion: 3, source: { modelCalls: 19 }, additionalCalls: 5 },
    resumeReviewProgress: { modelCalls: 19, rejectedParts, rejectedInput,
      diagnostic: { lastSubmissionIssue: diagnostics[0]!, issues: diagnostics } },
    onMainReviewBudget: (used: number) => { calls = Math.max(calls, used); },
    onReviewProgress: (value: RecordedProgress) => progress.push(structuredClone(value)),
    validate: () => assert.fail("局部补依据不能代替正式独立评审") }]));
  assert.ifError(innerFailure); assert.equal(verified, true); assert.equal(calls, 20);
});

test("引用解析前失败也保存最新原始提交，恢复提供新回执并沿累计预算修正", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "neuma-raw-review-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const requirements = [{ id: "R1", text: "完整处理输入" }], design = validDesign(requirements, { schemaVersion: 3 });
  design.instructions = "处理说明。".repeat(240);
  const candidateHash = designHash(design), context = architectureReviewEvidenceContext({ design, requirements, runtimeCapabilities: {} });
  const progress: RecordedProgress[] = []; let initial: unknown, diagnostics, round = 0, calls = 0, verified = 0, innerFailure;
  const designer = new ArchitectureDesigner({ config: { llmConfigured: true }, cwd, dataDir: join(cwd, "data"),
    sessionFactory: async (options: PiSessionOptions) => ({ modelCallAccounting: true, messages: [], subscribe: () => () => {}, dispose() {}, async abort() {},
      async prompt(text) {
        try {
        await options.onModelCall!(); calls++;
        const payload = JSON.parse(text), tool = fixtureTools(options.customTools).save_architecture_review_parts;
        if (round++ === 0) {
          initial = { candidateHash, progressHash: payload.reviewParts.progressHash,
            checks: [{ id: "verification", passed: true, evidence: "最新检查" }],
            issues: [{ id: "latest_change", blocking: false, checkId: "verification", kind: "design", description: "应保留的最新修改",
              remedy: "核对处理说明", candidatePaths: ["/instructions"], references: [{ source: "candidate", path: "/instructions" }], factClaims: [] }] };
          await assert.rejects(tool!.execute("too-broad-original", initial), error => {
            assert.equal(failureFields(error).validationIssue!.reason, "reference_too_broad");
            assert.match(fixtureString(failureFields(error).message), /referenceHints/u); diagnostics = failureFields(error).validationIssues; return true;
          });
          assert.deepEqual(objectFields(progress.findLast(value => value.rejectedInput)!.rejectedInput).input, initial);
          assert.equal(progress.some(value => value.parts || value.review), false);
        } else {
          assert.equal(payload.modelBudget.used, 1);
          assert.deepEqual(payload.latestRejectedInput.input, initial);
          assert.notEqual(payload.reviewParts.progressHash, objectFields(initial).progressHash);
          assert.equal(payload.reviewReferenceHints[0].path, "/instructions");
          const corrected = structuredClone(initial); objectFields(corrected).progressHash = payload.reviewParts.progressHash;
          partIssues(corrected)[0]!.references = [payload.reviewReferenceHints[0].reference];
          await tool!.execute("explicit-recovered-correction", corrected);
          const saved = progress.findLast(value => value.parts);
          assert.equal(saved!.modelCalls, 2);
          assert.equal(partIssues(saved!.parts)[0]!.description, "应保留的最新修改");
          assert.ok(design.instructions.includes(fixtureString(recordArray(partIssues(saved!.parts)[0]!.references)[0]!.quote)));
          assert.equal(saved!.rejectedInput, null);
        }
        verified++; throw new Error("offline stop");
        } catch (error) { if (failureFields(error).message !== "offline stop") innerFailure = error; throw error; }
      } }) });
  const options = { role: "reviewer", systemPrompt: "本地检查", submitName: "submit_architecture_review",
    parameters: reviewSubmissionSchema({ evidenceRequired: true }), payload: { candidateHash, design, requirements },
    reviewEvidenceContext: context, validate: () => assert.fail("分项不代表正式评审通过"),
    onReviewProgress: (value: RecordedProgress) => progress.push(structuredClone(value)) };
  await assert.rejects(designer.role(options));
  const rejectedInput = progress.findLast(value => value.rejectedInput)!.rejectedInput;
  await assert.rejects(callFixture(designer.role, designer, [{ ...options, initialModelCalls: 1,
    resumeReviewProgress: { modelCalls: 1, rejectedInput, diagnostic: { lastSubmissionIssue: diagnostics![0]!, issues: diagnostics! } } }]));
  assert.ifError(innerFailure); assert.equal(round, 2); assert.equal(calls, 2); assert.equal(verified, 2);
  assert.equal(progress.some(value => value.review), false);
});

test("原始提交保存失败锁定后续请求和迟到工具调用", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "neuma-raw-review-save-fail-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const requirements = [{ id: "R1", text: "处理输入" }], design = validDesign(requirements, { schemaVersion: 3 });
  design.instructions = "说明".repeat(600);
  const candidateHash = designHash(design), context = architectureReviewEvidenceContext({ design, requirements, runtimeCapabilities: {} });
  let charges = 0, rejectedSaves = 0, locked = false;
  const designer = new ArchitectureDesigner({ config: { llmConfigured: true }, cwd, dataDir: join(cwd, "data"),
    sessionFactory: async (options: PiSessionOptions) => ({ modelCallAccounting: true, messages: [], subscribe: () => () => {}, dispose() {}, async abort() {},
      async prompt(text) {
        await options.onModelCall!(); const payload = JSON.parse(text), tool = fixtureTools(options.customTools).save_architecture_review_parts;
        const args = { candidateHash, progressHash: payload.reviewParts.progressHash, issues: [{ id: "quote", blocking: false,
          checkId: "verification", kind: "design", description: "检查说明", remedy: "核对", candidatePaths: ["/instructions"],
          references: [{ source: "candidate", path: "/instructions" }], factClaims: [] }] };
        await assert.rejects(tool!.execute("raw-save-fail", args), /raw persistence failed/u);
        await assert.rejects(async () => { await options.onModelCall!(); }, /raw persistence failed/u);
        await assert.rejects(tool!.execute("late-correction", args), /raw persistence failed/u);
        locked = true; throw new Error("offline stop");
      } }) });
  await assert.rejects(designer.role({ role: "reviewer", systemPrompt: "本地检查", submitName: "submit_architecture_review",
    parameters: reviewSubmissionSchema({ evidenceRequired: true }), payload: { candidateHash, design, requirements },
    reviewEvidenceContext: context, validate: () => assert.fail("must not validate"),
    onMainReviewBudget: used => { charges = Math.max(charges, used); },
    onReviewProgress: value => { if (value.rejectedInput) { rejectedSaves++; throw new Error("raw persistence failed"); } } }));
  assert.equal(charges, 1); assert.equal(rejectedSaves, 1); assert.equal(locked, true);
});

test("分项保存和组装的真实错误先保存位置与原因，再结束当前模型请求", async (t) => {
  for (const name of ["save_architecture_review_parts", "submit_architecture_review_parts"]) await t.test(name, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "neuma-part-error-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const requirements = [{ id: "R1", text: "完整处理输入" }], design = validDesign(requirements, { schemaVersion: 3 });
    const candidateHash = designHash(design), progress: { review?: unknown; origin?: string; parts?: unknown; rejectedParts?: unknown; rejectedInput?: unknown; modelCalls: number; diagnostic?: import("../../src/contracts/architecture.mjs").ReviewDiagnostic; }[] = [], statuses: UnknownRecord[] = []; let diagnostic, requests = 0;
    const context = architectureReviewEvidenceContext({ design, requirements, runtimeCapabilities: {} });
    const expected = name === "save_architecture_review_parts"
      ? { path: "reviewParts.progressHash", reason: "invalid_reference" }
      : { path: "reviewParts", reason: "missing_coverage" };
    const designer = new ArchitectureDesigner({ config: { llmConfigured: true, model: "offline-diagnostics" }, cwd, dataDir: join(cwd, "data"),
      sessionFactory: async (options: PiSessionOptions) => ({ modelCallAccounting: true, messages: [], subscribe: () => () => {}, dispose() {}, async abort() {},
        async prompt(text) {
          requests++; await options.onModelCall!(); const payload = JSON.parse(text);
          const tool = fixtureTools(options.customTools)[name];
          const args = { candidateHash, progressHash: name === "save_architecture_review_parts" ? "b".repeat(64) : payload.reviewParts.progressHash,
            ...(name === "save_architecture_review_parts" ? { checks: [{ id: "verification", passed: true, evidence: "本地测试" }] }
              : { verdict: "pass", summary: "缺项不得通过" }) };
          await assert.rejects(tool!.execute("actual-rejection", args), (error) => {
            assert.deepEqual(failureFields(error).validationIssue, expected); return true;
          });
          throw new Error("offline stop after the actual rejected call");
        } }) });
    await assert.rejects(designer.role({ role: "reviewer", systemPrompt: "本地诊断夹具", submitName: "submit_architecture_review",
      parameters: reviewSubmissionSchema({ evidenceRequired: true }), payload: { candidateHash, design, requirements, requireAcceptanceVerification: true },
      reviewEvidenceContext: context, validate: () => { throw new Error("must not reach formal review"); },
      onProgress: (event) => statuses.push(event), onReviewProgress: (value: RecordedProgress) => progress.push(structuredClone(value)),
      onDiagnostics: (value) => { diagnostic = value; } }));
    assert.equal(requests, 1); assert.equal(diagnostic!.modelCalls, 1);
    assert.deepEqual(diagnostic!.lastSubmissionIssue, expected);
    assert.deepEqual(progress.findLast((value) => value.diagnostic)?.diagnostic!.lastSubmissionIssue, expected);
    assert.ok(statuses.some((event) => objectFields(event.validationIssue)?.reason === expected.reason));
    assert.equal(progress.some((value) => value.parts || value.review), false);
  });
});

test("分项引用错误直接提供当前原文回执，显式选择后保存且不增加模型次数", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "neuma-parts-reference-hints-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const requirements = [{ id: "R1", text: "完整处理输入" }], design = validDesign(requirements, { schemaVersion: 3 });
  const candidateHash = designHash(design), context = architectureReviewEvidenceContext({ design, requirements, runtimeCapabilities: {} });
  const progress: { review?: unknown; origin?: string; parts?: unknown; rejectedParts?: unknown; rejectedInput?: unknown; modelCalls: number; diagnostic?: import("../../src/contracts/architecture.mjs").ReviewDiagnostic; }[] = []; let charges = 0;
  const designer = new ArchitectureDesigner({ config: { llmConfigured: true }, cwd, dataDir: join(cwd, "data"),
    sessionFactory: async (options: PiSessionOptions) => ({ modelCallAccounting: true, messages: [], subscribe: () => () => {}, dispose() {}, async abort() {},
      async prompt(text) {
        await options.onModelCall!(); const payload = JSON.parse(text), tool = fixtureTools(options.customTools).save_architecture_review_parts;
        const args = { candidateHash, progressHash: payload.reviewParts.progressHash,
          checks: [{ id: "verification", passed: true, evidence: "本地检查" }], issues: [{ id: "needs_evidence", blocking: false, checkId: "verification", kind: "design",
            description: "独立核对处理说明", remedy: "保留原业务范围", candidatePaths: ["/instructions"],
            references: [{ source: "candidate", path: "/instructions", quote: "不是当前原文" }], factClaims: [] }] };
        let hints;
        await assert.rejects(tool!.execute("bad-parts-quote", args), error => {
          const marker = failureFields(error).message!.lastIndexOf('{"referenceHints":');
          assert.ok(marker >= 0); hints = JSON.parse(failureFields(error).message!.slice(marker)).referenceHints;
          assert.equal(hints[0].quote, design.instructions); return true;
        });
        assert.equal(progress.some(value => partIssues(value.parts).length), false);
        assert.equal(recordArray(partIssues(progress.findLast(value => value.rejectedParts)?.rejectedParts)[0]!.references)[0]!.quote, "不是当前原文");
        args.issues[0]!.references = [hints![0].reference];
        await tool!.execute("explicit-receipt-correction", args);
        assert.equal(recordArray(partIssues(progress.findLast(value => value.parts)?.parts)[0]!.references)[0]!.quote, design.instructions);
        throw new Error("offline stop after partial save");
      } }) });
  await assert.rejects(designer.role({ role: "reviewer", systemPrompt: "本地检查", submitName: "submit_architecture_review",
    parameters: reviewSubmissionSchema({ evidenceRequired: true }), payload: { candidateHash, design, requirements, requireAcceptanceVerification: true },
    reviewEvidenceContext: context, validate: () => assert.fail("分项保存不能代替正式提交"),
    onMainReviewBudget: used => { charges = Math.max(charges, used); }, onReviewProgress: (value: RecordedProgress) => progress.push(structuredClone(value)) }));
  assert.equal(charges, 1);
  assert.equal(progress.some(value => value.review), false);
});

test("被拒报告落盘失败后不再发出下一模型请求或接受迟到修正", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "neuma-rejected-save-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const requirements = [{ id: "R1", text: "完整处理输入" }], design = validDesign(requirements, { schemaVersion: 3 });
  const candidateHash = designHash(design), context = architectureReviewEvidenceContext({ design, requirements, runtimeCapabilities: {} });
  let diagnostic, charges = 0, rejectedSaves = 0;
  const designer = new ArchitectureDesigner({ config: { llmConfigured: true }, cwd, dataDir: join(cwd, "data"),
    sessionFactory: async (options: PiSessionOptions) => ({ modelCallAccounting: true, messages: [], subscribe: () => () => {}, dispose() {}, async abort() {},
      async prompt(text) {
        await options.onModelCall!(); const payload = JSON.parse(text), tool = fixtureTools(options.customTools).save_architecture_review_parts;
        const args = { candidateHash, progressHash: payload.reviewParts.progressHash,
          checks: [{ id: "verification", passed: true, evidence: "本地检查" }], issues: [{ id: "bad", blocking: false, checkId: "verification", kind: "design",
            description: "测试被拒原文", remedy: "核对原文", candidatePaths: ["/instructions"],
            references: [{ source: "candidate", path: "/instructions", quote: "not the original" }], factClaims: [] }] };
        await assert.rejects(tool!.execute("bad-quote", args), /draft persistence failed/u);
        await assert.rejects(async () => { await options.onModelCall!(); }, /draft persistence failed/u);
        args.issues[0]!.references[0]!.quote = design.instructions;
        await assert.rejects(tool!.execute("late-correction", args), /draft persistence failed/u);
        throw new Error("offline stop");
      } }) });
  await assert.rejects(designer.role({ role: "reviewer", systemPrompt: "本地检查", submitName: "submit_architecture_review",
    parameters: reviewSubmissionSchema({ evidenceRequired: true }), payload: { candidateHash, design, requirements, requireAcceptanceVerification: true },
    reviewEvidenceContext: context, validate: () => assert.fail("不能正式提交"),
    onMainReviewBudget: used => { charges = Math.max(charges, used); },
    onReviewProgress: value => { if (value.rejectedParts) { rejectedSaves++; throw new Error("draft persistence failed"); } },
    onDiagnostics: value => { diagnostic = value; } }));
  assert.equal(charges, 1); assert.equal(diagnostic!.modelCalls, 1); assert.equal(rejectedSaves, 1);
});
