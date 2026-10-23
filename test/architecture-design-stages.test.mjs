import test from "node:test";
import assert from "node:assert/strict";
import { InputError } from "../src/requirements/core.mjs";
import { designSubmissionSchema, designHash, validateDesign } from "../src/architecture/architecture-contract.mjs";
import { createArchitectureStageSchemas, validateArchitectureBlueprint, validateArchitectureModule,
  assembleArchitectureCandidate, applyArchitectureIntegration } from "../src/architecture/architecture-design-stages.mjs";
import { validDesign, validDraft } from "./helpers/architecture.mjs";
import { validateArchitecturePlatformClaims } from "../src/architecture/architecture-platform-claims.mjs";

const fields = ["components", "steps", "capabilities", "failureHandling", "decisions", "coverage", "acceptance", "unknowns", "platformClaims"];
const changed = (value, update) => { const copy = structuredClone(value); update(copy); return copy; };
const rejected = (action, path) => assert.throws(action, error => error instanceof InputError && error.validationIssue?.path.includes(path));

function fixture({ legacy = false } = {}) {
  const requirements = [{ id: "notes", text: "接收用户给出的工作记录" }, { id: "summary", text: "输出中文工作摘要" }];
  const base = validDesign(requirements, legacy ? {} : { schemaVersion: 3,
    interaction: { defaultEntry: "conversation", page: false, operations: false, inputs: "工作记录", results: "工作摘要", persistentData: "不跨任务保存" },
    connections: [], execution: { language: "none", hosting: "builtin", reason: "使用已有文本能力" },
    selectionBasis: { capacity: "已确认的工作记录", process: "读取后整理", quality: "保留原记录", requirementIds: ["notes", "summary"], assumptions: [] },
  });
  const candidateSchema = designSubmissionSchema(legacy ? validDraft() : { taskSpec: { version: 1 } }, { requirements });
  const global = Object.fromEntries(Object.entries(base).filter(([key]) => !fields.includes(key)));
  const blueprint = { global, modules: [
    { id: "source", purpose: "读取工作记录", requirementIds: ["notes"], componentIds: ["capture"], stepIds: ["read"], dependsOn: [], inputs: "用户输入", outputs: "已知工作记录" },
    { id: "output", purpose: "整理工作摘要", requirementIds: ["summary"], componentIds: ["compose"], stepIds: ["render"], dependsOn: ["source"], inputs: "已知工作记录", outputs: "中文摘要" },
  ] };
  const modules = blueprint.modules.map((assignment, index) => ({ moduleId: assignment.id, blueprintHash: designHash(blueprint),
    instructions: index ? "仅依据已知记录生成中文摘要。" : "接收原记录，不补充未知事实。",
    components: [{ ...base.components[0], id: assignment.componentIds[0] }],
    steps: [{ ...base.steps[0], id: assignment.stepIds[0], componentId: assignment.componentIds[0], dependsOn: index ? ["read"] : [] }],
    capabilities: structuredClone(base.capabilities), failureHandling: structuredClone(base.failureHandling),
    decisions: [{ ...base.decisions[0], id: index ? "format_decision" : "input_decision" }],
    coverage: [{ requirementId: assignment.requirementIds[0], componentIds: assignment.componentIds, verification: "按该条原需求检查" }],
    acceptance: (index ? [base.acceptance[2]] : base.acceptance.slice(0, 2)).map((row) => ({ ...row, requirementIds: assignment.requirementIds })),
    unknowns: [],
  }));
  const options = { blueprint, modules, candidateSchema, requirements };
  return { ...options, options, moduleOptions: index => ({ blueprint, assignment: blueprint.modules[index], candidateSchema, requirements }) };
}

test("阶段契约派生当前v3与旧候选字段，蓝图不要求模块详细设计", () => {
  for (const legacy of [false, true]) {
    const f = fixture({ legacy }), schemas = createArchitectureStageSchemas(f);
    assert.equal(Object.hasOwn(schemas.blueprint.properties.global.properties, "components"), false);
    assert.equal(schemas.module.properties.components.minItems, 0);
    assert.equal(schemas.integration.properties.updates.minItems, 0);
    assert.deepEqual(validateArchitectureBlueprint(f.blueprint, f), f.blueprint);
    assert.deepEqual(validateArchitectureModule(f.modules[0], f.moduleOptions(0)), f.modules[0]);
    const assembled = assembleArchitectureCandidate(f.options);
    assert.deepEqual(assembled.conflicts, []);
    assert.doesNotThrow(() => validateDesign(assembled.candidate, { requirements: f.requirements }));
    assert.deepEqual(applyArchitectureIntegration({ baseHash: designHash(assembled.candidate), updates: [] }, { ...f.options, ...assembled }), assembled.candidate);
    assert.equal(Object.hasOwn(assembled.candidate, "platformClaims"), false);
  }
});

