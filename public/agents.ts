import type { AgentProfile, AgentRequirement, Message, RuntimeOperation, RuntimeResult, RuntimeState } from "./ui-types.js";
import type { HistoryItem } from "./agent-conversations.js";
import type { UiRoute } from "./browser-events.js";
interface AgentOperation extends RuntimeOperation { kind: string; sourceKey: string; cancelPromise?: Promise<RuntimeResult> | undefined; development?: boolean | undefined }
interface AgentState extends RuntimeState { sourceKey: string; sequence: number; inspectionError: boolean; rebuildRequested: boolean; error: string; buildError: string; label: string; operation: AgentOperation | null }
type SidebarHistory = ReturnType<typeof createSidebarHistory<HistoryItem>>;
import { pageElement, type PageElements } from "./page-elements.js";
import { errorInfo } from "./ui-types.js";
import { agentDisplayDescription, agentDisplayName, deleteAgentPreview } from "./state.js";
import { AgentConversationHistory } from "./agent-conversations.js";
import { AgentAttachments, createAgentAttachmentView } from "./agent-attachments.js";
import { addUserMessage, createReplyView, renderUserMessage } from "./chat-ui.js";
import { agentBuildState, agentDevelopmentState, agentHistory, agentSourceKey, createAgentRuntime, developmentPhases } from "./agent-runtime.js";
import { createDevelopmentView } from "./agent-details-view.js";
import type { AgentMakingView } from "./agent-build-view.js";
import { agentMakingState, createAgentMakingView, rememberArchitectureThought } from "./agent-build-view.js";
import { avatarColors, installAvatarMotion, renderAgentAvatar, resolveAgentAvatar, setAgentAvatarActivity } from "./agent-avatar.js";
import { conversationDate } from "./group-view.js";
import { createSidebarHistory } from "./sidebar-history.js";
import { getApplicationContext } from "./application-context.js";

installAvatarMotion(document, window);

let storage: Storage | null;
try { storage = window.localStorage; } catch { storage = null; }
let agents: AgentRequirement[] = [];
let mainBusy = false;
let route: UiRoute = { page: "chat", agentId: null, groupId: null };
const runtimes = new Map<string, AgentState>(), inputs = new Map<string, string>();
const sidebarAvatars = new Map<string, { mark: HTMLElement; status: HTMLElement; restingLabel: string }>(), sidebarHistories = new Map<string, SidebarHistory>(), collapsedAvatars = new Map<string, { link: HTMLAnchorElement; mark: HTMLElement }>();
const avatarActivityLabels: Record<string, string> = { thinking: "正在思考…", working: "正在工作…", queued: "等待开始…" };
const profileVersions = new Map<string, number>(), broadcasting = new Set<string>();
let profilesError = "";
let developmentView: (ReturnType<typeof createDevelopmentView<HTMLElement & {open?:boolean}>> & { agentId: string }) | null = null;
let makingView: (AgentMakingView & { agentId: string }) | null = null;
let inspectionTimer: number | null = null;
let activeInspections = 0;
const inspectionWaiters: (() => void)[] = [];
const api = createAgentRuntime();
const attachments = new AgentAttachments({ api, onChange(id, cid) {
  if (!visible(id) || !current() || (cid && conversation(id).id !== cid)) return;
  if (!cid) renderMessages(current()!);
  renderControls(current()!);
} });
const history = new AgentConversationHistory({ api, storage, exists: (id) => agents.some((agent) => agent.id === id),
  onChange(id, messagesChanged = false) {
    const agent = agents.find((entry) => entry.id === id);
    if (agent) renderHistory(agent);
    if (!visible(id) || !current()) return;
    if (messagesChanged) renderMessages(current()!);
    renderControls(current()!);
    const item = conversation(id);
    renderConversationDate(item);
    byId("agent-conversation-title").textContent = item.messages.length || item.saveVersion ? item.title : agentDisplayName(current());
    renderStorageNote(current()!);
  } });
const conversations = history.active;
const switchRequests = new Map<string, number>();
const byId = <K extends keyof PageElements>(id: K) => pageElement(document, id);
const input = byId("agent-message");
const current = () => agents.find((item) => item.id === route.agentId);
const visible = (id: string | null, conversation?: HistoryItem) => route.page === "agent" && route.agentId === id
  && (!conversation || conversations.get(id!) === conversation);
const attachmentView = createAgentAttachmentView({ document, api, attachments, onChange(id) {
  if (visible(id) && current()) renderMessages(current()!);
} });

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text: string | undefined) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text!;
  return node;
}

function action(action: string, id = route.agentId) {
  document.dispatchEvent(new CustomEvent("neuma:agent-action", { detail: { action, id } }));
}

function conversation(id: string) {
  return history.current(id);
}

function savedInput(id: string, cid = conversation(id).id) {
  return inputs.get(cid) ?? history.state(id).items.get(cid)?.inputDraft ?? "";
}

function rememberInput(id: string, item: HistoryItem, value: string) {
  inputs.set(item.id, value);
  history.saveInput(id, item, value);
}

async function loadConversation(agent: AgentRequirement) {
  const state = history.state(agent.id), previous = conversation(agent.id), selection = state.selection;
  await history.load(agent);
  const selected = conversation(agent.id);
  if (history.states.get(agent.id) !== state || state.selection !== selection || selected === previous
    || previous.messages.length || previous.saveVersion) return;
  const draft = visible(agent.id) ? input.value : savedInput(agent.id, previous.id);
  if (draft && !savedInput(agent.id, selected.id)) {
    rememberInput(agent.id, selected, draft);
    inputs.delete(previous.id); history.saveInput(agent.id, previous, "");
  }
  if (visible(agent.id)) { input.value = savedInput(agent.id, selected.id); input.dispatchEvent(new Event("input")); }
}

let historyMenu: { agentId: string; conversationId: string; trigger: HTMLButtonElement; row: HTMLElement } | null = null;
const historyActionErrors = new Map<string, string>();

function closeHistoryMenu(restoreFocus = false) {
  if (!historyMenu) return;
  const { trigger, row } = historyMenu;
  historyMenu = null;
  byId("agent-history-menu").hidden = true;
  trigger.setAttribute("aria-expanded", "false");
  row.classList.remove("has-open-menu");
  if (restoreFocus) trigger.focus({ preventScroll: true });
}

function openHistoryMenu(agentId: string, item: HistoryItem, trigger: HTMLButtonElement, row: HTMLElement, focusItem = false) {
  const wasOpen = historyMenu?.trigger === trigger;
  closeHistoryMenu();
  if (wasOpen || item.deleting) return;
  const menu = byId("agent-history-menu"), remove = byId("agent-history-delete");
  historyMenu = { agentId, conversationId: item.id, trigger, row };
  trigger.setAttribute("aria-expanded", "true");
  row.classList.add("has-open-menu");
  remove.setAttribute("aria-label", `删除对话：${item.title}`);
  menu.setAttribute("aria-label", `对话操作：${item.title}`);
  menu.hidden = false;
  const anchor = trigger.getBoundingClientRect(), height = menu.getBoundingClientRect().height;
  const below = anchor.bottom + 4;
  menu.style.left = `${Math.max(8, anchor.right - 152)}px`;
  menu.style.top = `${Math.max(8, below + height <= window.innerHeight - 8 ? below : anchor.top - height - 4)}px`;
  if (focusItem) remove.focus({ preventScroll: true });
}

