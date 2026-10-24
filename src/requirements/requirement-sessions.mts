import { checkedConsultation } from "./consultation-storage.mjs";
import type { UnknownRecord } from "../contracts/json.mjs";
import type { JsonStoragePort } from "../runtime/storage-port.mjs";
import { readStoredObject } from "../runtime/storage-port.mjs";
import { isArray, isInteger, objectFields, errorField } from "../runtime/type-boundary.mjs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { GroupStorage, id } from "../collaboration/group-store.mjs";
import { InputError, normalizeDraft, processTurn } from "./core.mjs";
import { contentHash } from "./task-spec.mjs";
import { issueConfirmation, newConsultation } from "./consultation.mjs";
import { assertRequirementDraftSize, REQUIREMENT_CONVERSATION_MAX_BYTES } from "./requirement-limits.mjs";
interface RequirementRecord extends UnknownRecord {
  schemaVersion: 1; id: string; version: number; draft: unknown; lastQuestion: unknown; consultation: unknown;
  requests: { id: string; inputHash: string; result: UnknownRecord }[];
  boundAgentId?: string; confirmed?: boolean; confirmedRequestId?: string | null;
}
interface RequirementAgentsPort {
  getRequirements?(): Promise<{ requirements: { id: string; draft: unknown }[] }>;
  getRequirementConsultation?(id: string): unknown | Promise<unknown>;
  saveRequirements?(id: string, input: { name: unknown; draft: unknown }, metadata: { confirmation: unknown; requestId: unknown; consultation: unknown }): unknown | Promise<unknown>;
}

const conflict = () => Object.assign(new InputError("这份需求已在另一窗口更新，请重新打开后继续"), { reason: "requirement_conflict" });
const checkRecordSize = (record: unknown) => {
  const bytes = Buffer.byteLength(JSON.stringify(record), "utf8");
  if (bytes > REQUIREMENT_CONVERSATION_MAX_BYTES) throw Object.assign(new InputError("需求会话已达 32 MiB，请开始新会话；已有记录保留"),
    { reason: "requirement_conversation_too_large", bytes, limitBytes: REQUIREMENT_CONVERSATION_MAX_BYTES });
};

/** Server-owned state: client drafts are only an initial import, never an approval. */
export class RequirementSessions {
  readonly storage: JsonStoragePort;
  readonly agents: RequirementAgentsPort | undefined;
  readonly ready: Promise<void> | undefined;
  readonly queues = new Map<string, Promise<unknown>>();
  constructor({ dataDir, agents, storage = new GroupStorage({ dataDir: join(dataDir, "requirement-sessions") }) }: { dataDir: string; agents?: RequirementAgentsPort; storage?: JsonStoragePort }) {
    this.storage = storage; this.agents = agents; this.ready = storage.ready;
  }

