import type { JsonValue, UnknownRecord } from "../contracts/json.mjs";
import type { ApplicationAction } from "../contracts/application.mjs";
import type { ToolSchema } from "../contracts/tools.mjs";
import type { FixtureNode, FixtureBudget, ResolvedTestJson, DevelopmentCase, DevelopmentPlan, FixtureMetadata } from "../contracts/development.mjs";
import { isPlainRecord, isInteger, objectFields } from "../runtime/type-boundary.mjs";
interface FixtureOptions { maxBytes?: number | undefined; signal?: Pick<AbortSignal, "throwIfAborted"> | undefined; textWorkBudget?: FixtureBudget | undefined }
interface CaseOptions { maxInputBytes?: number | undefined; signal?: Pick<AbortSignal, "throwIfAborted"> | undefined; textWorkBudget?: FixtureBudget | undefined; fixtureBudget?: FixtureBudget | undefined }
import { createHash } from "node:crypto";
import { InputError } from "../requirements/core.mjs";
import { validateActionInput } from "../applications/application-contract.mjs";
import { validateApplicationTaskEnvelope } from "../applications/task-input-contract.mjs";
import { APPLICATION_TASK_INPUT_BYTES, APPLICATION_ACTION_VALUE_BYTES } from "../runtime/runtime-capability-contract.mjs";
import { assertCaseMaterials } from "./development-test-material-audit.mjs";

export const FIXTURE_LIMITS = Object.freeze({ recipeBytes: 12000, nodes: 256, depth: 12, expandedNodes: 100000, repeat: 10000,
  resultBytes: 1024 * 1024, rejectionInputBytes: 1024 * 1024 + 64 * 1024,
  caseBytes: 4 * 1024 * 1024, planBytes: 16 * 1024 * 1024 });
