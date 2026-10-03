import { appendAgentPreview, deleteAgentPreview, loadAgentPreview, saveAgentPreview } from "./state.js";

let storage;
try { storage = window.localStorage; } catch { storage = null; }
let agents = [];
let mainBusy = false;
let route = { page: "chat", agentId: null };
const previews = new Map();
const inputs = new Map();
const byId = (id) => document.getElementById(id);
const input = byId("agent-message");
const current = () => agents.find((item) => item.id === route.agentId);

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function action(action, id = route.agentId) {
  document.dispatchEvent(new CustomEvent("neuma:agent-action", { detail: { action, id } }));
}

function showError(text = "") {
  byId("agent-error").textContent = text;
  byId("agent-error").hidden = !text;
}

function preview(id) {
  if (!previews.has(id)) {
    const messages = loadAgentPreview(storage, id);
    previews.set(id, { messages, saved: messages.length > 0 });
  }
  return previews.get(id);
}

function renderSidebar() {
  const list = byId("sidebar-agent-list");
  list.replaceChildren();
  byId("sidebar-agents-empty").hidden = agents.length > 0;
  byId("sidebar-create-agent").disabled = mainBusy;
  for (const agent of agents) {
    const link = element("a", "sidebar-agent", "");
    link.href = `#agent/${encodeURIComponent(agent.id)}`;
    link.setAttribute("aria-label", `进入 ${agent.name} 的对话预览`);
    if (route.page === "agent" && route.agentId === agent.id) link.setAttribute("aria-current", "page");
    const mark = element("span", "agent-avatar", Array.from(agent.name)[0] || "A");
    mark.setAttribute("aria-hidden", "true");
    const label = element("span", "sidebar-agent-label", "");
    label.append(element("strong", "", agent.name),
      element("small", "", agent.dirty && agent.persisted ? "需求修改未保存" : agent.persisted ? "需求预览" : "需求预览 · 未保存"));
    link.append(mark, label);
    list.append(link);
  }
}

function renderMessages(agent) {
  const container = byId("agent-messages");
  const { messages } = preview(agent.id);
  container.replaceChildren();
  if (!messages.length) {
    const welcome = element("div", "welcome", "");
    welcome.append(element("span", "welcome-mark", Array.from(agent.name)[0] || "A"),
      element("strong", "", `这里是「${agent.name}」的对话`),
      element("p", "", agent.draft.goal?.value || "根据已确认的需求处理你的任务。"),
      element("p", "muted-note", "你可以输入一项任务，查看独立对话的交互方式。"));
    container.append(welcome);
  }
  for (const message of messages) {
    const row = element("div", "message user", "");
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "发送的预览消息");
    row.append(element("div", "bubble", message.content));
    container.append(row);
  }
  if (messages.length) container.append(element("p", "preview-receipt", "以上输入仅用于交互预览，尚未执行任务。"));
  container.scrollTop = container.scrollHeight;
}

function renderWorkspace() {
  if (route.page !== "agent") return;
  const agent = current();
  byId("agent-missing").hidden = Boolean(agent);
  byId("agent-workspace").hidden = !agent;
  byId("agent-iterate").hidden = !agent;
  byId("agent-title").textContent = agent?.name ?? "找不到智能体";
  byId("agent-subtitle").textContent = agent?.draft.goal?.value ?? "请回到 NUEMA 创建或确认需求。";
  if (!agent) return;
  byId("agent-conversation-title").textContent = agent.name;
  byId("agent-message-label").textContent = `给 ${agent.name} 的预览输入`;
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
  renderMessages(agent);
  byId("agent-storage-note").textContent = `${agent.persisted ? "需求已保存在此浏览器。" : "入口仅在当前页面存在，请保存需求以便下次打开。"}${preview(agent.id).saved
    ? "这份预览对话已手动保存；新输入需再次保存。" : "预览输入仅在本页保留，点击保存后刷新可恢复。"}`;
}

document.addEventListener("neuma:agents-changed", (event) => {
  agents = event.detail.items;
  mainBusy = event.detail.busy;
  renderSidebar();
  renderWorkspace();
});
document.addEventListener("neuma:route", (event) => {
  if (route.page === "agent") inputs.set(route.agentId, input.value);
  const previousPage = route.page;
  const previousId = route.agentId;
  route = event.detail;
  if (route.page === "agent" && previousId !== route.agentId) {
    input.value = inputs.get(route.agentId) ?? "";
    input.dispatchEvent(new Event("input"));
    showError();
  }
  renderSidebar();
  renderWorkspace();
  if (route.page === "agent" && current() && (previousPage !== "agent" || previousId !== route.agentId)) input.focus();
});
document.addEventListener("neuma:agent-removed", (event) => {
  previews.delete(event.detail.id);
  inputs.delete(event.detail.id);
  if (!deleteAgentPreview(storage, event.detail.id)) showError("入口已移除，但浏览器未能删除保存的预览输入。");
});
document.addEventListener("neuma:agent-saved", (event) => {
  if (event.detail.id === route.agentId) showError(event.detail.ok ? "" : "浏览器无法保存需求，请在管理页导出。");
});

byId("sidebar-create-agent").addEventListener("click", () => action("create"));
byId("agent-iterate").addEventListener("click", () => action("edit"));
byId("agent-save-entry").addEventListener("click", () => action("save"));
byId("agent-save-chat").addEventListener("click", () => {
  const agent = current();
  if (!agent) return;
  if (!agent.persisted) return showError("请先保存智能体需求，再保存这份预览对话。");
  const item = preview(agent.id);
  if (!saveAgentPreview(storage, agent.id, item.messages)) return showError("浏览器无法保存预览输入，请复制需要保留的内容。");
  item.saved = true;
  showError();
  renderWorkspace();
});
byId("agent-new-chat").addEventListener("click", () => {
  const agent = current();
  if (!agent) return;
  if (preview(agent.id).messages.length && !window.confirm("开启空白预览对话？本页输入会清空，已保存的版本保留到下次点击保存。")) return;
  previews.set(agent.id, { messages: [], saved: false });
  input.value = "";
  inputs.delete(agent.id);
  showError();
  renderWorkspace();
  input.dispatchEvent(new Event("input"));
  input.focus();
});
byId("agent-chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const agent = current();
  if (!agent || !input.value.trim()) return;
  const item = preview(agent.id);
  try { item.messages = appendAgentPreview(item.messages, input.value); }
  catch (error) { return showError(error.message); }
  item.saved = false;
  input.value = "";
  inputs.delete(agent.id);
  showError();
  renderWorkspace();
  input.dispatchEvent(new Event("input"));
  input.focus();
});

document.dispatchEvent(new CustomEvent("neuma:agents-request"));
