import type { ArchitectureBlueprint, ArchitectureModule, CandidateDraft } from "../../src/contracts/architecture-stages.mjs";
import type { DesignCheckpoint, DesignStageRole, PipelineHandoff } from "../../src/architecture/architecture-design-pipeline.mjs";
import type { SessionStorage } from "../../src/runtime/pi-port.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import { failureFields } from "../helpers/failure-fields.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { InputError } from "../../src/requirements/core.mjs";
import { designSubmissionSchema, designHash, validateDesign } from "../../src/architecture/architecture-contract.mjs";
import { architectureDesignRecovery, runArchitectureDesignPipeline, readArchitectureDesignProgress, architectureDesignCallLimits, architectureDesignTestContinuation } from "../../src/architecture/architecture-design-pipeline.mjs";
import { validDesign, validDraft } from "../helpers/architecture.mjs";
import { assembleArchitectureCandidate, applyArchitectureIntegration, createArchitectureStageSchemas } from "../../src/architecture/architecture-design-stages.mjs";
import { architectureModelContext } from "../../src/architecture/architecture-model-context.mjs";
import { architectureToolValidation } from "../../src/architecture/architecture-tool-diagnostics.mjs";
import type { ArchitectureAcceptance,ArchitectureComponent,ArchitectureStep,ArchitectureDecision } from "../../src/contracts/architecture.mjs";
import type { AcceptanceVerification } from "../../src/contracts/verification.mjs";
import type { BlueprintConsultationResult } from "../../src/architecture/architecture-blueprint-consultation.mjs";



type IntegrationPatch = { baseHash: unknown; updates: { path: string; value: unknown }[] };
type FixtureValue = ArchitectureBlueprint | ArchitectureModule | IntegrationPatch | BlueprintConsultationResult;
type FixturePayload = Record<string, unknown> & {
  blueprintHash?: string; baseHash?: string; baseCandidate?: CandidateDraft;
  requirements?: { id: string; text: string }[];
  dependencyInterfaces?: { moduleId: string; steps: { id: string }[] }[];
  designModelBudget?: { limit: number };
};
type FixtureRole = Omit<DesignStageRole, "payload"> & { payload: FixturePayload };
type StageState<T> = Omit<DesignCheckpoint["blueprint"], "result"> & { result: T | null };
type FixtureCheckpoint = Omit<DesignCheckpoint, "blueprint" | "modules" | "integration"> & {
  blueprint: StageState<ArchitectureBlueprint>; modules: StageState<ArchitectureModule>[];
  integration: StageState<IntegrationPatch>;
};
type FixtureHandler = (context: { options: FixtureRole; send(event?: unknown): Promise<void>; value: FixtureValue }) => unknown | Promise<unknown>;
function moduleValue(value: FixtureValue) { assert.ok("moduleId" in value); return value; }
function blueprintValue(value: FixtureValue) { assert.ok("global" in value); return value; }
function globalFields(candidate: CandidateDraft) { const { components, steps, capabilities, failureHandling, decisions, coverage, acceptance, unknowns, platformClaims, ...global } = candidate; return global; }
function recoveryFields(value: ReturnType<typeof architectureDesignRecovery>) { assert.ok(value); return objectFields(value); }
function candidateResult(value: CandidateDraft | PipelineHandoff) { assert.ok(!("needsInput" in value)); return value; }

const moduleFields = ["components", "steps", "capabilities", "failureHandling", "decisions", "coverage", "acceptance", "unknowns", "platformClaims"];

function fixture(count = 2) {
  const requirements = Array.from({ length: count }, (_, index) => ({ id: `req_${index}`, text: `已确认的功能${index}` }));
  const candidate = validDesign(requirements, { schemaVersion: 3,
    interaction: { defaultEntry: "conversation", page: false, operations: false, inputs: "工作记录", results: "摘要", persistentData: "无跨任务状态" },
    connections: [], execution: { language: "none", hosting: "builtin", reason: "复用文本能力" },
    selectionBasis: { capacity: "已确认记录", process: "逐项整理", quality: "保留原文事实", requirementIds: requirements.map(item => item.id), assumptions: [] } });
  const blueprint: ArchitectureBlueprint = { global: globalFields(candidate),
    modules: requirements.map((item, index) => ({ id: `module_${index}`, purpose: item.text, requirementIds: [item.id],
      dependsOn: index ? [`module_${index - 1}`] : [], inputs: "已知输入", outputs: "本模块结果" })) };
  const modules: ArchitectureModule[] = blueprint.modules.map((assignment, index) => ({ moduleId: assignment.id, blueprintHash: designHash(blueprint), instructions: `完成模块${index}的原范围。`,
    components: [{ ...candidate.components[0]!, id: `component_${index}` }],
    steps: [{ ...candidate.steps[0]!, id: `step_${index}`, componentId: `component_${index}`, dependsOn: index ? [{ moduleId: `module_${index - 1}`, id: `step_${index - 1}` }] : [] }],
    capabilities: structuredClone(candidate.capabilities), failureHandling: structuredClone(candidate.failureHandling),
    decisions: [{ ...candidate.decisions[0]!, id: `decision_${index}` }],
    coverage: [{ requirementId: requirements[index]!.id, componentIds: [`component_${index}`], verification: "检查本条原需求" }],
    acceptance: candidate.acceptance.map(row => ({ ...row, id: `${assignment.id}_${row.id}`, requirementIds: assignment.requirementIds })), unknowns: [] }));
  const context = { requirements, candidateSchema: designSubmissionSchema({ taskSpec: { version: 1 } }, { requirements }),
    draft: { taskSpec: "原始需求只发蓝图，整合使用程序拼装候选" }, runtimeCapabilities: { version: 1 }, evidence: [] };
  const binding = { agentId: "staged_case", requirementHash: "a".repeat(64), platformHash: "b".repeat(64), materialsHash: "c".repeat(64), previousCandidateHash: null };
  const record: { agentId: string; version: number; design: null; review: null; attempts: never[]; status?: string; designProgressCheckpoint?: FixtureCheckpoint } = { agentId: "staged_case", version: 1, design: null, review: null, attempts: [] };
  const saved: DesignCheckpoint[] = [], calls: { stage: string; key: string; modelCalls: number; storage: SessionStorage; payload: FixturePayload }[] = [];
  const onSave = async (checkpoint: DesignCheckpoint) => { saved.push(structuredClone(checkpoint)); };
  const mockRole = (handler?: FixtureHandler) => async (input: DesignStageRole) => {
    const options: FixtureRole = { ...input, payload: input.payload as FixturePayload };
    calls.push({ stage: options.stage, key: options.key, modelCalls: options.modelCalls, storage: structuredClone(options.sessionStorage), payload: options.payload });
    await options.onSessionRef({ file: options.sessionStorage.file ?? `${options.stage}-${options.key}-${objectFields(options.sessionStorage.binding).generation}.jsonl` });
    const send = async (event?: unknown): Promise<void> => { await options.onModelCall(event); };
    const value: FixtureValue = options.stage === "consultation"
      ? { conclusion: "仅分析责任需求", recommendations: ["按现有平台边界设计"], unknowns: [], references: [{ section: "requirements", pointer: "/0" }] }
      : options.stage === "blueprint" ? structuredClone(blueprint) : options.stage === "module"
      ? { ...structuredClone(modules.find(module => module.moduleId === options.key)!), blueprintHash: options.payload.blueprintHash! }
      : { baseHash: options.payload.baseHash, updates: [] };
    if (handler) return handler({ options, send, value });
    await send(); await options.onResult(value); return value;
  };
  const run = (overrides: Partial<Parameters<typeof runArchitectureDesignPipeline>[0]> = {}) => runArchitectureDesignPipeline({ record, context, binding, onSave, runRole: mockRole(), sessionDirectory: "/tmp/neuma-design-pipeline-fixture", ...overrides });
  return { record, context, binding, blueprint, modules, saved, calls, onSave, mockRole, run };
}

async function oldSemanticFailure(integrationCalls = 3) {
  const f = fixture(3); await f.run();
  const checkpoint = f.record.designProgressCheckpoint!;
  checkpoint.blueprint.result!.global.profile = "workflow";
  checkpoint.blueprint.resultHash = designHash(checkpoint.blueprint.result);
  checkpoint.blueprint.modelCalls = 5;
  for (const entry of checkpoint.modules) {
    entry.modelCalls = 4; entry.result!.blueprintHash = checkpoint.blueprint.resultHash;
    entry.result!.capabilities = [{ id: "invented_host", status: "available", reason: "历史错误编号" }];
    entry.resultHash = designHash(entry.result);
  }
  checkpoint.integration.result = null; checkpoint.integration.resultHash = null; checkpoint.integration.modelCalls = integrationCalls;
  checkpoint.modelCalls = 17 + integrationCalls;
  const { hash: _hash, ...body } = checkpoint; checkpoint.hash = designHash(body);
  const draft = validDraft(); draft.taskSpec = { version: 1, items: [{ id: "fixed", dimension: "processing", content: "固定原需求",
    applicability: "applies", critical: true, source: { kind: "user", evidence: [{ messageId: "source", quote: "固定原需求" }] } }] };
  Object.assign(f.record, { draft, requirements: f.context.requirements, status: "cancelled" });
  return f;
}