  queue<T>(sessionId: string, operation: () => T | PromiseLike<T>): Promise<T> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.queues.set(sessionId, next);
    void next.finally(() => { if (this.queues.get(sessionId) === next) this.queues.delete(sessionId); }).catch(() => {});
    return next;
  }

  async get(sessionId: string): Promise<RequirementRecord | null> {
    id(sessionId, "需求会话");
    const value = await readStoredObject(this.storage, sessionId, "session.json", { maxBytes: REQUIREMENT_CONVERSATION_MAX_BYTES });
    if (value && (value.schemaVersion !== 1 || value.id !== sessionId || !isInteger(value.version)
      || !isArray(value.requests) || !value.consultation || value.requests.some((raw) => {
        const request = objectFields(raw); return typeof request.id !== "string" || typeof request.inputHash !== "string" || !request.result || typeof request.result !== "object";
      }))) throw new InputError("需求协商记录损坏，请保留文件并检查");
    if (value) {
      try { assertRequirementDraftSize(value.draft); }
      catch (error) { throw Object.assign(new InputError(errorField(error, "reason") ? String(errorField(error, "message")) : "需求协商记录损坏，请保留文件并检查"),
        errorField(error, "reason") ? { reason: errorField(error, "reason"), bytes: errorField(error, "bytes"), limitBytes: errorField(error, "limitBytes") } : {}); }
    }
    return value as RequirementRecord | null;
  }

  async state(sessionId: string) {
    const record = await this.get(sessionId);
    if (!record) throw new InputError("需求会话不存在，请重新开始");
    return { ...(record.requests.at(-1)?.result ?? {}), requirementSessionId: sessionId, requirementVersion: record.version };
  }

  turn(body: unknown, providers: Parameters<typeof processTurn>[1], { signal, onProgress }: { signal?: AbortSignal; onProgress?: (event: UnknownRecord) => void } = {}) {
    if (!body || typeof body !== "object" || isArray(body)) throw new InputError("需求请求格式无效");
    const input = objectFields(body);
    const sessionId = id(input.requirementSessionId ?? `req_${randomUUID()}`, "需求会话"), requestId = id(input.requestId ?? `turn_${randomUUID()}`, "需求请求");
    id(sessionId, "需求会话"); id(requestId, "需求请求");
    return this.queue(sessionId, async () => {
      signal?.throwIfAborted();
      const existing = await this.get(sessionId);
      const inputHash = contentHash({ message: input.message });
      const previous = existing?.requests.find((request) => request.id === requestId);
      if (previous) {
        if (previous.inputHash !== inputHash) throw conflict();
        return structuredClone(previous.result);
      }
      if (existing && input.requirementVersion !== existing.version || !existing && (input.requirementVersion as number) > 0) throw conflict();
      const record: RequirementRecord = existing ?? { schemaVersion: 1, id: sessionId, version: 0, draft: normalizeDraft(input.draft),
        lastQuestion: "", consultation: newConsultation(), requests: [] };
      if (!existing && input.agentId) {
        id(input.agentId, "智能体");
        const saved = (await this.agents?.getRequirements?.())?.requirements?.find((item) => item.id === input.agentId);
        if (!saved) throw new InputError("没有找到要编辑的智能体需求");
        record.draft = normalizeDraft(saved.draft); record.boundAgentId = input.agentId as string;
        record.consultation = await this.agents?.getRequirementConsultation?.(input.agentId as string) ?? newConsultation();
      }
      const turnOptions = { signal, onProgress, enforceConsultation: true, requestId,
        ...(record.boundAgentId ? { verificationContext: { agentId: record.boundAgentId } } : {}) };
      const result = await processTurn({ message: input.message, draft: record.draft, lastQuestion: record.lastQuestion,
        consultation: checkedConsultation(record.consultation), userMessages: [], evidenceMessages: [{
          id: `request_user_${contentHash({ sessionId, requestId }).slice(0, 32)}`,
          role: "user", content: typeof input.message === "string" ? input.message.trim() : "",
        }] }, providers,
      turnOptions);
      signal?.throwIfAborted();
      const { confirmation, consultation, ...publicResult } = result;
      const version = record.version + 1;
      const response = { ...publicResult, requirementSessionId: sessionId, requirementVersion: version };
      const next = { ...record, version, draft: result.draft, lastQuestion: result.question ?? result.confirmationQuestion ?? "",
        consultation, confirmed: result.confirmed, confirmedRequestId: result.confirmed ? requestId : null,
        requests: [...record.requests, { id: requestId, inputHash, result: response }].slice(-100), updatedAt: new Date().toISOString() };
      checkRecordSize(next);
      await this.storage.writeJson(sessionId, "session.json", next, { signal });
      return response;
    });
  }

  save(sessionId: string, agentId: string, value: { name: unknown; draft: unknown }, agents: RequirementAgentsPort) {
    id(sessionId, "需求会话"); id(agentId, "智能体");
    return this.queue(sessionId, async () => {
      const record = await this.get(sessionId);
      if (!record?.confirmed || record.boundAgentId && record.boundAgentId !== agentId
        || contentHash(normalizeDraft(value.draft)) !== contentHash(record.draft)) throw new InputError("这份需求尚未在当前会话确认，或确认后内容已改变");
      const confirmation = issueConfirmation(normalizeDraft(record.draft), checkedConsultation(record.consultation), { requestId: record.confirmedRequestId ?? undefined });
      // Bind before saving, so a disconnected response cannot duplicate one confirmation under another Agent ID.
      if (!record.boundAgentId) { record.boundAgentId = agentId; checkRecordSize(record); await this.storage.writeJson(sessionId, "session.json", record); }
      return agents.saveRequirements!(agentId, { name: value.name, draft: record.draft },
        { confirmation, requestId: record.confirmedRequestId, consultation: record.consultation });
    });
  }

  close() { return Promise.allSettled([...this.queues.values()]); }
}
