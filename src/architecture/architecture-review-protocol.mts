import type { ReviewDiagnosticIssue, ReviewDiagnostic } from "../contracts/architecture.mjs";
import { hashValue } from "../development/development-contract.mjs";
import { objectFields } from "../runtime/type-boundary.mjs";
import { isModelSubmissionFormatIssue, MODEL_FORMAT_REJECTION_LIMIT } from "../runtime/model-submission-arguments.mjs";
// Bump only when submission behavior changes; restarting must not clear a stalled run.
export const ARCHITECTURE_REVIEW_PROTOCOL_VERSION = 3;
const formatFingerprint = hashValue({ category: "model_submission_format" });

export function architectureReviewProtocolRepairAvailable(input: unknown) {
  const diagnostic = objectFields(input), failure = objectFields(diagnostic.repeatedFailure);
  // The file-location upgrade only reopens the obsolete v1 quote-length rejection.
  return typeof failure.count === "number" && failure.count >= 3 && Number(failure.protocolVersion ?? 1) < 2
    && objectFields(diagnostic.lastSubmissionIssue).reason === "reference_too_broad";
}

export function architectureReviewFailureStalled(diagnostic: unknown) {
  const count = objectFields(objectFields(diagnostic).repeatedFailure).count;
  return typeof count === "number" && count >= 3 && !architectureReviewProtocolRepairAvailable(diagnostic);
}

export function nextReviewRejection(previous: ReviewDiagnostic["repeatedFailure"] | null, modelContractHash: string,
  issues: Pick<ReviewDiagnosticIssue, "path" | "reason" | "candidatePath">[]) {
  const format = issues.length > 0 && issues.every(isModelSubmissionFormatIssue);
  const fingerprint = format ? formatFingerprint : hashValue(issues.map(({ path, reason, candidatePath }) => ({ path, reason,
    ...(candidatePath ? { candidatePath } : {}) })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  // Old records lack a format category. Carry their existing allowance forward, never regrant it on upgrade.
  const sameFailure = previous?.modelContractHash === modelContractHash && (previous.fingerprint === fingerprint
    || format && (previous.protocolVersion ?? 1) < ARCHITECTURE_REVIEW_PROTOCOL_VERSION);
  return { modelContractHash, fingerprint, protocolVersion: ARCHITECTURE_REVIEW_PROTOCOL_VERSION,
    count: sameFailure ? Math.min(MODEL_FORMAT_REJECTION_LIMIT, previous!.count + 1) : 1 };
}