function historyDate(date: Date, today: Date) {
  if (!Number.isFinite(date.getTime())) return { group: "更早", label: "" };
  const day = new Date(date); day.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const week = new Date(today); week.setDate(today.getDate() - 6);
  const group = day.getTime() === today.getTime() ? "今天" : day.getTime() === yesterday.getTime() ? "昨天"
    : day >= week && day < today ? "近7天"
      : `${date.getFullYear() === today.getFullYear() ? "" : `${date.getFullYear()}年`}${date.getMonth() + 1}月`;
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return { group, label: group === "今天" || group === "昨天" ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}` };
}

function renderHistory(agent: AgentRequirement) {
  const view = sidebarHistories.get(agent.id);
  if (!view) return;
  const state = history.state(agent.id), selected = conversation(agent.id), records = history.records(agent.id);
  if (historyMenu?.agentId === agent.id) closeHistoryMenu(true);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  view.update({ records, active: visible(agent.id), status: state.loading ? "正在读取历史对话…" : state.error
    || historyActionErrors.get(agent.id) || (!records.length ? "还没有对话" : ""),
    renderRow(item) {
      const stamp = historyDate(new Date(item.updatedAt!), today);
      const row = element("div", "agent-history-row", "");
      row.classList.toggle("is-current", visible(agent.id) && item === selected);
      const select = element("button", "agent-history-select", "");
      select.type = "button"; select.dataset.conversationId = item.id;
      select.setAttribute("aria-label", `打开对话：${item.title}${item.pendingSync ? "，待同步" : ""}`);
      if (visible(agent.id) && item === selected) select.setAttribute("aria-current", "true");
      select.title = `${item.title}${stamp.label ? ` · ${stamp.label}` : ""}${item.pendingSync ? " · 待同步" : ""}`;
      select.append(element("span", "agent-history-title", item.title), element("span", "agent-history-time",
        `${stamp.label}${item.pendingSync ? " · 待同步" : ""}`));
      select.disabled = item.deleting;
      select.addEventListener("click", () => selectConversation(agent.id, item.id));
      const more = element("button", "agent-history-more", "");
      more.type = "button"; more.dataset.conversationId = item.id; more.disabled = item.deleting;
      more.setAttribute("aria-label", `对话操作：${item.title}`); more.title = "更多操作";
      more.setAttribute("aria-haspopup", "menu"); more.setAttribute("aria-expanded", "false");
      more.setAttribute("aria-controls", "agent-history-menu");
      const dots = element("span", "agent-history-more-icon", ""); dots.setAttribute("aria-hidden", "true"); more.append(dots);
      more.addEventListener("click", () => openHistoryMenu(agent.id, item, more, row));
      more.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        if (historyMenu?.trigger === more) byId("agent-history-delete").focus({ preventScroll: true });
        else openHistoryMenu(agent.id, item, more, row, true);
      });
      row.append(select, more); return row;
    },
  });
}

async function stopConversation(id: string, item = conversation(id)) {
  const operation = item.turn;
  if (!operation) return;
  operation.controller.abort();
  operation.reply.status = "stopped";
  operation.reply.error = "本轮任务未完成，已显示的内容保留。";
  const user = item.messages[item.messages.indexOf(operation.reply) - 1];
  if (user?.role === "user") { user.delivery = "stopped"; attachments.restore(id, item.id, user.attachments); }
  item.turn = item.replyView = null;
  syncAvatarActivity(agents.find((agent) => agent.id === id));
  void history.changed(id, item, { immediate: true });
  if (visible(id, item) && current()) { renderMessages(current()!); renderControls(current()!); }
  try { await api.cancel(item.sessionId); }
  catch (caught) { const error = errorInfo(caught); item.error = error.message || "停止请求未确认，请稍后重试。"; }
}

async function selectConversation(id: string, cid: string) {
  if (!agents.some((agent) => agent.id === id)) return;
  if (!visible(id)) document.dispatchEvent(new CustomEvent("neuma:navigate", { detail: { page: "agent", agentId: id } }));
  if (!visible(id)) return;
  if (conversation(id).id === cid) { input.focus({ preventScroll: true }); return; }
  const sequence = (switchRequests.get(id) || 0) + 1;
  switchRequests.set(id, sequence);
  const previous = conversation(id);
  rememberInput(id, previous, input.value);
  await stopConversation(id, previous);
  if (!visible(id) || switchRequests.get(id) !== sequence) return;
  await history.select(id, cid);
  if (!visible(id) || switchRequests.get(id) !== sequence || conversation(id).id !== cid) return;
  input.value = savedInput(id, cid);
  input.dispatchEvent(new Event("input"));
  renderWorkspace(); input.focus();
}

async function deleteConversation(id: string, cid: string) {
  const item = history.state(id).items.get(cid);
  if (!item || !window.confirm(`删除“${item.title}”？删除后无法恢复对话，已生成的文件仍可在产物中查看。`)) return;
  historyActionErrors.delete(id);
  const selected = conversation(id) === item;
  await stopConversation(id, item);
  if (!await history.remove(id, cid)) {
    if (history.state(id).items.get(cid) === item) {
      historyActionErrors.set(id, `未能删除“${item.title}”：${item.storageError || "删除失败，请重试。"}`);
      const agent = agents.find((entry) => entry.id === id); if (agent) renderHistory(agent);
    }
    return;
  }
  inputs.delete(cid);
  attachments.clear(id, cid);
  if (selected && visible(id)) { input.value = savedInput(id); input.dispatchEvent(new Event("input")); input.focus(); }
}

function runtime(agent: AgentRequirement) {
  if (!runtimes.has(agent.id)) runtimes.set(agent.id, {
    status: "unchecked", sourceKey: agentSourceKey(agent), definition: null, architecture: null, development: null, operation: null, inspection: null, sequence: 0,
    error: "", buildError: "", label: "", inspectionError: false, rebuildRequested: false, application: null,
  });
  return runtimes.get(agent.id)!;
}

function showError(text = "") {
  byId("agent-error").textContent = text;
  byId("agent-error").hidden = !text;
}

function avatarActivity(agent: AgentRequirement) {
  const state = runtime(agent), turn = conversations.get(agent.id)?.turn;
  if (turn) return turn.controller.signal.aborted || ["complete", "error", "stopped"].includes(turn.reply.status!)
    ? "idle" : turn.avatarActivity || "thinking";
  if (state.operation?.controller.signal.aborted || state.operation?.stopping) return "idle";
  if (agentDevelopmentState(agent, state).active || state.operation?.development || state.operation?.kind?.startsWith("development")) return "working";
  if (state.operation?.kind === "build" || ["building", "designing", "evaluating"].includes(state.status)) return "thinking";
  return "idle";
}

function syncAvatarActivity(agent: AgentRequirement | undefined) {
  if (!agent) return;
  const activity = avatarActivity(agent), sidebar = sidebarAvatars.get(agent.id);
  if (sidebar) {
    setAgentAvatarActivity(sidebar.mark, activity);
    sidebar.status.textContent = avatarActivityLabels[activity] || sidebar.restingLabel;
    sidebar.status.hidden = runtime(agent).status === "ready" && activity === "idle";
  }
  setAgentAvatarActivity(collapsedAvatars.get(agent.id)?.mark, activity);
  if (visible(agent.id)) setAgentAvatarActivity(byId("agent-icon"), activity);
}

function renderCollapsedAgents() {
  const rail = byId("sidebar-agent-rail"), shown = [...sidebarHistories.keys()]
    .map((id) => agents.find((agent) => agent.id === id)).filter((agent): agent is AgentRequirement => Boolean(agent));
  for (const [id, view] of collapsedAvatars) if (!shown.some((agent) => agent.id === id)) {
    if (view.link.contains(document.activeElement)) byId("sidebar-toggle").focus({ preventScroll: true });
    view.link.remove(); collapsedAvatars.delete(id);
  }
  rail.hidden = !shown.length;
  for (const [index, agent] of shown.entries()) {
    let view = collapsedAvatars.get(agent.id);
    if (!view) {
      const link = element("a", "collapsed-agent-link", ""), mark = element("span", "collapsed-agent-avatar agent-avatar", "");
      link.href = `#agent/${encodeURIComponent(agent.id)}`; link.dataset.agentId = agent.id;
      mark.setAttribute("aria-hidden", "true"); link.append(mark);
      link.addEventListener("click", (event) => {
        if (event.defaultPrevented || (event.button ?? 0) !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        document.dispatchEvent(new CustomEvent("neuma:navigate", { detail: { page: "agent", agentId: agent.id } }));
      });
      view = { link, mark }; collapsedAvatars.set(agent.id, view);
    }
    const name = agentDisplayName(agent);
    view.link.title = name; view.link.setAttribute("aria-label", `打开${name}的对话`);
    if (visible(agent.id)) view.link.setAttribute("aria-current", "page"); else view.link.removeAttribute("aria-current");
    renderAgentAvatar(view.mark, agent, { activity: avatarActivity(agent) });
    if (rail.children[index] !== view.link) {
      const focused = view.link === document.activeElement;
      rail.insertBefore(view.link, rail.children[index] ?? null);
      if (focused) view.link.focus({ preventScroll: true });
    }
  }
}

