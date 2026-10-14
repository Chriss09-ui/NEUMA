import { createCollaborationApi } from "./collaboration-api.js";
import { createGroupMaterials } from "./group-materials.js";
import { renderAgentAvatar } from "./agent-avatar.js";
import { renderGroupAvatar } from "./group-avatar.js";
import { createSelectMenu } from "./select-menu.js";
import { createSidebarHistory } from "./sidebar-history.js";
import { button, node, notice, renderMembers, renderMessages, renderTasks, terminalTask } from "./group-view.js";

const api = createCollaborationApi(), byId = (id) => document.getElementById(id);
const groupPanel = byId("group-panel"), groupShell = byId("group-page-shell"), groupMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let route = { page: "chat", groupId: null }, groups = [], data = null, requestSequence = 0;
let loading = false, sending = false, selectedTask = "", newTask = false, pollTimer = null, polling = false;
let editing = null, editorTrigger = null, editorSaving = false, editorSequence = 0, editorRetry = null, retry = null;
let listSequence = 0;
let settingsGroupId = null, settingsSequence = 0, settingsTimer = null, removeSettingsListener = null;
const drafts = new Map();
const avatarMembers = new Map();
const sidebarGroups = new Map(), taskHistories = new Map(), taskHistorySequences = new Map();
const collapsedGroups = new Map();
const COLLAPSED_GROUP_LIMIT = 2;
let pendingSidebarTask = null;
const materials = createGroupMaterials({ api, current: () => data, refresh: load, changed: controls });
const navigate = (detail) => document.dispatchEvent(new CustomEvent("neuma:navigate", { detail }));
const recipientMenu = createSelectMenu({ select: byId("group-recipient"), trigger: byId("group-recipient-trigger"),
  menu: byId("group-recipient-menu"), value: byId("group-recipient-value"), icon: byId("group-recipient-icon"),
  renderIcon: renderRecipientIcon, document, window });

function renderRecipientIcon(target, option) {
  target.replaceChildren(); target.classList.remove("group-avatar", "has-star-avatar");
  delete target.dataset.avatarKey; delete target.dataset.groupAvatarKey;
  if (option.value) renderAgentAvatar(target, data?.members?.find((member) => member.id === option.value)
    ?? { id: option.value }, { motion: false });
  else renderGroupAvatar(target, data?.group, data?.members || []);
}

function rememberAvatars(members = []) {
  let changed = false;
  for (const member of members) {
    if (typeof member?.id !== "string" || (!member.profile && avatarMembers.has(member.id))) continue;
    const icon = typeof member.profile?.icon === "string" ? member.profile.icon : "";
    if (avatarMembers.get(member.id)?.profile.icon === icon) continue;
    avatarMembers.set(member.id, { id: member.id, profile: { icon } }); changed = true;
  }
  return changed;
}
function groupAvatar(group, className) {
  const avatar = node("span", className); renderGroupAvatar(avatar, group, [...avatarMembers.values()]); return avatar;
}
function renderGroupIdentity() {
  if (data?.group?.id !== route.groupId) return;
  for (const id of ["group-avatar", "group-details-avatar"]) renderGroupAvatar(byId(id), data.group, [...avatarMembers.values()]);
}
function syncAvatars(members) {
  if (!rememberAvatars(members)) return;
  renderLibrary(); renderGroupIdentity();
}

function controls() {
  const unavailable = loading || !data?.group || data.group.archived;
  byId("group-send").disabled = Boolean(unavailable || sending || materials.busy());
  byId("group-new-task").disabled = Boolean(unavailable || sending);
  byId("group-message").disabled = Boolean(unavailable || sending);
  byId("group-panel-toggle").disabled = route.page !== "group" || data?.group?.id !== route.groupId;
  materials.syncControls();
  byId("group-recipient").disabled = Boolean(unavailable || sending);
  recipientMenu.refresh();
  const status = byId("group-compose-status");
  status.textContent = data?.group?.archived ? "群已归档，取消归档后可继续协作。"
    : sending ? "正在提交消息…" : "";
  status.hidden = !status.textContent;
}

