import { InputError } from "./core.mjs";
import { AgentStorage, agentId } from "./agent-storage.mjs";

function requirement(id, value) {
  agentId(id);
  if (!value || typeof value.name !== "string" || !value.name.trim() || value.name.length > 120
    || !value.draft || typeof value.draft !== "object" || Array.isArray(value.draft)
    || typeof value.draft.goal?.value !== "string" || !value.draft.goal.value.trim()
    || JSON.stringify(value.draft).length > 60000 || (value.importOnly !== undefined && typeof value.importOnly !== "boolean"))
    throw new InputError("请提供有效的 Agent 名称与需求");
  if (value.updatedAt !== undefined && !Number.isFinite(Date.parse(value.updatedAt))) throw new InputError("需求保存时间无效");
  return { id, name: value.name.trim(), draft: structuredClone(value.draft), updatedAt: value.updatedAt ?? new Date().toISOString() };
}

function conversation(value) {
  if (value?.schemaVersion !== 2 || !Array.isArray(value.messages) || value.messages.length > 80
    || (value.importOnly !== undefined && typeof value.importOnly !== "boolean")) throw new InputError("保存对话格式无效");
  const messages = value.messages.map((item) => {
    if (!item || !["user", "assistant"].includes(item.role) || typeof item.content !== "string"
      || item.content.length > (item.role === "user" ? 4000 : 32000)
      || (item.role === "user" && !item.content.trim())) throw new InputError("保存对话内容无效");
    const result = { role: item.role, content: item.content };
    if (typeof item.revision === "string" && item.revision.length <= 120) result.revision = item.revision;
    if (item.role === "user" && ["sent", "failed", "stopped", "pending"].includes(item.delivery))
      result.delivery = item.delivery === "pending" ? "stopped" : item.delivery;
    if (item.role === "assistant") {
      result.status = ["complete", "error", "stopped"].includes(item.status) ? item.status : "stopped";
      if (typeof item.error === "string") result.error = item.error.slice(0, 2000);
    }
    return result;
  });
  return { schemaVersion: 2, messages };
}

export class AgentLibrary {
  constructor({ dataDir, storage = new AgentStorage({ dataDir }) }) {
    this.storage = storage;
    this.pending = new Map();
  }

  queue(id, action) {
    agentId(id);
    const result = (this.pending.get(id) ?? Promise.resolve()).then(action);
    const settled = result.catch(() => {});
    this.pending.set(id, settled);
    void settled.then(() => { if (this.pending.get(id) === settled) this.pending.delete(id); });
    return result;
  }

  async deleted(id) { return Boolean(await this.storage.readJson(id, "deleted.json")); }

  async list() {
    const requirements = [];
    for (const id of await this.storage.agentIds()) {
      await this.pending.get(id);
      if (await this.deleted(id)) continue;
      const source = await this.storage.readJson(id, "requirements.json");
      if (!source) continue;
      if (source.id !== id) throw new InputError("Agent 需求身份与文件夹不一致");
      const value = requirement(id, source);
      const definition = await this.storage.readJson(id, "definition.json");
      if (definition?.agent?.profile) value.profile = structuredClone(definition.agent.profile);
      requirements.push(value);
    }
    return { requirements: requirements.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)) };
  }

  saveRequirement(id, input) {
    const value = requirement(id, input);
    return this.queue(id, async () => {
      if (await this.deleted(id)) {
        if (input.importOnly) return { requirement: null, deleted: true };
        throw new InputError("这个 Agent 已删除，请创建新的 Agent");
      }
      const previous = await this.storage.readJson(id, "requirements.json");
      if (input.importOnly && previous) {
        const browserIsNewer = previous._legacyFallback === "definition" || (previous._legacyFallback === "architecture"
          && Date.parse(value.updatedAt) > Date.parse(previous.updatedAt));
        if (!browserIsNewer) return { requirement: requirement(id, previous) };
      }
      await this.storage.writeJson(id, "requirements.json", value);
      return { requirement: structuredClone(value) };
    });
  }

  async getConversation(id) {
    agentId(id); await this.pending.get(id);
    if (await this.deleted(id)) return { conversation: null, deleted: true };
    const source = await this.storage.readJson(id, "conversations/saved.json");
    return { conversation: source ? conversation(source) : null };
  }

  saveConversation(id, input) {
    const value = conversation(input);
    return this.queue(id, async () => {
      if (await this.deleted(id)) {
        if (input.importOnly) return { conversation: null, deleted: true };
        throw new InputError("这个 Agent 已删除，不能保存对话");
      }
      if (!await this.storage.readJson(id, "requirements.json") && !await this.storage.readJson(id, "definition.json"))
        throw new InputError("请先保存这个 Agent 的需求");
      const previous = await this.storage.readJson(id, "conversations/saved.json");
      if (input.importOnly && previous) return { conversation: conversation(previous) };
      await this.storage.writeJson(id, "conversations/saved.json", value);
      return { conversation: structuredClone(value) };
    });
  }

  remove(id) {
    return this.queue(id, async () => {
      await this.storage.writeJson(id, "deleted.json", { id, deletedAt: new Date().toISOString() });
      await this.storage.removeFile(id, "requirements.json");
      await this.storage.removeFile(id, "conversations/saved.json");
    });
  }
}
