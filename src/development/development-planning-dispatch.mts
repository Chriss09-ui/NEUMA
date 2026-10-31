import type { DevelopmentCase, DevelopmentPlan, FixtureBudget } from "../contracts/development.mjs";
import type { ToolSchema } from "../contracts/tools.mjs";
import type { NeumaTool } from "../runtime/execution-port.mjs";
import { objectFields } from "../runtime/type-boundary.mjs";
import { toolInputValidation } from "../runtime/tool-input-diagnostics.mjs";
import { networkAllowed } from "../runtime/web-capabilities.mjs";
import { InputError } from "../requirements/core.mjs";
import { activationBusinessAcceptanceItems } from "../verification/acceptance-contract.mjs";
import { PLAN_V2_SCHEMA, PLAN_V3_SCHEMA, hashValue, nextReadyDevelopmentTask, validatePlan, validatePlanningFragment } from "./development-contract.mjs";
import { FIXTURE_LIMITS } from "./development-fixtures.mjs";
import type { DevelopmentController } from "./development.mjs";
import type { DevelopmentContext } from "./development-controller-types.mjs";
import { runDevelopmentParts, type DevelopmentPart } from "./development-dispatch.mjs";

interface Assignment { taskId?: string; acceptanceId: string; actionIds: string[] }
interface Outline { plan: Omit<DevelopmentPlan, "cases" | "activationCases" | "activationChecks">;
  actionOwners: { actionId: string; taskId: string; acceptanceId: string }[];
  activationScopes: { acceptanceId: string; executionScope: "isolated" | "shared" }[] }
interface CasePart { cases: DevelopmentCase[]; activationCases: DevelopmentCase[] }
const object = (properties: Record<string, ToolSchema>): ToolSchema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const id: ToolSchema = { type: "string", minLength: 1, maxLength: 80 };
function check(input: unknown, schema: ToolSchema) {
  const result = toolInputValidation(input, schema);
  if (!result.valid) throw new InputError("规划分组结构不符合当前提交契约：" + JSON.stringify(result.issues));
}

export function shouldDistributeDevelopmentPlanning(ctx: DevelopmentContext) {
  return ctx.record.workloadPolicyVersion === 1 && !ctx.record.plan
    && (ctx.record.architecture.requirements.length > 24 || ctx.record.architecture.design.acceptance.length > 10);
}

export function planningResolverTools(controller: DevelopmentController, ctx: DevelopmentContext): NeumaTool[] {
  if (!controller.services || ctx.record.architecture.design.schemaVersion !== 3) return [];
  const tool = (name: string, description: string, parameters: ToolSchema, resolve: (value: Record<string, unknown>) => Promise<unknown>): NeumaTool => ({
    name, label: description, description, parameters, executionMode: "sequential", execute: async (_id, input) => {
      controller.guard(ctx);
      if (!networkAllowed(ctx.record.architecture.draft)) throw new InputError("当前需求禁止联网，不能核实未缓存的依赖或镜像");
      const result = await resolve(objectFields(input)); controller.guard(ctx);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
    } });
  return [tool("resolve_service_dependencies", "核实服务依赖的固定版本与真实工件", object({ packages: { type: "array", maxItems: 40,
    items: object({ name: { type: "string" }, version: { type: "string" } }) } }), value => controller.services!.resolveDependencies({
      language: ctx.record.architecture.design.execution!.language, host: ctx.record.architecture.design.execution!.hosting,
      packages: value.packages, signal: ctx.signal })),
    tool("resolve_service_image", "核实官方容器镜像摘要", object({ image: { type: "string" } }), value =>
      controller.services!.resolveDockerImage({ image: value.image, signal: ctx.signal }))];
}

function outlineSchema(schema: ToolSchema) {
  const plan = structuredClone(schema);
  for (const key of ["cases", "activationCases", "activationChecks"]) delete plan.properties![key];
  plan.required = plan.required!.filter(key => !["cases", "activationCases", "activationChecks"].includes(key));
  plan.properties!.tasks!.items!.properties!.requirementIds!.maxItems = 24;
  plan.properties!.tasks!.items!.properties!.acceptanceIds!.maxItems = 6;
  plan.properties!.tasks!.items!.properties!.description!.maxLength = 1200;
  return object({ plan, actionOwners: { type: "array", maxItems: 82, items: object({ actionId: id, taskId: id, acceptanceId: id }) },
    activationScopes: { type: "array", maxItems: 80, items: object({ acceptanceId: id, executionScope: { type: "string", enum: ["isolated", "shared"] } }) } });
}

