/** Transport values. Disk reads and external tool arguments remain unknown until validated. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type UnknownRecord = Record<string, unknown>;
export interface ValidationIssue { path: string; reason: string }
export interface Validator<T, O = undefined> { (value: unknown, options?: O): T }
