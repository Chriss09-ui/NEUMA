import type { DevelopmentPlan } from "../contracts/development.mjs";
import { InputError } from "../requirements/core.mjs";
import { planningAdmissionFacts } from "../development/development-fixtures.mjs";

export function planReviewSubject(architectureRef: unknown, plan: DevelopmentPlan, planHash: string, version = 1) {
  if (![1, 2].includes(version)) throw new InputError("独立计划评审绑定版本无效");
  return { mode: "plan", architectureRef, plan, planHash,
    ...(version === 2 ? { admissionFacts: planningAdmissionFacts(plan) } : {}) };
}
