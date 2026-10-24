import type { ContextDelivery } from "./development-context.mjs";
import type { UnknownRecord } from "../contracts/json.mjs";
import type { DevelopmentArchitecture } from "../contracts/development.mjs";
import type { AgentStorage } from "../agents/agent-storage.mjs";
import { objectFields, isInteger, isArray, errorField } from "../runtime/type-boundary.mjs";
export interface DevelopmentSessionReference { bindingHash: string; role: string; file: string | null; turns: number; contextDelivery?: ContextDelivery | undefined; limit?: number; retryAttempts?: number; compactions?: number; submissionContinuations?: number;
  toolInputFailure?: { toolName: string; fingerprint: string; schemaHash?: string; callHash: string; count: number };
  pendingResult?: { result: unknown; subjectHash: unknown; planHash: string | null; codeHash: string | null } }
export interface DevelopmentSessionIdentity { id: string; agentId: string; architectureRef: unknown; architecture?: unknown }
interface HistoricalPlanningRecord extends DevelopmentSessionIdentity { phase?: unknown; status?: unknown; delivery?: unknown; plan?: unknown; planHash?: unknown; package?: unknown; tasks?: unknown; deliveries?: unknown; sessions?: unknown }
export interface DevelopmentSessionRecord { id: string; agentId: string; architectureRef: unknown; architecture: DevelopmentArchitecture;
  sessions?: Record<string, DevelopmentSessionReference>; phase?: string; status?: string; delivery?: string; plan?: unknown; planHash?: unknown; package?: unknown; tasks?: unknown[]; deliveries?: unknown[] }
export interface FailureSource { agentId: string; runId: string; recordHash: string; bindingHash: string; sessionHash: string | null; leafId: string | null }
type CaseReference = { id: string; acceptanceId: string; taskId?: string; actionId?: string; kind?: string; inputTarget?: string }
export interface PlanningFailureIssue { path: string; reason: string; remedy: string; source?: { path: string; localIndex?: number; caseId?: string }; proposedCaseRef?: CaseReference }
import { basename, join } from "node:path";
import { types } from "node:util";
import { InputError } from "../requirements/core.mjs";
import { hashValue } from "./development-contract.mjs";
import { readPiBoundSession } from "../runtime/pi-session-state.mjs";

export const PLANNING_TOOL_FAILURE_MAX_BYTES = 64 * 1024;
const failurePrefix = "草稿用例尚不符合已保存骨架，原文件未修改：";
const failureScope = "同一历史规划会话已保存的公开工具拒绝，仅为不可信只读参考；不是当前重测、需求、授权、计划接受或通过证据。";
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const caseId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const own = (value: unknown, key: PropertyKey): unknown => value && typeof value === "object" && !types.isProxy(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
const object = (value: unknown): value is UnknownRecord => Boolean(value) && typeof value === "object" && !Array.isArray(value)
  && !types.isProxy(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fields = (value: unknown, allowed: string[]): value is UnknownRecord => object(value) && Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.includes(key)
  && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"));
const text = (value: unknown, bytes: number): value is string => typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= bytes && !/[\u0000-\u001f\u007f]/u.test(value);
const planPath = (value: unknown): value is string => text(value, 500) && !value.includes("\\") && value.endsWith(".json")
  && value.split("/").every((part) => part && part !== "." && part !== "..");
const issuePath = (value: unknown): value is string => text(value, 1000) && /^planningFiles\.[A-Za-z0-9_.\[\]-]+$/u.test(value);

function arrayValues(value: unknown, max: number, min = 0): unknown[] | null {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const length = own(value, "length"), keys = Reflect.ownKeys(value);
  if (!isInteger(length) || length < min || length > max || keys.length !== length + 1) return null;
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field || !Object.hasOwn(field, "value") || !field.enumerable) return null;
    result.push(field.value);
  }
  return result;
}

