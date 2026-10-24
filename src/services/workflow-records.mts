import { Ajv } from "ajv";
import type { WorkflowRecord } from "./service-port.mjs";
import type { ToolSchema } from "../contracts/tools.mjs";

const string = { type: "string" }, number = { type: "number" }, boolean = { type: "boolean" };
const object = (properties: Record<string, ToolSchema>, required: string[] = []): ToolSchema => ({ type: "object", properties, required, additionalProperties: true });
const nullable = (value: ToolSchema): ToolSchema => ({ anyOf: [value, { type: "null" }] });
const reference = object({ sha256: string, path: string }, ["sha256", "path"]);
const item = object({ index: number, status: string, attempts: number, resultRef: nullable(reference), explicitRetry: boolean, reason: string },
  ["index", "status", "attempts", "resultRef"]);
const step = object({ id: string, status: string, items: { type: "array", items: item }, responseRef: nullable(reference), resultRef: reference },
  ["id", "status", "items", "responseRef"]);
const schema = object({ schemaVersion: { const: 1 }, id: string, agentId: string, deliveryVersion: string, scopeId: string,
  definition: {}, definitionHash: string, status: string, createdAt: string, updatedAt: string, steps: { type: "array", items: step },
  waiting: nullable(object({ stepId: string, prompt: string, inputSchema: {}, index: number, reason: string }, ["stepId"])),
  resultRefs: { type: "object", additionalProperties: reference }, inputRef: reference, reason: string },
  ["schemaVersion", "id", "agentId", "deliveryVersion", "scopeId", "definition", "definitionHash", "status", "createdAt", "steps", "waiting", "resultRefs"]);
export const isWorkflowRecordEnvelope = new Ajv({ strict: false, allErrors: false }).compile<Omit<WorkflowRecord, "definition"> & { definition: unknown }>(schema);
