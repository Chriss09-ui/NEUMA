import { randomUUID } from "node:crypto";
import { InputError } from "../requirements/core.mjs";
import { event, message, now, fingerprint } from "./group-store.mjs";
import { GROUP_SYSTEM, intentTool, replyTool, groupTools, memberCapabilityTool, groupTaskAllowsNetwork, groupTurnMessages } from "./group-tools.mjs";
import { createContextReadTool } from "../development/development-context.mjs";
import { groupConversationId, groupConversationMessages } from "./group-conversations.mjs";
import { publicGroupMessages } from "./group-messages.mjs";
import { GROUP_ROUTING_SYSTEM, routingTool, routedMemberIds } from "./group-routing.mjs";
import { PUBLIC_REPLY_SYSTEM, validateReplyRequest, schedulePublicReply, finishPublicReplyRelay } from "./group-replies.mjs";

const system = { type: "system", id: "platform", name: "NEUMA" };
const live = (task) => ["queued", "running", "negotiating", "waiting"].includes(task.status);
const hasWork = (task) => task.jobs.some((job) => ["queued", "running"].includes(job.status));
const readyDependencies = (task, child) => !child.pendingQuestions.length && child.dependsOn.every((ref) => task.children.find((value) => value.id === ref)?.status === "completed");
const actor = (member) => ({ type: "agent", id: member.id, name: member.name });
const requestedRecipients = (task) => task.requestedRecipientIds?.length ? task.requestedRecipientIds : task.requestedRecipientId ? [task.requestedRecipientId] : [];
const excerpt = (value, length) => typeof value === "string" && value.length > length ? value.slice(0, length) + "…[已截断]" : value;
const contextTool = (payload) => ({ ...createContextReadTool(() => payload), name: "read_group_turn_context", label: "分页读取本轮完整协作资料",
  description: "按 contextSections 的 section 分页读取本轮完整字段，不访问其他群、文件或原型属性。" });
const openIntegratorQuestions = (task) => (task.questions ?? []).some((question) => question.askerId === task.ownerId
  && !question.childId && !question.parentQuestionId && question.status !== "answered");

function boundedContext(payload, maxChars = 14_000) {
  if (JSON.stringify(payload).length <= maxChars) return payload;
  const contextSections = Object.keys(payload).map((section) => ({ section, totalChars: JSON.stringify(payload[section])?.length ?? 0 }));
  const base = { contextTruncated: true, contextSections,
    contextNotice: "这里只提供不完整摘要。成员索引始终保留全员完整 ID 和就绪状态，名称可能带截断标记，并省略职责、输入输出、能力和边界；选择协助对象前调用 read_group_member_capabilities 完整读卡以恢复名称和边界。子任务交接若有截断，须调用 read_group_turn_context(section:'child') 读取完整输入、输出和完成条件。其余完整目标、问题、成员、分工或消息按 section 分页读取；摘要不能代替完整输入。" };
  for (const length of [1200, 600, 300, 120, 40, 0]) {
    const result = { ...base, kind: payload.kind, conversationId: payload.conversationId, memberId: payload.memberId, integratorId: payload.integratorId, workDirectory: payload.workDirectory, selectedMaterialIds: payload.selectedMaterialIds,
      requestedRecipientIds: payload.requestedRecipientIds,
      replyRouting: payload.replyRouting,
      replyRequest: payload.replyRequest,
      goal: excerpt(payload.goal, length * 2), instruction: payload.instruction,
      child: payload.child ? { id: payload.child.id, title: excerpt(payload.child.title, length), description: excerpt(payload.child.description, length),
        status: payload.child.status, assigneeId: payload.child.assigneeId, dependsOn: payload.child.dependsOn, pendingQuestions: payload.child.pendingQuestions,
        capabilityId: payload.child.capabilityId, capabilityVersion: payload.child.capabilityVersion, inputs: excerpt(payload.child.inputs, length),
        expectedOutput: excerpt(payload.child.expectedOutput, length), acceptance: excerpt(payload.child.acceptance, length) } : null,
      members: (payload.members ?? []).map(({ id, name, ready }) => ({ id, name: length < 120 ? excerpt(name, length) : name, ready })),
      tasks: (payload.tasks ?? []).slice(-15).map(({ id, title, assigneeId, status }) => ({ id, title: excerpt(title, length), assigneeId, status })),
      previousIntents: (payload.previousIntents ?? []).slice(-15).map(({ agentId, participate, integratorId, contribution, interaction, replyStatus, replyAudience }) => ({ agentId, participate, integratorId, contribution: excerpt(contribution, length), interaction, replyStatus, replyAudience })),
      recentMessages: (payload.recentMessages ?? []).slice(-6).map(({ id, sender, content, taskId, recipientId, mentionIds, replyAudience }) => ({ id, sender, content: excerpt(content, length), taskId, recipientId, mentionIds, replyAudience })),
      triggeringMessage: payload.triggeringMessage ? { ...payload.triggeringMessage, content: excerpt(payload.triggeringMessage.content, length * 2) } : null,
      sharedMaterials: (payload.sharedMaterials ?? []).slice(0, 10).map(({ id, name, kind, status, selectedForTask }) => ({ id, name, kind, status, selectedForTask })),
    };
    if (JSON.stringify(result).length <= maxChars) return result;
  }
  throw new InputError("本轮协作资料过多，无法保留安全索引，请减少成员或拆分任务");
}

function selectIntegrator(intents) {
  const participants = intents.filter((value) => value.participate), willing = participants.filter((value) => value.willingToIntegrate);
  if (!participants.length || !willing.length) return null;
  const votes = new Set(participants.map((value) => value.integratorId).filter(Boolean));
  if (votes.size === 1 && willing.some((value) => value.agentId === [...votes][0])) return [...votes][0];
  if (willing.length === 1 && (!votes.size || [...votes].every((value) => value === willing[0].agentId))) return willing[0].agentId;
  return null;
}

