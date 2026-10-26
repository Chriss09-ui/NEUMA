import { isExecutionAttempt, executionOutcome } from "../runtime/execution-attempt.mjs";
import type { JsonValue, UnknownRecord } from "../contracts/json.mjs";
import type { ApplicationTaskInput, ApplicationTask, TaskArtifact, TaskRecord, ApplicationState } from "../contracts/application.mjs";
import type { AgentStoragePort } from "../runtime/storage-port.mjs";
import { readStoredObject } from "../runtime/storage-port.mjs";
import { objectFields, isRecord, isArray, isInteger } from "../runtime/type-boundary.mjs";
import { randomUUID, createHash } from "node:crypto";
import { InputError } from "../requirements/core.mjs";
import { agentId } from "../agents/agent-storage.mjs";
import { APPLICATION_STATE_VALUE_BYTES, APPLICATION_STATE_RECORD_BYTES, APPLICATION_TASK_INPUT_BYTES } from "../runtime/runtime-capability-contract.mjs";
import { MAX_RUNTIME_FILE_BYTES } from "../runtime/file-limits.mjs";
import { removeTaskArtifact } from "./task-artifacts.mjs";
import { validateApplicationTaskEnvelope } from "./task-input-contract.mjs";
interface StateOptions { scope?: string; kind?: string; stateVersion?: number }
function checkedTask(value: unknown, id: string): ApplicationTask {
  const task = objectFields(value);
  if (task.agentId !== id || !isArray(task.events) || typeof task.id !== "string" || typeof task.status !== "string"
    || ["actionId", "mutationId", "deliveryVersion", "requestHash", "createdAt", "updatedAt"].some((key) => typeof task[key] !== "string")
    || !Object.hasOwn(task, "input") || !isInteger(task.sequence) || !isRecord(task.source) || typeof task.source.scope !== "string"
    || (task.source.kind !== undefined && typeof task.source.kind !== "string")
    || (task.allowNetwork !== undefined && typeof task.allowNetwork !== "boolean")
    || (task.workflowId !== undefined && typeof task.workflowId !== "string")
    || (task.error !== undefined && task.error !== null && typeof task.error !== "string")
    || (task.finishedAt !== undefined && task.finishedAt !== null && typeof task.finishedAt !== "string")
    || !isArray(task.artifacts) || task.artifacts.some((raw) => {
      const artifact = objectFields(raw); return typeof artifact.path !== "string" || artifact.snapshotId !== undefined && typeof artifact.snapshotId !== "string";
    })
    || task.events.some((raw) => {
      const event = objectFields(raw); return !isInteger(event.seq) || ["type", "at", "taskId"].some((key) => typeof event[key] !== "string");
    })
    || (task.resumeReceipts !== undefined && (!isArray(task.resumeReceipts) || task.resumeReceipts.some((item) => {
      const receipt = objectFields(item); return typeof receipt.mutationId !== "string" || typeof receipt.requestHash !== "string";
    })))) throw new InputError("应用任务记录无效，请保留原文件");
  if (task.execution !== undefined && !isExecutionAttempt(task.execution)) throw new InputError("应用执行尝试记录无效");
  // Only the storage envelope is trusted. Action inputs/results retain their independent schema gates.
  return task as ApplicationTask;
}
export { validateApplicationTaskEnvelope } from "./task-input-contract.mjs";

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_STATE_BYTES = APPLICATION_STATE_RECORD_BYTES;
const now = () => new Date().toISOString();
export const taskFinished = (task: { status: string }) => TERMINAL.has(task.status);
export const applicationConflict = (message: string) => Object.assign(new InputError(message), { reason: "application_conflict" });
function json(value: unknown, limit = APPLICATION_TASK_INPUT_BYTES, space?: number): JsonValue {
  let source;
  try { source = JSON.stringify(value, null, space); } catch { throw new InputError("应用数据必须是 JSON"); }
  if (!source || Buffer.byteLength(source) > limit) throw new InputError("应用数据超过大小限制");
  return JSON.parse(source) as JsonValue;
}
function taskRequestHash(task: ApplicationTaskInput) {
  const source = { ...task.source };
  // Page bindings decide where results may appear, not whether an operation is a retry.
  delete source.applicationContext;
  return createHash("sha256").update(JSON.stringify([task.actionId, task.input, task.deliveryVersion, source])).digest("hex");
}

