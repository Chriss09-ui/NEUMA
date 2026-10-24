import type { ArchitectureDesign } from "../../src/contracts/architecture.mjs";
import type { Consultation } from "../../src/contracts/requirements.mjs";
import { validateDesign } from "../../src/architecture/architecture-contract.mjs";
import { checkedConsultation } from "../../src/requirements/consultation-storage.mjs";
export function requireCheckedDomainValues(raw: unknown) {
  // @ts-expect-error A persisted object must pass the consultation shape boundary.
  const unchecked: Consultation = raw;
  // @ts-expect-error A version tag alone is not a complete validated architecture.
  const incomplete: ArchitectureDesign = { schemaVersion: 3, profile: "custom" };
  void unchecked; void incomplete;
  return { consultation: checkedConsultation(raw), design: validateDesign(raw) };
}
export function versionSpecificFields(design: ArchitectureDesign) {
  if (design.schemaVersion === 3) return design.execution.hosting;
  // @ts-expect-error Legacy and v2 architecture have no modern execution choice.
  return design.execution.hosting;
}
