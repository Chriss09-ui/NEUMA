import type { UnknownRecord } from "./json.mjs";
import type { ValueSchema } from "./application.mjs";
export type ServiceLanguage = "javascript" | "python";
export type ServiceHost = "managed" | "docker";
export interface ServiceOperation extends UnknownRecord { id: string; title?: unknown; inputSchema: ValueSchema; outputSchema: ValueSchema; connectionIds?: string[]; idempotent?: boolean; visibility?: "public" | "internal" }
export interface DependencyLock { name: string; version: string; url: string; sha256: string; filename: string; target?: unknown; installPath?: string; maxBytes?: number }
export interface WorkflowStep extends UnknownRecord { id: string; actionId: string; dependsOn: string[]; input?: unknown; batch?: { inputPath: string; maxItems: number }; waitForInput?: { prompt: string; inputSchema: ValueSchema }; idempotent: boolean; maxRetries?: number }
export interface WorkflowDefinition extends UnknownRecord { schemaVersion: 1; entryActionId: string; steps: WorkflowStep[]; outputs: string[] }
export interface ServiceManifest extends UnknownRecord { schemaVersion: 1; language: ServiceLanguage; host: ServiceHost; entrypoint: string; operations: ServiceOperation[]; dependencies: { packages: DependencyLock[] }; resources: { timeoutMs: number; memoryMiB: number; scratchMiB: number; logBytes: number }; capabilities: string[]; dataVersion: number; docker?: { baseImage: string; buildSteps?: string[][] }; workflow?: WorkflowDefinition; migration?: { fromVersion: number; actionId: string; verifyActionId: string } }
