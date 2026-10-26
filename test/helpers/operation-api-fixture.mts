import type { OperationReference } from "../../public/operation-view.js";
import type { RuntimeResult } from "../../public/ui-types.js";

/** Adapts existing synthetic build responses to the accepted-operation HTTP contract. */
export function operationApiFixture(start: (kind: string, id: string, body: Record<string, unknown>, signal: AbortSignal) => Response | Promise<Response>,
  cancel: (kind: string, id: string) => Response | Promise<Response>) {
  interface Entry { reference: OperationReference; controller: AbortController; revision: number; running: boolean; error: string | null;
    result: RuntimeResult; phase?: unknown; label?: unknown; waiters: Set<() => void> }
  const entries = new Map<string, Entry>();
  function update(entry: Entry, event: Record<string, unknown>) {
    if (!entry.running) return;
    if (event.type === "done") { entry.result = event.result as RuntimeResult; entry.running = false; }
    else if (event.type === "error") { entry.error = String(event.error ?? "synthetic failure"); entry.running = false; }
    else { entry.phase = event.phase; entry.label = event.label;
      if (event.architecture) entry.result.architecture = event.architecture as RuntimeResult["architecture"];
      if (event.development) entry.result.development = event.development as RuntimeResult["development"]; }
    entry.revision++; for (const waiter of entry.waiters) waiter(); entry.waiters.clear();
  }
  async function consume(entry: Entry, pending: Response | Promise<Response>) {
    try {
      const response = await pending;
      if (response.headers.get("content-type")?.includes("ndjson")) {
        const reader = response.body!.getReader(); let text = "";
        for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value);
          let newline; while ((newline = text.indexOf("\n")) >= 0) { const line = text.slice(0, newline); text = text.slice(newline + 1); if (line.trim()) update(entry, JSON.parse(line)); } }
        if (text.trim()) update(entry, JSON.parse(text));
        if (entry.running) update(entry, { type: "error", error: "模型响应中断，已保存进度保留" });
      } else {
        const result = await response.json(); update(entry, response.ok ? { type: "done", result } : { type: "error", ...result });
      }
    } catch (error) { update(entry, { type: "error", error: error instanceof Error ? error.message : "synthetic failure" }); }
  }
  const view = (entry: Entry) => ({ operation: entry.reference, cursor: String(entry.revision), changed: true, reset: true,
    snapshot: { running: entry.running, interrupted: false, error: entry.error, phase: entry.phase, label: entry.label, result: entry.result } });
  return async (path: string, body: Record<string, unknown> | undefined, signal?: AbortSignal | null) => {
    const match = path.match(/^\/api\/agents\/([\w-]+)\/operations(?:\/([\w-]+)(?:\/(cancel))?)?(?:\?after=(.*))?$/);
    if (!match) return undefined;
    const [, id, operationId, action, after] = match;
    if (!operationId) {
      const key = String(body!.mutationId), entry: Entry = { reference: { version: 1, domain: String(body!.kind), ownerId: id!, operationId: key, generation: `generation-${key}` },
        controller: new AbortController(), revision: 0, running: true, error: null, result: {}, waiters: new Set() };
      entries.set(key, entry);
      void consume(entry, Promise.resolve().then(() => start(String(body!.kind), id!, body!, entry.controller.signal)));
      return Response.json(view(entry));
    }
    const entry = entries.get(operationId); if (!entry) return Response.json({ error: "Missing operation" }, { status: 404 });
    if (action === "cancel") {
      entry.controller.abort(); const response = await cancel(entry.reference.domain, id!);
      const result = await response.json(); update(entry, { type: "done", result }); return Response.json(view(entry));
    }
    if (entry.running && (entry.revision === 0 || after === String(entry.revision))) {
      await new Promise<void>((resolve, reject) => {
        const done = () => { signal?.removeEventListener("abort", abort); entry.waiters.delete(done); resolve(); };
        const abort = () => { signal?.removeEventListener("abort", abort); entry.waiters.delete(done); reject(signal?.reason); };
        entry.waiters.add(done); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
      });
    }
    return Response.json(view(entry));
  };
}
