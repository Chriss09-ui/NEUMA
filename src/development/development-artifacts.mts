import type { ValidateFunction } from "ajv";
import type { BinaryLike } from "node:crypto";
import type { ToolSchema } from "../contracts/tools.mjs";
import type { JsonValue, UnknownRecord } from "../contracts/json.mjs";
import type { DevelopmentPlan, DevelopmentCase, DevelopmentTask, DevelopmentApplication, DevelopmentArchitecture } from "../contracts/development.mjs";
import type { NeumaTool, RegisteredTool } from "../runtime/execution-port.mjs";
import type { PlanDiagnosticSource, PlanDiagnosticIssue } from "./development-plan-diagnostics.mjs";
import { objectFields, isInteger, errorField } from "../runtime/type-boundary.mjs";
interface PlanIndex extends UnknownRecord { caseFiles: string[]; activationCaseFiles?: string[] }
export type PlanningSnapshot = { agentId: string; runId: string; path: string; hash: string; files: { path: string; size: number; hash: string }[]; indexPath: string };
export type PlanningDraftSnapshot = PlanningSnapshot & { version: number; kind: string };
interface PlanningSource { path: string; hash: string; files: PlanningSnapshot["files"]; contents: Map<string, Buffer> }
interface PlanningOptions { signal?: AbortSignal | undefined; casesSchema?: ToolSchema | undefined; planSchema?: ToolSchema | undefined; schema?: ToolSchema | undefined;
  architecture?: DevelopmentArchitecture | undefined; previousPlan?: DevelopmentPlan | undefined; historicalDraft?: PlanningDraftSnapshot | null | undefined; indexPath?: string | undefined;
  freshWorkspace?: boolean; expectedHash?: unknown; offset?: number | undefined; limit?: number | undefined }
interface PlanningLocation { offset: number; line: number; column: number }
type CaseStub = UnknownRecord & { id: string; acceptanceId: string };
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { Ajv } from "ajv";
import { AgentStorage } from "../agents/agent-storage.mjs";
import { InputError } from "../requirements/core.mjs";
import { validateCodePath } from "./development-workspace.mjs";
import { restrictedNativeFileTools } from "./development-file-tools.mjs";
import { diagnosePlanningPlan, pagePlanDiagnostics, planDiagnosticLedger, planningInputFailure, planningInputRejectionFailure, planningFixtureFailure } from "./development-plan-diagnostics.mjs";
import { hashValue, activationCaseEntries } from "./development-contract.mjs";
import { validateActionInput } from "../applications/application-contract.mjs";
import { resolveCaseValues, inputContractRejection } from "./development-fixtures.mjs";
import { auditCaseMaterials, assertCaseMaterials } from "./development-test-material-audit.mjs";
import { acceptanceCaseMatches, validateAcceptanceVerification } from "../verification/acceptance-contract.mjs";
import { diagnoseApplicationManifest } from "./application-manifest-diagnostics.mjs";

export const PLAN_ARTIFACT_LIMITS = Object.freeze({ fileBytes: 2 * 1024 * 1024,
  totalBytes: 10 * 1024 * 1024, files: 201, cases: 200 });
export const PLAN_ARTIFACT_GUIDE = Object.freeze({
  index: "index.json contains ordinary plan fields except cases and activationCases. caseFiles references development case batches; optional activationCaseFiles references dedicated host-business case batches. Both use ordered relative .json paths and share the 200-case limit and global unique IDs. Every host-business acceptance has one activationChecks:{acceptanceId,caseIds,executionScope?} row referencing existing development cases or its own dedicated activationCases. Dedicated activation cases bind that host-business acceptanceId, may omit taskId, and never count as development coverage. executionScope defaults isolated; shared deliberately reuses scoped data across the exact caseIds sequence; managed-service also reuses its worker, while builtin starts a fresh isolated process per call. Original stage, cases, assertions and scope/sequence remain frozen on revision. delivery-review uses independent review evidence.",
  cases: "Prefer save_plan_cases({path,cases}) for each caseFiles batch. cases is a native nonempty array using the current public case schema, never a JSON string. The host serializes it. Replacing a valid batch must retain all existing IDs; use edit_plan_cases with the current fileHash for explicit remove/replace, never rewrite a full file with only the changed cases. At most 200 cases in total. JSON fixtures and frozen-test rules are unchanged.",
  submit: "Submit only indexPath. The host freezes the complete bundle before assembling and validating the ordinary plan; files do not bypass any plan or independent-review checks.",
  tools: "Save the task/application index skeleton first; caseFiles may temporarily be empty while drafting, but a formal submission needs cases. Once the skeleton is valid, independent case batches can use existing tools together in one reply; keep dependent operations ordered, then complete diagnostics, formal submission and independent review. Use save_plan_cases for typed case arrays to avoid escaping an entire case file inside a string. Use save_plan_json for the index; its compatibility protocol accepts structured data or complete JSON text, strictly parsed once. inputEncoding reports structured or json-text. edit_plan_cases adds, replaces, removes or reorders unfrozen draft cases by stable id and required file hash. update_plan_json replaces existing values by JSON Pointer. Native read/write/edit remain available; every planning write/edit must remain valid JSON with an object/array root, and every identified index must also satisfy the current index skeleton contract before replacement, or the previous file is preserved. read_plan_file provides exact character paging; source=previous reads only the bound untrusted historical draft, when available. restore_plan_file explicitly restores that source's same-name file with expectedSourceHash and expectedHash (current fileHash, or null only when absent); it never accepts a plan or restores code/sessions/budgets. read_plan_diagnostics pages the complete bounded independent issue ledger by bundle hash. Accepted cases are read-only to developers.",
  values: "For action inputs, assertions and mocks, an ordinary JSON value can use the existing {fixture:{op:'value',value:...}} form. This avoids hand-encoding JSON text; fixture limits and all frozen-test checks still apply.",
  limits: PLAN_ARTIFACT_LIMITS,
});
const operations = new Map<string, Promise<unknown>>();
const caseAjv = new Ajv({ strict: false, allErrors: true }), caseValidators = new WeakMap<ToolSchema, ValidateFunction<DevelopmentCase[]>>();
const indexValidators = new WeakMap<ToolSchema, { schema: ToolSchema; validate: ValidateFunction<PlanIndex> }>();
const indexAjv = new Ajv({ strict: false, allErrors: true, verbose: true });
const digest = (value: BinaryLike) => createHash("sha256").update(value).digest("hex");
const abort = (...signals: (AbortSignal | undefined)[]) => { for (const signal of signals) signal?.throwIfAborted(); };
const CASE_FILE_GROUPS = [["caseFiles", "cases"], ["activationCaseFiles", "activationCases"]] as const;

function indexContract(schema: ToolSchema | undefined) {
  if (!schema) return null;
  let contract = indexValidators.get(schema);
  if (!contract) {
    const { cases: _cases, activationCases: _activationCases, ...properties } = schema.properties ?? {};
    const references = { type: "array", minItems: 0, maxItems: PLAN_ARTIFACT_LIMITS.cases,
      items: { type: "string", minLength: 1, maxLength: 500 } };
    const definition = { ...schema, properties: { ...properties, caseFiles: references,
      ...(schema.properties?.activationCases ? { activationCaseFiles: references } : {}) },
      required: [...(schema.required ?? []).filter((key) => !["cases", "activationCases"].includes(key)), "caseFiles"] };
    contract = { schema: definition, validate: indexAjv.compile<PlanIndex>(definition) }; indexValidators.set(schema, contract);
  }
  return contract;
}

const safeField = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(value)
  && !["__proto__", "prototype", "constructor"].includes(value);
const schemaFields = (schema: ToolSchema | undefined) => ({ allowedFields: Object.keys(schema?.properties ?? {}).filter(safeField).slice(0, 32),
  requiredFields: (schema?.required ?? []).filter((key) => safeField(key) && Object.hasOwn(schema?.properties ?? {}, key)).slice(0, 32) });

