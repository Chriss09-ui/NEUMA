import { callFixture } from "../helpers/m7-test-boundaries.mjs";
import type { ArchitectureGlobal } from "../../src/contracts/architecture-stages.mjs";
import type { TestFailure } from "../helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { InputError } from "../../src/requirements/core.mjs";
import { designSubmissionSchema, designHash, validateDesign } from "../../src/architecture/architecture-contract.mjs";
import { createArchitectureStageSchemas, validateArchitectureBlueprint, validateArchitectureModule,
  assembleArchitectureCandidate, applyArchitectureIntegration, diagnoseBlueprintAssignments } from "../../src/architecture/architecture-design-stages.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import { validDesign, validDraft } from "../helpers/architecture.mjs";
import { validateArchitecturePlatformClaims } from "../../src/architecture/architecture-platform-claims.mjs";
import type { ArchitectureBlueprint,ArchitectureModule,CandidateDraft,ArchitectureConflict } from "../../src/contracts/architecture-stages.mjs";
import type { ArchitectureAcceptance } from "../../src/contracts/architecture.mjs";
import type { AcceptanceVerification } from "../../src/contracts/verification.mjs";

const fields = ["components", "steps", "capabilities", "failureHandling", "decisions", "coverage", "acceptance", "unknowns", "platformClaims"] as const;
const changed = <T,>(value: T, update: (copy: NoInfer<T>) => void): T => { const copy = structuredClone(value); update(copy); return copy; };
const rejected = (action: () => unknown, path: string) => assert.throws(action, (error: TestFailure) => error instanceof InputError && error.validationIssue?.path.includes(path));

function fixture({ legacy = false } = {}) {
  const requirements = [{ id: "notes", text: "接收用户给出的工作记录" }, { id: "summary", text: "输出中文工作摘要" }];
  const base = validDesign(requirements, legacy ? {} : { schemaVersion: 3,
    interaction: { defaultEntry: "conversation", page: false, operations: false, inputs: "工作记录", results: "工作摘要", persistentData: "不跨任务保存" },
    connections: [], execution: { language: "none", hosting: "builtin", reason: "使用已有文本能力" },
    selectionBasis: { capacity: "已确认的工作记录", process: "读取后整理", quality: "保留原记录", requirementIds: ["notes", "summary"], assumptions: [] },
  });
  const candidateSchema = designSubmissionSchema(legacy ? validDraft() : { taskSpec: { version: 1 } }, { requirements });
  const global = Object.fromEntries(Object.entries(base).filter(([key]) => !fields.some(field => field === key))) as Omit<typeof base, typeof fields[number]>;
  const blueprint: ArchitectureBlueprint = { global, modules: [
    { id: "source", purpose: "读取工作记录", requirementIds: ["notes"], componentIds: ["capture"], stepIds: ["read"], dependsOn: [], inputs: "用户输入", outputs: "已知工作记录" },
    { id: "output", purpose: "整理工作摘要", requirementIds: ["summary"], componentIds: ["compose"], stepIds: ["render"], dependsOn: ["source"], inputs: "已知工作记录", outputs: "中文摘要" },
  ] };
  const modules: ArchitectureModule[] = blueprint.modules.map((assignment, index) => ({ moduleId: assignment.id, blueprintHash: designHash(blueprint),
    instructions: index ? "仅依据已知记录生成中文摘要。" : "接收原记录，不补充未知事实。",
    components: [{ ...base.components[0]!, id: assignment.componentIds![0]! }],
    steps: [{ ...base.steps[0]!, id: assignment.stepIds![0]!, componentId: assignment.componentIds![0]!, dependsOn: index ? ["read"] : [] }],
    capabilities: structuredClone(base.capabilities), failureHandling: structuredClone(base.failureHandling),
    decisions: [{ ...base.decisions[0]!, id: index ? "format_decision" : "input_decision" }],
    coverage: [{ requirementId: assignment.requirementIds[0]!, componentIds: assignment.componentIds!, verification: "按该条原需求检查" }],
    acceptance: (index ? [base.acceptance[2]!] : base.acceptance.slice(0, 2)).map((row) => ({ ...row, requirementIds: assignment.requirementIds })),
    unknowns: [],
  }));
  const options = { blueprint, modules, candidateSchema, requirements, legacyBlueprint: true };
  return { ...options, options, moduleOptions: (index: number) => ({ ...options, assignment: blueprint.modules[index]! }) };
}

