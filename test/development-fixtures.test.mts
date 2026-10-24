import { objectFields } from "../src/runtime/type-boundary.mjs";
import { failureFields } from "./helpers/failure-fields.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Ajv } from "ajv";
import { InputError } from "../src/requirements/core.mjs";
import { FIXTURE_LIMITS, TEST_FIXTURE_SCHEMA, TEST_FIXTURE_OPERATION_GUIDE, testJsonSchema, resolveTestJson, resolveCaseValues } from "../src/development/development-fixtures.mjs";
import type { BinaryLike } from "crypto";

const value = (item: unknown) => ({ op: "value", value: item });
const array = (...items: unknown[]) => ({ op: "array", items });
const repeat = (count: number, item: unknown) => ({ op: "repeat", count, value: item });
const index = (start = 0, step = 1, extra = {}) => ({ op: "index", start, step, ...extra });
const concat = (...items: unknown[]) => ({ op: "concat", items });
const joinText = (value: unknown, separator = "") => ({ op: "join", value, separator });
const measure = (kind: string, value: unknown) => ({ op: "measure", kind, value });
const resolve = (node: unknown, options?: Parameters<typeof resolveTestJson>[1]) => resolveTestJson({ fixture: node }, options);
const sha256 = (text: BinaryLike) => createHash("sha256").update(text).digest("hex");
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test("旧JSON文本保持原text与返回形状，不自动加入夹具回执", () => {
  const text = ' \n {"n":1,"s":"中文","items":[null,true]} \n';
  assert.deepEqual(resolveTestJson(text), { value: JSON.parse(text), text });
  assert.throws(() => resolveTestJson("not json"), InputError);
  assert.throws(() => resolveTestJson(text, { maxBytes: 2 }), InputError);
});

test("同一字段接受业务JSON文本和原生配方，字符串编码的配方外壳不被二次展开", () => {
  const validate = new Ajv({ strict: false }).compile(testJsonSchema(8192));
  const business = { records: [{ key: "ordinary", value: 7 }] }, native = { fixture: value(business) };
  for (const input of [JSON.stringify(business), native]) {
    assert.equal(validate(input), true);
    assert.deepEqual(resolveTestJson(input).value, business);
  }
  const encodedRecipe = JSON.stringify(native);
  assert.equal(validate(encodedRecipe), true);
  const resolved = resolveTestJson(encodedRecipe);
  assert.deepEqual(resolved.value, native); assert.equal(resolved.fixture, undefined);
});

test("声明式大量数据可确定生成，冻结输入不变，UTF8字节与摘要由实际结果计算", () => {
  const recipe = freeze({ fixture: repeat(2000, { op: "object", fields: {
    path: index(10, 1, { prefix: "文件-", suffix: ".txt" }), amount: index(100, 3),
    note: { op: "text", value: "中文", count: 3 },
  } }) });
  const before = JSON.stringify(recipe), first = resolveTestJson(recipe), second = resolveTestJson(recipe);
  assert.deepEqual(first, second); assert.equal(JSON.stringify(recipe), before);
  assert.ok(Array.isArray(first.value)); assert.equal(first.value.length, 2000); assert.deepEqual(first.value![0], { path: "文件-10.txt", amount: 100, note: "中文中文中文" });
  assert.deepEqual(first.value!.at(-1), { path: "文件-2009.txt", amount: 6097, note: "中文中文中文" });
  assert.equal(first.fixture!.bytes, Buffer.byteLength(first.text)); assert.equal(first.fixture!.sha256, sha256(first.text));
  assert.equal(first.fixture!.recipeHash, sha256(before)); assert.deepEqual(JSON.parse(first.text), first.value);
});

test("数组、JSON字符串及嵌套repeat使用最近索引，精确整数越界和无来源索引拒绝", () => {
  assert.deepEqual(resolve(repeat(2, repeat(3, index(1, 2)))).value, [[1, 3, 5], [1, 3, 5]]);
  assert.deepEqual(resolve(repeat(2, { op: "json", value: array(index(5, 1), value("中")) })).value, ['[5,"中"]', '[6,"中"]']);
  assert.deepEqual(resolve(repeat(2, index(-2, -3, { suffix: "" }))).value, ["-2", "-5"]);
  assert.deepEqual(resolve(repeat(3, index(Number.MAX_SAFE_INTEGER - 2))).value,
    [Number.MAX_SAFE_INTEGER - 2, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]);
  assert.throws(() => resolve(repeat(4, index(Number.MAX_SAFE_INTEGER - 2))), InputError);
  assert.throws(() => resolve(index()), InputError);
  assert.deepEqual(resolve(repeat(0, value(1))).value, []); assert.equal(resolve({ op: "text", value: "中", count: 0 }).value, "");
});

