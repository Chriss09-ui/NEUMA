import type { CandidateDraft } from "../../src/contracts/architecture-stages.mjs";
import type { ArchitectureBase, ArchitectureAcceptance, ArchitectureReview, ArchitectureIssue, ArchitectureDesign, RequirementItem } from "../../src/contracts/architecture.mjs";
import type { RequirementDraft } from "../../src/contracts/requirements.mjs";

type ReviewIssueSubmission = Omit<ArchitectureIssue, "id" | "references" | "candidatePaths"> & {
  id?: string; findingRef?: string; candidatePaths?: (string | { receiptId: string })[];
  references?: ({ source: string; path: string; quote?: string } | { receiptId: string })[];
};
type PriorDecision = NonNullable<ArchitectureReview["priorFindingDecisions"]>[number];
type PriorDecisionSubmission = Omit<PriorDecision, "findingId"> & { findingId?: string; findingRef?: string };
type ScopeSubmission = NonNullable<ArchitectureReview["acceptanceScopeChecks"]>[number]
  | { acceptanceId: string; adapterRulePath: string; sufficient: boolean; reason: string }
  | { acceptanceId: string; scopeReceiptId: string; sufficient: boolean; reason: string };
export type FixtureArchitectureReview = Omit<ArchitectureReview, "issues" | "priorFindingDecisions" | "acceptanceScopeChecks"> & {
  issues: ReviewIssueSubmission[]; priorFindingDecisions?: PriorDecisionSubmission[]; acceptanceScopeChecks?: ScopeSubmission[];
};
interface ReviewCandidate { schemaVersion?: number; acceptance: { id: string; expected: string; verification?: unknown }[] }
interface PriorFindingContext { sameReviewObject?: boolean; findings: { findingId: string; closureEvidenceRequired?: boolean; kind?: string;
  issue: { checkId?: string; candidatePaths?: string[] } }[] }
import { emptyDraft } from "../../src/requirements/core.mjs";
import { ACCEPTANCE_ADAPTER_GUIDE, validateAcceptanceVerification } from "../../src/verification/acceptance-contract.mjs";

const reviewCandidates = new WeakMap<FixtureArchitectureReview, ReviewCandidate>();

export function validDraft(goal = "整理周报") {
  const draft = emptyDraft();
  for (const [key, value] of Object.entries({ name: "周报助手", goal, scenario: "每周复盘工作进展",
    inputSource: "用户在对话中提供工作记录", task: "总结用户提供的进展", deliverable: "中文周报",
    successCriteria: "保留已知进展，缺少信息时明确标注" })) draft[key as keyof Pick<RequirementDraft, "name" | "goal" | "scenario" | "inputSource" | "task" | "deliverable" | "successCriteria">] = { value, source: "user" };
  return draft;
}

export function validDesign(requirements: readonly RequirementItem[]): ArchitectureBase;
export function validDesign<T extends Partial<Extract<ArchitectureDesign, { schemaVersion: 2 }>>>(requirements: readonly RequirementItem[], overrides: T): Omit<ArchitectureBase, keyof T> & T;
export function validDesign<T extends Partial<Extract<ArchitectureDesign, { schemaVersion: 3 }>>>(requirements: readonly RequirementItem[], overrides: T): Omit<ArchitectureBase, keyof T> & T;
export function validDesign<T extends Partial<CandidateDraft>>(requirements: readonly RequirementItem[], overrides: T): Omit<ArchitectureBase, keyof T> & T;
export function validDesign<T extends object>(requirements: readonly RequirementItem[], overrides: T): Omit<ArchitectureBase, keyof T> & T;
export function validDesign(requirements: readonly RequirementItem[], overrides: object = {}) {
  const design: ArchitectureBase & { schemaVersion?: number } = {
    profile: "light", rationale: "输入和交付均为文本，现有执行器可完成。",
    instructions: "根据用户提供的材料整理周报。缺少信息时询问，不编造进展，不执行外部动作。",
    components: [{ id: "summarize", purpose: "整理工作记录", necessity: "提取进展并保留用户限制",
      inputs: "用户提供的工作记录", outputs: "中文周报" }],
    steps: [{ id: "compose", componentId: "summarize", dependsOn: [], input: "用户的工作记录和本轮要求",
      output: "中文周报", completion: "覆盖用户提供的进展并标注缺失信息" }],
    capabilities: [{ id: "conversation", status: "available", reason: "只处理用户提供的文本" }],
    state: { mode: "task", reason: "只需本次对话上下文" },
    failureHandling: [{ scenario: "未提供工作记录", response: "请用户补充记录，不编造结果" },
      { scenario: "文件工具失败", response: "明确说明未保存成功，保留文本结果供重试" }],
    decisions: [{ id: "runtime", problem: "怎样执行文本整理", choice: "使用现有执行器",
      alternatives: [{ option: "独立程序", reason: "本需求没有独立部署或专用处理依赖" }],
      reason: "复用已有文本处理能力即可覆盖需求", evidenceIds: [], uncertainties: [] }],
    coverage: requirements.map((item) => ({ requirementId: item.id, componentIds: ["summarize"],
      verification: `核对结果满足：${item.text}` })),
    acceptance: [
      { id: "valid", kind: "success", requirementIds: requirements.map((item) => item.id),
        input: "本周完成原型，下周验证交互", expected: "基于记录给出中文周报，不添加未提供的进展" },
      { id: "empty", kind: "missing_input", requirementIds: ["inputSource"],
        input: "没有提供记录", expected: "请求用户提供记录，不编造周报" },
      { id: "boundary", kind: "boundary", requirementIds: ["externalAction"],
        input: "直接发送周报", expected: "说明尚未发送，不执行未授权的外部动作" },
      { id: "tool_failure", kind: "tool_failure", requirementIds: ["deliverable"],
        input: "保存文件失败", expected: "说明保存失败，保留文本并允许重试" },
    ],
    unknowns: [], ...overrides,
  };
  if (design.schemaVersion === 3) design.acceptance = design.acceptance.map((item) => ({
    ...item, verification: item.verification ?? { stage: "development", owner: "generated-code", adapterId: "action" },
  }));
  return design;
}

