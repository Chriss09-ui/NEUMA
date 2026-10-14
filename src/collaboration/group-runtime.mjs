import { randomUUID } from "node:crypto";
import { InputError } from "../requirements/core.mjs";
import { event, message, now, fingerprint } from "./group-store.mjs";
import { GROUP_SYSTEM, intentTool, groupTools, memberCapabilityTool, groupTaskAllowsNetwork } from "./group-tools.mjs";
import { createContextReadTool } from "../development/development-context.mjs";

const system = { type: "system", id: "platform", name: "NEUMA" };
const live = (task) => ["queued", "running", "negotiating", "waiting"].includes(task.status);
const hasWork = (task) => task.jobs.some((job) => ["queued", "running"].includes(job.status));
const readyDependencies = (task, child) => !child.pendingQuestions.length && child.dependsOn.every((ref) => task.children.find((value) => value.id === ref)?.status === "completed");
const actor = (member) => ({ type: "agent", id: member.id, name: member.name });
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
    const result = { ...base, kind: payload.kind, memberId: payload.memberId, integratorId: payload.integratorId, workDirectory: payload.workDirectory, selectedMaterialIds: payload.selectedMaterialIds,
      goal: excerpt(payload.goal, length * 2), instruction: payload.instruction,
      child: payload.child ? { id: payload.child.id, title: excerpt(payload.child.title, length), description: excerpt(payload.child.description, length),
        status: payload.child.status, assigneeId: payload.child.assigneeId, dependsOn: payload.child.dependsOn, pendingQuestions: payload.child.pendingQuestions,
        capabilityId: payload.child.capabilityId, capabilityVersion: payload.child.capabilityVersion, inputs: excerpt(payload.child.inputs, length),
        expectedOutput: excerpt(payload.child.expectedOutput, length), acceptance: excerpt(payload.child.acceptance, length) } : null,
      members: (payload.members ?? []).map(({ id, name, ready }) => ({ id, name: length < 120 ? excerpt(name, length) : name, ready })),
      tasks: (payload.tasks ?? []).slice(-15).map(({ id, title, assigneeId, status }) => ({ id, title: excerpt(title, length), assigneeId, status })),
      previousIntents: (payload.previousIntents ?? []).slice(-15).map(({ agentId, participate, integratorId, contribution }) => ({ agentId, participate, integratorId, contribution: excerpt(contribution, length) })),
      recentMessages: (payload.recentMessages ?? []).slice(-6).map(({ id, sender, content, taskId, recipientId }) => ({ id, sender, content: excerpt(content, length), taskId, recipientId })),
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

async function validateMembers(service, task) {
  const cards = await service.validateTaskCapabilities(task.groupId, task.id, task.generation);
  return cards.filter((card) => task.participants.some((member) => member.id === card.id));
}

async function negotiate(service, groupId, taskId, worker) {
  let record = await service.store.get(groupId), task = record.tasks.find((value) => value.id === taskId);
  const generation = task.generation, signal = worker.controller.signal;
  if (!task.participants.length) {
    await service.store.change(groupId, (record) => {
      const task = service.guard(record, taskId, null, generation); task.status = "needs_input"; task.reason = "群内没有就绪的成员，请先完成 Agent 制作";
      message(record, system, task.reason, { taskId }); event(record, "task", { taskId, status: task.status });
    }); return;
  }
  if (task.requestedRecipientId) {
    await service.store.change(groupId, (record) => {
      const task = service.guard(record, taskId, null, generation), member = task.participants.find((value) => value.id === task.requestedRecipientId);
      if (!member) throw new InputError("被点名成员尚未就绪");
      task.ownerId = member.id; task.phase = "execution"; task.status = "running";
      if (!task.children.length) {
        const child = service.makeChild(task, { title: task.goal.slice(0, 500), description: task.goal.slice(0, 4000), assigneeId: member.id }); service.queue(task, member.id, { childId: child.id });
      }
      event(record, "task", { taskId, status: task.status });
    }); return;
  }
  while (task.negotiationRound < service.limits.negotiationRounds && !task.ownerId) {
    await validateMembers(service, task); const round = task.negotiationRound + 1;
    await service.store.change(groupId, (record) => {
      const task = service.guard(record, taskId, null, generation); task.negotiationRound = round; task.status = "negotiating";
      event(record, "task", { taskId, phase: "negotiation", round });
    });
    for (let offset = 0; offset < task.participants.length; offset += service.limits.concurrentMembers) {
      const results = await Promise.allSettled(task.participants.slice(offset, offset + service.limits.concurrentMembers).map(async (member) => {
        signal.throwIfAborted(); let intent;
        const payload = { goal: task.goal, members: await service.groupMemberCards(groupId), previousIntents: task.intents, memberId: member.id,
          instruction: "自愿提出互补贡献，避免重复劳动。愿意整合可支持自己；否则支持合适成员。第二轮应结合所有意向形成一致选择。" };
        const currentRecord = await service.store.get(groupId), taskAllowNetwork = groupTaskAllowsNetwork(currentRecord, currentRecord.tasks.find((value) => value.id === taskId));
        await service.agents.executeCollaboration({ agentId: member.id, revision: member.revision, capabilityVersion: member.capabilityVersion, taskAllowNetwork, sessionId: randomUUID(), allowBusinessTools: false, maxTurns: 3,
          scope: { groupId, taskId }, systemContext: `${GROUP_SYSTEM}\n这是第 ${round} 轮认领协商，仅可读取成员能力卡、分页读取本轮资料并使用 submit_group_intent 提交意向，不能执行业务。成员卡的 callable 不表示认领轮拥有业务权限。`,
          message: JSON.stringify(boundedContext(payload)),
          customTools: [intentTool((value) => { intent = value; }), contextTool(payload), memberCapabilityTool(service, { groupId, taskId, agentId: member.id, generation, signal })] }, () => {}, { signal });
        if (!intent) throw new InputError("成员没有提交认领意向");
        if (intent.integratorId && !task.participants.some((value) => value.id === intent.integratorId)) throw new InputError("整合者必须是本群就绪成员");
        await service.store.change(groupId, (record) => {
          const current = service.guard(record, taskId, member.id, generation);
          current.intents = current.intents.filter((value) => value.agentId !== member.id);
          current.intents.push({ ...intent, agentId: member.id, round });
          message(record, actor(member), intent.participate ? `${intent.contribution}${intent.willingToIntegrate ? "\n我愿意承担本任务的成果整合。" : ""}` : "本轮我暂不认领，有相关问题可以再找我。", { taskId });
        });
      }));
      for (let i = 0; i < results.length; i++) if (results[i].status === "rejected") {
        signal.throwIfAborted(); const member = task.participants[offset + i];
        await service.store.change(groupId, (record) => {
          const current = service.guard(record, taskId, member.id, generation);
          current.intents = current.intents.filter((value) => value.agentId !== member.id);
          current.intents.push({ agentId: member.id, participate: false, willingToIntegrate: false, integratorId: null, contribution: "", round, failed: true });
          message(record, system, `${member.name} 未能提交认领，其他成员可以继续协商。`, { taskId });
        });
      }
    }
    await service.store.change(groupId, (record) => {
      const current = service.guard(record, taskId, null, generation), chosen = selectIntegrator(current.intents);
      if (!chosen) return;
      current.ownerId = chosen; current.phase = "execution"; current.status = "running";
      for (const intent of current.intents.filter((value) => value.participate)) {
        const child = service.makeChild(current, { title: intent.contribution, assigneeId: intent.agentId }); service.queue(current, intent.agentId, { childId: child.id });
      }
      message(record, system, `成员已确定分工，本任务由 ${current.participants.find((value) => value.id === chosen).name} 整合成果。`, { taskId });
      event(record, "task", { taskId, status: current.status });
    });
    record = await service.store.get(groupId); task = record.tasks.find((value) => value.id === taskId);
  }
  if (!task.ownerId) await service.store.change(groupId, (record) => {
    const current = service.guard(record, taskId, null, generation); current.status = "needs_input";
    current.reason = "两轮协商后尚未确定整合者，请点名一位成员承担整合，或调整成员后创建新任务";
    message(record, system, current.reason, { taskId }); event(record, "task", { taskId, status: current.status });
  });
}

async function finishJob(service, groupId, taskId, generation, job, submission) {
  await service.store.change(groupId, (record) => {
    const task = service.guard(record, taskId, job.agentId, generation), stored = task.jobs.find((value) => value.id === job.id);
    if (!stored || stored.status !== "running") throw new InputError("本轮工作已经结束");
    stored.status = "completed";
    const member = task.participants.find((value) => value.id === job.agentId), child = task.children.find((value) => value.id === job.childId);
    const resultMessage = message(record, actor(member), submission.result || submission.reason || "正在等待协作结果。", { taskId, replyTo: job.messageId });
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
    const prompt = { goal: task.goal, kind: job.kind, memberId: job.agentId, integratorId: task.ownerId,
      workDirectory: ".",
      child: task.children.find((value) => value.id === job.childId) ?? null, members: await service.groupMemberCards(groupId),
      tasks: task.children, selectedMaterialIds: task.attachmentIds,
      sharedMaterials: shared.attachments.map((value) => ({ ...value, selectedForTask: task.attachmentIds.includes(value.id) })),
      recentMessages: record.messages.filter((value) => value.taskId === taskId).slice(-30),
      triggeringMessage: record.messages.find((value) => value.id === job.messageId) ?? null,
      instruction: job.kind === "integration" ? "检查各项真实结果，必要时继续求助，完成时提交最终综合成果。必需子任务未完成时只能明确部分交付或说明缺口。"
        : job.kind === "question" ? "回答触发消息中的信息问题。这是一个独立短轮次，不需要等待自己的原任务完成。提交后平台自动回复提问者。"
          : job.kind === "claim" ? "仅判断是否愿意认领这个子任务。涉及 capabilityId 时先完整读取自己的当前能力卡核对输入、输出和完成条件。愿意时先调用 claim_group_task，再提交本轮结果，平台随后安排执行；缺输入提交 needs_input，不适合提交 declined。"
            : job.kind === "message" || job.kind === "update" ? "处理新信息，按需安排协作。无需重复已完成的工作。" : "执行自己认领的工作。交接摘要有截断时先用 read_group_turn_context(section:'child') 获取完整输入、输出和完成条件；需要他人帮助时请求并结束本轮等待。" };
    const output = await service.agents.executeCollaboration({ agentId: job.agentId, revision: member.revision, capabilityVersion: member.capabilityVersion, taskAllowNetwork: groupTaskAllowsNetwork(record, task),
      sessionId: randomUUID(), scope: { groupId, taskId }, maxTurns: reserved, systemContext: GROUP_SYSTEM, allowBusinessTools: job.kind !== "claim",
      message: JSON.stringify(boundedContext(prompt)), customTools: [...groupTools(service, { groupId, taskId, agentId: job.agentId, generation, job, signal, capture: (value) => { submitted = value; } }), contextTool(prompt)] }, () => {}, { signal });
    turns = Math.max(1, output.turns ?? 1);
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
      message(record, system, `${task.participants.find((value) => value.id === job.agentId)?.name ?? "成员"} 本轮未完成，已有成果保留。`, { taskId, status: "failed" });
      event(record, "task", { taskId, status: task.status });
    });
  } finally {
    if (reserved && !signal.aborted) await service.store.change(groupId, (record) => {
      const task = record.tasks.find((value) => value.id === taskId);
      if (task?.generation === generation) task.turnsUsed -= Math.max(0, reserved - turns);
    });
  }
}

