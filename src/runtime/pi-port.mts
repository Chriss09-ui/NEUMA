/** Compatibility import for existing integrations. New business code uses execution-port. */
export * from "./execution-port.mjs";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ResolvedModelProfile } from "../contracts/model.mjs";
import type { ModelRequestRejection } from "./execution-port.mjs";
export type NeumaPiSession = AgentSession & { modelCallAccounting: boolean; modelProfile: ResolvedModelProfile; modelProfileHash: string; readonly modelRequestRejection?: ModelRequestRejection; sessionBindingHash?: string };