function boundaryFixture() {
  const f = fixture();
  for (const assignment of f.blueprint.modules) { Reflect.deleteProperty(assignment, "componentIds"); Reflect.deleteProperty(assignment, "stepIds"); }
  for (const module of f.modules) module.blueprintHash = designHash(f.blueprint);
  f.modules![1]!.steps[0]!.dependsOn = [{ moduleId: "source", id: "read" }];
  const options = { ...f.options, legacyBlueprint: false };
  return { ...options, options, moduleOptions: (index: number) => ({ ...options, assignment: f.blueprint.modules[index]!, dependencyModules: f.modules.slice(0, index!) }) };
}

function obligationFixture() {
  const f = boundaryFixture();
  const requirements = ["inputSource", "task", "deliverable", "verification_execution"].map(id => ({ id, text: `已确认要求 ${id}` }));
  f.blueprint.global.profile = "custom";
  f.blueprint.global.execution = { language: "javascript", hosting: "builtin", reason: "执行专属统计动作" };
  f.blueprint.global.interaction!.operations = true;
  f.blueprint.global.selectionBasis!.requirementIds = requirements.map(row => row.id);
  f.blueprint.modules[0]!.requirementIds = ["inputSource"];
  f.blueprint.modules[1]!.requirementIds = ["task", "deliverable", "verification_execution"];
  const draft = { interaction: { defaultEntry: "conversation", page: false, operations: ["统计"] } };
  const context = { ...f, requirements, draft, candidateSchema: designSubmissionSchema({ taskSpec: { version: 1 } }, { requirements }),
    deferredVerifications: { issues: [{ requirementId: "verification_execution", stage: "development" }] } };
  for (const [index, module] of f.modules.entries()) {
    const ids = f.blueprint.modules[index]!.requirementIds;
    module.blueprintHash = designHash(f.blueprint);
    module.coverage = ids.map(requirementId => ({ requirementId, componentIds: [module.components[0]!.id], verification: "核对本模块已确认的要求" }));
    module.acceptance = (index ? ["success", "tool_failure"] as const : ["missing_input", "boundary"] as const).map((kind, row) => ({
      id: `${module.moduleId}_acceptance_${row}`, kind, requirementIds: ids.filter(id => id !== "verification_execution"),
      input: kind === "tool_failure" ? "统计执行器明确返回执行失败" : "冻结的业务输入",
      expected: kind === "tool_failure" ? "如实返回执行失败，不声称已得到统计结果" : "返回符合该要求的具体结果或拒绝说明",
      verification: { stage: "development", owner: "generated-code", adapterId: "action" },
    }));
    if (index) {
      module.capabilities = [{ id: "statistics_code", status: "needs_development", reason: "实现统计代码" }];
      module.acceptance.push({ id: "verify_execution", kind: "success", requirementIds: ["verification_execution"],
        input: "开发阶段执行冻结验证用例", expected: "按原义务核对真实执行结果，失败阻止交付",
        verification: { stage: "development", owner: "generated-code", adapterId: "action" } });
    }
  }
  return { ...context, moduleOptions: (index: number) => ({ ...context, blueprint: f.blueprint,
    assignment: f.blueprint.modules[index]!, dependencyModules: f.modules.slice(0, index) }) };
}

test("模块提交前拒绝自己负责的验收类型、真实动作、原阶段及必填清单缺项", async t => {
  const cases: { name: string; index: number; path: string; change(module: ArchitectureModule): void }[] = [
    ...["missing_input", "boundary"].map(kind => ({ name: `缺少${kind}`, index: 0, path: "module.acceptance",
      change(module: ArchitectureModule) { module.acceptance = module.acceptance.filter(row => row.kind !== kind); } })),
    ...["success", "tool_failure"].map(kind => ({ name: `缺少${kind}`, index: 1, path: "module.acceptance",
      change(module: ArchitectureModule) { for (const row of module.acceptance) if (row.kind === kind) row.kind = "boundary"; } })),
    { name: "业务计算不能只留运行期观察", index: 1, path: "module.acceptance", change(module) {
      for (const row of module.acceptance) if (row.requirementIds.includes("task"))
        row.verification = { stage: "runtime", owner: "conversation", adapterId: "conversation" };
    } },
    { name: "后续义务不能改变原验证阶段", index: 1, path: "module.acceptance", change(module) {
      module.acceptance.find(row => row.id === "verify_execution")!.verification = { stage: "activation", owner: "platform", adapterId: "host-business" };
    } },
    { name: "能力清单必须有负责模块", index: 0, path: "module.capabilities", change(module) { module.capabilities = []; } },
    { name: "设计决策必须有负责模块", index: 1, path: "module.decisions", change(module) { module.decisions = []; } },
    { name: "失败处理必须有负责模块", index: 1, path: "module.failureHandling", change(module) { module.failureHandling = []; } },
  ];
  const baseline = obligationFixture();
  for (const [index, module] of baseline.modules.entries()) assert.doesNotThrow(() => validateArchitectureModule(module, baseline.moduleOptions(index)));
  for (const scenario of cases) await t.test(scenario.name, () => {
    const f = obligationFixture(), module = structuredClone(f.modules[scenario.index]!);
    scenario.change(module);
    assert.throws(() => validateArchitectureModule(module, f.moduleOptions(scenario.index)), error => {
      const issue = (objectFields(error).validationIssues as { path: string; ownerModuleId?: string }[]).find(issue => issue.path === scenario.path);
      assert.ok(issue); assert.equal(issue.ownerModuleId, module.moduleId);
      return true;
    });
  });
});

