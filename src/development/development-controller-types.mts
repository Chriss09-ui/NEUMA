import type { SessionMessage } from "../runtime/execution-port.mjs";
import type { ArchitectureRecord, ArchitectureReview } from "../contracts/architecture.mjs";
import type { DevelopmentArchitecture, DevelopmentPlan, DevelopmentTask, DevelopmentWork, DevelopmentReview, SavedDevelopmentReview } from "../contracts/development.mjs";
import type { AcceptanceLedger } from "../contracts/verification.mjs";
import type { UnknownRecord } from "../contracts/json.mjs";
import type { DevelopmentSnapshot } from "./development-workspace.mjs";
import type { PlanningSnapshot, PlanningDraftSnapshot } from "./development-artifacts.mjs";
import type { SubmissionRecord, SubmissionIssue } from "./development-diagnostics.mjs";
import type { DevelopmentSessionReference } from "./development-sessions.mjs";
import type { PlanningBlockerReport } from "./development-planning-blocker.mjs";
import type { DevelopmentContextPayload, PreparedDevelopmentContext } from "./development-context.mjs";
import type { PiSessionPort, NeumaTool } from "../runtime/execution-port.mjs";
import type { ContextEvent } from "../runtime/execution-port.mjs";
import type { ApplicationManifest } from "../contracts/application.mjs";

export interface DevelopmentRevision extends UnknownRecord { schemaVersion?: number; trust?: string; status?: string; source?: { agentId: string }; plan?: DevelopmentPlan; planHash?: string; caseFacts?: { planHash: string }; caseFactsReference?: unknown }
/** Persisted candidates may predate fields added to their recorded schema version. Full contract validation runs on use. */
export type DevelopmentCandidateDesign = import("../contracts/architecture.mjs").ArchitectureBase & {
  schemaVersion?: number; interaction?: import("../contracts/architecture.mjs").ArchitectureInteraction;
  connections?: NonNullable<ArchitectureRecord["design"]["connections"]>; execution?: NonNullable<ArchitectureRecord["design"]["execution"]>;
  selectionBasis?: NonNullable<ArchitectureRecord["design"]["selectionBasis"]>; platformClaims?: NonNullable<ArchitectureRecord["design"]["platformClaims"]>;
};
export interface PassedDevelopmentArchitecture extends DevelopmentArchitecture {
  agentId: string; name: string; version: number; contractVersion: number; status: string; candidateHash: string;
  requirements: import("../contracts/architecture.mjs").RequirementItem[]; draft?: import("../contracts/requirements.mjs").RequirementDraft; design: DevelopmentCandidateDesign;
  review?: Pick<ArchitectureReview, "candidateHash" | "verdict">; issues?: { blocking: boolean }[]; sourceFingerprint?: string; platformHash?: string; evidence?: unknown[];
  developmentRevision?: unknown; platformSnapshot?: unknown; platformContractVersion?: number;
}
export interface DevelopmentEvidence { browserVerified?: boolean; evidenceMode?: string; id: string; status: string; codeHash: string | null; summary?: string | undefined;
  planHash?: string | null; mode?: string; taskId?: string | null; results: { caseId: string; status: string; [key: string]: unknown }[]; architectureRef?: ArchitectureReference }
export interface ArchitectureReference { version: number; candidateHash: string }
export interface DevelopmentFeedback { passed?: boolean; report?: DevelopmentEvidence | PlanningBlockerReport; review?: DevelopmentReview; rejectedPlan?: DevelopmentPlan; reason?: string; codeHash?: string }
export interface VerificationFeedback { passed?: boolean; report: DevelopmentEvidence; review: DevelopmentReview }
export interface TaskProgress extends DevelopmentTask { status: string; attempts: number; repairs: number; turns: number; integration?: boolean; taskHash?: string;
  feedback?: VerificationFeedback; nextAction: string; summary?: string; verifiedCodeHash?: string }
export interface DevelopmentPackage { id: string; buildId: string; architectureRef: ArchitectureReference; codeHash: string; planHash: string; entrypoint: string;
  runtime: string; snapshot: DevelopmentSnapshot; protocolVersion?: number; application?: ApplicationManifest; verificationId: string; acceptanceLedger?: AcceptanceLedger }
