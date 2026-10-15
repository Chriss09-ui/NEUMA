import test from "node:test";
import assert from "node:assert/strict";
import { InputError, emptyDraft } from "../src/requirements/core.mjs";
import { ARCHITECTURE_VERSION, CAPABILITY_CATALOG_VERSION, CAPABILITIES, LEGACY_CAPABILITIES, PUBLIC_TOOL_IDS,
  capabilitySnapshotCompatible, requirementItems, validateDesign, validateReview, checkDesign, designHash } from "../src/architecture/architecture-contract.mjs";

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

function interactionFixture(interaction, { schemaVersion, page = false, operations = false } = {}) {
  const draft = readyDraft();
  draft.interaction = { defaultEntry: "conversation", page: false, operations: [],
    inputs: "会议记录", results: "中文摘要", persistentData: "无", ...interaction };
  const requirements = requirementItems(draft);
  const value = design();
  value.coverage = requirements.map((item) => ({ requirementId: item.id, componentIds: ["summarize"], verification: `核对：${item.text}` }));
  value.acceptance[0].requirementIds = requirements.map((item) => item.id);
  if (schemaVersion === 2) Object.assign(value, { schemaVersion, connections: [], interaction: {
    defaultEntry: page ? "application" : "conversation", page, operations,
    inputs: "会议记录", results: "中文摘要", persistentData: "无",
  } });
  return { value, context: { draft, requirements } };
}

test("已确认页面默认入口和助手用途不能被降级或擅自扩张", () => {
  const assistant = { enabled: true, purpose: "解释当前图形并操作已有参数" };
  const fixture = interactionFixture({ defaultEntry: "application", page: true, assistant }, { schemaVersion: 2, page: true });
  fixture.value.interaction.assistant = assistant;
  assert.equal(checkDesign(fixture.value, fixture.context).issues.some((issue) => issue.blocking), false);
  for (const mutate of [
    (value) => { value.interaction.defaultEntry = "conversation"; },
    (value) => { delete value.interaction.assistant; },
    (value) => { value.interaction.assistant = { enabled: false, purpose: "" }; },
    (value) => { value.interaction.assistant.purpose = "自动修改页面代码"; },
  ]) {
    const changed = structuredClone(fixture.value); mutate(changed);
    assert.ok(checkDesign(changed, fixture.context).issues.some((issue) => issue.id === "confirmed_presentation" && issue.blocking));
  }
  fixture.context.draft.interaction.assistant = { enabled: false, purpose: "" };
  assert.ok(checkDesign(fixture.value, fixture.context).issues.some((issue) => issue.id === "confirmed_presentation"));
  fixture.value.interaction.assistant = { enabled: false, purpose: "" };
  assert.equal(checkDesign(fixture.value, fixture.context).issues.some((issue) => issue.blocking), false);
  delete fixture.context.draft.interaction.assistant;
  fixture.value.interaction.assistant = assistant;
  assert.ok(checkDesign(fixture.value, fixture.context).issues.some((issue) => issue.id === "confirmed_presentation"));
  assert.ok(checkDesign(fixture.value, { requirements: fixture.context.requirements }).issues.some((issue) => issue.id === "confirmed_presentation"));
  delete fixture.value.interaction.assistant;
  assert.equal(checkDesign(fixture.value, fixture.context).issues.some((issue) => issue.blocking), false);
});

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
  assert.deepEqual(CAPABILITIES.map((item) => item.id), ["conversation", "list_workspace_files", "read_workspace_file", "write_workspace_file",
    "list_materials", "read_material", "read_material_image"]);
  assert.deepEqual(PUBLIC_TOOL_IDS, ["list_materials", "read_material", "read_material_image"]);
});

test("已确认托管页面或应用操作不能由旧候选结构绕过研发交付", () => {
  const page = interactionFixture({ defaultEntry: "application", page: true });
  const operation = interactionFixture({ operations: ["整理会议记录"] });
  for (const fixture of [page, operation]) {
    assert.doesNotThrow(() => validateDesign(fixture.value, fixture.context), "旧结构继续支持历史读取");
    const checked = checkDesign(fixture.value, fixture.context);
    assert.equal(checked.runnable, false);
    const issue = checked.issues.find((entry) => entry.id === "confirmed_interaction");
    assert.equal(issue.blocking, true);
    assert.equal(issue.source, "program");
    assert.deepEqual(issue.candidateFields, ["schemaVersion", "interaction", "profile", "steps", "coverage", "acceptance"]);
    assert.match(issue.remedy, /schemaVersion:2.*interaction\.page\/operations.*研发/);
  }
});

test("新版候选必须保留已确认的页面和操作字段，实际实现仍进入研发", () => {
  const page = interactionFixture({ defaultEntry: "application", page: true }, { schemaVersion: 2 });
  const operation = interactionFixture({ operations: ["整理会议记录"] }, { schemaVersion: 2 });
  for (const fixture of [page, operation]) {
    const checked = checkDesign(fixture.value, fixture.context);
    assert.equal(checked.runnable, false);
    assert.ok(checked.issues.some((entry) => entry.id === "confirmed_interaction" && entry.blocking));
  }
  page.value.interaction.page = true;
  page.value.interaction.defaultEntry = "application";
  operation.value.interaction.operations = true;
  for (const fixture of [page, operation]) assert.deepEqual(checkDesign(fixture.value, fixture.context), { issues: [], runnable: false });
});

