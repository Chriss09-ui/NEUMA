import type { RequirementDraft, RequirementIssue, SystemCheck, RequirementDerivation, CalculationRequest, CalculationFormula } from "../contracts/requirements.mjs";
import type { UnknownRecord } from "../contracts/json.mjs";
import type { ToolSchema } from "../contracts/tools.mjs";
import { objectFields, isArray } from "../runtime/type-boundary.mjs";
export interface CalculationContext { draft?: Partial<RequirementDraft> | undefined; platform?: unknown; platformHash?: string | undefined; issues?: (Pick<RequirementIssue, "id" | "requirementIds"> & { owner?: string })[] | undefined; requirementIds?: string[] | undefined; signal?: AbortSignal | undefined; verification?: SystemCheck[] | undefined; legacy?: boolean; originalBinding?: Pick<RequirementDerivation, "requirementHash" | "platformHash" | "factBindings"> }
interface CalculationSchema { [key: string]: unknown; properties?: Record<string, CalculationSchema | boolean>; items?: CalculationSchema | boolean; anyOf?: (CalculationSchema | boolean)[] }
type Rejection = { path: string; expectedFields: string[]; missingFields: string[]; unexpectedFields: boolean };
import { contentHash, substantiveRequirementHash } from "./task-spec.mjs";
import { SYSTEM_REQUIREMENT_CHECKS } from "../agents/requirement-verification.mjs";
import { textWithinLimit } from "../runtime/text-length.mjs";

export const CALCULATION_LIMITS = Object.freeze({ inputBytes: 32768, premises: 32, expressions: 16, nodes: 256, depth: 12, digits: 256, derivations: 2 });
export const CALCULATION_UNITS = Object.freeze(["count", "bytes", "utf16_units", "code_points", "milliseconds"]);
export const CALCULATION_FEEDBACK = Object.freeze({
  calculation_shape_invalid: "只接受calculationSchema的完整JSON字段；calculate不能同时提交research或最终评估，不接受代码、函数、属性访问或额外字段。",
  calculation_size_limit: "请求最多32768 UTF-8字节、32个前提、16个表达式，且两个数组都不能为空。",
  calculation_reference_invalid: "issueId必须是本轮已有system问题；requirementIds必须来自当前目录且关联该问题；前提source只能引用所列需求或当前存在的受控platform编号；ref只能引用前提或前序表达式。",
  calculation_value_invalid: "前提和表达式id必须是字母开头的唯一编号，仅含字母、数字、下划线或连字符，最多80字符；unit只用count、bytes、utf16_units、code_points、milliseconds。",
  calculation_integer_invalid: "value必须是最多256位的非负十进制整数字符串；除0外不能有前导零，不接受JSON数字、负数、小数或科学计数法。",
  calculation_complexity_limit: "所有表达式合计最多256个公式节点，公式嵌套最多12层；缩小或拆分公式，不提交深层对象。",
  calculation_operator_invalid: "op只支持add、subtract、multiply、min、max、ceilDiv；subtract和ceilDiv必须恰好两个参数，其余运算为2至16个参数。",
  calculation_division_by_zero: "ceilDiv的第二个参数不能为0；先核实分母前提，不能用错误算式证明可行性。",
  calculation_integer_limit: "每个中间结果必须非负且不超过256位十进制整数；超限或出现负数时修正公式与前提。",
  calculation_binding_invalid: "计算回执必须与当前需求、平台、参数、公式和程序重算值完全一致；不能修改或复用过期回执。",
  calculation_failed: "只读计算未完成，不能当作证据；保留真实系统缺口并在剩余预算内按结构修正。",
});
const operations = ["add", "subtract", "multiply", "min", "max", "ceilDiv"];
const identifier = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const integer = /^(?:0|[1-9][0-9]{0,255})$/;
const platformReferences = SYSTEM_REQUIREMENT_CHECKS.filter((reference) => reference.startsWith("platform."));
const scope = "只证明给定前提和公式的精确整数计算；前提数值、单位、完整性及适用性仍须独立复核，不证明程序或业务已通过验收。";
function fail(reason: string, path?: string, details: UnknownRecord = {}): never {
  const reject = safeCalculationRejection({ path, expectedFields: [], missingFields: [], unexpectedFields: false, ...details });
  throw Object.assign(new Error(reason), { reason, ...(reject ? { reject } : {}) });
}
const plain = (value: unknown): value is UnknownRecord => value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function fields(value: unknown, expected: string[], path?: string): asserts value is UnknownRecord {
  const keys = plain(value) ? Object.keys(value) : [], missingFields = expected.filter((key) => !plain(value) || !Object.hasOwn(value, key));
  if (!plain(value) || keys.length !== expected.length || missingFields.length) fail("calculation_shape_invalid", path,
    { expectedFields: expected, missingFields, unexpectedFields: keys.some((key) => !expected.includes(key)) });
};
const text = (value: unknown, max = 1000) => textWithinLimit(value, max) && value.trim();
const distinct = (items: readonly unknown[]) => new Set(items).size === items.length;
const object = <T extends Record<string, CalculationSchema | boolean>>(properties: T) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const list = <T extends CalculationSchema | boolean>(items: T, maxItems: number, minItems = 1) => ({ type: "array", items, minItems, maxItems });
const enumeration = (values: string[]) => values.length ? { type: "string", enum: [...new Set(values)] } : false;

