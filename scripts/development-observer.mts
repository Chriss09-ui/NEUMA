import type { SessionFactory, SessionMessage } from "../src/runtime/execution-port.mjs";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import { classifyDevelopmentToolError } from "./development-operation.mjs";

/** Error properties are non-enumerable: JSON.stringify(error) loses the transport cause. */
export function developmentDiagnostic(input: unknown, secrets: readonly string[] = []): unknown {
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") {
      let text = value;
      for (const secret of secrets) if (secret) text = text.replaceAll(secret, "[已隐藏]");
      return text
        .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[已隐藏私钥]")
        .replace(/Bearer\s+[^\s,;"'<>]+/gi, "Bearer [已隐藏]")
        .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[已隐藏]@")
        .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[已隐藏]")
        .replace(/((?:api[_-]?key|token|password|secret|authorization)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^,;&}\s]+)/gi, "$1[已隐藏]");
    }
    if (!value || typeof value !== "object") return value;
    if (depth > 12 || seen.has(value)) return "[嵌套或循环引用]";
    seen.add(value);
    let result: unknown;
    if (Array.isArray(value)) result = value.map(item => visit(item, depth + 1));
    else {
      const fields = value instanceof Error
        ? Object.fromEntries(["name", "message", "stack", "code", "status", "diagnostic", "validationIssue", "validationIssues", "cause", "errors"]
          .filter(key => key in value).map(key => [key, Reflect.get(value, key)])) : objectFields(value);
      result = Object.fromEntries(Object.entries(fields).filter(([key]) => !/^(thinking|reasoning_content)$/i.test(key))
        .map(([key, item]) => [key, /^(authorization|apiKey|jevApiKey|accessToken|refreshToken|secret|password)$/i.test(key)
          ? "[已隐藏]" : visit(item, depth + 1)]));
    }
    seen.delete(value);
    return result;
  };
  return visit(input, 0);
}

interface ObserverOptions {
  factory: SessionFactory;
  log(type: string, details: Record<string, unknown>): void;
  fail(kind: string, details: Record<string, unknown>): void;
  beforeRequest(): void;
  checkContent(details?: Record<string, unknown>): void;
}

/** Observe the execution port without cancelling parents on preliminary SDK error events. */
export function observeDevelopmentSessions(observer: ObserverOptions): SessionFactory {
  let sequence = 0;
  return async options => {
    observer.beforeRequest();
    const node = { session: ++sequence, binding: options.sessionStorage?.binding };
    const log = (type: string, details: Record<string, unknown> = {}) => observer.log(type, { node, ...details });
    const fail = (kind: string, details: Record<string, unknown>) => observer.fail(kind, { node, ...details });
    const session = await observer.factory({ ...options,
      ...(options.customTools ? { customTools: options.customTools.map(tool => ({ ...tool, async execute(...args) {
        try {
          const result = await tool.execute(...args);
          const details = { tool: tool.name, toolCallId: args[0], result };
          log("tool_result", details); observer.checkContent({ node, ...details }); return result;
        }
        catch (error) {
          const category = classifyDevelopmentToolError(error);
          const details = { tool: tool.name, toolCallId: args[0], category, error };
          log("tool_error", details); observer.checkContent({ node, ...details });
          if (category !== "validation") fail(category === "limit" ? "correction_or_content_limit" : "tool_execution_failed", { tool: tool.name, error });
          throw error;
        } finally { observer.checkContent(); }
      } })) } : {}),
      onToolDiagnostic: async event => { log("tool_diagnostic", event); await options.onToolDiagnostic?.(event); },
      onModelCall: async event => {
        observer.checkContent(); observer.beforeRequest();
        await options.onModelCall?.(event); log("model_call", { purpose: event?.purpose, retryAttempt: event?.retryAttempt });
      },
      beforeModelRequest: async event => {
        observer.checkContent(); observer.beforeRequest();
        await options.beforeModelRequest?.(event); log("model_request");
      },
    });
    log("session_opened", { file: session.sessionFile, bindingHash: session.sessionBindingHash });
    let lastFailure: SessionMessage | undefined;
    const outcome = (): SessionMessage | undefined => lastFailure;
    const unsubscribe = session.subscribe?.(event => {
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const message = event.message;
        lastFailure = ["error", "length", "aborted"].includes(message.stopReason ?? "") ? message : undefined;
        // An aborted message can precede the actual provider exception. It is evidence, not the cause.
        log("assistant_end", { stopReason: message.stopReason, errorMessage: message.errorMessage, usage: message.usage });
      }
      if (event.type === "auto_retry_start" || event.type === "auto_retry_end") log(event.type, { ...event });
    });
    const prompt = session.prompt.bind(session), dispose = session.dispose.bind(session);
    session.prompt = async (...args) => {
      lastFailure = undefined;
      try {
        const result = await prompt(...args);
        const failed = outcome();
        if (failed && failed.stopReason !== "aborted")
          fail("model_response_failed", { stopReason: failed.stopReason, message: failed.errorMessage });
        return result;
      } catch (error) {
        // Always retain the root exception, including after a sibling or the observer has stopped.
        log("prompt_error", { error }); fail("model_request_failed", { error }); throw error;
      }
    };
    session.dispose = async () => { unsubscribe?.(); await dispose(); };
    return session;
  };
}
