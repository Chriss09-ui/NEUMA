import { normalizeTaskSpec } from "../requirements/task-spec.mjs";
import { validateDesign } from "../architecture/architecture-contract.mjs";
import { validatePlan } from "../development/development-contract.mjs";
import type { TaskSpecValidator, ArchitectureValidator, DevelopmentValidator, TaskSpecV1, ArchitectureDesignEnvelope, DevelopmentPlanEnvelope } from "../contracts/versions.mjs";

// Temporary M4 adapters. The existing validators perform the complete runtime checks;
// only their checked envelope is exposed here, without claiming the nested JS is typed.
export const domainValidators: { taskSpec: TaskSpecValidator; architecture: ArchitectureValidator; development: DevelopmentValidator } = {
  taskSpec: (input) => normalizeTaskSpec(input) as TaskSpecV1,
  architecture: (input, options) => validateDesign(input, options) as ArchitectureDesignEnvelope,
  development: (input, options) => validatePlan(input, options) as DevelopmentPlanEnvelope,
};