function declaredIndexPath(schema: ToolSchema, pointer: string, missing?: string) {
  let current: ToolSchema | undefined = schema, path = "planningFiles.index";
  for (const part of pointer.split("/").slice(1).map((key) => key.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (current?.type === "array" && /^(0|[1-9][0-9]{0,5})$/.test(part)) { path += `[${part}]`; current = current.items; }
    else if (safeField(part) && Object.hasOwn(current?.properties ?? {}, part)) { path += `.${part}`; current = current!.properties![part]; }
    else break;
  }
  if (missing && safeField(missing) && Object.hasOwn(current?.properties ?? {}, missing)) {
    path += `.${missing}`; current = current!.properties![missing];
  }
  return { path, schema: current };
}

function indexIssues(value: unknown, schema: ToolSchema | undefined, file: string): PlanDiagnosticIssue[] {
  const contract = indexContract(schema);
  if (!contract) return [];
  const issues: PlanDiagnosticIssue[] = [];
  if (!contract.validate(value)) for (const error of contract.validate.errors ?? []) {
    const selected = declaredIndexPath(contract.schema, error.instancePath, error.params?.missingProperty);
    const rule = ["required", "type", "enum", "const", "minItems", "maxItems", "additionalProperties", "minLength", "maxLength", "pattern", "anyOf"].includes(error.keyword) ? error.keyword : "schema";
    const allowedValues = (selected.schema?.enum ?? (Object.hasOwn(selected.schema ?? {}, "const") ? [selected.schema!.const] : []))
      .filter((entry) => entry === null || typeof entry === "boolean" || typeof entry === "number" && Number.isFinite(entry)
        || typeof entry === "string" && entry.length <= 80).slice(0, 32);
    const fields = ["required", "additionalProperties"].includes(rule) ? schemaFields(error.parentSchema) : {};
    issues.push({ path: selected.path, reason: "planning_index_schema", rule, source: { path: file }, ...fields,
      ...(allowedValues.length ? { allowedValues } : {}),
      ...(typeof selected.schema?.type === "string" ? { expectedType: selected.schema.type } : {}),
      ...(rule === "minItems" ? { minimumItems: error.params.limit, ...(Array.isArray(error.data) ? { actualCount: error.data.length } : {}) } : {}),
      ...(rule === "maxItems" ? { maximumItems: error.params.limit, ...(Array.isArray(error.data) ? { actualCount: error.data.length } : {}) } : {}),
      remedy: rule === "additionalProperties" ? "索引仅使用allowedFields；cases和activationCases保存到独立批次，用caseFiles/activationCaseFiles引用，不在索引内嵌。"
        : `按当轮索引骨架补齐或修正该声明字段${allowedValues.length ? `，允许值为${JSON.stringify(allowedValues)}` : ""}；保留任务、应用和已有批次引用。草稿caseFiles可为空，正式提交前须补齐。` });
  }
  if (issues.length) return issues;
  for (const [field] of CASE_FILE_GROUPS) for (const [index, path] of ((value as PlanIndex)[field] ?? []).entries()) {
    try { planPath(path); } catch { issues.push({ path: `planningFiles.index.${field}[${index}]`, reason: "planning_material_path", source: { path: file },
      remedy: "索引只引用规划目录内的安全JSON相对路径；原文件未修改。" }); }
  }
  return issues;
}

function rejectIndex(issues: PlanDiagnosticIssue[]) {
  const diagnostic = pagePlanDiagnostics(planDiagnosticLedger(issues).result(), { limit: 40 });
  const error = new InputError("规划索引骨架无效，原文件未修改：" + JSON.stringify({ saved: false, ...diagnostic }));
  error.reason = "planning_index_invalid"; error.planningIssues = issues;
  return error;
}

function wrongHashScope(tool: string, expectedScope: string, receivedScope: string) {
  return Object.assign(new InputError("摘要作用域不匹配，材料未修改：" + JSON.stringify({ reason: "wrong_hash_scope", expectedHashScope: expectedScope,
    receivedHashScope: receivedScope, nextAction: expectedScope === "file" ? "读取目标文件的fileHash后主动重试；bundleHash不能用于单文件更新。"
      : "使用read_plan_diagnostics或正式提交回执的bundleHash；fileHash不能用于整组诊断分页。" })), {
    reason: "wrong_hash_scope", validationIssue: { path: `${tool}.expectedHash`, reason: "wrong_hash_scope" },
  });
}

async function assertFileHash(root: string, bytes: Buffer, expectedHash: unknown, tool: string) {
  if (expectedHash === undefined || expectedHash === digest(bytes)) return;
  if ((await inspect(root)).hash === expectedHash) throw wrongHashScope(tool, "file", "bundle");
  throw new InputError("规划文件已改变，请核对当前版本后再更新");
}

function assertBundleHash(source: PlanningSource, expectedHash: unknown) {
  if (expectedHash === undefined || expectedHash === source.hash) return;
  if (source.files.some((file) => file.hash === expectedHash)) throw wrongHashScope("read_plan_diagnostics", "bundle", "file");
  throw new InputError("规划材料已改变，请从第一页重新核对问题");
}

function planPath(input: unknown) {
  const value = validateCodePath(input);
  if (!value.endsWith(".json")) throw new InputError("规划材料仅允许 .json 数据文件");
  return value;
}

function runId(value: unknown) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][\w-]{0,99}$/.test(value)) throw new InputError("研发批次标识无效");
  return value;
}

async function directory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new InputError("规划目录必须是真实目录，不能包含链接");
  return realpath(path);
}

async function target(root: string, file: string, create = false) {
  planPath(file); await directory(root);
  let current = root;
  const parts = file.split("/");
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (errorField(error, "code") !== "ENOENT") throw error;
      if (index === parts.length - 1) return current;
      if (!create) throw new InputError("规划材料不存在");
      await mkdir(current, { mode: 0o700 }); info = await lstat(current);
    }
    if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())
      || (index === parts.length - 1 && (!info.isFile() || info.nlink !== 1)))
      throw new InputError("规划材料只允许普通文件，不能包含符号链接或硬链接");
  }
  return current;
}

async function readBytes(root: string, file: string) {
  const path = await target(root, file), before = await lstat(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.ino !== before.ino || info.dev !== before.dev)
      throw new InputError("规划材料类型或内容在读取时改变");
    if (info.size > PLAN_ARTIFACT_LIMITS.fileBytes) throw new InputError("规划材料单文件不能超过 2 MiB");
    const bytes = await handle.readFile();
    if (bytes.length > PLAN_ARTIFACT_LIMITS.fileBytes) throw new InputError("规划材料单文件不能超过 2 MiB");
    return bytes;
  } finally { await handle.close(); }
}

function decode(bytes: Buffer) {
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (value.includes("\0")) throw new Error("NUL");
    return value;
  } catch { throw new InputError("规划材料必须是 UTF-8 文本"); }
}

function jsonLocation(error: unknown, text: string) {
  const match = /\bposition ([0-9]+)\b/.exec(String(errorField(error, "message") ?? ""));
  const offset = match ? Number(match[1]) : /^Unexpected end of JSON input$/.test(String(errorField(error, "message") ?? "")) ? text.length : null;
  if (!isInteger(offset) || offset < 0 || offset > text.length) return undefined;
  const prefix = text.slice(0, offset);
  return { offset, line: prefix.split("\n").length, column: offset - prefix.lastIndexOf("\n") };
}

function artifactFailure(parseError: string, indexField = "index", fileIndex?: number, location?: PlanningLocation) {
  const messages: Record<string, string> = {
    json: "规划材料不是完整 JSON，请修正对应文件后再提交",
    missing: "规划索引引用了不存在的材料",
    duplicate: "规划材料包含重复引用或重复用例编号",
    path: "规划材料路径无效，必须使用规划目录内的安全 JSON 相对路径",
    shape: "规划索引或用例文件结构无效，请按已公开的规划材料契约修正",
    limit: "规划材料最多包含 200 个用例",
  };
  return Object.assign(new InputError(messages[parseError] + (location ? `（第 ${location.line} 行，第 ${location.column} 列，字符偏移 ${location.offset}）` : "")), { reason: "planning_artifact_invalid",
    artifactIssue: { indexField, ...(Number.isSafeInteger(fileIndex) ? { fileIndex } : {}), parseError,
      ...(location ? { location } : {}) } });
}

const structuredLimits = Object.freeze({ depth: 32, nodes: 100000, updates: 40 });
const jsonValueSchema = { description: "Ordinary JSON data only; no serialized JSON string is needed for the file itself." };

function copyJson(value: unknown, budget = { nodes: 0, bytes: 0 }, depth = 0): JsonValue {
  if (++budget.nodes > structuredLimits.nodes || depth > structuredLimits.depth)
    throw new InputError("结构化规划材料超过数据深度或节点额度");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new InputError("结构化规划材料只允许有限 JSON 数值");
    return value;
  }
  if (typeof value === "string") {
    budget.bytes += Buffer.byteLength(value);
    if (budget.bytes > PLAN_ARTIFACT_LIMITS.fileBytes) throw new InputError("规划材料单文件不能超过 2 MiB");
    return value;
  }
  if (!value || typeof value !== "object" || !(Array.isArray(value)
    ? Object.getPrototypeOf(value) === Array.prototype : [Object.prototype, null].includes(Object.getPrototypeOf(value))))
    throw new InputError("结构化规划材料只允许普通 JSON 数据");
  const descriptors = Object.getOwnPropertyDescriptors(value), array = Array.isArray(value);
  const result: Record<string, JsonValue> = Object.create(null), arrayResult: JsonValue[] = [];
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) throw new InputError("结构化规划材料不允许符号字段");
  if (array && (Object.getPrototypeOf(value) !== Array.prototype || Object.keys(descriptors).length !== (value as unknown[]).length + 1))
    throw new InputError("结构化规划材料不允许稀疏数组或自定义数组字段");
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (array && key === "length") continue;
    if (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable || (array && !/^(0|[1-9][0-9]*)$/.test(key)))
      throw new InputError("结构化规划材料不允许访问器或隐藏字段");
    budget.bytes += Buffer.byteLength(key);
    if (budget.bytes > PLAN_ARTIFACT_LIMITS.fileBytes) throw new InputError("规划材料单文件不能超过 2 MiB");
    const item = copyJson(descriptor.value, budget, depth + 1);
    if (array) arrayResult[Number(key)] = item; else result[key] = item;
  }
  return array ? arrayResult : result;
}

