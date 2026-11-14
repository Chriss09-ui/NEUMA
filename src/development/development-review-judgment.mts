import { InputError } from "../requirements/core.mjs";
import { requestJevDecision } from "../requirements/providers.mjs";
import { objectFields } from "../runtime/type-boundary.mjs";
import { hashValue, validateReview } from "./development-contract.mjs";
import { inspectDevelopmentCode } from "./development-workspace.mjs";
import type { DevelopmentReview, DevelopmentPlan } from "../contracts/development.mjs";
import type { DevelopmentController } from "./development.mjs";
import type { DevelopmentContext, DevelopmentEvidence, TaskProgress } from "./development-controller-types.mjs";
import type { DevelopmentSnapshot } from "./development-workspace.mjs";
import { FAILURE_ACCEPTANCE_GUIDE } from "../verification/acceptance-contract.mjs";
import { developmentTestCapabilities } from "./development-test-capabilities.mjs";

interface Assessment { necessity: number; strictness: number; basis: string; route: "pass" | "revise" }
interface Receipt { stateHash: string; attempts: number; formatFailures: number; responses: unknown[]; assessment: Assessment | null }
export interface DevelopmentJudgmentCheckpoint {
  version: 1 | 2; bindingHash: string; original: DevelopmentReview; receipts: Record<string, Receipt>;
  effective: DevelopmentReview | null; hash: string;
}
const rubric = { version: "development-group-jev-v1", necessityAtLeast: 75, strictnessBelow: 50, questions: {
  necessity: { type: "score", instructions: "判断本组这一条阻断意见所要求的最小必要修复。以确认需求、当前研发阶段、实际代码和程序报告为准，评语不是事实。规划检查任务和测试，任务评审只要求当前及已完成任务，整体评审检查完整交付。混合意见只评真实缺陷，不把附带优化算成必改。",
    criteria: ["问题不存在，当前资料已满足要求。", "只有命名、目录、写法或可选优化偏好。", "有改进空间，但不妨碍已确认功能及必要验证。", "具体材料证明需求遗漏、功能错误或必要测试缺口，当前必须修复。", "核心功能缺失、违反硬性约束或已有实际执行失败，必须修复。"] },
  strictness: { type: "score", instructions: "判断打回是否超出已确认需求和当前研发职责。允许功能等价的实现，不强加框架、多层抽象、每个内部函数的独立设计或重复测试。未来任务未实现不构成当前任务缺陷。真实代码和测试问题仍需处理，不能沿用架构阶段免写代码细节的标准。",
    criteria: ["仅针对当前真实缺陷，修复要求适当。", "略保守，但仍是必要修复。", "要求混合真实问题与不必要扩展，应采用最小修复。", "主要是未确认功能、写法偏好、过度设计或重复验证。", "完全基于偏好或未来任务阻拦，当前要求已满足。"] },
  basis: { type: "choice", instructions: "记录材料是否支持本条意见。只记录依据，不另设补查、置信度或暂停出口；合法评分仅产生通过或打回修改。程序实际测试结果保持原状。",
    criteria: { supported: "材料支持意见所述事实。", contradicted: "材料反证全部阻断主张。", unproven: "现有材料不足以确认意见。" } },
} };
const rubrics = { 1: rubric, 2: { ...rubric, version: "development-group-jev-v2", failureAcceptanceGuide: FAILURE_ACCEPTANCE_GUIDE } };