async function executeTask(service, groupId, taskId, worker) {
  const signal = worker.controller.signal;
  for (;;) {
    signal.throwIfAborted(); let record = await service.store.get(groupId), task = record.tasks.find((value) => value.id === taskId);
    if (!live(task)) return;
    if (task.turnsUsed >= service.limits.executionTurns) {
      await service.store.change(groupId, (record) => {
        const current = service.guard(record, taskId, null, task.generation); current.status = "needs_input"; current.reason = "本任务已用完自动协作轮次，请检查成果后创建新任务继续";
        message(record, system, current.reason, { taskId }); event(record, "task", { taskId, status: current.status });
      }); return;
    }
    const selected = [], occupied = new Set();
    const pendingWork = task.jobs.some((job) => job.kind !== "integration" && ["queued", "running"].includes(job.status));
    for (const job of task.jobs.filter((value) => value.status === "queued")) {
      if (job.kind === "integration" && pendingWork) continue;
      if (occupied.has(job.agentId)) continue;
      selected.push(job); occupied.add(job.agentId); if (selected.length === service.limits.concurrentMembers) break;
    }
    if (selected.length) { await Promise.allSettled(selected.map((job) => executeJob(service, groupId, taskId, task.generation, job, signal))); continue; }
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
      event(record, "task", { taskId, status: current.status }); message(record, system, current.reason, { taskId });
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