function publishConversationIntent(record, task, intent, sourceMessageId, limits) {
  const member = task.participants.find((value) => value.id === intent.agentId);
  const posted = record.messages.find((value) => value.id === intent.replyMessageId) ?? message(record, actor(member), intent.reply,
    { taskId: task.id, replyTo: sourceMessageId, ...(intent.replyRecipientId ? { recipientId: intent.replyRecipientId } : {}),
      visibility: "public", kind: intent.replyStatus === "needs_input" ? "clarification" : "reply" });
  intent.replyMessageId = posted.id;
  schedulePublicReply(record, task, posted, intent.replyRequest, limits);
}

async function validateMembers(service, task) {
  const cards = await service.validateTaskCapabilities(task.groupId, task.id, task.generation);
  return cards.filter((card) => task.participants.some((member) => member.id === card.id));
}

async function routeReply(service, groupId, taskId, generation, signal, messageId = null) {
  const record = await service.store.get(groupId), task = service.guard(record, taskId, null, generation);
  const source = messageId ? record.messages.find((value) => value.id === messageId && value.taskId === taskId)
    : record.messages.findLast((value) => value.taskId === taskId && ["user", "main"].includes(value.sender?.type));
  if (!source) throw new InputError("没有找到本轮群消息");
  const previous = messageId ? source.replyRouting : task.replyRouting;
  if (previous?.sourceMessageId === source.id && previous.generation === generation) return previous;
  const requested = messageId ? [...new Set([source.recipientId, ...(source.mentionIds ?? [])].filter(Boolean))] : requestedRecipients(task);
  let route = requested.length ? { mode: "named", memberIds: requested } : null;
  const history = groupConversationMessages(record, task, publicGroupMessages(record)).filter((value) => !messageId || value.seq <= source.seq);
  if (!route) {
    const member = task.participants[0];
    const payload = { goal: task.goal, conversationId: groupConversationId(task), triggeringMessage: source, recentMessages: history,
      members: (await service.groupMemberCards(groupId)).map(({ id, name, ready }) => ({ id, name, ready })),
      instruction: "只确定这条消息希望谁亲自回复；default/all/others/named/clarify。all 不能手写子集，不能把借用模型的成员排除。不要生成成员答复。" };
    await service.agents.executeCollaboration({ agentId: member.id, revision: member.revision, capabilityVersion: member.capabilityVersion,
      role: "routing", taskAllowNetwork: false, sessionId: randomUUID(), allowBusinessTools: false, maxTurns: 3,
      scope: { groupId, taskId }, systemContext: GROUP_ROUTING_SYSTEM, message: JSON.stringify(boundedContext(payload)),
      customTools: [routingTool((value) => { route = value; }), contextTool(payload)] }, () => {}, { signal });
    if (!route) throw new InputError("暂时未能确定回复对象，请明确点名后重试");
  }
  const memberIds = routedMemberIds(route, task.participants, history, source.id);
  const decision = { ...route, memberIds, sourceMessageId: source.id, generation };
  if (route.mode === "others" && !memberIds.length) { decision.mode = "clarify"; decision.question = "大家刚才都已回复。你希望哪位再说说？"; }
  await validateMembers(service, task); signal.throwIfAborted();
  await service.store.change(groupId, (record) => {
    const current = service.guard(record, taskId, null, generation);
    const latest = messageId ? record.messages.find((value) => value.id === messageId)
      : record.messages.findLast((value) => value.taskId === taskId && ["user", "main"].includes(value.sender?.type));
    if (latest?.id !== source.id) throw new InputError("群消息已更新，请重新确定回复对象");
    if (messageId) latest.replyRouting = decision;
    else current.replyRouting = decision;
    if (decision.mode === "clarify") {
      if (!messageId) { current.phase = "conversation"; current.status = "needs_input"; current.reason = decision.question; current.updatedAt = now(); }
      message(record, system, decision.question, { taskId, replyTo: source.id, visibility: "public", kind: "clarification" });
      event(record, "task", { taskId, status: current.status });
    }
  });
  return decision;
}

function restoreConversationUpdate(task) {
  if (task.continuationState && !hasWork(task)) {
    Object.assign(task.phase === "responding" && task.replyRelay?.status === "running" ? task.replyRelay.completion : task, task.continuationState);
    delete task.continuationState;
  }
}

async function prepareUserUpdate(service, groupId, taskId, generation, job, signal) {
  let routing;
  try { routing = await routeReply(service, groupId, taskId, generation, signal, job.messageId); }
  catch (error) {
    signal.throwIfAborted();
    const task = service.guard(await service.store.get(groupId), taskId, null, generation); await validateMembers(service, task);
    await service.store.change(groupId, (record) => {
      const current = service.guard(record, taskId, null, generation);
      for (const update of current.jobs) if (update.kind === "update" && update.messageId === job.messageId && update.status === "queued") update.status = "failed";
      message(record, system, "这条消息暂时未能确定回复成员，请明确点名后重试。已有工作和结果保留。", { taskId, replyTo: job.messageId, visibility: "public", kind: "status", status: "failed" });
      restoreConversationUpdate(current);
    });
    return;
  }
  await service.store.change(groupId, (record) => {
    signal.throwIfAborted(); const task = service.guard(record, taskId, null, generation);
    const pending = task.jobs.filter((value) => value.kind === "update" && value.messageId === job.messageId && value.status === "queued");
    const targets = routing.mode === "default" ? pending.map((value) => value.agentId) : routing.memberIds;
    for (const update of pending) {
      if (routing.mode === "clarify" || !targets.includes(update.agentId)) update.status = "completed";
      else update.routeResolved = true;
    }
    if (routing.mode !== "clarify") for (const target of targets) {
      service.queue(task, target, { kind: "update", messageId: job.messageId });
      const update = task.jobs.find((value) => value.kind === "update" && value.messageId === job.messageId && value.agentId === target && value.status === "queued");
      if (update) update.routeResolved = true;
    }
    restoreConversationUpdate(task);
  });
}

