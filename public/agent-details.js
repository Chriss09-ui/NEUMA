import { createAgentRuntime } from "./agent-runtime.js";
import { agentDisplayName, agentDisplayDescription } from "./state.js";
import { agentIconChoices, fileDescription, newestFiles, staticArtifactDocument } from "./agent-details-view.js";
import { avatarShapes, avatarColors, avatarIcon, resolveAgentAvatar, renderAgentAvatar } from "./agent-avatar.js";
import { createApplicationApi } from "./application-api.js";
import { saveFileDownload } from "./artifact-download.js";

const api = createAgentRuntime(), applicationApi = createApplicationApi(), states = new Map();
const byId = (id) => document.getElementById(id), panel = byId("agent-panel"), fileDialog = byId("agent-file-dialog"), shell = byId("agent-page-shell");
const emit = (type, detail) => document.dispatchEvent(new CustomEvent(type, { detail }));
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let viewTransitions = [];
let panelTransitionSequence = 0, panelTransitionTimer = null, removePanelTransitionListener = null;
let route = { page: "chat", agentId: null }, runtime = null, view = "profile";
let fileFocus = null, settingsAgentId = null;
const currentId = () => route.page === "agent" ? route.agentId : null;
const showing = (id, tab) => Boolean(id) && currentId() === id && settingsAgentId === id && (!tab || view === tab);
const showingFile = (id) => currentId() === id && fileDialog.open && fileFocus?.agentId === id;

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

function renderIdentity() {
  byId("agent-details-name").textContent = agentDisplayName(runtime.agent);
  const description = agentDisplayDescription(runtime.agent);
  byId("agent-details-description").textContent = description;
  byId("agent-details-description").hidden = !description;
  renderAgentAvatar(byId("agent-details-avatar"), runtime.agent, { document, motion: false });
}

function refreshAvailability() {
  const id = currentId(), ready = Boolean(id && runtime?.definition), item = id ? state(id) : null;
  byId("agent-details-unavailable").hidden = ready || ["connections", "services"].includes(view);
  for (const name of ["name", "description", "icon"]) byId(`agent-profile-${name}`).disabled = !ready;
  byId("agent-profile-custom-icon").disabled = !ready;
  byId("agent-avatar-reset").disabled = !ready;
  for (const group of ["agent-icon-options", "agent-avatar-shapes", "agent-avatar-colors"])
    for (const button of byId(group).children) button.disabled = !ready;
  byId("agent-profile-save").disabled = !ready || Boolean(item?.profileSaving);
  byId("agent-memory-input").disabled = !ready || !item?.memoryLoaded;
  byId("agent-memory-save").disabled = !ready || !item?.memoryLoaded || item.memorySaving;
  byId("agent-artifacts-open").disabled = !id || runtime?.agentId !== id;
  byId("agent-files-refresh").disabled = !ready;
  if (runtime) {
    byId("agent-build-shortcut").hidden = runtime.ready && !runtime.configurationAction || runtime.busy || ["checking", "unchecked"].includes(runtime.status);
    byId("agent-build-shortcut").textContent = runtime.configurationAction || runtime.developmentAction || (runtime.definition ? "重新生成" : "生成智能体");
  }
}

function renderProfile() {
  const item = state(currentId());
  if (!item.profile) return;
  for (const key of ["name", "description", "icon"]) byId(`agent-profile-${key}`).value = item.profile[key];
  renderAvatarEditor();
  message("agent-profile-feedback", item.profileNote || (item.profileDirty ? "有尚未保存的修改。" : "修改资料即可保存，无需重新生成。"), item.profileError);
}

function profileAvatar() {
  const id = currentId(), agent = { ...runtime.agent, id, profile: state(id).profile };
  const avatar = resolveAgentAvatar(agent);
  const selection = avatar.type === "star" ? avatar : resolveAgentAvatar({ ...agent, profile: { ...agent.profile, icon: "" } });
  return { agent, avatar, selection };
}