function caseGroups(outline: Outline) {
  const jobs: Assignment[] = outline.plan.tasks.flatMap(task => task.acceptanceIds.flatMap(acceptanceId => {
    const actions = outline.actionOwners.filter(owner => owner.taskId === task.id && owner.acceptanceId === acceptanceId).map(owner => owner.actionId);
    return Array.from({ length: Math.max(1, Math.ceil(actions.length / 4)) }, (_, index) => ({ taskId: task.id, acceptanceId, actionIds: actions.slice(index * 4, index * 4 + 4) }));
  }));
  const groups: { assignments: Assignment[]; activation: boolean; minimum: number; capacity: number }[] = [];
  for (const job of jobs) {
    const weight = Math.max(1, job.actionIds.length), previous = groups.at(-1);
    if (previous && previous.assignments.length < 4 && previous.minimum + weight <= 12) {
      previous.assignments.push(job); previous.minimum += weight; previous.capacity += weight;
    } else groups.push({ assignments: [job], activation: false, minimum: weight, capacity: weight });
  }
  for (const scope of outline.activationScopes) groups.push({ assignments: [{ acceptanceId: scope.acceptanceId, actionIds: [] }], activation: true, minimum: 1, capacity: 1 });
  let remaining = 200 - groups.reduce((sum, group) => sum + group.minimum, 0);
  if (!groups.length || remaining < 0) throw new InputError("任务验收组合与动作覆盖至少需要超过200例，请在骨架阶段合并重复责任分配。");
  while (remaining > 0) {
    let assigned = false;
    for (const group of groups) if (remaining && group.capacity < 12) { group.capacity++; remaining--; assigned = true; }
    if (!assigned) break;
  }
  return groups;
}

