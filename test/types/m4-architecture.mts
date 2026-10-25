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
import type { ArchitectureControllerPort } from "../../src/agents/prototype-port.mjs";
// 消费者端口只要求实际调用的方法集合：最小替身无需完整 ArchitectureDesigner 即可通过严格类型检查。
export function minimalArchitectureControllerDouble(): ArchitectureControllerPort {
  return {
    async get() { return null; },
    async getVersion() { return null; },
    async save(record) { void record; },
    async design(definition) { void definition; throw new Error("minimal double"); },
    async markReady(record) { return record; },
    async remove() {},
    ready: Promise.resolve(),
    persistence: Promise.resolve(),
  };
}
