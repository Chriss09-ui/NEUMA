import test from "node:test";
import assert from "node:assert/strict";
import { InputError } from "../src/requirements/core.mjs";
import { designSubmissionSchema, designHash, validateDesign } from "../src/architecture/architecture-contract.mjs";
import { architectureDesignRecovery, runArchitectureDesignPipeline, readArchitectureDesignProgress } from "../src/architecture/architecture-design-pipeline.mjs";
import { validDesign } from "./helpers/architecture.mjs";
import { assembleArchitectureCandidate, applyArchitectureIntegration, createArchitectureStageSchemas } from "../src/architecture/architecture-design-stages.mjs";

const moduleFields = ["components", "steps", "capabilities", "failureHandling", "decisions", "coverage", "acceptance", "unknowns", "platformClaims"];

function fixture(count = 2) {
  const requirements = Array.from({ length: count }, (_, index) => ({ id: `req_${index}`, text: `已确认的功能${index}` }));
  const candidate = validDesign(requirements, { schemaVersion: 3,
    interaction: { defaultEntry: "conversation", page: false, operations: false, inputs: "工作记录", results: "摘要", persistentData: "无跨任务状态" },
    connections: [], execution: { language: "none", hosting: "builtin", reason: "复用文本能力" },
    selectionBasis: { capacity: "已确认记录", process: "逐项整理", quality: "保留原文事实", requirementIds: requirements.map(item => item.id), assumptions: [] } });
  const blueprint = { global: Object.fromEntries(Object.entries(candidate).filter(([key]) => !moduleFields.includes(key))),
    modules: requirements.map((item, index) => ({ id: `module_${index}`, purpose: item.text, requirementIds: [item.id],
      dependsOn: index ? [`module_${index - 1}`] : [], inputs: "已知输入", outputs: "本模块结果" })) };
  const modules = blueprint.modules.map((assignment, index) => ({ moduleId: assignment.id, blueprintHash: designHash(blueprint), instructions: `完成模块${index}的原范围。`,
    components: [{ ...candidate.components[0], id: `component_${index}` }],
    steps: [{ ...candidate.steps[0], id: `step_${index}`, componentId: `component_${index}`, dependsOn: index ? [{ moduleId: `module_${index - 1}`, id: `step_${index - 1}` }] : [] }],
    capabilities: structuredClone(candidate.capabilities), failureHandling: structuredClone(candidate.failureHandling),
    decisions: [{ ...candidate.decisions[0], id: `decision_${index}` }],
    coverage: [{ requirementId: requirements[index].id, componentIds: [`component_${index}`], verification: "检查本条原需求" }],
    acceptance: candidate.acceptance.map(row => ({ ...row, id: `${assignment.id}_${row.id}`, requirementIds: assignment.requirementIds })), unknowns: [] }));
  const context = { requirements, candidateSchema: designSubmissionSchema({ taskSpec: { version: 1 } }, { requirements }),
    draft: { taskSpec: "原始需求只发蓝图，整合使用程序拼装候选" }, runtimeCapabilities: { version: 1 }, evidence: [] };
  const binding = { agentId: "staged_case", requirementHash: "a".repeat(64), platformHash: "b".repeat(64), materialsHash: "c".repeat(64), previousCandidateHash: null };
  const record = { agentId: "staged_case", version: 1, design: null, review: null, attempts: [] }, saved = [], calls = [];
  const onSave = async checkpoint => { saved.push(structuredClone(checkpoint)); };
  const mockRole = handler => async options => {
    calls.push({ stage: options.stage, key: options.key, modelCalls: options.modelCalls, storage: structuredClone(options.sessionStorage), payload: options.payload });
    await options.onSessionRef({ file: options.sessionStorage.file ?? `${options.stage}-${options.key}-${options.sessionStorage.binding.generation}.jsonl` });
    const send = async event => { await options.onModelCall(event); };
    const value = options.stage === "blueprint" ? structuredClone(blueprint) : options.stage === "module"
      ? { ...structuredClone(modules.find(module => module.moduleId === options.key)), blueprintHash: options.payload.blueprintHash }
      : { baseHash: options.payload.baseHash, updates: [] };
    if (handler) return handler({ options, send, value });
    await send(); await options.onResult(value); return value;
  };
  const run = overrides => runArchitectureDesignPipeline({ record, context, binding, onSave, runRole: mockRole(), sessionDirectory: "/tmp/neuma-design-pipeline-fixture", ...overrides });
  return { record, context, binding, blueprint, modules, saved, calls, onSave, mockRole, run };
}