function assess(response: unknown): Assessment {
  const answers = objectFields(objectFields(response).answers);
  const score = (input: unknown) => {
    const raw = objectFields(input), probabilities = objectFields(raw.probabilities);
    if (raw.type !== "score" || typeof raw.score !== "number" || !Number.isFinite(raw.score) || raw.score < 0 || raw.score > 4
      || typeof raw.confidence !== "number" || !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1
      || Object.keys(probabilities).sort().join() !== "0,1,2,3,4"
      || Object.values(probabilities).some(p => typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1)
      || Math.abs(Object.values(probabilities).reduce<number>((sum, p) => sum + Number(p), 0) - 1) > .02
      || Math.abs(Object.entries(probabilities).reduce((sum, [level, p]) => sum + Number(level) * Number(p), 0) - raw.score) > .06)
      throw new InputError("研发 JEV 分数结构无效。");
    return raw.score * 25;
  };
  const necessity = score(answers.necessity), strictness = score(answers.strictness), basis = objectFields(answers.basis), p = objectFields(basis.probabilities);
  if (basis.type !== "choice" || !["supported", "contradicted", "unproven"].includes(String(basis.choice))
    || Object.keys(p).sort().join() !== "contradicted,supported,unproven"
    || Object.values(p).some(p => typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1)
    || Math.abs(Object.values(p).reduce<number>((sum, p) => sum + Number(p), 0) - 1) > .02)
    throw new InputError("研发 JEV 依据判断结构无效。");
  return { necessity, strictness, basis: String(basis.choice), route: necessity >= 75 && strictness < 50 ? "revise" : "pass" };
}
const seal = (value: DevelopmentJudgmentCheckpoint) => {
  const { hash: _hash, ...body } = value;
  value.hash = hashValue(body); return value;
};
export function readDevelopmentJudgment(value: DevelopmentJudgmentCheckpoint) {
  const { hash, ...body } = value;
  if ((value.version !== 1 && value.version !== 2) || hash !== hashValue(body) || !/^[a-f0-9]{64}$/u.test(value.bindingHash)
    || !value.receipts || !value.original || !Array.isArray(value.original.issues)) throw new InputError("研发 JEV 判定记录无效。");
  for (const [id, receipt] of Object.entries(value.receipts)) {
    if (!value.original.issues.some(issue => issue.id === id && issue.blocking)
      || !Number.isSafeInteger(receipt.attempts) || receipt.attempts < 0 || !Array.isArray(receipt.responses)
      || receipt.responses.length > receipt.attempts || !Number.isSafeInteger(receipt.formatFailures) || receipt.formatFailures < 0 || receipt.formatFailures > 3
      || !/^[a-f0-9]{64}$/u.test(receipt.stateHash)
      || receipt.assessment && hashValue(receipt.assessment) !== hashValue(assess(receipt.responses.at(-1))))
      throw new InputError("研发 JEV 的原意见、响应或累计用量无法核验。");
  }
  return value;
}

