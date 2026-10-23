// Bump only when submission behavior changes; restarting must not clear a stalled run.
export const ARCHITECTURE_REVIEW_PROTOCOL_VERSION = 2;

export function architectureReviewProtocolRepairAvailable(diagnostic) {
  const failure = diagnostic?.repeatedFailure;
  return failure?.count >= 3 && (failure.protocolVersion ?? 1) < ARCHITECTURE_REVIEW_PROTOCOL_VERSION
    && diagnostic.lastSubmissionIssue?.reason === "reference_too_broad";
}

export function architectureReviewFailureStalled(diagnostic) {
  return diagnostic?.repeatedFailure?.count >= 3 && !architectureReviewProtocolRepairAvailable(diagnostic);
}