test("蓝图、并行模块、整合逐项落盘，最终候选仍须完整校验且不授予评审通过", async () => {
  const f = fixture();
  const result = await f.run();
  const integrationInput = f.calls.find(call => call.stage === "integration").payload;
  for (const key of ["draft", "candidateSchema", "modules", "blueprint"])
    assert.equal(Object.hasOwn(integrationInput, key), false, `整合输入不重复发送${key}`);
  assert.deepEqual(integrationInput.baseCandidate.components, result.components);
  assert.doesNotThrow(() => validateDesign(result, { requirements: f.context.requirements }));
  assert.deepEqual(f.calls.map(row => row.stage), ["blueprint", "module", "module", "integration"]);
  assert.equal(f.record.designProgressCheckpoint.modelCalls, 4);
  assert.ok(f.saved.some(checkpoint => checkpoint.blueprint.result !== null && checkpoint.modules.every(entry => entry.result === null)));
  assert.ok(f.saved.some(checkpoint => checkpoint.modules.every(entry => entry.result !== null) && checkpoint.integration.result === null));
  for (const row of f.calls.filter(row => row.stage === "module")) {
    assert.equal(row.payload.requirements.length, 1);
    assert.equal(Object.hasOwn(row.payload, "draft"), false);
    assert.equal(Object.hasOwn(row.payload, "candidateSchema"), false);
  }
  const loaded = readArchitectureDesignProgress(f.record, f);
  assert.equal(loaded.integration.result !== null, true);
  assert.equal(f.record.design, null); assert.equal(f.record.review, null); assert.deepEqual(f.record.attempts, []);
  assert.deepEqual(await f.run({ runRole: () => { throw new Error("已完成节点不能重跑"); } }), result);
});

test("正式蓝图提交后进程中断仍保留成果，恢复只补未完成节点", async () => {
  const f = fixture();
  await assert.rejects(f.run({ runRole: f.mockRole(async ({ options, send, value }) => {
    await send(); await options.onResult(value); throw new Error("模拟工具提交后进程退出");
  }) }), /模拟工具提交后进程退出/u);
  assert.ok(f.record.designProgressCheckpoint.blueprint.result);
  const start = f.calls.length;
  const result = await f.run();
  assert.deepEqual(f.calls.slice(start).map(row => row.stage), ["module", "module", "integration"]);
  assert.equal(f.record.designProgressCheckpoint.modelCalls, 4);
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
  const ref = f.record.designProgressCheckpoint.modules[0].sessionRef, used = f.record.designProgressCheckpoint.modelCalls;
  const result = await f.run({ runRole: f.mockRole(async ({ options, send, value }) => {
    await send();
    if (options.key === "module_0") {
      assert.equal(options.sessionStorage.file, ref.file);
      value.steps.push({ ...value.steps[0], id: "extra", dependsOn: ["step_0"] });
    }
    if (options.key === "module_1") {
      assert.ok(f.record.designProgressCheckpoint.modules[0].result);
      assert.deepEqual(options.payload.dependencyInterfaces[0].steps.map(step => step.id), ["step_0", "extra"]);
      value.steps[0].dependsOn = [{ moduleId: "module_0", id: "extra" }];
    }
    await options.onResult(value); return value;
  }) });
  assert.deepEqual(result.steps.at(-1).dependsOn, ["extra"]);
  assert.equal(f.record.designProgressCheckpoint.modelCalls, used + 3);
  assert.ok(readArchitectureDesignProgress(f.record, f));
});

test("历史v1/v2完整检查点按原协议和摘要读取，不迁移或刷新次数", async () => {
  for (const schemaVersion of [1, 2]) {
    const f = fixture(), candidate = await f.run(), cp = f.record.designProgressCheckpoint;
    const blueprint = cp.blueprint.result;
    for (const [index, assignment] of blueprint.modules.entries()) {
      assignment.componentIds = cp.modules[index].result.components.map(row => row.id);
      assignment.stepIds = cp.modules[index].result.steps.map(row => row.id);
    }
    cp.schemaVersion = schemaVersion;
    cp.schemaHash = designHash({ candidateSchema: f.context.candidateSchema,
      schemas: createArchitectureStageSchemas({ ...f.context, legacyBlueprint: true }) });
    cp.blueprint.resultHash = designHash(blueprint); cp.assignmentHash = designHash(blueprint.modules);
    for (const entry of cp.modules) {
      entry.result.blueprintHash = cp.blueprint.resultHash;
      for (const step of entry.result.steps) step.dependsOn = step.dependsOn.map(ref => typeof ref === "string" ? ref : ref.id);
      entry.resultHash = designHash(entry.result);
    }
    const { hash: _old, ...body } = cp; cp.hash = designHash(body);
    const before = structuredClone(cp);
    assert.deepEqual(readArchitectureDesignProgress(f.record, f), before);
    assert.deepEqual(await f.run({ runRole: () => { throw new Error("已完成历史不得重跑"); } }), candidate);
    assert.deepEqual(f.record.designProgressCheckpoint, before);
  }
});

