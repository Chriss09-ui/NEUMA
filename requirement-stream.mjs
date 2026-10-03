import { ProviderError } from "./core.mjs";

const MAX_REPLY_LENGTH = 4_000;
const MAX_BUFFER_LENGTH = 128 * 1_024;

function streamError(reason = "invalid_stream") {
  const message = reason === "reply_too_long" ? "兼容模型回复过长，请重试本轮"
    : reason === "incomplete_stream" ? "兼容模型回复中断，请重试本轮"
      : "兼容模型未返回有效的流式回复，请重试本轮";
  return new ProviderError(message, { stage: "llm", reason });
}

function validateFinish(reason) {
  if (reason !== "stop") throw streamError("incomplete_stream");
}

function validateChoice(choice) {
  if (choice?.delta?.tool_calls?.length || choice?.delta?.function_call
    || choice?.message?.tool_calls?.length || choice?.message?.function_call) {
    throw streamError();
  }
  if (choice?.finish_reason != null) validateFinish(choice.finish_reason);
}

// Read through one cancellable reader so cancellation also interrupts a stalled body.
async function readBody(response, signal, consume) {
  if (!response.body) throw streamError("incomplete_stream");
  const reader = response.body.getReader();
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = () => {
    rejectAbort(new DOMException("操作已取消", "AbortError"));
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let completed = false;
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), aborted]);
      if (signal?.aborted) throw new DOMException("操作已取消", "AbortError");
      if (done) {
        consume(decoder.decode(), true);
        completed = true;
        break;
      }
      if (consume(decoder.decode(value, { stream: true }), false) === false) break;
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!completed) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readModelReply(response, { signal, onDelta = () => {} } = {}) {
  const contentType = response.headers.get("content-type") ?? "";
  if (/application\/(?:[\w.+-]+\+)?json\b/i.test(contentType)) {
    let content = "";
    await readBody(response, signal, (chunk) => {
      if (content.length + chunk.length > MAX_BUFFER_LENGTH) throw streamError("reply_too_long");
      content += chunk;
    });
    let payload;
    try { payload = JSON.parse(content); } catch { throw streamError(); }
    const choice = payload?.choices?.[0];
    if (payload?.error) throw streamError();
    validateChoice(choice);
    validateFinish(choice?.finish_reason);
    const text = choice?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw streamError();
    if (text.length > MAX_REPLY_LENGTH) throw streamError("reply_too_long");
    onDelta(text);
    return text;
  }
  if (!/text\/event-stream\b/i.test(contentType)) {
    void response.body?.cancel().catch(() => {});
    throw streamError();
  }

  let buffer = "";
  let eventData = [];
  let eventLength = 0;
  let eventType = "";
  let text = "";
  let finished = false;
  let done = false;
  const dispatch = () => {
    if (eventType === "error") throw streamError();
    eventType = "";
    if (!eventData.length) return;
    const data = eventData.join("\n");
    eventData = [];
    eventLength = 0;
    if (done) throw streamError();
    if (data.trim() === "[DONE]") {
      if (!finished) throw streamError("incomplete_stream");
      done = true;
      return;
    }
    let payload;
    try { payload = JSON.parse(data); } catch { throw streamError(); }
    if (payload?.error || !Array.isArray(payload?.choices)) throw streamError();
    // Usage-only events have no choices; neither they nor reasoning are displayed.
    if (!payload.choices.length) return;
    const choice = payload.choices.find((item) => item.index === 0) ?? payload.choices[0];
    validateChoice(choice);
    const chunk = choice?.delta?.content;
    if (chunk != null && typeof chunk !== "string") throw streamError();
    if (chunk) {
      if (finished) throw streamError();
      if (text.length + chunk.length > MAX_REPLY_LENGTH) throw streamError("reply_too_long");
      text += chunk;
      onDelta(chunk);
    }
    if (choice.finish_reason === "stop") finished = true;
  };
  const consumeLine = (line) => {
    if (!line) return dispatch();
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      eventLength += value.length + 1;
      if (eventLength > MAX_BUFFER_LENGTH) throw streamError("reply_too_long");
      eventData.push(value);
    }
    if (field === "event") eventType = value;
  };
  await readBody(response, signal, (chunk, end) => {
    if (buffer.length + chunk.length > MAX_BUFFER_LENGTH) throw streamError("reply_too_long");
    buffer += chunk;
    let match;
    while ((match = /\r\n|\r|\n/.exec(buffer))) {
      if (!end && match[0] === "\r" && match.index === buffer.length - 1) break;
      consumeLine(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
    }
    if (end) {
      if (buffer) consumeLine(buffer);
      dispatch();
    }
    return !done;
  });
  if (!finished || !done || !text.trim()) throw streamError("incomplete_stream");
  return text;
}
