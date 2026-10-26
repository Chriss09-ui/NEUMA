import { objectFields } from "../../src/runtime/type-boundary.mjs";
import type { BrowserRequest } from "../../public/ui-types.js";
import type { MainConversation } from "../../public/ui-api-types.js";

/** Existing UI scenarios supply synthetic replies; the fixture supplies transport receipts only. */
export function mainOperationFixture(request: BrowserRequest): BrowserRequest {
  const conversations = new Map<string, MainConversation>();
  interface Entry { reference: { version: number; domain: string; ownerId: string; operationId: string; generation: string };
    sequence: number; status: string; reply: string; context: unknown; conversation: MainConversation; sources: unknown[]; actions: unknown[]; error: string | null; reason?: unknown; waiters: Set<() => void> }
  const entries = new Map<string, Entry>();
  const response = (entry: Entry) => Response.json({ operation: entry.reference, cursor: String(entry.sequence), changed: true, reset: true,
    snapshot: { ...entry, waiters: undefined, status: entry.status } });
  const publish = (entry: Entry) => { entry.sequence++; for (const done of entry.waiters) done(); entry.waiters.clear(); };
  const event = (entry: Entry, input: unknown) => {
    const value = objectFields(input);
    if (value.type === "text-start") entry.reply = "";
    if (value.type === "text-delta") entry.reply += value.delta;
    if (value.type === "context") entry.context = value.context;
    if (value.type === "done") {
      const result = objectFields(value.result);
      entry.status = "complete"; entry.reply = String(result.reply ?? "");
      entry.conversation = result.conversation as MainConversation;
      entry.context = result.context ?? entry.conversation?.context ?? null;
      entry.sources = Array.isArray(result.sources) ? result.sources : []; entry.actions = Array.isArray(result.actions) ? result.actions : [];
    }
    if (value.type === "error") { const reason = value.reason ?? objectFields(value.diagnostic).reason;
      entry.status = reason === "cancelled" ? "cancelled" : "failed"; entry.error = String(value.error ?? "回复未完成"); entry.reason = reason; }
    publish(entry);
  };
  async function consume(entry: Entry, pending: Promise<Response>) {
    try {
      const value = await pending;
      if (value.headers.get("content-type")?.includes("ndjson")) {
        const reader = value.body!.getReader(); let text = "";
        for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value);
          let end; while ((end = text.indexOf("\n")) >= 0) { const line = text.slice(0, end); text = text.slice(end + 1); if (line.trim()) event(entry, JSON.parse(line)); } }
        if (text.trim()) event(entry, JSON.parse(text));
        if (entry.status === "running") event(entry, { type: "error", error: "回复中断" });
      } else { const result = await value.json(); event(entry, value.ok ? { type: "done", result } : { type: "error", ...result }); }
    } catch (error) { event(entry, { type: "error", error: error instanceof Error ? error.message : "请求失败" }); }
  }
  return async (path, options = {}) => {
    const match = path.match(/^\/api\/main\/conversations\/([\w-]+)\/operations(?:\/([\w-]+)(?:\/(cancel))?)?(?:\?after=(.*))?$/);
    if (!match) {
      const result = await request(path, options);
      if (result.ok && result.headers.get("content-type")?.includes("json")) {
        const body = objectFields(await result.clone().json());
        if (typeof objectFields(body.conversation).id === "string") conversations.set(objectFields(body.conversation).id as string, body.conversation as MainConversation);
      }
      return result;
    }
    const [, id, operationId, action, after] = match;
    if (!operationId) {
      const input = JSON.parse(String(options.body)), key = String(input.mutationId);
      const initial = await request(path, options);
      const pending = Promise.resolve(initial);
      const entry: Entry = { reference: { version: 1, domain: "main", ownerId: id!, operationId: key, generation: `assistant-${key}` }, sequence: 0,
        conversation: conversations.get(id!) ?? { id: id!, title: "新对话", version: 1, messages: [] },
        status: "running", reply: "", context: conversations.get(id!)?.context ?? null, sources: [], actions: [], error: null, waiters: new Set() };
      entries.set(key, entry); void consume(entry, pending); return response(entry);
    }
    const entry = entries.get(operationId); if (!entry) return Response.json({ error: "Missing operation" }, { status: 404 });
    if (action === "cancel") {
      await request(path, options); entry.status = "cancelled"; entry.reason = "cancelled"; entry.error = "本轮已停止"; publish(entry); return response(entry);
    }
    if (entry.status === "running" && (entry.sequence === 0 || after === String(entry.sequence))) await new Promise<void>((resolve, reject) => {
      const done = () => { options.signal?.removeEventListener("abort", abort); entry.waiters.delete(done); resolve(); };
      const abort = () => { options.signal?.removeEventListener("abort", abort); entry.waiters.delete(done); reject(options.signal?.reason); };
      entry.waiters.add(done); options.signal?.addEventListener("abort", abort, { once: true }); if (options.signal?.aborted) abort();
    });
    return response(entry);
  };
}