function fail(reason: string): never { throw Object.assign(new InputError(`测试夹具无效：${reason}`), { reason: `fixture_${reason}` }); }
const plain = isPlainRecord;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const object = <P extends Record<string, ToolSchema>>(properties: P, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const node = { $ref: "#/$defs/node" }, json = { $ref: "#/$defs/json" };
const count = { type: "integer", minimum: 0, maximum: FIXTURE_LIMITS.repeat }, integer = { type: "integer", minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER };
const measurementKinds = ["sha256", "utf8-bytes", "utf16-units"];
export const TEST_FIXTURE_OPERATION_GUIDE = "夹具节点支持value常量、object.fields、array.items、repeat(count,value)、index(start,step,prefix?,suffix?)、text(value,count)、json(value)。concat:{op:'concat',items:[字符串节点,...]}按序拼接；join:{op:'join',value:生成字符串数组的节点,separator:字符串}连接数组，不隐式转换数字；measure:{op:'measure',kind:'sha256'|'utf8-bytes'|'utf16-units',value:字符串节点}测量原字符串，分别返回UTF-8原字节SHA-256小写十六进制、UTF-8字节数或UTF-16单元数，不含JSON外层引号及转义。json将子节点的值编码成JSON字符串；repeat中的index使用最近一层索引。所有中间值和最终值继续受原配方、节点、深度、展开及输出额度约束。新操作累计合成或测量的原文UTF-8字节另受16MiB工作额度约束，计划校验与执行共享整组账本，单独展开时限本配方。它们只构造明确数据，不执行代码、不根据业务输入自动计算正确答案，不支持动态占位符。";
export const TEST_FIXTURE_SCHEMA = { ...object({ fixture: node }), description: TEST_FIXTURE_OPERATION_GUIDE, $defs: {
  json: { anyOf: [{ type: "null" }, { type: "string" }, { type: "number" }, { type: "boolean" }, { type: "array", items: json }, { type: "object", additionalProperties: json }] },
  node: { anyOf: [object({ op: { const: "value" }, value: json }), object({ op: { const: "object" }, fields: { type: "object", additionalProperties: node } }),
    object({ op: { const: "array" }, items: { type: "array", items: node } }), object({ op: { const: "repeat" }, count, value: node }),
    object({ op: { const: "index" }, start: integer, step: integer, prefix: { type: "string" }, suffix: { type: "string" } }, ["op", "start", "step"]),
    object({ op: { const: "text" }, value: { type: "string" }, count }), object({ op: { const: "json" }, value: node }),
    object({ op: { const: "concat" }, items: { type: "array", items: node } }),
    object({ op: { const: "join" }, value: node, separator: { type: "string" } }),
    object({ op: { const: "measure" }, kind: { type: "string", enum: measurementKinds }, value: node })] },
} };

export const TEST_JSON_VALUE_GUIDE = "选择一种编码：实际业务值的JSON文本（字符串只解析一次），或原生{fixture:节点}对象。fixture配方外壳不能再次编码成字符串；节点内json操作只用于生成业务字段所需的JSON文本。";
export const testJsonSchema = (maxLength: number) => ({ description: TEST_JSON_VALUE_GUIDE,
  anyOf: [{ type: "string", minLength: 0, maxLength, description: "实际业务值的JSON文本，只解析一次；不是字符串编码的fixture配方外壳。" },
    { ...object({ fixture: { type: "object", properties: {}, required: [], additionalProperties: true } }),
      description: "原生JSON对象形式的声明式配方，结构为{fixture:节点}；不要对这个外壳调用JSON.stringify。" }] });

function jsonData(value: unknown, depth = 0): asserts value is JsonValue {
  if (depth > 32) fail("depth_limit");
  if (value === null || ["string", "boolean"].includes(typeof value) || typeof value === "number" && Number.isFinite(value)) return;
  if (!plain(value) && !Array.isArray(value)) fail("json_required");
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || key === "toJSON" || !descriptor || !Object.hasOwn(descriptor, "value")) fail("json_required");
    jsonData(descriptor.value, depth + 1);
  }
}
function fields(value: unknown, required: string[], optional: string[] = []): asserts value is UnknownRecord {
  if (!plain(value) || required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => ![...required, ...optional].includes(key))) fail("node_shape");
}

export function resolveTestJson(input: unknown, options: FixtureOptions = {}) { return resolveFixtureJson(input, options); }

