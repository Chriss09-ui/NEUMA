import { createApplicationApi } from "./application-api.js";
import { installApplicationHostBridge } from "./application-bridge.js";
import { createApplicationTasks } from "./application-tasks.js";

export function applicationMode(storage, id) {
  try { return storage?.getItem(`neuma.agent.application-mode.v1.${id}`) === "chat" ? "chat" : "application"; }
  catch { return "application"; }
}

export function createApplicationWorkspace({ document, window, api, storage }) {
  const byId = (id) => document.getElementById(id), root = byId("agent-workspace"), panel = byId("agent-application");
  let currentId = null, current = null, mode = "application", assistant = false, instance = null, frame = null;
  let detachBridge = null, generation = 0, opening = false, materialResolve = null;
  const settings = () => document.dispatchEvent(new CustomEvent("neuma:agent-connections-open"));
  const artifacts = () => byId("agent-artifacts-open").click();
  const tasks = createApplicationTasks({ document, api, list: byId("agent-application-task-list"), status: byId("agent-application-task-status"), onArtifacts: artifacts,
    onCompleted: (agentId) => document.dispatchEvent(new CustomEvent("neuma:agent-artifacts-changed", { detail: { agentId } })) });
  function render() {
    const available = Boolean(current?.pageReady && current.manifest?.page);
    const appMode = available && mode === "application";
    byId("agent-view-switch").hidden = !available;
    byId("agent-assistant-toggle").hidden = !appMode;
    byId("agent-assistant-toggle").setAttribute("aria-expanded", String(assistant && appMode));
    byId("agent-view-application").setAttribute("aria-pressed", String(mode === "application"));
    byId("agent-view-chat").setAttribute("aria-pressed", String(mode === "chat"));
    root.classList.toggle("has-application", available);
    root.classList.toggle("is-application", appMode);
    root.classList.toggle("application-assistant-open", appMode && assistant);
    panel.hidden = !appMode;
    const missing = (current?.actions || []).filter((action) => action.ready === false);
    byId("agent-application-connection-note").hidden = !missing.length;
    byId("agent-application-connection-text").textContent = missing.length
      ? `${missing.map((action) => action.label || action.title || action.id).join("、")}需要配置连接。其他功能可以继续使用。` : "";
    byId("agent-application-state").hidden = !available;
    byId("agent-application-state").textContent = missing.length ? "已交付 · 部分操作待配置" : "应用已交付";
  }
  function closeResource({ keepalive = false } = {}) {
    generation++; opening = false;
    detachBridge?.(); detachBridge = null;
    const previous = instance; instance = null;
    frame?.remove(); frame = null;
    if (previous) void api.close(previous.agentId, previous.instanceId, { keepalive }).catch(() => {});
    tasks.stop();
  }
  async function openResource() {
    if (!currentId || !current?.pageReady || !current.manifest?.page || instance || opening) return;
    const id = currentId, version = ++generation;
    opening = true;
    let opened = null;
    byId("agent-application-loading").hidden = false;
    byId("agent-application-loading").textContent = "正在打开应用…";
    byId("agent-application-retry").hidden = true;
    try {
      const result = await api.open(id);
      opened = result;
      if (currentId !== id || version !== generation) { void api.close(id, result.instanceId).catch(() => {}); return; }
      const address = new URL(result.url);
      if (address.origin !== result.origin || !["http:", "https:"].includes(address.protocol)
        || result.origin === window.location.origin || result.deliveryVersion !== current.deliveryVersion) throw new Error("页面来源或交付版本不一致，请重新打开应用。");
      instance = { ...result, agentId: id };
      frame = document.createElement("iframe"); frame.title = `${byId("agent-title").textContent}应用`;
      frame.className = "application-frame"; frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
      frame.setAttribute("referrerpolicy", "no-referrer");
      detachBridge = installApplicationHostBridge({ window, frame, instance, agentId: id, api, onTasks: tasks.refresh,
        onSettings: settings, onArtifacts: artifacts, selectMaterials });
      frame.addEventListener("load", () => { if (currentId === id && version === generation) byId("agent-application-loading").hidden = true; });
      frame.src = result.url; byId("agent-application-frame-host").append(frame);
      tasks.start(id);
    } catch (error) {
      if (opened && (!instance || instance.instanceId !== opened.instanceId)) void api.close(id, opened.instanceId).catch(() => {});
      if (currentId !== id || version !== generation) return;
      byId("agent-application-loading").textContent = error.message || "应用暂时无法打开。";
      byId("agent-application-retry").hidden = false;
    } finally { if (version === generation) opening = false; }
  }
  async function selectMaterials(id) {
    if (materialResolve) throw new Error("已有材料选择窗口打开。");
    const dialog = byId("application-material-dialog"), list = byId("application-material-list");
    list.replaceChildren();
    const result = await api.materials(id);
    if (id !== currentId) return { materials: [] };
    const selected = new Map();
    for (const material of result.attachments || result.materials || []) {
      const label = document.createElement("label"), checkbox = document.createElement("input"), title = document.createElement("span");
      label.className = "application-material-option"; checkbox.type = "checkbox"; title.textContent = material.name || "材料";
      checkbox.addEventListener("change", () => checkbox.checked ? selected.set(material.id, material) : selected.delete(material.id));
      label.append(checkbox, title); list.append(label);
    }
    if (!list.children.length) { const empty = document.createElement("p"); empty.textContent = "还没有材料，可从助手对话上传。"; list.append(empty); }
    dialog.showModal();
    return new Promise((resolve) => { materialResolve = { resolve, selected }; });
  }
  for (const [id, selected] of [["agent-view-application", "application"], ["agent-view-chat", "chat"]]) byId(id).addEventListener("click", () => {
    mode = selected; try { storage?.setItem(`neuma.agent.application-mode.v1.${currentId}`, mode); } catch {}
    render(); if (mode === "application") void openResource(); else byId("agent-message").focus();
  });
  byId("agent-assistant-toggle").addEventListener("click", () => { assistant = !assistant; render(); if (assistant) byId("agent-message").focus(); });
  byId("agent-application-configure").addEventListener("click", settings);
  byId("agent-application-retry").addEventListener("click", () => { closeResource(); void openResource(); });
  byId("application-material-confirm").addEventListener("click", () => {
    materialResolve?.resolve({ materials: [...materialResolve.selected.values()] }); materialResolve = null;
    byId("application-material-dialog").close();
  });
  byId("application-material-close").addEventListener("click", () => byId("application-material-dialog").close());
  byId("application-material-dialog").addEventListener("close", () => { materialResolve?.resolve({ materials: [] }); materialResolve = null; });
  return {
    route(id) {
      if (id !== currentId) { closeResource(); currentId = id; current = null; assistant = false; mode = applicationMode(storage, id); byId("application-material-dialog").close(); }
      render();
    },
    update(id, application) {
      if (id !== currentId) return;
      if (current?.deliveryVersion !== application?.deliveryVersion || !application?.pageReady) closeResource();
      current = application; render();
      if (mode === "application") void openResource();
    },
    async refresh() { const id = currentId; if (id) { const result = await api.application(id); if (id === currentId) this.update(id, result); } },
    remove(id) { if (id === currentId) { closeResource(); current = null; render(); } },
    close: closeResource,
  };
}