test("同名步骤的评审反馈仍定位实际模块，上游修改重新校验下游引用", async () => {
  const f = fixture();
  for (const module of f.modules) module.steps[0].id = "same";
  f.modules[1].steps[0].dependsOn = [{ moduleId: "module_0", id: "same" }];
  const candidate = await f.run(), start = f.calls.length;
  assert.deepEqual(candidate.steps[1].dependsOn, ["module_0__same"]);
  await f.run({ revision: { candidate, issues: [{ candidatePaths: ["/steps/1/completion"] }] } });
  assert.deepEqual(f.calls.slice(start).map(call => call.key), ["module_1", "integration"]);
  assert.ok(readArchitectureDesignProgress(f.record, f));
});

test("一个模块失败保留并行兄弟的完整成果，重启沿原会话只补失败模块", async () => {
  const f = fixture();
  f.blueprint.modules[1].dependsOn = []; f.modules[1].steps[0].dependsOn = [];
  await assert.rejects(f.run({ runRole: f.mockRole(async ({ options, send, value }) => {
    await send();
    if (options.key === "module_0") throw new Error("固定模块截断");
    await options.onResult(value); return value;
  }) }), /固定模块截断/u);
  const checkpoint = f.record.designProgressCheckpoint;
  assert.equal(checkpoint.modules[0].result, null); assert.ok(checkpoint.modules[1].result);
  assert.equal(checkpoint.integration.result, null);
  const firstRef = checkpoint.modules[0].sessionRef.file, start = f.calls.length;
  await f.run();
  assert.deepEqual(f.calls.slice(start).map(row => row.key), ["module_0", "integration"]);
  assert.equal(f.calls[start].storage.file, firstRef);
  assert.equal(f.calls[start].modelCalls, 1);
  assert.equal(f.record.designProgressCheckpoint.modelCalls, 5);
});

test("全部模块保存后跨模块编号重名不阻止拼装，中断恢复只进入整合与原校验", async () => {
  const f = fixture();
  for (const module of f.modules) module.platformClaims = [{ id: "shared_platform_claim", source: "runtimeCapabilities",
    path: "/version", expected: 1, decisionIds: [module.decisions[0].id], acceptanceIds: [module.acceptance[0].id] }];
  await assert.rejects(f.run({ runRole: f.mockRole(async ({ options, send, value }) => {
    if (options.stage === "integration") throw new Error("固定整合前中断");
    await send(); await options.onResult(value); return value;
  }) }), /固定整合前中断/u);
  f.record.status = "failed";
  const saved = structuredClone(f.record.designProgressCheckpoint), start = f.calls.length;
  assert.ok(saved.modules.every(entry => entry.result));
  assert.equal(architectureDesignRecovery(f.record).actionLabel, "继续整合与评审");
  assert.equal(architectureDesignRecovery(f.record).status, "continuing");
  const result = await f.run();
  assert.deepEqual(f.calls.slice(start).map(row => row.stage), ["integration"]);
  assert.deepEqual(f.record.designProgressCheckpoint.modules, saved.modules);
  assert.deepEqual(f.record.designProgressCheckpoint.blueprint, saved.blueprint);
  assert.equal(f.record.designProgressCheckpoint.modelCalls, saved.modelCalls + 1);
  assert.equal(new Set(result.platformClaims.map(row => row.id)).size, 2);
  assert.ok(readArchitectureDesignProgress(f.record, f));
});

test("整合耗尽后无决策冲突可由程序校验完成，24轮及原会话保留，不能冒充独立评审", async () => {
  const f = fixture(3);
  f.modules.forEach((module, index) => { module.capabilities[0].reason = `模块${index}的原始能力说明`; });
  await assert.rejects(f.run({ runRole: f.mockRole(async ({ options, send, value }) => {
    for (let i = 0; i < (options.stage === "blueprint" ? 4 : 5); i++) await send();
    if (options.stage === "integration") await send();
    await options.onResult(value); return value;
  }) }));
  Object.assign(f.record, { status: "failed", draft: { taskSpec: { version: 1 } }, requirements: f.context.requirements });
  const before = structuredClone(f.record.designProgressCheckpoint);
  assert.equal(before.modelCalls, 24); assert.equal(before.integration.modelCalls, 5);
  const recovery = architectureDesignRecovery(f.record);
  assert.equal(recovery.status, "continuing"); assert.equal(recovery.localCompletion, true);
  let validations = 0;
  const result = await f.run({ runRole: () => { throw new Error("程序恢复不得调用模型"); },
    validateProgramCandidate: candidate => { validations++; validateDesign(candidate, { requirements: f.context.requirements }); } });
  assert.equal(validations, 1);
  assert.equal(f.record.designProgressCheckpoint.integration.completedBy, "program");
  assert.deepEqual(f.record.designProgressCheckpoint.modules, before.modules);
  assert.equal(f.record.designProgressCheckpoint.modelCalls, 24);
  assert.equal(f.record.designProgressCheckpoint.integration.sessionRef.file, before.integration.sessionRef.file);
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
  const before = structuredClone(f.record.designProgressCheckpoint);
  await assert.rejects(f.run({ validateProgramCandidate: () => { throw new Error("完整校验阻断"); } }), /完整校验阻断/u);
  assert.deepEqual(f.record.designProgressCheckpoint, before);
  const cp = f.record.designProgressCheckpoint;
  cp.modules[1].result.capabilities[0].status = "unverified";
  cp.modules[1].resultHash = designHash(cp.modules[1].result);
  const { hash: _old, ...body } = cp; cp.hash = designHash(body);
  Object.assign(f.record, { status: "failed", draft: { taskSpec: { version: 1 } }, requirements: f.context.requirements });
  assert.equal(architectureDesignRecovery(f.record).localCompletion, undefined);
  let validated = false;
  await assert.rejects(f.run({ validateProgramCandidate: () => { validated = true; } }));
  assert.equal(validated, false);
});

