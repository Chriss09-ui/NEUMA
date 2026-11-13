import type { ReviewParts, ArchitectureReview } from "../contracts/architecture.mjs";
import type { ModelConfig } from "../contracts/model.mjs";
import type { UnknownRecord } from "../contracts/json.mjs";
import type { ReviewDiagnostic } from "../contracts/architecture.mjs";
import { InputError } from "../requirements/core.mjs";
import { requestJevDecision } from "../requirements/providers.mjs";
import { objectFields } from "../runtime/type-boundary.mjs";
import { modelContextValue } from "../runtime/model-context.mjs";
import { repairHash } from "../runtime/repair-scheduler.mjs";
import { ARCHITECTURE_JEV_SCOPE } from "./architecture-prompts.mjs";

export interface JudgmentGroup { id: string; assignment: { field: string; ids: string[] }; parts: ReviewParts }
interface Score { score: number; probabilities: Record<string, number>; confidence: number }
interface Assessment { necessity: Score; strictness: Score; basis: string; route: "revise" | "pass" | "waive" | "suggestion" | "recheck" }
interface Objection { key: string; field: keyof Omit<ReviewParts, "candidateHash">; index: number; value: unknown }
interface Receipt { stateHash: string; attempts: number; response: unknown; responses: unknown[]; assessment: Assessment | null; formatFailures: number }
interface JudgmentRound { parts: ReviewParts; receipts: Record<string, Receipt> }
interface GroupCheckpoint { sourceHash: string; rounds: JudgmentRound[]; recheckCalls: number; recheckRejection?: ReviewDiagnostic["repeatedFailure"]; recheckSession?: string }
type PolicyVersion = 1 | 2 | 3;
export interface ReviewJudgmentCheckpoint { version: PolicyVersion; bindingHash: string; candidateHash: string; completedReviewHash: string | null;
  groups: Record<string, GroupCheckpoint>; previousPolicy?: ReviewJudgmentCheckpoint; hash: string }