function renderSidebar() {
  const list = byId("sidebar-agent-list");
  for (const [id, view] of sidebarHistories) if (!agents.some((agent) => agent.id === id)) {
    if (historyMenu?.agentId === id) closeHistoryMenu();
    view.root.remove(); sidebarHistories.delete(id); sidebarAvatars.delete(id);
  }
  byId("sidebar-agents-empty").hidden = agents.length > 0;
  byId("sidebar-create-agent").disabled = mainBusy;
  for (const agent of agents) {
    let view = sidebarHistories.get(agent.id);
    const name = agentDisplayName(agent);
    if (!view) {
      const mark = element("span", "agent-avatar", ""); mark.setAttribute("aria-hidden", "true");
      view = createSidebarHistory<HistoryItem>({ document, storage, id: `sidebar-agent-history-${agent.id}`, title: name,
        href: `#agent/${encodeURIComponent(agent.id)}`, icon: mark, className: "sidebar-agent",
        onExpand(open) { if (!open && historyMenu?.agentId === agent.id) closeHistoryMenu(); if (open) return loadConversation(agent); },
      });
      sidebarHistories.set(agent.id, view); list.append(view.root);
      const status = element("small", "sidebar-agent-status", "");
      view.link.append(status); sidebarAvatars.set(agent.id, { mark, status, restingLabel: "" });
      if (view.expanded) void loadConversation(agent);
    }
    const avatar = sidebarAvatars.get(agent.id)!, state = runtime(agent);
    renderAgentAvatar(avatar.mark, agent, { activity: avatarActivity(agent) });
    const statusLabel: Record<string, string> = { building: "正在设计与检查", designing: "正在设计", evaluating: "正在评估", developing: "研发进行中",
      needs_changes: "方案待调整", needs_evidence: "待补充依据", needs_connection: "待连接能力",
      needs_development: "需要研发", infeasible: "方案不可行", failed: "处理失败", cancelled: "已停止",
      blocked: "尚未就绪", stale: "需求已更新 · 待生成", unchecked: "正在读取状态", checking: "正在读取状态",
      error: state.inspectionError ? "状态读取失败" : "处理失败" };
    avatar.restingLabel = state.status === "ready" ? "可以运行" : statusLabel[state.status] || "待生成";
    avatar.status.textContent = avatarActivityLabels[avatarActivity(agent)] || avatar.restingLabel;
    avatar.status.hidden = state.status === "ready" && avatarActivity(agent) === "idle";
    view.update({ title: name }); view.link.title = `${name} · ${avatar.status.textContent}`; renderHistory(agent);
  }
  renderCollapsedAgents();
}

function renderConversationDate(item: HistoryItem) {
  const container = byId("agent-messages"), date = item.messages.length ? conversationDate(item.createdAt) : null;
  let label = container.querySelector(".conversation-date");
  if (!date) { label?.remove(); return; }
  if (!label) {
    label = element("time", "conversation-date", date.label);
    container.prepend(label);
  }
  if (label.textContent !== date.label) label.textContent = date.label;
  if (label.getAttribute("datetime") !== date.dateTime) label.setAttribute("datetime", date.dateTime);
}

function renderMessages(agent: AgentRequirement) {
  const container = byId("agent-messages"), item = conversation(agent.id);
  container.replaceChildren();
  item.replyView = null;
  item.userRows = new Map();
  renderConversationDate(item);
  attachments.hydrate(agent.id, item.messages.flatMap((message) => message.role === "user" ? message.attachments || [] : []));
  if (!item.messages.length) {
    const welcome = element("div", "welcome", "");
    const mark = element("span", "welcome-mark", "");
    renderAgentAvatar(mark, agent);
    welcome.append(mark,
      element("strong", "", `这里是「${agentDisplayName(agent)}」的对话`),
      element("p", "", agentDisplayDescription(agent)),
      element("p", "muted-note", runtime(agent).status === "ready"
        ? "输入一项任务，让这个智能体开始处理。" : "设计与检查通过，并生成可用的智能体后，就可以在这里执行任务。"));
    container.append(welcome);
  }
  for (const message of item.messages) {
    if (message.role === "user") {
      const row = userRow(agent.id, item, message);
      item.userRows!.set(message, row);
      container.append(row);
    }
    else {
      const view = createReplyView(agentDisplayName(agent));
      view.update(message);
      container.append(view.row);
      if (message === item.turn?.reply) item.replyView = view;
    }
  }
  container.scrollTop = container.scrollHeight;
}

function userRow(id: string, item: HistoryItem, message: Message) {
  return renderUserMessage(message, input, {
    attachmentLabel: (ref) => attachments.material(id, ref.id)?.name || "已保存的附件",
    attachmentInfo: (ref) => attachments.material(id, ref.id),
    onAttachment: (ref) => { if (visible(id, item)) return attachmentView.showPreview(id, ref.id); },
    onRecover: (user) => { if (visible(id, item)) attachments.restore(id, item.id, user.attachments); },
  });
}

function renderControls(agent: AgentRequirement) {
  syncAvatarActivity(agent);
  const state = runtime(agent), item = conversation(agent.id), operation = state.operation || item.turn;
  const development = agentDevelopmentState(agent, state);
  const library = history.state(agent.id);
  const busy = Boolean(operation || serverOperationPending(agent, state) || item.loading
    || (library.loading && library.selection === library.loading.selection) || item.deleting
    || (!item.loaded && item.saveVersion));
  byId("agent-runtime-status").textContent = state.status === "building" ? state.label || "正在设计与检查…"
    : state.status === "ready" && item.turn ? "正在处理任务…"
      : state.status === "stale" ? "需求已更新，请重新生成后继续任务。"
        : state.status === "checking" || state.status === "unchecked" ? "正在读取智能体…"
          : state.status === "error" ? "生成未完成，可以重试。" : state.label || "需求已确认，点击生成智能体开始设计与检查。";
  if (profilesError) byId("agent-runtime-status").textContent += " · 名称与图标暂时未加载";
  byId("agent-build").disabled = busy || state.status === "checking" || state.architecture?.designRecovery?.status === "blocked";
  byId("agent-build").textContent = state.status === "building" ? "正在生成…" : state.architecture?.designRecovery
    ? agentMakingState(agent, state).actionLabel : state.definition ? "重新生成智能体" : "生成智能体";
  byId("agent-send").hidden = Boolean(operation);
  byId("agent-send").disabled = state.status !== "ready" || busy || attachments.blocked(agent.id, item.id);
  attachmentView.setContext({ agentId: agent.id, conversationId: item.id, disabled: state.status !== "ready" || busy });
  byId("agent-cancel-reply").hidden = !operation || Boolean(operation.kind?.startsWith("development") || operation.development);
  byId("agent-cancel-reply").disabled = Boolean(operation?.controller.signal.aborted);
  byId("agent-chat-form").setAttribute("aria-busy", String(busy));
  byId("agent-chat-save-status").textContent = item.messages.length
    ? item.saving ? "保存中" : item.pendingSync ? "待同步" : item.saved ? "已保存" : "自动保存" : "自动保存";
  byId("agent-chat-save-status").hidden = !item.storageError;
  byId("agent-chat-save-status").dataset.error = String(Boolean(item.storageError));
  byId("agent-chat-retry").hidden = !item.storageError && !library.error;
  byId("agent-chat-retry").disabled = Boolean(item.saving || item.loading || library.loading || item.conflict);
  byId("agent-chat-fork").hidden = !item.conflict;
  byId("agent-chat-fork").disabled = Boolean(item.turn || item.deleting);
  byId("agent-save-actions").hidden = !item.storageError && !library.error && !item.conflict;
  byId("agent-new-chat").disabled = Boolean(item.deleting);
  showError(item.error || item.storageError || state.error);
  renderDevelopment(agent, development);
  renderMaking(agent);
  broadcastRuntime(agent);
  scheduleInspection(agent);
}

