import { deleteAgentPreview, loadAgentPreview, saveAgentPreview } from "./state.js";
import { addUserMessage, createReplyView, renderUserMessage } from "./chat-ui.js";
import { agentHistory, agentSourceKey, createAgentRuntime } from "./agent-runtime.js";

let storage;
try { storage = window.localStorage; } catch { storage = null; }
let agents = [];
let mainBusy = false;
let route = { page: "chat", agentId: null };
const conversations = new Map(), runtimes = new Map(), inputs = new Map();
const api = createAgentRuntime();
const byId = (id) => document.getElementById(id);
const input = byId("agent-message");
const current = () => agents.find((item) => item.id === route.agentId);
const visible = (id, conversation) => route.page === "agent" && route.agentId === id
  && (!conversation || conversations.get(id) === conversation);

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function action(action, id = route.agentId) {
  document.dispatchEvent(new CustomEvent("neuma:agent-action", { detail: { action, id } }));
}

function conversation(id) {
  if (!conversations.has(id)) {
    const messages = loadAgentPreview(storage, id);
    conversations.set(id, { messages, saved: messages.length > 0, sessionId: crypto.randomUUID(), turn: null, error: "" });
  }
  return conversations.get(id);
}

function runtime(agent) {
  if (!runtimes.has(agent.id)) runtimes.set(agent.id, {
    status: "unchecked", sourceKey: agentSourceKey(agent), definition: null, operation: null, sequence: 0,
    error: "", label: "", rebuildRequested: false,
  });
  return runtimes.get(agent.id);
}

function showError(text = "") {
  byId("agent-error").textContent = text;
  byId("agent-error").hidden = !text;
}

function renderSidebar() {
  const list = byId("sidebar-agent-list");
  list.replaceChildren();
  byId("sidebar-agents-empty").hidden = agents.length > 0;
  byId("sidebar-create-agent").disabled = mainBusy;
  for (const agent of agents) {
    const link = element("a", "sidebar-agent", "");
    link.href = `#agent/${encodeURIComponent(agent.id)}`;
    link.setAttribute("aria-label", `进入 ${agent.name} 的对话`);
    if (visible(agent.id)) link.setAttribute("aria-current", "page");
    const mark = element("span", "agent-avatar", Array.from(agent.name)[0] || "A");
    mark.setAttribute("aria-hidden", "true");
    const state = runtime(agent);
    const label = element("span", "sidebar-agent-label", "");
    label.append(element("strong", "", agent.name), element("small", "", state.status === "ready" ? "可以运行"
      : state.status === "building" ? "正在生成" : state.status === "stale" ? "需求已更新 · 待生成" : "待生成"));
    link.append(mark, label);
    list.append(link);
  }
}

function renderMessages(agent) {
  const container = byId("agent-messages"), item = conversation(agent.id);
  container.replaceChildren();
  item.replyView = null;
  item.userRows = new Map();
  if (!item.messages.length) {
    const welcome = element("div", "welcome", "");
    welcome.append(element("span", "welcome-mark", Array.from(agent.name)[0] || "A"),
      element("strong", "", `这里是「${agent.name}」的对话`),
      element("p", "", agent.draft.goal?.value || "根据已确认的需求处理你的任务。"),
      element("p", "muted-note", runtime(agent).status === "ready"
        ? "输入一项任务，让这个智能体开始处理。" : "智能体生成完成后，就可以在这里执行任务。"));
    container.append(welcome);
  }
  for (const message of item.messages) {
    if (message.role === "user") {
      const row = renderUserMessage(message, input);
      item.userRows.set(message, row);
      container.append(row);
    }
    else {
      const view = createReplyView(agent.name);
      view.update(message);
      container.append(view.row);
      if (message === item.turn?.reply) item.replyView = view;
    }
  }
  container.scrollTop = container.scrollHeight;
}

function renderControls(agent) {
  const state = runtime(agent), item = conversation(agent.id), operation = state.operation || item.turn;
  byId("agent-runtime-status").textContent = state.status === "building" ? state.label || "正在生成智能体…"
    : state.status === "ready" ? item.turn ? "正在处理任务…" : "智能体已生成，可以开始任务。"
      : state.status === "stale" ? "需求已更新，请重新生成后继续任务。"
        : state.status === "checking" || state.status === "unchecked" ? "正在读取智能体…"
          : state.status === "error" ? "生成未完成，可以重试。" : "需求已确认，点击生成智能体。";
  byId("agent-build").disabled = Boolean(operation) || state.status === "checking";
  byId("agent-build").textContent = state.status === "building" ? "正在生成…" : state.definition ? "重新生成智能体" : "生成智能体";
  byId("agent-send").hidden = Boolean(operation);
  byId("agent-send").disabled = state.status !== "ready" || Boolean(operation);
  byId("agent-cancel-reply").hidden = !operation;
  byId("agent-cancel-reply").disabled = Boolean(operation?.controller.signal.aborted);
  byId("agent-chat-form").setAttribute("aria-busy", String(Boolean(operation)));
  byId("agent-save-chat").disabled = Boolean(item.turn);
  showError(item.error || state.error);
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
  byId("agent-message-label").textContent = `给 ${agent.name} 的任务`;
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
  renderControls(agent);
  byId("agent-storage-note").textContent = `${agent.persisted ? "需求已保存在此浏览器。" : "入口仅在当前页面存在，请保存需求以便下次打开。"}${conversation(agent.id).saved
    ? "这份对话已手动保存；新消息需再次保存。" : "对话仅在本页保留，点击保存后刷新可恢复。"}`;
}

