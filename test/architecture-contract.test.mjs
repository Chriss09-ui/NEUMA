import test from "node:test";
import assert from "node:assert/strict";
import { InputError, emptyDraft } from "../src/requirements/core.mjs";
import { ARCHITECTURE_VERSION, CAPABILITIES, requirementItems, validateDesign,
  validateReview, checkDesign, designHash } from "../src/architecture/architecture-contract.mjs";

function readyDraft() {
  const draft = emptyDraft();
  for (const [key, value] of Object.entries({ goal: "整理会议记录", scenario: "会后复盘", inputSource: "用户粘贴的文本",
    task: "提取决定与待办", deliverable: "中文摘要", successCriteria: "每条待办包含责任人或明确待确认" })) draft[key] = { value, source: "user" };
  return draft;
}

const requirements = requirementItems(readyDraft());
const context = { requirements };
function design() {
  return {
    profile: "light", rationale: "输入和输出均为文本，一次模型处理即可完成。", instructions: "只依据用户记录整理摘要，缺少内容时先询问。",
    components: [{ id: "summarize", purpose: "整理记录", necessity: "缺少整理会遗漏决定与待办", inputs: "会议文本", outputs: "摘要与待办" }],
    steps: [{ id: "compose", componentId: "summarize", dependsOn: [], input: "用户会议记录", output: "中文摘要", completion: "所有待办有责任人或待确认标记" }],
    capabilities: [{ id: "conversation", status: "available", reason: "只处理用户提供的文本" }],
    state: { mode: "task", reason: "只保留本次对话上下文" },
    failureHandling: [{ scenario: "未提供记录", response: "请求用户粘贴记录" }],
    decisions: [{ id: "runtime", problem: "如何执行文本整理", choice: "现有 SDK", alternatives: [{ option: "独立工作流", reason: "没有阶段间持久状态或调度需求" }], reason: "单次文本任务可直接使用现有能力", evidenceIds: [], uncertainties: [] }],
    coverage: requirements.map((item) => ({ requirementId: item.id, componentIds: ["summarize"], verification: `检查摘要满足：${item.text}` })),
    acceptance: [
      { id: "valid", kind: "success", requirementIds: requirements.map((item) => item.id), input: "会后整理：张三明天提交报告", expected: "中文摘要包含张三、提交报告、明天，且不发送外部消息" },
      { id: "empty", kind: "missing_input", requirementIds: ["inputSource"], input: "没有提供会议记录", expected: "询问会议记录，不编造摘要" },
      { id: "boundary", kind: "boundary", requirementIds: ["externalAction"], input: "请直接发给参会人", expected: "说明只能提供摘要，不声称已发送" },
    ], unknowns: [],
  };
}

function review(candidateHash = designHash(design())) {
  return { candidateHash, verdict: "pass", checks: ["requirements", "feasibility", "minimality", "interfaces", "failure_handling", "verification"]
    .map((id) => ({ id, passed: true, evidence: `已核对候选中的 ${id} 相关字段和需求映射` })), issues: [], summary: "设计在现有文本能力范围内可执行" };
}

test("需求交接使用现有 ready 门禁，保留约束、触发与外部边界", () => {
  assert.equal(ARCHITECTURE_VERSION, 1);
  assert.throws(() => requirementItems(emptyDraft()), InputError);
  const draft = readyDraft();
  draft.constraints = [{ text: "不能编造责任人", source: "user" }];
  draft.usage = { mode: "scheduled", detail: "每天九点", source: "user" };
  draft.capabilityDependencies = ["定时任务"];
  const items = requirementItems(draft);
  assert.ok(items.some((item) => item.id === "constraint_1"));
  assert.match(items.find((item) => item.id === "usage").text, /scheduled/);
  assert.ok(items.some((item) => item.id === "capability_1"));
  draft.unresolved = ["boundary"];
  assert.throws(() => requirementItems(draft), /未解决/);
});

test("有效设计返回独立副本，轻量真实能力才能直接运行", () => {
  const original = design();
  const result = validateDesign(original, context);
  assert.deepEqual(result, original);
  result.instructions = "已修改";
  assert.notEqual(result.instructions, original.instructions);
  assert.deepEqual(checkDesign(original, context), { issues: [], runnable: true });
  assert.deepEqual(CAPABILITIES.map((item) => item.id), ["conversation", "list_workspace_files", "read_workspace_file", "write_workspace_file"]);
});

test("空字段、额外字段、重复 ID 和超长指令不能通过", () => {
  for (const mutate of [
    (value) => { value.rationale = "  "; },
    (value) => { value.approved = true; },
    (value) => { value.components.push(structuredClone(value.components[0])); },
    (value) => { value.instructions = "a".repeat(12_001); },
    (value) => { value.unknowns = [{ question: "未知", blocking: "false", resolution: "待验证" }]; },
  ]) {
    const value = design(); mutate(value);
    assert.throws(() => validateDesign(value, context), InputError);
  }
});

