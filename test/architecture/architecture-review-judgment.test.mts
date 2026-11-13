import test from "node:test";
import assert from "node:assert/strict";
import type { ReviewParts } from "../../src/contracts/architecture.mjs";
import type { JudgmentGroup, ReviewJudgmentCheckpoint } from "../../src/architecture/architecture-review-judgment.mjs";
import { judgeArchitectureReviewGroups } from "../../src/architecture/architecture-review-judgment.mjs";
import { canonicalArchitectureReviewParts } from "../../src/architecture/architecture-review-parts.mjs";
import { designHash, reviewSubmissionSchema } from "../../src/architecture/architecture-contract.mjs";
import { architectureReviewEvidenceContext } from "../../src/architecture/architecture-review-evidence.mjs";
import { requestJevDecision } from "../../src/requirements/providers.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import { validDesign, passingReview } from "../helpers/architecture.mjs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchitectureDesigner } from "../../src/architecture/architecture.mjs";
import { validateReview } from "../../src/architecture/architecture-contract.mjs";
import { fidelityChecker } from "../helpers/fidelity.mjs";
import { createMainReviewCheckpoint, readMainReviewCheckpoint } from "../../src/architecture/architecture-main-review-checkpoint.mjs";
import { createArchitectureFeedbackLedger, closeArchitectureFeedbackByJudgment } from "../../src/architecture/architecture-feedback-ledger.mjs";
import { createPlatformSnapshot } from "../../src/architecture/platform-contract.mjs";
import { completeArchitectureReviewWaiver, runArchitectureReviewRevision, readArchitectureReviewRevision, architectureReviewRevisionRecovery } from "../../src/architecture/architecture-review-revision.mjs";
import { createReviewProgressCheckpoint } from "../../src/architecture/architecture-review-progress.mjs";
import { designSubmissionSchema, validateDesign } from "../../src/architecture/architecture-contract.mjs";
import type { UnknownRecord } from "../../src/contracts/json.mjs";
import { architecturePriorFindings, validateArchitecturePriorFindings } from "../../src/architecture/architecture-prior-findings.mjs";

function fixture() {
  const requirements = [{ id: "R1", text: "统计整数数组，3.0 按数值整数接受" }];
  const design = validDesign(requirements, { schemaVersion: 3, connections: [],
    interaction: { defaultEntry: "conversation", page: false, operations: false, inputs: "原始记录", results: "核对结果", persistentData: "无" },
    execution: { language: "none", hosting: "builtin", reason: "本地测试文本候选" },
    selectionBasis: { capacity: "本轮输入", process: "逐项核对", quality: "保留原文", requirementIds: ["R1"], assumptions: [] } });
  design.acceptance.forEach(row => { row.requirementIds = ["R1"]; });
  design.acceptance[0]!.input = '{"numbers":[-1000,-500,0,500,1000,-1,1,-2,2,-3,3,-4,4,-5,5,-6,6,-7,7,0]}';
  const candidateHash = designHash(design), context = architectureReviewEvidenceContext({ design, requirements, runtimeCapabilities: {}, evidence: [] });
  const group = (id: string, checkId: string, passed: boolean): JudgmentGroup => ({ id, assignment: { field: "checks", ids: [checkId] }, parts: {
    candidateHash, checks: [{ id: checkId, passed, evidence: passed ? "已核对本组" : "本组提出一项需要核实的阻塞" }],
    issues: passed ? [] : [{ id: `${id}_defect`, checkId, kind: "design", blocking: true,
      description: "本组认为组件还需补充明确输入边界", remedy: "核对已确认的输入范围", candidatePaths: ["/components/0"],
      references: [{ source: "candidate", path: "/components/0" }] }], acceptanceScopeChecks: [], priorFindingDecisions: [],
  } });
  let checkpoint: ReviewJudgmentCheckpoint | undefined;
  const options = { config: { jevApiKey: "fixture-only", jevModel: "jev-1.14.0" }, candidateHash, context,
    groups: [group("interfaces", "interfaces", false)],
    validate: (_group: JudgmentGroup, parts: ReviewParts) => canonicalArchitectureReviewParts(parts, {
      schema: reviewSubmissionSchema({ evidenceRequired: true }), candidateHash, context }),
    save: async (value: ReviewJudgmentCheckpoint) => { checkpoint = structuredClone(value); },
  };
  return { options, group, saved: () => checkpoint! };
}
const scored = (level: number) => ({ type: "score", score: level, confidence: 1,
  probabilities: Object.fromEntries([0, 1, 2, 3, 4].map(n => [n, n === level ? 1 : 0])) });
