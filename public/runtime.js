import { node } from "./project-view.js";
import { renderRuntimeLoading, renderRuntimePorts, renderRuntimeProjects } from "./runtime-view.js";

const byId = (id) => document.getElementById(id);
const dialog = byId("project-runtime-panel");
const tabs = ["projects", "ports"];
let snapshot = null, filter = "all", controller = null;

function selectProject(id) {
  dialog.close();
  document.dispatchEvent(new CustomEvent("neuma:project-select", { detail: { id } }));
}

function selectTab(selected, focus = false) {
  for (const name of tabs) {
    const active = name === selected, tab = byId(`runtime-tab-${name}`);
    tab.setAttribute("aria-selected", String(active)); tab.tabIndex = active ? 0 : -1;
    byId(`runtime-${name}-panel`).hidden = !active;
    if (active && focus) tab.focus();
  }
}

function render() {
  if (!snapshot) return;
  renderRuntimeProjects({ container: byId("runtime-projects-content"), projects: snapshot.projects, filter, onSelect: selectProject });
  const count = renderRuntimePorts({ container: byId("runtime-ports-content"), ports: snapshot.ports,
    query: byId("runtime-port-search").value, onSelect: selectProject });
  byId("runtime-port-count").textContent = `${count} 条监听记录`;
  for (const element of dialog.querySelectorAll("[data-runtime-count]")) {
    element.textContent = snapshot.summary[element.dataset.runtimeCount] ?? "—";
  }
}

async function refresh() {
  controller?.abort();
  const request = new AbortController(); controller = request;
  const button = byId("runtime-refresh"), status = byId("runtime-check-status"), error = byId("runtime-error");
  button.disabled = true; button.textContent = "正在刷新…";
  status.textContent = snapshot ? "正在刷新，当前显示上一次检查结果…" : "正在读取运行情况…";
  error.hidden = true;
  for (const name of tabs) {
    const content = byId(`runtime-${name}-content`);
    content.setAttribute("aria-busy", "true");
    if (!snapshot) renderRuntimeLoading(content);
  }
  try {
    const response = await fetch("/api/projects/runtime", { signal: request.signal, cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "运行情况读取失败，请重试。");
    if (!Array.isArray(result.projects) || !Array.isArray(result.ports) || !result.summary) throw new Error("运行情况返回不完整，请重试。");
    if (request.signal.aborted) return;
    snapshot = result;
    const time = new Date(result.checkedAt);
    status.textContent = Number.isNaN(time.getTime()) ? "本次检查已完成" : `检查于 ${time.toLocaleTimeString("zh-CN", { hour12: false })}`;
    const warnings = byId("runtime-warnings"); warnings.replaceChildren();
    for (const message of result.warnings ?? []) warnings.append(node("p", "", message));
    warnings.hidden = !warnings.childElementCount;
    render();
  } catch (failure) {
    if (request.signal.aborted) return;
    error.textContent = failure.message || "运行情况读取失败，请重试。"; error.hidden = false;
    status.textContent = snapshot ? "刷新失败，当前仍为上一次检查结果。" : "尚未取得运行情况。";
    if (!snapshot) for (const name of tabs) byId(`runtime-${name}-content`).replaceChildren();
    button.textContent = "重新检查";
  } finally {
    if (controller === request) {
      controller = null; button.disabled = false;
      if (error.hidden) button.textContent = "刷新状态";
      for (const name of tabs) byId(`runtime-${name}-content`).setAttribute("aria-busy", "false");
    }
  }
}

function open() {
  if (!dialog.open) dialog.showModal();
  void refresh();
}

byId("project-runtime-open").addEventListener("click", open);
byId("runtime-close").addEventListener("click", () => dialog.close());
byId("runtime-refresh").addEventListener("click", () => { void refresh(); });
byId("runtime-port-search").addEventListener("input", render);
dialog.addEventListener("close", () => controller?.abort());
document.addEventListener("neuma:runtime-open", open);
for (const [index, name] of tabs.entries()) {
  const tab = byId(`runtime-tab-${name}`);
  tab.addEventListener("click", () => selectTab(name));
  tab.addEventListener("keydown", (event) => {
    const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const target = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + offset + tabs.length) % tabs.length;
    if (!offset && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault(); selectTab(tabs[target], true);
  });
}
for (const button of dialog.querySelectorAll("[data-runtime-filter]")) button.addEventListener("click", () => {
  filter = button.dataset.runtimeFilter;
  for (const item of dialog.querySelectorAll("[data-runtime-filter]")) item.setAttribute("aria-pressed", String(item === button));
  render();
});
