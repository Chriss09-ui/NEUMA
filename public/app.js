import { blankSession, clearSession, deleteRequirement, initializeSession, loadSavedRequirements,
  loadSession, recentUserMessages, saveRequirement, saveSession, startNewConversation,
  upsertConfirmedRequirement } from "./state.js";
import { addUserMessage, createReplyView, mountWelcome, readReply, renderUserMessage } from "./chat-ui.js";

let browserStorage;
try { browserStorage = window.localStorage; } catch { browserStorage = null; }
const initial = initializeSession(browserStorage);
let session = initial.session;
let hasSavedCopy = initial.hasSavedCopy;
let pendingLegacy = initial.legacySession.messages.length || initial.legacySession.draft
  ? initial.legacySession : null;
let agents = loadSavedRequirements(browserStorage);
let activeAgentId = null;
let busy = false;
let pendingReply = null, replyView = null, activeController = null;
let diagnosticTurns = [];

const messagesEl = document.getElementById("messages");
const draftEl = document.getElementById("draft-content");
const statusEl = document.getElementById("draft-status");
const jevEl = document.getElementById("jev-status");
const errorEl = document.getElementById("error");
const agentsErrorEl = document.getElementById("agents-error");
const inputEl = document.getElementById("message");
const sendEl = document.getElementById("send");
const cancelEl = document.getElementById("cancel-reply");
const exportEl = document.getElementById("export");
const diagnosticsEl = document.getElementById("diagnostics");
const saveEl = document.getElementById("save");
const restoreEl = document.getElementById("restore");
const deleteSavedEl = document.getElementById("delete-saved");
const storageNoteEl = document.getElementById("storage-note");
const agentsEl = document.getElementById("agents-list");
const agentCountEl = document.getElementById("agent-count");
const resetEl = document.getElementById("reset");
const modifyEl = document.getElementById("modify");

const SOURCE_LABEL = { user: "用户说明", inferred: "直接推导", default: "系统暂定", unknown: "未明确" };
const CHOICE_FIELDS = new Set(["每次输入", "核心任务与处理方式", "输出结果", "完成标准"]);
const AGENT_TYPE_LABEL = {
  "Knowledge Agent": "知识类", "Analysis Agent": "分析类",
  "Generation Agent": "生成类", "Data Agent": "数据类", "Workflow Agent": "流程类",
};
const SUGGESTIONS = [
  ["整理会议", "从转写到结论与待办", "帮我做一个会议纪要 Agent。我会给它会议转写文字，它提炼结论和待办。", "meeting"],
  ["写好周报", "把零散记录变成进展", "帮我做一个周报 Agent。我每周把工作记录发给它，它整理成进展、问题和下周计划。", "report"],
  ["回复客户", "先起草，再由你把关", "帮我做一个客服回复 Agent。我贴客户的问题，它起草回复，由我审核后再发。", "reply"],
];

