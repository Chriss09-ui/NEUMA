import { objectFields } from "../../src/runtime/type-boundary.mjs";
import { callFixture } from "../helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { Ajv } from "ajv";
import { ACCEPTANCE_ADAPTER_GUIDE } from "../../src/verification/acceptance-contract.mjs";
import { INPUT_REJECTION_RESULT, INPUT_REJECTION_RESULT_CONTRACT, INPUT_REJECTION_ADMISSION_CONTRACT,
  INPUT_REJECTION_EXPECTED_EVIDENCE } from "../../src/verification/input-rejection-contract.mjs";
import { TEST_FIXTURE_SCHEMA, TEST_FIXTURE_OPERATION_GUIDE, FIXTURE_LIMITS, resolveCaseValues } from "../../src/development/development-fixtures.mjs";
import { DevelopmentController } from "../../src/development/development.mjs";
import { compactDevelopmentContext } from "../../src/development/development-context.mjs";
import { architectureReviewEvidenceContext } from "../../src/architecture/architecture-review-evidence.mjs";

test("入口拒绝共用强类型actual与独立admission事实，报告本身可以承担对应expected", () => {
  const facts = ACCEPTANCE_ADAPTER_GUIDE.adapters!["input-contract"]!.executionFacts;
  assert.equal(facts.resultContract, INPUT_REJECTION_RESULT_CONTRACT);
  assert.equal(facts.admissionContract, INPUT_REJECTION_ADMISSION_CONTRACT);
  assert.equal(facts.expectedEvidence, INPUT_REJECTION_EXPECTED_EVIDENCE);
  assert.equal(facts.resultContract.assertionSource, "actual"); assert.equal(facts.admissionContract.assertionSource, false);
  assert.equal(facts.expectedEvidence.reportMaySatisfyExpected, true);
  assert.equal(facts.expectedEvidence.requiresGeneratedCodeOutputFields, false);
  const ajv = new Ajv({ strict: false }), actual = ajv.compile(facts.resultContract.schema), admission = ajv.compile(facts.admissionContract.schema);
  assert.equal(actual(INPUT_REJECTION_RESULT), true);
  assert.equal(actual({ ...INPUT_REJECTION_RESULT, admission: { target: "action-value", bytes: 2, limit: 100 } }), false);
  assert.equal(actual({ rejected: true, reason: "other" }), false);
  assert.equal(admission({ target: "task-envelope", bytes: 101, limit: 100 }), true);
  assert.equal(admission({ target: "task-envelope", bytes: "101", limit: 100 }), false);
});

test("动作数据构造事实直接引用正式fixture协议，computed字符串仍是冻结字面值", () => {
  const facts = ACCEPTANCE_ADAPTER_GUIDE.adapters!.action!.executionFacts;
  assert.equal(facts.dynamicPlaceholders, false);
  assert.equal(facts.fixtureConstruction.schema, TEST_FIXTURE_SCHEMA);
  assert.equal(facts.fixtureConstruction.operationsGuidePath, "schema.description");
  assert.equal(facts.fixtureConstruction.schema.description, TEST_FIXTURE_OPERATION_GUIDE);
  assert.equal(facts.fixtureConstruction.limits, FIXTURE_LIMITS);
  assert.equal(facts.fixtureConstruction.businessOracle, false);
  const resolved = resolveCaseValues({ input: "{}", mocks: [{ capability: "files.write", argsJson: '{"file":"result.txt","content":"<computed-content>"}', resultJson: '{"saved":true}' }],
    assertions: [{ path: "", expectedJson: "true" }] });
  assert.equal(objectFields(resolved.mocks![0]!.args).content, "<computed-content>");
});

test("架构独立评审与研发首包使用同一指南和构造schema，不继承历史review的能力声明", () => {
  const design = { schemaVersion: 2, acceptance: [] }, requirements = [{ id: "task", text: "保留输入" }], runtimeCapabilities = { version: 1 };
  const review = architectureReviewEvidenceContext({ design, requirements, runtimeCapabilities });
  assert.equal(review.contextManifest!.acceptanceAdapterGuide!.delivery, "full");
  assert.deepEqual(review.acceptanceAdapterGuide, ACCEPTANCE_ADAPTER_GUIDE);
  const payload = callFixture(DevelopmentController.prototype.base, DevelopmentController.prototype, [{ record: { architectureRef: { version: 1, candidateHash: "a".repeat(64) },
    architecture: { design, requirements, runtimeCapabilities }, plan: { entrypoint: "main.mjs", runtime: "node-action", application: {} },
    handoffs: [], budgets: {} } }]);
  const first = compactDevelopmentContext(payload, 128000);
  assert.deepEqual(first.acceptanceAdapterGuide, review.acceptanceAdapterGuide);
  assert.deepEqual(first.testFixtureSchema, first.acceptanceAdapterGuide!.adapters.action!.executionFacts.fixtureConstruction.schema);
  assert.equal(first.acceptanceAdapterGuide!.adapters.action!.executionFacts.dynamicPlaceholders, false);
  assert.deepEqual(first.acceptanceAdapterGuide!.adapters["input-contract"]!.executionFacts.resultContract.value, INPUT_REJECTION_RESULT);
});
