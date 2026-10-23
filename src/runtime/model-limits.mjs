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
  // 思考与正式结果共用输出额度，设计及模块咨询需要给最终提交留出空间。
  const budgets = resolvedModelProfile(config).reasoning
    ? { designer: 65_536, reviewer: 16_384, module: 32_768, specialist: 32_768 }
    : { designer: 8192, reviewer: 4096, module: 4096, specialist: 4096 };
  if (!Object.hasOwn(budgets, role)) throw new TypeError("架构角色无效");
  return modelOutputBudget(config, budgets[role]);
}

export function developmentModelOutputBudget(config, role) {
  const budgets = { planner: 8192, developer: 16384, reviewer: 4096 };
  if (!Object.hasOwn(budgets, role)) throw new TypeError("研发角色无效");
  return reasoningModelOutputBudget(config, budgets[role]);
}