test("旧已完成整合沿原拼装与摘要恢复，不套新能力合并规则重写候选", async () => {
  const f = fixture(); f.modules[1].capabilities[0].reason = "另一份原始说明";
  await f.run();
  const legacy = assembleArchitectureCandidate({ ...f, modules: f.modules, blueprint: f.blueprint, candidateSchema: f.context.candidateSchema,
    requirements: f.context.requirements, mergeCapabilityReasons: false });
  const cp = f.record.designProgressCheckpoint;
  delete cp.assemblyVersion;
  cp.integration.result = { baseHash: designHash(legacy.candidate), updates: [{ path: "/capabilities", value: [legacy.candidate.capabilities[0]] }] };
  cp.integration.resultHash = designHash(cp.integration.result);
  const { hash: _old, ...body } = cp; cp.hash = designHash(body);
  const expected = applyArchitectureIntegration(cp.integration.result, { ...legacy, blueprint: f.blueprint, modules: f.modules,
    candidateSchema: f.context.candidateSchema, requirements: f.context.requirements, mergeCapabilityReasons: false });
  assert.ok(readArchitectureDesignProgress(f.record, f));
  assert.deepEqual(await f.run({ runRole: () => { throw new Error("不能重跑旧整合"); } }), expected);
  assert.equal(f.record.designProgressCheckpoint.assemblyVersion, undefined);
});

test("全局编号重新分配后评审仍退回实际责任模块，不错误失效同名兄弟", async () => {
  const f = fixture();
  for (const module of f.modules) module.decisions[0].id = "shared_decision";
  const candidate = await f.run(), before = structuredClone(f.record.designProgressCheckpoint), start = f.calls.length;
  f.modules[1].decisions[0].choice = "按本模块主责要求修正选择";
  await f.run({ revision: { candidate, issues: [{ candidatePaths: ["/decisions/1/choice"] }] } });
  assert.deepEqual(f.calls.slice(start).map(row => row.key), ["module_1", "integration"]);
  assert.deepEqual(f.record.designProgressCheckpoint.modules[0], before.modules[0]);
  assert.equal(f.record.designProgressCheckpoint.modules[1].generation, 1);
});

test("全局25轮及每节点5轮并发记账，压缩计费而网络重连沿原次数策略", async () => {
  const f = fixture(3);
  await f.run({ runRole: f.mockRole(async ({ options, send, value }) => {
    assert.equal(options.modelCallLimit, 5);
    assert.equal(options.payload.designModelBudget.limit, 25);
    for (let index = 0; index < 5; index++) await send({ purpose: index ? "compaction" : "agent", retryAttempt: 0 });
    await send({ purpose: "agent", retryAttempt: 1 });
    await options.onResult(value); return value;
  }) });
  assert.equal(f.record.designProgressCheckpoint.schemaVersion, 3);
  assert.equal(f.record.designProgressCheckpoint.modelCalls, 25);
  assert.ok(f.saved.every(checkpoint => checkpoint.modelCalls <= 25));
  for (const entry of [f.record.designProgressCheckpoint.blueprint, ...f.record.designProgressCheckpoint.modules, f.record.designProgressCheckpoint.integration])
    assert.equal(entry.modelCalls, 5);
});

