export function skillNode(tag, className = "", text = "") {
  const element = document.createElement(tag);
  element.className = className; element.textContent = text;
  return element;
}

export function skillButton(label, action, className = "secondary", disabled = false) {
  const button = skillNode("button", className, label);
  button.type = "button"; button.disabled = disabled;
  button.addEventListener("click", action);
  return button;
}

export function renderSkillList({ container, skills, selectedId, query, sourceId, busy, onSelect }) {
  const needle = query.trim().toLocaleLowerCase();
  const filtered = skills.filter((skill) => (!sourceId || skill.sources?.some((source) => source.id === sourceId)
    || skill.locations?.some((location) => location.sourceId === sourceId))
    && [skill.name, skill.description, skill.filePath, ...(skill.sources ?? []).map((source) => source.label)]
      .join(" ").toLocaleLowerCase().includes(needle));
  container.replaceChildren();
  for (const skill of filtered) {
    const button = skillButton("", () => onSelect(skill.id), "item skill-item", busy);
    button.dataset.skillId = skill.id; button.setAttribute("aria-pressed", String(skill.id === selectedId));
    const top = skillNode("span", "item-top");
    top.append(skillNode("strong", "", skill.name || "未命名技能"), skillNode("em", "", skill.readOnly ? "只读" : ""));
    button.append(top, skillNode("span", "item-desc", skill.description || "没有技能说明"),
      skillNode("span", "skill-item-source", (skill.sources ?? []).map((source) => source.label).join(" · ")));
    container.append(button);
  }
  if (!filtered.length) container.append(skillNode("p", "empty-state", skills.length
    ? "没有符合筛选条件的技能。试试其他关键词或来源。" : "尚未发现技能。添加扫描目录，或从本地导入一个技能。"));
  return filtered.length;
}

export function renderSkillOptions(select, sources, { importing = false, selected = "" } = {}) {
  select.replaceChildren();
  const placeholder = skillNode("option", "", importing ? "选择通用、Codex、Claude、Pi 或项目目录" : "全部来源");
  placeholder.value = ""; select.append(placeholder);
  for (const source of sources) {
    if (importing && (!source.canImport || source.readOnly)) continue;
    const option = skillNode("option", "", importing
      ? `${source.label} · ${source.path}` : source.label);
    option.value = source.id; select.append(option);
  }
  select.value = sources.some((source) => source.id === selected && (!importing || source.canImport && !source.readOnly)) ? selected : "";
}

export function renderSkillSources({ container, sources, busy, onRemove }) {
  container.replaceChildren();
  for (const source of sources) {
    const row = skillNode("div", "skills-source-row"), info = skillNode("div", "skills-source-info");
    info.append(skillNode("strong", "", source.label), skillNode("code", "skills-path", source.path),
      skillNode("span", "muted-note small", source.readOnly ? "只读目录" : source.exists ? "可扫描" : "目录尚不存在"));
    row.append(info);
    if (source.custom) row.append(skillButton("停止扫描", () => onRemove(source.id), "ghost-button", busy));
    container.append(row);
  }
  if (!sources.length) container.append(skillNode("p", "empty-state", "尚未取得扫描目录。"));
}

export function renderSkillWarnings(container, messages) {
  container.replaceChildren();
  for (const warning of messages ?? []) container.append(skillNode("p", "", typeof warning === "string" ? warning : warning.message || warning.type || "目录读取存在问题"));
  container.hidden = !container.childElementCount;
}

export function renderSkillFiles(container, files) {
  container.replaceChildren();
  for (const file of files ?? []) {
    const row = skillNode("li", "");
    row.append(skillNode("code", "", file.path), skillNode("span", "muted-note small", file.type === "directory" ? "目录"
      : Number.isFinite(file.size) ? `${file.size.toLocaleString("zh-CN")} 字节` : file.type || "文件"));
    container.append(row);
  }
  if (!files?.length) container.append(skillNode("li", "muted-note", "没有附带资源。"));
}

export function renderSkillLocations({ container, locations, busy, onRemoveLink }) {
  container.replaceChildren();
  for (const location of locations ?? []) {
    const row = skillNode("div", "skills-location-row"), info = skillNode("div", "skills-source-info");
    info.append(skillNode("span", "muted-note small", location.label || "技能入口"), skillNode("code", "skills-path", location.path));
    row.append(info);
    if (location.canRemoveLink) row.append(skillButton("移除此入口", () => onRemoveLink(location.id), "ghost-button danger", busy));
    container.append(row);
  }
}

