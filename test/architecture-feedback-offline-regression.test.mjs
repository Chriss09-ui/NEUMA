import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DevelopmentExecutor } from "../src/development/development-executor.mjs";
import { inspectDevelopmentCode } from "../src/development/development-workspace.mjs";
import { resolveTestJson } from "../src/development/development-fixtures.mjs";
import { createPlatformContractTool } from "../src/architecture/architecture-platform-claims.mjs";
import { ACCEPTANCE_ADAPTER_GUIDE } from "../src/verification/acceptance-contract.mjs";
import { historicalRepairSnapshot, validateHistoricalRepairDecision } from "../src/architecture/architecture-repair-evidence.mjs";
import { architectureReviewEvidenceContext } from "../src/architecture/architecture-review-evidence.mjs";
import { designHash } from "../src/architecture/architecture-contract.mjs";
import { ArchitectureDesigner } from "../src/architecture/architecture.mjs";
import { developmentRevisionReference, readHistoricalPlanningReference } from "../src/architecture/architecture-development-revision.mjs";
import { hashValue } from "../src/development/development-contract.mjs";
import { validDesign, passingReview, validDraft } from "./helpers/architecture.mjs";
import { fidelityChecker } from "./helpers/fidelity.mjs";
import { createArchitectureStageSessionFactory } from "./helpers/architecture-stages.mjs";

const recorded = JSON.parse(await readFile(new URL("./fixtures/architecture-feedback-recorded-defect.json", import.meta.url), "utf8"));
const object = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const integer = { type: "integer" }, text = { type: "string" };
const resultSchema = object({ approvedCount: integer, approvedAmountCents: integer, unapprovedCount: integer });
const manifest = { protocolVersion: 2, runtime: "node-action", entrypoint: "actions.mjs", page: null, stateVersion: 1, evidenceIds: [],
  actions: [{ id: "reconcile", title: "核对", connectionIds: [], inputSchema: object({ records: { type: "array", maxItems: 20,
    items: object({ approved: { type: "boolean" }, amountCents: integer }) } }), outputSchema: object({ result: resultSchema, jsonContent: text, csvContent: text }) }] };
const digest = (value) => createHash("sha256").update(value).digest("hex");
const writeMock = (file, content) => ({ capability: "files.write", argsJson: JSON.stringify({ file, content }),
  resultJson: JSON.stringify({ saved: true, file, characters: content.length,
    integrity: { bytes: Buffer.byteLength(content), utf16Units: content.length, sha256: digest(content) } }) });
function executableCase(sample, { placeholder = false } = {}) {
  return { id: sample.id, actionId: "reconcile", input: JSON.stringify(sample.input),
    mocks: [writeMock("result.json", placeholder ? "<computed-result-json>" : sample.jsonContent),
      writeMock("result.csv", placeholder ? "<computed-csv-content>" : sample.csvContent)],
    assertions: [{ path: "", expectedJson: JSON.stringify({ result: sample.result, jsonContent: sample.jsonContent, csvContent: sample.csvContent }) }] };
}