function cancelSettingsTransition() {
  const sequence = ++settingsSequence;
  if (settingsTimer !== null) clearTimeout(settingsTimer);
  settingsTimer = null; removeSettingsListener?.(); removeSettingsListener = null;
  return sequence;
}
function finishSettingsTransition(sequence) {
  if (sequence !== settingsSequence) return;
  if (settingsTimer !== null) clearTimeout(settingsTimer);
  settingsTimer = null; removeSettingsListener?.(); removeSettingsListener = null;
  groupShell.classList.remove("is-settings-animating"); groupPanel.hidden = !settingsGroupId;
}
function settingsVisibility(active, { animate = true } = {}) {
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
  const ended = (event) => {
    if (event.target === groupShell && event.propertyName === "grid-template-columns") finishSettingsTransition(sequence);
  };
  groupShell.addEventListener("transitionend", ended);
  removeSettingsListener = () => groupShell.removeEventListener("transitionend", ended);
  settingsTimer = setTimeout(() => finishSettingsTransition(sequence), duration + 50);
}
function selectSettingsTab(next) {
  groupPanel.dataset.view = next;
  for (const tab of ["profile", "members", "tasks"]) {
    byId(`group-details-${tab}`).hidden = tab !== next;
    byId(`group-details-${tab}-tab`).setAttribute("aria-pressed", String(tab === next));
  }
}
function openSettings({ focus = true } = {}) {
  if (route.page !== "group" || data?.group?.id !== route.groupId) return;
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

function settingsFocus() {
  const focused = document.activeElement;
  if (!settingsGroupId || !groupPanel.contains(focused)) return null;
  for (const [kind, key] of [["members", "memberId"], ["tasks", "taskId"]]) {
    const card = [...byId(`group-${kind}`).children].find((item) => item.contains(focused));
    if (card?.dataset[key]) return { kind, id: card.dataset[key], first: card.children[0].contains(focused) };
  }
  return null;
}
function restoreSettingsFocus(focused) {
  if (!focused || settingsGroupId !== route.groupId) return;
  const key = focused.kind === "members" ? "memberId" : "taskId";
  const card = [...byId(`group-${focused.kind}`).children].find((item) => item.dataset[key] === focused.id);
  const target = focused.first ? card?.children[0] : card?.children[card.children.length - 1];
  (target && ["BUTTON", "A", "SUMMARY"].includes(target.tagName) && !target.disabled ? target
    : byId(`group-details-${focused.kind}-tab`)).focus({ preventScroll: true });
}
function taskHistorySequence(id) {
  const sequence = (taskHistorySequences.get(id) || 0) + 1;
  taskHistorySequences.set(id, sequence); return sequence;
}
function rememberTaskHistory(result) {
  const id = result.group.id;
  taskHistorySequence(id);
  taskHistories.set(id, { tasks: Array.isArray(result.tasks) ? result.tasks : [],
    stamp: result.group.updatedAt || result.group.lastSequence || "", loading: false, error: "" });
}
async function loadTaskHistory(id) {
  const cached = taskHistories.get(id);
  if (cached?.loading || cached?.tasks || (route.page === "group" && route.groupId === id)) return;
  if (!groups.some((group) => group.id === id && !group.archived)) return;
  const sequence = taskHistorySequence(id);
  taskHistories.set(id, { loading: true, error: "" }); renderSidebarGroups();
  try {
    const result = await api.group(id);
    if (taskHistorySequences.get(id) !== sequence || !groups.some((group) => group.id === id && !group.archived)) return;
    if (result.group?.id !== id || !Array.isArray(result.tasks)) throw new Error("群历史尚未确认，请重试。");
    rememberTaskHistory(result); rememberAvatars(result.members); renderLibrary();
  } catch (error) {
    if (taskHistorySequences.get(id) !== sequence || !sidebarGroups.has(id)) return;
    taskHistories.set(id, { loading: false, error: `${error.message} 收起后展开可重试。` }); renderSidebarGroups();
  }
}
function openSidebarGroup(id, taskId) {
  if (route.page === "group" && route.groupId === id && data?.group?.id === id) {
    pendingSidebarTask = null; if (taskId !== undefined) chooseTask(taskId, { focus: false }); return;
  }
  pendingSidebarTask = { groupId: id, taskId };
  navigate({ page: "group", groupId: id });
}
function renderCollapsedGroups(visible) {
  const rail = byId("sidebar-group-rail"), shown = visible.slice(0, COLLAPSED_GROUP_LIMIT);
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
  if (shown.some((group, index) => rail.children[index] !== collapsedGroups.get(group.id).link)) {
    const focused = rail.contains(document.activeElement) ? document.activeElement : null;
    for (const group of shown) rail.append(collapsedGroups.get(group.id).link);
    focused?.focus({ preventScroll: true });
  }
}
function renderSidebarGroups() {
  const rail = byId("sidebar-group-list"), visible = groups.filter((group) => !group.archived);
  const ids = new Set(visible.map((group) => group.id));
  for (const [id, entry] of sidebarGroups) {
    if (ids.has(id)) continue;
    entry.root.remove(); sidebarGroups.delete(id); taskHistories.delete(id); taskHistorySequence(id);
  }
  for (const group of visible) {
    let entry = sidebarGroups.get(group.id);
    if (!entry) {
      entry = createSidebarHistory({ document, id: `group-${group.id}`, title: group.name,
        href: `#group/${encodeURIComponent(group.id)}`, icon: groupAvatar(group, "sidebar-group-avatar"),
        className: "sidebar-group-link", onExpand: (expanded) => { if (expanded) void loadTaskHistory(group.id); },
        onOpen: () => openSidebarGroup(group.id, ""), storage: localStorage });
      entry.root.dataset.groupId = group.id; sidebarGroups.set(group.id, entry);
    }
    renderGroupAvatar(entry.icon, group, [...avatarMembers.values()]);
    const current = route.page === "group" && route.groupId === group.id, history = taskHistories.get(group.id);
    entry.update({ title: group.name, active: current,
      records: [...(history?.tasks || [])].reverse(),
      status: history?.loading ? "正在读取历史…" : history?.error || (history?.tasks?.length === 0 ? "还没有任务对话" : ""),
      renderRow: (task) => {
        const row = button(task.goal || "协作任务", () => openSidebarGroup(group.id, task.id), "sidebar-history-item");
        row.dataset.taskId = task.id; row.title = task.goal || "协作任务";
        row.setAttribute("aria-current", current && selectedTask === task.id ? "page" : "false"); return row;
      } });
    if (entry.root.parentNode !== rail) rail.append(entry.root);
  }
  if (visible.some((group, index) => rail.children[index] !== sidebarGroups.get(group.id).root)) {
    const focused = rail.contains(document.activeElement) ? document.activeElement : null;
    for (const group of visible) rail.append(sidebarGroups.get(group.id).root);
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
  } catch (error) {
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
  byId("group-member-count").textContent = String(data.members?.length || 0);
  if (selectedTask && !data.tasks?.some((task) => task.id === selectedTask)) selectedTask = "";
  const recipient = byId("group-recipient"), previous = recipient.value; recipient.replaceChildren();
  const everyone = node("option", "", "群内协作"); everyone.value = ""; recipient.append(everyone);
  for (const member of data.members || []) { const option = node("option", "", member.name + (member.ready ? "" : "（未就绪）")); option.value = member.id; option.disabled = !member.ready; recipient.append(option); }
  if (data.members?.some((member) => member.id === previous && member.ready)) recipient.value = previous;
  renderMessages(byId("group-messages"), data.messages || [], selectedTask, data.members || [], data.tasks || []);
  renderMembers(byId("group-members"), data.members || []);
  renderTasks(byId("group-tasks"), data.tasks || [], selectedTask, { onSelect: chooseTask, onStop: stop, members: data.members || [] });
  for (const [index, task] of [...(data.tasks || [])].reverse().entries()) byId("group-tasks").children[index].dataset.taskId = task.id;
  materials.render(); controls(); renderSidebarGroups(); restoreSettingsFocus(focused);
}
async function load(id = route.groupId, { quiet = false } = {}) {
  if (!id) return;
  const sequence = ++requestSequence;
  const historySequence = taskHistorySequence(id);
  const history = taskHistories.get(id);
  if (!quiet) { taskHistories.set(id, { ...history, loading: true, error: "" }); renderSidebarGroups(); }
  if (!quiet) { loading = true; controls(); }
  try {
    const result = await api.group(id);
    if (result.group?.id !== id) throw new Error("群组身份尚未确认，请重试。");
    if (taskHistorySequences.get(id) === historySequence
      && groups.some((group) => group.id === id && !group.archived)) {
      rememberTaskHistory(result); renderSidebarGroups();
    }
    if (requestSequence !== sequence || route.page !== "group" || route.groupId !== id) return;
    data = result;
    if (pendingSidebarTask?.groupId === id) {
      selectedTask = result.tasks?.some((task) => task.id === pendingSidebarTask.taskId) ? pendingSidebarTask.taskId : "";
      newTask = false; pendingSidebarTask = null;
    }
    if (rememberAvatars(result.members)) renderLibrary();
    notice(byId("group-error"), ""); render();
  } catch (error) {
    if (taskHistorySequences.get(id) === historySequence && sidebarGroups.has(id)) {
      taskHistories.set(id, { ...history, loading: false, error: `${error.message} 点击群设置中的刷新重试。` }); renderSidebarGroups();
    }
    if (requestSequence === sequence && route.groupId === id) notice(byId("group-error"), `${error.message} 点击右侧刷新重试。`, true);
  }
  finally { if (sequence === requestSequence) { loading = false; controls(); } }
}
function chooseTask(id, { focus = true } = {}) {
  const inSettings = settingsGroupId && groupPanel.contains(document.activeElement);
  selectedTask = id; newTask = false; render(); if (focus && !inSettings) byId("group-message").focus();
}
async function stop(taskId) {
  const id = data?.group?.id; if (!id) return;
  try { await api.cancelTask(id, taskId); await load(id); }
  catch (error) { if (route.groupId === id) notice(byId("group-error"), `停止尚未确认：${error.message}`, true); }
}
async function send() {
  const id = data?.group?.id;
  const refs = materials.refs();
  const content = byId("group-message").value.trim() || (refs.length ? "请处理这些共享材料，任务目标不明确时先向我提问。" : "");
  if (!id || (!content && !refs.length) || loading || sending || data.group.archived || materials.busy()) return;
  const taskId = selectedTask || data.group.activeTaskId;
  const startNew = newTask || !taskId || terminalTask(data.tasks?.find((task) => task.id === taskId));
  const body = { content, ...(taskId && !startNew ? { taskId } : {}), ...(byId("group-recipient").value ? { recipientId: byId("group-recipient").value } : {}),
    newTask: startNew, ...(refs.length ? { attachmentIds: refs } : {}) };
  const fingerprint = JSON.stringify(body), request = retry?.id === id && retry.fingerprint === fingerprint
    ? retry.body : { ...body, mutationId: crypto.randomUUID() };
  retry = { id, fingerprint, body: request }; sending = true; controls(); notice(byId("group-error"), "");
  try {
    const result = await api.send(id, request);
    if (!result.message?.id) throw new Error("消息发送尚未确认，请重试。");
    retry = null;
    if (route.groupId !== id) return;
    byId("group-message").value = ""; drafts.delete(id); materials.consume(); newTask = false;
    if (result.task?.id && body.newTask) selectedTask = result.task.id;
    await load(id); await list();
  } catch (error) { if (route.groupId === id) notice(byId("group-error"), `${error.message} 当前消息与材料仍保留，可重试。`, true); }
  finally {
    sending = false; controls();
    const focused = document.activeElement;
    if (route.page === "group" && route.groupId === id && (!focused || focused === document.body
      || focused === byId("group-send") || focused === byId("group-message"))) byId("group-message").focus();
  }
}
async function editor(group = null, trigger = byId("groups-create")) {
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
  } catch (error) { if (sequence === editorSequence) notice(byId("group-editor-error"), error.message, true); }
}
function closeEditor() { if (editorSaving) return; editorSequence++; byId("group-editor").close(); editorTrigger?.focus(); }
async function saveEditor() {
  if (editorSaving) return;
  const memberIds = [...byId("group-member-picker").querySelectorAll("input:checked")].map((input) => input.value);
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
  } catch (error) { notice(byId("group-editor-error"), `${error.message} 编辑内容已保留。`, true); }
  finally { editorSaving = false; byId("group-editor-save").disabled = false; }
}
async function archive() {
  const group = data?.group; if (!group) return;
  byId("group-archive").disabled = true;
  try { await api.updateGroup(group.id, { archived: !group.archived, expectedVersion: group.version, mutationId: crypto.randomUUID() }); await load(group.id); await list(); }
  catch (error) { notice(byId("group-error"), error.message, true); }
  finally { byId("group-archive").disabled = false; }
}
async function poll() {
  if (polling || route.page !== "group" || !data || document.hidden) return;
  const id = data.group.id, after = data.lastSequence ?? data.group.lastSequence ?? 0; polling = true;
  try { const result = await api.events(id, after); if (route.page === "group" && route.groupId === id && (result.events?.length || result.lastSequence > after)) await load(id, { quiet: true }); }
  catch (error) { if (route.groupId === id) notice(byId("group-error"), `进度同步暂时中断：${error.message} 将自动重试。`, true); }
  finally { polling = false; }
}
byId("group-chat-form").addEventListener("submit", (event) => { event.preventDefault(); void send(); });
byId("group-new-task").addEventListener("click", () => { newTask = true; selectedTask = ""; render(); byId("group-message").focus(); });
byId("group-edit").addEventListener("click", () => void editor(data?.group, byId("group-edit")));
byId("group-refresh").addEventListener("click", () => void load());
byId("group-archive").addEventListener("click", () => void archive());
byId("group-panel-toggle").addEventListener("click", () => settingsGroupId ? closeSettings() : openSettings());
byId("group-details-close").addEventListener("click", () => closeSettings());
byId("group-files-open").addEventListener("click", () => openSettings({ focus: false }));
for (const tab of ["profile", "members", "tasks"]) byId(`group-details-${tab}-tab`).addEventListener("click", () => selectSettingsTab(tab));
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented || !settingsGroupId || document.querySelector("dialog[open]")) return;
  event.preventDefault(); closeSettings();
});
byId("groups-show-archived").addEventListener("change", renderLibrary);
for (const id of ["groups-create", "sidebar-create-group"]) byId(id).addEventListener("click", () => void editor(null, byId(id)));
document.addEventListener("neuma:create-group", () => void editor(null, byId("main-create-group")));
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
  closeSettings({ restoreFocus: false, animate: false });
  recipientMenu.close();
  if (route.page === "group" && route.groupId) drafts.set(route.groupId, byId("group-message").value);
  const previous = route.groupId; route = event.detail; clearInterval(pollTimer); pollTimer = null; requestSequence++;
  if (pendingSidebarTask && (route.page !== "group" || route.groupId !== pendingSidebarTask.groupId)) pendingSidebarTask = null;
  renderLibrary();
  if (route.page === "groups") void list();
  if (route.page === "group") {
    sidebarGroups.get(route.groupId)?.setExpanded(true);
    if (previous !== route.groupId) {
      data = null; selectedTask = ""; newTask = false; materials.reset();
      byId("group-recipient").value = "";
      renderGroupAvatar(byId("group-avatar"), null);
      renderGroupAvatar(byId("group-details-avatar"), null);
      byId("group-title").textContent = "正在读取群组…";
      byId("group-details-name").textContent = ""; byId("group-purpose").textContent = "";
      byId("group-panel-toggle").title = ""; byId("group-title").title = "";
      byId("group-messages").replaceChildren(node("p", "muted-note", "正在加载群消息…"));
      byId("group-members").replaceChildren(); byId("group-tasks").replaceChildren();
    }
    byId("group-message").value = drafts.get(route.groupId) || "";
    void load(); pollTimer = setInterval(() => void poll(), 2500);
  }
});
document.dispatchEvent(new CustomEvent("neuma:agents-request"));
void list();