function requirementFact(draft: Partial<RequirementDraft> | undefined, reference: string) {
  const item = draft?.taskSpec?.items?.find((entry) => entry.id === reference || `spec_${contentHash(entry.id).slice(0, 24)}` === reference);
  if (item) return item;
  const indexed = /^(constraint|capability|operation|connection)_([1-9][0-9]*)$/.exec(reference);
  if (indexed) return ({ constraint: draft?.constraints, capability: draft?.capabilityDependencies,
    operation: draft?.interaction?.operations, connection: draft?.connections } as Record<string, unknown[] | undefined>)[indexed[1]!]?.[Number(indexed[2]) - 1] ?? null;
  return Object.hasOwn(draft ?? {}, reference) ? objectFields(draft)[reference] : null;
}

// These hashes describe dependencies, never validate a model's claimed premise value.
function factBindings(request: CalculationRequest, { draft, platform, verification = [] }: CalculationContext): NonNullable<RequirementDerivation["factBindings"]> {
  const requirementIds = [...new Set([...request.requirementIds,
    ...request.premises.filter((item) => item.source.kind === "requirement").map((item) => item.source.reference)])].sort();
  const platformIds = [...new Set(request.premises.filter((item) => item.source.kind === "platform").map((item) => item.source.reference))].sort();
  return { version: 1, scopeHash: contentHash(draft?.unresolved ?? []),
    requirements: requirementIds.map((reference) => ({ reference, hash: contentHash(requirementFact(draft, reference)) })),
    platform: platformIds.map((reference) => ({ reference, hash: contentHash(reference.split(".").slice(1)
      .reduce<unknown>((value, part) => objectFields(value)[part], platform) ?? null) })),
    verification: platformIds.map((reference) => ({ reference, hash: contentHash(verification.filter((check) => check.id === request.issueId)
      .flatMap((check) => check.evidence ?? []).filter((entry) => entry.reference === reference)) })),
  };
}

function calculationRequest(derivation: UnknownRecord) {
  if (!isArray(derivation.expressions)) fail("calculation_shape_invalid");
  return { issueId: derivation.issueId, requirementIds: derivation.requirementIds, premises: derivation.premises,
    expressions: derivation.expressions.map(input => { const { id, unit, formula } = objectFields(input); return { id, unit, formula }; }) };
}