function resolveFixtureJson(input: unknown, { maxBytes = FIXTURE_LIMITS.resultBytes, signal, textWorkBudget = {} }: FixtureOptions = {}, maxAllowedBytes = FIXTURE_LIMITS.resultBytes): ResolvedTestJson {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > maxAllowedBytes) fail("output_limit");
  if (typeof input === "string") {
    if (Buffer.byteLength(input) > maxBytes) fail("output_limit");
    try { return { value: JSON.parse(input), text: input }; } catch { fail("json_required"); }
  }
  jsonData(input); fields(input, ["fixture"]);
  const recipe = JSON.stringify(input);
  if (Buffer.byteLength(recipe) > FIXTURE_LIMITS.recipeBytes) fail("recipe_limit");
  let nodes = 0;
  const inspect: (value: unknown, depth?: number) => asserts value is FixtureNode = (value, depth = 0) => {
    signal?.throwIfAborted();
    if (++nodes > FIXTURE_LIMITS.nodes || depth > FIXTURE_LIMITS.depth) fail("complexity_limit");
    if (!plain(value)) fail("node_shape");
    if (value.op === "value") fields(value, ["op", "value"]);
    else if (value.op === "object") {
      fields(value, ["op", "fields"]); if (!plain(value.fields) || Object.keys(value.fields).length > 100) fail("node_shape");
      Object.values(value.fields).forEach((child) => inspect(child, depth + 1));
    } else if (value.op === "array") {
      fields(value, ["op", "items"]); if (!Array.isArray(value.items)) fail("node_shape");
      value.items.forEach((child) => inspect(child, depth + 1));
    } else if ((value.op === "repeat" || value.op === "text")) {
      fields(value, ["op", "value", "count"]);
      if (!isInteger(value.count) || value.count < 0 || value.count > FIXTURE_LIMITS.repeat) fail("repeat_limit");
      if (value.op === "repeat") inspect(value.value, depth + 1);
      else if (typeof value.value !== "string") fail("node_shape");
    } else if (value.op === "index") {
      fields(value, ["op", "start", "step"], ["prefix", "suffix"]);
      if (!isInteger(value.start) || !isInteger(value.step)
        || ["prefix", "suffix"].some((key) => value[key] !== undefined && typeof value[key] !== "string")) fail("node_shape");
    } else if (value.op === "concat") {
      fields(value, ["op", "items"]); if (!Array.isArray(value.items)) fail("node_shape");
      value.items.forEach((child) => inspect(child, depth + 1));
    } else if (value.op === "join") {
      fields(value, ["op", "value", "separator"]); if (typeof value.separator !== "string") fail("node_shape");
      inspect(value.value, depth + 1);
    } else if (value.op === "measure") {
      fields(value, ["op", "kind", "value"]); if (typeof value.kind !== "string" || !measurementKinds.includes(value.kind)) fail("node_shape");
      inspect(value.value, depth + 1);
    } else if (value.op === "json") { fields(value, ["op", "value"]); inspect(value.value, depth + 1); }
    else fail("unknown_operation");
  };
  inspect(input.fixture);
  let expanded = 0;
  const finish = (value: JsonValue) => {
    const text = JSON.stringify(value), bytes = Buffer.byteLength(text);
    if (bytes > maxBytes) fail("output_limit");
    return { value, text, bytes };
  };
  const chargeTextWork = (text: string) => {
    signal?.throwIfAborted();
    const spent = textWorkBudget.textBytes ?? 0, bytes = Buffer.byteLength(text);
    if (!Number.isSafeInteger(spent) || spent < 0 || spent + bytes > FIXTURE_LIMITS.planBytes) fail("text_work_limit");
    textWorkBudget.textBytes = spent + bytes;
  };
  const joinText = (parts: JsonValue[], separator: string) => {
    let units = Math.max(0, parts.length - 1) * separator.length;
    for (const part of parts) {
      signal?.throwIfAborted();
      if (typeof part !== "string") fail("node_shape");
      units += part.length;
      // JSON string bytes cannot be fewer than its UTF-16 units plus two quotes.
      // Check before allocation, then use finish for exact UTF-8 and escaping costs.
      if (units + 2 > maxBytes) fail("output_limit");
    }
    const result = parts.join(separator); chargeTextWork(result);
    return finish(result);
  };
  const expand = (value: FixtureNode, index?: number): { value: JsonValue; text: string; bytes: number } => {
    signal?.throwIfAborted(); if (++expanded > FIXTURE_LIMITS.expandedNodes) fail("expansion_limit");
    if (value.op === "value") return finish(structuredClone(value.value));
    if (value.op === "text") {
      if (Buffer.byteLength(value.value) * value.count > maxBytes) fail("output_limit");
      return finish(value.value.repeat(value.count));
    }
    if (value.op === "index") {
      if (index === undefined) fail("index_scope");
      const exact = BigInt(value.start) + BigInt(index) * BigInt(value.step);
      if (exact < BigInt(Number.MIN_SAFE_INTEGER) || exact > BigInt(Number.MAX_SAFE_INTEGER)) fail("index_limit");
      const result = Number(exact);
      return finish(value.prefix !== undefined || value.suffix !== undefined ? `${value.prefix ?? ""}${result}${value.suffix ?? ""}` : result);
    }
    if (value.op === "json") return finish(expand(value.value, index).text);
    if (value.op === "concat") {
      const parts = []; let units = 0;
      for (const child of value.items) {
        const part = expand(child, index).value;
        if (typeof part !== "string") fail("node_shape");
        units += part.length; if (units + 2 > maxBytes) fail("output_limit");
        parts.push(part);
      }
      return joinText(parts, "");
    }
    if (value.op === "join") {
      const parts = expand(value.value, index).value;
      if (!Array.isArray(parts)) fail("node_shape");
      return joinText(parts, value.separator);
    }
    if (value.op === "measure") {
      const text = expand(value.value, index).value;
      if (typeof text !== "string") fail("node_shape");
      chargeTextWork(text);
      return finish(value.kind === "sha256" ? hash(text) : value.kind === "utf8-bytes" ? Buffer.byteLength(text) : text.length);
    }
    const entries: JsonValue[] = [], objectEntries: [string | number, JsonValue][] = [], array = value.op !== "object";
    const source: [string | number, FixtureNode][] = value.op === "object" ? Object.entries(value.fields) : value.op === "array" ? value.items.map((item, i) => [i, item])
      : Array.from({ length: value.count }, (_, i) => [i, value.value]);
    let bytes = 2;
    for (const [key, child] of source) {
      const result = expand(child, value.op === "repeat" ? Number(key) : index);
      bytes += result.bytes + (entries.length ? 1 : 0) + (array ? 0 : Buffer.byteLength(JSON.stringify(key)) + 1);
      if (bytes > maxBytes) fail("output_limit");
      entries.push(array ? result.value : [key, result.value]);
      if (!array) objectEntries.push([key, result.value]);
    }
    return finish(array ? entries : Object.fromEntries(objectEntries));
  };
  const result = expand(input.fixture);
  return { value: result.value, text: result.text, fixture: { recipeHash: hash(recipe), sha256: hash(result.text), bytes: result.bytes } };
}

