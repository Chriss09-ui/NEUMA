import { createHash } from "node:crypto";
import { InputError } from "../requirements/core.mjs";
import { objectFields, errorField } from "./type-boundary.mjs";
import { readFormatRecovery, formatRecoveryExhausted, type FormatRecovery } from "./format-recovery.mjs";

export interface RepairIssue { id: string; description: string; remedy: string; paths: string[]; owner: string; afterOwners?: string[] }
export interface RepairUpdate { path: string; value: unknown }
export interface RepairResult { baseHash: string; issueIds: string[]; summary: string; updates: RepairUpdate[] }
interface RepairHistory { wave: number; calls: number; sessionFile: string | null; inputHash: string | null;
  result: RepairResult | null; reason: string; submissionReplay?: ReviewSubmissionReplay }
export interface ReviewSubmissionReplay { version: 1; sourceCheckpointHash: string; sessionHash: string; bindingHash: string;
  toolCallId: string; rawHash: string; resultHash: string; rejectionHash: string }
export interface TaskRejection { fingerprint: string; modelContractHash: string; protocolVersion?: number; count: number }
export interface RepairGroup { id: string; issueIds: string[]; paths: string[]; wave: number; calls: number;
  dependsOn: string[]; sessionFile: string | null; inputHash: string | null; result: RepairResult | null; history?: RepairHistory[]; rejection?: TaskRejection;
  submissionReplay?: ReviewSubmissionReplay; formatRecovery?: FormatRecovery }
export interface RepairCheckpoint<Limit extends number | null = number> { version: 1 | 2 | 3 | 4; bindingHash: string; baseHash: string; issues: RepairIssue[];
  calls: number; callLimit: Limit; groupCallLimit: Limit; concurrency: number; groups: RepairGroup[]; hash: string; previousQuota?: RepairCheckpoint }
export interface RepairWorker<Limit extends number | null = number> { group: RepairGroup; issues: RepairIssue[]; base: unknown; baseHash: string;
  callLimit: Limit; onSession(file: string): Promise<void>; onCall(retryAttempt?: number): Promise<void>;
  onRejection?(value: TaskRejection): Promise<void>; onFormatRecovery?(value: FormatRecovery): Promise<void>; submit(value: unknown): Promise<RepairResult> }
export const repairHash = (value: unknown) => {
  const canonical = (item: unknown): string => {
    if (item === null || typeof item === "string" || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    if (!item || typeof item !== "object") throw new InputError("修复材料必须为JSON。");
    return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical((item as Record<string, unknown>)[key])}`).join(",")}}`;
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
};
export const repairPointer = (value: string) => value.replaceAll("~", "~0").replaceAll("/", "~1");
const clone = <T,>(value: T): T => structuredClone(value);
const fail = (message = "修复调度进度与原材料不一致，不能重新分派刷新额度。"): never => { throw new InputError(message); };
const seal = <L extends number | null,>(input: RepairCheckpoint<L>): RepairCheckpoint<L> => {
  const { hash: _hash, ...body } = input;
  if (Buffer.byteLength(JSON.stringify(body)) > 24 * 1024 * 1024) fail("修复进度超过保存容量，已完成成果保留。");
  return { ...body, hash: repairHash(body) };
};
const overlaps = (a: string, b: string) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
const keys = (pointer: string) => {
  if (!pointer.startsWith("/") || /~(?![01])/u.test(pointer)) fail("修复字段路径无效。");
  const result = pointer.slice(1).split("/").map(key => key.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (result.some(key => ["__proto__", "prototype", "constructor"].includes(key))) fail("修复字段路径无效。");
  return result;
};

/** Only existing values can be replaced; array insertions cannot invalidate other groups' pointers. */
export function applyRepairUpdates(base: unknown, updates: RepairUpdate[]): unknown {
  const result = clone(base);
  for (const update of updates) {
    const parts = keys(update.path), last = parts.pop()!;
    let parent = result;
    for (const key of parts) {
      if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, key)) fail("修复路径不存在。");
      parent = (parent as Record<string, unknown>)[key];
    }
    if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, last)) fail("修复路径不存在。");
    (parent as Record<string, unknown>)[last] = clone(update.value);
  }
  return result;
}

