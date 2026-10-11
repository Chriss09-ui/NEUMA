import { createCollaborationApi } from "./collaboration-api.js";
import { createGroupMaterials } from "./group-materials.js";
import { button, node, notice, renderMembers, renderMessages, renderTasks, terminalTask } from "./group-view.js";

const api = createCollaborationApi(), byId = (id) => document.getElementById(id);
let route = { page: "chat", groupId: null }, groups = [], data = null, requestSequence = 0;
let loading = false, sending = false, selectedTask = "", newTask = false, pollTimer = null, polling = false;
let editing = null, editorTrigger = null, editorSaving = false, editorSequence = 0, editorRetry = null, retry = null;
let listSequence = 0;
const drafts = new Map();
const materials = createGroupMaterials({ api, current: () => data, refresh: load, changed: controls });
const navigate = (detail) => document.dispatchEvent(new CustomEvent("neuma:navigate", { detail }));

function controls() {
  const unavailable = loading || !data?.group || data.group.archived;
  byId("group-send").disabled = Boolean(unavailable || sending || materials.busy());
  byId("group-new-task").disabled = Boolean(unavailable || sending);
  byId("group-message").disabled = Boolean(unavailable || sending);
  byId("group-recipient").disabled = Boolean(unavailable || sending);
  byId("group-compose-status").textContent = data?.group?.archived ? "群已归档，取消归档后可继续协作。"
    : sending ? "正在提交消息…" : newTask || terminalTask(data?.tasks?.find((task) => task.id === selectedTask))
      ? "下一条消息将发起一项新任务。" : "只向群内分享的消息与材料会进入协作。";
}
function renderLibrary() {
  const target = byId("groups-list"), rail = byId("sidebar-group-list"); target.replaceChildren(); rail.replaceChildren();
  const visible = groups.filter((group) => byId("groups-show-archived").checked || !group.archived);
  if (!visible.length) {
    const empty = node("div", "collaboration-empty groups-empty"); empty.append(node("span", "collaboration-empty-mark", "◎"),
      node("h2", "", "把能力组合成一支团队"), node("p", "muted-note", "创建群组、选择智能体，为它们交代一个共同目标。"),
      button("创建第一个群组", () => void editor(null, byId("groups-create")), "primary")); target.append(empty);
  }
  for (const group of visible) {
    const card = node("article", "group-library-card"), title = node("a", "group-library-title", group.name);
    title.href = `#group/${encodeURIComponent(group.id)}`;
    const heading = node("div", "group-library-heading"); heading.append(title, node("span", "identity-badge", group.archived ? "已归档" : "协作群"));
    card.append(heading, node("p", "muted-note", group.purpose || "共同推进工作"),
      node("p", "group-library-meta", `${group.memberIds?.length || 0} 位成员 · ${group.updatedAt ? new Date(group.updatedAt).toLocaleDateString("zh-CN") : "刚刚创建"}`)); target.append(card);
  }
  for (const group of groups.filter((item) => !item.archived)) {
    const link = node("a", "sidebar-group-link", group.name); link.href = `#group/${encodeURIComponent(group.id)}`;
    link.setAttribute("aria-current", route.page === "group" && route.groupId === group.id ? "page" : "false"); rail.append(link);
  }
  notice(byId("sidebar-groups-feedback"), "");
}
async function list() {
  const sequence = ++listSequence;
  try {
    const result = await api.groups(); if (!Array.isArray(result.groups)) throw new Error("群列表尚未确认。");
    if (sequence !== listSequence) return;
    groups = result.groups; renderLibrary(); notice(byId("groups-error"), "");
  } catch (error) {
    if (sequence !== listSequence) return;
    notice(byId("groups-error"), `${error.message} 重新进入群组页面可重试。`, true);
    notice(byId("sidebar-groups-feedback"), "群组暂时无法读取。");
  }
}
function render() {
  if (!data?.group || route.page !== "group" || data.group.id !== route.groupId) return;
  const group = data.group;
  byId("group-title").textContent = group.name; byId("group-purpose").textContent = group.purpose || "群内成员依据自己的能力共同工作";
  byId("group-archived").hidden = !group.archived; byId("group-archive").textContent = group.archived ? "取消归档" : "归档";
  byId("group-member-count").textContent = String(data.members?.length || 0);
  const filter = byId("group-task-filter"); filter.replaceChildren();
  const all = node("option", "", "全部消息"); all.value = ""; filter.append(all);
  for (const task of data.tasks || []) { const option = node("option", "", task.goal || "协作任务"); option.value = task.id; filter.append(option); }
  if (selectedTask && !data.tasks?.some((task) => task.id === selectedTask)) selectedTask = "";
  filter.value = selectedTask;
  const recipient = byId("group-recipient"), previous = recipient.value; recipient.replaceChildren();
  const everyone = node("option", "", "群内成员自主协作"); everyone.value = ""; recipient.append(everyone);
  for (const member of data.members || []) { const option = node("option", "", member.name + (member.ready ? "" : "（未就绪）")); option.value = member.id; option.disabled = !member.ready; recipient.append(option); }
  if (data.members?.some((member) => member.id === previous && member.ready)) recipient.value = previous;
  renderMessages(byId("group-messages"), data.messages || [], selectedTask, data.members || []);
  renderMembers(byId("group-members"), data.members || []);
  renderTasks(byId("group-tasks"), data.tasks || [], selectedTask, { onSelect: chooseTask, onStop: stop, members: data.members || [] });
  materials.render(); controls();
}
async function load(id = route.groupId, { quiet = false } = {}) {
  if (!id) return;
  const sequence = ++requestSequence;
  if (!quiet) { loading = true; controls(); }
  try {
    const result = await api.group(id);
    if (requestSequence !== sequence || route.page !== "group" || route.groupId !== id) return;
    if (result.group?.id !== id) throw new Error("群组身份尚未确认，请重试。");
    data = result; notice(byId("group-error"), ""); render();
  } catch (error) { if (requestSequence === sequence && route.groupId === id) notice(byId("group-error"), `${error.message} 点击右侧刷新重试。`, true); }
  finally { if (sequence === requestSequence) { loading = false; controls(); } }
}
function chooseTask(id) { selectedTask = id; newTask = false; render(); byId("group-message").focus(); }
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
  finally { sending = false; controls(); if (route.page === "group" && route.groupId === id) byId("group-message").focus(); }
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
      const copy = node("span"); copy.append(node("strong", "", agent.name), node("small", "muted-note", agent.ready ? agent.description || "已通过运行检查" : "尚未就绪"));
      label.append(input, copy); target.append(label);
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
byId("group-task-filter").addEventListener("change", (event) => chooseTask(event.target.value));
byId("group-new-task").addEventListener("click", () => { newTask = true; selectedTask = ""; render(); byId("group-message").focus(); });
byId("group-edit").addEventListener("click", () => void editor(data?.group, byId("group-edit")));
byId("group-refresh").addEventListener("click", () => void load());
byId("group-archive").addEventListener("click", () => void archive());
byId("groups-show-archived").addEventListener("change", renderLibrary);
for (const id of ["groups-create", "sidebar-create-group"]) byId(id).addEventListener("click", () => void editor(null, byId(id)));
document.addEventListener("neuma:create-group", () => void editor(null, byId("main-create-group")));
document.addEventListener("neuma:groups-changed", () => void list());
byId("group-editor-form").addEventListener("submit", (event) => { event.preventDefault(); void saveEditor(); });
byId("group-editor-close").addEventListener("click", closeEditor);
byId("group-editor").addEventListener("cancel", (event) => { event.preventDefault(); closeEditor(); });
document.addEventListener("neuma:route", (event) => {
  if (route.page === "group" && route.groupId) drafts.set(route.groupId, byId("group-message").value);
  const previous = route.groupId; route = event.detail; clearInterval(pollTimer); pollTimer = null; requestSequence++;
  renderLibrary();
  if (route.page === "groups") void list();
  if (route.page === "group") {
    if (previous !== route.groupId) {
      data = null; selectedTask = ""; newTask = false; materials.reset();
      byId("group-title").textContent = "正在读取群组…"; byId("group-purpose").textContent = "";
      byId("group-messages").replaceChildren(node("p", "muted-note", "正在加载群消息…"));
      byId("group-members").replaceChildren(); byId("group-tasks").replaceChildren();
    }
    byId("group-message").value = drafts.get(route.groupId) || "";
    void load(); pollTimer = setInterval(() => void poll(), 2500);
  }
});
void list();
