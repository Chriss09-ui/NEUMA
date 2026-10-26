import type { ArchitectureDesign, PlatformClaim } from "../contracts/architecture.mjs";
import type { ToolSchema } from "../contracts/tools.mjs";
import type { UnknownRecord } from "../contracts/json.mjs";
import type { NeumaTool } from "../runtime/execution-port.mjs";
import { objectFields } from "../runtime/type-boundary.mjs";
type Query = Pick<PlatformClaim, "source" | "path" | "expected">;
type FactSource = { reason: string; value?: never; sourceHash?: never } | { value: UnknownRecord; sourceHash: string; reason?: never };
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Ajv } from "ajv";
import { InputError } from "../requirements/core.mjs";
import { copyArchitectureReviewJson } from "./architecture-review-binding.mjs";

const sources = ["runtimeCapabilities", "acceptanceAdapterGuide"];
const scalar = { anyOf: [{ type: "null" }, { type: "boolean" }, { type: "number" }, { type: "string", minLength: 0, maxLength: 1000 }] };
const valueSchema = { anyOf: [scalar, { type: "array", maxItems: 16, items: scalar }] };
const identifier = { type: "string", minLength: 1, maxLength: 80, pattern: "^[A-Za-z][A-Za-z0-9_-]*$" };
const pointer = { type: "string", minLength: 1, maxLength: 500 };
const source = { type: "string", enum: sources };
const refs = { type: "array", maxItems: 80, uniqueItems: true, items: identifier };
const object = <T extends Record<string, ToolSchema>>(properties: T) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
export const PLATFORM_CLAIMS_SCHEMA = { type: "array", maxItems: 40, items: object({ id: identifier, source, path: pointer,
  expected: valueSchema, decisionIds: refs, acceptanceIds: refs }),
description: "仅v3可选的平台事实依赖。expected为原生标量或最多16个标量，必须与当前公开材料精确相同，并关联实际decision/acceptance编号。模型不填写actual、来源摘要或回执；文字声明不授予能力。" };
const querySchema = object({ requests: { type: "array", minItems: 1, maxItems: 16, items: object({ source, path: pointer, expected: valueSchema }) } });
const ajv = new Ajv({ strict: false, allErrors: true, coerceTypes: false }), claimsValid = ajv.compile<PlatformClaim[]>(PLATFORM_CLAIMS_SCHEMA), queryValid = ajv.compile<{ requests: Query[] }>(querySchema), valueValid = ajv.compile(valueSchema);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const copy = <T,>(value: T, maxBytes = 64 * 1024) => copyArchitectureReviewJson(value, { maxDepth: 32, maxNodes: 100_000, maxBytes });
function fail(path: string, reason: string, remedy: string): never { throw Object.assign(new InputError(`平台事实声明无效：${path} ${remedy}`),
  { validationIssue: { path, reason }, validationIssues: [{ path, reason, remedy }], validationIssueTotal: 1, validationIssuesTruncated: false }); }

function at(value: unknown, path: unknown): { found: false; value?: never } | { found: true; value: unknown } {
  if (typeof path !== "string" || !path.startsWith("/") || /~(?![01])/u.test(path)) return { found: false };
  let current = value;
  for (const key of path.slice(1).split("/").map(part => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (["__proto__", "prototype", "constructor"].includes(key) || !current || typeof current !== "object"
      || Array.isArray(current) && !/^(0|[1-9][0-9]*)$/u.test(key)) return { found: false };
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return { found: false };
    current = descriptor.value;
  }
  return { found: true, value: current };
}

/** Freeze only the two public fact sources; no credentials, model payloads or generated code. */
function factSources(context: object = {}): Record<string, FactSource> {
  return Object.fromEntries(sources.map((key): [string, FactSource] => {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(context, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.value === undefined) return [key, { reason: "platform_source_unavailable" }];
      const value = copy(descriptor.value as unknown, 2 * 1024 * 1024), sourceHash = digest(value);
      if (!value || typeof value !== "object" || Array.isArray(value)) return [key, { reason: "platform_source_unavailable" }];
      if (key === "runtimeCapabilities" && Object.hasOwn(value, "hash")) {
        const { hash, ...body } = objectFields(value);
        if (typeof hash !== "string" || hash !== digest(body)) return [key, { reason: "platform_source_stale" }];
      }
      const manifest = Object.getOwnPropertyDescriptor(context, "contextManifest");
      if (manifest && (!Object.hasOwn(manifest, "value") || objectFields(objectFields(copy(manifest.value as unknown))[key]).sha256 !== sourceHash))
        return [key, { reason: "platform_source_stale" }];
      return [key, { value: objectFields(value), sourceHash }];
    } catch { return [key, { reason: "platform_source_unavailable" }]; }
  }));
}

