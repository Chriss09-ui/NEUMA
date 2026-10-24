import type { DisplayAgent } from "./ui-types.js";
import type { GroupMention, GroupMessageView, GroupTaskView, GroupConversationView, LinkAction, MemberView } from "./ui-api-types.js";
type MemberIdentity = DisplayAgent & { id: string };
import { renderRichText } from "./rich-text.js";
import { renderAgentAvatar, resolveAgentAvatar } from "./agent-avatar.js";

export const taskLabels: Record<string, string> = { queued: "等待认领", pending: "等待认领", running: "协作中", responding: "成员回应中", discussing: "正在讨论", planning: "正在分工",
  working: "正在处理", completed: "已完成", complete: "已完成", partial: "部分交付", failed: "失败", blocked: "等待处理", cancelled: "已停止", interrupted: "已中断",
  negotiating: "正在协商", negotiation: "成员协商", conversation: "对话", execution: "执行任务", integration: "整合成果", delivery: "交付成果",
  waiting: "等待成员回应", needs_input: "待你补充", declined: "未认领" };
export const terminalTask = (task: { status?: string | undefined } | null | undefined) => ["completed", "complete", "partial", "failed", "cancelled", "interrupted"].includes(task?.status!);

export function groupConversations(tasks: readonly GroupTaskView[] = []) {
  const conversations = new Map<string, GroupConversationView>();
  for (const [index, task] of tasks.entries()) {
    const id = task.conversationId || task.id;
    const previous = conversations.get(id);
    conversations.set(id, { ...task, id, taskId: task.id,
      goal: previous?.goal || task.goal, createdAt: previous?.createdAt || task.createdAt,
      tasks: [...(previous?.tasks || []), task], order: index });
  }
  return [...conversations.values()].sort((left, right) => {
    const leftTime = Date.parse(left.updatedAt || left.tasks.at(-1)?.createdAt || "");
    const rightTime = Date.parse(right.updatedAt || right.tasks.at(-1)?.createdAt || "");
    return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime
      ? leftTime - rightTime : left.order - right.order;
  });
}

