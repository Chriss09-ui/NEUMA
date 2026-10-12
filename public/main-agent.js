import { createCollaborationApi } from "./collaboration-api.js";
import { createMainMaterials } from "./main-materials.js";
import { createMainContext } from "./main-context.js";
import { button, messageRow, node, notice } from "./group-view.js";

const api = createCollaborationApi(), byId = (id) => document.getElementById(id);
let selected = null, records = [], operation = null, loading = false, loaded = false, sequence = 0;
let retryRequest = null, page = "chat", listing = null, activationSequence = 0, activationRetry = null;
let needsConversationReload = false, needsHistoryReload = false;
const drafts = new Map();
const ACTIVE_KEY = "neuma.main.active-conversation.v1";
const materials = createMainMaterials({ api, current: () => selected, create, changed: controls,
  onError: (message) => notice(byId("main-error"), message, true) });
const contextPanel = createMainContext({ api, current: () => selected,
  submit(message) { if (operation || loading) return; byId("main-message").value = message; void send(); },
  edit(message) { if (!byId("main-message").value.trim()) byId("main-message").value = message; byId("main-message").focus(); },
  build: buildRequirement });
const HISTORY_KEY = "neuma.main.history-collapsed.v1";
let historyCollapsed = false;
try { historyCollapsed = localStorage.getItem(HISTORY_KEY) === "true"; } catch { /* Current layout remains usable. */ }
function historyLayout() {
  byId("main-workspace").classList.toggle("history-collapsed", historyCollapsed);
  byId("main-history-body").inert = historyCollapsed; byId("main-history-body").setAttribute("aria-hidden", String(historyCollapsed));
  const toggle = byId("main-history-toggle"), label = historyCollapsed ? "展开历史对话" : "收起历史对话";
  toggle.setAttribute("aria-expanded", String(!historyCollapsed)); toggle.setAttribute("aria-label", label); toggle.title = label;
}
function buildRequirement(agentId, requirement) {
  const record = requirement || selected?.context?.requirement;
  if (!record || record.id !== agentId) return showRecovery("需求保存记录尚未确认，请重新加载后重试制作。");
  document.dispatchEvent(new CustomEvent("neuma:main-requirement-saved", { detail: { requirement: record, build: true } }));
}
function applyContext(value, { reveal = false, force = false, syncRequirement = false } = {}) {
  if (selected && value !== undefined) selected.context = value;
  contextPanel.set(value ?? selected?.context ?? null, { reveal, force });
  const requirement = value?.requirement;
  if (syncRequirement && requirement) document.dispatchEvent(new CustomEvent("neuma:main-requirement-saved", { detail: { requirement } }));
}
const storage = { read() { try { return localStorage.getItem(ACTIVE_KEY); } catch { return null; } },
  write(id) { try { localStorage.setItem(ACTIVE_KEY, id); } catch { /* Server history remains authoritative. */ } } };