function historicalRepair({ fixed = false, platformExpected = false } = {}) {
  const raw = recorded.unchangedDecision;
  const original = validDesign([], { schemaVersion: 3 });
  original.decisions.push({ id: raw.oldId, problem: raw.problem, choice: raw.choice, reason: raw.reason,
    alternatives: [{ option: "固定明确数据", reason: "公开记录中相同错误机制的最小回放" }], evidenceIds: [], uncertainties: [] });
  const candidate = structuredClone(original);
  candidate.decisions.unshift({ ...structuredClone(candidate.decisions[0]), id: "unrelated_reordering" });
  const decision = candidate.decisions[2]; decision.id = fixed ? raw.oldId : raw.newId;
  if (fixed) decision.choice = "每个用例独立冻结精确JSON和CSV文本及其真实字节摘要；夹具仅构造明确数据，files.write继续严格匹配。";
  candidate.platformClaims = [{ id: "fixture_support", source: "acceptanceAdapterGuide",
    path: "/adapters/action/executionFacts/dynamicPlaceholders", expected: platformExpected, decisionIds: [decision.id], acceptanceIds: [] }];
  const finding = { findingId: "finding_recorded_mock_contract", kind: "historical-development-review",
    repairBasis: historicalRepairSnapshot(original, ["/decisions/1/choice"]) };
  const row = { findingId: finding.findingId, status: "resolved", checkIds: ["verification"],
    candidatePaths: ["/decisions/2/choice"], reason: "按当前来源核实本次修改，不继承历史通过" };
  const review = passingReview(designHash(candidate), candidate);
  review.issues.push({ id: finding.findingId, blocking: false, kind: "design", checkId: "verification",
    description: "原意见及建议只是历史判断；本轮用当前候选和公开事实重新核对。", remedy: "保留严格匹配与独立固定预期，不使用未实现的动态计算。",
    candidatePaths: row.candidatePaths, factClaims: [], references: [
      { source: "candidate", path: row.candidatePaths[0], quote: decision.choice },
      { source: "acceptanceAdapterGuide", path: "/adapters/action/executionFacts/dynamicPlaceholders", quote: "false" },
    ] });
  const context = architectureReviewEvidenceContext({ design: candidate, requirements: [], runtimeCapabilities: null });
  return { original, candidate, finding, row, review, context,
    validate: () => validateHistoricalRepairDecision(row, finding, review, candidate, context) };
}

test("公开记录D8换成D9且换位置，错误choice原样保留时不得声称修复", () => {
  const f = historicalRepair(), before = structuredClone(f.candidate);
  assert.equal(f.original.decisions[1].choice, recorded.unchangedDecision.choice);
  assert.equal(f.candidate.decisions[2].choice, recorded.unchangedDecision.choice);
  assert.notEqual(designHash(f.original), designHash(f.candidate));
  assert.throws(f.validate, (error) => error.validationIssue.reason === "repair_basis_unchanged");
  assert.deepEqual(f.candidate, before, "拒绝假关闭不能自动改写候选或替它生成修改");
});

test("只改方案文字仍不能用旧评审建议冒充平台能力；正确事实和具体修订才可通过来源门槛", () => {
  const invented = historicalRepair({ fixed: true, platformExpected: true });
  assert.throws(invented.validate, (error) => error.validationIssue.reason === "platform_fact_mismatch");
  const missing = historicalRepair({ fixed: true }); delete missing.candidate.platformClaims;
  missing.context = architectureReviewEvidenceContext({ design: missing.candidate, requirements: [], runtimeCapabilities: null });
  assert.throws(() => validateHistoricalRepairDecision(missing.row, missing.finding, missing.review, missing.candidate, missing.context),
    (error) => error.validationIssue.reason === "repair_platform_basis_missing");
  const correct = historicalRepair({ fixed: true });
  assert.doesNotThrow(correct.validate, "程序核实相关改动与当前来源；语义是否充分仍由独立评审负责");
});

test("保留旧错误却改报无关新增决策，真实平台引文也不能冒充相关修复", () => {
  const f = historicalRepair();
  f.row.candidatePaths = ["/decisions/0/choice"];
  f.candidate.platformClaims[0].decisionIds = [f.candidate.decisions[0].id];
  f.review.issues[0].candidatePaths = f.row.candidatePaths;
  f.review.issues[0].references[0] = { source: "candidate", path: f.row.candidatePaths[0], quote: f.candidate.decisions[0].choice };
  const context = architectureReviewEvidenceContext({ design: f.candidate, requirements: [], runtimeCapabilities: null });
  assert.equal(f.candidate.decisions[2].choice, recorded.unchangedDecision.choice);
  assert.throws(() => validateHistoricalRepairDecision(f.row, f.finding, f.review, f.candidate, context),
    (error) => ["repair_candidate_basis_unrelated", "repair_basis_unchanged"].includes(error.validationIssue.reason));
});