// Validate the tool envelope separately; both encodings budget the same content root.
function saveArguments(params: unknown, field = "value"): UnknownRecord & { path: string } {
  if (!params || typeof params !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(params)))
    throw new InputError("结构化规划保存只允许普通参数对象");
  const descriptors = Object.getOwnPropertyDescriptors(params), keys = Reflect.ownKeys(params);
  if (keys.length !== 2 || !["path", field].every((key) => {
    const descriptor = descriptors[key];
    return descriptor && descriptor.enumerable && Object.hasOwn(descriptor, "value");
  })) throw new InputError(`结构化规划保存只允许path和${field}普通字段`);
  const path = planPath(descriptors.path!.value);
  return { path, [field]: descriptors[field]!.value };
}

function pointers(updates: unknown) {
  if (!Array.isArray(updates) || updates.length < 1 || updates.length > structuredLimits.updates)
    throw new InputError("结构化规划更新每次须包含 1 至 40 项");
  const result = (updates as unknown[]).map((rawEntry) => {
    const entry = objectFields(rawEntry);
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry) || Object.keys(entry).length !== 2
      || !Object.hasOwn(entry, "pointer") || !Object.hasOwn(entry, "value") || typeof entry.pointer !== "string"
      || entry.pointer.length > 500 || !entry.pointer.startsWith("/") || /~(?![01])/.test(entry.pointer))
      throw new InputError("规划更新须使用有效的非空 JSON Pointer 和 value");
    const path = entry.pointer.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
    if (path.length > structuredLimits.depth || path.some((part) => ["__proto__", "prototype", "constructor"].includes(part)))
      throw new InputError("规划更新路径包含禁止字段或超过深度额度");
    return { path, value: entry.value };
  });
  for (let index = 0; index < result.length; index++) for (let previous = 0; previous < index; previous++) {
    const left = result[index]!.path, right = result[previous]!.path;
    if (left.slice(0, Math.min(left.length, right.length)).every((part, offset) => part === right[offset]))
      throw new InputError("规划更新不能包含重复或父子重叠路径");
  }
  return result;
}

function replaceJson(value: unknown, updates: unknown) {
  for (const update of pointers(updates)) {
    let parent = value;
    for (const [index, part] of update.path.entries()) {
      if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, part)
        || (Array.isArray(parent) && (!/^(0|[1-9][0-9]*)$/.test(part) || Number(part) >= parent.length)))
        throw new InputError("规划更新只允许替换已有字段或数组条目，路径不存在或越界");
      if (index === update.path.length - 1) objectFields(parent)[part] = update.value;
      else parent = objectFields(parent)[part];
    }
  }
  return value;
}

async function inspect(root: string): Promise<PlanningSource> {
  root = await directory(root);
  const files: PlanningSnapshot["files"] = [], contents = new Map<string, Buffer>();
  let total = 0;
  const walk = async (path: string, prefix = ""): Promise<void> => {
    await directory(path);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = prefix + entry.name;
      // Directories are checked separately; only the leaf needs a .json suffix.
      validateCodePath(file);
      if (entry.isSymbolicLink()) throw new InputError("规划材料不能包含链接");
      if (entry.isDirectory()) { await walk(join(path, entry.name), `${file}/`); continue; }
      planPath(file);
      if (!entry.isFile()) throw new InputError("规划材料只能包含普通文件");
      const bytes = await readBytes(root, file); decode(bytes); total += bytes.length;
      if (files.length >= PLAN_ARTIFACT_LIMITS.files || total > PLAN_ARTIFACT_LIMITS.totalBytes)
        throw new InputError("规划材料超过 201 个文件或 10 MiB 总量限制");
      files.push({ path: file, size: bytes.length, hash: digest(bytes) }); contents.set(file, bytes);
    }
  };
  await walk(root); files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { path: root, files, contents, hash: digest(JSON.stringify(files)) };
}

function assemble(contents: Map<string, Buffer>, indexPath: string): UnknownRecord & { cases: UnknownRecord[]; activationCases?: UnknownRecord[] } {
  const parse = (path: string, indexField = "index", fileIndex?: number): unknown => {
    const bytes = contents.get(path);
    if (!bytes) throw artifactFailure("missing", indexField, fileIndex);
    const text = decode(bytes);
    try { return JSON.parse(text); }
    catch (error) { throw artifactFailure("json", indexField, fileIndex, jsonLocation(error, text)); }
  };
  const rawIndex = parse(indexPath), index = objectFields(rawIndex);
  if (!rawIndex || typeof rawIndex !== "object" || Array.isArray(rawIndex) || Object.hasOwn(index, "cases") || Object.hasOwn(index, "activationCases")
    || !Array.isArray(index.caseFiles) || index.caseFiles.length < 1 || index.caseFiles.length > PLAN_ARTIFACT_LIMITS.cases)
    throw artifactFailure("shape");
  if (index.activationCaseFiles !== undefined && !Array.isArray(index.activationCaseFiles)) throw artifactFailure("shape", "activationCaseFiles");
  const references = new Set<string>(), groups: { cases: UnknownRecord[]; activationCases: UnknownRecord[] } = { cases: [], activationCases: [] }, ids = new Set<string>();
  let count = 0;
  for (const [fileField, caseField] of CASE_FILE_GROUPS) for (const [fileIndex, rawPath] of ((index[fileField] ?? []) as unknown[]).entries()) {
    let path: string; try { path = planPath(rawPath); } catch { throw artifactFailure("path", fileField, fileIndex); }
    if (references.has(planPath(path)) || path === indexPath) throw artifactFailure("duplicate", fileField, fileIndex);
    references.add(planPath(path));
    const value = parse(planPath(path), fileField, fileIndex), batch = Array.isArray(value) ? value : [value];
    if (!batch.length) throw artifactFailure("shape", fileField, fileIndex);
    for (const entry of batch) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw artifactFailure("shape", fileField, fileIndex);
      if (typeof objectFields(entry).id === "string" && ids.has(String(objectFields(entry).id))) throw artifactFailure("duplicate", fileField, fileIndex);
      if (typeof objectFields(entry).id === "string") ids.add(String(objectFields(entry).id));
      groups[caseField].push(objectFields(entry));
      if (++count > PLAN_ARTIFACT_LIMITS.cases) throw artifactFailure("limit", fileField, fileIndex);
    }
  }
  const { caseFiles: _caseFiles, activationCaseFiles: _activationCaseFiles, ...plan } = index;
  return { ...plan, cases: groups.cases, ...(index.activationCaseFiles === undefined ? {} : { activationCases: groups.activationCases }) };
}

