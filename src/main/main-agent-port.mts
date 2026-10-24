import type { MainMaterials } from "./main-materials.mjs";
import type { ConversationMessage } from "../contracts/storage.mjs";
import type { EvidenceMessage } from "../contracts/requirements.mjs";
import type { NeumaTool, Progress } from "../runtime/pi-port.mjs";
import type { MainRequirementAgents } from "./main-requirements.mjs";
import type { CollaborationService } from "../collaboration/groups.mjs";
import type { PromptOptions } from "../agents/prototype-port.mjs";

export interface MainAgentAgents extends MainRequirementAgents {
  services?: { environment?(): Promise<unknown> } | undefined;
  connections?: { snapshot?(agentId: string): Promise<unknown> } | undefined;
  capabilityCards?(): Promise<{ agents?: { id: string; name?: string | undefined; ready?: boolean; revision?: unknown }[] }>;
  listConversations?(agentId: string): Promise<unknown>;
  getConversationRecord?(agentId: string, conversationId: string): Promise<{ conversation?: unknown }>;
  saveConversationRecord?(agentId: string, conversationId: string, input: unknown): Promise<{ conversation?: { saveVersion: number } | null }>;
  prompt?(input: { agentId: string; sessionId: string; message: string; history: unknown[]; source: { kind: string; conversationId: string; mutationId: string } }, onProgress: Progress, options: PromptOptions): Promise<{ reply: string; status?: string }>;
  cancel?(sessionId: string): Promise<unknown>;
}
export interface MainTaskView { id: string; status: string; groupId?: string | undefined; groupName?: string | undefined; goal?: unknown;
  phase?: unknown; ownerId?: unknown; reason?: unknown; result?: unknown; updatedAt?: unknown; children?: unknown[]; turnsUsed?: unknown }
export interface MainGroupView { group: unknown; members?: unknown; tasks?: MainTaskView[]; messages?: { taskId?: string | null }[];
  materials?: unknown[]; artifacts?: { taskId?: string | null }[]; lastSequence?: unknown }
export interface MainAgentCollaboration {
  activity?(): Promise<{ tasks?: MainTaskView[] }>;
  listGroups?(): Promise<unknown>;
  getGroup?(groupId: string): Promise<MainGroupView>;
  createGroup?(input: Record<string, unknown>): Promise<{ group: { id: string } } | { id: string; group?: never }>;
  updateGroup?(groupId: string, input: Record<string, unknown>): Promise<unknown>;
  postMessage?(groupId: string, input: Record<string, unknown>, options: { source: string; taskAllowNetwork: boolean }): Promise<{ task?: { id: string; status: string } }>;
  cancelTask?(groupId: string, taskId: string): Promise<{ task?: { status: string }; cancelled?: unknown }>;
  importMaterial?: CollaborationService["importMaterial"];
}
export interface MainAttachment { id: string; name: string; kind?: unknown; mimeType?: unknown; status?: unknown; size?: unknown }
export interface MainAgentMaterials {
  list?: MainMaterials["list"];
  upload?: MainMaterials["upload"];
  materials?: Pick<MainMaterials["materials"], "raw" | "preview">;
  ready?: Promise<unknown>;
  resolve?(conversationId: string, attachmentIds: string[]): Promise<MainAttachment[]>;
  tools?(conversationId: string): NeumaTool[];
  forward?(conversationId: string, groupId: string, attachmentIds: string[], options: { signal: AbortSignal; mutationId: string }): Promise<{ attachmentIds: string[] }>;
  measure?(conversationId: string, attachmentIds: string[], options: { signal: AbortSignal }): Promise<EvidenceMessage[]>;
  close?(): unknown;
}
