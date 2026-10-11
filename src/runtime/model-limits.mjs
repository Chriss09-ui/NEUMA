const MIMO_V2_6_PRO = Object.freeze({
  contextWindow: 1_048_576,
  maxOutputTokens: 131_072,
  compat: Object.freeze({ maxTokensField: "max_completion_tokens",
    requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" }),
});

export function knownModelLimits(config = {}) {
  try {
    return new URL(config.chatUrl).hostname === "api.xiaomimimo.com" && config.model === "mimo-v2.6-pro"
      ? MIMO_V2_6_PRO : null;
  } catch { return null; }
}

export function modelOutputBudget(config, fallback = 4096) {
  return knownModelLimits(config)?.maxOutputTokens ?? fallback;
}
