import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { InputError, ProviderError } from "../requirements/core.mjs";
import { designHash, designSubmissionSchema } from "./architecture-contract.mjs";
import { copyArchitectureReviewJson, reviewCheckpointObject } from "./architecture-review-binding.mjs";
import { createArchitectureStageSchemas, validateArchitectureBlueprint, validateArchitectureModule, architectureModuleLayers,
  assembleArchitectureCandidate, applyArchitectureIntegration } from "./architecture-design-stages.mjs";

export const ARCHITECTURE_DESIGN_PIPELINE_CALL_LIMIT = 25;
export const ARCHITECTURE_DESIGN_STAGE_CALL_LIMIT = 5;
export const ARCHITECTURE_DESIGN_REPAIR_CALL_LIMIT = 2;
export const ARCHITECTURE_DESIGN_INTEGRATION_RESERVE = ARCHITECTURE_DESIGN_STAGE_CALL_LIMIT;
export const ARCHITECTURE_DESIGN_PROGRESS_MAX_BYTES = 2 * 1024 * 1024;

const checkpointKeys = ["schemaVersion", "pipelineId", "bindingHash", "schemaHash", "modelCalls", "revisionHash", "assignmentHash", "blueprint", "modules", "integration", "hash"];
const stageKeys = ["key", "modelCalls", "sessionStartCalls", "generation", "sessionRef", "result", "resultHash"];
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const exact = (value, fields) => reviewCheckpointObject(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const copy = value => copyArchitectureReviewJson(value, { maxDepth: 48, maxNodes: 300_000, maxBytes: ARCHITECTURE_DESIGN_PROGRESS_MAX_BYTES });
const state = key => ({ key, modelCalls: 0, sessionStartCalls: 0, generation: 0, sessionRef: null, result: null, resultHash: null });
const complete = entry => entry.result !== null;
const sealed = checkpoint => {
  const { hash: _previous, ...body } = checkpoint;
  return copy({ ...body, hash: designHash(body) });
};

// Limits belong to a persisted attempt; deploying new defaults must not refill old attempts.
export function architectureDesignCallLimits(checkpoint) {
  if (checkpoint?.schemaVersion === 1) return { stage: 3, pipeline: 15 };
  if ([2, 3].includes(checkpoint?.schemaVersion)) return { stage: ARCHITECTURE_DESIGN_STAGE_CALL_LIMIT, pipeline: ARCHITECTURE_DESIGN_PIPELINE_CALL_LIMIT };
  throw invalid();
}

function invalid(reason = "design_progress_invalid") {
  const error = new InputError(reason === "design_history_unavailable"
    ? "设计节点已发生模型调用，但原会话引用不可用；不能新建会话替代已用进度。"
    : "架构设计进度与当前材料不一致或已损坏；不能重开节点清空已用额度。");
  error.diagnostic = { stage: "architecture", reason, role: "designer", phase: "designing" };
  return error;
}

function stopped(checkpoint, stage, reason = "turn_limit") {
  return new ProviderError(reason === "cancelled" ? "架构设计已停止，已保存的节点成果保留。"
    : "架构设计节点达到共享调用额度，已保存成果保留；未完成方案不能进入评审。", {
    stage: "architecture", reason, role: stage === "module" ? "specialist" : "designer", phase: "designing",
    pipelineStage: stage, modelCalls: checkpoint.modelCalls, modelCallLimit: architectureDesignCallLimits(checkpoint).pipeline,
  });
}

const stageLimit = (checkpoint, stage, key) => architectureDesignCallLimits(checkpoint).stage
  + (checkpoint.repair?.stage === stage && checkpoint.repair.key === key ? ARCHITECTURE_DESIGN_REPAIR_CALL_LIMIT : 0);
const integrationReserve = checkpoint => complete(checkpoint.integration) ? 0
  : Math.max(0, stageLimit(checkpoint, "integration", "integration") - checkpoint.integration.modelCalls);
const stages = checkpoint => [
  { stage: "blueprint", entry: checkpoint.blueprint },
  ...checkpoint.modules.map(entry => ({ stage: "module", entry })),
  { stage: "integration", entry: checkpoint.integration },
];

function stageState(value, limit = ARCHITECTURE_DESIGN_STAGE_CALL_LIMIT) {
  const program = Object.hasOwn(value ?? {}, "completedBy");
  if (!exact(value, program ? [...stageKeys, "completedBy"] : stageKeys)
    || program && (value.key !== "integration" || value.completedBy !== "program" || value.result === null)
    || typeof value.key !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,99}$/u.test(value.key)
    || !Number.isSafeInteger(value.modelCalls) || value.modelCalls < 0 || value.modelCalls > limit
    || !Number.isSafeInteger(value.sessionStartCalls) || value.sessionStartCalls < 0 || value.sessionStartCalls > value.modelCalls
    || !Number.isSafeInteger(value.generation) || value.generation < 0 || value.generation > 1
    || value.generation === 0 && value.sessionStartCalls !== 0)
    throw invalid();
  if (value.sessionRef !== null && (!exact(value.sessionRef, ["file"])
    || typeof value.sessionRef.file !== "string" || !/^[A-Za-z0-9_.-]+\.jsonl$/u.test(value.sessionRef.file))) throw invalid();
  if (value.modelCalls > value.sessionStartCalls && !value.sessionRef) throw invalid("design_history_unavailable");
  if (value.result === null ? value.resultHash !== null : !hash(value.resultHash) || value.resultHash !== designHash(value.result)
    || value.modelCalls === value.sessionStartCalls || !value.sessionRef) throw invalid();
  return value;
}

