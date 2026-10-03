import { node, renderProjectDetails, renderProjectList, STATUS_LABELS, updateProjectStatus } from "./project-view.js";
import { addUserMessage, createReplyView, mountWelcome, readReply, renderUserMessage } from "./chat-ui.js";

const byId = (id) => document.getElementById(id);
const details = byId("project-details"), input = byId("project-message");
const STATUS_TONE = { running: "running", external: "running", starting: "starting", failed: "failed" };
let projects = [], selectedId = null, renderedId, busy = false, refreshing = false, chatting = false;
let sessionId = crypto.randomUUID(), messages = [];
let pendingReply = null, replyView = null, activeController = null, cancelling = false;
let route = { page: "chat", projectView: "list" };
let contextId = null, listSignature = "";

function showError(target, message = "") { const el = byId(target); el.textContent = message; el.hidden = !message; }
function clearErrors() { for (const id of ["project-error", "add-error", "manage-error"]) showError(id); }
function navigate(detail) { document.dispatchEvent(new CustomEvent("neuma:navigate", { detail })); }
function feedback(message = "") { const el = byId("project-feedback"); el.textContent = message; el.hidden = !message; }

async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "项目操作失败，请重试");
  return result;
}

function openProject(id) {
  selectedId = id; showError("manage-error");
  navigate({ page: "projects", projectView: "list" });
  render();
}

function renderMessages(scrollToEnd = true) {
  const container = byId("project-messages");
  const follow = scrollToEnd || container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  const previousTop = container.scrollTop;
  container.replaceChildren();
  {
    const welcome = node("div", "welcome");
    welcome.append(node("span", "welcome-eyebrow", "好用的工具，随时在手边"));
    const title = node("h2", "welcome-title", "让你的项目，");
    title.append(node("br"), node("span", "", "随时为你所用。"));
    welcome.append(title, node("p", "welcome-description", "给我一个本地路径，我来帮你登记。\n核对启动方式后，一句话就能打开。"));
    const chips = node("div", "suggestions");
    const suggestions = [
      ["添加项目", "关联电脑上的文件夹", () => navigate({ page: "projects", projectView: "add" }), "meeting"],
      ["查找项目", "在左侧搜索名称或用途", () => {
        document.dispatchEvent(new CustomEvent("neuma:project-library-open"));
        byId("project-search").focus({ preventScroll: true });
      }, "report"],
      ["了解使用方式", "看看助手可以帮你做什么", () => {
        const text = "你能帮我做些什么？应该从哪里开始？";
        input.value = input.value.trim() ? `${input.value}\n${text}` : text;
        input.dispatchEvent(new Event("input")); input.focus();
      }, "reply"],
    ];
    for (const [label, description, onClick, icon] of suggestions) {
      const chip = node("button", "suggestion"); chip.type = "button";
      const mark = node("span", `suggestion-icon icon-${icon}`); mark.setAttribute("aria-hidden", "true");
      chip.append(mark, node("strong", "", label), node("small", "", description));
      chip.addEventListener("click", onClick);
      chips.append(chip);
    }
    welcome.append(chips);
    mountWelcome(container, welcome, messages.length > 0);
  }
  for (const message of messages) {
    if (message.role === "user") { container.append(renderUserMessage(message, input)); continue; }
    if (message.status) {
      const view = createReplyView("项目助手"); view.update(message); container.append(view.row);
      if (message.projectId && projects.some((item) => item.id === message.projectId)) {
        const action = node("button", "secondary reply-project-link", "核对启动方式 →"); action.type = "button";
        action.addEventListener("click", () => openProject(message.projectId)); view.row.append(action);
      }
      if (message === pendingReply) replyView = view;
      continue;
    }
    const wrapper = node("div", `message ${message.role}`);
    wrapper.append(node("div", "message-label", message.role === "user" ? "你" : "项目助手"), node("div", "bubble", message.content));
    container.append(wrapper);
  }
  container.scrollTop = follow ? container.scrollHeight : previousTop;
}