const response = (necessity: number, strictness: number, basis = "supported") => ({ model: "jev-1.14.0", answers: {
  necessity: scored(necessity), strictness: scored(strictness), basis: { type: "choice", choice: basis,
    probabilities: Object.fromEntries(["supported", "contradicted", "unproven"].map(key => [key, key === basis ? 1 : 0])) } }, usage: { input_tokens: 100, output_tokens: 12 } });

test("每组独立判定：评审通过不请求JEV；过严意见可撤销，真实缺陷仍阻止整体通过", async () => {
  const f = fixture(), groups = [f.group("requirements", "requirements", true), f.group("interfaces", "interfaces", false),
    f.group("failure", "failure_handling", false), f.group("minimality", "minimality", false)];
  const original = structuredClone(groups), calls: string[] = [];
  const run = (checkpoint?: unknown) => judgeArchitectureReviewGroups({ ...f.options, groups, checkpoint,
    request: async args => {
      const state = objectFields(args.state), id = String(state.groupId); calls.push(id);
      await args.onAttempt(1);
      assert.equal(f.saved().groups[id]!.rounds[0]!.receipts["issues/0"]!.attempts, 1, "发送前持久记录实际调用");
      assert.equal((state.programFacts as { sum: number }[])[0]!.sum, 0, "实际输入由程序计算而非复述评审意见");
      return id === "interfaces" ? response(1, 3) : id === "failure" ? response(3, 1) : response(2, 0);
    } });
  const result = await run();
  assert.deepEqual(calls, ["interfaces", "failure", "minimality"]);
  assert.deepEqual(result.approvals, [{ groupId: "requirements", by: "reviewer", status: "pass" },
    { groupId: "interfaces", by: "jev", status: "pass" }, { groupId: "failure", by: "jev", status: "revise" },
    { groupId: "minimality", by: "jev", status: "pass" }]);
  assert.equal(result.review.verdict, "revise");
  assert.equal(result.parts.checks.find(row => row.id === "failure_handling")!.passed, false);
  assert.deepEqual(groups, original, "原报告不改写");
  await run(f.saved()); assert.equal(calls.length, 3, "恢复复用已完成评分，不重领调用");
});

test("合法评分只有通过或打回：灰区、分歧、低置信和依据不确定不再产生暂停", async () => {
  const split = response(2, 0);
  split.answers.necessity = { type: "score", score: 2, confidence: 0, probabilities: { 0: .5, 1: 0, 2: 0, 3: 0, 4: .5 } };
  const gray = response(2, 1);
  gray.answers.necessity = { type: "score", score: 2.8, confidence: .1, probabilities: { 0: 0, 1: 0, 2: .2, 3: .8, 4: 0 } };
  const actualSplit = response(2, 2);
  actualSplit.answers.necessity = { type: "score", score: 2.03, confidence: .07, probabilities: { 0: .04, 1: .41, 2: .13, 3: .32, 4: .1 } };
  actualSplit.answers.basis.probabilities = { supported: .7, contradicted: .04, unproven: .26 };
  for (const [label, answer, verdict] of [
    ["分布两端", split, "pass"], ["原60至75分灰区", gray, "pass"], ["第27版同类分歧", actualSplit, "pass"],
    ["达到打回门槛", response(3, 1), "revise"], ["过严分达到50", response(3, 2), "pass"],
    ["过严意见", response(4, 4), "pass"], ["依据不确定且低必要分", response(0, 4, "unproven"), "pass"],
    ["依据不确定但高必要分", response(3, 1, "unproven"), "revise"],
  ] as const) {
    const f = fixture(); let requests = 0;
    const result = await judgeArchitectureReviewGroups({ ...f.options, request: async args => {
      requests++; await args.onAttempt(1); return answer;
    } });
    assert.equal(result.review.verdict, verdict, label);
    assert.equal(result.checkpoint.groups.interfaces!.rounds[0]!.receipts["issues/0"]!.assessment!.route, verdict, label);
    assert.equal(requests, 1); assert.equal(result.checkpoint.groups.interfaces!.rounds.length, 1);
    assert.equal(result.checkpoint.groups.interfaces!.recheckCalls, 0);
    await judgeArchitectureReviewGroups({ ...f.options, checkpoint: result.checkpoint, request: async () => assert.fail("不重复评分") });
  }
});

