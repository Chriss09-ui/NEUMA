import type { AgentDefinition, AgentProfile, AgentRequirement, ApplicationView, ArchitectureView, DevelopmentView, RuntimeState } from "./ui-types.js";
export interface UiRoute { page: string; projectView?: string | undefined; agentId: string | null; groupId: string | null }
export interface RuntimeChanged extends RuntimeState { agentId: string; agent: AgentRequirement; definition: AgentDefinition | null; architecture: ArchitectureView | null; development: DevelopmentView | null; application: ApplicationView | null; configurationAction: string | null; developmentAction: string | null; buildAction: string | null; buildBlocked: boolean; ready: boolean; busy: boolean }
export interface TaskArtifactDetail { agentId: string; taskId: string; index: number; artifact: { path?: string | undefined; name?: string | undefined; size?: number | undefined } }
interface AgentSelection { agentId: string | null }
interface AgentPanel extends AgentSelection { active: boolean }
declare global {
  interface DocumentEventMap {
    "neuma:route": CustomEvent<UiRoute>;
    "neuma:navigate": CustomEvent<Partial<UiRoute>>;
    "neuma:agents-changed": CustomEvent<{ items: AgentRequirement[]; busy: boolean }>;
    "neuma:agent-action": CustomEvent<{ action: string; id: string }>;
    "neuma:agent-build": CustomEvent<{ id: string }>;
    "neuma:agent-develop": CustomEvent<{ id: string }>;
    "neuma:agent-development-stop": CustomEvent<{ id: string }>;
    "neuma:agent-saved": CustomEvent<{ id: string; ok: boolean; message?: string | undefined }>;
    "neuma:agent-removed": CustomEvent<{ id: string }>;
    "neuma:agent-profile-changed": CustomEvent<{ id: string; profile: AgentProfile }>;
    "neuma:agent-profiles-loaded": CustomEvent<{ profiles: (AgentProfile & { id: string })[] }>;
    "neuma:agent-runtime-request": CustomEvent<AgentSelection>;
    "neuma:agent-runtime-change": CustomEvent<RuntimeChanged>;
    "neuma:agent-application-loaded": CustomEvent<{ agentId: string; application: ApplicationView; revision: number }>;
    "neuma:agent-connections-open": CustomEvent<AgentSelection | null>;
    "neuma:agent-services-open": CustomEvent<AgentSelection | null>;
    "neuma:agent-connections-view": CustomEvent<AgentPanel>;
    "neuma:agent-services-view": CustomEvent<AgentPanel>;
    "neuma:agent-settings-view": CustomEvent<AgentPanel>;
    "neuma:agent-connections-changed": CustomEvent<AgentSelection>;
    "neuma:agent-services-changed": CustomEvent<AgentSelection>;
    "neuma:agent-artifacts-changed": CustomEvent<AgentSelection>;
    "neuma:agent-task-artifact-open": CustomEvent<TaskArtifactDetail>;
    "neuma:agent-message-started": CustomEvent<AgentSelection & { sessionId: string }>;
    "neuma:agent-turn-finished": CustomEvent<AgentSelection>;
    "neuma:main-requirements": CustomEvent<{ agentId?: string | undefined } | null>;
    "neuma:main-requirement-saved": CustomEvent<{ requirement: AgentRequirement; build?: boolean | undefined }>;
    "neuma:project-select": CustomEvent<{ id: string }>;
  }
}