test("节点额度耗尽后恢复不能开新会话或补回次数", async () => {
  const f = fixture(); let sent = 0;
  await assert.rejects(f.run({ runRole: f.mockRole(async ({ send }) => {
    for (let index = 0; index < 6; index++) { await send(); sent++; }
  }) }), error => error.diagnostic?.reason === "turn_limit");
  assert.equal(sent, 5); assert.equal(f.record.designProgressCheckpoint.modelCalls, 5);
  const before = f.calls.length;
  await assert.rejects(f.run(), error => error.diagnostic?.reason === "turn_limit");
  assert.equal(f.calls.length, before);
});

test("历史三轮检查点仍使用十五轮总账，已授权修复只续接原五轮且用量不清零", async () => {
  for (const repaired of [false, true]) {
    const f = fixture();
    await assert.rejects(f.run({ runRole: f.mockRole(async ({ send }) => {
      for (let i = 0; i < 3; i++) await send();
      throw new Error("固定历史中断");
    }) }));
    const checkpoint = f.record.designProgressCheckpoint;
    checkpoint.schemaVersion = 1;
    checkpoint.schemaHash = designHash({ candidateSchema: f.context.candidateSchema,
      schemas: createArchitectureStageSchemas({ ...f.context, legacyBlueprint: true }) });
    if (repaired) {
      checkpoint.repair = { stage: "blueprint", key: "blueprint", additionalCalls: 2, sourceVersion: 1, sourceHash: checkpoint.hash };
      checkpoint.blueprint.modelCalls = checkpoint.modelCalls = 4;
    }
    const { hash: _old, ...body } = checkpoint; checkpoint.hash = designHash(body);
    f.record.status = "failed"; f.record.version = 2;
    const saved = structuredClone(checkpoint), recovery = architectureDesignRecovery(f.record);
    assert.equal(recovery.pipelineModelCallLimit, 15);
    assert.equal(recovery.modelCallLimit, repaired ? 5 : 3);
    assert.ok(readArchitectureDesignProgress(f.record, f));
    assert.deepEqual(f.record.designProgressCheckpoint, saved);
    if (!repaired) {
      const count = f.calls.length;
      await assert.rejects(f.run(), error => error.diagnostic?.reason === "turn_limit");
      assert.equal(f.calls.length, count);
    } else {
      await assert.rejects(f.run({ runRole: f.mockRole(async ({ options, send }) => {
        assert.equal(options.modelCalls, 4); assert.equal(options.modelCallLimit, 5);
        assert.equal(options.sessionStorage.file, saved.blueprint.sessionRef.file);
        await send(); await send();
      }) }), error => error.diagnostic?.reason === "turn_limit");
      assert.equal(f.record.designProgressCheckpoint.modelCalls, 5);
      assert.equal(architectureDesignRecovery(f.record).status, "blocked");
    }
  }
});

test("显式修复只为绑定失败节点增加一次两轮额度，保留已完成兄弟与原会话并计入总账", async () => {
  const f = fixture(3);
  f.blueprint.modules[2].dependsOn = ["module_0"];
  f.modules[2].steps[0].dependsOn = [{ moduleId: "module_0", id: "step_0" }];
  await assert.rejects(f.run({ runRole: f.mockRole(async ({ options, send, value }) => {
    if (options.key === "module_1") { for (let i = 0; i < 6; i++) await send(); }
    await send(); await options.onResult(value); return value;
  }) }));
  f.record.status = "failed";
  const before = structuredClone(f.record.designProgressCheckpoint), recovery = architectureDesignRecovery(f.record);
  assert.equal(recovery.status, "available"); assert.equal(recovery.stageKey, "module_1");
  const start = f.calls.length, saved = f.saved.length;
  await assert.rejects(f.run(), error => error.diagnostic?.reason === "turn_limit");
  assert.equal(f.calls.length, start);
  f.record.version++;
  for (const repair of [{ ...recovery.request, version: 80 }, { ...recovery.request, stageKey: "module_0" },
    { ...recovery.request, checkpointHash: "0".repeat(64) }])
    await assert.rejects(f.run({ repair }), /授权/u);
  assert.equal(f.calls.length, start);
  const result = await f.run({ repair: recovery.request, runRole: f.mockRole(async ({ options, send, value }) => {
    if (options.stage === "module") {
      assert.equal(options.modelCallLimit, 7); assert.equal(options.modelCalls, 5);
      assert.equal(options.sessionStorage.file, before.modules[1].sessionRef.file);
      assert.ok(options.payload.stageRepair);
      assert.equal(f.saved.at(-1).repair.key, "module_1", "实际请求前已持久保存授权");
    }
    await send(); await options.onResult(value); return value;
  }) });
  assert.deepEqual(f.calls.slice(start).map(row => row.key), ["module_1", "integration"]);
  assert.equal(f.record.designProgressCheckpoint.modelCalls, before.modelCalls + 2);
  assert.equal(f.record.designProgressCheckpoint.modules[1].modelCalls, 6);
  for (const index of [0, 2]) assert.deepEqual(f.record.designProgressCheckpoint.modules[index], before.modules[index]);
  assert.deepEqual(f.record.designProgressCheckpoint.blueprint, before.blueprint);
  assert.ok(f.saved.length > saved);
  assert.doesNotThrow(() => validateDesign(result, { requirements: f.context.requirements }));
  assert.ok(readArchitectureDesignProgress(f.record, f));
  await assert.rejects(f.run({ repair: recovery.request }), /授权/u);
});

