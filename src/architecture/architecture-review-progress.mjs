import { hashValue } from "../development/development-contract.mjs";
import { types } from "node:util";
import { reviewSubmissionSchema } from "./architecture-contract.mjs";
import { architectureReviewEvidenceContext } from "./architecture-review-evidence.mjs";
import { architectureToolValidation } from "./architecture-tool-diagnostics.mjs";
import { copyArchitectureReviewJson, architectureReviewRecordBinding, reviewCheckpointObject, reviewCheckpointOwn, architectureReviewStoredCallLimit } from "./architecture-review-binding.mjs";
import { canonicalArchitectureReviewParts, canonicalArchitectureReviewPartsDraft } from "./architecture-review-parts.mjs";

export const REVIEW_PROGRESS_CHECKPOINT_MAX_BYTES = 256 * 1024;
const checkpointFields = ["schemaVersion", "source", "bindingHash", "reviewHash", "review", "origin", "modelCalls", "diagnostic", "hash"];
const sourceFields = ["agentId", "architectureVersion", "candidateHash"];
const origins = ["none", "unsubmitted", "semantic-rejected"];
const diagnosticFields = ["reason", "submissionAttempts", "submissionContinuations", "localRevisions", "lastSubmissionIssue", "issues", "repeatedFailure"];
const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const calls = (value, record) => Number.isSafeInteger(value) && value >= 0 && value <= architectureReviewStoredCallLimit(record);
const exact = (value, keys) => reviewCheckpointObject(value) && Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const token = (value) => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(value);

function canonicalParts(parts, record) {
  const context = architectureReviewEvidenceContext({ design: record.design, requirements: record.requirements,
    runtimeCapabilities: record.runtimeCapabilities, evidence: record.evidence ?? [],
    confirmedRequirementContext: record.confirmedRequirementContext ?? null, deferredVerifications: record.deferredVerifications ?? null,
    acceptanceAdapterGuide: record.reviewEvidence?.snapshot?.acceptanceAdapterGuide });
  return canonicalArchitectureReviewParts(parts, { candidateHash: record.candidateHash, context, priorFindings: record.priorFindings,
    schema: reviewSubmissionSchema({ evidenceRequired: record.design.schemaVersion >= 3, priorFindingsRequired: Boolean(record.priorFindings) }) });
}

function rejectedPartsCopy(parts, record) {
  return parts === null ? null : canonicalArchitectureReviewPartsDraft(parts, { candidateHash: record.candidateHash,
    schema: reviewSubmissionSchema({ evidenceRequired: record.design.schemaVersion >= 3, priorFindingsRequired: Boolean(record.priorFindings) }) });
}

/** Original rejected wire input is reference material only, never a canonical review or replay command. */
export function copyRejectedReviewInput(value, candidateHash) {
  if (value === null) return null;
  const result = copyArchitectureReviewJson(value, { maxDepth: 34, maxNodes: 100_000, maxBytes: REVIEW_PROGRESS_CHECKPOINT_MAX_BYTES });
  if (!exact(result, ["toolName", "input"])
    || !["submit_architecture_review", "save_architecture_review_parts", "submit_architecture_review_parts"].includes(result.toolName)
    || !reviewCheckpointObject(result.input) || result.input.candidateHash !== candidateHash)
    throw new TypeError("Rejected review input does not belong to this candidate");
  return result;
}