async function negotiate(service, groupId, taskId, worker) {
  let record = await service.store.get(groupId), task = record.tasks.find((value) => value.id === taskId);
  const generation = task.generation, signal = worker.controller.signal;
  if (!task.participants.length) {
    await service.store.change(groupId, (record) => {
      const task = service.guard(record, taskId, null, generation); task.status = "needs_input"; task.reason = "群内没有就绪的成员，请先完成 Agent 制作";
      message(record, system, "这里的成员还没有准备好。请先完成智能体制作，再回来和我们对话。", { taskId, visibility: "public", kind: "clarification" }); event(record, "task", { taskId, status: task.status });
    }); return;
  }
  await validateMembers(service, task);
  const routing = await routeReply(service, groupId, taskId, generation, signal);
  if (routing.mode === "clarify") return;
  const requested = requestedRecipients(task);
  const addressed = routing.mode === "default" ? requested : routing.memberIds;
  const participants = addressed.length ? task.participants.filter((member) => addressed.includes(member.id)) : task.participants;
  if (!participants.length) throw new InputError("被点名成员尚未就绪");
  while (task.negotiationRound < service.limits.negotiationRounds && !task.ownerId) {
    await validateMembers(service, task); const round = task.negotiationRound + 1;
    await service.store.change(groupId, (record) => {
      const task = service.guard(record, taskId, null, generation); task.negotiationRound = round; task.status = "negotiating";
      event(record, "task", { taskId, phase: "negotiation", round });
    });
    let nextMember = 0;
    const inspectMember = async (member) => {
      try {
        signal.throwIfAborted(); let intent;
        const currentRecord = await service.store.get(groupId), currentTask = service.guard(currentRecord, taskId, member.id, generation);
        const earlier = currentTask.intents.find((value) => value.agentId === member.id && value.replyMessageId);
        if (earlier) {
          await service.store.change(groupId, (record) => { service.guard(record, taskId, member.id, generation).intents.find((value) => value.agentId === member.id).round = round; });
          return;
        }
        const payload = { goal: task.goal, conversationId: groupConversationId(currentTask), members: await service.groupMemberCards(groupId), previousIntents: task.intents, memberId: member.id,
          selectedMaterialIds: currentTask.attachmentIds, requestedRecipientIds: requestedRecipients(currentTask),
          replyRouting: currentTask.replyRouting,
          recentMessages: groupConversationMessages(currentRecord, currentTask, publicGroupMessages(currentRecord)),
          triggeringMessage: currentRecord.messages.findLast((value) => value.taskId === taskId && ["user", "main"].includes(value.sender?.type)) ?? null,
          instruction: "先判断是直接对话还是需要真实执行的任务。回复对象已由平台 replyRouting 固定，成员不能用 replyAudience 改名单。普通问候、介绍、可直接回答的问题，用 conversation 提交以我/你说话的本人 reply，不造工作或声称业务完成；确实缺信息用 replyStatus:needs_input 提出具体问题。即便其他人也被点名，你也只写自己本人的答复；不要替同伴解释、推测未就绪、回“用户喊你”或说自己不叫人。对另一成员明确提问、交接或要求确认时，填写 replyRequest:{recipientId,kind:question|handoff|confirmation}，平台会安排他本人公开回复；只有提及则只填 replyRecipientId。任务才自愿提出互补贡献，愿意整合可支持自己；第二轮结合意向形成一致选择。" };
        const taskAllowNetwork = groupTaskAllowsNetwork(currentRecord, currentTask);
        await service.agents.executeCollaboration({ agentId: member.id, revision: member.revision, capabilityVersion: member.capabilityVersion, taskAllowNetwork, sessionId: randomUUID(), allowBusinessTools: false, maxTurns: 3,
          scope: { groupId, taskId }, systemContext: `${GROUP_SYSTEM}\n这是第 ${round} 轮交互判断与认领协商，仅可读取成员能力卡、分页读取本轮资料并使用 submit_group_intent 提交意向或直接对话回复，不能执行业务。成员卡的 callable 不表示认领轮拥有业务权限。`,
          message: JSON.stringify(boundedContext(payload)),
          customTools: [intentTool((value) => { intent = value; }), contextTool(payload), memberCapabilityTool(service, { groupId, taskId, agentId: member.id, generation, signal })] }, () => {}, { signal });
        if (!intent) throw new InputError("成员没有提交认领意向");
        if (intent.integratorId && !task.participants.some((value) => value.id === intent.integratorId)) throw new InputError("整合者必须是本群就绪成员");
        if (intent.replyAudience?.memberIds.some((id) => !task.participants.some((value) => value.id === id))) throw new InputError("回复对象必须是本群本轮就绪成员");
        if (intent.replyRecipientId && (intent.replyRecipientId === member.id || !task.participants.some((value) => value.id === intent.replyRecipientId))) throw new InputError("只能引用本群本轮就绪的其他成员");
        validateReplyRequest(currentRecord, currentTask, member.id, intent.replyRequest);
        await validateMembers(service, currentTask); signal.throwIfAborted();
        await service.store.change(groupId, (record) => {
          const current = service.guard(record, taskId, member.id, generation);
          current.intents = current.intents.filter((value) => value.agentId !== member.id);
          const stored = { ...intent, agentId: member.id, round }; current.intents.push(stored);
          message(record, actor(member), intent.interaction === "conversation" ? intent.reply : intent.participate ? `${intent.contribution}${intent.willingToIntegrate ? "\n我愿意承担本任务的成果整合。" : ""}` : "本轮我暂不认领，有相关问题可以再找我。", { taskId, visibility: "internal", kind: "negotiation" });
          if (routing.mode !== "default" && intent.interaction === "conversation" && !intent.replyRequest) {
            stored.replyMessageId = message(record, actor(member), intent.reply, { taskId, replyTo: routing.sourceMessageId,
              ...(intent.replyRecipientId ? { recipientId: intent.replyRecipientId } : {}), visibility: "public", kind: intent.replyStatus === "needs_input" ? "clarification" : "reply" }).id;
          }
        });
      } catch (error) {
        signal.throwIfAborted();
        await service.store.change(groupId, (record) => {
          const current = service.guard(record, taskId, member.id, generation);
          current.intents = current.intents.filter((value) => value.agentId !== member.id);
          current.intents.push({ agentId: member.id, participate: false, willingToIntegrate: false, integratorId: null, contribution: "", round, failed: true });
          message(record, system, `${member.name} 未能提交认领，其他成员可以继续协商。`, { taskId, visibility: "internal", kind: "status" });
        });
      }
    };
    const results = await Promise.allSettled(Array.from({ length: Math.min(participants.length, Math.max(1, service.limits.concurrentMembers)) }, async () => {
      while (nextMember < participants.length) await inspectMember(participants[nextMember++]);
    }));
    const failedWorker = results.find((value) => value.status === "rejected"); if (failedWorker) throw failedWorker.reason;
    await validateMembers(service, task); signal.throwIfAborted();
    const finishedConversation = await service.store.change(groupId, (record) => {
      const current = service.guard(record, taskId, null, generation);
      const intents = participants.map((member) => current.intents.find((value) => value.agentId === member.id && value.round === round));
      if (intents.some((intent) => intent && !intent.failed && intent.interaction !== "conversation")) return false;
      const replies = intents.filter((intent) => intent && !intent.failed && intent.interaction === "conversation" && intent.reply);
      if (!replies.length) return false;
      const fallback = replies.find((intent) => intent.replyStatus === "needs_input") ?? replies[0];
      const targets = routing.mode === "default" ? [fallback.agentId] : routing.memberIds;
      const audience = { mode: targets.length > 1 ? "members" : "single", memberIds: targets };
      const selected = participants.filter((member) => audience.memberIds.includes(member.id)).map((member) => replies.find((intent) => intent.agentId === member.id)).filter(Boolean);
      if (!selected.length) return false;
      const missing = participants.filter((member) => audience.memberIds.includes(member.id) && !selected.some((intent) => intent.agentId === member.id));
      const failed = missing.length > 0;
      current.replyAudience = audience;
      const source = record.messages.findLast((value) => value.taskId === taskId && ["user", "main"].includes(value.sender?.type));
      if (source) source.replyAudience = audience;
      current.ownerId = selected[0].agentId; current.phase = "conversation";
      current.status = failed ? "partial" : selected.some((intent) => intent.replyStatus === "needs_input") ? "needs_input" : "completed";
      current.result = selected.length === 1 ? selected[0].reply : selected.map((intent) => `${participants.find((member) => member.id === intent.agentId).name}：${intent.reply}`).join("\n\n");
      current.reason = current.status === "needs_input" ? selected.filter((intent) => intent.replyStatus === "needs_input").map((intent) => intent.reply).join("\n\n")
        : failed ? "部分成员暂时未能回复，已保留其他成员的答复" : "";
      current.updatedAt = now();
      for (const intent of selected) {
        publishConversationIntent(record, current, intent, routing.sourceMessageId, service.limits);
      }
      if (failed) message(record, system, missing.length ? `${missing.map((member) => member.name).join("、")} 暂时未能回复，其他成员的答复已保留。`
        : "部分成员暂时未能回复，已有答复已保留。", { taskId, visibility: "public", kind: "status" });
      event(record, "task", { taskId, status: current.status }); return true;
    });
    if (finishedConversation) return;
    await service.store.change(groupId, (record) => {
      const current = service.guard(record, taskId, null, generation), directed = current.requestedRecipientId && current.intents.find((value) => value.agentId === current.requestedRecipientId && value.participate);
      const chosen = directed ? directed.agentId : selectIntegrator(current.intents);
      if (!chosen) return;
      current.ownerId = chosen; current.phase = "execution"; current.status = "running";
      for (const intent of current.intents.filter((value) => value.participate)) {
        const child = service.makeChild(current, { title: intent.contribution, assigneeId: intent.agentId }); service.queue(current, intent.agentId, { childId: child.id });
      }
      if (routing.mode !== "default") for (const intent of current.intents.filter((value) => value.interaction === "conversation" && !value.replyMessageId)) {
        publishConversationIntent(record, current, intent, routing.sourceMessageId, service.limits);
      }
      message(record, system, `成员已确定分工，本任务由 ${current.participants.find((value) => value.id === chosen).name} 整合成果。`, { taskId, visibility: "internal", kind: "status" });
      event(record, "task", { taskId, status: current.status });
    });
    record = await service.store.get(groupId); task = record.tasks.find((value) => value.id === taskId);
  }
  if (!task.ownerId) await service.store.change(groupId, (record) => {
    const current = service.guard(record, taskId, null, generation); current.status = "needs_input";
    current.reason = "两轮协商后尚未确定整合者，请点名一位成员承担整合，或调整成员后创建新任务";
    const failed = current.intents.some((intent) => intent.failed);
    const targets = current.replyRouting?.memberIds ?? [];
    const targetNames = current.participants.filter((member) => targets.includes(member.id)).map((member) => member.name);
    message(record, system, failed ? targetNames.length ? `${targetNames.join("、")} 本次暂时未能回复，请稍后重试。已有消息已保留。`
      : "我们暂时没能完成回复，已有信息都保留了。请稍后重试，或点名一位成员继续。" : "请告诉我们你想解决什么、希望得到什么结果，也可以点名一位成员继续。", { taskId, visibility: "public", kind: "clarification" }); event(record, "task", { taskId, status: current.status });
    if (routing.mode !== "default") for (const intent of current.intents.filter((value) => value.interaction === "conversation" && !value.replyMessageId)) {
      publishConversationIntent(record, current, intent, routing.sourceMessageId, service.limits);
    }
  });
}

