import { createAgentRuntime } from "./agent-runtime.js";
import { agentDisplayName, agentDisplayDescription } from "./state.js";
import { agentIconChoices, fileDescription, newestFiles, staticArtifactDocument } from "./agent-details-view.js";

const api = createAgentRuntime(), states = new Map();
const byId = (id) => document.getElementById(id), dialog = byId("agent-panel"), fileDialog = byId("agent-file-dialog");
const emit = (type, detail) => document.dispatchEvent(new CustomEvent(type, { detail }));
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let viewTransitions = [];
let route = { page: "chat", agentId: null }, runtime = null, view = "profile", returnFocus = "agent-panel-toggle";
let fileFocus = null, settingsAgentId = null, artifactsCollapsed = false;
let storage;
try { storage = window.localStorage; artifactsCollapsed = storage?.getItem("neuma-agent-artifacts-collapsed") === "true"; } catch { storage = null; }
const currentId = () => route.page === "agent" ? route.agentId : null;
const showing = (id, tab) => currentId() === id && dialog.open && (!tab || view === tab);
const showingFile = (id) => currentId() === id && fileDialog.open && fileFocus?.agentId === id;

function setArtifactsCollapsed(collapsed, remember = true) {
  const body = byId("agent-artifacts-body"), toggle = byId("agent-artifacts-toggle");
  if (collapsed && body.contains(document.activeElement)) toggle.focus({ preventScroll: true });
  artifactsCollapsed = collapsed;
  body.inert = collapsed;
  byId("agent-workspace").classList.toggle("artifacts-collapsed", collapsed);
  toggle.setAttribute("aria-expanded", String(!collapsed));
  const label = collapsed ? "展开历史产物" : "收起历史产物";
  toggle.setAttribute("aria-label", label); toggle.title = label;
  if (remember) {
    try { storage?.setItem("neuma-agent-artifacts-collapsed", String(collapsed)); } catch { /* The current page can still be folded. */ }
  }
}
byId("agent-artifacts-toggle").addEventListener("click", () => setArtifactsCollapsed(!artifactsCollapsed));
setArtifactsCollapsed(artifactsCollapsed, false);

function state(id) {
  if (!states.has(id)) states.set(id, { files: [], filesLoaded: false, filesLoading: false, file: null, filePath: "", filesSequence: 0, fileSequence: 0,
    memory: "", memoryLoaded: false, memorySequence: 0, memorySaving: false, memoryDirty: false,
    profile: null, profileDirty: false, profileSaving: false });
  return states.get(id);
}

function message(id, text, error = false) {
  byId(id).textContent = text;
  byId(id).setAttribute("data-error", String(error));
}

function profileFor(agent) {
  return { name: agentDisplayName(agent), description: agentDisplayDescription(agent).slice(0, 240), icon: agent.profile?.icon || "" };
}

function refreshAvailability() {
  const id = currentId(), ready = Boolean(id && runtime?.definition), item = id ? state(id) : null;
  byId("agent-details-unavailable").hidden = ready;
  for (const name of ["name", "description", "icon"]) byId(`agent-profile-${name}`).disabled = !ready;
  for (const button of byId("agent-icon-options").children) button.disabled = !ready;
  byId("agent-profile-save").disabled = !ready || Boolean(item?.profileSaving);
  byId("agent-memory-input").disabled = !ready || !item?.memoryLoaded;
  byId("agent-memory-save").disabled = !ready || !item?.memoryLoaded || item.memorySaving;
  byId("agent-files-refresh").disabled = !ready;
  if (runtime) {
    byId("agent-build-shortcut").hidden = runtime.ready || runtime.busy || ["checking", "unchecked"].includes(runtime.status);
    byId("agent-build-shortcut").textContent = runtime.developmentAction || (runtime.definition ? "重新生成" : "生成智能体");
  }
}

function renderProfile() {
  const item = state(currentId());
  if (!item.profile) return;
  for (const key of ["name", "description", "icon"]) byId(`agent-profile-${key}`).value = item.profile[key];
  byId("agent-profile-icon").placeholder = Array.from(item.profile.name)[0] || "A";
  for (const button of byId("agent-icon-options").children) button.setAttribute("aria-pressed", String(button.dataset.icon === item.profile.icon));
  message("agent-profile-feedback", item.profileNote || (item.profileDirty ? "有尚未保存的修改。" : "修改资料即可保存，无需重新生成。"), item.profileError);
}