export function renderSkillImpact(container, preview, importing = false) {
  container.replaceChildren();
  container.append(skillNode("code", "skills-path", importing ? preview.targetPath : preview.path));
  container.append(skillNode("p", "", importing ? `将复制 ${preview.skillCount ?? preview.skills?.length ?? 1} 个技能。`
    : preview.action === "link" ? `回收这个软链接入口，影响 ${preview.skillCount ?? preview.skills?.length ?? 1} 个技能在此入口的访问；原技能文件保留。` : `将回收 ${preview.skillCount ?? preview.skills?.length ?? 1} 个技能及其目录内容。`));
  if (preview.skills?.length) {
    const list = skillNode("ul", "skills-impact-list");
    for (const skill of preview.skills) list.append(skillNode("li", "", typeof skill === "string" ? skill : `${skill.name || "技能"} · ${skill.filePath || skill.path || skill.baseDir || ""}`));
    container.append(list);
  }
  if (preview.aliases?.length && preview.action !== "link") {
    container.append(skillNode("p", "", "以下已发现入口将移除或失效；恢复后可重新使用："));
    const list = skillNode("ul", "skills-impact-list");
    for (const alias of preview.aliases) list.append(skillNode("li", "", typeof alias === "string" ? alias : alias.path || alias.label || "共享入口"));
    container.append(list);
  }
  for (const warning of preview.diagnostics ?? []) container.append(skillNode("p", "muted-note", typeof warning === "string" ? warning : warning.message));
  container.hidden = false;
}

export function renderSkillTrash({ container, entries, busy, onRestore }) {
  container.replaceChildren();
  for (const entry of entries) {
    const row = skillNode("div", "skills-source-row"), info = skillNode("div", "skills-source-info");
    info.append(skillNode("strong", "", entry.name || "已回收技能"), skillNode("code", "skills-path", entry.originalPath || entry.path || ""),
      skillNode("span", "muted-note small", entry.action === "link" ? "软链接入口" : "技能目录"));
    row.append(info, skillButton("恢复", () => onRestore(entry.id), "secondary", busy)); container.append(row);
  }
  if (!entries.length) container.append(skillNode("p", "empty-state", "回收站是空的。回收的技能可以在这里恢复。"));
}

