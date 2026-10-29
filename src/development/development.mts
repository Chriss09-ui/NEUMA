import { ExecutionLifecycle } from "../runtime/execution-lifecycle.mjs";
import { needsDevelopmentRepairDispatch, repairDevelopmentPlan, repairDevelopmentCode } from "./development-repair.mjs";
import type { WebCapabilityPort } from "../runtime/web-capabilities.mjs";
import type { RegisteredTool as ToolDefinition } from "../runtime/execution-port.mjs";
import type { ModelConfig } from "../contracts/model.mjs";
import type { UnknownRecord } from "../contracts/json.mjs";
import type { ToolResult, ToolSchema } from "../contracts/tools.mjs";
import type { DevelopmentPlan, DevelopmentWork, DevelopmentReview } from "../contracts/development.mjs";
import type { AcceptanceLedger } from "../contracts/verification.mjs";
import type { AgentStoragePort } from "../runtime/storage-port.mjs";
import type { SessionFactory, NeumaTool, RegisteredTool, RawToolInput } from "../runtime/execution-port.mjs";
import type { DevelopmentSnapshot } from "./development-workspace.mjs";
import type { PlanningDraftSnapshot } from "./development-artifacts.mjs";
import type { SubmissionIssue } from "./development-diagnostics.mjs";
import type { PlanningBlockerReport } from "./development-planning-blocker.mjs";
import type { DevelopmentContextPayload } from "./development-context.mjs";
import type { DevelopmentRunRecord, DevelopmentContext, DevelopmentHandle, DevelopmentRole, TaskProgress, DevelopmentEvidence, DevelopmentDiagnostic,
  PassedDevelopmentArchitecture, VerificationFeedback, DevelopmentSummaryRecord } from "./development-controller-types.mjs";
import type { ManagedServiceManager } from "../services/managed-service-manager.mjs";
import { readDevelopmentRunRecord } from "./development-record.mjs";
import { objectFields, errorField, isInteger } from "../runtime/type-boundary.mjs";
export interface DevelopmentExecutorPort extends Partial<Pick<DevelopmentExecutor, "runAction" | "run">> {
  probe(options?: Parameters<DevelopmentExecutor["probe"]>[0]): Promise<{ available: boolean; reason?: string }>;
  verify?(options: Parameters<DevelopmentExecutor["verify"]>[0]): Promise<Omit<DevelopmentEvidence, "id"> & { summary: string }>;
}
interface ControllerOptions { config: ModelConfig; cwd: string; dataDir: string; storage?: AgentStoragePort; sessionFactory?: SessionFactory;
  store?: DevelopmentStore; workspace?: DevelopmentWorkspace; executor?: DevelopmentExecutorPort;
  services?: ManagedServiceManager | undefined; getArchitecture?: ((id: string) => Promise<unknown>) | undefined; web?: WebCapabilityPort;
  limits?: Partial<DevelopmentLimits> }
interface ActivationResult { delivery: string; summary?: string; repair?: Omit<DevelopmentEvidence, "id" | "codeHash"> & { codeHash?: string | null }; acceptanceLedger?: AcceptanceLedger; runtimeCheck?: unknown }
interface RunOptions { signal?: AbortSignal | undefined; onProgress?: (value: UnknownRecord) => void; resume?: boolean;
  activate?: (record: DevelopmentRunRecord, signal: AbortSignal) => Promise<ActivationResult> }
type RoleOptions<T> = { kind: DevelopmentRole; tools?: RegisteredTool[]; validate: (value: unknown) => T | Promise<T>; counter: { turns: number }; limit: number; scope: unknown };
import { randomUUID } from "node:crypto";
import { InputError } from "../requirements/core.mjs";
import { createExecutionSession as createPiSession, classifyModelFailure } from "../runtime/execution-runtime.mjs";
import { developmentModelOutputBudget } from "../runtime/model-limits.mjs";
import { toolInputValidation } from "../runtime/tool-input-diagnostics.mjs";
import { renderPiSubmissionContract, readPiStructuredSubmission } from "../runtime/pi-submission-contract.mjs";
import { designHash, supportedArchitectureVersion, requiresDevelopment } from "../architecture/architecture-contract.mjs";
import { renderPlatformRules, platformCapabilityCatalog, validatePlatformMetadata } from "../architecture/platform-contract.mjs";
import { PLAN_SCHEMA, PLAN_V2_SCHEMA, PLAN_V3_SCHEMA, REVIEW_SCHEMA, WORK_SCHEMA, validatePlan, validateReview, validateWork, hashValue, nextReadyDevelopmentTask } from "./development-contract.mjs";
import { verifyManagedApplication } from "./managed-verification.mjs";
import { SERVICE_MANIFEST_SCHEMA } from "../services/service-contract.mjs";
import { TEST_FIXTURE_SCHEMA, FIXTURE_LIMITS } from "./development-fixtures.mjs";
import { serviceErrorMessage } from "../services/service-errors.mjs";
import { DevelopmentStore } from "./development-store.mjs";
import { DevelopmentWorkspace } from "./development-workspace.mjs";
import { DevelopmentExecutor } from "./development-executor.mjs";
import { PLAN_PROMPT, CODE_PROMPT, REVIEW_PROMPT, developmentNodePrompt } from "./development-prompts.mjs";
import { compactDevelopmentContext, developmentContextMessage, restoreDevelopmentContext, createContextReadTool } from "./development-context.mjs";
import { developmentCaseFacts } from "./development-case-facts.mjs";
import { bindApplicationManifest, VALUE_SCHEMA_DESCRIPTION } from "../applications/application-contract.mjs";
import { WebCapabilities, createWebTools, WEB_RUNTIME_PROMPT, networkAllowed } from "../runtime/web-capabilities.mjs";
import { AgentStorage } from "../agents/agent-storage.mjs";
import { recordSubmission, submissionIssues, lastSubmissionDiagnostic, planningToolIssues } from "./development-diagnostics.mjs";
import { developmentSessionBinding, developmentSessionStorage, bindDevelopmentSessionFile } from "./development-sessions.mjs";
import { DevelopmentArtifacts, PLAN_ARTIFACT_GUIDE } from "./development-artifacts.mjs";
import { planReviewSubject } from "../verification/plan-review-subject.mjs";
import { JSON_VALUE_SCHEMA_DESCRIPTION } from "../applications/value-schema-rules.mjs";
import { createDevelopmentFileTools } from "./development-file-tools.mjs";
import { createDevelopmentPlanningBlocker, planningBlockerOutcome, isPlanningBlockerOutcome, samePlanningBlocker } from "./development-planning-blocker.mjs";
import { createAcceptanceLedger, recordDevelopmentAcceptance, recordIndependentAcceptance, assertAcceptanceComplete, summarizeAcceptanceLedger, ACCEPTANCE_ADAPTER_GUIDE } from "../verification/acceptance-contract.mjs";

const LABELS: Record<string, string> = { intake: "正在接收设计与准备工作区…", planning: "正在拆分并检查研发任务…",
  implementing: "正在开发当前任务…", verifying: "正在运行测试与独立验收…", packaging: "正在整理经过验证的交付物…" };
const DEFAULT_LIMITS = Object.freeze({ corrections: 6, planRevisions: 1, taskRepairs: 2, integrationRepairs: 2, developerTurns: 40, reviewerTurns: 12 });
type DevelopmentLimits = { [K in keyof typeof DEFAULT_LIMITS]: number };
const toolResult = (value: unknown): ToolResult & { details: {} } => ({ content: [{ type: "text", text: JSON.stringify(value) }], details: {} });
const clone = <T,>(value: T): T => structuredClone(value);

function planningDraftBinding(record: DevelopmentRunRecord) {
  return hashValue({ agentId: record.agentId, architecture: record.architecture });
}

function unacceptedPlanning(record: Pick<DevelopmentSummaryRecord, "phase" | "plan" | "planHash" | "tasks" | "package">) {
  return record?.phase === "planning" && !record.plan && !record.planHash
    && !(record.tasks?.length) && !record.package;
}

function planningCaseFacts(record: DevelopmentRunRecord, signal?: AbortSignal) {
  const current = record.pendingPlan?.plan ?? record.feedback?.rejectedPlan ?? record.plan;
  if (current) return { ...developmentCaseFacts(current, { signal }), planSource: record.pendingPlan?.plan ? "pendingPlan.plan"
    : record.feedback?.rejectedPlan ? "feedback.rejectedPlan" : "record.plan", trust: "measurement-only" };
  const revision = objectFields(record.architecture.developmentRevision);
  if (revision?.schemaVersion === 1 && revision.trust === "untrusted-reference" && revision.status === "available"
    && objectFields(revision.source).agentId === record.agentId && revision.plan)
    return { ...developmentCaseFacts(revision.plan, { planHash: typeof revision.planHash === "string" ? revision.planHash : undefined, signal }),
      planSource: "developmentRevision.plan", trust: "untrusted-reference" };
}

function historicalPlanReview(record: DevelopmentRunRecord) {
  const attempt = record.planAttempts?.at(-1);
  if (!attempt || attempt.review?.verdict !== "revise" || attempt.planHash !== hashValue(attempt.plan)) return;
  try {
    const versions = attempt.review.subjectVersion === undefined ? [1, 2] : [attempt.review.subjectVersion];
    if (!versions.some((version) => attempt.review.subjectHash === hashValue(planReviewSubject(record.architectureRef, attempt.plan, attempt.planHash, version)))) return;
  } catch { return; }
  return { sourceRunId: record.id, reviewedPlanHash: attempt.planHash, review: clone(attempt.review),
    instruction: "这是旧计划版本的独立评语，不能当作当前材料已验证或所有结论仍成立；依据当前材料及程序实测逐项核对，保留真实业务问题，明确已修复或不成立的依据。不能改动架构或验收承诺以通过。" };
}

class Stop extends Error {
  status: string; diagnostic: DevelopmentDiagnostic | undefined;
  constructor(message: string, status = "blocked", diagnostic?: DevelopmentDiagnostic) { super(message); this.status = status; this.diagnostic = diagnostic; }
}

function modelStop(ctx: DevelopmentContext, handle: DevelopmentHandle, value: unknown) {
  const failure = handle.failure ?? classifyModelFailure(value);
  return new Stop(`${failure.message}。研发进度已保存，可继续。`, "failed", {
    stage: "model", phase: ctx.record.phase, role: handle.kind, reason: failure.reason, retries: handle.retries ?? 0,
  });
}

function validateTaskWork(value: unknown, task: TaskProgress) {
  const work = validateWork(value);
  if (work.changedFiles.some((file) => !task.files.includes(file))) throw Object.assign(
    new InputError("开发结果声明了任务授权范围之外的改动，需要修订任务"), { reason: "work_file_unauthorized" });
  return work;
}