test("具体意见也取得完整相关业务职责；非本条负评片段不再混入判定", async () => {
  const f = fixture(), group = f.options.groups[0]!;
  group.parts.issues.push({ ...group.parts.issues[0]!, id: "separate", candidatePaths: ["/instructions"],
    references: [{ source: "candidate", path: "/instructions" }] });
  let requests = 0;
  await judgeArchitectureReviewGroups({ ...f.options, request: async args => {
    await args.onAttempt(1); requests++;
    const state = objectFields(args.state), materials = state.materials as { source: string; path: string; value: unknown }[];
    assert.deepEqual(materials.find(row => row.source === "candidate" && row.path === "/components")!.value, f.options.context.candidate.components);
    assert.deepEqual(materials.find(row => row.source === "candidate" && row.path === "/steps")!.value, f.options.context.candidate.steps);
    if (requests === 1) assert.equal(materials.some(row => row.path === "/instructions"), false);
    assert.equal(materials.some(row => row.path === "/components/0"), false, "已提供整段时不再重复负评片段");
    return response(1, 4);
  } });
  assert.equal(requests, 2);
});

test("主题、验收和历史分项的合法评分都能组成通过或打回报告，不以缺少另写意见要求补查", async () => {
  for (const field of ["checks", "acceptanceScopeChecks", "priorFindingDecisions"] as const) {
    for (const shouldPass of [false, true]) {
      const f = fixture(), candidate = f.options.context.candidate;
      const complete = validateReview(passingReview(f.options.candidateHash, candidate), {
        candidateHash: f.options.candidateHash, schemaVersion: 3, evidenceContext: f.options.context });
      const priorFindings = field === "priorFindingDecisions" ? architecturePriorFindings({ version: 1,
        candidateHash: f.options.candidateHash, review: { issues: f.options.groups[0]!.parts.issues } }, {
        candidateHash: f.options.candidateHash, contextManifestHash: designHash(f.options.context.contextManifest),
        guideHash: objectFields(f.options.context.contextManifest.acceptanceAdapterGuide).sha256,
      }, { candidate, evidenceContext: f.options.context }) : undefined;
      const findingId = String(priorFindings?.findings[0]?.findingId);
      const parts: ReviewParts = { candidateHash: f.options.candidateHash, checks: complete.checks, issues: [],
        acceptanceScopeChecks: complete.acceptanceScopeChecks!, priorFindingDecisions: priorFindings ? [{
          findingId, status: "unresolved", reason: "原评审仍要求补充接口细节", checkIds: ["interfaces"], candidatePaths: ["/components/0"],
        }] : [] };
      if (field === "checks") Object.assign(parts.checks[0]!, { passed: false, evidence: "原评审认为遗漏业务输入范围" });
      if (field === "acceptanceScopeChecks") Object.assign(parts.acceptanceScopeChecks[0]!, { sufficient: false, reason: "原评审认为验证方向不能覆盖业务结果" });
      const groups: JudgmentGroup[] = [{ id: "all", assignment: { field, ids: [] }, parts }];
      const result = await judgeArchitectureReviewGroups({ ...f.options, groups, priorFindings,
        validate: (_group, value) => canonicalArchitectureReviewParts(value, { schema: reviewSubmissionSchema({
          evidenceRequired: true, priorFindingsRequired: Boolean(priorFindings) }), candidateHash: f.options.candidateHash,
          context: f.options.context, priorFindings }),
        request: async args => { await args.onAttempt(1); return shouldPass ? response(1, 4) : response(3, 1); },
      });
      assert.equal(result.review.verdict, shouldPass ? "pass" : "revise", field);
      assert.equal(validateReview(result.review, { candidateHash: f.options.candidateHash, schemaVersion: 3,
        evidenceContext: f.options.context }).verdict, result.review.verdict);
      if (priorFindings) validateArchitecturePriorFindings(result.review, priorFindings, candidate, { evidenceContext: f.options.context });
      if (priorFindings && shouldPass) {
        assert.equal(result.review.priorFindingDecisions![0]!.status, "unsupported", "撤销意见不冒充已经修改设计");
        assert.equal(result.review.issues.find(issue => issue.id === findingId)!.blocking, false);
      }
    }
  }
});

