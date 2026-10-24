import type { UnknownRecord } from "./contracts/json.mjs";
import type { ModelConfig } from "./contracts/model.mjs";
import type { PiSessionPort, SessionFactory, NeumaTool } from "./runtime/pi-port.mjs";
import type { FetchPort } from "./runtime/model-idle-timeout.mjs";
import { objectFields, isArray, errorField } from "./runtime/type-boundary.mjs";
import { InputError, ProviderError } from "./requirements/core.mjs";
import { getProviderConfig } from "./requirements/providers.mjs";
import { configEnv, settingsUpdates } from "./settings.mjs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiSession, classifyModelFailure } from "./runtime/pi-runtime.mjs";
import { withModelIdleTimeout } from "./runtime/model-idle-timeout.mjs";
interface ProbeOptions { fetchImpl?: FetchPort; signal?: AbortSignal | undefined; timeoutMs?: number }
interface ProbeRequest { url: string; model: string; apiKey: string; request: unknown; stage: string; validReply(payload: unknown): boolean; missingMessage: string }

const OVERRIDE_FIELDS = new Set<PropertyKey>(["chatUrl", "model", "apiKey"]);
const JEV_OVERRIDE_FIELDS = new Set<PropertyKey>(["jevModel", "jevApiKey", "clear"]);
const MAX_RESPONSE_BYTES = 64 * 1_024;
class ProbeError extends ProviderError {}

function probeError(message: string, reason: string, details: UnknownRecord = {}, stage = "llm") {
  return new ProbeError(message, { stage, reason, ...details });
}

function probeConfig(config: ModelConfig, body: unknown) {
  if (!body || typeof body !== "object" || isArray(body)) {
    throw new InputError("模型测试配置需要是一个对象");
  }
  const input = objectFields(body);
  if (Reflect.ownKeys(body).some((field) => !OVERRIDE_FIELDS.has(field))) {
    throw new InputError("模型测试只接受接口地址、模型名和 API Key");
  }
  const overrides: UnknownRecord = {};
  for (const field of OVERRIDE_FIELDS as Set<string>) {
    if (!Object.hasOwn(input, field)) continue;
    if (typeof input[field] !== "string") throw new InputError("配置项必须是文字");
    if (field === "apiKey" && !input[field].trim()) continue;
    overrides[field] = input[field];
  }
  const updates = Object.keys(overrides).length ? settingsUpdates(overrides) : {};
  const effective = getProviderConfig({ ...configEnv(config), ...updates });
  if (!effective.llmConfigured) {
    throw new InputError("请先填写接口地址、模型名和 API Key；已保存的 API Key 可以留空沿用");
  }
  settingsUpdates({ chatUrl: effective.chatUrl, model: effective.model, apiKey: effective.apiKey });
  return effective;
}

function jevProbeConfig(config: ModelConfig, body: unknown) {
  if (!body || typeof body !== "object" || isArray(body)) {
    throw new InputError("Jev 测试配置需要是一个对象");
  }
  const input = objectFields(body);
  if (Reflect.ownKeys(body).some((field) => !JEV_OVERRIDE_FIELDS.has(field))) {
    throw new InputError("Jev 测试只接受 Jev 模型名、API Key 和密钥清除设置");
  }
  const overrides: UnknownRecord = {};
  for (const field of ["jevModel", "jevApiKey"]) {
    if (!Object.hasOwn(input, field)) continue;
    if (typeof input[field] !== "string") throw new InputError("配置项必须是文字");
    if (field === "jevApiKey" && !input[field].trim()) continue;
    overrides[field] = input[field];
  }
  if (Object.hasOwn(input, "clear")) {
    if (!isArray(input.clear) || input.clear.some((field) => field !== "jevApiKey")) {
      throw new InputError("Jev 测试只支持清除 Jev API Key");
    }
    if (input.clear.length) overrides.clear = input.clear;
  }
  const updates = Object.keys(overrides).length ? settingsUpdates(overrides) : {};
  const effective = getProviderConfig({ ...configEnv(config), ...updates });
  if (!effective.jevConfigured) {
    throw new InputError("请先填写 Jev API Key；已保存的密钥可以留空沿用");
  }
  settingsUpdates({ jevModel: effective.jevModel, jevApiKey: effective.jevApiKey });
  return effective;
}

