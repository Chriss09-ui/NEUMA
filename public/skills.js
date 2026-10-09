import { renderSkillFiles, renderSkillImpact, renderSkillList, renderSkillLocations, renderSkillOptions, renderSkillSources, renderSkillTrash, renderSkillWarnings } from "./skills-view.js";

const byId = (id) => document.getElementById(id);
const dialogs = ["unsaved", "sources", "import", "delete", "trash"];
let snapshot = null, sources = [], selectedId = null, detail = null, draft = "", diskVersion = null;
let active = false, scanning = false, saving = false, mutating = false, detailLoading = false;
let detailSequence = 0, detailController = null, pendingAction = null, importPreview = null, deletePreview = null;
let importSequence = 0, deleteSequence = 0, sourceSequence = 0, trashSequence = 0, picking = null;
let trashEntries = [];
const dirty = () => !!detail && draft !== detail.content;
const busy = () => saving || mutating;
const skillPath = (id = selectedId) => `/api/skills/${encodeURIComponent(id)}`;
const errorTarget = (target, message = "") => { byId(target).textContent = message; byId(target).hidden = !message; };

async function api(path, body, signal) {
  const response = await fetch(path, { ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}), cache: "no-store" });
  const result = await response.json();
  if (!response.ok) {
    const failure = new Error(result.error || "操作失败，请重试。");
    failure.code = result.code; failure.status = response.status; throw failure;
  }
  return result;
}

function openDialog(name) { const dialog = byId(`skills-${name}-dialog`); if (!dialog.open) dialog.showModal(); }
function closeDialog(name) { const dialog = byId(`skills-${name}-dialog`); if (dialog.open) dialog.close(); }

function renderList() {
  const count = renderSkillList({ container: byId("skills-list"), skills: snapshot?.skills ?? [], selectedId,
    query: byId("skills-search").value, sourceId: byId("skills-source-filter").value, busy: busy(), onSelect: selectSkill });
  byId("skills-count").textContent = snapshot ? String(snapshot.skills.length) : "—";
  byId("skills-filter-count").textContent = snapshot ? `${count} 个技能` : "";
}

function renderEditorState() {
  const editable = !!detail?.canEdit;
  byId("skills-editor").readOnly = !editable; byId("skills-editor").disabled = saving;
  byId("skills-save").hidden = !editable;
  byId("skills-save").disabled = !editable || !dirty() || busy() || !!diskVersion;
  byId("skills-save").textContent = saving ? "保存中…" : "保存说明";
  byId("skills-delete").hidden = !detail?.canTrash; byId("skills-delete").disabled = busy();
  byId("skills-edit-status").textContent = saving ? "正在保存…" : diskVersion ? "原文件已更新，修改尚未保存" : dirty() ? "有未保存的修改" : editable ? "已与磁盘内容同步" : "只读";
  byId("skills-conflict").hidden = !diskVersion;
  byId("skills-conflict-view").disabled = busy(); byId("skills-conflict-reload").disabled = busy();
  for (const name of ["sources", "import", "trash"]) byId(`skills-${name}-open`).disabled = busy();
  byId("skills-refresh").disabled = busy() || scanning;
  for (const name of ["save", "discard", "cancel"]) byId(`skills-unsaved-${name}`).disabled = busy();
  byId("skills-unsaved-save").disabled = busy() || !!diskVersion || !editable;
}