test("纯工具方案由选用能力的模块提交失败验收，不追补已完成兄弟模块", () => {
  const f = boundaryFixture();
  const input = f.modules[0]!;
  input.capabilities.push({ id: "write_workspace_file", status: "available", reason: "保存输入记录" });
  assert.throws(() => validateArchitectureModule(input, f.moduleOptions(0)), error => {
    assert.deepEqual(objectFields(error).validationIssue, { path: "module.acceptance", reason: "missing_acceptance_kind",
      missingKinds: ["tool_failure"], ownerModuleId: "source" });
    return true;
  });
  input.acceptance.push({ id: "input_save_failure", kind: "tool_failure", requirementIds: ["notes"],
    input: "文件工具明确返回写入失败", expected: "如实报告写入失败，不声称已经保存",
    verification: { stage: "runtime", owner: "conversation", adapterId: "conversation" } });
  assert.doesNotThrow(() => validateArchitectureModule(input, f.moduleOptions(0)));
  assert.doesNotThrow(() => validateArchitectureModule(f.modules[1], f.moduleOptions(1)));
  assert.doesNotThrow(() => validateDesign(assembleArchitectureCandidate(f).candidate, { requirements: f.requirements }));
});

test("连接协议缺项在蓝图提交时报告，不能留给无连接修改权限的整合节点", () => {
  const f = boundaryFixture();
  f.blueprint.global.connections = [{ id: "business_api", purpose: "business", required: true, description: "业务接口",
    protocol: "http", operations: [{ id: "fetch" }] }];
  rejected(() => validateArchitectureBlueprint(f.blueprint, f), "blueprint.global.connections[0]");
  f.blueprint.global.connections[0]!.operations[0] = { id: "fetch", method: "GET", path: "/records" };
  assert.doesNotThrow(() => validateArchitectureBlueprint(f.blueprint, f));
  f.blueprint.global.connections.push(structuredClone(f.blueprint.global.connections[0]!));
  rejected(() => validateArchitectureBlueprint(f.blueprint, f), "blueprint.global.connections[1].id");
});

test("结构合法模块一次报告版本、未用组件、覆盖、验收和能力等独立错误", () => {
  const f = boundaryFixture(), module = structuredClone(f.modules[0]!);
  module.blueprintHash = "0".repeat(64);
  module.components.push({ ...module.components[0]!, id: "unused_component" });
  module.coverage[0]!.componentIds = ["missing_component"];
  module.acceptance = []; module.capabilities[0]!.id = "invented_capability";
  assert.throws(() => validateArchitectureModule(module, f.moduleOptions(0)), error => {
    const issues = objectFields(error).validationIssues as { path: string }[];
    assert.deepEqual(issues.map(issue => issue.path), ["module.blueprintHash", "module.steps.componentId",
      "module.coverage[0].componentIds", "module.acceptance", "module.capabilities[0].id"]);
    assert.equal(objectFields(error).validationIssueTotal, 5); return true;
  });
});

test("蓝图在派模块前同时拒绝交互与运行组合矛盾，模块在整合前拒绝全部伪可用编号", () => {
  const f = boundaryFixture();
  const schemaHash = designHash(createArchitectureStageSchemas(f));
  const bad = changed(f.blueprint, value => {
    value.global.profile = "workflow";
    value.global.interaction!.assistant = { enabled: true, purpose: "普通对话统计" };
  });
  assert.throws(() => validateArchitectureBlueprint(bad, f), (error: TestFailure) => {
    const paths = (objectFields(error).validationIssues as { path: string }[]).map(item => item.path);
    assert.ok(paths.includes("blueprint.global.interaction.assistant"));
    assert.ok(paths.includes("blueprint.global.execution.hosting"));
    return true;
  });
  const module = changed(f.modules[0]!, value => {
    value.capabilities = [{ id: "invented_conversation", status: "available", reason: "错误别名" },
      { id: "invented_host", status: "available", reason: "错误平台编号" },
      { id: "custom_validation_code", status: "needs_development", reason: "专属代码需研发" }];
  });
  assert.throws(() => validateArchitectureModule(module, f.moduleOptions(0)), (error: TestFailure) => {
    const issues = objectFields(error).validationIssues as { path: string; allowedReferences?: string[]; missingKinds?: string[] }[];
    assert.deepEqual(issues.map(item => item.path), ["module.capabilities[0].id", "module.capabilities[1].id", "module.acceptance"]);
    assert.ok(issues.slice(0, 2).every(item => item.allowedReferences!.includes("conversation")));
    assert.deepEqual(issues[2]!.missingKinds, ["tool_failure"], "选用新能力还应在本模块核对对应失败验收");
    return true;
  });
  assert.equal(designHash(createArchitectureStageSchemas(f)), schemaHash, "语义校验不改变历史阶段schema摘要");
});

