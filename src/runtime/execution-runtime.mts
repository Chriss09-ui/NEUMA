import type { ExecutionSession, ExecutionOptions, SessionEvent, SessionMessage } from "./execution-port.mjs";
import { createPiSession } from "./pi-runtime.mjs";
export { classifyModelFailure } from "./pi-runtime.mjs";

const HOST_EVENT_KEYS = ["message", "errorMessage", "finalError", "toolName", "toolCallId", "args", "isError", "success", "attempt", "maxAttempts", "delayMs", "willRetry", "result"] as const;

/** Streaming updates carry the whole growing reply. Copy the delta only, so each token does not retain another full copy. */
export function hostSessionEvent(event: { type: SessionEvent["type"] } & Record<string, unknown>): SessionEvent {
  const mapped = { type: event.type } as SessionEvent;
  if (event.type !== "message_update") {
    for (const key of HOST_EVENT_KEYS) if (key in event) Reflect.set(mapped, key, structuredClone(event[key]));
  }
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
    if (!update || typeof update !== "object") throw new TypeError("模型流事件缺少增量");
    const fields = update as { type?: unknown; delta?: unknown };
    mapped.assistantMessageEvent = { type: typeof fields.type === "string" ? fields.type : "", ...(typeof fields.delta === "string" ? { delta: fields.delta } : {}) };
  }
  return mapped;
}

/** Deliberately exposes no SDK manager/settings or mutable native event objects. */
export async function createExecutionSession(options: ExecutionOptions): Promise<ExecutionSession> {
  const native = await createPiSession(options);
  if (options.onModelCall && !native.modelCallAccounting) {
    native.dispose(); throw new Error("运行器缺少请求前持久记账能力");
  }
  return {
    capabilities: { version: 1, accounting: true, rawInputValidation: true, boundSessions: true },
    modelCallAccounting: native.modelCallAccounting,
    model: { contextWindow: native.model!.contextWindow },
    ...(native.sessionBindingHash ? { sessionBindingHash: native.sessionBindingHash } : {}),
    get sessionFile() { return native.sessionFile; },
    get modelRequestRejection() { return native.modelRequestRejection; },
    get messages() { return native.messages.map(message => structuredClone(message) as SessionMessage); },
    prompt: (text, promptOptions) => native.prompt(text, promptOptions),
    abort: () => native.abort(), dispose: () => native.dispose(),
    setAutoCompactionEnabled: enabled => native.setAutoCompactionEnabled(enabled),
    getLastAssistantText: () => native.getLastAssistantText(),
    subscribe: listener => native.subscribe(event => { listener(hostSessionEvent(event)); }),
  };
}
