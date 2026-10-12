import { randomUUID, createHash } from "node:crypto";
import { InputError } from "../requirements/core.mjs";
import { agentId } from "../agents/agent-storage.mjs";

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
const MAX_BYTES = 16 * 1024 * 1024;
const now = () => new Date().toISOString();
export const taskFinished = (task) => TERMINAL.has(task.status);
export const applicationConflict = (message) => Object.assign(new InputError(message), { reason: "application_conflict" });
function json(value, limit = 128 * 1024) {
  let source;
  try { source = JSON.stringify(value); } catch { throw new InputError("应用数据必须是 JSON"); }
  if (!source || Buffer.byteLength(source) > limit) throw new InputError("应用数据超过大小限制");
  return JSON.parse(source);
}

export class ApplicationTaskStore {
  constructor({ storage }) {
    this.storage = storage; this.queues = new Map(); this.ready = this.recover(); this.ready.catch(() => {});
  }
  serial(id, fn) {
    agentId(id);
    const pending = (this.queues.get(id) ?? Promise.resolve()).then(fn);
    const settled = pending.catch(() => {}); this.queues.set(id, settled);
    settled.finally(() => { if (this.queues.get(id) === settled) this.queues.delete(id); });
    return pending;
  }
  async record(id) {
    const record = await this.storage.readJson(id, "application/tasks.json", { maxBytes: MAX_BYTES });
    if (!record) return { version: 1, agentId: id, tasks: [] };
    if (record.version !== 1 || record.agentId !== id || !Array.isArray(record.tasks)
      || record.tasks.some((task) => task.agentId !== id || !Array.isArray(task.events))) throw new InputError("应用任务记录无效，请保留原文件");
    return record;
  }
  async save(id, record) {
    json(record, MAX_BYTES);
    await this.storage.writeJson(id, "application/tasks.json", record);
  }
  event(task, type, value = {}) {
    const event = { ...json(value), type, seq: ++task.sequence, at: now(), taskId: task.id };
    task.events.push(event); task.updatedAt = event.at;
  }
  async recover() {
    for (const id of await this.storage.agentIds()) await this.serial(id, async () => {
      const record = await this.record(id); let changed = false;
      for (const task of record.tasks) if (!taskFinished(task)) {
        task.status = "interrupted"; task.error = "NEUMA 已重启，任务已中断；请核实外部操作后重新提交。";
        task.finishedAt = now(); this.event(task, "interrupted", { error: task.error }); changed = true;
      }
      if (changed) await this.save(id, record);
    });
  }
  view(task) { const { events, mutationId, requestHash, ...value } = task; return structuredClone({ ...value, taskId: task.id }); }
  async create(id, input) {
    await this.ready;
    return this.serial(id, async () => {
      const record = await this.record(id);
      if (typeof input.mutationId !== "string" || !/^[\w-]{8,100}$/.test(input.mutationId)) throw new InputError("请提供稳定的任务幂等标识");
      const requestHash = createHash("sha256").update(JSON.stringify([input.actionId, input.input, input.deliveryVersion, input.source])).digest("hex");
      const existing = record.tasks.find((task) => task.mutationId === input.mutationId);
      if (existing) {
        if (existing.requestHash !== requestHash) throw applicationConflict("这个幂等标识已用于其他任务，请使用新的标识");
        return { task: this.view(existing), created: false };
      }
      const task = { ...json(input), id: randomUUID(), agentId: id, status: "queued", sequence: 0,
        requestHash, createdAt: now(), updatedAt: now(), progress: null, result: null, artifacts: [], events: [] };
      this.event(task, "queued"); record.tasks.push(task); await this.save(id, record);
      return { task: this.view(task), created: true };
    });
  }
  async list(id, { scope } = {}) {
    agentId(id); await this.ready;
    const { tasks } = await this.record(id);
    return tasks.filter((task) => scope === undefined || task.source.scope === scope).map((task) => this.view(task));
  }
  async get(id, taskId) {
    agentId(taskId); await this.ready;
    const task = (await this.record(id)).tasks.find((task) => task.id === taskId);
    if (!task) throw new InputError("没有找到这个 Agent 的应用任务");
    return this.view(task);
  }
  async update(id, taskId, patch, type = patch.status ?? "progress") {
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
  async events(id, taskId, after = 0) {
    if (!Number.isSafeInteger(after) || after < 0) throw new InputError("任务事件续读位置无效");
    await this.ready;
    const task = (await this.record(id)).tasks.find((item) => item.id === taskId);
    if (!task) throw new InputError("应用任务不存在");
    const events = task.events.filter((event) => event.seq > after).slice(0, 200);
    return { events, lastSequence: events.at(-1)?.seq ?? after, latestSequence: task.sequence };
  }
  statePath(scope, kind) {
    if (!["draft", "business"].includes(kind) || typeof scope !== "string" || scope.length > 300) throw new InputError("应用状态范围无效");
    return `application/${kind}/${createHash("sha256").update(scope).digest("hex")}.json`;
  }
  async getState(id, { scope = "private", kind = "draft", stateVersion = 1 } = {}) {
    agentId(id); await this.ready;
    const value = await this.storage.readJson(id, this.statePath(scope, kind), { maxBytes: 1024 * 1024 });
    if (!value) return { state: {}, version: 0, stateVersion };
    if (value.stateVersion !== stateVersion) throw applicationConflict("应用状态版本已变化，请先完成状态迁移");
    return value;
  }
  async setState(id, { state, expectedVersion }, options = {}) {
    await this.ready; const clean = json(state, 900 * 1024);
    return this.serial(id, async () => {
      const previous = await this.getState(id, options);
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== previous.version) throw applicationConflict("应用状态已被其他窗口更新，请重新读取后保存");
      const next = { state: clean, version: previous.version + 1, stateVersion: previous.stateVersion };
      await this.storage.writeJson(id, this.statePath(options.scope ?? "private", options.kind ?? "draft"), next); return next;
    });
  }
  async settle() { await Promise.all([...this.queues.values()]); }
}
