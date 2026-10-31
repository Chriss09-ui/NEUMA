import type { DisplayAgent } from "./ui-types.js";
import type { Group, GroupConversationView, GroupMention, GroupMessageView, GroupTask, GroupView } from "./ui-api-types.js";
import type { UiRoute } from "./browser-events.js";
interface GroupSend { content: string; newTask: boolean; taskId?: string | undefined; mentions?: GroupMention[] | undefined; attachmentIds?: string[] | undefined; mutationId: string }
interface TaskHistory { tasks?: GroupTask[] | undefined; loading?: boolean | undefined; error?: string | undefined; stamp?: string | number | undefined }
interface HistoryInput { group: { id: string; updatedAt?: string | number | undefined; lastSequence?: number | undefined }; tasks?: GroupTask[] | undefined; messages?: GroupMessageView[] | undefined }
interface SettingsFocus { kind: "members" | "tasks"; id: string; first: boolean; element: HTMLElement | null }
type GroupSidebar = ReturnType<typeof createSidebarHistory<GroupConversationView>>;
import { pageElement, type PageElements } from "./page-elements.js";
import { errorInfo } from "./ui-types.js";
import { createCollaborationApi } from "./collaboration-api.js";
import { createGroupMaterials } from "./group-materials.js";
import { renderAgentAvatar } from "./agent-avatar.js";
import { renderGroupAvatar } from "./group-avatar.js";
import { createGroupMentionComposer } from "./group-mention-composer.js";
import { createSidebarHistory } from "./sidebar-history.js";
import { createGroupCapabilities } from "./group-capabilities.js";
import { button, groupConversations, node, notice, renderMessages, renderTasks } from "./group-view.js";

const api = createCollaborationApi(), byId = <K extends keyof PageElements>(id: K) => pageElement(document, id);
const groupPanel = byId("group-panel"), groupShell = byId("group-page-shell"), groupMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let route: UiRoute = { page: "chat", groupId: null, agentId: null }, groups: Group[] = [], data: GroupView | null = null, requestSequence = 0;
let loading = false, sending = false, selectedTask = "", newTask = false, pollTimer: number | null = null, polling = false;
let editing: Group | null = null, editorTrigger: HTMLElement | null = null, editorSaving = false, editorSequence = 0, editorRetry: { fingerprint: string; body: unknown } | null = null, retry: { id: string; fingerprint: string; body: GroupSend } | null = null;
let listSequence = 0;
let settingsGroupId: string | null = null, settingsSequence = 0, settingsTimer: number | null = null, removeSettingsListener: (() => void) | null = null;
const drafts = new Map<string, ReturnType<ReturnType<typeof createGroupMentionComposer>["snapshot"]>>();
const archivingGroups = new Set<string>();
const newTaskDrafts = new Map<string, boolean>();
const selectedConversations = new Map<string, string>();
const avatarMembers = new Map<string, { id: string; profile: { icon: string } }>();
const sidebarGroups = new Map<string, GroupSidebar>(), taskHistories = new Map<string, TaskHistory>(), taskHistorySequences = new Map<string, number>();
const collapsedGroups = new Map<string, { link: HTMLAnchorElement; mark: HTMLElement }>();
const historyActionErrors = new Map<string, string>(), removingHistories = new Map<string, string>(), removalRetries = new Map<string, { mutationId: string }>();
const removedConversations = new Map<string, Set<string>>(), removedTasks = new Map<string, Set<string>>();
let historyMenu: { groupId: string; conversationId: string; trigger: HTMLButtonElement; row: HTMLElement } | null = null;
let pendingSidebarTask: { groupId: string; taskId?: string | undefined; newConversation?: boolean } | null = null;
const materials = createGroupMaterials({ api, current: () => data, refresh: load, changed: controls });
const memberCapabilities = createGroupCapabilities(byId("group-members"));
const navigate = (detail: Partial<UiRoute>) => document.dispatchEvent(new CustomEvent("neuma:navigate", { detail }));
const mentionComposer = createGroupMentionComposer({ input: byId("group-message"), popup: byId("group-mention-popup"),
  selected: byId("group-selected-mentions"), document, window });

function rememberAvatars(members: DisplayAgent[] = []) {
  let changed = false;
  for (const member of members) {
    if (typeof member?.id !== "string" || (!member.profile && avatarMembers.has(member.id))) continue;
    const icon = typeof member.profile?.icon === "string" ? member.profile.icon : "";
    if (avatarMembers.get(member.id)?.profile.icon === icon) continue;
    avatarMembers.set(member.id, { id: member.id, profile: { icon } }); changed = true;
  }
  return changed;
}
function groupAvatar(group: Group, className: string) {
  const avatar = node("span", className); renderGroupAvatar(avatar, group, [...avatarMembers.values()]); return avatar;
}
function renderGroupIdentity() {
  if (data?.group?.id !== route.groupId) return;
  for (const id of ["group-avatar", "group-details-avatar"] as const) renderGroupAvatar(byId(id), data.group, [...avatarMembers.values()]);
}
function syncAvatars(members: DisplayAgent[]) {
  if (!rememberAvatars(members)) return;
  renderLibrary(); renderGroupIdentity();
}