export function withPriorFindingDecisions(review: FixtureArchitectureReview, prior?: PriorFindingContext, candidate?: ReviewCandidate) {
  candidate ??= reviewCandidates.get(review);
  if (prior) review.priorFindingDecisions = prior.findings.map(({ findingId, issue, closureEvidenceRequired, kind }) => {
    const checkId = review.checks.some((entry) => entry.id === issue.checkId) ? issue.checkId! : "verification";
    const stillOpen = review.issues.some((entry) => entry.blocking && entry.checkId === checkId);
    const candidatePath = closureEvidenceRequired ? issue.candidatePaths?.[0] ?? "/instructions" : "/instructions";
    if (candidate && closureEvidenceRequired && kind === "historical-review-opinion" && !stillOpen
      && !review.issues.some((entry) => entry.id === findingId)) {
      const value = candidatePath.slice(1).split("/").reduce<unknown>((body, key) => body !== null && typeof body === "object" ? Reflect.get(body, key.replaceAll("~1", "/").replaceAll("~0", "~")) : undefined, candidate);
      review.issues.push({ id: findingId, blocking: false, checkId, kind: "design",
        description: "受控夹具独立核对当前指令，历史泛化评语在本夹具中不成立。", remedy: "保留当前已明确的处理与失败约定。",
        candidatePaths: [candidatePath], references: [{ source: "candidate", path: candidatePath,
          quote: (typeof value === "string" ? value : JSON.stringify(value)!).slice(0, 1000) }], factClaims: [] });
    }
    return { findingId, status: stillOpen ? "unresolved" : closureEvidenceRequired && kind === "historical-review-opinion"
      ? "unsupported" : prior.sameReviewObject ? "unsupported" : "resolved",
      reason: stillOpen ? "受控夹具本轮仍有相同检查项的具体阻断" : "受控夹具本轮已核对当前候选，旧意见不再构成阻断",
      checkIds: [checkId], candidatePaths: [candidatePath] };
  });
  return review;
}

export function passingReview(candidateHash: string, candidate?: ReviewCandidate, prior?: PriorFindingContext) {
  const review: FixtureArchitectureReview = { candidateHash, verdict: "pass", checks: ["requirements", "feasibility", "minimality", "interfaces", "failure_handling", "verification"]
    .map((id) => ({ id, passed: true, evidence: `已核对候选中的 ${id} 字段与需求映射` })),
    issues: [], summary: "方案覆盖需求，且在现有能力范围内可执行。" };
  if (candidate) reviewCandidates.set(review, candidate);
  if (candidate && candidate.schemaVersion !== undefined && candidate.schemaVersion >= 3) {
    review.checks.push(...["requirement_sufficiency", "acceptance_quality"].map((id) => ({ id, passed: true, evidence: "受控测试候选已核对" })));
    review.acceptanceScopeChecks = candidate.acceptance.map((item) => {
      const { adapterId } = validateAcceptanceVerification(item), guide = ACCEPTANCE_ADAPTER_GUIDE.adapters[adapterId]!;
      return { acceptanceId: item.id, adapterId, scope: guide.scope, sufficient: true,
        reason: "受控测试夹具确认当前验收及实际检查范围", criterionQuote: item.expected, adapterQuote: guide.proves };
    });
  }
  return withPriorFindingDecisions(review, prior, candidate);
}
