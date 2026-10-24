import type { Consultation } from "../contracts/requirements.mjs";
import type { UnknownRecord } from "../contracts/json.mjs";
import { InputError } from "./core.mjs";
import { isRecord } from "../runtime/type-boundary.mjs";

type Check = (value: unknown) => boolean;
const string: Check = value => typeof value === "string";
const boolean: Check = value => typeof value === "boolean";
const integer: Check = value => typeof value === "number" && Number.isSafeInteger(value);
const strings: Check = value => Array.isArray(value) && (value as unknown[]).every(string);
const array = (check: Check): Check => value => Array.isArray(value) && (value as unknown[]).every(check);
const member = (...values: string[]): Check => value => typeof value === "string" && values.includes(value);
const optional = (check: Check): Check => value => value === undefined || check(value);
function fields(value: unknown, required: Record<string, Check>, extras: Record<string, Check> = {}): boolean {
  if (!isRecord(value)) return false;
  return Object.entries(required).every(([key, check]) => check(value[key]))
    && Object.entries(extras).every(([key, check]) => optional(check)(value[key]));
}
const reference: Check = value => fields(value, { messageId: string, quote: string });
const message: Check = value => fields(value, { id: string, role: member("user", "assistant", "measurement"), content: string });
const stage = member("requirements", "development", "activation", "runtime");
const owner = member("user", "system", "runtime");
const progress: Check = value => fields(value, { basisHash: string, established: string, missing: string,
  nextAction: value => fields(value, { kind: string, detail: string }) });
const decision: Check = value => fields(value, { issueId: string, status: member("open", "resolved", "reopened"), reason: string, evidence: array(reference) },
  { owner, stage, checks: strings, progress, derivationIds: strings });
const issue: Check = value => fields(value, { id: string, owner, blocking: boolean, question: string, impact: string, requirementIds: strings },
  { stage, checks: strings, status: member("open", "resolved", "reopened"), current: boolean, handoffId: string, requirementHash: string,
    resolution: value => decision(value) && fields(value, { assessmentId: string, evidenceHash: string, evidenceIds: strings }) });
const systemCheck: Check = value => fields(value, { id: string, status: string, message: string,
  evidence: array(value => fields(value, { source: string, reference: string, detail: string })) });
const formula: Check = value => fields(value, { ref: string }) || fields(value, { value: string })
  || fields(value, { op: string, args: array(formula) });
const derivation: Check = value => fields(value, { id: string, status: value => value === "calculated", issueId: string,
  requirementIds: strings, requirementHash: string, platformHash: string, requestHash: string, scope: string,
  premises: array(value => fields(value, { id: string, value: string, unit: string, source: value => fields(value,
    { kind: member("requirement", "platform"), reference: string, detail: string }) })),
  expressions: array(value => fields(value, { id: string, unit: string, formula, value: string })) },
  { version: value => value === 2, factBindings: value => fields(value, { version: value => value === 1, scopeHash: string,
    requirements: array(value => fields(value, { reference: string, hash: string })),
    platform: array(value => fields(value, { reference: string, hash: string })),
    verification: array(value => fields(value, { reference: string, hash: string })) }) });
const deferredIssue: Check = value => issue(value) && fields(value, {
  stageDecision: value => fields(value, { stage: string, reason: string, checks: strings }, { assessmentId: string, derivationIds: strings }),
  verification: array(systemCheck),
});
const receipt: Check = value => fields(value, { version: value => value === 1, requestId: string, requirementHash: string,
  platformHash: string, assessmentId: string, draftHash: string, confirmedAt: string });
