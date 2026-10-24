export type ConversationHistoryApi = Pick<AgentRuntime, "saveHistoryConversation" | "listConversations" | "getHistoryConversation" | "removeConversation">;
import type { AgentRuntime } from "./ui-api-types.js";
import type { AgentRequirement, ConversationRecord, ConversationRequest, FrontendError, Message } from "./ui-types.js";
import type { createReplyView } from "./chat-ui.js";
interface Saving { controller: AbortController; promise?: Promise<void> | undefined }
interface Reading extends Saving { sequence: number; version: number }
export interface HistoryItem extends Omit<ConversationRecord, "createdAt" | "updatedAt"> { createdAt?: string | undefined; updatedAt?: string | undefined; saved: boolean; pendingSync: boolean; localBackup: boolean; loaded: boolean; loading: Reading | null; saving: Saving | null; inputDraft: string; restoredInputDraft: boolean; sessionId: string; turn: { kind?: string | undefined; development?: boolean | undefined; controller: AbortController; reply: Message; avatarActivity: string } | null; error: string; storageError: string; sequence: number; saveTimer: ReturnType<typeof setTimeout> | null; retryRequest: ConversationRequest | null; conflict: boolean; deleting: boolean; deleted?: boolean | undefined; replyView?: ReturnType<typeof createReplyView> | null | undefined; userRows?: Map<Message, HTMLElement> | undefined }
interface HistoryLoading extends Saving { selection: number; active: HistoryItem; items: Map<string, { item: HistoryItem; sequence: number; saveVersion: number }> }
interface HistoryState { items: Map<string, HistoryItem>; loaded: boolean; loading: HistoryLoading | null; error: string; selection: number }
import { errorInfo } from "./ui-types.js";
import { agentHistorySnapshot, loadAgentConversationBackups, saveAgentConversationBackup,
  deleteAgentConversationBackup, loadActiveAgentConversation, saveActiveAgentConversation } from "./state.js";

const titleFor = (messages: Message[]) => Array.from(messages.find((entry) => entry.role === "user")?.content.replace(/\s+/g, " ").trim()
  || (messages.some((entry) => entry.role === "user" && entry.attachments?.length) ? "附件分析" : "新对话")).slice(0, 30).join("");

export class AgentConversationHistory {
  declare api: ConversationHistoryApi;
  declare storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null | undefined;
  declare onChange: (agentId: string, switched?: boolean) => unknown;
  declare exists: (agentId: string) => boolean;
  declare states: Map<string, HistoryState>;
  declare active: Map<string, HistoryItem>;
  constructor({ api, storage, onChange = () => {}, exists = () => true }: { api: ConversationHistoryApi; storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null | undefined; onChange?: ((agentId: string, switched?: boolean) => unknown) | undefined; exists?: ((agentId: string) => boolean) | undefined }) {
    this.api = api;
    this.storage = storage;
    this.onChange = onChange;
    this.exists = exists;
    this.states = new Map();
    this.active = new Map();
  }

  item(agentId: string, record: Partial<ConversationRecord> = {}): HistoryItem {
    return { ...record, id: record.id || crypto.randomUUID(), agentId, schemaVersion: 4,
      messages: record.messages ? agentHistorySnapshot(record.messages).messages : [],
      title: record.title || titleFor(record.messages || []), saveVersion: record.saveVersion || 0,
      mutationId: record.mutationId || crypto.randomUUID(),
      saved: Boolean(record.saveVersion && !record.pendingSync), pendingSync: Boolean(record.pendingSync),
      localBackup: Boolean(record.messages), loaded: Array.isArray(record.messages), loading: null, saving: null,
      inputDraft: typeof record.inputDraft === "string" ? record.inputDraft : "", restoredInputDraft: Boolean(record.inputDraft),
      sessionId: crypto.randomUUID(), turn: null, error: "", storageError: "", sequence: 0,
      saveTimer: null, retryRequest: record.retryRequest || null, conflict: false, deleting: false };
  }

  state(id: string) {
    if (!this.states.has(id)) {
      const items = new Map(loadAgentConversationBackups(this.storage, id).map((record) => {
        const item = this.item(id, record);
        return [item.id, item];
      }));
      const requested = loadActiveAgentConversation(this.storage, id);
      const selected = items.get(requested!) || [...items.values()].sort((a, b) =>
        Date.parse(String(b.updatedAt || 0)) - Date.parse(String(a.updatedAt || 0)))[0] || this.item(id);
      items.set(selected.id, selected);
      this.states.set(id, { items, loaded: false, loading: null, error: "", selection: 0 });
      this.active.set(id, selected);
    }
    return this.states.get(id)!;
  }

