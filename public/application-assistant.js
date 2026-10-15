const STORAGE_KEY = "neuma.agent.assistant-layout.v1.";
const MARGIN = 16, COMPACT = { width: 360, height: 64 }, EXPANDED = { width: 400, height: 440 };
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;

export function boundAssistantLayout(layout, bounds) {
  const maximumWidth = Math.max(1, bounds.width - MARGIN * 2), maximumHeight = Math.max(1, bounds.height - MARGIN * 2);
  const width = Math.min(maximumWidth, Math.max(320, finite(layout.width, COMPACT.width)));
  const height = Math.min(maximumHeight, layout.expanded ? Math.max(240, finite(layout.height, EXPANDED.height)) : COMPACT.height);
  return { ...layout, width, height,
    x: Math.min(Math.max(MARGIN, finite(layout.x, bounds.width - width - MARGIN)), Math.max(MARGIN, bounds.width - width - MARGIN)),
    y: Math.min(Math.max(MARGIN, finite(layout.y, bounds.height - height - MARGIN)), Math.max(MARGIN, bounds.height - height - MARGIN)) };
}

export function createApplicationAssistant({ document, window, root, storage }) {
  const byId = (id) => document.getElementById(id), conversation = byId("agent-conversation");
  const header = byId("agent-assistant-header"), move = byId("agent-assistant-move"), collapse = byId("agent-assistant-collapse");
  const shield = byId("agent-assistant-pointer-shield"), grip = byId("agent-assistant-resize-se");
  let agentId = null, visible = false, layout = { ...COMPACT, expanded: false }, expandedSize = { ...EXPANDED };
  let gesture = null, suppressClick = false, motionTimer = null;
  const bounds = () => { const box = root.getBoundingClientRect?.(); return { width: box?.width || 1000, height: box?.height || 700 }; };
  function save() {
    if (!agentId) return;
    try { storage?.setItem(`${STORAGE_KEY}${agentId}`, JSON.stringify({ ...layout, expandedSize })); } catch {}
  }
  function render() {
    const displayed = boundAssistantLayout(layout, bounds());
    root.classList.toggle("application-assistant-compact", visible && !layout.expanded);
    header.hidden = !visible;
    for (const direction of ["n", "e", "s", "w", "nw", "ne", "sw", "se"]) byId(`agent-assistant-resize-${direction}`).hidden = !visible;
    const label = layout.expanded ? "拖动助手；方向键移动，Shift 加方向键调整大小" : "展开助手；可拖动，方向键移动";
    move.setAttribute("aria-label", label); move.setAttribute("title", label);
    collapse.setAttribute("aria-expanded", String(layout.expanded));
    byId("agent-assistant-toggle").setAttribute("aria-expanded", String(visible && layout.expanded));
    grip.setAttribute("aria-label", `调整助手大小，当前 ${Math.round(displayed.width)} × ${Math.round(displayed.height)}；使用方向键`);
    byId("agent-assistant-title").textContent = byId("agent-title").textContent || "智能体助手";
    if (conversation.style?.setProperty) {
      for (const [name, value] of Object.entries({ x: displayed.x, y: displayed.y, width: displayed.width, height: displayed.height }))
        conversation.style.setProperty(`--assistant-${name}`, `${value}px`);
    }
  }
  function stopMotion() {
    if (motionTimer !== null) window.clearTimeout(motionTimer);
    motionTimer = null;
    root.classList.toggle("application-assistant-animating", false);
    root.classList.toggle("application-assistant-expanding", false);
  }
  function startMotion(expanded) {
    if (!visible || gesture || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { stopMotion(); return; }
    if (motionTimer !== null) window.clearTimeout(motionTimer);
    root.classList.toggle("application-assistant-animating", true);
    root.classList.toggle("application-assistant-expanding", expanded);
    // Commit the current frame before changing geometry; rapid reversals continue from it.
    conversation.getBoundingClientRect();
    motionTimer = window.setTimeout(stopMotion, 380);
  }
  function setExpanded(expanded, persist = true, animate = true) {
    if (expanded === layout.expanded) return;
    if (animate) startMotion(expanded); else stopMotion();
    layout = boundAssistantLayout(layout, bounds());
    const right = layout.x + layout.width, bottom = layout.y + layout.height;
    if (layout.expanded) expandedSize = { width: layout.width, height: layout.height };
    const size = expanded ? expandedSize : COMPACT;
    layout = { ...size, expanded, x: right - size.width, y: bottom - size.height };
    render();
    if (expanded && motionTimer !== null) {
      const composerHeight = byId("agent-chat-form").getBoundingClientRect().height;
      conversation.style.setProperty("--assistant-composer-space", `${composerHeight + 8}px`);
    }
    if (persist) save();
  }
  function syncAvatar() {
    const source = byId("agent-icon"), target = byId("agent-assistant-avatar");
    if (source.cloneNode) {
      const copy = source.cloneNode(true); copy.removeAttribute("id"); copy.removeAttribute("title");
      const star = copy.querySelector("[data-star-avatar]");
      if (star) { star.dataset.avatarMotion = "false"; star.dataset.activity = "idle"; }
      target.replaceChildren(copy);
    } else target.textContent = source.textContent;
    byId("agent-assistant-title").textContent = byId("agent-title").textContent || "智能体助手";
  }
  function finishGesture(event) {
    if (!gesture || (event?.pointerId !== undefined && event.pointerId !== gesture.pointerId)) return;
    suppressClick = gesture.moved;
    try { gesture.target.releasePointerCapture?.(gesture.pointerId); } catch {}
    gesture = null; shield.hidden = true; root.classList.toggle("application-assistant-dragging", false); save();
  }
  function startGesture(event, direction = null) {
    if (!visible || gesture || (event.button !== undefined && event.button !== 0)) return;
    if (!direction && event.target?.closest?.("button,input,textarea,a") && !event.target.closest("#agent-assistant-move")) return;
    event.preventDefault();
    stopMotion();
    if (direction) setExpanded(true, false, false);
    layout = boundAssistantLayout(layout, bounds());
    const target = !direction && event.target?.closest?.("#agent-assistant-move") ? move : event.currentTarget || move;
    gesture = { pointerId: event.pointerId, target, direction, startX: event.clientX, startY: event.clientY, layout: { ...layout }, moved: false };
    try { target.setPointerCapture?.(event.pointerId); } catch {}
    shield.hidden = false; root.classList.toggle("application-assistant-dragging", true);
  }
  function moveGesture(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const dx = event.clientX - gesture.startX, dy = event.clientY - gesture.startY, original = gesture.layout;
    gesture.moved ||= Math.abs(dx) + Math.abs(dy) > 3;
    if (!gesture.direction) layout = { ...original, x: original.x + dx, y: original.y + dy };
    else {
      const direction = gesture.direction;
      layout = { ...original,
        width: original.width + (direction.includes("e") ? dx : direction.includes("w") ? -dx : 0),
        height: original.height + (direction.includes("s") ? dy : direction.includes("n") ? -dy : 0) };
      layout = boundAssistantLayout(layout, bounds());
      if (direction.includes("w")) layout.x = original.x + original.width - layout.width;
      if (direction.includes("n")) layout.y = original.y + original.height - layout.height;
    }
    layout = boundAssistantLayout(layout, bounds()); render();
  }
  function keyboard(event, resizing) {
    const delta = { ArrowLeft: [-8, 0], ArrowRight: [8, 0], ArrowUp: [0, -8], ArrowDown: [0, 8] }[event.key];
    if (!visible || !delta) return;
    event.preventDefault();
    stopMotion();
    layout = boundAssistantLayout(layout, bounds());
    if (resizing || event.shiftKey) {
      setExpanded(true, false, false); layout.width += delta[0]; layout.height += delta[1];
    } else { layout.x += delta[0]; layout.y += delta[1]; }
    layout = boundAssistantLayout(layout, bounds()); render(); save();
  }
  header.addEventListener("pointerdown", (event) => startGesture(event));
  for (const direction of ["n", "e", "s", "w", "nw", "ne", "sw", "se"])
    byId(`agent-assistant-resize-${direction}`).addEventListener("pointerdown", (event) => startGesture(event, direction));
  window.addEventListener("pointermove", moveGesture);
  window.addEventListener("pointerup", finishGesture);
  window.addEventListener("pointercancel", finishGesture);
  window.addEventListener("blur", () => finishGesture());
  move.addEventListener("keydown", (event) => keyboard(event, false));
  grip.addEventListener("keydown", (event) => keyboard(event, true));
  move.addEventListener("click", () => {
    if (suppressClick) { suppressClick = false; return; }
    setExpanded(true); byId("agent-message").focus();
  });
  collapse.addEventListener("click", () => { setExpanded(false); byId("agent-message").focus(); });
  byId("agent-assistant-reset").addEventListener("click", () => {
    stopMotion();
    expandedSize = { ...EXPANDED }; layout = { ...(layout.expanded ? EXPANDED : COMPACT), expanded: layout.expanded };
    render(); save();
  });
  const resizeObserver = window.ResizeObserver ? new window.ResizeObserver(() => { if (visible && !gesture) { stopMotion(); render(); } }) : null;
  resizeObserver?.observe(root);
  const avatarObserver = window.MutationObserver ? new window.MutationObserver(syncAvatar) : null;
  avatarObserver?.observe(byId("agent-icon"), { childList: true, attributes: true, attributeFilter: ["data-avatar-key"] });
  window.addEventListener("resize", () => { if (visible && !gesture) { stopMotion(); render(); } });
  return {
    select(id) {
      if (id === agentId) return;
      finishGesture(); stopMotion(); suppressClick = false; agentId = id; expandedSize = { ...EXPANDED }; layout = { ...COMPACT, expanded: false };
      try {
        const saved = JSON.parse(storage?.getItem(`${STORAGE_KEY}${id}`) || "null");
        if (saved && typeof saved === "object") {
          layout = { x: saved.x, y: saved.y, width: saved.width, height: saved.height, expanded: saved.expanded === true };
          expandedSize = { width: finite(saved.expandedSize?.width, EXPANDED.width), height: finite(saved.expandedSize?.height, EXPANDED.height) };
        }
      } catch {}
      syncAvatar(); render();
    },
    show(active) { visible = active; if (!active) { finishGesture(); stopMotion(); } render(); },
    expand() { setExpanded(true); },
    toggle() { setExpanded(!layout.expanded); },
    isExpanded: () => layout.expanded,
    layout: () => boundAssistantLayout(layout, bounds()),
    close() { finishGesture(); stopMotion(); resizeObserver?.disconnect(); avatarObserver?.disconnect(); },
  };
}