function renderDetail() {
  byId("skills-detail-panel").setAttribute("aria-busy", String(detailLoading));
  byId("skills-detail-empty").hidden = !!detail;
  byId("skills-detail-content").hidden = !detail;
  if (!detail) {
    byId("skills-detail-empty").replaceChildren();
    const heading = document.createElement("h2"), note = document.createElement("p");
    heading.textContent = detailLoading ? "正在读取技能…" : "选择一个技能";
    note.textContent = detailLoading ? "读取说明和附带资源。" : "查看它的说明、所在目录和附带资源。";
    byId("skills-detail-empty").append(heading, note); return;
  }
  byId("skills-detail-name").textContent = detail.name || "未命名技能";
  byId("skills-detail-description").textContent = detail.description || "没有技能说明";
  byId("skills-detail-path").textContent = detail.filePath;
  byId("skills-detail-access").textContent = detail.canEdit ? "可编辑" : "只读";
  byId("skills-shared-note").textContent = detail.readOnlyReason || (detail.locations?.length > 1
    ? `这些入口指向同一个文件；保存说明会同步影响 ${detail.locations.length} 个入口。` : "保存会直接修改这个目录中的 SKILL.md。");
  renderSkillWarnings(byId("skills-detail-diagnostics"), detail.diagnostics);
  renderSkillLocations({ container: byId("skills-locations"), locations: detail.locations, busy: busy(), onRemoveLink: (locationId) => requestTrash("link", locationId) });
  if (byId("skills-editor").value !== draft) byId("skills-editor").value = draft;
  const resources = (detail.files ?? []).filter((file) => file.path !== "SKILL.md");
  renderSkillFiles(byId("skills-files"), resources);
  byId("skills-files-count").textContent = String(resources.length);
  renderEditorState();
}

function applyDetail(result) {
  detail = result; selectedId = result.id; draft = result.content; diskVersion = null;
  byId("skills-disk-content").hidden = true; renderList(); renderDetail();
}

async function readDetail(id, preserveDraft = false) {
  detailController?.abort();
  const request = new AbortController(), sequence = ++detailSequence; detailController = request;
  detailLoading = true; renderDetail();
  try {
    const result = await api(skillPath(id), undefined, request.signal);
    if (sequence !== detailSequence || request.signal.aborted || selectedId !== id) return;
    if (typeof result.content !== "string" || result.canEdit && !result.revision || result.id !== id) throw new Error("技能详情返回不完整，请重新读取。");
    if (preserveDraft && dirty()) {
      if (result.revision !== detail.revision) diskVersion = result;
    } else applyDetail(result);
    errorTarget("skills-error");
  } catch (failure) {
    if (sequence === detailSequence && !request.signal.aborted) errorTarget("skills-error", failure.message);
  } finally {
    if (sequence === detailSequence) { detailLoading = false; detailController = null; renderDetail(); }
  }
}

function guardDraft(action) {
  if (busy()) return;
  if (!dirty()) { void action(); return; }
  pendingAction = action;
  errorTarget("skills-unsaved-error", diskVersion ? "原文件已更新，当前修改不能直接保存。取消后可查看磁盘版本，或放弃修改后继续。" : "");
  renderEditorState(); openDialog("unsaved");
}

function selectSkill(id) {
  if (id === selectedId || busy()) return;
  guardDraft(() => {
    selectedId = id; detail = null; draft = ""; diskVersion = null; renderList(); return readDetail(id);
  });
}

async function refresh(scan = false) {
  if (scanning || busy()) return;
  scanning = true; byId("skills-refresh").disabled = true; byId("skills-list").setAttribute("aria-busy", "true");
  byId("skills-status").textContent = snapshot ? "正在扫描，当前显示上次结果…" : "正在读取本机技能…";
  errorTarget("skills-error");
  try {
    const result = await api(scan ? "/api/skills/scan" : "/api/skills", scan ? {} : undefined);
    if (!Array.isArray(result.skills) || !Array.isArray(result.sources)) throw new Error("扫描结果返回不完整，请重试。");
    snapshot = result; sources = result.sources;
    renderSkillOptions(byId("skills-source-filter"), sources, { selected: byId("skills-source-filter").value });
    renderList(); renderSkillWarnings(byId("skills-warnings"), result.warnings);
    byId("skills-warning-panel").hidden = !result.warnings?.length;
    byId("skills-warning-summary").textContent = `扫描诊断（${result.warnings?.length ?? 0}）`;
    const checked = new Date(result.checkedAt);
    byId("skills-status").textContent = Number.isNaN(checked.getTime()) ? "本次扫描已完成" : `扫描于 ${checked.toLocaleTimeString("zh-CN", { hour12: false })}`;
    if (selectedId && !saving) {
      if (result.skills.some((skill) => skill.id === selectedId)) await readDetail(selectedId, true);
      else if (!dirty()) { selectedId = null; detail = null; renderDetail(); }
      else errorTarget("skills-error", "扫描未找到当前技能。未保存的修改已保留，请检查原目录。");
    }
  } catch (failure) {
    errorTarget("skills-error", failure.message);
    byId("skills-status").textContent = snapshot ? "扫描失败，当前仍为上次结果。" : "尚未读取到技能。可以重新扫描。";
  } finally {
    scanning = false; byId("skills-refresh").disabled = busy(); byId("skills-list").setAttribute("aria-busy", "false");
  }
}

