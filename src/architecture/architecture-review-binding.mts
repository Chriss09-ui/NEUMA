import type { UnknownRecord, JsonValue } from "../contracts/json.mjs";
import { objectFields, isInteger } from "../runtime/type-boundary.mjs";
import { types } from "node:util";
import { hashValue } from "../development/development-contract.mjs";

const bindingFields = ["agentId", "name", "sourceFingerprint", "draft", "requirements", "contractVersion", "candidateHash",
  "platformContractVersion", "platformHash", "platformSnapshot", "capabilityCatalogVersion", "capabilitySnapshot", "runtimeCapabilities",
  "confirmedRequirementContext", "deferredVerifications", "evidence", "modules", "researchGaps", "reviewContext", "reviewEvidence",
  "priorFindings", "issues", "developmentRevision"];

export const reviewCheckpointObject = (value: unknown): value is UnknownRecord => Boolean(value) && typeof value === "object" && !types.isProxy(value) && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export function reviewCheckpointOwn(value: unknown, key: PropertyKey): unknown {
  if (!reviewCheckpointObject(value)) throw new TypeError("Invalid checkpoint object");
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable)) throw new TypeError("Invalid checkpoint field");
  return descriptor?.value;
}

/** Copy only inert JSON; checkpoint validation must never execute accessors or proxy traps. */
export function copyArchitectureReviewJson<T>(value: T, { maxDepth = 64, maxNodes = 100_000, maxBytes = 2 * 1024 * 1024 } = {}): T {
  const seen = new Set(); let nodes = 0;
  const copy = (item: unknown, depth: number): JsonValue => {
    if (++nodes > maxNodes || depth > maxDepth) throw new TypeError("Checkpoint JSON exceeds limits");
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (!item || typeof item !== "object" || types.isProxy(item) || seen.has(item)) throw new TypeError("Invalid checkpoint JSON");
    const array = Array.isArray(item);
    if (array ? Object.getPrototypeOf(item) !== Array.prototype : !reviewCheckpointObject(item)) throw new TypeError("Invalid checkpoint JSON");
    const keys = Reflect.ownKeys(item), descriptors = Object.getOwnPropertyDescriptors(item);
    if (keys.some((key) => typeof key !== "string") || array && keys.length !== descriptors.length!.value + 1)
      throw new TypeError("Invalid checkpoint JSON");
    seen.add(item);
    const result: JsonValue = array ? [] : {};
    for (const key of array ? Array.from({ length: descriptors.length!.value }, (_, index) => String(index)) : keys) {
      const descriptor = typeof key === "string" ? descriptors[key] : undefined;
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("Invalid checkpoint JSON");
      Object.defineProperty(result, key, { value: copy(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    seen.delete(item);
    return result;
  };
  const result = copy(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw new TypeError("Checkpoint JSON exceeds limits");
  return result as T;
}

export function architectureReviewRecordBinding(record: unknown) {
  if (!reviewCheckpointObject(record)) return null;
  const agentId = reviewCheckpointOwn(record, "agentId"), candidateHash = reviewCheckpointOwn(record, "candidateHash"),
    architectureVersion = reviewCheckpointOwn(record, "version");
  if (typeof agentId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(agentId)
    || typeof candidateHash !== "string" || !/^[a-f0-9]{64}$/.test(candidateHash)
    || !isInteger(architectureVersion) || architectureVersion < 1) return null;
  const design = reviewCheckpointOwn(record, "design");
  if (!reviewCheckpointObject(design)) return null;
  const designHash = hashValue(copyArchitectureReviewJson(design));
  if (designHash !== candidateHash) return null;
  const binding: UnknownRecord = Object.fromEntries(bindingFields.map((key) => [key, copyArchitectureReviewJson(reviewCheckpointOwn(record, key) ?? null)]));
  if (Object.hasOwn(record, "feedbackLedger")) binding.feedbackLedger = copyArchitectureReviewJson(reviewCheckpointOwn(record, "feedbackLedger"));
  return { source: { agentId, architectureVersion, candidateHash }, bindingHash: hashValue({ ...binding, designHash }) };
}

/** Storage bounds only; the controller must also verify every authorization against its source version. */
export function architectureReviewStoredCallLimit(record: unknown) {
  try {
    const grant = objectFields(copyArchitectureReviewJson(reviewCheckpointOwn(record, "reviewRetryCheckpoint"), { maxDepth: 5, maxNodes: 40, maxBytes: 4096 }));
    const { hash, ...body } = grant, source = objectFields(grant.source);
    const limit = typeof source.modelCalls === "number" && typeof grant.additionalCalls === "number" ? source.modelCalls + grant.additionalCalls : NaN;
    const recordVersion = reviewCheckpointOwn(record, "version");
    if (grant.schemaVersion === 3 && grant.additionalCalls === 5 && hash === hashValue(body)
      && Object.keys(grant).sort().join() === "additionalCalls,bindingHash,hash,previousCheckpointHash,schemaVersion,source"
      && Object.keys(source).sort().join() === "candidateHash,modelCalls,progressHash,version"
      && [grant.bindingHash, grant.previousCheckpointHash, source.progressHash].every(value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value))
      && source.candidateHash === reviewCheckpointOwn(record, "candidateHash")
      && isInteger(source.version) && source.version > 0 && typeof recordVersion === "number" && source.version < recordVersion
      && isInteger(source.modelCalls) && source.modelCalls >= 7 && Number.isSafeInteger(limit)) return Math.max(12, limit);
  } catch { /* Invalid authorizations cannot expand the legacy storage bound. */ }
  return 12;
}