function httpFailure(status: number, stage: string) {
  const details = { httpStatus: status };
  const label = stage === "jev" ? "Jev " : "模型";
  if (status === 401 || status === 403) {
    return probeError(`${label}鉴权失败（HTTP ${status}），请检查 API Key`, "authentication", details, stage);
  }
  if (status === 429) {
    return probeError(`${label}请求过于频繁（HTTP 429），请稍后重试`, "rate_limit", details, stage);
  }
  if (status === 404) {
    return probeError(stage === "jev" ? "Jev 模型或接口不存在（HTTP 404），请检查 Jev 模型名"
      : "模型或接口地址不存在（HTTP 404），请检查接口地址和模型名", "not_found", details, stage);
  }
  if (status >= 500) {
    return probeError(`${label}服务暂时不可用（HTTP ${status}），请稍后重试`, "service_unavailable", details, stage);
  }
  if (status >= 300 && status < 400) {
    return probeError(stage === "jev" ? "Jev 接口发生重定向，无法完成连通性测试"
      : "模型接口发生重定向，请填写最终接口地址", "redirect_rejected", details, stage);
  }
  return probeError(`${label}接口返回 HTTP ${status}，请检查接口配置`, "http_error", details, stage);
}

function requestFailure(error: unknown, timedOut: boolean, stage: string) {
  const label = stage === "jev" ? "Jev " : "模型";
  const timeoutMessage = stage === "jev" ? "Jev 连通性测试超时，请稍后重试"
    : "模型连续未返回响应数据，已停止本次测试，请检查接口地址或稍后重试";
  if (timedOut || errorField(error, "name") === "TimeoutError") {
    return probeError(timeoutMessage, "timeout", {}, stage);
  }
  const code = objectFields(errorField(error, "cause")).code ?? errorField(error, "code");
  if (["ENOTFOUND", "EAI_AGAIN"].includes(code as string)) {
    return probeError(stage === "jev" ? "Jev 接口域名无法解析，请检查网络或稍后重试"
      : "模型接口域名无法解析，请检查接口地址", "dns", { causeCode: code }, stage);
  }
  if (["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(code as string)) {
    return probeError(stage === "jev" ? "连接 Jev 接口超时，请检查网络或稍后重试"
      : "连接模型接口超时，请检查网络或接口地址", "connect_timeout", { causeCode: code }, stage);
  }
  if (["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(code as string)) {
    return probeError(timeoutMessage, "timeout", { causeCode: code }, stage);
  }
  if (["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(code as string) || errorField(error, "name") === "AbortError") {
    return probeError(`${label}连接中断，请稍后重试`, "connection_reset",
      typeof code === "string" && ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(code as string) ? { causeCode: code } : {}, stage);
  }
  return probeError(stage === "jev" ? "无法连接 Jev 接口，请检查网络或稍后重试"
    : "无法连接模型接口，请检查网络和接口配置", "connection_failed", {}, stage);
}

async function readResponse(response: Response, signal: AbortSignal, aborted: Promise<never>, stage: string): Promise<unknown> {
  const label = stage === "jev" ? "Jev " : "模型";
  if (!response.body?.getReader) throw probeError(`${label}接口未返回有效的 JSON`, "invalid_json", {}, stage);
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, content = "", complete = false;
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), aborted]);
      if (signal.aborted) throw new DOMException("操作已取消", "AbortError");
      if (done) { complete = true; break; }
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw probeError(`${label}接口响应过大，请检查接口配置`, "response_too_large", {}, stage);
      try { content += decoder.decode(value, { stream: true }); }
      catch { throw probeError(`${label}接口未返回有效的 JSON`, "invalid_json", {}, stage); }
    }
    try { return JSON.parse(content + decoder.decode()); }
    catch { throw probeError(`${label}接口未返回有效的 JSON`, "invalid_json", {}, stage); }
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function hasReply(raw: unknown): boolean {
  const payload = objectFields(raw);
  if (!payload || payload.error || !isArray(payload.choices)) return false;
  const choice = objectFields(payload.choices.find((item) => objectFields(item).index === 0) ?? payload.choices[0]);
  const message = objectFields(choice?.message);
  if (!message || typeof message !== "object" || isArray(message)
    || (message.role !== undefined && message.role !== "assistant")
    || objectFields(message.tool_calls).length || message.function_call
    || ![undefined, null, "stop", "length"].includes(choice.finish_reason as string | null | undefined)) return false;
  const text = (value: unknown) => typeof value === "string" && Boolean(value.trim());
  const content = message.content;
  return text(content) || (isArray(content) && content.some((part) => objectFields(part).type === "text" && text(objectFields(part).text)))
    || text(message.reasoning_content) || text(message.reasoning);
}

