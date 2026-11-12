import type { ToolSchema, ToolResult } from "../contracts/tools.mjs";
import type { NeumaTool } from "./execution-port.mjs";
import { isPlainRecord, objectFields } from "./type-boundary.mjs";

const forbidden = new Set(["__proto__", "constructor", "prototype"]);
const maxBytes = 256 * 1024;
export const MODEL_FORMAT_REJECTION_LIMIT = 3;
const formatReasons = new Set(["required_field", "unknown_field", "invalid_type", "invalid_contract", "sdk_validation", "invalid_value", "size_limit",
  "invalid_request", "path_missing", "reference_path_missing", "reference_id_ambiguous",
  "required", "additionalProperties", "type", "anyOf", "oneOf", "enum", "const", "pattern", "uniqueItems",
  "minLength", "maxLength", "minItems", "maxItems", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minProperties", "maxProperties", "multipleOf"]);
export function isModelSubmissionFormatIssue(issue: unknown): boolean {
  const reason = objectFields(issue).reason;
  return typeof reason === "string" && formatReasons.has(reason);
}

/** Retry instructions describe a host-counted rejection, never a model-requested allowance. */
export function modelSubmissionFormatRecovery(issues: unknown, attempt: number | undefined) {
  if (!Array.isArray(issues) || !issues.length || !issues.every(isModelSubmissionFormatIssue)
    || typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1 || attempt > MODEL_FORMAT_REJECTION_LIMIT) return undefined;
  return { category: "format", attempt, limit: MODEL_FORMAT_REJECTION_LIMIT, retry: attempt < MODEL_FORMAT_REJECTION_LIMIT,
    instruction: attempt < MODEL_FORMAT_REJECTION_LIMIT
      ? "程序发现格式错误。按逐字段诊断修正当前工具参数，在原会话重试；保留业务内容和编号，数组或对象直接提交原生结构，不要再次编码成文字。"
      : "同一任务连续三轮格式检查未通过，已停止自动重交并保留原稿、诊断和累计次数。" };
}

/** Inspect host read-control envelopes only; file text is never interpreted as an error report. */
export function modelReadInputIssues(output: ToolResult, root: string) {
  const issues: { path: string; reason: string; remedy: string }[] = [];
  for (const part of output.content) {
    if (part.type !== "text") continue;
    let value;
    try { value = objectFields(JSON.parse(part.text)); } catch { continue; }
    const batch = Array.isArray(value.results), rows: unknown[] = batch ? value.results as unknown[] : [value];
    for (const [index, item] of rows.slice(0, 16).entries()) {
      const row = objectFields(item), error = objectFields(row.error);
      const reason = typeof error.reason === "string" ? error.reason : row.found === false ? row.reason : undefined;
      if (typeof reason !== "string" || !formatReasons.has(reason)) continue;
      issues.push({ path: batch ? `${root}.requests[${index}]` : `${root}.pointer`, reason,
        remedy: typeof error.message === "string" ? error.message : typeof row.remedy === "string" ? row.remedy
          : "核对返回的有效位置；续读使用原工具返回的nextRequest，不改变来源或猜写游标。" });
    }
  }
  return issues;
}

export function modelReadRecoveryResult(output: ToolResult, issues: ReturnType<typeof modelReadInputIssues>, attempt: number | undefined): ToolResult {
  let attached = false;
  return { ...output, content: output.content.map(part => {
    if (attached || part.type !== "text") return part;
    let value: unknown;
    try { value = JSON.parse(part.text); } catch { return part; }
    if (!isPlainRecord(value)) return part;
    attached = true;
    return { ...part, text: JSON.stringify({ ...value, inputRejected: true, issues, formatRecovery: modelSubmissionFormatRecovery(issues, attempt) }) };
  }) };
}
interface ContainerSchema {
  [key: string]: unknown; type?: string | string[];
  properties?: Record<string, ContainerSchema | boolean>; items?: ContainerSchema | boolean;
}

/** Only decode explicit container slots in model submissions. Business values and free text stay literal. */
export function modelSubmissionArguments(input: unknown, schema: ContainerSchema): unknown {
  let bytes = 0, nodes = 0, exceeded = false;
  const withinBudget = (depth: number) => {
    if (++nodes > 100_000 || depth > 32 || bytes > maxBytes) exceeded = true;
    return !exceeded;
  };
  const safe = (value: unknown, depth: number): boolean => {
    if (!withinBudget(depth)) return false;
    if (typeof value === "number") return Number.isFinite(value);
    return !value || typeof value !== "object" || Object.entries(value).every(([key, item]) => !forbidden.has(key) && safe(item, depth + 1));
  };
  function decode(value: unknown, rule: ContainerSchema | boolean, depth: number): unknown {
    if (!withinBudget(depth) || typeof rule === "boolean") return value;
    if (typeof rule.$ref === "string") {
      const name = /^#\/definitions\/([\w-]+)$/u.exec(rule.$ref)?.[1];
      const definitions = schema.definitions;
      if (!name || !isPlainRecord(definitions) || !Object.hasOwn(definitions, name) || !isPlainRecord(definitions[name])) return value;
      rule = definitions[name] as ContainerSchema;
    }
    if (rule.type !== "object" && rule.type !== "array") return value;
    if (typeof value === "string") {
      const prefix = rule.type === "array" ? "[" : "{";
      if (value.length > maxBytes || !value.trimStart().startsWith(prefix)) return value;
      bytes += Buffer.byteLength(value, "utf8");
      if (bytes > maxBytes) { exceeded = true; return value; }
      let parsed: unknown;
      try { parsed = JSON.parse(value); } catch { return value; }
      if (!(rule.type === "array" ? Array.isArray(parsed) : isPlainRecord(parsed)) || !safe(parsed, depth)) return value;
      value = parsed;
    }
    if (Array.isArray(value) && rule.type === "array" && rule.items) {
      let copy: unknown[] | undefined;
      for (const [index, child] of value.entries()) {
        if (exceeded) break;
        const next = decode(child, rule.items, depth + 1);
        if (next !== child) (copy ??= [...value])[index] = next;
      }
      return copy ?? value;
    }
    if (!isPlainRecord(value) || rule.type !== "object" || !rule.properties) return value;
    let copy: Record<string, unknown> | undefined;
    for (const [key, childRule] of Object.entries(rule.properties)) {
      if (forbidden.has(key) || !Object.hasOwn(value, key)) continue;
      const next = decode(value[key], childRule, depth + 1);
      if (next !== value[key]) (copy ??= { ...value })[key] = next;
    }
    return copy ?? value;
  }
  const result = decode(input, schema, 0);
  return exceeded ? input : result;
}

export function modelSubmissionTool(tool: NeumaTool): NeumaTool {
  const prepareArguments = (input: unknown) => {
    const args = modelSubmissionArguments(input, tool.parameters);
    return tool.prepareArguments ? tool.prepareArguments(args) : args;
  };
  return { ...tool, prepareArguments, execute: (id, input, ...rest) => tool.execute(id, prepareArguments(input), ...rest) };
}

/** A single replacement and a batch use the same targets, stale-base checks and atomic validation. */
export function singleUpdateSchema<T extends ToolSchema>(batch: T): T {
  const item = batch.properties!.updates!.items!.properties!;
  const binding = batch.required!.filter(key => key !== "updates");
  return { ...batch, required: binding, properties: { ...batch.properties, path: item.path, value: item.value },
    oneOf: [{ required: ["updates"], not: { anyOf: [{ required: ["path"] }, { required: ["value"] }] } },
      { required: ["path", "value"], not: { required: ["updates"] } }] };
}

export function modelUpdateBatch(input: unknown): unknown {
  const fields = objectFields(input);
  if (Object.hasOwn(fields, "updates") || !Object.hasOwn(fields, "path") || !Object.hasOwn(fields, "value")) return input;
  const { path, value, ...binding } = fields;
  return { ...binding, updates: [{ path, value }] };
}
