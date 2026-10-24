import type { RequirementDraft } from "../contracts/requirements.mjs";
import type { ModelConfig } from "../contracts/model.mjs";
import type { UnknownRecord } from "../contracts/json.mjs";
import type { AgentStorage } from "./agent-storage.mjs";
import type { MaterialStore } from "../materials/material-store.mjs";
import type { AgentConnectionStore } from "./agent-connections.mjs";
import type { ArchitectureDesigner } from "../architecture/architecture.mjs";
import type { DevelopmentController } from "../development/development.mjs";
import type { ApplicationService } from "../applications/application-service.mjs";
import type { ApplicationContext } from "../applications/application-context.mjs";
import type { ManagedServiceManager } from "../services/managed-service-manager.mjs";
import type { WebCapabilities } from "../runtime/web-capabilities.mjs";
import type { SessionFactory, PiSessionPort, NeumaTool } from "../runtime/pi-port.mjs";
import type { ConnectionSnapshot } from "../contracts/connection.mjs";
import type { ArchitectureReference } from "../development/development-controller-types.mjs";
export interface AgentProfile { name: string; description: string; icon: string }
export interface AgentDefinition { id: string; name: string; draft: RequirementDraft; fingerprint: string; instructions: string; revision: number;
  mode?: string; status?: string; profile?: AgentProfile | undefined; memory?: string | undefined; toolIds?: string[];
  createdAt?: string; updatedAt?: string; architectureRef?: ArchitectureReference; developmentRef?: { id: string; codeHash: string; planHash: string | null };
  execution?: { kind: string; buildId: string; codeHash: string; entrypoint: string }; dataMigrationRef?: string; dataRecoveryRequired?: boolean }
export interface ActivationBinding { id: string; architectureRef: ArchitectureReference; codeHash: string; planHash: string; packageId: string }
export interface ActivationTransaction { status: string; direction?: string; prior?: AgentDefinition | null | undefined; previousProfile?: string; deliveryVersion: string; migrationId?: string; developmentBinding?: ActivationBinding }
export interface DeliveryHistoryEntry { deliveryVersion: string; agent: AgentDefinition; connectionProfile?: string; stateVersion: number; dataVersion: number; language: string; host: string }
export interface BuildContext { controller: AbortController; cancelled: boolean; done: Promise<void>; finish(): void; session?: PiSessionPort | null; failed?: boolean }
export interface PrototypeSession { agentId: string; revision: number; connectionVersion?: number; session: PiSessionPort | null; busy: boolean;
  usedAt: number; controller: AbortController; cancelled?: boolean; failed?: boolean; failure?: { message: string; reason: string } | null;
  retries?: number; turns: number; applicationContext?: ApplicationContext | null; allowNetwork: boolean; connectionSnapshot: ConnectionSnapshot;
  refreshWeb?: boolean; hasImages?: boolean; runtimeEvidence: UnknownRecord[]; done: Promise<void>; finish(): void }
export type MaterialTool = NeumaTool & { resolveFile?: (id: string, signal?: AbortSignal) => Promise<{ path: string; name: string; mimeType: string; size?: number }> };
export interface CapabilityInput { capability: string; args: unknown; signal?: AbortSignal | undefined }
export interface PrototypeOptions { config: ModelConfig; cwd: string; dataDir: string; sessionFactory?: SessionFactory; fidelitySessionFactory?: SessionFactory;
  architecture?: ArchitectureDesigner; development?: DevelopmentController; storage?: AgentStorage; materials?: MaterialStore; connections?: AgentConnectionStore;
  connectionOptions?: Omit<ConstructorParameters<typeof AgentConnectionStore>[0], "dataDir" | "storage">; web?: WebCapabilities; applications?: ApplicationService;
  services?: ManagedServiceManager; enforceRequirementConfirmation?: boolean }
export interface PromptInput { agentId: string; sessionId: string; message?: string; history?: unknown; attachments?: unknown; applicationContext?: unknown; source?: unknown; scope?: unknown }
export interface PromptOptions { signal?: AbortSignal | undefined; activityScope?: { kind: string; conversationId: string }; taskAllowNetwork?: boolean }
export interface CollaborationOptions { agentId: string; revision: number; capabilityVersion?: string | undefined; taskAllowNetwork?: boolean; sessionId: string; message: string;
  systemContext?: string; customTools?: MaterialTool[]; allowBusinessTools?: boolean; role?: string; maxTurns?: number; scope: { groupId: string; taskId: string } }
