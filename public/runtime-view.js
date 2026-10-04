import { node } from "./project-view.js";

const STATE_LABELS = { running: "运行中", stopped: "未发现运行", unknown: "待确认" };
const SOURCE_LABELS = { nuema: "NUEMA 启动", external: "外部启动" };

function empty(container, title, description) {
  const state = node("div", "runtime-empty");
  state.append(node("strong", "", title), node("p", "", description));
  container.replaceChildren(state);
}

function createTable(label, headings) {
  const table = node("table", "runtime-table");
  table.append(node("caption", "sr-only", label));
  const head = node("thead"), row = node("tr"), body = node("tbody");
  for (const heading of headings) {
    const cell = node("th", "", heading); cell.scope = "col"; row.append(cell);
  }
  head.append(row); table.append(head, body);
  return { table, body };
}

function projectLink(project, onSelect, label = project.name) {
  const button = node("button", "runtime-project-link", label);
  button.type = "button";
  button.setAttribute("aria-label", `查看项目 ${project.name}`);
  button.addEventListener("click", () => onSelect(project.id));
  return button;
}

export function renderRuntimeProjects({ container, projects, filter, onSelect }) {
  const shown = projects.filter((project) => filter === "all" || (project.runtime?.state ?? "unknown") === filter);
  if (!shown.length) {
    empty(container, projects.length ? "没有符合当前状态的项目" : "还没有添加项目",
      projects.length ? "选择其他状态，查看已添加的项目。" : "添加本地项目后，可以在这里统一查看运行情况。");
    return;
  }
  const { table, body } = createTable("已添加项目的运行情况", ["项目", "运行状态", "监听端口", "操作"]);
  for (const project of shown) {
    const row = node("tr"), identity = node("td", "runtime-project-identity"), status = node("td");
    identity.append(node("strong", "", project.name));
    const path = node("span", "runtime-project-path", project.path ?? ""); path.title = project.path ?? "";
    identity.append(path);
    const runtime = project.runtime ?? { state: "unknown" };
    const state = Object.hasOwn(STATE_LABELS, runtime.state) ? runtime.state : "unknown";
    const badge = node("span", `runtime-state runtime-state-${state}`, STATE_LABELS[state]);
    status.append(badge);
    if (SOURCE_LABELS[runtime.source]) status.append(node("small", "runtime-source", SOURCE_LABELS[runtime.source]));
    if (runtime.reason) status.append(node("small", "runtime-reason", runtime.reason));
    const ports = node("td", "runtime-port-values", runtime.ports?.length ? runtime.ports.join(" · ") : "—");
    const action = node("td", "runtime-row-action"); action.append(projectLink(project, onSelect, "查看配置 →"));
    row.append(identity, status, ports, action); body.append(row);
  }
  container.replaceChildren(table);
}

export function renderRuntimePorts({ container, ports, query, onSelect }) {
  const search = query.trim().toLowerCase();
  const shown = ports.filter((item) => [item.port, item.pid, item.processName, item.address,
    ...(item.projects ?? []).map((project) => project.name)].join(" ").toLowerCase().includes(search));
  if (!shown.length) {
    empty(container, search ? "没有匹配的端口" : "本次未发现监听端口",
      search ? "试试端口号、进程名称或已添加的项目名称。" : "这里显示当前权限可读取的 TCP 监听端口。");
    return 0;
  }
  const { table, body } = createTable("电脑上的 TCP 监听端口", ["端口", "占用进程", "监听地址", "关联项目"]);
  for (const item of shown) {
    const row = node("tr"), port = node("td", "runtime-port-number"), process = node("td");
    port.append(node("strong", "", String(item.port)), node("small", "runtime-source", item.protocol || "TCP"));
    process.append(node("strong", "runtime-process-name", item.processName || "未知进程"), node("small", "runtime-source", `PID ${item.pid ?? "—"}`));
    const address = node("td", "runtime-address", item.address || "—");
    const projects = node("td", "runtime-port-projects");
    if (item.projects?.length) for (const project of item.projects) projects.append(projectLink(project, onSelect));
    else projects.append(node("span", "runtime-unmatched", "未关联项目"));
    row.append(port, process, address, projects); body.append(row);
  }
  container.replaceChildren(table);
  return shown.length;
}

export function renderRuntimeLoading(container) {
  empty(container, "正在检查", "读取本机端口和已添加项目的运行情况…");
}