test("局部修复再次中断沿原授权剩余次数续接，耗尽后不能重复领取或越过全局额度", async () => {
  const f = fixture();
  const exhaust = f.mockRole(async ({ send }) => { for (let i = 0; i < 6; i++) await send(); });
  await assert.rejects(f.run({ runRole: exhaust })); f.record.status = "failed";
  const { request } = architectureDesignRecovery(f.record); f.record.version++;
  await assert.rejects(f.run({ repair: request, runRole: f.mockRole(async ({ send }) => { await send(); throw new Error("修复中断"); }) }), /修复中断/u);
  const continuing = architectureDesignRecovery(f.record);
  assert.equal(continuing.status, "continuing"); assert.equal(continuing.modelCalls, 6);
  assert.equal(Object.hasOwn(continuing, "request"), false);
  await assert.rejects(f.run({ runRole: exhaust }));
  assert.equal(architectureDesignRecovery(f.record).status, "blocked");
  const start = f.calls.length;
  await assert.rejects(f.run({ repair: request }), /授权/u);
  assert.equal(f.calls.length, start);
  assert.equal(f.record.designProgressCheckpoint.blueprint.modelCalls, 7);
  assert.ok(f.record.designProgressCheckpoint.modelCalls <= 25);
});

test("全局额度不足时不签发局部修复授权，已完成节点不转移额度", async () => {
  const f = fixture(3);
  await assert.rejects(f.run({ runRole: f.mockRole(async ({ options, send, value }) => {
    for (let i = 0; i < 5; i++) await send();
    if (options.stage === "integration") await send();
    await options.onResult(value); return value;
  }) }));
  f.record.status = "failed";
  assert.equal(f.record.designProgressCheckpoint.modelCalls, 25);
  assert.equal(architectureDesignRecovery(f.record).status, "blocked");
  assert.equal(Object.hasOwn(architectureDesignRecovery(f.record), "request"), false);
  f.record.version++;
  const before = f.calls.length;
  await assert.rejects(f.run({ repair: { version: 1, checkpointHash: f.record.designProgressCheckpoint.hash, stageKey: "integration" } }), /授权/u);
  assert.equal(f.calls.length, before);
});

test("显式修复授权落盘失败时不发请求，保留原会话与原始已用次数", async () => {
  const f = fixture();
  await assert.rejects(f.run({ runRole: f.mockRole(async ({ send }) => { for (let i = 0; i < 6; i++) await send(); }) }));
  f.record.status = "failed";
  const { request } = architectureDesignRecovery(f.record), before = structuredClone(f.record.designProgressCheckpoint);
  f.record.version++;
  const start = f.calls.length;
  await assert.rejects(f.run({ repair: request, onSave: async checkpoint => {
    if (checkpoint.repair) throw new Error("固定授权保存故障");
  } }), /授权保存故障/u);
  assert.equal(f.calls.length, start);
  assert.deepEqual(f.record.designProgressCheckpoint, before);
});

test("损坏进度、不同冻结来源、不同schema、缺失已用原会话引用均拒绝重开", async () => {
  const f = fixture(); await f.run();
  const original = structuredClone(f.record.designProgressCheckpoint);
  for (const mutate of [checkpoint => { checkpoint.modelCalls = 0; }, checkpoint => { checkpoint.blueprint.result.global.instructions = "改写"; }]) {
    f.record.designProgressCheckpoint = structuredClone(original); mutate(f.record.designProgressCheckpoint);
    await assert.rejects(f.run(), error => error instanceof InputError && error.diagnostic?.reason === "design_progress_invalid");
  }
  f.record.designProgressCheckpoint = structuredClone(original);
  await assert.rejects(f.run({ binding: { ...f.binding, materialsHash: "d".repeat(64) } }), InputError);
  await assert.rejects(f.run({ context: { ...f.context, candidateSchema: { ...f.context.candidateSchema, description: "changed contract" } } }), InputError);
  const { hash: _old, ...body } = structuredClone(original); body.modules[0].sessionRef = null;
  f.record.designProgressCheckpoint = { ...body, hash: designHash(body) };
  await assert.rejects(f.run(), error => error.diagnostic?.reason === "design_history_unavailable");
});