function render() {
  const query = byId("project-search").value.trim().toLowerCase();
  const shown = projects.filter((item) => `${item.name} ${item.description ?? ""}`.toLowerCase().includes(query));
  const activeId = route.projectView === "list" || (route.projectView === "add" && !byId("manage-projects").hidden) ? selectedId : null;
  const signature = JSON.stringify([shown, activeId, query, projects.length]);
  if (signature !== listSignature) {
    listSignature = signature;
    renderProjectList({ container: byId("projects-list"), selectedId: activeId, busy: false, projects: shown,
      emptyText: projects.length ? "没有匹配的项目" : "还没有项目",
      onClearSearch: query ? () => { byId("project-search").value = ""; render(); byId("project-search").focus(); } : null,
      onSelect: openProject });
  }
  byId("project-count").textContent = projects.length;
  const project = projects.find((item) => item.id === selectedId);
  if (renderedId !== selectedId) {
    renderedId = selectedId;
    renderProjectDetails({ container: details, project, onConfigure: (body) => runAction("configure", body), onAction: (action) => runAction(action) });
  }
  const state = byId("project-state");
  state.textContent = project ? STATUS_LABELS[project.status] : "未选择";
  state.className = `status ${project ? STATUS_TONE[project.status] ?? "" : ""}`;
  updateProjectStatus(details, project, busy);
  byId("project-ask").hidden = !project;
  const context = projects.find((item) => item.id === contextId);
  byId("project-context").hidden = !context;
  byId("project-context-open").textContent = context?.name ?? "";
  byId("project-assistant-state").textContent = chatting ? "正在回复…" : "用一句话管理项目";
  for (const el of byId("project-add-form").querySelectorAll("input, button")) el.disabled = busy;
  byId("project-send").disabled = byId("project-new-chat").disabled = busy;
  input.disabled = busy && !chatting;
  byId("project-send").hidden = chatting;
  byId("project-cancel").hidden = !chatting;
  byId("project-cancel").disabled = cancelling;
  byId("project-compose-hint").textContent = chatting ? "可以先写下一条消息" : "Enter 发送 · Shift + Enter 换行";
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    projects = (await api("/api/projects")).projects;
    if (!projects.some((item) => item.id === selectedId)) selectedId = projects[0]?.id ?? null;
    render();
  } catch (failure) { showError(route.projectView === "assistant" ? "project-error" : route.projectView === "add" ? "add-error" : "manage-error", failure.message); }
  finally { refreshing = false; }
}

async function runAction(action, body = {}) {
  if (busy || !selectedId) return;
  if (action === "remove" && !window.confirm("移除这条项目记录？原项目文件会保留。")) return;
  const actionId = selectedId;
  busy = true; showError("manage-error"); feedback(); render();
  try {
    await api(`/api/projects/${actionId}/${action}`, action === "remove" ? { confirm: true } : body);
    if (action === "configure" || action === "remove") renderedId = undefined;
    await refresh();
    feedback({ configure: "启动方式已保存", start: "已提交启动，请查看项目状态", stop: "项目已停止", remove: "项目记录已移除，原文件已保留" }[action]);
  } catch (failure) { showError("manage-error", failure.message); }
  finally { busy = false; render(); }
}

byId("project-add-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (busy) return;
  busy = true; showError("add-error"); render();
  try {
    const name = byId("project-name").value.trim(), description = byId("project-description").value.trim();
    const result = await api("/api/projects", { path: byId("project-path").value.trim(),
      ...(name ? { name } : {}), ...(description ? { description } : {}) });
    for (const id of ["project-path", "project-name", "project-description"]) byId(id).value = "";
    await refresh();
    if (route.page === "projects" && route.projectView === "add") {
      byId("project-search").value = ""; renderedId = undefined;
      openProject(result.project.id);
    }
    feedback("项目已添加。核对启动方式后，就可以随时打开。");
  } catch (failure) { showError("add-error", failure.message); }
  finally { busy = false; render(); }
});

