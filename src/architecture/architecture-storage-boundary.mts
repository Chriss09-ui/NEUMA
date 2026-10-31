import type { StoredArchitectureRecord, ArchitectureDiagnostic } from "./architecture-controller-port.mjs";
import type { ToolSchema } from "../contracts/tools.mjs";
import type { UnknownRecord } from "../contracts/json.mjs";
import { checkedStoredDraft } from "../requirements/consultation-storage.mjs";
import { InputError } from "../requirements/core.mjs";
import { LEGACY_DESIGN_SCHEMA, DESIGN_V2_SCHEMA, DESIGN_V3_SCHEMA, REVIEW_SCHEMA } from "./architecture-contract.mjs";
import { architectureToolValidation } from "./architecture-tool-diagnostics.mjs";
import { objectFields, isRecord, isArray, isInteger } from "../runtime/type-boundary.mjs";
const strings = (value: unknown): value is string[] => isArray(value) && value.every(entry => typeof entry === "string");
const records = (value: unknown): value is UnknownRecord[] => isArray(value) && value.every(isRecord);
function invalid(): never { throw new InputError("架构记录格式无效，请保留原文件"); }
function diagnostic(value: unknown, failure: boolean): void {
    if (!isRecord(value)) invalid();
    if (failure && (typeof value.stage !== "string" || typeof value.reason !== "string")) invalid();
    for (const key of ["stage", "reason"]) if (value[key] !== undefined && typeof value[key] !== "string") invalid();
    for (const key of ["role", "phase"]) if (value[key] !== undefined && typeof value[key] !== "string") invalid();
    if (value.modelCalls !== undefined && !isInteger(value.modelCalls)) invalid();
    if (value.lastSubmissionIssue !== undefined) { const issue = objectFields(value.lastSubmissionIssue); if (typeof issue.path !== "string" || typeof issue.reason !== "string" || issue.candidatePath !== undefined && typeof issue.candidatePath !== "string") invalid(); }
    if (value.lastSubmissionDiagnostics !== undefined) {
      const details = objectFields(value.lastSubmissionDiagnostics);
      if (!records(details.issues) || details.issues.some(issue => typeof issue.path !== "string" || typeof issue.reason !== "string" || issue.candidatePath !== undefined && typeof issue.candidatePath !== "string")) invalid();
    }
    if (value.repeatedFailure !== undefined) { const failure = objectFields(value.repeatedFailure); if (!isInteger(failure.count) || typeof failure.modelContractHash !== "string" || typeof failure.fingerprint !== "string" || failure.protocolVersion !== undefined && !isInteger(failure.protocolVersion)) invalid(); }
}

