import test from "node:test";
import assert from "node:assert/strict";
import { renderPiSubmissionContract, readPiStructuredSubmission } from "../src/runtime/pi-submission-contract.mjs";

test("显式提交契约只广告真实注册的主工具和调用方允许的终止出口，不按前缀猜测", () => {
  const tools = [{ name: "finish_plan" }, { name: "report_blocker" }, { name: "submit_unrelated" }, { name: "read_context" }];
  const before = structuredClone(tools), text = renderPiSubmissionContract({ role: "planner", submitName: "finish_plan", tools,
    alternativeTools: ["report_blocker"] });
  assert.match(text, /role=planner，submitName=finish_plan/u);
  assert.match(text, /实际发起finish_plan的正式tool_call/u); assert.match(text, /report_blocker作为正式终止出口/u);
  assert.doesNotMatch(text, /submit_unrelated|read_context/u);
  assert.match(text, /完整JSON、代码块或仅含工具名与参数的正文均不算工具调用/u);
  assert.match(text, /不要求立即提交，不跳过既有检查，也不改变预算/u);
  assert.deepEqual(tools, before);
});

test("结构化终止提交与模型品牌无关，只解码唯一匹配的完整数据，拒绝一般工具、类型强转和批量命令", () => {
  const tool = { name: "finish", parameters: { type: "object", additionalProperties: false,
    required: ["answer"], properties: { answer: { type: "integer" } } } };
  const message = (value) => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: value }] });
  const read = (value) => readPiStructuredSubmission(message(value), { tools: [tool] });
  for (const value of [{ answer: 2 }, { submission: { name: "finish", arguments: { answer: 2 } } },
    { name: "finish", arguments: { answer: 2 } }, { tool: "finish", arguments: { answer: 2 } }]) {
    assert.deepEqual(read(JSON.stringify(value)), { tool, args: { answer: 2 } });
  }
  for (const value of ['{"answer":"2"}', '{"answer":2,"extra":0}', '[{"answer":2}]',
    '{"submission":{"name":"write","arguments":{"answer":2}}}',
    '{"submission":{"name":"finish","arguments":{"answer":2},"extra":0}}',
    '{"answer":2,"__proto__":{}}', '```json\n{"answer":2}\n```', '说明 {"answer":2}']) assert.equal(read(value), null);
  for (const stopReason of ["length", "error", "aborted"]) assert.equal(readPiStructuredSubmission({ ...message('{"answer":2}'), stopReason }, { tools: [tool] }), null);
  assert.equal(readPiStructuredSubmission(message('{"answer":2}'), { tools: [tool, { ...tool, name: "other" }] }), null);
  const thought = { type: "thinking" };
  Object.defineProperty(thought, "thinking", { get() { throw new Error("private thinking must not be read"); } });
  assert.deepEqual(readPiStructuredSubmission({ ...message('{"answer":2}'), content: [thought, ...message('{"answer":2}').content] }, { tools: [tool] }), { tool, args: { answer: 2 } });
  assert.match(renderPiSubmissionContract({ role: "reviewer", submitName: "finish", tools: [tool], structuredResponse: true }), /同一结构校验、版本检查和独立验收/u);
});

test("缺失、重复或未注册的正式出口不生成误导提示", () => {
  const base = { role: "reviewer", submitName: "finish", tools: [{ name: "finish" }] };
  for (const override of [{ tools: [] }, { tools: [{ name: "finish" }, { name: "finish" }] }, { alternativeTools: ["absent"] },
    { alternativeTools: ["finish"] }, { tools: [...base.tools, { name: "other" }], alternativeTools: ["other", "other"] },
    { role: "PRIVATE invalid role" }, { submitName: {} }])
    assert.throws(() => renderPiSubmissionContract({ ...base, ...override }), (error) => error instanceof TypeError && !error.message.includes("PRIVATE"));
  assert.doesNotMatch(renderPiSubmissionContract(base), /正式终止出口/u);
});
