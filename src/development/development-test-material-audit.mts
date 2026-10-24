import type { UnknownRecord } from "../contracts/json.mjs";
import type { FixtureBudget } from "../contracts/development.mjs";
import { objectFields, isRecord, isInteger } from "../runtime/type-boundary.mjs";
interface MaterialAuditOptions { signal?: Pick<AbortSignal, "throwIfAborted"> | undefined; budget?: FixtureBudget | undefined; maxWorkBytes?: number | undefined }
interface MaterialAuditInput { materialChecks?: unknown }
interface MaterialAuditResolved { input?: unknown; inputAvailable?: boolean; mocks?: { capability: unknown; args: unknown; value: unknown }[] }
interface MaterialAuditIssue { path: string; reason: string; remedy: string; measurement?: { measure: string; encoding?: string; actual: string | number; expected: string | number } }
import { createHash } from "node:crypto";
import { InputError } from "../requirements/core.mjs";

export const MATERIAL_AUDIT_LIMITS = Object.freeze({ checks: 16, issues: 64, workBytes: 16 * 1024 * 1024 });
export const MATERIAL_CHECKS_SCHEMA = { type: "array", minItems: 0, maxItems: MATERIAL_AUDIT_LIMITS.checks,
  description: "可选材料事实声明，只测已展开输入，不执行业务。pointer为JSON Pointer。array-length测数组项数；其余显式选择text原字符串或json规范JSON编码，不含任务/API信封。不能据此证明业务输出正确。",
  items: { type: "object", additionalProperties: false, required: ["source", "pointer", "measure", "expected"], properties: {
    source: { type: "string", enum: ["input"] }, pointer: { type: "string", minLength: 0, maxLength: 500 },
    measure: { type: "string", enum: ["array-length", "utf8-bytes", "utf16-units", "sha256"] },
    encoding: { type: "string", enum: ["text", "json"] },
    expected: { anyOf: [{ type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, { type: "string", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }] },
  } } };
const own = (value: unknown, key: PropertyKey) => value !== null && typeof value === "object" && Object.hasOwn(value, key);
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const remedy = "核对当前展开材料与该显式声明，或模拟回执与原参数；主动修正尚未接受的草稿并重走校验，不自动改预期、不声称业务已经通过。";

function at(value: unknown, pointer: unknown): { found: boolean; value?: unknown } {
  if (typeof pointer !== "string" || pointer.length > 500 || pointer !== "" && (!pointer.startsWith("/") || /~(?![01])/.test(pointer))) return { found: false };
  for (const token of pointer === "" ? [] : pointer.slice(1).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (["__proto__", "constructor", "prototype"].includes(key) || !own(value, key)) return { found: false };
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return { found: false };
    value = descriptor.value;
  }
  return { found: true, value };
}

/** Deterministic material consistency only: never infer an answer from business inputs or code. */
export function auditCaseMaterials(test: MaterialAuditInput, resolved: MaterialAuditResolved, { signal, budget = {}, maxWorkBytes = MATERIAL_AUDIT_LIMITS.workBytes }: MaterialAuditOptions = {}) {
  signal?.throwIfAborted();
  const issues: MaterialAuditIssue[] = []; let total = 0, checkedClaims = 0;
  const add = (path: string, reason: string, measurement?: MaterialAuditIssue["measurement"]) => {
    total++;
    if (issues.length < MATERIAL_AUDIT_LIMITS.issues) issues.push({ path, reason, remedy, ...(measurement ? { measurement } : {}) });
  };
  const charge = (text: string, path: string) => {
    const bytes = Buffer.byteLength(text), spent = budget.textBytes ?? 0;
    if (!Number.isSafeInteger(spent) || spent < 0 || bytes > maxWorkBytes - spent) { add(path, "material_measurement_limit"); return false; }
    budget.textBytes = spent + bytes; return true;
  };
  const checks = test.materialChecks ?? [];
  if (!Array.isArray(checks) || checks.length > MATERIAL_AUDIT_LIMITS.checks) add("materialChecks", "material_check_invalid");
  else for (const [index, candidate] of (checks as unknown[]).entries()) {
    const check = objectFields(candidate);
    signal?.throwIfAborted();
    const path = `materialChecks[${index}]`;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || check.source !== "input"
      || Object.keys(check).some((key) => !["source", "pointer", "measure", "encoding", "expected"].includes(key))
      || (typeof check.measure !== "string" || !["array-length", "utf8-bytes", "utf16-units", "sha256"].includes(check.measure))
      || (check.measure === "sha256" ? typeof check.expected !== "string" || !/^[a-f0-9]{64}$/.test(check.expected)
        : !isInteger(check.expected) || check.expected < 0)
      || (check.measure === "array-length" ? check.encoding !== undefined : (typeof check.encoding !== "string" || !["text", "json"].includes(check.encoding)))) {
      add(path, "material_check_invalid"); continue;
    }
    const selected = resolved.inputAvailable === false ? { found: false } : at(resolved.input, check.pointer);
    if (!selected.found) { add(path + ".pointer", "material_source_missing"); continue; }
    let actual;
    if (check.measure === "array-length") {
      if (!Array.isArray(selected.value)) { add(path + ".measure", "material_type_mismatch"); continue; }
      actual = selected.value.length;
    } else {
      const text = check.encoding === "json" ? JSON.stringify(selected.value) : selected.value;
      if (typeof text !== "string") { add(path + ".encoding", "material_type_mismatch"); continue; }
      if (!charge(text, path)) continue;
      actual = check.measure === "sha256" ? sha256(text) : check.measure === "utf8-bytes" ? Buffer.byteLength(text) : text.length;
    }
    checkedClaims++;
    if (actual !== check.expected) add(path + ".expected", "material_fact_mismatch", { measure: check.measure,
      ...(typeof check.encoding === "string" ? { encoding: check.encoding } : {}), actual, expected: check.expected as string | number });
  }
  for (const [index, mock] of (resolved.mocks ?? []).entries()) {
    signal?.throwIfAborted();
    const args = objectFields(mock?.args), rawValue = mock?.value, value = objectFields(rawValue);
    if (mock?.capability !== "files.write" || !rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)
      || value.saved === false || value.saved !== true && value.ok === false
      || value.saved !== true && value.ok !== true && own(value, "error") && value.error !== null) continue;
    if (typeof args?.content !== "string") { add(`mocks[${index}].argsJson.content`, "material_type_mismatch"); continue; }
    const path = `mocks[${index}].resultJson`;
    const content = args.content;
    const fields: [string, unknown][] = [["file", args.file], ["characters", content.length]];
    for (const [field, actual] of fields) if (own(value, field)) {
      checkedClaims++;
      if (value[field] !== actual) add(path + "." + field, "mock_write_metadata_mismatch");
    }
    if (own(value, "integrity")) {
      if (!value.integrity || typeof value.integrity !== "object" || Array.isArray(value.integrity)) {
        add(path + ".integrity", "mock_write_metadata_mismatch"); continue;
      }
      const metadata = objectFields(value.integrity);
      if (["sha256", "bytes", "utf16Units"].some((field) => own(metadata, field))) {
        if (!charge(args.content, path + ".integrity")) continue;
        const measurements: [string, () => string | number][] = [["sha256", () => sha256(content)], ["bytes", () => Buffer.byteLength(content)], ["utf16Units", () => content.length]];
        for (const [field, actual] of measurements) if (own(metadata, field)) {
          checkedClaims++;
          if (metadata[field] !== actual()) add(path + ".integrity." + field, "mock_write_metadata_mismatch");
        }
      }
    }
  }
  return { issues, total, retained: issues.length, truncated: total > issues.length, checkedClaims, generatedCodeExecuted: false, hostCallsExecuted: false };
}

export function assertCaseMaterials(test: MaterialAuditInput, resolved: MaterialAuditResolved, options?: MaterialAuditOptions) {
  const report = auditCaseMaterials(test, resolved, options);
  if (report.total) throw Object.assign(new InputError("测试材料声明或模拟写入回执与实际材料不一致"), {
    reason: report.issues[0]!.reason, fixtureField: report.issues[0]!.path, materialIssues: report.issues,
    materialIssueTotal: report.total, materialIssuesTruncated: report.truncated,
  });
  return report;
}