test("蓝图冻结需求归属与并行编号，拒绝遗漏、重复占用和模块依赖环", () => {
  const f = fixture();
  for (const mutate of [value => { value.modules.pop(); }, value => { value.modules[1].requirementIds = ["notes", "summary"]; }])
    rejected(() => validateArchitectureBlueprint(changed(f.blueprint, mutate), f), "requirementIds");
  rejected(() => validateArchitectureBlueprint(changed(f.blueprint, value => { value.modules[1].componentIds = ["capture"]; }), f), "componentIds");
  rejected(() => validateArchitectureBlueprint(changed(f.blueprint, value => { value.modules[0].dependsOn = ["output"]; }), f), "dependsOn");
});

test("模块成果绑定蓝图、模块身份与明确依赖，不能抢占其他模块需求", () => {
  const f = fixture();
  rejected(() => validateArchitectureModule({ ...f.modules[0], blueprintHash: "0".repeat(64) }, f.moduleOptions(0)), "blueprintHash");
  rejected(() => validateArchitectureModule(f.modules[0], { ...f.moduleOptions(0), assignment: { ...f.blueprint.modules[0], inputs: "改写输入" } }), "assignment");
  rejected(() => validateArchitectureModule(changed(f.modules[0], value => { value.steps[0].dependsOn = ["render"]; }), f.moduleOptions(0)), "dependsOn");
  rejected(() => validateArchitectureModule(changed(f.modules[1], value => { value.acceptance[0].requirementIds = ["notes"]; }), f.moduleOptions(1)), "requirementIds");
  rejected(() => validateArchitectureModule(changed(f.modules[0], value => { value.steps[0].dependsOn = ["read"]; }), f.moduleOptions(0)), "dependsOn");
});

test("并行结果按蓝图顺序拼装，共用相同能力去重且输入成果保持不变", () => {
  const f = fixture(), before = structuredClone(f.options);
  const forward = assembleArchitectureCandidate(f.options), reverse = assembleArchitectureCandidate({ ...f.options, modules: [...f.modules].reverse() });
  assert.deepEqual(reverse, forward);
  assert.deepEqual(forward.candidate.components.map(row => row.id), ["capture", "compose"]);
  assert.deepEqual(forward.candidate.steps.map(row => row.id), ["read", "render"]);
  assert.equal(forward.candidate.capabilities.length, 1);
  assert.deepEqual(f.options, before);
  rejected(() => assembleArchitectureCandidate({ ...f.options, modules: [f.modules[0], f.modules[0]] }), "modules");
  rejected(() => assembleArchitectureCandidate({ ...f.options, modules: f.modules.slice(0, 1) }), "modules");
});

test("跨模块局部编号重名按模块稳定分配全局编号，同步声明引用且不丢原始内容", () => {
  const f = fixture();
  for (const module of f.modules) {
    module.decisions[0].id = "shared_decision";
    module.acceptance[0].id = "shared_acceptance";
    module.platformClaims = [{ id: "shared_claim", source: "runtimeCapabilities", path: "/sharedFact", expected: false,
      decisionIds: ["shared_decision"], acceptanceIds: ["shared_acceptance"] }];
  }
  const before = structuredClone(f.options), assembled = assembleArchitectureCandidate(f.options);
  assert.deepEqual(assembleArchitectureCandidate({ ...f.options, modules: [...f.modules].reverse() }), assembled);
  assert.deepEqual(f.options, before);
  for (const field of ["decisions", "acceptance", "platformClaims"]) {
    assert.equal(assembled.candidate[field].length, f.modules.reduce((sum, module) => sum + module[field].length, 0));
    assert.equal(new Set(assembled.candidate[field].map(row => row.id)).size, assembled.candidate[field].length);
  }
  for (const [index, assignment] of f.blueprint.modules.entries()) {
    const claim = assembled.candidate.platformClaims[index];
    assert.equal(claim.id, `${assignment.id}__shared_claim`);
    assert.deepEqual(claim.decisionIds, [`${assignment.id}__shared_decision`]);
    assert.deepEqual(claim.acceptanceIds, [`${assignment.id}__shared_acceptance`]);
    const decision = assembled.candidate.decisions.find(row => row.id === claim.decisionIds[0]);
    assert.deepEqual({ ...decision, id: "shared_decision" }, f.modules[index].decisions[0]);
  }
  assert.doesNotThrow(() => validateArchitecturePlatformClaims(assembled.candidate, { runtimeCapabilities: { sharedFact: false } }));
  assert.doesNotThrow(() => validateDesign(assembled.candidate, { requirements: f.requirements, runtimeCapabilities: { sharedFact: false } }));
  assert.deepEqual(applyArchitectureIntegration({ baseHash: designHash(assembled.candidate), updates: [] }, { ...f.options, ...assembled }), assembled.candidate);
});

