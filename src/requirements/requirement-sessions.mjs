import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { GroupStorage, id } from "../collaboration/group-store.mjs";
import { InputError, normalizeDraft, processTurn } from "./core.mjs";
import { contentHash } from "./task-spec.mjs";
import { issueConfirmation, newConsultation } from "./consultation.mjs";

const conflict = () => Object.assign(new InputError("这份需求已在另一窗口更新，请重新打开后继续"), { reason: "requirement_conflict" });

/** Server-owned state: client drafts are only an initial import, never an approval. */
export class RequirementSessions {
  constructor({ dataDir, agents, storage = new GroupStorage({ dataDir: join(dataDir, "requirement-sessions") }) }) {
    this.storage = storage; this.agents = agents; this.ready = storage.ready; this.queues = new Map();
  }

  queue(sessionId, operation) {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.queues.set(sessionId, next);
    void next.finally(() => { if (this.queues.get(sessionId) === next) this.queues.delete(sessionId); }).catch(() => {});
    return next;
  }

  async get(sessionId) {
    id(sessionId, "需求会话");
    const value = await this.storage.readJson(sessionId, "session.json");
    if (value && (value.schemaVersion !== 1 || value.id !== sessionId || !Number.isSafeInteger(value.version)
      || !Array.isArray(value.requests) || !value.consultation)) throw new InputError("需求协商记录损坏，请保留文件并检查");
    return value;
  }

  async state(sessionId) {
    const record = await this.get(sessionId);
    if (!record) throw new InputError("需求会话不存在，请重新开始");
    return { ...(record.requests.at(-1)?.result ?? {}), requirementSessionId: sessionId, requirementVersion: record.version };
  }

  turn(body, providers, { signal, onProgress } = {}) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new InputError("需求请求格式无效");
    const sessionId = body.requirementSessionId ?? `req_${randomUUID()}`, requestId = body.requestId ?? `turn_${randomUUID()}`;
    id(sessionId, "需求会话"); id(requestId, "需求请求");
    return this.queue(sessionId, async () => {
      signal?.throwIfAborted();
      const existing = await this.get(sessionId);
      const inputHash = contentHash({ message: body.message });
      const previous = existing?.requests.find((request) => request.id === requestId);
      if (previous) {
        if (previous.inputHash !== inputHash) throw conflict();
        return structuredClone(previous.result);
      }
      if (existing && body.requirementVersion !== existing.version || !existing && body.requirementVersion > 0) throw conflict();
      const record = existing ?? { schemaVersion: 1, id: sessionId, version: 0, draft: normalizeDraft(body.draft),
        lastQuestion: "", consultation: newConsultation(), requests: [] };
      if (!existing && body.agentId) {
        id(body.agentId, "智能体");
        const saved = (await this.agents?.getRequirements?.())?.requirements?.find((item) => item.id === body.agentId);
        if (!saved) throw new InputError("没有找到要编辑的智能体需求");
        record.draft = normalizeDraft(saved.draft); record.boundAgentId = body.agentId;
        record.consultation = await this.agents.getRequirementConsultation?.(body.agentId) ?? newConsultation();
      }
      const result = await processTurn({ message: body.message, draft: record.draft, lastQuestion: record.lastQuestion,
        consultation: record.consultation, userMessages: [] }, providers,
      { signal, onProgress, enforceConsultation: true, requestId });
      signal?.throwIfAborted();
      const { confirmation, consultation, ...publicResult } = result;
      const version = record.version + 1;
      const response = { ...publicResult, requirementSessionId: sessionId, requirementVersion: version };
      const next = { ...record, version, draft: result.draft, lastQuestion: result.question ?? result.confirmationQuestion ?? "",
        consultation, confirmed: result.confirmed, confirmedRequestId: result.confirmed ? requestId : null,
        requests: [...record.requests, { id: requestId, inputHash, result: response }].slice(-100), updatedAt: new Date().toISOString() };
      await this.storage.writeJson(sessionId, "session.json", next, { signal });
      return response;
    });
  }

  save(sessionId, agentId, value, agents) {
    id(sessionId, "需求会话"); id(agentId, "智能体");
    return this.queue(sessionId, async () => {
      const record = await this.get(sessionId);
      if (!record?.confirmed || record.boundAgentId && record.boundAgentId !== agentId
        || contentHash(normalizeDraft(value.draft)) !== contentHash(record.draft)) throw new InputError("这份需求尚未在当前会话确认，或确认后内容已改变");
      const confirmation = issueConfirmation(record.draft, record.consultation, { requestId: record.confirmedRequestId });
      // Bind before saving, so a disconnected response cannot duplicate one confirmation under another Agent ID.
      if (!record.boundAgentId) { record.boundAgentId = agentId; await this.storage.writeJson(sessionId, "session.json", record); }
      return agents.saveRequirements(agentId, { name: value.name, draft: record.draft },
        { confirmation, requestId: record.confirmedRequestId, consultation: record.consultation });
    });
  }

  close() { return Promise.allSettled([...this.queues.values()]); }
}
