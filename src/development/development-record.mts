import { Ajv } from "ajv";
import { InputError } from "../requirements/core.mjs";
import { LEGACY_DESIGN_SCHEMA, DESIGN_V2_SCHEMA, DESIGN_V3_SCHEMA, REVIEW_SCHEMA as ARCHITECTURE_REVIEW_SCHEMA } from "../architecture/architecture-contract.mjs";
import { LEGACY_PLAN_SCHEMA, PLAN_V2_SCHEMA, PLAN_V3_SCHEMA, REVIEW_SCHEMA, WORK_SCHEMA } from "./development-contract.mjs";
import { checkedStoredDraft } from "../requirements/consultation-storage.mjs";
import { validateApplicationManifest } from "../applications/application-contract.mjs";
import { PLANNING_BLOCKER_SCHEMA } from "./development-planning-blocker.mjs";
import type { ToolSchema } from "../contracts/tools.mjs";
import type { DevelopmentRunRecord, DevelopmentDeliveryRecord } from "./development-controller-types.mjs";

const string = { type: "string" }, integer = { type: "integer" }, boolean = { type: "boolean" };
const array = (items: ToolSchema): ToolSchema => ({ type: "array", items });
const object = (properties: Record<string, ToolSchema>, required: string[] = []): ToolSchema => ({ type: "object", properties, required, additionalProperties: true });
const nullable = (schema: ToolSchema): ToolSchema => ({ anyOf: [schema, { type: "null" }] });
const strings = array(string);
const reference = object({ version: integer, candidateHash: string }, ["version", "candidateHash"]);
const file = object({ path: string, hash: string, size: integer }, ["path", "hash", "size"]);
const snapshot = object({ agentId: string, path: string, hash: string, files: array(file) }, ["agentId", "path", "hash", "files"]);
const planningSnapshot = object({ ...snapshot.properties, runId: string, indexPath: string, version: integer, kind: string }, [...snapshot.required!, "runId", "indexPath"]);
const plan = { anyOf: [LEGACY_PLAN_SCHEMA, PLAN_V2_SCHEMA, PLAN_V3_SCHEMA] };
const review = { ...REVIEW_SCHEMA, additionalProperties: true, properties: { ...REVIEW_SCHEMA.properties,
  subjectVersion: integer, mode: string, codeHash: nullable(string), planHash: nullable(string) } };
const report = object({ id: string, status: string, codeHash: nullable(string), summary: string, mode: string, taskId: nullable(string), planHash: nullable(string), architectureRef: reference,
  results: array(object({ caseId: string, status: string }, ["caseId", "status"])) }, ["id", "status", "codeHash", "results"]);
const blockerSourceFields = { agentId: string, runId: string, architectureRef: nullable(reference), architectureHash: string,
  sourceFingerprint: nullable(string), requirementHash: string, designHash: string, platformHash: nullable(string), runtimeCapabilityHash: string,
  confirmedContextHash: string, deferredContextHash: string, adapterGuideHash: string };
const blockerReport = object({ ...PLANNING_BLOCKER_SCHEMA.properties,
  issues: array(object({ ...PLANNING_BLOCKER_SCHEMA.properties.issues.items.properties, blocking: boolean }, [...PLANNING_BLOCKER_SCHEMA.properties.issues.items.required, "blocking"])), schemaVersion: integer, type: string, role: string, trust: string,
  status: string, source: object(blockerSourceFields, Object.keys(blockerSourceFields)), reportHash: string },
  [...PLANNING_BLOCKER_SCHEMA.required, "schemaVersion", "type", "role", "trust", "status", "source"]);
const feedback = object({ report: { anyOf: [report, blockerReport] }, review, rejectedPlan: plan, reason: string, codeHash: string, passed: boolean });
const task = object({ ...LEGACY_PLAN_SCHEMA.properties.tasks.items.properties, status: string, attempts: integer, repairs: integer, turns: integer,
  integration: boolean, taskHash: string, feedback: object({ passed: boolean, report, review }, ["report", "review"]), nextAction: string, summary: string, verifiedCodeHash: string },
  [...LEGACY_PLAN_SCHEMA.properties.tasks.items.required, "status", "attempts", "repairs", "turns", "nextAction"]);
