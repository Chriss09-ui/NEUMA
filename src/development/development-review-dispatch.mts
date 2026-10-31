import type { DevelopmentPlan, DevelopmentReview } from "../contracts/development.mjs";
import { InputError } from "../requirements/core.mjs";
import type { DevelopmentController } from "./development.mjs";
import type { DevelopmentContext, DevelopmentEvidence, TaskProgress } from "./development-controller-types.mjs";
import type { DevelopmentSnapshot } from "./development-workspace.mjs";
import { REVIEW_SCHEMA, hashValue, validateReview } from "./development-contract.mjs";
import { developmentCaseFacts } from "./development-case-facts.mjs";
import { runDevelopmentParts, type DevelopmentPart } from "./development-dispatch.mjs";

interface ReviewPayload { plan: DevelopmentPlan; planHash: string; report?: DevelopmentEvidence; codeHash?: string;
  task?: TaskProgress | null; admissionFacts?: unknown; caseFacts?: unknown }
interface ReviewScope { kind: "requirements" | "cases" | "files" | "interfaces"; ids: string[] }
const chunks = <T,>(rows: T[], size: number) => Array.from({ length: Math.ceil(rows.length / size) }, (_, index) => rows.slice(index * size, index * size + size));

export function shouldDistributeDevelopmentReview(ctx: DevelopmentContext, payload: ReviewPayload, snapshot?: DevelopmentSnapshot) {
  return ctx.record.workloadPolicyVersion === 1 && (ctx.record.architecture.requirements.length > 24
    || payload.plan.tasks.length > 4 || payload.plan.cases.length + (payload.plan.activationCases?.length ?? 0) > 12 || (snapshot?.files.length ?? 0) > 8);
}

