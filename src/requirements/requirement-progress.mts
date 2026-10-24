import type { RequirementDraft, RequirementIssue, SystemCheck, RequirementDerivation, IssueDecision } from "../contracts/requirements.mjs";
import { contentHash, substantiveRequirementHash } from "./task-spec.mjs";
import { textWithinLimit } from "../runtime/text-length.mjs";

const kinds = ["calculate", "verify_facts", "research", "review"];
const text = (value: unknown) => textWithinLimit(value, 3000) && value.trim();

export function systemAssessmentBasis(issue: Pick<RequirementIssue, "id">, { draft, platform, systemChecks = [], derivations = [] }: { draft: RequirementDraft; platform: unknown; systemChecks?: SystemCheck[]; derivations?: RequirementDerivation[] }) {
  const basis = { issueId: issue.id, requirementHash: substantiveRequirementHash(draft), platformHash: contentHash(platform),
    checks: systemChecks.filter((item) => item.id === issue.id),
    derivationIds: derivations.filter((item) => item.issueId === issue.id).map((item) => item.id).sort() };
  return { ...basis, basisHash: contentHash(basis) };
}

export function systemProgressSchema(basisHash: string) {
  return { type: "object", additionalProperties: false, required: ["basisHash", "established", "missing", "nextAction"], properties: {
    basisHash: { type: "string", const: basisHash }, established: { type: "string", minLength: 1, maxLength: 3000 },
    missing: { type: "string", minLength: 1, maxLength: 3000 }, nextAction: { type: "object", additionalProperties: false,
      required: ["kind", "detail"], properties: { kind: { type: "string", enum: kinds }, detail: { type: "string", minLength: 1, maxLength: 3000 } } },
  } };
}

export function checkedSystemProgress(issue: Pick<RequirementIssue, "id" | "question">, decision: IssueDecision, basis: ReturnType<typeof systemAssessmentBasis>, { required = false, historicalIds = [] }: { required?: boolean; historicalIds?: string[] } = {}) {
  const referenced = (decision.reason.match(/calculation_[a-f0-9]{32}/g) ?? []);
  const stale = referenced.some((id) => historicalIds.includes(id) && !basis.derivationIds.includes(id));
  const progress = decision.progress;
  if (stale || required && !progress || progress && (progress.basisHash !== basis.basisHash || !text(progress.established)
    || !text(progress.missing) || !kinds.includes(progress.nextAction?.kind) || !text(progress.nextAction.detail)))
    throw Object.assign(new Error("系统阻断缺少当前依据与可继续核实的进展"), { reason: "system_basis_stale" });
  // Legacy non-calculation decisions retain their contract. Host facts and the
  // independently checked gap form an explicit continuation record for them.
  return { issueId: issue.id, basisHash: basis.basisHash, checks: basis.checks.map((check) => check.id), derivationIds: basis.derivationIds,
    established: progress?.established ?? (basis.checks.some((check) => check.status === "verified")
      ? "已取得本轮列明的可信事实；尚不表示业务、代码或运行验收通过。" : "本轮尚未取得足够的可信事实，不能承诺能力已可用。"),
    missing: progress?.missing ?? decision.reason,
    nextAction: progress?.nextAction ?? { kind: basis.checks.some((check) => check.status !== "verified") ? "verify_facts" : "review", detail: issue.question } };
}