function failureSource(record: DevelopmentSessionIdentity): FailureSource {
  const binding = developmentSessionBinding(record, "planner", { previousPlanHash: null });
  return { agentId: record.agentId, runId: record.id, recordHash: hashValue(record), bindingHash: hashValue(binding), sessionHash: null, leafId: null };
}

function finishFailures<T extends object>(input: T): T & { bytes: number } {
  const value = Object.assign(input, { bytes: 0 });
  for (;;) {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes === value.bytes) return value;
    value.bytes = bytes;
  }
}

function failureBase(source: FailureSource | null) {
  return { schemaVersion: 1, trust: "untrusted-reference", current: false, scope: failureScope,
    source, maxBytes: PLANNING_TOOL_FAILURE_MAX_BYTES };
}

function unavailableFailures(source: FailureSource | null, reason: string) {
  return finishFailures({ ...failureBase(source), status: "unavailable" as const, reason });
}

function caseReference(value: unknown): CaseReference | null {
  if (!object(value)) return null;
  const result: UnknownRecord = {};
  for (const key of ["id", "acceptanceId", "taskId", "actionId", "kind", "inputTarget"]) {
    const field = own(value, key);
    if (field !== undefined) result[key] = field;
  }
  if (!caseId(result.id) || !caseId(result.acceptanceId)
    || ["taskId", "actionId"].some((key) => result[key] !== undefined && !caseId(result[key]))
    || result.kind !== undefined && (typeof result.kind !== "string" || !["action", "input-rejection", "node-check"].includes(result.kind))
    || result.inputTarget !== undefined && (result.kind !== "input-rejection" || (typeof result.inputTarget !== "string" || !["action-value", "task-envelope"].includes(result.inputTarget)))) return null;
  return result as CaseReference;
}

function normalizeIssue(value: unknown): PlanningFailureIssue | null {
  if (!fields(value, ["path", "reason", "remedy", "source", "proposedCaseRef"]) || !issuePath(value.path)
    || !text(value.reason, 80) || !/^[a-z][a-z0-9_]*$/u.test(value.reason) || !text(value.remedy, 4000)) return null;
  const result: PlanningFailureIssue = { path: value.path, reason: value.reason, remedy: value.remedy };
  if (value.source !== undefined) {
    const source = value.source;
    if (!fields(source, ["path", "localIndex", "caseId"]) || !planPath(source.path)
      || source.localIndex !== undefined && (!isInteger(source.localIndex) || source.localIndex < 0 || source.localIndex >= 200)
      || source.caseId !== undefined && !caseId(source.caseId)) return null;
    result.source = { path: source.path, ...(source.localIndex !== undefined ? { localIndex: source.localIndex } : {}),
      ...(source.caseId !== undefined ? { caseId: source.caseId } : {}) };
  }
  if (value.proposedCaseRef !== undefined) {
    if (!fields(value.proposedCaseRef, ["id", "acceptanceId", "taskId", "actionId", "kind", "inputTarget"])) return null;
    const reference = caseReference(value.proposedCaseRef);
    if (!reference || result.source?.caseId !== reference.id || !Number.isSafeInteger(result.source?.localIndex)) return null;
    result.proposedCaseRef = reference;
  }
  if ((result.source?.localIndex !== undefined || result.source?.caseId !== undefined) && (!result.source.caseId || !result.proposedCaseRef)) return null;
  return result;
}

function normalizeFailure(value: unknown) {
  const suppliedIssues = arrayValues(own(value, "issues"), 200, 1);
  if (!fields(value, ["entryId", "toolCallId", "toolName", "path", "reason", "saved", "issues"])
    || !id(value.entryId) || !text(value.toolCallId, 512) || value.toolName !== "save_plan_cases" || !planPath(value.path)
    || value.reason !== "planning_case_invalid" || value.saved !== false || !suppliedIssues) return null;
  const issues = suppliedIssues.map(normalizeIssue);
  return issues.every((issue): issue is PlanningFailureIssue => issue !== null) ? { entryId: value.entryId, toolCallId: value.toolCallId, toolName: "save_plan_cases", path: value.path,
    reason: "planning_case_invalid", saved: false, issues } : null;
}

