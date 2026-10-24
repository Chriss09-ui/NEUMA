import type { UnknownRecord } from "../contracts/json.mjs";
import { objectFields, isArray } from "../runtime/type-boundary.mjs";
export interface FeedbackIssue extends UnknownRecord {
  candidatePaths?: string[]; references?: { source: string; path: string; quote: string }[];
}
export interface FeedbackClosure extends UnknownRecord {
  status: string; candidateHash: string; factsHash: string;
  anchors: { path: string; kind: string; coreHash: string; id?: unknown }[];
}
export interface FeedbackFinding extends UnknownRecord {
  findingId: string; kind?: string; issue: FeedbackIssue; repairBasis?: unknown; repairBasisHash?: string;
  closure?: FeedbackClosure; closureEvidenceRequired?: boolean;
  currentAcceptance?: { id: string; path: string | null };
  resolutionBasis?: UnknownRecord & { status: string };
}
export interface FeedbackCoverage extends UnknownRecord { status: string }
export interface FeedbackLedgerBody extends UnknownRecord {
  findings: FeedbackFinding[]; coverage: FeedbackCoverage; coverageSources?: Record<string, FeedbackCoverage>;
  repairBases?: Record<string, unknown>;
}
export interface FeedbackLedger extends FeedbackLedgerBody { hash: string }
export interface PriorCurrent { candidateHash: string; contextManifestHash?: unknown; guideHash?: unknown }
export interface PriorFindings extends UnknownRecord {
  findings: FeedbackFinding[]; current: PriorCurrent; sameReviewObject: boolean; source: unknown;
  repairBases?: Record<string, unknown>; scopeChecks?: { acceptanceId: string; adapterId: string; sufficient: boolean }[];
}

/** Check only fields consumed here; historical opinions remain untrusted evidence. */
export function feedbackFinding(input: unknown): FeedbackFinding {
  const value = objectFields(input), issue = objectFields(value.issue);
  if (typeof value.findingId !== "string" || value.kind !== undefined && typeof value.kind !== "string"
    || !value.issue || typeof value.issue !== "object" || Array.isArray(value.issue)
    || issue.candidatePaths !== undefined && (!isArray(issue.candidatePaths) || issue.candidatePaths.some(path => typeof path !== "string"))
    || issue.references !== undefined && (!isArray(issue.references) || issue.references.some(input => {
      const reference = objectFields(input);
      return [reference.source, reference.path, reference.quote].some(field => typeof field !== "string");
    }))) throw new TypeError("Invalid historical feedback finding");
  if (value.closure !== undefined) {
    const closure = objectFields(value.closure);
    if ([closure.status, closure.candidateHash, closure.factsHash].some(field => typeof field !== "string")
      || !isArray(closure.anchors) || closure.anchors.some(input => {
        const anchor = objectFields(input); return [anchor.path, anchor.kind, anchor.coreHash].some(field => typeof field !== "string");
      })) throw new TypeError("Invalid historical feedback closure");
  }
  if (value.repairBasisHash !== undefined && typeof value.repairBasisHash !== "string") throw new TypeError("Invalid historical repair reference");
  if (value.currentAcceptance !== undefined) {
    const acceptance = objectFields(value.currentAcceptance);
    if (typeof acceptance.id !== "string" || acceptance.path !== null && typeof acceptance.path !== "string") throw new TypeError("Invalid historical acceptance reference");
  }
  if (value.resolutionBasis !== undefined && typeof objectFields(value.resolutionBasis).status !== "string") throw new TypeError("Invalid historical resolution basis");
  return value as FeedbackFinding;
}
export function feedbackFindings(input: unknown): FeedbackFinding[] {
  if (!isArray(input)) throw new TypeError("Invalid historical feedback list");
  return input.map(feedbackFinding);
}
export function priorFindings(input: unknown): PriorFindings | null {
  if (!input) return null;
  const value = objectFields(input), current = objectFields(value.current);
  feedbackFindings(value.findings);
  if (typeof current.candidateHash !== "string"
    || typeof value.sameReviewObject !== "boolean" || value.scopeChecks !== undefined && (!isArray(value.scopeChecks)
    || value.scopeChecks.some(input => { const row = objectFields(input); return typeof row.acceptanceId !== "string" || typeof row.adapterId !== "string" || typeof row.sufficient !== "boolean"; })))
    throw new TypeError("Invalid prior findings envelope");
  return value as PriorFindings;
}

export function feedbackLedger(input: unknown): FeedbackLedger | null {
  if (!input) return null;
  const value = objectFields(input);
  feedbackFindings(value.findings);
  if (typeof value.hash !== "string" || typeof objectFields(value.coverage).status !== "string") throw new TypeError("Invalid feedback ledger envelope");
  return value as FeedbackLedger;
}