export function replayRequirementDerivation(input: unknown): RequirementDerivation {
  const record = objectFields(input);
  jsonData(input);
  if (!plain(record) || !Array.isArray(record.expressions)) fail("calculation_shape_invalid");
  if (!/^[a-f0-9]{64}$/.test(typeof record.requirementHash === "string" ? record.requirementHash : "")) fail("calculation_binding_invalid");
  const request = calculationRequest(record);
  const arithmetic = computeDerivation(request, { draft: {}, platformHash: typeof record.platformHash === "string" ? record.platformHash : undefined,
    issues: [{ id: String(record.issueId), requirementIds: isArray(record.requirementIds) ? record.requirementIds.filter((value): value is string => typeof value === "string") : [] }], requirementIds: isArray(record.requirementIds) ? record.requirementIds.filter((value): value is string => typeof value === "string") : [],
    originalBinding: { requirementHash: String(record.requirementHash), platformHash: String(record.platformHash) }, legacy: true }, true);
  let checked = arithmetic;
  if (record.version === 2) {
    const facts = objectFields(record.factBindings);
    fields(facts, ["version", "scopeHash", "requirements", "platform", "verification"], "calculate");
    if (facts.version !== 1 || !/^[a-f0-9]{64}$/.test(typeof facts.scopeHash === "string" ? facts.scopeHash : "")) fail("calculation_binding_invalid");
    const expected = { requirements: [...new Set([...arithmetic.requirementIds,
      ...arithmetic.premises.filter((item) => item.source.kind === "requirement").map((item) => item.source.reference)])].sort(),
    platform: [...new Set(arithmetic.premises.filter((item) => item.source.kind === "platform").map((item) => item.source.reference))].sort() };
    for (const kind of ["requirements", "platform", "verification"] as const) {
      if (!isArray(facts[kind]) || facts[kind].length !== expected[kind === "verification" ? "platform" : kind].length)
        fail("calculation_binding_invalid");
      for (const [index, fact] of facts[kind].entries()) {
        fields(fact, ["reference", "hash"], "calculate");
        if (fact.reference !== expected[kind === "verification" ? "platform" : kind][index] || !/^[a-f0-9]{64}$/.test(typeof fact.hash === "string" ? fact.hash : "")) fail("calculation_binding_invalid");
      }
    }
    const binding = { issueId: arithmetic.issueId, requirementIds: arithmetic.requirementIds, requirementHash: arithmetic.requirementHash,
      platformHash: arithmetic.platformHash, requestHash: arithmetic.requestHash, version: 2 as const, factBindings: facts as NonNullable<RequirementDerivation["factBindings"]> };
    checked = { ...arithmetic, ...binding, id: `calculation_${contentHash(binding).slice(0, 32)}` };
  }
  if (contentHash(checked) !== contentHash(record)) fail("calculation_binding_invalid");
  return checked;
}

export function selectRequirementDerivations(records: RequirementDerivation[] = [], context: CalculationContext = {}) {
  const reusable: RequirementDerivation[] = [], invalidated: { id: string; issueId: string; reason: string }[] = [];
  const seen = new Set();
  for (const record of records.slice(-60).toReversed()) {
    if (!record || typeof record.id !== "string" || seen.has(record.id)) continue;
    seen.add(record.id);
    try {
      replayRequirementDerivation(record);
      const checked = validateRequirementDerivations([record], context)[0]!;
      if (record.version !== 2 && record.premises.some((item) => item.source.kind === "platform" && item.source.reference === "platform.runtime")
        && context.verification?.some((check) => check.id === record.issueId && check.evidence?.some((entry) => {
          try { return JSON.parse(entry.detail).type === "current_connection_framing"; } catch { return false; }
        }))) {
        invalidated.push({ id: record.id, issueId: record.issueId, reason: "calculation_legacy_unbound" }); continue;
      }
      if (reusable.length < CALCULATION_LIMITS.derivations) reusable.push(checked);
      else invalidated.push({ id: record.id, issueId: record.issueId, reason: "calculation_history_superseded" });
    } catch {
      context.signal?.throwIfAborted();
      invalidated.push({ id: record.id, issueId: record.issueId, reason: "calculation_binding_invalid" });
    }
  }
  return { reusable, invalidated };
}

export function safeCalculationPath(value: unknown) {
  if (typeof value !== "string" || value.length > 240) return null;
  if (value === "calculate") return value;
  const match = /^calculate\.(issueId|requirementIds|premises|expressions)(.*)$/.exec(value);
  if (!match) return null;
  const field = match[1]!, tail = match[2]!;
  if (!tail) return value;
  if (field === "issueId") return null;
  if (field === "requirementIds") return /^\[(0|[1-9][0-9]{0,2})\]$/.test(tail) && Number(tail.slice(1, -1)) < 120 ? value : null;
  const item = /^\[(0|[1-9][0-9]?)\](.*)$/.exec(tail);
  if (!item || Number(item[1]) >= CALCULATION_LIMITS[field as "premises" | "expressions"]) return null;
  if (field === "premises") return /^(?:\.(?:id|value|unit|source(?:\.(?:kind|reference|detail))?))?$/.test(item[2]!) ? value : null;
  if (/^(?:\.(?:id|unit))?$/.test(item[2]!)) return value;
  if (!item[2]!.startsWith(".formula")) return null;
  let rest = item[2]!.slice(".formula".length), depth = 0;
  while (rest.startsWith(".args[")) {
    const arg = /^\.args\[(0|[1-9][0-9]?)\]/.exec(rest);
    if (!arg || Number(arg[1]) >= 16 || ++depth > CALCULATION_LIMITS.depth) return null;
    rest = rest.slice(arg[0].length);
  }
  return /^(?:\.(?:value|ref|op|args))?$/.test(rest) ? value : null;
}