function diagnosticCopy(value = {}) {
  const result = copyArchitectureReviewJson(value, { maxDepth: 4, maxNodes: 1000, maxBytes: 8192 });
  if (!reviewCheckpointObject(result) || Object.keys(result).some((key) => !diagnosticFields.includes(key))) throw new TypeError("Invalid progress diagnostic");
  if (Object.hasOwn(result, "reason") && !token(result.reason)) throw new TypeError("Invalid progress diagnostic reason");
  for (const key of ["submissionAttempts", "submissionContinuations", "localRevisions"])
    if (Object.hasOwn(result, key) && (!Number.isSafeInteger(result[key]) || result[key] < 0 || result[key] > 1000)) throw new TypeError("Invalid progress diagnostic count");
  const issue = (item) => exact(item, ["path", "reason", ...(Object.hasOwn(item ?? {}, "candidatePath") ? ["candidatePath"] : [])])
    && typeof item.path === "string" && item.path.length <= 500 && !/[\x00-\x1f\x7f]/.test(item.path) && token(item.reason)
    && (!Object.hasOwn(item, "candidatePath") || typeof item.candidatePath === "string" && item.candidatePath.startsWith("/")
      && item.candidatePath.length <= 500 && !/[\x00-\x1f\x7f]/.test(item.candidatePath));
  if (Object.hasOwn(result, "lastSubmissionIssue") && !issue(result.lastSubmissionIssue)) throw new TypeError("Invalid progress diagnostic issue");
  if (Object.hasOwn(result, "issues") && (!Array.isArray(result.issues) || result.issues.length > 40 || !result.issues.every(issue)))
    throw new TypeError("Invalid progress diagnostic issues");
  if (Object.hasOwn(result, "repeatedFailure") && (!exact(result.repeatedFailure, ["modelContractHash", "fingerprint", "count",
    ...(Object.hasOwn(result.repeatedFailure ?? {}, "protocolVersion") ? ["protocolVersion"] : [])])
    || Object.hasOwn(result.repeatedFailure, "protocolVersion") && (!Number.isSafeInteger(result.repeatedFailure.protocolVersion) || result.repeatedFailure.protocolVersion < 1)
    || !hash(result.repeatedFailure.modelContractHash) || !hash(result.repeatedFailure.fingerprint)
    || !Number.isSafeInteger(result.repeatedFailure.count) || result.repeatedFailure.count < 1 || result.repeatedFailure.count > 3))
    throw new TypeError("Invalid repeated progress failure");
  return result;
}

function canonicalReview(value, record, validateDraft) {
  const review = copyArchitectureReviewJson(value, { maxDepth: 32, maxNodes: 100_000, maxBytes: REVIEW_PROGRESS_CHECKPOINT_MAX_BYTES });
  const schema = reviewSubmissionSchema({ evidenceRequired: record.design.schemaVersion >= 3, priorFindingsRequired: Boolean(record.priorFindings) });
  if (!reviewCheckpointObject(review) || review.candidateHash !== record.candidateHash || !architectureToolValidation(review, schema, { root: "review" }).valid)
    throw new TypeError("Progress review is not a complete canonical draft");
  // Only resolved protocol fields survive; receipt identifiers and session nonces are never restored.
  const noSessionReferences = (item) => {
    if (!item || typeof item !== "object") return true;
    return Object.entries(item).every(([key, child]) => !["receiptId", "scopeReceiptId", "adapterRulePath", "nonce", "submissionHash", "draftHash"].includes(key)
      && noSessionReferences(child));
  };
  if (!noSessionReferences(review)) throw new TypeError("Progress draft contains session references");
  if (validateDraft !== undefined) {
    if (typeof validateDraft !== "function" || validateDraft(copyArchitectureReviewJson(review)) === false) throw new TypeError("Progress draft failed structural validation");
  }
  return review;
}

function checkedCheckpoint(checkpoint, record, sameVersion, validateDraft) {
  const value = copyArchitectureReviewJson(checkpoint, { maxDepth: 36, maxNodes: 101_000, maxBytes: REVIEW_PROGRESS_CHECKPOINT_MAX_BYTES }),
    current = architectureReviewRecordBinding(record);
  const fields = [...checkpointFields, ...(value.schemaVersion >= 2 ? ["parts", "partsHash"] : []),
    ...(value.schemaVersion >= 3 ? ["rejectedParts", "rejectedPartsHash"] : []),
    ...(value.schemaVersion === 4 ? ["rejectedInput", "rejectedInputHash"] : [])];
  if (!current || ![1, 2, 3, 4].includes(value.schemaVersion) || !exact(value, fields) || !exact(value.source, sourceFields)
    || !Number.isSafeInteger(value.source.architectureVersion) || value.source.architectureVersion < 1 || !calls(value.modelCalls, record)
    || !origins.includes(value.origin) || value.source.agentId !== current.source.agentId || value.source.candidateHash !== current.source.candidateHash
    || sameVersion && value.source.architectureVersion !== current.source.architectureVersion
    || !hash(value.bindingHash) || value.bindingHash !== current.bindingHash || !hash(value.hash)) return null;
  diagnosticCopy(value.diagnostic);
  if (value.review === null ? value.reviewHash !== null || value.origin !== "none"
    : !hash(value.reviewHash) || value.origin === "none" || hashValue(canonicalReview(value.review, record, validateDraft)) !== value.reviewHash) return null;
  if (value.schemaVersion >= 2 && (!hash(value.partsHash) || hashValue(canonicalParts(value.parts, record)) !== value.partsHash)) return null;
  if (value.schemaVersion >= 3 && (value.rejectedParts === null ? value.rejectedPartsHash !== null
    : !hash(value.rejectedPartsHash) || hashValue(rejectedPartsCopy(value.rejectedParts, record)) !== value.rejectedPartsHash)) return null;
  if (value.schemaVersion === 4 && (value.rejectedInput === null ? value.rejectedInputHash !== null
    : !hash(value.rejectedInputHash) || hashValue(copyRejectedReviewInput(value.rejectedInput, record.candidateHash)) !== value.rejectedInputHash)) return null;
  const { hash: savedHash, ...body } = value;
  return hashValue(body) === savedHash ? value : null;
}

