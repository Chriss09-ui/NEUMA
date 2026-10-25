import type { ToolSchema } from "../../src/contracts/tools.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { toolInputValidation } from "../../src/runtime/tool-input-diagnostics.mjs";

test("同源严格参数诊断给出字段、应填与实际类型、枚举和边界，不转换参数或回显值", () => {
  const schema = { type: "object", additionalProperties: false, required: ["path", "items"], properties: {
    path: { type: "string" }, items: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["op", "index", "enabled"], properties: { op: { type: "string", enum: ["add", "replace", "remove", "move"] },
        index: { type: "integer", minimum: 0, maximum: 199 }, enabled: { type: "boolean" } } } },
  } };
  const value = { path: 7, items: [{ op: "PRIVATE_VALUE", index: 200, PRIVATE_DYNAMIC_FIELD: "PRIVATE_VALUE" }] }, before = structuredClone(value);
  const result = toolInputValidation(value, schema, { root: "edit_plan_cases" }); assert.ok(!result.valid);
  const entry = (path: string) => result.issues.find(issue => issue.path === path);
  assert.equal(result.valid, false);
  assert.equal(entry!("edit_plan_cases.path")!.expectedType, "string"); assert.equal(entry!("edit_plan_cases.path")!.receivedType, "number");
  assert.deepEqual(entry!("edit_plan_cases.items[0].op")!.allowedValues, ["add", "replace", "remove", "move"]);
  assert.deepEqual(entry!("edit_plan_cases.items[0].index")!.constraints, { maximum: 199 });
  assert.equal(entry!("edit_plan_cases.items[0].enabled")!.receivedType, "missing");
  assert.equal(entry!("edit_plan_cases.items[0].enabled")!.expectedType, "boolean");
  assert.deepEqual(entry!("edit_plan_cases.items[0]")!.allowedFields, ["op", "index", "enabled"]);
  assert.equal(result.total, result.issues.length); assert.equal(result.truncated, false);
  assert.deepEqual(value, before); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/u);
});

test("联合写法只反馈当前完整形状内的嵌套错误；缺半个摘录不能变成整字段写法", () => {
  const whole: ToolSchema & { properties: Record<string, ToolSchema>; required: string[] } = { type: "object", required: ["source", "path"], properties: { source: { type: "string" }, path: { type: "string" } }, additionalProperties: false };
  const excerpt = structuredClone(whole); excerpt.required.push("offset", "length");
  excerpt.properties.offset = { type: "integer", minimum: 0 }; excerpt.properties.length = { type: "integer", minimum: 1 };
  const detailed = { type: "object", required: ["source", "path", "quote"], properties: {
    source: { type: "string" }, path: { type: "string" }, quote: { type: "string" }, reason: { type: "string" },
  }, additionalProperties: false };
  const compact = { type: "object", required: ["claimRef", "reason"], properties: { claimRef: { anyOf: [whole, excerpt] }, reason: { type: "string" } }, additionalProperties: false };
  const schema = { type: "object", properties: { restrictions: { type: "array", items: { anyOf: [detailed, compact] } } }, required: ["restrictions"] };
  for (const [reference, expectedReason, receivedType] of [[{ source: "candidate", path: "/x", offset: "0", length: 3 }, "type", "string"],
    [{ source: "candidate", path: "/x", length: 3 }, "required", "missing"]]) {
    const result = toolInputValidation({ restrictions: [{ claimRef: reference, reason: "PRIVATE_TEXT" }] }, schema, { root: "fidelity" }); assert.ok(!result.valid);
    assert.equal(result.total, 1); assert.equal(result.issues![0]!.path, "fidelity.restrictions[0].claimRef.offset");
    assert.equal(result.issues![0]!.reason, expectedReason); assert.equal(result.issues![0]!.expectedType, "integer");
    assert.equal(result.issues![0]!.receivedType, receivedType); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TEXT/u);
  }
});

test("无法唯一选择的联合写法给出替代结构，不把两个分支的必填字段合并", () => {
  const schema = { type: "object", properties: { value: { anyOf: [
    { type: "object", properties: { left: { type: "string" } }, required: ["left"], additionalProperties: false },
    { type: "object", properties: { right: { type: "string" } }, required: ["right"], additionalProperties: false },
  ] } }, required: ["value"] };
  const result = toolInputValidation({ value: {} }, schema); assert.ok(!result.valid);
  assert.equal(result.total, 1); assert.equal(result.issues![0]!.path, "root.value"); assert.equal(result.issues![0]!.reason, "anyOf");
  assert.deepEqual(result.issues![0]!.alternatives!.map(option => option.requiredFields), [["left"], ["right"]]);
  assert.equal(result.issues![0]!.alternativesTruncated, false);
});

test("数组内复用同一联合schema时，各项独立选分支，不能相互删除或污染错误", () => {
  const branch = (kind: string, field: string, type: string) => ({ type: "object", properties: { kind: { const: kind }, [field]: { type } },
    required: ["kind", field], additionalProperties: false });
  const schema = { type: "array", items: { anyOf: [branch("A", "value", "integer"), branch("B", "text", "string")] } };
  const result = toolInputValidation([{ kind: "A", value: false }, { kind: "B", text: false }, { kind: "B", text: false }], schema); assert.ok(!result.valid);
  assert.equal(result.total, 3);
  assert.deepEqual(result.issues.map(({ path, expectedType }) => ({ path, expectedType })), [
    { path: "root[0].value", expectedType: "integer" }, { path: "root[1].text", expectedType: "string" },
    { path: "root[2].text", expectedType: "string" },
  ]);
});

