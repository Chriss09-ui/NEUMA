import { types } from "node:util";
import { hashValue } from "../development/development-contract.mjs";

const bindingFields = ["agentId", "name", "sourceFingerprint", "draft", "requirements", "contractVersion", "candidateHash",
  "platformContractVersion", "platformHash", "platformSnapshot", "capabilityCatalogVersion", "capabilitySnapshot", "runtimeCapabilities",
  "confirmedRequirementContext", "deferredVerifications", "evidence", "modules", "researchGaps", "reviewContext", "reviewEvidence",
  "priorFindings", "issues", "developmentRevision"];

export const reviewCheckpointObject = (value) => value && typeof value === "object" && !types.isProxy(value) && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export function reviewCheckpointOwn(value, key) {
  if (!reviewCheckpointObject(value)) throw new TypeError("Invalid checkpoint object");
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable)) throw new TypeError("Invalid checkpoint field");
  return descriptor?.value;
}

/** Copy only inert JSON; checkpoint validation must never execute accessors or proxy traps. */
export function copyArchitectureReviewJson(value, { maxDepth = 64, maxNodes = 100_000, maxBytes = 2 * 1024 * 1024 } = {}) {
  const seen = new Set(); let nodes = 0;
  const copy = (item, depth) => {
    if (++nodes > maxNodes || depth > maxDepth) throw new TypeError("Checkpoint JSON exceeds limits");
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (!item || typeof item !== "object" || types.isProxy(item) || seen.has(item)) throw new TypeError("Invalid checkpoint JSON");
    const array = Array.isArray(item);
    if (array ? Object.getPrototypeOf(item) !== Array.prototype : !reviewCheckpointObject(item)) throw new TypeError("Invalid checkpoint JSON");
    const keys = Reflect.ownKeys(item), descriptors = Object.getOwnPropertyDescriptors(item);
    if (keys.some((key) => typeof key !== "string") || array && keys.length !== descriptors.length.value + 1)
      throw new TypeError("Invalid checkpoint JSON");
    seen.add(item);
    const result = array ? [] : {};
    for (const key of array ? Array.from({ length: descriptors.length.value }, (_, index) => String(index)) : keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("Invalid checkpoint JSON");
      Object.defineProperty(result, key, { value: copy(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    seen.delete(item);
    return result;
  };
  const result = copy(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw new TypeError("Checkpoint JSON exceeds limits");
  return result;
}

export function architectureReviewRecordBinding(record) {
  if (!reviewCheckpointObject(record)) return null;
  const agentId = reviewCheckpointOwn(record, "agentId"), candidateHash = reviewCheckpointOwn(record, "candidateHash"),
    architectureVersion = reviewCheckpointOwn(record, "version");
  if (typeof agentId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(agentId)
    || typeof candidateHash !== "string" || !/^[a-f0-9]{64}$/.test(candidateHash)
    || !Number.isSafeInteger(architectureVersion) || architectureVersion < 1) return null;
  const design = reviewCheckpointOwn(record, "design");
  if (!reviewCheckpointObject(design)) return null;
  const designHash = hashValue(copyArchitectureReviewJson(design));
  if (designHash !== candidateHash) return null;
  const binding = Object.fromEntries(bindingFields.map((key) => [key, copyArchitectureReviewJson(reviewCheckpointOwn(record, key) ?? null)]));
  if (Object.hasOwn(record, "feedbackLedger")) binding.feedbackLedger = copyArchitectureReviewJson(reviewCheckpointOwn(record, "feedbackLedger"));
  return { source: { agentId, architectureVersion, candidateHash }, bindingHash: hashValue({ ...binding, designHash }) };
}
