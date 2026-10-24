import test from "node:test";
import assert from "node:assert/strict";
import { publicInputContractFailure } from "../src/applications/application-errors.mjs";
import { validateActionInput, validateActionOutput } from "../src/applications/application-contract.mjs";
import { InputError } from "../src/requirements/core.mjs";
import { objectFields } from "../src/runtime/type-boundary.mjs";

const object = (properties: Record<string, object>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const action = { inputSchema: object({ records: { type: "array", items: object({ bytes: { type: "integer" } }) } }) };
const capture = (run: () => unknown) => { try { run(); } catch (error) { assert.ok(error instanceof InputError); return error; } throw new Error("固定非法输入应被正式校验器拒绝"); };
const typed = (path: string, reason = "invalid_type") => Object.assign(new InputError("PRIVATE_ERROR_BODY"), { reason: "input_contract_rejected", validationIssue: { path, reason } });

test("真实输入契约错误只公开声明字段位置和固定原因，不复制原异常或动态数据", () => {
  const error = capture(() => validateActionInput(action, { records: [{ bytes: true }] }));
  const result = publicInputContractFailure(error);
  assert.deepEqual(result!.validationIssue!, { path: "input.records.0.bytes", reason: "invalid_type" });
  assert.equal(result!.reason!, "input_contract_rejected"); assert.match(result!.error!, /input\.records\.0\.bytes.*字段类型无效/);
  const unknown = capture(() => validateActionInput(action, { records: [{ bytes: 1, PRIVATE_DYNAMIC_KEY: "PRIVATE_VALUE" }] }));
  const safe = publicInputContractFailure(unknown); assert.equal(safe!.validationIssue!.path, "input.records.0");
  assert.doesNotMatch(JSON.stringify(safe), /PRIVATE_/);
  result!.validationIssue!.path = "caller-modified";
  assert.equal(objectFields(error.validationIssue).path, "input.records.0.bytes", "公开回执不能成为原错误的可变引用");
});

test("固定原因与有界路径白名单覆盖根、数组、原生JSON，拒绝额外元数据或任意文本", () => {
  for (const reason of ["required_field", "unknown_field", "invalid_type", "size_limit", "invalid_value", "json_limit", "invalid_structure", "channel_limit"])
    assert.equal(publicInputContractFailure!(typed("input.data[JSON][1].field", reason))!.validationIssue.reason, reason);
  for (const path of ["input", "input.rows.123.value", "input.data[JSON][JSON]", "input.rows[12].value"])
    assert.equal(publicInputContractFailure!(typed(path))!.validationIssue.path, path);
  for (const path of ["output.value", "input['PRIVATE_KEY']", "input.value\nPRIVATE_BODY", "input.value=PRIVATE_BODY", "input..value", "input." + "x".repeat(2049)])
    assert.equal(publicInputContractFailure(typed(path)), null);
  assert.equal(publicInputContractFailure(typed("input.value", "PRIVATE_REASON")), null);
  const extra = typed("input.value"); Object.assign(extra.validationIssue, { PRIVATE_FIELD: "PRIVATE_VALUE" });
  assert.equal(publicInputContractFailure(extra), null);
});

test("非InputError伪造元数据、输出契约错误和未知异常不能伪装输入拒绝", () => {
  const metadata = { reason: "input_contract_rejected", validationIssue: { path: "input.records.0.bytes", reason: "invalid_type" } };
  for (const error of [null, undefined, new Error("PRIVATE_ERROR_BODY"), Object.assign(new Error("PRIVATE_ERROR_BODY"), metadata),
    { message: "PRIVATE_ERROR_BODY", ...metadata }, new InputError("PRIVATE_ERROR_BODY")]) assert.equal(publicInputContractFailure(error), null);
  const output = capture(() => validateActionOutput({ outputSchema: object({ PRIVATE_OUTPUT_FIELD: { type: "integer" } }) }, { PRIVATE_OUTPUT_FIELD: "PRIVATE_GENERATED_OUTPUT" }));
  assert.equal(output.reason, "output_contract_failed"); assert.equal(publicInputContractFailure(output), null);
});

test("正式原生JSON深度和通道限制仍给受控位置，不回显动态原文", () => {
  const opaque = { inputSchema: object({ data: {} }) };
  let data: unknown = 1; for (let index = 0; index < 35; index++) data = { PRIVATE_DYNAMIC_KEY: data };
  const depth = publicInputContractFailure(capture(() => validateActionInput(opaque, { data })));
  assert.equal(depth!.validationIssue!.reason, "json_limit"); assert.match(depth!.validationIssue!.path, /^input\.data(?:\[JSON\])+$/);
  assert.doesNotMatch(JSON.stringify(depth), /PRIVATE_/);
  const channel = publicInputContractFailure(capture(() => validateActionInput(opaque, { data: "界".repeat(400000) })));
  assert.deepEqual(channel!.validationIssue!, { path: "input", reason: "channel_limit" });
});