export function validateRepairResult(input: unknown, group: RepairGroup, base: unknown): RepairResult {
  const value = objectFields(input);
  if (Object.keys(value).sort().join() !== "baseHash,issueIds,summary,updates" || value.baseHash !== repairHash(base)
    || !Array.isArray(value.issueIds) || repairHash([...value.issueIds].sort()) !== repairHash([...group.issueIds].sort())
    || typeof value.summary !== "string" || !value.summary.trim() || value.summary.length > 4000
    || !Array.isArray(value.updates) || value.updates.length > 24) fail("请提交本组全部问题编号、当前基底摘要和最多24处局部修复。");
  const paths: string[] = [];
  for (const raw of value.updates as unknown[]) {
    const item = objectFields(raw);
    if (Object.keys(item).sort().join() !== "path,value" || typeof item.path !== "string"
      || !group.paths.some(path => item.path === path || String(item.path).startsWith(path + "/"))
      || paths.some(path => overlaps(path, item.path as string))) fail("修复越过本组授权字段，或提交了互相覆盖的修改。");
    keys(item.path as string); paths.push(item.path as string);
  }
  const result = clone(value) as unknown as RepairResult;
  applyRepairUpdates(base, result.updates);
  return result;
}

const callLimitFor = (version: number, groups: number, perGroup: number) => Math.min(groups * perGroup,
  version === 2 ? 1200 : 120);

export function createRepairCheckpoint(binding: unknown, base: unknown, issues: RepairIssue[], groupCallLimit: number, version: 1 | 2 = 1): RepairCheckpoint {
  if (![1, 2].includes(version) || !Number.isSafeInteger(groupCallLimit) || groupCallLimit < 1 || groupCallLimit > 12) fail("修复问题或额度无效。");
  return newCheckpoint(binding, base, issues, groupCallLimit, version);
}

export function createReviewTaskCheckpoint(binding: unknown, base: unknown, issues: RepairIssue[]) {
  return newCheckpoint(binding, base, issues, null, 3);
}

export function createDevelopmentTaskCheckpoint(binding: unknown, base: unknown, issues: RepairIssue[]) {
  return newCheckpoint(binding, base, issues, null, 4);
}

export function readDevelopmentTaskCheckpoint(input: unknown): RepairCheckpoint<null> {
  if (objectFields(input).version === 4) return readCheckpoint(input, true, true) as RepairCheckpoint<null>;
  const previous = readRepairCheckpoint(input);
  return seal({ ...clone(previous), version: 4, callLimit: null, groupCallLimit: null, previousQuota: previous });
}

function newCheckpoint<L extends number | null>(binding: unknown, base: unknown, issues: RepairIssue[], groupCallLimit: L,
  version: 1 | 2 | 3 | 4): RepairCheckpoint<L> {
  if (!issues.length || issues.length > ([2, 4].includes(version) ? 400 : 160) || new Set(issues.map(issue => issue.id)).size !== issues.length
    || issues.some(issue => !issue.id || !issue.paths.length || !issue.owner || !issue.description)) fail("修复问题或额度无效。");
  for (const issue of issues) for (const path of issue.paths) keys(path);
  const buckets = new Map<string, RepairIssue[][]>();
  for (const issue of issues) {
    const batches = buckets.get(issue.owner) ?? [];
    const last = batches.at(-1);
    if (!last || last.length >= 3 || JSON.stringify([...last, issue]).length > 12000) batches.push([issue]);
    else last.push(issue);
    buckets.set(issue.owner, batches);
  }
  const groups = [...buckets.values()].flat().map((batch, index): RepairGroup => ({ id: `repair_${index + 1}`,
    issueIds: batch.map(issue => issue.id), paths: [...new Set(batch.flatMap(issue => issue.paths))].sort(), wave: 0,
    dependsOn: [], calls: 0, sessionFile: null, inputHash: null, result: null }));
  for (const group of groups) {
    const after = new Set(issues.filter(issue => group.issueIds.includes(issue.id)).flatMap(issue => issue.afterOwners ?? []));
    group.dependsOn = groups.filter(other => other.id !== group.id && issues.some(issue => other.issueIds.includes(issue.id) && after.has(issue.owner))).map(other => other.id);
  }
  return seal({ version, bindingHash: repairHash(binding), baseHash: repairHash(base), issues: clone(issues),
    calls: 0, callLimit: (groupCallLimit === null ? null : callLimitFor(version, groups.length, groupCallLimit)) as L, groupCallLimit, concurrency: 3, groups, hash: "" });
}

