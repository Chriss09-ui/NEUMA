import type { MainAgent } from "./main/main-agent.mjs";
import type { MainAgentMaterials } from "./main/main-agent-port.mjs";
import type { CollaborationService } from "./collaboration/groups.mjs";
import type { PrototypeAgents } from "./agents/agent-prototype.mjs";
import type { MainAgentAgents } from "./main/main-agent-port.mjs";
import type { CollaborationAgents } from "./collaboration/groups.mjs";
import type { ProjectManagerPort, Progress } from "./runtime/execution-port.mjs";
import type { ProjectManager } from "./projects/projects.mjs";
import type { AgentStorage } from "./agents/agent-storage.mjs";
import type { ApplicationService } from "./applications/application-service.mjs";
import type { AgentConnectionStore } from "./agents/agent-connections.mjs";
import type { ManagedServiceManager } from "./services/managed-service-manager.mjs";
import type { ServiceGateway } from "./services/service-gateway.mjs";
import type { WebCapabilityPort } from "./runtime/web-capabilities.mjs";

type Forwarded = "currentOperation" | "submitOperation" | "operation" | "cancelOperation" | "getConversation" | "saveConversation" | "getProfiles" | "getArchitecture" | "getDevelopment" |
  "getActiveRuntime" | "getMemory" | "setMemory" | "setProfile" | "remove" | "removeConversation" |
  "cancelBuild" | "cancelDevelopment" | "getAttachment" | "listAttachments" | "files" |
  "deliveryHistory" | "rollbackDelivery" | "changeService" | "previewTaskArtifact";
type ForwardedMethods = { [K in Forwarded]?: (...args: Parameters<PrototypeAgents[K]>) => unknown | Promise<unknown> };
export interface ServerPromptPort<Result = unknown> {
  prompt?(body: Record<string, unknown>, progress?: Progress, options?: { signal?: AbortSignal | undefined }): Promise<Result>;
  cancel?(sessionId: string): Promise<unknown>;
  dispose?(): unknown | Promise<unknown>;
}
export interface ServerAgents extends ForwardedMethods, Omit<MainAgentAgents, "services" | "connections" | "prompt" | "capabilityCards">, ServerPromptPort<{ reply: string; status?: string }> {
  capabilityCards?: NonNullable<CollaborationAgents["capabilityCards"]>;
  executeCollaboration?: NonNullable<CollaborationAgents["executeCollaboration"]>;
  onLifecycle?: NonNullable<CollaborationAgents["onLifecycle"]>;
  activitySnapshot?: NonNullable<CollaborationAgents["activitySnapshot"]>;
  file?: NonNullable<CollaborationAgents["file"]>;
  attachmentRaw?: PrototypeAgents["attachmentRaw"];
  attachmentPreview?: PrototypeAgents["attachmentPreview"];
  attachmentImage?: PrototypeAgents["attachmentImage"];
  uploadAttachment?: PrototypeAgents["uploadAttachment"];
  downloadFile?: PrototypeAgents["downloadFile"];
  readTaskArtifact?: PrototypeAgents["readTaskArtifact"];
  connectionRequirements?: PrototypeAgents["connectionRequirements"];
  connectionRequirementSets?: PrototypeAgents["connectionRequirementSets"];
  requireAgent?: (...args: Parameters<PrototypeAgents["requireAgent"]>) => unknown | Promise<unknown>;
  build?(body: Record<string, unknown>, options: { signal: AbortSignal; onProgress: Progress }): unknown | Promise<unknown>;
  develop?(id: string, options: { resume: boolean; signal: AbortSignal; onProgress: Progress }): unknown | Promise<unknown>;
  close?(): unknown | Promise<unknown>;
  ready?: Promise<unknown>;
  runtimeReady?: Promise<unknown>;
  persistence?: Promise<unknown>;
  storage?: Partial<AgentStorage>;
  architecture?: { ready?: Promise<unknown>; persistence?: Promise<unknown> };
  development?: { store?: { ready?: Promise<unknown>; persistence?: Promise<unknown> } };
  applications?: Partial<ApplicationService>;
  connections?: Partial<AgentConnectionStore>;
  services?: Partial<ManagedServiceManager>;
  gateway?: Partial<ServiceGateway>;
  web?: WebCapabilityPort;
}
export type ServerProjects = ProjectManagerPort & Partial<Pick<ProjectManager, "load" | "configure" | "dispose">> & { pendingAdds?: { size: number } };

type MainForwarded = "submit" | "operation" | "activateRequirements" | "cancel" | "createConversation" | "getConversation" | "listConversations" | "prompt" | "removeConversation";
export type ServerMainPort = { [K in MainForwarded]?: (...args: Parameters<MainAgent[K]>) => unknown | Promise<unknown> } & {
  ready?: Promise<unknown>; close?: MainAgent["close"]; materials?: MainAgentMaterials;
};
export type ServerCollaborationPort = Partial<Pick<CollaborationService, "activity" | "artifact" | "cancelTask" | "cards" | "createGroup" | "events" | "getGroup" | "listGroups" | "postMessage" | "removeConversation" | "requireMaterial" | "share" | "updateGroup" | "uploadMaterial" | "ready" | "materials" | "close" | "importMaterial">>;
