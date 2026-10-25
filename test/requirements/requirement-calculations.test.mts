import { recordArray } from "../helpers/m7-test-boundaries.mjs";
import { callFixture } from "../helpers/m7-test-boundaries.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import type { CalculationContext } from "../../src/requirements/requirement-calculations.mjs";
import type { RequirementDraft } from "../../src/contracts/requirements.mjs";
interface RawRequest { issueId: string; requirementIds: unknown; premises: { id: string; value: unknown; unit: string; source: { kind: string; reference: string; detail: string } }[]; expressions: { id: string; unit: string; formula: unknown }[]; toJSON?: () => unknown }
import { failureFields } from "../helpers/failure-fields.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { Ajv } from "ajv";
import { calculateRequirementDerivation, validateRequirementDerivations, replayRequirementDerivation, selectRequirementDerivations, calculationRequestSchema, CALCULATION_LIMITS } from "../../src/requirements/requirement-calculations.mjs";
import { createPlatformSnapshot } from "../../src/architecture/platform-contract.mjs";
import { contentHash } from "../../src/requirements/task-spec.mjs";
import { validDraft } from "../helpers/architecture.mjs";

function context(): CalculationContext & { draft: RequirementDraft; requirementIds: string[]; issues: { id: string; owner: string; question: string; requirementIds: string[]; stage?: string }[] } {
  return { draft: validDraft("汇总有界记录"), platform: createPlatformSnapshot(), requirementIds: ["task", "deliverable"],
    issues: [{ id: "capacity", owner: "system", question: "核实处理与交付边界", requirementIds: ["task", "deliverable"] }] };
}
const number = (value: string|number) => ({ value: String(value) });
const ref = (name: string) => ({ ref: name });
const op = (name: string, ...args: unknown[]) => ({ op: name, args });
function request(): RawRequest {
  return { issueId: "capacity", requirementIds: ["task", "deliverable"],
    premises: [{ id: "rows", value: "147", unit: "count", source: { kind: "requirement", reference: "task", detail: "模型提出的记录数量上界，数值是否由需求支持待复核" } },
      { id: "row_chars", value: "37", unit: "utf16_units", source: { kind: "requirement", reference: "deliverable", detail: "模型提出的每条输出字符上界，字段和编码假设待复核" } },
      { id: "overhead", value: "11", unit: "utf16_units", source: { kind: "platform", reference: "platform.runtime", detail: "模型提出的封装开销，引用存在不证明数值正确" } }],
    expressions: [{ id: "output", unit: "utf16_units", formula: op("add", op("multiply", ref("rows"), ref("row_chars")), ref("overhead")) },
      { id: "chunks", unit: "count", formula: op("ceilDiv", ref("output"), number(1000)) },
      { id: "difference", unit: "utf16_units", formula: op("subtract", op("max", ref("output"), number(6000)), ref("output")) },
      { id: "minimum", unit: "count", formula: op("min", ref("chunks"), number(2)) }] };
}

test("有限算术树精确计算并绑定需求、平台、问题和完整请求，不把前提当事实", () => {
  const input = request(), ctx = context(), before = structuredClone({ input, ctx });
  const result = calculateRequirementDerivation(input, ctx);
  assert.equal(result.status, "calculated"); assert.match(result.id, /^calculation_[a-f0-9]{32}$/);
  assert.equal(result.platformHash, contentHash(ctx.platform)); assert.equal(result.requestHash, contentHash(input));
  assert.deepEqual(result.expressions.map((item) => item.value), ["5450", "6", "550", "2"]);
  assert.match(result.scope, /前提数值、单位、完整性及适用性仍须独立复核/);
  assert.deepEqual(validateRequirementDerivations([result], ctx), [result]);
  assert.deepEqual({ input, ctx }, before);
  input.premises[0]!.value = "999";
  assert.equal(calculateRequirementDerivation(input, ctx).status, "calculated", "引用存在不代表程序认可前提数值");
});

test("大整数不经过浮点运算，除法向上取整", () => {
  const input = request(); input.expressions = [{ id: "exact", unit: "count", formula: op("add", number("9007199254740993"), number(1)) },
    { id: "rounded", unit: "count", formula: op("ceilDiv", number(7), number(3)) }];
  assert.deepEqual(calculateRequirementDerivation(input, context()).expressions.map((item) => item.value), ["9007199254740994", "3"]);
});

