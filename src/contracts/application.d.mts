import type { JsonPrimitive, JsonValue, UnknownRecord } from "./json.mjs";
export type ValueKind = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
export interface ValueSchema {
  type?: ValueKind;
  description?: string;
  properties?: Record<string, ValueSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: ValueSchema;
  enum?: JsonPrimitive[];
  minLength?: number; maxLength?: number; minimum?: number; maximum?: number; minItems?: number; maxItems?: number;
}
export interface ApplicationAction { id: string; title: string; inputSchema: ValueSchema; outputSchema: ValueSchema; connectionIds: string[] }
export interface ApplicationPage { entrypoint: string; resources: { path: string; sha256: string }[] }
/** Service implementation is checked by its existing validator; full service migration belongs to M5. */
export interface ApplicationManifestBase extends UnknownRecord { entrypoint: string; page: ApplicationPage | null; actions: ApplicationAction[]; stateVersion: number; evidenceIds: string[] }
export type ApplicationManifest = ApplicationManifestBase & ({ protocolVersion: 2; runtime: "node-action" } | { protocolVersion: 3; runtime: "managed-service"; service: UnknownRecord });
export interface SnapshotFile { path: string; hash: string; [key: string]: unknown }
export interface ApplicationSnapshot { files: SnapshotFile[]; [key: string]: unknown }
export interface TaskSource extends UnknownRecord { scope: string; kind?: string }
export interface ApplicationTaskInput extends UnknownRecord {
  actionId: string; input: unknown; mutationId: string; deliveryVersion: string; source: TaskSource;
}
export interface TaskArtifact extends UnknownRecord { path: string; snapshotId?: string; name?: unknown; size?: unknown; sha256?: unknown }
export interface TaskEvent extends UnknownRecord { type: string; seq: number; at: string; taskId: string }
export interface ApplicationTask extends ApplicationTaskInput {
  id: string; agentId: string; status: string; sequence: number; requestHash: string; createdAt: string; updatedAt: string;
  progress: unknown; result: unknown; artifacts: TaskArtifact[]; events: TaskEvent[];
  workflowId?: string; resumeReceipts?: { mutationId: string; requestHash: string }[];
  error?: string | null; finishedAt?: string | null;
}
export interface TaskRecord { version: 1; agentId: string; tasks: ApplicationTask[]; [key: string]: unknown }
export interface ApplicationState { state: unknown; version: number; stateVersion: number; [key: string]: unknown }
