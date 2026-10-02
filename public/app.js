import { blankSession, clearSession, deleteRequirement, initializeSession, loadSavedRequirements,
  loadSession, recentUserMessages, saveRequirement, saveSession, startNewConversation,
  upsertConfirmedRequirement } from "./state.js";

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
let diagnosticTurns = [];

const messagesEl = document.getElementById("messages");
const draftEl = document.getElementById("draft-content");
const statusEl = document.getElementById("draft-status");
const jevEl = document.getElementById("jev-status");
const connectionEl = document.getElementById("connection");
const errorEl = document.getElementById("error");
const inputEl = document.getElementById("message");
const sendEl = document.getElementById("send");
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

function element(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = !message;
}

function renderMessages() {
  messagesEl.replaceChildren();
  if (session.messages.length === 0) {
    const welcome = element("div", "welcome");
    welcome.append(element("strong", "", "从一句话开始"));
    welcome.append(element("p", "", "例如：“帮我做一个周报 Agent。我每周把工作记录发给它，它整理成进展、问题和下周计划。”"));
    messagesEl.append(welcome);
    return;
  }
  for (const message of session.messages) {
    const wrapper = element("div", `message ${message.role}`);
    wrapper.append(element("div", "message-label", message.role === "user" ? "你" : "NEUMA · 需求 Agent"));
    wrapper.append(element("div", "bubble", message.content));
    messagesEl.append(wrapper);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
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
    : session.status === "ready" ? "待用户确认"
    : session.status === "needs_input" ? "待补充" : "等待描述";
  exportEl.disabled = !draft;
  if (!draft) {
    appendField("Agent 名称", "", "", "描述后会出现在这里");
    appendField("核心目标", "");
    appendField("使用场景", "");
    appendField("每次输入", "");
    appendField("核心任务", "");
    appendField("输出结果", "");
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

function renderAgents() {
  agentsEl.replaceChildren();
  agentCountEl.textContent = String(agents.length);
  if (!agents.length) {
    agentsEl.append(element("p", "agents-empty", "确认第一份 Agent 需求后，它会出现在这里。"));
    return;
  }
  for (const agent of agents) {
    const card = element("article", `agent-card${agent.id === activeAgentId ? " active" : ""}`);
    const open = element("button", "agent-open");
    open.type = "button";
    open.disabled = busy;
    open.setAttribute("aria-pressed", String(agent.id === activeAgentId));
    open.setAttribute("aria-label", `打开 ${agent.name} 的需求`);
    open.append(element("strong", "agent-name", agent.name));
    open.append(element("span", "agent-goal", agent.draft.goal?.value || "需求已确认"));
    open.addEventListener("click", () => openAgent(agent.id));
    const footer = element("div", "agent-footer");
    footer.append(element("span", "agent-save-state", agent.dirty && agent.persisted
      ? "修改未保存" : agent.persisted ? "已保存" : "仅当前页"));
    const actions = element("div", "agent-actions");
    if (agent.dirty || !agent.persisted) {
      const save = element("button", "agent-action", agent.persisted ? "保存修改" : "保存");
      save.type = "button";
      save.disabled = busy;
      save.setAttribute("aria-label", `保存 ${agent.name} 的需求`);
      save.addEventListener("click", () => saveAgent(agent.id));
      actions.append(save);
    }
    const remove = element("button", "agent-action danger", "删除");
    remove.type = "button";
    remove.disabled = busy;
    remove.setAttribute("aria-label", `删除 ${agent.name} 的需求`);
    remove.addEventListener("click", () => removeAgent(agent.id));
    actions.append(remove);
    footer.append(actions);
    card.append(open, footer);
    agentsEl.append(card);
  }
}

function openAgent(id) {
  if (busy) return;
  const agent = agents.find((item) => item.id === id);
  if (!agent) return;
  if ((session.draft || session.messages.length)
    && !window.confirm(`打开“${agent.name}”会替换当前对话和草稿。继续吗？`)) return;
  session = blankSession();
  diagnosticTurns = [];
  session.draft = structuredClone(agent.draft);
  session.status = "ready";
  session.confirmed = true;
  session.messages.push({ role: "assistant",
    content: `已打开“${agent.name}”的需求说明。你可以在下方描述要修改的地方。` });
  activeAgentId = id;
  pendingLegacy = null;
  inputEl.value = "";
  showError("");
  render();
}

function saveAgent(id) {
  if (busy) return;
  const agent = agents.find((item) => item.id === id);
  if (!agent || !saveRequirement(browserStorage, agent)) {
    showError("浏览器无法保存 Agent 需求，请导出 JSON");
    return;
  }
  agents = agents.map((item) => item.id === id ? { ...item, persisted: true, dirty: false } : item);
  showError("");
  render();
}

function removeAgent(id) {
  if (busy) return;
  const agent = agents.find((item) => item.id === id);
  if (!agent || !window.confirm(`删除“${agent.name}”的需求？${agent.persisted ? "浏览器中保存的版本也会删除。" : ""}${activeAgentId === id ? "当前打开的对话也会清空。" : ""}`)) return;
  if (agent.persisted && !deleteRequirement(browserStorage, id)) {
    showError("浏览器无法删除这份 Agent 需求");
    return;
  }
  agents = agents.filter((item) => item.id !== id);
  if (activeAgentId === id) {
    session = blankSession();
    diagnosticTurns = [];
    activeAgentId = null;
    inputEl.value = "";
  }
  showError("");
  render();
}

function render() {
  renderMessages();
  renderDraft();
  renderJev();
  renderAgents();
  sendEl.disabled = busy;
  inputEl.disabled = busy;
  sendEl.textContent = busy ? "正在整理…" : "发送 ↗";
  resetEl.disabled = busy;
  modifyEl.disabled = busy;
  saveEl.disabled = !session.draft || busy;
  diagnosticsEl.disabled = busy || (!diagnosticTurns.length && !session.messages.length);
  restoreEl.disabled = busy || (!hasSavedCopy && !pendingLegacy);
  deleteSavedEl.disabled = busy || (!hasSavedCopy && !pendingLegacy);
  storageNoteEl.textContent = hasSavedCopy
    ? "浏览器中有一份手动保存的对话。刷新后仍从空白开始，点击“恢复已存对话”才会使用它。"
    : pendingLegacy
      ? "旧版记录已从本地存储移除，仅在本页暂存；需要继续时请手动恢复。"
      : "默认不保存或继承对话；刷新后从空白开始。";
}

async function checkHealth() {
  try {
    const response = await fetch("/api/health");
    if (!response.ok) throw new Error();
    const health = await response.json();
    connectionEl.textContent = `${health.llmConfigured ? "模型已配置" : "模型未配置"} · ${health.jevConfigured ? "Jev 已配置" : "Jev 未配置"}`;
  } catch {
    connectionEl.textContent = "本地服务未连接";
  }
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
  busy = true;
  showError("");
  render();
  try {
    const response = await fetch("/api/requirements/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, draft: session.draft, lastQuestion: session.lastQuestion,
        userMessages }),
    });
    httpStatus = response.status;
    stage = "parse_response";
    const payload = await response.json();
    serverDiagnostic = payload.diagnostic ?? null;
    if (!response.ok) throw new Error(payload.error || "需求整理失败，请重试");
    stage = "update_session";
    session.draft = payload.draft;
    session.status = payload.status;
    session.confirmed = payload.confirmed === true;
    session.lastQuestion = payload.question || payload.confirmationQuestion || "";
    session.jev = payload.jev;
    session.messages.push({ role: "user", content: message });
    const assistantMessage = payload.confirmed
      ? `需求已确认：\n${payload.summary}\n\n当前测试版到需求层为止。`
      : payload.status === "ready"
        ? `我整理出的需求是：\n${payload.summary}\n\n${payload.confirmationQuestion}`
        : `${payload.summary}\n\n${payload.question}`;
    session.messages.push({ role: "assistant", content: assistantMessage });
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
    inputEl.value = "";
  } catch (error) {
    const message = error instanceof Error ? error.message : "请求失败，请重试";
    showError(message);
    diagnosticTurn.result = { outcome: "error", stage, httpStatus,
      message, diagnostic: serverDiagnostic };
  } finally {
    diagnosticTurn.durationMs = Math.round(performance.now() - startedAt);
    diagnosticTurns = [...diagnosticTurns, diagnosticTurn].slice(-40);
    busy = false;
    render();
    inputEl.focus();
  }
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

render();
if (!initial.legacyCleared) showError("无法清除旧版自动保存记录，请在浏览器中清除本站数据");
void checkHealth();