const adapterId = { enum: ["action", "input-contract", "page-resources", "host-files", "host-runtime", "host-business", "host-gateway", "delivery-review", "conversation"] };
const status = { enum: ["passed", "failed", "not_run", "error"] };
const verification = object({ stage: { enum: ["development", "activation", "runtime"] }, owner: { enum: ["generated-code", "platform", "conversation"] }, adapterId }, ["stage", "owner", "adapterId"]);
const evidence = object({ kind: { enum: ["development-report", "independent-review", "host-integration", "runtime-task"] }, bindingHash: string,
  scope: string, mode: string, codeHash: string, planHash: string, reportId: string, caseIds: strings, reportHash: string,
  planSubjectHash: string, integrationSubjectHash: string, planReviewHash: string, integrationReviewHash: string, adapterId,
  evidenceId: string, evidenceHash: string, taskId: string, deliveryVersion: string }, ["kind", "bindingHash"]);
const ledger = object({ schemaVersion: { const: 1 }, binding: object({ agentId: string, architectureVersion: integer, architectureHash: string,
  requirementsHash: string, planHash: string, codeHash: string, runtimeCapabilitiesHash: string }, ["agentId", "architectureVersion", "architectureHash", "requirementsHash", "planHash", "codeHash"]),
  bindingHash: string, status, items: array(object({ acceptanceId: string, requirementIds: strings, verification, legacy: boolean,
    acceptanceHash: string, status, evidence: nullable(evidence), reason: string }, ["acceptanceId", "requirementIds", "verification", "legacy", "acceptanceHash", "status", "evidence"])) },
  ["schemaVersion", "binding", "bindingHash", "status", "items"]);
const packageSchema = object({ id: string, buildId: string, architectureRef: reference, codeHash: string, planHash: string, entrypoint: string,
  runtime: string, snapshot, protocolVersion: integer, application: object({}), verificationId: string, acceptanceLedger: ledger },
  ["id", "buildId", "architectureRef", "codeHash", "planHash", "entrypoint", "runtime", "snapshot", "verificationId"]);
const historicalReview = object({ sourceRunId: string, reviewedPlanHash: string, review, instruction: string }, ["sourceRunId", "reviewedPlanHash", "review", "instruction"]);
const draft = object({ bindingHash: string, snapshot: planningSnapshot, historicalReview }, ["bindingHash", "snapshot"]);
const session = object({ bindingHash: string, role: string, file: nullable(string), turns: integer, limit: integer, retryAttempts: integer,
  compactions: integer, submissionContinuations: integer, pendingResult: object({ result: {}, subjectHash: nullable(string), planHash: nullable(string), codeHash: nullable(string) }, ["result", "subjectHash", "planHash", "codeHash"]),
  toolInputFailure: object({ toolName: string, fingerprint: string, schemaHash: string, callHash: string, count: integer }, ["toolName", "fingerprint", "callHash", "count"]),
  contextDelivery: object({ version: integer, bindingHash: string, sections: array(object({ section: string, contentHash: string, messageHash: string }, ["section", "contentHash", "messageHash"])) }, ["version", "bindingHash", "sections"]) },
  ["bindingHash", "role", "file", "turns"]);
// Historical candidates retain their structural types without reapplying current submission size limits.
function storedShape(value: ToolSchema): ToolSchema {
  const result = { ...value };
  for (const key of ["minItems", "maxItems", "minLength", "maxLength", "pattern", "minimum", "maximum", "minProperties", "maxProperties", "uniqueItems"]) delete result[key];
  if (result.properties) result.properties = Object.fromEntries(Object.entries(result.properties).map(([key, schema]) => [key, storedShape(schema)]));
  if (result.items) result.items = storedShape(result.items);
  for (const key of ["anyOf", "oneOf", "allOf"] as const) if (result[key]) result[key] = result[key]!.map(storedShape);
  return result;
}
const candidateDesign = storedShape(object({ ...LEGACY_DESIGN_SCHEMA.properties, schemaVersion: integer,
  interaction: DESIGN_V3_SCHEMA.properties!.interaction!, execution: DESIGN_V3_SCHEMA.properties!.execution!,
  selectionBasis: DESIGN_V3_SCHEMA.properties!.selectionBasis!, platformClaims: (DESIGN_V3_SCHEMA.properties as Record<string, ToolSchema>).platformClaims!,
  connections: { anyOf: [DESIGN_V2_SCHEMA.properties!.connections!, DESIGN_V3_SCHEMA.properties!.connections!] } }, LEGACY_DESIGN_SCHEMA.required));
const architecture = object({ agentId: string, name: string, version: integer, contractVersion: integer, status: string, candidateHash: string,
  requirements: array(object({ id: string, text: string }, ["id", "text"])), draft: object({}), design: candidateDesign,
  sourceFingerprint: string, platformHash: string, platformContractVersion: integer, evidence: array({}),
  deferredVerifications: nullable(object({ issues: array(object({ requirementId: string, stage: string }, ["requirementId"])) })),
  review: ARCHITECTURE_REVIEW_SCHEMA, issues: array(object({ blocking: boolean }, ["blocking"])) },
  ["agentId", "name", "version", "contractVersion", "status", "candidateHash", "requirements", "design"]);