const assessment: Check = value => fields(value, { id: string, requirementHash: string, platformHash: string, evidenceHash: string }, {
  createdAt: string, requestId: string, systemReviewVersion: integer, failure: string, message: string,
  verdict: member("sufficient", "needs_input", "blocked"), direction: string, adequacy: string,
  dimensionChecks: array(value => fields(value, { dimension: member("input_scale", "processing", "delivery", "workflow", "data_lifecycle", "external_conditions"),
    status: member("sufficient", "not_applicable", "unknown"), reason: string, requirementIds: strings })),
  issues: array(issue), issueDecisions: array(decision), systemChecks: array(systemCheck), deferredIssues: array(deferredIssue),
  derivations: array(derivation), systemProgress: array(progress),
});

/** Checks stored field shapes without normalizing, upgrading, or modifying the saved history. Semantic gates still run on use. */
export function checkedConsultation(value: unknown): Consultation {
  const valid = fields(value, { version: integer, revision: integer, evidenceMessages: array(message), assessments: array(assessment), issues: array(issue), receipts: array(receipt) }, {
    displayedHash: string,
    notes: array(value => fields(value, { id: string, kind: value => value === "system_unresolved", issueId: string, sourceRequirementHash: string, assessmentId: string, text: string })),
    handoff: value => fields(value, { id: string, requirementHash: string, architectureVersion: integer, issues: array(issue) }, { resolved: boolean }),
  });
  if (!valid) throw Object.assign(new InputError("需求咨询记录字段格式无效，已有记录保留"), { reason: "consultation_record_invalid" });
  // Every declared non-opaque field above has been checked; extra historic fields stay on the original object.
  return value as Consultation;
}

export function checkedStoredDraft(value: unknown): import("../contracts/requirements.mjs").RequirementDraft {
  const source = member("user", "inferred", "default", "unknown");
  const field: Check = value => fields(value, { value: string, source });
  const required: Record<string, Check> = Object.fromEntries(["name", "agentType", "goal", "scenario", "inputSource", "task", "deliverable", "successCriteria", "routingCondition"].map(key => [key, field]));
  Object.assign(required, { constraints: array(value => fields(value, { text: string, source }, { value: string }) || fields(value, { value: string, source }, { text: string })), capabilityDependencies: strings, unresolved: strings,
    usage: value => fields(value, { mode: member("on_demand", "scheduled", "event", "unclear"), detail: string, source }),
    externalAction: value => fields(value, { mode: member("none", "possible", "requested"), operation: string, target: string, scope: string, trigger: string, source }),
    conflict: value => value === null || fields(value, { left: string, right: string }) } satisfies Record<string, Check>);
  const taskSpec: Check = value => fields(value, { version: value => value === 1, items: array(value => fields(value, {
    id: string, dimension: member("input_scale", "processing", "delivery", "workflow", "data_lifecycle", "external_conditions"), content: string,
    applicability: member("applies", "not_applicable", "unknown"), critical: boolean,
    source: value => fields(value, { kind: member("user", "accepted", "measured", "inferred", "unknown"), evidence: array(reference) }, { reason: string }),
  })) }, { retired: array(value => fields(value, { id: string, reason: string, evidence: array(reference) })) });
  const valid = fields(value, required, { taskSpec,
    interaction: value => fields(value, { defaultEntry: member("conversation", "application"), page: boolean, operations: strings, inputs: string, results: string, persistentData: string },
      { assistant: value => fields(value, { enabled: boolean, purpose: string }) }),
    connections: array(value => fields(value, { purpose: member("search", "model", "business"), description: string, required: boolean })),
  });
  if (!valid) throw Object.assign(new InputError("保存的需求草稿字段格式无效，已有记录保留"), { reason: "requirement_record_invalid" });
  return value as import("../contracts/requirements.mjs").RequirementDraft;
}

/** Read handoff fields without resolving issues or changing historical records. */
export function checkedRequirementHandoff(value: unknown): import("../contracts/requirements.mjs").RequirementHandoff {
  if (!fields(value, { id: string, requirementHash: string, architectureVersion: integer, issues: array(issue) }, { resolved: boolean }))
    throw new InputError("需求交接已过期或格式无效，请刷新后重试");
  return value as import("../contracts/requirements.mjs").RequirementHandoff;
}