test("JEV格式失败连续三次单独保存，恢复不清零；模型或材料改变不能复用旧评分", async () => {
  const f = fixture(); let calls = 0;
  await assert.rejects(judgeArchitectureReviewGroups({ ...f.options,
    request: async args => { calls++; await args.onAttempt(1); return { answers: {} }; } }), /连续三次/);
  const saved = f.saved(), receipt = saved.groups.interfaces!.rounds[0]!.receipts["issues/0"]!;
  assert.equal(receipt.attempts, 3); assert.equal(receipt.formatFailures, 3); assert.equal(calls, 3);
  await assert.rejects(judgeArchitectureReviewGroups({ ...f.options, checkpoint: saved, request: async () => assert.fail("不得重新领取") }), /连续三次/);
  await assert.rejects(judgeArchitectureReviewGroups({ ...f.options, checkpoint: saved, config: { ...f.options.config, jevModel: "different" } }), /不符/);
  await assert.rejects(judgeArchitectureReviewGroups({ ...f.options, checkpoint: saved, context: { ...f.options.context, requirements: [] } }), /不符/);
});

test("旧评分规则停点保留报告、原会话和全部用量，按新阶段边界续判且中断后不重复迁移", async () => {
  const f = fixture(), old = JSON.parse(await readFile(new URL("../fixtures/architecture-group-jev-v1.json", import.meta.url), "utf8")) as {
    candidateHash: string; context: typeof f.options.context; groups: JudgmentGroup[]; checkpoint: ReviewJudgmentCheckpoint;
    formatCheckpoint: ReviewJudgmentCheckpoint };
  const v2 = JSON.parse(await readFile(new URL("../fixtures/architecture-group-jev-v2.json", import.meta.url), "utf8")) as { checkpoint: ReviewJudgmentCheckpoint };
  v2.checkpoint.previousPolicy = structuredClone(old.checkpoint);
  const options = { ...f.options, candidateHash: old.candidateHash, context: old.context, groups: old.groups,
    validate: (_group: JudgmentGroup, parts: ReviewParts) => canonicalArchitectureReviewParts(parts, {
      schema: reviewSubmissionSchema({ evidenceRequired: true }), candidateHash: old.candidateHash, context: old.context }) };
  for (const source of [structuredClone(old.checkpoint), v2.checkpoint]) {
    const original = structuredClone(source);
    let calls = 0;
    await assert.rejects(judgeArchitectureReviewGroups({ ...options, checkpoint: source, request: async args => {
      calls++; await args.onAttempt(1);
      assert.deepEqual(f.saved().previousPolicy, source, "发送前已完整保存旧评分依据");
      assert.equal(f.saved().groups.interfaces!.recheckCalls, 8);
      assert.equal(f.saved().groups.interfaces!.rounds[1]!.receipts["issues/0"]!.attempts, source.groups.interfaces!.rounds[1]!.receipts["issues/0"]!.attempts + 1);
      assert.match(String(objectFields(args.state).architectureScope), /这个事实本身不足以支持打回/);
      assert.match(String(objectFields(objectFields(args.questions).necessity).instructions), /研发设计/);
      throw new Error("连接中断");
    } }), /连接中断/);
    const interrupted = f.saved();
    const result = await judgeArchitectureReviewGroups({ ...options, checkpoint: interrupted, request: async args => {
      calls++; await args.onAttempt(1); return response(1, 4);
    } });
    assert.equal(result.review.verdict, "pass");
    assert.equal(calls, 3, "只对最新报告两条意见重判，额外保留失败请求");
    assert.equal(result.checkpoint.version, 3);
    assert.deepEqual(result.checkpoint.previousPolicy, source);
    assert.deepEqual(source, original, "输入检查点未被改写");
    const current = result.checkpoint.groups.interfaces!, previous = source.groups.interfaces!;
    assert.equal(current.recheckCalls, 8); assert.equal(current.recheckSession, previous.recheckSession);
    assert.deepEqual(current.rounds.map(round => round.parts), previous.rounds.map(round => round.parts));
    assert.deepEqual(current.rounds[0], previous.rounds[0], "已被补查替代的原评分留存，不重复请求");
    assert.equal(current.rounds.flatMap(round => Object.values(round.receipts)).reduce((n, r) => n + r.attempts, 0),
      previous.rounds.flatMap(round => Object.values(round.receipts)).reduce((n, r) => n + r.attempts, 0) + 3);
    for (const [key, receipt] of Object.entries(previous.rounds[1]!.receipts))
      assert.deepEqual(current.rounds[1]!.receipts[key]!.responses.slice(0, receipt.responses.length), receipt.responses);
    await judgeArchitectureReviewGroups({ ...options, checkpoint: result.checkpoint,
      request: async () => assert.fail("新规则已完成的评分直接复用") });
    const corrupt = structuredClone(result.checkpoint);
    corrupt.groups.interfaces!.rounds[1]!.receipts["issues/0"]!.attempts = 0;
    const { hash: _hash, ...body } = corrupt; corrupt.hash = designHash(body);
    await assert.rejects(judgeArchitectureReviewGroups({ ...options, checkpoint: corrupt,
      request: async () => assert.fail("不可刷新原用量") }), /丢失原用量/);
  }
  await assert.rejects(judgeArchitectureReviewGroups({ ...options, checkpoint: old.formatCheckpoint,
    request: async () => assert.fail("旧三次格式错误不因规则升级清零") }), /连续三次/);
  assert.equal(f.saved().groups.interfaces!.rounds[0]!.receipts["issues/0"]!.formatFailures, 3);
});