test("纯字符串组合构造有序文本，重复索引可连接且原配方和冻结回执保持", () => {
  const body = concat(value("name,value\n"), joinText(repeat(3, concat(index(1, 1, { prefix: "row-" }), value(",中文"))), "\n"), value("\n"));
  const recipe = freeze({ fixture: body }), before = JSON.stringify(recipe), result = resolveTestJson(recipe);
  const expected = "name,value\nrow-1,中文\nrow-2,中文\nrow-3,中文\n";
  assert.equal(result.value, expected); assert.equal(result.text, JSON.stringify(expected));
  assert.equal(result.fixture!.sha256, sha256(JSON.stringify(expected)), "原夹具回执继续绑定展开后的JSON文本");
  assert.equal(result.fixture!.recipeHash, sha256(before)); assert.equal(JSON.stringify(recipe), before);
  assert.deepEqual(resolveTestJson(recipe), result); assert.equal(TEST_FIXTURE_SCHEMA.description, TEST_FIXTURE_OPERATION_GUIDE);
  assert.equal(resolve(concat()).value, ""); assert.equal(resolve(joinText(array(), "unused")).value, "");
  assert.deepEqual(resolve(repeat(2, joinText(repeat(2, index(5, 1, { prefix: "x" })), "|"))).value, ["x5|x6", "x5|x6"]);
});

test("测量原字符串的UTF8字节、UTF16单元与SHA，不哈希JSON外层引号或转义", () => {
  const original = '汉😀\r\n"\t\\\0\ud800';
  assert.equal(resolve(measure("sha256", value(original))).value, sha256(original));
  assert.notEqual(sha256(original), sha256(JSON.stringify(original)));
  assert.equal(resolve(measure("utf8-bytes", value(original))).value, Buffer.byteLength(original));
  assert.equal(resolve(measure("utf16-units", value(original))).value, original.length);
  const emoji = concat(value("\ud83d"), value("\ude00"));
  assert.equal(resolve(measure("utf8-bytes", emoji)).value, 4); assert.equal(resolve(measure("utf16-units", emoji)).value, 2);
  assert.equal(resolve(measure("sha256", emoji)).value, sha256("😀"));
  const serialized = { op: "json", value: { op: "object", fields: { text: value(original), n: value(3) } } };
  assert.equal(resolve(measure("sha256", serialized)).value, sha256(JSON.stringify({ text: original, n: 3 })));
  assert.equal(resolve(measure("utf8-bytes", value(""))).value, 0);
});

test("文件替身明确表达大文本参数及测量回执，严格匹配所需值无需长串重复手写", () => {
  const content = concat(value("header\n"), joinText(repeat(4000, concat(index(0, 1, { prefix: "item-" }), value(",中文"))), "\n"), value("\n"));
  const recipe = (fixture: unknown) => ({ fixture });
  const testCase = { input: "{}", mocks: [{ capability: "files.write", argsJson: recipe({ op: "object", fields: { file: value("report.csv"), content } }),
    resultJson: recipe({ op: "object", fields: { saved: value(true), integrity: { op: "object", fields: {
      sha256: measure("sha256", content), bytes: measure("utf8-bytes", content), units: measure("utf16-units", content),
    } } } }) }], assertions: [{ path: "ok", expectedJson: "true" }] };
  const before = JSON.stringify(testCase), resolved = resolveCaseValues(testCase);
  const actual = "header\n" + Array.from({ length: 4000 }, (_, i) => `item-${i},中文`).join("\n") + "\n";
  assert.deepEqual(resolved.mocks[0]!.args, { file: "report.csv", content: actual });
  assert.deepEqual(resolved.mocks[0]!.value, { saved: true, integrity: { sha256: sha256(actual), bytes: Buffer.byteLength(actual), units: actual.length } });
  assert.ok(resolved.fixtures!.find((item) => item.field === "mocks[0].argsJson")!.bytes > 12000);
  assert.equal(JSON.stringify(testCase), before);
});

