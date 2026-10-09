import { randomUUID } from "node:crypto";
import { InputError } from "../requirements/core.mjs";
import { createPiSession } from "../runtime/pi-runtime.mjs";
import { designHash, ARCHITECTURE_VERSION } from "../architecture/architecture-contract.mjs";
import { PLAN_SCHEMA, REVIEW_SCHEMA, WORK_SCHEMA, validatePlan, validateReview, validateWork, hashValue } from "./development-contract.mjs";
import { DevelopmentStore } from "./development-store.mjs";
import { DevelopmentWorkspace } from "./development-workspace.mjs";
import { DevelopmentExecutor } from "./development-executor.mjs";
import { PLAN_PROMPT, CODE_PROMPT, REVIEW_PROMPT } from "./development-prompts.mjs";
import { compactDevelopmentContext, createContextReadTool } from "./development-context.mjs";
import { AgentStorage } from "../agents/agent-storage.mjs";

const LABELS = { intake: "正在接收设计与准备工作区…", planning: "正在拆分并检查研发任务…",
  implementing: "正在开发当前任务…", verifying: "正在运行测试与独立验收…", packaging: "正在整理经过验证的交付物…" };
const DEFAULT_LIMITS = Object.freeze({ corrections: 6, planRevisions: 1, taskRepairs: 2, integrationRepairs: 2, developerTurns: 40, reviewerTurns: 12 });
const toolResult = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }], details: {} });
const clone = (value) => structuredClone(value);

class Stop extends Error {
  constructor(message, status = "blocked") { super(message); this.status = status; }
}

export function developmentSummary(record) {
  if (!record) return null;
  return clone({ id: record.id, agentId: record.agentId, name: record.name, version: record.version,
    architectureRef: record.architectureRef, status: record.status, phase: record.phase, summary: record.summary,
    delivery: record.delivery, currentTaskId: record.currentTaskId, budgets: record.budgets,
    tasks: (record.tasks ?? []).map(({ id, title, status, attempts, repairs, summary }) => ({ id, title, status, attempts, repairs, summary })),
    package: record.package ? { codeHash: record.package.codeHash, planHash: record.package.planHash, entrypoint: record.package.entrypoint } : null,
    verification: record.reports?.at(-1) ? { status: record.reports.at(-1).status, summary: record.reports.at(-1).summary } : null,
    createdAt: record.createdAt, updatedAt: record.updatedAt });
}

export class DevelopmentController {
  constructor({ config, cwd, dataDir, storage, sessionFactory = createPiSession, store, workspace, executor, getArchitecture, limits = {} }) {
    Object.assign(this, { config, cwd, dataDir, sessionFactory, getArchitecture });
    this.storage = storage ?? store?.storage ?? workspace?.storage ?? new AgentStorage({ dataDir });
    this.store = store ?? new DevelopmentStore({ dataDir, storage: this.storage });
    this.workspace = workspace ?? new DevelopmentWorkspace({ dataDir, storage: this.storage });
    this.executor = executor ?? new DevelopmentExecutor();
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.active = new Map();
  }

  async get(id) { return developmentSummary(await this.store.get(id)); }
  has(id) { return this.active.has(id); }
  async remove(id) { await this.cancel(id); await this.store.remove(id); }

  guard(ctx) {
    ctx.signal.throwIfAborted();
    if (this.active.get(ctx.record.agentId) !== ctx) throw new Stop("这轮研发已经失效");
  }

