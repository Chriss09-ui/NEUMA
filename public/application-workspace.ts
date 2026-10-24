import type { ApplicationElement, ApplicationDocument, ApplicationWindow, DownloadDocument } from "./application-dom.js";
import type { BridgeWindow } from "./application-bridge.js";
import type { ApplicationApi } from "./ui-api-types.js";
import type { ApplicationInstance, ApplicationView, Material } from "./ui-types.js";
import type { TaskArtifactDetail } from "./browser-events.js";
interface MaterialSelection { agentId: string; generation: number; instance: ApplicationInstance | null; selected: Map<string, Material>; shown: boolean; resolve: (result: { materials: Material[] }) => void; reject: (error: unknown) => void }
import { pageElement, type PageElements } from "./page-elements.js";
import { errorInfo } from "./ui-types.js";
import { createApplicationApi } from "./application-api.js";
import { installApplicationHostBridge } from "./application-bridge.js";
import { createApplicationTasks } from "./application-tasks.js";
import { createApplicationAssistant } from "./application-assistant.js";
import { activateApplicationContext, setApplicationContext, clearApplicationContext, getApplicationActionContext,
  releaseApplicationContext, applicationTaskEvent } from "./application-context.js";

export function applicationMode(storage: Pick<Storage,"getItem"> | null | undefined, id: string | null, defaultEntry = "application") {
  try {
    const selected = storage?.getItem(`neuma.agent.application-mode.v1.${id}`);
    if (["chat", "application"].includes(selected!)) return selected!;
  } catch {}
  return ["conversation", "chat"].includes(defaultEntry) ? "chat" : "application";
}

