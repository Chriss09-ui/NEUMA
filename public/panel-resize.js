export function initPanelResize({ layout, handle, variable, storageKey, label, defaultWidth, minWidth, maxWidth,
  getMax = () => maxWidth, isEnabled = () => true, isCollapsed = () => false, collapsedWidth = 0,
  collapse, expand, windowRef = window, storage,
  now = () => windowRef.performance.now(), watch = [] } = {}) {
  const noop = () => {};
  if (!layout?.getBoundingClientRect || !handle) return { refresh: noop, cancel: noop, dispose: noop };
  let preferredWidth = defaultWidth, renderedWidth = defaultWidth, limits, dragging = null, disposed = false;
  try {
    storage ??= windowRef.localStorage;
    const stored = Number(storage?.getItem(storageKey));
    if (Number.isFinite(stored) && stored > 0) preferredWidth = Math.min(maxWidth, Math.max(minWidth, Math.round(stored)));
  } catch { /* Width adjustment remains usable without browser storage. */ }
  const clamp = (width) => Math.min(limits.max, Math.max(limits.min, width));
  const persist = () => { try { storage?.setItem(storageKey, String(preferredWidth)); } catch { /* Keep the preference in memory. */ } };
  const apply = () => {
    renderedWidth = clamp(preferredWidth);
    const closed = isCollapsed();
    const revealing = dragging?.phase === "revealing";
    const previewWidth = revealing ? Math.min(limits.max, Math.max(collapsedWidth, collapsedWidth + dragging.delta)) : null;
    const visibleWidth = revealing ? previewWidth : closed ? collapsedWidth : renderedWidth;
    layout.style.setProperty(variable, `${revealing ? previewWidth : renderedWidth}px`);
    handle.setAttribute("aria-valuemin", String(closed ? collapsedWidth : limits.min));
    handle.setAttribute("aria-valuemax", String(limits.max));
    handle.setAttribute("aria-valuenow", String(visibleWidth));
    handle.setAttribute("aria-valuetext", closed && !revealing ? `${label}已折叠，向右拖动展开` : `${label} ${visibleWidth} 像素`);
  };
  const finish = (commit = false, restoreFold = true) => {
    if (!dragging) return;
    const previous = dragging; dragging = null;
    const openOnRelease = commit && previous.phase === "revealing" && previous.delta >= 32;
    if (!commit || !previous.changed) preferredWidth = previous.preferredWidth;
    layout.classList.remove("is-panel-resizing", "is-panel-revealing"); handle.classList.remove("at-minimum");
    try { if (handle.hasPointerCapture?.(previous.id)) handle.releasePointerCapture(previous.id); } catch { /* Capture may already be released. */ }
    if (!commit && restoreFold && isEnabled() && previous.opened && !isCollapsed()) collapse?.();
    if (openOnRelease && isEnabled() && isCollapsed()) expand?.();
    apply(); if (commit && previous.changed) persist();
  };
  const refresh = () => {
    if (disposed) return;
    const available = getMax();
    const max = Number.isFinite(available) ? Math.max(1, Math.min(maxWidth, Math.floor(available))) : maxWidth;
    limits = { min: Math.min(minWidth, max), max };
    const enabled = isEnabled();
    if (!enabled || (dragging && dragging.expectedCollapsed !== isCollapsed())) finish(false, false);
    handle.inert = !enabled; handle.tabIndex = enabled ? 0 : -1;
    handle.setAttribute("aria-hidden", String(!enabled));
    handle.setAttribute("aria-disabled", String(!enabled)); apply();
  };
  const down = (event) => {
    if (disposed || dragging || event.button !== 0 || event.isPrimary === false || !Number.isFinite(event.clientX)) return;
    refresh(); if (!isEnabled()) return;
    event.preventDefault(); handle.focus({ preventScroll: true });
    const closed = isCollapsed();
    dragging = { id: event.pointerId, x: event.clientX, renderedWidth: closed ? collapsedWidth : renderedWidth,
      preferredWidth, minimum: null, delta: 0, startedCollapsed: closed, expectedCollapsed: closed,
      phase: closed ? "revealing" : "resizing", opened: false, changed: false };
    apply(); layout.classList.add(closed ? "is-panel-revealing" : "is-panel-resizing");
    try { handle.setPointerCapture?.(event.pointerId); } catch { /* Window listeners still finish the drag. */ }
  };
  const move = (event) => {
    if (!dragging || event.pointerId !== dragging.id || !Number.isFinite(event.clientX)) return;
    event.preventDefault();
    dragging.delta = event.clientX - dragging.x;
    const rawWidth = dragging.renderedWidth + dragging.delta;
    if (dragging.phase === "revealing") {
      if (!expand || rawWidth < limits.min) { apply(); return; }
      dragging.phase = "resizing"; dragging.opened = true; dragging.expectedCollapsed = false;
      preferredWidth = clamp(Math.round(rawWidth)); apply();
      layout.classList.remove("is-panel-revealing"); layout.classList.add("is-panel-resizing");
      expand(); refresh(); handle.focus({ preventScroll: true });
    }
    dragging.changed ||= dragging.startedCollapsed ? rawWidth > limits.min : dragging.delta !== 0;
    if (rawWidth <= limits.min) {
      if (!dragging.minimum) dragging.minimum = { at: now(), x: event.clientX };
      const continuingLeft = event.clientX < dragging.minimum.x;
      dragging.minimum.x = event.clientX;
      const beyondLimit = limits.min - rawWidth;
      // Crossing the limit once never collapses; a later deliberate pull does.
      if (collapse && continuingLeft && now() - dragging.minimum.at >= 180 && beyondLimit >= 32) {
        finish(false, false); collapse(); refresh(); return;
      }
    } else dragging.minimum = null;
    handle.classList.toggle("at-minimum", rawWidth <= limits.min);
    preferredWidth = clamp(Math.round(rawWidth)); apply();
  };
  const up = (event) => { if (dragging && event.pointerId === dragging.id) finish(true); };
  const cancelPointer = (event) => { if (dragging && event.pointerId === dragging.id) finish(false); };
  const cancel = () => finish(false);
  const keyboard = (event) => {
    if (event.key === "Escape" && dragging) { event.preventDefault(); cancel(); return; }
    if (disposed || dragging || !isEnabled() || !["ArrowLeft", "ArrowRight", "Home", "End", "Enter", " "].includes(event.key)) return;
    refresh(); event.preventDefault();
    if (isCollapsed()) {
      if (!expand || !["ArrowRight", "End", "Enter", " "].includes(event.key)) return;
      expand(); refresh(); handle.focus({ preventScroll: true });
      if (event.key !== "End") return;
    }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const step = event.shiftKey ? 48 : 16;
    preferredWidth = event.key === "Home" ? limits.min : event.key === "End" ? limits.max
      : clamp(renderedWidth + (event.key === "ArrowRight" ? step : -step));
    apply(); persist();
  };
  const reset = () => {
    if (disposed || !isEnabled()) return;
    cancel(); if (isCollapsed()) expand?.();
    preferredWidth = defaultWidth; refresh(); persist(); handle.focus({ preventScroll: true });
  };
  handle.setAttribute("role", "separator"); handle.setAttribute("aria-orientation", "vertical");
  const listeners = [[handle, "pointerdown", down], [handle, "lostpointercapture", cancelPointer],
    [handle, "keydown", keyboard], [handle, "dblclick", reset], [windowRef, "pointermove", move],
    [windowRef, "pointerup", up], [windowRef, "pointercancel", cancelPointer], [windowRef, "blur", cancel]];
  const targets = [...new Set([layout, ...watch].filter(Boolean))];
  const Observer = windowRef.ResizeObserver;
  const observer = typeof Observer === "function" ? new Observer(refresh) : null;
  if (observer) for (const target of targets) observer.observe(target);
  else listeners.push([windowRef, "resize", refresh]);
  const Mutation = windowRef.MutationObserver;
  const mutations = typeof Mutation === "function" ? new Mutation(refresh) : null;
  for (const target of targets) mutations?.observe(target, { attributes: true, attributeFilter: ["class", "hidden"] });
  for (const [target, name, listener] of listeners) target.addEventListener(name, listener);
  refresh();
  return { refresh, cancel, dispose: () => {
    if (disposed) return;
    cancel(); disposed = true; observer?.disconnect(); mutations?.disconnect();
    for (const [target, name, listener] of listeners) target.removeEventListener(name, listener);
  } };
}