  async save(ctx) {
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

  async current(ctx) {
    this.guard(ctx);
    if (!this.getArchitecture) return;
    const current = await this.getArchitecture(ctx.record.agentId);
    this.guard(ctx);
    if (current?.status !== "passed" || current.version !== ctx.record.architectureRef.version
      || current.candidateHash !== ctx.record.architectureRef.candidateHash)
      throw new Stop("架构版本已经变化，当前研发结果不能交付；请基于新的已评估方案开始研发");
  }

  async phase(ctx, phase, summary = LABELS[phase]) {
    await this.current(ctx);
    Object.assign(ctx.record, { phase, summary });
    await this.save(ctx);
    ctx.onProgress({ type: "status", phase, label: summary, development: developmentSummary(ctx.record) });
  }

  async correction(ctx, kind, task, transition = () => {}) {
    const budgets = ctx.record.budgets;
    if (budgets.corrections <= 0 || (kind === "plan" && budgets.planRevisions <= 0)
      || (kind === "integration" && budgets.integrationRepairs <= 0)
      || (kind === "task" && task.repairs >= this.limits.taskRepairs))
      throw new Stop("自动修订预算已用完，代码和失败证据已保存", "failed");
    budgets.corrections--;
    if (kind === "plan") budgets.planRevisions--;
    if (kind === "integration") budgets.integrationRepairs--;
    if (kind === "task") task.repairs++;
    transition();
    await this.save(ctx);
  }

  async integrationRepair(ctx, feedback, title = "修复整体验收问题") {
    await this.correction(ctx, "integration", null, () => {
      const delivered = ctx.record.deliveries?.find((item) => item.package.id === ctx.record.package?.id);
      if (delivered) { delivered.status = "defective"; delivered.failureReportId = feedback.report.id; }
      ctx.record.package = null;
      ctx.record.feedback = feedback;
      ctx.record.tasks.push({ id: `integration_${randomUUID().slice(0, 8)}`, title, description: feedback.review.summary,
        requirementIds: ctx.record.architecture.requirements.map((item) => item.id), acceptanceIds: ctx.record.architecture.design.acceptance.map((item) => item.id),
        dependsOn: [], files: [...new Set(ctx.record.plan.tasks.flatMap((item) => item.files))], integration: true,
        status: "pending", attempts: 0, repairs: 0, turns: 0, feedback, nextAction: "implement" });
    });
  }

  async role(ctx, { kind, tools = [], validate, counter, limit }) {
    const name = kind === "planner" ? "submit_development_plan" : kind === "developer" ? "submit_development_work" : "submit_development_review";
    const schemas = { planner: PLAN_SCHEMA, developer: WORK_SCHEMA, reviewer: REVIEW_SCHEMA };
    const handle = { kind, accepting: false, submitted: false, result: undefined, counter, limit, failed: false, turnsInPrompt: 0, disposed: false };
    const submit = { name, label: "提交阶段结果", description: "提交经过结构校验的阶段结果；提交不表示整体通过。",
      parameters: schemas[kind], executionMode: "sequential", execute: async (_id, value) => {
        this.guard(ctx);
        if (!handle.accepting || handle.submitted) throw new InputError("本阶段已提交，请结束本轮");
        const result = validate(value);
        handle.result = result; handle.submitted = true;
        return toolResult({ submitted: true });
      } };
    const guardedTools = [...tools, createContextReadTool(() => handle.payload)].map((tool) => ({ ...tool, execute: async (...args) => {
      this.guard(ctx);
      if (!handle.accepting || handle.submitted) throw new InputError("当前阶段不能继续修改或读取工具，请等待下一项工作");
      const result = await tool.execute(...args);
      this.guard(ctx); return result;
    } }));
    handle.session = await this.sessionFactory({ config: this.config, cwd: await this.workspace.workspacePath(ctx.record.agentId, ctx.record.id),
      dataDir: await this.storage.directory(ctx.record.agentId, "", { create: true }),
      systemPrompt: { planner: PLAN_PROMPT, developer: CODE_PROMPT, reviewer: REVIEW_PROMPT }[kind],
      customTools: [...guardedTools, submit] });
    if (kind === "developer") handle.session.setAutoCompactionEnabled?.(false);
    ctx.handles.add(handle);
    if (ctx.signal.aborted) { await handle.session.abort?.(); this.dispose(ctx, handle); this.guard(ctx); }
    handle.unsubscribe = handle.session.subscribe?.((event) => {
      if (event.type === "auto_retry_end" && !event.success) handle.failed = true;
      if (event.type === "turn_end" && ++handle.turnsInPrompt > 1) {
        counter.turns++;
        if (counter.turns > limit) { handle.failed = true; void handle.session.abort?.(); }
        void this.save(ctx).catch(() => { handle.failed = true; void handle.session.abort?.(); });
      }
      if (event.type === "turn_end" && kind === "developer" && !handle.submitted && !handle.failed
        && handle.session.getContextUsage?.()?.percent >= 65) {
        handle.rotate = true;
        void handle.session.abort?.();
      }
    }) ?? (() => {});
    return handle;
  }

  dispose(ctx, handle) {
    if (!handle || handle.disposed) return;
    handle.disposed = true; handle.unsubscribe?.(); handle.session.dispose?.(); ctx.handles.delete(handle);
  }

  async ask(ctx, handle, payload) {
    this.guard(ctx);
    if (handle.counter.turns >= handle.limit) throw new Stop("本任务模型回合预算已用完，已保留进度", "failed");
    handle.counter.turns++;
    await this.save(ctx);
    Object.assign(handle, { accepting: true, submitted: false, result: undefined, turnsInPrompt: 0, rotate: false });
    handle.payload = clone(payload);
    try {
      const maxChars = Math.min(16_000, Math.max(4096, Math.floor((handle.session.model?.contextWindow ?? 32768) / 2)));
      try { await handle.session.prompt(JSON.stringify(compactDevelopmentContext(handle.payload, maxChars))); }
      catch (error) { if (!handle.rotate || ctx.signal.aborted || handle.failed) throw error; }
      await ctx.writes;
      this.guard(ctx);
      if (handle.rotate && !handle.failed) return validateWork({ summary: "已保存当前代码，正在按检查点续接上下文。",
        changedFiles: [], knownIssues: [], nextAction: "读取当前任务、代码和最近失败证据，继续未完成的实现。", continue: true });
      const last = handle.session.messages?.findLast((message) => message.role === "assistant");
      if (handle.failed || ["error", "aborted"].includes(last?.stopReason))
        throw new Stop("模型调用未完成，研发进度已保存，请检查连接后继续", "failed");
      if (!handle.submitted) throw new Stop("本阶段没有提交有效的结构化结果，不能推进", "failed");
      return handle.result;
    } finally { handle.accepting = false; }
  }

  base(ctx) {
    const r = ctx.record;
    return { architectureRef: r.architectureRef, requirements: r.architecture.requirements,
      design: r.architecture.design, entrypoint: r.plan?.entrypoint,
      handoffs: r.handoffs.slice(-12), remaining: r.budgets };
  }

  async review(ctx, mode, payload, snapshot) {
    const subjectHash = hashValue({ mode, architectureRef: ctx.record.architectureRef, ...payload });
    const counter = { turns: 0 };
    const handle = await this.role(ctx, { kind: "reviewer", counter, limit: this.limits.reviewerTurns,
      tools: snapshot ? await this.workspace.snapshotTools(snapshot, ctx.record.agentId) : [], validate: (value) => validateReview(value, { subjectHash }) });
    try {
      const result = await this.ask(ctx, handle, { ...this.base(ctx), mode, subjectHash, ...payload });
      ctx.record.reviews.push({ ...result, mode, codeHash: snapshot?.hash ?? null, planHash: payload.planHash ?? null });
      await this.save(ctx); return result;
    } finally { this.dispose(ctx, handle); }
  }

  async plan(ctx) {
    await this.phase(ctx, "planning");
    const oldPlan = ctx.record.plan;
    const counter = ctx.record.planning;
    const handle = await this.role(ctx, { kind: "planner", counter, limit: this.limits.reviewerTurns,
      tools: await this.workspace.tools(ctx.record.agentId, ctx.record.id, { readOnly: true, signal: ctx.signal }),
      validate: (value) => validatePlan(value, { architecture: ctx.record.architecture, previousPlan: oldPlan ?? undefined }) });
    try {
      for (;;) {
        const plan = await this.ask(ctx, handle, { ...this.base(ctx), previousPlan: ctx.record.plan,
          issues: ctx.record.feedback, completedTasks: ctx.record.tasks.filter((task) => task.status === "verified") });
        const planHash = hashValue(plan);
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
          Object.assign(ctx.record, { plan, planHash, feedback: null, needsReplan: false });
          await this.save(ctx); return;
        }
        ctx.record.feedback = { review, rejectedPlan: plan };
        await this.save(ctx);
        if (review.verdict === "blocked" || review.issues.some((item) => item.blocking && ["architecture", "environment"].includes(item.kind)))
          throw new Stop(review.summary);
        await this.correction(ctx, "plan");
      }
    } finally { this.dispose(ctx, handle); }
  }

