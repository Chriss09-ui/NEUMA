import type { ConnectionDefinition } from "../contracts/connection.mjs";
import { validateSchema } from "./http-adapter.mjs";

const text = { type: "string", minLength: 1, maxLength: 4000 }, id = { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,79}$" };
const mapping = { type: "object", additionalProperties: { anyOf: [{ type: "string", maxLength: 200 }, { type: "object", properties: { from: { type: "string" }, config: id, credential: id, literal: {} }, additionalProperties: false }] } };
export const CONNECTION_DEFINITION_SCHEMA = { type: "object", required: ["id", "purpose", "required", "description", "operations"], additionalProperties: false, properties: {
  id, purpose: { enum: ["search", "model", "business"] }, required: { type: "boolean" }, description: text, label: text,
  protocol: { enum: ["http", "mcp"] },
  configFields: { type: "array", maxItems: 40, items: { type: "object", required: ["key", "label", "type"], additionalProperties: false, properties: {
    key: id, label: text, type: { enum: ["text", "password", "number", "select"] }, required: { type: "boolean" },
    options: { type: "array", maxItems: 200, items: { anyOf: [{ type: "string" }, { type: "object", required: ["value", "label"], additionalProperties: false, properties: { value: { type: "string" }, label: text } }] } },
    optionsFrom: { type: "object", required: ["operationId", "valuePath", "labelPath"], additionalProperties: false, properties: { operationId: id, itemsPath: { type: "string" }, valuePath: { type: "string" }, labelPath: { type: "string" } } },
  } } },
  operations: { type: "array", maxItems: 40, items: { type: "object", required: ["id"], additionalProperties: false, properties: {
    id, description: text, method: { enum: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] }, path: text, input: text, output: text,
    safeTest: { type: "boolean" }, readOnly: { type: "boolean" }, testInput: { type: "object" }, inputSchema: { type: "object" }, outputSchema: { type: "object" },
    tool: text, resourceUri: text, timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 },
    request: { type: "object", additionalProperties: false, properties: { path: mapping, query: mapping, headers: mapping, body: mapping, bodyFrom: { type: "string" }, encoding: { enum: ["json", "form", "multipart"] } } },
  } } },
} };
export function validateConnectionDefinition(input: unknown): ConnectionDefinition {
  validateSchema(CONNECTION_DEFINITION_SCHEMA, input, "invalid_operation");
  const definition = input as ConnectionDefinition;
  if (new Set(definition.operations.map((operation) => operation.id)).size !== definition.operations.length) throw Object.assign(new Error("连接操作编号不能重复"), { reason: "invalid_operation" });
  for (const operation of definition.operations) {
    const valid = definition.protocol === "mcp" ? Boolean(operation.tool) !== Boolean(operation.resourceUri) : Boolean(operation.method && operation.path);
    if (!valid) throw Object.assign(new Error("连接操作缺少所选协议的必要定义"), { reason: "invalid_operation" });
    if (operation.safeTest && operation.readOnly === false) throw Object.assign(new Error("有副作用的操作不能作为连接测试"), { reason: "invalid_operation" });
  }
  return definition;
}
