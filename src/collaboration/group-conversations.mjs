export const groupConversationId = (task) => task?.conversationId || task?.id;

export function groupConversationTasks(record, task, { throughCurrent = true } = {}) {
  const tasks = record.tasks ?? [], index = tasks.findIndex((value) => value.id === task.id);
  const history = throughCurrent && index >= 0 ? tasks.slice(0, index + 1) : tasks;
  const conversationId = groupConversationId(task);
  return history.filter((value) => groupConversationId(value) === conversationId);
}

export function groupConversationMessages(record, task, messages = record.messages) {
  const taskIds = new Set([task.id, ...groupConversationTasks(record, task).map((value) => value.id)]);
  return (messages ?? []).filter((value) => taskIds.has(value.taskId));
}
