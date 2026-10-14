const COLLAPSE_PAUSE_MS = 350, COLLAPSE_PULL_PX = 24;

export function initPanelResize({ layout, handle, variable, storageKey, label, defaultWidth, minWidth, maxWidth,
  getMax = () => maxWidth, isEnabled = () => true, isCollapsed = () => false, collapsedWidth = 0,
  collapse, expand, onRender, windowRef = window, storage,
  now = () => windowRef.performance.now(), watch = [] } = {}) {
  const noop = () => {};
  if (!layout?.getBoundingClientRect || !handle) return { refresh: noop, cancel: noop, dispose: noop };
  let preferredWidth = defaultWidth, renderedWidth = defaultWidth, limits, dragging = null, pointerY = null, disposed = false;
  try {
    storage ??= windowRef.localStorage;
    const stored = Number(storage?.getItem(storageKey));
    if (Number.isFinite(stored) && stored > 0) preferredWidth = Math.min(maxWidth, Math.max(minWidth, Math.round(stored)));
  } catch { /* Width adjustment remains usable without browser storage. */ }
  const clamp = (width) => Math.min(limits.max, Math.max(limits.min, width));
  const persist = () => { try { storage?.setItem(storageKey, String(preferredWidth)); } catch { /* Keep the preference in memory. */ } };
  const placeGrip = () => {
    if (pointerY === null) { handle.style.removeProperty("--panel-grip-y"); return; }
    const { top, height } = handle.getBoundingClientRect();
    if (!Number.isFinite(top) || !Number.isFinite(height) || height <= 0) return;
    const inset = Math.min(14, height / 2);
    handle.style.setProperty("--panel-grip-y", `${Math.min(height - inset, Math.max(inset, pointerY - top))}px`);
  };
  const followPointer = (event) => {
    if (disposed || !isEnabled() || event.isPrimary === false || !Number.isFinite(event.clientY)) return;
    pointerY = event.clientY; placeGrip();
  };
  const hover = (event) => { if (!dragging) followPointer(event); };
  const leave = () => { if (!dragging) { pointerY = null; placeGrip(); } };
  const focus = () => { if (!dragging && pointerY === null) placeGrip(); };
  const apply = () => {
    renderedWidth = clamp(preferredWidth);
    const closed = isCollapsed();
    const revealing = dragging?.phase === "revealing";
    const previewWidth = revealing ? Math.min(limits.max, Math.max(collapsedWidth, collapsedWidth + dragging.delta)) : null;
    const visibleWidth = revealing ? previewWidth : closed ? collapsedWidth : renderedWidth;
    const width = revealing ? previewWidth : renderedWidth;
    layout.style.setProperty(variable, `${width}px`); onRender?.(width);
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
    handle.setAttribute("aria-disabled", String(!enabled));
    if (!enabled) pointerY = null;
    apply(); placeGrip();
  };
  const down = (event) => {
    if (disposed || dragging || event.button !== 0 || event.isPrimary === false || !Number.isFinite(event.clientX)) return;
    refresh(); if (!isEnabled()) return;
    followPointer(event); event.preventDefault(); handle.focus({ preventScroll: true });
    const closed = isCollapsed();
    dragging = { id: event.pointerId, x: event.clientX, renderedWidth: closed ? collapsedWidth : renderedWidth,
      preferredWidth, minimum: !closed && renderedWidth <= limits.min ? { at: now(), x: event.clientX, pull: 0 } : null,
      delta: 0, startedCollapsed: closed, expectedCollapsed: closed,
      phase: closed ? "revealing" : "resizing", opened: false, changed: false };
    apply(); layout.classList.add(closed ? "is-panel-revealing" : "is-panel-resizing");
    try { handle.setPointerCapture?.(event.pointerId); } catch { /* Window listeners still finish the drag. */ }
  };
  const move = (event) => {
    if (!dragging || event.pointerId !== dragging.id || !Number.isFinite(event.clientX)) return;
    event.preventDefault(); followPointer(event);
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
      if (!dragging.minimum) dragging.minimum = { at: now(), x: event.clientX, pull: 0 };
      const leftward = dragging.minimum.x - event.clientX;
      dragging.minimum.x = event.clientX;
      // Movement during the pause never contributes to the deliberate pull to fold.
      if (now() - dragging.minimum.at >= COLLAPSE_PAUSE_MS) dragging.minimum.pull += Math.max(0, leftward);
      if (collapse && leftward > 0 && dragging.minimum.pull >= COLLAPSE_PULL_PX) {
        finish(false, false); collapse(); refresh(); return;
      }
      // Consume overshoot so moving right immediately widens from the boundary.
      dragging.x = event.clientX; dragging.renderedWidth = limits.min;
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
  const listeners = [[handle, "pointerenter", hover], [handle, "pointermove", hover],
    [handle, "pointerleave", leave], [handle, "focus", focus], [windowRef, "scroll", placeGrip, true],
    [handle, "pointerdown", down], [handle, "lostpointercapture", cancelPointer],
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
  for (const [target, name, listener, options] of listeners) target.addEventListener(name, listener, options);
  refresh();
  return { refresh, cancel, dispose: () => {
    if (disposed) return;
    cancel(); disposed = true; observer?.disconnect(); mutations?.disconnect();
    for (const [target, name, listener, options] of listeners) target.removeEventListener(name, listener, options);
  } };
}

export function initWorkspaceResize({ documentRef = document, windowRef = window } = {}) {
  const byId = (id) => documentRef.getElementById(id);
  const shell = byId("app-shell"), workspace = byId("main-workspace"), page = byId("page-chat");
  if (!shell || !workspace || !page) return;
  const watch = [shell, workspace, page];
  const agentWorkspace = byId("agent-workspace"), agentPage = byId("page-agent");
  const agentShell = byId("agent-page-shell"), agentPrimary = byId("agent-primary"), agentPanel = byId("agent-panel");
  const agentApplication = byId("agent-application");
  const groupPage = byId("page-group"), groupShell = byId("group-page-shell");
  const groupPrimary = byId("group-primary"), groupPanel = byId("group-panel");
  const collapsed = (root, name) => root.classList.contains(name);
  const contextWidth = () => collapsed(workspace, "context-open") ? 304 : 0;
  const paddingWidth = (root) => {
    const css = windowRef.getComputedStyle(root);
    return (Number.parseFloat(css.paddingLeft) || 0) + (Number.parseFloat(css.paddingRight) || 0);
  };
  const fold = (id) => { const toggle = byId(id); toggle.click(); toggle.focus({ preventScroll: true }); };
  const sidebar = initPanelResize({ layout: shell, handle: byId("sidebar-resize"), variable: "--sidebar",
    storageKey: "neuma.sidebar.width.v1", label: "主导航", defaultWidth: 232, minWidth: 175, maxWidth: 320,
    windowRef, watch: [...watch, agentPage, agentWorkspace, agentShell, agentPrimary, agentPanel, agentApplication,
      groupPage, groupShell, groupPrimary, groupPanel],
    isCollapsed: () => collapsed(shell, "sidebar-collapsed"), collapsedWidth: 72,
    getMax: () => {
      const width = shell.getBoundingClientRect().width;
      if (agentPage && agentWorkspace && !agentPage.hidden) {
        const settingsWidth = agentShell && agentPrimary ? Math.max(0,
          agentShell.getBoundingClientRect().width - agentPrimary.getBoundingClientRect().width) : 0;
        const application = collapsed(agentWorkspace, "is-application");
        const extra = application ? agentApplication ? Math.max(0,
          agentWorkspace.getBoundingClientRect().width - agentApplication.getBoundingClientRect().width) : 0
          : 0;
        return Math.max(175, width - paddingWidth(agentPage) - (agentPrimary ? paddingWidth(agentPrimary) : 0)
          - settingsWidth - extra - 364);
      }
      if (groupPage && groupShell && groupPrimary && !groupPage.hidden) {
        const settingsWidth = Math.max(0, groupShell.getBoundingClientRect().width - groupPrimary.getBoundingClientRect().width);
        return Math.max(175, width - paddingWidth(groupPage) - paddingWidth(groupPrimary) - settingsWidth - 364);
      }
      if (page.hidden) return Math.max(175, width - 640);
      return Math.max(175, width - paddingWidth(page) - contextWidth() - 364);
    }, collapse: () => fold("sidebar-toggle"), expand: () => byId("sidebar-toggle").click() });
  return { sidebar };
}

if (typeof document !== "undefined" && typeof window !== "undefined") initWorkspaceResize();