if (typeof document !== "undefined" && document.getElementById("agent-application")) {
  let storage; try { storage = window.localStorage; } catch {}
  const api = createApplicationApi(), checked = new Map();
  let routeId = null;
  const view = createApplicationWorkspace({ document, window, storage, api });
  document.addEventListener("neuma:route", (event) => {
    routeId = event.detail.page === "agent" ? event.detail.agentId : null;
    view.route(routeId);
    document.dispatchEvent(new CustomEvent("neuma:agent-runtime-request", { detail: { agentId: event.detail.agentId } }));
  });
  document.addEventListener("neuma:agent-runtime-change", (event) => {
    const { agentId, application, definition, status } = event.detail;
    view.update(agentId, application);
    if (routeId !== agentId || application || !definition || !["ready", "needs_connection"].includes(status)) return;
    const key = `${definition.revision}:${status}`;
    if (checked.get(agentId) === key) return;
    checked.set(agentId, key);
    void api.application(agentId).then((result) => document.dispatchEvent(new CustomEvent("neuma:agent-application-loaded", {
      detail: { agentId, application: result, revision: definition.revision },
    }))).catch(() => checked.delete(agentId));
  });
  document.addEventListener("neuma:agent-connections-changed", () => view.refresh().catch(() => {}));
  document.addEventListener("neuma:agent-removed", (event) => view.remove(event.detail.id));
  window.addEventListener("pagehide", () => view.close({ keepalive: true }));
}
