import { objectFields } from "../runtime/type-boundary.mjs";
import type { MaterialUpload } from "../materials/material-port.mjs";
import type { Group, GroupArtifact, GroupTask, GroupMember, GroupRecord, GroupChild, WorkRequest, MemberCard, CollaborationLimits } from "../contracts/collaboration.mjs";
import type { CollaborationOptions, MaterialTool } from "../agents/prototype-port.mjs";
import type { Progress } from "../runtime/pi-port.mjs";
import type { RawMaterial, MaterialDescriptor } from "../contracts/material.mjs";
export interface CollaborationAgents {
  ready?: Promise<unknown>;
  capabilityCards?(options?: { agentIds?: string[] }): Promise<{ agents: MemberCard[] }>;
  onLifecycle?(listener: (event: { type: string; agentId: string }) => unknown): () => void;
  activitySnapshot?(): Promise<Record<string, unknown>>;
  executeCollaboration?(options: CollaborationOptions, progress?: Progress, optionsWithSignal?: { signal?: AbortSignal | undefined }): Promise<{ turns?: number; reply?: string }>;
  attachmentRaw?(agentId: string, attachmentId: string): Promise<RawMaterial>;
  file?(agentId: string, path: string): Promise<{ content: string; truncated?: boolean }>;
}
export interface CollaborationMaterials {
  list(groupId: string): Promise<{ attachments: MaterialDescriptor[] }>;
  resolve?(groupId: string, refs?: unknown): Promise<{ id: string }[]>;
  tools?(groupId: string): MaterialTool[];
  close(): Promise<unknown>;
  upload?: MaterialStore["upload"];
  get?: MaterialStore["get"];
  raw?: MaterialStore["raw"];
  preview?: MaterialStore["preview"];
  image?: MaterialStore["image"];
}
export interface GroupWorker { controller: AbortController; taskId: string | null; promise?: Promise<void> | undefined; persistenceFailed?: boolean | undefined }
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { InputError } from "../requirements/core.mjs";
import { MaterialStore } from "../materials/material-store.mjs";
import { GroupStore, GROUP_LIMITS, TERMINAL_TASKS, id, text, conflict, fingerprint, event, message, now } from "./group-store.mjs";
import { runGroup } from "./group-runtime.mjs";
import { groupTaskAllowsNetwork } from "./group-tools.mjs";
import { publicGroupMessages } from "./group-messages.mjs";
import { groupConversationId, groupConversationTasks } from "./group-conversations.mjs";
import { groupMentionIds, validateGroupMentions } from "./group-mentions.mjs";
import { stopPublicReplyRelay } from "./group-replies.mjs";

const publicGroup = ({ creationId, creationHash, ...group }: Group) => group;
const publicArtifact = ({ content, ...artifact }: GroupArtifact) => artifact;
const system = { type: "system", id: "platform", name: "NEUMA" };
const unfinished = (task: Pick<GroupTask, "status">) => !TERMINAL_TASKS.has(task.status);
const deletedConversation = () => Object.assign(conflict("这段群对话已删除，请新建对话"), { reason: "conversation_deleted" });
const matchesParticipant = (member: GroupMember, card: MemberCard | undefined) => card?.ready && card.revision === member.revision
  && (!member.capabilityVersion || card.capabilityVersion === member.capabilityVersion);
const memberCards = (record: GroupRecord, cards: MemberCard[]): MemberCard[] => record.group.memberIds.map((memberId) => cards.find((card) => card.id === memberId)
  ?? { id: memberId, name: "已移除的 Agent", ready: false, description: "成员已不可用" });
export const isLive = (task: { status?: string | undefined }) => ["queued", "running", "negotiating", "waiting"].includes(task.status ?? "");
const rootTask = (record: GroupRecord, taskId: unknown) => {
  id(taskId, "任务");
  if (record.deletedConversations?.some((value) => value.id === taskId || value.taskIds.includes(String(taskId))))
    throw deletedConversation();
  const task = record.tasks.find((value) => value.id === taskId);
  if (!task) throw new InputError("没有找到这个群的任务");
  return task;
};

