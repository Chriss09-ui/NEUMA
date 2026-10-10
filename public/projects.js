import { node, nuemaText, renderProjectDetails, renderProjectList, STATUS_LABELS, updateProjectStatus } from "./project-view.js";
import { addUserMessage, createReplyView, mountWelcome, readReply, renderUserMessage } from "./chat-ui.js";

const byId = (id) => document.getElementById(id);
const details = byId("project-details"), input = byId("project-message");
const STATUS_TONE = { running: "running", external: "running", starting: "starting", failed: "failed" };
let projects = [], selectedId = null, renderedId, busy = false, refreshing = false, chatting = false;
let sessionId = crypto.randomUUID(), messages = [];
let pendingReply = null, replyView = null, activeController = null, cancelling = false;
let route = { page: "chat", projectView: "list" };
let contextId = null, listSignature = "";
let folderController = null, suggestedProjectName = "";
let adding = false, addFailed = false, renderedConfiguration;
let listVersion = 0;
let inspectingId = null;

function showError(target, message = "") { const el = byId(target); el.textContent = nuemaText(message); el.hidden = !message; }
function clearErrors() { for (const id of ["project-error", "add-error", "manage-error"]) showError(id); }
function navigate(detail) { document.dispatchEvent(new CustomEvent("neuma:navigate", { detail })); }
function feedback(message = "") { const el = byId("project-feedback"); el.textContent = nuemaText(message); el.hidden = !message; }
function displayedReply(reply) { return { ...reply, content: nuemaText(reply.content), label: nuemaText(reply.label), error: nuemaText(reply.error) }; }

function addFailureMessage(failure) {
  if (failure?.diagnostic && typeof failure.message === "string") {
    return /^添加失败/.test(failure.message) ? failure.message : `添加失败：${failure.message.replace(/[。.!！\s]+$/, "")}。项目未加入列表。`;
  }
  if (/failed to fetch|fetch failed|load failed|network|连接中断/i.test(failure?.message ?? "")) {
    return "添加失败：与本机服务的连接中断，请确认 NEUMA 正在运行后重试。";
  }
  return "添加失败：项目检查未完成，请稍后重试。项目未加入列表。";
}

async function api(path, body) {
  const setup = body !== undefined && (path === "/api/projects" || path.endsWith("/inspect"));
  const response = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json", ...(setup ? { accept: "application/x-ndjson" } : {}) }, body: JSON.stringify(body) });
  if (setup) return readReply(response, (event) => {
    if (event.type !== "status" || !event.label) return;
    if (adding) byId("project-folder-status").textContent = nuemaText(event.label);
    else feedback(event.label);
  }, { incompleteMessage: path === "/api/projects" ? "添加连接中断，请稍后重试。" : "项目检查连接中断，可以在详情中重新识别。",
    isComplete: (result) => typeof result?.project?.id === "string" });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || "项目操作失败，请重试"), { code: result.code });
  return result;
}

function openProject(id) {
  selectedId = id; showError("manage-error");
  navigate({ page: "projects", projectView: "list" });
  render();
}