function renderAvatarEditor() {
  const { agent, avatar, selection } = profileAvatar();
  renderAgentAvatar(byId("agent-avatar-preview"), agent, { document });
  byId("agent-profile-custom-icon").value = avatar.type === "text" ? agent.profile.icon : "";
  for (const button of byId("agent-avatar-shapes").children) {
    button.setAttribute("aria-pressed", String(avatar.type === "star" && button.dataset.shape === avatar.shape));
    const icon = avatarIcon({ shape: button.dataset.shape, color: selection.color });
    renderAgentAvatar(button.children[0], { ...agent, profile: { ...agent.profile, icon } }, { document, motion: false });
  }
  for (const button of byId("agent-avatar-colors").children)
    button.setAttribute("aria-pressed", String(avatar.type === "star" && button.dataset.color === avatar.color));
  for (const button of byId("agent-icon-options").children)
    button.setAttribute("aria-pressed", String(button.dataset.icon === agent.profile.icon));
}

function selectIcon(icon) {
  if (!currentId() || !runtime?.definition) return;
  byId("agent-profile-icon").value = icon;
  profileEdited();
}

function stopViewTransitions() {
  for (const animation of viewTransitions) animation.cancel();
  viewTransitions = [];
}
reducedMotion.addEventListener("change", () => {
  stopViewTransitions();
  if (reducedMotion.matches) panelVisibility(Boolean(settingsAgentId), { animate: false });
});

function selectView(next) {
  if (!currentId() || runtime?.agentId !== currentId()) return;
  const changed = next !== view;
  const content = byId(`agent-details-${next}`);
  const animate = changed && showing(currentId()) && !reducedMotion.matches && typeof content.animate === "function";
  if (changed) stopViewTransitions();
  view = next; panel.dataset.view = view;
  for (const tab of ["memory", "profile", "connections", "services"]) {
    byId(`agent-details-${tab}`).hidden = tab !== view;
    byId(`agent-details-${tab}-tab`).setAttribute("aria-pressed", String(tab === view));
  }
  byId("agent-details-title").textContent = "智能体设置";
  renderIdentity();
  refreshAvailability();
  if (view === "profile") renderProfile();
  if (view === "memory") { renderMemory(); if (runtime.definition) void loadMemory(currentId()); }
  emit("neuma:agent-connections-view", { agentId: currentId(), active: view === "connections" });
  emit("neuma:agent-services-view", { agentId: currentId(), active: view === "services" });
  if (animate) {
    viewTransitions = [content.animate([
      { opacity: 0, transform: `translateX(${view === "memory" ? 8 : -8}px)` },
      { opacity: 1, transform: "translateX(0)" },
    ], { duration: 200, easing: "ease-out", fill: "backwards" })];
  }
}

function cancelPanelTransition() {
  const sequence = ++panelTransitionSequence;
  if (panelTransitionTimer !== null) clearTimeout(panelTransitionTimer);
  panelTransitionTimer = null;
  removePanelTransitionListener?.(); removePanelTransitionListener = null;
  return sequence;
}

function finishPanelTransition(sequence) {
  if (sequence !== panelTransitionSequence) return;
  if (panelTransitionTimer !== null) clearTimeout(panelTransitionTimer);
  panelTransitionTimer = null;
  removePanelTransitionListener?.(); removePanelTransitionListener = null;
  shell.classList.remove("is-settings-animating");
  panel.hidden = !settingsAgentId;
}

function panelVisibility(active, { animate = true } = {}) {
  const sequence = cancelPanelTransition();
  panel.inert = !active;
  panel.setAttribute("aria-hidden", String(!active));
  if (active && panel.hidden) {
    panel.hidden = false;
    // Commit the closed position before changing the grid and transform targets.
    shell.getBoundingClientRect();
  }
  const durations = animate && !reducedMotion.matches && window.getComputedStyle
    ? (window.getComputedStyle(shell).transitionDuration || "").split(",") : [];
  const duration = Math.max(0, ...durations.map((value) => (Number.parseFloat(value) || 0) * (value.trim().endsWith("ms") ? 1 : 1000)));
  if (duration) shell.classList.add("is-settings-animating");
  shell.classList.toggle("settings-open", active);
  byId("agent-panel-toggle").setAttribute("aria-expanded", String(active));
  if (!duration) {
    shell.getBoundingClientRect();
    for (const animation of shell.getAnimations?.() || []) animation.finish();
    finishPanelTransition(sequence); return;
  }
  const ended = (event) => {
    if (event.target === shell && event.propertyName === "grid-template-columns") finishPanelTransition(sequence);
  };
  shell.addEventListener("transitionend", ended);
  removePanelTransitionListener = () => shell.removeEventListener("transitionend", ended);
  panelTransitionTimer = setTimeout(() => finishPanelTransition(sequence), duration + 50);
}

