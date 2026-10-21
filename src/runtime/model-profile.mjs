import { createHash } from "node:crypto";
import { findPackageJSON } from "node:module";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { InputError } from "../requirements/core.mjs";

const manifestPath = findPackageJSON("@earendil-works/pi-ai", import.meta.resolve("@earendil-works/pi-coding-agent"));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const catalog = await import(new URL(manifest.exports["./providers/*"].import.replace("*", "all"), pathToFileURL(manifestPath)).href);
const models = catalog.getBuiltinProviders().flatMap((provider) => catalog.getBuiltinModels(provider));
const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const booleanCompat = ["supportsStore", "supportsDeveloperRole", "supportsReasoningEffort", "supportsUsageInStreaming",
  "supportsFinishReason", "requiresToolResultName", "requiresAssistantAfterToolResult", "requiresThinkingAsText",
  "requiresReasoningContentOnAssistantMessages", "zaiToolStream", "supportsThinkingTokenBudget", "supportsOpenAIGrammarTools",
  "supportsMidConvoSystemMessages", "supportsMidConvoToolAdditions", "supportsStrictMode", "sendSessionAffinityHeaders", "supportsLongCacheRetention"];
const enumCompat = {
  maxTokensField: ["max_tokens", "max_completion_tokens"],
  thinkingFormat: ["openai", "openrouter", "deepseek", "together", "baseten", "zai", "qwen", "chat-template", "qwen-chat-template", "string-thinking", "ant-ling"],
  thinkingTokenBudgetField: ["thinking_token_budget", "thinking_budget", "thinking_budget_tokens"],
  cacheControlFormat: ["anthropic"], sessionAffinityFormat: ["openai", "openai-nosession", "openrouter"],
};
const cache = new Map();
const invalid = () => { throw new InputError("模型能力配置无效，请核对声明字段、类型和接口绑定"); };
const freeze = (value) => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const canonical = (value) => value && typeof value === "object" ? Array.isArray(value) ? value.map(canonical)
  : Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const modelProfileHash = (profile) => createHash("sha256").update(JSON.stringify(canonical(profile))).digest("hex");

function jsonCopy(value, depth = 0, budget = { nodes: 0, characters: 0 }) {
  if (depth > 8 || ++budget.nodes > 256) invalid();
  if (typeof value === "string" && (budget.characters += value.length) > 8192) invalid();
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object" || ![Object.prototype, Array.prototype].includes(Object.getPrototypeOf(value))) invalid();
  if (Array.isArray(value) && (Object.keys(value).length !== value.length || Object.keys(value).some((key, index) => key !== String(index)))) invalid();
  const output = Array.isArray(value) ? [] : {};
  for (const key of Object.keys(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid();
    if ((budget.characters += key.length) > 8192) invalid();
    output[key] = jsonCopy(descriptor.value, depth + 1, budget);
  }
  return output;
}
const exact = (value, allowed) => value && !Array.isArray(value) && typeof value === "object"
  && Object.keys(value).every((key) => allowed.includes(key));
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

function endpoint(value, chat = false) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    if (chat && !url.pathname.endsWith("/chat/completions")) return null;
    if (chat) url.pathname = url.pathname.slice(0, -"/chat/completions".length);
    return url.href.replace(/\/$/, "");
  } catch { return null; }
}

function checkedCompat(value = {}) {
  if (!exact(value, [...booleanCompat, ...Object.keys(enumCompat)])) invalid();
  if (value.supportsFinishReason !== undefined && value.supportsFinishReason !== true) invalid();
  for (const [key, entry] of Object.entries(value)) {
    if (booleanCompat.includes(key) ? typeof entry !== "boolean" : !enumCompat[key].includes(entry)) invalid();
  }
  return value;
}

