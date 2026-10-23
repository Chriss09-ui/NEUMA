import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchitectureDesigner, architectureVerificationContext } from "../src/architecture/architecture.mjs";
import { PrototypeAgents } from "../src/agents/agent-prototype.mjs";
import { createPlatformSnapshot } from "../src/architecture/platform-contract.mjs";
import { designHash, requirementItems } from "../src/architecture/architecture-contract.mjs";
import { contentHash, substantiveRequirementHash } from "../src/requirements/task-spec.mjs";
import { consultationEvidenceHash, issueConfirmation, newConsultation } from "../src/requirements/consultation.mjs";
import { validatePlan } from "../src/development/development-contract.mjs";
import { sufficientPreflight } from "./helpers/consultation.mjs";
import { validDraft, validDesign, passingReview } from "./helpers/architecture.mjs";
import { fidelityChecker } from "./helpers/fidelity.mjs";
import { architectureStageSubmission } from "./helpers/architecture-stages.mjs";

function draft() {
  return { ...validDraft(), taskSpec: { version: 1, items: [{ id: "full_coverage", dimension: "processing", content: "完整处理全部输入",
    applicability: "applies", critical: true, source: { kind: "user", evidence: [{ messageId: "source", quote: "完整处理全部输入" }] } }] } };
}
async function consultation(draft, platform = createPlatformSnapshot()) {
  const consultation = newConsultation(); consultation.evidenceMessages.push({ id: "source", role: "user", content: "完整处理全部输入" });
  const issue = { id: "intake_integrity", owner: "system", blocking: false, stage: "development", question: "分段接收须验证段数、摘要和总记录数，缺段不得产出最终统计",
    impact: "完整接收与逐项覆盖才能满足原需求", requirementIds: ["full_coverage"], checks: ["platform.deliveryRoutes.managedService"] };
  const check = { id: issue.id, status: "verified", message: "已核实宿主提供动作与能力桥，不代表分段程序已通过测试", evidence: [
    { source: "platform", reference: issue.checks[0], detail: "平台允许受管动作经 files/state 保存分段及临时索引，具体协议待研发验收" },
  ] };
  const id = "pre_deferred_verification";
  consultation.assessments.push({ ...await sufficientPreflight(), id, issues: [issue], requirementHash: substantiveRequirementHash(draft),
    platformHash: contentHash(platform), evidenceHash: consultationEvidenceHash(consultation), systemChecks: [check],
    deferredIssues: [{ ...issue, stageDecision: { stage: issue.stage, reason: "该问题在实现动作后以确定输入和输出实际验收，不是新的业务取舍",
      checks: [...issue.checks], assessmentId: id }, verification: [check] }] });
  return consultation;
}
function currentDesign(requirements) {
  const value = validDesign(requirements, { schemaVersion: 3, profile: "custom", connections: [],
    interaction: { defaultEntry: "conversation", page: false, operations: true, inputs: "分段记录", results: "完整汇总", persistentData: "仅本次接收临时索引" },
    execution: { language: "javascript", hosting: "builtin", reason: "本测试仅检查批准动作的验证交接" },
    selectionBasis: { capacity: "固定三条输入", process: "核对各段完整后汇总", quality: "结果计数与输入对应",
      requirementIds: requirements.map((item) => item.id), assumptions: [] } });
  const deferred = requirements.find((item) => item.id.startsWith("verification_"));
  if (deferred) value.acceptance.push({ id: "intake_integrity", kind: "success", requirementIds: [deferred.id],
    input: "提交两段共三条记录及完整性摘要；另提交缺少第二段的输入", expected: "完整输入输出三条汇总；缺段输入报告未完整接收且没有最终统计",
    verification: { stage: "development", owner: "generated-code", adapterId: "action" } });
  return value;
}
function review(hash, candidate) {
  const value = passingReview(hash, candidate);
  value.checks.push(...["requirement_sufficiency", "acceptance_quality"].filter((id) => !value.checks.some((item) => item.id === id))
    .map((id) => ({ id, passed: true, evidence: "核对后续义务及具体验收" })));
  return value;
}
function sessions(script = {}) {
  const candidates = new Map();
  return async (options) => {
    const tools = Object.fromEntries(options.customTools.map((tool) => [tool.name, tool])), storage = options.sessionStorage;
    return { messages: [], modelCallAccounting: true,
      ...(storage ? { sessionFile: join(storage.directory, storage.file ?? `${storage.binding.key}-${storage.binding.generation}.jsonl`) } : {}),
      subscribe: () => () => {}, async abort() {}, dispose() {},
      async prompt(text) {
        await options.onModelCall();
        const payload = JSON.parse(text);
        if (storage) {
          const id = storage.binding.pipelineId;
          if (storage.binding.stage === "blueprint") {
            const value = currentDesign(payload.requirements); script.change?.(value, payload); candidates.set(id, value);
          }
          const candidate = candidates.get(id);
          assert.ok(candidate, "模块和整合必须复用蓝图阶段的完整固定候选");
          const stage = architectureStageSubmission({ tools, payload, candidate });
          assert.ok(stage); return stage.tool.execute(`fixture-${storage.binding.stage}`, stage.args);
        }
        if (tools.submit_architecture) {
          const value = currentDesign(payload.requirements); script.change?.(value, payload);
          return tools.submit_architecture.execute("candidate", value);
        }
        const value = review(payload.candidateHash, payload.design); script.review?.(value, payload);
        return tools.submit_architecture_review.execute("review", value);
      } };
  };
}
async function fixture(t, script = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-deferred-architecture-"));
  const designer = new ArchitectureDesigner({ config: { llmConfigured: true }, cwd: root, dataDir: root,
    sessionFactory: sessions(script), fidelitySessionFactory: fidelityChecker() });
  t.after(async () => { await designer.persistence; await rm(root, { recursive: true, force: true }); });
  return { designer, root };
}

