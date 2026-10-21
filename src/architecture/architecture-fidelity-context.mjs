import { designHash } from "./architecture-contract.mjs";
import { copyArchitectureReviewJson as jsonCopy, reviewCheckpointOwn as own } from "./architecture-review-binding.mjs";
import { architectureReviewEvidenceContext } from "./architecture-review-evidence.mjs";
import { validatePlatformMetadata } from "./platform-contract.mjs";

export const ARCHITECTURE_FIDELITY_CONTEXT_VERSION = "full-v2";

/** Absence identifies the exact historical context; it never upgrades a saved session. */
export function architectureFidelityContextVersion(reference) {
  if (reference === undefined) return undefined;
  const version = own(reference, "contextVersion");
  if (!Object.hasOwn(reference, "contextVersion")) return undefined;
  if (version !== ARCHITECTURE_FIDELITY_CONTEXT_VERSION) throw new TypeError("Unknown fidelity context version");
  return version;
}

/** Only already frozen review facts enter this independent, read-only check. */
export function createArchitectureFidelityContext(source, { contextVersion } = {}) {
  if (contextVersion !== undefined && contextVersion !== ARCHITECTURE_FIDELITY_CONTEXT_VERSION)
    throw new TypeError("Unknown fidelity context version");
  const context = { requirements: jsonCopy(own(source, "requirements")), draft: jsonCopy(own(source, "draft") ?? null),
    confirmedRequirementContext: jsonCopy(own(source, "confirmedRequirementContext") ?? null), candidate: jsonCopy(own(source, "candidate")),
    runtimeCapabilities: jsonCopy(own(source, "runtimeCapabilities") ?? null), acceptanceAdapterGuide: jsonCopy(own(source, "acceptanceAdapterGuide")),
    acceptanceAdapterGuideSource: own(source, "acceptanceAdapterGuideSource") };
  if (typeof context.acceptanceAdapterGuideSource !== "string") throw new TypeError("Missing fidelity guide source");
  if (contextVersion === undefined) return context;
  const facts = { deferredVerifications: jsonCopy(own(source, "deferredVerifications") ?? null), evidence: jsonCopy(own(source, "evidence")),
    contextManifest: jsonCopy(own(source, "contextManifest")), platformContractVersion: own(source, "platformContractVersion"),
    platformHash: own(source, "platformHash"), platformSnapshot: jsonCopy(own(source, "platformSnapshot")) };
  validatePlatformMetadata({ platformContractVersion: facts.platformContractVersion, platformHash: facts.platformHash, platformSnapshot: facts.platformSnapshot });
  const expected = architectureReviewEvidenceContext({ design: context.candidate, requirements: context.requirements,
    runtimeCapabilities: context.runtimeCapabilities, confirmedRequirementContext: context.confirmedRequirementContext,
    acceptanceAdapterGuide: context.acceptanceAdapterGuide, evidence: facts.evidence, deferredVerifications: facts.deferredVerifications });
  if (designHash(expected.contextManifest) !== designHash(facts.contextManifest)) throw new TypeError("Fidelity review facts do not match the frozen manifest");
  return { ...context, fidelityContextVersion: contextVersion, ...facts };
}

export function architectureRecordFidelityContext(record, evidenceContext, options) {
  return createArchitectureFidelityContext({ requirements: own(record, "requirements"), draft: own(record, "draft") ?? null,
    confirmedRequirementContext: own(record, "confirmedRequirementContext") ?? null, candidate: own(record, "design"),
    runtimeCapabilities: own(record, "runtimeCapabilities") ?? null, acceptanceAdapterGuide: own(evidenceContext, "acceptanceAdapterGuide"),
    acceptanceAdapterGuideSource: "review-evidence-context", deferredVerifications: own(record, "deferredVerifications") ?? null,
    evidence: own(record, "evidence"), contextManifest: own(evidenceContext, "contextManifest"),
    platformContractVersion: own(record, "platformContractVersion"), platformHash: own(record, "platformHash"), platformSnapshot: own(record, "platformSnapshot") }, options);
}