function diagnoseBundle(source: PlanningSource, indexPath: string, { schema, architecture, previousPlan, freshWorkspace = false, offset, limit }: PlanningOptions = {}) {
  const initialIssues: PlanDiagnosticIssue[] = [], cases: UnknownRecord[] = [], activationCases: UnknownRecord[] = [], sources: PlanDiagnosticSource[] = [], activationSources: PlanDiagnosticSource[] = [];
  const indexedPaths = new Set([indexPath]);
  const add = (path: string, reason: string, extra: Partial<PlanDiagnosticIssue> = {}) => initialIssues.push({ path, reason, ...extra });
  const parse = (path: string, field: string, fileIndex?: number): unknown => {
    const bytes = source.contents.get(path), location = { path, ...(fileIndex === undefined ? {} : { fileIndex }) };
    if (!bytes) { add(field, "planning_material_missing", { source: location, remedy: "补齐该索引或已引用的用例文件；先保存任务与动作契约骨架，再逐批补齐用例。" }); return; }
    const text = decode(bytes);
    try { return JSON.parse(text); }
    catch (error) { add(field, "planning_material_json", { source: location, ...(jsonLocation(error, text) ? { location: jsonLocation(error, text) } : {}), remedy: "修正该文件的JSON语法；其他可读取材料仍已独立检查。" }); }
  };
  const rawIndex = parse(indexPath, "planningFiles.index"), index = objectFields(rawIndex);
  const skeletonIssues = rawIndex === undefined ? [] : indexIssues(rawIndex, schema, indexPath);
  initialIssues.push(...skeletonIssues);
  let plan;
  if (!rawIndex || typeof rawIndex !== "object" || Array.isArray(rawIndex) || Object.hasOwn(index, "cases") || Object.hasOwn(index, "activationCases") || !Array.isArray(index.caseFiles)
    || index.activationCaseFiles !== undefined && !Array.isArray(index.activationCaseFiles)) {
    if (rawIndex !== undefined && !skeletonIssues.length) add("planningFiles.index", "planning_material_shape", { source: { path: indexPath }, remedy: "索引保存任务、应用契约和有序caseFiles；不在索引内嵌cases。" });
  } else {
    if (!index.caseFiles.length) add("planningFiles.caseFiles", "planning_material_missing", { source: { path: indexPath }, remedy: "任务和动作骨架已保存；按骨架补齐用例文件并加入caseFiles，再正式提交。" });
    if (index.caseFiles.length > PLAN_ARTIFACT_LIMITS.cases) add("planningFiles.caseFiles", "planning_material_limit", { remedy: "用例文件和总用例均不能超过200；保留全部必要边界并合并合理批次。" });
    const seen = new Map();
    for (const [fileField, caseField] of CASE_FILE_GROUPS) for (const [fileIndex, rawPath] of ((index[fileField] ?? []) as unknown[]).slice(0, PLAN_ARTIFACT_LIMITS.cases).entries()) {
      const targetCases = caseField === "cases" ? cases : activationCases, targetSources = caseField === "cases" ? sources : activationSources;
      const field = `planningFiles.${fileField}[${fileIndex}]`;
      let path: string; try { path = planPath(rawPath); } catch { add(field, "planning_material_path", { remedy: "只引用规划目录内的安全JSON相对路径。" }); continue; }
      try { planPath(path); } catch { add(field, "planning_material_path", { remedy: "只引用规划目录内的安全JSON相对路径。" }); continue; }
      indexedPaths.add(path);
      if (seen.has(path) || path === indexPath) {
        add(field, "planning_material_duplicate", { source: { path, fileIndex }, ...(seen.has(path) ? { relatedSources: [{ path, fileIndex: seen.get(path) }] } : {}), remedy: "同一用例文件只引用一次，且不得把索引本身作为用例文件。" }); continue;
      }
      seen.set(path, fileIndex);
      const value = parse(path, field, fileIndex);
      if (value === undefined) continue;
      const batch = Array.isArray(value) ? value : [value];
      if (!batch.length) add(field, "planning_material_shape", { source: { path, fileIndex }, remedy: "已引用的用例文件必须包含一个用例对象或非空用例数组。" });
      if (cases.length + activationCases.length + batch.length > PLAN_ARTIFACT_LIMITS.cases) add(field, "planning_material_limit", { source: { path, fileIndex }, remedy: "研发与激活专用批次合计最多200个用例；不能缩小业务测试范围。" });
      for (const [localIndex, entry] of batch.slice(0, Math.max(0, PLAN_ARTIFACT_LIMITS.cases - cases.length - activationCases.length)).entries()) {
        const location: PlanDiagnosticSource & { fileIndex: number; caseHash?: string } = { path, fileIndex, localIndex, ...(typeof objectFields(entry).id === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(String(objectFields(entry).id)) ? { caseId: String(objectFields(entry).id) } : {}) };
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) { add(field, "planning_material_shape", { source: location }); continue; }
        location.caseHash = hashValue(entry);
        targetCases.push(objectFields(entry)); targetSources.push(location);
      }
    }
    const { caseFiles: _caseFiles, activationCaseFiles: _activationCaseFiles, ...ordinary } = index;
    plan = { ...ordinary, cases, ...(index.activationCaseFiles === undefined ? {} : { activationCases }) };
  }
  const ledger = plan && schema ? diagnosePlanningPlan(plan, schema, { architecture, previousPlan, freshWorkspace, sources, activationSources,
    indexSource: { path: indexPath }, initialIssues }) : planDiagnosticLedger(initialIssues).result();
  const unreferenced = source.files.filter((file) => !indexedPaths.has(file.path));
  return { ...(plan ? { plan } : {}), hash: source.hash, bundleHash: source.hash, hashScope: "bundle", files: source.files, sources, activationSources,
    status: ledger.total ? initialIssues.some((entry) => entry.reason === "planning_material_missing") ? "incomplete" : "rejected" : "valid",
    diagnostics: { ...pagePlanDiagnostics(ledger, { offset, limit }), ...(unreferenced.length ? { directoryNotice: {
      unreferencedFiles: unreferenced.slice(0, 10).map(({ path }) => path), unreferencedFilesTotal: unreferenced.length,
      unreferencedFilesTruncated: unreferenced.length > 10,
      message: "这些JSON文件存在于规划目录，但未被当前索引引用；不会自动进入cases或activationCases。不判断它们是否为必需用例；主动更新完整引用数组时保留仍需要的原批次。",
    } } : {}) } };
}

function caseEntries(contents: Map<string, Buffer>, path: string): { entry: CaseStub; source: PlanDiagnosticSource }[] {
  const bytes = contents.get(path);
  if (!bytes) return [];
  let value: unknown;
  try { value = JSON.parse(decode(bytes)); } catch { return []; }
  if (value && !Array.isArray(value) && Array.isArray(objectFields(value).caseFiles)) return [];
  const entries: unknown[] = Array.isArray(value) ? value : [value];
  return entries.flatMap((rawEntry, localIndex) => {
    const entry = objectFields(rawEntry);
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry) || typeof entry.id !== "string" || typeof entry.acceptanceId !== "string") return [];
    return [{ entry: entry as CaseStub, source: { path, localIndex, caseId: entry.id } }];
  });
}

function checkCaseIds(source: PlanningSource, path: string, cases: DevelopmentCase[]) {
  const referenced = new Set<string>();
  for (const bytes of source.contents.values()) {
    let index: UnknownRecord;
    try { index = objectFields(JSON.parse(decode(bytes))); } catch { continue; }
    if (index && !Array.isArray(index) && Array.isArray(index.caseFiles))
      for (const file of [...index.caseFiles, ...(Array.isArray(index.activationCaseFiles) ? index.activationCaseFiles : [])]) try { referenced.add(planPath(file)); } catch { /* Invalid references are diagnosed separately. */ }
  }
  const seen = new Map<string, { entry: { id: string }; source: PlanDiagnosticSource }>();
  for (const file of referenced) if (file !== path) for (const item of caseEntries(source.contents, file)) if (!seen.has(item.entry.id)) seen.set(item.entry.id, item);
  for (const [localIndex, entry] of cases.entries()) {
    const location = { path, localIndex, caseId: entry.id };
    if (seen.has(entry.id)) {
      const previous = seen.get(entry.id)!;
      const error = new InputError("用例编号与现有材料重复；已保留原文件，请核对两个位置而非自动去重");
      error.reason = "planning_case_duplicate";
      error.planningIssues = [{ reason: "duplicate_id", path: `planningFiles.cases[${localIndex}].id`, source: location,
        relatedSources: [previous.source], referenceId: entry.id, duplicateConflict: hashValue(previous.entry) !== hashValue(entry),
        remedy: "核对两个位置的输入与断言；不同场景须采用不同稳定编号，不能自动删除或改变预期。" }];
      error.message += "：" + JSON.stringify({ saved: false, issues: error.planningIssues });
      throw error;
    }
    seen.set(entry.id, { entry, source: location });
  }
}

function assertBatchIdsPreserved(source: PlanningSource, path: string, cases: DevelopmentCase[], validateCases: ValidateFunction<DevelopmentCase[]>) {
  const bytes = source.contents.get(path);
  if (!bytes) return;
  let previous: unknown;
  try { previous = JSON.parse(decode(bytes)); } catch { return; }
  const existing = Array.isArray(previous) ? previous : [previous];
  if (!validateCases(existing)) return;
  const present = new Set(cases.map((entry) => entry.id));
  const missing = [...new Set(existing.map((entry) => entry.id))].filter((id) => !present.has(id));
  if (!missing.length) return;
  const error = new InputError("整批覆盖将遗漏已有用例，原文件未修改：" + JSON.stringify({ saved: false, reason: "planning_case_loss",
    path, fileHash: digest(bytes), hashScope: "file", missingIds: missing,
    nextAction: "先读取当前文件；只改少量用例时用edit_plan_cases及当前fileHash明确replace/remove，不自动合并、删减或改断言。" }));
  error.reason = "planning_case_loss";
  error.planningIssues = [{ path: "planningFiles.cases", reason: "planning_case_loss", source: { path },
    remedy: "整批保存须保留已有稳定编号；使用edit_plan_cases按当前fileHash显式替换或删除，不以局部数组覆盖完整批次。" }];
  throw error;
}