test("旧蓝图与模块语义问题按归属复核，五个原剩余调用完成且不重写历史", async () => {
  const f = await oldSemanticFailure();
  const original = structuredClone(f.record.designProgressCheckpoint!);
  const recovery = architectureDesignRecovery(f.record)!;
  assert.equal(recovery.status, "available");
  assert.equal(recovery.stageKey, "blueprint");
  const before = f.calls.length, histories: SessionStorage[] = [];
  f.record.version = 2;
  await f.run({ repair: recovery.request, validateHistory: async storage => { histories.push(structuredClone(storage)); },
    runRole: f.mockRole(async ({ options, send, value }) => {
      assert.ok(objectFields(options.payload).validationRepair);
      assert.equal(options.modelCallLimit - options.modelCalls, 1, "模型看到的额度扣除其他待完成责任节点的预留");
      await send(); await options.onResult(value); return value;
    }) });
  assert.deepEqual(f.calls.slice(before).map(item => item.key), ["blueprint", "module_0", "module_1", "module_2", "integration"]);
  const saved = f.record.designProgressCheckpoint!;
  assert.equal(saved.modelCalls, 25);
  assert.deepEqual(saved.validationRepair!.source, original);
  assert.equal(histories.length, 5);
  assert.equal(saved.blueprint.modelCalls, 6);
  assert.ok(saved.modules.every(item => item.modelCalls === 5 && item.generation === 1));
  assert.equal(saved.integration.modelCalls, 4);
  assert.ok(readArchitectureDesignProgress(f.record, f));
  await f.run({ runRole: async () => { assert.fail("已通过复核的成果不得再次调用模型"); } });
  const forged = structuredClone(saved);
  forged.validationRepair!.targets.pop();
  const { hash: _hash, ...body } = forged; forged.hash = designHash(body);
  assert.throws(() => readArchitectureDesignProgress({ designProgressCheckpoint: forged }, f), /进度/u);
});

test("旧成果修复额度不足或原会话不可核验时零新增调用，成果与用量保留", async () => {
  for (const insufficient of [true, false]) {
    const f = await oldSemanticFailure(insufficient ? 4 : 3), before = f.calls.length;
    const original = structuredClone(f.record.designProgressCheckpoint!);
    const recovery = architectureDesignRecovery(f.record)!;
    assert.equal(recovery.status, insufficient ? "blocked" : "available");
    f.record.version = 2;
    await assert.rejects(f.run({ ...(insufficient ? {} : { repair: recovery.request }), validateHistory: async () => { throw new Error("历史会话缺失"); } }),
      insufficient ? /剩余额度/u : /历史会话缺失/u);
    assert.equal(f.calls.length, before);
    assert.equal(f.record.designProgressCheckpoint!.modelCalls, original.modelCalls);
    assert.deepEqual(f.record.designProgressCheckpoint!.blueprint, original.blueprint);
    assert.deepEqual(f.record.designProgressCheckpoint!.modules, original.modules);
  }
});

test("模块历史问题只复核责任模块及依赖下游，独立兄弟和蓝图逐字保留", async () => {
  const f = fixture(3);
  f.blueprint.modules[2]!.dependsOn = []; f.modules[2]!.steps[0]!.dependsOn = [];
  for (const module of f.modules) module.blueprintHash = designHash(f.blueprint);
  await f.run();
  const checkpoint = f.record.designProgressCheckpoint!;
  checkpoint.modules[0]!.result!.capabilities[0]!.id = "invented_available";
  checkpoint.modules[0]!.resultHash = designHash(checkpoint.modules[0]!.result);
  checkpoint.integration.result = null; checkpoint.integration.resultHash = null;
  const { hash: _hash, ...body } = checkpoint; checkpoint.hash = designHash(body);
  const preserved = structuredClone({ blueprint: checkpoint.blueprint, sibling: checkpoint.modules[2] });
  const start = f.calls.length; f.record.version = 2;
  await f.run({ validateHistory: async () => {} });
  assert.deepEqual(f.calls.slice(start).map(item => item.key), ["module_0", "module_1", "integration"]);
  assert.deepEqual(f.record.designProgressCheckpoint!.blueprint, preserved.blueprint);
  assert.deepEqual(f.record.designProgressCheckpoint!.modules[2], preserved.sibling);
  assert.equal(f.record.designProgressCheckpoint!.modelCalls, 8);
});

test("局部复核发生失败保留原稿和已用次数，不能以恢复再次领取额度", async () => {
  const f = await oldSemanticFailure(), recovery = architectureDesignRecovery(f.record)!;
  f.record.version = 2;
  await assert.rejects(f.run({ repair: recovery.request, validateHistory: async () => {},
    runRole: f.mockRole(async ({ options, send }) => { await send(); assert.equal(options.stage, "blueprint"); throw new Error("固定复核失败"); }) }), /固定复核失败/u);
  const checkpoint = f.record.designProgressCheckpoint!;
  assert.equal(checkpoint.modelCalls, 21); assert.equal(checkpoint.blueprint.modelCalls, 6);
  assert.ok(checkpoint.validationRepair!.source.blueprint.result);
  assert.equal(architectureDesignRecovery(f.record)!.status, "blocked");
  assert.ok(readArchitectureDesignProgress(f.record, f));
});

test("明确测试续跑只补一个耗尽节点与总账各一次，绑定失败快照且不能重复领取", async () => {
  const f = await oldSemanticFailure(), first = architectureDesignRecovery(f.record)!;
  f.record.version = 2;
  await assert.rejects(f.run({ repair: first.request, validateHistory: async () => {}, runRole: f.mockRole(async ({ options, send, value }) => {
    await send(); if (options.key === "module_0") throw new Error("固定末轮仅完成资料读取");
    await options.onResult(value); return value;
  }) }), /资料读取/u);
  const failed = structuredClone(f.record.designProgressCheckpoint!), grant = architectureDesignTestContinuation(f.record)!;
  assert.equal(failed.modelCalls, 22); assert.equal(grant.additionalCalls, 1);
  const recovery = architectureDesignRecovery(f.record)!;
  assert.equal(recovery.status, "available"); assert.equal(objectFields(recovery.request).kind, "stage_validation_retry");
  const before = f.calls.length; f.record.version = 3;
  await assert.rejects(f.run({ repair: { ...objectFields(recovery.request), additionalCalls: 2 } }), /授权/u);
  assert.equal(f.calls.length, before);
  await f.run({ repair: recovery.request });
  const completed = f.record.designProgressCheckpoint!;
  assert.equal(completed.modelCalls, 26); assert.equal(architectureDesignCallLimits(completed).pipeline, 26);
  assert.equal(completed.modules[0]!.modelCalls, 6); assert.equal(completed.blueprint.modelCalls, 6);
  assert.deepEqual(completed.validationContinuation!.source, failed);
  assert.deepEqual(f.calls.slice(before).map(item => item.key), ["module_0", "module_1", "module_2", "integration"]);
  assert.equal(architectureDesignTestContinuation(f.record), null);
  assert.ok(readArchitectureDesignProgress(f.record, f));
  await assert.rejects(f.run({ repair: recovery.request }), /授权/u);
  assert.equal(f.record.designProgressCheckpoint!.modelCalls, 26);
  const bad = structuredClone(completed); bad.validationContinuation!.source.hash = "0".repeat(64);
  const { hash: _hash, ...body } = bad; bad.hash = designHash(body);
  assert.throws(() => readArchitectureDesignProgress({ designProgressCheckpoint: bad }, f), /进度/u);
});

test("蓝图、并行模块、整合逐项落盘，最终候选仍须完整校验且不授予评审通过", async () => {
  const f = fixture();
  const result = candidateResult(await f.run());
  const integrationInput = f.calls.find(call => call.stage === "integration")!.payload;
  for (const key of ["draft", "candidateSchema", "modules", "blueprint"])
    assert.equal(Object.hasOwn(integrationInput, key), false, `整合输入不重复发送${key}`);
  assert.deepEqual(integrationInput.baseCandidate!.components, result.components);
  assert.doesNotThrow(() => validateDesign(result, { requirements: f.context.requirements }));
  assert.deepEqual(f.calls.map(row => row.stage), ["blueprint", "module", "module", "integration"]);
  assert.equal(f.record.designProgressCheckpoint!.modelCalls, 4);
  assert.ok(f.saved.some(checkpoint => checkpoint.blueprint.result !== null && checkpoint.modules.every((entry) => entry.result === null)));
  assert.ok(f.saved.some(checkpoint => checkpoint.modules.every((entry) => entry.result !== null) && checkpoint.integration.result === null));
  for (const row of f.calls.filter(row => row.stage === "module")) {
    assert.equal(row.payload.requirements!.length, 1);
    assert.equal(Object.hasOwn(row.payload, "draft"), false);
    assert.equal(Object.hasOwn(row.payload, "candidateSchema"), false);
  }
  const loaded = readArchitectureDesignProgress(f.record, f);
  assert.equal(loaded!.integration.result !== null, true);
  assert.equal(f.record.design, null); assert.equal(f.record.review, null); assert.deepEqual(f.record.attempts, []);
  assert.deepEqual(await f.run({ runRole: () => { throw new Error("已完成节点不能重跑"); } }), result);
});