function checkpointState(checkpoint) {
  const keys = [...checkpointKeys, ...["repair", "assemblyVersion"].filter(key => Object.hasOwn(checkpoint, key))];
  if (!exact(checkpoint, keys) || Object.hasOwn(checkpoint, "assemblyVersion") && checkpoint.assemblyVersion !== 2
    || ![1, 2, 3].includes(checkpoint.schemaVersion) || typeof checkpoint.pipelineId !== "string" || !/^[a-f0-9-]{36}$/u.test(checkpoint.pipelineId)
    || !hash(checkpoint.hash) || checkpoint.hash !== sealed(checkpoint).hash
    || checkpoint.revisionHash !== null && !hash(checkpoint.revisionHash)
    || checkpoint.assignmentHash !== null && !hash(checkpoint.assignmentHash)
    || !Number.isSafeInteger(checkpoint.modelCalls) || checkpoint.modelCalls < 0
    || checkpoint.modelCalls > architectureDesignCallLimits(checkpoint).pipeline || !Array.isArray(checkpoint.modules)
    || checkpoint.modules.length > 3) throw invalid();
  if (Object.hasOwn(checkpoint, "repair")) {
    const repair = checkpoint.repair;
    if (!exact(repair, ["stage", "key", "additionalCalls", "sourceVersion", "sourceHash"])
      || !["blueprint", "module", "integration"].includes(repair.stage)
      || repair.additionalCalls !== ARCHITECTURE_DESIGN_REPAIR_CALL_LIMIT
      || !Number.isSafeInteger(repair.sourceVersion) || repair.sourceVersion < 1 || !hash(repair.sourceHash)
      || !stages(checkpoint).some(({ stage, entry }) => stage === repair.stage && entry?.key === repair.key
        && entry.modelCalls >= architectureDesignCallLimits(checkpoint).stage)) throw invalid();
  }
  for (const { stage, entry } of stages(checkpoint)) stageState(entry, stageLimit(checkpoint, stage, entry?.key));
  if (checkpoint.blueprint.key !== "blueprint" || checkpoint.integration.key !== "integration"
    || new Set(checkpoint.modules.map(entry => entry.key)).size !== checkpoint.modules.length
    || checkpoint.modelCalls !== stages(checkpoint).reduce((total, { entry }) => total + entry.modelCalls, 0)) throw invalid();
  if (checkpoint.integration.completedBy === "program" && (checkpoint.assemblyVersion !== 2
    || checkpoint.integration.result.updates?.length !== 0)) throw invalid();
}