/** Untrusted progress only: neither a draft nor its budget grants submission or review status. */
export function createReviewProgressCheckpoint(record, review, modelCalls, options = {}) {
  try {
    const current = architectureReviewRecordBinding(record), origin = reviewCheckpointOwn(options, "origin") ?? (review === null ? "none" : undefined),
      diagnostic = diagnosticCopy(reviewCheckpointOwn(options, "diagnostic")), validateDraft = reviewCheckpointOwn(options, "validateDraft");
    if (!current || !calls(modelCalls, record) || !origins.includes(origin) || (review === null) !== (origin === "none")) return null;
    const savedReview = review === null ? null : canonicalReview(review, record, validateDraft);
    const suppliedInput = reviewCheckpointOwn(options, "rejectedInput"), rejectedInput = suppliedInput === undefined ? undefined : copyRejectedReviewInput(suppliedInput, record.candidateHash);
    const suppliedRejected = reviewCheckpointOwn(options, "rejectedParts"), rejectedParts = suppliedRejected === undefined
      ? rejectedInput === undefined ? undefined : null : rejectedPartsCopy(suppliedRejected, record);
    const suppliedParts = reviewCheckpointOwn(options, "parts"), parts = suppliedParts === undefined
      ? rejectedParts === undefined ? undefined : canonicalParts({ candidateHash: record.candidateHash,
        checks: [], issues: [], acceptanceScopeChecks: [], priorFindingDecisions: [] }, record) : canonicalParts(suppliedParts, record);
    const body = { schemaVersion: rejectedInput !== undefined ? 4 : rejectedParts !== undefined ? 3 : parts === undefined ? 1 : 2, source: current.source, bindingHash: current.bindingHash, reviewHash: savedReview === null ? null : hashValue(savedReview),
      review: savedReview, origin, modelCalls, diagnostic, ...(parts === undefined ? {} : { parts, partsHash: hashValue(parts) }),
      ...(rejectedParts === undefined ? {} : { rejectedParts, rejectedPartsHash: rejectedParts === null ? null : hashValue(rejectedParts) }),
      ...(rejectedInput === undefined ? {} : { rejectedInput, rejectedInputHash: rejectedInput === null ? null : hashValue(rejectedInput) }) };
    const checkpoint = { ...body, hash: hashValue(body) };
    return Buffer.byteLength(JSON.stringify(checkpoint)) <= REVIEW_PROGRESS_CHECKPOINT_MAX_BYTES ? checkpoint : null;
  } catch { return null; }
}

export function readReviewProgressCheckpoint(record, options = {}) {
  try { return checkedCheckpoint(reviewCheckpointOwn(record, "reviewProgressCheckpoint"), record, true, reviewCheckpointOwn(options, "validateDraft")); }
  catch { return null; }
}