test("已确认的后续义务映射正式任务编号，进入架构覆盖与具体待验收条目，不改需求指纹", async (t) => {
  const source = draft(), before = contentHash(source), saved = await consultation(source), f = await fixture(t);
  const result = await f.designer.design({ id: "agent", name: "核对助手", draft: source, fingerprint: before }, { consultation: saved });
  assert.equal(result.status, "passed"); assert.equal(result.delivery, "needs_development");
  const issue = result.deferredVerifications.issues[0], formalSpec = `spec_${designHash("full_coverage").slice(0, 24)}`;
  assert.deepEqual(issue.requirementIds, [formalSpec]); assert.match(issue.requirementId, /^verification_[a-f0-9]{24}$/);
  assert.equal(result.deferredVerifications.assessmentId, saved.assessments[0].id);
  assert.ok(result.requirements.some((item) => item.id === issue.requirementId && /尚未执行/.test(item.text)));
  assert.ok(result.design.coverage.some((item) => item.requirementId === issue.requirementId));
  assert.ok(result.design.acceptance.some((item) => item.id === "intake_integrity" && item.requirementIds.includes(issue.requirementId)));
  assert.equal(contentHash(source), before); assert.equal(result.sourceFingerprint, before);
  assert.equal((await f.designer.get("agent")).deferredVerifications.hash, result.deferredVerifications.hash);
});

