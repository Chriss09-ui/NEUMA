import type { ExecutionSession, ExecutionOptions, SessionEvent, SessionMessage } from "./execution-port.mjs";
import { createPiSession } from "./pi-runtime.mjs";
export { classifyModelFailure } from "./pi-runtime.mjs";

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
    subscribe: listener => native.subscribe(event => {
      const mapped: SessionEvent = { type: event.type };
      // Copy only host contract fields, including unknown usage as absent rather than zero.
      for (const key of ["message", "errorMessage", "finalError", "toolName", "toolCallId", "args", "isError", "success", "attempt", "maxAttempts", "delayMs", "willRetry", "result"] as const)
        if (key in event) Reflect.set(mapped, key, structuredClone(Reflect.get(event, key)));
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        mapped.assistantMessageEvent = { type: update.type, ...("delta" in update && typeof update.delta === "string" ? { delta: update.delta } : {}) };
      }
      listener(mapped);
    }),
  };
}