function programIntegration(checkpoint, context) {
  context = { ...context, legacyBlueprint: checkpoint.schemaVersion < 3 };
  if (!complete(checkpoint.blueprint) || !checkpoint.modules.length || !checkpoint.modules.every(complete)
    || complete(checkpoint.integration) || checkpoint.integration.modelCalls < architectureDesignCallLimits(checkpoint).stage) return null;
  const blueprint = checkpoint.blueprint.result, modules = checkpoint.modules.map(entry => entry.result);
  const assembled = assembleArchitectureCandidate({ ...context, blueprint, modules, mergeCapabilityReasons: true });
  if (assembled.conflicts.length) return null;
  const submission = { baseHash: designHash(assembled.candidate), updates: [] };
  const candidate = applyArchitectureIntegration(submission, { ...context, ...assembled, blueprint, modules, mergeCapabilityReasons: true });
  return { submission, candidate };
}

/** Presentation only: granting still requires the full frozen-input and native-session checks. */
export function architectureDesignRecovery(record) {
  if (!["failed", "cancelled"].includes(record?.status) || !record.designProgressCheckpoint) return null;
  try {
    const checkpoint = copy(record.designProgressCheckpoint); checkpointState(checkpoint);
    const exhausted = stages(checkpoint).find(({ stage, entry }) => !complete(entry)
      && entry.modelCalls >= stageLimit(checkpoint, stage, entry.key));
    const continuing = checkpoint.repair && stages(checkpoint).find(({ stage, entry }) => !complete(entry)
      && stage === checkpoint.repair.stage && entry.key === checkpoint.repair.key);
    const integrationReady = complete(checkpoint.blueprint) && checkpoint.modules.length > 0
      && checkpoint.modules.every(complete) && !complete(checkpoint.integration);
    const localCompletion = integrationReady && record.draft?.taskSpec && Array.isArray(record.requirements)
      && Boolean(programIntegration(checkpoint, { requirements: record.requirements,
        evidence: record.evidence ?? [], confirmedRequirementContext: record.confirmedRequirementContext, deferredVerifications: record.deferredVerifications,
        candidateSchema: designSubmissionSchema(record.draft, { requirements: record.requirements }) }));
    const target = exhausted ?? continuing ?? (integrationReady ? { stage: "integration", entry: checkpoint.integration } : null);
    if (!target) return null;
    const { stage, entry } = target;
    const reserved = stage === "integration" ? 0 : integrationReserve(checkpoint)
      + checkpoint.modules.filter(item => item.key !== entry.key && !complete(item)).length;
    const available = !checkpoint.repair && checkpoint.modelCalls + reserved + ARCHITECTURE_DESIGN_REPAIR_CALL_LIMIT
      <= architectureDesignCallLimits(checkpoint).pipeline;
    const status = localCompletion ? "continuing" : exhausted ? available ? "available" : "blocked"
      : integrationReady && architectureDesignCallLimits(checkpoint).pipeline - checkpoint.modelCalls < integrationReserve(checkpoint)
        ? "blocked" : "continuing";
    const stageLabel = stage === "module" ? "功能模块" : stage === "blueprint" ? "架构蓝图" : "架构整合";
    return { status, stage, stageKey: entry.key, stageLabel,
      completedModules: checkpoint.modules.filter(complete).length, totalModules: checkpoint.modules.length,
      modelCalls: entry.modelCalls, modelCallLimit: stageLimit(checkpoint, stage, entry.key),
      pipelineModelCalls: checkpoint.modelCalls, pipelineModelCallLimit: architectureDesignCallLimits(checkpoint).pipeline,
      message: localCompletion ? "现有模块可由程序完成一致能力说明的合并，无需新增设计调用；下一步仍须独立评审。"
        : status === "available" ? `${stageLabel}已用完本节点轮次，已完成成果保留；可手动授权最多2轮局部修复。`
        : status === "continuing" ? integrationReady ? "全部功能模块已保存，可继续整合与独立评审；不会重跑已完成模块。"
          : "局部修复尚未完成，可沿原会话继续；已用次数和已完成成果保留。"
          : "本次设计的可用修复额度已耗尽，不能重复生成刷新额度；请保留材料检查阻断原因。",
      ...(localCompletion ? { localCompletion: true, actionLabel: "复核现有方案并继续评审" }
        : integrationReady && status === "continuing" ? { actionLabel: "继续整合与评审" } : {}),
      ...(status === "available" ? { request: { version: record.version, checkpointHash: checkpoint.hash, stageKey: entry.key } } : {}) };
  } catch { return null; }
}

