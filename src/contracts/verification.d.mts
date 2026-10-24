export type AcceptanceStage = "development" | "activation" | "runtime";
export type AcceptanceAdapterId = "action" | "input-contract" | "page-resources" | "host-files" | "host-runtime" | "host-business" | "host-gateway" | "delivery-review" | "conversation";
export interface AcceptanceVerification { stage: AcceptanceStage; owner: "generated-code" | "platform" | "conversation"; adapterId: AcceptanceAdapterId }
export type AcceptanceItem = { id: string; requirementIds?: string[]; verification?: unknown }
export type ConversationDecision = { acceptanceId: string; status: "passed" | "failed" | "not_run"; triggered: boolean; reason: string;
  quotes: { source: "message" | "reply" | "toolEvidence"; quote: string }[] }
export type AcceptanceStatus = "passed" | "failed" | "not_run" | "error";
export interface AcceptanceBinding { agentId: string; architectureVersion: number; architectureHash: string; requirementsHash: string; planHash: string; codeHash: string; runtimeCapabilitiesHash?: string }
export interface AcceptanceEvidence { kind: "development-report" | "independent-review" | "host-integration" | "runtime-task"; bindingHash: string; scope?: string;
  mode?: string; codeHash?: string; planHash?: string; reportId?: string; caseIds?: string[]; reportHash?: string; planSubjectHash?: string; integrationSubjectHash?: string;
  planReviewHash?: string; integrationReviewHash?: string; adapterId?: AcceptanceAdapterId; evidenceId?: string; evidenceHash?: string; taskId?: string; deliveryVersion?: string }
export interface AcceptanceLedgerItem { acceptanceId: string; requirementIds: string[]; verification: AcceptanceVerification; legacy: boolean; acceptanceHash: string;
  status: AcceptanceStatus; evidence: AcceptanceEvidence | null; reason?: string }
export interface AcceptanceLedger { schemaVersion: 1; binding: AcceptanceBinding; bindingHash: string; status: AcceptanceStatus; items: AcceptanceLedgerItem[] }