function controls() {
  const unavailable = loading || !data?.group || data!.group.archived || removingHistories.has(route.groupId!);
  byId("group-send").disabled = Boolean(unavailable || sending || materials.busy());
  for (const [id, entry] of sidebarGroups) entry.newChat.disabled = Boolean(sending || removingHistories.has(id)
    || (route.page === "group" && route.groupId === id && loading));
  byId("group-message").disabled = Boolean(unavailable || sending);
  byId("group-panel-toggle").disabled = route.page !== "group" || data?.group?.id !== route.groupId;
  materials.syncControls();
  mentionComposer.sync();
  const status = byId("group-compose-status");
  const current = route.page === "group" && data?.group?.id === route.groupId;
  const active = currentConversation()?.tasks.at(-1);
  const processing = !newTask && ["queued", "running", "negotiating", "waiting"].includes(active?.status!);
  status.textContent = !current ? "" : data!.group.archived ? "群已归档，取消归档后可继续协作。"
    : sending && retry?.id === route.groupId ? "正在提交消息…" : processing ? "正在处理你的消息…" : "";
  status.hidden = !status.textContent;
}

function currentConversation() {
  return groupConversations(data?.tasks || []).find((conversation) => conversation.id === selectedTask);
}
function savedConversation(id: string) {
  if (selectedConversations.has(id)) return selectedConversations.get(id)!;
  try { return localStorage.getItem(`neuma.group.selected-conversation.${id}`) || ""; } catch { return ""; }
}
function rememberConversation(id: string, selected: string) {
  selectedConversations.set(id, selected);
  try { localStorage.setItem(`neuma.group.selected-conversation.${id}`, selected); } catch { /* Selection still survives page changes in memory. */ }
}
function resolveConversation(id = selectedTask) {
  const conversations = groupConversations(data?.tasks || []);
  return conversations.find((conversation) => conversation.id === id || conversation.tasks.some((task) => task.id === id))?.id
    || conversations.at(-1)?.id || "";
}

function cancelSettingsTransition() {
  const sequence = ++settingsSequence;
  if (settingsTimer !== null) clearTimeout(settingsTimer);
  settingsTimer = null; removeSettingsListener?.(); removeSettingsListener = null;
  return sequence;
}
function finishSettingsTransition(sequence: number) {
  if (sequence !== settingsSequence) return;
  if (settingsTimer !== null) clearTimeout(settingsTimer);
  settingsTimer = null; removeSettingsListener?.(); removeSettingsListener = null;
  groupShell.classList.remove("is-settings-animating"); groupPanel.hidden = !settingsGroupId;
}
function settingsVisibility(active: boolean, { animate = true } = {}) {
  const sequence = cancelSettingsTransition();
  groupPanel.inert = !active; groupPanel.setAttribute("aria-hidden", String(!active));
  if (active && groupPanel.hidden) { groupPanel.hidden = false; groupShell.getBoundingClientRect(); }
  const durations = animate && !groupMotion.matches && window.getComputedStyle
    ? (window.getComputedStyle(groupShell).transitionDuration || "").split(",") : [];
  const duration = Math.max(0, ...durations.map((value) => (Number.parseFloat(value) || 0) * (value.trim().endsWith("ms") ? 1 : 1000)));
  if (duration) groupShell.classList.add("is-settings-animating");
  groupShell.classList.toggle("settings-open", active);
  byId("group-panel-toggle").setAttribute("aria-expanded", String(active));
  if (!duration) {
    groupShell.getBoundingClientRect();
    for (const animation of groupShell.getAnimations?.() || []) animation.finish();
    finishSettingsTransition(sequence); return;
  }
  const ended = (event: TransitionEvent) => {
    if (event.target === groupShell && event.propertyName === "grid-template-columns") finishSettingsTransition(sequence);
  };
  groupShell.addEventListener("transitionend", ended);
  removeSettingsListener = () => groupShell.removeEventListener("transitionend", ended);
  settingsTimer = setTimeout(() => finishSettingsTransition(sequence), duration + 50);
}
function selectSettingsTab(next: "profile" | "members" | "tasks") {
  groupPanel.dataset.view = next;
  for (const tab of ["profile", "members", "tasks"] as const) {
    byId(`group-details-${tab}`).hidden = tab !== next;
    byId(`group-details-${tab}-tab`).setAttribute("aria-pressed", String(tab === next));
  }
}
function openSettings({ focus = true } = {}) {
  if (route.page !== "group" || data?.group?.id !== route.groupId) return;
  mentionComposer.close();
  if (!settingsGroupId) {
    settingsGroupId = route.groupId; selectSettingsTab("profile"); settingsVisibility(true);
  }
  if (focus) byId("group-details-close").focus({ preventScroll: true });
}
function closeSettings({ restoreFocus = true, animate = true } = {}) {
  const id = settingsGroupId; settingsGroupId = null;
  if (!id && animate) return;
  settingsVisibility(false, { animate });
  if (restoreFocus && route.page === "group" && route.groupId === id) byId("group-panel-toggle").focus({ preventScroll: true });
}
groupPanel.inert = true; groupPanel.setAttribute("aria-hidden", "true");
groupMotion.addEventListener("change", () => { if (groupMotion.matches) settingsVisibility(Boolean(settingsGroupId), { animate: false }); });