test("跨模块后续义务标明主责，模块工具与最终校验只允许本模块编号，完整义务保留到整合", async () => {
  const f = fixture();
  Object.assign(f.context, { deferredVerifications: { issues: [{ id: "development_validation", requirementId: "req_1", requirementIds: ["req_0"],
    owner: "system", stage: "development", question: "验证统计动作实际执行并覆盖全部输入拒绝分支" }] } });
  const candidate = candidateResult(await f.run({ runRole: f.mockRole(async ({ options, send, value }) => {
    await send();
    if (options.stage === "module") {
      const ownedId = options.key === "module_0" ? "req_0" : "req_1", foreignId = ownedId === "req_0" ? "req_1" : "req_0";
      const properties = options.parameters.properties!;
      assert.deepEqual(objectFields(objectFields(objectFields(properties.coverage!.items).properties).requirementId).enum,
        [ownedId], "coverage可选编号必须来自本模块冻结分工");
      const references = objectFields(objectFields(objectFields(properties.acceptance!.items).properties).requirementIds);
      assert.deepEqual(objectFields(references.items).enum, [ownedId]);
      const invalid = structuredClone(moduleValue(value));
      invalid.coverage.push({ ...invalid.coverage[0]!, requirementId: foreignId });
      invalid.acceptance[0]!.requirementIds = [ownedId, foreignId];
      const rejected = architectureToolValidation(invalid, options.parameters, { root: "module" });
      assert.equal(rejected.valid, false, "越界编号必须在原始工具结构校验时被拒，不能等到最终语义检查");
      assert.ok(rejected.issues.some(issue => issue.path === "module.coverage[1].requirementId"));
      assert.ok(rejected.issues.some(issue => issue.path === "module.acceptance[0].requirementIds[1]"));
      assert.throws(() => options.validate(invalid), InputError);
      const packet = architectureModelContext(options.payload, { role: "specialist" });
      const scope = objectFields(packet.requirementScope);
      assert.deepEqual(scope.ownedRequirementIds, [ownedId]);
      assert.deepEqual(scope.referenceOnly, [{ moduleId: options.key === "module_0" ? "module_1" : "module_0", requirementIds: [foreignId] }]);
      const obligation = objectFields((packet.deferredObligations as unknown[])[0]);
      assert.deepEqual(obligation.architectureResponsibility, {
        ownerModuleId: "module_1", usage: options.key === "module_0" ? "reference_only" : "owned",
      }, "后续义务的主责由单独的requirementId决定，不能因关联了输入要求就转给输入模块");
      assert.deepEqual(obligation.requirementIds, ["req_0"]);
    }
    await options.onResult(value); return value;
  }) }));
  assert.deepEqual(candidate.coverage.map(row => row.requirementId), ["req_0", "req_1"]);
  assert.ok(candidate.acceptance.some(row => row.requirementIds.includes("req_1")), "整合后的方案仍须验收另一个模块负责的完整义务");
  assert.doesNotThrow(() => validateDesign(candidate, { requirements: f.context.requirements }));
  assert.equal(f.record.designProgressCheckpoint!.schemaHash, "ee19879933b08ec9f60fdd616e79b2b321661d0e29946d8f70240a172b780a85",
    "沿用修复前的阶段契约摘要；模块当前提交限制不破坏历史检查点绑定");
  assert.ok(readArchitectureDesignProgress(f.record, f));
});

test("蓝图按问题动态并行分析，失败保留成功组且恢复沿用会话与总额度", async () => {
  const f = fixture(3);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let dispatched = false, active = 0, maximum = 0, arrived = 0, fail = true;
  const handler: FixtureHandler = async ({ options, send, value }) => {
    await send();
    if (options.stage === "consultation") {
      assert.equal(options.modelCallLimit, 3);
      assert.equal(options.payload.requirements!.length, 1);
      assert.equal(options.payload.candidateSchema, undefined);
      assert.equal(options.tools, undefined, "专项子Agent不能递归委派");
      active++; maximum = Math.max(maximum, active); if (++arrived === 3) release();
      await gate; active--;
      if (objectFields(options.payload.assignment).topic === "verification" && fail) { fail = false; throw new Error("专项中断"); }
    }
    if (options.stage === "blueprint" && !dispatched) {
      dispatched = true;
      await options.tools!.find(tool => tool.name === "consult_architecture")!.execute("dispatch", { assignments:
        ["platform", "interfaces", "verification"].map((topic, i) => ({ topic, question: `分析本组问题${i}`, requirementIds: [`req_${i}`] })) });
    } else if (options.stage === "blueprint") {
      assert.equal((options.payload.consultations as unknown[]).length, 3);
    }
    await options.onResult(value); return value;
  };
  await assert.rejects(f.run({ runRole: f.mockRole(handler) }), /专项中断/);
  assert.equal(maximum, 3);
  const before = structuredClone(f.record.designProgressCheckpoint!);
  assert.equal(before.modelCalls, 4);
  assert.equal(before.consultations!.filter(entry => entry.result).length, 2);
  assert.equal(before.blueprint.result, null);
  assert.ok(readArchitectureDesignProgress(f.record, f));
  const start = f.calls.length;
  const result = candidateResult(await f.run({ runRole: f.mockRole(handler) }));
  const resumed = f.calls.slice(start).filter(call => call.stage === "consultation");
  assert.equal(resumed.length, 1);
  const pending = before.consultations!.find(entry => !entry.result)!;
  assert.equal(resumed[0]!.storage.file, pending.sessionRef!.file);
  assert.equal(resumed[0]!.modelCalls, 1);
  assert.equal(f.record.designProgressCheckpoint!.modelCalls, 10);
  assert.doesNotThrow(() => validateDesign(result, { requirements: f.context.requirements }));
  assert.ok(readArchitectureDesignProgress(f.record, f));
});

test("专项分派先保存，保存失败不启动子Agent；旧v3不会新增分派或重置额度", async () => {
  const f = fixture(1);
  await assert.rejects(f.run({ onSave: async checkpoint => {
    if (checkpoint.consultations?.length) throw new Error("分派落盘失败");
    await f.onSave(checkpoint);
  }, runRole: f.mockRole(async ({ options, send }) => {
    await send(); assert.equal(options.stage, "blueprint");
    return options.tools![0]!.execute("dispatch", { assignments: [{ topic: "platform", question: "核对运行路径", requirementIds: ["req_0"] }] });
  }) }), /分派落盘失败/);
  assert.equal(f.calls.length, 1);
  const cp = f.record.designProgressCheckpoint!;
  cp.schemaVersion = 3; delete cp.consultations;
  const { hash: _hash, ...body } = cp; cp.hash = designHash(body);
  await f.run({ runRole: f.mockRole(async ({ options, send, value }) => {
    if (options.stage === "blueprint") { assert.equal(options.tools, undefined); assert.equal(options.modelCalls, 1); }
    await send(); await options.onResult(value); return value;
  }) });
  assert.equal(f.record.designProgressCheckpoint!.schemaVersion, 3);
  assert.equal(f.record.designProgressCheckpoint!.modelCalls, 4);
});

test("专项额度耗尽及丢失分派记录均不能重领预算或绕过已分派问题", async () => {
  const f = fixture(1);
  await assert.rejects(f.run({ runRole: f.mockRole(async ({ options, send }) => {
    await send();
    if (options.stage === "consultation") { await send(); await send(); await send(); }
    return options.tools![0]!.execute("dispatch", { assignments: [{ topic: "platform", question: "核实运行能力", requirementIds: ["req_0"] }] });
  }) }), error => failureFields(error).diagnostic?.reason === "turn_limit");
  const cp = structuredClone(f.record.designProgressCheckpoint!);
  assert.equal(cp.consultations![0]!.modelCalls, 3);
  assert.equal(cp.modelCalls, 4);
  const start = f.calls.length;
  await assert.rejects(f.run(), error => failureFields(error).diagnostic?.reason === "turn_limit");
  assert.equal(f.calls.length, start);
  assert.deepEqual(f.record.designProgressCheckpoint, cp);
  delete f.record.designProgressCheckpoint!.consultations;
  const { hash: _hash, ...body } = f.record.designProgressCheckpoint!;
  f.record.designProgressCheckpoint!.hash = designHash(body);
  assert.throws(() => readArchitectureDesignProgress(f.record, f), /损坏/);
  await assert.rejects(f.run()); assert.equal(f.calls.length, start);
});