export async function planDevelopmentParts(controller: DevelopmentController, ctx: DevelopmentContext) {
  const architecture = ctx.record.architecture, planSchema = architecture.design.schemaVersion === 3 ? PLAN_V3_SCHEMA : PLAN_V2_SCHEMA;
  const schema = outlineSchema(planSchema), activation = activationBusinessAcceptanceItems(architecture);
  const validateOutline = (input: unknown): Outline => {
    check(input, schema);
    const outline = input as Outline;
    if (Buffer.byteLength(JSON.stringify(outline)) > 1024 * 1024) throw new InputError("规划骨架超过1 MiB，请缩小重复说明。");
    const plan = validatePlanningFragment({ ...outline.plan, cases: [] }, { architecture });
    if (new Set(plan.tasks.flatMap(task => task.files)).size > 200) throw new InputError("任务授权文件合计不能超过200个。");
    const requiredActions = [...plan.application!.actions.map(action => action.id), ...Object.values(plan.application!.service?.migration ?? {})
      .filter((value): value is string => typeof value === "string")];
    if (new Set(outline.actionOwners.map(owner => owner.actionId)).size !== outline.actionOwners.length
      || hashValue(outline.actionOwners.map(owner => owner.actionId).sort()) !== hashValue([...new Set(requiredActions)].sort()))
      throw new InputError("每个公开动作及迁移/验证动作必须恰有一项研发任务与验收归属。");
    for (const owner of outline.actionOwners) {
      const task = plan.tasks.find(task => task.id === owner.taskId), acceptance = architecture.design.acceptance.find(item => item.id === owner.acceptanceId);
      if (!task?.acceptanceIds.includes(owner.acceptanceId) || acceptance?.verification && acceptance.verification.adapterId !== "action")
        throw new InputError("动作必须分配给负责真实action验收的任务组合。");
    }
    if (new Set(outline.activationScopes.map(row => row.acceptanceId)).size !== outline.activationScopes.length
      || hashValue(outline.activationScopes.map(row => row.acceptanceId).sort()) !== hashValue(activation.map(row => row.id).sort()))
      throw new InputError("启用前验证作用域必须完整且仅覆盖原host-business验收。");
    const pending = plan.tasks.map(task => ({ ...task, status: "pending" })), available = new Set<string>();
    for (let index = 0; index < pending.length; index++) {
      const task = nextReadyDevelopmentTask(pending)!; task.files.forEach(file => available.add(file));
      if (task.acceptanceIds.some(id => !["input-contract", "page-resources"].includes(architecture.design.acceptance.find(row => row.id === id)?.verification?.adapterId ?? "action"))
        && !available.has(plan.entrypoint)) throw new InputError(`任务${task.id}需要执行代码，入口必须包含在当前或已完成任务的文件授权中。`);
      task.status = "verified";
    }
    caseGroups(outline);
    return structuredClone(outline);
  };
  const binding = { runId: ctx.record.id, architectureHash: hashValue(architecture), kind: "initial_planning" };
  const [outline] = await runDevelopmentParts(controller, ctx, "planning_outline", binding, [{ id: "outline", role: "planner", schema,
    instruction: "仅规划全局接口和可运行任务骨架，不写用例或文件。plan不能包含cases、activationCases或activationChecks。每任务最多24条需求、6项验收；按模块拆分。actionOwners为每个公开动作和迁移/验证动作指定taskId与acceptanceId。activationScopes逐项声明真实启用验收的isolated/shared范围。用例交由后续独立Agent设计。直接调用submit_development_plan_part提交。",
    payload: { ...controller.base(ctx), planSchema: schema }, tools: planningResolverTools(controller, ctx), allowBlocker: true, validate: validateOutline }], 12);
  const groups = caseGroups(outline!), outlineHash = hashValue(outline);
  const parts: DevelopmentPart<CasePart>[] = groups.map((group, index) => {
    const partId = `cases_${index}`, prefix = `g${index}_`, caseSchema = structuredClone(planSchema.properties.cases.items!);
    const activationSchema = structuredClone(planSchema.properties.activationCases?.items ?? caseSchema);
    for (const current of [caseSchema, activationSchema]) current.properties!.id = { type: "string", pattern: `^${prefix}[A-Za-z0-9_-]{1,60}$` };
    const partSchema = object({ cases: { type: "array", minItems: group.activation ? 0 : group.minimum,
      maxItems: group.activation ? 0 : group.capacity, items: caseSchema },
      activationCases: { type: "array", minItems: group.activation ? 1 : 0, maxItems: group.activation ? group.capacity : 0, items: activationSchema } });
    const requirementIds = new Set(group.assignments.flatMap(row => architecture.design.acceptance.find(item => item.id === row.acceptanceId)!.requirementIds));
    const expandedBytes = Math.floor(FIXTURE_LIMITS.planBytes * group.capacity / 200), materialBytes = Math.floor(8 * 1024 * 1024 * group.capacity / 200);
    return { id: partId, role: "planner", schema: partSchema,
      instruction: `只设计caseAssignments中的冻结用例，最多${group.capacity}例；id使用${prefix}前缀。每项任务/验收组合必须有对应实际用例，指定actionIds各至少一次真实action执行；不能用入口拒绝代替。激活专用组仅返回activationCases，其他组仅返回cases。共享序列在本组按业务顺序提交。完整契约和夹具仍适用，直接提交分项，不写文件、不修改骨架。`,
      payload: { ...controller.base(ctx), requirements: architecture.requirements.filter(item => requirementIds.has(item.id)),
        design: { ...architecture.design, acceptance: architecture.design.acceptance.filter(item => group.assignments.some(row => row.acceptanceId === item.id)) },
        plan: outline!.plan, fullRequirements: architecture.requirements, fullDesign: architecture.design,
        caseAssignments: { rows: group.assignments, activation: group.activation, capacity: group.capacity, expandedBytes, materialBytes },
        planSchema: partSchema },
      validate: input => {
        check(input, partSchema); const part = input as CasePart, rows = [...part.cases, ...part.activationCases];
        if (Buffer.byteLength(JSON.stringify(part)) > materialBytes) throw new InputError("本组用例材料超过分配容量，请使用声明式夹具减少重复文本。");
        for (const row of rows) if (!group.assignments.some(item => item.acceptanceId === row.acceptanceId && (group.activation || item.taskId === row.taskId)))
          throw new InputError("用例超出本组任务/验收归属。");
        for (const item of group.assignments) {
          const owned = rows.filter(row => row.acceptanceId === item.acceptanceId && (group.activation || row.taskId === item.taskId));
          if (!owned.length || item.actionIds.some(id => !owned.some(row => row.actionId === id && (row.kind ?? "action") === "action")))
            throw new InputError("本组缺少已分派的验收组合或动作实际执行用例。");
        }
        const budget: FixtureBudget = { bytes: 0 };
        validatePlanningFragment({ ...outline!.plan, cases: part.cases, ...(part.activationCases.length ? { activationCases: part.activationCases } : {}) }, { architecture, freshWorkspace: true }, budget);
        if ((budget.bytes ?? 0) > expandedBytes || (budget.textBytes ?? 0) > expandedBytes)
          throw new InputError("本组夹具展开或文本工作量超过分配容量，请保留业务边界并减少重复样本。");
        return structuredClone(part);
      } };
  });
  const assemble = (results: CasePart[]) => {
    const cases = results.flatMap(part => part.cases), activationCases = results.flatMap(part => part.activationCases);
    return validatePlan({ ...outline!.plan, cases, ...(activationCases.length ? { activationCases,
      activationChecks: outline!.activationScopes.map(scope => ({ ...scope, caseIds: activationCases.filter(test => test.acceptanceId === scope.acceptanceId).map(test => test.id) })) } : {}) }, { architecture, freshWorkspace: true });
  };
  const results = await runDevelopmentParts(controller, ctx, `planning_cases_${outlineHash}`, { ...binding, outlineHash }, parts, 8, assemble);
  const candidate = assemble(results);
  const saved = await controller.artifacts.saveRepairCandidate(ctx.record.agentId, ctx.record.id, candidate, { signal: ctx.signal });
  if (hashValue(saved.plan) !== hashValue(candidate)) throw new InputError("分组规划合并材料与候选不一致。");
  ctx.record.planningArtifact = saved.snapshot;
  ctx.record.pendingPlan = { plan: candidate, planHash: hashValue(candidate) };
  await controller.save(ctx);
  return candidate;
}