async function controllerFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "neuma-feedback-first-prompt-"));
  const draft = validDraft();
  draft.taskSpec = { version: 1, items: [{ id: "complete", dimension: "processing", content: "完整核对用户提供的记录", applicability: "applies", critical: true,
    source: { kind: "user", evidence: [{ messageId: "source", quote: "完整核对用户提供的记录" }] } }] };
  const input = { id: "recorded_feedback_agent", name: "离线反馈回归", fingerprint: "same-business-source", draft };
  const state = { mode: "initial", payloads: [], fixtureResponses: 0 };
  const stages = createArchitectureStageSessionFactory((payload) => {
    const design = validDesign(payload.requirements, { schemaVersion: 3, profile: "custom", connections: [],
      interaction: { defaultEntry: "conversation", page: false, operations: true, inputs: "用户记录", results: "完整结果", persistentData: "无" },
      execution: { language: "javascript", hosting: "builtin", reason: "确定性处理" },
      selectionBasis: { capacity: "保留全部输入边界", process: "逐项处理", quality: "独立核对", requirementIds: payload.requirements.map((row) => row.id), assumptions: [] } });
    const raw = recorded.unchangedDecision;
    design.decisions.push({ id: raw.oldId, problem: raw.problem, choice: raw.choice, reason: raw.reason,
      alternatives: [{ option: "明确冻结预期", reason: "最小历史错误回放" }], evidenceIds: [], uncertainties: [] });
    return design;
  }, { onPrompt: ({ stage, payload }) => {
    assert.equal(state.mode, "initial", "已有完整旧候选的技术修订继续走受控局部修订入口");
    state.payloads.push({ designer: false, stage, payload }); state.fixtureResponses++;
  } });
  const designer = new ArchitectureDesigner({ config: { llmConfigured: true }, cwd: root, dataDir: join(root, "data"), fidelitySessionFactory: fidelityChecker(),
    sessionFactory: async (options) => {
      const stage = await stages(options); if (stage) return stage;
      const { customTools } = options;
      const tools = Object.fromEntries(customTools.map((tool) => [tool.name, tool]));
      return { messages: [], modelCallAccounting: true, subscribe: () => () => {}, dispose() {}, abort() {}, async prompt(text) {
        await options.onModelCall();
        const payload = JSON.parse(text);
        state.payloads.push({ designer: Boolean(tools.submit_architecture), payload });
        if (state.mode === "capture") {
          assert.ok(tools.submit_architecture);
          throw new Error("Controlled offline fixture captured the first input before any model request");
        }
        state.fixtureResponses++;
        if (tools.submit_architecture) {
          if (state.mode !== "initial") {
            const design = structuredClone(payload.previousDesign), decision = design.decisions[1];
            decision.id = recorded.unchangedDecision.newId;
            if (state.mode === "fixed") decision.choice = "逐用例冻结独立的精确JSON/CSV原文及其完整性数据，保留严格匹配；公开夹具仅构造明确数据。";
            design.platformClaims = [{ id: "fixture_support", source: "acceptanceAdapterGuide",
              path: "/adapters/action/executionFacts/dynamicPlaceholders", expected: false, decisionIds: [decision.id], acceptanceIds: [] }];
            return tools.submit_architecture.execute("fixture-revision", design);
          }
          const design = validDesign(payload.requirements, { schemaVersion: 3, profile: "custom", connections: [],
            interaction: { defaultEntry: "conversation", page: false, operations: true, inputs: "用户记录", results: "完整结果", persistentData: "无" },
            execution: { language: "javascript", hosting: "builtin", reason: "确定性处理" },
            selectionBasis: { capacity: "保留全部输入边界", process: "逐项处理", quality: "独立核对", requirementIds: payload.requirements.map((row) => row.id), assumptions: [] } });
          const raw = recorded.unchangedDecision;
          design.decisions.push({ id: raw.oldId, problem: raw.problem, choice: raw.choice, reason: raw.reason,
            alternatives: [{ option: "明确冻结预期", reason: "最小历史错误回放" }], evidenceIds: [], uncertainties: [] });
          return tools.submit_architecture.execute("fixture-design", design);
        }
        // Reconstruct a historical wrong approval; this synthetic answer is not evidence that the old design is feasible.
        const review = passingReview(payload.candidateHash, payload.design, payload.priorFindings);
        if (state.mode !== "initial") for (const row of review.priorFindingDecisions ?? []) {
          row.status = "resolved"; row.checkIds = ["verification"]; row.candidatePaths = ["/decisions/1/choice"];
          review.issues.push({ id: row.findingId, blocking: false, kind: "design", checkId: "verification",
            description: "分别核对历史问题与错误建议，按当前平台事实修订。", remedy: "保留严格匹配和独立冻结数据，不创建动态占位能力。",
            candidatePaths: row.candidatePaths, factClaims: [], references: [
              { source: "candidate", path: row.candidatePaths[0], quote: payload.design.decisions[1].choice },
              { source: "acceptanceAdapterGuide", path: "/adapters/action/executionFacts/dynamicPlaceholders", quote: "false" },
            ] });
        }
        return tools.submit_architecture_review.execute("fixture-historical-review", review);
      } };
    } });
  t.after(async () => { await designer.persistence; await rm(root, { recursive: true, force: true }); });
  const original = await designer.design(input);
  assert.equal(original.status, "passed"); assert.equal(state.fixtureResponses, 4);
  assert.deepEqual(state.payloads.map((entry) => entry.stage ?? (entry.designer ? "designer" : "reviewer")),
    ["blueprint", "module", "integration", "reviewer"]);
  const ref = (architecture) => ({ version: architecture.version, candidateHash: architecture.candidateHash });
  const oldPlan = { schemaVersion: 2, summary: "按历史错误建议把占位符作为受支持功能", runtime: "node-action", tasks: [], cases: [] };
  const oldHash = hashValue(oldPlan), oldRun = { id: "historical_feedback_run", agentId: input.id, version: 1, revision: 1,
    architectureRef: ref(original), architecture: structuredClone(original), createdAt: "2026-10-20T01:00:00.000Z",
    status: "failed", delivery: "blocked", phase: "planning", summary: "旧计划被评审要求修订", plan: null, planHash: null,
    pendingPlan: { plan: oldPlan, planHash: oldHash }, planAttempts: [], tasks: [], deliveries: [], reports: [],
    reviews: [{ planHash: oldHash, subjectHash: oldHash, verdict: "revise", summary: "同一意见描述与建议矛盾", issues: recorded.historicalOpinions.map((issue) => ({
      id: issue.id, blocking: issue.blocking, kind: "plan", description: issue.descriptionExcerpt, remedy: issue.remedyExcerpt })) }],
    feedback: { reason: "旧评审需要修订" }, sessions: {}, budgets: { corrections: 0 } };
  const reference = developmentRevisionReference(oldRun, original), parent = { ...structuredClone(original), version: 2,
    developmentRevision: reference, revisionSource: { kind: "development-failure", developmentRunId: oldRun.id,
      developmentRecordHash: reference.source.recordHash, developmentArchitectureRef: ref(original) } };
  const latest = { ...structuredClone(oldRun), id: "latest_generic_failure", version: 2, architectureRef: ref(parent), architecture: structuredClone(parent),
    pendingPlan: null, ...structuredClone(recorded.latestFailure), summary: "泛化最新失败", createdAt: "2026-10-20T02:00:00.000Z" };
  await designer.save(parent);
  const history = await readHistoricalPlanningReference({ architecture: parent, developmentFailure: latest,
    readRun: async (id) => { assert.equal(id, oldRun.id); return oldRun; },
    readArchitecture: async (version) => { assert.equal(version, original.version); return original; } });
  assert.equal(history.status, "available");
  return { designer, input, state, original, oldRun, parent, latest, history,
    options: { developmentFailure: latest, historicalPlanningReference: history } };
}