test("耗尽专项有明确恢复入口，唯一局部修复授权沿原会话累计后完成", async () => {
  const f = fixture(1);
  await assert.rejects(f.run({ runRole: f.mockRole(async ({ options, send }) => {
    await send();
    if (options.stage === "consultation") { await send(); await send(); await send(); }
    return options.tools![0]!.execute("dispatch", { assignments: [{ topic: "platform", question: "核实能力", requirementIds: ["req_0"] }] });
  }) }));
  const recovery = architectureDesignRecovery({ ...f.record, status: "failed" });
  assert.equal(recovery?.status, "available"); assert.equal(recovery?.stage, "consultation");
  const original = structuredClone(f.record.designProgressCheckpoint!);
  f.record.version++;
  await f.run({ repair: recovery!.request });
  const current = f.record.designProgressCheckpoint!;
  assert.equal(current.consultations![0]!.modelCalls, 4);
  assert.deepEqual(current.consultations![0]!.sessionRef, original.consultations![0]!.sessionRef);
  assert.equal(current.modelCalls, 8); assert.equal(current.repair!.stage, "consultation");
  assert.ok(readArchitectureDesignProgress(f.record, f));
});

test("专项消耗预算后模块得到实际可用次数，受限节点仍有正式提交机会", async () => {
  const f = fixture(3), limits: Record<string, number> = {};
  await f.run({ runRole: f.mockRole(async ({ options, send, value }) => {
    if (options.stage === "blueprint") {
      await send();
      await options.tools![0]!.execute("dispatch", { assignments: ["platform", "interfaces", "verification"].map((topic, i) => ({
        topic, question: `核对${topic}`, requirementIds: [`req_${i}`] })) });
      await send(); await send(); await send();
    } else if (options.stage === "consultation") { await send(); await send(); await send(); }
    else {
      limits[options.key] = options.modelCallLimit - options.modelCalls;
      for (let i = options.modelCalls; i < options.modelCallLimit; i++) await send();
    }
    await options.onResult(value); return value;
  }) });
  assert.deepEqual(limits, { module_0: 5, module_1: 1, module_2: 1, integration: 5 });
  assert.equal(f.record.designProgressCheckpoint!.modelCalls, 25);
});

test("新的复杂需求按工作量扩展模块并限制每组职责，最多三个模块同时运行", async () => {
  const f = fixture(4), requirements = Array.from({ length: 84 }, (_, i) => ({ id: `scope_${i}`, text: `明确要求${i}` }));
  f.context.requirements.splice(0, f.context.requirements.length, ...requirements);
  f.context.candidateSchema = designSubmissionSchema({ taskSpec: { version: 1 } }, { requirements });
  f.blueprint.global.selectionBasis!.requirementIds = requirements.map(row => row.id);
  f.blueprint.modules.forEach((assignment, index) => {
    assignment.requirementIds = requirements.slice(index * 21, index * 21 + 21).map(row => row.id); assignment.dependsOn = [];
    const module = f.modules[index]!; module.steps[0]!.dependsOn = [];
    module.coverage = assignment.requirementIds.map(requirementId => ({ requirementId, componentIds: [module.components[0]!.id], verification: "逐项核对原要求" }));
    module.acceptance.forEach(row => { row.requirementIds = assignment.requirementIds; });
  });
  let active = 0, maximum = 0;
  await f.run({ runRole: f.mockRole(async ({ options, send, value }) => {
    if (options.stage === "blueprint") {
      assert.equal(options.parameters.properties!.modules!.maxItems, 4);
      assert.equal(options.parameters.properties!.modules!.items!.properties!.requirementIds!.maxItems, 24);
    }
    if (options.stage === "module") { active++; maximum = Math.max(maximum, active); }
    await send(); await options.onResult(value);
    if (options.stage === "module") active--;
    return value;
  }) });
  assert.equal(maximum, 3); assert.equal(f.record.designProgressCheckpoint!.schemaVersion, 5);
  assert.equal(f.record.designProgressCheckpoint!.moduleLimit, 4); assert.equal(f.record.designProgressCheckpoint!.modules.length, 4);
  const before = structuredClone(f.record.designProgressCheckpoint);
  await f.run({ runRole: async () => assert.fail("已完成节点不能重新领取额度") });
  assert.deepEqual(f.record.designProgressCheckpoint, before);
});

test("模块分派显式限制全局容量，旧超限成果退回责任模块而非反复重放", async () => {
  const f = fixture(2);
  await f.run({ runRole: f.mockRole(async ({ options, send, value }) => {
    if (options.stage === "module") assert.equal(options.parameters.properties!.components!.maxItems, options.key === "module_0" ? 40 : 79);
    await send(); await options.onResult(value); return value;
  }) });
  const cp = f.record.designProgressCheckpoint!;
  for (const entry of cp.modules) {
    const module = entry.result!;
    for (let i = 1; i < 41; i++) {
      const id = `${module.moduleId}_extra_${i}`;
      module.components.push({ ...module.components[0]!, id });
      module.steps.push({ ...module.steps[0]!, id, componentId: id, dependsOn: [] });
    }
    entry.resultHash = designHash(module);
  }
  cp.integration.result = null; cp.integration.resultHash = null;
  const { hash: _hash, ...body } = cp; cp.hash = designHash(body);
  const source = structuredClone(cp);
  const draft = validDraft(); draft.taskSpec = { version: 1, items: [] };
  const recovery = architectureDesignRecovery({ ...f.record, status: "failed", draft, requirements: f.context.requirements });
  assert.equal(objectFields(recovery).kind, "stage_validation");
  const start = f.calls.length;
  await f.run({ validateHistory: async () => {} });
  assert.deepEqual(f.calls.slice(start).map(call => call.key), ["module_0", "module_1", "integration"]);
  assert.deepEqual(f.record.designProgressCheckpoint!.validationRepair!.source, source);
  assert.equal(f.record.designProgressCheckpoint!.modules[0]!.modelCalls, 2);
  assert.ok(readArchitectureDesignProgress(f.record, f));
});

test("恢复保留旧模块41条真实成果，剩余模块只能使用39条，合并不再溢出", async () => {
  const f = fixture(2);
  await assert.rejects(f.run({ runRole: f.mockRole(async ({ options, send, value }) => {
    await send(); await options.onResult(value);
    if (options.key === "module_0") throw new Error("第一模块提交后中断");
    return value;
  }) }), /第一模块提交后中断/u);
  const checkpoint = f.record.designProgressCheckpoint!, entry = checkpoint.modules[0]!;
  // Old versions allowed independently valid modules to use more than today's initial share.
  for (let i = 1; i < 41; i++) {
    const id = `historical_${i}`;
    entry.result!.components.push({ ...entry.result!.components[0]!, id });
    entry.result!.steps.push({ ...entry.result!.steps[0]!, id, componentId: id, dependsOn: [] });
  }
  entry.resultHash = designHash(entry.result);
  const { hash: _hash, ...body } = checkpoint; checkpoint.hash = designHash(body);
  const original = structuredClone(entry), start = f.calls.length;
  const candidate = candidateResult(await f.run({ runRole: f.mockRole(async ({ options, send, value }) => {
    if (options.stage === "module") {
      assert.equal(options.key, "module_1");
      assert.equal(options.parameters.properties!.components!.maxItems, 39);
      assert.equal(options.parameters.properties!.steps!.maxItems, 39);
      const module = moduleValue(value);
      for (let i = 1; i < 39; i++) {
        const id = `remaining_${i}`;
        module.components.push({ ...module.components[0]!, id });
        module.steps.push({ ...module.steps[0]!, id, componentId: id, dependsOn: [] });
      }
    }
    await send(); await options.onResult(value); return value;
  }) }));
  assert.equal(candidate.components.length, 80); assert.equal(candidate.steps.length, 80);
  assert.deepEqual(f.calls.slice(start).map(call => call.key), ["module_1", "integration"]);
  assert.deepEqual(f.record.designProgressCheckpoint!.modules[0], original);
  assert.doesNotThrow(() => validateDesign(candidate, { requirements: f.context.requirements }));
});

test("正式蓝图提交后进程中断仍保留成果，恢复只补未完成节点", async () => {
  const f = fixture();
  await assert.rejects(f.run({ runRole: f.mockRole(async ({ options, send, value }) => {
    await send(); await options.onResult(value); throw new Error("模拟工具提交后进程退出");
  }) }), /模拟工具提交后进程退出/u);
  assert.ok(f.record.designProgressCheckpoint!.blueprint.result);
  const start = f.calls.length;
  const result = candidateResult(await f.run());
  assert.deepEqual(f.calls.slice(start).map(row => row.stage), ["module", "module", "integration"]);
  assert.equal(f.record.designProgressCheckpoint!.modelCalls, 4);
  assert.doesNotThrow(() => validateDesign(result, { requirements: f.context.requirements }));
});