async function inspectAgent(agent) {
  const state = runtime(agent);
  if (state.status !== "unchecked") return;
  const sequence = ++state.sequence;
  state.status = "checking";
  if (visible(agent.id)) renderControls(agent);
  try {
    const result = await api.inspect(agent.id);
    if (state.sequence !== sequence || !agents.some((item) => item.id === agent.id)) return;
    state.definition = result.agent;
    state.status = !result.agent ? "missing" : agentSourceKey(result.agent) === state.sourceKey ? "ready" : "stale";
  } catch (error) {
    if (state.sequence !== sequence) return;
    state.status = "error";
    state.error = error.message || "无法读取智能体，请重新生成。";
  }
  renderSidebar();
  if (visible(agent.id)) renderWorkspace();
}

async function buildAgent(id, queueIfBusy = false) {
  const agent = agents.find((item) => item.id === id);
  if (!agent) return;
  const state = runtime(agent), item = conversation(id);
  if (state.operation || item.turn) {
    if (queueIfBusy && (item.turn || state.operation.sourceKey !== agentSourceKey(agent)
      || state.operation.controller.signal.aborted)) state.rebuildRequested = true;
    return;
  }
  state.rebuildRequested = false;
  const operation = { controller: new AbortController(), sourceKey: agentSourceKey(agent) };
  state.sequence++;
  state.operation = operation;
  state.status = "building";
  state.error = item.error = "";
  state.label = "正在生成智能体…";
  renderSidebar();
  if (visible(id)) renderWorkspace();
  try {
    const result = await api.build(agent, { signal: operation.controller.signal, onProgress(progress) {
      if (operation.controller.signal.aborted || state.operation !== operation) return;
      if (progress.type === "status") state.label = progress.label || "正在生成智能体…";
      if (visible(id)) renderControls(agent);
    } });
    operation.controller.signal.throwIfAborted();
    if (state.sourceKey !== operation.sourceKey) return;
    state.definition = result.agent;
    state.status = "ready";
    item.sessionId = crypto.randomUUID();
  } catch (error) {
    if (state.sourceKey !== operation.sourceKey) return;
    state.status = "error";
    state.error = operation.controller.signal.aborted || error.reason === "cancelled" ? "生成已停止，可以重新生成。" : error.message || "生成失败，请重试。";
  } finally {
    if (state.operation === operation) state.operation = null;
    renderSidebar();
    if (visible(id)) renderWorkspace();
    await rebuildIfRequested(id, state);
  }
}

async function rebuildIfRequested(id, state) {
  if (!state.rebuildRequested || runtimes.get(id) !== state || state.operation || conversations.get(id)?.turn
    || !agents.some((agent) => agent.id === id)) return;
  state.rebuildRequested = false;
  await buildAgent(id);
}

function updateReply(id, item) {
  if (!visible(id, item)) return;
  const container = byId("agent-messages");
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  item.replyView?.update(item.turn.reply);
  if (atBottom) container.scrollTop = container.scrollHeight;
}

async function stopAgent(id) {
  const agent = agents.find((entry) => entry.id === id);
  if (!agent) return;
  const state = runtime(agent), item = conversation(id), operation = state.operation || item.turn;
  if (!operation || operation.controller.signal.aborted) return;
  if (item.turn) { item.turn.reply.status = "stopping"; updateReply(id, item); }
  operation.controller.abort();
  if (visible(id)) renderControls(agent);
  if (!item.turn) return;
  try { await api.cancel(item.sessionId); }
  catch (error) {
    item.error = error.message || "停止请求未确认，请稍后重试。";
    if (visible(id, item)) showError(item.error);
  }
}