test("悬空组件、需求、步骤引用与依赖循环不能通过", () => {
  for (const mutate of [
    (value) => { value.steps[0].componentId = "ghost"; },
    (value) => { value.steps[0].dependsOn = ["ghost"]; },
    (value) => { value.steps[0].dependsOn = ["compose"]; },
    (value) => { value.coverage[0].componentIds = ["ghost"]; },
    (value) => { value.coverage[0].requirementId = "ghost"; },
    (value) => { value.acceptance[0].requirementIds.push("ghost"); },
  ]) {
    const value = design(); mutate(value);
    assert.throws(() => validateDesign(value, context), InputError);
  }
  const cyclic = design();
  cyclic.steps[0].dependsOn = ["second"];
  cyclic.steps.push({ ...cyclic.steps[0], id: "second", dependsOn: ["compose"] });
  assert.throws(() => validateDesign(cyclic, context), /循环/);
});

test("需求覆盖和验收种类必须完整，工具失败场景按能力要求", () => {
  const missingCoverage = design(); missingCoverage.coverage.pop();
  assert.throws(() => validateDesign(missingCoverage, context), /未被设计覆盖/);
  const missingAcceptance = design(); missingAcceptance.acceptance[0].requirementIds = ["goal"];
  assert.throws(() => validateDesign(missingAcceptance, context), /缺少验收场景/);
  const missingKind = design(); missingKind.acceptance[2].kind = "success";
  assert.throws(() => validateDesign(missingKind, context), /boundary/);
  const tool = design();
  tool.capabilities.push({ id: "read_workspace_file", status: "available", reason: "读取用户放在专属目录的记录" });
  assert.throws(() => validateDesign(tool, context), /tool_failure/);
  tool.acceptance.push({ id: "tool_error", kind: "tool_failure", requirementIds: ["inputSource"], input: "请求读取不存在的记录文件", expected: "报告未找到文件，请用户确认文件或粘贴文本" });
  assert.equal(checkDesign(tool, context).runnable, true);
});

test("不允许把未知能力伪称 available，证据引用必须实际存在", () => {
  const unavailable = design(); unavailable.capabilities[0].id = "send_email";
  assert.throws(() => validateDesign(unavailable, context), /未被工具目录证实/);
  const noEvidence = design(); noEvidence.decisions[0].evidenceIds = ["official_1"];
  assert.throws(() => validateDesign(noEvidence, context), /不存在的 ID/);
  assert.doesNotThrow(() => validateDesign(noEvidence, { ...context, evidence: [{ id: "official_1", url: "https://example.com/docs" }] }));
});

test("未知问题成为门禁项；workflow/custom 可评估但不得标成直接可运行", () => {
  const unknown = design(); unknown.unknowns.push({ question: "输出格式是否支持", blocking: true, resolution: "确认实际输出示例" });
  assert.doesNotThrow(() => validateDesign(unknown, context));
  assert.equal(checkDesign(unknown, context).runnable, false);
  assert.equal(checkDesign(unknown, context).issues[0].blocking, true);
  for (const profile of ["workflow", "custom"]) {
    const value = design(); value.profile = profile;
    assert.deepEqual(checkDesign(value, context), { issues: [], runnable: false });
  }
  const persistent = design(); persistent.state.mode = "persistent";
  assert.equal(checkDesign(persistent, context).issues[0].blocking, true);
});

test("已知待实现与未经验证分开，任何缺失能力都不能进入轻量运行", () => {
  for (const status of ["needs_connection", "needs_development", "unverified"]) {
    const value = design();
    value.capabilities.push({ id: "external_service", status, reason: "外部服务未接入，需要后续实现" });
    value.acceptance.push({ id: "service_failure", kind: "tool_failure", requirementIds: ["task"], input: "外部服务暂时无法访问", expected: "说明未完成，不声称结果已获取" });
    assert.equal(checkDesign(value, context).runnable, false);
    assert.equal(checkDesign(value, context).issues[0].blocking, true);
    value.profile = "custom";
    const result = checkDesign(value, context);
    assert.equal(result.runnable, false);
    assert.equal(result.issues[0].blocking, status === "unverified");
  }
  assert.throws(() => validateDesign(design(), { ...context, capabilities: [] }), /未被工具目录证实/);
  assert.throws(() => validateDesign(design(), { ...context, evidence: [null] }), InputError);
});

test("候选 hash 不受对象键序影响，任何实际变更使旧评估失效", () => {
  assert.equal(designHash({ b: 2, a: { d: 4, c: 3 } }), designHash({ a: { c: 3, d: 4 }, b: 2 }));
  const initialHash = designHash(design());
  const changed = design(); changed.instructions += "请使用简体中文。";
  const nextHash = designHash(changed);
  assert.notEqual(initialHash, nextHash);
  assert.throws(() => validateReview(review(initialHash), { candidateHash: nextHash }), /不匹配/);
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => designHash(cyclic), InputError);
});

test("评估必须完整且无阻断项，不能只靠 pass 文本放行", () => {
  const candidateHash = designHash(design());
  const valid = review(candidateHash);
  assert.deepEqual(validateReview(valid, { candidateHash }), valid);
  for (const mutate of [
    (value) => { value.checks[0].passed = false; },
    (value) => { value.issues.push({ id: "missing", blocking: true, description: "缺少来源", remedy: "提供真实证据" }); },
    (value) => { value.checks[5] = structuredClone(value.checks[0]); },
    (value) => { value.checks[0].evidence = ""; },
  ]) {
    const value = review(candidateHash); mutate(value);
    assert.throws(() => validateReview(value, { candidateHash }), InputError);
  }
  const insufficient = review(candidateHash);
  insufficient.verdict = "insufficient";
  insufficient.checks[1].passed = false;
  assert.doesNotThrow(() => validateReview(insufficient, { candidateHash }));
});
