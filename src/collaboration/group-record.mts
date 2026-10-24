import { InputError } from "../requirements/core.mjs";
import type { GroupRecord } from "../contracts/collaboration.mjs";

// Disk JSON remains unknown until the fields consumed by the collaboration
// controller have been checked. Optional historical fields stay absent.
import { string, number, boolean, optional, nullable, array, object } from "../runtime/record-shape.mjs";
const strings = array(string), maybeString = optional(string), nullString = nullable(string);
const sender = object({ type: string, id: string, name: maybeString });
const replyRequest = object({ recipientId: string, kind: string });
const audience = object({ mode: string, memberIds: strings });
const routing = object({ mode: string, memberIds: strings, question: maybeString, sourceMessageId: string, generation: number });
const references = { replyRecipientId: maybeString, replyRequest: optional(replyRequest) };
const work = { capabilityId: maybeString, capabilityVersion: maybeString, inputs: maybeString, expectedOutput: maybeString, acceptance: maybeString };
const completion = { phase: maybeString, status: string, reason: maybeString };
const relayRequest = object({ id: string, sourceMessageId: string, requesterId: string, recipientId: string, kind: string,
  chainId: string, depth: number, visitedIds: strings, status: string, result: maybeString, reason: maybeString, replyMessageId: maybeString, reservedTurns: optional(number) });
const relay = object({ sourceMessageId: maybeString, generation: number, status: string, requests: array(relayRequest),
  completion: object(completion), needsInput: strings, failures: strings, limited: optional(boolean) });
const task = object({ toolReceipts: optional(array(object({ id: string, hash: string }))), id: string, conversationId: maybeString, groupId: maybeString, goal: string, status: string, phase: maybeString, reason: maybeString, ownerId: optional(nullString),
  participants: array(object({ id: string, name: maybeString, revision: number, capabilityVersion: maybeString })),
  requestedRecipientId: optional(nullString), requestedRecipientIds: optional(strings), attachmentIds: optional(strings),
  children: array(object({ id: string, title: string, description: string, assigneeId: nullString, required: boolean,
    dependsOn: strings, pendingQuestions: strings, status: string, result: string, reason: maybeString, artifactIds: strings,
    createdAt: string, updatedAt: string, requesterId: maybeString, ...work })),
  jobs: array(object({ id: string, agentId: string, childId: nullString, kind: string, messageId: nullString, status: string,
    createdAt: string, routeResolved: optional(boolean), intentChecked: optional(boolean), replyMessageId: maybeString })),
  intents: optional(array(object({ agentId: string, round: number, participate: boolean, contribution: string, willingToIntegrate: boolean,
    integratorId: nullString, interaction: maybeString, reply: maybeString, replyStatus: maybeString, failed: optional(boolean),
    replyMessageId: maybeString, replyAudience: optional(audience), ...references }))),
  requests: array(object({ id: string, agentId: string, capability: string, reason: string, status: string, createdAt: string })),
  negotiationRound: optional(number), turnsUsed: optional(number), generation: number, result: string, createdAt: string, updatedAt: string,
  taskAllowNetwork: optional(boolean), artifactIds: optional(strings),
  questions: optional(array(object({ id: string, askerId: string, recipientId: string, childId: nullString, parentQuestionId: nullString,
    status: string, result: maybeString, reason: maybeString, answerId: maybeString }))),
  replyRelay: optional(relay), replyRelayHistory: optional(array(relay)), replyAudience: optional(audience), replyRouting: optional(routing),
  continuationState: optional(object(completion)), integrationSignature: optional(nullString) });
const record = object({ schemaVersion: (value) => value === 1,
  group: object({ id: string, name: string, purpose: string, memberIds: strings, archived: boolean, materialIds: optional(strings), version: number,
    createdAt: string, updatedAt: string, lastSequence: number, activeTaskId: nullString, creationId: string, creationHash: string }),
  tasks: array(task), messages: array(object({ id: string, sender, content: string, taskId: nullString, recipientId: nullString,
    replyTo: nullString, status: string, createdAt: string, seq: number, visibility: maybeString, kind: maybeString,
    mentionIds: optional(strings), mentions: optional(array(object({ memberId: string, start: number, end: number, text: string }))),
    replyRequest: optional(replyRequest), replyRequestStatus: maybeString, replyAudience: optional(audience), replyRouting: optional(routing) })),
  events: array(object({ type: string, groupId: string, seq: number, createdAt: string, taskId: optional(nullString),
    agentId: optional(nullString), phase: maybeString, status: maybeString, messageId: maybeString, childId: optional(nullString) })),
  artifacts: array(object({ id: string, name: maybeString, path: string, agentId: string, taskId: nullString, content: string,
    hash: string, size: number, createdAt: string })),
  mutations: array(object({ id: string, hash: string, result: object({ taskId: maybeString, messageId: maybeString,
    attachment: optional(object({ id: string })) }) })),
  deletedConversations: optional(array(object({ id: string, taskIds: strings, deletedAt: string }))) });

export function checkedGroupRecord(value: unknown): GroupRecord {
  if (!record(value)) throw new InputError("群记录格式无效，请保留原文件");
  // The existing loader supplies the historical materialIds default immediately.
  return value as GroupRecord;
}
