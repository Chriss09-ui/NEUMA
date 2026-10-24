import { objectFields } from "../runtime/type-boundary.mjs";
// Bump only when submission behavior changes; restarting must not clear a stalled run.
export const ARCHITECTURE_REVIEW_PROTOCOL_VERSION = 2;

export function architectureReviewProtocolRepairAvailable(input: unknown) {
  const diagnostic = objectFields(input), failure = objectFields(diagnostic.repeatedFailure);
  return typeof failure.count === "number" && failure.count >= 3 && Number(failure.protocolVersion ?? 1) < ARCHITECTURE_REVIEW_PROTOCOL_VERSION
    && objectFields(diagnostic.lastSubmissionIssue).reason === "reference_too_broad";
}

export function architectureReviewFailureStalled(diagnostic: unknown) {
  const count = objectFields(objectFields(diagnostic).repeatedFailure).count;
  return typeof count === "number" && count >= 3 && !architectureReviewProtocolRepairAvailable(diagnostic);
}
