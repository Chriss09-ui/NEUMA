import { hashValue } from "../development/development-contract.mjs";
import { copyArchitectureReviewJson as jsonCopy, architectureReviewRecordBinding as recordBinding,
  reviewCheckpointObject as object, reviewCheckpointOwn as own } from "./architecture-review-binding.mjs";
import { readMainReviewCheckpoint, mainReviewCheckpointMatches } from "./architecture-main-review-checkpoint.mjs";
import { architectureFidelityContextVersion } from "./architecture-fidelity-context.mjs";

const MAX_BYTES = 64 * 1024;
const diagnosticLimits = { maxDepth: 16, maxNodes: 5000, maxBytes: 32 * 1024 };
const progressFields = ["schemaVersion", "source", "bindingHash", "state", "parentModelCalls", "hash"];
const sourceFields = ["agentId", "architectureVersion", "candidateHash", "reviewHash"];
const stateFields = ["contextHash", "schemaHash", "sessionFile", "sessionBindingHash", "calls", "diagnostic"];
const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const count = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const exact = (value, keys) => object(value) && Reflect.ownKeys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));

function stateCopy(state) {
  const value = jsonCopy(state, { maxDepth: 18, maxNodes: 5010, maxBytes: MAX_BYTES });
  const contextVersion = architectureFidelityContextVersion(value);
  if (!exact(value, contextVersion ? [...stateFields, "contextVersion"] : stateFields) || !hash(value.contextHash) || !hash(value.schemaHash) || !hash(value.sessionBindingHash)
    || !count(value.calls, 2) || typeof value.sessionFile !== "string" || value.sessionFile.length > 255
    || !/^[A-Za-z0-9_.-]+\.jsonl$/.test(value.sessionFile) || !object(value.diagnostic))
    throw new TypeError("Invalid fidelity progress state");
  value.diagnostic = jsonCopy(value.diagnostic, diagnosticLimits);
  return value;
}

function mainCheckpoint(record, sameVersion) {
  if (sameVersion) return readMainReviewCheckpoint(record);
  const checkpoint = own(record, "mainReviewCheckpoint");
  return mainReviewCheckpointMatches(checkpoint, record) ? jsonCopy(checkpoint) : null;
}

function checkedProgress(progress, record, sameVersion) {
  const value = jsonCopy(progress, { maxDepth: 20, maxNodes: 5030, maxBytes: MAX_BYTES }), current = recordBinding(record),
    checkpoint = mainCheckpoint(record, sameVersion);
  if (!current || !checkpoint || !exact(value, progressFields) || value.schemaVersion !== 1 || !exact(value.source, sourceFields)
    || !Number.isSafeInteger(value.source.architectureVersion) || value.source.architectureVersion < 1
    || value.source.agentId !== current.source.agentId || value.source.candidateHash !== current.source.candidateHash
    || sameVersion && value.source.architectureVersion !== current.source.architectureVersion
    || !hash(value.source.reviewHash) || value.source.reviewHash !== checkpoint.reviewHash
    || !hash(value.bindingHash) || value.bindingHash !== current.bindingHash || !hash(value.hash)
    || !count(value.parentModelCalls, 12)) return null;
  const state = stateCopy(value.state);
  if (value.parentModelCalls < state.calls) return null;
  const { hash: savedHash, ...body } = value;
  return hashValue(body) === savedHash ? value : null;
}

/** A bound native-session reference and safe diagnostics; it grants no fidelity or review status. */
export function createArchitectureFidelityProgress(record, state, parentModelCalls) {
  try {
    const current = recordBinding(record), checkpoint = mainCheckpoint(record, true), savedState = stateCopy(state);
    if (!current || !checkpoint || !count(parentModelCalls, 12) || parentModelCalls < savedState.calls) return null;
    const body = { schemaVersion: 1, source: { ...current.source, reviewHash: checkpoint.reviewHash },
      bindingHash: current.bindingHash, state: savedState, parentModelCalls };
    const progress = { ...body, hash: hashValue(body) };
    return Buffer.byteLength(JSON.stringify(progress)) <= MAX_BYTES ? progress : null;
  } catch { return null; }
}

export function readArchitectureFidelityProgress(record) {
  try { return checkedProgress(own(record, "requirementFidelityProgress"), record, true); }
  catch { return null; }
}

export function architectureFidelityProgressMatches(progress, record) {
  try { return checkedProgress(progress, record, false) !== null; }
  catch { return false; }
}