test("局部编号分配遵守80字符限制并避开原始保留编号，模块内部重复仍明确拒绝", () => {
  const f = fixture();
  for (const module of f.modules) {
    module.decisions[0].id = "shared";
    module.platformClaims = [{ id: "c".repeat(80), source: "runtimeCapabilities", path: "/sharedFact", expected: false,
      decisionIds: ["shared"], acceptanceIds: [module.acceptance[0].id] }];
  }
  f.modules[0].decisions.push({ ...f.modules[0].decisions[0], id: "source__shared" });
  const assembled = assembleArchitectureCandidate(f.options);
  assert.notEqual(assembled.candidate.decisions[0].id, "source__shared");
  assert.equal(assembled.candidate.decisions[1].id, "source__shared");
  for (const claim of assembled.candidate.platformClaims) {
    assert.ok(claim.id.length <= 80); assert.match(claim.id, /^[A-Za-z][A-Za-z0-9_-]*$/u);
    assert.ok(assembled.candidate.decisions.some(row => claim.decisionIds.includes(row.id)));
  }
  f.modules[0].platformClaims.push(structuredClone(f.modules[0].platformClaims[0]));
  assert.throws(() => assembleArchitectureCandidate(f.options), error => {
    assert.equal(error.validationIssue.reason, "duplicate_id");
    assert.equal(error.validationIssue.path, "module.platformClaims[1].id");
    assert.match(error.message, /第1项与第2项/u); return true;
  });
});

test("同编号能力不一致产生明确冲突，仅由绑定整合局部解决", () => {
  const f = fixture();
  f.modules[1].capabilities[0].status = "unverified";
  const assembled = assembleArchitectureCandidate(f.options);
  assert.deepEqual(assembled.conflicts, [{ path: "/capabilities", reason: "capability_conflict", relatedPaths: ["/capabilities/0", "/capabilities/1"], moduleIds: ["source", "output"] }]);
  const result = applyArchitectureIntegration({ baseHash: designHash(assembled.candidate), updates: [
    { path: "/capabilities", value: [assembled.candidate.capabilities[0]] },
    { path: "/instructions", value: "接收记录后生成摘要，保留未知信息。" },
  ] }, { ...f.options, ...assembled });
  assert.equal(result.capabilities.length, 1);
  assert.equal(result.instructions, "接收记录后生成摘要，保留未知信息。");
  assert.doesNotThrow(() => validateDesign(result, { requirements: f.requirements }));
  rejected(() => applyArchitectureIntegration({ baseHash: designHash(assembled.candidate), updates: [] }, { ...f.options, ...assembled }), "capabilities");
});

test("相同能力和状态的说明由程序完整合并，超长或状态不同仍保留冲突", () => {
  const f = fixture(); f.modules[1].capabilities[0].reason = "输出模块保留原记录事实";
  const before = structuredClone(f.options), merged = assembleArchitectureCandidate(f.options);
  assert.equal(merged.conflicts.length, 0); assert.equal(merged.candidate.capabilities.length, 1);
  assert.equal(merged.candidate.capabilities[0].reason, f.modules.map(module => module.capabilities[0].reason).join("\n"));
  assert.deepEqual(f.options, before);
  f.modules[0].capabilities[0].reason = "甲".repeat(1100); f.modules[1].capabilities[0].reason = "乙".repeat(1100);
  assert.equal(assembleArchitectureCandidate(f.options).conflicts[0].reason, "capability_conflict");
  assert.equal(assembleArchitectureCandidate({ ...before, mergeCapabilityReasons: false }).conflicts.length, 1);
});

test("整合绑定实际模块与冲突，禁止改写蓝图、模块内容、需求归属或重叠路径", () => {
  const f = fixture(), assembled = assembleArchitectureCandidate(f.options), options = { ...f.options, ...assembled };
  const input = updates => ({ baseHash: designHash(assembled.candidate), updates });
  rejected(() => applyArchitectureIntegration({ baseHash: "0".repeat(64), updates: [] }, options), "baseHash");
  rejected(() => applyArchitectureIntegration(input([]), { ...options, conflicts: [{ path: "/execution" }] }), "baseHash");
  for (const path of ["/profile", "/execution/language", "/components/0/purpose", "/steps/1/id", "/__proto__/polluted"])
    rejected(() => applyArchitectureIntegration(input([{ path, value: "rewritten" }]), options), "updates.path");
  rejected(() => applyArchitectureIntegration(input([{ path: "/acceptance", value: assembled.candidate.acceptance.slice(1) }]), options), "candidate.acceptance");
  const acceptance = changed(assembled.candidate.acceptance, rows => { rows[0].requirementIds = ["summary"]; });
  rejected(() => applyArchitectureIntegration(input([{ path: "/acceptance", value: acceptance }]), options), "acceptance");
  rejected(() => applyArchitectureIntegration(input([{ path: "/instructions", value: "第一项" }, { path: "/instructions", value: "第二项" }]), options), "updates.path");
});