test("仅当前系统问题、当前需求和实际存在的受控平台引用可用于计算", () => {
  for (const change of [
    (input: { issueId: string; }) => { input.issueId = "missing"; },
    (input: { requirementIds: string[]; }) => { input.requirementIds = ["missing"]; },
    (input: { requirementIds: string[]; }) => { input.requirementIds.push("task"); },
    (input: { premises: { source: { reference: string; }; }[]; }) => { input.premises[0]!.source.reference = "missing"; },
    (input: { premises: { source: { kind: string; }; }[]; }) => { input.premises[0]!.source.kind = "user_claim"; },
    (input: { premises: { source: { reference: string; }; }[]; }) => { input.premises[2]!.source.reference = "platform.runtime.private.path"; },
    (input: { premises: { source: { reference: string; }; }[]; }) => { input.premises[2]!.source.reference = "runtime.managed.python"; },
  ]) {
    const input = request(); callFixture(change, undefined, [input]);
    assert.throws(() => calculateRequirementDerivation(input, context()), { reason: "calculation_reference_invalid" });
  }
  const ctx = context(); ctx.issues[0]!.owner = "user";
  assert.throws(() => calculateRequirementDerivation(request(), ctx), { reason: "calculation_reference_invalid" });
  const absent = context(); absent.platform = { version: 1 };
  assert.throws(() => calculateRequirementDerivation(request(), absent), { reason: "calculation_reference_invalid" });
  const schema = calculationRequestSchema(context());
  assert.deepEqual(objectFields(schema.properties.issueId).enum, ["capacity"]);
  assert.ok((objectFields(schema.properties.premises.items.properties.source.anyOf[1]!.properties.reference).enum as string[]).includes("platform.runtime"));
  const empty = calculationRequestSchema({ platform: {} });
  assert.equal(empty.properties.issueId, false); assert.equal(empty.properties.requirementIds.items, false);
  assert.equal(empty.properties.premises.items.properties.source.anyOf[1]!.properties.reference, false);
  assert.equal(objectFields(objectFields(schema.$defs.formula.anyOf[2]!.properties).args).maxItems, 2);
  const ajv = new Ajv();
  assert.doesNotThrow(() => ajv.compile(empty));
  const validate = ajv.compile(schema);
  assert.equal(validate(request()), true);
  const ternary = request(); ternary.expressions[0]!.formula = op("ceilDiv", number(1), number(2), number(3));
  assert.equal(validate(ternary), false);
});

test("计算请求不接受代码、属性访问、前向引用、额外字段或不受支持的运算", () => {
  for (const formula of ["process.exit()", { call: "eval", args: [] }, { ref: "rows.constructor" }, { ref: "later" },
    { value: "1", extra: true }, op("pow", number(2), number(3)), op("ceilDiv", number(2), number(3), number(4))]) {
    const input = request(); input.expressions[0]!.formula = formula;
    assert.throws(() => calculateRequirementDerivation(input, context()));
  }
  const input = request(); Reflect.set(input.expressions[0]!, "id", ["coerced"]);
  assert.throws(() => calculateRequirementDerivation(input, context()), { reason: "calculation_value_invalid" });
});

test("输入、节点、深度、整数位数和除零均有明确上限", () => {
  const oversized = request(); oversized.premises[0]!.source.detail = "x".repeat(CALCULATION_LIMITS.inputBytes);
  assert.throws(() => calculateRequirementDerivation(oversized, context()), { reason: "calculation_size_limit" });
  const deep = request(); let tree: unknown = number(1);
  for (let index = 0; index < 14; index++) tree = op("add", tree, number(1));
  deep.expressions[0]!.formula = tree;
  assert.throws(() => calculateRequirementDerivation(deep, context()), { reason: "calculation_complexity_limit" });
  const many = request(); many.expressions = Array.from({ length: 16 }, (_, index) => ({ id: `expr_${index}`, unit: "count", formula: op("add", ...Array.from({ length: 16 }, () => number(1))) }));
  assert.throws(() => calculateRequirementDerivation(many, context()), { reason: "calculation_complexity_limit" });
  for (const formula of [op("multiply", number("1" + "0".repeat(255)), number(10)), op("subtract", number(1), number(2))]) {
    const input = request(); input.expressions[0]!.formula = formula;
    assert.throws(() => calculateRequirementDerivation(input, context()), { reason: "calculation_integer_limit" });
  }
  const zero = request(); zero.expressions[0]!.formula = op("ceilDiv", number(1), number(0));
  assert.throws(() => calculateRequirementDerivation(zero, context()), { reason: "calculation_division_by_zero" });
  for (const value of ["01", "-1", "1.5", "Infinity", 10]) {
    const input = request(); input.premises[0]!.value = value;
    assert.throws(() => calculateRequirementDerivation(input, context()), { reason: "calculation_integer_invalid" });
  }
});

test("保存的计算必须可重算，过期绑定、改结果、改公式、改前提或未知问题都拒绝", () => {
  const ctx = context(), result = calculateRequirementDerivation(request(), ctx);
  for (const change of [
    (value: { expressions: { value: string; }[]; }) => { value.expressions[0]!.value = "1"; },
    (value: { expressions: { formula: { value: string; }; }[]; }) => { value.expressions[0]!.formula = number(1); },
    (value: { premises: { value: string; }[]; }) => { value.premises[0]!.value = "1"; },
    (value: { requestHash: string; }) => { value.requestHash = "0".repeat(64); },
    (value: { platformHash: string; }) => { value.platformHash = "0".repeat(64); },
    (value: { status: string; }) => { value.status = "verified"; },
    (value: { issueId: string; }) => { value.issueId = "missing"; },
  ]) {
    const changed = structuredClone(result); callFixture(change, undefined, [changed]);
    assert.throws(() => validateRequirementDerivations([changed], ctx));
  }
  const changed = context(); changed.draft.task.value += "新增行为";
  assert.throws(() => validateRequirementDerivations([result], changed), { reason: "calculation_binding_invalid" });
  assert.throws(() => validateRequirementDerivations([result, result], ctx), { reason: "calculation_shape_invalid" });
  const changedQuestion = context(); changedQuestion.issues[0]!.question = "同编号的另一技术问题";
  assert.deepEqual(validateRequirementDerivations([result], changedQuestion), [result], "问题重述不改算术回执；公式对当前问题是否适用须独立复核");
  const moved = context(); moved.issues[0]!.stage = "development";
  assert.deepEqual(validateRequirementDerivations([result], moved), [result], "独立审查后移阶段不改变原技术问题的计算绑定");
});