async function save() {
  if (!detail?.canEdit || !dirty() || busy() || diskVersion) return false;
  const id = selectedId, content = draft, revision = detail.revision;
  detailSequence++; detailController?.abort(); detailLoading = false;
  saving = true; renderList(); renderDetail(); errorTarget("skills-error");
  try {
    const result = await api(`${skillPath(id)}/save`, { content, revision });
    if (selectedId !== id) return false;
    applyDetail(result); byId("skills-status").textContent = "说明已保存。"; return true;
  } catch (failure) {
    if (failure.code === "SKILL_CONFLICT" || failure.status === 409) {
      diskVersion = { conflict: true }; await readDetail(id, true);
    }
    errorTarget("skills-error", failure.message);
    if (byId("skills-unsaved-dialog").open) errorTarget("skills-unsaved-error", failure.message);
    return false;
  } finally { saving = false; renderList(); renderDetail(); }
}

async function openSources() {
  errorTarget("skills-sources-error"); openDialog("sources");
  const sequence = ++sourceSequence;
  try {
    const result = await api("/api/skills/sources");
    if (sequence !== sourceSequence) return;
    sources = result.sources; renderSources();
  } catch (failure) { if (sequence === sourceSequence) errorTarget("skills-sources-error", failure.message); }
}
function renderSources() { renderSkillSources({ container: byId("skills-sources-list"), sources, busy: mutating, onRemove: removeSource }); }
async function removeSource(id) {
  if (busy()) return;
  mutating = true; renderSources();
  try { sources = (await api(`/api/skills/sources/${encodeURIComponent(id)}/remove`, {})).sources; }
  catch (failure) { errorTarget("skills-sources-error", failure.message); }
  finally { mutating = false; renderSources(); await refresh(true); }
}

async function pickFolder(purpose) {
  if (picking || busy()) return;
  const controller = new AbortController(); picking = { purpose, controller };
  const button = byId(purpose === "source" ? "skills-source-pick" : "skills-import-pick");
  const target = purpose === "source" ? "skills-sources-error" : "skills-import-error";
  button.disabled = true; button.textContent = "选择中…"; errorTarget(target);
  try {
    const result = await api("/api/skills/pick-folder", { purpose }, controller.signal);
    if (controller.signal.aborted || result.cancelled) return;
    byId(purpose === "source" ? "skills-source-path" : "skills-import-path").value = result.path;
    if (purpose === "import") { byId("skills-import-name").value = result.name || ""; invalidateImport(); }
  } catch (failure) { if (!controller.signal.aborted) errorTarget(target, failure.message); }
  finally { if (picking?.controller === controller) picking = null; button.disabled = false; button.textContent = "选择目录"; }
}

function invalidateImport() {
  importSequence++; importPreview = null;
  byId("skills-import-preview").hidden = true; byId("skills-import-confirm").disabled = true;
}
async function openImport() {
  if (busy()) return;
  invalidateImport(); errorTarget("skills-import-error");
  for (const id of ["skills-import-path", "skills-import-name"]) byId(id).value = "";
  renderSkillOptions(byId("skills-import-target"), sources, { importing: true }); openDialog("import");
}
const importBody = () => ({ path: byId("skills-import-path").value.trim(), targetId: byId("skills-import-target").value,
  ...(byId("skills-import-name").value.trim() ? { name: byId("skills-import-name").value.trim() } : {}) });
function lockImport(value) {
  for (const name of ["path", "target", "name", "pick", "preview-button"]) byId(`skills-import-${name}`).disabled = value;
  byId("skills-import-confirm").disabled = value || !importPreview;
}