function closePanel({ restoreFocus = true, animate = true } = {}) {
  if (!settingsAgentId) { if (!animate) panelVisibility(false, { animate: false }); return; }
  const id = settingsAgentId;
  settingsAgentId = null;
  if (fileDialog.open) { fileFocus = null; fileDialog.close(); }
  panelVisibility(false, { animate });
  stopViewTransitions();
  emit("neuma:agent-connections-view", { agentId: id, active: false });
  emit("neuma:agent-services-view", { agentId: id, active: false });
  emit("neuma:agent-settings-view", { agentId: id, active: false });
  if (restoreFocus && currentId() === id && states.has(id)) byId("agent-panel-toggle").focus({ preventScroll: true });
}

function openPanel(next, { focus = true } = {}) {
  if (!currentId() || runtime?.agentId !== currentId()) return;
  const opened = !settingsAgentId;
  settingsAgentId = currentId();
  if (fileDialog.open) { fileFocus = null; fileDialog.close(); }
  selectView(next);
  if (opened) panelVisibility(true);
  if (opened) emit("neuma:agent-settings-view", { agentId: currentId(), active: true });
  if (focus) byId("agent-details-close").focus({ preventScroll: true });
}

function openArtifacts() {
  const id = currentId();
  if (!id || runtime?.agentId !== id) return;
  const item = state(id);
  item.taskArtifact = null;
  if (!settingsAgentId) openPanel("profile", { focus: false });
  fileFocus = { agentId: id, selectOnLoad: !item.filesLoaded };
  renderFiles(); renderFile();
  if (!fileDialog.open) fileDialog.showModal();
  const path = item.filePath || item.files[0]?.path;
  if (runtime.definition && path) void loadFile(id, path);
  if (runtime.definition && !item.filesLoaded && !item.filesLoading) void loadFiles(id);
  const button = [...byId("agent-file-list").children].find((node) => node.dataset.path === path);
  (button || byId("agent-file-close")).focus({ preventScroll: true });
}

async function openTaskArtifact(detail) {
  const id = currentId();
  if (!id || detail?.agentId !== id || runtime?.agentId !== id || !/^[\w-]{1,80}$/.test(detail.taskId)
    || !Number.isSafeInteger(detail.index) || detail.index < 0) return;
  const item = state(id), returnTo = document.activeElement;
  if (!settingsAgentId) openPanel("profile", { focus: false });
  const artifact = { taskId: detail.taskId, index: detail.index, path: detail.artifact?.path || detail.artifact?.name || `产物 ${detail.index + 1}`,
    note: "正在读取任务产物预览…", preview: null, downloading: false };
  item.taskArtifact = artifact; item.fileSequence++;
  fileFocus = { agentId: id, selectOnLoad: false, returnTo };
  renderFiles(); renderFile();
  if (!fileDialog.open) fileDialog.showModal();
  byId("agent-file-close").focus({ preventScroll: true });
  try {
    const preview = await applicationApi.artifactPreview(id, artifact.taskId, artifact.index);
    if (item.taskArtifact !== artifact || states.get(id) !== item) return;
    artifact.preview = preview; artifact.note = "";
  } catch (error) {
    if (item.taskArtifact !== artifact || states.get(id) !== item) return;
    artifact.note = error.message || "产物预览暂时不可用，可以下载完整文件。";
  }
  if (showingFile(id)) renderFile();
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
      item.file = null; item.filePath = ""; item.fileNote = ""; item.fileSequence++;
    }
    if (currentId() === id) {
      renderFiles();
      if (showingFile(id)) {
        renderFile();
        const path = item.filePath || (fileFocus.selectOnLoad ? item.files[0]?.path : null);
        fileFocus.selectOnLoad = false;
        if (path && !item.taskArtifact) void loadFile(id, path);
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
    button.setAttribute("aria-pressed", String(!item.taskArtifact && file.path === item.filePath));
    const title = document.createElement("strong"), info = document.createElement("small");
    title.textContent = file.path; info.textContent = fileDescription(file);
    button.append(title, info); button.addEventListener("click", () => { if (showingFile(id)) void loadFile(id, file.path); }); list.append(button);
    if (file.path === focusedPath) button.focus({ preventScroll: true });
  }
  if (focusedPath && !item.files.some((file) => file.path === focusedPath) && showingFile(currentId()))
    byId("agent-files-refresh").focus({ preventScroll: true });
}