function removeFromView(id) {
  listVersion++;
  projects = projects.filter((project) => project.id !== id);
  if (contextId === id) contextId = null;
  if (selectedId === id) {
    selectedId = null; renderedId = undefined;
    if (route.page === "projects" && route.projectView === "list") navigate({ page: "projects", projectView: "assistant" });
  }
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
    welcome.append(title, node("p", "welcome-description", "给我一个本地路径，我来识别和配置。\n准备好后，一句话就能打开。"));
    const chips = node("div", "suggestions");
    const suggestions = [
      ["添加项目", "关联电脑上的文件夹", () => navigate({ page: "projects", projectView: "add" }), "meeting"],
      ["查找项目", "在左侧搜索名称或用途", () => {
        document.dispatchEvent(new CustomEvent("neuma:project-library-open"));
        byId("project-search").focus({ preventScroll: true });
      }, "report"],
      ["运行与端口", "查看已启动项目与端口占用", () => byId("project-runtime-open").click(), "reply"],
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
      const view = createReplyView("项目助手"); view.update(displayedReply(message)); container.append(view.row);
      if (message.projectId && projects.some((item) => item.id === message.projectId)) {
        const action = node("button", "secondary reply-project-link", "查看项目 →"); action.type = "button";
        action.addEventListener("click", () => openProject(message.projectId)); view.row.append(action);
      }
      if (message === pendingReply) replyView = view;
      continue;
    }
    const wrapper = node("div", `message ${message.role}`);
    wrapper.setAttribute("role", "group");
    wrapper.setAttribute("aria-label", "项目助手的回复");
    wrapper.append(node("div", "bubble", nuemaText(message.content)));
    container.append(wrapper);
  }
  container.scrollTop = follow ? container.scrollHeight : previousTop;
}