async function finishJob(service, groupId, taskId, generation, job, submission) {
  await service.store.change(groupId, (record) => {
    const task = service.guard(record, taskId, job.agentId, generation), stored = task.jobs.find((value) => value.id === job.id);
    if (!stored || stored.status !== "running") throw new InputError("本轮工作已经结束");
    stored.status = "completed";
    const member = task.participants.find((value) => value.id === job.agentId), child = task.children.find((value) => value.id === job.childId);
    const isDelivery = job.kind === "integration" && submission.status !== "waiting";
    if (isDelivery) validateReplyRequest(record, task, member.id, submission.replyRequest);
    const resultMessage = message(record, actor(member), submission.result || submission.reason || "正在等待协作结果。", { taskId, replyTo: job.messageId,
      ...(isDelivery && submission.replyRecipientId ? { recipientId: submission.replyRecipientId } : {}),
      visibility: isDelivery ? "public" : "internal", kind: isDelivery ? ["complete", "partial"].includes(submission.status) ? "delivery" : "clarification" : job.kind === "work" ? "member_result" : "coordination" });
    if (job.kind === "question") {
      const question = task.questions?.find((value) => value.id === job.messageId);
      if (question) {
        resultMessage.recipientId = question.askerId;
        question.status = submission.status === "complete" ? "answered" : submission.status;
        question.result = submission.result; question.reason = submission.reason;
        if (submission.status === "complete") {
          question.answerId = resultMessage.id;
          const askingChild = task.children.find((value) => value.id === question.childId);
          if (question.parentQuestionId) {
            const parent = task.questions.find((value) => value.id === question.parentQuestionId);
            const waiting = task.questions.some((value) => value.parentQuestionId === parent?.id && value.status !== "answered");
            if (parent && parent.status !== "answered" && !waiting) service.queue(task, parent.recipientId, { kind: "question", messageId: parent.id });
          } else if (askingChild) {
            askingChild.pendingQuestions = askingChild.pendingQuestions.filter((value) => value !== question.id);
            if (["waiting", "needs_input"].includes(askingChild.status) && readyDependencies(task, askingChild)) {
              askingChild.status = "queued"; service.queue(task, askingChild.assigneeId, { childId: askingChild.id });
            }
          } else if (question.askerId === task.ownerId) {
            task.integrationSignature = null;
            if (!openIntegratorQuestions(task)) service.queue(task, task.ownerId, { kind: "integration", messageId: resultMessage.id });
          } else {
            service.queue(task, question.askerId, { kind: "message", messageId: resultMessage.id });
          }
        }
      }
    } else if (job.kind === "work" && child) {
      child.status = submission.status === "complete" ? "completed" : submission.status === "waiting" ? "waiting" : submission.status === "declined" ? "declined" : "needs_input";
      child.result = submission.result; child.reason = submission.reason; child.artifactIds = submission.artifactIds; child.updatedAt = now();
    } else if (job.kind === "integration") {
      if (["complete", "partial"].includes(submission.status)) {
        task.status = submission.status === "complete" ? "completed" : "partial"; task.phase = "delivery";
        task.result = submission.result; task.artifactIds = submission.artifactIds; task.reason = submission.reason;
        // Final delivery closes optional background requests as well.
        for (const pending of task.jobs) if (pending.status === "queued") pending.status = "cancelled";
      } else if (["needs_input", "declined"].includes(submission.status) || !hasWork(task)) {
        task.status = "needs_input"; task.reason = submission.reason || "等待补充信息或重新分配"; task.result = submission.result;
      }
    } else if (job.kind === "update" || job.kind === "message") {
      for (const question of task.questions ?? []) if (question.recipientId === job.agentId && question.status !== "answered") {
        service.queue(task, job.agentId, { kind: "question", messageId: question.id });
      }
      for (const value of task.children) if (value.assigneeId === job.agentId && ["needs_input", "declined"].includes(value.status)) {
        value.status = "queued"; service.queue(task, job.agentId, { childId: value.id });
      }
      if (job.agentId === task.ownerId) task.integrationSignature = null;
    }
    for (const dependent of task.children) if (dependent.status === "waiting" && dependent.assigneeId && readyDependencies(task, dependent)) {
      dependent.status = "queued"; service.queue(task, dependent.assigneeId, { childId: dependent.id });
    }
    if (isDelivery) schedulePublicReply(record, task, resultMessage, submission.replyRequest, service.limits);
    task.updatedAt = now(); event(record, "task", { taskId, childId: child?.id, status: task.status });
  });
}