function stopViewTransitions() {
  for (const animation of viewTransitions) animation.cancel();
  viewTransitions = [];
}
reducedMotion.addEventListener("change", stopViewTransitions);

function selectView(next) {
  const changed = next !== view;
  const animate = changed && dialog.open && !reducedMotion.matches && typeof dialog.animate === "function";
  const previousHeight = animate ? dialog.getBoundingClientRect().height : 0;
  if (changed) stopViewTransitions();
  view = next; dialog.dataset.view = view;
  for (const tab of ["memory", "profile"]) {
    byId(`agent-details-${tab}`).hidden = tab !== view;
    byId(`agent-details-${tab}-tab`).setAttribute("aria-pressed", String(tab === view));
  }
  byId("agent-details-title").textContent = "智能体设置";
  byId("agent-details-name").textContent = agentDisplayName(runtime.agent);
  refreshAvailability();
  if (view === "profile") renderProfile();
  if (view === "memory") { renderMemory(); if (runtime.definition) void loadMemory(currentId()); }
  if (animate) {
    const nextHeight = dialog.getBoundingClientRect().height;
    viewTransitions = [
      dialog.animate([{ height: `${previousHeight}px` }, { height: `${nextHeight}px` }],
        { duration: 280, easing: "cubic-bezier(.22, 1, .36, 1)" }),
      byId(`agent-details-${view}`).animate([
        { opacity: 0, transform: `translateX(${view === "memory" ? 8 : -8}px)` },
        { opacity: 1, transform: "translateX(0)" },
      ], { duration: 200, delay: 40, easing: "ease-out", fill: "backwards" }),
    ];
  }
}

function openPanel(next, trigger) {
  if (!currentId() || runtime?.agentId !== currentId()) return;
  returnFocus = trigger;
  settingsAgentId = currentId();
  if (fileDialog.open) fileDialog.close();
  selectView(next);
  if (!dialog.open) dialog.showModal();
}

async function loadFiles(id) {
  const item = state(id), sequence = ++item.filesSequence;
  item.filesLoading = true;
  if (currentId() === id) message("agent-files-feedback", "正在读取产物…");
  try {
    const result = await api.listFiles(id);
    if (sequence !== item.filesSequence || states.get(id) !== item) return;
    item.files = newestFiles(result.files);
    item.filesLoaded = true;
    item.filesNote = result.truncated ? "当前仅显示部分文件。" : item.files.length ? "" : "还没有保存的产物。让智能体把结果保存为文件，就会出现在这里。";
    if (item.filePath && !item.files.some((file) => file.path === item.filePath)) {
      item.file = null; item.filePath = ""; item.fileSequence++;
    }
    if (currentId() === id) {
      renderFiles();
      if (showingFile(id)) {
        renderFile();
        if (item.filePath) void loadFile(id, item.filePath, false);
      }
    }
  } catch (error) {
    if (sequence !== item.filesSequence || states.get(id) !== item) return;
    item.filesNote = `${error.message || "读取失败，请重试。"}${item.files.length ? " 仍显示上次读取的列表。" : ""}`;
    if (currentId() === id) renderFiles();
  } finally {
    if (sequence === item.filesSequence) item.filesLoading = false;
  }
}

function renderFiles() {
  if (!currentId()) return;
  const item = state(currentId()), list = byId("agent-file-list");
  const focusedPath = list.contains(document.activeElement) ? document.activeElement.dataset.path : null;
  byId("agent-artifacts-count").textContent = String(item.files.length);
  message("agent-files-feedback", item.filesNote || (item.filesLoaded ? "" : "生成智能体后，可查看保存的文件。"));
  list.replaceChildren();
  for (const file of item.files) {
    const id = currentId(), button = document.createElement("button"); button.type = "button"; button.className = "agent-file-item";
    button.dataset.path = file.path;
    button.setAttribute("aria-pressed", String(file.path === item.filePath));
    const title = document.createElement("strong"), info = document.createElement("small");
    title.textContent = file.path; info.textContent = fileDescription(file);
    button.append(title, info); button.addEventListener("click", () => void loadFile(id, file.path)); list.append(button);
    if (file.path === focusedPath) button.focus({ preventScroll: true });
  }
}

