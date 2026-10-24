import assert from "node:assert/strict";
export function checkedText(value: unknown): string {
  assert.ok(typeof value === "string", "expected a text field");
  return value;
}
