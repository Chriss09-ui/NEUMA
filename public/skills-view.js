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