test("蓝图保持已确认入口与助手选择，专属代码动作可以使用custom和builtin", () => {
  const f = boundaryFixture();
  const blueprint = changed(f.blueprint, value => {
    value.global.profile = "custom"; value.global.execution!.language = "javascript"; value.global.interaction!.operations = true;
  });
  const draft = { interaction: { defaultEntry: "conversation", page: false, operations: ["统计"] } };
  assert.deepEqual(validateArchitectureBlueprint(blueprint, { ...f, draft }), blueprint);
  const changedChoice = changed(blueprint, value => { value.global.interaction!.page = true; value.global.interaction!.defaultEntry = "application"; });
  rejected(() => validateArchitectureBlueprint(changedChoice, { ...f, draft }), "interaction.defaultEntry");
});

test("全局选型引用不替代模块主责，缺失、重复和未知编号同时明确报告", () => {
  const f = boundaryFixture();
  const missing = changed(f.blueprint, value => { value.modules.pop(); });
  const before = structuredClone(missing);
  const report = diagnoseBlueprintAssignments(missing, f.requirements)!;
  assert.deepEqual(report.missing, [{ id: "summary", referencedGlobally: true }]);
  assert.deepEqual(report.totals, { missing: 1, duplicates: 0, unknown: 0 });
  assert.equal(report.truncated, false);
  assert.throws(() => validateArchitectureBlueprint(missing, f), error => {
    assert.deepEqual(objectFields(error).blueprintAllocation, report);
    assert.equal(objectFields(objectFields(error).validationIssue).path, "blueprint.modules.requirementIds");
    return true;
  });
  assert.deepEqual(missing, before, "诊断不猜测主责、不修改候选");
  const mixed = changed(f.blueprint, value => {
    value.modules[0]!.requirementIds = ["notes", "unknown_requirement"];
    value.modules[1]!.requirementIds = ["notes"];
  });
  const all = diagnoseBlueprintAssignments(mixed, f.requirements)!;
  assert.deepEqual(all.missing, [{ id: "summary", referencedGlobally: true }]);
  assert.deepEqual(all.duplicates, [{ id: "notes", moduleIndexes: [0, 1], occurrences: 2 }]);
  assert.deepEqual(all.unknown, [{ id: "unknown_requirement", moduleIndexes: [0], occurrences: 1 }]);
  assert.throws(() => validateArchitectureBlueprint(mixed, f), error => {
    assert.deepEqual(objectFields(error).blueprintAllocation, all); return true;
  });
});

test("主责诊断有界并保留真实总数，不回显任意坏参数或执行访问器", () => {
  const requirements = Array.from({ length: 254 }, (_, i) => ({ id: `req_${i}_${"x".repeat(60)}`, text: "原要求" }));
  const report = diagnoseBlueprintAssignments({ modules: [{ requirementIds: [requirements[0]!.id] }] }, requirements)!;
  assert.equal(report.totals.missing, 253); assert.equal(report.requiredCount, 254);
  assert.equal(report.truncated, true); assert.ok(report.missing.length < 253);
  assert.ok(JSON.stringify(report).length < 6000);
  assert.equal(diagnoseBlueprintAssignments({ modules: [{ requirementIds: ["private arbitrary payload"] }] }, requirements), null);
  let touched = false;
  assert.equal(diagnoseBlueprintAssignments({ get modules() { touched = true; return []; } }, requirements), null);
  assert.equal(touched, false);
});

