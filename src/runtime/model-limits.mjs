import { resolvedModelProfile } from "./model-profile.mjs";
export { resolvedModelProfile, modelProfileHash } from "./model-profile.mjs";

export function knownModelLimits(config = {}) {
  const profile = resolvedModelProfile(config);
  return profile.source.kind === "fallback" ? null : profile;
}

export function modelOutputBudget(config, fallback = 4096) {
  return Math.min(resolvedModelProfile(config).maxOutputTokens, fallback);
}

export function reasoningModelOutputBudget(config, base = 4096) {
  return modelOutputBudget(config, resolvedModelProfile(config).reasoning ? base * 4 : base);
}

export function architectureModelOutputBudget(config, role) {
  const budgets = { designer: 8192, reviewer: 4096, module: 4096, specialist: 4096 };
  if (!Object.hasOwn(budgets, role)) throw new TypeError("架构角色无效");
  return reasoningModelOutputBudget(config, budgets[role]);
}

export function developmentModelOutputBudget(config, role) {
  const budgets = { planner: 8192, developer: 16384, reviewer: 4096 };
  if (!Object.hasOwn(budgets, role)) throw new TypeError("研发角色无效");
  return reasoningModelOutputBudget(config, budgets[role]);
}