test("缺少后续义务的设计覆盖或验收均不能通过，不能只把它留在协商日志", async (t) => {
  for (const target of ["coverage", "acceptance"]) await t.test(target, async (child) => {
    const source = draft(), saved = await consultation(source), f = await fixture(child, { change(value) {
      if (target === "coverage") value.coverage = value.coverage.filter((item) => !item.requirementId.startsWith("verification_"));
      else for (const item of value.acceptance) item.requirementIds = item.requirementIds.filter((id) => !id.startsWith("verification_"));
    } });
    await assert.rejects(f.designer.design({ id: "agent", name: "核对助手", draft: source, fingerprint: contentHash(source) }, { consultation: saved }),
      (error) => {
        if (target === "coverage") assert.deepEqual(error.validationIssue, { path: "module.coverage", reason: "invalid_reference" });
        else {
          assert.match(error.validationIssue.path, /^module\.acceptance\[\d+\]\.requirementIds$/u);
          assert.equal(error.validationIssue.reason, "size_limit");
          assert.equal(error.validationIssue.constraints.minItems, 1);
        }
        return true;
      });
    const stopped = await f.designer.get("agent");
    assert.notEqual(stopped.status, "passed");
    assert.ok(stopped.designProgressCheckpoint.blueprint.result);
    assert.equal(stopped.designProgressCheckpoint.modules[0].result, null);
    assert.equal(stopped.designProgressCheckpoint.integration.modelCalls, 0, "模块缺项不能进入整合补造覆盖");
  });
});

test("过期需求或平台、未知核实、错阶段评估及悬空任务引用均不能作为后移义务", async () => {
  const source = draft(), saved = await consultation(source), platform = createPlatformSnapshot();
  const changed = structuredClone(source); changed.task.value += "新业务范围";
  await assert.rejects(architectureVerificationContext(changed, saved, platform), /未绑定/);
  await assert.rejects(architectureVerificationContext(source, saved, createPlatformSnapshot({ allowNetwork: false })), /未绑定/);
  for (const change of [
    (value) => { value.assessments[0].deferredIssues[0].verification[0].status = "unknown"; },
    (value) => { value.assessments[0].deferredIssues[0].stageDecision.assessmentId = "pre_old"; },
    (value) => { value.assessments[0].deferredIssues[0].requirementIds = ["connections"]; value.assessments[0].issues[0].requirementIds = ["connections"]; },
  ]) {
    const invalid = structuredClone(saved); change(invalid);
    await assert.rejects(architectureVerificationContext(source, invalid, platform), /未绑定|正式需求编号/);
  }
  assert.deepEqual(await architectureVerificationContext(validDraft(), null, platform), { context: null, requirements: [] });
});

test("正式新增验证要求必须进入研发任务及实际用例，不能仅被架构文字提到", async (t) => {
  const source = draft(), f = await fixture(t), saved = await consultation(source);
  const architecture = await f.designer.design({ id: "agent", name: "核对助手", draft: source, fingerprint: contentHash(source) }, { consultation: saved });
  const schema = { type: "object", properties: {}, required: [], additionalProperties: false };
  const plan = { schemaVersion: 3, summary: "落实全部架构验收", runtime: "node-action", entrypoint: "actions.mjs",
    application: { protocolVersion: 2, runtime: "node-action", entrypoint: "actions.mjs", page: null,
      actions: [{ id: "check", title: "完整性检查", inputSchema: schema, outputSchema: schema, connectionIds: [] }], stateVersion: 1, evidenceIds: [] },
    tasks: [{ id: "implement", title: "实现并验证完整性", description: "对照冻结验收测试完整及缺段输入", files: ["actions.mjs"], dependsOn: [],
      requirementIds: architecture.requirements.map((item) => item.id), acceptanceIds: architecture.design.acceptance.map((item) => item.id) }],
    cases: architecture.design.acceptance.map((item, index) => ({ id: `case_${index}`, taskId: "implement", acceptanceId: item.id,
      kind: "action", actionId: "check", mocks: [], input: "{}", assertions: [{ path: "", expectedJson: "{}" }] })) };
  assert.doesNotThrow(() => validatePlan(plan, { architecture }));
  const noTask = structuredClone(plan); noTask.tasks[0].requirementIds = noTask.tasks[0].requirementIds.filter((id) => !id.startsWith("verification_"));
  assert.throws(() => validatePlan(noTask, { architecture }), /verification_.*缺少研发任务/);
  const noCase = structuredClone(plan); noCase.cases = noCase.cases.filter((item) => item.acceptanceId !== "intake_integrity");
  assert.throws(() => validatePlan(noCase, { architecture }), /intake_integrity.*实际.*用例/);
});