// Version 3 is used only by independent review. Validate the original seal and quotas before upgrading a copy.
export function readReviewTaskCheckpoint(input: unknown): RepairCheckpoint<null> {
  const value = objectFields(input);
  if (value.version === 3) return readCheckpoint(input, true) as RepairCheckpoint<null>;
  const previous = readRepairCheckpoint(input);
  if (previous.version !== 1 || previous.groupCallLimit !== 3) fail();
  return seal({ ...previous, version: 3, callLimit: null, groupCallLimit: null });
}

export function readRepairCheckpoint(input: unknown): RepairCheckpoint {
  return readCheckpoint(input, false) as RepairCheckpoint;
}

function readCheckpoint(input: unknown, review: boolean, development = false): RepairCheckpoint<number | null> {
  const value = objectFields(input);
  if ((review ? value.version !== (development ? 4 : 3) : value.version !== 1 && value.version !== 2) || !Array.isArray(value.issues) || !Array.isArray(value.groups)
    || !Number.isSafeInteger(value.calls) || (review ? value.groupCallLimit !== null || value.callLimit !== null
      : !Number.isSafeInteger(value.callLimit) || !Number.isSafeInteger(value.groupCallLimit)) || typeof value.bindingHash !== "string" || typeof value.baseHash !== "string") fail();
  const state = clone(input) as RepairCheckpoint<number | null>;
  if (seal(state).hash !== state.hash || state.concurrency !== 3 || state.groupCallLimit !== null && (state.groupCallLimit < 1 || state.groupCallLimit > 12)
    || state.groups.length < 1 || state.groups.length > ([2, 4].includes(state.version) ? 400 : 160)
    || state.issues.length > ([2, 4].includes(state.version) ? 400 : 160)
    || state.groupCallLimit !== null && state.callLimit !== callLimitFor(state.version, state.groups.length, state.groupCallLimit)
    || state.calls < 0 || state.callLimit !== null && state.calls > state.callLimit || state.calls !== state.groups.reduce((sum, group) => sum + group.calls, 0)
    || new Set(state.groups.map(group => group.id)).size !== state.groups.length) fail();
  const ids = state.groups.flatMap(group => group.issueIds);
  if (state.previousQuota) {
    if (!development) fail();
    const previous = readRepairCheckpoint(state.previousQuota);
    if (previous.bindingHash !== state.bindingHash || previous.baseHash !== state.baseHash || repairHash(previous.issues) !== repairHash(state.issues)
      || previous.calls > state.calls || previous.groups.some(old => {
        const current = state.groups.find(group => group.id === old.id);
        return !current || current.calls < old.calls;
      })) fail();
  }
  if (ids.length !== state.issues.length || new Set(ids).size !== ids.length
    || state.issues.some(issue => !ids.includes(issue.id))) fail();
  for (const group of state.groups) {
    const checkReplay = (receipt: ReviewSubmissionReplay | undefined, result: RepairResult | null) => {
      if (receipt === undefined) return;
      if (!review || !result || Object.keys(receipt).sort().join() !== "bindingHash,rawHash,rejectionHash,resultHash,sessionHash,sourceCheckpointHash,toolCallId,version"
        || receipt.version !== 1 || typeof receipt.toolCallId !== "string" || !receipt.toolCallId || receipt.toolCallId.length > 256
        || [receipt.bindingHash, receipt.rawHash, receipt.rejectionHash, receipt.resultHash, receipt.sessionHash, receipt.sourceCheckpointHash]
          .some(value => typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
        || receipt.resultHash !== repairHash(result)) fail();
    };
    checkReplay(group.submissionReplay, group.result);
    if (group.submissionReplay && (!group.rejection || group.submissionReplay.rejectionHash !== repairHash(group.rejection))) fail();
    if (group.rejection !== undefined) {
      const rejection = group.rejection;
      if (!review || !rejection || !group.calls || !Number.isSafeInteger(rejection.count) || rejection.count < 1 || rejection.count > 3
        || ![rejection.modelContractHash, rejection.fingerprint].every(hash => typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash))
        || rejection.protocolVersion !== undefined && (!Number.isSafeInteger(rejection.protocolVersion) || rejection.protocolVersion < 1)) fail();
    }
    if (group.formatRecovery !== undefined) { if (state.version !== 4) fail(); readFormatRecovery(group.formatRecovery); }
    const owned = state.issues.filter(issue => group.issueIds.includes(issue.id));
    const history = group.history ?? [];
    if (Array.isArray(history)) for (const entry of history) checkReplay(entry.submissionReplay, entry.result);
    if (!Array.isArray(history) || history.length > 12 || history.some((entry, index) => !Number.isSafeInteger(entry.calls)
      || entry.calls < 1 || entry.calls > group.calls || index > 0 && entry.calls < history[index - 1]!.calls
      || !Number.isSafeInteger(entry.wave) || entry.wave < 1 || typeof entry.inputHash !== "string"
      || !entry.sessionFile || !/^[\w.-]+\.jsonl$/u.test(entry.sessionFile)
      || typeof entry.reason !== "string" || !entry.reason || entry.reason.length > 4000
      || entry.result && entry.result.baseHash !== entry.inputHash)) fail();
    if (history.some(entry => entry.sessionFile === group.sessionFile && entry.inputHash !== group.inputHash)) fail();
    const rebased = history.length > 0 && history.at(-1)!.calls === group.calls && !group.sessionFile;
    if (group.issueIds.length > 3 || repairHash([...new Set(owned.flatMap(issue => issue.paths))].sort()) !== repairHash(group.paths)
      || !Array.isArray(group.dependsOn) || group.dependsOn.some(id => id === group.id || !state.groups.some(other => other.id === id))
      || !Array.isArray(group.paths) || !group.paths.length || !Number.isSafeInteger(group.wave) || group.wave < 0
      || !Number.isSafeInteger(group.calls) || group.calls < 0 || state.groupCallLimit !== null && group.calls > state.groupCallLimit
      || group.calls > 0 && !group.sessionFile && !rebased || group.sessionFile !== null && !/^[\w.-]+\.jsonl$/u.test(group.sessionFile)
      || group.wave === 0 && (group.calls && !rebased || group.result || group.inputHash)
      || group.wave > 0 && typeof group.inputHash !== "string" || group.result && !group.calls) fail();
    for (const path of group.paths) keys(path);
  }
  return state;
}

