import type { UnknownRecord } from "../contracts/json.mjs";
/** A view of untrusted fields, never a claim that their values form a validated DTO. */
export function objectFields(value: unknown): UnknownRecord {
  return value !== null && (typeof value === "object" || typeof value === "function") ? value as UnknownRecord : {};
}
export function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
export function isPlainRecord(value: unknown): value is UnknownRecord {
  return isRecord(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
export function isArray(value: unknown): value is unknown[] { return Array.isArray(value); }
export function isInteger(value: unknown): value is number { return Number.isSafeInteger(value); }
export function errorField(error: unknown, key: string): unknown { return objectFields(error)[key]; }