  current(id: string) { this.state(id); return this.active.get(id)!; }

  records(id: string) {
    return [...this.state(id).items.values()].filter((item) => !item.deleted && (item.messages.length || item.saveVersion))
      .sort((a, b) => Date.parse(String(b.updatedAt || 0)) - Date.parse(String(a.updatedAt || 0)));
  }

  backup(id: string, item: HistoryItem) {
    try {
      const now = new Date().toISOString();
      const record = { schemaVersion: 4, id: item.id, agentId: id, title: item.title,
        createdAt: item.createdAt || now, updatedAt: item.updatedAt || now, saveVersion: item.saveVersion,
        messages: agentHistorySnapshot(item.messages).messages,
        ...(item.inputDraft ? { inputDraft: item.inputDraft } : {}),
        ...(item.retryRequest ? { retryRequest: item.retryRequest } : {}) };
      item.localBackup = saveAgentConversationBackup(this.storage, id, record, {
        pendingSync: item.pendingSync, expectedVersion: item.retryRequest?.expectedVersion ?? item.saveVersion,
        mutationId: item.retryRequest?.mutationId || item.mutationId,
      });
    } catch { item.localBackup = false; }
  }

  saveInput(id: string, item: HistoryItem, value: string) {
    if (!item || item.deleted || item.deleting || this.states.get(id)?.items.get(item.id) !== item || !this.exists(id)) return false;
    if (typeof value !== "string" || value.length > 4000 || value.includes("\0")) return false;
    item.inputDraft = value;
    const state = this.state(id);
    if (value || item.messages.length || item.saveVersion) this.backup(id, item);
    else item.localBackup = deleteAgentConversationBackup(this.storage, id, item.id);
    if (value && this.current(id) === item && (state.loaded || state.selection > 0 || item.restoredInputDraft))
      saveActiveAgentConversation(this.storage, id, item.id);
    return item.localBackup;
  }

  changed(id: string, item: HistoryItem, { immediate = false } = {}) {
    if (item.deleted || item.deleting || !this.exists(id)) return;
    const state = this.state(id), now = new Date().toISOString();
    item.title = titleFor(item.messages);
    item.createdAt ||= now;
    item.updatedAt = now;
    item.sequence++;
    item.loaded = true;
    item.pendingSync = true;
    item.saved = false;
    state.items.set(item.id, item);
    saveActiveAgentConversation(this.storage, id, this.current(id).id);
    if (immediate) {
      clearTimeout(item.saveTimer ?? undefined); item.saveTimer = null;
      this.backup(id, item);
      this.onChange(id);
      if (item.conflict) return;
      return this.save(id, item);
    }
    if (item.saveTimer === null) {
      this.backup(id, item);
      this.onChange(id);
      item.saveTimer = setTimeout(() => {
        item.saveTimer = null;
        this.backup(id, item);
        this.onChange(id);
        if (item.conflict) return;
        return this.save(id, item);
      }, 1000);
    }
  }

  async save(id: string, item = this.current(id)): Promise<void> {
    if (!item.messages.length || item.deleted || item.deleting || !this.exists(id)) return;
    if (item.saving) return item.saving.promise;
    if (item.conflict) return;
    clearTimeout(item.saveTimer ?? undefined); item.saveTimer = null;
    const saving: Saving = { controller: new AbortController() };
    item.saving = saving;
    saving.promise = this.saveLoop(id, item, saving);
    return saving.promise;
  }