function checkCaseDraft(source: PlanningSource, path: string, cases: DevelopmentCase[], { schema, architecture }: PlanningOptions) {
  if (!schema || !architecture) return;
  const indexes: { file: string; value: UnknownRecord; caseField: "cases" | "activationCases" }[] = [];
  for (const [file, bytes] of source.contents) {
    let value: unknown;
    try { value = JSON.parse(decode(bytes)); } catch { continue; }
    const fields = objectFields(value);
    if (value && !Array.isArray(value) && Array.isArray(fields.caseFiles)) for (const [fileField, caseField] of CASE_FILE_GROUPS)
      if (Array.isArray(fields[fileField]) && (fields[fileField] as unknown[]).includes(path)) indexes.push({ file, value: fields, caseField });
  }
  let checkedIndex: { tasks: DevelopmentTask[]; application: DevelopmentApplication; runtime: string } | undefined;
  const reject = (issues: PlanDiagnosticIssue[], diagnostic?: { total: number; retained: number; truncated: boolean }): never => {
    const tasks = checkedIndex?.tasks ?? [];
    const taskAssignments = issues.some((entry) => entry.reason === "invalid_reference") ? {
      allowedTaskIds: tasks.map((task) => task.id), tasks: tasks.slice(0, 12).map((task) => ({ taskId: task.id,
        requirementIds: task.requirementIds.slice(0, 16), requirementCount: task.requirementIds.length,
        acceptanceIds: task.acceptanceIds.slice(0, 16), acceptanceCount: task.acceptanceIds.length })),
      taskCount: tasks.length, truncated: tasks.length > 12 || tasks.some((task) => task.requirementIds.length > 16 || task.acceptanceIds.length > 16),
    } : undefined;
    const error = new InputError("草稿用例尚不符合已保存骨架，原文件未修改：" + JSON.stringify({ saved: false, issues,
      ...(taskAssignments ? { taskAssignments } : {}),
      ...(diagnostic ? { subject: "planning-index-application", total: diagnostic.total, retained: diagnostic.retained, truncated: diagnostic.truncated } : {}) }));
    error.reason = "planning_case_invalid"; error.planningIssues = issues; throw error;
  };
  if (indexes.length !== 1) reject([{ path: "planningFiles.index", reason: "planning_index_required",
    remedy: "先保存完整任务与应用契约骨架，并让唯一索引的caseFiles引用本文件；不要先生成大量脱离动作契约的用例。" }]);
  const skeletonIssues = indexIssues(indexes[0]!.value, schema, indexes[0]!.file);
  if (skeletonIssues.length) reject(skeletonIssues);
  checkedIndex = indexes[0]!.value as PlanIndex & { tasks: DevelopmentTask[]; application: DevelopmentApplication; runtime: string };
  const { caseFiles, activationCaseFiles, ...ordinary } = indexes[0]!.value;
  const skeleton = { ...ordinary, tasks: checkedIndex.tasks, application: checkedIndex.application, runtime: checkedIndex.runtime, cases: [],
    ...(activationCaseFiles === undefined ? {} : { activationCases: [] }) };
  const caseField = indexes[0]!.caseField, caseSchema = schema.properties?.[caseField];
  if (!caseSchema || !caseAjv.compile({ ...caseSchema, minItems: 0 })(cases)) reject([{ path: `planningFiles.${caseField}`,
    reason: "case_schema_invalid", source: { path }, remedy: "用例批次须符合其索引分组的公开结构；激活专用用例不要求taskId，只绑定host-business。" }]);
  const applicationDiagnostic = diagnoseApplicationManifest(skeleton.application, { schema: schema.properties?.application, plan: skeleton });
  const issues: PlanDiagnosticIssue[] = [], fixtureBudget = { bytes: 0 }, actionList = skeleton.application.service?.operations ?? skeleton.application.actions;
  for (const [localIndex, entry] of cases.entries()) {
    const location = { path, localIndex, caseId: entry.id }, casePath = `planningFiles.${caseField}[${localIndex}]`;
    const issue = (field: string, reason: string, remedy?: string) => issues.push({ path: casePath + field, source: location, reason, remedy });
    if (caseField === "cases") {
      const task = skeleton.tasks.find((item) => item.id === entry.taskId);
      if (!task) issue(".taskId", "invalid_reference", "taskId须精确引用当前索引已有任务；先读取骨架，不创建不存在的任务编号。");
      else if (!task.acceptanceIds.includes(entry.acceptanceId)) issue(".acceptanceId", "invalid_reference", "当前验收须分配给所引用任务；核对任务acceptanceIds，不把用例移到无关任务。");
    }
    if (entry.kind === "node-check") {
      if (!skeleton.application.page) issue(".kind", "node_check_invalid", "当前应用没有页面，node-check不能代替业务动作或宿主验收。选择实际责任对应的验收方式，不自动转换或修改断言。");
      for (const entryIssue of auditCaseMaterials(entry, { input: entry.input, mocks: [] }, { budget: fixtureBudget }).issues)
        issue("." + entryIssue.path, entryIssue.reason, entryIssue.remedy);
      continue;
    }
    const action = actionList.find((item) => item.id === entry.actionId);
    if (!action) { issue(".actionId", "action_missing", "先在已保存骨架声明真实动作，再按该动作契约设计用例。"); continue; }
    const acceptance = architecture.design?.acceptance?.find((item) => item.id === entry.acceptanceId);
    let matches = false;
    try { matches = caseField === "activationCases" ? validateAcceptanceVerification(acceptance).adapterId === "host-business"
      && skeleton.application.actions.some((item) => item.id === entry.actionId) : acceptanceCaseMatches(acceptance, entry); } catch { /* Report the fixed reference location below. */ }
    if (!matches) issue(".acceptanceId", "acceptance_adapter_mismatch", "按本分组绑定真实验收：cases只用于研发，activationCases只绑定自身host-business及公开动作。不可迁移验收阶段。");
    let resolved;
    try { resolved = resolveCaseValues(entry, { maxInputBytes: skeleton.runtime === "managed-service" ? 1024 * 1024 : 128 * 1024, fixtureBudget }); }
    catch (error) {
      if (Array.isArray(objectFields(error).materialIssues)) {
        for (const rawIssue of objectFields(error).materialIssues as unknown[]) { const entry = objectFields(rawIssue); issue("." + entry.path, String(entry.reason), typeof entry.remedy === "string" ? entry.remedy : undefined); }
        continue;
      }
      const field = /^(?:input|mocks\[(?:0|[1-9][0-9]?)\]\.(?:argsJson|resultJson)|assertions\[(?:0|[1-9][0-9]?)\]\.expectedJson)$/.test(String(errorField(error, "fixtureField") ?? "")) ? `.${errorField(error, "fixtureField")}` : "";
      const failure = planningFixtureFailure(errorField(error, "reason"));
      issue(field, failure.reason, failure.remedy); continue;
    }
    let accepted = true;
    if (entry.kind === "input-rejection") accepted = !inputContractRejection(action, resolved.input, { target: entry.inputTarget }).rejected;
    else try { validateActionInput(action, resolved.input); } catch { accepted = false; }
    if (entry.kind === "input-rejection" ? accepted : !accepted) {
      const failure = entry.kind === "input-rejection" ? planningInputRejectionFailure(entry, action, resolved.input)
        : planningInputFailure(entry, resolved.input);
      issue(entry.kind === "input-rejection" ? ".kind" : ".input", failure.reason, failure.remedy);
    }
  }
  if (issues.length) reject(issues);
  return applicationDiagnostic.valid ? null : { status: "rejected", scope: "index-application", ...applicationDiagnostic,
    issues: applicationDiagnostic.issues.map((entry) => ({ ...entry, source: { path: indexes[0]!.file } })),
    message: "仅保存了当前局部用例草稿；索引应用仍有问题，尚未提交或通过。按来源修正后仍须完整检查与独立评审。" };
}

async function seal(path: string, mode: number): Promise<void> {
  if (mode === 0o700) await chmod(path, mode);
  for (const entry of await readdir(path, { withFileTypes: true }))
    if (entry.isDirectory() && !entry.isSymbolicLink()) await seal(join(path, entry.name), mode);
  if (mode !== 0o700) await chmod(path, mode);
}

async function freezeBundle(source: PlanningSource, parent: string, signal?: AbortSignal) {
  const path = join(parent, source.hash);
  let frozen;
  try { frozen = await inspect(path); }
  catch (error) {
    if (errorField(error, "code") !== "ENOENT") throw error;
    const temporary = join(parent, `pending-${randomUUID()}`); await mkdir(temporary, { mode: 0o700 });
    try {
      for (const file of source.files) {
        abort(signal); const destination = join(temporary, file.path); await mkdir(dirname(destination), { mode: 0o700, recursive: true });
        await writeFile(destination, source.contents.get(file.path)!, { mode: 0o444, flag: "wx" });
      }
      await seal(temporary, 0o555); abort(signal);
      try { await rename(temporary, path); }
      catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes(String(errorField(error, "code")))) throw error; }
    } finally {
      try { await seal(temporary, 0o700); await rm(temporary, { recursive: true, force: true }); }
      catch (error) { if (errorField(error, "code") !== "ENOENT") throw error; }
    }
    frozen = await inspect(path);
  }
  if (frozen.hash !== source.hash) throw new InputError("规划材料快照校验失败");
  abort(signal);
  return { path, frozen };
}

export class DevelopmentArtifacts {
  storage: Pick<AgentStorage, "directory">;
  indexContracts: Map<string, { schema: ToolSchema; paths: Set<string> }>;
  constructor({ dataDir, storage }: { dataDir?: string; storage?: Pick<AgentStorage, "directory"> }) {
    if (!dataDir && !storage) throw new InputError("缺少研发存储目录");
    this.storage = storage ?? new AgentStorage({ dataDir: dataDir! });
    this.indexContracts = new Map();
  }

  bindIndex(root: string, schema: ToolSchema | undefined, indexPath: unknown) {
    if (!schema) return;
    let bound = this.indexContracts.get(root);
    if (!bound || bound.schema !== schema) {
      bound = { schema, paths: new Set(["index.json"]) }; this.indexContracts.set(root, bound);
    }
    if (indexPath !== undefined) bound.paths.add(planPath(indexPath));
  }

  async directory(agentId: string, id: string, { create = true } = {}) {
    return this.storage.directory(agentId, `development/workspaces/${runId(id)}/planning`, { create });
  }

