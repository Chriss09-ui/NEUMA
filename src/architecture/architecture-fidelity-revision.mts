import type { UnknownRecord } from "../contracts/json.mjs";
import { objectFields, isInteger } from "../runtime/type-boundary.mjs";
import { designHash, validateReview } from "./architecture-contract.mjs";
import { copyArchitectureReviewJson as jsonCopy, architectureReviewRecordBinding as recordBinding,
  reviewCheckpointOwn as own, reviewCheckpointObject as object } from "./architecture-review-binding.mjs";
import { readMainReviewCheckpoint } from "./architecture-main-review-checkpoint.mjs";
import { readReviewProgressCheckpoint, readLegacyReviewProgressCheckpoint } from "./architecture-review-progress.mjs";
import { readArchitectureFidelityProgress } from "./architecture-fidelity-progress.mjs";
import { validateArchitecturePriorFindings } from "./architecture-prior-findings.mjs";
import { diagnoseRequirementFidelitySubmission } from "./requirement-fidelity.mjs";
import { architectureFidelityContextVersion, architectureRecordFidelityContext } from "./architecture-fidelity-context.mjs";

const reviewSourceFields = ["candidate", "requirements", "runtimeCapabilities", "evidence", "confirmedRequirementContext",
  "deferredVerifications", "acceptanceAdapterGuide", "contextManifest"];

// The full context combines independently bounded sources; its sum is not a new 2 MiB source.
export function copyFidelityReviewEvidenceContext(value: unknown) {
  if (!object(value) || Reflect.ownKeys(value).length !== reviewSourceFields.length
    || Reflect.ownKeys(value).some((key) => (typeof key !== "string" || !reviewSourceFields.includes(key)))) throw new TypeError("Invalid fidelity evidence context");
  return Object.fromEntries(reviewSourceFields.map((key) => [key, jsonCopy(own(value, key))]));
}

/** A checked negative decision is a technical editing reference, never a replacement main review. */
export function readArchitectureFidelityRevision(record: unknown, evidenceInput: unknown) {
  try {
    let evidenceContext = evidenceInput;
    const binding = recordBinding(record), checkpoint = readMainReviewCheckpoint(record);
    if (!binding || !checkpoint || checkpoint.fidelityStatus !== "not_preserved" || !evidenceContext) return null;
    evidenceContext = copyFidelityReviewEvidenceContext(evidenceContext);
    const evidence = objectFields(jsonCopy(checkpoint.fidelityEvidence)), snapshot = objectFields(jsonCopy(objectFields(own(record, "reviewEvidence")).snapshot));
    const fields = ["contextHash", "verdict", "checks", "restrictions", "modelCalls", "fidelityDiagnostic", "contextVersion"];
    const contextVersion = architectureFidelityContextVersion(evidence);
    if (!["narrowed", "unproven"].some(verdict => verdict === evidence.verdict) || Object.keys(evidence).some((key) => !fields.includes(key))
      || !isInteger(evidence.modelCalls) || evidence.modelCalls < 1 || evidence.modelCalls > 2
      || !snapshot || designHash(objectFields(evidenceContext).contextManifest) !== designHash(snapshot.contextManifest)
      || designHash(objectFields(evidenceContext).acceptanceAdapterGuide) !== designHash(snapshot.acceptanceAdapterGuide)) return null;
    for (const [key, field] of [["candidate", "design"], ["requirements", "requirements"], ["runtimeCapabilities", "runtimeCapabilities"],
      ["evidence", "evidence"], ["confirmedRequirementContext", "confirmedRequirementContext"], ["deferredVerifications", "deferredVerifications"]] as const)
      if (designHash(objectFields(evidenceContext)[key] ?? null) !== designHash(own(record, field) ?? null)) return null;
    validateArchitecturePriorFindings(validateReview(checkpoint.review, { candidateHash: binding.source.candidateHash,
      schemaVersion: objectFields(own(record, "design")).schemaVersion as number | undefined, evidenceContext }), own(record, "priorFindings"), own(record, "design"), { evidenceContext });
    const context = architectureRecordFidelityContext(record, evidenceContext, { contextVersion });
    const submission = Object.fromEntries(["contextHash", "verdict", "checks", "restrictions"].map((key) => [key, evidence[key]]));
    const progress = readReviewProgressCheckpoint(record) ?? readLegacyReviewProgressCheckpoint(record), fidelity = readArchitectureFidelityProgress(record);
    if (Object.hasOwn(objectFields(record), "reviewProgressCheckpoint") && !progress || Object.hasOwn(objectFields(record), "requirementFidelityProgress") && !fidelity) return null;
    const schemaHash = fidelity?.state.schemaHash ?? diagnoseRequirementFidelitySubmission(context, null).schemaHash;
    const checked = diagnoseRequirementFidelitySubmission(context, submission, { canonical: true, schemaHash });
    if (!checked.valid || evidence.fidelityDiagnostic && (objectFields(evidence.fidelityDiagnostic).schemaVersion !== 1
      || objectFields(evidence.fidelityDiagnostic).contextVersion !== contextVersion || objectFields(evidence.fidelityDiagnostic).contextHash !== checked.contextHash
      || objectFields(evidence.fidelityDiagnostic).modelCalls !== evidence.modelCalls || objectFields(evidence.fidelityDiagnostic).stopReason !== "submitted")) return null;
    if (fidelity && (architectureFidelityContextVersion(fidelity.state) !== contextVersion
      || fidelity.state.contextHash !== checked.contextHash || fidelity.state.schemaHash !== checked.schemaHash
      || fidelity.state.calls !== evidence.modelCalls || fidelity.state.diagnostic.schemaVersion !== 1
      || fidelity.state.diagnostic.contextVersion !== contextVersion || fidelity.state.diagnostic.contextHash !== checked.contextHash
      || fidelity.state.diagnostic.modelCalls !== fidelity.state.calls)) return null;
    const modelCalls = Math.max(checkpoint.modelCalls, progress?.modelCalls ?? 0, fidelity?.parentModelCalls ?? 0);
    if (modelCalls < evidence.modelCalls) return null;
    return { trust: "untrusted-technical-reference", source: { ...binding.source, bindingHash: binding.bindingHash,
      reviewHash: checkpoint.reviewHash, contextHash: checked.contextHash, schemaHash: checked.schemaHash, evidenceHash: designHash(evidence) },
      modelCalls, evidence };
  } catch { return null; }
}