test("JEV连接失败使用既有传输重试，每次真实请求先记账；凭据不进入业务状态", async () => {
  let attempts = 0, fetched = 0;
  const result = await requestJevDecision({ config: { jevApiKey: "fixture-only" }, state: { groupId: "g1" }, questions: {},
    onAttempt: async () => { attempts++; }, fetchImpl: async (_url, init) => {
      fetched++; assert.equal(attempts, fetched); assert.equal(JSON.parse(String(init?.body)).state.groupId, "g1");
      assert.doesNotMatch(String(init?.body), /fixture-only/);
      if (fetched === 1) throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
      return new Response(JSON.stringify(response(0, 0)));
    } });
  assert.equal(fetched, 2); assert.equal(objectFields(result).model, "jev-1.14.0");
});

test("撤销旧修订只关闭同一原问题，保留原反馈与正文锚点，遗漏的历史问题仍拦住", async () => {
  const f = fixture(), original = f.options.groups[0]!.parts;
  const source = { agentId: "old", version: 24, candidateHash: f.options.candidateHash, design: f.options.context.candidate,
    review: { ...original, verdict: "revise", summary: "原评审" } };
  const ledger = createArchitectureFeedbackLedger(source, { ...f.options.context, agentId: "old" });
  const before = structuredClone(ledger);
  const result = await judgeArchitectureReviewGroups({ ...f.options, request: async args => { await args.onAttempt(1); return response(1, 4); } });
  const closed = closeArchitectureFeedbackByJudgment(ledger, source, result.review, result.checkpoint, f.options.context);
  assert.equal(closed.findings[0]!.closure!.status, "unsupported");
  assert.ok(closed.findings[0]!.closure!.anchors.length); assert.deepEqual(ledger, before);
  const unrelated = { ...source, review: { ...source.review, issues: [...original.issues, { ...original.issues[0]!, id: "unrelated", description: "另一项未复核缺陷" }] } };
  const more = createArchitectureFeedbackLedger(unrelated, { ...f.options.context, agentId: "old" });
  assert.throws(() => closeArchitectureFeedbackByJudgment(more, source, result.review, result.checkpoint, f.options.context), /未被本次/);
  assert.throws(() => closeArchitectureFeedbackByJudgment(ledger, source, result.review, null, f.options.context), /完整通过/);
});