// Frozen only for validating existing receipts; new requests use the stage-scoped rubric below.
const legacyRubric = {
  version: "group-jev-v1",
  questions: {
    necessity: { type: "score", instructions: "评估这一条意见所要求的当前架构整改的必要性。以已确认需求、当前阶段、原文及程序计算事实为准；评审意见不是事实。多项主张混在一起时，按仍成立的最重要缺陷判断，不能因其中一项错误而撤销其余真实缺陷。后续代码和真实验证未完成不等于当前架构有错。",
      criteria: ["原文已经满足要求，或者意见所指问题不存在。", "只是命名、表达、风格或可选优化，不影响已确认需求。", "有局部改进空间，但当前方案仍能实现和验证已确认需求。", "存在有具体原文依据的当前缺口，会使某项已确认需求无法实现或验证，必须修改。", "核心任务缺失或设计直接违背已确认的硬性要求，当前方案必然无法完成该任务。"] },
    strictness: { type: "score", instructions: "评估这条打回要求是否超出用户确认的需求及当前架构阶段。不要因证据缺失就认定评审过严。不要把程序已经确认的真实缺陷当作过严。允许功能等价的设计；后续实施验证已有明确责任和路径时，不要求现在提供实施完成证据。",
      criteria: ["打回针对当前必须满足的要求，范围及要求适当。", "要求略保守，但仍针对当前必须满足的要求。", "意见混合必要检查和额外要求，尚不能整体撤销。", "主要强加未确认要求、个人实现偏好，或要求提前完成已有安排的后续验证。", "完全依据个人偏好或完美化标准阻拦，当前明确需求已经满足。"] },
    basis: { type: "choice", instructions: "原文和程序事实是否足以判断本条意见？遇到一条意见混合多个主张，只有所有阻塞主张都被反证才能选contradicted；缺资料、长文截断或无法核对时选unproven。",
      criteria: { supported: "材料足够，意见所述事实成立；严重程度和是否需要现在改由另两项评分判断。",
        contradicted: "材料足够，意见的全部阻塞主张都与原文或程序事实相矛盾。", unproven: "材料不足、主张含混或相互冲突，尚不能决定放行或打回。" } },
  },
};
const stageRubric = {
  version: "group-jev-v2",
  scope: ARCHITECTURE_JEV_SCOPE,
  questions: {
    necessity: { type: "score", instructions: "评估这一条意见要求当前架构整改的必要性。只根据已确认需求、总体可行性、关键业务职责与输入输出判断；当前仅需总体方案。函数名、内部调用、开发任务和可执行测试材料由研发设计，不因未写这些细节给高分。混合意见只评真实架构缺陷的必要性，不把额外要求算作必须整改。",
      criteria: ["原文已经满足要求，或意见所指问题不存在。", "只有实现细节、研发测试材料、重复验收或个人偏好方面的要求，不影响总体方案。", "有局部改进空间，但当前总体方案可交研发继续实施。", "具体原文证明需求遗漏、关键可行性障碍或业务职责和输入输出矛盾，影响某项已确认需求，当前必须整改。", "核心任务缺失或直接违背用户硬性要求，当前总体方案必然无法完成任务。"] },
    strictness: { type: "score", instructions: "评估打回是否越过架构职责。只要求总体做法、关键业务配合、主要失败响应及业务验证方向；不要求逐节点研发设计和完整回归。已有场景覆盖同一要求即可复用。真实架构障碍仍须处理，但不能附带强制研发细节。",
      criteria: ["要求针对当前真实架构缺陷，整改范围必要且适当。", "稍保守，仍针对当前必要的架构修改。", "混合真实架构缺陷和额外要求，应仅保留真实缺陷的最小整改。", "主要强加内部实现、逐节点开发、可执行测试材料或重复验证，超出架构职责。", "完全依据开发细节、偏好或完美化标准阻拦，当前总体方案已满足需求。"] },
    basis: { type: "choice", instructions: "核对本条意见陈述的事实是否有原文依据。没写研发细节可以是事实，supported仅确认事实，不能因此认定架构必须整改；由必要性和过严度判断。材料已足以区分阶段职责时，不因缺少后续研发产物选unproven。混合主张分别核对，确有影响总体判断的材料缺口才选unproven。",
      criteria: { supported: "材料足够，意见陈述的事实成立；是否应在当前阶段整改另行评分。",
        contradicted: "材料足够，意见的全部阻塞主张与原文或程序事实相矛盾。", unproven: "影响总体判断的关键事实缺失、含混或相互冲突，需核实。" } },
  },
};
const routing = { reviseNecessityAtLeast: 75, reviseStrictnessBelow: 50,
  instruction: "合法评分只产生打回或通过。必要分至少75且过严分低于50时交回设计修改，再评审；其余通过，可保留非阻塞建议。依据判断、置信度和分歧只记录，不另设补查或暂停。" };
const rubric = { ...stageRubric, version: "group-jev-v3", routing,
  questions: { ...stageRubric.questions, basis: { ...stageRubric.questions.basis,
    instructions: stageRubric.questions.basis.instructions + " 此项只记录依据状态，不单独触发补查或暂停；影响当前总体方案的真实缺口计入必要性评分。" } } };
const rubrics = { 1: legacyRubric, 2: stageRubric, 3: rubric };
const rows = (value: unknown): UnknownRecord[] => Array.isArray(value) ? value.map(objectFields) : [];
const seal = (value: Omit<ReviewJudgmentCheckpoint, "hash">): ReviewJudgmentCheckpoint => ({ ...value, hash: repairHash(value) });
function stop(reason: string, message: string, details: UnknownRecord = {}): never {
  throw Object.assign(new InputError(message), { diagnostic: { stage: "architecture", role: "reviewer", phase: "evaluating", reason, ...details } });
}

export function architectureGroupJevEnabled(config: ModelConfig) {
  return typeof config.jevApiKey === "string" && Boolean(config.jevApiKey.trim());
}

export function judgmentApprovesReview(record: unknown, review: unknown): boolean {
  const source = objectFields(record), value = objectFields(source.reviewJudgmentCheckpoint), { hash, ...body } = value;
  return (value.version === 1 || value.version === 2 || value.version === 3) && value.candidateHash === source.candidateHash && hash === repairHash(body)
    && value.completedReviewHash === repairHash(review) && objectFields(review).verdict === "pass";
}

