import type { WebCapabilityPort } from "../runtime/web-capabilities.mjs";
import type { ArchitectureDesign, ArchitectureReview, ArchitectureIssue, RequirementItem, EvidenceItem, ConfirmedRequirementContext, DeferredVerifications } from "../contracts/architecture.mjs";
import type { RequirementDraft, Consultation, RequirementIssue } from "../contracts/requirements.mjs";
import type { UnknownRecord } from "../contracts/json.mjs";
import type { ModelConfig } from "../contracts/model.mjs";
import type { ToolSchema, ToolResult } from "../contracts/tools.mjs";
import type { AgentStoragePort } from "../runtime/storage-port.mjs";
import type { SessionFactory, VerificationSessionFactory, PiSessionPort, NeumaTool, SessionStorage, Progress } from "../runtime/execution-port.mjs";
import type { createTechnicalResearch } from "./architecture-research.mjs";
import type { WebCapabilities } from "../runtime/web-capabilities.mjs";
import type { developmentRevisionReference } from "./architecture-development-revision.mjs";
import type { createArchitectureFeedbackLedger } from "./architecture-feedback-ledger.mjs";
import type { architecturePriorFindings } from "./architecture-prior-findings.mjs";
export interface Definition { id: string; name: string; draft: RequirementDraft; fingerprint: string }
export interface ModuleProposal { proposal: string; interfaces: string; tradeoffs: string; evidenceIds: string[]; unknowns: string[] }
export interface ModuleConsultation { assignment: { question: string; boundary: string; benefit: string }; result: ModuleProposal }
export interface ArchitectureRoleDiagnostic extends UnknownRecord { stage?: string; reason?: string; role?: string; phase?: string; modelCalls?: number; lastSubmissionIssue?: { path: string; reason: string; candidatePath?: string } | undefined; lastSubmissionDiagnostics?: { issues: import("../contracts/architecture.mjs").ReviewDiagnosticIssue[]; total: unknown; truncated: unknown }; repeatedFailure?: { count: number; protocolVersion?: number; modelContractHash: string; fingerprint: string } }
export interface ArchitectureDiagnostic extends ArchitectureRoleDiagnostic { stage: string; reason: string }
export interface StoredArchitectureRecord extends UnknownRecord {
  agentId: string; name: string; version: number; contractVersion: number; sourceFingerprint: string; status: string; delivery: string; summary: string;
  draft: RequirementDraft; requirements: RequirementItem[]; design: ArchitectureDesign | null; review: ArchitectureReview | null; candidateHash: string | null;
  evidence: EvidenceItem[]; researchGaps: string[]; modules: ModuleConsultation[]; attempts: UnknownRecord[]; issues: ArchitectureIssue[];
  createdAt: string; updatedAt?: string; platformHash?: string; platformContractVersion?: number; platformSnapshot?: unknown; capabilityCatalogVersion?: number; capabilitySnapshot?: unknown; runtimeCapabilities?: unknown;
  confirmedRequirementContext?: unknown; deferredVerifications?: unknown;
  diagnostic?: ArchitectureDiagnostic; reviewDiagnostics?: ArchitectureRoleDiagnostic[]; reviewFindingTransitions?: unknown[]; reviewContext?: UnknownRecord | null; reviewEvidence?: UnknownRecord;
  designProgressCheckpoint?: UnknownRecord | null; designProgressEvidenceHash?: string; designResearchCalls?: number; designStageDiagnostics?: Record<string, { lastSubmissionIssue: { path: string; reason: string } }>;
  reviewProgressCheckpoint?: UnknownRecord | null; mainReviewCheckpoint?: UnknownRecord | null; requirementFidelityProgress?: UnknownRecord | null;
  reviewRevisionCheckpoint?: UnknownRecord | null; reviewRetryCheckpoint?: UnknownRecord | null; reviewRevisionSource?: string; revisionSource?: UnknownRecord;
  reviewDispatchCheckpoint?: unknown; reviewDispatchSource?: string;
  requirementFidelity?: UnknownRecord; designRecovery?: UnknownRecord;
  developmentRevision?: unknown;
  feedbackLedger?: unknown;
  priorFindings?: unknown;
  restartSource?: { version: number; recordHash: string; preparedVersion: number; authorization: string; createdAt: string };
}
export interface ArchitectureOptions { config: ModelConfig; cwd: string; dataDir: string; sessionFactory?: SessionFactory; handoffSessionFactory?: VerificationSessionFactory; fidelitySessionFactory?: VerificationSessionFactory;
  research?: { search(query: unknown, options?: { signal?: AbortSignal | undefined }): Promise<{ sources: EvidenceItem[]; gaps: string[] }> }; storage?: AgentStoragePort; web?: WebCapabilityPort }