function renderMaking(agent: AgentRequirement) {
  const state = runtime(agent), active = Boolean(state.activeRuntime), updateAvailable = active && Boolean(state.updateStatus || state.operation);
  const toggle = byId("agent-upgrade-toggle");
  toggle.hidden = !updateAvailable;
  if (!updateAvailable) state.showUpgrade = false;
  toggle.textContent = state.showUpgrade ? "返回当前版本" : "查看更新进度";
  toggle.setAttribute("aria-expanded", String(Boolean(state.showUpgrade)));
  toggle.title = state.operation ? "当前版本保留；更新期间暂时停止提交新任务。" : "查看最近一次更新的进度和结果。";
  const showingUpdate = updateAvailable && Boolean(state.showUpgrade);
  const making = showingUpdate || !active && state.status !== "ready" && !state.application?.pageReady && !conversation(agent.id).turn;
  byId("agent-making-panel").hidden = !making;
  byId("agent-conversation").hidden = making;
  byId("agent-conversation-actions").hidden = making;
  byId("agent-workspace").classList.toggle("is-making", making && !showingUpdate);
  byId("agent-workspace").classList.toggle("showing-update", showingUpdate);
  if (!making) { byId("agent-making-content").replaceChildren(); makingView = null; return; }
  const focused = makingView?.agentId === agent.id
    ? (["stop", "start", "details"] as const).find((key) => makingView![key] === document.activeElement) : null;
  const thoughtsOpen = makingView?.agentId === agent.id ? Boolean(makingView.thoughts?.open) : false;
  const progressState = showingUpdate ? { ...state, ...agentBuildState(agent, { agent: state.definition, architecture: state.architecture, development: state.development }) } : state;
  makingView = { ...createAgentMakingView(agent, progressState, {
    onStop: () => stopMaking(agent.id),
    onStart: () => {
      const development = agentDevelopmentState(agent, state);
      return development.canStart || development.canResume ? developAgent(agent.id)
        : buildAgent(agent.id, false, progressState.architecture?.designRecovery?.request);
    },
    onDetails: () => {
      if (byId("agent-panel-toggle").getAttribute("aria-expanded") !== "true") byId("agent-panel-toggle").click();
      byId("agent-details-profile-tab").click();
      const details = byId("agent-brief").closest?.("details");
      if (details) details.open = true;
    },
    thoughtsOpen,
  }), agentId: agent.id };
  byId("agent-making-content").replaceChildren(makingView.root);
  if (focused) (makingView[focused] || makingView.start || makingView.details).focus({ preventScroll: true });
}

function clearInspectionTimer() {
  if (inspectionTimer !== null) clearTimeout(inspectionTimer);
  inspectionTimer = null;
}

function serverOperationPending(agent: AgentRequirement, state = runtime(agent)) {
  const architecture = state.architecture;
  return architecture?.agentId === agent.id && agentSourceKey(architecture) === state.sourceKey
    && (["designing", "evaluating"].includes(architecture.status) || agentDevelopmentState(agent, state).active);
}

function scheduleInspection(agent: AgentRequirement | undefined) {
  if (!agent || !visible(agent.id)) return;
  clearInspectionTimer();
  const state = runtime(agent);
  if (state.operation || conversations.get(agent.id)?.turn || state.inspection
    || !serverOperationPending(agent, state)) return;
  inspectionTimer = setTimeout(() => {
    inspectionTimer = null;
    const latest = current();
    if (visible(agent.id) && latest) return inspectAgent(latest, true);
  }, 3000);
}

function renderDevelopment(agent: AgentRequirement, development = agentDevelopmentState(agent, runtime(agent))) {
  const container = document.getElementById("agent-development");
  if (!container) return;
  const state = runtime(agent), operation = state.operation?.kind?.startsWith("development") || state.operation?.development ? state.operation : null;
  container.hidden = !development.visible && !operation;
  if (container.hidden) { container.replaceChildren(); developmentView = null; return; }
  const focusedAction = developmentView?.agentId === agent.id
    ? document.activeElement === developmentView.start ? "start" : document.activeElement === developmentView.stop ? "stop" : null : null;
  const tasksOpen = developmentView?.agentId === agent.id ? developmentView.taskDetails?.open : undefined;
  developmentView = { ...createDevelopmentView(development, { phase: operation?.phase, label: operation?.label, tasksOpen,
    busy: Boolean(operation), stopping: Boolean(operation?.stopping || operation?.controller.signal.aborted),
    showActions: false,
    onStart: () => developAgent(agent.id), onStop: () => operation?.kind === "build" ? stopAgent(agent.id) : stopDevelopment(agent.id) }), agentId: agent.id };
  container.replaceChildren(developmentView.root);
  if (focusedAction) (developmentView[focusedAction] || developmentView.start || developmentView.stop || developmentView.root).focus({ preventScroll: true });
}

function broadcastRuntime(agent = current()) {
  if (!agent || broadcasting.has(agent.id)) return;
  agent = agents.find((entry) => entry.id === agent!.id);
  if (!agent) return;
  const state = runtime(agent), item = conversation(agent.id), development = agentDevelopmentState(agent, state);
  const busy = Boolean(state.operation || item.turn || development.active || item.loading || history.state(agent.id).loading);
  broadcasting.add(agent.id);
  try {
    document.dispatchEvent(new CustomEvent("neuma:agent-runtime-change", { detail: {
      agentId: agent.id, agent: structuredClone(agent), definition: state.definition ? structuredClone(state.definition) : null,
      architecture: state.architecture ? structuredClone(state.architecture) : null,
      development: state.development ? structuredClone(state.development) : null,
      application: state.application ? structuredClone(state.application) : null,
      configurationAction: state.gatewayPending ? "配置本机接口" : null,
      developmentAction: development.canStart || development.canResume ? development.actionLabel : null,
      buildAction: state.architecture?.designRecovery ? agentMakingState(agent, state).actionLabel : null,
      buildBlocked: state.architecture?.designRecovery?.status === "blocked",
      status: state.status, ready: state.status === "ready" && !busy, busy, error: item.error || item.storageError || state.error,
    } }));
  } finally { broadcasting.delete(agent.id); }
}

function syncProfile(id: string, profile: AgentProfile | undefined, version: number) {
  const agent = agents.find((entry) => entry.id === id);
  if (!agent || !profile || typeof profile !== "object" || version !== (profileVersions.get(id) || 0)) return;
  const normalized = { ...profile, id };
  if (JSON.stringify(agent.profile) === JSON.stringify(normalized)) return;
  document.dispatchEvent(new CustomEvent("neuma:agent-profile-changed", { detail: { id, profile: normalized } }));
}

async function loadProfiles() {
  const versions = new Map(profileVersions);
  try {
    const result = await api.listProfiles();
    if (!Array.isArray(result.profiles)) throw new Error("名称与图标暂时无法读取");
    const profiles = result.profiles.filter((profile) => profile && typeof profile.id === "string"
      && (versions.get(profile.id) || 0) === (profileVersions.get(profile.id) || 0));
    document.dispatchEvent(new CustomEvent("neuma:agent-profiles-loaded", { detail: { profiles } }));
    profilesError = "";
  } catch { profilesError = "名称与图标暂时未加载"; }
  if (route.page === "agent" && current()) renderControls(current()!);
}

