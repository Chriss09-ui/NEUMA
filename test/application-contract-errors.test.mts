import { failureFields } from "./helpers/failure-fields.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { validateActionInput, validateActionOutput } from "../src/applications/application-contract.mjs";
import { InputError } from "../src/requirements/core.mjs";

const object = (properties: Record<string,import("../src/contracts/application.mjs").ValueSchema>): import("../src/contracts/application.mjs").ValueSchema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const records = object({ records: { type: "array", items: object({ bytes: { type: "integer", minimum: 0 } }) } });
const action = { inputSchema: records, outputSchema: records };

test("input admission errors identify the declared field and array position without including values", () => {
  assert.throws(() => validateActionInput(action, { records: [{ bytes: 1 }, { bytes: true }] }), (error) => {
    assert.ok(error instanceof InputError);
    assert.equal(error.reason, "input_contract_rejected"); assert.equal(error.statusCode, 400);
    assert.deepEqual(error.validationIssue, { path: "input.records.1.bytes", reason: "invalid_type" });
    assert.doesNotMatch(error.message, /true/); return true;
  });
  assert.throws(() => validateActionInput(action, { records: [{}] }), (error) => {
    assert.deepEqual(failureFields(error).validationIssue, { path: "input.records.0.bytes", reason: "required_field" }); return true;
  });
});

test("unknown input keys and raw JSON object keys never enter public error paths", () => {
  const secret = "private-key-do-not-echo";
  assert.throws(() => validateActionInput(action, { records: [{ bytes: 1, [secret]: secret }] }), (error) => {
    assert.deepEqual(failureFields(error).validationIssue, { path: "input.records.0", reason: "unknown_field" });
    assert.equal(JSON.stringify(failureFields(error).validationIssue).includes(secret), false); assert.equal(failureFields(error).message!.includes(secret), false); return true;
  });
  const raw = { inputSchema: object({ records: { type: "array", items: {} } }) };
  assert.throws(() => validateActionInput(raw, { records: [{ [secret]: undefined }] }), (error) => {
    assert.deepEqual(failureFields(error).validationIssue, { path: "input.records.0[JSON]", reason: "invalid_type" });
    assert.equal(failureFields(error).message!.includes(secret), false); return true;
  });
});

test("generated output failures remain program failures and invalid schemas are not blamed on input", () => {
  assert.throws(() => validateActionOutput(action, { records: [{ bytes: false }] }), (error) => {
    assert.equal(failureFields(error).reason, "output_contract_failed"); assert.equal(failureFields(error).statusCode, 500);
    assert.deepEqual(failureFields(error).validationIssue, { path: "output.records.0.bytes", reason: "invalid_type" }); return true;
  });
  assert.throws(() => validateActionInput({ inputSchema: { type: "invented" } }, {}), (error) => {
    assert.equal(failureFields(error).reason, undefined); assert.equal(failureFields(error).validationIssue, undefined); return true;
  });
  assert.throws(() => validateActionOutput({ outputSchema: { type: "invented" } }, {}), (error) => {
    assert.equal(failureFields(error).reason, "output_contract_failed"); assert.equal(failureFields(error).statusCode, 500);
    assert.deepEqual(failureFields(error).validationIssue, { path: "output", reason: "invalid_schema" }); return true;
  });
});