export function resolveCaseInput(rawItem: unknown, { maxInputBytes = 128 * 1024, signal, textWorkBudget }: CaseOptions = {}) {
  const item = objectFields(rawItem);
  if (Object.hasOwn(item, "inputTarget") && (item.kind !== "input-rejection"
    || (item.inputTarget !== "action-value" && item.inputTarget !== "task-envelope"))) fail("input_target_invalid");
  const maxBytes = item.kind === "input-rejection" ? FIXTURE_LIMITS.rejectionInputBytes : maxInputBytes;
  return resolveFixtureJson(item.input, { maxBytes, signal, textWorkBudget },
    item.kind === "input-rejection" ? FIXTURE_LIMITS.rejectionInputBytes : FIXTURE_LIMITS.resultBytes);
}

type ResolvedCaseValues<Path, Capability = string> = { input: JsonValue; mocks: { capability: Capability; args: JsonValue; value: JsonValue }[]; assertions: { path: Path; value: JsonValue }[]; fixtures?: (FixtureMetadata & { field: string })[] };
export function resolveCaseValues(item: DevelopmentCase, options?: CaseOptions): ResolvedCaseValues<string>;
export function resolveCaseValues(item: unknown, options?: CaseOptions): ResolvedCaseValues<unknown, unknown>;
export function resolveCaseValues(rawItem: unknown, { maxInputBytes = 128 * 1024, signal, fixtureBudget }: CaseOptions = {}): ResolvedCaseValues<unknown, unknown> {
  const item = objectFields(rawItem);
  const fixtures: (FixtureMetadata & { field: string })[] = [];
  const textWorkBudget = fixtureBudget ?? {};
  let bytes = 0;
  const resolve = (value: unknown, field: string, maxBytes?: number) => {
    let result;
    try { result = field === "input" ? resolveCaseInput(item, { maxInputBytes, signal, textWorkBudget })
      : resolveTestJson(value, { ...(maxBytes ? { maxBytes } : {}), signal, textWorkBudget }); }
    catch (error) {
      if (error instanceof InputError && typeof error.reason === "string" && error.reason.startsWith("fixture_")) error.fixtureField = field;
      throw error;
    }
    if (result.fixture) {
      bytes += result.fixture.bytes;
      if (bytes > FIXTURE_LIMITS.caseBytes) fail("case_output_limit");
      if (fixtureBudget) {
        if (!isInteger(fixtureBudget.bytes) || fixtureBudget.bytes < 0 || fixtureBudget.bytes + result.fixture.bytes > FIXTURE_LIMITS.planBytes) fail("plan_output_limit");
        fixtureBudget.bytes += result.fixture.bytes;
      }
      fixtures.push({ field, ...result.fixture });
    }
    return result;
  };
  const input = resolve(item.input, "input", maxInputBytes);
  const mockInputs = item.mocks ?? [];
  if (!Array.isArray(mockInputs)) throw new TypeError("用例能力替身必须为数组");
  const mocks = (mockInputs as unknown[]).map((rawMock, index) => { const mock = objectFields(rawMock);
    return ({ capability: mock.capability,
    args: resolve(mock.argsJson, `mocks[${index}].argsJson`).value, value: resolve(mock.resultJson, `mocks[${index}].resultJson`).value }); });
  if (!Array.isArray(item.assertions)) throw new TypeError("用例断言必须为数组");
  const assertions = (item.assertions as unknown[]).map((rawAssertion, index) => { const assertion = objectFields(rawAssertion); return ({ path: assertion.path,
    value: resolve(assertion.expectedJson, `assertions[${index}].expectedJson`).value }); });
  const resolved = { input: input.value, mocks, assertions, ...(fixtures.length ? { fixtures } : {}) };
  assertCaseMaterials(item, resolved, { signal, budget: textWorkBudget, maxWorkBytes: FIXTURE_LIMITS.planBytes });
  return resolved;
}

