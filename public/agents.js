import { agentDisplayDescription, agentDisplayName, deleteAgentPreview } from "./state.js";
import { AgentConversationHistory } from "./agent-conversations.js";
import { addUserMessage, createReplyView, renderUserMessage } from "./chat-ui.js";
import { agentBuildState, agentDevelopmentState, agentHistory, agentSourceKey, createAgentRuntime, developmentPhases } from "./agent-runtime.js";
import { createDevelopmentView } from "./agent-details-view.js";
import { installAvatarMotion, renderAgentAvatar } from "./agent-avatar.js";

installAvatarMotion(document, window);

let storage;
try { storage = window.localStorage; } catch { storage = null; }
let agents = [];
let mainBusy = false;
let route = { page: "chat", agentId: null };
const runtimes = new Map(), inputs = new Map();
const profileVersions = new Map(), broadcasting = new Set();
let profilesError = "";
let developmentView = null;
let inspectionTimer = null;
const api = createAgentRuntime();
const history = new AgentConversationHistory({ api, storage, exists: (id) => agents.some((agent) => agent.id === id),
  onChange(id, messagesChanged = false) {
    if (!visible(id) || !current()) return;
    renderHistory(current());
    if (messagesChanged) renderMessages(current());
    renderControls(current());
    const item = conversation(id);
    byId("agent-conversation-title").textContent = item.messages.length || item.saveVersion ? item.title : agentDisplayName(current());
    renderStorageNote(current());
  } });
const conversations = history.active;
const switchRequests = new Map();
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
  return history.current(id);
}

async function loadConversation(agent) {
  return history.load(agent);
}

let historyCollapsed = false;
try { historyCollapsed = storage?.getItem("neuma.agent.history-collapsed.v1") === "true"; } catch {}

function renderHistory(agent) {
  const list = byId("agent-history-list"), state = history.state(agent.id), selected = conversation(agent.id);
  const focusedId = document.activeElement?.dataset?.conversationId;
  const focusedDelete = document.activeElement?.className === "agent-history-delete";
  list.replaceChildren();
  const records = history.records(agent.id);
  byId("agent-history-count").textContent = String(records.length);
  byId("agent-history-feedback").textContent = state.loading ? "正在读取历史对话…" : state.error
    || (!records.length ? "还没有历史对话，发送消息开始聊天。" : "按最近更新排列");
  byId("agent-workspace").classList.toggle("history-collapsed", historyCollapsed);
  byId("agent-history-body").hidden = historyCollapsed;
  const toggle = byId("agent-history-toggle"), label = historyCollapsed ? "展开历史对话" : "收起历史对话";
  toggle.setAttribute("aria-expanded", String(!historyCollapsed));
  toggle.setAttribute("aria-label", label); toggle.title = label;
  for (const item of records) {
    const row = element("div", "agent-history-row", "");
    row.classList.toggle("is-current", item === selected);
    const select = element("button", "agent-history-select", "");
    select.type = "button"; select.dataset.conversationId = item.id;
    select.setAttribute("aria-label", `打开对话：${item.title}`);
    if (item === selected) select.setAttribute("aria-current", "true");
    const date = new Date(item.updatedAt);
    select.append(element("span", "agent-history-title", item.title), element("span", "agent-history-time",
      `${Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : ""}${item.pendingSync ? " · 待同步" : ""}`));
    select.disabled = item.deleting;
    select.addEventListener("click", () => selectConversation(agent.id, item.id));
    const remove = element("button", "agent-history-delete", "删除");
    remove.type = "button"; remove.dataset.conversationId = item.id;
    remove.setAttribute("aria-label", `删除对话：${item.title}`); remove.disabled = item.deleting;
    remove.addEventListener("click", () => deleteConversation(agent.id, item.id));
    row.append(select, remove); list.append(row);
    if (focusedId === item.id) (focusedDelete ? remove : select).focus({ preventScroll: true });
  }
}

async function stopConversation(id, item = conversation(id)) {
  const operation = item.turn;
  if (!operation) return;
  operation.controller.abort();
  operation.reply.status = "stopped";
  operation.reply.error = "本轮任务未完成，已显示的内容保留。";
  const user = item.messages[item.messages.indexOf(operation.reply) - 1];
  if (user?.role === "user") user.delivery = "stopped";
  item.turn = item.replyView = null;
  void history.changed(id, item, { immediate: true });
  if (visible(id, item) && current()) { renderMessages(current()); renderControls(current()); }
  try { await api.cancel(item.sessionId); }
  catch (error) { item.error = error.message || "停止请求未确认，请稍后重试。"; }
}