function settingsFocus(): SettingsFocus | null {
  const focused = document.activeElement as HTMLElement | null;
  if (!settingsGroupId || !groupPanel.contains(focused)) return null;
  for (const [kind, key] of [["members", "memberId"], ["tasks", "taskId"]] as const) {
    const card = ([...byId(`group-${kind}`).children] as HTMLElement[]).find((item) => item.contains(focused));
    if (card?.dataset[key]) return { kind, id: card.dataset[key], first: card.children[0]!.contains(focused), element: focused };
  }
  return null;
}
function restoreSettingsFocus(focused: SettingsFocus | null) {
  if (!focused || settingsGroupId !== route.groupId) return;
  if (groupPanel.contains(focused.element)) {
    if (document.activeElement !== focused.element) focused.element!.focus({ preventScroll: true });
    return;
  }
  const key = focused.kind === "members" ? "memberId" : "taskId";
  const card = ([...byId(`group-${focused.kind}`).children] as HTMLElement[]).find((item) => item.dataset[key] === focused.id);
  const target = focused.first ? card?.children[0] : card?.children[card.children.length - 1];
  (target && ["BUTTON", "A", "SUMMARY"].includes(target.tagName) && !(target as HTMLButtonElement).disabled ? target as HTMLElement
    : byId(`group-details-${focused.kind}-tab`)).focus({ preventScroll: true });
}
function taskHistorySequence(id: string) {
  const sequence = (taskHistorySequences.get(id) || 0) + 1;
  taskHistorySequences.set(id, sequence); return sequence;
}
function withoutRemovedHistory<T extends HistoryInput>(result: T): T {
  const id = result.group?.id, conversations = removedConversations.get(id), taskIds = removedTasks.get(id);
  if (!conversations?.size) return result;
  for (const task of result.tasks || []) if (conversations.has(task.conversationId || task.id)) taskIds!.add(task.id);
  const tasks = (result.tasks || []).filter((task) => !conversations.has(task.conversationId || task.id));
  return { ...result, tasks, messages: (result.messages || []).filter((message) => !taskIds?.has(message.taskId!)) };
}
function rememberTaskHistory(result: HistoryInput) {
  result = withoutRemovedHistory(result);
  const id = result.group.id;
  taskHistorySequence(id);
  taskHistories.set(id, { tasks: Array.isArray(result.tasks) ? result.tasks : [],
    stamp: result.group.updatedAt || result.group.lastSequence || "", loading: false, error: "" });
}
function closeHistoryMenu(restoreFocus = false) {
  if (!historyMenu) return;
  const { trigger, row } = historyMenu; historyMenu = null;
  byId("group-history-menu").hidden = true;
  trigger.setAttribute("aria-expanded", "false"); row.classList.remove("has-open-menu");
  if (restoreFocus) trigger.focus({ preventScroll: true });
}
function openHistoryMenu(groupId: string, conversation: GroupConversationView, trigger: HTMLButtonElement, row: HTMLElement, focusItem = false) {
  const wasOpen = historyMenu?.trigger === trigger;
  closeHistoryMenu();
  if (wasOpen || removingHistories.has(groupId)) return;
  const menu = byId("group-history-menu"), remove = byId("group-history-delete");
  historyMenu = { groupId, conversationId: conversation.id, trigger, row };
  trigger.setAttribute("aria-expanded", "true"); row.classList.add("has-open-menu");
  remove.setAttribute("aria-label", `删除对话：${conversation.goal || "协作任务"}`);
  menu.setAttribute("aria-label", `对话操作：${conversation.goal || "协作任务"}`); menu.hidden = false;
  const anchor = trigger.getBoundingClientRect(), height = menu.getBoundingClientRect().height, below = anchor.bottom + 4;
  menu.style.left = `${Math.max(8, anchor.right - 152)}px`;
  menu.style.top = `${Math.max(8, below + height <= window.innerHeight - 8 ? below : anchor.top - height - 4)}px`;
  if (focusItem) remove.focus({ preventScroll: true });
}
async function removeConversation(groupId: string, conversationId: string) {
  if (removingHistories.has(groupId) || (sending && retry?.id === groupId)) return;
  const conversation = groupConversations(taskHistories.get(groupId)?.tasks || []).find((item) => item.id === conversationId);
  if (!conversation || !window.confirm(`删除“${conversation.goal || "协作任务"}”？此对话的全部消息和执行记录将被删除，群组、共享资料与成果文件保留。`)) return;
  const originalFocus = document.activeElement, key = `${groupId}/${conversationId}`;
  const body = removalRetries.get(key) || { mutationId: crypto.randomUUID() };
  removalRetries.set(key, body); removingHistories.set(groupId, conversationId); historyActionErrors.delete(groupId);
  taskHistorySequence(groupId); renderSidebarGroups(); controls();
  let removed = false;
  try {
    const result = await api.removeGroupConversation(groupId, conversationId, body);
    if (result.removed !== true || result.conversationId !== conversationId) throw new Error("删除结果尚未确认，请重试。");
    removed = true; removalRetries.delete(key);
    if (!removedConversations.has(groupId)) removedConversations.set(groupId, new Set());
    if (!removedTasks.has(groupId)) removedTasks.set(groupId, new Set());
    removedConversations.get(groupId)!.add(conversationId);
    for (const task of conversation.tasks) removedTasks.get(groupId)!.add(task.id);
    const history = taskHistories.get(groupId);
    if (history?.tasks) rememberTaskHistory({ group: { id: groupId, updatedAt: history.stamp }, tasks: history.tasks });
    if (savedConversation(groupId) === conversationId) {
      const remaining = groupConversations(taskHistories.get(groupId)?.tasks || []);
      rememberConversation(groupId, remaining.at(-1)?.id || "");
    }
    if (pendingSidebarTask?.groupId === groupId && (pendingSidebarTask.taskId === conversationId
      || removedTasks.get(groupId)!.has(pendingSidebarTask.taskId!))) pendingSidebarTask = null;
    if (retry?.id === groupId && removedTasks.get(groupId)!.has(retry.body.taskId!)) retry = null;
    if (route.page === "group" && route.groupId === groupId && data?.group?.id === groupId) {
      data = withoutRemovedHistory(data);
      if (selectedTask === conversationId) {
        selectedTask = resolveConversation(); newTask = !selectedTask; newTaskDrafts.set(groupId, newTask);
      }
      render();
    }
  } catch (caught) { const error = errorInfo(caught);
    if ([400, 409].includes(error.status!)) removalRetries.delete(key);
    historyActionErrors.set(groupId, `删除未完成：${error.message} 可重试。`);
  } finally {
    removingHistories.delete(groupId); renderSidebarGroups(); controls();
  }
  const restoreFocus = document.activeElement === originalFocus || document.activeElement === document.body;
  if (removed) {
    if (route.page === "group" && route.groupId === groupId) await load(groupId, { quiet: true });
    if (restoreFocus && route.page === "group" && route.groupId === groupId) byId("group-message").focus({ preventScroll: true });
    else if (restoreFocus) sidebarGroups.get(groupId)?.link.focus({ preventScroll: true });
  } else if (restoreFocus) {
    const entry = sidebarGroups.get(groupId), row = ([...(entry?.list.children || [])] as HTMLElement[]).find((item) => item.dataset.conversationId === conversationId);
    (entry?.expanded ? row?.querySelector<HTMLElement>(".main-history-more") : entry?.link)?.focus({ preventScroll: true });
  }
}
async function loadTaskHistory(id: string) {
  const cached = taskHistories.get(id);
  if (cached?.loading || cached?.tasks || (route.page === "group" && route.groupId === id)) return;
  if (!groups.some((group) => group.id === id && !group.archived)) return;
  const sequence = taskHistorySequence(id);
  taskHistories.set(id, { loading: true, error: "" }); renderSidebarGroups();
  try {
    const result = withoutRemovedHistory(await api.group(id));
    if (taskHistorySequences.get(id) !== sequence || !groups.some((group) => group.id === id && !group.archived)) return;
    if (result.group?.id !== id || !Array.isArray(result.tasks)) throw new Error("群历史尚未确认，请重试。");
    rememberTaskHistory(result); rememberAvatars(result.members); renderLibrary();
  } catch (caught) { const error = errorInfo(caught);
    if (taskHistorySequences.get(id) !== sequence || !sidebarGroups.has(id)) return;
    taskHistories.set(id, { loading: false, error: `${error.message} 收起后展开可重试。` }); renderSidebarGroups();
  }
}
function openSidebarGroup(id: string, taskId?: string, newConversation = false) {
  if (newConversation && (sending || removingHistories.has(id))) return;
  if (route.page === "group" && route.groupId === id && data?.group?.id === id) {
    pendingSidebarTask = null;
    if (newConversation) startNewConversation();
    else if (taskId !== undefined) chooseTask(taskId, { focus: false });
    return;
  }
  pendingSidebarTask = { groupId: id, taskId, newConversation };
  navigate({ page: "group", groupId: id });
}
function renderCollapsedGroups(visible: Group[]) {
  const rail = byId("sidebar-group-rail"), shown = visible;
  for (const [id, view] of collapsedGroups) if (!shown.some((group) => group.id === id)) {
    if (view.link.contains(document.activeElement)) byId("sidebar-toggle").focus({ preventScroll: true });
    view.link.remove(); collapsedGroups.delete(id);
  }
  rail.hidden = !shown.length;
  for (const group of shown) {
    let view = collapsedGroups.get(group.id);
    if (!view) {
      const link = node("a", "collapsed-agent-link collapsed-group-link"), mark = groupAvatar(group, "collapsed-group-avatar");
      link.href = `#group/${encodeURIComponent(group.id)}`; link.dataset.groupId = group.id; link.append(mark);
      link.addEventListener("click", (event) => {
        if (event.defaultPrevented || (event.button ?? 0) !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); navigate({ page: "group", groupId: group.id });
      });
      view = { link, mark }; collapsedGroups.set(group.id, view);
    }
    view.link.title = group.name; view.link.setAttribute("aria-label", `打开${group.name}的群聊`);
    if (route.page === "group" && route.groupId === group.id) view.link.setAttribute("aria-current", "page");
    else view.link.removeAttribute("aria-current");
    renderGroupAvatar(view.mark, group, [...avatarMembers.values()]);
  }
  if (shown.some((group, index) => rail.children[index] !== collapsedGroups.get(group.id)!.link)) {
    const focused = rail.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    for (const group of shown) rail.append(collapsedGroups.get(group.id)!.link);
    focused?.focus({ preventScroll: true });
  }
}
function renderSidebarGroups() {
  const rail = byId("sidebar-group-list"), visible = groups.filter((group) => !group.archived);
  const ids = new Set(visible.map((group) => group.id));
  for (const [id, entry] of sidebarGroups) {
    if (ids.has(id)) continue;
    if (historyMenu?.groupId === id) closeHistoryMenu();
    entry.root.remove(); sidebarGroups.delete(id); taskHistories.delete(id); taskHistorySequence(id);
  }
  for (const group of visible) {
    let entry = sidebarGroups.get(group.id);
    if (!entry) {
      entry = createSidebarHistory<GroupConversationView>({ document, id: `group-${group.id}`, title: group.name,
        href: `#group/${encodeURIComponent(group.id)}`, icon: groupAvatar(group, "sidebar-group-avatar"),
        className: "sidebar-group-link", onExpand: (expanded) => {
          if (!expanded && historyMenu?.groupId === group.id) closeHistoryMenu();
          if (expanded) void loadTaskHistory(group.id);
        },
        onOpen: () => openSidebarGroup(group.id), onNew: () => openSidebarGroup(group.id, undefined, true), storage: localStorage });
      entry.root.dataset.groupId = group.id; sidebarGroups.set(group.id, entry);
    }
    renderGroupAvatar(entry.icon as HTMLElement, group, [...avatarMembers.values()]);
    const current = route.page === "group" && route.groupId === group.id, history = taskHistories.get(group.id);
    if (historyMenu?.groupId === group.id) closeHistoryMenu(true);
    entry.update({ title: group.name, active: current,
      records: groupConversations(history?.tasks || []).reverse(),
      status: removingHistories.has(group.id) ? "正在删除对话…" : historyActionErrors.get(group.id)
        || (history?.loading ? "正在读取历史…" : history?.error || (history?.tasks?.length === 0 ? "还没有任务对话" : "")),
      renderRow: (task) => {
        const row = node("div", "main-history-row"); row.dataset.conversationId = task.id;
        const select = button(task.goal || "协作任务", () => openSidebarGroup(group.id, task.id), "sidebar-history-item");
        select.dataset.taskId = task.id; select.dataset.conversationId = task.id; select.title = task.goal || "协作任务";
        select.setAttribute("aria-current", current && selectedTask === task.id ? "page" : "false");
        const more = button("", () => openHistoryMenu(group.id, task, more, row), "main-history-more");
        more.dataset.conversationId = task.id; more.setAttribute("aria-label", `对话操作：${task.goal || "协作任务"}`);
        more.title = "更多操作"; more.setAttribute("aria-haspopup", "menu"); more.setAttribute("aria-expanded", "false");
        more.setAttribute("aria-controls", "group-history-menu");
        const dots = node("span", "agent-history-more-icon"); dots.setAttribute("aria-hidden", "true"); more.append(dots);
        more.disabled = select.disabled = removingHistories.has(group.id);
        more.addEventListener("keydown", (event) => {
          if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
          event.preventDefault();
          if (historyMenu?.trigger === more) byId("group-history-delete").focus({ preventScroll: true });
          else openHistoryMenu(group.id, task, more, row, true);
        });
        row.append(select, more); return row;
      } });
    entry.newChat.disabled = Boolean(sending || removingHistories.has(group.id) || (current && loading));
    if (entry.root.parentNode !== rail) rail.append(entry.root);
  }
  if (visible.some((group, index) => rail.children[index] !== sidebarGroups.get(group.id)!.root)) {
    const focused = rail.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    for (const group of visible) rail.append(sidebarGroups.get(group.id)!.root);
    focused?.focus({ preventScroll: true });
  }
  renderCollapsedGroups(visible);
}
function renderLibrary() {
  const target = byId("groups-list"); target.replaceChildren();
  const visible = groups.filter((group) => byId("groups-show-archived").checked || !group.archived);
  if (!visible.length) {
    const empty = node("div", "collaboration-empty groups-empty"); empty.append(node("span", "collaboration-empty-mark", "◎"),
      node("h2", "", "把能力组合成一支团队"), node("p", "muted-note", "创建群组、选择智能体，为它们交代一个共同目标。"),
      button("创建第一个群组", () => void editor(null, byId("groups-create")), "primary")); target.append(empty);
  }
  for (const group of visible) {
    const card = node("article", "group-library-card"), title = node("a", "group-library-title", group.name);
    title.href = `#group/${encodeURIComponent(group.id)}`;
    const heading = node("div", "group-library-heading"); heading.append(groupAvatar(group, "group-library-avatar"), title,
      node("span", "identity-badge", group.archived ? "已归档" : "协作群"));
    card.append(heading, node("p", "muted-note", group.purpose || "共同推进工作"),
      node("p", "group-library-meta", `${group.memberIds?.length || 0} 位成员 · ${group.updatedAt ? new Date(group.updatedAt).toLocaleDateString("zh-CN") : "刚刚创建"}`)); target.append(card);
  }
  renderSidebarGroups();
  notice(byId("sidebar-groups-feedback"), "");
}
async function list() {
  const sequence = ++listSequence;
  try {
    const result = await api.groups(); if (!Array.isArray(result.groups)) throw new Error("群列表尚未确认。");
    if (sequence !== listSequence) return;
    for (const group of result.groups) {
      const history = taskHistories.get(group.id), stamp = group.updatedAt || group.lastSequence || "";
      if (history?.tasks && history.stamp !== stamp && !(route.page === "group" && route.groupId === group.id)) {
        taskHistories.delete(group.id); taskHistorySequence(group.id);
      }
    }
    groups = result.groups; renderLibrary(); notice(byId("groups-error"), "");
    for (const [id, entry] of sidebarGroups) if (entry.expanded) void loadTaskHistory(id);
  } catch (caught) { const error = errorInfo(caught);
    if (sequence !== listSequence) return;
    notice(byId("groups-error"), `${error.message} 重新进入群组页面可重试。`, true);
    notice(byId("sidebar-groups-feedback"), "群组暂时无法读取。");
  }
}
function render() {
  if (!data?.group || route.page !== "group" || data.group.id !== route.groupId) return;
  const group = data.group, focused = settingsFocus();
  renderGroupIdentity();
  byId("group-title").textContent = group.name;
  byId("group-panel-toggle").title = group.name; byId("group-title").title = group.name;
  byId("group-details-name").textContent = group.name;
  byId("group-purpose").textContent = group.purpose || ""; byId("group-purpose").hidden = !group.purpose;
  byId("group-message").placeholder = `给 ${group.name} 发消息…`;
  byId("group-archived").hidden = !group.archived; byId("group-archive").textContent = group.archived ? "取消归档" : "归档";
  byId("group-archive").disabled = archivingGroups.has(group.id);
  byId("group-member-count").textContent = String(data.members?.length || 0);
  if (newTask) selectedTask = "";
  else {
    selectedTask = resolveConversation(); rememberConversation(group.id, selectedTask);
  }
  mentionComposer.setMembers(data.members || [], group.id);
  renderMessages(byId("group-messages"), newTask ? [] : data.messages || [], selectedTask, data.members || [], data.tasks || []);
  memberCapabilities.render(data.members || [], group.id);
  renderTasks(byId("group-tasks"), data.tasks || [], selectedTask, { onSelect: chooseTask, onStop: stop, members: data.members || [] });
  for (const [index, task] of [...(data.tasks || [])].reverse().entries()) (byId("group-tasks").children[index] as HTMLElement).dataset.taskId = task.id;
  materials.render(); controls(); renderSidebarGroups(); restoreSettingsFocus(focused);
}
async function load(id: string | null = route.groupId, { quiet = false } = {}) {
  if (!id) return;
  let openNewConversation = false;
  const sequence = ++requestSequence;
  const historySequence = taskHistorySequence(id);
  const history = taskHistories.get(id);
  if (!quiet) { taskHistories.set(id, { ...history, loading: true, error: "" }); renderSidebarGroups(); }
  if (!quiet) { loading = true; controls(); }
  try {
    const result = withoutRemovedHistory(await api.group(id));
    if (result.group?.id !== id) throw new Error("群组身份尚未确认，请重试。");
    if (taskHistorySequences.get(id) === historySequence
      && groups.some((group) => group.id === id && !group.archived)) {
      rememberTaskHistory(result); renderSidebarGroups();
    }
    if (requestSequence !== sequence || route.page !== "group" || route.groupId !== id) return;
    data = result;
    if (pendingSidebarTask?.groupId === id) {
      if (pendingSidebarTask.newConversation) openNewConversation = true;
      else if (pendingSidebarTask.taskId !== undefined) {
        selectedTask = resolveConversation(pendingSidebarTask.taskId); newTask = false;
      }
      pendingSidebarTask = null;
    }
    if (rememberAvatars(result.members)) renderLibrary();
    notice(byId("group-error"), ""); render();
  } catch (caught) { const error = errorInfo(caught);
    if (taskHistorySequences.get(id) === historySequence && sidebarGroups.has(id)) {
      taskHistories.set(id, { ...history, loading: false, error: `${error.message} 点击群设置中的刷新重试。` }); renderSidebarGroups();
    }
    if (requestSequence === sequence && route.groupId === id) notice(byId("group-error"), `${error.message} 点击右侧刷新重试。`, true);
  }
  finally { if (sequence === requestSequence) { loading = false; controls(); if (openNewConversation) startNewConversation(); } }
}
function chooseTask(id: string, { focus = true } = {}) {
  mentionComposer.close();
  const inSettings = settingsGroupId && groupPanel.contains(document.activeElement);
  selectedTask = resolveConversation(id); newTask = false; rememberConversation(route.groupId!, selectedTask);
  render(); if (focus && !inSettings) byId("group-message").focus();
}
async function stop(taskId: string) {
  const id = data?.group?.id; if (!id) return;
  try {
    await api.cancelTask(id, taskId);
    if (route.page === "group" && route.groupId === id) await load(id);
  }
  catch (caught) { const error = errorInfo(caught); if (route.groupId === id) notice(byId("group-error"), `停止尚未确认：${error.message}`, true); }
}
async function send() {
  const id = data?.group?.id;
  const refs = materials.refs();
  const content = byId("group-message").value.trim() || (refs.length ? "请处理这些共享材料，任务目标不明确时先向我提问。" : "");
  if (!id || (!content && !refs.length) || loading || sending || removingHistories.has(id) || data!.group.archived || materials.busy()) return;
  let mentions;
  try { mentions = mentionComposer.requestMentions(); }
  catch (caught) { const error = errorInfo(caught); notice(byId("group-error"), error.message, true); return; }
  mentionComposer.close();
  const taskId = currentConversation()?.taskId;
  const startNew = newTask || !taskId;
  const body = { content, ...(taskId && !startNew ? { taskId } : {}), ...(mentions.length ? { mentions } : {}),
    newTask: startNew, ...(refs.length ? { attachmentIds: refs } : {}) };
  const fingerprint = JSON.stringify({ ...body, taskId: undefined, conversationId: startNew ? "" : selectedTask });
  let request = retry?.id === id && retry.fingerprint === fingerprint
    ? retry.body : { ...body, mutationId: crypto.randomUUID() };
  retry = { id, fingerprint, body: request }; sending = true;
  if (startNew) newTask = true;
  controls(); notice(byId("group-error"), "");
  try {
    let result;
    try { result = await api.send(id, request); }
    catch (caught) { const error = errorInfo(caught);
      if (error.reason !== "conversation_deleted" || request.newTask !== true || request.taskId
        || route.page !== "group" || route.groupId !== id || retry?.id !== id || retry.body !== request) throw error;
      request = { ...request, mutationId: crypto.randomUUID() };
      retry = { id, fingerprint, body: request };
      result = await api.send(id, request);
    }
    if (!result.message?.id) throw new Error("消息发送尚未确认，请重试。");
    retry = null; drafts.delete(id); newTaskDrafts.delete(id); materials.consume(id);
    const conversationId = result.task?.conversationId || result.task?.id || selectedConversations.get(id) || "";
    if (conversationId) rememberConversation(id, conversationId);
    if (route.page !== "group" || route.groupId !== id) return;
    mentionComposer.restore(); newTask = false;
    if (conversationId) selectedTask = conversationId;
    await load(id); await list();
  } catch (caught) { const error = errorInfo(caught); if (route.groupId === id) notice(byId("group-error"), `${error.message} 当前消息与材料仍保留，可重试。`, true); }
  finally {
    sending = false; controls();
    const focused = document.activeElement;
    if (route.page === "group" && route.groupId === id && (!focused || focused === document.body
      || focused === byId("group-send") || focused === byId("group-message"))) byId("group-message").focus();
  }
}
async function editor(group: Group | null | undefined = null, trigger = byId("groups-create")) {
  const sequence = ++editorSequence; editing = group ? { ...group } : null; editorTrigger = trigger; editorRetry = null;
  byId("group-editor-title").textContent = group ? "编辑群组" : "创建群组";
  byId("group-editor-save").textContent = group ? "保存群组" : "创建群组";
  byId("group-name").value = group?.name || ""; byId("group-purpose-input").value = group?.purpose || "";
  byId("group-member-picker").replaceChildren(node("p", "muted-note", "正在读取智能体能力…"));
  byId("group-editor-save").disabled = true; notice(byId("group-editor-error"), "");
  byId("group-editor").showModal(); byId("group-name").focus();
  try {
    const result = await api.agents(); if (sequence !== editorSequence || !byId("group-editor").open) return;
    const target = byId("group-member-picker"); target.replaceChildren();
    for (const agent of result.agents || []) {
      const label = node("label", "group-pick-member"), input = node("input"); input.type = "checkbox"; input.value = agent.id;
      input.checked = group?.memberIds?.includes(agent.id) || false; input.disabled = !agent.ready && !input.checked;
      const avatar = node("span", "group-pick-avatar"); avatar.setAttribute("aria-hidden", "true"); renderAgentAvatar(avatar, agent);
      const copy = node("span", "group-pick-copy"); copy.append(node("strong", "", agent.name), node("small", "muted-note", agent.ready ? agent.description || "已通过运行检查" : "尚未就绪"));
      label.append(input, avatar, copy); target.append(label);
    }
    if (!result.agents?.length) { target.append(node("p", "muted-note", "先创建并完成一个智能体，再邀请它参加群协作。")); const link = node("a", "text-link", "创建智能体"); link.href = "#create"; link.addEventListener("click", closeEditor); target.append(link); }
    byId("group-editor-save").disabled = false;
  } catch (caught) { const error = errorInfo(caught); if (sequence === editorSequence) notice(byId("group-editor-error"), error.message, true); }
}
function closeEditor() { if (editorSaving) return; editorSequence++; byId("group-editor").close(); editorTrigger?.focus(); }
async function saveEditor() {
  if (editorSaving) return;
  const memberIds = [...byId("group-member-picker").querySelectorAll<HTMLInputElement>("input:checked")].map((input) => input.value);
  if (!memberIds.length) return notice(byId("group-editor-error"), "请选择至少一个智能体。", true);
  const input = { name: byId("group-name").value.trim(), purpose: byId("group-purpose-input").value.trim(), memberIds,
    ...(editing ? { expectedVersion: editing.version } : {}) };
  const fingerprint = JSON.stringify(input), body = editorRetry?.fingerprint === fingerprint
    ? editorRetry.body : { ...input, mutationId: crypto.randomUUID() };
  editorRetry = { fingerprint, body };
  editorSaving = true; byId("group-editor-save").disabled = true;
  try {
    const result = editing ? await api.updateGroup(editing.id, body) : await api.createGroup(body);
    if (!result.group?.id) throw new Error("群组保存尚未确认。");
    editorRetry = null; editorSaving = false; closeEditor(); await list(); navigate({ page: "group", groupId: result.group.id });
  } catch (caught) { const error = errorInfo(caught); notice(byId("group-editor-error"), `${error.message} 编辑内容已保留。`, true); }
  finally { editorSaving = false; byId("group-editor-save").disabled = false; }
}
async function archive() {
  const group = data?.group; if (!group || archivingGroups.has(group.id)) return;
  const current = () => route.page === "group" && route.groupId === group.id;
  archivingGroups.add(group.id);
  byId("group-archive").disabled = true;
  try { await api.updateGroup(group.id, { archived: !group.archived, expectedVersion: group.version, mutationId: crypto.randomUUID() }); if (current()) await load(group.id); await list(); }
  catch (caught) { const error = errorInfo(caught); if (current()) notice(byId("group-error"), error.message, true); }
  finally { archivingGroups.delete(group.id); if (current()) byId("group-archive").disabled = false; }
}
async function poll() {
  if (polling || route.page !== "group" || !data || document.hidden) return;
  const id = data.group.id, after = data.lastSequence ?? data.group.lastSequence ?? 0; polling = true;
  try { const result = await api.events(id, after); if (route.page === "group" && route.groupId === id && (result.events?.length || result.lastSequence > after)) await load(id, { quiet: true }); }
  catch (caught) { const error = errorInfo(caught); if (route.groupId === id) notice(byId("group-error"), `进度同步暂时中断：${error.message} 将自动重试。`, true); }
  finally { polling = false; }
}
byId("group-history-delete").addEventListener("click", () => {
  const target = historyMenu; closeHistoryMenu(true);
  if (target) return removeConversation(target.groupId, target.conversationId);
});
for (const id of ["sidebar-scroll", "sidebar-agent-list", "sidebar-group-list"] as const) {
  byId(id).addEventListener("scroll", () => closeHistoryMenu(true));
}
window.addEventListener?.("resize", () => closeHistoryMenu(true));
document.addEventListener("click", (event) => {
  if (historyMenu && !historyMenu.trigger.contains(event.target as Node | null) && !byId("group-history-menu").contains(event.target as Node | null)) closeHistoryMenu();
});
document.addEventListener("keydown", (event) => {
  if (!historyMenu) return;
  if (event.key === "Escape") { event.preventDefault(); closeHistoryMenu(true); }
  else if (event.key === "Tab") closeHistoryMenu(true);
  else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && byId("group-history-menu").contains(event.target as Node | null)) {
    event.preventDefault(); byId("group-history-delete").focus({ preventScroll: true });
  }
});
byId("group-chat-form").addEventListener("submit", (event) => { event.preventDefault(); void send(); });
function startNewConversation() {
  if (loading || sending || !data?.group || data.group.id !== route.groupId || data.group.archived || removingHistories.has(route.groupId!)) return;
  mentionComposer.close();
  if (retry?.id === route.groupId) retry = null;
  newTask = true; selectedTask = ""; render(); byId("group-message").focus();
}
byId("group-edit").addEventListener("click", () => void editor(data?.group, byId("group-edit")));
byId("group-refresh").addEventListener("click", () => void load());
byId("group-archive").addEventListener("click", () => void archive());
byId("group-panel-toggle").addEventListener("click", () => settingsGroupId ? closeSettings() : openSettings());
byId("group-details-close").addEventListener("click", () => closeSettings());
byId("group-files-open").addEventListener("click", () => openSettings({ focus: false }));
for (const tab of ["profile", "members", "tasks"] as const) byId(`group-details-${tab}-tab`).addEventListener("click", () => selectSettingsTab(tab));
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented || !settingsGroupId || document.querySelector("dialog[open]")) return;
  event.preventDefault(); closeSettings();
});
byId("groups-show-archived").addEventListener("change", renderLibrary);
byId("groups-create").addEventListener("click", () => void editor(null, byId("groups-create")));
document.addEventListener("neuma:groups-changed", () => void list());
document.addEventListener("neuma:agents-changed", (event) => syncAvatars(event.detail?.items || []));
document.addEventListener("neuma:agent-profile-changed", (event) => {
  if (event.detail?.profile) syncAvatars([{ id: event.detail.id, profile: event.detail.profile }]);
});
document.addEventListener("neuma:agent-profiles-loaded", (event) => syncAvatars((event.detail?.profiles || [])
  .map((profile) => ({ id: profile.id, profile }))));
