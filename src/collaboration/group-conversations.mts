import type { GroupRecord, GroupTask } from "../contracts/collaboration.mjs";
export const groupConversationId = (task: Pick<GroupTask, "id" | "conversationId">) => task?.conversationId || task?.id;

export function groupConversationTasks<Task extends Pick<GroupTask, "id" | "conversationId">>(record: { tasks?: Task[] | undefined }, task: Pick<GroupTask, "id" | "conversationId">, { throughCurrent = true } = {}) {
  const tasks = record.tasks ?? [], index = tasks.findIndex((value) => value.id === task.id);
  const history = throughCurrent && index >= 0 ? tasks.slice(0, index + 1) : tasks;
  const conversationId = groupConversationId(task);
  return history.filter((value) => groupConversationId(value) === conversationId);
}

export function groupConversationMessages<Task extends Pick<GroupTask, "id" | "conversationId">, Message extends { taskId?: string | null | undefined }>(record: { tasks?: Task[] | undefined; messages?: Message[] | undefined }, task: Pick<GroupTask, "id" | "conversationId">, messages = record.messages) {
  const taskIds = new Set<string | null | undefined>([task.id, ...groupConversationTasks(record, task).map((value) => value.id)]);
  return (messages ?? []).filter((value) => taskIds.has(value.taskId));
}