export function checkedArchitectureDiagnostic(input: unknown): ArchitectureDiagnostic {
  diagnostic(input, true); return input as ArchitectureDiagnostic;
}
// Loading preserves structurally readable rejected candidates; the original design gate owns semantic limits.
function storedShape(schema: ToolSchema): ToolSchema {
  const result: ToolSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (["minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "pattern"].includes(key)) continue;
    if (key === "properties" && schema.properties) result.properties = Object.fromEntries(Object.entries(schema.properties).map(([name, child]) => [name, storedShape(child)]));
    else if (key === "items" && schema.items) result.items = storedShape(schema.items);
    else if ((key === "anyOf" || key === "oneOf" || key === "allOf") && schema[key]) result[key] = schema[key].map(storedShape);
    else result[key] = value;
  }
  return result;
}
const storedDesignSchemas = { legacy: storedShape(LEGACY_DESIGN_SCHEMA), 2: storedShape(DESIGN_V2_SCHEMA), 3: storedShape(DESIGN_V3_SCHEMA) };
const issueSchema = { type: "object", required: ["id", "blocking", "description", "remedy"], properties: {
  id: { type: "string" }, blocking: { type: "boolean" }, description: { type: "string" }, remedy: { type: "string" },
  source: { type: "string" }, checkId: { type: "string" }, kind: { type: "string" },
  candidateFields: { type: "array", items: { type: "string" } }, candidatePaths: { type: "array", items: { type: "string" } },
  references: { type: "array", items: { type: "object", required: ["source", "path", "quote"], properties: { source: { type: "string" }, path: { type: "string" }, quote: { type: "string" } } } },
  factClaims: { type: "array", items: { type: "object", required: ["source", "path", "expectedJson"], properties: { source: { type: "string" }, path: { type: "string" }, expectedJson: { type: "string" } } } },
} };
/** Decode only stored field shapes. Checkpoint payloads stay opaque until their versioned readers validate bindings and budgets. */
export function checkedStoredArchitectureRecord(input: unknown): StoredArchitectureRecord {
  if (!isRecord(input)) invalid();
  const value = input;
  for (const key of ["agentId", "name", "sourceFingerprint", "status", "delivery", "summary", "createdAt"]) if (typeof value[key] !== "string") invalid();
  if (!isInteger(value.version) || value.version < 1 || !isInteger(value.contractVersion) || !/^[\w-]{1,80}$/.test(String(value.agentId))) invalid();
  checkedStoredDraft(value.draft);
  if (!records(value.requirements) || value.requirements.some(row => typeof row.id !== "string" || typeof row.text !== "string")
    || !records(value.evidence) || value.evidence.some(row => typeof row.id !== "string") || !strings(value.researchGaps)
    || !records(value.attempts) || !records(value.modules)) invalid();
  for (const module of value.modules) {
    const assignment = objectFields(module.assignment), result = objectFields(module.result);
    if (["question", "boundary", "benefit"].some(key => typeof assignment[key] !== "string")
      || ["proposal", "interfaces", "tradeoffs"].some(key => typeof result[key] !== "string") || !strings(result.evidenceIds) || !strings(result.unknowns)) invalid();
  }
  if (!architectureToolValidation(value.issues, { type: "array", items: issueSchema }).valid) invalid();
  if (value.candidateHash !== null && typeof value.candidateHash !== "string") invalid();
  if (value.design !== null) {
    const version = objectFields(value.design).schemaVersion;
    if (!architectureToolValidation(value.design, version === 3 ? storedDesignSchemas[3] : version === 2 ? storedDesignSchemas[2] : storedDesignSchemas.legacy).valid) invalid();
  }
  if (value.review !== null && !architectureToolValidation(value.review, REVIEW_SCHEMA).valid) invalid();
  for (const key of ["updatedAt", "platformHash", "designProgressEvidenceHash", "reviewRevisionSource", "reviewDispatchSource"]) if (value[key] !== undefined && typeof value[key] !== "string") invalid();
  for (const key of ["platformContractVersion", "capabilityCatalogVersion", "designResearchCalls"]) if (value[key] !== undefined && !isInteger(value[key])) invalid();
  if (value.reviewContext !== undefined && value.reviewContext !== null && !isRecord(value.reviewContext)) invalid();
  for (const key of ["reviewEvidence", "revisionSource", "requirementFidelity", "designRecovery"]) if (value[key] !== undefined && !isRecord(value[key])) invalid();
  for (const key of ["designProgressCheckpoint", "reviewProgressCheckpoint", "mainReviewCheckpoint", "requirementFidelityProgress", "reviewRevisionCheckpoint", "reviewRetryCheckpoint", "reviewDispatchCheckpoint"])
    if (value[key] !== undefined && value[key] !== null && !isRecord(value[key])) invalid();
  if (value.diagnostic !== undefined) diagnostic(value.diagnostic, true);
  if (value.reviewDiagnostics !== undefined) { if (!isArray(value.reviewDiagnostics)) invalid(); value.reviewDiagnostics.forEach(entry => diagnostic(entry, false)); }
  if (value.designStageDiagnostics !== undefined) {
    if (!isRecord(value.designStageDiagnostics)) invalid();
    for (const entry of Object.values(value.designStageDiagnostics)) { const issue = objectFields(objectFields(entry).lastSubmissionIssue); if (typeof issue.path !== "string" || typeof issue.reason !== "string") invalid(); }
  }
  if (value.reviewFindingTransitions !== undefined && !isArray(value.reviewFindingTransitions)) invalid();
  if (value.restartSource !== undefined) { const source = objectFields(value.restartSource); if (![source.version, source.preparedVersion].every(isInteger) || [source.recordHash, source.authorization, source.createdAt].some(entry => typeof entry !== "string")) invalid(); }
  return input as StoredArchitectureRecord;
}

/** A shape bridge for an already passed record; downstream source hashes and delivery gates still apply. */
export function checkedPassedArchitecture(input: unknown): StoredArchitectureRecord & import("../contracts/development.mjs").DevelopmentArchitecture & {
  design: import("../contracts/architecture.mjs").ArchitectureDesign; review: import("../contracts/architecture.mjs").ArchitectureReview; candidateHash: string;
} {
  const record = checkedStoredArchitectureRecord(input);
  if (record.status !== "passed" || !record.design || !record.review || record.review.verdict !== "pass" || typeof record.candidateHash !== "string") invalid();
  if (record.deferredVerifications !== undefined && record.deferredVerifications !== null) {
    if (!isRecord(record.deferredVerifications)) invalid();
    const issues = record.deferredVerifications.issues;
    if (issues !== undefined && (!records(issues) || issues.some(issue => typeof issue.requirementId !== "string" || issue.stage !== undefined && typeof issue.stage !== "string"))) invalid();
  }
  return record as StoredArchitectureRecord & import("../contracts/development.mjs").DevelopmentArchitecture & {
    design: import("../contracts/architecture.mjs").ArchitectureDesign; review: import("../contracts/architecture.mjs").ArchitectureReview; candidateHash: string;
  };
}