test("没有匹配的鉴别字段时，替代结构列出各分支的固定值与对应字段类型", () => {
  const branch = (kind: string, type: string) => ({ type: "object", properties: { kind: { const: kind }, value: { type } },
    required: ["kind", "value"], additionalProperties: false });
  const result = toolInputValidation({ kind: "PRIVATE_KIND", value: false }, { anyOf: [branch("A", "integer"), branch("B", "string")] }); assert.ok(!result.valid);
  const alternatives = result.issues![0]!.alternatives;
  assert.deepEqual(alternatives!.map!(option => option.fields), [
    [{ field: "kind", allowedValues: ["A"] }, { field: "value", expectedType: "integer" }],
    [{ field: "kind", allowedValues: ["B"] }, { field: "value", expectedType: "string" }],
  ]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_KIND/u);
});

test("枚举鉴别字段与固定值同样选择当前写法，不能用另一写法掩盖缺失字段", () => {
  const schema = { anyOf: [
    { type: "object", properties: { kind: { enum: ["A"] }, value: { type: "object", properties: { first: { type: "string" }, second: { type: "string" } }, required: ["first", "second"] } }, required: ["kind", "value"] },
    { type: "object", properties: { kind: { enum: ["B"] }, value: { type: "object" } }, required: ["kind", "value"] },
  ] };
  const result = toolInputValidation({ kind: "A", value: {} }, schema); assert.ok(!result.valid);
  assert.deepEqual(result.issues.map(({ path, reason }) => ({ path, reason })), [
    { path: "root.value.first", reason: "required" }, { path: "root.value.second", reason: "required" },
  ]);
});

test("额外字段数量不能改变已匹配的鉴别值", () => {
  const properties = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`extra_${index}`, { type: "string" }]));
  const branch = (kind: string, extra: { [x: string]: { type: string; }; }) => ({ type: "object", properties: { kind: { const: kind }, value: { type: "integer" }, ...extra },
    required: ["kind", "value"], additionalProperties: false });
  const result = toolInputValidation({ kind: "A", value: 3, ...Object.fromEntries(Object.keys(properties).map(field => [field, "PRIVATE_VALUE"])) },
    { anyOf: [branch("A", {}), branch("B", properties)] }); assert.ok(!result.valid);
  assert.equal(result.total, 1); assert.equal(result.issues![0]!.reason, "additionalProperties");
  assert.deepEqual(result.issues![0]!.allowedFields, ["kind", "value"]);
});

test("数量限制明确保留真实问题总数；重复诊断与未知动态名字不会扩大反馈", () => {
  const schema = { type: "object", properties: { rows: { type: "array", items: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] } } } };
  const value = { rows: Array.from({ length: 17 }, () => ({ count: "PRIVATE_STRING" })) };
  const result = toolInputValidation(value, schema, { limit: 3 }); assert.ok(!result.valid);
  assert.equal(result.total, 17); assert.equal(result.retained, 3); assert.equal(result.truncated, true);
  assert.equal(result.issues!.at(-1)!.path, "root.rows[2].count"); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_STRING/u);
  assert.deepEqual(toolInputValidation({ rows: [{ count: 2 }] }, schema), { valid: true, issues: [] });
});

test("大量长声明字段仍保留具体反馈及省略计数，不触发底层16k泛化回退", () => {
  const properties = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`field_${index}_` + "x".repeat(60), { type: "string" }]));
  const schema = { type: "array", items: { type: "object", properties, required: Object.keys(properties), additionalProperties: false } };
  const item = { ...Object.fromEntries(Object.keys(properties).map(field => [field, "PRIVATE_VALUE"])), PRIVATE_KEY: "PRIVATE_VALUE" };
  const result = toolInputValidation(Array.from({ length: 12 }, () => item), schema); assert.ok(!result.valid);
  assert.equal(result.total, 12); assert.ok(result.retained > 0); assert.equal(result.truncated, true);
  assert.ok(JSON.stringify(result).length < 14000); assert.equal(result.issues![0]!.reason, "additionalProperties");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/u);
});

test("单条深层替代结构提示也必须有界并保留第一项问题", () => {
  const names = Array.from({ length: 32 }, (_, index) => `field_${index}_` + "x".repeat(60));
  const inner = { type: "object", properties: Object.fromEntries(names.map(field => [field, { type: "string" }])), required: names, additionalProperties: false };
  const branch = { type: "object", properties: Object.fromEntries(names.map(field => [field, inner])), required: names, additionalProperties: false };
  const result = toolInputValidation(false, { anyOf: Array.from({ length: 4 }, () => branch) }); assert.ok(!result.valid);
  assert.equal(result.total, 1); assert.equal(result.retained, 1); assert.equal(result.issues![0]!.path, "root");
  assert.ok(result.issues![0]!.alternatives!.every(alternative => alternative.fieldsTruncated));
  assert.ok(JSON.stringify(result).length < 14000);
});