  async saveLoop(id: string, item: HistoryItem, saving: Saving) {
    const valid = () => this.exists(id) && this.states.get(id)?.items.get(item.id) === item
      && item.saving === saving && !item.deleted && !item.deleting;
    try {
      this.onChange(id);
      while (valid() && item.pendingSync) {
        const snapshot = agentHistorySnapshot(item.messages);
        if (new TextEncoder().encode(JSON.stringify(snapshot)).length > 8 * 1024 * 1024)
          throw new Error("这条对话超过 8 MiB，当前内容仍保留，请新建对话继续。");
        const sequence = item.sequence;
        const request = item.retryRequest || { ...snapshot, expectedVersion: item.saveVersion, mutationId: crypto.randomUUID() };
        item.retryRequest = request;
        this.backup(id, item);
        const result = await this.api.saveHistoryConversation(id, item.id, request, { signal: saving.controller.signal });
        if (!valid()) return;
        const record = result.conversation;
        if (result.deleted) { const error: FrontendError = new Error("这条对话已删除，可以把本机内容另存为新对话。"); error.reason = "conversation_deleted"; throw error; }
        if (record?.id !== item.id || record.agentId !== id || ![2, 3, 4].includes(record.schemaVersion)
          || !Number.isSafeInteger(record.saveVersion) || record.saveVersion < 1 || !Array.isArray(record.messages))
          throw new Error("对话保存尚未确认，请重试。");
        item.saveVersion = record.saveVersion;
        item.mutationId = record.mutationId;
        item.createdAt = record.createdAt;
        item.retryRequest = null;
        const matches = JSON.stringify(agentHistorySnapshot(record.messages).messages)
          === JSON.stringify(agentHistorySnapshot(item.messages).messages);
        item.pendingSync = sequence !== item.sequence || !matches;
        item.saved = !item.pendingSync;
        if (!item.pendingSync) item.updatedAt = record.updatedAt;
        item.storageError = "";
        this.backup(id, item);
        this.onChange(id);
        if (item.saveTimer !== null) break;
      }
    } catch (caught) { const error = errorInfo(caught);
      if (!valid()) return;
      item.pendingSync = true; item.saved = false;
      item.conflict = ["conversation_conflict", "conversation_deleted"].includes(error.reason!);
      item.storageError = `${error.message || "对话暂时无法保存"}。${item.localBackup ? "本机备份已保留。" : "本机备份也未成功，请复制需要保留的内容。"}`;
      this.backup(id, item);
    } finally {
      if (item.saving === saving) item.saving = null;
      if (this.exists(id) && this.states.has(id)) this.onChange(id);
    }
  }

  async load(agent: Pick<AgentRequirement, "id" | "persisted">) {
    const id = agent.id, state = this.state(id);
    if (!agent.persisted || state.loaded || state.loading) return state.loading?.promise;
    const loading: HistoryLoading = { controller: new AbortController(), selection: state.selection, active: this.current(id),
      items: new Map([...state.items].map(([cid, item]) => [cid, { item, sequence: item.sequence, saveVersion: item.saveVersion }])) };
    const unchanged = (cid: string, item: HistoryItem) => {
      const previous = loading.items.get(cid);
      return previous?.item === item && previous.sequence === item.sequence && previous.saveVersion === item.saveVersion;
    };
    state.loading = loading;
    loading.promise = (async () => {
      try {
        const result = await this.api.listConversations(id, { signal: loading.controller.signal });
        if (this.states.get(id) !== state || !this.exists(id) || loading.controller.signal.aborted) return;
        if (!Array.isArray(result.conversations)) throw new Error("历史对话列表尚未确认");
        const serverIds = new Set(result.conversations.map((record) => record.id));
        for (const [cid, item] of state.items) {
          if (!serverIds.has(cid) && unchanged(cid, item) && item.saveVersion && !item.pendingSync && !item.turn) {
            state.items.delete(cid); deleteAgentConversationBackup(this.storage, id, cid);
          }
        }
        for (const record of result.conversations) {
          if (!record || typeof record.id !== "string") throw new Error("历史对话记录格式无效");
          if (loading.items.get(record.id)?.item.deleted) continue;
          const previous = state.items.get(record.id);
          if (!previous) state.items.set(record.id, this.item(id, record));
          else if (unchanged(record.id, previous) && !previous.pendingSync && !previous.turn) {
            if (previous.saveVersion !== record.saveVersion) previous.loaded = false;
            Object.assign(previous, record);
          }
        }
        state.loaded = true; state.error = "";
        if (!state.items.has(this.current(id).id)) {
          const latest = this.records(id)[0];
          if (latest) {
            this.active.set(id, latest);
            saveActiveAgentConversation(this.storage, id, latest.id);
          } else this.blank(id);
        } else if (state.selection === loading.selection && !this.current(id).messages.length && !this.current(id).restoredInputDraft) {
          const selected = state.items.get(loadActiveAgentConversation(this.storage, id)!) || this.records(id)[0];
          if (selected) this.active.set(id, selected);
        }
        const selected = this.current(id);
        if (!selected.loaded && selected.saveVersion) await this.read(id, selected);
        if (this.states.get(id) !== state || !this.exists(id)) return;
        for (const item of state.items.values()) if (item.pendingSync && !item.conflict) void this.save(id, item);
      } catch (caught) { const error = errorInfo(caught);
        if (this.states.get(id) === state && !loading.controller.signal.aborted) state.error = `历史对话暂时无法读取：${error.message || "服务未响应"}`;
      } finally {
        if (state.loading === loading) state.loading = null;
        if (this.exists(id) && this.states.get(id) === state)
          this.onChange(id, state.selection === loading.selection && this.active.get(id) !== loading.active);
      }
    })();
    this.onChange(id);
    return loading.promise;
  }