async function sendMessage() {
  const agent = current(), message = input.value.trim();
  if (!agent || !message) return;
  const state = runtime(agent), item = conversation(agent.id);
  if (state.status !== "ready" || state.operation || item.turn) return;
  if (message.length > 4000) return showError("任务输入需为 1～4000 字。");
  const history = agentHistory(item.messages, state.definition.revision);
  const user = addUserMessage(item.messages, message);
  user.revision = String(state.definition.revision);
  const reply = { role: "assistant", content: "", status: "thinking", label: "正在处理任务…", revision: user.revision };
  const operation = { controller: new AbortController(), reply };
  item.turn = operation;
  item.messages.push(reply);
  item.saved = false;
  item.error = "";
  input.value = "";
  inputs.delete(agent.id);
  input.dispatchEvent(new Event("input"));
  renderWorkspace();
  try {
    const result = await api.turn({ agentId: agent.id, sessionId: item.sessionId, message, history }, {
      signal: operation.controller.signal, onProgress(progress) {
        if (operation.controller.signal.aborted) return;
        if (progress.type === "text-start") { reply.content = ""; reply.status = "thinking"; }
        if (progress.type === "text-delta" && typeof progress.delta === "string") { reply.content += progress.delta; reply.status = "writing"; }
        if (progress.type === "status") { reply.status = "thinking"; reply.label = progress.label || "正在处理任务…"; }
        updateReply(agent.id, item);
      },
    });
    operation.controller.signal.throwIfAborted();
    user.delivery = "sent";
    Object.assign(reply, { content: result.reply, status: "complete" });
  } catch (error) {
    const stopped = operation.controller.signal.aborted || error.reason === "cancelled";
    user.delivery = stopped ? "stopped" : "failed";
    reply.status = stopped ? "stopped" : "error";
    reply.error = stopped ? "本轮任务未完成，已显示的内容保留。" : error.message || "任务失败，请重试。";
    item.error = stopped ? item.error : reply.error;
    if (!stopped && conversations.get(agent.id) === item) {
      if (visible(agent.id, item) && !input.value.trim()) { input.value = message; input.dispatchEvent(new Event("input")); }
      else if (!visible(agent.id, item) && !inputs.get(agent.id)?.trim()) inputs.set(agent.id, message);
    }
  } finally {
    if (visible(agent.id, item)) {
      updateReply(agent.id, item);
      if (user.delivery !== "sent") item.userRows.get(user)?.replaceWith(renderUserMessage(user, input));
    }
    item.turn = item.replyView = null;
    if (visible(agent.id, item)) { renderControls(agent); input.focus(); }
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
    state.error = "";
  }
  renderSidebar();
  renderWorkspace();
  if (route.page === "agent" && current()) return inspectAgent(current());
});
document.addEventListener("neuma:route", (event) => {
  if (route.page === "agent") inputs.set(route.agentId, input.value);
  const previousPage = route.page, previousId = route.agentId;
  route = event.detail;
  if (route.page === "agent" && previousId !== route.agentId) {
    input.value = inputs.get(route.agentId) ?? "";
    input.dispatchEvent(new Event("input"));
  }
  renderSidebar();
  renderWorkspace();
  if (route.page === "agent" && current()) {
    if (previousPage !== "agent" || previousId !== route.agentId) input.focus();
    return inspectAgent(current());
  }
});
document.addEventListener("neuma:agent-build", (event) => buildAgent(event.detail.id, true));
document.addEventListener("neuma:agent-removed", (event) => {
  const id = event.detail.id, item = conversations.get(id);
  runtimes.get(id)?.operation?.controller.abort();
  if (item?.turn) { item.turn.controller.abort(); api.cancel(item.sessionId).catch(() => {}); }
  conversations.delete(id);
  runtimes.delete(id);
  inputs.delete(id);
  if (!deleteAgentPreview(storage, id)) showError("入口已移除，但浏览器未能删除保存的对话。");
});
document.addEventListener("neuma:agent-saved", (event) => {
  if (event.detail.id === route.agentId) showError(event.detail.ok ? "" : "浏览器无法保存需求，请在管理页导出。");
});

byId("sidebar-create-agent").addEventListener("click", () => action("create"));
byId("agent-iterate").addEventListener("click", () => action("edit"));
byId("agent-save-entry").addEventListener("click", () => action("save"));
byId("agent-build").addEventListener("click", () => buildAgent(route.agentId));
byId("agent-cancel-reply").addEventListener("click", () => stopAgent(route.agentId));
byId("agent-save-chat").addEventListener("click", () => {
  const agent = current();
  if (!agent) return;
  if (!agent.persisted) return showError("请先保存智能体需求，再保存这份对话。");
  const item = conversation(agent.id);
  if (item.turn) return;
  if (!saveAgentPreview(storage, agent.id, item.messages)) return showError("浏览器无法保存对话，请复制需要保留的内容。");
  item.saved = true;
  item.error = "";
  renderWorkspace();
});
byId("agent-new-chat").addEventListener("click", () => {
  const agent = current();
  if (!agent) return;
  if (conversation(agent.id).messages.length && !window.confirm("开启空白新对话？本页消息会清空，已保存的版本保留到下次点击保存。")) return;
  stopAgent(agent.id);
  conversations.set(agent.id, { messages: [], saved: false, sessionId: crypto.randomUUID(), turn: null, error: "" });
  input.value = "";
  inputs.delete(agent.id);
  renderWorkspace();
  input.dispatchEvent(new Event("input"));
  input.focus();
});
byId("agent-chat-form").addEventListener("submit", (event) => { event.preventDefault(); return sendMessage(); });

document.dispatchEvent(new CustomEvent("neuma:agents-request"));
