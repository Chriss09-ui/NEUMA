import { isArray, isInteger, objectFields } from "./type-boundary.mjs";

export const MODEL_STREAM_LIMIT_CODE = "NEUMA_MODEL_STREAM_LIMIT";
/** Unique text retained from one model reply, across body, reasoning and tool arguments. */
export const MODEL_STREAM_ASSEMBLED_CHAR_LIMIT = 1_500_000;
/** One server-sent line. A cumulative fragment is one line, so this stays above a normal reply. */
export const MODEL_STREAM_LINE_BYTE_LIMIT = 2 * 1024 * 1024;
/** Bytes forwarded to the model client after cumulative fragments are reduced to their new suffix. */
export const MODEL_STREAM_FORWARDED_BYTE_LIMIT = 8 * 1024 * 1024;

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export function modelStreamLimitError() {
  return Object.assign(new Error(`${MODEL_STREAM_LIMIT_CODE}: 这一轮模型回复超出单次接收上限，已停止接收；已保存进度保留`), {
    code: MODEL_STREAM_LIMIT_CODE, reason: "stream_limit",
  });
}

interface StreamBoundOptions {
  assembledCharLimit?: number;
  lineByteLimit?: number;
  forwardedByteLimit?: number;
}

function limit(value: number | undefined, fallback: number) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("模型流接收上限无效");
  return value;
}

class ByteQueue {
  private parts: Uint8Array[] = [];
  private start = 0;
  bytes = 0;

  push(chunk: Uint8Array) {
    if (!chunk.byteLength) return;
    this.parts.push(chunk.slice());
    this.bytes += chunk.byteLength;
  }

  private find(target: number) {
    let seen = 0;
    for (let index = 0; index < this.parts.length; index++) {
      const part = this.parts[index]!;
      const from = index === 0 ? this.start : 0;
      for (let offset = from; offset < part.length; offset++) if (part[offset] === target) return seen + offset - from;
      seen += part.length - from;
    }
    return -1;
  }

  private take(count: number) {
    const out = new Uint8Array(count);
    let filled = 0;
    while (filled < count) {
      const part = this.parts[0];
      if (!part) break;
      const take = Math.min(part.length - this.start, count - filled);
      out.set(part.subarray(this.start, this.start + take), filled);
      filled += take;
      this.start += take;
      this.bytes -= take;
      if (this.start >= part.length) { this.parts.shift(); this.start = 0; }
    }
    return out;
  }

  takeLine() {
    const newline = this.find(10);
    if (newline < 0) return null;
    const line = this.take(newline);
    this.take(1);
    return line;
  }

  takeRest() { return this.bytes ? this.take(this.bytes) : null; }
}

/** Reduce a repeated full fragment to the unseen suffix. Ordinary deltas do not start with the text already forwarded. */
export function createModelStreamRewriter(options: StreamBoundOptions = {}) {
  const assembledCharLimit = limit(options.assembledCharLimit, MODEL_STREAM_ASSEMBLED_CHAR_LIMIT);
  const forwardedByteLimit = limit(options.forwardedByteLimit, MODEL_STREAM_FORWARDED_BYTE_LIMIT);
  const assembled = new Map<string, string>();
  let chars = 0, forwarded = 0;
  const take = (key: string, incoming: string) => {
    const previous = assembled.get(key) ?? "";
    const cumulative = previous.length > 0 && incoming.startsWith(previous);
    const next = cumulative ? incoming : previous + incoming;
    const growth = next.length - previous.length;
    if (chars + growth > assembledCharLimit) throw modelStreamLimitError();
    chars += growth;
    assembled.set(key, next);
    return cumulative ? incoming.slice(previous.length) : incoming;
  };
  const rewriteValue = (value: unknown) => {
    const root = objectFields(value);
    if (!isArray(root.choices)) return false;
    for (const [choiceIndex, choice] of root.choices.entries()) {
      const delta = objectFields(objectFields(choice).delta);
      if (typeof delta.content === "string") delta.content = take(`content:${choiceIndex}`, delta.content);
      for (const field of ["reasoning_content", "reasoning", "reasoning_text"] as const)
        if (typeof delta[field] === "string") delta[field] = take(`${field}:${choiceIndex}`, delta[field]);
      if (isArray(delta.tool_calls)) for (const call of delta.tool_calls) {
        const item = objectFields(call), index = isInteger(item.index) && item.index >= 0 && item.index <= 255 ? item.index : 0;
        const fn = objectFields(item.function), custom = objectFields(item.custom);
        if (typeof fn.arguments === "string") fn.arguments = take(`arguments:${choiceIndex}:${index}`, fn.arguments);
        if (typeof custom.input === "string") custom.input = take(`custom:${choiceIndex}:${index}`, custom.input);
      }
      if (isArray(delta.reasoning_details)) for (const [detailIndex, detail] of delta.reasoning_details.entries()) {
        const row = objectFields(detail), identity = `${row.type}:${isInteger(row.index) ? row.index : detailIndex}`;
        for (const field of ["text", "summary", "data"] as const)
          if (typeof row[field] === "string") row[field] = take(`detail:${choiceIndex}:${identity}:${field}`, row[field]);
      }
    }
    return true;
  };
  return { rewriteLine(line: string) {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    let rewritten = text;
    if (text.startsWith("data:")) {
      const payload = text.startsWith("data: ") ? text.slice(6) : text.slice(5);
      if (payload && payload !== "[DONE]") {
        try {
          const value: unknown = JSON.parse(payload);
          if (rewriteValue(value)) rewritten = `data: ${JSON.stringify(value)}`;
        } catch (error) {
          if (objectFields(error).code === MODEL_STREAM_LIMIT_CODE) throw error;
        }
      }
    }
    const bytes = textEncoder.encode(`${rewritten}\n`);
    if (forwarded + bytes.byteLength > forwardedByteLimit) throw modelStreamLimitError();
    forwarded += bytes.byteLength;
    return bytes;
  } };
}

export function boundEventStream(source: ReadableStream<Uint8Array>, options: StreamBoundOptions = {}): ReadableStream<Uint8Array> {
  const lineByteLimit = limit(options.lineByteLimit, MODEL_STREAM_LINE_BYTE_LIMIT);
  const reader = source.getReader(), queue = new ByteQueue(), rewriter = createModelStreamRewriter(options);
  const emit = (controller: ReadableStreamDefaultController<Uint8Array>, line: Uint8Array) => {
    if (line.byteLength > lineByteLimit) throw modelStreamLimitError();
    controller.enqueue(rewriter.rewriteLine(textDecoder.decode(line)));
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          const line = queue.takeLine();
          if (line) { emit(controller, line); return; }
          const next = await reader.read();
          if (next.done) {
            const rest = queue.takeRest();
            if (rest?.byteLength) emit(controller, rest);
            controller.close();
            return;
          }
          if (next.value.byteLength > lineByteLimit || !next.value.includes(10) && queue.bytes + next.value.byteLength > lineByteLimit)
            throw modelStreamLimitError();
          queue.push(next.value);
        }
      } catch (error) {
        await reader.cancel(error).catch(() => {});
        throw error;
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  }, { highWaterMark: 0 });
}

export function boundModelResponse(response: Response, options: StreamBoundOptions = {}) {
  const type = response.headers.get("content-type") ?? "";
  if (!response.ok || !response.body || type.includes("application/json") && !type.includes("event-stream")) return response;
  if (type && !type.includes("event-stream") && !type.includes("text/plain") && !type.includes("octet-stream")) return response;
  return new Response(boundEventStream(response.body, options), { status: response.status, statusText: response.statusText, headers: response.headers });
}