/** Validate a projection before attaching it to an architecture record; never trust its claimed source. */
export function validatedDevelopmentPlanningToolFailures(value: unknown, record: DevelopmentSessionIdentity) {
  const expected = failureSource(record), source = own(value, "source");
  const invalid = () => unavailableFailures(expected, "planning_tool_failure_reference_invalid");
  if (!fields(value, ["schemaVersion", "trust", "current", "scope", "source", "maxBytes", "status", "reason", "failures", "omittedFailures", "bytes"])
    || value.schemaVersion !== 1 || value.trust !== "untrusted-reference" || value.current !== false || value.scope !== failureScope
    || value.maxBytes !== PLANNING_TOOL_FAILURE_MAX_BYTES || !fields(source, ["agentId", "runId", "recordHash", "bindingHash", "sessionHash", "leafId"])
    || !["agentId", "runId", "recordHash", "bindingHash"].every((key) => source[key] === objectFields(expected)[key])
    || source.sessionHash !== null && !hash(source.sessionHash) || source.leafId !== null && !id(source.leafId)) return invalid();
  const base = failureBase({ ...expected, sessionHash: source.sessionHash, leafId: source.leafId });
  let checked;
  const suppliedFailures = arrayValues(own(value, "failures"), 4, 1);
  if (value.status === "unavailable" && text(value.reason, 100) && /^[a-z][a-z0-9_]*$/u.test(value.reason)
    && value.failures === undefined && value.omittedFailures === undefined) checked = unavailableFailures(base.source, value.reason);
  else if (value.status === "available" && hash(source.sessionHash) && id(source.leafId) && value.reason === undefined
    && suppliedFailures
    && isInteger(value.omittedFailures) && value.omittedFailures >= 0) {
    const failures = suppliedFailures.map(normalizeFailure);
    if (failures.every((failure): failure is NonNullable<typeof failure> => failure !== null) && new Set(failures.map((failure) => failure.entryId)).size === failures.length
      && new Set(failures.map((failure) => failure.toolCallId)).size === failures.length)
      checked = finishFailures({ ...base, status: "available" as const, failures, omittedFailures: value.omittedFailures });
  }
  return checked && checked.bytes === value.bytes && checked.bytes <= PLANNING_TOOL_FAILURE_MAX_BYTES ? checked : invalid();
}