export function createApplicationWorkspace<E extends ApplicationElement<E> = HTMLElement>({ document, window, api, storage }: { document: ApplicationDocument<E> & DownloadDocument<E>; window: ApplicationWindow<E> & BridgeWindow; api: ApplicationApi; storage?: Pick<Storage,"getItem"|"setItem"> | null | undefined }) {
  const byId = <K extends keyof PageElements>(id: K) => pageElement(document, id), root = byId("agent-workspace"), panel = byId("agent-application");
  let currentId: string | null = null, current: ApplicationView | null = null, mode = "application", assistant = false, settingsOpen = false, instance: (ApplicationInstance & {agentId:string}) | null = null, frame: E | null = null;
  let detachBridge: ReturnType<typeof installApplicationHostBridge> | null = null, generation = 0, opening = false, materialSelection: MaterialSelection | null = null;
  const floatingAssistant = createApplicationAssistant({ document, window, root, storage });
  const taskPanel = byId("agent-application-task-list").parentElement;
  const fileTaskHost = byId("agent-file-list").parentElement;
  const settings = () => document.dispatchEvent(new CustomEvent("neuma:agent-connections-open"));
  const artifacts = (detail?: TaskArtifactDetail) => detail?.taskId
    ? document.dispatchEvent(new CustomEvent("neuma:agent-task-artifact-open", { detail })) : byId("agent-artifacts-open").click();
  const tasks = createApplicationTasks({ document, api, list: byId("agent-application-task-list"), status: byId("agent-application-task-status"), onArtifacts: artifacts,
    onChanged: (task) => detachBridge?.notifyTask?.(applicationTaskEvent(currentId, task)),
    onCompleted: (agentId) => document.dispatchEvent(new CustomEvent("neuma:agent-artifacts-changed", { detail: { agentId } })) });
  function render() {
    const available = Boolean(current?.pageReady && current.manifest?.page);
    const appMode = available && mode === "application";
    const taskHost = appMode ? panel : fileTaskHost;
    if (taskPanel && taskHost && taskPanel.parentElement !== taskHost) taskHost.append(taskPanel);
    if (currentId && current?.actions?.length) tasks.start(currentId); else tasks.stop();
    const assistantAllowed = current?.assistant?.enabled !== false;
    const assistantVisible = appMode && assistantAllowed && assistant && !settingsOpen;
    floatingAssistant.show(assistantVisible);
    const conversation = byId("agent-conversation");
    conversation.inert = appMode && !assistantVisible;
    conversation.setAttribute("aria-hidden", String(conversation.inert));
    const actions = byId("agent-conversation-actions");
    const actionsHost = byId(assistantVisible ? "agent-assistant-actions" : "agent-chat-actions");
    if (actions.parentElement !== actionsHost) actionsHost.append(actions);
    byId("agent-view-switch").hidden = !available;
    byId("agent-assistant-toggle").hidden = !appMode || settingsOpen || !assistantAllowed;
    byId("agent-assistant-toggle").disabled = settingsOpen || !assistantAllowed;
    byId("agent-new-chat").hidden = appMode && !assistantVisible;
    byId("agent-assistant-toggle").setAttribute("aria-expanded", String(assistantVisible && floatingAssistant.isExpanded()));
    byId("agent-view-application").setAttribute("aria-pressed", String(mode === "application"));
    byId("agent-view-chat").setAttribute("aria-pressed", String(mode === "chat"));
    root.classList.toggle("has-application", available);
    root.classList.toggle("is-application", appMode);
    root.classList.toggle("application-assistant-open", assistantVisible);
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
    finishMaterialSelection();
    detachBridge?.(); detachBridge = null;
    const previous = instance; instance = null;
    if (previous) releaseApplicationContext(previous.agentId, previous.instanceId);
    frame?.remove(); frame = null;
    if (previous) void api.close(previous.agentId!, previous.instanceId, { keepalive }).catch(() => {});
    tasks.stop();
  }
  async function openResource() {
    if (!currentId || !current?.pageReady || !current.manifest?.page || instance || opening) return;
    const id = currentId, version = ++generation;
    opening = true;
    let opened: ApplicationInstance | null = null;
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
      activateApplicationContext(id, instance);
      frame = document.createElement("iframe"); frame.title = `${byId("agent-title").textContent}应用`;
      frame.className = "application-frame"; frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
      frame.setAttribute("referrerpolicy", "no-referrer");
      detachBridge = installApplicationHostBridge({ window, frame, instance, agentId: id, api, onTasks: tasks.refresh,
        onSettings: settings, onArtifacts: artifacts, selectMaterials,
        getContext: () => getApplicationActionContext(id),
        onAssistantContext: (snapshot) => snapshot === null ? clearApplicationContext(id, result.instanceId) : setApplicationContext(id, result.instanceId, snapshot),
        onAssistantOpen: () => {
          if (currentId !== id || version !== generation || settingsOpen || current?.assistant?.enabled === false) return { opened: false };
          assistant = true; floatingAssistant.expand(); render(); byId("agent-message").focus(); return { opened: true };
        } });
      frame.addEventListener("load", () => {
        if (currentId !== id || version !== generation) return;
        byId("agent-application-loading").hidden = true;
      });
      frame.src = result.url; byId("agent-application-frame-host").append(frame);
      tasks.start(id);
    } catch (caught) { const error = errorInfo(caught);
      if (opened && (!instance || instance.instanceId !== opened.instanceId)) void api.close(id, opened.instanceId).catch(() => {});
      if (currentId !== id || version !== generation) return;
      byId("agent-application-loading").textContent = error.message || "应用暂时无法打开。";
      byId("agent-application-retry").hidden = false;
    } finally { if (version === generation) opening = false; }
  }
  function finishMaterialSelection(operation = materialSelection, materials: Material[] = [], error?: unknown) {
    if (!operation || materialSelection !== operation) return;
    materialSelection = null;
    if (operation.shown && byId("application-material-dialog").open) byId("application-material-dialog").close!();
    if (error) operation.reject(error); else operation.resolve({ materials });
  }
  async function loadMaterialSelection(operation: MaterialSelection) {
    const dialog = byId("application-material-dialog"), list = byId("application-material-list");
    const result = await api.materials(operation.agentId);
    if (materialSelection !== operation || operation.agentId !== currentId
      || operation.generation !== generation || operation.instance !== instance) return;
    for (const material of result.attachments || result.materials || []) {
      const label = document.createElement("label"), checkbox = document.createElement("input"), title = document.createElement("span");
      label.className = "application-material-option"; checkbox.type = "checkbox"; title.textContent = material.name || "材料";
      checkbox.addEventListener("change", () => checkbox.checked ? operation.selected.set(material.id, material) : operation.selected.delete(material.id));
      label.append(checkbox, title); list.append(label);
    }
    if (!list.children.length) { const empty = document.createElement("p"); empty.textContent = "还没有材料，可从助手对话上传。"; list.append(empty); }
    dialog.showModal!();
    operation.shown = true;
  }
  function selectMaterials(id: string) {
    if (materialSelection) throw new Error("已有材料选择窗口打开。");
    return new Promise<{ materials: Material[] }>((resolve, reject) => {
      const operation = { agentId: id, generation, instance, selected: new Map<string, Material>(), shown: false, resolve, reject };
      materialSelection = operation;
      byId("application-material-list").replaceChildren();
      void loadMaterialSelection(operation).catch((error) => finishMaterialSelection(operation, [], error));
    });
  }
  for (const [id, selected] of [["agent-view-application", "application"], ["agent-view-chat", "chat"]] as const) byId(id).addEventListener("click", () => {
    mode = selected; try { storage?.setItem(`neuma.agent.application-mode.v1.${currentId}`, mode); } catch {}
    render(); if (mode === "application") void openResource(); else byId("agent-message").focus();
  });
  byId("agent-assistant-toggle").addEventListener("click", () => {
    if (settingsOpen || current?.assistant?.enabled === false) return;
    if (current?.assistant?.enabled === true) { assistant = true; floatingAssistant.toggle(); }
    else { assistant = !assistant; if (assistant) floatingAssistant.expand(); }
    render(); if (assistant) byId("agent-message").focus();
  });
  document.addEventListener("neuma:agent-message-started", (event) => {
    if (event.detail?.agentId !== currentId || !assistant) return;
    floatingAssistant.expand(); render();
  });
  document.addEventListener("neuma:agent-turn-finished", (event) => {
    if (event.detail?.agentId === currentId && current?.actions?.length) void tasks.refresh();
  });
  document.addEventListener("neuma:agent-settings-view", (event) => {
    if (!currentId || event.detail?.agentId !== currentId) return;
    settingsOpen = Boolean(event.detail.active); render();
  });
  byId("agent-application-configure").addEventListener("click", settings);
  byId("agent-application-retry").addEventListener("click", () => { closeResource(); void openResource(); });
  byId("application-material-confirm").addEventListener("click", () => {
    if (materialSelection?.shown) finishMaterialSelection(materialSelection, [...materialSelection.selected.values()]);
  });
  byId("application-material-close").addEventListener("click", () => finishMaterialSelection());
  byId("application-material-dialog").addEventListener("cancel", (event) => { event.preventDefault(); finishMaterialSelection(); });
  byId("application-material-dialog").addEventListener("close", () => {
    // Native close events may arrive after a new selection has already started.
    if (!byId("application-material-dialog").open && materialSelection?.shown) finishMaterialSelection();
  });
  return {
    route(id: string | null) {
      if (id !== currentId) { closeResource(); currentId = id; current = null; assistant = false; settingsOpen = false; mode = applicationMode(storage, id); floatingAssistant.select(id); }
      render();
    },
    update(id: string, application: ApplicationView | null | undefined) {
      if (id !== currentId) return;
      if (!current && application) { mode = applicationMode(storage, id, application.defaultEntry); assistant = application.assistant?.enabled === true; }
      else if (current?.assistant?.enabled !== application?.assistant?.enabled) assistant = application?.assistant?.enabled === true;
      if (current?.deliveryVersion !== application?.deliveryVersion || (instance || opening) && !application?.pageReady) closeResource();
      current = application ?? null; render();
      if (mode === "application") void openResource();
    },
    async refresh() { const id = currentId; if (id) { const result = await api.application(id); if (id === currentId) this.update(id, result); } },
    remove(id: string) { if (id === currentId) { closeResource(); current = null; settingsOpen = false; render(); } },
    close: closeResource,
  };
}

if (typeof document !== "undefined" && document.getElementById("agent-application")) {
  let storage; try { storage = window.localStorage; } catch {}
  const api = createApplicationApi(), checked = new Map();
  let routeId: string | null = null;
  const view = createApplicationWorkspace<HTMLElement>({ document, window, storage, api });
  document.addEventListener("neuma:route", (event) => {
    routeId = event.detail.page === "agent" ? event.detail!.agentId : null;
    view.route(routeId);
    document.dispatchEvent(new CustomEvent("neuma:agent-runtime-request", { detail: { agentId: event.detail!.agentId } }));
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
