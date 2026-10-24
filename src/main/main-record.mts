import { InputError } from "../requirements/core.mjs";
import { checkedConsultation } from "../requirements/consultation-storage.mjs";
import { normalizeTaskSpec } from "../requirements/task-spec.mjs";
import { string, number, boolean, optional, nullable, array, object, oneOf } from "../runtime/record-shape.mjs";
import type { MainRecord } from "../contracts/main.mjs";
const strings = array(string), maybeString = optional(string);
const fieldSource = oneOf("user", "inferred", "default", "unknown");
const field = object({ value: string, source: fieldSource });
const draft = object({ ...Object.fromEntries(["name", "agentType", "goal", "scenario", "inputSource", "task", "deliverable", "successCriteria", "routingCondition"].map((name) => [name, field])),
  constraints: array(object({ text: string, source: fieldSource })),
  usage: object({ mode: oneOf("on_demand", "scheduled", "event", "unclear"), detail: string, source: fieldSource }),
  externalAction: object({ mode: oneOf("none", "possible", "requested"), operation: string, target: string, scope: string, trigger: string, source: fieldSource }),
  interaction: optional(object({ defaultEntry: oneOf("conversation", "application"), page: boolean, operations: strings, inputs: string, results: string, persistentData: string,
    assistant: optional(object({ enabled: boolean, purpose: string })) })),
  connections: optional(array(object({ purpose: oneOf("search", "model", "business"), description: string, required: boolean }))),
  capabilityDependencies: strings, unresolved: strings, conflict: nullable(object({ left: string, right: string })),
  taskSpec: optional((value) => { try { normalizeTaskSpec(value); return true; } catch { return false; } }) });
const saved = object({ id: string, name: string, draft: object({ goal: object({ value: string }) }), updatedAt: maybeString });
const receipt = object({ version: oneOf(1), requestId: string, requirementHash: string, platformHash: string, assessmentId: string, draftHash: string, confirmedAt: string });
const requirement = object({ agentId: string, mode: string, draft, status: string, confirmed: boolean, version: number,
  question: nullable(string), lastQuestion: nullable(string), confirmationQuestion: nullable(string), summary: string, userMessages: strings,
  consultation: optional((value) => { try { checkedConsultation(value); return true; } catch { return false; } }),
  savedRequirement: optional(saved), createdAt: string, updatedAt: string, confirmation: optional(receipt) });
const context = object({ type: string, agentId: maybeString, groupId: maybeString, taskId: maybeString });
const diagnostic = object({ stage: string, reason: string });
const record = object({ schemaVersion: oneOf(1), id: string, title: string, version: number, createdAt: string, updatedAt: string,
  messages: array(object({ id: string, role: oneOf("user", "assistant"), content: string, status: string,
    sources: array(object({ type: string, agentId: maybeString, groupId: maybeString, taskId: maybeString, sessionId: maybeString,
      conversationId: maybeString, sourceLink: maybeString, status: maybeString, operation: maybeString, name: maybeString, reply: maybeString, message: maybeString })),
    actions: array(object({ type: string })), createdAt: string, updatedAt: string,
    attachments: optional(array(object({ id: string, name: string }))), diagnostic: optional(diagnostic) })),
  requests: array(object({ mutationId: string, hash: string, userId: string, assistantId: string, status: string, diagnostic: optional(diagnostic) })),
  creationMutationId: maybeString, deletedAt: maybeString, deletionMutationId: maybeString, deletionExpectedVersion: optional(number),
  requirements: optional(array(requirement)), requirement: optional(nullable(requirement)), context: optional(nullable(context)),
  requirementActivations: optional(array(object({ mutationId: string, agentId: nullable(string), context: nullable(context) }))) });
export function checkedMainRecordShape(value: unknown): MainRecord {
  if (!record(value)) throw new InputError("主 Agent 对话记录格式无效");
  return value as MainRecord;
}
