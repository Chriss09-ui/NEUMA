import type { ModelConfig } from "../contracts/model.mjs";
import type { UnknownRecord, JsonValue } from "../contracts/json.mjs";
import type { ToolSchema, ToolResult } from "../contracts/tools.mjs";
export interface NeumaTool {
  name: string; label: string; description: string; parameters: ToolSchema; executionMode?: "sequential" | "parallel";
  execute(id: string, input: unknown, signal?: AbortSignal, onUpdate?: unknown, context?: unknown): Promise<ToolResult>;
}
export type RegisteredTool = NeumaTool;
export interface SessionStorage { directory: string; binding: unknown; file?: string }
export interface RawToolInput { toolName: string; toolCallId: string; args: unknown }
export interface RawDecision { valid: boolean; reason?: string }
export interface ModelRequestRejection { reason: string; requestSent: boolean; source: string; causeReason: unknown; purpose: string; retryAttempt: number; used?: number; limit?: number }
export type Progress = (event: UnknownRecord) => void;
export type SessionContentPart = { type: "text"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown }
  | { type: "thinking"; thinking: string }
  | { type: "image"; data: string; mimeType: string };
/** Only lifecycle/error/text/tool receipt fields consumed by the host cross the injection port. */
export interface SessionMessage { role: string; content?: string | SessionContentPart[] | undefined; stopReason?: string | undefined; errorMessage?: string | undefined;
  toolName?: string | undefined; toolCallId?: string | undefined; isError?: boolean | undefined; usage?: { output?: number | undefined } | undefined }
export type AssistantSessionMessage = Omit<SessionMessage, "role" | "content"> & { role: "assistant"; content?: SessionContentPart[] | undefined };
/** Stable NEUMA event vocabulary. SDK-only events never reach business controllers. */
interface SessionEventFields {
  message?: AssistantSessionMessage | (SessionMessage & { role: "user" | "toolResult" | "custom" | "compactionSummary" | "branchSummary" | "bashExecution" | "system" }) | undefined;
  assistantMessageEvent?: { type: string; delta?: string | undefined } | undefined;
  errorMessage?: string | undefined; finalError?: string | undefined; toolName?: string | undefined; toolCallId?: string | undefined;
  args?: unknown; isError?: boolean | undefined; success?: boolean | undefined; attempt?: number | undefined;
  maxAttempts?: number | undefined; delayMs?: number | undefined; willRetry?: boolean | undefined;
}
export type SessionEvent = SessionEventFields & (
  { type: "tool_execution_end"; result?: { content?: { type: string; text?: string | undefined }[] | undefined } | undefined }
  | { type: "message_start" | "message_update" | "message_end" | "turn_start" | "turn_end" | "tool_execution_start" | "tool_execution_update"
      | "agent_start" | "agent_end" | "agent_settled" | "queue_update" | "entry_appended" | "session_info_changed" | "thinking_level_changed"
      | "compaction_start" | "compaction_end" | "auto_retry_start" | "auto_retry_end" | "summarization_retry_scheduled"
      | "summarization_retry_attempt_start" | "summarization_retry_finished" | "bash_execution_update"; result?: unknown }
);
export interface ContextEvent { messages: (SessionMessage & { timestamp?: number; summary?: string })[] }
export interface ExecutionCapabilities { version: 1; accounting: true; rawInputValidation: true; boundSessions: true }
/** Injection uses the methods consumed by NEUMA, without private SDK fields or constructors. */
export interface ExecutionSession {
  prompt(text: string, options?: { images?: { type: "image"; data: string; mimeType: string }[] }): Promise<unknown>;
  abort(): void | Promise<void>; dispose(): void | Promise<void>;
  subscribe?(listener: (event: SessionEvent) => void): () => void;
  setAutoCompactionEnabled?(enabled: boolean): void;
  getLastAssistantText?(): string | undefined;
  readonly messages?: SessionMessage[];
  modelCallAccounting?: boolean;
  readonly capabilities?: ExecutionCapabilities;
  readonly model?: { contextWindow?: number } | undefined;
  readonly modelRequestRejection?: ModelRequestRejection | undefined;
  sessionBindingHash?: string;
  readonly sessionFile?: string | undefined;
}
/** Independent verification only consumes prompt and probes the remaining lifecycle/history hooks. */
export type VerificationSessionPort = Pick<ExecutionSession, "prompt"> & Partial<Pick<ExecutionSession,
  "abort" | "dispose" | "subscribe" | "setAutoCompactionEnabled" | "messages" | "modelCallAccounting" | "sessionBindingHash" | "sessionFile">>;