function check(query: Query, facts: Record<string, FactSource>) {
  const source = facts[query.source];
  if (!source || source.reason) return { found: false, matches: false, reason: source?.reason ?? "platform_source_unavailable" };
  const selected = at(source.value, query.path);
  if (!selected.found) return { found: false, matches: false, sourceHash: source.sourceHash, reason: "platform_path_missing" };
  if (!valueValid(selected.value) || Buffer.byteLength(JSON.stringify(selected.value)) > 4096)
    return { found: true, matches: false, sourceHash: source.sourceHash, reason: "platform_value_not_scalar" };
  return { found: true, actual: copy(selected.value), matches: isDeepStrictEqual(selected.value, query.expected), sourceHash: source.sourceHash,
    ...(!isDeepStrictEqual(selected.value, query.expected) ? { reason: "platform_fact_mismatch" } : {}) };
}

export function validateArchitecturePlatformClaims<T>(input: T, context: object) {
  const design = objectFields(input);
  if (!Object.hasOwn(design, "platformClaims")) return input;
  if (design.schemaVersion !== 3) fail("design.platformClaims", "invalid_contract", "只有v3候选可以声明显式平台事实。");
  let claims: unknown;
  try { claims = copy(design.platformClaims); } catch { fail("design.platformClaims", "invalid_type", "请使用有界普通JSON声明。"); }
  if (!claimsValid(claims)) fail("design.platformClaims", "invalid_contract", "只允许已声明字段、公开来源、标量或小列表，不能填写actual、hash或回执。");
  const ids = new Set(), decisions = new Set((design.decisions as unknown[]).map(row => objectFields(row).id)), acceptance = new Set((design.acceptance as unknown[]).map(row => objectFields(row).id)), facts = factSources(context);
  for (const [index, claim] of claims.entries()) {
    const path = `design.platformClaims[${index}]`;
    if (ids.has(claim.id)) fail(`${path}.id`, "invalid_reference", "同一声明编号不能重复。"); ids.add(claim.id);
    if (!claim.decisionIds.length && !claim.acceptanceIds.length) fail(path, "invalid_reference", "声明必须关联至少一个当前决策或验收项。");
    if (claim.decisionIds.some(id => !decisions.has(id))) fail(`${path}.decisionIds`, "invalid_reference", "只关联当前候选的实际决策编号。");
    if (claim.acceptanceIds.some(id => !acceptance.has(id))) fail(`${path}.acceptanceIds`, "invalid_reference", "只关联当前候选的实际验收编号。");
    const result = check(claim, facts);
    if (!result.matches) fail(`${path}.${result.reason === "platform_fact_mismatch" ? "expected" : "path"}`, result.reason ?? "platform_fact_mismatch",
      "当前冻结平台事实不支持该依赖；使用check_platform_contract核对实际值并修订方案，不能通过声明新增能力。");
  }
  return input;
}

export function createPlatformContractTool(context: object): NeumaTool {
  const facts = factSources(context);
  return { name: "check_platform_contract", label: "核对当前平台事实", executionMode: "sequential", parameters: structuredClone(querySchema),
    description: "只读批查1至16个当前runtimeCapabilities或acceptanceAdapterGuide的JSON Pointer及expected标量/小列表；返回宿主实际值、是否匹配和来源摘要。来源不可用、路径缺失或值不符不授权能力。不联网、不写配置、不执行生成代码。",
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      let value: unknown;
      try { value = copy(input); } catch { fail("check_platform_contract", "invalid_type", "只接受有界普通JSON参数。"); }
      if (!queryValid(value)) fail("check_platform_contract", "invalid_contract", "使用已声明来源、JSON Pointer及expected，不填写actual、hash或回执。");
      const results = value.requests.map((query, index) => { signal?.throwIfAborted(); return { index, source: query.source, ...check(query, facts) }; });
      return { content: [{ type: "text", text: JSON.stringify({ scope: "explicit-current-platform-facts-only", grantsCapability: false, results }) }], details: {} };
    } };
}