  async verify(ctx, task, snapshot) {
    await this.phase(ctx, "verifying", task ? `正在验收「${task.title}」并检查已有功能…` : "正在对全部任务进行整体验收…");
    const selected = new Set(ctx.record.tasks.filter((item) => item.status === "verified").map((item) => item.id));
    if (task) selected.add(task.id);
    const cases = !task || task.integration ? ctx.record.plan.cases : ctx.record.plan.cases.filter((item) => selected.has(item.taskId));
    const report = await this.executor.verify({ snapshot, entrypoint: ctx.record.plan.entrypoint, cases,
      stateful: ctx.record.architecture.design.state.mode === "persistent", signal: ctx.signal });
    this.guard(ctx);
    if (report.codeHash !== snapshot.hash) throw new Stop("测试证据对应的代码版本不一致", "failed");
    const evidence = { ...report, id: randomUUID(), mode: task ? "task" : "integration", taskId: task?.id ?? null,
      planHash: ctx.record.planHash, architectureRef: ctx.record.architectureRef };
    ctx.record.reports.push(evidence);
    await this.save(ctx);
    if (["not_run", "error"].includes(report.status)) throw new Stop(report.summary || "执行验证尚未完成，不能交付");
    const review = await this.review(ctx, task ? "task" : "integration", { plan: ctx.record.plan, planHash: ctx.record.planHash,
      task: task ? clone(task) : null, report: evidence, codeHash: snapshot.hash }, snapshot);
    return { passed: report.status === "passed" && review.verdict === "pass", report: evidence, review };
  }

