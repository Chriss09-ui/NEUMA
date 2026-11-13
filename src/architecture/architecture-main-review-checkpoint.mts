import type { UnknownRecord } from "../contracts/json.mjs";
import { isInteger } from "../runtime/type-boundary.mjs";
import { judgmentApprovesReview } from "./architecture-review-judgment.mjs";
interface MainReviewCheckpoint { schemaVersion: 1 | 2; groupJudgmentHash?: string; source: { agentId: string; architectureVersion: number; candidateHash: string }; bindingHash: string; reviewHash: string; review: UnknownRecord & { verdict: "pass"; candidateHash: string }; modelCalls: number; fidelityStatus: "pending" | "not_preserved"; fidelityEvidence: unknown; hash: string }
import { hashValue } from "../development/development-contract.mjs";
import { copyArchitectureReviewJson as jsonCopy, architectureReviewRecordBinding as recordBinding,
  reviewCheckpointObject as object, reviewCheckpointOwn as own, architectureReviewStoredCallLimit } from "./architecture-review-binding.mjs";

const sourceMaxBytes = 2 * 1024 * 1024;
export const MAIN_REVIEW_CHECKPOINT_MAX_BYTES = 2 * sourceMaxBytes + 64 * 1024;
const checkpointFields = ["schemaVersion", "source", "bindingHash", "reviewHash", "review", "modelCalls", "fidelityStatus", "fidelityEvidence", "hash"];
const sourceFields = ["agentId", "architectureVersion", "candidateHash"];
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const version = (value: unknown): value is number => isInteger(value) && value >= 1;
const calls = (value: unknown, record: unknown, review?: unknown): value is number => isInteger(value) && value >= 0
  && (value > 0 || judgmentApprovesReview(record, review)) && value <= architectureReviewStoredCallLimit(record);
const fidelity = (status: unknown, evidence: unknown) => status === "pending" ? evidence === null
  : status === "not_preserved" && object(evidence) && ["narrowed", "unproven"].some(verdict => verdict === evidence.verdict) && hash(evidence.contextHash);

function exact(value: unknown, keys: string[]): value is UnknownRecord {
  return object(value) && Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function checkedCheckpoint(checkpoint: unknown, record: unknown, sameVersion: boolean): MainReviewCheckpoint | null {
  const grouped = own(checkpoint, "schemaVersion") === 2, fields = grouped ? [...checkpointFields, "groupJudgmentHash"] : checkpointFields;
  if (!exact(checkpoint, fields)) return null;
  const value = Object.fromEntries(fields.map((key) => [key, jsonCopy(own(checkpoint, key),
    ["review", "fidelityEvidence"].includes(key) ? { maxBytes: sourceMaxBytes } : { maxBytes: 64 * 1024, maxNodes: 64, maxDepth: 8 })]));
  const current = recordBinding(record);
  if (!current || !exact(value, fields) || value.schemaVersion !== (grouped ? 2 : 1) || !exact(value.source, sourceFields)
    || grouped && (!hash(value.groupJudgmentHash) || value.groupJudgmentHash !== own(own(record, "reviewJudgmentCheckpoint"), "hash")
      || !judgmentApprovesReview(record, value.review))
    || !grouped && value.modelCalls === 0
    || !version(value.source.architectureVersion) || !calls(value.modelCalls, record, value.review) || !fidelity(value.fidelityStatus, value.fidelityEvidence)
    || value.source.agentId !== current.source.agentId || value.source.candidateHash !== current.source.candidateHash
    || sameVersion && value.source.architectureVersion !== current.source.architectureVersion
    || !hash(value.bindingHash) || value.bindingHash !== current.bindingHash || !hash(value.reviewHash) || !hash(value.hash)
    || !object(value.review) || Buffer.byteLength(JSON.stringify(value.review)) > sourceMaxBytes
    || value.fidelityEvidence !== null && Buffer.byteLength(JSON.stringify(value.fidelityEvidence)) > sourceMaxBytes
    || value.review.verdict !== "pass" || value.review.candidateHash !== current.source.candidateHash
    || hashValue(value.review) !== value.reviewHash || Buffer.byteLength(JSON.stringify(value)) > MAIN_REVIEW_CHECKPOINT_MAX_BYTES) return null;
  const { hash: savedHash, ...body } = value;
  return hashValue(body) === savedHash ? { ...value, schemaVersion: grouped ? 2 : 1, ...(grouped ? { groupJudgmentHash: String(value.groupJudgmentHash) } : {}), source: { agentId: current.source.agentId, architectureVersion: value.source.architectureVersion, candidateHash: current.source.candidateHash }, bindingHash: value.bindingHash, reviewHash: value.reviewHash, review: { ...value.review, verdict: "pass", candidateHash: current.source.candidateHash }, modelCalls: value.modelCalls, fidelityStatus: value.fidelityStatus === "pending" ? "pending" : "not_preserved", fidelityEvidence: value.fidelityEvidence, hash: savedHash } : null;
}

/** The caller validates the fully resolved review; this checkpoint grants no review or delivery status. */
export function createMainReviewCheckpoint(record: unknown, review: unknown, modelCalls: unknown, options: unknown = {}) {
  try {
    const suppliedStatus = own(options, "fidelityStatus"), fidelityStatus = suppliedStatus === undefined ? "pending" : suppliedStatus;
    const suppliedEvidence = own(options, "fidelityEvidence"), fidelityEvidence = suppliedEvidence === undefined ? null : jsonCopy(suppliedEvidence);
    const current = recordBinding(record), savedReview = jsonCopy(review);
    if (!current || !calls(modelCalls, record, savedReview) || !fidelity(fidelityStatus, fidelityEvidence) || !object(savedReview) || savedReview.verdict !== "pass"
      || savedReview.candidateHash !== current.source.candidateHash) return null;
    const grouped = judgmentApprovesReview(record, savedReview);
    const body = { schemaVersion: grouped ? 2 : 1, ...(grouped ? { groupJudgmentHash: own(own(record, "reviewJudgmentCheckpoint"), "hash") } : {}), source: current.source, bindingHash: current.bindingHash,
      reviewHash: hashValue(savedReview), review: savedReview, modelCalls, fidelityStatus, fidelityEvidence };
    const checkpoint = { ...body, hash: hashValue(body) };
    return Buffer.byteLength(JSON.stringify(checkpoint)) <= MAIN_REVIEW_CHECKPOINT_MAX_BYTES ? checkpoint : null;
  } catch { return null; }
}

export function readMainReviewCheckpoint(record: unknown) {
  try { return checkedCheckpoint(own(record, "mainReviewCheckpoint"), record, true); }
  catch { return null; }
}

export function mainReviewCheckpointMatches(checkpoint: unknown, record: unknown): checkpoint is MainReviewCheckpoint {
  try { return checkedCheckpoint(checkpoint, record, false) !== null; }
  catch { return false; }
}