function render() {
  const query = byId("project-search").value.trim().toLowerCase();
  const presented = projects.map((item) => item.id === inspectingId
    ? { ...item, canLaunch: false, setup: { status: "checking", summary: "NEUMA 正在检查最新的项目说明和启动入口…" } } : item);
  const shown = presented.filter((item) => `${item.name} ${item.description ?? ""}`.toLowerCase().includes(query));
  const activeId = route.projectView === "list" || (route.projectView === "add" && !byId("manage-projects").hidden) ? selectedId : null;
  const signature = JSON.stringify([shown, activeId, query, projects.length, busy]);
  if (signature !== listSignature) {
    listSignature = signature;
    renderProjectList({ container: byId("projects-list"), selectedId: activeId, busy: false, projects: shown,
      emptyText: projects.length ? "没有匹配的项目" : "还没有项目",
      onClearSearch: query ? () => { byId("project-search").value = ""; render(); byId("project-search").focus(); } : null,
      onSelect: openProject, onInspect: (id) => runAction("inspect", {}, id), removeDisabled: busy, onRemove: (id) => runAction("remove", {}, id) });
  }
  byId("project-count").textContent = projects.length;
  const project = presented.find((item) => item.id === selectedId);
  const configuration = JSON.stringify([project?.setup, project?.launch, project?.allowLaunch, project?.root]);
  if (renderedId !== selectedId || renderedConfiguration !== configuration) {
    renderedId = selectedId;
    renderedConfiguration = configuration;
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
  byId("project-choose-folder").disabled = busy || Boolean(folderController);
  byId("project-choose-folder").textContent = folderController ? "选择中…" : byId("project-path").value ? "重新选择" : "选择文件夹";
  byId("project-path").disabled = busy || Boolean(folderController);
  byId("project-add-submit").disabled = busy || Boolean(folderController);
  byId("project-add-submit").textContent = adding ? "正在识别…" : addFailed ? "重试添加" : "添加并自动配置";
  byId("project-add-form").setAttribute("aria-busy", String(adding));
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
  const version = listVersion;
  try {
    const result = await api("/api/projects");
    if (version !== listVersion) return;
    projects = result.projects;
    if (!projects.some((item) => item.id === selectedId)) selectedId = projects[0]?.id ?? null;
    render();
  } catch (failure) { showError(route.projectView === "assistant" ? "project-error" : route.projectView === "add" ? "add-error" : "manage-error", failure.message); }
  finally { refreshing = false; }
}

async function runAction(action, body = {}, actionId = selectedId) {
  if (busy || !actionId) return;
  const target = projects.find((project) => project.id === actionId);
  if (action === "remove" && (!target || !window.confirm(`删除项目“${target.name}”？\n\n只从 NEUMA 中移除，电脑上的项目文件不会删除。${target.canStop ? "\n由 NEUMA 启动的这个项目也会停止运行。" : ""}${target.setup?.status === "checking" ? "\n当前项目检查也会停止。" : ""}`))) return;
  if (action === "inspect") {
    if (!target || target.canStop || target.setup?.status === "checking") return;
    openProject(actionId); inspectingId = actionId;
  }
  busy = true; clearErrors(); feedback(); render();
  try {
    let result;
    try { result = await api(`/api/projects/${actionId}/${action}`, action === "remove" ? { confirm: true } : body); }
    catch (failure) {
      if (action !== "remove" || failure.code !== "PROJECT_REMOVE_STOP_FAILED") throw failure;
      const message = `无法停止“${target.name}”。\n\n${nuemaText(failure.message)}\n\n是否仅从 NEUMA 中移除这个项目？本地文件不会删除。`;
      if (!window.confirm(message)) {
        showError("manage-error", "已保留项目记录。停止未完成，可以修复停止脚本后重试，或再次删除并选择仅移除记录。");
        await refresh(); return;
      }
      result = await api(`/api/projects/${actionId}/remove`, { confirm: true, removeOnly: true });
    }
    if (action === "remove") removeFromView(actionId);
    if (action === "inspect") {
      listVersion++;
      projects = projects.map((project) => project.id === actionId ? result.project : project);
    }
    if (["configure", "inspect", "remove"].includes(action)) renderedId = undefined;
    await refresh();
    feedback(action === "inspect" ? result.project.canLaunch ? "NEUMA 已更新启动方式，可以打开项目了。"
      : result.project.setup?.status === "paused" ? "检查已暂停，可以稍后继续。" : "项目检查已结束，请查看下方结果。"
      : { configure: "启动方式已保存", start: "", stop: "项目已停止", remove: result.project?.servicesMayBeRunning
        ? `已移除“${target?.name}”，本地文件已保留。未能停止的服务可能仍在运行，可在“运行与端口”中查看。`
        : `已删除“${target?.name}”，本地项目文件已保留。` }[action]);
    if (action === "remove") byId("project-assistant-home").focus({ preventScroll: true });
  } catch (failure) { showError(route.projectView === "assistant" ? "project-error" : "manage-error", failure.message); }
  finally { inspectingId = null; busy = false; render(); }
}

async function chooseProjectFolder() {
  if (busy || folderController || route.page !== "projects" || route.projectView !== "add") return;
  const controller = new AbortController();
  let focusId = "project-path";
  folderController = controller;
  showError("add-error");
  byId("project-folder-status").textContent = "请在系统窗口中选择项目文件夹…";
  render();
  try {
    const response = await fetch("/api/projects/pick-folder", { method: "POST",
      headers: { "content-type": "application/json" }, body: "{}", signal: controller.signal });
    const result = await response.json();
    if (controller.signal.aborted || folderController !== controller) return;
    if (!response.ok) throw new Error(result.error || "暂时无法选择文件夹，请手动填写路径。");
    if (result.cancelled) {
      byId("project-folder-status").textContent = "已取消选择。可以重新选择，也可以直接填写本机路径。";
      focusId = "project-choose-folder";
      return;
    }
    if (typeof result.path !== "string" || !result.path) throw new Error("没有取得文件夹路径，请重新选择。");
    byId("project-path").value = result.path;
    addFailed = false;
    const name = byId("project-name");
    if (!name.value.trim() || name.value === suggestedProjectName) name.value = result.name || "";
    suggestedProjectName = result.name || "";
    byId("project-folder-status").textContent = "文件夹已选好，NEUMA 会自动检查项目并配置启动方式。";
    focusId = "project-add-submit";
  } catch (error) {
    if (controller.signal.aborted || folderController !== controller) return;
    showError("add-error", error.message);
    byId("project-folder-status").textContent = "也可以直接粘贴项目的完整路径。";
  } finally {
    if (folderController === controller) {
      folderController = null; render(); byId(focusId).focus({ preventScroll: true });
    }
  }
}
byId("project-choose-folder").addEventListener("click", chooseProjectFolder);
byId("project-path").addEventListener("input", () => {
  addFailed = false; showError("add-error");
  byId("project-folder-status").textContent = "只需提供路径，NEUMA 会检查项目说明和入口，自动配置启动方式。";
  render();
});

byId("project-add-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (busy || folderController) return;
  busy = adding = true; addFailed = false; showError("add-error"); feedback();
  byId("project-folder-status").textContent = "正在添加并检查项目…"; render();
  try {
    const name = byId("project-name").value.trim(), description = byId("project-description").value.trim();
    const result = await api("/api/projects", { path: byId("project-path").value.trim(),
      ...(name ? { name } : {}), ...(description ? { description } : {}) });
    if (!result.project?.id || result.project.canLaunch !== true) throw new Error("添加未完成");
    listVersion++;
    projects = projects.some((project) => project.id === result.project.id)
      ? projects.map((project) => project.id === result.project.id ? result.project : project) : [...projects, result.project];
    for (const id of ["project-path", "project-name", "project-description"]) byId(id).value = "";
    suggestedProjectName = "";
    byId("project-folder-status").textContent = "选择项目所在的文件夹，也可以直接填写本机路径。";
    await refresh();
    if (route.page === "projects" && route.projectView === "add") {
      byId("project-search").value = ""; renderedId = undefined;
      openProject(result.project.id);
    }
    feedback("项目已添加，启动方式已配好。点击“打开项目”即可使用。");
  } catch (failure) {
    addFailed = true;
    const message = addFailureMessage(failure);
    showError("add-error", message);
    byId("project-folder-status").textContent = "输入已保留，可以稍后直接重试。";
    if (route.page === "projects" && route.projectView !== "add") feedback(message);
  }
  finally { busy = adding = false; render(); }
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
      replyView?.update(displayedReply(reply));
      if (atBottom) container.scrollTop = container.scrollHeight;
    });
    if (requestSession !== sessionId) return;
    user.delivery = "sent";
    Object.assign(reply, { content: result.reply, status: "complete" });
    messages = messages.slice(-80); projects = result.projects; listVersion++;
    for (const action of result.actions) if (action.tool === "remove_project" && action.project.removed) removeFromView(action.project.id);
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
  cancelling = true; reply.cancelRequested = true; reply.status = "stopping"; replyView?.update(displayedReply(reply)); render();
  try { await api("/api/projects/cancel", { sessionId: requestSession }); controller?.abort(); }
  catch (failure) {
    if (sessionId === requestSession && chatting) { reply.cancelRequested = false; reply.status = previous; replyView?.update(displayedReply(reply)); showError("project-error", failure.message); }
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
document.addEventListener("neuma:project-select", (event) => {
  if (projects.some((project) => project.id === event.detail?.id)) openProject(event.detail.id);
});
byId("project-search").addEventListener("input", render);
byId("project-refresh").addEventListener("click", () => { showError("manage-error"); void refresh(); });

const watching = () => route.page === "projects";
document.addEventListener("neuma:route", (event) => {
  const before = watching();
  const wasAdding = route.page === "projects" && route.projectView === "add";
  route = event.detail;
  const adding = route.page === "projects" && route.projectView === "add";
  if (!adding && folderController) {
    folderController.abort(); folderController = null;
    byId("project-folder-status").textContent = "选择项目所在的文件夹，也可以直接填写本机路径。";
  }
  render();
  if (watching() && !before) { clearErrors(); void refresh(); }
  if (adding && !wasAdding && !byId("project-path").value.trim()) void chooseProjectFolder();
});
document.addEventListener("neuma:settings-changed", () => {
  activeController?.abort(); activeController = null;
  sessionId = crypto.randomUUID(); messages = []; pendingReply = replyView = null;
  busy = chatting = cancelling = false; render(); renderMessages();
});
setInterval(() => { if (watching() && document.visibilityState === "visible") void refresh(); }, 3000);
render(); renderMessages();
void refresh();