test("新组合节点的公开结构与实际类型检查一致，不进行隐式字符串转换", () => {
  const validate = new Ajv({ strict: true }).compile(TEST_FIXTURE_SCHEMA);
  for (const node of [concat(value("x")), joinText(repeat(2, value("y")), ","), ...["sha256", "utf8-bytes", "utf16-units"].map((kind) => measure(kind, value("z")))]) {
    assert.equal(validate({ fixture: node }), true); assert.doesNotThrow(() => resolve(node));
  }
  for (const node of [{ op: "concat", value: value("x") }, { op: "concat", items: "x" }, { op: "join", value: array(), separator: 0 },
    { ...measure("sha256", value("x")), unknown: true }, measure("md5", value("x"))]) {
    assert.equal(validate({ fixture: node }), false); assert.throws(() => resolve(node), (error) => failureFields(error).reason === "fixture_node_shape");
  }
  for (const node of [concat(value(7)), concat(value(["x"])), joinText(value("x"), ","), joinText(array(value("x"), value(null)), ","), measure("sha256", value({ text: "x" }))])
    assert.throws(() => resolve(node), (error) => failureFields(error).reason === "fixture_node_shape");
});

test("组合与测量继续限制中间值、配方节点深度和展开次数，不借短摘要逃逸额度", () => {
  const composed = concat(value("中文"), value("ab")), bytes = Buffer.byteLength(JSON.stringify("中文ab"));
  assert.equal(resolve(composed, { maxBytes: bytes }).fixture!.bytes, bytes);
  assert.throws(() => resolve(composed, { maxBytes: bytes - 1 }), (error) => failureFields(error).reason === "fixture_output_limit");
  const joined = joinText(array(value("a"), value("b")), "中".repeat(10));
  const joinedBytes = Buffer.byteLength(JSON.stringify("a" + "中".repeat(10) + "b"));
  assert.equal(resolve(joined, { maxBytes: joinedBytes }).fixture!.bytes, joinedBytes);
  assert.throws(() => resolve(joined, { maxBytes: joinedBytes - 1 }), (error) => failureFields(error).reason === "fixture_output_limit");
  assert.throws(() => resolve(joinText(repeat(10000, value("")), "x".repeat(4000))), (error) => failureFields(error).reason === "fixture_output_limit");
  assert.throws(() => resolve(measure("sha256", { op: "text", value: "x", count: 10000 }), { maxBytes: 5000 }), (error) => failureFields(error).reason === "fixture_output_limit");
  assert.throws(() => resolve(concat(value("x".repeat(FIXTURE_LIMITS.recipeBytes)))), (error) => failureFields(error).reason === "fixture_recipe_limit");
  const children = Array.from({ length: FIXTURE_LIMITS.nodes - 1 }, () => value("x"));
  const concatenated = resolve(concat(...children)).value; assert.ok(typeof concatenated === "string"); assert.equal(concatenated.length, children.length);
  assert.throws(() => resolve(concat(...children, value("x"))), (error) => failureFields(error).reason === "fixture_complexity_limit");
  let deep: unknown = value("x"); for (let i = 0; i < FIXTURE_LIMITS.depth; i++) deep = concat(deep);
  assert.equal(resolve(deep).value, "x"); assert.throws(() => resolve(concat(deep)), (error) => failureFields(error).reason === "fixture_complexity_limit");
  assert.throws(() => resolve(joinText(repeat(10000, concat(...Array.from({ length: 11 }, () => value("x")))))), (error) => failureFields(error).reason === "fixture_expansion_limit");
  const giant = { fixture: concat({ op: "text", value: "x".repeat(100), count: 10000 }) };
  assert.throws(() => resolveCaseValues({ input: "{}", assertions: Array.from({ length: 5 }, (_, index) => ({ path: `part${index}`, expectedJson: giant })) }),
    (error) => failureFields(error).reason === "fixture_case_output_limit");
  assert.throws(() => resolveCaseValues({ input: "{}", assertions: [{ path: "text", expectedJson: { fixture: concat(value("abc")) } }] }, { fixtureBudget: { bytes: FIXTURE_LIMITS.planBytes - 1 } }),
    (error) => failureFields(error).reason === "fixture_plan_output_limit");
});

test("短摘要不能隐藏大量原文处理，新操作共享工作字节额度且可取消", () => {
  const large = { op: "text", value: "x".repeat(100), count: 10000 };
  const hiddenWork = repeat(10000, measure("sha256", large));
  assert.throws(() => resolve(hiddenWork), (error) => failureFields(error).reason === "fixture_text_work_limit");
  const budget: { bytes: number; textBytes?: number } = { bytes: 0 }, testCase = { input: "{}", assertions: [{ path: "digest", expectedJson: { fixture: measure("sha256", large) } }] };
  for (let i = 0; i < 16; i++) assert.doesNotThrow(() => resolveCaseValues(testCase, { fixtureBudget: budget }));
  assert.equal(budget.textBytes, 16000000); assert.ok(budget.bytes < 2000, "最终摘要输出很小，工作量仍累计");
  assert.throws(() => resolveCaseValues(testCase, { fixtureBudget: budget }), (error) => failureFields(error).reason === "fixture_text_work_limit");
  let checks = 0;
  const signal = { throwIfAborted() { if (++checks === 35) throw new DOMException("cancelled", "AbortError"); } };
  assert.throws(() => resolve(hiddenWork, { signal }), { name: "AbortError" }); assert.equal(checks, 35);
  assert.doesNotThrow(() => resolve(large), "旧text配方本身不增加新操作工作计量");
});