function renderArchitecture(agent: AgentRequirement, brief: HTMLElement) {
  const record = runtime(agent).architecture;
  if (!record || record.agentId !== agent.id || agentSourceKey(record) !== agentSourceKey(agent)) return;
  const details = element("details", "agent-requirements-details", "");
  details.append(element("summary", "", "方案与检查结果"));
  const profiles: Record<string, string> = { light: "轻量助手", workflow: "流程助手", custom: "专用程序" };
  const capabilities = (Array.isArray(record.design?.capabilities) ? record.design.capabilities : [])
    .filter((item) => item?.status !== "available").map((item) => (item as { reason?: string }).reason)
    .filter((text) => typeof text === "string").join("；");
  const issues = (Array.isArray(record.issues) ? record.issues : []).map((issue) => [issue?.description, issue?.remedy]
    .filter((text) => typeof text === "string" && text.trim()).join(" ")).filter(Boolean).join("；");
  for (const [label, value] of [["方案类型", profiles[record.design?.profile!]], ["方案说明", record.summary],
    ["选择理由", record.design?.rationale], ["检查结论", record.review?.summary],
    ["待处理问题", issues], ["待接入能力", capabilities]]) {
    if (typeof value !== "string" || !value.trim()) continue;
    const row = element("div", "draft-field", "");
    row.append(element("div", "field-label", label), element("div", "field-value", value));
    details.append(row);
  }
  brief.append(details);
  const development = agentDevelopmentState(agent, runtime(agent));
  if (development.record) {
    const row = element("div", "draft-field", "");
    row.append(element("div", "field-label", development.label), element("div", "field-value", development.summary));
    details.append(row);
  }
}

function renderWorkspace({ renderConversation = true } = {}) {
  if (route.page !== "agent") return;
  const agent = current();
  byId("agent-missing").hidden = Boolean(agent);
  byId("agent-workspace").hidden = !agent;
  byId("agent-conversation-actions").hidden = !agent;
  byId("agent-iterate").hidden = !agent;
  byId("agent-title").textContent = agent ? agentDisplayName(agent) : "找不到智能体";
  const identity = byId("agent-panel-toggle");
  identity.disabled = !agent;
  identity.title = agent ? agentDisplayName(agent) : "找不到智能体";
  identity.setAttribute("aria-label", agent ? `${agentDisplayName(agent)}的设置` : "找不到智能体");
  renderAgentAvatar(byId("agent-icon"), agent, { activity: agent ? avatarActivity(agent) : "idle" });
  const avatar = agent && resolveAgentAvatar(agent);
  const color = avatar?.type === "star" ? avatarColors.find((item) => item.id === avatar.color) : null;
  const messageStyle = byId("agent-messages").style;
  messageStyle.setProperty("--user-bubble-background", color?.hex || "var(--text)");
  messageStyle.setProperty("--user-bubble-color", "var(--surface)");
  byId("agent-subtitle").textContent = agent ? agentDisplayDescription(agent) : "请回到 NEUMA 创建或确认需求。";
  byId("agent-subtitle").hidden = Boolean(agent);
  if (!agent) return;
  byId("agent-conversation-title").textContent = conversation(agent.id).messages.length || conversation(agent.id).saveVersion
    ? conversation(agent.id).title : agentDisplayName(agent);
  byId("agent-message-label").textContent = `给 ${agentDisplayName(agent)} 的任务`;
  input.placeholder = `给 ${agentDisplayName(agent)} 发消息…`;
  byId("agent-iterate").disabled = mainBusy;
  byId("agent-save-entry").disabled = mainBusy || (agent.persisted && !agent.dirty);
  byId("agent-save-entry").textContent = agent.persisted && !agent.dirty ? "需求已保存" : "保存智能体需求";
  const brief = byId("agent-brief");
  brief.replaceChildren();
  for (const [label, value] of [["使用场景", agent.draft.scenario?.value], ["每次输入", agent.draft.inputSource?.value],
    ["核心任务", agent.draft.task?.value], ["任务结果", agent.draft.deliverable?.value],
    ["完成标准", agent.draft.successCriteria?.value]]) {
    const field = element("div", "draft-field", "");
    field.append(element("div", "field-label", label), element("div", "field-value", value || "暂无额外说明"));
    brief.append(field);
  }
  renderArchitecture(agent, brief);
  renderHistory(agent);
  if (renderConversation || !conversation(agent.id).messages.length) renderMessages(agent);
  renderControls(agent);
  renderStorageNote(agent);
}

function renderStorageNote(agent: AgentRequirement) {
  const item = conversation(agent.id);
  byId("agent-storage-note").textContent = `${agent.persisted ? agent.dirty ? "原需求在 Agent 文件夹，当前修改尚未保存。" : "需求已保存在 Agent 文件夹。" : agent.localBackup ? "需求仅有浏览器备份，请重试保存到 Agent 文件夹。" : "入口仅在当前页面存在，请保存需求以便下次打开。"}${item.loading
    ? "正在读取历史对话。" : item.saved ? "对话已自动保存在 Agent 文件夹。"
      : item.localBackup ? "当前对话的本机备份已保留。" : "发送消息后，对话会自动保存。"}`;
}

function acquireInspectionSlot() {
  return new Promise<() => void>((resolve) => {
    const start = () => {
      activeInspections++;
      resolve(() => { activeInspections--; inspectionWaiters.shift()?.(); });
    };
    if (activeInspections < 2) start(); else inspectionWaiters.push(start);
  });
}

function inspectAgent(agent: AgentRequirement, refresh = false) {
  const state = runtime(agent);
  if (state.inspection) return state.inspection.sequence === state.sequence && state.inspection.sourceKey === state.sourceKey
    ? state.inspection.promise : undefined;
  if (state.operation || conversations.get(agent.id)?.turn || (!refresh && state.status !== "unchecked")) return;
  const sequence = ++state.sequence;
  const sourceKey = state.sourceKey, inspection: { sequence: number; sourceKey: string; promise?: Promise<void> } = { sequence, sourceKey };
  const valid = () => state.sequence === sequence && runtimes.get(agent.id) === state && state.sourceKey === sourceKey
    && !state.operation && !conversations.get(agent.id)?.turn && agents.some((item) => item.id === agent.id);
  state.inspection = inspection;
  state.inspectionError = false;
  const profileVersion = profileVersions.get(agent.id) || 0;
  if (!refresh || state.status === "unchecked") state.status = "checking";
  renderSidebar();
  if (visible(agent.id)) renderControls(agent);
  inspection.promise = (async () => {
    const release = await acquireInspectionSlot();
    try {
      if (!valid()) return;
      const result = await api.inspect(agent.id);
      if (!valid()) return;
      state.definition = result.agent ?? null;
      state.architecture = result.architecture ?? null;
      state.development = result.development ?? null;
      state.application = result.application ?? result.activeRuntime?.application ?? null;
      state.error = "";
      Object.assign(state, agentBuildState(agent, result));
      if (state.status === "ready" || state.architecture?.status === "passed") state.buildError = "";
      syncProfile(agent.id, result.profile || result.agent?.profile, profileVersion);
    } catch (caught) { const error = errorInfo(caught);
      if (!valid()) return;
      state.status = "error"; state.inspectionError = true;
      state.error = error.message || "智能体状态暂时无法读取，请刷新后重试。";
    } finally {
      release();
      if (state.inspection === inspection) state.inspection = null;
      if (valid()) {
        renderSidebar();
        if (visible(agent.id)) renderWorkspace({ renderConversation: !refresh });
      } else if (visible(agent.id)) scheduleInspection(current());
    }
  })();
  return inspection.promise;
}

