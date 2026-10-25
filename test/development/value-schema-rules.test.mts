import { callFixture } from "../helpers/m7-test-boundaries.mjs";
import type { ValueSchema } from "../../src/contracts/application.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { VALUE_SCHEMA_RULES, VALUE_SCHEMA_DESCRIPTION, validateValueSchema, validateActionInput, validateApplicationManifest } from "../../src/applications/application-contract.mjs";
import { SERVICE_MANIFEST_SCHEMA, SERVICE_DEFAULTS, validateServiceManifest, hashServiceManifest, serviceHash } from "../../src/services/service-contract.mjs";
import { PLAN_V2_SCHEMA, PLAN_V3_SCHEMA, LEGACY_PLAN_SCHEMA, validatePlan, hashValue } from "../../src/development/development-contract.mjs";
import { DevelopmentController } from "../../src/development/development.mjs";
import { DEVELOPMENT_REJECTION_EXAMPLE } from "../../src/development/development-prompts.mjs";

const object = (properties: { total?: { type: string; }; records?: {}; text?: { type: string; minLength: number; maxLength: number; }; }) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const schema = () => structuredClone(DEVELOPMENT_REJECTION_EXAMPLE.inputSchema);
const operation = () => ({ id: "process", title: "处理整数", inputSchema: schema(), outputSchema: object({ total: { type: "integer" } }), connectionIds: [] });
function fixture() {
  const cases = structuredClone(DEVELOPMENT_REJECTION_EXAMPLE.cases), action = operation();
  const architecture = { requirements: [{ id: "goal" }], design: { acceptance: cases.map((item) => ({ id: item.acceptanceId })) } };
  const plan = { schemaVersion: 2, summary: "区分输入结构和业务拒绝", runtime: "node-action", entrypoint: "actions.mjs",
    application: { protocolVersion: 2, runtime: "node-action", entrypoint: "actions.mjs", page: null, actions: [action], stateVersion: 1, evidenceIds: [] },
    tasks: [{ id: "validate", title: "校验", description: "执行正常与业务负例，保留输入拒绝证明", requirementIds: ["goal"],
      acceptanceIds: cases.map((item) => item.acceptanceId), dependsOn: [], files: ["actions.mjs"] }], cases };
  return { architecture, plan };
}

test("工具字段和新版研发公共上下文共享同一说明，保留自由对象和旧协议结构", () => {
  for (const parent of [PLAN_V2_SCHEMA.properties.application.properties.actions.items, PLAN_V3_SCHEMA.properties.application.properties.actions.items,
    SERVICE_MANIFEST_SCHEMA.properties!.operations!.items]) for (const key of ["inputSchema", "outputSchema"]) {
    const definition = parent!.properties![key];
    assert.equal(definition!.type!, "object"); assert.equal(definition!.additionalProperties!, true);
    assert.equal(definition!.description!, VALUE_SCHEMA_DESCRIPTION);
    assert.equal(Object.hasOwn(definition!, "$defs"), false);
  }
  for (const version of [1, 2, 3]) {
    const base = callFixture(DevelopmentController.prototype.base, {}, [{ record: { architecture: { design: version === 1 ? {} : { schemaVersion: version } }, handoffs: [], budgets: {} } }]);
    if (version === 1) assert.equal(Object.hasOwn(objectFields(base), "valueSchemaGuide"), false);
    else assert.equal(objectFields(base).valueSchemaGuide, VALUE_SCHEMA_DESCRIPTION);
  }
  assert.equal(LEGACY_PLAN_SCHEMA.properties.cases.items.properties.input.type, "string");
  assert.equal(Object.hasOwn(LEGACY_PLAN_SCHEMA.properties.cases.items.properties.input, "description"), false);
  assert.throws(() => { VALUE_SCHEMA_RULES.types.push("unsupported"); }, TypeError);
});

test("共享规则保持现有类型、关键词、适用规则和边界，没有增加JSON Schema功能", () => {
  const accepted = [object({}), { type: "array", items: { type: "string" } }, { type: "string" }, { type: "number" }, { type: "integer" }, { type: "boolean" }, { type: "null" }];
  assert.deepEqual(accepted.map((value) => value.type), VALUE_SCHEMA_RULES.types);
  for (const value of accepted) assert.equal(validateValueSchema(value), value);
  for (const key of ["$ref", "anyOf", "oneOf", "allOf", "pattern", "default", "nullable", "format", "const", "uniqueItems"]) {
    assert.equal(VALUE_SCHEMA_RULES.keywords.includes(key), false);
    assert.throws(() => validateValueSchema({ type: "string", [key]: "unused" }));
  }
  for (const value of [{ type: "string", minimum: 0 }, { type: "integer", minLength: 0 }, { type: "array" },
    { type: "object", properties: {}, required: [], additionalProperties: true }, { type: "string", minLength: 2, maxLength: 1 },
    { type: "string", maxLength: VALUE_SCHEMA_RULES.limits.lengthOrCount + 1 }, { type: "integer", enum: [1.5] },
    { type: "string", enum: Array.from({ length: VALUE_SCHEMA_RULES.limits.enumItems + 1 }, (_, index) => String(index)) }]) assert.throws(() => validateValueSchema(value));
  let nested: ValueSchema = { type: "string" }; for (let index = 0; index <= VALUE_SCHEMA_RULES.limits.depth; index++) nested = { type: "array", items: nested };
  assert.throws(() => validateValueSchema(nested));
  assert.doesNotThrow(() => validateValueSchema({ type: "string", maxLength: VALUE_SCHEMA_RULES.limits.lengthOrCount }));
});