test("下游等待上游正式保存并获得新增步骤接口，上游失败不提前启动下游", async () => {
  const f = fixture();
  await assert.rejects(f.run({ runRole: f.mockRole(async ({ options, send, value }) => {
    await send();
    if (options.key === "module_0") throw new Error("上游暂未完成");
    await options.onResult(value); return value;
  }) }), /上游暂未完成/u);
  assert.equal(f.calls.some(call => call.key === "module_1"), false);
  const ref = f.record.designProgressCheckpoint!.modules[0]!.sessionRef, used = f.record.designProgressCheckpoint!.modelCalls;
  const result = candidateResult(await f.run({ runRole: f.mockRole(async ({ options, send, value }) => {
    await send();
    if (options.key === "module_0") {
      assert.equal(options.sessionStorage.file, ref!.file);
      moduleValue(value).steps.push({ ...moduleValue(value).steps[0]!, id: "extra", dependsOn: ["step_0"] });
    }
    if (options.key === "module_1") {
      assert.ok(f.record.designProgressCheckpoint!.modules[0]!.result);
      assert.deepEqual(options.payload.dependencyInterfaces![0]!.steps.map((step) => step.id), ["step_0", "extra"]);
      moduleValue(value).steps[0]!.dependsOn = [{ moduleId: "module_0", id: "extra" }];
    }
    await options.onResult(value); return value;
  }) }));
  assert.deepEqual(result.steps.at(-1)!.dependsOn, ["extra"]);
  assert.equal(f.record.designProgressCheckpoint!.modelCalls, used + 3);
  assert.ok(readArchitectureDesignProgress(f.record, f));
});

test("历史v1/v2完整检查点按原协议和摘要读取，不迁移或刷新次数", async () => {
  for (const schemaVersion of [1, 2] as const) {
    const f = fixture(), candidate = candidateResult(await f.run()), cp = f.record.designProgressCheckpoint!;
    const blueprint = cp.blueprint.result;
    for (const [index, assignment] of blueprint!.modules.entries()) {
      assignment.componentIds = cp.modules[index]!.result!.components.map((row) => row.id);
      assignment.stepIds = cp.modules[index]!.result!.steps.map((row) => row.id);
    }
    cp.schemaVersion = schemaVersion;
    delete cp.consultations;
    cp.schemaHash = designHash({ candidateSchema: f.context.candidateSchema,
      schemas: createArchitectureStageSchemas({ ...f.context, legacyBlueprint: true }) });
    cp.blueprint.resultHash = designHash(blueprint); cp.assignmentHash = designHash(blueprint!.modules);
    for (const entry of cp.modules) {
      entry.result!.blueprintHash = cp.blueprint.resultHash;
      for (const step of entry.result!.steps) step.dependsOn = step.dependsOn.map((ref) => typeof ref === "string" ? ref : ref.id);
      entry.resultHash = designHash(entry.result);
    }
    const { hash: _old, ...body } = cp; cp.hash = designHash(body);
    const before = structuredClone(cp);
    assert.deepEqual(readArchitectureDesignProgress(f.record, f), before);
    assert.deepEqual(await f.run({ runRole: () => { throw new Error("已完成历史不得重跑"); } }), candidate);
    assert.deepEqual(f.record.designProgressCheckpoint, before);
  }
});

test("旧蓝图已冻结41与39个组件时沿原分工恢复，不被新的均分额度拒绝", async () => {
  for (const schemaVersion of [1, 2] as const) {
    const f = fixture(2);
    await assert.rejects(f.run({ runRole: f.mockRole(async ({ options, send, value }) => {
      await send(); await options.onResult(value);
      if (options.stage === "blueprint") throw new Error("蓝图已保存后中断");
      return value;
    }) }), /蓝图已保存后中断/u);
    const cp = f.record.designProgressCheckpoint!, blueprint = cp.blueprint.result!;
    for (const [index, module] of f.modules.entries()) {
      const count = index === 0 ? 41 : 39;
      module.steps[0]!.dependsOn = [];
      for (let i = 1; i < count; i++) {
        const id = `${module.moduleId}_frozen_${i}`;
        module.components.push({ ...module.components[0]!, id });
        module.steps.push({ ...module.steps[0]!, id, componentId: id, dependsOn: [] });
      }
      blueprint.modules[index]!.componentIds = module.components.map(row => row.id);
      blueprint.modules[index]!.stepIds = module.steps.map(row => row.id);
    }
    cp.schemaVersion = schemaVersion; delete cp.consultations;
    cp.schemaHash = designHash({ candidateSchema: f.context.candidateSchema, schemas: createArchitectureStageSchemas({ ...f.context, legacyBlueprint: true }) });
    cp.blueprint.resultHash = designHash(blueprint); cp.assignmentHash = designHash(blueprint.modules);
    const { hash: _hash, ...body } = cp; cp.hash = designHash(body);
    const frozen = structuredClone(cp.blueprint), start = f.calls.length;
    const candidate = candidateResult(await f.run({ runRole: f.mockRole(async ({ options, send, value }) => {
      await send(); await options.onResult(value); return value;
    }) }));
    assert.equal(candidate.components.length, 80); assert.equal(candidate.steps.length, 80);
    assert.deepEqual(f.record.designProgressCheckpoint!.blueprint, frozen);
    assert.equal(f.record.designProgressCheckpoint!.schemaVersion, schemaVersion);
    assert.equal(f.record.designProgressCheckpoint!.modelCalls, 4);
    assert.deepEqual(f.calls.slice(start).map(call => call.key), ["module_0", "module_1", "integration"]);
    assert.doesNotThrow(() => validateDesign(candidate, { requirements: f.context.requirements }));
  }
});

test("同名步骤的评审反馈仍定位实际模块，上游修改重新校验下游引用", async () => {
  const f = fixture();
  for (const module of f.modules) module.steps[0]!.id = "same";
  f.modules[1]!.steps[0]!.dependsOn = [{ moduleId: "module_0", id: "same" }];
  const candidate = candidateResult(await f.run()), start = f.calls.length;
  assert.deepEqual(candidate.steps[1]!.dependsOn, ["module_0__same"]);
  await f.run({ revision: { candidate, issues: [{ candidatePaths: ["/steps/1/completion"] }] } });
  assert.deepEqual(f.calls.slice(start).map(call => call.key), ["module_1", "integration"]);
  assert.ok(readArchitectureDesignProgress(f.record, f));
});

test("一个模块失败保留并行兄弟的完整成果，重启沿原会话只补失败模块", async () => {
  const f = fixture();
  f.blueprint.modules[1]!.dependsOn = []; f.modules[1]!.steps[0]!.dependsOn = [];
  await assert.rejects(f.run({ runRole: f.mockRole(async ({ options, send, value }) => {
    await send();
    if (options.key === "module_0") throw new Error("固定模块截断");
    await options.onResult(value); return value;
  }) }), /固定模块截断/u);
  const checkpoint = f.record.designProgressCheckpoint!;
  assert.equal(checkpoint.modules[0]!.result, null); assert.ok(checkpoint.modules[1]!.result);
  assert.equal(checkpoint.integration.result, null);
  const firstRef = checkpoint.modules[0]!.sessionRef!.file, start = f.calls.length;
  await f.run();
  assert.deepEqual(f.calls.slice(start).map(row => row.key), ["module_0", "integration"]);
  assert.equal(f.calls[start]!.storage.file, firstRef);
  assert.equal(f.calls[start]!.modelCalls, 1);
  assert.equal(f.record.designProgressCheckpoint!.modelCalls, 5);
});

test("全部模块保存后跨模块编号重名不阻止拼装，中断恢复只进入整合与原校验", async () => {
  const f = fixture();
  for (const module of f.modules) module.platformClaims = [{ id: "shared_platform_claim", source: "runtimeCapabilities",
    path: "/version", expected: 1, decisionIds: [module.decisions[0]!.id], acceptanceIds: [module.acceptance[0]!.id] }];
  await assert.rejects(f.run({ runRole: f.mockRole(async ({ options, send, value }) => {
    if (options.stage === "integration") throw new Error("固定整合前中断");
    await send(); await options.onResult(value); return value;
  }) }), /固定整合前中断/u);
  f.record.status = "failed";
  const saved = structuredClone(f.record.designProgressCheckpoint!), start = f.calls.length;
  assert.ok(saved!.modules.every((entry) => entry.result));
  assert.equal(recoveryFields(architectureDesignRecovery(f.record)).actionLabel, "继续整合与评审");
  assert.equal(architectureDesignRecovery(f.record)!.status, "continuing");
  const result = candidateResult(await f.run());
  assert.deepEqual(f.calls.slice(start).map(row => row.stage), ["integration"]);
  assert.deepEqual(f.record.designProgressCheckpoint!.modules, saved!.modules);
  assert.deepEqual(f.record.designProgressCheckpoint!.blueprint, saved!.blueprint);
  assert.equal(f.record.designProgressCheckpoint!.modelCalls, saved!.modelCalls + 1);
  assert.equal(new Set(result.platformClaims!.map((row) => row.id)).size, 2);
  assert.ok(readArchitectureDesignProgress(f.record, f));
});