test("仅下载本地打开的 HTML 文件不被误判为托管页面，旧轻量文本路径保持兼容", () => {
  const fixture = interactionFixture({ results: "下载自包含 HTML，用户在本地浏览器打开" });
  for (const schemaVersion of [1, 2]) {
    if (schemaVersion === 2) Object.assign(fixture.value, { schemaVersion, connections: [], interaction: {
      defaultEntry: "conversation", page: false, operations: false,
      inputs: "会议记录", results: "下载 HTML", persistentData: "无",
    } });
    assert.deepEqual(checkDesign(fixture.value, fixture.context), { issues: [], runnable: true });
  }
});

test("历史目录仅接受完整精确的四项快照，仍核对实际已使用能力", () => {
  const legacy = { design: design(), capabilitySnapshot: structuredClone(LEGACY_CAPABILITIES) };
  assert.equal(capabilitySnapshotCompatible(legacy), true);
  assert.equal(capabilitySnapshotCompatible({ ...legacy, capabilityCatalogVersion: 1 }), true);
  for (const mutate of [
    (record) => { record.capabilitySnapshot.pop(); },
    (record) => { record.capabilitySnapshot[0].scope = "可读取其他 Agent"; },
    (record) => { record.capabilitySnapshot[0].version = 1; },
    (record) => { record.capabilitySnapshot.push({ id: "web_search", status: "available", scope: "联网" }); },
    (record) => { record.design.capabilities.push({ id: "read_material", status: "available", reason: "伪装旧目录能力" }); },
    (record) => { record.capabilityCatalogVersion = 999; },
  ]) {
    const record = structuredClone(legacy); mutate(record);
    assert.equal(capabilitySnapshotCompatible(record), false);
  }
  const changed = CAPABILITIES.map((item) => item.id === "conversation" ? { ...item, scope: "扩大权限" } : item);
  assert.equal(capabilitySnapshotCompatible(legacy, changed), false);
  assert.equal(Object.isFrozen(LEGACY_CAPABILITIES), true);
  assert.ok(LEGACY_CAPABILITIES.every(Object.isFrozen));
});

test("版本化目录按已使用能力校验，新添无关能力不废弃已有方案", () => {
  const record = { capabilityCatalogVersion: CAPABILITY_CATALOG_VERSION, capabilitySnapshot: structuredClone(CAPABILITIES), design: design() };
  record.design.capabilities.push({ id: "read_material", status: "available", reason: "读取上传文档" });
  assert.equal(capabilitySnapshotCompatible(record), true);
  const future = [...CAPABILITIES, { id: "future_tool", version: 1, status: "available", scope: "未来工具" }];
  assert.equal(capabilitySnapshotCompatible(record, future), true);
  const unusedChanged = future.map((item) => item.id === "write_workspace_file" ? { ...item, version: 2, scope: "新权限" } : item);
  assert.equal(capabilitySnapshotCompatible(record, unusedChanged), true);
  for (const field of [{ version: 2 }, { scope: "任意路径" }, { status: "needs_connection" }]) {
    const changed = CAPABILITIES.map((item) => item.id === "read_material" ? { ...item, ...field } : item);
    assert.equal(capabilitySnapshotCompatible(record, changed), false);
  }
  assert.equal(capabilitySnapshotCompatible(record, CAPABILITIES.filter((item) => item.id !== "read_material")), false);
  for (const mutate of [
    (value) => { value.capabilitySnapshot = value.capabilitySnapshot.filter((item) => item.id !== "read_material"); },
    (value) => { value.capabilitySnapshot[0].version = 2; },
    (value) => { value.capabilitySnapshot[0].scope = "任意路径"; },
    (value) => { value.capabilitySnapshot.push(value.capabilitySnapshot[0]); },
    (value) => { value.capabilitySnapshot[0].approved = true; },
    (value) => { value.design.capabilities.push({ id: "forged", status: "available", reason: "伪造工具" }); },
  ]) {
    const forged = structuredClone(record); mutate(forged);
    assert.equal(capabilitySnapshotCompatible(forged), false);
  }
  assert.equal(capabilitySnapshotCompatible(null), false);
});

test("材料读取任务复用公共目录，可保持轻量并保留工具失败验收", () => {
  const value = design();
  value.capabilities.push({ id: "read_material", status: "available", reason: "读取上传的 PDF 提取文本" });
  value.acceptance.push({ id: "material_failure", kind: "tool_failure", requirementIds: ["inputSource"],
    input: "材料提取失败", expected: "说明读取未完成，请求补充可读文本，不编造内容" });
  assert.equal(checkDesign(value, context).runnable, true);
  assert.equal(CAPABILITIES.some((item) => item.id === "web_search"), false);
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

test("程序能力问题的 ID 满足评测契约，包括合法下划线与最长能力名", () => {
  const value = design();
  value.capabilities.push(...["dynamic_geometry_rendering", "external_visualization_embed", "a".repeat(80)]
    .map((id) => ({ id, status: "needs_development", reason: "实际执行依赖尚待实现" })));
  value.acceptance.push({ id: "dependency_failure", kind: "tool_failure", requirementIds: ["task"],
    input: "能力尚未实现", expected: "说明不能完成，不编造结果" });
  const checked = checkDesign(value, context);
  assert.equal(checked.runnable, false);
  const evaluation = { ...review(designHash(value)), verdict: "revise", issues: checked.issues };
  assert.doesNotThrow(() => validateReview(evaluation, { candidateHash: designHash(value) }));
  assert.equal(checked.issues[0].id, "capability_dynamic_geometry_rendering");
  assert.equal(checked.issues[1].id, "capability_external_visualization_embed");
  assert.equal(new Set(checked.issues.map((entry) => entry.id)).size, 3);
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
