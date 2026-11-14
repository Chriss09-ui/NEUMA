import { callFixture } from "../helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { renderPiSubmissionContract, readPiStructuredSubmission } from "../../src/runtime/pi-submission-contract.mjs";
import { modelSubmissionArguments, modelSubmissionSchemaAtPath, modelSubmissionFormatRecovery, modelReadInputIssues, modelReadRecoveryResult } from "../../src/runtime/model-submission-arguments.mjs";

test("格式重交反馈只接受程序识别的格式诊断，三轮停止且内容错误不能混入", () => {
  const issues = [{ path: "review.checks", reason: "invalid_type" }, { path: "review.issues", reason: "unknown_field" },
    { path: "read.requests", reason: "maxItems" }, { path: "check.expected", reason: "invalid_value" }];
  assert.equal(modelSubmissionFormatRecovery(issues, 1)?.retry, true);
  assert.equal(modelSubmissionFormatRecovery(issues, 2)?.retry, true);
  const exhausted = modelSubmissionFormatRecovery(issues, 3)!;
  assert.equal(exhausted.attempt, 3); assert.equal(exhausted.limit, 3); assert.equal(exhausted.retry, false);
  for (const reason of ["missing_coverage", "reference_quote_mismatch", "platform_claim_mismatch", "insufficient_evidence", "api_connection"])
    assert.equal(modelSubmissionFormatRecovery([...issues, { path: "review", reason }], 1), undefined);
  assert.equal(modelSubmissionFormatRecovery([], 1), undefined);
  for (const count of [undefined, 0, 4, 1.5]) assert.equal(modelSubmissionFormatRecovery(issues, count), undefined);
  const output = { content: [{ type: "text" as const, text: JSON.stringify({ results: [
    { text: '{"error":{"reason":"invalid_request"}}' }, { error: { reason: "invalid_request", message: "续读来源不一致" } },
  ] }) }], details: {} };
  const reads = modelReadInputIssues(output, "read_model_context");
  assert.deepEqual(reads, [{ path: "read_model_context.requests[1]", reason: "invalid_request", remedy: "续读来源不一致" }]);
  assert.equal(modelSubmissionFormatRecovery(reads, 2)?.retry, true);
  const recovered = modelReadRecoveryResult(output, reads, 2);
  assert.equal(recovered.content.length, 1);
  const body = JSON.parse((recovered.content[0] as { text: string }).text);
  assert.equal(body.results[0].text, '{"error":{"reason":"invalid_request"}}');
  assert.equal(body.formatRecovery.retry, true);
});

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
  const message = (value: string) => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: value }] });
  const read = (value: string) => readPiStructuredSubmission(message(value), { tools: [tool] });
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

test("编码容器在正式回复中还原，模糊类型、业务文本、坏JSON与原型字段不被猜测", () => {
  const tool = { name: "finish", parameters: { type: "object", required: ["rows"], additionalProperties: false, properties: {
    rows: { type: "array", items: { type: "object", required: ["ids", "text", "sample"], additionalProperties: false,
      properties: { ids: { type: "array", items: { type: "string" } }, text: { type: "string" }, sample: { anyOf: [{ type: "string" }, { type: "object" }] } } } } } } };
  const send = (rows: unknown) => readPiStructuredSubmission({ role: "assistant", stopReason: "stop",
    content: [{ type: "text", text: JSON.stringify({ submission: { name: "finish", arguments: { rows } } }) }] }, { tools: [tool] });
  const row = { ids: '["req"]', text: "[1]", sample: '{"id":2}' };
  assert.deepEqual(send(JSON.stringify([row]))?.args, { rows: [{ ...row, ids: ["req"] }] });
  for (const malformed of ['[{"ids":[}', '[{"constructor":{}}]', JSON.stringify([ { ...row, ids: "[3]" } ])]) assert.equal(send(malformed), null);
});

