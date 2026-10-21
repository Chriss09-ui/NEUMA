import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchitectureDesigner, architectureConfirmedContext } from "../src/architecture/architecture.mjs";
import { createPlatformSnapshot } from "../src/architecture/platform-contract.mjs";
import { designHash } from "../src/architecture/architecture-contract.mjs";
import { contentHash, substantiveRequirementHash } from "../src/requirements/task-spec.mjs";
import { consultationEvidenceHash, newConsultation } from "../src/requirements/consultation.mjs";
import { validDraft, validDesign, passingReview } from "./helpers/architecture.mjs";
import { sufficientPreflight } from "./helpers/consultation.mjs";
import { handoffChecker, requirementReference } from "./helpers/handoff.mjs";
import { fidelityChecker } from "./helpers/fidelity.mjs";

async function source() {
  const draft = validDraft("逐项核对并输出材料清单");
  draft.taskSpec = { version: 1, items: [
    { id: "coverage", dimension: "processing", content: "覆盖全部条目，不抽样", applicability: "applies", critical: true,
      source: { kind: "user", evidence: [{ messageId: "user_scope", quote: "覆盖全部条目，不抽样" }] } },
    { id: "baseline", dimension: "workflow", content: "采用另一套独立实现进行程序比对", applicability: "applies", critical: true,
      source: { kind: "accepted", evidence: [{ messageId: "suggestion", quote: "验收使用另一套独立实现进行程序比对" },
        { messageId: "accepted", quote: "我接受这个验收方法，不指定实现语言" }] } },
    { id: "measured", dimension: "input_scale", content: "实际材料有四条", applicability: "applies", critical: false,
      source: { kind: "measured", evidence: [{ messageId: "measurement", quote: "实际测量：四条" }] } },
    { id: "inferred", dimension: "delivery", content: "按记录序号保留核对关系", applicability: "applies", critical: false,
      source: { kind: "inferred", reason: "完整覆盖需要保留与原条目的对应关系", evidence: [{ messageId: "user_scope", quote: "覆盖全部条目，不抽样" }] } },
  ] };
  const platform = createPlatformSnapshot(), consultation = newConsultation();
  consultation.evidenceMessages = [
    { id: "user_scope", role: "user", content: "请覆盖全部条目，不抽样。其余未引用的对话不会投影。" },
    { id: "suggestion", role: "assistant", content: "建议：验收使用另一套独立实现进行程序比对。" },
    { id: "accepted", role: "user", content: "我接受这个验收方法，不指定实现语言。" },
    { id: "measurement", role: "measurement", content: "实际测量：四条。" },
    { id: "irrelevant", role: "user", content: "不属于当前要求的旧话题" },
  ];
  const decision = { issueId: "baseline_method", owner: "user", status: "resolved", stage: "requirements",
    reason: "用户接受独立实现的程序比对方式", evidence: [{ messageId: "accepted", quote: "我接受这个验收方法，不指定实现语言" }] };
  const assessment = { ...await sufficientPreflight(), id: "pre_current", systemReviewVersion: 1,
    requirementHash: substantiveRequirementHash(draft), platformHash: contentHash(platform), evidenceHash: consultationEvidenceHash(consultation),
    issueDecisions: [structuredClone(decision)] };
  consultation.assessments.push(assessment);
  consultation.issues.push({ id: decision.issueId, owner: "user", blocking: true, question: "验收的独立基准使用哪种方式？",
    impact: "影响验收方法", requirementIds: ["baseline", "successCriteria"], status: "resolved", current: false,
    requirementHash: assessment.requirementHash, resolution: { ...structuredClone(decision), assessmentId: assessment.id, evidenceHash: assessment.evidenceHash } });
  return { draft, platform, consultation };
}

