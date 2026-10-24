import type { UnknownRecord } from "./json.mjs";
export interface RequirementDraft extends UnknownRecord { goal: { value: string; [key: string]: unknown } }
export interface SavedRequirement extends UnknownRecord { id: string; name: string; draft: RequirementDraft; updatedAt: string; profile?: unknown }
export interface AttachmentRef { id: string }
export interface ConversationMessage {
  role: "user" | "assistant"; content: string; attachments?: AttachmentRef[]; revision?: string;
  delivery?: "sent" | "failed" | "stopped"; status?: "complete" | "error" | "stopped"; error?: string;
}
export interface ConversationSnapshot { schemaVersion: number; messages: ConversationMessage[] }
export interface ConversationRecord extends ConversationSnapshot {
  id: string; agentId: string; title: string; createdAt: string; updatedAt: string; saveVersion: number; mutationId: string; deletedAt?: never;
}
export interface ConversationTombstone { schemaVersion: number; id: string; agentId: string; deletedAt: string; messages?: never; saveVersion?: never; createdAt?: never; mutationId?: never }
export type StoredConversation = ConversationRecord | ConversationTombstone;
/** The storage envelope is validated here; M4 owns each phase/checkpoint's semantic payload. */
export interface DevelopmentInput extends UnknownRecord { id: string; agentId: string; status: string; version?: number; revision?: unknown }
export interface DevelopmentRecord extends DevelopmentInput { revision: number; createdAt: string; updatedAt: string }