function inputs({ context, binding }) {
  if (!reviewCheckpointObject(context) || !Array.isArray(context.requirements) || !reviewCheckpointObject(context.candidateSchema)
    || !reviewCheckpointObject(binding)) throw invalid();
  const schemas = createArchitectureStageSchemas(context);
  return { schemas, schemaHash: designHash({ candidateSchema: context.candidateSchema, schemas }), bindingHash: designHash(copy(binding)) };
}

/** Existing but invalid progress must fail closed, rather than replenish a node's budget. */
export function readArchitectureDesignProgress(record, { context, binding }) {
  if (!Object.hasOwn(record, "designProgressCheckpoint")) return null;
  try {
    context = { ...context, legacyBlueprint: record.designProgressCheckpoint?.schemaVersion < 3 };
    const { schemas, schemaHash, bindingHash } = inputs({ context, binding });
    const checkpoint = copy(record.designProgressCheckpoint);
    checkpointState(checkpoint);
    if (checkpoint.bindingHash !== bindingHash || checkpoint.schemaHash !== schemaHash) throw invalid();
    if (!complete(checkpoint.blueprint)) {
      if (checkpoint.modules.some(complete) || complete(checkpoint.integration)
        || checkpoint.assignmentHash === null && checkpoint.modules.length) throw invalid();
      return checkpoint;
    }
    const blueprint = validateArchitectureBlueprint(checkpoint.blueprint.result, context);
    if (designHash(blueprint) !== checkpoint.blueprint.resultHash || designHash(blueprint.modules) !== checkpoint.assignmentHash
      || blueprint.modules.length !== checkpoint.modules.length) throw invalid();
    for (const [index, assignment] of blueprint.modules.entries()) {
      const entry = checkpoint.modules[index];
      if (entry.key !== assignment.id) throw invalid();
    }
    const verified = [];
    for (const layer of architectureModuleLayers(blueprint)) for (const assignment of layer) {
      const entry = checkpoint.modules.find(item => item.key === assignment.id);
      if (complete(entry)) {
        const result = validateArchitectureModule(entry.result, { ...context, blueprint, assignment, dependencyModules: verified });
        if (designHash(result) !== entry.resultHash) throw invalid();
        verified.push(result);
      }
    }
    if (complete(checkpoint.integration)) {
      if (!checkpoint.modules.every(complete)) throw invalid();
      const modules = checkpoint.modules.map(entry => entry.result);
      const mergeCapabilityReasons = checkpoint.assemblyVersion === 2;
      const assembled = assembleArchitectureCandidate({ ...context, blueprint, modules, mergeCapabilityReasons });
      if (checkpoint.integration.completedBy === "program" && assembled.conflicts.length) throw invalid();
      applyArchitectureIntegration(checkpoint.integration.result, { ...context, ...assembled, blueprint, modules, mergeCapabilityReasons });
    }
    if (schemas.integration === undefined) throw invalid();
    return checkpoint;
  } catch (error) {
    if (error instanceof InputError && error.diagnostic?.reason === "design_history_unavailable") throw error;
    throw invalid();
  }
}

const instructions = {
  blueprint: "你负责本轮架构蓝图，不承担模块内部的详细设计。只提交全局执行选择与1至3个功能模块的职责、正式需求归属、输入输出和依赖边界。每条正式需求恰有一个主责模块，跨模块依赖明确声明。不要声明或冻结组件、步骤编号；这些由模块设计者按需要补充。不提前展开完整覆盖表和验收表，不编造平台能力，不执行外部动作。蓝图保存只是中间成果，不代表完整候选或通过。",
  module: "你只设计本轮assignment主责的功能模块。遵守蓝图的模块职责、输入输出与依赖，自主设计和补充本模块的组件、步骤、能力、失败处理、决策、需求覆盖和验收义务。每个组件至少由一个步骤使用。组件和步骤编号在本模块内唯一；本地引用用字符串，跨模块步骤依赖及组件覆盖用{moduleId,id}，只能引用dependencyInterfaces提供的直接依赖模块真实编号，不猜测或代写其他模块。不修改其他模块或全局选择，不递归委派、不缩减用户要求。只按当前节点工具提交完整模块产物；保存不代表最终通过。",
  integration: "你是架构整合者。程序已经拼装蓝图与模块产物，只处理给定冲突和整体验收衔接，按baseHash提交必要的局部updates；无须修改时提交空updates。保留蓝图约束、模块职责、稳定ID及有效内容，不重写完整候选，不重新开展全局设计。修改仍受完整原结构与独立评审约束，不能以整合自述宣布通过。",
};
const legacyInstructions = {
  blueprint: "你负责冻结本轮架构蓝图，不承担全部模块的详细设计。只提交全局执行选择与1至3个功能模块的职责、正式需求归属、稳定组件/步骤编号、输入输出和依赖边界。每条正式需求恰有一个主责模块，跨模块依赖明确声明。不提前展开完整覆盖表和验收表，不编造平台能力，不执行外部动作。蓝图保存只是中间成果，不代表完整候选或通过。",
  module: "你只设计本轮assignment主责的功能模块。遵守已冻结蓝图、编号、输入输出与依赖，交付本模块的组件、步骤、能力、失败处理、决策、需求覆盖和验收义务。不得修改其他模块或全局选择，不递归委派、不重新统筹整个架构。不确定事项明确保留，不能缩减用户要求。只按当前节点工具提交完整模块产物；保存不代表最终通过。",
};