test("调用前记账持久化失败不发送模型请求，也不启动后继节点", async () => {
  const f = fixture(); let sent = 0;
  await assert.rejects(f.run({ onSave: async checkpoint => { if (checkpoint.modelCalls) throw new Error("固定落盘失败"); },
    runRole: f.mockRole(async ({ send }) => { await send(); sent++; }) }), /固定落盘失败/u);
  assert.equal(sent, 0); assert.equal(f.calls.length, 1);
  assert.equal(f.record.designProgressCheckpoint.modelCalls, 0);
});

test("显式取消拒绝迟到阶段提交，保留已发生轮次与原会话", async () => {
  const f = fixture(), controller = new AbortController();
  await assert.rejects(f.run({ signal: controller.signal, runRole: f.mockRole(async ({ options, send, value }) => {
    await send(); controller.abort(new Error("固定取消")); await options.onResult(value); return value;
  }) }), /固定取消/u);
  const checkpoint = f.record.designProgressCheckpoint;
  assert.equal(checkpoint.blueprint.result, null); assert.equal(checkpoint.modelCalls, 1); assert.ok(checkpoint.blueprint.sessionRef);
  await f.run();
  assert.equal(f.record.designProgressCheckpoint.modelCalls, 5);
});

test("独立评审修订只退回命中模块及整合，共享累计额度和新代会话不重置", async () => {
  const f = fixture(), candidate = await f.run(), start = f.calls.length;
  const revision = { candidate, candidateHash: designHash(candidate), issues: [{ candidatePaths: ["/components/1/purpose"] }] };
  const result = await f.run({ revision, runRole: f.mockRole(async ({ options, send, value }) => {
    await send(); if (options.stage === "module") value.components[0].purpose = "修复独立评审指出的职责问题";
    await options.onResult(value); return value;
  }) });
  assert.deepEqual(f.calls.slice(start).map(row => row.key), ["module_1", "integration"]);
  assert.equal(result.components[1].purpose, "修复独立评审指出的职责问题");
  const checkpoint = f.record.designProgressCheckpoint;
  assert.deepEqual(checkpoint.modules.map(entry => [entry.modelCalls, entry.generation]), [[1, 0], [2, 1]]);
  assert.equal(checkpoint.integration.modelCalls, 2); assert.equal(checkpoint.modelCalls, 6);
  assert.equal(f.calls[start].storage.binding.generation, 1); assert.equal(f.calls[start].storage.file, undefined);
  const end = f.calls.length;
  assert.deepEqual(await f.run({ revision }), result); assert.equal(f.calls.length, end);
});

test("评审精确路径优先泛化字段，非阻断意见不扩大修订范围", async () => {
  const f = fixture(), candidate = await f.run(), before = structuredClone(f.record.designProgressCheckpoint), start = f.calls.length;
  await f.run({ revision: { candidate, issues: [
    { blocking: true, candidatePaths: ["/components/1/purpose"], candidateFields: ["execution", "components"] },
    { blocking: false, candidateFields: ["rationale", "acceptance"] },
  ] } });
  assert.deepEqual(f.calls.slice(start).map(row => row.key), ["module_1", "integration"]);
  assert.deepEqual(f.record.designProgressCheckpoint.blueprint, before.blueprint);
  assert.deepEqual(f.record.designProgressCheckpoint.modules[0], before.modules[0]);
});

test("评审没有阻断问题时保留完整候选和阶段成果，不开启修订", async () => {
  const f = fixture(), candidate = await f.run(), before = structuredClone(f.record.designProgressCheckpoint), start = f.calls.length;
  assert.deepEqual(await f.run({ revision: { candidate, issues: [
    { blocking: false, candidatePaths: ["/components/0"], candidateFields: ["execution"] },
  ] } }), candidate);
  assert.equal(f.calls.length, start);
  assert.deepEqual(f.record.designProgressCheckpoint, before);
});

test("修订必需模块或整合已耗尽时先阻断，不失效成果或调用其他节点", async () => {
  for (const exhaustedStage of ["module", "integration"]) {
    const f = fixture(), candidate = await f.run(), checkpoint = f.record.designProgressCheckpoint;
    const exhausted = exhaustedStage === "module" ? checkpoint.modules[1] : checkpoint.integration;
    checkpoint.modelCalls += 5 - exhausted.modelCalls; exhausted.modelCalls = 5;
    const { hash: _old, ...body } = checkpoint; checkpoint.hash = designHash(body);
    const before = structuredClone(checkpoint), start = f.calls.length, saved = f.saved.length;
    await assert.rejects(f.run({ revision: { candidate, issues: [{ blocking: true, candidatePaths: ["/components/1/purpose"] }] } }),
      error => error instanceof InputError && error.diagnostic?.reason === "revision_budget_exhausted");
    assert.equal(f.calls.length, start);
    assert.deepEqual(f.record.designProgressCheckpoint, before);
    assert.ok(f.saved.slice(saved).every(value => designHash(value) === designHash(before)));
  }
});