/** Legacy counts only; the caller must first validate the current interrupted review seed. */
export function readLegacyReviewProgressCheckpoint(record) {
  try {
    if (!reviewCheckpointObject(record) || Object.hasOwn(record, "mainReviewCheckpoint") || Object.hasOwn(record, "reviewProgressCheckpoint")) return null;
    const diagnostic = reviewCheckpointOwn(record, "diagnostic");
    if (!reviewCheckpointObject(diagnostic) || reviewCheckpointOwn(diagnostic, "stage") !== "architecture"
      || reviewCheckpointOwn(diagnostic, "role") !== "reviewer" || reviewCheckpointOwn(diagnostic, "phase") !== "evaluating") return null;
    let modelCalls = reviewCheckpointOwn(diagnostic, "modelCalls");
    if (!calls(modelCalls) || modelCalls < 1) return null;
    if (Object.hasOwn(record, "reviewDiagnostics")) {
      const history = reviewCheckpointOwn(record, "reviewDiagnostics");
      if (!Array.isArray(history) || types.isProxy(history) || Object.getPrototypeOf(history) !== Array.prototype || history.length > 1000) return null;
      const descriptors = Object.getOwnPropertyDescriptors(history);
      if (Reflect.ownKeys(descriptors).length !== history.length + 1) return null;
      for (let index = 0; index < history.length; index++) {
        const descriptor = descriptors[index];
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") || !reviewCheckpointObject(descriptor.value)) return null;
        const entry = descriptor.value;
        if (reviewCheckpointOwn(entry, "role") !== "reviewer") continue;
        const used = reviewCheckpointOwn(entry, "modelCalls");
        if (!calls(used)) return null;
        modelCalls = Math.max(modelCalls, used);
      }
    }
    const context = copyArchitectureReviewJson(reviewCheckpointOwn(record, "reviewContext")),
      evidence = copyArchitectureReviewJson(reviewCheckpointOwn(record, "reviewEvidence")), snapshot = evidence.snapshot;
    if (!reviewCheckpointObject(snapshot) || snapshot.version !== 1 || evidence.version !== 2
      || !exact(snapshot, ["version", "candidateHash", "platformHash", "acceptanceAdapterGuide", "contextManifest", "hash"])
      || snapshot.candidateHash !== reviewCheckpointOwn(record, "candidateHash") || snapshot.platformHash !== reviewCheckpointOwn(record, "platformHash")
      || context.candidateHash !== snapshot.candidateHash || context.platformHash !== snapshot.platformHash || evidence.snapshotHash !== snapshot.hash) return null;
    const { hash: snapshotHash, ...body } = snapshot;
    if (snapshotHash !== hashValue(body)) return null;
    const facts = Object.fromEntries(["design", "requirements", "runtimeCapabilities", "evidence", "confirmedRequirementContext", "deferredVerifications"]
      .map((key) => [key, copyArchitectureReviewJson(reviewCheckpointOwn(record, key) ?? null)]));
    if (!reviewCheckpointObject(facts.design) || !Array.isArray(facts.requirements) || !reviewCheckpointObject(facts.runtimeCapabilities)
      || !Array.isArray(facts.evidence)) return null;
    const current = architectureReviewEvidenceContext({ ...facts, acceptanceAdapterGuide: snapshot.acceptanceAdapterGuide });
    if (hashValue(current.contextManifest) !== hashValue(snapshot.contextManifest)) return null;
    const reason = reviewCheckpointOwn(diagnostic, "reason");
    if (reason !== undefined && !token(reason)) return null;
    return createReviewProgressCheckpoint(record, null, modelCalls, { diagnostic: reason === undefined ? {} : { reason } });
  } catch { return null; }
}

export function reviewProgressCheckpointMatches(checkpoint, record, options = {}) {
  try { return checkedCheckpoint(checkpoint, record, false, reviewCheckpointOwn(options, "validateDraft")) !== null; }
  catch { return false; }
}

/** Charge progress even when the latest submission is malformed; retain the last valid draft. */
export function advanceReviewProgressCheckpoint(record, modelCalls, options = {}) {
  try {
    const validateDraft = reviewCheckpointOwn(options, "validateDraft"), saved = reviewCheckpointOwn(record, "reviewProgressCheckpoint"),
      previous = saved === undefined ? null : checkedCheckpoint(saved, record, true, validateDraft);
    if (!calls(modelCalls, record) || saved !== undefined && !previous || previous && modelCalls < previous.modelCalls) return null;
    const diagnostic = reviewCheckpointOwn(options, "diagnostic") ?? previous?.diagnostic ?? {}, supplied = reviewCheckpointOwn(options, "review");
    const parts = reviewCheckpointOwn(options, "parts") ?? previous?.parts;
    const suppliedRejected = reviewCheckpointOwn(options, "rejectedParts"), rejectedParts = suppliedRejected === undefined ? previous?.rejectedParts : suppliedRejected;
    const suppliedInput = reviewCheckpointOwn(options, "rejectedInput"), rejectedInput = suppliedInput === undefined ? previous?.rejectedInput : suppliedInput;
    const draftOptions = { ...(rejectedParts === undefined ? {} : { rejectedParts }), ...(rejectedInput === undefined ? {} : { rejectedInput }) };
    if (supplied !== undefined && supplied !== null) {
      const next = createReviewProgressCheckpoint(record, supplied, modelCalls, { origin: reviewCheckpointOwn(options, "origin"), diagnostic, validateDraft, ...draftOptions, ...(parts === undefined ? {} : { parts }) });
      if (next) return next;
    }
    return createReviewProgressCheckpoint(record, previous?.review ?? null, modelCalls,
      { origin: previous?.origin ?? "none", diagnostic, validateDraft, ...draftOptions, ...(parts === undefined ? {} : { parts }) });
  } catch { return null; }
}