export function initSkillSplitter({ layout, handle, windowRef = window, storage } = {}) {
  const noop = () => {};
  if (!layout?.getBoundingClientRect || !handle) return { refresh: noop, cancel: noop, dispose: noop };
  const key = "neuma-skills-list-width", defaultWidth = 300;
  let preferredWidth = defaultWidth, renderedWidth = defaultWidth, limits = null, dragging = null, pointerY = null, disposed = false;
  try {
    storage ??= windowRef.localStorage;
    const stored = Number(storage?.getItem(key));
    if (Number.isFinite(stored) && stored > 0) preferredWidth = Math.min(640, Math.round(stored));
  } catch { /* Width adjustment remains available when browser storage is blocked. */ }
  const clamp = (width) => Math.min(limits.max, Math.max(limits.min, width));
  const persist = () => { try { storage?.setItem(key, String(preferredWidth)); } catch { /* Keep the current layout in memory. */ } };
  const placeGrip = (clientY) => {
    if (disposed || !Number.isFinite(clientY)) return;
    const { top, height, width } = layout.getBoundingClientRect();
    if (!Number.isFinite(top) || !Number.isFinite(height) || height <= 0 || !Number.isFinite(width) || width <= 0) return;
    const inset = Math.min(28, height / 2);
    const y = Math.min(height - inset, Math.max(inset, clientY - top));
    layout.style.setProperty("--skills-grip-y", `${Math.round(y)}px`);
  };
  const centerGrip = () => {
    const { top, height, width } = layout.getBoundingClientRect();
    if (!Number.isFinite(top) || !Number.isFinite(height) || height <= 0 || !Number.isFinite(width) || width <= 0) return;
    const viewportBottom = Number.isFinite(windowRef.innerHeight) ? windowRef.innerHeight : top + height;
    const start = Math.max(0, top), end = Math.min(viewportBottom, top + height);
    if (end > start) placeGrip((start + end) / 2);
  };
  const refreshGrip = () => { if (pointerY === null) centerGrip(); else placeGrip(pointerY); };
  const followPointer = (event) => {
    if (disposed || dragging || event.isPrimary === false || !Number.isFinite(event.clientY)) return;
    pointerY = event.clientY; placeGrip(pointerY);
  };
  const leave = () => { if (!dragging) pointerY = null; };
  const focus = () => { if (!dragging && pointerY === null) centerGrip(); };
  const apply = () => {
    if (!limits) return;
    renderedWidth = clamp(preferredWidth);
    layout.style.setProperty("--skills-list-width", `${renderedWidth}px`);
    layout.style.setProperty("--skills-divider-x", `${renderedWidth + limits.gap / 2}px`);
    handle.setAttribute("aria-valuemin", String(limits.min));
    handle.setAttribute("aria-valuemax", String(limits.max));
    handle.setAttribute("aria-valuenow", String(renderedWidth));
    handle.setAttribute("aria-valuetext", `技能列表 ${renderedWidth} 像素`);
  };
  const refresh = () => {
    if (disposed) return;
    const width = layout.getBoundingClientRect().width;
    if (!Number.isFinite(width) || width <= 0) return;
    const gap = Number.parseFloat(windowRef.getComputedStyle?.(layout)?.columnGap) || 24;
    const max = Math.max(1, Math.min(640, Math.floor(width - gap - 420)));
    limits = { min: Math.min(220, max), max, gap };
    apply(); refreshGrip();
  };
  const finish = (commit = false) => {
    if (!dragging) return;
    const previous = dragging; dragging = null;
    if (!commit) preferredWidth = previous.preferredWidth;
    layout.classList.remove("is-resizing");
    try { if (handle.hasPointerCapture?.(previous.id)) handle.releasePointerCapture(previous.id); } catch { /* The browser may have released capture already. */ }
    apply();
    if (commit) persist();
  };
  const down = (event) => {
    if (disposed || dragging || event.button !== 0 || event.isPrimary === false) return;
    refresh(); if (!limits) return;
    followPointer(event);
    event.preventDefault(); handle.focus({ preventScroll: true });
    dragging = { id: event.pointerId, x: event.clientX, renderedWidth, preferredWidth };
    layout.classList.add("is-resizing");
    try { handle.setPointerCapture?.(event.pointerId); } catch { /* Window listeners still complete or cancel the drag. */ }
  };
  const move = (event) => {
    if (!dragging || event.pointerId !== dragging.id) return;
    event.preventDefault();
    if (Number.isFinite(event.clientY)) { pointerY = event.clientY; placeGrip(pointerY); }
    preferredWidth = clamp(Math.round(dragging.renderedWidth + event.clientX - dragging.x)); apply();
  };
  const up = (event) => { if (dragging && event.pointerId === dragging.id) finish(true); };
  const cancelPointer = (event) => { if (dragging && event.pointerId === dragging.id) finish(false); };
  const cancel = () => finish(false);
  const keyboard = (event) => {
    if (disposed || dragging || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    refresh(); if (!limits) return;
    event.preventDefault();
    const step = event.shiftKey ? 48 : 16;
    preferredWidth = event.key === "Home" ? limits.min : event.key === "End" ? limits.max
      : clamp(renderedWidth + (event.key === "ArrowRight" ? step : -step));
    apply(); persist();
  };
  const reset = () => { if (!disposed) { cancel(); preferredWidth = defaultWidth; refresh(); persist(); } };
  handle.setAttribute("role", "separator"); handle.setAttribute("aria-orientation", "vertical");
  const listeners = [[handle, "pointerenter", followPointer], [handle, "pointermove", followPointer],
    [handle, "pointerleave", leave], [handle, "focus", focus], [windowRef, "scroll", refreshGrip, true],
    [handle, "pointerdown", down], [handle, "lostpointercapture", cancelPointer],
    [handle, "keydown", keyboard], [handle, "dblclick", reset], [windowRef, "pointermove", move],
    [windowRef, "pointerup", up], [windowRef, "pointercancel", cancelPointer], [windowRef, "blur", cancel]];
  const Observer = windowRef.ResizeObserver;
  const observer = typeof Observer === "function" ? new Observer(refresh) : null;
  if (observer) observer.observe(layout); else listeners.push([windowRef, "resize", refresh]);
  for (const [target, name, listener, options] of listeners) target.addEventListener(name, listener, options);
  refresh();
  return { refresh, cancel, dispose: () => {
    if (disposed) return;
    cancel(); disposed = true; observer?.disconnect();
    for (const [target, name, listener, options] of listeners) target.removeEventListener(name, listener, options);
  } };
}