test("整合耗尽后无决策冲突可由程序校验完成，24轮及原会话保留，不能冒充独立评审", async () => {
  const f = fixture(3);
  f.modules.forEach((module, index) => { module.capabilities[0]!.reason = `模块${index}的原始能力说明`; });
  await assert.rejects(f.run({ runRole: f.mockRole(async ({ options, send, value }) => {
    for (let i = 0; i < (options.stage === "blueprint" ? 4 : 5); i++) await send();
    if (options.stage === "integration") await send();
    await options.onResult(value); return value;
  }) }));
  Object.assign(f.record, { status: "failed", draft: { taskSpec: { version: 1 } }, requirements: f.context.requirements });
  const before = structuredClone(f.record.designProgressCheckpoint!);
  assert.equal(before!.modelCalls, 24); assert.equal(before!.integration.modelCalls, 5);
  const recovery = architectureDesignRecovery(f.record)!;
  assert.equal(recovery!.status, "continuing"); assert.equal(recoveryFields(recovery).localCompletion, true);
  let validations = 0;
  const result = candidateResult(await f.run({ runRole: () => { throw new Error("程序恢复不得调用模型"); },
    validateProgramCandidate: (candidate: unknown): void => { validations++; validateDesign(candidate, { requirements: f.context.requirements }); } }));
  assert.equal(validations, 1);
  assert.equal(f.record.designProgressCheckpoint!.integration.completedBy, "program");
  assert.deepEqual(f.record.designProgressCheckpoint!.modules, before!.modules);
  assert.equal(f.record.designProgressCheckpoint!.modelCalls, 24);
  assert.equal(f.record.designProgressCheckpoint!.integration.sessionRef!.file, before!.integration.sessionRef!.file);
  assert.equal(f.record.review, null); assert.equal(f.record.design, null);
  assert.ok(readArchitectureDesignProgress(f.record, f));
  assert.deepEqual(await f.run({ runRole: () => { throw new Error("已保存结果不得重新请求"); } }), result);
});

test("程序恢复的完整校验失败时不保存完成标记，真实状态冲突不走程序恢复", async () => {
  const f = fixture();
  await assert.rejects(f.run({ runRole: f.mockRole(async ({ options, send, value }) => {
    await send();
    if (options.stage === "integration") { for (let i = 0; i < 4; i++) await send(); throw new Error("固定整合中断"); }
    await options.onResult(value); return value;
  }) }));
  const before = structuredClone(f.record.designProgressCheckpoint!);
  await assert.rejects(f.run({ validateProgramCandidate: () => { throw new Error("完整校验阻断"); } }), /完整校验阻断/u);
  assert.deepEqual(f.record.designProgressCheckpoint, before);
  const cp = f.record.designProgressCheckpoint!;
  cp.modules[1]!.result!.capabilities[0]!.status = "unverified";
  cp.modules[1]!.resultHash = designHash(cp.modules[1]!.result);
  const { hash: _old, ...body } = cp; cp.hash = designHash(body);
  Object.assign(f.record, { status: "failed", draft: { taskSpec: { version: 1 } }, requirements: f.context.requirements });
  assert.equal(recoveryFields(architectureDesignRecovery(f.record)).localCompletion, undefined);
  let validated = false;
  await assert.rejects(f.run({ validateProgramCandidate: () => { validated = true; } }));
  assert.equal(validated, false);
});

test("旧已完成整合沿原拼装与摘要恢复，不套新能力合并规则重写候选", async () => {
  const f = fixture(); f.modules[1]!.capabilities[0]!.reason = "另一份原始说明";
  await f.run();
  const legacy = assembleArchitectureCandidate({ ...f, modules: f.modules, blueprint: f.blueprint, candidateSchema: f.context.candidateSchema,
    requirements: f.context.requirements, mergeCapabilityReasons: false });
  const cp = f.record.designProgressCheckpoint!;
  delete cp.assemblyVersion;
  cp.integration.result = { baseHash: designHash(legacy.candidate), updates: [{ path: "/capabilities", value: [legacy.candidate.capabilities[0]] }] };
  cp.integration.resultHash = designHash(cp.integration.result);
  const { hash: _old, ...body } = cp; cp.hash = designHash(body);
  const expected = applyArchitectureIntegration(cp.integration.result, { ...legacy, blueprint: f.blueprint, modules: f.modules,
    candidateSchema: f.context.candidateSchema, requirements: f.context.requirements, mergeCapabilityReasons: false });
  assert.ok(readArchitectureDesignProgress(f.record, f));
  assert.deepEqual(await f.run({ runRole: () => { throw new Error("不能重跑旧整合"); } }), expected);
  assert.equal(f.record.designProgressCheckpoint!.assemblyVersion, undefined);
});

test("全局编号重新分配后评审仍退回实际责任模块，不错误失效同名兄弟", async () => {
  const f = fixture();
  for (const module of f.modules) module.decisions[0]!.id = "shared_decision";
  const candidate = candidateResult(await f.run()), before = structuredClone(f.record.designProgressCheckpoint!), start = f.calls.length;
  f.modules[1]!.decisions[0]!.choice = "按本模块主责要求修正选择";
  await f.run({ revision: { candidate, issues: [{ candidatePaths: ["/decisions/1/choice"] }] } });
  assert.deepEqual(f.calls.slice(start).map(row => row.key), ["module_1", "integration"]);
  assert.deepEqual(f.record.designProgressCheckpoint!.modules[0], before!.modules[0]);
  assert.equal(f.record.designProgressCheckpoint!.modules[1]!.generation, 1);
});

test("全局25轮及每节点5轮并发记账，压缩计费而网络重连沿原次数策略", async () => {
  const f = fixture(3);
  await f.run({ runRole: f.mockRole(async ({ options, send, value }) => {
    assert.equal(options.modelCallLimit, 5);
    assert.equal(options.payload.designModelBudget!.limit, 25);
    for (let index = 0; index < 5; index++) await send({ purpose: index ? "compaction" : "agent", retryAttempt: 0 });
    await send({ purpose: "agent", retryAttempt: 1 });
    await options.onResult(value); return value;
  }) });
  assert.equal(f.record.designProgressCheckpoint!.schemaVersion, 4);
  assert.equal(f.record.designProgressCheckpoint!.modelCalls, 25);
  assert.ok(f.saved.every(checkpoint => checkpoint.modelCalls <= 25));
  for (const entry of [f.record.designProgressCheckpoint!.blueprint, ...f.record.designProgressCheckpoint!.modules, f.record.designProgressCheckpoint!.integration])
    assert.equal(entry.modelCalls, 5);
});

test("节点额度耗尽后恢复不能开新会话或补回次数", async () => {
  const f = fixture(); let sent = 0;
  await assert.rejects(f.run({ runRole: f.mockRole(async ({ send }) => {
    for (let index = 0; index < 6; index++) { await send(); sent++; }
  }) }), error => failureFields(error).diagnostic?.reason === "turn_limit");
  assert.equal(sent, 5); assert.equal(f.record.designProgressCheckpoint!.modelCalls, 5);
  const before = f.calls.length;
  await assert.rejects(f.run(), error => failureFields(error).diagnostic?.reason === "turn_limit");
  assert.equal(f.calls.length, before);
});

test("历史三轮检查点仍使用十五轮总账，已授权修复只续接原五轮且用量不清零", async () => {
  for (const repaired of [false, true]) {
    const f = fixture();
    await assert.rejects(f.run({ runRole: f.mockRole(async ({ send }) => {
      for (let i = 0; i < 3; i++) await send();
      throw new Error("固定历史中断");
    }) }));
    const checkpoint = f.record.designProgressCheckpoint!;
    checkpoint.schemaVersion = 1;
    delete checkpoint.consultations;
    checkpoint.schemaHash = designHash({ candidateSchema: f.context.candidateSchema,
      schemas: createArchitectureStageSchemas({ ...f.context, legacyBlueprint: true }) });
    if (repaired) {
      checkpoint.repair = { stage: "blueprint", key: "blueprint", additionalCalls: 2, sourceVersion: 1, sourceHash: checkpoint.hash };
      checkpoint.blueprint.modelCalls = checkpoint.modelCalls = 4;
    }
    const { hash: _old, ...body } = checkpoint; checkpoint.hash = designHash(body);
    f.record.status = "failed"; f.record.version = 2;
    const saved = structuredClone(checkpoint), recovery = architectureDesignRecovery(f.record)!;
    assert.equal(recovery!.pipelineModelCallLimit, 15);
    assert.equal(recovery!.modelCallLimit, repaired ? 5 : 3);
    assert.ok(readArchitectureDesignProgress(f.record, f));
    assert.deepEqual(f.record.designProgressCheckpoint, saved);
    if (!repaired) {
      const count = f.calls.length;
      await assert.rejects(f.run(), error => failureFields(error).diagnostic?.reason === "turn_limit");
      assert.equal(f.calls.length, count);
    } else {
      await assert.rejects(f.run({ runRole: f.mockRole(async ({ options, send }) => {
        assert.equal(options.modelCalls, 4); assert.equal(options.modelCallLimit, 5);
        assert.equal(options.sessionStorage.file, saved.blueprint.sessionRef!.file);
        await send(); await send();
      }) }), error => failureFields(error).diagnostic?.reason === "turn_limit");
      assert.equal(f.record.designProgressCheckpoint!.modelCalls, 5);
      assert.equal(architectureDesignRecovery(f.record)!.status, "blocked");
    }
  }
});

