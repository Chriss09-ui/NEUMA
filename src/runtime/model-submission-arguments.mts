import type { ToolSchema } from "../contracts/tools.mjs";
import type { NeumaTool } from "./execution-port.mjs";
import { isPlainRecord, objectFields } from "./type-boundary.mjs";

const forbidden = new Set(["__proto__", "constructor", "prototype"]);
const maxBytes = 256 * 1024;
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
  const prepareArguments = (input: unknown) => modelSubmissionArguments(input, tool.parameters);
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