function revisionOwners(revision, blueprint, modules, assembledCandidate) {
  const owners = new Set(); let reviseBlueprint = false;
  const candidate = revision.candidate;
  const globalFields = Object.keys(blueprint.global).filter(key => key !== "instructions");
  const arrays = ["components", "steps", "capabilities", "failureHandling", "decisions", "coverage", "acceptance", "unknowns", "platformClaims"];
  const issues = (revision.issues ?? []).filter(issue => issue.blocking !== false);
  const paths = issues.flatMap(issue => issue.candidatePaths?.length ? issue.candidatePaths : issue.candidateFields ?? []);
  for (const raw of paths) {
    if (typeof raw !== "string") continue;
    const [field, index] = raw.replace(/^\//u, "").split("/");
    if (globalFields.includes(field)) { reviseBlueprint = true; continue; }
    if (!arrays.includes(field)) continue;
    const item = /^(0|[1-9][0-9]*)$/u.test(index ?? "") ? candidate[field]?.[Number(index)] : undefined;
    let offset = 0;
    const matches = modules.filter(module => {
      const rows = module[field] ?? [], assembledRows = assembledCandidate[field]?.slice(offset, offset + rows.length) ?? [];
      offset += rows.length;
      if (item === undefined) return true;
      if (["components", "steps", "decisions", "acceptance", "platformClaims"].includes(field)) return assembledRows.some(row => row.id === item.id);
      return rows.some(row => typeof row?.id === "string" && row.id === item?.id
        || field === "coverage" && row.requirementId === item.requirementId
        || designHash(row) === designHash(item));
    });
    for (const module of matches) owners.add(module.moduleId);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const assignment of blueprint.modules) if (!owners.has(assignment.id) && assignment.dependsOn.some(id => owners.has(id))) {
      owners.add(assignment.id); changed = true;
    }
  }
  return { reviseBlueprint, owners, hasBlockingIssues: issues.length > 0 };
}