test("修订各节点尚有余量但共享剩余不足时保留成果，不能只启动前一个节点", async () => {
  const f = fixture(3), candidate = await f.run(), checkpoint = f.record.designProgressCheckpoint;
  checkpoint.blueprint.modelCalls = 5;
  [5, 6, 4].forEach((calls, index) => { checkpoint.modules[index].modelCalls = calls; });
  checkpoint.integration.modelCalls = 4; checkpoint.modelCalls = 24;
  checkpoint.repair = { stage: "module", key: "module_1", additionalCalls: 2, sourceVersion: 1, sourceHash: "a".repeat(64) };
  const { hash: _old, ...body } = checkpoint; checkpoint.hash = designHash(body);
  const before = structuredClone(checkpoint), start = f.calls.length;
  await assert.rejects(f.run({ revision: { candidate, issues: [{ blocking: true, candidatePaths: ["/components/2/purpose"] }] } }),
    error => error instanceof InputError && error.diagnostic?.reason === "revision_budget_exhausted");
  assert.equal(f.calls.length, start);
  assert.deepEqual(f.record.designProgressCheckpoint, before);
});

test("全局蓝图选型修订保留模块分工，使全部依赖节点失效而不刷新累计次数", async () => {
  const f = fixture(), candidate = await f.run(), start = f.calls.length;
  const revision = { candidate, candidateHash: designHash(candidate), issues: [{ candidateFields: ["rationale"] }] };
  const result = await f.run({ revision, runRole: f.mockRole(async ({ options, send, value }) => {
    await send(); if (options.stage === "blueprint") value.global.rationale = "按独立评审修正全局选型依据";
    await options.onResult(value); return value;
  }) });
  assert.deepEqual(f.calls.slice(start).map(row => row.stage), ["blueprint", "module", "module", "integration"]);
  assert.equal(result.rationale, "按独立评审修正全局选型依据");
  assert.equal(f.record.designProgressCheckpoint.modelCalls, 8);
  assert.ok(f.record.designProgressCheckpoint.modules.every(entry => entry.generation === 1 && entry.modelCalls === 2));
  assert.doesNotThrow(() => readArchitectureDesignProgress(f.record, f));
});

test("修订中断后的相同反馈恢复原代，不重复失效或丢失已用回合", async () => {
  const f = fixture(), candidate = await f.run();
  const revision = { candidate, candidateHash: designHash(candidate), issues: [{ candidatePaths: ["/steps/1/completion"] }] };
  await assert.rejects(f.run({ revision, runRole: f.mockRole(async ({ send }) => { await send(); throw new Error("修订中断"); }) }), /修订中断/u);
  const before = f.record.designProgressCheckpoint.modules[1]; assert.equal(before.generation, 1); assert.equal(before.modelCalls, 2);
  const start = f.calls.length;
  await f.run({ revision });
  assert.equal(f.calls[start].storage.file, before.sessionRef.file);
  assert.equal(f.calls[start].modelCalls, 2);
  assert.equal(f.record.designProgressCheckpoint.modules[1].modelCalls, 3);
  assert.equal(f.record.designProgressCheckpoint.modules[1].generation, 1);
  assert.equal(f.record.designProgressCheckpoint.modelCalls, 7);
});

test("上游模块修订沿依赖闭包退回所有下游，模糊反馈只交整合者局部核对", async () => {
  const f = fixture(3), candidate = await f.run(), start = f.calls.length;
  await f.run({ revision: { candidate, candidateHash: designHash(candidate), issues: [{ candidatePaths: ["/steps/0/completion"] }] } });
  assert.deepEqual(f.calls.slice(start).map(row => row.key), ["module_0", "module_1", "module_2", "integration"]);
  const other = fixture(), previous = await other.run(), before = other.calls.length;
  await other.run({ revision: { candidate: previous, issues: [{ description: "待整合核对的总体意见" }] } });
  assert.deepEqual(other.calls.slice(before).map(row => row.stage), ["integration"]);
  assert.equal(other.record.designProgressCheckpoint.modelCalls, 5);
});

test("蓝图经既有必要性复核返回真实需求缺口，不伪造蓝图或派发模块", async () => {
  const f = fixture(), needsInput = [{ id: "business_choice", question: "尚未确认的交付范围" }];
  const result = await f.run({ runRole: f.mockRole(async ({ send }) => { await send(); return { needsInput }; }) });
  assert.deepEqual(result, { needsInput });
  assert.deepEqual(f.calls.map(row => row.stage), ["blueprint"]);
  assert.equal(f.record.designProgressCheckpoint.blueprint.result, null);
  assert.equal(f.record.designProgressCheckpoint.modelCalls, 1);
});