async function executeJob(service, groupId, taskId, generation, job, signal) {
  let reserved = 0, turns = 0, submitted;
  try {
    let task = (await service.store.get(groupId)).tasks.find((value) => value.id === taskId);
    await validateMembers(service, task);
    const canRun = await service.store.change(groupId, (record) => {
      const task = service.guard(record, taskId, job.agentId, generation), stored = task.jobs.find((value) => value.id === job.id);
      if (stored.status !== "queued") return false;
      if (job.kind === "integration" && task.jobs.some((value) => value.kind !== "integration" && ["queued", "running"].includes(value.status))) return false;
      const child = task.children.find((value) => value.id === job.childId);
      if (job.kind === "claim" && child?.assigneeId) { stored.status = "cancelled"; return false; }
      if (job.kind === "work" && child && !readyDependencies(task, child)) { child.status = "waiting"; stored.status = "completed"; return false; }
      reserved = Math.min(service.limits.turnLimit, service.limits.executionTurns - task.turnsUsed);
      if (reserved <= 0) return false;
      // Reserve before invoking the model; a crash must never refund unknown work.
      task.turnsUsed += reserved; stored.status = "running"; if (job.kind === "work" && child) child.status = "running";
      event(record, "status", { taskId, agentId: job.agentId, phase: job.kind }); return true;
    });
    if (!canRun) return;
    const record = await service.store.get(groupId); task = record.tasks.find((value) => value.id === taskId);
    const member = task.participants.find((value) => value.id === job.agentId), shared = await service.sharedMaterials(groupId);
    const prompt = { goal: task.goal, conversationId: groupConversationId(task), kind: job.kind, memberId: job.agentId, integratorId: task.ownerId,
      workDirectory: ".",
      child: task.children.find((value) => value.id === job.childId) ?? null, members: await service.groupMemberCards(groupId),
      tasks: task.children, selectedMaterialIds: task.attachmentIds,
      sharedMaterials: shared.attachments.map((value) => ({ ...value, selectedForTask: task.attachmentIds.includes(value.id) })),
      recentMessages: groupTurnMessages(record, task),
      triggeringMessage: record.messages.find((value) => value.id === job.messageId) ?? null,
      instruction: job.kind === "integration" ? "检查各项真实结果，必要时继续后台求助。最终结果是直接对你说的话：用我/你/我们给出实际成果、必要依据、还缺什么，不叙述后台分工或把你称作用户。必需子任务未完成时只能明确部分交付或提出具体补充问题。"
        : job.kind === "question" ? "回答触发消息中的信息问题。这是一个独立短轮次，不需要等待自己的原任务完成。提交后平台自动回复提问者。"
          : job.kind === "claim" ? "仅判断是否愿意认领这个子任务。涉及 capabilityId 时先完整读取自己的当前能力卡核对输入、输出和完成条件。愿意时先调用 claim_group_task，再提交本轮结果，平台随后安排执行；缺输入提交 needs_input，不适合提交 declined。"
            : job.kind === "message" || job.kind === "update" ? "处理新信息，按需安排协作。无需重复已完成的工作。" : "执行自己认领的工作。交接摘要有截断时先用 read_group_turn_context(section:'child') 获取完整输入、输出和完成条件；需要他人帮助时请求并结束本轮等待。" };
    let intentTurns = 0;
    if (job.kind === "update" && job.routeResolved && !job.intentChecked) {
      let intent;
      const input = prompt.triggeringMessage;
      const context = { goal: task.goal, kind: "update", conversationId: prompt.conversationId, memberId: member.id,
        members: prompt.members, triggeringMessage: input, replyRouting: input.replyRouting,
        recentMessages: groupConversationMessages(record, task, publicGroupMessages(record)).filter((value) => value.seq <= input.seq),
        instruction: "判断 triggeringMessage 这条最新原话：点名打招呼、介绍或普通问答用 conversation，直接提交你本人的 reply；不要把它当作原业务的补充，也不要替同伴传话。确实修改或继续原业务的指令才用 task。此处只读判断，不能执行或声称已执行业务。" };
      const output = await service.agents.executeCollaboration({ agentId: member.id, revision: member.revision, capabilityVersion: member.capabilityVersion,
        taskAllowNetwork: false, sessionId: randomUUID(), scope: { groupId, taskId }, maxTurns: Math.min(3, reserved), allowBusinessTools: false,
        systemContext: GROUP_SYSTEM, message: JSON.stringify(boundedContext(context)),
        customTools: [intentTool((value) => { intent = value; }), contextTool(context),
          memberCapabilityTool(service, { groupId, taskId, agentId: member.id, generation, signal })] }, () => {}, { signal });
      turns = intentTurns = Math.max(1, output.turns ?? 1);
      if (!intent) throw new InputError("成员没有提交明确的交互判断");
      await validateMembers(service, task); signal.throwIfAborted();
      const answered = await service.store.change(groupId, (record) => {
        const current = service.guard(record, taskId, member.id, generation), stored = current.jobs.find((value) => value.id === job.id);
        if (stored?.status !== "running") throw new InputError("这条消息已结束处理");
        stored.intentChecked = true;
        if (intent.interaction !== "conversation") { delete current.continuationState; return false; }
        validateReplyRequest(record, current, member.id, intent.replyRequest);
        if (intent.replyRecipientId && (intent.replyRecipientId === member.id || !current.participants.some((value) => value.id === intent.replyRecipientId))) throw new InputError("只能引用本群本轮就绪的其他成员");
        stored.status = "completed";
        const posted = message(record, actor(member), intent.reply, { taskId, replyTo: input.id,
          ...(intent.replyRecipientId ? { recipientId: intent.replyRecipientId } : {}), visibility: "public", kind: intent.replyStatus === "needs_input" ? "clarification" : "reply" });
        stored.replyMessageId = posted.id;
        restoreConversationUpdate(current);
        schedulePublicReply(record, current, posted, intent.replyRequest, service.limits);
        current.updatedAt = now(); event(record, "task", { taskId, status: current.status }); return true;
      });
      if (answered) return;
    }
    if (reserved <= intentTurns) throw new InputError("本轮已达到自动协作次数限制");
    turns = reserved;
    const output = await service.agents.executeCollaboration({ agentId: job.agentId, revision: member.revision, capabilityVersion: member.capabilityVersion, taskAllowNetwork: groupTaskAllowsNetwork(record, task),
      sessionId: randomUUID(), scope: { groupId, taskId }, maxTurns: reserved - intentTurns, systemContext: GROUP_SYSTEM, allowBusinessTools: job.kind !== "claim",
      message: JSON.stringify(boundedContext(prompt)), customTools: [...groupTools(service, { groupId, taskId, agentId: job.agentId, generation, job, signal, capture: (value) => { submitted = value; } }), contextTool(prompt)] }, () => {}, { signal });
    turns = intentTurns + Math.max(1, output.turns ?? 1);
    if (!submitted) throw new InputError("成员未提交明确工作结果");
    signal.throwIfAborted(); await finishJob(service, groupId, taskId, generation, job, submitted);
  } catch (error) {
    if (signal.aborted) return;
    try { await service.validateTaskCapabilities(groupId, taskId, generation); }
    catch {
      const current = (await service.store.get(groupId)).tasks.find((value) => value.id === taskId);
      if (!current || !live(current) || current.generation !== generation) return;
    }
    turns ||= reserved;
    await service.store.change(groupId, (record) => {
      const task = record.tasks.find((value) => value.id === taskId);
      if (!task || !live(task) || task.generation !== generation) return;
      const stored = task.jobs.find((value) => value.id === job.id); if (stored) stored.status = "failed";
      const child = task.children.find((value) => value.id === job.childId);
      if (job.kind === "work" && child) { child.status = "failed"; child.reason = "本轮未完成，请检查后重新分配"; }
      if (job.kind === "integration") { task.status = "needs_input"; task.reason = "整合未完成，请检查已有结果后继续"; }
      if (error.reason === "capability_changed") {
        service.interrupt(record, task, "执行条件已经变化，我们已停止继续操作，已有成果保留。请检查后重新开始。", "interrupted"); return;
      }
      message(record, system, job.kind === "integration" ? "我们暂时没能完成最终回复，已有成果都保留了。请检查后继续。" : `${task.participants.find((value) => value.id === job.agentId)?.name ?? "成员"} 本轮未完成，已有成果保留。`,
        { taskId, status: "failed", visibility: ["integration", "update"].includes(job.kind) ? "public" : "internal", kind: "status" });
      restoreConversationUpdate(task);
      event(record, "task", { taskId, status: task.status });
    });
  } finally {
    if (reserved && !signal.aborted) await service.store.change(groupId, (record) => {
      const task = record.tasks.find((value) => value.id === taskId);
      if (task?.generation === generation) task.turnsUsed -= Math.max(0, reserved - turns);
    });
  }
}