async function previewImport() {
  if (busy()) return;
  const body = importBody();
  if (!body.path || !body.targetId) { errorTarget("skills-import-error", "请选择来源目录和复制目标。"); return; }
  invalidateImport(); const sequence = importSequence;
  byId("skills-import-preview-button").disabled = true; errorTarget("skills-import-error");
  try {
    const result = await api("/api/skills/import/preview", body);
    if (sequence !== importSequence || !byId("skills-import-dialog").open) return;
    importPreview = { ...result, body }; renderSkillImpact(byId("skills-import-preview"), result, true);
    byId("skills-import-confirm").disabled = false;
  } catch (failure) { if (sequence === importSequence) errorTarget("skills-import-error", failure.message); }
  finally { byId("skills-import-preview-button").disabled = false; }
}
async function confirmImport() {
  if (!importPreview || busy()) return;
  const preview = importPreview;
  guardDraft(async () => {
    mutating = true; lockImport(true); renderList(); renderEditorState();
    try {
      const result = await api("/api/skills/import", { ...preview.body, revision: preview.revision });
      closeDialog("import"); selectedId = null; detail = null;
      mutating = false; await refresh(true); applyDetail(result);
      byId("skills-status").textContent = "技能已复制导入。";
    } catch (failure) { invalidateImport(); errorTarget("skills-import-error", failure.message); }
    finally { mutating = false; lockImport(false); renderList(); renderEditorState(); }
  });
}

function requestTrash(action = "skill", locationId) {
  guardDraft(async () => {
    const id = selectedId, sequence = ++deleteSequence; deletePreview = null;
    openDialog("delete"); errorTarget("skills-delete-error");
    byId("skills-delete-title").textContent = action === "link" ? "移除此入口" : "移至回收站";
    byId("skills-delete-note").textContent = action === "link" ? "仅移除所选软链接入口，其他入口与原技能文件保留。" : "回收整个技能目录。请确认以下子技能与共享入口的影响。";
    byId("skills-delete-impact").textContent = "正在确认影响范围…"; byId("skills-delete-confirm").disabled = true;
    byId("skills-delete-confirm").textContent = action === "link" ? "确认移除此入口" : "确认移至回收站";
    try {
      const result = await api(`${skillPath(id)}/trash/preview`, { action, ...(locationId ? { locationId } : {}) });
      if (sequence !== deleteSequence || !byId("skills-delete-dialog").open) return;
      deletePreview = { ...result, id }; renderSkillImpact(byId("skills-delete-impact"), result);
      byId("skills-delete-confirm").disabled = false;
    } catch (failure) { if (sequence === deleteSequence) errorTarget("skills-delete-error", failure.message); }
  });
}

async function confirmTrash() {
  if (!deletePreview || busy()) return;
  const preview = deletePreview; mutating = true; byId("skills-delete-confirm").disabled = true;
  try {
    await api(`${skillPath(preview.id)}/trash`, { confirm: true, revision: preview.revision, action: preview.action,
      ...(preview.locationId ? { locationId: preview.locationId } : {}) });
    closeDialog("delete"); detailSequence++; detailController?.abort(); selectedId = null; detail = null; draft = ""; diskVersion = null;
    mutating = false; renderDetail(); await refresh(true); byId("skills-status").textContent = preview.action === "link" ? "入口已移除，可在回收站恢复。" : "技能已移至回收站。";
  } catch (failure) { errorTarget("skills-delete-error", failure.message); deletePreview = null; }
  finally { mutating = false; renderList(); renderEditorState(); }
}

async function loadTrash() {
  const sequence = ++trashSequence;
  errorTarget("skills-trash-error"); byId("skills-trash-list").setAttribute("aria-busy", "true");
  try {
    const result = await api("/api/skills/trash");
    if (sequence !== trashSequence) return;
    trashEntries = result.entries; renderTrash();
  } catch (failure) { if (sequence === trashSequence) errorTarget("skills-trash-error", failure.message); }
  finally { if (sequence === trashSequence) byId("skills-trash-list").setAttribute("aria-busy", "false"); }
}
function renderTrash() { renderSkillTrash({ container: byId("skills-trash-list"), entries: trashEntries, busy: mutating, onRestore: restore }); }
function restore(id) {
  guardDraft(async () => {
    mutating = true; renderTrash();
    try {
      const result = await api(`/api/skills/trash/${encodeURIComponent(id)}/restore`, {});
      mutating = false; await refresh(true); await loadTrash();
      if (result.id && typeof result.content === "string") applyDetail(result);
      byId("skills-status").textContent = "已恢复到原目录。";
    } catch (failure) { errorTarget("skills-trash-error", failure.message); }
    finally { mutating = false; renderTrash(); renderList(); renderEditorState(); }
  });
}

