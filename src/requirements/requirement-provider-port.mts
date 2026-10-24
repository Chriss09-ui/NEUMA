import type { RequirementDraft, Consultation, EvidenceMessage, ProviderDiagnostic, PreflightResponse, RequirementIssue, RequirementHandoff, RequirementNote } from "../contracts/requirements.mjs";
import type { ModelConfig } from "../contracts/model.mjs";
import type { UnknownRecord } from "../contracts/json.mjs";
export interface ProviderConfig extends ModelConfig { chatUrl: string; model: string; apiKey: string; jevApiKey: string; jevModel: string; llmTimeoutMs: number; llmConfigured: boolean; jevConfigured: boolean }
export interface TurnInput { message: string; previousDraft: RequirementDraft; lastQuestion?: string | undefined; userMessages?: string[] | undefined; signal?: AbortSignal | undefined; evidenceMessages?: EvidenceMessage[] | undefined; consultation?: Consultation | null; platform?: unknown; taskSpecVersion?: number }
export interface GeneratedDraft extends UnknownRecord { draft?: unknown; proposedGap?: unknown; question?: unknown; answeredPoint?: unknown; confirmed?: unknown }
export interface JevScore { type: "score"; score: number; confidence: number; probabilities: Record<"0" | "1" | "2", number> }
export interface JevResult { model?: string; answers: { point_sufficiency: JevScore } }
export interface JudgeInput { message: string; draft: RequirementDraft; lastQuestion: string; userMessages: string[]; answeredPoint: string; signal?: AbortSignal | undefined }
export interface ReaskInput extends Omit<JudgeInput, "draft"> { score: number; confidence: number; probabilities: JevScore["probabilities"]; passLine: { score: number; confidence: number } }
export interface Providers {
  streamReply?: ((input: { summary: string; signal?: AbortSignal | undefined; onDelta?: ((text: string) => void) | undefined }) => Promise<string | undefined>) | undefined;
  generateDraft?(input: TurnInput): Promise<GeneratedDraft>;
  judgeJev?: ((input: JudgeInput) => Promise<unknown>) | null;
  decideReask?: ((input: ReaskInput) => Promise<unknown>) | null;
  getPlatform?: ((input: { draft: RequirementDraft; message: string }) => unknown | Promise<unknown>) | undefined;
  preflight?: ((input: PreflightInput) => Promise<PreflightResponse>) | undefined;
  research?: RequirementResearch | undefined;
  verifySystemIssues?: SystemVerifier | undefined;
}
export interface ReaskReview { used: boolean; reask: boolean; question: string | null; failure: ProviderDiagnostic | null }

export type RequirementResearch = (request: { query?: unknown; url?: unknown }, options: { signal?: AbortSignal | undefined; draft: RequirementDraft; platform: unknown }) => Promise<unknown>;
export type SystemVerifier = (input: { issues: RequirementIssue[]; draft: RequirementDraft; platform: unknown; verificationContext?: unknown; signal?: AbortSignal | undefined }) => Promise<unknown>;
export interface PreflightInput extends UnknownRecord { draft: RequirementDraft; platform: unknown; evidenceMessages?: EvidenceMessage[]; previousIssues?: RequirementIssue[]; priorDerivations?: unknown[]; consultationNotes?: RequirementNote[]; verificationContext?: unknown; handoff?: Consultation["handoff"] | null | undefined; signal?: AbortSignal | undefined; research?: RequirementResearch | undefined; verifySystemIssues?: SystemVerifier | undefined }
export type ProviderIntegrations = Pick<Providers, "research" | "verifySystemIssues" | "getPlatform">;