test("取消在解析和每个计算节点检查，错误只返回受控原因", () => {
  const controller = new AbortController(); controller.abort();
  assert.throws(() => calculateRequirementDerivation(request(), { ...context(), signal: controller.signal }), { name: "AbortError" });
  let checks = 0;
  const signal = { throwIfAborted() { if (++checks === 8) throw new DOMException("cancelled", "AbortError"); } };
  assert.throws(() => calculateRequirementDerivation(request(), { ...context(), signal }), { name: "AbortError" });
  const input = request(); input.premises[0]!.source.reference = "PRIVATE_CALCULATION_VALUE";
  assert.throws(() => calculateRequirementDerivation(input, context()), (error) => !failureFields(error).message!.includes("PRIVATE_CALCULATION_VALUE"));
  let executed = false;
  const custom = request(); custom.toJSON = () => { executed = true; return {}; };
  assert.throws(() => calculateRequirementDerivation(custom, context()), { reason: "calculation_shape_invalid" });
  assert.equal(executed, false);
  const accessor = request(); Object.defineProperty(accessor, "calculate", { get() { executed = true; return {}; } });
  assert.throws(() => calculateRequirementDerivation(accessor, context()), { reason: "calculation_shape_invalid" });
  assert.equal(executed, false);
});

test("新版回执按实际依赖续接，不改写历史摘要；连接事实改变只失效相关推导", () => {
  const ctx = { ...context(), verification: [{ id: "capacity", status: "verified", evidence: [
    { source: "platform", reference: "platform.runtime", detail: JSON.stringify({ type: "current_connection_framing", snapshotHash: "a".repeat(64), bytes: 574 }) },
  ] }] };
  const result = calculateRequirementDerivation(request(), ctx);
  assert.equal(result.version, 2); assert.deepEqual(replayRequirementDerivation(result), result);
  const unrelated = structuredClone(ctx); unrelated.draft.scenario.value += "改为另一个使用场景"; objectFields(objectFields(unrelated.platform).network).allowNetwork = false;
  assert.deepEqual(validateRequirementDerivations([result], unrelated), [result]);
  assert.equal(result.requirementHash, calculateRequirementDerivation(request(), ctx).requirementHash, "续接不重绑历史摘要");
  const changed = structuredClone(ctx); changed.verification[0]!.evidence[0]!.detail = JSON.stringify({ type: "current_connection_framing", snapshotHash: "b".repeat(64), bytes: 600 });
  assert.deepEqual(selectRequirementDerivations([result], changed).reusable, []);
  assert.equal(selectRequirementDerivations([result], changed).invalidated[0]!.id, result.id);
  const requirementOnly = request(); requirementOnly.premises = requirementOnly.premises.slice(0, 2);
  requirementOnly.expressions = [{ id: "total", unit: "count", formula: op("add", ref("rows"), number(1)) }];
  const independent = calculateRequirementDerivation(requirementOnly, ctx);
  assert.deepEqual(selectRequirementDerivations([independent], changed).reusable, [independent]);
  const relevant = structuredClone(ctx); relevant.draft.task.value += "需要增加处理范围";
  assert.deepEqual(selectRequirementDerivations([result], relevant).reusable, []);
  const changedLimit = structuredClone(ctx); const runtime = objectFields(objectFields(changedLimit.platform).runtime); runtime.actionInputBytes = Number(runtime.actionInputBytes) + 1;
  assert.deepEqual(selectRequirementDerivations([result], changedLimit).reusable, []);
  const damaged = structuredClone(result); damaged.expressions[0]!.value = "0";
  assert.throws(() => replayRequirementDerivation(damaged));
});

test("旧回执只保留原有兼容性，未绑定当前连接的算术不能冒充新容量证据", () => {
  const ctx = context(), original = calculateRequirementDerivation(request(), ctx), before = structuredClone(original);
  assert.equal(Object.hasOwn(original, "version"), false);
  assert.deepEqual(replayRequirementDerivation(original), original);
  const selection = selectRequirementDerivations([original], { ...ctx, verification: [{ id: "capacity", evidence: [
    { source: "platform", reference: "platform.runtime", detail: JSON.stringify({ type: "current_connection_framing", bytes: 574 }) },
  ] }] });
  assert.equal(selection.reusable.length, 0); assert.equal(selection.invalidated[0]!.reason, "calculation_legacy_unbound");
  assert.deepEqual(original, before);
});