async function selectConversation(id, cid) {
  if (!visible(id) || conversation(id).id === cid) return;
  const sequence = (switchRequests.get(id) || 0) + 1;
  switchRequests.set(id, sequence);
  const previous = conversation(id);
  inputs.set(previous.id, input.value);
  await stopConversation(id, previous);
  if (!visible(id) || switchRequests.get(id) !== sequence) return;
  await history.select(id, cid);
  if (!visible(id) || switchRequests.get(id) !== sequence || conversation(id).id !== cid) return;
  input.value = inputs.get(cid) || "";
  input.dispatchEvent(new Event("input"));
  renderWorkspace(); input.focus();
}

async function deleteConversation(id, cid) {
  const item = history.state(id).items.get(cid);
  if (!item || !window.confirm(`删除“${item.title}”？删除后无法恢复对话，已生成的文件仍可在产物中查看。`)) return;
  const selected = conversation(id) === item;
  await stopConversation(id, item);
  if (!await history.remove(id, cid)) return;
  inputs.delete(cid);
  if (selected && visible(id)) { input.value = inputs.get(conversation(id).id) || ""; input.dispatchEvent(new Event("input")); input.focus(); }
}

function runtime(agent) {
  if (!runtimes.has(agent.id)) runtimes.set(agent.id, {
    status: "unchecked", sourceKey: agentSourceKey(agent), definition: null, architecture: null, development: null, operation: null, inspection: null, sequence: 0,
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
    const name = agentDisplayName(agent);
    link.setAttribute("aria-label", `进入 ${name} 的对话`);
    if (visible(agent.id)) link.setAttribute("aria-current", "page");
    const mark = element("span", "agent-avatar", "");
    renderAgentAvatar(mark, agent);
    mark.setAttribute("aria-hidden", "true");
    const state = runtime(agent);
    const label = element("span", "sidebar-agent-label", "");
    const statusLabel = { building: "正在设计与检查", designing: "正在设计", evaluating: "正在评估", developing: "研发进行中",
      needs_changes: "方案待调整", needs_evidence: "待补充依据", needs_connection: "待连接能力",
      needs_development: "需要研发", infeasible: "方案不可行", failed: "处理失败", cancelled: "已停止",
      blocked: "尚未就绪", stale: "需求已更新 · 待生成" };
    label.append(element("strong", "", name), element("small", "", state.status === "ready"
      ? "可以运行" : statusLabel[state.status] || "待生成"));
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
    const mark = element("span", "welcome-mark", "");
    renderAgentAvatar(mark, agent);
    welcome.append(mark,
      element("strong", "", `这里是「${agentDisplayName(agent)}」的对话`),
      element("p", "", agentDisplayDescription(agent)),
      element("p", "muted-note", runtime(agent).status === "ready"
        ? "输入一项任务，让这个智能体开始处理。" : "设计与检查通过，并生成可用的智能体后，就可以在这里执行任务。"));
    container.append(welcome);
  }
  for (const message of item.messages) {
    if (message.role === "user") {
      const row = renderUserMessage(message, input);
      item.userRows.set(message, row);
      container.append(row);
    }
    else {
      const view = createReplyView(agentDisplayName(agent));
      view.update(message);
      container.append(view.row);
      if (message === item.turn?.reply) item.replyView = view;
    }
  }
  container.scrollTop = container.scrollHeight;
}

function renderControls(agent) {
  const state = runtime(agent), item = conversation(agent.id), operation = state.operation || item.turn;
  const development = agentDevelopmentState(agent, state);
  const library = history.state(agent.id);
  const busy = Boolean(operation || development.active || item.loading
    || (library.loading && library.selection === library.loading.selection) || item.deleting
    || (!item.loaded && item.saveVersion));
  byId("agent-runtime-status").textContent = state.status === "building" ? state.label || "正在设计与检查…"
    : state.status === "ready" && item.turn ? "正在处理任务…"
      : state.status === "stale" ? "需求已更新，请重新生成后继续任务。"
        : state.status === "checking" || state.status === "unchecked" ? "正在读取智能体…"
          : state.status === "error" ? "生成未完成，可以重试。" : state.label || "需求已确认，点击生成智能体开始设计与检查。";
  if (profilesError) byId("agent-runtime-status").textContent += " · 名称与图标暂时未加载";
  byId("agent-build").disabled = busy || state.status === "checking";
  byId("agent-build").textContent = state.status === "building" ? "正在生成…" : state.definition ? "重新生成智能体" : "生成智能体";
  byId("agent-send").hidden = Boolean(operation);
  byId("agent-send").disabled = state.status !== "ready" || busy;
  byId("agent-cancel-reply").hidden = !operation || Boolean(operation.kind?.startsWith("development") || operation.development);
  byId("agent-cancel-reply").disabled = Boolean(operation?.controller.signal.aborted);
  byId("agent-chat-form").setAttribute("aria-busy", String(busy));
  byId("agent-chat-save-status").textContent = item.messages.length
    ? item.saving ? "保存中" : item.pendingSync ? "待同步" : item.saved ? "已保存" : "自动保存" : "自动保存";
  byId("agent-chat-save-status").hidden = !item.storageError;
  byId("agent-chat-save-status").dataset.error = String(Boolean(item.storageError));
  byId("agent-chat-retry").hidden = !item.storageError && !library.error;
  byId("agent-chat-retry").disabled = Boolean(item.saving || item.loading || library.loading || item.conflict);
  byId("agent-chat-fork").hidden = !item.conflict;
  byId("agent-chat-fork").disabled = Boolean(item.turn || item.deleting);
  byId("agent-new-chat").disabled = Boolean(item.deleting);
  showError(item.error || item.storageError || state.error);
  renderDevelopment(agent, development);
  broadcastRuntime(agent);
  scheduleInspection(agent);
}

function clearInspectionTimer() {
  if (inspectionTimer !== null) clearTimeout(inspectionTimer);
  inspectionTimer = null;
}

function serverOperationPending(agent, state = runtime(agent)) {
  const architecture = state.architecture;
  return architecture?.agentId === agent.id && agentSourceKey(architecture) === state.sourceKey
    && (["designing", "evaluating"].includes(architecture.status) || agentDevelopmentState(agent, state).active);
}

function scheduleInspection(agent) {
  if (!agent || !visible(agent.id)) return;
  clearInspectionTimer();
  const state = runtime(agent);
  if (state.operation || conversations.get(agent.id)?.turn || state.inspection
    || !serverOperationPending(agent, state)) return;
  inspectionTimer = setTimeout(() => {
    inspectionTimer = null;
    const latest = current();
    if (visible(agent.id) && latest) return inspectAgent(latest, true);
  }, 3000);
}

function renderDevelopment(agent, development = agentDevelopmentState(agent, runtime(agent))) {
  const container = byId("agent-development");
  if (!container) return;
  const state = runtime(agent), operation = state.operation?.kind?.startsWith("development") || state.operation?.development ? state.operation : null;
  container.hidden = !development.visible && !operation;
  if (container.hidden) { container.replaceChildren(); developmentView = null; return; }
  const focusedAction = developmentView?.agentId === agent.id
    ? document.activeElement === developmentView.start ? "start" : document.activeElement === developmentView.stop ? "stop" : null : null;
  const tasksOpen = developmentView?.agentId === agent.id ? developmentView.taskDetails?.open : undefined;
  developmentView = { ...createDevelopmentView(development, { phase: operation?.phase, label: operation?.label, tasksOpen,
    busy: Boolean(operation), stopping: Boolean(operation?.stopping || operation?.controller.signal.aborted),
    onStart: () => developAgent(agent.id), onStop: () => operation?.kind === "build" ? stopAgent(agent.id) : stopDevelopment(agent.id) }), agentId: agent.id };
  container.replaceChildren(developmentView.root);
  if (focusedAction) (developmentView[focusedAction] || developmentView.start || developmentView.stop || developmentView.root).focus({ preventScroll: true });
}

function broadcastRuntime(agent = current()) {
  if (!agent || broadcasting.has(agent.id)) return;
  agent = agents.find((entry) => entry.id === agent.id);
  if (!agent) return;
  const state = runtime(agent), item = conversation(agent.id), development = agentDevelopmentState(agent, state);
  const busy = Boolean(state.operation || item.turn || development.active || item.loading || history.state(agent.id).loading);
  broadcasting.add(agent.id);
  try {
    document.dispatchEvent(new CustomEvent("neuma:agent-runtime-change", { detail: {
      agentId: agent.id, agent: structuredClone(agent), definition: state.definition ? structuredClone(state.definition) : null,
      architecture: state.architecture ? structuredClone(state.architecture) : null,
      development: state.development ? structuredClone(state.development) : null,
      developmentAction: development.canStart || development.canResume ? development.actionLabel : null,
      status: state.status, ready: state.status === "ready" && !busy, busy, error: item.error || item.storageError || state.error,
    } }));
  } finally { broadcasting.delete(agent.id); }
}

function syncProfile(id, profile, version) {
  const agent = agents.find((entry) => entry.id === id);
  if (!agent || !profile || typeof profile !== "object" || version !== (profileVersions.get(id) || 0)) return;
  const normalized = { ...profile, id };
  if (JSON.stringify(agent.profile) === JSON.stringify(normalized)) return;
  document.dispatchEvent(new CustomEvent("neuma:agent-profile-changed", { detail: { id, profile: normalized } }));
}

async function loadProfiles() {
  const versions = new Map(profileVersions);
  try {
    const result = await api.listProfiles();
    if (!Array.isArray(result.profiles)) throw new Error("名称与图标暂时无法读取");
    const profiles = result.profiles.filter((profile) => profile && typeof profile.id === "string"
      && (versions.get(profile.id) || 0) === (profileVersions.get(profile.id) || 0));
    document.dispatchEvent(new CustomEvent("neuma:agent-profiles-loaded", { detail: { profiles } }));
    profilesError = "";
  } catch { profilesError = "名称与图标暂时未加载"; }
  if (route.page === "agent" && current()) renderControls(current());
}

function renderArchitecture(agent, brief) {
  const record = runtime(agent).architecture;
  if (!record || record.agentId !== agent.id || agentSourceKey(record) !== agentSourceKey(agent)) return;
  const details = element("details", "agent-requirements-details", "");
  details.append(element("summary", "", "方案与检查结果"));
  const profiles = { light: "轻量助手", workflow: "流程助手", custom: "专用程序" };
  const capabilities = (Array.isArray(record.design?.capabilities) ? record.design.capabilities : [])
    .filter((item) => item?.status !== "available").map((item) => item?.reason)
    .filter((text) => typeof text === "string").join("；");
  const issues = (Array.isArray(record.issues) ? record.issues : []).map((issue) => [issue?.description, issue?.remedy]
    .filter((text) => typeof text === "string" && text.trim()).join(" ")).filter(Boolean).join("；");
  for (const [label, value] of [["方案类型", profiles[record.design?.profile]], ["方案说明", record.summary],
    ["选择理由", record.design?.rationale], ["检查结论", record.review?.summary],
    ["待处理问题", issues], ["待接入能力", capabilities]]) {
    if (typeof value !== "string" || !value.trim()) continue;
    const row = element("div", "draft-field", "");
    row.append(element("div", "field-label", label), element("div", "field-value", value));
    details.append(row);
  }
  brief.append(details);
  const development = agentDevelopmentState(agent, runtime(agent));
  if (development.record) {
    const row = element("div", "draft-field", "");
    row.append(element("div", "field-label", development.label), element("div", "field-value", development.summary));
    details.append(row);
  }
}

function renderWorkspace({ renderConversation = true } = {}) {
  if (route.page !== "agent") return;
  const agent = current();
  byId("agent-missing").hidden = Boolean(agent);
  byId("agent-workspace").hidden = !agent;
  byId("agent-iterate").hidden = !agent;
  byId("agent-title").textContent = agent ? agentDisplayName(agent) : "找不到智能体";
  renderAgentAvatar(byId("agent-icon"), agent);
  byId("agent-subtitle").textContent = agent ? agentDisplayDescription(agent) : "请回到 NEUMA 创建或确认需求。";
  if (!agent) return;
  byId("agent-conversation-title").textContent = conversation(agent.id).messages.length || conversation(agent.id).saveVersion
    ? conversation(agent.id).title : agentDisplayName(agent);
  byId("agent-message-label").textContent = `给 ${agentDisplayName(agent)} 的任务`;
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
  renderArchitecture(agent, brief);
  renderHistory(agent);
  if (renderConversation || !conversation(agent.id).messages.length) renderMessages(agent);
  renderControls(agent);
  renderStorageNote(agent);
}

function renderStorageNote(agent) {
  const item = conversation(agent.id);
  byId("agent-storage-note").textContent = `${agent.persisted ? agent.dirty ? "原需求在 Agent 文件夹，当前修改尚未保存。" : "需求已保存在 Agent 文件夹。" : agent.localBackup ? "需求仅有浏览器备份，请重试保存到 Agent 文件夹。" : "入口仅在当前页面存在，请保存需求以便下次打开。"}${item.loading
    ? "正在读取历史对话。" : item.saved ? "对话已自动保存在 Agent 文件夹。"
      : item.localBackup ? "当前对话的本机备份已保留。" : "发送消息后，对话会自动保存。"}`;
}

async function inspectAgent(agent, refresh = false) {
  const state = runtime(agent);
  if (state.inspection || state.operation || conversations.get(agent.id)?.turn || (!refresh && state.status !== "unchecked")) return;
  const sequence = ++state.sequence;
  const sourceKey = state.sourceKey, inspection = { sequence };
  const valid = () => state.sequence === sequence && runtimes.get(agent.id) === state && state.sourceKey === sourceKey
    && !state.operation && !conversations.get(agent.id)?.turn && agents.some((item) => item.id === agent.id);
  state.inspection = inspection;
  const profileVersion = profileVersions.get(agent.id) || 0;
  if (!refresh || state.status === "unchecked") state.status = "checking";
  if (visible(agent.id)) renderControls(agent);
  try {
    const result = await api.inspect(agent.id);
    if (!valid()) return;
    state.definition = result.agent ?? null;
    state.architecture = result.architecture ?? null;
    state.development = result.development ?? null;
    state.error = "";
    Object.assign(state, agentBuildState(agent, result));
    syncProfile(agent.id, result.profile || result.agent?.profile, profileVersion);
  } catch (error) {
    if (!valid()) return;
    state.status = "error";
    state.error = error.message || "无法读取智能体，请重新生成。";
  } finally {
    if (state.inspection === inspection) state.inspection = null;
    if (valid()) {
      renderSidebar();
      if (visible(agent.id)) renderWorkspace({ renderConversation: !refresh });
    } else if (visible(agent.id)) scheduleInspection(current());
  }
}

async function buildAgent(id, queueIfBusy = false) {
  const agent = agents.find((item) => item.id === id);
  if (!agent) return;
  const state = runtime(agent), item = conversation(id);
  if (state.operation || item.turn || agentDevelopmentState(agent, state).active) {
    if (queueIfBusy && (item.turn || state.operation?.sourceKey !== agentSourceKey(agent)
      || state.operation?.controller.signal.aborted)) state.rebuildRequested = true;
    return;
  }
  state.rebuildRequested = false;
  const operation = { kind: "build", controller: new AbortController(), sourceKey: agentSourceKey(agent) };
  const profileVersion = profileVersions.get(id) || 0;
  state.sequence++;
  state.operation = operation;
  state.status = "building";
  state.architecture = null;
  state.development = null;
  state.error = item.error = "";
  state.label = "正在设计与检查…";
  renderSidebar();
  if (visible(id)) renderWorkspace();
  try {
    const result = await api.build(agent, { signal: operation.controller.signal, onProgress(progress) {
      if (operation.controller.signal.aborted || state.operation !== operation) return;
      if (progress.type === "status") state.label = progress.label || "正在设计与检查…";
      if (progress.architecture?.agentId === id && agentSourceKey(progress.architecture) === operation.sourceKey) state.architecture = progress.architecture;
      if (agentDevelopmentState(agent, { architecture: state.architecture, development: progress.development }).record) {
        state.development = progress.development; operation.development = true;
        operation.phase = progress.phase; operation.label = progress.label;
      }
      if (visible(id)) renderControls(agent);
    } });
    operation.controller.signal.throwIfAborted();
    if (state.sourceKey !== operation.sourceKey) return;
    state.definition = result.agent ?? null;
    state.architecture = result.architecture ?? null;
    state.development = result.development ?? null;
    Object.assign(state, agentBuildState(agent, result));
    if (state.status === "ready") item.sessionId = crypto.randomUUID();
    syncProfile(id, result.profile || result.agent?.profile, profileVersion);
  } catch (error) {
    if (state.sourceKey !== operation.sourceKey) return;
    state.status = "error";
    state.error = operation.controller.signal.aborted || error.reason === "cancelled" ? "生成已停止，可以重新生成。" : error.message || "生成失败，请重试。";
    if (operation.development) {
      try {
        if (operation.controller.signal.aborted) await api.cancelDevelopment(id);
        const snapshot = await api.inspect(id);
        if (state.operation === operation && state.sourceKey === operation.sourceKey) {
          applyDevelopmentResult(agent, state, snapshot);
          if (snapshot.development?.status !== "completed") state.error = "研发进度已保存，可以继续。";
        }
      } catch { state.error = "研发连接已结束，进度尚未确认，请刷新后核实。"; }
    }
  } finally {
    if (state.operation === operation) state.operation = null;
    renderSidebar();
    if (visible(id)) renderWorkspace();
    await rebuildIfRequested(id, state);
  }
}

function currentDevelopmentOperation(id, state, operation) {
  return runtimes.get(id) === state && state.operation === operation && state.sourceKey === operation.sourceKey
    && agents.some((agent) => agent.id === id);
}

function applyDevelopmentResult(agent, state, result) {
  state.definition = result.agent ?? null;
  state.architecture = result.architecture ?? null;
  state.development = result.development ?? null;
  Object.assign(state, agentBuildState(agent, result));
}

async function developAgent(id) {
  const agent = agents.find((entry) => entry.id === id);
  if (!agent) return;
  const state = runtime(agent), item = conversation(id), development = agentDevelopmentState(agent, state);
  if (state.operation || item.turn || (!development.canStart && !development.canResume)) return;
  const operation = { kind: "development", controller: new AbortController(), sourceKey: agentSourceKey(agent),
    phase: development.record?.phase || "intake", label: development.canResume ? "正在核实已保存的研发进度…" : "正在接收已通过的设计…" };
  const profileVersion = profileVersions.get(id) || 0;
  state.sequence++; state.operation = operation; state.status = "developing"; state.error = item.error = "";
  state.label = operation.label;
  renderSidebar(); if (visible(id)) renderControls(agent);
  try {
    const result = await api.develop(id, { resume: development.canResume, signal: operation.controller.signal, onProgress(progress) {
      if (!currentDevelopmentOperation(id, state, operation) || operation.controller.signal.aborted || progress.type !== "status") return;
      if (developmentPhases.some(([phase]) => phase === progress.phase)) operation.phase = progress.phase;
      if (typeof progress.label === "string") state.label = operation.label = progress.label;
      if (agentDevelopmentState(agent, { architecture: state.architecture, development: progress.development }).record)
        state.development = progress.development;
      if (visible(id)) renderControls(agent);
    } });
    operation.controller.signal.throwIfAborted();
    if (!currentDevelopmentOperation(id, state, operation)) return;
    applyDevelopmentResult(agent, state, result);
    if (state.status === "ready") item.sessionId = crypto.randomUUID();
    syncProfile(id, result.profile || result.agent?.profile, profileVersion);
  } catch (error) {
    if (!currentDevelopmentOperation(id, state, operation)) return;
    state.error = operation.stopping ? "" : error.message || "研发未完成，正在核实已保存的进度。";
    try {
      // Reconcile from durable server state after the stream ends; a lost response is not a successful build.
      if (operation.cancelPromise) await operation.cancelPromise;
      const result = await api.inspect(id);
      if (!currentDevelopmentOperation(id, state, operation)) return;
      if (operation.stopping && result.development?.status === "completed") {
        state.status = "needs_development"; state.error = "停止请求后的结果尚未确认，请刷新页面核实研发状态。";
      } else applyDevelopmentResult(agent, state, result);
    } catch (recoveryError) {
      if (!currentDevelopmentOperation(id, state, operation)) return;
      state.status = "needs_development";
      state.error = recoveryError.message || "研发状态暂时无法确认，请刷新页面读取已保存的进度。";
    }
  } finally {
    if (state.operation === operation) state.operation = null;
    renderSidebar(); if (visible(id)) renderWorkspace();
    await rebuildIfRequested(id, state);
  }
}

async function stopDevelopment(id) {
  const agent = agents.find((entry) => entry.id === id);
  if (!agent) return;
  const state = runtime(agent), local = state.operation?.kind === "development";
  if (state.operation?.stopping || (!local && (state.operation || !agentDevelopmentState(agent, state).active))) return;
  const operation = local ? state.operation : { kind: "development-stop", controller: new AbortController(), sourceKey: agentSourceKey(agent) };
  operation.stopping = true; state.sequence++; state.operation = operation;
  operation.cancelPromise = api.cancelDevelopment(id);
  operation.controller.abort();
  if (visible(id)) renderControls(agent);
  try {
    const result = await operation.cancelPromise;
    if (!currentDevelopmentOperation(id, state, operation)) return;
    if (result.development?.agentId === id && result.development.status !== "completed") state.development = result.development;
    if (!local) {
      const snapshot = await api.inspect(id);
      if (!currentDevelopmentOperation(id, state, operation)) return;
      if (snapshot.development?.status !== "completed") applyDevelopmentResult(agent, state, snapshot);
      else { state.status = "needs_development"; state.error = "停止请求后的结果尚未确认，请刷新页面核实研发状态。"; }
    }
  } catch (error) {
    if (currentDevelopmentOperation(id, state, operation)) state.error = error.message || "停止研发尚未确认，请稍后重试。";
  } finally {
    if (!local && state.operation === operation) state.operation = null;
    if (visible(id)) renderControls(agent);
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
  if (operation?.kind?.startsWith("development")) return stopDevelopment(id);
  if (item.turn) return stopConversation(id, item);
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
  const library = history.state(agent.id);
  if (state.status !== "ready" || state.operation || item.turn || item.loading
    || (library.loading && library.selection === library.loading.selection)
    || item.deleting || (!item.loaded && item.saveVersion)) return;
  if (message.length > 4000) return showError("任务输入需为 1～4000 字。");
  const turnHistory = agentHistory(item.messages, state.definition.revision);
  const user = addUserMessage(item.messages, message);
  user.revision = String(state.definition.revision);
  const reply = { role: "assistant", content: "", status: "thinking", label: "正在处理任务…", revision: user.revision };
  const operation = { controller: new AbortController(), reply };
  item.turn = operation;
  item.loaded = true;
  item.messages.push(reply);
  item.saved = false;
  item.error = "";
  input.value = "";
  inputs.delete(item.id);
  input.dispatchEvent(new Event("input"));
  renderWorkspace();
  void history.changed(agent.id, item, { immediate: true });
  try {
    const result = await api.turn({ agentId: agent.id, sessionId: item.sessionId, message, history: turnHistory }, {
      signal: operation.controller.signal, onProgress(progress) {
        if (operation.controller.signal.aborted) return;
        if (progress.type === "text-start") { reply.content = ""; reply.status = "thinking"; }
        if (progress.type === "text-delta" && typeof progress.delta === "string") { reply.content += progress.delta; reply.status = "writing"; }
        if (progress.type === "status") { reply.status = "thinking"; reply.label = progress.label || "正在处理任务…"; }
        updateReply(agent.id, item);
        history.changed(agent.id, item);
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
      else if (!visible(agent.id, item) && !inputs.get(item.id)?.trim()) inputs.set(item.id, message);
    }
  } finally {
    if (visible(agent.id, item)) {
      updateReply(agent.id, item);
      if (user.delivery !== "sent") item.userRows.get(user)?.replaceWith(renderUserMessage(user, input));
    }
    if (item.turn === operation) item.turn = item.replyView = null;
    await history.changed(agent.id, item, { immediate: true });
    if (visible(agent.id, item)) {
      const restoreInput = [input, byId("agent-send"), byId("agent-cancel-reply")].includes(document.activeElement);
      renderControls(agent);
      if (restoreInput) input.focus();
    }
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
    state.label = "";
    state.error = "";
  }
  renderSidebar();
  renderWorkspace();
  if (route.page === "agent" && current()) return Promise.all([inspectAgent(current()), loadConversation(current())]);
});
document.addEventListener("neuma:route", (event) => {
  clearInspectionTimer();
  if (route.page === "agent" && current()) inputs.set(conversation(route.agentId).id, input.value);
  const previousPage = route.page, previousId = route.agentId;
  route = event.detail;
  if (route.page === "agent" && previousId !== route.agentId) {
    input.value = inputs.get(conversation(route.agentId).id) ?? "";
    input.dispatchEvent(new Event("input"));
  }
  renderSidebar();
  renderWorkspace();
  if (route.page === "agent" && current()) {
    if (previousPage !== "agent" || previousId !== route.agentId) input.focus();
    return Promise.all([inspectAgent(current(), serverOperationPending(current())), loadConversation(current())]);
  }
});
document.addEventListener("neuma:agent-build", (event) => buildAgent(event.detail.id, true));
document.addEventListener("neuma:agent-develop", (event) => developAgent(event.detail.id));
document.addEventListener("neuma:agent-development-stop", (event) => stopDevelopment(event.detail.id));
document.addEventListener("neuma:agent-runtime-request", (event) => {
  const agent = agents.find((item) => item.id === (event.detail?.agentId ?? route.agentId));
  if (agent) broadcastRuntime(agent);
});
document.addEventListener("neuma:agent-profile-changed", (event) => {
  const { id } = event.detail ?? {};
  if (typeof id === "string") profileVersions.set(id, (profileVersions.get(id) || 0) + 1);
});
document.addEventListener("neuma:agent-removed", (event) => {
  const id = event.detail.id, item = conversations.get(id);
  if (id === route.agentId) clearInspectionTimer();
  runtimes.get(id)?.operation?.controller.abort();
  item?.loading?.controller.abort();
  item?.saving?.controller.abort();
  if (item?.turn) { item.turn.controller.abort(); api.cancel(item.sessionId).catch(() => {}); }
  for (const entry of history.state(id).items.values()) inputs.delete(entry.id);
  history.clear(id);
  runtimes.delete(id);
  inputs.delete(id);
  profileVersions.delete(id);
  if (!deleteAgentPreview(storage, id)) showError("入口已移除，但浏览器未能删除保存的对话。");
});
document.addEventListener("neuma:agent-saved", (event) => {
  if (event.detail.id === route.agentId) showError(event.detail.ok ? "" : event.detail.message || "Agent 需求尚未保存到文件夹，请重试保存。");
});

byId("sidebar-create-agent").addEventListener("click", () => action("create"));
byId("agent-iterate").addEventListener("click", () => action("edit"));
byId("agent-save-entry").addEventListener("click", () => action("save"));
byId("agent-build").addEventListener("click", () => buildAgent(route.agentId));
byId("agent-cancel-reply").addEventListener("click", () => stopAgent(route.agentId));
byId("agent-chat-retry").addEventListener("click", async () => {
  const agent = current();
  if (!agent) return;
  const state = history.state(agent.id), item = conversation(agent.id);
  if (state.error) { state.loaded = false; return loadConversation(agent); }
  if (!item.loaded && item.saveVersion) return history.read(agent.id, item);
  return history.save(agent.id, item);
});
byId("agent-chat-fork").addEventListener("click", async () => {
  const agent = current();
  if (!agent) return;
  await stopConversation(agent.id);
  await history.fork(agent.id);
  if (visible(agent.id)) renderWorkspace();
});
byId("agent-history-toggle").addEventListener("click", () => {
  const agent = current();
  if (!agent) return;
  historyCollapsed = !historyCollapsed;
  try { storage?.setItem("neuma.agent.history-collapsed.v1", String(historyCollapsed)); } catch {}
  if (historyCollapsed) byId("agent-history-toggle").focus({ preventScroll: true });
  renderHistory(agent);
});
byId("agent-new-chat").addEventListener("click", async () => {
  const agent = current();
  if (!agent) return;
  const sequence = (switchRequests.get(agent.id) || 0) + 1;
  switchRequests.set(agent.id, sequence);
  const previous = conversation(agent.id);
  inputs.set(previous.id, input.value);
  await stopConversation(agent.id, previous);
  if (!visible(agent.id) || switchRequests.get(agent.id) !== sequence) return;
  history.blank(agent.id);
  input.value = "";
  renderWorkspace();
  input.dispatchEvent(new Event("input"));
  input.focus();
});
byId("agent-chat-form").addEventListener("submit", (event) => { event.preventDefault(); return sendMessage(); });
window.addEventListener?.("pagehide", () => history.checkpoint());

document.dispatchEvent(new CustomEvent("neuma:agents-request"));
void loadProfiles();