function score(value: unknown): Score {
  const answer = objectFields(value), probabilities = objectFields(answer.probabilities);
  if (answer.type !== "score" || Object.keys(probabilities).sort().join() !== "0,1,2,3,4"
    || Object.values(probabilities).some(p => typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1)
    || typeof answer.score !== "number" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > 4
    || typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1)
    throw new InputError("JEV 分数结构无效。");
  const p = probabilities as Record<string, number>;
  if (Math.abs(Object.values(p).reduce((a, b) => a + b, 0) - 1) > .02
    || Math.abs(Object.entries(p).reduce((sum, [level, probability]) => sum + Number(level) * probability, 0) - answer.score) > .06)
    throw new InputError("JEV 分数与概率不一致。");
  return { score: answer.score * 25, probabilities: p, confidence: answer.confidence };
}

function assess(response: unknown, version: PolicyVersion): Assessment {
  const answers = objectFields(objectFields(response).answers), necessity = score(answers.necessity), strictness = score(answers.strictness);
  const basis = objectFields(answers.basis), p = objectFields(basis.probabilities);
  if (basis.type !== "choice" || !["supported", "contradicted", "unproven"].includes(String(basis.choice))
    || Object.keys(p).sort().join() !== "contradicted,supported,unproven"
    || Object.values(p).some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
    || Math.abs(Object.values(p).reduce<number>((sum, value) => sum + Number(value), 0) - 1) > .02)
    throw new InputError("JEV 依据判断结构无效。");
  if (version === 3) return { necessity, strictness, basis: String(basis.choice),
    route: necessity.score >= routing.reviseNecessityAtLeast && strictness.score < routing.reviseStrictnessBelow ? "revise" : "pass" };
  // Kept only to verify historical receipts. Current decisions never enter this branch.
  let route: Assessment["route"] = "recheck";
  const split = [necessity, strictness].some(a => a.probabilities["0"]! + a.probabilities["1"]! >= .25
    && a.probabilities["3"]! + a.probabilities["4"]! >= .25);
  if (!split && Number(p[String(basis.choice)]) >= .75 && basis.choice !== "unproven") {
    if (basis.choice === "contradicted" && necessity.score < 60) route = "waive";
    else if (basis.choice === "supported" && necessity.score >= 75 && strictness.score < 50) route = "revise";
    else if (strictness.score >= 75 && necessity.score < 75) route = "waive";
    else if (necessity.score < 60) route = "suggestion";
  }
  return { necessity, strictness, basis: String(basis.choice), route };
}

function scopeIssues(parts: ReviewParts, id: unknown, context: unknown) {
  const index = rows(objectFields(objectFields(context).candidate).acceptance).findIndex(row => row.id === id);
  const path = `/acceptance/${index}`;
  return index < 0 ? [] : parts.issues.filter(issue => issue.blocking && issue.checkId === "acceptance_quality"
    && issue.candidatePaths?.some(p => p === path || p.startsWith(path + "/")));
}

function objections(parts: ReviewParts, context: unknown): Objection[] {
  return (Object.keys(parts) as (keyof ReviewParts)[]).flatMap(field => {
    if (field === "candidateHash") return [];
    return parts[field].flatMap((row, index) => {
      const item = objectFields(row), blocking = field === "checks" ? !item.passed : field === "issues" ? item.blocking
        : field === "acceptanceScopeChecks" ? !item.sufficient : !["resolved", "unsupported"].includes(String(item.status));
      // A theme flag is the roll-up of its concrete objections, not another vote on the same defect.
      if (field === "checks" && parts.issues.some(issue => issue.blocking && issue.checkId === item.id)
        || field === "acceptanceScopeChecks" && scopeIssues(parts, item.acceptanceId, context).length) return [];
      return blocking ? [{ key: `${field}/${index}`, field, index, value: structuredClone(row) }] : [];
    });
  });
}

function arithmeticFacts(candidate: unknown) {
  return rows(objectFields(candidate).acceptance).flatMap((test, index) => {
    if (typeof test.input !== "string") return [];
    let input: unknown;
    try { input = JSON.parse(test.input); } catch { return []; }
    return Object.entries(objectFields(input)).flatMap(([key, value]) => {
      if (!Array.isArray(value) || !value.length || value.some(n => typeof n !== "number" || !Number.isSafeInteger(n))) return [];
      const values = value as number[], exactSum = values.reduce((a, b) => a + BigInt(b), 0n);
      if (exactSum < BigInt(Number.MIN_SAFE_INTEGER) || exactSum > BigInt(Number.MAX_SAFE_INTEGER)) return [];
      const sum = Number(exactSum);
      return [{ source: "candidate", path: `/acceptance/${index}/input`, field: key, count: values.length, sum,
        min: Math.min(...values), max: Math.max(...values), instruction: "仅陈述此输入数组的计算事实，不替代业务需求或证明整个用例通过。" }];
    });
  });
}