async function buildAgent(id: string, queueIfBusy = false, architectureRepair?: unknown) {
  const agent = agents.find((item) => item.id === id);
  if (!agent) return;
  const state = runtime(agent), item = conversation(id);
  if (state.architecture?.designRecovery?.status === "blocked") return;
  if (state.operation || item.turn || agentDevelopmentState(agent, state).active) {
    if (queueIfBusy && (item.turn || state.operation?.sourceKey !== agentSourceKey(agent)
      || state.operation?.controller.signal.aborted)) state.rebuildRequested = true;
    return;
  }
  state.rebuildRequested = false;
  const operation: AgentOperation = { kind: "build", controller: new AbortController(), sourceKey: agentSourceKey(agent), phase: "designing", label: "正在设计与检查…" };
  const profileVersion = profileVersions.get(id) || 0;
  state.sequence++;
  state.operation = operation;
  state.status = "building";
  state.architecture = null;
  state.development = null;
  if (!state.activeRuntime) state.application = null;
  state.error = item.error = "";
  state.buildError = "";
  state.inspectionError = false;
  state.label = "正在设计与检查…";
  state.architectureThoughts = [];
  renderSidebar();
  if (visible(id)) renderControls(agent);
  try {
    const result = await api.build(agent, { architectureRepair, signal: operation.controller.signal, onProgress(progress) {
      if (operation.controller.signal.aborted || state.operation !== operation) return;
      if (progress.type === "architecture_thought") {
        state.architectureThoughts = rememberArchitectureThought(state.architectureThoughts, progress);
        if (visible(id) && makingView?.agentId === id && makingView.syncThoughts) makingView.syncThoughts();
        else if (visible(id)) renderControls(agent);
      } else {
      if (progress.type === "status") {
        operation.phase = progress.phase || operation.phase;
        state.label = operation.label = progress.label || "正在设计与检查…";
      }
      if (progress.architecture?.agentId === id && agentSourceKey(progress.architecture) === operation.sourceKey) state.architecture = progress.architecture;
      if (agentDevelopmentState(agent, { architecture: state.architecture, development: progress.development }).record) {
        state.development = progress.development; operation.development = true;
        operation.phase = progress.phase; operation.label = progress.label;
      }
      if (visible(id)) renderControls(agent);
      }
      syncAvatarActivity(agent);
    } });
    operation.controller.signal.throwIfAborted();
    if (state.sourceKey !== operation.sourceKey || state.operation !== operation) return;
    state.definition = result.agent ?? null;
    state.architecture = result.architecture ?? null;
    state.development = result.development ?? null;
    state.application = result.application ?? result.activeRuntime?.application ?? null;
    Object.assign(state, agentBuildState(agent, result));
    state.buildError = "";
    if (state.status === "ready") item.sessionId = crypto.randomUUID();
    syncProfile(id, result.profile || result.agent?.profile, profileVersion);
  } catch (caught) { const error = errorInfo(caught);
    if (state.sourceKey !== operation.sourceKey || state.operation !== operation) return;
    state.status = "error";
    state.error = operation.controller.signal.aborted || error.reason === "cancelled" ? "生成已停止，可以重新生成。" : error.message || "生成失败，请重试。";
    state.buildError = operation.controller.signal.aborted || error.reason === "cancelled" ? "" : state.error;
    try {
      if (operation.cancelPromise) await operation.cancelPromise;
      if (state.operation !== operation || state.sourceKey !== operation.sourceKey) return;
      const snapshot = await api.inspect(id);
      if (state.operation === operation && state.sourceKey === operation.sourceKey) {
        applyDevelopmentResult(agent, state, snapshot);
        if (state.status === "ready" || state.architecture?.status === "passed") state.buildError = "";
        if (operation.stopping && !serverOperationPending(agent, state)) state.error = "";
        else if (operation.development && snapshot.development?.status !== "completed") state.error = "研发进度已保存，可以继续。";
      }
    } catch {
      if (state.operation === operation && state.sourceKey === operation.sourceKey && operation.stopping)
        state.error = "生成状态尚未确认，请刷新后核实已保存的进度。";
    }
  } finally {
    if (state.operation === operation) state.operation = null;
    renderSidebar();
    if (visible(id)) renderWorkspace();
    await rebuildIfRequested(id, state);
  }
}

function currentDevelopmentOperation(id: string, state: AgentState, operation: AgentOperation) {
  return runtimes.get(id) === state && state.operation === operation && state.sourceKey === operation.sourceKey
    && agents.some((agent) => agent.id === id);
}

function applyDevelopmentResult(agent: AgentRequirement, state: AgentState, result: RuntimeResult) {
  state.definition = result.agent ?? null;
  state.architecture = result.architecture ?? null;
  state.development = result.development ?? null;
  state.application = result.application ?? result.activeRuntime?.application ?? null;
  Object.assign(state, agentBuildState(agent, result));
}

async function developAgent(id: string) {
  const agent = agents.find((entry) => entry.id === id);
  if (!agent) return;
  const state = runtime(agent), item = conversation(id), development = agentDevelopmentState(agent, state);
  if (development.canConfigure) {
    document.dispatchEvent(new CustomEvent("neuma:agent-services-open", { detail: { agentId: id } }));
    return;
  }
  if (state.operation || item.turn || (!development.canStart && !development.canResume)) return;
  const operation: AgentOperation = { kind: "development", controller: new AbortController(), sourceKey: agentSourceKey(agent),
    phase: development.record?.phase || "intake", label: development.canResume ? "正在核实已保存的研发进度…" : "正在接收已通过的设计…" };
  const profileVersion = profileVersions.get(id) || 0;
  state.sequence++; state.operation = operation; state.status = "developing"; state.error = item.error = ""; state.buildError = "";
  state.label = operation.label!;
  renderSidebar(); if (visible(id)) renderControls(agent);
  try {
    const result = await api.develop(id, { resume: development.canResume, signal: operation.controller.signal, onProgress(progress) {
      if (!currentDevelopmentOperation(id, state, operation) || operation.controller.signal.aborted || progress.type !== "status") return;
      if (developmentPhases.some(([phase]) => phase === progress.phase)) operation.phase = progress.phase;
      if (typeof progress.label === "string") state.label = operation.label = progress.label;
      if (agentDevelopmentState(agent, { architecture: state.architecture, development: progress.development }).record)
        state.development = progress.development;
      if (visible(id)) renderControls(agent);
    } });
    operation.controller.signal.throwIfAborted();
    if (!currentDevelopmentOperation(id, state, operation)) return;
    applyDevelopmentResult(agent, state, result);
    if (state.status === "ready") item.sessionId = crypto.randomUUID();
    syncProfile(id, result.profile || result.agent?.profile, profileVersion);
  } catch (caught) { const error = errorInfo(caught);
    if (!currentDevelopmentOperation(id, state, operation)) return;
    state.error = operation.stopping ? "" : error.message || "研发未完成，正在核实已保存的进度。";
    try {
      // Reconcile from durable server state after the stream ends; a lost response is not a successful build.
      if (operation.cancelPromise) await operation.cancelPromise;
      const result = await api.inspect(id);
      if (!currentDevelopmentOperation(id, state, operation)) return;
      if (operation.stopping && result.development?.status === "completed") {
        state.status = "needs_development"; state.error = "停止请求后的结果尚未确认，请刷新页面核实研发状态。";
      } else applyDevelopmentResult(agent, state, result);
    } catch (caught) { const recoveryError = errorInfo(caught);
      if (!currentDevelopmentOperation(id, state, operation)) return;
      state.status = "needs_development";
      state.error = recoveryError.message || "研发状态暂时无法确认，请刷新页面读取已保存的进度。";
    }
  } finally {
    if (state.operation === operation) state.operation = null;
    renderSidebar(); if (visible(id)) renderWorkspace();
    await rebuildIfRequested(id, state);
  }
}