function element(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(className, text, onClick, label = "") {
  const node = element("button", className, text);
  node.type = "button";
  node.disabled = busy;
  if (label) node.setAttribute("aria-label", label);
  node.addEventListener("click", onClick);
  return node;
}

function navigate(detail) {
  document.dispatchEvent(new CustomEvent("neuma:navigate", { detail }));
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = !message;
}

function showAgentsError(message) {
  agentsErrorEl.textContent = message;
  agentsErrorEl.hidden = !message;
}

function renderMessages(scrollToEnd = true) {
  const scrollTop = messagesEl.scrollTop;
  replyView = null;
  messagesEl.replaceChildren();
  {
    const welcome = element("div", "welcome");
    welcome.append(element("span", "welcome-eyebrow", "留点时间，给更重要的事"));
    const title = element("h2", "welcome-title", "把重复的工作，");
    title.append(element("br"), element("span", "", "交给你的智能体。"));
    welcome.append(title);
    welcome.append(element("p", "welcome-description", "说说你想完成什么。我会帮你理清需求，\n一步步建立专属的工作助手。"));
    const chips = element("div", "suggestions");
    for (const [label, description, text, icon] of SUGGESTIONS) {
      const suggestion = button("suggestion", "", () => {
        inputEl.value = text;
        inputEl.dispatchEvent(new Event("input"));
        inputEl.focus();
      });
      const mark = element("span", `suggestion-icon icon-${icon}`);
      mark.setAttribute("aria-hidden", "true");
      suggestion.append(mark, element("strong", "", label), element("small", "", description));
      chips.append(suggestion);
    }
    welcome.append(chips);
    mountWelcome(messagesEl, welcome, session.messages.length > 0);
    if (session.messages.length === 0) return;
  }
  for (const message of session.messages) {
    if (message.role === "user") { messagesEl.append(renderUserMessage(message, inputEl)); continue; }
    const view = createReplyView("NUEMA");
    view.update({ ...message, status: message.status || "complete" });
    messagesEl.append(view.row);
    if (message === pendingReply) replyView = view;
  }
  const delivered = session.confirmed && agents.find((item) => item.id === activeAgentId);
  if (delivered) {
    const needsSave = delivered.dirty || !delivered.persisted;
    const card = element("div", "delivery-card");
    card.append(element("span", "agent-type", "独立对话入口"), element("strong", "", delivered.name),
      element("p", "muted-note", "已加入左侧“我的智能体”。先预览对话方式，后续可以随时让 NUEMA 协助迭代。"));
    card.append(button("primary", needsSave ? "保存需求并进入预览" : "进入对话预览", () => {
      if (needsSave && !saveAgent(delivered.id)) return;
      navigate({ page: "agent", agentId: delivered.id });
    }));
    messagesEl.append(card);
  }
  messagesEl.scrollTop = scrollToEnd ? messagesEl.scrollHeight : scrollTop;
}

function appendField(label, value, source = "", emptyLabel = "尚未明确") {
  const row = element("div", "draft-field");
  const heading = element("div", "field-label");
  heading.append(element("span", "", label));
  if (source) heading.append(element("span", "source", source === "inferred" && CHOICE_FIELDS.has(label)
    ? "建议，待核对" : SOURCE_LABEL[source] ?? ""));
  row.append(heading);
  row.append(element("div", `field-value${value ? "" : " empty"}`, value || emptyLabel));
  draftEl.append(row);
}

function renderDraft() {
  draftEl.replaceChildren();
  const draft = session.draft;
  statusEl.className = `status ${session.status}`;
  statusEl.textContent = session.confirmed ? "需求已确认"
    : session.status === "ready" ? "待你确认"
    : session.status === "needs_input" ? "待补充" : "等待描述";
  exportEl.disabled = !draft || busy;
  const currentStep = session.confirmed ? "preview" : session.status === "ready" ? "confirm" : "describe";
  for (const step of ["describe", "confirm", "preview"]) {
    const item = document.getElementById(`brief-step-${step}`);
    if (step === currentStep) item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
  }
  if (!draft) {
    const empty = element("div", "brief-empty");
    const illustration = element("div", "brief-illustration");
    illustration.setAttribute("aria-hidden", "true");
    illustration.append(element("span"), element("span"), element("span"));
    empty.append(illustration, element("h3", "", "想法在这里成形"),
      element("p", "", "聊过的目标、材料和预期结果，\n会整理成一份清晰的需求说明。"));
    draftEl.append(empty);
    return;
  }
  appendField("Agent 名称", draft.name?.value, draft.name?.source);
  appendField("初步类型", AGENT_TYPE_LABEL[draft.agentType?.value] || draft.agentType?.value,
    draft.agentType?.source, "待判断");
  appendField("核心目标", draft.goal?.value, draft.goal?.source);
  appendField("使用场景", draft.scenario?.value, draft.scenario?.source);
  appendField("每次输入", draft.inputSource?.value, draft.inputSource?.source);
  appendField("核心任务与处理方式", draft.task?.value, draft.task?.source);
  appendField("输出结果", draft.deliverable?.value, draft.deliverable?.source);
  appendField("完成标准", draft.successCriteria?.value, draft.successCriteria?.source, "暂无额外标准");
  appendField("工作限制", draft.constraints?.map((item) => item.text).join("；"));
  appendField("建议调用场景", draft.routingCondition?.value, draft.routingCondition?.source);
  appendField("使用方式", draft.usage?.detail, draft.usage?.source);
  const action = draft.externalAction;
  const actionText = action?.mode === "none" ? "不执行对外动作"
    : action?.mode === "possible" ? "是否执行对外动作仍需明确"
      : [action?.operation, action?.target, action?.scope, action?.trigger].filter(Boolean).join("；");
  appendField("对外动作", actionText, action?.source);
  appendField("能力连接状态", "尚未接通；本阶段仅整理需求");
  appendField("能力依赖", draft.capabilityDependencies?.join("；"), "", "暂无已知依赖");
  appendField("未解决事项", draft.unresolved?.join("；"), "", "暂无");
}

function renderJev() {
  if (!session.jev) {
    jevEl.textContent = "Jev 尚未参与判断";
  } else if (session.jev.used) {
    jevEl.textContent = `Jev 已参与 · 本轮缺口：${session.jev.appliedGap === "none" ? "无" : session.jev.appliedGap}`;
  } else if (session.jev.reason === "not_needed") {
    jevEl.textContent = "本轮处理确认或纠正方向，未再次调用 Jev";
  } else {
    jevEl.textContent = session.jev.reason === "not_configured"
      ? "Jev 未配置 · 本轮由需求 Agent 与规则判断"
      : "Jev 暂不可用 · 已自动按需求草稿继续";
  }
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function renderAgents() {
  agentsEl.replaceChildren();
  agentCountEl.textContent = String(agents.length);
  if (!agents.length) {
    const empty = element("div", "empty-state");
    empty.append(element("span", "empty-symbol", "✳"), element("h2", "", "给自己添一位工作助手"));
    empty.append(element("p", "", "从一项重复的工作开始。确认需求后，你的智能体就会出现在这里。"));
    empty.append(button("primary", "创建第一个智能体", () => document.getElementById("agents-create").click()));
    agentsEl.append(empty);
  }
  for (const agent of agents) {
    const card = element("article", `card agent-card${agent.id === activeAgentId ? " active" : ""}`);
    const top = element("div", "agent-card-top");
    top.append(element("span", "agent-type", AGENT_TYPE_LABEL[agent.draft.agentType?.value] || "Agent"));
    const state = agent.dirty && agent.persisted ? ["warn", "修改未保存"]
      : agent.persisted ? ["ok", "已保存"] : ["", "仅当前页"];
    top.append(element("span", `status ${state[0]}`, state[1]));
    card.append(top, element("h3", "", agent.name));
    card.append(element("p", "", agent.draft.goal?.value || "需求已确认"));
    const time = formatTime(agent.updatedAt);
    if (time) card.append(element("span", "agent-meta", `更新于 ${time}${agent.id === activeAgentId ? " · 正在对话中编辑" : ""}`));
    const actions = element("div", "agent-actions");
    actions.append(button("secondary", "进入对话", () => navigate({ page: "agent", agentId: agent.id }),
      `进入 ${agent.name} 的对话预览`));
    actions.append(button("ghost-button", "让 NUEMA 迭代", () => openAgent(agent.id), `让 NUEMA 迭代 ${agent.name}`));
    if (agent.dirty || !agent.persisted) {
      actions.append(button("secondary", agent.persisted ? "保存修改" : "保存", () => saveAgent(agent.id),
        `保存 ${agent.name} 的需求`));
    }
    actions.append(button("ghost-button", "导出", () => downloadJson(`${agent.name}.json`,
      { name: agent.name, draft: agent.draft, updatedAt: agent.updatedAt, exportedAt: new Date().toISOString() })));
    actions.append(button("ghost-button danger", "删除", () => removeAgent(agent.id), `删除 ${agent.name} 的需求`));
    card.append(actions);
    agentsEl.append(card);
  }
  document.dispatchEvent(new CustomEvent("neuma:agents-changed", { detail: { items: agents, busy } }));
}

function openAgent(id) {
  if (busy) return;
  const agent = agents.find((item) => item.id === id);
  if (!agent) return;
  if (agent.id !== activeAgentId && (session.draft || session.messages.length)
    && !window.confirm(`打开“${agent.name}”会替换当前对话和草稿。继续吗？`)) return;
  if (agent.id !== activeAgentId) {
    session = blankSession();
    diagnosticTurns = [];
    session.draft = structuredClone(agent.draft);
    session.status = "ready";
    session.confirmed = true;
    session.messages.push({ role: "assistant",
      content: `我们继续迭代“${agent.name}”。右侧是当前确认的需求，你可以告诉我希望调整什么；确认修改后会更新同一个智能体入口。` });
    activeAgentId = id;
    pendingLegacy = null;
    inputEl.value = "";
  }
  showError("");
  showAgentsError("");
  render();
  navigate({ page: "chat" });
}

function saveAgent(id) {
  if (busy) return;
  const agent = agents.find((item) => item.id === id);
  if (!agent || !saveRequirement(browserStorage, agent)) {
    showAgentsError("浏览器无法保存 Agent 需求，请先导出");
    showError("浏览器无法保存 Agent 需求，请先导出");
    document.dispatchEvent(new CustomEvent("neuma:agent-saved", { detail: { id, ok: false } }));
    return false;
  }
  agents = agents.map((item) => item.id === id ? { ...item, persisted: true, dirty: false } : item);
  showAgentsError("");
  showError("");
  render();
  document.dispatchEvent(new CustomEvent("neuma:agent-saved", { detail: { id, ok: true } }));
  return true;
}

function removeAgent(id) {
  if (busy) return;
  const agent = agents.find((item) => item.id === id);
  if (!agent || !window.confirm(`删除“${agent.name}”的需求？${agent.persisted ? "浏览器中保存的版本也会删除。" : ""}${activeAgentId === id ? "当前打开的对话也会清空。" : ""}`)) return;
  if (agent.persisted && !deleteRequirement(browserStorage, id)) {
    showAgentsError("浏览器无法删除这份 Agent 需求");
    return;
  }
  agents = agents.filter((item) => item.id !== id);
  document.dispatchEvent(new CustomEvent("neuma:agent-removed", { detail: { id } }));
  if (activeAgentId === id) {
    session = blankSession();
    diagnosticTurns = [];
    activeAgentId = null;
    inputEl.value = "";
  }
  showAgentsError("");
  render();
}

function render(scrollToEnd = true) {
  renderMessages(scrollToEnd);
  renderDraft();
  renderJev();
  renderAgents();
  const editingAgent = agents.find((item) => item.id === activeAgentId);
  document.getElementById("iteration-context").hidden = !editingAgent;
  document.getElementById("iteration-agent-name").textContent = editingAgent?.name ?? "";
  sendEl.disabled = busy;
  sendEl.hidden = busy;
  cancelEl.hidden = !busy;
  cancelEl.disabled = activeController?.signal.aborted === true;
  inputEl.disabled = false;
  resetEl.disabled = busy;
  modifyEl.disabled = busy || !session.draft;
  saveEl.disabled = !session.draft || busy;
  diagnosticsEl.disabled = busy || (!diagnosticTurns.length && !session.messages.length);
  restoreEl.disabled = busy || (!hasSavedCopy && !pendingLegacy);
  deleteSavedEl.disabled = busy || (!hasSavedCopy && !pendingLegacy);
  storageNoteEl.textContent = hasSavedCopy
    ? "浏览器中有一份手动保存的对话。刷新后仍从空白开始，点击“恢复已存对话”才会使用它。"
    : pendingLegacy
      ? "旧版记录已从本地存储移除，仅在本页暂存；需要继续时请手动恢复。"
      : "默认不保存对话，刷新后从空白开始。";
}

document.getElementById("chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  const message = inputEl.value.trim();
  if (!message) return;
  const startedAt = performance.now();
  const userMessages = recentUserMessages(session.messages);
  const diagnosticTurn = {
    at: new Date().toISOString(),
    request: { message, lastQuestion: session.lastQuestion, userMessages,
      draftBefore: structuredClone(session.draft) },
  };
  let stage = "request";
  let httpStatus = null;
  let serverDiagnostic = null;
  const user = addUserMessage(session.messages, message);
  const reply = { role: "assistant", content: "", status: "thinking", label: "正在整理需求…" };
  const controller = new AbortController();
  activeController = controller;
  pendingReply = reply;
  session.messages.push(reply);
  inputEl.value = "";
  inputEl.dispatchEvent(new Event("input"));
  busy = true;
  showError("");
  render();
  try {
    const response = await fetch("/api/requirements/turn", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify({ message, draft: session.draft, lastQuestion: session.lastQuestion,
        userMessages }),
      signal: controller.signal,
    });
    httpStatus = response.status;
    stage = "parse_response";
    const payload = await readReply(response, (progress) => {
      if (controller.signal.aborted) return;
      const atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
      if (progress.type === "text-start") { reply.content = ""; reply.status = "thinking"; reply.label = ""; }
      if (progress.type === "text-delta" && typeof progress.delta === "string") {
        reply.content += progress.delta; reply.status = "writing";
      }
      if (progress.type === "status") { reply.status = "thinking"; reply.label = progress.label || "正在整理需求…"; }
      replyView?.update(reply);
      if (atBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
    }, { incompleteMessage: "连接中断，回复尚未完成。需求说明仍保留本轮开始前的内容。" });
    controller.signal.throwIfAborted();
    serverDiagnostic = payload.diagnostic ?? null;
    if (!response.ok) throw new Error(payload.error || "需求整理失败，请重试");
    stage = "update_session";
    session.draft = payload.draft;
    session.status = payload.status;
    session.confirmed = payload.confirmed === true;
    session.lastQuestion = payload.question || payload.confirmationQuestion || "";
    session.jev = payload.jev;
    user.delivery = "sent";
    const assistantMessage = typeof payload.reply === "string" ? payload.reply : payload.confirmed
      ? `需求已确认：\n${payload.summary}\n\n独立对话入口已加入左侧“我的智能体”。当前可以预览交互，任务执行能力尚未接入。`
      : payload.status === "ready"
        ? `我整理出的需求是：\n${payload.summary}\n\n${payload.confirmationQuestion}`
        : `${payload.summary}\n\n${payload.question}`;
    Object.assign(reply, { content: assistantMessage, status: "complete" });
    diagnosticTurn.result = {
      outcome: "success", httpStatus, status: payload.status,
      question: payload.question, confirmationQuestion: payload.confirmationQuestion,
      assistantMessage, draftAfter: structuredClone(payload.draft),
      diagnostic: serverDiagnostic,
    };
    session.messages = session.messages.slice(-80);
    if (session.confirmed) {
      const updated = upsertConfirmedRequirement(agents, activeAgentId, session.draft, crypto.randomUUID());
      agents = updated.items;
      activeAgentId = updated.activeId;
    }
    pendingLegacy = null;
  } catch (error) {
    const stopped = controller.signal.aborted || error.reason === "cancelled";
    user.delivery = stopped ? "stopped" : "failed";
    reply.status = stopped ? "stopped" : "error";
    if (!stopped && !inputEl.value.trim()) { inputEl.value = message; inputEl.dispatchEvent(new Event("input")); }
    const errorMessage = error instanceof Error ? error.message : "请求失败，请重试";
    reply.error = stopped ? "本轮未完成，需求说明未更新。" : errorMessage;
    if (!stopped) showError(errorMessage);
    diagnosticTurn.result = { outcome: stopped ? "cancelled" : "error", stage, httpStatus,
      message: stopped ? "已停止回复" : errorMessage, diagnostic: error.diagnostic ?? serverDiagnostic };
  } finally {
    diagnosticTurn.durationMs = Math.round(performance.now() - startedAt);
    diagnosticTurns = [...diagnosticTurns, diagnosticTurn].slice(-40);
    busy = false;
    pendingReply = replyView = activeController = null;
    render(false);
    if (!document.getElementById("page-chat").hidden) inputEl.focus({ preventScroll: true });
  }
});

cancelEl.addEventListener("click", () => {
  if (!busy || !activeController || activeController.signal.aborted) return;
  pendingReply.status = "stopping";
  replyView?.update(pendingReply);
  cancelEl.disabled = true;
  activeController.abort();
});

modifyEl.addEventListener("click", () => {
  inputEl.placeholder = "例如：不要自动发送；以后只生成供我审核的草稿。";
  inputEl.focus();
});

saveEl.addEventListener("click", () => {
  if (!session.draft) return;
  if (!saveSession(browserStorage, session)) {
    showError("浏览器无法保存记录，请导出 JSON");
    return;
  }
  hasSavedCopy = true;
  pendingLegacy = null;
  showError("");
  render();
});

restoreEl.addEventListener("click", () => {
  if (busy || (!hasSavedCopy && !pendingLegacy)) return;
  if ((session.draft || session.messages.length)
    && !window.confirm("用已有记录替换当前页面的对话和草稿？")) return;
  const restored = hasSavedCopy ? loadSession(browserStorage) : pendingLegacy;
  if (!restored || (!restored.draft && !restored.messages.length)) {
    showError("已保存记录无法读取，请删除后重新开始");
    return;
  }
  session = restored;
  diagnosticTurns = [];
  activeAgentId = null;
  if (session.confirmed && session.draft) {
    const existing = agents.find((item) => JSON.stringify(item.draft) === JSON.stringify(session.draft));
    if (existing) activeAgentId = existing.id;
    else {
      const updated = upsertConfirmedRequirement(agents, null, session.draft, crypto.randomUUID());
      agents = updated.items;
      activeAgentId = updated.activeId;
    }
  }
  pendingLegacy = null;
  inputEl.value = "";
  showError("");
  render();
});

deleteSavedEl.addEventListener("click", () => {
  if (busy) return;
  if (!clearSession(browserStorage)) {
    showError("浏览器无法删除已保存记录");
    return;
  }
  hasSavedCopy = false;
  pendingLegacy = null;
  showError("");
  render();
});

function downloadJson(filename, data) {
  const content = JSON.stringify(data, null, 2);
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

exportEl.addEventListener("click", () => {
  if (!session.draft) return;
  downloadJson("neuma-agent-requirements.json", { status: session.status, draft: session.draft,
    exportedAt: new Date().toISOString() });
});

diagnosticsEl.addEventListener("click", () => {
  if (!diagnosticTurns.length && !session.messages.length) return;
  downloadJson("neuma-diagnostics.json", {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    session: { status: session.status, draft: session.draft,
      lastQuestion: session.lastQuestion, messages: session.messages },
    turns: diagnosticTurns,
  });
});

resetEl.addEventListener("click", () => {
  if (busy) return;
  if ((session.draft || session.messages.length)
    && !window.confirm("开启新对话？当前对话和草稿会清空，手动保存的记录仍会保留。")) return;
  const fresh = startNewConversation(browserStorage);
  pendingLegacy = null;
  session = fresh.session;
  diagnosticTurns = [];
  activeAgentId = null;
  hasSavedCopy = fresh.hasSavedCopy;
  inputEl.value = "";
  showError("");
  render();
  inputEl.focus();
});

document.getElementById("agents-create").addEventListener("click", () => {
  navigate({ page: "chat" });
  if (session.draft || session.messages.length) resetEl.click();
});

document.addEventListener("neuma:agents-request", renderAgents);
document.addEventListener("neuma:agent-action", (event) => {
  const { action, id } = event.detail ?? {};
  if (action === "edit") openAgent(id);
  if (action === "save") saveAgent(id);
  if (action === "create") document.getElementById("agents-create").click();
});
document.getElementById("iteration-back").addEventListener("click", () => {
  if (activeAgentId) navigate({ page: "agent", agentId: activeAgentId });
});

render();
if (!initial.legacyCleared) showError("无法清除旧版自动保存记录，请在浏览器中清除本站数据");