test("成对范例走同一真实输入校验；业务位置断言与已冻结case不能被替换", () => {
  const { architecture, plan } = fixture();
  assert.deepEqual(validatePlan(plan, { architecture }), plan);
  const action = plan.application.actions[0];
  assert.doesNotThrow(() => validateActionInput(action!, JSON.parse(String(plan.cases![0]!.input))));
  assert.throws(() => callFixture(validateActionInput, undefined, [action, JSON.parse(String(plan.cases![1]!.input))]));
  assert.doesNotThrow(() => validateActionInput(action!, JSON.parse(String(plan.cases![2]!.input))));
  assert.deepEqual(plan.cases![2]!.assertions, [{ path: "error.code", expectedJson: '"duplicate_item"' }, { path: "error.index", expectedJson: "1" }]);
  const weakened = structuredClone(plan); weakened.cases![2]!.assertions.pop();
  assert.throws(() => callFixture(validatePlan, undefined, [weakened, { architecture, previousPlan: plan }]), /不能删除或放宽/);
  const converted = structuredClone(plan); converted.cases[2] = { ...converted.cases[1]!, id: converted.cases![2]!.id, acceptanceId: converted.cases![2]!.acceptanceId };
  assert.throws(() => callFixture(validatePlan, undefined, [converted, { architecture, previousPlan: plan }]), /不能删除或替换/);
});

test("工具说明不写入用户输入输出schema或交付清单，现有摘要与服务规范化不变", () => {
  const { architecture, plan } = fixture(), before = structuredClone(plan), hash = hashValue(plan);
  validateValueSchema(plan.application!.actions[0]!.inputSchema);
  validateApplicationManifest(plan.application, { allowUnverified: true }); validatePlan(plan, { architecture });
  assert.deepEqual(plan, before); assert.equal(hashValue(plan), hash);
  assert.equal(JSON.stringify(plan).includes(VALUE_SCHEMA_DESCRIPTION), false);
  const manifest = { schemaVersion: 1, language: "javascript", host: "managed", entrypoint: "actions.mjs", operations: [operation()],
    capabilities: [], dependencies: { packages: [] }, resources: { ...SERVICE_DEFAULTS }, dataVersion: 1 };
  const normalized = validateServiceManifest(manifest);
  const expected = { schemaVersion: 1, language: "javascript", host: "managed", entrypoint: "actions.mjs", operations: manifest.operations,
    dependencies: { packages: [] }, resources: { ...SERVICE_DEFAULTS }, capabilities: [], dataVersion: 1 };
  assert.deepEqual(normalized, expected); assert.equal(hashServiceManifest(manifest), serviceHash(expected));
  assert.equal(JSON.stringify(normalized).includes(VALUE_SCHEMA_DESCRIPTION), false);
  assert.equal(Object.hasOwn(normalized.operations![0]!.inputSchema, "description"), false);
});


test("嵌套原生JSON保留业务坏值与原始键，同时受深度节点和JSON类型约束", () => {
  const action = { inputSchema: object({ records: {} }) };
  const value = { records: [{ value: true, extra: null }, "invalid record", JSON.parse(String('{"__proto__":{"value":1}}'))] };
  assert.deepEqual(validateActionInput(action, value), value);
  assert.equal(Reflect.get({}, "value"), undefined);
  assert.throws(() => validateValueSchema({}));
  assert.throws(() => validateValueSchema({ type: "array", items: { description: "not empty" } }));
  let getterCalled = false;
  const accessor = Object.defineProperty({}, "value", { enumerable: true, get() { getterCalled = true; return "invalid"; } });
  const cycle = {}; Reflect.set(cycle, "child", cycle);
  const sparse: string|unknown[] = []; sparse.length = 2;
  const hidden = Object.defineProperty({}, "hidden", { value: 1 });
  const symbol = { [Symbol("data")]: 1 };
  let deep = null; for (let i = 0; i < 34; i++) deep = [deep];
  for (const records of [undefined, NaN, Infinity, 1n, () => {}, accessor, cycle, sparse, hidden, symbol, deep, new Date(), Array(100001).fill(0)])
    assert.throws(() => validateActionInput(action, { records }));
  assert.equal(getterCalled, false);
  assert.throws(() => validateActionInput(action, { records: "x".repeat(1024 * 1024) }), /通道限制/);
});

test("字符串长度按Unicode码点而非文件UTF16计数，数据NUL保持JSON原形", () => {
  const action = { inputSchema: object({ text: { type: "string", minLength: 2, maxLength: 2 } }) };
  assert.deepEqual(validateActionInput(action, { text: "😀中" }), { text: "😀中" });
  assert.throws(() => validateActionInput(action, { text: "😀" }));
  assert.throws(() => validateActionInput(action, { text: "😀中a" }));
  assert.deepEqual(validateActionInput(action, { text: "\0a" }), { text: "\0a" });
});