async function answerPublicReplyQueue(service, groupId, taskId, worker) {
  const signal = worker.controller.signal;
  for (;;) {
    signal.throwIfAborted();
    let record = await service.store.get(groupId), task = record.tasks.find((value) => value.id === taskId);
    if (!live(task) || task.phase !== "responding") return;
    const generation = task.generation;
    await validateMembers(service, task);
    const request = await service.store.change(groupId, (record) => {
      const current = service.guard(record, taskId, null, generation), relay = current.replyRelay;
      if (current.phase !== "responding" || relay?.generation !== generation) return null;
      const occupied = new Set(relay.requests.filter((value) => value.status === "running").map((value) => value.recipientId));
      const next = relay.requests.find((value) => value.status === "queued" && !occupied.has(value.recipientId));
      if (!next) { finishPublicReplyRelay(record, current); return null; }
      const reserved = Math.min(service.limits.publicReplyTurns, service.limits.executionTurns - current.turnsUsed);
      if (reserved <= 0 && occupied.size) return null;
      next.status = "running"; next.reservedTurns = reserved; current.turnsUsed += reserved;
      event(record, "status", { taskId, agentId: next.recipientId, phase: "public_reply" }); return next;
    });
    if (!request) return;
    let usedTurns = request.reservedTurns, submitted;
    try {
      if (!request.reservedTurns) throw new InputError("本轮已达到自动回复次数限制");
      record = await service.store.get(groupId); task = service.guard(record, taskId, request.recipientId, generation);
      const member = task.participants.find((value) => value.id === request.recipientId);
      const prompt = { kind: "public_reply", goal: task.goal, conversationId: groupConversationId(task), memberId: member.id,
        members: await service.groupMemberCards(groupId),
        triggeringMessage: record.messages.find((value) => value.id === request.sourceMessageId),
        replyRequest: request, recentMessages: groupConversationMessages(record, task, publicGroupMessages(record)),
        instruction: "这是对你本人的公开提问、交接或确认请求。直接用我/你回应来源成员，提交 submit_group_reply。收到确认后结束；必要的新问题才请求下一位。没有业务工具，不能冒充已执行实际工作。" };
      const output = await service.agents.executeCollaboration({ agentId: member.id, revision: member.revision, capabilityVersion: member.capabilityVersion,
        taskAllowNetwork: false, sessionId: randomUUID(), scope: { groupId, taskId }, allowBusinessTools: false,
        maxTurns: request.reservedTurns, systemContext: PUBLIC_REPLY_SYSTEM, message: JSON.stringify(boundedContext(prompt)),
        customTools: [replyTool((value) => { submitted = value; }), contextTool(prompt)] }, () => {}, { signal });
      usedTurns = Math.max(1, output.turns ?? 1);
      if (!submitted) throw new InputError("成员没有提交明确的公开答复");
      await validateMembers(service, task); signal.throwIfAborted();
      await service.store.change(groupId, (record) => {
        const current = service.guard(record, taskId, member.id, generation), relay = current.replyRelay;
        const stored = relay?.requests.find((value) => value.id === request.id);
        if (current.phase !== "responding" || stored?.status !== "running" || relay.generation !== generation) throw new InputError("这次接话已经结束");
        validateReplyRequest(record, current, member.id, submitted.replyRequest);
        const recipientId = submitted.replyRecipientId ?? request.requesterId;
        if (recipientId === member.id || !record.group.memberIds.includes(recipientId) || !current.participants.some((value) => value.id === recipientId)) throw new InputError("公开答复只能引用本轮其他成员");
        const posted = message(record, actor(member), submitted.reply, { taskId, recipientId, replyTo: request.sourceMessageId,
          visibility: "public", kind: submitted.replyStatus === "complete" ? "reply" : "clarification" });
        stored.status = "completed"; stored.replyMessageId = posted.id;
        const source = record.messages.find((value) => value.id === stored.sourceMessageId);
        if (source) source.replyRequestStatus = "completed";
        if (submitted.replyStatus === "needs_input") relay.needsInput.push(submitted.reply);
        if (submitted.replyStatus === "declined") relay.failures.push(submitted.reply);
        schedulePublicReply(record, current, posted, submitted.replyRequest, service.limits, stored);
        current.updatedAt = now(); event(record, "task", { taskId, status: current.status });
      });
    } catch (error) {
      if (signal.aborted) return;
      try { await service.validateTaskCapabilities(groupId, taskId, generation); } catch { return; }
      await service.store.change(groupId, (record) => {
        const current = service.guard(record, taskId, request.recipientId, generation), relay = current.replyRelay;
        const stored = relay?.requests.find((value) => value.id === request.id);
        if (stored?.status !== "running") return;
        stored.status = "failed";
        const name = current.participants.find((value) => value.id === request.recipientId)?.name ?? "被叫到的成员";
        const explanation = `${name} 本次暂时未能自动回复，已有内容保留。`;
        relay.failures.push(explanation);
        const source = record.messages.find((value) => value.id === stored.sourceMessageId);
        if (source) source.replyRequestStatus = "failed";
        message(record, system, explanation, { taskId, visibility: "public", kind: "status", status: "failed" });
      });
    } finally {
      if (!signal.aborted) await service.store.change(groupId, (record) => {
        const current = record.tasks.find((value) => value.id === taskId);
        if (current?.generation === generation) current.turnsUsed -= Math.max(0, request.reservedTurns - usedTurns);
      });
    }
  }
}

