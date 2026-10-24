import type { UnknownRecord } from "./json.mjs";
/** Version tags are descriptive. Reading never upgrades checkpoints or replenishes budgets. */
export type TaskSpecVersion = 1;
export type ArchitectureContractVersion = 1 | 2 | 3;
export type ArchitectureDesignCheckpointVersion = 1 | 2 | 3;
export type ArchitectureReviewProgressVersion = 1 | 2 | 3 | 4;
export type DevelopmentPlanVersion = 1 | 2 | 3;
export interface VersionedInput<V extends number> extends UnknownRecord { schemaVersion: V }
/** Shared task facts retain their original evidence and version discriminants. */
export interface EvidenceReference { messageId: string; quote: string }
export interface TaskSpecV1 {
  version: 1;
  items: { id: string; dimension: "input_scale" | "processing" | "delivery" | "workflow" | "data_lifecycle" | "external_conditions";
    content: string; applicability: "applies" | "not_applicable" | "unknown"; critical: boolean;
    source: { kind: "user" | "accepted" | "measured" | "inferred" | "unknown"; evidence: EvidenceReference[]; reason?: string } }[];
  retired?: { id: string; reason: string; evidence: EvidenceReference[] }[];
}
export type ArchitectureDesignEnvelope = import("./architecture.mjs").ArchitectureDesign;
export type DevelopmentPlanEnvelope = import("./development.mjs").DevelopmentPlan;
export interface TaskSpecValidator { (value: unknown): TaskSpecV1 }