export function developmentSummary(record: DevelopmentRunRecord | DevelopmentSummaryRecord | null) {
  if (!record) return null;
  const freshPlanningRound = record.status === "failed" && unacceptedPlanning(record)
    && (["turn_limit", "correction_limit"].includes(typeof record.diagnostic?.reason === "string" ? record.diagnostic.reason : "")
      || record.budgets?.planRevisions === 0 && record.reviews?.findLast((entry) => entry.mode === "plan")?.verdict === "revise"
      || Object.values(record.sessions ?? {}).some((entry) => entry.role === "planner" && isInteger(entry.limit)
        && entry.limit > 0 && entry.turns >= entry.limit));
  return clone({ id: record.id, agentId: record.agentId, name: record.name, version: record.version,
    architectureRef: record.architectureRef, status: record.status, phase: record.phase, summary: record.summary,
    diagnostic: record.diagnostic ?? null,
    ...(freshPlanningRound ? { continuation: { mode: "fresh", sourceRunId: record.id, reason: "planning_budget_exhausted", historyPreserved: true } } : {}),
    acceptance: record.acceptanceLedger ? summarizeAcceptanceLedger(record.acceptanceLedger, { allowPendingActivationAdapters: ["host-gateway"] }) : null,
    submissionCounts: record.submissionCounts ?? {},
    delivery: record.delivery, currentTaskId: record.currentTaskId, budgets: record.budgets,
    tasks: (record.tasks ?? []).map(({ id, title, status, attempts, repairs, summary }) => ({ id, title, status, attempts, repairs, summary })),
    package: record.package ? { codeHash: record.package.codeHash, planHash: record.package.planHash, entrypoint: record.package.entrypoint } : null,
    verification: record.reports?.at(-1) ? { status: record.reports.at(-1)!.status, summary: record.reports.at(-1)!.summary } : null,
    createdAt: record.createdAt, updatedAt: record.updatedAt });
}

function workspaceStoragePort(value: unknown): AgentStoragePort | undefined {
  if (value === undefined) return undefined;
  const fields = objectFields(value);
  if (!["readJson", "writeJson", "agentIds", "directory", "jsonFiles", "removeFile", "removeDirectory"].every(name => typeof fields[name] === "function")
    || fields.dataDir !== undefined && typeof fields.dataDir !== "string"
    || fields.ready !== undefined && !(fields.ready instanceof Promise)) throw new InputError("研发工作区存储接口不完整");
  return value as AgentStoragePort;
}

export class DevelopmentController {
  config!: ModelConfig; cwd!: string; dataDir!: string; sessionFactory!: SessionFactory; getArchitecture?: ((id: string) => Promise<unknown>) | undefined;
  storage: AgentStoragePort; store: DevelopmentStore; workspace: DevelopmentWorkspace; artifacts: DevelopmentArtifacts;
  executor: DevelopmentExecutorPort; services: ManagedServiceManager | undefined; web: WebCapabilityPort;
  limits: DevelopmentLimits; active = new Map<string, DevelopmentContext>();
  constructor({ config, cwd, dataDir, storage, sessionFactory = createPiSession, store, workspace, executor, services, getArchitecture, web, limits = {} }: ControllerOptions) {
    Object.assign(this, { config, cwd, dataDir, sessionFactory, getArchitecture });
    this.storage = storage ?? store?.storage ?? workspaceStoragePort(workspace?.storage) ?? new AgentStorage({ dataDir });
    this.store = store ?? new DevelopmentStore({ dataDir, storage: this.storage });
    this.workspace = workspace ?? new DevelopmentWorkspace({ dataDir, storage: this.storage });
    this.artifacts = new DevelopmentArtifacts({ storage: this.storage });
    this.executor = executor ?? new DevelopmentExecutor();
    this.services = services;
    this.web = web ?? new WebCapabilities();
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.active = new Map();
  }

  async get(id: string) { const value = await this.store.get(id); return developmentSummary(value ? readDevelopmentRunRecord(value) : null); }
  has(id: string) { return this.active.has(id); }
  async remove(id: string) { await this.cancel(id); await this.store.remove(id); }

  guard(ctx: DevelopmentContext) {
    ctx.signal.throwIfAborted();
    if (this.active.get(ctx.record.agentId) !== ctx) throw new Stop("这轮研发已经失效");
  }

  async save(ctx: DevelopmentContext) {
    const snapshot = clone(ctx.record);
    const save = ctx.writes.then(async () => {
      snapshot.revision = ctx.record.revision;
      const saved = await this.store.save(snapshot);
      ctx.record.revision = saved.revision;
      ctx.record.updatedAt = saved.updatedAt;
    });
    ctx.writes = save;
    await save;
  }

  async current(ctx: DevelopmentContext) {
    this.guard(ctx);
    if (!this.getArchitecture) return;
    const current = objectFields(await this.getArchitecture(ctx.record.agentId));
    this.guard(ctx);
    if (current?.status !== "passed" || current.version !== ctx.record.architectureRef.version
      || current.candidateHash !== ctx.record.architectureRef.candidateHash)
      throw new Stop("架构版本已经变化，当前研发结果不能交付；请基于新的已评估方案开始研发");
  }

  async phase(ctx: DevelopmentContext, phase: string, summary = LABELS[phase]!) {
    await this.current(ctx);
    Object.assign(ctx.record, { phase, summary });
    await this.save(ctx);
    ctx.onProgress({ type: "status", phase, label: summary, development: developmentSummary(ctx.record) });
  }

  async correction(ctx: DevelopmentContext, kind: string, task?: TaskProgress | null, transition = () => {}) {
    const budgets = ctx.record.budgets;
    if (budgets.corrections <= 0 || (kind === "plan" && budgets.planRevisions <= 0)
      || (kind === "integration" && budgets.integrationRepairs <= 0)
      || (kind === "task" && task!.repairs >= this.limits.taskRepairs))
      throw new Stop("自动修订预算已用完，代码和失败证据已保存", "failed", {
        stage: "development", phase: ctx.record.phase, reason: "correction_limit", kind,
      });
    budgets.corrections--;
    if (kind === "plan") budgets.planRevisions--;
    if (kind === "integration") budgets.integrationRepairs--;
    if (kind === "task") task!.repairs++;
    transition();
    await this.save(ctx);
  }

  async integrationRepair(ctx: DevelopmentContext, feedback: VerificationFeedback, title = "修复整体验收问题") {
    await this.correction(ctx, "integration", null, () => {
      const delivered = ctx.record.deliveries?.find((item) => item.package.id === ctx.record.package?.id);
      if (delivered) { delivered.status = "defective"; delivered.failureReportId = feedback.report.id; }
      ctx.record.package = null;
      ctx.record.feedback = feedback;
      ctx.record.tasks.push({ id: `integration_${randomUUID().slice(0, 8)}`, title, description: feedback.review.summary,
        requirementIds: ctx.record.architecture.requirements.map((item) => item.id), acceptanceIds: ctx.record.architecture.design.acceptance.map((item) => item.id),
        dependsOn: [], files: [...new Set(ctx.record.plan!.tasks.flatMap((item) => item.files))], integration: true,
        status: "pending", attempts: 0, repairs: 0, turns: 0, feedback, nextAction: "implement" });
    });
  }