async function loadFile(id, path) {
  if (!showingFile(id) || !runtime?.definition) return;
  const item = state(id), sequence = ++item.fileSequence;
  item.taskArtifact = null; item.workspaceDownload = null;
  item.filePath = path; item.file = null; item.fileNote = "正在读取文件…";
  renderFiles(); renderFile();
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
  const item = state(currentId()), artifact = item.taskArtifact, file = artifact ? artifact.preview : item.file, container = byId("agent-file-content");
  container.replaceChildren();
  byId("agent-file-name").textContent = file?.path || artifact?.path || item.filePath || "选择一份产物";
  const download = byId("agent-file-download"), operation = artifact || item.workspaceDownload;
  download.hidden = !artifact && !file; download.disabled = Boolean(operation?.downloading);
  download.textContent = operation?.downloading ? "正在准备下载…" : artifact ? "下载本任务文件" : "下载当前文件";
  download.setAttribute("aria-busy", String(Boolean(operation?.downloading)));
  byId("agent-file-info").textContent = operation?.downloadNote || (file
    ? `${artifact ? "本次任务快照预览" : "工作目录预览"} · 可能已脱敏${file.truncated ? "，仅展示部分内容。" : "。"}${artifact ? "下载获取本次任务的完整原文件。" : "下载获取目录中的当前原文件。"}`
    : artifact?.note || item.fileNote || "文件保存在这个智能体的专属目录。");
  byId("agent-file-info").setAttribute("role", "status");
  container.setAttribute("aria-busy", String(Boolean(artifact && !file && artifact.note === "正在读取任务产物预览…")));
  if (!file) {
    const empty = document.createElement("div"), title = document.createElement("strong"), note = document.createElement("p");
    empty.className = "agent-file-empty"; title.textContent = artifact || item.filePath ? "正在查看这份产物" : "成果会留在这里";
    note.textContent = artifact?.note || item.fileNote || "选择左侧文件，即可查看预览。"; empty.append(title, note); container.append(empty);
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
  if (!currentId() || !runtime?.definition) return;
  const item = state(currentId());
  item.profile = Object.fromEntries(["name", "description", "icon"].map((key) => [key, byId(`agent-profile-${key}`).value]));
  item.profileDirty = true; item.profileError = false; item.profileNote = "有尚未保存的修改。";
  message("agent-profile-feedback", item.profileNote);
  renderAvatarEditor();
}
for (const key of ["name", "description", "icon"]) byId(`agent-profile-${key}`).addEventListener("input", profileEdited);
byId("agent-profile-custom-icon").addEventListener("input", () => selectIcon(byId("agent-profile-custom-icon").value));
byId("agent-avatar-reset").addEventListener("click", () => selectIcon(""));
for (const shape of avatarShapes) {
  const button = document.createElement("button"), icon = document.createElement("span");
  button.type = "button"; button.className = "agent-avatar-shape"; button.dataset.shape = shape.id;
  button.setAttribute("aria-label", `使用${shape.label}造型`); button.setAttribute("aria-pressed", "false"); button.title = shape.label;
  icon.className = "agent-avatar-option-icon"; icon.setAttribute("aria-hidden", "true"); button.append(icon);
  button.addEventListener("click", () => {
    if (!currentId() || !runtime?.definition) return;
    selectIcon(avatarIcon({ shape: shape.id, color: profileAvatar().selection.color }));
  });
  byId("agent-avatar-shapes").append(button);
}
for (const color of avatarColors) {
  const button = document.createElement("button"), swatch = document.createElement("span");
  button.type = "button"; button.className = "agent-avatar-color"; button.dataset.color = color.id;
  button.setAttribute("aria-label", `使用${color.label}配色`); button.setAttribute("aria-pressed", "false"); button.title = color.label;
  swatch.className = "agent-avatar-swatch"; swatch.style.backgroundColor = color.hex; swatch.setAttribute("aria-hidden", "true"); button.append(swatch);
  button.addEventListener("click", () => {
    if (!currentId() || !runtime?.definition) return;
    selectIcon(avatarIcon({ shape: profileAvatar().selection.shape, color: color.id }));
  });
  byId("agent-avatar-colors").append(button);
}
for (const [icon, label] of agentIconChoices) {
  const button = document.createElement("button"); button.type = "button"; button.textContent = icon; button.dataset.icon = icon;
  button.setAttribute("aria-label", `使用${label}图标`); button.setAttribute("aria-pressed", "false");
  button.addEventListener("click", () => selectIcon(icon)); byId("agent-icon-options").append(button);
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

byId("agent-panel-toggle").addEventListener("click", () => settingsAgentId ? closePanel() : openPanel("profile"));
for (const tab of ["memory", "profile", "connections", "services"]) byId(`agent-details-${tab}-tab`).addEventListener("click", () => selectView(tab));
document.addEventListener("neuma:agent-connections-open", () => openPanel("connections"));
document.addEventListener("neuma:agent-services-open", () => openPanel("services"));
byId("agent-details-close").addEventListener("click", () => closePanel());
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented || !settingsAgentId || document.querySelector("dialog[open]")) return;
  event.preventDefault(); closePanel();
});
byId("agent-file-close").addEventListener("click", () => fileDialog.close());
byId("agent-artifacts-open").addEventListener("click", openArtifacts);
document.addEventListener("neuma:agent-artifacts-changed", (event) => {
  if (currentId() === event.detail.agentId && runtime?.definition) void loadFiles(currentId());
});
document.addEventListener("neuma:agent-task-artifact-open", (event) => { void openTaskArtifact(event.detail); });
fileDialog.addEventListener("close", () => {
  if (fileDialog.open) return;
  const id = fileFocus?.agentId, returnTo = fileFocus?.returnTo; fileFocus = null;
  if (currentId() === id && states.has(id) && showing(id))
    (returnTo?.isConnected !== false && returnTo?.focus && !fileDialog.contains(returnTo) ? returnTo : byId("agent-artifacts-open")).focus({ preventScroll: true });
});
byId("agent-build-shortcut").addEventListener("click", () => runtime?.configurationAction
  ? emit("neuma:agent-services-open", { agentId: currentId() }) : runtime?.developmentAction
    ? emit("neuma:agent-develop", { id: currentId() }) : byId("agent-build").click());