async function loadFile(id, path, open = true) {
  if (currentId() !== id || !runtime?.definition) return;
  const item = state(id), sequence = ++item.fileSequence;
  item.filePath = path; item.file = null; item.fileNote = "正在读取文件…";
  if (open) {
    fileFocus = { agentId: id, path };
    if (dialog.open) dialog.close();
  }
  renderFiles(); renderFile();
  if (open && !fileDialog.open) fileDialog.showModal();
  try {
    const file = await api.readFile(id, path);
    if (sequence !== item.fileSequence || states.get(id) !== item) return;
    item.file = file; item.fileNote = "";
  } catch (error) {
    if (sequence !== item.fileSequence || states.get(id) !== item) return;
    item.fileNote = error.message || "读取失败，请重新选择文件。";
  }
  if (showingFile(id)) renderFile();
}

function renderFile() {
  const item = state(currentId()), file = item.file, container = byId("agent-file-content");
  container.replaceChildren();
  byId("agent-file-name").textContent = file?.path || item.filePath || "选择一份产物";
  byId("agent-file-download").hidden = !file || file.truncated;
  byId("agent-file-info").textContent = file ? file.truncated ? "文件过长，仅展示部分内容。" : /\.html?$/i.test(file.path) ? "静态网页预览" : "文本预览"
    : item.fileNote || "文件保存在这个智能体的专属目录。";
  if (!file) {
    const empty = document.createElement("div"), title = document.createElement("strong"), note = document.createElement("p");
    empty.className = "agent-file-empty"; title.textContent = item.filePath ? "正在查看这份产物" : "成果会留在这里";
    note.textContent = item.fileNote || "选择左侧文件，即可查看或下载。"; empty.append(title, note); container.append(empty);
  } else if (/\.html?$/i.test(file.path) && !file.truncated) {
    const frame = document.createElement("iframe"); frame.title = `预览 ${file.path}`;
    frame.setAttribute("sandbox", ""); frame.setAttribute("referrerpolicy", "no-referrer");
    frame.srcdoc = staticArtifactDocument(file.content); container.append(frame);
  } else {
    const text = document.createElement("pre"); text.className = "agent-file-text"; text.textContent = file.content; container.append(text);
  }
}

function renderMemory() {
  const item = state(currentId());
  byId("agent-memory-input").value = item.memory;
  message("agent-memory-feedback", item.memoryNote || (item.memoryDirty ? "有尚未保存的修改。" : "保存后，从下一次任务开始使用。"), item.memoryError);
  refreshAvailability();
}

async function loadMemory(id) {
  const item = state(id);
  if (item.memoryLoaded) return;
  const sequence = ++item.memorySequence;
  item.memoryNote = "正在读取记忆…"; item.memoryError = false;
  if (showing(id, "memory")) renderMemory();
  try {
    const result = await api.getMemory(id);
    if (sequence !== item.memorySequence || item.memoryDirty) return;
    item.memory = result.memory; item.memoryLoaded = true;
    item.memoryNote = "保存后从下次任务生效；清空并保存即可移除记忆。";
  } catch (error) {
    if (sequence !== item.memorySequence) return;
    item.memoryNote = `${error.message || "读取失败。"} 重新打开可重试。`; item.memoryError = true;
  }
  if (showing(id, "memory")) renderMemory();
}

byId("agent-memory-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = currentId(), item = state(id);
  if (!runtime?.definition || !item.memoryLoaded || item.memorySaving) return;
  const submitted = item.memory; item.memorySaving = true; item.memoryNote = "正在保存…"; item.memoryError = false;
  renderMemory();
  try {
    const result = await api.saveMemory(id, submitted);
    if (item.memory === submitted) { item.memory = result.memory; item.memoryDirty = false; }
    item.memoryNote = item.memoryDirty ? "已保存上一份内容；当前修改尚未保存。" : "已保存，下次任务会使用这份记忆。";
  } catch (error) { item.memoryNote = error.message || "保存失败，请重试。"; item.memoryError = true; }
  finally { item.memorySaving = false; if (showing(id, "memory")) renderMemory(); }
});
byId("agent-memory-input").addEventListener("input", () => {
  const item = state(currentId()); item.memory = byId("agent-memory-input").value; item.memoryDirty = true; item.memoryNote = "有尚未保存的修改。"; item.memoryError = false;
  message("agent-memory-feedback", item.memoryNote);
});

