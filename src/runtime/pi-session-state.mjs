import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { InputError } from "../requirements/core.mjs";
import { toolInputValidation } from "./tool-input-diagnostics.mjs";

const BINDING_ENTRY = "neuma.session-binding.v1";
const MAX_RAW_ARGUMENT_BYTES = 1024 * 1024;
const STOP_REASONS = new Set(["stop", "length", "tool_calls", "function_call", "content_filter", "network_error"]);
export const PI_READ_ONLY_SESSION_MAX_BYTES = 16 * 1024 * 1024;
const valueType = (value) => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

function canonicalBinding(value, depth = 0) {
  if (depth > 8) throw new InputError("会话绑定无效");
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalBinding(item, depth + 1)).join(",")}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new InputError("会话绑定无效");
      return `${JSON.stringify(key)}:${canonicalBinding(descriptor.value, depth + 1)}`;
    }).join(",")}}`;
  }
  throw new InputError("会话绑定无效");
}

function readOnlyFailure(reason) {
  return Object.assign(new InputError("绑定的历史会话不可用于只读参考"), { reason });
}

/** Read one already-bound native session without restoring, migrating or writing it. */
export async function readPiBoundSession(sdk, { cwd, storage, signal, expectedSessionHash } = {}) {
  const reject = (reason) => { throw readOnlyFailure(reason); };
  signal?.throwIfAborted();
  if (typeof cwd !== "string" || !isAbsolute(cwd) || typeof storage?.directory !== "string" || !isAbsolute(storage.directory)
    || typeof storage.file !== "string" || !/^[A-Za-z0-9_.-]+\.jsonl$/.test(storage.file) || storage.file !== basename(storage.file)
    || !storage.binding || valueType(storage.binding) !== "object") reject("session_reference_invalid");
  if (expectedSessionHash !== undefined && !/^[a-f0-9]{64}$/.test(expectedSessionHash)) reject("session_reference_invalid");
  const canonical = canonicalBinding(storage.binding);
  if (Buffer.byteLength(canonical) > 8192) reject("session_reference_invalid");
  const bindingHash = createHash("sha256").update(canonical).digest("hex");
  const directoryStat = await lstat(storage.directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) reject("session_directory_invalid");
  const directory = await realpath(storage.directory), file = resolve(directory, storage.file);
  if (dirname(file) !== directory) reject("session_reference_invalid");
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size === 0) reject("session_file_invalid");
  if (before.size > PI_READ_ONLY_SESSION_MAX_BYTES) reject("session_size_limit");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes;
  const same = (left, right) => ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every((key) => left[key] === right[key]);
  try {
    const opened = await handle.stat();
    if (!same(before, opened) || opened.nlink !== 1) reject("session_changed");
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      signal?.throwIfAborted();
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    if (offset !== before.size || !same(opened, await handle.stat()) || !same(before, await lstat(file))) reject("session_changed");
    bytes = buffer.subarray(0, offset);
  } finally { await handle.close(); }
  signal?.throwIfAborted();
  const sessionHash = createHash("sha256").update(bytes).digest("hex");
  if (expectedSessionHash !== undefined && expectedSessionHash !== sessionHash) reject("session_changed");
  const content = bytes.toString("utf8");
  if (!Buffer.from(content).equals(bytes)) reject("session_file_invalid");
  const entries = sdk.parseSessionEntries(content);
  // The native parser skips malformed lines; a skipped entry cannot establish provenance.
  if (!Array.isArray(entries) || !entries.length || entries.length > 100_000
    || entries.length !== content.split("\n").filter((line) => line.trim()).length) reject("session_file_invalid");
  const header = entries[0];
  if (header?.type !== "session" || header.version !== sdk.CURRENT_SESSION_VERSION || typeof header.cwd !== "string"
    || resolve(header.cwd) !== resolve(cwd) || entries.filter((entry) => entry.type === "session").length !== 1) reject("session_header_invalid");
  const ids = new Set();
  for (const entry of entries.slice(1)) {
    signal?.throwIfAborted();
    if (typeof entry?.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(entry.id) || ids.has(entry.id)
      || entry.parentId !== null && !ids.has(entry.parentId)) reject("session_tree_invalid");
    ids.add(entry.id);
  }
  const bindings = entries.filter((entry) => entry.type === "custom" && entry.customType === BINDING_ENTRY);
  if (bindings.length !== 1 || bindings[0].data?.version !== 1 || bindings[0].data?.bindingHash !== bindingHash) reject("session_binding_mismatch");
  const manager = sdk.SessionManager.inMemory(cwd, undefined, entries);
  if (!manager.getBranch().some((entry) => entry.id === bindings[0].id)) reject("session_binding_mismatch");
  return { manager, bindingHash, sessionHash, leafId: manager.getLeafId() };
}

export async function piSessionManager(sdk, { cwd, storage }) {
  if (!storage) return { manager: sdk.SessionManager.inMemory(cwd) };
  if (typeof storage.directory !== "string" || !isAbsolute(storage.directory)
    || !storage.binding || valueType(storage.binding) !== "object") throw new InputError("会话保存配置无效");
  const canonical = canonicalBinding(storage.binding);
  if (Buffer.byteLength(canonical) > 8192) throw new InputError("会话绑定过长");
  const bindingHash = createHash("sha256").update(canonical).digest("hex");
  await mkdir(storage.directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(storage.directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new InputError("会话保存目录无效");
  await chmod(storage.directory, 0o700);
  const directory = await realpath(storage.directory);
  let manager;
  if (storage.file !== undefined) {
    if (typeof storage.file !== "string" || !storage.file || !/^[A-Za-z0-9_.-]+\.jsonl$/.test(basename(storage.file)))
      throw new InputError("会话记录引用无效");
    const file = resolve(directory, storage.file);
    if (dirname(file) !== directory) throw new InputError("会话记录超出允许目录");
    let stat;
    try { stat = await lstat(file); } catch { throw new InputError("会话记录不存在，不能建立替代会话"); }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size === 0) throw new InputError("会话记录无效");
    // Pi can initialize an empty file or migrate a foreign record while opening it. Check the
    // current NEUMA-owned header first, so a rejected restore does not modify that file.
    const handle = await open(file, "r");
    let header;
    try {
      const buffer = Buffer.alloc(64 * 1024), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
      header = JSON.parse(firstLine);
    } catch { throw new InputError("会话记录无效"); }
    finally { await handle.close(); }
    if (header?.type !== "session" || header.version !== sdk.CURRENT_SESSION_VERSION || typeof header.cwd !== "string"
      || resolve(header.cwd) !== resolve(cwd)) throw new InputError("会话绑定不匹配，不能恢复其他任务的历史");
    try { manager = sdk.SessionManager.open(file, directory); }
    catch { throw new InputError("会话记录无效，不能恢复"); }
    const entries = manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === BINDING_ENTRY);
    if (entries.length !== 1 || entries[0].data?.version !== 1 || entries[0].data?.bindingHash !== bindingHash
      || resolve(manager.getCwd()) !== resolve(cwd)) throw new InputError("会话绑定不匹配，不能恢复其他任务的历史");
    await chmod(file, 0o600);
  } else {
    manager = sdk.SessionManager.create(cwd, directory);
    // The SDK intentionally defers setup-only records until a user message. Reserve its new
    // filename privately, then let the native empty-file initializer persist the header now.
    // A controller can therefore save this reference before its first prompt or cancellation.
    const handle = await open(manager.getSessionFile(), "wx", 0o600);
    await handle.close();
    manager = sdk.SessionManager.open(manager.getSessionFile(), directory, cwd);
    manager.appendCustomEntry(BINDING_ENTRY, { version: 1, bindingHash });
  }
  return { manager, bindingHash, directory };
}

function argumentShape(value, schema) {
  const fields = [];
  for (const key of Object.keys(schema?.properties ?? {}).slice(0, 48)) {
    const descriptor = value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, key) : undefined;
    if (!descriptor) continue;
    const item = descriptor.value;
    fields.push({ field: key, type: descriptor.get || descriptor.set ? "accessor" : valueType(item),
      ...(typeof item === "string" ? { bytes: Buffer.byteLength(item) } : Array.isArray(item) ? { length: item.length } : {}) });
  }
  return { type: valueType(value), fields };
}

// Raw argument strings live only until normalization finishes. Diagnostics contain schema names,
// types and bounded sizes, never submitted strings, unknown property names or provider payloads.
export function piSessionPolicy({ customTools, onToolDiagnostic, toolErrorResult, rawInputValidators, transformContext, halt }) {
  const tools = new Map(customTools.map((tool) => [tool.name, tool]));
  const rawValidators = new Map(Object.entries(rawInputValidators ?? {}));
  if ([...rawValidators].some(([name, validate]) => !tools.has(name) || typeof validate !== "function"))
    throw new InputError("原始工具参数校验配置无效");
  const rawDecisions = new WeakMap();
  const unavailable = { valid: false, reason: "无法唯一核对本轮原始工具参数，本次未执行。请按公开结构重新提交。" };
  let rawCalls = new Map(), rawStopReason = null, usage = null, retainedRawBytes = 0;
  const startRequest = () => { rawCalls = new Map(); rawStopReason = null; usage = null; retainedRawBytes = 0; };
  const safeCall = async (fn, ...args) => {
    try { return await fn?.(...args); }
    catch (error) { halt(error); return undefined; }
  };
  const checkRaw = async (call) => {
    const outcome = await safeCall(rawValidators.get(call.name), { toolName: call.name, toolCallId: call.id, args: call.arguments });
    if (outcome?.valid === true) return { valid: true };
    return { valid: false, reason: typeof outcome?.reason === "string" && outcome.reason.length <= 16000 ? outcome.reason : unavailable.reason };
  };
  const factory = (pi) => {
    if (transformContext) pi.on("context", async (event) => {
      const messages = await safeCall(transformContext, event.messages);
      if (messages !== undefined && !Array.isArray(messages)) { halt(new InputError("模型上下文投影必须返回消息数组")); return; }
      return messages === undefined ? undefined : { messages };
    });
    if (rawValidators.size) pi.on("tool_call", async (event, context) => {
      if (!rawValidators.has(event.toolName)) return;
      if (event.parentToolCallId || typeof event.toolCallId !== "string" || event.toolCallId.length > 512)
        return { block: true, reason: unavailable.reason };
      let assistant;
      try { assistant = context.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant")?.message; }
      catch { return { block: true, reason: unavailable.reason }; }
      const calls = assistant?.content?.filter((entry) => entry.type === "toolCall" && entry.id === event.toolCallId) ?? [];
      if (calls.length !== 1 || calls[0].name !== event.toolName) return { block: true, reason: unavailable.reason };
      let decisions = rawDecisions.get(assistant);
      if (!decisions) { decisions = new Map(); rawDecisions.set(assistant, decisions); }
      // Restored sessions have no in-memory decisions; the current persisted assistant call is authoritative.
      const outcome = decisions.get(event.toolCallId) ?? await checkRaw(calls[0]);
      decisions.set(event.toolCallId, outcome);
      if (!outcome.valid) return { block: true, reason: outcome.reason };
    });
    pi.on("provider_stream_event", (event) => {
      if (!onToolDiagnostic) return;
      const choice = event.data?.choices?.[0];
      if (typeof choice?.finish_reason === "string") rawStopReason = STOP_REASONS.has(choice.finish_reason) ? choice.finish_reason : "other";
      if (event.data?.usage) {
        usage = {};
        for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
          const value = event.data.usage[key];
          if (Number.isSafeInteger(value) && value >= 0) usage[key] = value;
        }
      }
      for (const call of choice?.delta?.tool_calls ?? []) {
        if (!Number.isInteger(call?.index) || call.index < 0 || call.index > 255) continue;
        const saved = rawCalls.get(call.index) ?? { index: call.index, bytes: 0, text: "", complete: true };
        if (typeof call.id === "string" && call.id.length <= 512) saved.id = call.id;
        if (typeof call.function?.arguments === "string") {
          const bytes = Buffer.byteLength(call.function.arguments);
          saved.bytes += bytes;
          if (saved.complete && retainedRawBytes + bytes <= MAX_RAW_ARGUMENT_BYTES) {
            saved.text += call.function.arguments; retainedRawBytes += bytes;
          } else {
            retainedRawBytes -= Buffer.byteLength(saved.text);
            saved.complete = false; saved.text = "";
          }
        }
        rawCalls.set(call.index, saved);
      }
    });
    pi.on("message_end", async (event, context) => {
      const message = event.message;
      if (message.role === "assistant" && rawValidators.size) {
        const calls = message.content?.filter((entry) => entry.type === "toolCall") ?? [], decisions = new Map();
        rawDecisions.set(message, decisions);
        for (const call of calls) if (rawValidators.has(call.name) && typeof call.id === "string" && call.id.length <= 512) {
          const unique = calls.filter((entry) => entry.id === call.id).length === 1;
          decisions.set(call.id, unique ? await checkRaw(call) : unavailable);
        }
      }
      if (message.role === "assistant" && onToolDiagnostic) {
        for (const call of message.content ?? []) {
          if (call.type !== "toolCall" || !tools.has(call.name)) continue;
          const raw = [...rawCalls.values()].find((item) => item.id === call.id);
          let parsed, valid = false;
          if (raw?.complete) {
            try { parsed = JSON.parse(raw.text); valid = true; } catch { /* Type metadata records malformed JSON without its contents. */ }
          }
          await safeCall(onToolDiagnostic, { stage: "arguments", toolName: call.name,
            raw: { available: Boolean(raw), complete: raw?.complete ?? false, bytes: raw?.bytes ?? 0, validJson: valid,
              ...(valid ? { shape: argumentShape(parsed, tools.get(call.name).parameters) } : {}) },
            parsed: argumentShape(call.arguments, tools.get(call.name).parameters),
            stopReason: ["stop", "length", "toolUse", "error", "aborted"].includes(message.stopReason) ? message.stopReason : "other",
            rawStopReason, ...(usage && Object.keys(usage).length ? { usage } : {}) });
        }
        rawCalls.clear();
        retainedRawBytes = 0;
      }
      if (message.role !== "toolResult" || !message.isError) return;
      const text = message.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") ?? "";
      if (!text.startsWith("Validation failed for tool ")) return;
      const assistant = context.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant")?.message;
      const call = assistant?.content?.find((item) => item.type === "toolCall" && item.id === message.toolCallId);
      const result = tools.has(message.toolName) ? await safeCall(toolErrorResult,
        { toolName: message.toolName, toolCallId: message.toolCallId, args: call?.arguments }) : undefined;
      const feedback = !result?.content && tools.has(message.toolName) && call?.name === message.toolName
        ? toolInputValidation(call.arguments, tools.get(message.toolName).parameters, { root: message.toolName }) : undefined;
      return { message: { ...message, content: result?.content ?? [{ type: "text", text: JSON.stringify({ executed: false, reason: "sdk_validation",
        ...(feedback && !feedback.valid ? feedback : {}), nextAction: "工具参数未通过结构校验，本次未执行。按具体字段修正；未修改参数的重试不能解决此错误。" }) }],
        details: result?.details ?? { reason: "sdk_validation" }, structuredContent: undefined } };
    });
  };
  return { factory, startRequest };
}