export async function reviewDevelopmentParts(controller: DevelopmentController, ctx: DevelopmentContext, mode: string,
  subjectHash: string, payload: ReviewPayload, snapshot?: DevelopmentSnapshot): Promise<DevelopmentReview> {
  const architecture = ctx.record.architecture;
  const taskIds = new Set(ctx.record.tasks.filter(task => task.status === "verified" || task.id === payload.task?.id).map(task => task.id));
  const taskScope = mode === "task" && !payload.task?.integration;
  const allCases = taskScope ? payload.plan.cases.filter(row => taskIds.has(row.taskId)) : [...payload.plan.cases, ...payload.plan.activationCases ?? []];
  const requirementIds = new Set(payload.plan.tasks.filter(task => taskIds.has(task.id)).flatMap(task => task.requirementIds));
  const reviewRequirements = taskScope ? architecture.requirements.filter(row => requirementIds.has(row.id)) : architecture.requirements;
  const scopes: ReviewScope[] = [
    ...chunks(reviewRequirements.map(row => row.id), 24).map(ids => ({ kind: "requirements" as const, ids })),
    ...chunks(allCases.map(row => row.id), 6).map(ids => ({ kind: "cases" as const, ids })),
    ...chunks(snapshot?.files.map(file => file.path) ?? [], 8).map(ids => ({ kind: "files" as const, ids })),
    { kind: "interfaces", ids: [] },
  ];
  const issueLimit = Math.max(1, Math.floor(100 / scopes.length));
  if (scopes.length > 100) throw new InputError("独立评审分组超过可完整保存的容量，不能遗漏范围。");
  const partSchema = structuredClone(REVIEW_SCHEMA);
  partSchema.properties.issues.maxItems = issueLimit;
  const index = { tasks: payload.plan.tasks, entrypoint: payload.plan.entrypoint, runtime: payload.plan.runtime,
    application: payload.plan.application, activationChecks: payload.plan.activationChecks,
    caseIndex: allCases.map(row => ({ id: row.id, taskId: row.taskId, acceptanceId: row.acceptanceId, kind: row.kind ?? "action", actionId: row.actionId })) };
  const parts: DevelopmentPart<DevelopmentReview>[] = scopes.map((scope, number) => {
    const partId = `review_${number}`, partHash = hashValue({ subjectHash, scope });
    const cases = scope.kind === "cases" ? allCases.filter(row => scope.ids.includes(row.id)) : [];
    const requirements = scope.kind === "requirements" ? architecture.requirements.filter(row => scope.ids.includes(row.id)) : [];
    const acceptanceIds = new Set(cases.map(row => row.acceptanceId));
    const selectedReport = payload.report ? { ...payload.report, results: scope.kind === "cases"
      ? payload.report.results.filter(row => scope.ids.includes(row.caseId)) : [],
      resultIndex: payload.report.results.map(row => ({ caseId: row.caseId, status: row.status, reason: row.reason })) } : undefined;
    const measuredPlanFragment = { ...payload.plan, cases: payload.plan.cases.filter(row => scope.ids.includes(row.id)),
      ...(payload.plan.activationCases ? { activationCases: payload.plan.activationCases.filter(row => scope.ids.includes(row.id)) } : {}) };
    return { id: partId, role: "reviewer", schema: partSchema,
      instruction: `这是独立评审分组，mode=${mode}。只负责reviewScope列出的${scope.kind}。requirements组逐条核对需求承接；cases组核对真实输入、断言与报告；files组实际读取指定快照代码；interfaces组核对任务依赖、接口、执行选择和跨组一致性。task模式仅要求当前及已完成任务的实现，未来任务尚未开发不算缺陷。全量原文按需读取fullPlan/fullDesign/fullRequirements/fullReport。最多${issueLimit}条意见，同责任同因问题可合并但必须保留具体依据和全部未解决项。本组通过只表示本组完成，所有分组通过后程序才汇总通过。`,
      payload: { ...controller.base(ctx), mode, subjectHash: partHash, reviewScope: scope, planHash: payload.planHash,
        plan: { ...index, cases, representation: "scoped-view", fullSource: "fullPlan" }, requirements,
        design: scope.kind === "interfaces" ? architecture.design : { execution: architecture.design.execution,
          state: architecture.design.state, interaction: architecture.design.interaction,
          acceptance: architecture.design.acceptance.filter(row => acceptanceIds.has(row.id)
            || scope.kind === "requirements" && row.requirementIds.some(id => scope.ids.includes(id))) },
        ...(selectedReport ? { report: selectedReport } : {}),
        ...(scope.kind === "cases" ? { measuredPlanFragment, caseFacts: {
          ...developmentCaseFacts(measuredPlanFragment, { signal: ctx.signal }), planSource: "measuredPlanFragment", sourcePlanHash: payload.planHash,
          scopeNotice: "planHash绑定本组measuredPlanFragment，sourcePlanHash绑定fullPlan；这里只是子集实测，不能当作全量计划或运行证据。" } } : {}),
        fullPlan: payload.plan, fullDesign: architecture.design, fullRequirements: architecture.requirements,
        ...(payload.report ? { fullReport: payload.report } : {}),
        ...(payload.admissionFacts ? { admissionFacts: payload.admissionFacts } : {}),
      },
      tools: [],
      validate: value => {
        const checked = validateReview(value, { subjectHash: partHash, plan: payload.plan });
        if (checked.issues.length > issueLimit) throw new InputError("评审分组意见超过分配容量，请合并同因问题并保留具体依据。");
        return checked;
      } };
  });
  // Snapshot readers are independently bound and validated on each actual file read.
  if (snapshot) for (const part of parts) part.tools = await controller.workspace.snapshotTools(snapshot, ctx.record.agentId);
  const results = await runDevelopmentParts(controller, ctx, `review_${subjectHash}`, { mode, subjectHash, planHash: payload.planHash,
    codeHash: snapshot?.hash ?? null, reportId: payload.report?.id ?? null }, parts, 6);
  const issues = results.flatMap((result, index) => result.issues.map(issue => ({ ...issue, id: `r${index}_${hashValue(issue.id).slice(0, 20)}` })));
  const verdict = results.some(result => result.verdict === "blocked") ? "blocked" : issues.some(issue => issue.blocking) ? "revise" : "pass";
  return validateReview({ subjectHash, verdict, issues,
    summary: `独立评审完成${results.length}组：${results.filter(result => result.verdict === "pass").length}组通过；${issues.filter(issue => issue.blocking).length}条阻断意见。全部分项及其依据已保存在同一对象的检查点。` }, { subjectHash, plan: payload.plan });
}