test("最新只有泛化失败时，真实修订控制器首包仍带唯一历史评审与不可信建议定位", async (t) => {
  const { designer, input, state, original, oldRun, parent, latest, options } = await controllerFixture(t);
  const before = hashValue({ original, oldRun, parent, latest }), oldPayloads = state.payloads.length;
  state.mode = "capture";
  await assert.rejects(designer.design(input, options), (error) => error.diagnostic?.stage === "architecture");
  assert.equal(state.payloads.length, oldPayloads + 1);
  const firstPayload = state.payloads.at(-1).payload;
  assert.equal(state.fixtureResponses, 4, "仅前置三阶段与独立评审返回固定答案，修订首包在真实调用前已截获停止");
  assert.equal(firstPayload.developmentRevision.source.runId, latest.id);
  assert.equal(firstPayload.developmentRevision.context.feedback.reason, recorded.latestFailure.feedback.reason);
  const summary = firstPayload.developmentRevision.reviewFeedbackSummary;
  assert.equal(summary.status, "available"); assert.equal(summary.trust, "untrusted-reference");
  assert.equal(summary.total, recorded.historicalOpinions.length); assert.equal(summary.findings.length, recorded.historicalOpinions.length);
  for (const opinion of recorded.historicalOpinions) {
    const row = summary.findings.find((entry) => entry.description === opinion.descriptionExcerpt);
    assert.ok(row, "旧问题须明确进入首包索引，不能仅保留旧计划");
    assert.equal(row.source.runId, oldRun.id); assert.equal(row.suggestedRemedy, opinion.remedyExcerpt);
    assert.equal(row.detailSection, "historicalPlanningReference");
  }
  assert.equal(hashValue({ original, oldRun, parent, latest }), before);
});