test("输出使用UTF8而非字符数计额，达到上限可用，超限不交付部分结果", () => {
  const node = { op: "text", value: "中", count: 4 }, bytes = Buffer.byteLength(JSON.stringify("中".repeat(4)));
  assert.equal(resolve(node, { maxBytes: bytes }).fixture!.bytes, bytes);
  assert.throws(() => resolve(node, { maxBytes: bytes - 1 }), InputError);
  assert.throws(() => resolve({ op: "text", value: "中".repeat(100), count: 10000 }), InputError);
  for (const maxBytes of [0, -1, 1.5, FIXTURE_LIMITS.resultBytes + 1]) assert.throws(() => resolve(value(null), { maxBytes }), InputError);
});

test("配方大小、AST节点、深度、重复数及重复展开均有限额", () => {
  assert.throws(() => resolve(value("x".repeat(FIXTURE_LIMITS.recipeBytes))), InputError);
  const boundary = Array.from({ length: FIXTURE_LIMITS.nodes - 1 }, () => value(0));
  const expanded = resolve(array(...boundary)).value; assert.ok(Array.isArray(expanded)); assert.equal(expanded.length, boundary.length);
  assert.throws(() => resolve(array(...boundary, value(1))), InputError);
  let node: unknown = value(null);
  for (let depth = 0; depth < FIXTURE_LIMITS.depth; depth++) node = array(node);
  assert.doesNotThrow(() => resolve(node)); assert.throws(() => resolve(array(node)), InputError);
  const repeated = resolve(repeat(FIXTURE_LIMITS.repeat, value(0))).value; assert.ok(Array.isArray(repeated)); assert.equal(repeated.length, FIXTURE_LIMITS.repeat);
  for (const count of [-1, 0.5, FIXTURE_LIMITS.repeat + 1]) assert.throws(() => resolve(repeat(count, value(0))), InputError);
  assert.throws(() => resolve(repeat(1001, repeat(100, value(0)))), InputError);
});

test("只接受声明式JSON，未知操作、额外字段、原型对象、函数和取值钩子不能执行", () => {
  const validate = new Ajv({ strict: true }).compile(TEST_FIXTURE_SCHEMA);
  const recipe = { fixture: repeat(2, { op: "object", fields: { id: index(0, 1), text: value("plain") } }) };
  assert.equal(validate(recipe), true); assert.equal(validate({ fixture: { op: "execute", code: "process.exit()" } }), false);
  for (const node of [{ op: "execute", code: "process.exit()" }, { ...value(1), code: "ignored" }, { op: "index", start: "0", step: 1 },
    { op: "value", value: () => 1 }, Object.assign(Object.create({ inherited: true }), value(1))]) assert.throws(() => resolve(node), InputError);
  let invoked = 0;
  const getter = { op: "value" }; Object.defineProperty(getter, "value", { enumerable: true, get() { invoked++; return 1; } });
  const hooked = { fixture: value(1), toJSON() { invoked++; return {}; } };
  assert.throws(() => resolve(getter), InputError); assert.throws(() => resolveTestJson(hooked), InputError); assert.equal(invoked, 0);
  const data = JSON.parse('{"__proto__":{"polluted":true},"constructor":"literal data"}');
  const result = resolve(value(data)); assert.equal(Object.hasOwn(objectFields(result.value), "__proto__"), true);
  assert.equal(Object.getPrototypeOf(result.value), Object.prototype); assert.equal(objectFields({}).polluted, undefined);
});

test("取消在生成前和展开中停止，不能返回部分夹具或伪装成功", () => {
  const controller = new AbortController(); controller.abort();
  assert.throws(() => resolve(value(1), { signal: controller.signal }), { name: "AbortError" });
  let checks = 0;
  const signal = { throwIfAborted() { if (++checks === 25) throw new DOMException("cancelled", "AbortError"); } };
  assert.throws(() => resolve(repeat(1000, index()), { signal }), { name: "AbortError" }); assert.equal(checks, 25);
});