const properties = {
  id: string, agentId: string, name: string, version: integer, revision: integer, createdAt: string, updatedAt: string,
  architectureRef: reference, architecture, status: string, phase: string, delivery: string, summary: string,
  budgets: object({ corrections: integer, planRevisions: integer, integrationRepairs: integer }, ["corrections", "planRevisions", "integrationRepairs"]),
  planning: object({ turns: integer }, ["turns"]), tasks: array(task), plan: nullable(plan), planHash: nullable(string),
  planAttempts: array(object({ plan, planHash: string, review }, ["plan", "planHash", "review"])), reviews: array(object(review.properties!, [...review.required!, "mode", "codeHash", "planHash"])), reports: array(report),
  handoffs: array(object({ ...WORK_SCHEMA.properties, taskId: string, codeHash: string, files: array(file) }, [...WORK_SCHEMA.required, "taskId", "codeHash", "files"])),
  currentTaskId: nullable(string), snapshot: nullable(snapshot), verifiedSnapshot: nullable(snapshot), package: nullable(packageSchema),
  deliveries: array(object({ package: packageSchema, status: string, failureReportId: string }, ["package", "status"])), feedback: nullable(feedback),
  diagnostic: nullable(object({ stage: string, phase: string, reason: string, role: string }, ["stage", "phase", "reason"])), acceptanceLedger: ledger,
  sessions: { type: "object", additionalProperties: session }, needsReplan: boolean,
  pendingPlan: nullable(object({ plan, planHash: string }, ["plan", "planHash"])),
  pendingReview: nullable(object({ mode: string, subjectHash: string, planHash: nullable(string), codeHash: nullable(string), reportId: nullable(string) }, ["mode", "subjectHash", "planHash", "codeHash", "reportId"])),
  planningArtifact: planningSnapshot, planningDraft: draft, planningDraftSource: draft, planningIndexPath: string,
  argumentDiagnostics: array(object({})), planDraftChecks: array(object({ turn: integer, status: string, hash: nullable(string) }, ["hash"])),
  submissionCounts: { type: "object", additionalProperties: object({ attempts: integer, accepted: integer, rejected: integer }, ["attempts", "accepted", "rejected"]) },
  submissionAttempts: array(object({ sequence: integer, role: string, phase: string, taskId: string, turn: integer, stage: string, status: string,
    issues: array(object({ path: string, reason: string, remedy: string }, ["path", "reason", "remedy"])), at: string }, ["sequence", "role", "phase", "turn", "stage", "status", "issues", "at"])),
};
const valid = new Ajv({ strict: false, allErrors: false }).compile<DevelopmentRunRecord>(object(properties,
  ["id", "agentId", "name", "version", "revision", "createdAt", "updatedAt", "architectureRef", "architecture", "status", "phase", "delivery", "summary",
    "budgets", "planning", "tasks", "plan", "planHash", "planAttempts", "reviews", "reports", "handoffs", "currentTaskId", "package", "deliveries", "feedback"]));

/** Checks persisted controller fields without filling historical gaps or changing stored bytes. Semantic bindings remain controller gates. */
export function readDevelopmentRunRecord(value: unknown): DevelopmentRunRecord {
  if (!valid(value)) throw new InputError("研发检查点字段已损坏，不能恢复阶段状态或模型预算");
  if (value.architecture.draft !== undefined) checkedStoredDraft(value.architecture.draft);
  for (const delivery of [value.package, ...value.deliveries.map(item => item.package)]) {
    if (delivery?.application !== undefined) validateApplicationManifest(delivery.application);
  }
  return value;
}

const validDelivery = new Ajv({ strict: false, allErrors: false }).compile<DevelopmentDeliveryRecord>(object({ ...properties,
  architecture: {}, package: object({ codeHash: string, planHash: string, entrypoint: string, application: {}, snapshot: {}, acceptanceLedger: ledger },
    ["codeHash", "planHash", "application", "snapshot"]) }, ["id", "agentId", "status", "delivery", "planHash", "architectureRef", "package"]));
/** Read only the delivery and optional summary fields; stage-state validation belongs to development recovery. */
export function readDevelopmentDeliveryRecord(value: unknown): DevelopmentDeliveryRecord {
  if (!validDelivery(value)) throw new InputError("应用交付与当前 Agent 版本不一致");
  return value;
}