/** Explicit profiles contain capability data only, bound to one exact endpoint and model. */
export function checkedModelProfile(value) {
  const profile = jsonCopy(value);
  if (Number.isSafeInteger(profile?.contextWindow) && profile.contextWindow < 8192)
    throw new InputError("模型能力配置无效：当前 Pi 运行器需要至少 8192 的上下文空间，其中须保留 SDK 安全余量");
  if (Buffer.byteLength(JSON.stringify(profile)) > 8192 || !exact(profile,
    ["schemaVersion", "target", "api", "contextWindow", "maxOutputTokens", "reasoning", "input", "compat", "thinkingLevelMap"])) invalid();
  if (profile.schemaVersion !== 1 || profile.api !== "openai-completions" || !exact(profile.target, ["chatUrl", "model"])
    || typeof profile.target.chatUrl !== "string" || !endpoint(profile.target.chatUrl, true)
    || typeof profile.target.model !== "string" || !/^[\w.:/@-]{1,200}$/.test(profile.target.model)
    || !integer(profile.contextWindow, 8192, 16_777_216) || !integer(profile.maxOutputTokens, 256, profile.contextWindow)
    || typeof profile.reasoning !== "boolean" || !Array.isArray(profile.input) || !profile.input.includes("text")
    || profile.input.some((item) => !["text", "image"].includes(item)) || new Set(profile.input).size !== profile.input.length) invalid();
  profile.target.chatUrl = endpoint(profile.target.chatUrl, true) + "/chat/completions";
  profile.input = ["text", ...(profile.input.includes("image") ? ["image"] : [])];
  profile.compat = checkedCompat(profile.compat);
  if (profile.thinkingLevelMap !== undefined) {
    if (!exact(profile.thinkingLevelMap, levels) || Object.values(profile.thinkingLevelMap).some((item) => item !== null
      && (typeof item !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(item)))) invalid();
  }
  return freeze(profile);
}

export function readModelProfile(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || Buffer.byteLength(value) > 8192) invalid();
  try { return checkedModelProfile(JSON.parse(value)); } catch { invalid(); }
}

export function resolvedModelProfile(config = {}) {
  const baseUrl = endpoint(config.chatUrl, true), model = typeof config.model === "string" ? config.model : null;
  const explicit = config.modelProfile === undefined || config.modelProfile === null ? null : checkedModelProfile(config.modelProfile);
  const key = JSON.stringify([baseUrl, model, explicit]);
  if (cache.has(key)) return cache.get(key);
  const matches = baseUrl ? models.filter((entry) => entry.api === "openai-completions" && entry.id === model && endpoint(entry.baseUrl) === baseUrl) : [];
  let profile;
  if (matches.length === 1) {
    const entry = matches[0];
    profile = { schemaVersion: 1, source: { kind: "pi-local-catalog", provider: entry.provider, packageVersion: manifest.version,
      generatedAt: catalog.getBuiltinModelDataGeneratedAt() ?? null }, api: entry.api, contextWindow: entry.contextWindow,
    maxOutputTokens: entry.maxTokens, reasoning: entry.reasoning, input: [...entry.input], compat: structuredClone(entry.compat ?? {}),
    ...(entry.thinkingLevelMap ? { thinkingLevelMap: structuredClone(entry.thinkingLevelMap) } : {}),
    ...(entry.inputLimits ? { inputLimits: structuredClone(entry.inputLimits) } : {}) };
  } else if (explicit && endpoint(explicit.target.chatUrl, true) === baseUrl && explicit.target.model === model) {
    const { target, ...capabilities } = explicit;
    profile = { ...capabilities, source: { kind: "explicit" } };
  } else {
    profile = { schemaVersion: 1, source: { kind: "fallback", reason: explicit ? "explicit_target_mismatch" : matches.length ? "catalog_ambiguous" : "catalog_not_found" },
      api: "openai-completions", contextWindow: 32_768, maxOutputTokens: 16_384, reasoning: false, input: ["text"],
      compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: "max_tokens" } };
  }
  // Complete-response markers are a platform submission requirement, not a vendor capability claim.
  profile.platformRequirements = { completeResponseFinishReason: true };
  profile.compat = { ...profile.compat, supportsFinishReason: true };
  profile.target = { baseUrl, model };
  const result = freeze(profile);
  if (cache.size >= 128) cache.clear();
  cache.set(key, result);
  return result;
}