async function stopDevelopment(id: string) {
  const agent = agents.find((entry) => entry.id === id);
  if (!agent) return;
  const state = runtime(agent), local = state.operation?.kind === "development";
  if (state.operation?.stopping || (!local && (state.operation || !agentDevelopmentState(agent, state).active))) return;
  const operation: AgentOperation = local ? state.operation! : { kind: "development-stop", controller: new AbortController(), sourceKey: agentSourceKey(agent) };
  operation.stopping = true; state.sequence++; state.operation = operation;
  operation.cancelPromise = api.cancelDevelopment(id);
  operation.controller.abort();
  if (visible(id)) renderControls(agent);
  try {
    const result = await operation.cancelPromise;
    if (!currentDevelopmentOperation(id, state, operation)) return;
    if (result.development?.agentId === id && result.development.status !== "completed") state.development = result.development;
    if (!local) {
      const snapshot = await api.inspect(id);
      if (!currentDevelopmentOperation(id, state, operation)) return;
      if (snapshot.development?.status !== "completed") applyDevelopmentResult(agent, state, snapshot);
      else { state.status = "needs_development"; state.error = "停止请求后的结果尚未确认，请刷新页面核实研发状态。"; }
    }
  } catch (caught) { const error = errorInfo(caught);
    if (currentDevelopmentOperation(id, state, operation)) state.error = error.message || "停止研发尚未确认，请稍后重试。";
  } finally {
    if (!local && state.operation === operation) state.operation = null;
    if (visible(id)) renderControls(agent);
  }
}

async function rebuildIfRequested(id: string, state: AgentState) {
  if (!state.rebuildRequested || runtimes.get(id) !== state || state.operation || conversations.get(id)?.turn
    || !agents.some((agent) => agent.id === id)) return;
  state.rebuildRequested = false;
  await buildAgent(id);
}

function updateReply(id: string, item: HistoryItem) {
  syncAvatarActivity(agents.find((agent) => agent.id === id));
  if (!visible(id, item)) return;
  const container = byId("agent-messages");
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  item.replyView?.update(item.turn!.reply);
  if (atBottom) container.scrollTop = container.scrollHeight;
}

async function stopAgent(id: string) {
  const agent = agents.find((entry) => entry.id === id);
  if (!agent) return;
  const state = runtime(agent), item = conversation(id), operation = state.operation || item.turn;
  if (operation?.kind?.startsWith("development")) return stopDevelopment(id);
  if (item.turn) return stopConversation(id, item);
  return stopMaking(id);
}

async function stopMaking(id: string) {
  const agent = agents.find((entry) => entry.id === id);
  if (!agent) return;
  const state = runtime(agent);
  if (state.operation?.kind?.startsWith("development") || (!state.operation && agentDevelopmentState(agent, state).active))
    return stopDevelopment(id);
  if (state.operation?.stopping || (!state.operation && !serverOperationPending(agent, state))) return;
  const operation: AgentOperation = state.operation || { kind: "build-stop", controller: new AbortController(), sourceKey: agentSourceKey(agent) };
  const valid = () => runtimes.get(id) === state && state.operation === operation && state.sourceKey === operation.sourceKey
    && agents.some((entry) => entry.id === id);
  operation.stopping = true; state.sequence++; state.rebuildRequested = false; state.operation = operation;
  operation.cancelPromise = api.cancelBuild(id);
  operation.controller.abort();
  if (visible(id)) renderControls(agent);
  try {
    const result = await operation.cancelPromise;
    if (!valid()) return;
    const snapshot = Object.hasOwn(result, "architecture") ? result : await api.inspect(id);
    if (!valid()) return;
    applyDevelopmentResult(agent, state, snapshot);
    state.error = serverOperationPending(agent, state) ? "终止请求尚未完成，正在核实后台状态。" : "";
  } catch (caught) { const error = errorInfo(caught);
    if (!valid()) return;
    state.error = error.message || "终止请求未确认，请稍后重试。";
    try {
      const snapshot = await api.inspect(id);
      if (valid()) applyDevelopmentResult(agent, state, snapshot);
    } catch {}
  } finally {
    if (state.operation === operation) state.operation = null;
    renderSidebar(); if (visible(id)) renderWorkspace();
  }
}

async function sendMessage() {
  const agent = current(), message = input.value.trim();
  if (!agent) return;
  const state = runtime(agent), item = conversation(agent.id);
  const attachmentRefs = attachments.refs(agent.id, item.id);
  if ((!message && !attachmentRefs.length) || attachments.blocked(agent.id, item.id)) return;
  const library = history.state(agent.id);
  if (state.status !== "ready" || state.operation || item.turn || item.loading
    || (library.loading && library.selection === library.loading.selection)
    || item.deleting || (!item.loaded && item.saveVersion)) return;
  if (message.length > 4000) return showError("任务输入需为 1～4000 字。");
  const applicationContext = getApplicationContext(agent.id);
  const turnHistory = agentHistory(item.messages, state.definition!.revision);
  const user = addUserMessage(item.messages, message, attachmentRefs);
  user.revision = String(state.definition!.revision);
  const reply: Message = { role: "assistant", content: "", status: "thinking", label: "正在处理任务…", revision: user.revision };
  const operation = { controller: new AbortController(), reply, avatarActivity: "thinking" };
  item.turn = operation;
  document.dispatchEvent(new CustomEvent("neuma:agent-message-started", { detail: { agentId: agent.id, sessionId: item.sessionId } }));
  item.loaded = true;
  item.messages.push(reply);
  item.saved = false;
  item.error = "";
  attachments.consume(agent.id, item.id);
  input.value = "";
  inputs.delete(item.id);
  input.dispatchEvent(new Event("input"));
  renderWorkspace();
  void history.changed(agent.id, item, { immediate: true });
  try {
    const result = await api.turn({ agentId: agent.id, sessionId: item.sessionId, message, history: turnHistory,
      ...(applicationContext ? { applicationContext } : {}),
      ...(attachmentRefs.length ? { attachments: attachmentRefs } : {}) }, {
      signal: operation.controller.signal, onProgress(progress) {
        if (operation.controller.signal.aborted) return;
        if (progress.type === "text-start") { reply.content = ""; reply.status = "thinking"; operation.avatarActivity = "thinking"; }
        if (progress.type === "text-delta" && typeof progress.delta === "string") {
          reply.content += progress.delta; reply.status = "writing"; operation.avatarActivity = "working";
        }
        if (progress.type === "status") {
          reply.status = "thinking"; reply.label = progress.label || "正在处理任务…";
          operation.avatarActivity = progress.phase === "tool" ? "working" : progress.phase === "queued" ? "queued" : "thinking";
        }
        updateReply(agent.id, item);
        history.changed(agent.id, item);
      },
    });
    operation.controller.signal.throwIfAborted();
    user.delivery = "sent";
    Object.assign(reply, { content: result.reply, status: "complete" });
  } catch (caught) { const error = errorInfo(caught);
    const stopped = operation.controller.signal.aborted || error.reason === "cancelled";
    user.delivery = stopped ? "stopped" : "failed";
    reply.status = stopped ? "stopped" : "error";
    reply.error = stopped ? "本轮任务未完成，已显示的内容保留。" : error.message || "任务失败，请重试。";
    item.error = stopped ? item.error : reply.error;
    if (item.turn === operation && history.states.get(agent.id)?.items.get(item.id) === item)
      attachments.restore(agent.id, item.id, attachmentRefs);
    if (!stopped && conversations.get(agent.id) === item) {
      if (visible(agent.id, item) && !input.value.trim()) { input.value = message; input.dispatchEvent(new Event("input")); }
      else if (!visible(agent.id, item) && !savedInput(agent.id, item.id).trim()) rememberInput(agent.id, item, message);
    }
  } finally {
    if (visible(agent.id, item)) {
      updateReply(agent.id, item);
      if (user.delivery !== "sent") item.userRows!.get(user)?.replaceWith(userRow(agent.id, item, user));
    }
    if (item.turn === operation) item.turn = item.replyView = null;
    document.dispatchEvent(new CustomEvent("neuma:agent-turn-finished", { detail: { agentId: agent.id } }));
    syncAvatarActivity(agent);
    await history.changed(agent.id, item, { immediate: true });
    if (visible(agent.id, item)) {
      const restoreInput = [input, byId("agent-send"), byId("agent-cancel-reply")].includes(document.activeElement as HTMLButtonElement | HTMLTextAreaElement);
      renderControls(agent);
      if (restoreInput) input.focus();
    }
    await rebuildIfRequested(agent.id, state);
  }
}

