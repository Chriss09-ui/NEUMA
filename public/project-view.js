export const STATUS_LABELS = { stopped: "未运行", starting: "正在启动", running: "运行中", failed: "启动失败", completed: "运行结束", external: "已在外部打开" };
export const KIND_LABELS = { web: "本地网页", node: "Node 项目", python: "Python 工具", script: "脚本项目", desktop: "桌面应用", other: "其他项目" };
const STATUS_TONE = { running: "ok", external: "ok", starting: "warn", failed: "off" };

// Older saved summaries and running servers can still use the internal engine name.
export function nuemaText(value = "") {
  return value.replace(/\b(?:NUEMA|PI(?:[\s-]*agent)?)\b/gi, "NEUMA");
}

export function node(tag, className = "", text = "") {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = text;
  return el;
}

export function statusDot(status) {
  return node("i", `dot ${STATUS_TONE[status] ?? ""}`);
}

export function renderProjectList({ container, projects, selectedId, busy, onSelect, onInspect, onRemove, removeDisabled = false, emptyText, onClearSearch }) {
  const focusedId = container.contains(document.activeElement) ? document.activeElement.dataset.projectId : null;
  const focusedRemoveId = container.contains(document.activeElement) ? document.activeElement.dataset.projectRemoveId : null;
  const focusedInspectId = container.contains(document.activeElement) ? document.activeElement.dataset.projectInspectId : null;
  container.replaceChildren();
  if (!projects.length) {
    const empty = node("div", "library-empty");
    empty.append(node("strong", "", emptyText), node("p", "", onClearSearch ? "换个关键词，或清除搜索。" : "添加一个本地项目，\n以后就能在这里找到它。"));
    if (onClearSearch) {
      const clear = node("button", "text-link link-button", "清除搜索"); clear.type = "button";
      clear.addEventListener("click", onClearSearch); empty.append(clear);
    } else {
      const add = node("a", "text-link", "添加第一个项目 →"); add.href = "#projects/add"; empty.append(add);
    }
    container.append(empty);
    return;
  }
  for (const project of projects) {
    const button = node("button", "item");
    button.type = "button"; button.disabled = busy;
    button.dataset.projectId = project.id;
    button.setAttribute("aria-pressed", String(project.id === selectedId));
    button.setAttribute("aria-label", `查看 ${project.name}`);
    const top = node("span", "item-top");
    top.append(statusDot(project.status), node("strong", "", project.name), node("em", "", STATUS_LABELS[project.status]));
    button.append(top, node("span", "item-desc", project.description || KIND_LABELS[project.kind]));
    button.addEventListener("click", () => onSelect(project.id));
    const row = node("div", "project-list-entry"); row.append(button);
    if (onInspect) {
      const checking = project.setup?.status === "checking";
      const inspect = node("button", "project-list-inspect", checking ? "识别中…" : "重新识别");
      inspect.type = "button"; inspect.disabled = busy || removeDisabled || checking || project.canStop;
      inspect.dataset.projectInspectId = project.id;
      inspect.title = project.canStop ? "请先停止项目，再重新识别启动方式" : "让 NEUMA 重新读取项目并更新启动方式";
      inspect.setAttribute("aria-label", `重新识别项目 ${project.name}`);
      inspect.setAttribute("aria-busy", String(checking));
      inspect.addEventListener("click", () => { void onInspect(project.id); });
      row.append(inspect);
    }
    if (onRemove) {
      const remove = node("button", "project-list-delete", "删除");
      remove.type = "button"; remove.disabled = busy || removeDisabled;
      remove.dataset.projectRemoveId = project.id;
      remove.title = `删除项目“${project.name}”`;
      remove.setAttribute("aria-label", `删除项目 ${project.name}`);
      remove.addEventListener("click", () => { void onRemove(project.id); });
      row.append(remove);
      container.append(row);
      if (project.id === focusedRemoveId) remove.focus({ preventScroll: true });
    } else container.append(row);
    if (project.id === focusedId) button.focus({ preventScroll: true });
    if (project.id === focusedInspectId) row.querySelector(".project-list-inspect").focus({ preventScroll: true });
  }
}