export function initWorkspaceResize({ documentRef = document, windowRef = window } = {}) {
  const byId = (id) => documentRef.getElementById(id);
  const shell = byId("app-shell"), workspace = byId("main-workspace"), page = byId("page-chat");
  if (!shell || !workspace || !page) return;
  const history = byId("main-history"), watch = [shell, workspace, page, history];
  const collapsed = (root, name) => root.classList.contains(name);
  const contextWidth = () => collapsed(workspace, "context-open") ? 324 : 0;
  const fold = (id) => { const toggle = byId(id); toggle.click(); toggle.focus({ preventScroll: true }); };
  const sidebar = initPanelResize({ layout: shell, handle: byId("sidebar-resize"), variable: "--sidebar",
    storageKey: "neuma.sidebar.width.v1", label: "主导航", defaultWidth: 232, minWidth: 200, maxWidth: 320,
    windowRef, watch, isCollapsed: () => collapsed(shell, "sidebar-collapsed"), collapsedWidth: 72,
    getMax: () => {
      const width = shell.getBoundingClientRect().width;
      if (page.hidden) return Math.max(200, width - 640);
      const css = windowRef.getComputedStyle(page);
      const padding = (Number.parseFloat(css.paddingLeft) || 0) + (Number.parseFloat(css.paddingRight) || 0);
      // Reserve the open history minimum so pulling it out never shifts its origin.
      return Math.max(200, width - padding - 160 - contextWidth() - 388);
    }, collapse: () => fold("sidebar-toggle"), expand: () => byId("sidebar-toggle").click() });
  const historyPanel = initPanelResize({ layout: workspace, handle: byId("main-history-resize"), variable: "--main-history-width",
    storageKey: "neuma.main.history-width.v1", label: "历史对话", defaultWidth: 208, minWidth: 160, maxWidth: 360,
    windowRef, watch, isEnabled: () => !page.hidden,
    isCollapsed: () => collapsed(workspace, "history-collapsed"), collapsedWidth: 40,
    getMax: () => Math.max(160, workspace.getBoundingClientRect().width - contextWidth() - 388),
    collapse: () => fold("main-history-toggle"), expand: () => byId("main-history-toggle").click() });
  return { sidebar, history: historyPanel };
}

if (typeof document !== "undefined" && typeof window !== "undefined") initWorkspaceResize();