document.addEventListener("neuma:agents-changed", (event) => {
  agents = event.detail.items;
  mainBusy = event.detail.busy;
  for (const agent of agents) {
    const state = runtime(agent), sourceKey = agentSourceKey(agent);
    if (state.sourceKey === sourceKey) continue;
    state.sourceKey = sourceKey;
    state.sequence++;
    state.operation?.controller.abort();
    state.status = "stale";
    if (!state.activeRuntime) state.application = null;
    state.label = "";
    state.error = "";
    state.buildError = "";
    state.inspectionError = false;
  }
  renderSidebar();
  renderWorkspace();
  for (const agent of agents) if (runtime(agent).status === "unchecked") void inspectAgent(agent);
  if (route.page === "agent" && current()) return Promise.all([inspectAgent(current()!), loadConversation(current()!)]);
});
document.addEventListener("neuma:route", (event) => {
  clearInspectionTimer();
  attachmentView.close();
  closeHistoryMenu();
  if (route.page === "agent" && current()) rememberInput(route.agentId!, conversation(route.agentId!), input.value);
  const previousPage = route.page, previousId = route.agentId;
  route = event.detail;
  if (route.page !== "agent") attachmentView.setContext(null);
  if (route.page === "agent" && previousId !== route.agentId) {
    input.value = savedInput(route.agentId!);
    input.dispatchEvent(new Event("input"));
  }
  renderSidebar();
  if (route.page === "agent" && current() && (previousPage !== "agent" || previousId !== route.agentId))
    sidebarHistories.get(route.agentId!)?.openInitially();
  renderWorkspace();
  if (route.page === "agent" && current()) {
    if ((previousPage !== "agent" || previousId !== route.agentId) && runtime(current()!).status === "ready") input.focus();
    return Promise.all([inspectAgent(current()!, serverOperationPending(current()!)), loadConversation(current()!)]);
  }
});
document.addEventListener("neuma:agent-build", (event) => {
  const agent = agents.find(item => item.id === event.detail.id);
  if (agent) return buildAgent(agent.id, true, runtime(agent).architecture?.designRecovery?.request);
});
document.addEventListener("neuma:agent-develop", (event) => developAgent(event.detail.id));
document.addEventListener("neuma:agent-development-stop", (event) => stopDevelopment(event.detail.id));
document.addEventListener("neuma:agent-runtime-request", (event) => {
  const agent = agents.find((item) => item.id === (event.detail?.agentId ?? route.agentId));
  if (agent) broadcastRuntime(agent);
});
document.addEventListener("neuma:agent-application-loaded", (event) => {
  const { agentId, application, revision } = event.detail;
  const agent = agents.find((item) => item.id === agentId);
  if (!agent || runtime(agent).definition?.revision !== revision || runtime(agent).operation || runtime(agent).status === "stale") return;
  runtime(agent).application = application;
  if (visible(agentId)) renderControls(agent);
});
document.addEventListener("neuma:agent-connections-changed", (event) => {
  const agent = agents.find((item) => item.id === event.detail.agentId);
  if (agent) void inspectAgent(agent, true);
});
document.addEventListener("neuma:agent-services-changed", (event) => {
  const agent = agents.find((item) => item.id === event.detail.agentId);
  if (agent) void inspectAgent(agent, true);
});
document.addEventListener("neuma:agent-profile-changed", (event) => {
  const { id } = event.detail ?? {};
  if (typeof id === "string") profileVersions.set(id, (profileVersions.get(id) || 0) + 1);
});
document.addEventListener("neuma:agent-removed", (event) => {
  const id = event.detail.id, item = conversations.get(id);
  if (id === route.agentId) clearInspectionTimer();
  runtimes.get(id)?.operation?.controller.abort();
  item?.loading?.controller.abort();
  item?.saving?.controller.abort();
  if (item?.turn) { item.turn.controller.abort(); api.cancel(item.sessionId).catch(() => {}); }
  for (const entry of history.state(id).items.values()) inputs.delete(entry.id);
  history.clear(id);
  attachments.clear(id);
  runtimes.delete(id);
  inputs.delete(id);
  profileVersions.delete(id);
  if (!deleteAgentPreview(storage, id)) showError("入口已移除，但浏览器未能删除保存的对话。");
});
document.addEventListener("neuma:agent-saved", (event) => {
  if (event.detail.id === route.agentId) showError(event.detail.ok ? "" : event.detail.message || "Agent 需求尚未保存到文件夹，请重试保存。");
});

byId("sidebar-create-agent").addEventListener("click", () => action("create"));
byId("agent-iterate").addEventListener("click", () => action("edit"));
byId("agent-save-entry").addEventListener("click", () => action("save"));
byId("agent-build").addEventListener("click", () => {
  const agent = current();
  if (agent) return buildAgent(agent.id, false, runtime(agent).architecture?.designRecovery?.request);
});
byId("agent-upgrade-toggle").addEventListener("click", () => {
  const agent = current(); if (!agent) return;
  const state = runtime(agent); state.showUpgrade = !state.showUpgrade; renderControls(agent);
});
byId("agent-cancel-reply").addEventListener("click", () => stopAgent(route.agentId!));
byId("agent-chat-retry").addEventListener("click", async () => {
  const agent = current();
  if (!agent) return;
  const state = history.state(agent.id), item = conversation(agent.id);
  if (state.error) { state.loaded = false; return loadConversation(agent); }
  if (!item.loaded && item.saveVersion) return history.read(agent.id, item);
  return history.save(agent.id, item);
});
byId("agent-chat-fork").addEventListener("click", async () => {
  const agent = current();
  if (!agent) return;
  await stopConversation(agent.id);
  await history.fork(agent.id);
  if (visible(agent.id)) renderWorkspace();
});
byId("agent-history-delete").addEventListener("click", () => {
  const target = historyMenu;
  closeHistoryMenu(true);
  if (target && agents.some((agent) => agent.id === target.agentId)) return deleteConversation(target.agentId, target.conversationId);
});
for (const id of ["sidebar-scroll", "sidebar-agent-list", "sidebar-group-list"] as const) {
  byId(id).addEventListener("scroll", () => closeHistoryMenu(true));
}
window.addEventListener?.("resize", () => closeHistoryMenu(true));
document.addEventListener("click", (event) => {
  if (historyMenu && !historyMenu.trigger.contains(event.target as Node | null) && !byId("agent-history-menu").contains(event.target as Node | null)) closeHistoryMenu();
});
document.addEventListener("keydown", (event) => {
  if (!historyMenu) return;
  if (event.key === "Escape") { event.preventDefault(); closeHistoryMenu(true); }
  else if (event.key === "Tab") closeHistoryMenu(true);
  else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && byId("agent-history-menu").contains(event.target as Node | null)) {
    event.preventDefault(); byId("agent-history-delete").focus({ preventScroll: true });
  }
});
async function newConversation(id = route.agentId) {
  if (!visible(id)) document.dispatchEvent(new CustomEvent("neuma:navigate", { detail: { page: "agent", agentId: id } }));
  const agent = current();
  if (!agent || !visible(id)) return;
  const sequence = (switchRequests.get(agent.id) || 0) + 1;
  switchRequests.set(agent.id, sequence);
  const previous = conversation(agent.id);
  rememberInput(agent.id, previous, input.value);
  await stopConversation(agent.id, previous);
  if (!visible(agent.id) || switchRequests.get(agent.id) !== sequence) return;
  history.blank(agent.id);
  input.value = "";
  renderWorkspace();
  input.dispatchEvent(new Event("input")); input.focus();
}
byId("agent-new-chat").addEventListener("click", () => newConversation());
input.addEventListener("input", () => { if (route.page === "agent" && current()) rememberInput(route.agentId!, conversation(route.agentId!), input.value); });
byId("agent-chat-form").addEventListener("submit", (event) => { event.preventDefault(); return sendMessage(); });
window.addEventListener?.("pagehide", () => {
  if (route.page === "agent" && current()) rememberInput(route.agentId!, conversation(route.agentId!), input.value);
  history.checkpoint();
});

document.dispatchEvent(new CustomEvent("neuma:agents-request"));
void loadProfiles();