test("新蓝图只声明模块边界，模块可补齐第四组件的执行步骤", () => {
  const f = boundaryFixture(), schemas = createArchitectureStageSchemas(f);
  assert.equal(Object.hasOwn(schemas.blueprint.properties.modules.items.properties, "componentIds"), false);
  assert.equal(Object.hasOwn(schemas.blueprint.properties.modules.items.properties, "stepIds"), false);
  assert.deepEqual(validateArchitectureBlueprint(f.blueprint, f), f.blueprint);
  rejected(() => validateArchitectureBlueprint(changed(f.blueprint, (value) => { value.modules[0]!.stepIds = ["read"]; }), f), "blueprint.modules[0]");
  const module = f.modules[0];
  for (const id of ["concept", "calculate", "stability"]) module!.components!.push({ ...module!.components![0]!, id });
  for (const id of ["calculate", "stability"]) module!.steps!.push({ ...module!.steps![0]!, id, componentId: id });
  assert.throws(() => validateArchitectureModule(module, callFixture(Reflect.apply, Reflect, [f.moduleOptions, f, [0]])), (error: TestFailure) => error.validationIssue?.reason === "component_unused");
  module!.steps!.push({ ...module!.steps![0]!, id: "classify_concept", componentId: "concept", dependsOn: ["read"] });
  assert.deepEqual(validateArchitectureModule(module, f.moduleOptions(0)), module);
  const assembled = assembleArchitectureCandidate(f.options);
  assert.equal(assembled.candidate.steps.length, 5);
  assert.doesNotThrow(() => validateDesign(assembled.candidate, { requirements: f.requirements }));
});

test("跨模块引用只接受已声明直接依赖的真实成果，本地引用不能猜上游编号", () => {
  const f = boundaryFixture();
  assert.deepEqual(validateArchitectureModule(f.modules[1], f.moduleOptions(1)), f.modules[1]);
  for (const ref of ["read", { moduleId: "source", id: "missing" }, { moduleId: "stranger", id: "read" }, { moduleId: "output", id: "render" }])
    rejected(() => validateArchitectureModule(changed(f.modules[1], (module) => { module!.steps[0]!.dependsOn = [ref]; }), f.moduleOptions(1)), "dependsOn");
  rejected(() => validateArchitectureModule(f.modules[1], { ...f.moduleOptions(1), dependencyModules: [] }), "dependencies");
  rejected(() => validateArchitectureModule(changed(f.modules[0], (module) => { module!.steps[0]!.dependsOn = ["read"]; }), f.moduleOptions(0)), "dependsOn");
  rejected(() => validateArchitectureModule(changed(f.modules[1], (module) => { module!.coverage[0]!.componentIds = [{ moduleId: "source", id: "missing" }]; }), f.moduleOptions(1)), "componentIds");
  f.modules![1]!.coverage[0]!.componentIds.push({ moduleId: "source", id: "capture" });
  assert.deepEqual(assembleArchitectureCandidate!(f.options).candidate.coverage[1]!.componentIds, ["compose", "capture"]);
});

test("模块内部组件和步骤可以同名，拼装区分所有者并同步本地及跨模块引用", () => {
  const f = boundaryFixture();
  for (const module of f.modules) {
    module.components![0]!.id = "common"; module.steps![0]!.id = "execute";
    module.steps![0]!.componentId = "common"; module.coverage![0]!.componentIds = ["common"];
  }
  f.modules![1]!.steps[0]!.dependsOn = [{ moduleId: "source", id: "execute" }];
  f.modules![1]!.coverage[0]!.componentIds.push({ moduleId: "source", id: "common" });
  const before = structuredClone(f.options), { candidate } = assembleArchitectureCandidate(f.options);
  assert.deepEqual(candidate.components.map(row => row.id), ["source__common", "output__common"]);
  assert.deepEqual(candidate.steps.map(row => row.componentId), ["source__common", "output__common"]);
  assert.deepEqual(candidate.steps![1]!.dependsOn, ["source__execute"]);
  assert.deepEqual(candidate.coverage![1]!.componentIds, ["output__common", "source__common"]);
  assert.deepEqual(f.options, before);
  assert.deepEqual(assembleArchitectureCandidate({ ...f.options, modules: [...f.modules].reverse() }).candidate, candidate);
  assert.doesNotThrow(() => validateDesign(candidate, { requirements: f.requirements }));
  rejected(() => validateArchitectureModule(changed(f.modules[0], (module) => { callFixture(module!.components.push, module!.components, [module!.components[0]]); }), f.moduleOptions(0)), "components");
});

test("整合也不能新增未经蓝图授权的跨模块覆盖", () => {
  const f = boundaryFixture(), assembled = assembleArchitectureCandidate(f.options);
  rejected(() => applyArchitectureIntegration({ baseHash: designHash(assembled.candidate), updates: [
    { path: "/coverage/0/componentIds", value: ["capture", "compose"] },
  ] }, { ...f.options, ...assembled }), "coverage.componentIds");
});

