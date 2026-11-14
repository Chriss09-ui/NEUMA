import { setTimeout as pause } from "node:timers/promises";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import { InputError } from "../src/requirements/core.mjs";
import type { OperationReference } from "../src/runtime/operation-view.mjs";

export interface DevelopmentOperationSnapshot {
  running: boolean; interrupted: boolean; error: string | null;
  phase?: string; label?: string; result: Record<string, unknown>;
}
export interface DevelopmentOperationView {
  operation: OperationReference; cursor: string; snapshot: DevelopmentOperationSnapshot | null;
}
interface ContinueOptions {
  baseUrl: string; agentId: string; mutationId: string; signal?: AbortSignal;
  onView?(view: DevelopmentOperationView): void | Promise<void>;
  onRetry?(event: { phase: "submit" | "observe"; attempt: number; error: unknown }): void | Promise<void>;
  onRequestError?(event: { phase: "submit" | "observe"; attempt: number; retry: boolean; error: unknown }): void | Promise<void>;
}
class HttpFailure extends Error { constructor(readonly status: number) { super(`后台研发接口返回 HTTP ${status}`); } }

/** Live observers must leave recoverable rejections to the controller and its persisted counters. */
export function classifyDevelopmentToolError(error: unknown): "validation" | "limit" | "execution" {
  const reason = objectFields(objectFields(error).diagnostic).reason;
  if (["content_rejection_limit", "repeated_tool_error", "review_judgment_format", "read_input_correction_limit"].includes(String(reason))) return "limit";
  if (["context_source_failed", "read_recovery_persistence"].includes(String(reason))) return "execution";
  return error instanceof InputError ? "validation" : "execution";
}

/** Request retries locate the same accepted task; observing never resumes or cancels it. */
export async function continueDevelopmentOperation(options: ContinueOptions): Promise<DevelopmentOperationSnapshot> {
  const { agentId, mutationId, signal } = options;
  if (![agentId, mutationId].every(value => /^[\w-]{1,100}$/.test(value))) throw new Error("研发或请求编号无效。");
  const endpoint = new URL(`api/agents/${encodeURIComponent(agentId)}/operations`, options.baseUrl);
  const body = JSON.stringify({ kind: "development", mutationId, resume: true });
  const request = async (url: URL, phase: "submit" | "observe") => {
    for (let attempt = 1; ; attempt++) {
      signal?.throwIfAborted();
      try {
        const deadline = AbortSignal.timeout(15_000);
        const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
          ...(phase === "submit" ? { method: "POST", headers: { "content-type": "application/json" }, body } : {}) });
        if (!response.ok) { await response.body?.cancel(); throw new HttpFailure(response.status); }
        return await response.json() as unknown;
      } catch (error) {
        const transient = error instanceof TypeError || error instanceof Error && error.name === "TimeoutError"
          || error instanceof HttpFailure && [408, 429, 500, 502, 503, 504].includes(error.status);
        await options.onRequestError?.({ phase, attempt, retry: transient && !signal?.aborted, error });
        signal?.throwIfAborted();
        if (!transient) throw error;
        await options.onRetry?.({ phase, attempt, error });
        // Transport retries only locate this accepted operation; they consume no business retries.
        await pause(Math.min(500 * attempt, 5_000), undefined, { signal });
      }
    }
  };
  let generation: string | undefined, cursor: string | undefined;
  const check = (input: unknown): DevelopmentOperationView => {
    const value = objectFields(input), operation = objectFields(value.operation), snapshot = objectFields(value.snapshot);
    if (operation.version !== 1 || operation.domain !== "development" || operation.ownerId !== agentId || operation.operationId !== mutationId
      || typeof operation.generation !== "string" || !operation.generation || generation !== undefined && generation !== operation.generation
      || typeof value.cursor !== "string" || !value.cursor
      || (value.snapshot === null ? cursor === undefined || cursor !== value.cursor
        : typeof snapshot.running !== "boolean" || typeof snapshot.interrupted !== "boolean" || snapshot.error !== null && typeof snapshot.error !== "string"
          || !snapshot.result || typeof snapshot.result !== "object" || Array.isArray(snapshot.result)))
      throw new Error("后台研发任务回执或身份无效，不能重新启动任务。");
    generation = operation.generation;
    return value as unknown as DevelopmentOperationView;
  };
  let view = check(await request(endpoint, "submit"));
  for (;;) {
    signal?.throwIfAborted();
    await options.onView?.(view);
    if (view.snapshot && !view.snapshot.running) return view.snapshot;
    cursor = view.cursor;
    await pause(750, undefined, { signal });
    const query = new URL(`${endpoint.pathname}/${encodeURIComponent(mutationId)}`, endpoint);
    query.searchParams.set("after", cursor);
    view = check(await request(query, "observe"));
  }
}