test("构建只从已保存协商取得后续义务，旧需求同内容保存不会丢失其可信上下文", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-deferred-build-")), source = draft(), saved = await consultation(source);
  const agents = new PrototypeAgents({ config: { llmConfigured: true }, cwd: root, dataDir: root,
    fidelitySessionFactory: fidelityChecker(),
    sessionFactory: sessions({ review(value) { value.verdict = "insufficient"; value.checks[0].passed = false;
      value.issues = [{ id: "test_stop", blocking: true, description: "测试在架构交接前停止", remedy: "本测试不启动研发",
        checkId: "requirements", kind: "design", candidatePaths: ["/steps/0/output"],
        references: [{ source: "candidate", path: "/steps/0/output", quote: "中文周报" }], factClaims: [] }]; } }) });
  t.after(async () => { await agents.close(); await rm(root, { recursive: true, force: true }); });
  const name = "核对助手", approval = issueConfirmation(source, saved, { platform: createPlatformSnapshot(), requestId: "confirm-deferred" });
  await agents.saveRequirements("agent", { name, draft: source }, { confirmation: approval, consultation: saved });
  const result = await agents.build({ id: "agent", name, draft: source });
  assert.equal(result.architecture.status, "needs_evidence"); assert.ok(result.architecture.deferredVerifications);
  assert.deepEqual(result.architecture.deferredVerifications.issues[0].requirementIds, [`spec_${designHash("full_coverage").slice(0, 24)}`]);
  const stored = await agents.getRequirementConsultation("agent"); assert.deepEqual(stored, saved);
});

test("同需求新出现验证义务不能复用旧架构缓存，失败候选仍保留旧活动定义", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-deferred-cache-")), source = draft(), saved = await consultation(source);
  let candidates = 0;
  const agents = new PrototypeAgents({ config: { llmConfigured: true }, cwd: root, dataDir: root, fidelitySessionFactory: fidelityChecker(), sessionFactory: sessions({
    change(value, payload) {
      candidates++;
      if (!payload.deferredVerifications) {
        value.profile = "light"; value.interaction.operations = false;
        value.execution = { language: "none", hosting: "builtin", reason: "旧版本使用已有工具" };
      }
    },
    review(value, payload) {
      if (payload.deferredVerifications) { value.verdict = "insufficient"; value.checks[0].passed = false;
        value.issues = [{ id: "test_stop", blocking: true, description: "新义务仍需设计", remedy: "测试保留旧活动定义",
          checkId: "requirements", kind: "design", candidatePaths: ["/steps/0/output"],
          references: [{ source: "candidate", path: "/steps/0/output", quote: "中文周报" }], factClaims: [] }]; }
    },
  }) });
  t.after(async () => { await agents.close(); await rm(root, { recursive: true, force: true }); });
  const first = structuredClone(saved); first.assessments[0].issues = []; delete first.assessments[0].deferredIssues;
  const input = { id: "agent", name: "核对助手", draft: source }, platform = createPlatformSnapshot();
  await agents.saveRequirements(input.id, input, { confirmation: issueConfirmation(source, first, { platform, requestId: "confirm-old" }), consultation: first });
  const previous = await agents.build(input); assert.equal(previous.agent.status, "ready"); assert.equal(candidates, 1);
  assert.equal(previous.architecture.deferredVerifications, undefined);
  await agents.saveRequirements(input.id, input, { confirmation: issueConfirmation(source, saved, { platform, requestId: "confirm-new" }), consultation: saved });
  const next = await agents.build(input);
  assert.equal(candidates, 2, "同草稿的新验证义务必须进入新架构");
  assert.equal(next.architecture.status, "needs_evidence"); assert.ok(next.architecture.deferredVerifications);
  assert.equal(next.agent.fingerprint, previous.agent.fingerprint);
  assert.deepEqual(next.agent.architectureRef, previous.agent.architectureRef);
});