test("旧修订撤销后继续范围评审：原检查点和调用完整保留，不重新进入修订或刷新评审次数", async () => {
  const f = fixture(), requirements = f.options.context.requirements;
  const candidate = validateDesign(f.options.context.candidate, { requirements });
  const draft = { taskSpec: { version: 1 } }, candidateHash = f.options.candidateHash;
  const review = validateReview(passingReview(candidateHash, candidate), { candidateHash, schemaVersion: 3, evidenceContext: f.options.context });
  review.verdict = "revise"; review.checks.find(row => row.id === "interfaces")!.passed = false;
  review.issues = structuredClone(f.options.groups[0]!.parts.issues);
  const progress = { schemaVersion: 1, pipelineId: "original-pipeline", modelCalls: 15 };
  const source = { agentId: "waiver", version: 8, status: "failed", sourceFingerprint: "same", draft, requirements,
    platformHash: "a".repeat(64), runtimeCapabilities: {}, evidence: [], researchGaps: [], designResearchCalls: 0,
    designProgressCheckpoint: { ...progress, hash: designHash(progress) }, candidateHash, design: candidate, review, issues: review.issues,
    attempts: [{ candidateHash, design: candidate, review, issues: review.issues }] };
  const record: UnknownRecord = { ...structuredClone(source), version: 9, design: null, candidateHash: null, review: null, attempts: [], reviewRequestPolicy: "task_rejections" };
  const run = () => runArchitectureReviewRevision({ record, source, candidateSchema: designSubmissionSchema(draft, { requirements }),
    sessionDirectory: "/tmp/neuma-waiver-unit", validate: value => validateDesign(value, { requirements }), onSave: async () => {},
    runRole: async node => { await node.onSessionRef({ file: "original.jsonl" }); await node.onModelCall(); throw new Error("连接中断"); } });
  await assert.rejects(run(), /连接中断/);
  const original = structuredClone(record.reviewRevisionCheckpoint);
  const fullParts: ReviewParts = { candidateHash, checks: review.checks, issues: review.issues, acceptanceScopeChecks: review.acceptanceScopeChecks!, priorFindingDecisions: [] };
  const judged = await judgeArchitectureReviewGroups({ ...f.options, groups: [{ id: "checks", assignment: { field: "checks", ids: review.checks.map(row => row.id) }, parts: { ...fullParts, acceptanceScopeChecks: [] } },
    { id: "acceptance", assignment: { field: "acceptanceScopeChecks", ids: review.acceptanceScopeChecks!.map(row => row.acceptanceId) }, parts: { ...fullParts, checks: [], issues: [] } }],
    request: async args => { await args.onAttempt(1); return response(1, 4); } });
  record.reviewRevisionJudgment = judged.checkpoint;
  record.reviewRevisionCheckpoint = completeArchitectureReviewWaiver(record, candidate, judged.review);
  const waived = readArchitectureReviewRevision(record)!;
  assert.equal(waived.schemaVersion, 3); assert.equal(waived.modelCalls, 1); assert.deepEqual(waived.previousCheckpoint, original);
  assert.deepEqual(await run(), candidate, "撤销只保留原稿，不请求模型生成假修复");
  record.design = candidate; record.candidateHash = candidateHash;
  record.reviewProgressCheckpoint = createReviewProgressCheckpoint(record, null, 6);
  assert.ok(record.reviewProgressCheckpoint);
  const recovery = architectureReviewRevisionRecovery(record, true)!;
  assert.equal(recovery.stage, "evaluating"); assert.equal(recovery.modelCalls, 6);
  assert.throws(() => readArchitectureReviewRevision({ ...record, reviewRevisionJudgment: null }), /无法核验/);
});