byId("skills-search").addEventListener("input", renderList);
byId("skills-source-filter").addEventListener("change", renderList);
byId("skills-editor").addEventListener("input", () => { draft = byId("skills-editor").value; renderEditorState(); });
byId("skills-refresh").addEventListener("click", () => { void refresh(true); });
byId("skills-save").addEventListener("click", () => { void save(); });
byId("skills-sources-open").addEventListener("click", () => { void openSources(); });
byId("skills-import-open").addEventListener("click", () => { void openImport(); });
byId("skills-delete").addEventListener("click", () => requestTrash());
byId("skills-trash-open").addEventListener("click", () => { openDialog("trash"); void loadTrash(); });
byId("skills-source-pick").addEventListener("click", () => { void pickFolder("source"); });
byId("skills-import-pick").addEventListener("click", () => { void pickFolder("import"); });
byId("skills-import-form").addEventListener("submit", (event) => { event.preventDefault(); void previewImport(); });
byId("skills-import-confirm").addEventListener("click", () => { void confirmImport(); });
for (const id of ["skills-import-path", "skills-import-name"]) byId(id).addEventListener("input", invalidateImport);
byId("skills-import-target").addEventListener("change", invalidateImport);
byId("skills-delete-confirm").addEventListener("click", () => { void confirmTrash(); });
byId("skills-conflict-view").addEventListener("click", async () => {
  if (diskVersion?.conflict) await readDetail(selectedId, true);
  if (typeof diskVersion?.content === "string") { byId("skills-disk-content").textContent = diskVersion.content; byId("skills-disk-content").hidden = false; }
});
byId("skills-conflict-reload").addEventListener("click", async () => {
  if (diskVersion?.conflict) await readDetail(selectedId, true);
  if (typeof diskVersion?.content === "string") applyDetail(diskVersion);
});
byId("skills-unsaved-cancel").addEventListener("click", () => closeDialog("unsaved"));
byId("skills-unsaved-discard").addEventListener("click", () => {
  const action = pendingAction; pendingAction = null; draft = detail.content; diskVersion = null; closeDialog("unsaved"); renderDetail(); void action?.();
});
byId("skills-unsaved-save").addEventListener("click", async () => {
  if (!await save()) return;
  const action = pendingAction; pendingAction = null; closeDialog("unsaved"); void action?.();
});
byId("skills-source-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (busy()) return;
  const path = byId("skills-source-path").value.trim(); if (!path) return;
  mutating = true;
  for (const name of ["path", "pick", "add"]) byId(`skills-source-${name}`).disabled = true;
  errorTarget("skills-sources-error");
  try { sources = (await api("/api/skills/sources", { path })).sources; byId("skills-source-path").value = ""; }
  catch (failure) { errorTarget("skills-sources-error", failure.message); }
  finally {
    mutating = false;
    for (const name of ["path", "pick", "add"]) byId(`skills-source-${name}`).disabled = false;
    renderSources(); await refresh(true);
  }
});
for (const button of document.querySelectorAll("[data-skills-close]")) button.addEventListener("click", () => {
  if (!busy()) byId(button.dataset.skillsClose).close();
});
for (const name of dialogs) {
  const dialog = byId(`skills-${name}-dialog`);
  dialog.addEventListener("cancel", (event) => { if (busy()) event.preventDefault(); });
  dialog.addEventListener("close", () => {
    if (name === "unsaved") pendingAction = null;
    if (name === "import") invalidateImport();
    if (name === "delete") { deleteSequence++; deletePreview = null; }
    if ((name === "sources" && picking?.purpose === "source") || (name === "import" && picking?.purpose === "import")) picking.controller.abort();
  });
}
document.addEventListener("neuma:route", (event) => {
  const wasActive = active; active = event.detail.page === "skills";
  if (!active) for (const name of dialogs) closeDialog(name);
  if (active && !wasActive && !snapshot) void refresh();
});
window.addEventListener("beforeunload", (event) => { if (dirty()) { event.preventDefault(); event.returnValue = ""; } });
renderList(); renderDetail();