function rejectionEnvelope(action: { id?: unknown }, input: unknown) {
  return { actionId: action.id, input, mutationId: "verification-input-rejection", deliveryVersion: "verification-input-rejection",
    source: { kind: "application", scope: "verification:input-rejection" }, allowNetwork: false };
}

export function inputContractMeasurement(action: { id?: unknown }, input: unknown, { target = "action-value" }: { target?: unknown } = {}) {
  if (typeof target !== "string" || !["action-value", "task-envelope"].includes(target)) throw new InputError("输入拒绝验证目标无效");
  return { target, bytes: Buffer.byteLength(JSON.stringify(target === "task-envelope" ? rejectionEnvelope(action, input) : input)),
    limit: target === "task-envelope" ? APPLICATION_TASK_INPUT_BYTES : APPLICATION_ACTION_VALUE_BYTES };
}

export function inputContractRejection(action: { id?: unknown; inputSchema?: unknown }, input: unknown, { target = "action-value" }: { target?: unknown } = {}) {
  inputContractMeasurement(action, input, { target });
  try {
    if (target === "task-envelope") validateApplicationTaskEnvelope(rejectionEnvelope(action, input));
    else validateActionInput({ inputSchema: action.inputSchema }, input);
    return { rejected: false, reason: "input_accepted" };
  }
  catch (error) { if (!(error instanceof InputError)) throw error; return { rejected: true, reason: "input_contract_rejected" }; }
}

export function planningAdmissionFacts(plan: DevelopmentPlan) {
  const operations = plan?.application?.service?.operations ?? plan?.application?.actions ?? [];
  return [...(plan?.cases ?? []), ...(plan?.activationCases ?? [])].filter((test) => test.kind === "input-rejection").map((test) => {
    const action = operations.find((entry) => entry.id === test.actionId);
    if (!action) throw new TypeError("拒绝证据缺少已声明动作");
    const { value } = resolveCaseInput(test);
    return { caseId: test.id, actionId: action.id, ...inputContractMeasurement(action, value, { target: test.inputTarget }),
      ...inputContractRejection(action, value, { target: test.inputTarget }), actionExecuted: false };
  });
}