export function renderProjectDetails({ container, project, onConfigure, onAction }) {
  container.replaceChildren();
  if (!project) {
    const empty = node("div", "detail-empty");
    const link = node("a", "primary", "添加项目"); link.href = "#projects/add";
    empty.append(node("span", "empty-symbol", "＋"), node("h3", "", "给常用工具一个固定位置"),
      node("p", "", "选择左侧项目，查看详情或直接打开；\n也可以添加一个新的本地项目。"), link);
    container.append(empty);
    return;
  }
  const meta = node("div", "project-meta");
  meta.append(node("span", "kind", KIND_LABELS[project.kind]), node("strong", "", project.name), node("code", "", project.path));
  if (project.description) meta.append(node("p", "", project.description));

  const form = node("form", "project-config");
  const launch = node("details", "project-launch");
  const summary = node("summary");
  summary.append(node("span", "", "高级配置"), node("small", "", "需要时再手动调整"));
  launch.append(summary, form);
  const fields = {};
  const field = (key, label, value, multiline = false, placeholder = "") => {
    const wrapper = node("label", "", label), input = node(multiline ? "textarea" : "input");
    input.value = value; input.placeholder = placeholder; input.spellcheck = false;
    if (!multiline) input.type = "text";
    input.id = `project-config-${key}`; fields[key] = input;
    wrapper.append(input); form.append(wrapper);
  };
  if (project.kind !== "web") {
    field("command", "启动程序", project.launch?.command || "", false, "例如 npm、python3");
    field("args", "启动参数（JSON 数组）", JSON.stringify(project.launch?.args || []), true, "[\"run\", \"dev\"]");
    field("url", "本地页面地址（可选，也会尝试从启动输出识别）", project.launch?.url || "", false, "http://127.0.0.1:5173");
  } else form.append(node("p", "project-action-note", "这是静态网页，会通过独立的本机预览地址打开。"));
  const permission = node("label", "launch-permission"), check = node("input");
  check.type = "checkbox"; check.checked = project.allowLaunch;
  permission.append(check, node("span", "", "允许 NEUMA 按此方式启动这个项目。启动会运行项目自己的代码。"));
  form.append(permission);
  const save = node("button", "secondary", "保存启动方式"); save.type = "submit"; form.append(save);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    let args = [];
    try { if (fields.args) args = JSON.parse(fields.args.value); }
    catch { fields.args.setCustomValidity("请填写 JSON 数组，例如 [\"run\", \"dev\"]"); fields.args.reportValidity(); return; }
    fields.args?.setCustomValidity("");
    void onConfigure({ command: fields.command?.value.trim(), args, url: fields.url?.value.trim(), allowLaunch: check.checked });
  });
  fields.args?.addEventListener("input", () => fields.args.setCustomValidity(""));

  const actions = node("div", "project-actions");
  for (const [action, label, className] of [["start", "打开项目", "primary"],
    ["stop", "停止", "secondary"], ["remove", "删除项目", "secondary danger project-delete"]]) {
    const button = node("button", className, label);
    button.type = "button"; button.dataset.projectAction = action;
    button.addEventListener("click", () => { void onAction(action); }); actions.append(button);
  }
  const setup = node("div", "project-setup"); setup.setAttribute("aria-busy", String(project.setup?.status === "checking"));
  setup.append(node("span", "project-setup-mark", project.setup?.status === "checking" ? "◌" : project.canLaunch ? "✓" : "·"));
  const setupText = node("div", "project-setup-text"); setupText.setAttribute("role", "status");
  setupText.append(node("strong", "", project.setup?.status === "checking" ? "NEUMA 正在重新识别" : project.setup?.status === "paused" ? "检查已暂停" : project.canLaunch ? "启动方式已配好" : "让 NEUMA 帮你配置"),
    node("p", "", nuemaText(project.setup?.summary || "自动检查项目说明和入口，识别后即可一键打开，无需填写启动参数。")));
  const help = node("p", "project-inspect-hint"); help.id = "project-inspect-hint"; setupText.append(help);
  const inspect = node("button", "secondary project-reinspect", "重新识别"); inspect.type = "button";
  inspect.dataset.projectAction = "inspect";
  inspect.setAttribute("aria-describedby", help.id);
  inspect.addEventListener("click", () => { void onAction("inspect"); });
  setup.append(setupText, inspect);
  const note = node("p", "project-action-note"); note.id = "project-runtime-note";
  container.append(meta, setup, actions, note, launch);
}

export function updateProjectStatus(container, project, busy) {
  if (!project) return;
  for (const el of container.querySelectorAll("input, textarea, button")) {
    const action = el.dataset.projectAction;
    el.disabled = busy || project.setup?.status === "checking" || (action === "start" ? !project.canLaunch || project.openingPage || project.status === "starting"
      : action === "inspect" ? project.canStop
      : action === "stop" ? !project.canStop : !action && project.canStop);
    if (action === "start") el.textContent = project.openingPage || project.status === "starting" ? "正在打开…" : "打开项目";
    if (action === "inspect") {
      el.textContent = project.setup?.status === "checking" ? "识别中…" : "重新识别";
      el.setAttribute("aria-busy", String(project.setup?.status === "checking"));
      el.title = project.canStop ? "请先停止项目，再重新识别启动方式" : "让 NEUMA 重新读取项目并更新启动方式";
    }
  }
  container.querySelector("#project-inspect-hint").textContent = project.setup?.status === "checking"
    ? "正在读取最新文件，完成后会更新启动配置。"
    : project.canStop ? "请先停止项目，再重新识别启动方式。" : "启动方式有变化？让 NEUMA 重新识别，一键更新配置。";
  const note = container.querySelector("#project-runtime-note");
  note.textContent = nuemaText(project.error || project.openError || (project.openingPage || project.status === "starting"
    ? "正在准备项目，完成后会自动打开窗口。"
    : project.canStop ? project.pageOpened ? "项目已打开，保持运行即可使用。" : "项目正在运行。"
      : project.status === "external" ? "项目已在独立窗口打开。"
        : !project.canLaunch ? "识别遇到问题时，可以点“问问助手”继续说明，或重新识别。" : "点击后会自动启动并打开项目。原项目文件会保留。"));
}
