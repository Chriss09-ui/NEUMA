import type { ModelConfig } from "../contracts/model.mjs";
import { resolvedModelProfile } from "./model-profile.mjs";
export { resolvedModelProfile, modelProfileHash } from "./model-profile.mjs";

export function knownModelLimits(config: ModelConfig = {}) {
  const profile = resolvedModelProfile(config);
  return profile.source.kind === "fallback" ? null : profile;
}

export function modelOutputBudget(config: ModelConfig, fallback = 4096) {
  return Math.min(resolvedModelProfile(config).maxOutputTokens, fallback);
}

export function reasoningModelOutputBudget(config: ModelConfig, base = 4096) {
  return modelOutputBudget(config, resolvedModelProfile(config).reasoning ? base * 4 : base);
}

export function architectureModelOutputBudget(config: ModelConfig, role: string) {
  const fallbackBudgets: Record<string, number> = { designer: 8192, reviewer: 4096, module: 4096, specialist: 4096 };
  if (!Object.hasOwn(fallbackBudgets, role)) throw new TypeError("架构角色无效");
  const profile = resolvedModelProfile(config);
  // 思考与正式结果共用输出额度；已核实能力时使用模型上限，不再叠加角色上限。
  return profile.source.kind === "fallback" ? Math.min(profile.maxOutputTokens, fallbackBudgets[role]!) : profile.maxOutputTokens;
}

export function developmentModelOutputBudget(config: ModelConfig, role: string) {
  const budgets: Record<string, number> = { planner: 8192, developer: 16384, reviewer: 4096 };
  if (!Object.hasOwn(budgets, role)) throw new TypeError("研发角色无效");
  return reasoningModelOutputBudget(config, budgets[role]!);
}