  async task(ctx, task) {
    let handle;
    const create = async () => this.role(ctx, { kind: "developer", counter: task, limit: this.limits.developerTurns,
      tools: [...await this.workspace.tools(ctx.record.agentId, ctx.record.id, { allowedFiles: task.files, signal: ctx.signal }),
        { name: "run_development_checks", label: "运行开发自测", description: "在隔离环境运行已确认的验收用例，自测不代表独立验收通过。",
          parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, executionMode: "sequential",
          execute: async () => {
            const snapshot = await this.workspace.snapshot(ctx.record.agentId, ctx.record.id);
            const report = await this.executor.verify({ snapshot, entrypoint: ctx.record.plan.entrypoint,
              cases: ctx.record.plan.cases, stateful: ctx.record.architecture.design.state.mode === "persistent", signal: ctx.signal });
            this.guard(ctx);
            const evidence = { ...report, id: randomUUID(), mode: "self_test", planHash: ctx.record.planHash };
            ctx.record.reports.push(evidence); await this.save(ctx);
            handle.payload.selfTest = evidence;
            return toolResult({ status: evidence.status, ...compactDevelopmentContext({ summary: evidence.summary, selfTest: evidence }, 12_000) });
          } }], validate: validateWork });
    try {
      task.status = "active"; ctx.record.currentTaskId = task.id;
      if (!task.attempts) { task.attempts = 1; task.nextAction = "implement"; }
      await this.save(ctx);
      for (;;) {
        if (task.nextAction !== "verify") {
          await this.phase(ctx, "implementing", `正在${task.repairs ? "修复" : "开发"}「${task.title}」…`);
          if (!handle) handle = await create();
          const work = await this.ask(ctx, handle, { ...this.base(ctx), task, feedback: task.feedback ?? null,
            cases: ctx.record.plan.cases, checkpoint: ctx.record.snapshot ? { hash: ctx.record.snapshot.hash, files: ctx.record.snapshot.files } : null });
          if (work.changedFiles.some((file) => !task.files.includes(file))) throw new Stop("开发结果声明了任务授权范围之外的改动，需要修订任务", "blocked");
          const snapshot = await this.workspace.snapshot(ctx.record.agentId, ctx.record.id);
          const handoff = { taskId: task.id, ...work, codeHash: snapshot.hash, files: snapshot.files };
          ctx.record.handoffs.push(handoff); ctx.record.snapshot = snapshot;
          task.summary = work.summary; task.nextAction = work.continue ? "implement" : "verify";
          await this.save(ctx);
          if (work.continue) { this.dispose(ctx, handle); handle = null; continue; }
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
        const usage = handle?.session.getContextUsage?.();
        if (usage?.percent >= 65) { this.dispose(ctx, handle); handle = null; }
      }
    } finally { this.dispose(ctx, handle); }
  }

  async run(architecture, { signal, onProgress = () => {}, resume = false, activate } = {}) {
    if (architecture?.status !== "passed" || architecture.contractVersion !== ARCHITECTURE_VERSION
      || architecture.candidateHash !== designHash(architecture.design) || architecture.review?.verdict !== "pass"
      || architecture.review.candidateHash !== architecture.candidateHash || architecture.issues?.some((issue) => issue.blocking)
      || !["workflow", "custom"].includes(architecture.design.profile)) throw new InputError("请先完成可交接的流程或专用程序架构评估");
    const agentId = architecture.agentId;
    if (this.active.has(agentId)) throw new InputError("这个 Agent 正在研发，请等待完成或停止");
    const controller = new AbortController();
    const ctx = { controller, signal: controller.signal, onProgress, handles: new Set(), writes: Promise.resolve(), record: null };
    ctx.done = new Promise((resolve) => { ctx.finish = resolve; });
    const abort = () => { controller.abort(); for (const handle of ctx.handles) void handle.session.abort?.(); };
    signal?.addEventListener("abort", abort, { once: true });
    this.active.set(agentId, ctx);
    if (signal?.aborted) abort();
    try {
      const previous = await this.store.get(agentId);
      if (resume) {
        if (!previous || previous.architectureRef.version !== architecture.version || previous.architectureRef.candidateHash !== architecture.candidateHash)
          throw new InputError("没有与当前架构版本对应的可恢复研发记录");
        ctx.record = previous;
        if (previous.status === "completed" && previous.delivery === "ready") return clone(previous);
        Object.assign(ctx.record, { status: "running", delivery: "blocked", summary: "正在核对检查点并继续研发…" });
        await this.save(ctx);
      } else {
        ctx.record = await this.store.create({ id: `dev_${randomUUID().replaceAll("-", "")}`, agentId, name: architecture.name,
          version: (previous?.version ?? 0) + 1, architectureRef: { version: architecture.version, candidateHash: architecture.candidateHash },
          architecture: clone(architecture), status: "running", phase: "intake", delivery: "blocked", summary: LABELS.intake,
          budgets: { corrections: this.limits.corrections, planRevisions: this.limits.planRevisions, integrationRepairs: this.limits.integrationRepairs },
          planning: { turns: 0 }, tasks: [], plan: null, planHash: null, planAttempts: [], reviews: [], reports: [], handoffs: [],
          currentTaskId: null, snapshot: null, verifiedSnapshot: null, package: null, deliveries: [], feedback: null });
      }
      await this.current(ctx);
      await this.phase(ctx, "intake");
      await this.workspace.create(ctx.record.agentId, ctx.record.id);
      const probe = await this.executor.probe({ signal: ctx.signal });
      this.guard(ctx);
      ctx.record.execution = probe;
      if (!probe.available) throw new Stop(probe.reason || "隔离执行环境尚不可用，已保留研发记录");
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
        const pending = ctx.record.tasks.filter((task) => task.status !== "verified");
        const task = pending.find((task) => task.dependsOn.every((id) => ctx.record.tasks.some((item) => item.id === id && item.status === "verified")));
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
        await this.phase(ctx, "packaging");
        ctx.record.package = { id: `pkg_${randomUUID()}`, buildId: ctx.record.id, architectureRef: ctx.record.architectureRef, codeHash: snapshot.hash,
          planHash: ctx.record.planHash, entrypoint: ctx.record.plan.entrypoint, runtime: "node-json", snapshot,
          verificationId: result.report.id };
        (ctx.record.deliveries ??= []).push({ package: clone(ctx.record.package), status: "verified" });
        await this.save(ctx);
        await this.current(ctx);
        const delivery = activate ? await activate(clone(ctx.record), ctx.signal) : { delivery: "needs_development", summary: "研发验收已完成，等待运行层接入" };
        await this.current(ctx);
        if (delivery.repair) {
          const report = { ...delivery.repair, id: randomUUID(), mode: "runtime", codeHash: snapshot.hash,
            planHash: ctx.record.planHash, architectureRef: ctx.record.architectureRef };
          ctx.record.reports.push(report);
          await this.save(ctx);
          const review = await this.review(ctx, "integration", { plan: ctx.record.plan, planHash: ctx.record.planHash,
            report, codeHash: snapshot.hash }, snapshot);
          if (review.issues.some((issue) => issue.blocking && ["architecture", "environment"].includes(issue.kind))) throw new Stop(review.summary);
          await this.integrationRepair(ctx, { report, review }, "修复交付启动问题");
          continue;
        }
        Object.assign(ctx.record, { status: "completed", delivery: delivery.delivery, summary: delivery.summary,
          runtimeCheck: delivery.runtimeCheck ?? null, currentTaskId: null });
        Object.assign(ctx.record.deliveries.at(-1), { status: delivery.delivery === "ready" ? "activated" : "verified",
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
          : error instanceof Stop || error instanceof InputError ? error.message : "研发未完成，检查点已保留，请检查执行环境或模型连接后继续。" });
      await this.save(ctx);
      return clone(ctx.record);
    } finally {
      signal?.removeEventListener("abort", abort);
      for (const handle of [...ctx.handles]) this.dispose(ctx, handle);
      if (this.active.get(agentId) === ctx) this.active.delete(agentId);
      ctx.finish();
    }
  }

  async cancel(id) {
    const ctx = this.active.get(id);
    if (!ctx) return { cancelled: false, development: await this.get(id) };
    ctx.controller.abort();
    await Promise.allSettled([...ctx.handles].map((handle) => handle.session.abort?.()));
    await ctx.done;
    return { cancelled: true, development: await this.get(id) };
  }

  async close() { await Promise.allSettled([...this.active.keys()].map((id) => this.cancel(id))); }
}
