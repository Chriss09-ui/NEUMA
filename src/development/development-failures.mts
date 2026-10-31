import type { DevelopmentEvidence } from "./development-controller-types.mjs";

// These causes are produced by the bounded execution adapters, not inferred from model prose.
const codeFailures = new Set(["entrypoint_missing", "timeout", "output_limit", "service_entrypoint_missing", "service_timeout", "service_output_limit"]);

export function repairableDevelopmentResult(result: { status: string; [key: string]: unknown }) {
  return result.status === "failed" || result.status === "error" && codeFailures.has(String(result.reason));
}

export function repairableDevelopmentReport(report: Pick<DevelopmentEvidence, "status" | "results">) {
  return report.results.length > 0 && report.results.some(repairableDevelopmentResult)
    && report.results.every(result => result.status === "passed" || repairableDevelopmentResult(result));
}