/** Only public fields of matched tool messages are inspected; assistant prose/thinking is never read. */
export function projectDevelopmentPlanningToolFailures(manager: { getBranch(): unknown }, source: FailureSource) {
  const calls = new Map<unknown, { name: unknown; path: unknown; position: number; cases: (CaseReference | null)[] | null } | null>(), resultCounts = new Map<unknown, number>(), results = [], branch = arrayValues(manager.getBranch(), 100_000);
  if (!branch) return unavailableFailures(source, "planning_tool_failure_invalid");
  for (const [position, entry] of branch.entries()) {
    if (own(entry, "type") !== "message") continue;
    const message = own(entry, "message"), role = own(message, "role"), content = own(message, "content");
    if (role === "assistant") {
      const blocks = arrayValues(content, 1024);
      if (!blocks) return unavailableFailures(source, "planning_tool_failure_invalid");
      for (const block of blocks) {
        if (own(block, "type") !== "toolCall") continue;
        const callId = own(block, "id");
        if (!text(callId, 512)) continue;
        const name = own(block, "name"), parameters = name === "save_plan_cases" ? own(block, "arguments") : undefined,
          cases = arrayValues(own(parameters, "cases"), 200, 1);
        const call = { name, path: own(parameters, "path"), position,
          cases: cases ? cases.map(caseReference) : null };
        calls.set(callId, calls.has(callId) ? null : call);
      }
    }
    if (role === "toolResult") {
      const callId = own(message, "toolCallId");
      resultCounts.set(callId, (resultCounts.get(callId) ?? 0) + 1);
    }
  }
  for (const [position, entry] of branch.entries()) {
    if (own(entry, "type") !== "message") continue;
    const message = own(entry, "message"), role = own(message, "role"), content = own(message, "content");
    if (role !== "toolResult" || own(message, "isError") !== true || own(message, "toolName") !== "save_plan_cases") continue;
    const callId = own(message, "toolCallId"), call = calls.get(callId);
    const blocks = arrayValues(content, 1, 1);
    if (!blocks || own(blocks[0], "type") !== "text") continue;
    const body = own(blocks[0], "text");
    if (typeof body !== "string" || !body.startsWith(failurePrefix)) continue;
    if (!call || call.position >= position || call.name !== "save_plan_cases" || !planPath(call.path) || resultCounts.get(callId) !== 1)
      return unavailableFailures(source, "planning_tool_failure_ambiguous");
    if (Buffer.byteLength(body) > PLANNING_TOOL_FAILURE_MAX_BYTES) return unavailableFailures(source, "planning_tool_failures_too_large");
    let parsed: unknown;
    try { parsed = JSON.parse(body.slice(failurePrefix.length)); } catch { return unavailableFailures(source, "planning_tool_failure_invalid"); }
    if (!fields(parsed, ["saved", "issues", "taskAssignments", "subject", "total", "retained", "truncated"]) || parsed.saved !== false)
      return unavailableFailures(source, "planning_tool_failure_invalid");
    const suppliedIssues = arrayValues(parsed.issues, 200, 1);
    if (!suppliedIssues) return unavailableFailures(source, "planning_tool_failure_invalid");
    const issues = [];
    for (const issue of suppliedIssues) {
      if (!fields(issue, ["path", "reason", "remedy", "source"])) return unavailableFailures(source, "planning_tool_failure_invalid");
      const location = own(issue, "source"), localIndex = own(location, "localIndex"), sourceCaseId = own(location, "caseId");
      let proposedCaseRef;
      if (localIndex !== undefined || sourceCaseId !== undefined) {
        proposedCaseRef = call.cases?.[typeof localIndex === "number" ? localIndex : -1];
        if (!isInteger(localIndex) || localIndex < 0 || !proposedCaseRef || proposedCaseRef.id !== sourceCaseId
          || own(location, "path") !== call.path) return unavailableFailures(source, "planning_tool_failure_case_reference_mismatch");
      }
      issues.push({ path: issue.path, reason: issue.reason, remedy: issue.remedy,
        ...(location !== undefined ? { source: location } : {}), ...(proposedCaseRef ? { proposedCaseRef } : {}) });
    }
    const failure = normalizeFailure({ entryId: own(entry, "id"), toolCallId: callId, toolName: "save_plan_cases", path: call.path,
      reason: "planning_case_invalid", saved: false, issues });
    if (!failure) return unavailableFailures(source, "planning_tool_failure_invalid");
    results.push(failure);
  }
  if (!results.length) return unavailableFailures(source, "planning_tool_failures_missing");
  const projection = finishFailures({ ...failureBase(source), status: "available" as const, failures: results.slice(-4), omittedFailures: Math.max(0, results.length - 4) });
  return projection.bytes <= PLANNING_TOOL_FAILURE_MAX_BYTES ? projection : unavailableFailures(source, "planning_tool_failures_too_large");
}

