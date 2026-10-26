import { InputError } from "../requirements/core.mjs";
export interface OperationReference {
  version: 1; domain: "main" | "build" | "development" | "group" | "application";
  ownerId: string; operationId: string; generation: string;
}
/** A cursor names a committed snapshot. Gaps rebase, never replay an execution. */
export function operationView<T>(operation: OperationReference, revision: number | string, snapshot: T, after?: string | null) {
  if (typeof revision === "number" ? !Number.isSafeInteger(revision) || revision < 0 : !/^[a-f0-9]{64}$/.test(revision)) throw new InputError("任务查看版本无效");
  const cursor = `${operation.domain}:${operation.ownerId}:${operation.operationId}:${operation.generation}:${revision}`;
  if (after !== undefined && after !== null && (typeof after !== "string" || after.length > 600 || /[\r\n\0]/.test(after))) throw new InputError("任务续读位置无效");
  return { operation, cursor, changed: after !== cursor, reset: after !== undefined && after !== null && after !== cursor,
    snapshot: after === cursor ? null : snapshot };
}
