export const taskLabels = { queued: "等待认领", pending: "等待认领", running: "协作中", discussing: "正在讨论", planning: "正在分工",
  working: "正在处理", completed: "已完成", complete: "已完成", partial: "部分交付", failed: "失败", blocked: "等待处理", cancelled: "已停止", interrupted: "已中断",
  negotiating: "正在协商", negotiation: "成员协商", execution: "执行任务", integration: "整合成果", delivery: "交付成果",
  waiting: "等待成员回应", needs_input: "待你补充", declined: "未认领" };
export const terminalTask = (task) => ["completed", "complete", "partial", "failed", "cancelled", "interrupted"].includes(task?.status);

export function node(tag, className = "", text = "") {
  const value = document.createElement(tag); value.className = className; value.textContent = text; return value;
}
export function button(label, action, className = "ghost-button") {
  const value = node("button", className, label); value.type = "button"; value.addEventListener("click", action); return value;
}
export function notice(target, text, error = false) {
  target.textContent = text || ""; target.hidden = !text; target.classList.toggle("error", error);
}
export function internalLinks(content, actions = []) {
  const links = new Map();
  for (const match of String(content || "").matchAll(/#(group|agent)\/([\w-]+)/g)) links.set(match[0], match[1] === "group" ? "打开群组" : "打开智能体");
  for (const action of actions) {
    const href = typeof action === "string" ? action : action?.href || action?.url || action?.sourceLink;
    if (/^#(?:create|chat|groups|(?:group|agent)\/[\w-]+)$/.test(href || "")) links.set(href, action?.label || action?.name
      || (href.startsWith("#group/") ? "打开群组" : href.startsWith("#agent/") ? "打开智能体" : "打开工作区"));
    if (["create_agent", "create"].includes(action?.type)) links.set("#create", "创建智能体");
  }
  const row = node("div", "collaboration-links");
  for (const [href, label] of links) { const link = node("a", "text-link", label); link.href = href; row.append(link); }
  return row;
}
export function messageRow(message, { attachmentUrl } = {}) {
  const isUser = message.sender?.type === "user" || message.role === "user";
  const row = node("article", `collaboration-message ${isUser ? "is-user" : ""}`);
  row.dataset.messageId = message.id || "";
  const identity = node("div", "collaboration-message-heading");
  identity.append(node("span", "collaboration-message-avatar", isUser ? "我" : Array.from(message.sender?.name || "NEUMA")[0]),
    node("strong", "", isUser ? "你" : message.sender?.name || "NEUMA"));
  if (message.recipientId) identity.append(node("span", "muted-note small", `→ ${message.recipientId}`));
  if (message.createdAt) { const time = node("time", "muted-note small", new Date(message.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })); time.dateTime = message.createdAt; identity.append(time); }
  const content = (isUser ? String(message.content || "") : String(message.content || "").replace(/#(?:group|agent)\/[\w-]+/g, "")).trim();
  row.append(identity);
  if (message.attachments?.length) {
    const attachments = node("div", "collaboration-links");
    for (const attachment of message.attachments) {
      const label = attachment.name || "已保存材料", link = node(attachmentUrl ? "a" : "span", "text-link small", `▧ ${label}`);
      if (attachmentUrl) { link.href = attachmentUrl(attachment.id); link.download = label; }
      attachments.append(link);
    }
    row.append(attachments);
  }
  row.append(node("div", "collaboration-message-body", content || (message.status === "running" ? "正在处理…" : "")));
  if (["failed", "error", "cancelled", "interrupted"].includes(message.status)) row.append(node("p", "muted-note small", taskLabels[message.status] || "回复未完成"));
  row.append(internalLinks(message.content, [...(message.actions || []), ...(message.sources || [])]));
  return row;
}
export function renderMessages(target, messages, selectedTask = "", members = []) {
  const atBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 100;
  target.replaceChildren();
  const visible = selectedTask ? messages.filter((message) => message.taskId === selectedTask) : messages;
  if (!visible.length) {
    const welcome = node("div", "collaboration-empty");
    welcome.append(node("span", "collaboration-empty-mark", "◎"), node("h2", "", "让不同能力在这里相遇"),
      node("p", "muted-note", "给出目标，成员会根据自己的能力讨论、认领并推进任务。你可以随时补充信息。"));
    target.append(welcome);
  }
  for (const message of visible) {
    const recipient = members.find((member) => member.id === message.recipientId);
    target.append(messageRow(recipient ? { ...message, recipientId: recipient.name } : message));
  }
  if (atBottom) target.scrollTop = target.scrollHeight;
}
export function renderMembers(target, members) {
  const opened = new Set([...target.children].filter((card) => card.open).map((card) => card.dataset.memberId));
  target.replaceChildren();
  for (const member of members) {
    const card = node("details", "group-member-card");
    card.dataset.memberId = member.id; card.open = opened.has(member.id);
    const summary = node("summary");
    summary.append(node("span", "collaboration-message-avatar", Array.from(member.name || "A")[0]), node("strong", "", member.name),
      node("span", `member-ready ${member.ready ? "" : "unavailable"}`, member.ready ? "可工作" : "未就绪"));
    card.append(summary, node("p", "muted-note small", member.description || "暂无简介"));
    for (const [key, label] of [["task", "擅长"], ["input", "需要输入"], ["output", "交付"], ["boundaries", "范围"]]) {
      const value = member[key]; if (!value) continue;
      const item = node("p", "group-capability"); item.append(node("strong", "", `${label}　`), node("span", "", Array.isArray(value) ? value.join("；") : typeof value === "object" ? JSON.stringify(value) : String(value))); card.append(item);
    }
    const link = node("a", "text-link small", "打开私聊"); link.href = `#agent/${encodeURIComponent(member.id)}`; card.append(link); target.append(card);
  }
  if (!members.length) target.append(node("p", "muted-note", "还没有加入成员，请编辑群组。"));
}
export function renderTasks(target, tasks, selected, { onSelect, onStop, members = [] }) {
  target.replaceChildren();
  if (!tasks.length) target.append(node("p", "muted-note", "从一项明确的任务开始。"));
  for (const task of [...tasks].reverse()) {
    const card = node("article", `group-task-card ${selected === task.id ? "selected" : ""}`);
    const select = button(task.goal || "协作任务", () => onSelect(task.id), "group-task-title");
    select.setAttribute("aria-pressed", String(selected === task.id));
    card.append(select, node("p", "group-task-status", [taskLabels[task.status] || task.status, taskLabels[task.phase] || task.phase].filter(Boolean).join(" · ")));
    for (const child of task.children || []) {
      const assignee = members.find((member) => member.id === child.assigneeId)?.name || child.assigneeId;
      card.append(node("p", "group-task-child", `${taskLabels[child.status] || child.status || "待认领"} · ${child.title}${assignee ? `（${assignee}）` : ""}`));
    }
    if (task.result || task.reason) card.append(node("p", "muted-note small", task.result || task.reason));
    if (!terminalTask(task)) card.append(button("停止任务", () => onStop(task.id), "text-link link-button"));
    target.append(card);
  }
}