test("正式架构提交拒绝原样D9的假通过；真实修订后同断点完整独审可通过且旧记录不变", async (t) => {
  const { designer, input, state, original, oldRun, parent, latest, options } = await controllerFixture(t);
  const before = hashValue({ original, oldRun, parent, latest }); state.mode = "unchanged";
  await assert.rejects(designer.design(input, options), (error) => error.validationIssue?.reason === "repair_basis_unchanged");
  const rejected = await designer.get(input.id);
  assert.equal(rejected.status, "failed"); assert.equal(rejected.review, null);
  assert.equal(rejected.feedbackLedger.findings.filter((finding) => !finding.closure).length, recorded.historicalOpinions.length);
  const rejectedLedger = hashValue(rejected.feedbackLedger);
  assert.equal(state.payloads.at(-1).designer, false, "假pass确实抵达真实独立评审提交工具，而非仅检查局部帮助函数");
  state.mode = "fixed";
  const passed = await designer.design(input, options);
  assert.equal(passed.status, "passed"); assert.equal(passed.review.verdict, "pass");
  assert.equal(passed.feedbackLedger.findings.filter((finding) => !finding.closure).length, 0);
  assert.ok(passed.feedbackLedger.findings.every((finding) => finding.closure.status === "resolved"));
  assert.equal(passed.delivery, "needs_development", "架构通过不冒充研发、真实业务验收或交付成功");
  assert.equal(hashValue((await designer.getVersion(input.id, rejected.version)).feedbackLedger), rejectedLedger, "旧失败版本不回写关闭状态");
  assert.equal(hashValue({ original, oldRun, parent, latest }), before);
  assert.equal(state.fixtureResponses, 8, "首次三阶段与独立评审、两次负例角色和两次修复角色均为本地固定回答，没有真实模型请求");
});

