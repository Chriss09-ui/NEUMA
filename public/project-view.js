export const STATUS_LABELS = { stopped: "已收纳", starting: "正在启动", running: "运行中", failed: "启动失败", completed: "运行结束", external: "已在外部打开" };
const KIND_LABELS = { web: "本地网页", node: "Node 项目", python: "Python 工具", desktop: "桌面应用", other: "其他项目" };

export function node(tag, className = "", text = "") {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = text;
  return el;
}

export function renderProjectList({ container, projects, selectedId, busy, onSelect }) {
  container.replaceChildren();
  if (!projects.length) { container.append(node("p", "agents-empty", "还没有匹配的项目。粘贴路径即可添加，也可以在对话中告诉我。")); return; }
  for (const project of projects) {
    const card = node("article", `agent-card${project.id === selectedId ? " active" : ""}`);
    const button = node("button", "agent-open");
    button.type = "button"; button.disabled = busy;
    button.setAttribute("aria-pressed", String(project.id === selectedId));
    button.setAttribute("aria-label", `查看 ${project.name}`);
    button.append(node("strong", "agent-name", project.name), node("span", "agent-goal", project.description || KIND_LABELS[project.kind]));
    button.addEventListener("click", () => onSelect(project.id));
    const footer = node("div", "agent-footer");
    footer.append(node("span", "agent-save-state", STATUS_LABELS[project.status]));
    card.append(button, footer); container.append(card);
  }
}

export function renderProjectDetails({ container, project, onConfigure, onAction }) {
  container.replaceChildren();
  if (!project) { container.append(node("p", "panel-note", "选择一个项目，查看位置、启动方式和预览。")); return; }
  const meta = node("div", "project-meta");
  meta.append(node("strong", "", project.name), node("p", "", `${KIND_LABELS[project.kind]}\n${project.path}`));
  if (project.description) meta.append(node("p", "", project.description));
  container.append(meta);
  const form = node("form", "project-config");
  const fields = {};
  const field = (key, label, value, multiline = false) => {
    const wrapper = node("label", "", label), input = node(multiline ? "textarea" : "input");
    input.value = value; if (!multiline) input.type = "text";
    input.id = `project-config-${key}`; fields[key] = input;
    wrapper.append(input); form.append(wrapper);
  };
  if (project.kind !== "web") {
    field("command", "启动程序", project.launch?.command || "");
    field("args", "启动参数（JSON 数组）", JSON.stringify(project.launch?.args || []), true);
    field("url", "本地页面地址（可选，也会尝试从启动输出识别）", project.launch?.url || "");
  } else form.append(node("p", "project-action-note", "此网页会通过独立的本地预览地址打开。"));
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
  container.append(form);
  const actions = node("div", "panel-actions");
  for (const [action, label] of [["start", "启动并查看"], ["stop", "停止"], ["remove", "移除记录"]]) {
    const button = node("button", action === "remove" ? "text-button" : "secondary", label);
    button.type = "button"; button.dataset.projectAction = action;
    button.addEventListener("click", () => { void onAction(action); }); actions.append(button);
  }
  const note = node("p", "project-action-note"); note.id = "project-runtime-note";
  const link = node("a", "project-preview-link", "在新窗口打开页面"); link.id = "project-preview-link";
  link.target = "_blank"; link.rel = "noopener noreferrer"; link.hidden = true;
  const preview = node("iframe", "project-preview"); preview.id = "project-preview";
  preview.title = `${project.name} 的页面预览`; preview.setAttribute("sandbox", "allow-scripts allow-forms allow-downloads"); preview.hidden = true;
  container.append(actions, note, link, preview);
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
    : !project.canLaunch ? "核对并启用启动方式后，可以在对话中让我打开它。" : "移除记录保留原项目文件。");
  const link = container.querySelector("#project-preview-link"), preview = container.querySelector("#project-preview");
  link.hidden = preview.hidden = !project.url;
  if (project.url) {
    link.href = project.url;
    if (preview.getAttribute("src") !== project.url) preview.src = project.url;
  } else preview.removeAttribute("src");
}