test("明确的多余闭合符和外层套错可还原，冲突或坏内容仍由完整提交契约拒绝", () => {
  const tool = { name: "finish", parameters: { type: "object", required: ["plan", "owners", "scopes"], additionalProperties: false,
    properties: { plan: { type: "object", required: ["n", "text"], additionalProperties: false,
      properties: { n: { type: "integer" }, text: { type: "string" } } }, owners: { type: "array", items: { type: "string" } }, scopes: { type: "array", items: { type: "string" } } } } };
  const plan = { n: 3, text: '业务原文 {"n":4}} 不得重写' }, expected = { plan, owners: ["task"], scopes: [] };
  const fragment = JSON.stringify(expected).slice('{"plan":'.length);
  const send = (args: unknown) => readPiStructuredSubmission({ role: "assistant", stopReason: "stop", content: [{ type: "text",
    text: JSON.stringify({ submission: { name: "finish", arguments: args } }) }] }, { tools: [tool] });
  for (const args of [{ plan: fragment }, { ...expected, plan: fragment }, { ...expected, plan: JSON.stringify(plan) + "}" },
    { ...expected, owners: '["task"]]' }]) {
    const before = structuredClone(args);
    assert.deepEqual(send(args)?.args, expected); assert.deepEqual(args, before);
  }
  for (const args of [{ ...expected, plan: fragment, owners: ["different"] },
    { plan: fragment.replace('"owners"', '"unknown"') },
    { ...expected, plan: '{"n":1,"n":3,"text":"same"}}' },
    { ...expected, plan: '{"n":3,"text":"unfinished}' },
    { ...expected, plan: '{"n":3,"text":"ok"} extra' },
    { ...expected, plan: '{"n":3,"text":"ok","__proto__":{}}}' },
    { ...expected, plan: '{"n":"3","text":"wrong scalar"}}' }]) assert.equal(send(args), null);
});

test("缺失、重复或未注册的正式出口不生成误导提示", () => {
  const base = { role: "reviewer", submitName: "finish", tools: [{ name: "finish" }] };
  for (const override of [{ tools: [] }, { tools: [{ name: "finish" }, { name: "finish" }] }, { alternativeTools: ["absent"] },
    { alternativeTools: ["finish"] }, { tools: [...base.tools, { name: "other" }], alternativeTools: ["other", "other"] },
    { role: "PRIVATE invalid role" }, { submitName: {} }])
    assert.throws(() => callFixture(renderPiSubmissionContract, undefined, [{ ...base, ...override }]), (error) => error instanceof TypeError && !error.message.includes("PRIVATE"));
  assert.doesNotMatch(renderPiSubmissionContract(base), /正式终止出口/u);
});

test("补丁按声明路径恢复容器，保留业务文本和数字，不猜测联合类型或未声明字段", () => {
  const schema = { type: "object", properties: {
    rows: { type: "array", items: { $ref: "#/definitions/row" } },
    free: {}, union: { anyOf: [{ type: "object" }, { type: "string" }] },
  }, definitions: { row: { type: "object", properties: { text: { type: "string" }, number: { type: "integer" }, ids: { type: "array", items: { type: "string" } } } } } };
  const read = (path: string, value: unknown) => {
    const target = modelSubmissionSchemaAtPath(schema, path);
    return target ? modelSubmissionArguments(value, target) : value;
  };
  const raw = JSON.stringify({ text: '{"id":1}', number: "3", ids: '["a"]' });
  assert.deepEqual(read("/rows/0", raw), { text: '{"id":1}', number: "3", ids: ["a"] });
  for (const path of ["/rows/0/text", "/rows/0/number", "/rows/01", "/rows/0/extra", "/union", "/free", "/__proto__", "/rows/~2"])
    assert.equal(read(path, raw), raw, path);
  for (const value of ['{"ids":[}', '"3"', '3', '{"__proto__":{}}']) assert.equal(read("/rows/0", value), value);
});