export function conversationDate(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return { label: date.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" }), dateTime: date.toISOString() };
}

export function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") {
  const value = document.createElement(tag); value.className = className; value.textContent = text; return value;
}
export function button(label: string, action: () => unknown, className = "ghost-button") {
  const value = node("button", className, label); value.type = "button"; value.addEventListener("click", action); return value;
}
export function notice(target: HTMLElement, text: string | null | undefined, error = false) {
  target.textContent = text || ""; target.hidden = !text; target.classList.toggle("error", error);
}
export function internalLinks(content: unknown, actions: LinkAction[] = []) {
  const links = new Map<string, string>();
  for (const match of String(content || "").matchAll(/#(group|agent)\/([\w-]+)/g)) links.set(match[0], match[1] === "group" ? "打开群组" : "打开智能体");
  for (const action of actions) {
    const href = typeof action === "string" ? action : action?.href || action?.url || action?.sourceLink;
    if (/^#(?:create|chat|groups|(?:group|agent)\/[\w-]+)$/.test(href || "")) links.set(href!, (typeof action === "string" ? undefined : action?.label || action?.name)
      || (href!.startsWith("#group/") ? "打开群组" : href!.startsWith("#agent/") ? "打开智能体" : "打开工作区"));
    if (["create_agent", "create"].includes((typeof action === "string" ? undefined : action?.type)!)) links.set("#create", "创建智能体");
  }
  const row = node("div", "collaboration-links");
  for (const [href, label] of links) { const link = node("a", "text-link", label); link.href = href; row.append(link); }
  return row;
}
function agentIdentity(target: HTMLElement, agent: MemberIdentity) {
  target.dataset.agentId = agent.id;
  const avatar = resolveAgentAvatar(agent);
  if (avatar.type === "star") target.dataset.avatarColor = avatar.color;
}
function messageAvatar(agent: MemberIdentity, className: string) {
  const avatar = node("span", className);
  avatar.setAttribute("aria-hidden", "true");
  renderAgentAvatar(avatar, agent, { motion: false });
  return avatar;
}
function prependRecipient(body: HTMLElement, agent: MemberIdentity) {
  const mention = node("span", "group-message-mention group-agent-identity");
  agentIdentity(mention, agent); mention.setAttribute("aria-label", `@${agent.name}`); mention.title = `@${agent.name}`;
  mention.append(messageAvatar(agent, "group-mention-avatar"), node("span", "group-mention-name", agent.name));
  const first = body.firstElementChild;
  if (first?.tagName === "P") first.prepend(mention, document.createTextNode(" "));
  else {
    const opening = node("p"); opening.append(mention); body.prepend(opening);
  }
}
function recipientPrefix(content: string, name: string) {
  const prefix = `@${name}`;
  if (!content.startsWith(prefix) || !/^(?:[\s，,：:、]|$)/u.test(content.slice(prefix.length))) return null;
  let remainder = content.slice(prefix.length).replace(/^[\s，,：:、]+/u, "");
  if (remainder.startsWith(name) && /^(?:[\s，,：:、]|$)/u.test(remainder.slice(name.length))) {
    remainder = remainder.slice(name.length).replace(/^[\s，,：:、]+/u, "");
  }
  return remainder;
}
function leadingRecipient(content: string, members: MemberIdentity[]) {
  const matches = members.filter((member): member is MemberIdentity & { name: string } => Boolean(member.id) && member.id !== "main" && typeof member.name === "string"
    && Boolean(member.name) && recipientPrefix(content, member.name) !== null);
  const longest = Math.max(0, ...matches.map((member) => member.name.length));
  const exact = matches.filter((member) => member.name.length === longest);
  return new Set(exact.map((member) => member.id)).size === 1 ? exact[0] : null;
}
function renderUserMentions(body: HTMLElement, content: string, mentions: GroupMention[] | undefined, members: MemberIdentity[]) {
  const ranges = Array.isArray(mentions) ? [...mentions].sort((a, b) => a.start - b.start) : [];
  let cursor = 0;
  for (const mention of ranges) {
    if (!Number.isInteger(mention.start) || !Number.isInteger(mention.end) || mention.start < cursor || mention.end <= mention.start
      || mention.end > content.length || typeof mention.text !== "string" || !mention.text.startsWith("@")
      || content.slice(mention.start, mention.end) !== mention.text) continue;
    const member = members.find((member) => member.id === mention.memberId);
    if (!member) continue;
    body.append(document.createTextNode(content.slice(cursor, mention.start)));
    const identity = node("span", "group-message-mention group-user-mention group-agent-identity");
    agentIdentity(identity, member); identity.title = mention.text; identity.setAttribute("aria-label", mention.text);
    identity.append(messageAvatar(member, "group-mention-avatar"), node("span", "group-mention-name", mention.text));
    body.append(identity); cursor = mention.end;
  }
  if (cursor) body.append(document.createTextNode(content.slice(cursor)));
  else body.textContent = content;
}
export function messageRow(message: GroupMessageView, { attachmentUrl, bubble = false, senderAgent, recipientAgent, recipientNames = [], members = [] }: { attachmentUrl?: ((id: string) => string) | undefined; bubble?: boolean | undefined; senderAgent?: MemberIdentity | null | undefined; recipientAgent?: MemberIdentity | null | undefined; recipientNames?: (string | undefined)[] | undefined; members?: MemberIdentity[] | undefined } = {}) {
  const isUser = message.sender?.type === "user" || message.role === "user";
  const showAgent = bubble && !isUser && senderAgent && message.sender?.type === "agent";
  const row = node("article", bubble ? `message ${isUser ? "user" : "assistant"}` : `collaboration-message ${isUser ? "is-user" : ""}`);
  if (showAgent) {
    row.classList.add("group-agent-message");
    const name = node("span", "group-message-sender group-agent-identity", senderAgent.name);
    agentIdentity(name, senderAgent);
    row.append(messageAvatar(senderAgent, "group-message-avatar"), name);
  }
  row.dataset.messageId = message.id || "";
  if (bubble) {
    row.setAttribute("role", "group"); row.setAttribute("aria-label", isUser ? "发送的消息" : "助理的回复");
  } else {
    const identity = node("div", "collaboration-message-heading");
    identity.append(node("span", "collaboration-message-avatar", isUser ? "我" : Array.from(message.sender?.name || "NEUMA")[0]!),
      node("strong", "", isUser ? "你" : message.sender?.name || "NEUMA"));
    if (message.recipientId) identity.append(node("span", "muted-note small", `→ ${message.recipientId}`));
    if (message.createdAt) { const time = node("time", "muted-note small", new Date(message.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })); time.dateTime = message.createdAt; identity.append(time); }
    row.append(identity);
  }
  let content = (isUser ? String(message.content || "") : String(message.content || "").replace(/#(?:group|agent)\/[\w-]+/g, "")).trim();
  if (showAgent && recipientAgent) {
    const names = [...new Set([recipientAgent.name, ...recipientNames])].filter((name): name is string => Boolean(name)).sort((left, right) => right.length - left.length);
    for (const name of names) {
      const remainder = recipientPrefix(content, name);
      if (remainder !== null) { content = remainder; break; }
    }
  }
  if (message.attachments?.length) {
    const attachments = node("div", "collaboration-links");
    for (const attachment of message.attachments) {
      const label = attachment.name || "已保存材料", link = node(attachmentUrl ? "a" : "span", "text-link small", `▧ ${label}`);
      if (attachmentUrl) { (link as HTMLAnchorElement).href = attachmentUrl(attachment.id); (link as HTMLAnchorElement).download = label; }
      attachments.append(link);
    }
    row.append(attachments);
  }
  const body = node("div", bubble ? "bubble" : "collaboration-message-body");
  const displayedContent = content || (message.status === "running" ? "正在处理…" : "");
  const showRecipient = showAgent && recipientAgent && Boolean(String(message.content || "").trim());
  if (isUser) renderUserMentions(body, displayedContent, message.mentions, members);
  else renderRichText(body, displayedContent);
  if (showRecipient) prependRecipient(body, recipientAgent);
  if (bubble) {
    body.hidden = !content && !showRecipient && message.status !== "running";
    body.classList.toggle("streaming", message.status === "running" && Boolean(content));
  }
  row.append(body);
  if (["failed", "error", "cancelled", "interrupted"].includes(message.status!)) row.append(node("p", "muted-note small", taskLabels[message.status!] || "回复未完成"));
  row.append(internalLinks(message.content, [...(message.actions || []), ...(message.sources || [])]));
  return row;
}
export function renderMessages(target: HTMLElement, messages: GroupMessageView[], selectedTask = "", members: MemberView[] = [], tasks: GroupTaskView[] = []) {
  const atBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 100;
  target.replaceChildren();
  const conversation = groupConversations(tasks).find((item) => item.id === selectedTask
    || item.tasks.some((task) => task.id === selectedTask));
  const taskIds = new Set(conversation?.tasks.map((task) => task.id) || [selectedTask]);
  const visible = messages.filter((message) => message.visibility !== "internal" && (!selectedTask || taskIds.has(message.taskId!)));
  if (!visible.length) {
    const welcome = node("div", "collaboration-empty");
    welcome.append(node("span", "collaboration-empty-mark", "◎"), node("h2", "", "让不同能力在这里相遇"),
      node("p", "muted-note", "说说你想完成什么，成员会为你处理并在这里回复结果。需要补充信息时也会直接问你。"));
    target.append(welcome);
  }
  const date = conversationDate(visible[0]?.createdAt);
  if (date) {
    const time = node("time", "conversation-date", date.label);
    time.dateTime = date.dateTime; target.append(time);
  }
  for (const message of visible) {
    const isUser = message.sender?.type === "user" || message.role === "user";
    const sender = isUser ? "你" : message.sender?.name || members.find((member) => member.id === message.sender?.id)?.name || "NEUMA";
    const senderAgent = message.sender?.type === "agent"
      ? { ...members.find((member) => member.id === message.sender!.id), id: message.sender!.id, name: sender } : null;
    const participants = tasks.find((task) => task.id === message.taskId)?.participants || [];
    const knownMembers = [...members, ...participants];
    const legacyRecipient = !message.recipientId && message.sender?.type === "agent"
      ? leadingRecipient(String(message.content || "").trim(), knownMembers) : null;
    const recipientAgent = !message.recipientId ? legacyRecipient : message.recipientId === "main" ? null
      : members.find((member) => member.id === message.recipientId)
        || participants.find((member) => member.id === message.recipientId)
        || messages.find((item) => item.sender?.type === "agent" && item.sender.id === message.recipientId)?.sender;
    const recipient = recipientAgent?.name || message.recipientId;
    const isMention = !isUser && Boolean(senderAgent);
    const recipientNames = knownMembers.filter((member) => member.id === recipientAgent?.id).map((member) => member.name);
    const row = messageRow(message, { bubble: true, senderAgent, recipientAgent, recipientNames, members: knownMembers });
    row.setAttribute("aria-label", `${sender}发送的消息${recipient ? isMention ? `，提及${recipient}` : `，定向发送给${recipient}` : ""}`);
    row.setAttribute("title", `${sender}${recipient ? isMention ? ` · @${recipient}` : ` → ${recipient}` : ""}`);
    target.append(row);
  }
  if (atBottom) target.scrollTop = target.scrollHeight;
}
export function renderMembers(target: HTMLElement, members: MemberView[]) {
  const opened = new Set(([...target.children] as HTMLDetailsElement[]).filter((card) => card.open).map((card) => card.dataset.memberId));
  target.replaceChildren();
  for (const member of members) {
    const card = node("details", "group-member-card");
    card.dataset.memberId = member.id; card.open = opened.has(member.id);
    const summary = node("summary");
    const avatar = node("span", "collaboration-message-avatar group-member-avatar");
    avatar.setAttribute("aria-hidden", "true"); renderAgentAvatar(avatar, member);
    summary.append(avatar, node("strong", "", member.name),
      node("span", `member-ready ${member.ready ? "" : "unavailable"}`, member.ready ? "可工作" : "未就绪"));
    card.append(summary, node("p", "muted-note small", member.description || "暂无简介"));
    for (const [key, label] of [["task", "擅长"], ["input", "需要输入"], ["output", "交付"], ["boundaries", "范围"]] as const) {
      const value = member[key]; if (!value) continue;
      const item = node("p", "group-capability"); item.append(node("strong", "", `${label}　`), node("span", "", Array.isArray(value) ? value.join("；") : typeof value === "object" ? JSON.stringify(value) : String(value))); card.append(item);
    }
    const link = node("a", "text-link small", "打开私聊"); link.href = `#agent/${encodeURIComponent(member.id)}`; card.append(link); target.append(card);
  }
  if (!members.length) target.append(node("p", "muted-note", "还没有加入成员，请编辑群组。"));
}
export function renderTasks(target: HTMLElement, tasks: GroupTaskView[], selected: string, { onSelect, onStop, members = [] }: { onSelect: (id: string) => unknown; onStop: (id: string) => unknown; members?: MemberIdentity[] | undefined }) {
  target.replaceChildren();
  if (!tasks.length) target.append(node("p", "muted-note", "从一项明确的任务开始。"));
  for (const task of [...tasks].reverse()) {
    const isSelected = selected === (task.conversationId || task.id);
    const card = node("article", `group-task-card ${isSelected ? "selected" : ""}`);
    const select = button(task.goal || "协作任务", () => onSelect(task.id), "group-task-title");
    select.setAttribute("aria-pressed", String(isSelected));
    card.append(select, node("p", "group-task-status", [taskLabels[task.status] || task.status, taskLabels[task.phase!] || task.phase].filter(Boolean).join(" · ")));
    for (const child of task.children || []) {
      const assignee = members.find((member) => member.id === child.assigneeId)?.name || child.assigneeId;
      card.append(node("p", "group-task-child", `${taskLabels[child.status] || child.status || "待认领"} · ${child.title}${assignee ? `（${assignee}）` : ""}`));
    }
    if (task.result || task.reason) card.append(node("p", "muted-note small", task.result || task.reason));
    if (!terminalTask(task)) card.append(button("停止任务", () => onStop(task.id), "text-link link-button"));
    target.append(card);
  }
}
