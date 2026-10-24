import type { GroupRecord, GroupTask } from "../contracts/collaboration.mjs";
export const groupConversationId = (task: Pick<GroupTask, "id" | "conversationId">) => task?.conversationId || task?.id;

export function groupConversationTasks(record: Pick<GroupRecord, "tasks">, task: Pick<GroupTask, "id" | "conversationId">, { throughCurrent = true } = {}) {
  const tasks = record.tasks ?? [], index = tasks.findIndex((value) => value.id === task.id);
  const history = throughCurrent && index >= 0 ? tasks.slice(0, index + 1) : tasks;
  const conversationId = groupConversationId(task);
  return history.filter((value) => groupConversationId(value) === conversationId);
}

export function groupConversationMessages<Message extends { taskId: string | null }>(record: Pick<GroupRecord, "tasks"> & { messages: Message[] }, task: Pick<GroupTask, "id" | "conversationId">, messages = record.messages) {
  const taskIds = new Set<string | null>([task.id, ...groupConversationTasks(record, task).map((value) => value.id)]);
  return (messages ?? []).filter((value) => taskIds.has(value.taskId));
}