export async function testModelConnection(config: ModelConfig = {}, body: unknown = {}, { fetchImpl = fetch, signal: externalSignal, timeoutMs = 15_000 }: ProbeOptions = {}) {
  const effective = probeConfig(config, body);
  const request: UnknownRecord = {
    model: effective.model, stream: false, max_tokens: 32,
    messages: [{ role: "user", content: "Reply with OK only." }],
  };
  if (/(^|\.)xiaomimimo\.com$/.test(new URL(effective.chatUrl).hostname)) {
    request.thinking = { type: "disabled" };
  }
  return probeConnection({ url: effective.chatUrl, model: effective.model, apiKey: effective.apiKey,
    request, stage: "llm", validReply: hasReply,
    missingMessage: "模型接口未返回有效的模型回复，请检查模型名和接口配置" },
  { fetchImpl, signal: externalSignal, timeoutMs });
}

export async function testAgentModelConnection(config: ModelConfig = {}, body: unknown = {},
  { sessionFactory = createPiSession, signal: externalSignal, timeoutMs = 30_000 }: { sessionFactory?: SessionFactory; signal?: AbortSignal; timeoutMs?: number } = {}) {
  const effective = { ...probeConfig(config, body), llmIdleTimeoutMs: timeoutMs };
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    throw new InputError("构建能力测试无响应等待时间应为 1 到 30000 毫秒之间的整数");
  externalSignal?.throwIfAborted();
  const controller = new AbortController(), { signal } = controller;
  const receipt = randomUUID(), started = performance.now();
  let session: PiSessionPort | undefined, finished = false, unsubscribe = () => {}, turns = 0, toolsCalled = 0, retryWithdrawn = false;
  let turnLimit = false, invalidTool = false, streaming = false, finalError = "";
  const stopSession = (value: PiSessionPort | undefined) => {
    try { void Promise.resolve(value?.abort()).catch(() => {}); } catch {}
  };
  const disposeSession = (value: PiSessionPort | undefined) => {
    try { void Promise.resolve(value?.dispose()).catch(() => {}); } catch {}
  };
  const cancel = () => controller.abort();
  externalSignal?.addEventListener("abort", cancel, { once: true });
  let rejectAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    stopSession(session);
    rejectAbort(new DOMException("操作已取消", "AbortError"));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const tool: NeumaTool = { name: "check_agent_connection", label: "检查构建连接", description: "无副作用的连接测试，返回测试回执。",
    parameters: { type: "object", properties: { challenge: { type: "string", enum: ["neuma-agent-probe"] } },
      required: ["challenge"], additionalProperties: false }, executionMode: "sequential",
    execute: async (_id, value) => {
      signal.throwIfAborted();
      if (toolsCalled || objectFields(value).challenge !== "neuma-agent-probe" || Object.keys(objectFields(value)).length !== 1) {
        invalidTool = true;
        throw probeError("模型未按约定完成构建工具测试", "tool_round_trip");
      }
      toolsCalled++;
      return { content: [{ type: "text", text: JSON.stringify({ receipt }) }], details: {} };
    } };
  try {
    // Session creation may finish after cancellation; dispose that late session too.
    const creating = Promise.resolve().then(() => sessionFactory({ config: effective, cwd: tmpdir(),
      dataDir: join(tmpdir(), `neuma-agent-model-probe-${randomUUID()}`), customTools: [tool], maxOutputTokens: 512,
      systemPrompt: "这是无副作用的连接测试。先调用 check_agent_connection 一次，challenge 为 neuma-agent-probe。收到工具结果后，只回复 OK 加一个空格再加工具返回的 receipt，不再调用工具。" }))
      .then((value) => {
        if (finished || signal.aborted) { stopSession(value); disposeSession(value); throw new DOMException("操作已取消", "AbortError"); }
        session = value;
        return value;
      });
    const activeSession = await Promise.race([creating, aborted]);
    signal.throwIfAborted();
    activeSession.setAutoCompactionEnabled!(false);
    unsubscribe = activeSession.subscribe!((event) => {
      if (event.type === "turn_start") {
        retryWithdrawn = false;
        if (++turns > 4) { turnLimit = true; controller.abort(); }
      }
      if (event.type === "auto_retry_start" && !retryWithdrawn && turns > 0) {
        turns--;
        retryWithdrawn = true;
      }
      if (event.type === "message_update" && ["text_delta", "toolcall_delta"].includes(event.assistantMessageEvent?.type!)) streaming = true;
      if (event.type === "auto_retry_end" && !event.success) finalError = event.finalError || "";
    });
    await Promise.race([activeSession.prompt("请开始构建连接测试。"), aborted]);
    signal.throwIfAborted();
    const last = activeSession.messages?.findLast((message) => message.role === "assistant");
    if (["error", "aborted"].includes(last?.stopReason ?? "") || finalError) {
      const mapped = classifyModelFailure(last?.errorMessage || finalError);
      if (mapped.reason === "api_idle_timeout") throw requestFailure({ name: "TimeoutError" }, false, "llm");
      throw probeError(mapped.message, mapped.reason);
    }
    if (last?.stopReason === "length") throw probeError("构建能力测试的模型输出被截断", "output_limit");
    if (invalidTool || toolsCalled !== 1 || activeSession.getLastAssistantText!()?.trim() !== `OK ${receipt}`)
      throw probeError("模型未完成工具调用与结果回传，暂不能确认构建能力", "tool_round_trip");
    if (!streaming) throw probeError("模型未返回可验证的流式结果", "missing_stream");
    return { ok: true, model: effective.model, latencyMs: Math.max(0, Math.round(performance.now() - started)),
      toolsCalled, streaming: true, toolRoundTrip: true };
  } catch (error) {
    if (externalSignal?.aborted) throw new DOMException("操作已取消", "AbortError");
    if (turnLimit) throw probeError("构建能力测试达到模型轮次上限", "turn_limit");
    if (error instanceof ProbeError) throw error;
    const mapped = classifyModelFailure(errorField(error, "message"));
    if (mapped.reason === "api_idle_timeout") throw requestFailure({ name: "TimeoutError" }, false, "llm");
    throw probeError(mapped.message, mapped.reason);
  } finally {
    finished = true;
    externalSignal?.removeEventListener("abort", cancel);
    signal.removeEventListener("abort", onAbort);
    unsubscribe();
    disposeSession(session);
  }
}

