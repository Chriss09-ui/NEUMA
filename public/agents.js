import { agentDisplayDescription, agentDisplayIcon, agentDisplayName, deleteAgentPreview, loadAgentPreview, saveAgentPreview } from "./state.js";
import { addUserMessage, createReplyView, renderUserMessage } from "./chat-ui.js";
import { agentBuildState, agentDevelopmentState, agentHistory, agentSourceKey, createAgentRuntime, developmentPhases } from "./agent-runtime.js";
import { createDevelopmentView } from "./agent-details-view.js";

let storage;
try { storage = window.localStorage; } catch { storage = null; }
let agents = [];
let mainBusy = false;
let route = { page: "chat", agentId: null };
const conversations = new Map(), runtimes = new Map(), inputs = new Map();
const profileVersions = new Map(), broadcasting = new Set();
let profilesError = "";
let developmentView = null;
let inspectionTimer = null;
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
    const mark = element("span", "agent-avatar", agentDisplayIcon(agent));
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
    welcome.append(element("span", "welcome-mark", agentDisplayIcon(agent)),
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
  const busy = Boolean(operation || development.active);
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
  byId("agent-save-chat").disabled = Boolean(item.turn);
  showError(item.error || state.error);
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
  const busy = Boolean(state.operation || item.turn || development.active);
  broadcasting.add(agent.id);
  try {
    document.dispatchEvent(new CustomEvent("neuma:agent-runtime-change", { detail: {
      agentId: agent.id, agent: structuredClone(agent), definition: state.definition ? structuredClone(state.definition) : null,
      architecture: state.architecture ? structuredClone(state.architecture) : null,
      development: state.development ? structuredClone(state.development) : null,
      developmentAction: development.canStart || development.canResume ? development.actionLabel : null,
      status: state.status, ready: state.status === "ready" && !busy, busy, error: item.error || state.error,
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
  byId("agent-icon").textContent = agent ? agentDisplayIcon(agent) : "";
  byId("agent-subtitle").textContent = agent ? agentDisplayDescription(agent) : "请回到 NUEMA 创建或确认需求。";
  if (!agent) return;
  byId("agent-conversation-title").textContent = agentDisplayName(agent);
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
  if (renderConversation || !conversation(agent.id).messages.length) renderMessages(agent);
  renderControls(agent);
  byId("agent-storage-note").textContent = `${agent.persisted ? "需求已保存在此浏览器。" : "入口仅在当前页面存在，请保存需求以便下次打开。"}${conversation(agent.id).saved
    ? "这份对话已手动保存；新消息需再次保存。" : "对话仅在本页保留，点击保存后刷新可恢复。"}`;
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
  if (route.page === "agent" && current()) return inspectAgent(current());
});
document.addEventListener("neuma:route", (event) => {
  clearInspectionTimer();
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
    return inspectAgent(current(), serverOperationPending(current()));
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
  if (item?.turn) { item.turn.controller.abort(); api.cancel(item.sessionId).catch(() => {}); }
  conversations.delete(id);
  runtimes.delete(id);
  inputs.delete(id);
  profileVersions.delete(id);
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
void loadProfiles();