export class CollaborationService {
  agents: CollaborationAgents; store: GroupStore; limits: CollaborationLimits; materials: CollaborationMaterials;
  workers: Map<string, GroupWorker>; closed: boolean; ready: Promise<unknown>;
  unsubscribeLifecycle: (() => void) | undefined;
  constructor({ dataDir, agents, store = new GroupStore({ dataDir }), materials, limits = {} }: { dataDir: string; agents: CollaborationAgents; store?: GroupStore; materials?: CollaborationMaterials; limits?: Partial<CollaborationLimits> | undefined }) {
    this.agents = agents; this.store = store; this.limits = { ...GROUP_LIMITS, ...limits };
    this.materials = materials ?? new MaterialStore({ storage: store.storage });
    this.workers = new Map(); this.closed = false;
    this.ready = Promise.all([store.ready, agents.ready]); this.ready.catch(() => {});
    this.unsubscribeLifecycle = agents.onLifecycle?.((value) => this.invalidateAgent(value.agentId ?? objectFields(value).id, (objectFields(value).reason ?? value.type) as string));
  }
  async cards(options?: { agentIds?: string[] }): Promise<MemberCard[]> { await this.ready; return (await this.agents.capabilityCards!(options)).agents; }
  async groupMemberCards(groupId: string): Promise<MemberCard[]> {
    const record = await this.store.get(groupId), cards = await this.cards({ agentIds: record.group.memberIds });
    return memberCards(record, cards);
  }
  async validateTaskCapabilities(groupId: string, taskId: string, generation: number): Promise<MemberCard[]> {
    const snapshot = await this.store.get(groupId), task = this.guard(snapshot, taskId, null, generation);
    const cards = await this.cards({ agentIds: task.participants.map((member) => member.id) });
    if (task.participants.every((member) => matchesParticipant(member, cards.find((card) => card.id === member.id)))) return cards;
    const changed = await this.store.change(groupId, (record) => {
      const task = this.guard(record, taskId, null, generation);
      if (task.participants.every((member) => matchesParticipant(member, cards.find((card) => card.id === member.id)))) return false;
      this.interrupt(record, task, "成员能力、执行条件或定义已变化，请检查已有成果后创建新任务重新分配");
      return true;
    });
    if (changed) {
      this.abort(groupId, taskId);
      throw new InputError("成员能力、执行条件或定义已变化，请检查已有成果后重新分配");
    }
    return cards;
  }
  async members(memberIds: unknown): Promise<string[]> {
    if (!Array.isArray(memberIds) || !memberIds.length || memberIds.length > 64 || new Set(memberIds).size !== memberIds.length) throw new InputError("请选择 1～64 个不同的群成员");
    const cards = await this.cards();
    for (const memberId of memberIds) if (!cards.some((card) => card.id === id(memberId, "成员"))) throw new InputError("群成员不存在，请刷新成员列表");
    return memberIds.map((value) => id(value, "成员"));
  }
  async listGroups() { await this.ready; return { groups: (await this.store.list()).map(publicGroup) }; }
  async getGroup(groupId: string) {
    const record = await this.store.get(groupId), cards = await this.cards({ agentIds: record.group.memberIds });
    const members = memberCards(record, cards);
    return { group: publicGroup(record.group), members, tasks: record.tasks, messages: publicGroupMessages(record),
      materials: (await this.materials.list(groupId)).attachments.filter((value) => record.group.materialIds.includes(value.id)), artifacts: record.artifacts.map(publicArtifact), lastSequence: record.group.lastSequence };
  }
  async createGroup(input: Record<string, unknown> = {}) {
    if (this.closed) throw new InputError("协作服务正在关闭");
    const group = await this.store.create({ name: text(input.name, "群名称", 120), purpose: text(input.purpose, "群用途", 2000, true),
      memberIds: await this.members(input.memberIds), mutationId: id(input.mutationId, "操作") });
    return this.getGroup(group.id);
  }
  async removeConversation(groupId: string, conversationId: string, input: Record<string, unknown> = {}) {
    id(conversationId, "群对话");
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new InputError("群对话删除请求无效");
    const mutationId = id(input.mutationId, "删除请求"), hash = fingerprint({ action: "removeConversation", conversationId });
    return this.store.change(groupId, (record) => {
      const prior = this.replay(record, mutationId, hash); if (prior) return prior;
      if (this.closed) throw new InputError("协作服务正在关闭");
      const tasks = record.tasks.filter((task) => groupConversationId(task) === conversationId);
      if (tasks.some(unfinished)) throw conflict("这段群对话仍在进行或等待补充，请停止后再删除");
      const result = { removed: true, conversationId };
      if (tasks.length) {
        const taskIds = new Set<string | null | undefined>(tasks.map((task) => task.id));
        record.tasks = record.tasks.filter((task) => !taskIds.has(task.id));
        record.messages = record.messages.filter((value) => !taskIds.has(value.taskId));
        record.events = record.events.filter((value) => !taskIds.has(value.taskId));
        if (taskIds.has(record.group.activeTaskId)) record.group.activeTaskId = null;
        record.deletedConversations ??= [];
        record.deletedConversations.push({ id: conversationId, taskIds: [...taskIds] as string[], deletedAt: now() });
        event(record, "conversation-removed", { conversationId });
      }
      record.mutations.push({ id: mutationId, hash, result });
      return result;
    });
  }
  async updateGroup(groupId: string, input: Record<string, unknown> = {}) {
    const archived = input.archived;
    const memberIds = input.memberIds === undefined ? undefined : await this.members(input.memberIds);
    const mutationId = id(input.mutationId, "操作"), hash = fingerprint(input);
    if (!Number.isSafeInteger(input.expectedVersion)) throw new InputError("群修改需要读取版本");
    if (archived !== undefined && typeof archived !== "boolean") throw new InputError("归档状态无效");
    const interrupted: string[] = [];
    await this.store.change(groupId, (record) => {
      if (this.replay(record, mutationId, hash)) return;
      if (record.group.version !== input.expectedVersion) throw conflict("群已被修改，请刷新后再保存");
      if (input.name !== undefined) record.group.name = text(input.name, "群名称", 120);
      if (input.purpose !== undefined) record.group.purpose = text(input.purpose, "群用途", 2000, true);
      const removed = record.group.memberIds.filter((value) => memberIds && !memberIds.includes(value));
      if (memberIds) record.group.memberIds = memberIds;
      if (archived !== undefined) record.group.archived = archived;
      for (const task of record.tasks.filter(unfinished)) if (record.group.archived || removed.some((value) => task.participants.some((member) => member.id === value))) {
        this.interrupt(record, task, record.group.archived ? "群已归档" : "群成员已变更，请检查成果后重新分配"); interrupted.push(task.id);
      }
      record.group.version++; event(record, "group", { version: record.group.version });
      record.mutations.push({ id: mutationId, hash, result: { groupId } });
    });
    for (const taskId of interrupted) this.abort(groupId, taskId);
    return this.getGroup(groupId);
  }
  replay(record: GroupRecord, mutationId: string, hash: string) {
    const prior = record.mutations.find((value) => value.id === mutationId);
    if (!prior) return null;
    if (prior.hash !== hash) throw conflict("同一操作标识不能用于不同内容");
    return prior.result;
  }
  queue(task: GroupTask, agentId: string, { childId = null, kind = "work", messageId = null }: { childId?: string | null | undefined; kind?: string; messageId?: string | null | undefined } = {}) {
    if (task.jobs.some((job) => ["queued", "running"].includes(job.status) && job.agentId === agentId && job.childId === childId && job.kind === kind && job.messageId === messageId)) return;
    task.jobs.push({ id: randomUUID(), agentId, childId, kind, messageId, status: "queued", createdAt: now() });
  }
  makeChild(task: GroupTask, { title, description = title, assigneeId = null, required = true, dependsOn = [], capabilityId, capabilityVersion, inputs, expectedOutput, acceptance }: WorkRequest & { title: unknown; description?: unknown; assigneeId?: string | null; required?: boolean; dependsOn?: string[] }): GroupChild {
    const child: GroupChild = { id: randomUUID(), title: text(title, "子任务", 500), description: text(description, "子任务说明", 4000), assigneeId,
      required, dependsOn, pendingQuestions: [], status: "queued", result: "", artifactIds: [], createdAt: now(), updatedAt: now(),
      ...(capabilityId ? { capabilityId, capabilityVersion } : {}),
      ...(inputs !== undefined ? { inputs } : {}), ...(expectedOutput !== undefined ? { expectedOutput } : {}), ...(acceptance !== undefined ? { acceptance } : {}) };
    task.children.push(child); return child;
  }
  async postMessage(groupId: string, input: Record<string, unknown> = {}, { source = "user", taskAllowNetwork }: { source?: string; taskAllowNetwork?: boolean | undefined } = {}) {
    if (this.closed) throw new InputError("协作服务正在关闭");
    if (!["user", "main"].includes(source)) throw new InputError("群任务只能由用户或群外主 Agent 发起及补充");
    if (taskAllowNetwork !== undefined && (source !== "main" || typeof taskAllowNetwork !== "boolean")) throw new InputError("可信任务联网策略仅由群外主 Agent 转交，并须为布尔值");
    const content = text(input.content, "消息"), mutationId = id(input.mutationId, "操作"), hash = taskAllowNetwork === undefined
      ? fingerprint({ ...input, source }) : `policy-v1:${fingerprint({ input, source, taskAllowNetwork })}`;
    const cards = await this.cards();
    const attachments = await this.materials.resolve!(groupId, input.attachmentIds ?? []);
    const restrictedTaskIds: string[] = [];
    const result = await this.store.change(groupId, (record) => {
      if (input.taskId && record.deletedConversations?.some((value) => value.id === input.taskId || value.taskIds.includes(String(input.taskId))))
        throw deletedConversation();
      const replay = this.replay(record, mutationId, hash);
      if (replay) return { message: record.messages.find((value) => value.id === replay.messageId), task: rootTask(record, replay.taskId) };
      if (this.closed) throw new InputError("协作服务正在关闭");
      if (record.group.archived) throw new InputError("群已归档，请先恢复群");
      if (attachments.some((value) => !record.group.materialIds.includes(value.id))) throw new InputError("只能引用明确分享给本群的材料");
      if (input.recipientId && !record.group.memberIds.includes(id(input.recipientId, "接收成员"))) throw new InputError("只能点名当前群成员");
      const recipientId = input.recipientId ? id(input.recipientId, "接收成员") : null;
      const members = memberCards(record, cards);
      const mentions = validateGroupMentions(content, input.mentions, members);
      const mentionIds = [...new Set([...mentions.map((mention) => mention.memberId), ...groupMentionIds(content, members)])];
      const requestedRecipientIds = [...new Set([...(recipientId ? [recipientId] : []), ...mentionIds])];
      if (requestedRecipientIds.some((memberId) => !cards.some((card) => card.id === memberId && card.ready))) throw new InputError("被点名成员尚未就绪");
      let task: GroupTask | undefined, previous: GroupTask | undefined;
      if (input.taskId && !input.newTask) {
        const selected = rootTask(record, input.taskId);
        previous = groupConversationTasks(record, selected, { throughCurrent: false }).at(-1)!;
        if (!TERMINAL_TASKS.has(previous.status) && previous.participants.some((member) => !matchesParticipant(member, cards.find((card) => card.id === member.id)))) {
          this.interrupt(record, previous, "成员能力、执行条件或定义已变化，请检查已有成果后创建新任务重新分配");
          restrictedTaskIds.push(previous.id);
          return { errorMessage: "成员能力、执行条件或定义已变化，请创建新任务重新分配" };
        }
        const responding = previous.phase === "responding";
        const pausedBusiness = responding && previous.ownerId && isLive({ status: previous.replyRelay?.completion?.status });
        if (responding && stopPublicReplyRelay(record, previous)) {
          restrictedTaskIds.push(previous.id);
          if (pausedBusiness) {
            if (previous.jobs.some((job) => job.status === "running")) this.interrupt(record, previous, "新消息已收到，旧轮正在执行的工作已停止，已有成果保留；我们会按新消息继续。", "interrupted");
            else previous.status = "queued";
          }
        }
        const resumeBusiness = pausedBusiness && previous.status === "queued";
        const delivering = responding && !resumeBusiness || previous.jobs.some((job) => job.kind === "integration" && job.status === "running");
        const tighteningNetwork = groupTaskAllowsNetwork(record, previous) && (taskAllowNetwork === false || !groupTaskAllowsNetwork({ ...record,
          messages: [...record.messages, { taskId: previous.id, sender: { type: source }, content }] }, previous));
        if ((!responding || resumeBusiness) && !TERMINAL_TASKS.has(previous.status) && (!delivering || tighteningNetwork) && (previous.ownerId || previous.status === "needs_input")) task = previous;
      }
      const continuing = Boolean(task);
      if (!task) {
        const timestamp = now();
        const taskId = randomUUID(), inheritedMaterialIds = (previous?.attachmentIds ?? []).filter((value) => record.group.materialIds.includes(value));
        const networkPolicy = previous && !groupTaskAllowsNetwork(record, previous) ? false : taskAllowNetwork;
        task = { id: taskId, conversationId: previous ? groupConversationId(previous) : taskId, groupId, goal: content, status: "queued", phase: "negotiation", ownerId: null,
          participants: cards.filter((card) => record.group.memberIds.includes(card.id) && card.ready).map((card) => ({ id: card.id, revision: card.revision!, name: card.name,
            ...(card.capabilityVersion ? { capabilityVersion: card.capabilityVersion } : {}) })),
          requestedRecipientId: recipientId, ...(requestedRecipientIds.length ? { requestedRecipientIds } : {}),
          attachmentIds: [...new Set([...inheritedMaterialIds, ...attachments.map((value) => value.id)])],
          children: [], jobs: [], intents: [], requests: [], negotiationRound: 0, turnsUsed: 0, generation: 1,
          result: "", reason: "", createdAt: timestamp, updatedAt: timestamp, ...(networkPolicy !== undefined ? { taskAllowNetwork: networkPolicy } : {}) };
        record.tasks.push(task); event(record, "task", { taskId: task.id, status: task.status });
      }
      const previouslyAllowedNetwork = continuing && (isLive(task) || task.ownerId) && groupTaskAllowsNetwork(record, task);
      const posted = message(record, { type: source === "main" ? "main" : "user", id: source === "main" ? "main" : "user", name: source === "main" ? "主 Agent 转交" : "你" }, content,
        { taskId: task.id, recipientId: recipientId });
      if (mentionIds.length) posted.mentionIds = mentionIds;
      if (mentions.length) posted.mentions = mentions;
      if (continuing) {
        if (taskAllowNetwork !== undefined) task.taskAllowNetwork = task.taskAllowNetwork !== false && taskAllowNetwork;
        task.attachmentIds = [...new Set([...task.attachmentIds!, ...attachments.map((value) => value.id)])];
        if (previouslyAllowedNetwork && !groupTaskAllowsNetwork(record, task)) {
          this.interrupt(record, task, "联网限制已更新，旧任务已停止，已有成果和新消息已保留；请创建新任务按最新限制继续");
          restrictedTaskIds.push(task.id);
        } else if (task.phase === "conversation") {
          task.ownerId = null; task.negotiationRound = 0; task.intents = []; task.status = "queued"; task.reason = "";
          task.requestedRecipientId = recipientId; task.requestedRecipientIds = requestedRecipientIds;
          delete task.replyAudience; delete task.replyRouting;
        } else if (task.status === "needs_input" && !task.ownerId) {
          if (requestedRecipientIds.some((memberId) => !task.participants.some((value) => value.id === memberId))) throw new InputError("点名成员尚未就绪，请创建新任务");
          task.requestedRecipientId = recipientId; task.negotiationRound = 0; task.intents = []; task.status = "queued"; task.reason = "";
          task.requestedRecipientIds = requestedRecipientIds; delete task.replyAudience; delete task.replyRouting;
        } else {
          const recipients = requestedRecipientIds.length ? requestedRecipientIds : [task.ownerId].filter((value): value is string => typeof value === "string");
          if (recipients.some((memberId) => !task.participants.some((value) => value.id === memberId))) throw new InputError("点名成员尚未就绪，请创建新任务");
          if (["needs_input", "waiting"].includes(task.status)) task.continuationState ??= { status: task.status, phase: task.phase, reason: task.reason };
          for (const recipient of recipients) this.queue(task, recipient, { kind: "update", messageId: posted.id });
          if (["needs_input", "waiting"].includes(task.status)) { task.status = "queued"; task.reason = ""; }
        }
      }
      if (previous && !continuing && !groupTaskAllowsNetwork(record, task)) {
        const restricted = groupConversationTasks(record, task).filter((value) => value.id !== task.id && isLive(value) && groupTaskAllowsNetwork(record, value));
        for (const earlier of restricted) {
          earlier.taskAllowNetwork = false;
          this.interrupt(record, earlier, "联网限制已更新，旧任务已停止，已有成果保留；我们会按最新限制继续这段对话");
          restrictedTaskIds.push(earlier.id);
        }
      }
      record.mutations.push({ id: mutationId, hash, result: { messageId: posted.id, taskId: task.id } });
      return { message: posted, task };
    });
    for (const taskId of restrictedTaskIds) this.abort(groupId, taskId);
    if (result.errorMessage) throw new InputError(result.errorMessage);
    this.start(groupId); return result;
  }
  async events(groupId: string, after = 0) {
    if (!Number.isSafeInteger(after) || after < 0) throw new InputError("消息续读位置无效");
    const record = await this.store.get(groupId);
    if (after > record.group.lastSequence) throw new InputError("消息续读位置超过当前记录");
    const events = record.events.filter((value) => value.seq > after).slice(0, 500);
    return { events, lastSequence: events.at(-1)?.seq ?? after, latestSequence: record.group.lastSequence };
  }
  guard(record: GroupRecord, taskId: string, agentId: string | null, generation: number): GroupTask {
    const task = rootTask(record, taskId);
    if (this.closed || record.group.archived || !isLive(task) || task.generation !== generation) throw new InputError("本轮协作已停止");
    if (agentId && (!record.group.memberIds.includes(agentId) || !task.participants.some((value) => value.id === agentId))) throw new InputError("成员不属于本轮协作");
    return task;
  }
  interrupt(record: GroupRecord, task: GroupTask, reason: string, status = "interrupted") {
    task.status = status; task.reason = reason; task.generation++; task.updatedAt = now();
    for (const job of task.jobs) if (["queued", "running"].includes(job.status)) job.status = status;
    if (task.replyRelay?.status === "running") {
      task.replyRelay.status = status;
      for (const request of task.replyRelay.requests) if (["queued", "running"].includes(request.status)) {
        request.status = status;
        const source = record.messages.find((value) => value.id === request.sourceMessageId);
        if (source) source.replyRequestStatus = status;
      }
    }
    for (const child of task.children) if (["queued", "running", "waiting"].includes(child.status)) child.status = status;
    if (record.group.activeTaskId === task.id) record.group.activeTaskId = null;
    event(record, "task", { taskId: task.id, status }); message(record, system, reason, { taskId: task.id, visibility: "public", kind: "status" });
  }
  abort(groupId: string, taskId: string) { const worker = this.workers.get(groupId); if (worker?.taskId === taskId) worker.controller.abort(); }
  async cancelTask(groupId: string, taskId: string) {
    const result = await this.store.change(groupId, (record) => {
      const task = rootTask(record, taskId); if (unfinished(task)) this.interrupt(record, task, "你已停止这项任务，已产生的成果保留", "cancelled"); return { task };
    });
    this.abort(groupId, taskId); return result;
  }
  async invalidateAgent(agentId: string, reason = "成员状态变化") {
    if (!agentId) return;
    for (const group of await this.store.list()) {
      const affected = await this.store.change(group.id, (record) => {
        const tasks = record.tasks.filter((task) => unfinished(task) && task.participants.some((value) => value.id === agentId));
        for (const task of tasks) this.interrupt(record, task, `成员已变更（${reason}），请检查已有成果后重新分配`);
        return tasks.map((task) => task.id);
      });
      for (const taskId of affected) this.abort(group.id, taskId);
    }
  }
  start(groupId: string) {
    if (this.closed || this.workers.has(groupId)) return;
    const worker: GroupWorker = { controller: new AbortController(), taskId: null };
    this.workers.set(groupId, worker);
    worker.promise = Promise.resolve().then(() => runGroup(this, groupId, worker)).catch(async () => {
      if (worker.controller.signal.aborted) return;
      worker.persistenceFailed = true;
      await this.store.change(groupId, (record) => {
        const task = record.tasks.find((value) => value.id === worker.taskId);
        if (task && isLive(task)) this.interrupt(record, task, "协作未能继续，已有结果已保留，请检查后重试", "failed");
      });
    }).finally(async () => {
      if (this.workers.get(groupId) === worker) this.workers.delete(groupId);
      if (!this.closed && !worker.persistenceFailed && (await this.store.get(groupId)).tasks.some((task) => task.status === "queued")) this.start(groupId);
    });
    worker.promise.catch(() => {});
  }
  async idle(groupId: string) { for (;;) { const worker = this.workers.get(groupId); if (!worker) return; await worker.promise; } }
  async uploadMaterial(groupId: string, options: Parameters<MaterialStore["upload"]>[1]) {
    const record = await this.store.get(groupId); if (record.group.archived) throw new InputError("群已归档");
    const result = await this.materials.upload!(groupId, options);
    try {
      await this.store.change(groupId, (next) => {
        if (next.group.archived || this.closed) throw new InputError("群已停止接收材料");
        next.group.materialIds.push(result.attachment.id); event(next, "material", { materialId: result.attachment.id });
      });
    } catch (error) { await this.discardMaterial(groupId, result.attachment.id); throw error; }
    return result;
  }
  async discardMaterial(groupId: string, materialId: string) {
    await Promise.allSettled([this.store.storage.removeDirectory(groupId, `attachments/${materialId}`), this.store.storage.removeDirectory(groupId, `workspace/inputs/${materialId}`)]);
  }
  async requireMaterial(groupId: string, materialId: string) {
    const record = await this.store.get(groupId);
    if (!record.group.materialIds.includes(materialId)) throw new InputError("材料未分享给本群");
    return this.materials.get!(groupId, materialId);
  }
  async sharedMaterials(groupId: string) {
    const record = await this.store.get(groupId);
    return { attachments: (await this.materials.list(groupId)).attachments.filter((value) => record.group.materialIds.includes(value.id)) };
  }
  async importMaterial(groupId: string, { name, mimeType, source, mutationId }: MaterialUpload & { mutationId: string }, { signal }: { signal?: AbortSignal | undefined } = {}) {
    id(mutationId, "操作"); const hash = fingerprint({ name, mimeType }); let uploaded: string | undefined;
    try {
      return await this.store.change(groupId, async (record) => {
        const prior = this.replay(record, mutationId, hash); if (prior) return prior;
        if (record.group.archived || this.closed) throw new InputError("群已停止接收材料");
        const result = await this.materials.upload!(groupId, { name, mimeType, source, signal }); uploaded = result.attachment.id;
        record.group.materialIds.push(uploaded!); event(record, "material", { materialId: uploaded });
        record.mutations.push({ id: mutationId, hash, result }); return result;
      });
    } catch (error) { if (uploaded) await this.discardMaterial(groupId, uploaded); throw error; }
  }
  async share(groupId: string, input: Record<string, unknown>, { signal }: { signal?: AbortSignal | undefined } = {}) {
    const mutationId = id(input.mutationId, "操作"), hash = fingerprint(input);
    let uploaded: string | undefined;
    try { return await this.store.change(groupId, async (record) => {
      const prior = this.replay(record, mutationId, hash); if (prior) return prior;
      if (record.group.archived) throw new InputError("群已归档");
      const sourceAgentId = id(input.agentId, "Agent"); let result;
      if (input.attachmentId && !input.path) {
        const raw = await this.agents.attachmentRaw!(sourceAgentId, input.attachmentId as string);
        const handle = await open(raw.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.nlink !== 1 || info.size !== raw.size) throw new InputError("原始材料已改变");
          result = await this.materials.upload!(groupId, { name: raw.name, mimeType: raw.mimeType, source: handle.createReadStream({ autoClose: false }), signal });
          uploaded = result.attachment.id;
        } finally { await handle.close(); }
        record.group.materialIds.push(result.attachment.id); event(record, "material", { materialId: result.attachment.id });
      } else if (input.path && !input.attachmentId) {
        const file = await this.agents.file!(sourceAgentId, text(input.path, "文件", 1000));
        if (file.truncated) throw new InputError("文件超过可分享的文本大小，请作为材料上传");
        const artifact = this.addArtifact(record, id(input.agentId, "Agent"), null, text(input.path, "文件", 1000), file.content);
        result = { artifact: publicArtifact(artifact) };
      } else throw new InputError("请选择一份材料或一个产物");
      record.mutations.push({ id: mutationId, hash, result }); return result;
    }); } catch (error) { if (uploaded) await this.discardMaterial(groupId, uploaded); throw error; }
  }
  addArtifact(record: GroupRecord, agentId: string, taskId: string | null, path: string, content: string) {
    const hash = fingerprint(content);
    const prior = record.artifacts.find((value) => value.agentId === agentId && value.taskId === taskId && value.path === path && value.hash === hash);
    if (prior) return prior;
    const artifact = { id: randomUUID(), name: path.split("/").at(-1), path, agentId, taskId, content, hash, size: Buffer.byteLength(content), createdAt: now() };
    record.artifacts.push(artifact); event(record, "artifact", { artifactId: artifact.id, taskId, agentId }); return artifact;
  }
  async publishArtifact(groupId: string, taskId: string, agentId: string, generation: number, path: unknown) {
    const relativePath = text(path, "产物路径", 1000);
    const forbidden = /^(?:\..*|node_modules|venv|__pycache__|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*(?:secret|credential|token|password|api[_-]?key|access[_-]?key|private[_-]?key).*|.*\.(?:pem|key|p12|pfx))$/i;
    if (relativePath.startsWith("/") || relativePath.includes("\\") || relativePath.split("/").some((part) => !part || forbidden.test(part))) throw new InputError("请使用本次群任务目录内的相对产物路径，不能访问隐藏文件或凭据");
    const file = await this.agents.file!(agentId, `group-tasks/${id(groupId)}/${id(taskId)}/${id(agentId)}/${relativePath}`);
    if (file.truncated) throw new InputError("产物过大，请拆分文件后分享");
    return this.store.change(groupId, (record) => {
      this.guard(record, taskId, agentId, generation);
      return publicArtifact(this.addArtifact(record, agentId, taskId, relativePath, file.content));
    });
  }
  async artifact(groupId: string, artifactId: string) {
    const record = await this.store.get(groupId), artifact = record.artifacts.find((value) => value.id === id(artifactId, "产物"));
    if (!artifact) throw new InputError("没有找到本群分享的产物");
    return { artifact: publicArtifact(artifact), content: artifact.content };
  }
  async activity() {
    const groups = (await this.listGroups()).groups, tasks = [];
    for (const group of groups) {
      const record = await this.store.get(group.id);
      tasks.push(...record.tasks.map((task) => ({ id: task.id, groupId: group.id, groupName: group.name, goal: task.goal, status: task.status,
        phase: task.phase, ownerId: task.ownerId, reason: task.reason, result: task.result.slice(0, 1200), requests: task.requests,
        updatedAt: task.updatedAt, children: task.children.map(({ id, title, assigneeId, status }) => ({ id, title, assigneeId, status })) })));
    }
    return { agents: await this.cards(), groups, tasks, ...(await this.agents.activitySnapshot!()) };
  }
  async close({ permanent = true } = {}) {
    this.closed = true;
    for (const [groupId, worker] of this.workers) {
      await this.store.change(groupId, (record) => {
        for (const task of record.tasks.filter(isLive)) this.interrupt(record, task, "协作服务已停止，已有成果保留");
      }); worker.controller.abort();
    }
    await Promise.allSettled([...this.workers.values()].map((value) => value.promise));
    await this.materials.close(); await this.store.close();
    if (permanent) this.unsubscribeLifecycle?.(); else this.closed = false;
  }
}