function profileEdited() {
  const item = state(currentId());
  item.profile = Object.fromEntries(["name", "description", "icon"].map((key) => [key, byId(`agent-profile-${key}`).value]));
  item.profileDirty = true; item.profileError = false; item.profileNote = "有尚未保存的修改。";
  message("agent-profile-feedback", item.profileNote);
  for (const button of byId("agent-icon-options").children) button.setAttribute("aria-pressed", String(button.dataset.icon === item.profile.icon));
}
for (const key of ["name", "description", "icon"]) byId(`agent-profile-${key}`).addEventListener("input", profileEdited);
for (const [icon, label] of agentIconChoices) {
  const button = document.createElement("button"); button.type = "button"; button.textContent = icon; button.dataset.icon = icon;
  button.setAttribute("aria-label", `使用${label}图标`); button.setAttribute("aria-pressed", "false");
  button.addEventListener("click", () => { byId("agent-profile-icon").value = icon; profileEdited(); }); byId("agent-icon-options").append(button);
}
byId("agent-profile-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = currentId(), item = state(id);
  if (!runtime?.definition || !item.profile || item.profileSaving) return;
  if (!item.profile.name.trim()) { message("agent-profile-feedback", "名称不能为空。", true); return; }
  const submitted = { ...item.profile }; item.profileSaving = true; item.profileNote = "正在保存…"; item.profileError = false;
  renderProfile(); refreshAvailability();
  try {
    const result = await api.saveProfile(id, submitted);
    if (JSON.stringify(item.profile) === JSON.stringify(submitted)) { item.profile = result.profile; item.profileDirty = false; }
    item.profileNote = item.profileDirty ? "已保存上一份资料；当前修改尚未保存。" : "已保存，名称、简介和图标已更新。";
    emit("neuma:agent-profile-changed", { id, profile: result.profile });
  } catch (error) { item.profileNote = error.message || "保存失败，请重试。"; item.profileError = true; }
  finally { item.profileSaving = false; if (showing(id, "profile")) { renderProfile(); refreshAvailability(); } }
});

for (const trigger of ["agent-panel-toggle", "agent-identity-edit"]) byId(trigger).addEventListener("click", () => openPanel("profile", trigger));
for (const tab of ["memory", "profile"]) byId(`agent-details-${tab}-tab`).addEventListener("click", () => selectView(tab));
byId("agent-details-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {
  stopViewTransitions();
  if (currentId() && currentId() === settingsAgentId) byId(returnFocus).focus({ preventScroll: true });
});
byId("agent-file-close").addEventListener("click", () => fileDialog.close());
fileDialog.addEventListener("close", () => {
  if (!currentId() || fileFocus?.agentId !== currentId()) return;
  const button = !artifactsCollapsed
    ? [...byId("agent-file-list").children].find((node) => node.dataset.path === fileFocus.path) : null;
  (button || byId("agent-artifacts-toggle")).focus({ preventScroll: true });
});
byId("agent-build-shortcut").addEventListener("click", () => runtime?.developmentAction
  ? emit("neuma:agent-develop", { id: currentId() }) : byId("agent-build").click());
byId("agent-files-refresh").addEventListener("click", () => { if (runtime?.definition) void loadFiles(currentId()); });
byId("agent-file-download").addEventListener("click", () => {
  const file = state(currentId()).file;
  if (!file || file.truncated || !showingFile(currentId())) return;
  const url = URL.createObjectURL(new Blob([file.content], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = file.path.split("/").at(-1); link.hidden = true;
  // Keep the download target in the active dialog, rather than the inert background.
  fileDialog.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
});
document.addEventListener("neuma:agent-runtime-change", (event) => {
  const detail = event.detail;
  if (!currentId() || detail.agentId !== currentId() || !detail.agent) return;
  const previous = runtime; runtime = detail;
  const item = state(currentId());
  if (!item.profileDirty && !item.profileSaving) item.profile = profileFor(detail.agent);
  refreshAvailability();
  if (detail.definition && (!previous?.definition || (previous.busy && !detail.busy))) void loadFiles(currentId());
  if (dialog.open) {
    byId("agent-details-name").textContent = agentDisplayName(detail.agent);
    if (view === "profile" && !item.profileDirty && !item.profileSaving) renderProfile();
    if (!previous?.definition && detail.definition) selectView(view);
  }
});
document.addEventListener("neuma:route", (event) => {
  route = event.detail; runtime = null;
  if (dialog.open) dialog.close();
  if (fileDialog.open) fileDialog.close();
  if (currentId()) renderFiles();
  emit("neuma:agent-runtime-request", { agentId: currentId() });
});
document.addEventListener("neuma:agent-removed", (event) => {
  states.delete(event.detail.id);
  if (event.detail.id === currentId() && dialog.open) dialog.close();
  if (event.detail.id === currentId() && fileDialog.open) fileDialog.close();
});
