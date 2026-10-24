import type { UnknownRecord } from "./json.mjs";
export interface ModelConfig extends UnknownRecord { chatUrl?: string; model?: string; apiKey?: string; modelAuthType?: string; modelProfile?: unknown; llmConfigured?: boolean; llmIdleTimeoutMs?: number; llmTimeoutMs?: number }
export interface ModelCompat {
  supportsStore?: boolean; supportsDeveloperRole?: boolean; supportsReasoningEffort?: boolean; supportsUsageInStreaming?: boolean;
  supportsFinishReason?: boolean; requiresToolResultName?: boolean; requiresAssistantAfterToolResult?: boolean;
  requiresThinkingAsText?: boolean; requiresReasoningContentOnAssistantMessages?: boolean; zaiToolStream?: boolean;
  supportsThinkingTokenBudget?: boolean; supportsOpenAIGrammarTools?: boolean; supportsMidConvoSystemMessages?: boolean;
  supportsMidConvoToolAdditions?: boolean; supportsStrictMode?: boolean; sendSessionAffinityHeaders?: boolean; supportsLongCacheRetention?: boolean;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  thinkingFormat?: "openai" | "openrouter" | "deepseek" | "together" | "baseten" | "zai" | "qwen" | "chat-template" | "qwen-chat-template" | "string-thinking" | "ant-ling";
  thinkingTokenBudgetField?: "thinking_token_budget" | "thinking_budget" | "thinking_budget_tokens";
  cacheControlFormat?: "anthropic"; sessionAffinityFormat?: "openai" | "openai-nosession" | "openrouter";
}
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface ModelCapabilities {
  schemaVersion: 1; api: "openai-completions"; contextWindow: number; maxOutputTokens: number; reasoning: boolean;
  input: ("text" | "image")[]; compat: ModelCompat; thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  inputLimits?: { maxRequestBytes?: number; images?: { maxPerMessage?: number; maxPerRequest?: number; resize?: { maxWidth?: number; maxHeight?: number; maxBytes?: number; jpegQuality?: number } } };
}
export interface ExplicitModelProfile extends ModelCapabilities, UnknownRecord { target: { chatUrl: string; model: string } }
export interface ResolvedModelProfile extends ModelCapabilities {
  source: { kind: "explicit" } | { kind: "fallback"; reason: string } | { kind: "pi-local-catalog"; provider: string; packageVersion: string; generatedAt: string | null };
  platformRequirements: { completeResponseFinishReason: true }; target: { baseUrl: string | null; model: string | null };
}