export interface ArchitectureDesignOptions { signal?: AbortSignal | undefined; onProgress?: Progress | undefined; consultation?: Consultation | undefined; developmentFailure?: unknown; historicalPlanningReference?: unknown; architectureRepair?: unknown }
export interface HandoffResult { needsInput: RequirementIssue[] }
export interface ArchitectureRolePayload extends UnknownRecord { requirements?: RequirementItem[]; draft?: unknown; requirement?: RequirementDraft | { name: string; draft: RequirementDraft }; design?: unknown; previousDesign?: unknown; candidateSchema?: ToolSchema; candidateHash?: string | null; capabilities?: readonly import("../contracts/architecture.mjs").Capability[]; evidence?: EvidenceItem[]; pipelineStage?: string; integrationPolicy?: { allowedRoots: string[]; instruction: string }; priorFindings?: unknown }
export type ReviewRoleProgress = Pick<import("../contracts/architecture.mjs").ReviewProgressCheckpoint, "modelCalls"> & Partial<Pick<import("../contracts/architecture.mjs").ReviewProgressCheckpoint, "origin" | "diagnostic" | "parts" | "rejectedParts" | "rejectedInput">> & { review?: Pick<ArchitectureReview, "candidateHash"> | null | undefined };
export interface ArchitectureRoleOptions<T = unknown> { role: string; agentId?: string | undefined; systemPrompt: string; payload: ArchitectureRolePayload; submitName: string; parameters: ToolSchema; validate: (value: unknown) => T;
  tools?: NeumaTool[]; signal?: AbortSignal | undefined; onProgress?: Progress | undefined; allowHandoff?: boolean; reviewEvidenceContext?: unknown;
  onFidelity?: (value: Awaited<ReturnType<typeof import("./requirement-fidelity.mjs").verifyRequirementFidelity>>) => unknown | Promise<unknown>; onDiagnostics?: (value: ArchitectureRoleDiagnostic) => unknown | Promise<unknown>;
  editableDesign?: unknown; onMainReviewValidated?: (value: T, turns: number) => unknown | Promise<unknown>; onMainReviewBudget?: (turns: number) => unknown | Promise<unknown>;
  resumeMainReview?: ReturnType<typeof import("./architecture-main-review-checkpoint.mjs").readMainReviewCheckpoint> | undefined; initialModelCalls?: number; resumeReviewProgress?: ReviewRoleProgress | null | undefined; onReviewProgress?: (value: { review?: unknown; origin?: string; parts?: unknown; rejectedParts?: unknown; rejectedInput?: unknown; modelCalls: number; diagnostic?: import("../contracts/architecture.mjs").ReviewDiagnostic }) => unknown | Promise<unknown>;
  getFidelitySessionStorage?: () => SessionStorage | Promise<SessionStorage>; resumeFidelityProgress?: ReturnType<typeof import("./architecture-fidelity-progress.mjs").readArchitectureFidelityProgress> | undefined; onFidelityProgress?: (value: unknown, turns: number) => unknown | Promise<unknown>;
  technicalRevision?: boolean; modelCallLimit?: number; onStageModelCall?: (value: { retryAttempt?: number; purpose?: string; formatSubmission?: boolean }) => unknown | Promise<unknown>; onStageResult?: (value: unknown) => unknown | Promise<unknown>;
  sessionStorage?: SessionStorage; onSessionRef?: (value: { file: string }) => unknown | Promise<unknown>; resumeStage?: boolean; stageReasoningMode?: "off" | "auto"; maxOutputTokens?: number;
  formatSubmissionLimit?: number | undefined; resumeSubmissionIssue?: unknown; reviewRetry?: import("./architecture-review-revision.mjs").ReviewRetryCheckpoint | false | undefined }