test("小组汇总替代主模型重审，零主评审调用可持久恢复，但独立范围复核仍能阻断", async t => {
  const f = fixture(), root = await mkdtemp(join(tmpdir(), "neuma-group-judgment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const complete = validateReview(passingReview(f.options.candidateHash, f.options.context.candidate), {
    candidateHash: f.options.candidateHash, schemaVersion: 3, evidenceContext: f.options.context });
  const platformSnapshot = createPlatformSnapshot({ allowNetwork: false });
  const parts: ReviewParts = { candidateHash: complete.candidateHash, checks: complete.checks, issues: complete.issues,
    acceptanceScopeChecks: complete.acceptanceScopeChecks!, priorFindingDecisions: [] };
  const result = await judgeArchitectureReviewGroups({ ...f.options,
    groups: [{ id: "checks", assignment: { field: "checks", ids: parts.checks.map(row => row.id) }, parts: { ...parts, acceptanceScopeChecks: [] } },
      { id: "acceptance", assignment: { field: "acceptanceScopeChecks", ids: parts.acceptanceScopeChecks.map(row => row.acceptanceId) }, parts: { ...parts, checks: [] } }],
    request: async () => assert.fail("通过的小组不应额外调用JEV") });
  const record = { agentId: "group_fixture", version: 1, sourceFingerprint: "confirmed", draft: {}, requirements: f.options.context.requirements,
    design: f.options.context.candidate, candidateHash: complete.candidateHash, reviewRequestPolicy: "task_rejections",
    reviewJudgmentCheckpoint: result.checkpoint };
  const saved = createMainReviewCheckpoint(record, result.review, 0);
  assert.ok(saved); assert.equal(readMainReviewCheckpoint({ ...record, mainReviewCheckpoint: saved })!.modelCalls, 0);
  assert.equal(readMainReviewCheckpoint({ ...record, reviewJudgmentCheckpoint: null, mainReviewCheckpoint: saved }), null);
  const afterReading = createMainReviewCheckpoint(record, result.review, 2);
  assert.equal(readMainReviewCheckpoint({ ...record, mainReviewCheckpoint: afterReading })!.modelCalls, 2);
  assert.equal(readMainReviewCheckpoint({ ...record, reviewJudgmentCheckpoint: null, mainReviewCheckpoint: afterReading }), null,
    "范围复核已有调用后仍须核验原小组判定凭据");
  for (const outcome of ["preserved", "narrowed"]) {
    let fidelityCalls = 0;
    const designer = new ArchitectureDesigner({ config: {}, cwd: root, dataDir: root,
      sessionFactory: async () => assert.fail("汇总不再新建主评审模型会话"),
      fidelitySessionFactory: fidelityChecker(outcome, { inspect: () => { fidelityCalls++; } }) });
    const run = designer.role({ role: "reviewer", systemPrompt: "程序汇总", assembledReview: result.review,
      payload: { ...f.options.context, design: f.options.context.candidate, candidateHash: complete.candidateHash, requireAcceptanceVerification: true,
        platformSnapshot, platformHash: designHash(platformSnapshot), platformContractVersion: platformSnapshot.version },
      submitName: "submit_architecture_review", parameters: reviewSubmissionSchema({ evidenceRequired: true }),
      reviewEvidenceContext: f.options.context,
      validate: value => validateReview(value, { candidateHash: complete.candidateHash, schemaVersion: 3, evidenceContext: f.options.context }) });
    if (outcome === "preserved") assert.equal((await run).verdict, "pass");
    else await assert.rejects(run, /范围|scope/);
    assert.equal(fidelityCalls, 1);
  }
});
