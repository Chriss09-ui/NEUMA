import type { ConnectionDefinition } from "./connection.mjs";
import type { RequirementDraft, DeferredIssue } from "./requirements.mjs";
import type { AcceptanceVerification } from "./verification.mjs";
import type { UnknownRecord } from "./json.mjs";
export interface RequirementItem { id: string; text: string }
export interface Capability { id: string; status: string; scope: string; version?: number }
export interface ArchitectureComponent { id: string; purpose: string; necessity: string; inputs: string; outputs: string }
export interface ArchitectureStep { id: string; componentId: string; dependsOn: string[]; input: string; output: string; completion: string }
export interface ArchitectureDecision { id: string; problem: string; choice: string; alternatives: { option: string; reason: string }[]; reason: string; evidenceIds: string[]; uncertainties: string[] }
export interface ArchitectureAcceptance { id: string; kind: "success" | "missing_input" | "boundary" | "tool_failure"; requirementIds: string[]; input: string; expected: string; verification?: AcceptanceVerification; [key: string]: unknown }
export interface ArchitectureInteraction { defaultEntry: "conversation" | "application"; page: boolean; operations: boolean; inputs: string; results: string; persistentData: string; assistant?: { enabled: boolean; purpose: string } }
export interface LegacyArchitectureConnection { id: string; purpose: "search" | "model" | "business"; required: boolean; description: string; operations: { id: string; method: string; path: string; input: string; output: string; safeTest: boolean }[] }
export interface ArchitectureBase {
  profile: "light" | "workflow" | "custom"; rationale: string; instructions: string; components: ArchitectureComponent[]; steps: ArchitectureStep[];
  capabilities: { id: string; status: "available" | "needs_connection" | "needs_development" | "unverified"; reason: string }[];
  state: { mode: "none" | "task" | "persistent"; reason: string }; failureHandling: { scenario: string; response: string }[];
  decisions: ArchitectureDecision[]; coverage: { requirementId: string; componentIds: string[]; verification: string }[];
  acceptance: ArchitectureAcceptance[]; unknowns: { question: string; blocking: boolean; resolution: string }[];
}
export type ArchitectureDesign = ArchitectureBase & (
  { schemaVersion?: never; interaction?: never; connections?: never; execution?: never; selectionBasis?: never; platformClaims?: never }
  | { schemaVersion: 2; interaction: ArchitectureInteraction; connections: LegacyArchitectureConnection[]; execution?: never; selectionBasis?: never; platformClaims?: never }
  | { schemaVersion: 3; interaction: ArchitectureInteraction; connections: ConnectionDefinition[]; execution: { language: "none" | "javascript" | "python"; hosting: "builtin" | "managed" | "docker"; reason: string };
      selectionBasis: { capacity: string; process: string; quality: string; requirementIds: string[]; assumptions: string[] }; platformClaims?: PlatformClaim[] });
export interface PlatformClaim { id: string; source: "runtimeCapabilities" | "acceptanceAdapterGuide"; path: string; expected: unknown; decisionIds: string[]; acceptanceIds: string[] }
export interface ArchitectureIssue { id: string; blocking: boolean; description: string; remedy: string; source?: string; candidateFields?: string[];
  checkId?: string; kind?: string; candidatePaths?: string[]; references?: { source: string; path: string; quote: string }[]; factClaims?: { source: string; path: string; expectedJson: string }[] }
export interface ArchitectureReview { candidateHash: string; verdict: "pass" | "revise" | "insufficient" | "infeasible" | "needs_input"; checks: { id: string; passed: boolean; evidence: string }[]; issues: ArchitectureIssue[]; summary: string;
  acceptanceScopeChecks?: { acceptanceId: string; adapterId: string; scope: string; sufficient: boolean; reason: string; criterionQuote: string; adapterQuote: string }[];
  priorFindingDecisions?: { findingId: string; status: string; reason: string; checkIds: string[]; candidatePaths: string[] }[] }
export interface EvidenceItem { id: string; [key: string]: unknown }
export interface ConfirmedRequirementContext { hash: string; sourceQuotes: { id: string; messageId: string; quote: string; [key: string]: unknown }[]; taskSources?: { quoteIds?: string[] }[]; resolvedChoices?: { quoteIds?: string[] }[]; [key: string]: unknown }
export interface DeferredVerifications { hash: string; issues: (DeferredIssue & { requirementId: string })[]; [key: string]: unknown }
export interface ArchitectureContext { requirements?: RequirementItem[]; capabilities?: readonly Capability[]; evidence?: EvidenceItem[]; draft?: RequirementDraft;
  deferredVerifications?: unknown; confirmedRequirementContext?: unknown;
  requireAcceptanceVerification?: boolean; runtimeCapabilities?: unknown; acceptanceAdapterGuide?: unknown; contextManifest?: unknown;
  platformSnapshot?: { version?: number; publicCapabilities?: Capability[] } }
export interface ArchitectureEvidenceContext { candidate: ArchitectureDesign; requirements: RequirementItem[]; runtimeCapabilities: unknown; evidence: EvidenceItem[];
  confirmedRequirementContext: unknown; deferredVerifications: unknown; acceptanceAdapterGuide: unknown;
  contextManifest: Record<string, { delivery: string; characters: number; sha256: string }> }
export interface ArchitectureRecord extends UnknownRecord { agentId: string; version: number; candidateHash: string; design: ArchitectureDesign; contractVersion: number;
  draft: RequirementDraft; requirements: RequirementItem[]; sourceFingerprint: string; platformHash: string; evidence: EvidenceItem[];
  priorFindings?: { findings: { findingId: string }[] };
  reviewEvidence?: { snapshot?: { contextManifest?: Record<string, { delivery: string; characters: number; sha256: string }> }; frozenEvidence?: EvidenceItem[] };
  capabilityCatalogVersion?: number; capabilitySnapshot?: Capability[]; runtimeCapabilities?: unknown; platformSnapshot?: ArchitectureContext["platformSnapshot"] }
export interface ReviewParts { candidateHash: string; checks: ArchitectureReview["checks"]; issues: ArchitectureReview["issues"]; acceptanceScopeChecks: NonNullable<ArchitectureReview["acceptanceScopeChecks"]>; priorFindingDecisions: NonNullable<ArchitectureReview["priorFindingDecisions"]> }
export interface ReviewDiagnosticIssue { path: string; reason: string; candidatePath?: string; remedy?: string; findingId?: string }
export interface ReviewDiagnostic { reason?: string; submissionAttempts?: number; submissionContinuations?: number; localRevisions?: number; lastSubmissionIssue?: ReviewDiagnosticIssue; issues?: ReviewDiagnosticIssue[];
  repeatedFailure?: { modelContractHash: string; fingerprint: string; count: number; protocolVersion?: number } }
export interface RejectedReviewInput { toolName: string; input: UnknownRecord & { candidateHash: string } }
export interface ReviewProgressCheckpoint { schemaVersion: 1 | 2 | 3 | 4; source: { agentId: string; architectureVersion: number; candidateHash: string }; bindingHash: string; reviewHash: string | null; review: ArchitectureReview | null; origin: string; modelCalls: number; diagnostic: ReviewDiagnostic; hash: string;
  parts?: ReviewParts; partsHash?: string; rejectedParts?: ReviewParts | null; rejectedPartsHash?: string | null; rejectedInput?: RejectedReviewInput | null; rejectedInputHash?: string | null }