export async function readDevelopmentPlanningToolFailures(storage: Pick<AgentStorage, "directory">, record: HistoricalPlanningRecord, { signal, expectedSessionHash, sdk }: { signal?: AbortSignal | undefined; expectedSessionHash?: string | undefined; sdk?: Parameters<typeof readPiBoundSession>[0] } = {}) {
  let source;
  try {
    source = failureSource(record);
    if (record.phase !== "planning" || !["failed", "blocked"].some(status => status === record.status) || record.delivery !== "blocked"
      || record.plan || record.planHash || record.package || record.tasks !== undefined && record.tasks !== null && (!isArray(record.tasks) || record.tasks.length > 0) || !isArray(record.deliveries) || record.deliveries.length)
      return unavailableFailures(source, "planning_tool_failure_scope_unavailable");
    const binding = developmentSessionBinding(record, "planner", { previousPlanHash: null }), key = source.bindingHash;
    const rawReference = objectFields(record.sessions)[key];
    if (!rawReference) return unavailableFailures(source, "planner_session_missing");
    const reference = objectFields(rawReference);
    if (reference.bindingHash !== key || reference.role !== "planner" || !isInteger(reference.turns) || reference.turns < 0
      || typeof reference.file !== "string" || !/^[A-Za-z0-9_.-]+\.jsonl$/.test(reference.file) || reference.file !== basename(reference.file))
      return unavailableFailures(source, "planner_session_reference_invalid");
    const directory = await storage.directory(record.agentId, `development/sessions/${record.id}/${key}`);
    const cwd = await storage.directory(record.agentId, `development/workspaces/${record.id}/code`);
    const native = await readPiBoundSession(sdk ?? await import("@earendil-works/pi-coding-agent"),
      { cwd, storage: { directory, file: reference.file, binding }, ...(signal ? { signal } : {}), ...(expectedSessionHash === undefined ? {} : { expectedSessionHash }) });
    source = { ...source, sessionHash: native.sessionHash, leafId: native.leafId };
    return projectDevelopmentPlanningToolFailures(native.manager, source);
  } catch (error) {
    signal?.throwIfAborted();
    return unavailableFailures(source ?? null, typeof errorField(error, "reason") === "string" && /^[a-z][a-z0-9_]{0,99}$/u.test(String(errorField(error, "reason")))
      ? String(errorField(error, "reason")) : errorField(error, "code") === "ENOENT" ? "planner_session_missing" : "planner_session_unavailable");
  }
}

/** Business identity stays outside Pi's lossy conversation context. */
export function developmentSessionBinding(record: DevelopmentSessionIdentity, role: string, scope: unknown) {
  if (!["planner", "developer", "reviewer"].includes(role)) throw new InputError("研发会话角色无效");
  return { version: 1, agentId: record.agentId, runId: record.id, architectureRef: record.architectureRef,
    requirementsHash: hashValue(objectFields(record.architecture).requirements), platformHash: objectFields(record.architecture).platformHash ?? null,
    role, scope: structuredClone(scope) };
}

export async function developmentSessionStorage(storage: Pick<AgentStorage, "directory">, record: DevelopmentSessionRecord, binding: ReturnType<typeof developmentSessionBinding>) {
  const key = hashValue(binding);
  record.sessions ??= {};
  const existing = record.sessions[key];
  if (existing && (existing.bindingHash !== key || existing.role !== binding.role
    || !Number.isSafeInteger(existing.turns) || existing.turns < 0
    || (existing.file !== null && (typeof existing.file !== "string" || !/^[A-Za-z0-9_.-]+\.jsonl$/.test(existing.file)
      || existing.file !== basename(existing.file))))) throw new InputError("研发会话绑定或记录已损坏，不能恢复");
  const reference = existing ?? { bindingHash: key, role: binding.role, file: null, turns: 0 };
  record.sessions[key] = reference;
  const directory = await storage.directory(record.agentId, `development/sessions/${record.id}/${key}`, { create: true });
  return { key, reference, options: { directory, ...(reference.file ? { file: join(directory, reference.file) } : {}), binding } };
}

export function bindDevelopmentSessionFile(reference: DevelopmentSessionReference, file: unknown) {
  if (file === undefined) return; // Legacy injected runtimes may still be in memory.
  if (typeof file !== "string" || !/^[A-Za-z0-9_.-]+\.jsonl$/.test(basename(file))) throw new InputError("研发会话文件标识无效");
  const name = basename(file);
  if (reference.file && reference.file !== name) throw new InputError("研发会话不能静默切换历史文件");
  reference.file = name;
}