test("阶段契约派生当前v3与旧候选字段，蓝图不要求模块详细设计", () => {
  for (const legacy of [false, true]) {
    const f = fixture({ legacy }), schemas = createArchitectureStageSchemas(f);
    assert.equal(Object.hasOwn(schemas.blueprint.properties.global.properties, "components"), false);
    assert.equal(schemas.module.properties.components!.minItems, 0);
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
  for (const mutate of [(value) => { value.modules.pop(); }, (value) => { value.modules[1]!.requirementIds = ["notes", "summary"]; }] satisfies ((value: ArchitectureBlueprint) => void)[])
    rejected(() => validateArchitectureBlueprint(changed(f.blueprint, mutate), f), "requirementIds");
  rejected(() => validateArchitectureBlueprint(changed(f.blueprint, (value) => { value.modules[1]!.componentIds = ["capture"]; }), f), "componentIds");
  rejected(() => validateArchitectureBlueprint(changed(f.blueprint, (value) => { value.modules[0]!.dependsOn = ["output"]; }), f), "dependsOn");
});

test("模块成果绑定蓝图、模块身份与明确依赖，不能抢占其他模块需求", () => {
  const f = fixture();
  rejected(() => validateArchitectureModule({ ...f.modules[0]!, blueprintHash: "0".repeat(64) }, f.moduleOptions(0)), "blueprintHash");
  rejected(() => validateArchitectureModule(f.modules[0], { ...f.moduleOptions(0), assignment: { ...f.blueprint.modules[0]!, inputs: "改写输入" } }), "assignment");
  rejected(() => validateArchitectureModule(changed(f.modules[0], (value) => { value!.steps[0]!.dependsOn = ["render"]; }), f.moduleOptions(0)), "dependsOn");
  rejected(() => validateArchitectureModule(changed(f.modules[1], (value) => { value!.acceptance[0]!.requirementIds = ["notes"]; }), f.moduleOptions(1)), "requirementIds");
  rejected(() => validateArchitectureModule(changed(f.modules[0], (value) => { value!.steps[0]!.dependsOn = ["read"]; }), f.moduleOptions(0)), "dependsOn");
});

test("并行结果按蓝图顺序拼装，共用相同能力去重且输入成果保持不变", () => {
  const f = fixture(), before = structuredClone(f.options);
  const forward = assembleArchitectureCandidate(f.options), reverse = assembleArchitectureCandidate({ ...f.options, modules: [...f.modules].reverse() });
  assert.deepEqual(reverse, forward);
  assert.deepEqual(forward.candidate.components.map(row => row.id), ["capture", "compose"]);
  assert.deepEqual(forward.candidate.steps.map(row => row.id), ["read", "render"]);
  assert.equal(forward.candidate.capabilities.length, 1);
  assert.deepEqual(f.options, before);
  rejected(() => assembleArchitectureCandidate({ ...f.options, modules: [f.modules[0]!, f.modules[0]!] }), "modules");
  rejected(() => assembleArchitectureCandidate({ ...f.options, modules: f.modules.slice(0, 1) }), "modules");
});

test("跨模块局部编号重名按模块稳定分配全局编号，同步声明引用且不丢原始内容", () => {
  const f = fixture();
  for (const module of f.modules) {
    module.decisions![0]!.id = "shared_decision";
    module.acceptance![0]!.id = "shared_acceptance";
    module.platformClaims = [{ id: "shared_claim", source: "runtimeCapabilities", path: "/sharedFact", expected: false,
      decisionIds: ["shared_decision"], acceptanceIds: ["shared_acceptance"] }];
  }
  const before = structuredClone(f.options), assembled = assembleArchitectureCandidate(f.options);
  assert.deepEqual(assembleArchitectureCandidate({ ...f.options, modules: [...f.modules].reverse() }), assembled);
  assert.deepEqual(f.options, before);
  for (const field of ["decisions", "acceptance", "platformClaims"] as const) {
    assert.equal(assembled.candidate[field]!.length, f.modules.reduce((sum, module) => sum + module[field]!.length, 0));
    assert.equal(new Set(assembled.candidate[field]!.map((row) => row.id)).size, assembled.candidate[field]!.length);
  }
  for (const [index, assignment] of f.blueprint.modules.entries()) {
    const claim = assembled.candidate!.platformClaims![index];
    assert.equal(claim!.id!, `${assignment.id}__shared_claim`);
    assert.deepEqual(claim!.decisionIds!, [`${assignment.id}__shared_decision`]);
    assert.deepEqual(claim!.acceptanceIds!, [`${assignment.id}__shared_acceptance`]);
    const decision = assembled.candidate.decisions.find(row => row.id === claim!.decisionIds![0]);
    assert.deepEqual({ ...decision!, id: "shared_decision" }, f.modules![index]!.decisions[0]);
  }
  assert.doesNotThrow(() => validateArchitecturePlatformClaims(assembled.candidate, { runtimeCapabilities: { sharedFact: false } }));
  assert.doesNotThrow(() => validateDesign(assembled.candidate, { requirements: f.requirements, runtimeCapabilities: { sharedFact: false } }));
  assert.deepEqual(applyArchitectureIntegration({ baseHash: designHash(assembled.candidate), updates: [] }, { ...f.options, ...assembled }), assembled.candidate);
});

test("局部编号分配遵守80字符限制并避开原始保留编号，模块内部重复仍明确拒绝", () => {
  const f = fixture();
  for (const module of f.modules) {
    module.decisions![0]!.id = "shared";
    module.platformClaims = [{ id: "c".repeat(80), source: "runtimeCapabilities", path: "/sharedFact", expected: false,
      decisionIds: ["shared"], acceptanceIds: [module.acceptance![0]!.id] }];
  }
  f.modules![0]!.decisions.push({ ...f.modules![0]!.decisions[0]!, id: "source__shared" });
  const assembled = assembleArchitectureCandidate(f.options);
  assert.notEqual(assembled.candidate!.decisions[0]!.id, "source__shared");
  assert.equal(assembled.candidate!.decisions[1]!.id, "source__shared");
  for (const claim of assembled.candidate!.platformClaims!) {
    assert.ok(claim.id.length <= 80); assert.match(claim.id, /^[A-Za-z][A-Za-z0-9_-]*$/u);
    assert.ok(assembled.candidate.decisions.some(row => claim.decisionIds.includes(row.id)));
  }
  f.modules![0]!.platformClaims!.push(structuredClone(f.modules![0]!.platformClaims![0])!);
  assert.throws(() => callFixture(assembleArchitectureCandidate, undefined, [f.options]), (error: TestFailure) => {
    assert.equal(error.validationIssue!.reason, "duplicate_id");
    assert.equal(error.validationIssue!.path, "module.platformClaims[1].id");
    assert.match(error.message, /第1项与第2项/u); return true;
  });
});

test("同编号能力不一致产生明确冲突，仅由绑定整合局部解决", () => {
  const f = fixture();
  f.modules![1]!.capabilities[0]!.status = "unverified";
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
  const f = fixture(); f.modules![1]!.capabilities[0]!.reason = "输出模块保留原记录事实";
  const before = structuredClone(f.options), merged = assembleArchitectureCandidate(f.options);
  assert.equal(merged.conflicts.length, 0); assert.equal(merged.candidate.capabilities.length, 1);
  assert.equal(merged.candidate!.capabilities[0]!.reason, f.modules.map(module => module.capabilities![0]!.reason).join("\n"));
  assert.deepEqual(f.options, before);
  f.modules![0]!.capabilities[0]!.reason = "甲".repeat(1100); f.modules![1]!.capabilities[0]!.reason = "乙".repeat(1100);
  assert.equal(assembleArchitectureCandidate!(f.options).conflicts[0]!.reason, "capability_conflict");
  assert.equal(assembleArchitectureCandidate({ ...before, mergeCapabilityReasons: false }).conflicts.length, 1);
});

test("整合绑定实际模块与冲突，禁止改写蓝图、模块内容、需求归属或重叠路径", () => {
  const f = fixture(), assembled = assembleArchitectureCandidate(f.options), options = { ...f.options, ...assembled };
  const input = (updates: unknown) => ({ baseHash: designHash(assembled.candidate), updates });
  rejected(() => applyArchitectureIntegration({ baseHash: "0".repeat(64), updates: [] }, options), "baseHash");
  rejected(() => callFixture(applyArchitectureIntegration, undefined, [input([]), { ...options, conflicts: [{ path: "/execution" }] }]), "baseHash");
  for (const path of ["/profile", "/execution/language", "/components/0/purpose", "/steps/1/id", "/__proto__/polluted"])
    rejected(() => applyArchitectureIntegration(input([{ path, value: "rewritten" }]), options), "updates.path");
  rejected(() => applyArchitectureIntegration(input([{ path: "/acceptance", value: assembled.candidate.acceptance.slice(1) }]), options), "candidate.acceptance");
  const acceptance = changed(assembled.candidate.acceptance, (rows) => { rows[0]!.requirementIds = ["summary"]; });
  rejected(() => applyArchitectureIntegration(input([{ path: "/acceptance", value: acceptance }]), options), "acceptance");
  rejected(() => applyArchitectureIntegration(input([{ path: "/instructions", value: "第一项" }, { path: "/instructions", value: "第二项" }]), options), "updates.path");
});

test("模块漏验收在组装前指明原责任，缺失模块不能提前成为完整候选", () => {
  const f = fixture();
  const original = structuredClone(f.modules[0]!.acceptance);
  f.modules![0]!.acceptance = f.modules![0]!.acceptance.slice(0, 1);
  assert.throws(() => assembleArchitectureCandidate(f.options), error => {
    assert.deepEqual(objectFields(error).validationIssue, { path: "module.acceptance", reason: "missing_acceptance_kind",
      missingKinds: ["missing_input"], ownerModuleId: "source" });
    return true;
  });
  f.modules[0]!.acceptance = original;
  assert.doesNotThrow(() => validateDesign(assembleArchitectureCandidate(f.options).candidate, { requirements: f.requirements }));
  rejected(() => assembleArchitectureCandidate({ ...f.options, modules: [] }), "modules");
});

test("整合无冲突时保留模块已完成验收、失败处理、未知项及覆盖说明", () => {
  const f = fixture();
  f.modules![0]!.unknowns = [{ question: "仍需验证实际输入规模", blocking: true, resolution: "在真实验收中核实" }];
  const assembled = assembleArchitectureCandidate(f.options), options = { ...f.options, ...assembled };
  const input = (updates: unknown) => ({ baseHash: designHash(assembled.candidate), updates });
  const acceptance = changed(assembled.candidate.acceptance, (rows) => { rows[0]!.expected = "只要求能返回文字"; });
  rejected(() => applyArchitectureIntegration(input([{ path: "/acceptance", value: acceptance }]), options), "acceptance");
  rejected(() => applyArchitectureIntegration(input([{ path: "/unknowns", value: [] }]), options), "unknowns");
  rejected(() => applyArchitectureIntegration(input([{ path: "/failureHandling", value: [{ scenario: "任意情况", response: "结束处理" }] }]), options), "failureHandling");
  const coverage = changed(assembled.candidate.coverage, (rows) => { rows[0]!.verification = "只做文本检查"; });
  rejected(() => applyArchitectureIntegration(input([{ path: "/coverage", value: coverage }]), options), "coverage");
  const failures = [...assembled.candidate.failureHandling, { scenario: "跨模块输入缺失", response: "保留已完成模块并报告缺失来源" }];
  const result = applyArchitectureIntegration(input([{ path: "/failureHandling", value: failures }]), options);
  assert.deepEqual(result.failureHandling, failures);
  assert.deepEqual(result.unknowns, assembled.candidate.unknowns);
});

test("模块验收一次列出全部主责缺项，诊断只包含宿主正式编号", () => {
  const f = fixture();
  f.modules![0]!.acceptance = [];
  assert.throws(() => validateArchitectureModule(f.modules[0], callFixture(Reflect.apply, Reflect, [f.moduleOptions, f, [0]])), (error: TestFailure) => {
    assert.deepEqual(error.validationIssue, { path: "module.acceptance", reason: "missing_coverage", allowedReferences: ["notes"], missingReferences: ["notes"] });
    return true;
  });
});

test("未使用组件明确列出缺失编号，不能只返回笼统格式或引用错误", () => {
  const f = fixture();
  f.blueprint!.modules[0]!.componentIds!.push("calculate");
  f.modules![0]!.components.push({ ...f.modules![0]!.components[0]!, id: "calculate" });
  f.modules![0]!.blueprintHash = designHash(f.blueprint);
  assert.throws(() => validateArchitectureModule(f.modules[0], callFixture(Reflect.apply, Reflect, [f.moduleOptions, f, [0]])), (error: TestFailure) => {
    assert.equal(error.validationIssue!.reason, "component_unused");
    assert.deepEqual(error.validationIssue!.missingReferences, ["calculate"]);
    assert.deepEqual(error.validationIssue!.allowedReferences, ["capture", "calculate"]);
    assert.match(error.message, /步骤/u); return true;
  });
});

test("阶段JSON校验不执行访问器，错误不会复制任意提交值", () => {
  const f = fixture(); let accessed = false;
  const module = { ...f.modules[0]! };
  Object.defineProperty(module, "instructions", { enumerable: true, get() { accessed = true; throw new Error("fixture-private-value"); } });
  assert.throws(() => validateArchitectureModule(module, callFixture(Reflect.apply, Reflect, [f.moduleOptions, f, [0]])), (error: TestFailure) => error instanceof InputError && !error.message.includes("fixture-private-value"));
  assert.equal(accessed, false);
  const circular = { ...f.modules[0]! }; Reflect.set(circular, "unknowns", [circular]);
  rejected(() => validateArchitectureModule(circular, f.moduleOptions(0)), "module");
});