export async function testJevConnection(config: ModelConfig = {}, body: unknown = {}, { fetchImpl = fetch, signal: externalSignal, timeoutMs = 15_000 }: ProbeOptions = {}) {
  const effective = jevProbeConfig(config, body);
  return probeConnection({ url: "https://api.typesafe.ai/v1/systemone", model: effective.jevModel,
    apiKey: effective.jevApiKey, stage: "jev", missingMessage: "Jev 接口未返回有效的判断结果，请检查 Jev 模型名",
    validReply: (payload) => {
      const answer = objectFields(objectFields(objectFields(payload).answers).connectivity);
      return !objectFields(payload).error && answer?.type === "noul" && typeof answer.noul === "number" && Number.isFinite(answer.noul)
        && answer.noul >= 0 && answer.noul <= 1;
    },
    request: {
      model: effective.jevModel, state: { connection_test: true },
      questions: { connectivity: {
        type: "noul", instructions: "Does the connection_test flag in state equal true?",
        criteria: { true: "The connection_test flag is true.", false: "The connection_test flag is false or absent." },
      } },
    } }, { fetchImpl, signal: externalSignal, timeoutMs });
}

async function probeConnection({ url, model, apiKey, request, stage, validReply, missingMessage }: ProbeRequest,
  { fetchImpl, signal: externalSignal, timeoutMs }: { fetchImpl: FetchPort; signal?: AbortSignal | undefined; timeoutMs: number }) {
  if (externalSignal?.aborted) throw new DOMException("操作已取消", "AbortError");
  const controller = new AbortController();
  const { signal } = controller;
  let timedOut = false;
  const timeout = stage === "jev" ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs) : null;
  const requestFetch = stage === "llm" ? withModelIdleTimeout(fetchImpl, { idleTimeoutMs: timeoutMs }) : fetchImpl;
  const cancel = () => controller.abort();
  externalSignal?.addEventListener("abort", cancel, { once: true });
  let rejectAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(new DOMException("操作已取消", "AbortError"));
  signal.addEventListener("abort", onAbort, { once: true });
  const started = performance.now();
  try {
    const response = await Promise.race([requestFetch(url, {
      method: "POST", redirect: "error",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(request), signal,
    }), aborted]);
    if (signal.aborted) throw new DOMException("操作已取消", "AbortError");
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : 0;
      throw httpFailure(status, stage);
    }
    const payload = await readResponse(response, signal, aborted, stage);
    if (!validReply(payload)) throw probeError(missingMessage, "missing_content", {}, stage);
    return { ok: true, model, latencyMs: Math.max(0, Math.round(performance.now() - started)) };
  } catch (error) {
    if (externalSignal?.aborted) throw new DOMException("操作已取消", "AbortError");
    if (timedOut) throw requestFailure(error, true, stage);
    if (error instanceof ProbeError) throw error;
    throw requestFailure(error, false, stage);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", cancel);
    signal.removeEventListener("abort", onAbort);
  }
}
