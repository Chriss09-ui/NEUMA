import type { AgentSession, AgentSessionEvent, ContextEvent, PromptOptions, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ModelConfig, ResolvedModelProfile } from "../contracts/model.mjs";
import type { UnknownRecord, JsonValue } from "../contracts/json.mjs";
import type { ToolSchema, ToolResult } from "../contracts/tools.mjs";
export interface NeumaTool {
  name: string; label: string; description: string; parameters: ToolSchema; executionMode?: "sequential" | "parallel";
  execute(id: string, input: unknown, signal?: AbortSignal): Promise<ToolResult>;
}
export type RegisteredTool = NeumaTool | ToolDefinition;
export interface SessionStorage { directory: string; binding: unknown; file?: string }
export interface RawToolInput { toolName: string; toolCallId: string; args: unknown }
export interface RawDecision { valid: boolean; reason?: string }
export interface ModelRequestRejection { reason: string; requestSent: boolean; source: string; causeReason: unknown; purpose: string; retryAttempt: number; used?: number; limit?: number }
export type Progress = (event: UnknownRecord) => void;
/** Injection uses the methods consumed by NEUMA, without private SDK fields or constructors. */
export interface PiSessionPort {
  prompt(text: string, options?: Pick<PromptOptions, "images">): Promise<unknown>;
  abort(): Promise<void>; dispose(): void;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  setAutoCompactionEnabled(enabled: boolean): void;
  getLastAssistantText(): string | undefined;
  readonly messages: AgentSession["messages"];
  modelCallAccounting?: boolean;
  readonly modelRequestRejection?: ModelRequestRejection;
  sessionBindingHash?: string;
  readonly sessionFile?: string | undefined;
}
export interface PiSessionOptions {
  config: ModelConfig; cwd: string; dataDir: string; manager?: ProjectManagerPort; turn?: ProjectTurn; customTools?: RegisteredTool[];
  systemPrompt?: string; maxOutputTokens?: number; reasoningMode?: "off" | "auto";
  sessionStorage?: SessionStorage;
  beforeModelRequest?: (event: { signal?: AbortSignal | null | undefined }) => unknown | Promise<unknown>;
  onModelCall?: (event: { signal?: AbortSignal | undefined; purpose?: string; retryAttempt?: number }) => unknown | Promise<unknown>;
  onToolDiagnostic?: (event: UnknownRecord) => unknown | Promise<unknown>;
  toolErrorResult?: (input: RawToolInput) => (ToolResult & { details: JsonValue }) | undefined | Promise<(ToolResult & { details: JsonValue }) | undefined>;
  rawInputValidators?: Record<string, (input: RawToolInput) => RawDecision | Promise<RawDecision>>;
  transformContext?: (messages: ContextEvent["messages"]) => ContextEvent["messages"] | undefined | Promise<ContextEvent["messages"] | undefined>;
  preparePrompt?: (text: string) => string | Promise<string>;
}
export type SessionFactory = (options: PiSessionOptions) => PiSessionPort | Promise<PiSessionPort>;
export type NeumaPiSession = AgentSession & { modelCallAccounting: boolean; modelProfile: ResolvedModelProfile; modelProfileHash: string; readonly modelRequestRejection?: ModelRequestRejection; sessionBindingHash?: string };
export interface ProjectSummary extends UnknownRecord {
  id: string; name: string; description: unknown; path: unknown; kind: unknown; status: unknown; canLaunch: unknown; canStop: unknown;
  url?: unknown; pageOpened?: unknown; openingPage?: unknown; openError?: unknown; setup?: unknown; error?: unknown;
}
export interface ProjectManagerPort {
  list(): Promise<ProjectSummary[]>;
  failures(input: { limit: unknown }): Promise<unknown>;
  runtime(options: { signal?: AbortSignal | undefined }): Promise<{ checkedAt: unknown; summary: unknown; warnings: unknown; projects: (ProjectSummary & { runtime: { state: string } })[]; ports: { port: number; processName: string; projects: { name: string }[] }[] }>;
  add(input: UnknownRecord, options: { signal?: AbortSignal | undefined; instructions: string; onProgress: Progress }): Promise<ProjectSummary>;
  inspect(id: unknown, options: { signal?: AbortSignal | undefined; instructions: string; onProgress: Progress }): Promise<ProjectSummary>;
  start(id: unknown): Promise<ProjectSummary>; stop(id: unknown): Promise<ProjectSummary>;
  remove(id: unknown, options: { removeOnly: unknown }): Promise<UnknownRecord>;
}
export interface ProjectTurn {
  message: string; onProgress?: Progress | null;
  actions: { tool: string; project: unknown }[];
  failedOperation?: UnknownRecord | null;
  removalNeedsConfirmation?: Set<unknown>;
}
