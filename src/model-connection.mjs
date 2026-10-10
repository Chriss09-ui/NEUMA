import { InputError, ProviderError } from "./requirements/core.mjs";
import { getProviderConfig } from "./requirements/providers.mjs";
import { configEnv, settingsUpdates } from "./settings.mjs";

const OVERRIDE_FIELDS = new Set(["chatUrl", "model", "apiKey"]);
const JEV_OVERRIDE_FIELDS = new Set(["jevModel", "jevApiKey", "clear"]);
const MAX_RESPONSE_BYTES = 64 * 1_024;
class ProbeError extends ProviderError {}

function probeError(message, reason, details = {}, stage = "llm") {
  return new ProbeError(message, { stage, reason, ...details });
}

function probeConfig(config, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new InputError("模型测试配置需要是一个对象");
  }
  if (Reflect.ownKeys(body).some((field) => !OVERRIDE_FIELDS.has(field))) {
    throw new InputError("模型测试只接受接口地址、模型名和 API Key");
  }
  const overrides = {};
  for (const field of OVERRIDE_FIELDS) {
    if (!Object.hasOwn(body, field)) continue;
    if (typeof body[field] !== "string") throw new InputError("配置项必须是文字");
    if (field === "apiKey" && !body[field].trim()) continue;
    overrides[field] = body[field];
  }
  const updates = Object.keys(overrides).length ? settingsUpdates(overrides) : {};
  const effective = getProviderConfig({ ...configEnv(config), ...updates });
  if (!effective.llmConfigured) {
    throw new InputError("请先填写接口地址、模型名和 API Key；已保存的 API Key 可以留空沿用");
  }
  settingsUpdates({ chatUrl: effective.chatUrl, model: effective.model, apiKey: effective.apiKey });
  return effective;
}

function jevProbeConfig(config, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new InputError("Jev 测试配置需要是一个对象");
  }
  if (Reflect.ownKeys(body).some((field) => !JEV_OVERRIDE_FIELDS.has(field))) {
    throw new InputError("Jev 测试只接受 Jev 模型名、API Key 和密钥清除设置");
  }
  const overrides = {};
  for (const field of ["jevModel", "jevApiKey"]) {
    if (!Object.hasOwn(body, field)) continue;
    if (typeof body[field] !== "string") throw new InputError("配置项必须是文字");
    if (field === "jevApiKey" && !body[field].trim()) continue;
    overrides[field] = body[field];
  }
  if (Object.hasOwn(body, "clear")) {
    if (!Array.isArray(body.clear) || body.clear.some((field) => field !== "jevApiKey")) {
      throw new InputError("Jev 测试只支持清除 Jev API Key");
    }
    if (body.clear.length) overrides.clear = body.clear;
  }
  const updates = Object.keys(overrides).length ? settingsUpdates(overrides) : {};
  const effective = getProviderConfig({ ...configEnv(config), ...updates });
  if (!effective.jevConfigured) {
    throw new InputError("请先填写 Jev API Key；已保存的密钥可以留空沿用");
  }
  settingsUpdates({ jevModel: effective.jevModel, jevApiKey: effective.jevApiKey });
  return effective;
}

function httpFailure(status, stage) {
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

function requestFailure(error, timedOut, stage) {
  const label = stage === "jev" ? "Jev " : "模型";
  const timeoutMessage = stage === "jev" ? "Jev 连通性测试超时，请稍后重试"
    : "模型连通性测试超时，请检查接口地址或稍后重试";
  if (timedOut || error?.name === "TimeoutError") {
    return probeError(timeoutMessage, "timeout", {}, stage);
  }
  const code = error?.cause?.code ?? error?.code;
  if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) {
    return probeError(stage === "jev" ? "Jev 接口域名无法解析，请检查网络或稍后重试"
      : "模型接口域名无法解析，请检查接口地址", "dns", { causeCode: code }, stage);
  }
  if (["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(code)) {
    return probeError(stage === "jev" ? "连接 Jev 接口超时，请检查网络或稍后重试"
      : "连接模型接口超时，请检查网络或接口地址", "connect_timeout", { causeCode: code }, stage);
  }
  if (["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(code)) {
    return probeError(timeoutMessage, "timeout", { causeCode: code }, stage);
  }
  if (["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(code) || error?.name === "AbortError") {
    return probeError(`${label}连接中断，请稍后重试`, "connection_reset",
      typeof code === "string" && ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(code) ? { causeCode: code } : {}, stage);
  }
  return probeError(stage === "jev" ? "无法连接 Jev 接口，请检查网络或稍后重试"
    : "无法连接模型接口，请检查网络和接口配置", "connection_failed", {}, stage);
}

async function readResponse(response, signal, aborted, stage) {
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

function hasReply(payload) {
  if (!payload || payload.error || !Array.isArray(payload.choices)) return false;
  const choice = payload.choices.find((item) => item?.index === 0) ?? payload.choices[0];
  const message = choice?.message;
  if (!message || typeof message !== "object" || Array.isArray(message)
    || (message.role !== undefined && message.role !== "assistant")
    || message.tool_calls?.length || message.function_call
    || ![undefined, null, "stop", "length"].includes(choice.finish_reason)) return false;
  const text = (value) => typeof value === "string" && Boolean(value.trim());
  const content = message.content;
  return text(content) || (Array.isArray(content) && content.some((part) => part?.type === "text" && text(part.text)))
    || text(message.reasoning_content) || text(message.reasoning);
}

export async function testModelConnection(config = {}, body = {}, { fetchImpl = fetch, signal: externalSignal, timeoutMs = 15_000 } = {}) {
  const effective = probeConfig(config, body);
  const request = {
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

export async function testJevConnection(config = {}, body = {}, { fetchImpl = fetch, signal: externalSignal, timeoutMs = 15_000 } = {}) {
  const effective = jevProbeConfig(config, body);
  return probeConnection({ url: "https://api.typesafe.ai/v1/systemone", model: effective.jevModel,
    apiKey: effective.jevApiKey, stage: "jev", missingMessage: "Jev 接口未返回有效的判断结果，请检查 Jev 模型名",
    validReply: (payload) => {
      const answer = payload?.answers?.connectivity;
      return !payload?.error && answer?.type === "noul" && Number.isFinite(answer.noul)
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

async function probeConnection({ url, model, apiKey, request, stage, validReply, missingMessage },
  { fetchImpl, signal: externalSignal, timeoutMs }) {
  if (externalSignal?.aborted) throw new DOMException("操作已取消", "AbortError");
  const controller = new AbortController();
  const { signal } = controller;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const cancel = () => controller.abort();
  externalSignal?.addEventListener("abort", cancel, { once: true });
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(new DOMException("操作已取消", "AbortError"));
  signal.addEventListener("abort", onAbort, { once: true });
  const started = performance.now();
  try {
    const response = await Promise.race([fetchImpl(url, {
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
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", cancel);
    signal.removeEventListener("abort", onAbort);
  }
}
