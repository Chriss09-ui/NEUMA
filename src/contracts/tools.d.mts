import type { UnknownRecord, JsonValue } from "./json.mjs";
/** The registered schema vocabulary is broader than the restricted action value schema. */
export interface ToolSchema {
  [key: string]: unknown;
  type?: string | string[]; properties?: Record<string, ToolSchema>; required?: string[];
  items?: ToolSchema; anyOf?: ToolSchema[]; oneOf?: ToolSchema[]; allOf?: ToolSchema[];
  then?: ToolSchema; else?: ToolSchema; const?: unknown; enum?: unknown[];
}
export interface ToolResult { content: ({ type: "text"; text: string } | { type: "image"; mimeType: string; data: string })[]; details: unknown; terminate?: boolean }
export interface DiagnosticHint {
  expectedType?: string | undefined; expectedTypes?: string[];
  allowedFields?: string[]; requiredFields?: string[]; allowedValues?: unknown[];
  fields?: (DiagnosticHint & { field: string })[]; alternatives?: DiagnosticHint[];
  allowedFieldsTruncated?: boolean; requiredFieldsTruncated?: boolean; allowedValuesTruncated?: boolean;
  fieldsTruncated?: boolean; alternativesTruncated?: boolean;
}
export interface ToolInputIssue extends DiagnosticHint { path: string; reason: string; remedy: string; receivedType: string; constraints?: Record<string, number> }
export type ToolInputValidation = { valid: true; issues: [] } | { valid: false; issues: ToolInputIssue[]; total: number; retained: number; truncated: boolean };
