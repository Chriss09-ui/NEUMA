import { callFixture } from "./helpers/m7-test-boundaries.mjs";
import type { DevelopmentCase } from "../src/contracts/development.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { Ajv } from "ajv";
import { LEGACY_PLAN_SCHEMA, PLAN_V2_SCHEMA, PLAN_V3_SCHEMA, validatePlan } from "../src/development/development-contract.mjs";

const empty = { type: "object", properties: {}, required: [], additionalProperties: false };
const actionCase = () => ({ id: "normal", taskId: "task", acceptanceId: "works", actionId: "run", mocks: [], input: "{}", assertions: [{ path: "", expectedJson: "{}" }] });
function setup(version: number) {
  const action = { id: "run", title: "执行", inputSchema: empty, outputSchema: empty, connectionIds: [] };
  const architecture = { requirements: [{ id: "goal" }], design: { acceptance: [{ id: "works" }] } };
  const plan = { schemaVersion: version, summary: "验证用例结构", runtime: "node-action", entrypoint: "actions.mjs",
    application: { protocolVersion: 2, runtime: "node-action", entrypoint: "actions.mjs", page: { entrypoint: "index.html", resources: [{ path: "index.html", sha256: "" }] },
      actions: [action], stateVersion: 1, evidenceIds: [] },
    tasks: [{ id: "task", title: "执行", description: "实现实际功能", requirementIds: ["goal"], acceptanceIds: ["works"], dependsOn: [], files: ["actions.mjs", "index.html", "checks/page.mjs"] }],
    cases: [actionCase()] as DevelopmentCase[] };
  return { architecture, plan };
}
const nodeCase = () => ({ id: "page", taskId: "task", acceptanceId: "works", kind: "node-check" as const, entrypoint: "checks/page.mjs", input: "", assertions: [{ path: "", expectedJson: "true" }] });
const rejectionCase = () => ({ ...actionCase(), id: "reject", kind: "input-rejection", input: '{"unexpected":true}', assertions: [{ path: "rejected", expectedJson: "true" }] });

test("v2 and v3 tool schemas and controller require the same action, node-check and rejection structure", () => {
  for (const version of [2, 3]) {
    const schema = version === 2 ? PLAN_V2_SCHEMA : PLAN_V3_SCHEMA;
    const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);
    for (const item of [actionCase(), { ...actionCase(), kind: "action" }, nodeCase(), rejectionCase()]) {
      const { architecture, plan } = setup(version); plan.cases.push(item.id === "normal" ? { ...item, id: "second" } : item);
      assert.equal(validate(plan), true, JSON.stringify(validate.errors)); assert.deepEqual(validatePlan(plan, { architecture }), plan);
    }
    for (const mutate of [
      (item: { actionId: unknown; }) => { Reflect.deleteProperty(item, "actionId"); }, (item: { mocks: unknown; }) => { Reflect.deleteProperty(item, "mocks"); }, (item: { entrypoint: string; }) => { item.entrypoint = "checks/page.mjs"; },
      (item: { entrypoint: unknown; }) => { Object.assign(item, nodeCase()); Reflect.deleteProperty(item, "entrypoint"); },
      (item: object) => { Object.assign(item, nodeCase()); },
      (item: { mocks: { capability: string; argsJson: string; resultJson: string; }[]; }) => { Object.assign(item, rejectionCase()); item.mocks = [{ capability: "files.read", argsJson: "{}", resultJson: "{}" }]; },
      (item: { actionId: unknown; }) => { Object.assign(item, rejectionCase()); Reflect.deleteProperty(item, "actionId"); },
      (item: { mocks: unknown; }) => { Object.assign(item, rejectionCase()); Reflect.deleteProperty(item, "mocks"); },
      ...(version === 3 ? [(item: { workflowInputs: { stepId: string; inputJson: string; }[]; }) => { Object.assign(item, rejectionCase()); item.workflowInputs = [{ stepId: "wait", inputJson: "true" }]; }] : []),
    ]) {
      const { architecture, plan } = setup(version); callFixture(mutate, undefined, [plan.cases[0]!]);
      assert.equal(validate(plan), false, "SDK结构必须提前拒绝，不能仅靠控制器发现");
      assert.throws(() => validatePlan(plan, { architecture }));
    }
  }
});

test("node-check explicitly requires its kind and text input/expectations; absent kind remains a normal action", () => {
  const validate = new Ajv({ strict: false }).compile(PLAN_V3_SCHEMA.properties.cases.items);
  assert.equal(validate(actionCase()), true);
  assert.equal(validate({ ...rejectionCase(), workflowInputs: [] }), true, "空回复列表仍须由既有语义检查核对冻结流程");
  for (const mutate of [
    (item: { kind: unknown; }) => { Reflect.deleteProperty(item, "kind"); }, (item: { entrypoint: unknown; }) => { Reflect.deleteProperty(item, "entrypoint"); },
    (item: { actionId: string; }) => { item.actionId = "run"; }, (item: { mocks: never[]; }) => { item.mocks = []; },
    (item: { input: { fixture: { op: string; value: {}; }; }; }) => { item.input = { fixture: { op: "value", value: {} } }; },
    (item: { assertions: { expectedJson: { fixture: { op: string; value: boolean; }; }; }[]; }) => { item.assertions![0]!.expectedJson = { fixture: { op: "value", value: true } }; },
  ]) { const item = nodeCase(); callFixture(mutate, undefined, [item]); assert.equal(validate(item), false); }
  const legacy = new Ajv({ strict: false }).compile(LEGACY_PLAN_SCHEMA.properties.cases.items);
  const item = { id: "legacy", taskId: "task", acceptanceId: "works", input: "plain text is still valid", assertions: [{ path: "", expectedJson: "true" }] };
  assert.equal(legacy(item), true);
  assert.equal(legacy({ ...item, kind: "action", mocks: [], actionId: "run" }), false);
});