function showRecovery(message, error = true, target = "main-error") {
  if (target === "main-history-status") needsHistoryReload = true;
  else needsConversationReload = true;
  notice(byId(target), message, error); controls();
}
function controls() {
  byId("main-send").disabled = Boolean(loading || operation || materials.busy());
  byId("main-new-chat").disabled = Boolean(loading || operation || materials.busy());
  byId("main-refresh").disabled = Boolean(loading || operation || materials.busy());
  byId("main-refresh").hidden = !(needsConversationReload || needsHistoryReload);
  byId("main-recovery").hidden = byId("main-refresh").hidden;
  byId("main-upload").disabled = Boolean(loading || operation || materials.busy());
  byId("main-materials-open").disabled = Boolean(loading || operation || materials.busy());
  byId("main-cancel").hidden = !operation;
  byId("main-message").disabled = loading;
}
function render() {
  const target = byId("main-messages"), wasBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 100;
  target.replaceChildren();
  byId("main-conversation-title").textContent = selected?.title || "一起推进你的工作";
  byId("main-conversation-title").hidden = !selected?.messages?.length;
  if (!selected?.messages?.length) {
    const welcome = node("div", "collaboration-empty main-welcome");
    const mark = node("span", "brand-mark main-welcome-mark"); mark.setAttribute("aria-hidden", "true");
    const image = node("img"); image.src = "/assets/brand/neuma-mark.png"; image.alt = "";
    image.width = 52; image.height = 52; image.draggable = false; mark.append(image);
    welcome.append(mark, node("h2", "", "今天，想先完成什么？"),
      node("p", "muted-note", "说说你的想法，或把材料发过来。\n整理资料、写文案、分析问题，都可以从这里开始。"));
    const actions = node("div", "main-welcome-actions");
    const groups = node("a", "secondary collaboration-action-link", "查看群组"); groups.href = "#groups";
    actions.append(groups); welcome.append(actions); target.append(welcome);
  }
  for (const message of selected?.messages || []) target.append(messageRow(message, { bubble: true, attachmentUrl: (id) => api.mainMaterialUrl(selected.id, id) }));
  if (operation?.reply) target.append(messageRow(operation.reply, { bubble: true }));
  if (wasBottom) target.scrollTop = target.scrollHeight;
  const list = byId("main-history-list"); list.replaceChildren();
  for (const record of records) {
    const item = button(record.title || "新对话", () => select(record.id), "collaboration-history-item");
    item.title = record.title || "新对话";
    item.disabled = Boolean(operation || loading || materials.busy()); item.setAttribute("aria-current", record.id === selected?.id ? "true" : "false"); list.append(item);
  }
  materials.render(); controls();
}
async function select(id) {
  if (operation || loading || materials.busy()) return;
  const unboundDraft = selected ? "" : byId("main-message").value;
  if (selected) drafts.set(selected.id, byId("main-message").value);
  const current = ++sequence; loading = true; controls();
  try {
    const result = await api.conversation(id);
    if (current !== sequence) return;
    if (result.conversation?.id !== id) throw new Error("主助理对话身份尚未确认，请重试。");
    selected = result.conversation; storage.write(id); retryRequest = null; materials.reset(); contextPanel.reset(selected.context);
    byId("main-message").value = drafts.get(id) ?? unboundDraft;
    needsConversationReload = false;
    notice(byId("main-error"), ""); render();
  } catch (error) { showRecovery(error.message); }
  finally { if (current === sequence) { loading = false; render(); } }
}
async function readList() {
  try {
    const result = await api.conversations();
    if (!Array.isArray(result.conversations)) throw new Error("主助理历史尚未确认。");
    records = result.conversations; loaded = true; needsHistoryReload = false;
    notice(byId("main-history-status"), records.length ? "" : "新的对话会自动保存。");
    render();
    if (!selected && records.length) await select(records.find((record) => record.id === storage.read())?.id || records[0].id);
  } catch (error) { showRecovery(`${error.message} 重新加载后重试。`, true, "main-history-status"); }
}
function list() { if (!listing) listing = readList().finally(() => { listing = null; }); return listing; }
async function create({ preserveInput = true } = {}) {
  if (operation || loading || materials.busy()) return;
  const input = byId("main-message").value;
  if (selected) drafts.set(selected.id, input);
  loading = true; controls();
  try {
    const result = await api.createConversation();
    if (!result.conversation?.id) throw new Error("新对话尚未保存，请重试。");
    selected = result.conversation; storage.write(selected.id); retryRequest = null; materials.reset(); contextPanel.reset(null);
    byId("main-message").value = preserveInput ? input : ""; drafts.set(selected.id, byId("main-message").value);
    needsConversationReload = false;
    notice(byId("main-error"), ""); await list();
  } catch (error) { showRecovery(error.message); }
  finally { loading = false; render(); byId("main-message").focus(); }
}
async function send() {
  const attachmentIds = materials.refs(), supplied = byId("main-message").value.trim();
  const message = supplied || (attachmentIds.length ? "请处理这些材料，任务目标不明确时先向我提问。" : "");
  if (!message || message.length > 4000 || operation || loading || materials.busy()) return;
  if (!selected) { await create(); if (!selected) return; }
  const id = selected.id;
  const previousContext = structuredClone(selected.context ?? null), previousPanel = contextPanel.capture();
  const input = { message, ...(attachmentIds.length ? { attachmentIds } : {}) }, fingerprint = JSON.stringify(input);
  const request = retryRequest?.id === id && retryRequest.fingerprint === fingerprint
    ? retryRequest.body : { ...input, mutationId: crypto.randomUUID() };
  retryRequest = { id, fingerprint, body: request };
  const running = { id, controller: new AbortController(), reply: { role: "assistant", content: "", status: "running" } };
  operation = running;
  selected.messages ||= [];
  const previous = selected.messages.length;
  const user = { role: "user", content: message, ...(attachmentIds.length ? { attachments: materials.attachments() } : {}) };
  selected.messages.push(user);
  byId("main-message").value = ""; needsConversationReload = false; notice(byId("main-error"), ""); render();
  try {
    const result = await api.mainTurn(id, request, { signal: running.controller.signal, onProgress(event) {
      if (operation !== running || running.controller.signal.aborted) return;
      if (event.type === "text-start") running.reply.content = "";
      if (event.type === "text-delta") running.reply.content += event.delta || "";
      if (event.type === "status") byId("main-progress").textContent = event.label || "正在联系智能体、整理工作…";
      if (event.type === "context") applyContext(event.context, { reveal: true });
      render();
    } });
    running.controller.signal.throwIfAborted();
    if (result.conversation?.id !== id) throw new Error("主助理回复身份尚未确认。");
    selected = result.conversation;
    applyContext(result.context ?? selected.context, { reveal: true, syncRequirement: true });
    if (result.actions?.length && selected.messages?.length) selected.messages.at(-1).actions = result.actions;
    for (const action of result.actions || []) if (action.type === "build_agent") buildRequirement(action.agentId, action.requirement || selected.context?.requirement);
    if (result.sources?.some((source) => source.groupId && (source.type === "group_task"
      || (source.type === "group" && ["created", "updated", "archived"].includes(source.operation))))) {
      document.dispatchEvent(new CustomEvent("neuma:groups-changed"));
    }
    retryRequest = null; materials.consume();
  } catch (error) {
    const stopped = running.controller.signal.aborted || error.reason === "cancelled";
    if (stopped || error.reason) retryRequest = null;
    selected.context = previousContext; contextPanel.restore(previousPanel);
    selected.messages.splice(previous);
    if (running.reply.content) selected.messages.push(user, { ...running.reply, status: stopped ? "cancelled" : "error" });
    if (!byId("main-message").value.trim()) byId("main-message").value = message;
    showRecovery(stopped ? "本轮已停止，已保存的内容可重新加载查看。" : `${error.message} 当前输入已保留，可重试或重新加载。`, !stopped);
  } finally {
    if (operation === running) operation = null;
    byId("main-progress").textContent = "主助理位于群外，帮你管理和联系所有智能体。";
    render(); await list();
    if (page === "chat") byId("main-message").focus();
  }
}
async function activateRequirements(agentId) {
  document.dispatchEvent(new CustomEvent("neuma:navigate", { detail: { page: "chat" } }));
  if (!loaded) await list();
  if (operation || loading || materials.busy()) return notice(byId("main-error"), "请等当前回复完成，再继续整理需求。", true);
  if (!selected) { await create(); if (!selected) return; }
  const id = selected.id, token = ++activationSequence, key = `${id}:${agentId || "new"}`;
  const body = activationRetry?.key === key ? activationRetry.body : { ...(agentId ? { agentId } : {}), mutationId: crypto.randomUUID() };
  activationRetry = { key, body }; loading = true; controls();
  try {
    const result = await api.activateRequirements(id, body);
    if (token !== activationSequence || selected?.id !== id) return;
    if (result.conversation?.id !== id) throw new Error("需求对话身份尚未确认。");
    selected = result.conversation; applyContext(result.context || selected.context, { reveal: true, force: true, syncRequirement: true }); activationRetry = null;
    needsConversationReload = false;
    notice(byId("main-error"), ""); render();
  } catch (error) { if (token === activationSequence) showRecovery(`${error.message} 原对话与输入已保留。`); }
  finally { if (token === activationSequence) { loading = false; controls(); byId("main-message").focus(); } }
}
byId("main-chat-form").addEventListener("submit", (event) => { event.preventDefault(); void send(); });
byId("main-new-chat").addEventListener("click", () => void create({ preserveInput: false }));
byId("main-refresh").addEventListener("click", async () => { if (selected) await select(selected.id); await list(); });
byId("main-create-agent").addEventListener("click", () => void activateRequirements());
byId("main-history-toggle").addEventListener("click", () => {
  historyCollapsed = !historyCollapsed;
  if (historyCollapsed && byId("main-history-body").contains?.(document.activeElement)) byId("main-history-toggle").focus();
  historyLayout(); try { localStorage.setItem(HISTORY_KEY, String(historyCollapsed)); } catch { /* Only persistence is unavailable. */ }
});
byId("main-create-group").addEventListener("click", () => document.dispatchEvent(new CustomEvent("neuma:create-group")));
byId("main-cancel").addEventListener("click", async () => {
  const current = operation; if (!current) return;
  byId("main-cancel").disabled = true;
  try { await api.cancelMain(current.id); current.controller.abort(); }
  catch (error) { showRecovery(`停止尚未确认：${error.message}`); }
  finally { byId("main-cancel").disabled = false; }
});
document.addEventListener("neuma:route", (event) => {
  page = event.detail.page;
  contextPanel.route(page);
  if (page === "chat" && !loaded) void list();
});
document.addEventListener("neuma:main-requirements", (event) => void activateRequirements(event.detail?.agentId));
document.addEventListener("neuma:agent-runtime-change", (event) => contextPanel.runtime(event.detail));
historyLayout();
