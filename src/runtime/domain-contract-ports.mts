import { normalizeTaskSpec } from "../requirements/task-spec.mjs";
import { validateDesign } from "../architecture/architecture-contract.mjs";
import { validatePlan } from "../development/development-contract.mjs";
// M4 validators now expose their complete checked domain types directly.
export const domainValidators = {
  taskSpec: normalizeTaskSpec,
  architecture: validateDesign,
  development: validatePlan,
};