byId("agent-files-refresh").addEventListener("click", () => { if (runtime?.definition) void loadFiles(currentId()); });
byId("agent-file-download").addEventListener("click", async () => {
  const id = currentId();
  if (!id || !showingFile(id)) return;
  const item = state(id), artifact = item.taskArtifact, file = item.file, focus = fileFocus;
  if (!artifact && !file) return;
  const operation = artifact || (item.workspaceDownload ??= {});
  if (operation.downloading) return;
  operation.downloading = true; operation.downloadNote = ""; renderFile();
  try {
    await saveFileDownload({ document, parent: fileDialog, name: artifact?.path || file.path,
      read: () => artifact ? applicationApi.downloadArtifact(id, artifact.taskId, artifact.index) : api.downloadFile(id, file.path),
      isCurrent: () => showingFile(id) && fileFocus === focus && item.taskArtifact === artifact
        && (artifact || item.filePath === file.path) });
  } catch (error) { operation.downloadNote = error.message || "文件下载未完成，请重试。"; }
  finally { operation.downloading = false; if (showingFile(id) && item.taskArtifact === artifact) renderFile(); }
});
document.addEventListener("neuma:agent-runtime-change", (event) => {
  const detail = event.detail;
  if (!currentId() || detail.agentId !== currentId() || !detail.agent) return;
  const previous = runtime; runtime = detail;
  const item = state(currentId());
  if (!item.profileDirty && !item.profileSaving) item.profile = profileFor(detail.agent);
  refreshAvailability();
  if (detail.definition && (!previous?.definition || (previous.busy && !detail.busy))) void loadFiles(currentId());
  if (showing(currentId())) {
    renderIdentity();
    if (view === "profile" && !item.profileDirty && !item.profileSaving) renderProfile();
    if (!previous?.definition && detail.definition) selectView(view);
  }
});
document.addEventListener("neuma:route", (event) => {
  closePanel({ restoreFocus: false, animate: false });
  if (fileDialog.open) { fileFocus = null; fileDialog.close(); }
  route = event.detail; runtime = null;
  if (currentId()) renderFiles();
  emit("neuma:agent-runtime-request", { agentId: currentId() });
});
document.addEventListener("neuma:agent-removed", (event) => {
  states.delete(event.detail.id);
  if (event.detail.id !== currentId()) return;
  closePanel({ restoreFocus: false, animate: false });
  if (fileDialog.open) { fileFocus = null; fileDialog.close(); }
  runtime = null;
});
