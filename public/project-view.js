export const STATUS_LABELS = { stopped: "未运行", starting: "正在启动", running: "运行中", failed: "启动失败", completed: "运行结束", external: "已在外部打开" };
export const KIND_LABELS = { web: "本地网页", node: "Node 项目", python: "Python 工具", desktop: "桌面应用", other: "其他项目" };
const STATUS_TONE = { running: "ok", external: "ok", starting: "warn", failed: "off" };

export function node(tag, className = "", text = "") {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = text;
  return el;
}

export function statusDot(status) {
  return node("i", `dot ${STATUS_TONE[status] ?? ""}`);
}

export function renderProjectList({ container, projects, selectedId, busy, onSelect, emptyText, onClearSearch }) {
  const focusedId = container.contains(document.activeElement) ? document.activeElement.dataset.projectId : null;
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
    container.append(button);
    if (project.id === focusedId) button.focus({ preventScroll: true });
  }
}

export function renderProjectDetails({ container, project, onConfigure, onAction }) {
  container.replaceChildren();
  if (!project) {
    const empty = node("div", "detail-empty");
    const link = node("a", "primary", "添加项目"); link.href = "#projects/add";
    empty.append(node("span", "empty-symbol", "＋"), node("h3", "", "给常用工具一个固定位置"),
      node("p", "", "选择左侧项目，查看详情与预览；\n也可以添加一个新的本地项目。"), link);
    container.append(empty);
    return;
  }
  const meta = node("div", "project-meta");
  meta.append(node("span", "kind", KIND_LABELS[project.kind]), node("strong", "", project.name), node("code", "", project.path));
  if (project.description) meta.append(node("p", "", project.description));

  const form = node("form", "project-config");
  const launch = node("details", "project-launch"); launch.open = !project.allowLaunch;
  const summary = node("summary");
  summary.append(node("span", "", "启动方式"), node("small", "", project.allowLaunch ? "已核对 · 点击修改" : "首次使用，请先核对"));
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
  for (const [action, label, className] of [["start", "启动并查看", "primary"], ["stop", "停止", "secondary"], ["remove", "移除记录", "ghost-button"]]) {
    const button = node("button", className, label);
    button.type = "button"; button.dataset.projectAction = action;
    button.addEventListener("click", () => { void onAction(action); }); actions.append(button);
  }
  const note = node("p", "project-action-note"); note.id = "project-runtime-note";
  const link = node("a", "project-preview-link", "在新窗口打开页面 ↗"); link.id = "project-preview-link";
  link.target = "_blank"; link.rel = "noopener noreferrer"; link.hidden = true;
  const preview = node("iframe", "project-preview"); preview.id = "project-preview";
  preview.title = `${project.name} 的页面预览`; preview.setAttribute("sandbox", "allow-scripts allow-forms allow-downloads"); preview.hidden = true;
  container.append(meta, actions, note, launch, link, preview);
}

export function updateProjectStatus(container, project, busy) {
  if (!project) return;
  for (const el of container.querySelectorAll("input, textarea, button")) {
    const action = el.dataset.projectAction;
    el.disabled = busy || (action === "start" ? !project.canLaunch || project.canStop
      : action === "stop" ? !project.canStop : !action && project.canStop);
  }
  const note = container.querySelector("#project-runtime-note");
  note.textContent = project.error || (project.status === "running" && !project.url
    ? "进程正在运行，页面入口尚未验证。脚本工具可能没有网页。"
    : project.canStop ? "运行中无法修改启动方式，停止后可编辑。"
      : !project.canLaunch ? "核对并勾选允许启动后保存，就可以启动或让项目助手打开它。" : "移除记录只删除登记，原项目文件会保留。");
  const link = container.querySelector("#project-preview-link"), preview = container.querySelector("#project-preview");
  link.hidden = preview.hidden = !project.url;
  if (project.url) {
    link.href = project.url;
    if (preview.getAttribute("src") !== project.url) preview.src = project.url;
  } else preview.removeAttribute("src");
}
