import { objectFields } from "./type-boundary.mjs";

import { randomUUID } from "node:crypto";
import type { ExecutionAttempt } from "../contracts/execution.mjs";
export type { ExecutionAttempt, ExecutionDispatch } from "../contracts/execution.mjs";
export function createExecutionAttempt(bindingHash: string, number: number): ExecutionAttempt {
  const value: ExecutionAttempt = { version: 1, id: randomUUID(), number, bindingHash, phase: "prepared" };
  if (!isExecutionAttempt(value)) throw new Error("执行尝试绑定无效");
  return value;
}
export function isExecutionAttempt(input: unknown): input is ExecutionAttempt {
  const value = objectFields(input), reference = objectFields(value.resultRef);
  return value.version === 1 && typeof value.id === "string" && /^[a-f0-9-]{36}$/.test(value.id)
    && Number.isSafeInteger(value.number) && Number(value.number) > 0
    && typeof value.bindingHash === "string" && /^[a-f0-9]{64}$/.test(value.bindingHash)
    && ["prepared", "dispatched", "completed"].includes(String(value.phase))
    && (value.resolution === undefined || value.resolution === "verified" || value.resolution === "retry_approved")
    && (value.uncertain === undefined || typeof value.uncertain === "boolean")
    && (value.phase === "completed" ? typeof reference.sha256 === "string" && /^[a-f0-9]{64}$/.test(reference.sha256)
      && typeof reference.path === "string" : value.resultRef === undefined);
}
export function executionOutcome(attempt?: ExecutionAttempt): "not_started" | "unknown" | "completed" {
  // Legacy absence is never evidence that a side effect did not happen.
  return !attempt || attempt.phase === "dispatched" ? "unknown" : attempt.phase === "prepared" ? "not_started" : "completed";
}