test("确认证据按当前需求和平台绑定，逐字去重且保留来源种类，不投影整段历史", async () => {
  const input = await source(), before = structuredClone(input);
  const context = await architectureConfirmedContext(input.draft, input.consultation, input.platform);
  assert.equal(context.assessmentId, "pre_current");
  assert.equal(context.requirementHash, substantiveRequirementHash(input.draft));
  assert.equal(context.platformHash, contentHash(input.platform));
  assert.deepEqual(context.taskSources.map((item) => item.kind), ["user", "accepted", "measured", "inferred"]);
  assert.equal(context.taskSources[0].requirementId, `spec_${designHash("coverage").slice(0, 24)}`);
  assert.deepEqual(context.taskSources[0].quoteIds, context.taskSources[3].quoteIds);
  assert.equal(context.sourceQuotes.length, 4);
  assert.equal(context.sourceQuotes.find((item) => item.messageId === "accepted").role, "user");
  assert.deepEqual(context.resolvedChoices[0].requirementIds, [`spec_${designHash("baseline").slice(0, 24)}`, "successCriteria"]);
  assert.equal(context.resolvedChoices[0].quoteIds[0], context.taskSources[1].quoteIds[1]);
  assert.doesNotMatch(JSON.stringify(context), /其余未引用|不属于当前/);
  const { hash, ...value } = context; assert.equal(hash, designHash(value));
  assert.deepEqual(input, before);
  const original = structuredClone(context);
  context.sourceQuotes[0].quote = "调用方修改";
  assert.deepEqual(await architectureConfirmedContext(input.draft, input.consultation, input.platform), original);
});

test("过期、失败、未确认充分及旧协议的咨询不提供确认证据上下文", async () => {
  for (const change of [
    ({ draft }) => { draft.task.value += "，新增任务"; },
    (input) => { input.platform = createPlatformSnapshot({ allowNetwork: false }); },
    ({ consultation }) => { consultation.assessments[0].failure = "preflight_failed"; },
    ({ consultation }) => { delete consultation.assessments[0].systemReviewVersion; },
    ({ consultation }) => { consultation.assessments.push({ ...consultation.assessments[0], id: "pre_failed", failure: "request_failed" }); },
    ({ consultation }) => { consultation.handoff = { resolved: false, issues: [{ owner: "user", blocking: true, question: "尚未回答" }] }; },
    ({ consultation }) => { consultation.assessments[0].verdict = "needs_input"; consultation.assessments[0].issues = [
      { id: "open_choice", owner: "user", blocking: true, question: "交付给谁？", impact: "影响交付格式", requirementIds: ["deliverable"] } ]; },
  ]) {
    const input = await source(); change(input);
    assert.equal(await architectureConfirmedContext(input.draft, input.consultation, input.platform), null);
  }
  assert.equal(await architectureConfirmedContext(validDraft(), null, createPlatformSnapshot()), null);
});

test("任务要求的引用不存在、原文不匹配或来源角色错误时不能注入确认证据", async () => {
  for (const change of [
    ({ draft }) => { draft.taskSpec.items[0].source.evidence[0].quote = "用户未说过的内容"; },
    ({ consultation }) => { consultation.evidenceMessages = consultation.evidenceMessages.filter((item) => item.id !== "user_scope"); },
    ({ consultation }) => { consultation.evidenceMessages.find((item) => item.id === "user_scope").role = "assistant"; },
    ({ consultation }) => { consultation.evidenceMessages.find((item) => item.id === "accepted").role = "assistant"; },
  ]) {
    const input = await source(); change(input);
    input.consultation.assessments[0].requirementHash = substantiveRequirementHash(input.draft);
    assert.equal(await architectureConfirmedContext(input.draft, input.consultation, input.platform), null);
  }
});

test("已解决选择只投影当前需求下有对应独立决定和有效用户原话的事项", async () => {
  for (const change of [
    ({ consultation }) => { consultation.issues[0].status = "open"; },
    ({ consultation }) => { consultation.issues[0].current = true; },
    ({ consultation }) => { consultation.issues[0].owner = "system"; },
    ({ consultation }) => { consultation.issues[0].requirementHash = "0".repeat(64); },
    ({ consultation }) => { consultation.issues[0].resolution.assessmentId = "pre_missing"; },
    ({ consultation }) => { consultation.issues[0].resolution.evidenceHash = "0".repeat(64); },
    ({ consultation }) => { consultation.issues[0].resolution.evidence[0].quote = "未经确认"; },
    ({ consultation }) => { consultation.issues[0].requirementIds = ["unknown_requirement"]; },
    ({ consultation }) => { consultation.assessments[0].issueDecisions = []; },
    ({ consultation }) => { consultation.assessments[0].issueDecisions[0].evidence[0].quote = "找不到的原话"; },
    ({ consultation }) => { const ref = { messageId: "suggestion", quote: "验收使用另一套独立实现进行程序比对" };
      consultation.assessments[0].issueDecisions[0].evidence = [ref]; consultation.issues[0].resolution.evidence = [ref]; },
  ]) {
    const input = await source(); change(input);
    const context = await architectureConfirmedContext(input.draft, input.consultation, input.platform);
    assert.equal(context.taskSources.length, 4); assert.deepEqual(context.resolvedChoices, []);
  }
});