test("显式修复只为绑定失败节点增加一次两轮额度，保留已完成兄弟与原会话并计入总账", async () => {
  const f = fixture(3);
  f.blueprint.modules[2]!.dependsOn = ["module_0"];
  f.modules[2]!.steps[0]!.dependsOn = [{ moduleId: "module_0", id: "step_0" }];
  await assert.rejects(f.run({ runRole: f.mockRole(async ({ options, send, value }) => {
    if (options.key === "module_1") { for (let i = 0; i < 6; i++) await send(); }
    await send(); await options.onResult(value); return value;
  }) }));
  f.record.status = "failed";
  const before = structuredClone(f.record.designProgressCheckpoint!), recovery = architectureDesignRecovery(f.record)!;
  assert.equal(recovery!.status, "available"); assert.equal(recovery!.stageKey, "module_1");
  const start = f.calls.length, saved = f.saved.length;
  await assert.rejects(f.run(), error => failureFields(error).diagnostic?.reason === "turn_limit");
  assert.equal(f.calls.length, start);
  f.record.version++;
  for (const repair of [{ ...recovery!.request, version: 80 }, { ...recovery!.request, stageKey: "module_0" },
    { ...recovery!.request, checkpointHash: "0".repeat(64) }])
    await assert.rejects(f.run({ repair }), /授权/u);
  assert.equal(f.calls.length, start);
  const result = candidateResult(await f.run({ repair: recovery!.request, runRole: f.mockRole(async ({ options, send, value }) => {
    if (options.stage === "module") {
      assert.equal(options.modelCallLimit, 7); assert.equal(options.modelCalls, 5);
      assert.equal(options.sessionStorage.file, before!.modules[1]!.sessionRef!.file);
      assert.ok(options.payload.stageRepair);
      assert.equal(f.saved.at(-1)!.repair!.key, "module_1", "实际请求前已持久保存授权");
    }
    await send(); await options.onResult(value); return value;
  }) }));
  assert.deepEqual(f.calls.slice(start).map(row => row.key), ["module_1", "integration"]);
  assert.equal(f.record.designProgressCheckpoint!.modelCalls, before!.modelCalls + 2);
  assert.equal(f.record.designProgressCheckpoint!.modules[1]!.modelCalls, 6);
  for (const index of [0, 2]) assert.deepEqual(f.record.designProgressCheckpoint!.modules[index], before!.modules[index]);
  assert.deepEqual(f.record.designProgressCheckpoint!.blueprint, before!.blueprint);
  assert.ok(f.saved.length > saved);
  assert.doesNotThrow(() => validateDesign(result, { requirements: f.context.requirements }));
  assert.ok(readArchitectureDesignProgress(f.record, f));
  await assert.rejects(f.run({ repair: recovery!.request }), /授权/u);
});

test("局部修复再次中断沿原授权剩余次数续接，耗尽后不能重复领取或越过全局额度", async () => {
  const f = fixture();
  const exhaust = f.mockRole(async ({ send }) => { for (let i = 0; i < 6; i++) await send(); });
  await assert.rejects(f.run({ runRole: exhaust })); f.record.status = "failed";
  const { request } = architectureDesignRecovery(f.record)!; f.record.version++;
  await assert.rejects(f.run({ repair: request, runRole: f.mockRole(async ({ send }) => { await send(); throw new Error("修复中断"); }) }), /修复中断/u);
  const continuing = architectureDesignRecovery(f.record)!;
  assert.equal(continuing!.status, "continuing"); assert.equal(continuing!.modelCalls, 6);
  assert.equal(Object.hasOwn(continuing, "request"), false);
  await assert.rejects(f.run({ runRole: exhaust }));
  assert.equal(architectureDesignRecovery(f.record)!.status, "blocked");
  const start = f.calls.length;
  await assert.rejects(f.run({ repair: request }), /授权/u);
  assert.equal(f.calls.length, start);
  assert.equal(f.record.designProgressCheckpoint!.blueprint.modelCalls, 7);
  assert.ok(f.record.designProgressCheckpoint!.modelCalls <= 25);
});

test("全局额度不足时不签发局部修复授权，已完成节点不转移额度", async () => {
  const f = fixture(3);
  await assert.rejects(f.run({ runRole: f.mockRole(async ({ options, send, value }) => {
    for (let i = 0; i < 5; i++) await send();
    if (options.stage === "integration") await send();
    await options.onResult(value); return value;
  }) }));
  f.record.status = "failed";
  assert.equal(f.record.designProgressCheckpoint!.modelCalls, 25);
  assert.equal(architectureDesignRecovery(f.record)!.status, "blocked");
  assert.equal(Object.hasOwn(architectureDesignRecovery(f.record)!, "request"), false);
  f.record.version++;
  const before = f.calls.length;
  await assert.rejects(f.run({ repair: { version: 1, checkpointHash: f.record.designProgressCheckpoint!.hash, stageKey: "integration" } }), /授权/u);
  assert.equal(f.calls.length, before);
});

test("显式修复授权落盘失败时不发请求，保留原会话与原始已用次数", async () => {
  const f = fixture();
  await assert.rejects(f.run({ runRole: f.mockRole(async ({ send }) => { for (let i = 0; i < 6; i++) await send(); }) }));
  f.record.status = "failed";
  const { request } = architectureDesignRecovery(f.record)!, before = structuredClone(f.record.designProgressCheckpoint!);
  f.record.version++;
  const start = f.calls.length;
  await assert.rejects(f.run({ repair: request, onSave: async (checkpoint) => {
    if (checkpoint.repair) throw new Error("固定授权保存故障");
  } }), /授权保存故障/u);
  assert.equal(f.calls.length, start);
  assert.deepEqual(f.record.designProgressCheckpoint, before);
});

test("损坏进度、不同冻结来源、不同schema、缺失已用原会话引用均拒绝重开", async () => {
  const f = fixture(); await f.run();
  const original = structuredClone(f.record.designProgressCheckpoint!);
  for (const mutate of [(checkpoint: FixtureCheckpoint) => { checkpoint.modelCalls = 0; }, (checkpoint: FixtureCheckpoint) => { checkpoint.blueprint.result!.global.instructions = "改写"; }]) {
    f.record.designProgressCheckpoint = structuredClone(original); mutate(f.record.designProgressCheckpoint);
    await assert.rejects(f.run(), error => error instanceof InputError && failureFields(error).diagnostic?.reason === "design_progress_invalid");
  }
  f.record.designProgressCheckpoint = structuredClone(original);
  await assert.rejects(f.run({ binding: { ...f.binding, materialsHash: "d".repeat(64) } }), InputError);
  await assert.rejects(f.run({ context: { ...f.context, candidateSchema: { ...f.context.candidateSchema, description: "changed contract" } } }), InputError);
  const { hash: _old, ...body } = structuredClone(original); body.modules[0]!.sessionRef = null;
  f.record.designProgressCheckpoint = { ...body, hash: designHash(body) };
  await assert.rejects(f.run(), error => failureFields(error).diagnostic?.reason === "design_history_unavailable");
});

test("调用前记账持久化失败不发送模型请求，也不启动后继节点", async () => {
  const f = fixture(); let sent = 0;
  await assert.rejects(f.run({ onSave: async (checkpoint) => { if (checkpoint.modelCalls) throw new Error("固定落盘失败"); },
    runRole: f.mockRole(async ({ send }) => { await send(); sent++; }) }), /固定落盘失败/u);
  assert.equal(sent, 0); assert.equal(f.calls.length, 1);
  assert.equal(f.record.designProgressCheckpoint!.modelCalls, 0);
});

test("显式取消拒绝迟到阶段提交，保留已发生轮次与原会话", async () => {
  const f = fixture(), controller = new AbortController();
  await assert.rejects(f.run({ signal: controller.signal, runRole: f.mockRole(async ({ options, send, value }) => {
    await send(); controller.abort(new Error("固定取消")); await options.onResult(value); return value;
  }) }), /固定取消/u);
  const checkpoint = f.record.designProgressCheckpoint!;
  assert.equal(checkpoint.blueprint.result, null); assert.equal(checkpoint.modelCalls, 1); assert.ok(checkpoint.blueprint.sessionRef);
  await f.run();
  assert.equal(f.record.designProgressCheckpoint!.modelCalls, 5);
});