function judgmentState(group: JudgmentGroup, objection: Objection, context: unknown, priorFindings: unknown, version: PolicyVersion) {
  const source = objectFields(context), candidate = objectFields(source.candidate), value = objectFields(objection.value);
  const paths = new Map<string, { source: string; path: string }>();
  const add = (source: string, path: string) => paths.set(`${source}:${path}`, { source, path });
  const relatedIssues = version < 3 ? group.parts.issues : objection.field === "issues" ? [group.parts.issues[objection.index]!] : group.parts.issues;
  for (const row of relatedIssues) {
    for (const path of row.candidatePaths ?? []) add("candidate", path);
    for (const ref of row.references ?? []) add(ref.source, ref.path);
    for (const fact of row.factClaims ?? []) add(fact.source, fact.path);
  }
  if (objection.field === "acceptanceScopeChecks") {
    const index = rows(candidate.acceptance).findIndex(row => row.id === value.acceptanceId);
    if (index >= 0) add("candidate", `/acceptance/${index}`);
    if (typeof value.adapterRulePath === "string") add("acceptanceAdapterGuide", value.adapterRulePath);
  }
  if (objection.field === "priorFindingDecisions") for (const path of Array.isArray(value.candidatePaths) ? value.candidatePaths : [])
    if (typeof path === "string") add("candidate", path);
  // Theme checks need their actual design sections, including positive evidence omitted by an objection.
  if (objection.field === "checks") {
    const sections: Record<string, string[]> = { requirements: ["coverage", "components"], requirement_sufficiency: ["coverage", "unknowns"],
      feasibility: ["capabilities", "execution", "decisions"], minimality: ["components", "steps"],
      interfaces: ["components", "steps", "interaction"], failure_handling: ["failureHandling", "steps"],
      verification: ["acceptance"], acceptance_quality: ["acceptance"] };
    for (const section of sections[String(value.id)] ?? ["components", "steps"]) if (Object.hasOwn(candidate, section)) add("candidate", `/${section}`);
  }
  if (version === 3) {
    const sections: Record<string, string[]> = { requirements: ["coverage", "components", "interaction"], requirement_sufficiency: ["coverage", "unknowns", "selectionBasis"],
      feasibility: ["capabilities", "execution", "decisions", "platformClaims"], minimality: ["components", "steps"],
      interfaces: ["components", "steps", "interaction", "failureHandling"], failure_handling: ["components", "failureHandling", "steps"],
      verification: ["acceptance", "components", "steps"], acceptance_quality: ["acceptance", "components", "steps"] };
    const themes = objection.field === "checks" ? [value.id] : objection.field === "issues" ? [value.checkId]
      : objection.field === "acceptanceScopeChecks" ? ["acceptance_quality"] : Array.isArray(value.checkIds) ? value.checkIds : [];
    for (const theme of themes) for (const section of sections[String(theme)] ?? ["components", "steps"])
      if (Object.hasOwn(candidate, section)) add("candidate", `/${section}`);
  }
  const selected = [...paths.values()].filter(ref => version < 3 || ![...paths.values()].some(parent => parent.source === ref.source
    && parent.path !== ref.path && (parent.path === "" || ref.path.startsWith(parent.path + "/"))));
  const materials = selected.map(ref => {
    const text = modelContextValue(source, ref.source, ref.path);
    if (text === undefined) stop("review_judgment_material_missing", "JEV 所需的原文位置无法读取。", { groupId: group.id, ...ref });
    return { ...ref, value: text };
  });
  const state = { stage: "架构设计的独立评审；代码实施和实际运行验收尚在后续阶段", groupId: group.id, assignment: group.assignment,
    objection: objection.value, requirements: source.requirements, materials, confirmedRequirementContext: source.confirmedRequirementContext,
    deferredVerifications: source.deferredVerifications, priorFindings: objection.field === "priorFindingDecisions" ? priorFindings : null,
    acceptanceIndex: rows(candidate.acceptance).map(row => ({ id: row.id, requirementIds: row.requirementIds, input: row.input, expected: row.expected })),
    programFacts: arithmeticFacts(candidate), instruction: "只决定本组这一条意见是否应阻塞当前架构；其他组没有被授权通过。不要把评审意见当原始需求；不要假设本次资料中未出现的事实。",
    ...(version === 1 ? {} : { architectureScope: ARCHITECTURE_JEV_SCOPE }), ...(version === 3 ? { routing } : {}) };
  if (Buffer.byteLength(JSON.stringify(state)) > 128 * 1024)
    stop("review_judgment_material_capacity", "这一条争议所需原文过多，需要缩小问题范围；未截断材料或自动放行。", { groupId: group.id, objection: objection.key });
  return state;
}

