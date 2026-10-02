import { node, renderProjectDetails, renderProjectList, STATUS_LABELS, updateProjectStatus } from "./project-view.js";

const byId = (id) => document.getElementById(id);
const workspace = byId("projects-workspace"), details = byId("project-details"), input = byId("project-message");
let projects = [], selectedId = null, renderedId, busy = false, refreshing = false, chatting = false;
let sessionId = crypto.randomUUID(), messages = [];

function error(message = "") { byId("project-error").textContent = message; byId("project-error").hidden = !message; }
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "项目操作失败，请重试");
  return result;
}

function renderMessages() {
  const container = byId("project-messages"); container.replaceChildren();
  if (!messages.length) {
    const welcome = node("div", "welcome");
    welcome.append(node("strong", "", "从已有的一个小项目开始"), node("p", "", "把项目完整路径告诉我，我会识别类型并加入左侧列表。核对启动方式后，就可以直接说“打开它”。"));
    container.append(welcome);
  }
  for (const message of messages) {
    const wrapper = node("div", `message ${message.role}`);
    wrapper.append(node("div", "message-label", message.role === "user" ? "你" : "NEUMA · 项目助手"), node("div", "bubble", message.content));
    container.append(wrapper);
  }
  if (busy) container.append(node("p", "project-action-note", "正在处理项目操作…"));
  container.scrollTop = container.scrollHeight;
}

function render() {
  const query = byId("project-search").value.trim().toLowerCase();
  renderProjectList({ container: byId("projects-list"), projects: projects.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(query)),
    selectedId, busy, onSelect: (id) => { selectedId = id; render(); } });
  byId("project-count").textContent = projects.length;
  const project = projects.find((item) => item.id === selectedId);
  if (renderedId !== selectedId) {
    renderedId = selectedId;
    renderProjectDetails({ container: details, project, onConfigure: (body) => runAction("configure", body), onAction: (action) => runAction(action) });
  }
  byId("project-state").textContent = project ? STATUS_LABELS[project.status] : "未选择";
  updateProjectStatus(details, project, busy);
  for (const el of byId("project-add-form").querySelectorAll("input, button")) el.disabled = busy;
  byId("project-send").disabled = input.disabled = byId("project-new-chat").disabled = busy;
  byId("project-cancel").hidden = !chatting;
  byId("project-send").textContent = busy ? "正在处理…" : "发送 ↗";
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    projects = (await api("/api/projects")).projects;
    if (!projects.some((item) => item.id === selectedId)) selectedId = projects[0]?.id ?? null;
    render();
  } catch (failure) { error(failure.message); }
  finally { refreshing = false; }
}

async function runAction(action, body = {}) {
  if (busy || !selectedId) return;
  if (action === "remove" && !window.confirm("移除这条项目记录？原项目文件会保留。")) return;
  busy = true; error(); render();
  try {
    await api(`/api/projects/${selectedId}/${action}`, action === "remove" ? { confirm: true } : body);
    if (action === "configure" || action === "remove") renderedId = undefined;
    await refresh();
  } catch (failure) { error(failure.message); }
  finally { busy = false; render(); }
}

byId("project-add-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (busy) return;
  busy = true; error(); render();
  try {
    const result = await api("/api/projects", { path: byId("project-path").value.trim() });
    selectedId = result.project.id; byId("project-path").value = ""; await refresh();
  } catch (failure) { error(failure.message); }
  finally { busy = false; render(); }
});

byId("project-chat-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (busy || !input.value.trim()) return;
  const message = input.value.trim();
  busy = chatting = true; error(); render(); renderMessages();
  try {
    const result = await api("/api/projects/turn", { message, sessionId });
    messages.push({ role: "user", content: message }, { role: "assistant", content: result.reply });
    messages = messages.slice(-80); projects = result.projects;
    const added = result.actions.findLast((item) => item.tool === "add_project");
    if (added) selectedId = added.project.id;
    input.value = "";
  } catch (failure) { error(failure.message); await refresh(); }
  finally { busy = chatting = false; render(); renderMessages(); input.focus(); }
});
byId("project-cancel").addEventListener("click", async () => {
  try { await api("/api/projects/cancel", { sessionId }); }
  catch (failure) { error(failure.message); }
});
byId("project-new-chat").addEventListener("click", () => {
  if (busy) return;
  sessionId = crypto.randomUUID(); messages = []; input.value = ""; error(); renderMessages(); input.focus();
});
byId("project-search").addEventListener("input", render);
byId("project-refresh").addEventListener("click", () => { error(); void refresh(); });

function selectWorkspace(projectMode) {
  workspace.hidden = !projectMode; byId("requirements-workspace").hidden = projectMode;
  byId("projects-tab").setAttribute("aria-pressed", String(projectMode));
  byId("requirements-tab").setAttribute("aria-pressed", String(!projectMode));
  history.replaceState(null, "", projectMode ? "#projects" : location.pathname);
  if (projectMode) { void refresh(); input.focus(); }
}
byId("projects-tab").addEventListener("click", () => selectWorkspace(true));
byId("requirements-tab").addEventListener("click", () => selectWorkspace(false));
setInterval(() => { if (!workspace.hidden && document.visibilityState === "visible") void refresh(); }, 3000);
render(); renderMessages();
selectWorkspace(location.hash === "#projects");
void api("/api/health").then((health) => {
  byId("pi-connection").textContent = health.pi?.configured ? "项目助手已配置 · 由 Pi 执行" : "项目助手待配置 · 可以先手动添加项目";
}).catch(() => { byId("pi-connection").textContent = "本地服务未连接"; });
