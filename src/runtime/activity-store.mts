import type { AgentStoragePort } from "./storage-port.mjs";
import { objectFields, isRecord, isInteger } from "./type-boundary.mjs";
export type ActivityScope = { groupId: string; taskId: string } | { kind: "private"; sessionId: string } | { kind: "main"; conversationId: string };
export interface ActivityRecord { id: string; agentId: string; sessionId: string; revision: number; scope: ActivityScope; status: string; createdAt: string; startedAt: string | null; updatedAt: string; endedAt: string | null; summary: string; turns: number }
import { randomUUID } from "node:crypto";
import { InputError } from "../requirements/core.mjs";
import { safeDiagnosticText } from "../projects/project-diagnostics.mjs";

const MAX_ACTIVITIES = 200;
const live = new Set(["queued", "running"]);
const states = new Set([...live, "complete", "failed", "cancelled", "interrupted"]);
const identifier = (value: unknown): value is string => typeof value === "string" && /^[\w-]{1,80}$/.test(value);
const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const summary = (value: unknown) => safeDiagnosticText(value).slice(0, 240);

function scopeOf(value: unknown): ActivityScope {
  if (!isRecord(value)) throw new InputError("活动范围无效");
  const keys = Object.keys(value);
  if (keys.length === 2 && identifier(value.groupId) && identifier(value.taskId)) return { groupId: value.groupId, taskId: value.taskId };
  if (keys.length === 2 && value.kind === "private" && identifier(value.sessionId)) return { kind: "private", sessionId: value.sessionId };
  if (keys.length === 2 && value.kind === "main" && identifier(value.conversationId)) return { kind: "main", conversationId: value.conversationId };
  throw new InputError("活动范围无效");
}

function recordOf(input: unknown, agentId: string): ActivityRecord {
  const value = objectFields(input);
  if (!value || value.agentId !== agentId || !identifier(value.id) || !identifier(value.sessionId)
    || !isInteger(value.revision) || value.revision < 1 || typeof value.status !== "string" || !states.has(value.status)
    || !date(value.createdAt) || !date(value.updatedAt) || (value.startedAt !== null && !date(value.startedAt))
    || (value.endedAt !== null && !date(value.endedAt)) || typeof value.summary !== "string"
    || !isInteger(value.turns) || value.turns < 0) throw new InputError("Agent 活动记录格式无效，请保留原文件");
  return { id: value.id, agentId, sessionId: value.sessionId, revision: value.revision, scope: scopeOf(value.scope),
    status: value.status, createdAt: value.createdAt, startedAt: value.startedAt, updatedAt: value.updatedAt,
    endedAt: value.endedAt, summary: summary(value.summary), turns: value.turns };
}

export class ActivityStore {
  storage: Pick<AgentStoragePort, "agentIds" | "readJson" | "writeJson">; records: Map<string, ActivityRecord[]>; persistence: Promise<unknown>; ready: Promise<void>;
  constructor({ storage }: { storage: ActivityStore["storage"] }) {
    this.storage = storage;
    this.records = new Map();
    this.persistence = Promise.resolve();
    this.ready = this.load();
    this.ready.catch(() => {});
  }

  async load() {
    for (const agentId of await this.storage.agentIds()) {
      if (await this.storage.readJson(agentId, "deleted.json")) continue;
      const input = await this.storage.readJson(agentId, "activities.json", { maxBytes: 1024 * 1024 });
      if (!input) continue;
      const source = objectFields(input);
      if (source.schemaVersion !== 1 || !Array.isArray(source.activities) || source.activities.length > MAX_ACTIVITIES)
        throw new InputError("Agent 活动记录格式无效，请保留原文件");
      const ids = new Set();
      const records = source.activities.map((value) => {
        const record = recordOf(value, agentId);
        if (ids.has(record.id)) throw new InputError("Agent 活动记录包含重复标识");
        ids.add(record.id);
        if (live.has(record.status)) Object.assign(record, { status: "interrupted", updatedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(), summary: "服务停止前任务尚未完成，未自动重新执行。" });
        return record;
      });
      if (source.activities.some((record: unknown) => live.has(String(objectFields(record).status))))
        await this.storage.writeJson(agentId, "activities.json", { schemaVersion: 1, activities: records });
      this.records.set(agentId, records);
    }
  }

  commit<T>(agentId: string, update: (records: ActivityRecord[]) => T): Promise<T> {
    const operation = this.persistence.then(async () => {
      await this.ready;
      const records = structuredClone(this.records.get(agentId) ?? []);
      const result = update(records);
      while (records.length > MAX_ACTIVITIES) {
        const index = records.findIndex((record) => !live.has(record.status));
        if (index < 0) throw new InputError("当前 Agent 等待任务过多，请稍后重试");
        records.splice(index, 1);
      }
      await this.storage.writeJson(agentId, "activities.json", { schemaVersion: 1, activities: records });
      this.records.set(agentId, records);
      return structuredClone(result);
    });
    this.persistence = operation.catch(() => {});
    return operation;
  }

  async start({ agentId, sessionId, revision, scope, message }: { agentId: string; sessionId: string; revision: number; scope: ActivityScope; message: unknown }) {
    const now = new Date().toISOString();
    const record = recordOf({ id: randomUUID(), agentId, sessionId, revision, scope, status: "queued",
      createdAt: now, startedAt: null, updatedAt: now, endedAt: null, summary: summary(message), turns: 0 }, agentId);
    return this.commit(agentId, (records) => { records.push(record); return record; });
  }

  update(agentId: string, id: string, { status, turns, summary: text }: { status?: string | undefined; turns?: number | undefined; summary?: unknown; runtimeVerification?: unknown } = {}) {
    if (typeof status !== "string" || !states.has(status) || (turns !== undefined && (!Number.isSafeInteger(turns) || turns < 0)))
      return Promise.reject(new InputError("Agent 活动状态无效"));
    return this.commit(agentId, (records) => {
      const record = records.find((item) => item.id === id);
      if (!record) throw new InputError("没有找到 Agent 活动记录");
      if (!live.has(record.status)) return record;
      const now = new Date().toISOString();
      Object.assign(record, { status, updatedAt: now, ...(turns !== undefined ? { turns } : {}),
        ...(text !== undefined ? { summary: summary(text) } : {}),
        ...(status === "running" ? { startedAt: now } : {}), ...(!live.has(status) ? { endedAt: now } : {}) });
      return record;
    });
  }

  async snapshot() {
    await this.ready;
    await this.persistence;
    return { activities: structuredClone([...this.records.values()].flat()).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)) };
  }
}