export async function judgeDevelopmentReview(controller: DevelopmentController, ctx: DevelopmentContext, groupId: string,
  mode: string, original: DevelopmentReview, payload: { plan: DevelopmentPlan; planHash: string; report?: DevelopmentEvidence; task?: TaskProgress | null;
    admissionFacts?: unknown; caseFacts?: unknown },
  snapshot?: DevelopmentSnapshot, scope?: { kind: string; ids: string[] }): Promise<DevelopmentReview> {
  const key = hashValue({ subjectHash: original.subjectHash, original }), saved = ctx.record.reviewJudgments?.[key];
  if (!controller.config?.jevApiKey && !saved) return original;
  const version = saved ? readDevelopmentJudgment(saved).version : 2;
  const selectedRubric = rubrics[version];
  const bindingHash = hashValue({ runId: ctx.record.id, architectureRef: ctx.record.architectureRef, groupId, mode, rubric: selectedRubric,
    subjectHash: original.subjectHash, planHash: payload.planHash, codeHash: snapshot?.hash ?? null, reportId: payload.report?.id ?? null,
    model: controller.config.jevModel || "jev-1.14.0", original });
  const checkpoint = saved ? readDevelopmentJudgment(saved) : seal({ version, bindingHash, original: structuredClone(original), receipts: {}, effective: null, hash: "" });
  if (checkpoint.bindingHash !== bindingHash) throw new InputError("研发 JEV 判定与当前计划、代码或报告不一致，原用量保留。");
  const persist = async () => {
    controller.guard(ctx); (ctx.record.reviewJudgments ??= {})[key] = seal(checkpoint); await controller.save(ctx);
  };
  await persist();
  const code = snapshot && original.issues.some(row => row.blocking)
    ? await inspectDevelopmentCode((await controller.workspace.validateSnapshot(snapshot, ctx.record.agentId)).path) : null;
  for (const issue of original.issues.filter(row => row.blocking)) {
    const taskIds = new Set([...(issue.taskIds ?? []), ...(payload.task ? [payload.task.id] : [])]);
    if (!taskIds.size && scope?.kind === "cases") for (const row of payload.plan.cases)
      if (scope.ids.includes(row.id)) taskIds.add(row.taskId);
    const tasks = payload.plan.tasks.filter(task => taskIds.has(task.id));
    const files = new Set([...(issue.files ?? []), ...tasks.flatMap(task => task.files), ...(scope?.kind === "files" ? scope.ids : [])]);
    if (code && !files.size) for (const file of snapshot!.files) files.add(file.path);
    const caseIds = new Set(payload.plan.cases.filter(row => scope?.kind === "cases" ? scope.ids.includes(row.id)
      : !taskIds.size || taskIds.has(row.taskId)).map(row => row.id));
    const report = payload.report ? { ...payload.report, results: payload.report.results.filter(row => caseIds.has(row.caseId)),
      reportHash: hashValue(payload.report), totalResults: payload.report.results.length,
      resultIndex: payload.report.results.map(row => ({ caseId: row.caseId, status: row.status, reason: row.reason ?? null })) } : null;
    const facts = objectFields(payload.caseFacts);
    const state = { stage: `研发独立评审：${mode}`, groupId, scope: scope ?? { kind: "whole-object", ids: [] }, objection: issue,
      requirements: ctx.record.architecture.requirements, design: ctx.record.architecture.design,
      plan: { ...payload.plan, cases: payload.plan.cases.filter(row => caseIds.has(row.id)) },
      code: code ? [...files].map(path => {
        const content = code.contents.get(path);
        return content ? { path, exists: true, content: content.toString("utf8") }
          : { path, exists: false, notice: "当前快照没有此文件；结合任务阶段判断是否应已实现，缺失事实本身不等于当前任务有错。" };
      }) : [],
      currentTaskId: payload.task?.id ?? null, completedTaskIds: ctx.record.tasks.filter(task => task.status === "verified").map(task => task.id),
      report, runtimeCapabilities: ctx.record.architecture.runtimeCapabilities ?? null,
      ...(version === 2 ? { failureAcceptanceGuide: FAILURE_ACCEPTANCE_GUIDE, testCapabilities: developmentTestCapabilities() } : {}),
      programFacts: { admissionFacts: payload.admissionFacts ?? null, caseFacts: payload.caseFacts ? { ...facts,
        cases: Array.isArray(facts.cases) ? facts.cases.filter(row => caseIds.has(String(objectFields(row).caseId))) : [] } : null },
      routing: { necessityAtLeast: 75, strictnessBelow: 50, otherwise: "pass" },
      instruction: "仅判定本组这一条阻断意见，保留其他组职责。以实际材料判断，不能把评语当需求或把未执行当成功。合法评分只有通过和打回修改；程序测试失败仍由程序拦住。" };
    if (Buffer.byteLength(JSON.stringify(state)) > 128 * 1024)
      throw new InputError("本条研发 JEV 判定所需资料超过容量，原资料未截断；需要缩小具体问题范围。");
    const stateHash = hashValue(state), receipt = checkpoint.receipts[issue.id] ??= { stateHash, attempts: 0, formatFailures: 0, responses: [], assessment: null };
    if (receipt.stateHash !== stateHash) throw new InputError("研发 JEV 评分材料版本不一致。");
    while (!receipt.assessment && receipt.formatFailures < 3) {
      let response: unknown;
      try {
        response = await requestJevDecision({ config: controller.config, state, questions: selectedRubric.questions, signal: ctx.signal,
          onAttempt: async () => { receipt.attempts++; await persist(); } });
      } catch (error) {
        if (objectFields(objectFields(error).diagnostic).reason !== "invalid_json") throw error;
        response = { error: "invalid_json" };
      }
      receipt.responses.push(response);
      try { receipt.assessment = assess(response); }
      catch (error) { if (!(error instanceof InputError)) throw error; receipt.formatFailures++; }
      await persist();
    }
    if (!receipt.assessment) throw Object.assign(new InputError("本组研发 JEV 连续三次返回无效格式，已保存原报告和计数。"),
      { diagnostic: { stage: "development", phase: ctx.record.phase, role: "jev", reason: "review_judgment_format", groupId, issueId: issue.id } });
  }
  const effective = structuredClone(original);
  for (const issue of effective.issues.filter(row => row.blocking)) {
    const decision = checkpoint.receipts[issue.id]!.assessment!;
    if (decision.route === "pass") {
      issue.blocking = false;
      issue.remedy = `本组 JEV 撤销强制修改，作为建议保留（必要分 ${decision.necessity}，过严分 ${decision.strictness}）。原报告与评分留档；不表示代码已修改。`;
    }
  }
  effective.verdict = effective.issues.some(row => row.blocking) ? "revise" : "pass";
  effective.summary = `本组${effective.verdict === "pass" ? "通过" : "需要修改"}；保留 ${effective.issues.filter(row => row.blocking).length} 项必要修改，JEV 原始评分已保存。`;
  validateReview(effective, { subjectHash: original.subjectHash, plan: payload.plan });
  if (checkpoint.effective && hashValue(checkpoint.effective) !== hashValue(effective)) throw new InputError("研发 JEV 保存结论与评分不符。");
  checkpoint.effective = effective; await persist(); return effective;
}
