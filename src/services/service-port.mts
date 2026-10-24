import type { ServiceManifest, ServiceLanguage, WorkflowDefinition } from "../contracts/service.mjs";
import type { UnknownRecord } from "../contracts/json.mjs";
export type Progress = (value: UnknownRecord) => void | Promise<void>;
export interface ProgressOptions { signal?: AbortSignal | undefined; onProgress?: Progress | undefined }
export interface ReadyEnvironment { available: true; language: string; version: string; executable: string; runtimeRoot: string | null }
export interface UnavailableEnvironment { available: false; language: string; version: string; reason: string }
export type RuntimeEnvironment = ReadyEnvironment | UnavailableEnvironment;
export interface InstalledDependencies { path: string; hash: string; treeHash: string }
export interface IsolationProbe { available: boolean; reason?: string; kind?: string; host?: string; checks?: unknown; version?: unknown; verified?: boolean; language?: string; resourceEnforcement?: string }
export interface DockerDelivery { imageId: string; seccompPath: string; buildHash: string; isolation?: IsolationProbe }
export interface ServiceIdentity { agentId: string; deliveryVersion: string; scopeId?: string | undefined }
export interface DeliveryRecord extends ServiceIdentity { schemaVersion: 1; directory: string; codeDir: string; sourceHash: string; manifestHash: string; manifest: ServiceManifest; dependencies: InstalledDependencies; createdAt: string; isolation: IsolationProbe; docker?: DockerDelivery }
export interface ServiceCatalog { schemaVersion: 1; deliveries: Record<string, DeliveryRecord>; active: Record<string, string>; desired: Record<string, ServiceIdentity> }
export interface ServiceResult { status: string; reason?: string | undefined; output?: unknown }
export interface CapabilityContext { signal: AbortSignal; requestId?: string; agentId?: string; deliveryVersion?: string; scopeId?: string }
export type CapabilityHandler = (name: string, args: unknown, context: CapabilityContext) => Promise<unknown> | unknown;
export interface ServiceRunOptions extends ServiceIdentity { actionId: string; input: unknown; signal?: AbortSignal | undefined; persist?: boolean; capabilityHandler?: CapabilityHandler | undefined; onProgress?: Progress | undefined }
export interface ServicePrepareOptions extends ProgressOptions { agentId: string; deliveryVersion: string; manifest: unknown; codeDir: string }
export interface WorkflowReference { sha256: string; path: string }
export interface WorkflowItem { index: number; status: string; attempts: number; resultRef: WorkflowReference | null; explicitRetry?: boolean; reason?: string }
export interface WorkflowStepState { id: string; status: string; items: WorkflowItem[]; responseRef: WorkflowReference | null; resultRef?: WorkflowReference }
export interface WorkflowRecord { schemaVersion: 1; id: string; agentId: string; deliveryVersion: string; scopeId: string; definition: WorkflowDefinition; definitionHash: string; status: string; createdAt: string; updatedAt?: string; steps: WorkflowStepState[]; waiting: { stepId: string; prompt?: string; inputSchema?: unknown; index?: number; reason?: string } | null; resultRefs: Record<string, WorkflowReference | undefined>; inputRef?: WorkflowReference; reason?: string }
export interface WorkflowContextOptions<Context> { signal?: AbortSignal | undefined; context?: Context | undefined }
export interface WorkflowStartOptions<Context> extends WorkflowContextOptions<Context>, ServiceIdentity { id?: string; definition: unknown; input: unknown }
export interface WorkflowResolution { stepId: string; index: number; outcome: string; output?: unknown; explicitlyApproved?: boolean }
export interface WorkflowResumeOptions<Context> extends WorkflowContextOptions<Context> { id: string; input?: unknown; resolution?: unknown }
export interface WorkflowActionOptions<Context> extends WorkflowContextOptions<Context>, ServiceRunOptions { workflowId: string; stepId: string; itemIndex: number }