export interface DevelopmentDiagnostic extends UnknownRecord { stage: string; phase: string; reason: unknown; role?: string }
export interface HistoricalReview { sourceRunId: string; reviewedPlanHash: string; review: DevelopmentReview & { subjectVersion?: number }; instruction: string }
export interface PlanningDraft { bindingHash: string; snapshot: PlanningDraftSnapshot; historicalReview?: HistoricalReview }
export interface DevelopmentRunRecord extends SubmissionRecord {
  id: string; agentId: string; name: string; version: number; revision: number; createdAt: string; updatedAt: string;
  architectureRef: ArchitectureReference; architecture: PassedDevelopmentArchitecture; status: string; phase: string; delivery: string; summary: string;
  budgets: { corrections: number; planRevisions: number; integrationRepairs: number }; planning: { turns: number }; tasks: TaskProgress[];
  plan: DevelopmentPlan | null; planHash: string | null; planAttempts: { plan: DevelopmentPlan; planHash: string; review: DevelopmentReview & { subjectVersion?: number } }[];
  reviews: (DevelopmentReview & { subjectVersion?: number; mode: string; codeHash: string | null; planHash: string | null })[]; reports: DevelopmentEvidence[];
  handoffs: (DevelopmentWork & { taskId: string; codeHash: string; files: DevelopmentSnapshot["files"] })[];
  currentTaskId: string | null; snapshot?: DevelopmentSnapshot | null; verifiedSnapshot?: DevelopmentSnapshot | null; package: DevelopmentPackage | null;
  deliveries: { package: DevelopmentPackage; status: string; failureReportId?: string; runtimeCheck?: unknown }[]; feedback: DevelopmentFeedback | null;
  diagnostic?: DevelopmentDiagnostic | null; acceptanceLedger?: AcceptanceLedger; sessions?: Record<string, DevelopmentSessionReference>;
  needsReplan?: boolean; pendingPlan?: { plan: DevelopmentPlan; planHash: string } | null;
  pendingReview?: { mode: string; subjectHash: string; planHash: string | null; codeHash: string | null; reportId: string | null } | null;
  planningArtifact?: PlanningSnapshot; planningDraft?: PlanningDraft; planningDraftSource?: PlanningDraft; planningIndexPath?: string;
  planningDraftRecovery?: unknown; planningDraftCapture?: unknown; argumentDiagnostics?: UnknownRecord[];
  planDraftChecks?: ({ turn?: number; status?: string; hash: string | null } & UnknownRecord)[]; execution?: unknown; runtimeCheck?: unknown;
}
export type DevelopmentRole = "planner" | "developer" | "reviewer";
export interface DevelopmentSession extends PiSessionPort { sessionFile?: string | undefined; modelCallAccounting?: boolean; model?: { contextWindow?: number } | undefined }
export interface DevelopmentHandle<Result = unknown> {
  kind: DevelopmentRole; submitName: string; accepting: boolean; submitted: boolean; result: Result | undefined; counter: { turns: number }; limit: number; failed: boolean;
  turnsInPrompt: number; disposed: boolean; submissionCalls: Map<string, { value: unknown; recorded: boolean }>; planningBlocker?: unknown;
  checkToolInputs?: () => void; charge: (options?: { purpose?: string; retryAttempt?: number }) => Promise<void>;
  reference: DevelopmentSessionReference; validate: (value: unknown) => Result | Promise<Result>; session: DevelopmentSession; unsubscribe?: () => void;
  payload: DevelopmentContextPayload; contextMessage?: PreparedDevelopmentContext; contextMaxChars: number; structuredSubmissionTools: NeumaTool[];
  lastAssistant?: SessionMessage | undefined; retries?: number; failure?: { message: string; reason: string };
}
export interface DevelopmentContext { controller: AbortController; signal: AbortSignal; onProgress: (value: UnknownRecord) => void; handles: Set<DevelopmentHandle>;
  writes: Promise<void>; record: DevelopmentRunRecord; done: Promise<void>; finish(): void; planningWorkspace?: { empty: boolean; codeHash: string }; lastRole?: string }

/** Active delivery views do not require development-stage budgets or checkpoints. */
export interface DevelopmentDeliveryRecord extends Partial<Omit<DevelopmentRunRecord, "package" | "architecture">> {
  id: string; agentId: string; status: string; delivery: string; planHash: string | null; architectureRef: ArchitectureReference;
  architecture?: unknown;
  package: { codeHash: string; planHash: string; entrypoint?: string; application: unknown; snapshot: unknown; acceptanceLedger?: AcceptanceLedger };
}
export type DevelopmentSummaryRecord = Omit<DevelopmentDeliveryRecord, "package"> & {
  package?: Pick<DevelopmentDeliveryRecord["package"], "codeHash" | "planHash" | "entrypoint"> | null;
};