test("独立评审修订只退回命中模块及整合，共享累计额度和新代会话不重置", async () => {
  const f = fixture(), candidate = candidateResult(await f.run()), start = f.calls.length;
  const revision = { candidate, candidateHash: designHash(candidate), issues: [{ candidatePaths: ["/components/1/purpose"] }] };
  const result = candidateResult(await f.run({ revision, runRole: f.mockRole(async ({ options, send, value }) => {
    await send(); if (options.stage === "module") moduleValue(value).components[0]!.purpose = "修复独立评审指出的职责问题";
    await options.onResult(value); return value;
  }) }));
  assert.deepEqual(f.calls.slice(start).map(row => row.key), ["module_1", "integration"]);
  assert.equal(result.components[1]!.purpose, "修复独立评审指出的职责问题");
  const checkpoint = f.record.designProgressCheckpoint!;
  assert.deepEqual(checkpoint.modules.map((entry) => [entry.modelCalls, entry.generation]), [[1, 0], [2, 1]]);
  assert.equal(checkpoint.integration.modelCalls, 2); assert.equal(checkpoint.modelCalls, 6);
  assert.equal(objectFields(f.calls[start]!.storage.binding).generation, 1); assert.equal(f.calls[start]!.storage.file, undefined);
  const end = f.calls.length;
  assert.deepEqual(await f.run({ revision }), result); assert.equal(f.calls.length, end);
});

test("评审精确路径优先泛化字段，非阻断意见不扩大修订范围", async () => {
  const f = fixture(), candidate = candidateResult(await f.run()), before = structuredClone(f.record.designProgressCheckpoint!), start = f.calls.length;
  await f.run({ revision: { candidate, issues: [
    { blocking: true, candidatePaths: ["/components/1/purpose"], candidateFields: ["execution", "components"] },
    { blocking: false, candidateFields: ["rationale", "acceptance"] },
  ] } });
  assert.deepEqual(f.calls.slice(start).map(row => row.key), ["module_1", "integration"]);
  assert.deepEqual(f.record.designProgressCheckpoint!.blueprint, before!.blueprint);
  assert.deepEqual(f.record.designProgressCheckpoint!.modules[0], before!.modules[0]);
});

test("评审没有阻断问题时保留完整候选和阶段成果，不开启修订", async () => {
  const f = fixture(), candidate = candidateResult(await f.run()), before = structuredClone(f.record.designProgressCheckpoint!), start = f.calls.length;
  assert.deepEqual(await f.run({ revision: { candidate, issues: [
    { blocking: false, candidatePaths: ["/components/0"], candidateFields: ["execution"] },
  ] } }), candidate);
  assert.equal(f.calls.length, start);
  assert.deepEqual(f.record.designProgressCheckpoint, before);
});

test("修订必需模块或整合已耗尽时先阻断，不失效成果或调用其他节点", async () => {
  for (const exhaustedStage of ["module", "integration"]) {
    const f = fixture(), candidate = candidateResult(await f.run()), checkpoint = f.record.designProgressCheckpoint!;
    const exhausted = exhaustedStage === "module" ? checkpoint.modules[1] : checkpoint.integration;
    checkpoint.modelCalls += 5 - exhausted!.modelCalls; exhausted!.modelCalls = 5;
    const { hash: _old, ...body } = checkpoint; checkpoint.hash = designHash(body);
    const before = structuredClone(checkpoint), start = f.calls.length, saved = f.saved.length;
    await assert.rejects(f.run({ revision: { candidate, issues: [{ blocking: true, candidatePaths: ["/components/1/purpose"] }] } }),
      error => error instanceof InputError && failureFields(error).diagnostic?.reason === "revision_budget_exhausted");
    assert.equal(f.calls.length, start);
    assert.deepEqual(f.record.designProgressCheckpoint, before);
    assert.ok(f.saved.slice(saved).every(value => designHash(value) === designHash(before)));
  }
});

test("修订各节点尚有余量但共享剩余不足时保留成果，不能只启动前一个节点", async () => {
  const f = fixture(3), candidate = candidateResult(await f.run()), checkpoint = f.record.designProgressCheckpoint!;
  checkpoint.blueprint.modelCalls = 5;
  [5, 6, 4].forEach((calls, index) => { checkpoint.modules[index]!.modelCalls = calls; });
  checkpoint.integration.modelCalls = 4; checkpoint.modelCalls = 24;
  checkpoint.repair = { stage: "module", key: "module_1", additionalCalls: 2, sourceVersion: 1, sourceHash: "a".repeat(64) };
  const { hash: _old, ...body } = checkpoint; checkpoint.hash = designHash(body);
  const before = structuredClone(checkpoint), start = f.calls.length;
  await assert.rejects(f.run({ revision: { candidate, issues: [{ blocking: true, candidatePaths: ["/components/2/purpose"] }] } }),
    error => error instanceof InputError && failureFields(error).diagnostic?.reason === "revision_budget_exhausted");
  assert.equal(f.calls.length, start);
  assert.deepEqual(f.record.designProgressCheckpoint, before);
});

test("全局蓝图选型修订保留模块分工，使全部依赖节点失效而不刷新累计次数", async () => {
  const f = fixture(), candidate = candidateResult(await f.run()), start = f.calls.length;
  const revision = { candidate, candidateHash: designHash(candidate), issues: [{ candidateFields: ["rationale"] }] };
  const result = candidateResult(await f.run({ revision, runRole: f.mockRole(async ({ options, send, value }) => {
    await send(); if (options.stage === "blueprint") blueprintValue(value).global.rationale = "按独立评审修正全局选型依据";
    await options.onResult(value); return value;
  }) }));
  assert.deepEqual(f.calls.slice(start).map(row => row.stage), ["blueprint", "module", "module", "integration"]);
  assert.equal(result.rationale, "按独立评审修正全局选型依据");
  assert.equal(f.record.designProgressCheckpoint!.modelCalls, 8);
  assert.ok(f.record.designProgressCheckpoint!.modules.every((entry) => entry.generation === 1 && entry.modelCalls === 2));
  assert.doesNotThrow(() => readArchitectureDesignProgress(f.record, f));
});

test("修订中断后的相同反馈恢复原代，不重复失效或丢失已用回合", async () => {
  const f = fixture(), candidate = candidateResult(await f.run());
  const revision = { candidate, candidateHash: designHash(candidate), issues: [{ candidatePaths: ["/steps/1/completion"] }] };
  await assert.rejects(f.run({ revision, runRole: f.mockRole(async ({ send }) => { await send(); throw new Error("修订中断"); }) }), /修订中断/u);
  const before = f.record.designProgressCheckpoint!.modules[1]; assert.equal(before!.generation, 1); assert.equal(before!.modelCalls, 2);
  const start = f.calls.length;
  await f.run({ revision });
  assert.equal(f.calls[start]!.storage.file, before!.sessionRef!.file);
  assert.equal(f.calls[start]!.modelCalls, 2);
  assert.equal(f.record.designProgressCheckpoint!.modules[1]!.modelCalls, 3);
  assert.equal(f.record.designProgressCheckpoint!.modules[1]!.generation, 1);
  assert.equal(f.record.designProgressCheckpoint!.modelCalls, 7);
});

test("上游模块修订沿依赖闭包退回所有下游，模糊反馈只交整合者局部核对", async () => {
  const f = fixture(3), candidate = candidateResult(await f.run()), start = f.calls.length;
  await f.run({ revision: { candidate, candidateHash: designHash(candidate), issues: [{ candidatePaths: ["/steps/0/completion"] }] } });
  assert.deepEqual(f.calls.slice(start).map(row => row.key), ["module_0", "module_1", "module_2", "integration"]);
  const other = fixture(), previous = candidateResult(await other.run()), before = other.calls.length;
  await other.run({ revision: { candidate: previous, issues: [{ description: "待整合核对的总体意见" }] } });
  assert.deepEqual(other.calls.slice(before).map(row => row.stage), ["integration"]);
  assert.equal(other.record.designProgressCheckpoint!.modelCalls, 5);
});

test("蓝图经既有必要性复核返回真实需求缺口，不伪造蓝图或派发模块", async () => {
  const f = fixture(), needsInput = [{ id: "business_choice", question: "尚未确认的交付范围" }];
  const result = await f.run({ runRole: f.mockRole(async ({ send }) => { await send(); return { needsInput }; }) });
  assert.deepEqual(result, { needsInput });
  assert.deepEqual(f.calls.map(row => row.stage), ["blueprint"]);
  assert.equal(f.record.designProgressCheckpoint!.blueprint.result, null);
  assert.equal(f.record.designProgressCheckpoint!.modelCalls, 1);
});