const diagnosticKeys = new Set(["calculate", "issueId", "requirementIds", "premises", "expressions", "id", "value", "unit", "source", "kind", "reference", "detail", "formula", "ref", "op", "args"]);
export function safeCalculationRejection(value: unknown): Rejection | null {
  if (!plain(value)) return null;
  const get = (key: string): unknown => { const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined; };
  const path = safeCalculationPath(get("path")), expected = get("expectedFields"), missing = get("missingFields"), unexpected = get("unexpectedFields");
  const keys = (items: unknown): items is string[] => isArray(items) && items.length <= 4 && Reflect.ownKeys(items).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(items, key);
    return key === "length" || typeof key === "string" && /^(0|[1-3])$/.test(key) && descriptor && Object.hasOwn(descriptor, "value") && diagnosticKeys.has(descriptor.value);
  }) && Object.keys(items).length === items.length && distinct(items);
  if (!path || !keys(expected) || !keys(missing) || missing.some((key) => !expected.includes(key)) || typeof unexpected !== "boolean") return null;
  return { path, expectedFields: [...expected], missingFields: [...missing], unexpectedFields: unexpected };
}

const childPath = (path: string | undefined, key: string | number, array: boolean) => safeCalculationPath(array ? `${path}[${key}]` : `${path}.${key}`) ?? path;
function jsonData(value: unknown, depth = 0, path?: string): void {
  if (depth > 32) fail("calculation_complexity_limit", path);
  if (value === null || ["string", "boolean"].includes(typeof value) || typeof value === "number" && Number.isFinite(value)) return;
  if (!plain(value) && !Array.isArray(value)) fail("calculation_shape_invalid", path);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || key === "toJSON" || !descriptor || !Object.hasOwn(descriptor, "value")) fail("calculation_shape_invalid", path);
    jsonData(descriptor.value, depth + 1, childPath(path, key, Array.isArray(value)));
  }
}

function availablePlatformReferences(input: unknown) {
  const platform = objectFields(input), deliveryRoutes = objectFields(platform.deliveryRoutes);
  if (input === undefined) return platformReferences;
  const values: UnknownRecord = { "platform.deliveryRoutes.downloadableFiles": deliveryRoutes.downloadableFiles,
    "platform.deliveryRoutes.hostedApplication": deliveryRoutes.hostedApplication,
    "platform.deliveryRoutes.developedWorkflow": deliveryRoutes.developedWorkflow,
    "platform.deliveryRoutes.managedService": deliveryRoutes.managedService,
    "platform.runtime": platform?.runtime, "platform.managedRuntime": platform?.managedRuntime,
    "platform.connections": platform?.connections, "platform.network": platform?.network,
    "platform.businessCapabilities": platform?.businessCapabilities, "platform.publicCapabilities": platform?.publicCapabilities };
  return platformReferences.filter((reference) => values[reference] !== undefined);
}

export function calculationRequestSchema({ issues = [], requirementIds = [], platform }: Pick<CalculationContext, "issues" | "requirementIds" | "platform"> = {}) {
  const id = { type: "string", pattern: identifier.source }, value = { type: "string", pattern: integer.source };
  const unit = { type: "string", enum: [...CALCULATION_UNITS] }, formula = { $ref: "#/$defs/formula" };
  return { ...object({ issueId: enumeration(issues.filter((issue) => issue.owner === "system").map((issue) => issue.id)),
    requirementIds: { ...list(enumeration(requirementIds), 120), uniqueItems: true },
    premises: list(object({ id, value, unit, source: { anyOf: [
      object({ kind: { const: "requirement" }, reference: enumeration(requirementIds), detail: { type: "string", minLength: 1, maxLength: 1000 } }),
      object({ kind: { const: "platform" }, reference: enumeration(availablePlatformReferences(platform)), detail: { type: "string", minLength: 1, maxLength: 1000 } }),
    ] } }), CALCULATION_LIMITS.premises),
    expressions: list(object({ id, unit, formula }), CALCULATION_LIMITS.expressions),
  }), $defs: { formula: { anyOf: [object({ value }), object({ ref: id }),
    object({ op: enumeration(["subtract", "ceilDiv"]), args: list(formula, 2, 2) }),
    object({ op: enumeration(operations.filter((op) => !["subtract", "ceilDiv"].includes(op))), args: list(formula, 16, 2) })] } } };
}