test("全局验收不足留给整合补跨模块场景，缺失模块不能提前成为完整候选", () => {
  const f = fixture();
  f.modules[0].acceptance = f.modules[0].acceptance.slice(0, 1);
  const assembled = assembleArchitectureCandidate(f.options);
  assert.ok(assembled.conflicts.some(row => row.path === "/acceptance"));
  const acceptance = [...assembled.candidate.acceptance, { ...f.modules[0].acceptance[0], id: "missing_record", kind: "missing_input",
    requirementIds: ["notes"], input: "未提供记录", expected: "请用户提供记录" }];
  const candidate = applyArchitectureIntegration({ baseHash: designHash(assembled.candidate), updates: [{ path: "/acceptance", value: acceptance }] }, { ...f.options, ...assembled });
  assert.doesNotThrow(() => validateDesign(candidate, { requirements: f.requirements }));
  rejected(() => assembleArchitectureCandidate({ ...f.options, modules: [] }), "modules");
});

test("整合无冲突时保留模块已完成验收、失败处理、未知项及覆盖说明", () => {
  const f = fixture();
  f.modules[0].unknowns = [{ question: "仍需验证实际输入规模", blocking: true, resolution: "在真实验收中核实" }];
  const assembled = assembleArchitectureCandidate(f.options), options = { ...f.options, ...assembled };
  const input = updates => ({ baseHash: designHash(assembled.candidate), updates });
  const acceptance = changed(assembled.candidate.acceptance, rows => { rows[0].expected = "只要求能返回文字"; });
  rejected(() => applyArchitectureIntegration(input([{ path: "/acceptance", value: acceptance }]), options), "acceptance");
  rejected(() => applyArchitectureIntegration(input([{ path: "/unknowns", value: [] }]), options), "unknowns");
  rejected(() => applyArchitectureIntegration(input([{ path: "/failureHandling", value: [{ scenario: "任意情况", response: "结束处理" }] }]), options), "failureHandling");
  const coverage = changed(assembled.candidate.coverage, rows => { rows[0].verification = "只做文本检查"; });
  rejected(() => applyArchitectureIntegration(input([{ path: "/coverage", value: coverage }]), options), "coverage");
  const failures = [...assembled.candidate.failureHandling, { scenario: "跨模块输入缺失", response: "保留已完成模块并报告缺失来源" }];
  const result = applyArchitectureIntegration(input([{ path: "/failureHandling", value: failures }]), options);
  assert.deepEqual(result.failureHandling, failures);
  assert.deepEqual(result.unknowns, assembled.candidate.unknowns);
});

test("模块验收一次列出全部主责缺项，诊断只包含宿主正式编号", () => {
  const f = fixture();
  f.modules[0].acceptance = [];
  assert.throws(() => validateArchitectureModule(f.modules[0], f.moduleOptions(0)), error => {
    assert.deepEqual(error.validationIssue, { path: "module.acceptance", reason: "missing_coverage", allowedReferences: ["notes"], missingReferences: ["notes"] });
    return true;
  });
});

test("未使用组件明确列出缺失编号，不能只返回笼统格式或引用错误", () => {
  const f = fixture();
  f.blueprint.modules[0].componentIds.push("calculate");
  f.modules[0].components.push({ ...f.modules[0].components[0], id: "calculate" });
  f.modules[0].blueprintHash = designHash(f.blueprint);
  assert.throws(() => validateArchitectureModule(f.modules[0], f.moduleOptions(0)), error => {
    assert.equal(error.validationIssue.reason, "component_unused");
    assert.deepEqual(error.validationIssue.missingReferences, ["calculate"]);
    assert.deepEqual(error.validationIssue.allowedReferences, ["capture", "calculate"]);
    assert.match(error.message, /步骤/u); return true;
  });
});

test("阶段JSON校验不执行访问器，错误不会复制任意提交值", () => {
  const f = fixture(); let accessed = false;
  const module = { ...f.modules[0] };
  Object.defineProperty(module, "instructions", { enumerable: true, get() { accessed = true; throw new Error("fixture-private-value"); } });
  assert.throws(() => validateArchitectureModule(module, f.moduleOptions(0)), error => error instanceof InputError && !error.message.includes("fixture-private-value"));
  assert.equal(accessed, false);
  const circular = { ...f.modules[0] }; circular.unknowns = [circular];
  rejected(() => validateArchitectureModule(circular, f.moduleOptions(0)), "module");
});