/** Runs only the new design path. Its caller retains the final full validation and independent review. */
export async function runArchitectureDesignPipeline({ record, context, binding, runRole, onSave, signal, onProgress, sessionDirectory, revision, repair,
  forceIntegration = false, validateProgramCandidate = value => value }) {
  if (typeof runRole !== "function" || typeof onSave !== "function" || typeof sessionDirectory !== "string" || !isAbsolute(sessionDirectory)) throw invalid();
  context = { ...context, legacyBlueprint: record.designProgressCheckpoint?.schemaVersion < 3 };
  const { schemas, schemaHash, bindingHash } = inputs({ context, binding });
  let checkpoint = readArchitectureDesignProgress(record, { context, binding }) ?? sealed({ schemaVersion: 3, pipelineId: randomUUID(),
    bindingHash, schemaHash, modelCalls: 0, revisionHash: null, assignmentHash: null, assemblyVersion: 2,
    blueprint: state("blueprint"), modules: [], integration: state("integration") });
  let writes = Promise.resolve(), persistenceError;
  const active = () => { if (persistenceError) throw persistenceError; signal?.throwIfAborted(); };
  const update = action => {
    const task = writes.then(async () => {
      active();
      const next = copy(checkpoint);
      await action(next);
      active();
      const snapshot = sealed(next);
      try { await onSave(copy(snapshot)); }
      catch (error) { persistenceError ??= error; throw error; }
      checkpoint = snapshot;
      record.designProgressCheckpoint = copy(snapshot);
      return snapshot;
    });
    writes = task.catch(() => {});
    return task;
  };
  const entryAt = (value, stage, key) => stage === "module" ? value.modules.find(entry => entry.key === key) : value[stage];
  if (repair !== undefined) {
    const recovery = architectureDesignRecovery({ ...record, status: "failed", version: record.version - 1 });
    if (!recovery?.request || !exact(repair, ["version", "checkpointHash", "stageKey"])
      || !Number.isSafeInteger(repair.version) || repair.version < 1 || repair.version !== record.version - 1
      || designHash(repair) !== designHash(recovery.request))
      throw new InputError("局部修复授权已过期、已使用或不属于当前失败节点，请刷新已保存进度。");
    await update(next => { next.repair = { stage: recovery.stage, key: repair.stageKey,
      additionalCalls: ARCHITECTURE_DESIGN_REPAIR_CALL_LIMIT, sourceVersion: repair.version, sourceHash: repair.checkpointHash }; });
  }
  if (!Object.hasOwn(checkpoint, "assemblyVersion") && checkpoint.integration.modelCalls === 0 && !complete(checkpoint.integration))
    await update(next => { next.assemblyVersion = 2; });
  await update(() => {});
  if (revision) {
    const revisionHash = designHash(copy(revision));
    if (checkpoint.revisionHash !== revisionHash) {
      if (checkpoint.revisionHash !== null || !complete(checkpoint.blueprint) || !complete(checkpoint.integration)
        || !checkpoint.modules.every(complete) || !revision.candidate || !Array.isArray(revision.issues)) throw invalid();
      const blueprint = checkpoint.blueprint.result, modules = checkpoint.modules.map(entry => entry.result);
      const mergeCapabilityReasons = checkpoint.assemblyVersion === 2;
      const assembled = assembleArchitectureCandidate({ ...context, blueprint, modules, mergeCapabilityReasons });
      const candidate = applyArchitectureIntegration(checkpoint.integration.result, { ...context, ...assembled, blueprint, modules, mergeCapabilityReasons });
      if (designHash(candidate) !== designHash(revision.candidate)
        || revision.candidateHash !== undefined && revision.candidateHash !== designHash(candidate)) throw invalid();
      const { reviseBlueprint, owners, hasBlockingIssues } = revisionOwners(revision, blueprint, modules, assembled.candidate);
      if (!hasBlockingIssues && !forceIntegration) return candidate;
      const targets = stages(checkpoint).filter(({ stage, entry }) => stage === "integration"
        || stage === "blueprint" && reviseBlueprint || stage === "module" && (reviseBlueprint || owners.has(entry.key)));
      if (checkpoint.modelCalls + targets.length > architectureDesignCallLimits(checkpoint).pipeline
        || targets.some(({ stage, entry }) => entry.modelCalls >= stageLimit(checkpoint, stage, entry.key))) {
        const error = new InputError("评审修订所需节点没有足够的剩余调用额度；已评审候选、阶段成果和评审意见均保留，不能启动无法完成的修订。");
        error.diagnostic = { stage: "architecture", reason: "revision_budget_exhausted", role: "designer", phase: "designing",
          modelCalls: checkpoint.modelCalls, modelCallLimit: architectureDesignCallLimits(checkpoint).pipeline };
        throw error;
      }
      await update(next => {
        const invalidate = entry => {
          entry.result = null; entry.resultHash = null; entry.sessionRef = null;
          delete entry.completedBy;
          entry.sessionStartCalls = entry.modelCalls; entry.generation++;
        };
        if (reviseBlueprint) invalidate(next.blueprint);
        for (const entry of next.modules) if (reviseBlueprint || owners.has(entry.key)) invalidate(entry);
        invalidate(next.integration);
        next.revisionHash = revisionHash;
      });
    }
  }
  const sessionStorageFor = (stage, key, entry) => ({ directory: sessionDirectory,
    binding: { version: 1, role: "architecture-design-stage", stage, key, pipelineId: checkpoint.pipelineId,
      parentBindingHash: bindingHash, blueprintHash: stage === "blueprint" ? null : checkpoint.blueprint.resultHash,
      schemaHash, generation: entry.generation }, ...(entry.sessionRef ? { file: entry.sessionRef.file } : {}) });
  const runStage = async (stage, key, payload, parameters, validate, integrationContext) => {
    active();
    const existing = entryAt(checkpoint, stage, key);
    if (complete(existing)) return copy(existing.result);
    const modelCallLimit = stageLimit(checkpoint, stage, key);
    if (existing.modelCalls >= modelCallLimit) throw stopped(checkpoint, stage);
    if (existing.modelCalls > existing.sessionStartCalls && !existing.sessionRef) throw invalid("design_history_unavailable");
    const role = stage === "module" ? "specialist" : "designer";
    const sessionStorage = sessionStorageFor(stage, key, existing);
    const onSessionRef = async ref => {
      if (!exact(ref, ["file"]) || typeof ref.file !== "string" || !/^[A-Za-z0-9_.-]+\.jsonl$/u.test(ref.file)) throw invalid();
      await update(next => {
        const entry = entryAt(next, stage, key);
        if (entry.sessionRef && entry.sessionRef.file !== ref.file) throw invalid("design_history_unavailable");
        entry.sessionRef = copy(ref);
      });
    };
    const onModelCall = async (event = {}) => {
      active();
      if (event.retryAttempt > 0) return;
      await update(next => {
        const entry = entryAt(next, stage, key);
        if (!entry.sessionRef) throw invalid("design_history_unavailable");
        const unusedModules = stage === "module" ? next.modules.filter(item => item.key !== key && !complete(item) && item.modelCalls === 0).length : 0;
        const reserved = stage === "integration" ? 0 : integrationReserve(next) + unusedModules;
        if (complete(entry) || entry.modelCalls >= modelCallLimit
          || next.modelCalls >= architectureDesignCallLimits(next).pipeline - reserved) throw stopped(next, stage);
        entry.modelCalls++; next.modelCalls++;
      });
    };
    const onResult = async value => {
      active(); const result = validate(copy(value)), resultHash = designHash(result);
      await update(next => {
        const entry = entryAt(next, stage, key);
        if (entry.result !== null) { if (entry.resultHash !== resultHash) throw invalid(); return; }
        if (entry.modelCalls <= entry.sessionStartCalls || !entry.sessionRef) throw invalid("design_history_unavailable");
        entry.result = result; entry.resultHash = resultHash;
        if (stage === "blueprint") {
          const assignmentHash = designHash(result.modules);
          if (next.assignmentHash !== null && next.assignmentHash !== assignmentHash) throw invalid();
          next.assignmentHash = assignmentHash;
          if (!next.modules.length) next.modules = result.modules.map(assignment => state(assignment.id));
        }
      });
    };
    onProgress?.({ type: "status", phase: "designing", label: ({ blueprint: "正在确定架构蓝图与模块边界…", module: "正在设计功能模块并核对上游接口…", integration: "正在整合模块并核对交接…" })[stage] });
    const value = await runRole({ stage, key, role, stageInstruction: context.legacyBlueprint && legacyInstructions[stage] || instructions[stage],
      submitName: ({ blueprint: "submit_architecture_blueprint", module: "submit_architecture_module", integration: "submit_architecture_integration" })[stage],
      payload: { ...payload, blueprintProtocol: context.legacyBlueprint ? "frozen-ids-v1" : "module-boundaries-v2", pipelineStage: stage, designModelBudget: { limit: architectureDesignCallLimits(checkpoint).pipeline, used: checkpoint.modelCalls,
        remaining: architectureDesignCallLimits(checkpoint).pipeline - checkpoint.modelCalls, stageLimit: modelCallLimit },
      ...(checkpoint.repair?.stage === stage && checkpoint.repair.key === key ? { stageRepair: {
        additionalCalls: ARCHITECTURE_DESIGN_REPAIR_CALL_LIMIT,
        instruction: "用户已显式授权一次局部修复。继续原会话，先修正上次提交被拒的结构与引用；不要重写已完成模块。每个声明组件都必须有实际执行步骤，保持模块职责、接口及业务范围，按当前蓝图协议处理内部编号。" } } : {}),
      ...(revision ? { revisionFeedback: copy(revision.issues ?? []) } : {}) }, parameters,
      validate: value => {
        const result = validate(value);
        if (stage === "blueprint" && checkpoint.assignmentHash !== null && designHash(result.modules) !== checkpoint.assignmentHash)
          throw new InputError("蓝图修订必须保留本轮模块分工及接口约定；不能借修订重开模块预算。");
        return result;
      },
      modelCalls: existing.modelCalls, modelCallLimit, sessionStorage, onSessionRef, onModelCall, onResult,
      ...(integrationContext ? { integrationContext } : {}) });
    if (stage === "blueprint" && value?.needsInput) return value;
    await onResult(value);
    return copy(entryAt(checkpoint, stage, key).result);
  };
  const blueprint = await runStage("blueprint", "blueprint", context, schemas.blueprint, value => validateArchitectureBlueprint(value, context));
  if (blueprint.needsInput) return blueprint;
  const local = programIntegration(checkpoint, context);
  if (local) {
    await validateProgramCandidate(local.candidate, { sessionStorage: sessionStorageFor("integration", "integration", checkpoint.integration) }); active();
    await update(next => {
      next.assemblyVersion = 2;
      next.integration.result = copy(local.submission); next.integration.resultHash = designHash(local.submission);
      next.integration.completedBy = "program";
    });
    onProgress?.({ type: "status", phase: "designing", label: "程序已完成一致能力说明的合并，准备独立评审…" });
    return local.candidate;
  }
  const missing = checkpoint.modules.filter(entry => !complete(entry));
  if (architectureDesignCallLimits(checkpoint).pipeline - checkpoint.modelCalls < integrationReserve(checkpoint) + missing.length) throw stopped(checkpoint, "module");
  const { draft: _draft, requirement: _requirement, requirements: _requirements, candidateSchema: _candidateSchema,
    previousDesign: _previousDesign, ...facts } = context;
  const layers = context.legacyBlueprint ? [blueprint.modules] : architectureModuleLayers(blueprint);
  for (const layer of layers) {
    const settled = await Promise.allSettled(layer.map(assignment => {
      const dependencyModules = checkpoint.modules.filter(entry => assignment.dependsOn.includes(entry.key) && complete(entry)).map(entry => copy(entry.result));
      const dependencyInterfaces = dependencyModules.map(module => ({ moduleId: module.moduleId,
        components: module.components, steps: module.steps.map(({ id, componentId, input, output, completion }) => ({ id, componentId, input, output, completion })) }));
      return runStage("module", assignment.id,
        { ...facts, assignment, blueprint, blueprintHash: designHash(blueprint),
          ...(!context.legacyBlueprint ? { dependencyInterfaces } : {}),
          requirements: context.requirements.filter(item => assignment.requirementIds.includes(item.id)) },
        schemas.module, value => validateArchitectureModule(value, { ...context, blueprint, assignment, dependencyModules }));
    }));
    active();
    const failed = settled.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
  }
  const modules = checkpoint.modules.map(entry => copy(entry.result));
  const mergeCapabilityReasons = checkpoint.assemblyVersion === 2;
  const assembled = assembleArchitectureCandidate({ ...context, blueprint, modules, mergeCapabilityReasons });
  const integrationContext = { ...context, ...assembled, blueprint, modules, mergeCapabilityReasons };
  const integration = await runStage("integration", "integration", { ...facts, requirements: context.requirements,
    blueprintBoundary: { globalFields: Object.keys(blueprint.global).filter(key => key !== "instructions"), modules: blueprint.modules },
    baseCandidate: assembled.candidate, baseHash: designHash(assembled.candidate), conflicts: assembled.conflicts,
    integrationPolicy: { allowedRoots: [...new Set(["instructions", "failureHandling", "coverage", "acceptance", "unknowns",
      ...assembled.conflicts.map(entry => entry.path.split("/")[1])])], frozenRoots: ["components", "steps"],
      instruction: "updates的path只指向baseCandidate。不得修改冻结的组件、步骤或编号。修正整合提交时重新调用submit_architecture_integration并提交完整baseHash、updates；没有修改则updates为空数组。" } }, schemas.integration, value => {
    applyArchitectureIntegration(value, integrationContext);
    return copy(value);
  }, integrationContext);
  active();
  return applyArchitectureIntegration(integration, integrationContext);
}