byId("group-editor-form").addEventListener("submit", (event) => { event.preventDefault(); void saveEditor(); });
byId("group-editor-close").addEventListener("click", closeEditor);
byId("group-editor").addEventListener("cancel", (event) => { event.preventDefault(); closeEditor(); });
document.addEventListener("neuma:route", (event) => {
  closeHistoryMenu();
  closeSettings({ restoreFocus: false, animate: false });
  mentionComposer.close();
  if (route.page === "group" && route.groupId) {
    drafts.set(route.groupId, mentionComposer.snapshot()); newTaskDrafts.set(route.groupId, newTask);
    if (!newTask) rememberConversation(route.groupId!, selectedTask);
  }
  const previous = route.groupId; route = event.detail; clearInterval(pollTimer ?? undefined); pollTimer = null; requestSequence++;
  if (route.page !== "group" || previous !== route.groupId) memberCapabilities.reset();
  if (pendingSidebarTask && (route.page !== "group" || route.groupId !== pendingSidebarTask.groupId)) pendingSidebarTask = null;
  renderLibrary();
  if (route.page === "groups") void list();
  if (route.page === "group") {
    sidebarGroups.get(route.groupId!)?.setExpanded(true);
    if (previous !== route.groupId) {
      data = null; selectedTask = savedConversation(route.groupId!); newTask = newTaskDrafts.get(route.groupId!) || false; materials.reset();
      mentionComposer.setMembers([], route.groupId);
      renderGroupAvatar(byId("group-avatar"), null);
      renderGroupAvatar(byId("group-details-avatar"), null);
      byId("group-title").textContent = "正在读取群组…";
      byId("group-details-name").textContent = ""; byId("group-purpose").textContent = "";
      byId("group-panel-toggle").title = ""; byId("group-title").title = "";
      byId("group-messages").replaceChildren(node("p", "muted-note", "正在加载群消息…"));
      byId("group-tasks").replaceChildren();
    }
    mentionComposer.restore(drafts.get(route.groupId!));
    void load(); pollTimer = setInterval(() => void poll(), 2500);
  }
  controls();
});
document.dispatchEvent(new CustomEvent("neuma:agents-request"));
void list();