function candidate(requirements) {
  return validDesign(requirements, { schemaVersion: 3,
    interaction: { defaultEntry: "conversation", page: false, operations: false, inputs: "固定材料", results: "完整核对清单", persistentData: "不保存历史" },
    connections: [], execution: { language: "none", hosting: "builtin", reason: "固定材料使用现有工具" },
    selectionBasis: { capacity: "已明确输入边界", process: "逐条完整处理", quality: "以独立基准核对", requirementIds: requirements.map((item) => item.id), assumptions: [] } });
}

async function fixture(t, script) {
  const root = await mkdtemp(join(tmpdir(), "neuma-confirmed-architecture-")), calls = [];
  const designer = new ArchitectureDesigner({ config: { llmConfigured: true }, cwd: root, dataDir: root,
    handoffSessionFactory: handoffChecker(),
    fidelitySessionFactory: fidelityChecker(),
    sessionFactory: async ({ customTools }) => {
      const tools = Object.fromEntries(customTools.map((tool) => [tool.name, tool]));
      const role = tools.submit_architecture ? "designer" : tools.submit_module_design ? "specialist" : "reviewer";
      return { messages: [], subscribe: () => () => {}, dispose() {}, async abort() {},
        async prompt(text) { const payload = JSON.parse(text); calls.push({ role, payload });
          if (script) return script({ role, payload, tools });
          if (role === "designer") {
            await tools.delegate_module.execute("module", { modules: [{ question: "核对完整覆盖的最小方案", boundary: "不改变业务要求", benefit: "独立检查核对关系" }] });
            return tools.submit_architecture.execute("candidate", candidate(payload.requirements));
          }
          if (role === "specialist") return tools.submit_module_design.execute("module_result", {
            proposal: "使用已有工具逐项核对", interfaces: "输入与清单条目一一对应", tradeoffs: "不新增后台系统", evidenceIds: [], unknowns: [] });
          const review = passingReview(payload.candidateHash, payload.design);
          review.checks.push(...["requirement_sufficiency", "acceptance_quality"].filter((id) => !review.checks.some((item) => item.id === id)).map((id) => ({ id, passed: true, evidence: "当前任务要求与验收已经覆盖" })));
          return tools.submit_architecture_review.execute("review", review);
        } };
    } });
  t.after(async () => { await designer.persistence; await rm(root, { recursive: true, force: true }); });
  return { designer, calls };
}

test("设计者、评审者和模块顾问共享冻结的确认证据，证据本身不会替代独立评审", async (t) => {
  const input = await source(), before = contentHash(input.draft), f = await fixture(t);
  const result = await f.designer.design({ id: "agent", name: "核对助手", draft: input.draft, fingerprint: before }, { consultation: input.consultation });
  assert.deepEqual(f.calls.map((item) => item.role), ["designer", "specialist", "reviewer"]);
  const expected = await architectureConfirmedContext(input.draft, input.consultation, input.platform);
  for (const call of f.calls) assert.deepEqual(call.payload.confirmedRequirementContext, expected);
  assert.deepEqual(result.confirmedRequirementContext, expected);
  assert.deepEqual((await f.designer.get("agent")).confirmedRequirementContext, expected);
  assert.equal(contentHash(input.draft), before); assert.equal(result.status, "passed"); assert.equal(result.delivery, "blocked");
});

test("有确认证据仍允许真正缺少的关键选择正式返需，不自动解决或放行", async (t) => {
  const input = await source(), f = await fixture(t, async ({ role, payload, tools }) => {
    assert.equal(role, "designer"); assert.ok(payload.confirmedRequirementContext);
    return tools.request_requirements.execute("handoff", { issues: [{ id: "new_audience", question: "这份结果供哪个使用对象使用？",
      impact: "不同对象需要不同交付范围", requirementIds: ["deliverable"], references: [requirementReference(payload, "deliverable")] }] });
  });
  const result = await f.designer.design({ id: "agent", name: "核对助手", draft: input.draft, fingerprint: contentHash(input.draft) }, { consultation: input.consultation });
  assert.equal(result.status, "needs_input"); assert.equal(result.delivery, "blocked");
  assert.equal(result.handoff.issues[0].id, "new_audience"); assert.equal(result.handoff.issues[0].blocking, true);
  assert.equal(f.calls.length, 1);
});
