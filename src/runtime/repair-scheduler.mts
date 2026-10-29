import { createHash } from "node:crypto";
import { InputError } from "../requirements/core.mjs";
import { objectFields } from "./type-boundary.mjs";

export interface RepairIssue { id: string; description: string; remedy: string; paths: string[]; owner: string; afterOwners?: string[] }
export interface RepairUpdate { path: string; value: unknown }
export interface RepairResult { baseHash: string; issueIds: string[]; summary: string; updates: RepairUpdate[] }
export interface RepairGroup { id: string; issueIds: string[]; paths: string[]; wave: number; calls: number;
  dependsOn: string[]; sessionFile: string | null; inputHash: string | null; result: RepairResult | null }
export interface RepairCheckpoint { version: 1; bindingHash: string; baseHash: string; issues: RepairIssue[];
  calls: number; callLimit: number; groupCallLimit: number; concurrency: number; groups: RepairGroup[]; hash: string }
export interface RepairWorker { group: RepairGroup; issues: RepairIssue[]; base: unknown; baseHash: string;
  callLimit: number; onSession(file: string): Promise<void>; onCall(retryAttempt?: number): Promise<void>;
  submit(value: unknown): Promise<RepairResult> }
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
const seal = (input: RepairCheckpoint): RepairCheckpoint => {
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

export function createRepairCheckpoint(binding: unknown, base: unknown, issues: RepairIssue[], groupCallLimit: number): RepairCheckpoint {
  if (!issues.length || issues.length > 160 || new Set(issues.map(issue => issue.id)).size !== issues.length
    || issues.some(issue => !issue.id || !issue.paths.length || !issue.owner || !issue.description)
    || !Number.isSafeInteger(groupCallLimit) || groupCallLimit < 1 || groupCallLimit > 12) fail("修复问题或额度无效。");
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
  return seal({ version: 1, bindingHash: repairHash(binding), baseHash: repairHash(base), issues: clone(issues),
    calls: 0, callLimit: Math.min(120, groups.length * groupCallLimit), groupCallLimit, concurrency: 3, groups, hash: "" });
}

export function readRepairCheckpoint(input: unknown): RepairCheckpoint {
  const value = objectFields(input);
  if (value.version !== 1 || !Array.isArray(value.issues) || !Array.isArray(value.groups)
    || !Number.isSafeInteger(value.calls) || !Number.isSafeInteger(value.callLimit)
    || !Number.isSafeInteger(value.groupCallLimit) || typeof value.bindingHash !== "string" || typeof value.baseHash !== "string") fail();
  const state = clone(input) as RepairCheckpoint;
  if (seal(state).hash !== state.hash || state.concurrency !== 3 || state.groupCallLimit < 1 || state.groupCallLimit > 12
    || state.groups.length < 1 || state.groups.length > 160 || state.callLimit !== Math.min(120, state.groups.length * state.groupCallLimit)
    || state.calls < 0 || state.calls > state.callLimit || state.calls !== state.groups.reduce((sum, group) => sum + group.calls, 0)
    || new Set(state.groups.map(group => group.id)).size !== state.groups.length) fail();
  const ids = state.groups.flatMap(group => group.issueIds);
  if (ids.length !== state.issues.length || new Set(ids).size !== ids.length
    || state.issues.some(issue => !ids.includes(issue.id))) fail();
  for (const group of state.groups) {
    const owned = state.issues.filter(issue => group.issueIds.includes(issue.id));
    if (group.issueIds.length > 3 || repairHash([...new Set(owned.flatMap(issue => issue.paths))].sort()) !== repairHash(group.paths)
      || !Array.isArray(group.dependsOn) || group.dependsOn.some(id => id === group.id || !state.groups.some(other => other.id === id))
      || !Array.isArray(group.paths) || !group.paths.length || !Number.isSafeInteger(group.wave) || group.wave < 0
      || !Number.isSafeInteger(group.calls) || group.calls < 0 || group.calls > state.groupCallLimit
      || group.calls > 0 && !group.sessionFile || group.sessionFile !== null && !/^[\w.-]+\.jsonl$/u.test(group.sessionFile)
      || group.wave === 0 && (group.calls || group.result || group.inputHash)
      || group.wave > 0 && typeof group.inputHash !== "string" || group.result && !group.calls) fail();
    for (const path of group.paths) keys(path);
  }
  return state;
}

/** Workers only propose patches. A persisted wave is replayed before any new work is scheduled. */
export async function runRepairSchedule(options: { checkpoint: RepairCheckpoint; binding: unknown; base: unknown;
  save(state: RepairCheckpoint): Promise<void>; run(worker: RepairWorker): Promise<unknown>; signal?: AbortSignal | undefined }): Promise<unknown> {
  let state = readRepairCheckpoint(options.checkpoint), writes = Promise.resolve(), persistenceError: unknown;
  if (state.bindingHash !== repairHash(options.binding) || state.baseHash !== repairHash(options.base)) fail();
  const active = () => { options.signal?.throwIfAborted(); if (persistenceError) throw persistenceError; };
  const update = (change: (next: RepairCheckpoint) => void) => {
    const pending = writes.then(async () => {
      active(); const next = clone(state); change(next); const saved = seal(next);
      try { await options.save(clone(saved)); } catch (error) { persistenceError ??= error; throw error; }
      state = saved; active();
    });
    writes = pending.catch(() => {}); return pending;
  };
  await update(() => {});
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
    const settled = await Promise.allSettled(groups.filter(group => !group.result).map(async original => {
      const current = () => state.groups.find(group => group.id === original.id)!;
      if (current().calls >= state.groupCallLimit || state.calls >= state.callLimit) fail("修复子任务额度已用完，已完成组保留，不能重新分派刷新额度。");
      await options.run({ group: clone(original), base: clone(base), baseHash: repairHash(base),
        issues: clone(state.issues.filter(issue => original.issueIds.includes(issue.id))), callLimit: state.groupCallLimit,
        onSession: file => update(next => {
          const group = next.groups.find(group => group.id === original.id)!;
          if (!/^[\w.-]+\.jsonl$/u.test(file) || group.sessionFile && group.sessionFile !== file) fail();
          group.sessionFile = file;
        }),
        onCall: (retryAttempt = 0) => update(next => {
          const group = next.groups.find(group => group.id === original.id)!;
          if (retryAttempt > 0) return;
          if (!group.sessionFile || group.result || group.calls >= next.groupCallLimit || next.calls >= next.callLimit) fail("修复调用额度已耗尽。");
          group.calls++; next.calls++;
        }),
        submit: async value => {
          active(); const result = validateRepairResult(value, current(), base);
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
    base = applyRepairUpdates(base, completed.flatMap(group => group.result!.updates)); wave++;
  }
}