  async read(id: string, item: HistoryItem) {
    if (item.loaded || item.pendingSync || item.loading || item.deleted) return item.loading?.promise;
    const loading: Reading = { controller: new AbortController(), sequence: item.sequence, version: item.saveVersion };
    let applied = false;
    item.loading = loading;
    loading.promise = (async () => {
      try {
        const result = await this.api.getHistoryConversation(id, item.id, { signal: loading.controller.signal });
        if (this.states.get(id)?.items.get(item.id) !== item || item.deleted || loading.controller.signal.aborted) return;
        if (item.sequence !== loading.sequence || item.saveVersion !== loading.version || item.pendingSync) return;
        if (!result.conversation || result.deleted) throw new Error("这条对话已删除，请打开其他记录。");
        const record = result.conversation;
        if (record.id !== item.id || record.agentId !== id || ![2, 3, 4].includes(record.schemaVersion)) throw new Error("对话身份尚未确认");
        Object.assign(item, record, { messages: agentHistorySnapshot(record.messages).messages, loaded: true, saved: true, storageError: "" });
        applied = true;
        this.backup(id, item);
      } catch (caught) { const error = errorInfo(caught);
        if (this.states.get(id)?.items.get(item.id) === item && !loading.controller.signal.aborted) item.storageError = error.message || "对话暂时无法读取，请重试。";
      } finally {
        if (item.loading === loading) item.loading = null;
        if (this.exists(id) && this.states.get(id)?.items.get(item.id) === item)
          this.onChange(id, applied && this.active.get(id) === item);
      }
    })();
    this.onChange(id);
    return loading.promise;
  }

  async select(id: string, cid: string) {
    const state = this.state(id), item = state.items.get(cid);
    if (!item || item.deleted || item.deleting) return;
    state.selection++;
    this.active.set(id, item);
    saveActiveAgentConversation(this.storage, id, cid);
    this.onChange(id, true);
    await this.read(id, item);
  }

  blank(id: string) {
    const state = this.state(id), item = this.item(id);
    item.loaded = true;
    state.selection++;
    state.items.set(item.id, item);
    this.active.set(id, item);
    saveActiveAgentConversation(this.storage, id, null);
    this.onChange(id, true);
    return item;
  }

  async fork(id: string, item = this.current(id)) {
    const next = this.blank(id);
    next.messages = agentHistorySnapshot(item.messages).messages;
    next.error = item.error;
    await this.changed(id, next, { immediate: true });
    this.onChange(id, true);
  }

  async remove(id: string, cid: string) {
    const state = this.state(id), item = state.items.get(cid);
    if (!item || item.deleting) return false;
    item.deleting = true;
    clearTimeout(item.saveTimer ?? undefined); item.saveTimer = null;
    item.loading?.controller.abort(); item.saving?.controller.abort();
    this.onChange(id);
    try {
      const result = await this.api.removeConversation(id, cid);
      if (this.states.get(id) !== state || !this.exists(id)) return false;
      if (result.deleted !== true || result.id !== cid) throw new Error("删除尚未确认，请重试。");
      item.deleted = true;
      state.items.delete(cid);
      const removedBackup = deleteAgentConversationBackup(this.storage, id, cid);
      if (!removedBackup) state.error = "对话已删除，本机旧备份尚未清理；服务器不会重新导入它。";
      if (this.current(id) === item) {
        const latest = this.records(id)[0];
        if (latest) await this.select(id, latest.id); else this.blank(id);
      }
      this.onChange(id, true);
      return true;
    } catch (caught) { const error = errorInfo(caught);
      item.storageError = error.message || "删除失败，请重试。";
      return false;
    } finally {
      item.deleting = false;
      if (this.exists(id) && this.states.get(id) === state) this.onChange(id);
    }
  }

  clear(id: string) {
    const state = this.states.get(id);
    state?.loading?.controller.abort();
    for (const item of state?.items.values() || []) {
      clearTimeout(item.saveTimer ?? undefined);
      item.loading?.controller.abort(); item.saving?.controller.abort();
      deleteAgentConversationBackup(this.storage, id, item.id);
    }
    saveActiveAgentConversation(this.storage, id, null);
    this.states.delete(id); this.active.delete(id);
  }

  checkpoint() {
    for (const [id, state] of this.states) for (const item of state.items.values())
      if ((item.pendingSync || item.inputDraft) && !item.deleted && !item.deleting) this.backup(id, item);
  }
}
