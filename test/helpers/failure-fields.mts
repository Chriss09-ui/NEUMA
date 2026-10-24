import assert from "node:assert/strict";
import { objectFields } from "../../src/runtime/type-boundary.mjs";

interface FailureIssue extends Record<string, unknown> { path?: string; reason?: string }
interface FailureMetadata extends Record<string, unknown> { stage?: string; reason?: string; field?: string; issues?: FailureIssue[] }
interface FixturePreflightDiagnostic extends Record<string, unknown> {
  modelTurns?: number; readOnlyCalls?: number; researchCalls?: number; systemVerificationCalls?: number; calculationCalls?: number;
  correctiveContinuations?: number; stopReason?: string;
  events?: { reason: string; role?: string; turn?: number; paths?: string[]; issueIds?: string[] }[];
}
export interface FixtureFailureFields extends Record<string, unknown> {
  message?: string; name?: string; reason?: string; code?: unknown; bytes?: number; limitBytes?: number;
  preflightDiagnostic?: FixturePreflightDiagnostic; diagnostic?: FailureMetadata; validationIssue?: FailureMetadata; developmentIssue?: FailureMetadata; validationIssues?: FailureIssue[];
}
/** Assertions inspect only the error fields they consume, including errors from a VM realm. */
export function failureFields(value: unknown): FixtureFailureFields {
  assert.ok(value && typeof value === "object");
  const fields = objectFields(value);
  for (const key of ["message", "name", "reason"]) assert.ok(fields[key] === undefined || typeof fields[key] === "string");
  for (const key of ["bytes", "limitBytes"]) assert.ok(fields[key] === undefined || typeof fields[key] === "number");
  for (const key of ["diagnostic", "validationIssue", "developmentIssue"]) {
    const metadata = fields[key];
    assert.ok(metadata === undefined || metadata !== null && typeof metadata === "object" && !Array.isArray(metadata));
    if (metadata) for (const field of ["stage", "reason", "field"]) assert.ok(objectFields(metadata)[field] === undefined || typeof objectFields(metadata)[field] === "string");
  }
  const validateIssues = (issues: unknown) => {
    assert.ok(Array.isArray(issues));
    for (const issue of issues) {
      assert.ok(issue && typeof issue === "object" && !Array.isArray(issue));
      for (const key of ["path", "reason"]) assert.ok(objectFields(issue)[key] === undefined || typeof objectFields(issue)[key] === "string");
    }
  };
  if (fields.preflightDiagnostic !== undefined) {
    assert.ok(fields.preflightDiagnostic !== null && typeof fields.preflightDiagnostic === "object" && !Array.isArray(fields.preflightDiagnostic));
    const diagnostic = objectFields(fields.preflightDiagnostic);
    for (const key of ["modelTurns", "readOnlyCalls", "researchCalls", "systemVerificationCalls", "calculationCalls", "correctiveContinuations"])
      assert.ok(diagnostic[key] === undefined || typeof diagnostic[key] === "number");
    assert.ok(diagnostic.stopReason === undefined || typeof diagnostic.stopReason === "string");
    if (diagnostic.events !== undefined) {
      assert.ok(Array.isArray(diagnostic.events));
      for (const event of diagnostic.events) {
        const fields = objectFields(event); assert.equal(typeof fields.reason, "string");
        assert.ok(fields.role === undefined || typeof fields.role === "string");
        assert.ok(fields.turn === undefined || typeof fields.turn === "number");
        for (const key of ["paths", "issueIds"]) assert.ok(fields[key] === undefined || Array.isArray(fields[key]) && fields[key].every(item => typeof item === "string"));
      }
    }
  }
  if (fields.validationIssues !== undefined) validateIssues(fields.validationIssues);
  for (const key of ["diagnostic", "validationIssue", "developmentIssue"]) {
    const issues = objectFields(fields[key]).issues;
    if (issues !== undefined) validateIssues(issues);
  }
  return value as FixtureFailureFields;
}