export type VerificationSessionFactory = (options: ExecutionOptions) => VerificationSessionPort | Promise<VerificationSessionPort>;
export interface ExecutionOptions {
  config: ModelConfig; cwd: string; dataDir: string; manager?: ProjectManagerPort; turn?: ProjectTurn; customTools?: RegisteredTool[];
  systemPrompt?: string; maxOutputTokens?: number; reasoningMode?: "off" | "auto";
  sessionStorage?: SessionStorage;
  beforeModelRequest?: (event: { signal?: AbortSignal | null | undefined }) => unknown | Promise<unknown>;
  onModelCall?: (event?: { signal?: AbortSignal | undefined; purpose?: string; retryAttempt?: number }) => unknown | Promise<unknown>;
  onToolDiagnostic?: (event: UnknownRecord) => unknown | Promise<unknown>;
  toolErrorResult?: (input: RawToolInput) => (ToolResult & { details: JsonValue }) | undefined | Promise<(ToolResult & { details: JsonValue }) | undefined>;
  rawInputValidators?: Record<string, (input: RawToolInput) => RawDecision | Promise<RawDecision>>;
  transformContext?: (messages: ContextEvent["messages"]) => ContextEvent["messages"] | undefined | Promise<ContextEvent["messages"] | undefined>;
  preparePrompt?: (text: string) => string | Promise<string>;
}
export type SessionFactory = (options: ExecutionOptions) => ExecutionSession | Promise<ExecutionSession>;
export interface ProjectSummary extends UnknownRecord {
  id?: string | undefined; name?: string | undefined; description?: unknown; path?: unknown; kind?: unknown; status?: unknown; canLaunch?: unknown; canStop?: unknown;
  url?: unknown; pageOpened?: unknown; openingPage?: unknown; openError?: unknown; setup?: unknown; error?: unknown;
}
export interface ProjectManagerPort {
  list?(): Promise<ProjectSummary[]>;
  failures?(input: { limit: unknown }): Promise<unknown>;
  runtime?(options: { signal?: AbortSignal | undefined }): Promise<{ checkedAt: unknown; summary?: unknown; warnings: unknown; projects?: (ProjectSummary & { runtime: { state: string } })[]; ports?: { port: number; processName: string; projects: { name: string }[] }[] }>;
  add?(input: UnknownRecord, options: { signal?: AbortSignal | undefined; instructions?: string; onProgress?: Progress }): Promise<ProjectSummary>;
  inspect?(id: unknown, options: { signal?: AbortSignal | undefined; instructions?: string; onProgress?: Progress }): Promise<ProjectSummary>;
  start?(id: unknown): Promise<ProjectSummary>; stop?(id: unknown): Promise<ProjectSummary>;
  remove?(id: unknown, options: { removeOnly: unknown }): Promise<UnknownRecord>;
}
export interface ProjectTurn {
  message?: string; onProgress?: Progress | null;
  actions: { tool: string; project: unknown }[];
  failedOperation?: UnknownRecord | null;
  removalNeedsConfirmation?: Set<unknown>;
}

/** Compatibility names for existing injected clients; owned by NEUMA. */
export type PiSessionPort = ExecutionSession;
export type PiSessionOptions = ExecutionOptions;