export class ApplicationTaskStore {
  readonly storage: AgentStoragePort;
  readonly queues = new Map<string, Promise<void>>();
  readonly ready: Promise<void>;
  constructor({ storage }: { storage: AgentStoragePort }) {
    this.storage = storage; this.ready = this.recover(); this.ready.catch(() => {});
  }
  serial<T>(id: string, fn: () => T | PromiseLike<T>): Promise<T> {
    agentId(id);
    const pending = (this.queues.get(id) ?? Promise.resolve()).then(fn);
    const settled = pending.then(() => {}, () => {}); this.queues.set(id, settled);
    settled.finally(() => { if (this.queues.get(id) === settled) this.queues.delete(id); });
    return pending;
  }
  async record(id: string): Promise<TaskRecord> {
    const record = await readStoredObject(this.storage, id, "application/tasks.json", { maxBytes: MAX_BYTES });
    if (!record) return { version: 1, agentId: id, tasks: [] };
    if (record.version !== 1 || record.agentId !== id || !isArray(record.tasks)
      || record.tasks.some((task) => objectFields(task).agentId !== id || !isArray(objectFields(task).events))) throw new InputError("应用任务记录无效，请保留原文件");
    record.tasks.forEach((task) => checkedTask(task, id));
    return record as TaskRecord;
  }
  async save(id: string, record: TaskRecord) {
    // Match AgentStorage's persisted encoding, including indentation.
    json(record, MAX_BYTES, 2);
    const interrupted = this.interruptedRecord(record);
    if (interrupted) json(interrupted, MAX_BYTES, 2);
    await this.storage.writeJson(id, "application/tasks.json", record);
  }
  event(task: ApplicationTask, type: string, value: UnknownRecord = {}) {
    // Events carry the same result patch accepted by update, not a new task input.
    const event = { ...objectFields(json(value, 1024 * 1024)), type, seq: ++task.sequence, at: now(), taskId: task.id };
    task.events.push(event); task.updatedAt = event.at;
  }
  interruptedRecord(record: TaskRecord) {
    let changed = false;
    const tasks = record.tasks.map((task) => {
      if (taskFinished(task)) return task;
      const interrupted = { ...task, events: [...task.events], status: "interrupted",
        error: task.execution && executionOutcome(task.execution) === "not_started" ? "NEUMA 已重启，任务尚未分派；可重新提交。" : "NEUMA 已重启，任务已中断；请核实外部操作后重新提交。", finishedAt: now() };
      this.event(interrupted, "interrupted", { error: interrupted.error }); changed = true;
      return interrupted;
    });
    return changed ? { ...record, tasks } : null;
  }
  async recover() {
    for (const id of await this.storage.agentIds()) await this.serial(id, async () => {
      const interrupted = this.interruptedRecord(await this.record(id));
      if (interrupted) await this.save(id, interrupted);
    });
  }
  view(task: ApplicationTask) { const { events, mutationId, requestHash, ...value } = task; return structuredClone({ ...value, taskId: task.id, ...(task.execution ? { executionOutcome: executionOutcome(task.execution) } : {}) }); }
  async create(id: string, input: ApplicationTaskInput) {
    await this.ready;
    return this.serial(id, async () => {
      const record = await this.record(id);
      if (typeof input.mutationId !== "string" || !/^[\w-]{8,100}$/.test(input.mutationId)) throw new InputError("请提供稳定的任务幂等标识");
      const requestHash = taskRequestHash(input);
      const existing = record.tasks.find((task) => task.mutationId === input.mutationId);
      if (existing) {
        // Recompute legacy records whose stored hash included the page binding.
        if (taskRequestHash(existing) !== requestHash) throw applicationConflict("这个幂等标识已用于其他任务，请使用新的标识");
        return { task: this.view(existing), created: false };
      }
      const task: ApplicationTask = { ...(validateApplicationTaskEnvelope(input) as ApplicationTaskInput), id: randomUUID(), agentId: id, status: "queued", sequence: 0,
        requestHash, createdAt: now(), updatedAt: now(), progress: null, result: null, artifacts: [], events: [] };
      this.event(task, "queued"); record.tasks.push(task); await this.save(id, record);
      return { task: this.view(task), created: true };
    });
  }
  async list(id: string, { scope }: { scope?: string } = {}) {
    agentId(id); await this.ready;
    const { tasks } = await this.record(id);
    return tasks.filter((task) => scope === undefined || task.source.scope === scope).map((task) => this.view(task));
  }
  async get(id: string, taskId: string) {
    agentId(taskId); await this.ready;
    const task = (await this.record(id)).tasks.find((task) => task.id === taskId);
    if (!task) throw new InputError("没有找到这个 Agent 的应用任务");
    return this.view(task);
  }
  async update(id: string, taskId: string, patch: Partial<ApplicationTask>, type = patch.status ?? "progress") {
    await this.ready;
    return this.serial(id, async () => {
      const record = await this.record(id), task = record.tasks.find((task) => task.id === taskId);
      if (!task) throw new InputError("应用任务不存在");
      if (taskFinished(task)) return this.view(task);
      Object.assign(task, json(patch, 1024 * 1024));
      if (taskFinished(task)) task.finishedAt = now();
      this.event(task, type, patch); await this.save(id, record); return this.view(task);
    });
  }
  async resume(id: string, taskId: string, { expectedVersion, mutationId, input, resolution }: { expectedVersion: unknown; mutationId: unknown; input?: unknown; resolution?: unknown }, patch: Partial<ApplicationTask> = {}) {
    await this.ready;
    if (typeof mutationId !== "string" || !/^[\w-]{8,100}$/.test(mutationId)) throw new InputError("继续任务需要稳定的请求编号");
    const requestHash = createHash("sha256").update(JSON.stringify([input ?? null, resolution ?? null])).digest("hex");
    return this.serial(id, async () => {
      const record = await this.record(id), task = record.tasks.find((task) => task.id === taskId);
      if (!task?.workflowId) throw new InputError("这个任务没有可继续的流程检查点");
      const receipt = (task.resumeReceipts ?? []).find((item) => item.mutationId === mutationId);
      if (receipt) {
        if (receipt.requestHash !== requestHash) throw applicationConflict("请求编号已用于不同的继续操作");
        return { task: this.view(task), created: false };
      }
      if (expectedVersion !== task.sequence) throw applicationConflict("任务状态已变化，请刷新后继续");
      if (!["waiting_input", "interrupted", "needs_review", "failed"].includes(task.status)) throw applicationConflict("任务当前不能继续");
      Object.assign(task, json(patch), { status: "queued", error: null, finishedAt: null });
      task.resumeReceipts = [...(task.resumeReceipts ?? []), { mutationId, requestHash }].slice(-100);
      this.event(task, "resuming"); await this.save(id, record);
      return { task: this.view(task), created: true };
    });
  }
  async appendArtifact(id: string, taskId: string, artifact: unknown) {
    await this.ready;
    const clean = objectFields(json(artifact));
    if (typeof clean.path !== "string" || !clean.path) throw new InputError("应用产物路径无效");
    if (clean.snapshotId !== undefined && (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(clean.snapshotId as string)
      || typeof clean.name !== "string" || !clean.name || !isInteger(clean.size) || clean.size < 0 || clean.size > MAX_RUNTIME_FILE_BYTES
      || !/^[a-f0-9]{64}$/.test((clean.sha256 ?? "") as string))) throw new InputError("应用产物快照信息无效");
    return this.serial(id, async () => {
      const record = await this.record(id), task = record.tasks.find((task) => task.id === taskId);
      if (!task) throw new InputError("应用任务不存在");
      if (taskFinished(task)) return this.view(task);
      const replaced = task.artifacts.find((file) => file.path === clean.path);
      task.artifacts = [...task.artifacts.filter((file) => file.path !== clean.path), clean as TaskArtifact];
      this.event(task, "artifact", { artifacts: task.artifacts });
      await this.save(id, record);
      // Keep the new reference committed even if obsolete-file cleanup fails.
      if (replaced?.snapshotId && replaced.snapshotId !== clean.snapshotId)
        await removeTaskArtifact({ storage: this.storage, id, taskId, artifact: replaced }).catch(() => {});
      return this.view(task);
    });
  }
  async events(id: string, taskId: string, after = 0) {
    if (!isInteger(after) || after < 0) throw new InputError("任务事件续读位置无效");
    await this.ready;
    const task = (await this.record(id)).tasks.find((item) => item.id === taskId);
    if (!task) throw new InputError("应用任务不存在");
    const events = task.events.filter((event) => event.seq > after).slice(0, 200);
    return { events, lastSequence: events.at(-1)?.seq ?? after, latestSequence: task.sequence };
  }
  statePath(scope: string, kind: string) {
    if (!["draft", "business"].includes(kind) || typeof scope !== "string" || scope.length > 300) throw new InputError("应用状态范围无效");
    return `application/${kind}/${createHash("sha256").update(scope).digest("hex")}.json`;
  }
  async getState(id: string, { scope = "private", kind = "draft", stateVersion = 1 }: StateOptions = {}): Promise<ApplicationState> {
    agentId(id); await this.ready;
    const value = await readStoredObject(this.storage, id, this.statePath(scope, kind), { maxBytes: MAX_STATE_BYTES });
    if (!value) return { state: {}, version: 0, stateVersion };
    if (value.stateVersion !== stateVersion) throw applicationConflict("应用状态版本已变化，请先完成状态迁移");
    if (!isInteger(value.version) || value.version < 0 || !Object.hasOwn(value, "state")) throw new InputError("应用状态记录无效，请保留原文件");
    return value as ApplicationState;
  }
  async setState(id: string, { state, expectedVersion }: { state: unknown; expectedVersion: unknown }, options: StateOptions = {}) {
    await this.ready; const clean = json(state, APPLICATION_STATE_VALUE_BYTES);
    return this.serial(id, async () => {
      const previous = await this.getState(id, options);
      if (!isInteger(expectedVersion) || expectedVersion !== previous.version) throw applicationConflict("应用状态已被其他窗口更新，请重新读取后保存");
      const next = { state: clean, version: previous.version + 1, stateVersion: previous.stateVersion };
      json(next, MAX_STATE_BYTES, 2);
      await this.storage.writeJson(id, this.statePath(options.scope ?? "private", options.kind ?? "draft"), next); return next;
    });
  }
  async settle() { await Promise.all([...this.queues.values()]); }
}