interface ScheduleOptions<L extends number | null> { checkpoint: RepairCheckpoint<L>; binding: unknown; base: unknown;
  save(state: RepairCheckpoint<L>): Promise<void>; run(worker: RepairWorker<L>): Promise<unknown>; signal?: AbortSignal | undefined;
  retryInvalidMerge?: boolean;
  onInvalidMerge?: ((groupIds: string[], receiptHash: string) => Promise<void>) | undefined;
  validateCandidate?: ((candidate: unknown, final: boolean) => unknown | Promise<unknown>) | undefined }

/** Workers only propose patches. A persisted wave is replayed before any new work is scheduled. */
export function runRepairSchedule(options: ScheduleOptions<number>) {
  return runSchedule(options, readRepairCheckpoint(options.checkpoint), (quota, state) => quota ?? state.groupCallLimit);
}
export function runReviewTaskSchedule(options: ScheduleOptions<null>) {
  return runSchedule(options, readReviewTaskCheckpoint(options.checkpoint), () => null);
}
export function runDevelopmentTaskSchedule(options: ScheduleOptions<null>) {
  return runSchedule(options, readDevelopmentTaskCheckpoint(options.checkpoint), () => null);
}

async function runSchedule<L extends number | null>(options: ScheduleOptions<L>, state: RepairCheckpoint<L>,
  workerLimit: (quota: number | undefined, state: RepairCheckpoint<L>) => L): Promise<unknown> {
  let writes = Promise.resolve(), persistenceError: unknown;
  if (state.bindingHash !== repairHash(options.binding) || state.baseHash !== repairHash(options.base)) fail();
  const active = () => { options.signal?.throwIfAborted(); if (persistenceError) throw persistenceError; };
  const update = (change: (next: RepairCheckpoint<L>) => void) => {
    const pending = writes.then(async () => {
      active(); const next = clone(state); change(next); const saved = seal(next);
      try { await options.save(clone(saved)); } catch (error) { persistenceError ??= error; throw error; }
      state = saved; active();
    });
    writes = pending.catch(() => {}); return pending;
  };
  await update(() => {});
  const reopen = async (ids: string[], wave: number, error: unknown) => {
    await update(next => {
    const reason = (error instanceof Error ? error.message : "合并校验未通过，须重新核对本组及下游补丁。").slice(0, 4000);
    for (const group of next.groups) if (ids.includes(group.id) || group.wave > wave) {
      if (group.calls && group.sessionFile) {
        if ((group.history?.length ?? 0) >= 12) fail("修复退回次数已达到保存上限。");
        (group.history ??= []).push({ wave: group.wave, calls: group.calls, sessionFile: group.sessionFile,
          inputHash: group.inputHash, result: clone(group.result), reason,
          ...(group.submissionReplay ? { submissionReplay: clone(group.submissionReplay) } : {}) });
      }
      group.result = null;
      delete group.submissionReplay;
      // Later waves consumed the rejected base. Keep their history and usage, but bind a new session to the corrected base.
      if (group.wave > wave) { group.wave = 0; group.inputHash = null; group.sessionFile = null; }
    }
    });
    await options.onInvalidMerge?.(ids, state.hash);
  };
  let base = clone(options.base), wave = 1;
  for (;;) {
    active();
    let groups = state.groups.filter(group => group.wave === wave);
    if (!groups.length) {
      if (state.groups.every(group => group.result)) return base;
      const selected: RepairGroup[] = [];
      for (const group of state.groups.filter(group => !group.wave)) {
        if (group.dependsOn.some(id => !state.groups.find(other => other.id === id)?.result)) continue;
        if (!selected.some(other => other.paths.some(a => group.paths.some(b => overlaps(a, b))))) selected.push(group);
        if (selected.length >= state.concurrency) break;
      }
      if (!selected.length) fail("修复分组存在未满足或循环依赖，保留全部问题等待重新核对归属。");
      const ids = new Set(selected.map(group => group.id));
      await update(next => { for (const group of next.groups) if (ids.has(group.id)) { group.wave = wave; group.inputHash = repairHash(base); } });
      groups = state.groups.filter(group => group.wave === wave);
    }
    if (groups.length > state.concurrency || groups.some(group => group.inputHash !== repairHash(base)
      || group.dependsOn.some(id => { const dependency = state.groups.find(other => other.id === id); return !dependency?.result || dependency.wave >= wave; }))
      || groups.some((group, index) => groups.slice(0, index).some(other => other.paths.some(a => group.paths.some(b => overlaps(a, b)))))) fail();
    for (const group of groups.filter(group => group.result)) {
      const result = validateRepairResult(group.result, group, base);
      try { await options.validateCandidate?.(applyRepairUpdates(base, result.updates), false); }
      catch (error) { await reopen([group.id], wave, error); }
    }
    groups = state.groups.filter(group => group.wave === wave);
    const pending = groups.filter(group => !group.result), quotas = new Map(pending.map(group => [group.id, group.calls]));
    const { callLimit, groupCallLimit } = state;
    if (callLimit !== null && groupCallLimit !== null) {
      const reserve = state.version === 2 ? Math.min(2, groupCallLimit) : 1;
      let available = callLimit - state.calls - state.groups.filter(group => !group.result && group.wave !== wave)
        .reduce((sum, group) => sum + Math.min(reserve, groupCallLimit - group.calls), 0);
      if (available < pending.length) fail("剩余修复次数不足以让每个未完成组正式提交；已完成结果与累计用量保留。");
      for (;;) {
        let assigned = false;
        for (const group of pending) if (available > 0 && quotas.get(group.id)! < groupCallLimit) {
          quotas.set(group.id, quotas.get(group.id)! + 1); available--; assigned = true;
        }
        if (!assigned) break;
      }
    }
    const settled = await Promise.allSettled(groups.filter(group => !group.result).map(async original => {
      const current = () => state.groups.find(group => group.id === original.id)!;
      const limit = workerLimit(quotas.get(original.id), state);
      if (state.version !== 4 && current().rejection?.count === 3) fail("子任务连续三次因同一问题提交失败。");
      const exhausted = formatRecoveryExhausted(current().formatRecovery);
      if (state.version === 4 && exhausted) throw Object.assign(new InputError("本研发子组收到反馈后已实际纠正三次仍不合格，原会话和记录保留。"),
        { diagnostic: { stage: "development", phase: "repair", reason: "repeated_tool_error", attempts: 3,
          counting: "corrections_after_feedback", toolName: exhausted.toolName, issues: exhausted.failures.at(-1)!.issues } });
      if (limit !== null && current().calls >= limit || state.callLimit !== null && state.calls >= state.callLimit) fail("修复子任务额度已用完，已完成组保留，不能重新分派刷新额度。");
      await options.run({ group: clone(original), base: clone(base), baseHash: repairHash(base),
        issues: clone(state.issues.filter(issue => original.issueIds.includes(issue.id))), callLimit: limit,
        onSession: file => update(next => {
          const group = next.groups.find(group => group.id === original.id)!;
          if (!/^[\w.-]+\.jsonl$/u.test(file) || group.sessionFile && group.sessionFile !== file) fail();
          if (group.history?.some(entry => entry.sessionFile === file && entry.inputHash !== group.inputHash)) fail();
          group.sessionFile = file;
        }),
        onCall: (retryAttempt = 0) => update(next => {
          const group = next.groups.find(group => group.id === original.id)!;
          if (retryAttempt > 0) return;
          if (!group.sessionFile || group.result || limit !== null && group.calls >= limit || next.callLimit !== null && next.calls >= next.callLimit) fail("修复调用额度已耗尽。");
          group.calls++; next.calls++;
        }),
        onRejection: value => update(next => {
          const group = next.groups.find(group => group.id === original.id)!;
          if (![3, 4].includes(next.version) || !group.sessionFile || !group.calls || group.result) fail();
          group.rejection = clone(value);
        }),
        ...(state.version === 4 ? { onFormatRecovery: (value: FormatRecovery) => update(next => {
          readFormatRecovery(value);
          const group = next.groups.find(group => group.id === original.id)!;
          if (!group.sessionFile) fail();
          group.formatRecovery = clone(value);
        }) } : {}),
        submit: async value => {
          active(); const result = validateRepairResult(value, current(), base);
          try { await options.validateCandidate?.(applyRepairUpdates(base, result.updates), false); }
          catch (error) {
            if (state.version !== 4) throw error;
            await options.onInvalidMerge?.([original.id], repairHash({ group: original.id, calls: current().calls, result }));
            throw Object.assign(error instanceof Error ? error : new InputError("本组内容未通过校验。"), { reason: "repair_content_rejected" });
          }
          await update(next => {
            const group = next.groups.find(group => group.id === original.id)!;
            if (!group.calls || group.result) fail("本修复子任务已提交或尚未调用模型。");
            group.result = result;
          }); return result;
        } });
      if (!current().result) fail("子 Agent 尚未提交完整修复结果，进度已保存。");
    }));
    active(); const failure = settled.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
    const completed = state.groups.filter(group => group.wave === wave);
    for (const group of completed) validateRepairResult(group.result, group, base);
    const candidate = applyRepairUpdates(base, completed.flatMap(group => group.result!.updates));
    try { await options.validateCandidate?.(candidate, state.groups.every(group => group.result)); }
    catch (error) {
      const requested = errorField(error, "repairGroupIds");
      const ids = Array.isArray(requested) && requested.length && requested.every(id => typeof id === "string" && state.groups.some(group => group.id === id && group.wave > 0))
        ? requested as string[] : completed.map(group => group.id);
      const firstWave = Math.min(wave, ...state.groups.filter(group => ids.includes(group.id)).map(group => group.wave));
      await reopen(ids, firstWave, error);
      if (options.retryInvalidMerge) { base = clone(options.base); wave = 1; continue; }
      throw error;
    }
    base = candidate; wave++;
  }
}