  async role(ctx: DevelopmentContext, options: RoleOptions<DevelopmentPlan> & { kind: "planner" }): Promise<DevelopmentHandle<DevelopmentPlan | { report: PlanningBlockerReport }>>;
  async role(ctx: DevelopmentContext, options: RoleOptions<DevelopmentWork> & { kind: "developer" }): Promise<DevelopmentHandle<DevelopmentWork>>;
  async role(ctx: DevelopmentContext, options: RoleOptions<DevelopmentReview> & { kind: "reviewer" }): Promise<DevelopmentHandle<DevelopmentReview>>;
  async role(ctx: DevelopmentContext, { kind, tools = [], validate, counter, limit, scope }: RoleOptions<DevelopmentPlan | DevelopmentWork | DevelopmentReview>): Promise<DevelopmentHandle<DevelopmentPlan | DevelopmentWork | DevelopmentReview | { report: PlanningBlockerReport }>> {
    validatePlatformMetadata(ctx.record.architecture);
    const platform = ctx.record.architecture.platformSnapshot;
    const name = kind === "planner" ? "submit_development_plan" : kind === "developer" ? "submit_development_work" : "submit_development_review";
    const schemas = { planner: ctx.record.architecture.design.schemaVersion === 3 ? PLAN_V3_SCHEMA : ctx.record.architecture.design.schemaVersion === 2 ? PLAN_V2_SCHEMA : PLAN_SCHEMA, developer: WORK_SCHEMA, reviewer: REVIEW_SCHEMA };
    const filePlan = kind === "planner" && Number(ctx.record.architecture.design.schemaVersion) >= 2;
    const freshWorkspace = filePlan && ctx.planningWorkspace?.empty === true;
    const submitSchema = filePlan ? { type: "object", properties: { indexPath: { type: "string", minLength: 1, maxLength: 500,
      description: "独立规划目录内的 JSON 索引相对路径；计划和用例已用 write/edit 保存" } }, required: ["indexPath"], additionalProperties: false } : schemas[kind];
    const handle = { kind, submitName: name, accepting: false, submitted: false, result: undefined, counter, limit, failed: false, turnsInPrompt: 0, disposed: false, submissionCalls: new Map<string, { value: unknown; recorded: boolean }>() } as DevelopmentHandle<DevelopmentPlan | DevelopmentWork | DevelopmentReview | { report: PlanningBlockerReport }>;
    const planningBlocker = kind === "planner" ? createDevelopmentPlanningBlocker(ctx.record, {
      acceptanceAdapterGuide: ctx.record.architecture.runtimeCapabilities ? ACCEPTANCE_ADAPTER_GUIDE : null }) : null;
    if (planningBlocker) handle.planningBlocker = planningBlocker.context;
    let rejectedPlanningMaterial: { hash: string | null; indexPath: unknown } | null = null;
    const persistent = await developmentSessionStorage(this.storage, ctx.record, developmentSessionBinding(ctx.record, kind, scope));
    persistent.reference.limit ??= limit;
    if (!Number.isSafeInteger(persistent.reference.limit) || persistent.reference.limit < 1) throw new InputError("研发会话预算记录无效");
    limit = Math.min(limit, persistent.reference.limit);
    handle.limit = limit;
    counter.turns = Math.max(counter.turns, persistent.reference.turns);
    const rejectedInputCalls = new Set();
    const checkToolInputs = () => {
      if (persistent.reference.toolInputFailure?.count === 3) throw new Stop("相同工具参数已连续三次未通过结构检查，已停止继续请求并保留诊断；请先核对字段与公开工具契约。", "failed", {
        stage: "development", phase: ctx.record.phase, role: kind, reason: "repeated_tool_error", attempts: 3,
      });
    };
    const clearToolInputFailure = async (toolName: string) => {
      const failure = persistent.reference.toolInputFailure;
      if (failure?.toolName !== toolName || failure.count === 3) return;
      delete persistent.reference.toolInputFailure;
      await this.save(ctx);
    };
    handle.checkToolInputs = checkToolInputs;
    const charge = async ({ purpose = "agent", retryAttempt = 0 } = {}) => {
      this.guard(ctx);
      checkToolInputs();
      if (handle.submitted && isPlanningBlockerOutcome(handle.result)) throw new Stop("规划技术阻断已保存");
      if (retryAttempt > 0) {
        persistent.reference.retryAttempts = (persistent.reference.retryAttempts ?? 0) + 1;
      } else {
        if (counter.turns >= limit) throw new Stop("本任务模型回合预算已用完，已保留进度", "failed", {
          stage: "development", phase: ctx.record.phase, role: kind, reason: "turn_limit",
        });
        counter.turns++;
        persistent.reference.turns = counter.turns;
        if (purpose === "compaction") persistent.reference.compactions = (persistent.reference.compactions ?? 0) + 1;
      }
      await this.save(ctx);
    };
    handle.charge = charge;
    handle.reference = persistent.reference;
    handle.validate = validate;
    const budget = () => ({ limit, used: counter.turns, remaining: Math.max(0, limit - counter.turns),
      ...(kind === "planner" ? { guidance: "读写、格式修复和提交共用此上限。已有完整字段无需重读；可同轮调用多个写入工具，合并小批用例。预留至少两轮处理程序拒绝；已有完整候选请尽早提交。" } : {}) });
    const root = kind === "planner" ? "plan" : kind === "developer" ? "work" : "review";
    const noteSubmission = async (id: string, value: unknown, { status, stage = "contract", error, diagnosticIssues }: { status: "accepted" | "rejected"; stage?: string; error?: unknown; diagnosticIssues?: SubmissionIssue[] }) => {
      const call = handle.submissionCalls.get(id);
      if (call?.recorded) return;
      if (call) call.recorded = true;
      const issues = status === "rejected" ? diagnosticIssues ?? submissionIssues(value, stage === "sdk" ? submitSchema : schemas[kind], {
        root, error, sdk: stage === "sdk", architecture: ctx.record.architecture }) : [];
      recordSubmission(ctx.record, { role: kind, phase: ctx.record.phase, taskId: ctx.record.currentTaskId,
        turn: counter.turns, stage, status, issues });
      await this.save(ctx);
      return issues;
    };
    const submit: NeumaTool = { name, label: "提交阶段结果", description: "提交经过结构校验的阶段结果；提交不表示整体通过。",
      parameters: submitSchema, executionMode: "sequential" as const, execute: async (_id: string, value: unknown) => {
        this.guard(ctx);
        checkToolInputs();
        if (!handle.accepting || handle.submitted) throw new InputError("本阶段已提交，请结束本轮");
        let result, artifact;
        try {
          if (filePlan) {
            if (!value || typeof objectFields(value).indexPath !== "string" || Object.keys(value).some((key) => key !== "indexPath"))
              throw new InputError("请只提交规划文件的 indexPath");
            artifact = await this.artifacts.submit(ctx.record.agentId, ctx.record.id, String(objectFields(value).indexPath), { signal: ctx.signal });
          }
          result = await validate(artifact?.plan ?? value);
        }
        catch (error) {
          let complete;
          if (filePlan && typeof objectFields(value).indexPath === "string") {
            try {
              complete = await this.artifacts.diagnose(ctx.record.agentId, ctx.record.id, String(objectFields(value).indexPath),
                { schema: schemas.planner, architecture: ctx.record.architecture, previousPlan: ctx.record.plan ?? undefined, freshWorkspace,
                  limit: 40, signal: ctx.signal });
            } catch (diagnosticError) {
              this.guard(ctx);
              if (!(diagnosticError instanceof InputError)) throw diagnosticError;
            }
          }
          const issues = await noteSubmission(_id, artifact?.plan ?? value, { status: "rejected", error,
            ...(complete?.diagnostics.total ? { diagnosticIssues: complete.diagnostics.issues } : {}) });
          if (complete?.diagnostics.total) {
            const unchanged = rejectedPlanningMaterial?.hash === complete.hash && rejectedPlanningMaterial.indexPath === objectFields(value).indexPath;
            rejectedPlanningMaterial = { hash: complete.hash, indexPath: objectFields(value).indexPath };
            const feedback = unchanged ? { unchanged: true, total: complete.diagnostics.total, retained: complete.diagnostics.retained,
              truncated: complete.diagnostics.truncated, offset: complete.diagnostics.offset, nextOffset: complete.diagnostics.nextOffset,
              diagnosticsTool: { name: "read_plan_diagnostics", arguments: { indexPath: objectFields(value).indexPath, expectedHash: complete.hash, offset: 0, limit: 40 } },
              nextAction: "材料整组hash与上次被拒时相同，没有修改。本次仍未提交通过；原完整问题页继续有效。先按原source修改，或用read_plan_diagnostics按该hash分页核对尚未处理的问题，再正式重交；重复提交仍占原预算。" }
              : { ...complete.diagnostics, nextAction: "按source中的文件、稳定caseId和局部索引修正全部独立问题；有nextOffset时用read_plan_diagnostics按本hash继续分页。编辑失败时原文件不变，应先读取或按ID与当前hash局部修订，不能重复提交未变材料。" };
            throw new InputError("提交未通过：" + JSON.stringify({ submitted: false, indexPath: objectFields(value).indexPath, hash: complete.hash, bundleHash: complete.hash, hashScope: "bundle",
              ...feedback, hostModelBudget: budget() }));
          }
          throw new InputError(`提交未通过：${(issues ?? []).map((item) => `${item.path} [${item.reason}]：${item.remedy}`).join("；") || "请按当前提交契约修正后重交。"}`);
        }
        rejectedPlanningMaterial = null;
        await clearToolInputFailure(name);
        await noteSubmission(_id, value, { status: "accepted" });
        this.guard(ctx);
        if (artifact) ctx.record.planningArtifact = artifact.snapshot;
        const acceptedSnapshot = kind === "developer" ? await this.workspace.snapshot(ctx.record.agentId, ctx.record.id) : null;
        persistent.reference.pendingResult = { result: clone(result), subjectHash: handle.payload?.subjectHash ?? null,
          planHash: ctx.record.planHash ?? null, codeHash: acceptedSnapshot?.hash ?? null };
        await this.save(ctx);
        this.guard(ctx);
        handle.result = result; handle.submitted = true;
        handle.session?.setAutoCompactionEnabled?.(false);
        return { ...toolResult({ submitted: true }), terminate: true };
      } };
    const webTools = kind === "reviewer" ? [] : createWebTools({ web: this.web, agentId: ctx.record.agentId,
      scope: `development:${ctx.record.id}`, signal: ctx.signal,
      allowNetwork: objectFields(objectFields(platform).network).allowNetwork !== false && networkAllowed(ctx.record.architecture.requirements) });
    const blockerTool: NeumaTool | null = planningBlocker ? { name: "submit_development_blocker", label: "提交规划技术阻断",
      description: "无需合法计划即可正式报告阻止规划的架构或环境问题；逐字引用当前design、runtimeCapabilities或acceptanceAdapterGuide原文。仅保存规划者的不可信技术意见，不修改需求或代表独立评审通过。",
      parameters: planningBlocker.parameters, executionMode: "sequential" as const, execute: async (_id: string, value: unknown) => {
        this.guard(ctx);
        checkToolInputs();
        if (!handle.accepting || handle.submitted) throw new InputError("本阶段已提交或失效，不能提交规划阻断");
        await this.current(ctx);
        const report = planningBlocker.submit(value, ctx.record);
        await clearToolInputFailure("submit_development_blocker");
        Object.assign(ctx.record, { status: "blocked", delivery: "blocked", summary: report.summary,
          feedback: { report }, diagnostic: { stage: "development", phase: "planning", role: "planner", reason: "planning_blocked",
            trust: "untrusted-reference", issueKinds: [...new Set(report.issues.map((issue) => issue.kind))] } });
        await this.save(ctx);
        await this.current(ctx);
        delete persistent.reference.pendingResult;
        handle.result = planningBlockerOutcome(report); handle.submitted = true;
        handle.session?.setAutoCompactionEnabled?.(false);
        return { ...toolResult({ submitted: true, blocked: true, role: "planner", trust: "untrusted-reference", reportHash: report.reportHash,
          hostModelBudget: budget() }), terminate: true };
      } } : null;
    const guardedTools = [...tools, ...webTools, createContextReadTool(() => handle.payload)].map((tool) => Object.assign({ ...tool }, { execute: async (...args: Parameters<ToolDefinition["execute"]>) => {
      this.guard(ctx);
      checkToolInputs();
      if (!handle.accepting || handle.submitted) throw new InputError("当前阶段不能继续修改或读取工具，请等待下一项工作");
      const result = await tool.execute(args[0], args[1], args[2], args[3], args[4]);
      this.guard(ctx);
      await clearToolInputFailure(tool.name);
      let draftCheck, fileState;
      if (filePlan && ["write", "edit", "save_plan_cases", "edit_plan_cases", "save_plan_json", "update_plan_json", "restore_plan_file"].includes(tool.name)) {
        const parameters = objectFields(args[1]);
        if (["write", "save_plan_json", "restore_plan_file"].includes(tool.name)) {
          try {
            if (tool.name === "save_plan_json") {
              const saved = JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "");
              if (saved.planningIndex === true) ctx.record.planningIndexPath = saved.path;
            } else if (tool.name === "restore_plan_file") {
              if (parameters.path === ctx.record.planningDraftSource?.snapshot.indexPath) ctx.record.planningIndexPath = String(parameters.path);
            } else {
              const value = JSON.parse(String(parameters.content));
              if (value && Array.isArray(value.caseFiles)) ctx.record.planningIndexPath = String(parameters.path);
            }
          } catch { /* Incomplete JSON can be corrected with the native editor. */ }
        }
        const candidate = await this.artifacts.diagnose(ctx.record.agentId, ctx.record.id,
          ctx.record.planningIndexPath ?? "index.json", { schema: schemas.planner, architecture: ctx.record.architecture, freshWorkspace,
            previousPlan: ctx.record.plan ?? undefined, signal: ctx.signal });
        const written = candidate.files?.find((entry) => entry.path === parameters.path);
        if (written) fileState = { path: written.path, fileHash: written.hash, hashScope: "file", bytes: written.size };
        draftCheck = { status: candidate.status, hash: candidate.hash, bundleHash: candidate.hash, hashScope: "bundle", ...candidate.diagnostics,
          message: candidate.status === "valid" ? "当前材料已通过程序检查；请正式提交索引，随后仍需独立评审。"
            : "按稳定问题编号修正；read_plan_diagnostics 可继续读取完整诊断，不必反复提交探测下一处错误。" };
        const history = ctx.record.planDraftChecks ??= [];
        history.push({ turn: counter.turns, status: draftCheck.status, hash: candidate.hash, ...candidate.diagnostics });
        if (history.length > 24) history.splice(0, history.length - 24);
        await this.save(ctx);
        this.guard(ctx);
      }
      if (tool.name === "read_development_context") {
        const [first, ...rest] = result.content;
        return { ...result, content: [{ ...first, text: JSON.stringify({ ...JSON.parse(first?.type === "text" ? first.text : ""), hostModelBudget: budget() }) }, ...rest] };
      }
      return { ...result, content: [...result.content, { type: "text", text: JSON.stringify({ hostModelBudget: budget(),
        ...(fileState ? { fileState } : {}), ...(draftCheck ? { planDraftCheck: draftCheck } : {}) }) }] };
    } }));
    const sessionTools = [...guardedTools, ...(blockerTool ? [blockerTool] : []), submit];
    const previousInputFailure = persistent.reference.toolInputFailure;
    if (previousInputFailure?.schemaHash) {
      const previousTool = sessionTools.find((tool) => tool.name === previousInputFailure.toolName);
      if (!previousTool || hashValue(previousTool.parameters) !== previousInputFailure.schemaHash)
        delete persistent.reference.toolInputFailure;
    }
    const inputFeedback = (toolName: string, args: unknown) => {
      const tool = sessionTools.find((entry) => entry.name === toolName);
      if (!tool) return;
      const structural = toolInputValidation(args, tool.parameters as ToolSchema, { root: toolName === name ? root : toolName });
      if (structural.valid) return;
      const issues = toolName === name ? submissionIssues(args, submitSchema, { root, sdk: true })
        : planningToolIssues(args, tool.parameters as ToolSchema, toolName);
      const boundIssue = (entry: SubmissionIssue): SubmissionIssue => {
        const result = { ...entry };
        for (const key of ["allowedFields", "requiredFields", "allowedValues"]) if (Array.isArray(result[key]) && (result[key] as unknown[]).length > 8) {
          result[key] = (result[key] as unknown[]).slice(0, 8); result[`${key}Truncated`] = true;
        }
        if (Array.isArray(result.alternatives)) {
          result.alternatives = result.alternatives.slice(0, 2).map((alternative) => boundIssue(alternative as SubmissionIssue));
          if ((entry.alternatives as unknown[]).length > 2) result.alternativesTruncated = true;
        }
        return result;
      };
      const feedback = { ...(toolName === name || toolName === blockerTool?.name ? { submitted: false } : { saved: false }),
        issues: issues.map(boundIssue), total: structural.total, retained: issues.length, truncated: structural.total > issues.length,
        hostModelBudget: budget() };
      while (feedback.issues.length > 1 && JSON.stringify(feedback).length > 14500) {
        feedback.issues.pop(); feedback.retained = feedback.issues.length; feedback.truncated = true;
      }
      return feedback;
    };
    handle.structuredSubmissionTools = [...(blockerTool ? [blockerTool] : []), submit];
    handle.session = await this.sessionFactory({ config: this.config, cwd: await this.workspace.workspacePath(ctx.record.agentId, ctx.record.id),
      reasoningMode: kind === "reviewer" ? "off" : "auto",
      dataDir: await this.storage.directory(ctx.record.agentId, "", { create: true }),
      systemPrompt: developmentNodePrompt(kind)
        + (kind === "reviewer" ? "" : "\n" + WEB_RUNTIME_PROMPT)
        + "\n" + renderPiSubmissionContract({ role: kind, submitName: name, tools: sessionTools, alternativeTools: blockerTool ? [blockerTool.name] : [], structuredResponse: true }),
      customTools: sessionTools, sessionStorage: persistent.options, onModelCall: charge,
      transformContext: (messages) => handle.contextMessage
        ? restoreDevelopmentContext(messages, handle.payload, handle.contextMaxChars, handle.contextMessage) : messages,
      rawInputValidators: Object.fromEntries(sessionTools.map((tool) => [tool.name, async ({ args, toolCallId }) => {
        const feedback = inputFeedback(tool.name, args);
        if (!feedback) return { valid: true };
        const callHash = typeof toolCallId === "string" && toolCallId.length <= 512
          ? hashValue({ toolName: tool.name, toolCallId, turn: counter.turns }) : null;
        if (callHash && !rejectedInputCalls.has(callHash)) {
          rejectedInputCalls.add(callHash);
          const fingerprint = hashValue({ toolName: tool.name, schema: tool.parameters, args });
          const previous = persistent.reference.toolInputFailure;
          if (previous?.count !== 3 && previous?.callHash !== callHash) {
            persistent.reference.toolInputFailure = { toolName: tool.name, fingerprint, schemaHash: hashValue(tool.parameters), callHash,
              count: previous?.fingerprint === fingerprint ? Math.min(3, previous.count + 1) : 1 };
            await this.save(ctx);
          }
        }
        return { valid: false, reason: JSON.stringify(feedback) };
      }])),
      toolErrorResult: ({ toolName, args }) => {
        const feedback = inputFeedback(toolName, args);
        return feedback ? toolResult(feedback) : undefined;
      },
      onToolDiagnostic: async (diagnostic) => {
        this.guard(ctx);
        if (![name, "write", "edit", "save_plan_cases", "edit_plan_cases", "save_plan_json", "update_plan_json", "read_plan_diagnostics", "restore_plan_file"].includes(typeof diagnostic.toolName === "string" ? diagnostic.toolName : "")) return;
        const entries = ctx.record.argumentDiagnostics ??= [];
        entries.push({ role: kind, phase: ctx.record.phase, turn: counter.turns, ...diagnostic });
        if (entries.length > 24) entries.splice(0, entries.length - 24);
        await this.save(ctx);
      },
      maxOutputTokens: developmentModelOutputBudget(this.config, kind) });
    bindDevelopmentSessionFile(persistent.reference, handle.session.sessionFile);
    await this.save(ctx);
    ctx.handles.add(handle);
    if (ctx.signal.aborted) { await handle.session.abort?.(); await this.dispose(ctx, handle); this.guard(ctx); }
    handle.unsubscribe = handle.session.subscribe?.((event) => {
      if ((event.type === "message_end" || event.type === "turn_end") && event.message?.role === "assistant")
        handle.lastAssistant = event.message;
      if (event.type === "tool_execution_start" && event.toolName === name) {
        handle.submissionCalls.set(event.toolCallId!, { value: event.args, recorded: false });
      }
      if (event.type === "tool_execution_end" && event.toolName === name) {
        const call = handle.submissionCalls.get(event.toolCallId!);
        if (event.isError && !call?.recorded && handle.accepting && !ctx.signal.aborted)
          void noteSubmission(event.toolCallId!, call?.value, { status: "rejected", stage: "sdk" })
            .catch(() => { handle.failed = true; void handle.session.abort?.(); });
        handle.submissionCalls.delete(event.toolCallId!);
      }
      if (event.type === "auto_retry_start") {
        if (Number.isInteger(event.attempt) && event.attempt! >= 0 && event.attempt! <= 5) handle.retries = event.attempt!;
        handle.failure = classifyModelFailure(event.errorMessage);
      }
      if (event.type === "auto_retry_end" && !event.success) {
        handle.failed = true; handle.failure = event.finalError ? classifyModelFailure(event.finalError) : handle.failure ?? classifyModelFailure();
      }
      if (event.type === "turn_end" && !handle.session.modelCallAccounting && ++handle.turnsInPrompt > 1) {
        counter.turns++;
        persistent.reference.turns = counter.turns;
        if (counter.turns > limit) { handle.failed = true; void handle.session.abort?.(); }
        void this.save(ctx).catch(() => { handle.failed = true; void handle.session.abort?.(); });
      }
    }) ?? (() => {});
    return handle;
  }

  async dispose(ctx: DevelopmentContext, handle?: DevelopmentHandle) {
    if (!handle || handle.disposed) return;
    handle.disposed = true;
    const lifecycle = new ExecutionLifecycle();
    lifecycle.own("handle", () => ctx.handles.delete(handle));
    lifecycle.own("session", () => handle.session.dispose?.());
    lifecycle.own("subscription", () => handle.unsubscribe?.());
    await lifecycle.close();
  }

  async ask<T>(ctx: DevelopmentContext, handle: DevelopmentHandle<T>, payload: DevelopmentContextPayload): Promise<T> {
    this.guard(ctx);
    handle.checkToolInputs?.();
    ctx.lastRole = handle.kind;
    handle.payload = clone({ ...payload, ...(handle.planningBlocker ? { planningBlockerContract: handle.planningBlocker } : {}) });
    handle.payload.roleGuide = { planner: PLAN_PROMPT, developer: CODE_PROMPT, reviewer: REVIEW_PROMPT }[handle.kind];
    if (ctx.record.architecture.platformSnapshot) handle.payload.platformGuide = renderPlatformRules(ctx.record.architecture.platformSnapshot,
      { runtimeCapabilities: ctx.record.architecture.runtimeCapabilities });
    handle.payload.modelBudget = { limit: handle.limit, used: handle.counter.turns, remaining: Math.max(0, handle.limit - handle.counter.turns) };
    const accepted = handle.reference.pendingResult;
    if (accepted) {
      if (accepted.subjectHash !== (payload.subjectHash ?? null) || accepted.planHash !== (ctx.record.planHash ?? null))
        throw new InputError("已保存的阶段提交与当前评审或计划不一致");
      if (handle.kind === "developer" && (await this.workspace.snapshot(ctx.record.agentId, ctx.record.id)).hash !== accepted.codeHash)
        throw new InputError("已保存的开发提交对应代码已改变，不能恢复旧提交");
      try { return await handle.validate(clone(accepted.result)); }
      catch (error) {
        if (handle.kind !== "developer" || errorField(error, "reason") !== "work_file_unauthorized") throw error;
        // Earlier records could persist a structurally valid submission before checking its
        // declared files. Discard only this known bad result, not its history or spent turns.
        delete handle.reference.pendingResult;
        const issues = submissionIssues(accepted.result, WORK_SCHEMA, { root: "work", error });
        handle.payload.submissionFeedback = { submitted: false, issues };
        handle.payload.feedback = { ...objectFields(handle.payload.feedback), reason: issues[0]!.remedy };
        recordSubmission(ctx.record, { role: handle.kind, phase: ctx.record.phase, taskId: ctx.record.currentTaskId,
          turn: handle.counter.turns, stage: "contract", status: "rejected", issues });
        await this.save(ctx);
      }
    }
    if (handle.counter.turns >= handle.limit) throw new Stop("本任务模型回合预算已用完，已保留进度", "failed", {
      stage: "development", phase: ctx.record.phase, role: handle.kind, reason: "turn_limit",
    });
    Object.assign(handle, { accepting: true, submitted: false, result: undefined, turnsInPrompt: 0 });
    handle.session.setAutoCompactionEnabled?.(true);
    try {
      const maxChars = Math.min(handle.kind === "developer" ? 24_000 : 64_000, Math.max(4096, Math.floor((handle.session.model?.contextWindow ?? 32768) / 2)));
      const prepared = developmentContextMessage(handle.payload, maxChars, { reference: handle.reference, messages: handle.session.messages, kind: handle.kind });
      handle.contextMessage = prepared;
      handle.contextMaxChars = maxChars;
      handle.reference.contextDelivery = prepared.delivery;
      await this.save(ctx);
      let message = prepared.message, continued = false;
      for (;;) {
        if (!handle.session.modelCallAccounting) await handle.charge();
        handle.turnsInPrompt = 0; handle.lastAssistant = undefined;
        const messageCount = handle.session.messages?.length ?? 0;
        try { await handle.session.prompt(message); }
        catch (error) {
          if (!ctx.signal.aborted && handle.submitted && isPlanningBlockerOutcome(handle.result)) {
            await this.current(ctx); return handle.result;
          }
          if (ctx.signal.aborted || error instanceof InputError || error instanceof Stop) throw error;
          throw modelStop(ctx, handle, errorField(error, "message"));
        }
        await ctx.writes;
        this.guard(ctx);
        handle.checkToolInputs?.();
        const last = handle.lastAssistant ?? handle.session.messages?.slice(messageCount).findLast((entry) => entry.role === "assistant");
        if (handle.counter.turns > handle.limit) throw new Stop("本任务模型回合预算已用完，已保留进度", "failed", {
          stage: "development", phase: ctx.record.phase, role: handle.kind, reason: "turn_limit",
        });
        if (handle.failed || ["error", "aborted"].includes(last?.stopReason ?? ""))
          throw modelStop(ctx, handle, last?.errorMessage);
        if (last?.stopReason === "length") throw new Stop("模型输出达到上限，本阶段结果尚未完整提交，进度已保存，可继续。", "failed", {
          stage: "model", phase: ctx.record.phase, role: handle.kind, reason: "output_limit", retries: handle.retries ?? 0,
        });
        if (handle.submitted) return handle.result!;
        const structured = readPiStructuredSubmission(last, { tools: handle.structuredSubmissionTools });
        let structuredFeedback;
        if (structured) {
          try {
            await structured.tool.execute(`structured_submission_${handle.counter.turns}`, structured.args);
          } catch (error) {
            this.guard(ctx);
            if (!(error instanceof InputError)) throw error;
            structuredFeedback = error.message;
          }
          if (handle.submitted) return handle.result!;
        }
        if (continued || last?.stopReason !== "stop") throw new Stop("本阶段没有提交有效的结构化结果，不能推进", "failed", {
          stage: "development", phase: ctx.record.phase, role: handle.kind, reason: "submission_incomplete",
        });
        if (handle.counter.turns >= handle.limit) throw new Stop("本任务模型回合预算已用完，已保留进度", "failed", {
          stage: "development", phase: ctx.record.phase, role: handle.kind, reason: "turn_limit",
        });
        await this.current(ctx);
        continued = true;
        handle.reference.submissionContinuations = (handle.reference.submissionContinuations ?? 0) + 1;
        await this.save(ctx);
        message = JSON.stringify({ submissionContinuation: { reason: "submission_incomplete", attempt: 1, maximum: 1,
          requiredTool: handle.submitName,
          ...(handle.planningBlocker ? { allowedTerminalTools: [handle.submitName, "submit_development_blocker"] } : {}),
          instruction: "上一轮正常结束但尚未正式提交。继续当前会话、已保存草稿和已有工具拒绝反馈，完成当前阶段后调用指定提交工具；若有allowedTerminalTools，也可按公开证据契约正式提交规划技术阻断。不能以文字说明代替提交，不改变冻结需求、授权和验收。完整资料仍可用read_development_context分页读取，无需从头重写。",
          modelBudget: { limit: handle.limit, used: handle.counter.turns, remaining: Math.max(0, handle.limit - handle.counter.turns) },
          ...(handle.payload.feedback || handle.payload.issues ? { existingFailureFeedback: compactDevelopmentContext({
            ...(handle.payload.feedback ? { feedback: handle.payload.feedback } : {}),
            ...(handle.payload.issues ? { issues: handle.payload.issues } : {}),
          }, 4096) } : {}),
          ...(lastSubmissionDiagnostic(ctx.record, handle.kind) ? { submissionFeedback: lastSubmissionDiagnostic(ctx.record, handle.kind) } : {}),
          ...(structuredFeedback ? { structuredSubmissionFeedback: structuredFeedback } : {}),
          ...(handle.kind === "planner" && ctx.record.planningIndexPath ? { planningIndexPath: ctx.record.planningIndexPath } : {}),
        } });
      }
    } finally { handle.accepting = false; }
  }

  base(ctx: DevelopmentContext, caseFacts?: ReturnType<typeof planningCaseFacts>) {
    const r = ctx.record;
    const developmentRevision = r.architecture.developmentRevision ? objectFields(clone(r.architecture.developmentRevision)) : null;
    if (caseFacts?.planSource === "developmentRevision.plan" && developmentRevision?.planHash === caseFacts.planHash
      && objectFields(developmentRevision.caseFacts).planHash === caseFacts.planHash) {
      delete developmentRevision.caseFacts;
      developmentRevision.caseFactsReference = { section: "caseFacts", planHash: caseFacts.planHash, trust: "untrusted-reference" };
    }
    const platform = r.architecture.platformSnapshot ? { platformSnapshot: clone(r.architecture.platformSnapshot),
      platformContractVersion: r.architecture.platformContractVersion, platformHash: r.architecture.platformHash,
      capabilities: platformCapabilityCatalog(r.architecture.platformSnapshot, { runtimeCapabilities: r.architecture.runtimeCapabilities }) } : {};
    return { architectureRef: r.architectureRef,
      ...(ctx.planningWorkspace ? { planningWorkspace: clone(ctx.planningWorkspace) } : {}),
      ...(r.architecture.runtimeCapabilities ? { acceptanceAdapterGuide: clone(ACCEPTANCE_ADAPTER_GUIDE), jsonValueSchemaGuide: JSON_VALUE_SCHEMA_DESCRIPTION } : {}), requirements: r.architecture.requirements,
      design: r.architecture.design,
      ...(r.architecture.runtimeCapabilities ? { runtimeCapabilities: clone(r.architecture.runtimeCapabilities) } : {}),
      verificationAssignments: (r.architecture.design?.acceptance ?? []).map(({ id, verification }) => ({ acceptanceId: id, verification: verification ?? { stage: "development", owner: "generated-code", adapterId: "action" } })), entrypoint: r.plan?.entrypoint, runtime: r.plan?.runtime, application: r.plan?.application,
      ...(r.architecture.deferredVerifications ? { deferredVerifications: clone(r.architecture.deferredVerifications) } : {}),
      ...(developmentRevision ? { developmentRevision } : {}),
      ...(r.architecture.design.schemaVersion === 3 ? { serviceManifestSchema: SERVICE_MANIFEST_SCHEMA } : {}),
      ...(Number(r.architecture.design.schemaVersion) >= 2 ? { testFixtureSchema: TEST_FIXTURE_SCHEMA, testFixtureLimits: FIXTURE_LIMITS, valueSchemaGuide: VALUE_SCHEMA_DESCRIPTION } : {}),
      ...platform, handoffs: r.handoffs.slice(-12), remaining: r.budgets };
  }

  async review(ctx: DevelopmentContext, mode: string, payload: { plan: DevelopmentPlan; planHash: string; report?: DevelopmentEvidence; codeHash?: string; task?: TaskProgress | null; admissionFacts?: unknown; caseFacts?: unknown }, snapshot?: DevelopmentSnapshot) {
    const subjectVersion = mode === "plan" && Number(payload.plan?.schemaVersion) >= 2 ? 2 : 1;
    const subject = mode === "plan" ? planReviewSubject(ctx.record.architectureRef, payload.plan, payload.planHash, subjectVersion)
      : { mode, architectureRef: ctx.record.architectureRef, ...payload };
    if (subjectVersion === 2) payload = { ...payload, admissionFacts: subject.admissionFacts };
    const subjectHash = hashValue(subject);
    if (mode === "plan") payload = { ...payload, caseFacts: { ...developmentCaseFacts(payload.plan, { planHash: payload.planHash, signal: ctx.signal }),
      planSource: "plan", trust: "measurement-only" } };
    ctx.record.pendingReview = { mode, subjectHash, planHash: payload.planHash ?? null, codeHash: snapshot?.hash ?? null,
      reportId: payload.report?.id ?? null };
    await this.save(ctx);
    const counter = { turns: 0 };
    const handle = await this.role(ctx, { kind: "reviewer", counter, limit: this.limits.reviewerTurns,
      scope: { subjectHash },
      tools: snapshot ? await this.workspace.snapshotTools(snapshot, ctx.record.agentId) : [], validate: (value) => validateReview(value, { subjectHash, plan: payload.plan }) });
    try {
      let result = await this.ask(ctx, handle, { ...this.base(ctx), mode, subjectHash, ...payload });
      if (subjectVersion === 2) result = { ...result, subjectVersion };
      ctx.record.reviews.push({ ...result, mode, codeHash: snapshot?.hash ?? null, planHash: payload.planHash ?? null });
      ctx.record.pendingReview = null;
      delete handle.reference.pendingResult;
      await this.save(ctx); return result;
    } finally { await this.dispose(ctx, handle); }
  }

  async plan(ctx: DevelopmentContext) {
    await this.phase(ctx, "planning");
    const workspace = await this.workspace.snapshot(ctx.record.agentId, ctx.record.id);
    this.guard(ctx);
    ctx.planningWorkspace = { empty: workspace.files.length === 0, codeHash: workspace.hash };
    const freshWorkspace = ctx.planningWorkspace.empty;
    let historicalPlanningDraft, historicalDraft;
    if (ctx.record.planningDraftSource && unacceptedPlanning(ctx.record)) {
      const source = ctx.record.planningDraftSource;
      if (source.bindingHash !== planningDraftBinding(ctx.record)) throw new InputError("历史规划草稿与当前架构事实不一致");
      historicalDraft = source.snapshot;
      const currentCheck = await this.artifacts.diagnose(ctx.record.agentId, ctx.record.id, source.snapshot.indexPath, {
        schema: ctx.record.architecture.design.schemaVersion === 3 ? PLAN_V3_SCHEMA : PLAN_V2_SCHEMA,
        architecture: ctx.record.architecture, freshWorkspace, signal: ctx.signal, limit: 40 });
      historicalPlanningDraft = { trust: "unverified", source: { runId: source.snapshot.runId,
        indexPath: source.snapshot.indexPath, bundleHash: source.snapshot.hash,
        files: source.snapshot.files.map(({ path, size, hash }) => ({ path, bytes: size, fileHash: hash, hashScope: "file" })) },
        currentCheck: { status: currentCheck.status, bundleHash: currentCheck.hash, diagnostics: currentCheck.diagnostics },
        ...(source.historicalReview ? { historicalReview: source.historicalReview } : {}),
        instruction: "这是同一架构的历史未通过草稿，只复制了规划材料，没有代码、验收通过结果或旧会话。source.files是精确历史清单；read_plan_file({path,source:'previous',offset?,limit?})按原文分页读取。需要还原同名文件时主动调用restore_plan_file({path,expectedSourceHash:源fileHash,expectedHash:当前fileHash或仅目标不存在时null})，不必重写旧用例；恢复仍是未验收草稿。当前检查已重算；按实际文件局部修正并主动正式提交，仍须独立评审，不改需求或预期以求通过。" };
    }
    const oldPlan = ctx.record.plan;
    const counter = ctx.record.planning;
    let handle: DevelopmentHandle<DevelopmentPlan | { report: PlanningBlockerReport }> | undefined;
    try {
    handle = await this.role(ctx, { kind: "planner", counter, limit: this.limits.reviewerTurns,
      scope: { previousPlanHash: oldPlan ? hashValue(oldPlan) : null },
      tools: [...(Number(ctx.record.architecture.design.schemaVersion) >= 2
        ? await this.artifacts.tools(ctx.record.agentId, ctx.record.id, { signal: ctx.signal,
          casesSchema: (ctx.record.architecture.design.schemaVersion === 3 ? PLAN_V3_SCHEMA : PLAN_V2_SCHEMA).properties.cases,
          planSchema: ctx.record.architecture.design.schemaVersion === 3 ? PLAN_V3_SCHEMA : PLAN_V2_SCHEMA,
          architecture: ctx.record.architecture, previousPlan: oldPlan ?? undefined, historicalDraft, freshWorkspace })
        : await this.workspace.tools(ctx.record.agentId, ctx.record.id, { readOnly: true, signal: ctx.signal })),
        ...(this.services && ctx.record.architecture.design.schemaVersion === 3 ? [{ name: "resolve_service_dependencies", label: "核实服务依赖",
          description: "从受支持的官方包目录解析固定版本及完整依赖工件，不执行包代码。返回的URL与摘要用于服务清单，不能自己猜测。",
          parameters: { type: "object", properties: { packages: { type: "array", maxItems: 40, items: { type: "object", properties: {
            name: { type: "string" }, version: { type: "string" } }, required: ["name", "version"], additionalProperties: false } } }, required: ["packages"], additionalProperties: false },
          executionMode: "sequential" as const, execute: async (_id: string, value: unknown) => {
            this.guard(ctx);
            if (!networkAllowed(ctx.record.architecture.draft)) throw new InputError("当前需求禁止联网，不能下载未缓存的依赖");
            const result = await this.services!.resolveDependencies({ language: ctx.record.architecture.design.execution!.language,
              host: ctx.record.architecture.design.execution!.hosting, packages: objectFields(value).packages, signal: ctx.signal });
            this.guard(ctx); return toolResult(result);
          } }, { name: "resolve_service_image", label: "核实容器镜像",
          description: "查询 Docker Hub 官方镜像的 linux/arm64 固定摘要；仅核实清单，不执行或安装容器。",
          parameters: { type: "object", properties: { image: { type: "string" } }, required: ["image"], additionalProperties: false },
          executionMode: "sequential" as const, execute: async (_id: string, value: unknown) => {
            this.guard(ctx); if (!networkAllowed(ctx.record.architecture.draft)) throw new InputError("当前需求不允许联网核实镜像");
            const result = await this.services!.resolveDockerImage({ image: objectFields(value).image, signal: ctx.signal });
            this.guard(ctx); return toolResult(result);
          } }] : [])],
      validate: (value) => validatePlan(value, { architecture: ctx.record.architecture, previousPlan: oldPlan ?? undefined, freshWorkspace }) });
      for (;;) {
        if (ctx.record.pendingPlanRepair) {
          const feedback = ctx.record.feedback;
          if (!feedback?.review || !feedback.rejectedPlan) throw new InputError("待修订计划的原候选或评语缺失。");
          await repairDevelopmentPlan(this, ctx, feedback.rejectedPlan, { review: feedback.review });
        }
        const caseFacts = ctx.record.pendingPlan?.plan == null ? planningCaseFacts(ctx.record, ctx.signal) : undefined;
        const plan = ctx.record.pendingPlan?.plan ?? await this.ask(ctx, handle, { ...this.base(ctx, caseFacts), previousPlan: ctx.record.plan,
          ...(caseFacts ? { caseFacts } : {}),
          ...(historicalPlanningDraft ? { historicalPlanningDraft } : {}),
          ...(Number(ctx.record.architecture.design.schemaVersion) >= 2 ? { planningFiles: PLAN_ARTIFACT_GUIDE,
            planSchema: ctx.record.architecture.design.schemaVersion === 3 ? PLAN_V3_SCHEMA : PLAN_V2_SCHEMA } : {}),
          issues: ctx.record.feedback, completedTasks: ctx.record.tasks.filter((task) => task.status === "verified") });
        if (isPlanningBlockerOutcome(plan)) return;
        validatePlan(plan, { architecture: ctx.record.architecture, previousPlan: oldPlan ?? undefined, freshWorkspace });
        const planHash = hashValue(plan);
        if (ctx.record.planningArtifact) {
          const frozen = await this.artifacts.validateSnapshot(ctx.record.planningArtifact, ctx.record.agentId);
          if (hashValue(frozen.plan) !== planHash) throw new InputError("规划提交与已封存材料不一致");
        }
        ctx.record.pendingPlan = { plan, planHash };
        delete handle.reference.pendingResult;
        await this.save(ctx);
        const review = await this.review(ctx, "plan", { plan, planHash });
        ctx.record.planAttempts.push({ plan, planHash, review });
        if (review.verdict === "pass") {
          const previous = new Map(ctx.record.tasks.map((task) => [task.id, task]));
          ctx.record.tasks = plan.tasks.map((task) => {
            const prior = previous.get(task.id), taskHash = hashValue(task);
            return { ...task, taskHash, status: prior?.taskHash === taskHash ? prior.status : "pending",
              attempts: prior?.attempts ?? 0, repairs: prior?.repairs ?? 0, turns: prior?.turns ?? 0,
              summary: prior?.summary ?? "", nextAction: "implement" };
          });
          Object.assign(ctx.record, { plan, planHash, feedback: null, needsReplan: false, pendingPlan: null });
          await this.save(ctx); return;
        }
        ctx.record.feedback = { review, rejectedPlan: plan };
        ctx.record.pendingPlan = null;
        await this.save(ctx);
        if (review.verdict === "blocked" || review.issues.some((item) => item.blocking && ["architecture", "environment"].includes(item.kind)))
          throw new Stop(review.summary);
        await this.correction(ctx, "plan", null, () => {
          if (needsDevelopmentRepairDispatch(ctx, { review })) ctx.record.pendingPlanRepair = true;
        });
      }
    } finally { await this.dispose(ctx, handle); delete ctx.planningWorkspace; }
  }

  async verify(ctx: DevelopmentContext, task: TaskProgress | null, snapshot: DevelopmentSnapshot) {
    await this.phase(ctx, "verifying", task ? `正在验收「${task.title}」并检查已有功能…` : "正在对全部任务进行整体验收…");
    const selected = new Set(ctx.record.tasks.filter((item) => item.status === "verified").map((item) => item.id));
    if (task) selected.add(task.id);
    const cases = !task || task.integration ? ctx.record.plan!.cases : ctx.record.plan!.cases.filter((item) => selected.has(item.taskId));
    const pending = ctx.record.pendingReview;
    let evidence = pending?.mode === (task ? "task" : "integration") && pending.codeHash === snapshot.hash
      && pending.planHash === ctx.record.planHash ? ctx.record.reports.find((item) => item.id === pending.reportId
        && item.taskId === (task?.id ?? null) && item.codeHash === snapshot.hash && item.planHash === ctx.record.planHash) : null;
    if (!evidence) {
      const report = await this.verifyExecution(ctx, { snapshot, entrypoint: ctx.record.plan!.entrypoint, cases, runtime: ctx.record.plan!.runtime, application: ctx.record.plan!.application, validateResources: !task || Boolean(task.integration),
        stateful: ctx.record.architecture.design.state.mode === "persistent", signal: ctx.signal });
      this.guard(ctx);
      if (report.codeHash !== snapshot.hash) throw new Stop("测试证据对应的代码版本不一致", "failed");
      evidence = { ...report, id: randomUUID(), mode: task ? "task" : "integration", taskId: task?.id ?? null,
        planHash: ctx.record.planHash!, architectureRef: ctx.record.architectureRef };
      ctx.record.reports.push(evidence);
      await this.save(ctx);
    }
    if (["not_run", "error"].includes(evidence.status)) throw new Stop(evidence.summary || "执行验证尚未完成，不能交付");
    const review = await this.review(ctx, task ? "task" : "integration", { plan: ctx.record.plan!, planHash: ctx.record.planHash!,
      task: task ? clone(task) : null, report: evidence, codeHash: snapshot.hash }, snapshot);
    return { passed: evidence.status === "passed" && review.verdict === "pass", report: evidence, review };
  }

  verifyExecution(ctx: DevelopmentContext, options: Parameters<DevelopmentExecutor["verify"]>[0]) {
    if (options.runtime === "managed-service") {
      if (!this.services) return Promise.resolve({ status: "not_run", codeHash: options.snapshot?.hash, results: [], summary: "受管服务运行器尚未接入" });
      return verifyManagedApplication({ ...options, services: this.services, executor: this.executor, agentId: ctx.record.agentId });
    }
    return this.executor.verify!(options);
  }

  async task(ctx: DevelopmentContext, task: TaskProgress) {
    let handle: DevelopmentHandle<DevelopmentWork> | undefined;
    const create = async () => this.role(ctx, { kind: "developer", counter: task, limit: this.limits.developerTurns,
      scope: { taskId: task.id, taskHash: task.taskHash ?? hashValue({ id: task.id, title: task.title, files: task.files,
        requirementIds: task.requirementIds, acceptanceIds: task.acceptanceIds, dependsOn: task.dependsOn }),
      planHash: ctx.record.planHash!, filesHash: hashValue(task.files) },
      tools: [...await (Number(ctx.record.architecture.design.schemaVersion) >= 2 ? createDevelopmentFileTools(this.workspace, ctx.record.agentId, ctx.record.id,
        { allowedFiles: task.files, signal: ctx.signal }) : this.workspace.tools(ctx.record.agentId, ctx.record.id, { allowedFiles: task.files, signal: ctx.signal })),
        { name: "run_development_checks", label: "运行开发自测", description: "在隔离环境运行已确认的验收用例，自测不代表独立验收通过。",
          parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, executionMode: "sequential",
          execute: async () => {
            const snapshot = await this.workspace.snapshot(ctx.record.agentId, ctx.record.id);
            const report = await this.verifyExecution(ctx, { snapshot, entrypoint: ctx.record.plan!.entrypoint,
              cases: ctx.record.plan!.cases, runtime: ctx.record.plan!.runtime, application: ctx.record.plan!.application, stateful: ctx.record.architecture.design.state.mode === "persistent", signal: ctx.signal });
            this.guard(ctx);
            const evidence = { ...report, id: randomUUID(), mode: "self_test", planHash: ctx.record.planHash };
            ctx.record.reports.push(evidence); await this.save(ctx);
            handle!.payload.selfTest = evidence;
            return toolResult({ status: evidence.status, ...compactDevelopmentContext({ summary: evidence.summary, selfTest: evidence }, 12_000) });
          } }], validate: (value) => validateTaskWork(value, task) });
    try {
      task.status = "active"; ctx.record.currentTaskId = task.id;
      if (!task.attempts) { task.attempts = 1; task.nextAction = "implement"; }
      await this.save(ctx);
      for (;;) {
        if (task.nextAction !== "verify" && task.feedback && (task.integration || task.repairs > 0)
          && needsDevelopmentRepairDispatch(ctx, task.feedback)) {
          await this.phase(ctx, "implementing", `正在按问题分组修复「${task.title}」…`);
          await repairDevelopmentCode(this, ctx, task, task.feedback);
        }
        if (task.nextAction !== "verify") {
          await this.phase(ctx, "implementing", `正在${task.repairs ? "修复" : "开发"}「${task.title}」…`);
          if (!handle) handle = await create();
          const work = await this.ask(ctx, handle, { ...this.base(ctx), task, feedback: task.feedback ?? null,
            cases: ctx.record.plan!.cases,
            ...(ctx.record.plan!.activationCases ? { activationCases: ctx.record.plan!.activationCases } : {}),
            ...(ctx.record.plan!.activationChecks ? { activationChecks: ctx.record.plan!.activationChecks } : {}),
            checkpoint: ctx.record.snapshot ? { hash: ctx.record.snapshot.hash, files: ctx.record.snapshot.files } : null });
          if (work.changedFiles.some((file) => !task.files.includes(file))) throw new Stop("开发结果声明了任务授权范围之外的改动，需要修订任务", "blocked");
          const snapshot = await this.workspace.snapshot(ctx.record.agentId, ctx.record.id);
          const handoff = { taskId: task.id, ...work, codeHash: snapshot.hash, files: snapshot.files };
          ctx.record.handoffs.push(handoff); ctx.record.snapshot = snapshot;
          task.summary = work.summary; task.nextAction = work.continue ? "implement" : "verify";
          delete handle.reference.pendingResult;
          await this.save(ctx);
          if (work.continue) continue;
        }
        const snapshot = await this.workspace.snapshot(ctx.record.agentId, ctx.record.id);
        ctx.record.snapshot = snapshot;
        const result = await this.verify(ctx, task, snapshot);
        task.feedback = result;
        if (result.passed) {
          task.status = "verified"; task.verifiedCodeHash = snapshot.hash; task.nextAction = "done";
          ctx.record.verifiedSnapshot = snapshot; ctx.record.currentTaskId = null;
          await this.save(ctx); return "next";
        }
        await this.save(ctx);
        if (result.review.issues.some((issue) => issue.blocking && ["architecture", "environment"].includes(issue.kind))) throw new Stop(result.review.summary);
        if (result.review.issues.some((issue) => issue.blocking && issue.kind === "plan")) {
          await this.correction(ctx, "plan", null, () => { ctx.record.feedback = result; ctx.record.needsReplan = true; });
          return "replan";
        }
        await this.correction(ctx, "task", task, () => { task.attempts++; task.nextAction = "implement"; });
      }
    } finally { await this.dispose(ctx, handle); }
  }

  async run(architecture: PassedDevelopmentArchitecture, { signal, onProgress = () => {}, resume = false, activate }: RunOptions = {}) {
    if (architecture?.status !== "passed" || !supportedArchitectureVersion(architecture)
      || architecture.candidateHash !== designHash(architecture.design) || architecture.review?.verdict !== "pass"
      || architecture.review.candidateHash !== architecture.candidateHash || architecture.issues?.some((issue) => issue.blocking)
      || !requiresDevelopment(architecture.design)) throw new InputError("请先完成可交接的流程或专用程序架构评估");
    const agentId = architecture.agentId;
    if (this.active.has(agentId)) throw new InputError("这个 Agent 正在研发，请等待完成或停止");
    const controller = new AbortController();
    const ctx: DevelopmentContext = { controller, signal: controller.signal, onProgress, handles: new Set(), writes: Promise.resolve(), record: null!, done: Promise.resolve(), finish() {} };
    ctx.done = new Promise<void>((resolve) => { ctx.finish = resolve; });
    const abort = () => { controller.abort(); for (const handle of ctx.handles) void handle.session.abort?.(); };
    signal?.addEventListener("abort", abort, { once: true });
    this.active.set(agentId, ctx);
    if (signal?.aborted) abort();
    try {
      const storedPrevious = await this.store.get(agentId);
      const previous = storedPrevious ? readDevelopmentRunRecord(storedPrevious) : null;
      if (samePlanningBlocker(previous, architecture, architecture.runtimeCapabilities ? ACCEPTANCE_ADAPTER_GUIDE : null)) {
        ctx.record = previous!;
        await this.current(ctx);
        return clone(previous!);
      }
      if (resume) {
        if (!previous || previous.architectureRef.version !== architecture.version || previous.architectureRef.candidateHash !== architecture.candidateHash)
          throw new InputError("没有与当前架构版本对应的可恢复研发记录");
        ctx.record = previous!;
        if (previous.status === "completed" && previous.delivery === "ready") return clone(previous!);
        Object.assign(ctx.record, { status: "running", delivery: "blocked", diagnostic: null, summary: "正在核对检查点并继续研发…" });
        await this.save(ctx);
      } else {
        ctx.record = readDevelopmentRunRecord(await this.store.create({ id: `dev_${randomUUID().replaceAll("-", "")}`, agentId, name: architecture.name,
          version: (previous?.version ?? 0) + 1, architectureRef: { version: architecture.version, candidateHash: architecture.candidateHash },
          architecture: clone(architecture), status: "running", phase: "intake", delivery: "blocked", summary: LABELS.intake,
          budgets: { corrections: this.limits.corrections, planRevisions: this.limits.planRevisions, integrationRepairs: this.limits.integrationRepairs },
          repairDispatchVersion: 1, dispatchedRepairs: [], repairBatches: {}, planning: { turns: 0 }, tasks: [], plan: null, planHash: null, planAttempts: [], reviews: [], reports: [], handoffs: [],
          currentTaskId: null, snapshot: null, verifiedSnapshot: null, package: null, deliveries: [], feedback: null }));
        if (previous?.status === "failed" && unacceptedPlanning(previous) && Number(architecture.design.schemaVersion) >= 2
          && planningDraftBinding(previous) === planningDraftBinding(ctx.record)) {
          try {
            let draft = previous.planningDraft;
            if (!draft && previous.planDraftChecks?.at(-1)?.hash) {
              const snapshot = await this.artifacts.captureDraft(previous.agentId, previous.id, previous.planningIndexPath ?? "index.json", {
                expectedHash: previous.planDraftChecks!.at(-1)!.hash, signal: ctx.signal });
              if (snapshot) draft = { bindingHash: planningDraftBinding(previous), snapshot };
            }
            if (draft?.bindingHash === planningDraftBinding(ctx.record) && draft.snapshot.runId === previous.id) {
              const restored = await this.artifacts.restoreDraft(draft.snapshot, agentId, ctx.record.id, { signal: ctx.signal });
              ctx.record.planningIndexPath = restored.indexPath;
              ctx.record.planningDraftSource = clone(draft);
              let historicalReview = historicalPlanReview(previous);
              const inherited = previous.planningDraftSource?.historicalReview;
              if (!historicalReview && /^dev_[a-f0-9]{32}$/u.test(inherited?.sourceRunId ?? "") && this.store.getRun) {
                const storedOriginal = await this.store.getRun(inherited!.sourceRunId);
                const original = storedOriginal ? readDevelopmentRunRecord(storedOriginal) : null;
                this.guard(ctx);
                if (original && planningDraftBinding(original) === planningDraftBinding(ctx.record))
                  historicalReview = historicalPlanReview(original);
              }
              if (historicalReview) ctx.record.planningDraftSource.historicalReview = historicalReview;
              await this.save(ctx);
            }
          } catch (error) {
            this.guard(ctx);
            if (!(error instanceof InputError) && !["ENOENT", "EACCES", "EPERM"].includes(String(errorField(error, "code")))) throw error;
            ctx.record.planningDraftRecovery = { status: "skipped", reason: "draft_unavailable_or_changed", sourceRunId: previous.id };
            await this.save(ctx);
          }
        }
      }
      await this.current(ctx);
      await this.phase(ctx, "intake");
      if (architecture.design.schemaVersion === 3 && architecture.design.execution?.language === "none")
        throw new Stop("已评审方案只使用现有工具，应返回架构层核对交付方式；当前代码和进度已保留。", "blocked",
          { stage: "architecture", phase: "intake", reason: "development_not_required" });
      if (resume && ctx.record.plan) {
        validatePlan(ctx.record.plan, { architecture });
        if (ctx.record.planHash !== hashValue(ctx.record.plan)) throw new InputError("研发计划与保存摘要不一致，不能恢复旧会话或验收状态");
        for (const task of ctx.record.tasks.filter((item) => !item.integration)) {
          const definition = ctx.record.plan!.tasks.find((item) => item.id === task.id);
          if (!definition || task.taskHash && task.taskHash !== hashValue(definition)
            || Object.keys(definition).some((key) => !Object.hasOwn(task, key) || hashValue(objectFields(task)[key]) !== hashValue(objectFields(definition)[key])))
            throw new InputError("研发任务与冻结计划不一致，不能恢复旧会话或验收状态");
        }
        if (ctx.record.planningArtifact && !ctx.record.needsReplan) {
          const frozen = await this.artifacts.validateSnapshot(ctx.record.planningArtifact, ctx.record.agentId);
          if (hashValue(frozen.plan) !== ctx.record.planHash) throw new InputError("研发规划材料与冻结计划不一致");
        }
      }
      await this.workspace.create(ctx.record.agentId, ctx.record.id);
      const execution = architecture.design.execution;
      if (execution && execution.hosting !== "builtin" && this.services) {
        await this.phase(ctx, "intake", "正在准备并检查所需运行环境…");
        try { await this.services.prepareEnvironment({ language: execution.language, host: execution.hosting, signal: ctx.signal,
          onProgress: (value) => ctx.onProgress({ type: "status", phase: "intake", label: value.status === "downloading"
            ? `正在下载受管运行环境（已接收 ${Math.round(Number(value.bytes) / 1048576)} MiB）…`
            : value.status === "installing" ? "正在校验并安装受管环境…" : "运行环境已准备…" }) }); }
        catch (error) {
          if (ctx.signal.aborted) throw error;
          throw new Stop("所需运行环境未准备完成；检查网络或环境后可继续当前研发。", "blocked",
            { stage: "environment", phase: "intake", reason: errorField(error, "reason") ?? "environment_preparation_failed" });
        }
      }
      const probe = execution && execution.hosting !== "builtin"
        ? this.services ? await this.services.probe({ language: execution.language, host: execution.hosting, signal: ctx.signal }) : { available: false, reason: "受管运行器尚未接入" }
        : await this.executor.probe({ signal: ctx.signal });
      this.guard(ctx);
      ctx.record.execution = probe;
      if (!probe.available) throw new Stop(execution?.hosting === "docker"
        ? "待准备环境：请安装并启动 Docker，然后继续当前研发。" : "待准备环境：本机隔离运行检查未通过，已保留研发记录。", "blocked",
        { stage: "environment", phase: "intake", reason: probe.reason ?? "runtime_unavailable" });
      if (resume) {
        const actual = await this.workspace.snapshot(ctx.record.agentId, ctx.record.id);
        if (ctx.record.snapshot?.hash !== actual.hash) {
          for (const task of ctx.record.tasks) {
            if (task.status === "active") task.nextAction = "implement";
          }
          ctx.record.feedback = { reason: "工作区与最近检查点不同，已保留实际改动，必须重新验证", codeHash: actual.hash };
        }
        ctx.record.snapshot = actual;
        await this.save(ctx);
      }
      for (;;) {
        if (!ctx.record.plan || ctx.record.needsReplan) await this.plan(ctx);
        if (ctx.record.status === "blocked") return clone(ctx.record);
        const pending = ctx.record.tasks.filter((task) => task.status !== "verified");
        const task = nextReadyDevelopmentTask(ctx.record.tasks);
        if (pending.length && !task) throw new Stop("任务依赖尚未满足，不能继续开发");
        if (task) { await this.task(ctx, task); continue; }
        const snapshot = await this.workspace.snapshot(ctx.record.agentId, ctx.record.id);
        ctx.record.snapshot = snapshot;
        const result = await this.verify(ctx, null, snapshot);
        if (!result.passed) {
          ctx.record.feedback = result;
          await this.save(ctx);
          if (result.review.issues.some((issue) => issue.blocking && ["architecture", "environment"].includes(issue.kind))) throw new Stop(result.review.summary);
          if (result.review.issues.some((issue) => issue.blocking && issue.kind === "plan")) {
            await this.correction(ctx, "plan", null, () => { ctx.record.needsReplan = true; }); continue;
          }
          await this.integrationRepair(ctx, result); continue;
        }
        if (ctx.record.architecture.design.acceptance.some((item) => item.verification)) {
          ctx.record.acceptanceLedger = recordDevelopmentAcceptance(createAcceptanceLedger({ architecture: ctx.record.architecture,
            plan: ctx.record.plan!, codeHash: snapshot.hash }), { report: result.report, cases: ctx.record.plan!.cases });
          if (ctx.record.acceptanceLedger.items.some((item) => item.verification.adapterId === "delivery-review")) {
            ctx.record.acceptanceLedger = recordIndependentAcceptance(ctx.record.acceptanceLedger, { plan: ctx.record.plan!,
              planReview: ctx.record.reviews.findLast((item) => item.mode === "plan" && item.planHash === ctx.record.planHash && item.verdict === "pass"),
              integrationReview: ctx.record.reviews.findLast((item) => item.mode === "integration" && item.codeHash === snapshot.hash && item.verdict === "pass"), report: result.report });
          }
          assertAcceptanceComplete(ctx.record.acceptanceLedger, { architecture: ctx.record.architecture, plan: ctx.record.plan!,
            codeHash: snapshot.hash, stageScope: ["development"] });
        }
        await this.phase(ctx, "packaging");
        ctx.record.package = { id: `pkg_${randomUUID()}`, buildId: ctx.record.id, architectureRef: ctx.record.architectureRef, codeHash: snapshot.hash,
          planHash: ctx.record.planHash!, entrypoint: ctx.record.plan!.entrypoint, runtime: ctx.record.plan!.runtime, snapshot,
          ...(["node-action", "managed-service"].includes(ctx.record.plan!.runtime) ? { protocolVersion: ctx.record.plan!.application!.protocolVersion,
            application: bindApplicationManifest(ctx.record.plan!.application, snapshot, [result.report.id]) } : {}),
          verificationId: result.report.id, ...(ctx.record.acceptanceLedger ? { acceptanceLedger: clone(ctx.record.acceptanceLedger) } : {}) };
        (ctx.record.deliveries ??= []).push({ package: clone(ctx.record.package!), status: "verified" });
        await this.save(ctx);
        await this.current(ctx);
        const delivery = activate ? await activate(clone(ctx.record), ctx.signal) : { delivery: "needs_development", summary: "研发验收已完成，等待运行层接入" };
        await this.current(ctx);
        if (delivery.repair) {
          const report = { ...delivery.repair, id: randomUUID(), mode: "runtime", codeHash: snapshot.hash,
            planHash: ctx.record.planHash!, architectureRef: ctx.record.architectureRef };
          ctx.record.reports.push(report);
          await this.save(ctx);
          const review = await this.review(ctx, "integration", { plan: ctx.record.plan!, planHash: ctx.record.planHash!,
            report, codeHash: snapshot.hash }, snapshot);
          if (review.issues.some((issue) => issue.blocking && ["architecture", "environment"].includes(issue.kind))) throw new Stop(review.summary);
          await this.integrationRepair(ctx, { report, review }, "修复交付启动问题");
          continue;
        }
        if (delivery.acceptanceLedger) {
          ctx.record.acceptanceLedger = clone(delivery.acceptanceLedger);
          ctx.record.package!.acceptanceLedger = clone(delivery.acceptanceLedger);
          ctx.record.deliveries.at(-1)!.package.acceptanceLedger = clone(delivery.acceptanceLedger);
        }
        Object.assign(ctx.record, { status: "completed", delivery: delivery.delivery, diagnostic: null, summary: delivery.summary,
          runtimeCheck: delivery.runtimeCheck ?? null, currentTaskId: null });
        Object.assign(ctx.record.deliveries.at(-1)!, { status: delivery.delivery === "ready" ? "activated" : "verified",
          runtimeCheck: delivery.runtimeCheck ?? null });
        await this.save(ctx);
        await this.current(ctx);
        onProgress({ type: "status", phase: "packaging", label: ctx.record.summary, development: developmentSummary(ctx.record) });
        return clone(ctx.record);
      }
    } catch (error) {
      if (!ctx.record) throw error;
      Object.assign(ctx.record, { status: ctx.signal.aborted ? "cancelled" : error instanceof Stop ? error.status : "failed",
        delivery: "blocked", summary: ctx.signal.aborted ? "研发已停止，已保存代码与交接记录，可继续。"
          : error instanceof Stop || error instanceof InputError ? error.message
            : errorField(error, "name") === "ServiceError" ? serviceErrorMessage(String(errorField(error, "reason"))) : "研发未完成，检查点已保留，可继续并核实当前步骤。" });
      ctx.record.diagnostic = ctx.signal.aborted ? { stage: "development", phase: ctx.record.phase, reason: "cancelled" }
        : error instanceof Stop && error.diagnostic ? error.diagnostic
          : { stage: errorField(error, "name") === "ServiceError" ? "runtime" : "development", phase: ctx.record.phase,
            reason: error instanceof InputError ? "invalid_result" : errorField(error, "name") === "ServiceError" ? errorField(error, "reason") : "execution_failed" };
      const submission = !ctx.signal.aborted && lastSubmissionDiagnostic(ctx.record, ctx.record.diagnostic!.role ?? ctx.lastRole);
      if (submission) ctx.record.diagnostic!.submission = submission;
      if (!ctx.signal.aborted && unacceptedPlanning(ctx.record) && Number(ctx.record.architecture.design.schemaVersion) >= 2) {
        try {
          const snapshot = await this.artifacts.captureDraft(ctx.record.agentId, ctx.record.id, ctx.record.planningIndexPath ?? "index.json", { signal: ctx.signal });
          if (snapshot) ctx.record.planningDraft = { bindingHash: planningDraftBinding(ctx.record), snapshot };
        } catch (draftError) {
          ctx.record.planningDraftCapture = { status: "skipped", reason: "draft_unavailable_or_changed" };
        }
      }
      await this.save(ctx);
      return clone(ctx.record);
    } finally {
      const lifecycle = new ExecutionLifecycle();
      lifecycle.own("run", () => { if (this.active.get(agentId) === ctx) this.active.delete(agentId); ctx.finish(); });
      for (const handle of [...ctx.handles].reverse()) lifecycle.own("role", () => this.dispose(ctx, handle));
      lifecycle.own("abort-listener", () => signal?.removeEventListener("abort", abort));
      await lifecycle.close();
    }
  }

  async cancel(id: string) {
    const ctx = this.active.get(id);
    if (!ctx) return { cancelled: false, development: await this.get(id) };
    ctx.controller.abort();
    await Promise.allSettled([...ctx.handles].map((handle) => handle.session.abort?.()));
    await ctx.done;
    return { cancelled: true, development: await this.get(id) };
  }

  async close() { await Promise.allSettled([...this.active.keys()].map((id) => this.cancel(id))); }
}