  async serial<T>(agentId: string, id: string, operation: (root: string) => Promise<T>, { create = true } = {}): Promise<T> {
    const root = await this.directory(agentId, id, { create });
    const pending = (operations.get(root) ?? Promise.resolve()).then(() => operation(root));
    const settled = pending.catch(() => {}); operations.set(root, settled);
    settled.finally(() => { if (operations.get(root) === settled) operations.delete(root); });
    return pending;
  }

  async write(root: string, file: string, content: unknown, { signal }: PlanningOptions = {}) {
    planPath(file); abort(signal);
    if (typeof content !== "string" || content.includes("\0") || Buffer.byteLength(content) > PLAN_ARTIFACT_LIMITS.fileBytes)
      throw new InputError("规划材料必须是 UTF-8 文本且单文件不超过 2 MiB");
    const text = decode(Buffer.from(content));
    let value: unknown;
    try { value = JSON.parse(text); }
    catch (error) { throw artifactFailure("json", "index", undefined, jsonLocation(error, text)); }
    if (!value || typeof value !== "object") throw artifactFailure("shape");
    const current = await inspect(root), previous = current.files.find((entry) => entry.path === file);
    const bound = this.indexContracts.get(root);
    if (bound) {
      const claimsIndex = (entry: unknown) => entry && !Array.isArray(entry) && ["caseFiles", "activationCaseFiles"].some((key) => Object.hasOwn(objectFields(entry), key));
      let former: unknown;
      try { if (current.contents.has(file)) former = JSON.parse(decode(current.contents.get(file)!)); } catch { /* A bound invalid index can be repaired by a complete write. */ }
      if (bound.paths.has(file) || claimsIndex(value) || claimsIndex(former)) {
        bound.paths.add(file);
        const issues = indexIssues(value, bound.schema, file);
        if (issues.length) throw rejectIndex(issues);
      }
    }
    const size = Buffer.byteLength(content);
    if ((!previous && current.files.length >= PLAN_ARTIFACT_LIMITS.files)
      || current.files.reduce((sum, entry) => sum + entry.size, 0) - (previous?.size ?? 0) + size > PLAN_ARTIFACT_LIMITS.totalBytes)
      throw new InputError("规划材料超过 201 个文件或 10 MiB 总量限制");
    const destination = await target(root, file, true), temporary = join(dirname(destination), `.write-${randomUUID()}`);
    try {
      await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
      abort(signal); await target(root, file); abort(signal); await rename(temporary, destination);
    } finally { await rm(temporary, { force: true }); }
  }