byId("project-chat-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (busy || !input.value.trim()) return;
  const message = input.value.trim();
  const context = projects.find((item) => item.id === contextId);
  const requestMessage = context ? `当前项目：${context.name}\n项目路径：${context.path}\n\n${message}` : message;
  const requestSession = sessionId;
  const user = addUserMessage(messages, context ? `关于「${context.name}」\n${message}` : message);
  const reply = { role: "assistant", content: "", status: "thinking" };
  const controller = new AbortController(); activeController = controller;
  messages.push(reply); pendingReply = reply;
  input.value = ""; input.dispatchEvent(new Event("input"));
  busy = chatting = true; showError("project-error"); feedback(); render(); renderMessages();
  input.focus({ preventScroll: true });
  try {
    const response = await fetch("/api/projects/turn", { method: "POST", headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify({ message: requestMessage, sessionId: requestSession }), signal: controller.signal });
    const result = await readReply(response, (progress) => {
      if (requestSession !== sessionId || reply.cancelRequested) return;
      const container = byId("project-messages");
      const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
      if (progress.type === "text-start") { reply.content = ""; reply.status = "thinking"; reply.label = ""; }
      if (progress.type === "text-delta" && typeof progress.delta === "string") { reply.content += progress.delta; reply.status = "writing"; }
      if (progress.type === "status") { reply.status = progress.phase === "tool" ? "tool" : "thinking"; reply.label = progress.label || ""; }
      replyView?.update(reply);
      if (atBottom) container.scrollTop = container.scrollHeight;
    });
    if (requestSession !== sessionId) return;
    user.delivery = "sent";
    Object.assign(reply, { content: result.reply, status: "complete" });
    messages = messages.slice(-80); projects = result.projects;
    const added = result.actions.findLast((item) => item.tool === "add_project");
    if (added) reply.projectId = added.project.id;
  } catch (failure) {
    if (requestSession !== sessionId) return;
    const stopped = failure.reason === "cancelled" || (reply.cancelRequested && failure.name === "AbortError");
    user.delivery = stopped ? "stopped" : "failed";
    reply.status = stopped ? "stopped" : "error";
    reply.error = stopped ? "已执行的项目操作会保留，可在项目列表查看状态。" : failure.message;
    if (!stopped && !input.value.trim()) { input.value = message; input.dispatchEvent(new Event("input")); }
    await refresh();
  } finally {
    if (requestSession === sessionId) {
      busy = chatting = cancelling = false; pendingReply = replyView = activeController = null;
      render(); renderMessages(false);
      if (route.page === "projects" && route.projectView === "assistant") input.focus({ preventScroll: true });
    }
  }
});
byId("project-cancel").addEventListener("click", async () => {
  if (!chatting || cancelling) return;
  const requestSession = sessionId, reply = pendingReply, previous = reply.status, controller = activeController;
  cancelling = true; reply.cancelRequested = true; reply.status = "stopping"; replyView?.update(reply); render();
  try { await api("/api/projects/cancel", { sessionId: requestSession }); controller?.abort(); }
  catch (failure) {
    if (sessionId === requestSession && chatting) { reply.cancelRequested = false; reply.status = previous; replyView?.update(reply); showError("project-error", failure.message); }
  } finally { if (sessionId === requestSession) { cancelling = false; render(); } }
});
byId("project-new-chat").addEventListener("click", () => {
  if (busy) return;
  sessionId = crypto.randomUUID(); messages = []; contextId = null; input.value = ""; showError("project-error"); feedback(); render(); renderMessages(); input.focus();
});
byId("project-ask").addEventListener("click", () => {
  contextId = selectedId; navigate({ page: "projects", projectView: "assistant" }); render();
});
byId("project-context-open").addEventListener("click", () => { if (contextId) openProject(contextId); });
byId("project-context-clear").addEventListener("click", () => { contextId = null; render(); input.focus(); });
byId("project-search").addEventListener("input", render);
byId("project-refresh").addEventListener("click", () => { showError("manage-error"); void refresh(); });

const watching = () => route.page === "projects";
document.addEventListener("neuma:route", (event) => {
  const before = watching();
  route = event.detail;
  render();
  if (watching() && !before) { clearErrors(); void refresh(); }
});
document.addEventListener("neuma:settings-changed", () => {
  activeController?.abort(); activeController = null;
  sessionId = crypto.randomUUID(); messages = []; pendingReply = replyView = null;
  busy = chatting = cancelling = false; render(); renderMessages();
});
setInterval(() => { if (watching() && document.visibilityState === "visible") void refresh(); }, 3000);
render(); renderMessages();
void refresh();
