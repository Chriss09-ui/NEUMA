import { Ajv } from "ajv";
import type { AgentDefinition, ActivationTransaction, DeliveryHistoryEntry } from "./prototype-port.mjs";
import { checkedStoredDraft } from "../requirements/consultation-storage.mjs";
import { InputError } from "../requirements/core.mjs";
const string = { type: "string" }, integer = { type: "integer" };
const reference = { type: "object", properties: { version: integer, candidateHash: string }, required: ["version", "candidateHash"] };
const agent = { type: "object", properties: { id: string, name: string, fingerprint: string, instructions: string, revision: integer,
  draft: { type: "object" }, mode: string, status: string, memory: string, toolIds: { type: "array", items: string }, createdAt: string, updatedAt: string,
  profile: { type: "object", properties: { name: string, description: string, icon: string }, required: ["name", "description", "icon"] },
  architectureRef: reference, developmentRef: { type: "object", properties: { id: string, codeHash: string, planHash: { type: ["string", "null"] } }, required: ["id", "codeHash", "planHash"] },
  execution: { type: "object", properties: { kind: string, buildId: string, codeHash: string, entrypoint: string }, required: ["kind", "buildId", "codeHash", "entrypoint"] },
  dataMigrationRef: string, dataRecoveryRequired: { type: "boolean" } }, required: ["id", "name", "draft", "fingerprint", "instructions", "revision"] };
const ajv = new Ajv({ strict: false });
const validAgent = ajv.compile<AgentDefinition>(agent);
const validActivation = ajv.compile<ActivationTransaction>({ type: "object", properties: { status: string, direction: string, prior: { anyOf: [agent, { type: "null" }] },
  previousProfile: string, deliveryVersion: string, migrationId: string, developmentBinding: { type: "object", properties: { id: string, architectureRef: reference,
    codeHash: string, planHash: string, packageId: string }, required: ["id", "architectureRef", "codeHash", "planHash", "packageId"] } }, required: ["status", "deliveryVersion"] });
const validHistory = ajv.compile<DeliveryHistoryEntry[]>({ type: "array", items: { type: "object", properties: { deliveryVersion: string, agent,
  connectionProfile: string, stateVersion: integer, dataVersion: integer, language: string, host: string }, required: ["deliveryVersion", "agent", "stateVersion", "dataVersion", "language", "host"] } });
/** Check persisted shapes without filling defaults or changing the original historical object. */
export function checkedAgentDefinition(value: unknown): AgentDefinition {
  if (!validAgent(value)) throw new InputError("Agent 定义文件格式无效，请保留原文件");
  checkedStoredDraft(value.draft); return value;
}
export function checkedActivationTransaction(value: unknown): ActivationTransaction | null {
  if (value === null || value === undefined) return null;
  if (!validActivation(value)) throw new InputError("激活恢复记录格式无效，请保留原文件");
  if (value.prior) checkedAgentDefinition(value.prior); return value;
}
export function checkedDeliveryHistory(value: unknown): DeliveryHistoryEntry[] {
  if (!validHistory(value)) throw new InputError("历史交付记录格式无效，请保留原文件");
  for (const item of value) checkedAgentDefinition(item.agent); return value;
}