  async tools(agentId: string, id: string, { signal, casesSchema, planSchema, architecture, previousPlan, historicalDraft, indexPath, freshWorkspace = false }: PlanningOptions = {}): Promise<RegisteredTool[]> {
    if (casesSchema?.type !== "array" || casesSchema.minItems !== 1 || casesSchema.maxItems !== PLAN_ARTIFACT_LIMITS.cases || !casesSchema.items)
      throw new InputError("规划工具缺少当前公开用例结构");
    const writableCasesSchema: ToolSchema = planSchema?.properties?.activationCases ? { ...casesSchema,
      items: { anyOf: [casesSchema.items, planSchema.properties!.activationCases!.items!] } } : casesSchema;
    let validateCases = caseValidators.get(writableCasesSchema);
    if (!validateCases) { validateCases = caseAjv.compile<DevelopmentCase[]>(writableCasesSchema); caseValidators.set(writableCasesSchema, validateCases); }
    const root = await this.directory(agentId, id), lock = <T,>(operation: () => Promise<T>) => this.serial(agentId, id, operation);
    const history = historicalDraft && !previousPlan ? structuredClone(historicalDraft) : null;
    if (history) await this.draftSource(history!, agentId, id, { signal });
    this.bindIndex(root, planSchema, indexPath ?? history?.indexPath);
    const native = await restrictedNativeFileTools({ root, lock, signal, validatePath: planPath,
      readFile: async (path, options) => { abort(signal, options?.signal); return readBytes(root, planPath(path)); },
      writeFile: (path, content, options) => this.write(root, path, content, options),
    });
    const tool = (name: string, description: string, parameters: ToolSchema, action: (params: UnknownRecord, options: PlanningOptions) => Promise<unknown>): NeumaTool => ({ name, label: description, description, parameters,
      executionMode: "sequential", execute: async (_callId, params, toolSignal) => lock(async () => {
        abort(signal, toolSignal);
        const activeSignal = signal && toolSignal ? AbortSignal.any([signal, toolSignal]) : signal ?? toolSignal;
        const value = await action(objectFields(params), { signal: activeSignal }); abort(signal, toolSignal);
        return { content: [{ type: "text", text: JSON.stringify(value) }], details: {} };
      }) });
    return [...native,
      tool("save_plan_cases", "保存当前公开结构的用例批次；cases直接传非空数组，不传JSON字符串，由宿主序列化", {
        type: "object", properties: { path: { type: "string" }, cases: writableCasesSchema }, required: ["path", "cases"], additionalProperties: false,
      }, async (params, options) => {
        const safe = saveArguments(params, "cases"), cases = copyJson(safe.cases);
        if (!Array.isArray(cases) || !validateCases(cases))
          throw new InputError("save_plan_cases.cases须为符合当前公开用例结构的非空数组，最多200例；不接受JSON字符串，不改写用例内容");
        const source = await inspect(root);
        checkCaseIds(source, planPath(safe.path), cases);
        const indexDiagnostics = checkCaseDraft(source, planPath(safe.path), cases, { schema: planSchema, architecture });
        assertBatchIdsPreserved(source, safe.path, cases, validateCases);
        const content = JSON.stringify(cases, null, 2) + "\n";
        await this.write(root, planPath(safe.path), content, options);
        return { path: safe.path, hash: digest(content), fileHash: digest(content), hashScope: "file", bytes: Buffer.byteLength(content), serialized: true, inputEncoding: "structured", caseCount: cases.length,
          ...(indexDiagnostics ? { indexDiagnostics } : {}) };
      }),
      tool("save_plan_json", "保存规划JSON对象/数组或完整JSON文本；文本严格解析一次，宿主统一安全序列化", {
        type: "object", properties: { path: { type: "string" }, value: {
          description: "A structured JSON object/array, or complete JSON text encoding an object/array. JSON text is strictly parsed exactly once, never repaired. The result passes the same limits and validation. inputEncoding reports the accepted format.",
          anyOf: [{ type: "object", additionalProperties: true }, { type: "array", items: {} }, { type: "string", maxLength: PLAN_ARTIFACT_LIMITS.fileBytes }] } },
        required: ["path", "value"], additionalProperties: false,
      }, async (params, options) => {
        const safe = saveArguments(params);
        const inputEncoding = typeof safe.value === "string" ? "json-text" : "structured";
        let value = safe.value;
        if (typeof value === "string") {
          if (Buffer.byteLength(value) > PLAN_ARTIFACT_LIMITS.fileBytes) throw new InputError("规划材料单文件不能超过 2 MiB");
          try { value = JSON.parse(value); }
          catch (error) { throw artifactFailure("json", "index", undefined, jsonLocation(error, String(safe.value))); }
        }
        value = copyJson(value);
        if (!value || typeof value !== "object") throw new InputError(`save_plan_json.value [type]：规划文件须保存JSON对象或数组；JSON文本只解码一次，${inputEncoding === "json-text" ? "解码后" : "当前"}根类型为${value === null ? "null" : typeof value}，不能保存基本值`);
        const content = JSON.stringify(value, null, 2) + "\n";
        await this.write(root, planPath(safe.path), content, options);
        return { path: safe.path, hash: digest(content), fileHash: digest(content), hashScope: "file", bytes: Buffer.byteLength(content), serialized: true, inputEncoding,
          planningIndex: Array.isArray(objectFields(value).caseFiles) };
      }),
      tool("update_plan_json", "按JSON Pointer替换已有规划字段或用例；不删减冻结验收，宿主重新序列化", {
        type: "object", properties: { path: { type: "string" }, expectedHash: { type: "string", pattern: "^[a-f0-9]{64}$", description: "目标path当前单文件fileHash（hashScope=file）；不可使用正式提交或诊断的bundleHash。" },
          updates: { type: "array", minItems: 1, maxItems: structuredLimits.updates, items: { type: "object", properties: {
            pointer: { type: "string", minLength: 1, maxLength: 500 }, value: jsonValueSchema }, required: ["pointer", "value"], additionalProperties: false } } },
        required: ["path", "updates"], additionalProperties: false,
      }, async (params, options) => {
        const safe = objectFields(copyJson(params)), bytes = await readBytes(root, planPath(safe.path)), text = decode(bytes);
        if (Object.keys(safe).some((key) => !["path", "updates", "expectedHash"].includes(key))) throw new InputError("结构化规划更新含未声明字段");
        await assertFileHash(root, bytes, safe.expectedHash, "update_plan_json");
        let value: unknown;
        try { value = JSON.parse(text); }
        catch (error) { throw artifactFailure("json", "index", undefined, jsonLocation(error, text)); }
        const content = JSON.stringify(copyJson(replaceJson(value, safe.updates)), null, 2) + "\n";
        await this.write(root, planPath(safe.path), content, options);
        return { path: safe.path, hash: digest(content), fileHash: digest(content), hashScope: "file", bytes: Buffer.byteLength(content), updated: objectFields(safe.updates).length };
      }),
      tool("edit_plan_cases", "按稳定用例编号和当前文件摘要增、改、删或重排未冻结草稿；不自动去重或改断言", {
        type: "object", additionalProperties: false, required: ["path", "expectedHash", "changes"], properties: {
          path: { type: "string" }, expectedHash: { type: "string", pattern: "^[a-f0-9]{64}$", description: "目标用例文件当前fileHash（hashScope=file），不是整组bundleHash。" },
          changes: { type: "array", minItems: 1, maxItems: structuredLimits.updates, items: {
            type: "object", additionalProperties: false, required: ["op", "id"], properties: {
              op: { type: "string", enum: ["add", "replace", "remove", "move"] }, id: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,79}$" },
              case: writableCasesSchema.items!, beforeId: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,79}$" },
              expectedCaseHash: { type: "string", pattern: "^[a-f0-9]{64}$", description: "目标单用例的caseHash（hashScope=case），不是fileHash或bundleHash。" }, localIndex: { type: "integer", minimum: 0, maximum: 199 },
            },
          } },
        },
      }, async (params, options) => {
        const safe = objectFields(copyJson(params));
        if (!safe || typeof safe !== "object" || Array.isArray(safe) || Object.keys(safe).some((key) => !["path", "expectedHash", "changes"].includes(key))
          || !/^[a-f0-9]{64}$/.test(String(safe.expectedHash ?? "")) || !Array.isArray(safe.changes) || !safe.changes.length || safe.changes.length > structuredLimits.updates)
          throw new InputError("用例局部修改须提供文件路径、当前expectedHash与1至40项changes");
        const bytes = await readBytes(root, planPath(safe.path));
        await assertFileHash(root, bytes, safe.expectedHash, "edit_plan_cases");
        let value: unknown;
        try { value = JSON.parse(decode(bytes)); } catch { throw new InputError("用例文件不是完整JSON，未修改材料"); }
        let cases: unknown[] = Array.isArray(value) ? value : [value];
        if (cases.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry) || typeof objectFields(entry).id !== "string"))
          throw new InputError("局部用例修改只操作用例对象或用例对象数组");
        for (const rawChange of safe.changes as unknown[]) {
          const change = objectFields(rawChange);
          if (!change || typeof change !== "object" || Object.keys(change).some((key) => !["op", "id", "case", "beforeId", "expectedCaseHash", "localIndex"].includes(key))
            || (typeof change.op !== "string" || !["add", "replace", "remove", "move"].includes(change.op)) || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(String(change.id ?? ""))
            || change.beforeId !== undefined && !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(String(change.beforeId))
            || change.expectedCaseHash !== undefined && !/^[a-f0-9]{64}$/.test(String(change.expectedCaseHash))
            || change.localIndex !== undefined && (!isInteger(change.localIndex) || change.localIndex < 0 || change.localIndex > 199))
            throw new InputError("用例局部修改包含未声明字段或无效编号、位置与摘要");
          const matches = cases.flatMap((entry, index) => objectFields(entry).id === change.id
            && (change.expectedCaseHash === undefined || hashValue(entry) === change.expectedCaseHash)
            && (change.localIndex === undefined || index === change.localIndex) ? [index] : []);
          if (change.op === "add" ? cases.some((entry) => objectFields(entry).id === change.id) : matches.length !== 1)
            throw new InputError("新增编号必须不存在；修改目标须唯一。重复编号可结合诊断位置localIndex或expectedCaseHash精确选择");
          if (["remove", "replace"].includes(change.op) && activationCaseEntries(previousPlan).some(({ test }) => test.id === change.id))
            throw new InputError("不能删除或替换已冻结验收用例");
          if (["add", "replace"].includes(change.op) ? !change.case || objectFields(change.case).id !== change.id || !validateCases([change.case]) : Object.hasOwn(change, "case"))
            throw new InputError("新增或替换须提供同编号、符合公开结构的完整case；删除与重排不传case");
          if (change.op === "replace") cases[matches[0]!] = change.case;
          else if (change.op === "remove") cases.splice(matches[0]!, 1);
          else {
            const entry = change.op === "add" ? change.case : cases.splice(matches[0]!, 1)[0];
            const before = change.beforeId === undefined ? cases.length : cases.findIndex((item) => objectFields(item).id === change.beforeId);
            if (before < 0 || change.beforeId !== undefined && cases.filter((item) => objectFields(item).id === change.beforeId).length !== 1)
              throw new InputError("beforeId必须唯一指向同文件中的其他用例；省略时放到末尾");
            cases.splice(before, 0, entry);
          }
        }
        if (cases.length && !validateCases(cases)) throw new InputError("用例批次最多包含200个符合公开结构的用例");
        const source = await inspect(root);
        checkCaseIds(source, planPath(safe.path), cases as DevelopmentCase[]);
        const indexDiagnostics = checkCaseDraft(source, planPath(safe.path), cases as DevelopmentCase[], { schema: planSchema, architecture });
        const content = JSON.stringify(cases, null, 2) + "\n";
        await this.write(root, planPath(safe.path), content, options);
        return { path: safe.path, hash: digest(content), fileHash: digest(content), hashScope: "file", bytes: Buffer.byteLength(content), updated: safe.changes.length,
          ...(indexDiagnostics ? { indexDiagnostics } : {}),
          ...(cases.length ? {} : { incomplete: true, nextAction: "该草稿批次已空；在索引调整引用或补入真实用例后再正式提交。空批次不能通过正式封存与验收。" }),
          cases: cases.map((entry, localIndex) => ({ id: objectFields(entry).id, localIndex, hash: hashValue(entry), caseHash: hashValue(entry), hashScope: "case" })) };
      }),
      tool("read_plan_diagnostics", "分页核对当前整组规划的独立问题；绑定材料摘要，不推进研发状态", {
        type: "object", additionalProperties: false, required: ["indexPath"], properties: {
          indexPath: { type: "string" }, expectedHash: { type: "string", pattern: "^[a-f0-9]{64}$", description: "当前整组材料bundleHash（hashScope=bundle）；不可使用read_plan_file的fileHash。" },
          offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 40 },
        },
      }, async ({ indexPath, expectedHash, offset = 0, limit = 24 }) => {
        planPath(indexPath); const source = await inspect(root);
        this.bindIndex(root, planSchema, indexPath);
        assertBundleHash(source, expectedHash);
        const result = diagnoseBundle(source, planPath(indexPath), { schema: planSchema, architecture, previousPlan, freshWorkspace, offset: Number(offset), limit: Number(limit) });
        return { status: result.status, hash: result.hash, bundleHash: result.hash, hashScope: "bundle", diagnostics: result.diagnostics };
      }),
      tool("list_plan_files", "列出当前规划材料", { type: "object", properties: {}, required: [], additionalProperties: false },
        async () => ({ files: (await inspect(root)).files.map(({ path, size }) => ({ path, size })) })),
      tool("read_plan_file", "按字符精确分页读取当前材料；source=previous仅限当前绑定的历史未验收草稿", { type: "object", additionalProperties: false,
        properties: { path: { type: "string" }, source: { type: "string", enum: ["current", "previous"] }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100000 } }, required: ["path"] },
      async ({ path, source = "current", offset = 0, limit = 24000 }, options) => {
        if (!isInteger(offset) || offset < 0 || !isInteger(limit) || limit < 1 || limit > 100000)
          throw new InputError("规划材料读取范围无效");
        planPath(path);
        if ((typeof source !== "string" || !["current", "previous"].includes(source)) || source === "previous" && !history) throw new InputError("当前阶段没有绑定的历史未验收草稿");
        const prior = source === "previous" ? await this.draftSource(history!, agentId, id, options) : null;
        const bytes = prior ? prior.contents.get(planPath(path)) : await readBytes(root, planPath(path));
        if (!bytes) throw new InputError("历史草稿没有此文件");
        const text = decode(bytes), end = Math.min(text.length, offset + limit);
        if (offset > text.length) throw new InputError("规划材料读取位置超过文件末尾");
        return { path, source, ...(prior ? { trust: "unverified", sourceRunId: history!.runId } : {}), content: text.slice(offset, end), totalChars: text.length,
          hash: digest(bytes), fileHash: digest(bytes), hashScope: "file", truncated: end < text.length, nextOffset: end < text.length ? end : null };
      }),
      ...(history ? [tool("restore_plan_file", "显式恢复绑定历史未验收草稿的同名文件；需源摘要及当前CAS，仍须完整检查和评审", {
        type: "object", additionalProperties: false, required: ["path", "expectedSourceHash", "expectedHash"], properties: {
          path: { type: "string" }, expectedSourceHash: { type: "string", pattern: "^[a-f0-9]{64}$", description: "read_plan_file(source=previous)或历史清单返回的源fileHash" },
          expectedHash: { anyOf: [{ type: "null" }, { type: "string", pattern: "^[a-f0-9]{64}$" }], description: "当前目标fileHash；仅目标不存在时显式为null" },
        },
      }, async ({ path, expectedSourceHash, expectedHash }, options) => {
        planPath(path);
        if (!/^[a-f0-9]{64}$/.test(String(expectedSourceHash ?? "")) || expectedHash !== null && !/^[a-f0-9]{64}$/.test(String(expectedHash ?? "")))
          throw new InputError("恢复须提供源文件摘要和当前文件摘要；目标不存在时明确expectedHash=null");
        const previous = await this.draftSource(history!, agentId, id, options), bytes = previous.contents.get(planPath(path));
        if (!bytes || digest(bytes) !== expectedSourceHash) throw new InputError("历史草稿源文件不存在或摘要不一致");
        const current = await inspect(root), present = current.contents.get(planPath(path));
        if (expectedHash === null ? present !== undefined : !present || digest(present) !== expectedHash) {
          const state = { restored: false, path, currentFileHash: present ? digest(present) : null,
            sourceFileHash: expectedSourceHash, currentMatchesSource: present !== undefined && digest(present) === expectedSourceHash };
          const error = new InputError("当前规划文件已改变或存在状态不符，未恢复：" + JSON.stringify({ ...state,
            remedy: state.currentMatchesSource ? "当前文件已经与历史原稿完全一致，无需恢复；依据当前完整诊断继续修正或正式提交，不重复恢复此文件。"
              : "核对当前文件与源文件；确需恢复时，使用本回执的currentFileHash作为expectedHash主动重试，不能把存在的目标写成null。" }));
          error.reason = "planning_restore_conflict"; error.restoreState = state; throw error;
        }
        await this.write(root, planPath(path), decode(bytes), options);
        return { restored: true, path, trust: "unverified", sourceRunId: history!.runId,
          hash: digest(bytes), fileHash: digest(bytes), hashScope: "file", bytes: bytes.length };
      })] : []),
    ];
  }

  async diagnose(agentId: string, id: string, indexPath: string, { signal, schema, architecture, previousPlan, freshWorkspace = false, expectedHash, offset = 0, limit = 24 }: PlanningOptions = {}) {
    try { planPath(indexPath); } catch { throw artifactFailure("path"); }
    abort(signal);
    try {
      return await this.serial(agentId, id, async (root) => {
        this.bindIndex(root, schema, indexPath);
        abort(signal); const source = await inspect(root); abort(signal);
        assertBundleHash(source, expectedHash);
        return diagnoseBundle(source, indexPath, { schema, architecture, previousPlan, freshWorkspace, offset, limit });
      }, { create: false });
    } catch (error) {
      if (errorField(error, "code") !== "ENOENT") throw error;
      return { status: "incomplete", hash: null, files: [], sources: [], diagnostics: pagePlanDiagnostics(planDiagnosticLedger([
        { path: "planningFiles.index", reason: "planning_material_missing", source: { path: indexPath }, remedy: "先保存当前任务和应用契约索引骨架，再按引用逐批生成用例。" },
      ]).result(), { offset, limit }) };
    }
  }

  async preview(agentId: string, id: string, indexPath: string, { signal }: PlanningOptions = {}) {
    try { planPath(indexPath); } catch { throw artifactFailure("path"); }
    abort(signal);
    try {
      return await this.serial(agentId, id, async (root) => {
        abort(signal); const source = await inspect(root); abort(signal);
        const plan = assemble(source.contents, indexPath); abort(signal);
        return { plan, hash: source.hash, files: source.files };
      }, { create: false });
    } catch (error) {
      if (errorField(error, "code") === "ENOENT") throw artifactFailure("missing");
      throw error;
    }
  }

  async submit(agentId: string, id: string, indexPath: string, { signal }: PlanningOptions = {}) {
    try { planPath(indexPath); } catch { throw artifactFailure("path"); }
    return this.serial(agentId, id, async (root) => {
      abort(signal); const source = await inspect(root);
      const plan = assemble(source.contents, indexPath), fixtureBudget = { bytes: 0 };
      for (const { test: rawTest } of activationCaseEntries(plan)) {
        const test = objectFields(rawTest);
        abort(signal);
        if (!["node-action", "managed-service"].includes(typeof plan.runtime === "string" ? plan.runtime : "") || test.kind === "node-check")
          assertCaseMaterials(test, { input: test.input, mocks: [] }, { signal, budget: fixtureBudget });
        else
          resolveCaseValues({ ...test, assertions: Array.isArray(test.assertions) ? test.assertions : [], mocks: Array.isArray(test.mocks) ? test.mocks : [] },
            { maxInputBytes: plan.runtime === "managed-service" ? 1024 * 1024 : 128 * 1024, signal, fixtureBudget });
      }
      const parent = await this.storage.directory(agentId, "development/planning-snapshots", { create: true });
      const { path, frozen } = await freezeBundle(source, parent, signal);
      return { plan: assemble(frozen.contents, indexPath),
        snapshot: { agentId, runId: id, path, hash: frozen.hash, files: frozen.files, indexPath } };
    });
  }

  async captureDraft(agentId: string, id: string, indexPath: string, { expectedHash, signal }: PlanningOptions = {}) {
    planPath(indexPath); abort(signal);
    try {
      return await this.serial(agentId, id, async (root) => {
        abort(signal); const source = await inspect(root); abort(signal);
        if (expectedHash !== undefined && (!/^[a-f0-9]{64}$/.test(String(expectedHash)) || expectedHash !== source.hash))
          throw new InputError("历史规划草稿与记录的整组摘要不一致，不能续接");
        if (!source.files.length) return null;
        const parent = await this.storage.directory(agentId, "development/planning-draft-snapshots", { create: true });
        const { path, frozen } = await freezeBundle(source, parent, signal);
        return { version: 1, kind: "untrusted-planning-draft", agentId, runId: id, path,
          hash: frozen.hash, files: frozen.files, indexPath };
      }, { create: false });
    } catch (error) { if (errorField(error, "code") === "ENOENT") return null; throw error; }
  }

  async draftSource(snapshot: PlanningDraftSnapshot, agentId: string, id: string, { signal }: PlanningOptions = {}) {
    if (!snapshot || snapshot.version !== 1 || snapshot.kind !== "untrusted-planning-draft" || snapshot.agentId !== agentId
      || !/^[a-f0-9]{64}$/.test(snapshot.hash) || typeof snapshot.path !== "string" || !Array.isArray(snapshot.files))
      throw new InputError("历史规划草稿标识无效");
    runId(snapshot.runId); runId(id); planPath(snapshot.indexPath); abort(signal);
    if (snapshot.runId === id) throw new InputError("历史规划草稿只可恢复到新的空批次");
    const parent = await this.storage.directory(agentId, "development/planning-draft-snapshots");
    const sourcePath = join(parent, snapshot.hash);
    if (relative(sourcePath, resolve(snapshot.path)) !== "") throw new InputError("历史规划草稿不属于当前 Agent");
    const source = await inspect(sourcePath); abort(signal);
    if (!source.files.length || source.hash !== snapshot.hash || JSON.stringify(source.files) !== JSON.stringify(snapshot.files))
      throw new InputError("历史规划草稿快照内容已改变，不能续接");
    return source;
  }

  async restoreDraft(snapshot: PlanningDraftSnapshot, agentId: string, id: string, { signal }: PlanningOptions = {}) {
    const source = await this.draftSource(snapshot, agentId, id, { signal });
    return this.serial(agentId, id, async (root) => {
      abort(signal);
      if ((await inspect(root)).files.length) throw new InputError("新规划目录已有材料，不能覆盖恢复");
      const temporary = join(dirname(root), `.planning-recovery-${randomUUID()}`); await mkdir(temporary, { mode: 0o700 });
      try {
        for (const file of source.files) {
          abort(signal); const destination = join(temporary, file.path); await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
          await writeFile(destination, source.contents.get(file.path)!, { flag: "wx", mode: 0o600 });
        }
        if ((await inspect(temporary)).hash !== snapshot.hash) throw new InputError("历史规划草稿复制校验失败");
        abort(signal);
        if ((await inspect(root)).files.length) throw new InputError("新规划目录已有材料，不能覆盖恢复");
        abort(signal); await rename(temporary, root);
        return { indexPath: snapshot.indexPath, hash: snapshot.hash, bundleHash: snapshot.hash, hashScope: "bundle" };
      } finally { await rm(temporary, { recursive: true, force: true }); }
    });
  }

  async validateSnapshot(snapshot: PlanningSnapshot, agentId = snapshot?.agentId) {
    if (!snapshot || snapshot.agentId !== agentId || !/^[a-f0-9]{64}$/.test(snapshot.hash)
      || typeof snapshot.path !== "string" || !Array.isArray(snapshot.files)) throw new InputError("规划材料快照标识无效");
    runId(snapshot.runId); planPath(snapshot.indexPath);
    const parent = await this.storage.directory(agentId, "development/planning-snapshots");
    const root = join(parent, snapshot.hash);
    if (relative(root, resolve(snapshot.path)) !== "") throw new InputError("规划材料快照不属于当前 Agent");
    const actual = await inspect(root);
    if (actual.hash !== snapshot.hash || JSON.stringify(actual.files) !== JSON.stringify(snapshot.files))
      throw new InputError("规划材料快照内容已改变");
    return { plan: assemble(actual.contents, snapshot.indexPath), snapshot: structuredClone(snapshot) };
  }
}