test("旧评审推荐的动态占位符不构成平台事实，两个编码入口均保留字面值", async () => {
  const tool = createPlatformContractTool({ acceptanceAdapterGuide: ACCEPTANCE_ADAPTER_GUIDE });
  const result = JSON.parse((await tool.execute("recorded-advice", { requests: [{ source: "acceptanceAdapterGuide",
    path: "/adapters/action/executionFacts/dynamicPlaceholders", expected: true }] })).content[0].text);
  assert.equal(result.results[0].matches, false);
  assert.equal(result.results[0].actual, false);
  assert.equal(result.grantsCapability, false);
  for (const value of [JSON.stringify("<computed-result-json>"), { fixture: { op: "value", value: "<computed-result-json>" } }])
    assert.equal(resolveTestJson(value).value, "<computed-result-json>");
});

test("已有错误建议实际无法匹配写入；冻结独立精确预期后相同代码与变更输入均真实执行通过", { timeout: 20000 }, async (t) => {
  const executor = new DevelopmentExecutor(), availability = await executor.probe();
  if (!availability.available) {
    if (process.env.NEUMA_REQUIRE_ISOLATION === "1") assert.fail(availability.reason);
    return t.skip(availability.reason);
  }
  const root = await mkdtemp(join(tmpdir(), "neuma-feedback-execution-")), codeDir = join(root, "source");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(codeDir);
  await writeFile(join(codeDir, "actions.mjs"), `import {createHash} from 'node:crypto';
export const actions={async reconcile(input,ctx){
 const result={approvedCount:0,approvedAmountCents:0,unapprovedCount:0};
 for(const item of input.records){if(item.approved){result.approvedCount++;result.approvedAmountCents+=item.amountCents;}else result.unapprovedCount++;}
 const jsonContent=JSON.stringify(result),csvContent='approvedCount,approvedAmountCents,unapprovedCount\\n'+[result.approvedCount,result.approvedAmountCents,result.unapprovedCount].join(',')+'\\n';
 for(const [file,content] of [['result.json',jsonContent],['result.csv',csvContent]]){
  const saved=await ctx.files.write({file,content});
  if(saved.saved!==true||saved.file!==file||saved.integrity.bytes!==Buffer.byteLength(content)||saved.integrity.utf16Units!==content.length||saved.integrity.sha256!==createHash('sha256').update(content).digest('hex'))throw new Error('receipt_mismatch');
 }
 return {result,jsonContent,csvContent};
}};`);
  const snapshot = await inspectDevelopmentCode(codeDir), verify = (cases) => executor.verify({ snapshot,
    entrypoint: "actions.mjs", runtime: "node-action", application: manifest, cases });
  const wrong = recorded.executionSamples.map((sample) => executableCase(sample, { placeholder: true })), before = structuredClone(wrong);
  const rejected = await verify(wrong);
  assert.equal(rejected.status, "failed", JSON.stringify(rejected));
  assert.equal(rejected.results.length, 2);
  assert.ok(rejected.results.every((row) => row.status === "failed"));
  assert.ok(rejected.results.every((row) => row.mockCalls.length === 0), "字面参数不能与实际生成内容匹配，不能伪造工具调用成功");
  assert.deepEqual(wrong, before);
  const correct = recorded.executionSamples.map((sample) => executableCase(sample)), frozen = structuredClone(correct);
  const passed = await verify(correct);
  assert.equal(passed.status, "passed", JSON.stringify(passed));
  assert.ok(passed.results.every((row) => row.actionExecuted && row.mockCalls.length === 2));
  assert.deepEqual(passed.results.map((row) => row.actual.result), recorded.executionSamples.map((sample) => sample.result));
  assert.equal(passed.connectionVerified, false, "模拟写入只证明生成代码，不冒充真实宿主文件通道");
  assert.deepEqual(correct, frozen, "执行不得按生成结果反向修正冻结断言或替身");
  assert.equal((await inspectDevelopmentCode(codeDir)).hash, snapshot.hash, "修正测试材料不修改生成代码");
});
