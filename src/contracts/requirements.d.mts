import type { TaskSpecV1 } from "./versions.mjs";
export interface EvidenceMessage { id: string; role: "user" | "assistant" | "measurement"; content: string }
export interface EvidenceMessageInput { id?: string; role: string; content: string }
export type RequirementSource = "user" | "inferred" | "default" | "unknown";
export interface RequirementField { value: string; source: RequirementSource }
export interface RequirementDraft {
  name: RequirementField; agentType: RequirementField; goal: RequirementField; scenario: RequirementField;
  inputSource: RequirementField; task: RequirementField; deliverable: RequirementField; successCriteria: RequirementField; routingCondition: RequirementField;
  constraints: ({ text: string; value?: string; source: RequirementSource } | { text?: never; value: string; source: RequirementSource })[];
  usage: { mode: "on_demand" | "scheduled" | "event" | "unclear"; detail: string; source: RequirementSource };
  externalAction: { mode: "none" | "possible" | "requested"; operation: string; target: string; scope: string; trigger: string; source: RequirementSource };
  interaction?: { defaultEntry: "conversation" | "application"; page: boolean; operations: string[]; inputs: string; results: string; persistentData: string; assistant?: { enabled: boolean; purpose: string } };
  connections?: { purpose: "search" | "model" | "business"; description: string; required: boolean }[];
  capabilityDependencies: string[]; unresolved: string[]; conflict: { left: string; right: string } | null; taskSpec?: TaskSpecV1;
}
export interface ProviderDiagnostic { stage: string; reason: string; [key: string]: unknown }
export interface RequirementIssue {
  id: string; owner: "user" | "system" | "runtime"; blocking: boolean; question: string; impact: string; requirementIds: string[];
  stage?: "requirements" | "development" | "activation" | "runtime"; checks?: string[]; status?: "open" | "resolved" | "reopened" | undefined;
  current?: boolean; handoffId?: string; requirementHash?: string;
  resolution?: IssueDecision & { assessmentId: string; evidenceHash: string; evidenceIds: string[] };
}
export interface SystemCheck { id: string; status: string; message: string; evidence: { source: string; reference: string; detail: string }[] }
export interface SystemProgress { basisHash: string; established: string; missing: string; nextAction: { kind: string; detail: string }; [key: string]: unknown }
export interface IssueDecision { issueId: string; status: "open" | "resolved" | "reopened"; reason: string; evidence: { messageId: string; quote: string }[];
  owner?: RequirementIssue["owner"]; stage?: RequirementIssue["stage"]; checks?: string[]; progress?: SystemProgress; derivationIds?: string[] }
export interface PreflightAssessment { verdict: "sufficient" | "needs_input" | "blocked"; direction: string; adequacy: string;
  dimensionChecks: { dimension: TaskSpecV1["items"][number]["dimension"]; status: "sufficient" | "not_applicable" | "unknown"; reason: string; requirementIds: string[] }[];
  issues: RequirementIssue[] }
export type ConsultationHandoff = Pick<RequirementHandoff, "id" | "issues" | "resolved"> & Partial<Pick<RequirementHandoff, "requirementHash" | "architectureVersion">>;
export interface RequirementHandoff { id: string; requirementHash: string; architectureVersion: number; issues: RequirementIssue[]; resolved?: boolean }
export interface RequirementNote { id: string; kind: "system_unresolved"; issueId: string; sourceRequirementHash: string; assessmentId: string; text: string }
export interface RequirementReceipt { version: 1; requestId: string; requirementHash: string; platformHash: string; assessmentId: string; draftHash: string; confirmedAt: string }
export interface SavedAssessment extends Partial<PreflightAssessment> { id: string; requestId?: string | undefined; requirementHash: string; platformHash: string; evidenceHash: string; createdAt?: string;
  systemReviewVersion?: number; failure?: string; message?: string; issueDecisions?: IssueDecision[]; systemChecks?: SystemCheck[];
  deferredIssues?: DeferredIssue[]; derivations?: RequirementDerivation[]; diagnostic?: unknown; systemProgress?: SystemProgress[] }
export interface DeferredIssue extends RequirementIssue { stageDecision: { stage: string; reason: string; checks: string[]; assessmentId?: string; derivationIds?: string[] }; verification: SystemCheck[] }
export interface Consultation { version: number; revision: number; evidenceMessages: EvidenceMessage[]; assessments: SavedAssessment[]; issues: RequirementIssue[]; receipts: RequirementReceipt[];
  handoff?: ConsultationHandoff; notes?: RequirementNote[]; displayedHash?: string }
export type CalculationFormula = { ref: string } | { value: string } | { op: string; args: CalculationFormula[] };
export interface CalculationRequest { issueId: string; requirementIds: string[]; premises: { id: string; value: string; unit: string; source: { kind: "requirement" | "platform"; reference: string; detail: string } }[];
  expressions: { id: string; unit: string; formula: CalculationFormula }[] }
export interface RequirementDerivation extends CalculationRequest { id: string; version?: 2; status: "calculated"; requirementHash: string; platformHash: string; requestHash: string;
  expressions: (CalculationRequest["expressions"][number] & { value: string })[]; scope: string;
  factBindings?: { version: 1; scopeHash: string; requirements: { reference: string; hash: string }[]; platform: { reference: string; hash: string }[]; verification: { reference: string; hash: string }[] } }
export interface RequirementState { draft: RequirementDraft; consultation?: Consultation | undefined; status: string; confirmed: boolean; version: number; question: string | null; lastQuestion: string | null; confirmationQuestion: string | null;
  agentId?: string; id?: string; summary?: string | undefined; confirmation?: RequirementReceipt | undefined }
export interface PreflightResponse extends PreflightAssessment { reviewedIssues?: RequirementIssue[]; issueDecisions?: IssueDecision[]; systemChecks?: SystemCheck[]; deferredIssues?: DeferredIssue[];
  derivations?: RequirementDerivation[]; systemProgress?: SystemProgress[]; preflightDiagnostic?: unknown }
