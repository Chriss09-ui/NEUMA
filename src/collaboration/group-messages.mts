import type { GroupRecord, GroupTask, GroupMessage } from "../contracts/collaboration.mjs";
const legacyNoOwner = "两轮协商后尚未确定整合者，请点名一位成员承担整合，或调整成员后创建新任务";

function isRecordedResult(task: GroupTask, value: GroupMessage) {
  if (value.sender?.type !== "agent") return false;
  if (value.sender.id === task.ownerId && value.content && [task.result, task.reason].includes(value.content)) return true;
  if ((task.children ?? []).some((child) => child.assigneeId === value.sender.id && value.content && [child.result, child.reason].includes(value.content))) return true;
  return (task.questions ?? []).some((question) => question.answerId === value.id || question.recipientId === value.sender.id
    && value.content && [question.result, question.reason].includes(value.content));
}

function isLegacyCoordination(task: GroupTask, value: GroupMessage) {
  if (value.sender?.type === "system") return (task.participants ?? []).some((member) => value.content === `${member.name} 未能提交认领，其他成员可以继续协商。`
    || value.content === `成员已确定分工，本任务由 ${member.name} 整合成果。`);
  if (value.sender?.type !== "agent") return false;
  return (task.intents ?? []).some((intent) => intent.agentId === value.sender.id && value.content === (intent.participate
    ? `${intent.contribution}${intent.willingToIntegrate ? "\n我愿意承担本任务的成果整合。" : ""}` : "本轮我暂不认领，有相关问题可以再找我。"));
}

// Old records have no visibility field. Use actual execution events rather than
// guessing from prose; unknown messages and completed deliveries stay visible.
export function publicGroupMessages(record: Pick<GroupRecord, "tasks" | "messages" | "events">): GroupMessage[] {
  const tasks = new Map((record.tasks ?? []).map((task) => [task.id, task]));
  const negotiating = new Set(), negotiationMessages = new Set(), executionMessages = new Set(), deliveries = new Set(), phases = new Map();
  const events = record.events ?? [];
  for (const [index, entry] of events.entries()) {
    if (entry.type === "task") {
      if (entry.phase === "negotiation") negotiating.add(entry.taskId);
      else if (entry.status) negotiating.delete(entry.taskId);
    } else if (entry.type === "status" && entry.agentId && ["work", "question", "claim", "update", "message", "integration"].includes(entry.phase ?? "")) {
      phases.set(`${entry.taskId}:${entry.agentId}`, entry.phase);
    } else if (entry.type === "message") {
      if (negotiating.has(entry.taskId)) negotiationMessages.add(entry.messageId);
      const phase = phases.get(`${entry.taskId}:${entry.agentId}`), next = events[index + 1];
      if (phase) executionMessages.add(entry.messageId);
      // finishJob writes the result message and terminal/needs_input event in
      // one store mutation, so prior deliveries survive later task updates too.
      if (phase === "integration" && next?.type === "task" && next.taskId === entry.taskId && !next.childId
        && ["completed", "partial", "needs_input"].includes(next.status ?? "")) deliveries.add(entry.messageId);
    }
  }
  return (record.messages ?? []).flatMap((value) => {
    if (value.visibility === "internal") return [];
    if (value.visibility === "public" || ["user", "main"].includes(value.sender?.type)) return [value];
    const task = tasks.get(value.taskId!);
    if (!task || deliveries.has(value.id)) return [value];
    if (value.sender?.type === "agent" && executionMessages.has(value.id)) return [];
    if (isRecordedResult(task, value)) return [value];
    if (isLegacyCoordination(task, value) || value.sender?.type === "agent" && negotiationMessages.has(value.id)) return [];
    if (value.sender?.type === "system" && value.content === legacyNoOwner) {
      return [{ ...value, content: "请告诉我们你想解决什么、希望得到什么结果，也可以点名一位成员继续。", visibility: "public", kind: "clarification" }];
    }
    return [value];
  });
}