function computeDerivation(input: unknown, { draft, platform, platformHash, issues = [], requirementIds = [], signal,
  verification, legacy = verification === undefined, originalBinding }: CalculationContext = {}, replay = false): RequirementDerivation {
  const request = objectFields(input);
  signal?.throwIfAborted();
  jsonData(input, 0, "calculate");
  let encoded;
  try { encoded = JSON.stringify(request); } catch { fail("calculation_shape_invalid", "calculate"); }
  if (typeof encoded !== "string" || Buffer.byteLength(encoded) > CALCULATION_LIMITS.inputBytes) fail("calculation_size_limit", "calculate");
  fields(request, ["issueId", "requirementIds", "premises", "expressions"], "calculate");
  const issue = issues.find((item) => item.id === request.issueId && (replay || item.owner === "system"));
  if (!issue) fail("calculation_reference_invalid", "calculate.issueId");
  if (!isArray(request.requirementIds) || !request.requirementIds.length || request.requirementIds.length > 120
    || !distinct(request.requirementIds) || request.requirementIds.some((id) => typeof id !== "string" || !requirementIds.includes(id))
    || !request.requirementIds.some((id) => issue.requirementIds?.some(value => value === id))) fail("calculation_reference_invalid", "calculate.requirementIds");
  for (const field of ["premises", "expressions"] as const) if (!isArray(request[field]) || !request[field].length || request[field].length > CALCULATION_LIMITS[field as "premises" | "expressions"]) fail("calculation_size_limit", `calculate.${field}`);
  const values = new Map<string, bigint>(), platformIds = availablePlatformReferences(platform);
  const checkedInteger = (value: unknown, path: string | undefined): bigint => { if (typeof value !== "string" || !integer.test(value)) fail("calculation_integer_invalid", path); return BigInt(value); };
  for (const [index, premise] of (request.premises as unknown[]).entries()) {
    const path = `calculate.premises[${index}]`;
    signal?.throwIfAborted(); fields(premise, ["id", "value", "unit", "source"], path);
    if (typeof premise.id !== "string" || !identifier.test(premise.id) || values.has(premise.id)) fail("calculation_value_invalid", `${path}.id`);
    if (typeof premise.unit !== "string" || !CALCULATION_UNITS.includes(premise.unit)) fail("calculation_value_invalid", `${path}.unit`);
    fields(premise.source, ["kind", "reference", "detail"], `${path}.source`);
    const source = premise.source;
    if (!text(source.detail)) fail("calculation_reference_invalid", `${path}.source.detail`);
    if (!["requirement", "platform"].some(kind => kind === source.kind)) fail("calculation_reference_invalid", `${path}.source.kind`);
    if (source.kind === "requirement" ? !request.requirementIds.includes(source.reference)
      : !platformIds.some(reference => reference === source.reference)) fail("calculation_reference_invalid", `${path}.source.reference`);
    values.set(premise.id, checkedInteger(premise.value, `${path}.value`));
  }
  let nodes = 0;
  const evaluate = (formula: unknown, path: string | undefined, depth = 0): bigint => {
    signal?.throwIfAborted();
    if (++nodes > CALCULATION_LIMITS.nodes || depth > CALCULATION_LIMITS.depth) fail("calculation_complexity_limit", path);
    if (!plain(formula)) fail("calculation_shape_invalid", path);
    if (Object.hasOwn(formula, "value")) { fields(formula, ["value"], path); return checkedInteger(formula.value, `${path}.value`); }
    if (Object.hasOwn(formula, "ref")) {
      fields(formula, ["ref"], path); if (typeof formula.ref !== "string" || !values.has(formula.ref)) fail("calculation_reference_invalid", `${path}.ref`); return values.get(formula.ref)!;
    }
    fields(formula, ["op", "args"], path);
    if (typeof formula.op !== "string" || !operations.includes(formula.op)) fail("calculation_operator_invalid", `${path}.op`);
    if (!isArray(formula.args) || formula.args.length < 2 || formula.args.length > 16
      || ["subtract", "ceilDiv"].includes(formula.op) && formula.args.length !== 2) fail("calculation_operator_invalid", `${path}.args`);
    const args = formula.args.map((arg, index) => evaluate(arg, childPath(`${path}.args`, index, true), depth + 1));
    let result = args[0]!;
    for (const value of args.slice(1)) {
      if (formula.op === "add") result += value;
      else if (formula.op === "subtract") result -= value;
      else if (formula.op === "multiply") result *= value;
      else if (formula.op === "min") result = result < value ? result : value;
      else if (formula.op === "max") result = result > value ? result : value;
      else { if (value === 0n) fail("calculation_division_by_zero", `${path}.args[1]`); result = result / value + (result % value === 0n ? 0n : 1n); }
      if (result < 0n || result.toString().length > CALCULATION_LIMITS.digits) fail("calculation_integer_limit", path);
    }
    return result;
  };
  const expressions = (request.expressions as unknown[]).map((expression, index) => {
    const path = `calculate.expressions[${index}]`;
    fields(expression, ["id", "unit", "formula"], path);
    if (typeof expression.id !== "string" || !identifier.test(expression.id) || values.has(expression.id)) fail("calculation_value_invalid", `${path}.id`);
    if (typeof expression.unit !== "string" || !CALCULATION_UNITS.includes(expression.unit)) fail("calculation_value_invalid", `${path}.unit`);
    const value = evaluate(expression.formula, `${path}.formula`).toString(); values.set(expression.id, BigInt(value));
    return { ...structuredClone(expression), id: expression.id, unit: expression.unit, formula: expression.formula as CalculationFormula, value };
  });
  const checkedRequest = input as CalculationRequest;
  const actualPlatformHash = platform === undefined ? platformHash : contentHash(platform);
  if (!/^[a-f0-9]{64}$/.test(actualPlatformHash ?? "") || platformHash !== undefined && platformHash !== actualPlatformHash) fail("calculation_binding_invalid");
  const dependencies = !legacy ? factBindings(checkedRequest, { draft, platform, verification }) : undefined;
  if (dependencies && platform === undefined && originalBinding) dependencies.platform = originalBinding.factBindings?.platform as NonNullable<RequirementDerivation["factBindings"]>["platform"];
  const binding = { issueId: checkedRequest.issueId, requirementIds: [...checkedRequest.requirementIds],
    requirementHash: originalBinding?.requirementHash ?? substantiveRequirementHash(draft),
    platformHash: originalBinding?.platformHash ?? actualPlatformHash!,  requestHash: contentHash(request),
    ...(!legacy ? { version: 2 as const, factBindings: dependencies! } : {}) };
  return { id: `calculation_${contentHash(binding).slice(0, 32)}`, status: "calculated", ...binding,
    premises: structuredClone(checkedRequest.premises), expressions, scope };
}

