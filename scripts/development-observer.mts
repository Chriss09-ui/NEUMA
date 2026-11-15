import type { SessionFactory, SessionMessage } from "../src/runtime/execution-port.mjs";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import { classifyDevelopmentToolError } from "./development-operation.mjs";

const REGEX_TEXT_LIMIT = 8192;
export const DEVELOPMENT_EVENT_TEXT_LIMIT = 4096;
interface DiagnosticOptions { maxText?: number }

function hideSecrets(text: string, secrets: readonly string[]) {
  let next = text;
  for (const secret of secrets) if (secret) next = next.split(secret).join("[已隐藏]");
  return next;
}

function boundText(text: string, maxText: number | undefined) {
  return maxText !== undefined && text.length > maxText ? `${text.slice(0, maxText)}…[已截断，原长 ${text.length}]` : text;
}

/** Advance through long text without compiling a global expression against it. */
function replaceSpans(text: string, find: (value: string, from: number) => { start: number; end: number; replacement: string } | undefined) {
  let result = "", index = 0;
  while (index < text.length) {
    const match = find(text, index);
    if (!match || match.end <= index || match.end <= match.start) return result + text.slice(index);
    result += text.slice(index, match.start) + match.replacement;
    index = match.end;
  }
  return result;
}

function findPrivateKey(text: string, from: number) {
  const begin = text.indexOf("-----BEGIN ", from);
  if (begin < 0) return undefined;
  const header = text.indexOf("-----", begin + 11);
  if (header < 0 || !text.slice(begin + 11, header).toUpperCase().includes("PRIVATE KEY"))
    return { start: begin, end: begin + 11, replacement: "-----BEGIN " };
  const endLabel = text.indexOf("-----END ", header);
  const close = endLabel < 0 ? -1 : text.indexOf("-----", endLabel + 9);
  return { start: begin, end: close < 0 ? text.length : close + 5, replacement: "[已隐藏私钥]" };
}

function findBearer(text: string, from: number) {
  const at = text.toLowerCase().indexOf("bearer", from);
  if (at < 0) return undefined;
  let cursor = at + 6;
  if (cursor >= text.length || !/\s/.test(text[cursor]!)) return { start: at, end: cursor, replacement: text.slice(at, cursor) };
  while (cursor < text.length && /\s/.test(text[cursor]!)) cursor++;
  const value = cursor;
  while (cursor < text.length && !" ,;\"'<>".includes(text[cursor]!)) cursor++;
  if (cursor === value) return { start: at, end: at + 6, replacement: text.slice(at, at + 6) };
  return { start: at, end: cursor, replacement: "Bearer [已隐藏]" };
}

function findUrlSecret(text: string, from: number) {
  const marker = text.indexOf("://", from);
  if (marker < 0) return undefined;
  let start = marker;
  while (start > from && /[a-z0-9+.-]/i.test(text[start - 1]!)) start--;
  if (start === marker || !/[a-z]/i.test(text[start]!)) return { start: marker, end: marker + 3, replacement: "://" };
  let end = marker + 3;
  const user = end;
  while (end < text.length && !/[\s/@]/.test(text[end]!)) end++;
  if (end === user || text[end] !== "@") return { start: marker, end: marker + 3, replacement: "://" };
  return { start: user, end, replacement: "[已隐藏]" };
}

function findSk(text: string, from: number) {
  const at = text.indexOf("sk-", from);
  if (at < 0) return undefined;
  if (at > 0 && /[A-Za-z0-9_]/.test(text[at - 1]!)) return { start: at, end: at + 3, replacement: "sk-" };
  let end = at + 3;
  while (end < text.length && /[A-Za-z0-9_-]/.test(text[end]!)) end++;
  if (end - at - 3 < 8) return { start: at, end: at + 3, replacement: "sk-" };
  return { start: at, end, replacement: "[已隐藏]" };
}

function findAssignment(text: string, from: number) {
  const lower = text.toLowerCase();
  let best = -1, keyLength = 0;
  for (const key of ["authorization", "api_key", "api-key", "apikey", "password", "secret", "token"]) {
    const at = lower.indexOf(key, from);
    if (at >= 0 && (best < 0 || at < best)) { best = at; keyLength = key.length; }
  }
  if (best < 0) return undefined;
  let cursor = best + keyLength;
  if (text[cursor] === "'" || text[cursor] === '"') cursor++;
  while (cursor < text.length && /\s/.test(text[cursor]!)) cursor++;
  if (text[cursor] !== ":" && text[cursor] !== "=") return { start: best, end: best + keyLength, replacement: text.slice(best, best + keyLength) };
  cursor++;
  while (cursor < text.length && /\s/.test(text[cursor]!)) cursor++;
  const value = cursor;
  const quote = text[cursor];
  if (quote === '"' || quote === "'") {
    cursor++;
    while (cursor < text.length && text[cursor] !== quote && text[cursor] !== "\n" && text[cursor] !== "\r") cursor++;
    if (text[cursor] === quote) cursor++;
  } else while (cursor < text.length && !" ,;&}".includes(text[cursor]!) && !/\s/.test(text[cursor]!)) cursor++;
  if (cursor === value) return { start: best, end: best + keyLength, replacement: text.slice(best, best + keyLength) };
  return { start: value, end: cursor, replacement: "[已隐藏]" };
}

function redactLongText(text: string, secrets: readonly string[]) {
  let next = hideSecrets(text, secrets);
  for (const find of [findPrivateKey, findBearer, findUrlSecret, findSk, findAssignment]) next = replaceSpans(next, find);
  return next;
}

function redactText(text: string, secrets: readonly string[], maxText: number | undefined) {
  const hidden = hideSecrets(text, secrets);
  const redacted = hidden.length > REGEX_TEXT_LIMIT ? redactLongText(hidden, []) : hidden
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[已隐藏私钥]")
    .replace(/Bearer\s+[^\s,;"'<>]+/gi, "Bearer [已隐藏]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[已隐藏]@")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[已隐藏]")
    .replace(/((?:api[_-]?key|token|password|secret|authorization)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^,;&}\s]+)/gi, "$1[已隐藏]");
  return boundText(redacted, maxText);
}

/** Error properties are non-enumerable: JSON.stringify(error) loses the transport cause. */
export function developmentDiagnostic(input: unknown, secrets: readonly string[] = [], options: DiagnosticOptions = {}): unknown {
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") return redactText(value, secrets, options.maxText);
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

/** Session events stay bounded so a long tool result is not copied through a global expression. */
export function developmentEventDiagnostic(input: unknown, secrets: readonly string[] = []) {
  return developmentDiagnostic(input, secrets, { maxText: DEVELOPMENT_EVENT_TEXT_LIMIT });
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
    const log = (type: string, details: Record<string, unknown> = {}) => {
      try { observer.log(type, { node, ...details }); } catch { /* 观察记录失败不能改变工具或模型结果。 */ }
    };
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