async function answerPublicReplies(service, groupId, taskId, worker) {
  const results = await Promise.allSettled(Array.from({ length: Math.max(1, service.limits.concurrentMembers) }, () => answerPublicReplyQueue(service, groupId, taskId, worker)));
  const failed = results.find((value) => value.status === "rejected");
  if (failed) throw failed.reason;
}

async function executeTask(service, groupId, taskId, worker) {
  const signal = worker.controller.signal;
  for (;;) {
    signal.throwIfAborted(); let record = await service.store.get(groupId), task = record.tasks.find((value) => value.id === taskId);
    // A quick answer can reset a published clarification before its worker unwinds.
    if (!live(task) || task.status === "queued" && !task.ownerId) return;
    if (task.phase === "responding") { await answerPublicReplies(service, groupId, taskId, worker); continue; }
    const update = task.jobs.find((job) => job.kind === "update" && job.status === "queued" && !job.routeResolved
      && record.messages.some((value) => value.id === job.messageId && ["user", "main"].includes(value.sender?.type)));
    if (update) { await prepareUserUpdate(service, groupId, taskId, task.generation, update, signal); continue; }
    if (task.turnsUsed >= service.limits.executionTurns) {
      await service.store.change(groupId, (record) => {
        const current = service.guard(record, taskId, null, task.generation); current.status = "needs_input"; current.reason = "本任务已用完自动协作轮次，请检查成果后创建新任务继续";
        message(record, system, "我们已达到这次自动处理的次数限制，已有成果保留。请检查后重新开始。", { taskId, visibility: "public", kind: "status" }); event(record, "task", { taskId, status: current.status });
      }); return;
    }
    const selected = [], occupied = new Set();
    const pendingWork = task.jobs.some((job) => job.kind !== "integration" && ["queued", "running"].includes(job.status));
    for (const job of task.jobs.filter((value) => value.status === "queued")) {
      if (job.kind === "integration" && pendingWork) continue;
      if (occupied.has(job.agentId)) continue;
      selected.push(job); occupied.add(job.agentId); if (selected.length === service.limits.concurrentMembers) break;
    }
    if (selected.length) {
      const results = await Promise.allSettled(selected.map((job) => executeJob(service, groupId, taskId, task.generation, job, signal)));
      const failed = results.find((value) => value.status === "rejected");
      if (failed) throw failed.reason;
      continue;
    }
    const signature = fingerprint(task.children.map(({ id, status, result }) => ({ id, status, result })));
    if (task.ownerId && !openIntegratorQuestions(task) && task.integrationSignature !== signature) {
      await service.store.change(groupId, (record) => {
        const current = service.guard(record, taskId, null, task.generation); current.integrationSignature = signature;
        service.queue(current, current.ownerId, { kind: "integration" }); current.phase = "integration";
        event(record, "task", { taskId, phase: current.phase });
      }); continue;
    }
    await service.store.change(groupId, (record) => {
      const current = service.guard(record, taskId, null, task.generation); current.status = "needs_input";
      current.reason = "当前没有可继续执行的工作，请检查等待事项或补充信息";
      event(record, "task", { taskId, status: current.status }); message(record, system, "我们还需要一些信息才能继续。请补充相关材料或说明你想得到的结果。", { taskId, visibility: "public", kind: "clarification" });
    }); return;
  }
}

export async function runGroup(service, groupId, worker) {
  await service.ready;
  while (!service.closed && !worker.controller.signal.aborted) {
    const record = await service.store.get(groupId);
    if (record.group.archived) return;
    const task = record.tasks.find((value) => value.status === "queued"); if (!task) return;
    worker.taskId = task.id;
    await service.store.change(groupId, (record) => { const current = service.guard(record, task.id, null, task.generation); current.status = "running"; record.group.activeTaskId = task.id; event(record, "task", { taskId: task.id, status: "running" }); });
    try {
      await validateMembers(service, task);
      if (!task.ownerId) await negotiate(service, groupId, task.id, worker);
      if (!worker.controller.signal.aborted) await executeTask(service, groupId, task.id, worker);
    } catch (error) {
      if (worker.controller.signal.aborted) return;
      await service.store.change(groupId, (record) => {
        const current = record.tasks.find((value) => value.id === task.id);
        if (current && live(current)) service.interrupt(record, current, error instanceof InputError ? error.message : "任务未能继续，请检查已有成果", "interrupted");
      });
    }
    await service.store.change(groupId, (record) => { if (record.group.activeTaskId === task.id) record.group.activeTaskId = null; });
    worker.taskId = null;
  }
}
