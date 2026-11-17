import test from "node:test";
import assert from "node:assert/strict";
import { hostSessionEvent } from "../../src/runtime/execution-runtime.mjs";
import { classifyModelFailure } from "../../src/runtime/pi-runtime.mjs";
import { boundEventStream, boundModelResponse, createModelStreamRewriter, MODEL_STREAM_LIMIT_CODE } from "../../src/runtime/model-stream-bounds.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function chunk(text: string) { return encoder.encode(text); }

function choice(delta: Record<string, unknown>) {
  return { choices: [{ index: 0, delta }] };
}

async function readStream(chunks: Uint8Array[], options?: { assembledCharLimit?: number; lineByteLimit?: number; forwardedByteLimit?: number }) {
  const stream = boundEventStream(new ReadableStream({
    start(controller) { for (const item of chunks) controller.enqueue(item); controller.close(); },
  }), options);
  const reader = stream.getReader(), parts: Uint8Array[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    parts.push(next.value);
  }
  return decoder.decode(Buffer.concat(parts));
}

function payloads(body: string) {
  return body.split("\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]").map(line => JSON.parse(line.slice(6)) as { choices: { delta: Record<string, unknown> }[] });
}

test("累计全文只转发新增后缀，普通增量保持原样", async () => {
  let full = "";
  const cumulative = ["{", "\"题目\":", "论文"].map(piece => {
    full += piece;
    return `data: ${JSON.stringify(choice({ tool_calls: [{ index: 0, function: { arguments: full } }] }))}\n`;
  });
  const rewritten = payloads(await readStream(cumulative.map(chunk)));
  const forwarded = rewritten.map(item => (item.choices[0]!.delta.tool_calls as { function: { arguments: string } }[])[0]!.function.arguments);
  assert.deepEqual(forwarded, ["{", "\"题目\":", "论文"]);
  assert.equal(forwarded.join(""), full);

  const deltas = ["{", "\"题目\":", "论文"].map(piece => `data: ${JSON.stringify(choice({ tool_calls: [{ index: 0, function: { arguments: piece } }] }))}\n`);
  const passed = payloads(await readStream([chunk(deltas.join(""))]));
  assert.deepEqual(passed.map(item => (item.choices[0]!.delta.tool_calls as { function: { arguments: string } }[])[0]!.function.arguments), ["{", "\"题目\":", "论文"]);
});

test("思考字段的累计全文同样只保留新增部分，且跨字节片不被拆开", async () => {
  let full = "";
  const pieces = ["先看", "摘要", "再写结论"];
  const lines = pieces.map(piece => {
    full += piece;
    return `data: ${JSON.stringify(choice({ reasoning_content: full }))}\n`;
  }).join("") + "data: [DONE]\n";
  const bytes = chunk(lines);
  const split = [bytes.subarray(0, 3), bytes.subarray(3, 7), bytes.subarray(7)];
  const body = await readStream(split);
  const forwarded = payloads(body).map(item => item.choices[0]!.delta.reasoning_content);
  assert.deepEqual(forwarded, pieces);
  assert.ok(body.endsWith("data: [DONE]\n"));
});

test("单轮累计正文超过上限时停止，不再继续转发", async () => {
  const huge = "甲".repeat(50);
  const lines = [huge, huge + "乙".repeat(20)].map(text => `data: ${JSON.stringify(choice({ content: text }))}\n`);
  await assert.rejects(readStream(lines.map(chunk), { assembledCharLimit: 60 }), (error: Error) => error.message.includes(MODEL_STREAM_LIMIT_CODE));
  assert.equal(classifyModelFailure(`${MODEL_STREAM_LIMIT_CODE}: 停止`).reason, "api_output_limit");
  assert.match(classifyModelFailure(`${MODEL_STREAM_LIMIT_CODE}: 停止`).message, /已保存进度保留/);
});

test("非事件流响应不改写", async () => {
  const response = boundModelResponse(new Response("{\"ok\":true}", { status: 200, headers: { "content-type": "application/json" } }));
  assert.equal(await response.text(), "{\"ok\":true}");
  const rewriter = createModelStreamRewriter();
  assert.equal(decoder.decode(rewriter.rewriteLine("data: not-json")), "data: not-json\n");
});

test("流式更新不复制整段回复，结束事件仍复制正文", () => {
  const message = { role: "assistant", content: [{ type: "text", text: "甲".repeat(1000) }] };
  const update = hostSessionEvent({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", delta: "甲", partial: message } });
  assert.equal(update.type, "message_update");
  assert.equal("message" in update, false);
  assert.deepEqual(update.assistantMessageEvent, { type: "text_delta", delta: "甲" });
  const end = hostSessionEvent({ type: "message_end", message });
  assert.deepEqual(end.message, message);
  if (end.message && Array.isArray(end.message.content) && end.message.content[0] && "text" in end.message.content[0]) end.message.content[0].text = "changed";
  assert.equal(message.content[0]!.text, "甲".repeat(1000));
});