export function calculateRequirementDerivation(request: unknown, context: CalculationContext) {
  return computeDerivation(request, context);
}

export function validateRequirementDerivations(input: unknown, context: CalculationContext): RequirementDerivation[] {
  const derivations = input;
  if (!isArray(derivations) || derivations.length > CALCULATION_LIMITS.derivations || !distinct(derivations.map((item) => objectFields(item).id))) fail("calculation_shape_invalid");
  return derivations.map((input) => {
    const derivation = replayRequirementDerivation(input);
    jsonData(derivation);
    if (!plain(derivation) || !Array.isArray(derivation.expressions) || derivation.expressions.some((expression) => !plain(expression))) fail("calculation_shape_invalid");
    const request = calculationRequest(objectFields(derivation));
    // Reclassification does not invalidate arithmetic; issuing a new calculation remains system-only.
    // Historical v1 records keep exact whole-draft/platform matching. New records may
    // survive unrelated changes, but every referenced fact and fresh check must match.
    const v2 = derivation.version === 2;
    const checked = computeDerivation(request, { ...context, legacy: !v2,
      ...(v2 ? { originalBinding: derivation } : {}) }, true);
    if (contentHash(checked) !== contentHash(derivation)) fail("calculation_binding_invalid");
    return checked;
  });
}