export async function judgeArchitectureReviewGroups(options: { config: ModelConfig; candidateHash: string; context: unknown; priorFindings?: unknown;
  groups: JudgmentGroup[]; checkpoint?: unknown; signal?: AbortSignal | undefined; save(value: ReviewJudgmentCheckpoint): Promise<void>;
  validate(group: JudgmentGroup, parts: ReviewParts, derived?: boolean): ReviewParts;
  request?: typeof requestJevDecision }) {
  const { groups, signal } = options, model = options.config.jevModel || "jev-1.14.0";
  const binding = (version: PolicyVersion) => repairHash({ candidateHash: options.candidateHash, context: options.context,
    priorFindings: options.priorFindings ?? null, groups, rubric: rubrics[version], model });
  const read = (input: unknown): ReviewJudgmentCheckpoint => {
    const saved = objectFields(input), { hash, ...body } = saved;
    const keys = ["bindingHash", "candidateHash", "completedReviewHash", "groups", "hash", "version",
      ...((saved.version === 2 || saved.version === 3) && saved.previousPolicy !== undefined ? ["previousPolicy"] : [])].sort().join();
    if ((saved.version !== 1 && saved.version !== 2 && saved.version !== 3) || saved.bindingHash !== binding(saved.version as PolicyVersion)
      || saved.candidateHash !== options.candidateHash || hash !== repairHash(body) || Object.keys(saved).sort().join() !== keys
      || !saved.groups || typeof saved.groups !== "object" || Array.isArray(saved.groups))
      stop("review_judgment_binding", "JEV 原判定与候选、分组、模型或评分规则不符；不能清零后重跑。");
    return structuredClone(saved) as unknown as ReviewJudgmentCheckpoint;
  };
  const roundVersion = (value: ReviewJudgmentCheckpoint, id: string, index: number): PolicyVersion =>
    value.previousPolicy && index < (value.previousPolicy.groups[id]?.rounds.length ?? 1) - 1
      ? roundVersion(value.previousPolicy, id, index) : value.version;
  const verifyGroups = (value: ReviewJudgmentCheckpoint) => {
    for (const [id, saved] of Object.entries(value.groups)) {
      const group = groups.find(group => group.id === id);
      if (!group || saved.sourceHash !== repairHash(group) || !Number.isSafeInteger(saved.recheckCalls) || saved.recheckCalls < 0
        || !Array.isArray(saved.rounds) || saved.rounds.length < 1 || saved.rounds.length > 2
        || repairHash(saved.rounds[0]!.parts) !== repairHash(group.parts))
        stop("review_judgment_binding", "JEV 小组原报告或累计用量无法核验。");
      for (const [index, round] of saved.rounds.entries()) {
        options.validate(group, round.parts);
        const pending = objections(round.parts, options.context);
        if (!round.receipts || Array.isArray(round.receipts)) stop("review_judgment_binding", "JEV 判定回执缺失。");
        const version = roundVersion(value, id, index);
        for (const [key, receipt] of Object.entries(round.receipts)) {
          const item = pending.find(item => item.key === key);
          if (!item || receipt.stateHash !== repairHash(judgmentState({ ...group, parts: round.parts }, item, options.context, options.priorFindings, version))
            || !Number.isSafeInteger(receipt.attempts) || receipt.attempts < 0 || !Array.isArray(receipt.responses)
            || receipt.responses.length > receipt.attempts || !Number.isSafeInteger(receipt.formatFailures)
            || receipt.formatFailures < 0 || receipt.formatFailures > 3
            || repairHash(receipt.response) !== repairHash(receipt.responses.at(-1) ?? null))
            stop("review_judgment_binding", "JEV 原始材料或请求计数无法核验。");
          if (receipt.assessment) {
            let expected: Assessment;
            try { expected = assess(receipt.response, version); } catch { stop("review_judgment_binding", "JEV 保存的评分结构无效。"); }
            if (repairHash(expected!) !== repairHash(receipt.assessment)) stop("review_judgment_binding", "JEV 判定与保存的响应不一致。");
          }
        }
        if (value.completedReviewHash !== null && index === saved.rounds.length - 1
          && pending.some(item => !round.receipts[item.key]?.assessment)) stop("review_judgment_binding", "已完成判定缺少正式评分。");
      }
    }
    if (value.completedReviewHash !== null && groups.some(group => !value.groups[group.id]))
      stop("review_judgment_binding", "已完成判定缺少小组结果。");
  };
  const verifyHistory = (checkpoint: ReviewJudgmentCheckpoint) => {
    if (checkpoint.previousPolicy) {
      const previous = read(checkpoint.previousPolicy);
      if (previous.version >= checkpoint.version || previous.completedReviewHash !== null)
        stop("review_judgment_binding", "评分规则升级来源不是旧版未完成判定。");
      verifyHistory(previous);
      for (const [id, old] of Object.entries(previous.groups)) {
        const current = checkpoint.groups[id];
        if (!current || current.recheckCalls < old.recheckCalls || current.recheckSession !== old.recheckSession && old.recheckSession
          || current.rounds.length < old.rounds.length) stop("review_judgment_binding", "评分规则升级丢失原补查或会话。");
        for (const [index, round] of old.rounds.entries()) {
          const next = current.rounds[index]!;
          if (repairHash(next.parts) !== repairHash(round.parts)
            || index < old.rounds.length - 1 && repairHash(next) !== repairHash(round))
            stop("review_judgment_binding", "评分规则升级改写了原报告或历史评分。");
          for (const [key, receipt] of Object.entries(round.receipts)) {
            const updated = next.receipts[key];
            if (!updated || updated.attempts < receipt.attempts || updated.formatFailures < receipt.formatFailures
              || repairHash(updated.responses.slice(0, receipt.responses.length)) !== repairHash(receipt.responses)
              || index === old.rounds.length - 1 && updated.assessment && updated.responses.length === receipt.responses.length)
              stop("review_judgment_binding", "评分规则升级丢失原用量或复用了旧规则评分。");
          }
        }
      }
    }
    verifyGroups(checkpoint);
  };
  let checkpoint = options.checkpoint === undefined
    ? seal({ version: 3, bindingHash: binding(3), candidateHash: options.candidateHash, completedReviewHash: null, groups: {} })
    : read(options.checkpoint);
  verifyHistory(checkpoint);
  const migrated = checkpoint.version < 3 && checkpoint.completedReviewHash === null;
  if (migrated) {
    const previousPolicy = structuredClone(checkpoint);
    // Preserve all reports, sessions and cumulative counters; only the latest report needs the new judgment.
    for (const group of groups) {
      const round = checkpoint.groups[group.id]?.rounds.at(-1);
      if (!round) continue;
      for (const item of objections(round.parts, options.context)) {
        const receipt = round.receipts[item.key];
        if (!receipt) continue;
        receipt.stateHash = repairHash(judgmentState({ ...group, parts: round.parts }, item, options.context, options.priorFindings, 3));
        receipt.assessment = null;
      }
    }
    checkpoint = seal({ version: 3, bindingHash: binding(3), candidateHash: options.candidateHash,
      completedReviewHash: null, groups: checkpoint.groups, previousPolicy });
  }
  const persist = async () => {
    signal?.throwIfAborted();
    const { hash: _hash, ...body } = checkpoint;
    checkpoint = seal(body); await options.save(structuredClone(checkpoint)); signal?.throwIfAborted();
  };
  if (migrated) await persist();
  const result: ReviewParts = { candidateHash: options.candidateHash, checks: [], issues: [], acceptanceScopeChecks: [], priorFindingDecisions: [] };
  const approvals: { groupId: string; by: "reviewer" | "jev"; status: "pass" | "revise" }[] = [];
  for (const group of groups) {
    signal?.throwIfAborted();
    let saved = checkpoint.groups[group.id];
    if (!saved) {
      saved = { sourceHash: repairHash(group), rounds: [{ parts: structuredClone(group.parts), receipts: {} }], recheckCalls: 0 };
      checkpoint.groups[group.id] = saved; await persist();
    }
    if (saved.sourceHash !== repairHash(group) || !Number.isSafeInteger(saved.recheckCalls) || saved.recheckCalls < 0
      || !Array.isArray(saved.rounds) || saved.rounds.length < 1 || saved.rounds.length > 2
      || repairHash(saved.rounds[0]!.parts) !== repairHash(group.parts)) stop("review_judgment_binding", "JEV 小组原报告或累计用量无法核验。");
    const round = saved.rounds.at(-1)!;
    options.validate(group, round.parts);
    const pending = objections(round.parts, options.context), keys = new Set(pending.map(item => item.key));
    if (Object.keys(round.receipts).some(key => !keys.has(key))) stop("review_judgment_binding", "JEV 判定没有对应的原始意见。");
    for (const item of pending) {
      const state = judgmentState({ ...group, parts: round.parts }, item, options.context, options.priorFindings, checkpoint.version), stateHash = repairHash(state);
      const receipt = round.receipts[item.key] ??= { stateHash, attempts: 0, response: null, responses: [], assessment: null, formatFailures: 0 };
      if (receipt.stateHash !== stateHash || !Number.isSafeInteger(receipt.attempts) || receipt.attempts < 0
        || !Array.isArray(receipt.responses) || receipt.responses.length > receipt.attempts
        || !Number.isSafeInteger(receipt.formatFailures) || receipt.formatFailures < 0 || receipt.formatFailures > 3)
        stop("review_judgment_binding", "JEV 原始材料或请求计数无法核验。");
      if (receipt.assessment) {
        if (repairHash(assess(receipt.response, checkpoint.version)) !== repairHash(receipt.assessment)) stop("review_judgment_binding", "JEV 判定与保存的响应不一致。");
        continue;
      }
      while (!receipt.assessment && receipt.formatFailures < 3) {
        let response: unknown;
        try {
          response = await (options.request ?? requestJevDecision)({ config: options.config, state, questions: rubrics[checkpoint.version].questions, signal,
            onAttempt: async () => { receipt.attempts++; await persist(); } });
        } catch (error) {
          const diagnostic = objectFields(objectFields(error).diagnostic);
          if (diagnostic.reason !== "invalid_json") stop("review_judgment_request", error instanceof Error ? error.message : "JEV 请求未完成。",
            { groupId: group.id, objection: item.key, providerReason: diagnostic.reason ?? "request_failed", attempts: receipt.attempts });
          response = { error: "invalid_json" };
        }
        receipt.responses.push(response);
        receipt.response = response;
        try { receipt.assessment = assess(response, checkpoint.version); }
        catch (error) { if (!(error instanceof InputError)) throw error; receipt.formatFailures++; }
        await persist();
      }
      if (!receipt.assessment) stop("review_judgment_format", "JEV 连续三次返回无效评分结构；原报告和用量已保存。", { groupId: group.id, objection: item.key });
    }
    const effective = structuredClone(round.parts);
    for (const item of pending) {
      const decision = round.receipts[item.key]!.assessment!, approved = decision.route !== "revise";
      if (checkpoint.version < 3 && !approved) continue;
      const note = checkpoint.version < 3
        ? `本组 JEV 判定为${decision.route === "waive" ? "撤销打回" : "非阻塞建议"}（必要度 ${decision.necessity.score.toFixed(1)}，过严度 ${decision.strictness.score.toFixed(1)}）；原文与原报告保存在小组判定记录。`
        : `本组 JEV 判定${approved ? "通过，不保留此项打回" : "打回设计修改"}（必要度 ${decision.necessity.score.toFixed(1)}，过严度 ${decision.strictness.score.toFixed(1)}）；原文、原报告和评分保留，不表示设计已修改或业务已验收。`;
      if (item.field === "issues") {
        if (approved) { effective.issues[item.index]!.blocking = false; effective.issues[item.index]!.remedy = note; }
        continue;
      }
      // Flags and historical decisions still need a concrete issue for the ordinary aggregate validator.
      let checkId: string, candidatePaths: string[], description: string, id: string;
      if (item.field === "checks") {
        const check = effective.checks[item.index]!; check.passed = approved;
        if (approved) { check.evidence = note; continue; }
        checkId = check.id; description = check.evidence; id = `jev_${repairHash([group.id, item.key]).slice(0, 24)}`;
        candidatePaths = judgmentState(group, item, options.context, options.priorFindings, checkpoint.version).materials
          .filter(ref => ref.source === "candidate").map(ref => ref.path).slice(0, 12);
      } else if (item.field === "acceptanceScopeChecks") {
        const check = effective.acceptanceScopeChecks[item.index]!; check.sufficient = approved;
        if (approved) { check.reason = note; continue; }
        checkId = "acceptance_quality"; description = check.reason; id = `jev_${repairHash([group.id, item.key]).slice(0, 24)}`;
        candidatePaths = [`/acceptance/${rows(objectFields(objectFields(options.context).candidate).acceptance).findIndex(row => row.id === check.acceptanceId)}`];
      } else {
        const row = effective.priorFindingDecisions[item.index]!;
        const finding = rows(objectFields(options.priorFindings).findings).find(finding => finding.findingId === row.findingId);
        row.status = approved ? "unsupported" : "unresolved"; row.reason = note;
        checkId = row.checkIds[0]!; candidatePaths = row.candidatePaths; id = row.findingId;
        description = String(objectFields(finding?.issue).description ?? objectFields(item.value).reason);
      }
      const existing = effective.issues.find(issue => issue.id === id);
      const references = [...(existing?.references ?? []), ...candidatePaths.map(path => ({ source: "candidate", path }))]
        .filter((ref, index, all) => all.findIndex(other => other.source === ref.source && other.path === ref.path) === index);
      const issue = { ...existing, id, checkId, kind: existing?.kind ?? "design", blocking: !approved, description,
        remedy: note, candidatePaths, references } as ReviewParts["issues"][number];
      if (existing) Object.assign(existing, issue); else effective.issues.push(issue);
    }
    for (const check of effective.checks) if (round.parts.issues.some(issue => issue.blocking && issue.checkId === check.id)) {
      check.passed = !effective.issues.some(issue => issue.blocking && issue.checkId === check.id);
      if (check.passed) check.evidence = "本组具体阻塞意见已逐条由 JEV 撤销或降为建议；原检查结论保留在判定记录。";
    }
    for (const check of effective.acceptanceScopeChecks) if (scopeIssues(round.parts, check.acceptanceId, options.context).length) {
      check.sufficient = !scopeIssues(effective, check.acceptanceId, options.context).length;
      if (check.sufficient) check.reason = "本项具体阻塞意见已逐条由 JEV 撤销或降为建议；原判断保留在判定记录。";
    }
    if (checkpoint.version === 3) for (const check of effective.checks) {
      if (effective.issues.some(issue => issue.blocking && issue.checkId === check.id)) check.passed = false;
    }
    options.validate(group, effective, checkpoint.version === 3);
    approvals.push({ groupId: group.id, by: objections(round.parts, options.context).length ? "jev" : "reviewer", status: objections(effective, options.context).length ? "revise" : "pass" });
    for (const field of ["checks", "issues", "acceptanceScopeChecks", "priorFindingDecisions"] as const)
      (result[field] as unknown[]).push(...effective[field]);
  }
  for (const check of result.checks) {
    const retained = result.issues.filter(issue => issue.blocking && issue.checkId === check.id);
    if (retained.length) { check.passed = false; check.evidence = `相关小组仍保留阻塞意见：${retained.map(issue => issue.id).join("、")}`; }
  }
  const failed = result.checks.some(row => !row.passed) || result.issues.some(row => row.blocking)
    || result.acceptanceScopeChecks.some(row => !row.sufficient) || result.priorFindingDecisions.some(row => !["resolved", "unsupported"].includes(row.status));
  const review: ArchitectureReview = { ...result, verdict: failed ? "revise" : "pass", summary: failed
    ? "各组分别检查和复核后，仍有必须修改的问题。" : "各组已分别通过，程序汇总完成；仍须独立需求范围复核。" };
  if (checkpoint.completedReviewHash !== null && checkpoint.completedReviewHash !== repairHash(review))
    stop("review_judgment_binding", "保存的汇总结论与本组判定不一致。");
  checkpoint.completedReviewHash = repairHash(review); await persist();
  return { parts: result, review, approvals, checkpoint };
}
