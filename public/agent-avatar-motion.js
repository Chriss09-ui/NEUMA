const installed = new WeakMap();
const fields = ["x", "y", "rx", "ry", "rz", "scale", "cx", "cy"];
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const restingAvatarPose = () => ({ x: 0, y: 0, rx: 0, ry: 0, rz: 0, scale: 1, cx: 0, cy: 0 });

export function avatarPointerPose({ dx, dy, size, shape }) {
  if (![dx, dy, size].every(Number.isFinite) || size <= 0) return restingAvatarPose();
  const large = size >= 80, radius = large ? 170 : 72;
  const proximity = Math.pow(clamp(1 - Math.max(0, Math.hypot(dx, dy) - size * .42) / radius, 0, 1), 1.4);
  if (!proximity) return restingAvatarPose();
  const nx = clamp(dx / (size * .75), -1, 1) * proximity;
  const ny = clamp(dy / (size * .75), -1, 1) * proximity;
  const tilt = large ? 9 : 4.5;
  const coreTravel = ["shield", "diamond"].includes(shape) ? .018 : .02;
  return { x: nx * size * .015, y: ny * size * .015, rx: -ny * tilt, ry: nx * tilt,
    rz: nx * tilt * .3, scale: 1 + (large ? .035 : .025) * proximity,
    cx: nx * size * coreTravel, cy: ny * size * coreTravel };
}

export function advanceAvatarPose(current, target, elapsed) {
  const amount = 1 - Math.exp(-clamp(Number.isFinite(elapsed) ? elapsed : 16, 0, 40) / 105);
  const pose = {}, moving = fields.some((key) => Math.abs(target[key] - current[key]) > (key === "scale" ? .0001 : .005));
  for (const key of fields) {
    const delta = target[key] - current[key];
    pose[key] = Math.abs(delta) > (key === "scale" ? .0001 : .005) ? current[key] + delta * amount : target[key];
  }
  return { pose, moving };
}

export function installAvatarMotion(documentRef, windowRef) {
  if (installed.has(documentRef)) return installed.get(documentRef);
  if (!documentRef?.querySelectorAll || !windowRef?.requestAnimationFrame || !windowRef?.matchMedia) return () => {};
  const reduce = windowRef.matchMedia("(prefers-reduced-motion: reduce)");
  const states = new Map();
  let pointer = null, dirty = false, frame = 0, lastTime = 0;

  function paint(state) {
    const p = state.pose;
    state.world.style.transform = `translate3d(${p.x.toFixed(3)}px, ${p.y.toFixed(3)}px, 0) rotateX(${p.rx.toFixed(3)}deg) rotateY(${p.ry.toFixed(3)}deg) rotateZ(${p.rz.toFixed(3)}deg) scale(${p.scale.toFixed(5)})`;
    state.core.style.transform = `translate3d(${p.cx.toFixed(3)}px, ${p.cy.toFixed(3)}px, 4px)`;
  }

  function updateTargets() {
    for (const state of states.values()) state.target = restingAvatarPose();
    if (!pointer || reduce.matches) return;
    const scope = documentRef.querySelector("dialog[open]") || documentRef;
    for (const element of scope.querySelectorAll('[data-star-avatar][data-avatar-motion="true"]')) {
      const bounds = element.getBoundingClientRect();
      if (!bounds.width || !bounds.height) continue;
      const target = avatarPointerPose({ dx: pointer.x - bounds.left - bounds.width / 2,
        dy: pointer.y - bounds.top - bounds.height / 2, size: bounds.width, shape: element.dataset.shape });
      if (target.scale === 1) continue;
      let state = states.get(element);
      if (!state) {
        state = { element, world: element.querySelector(".star-avatar-world"), core: element.querySelector(".star-avatar-core"),
          pose: restingAvatarPose(), target };
        states.set(element, state);
      }
      state.target = target;
    }
  }

  function tick(time) {
    frame = 0;
    if (dirty) { dirty = false; updateTargets(); }
    const elapsed = lastTime ? time - lastTime : 16;
    lastTime = time;
    let moving = false;
    for (const [element, state] of states) {
      if (!element.isConnected || !element.getBoundingClientRect().width) {
        state.pose = restingAvatarPose(); paint(state); states.delete(element); continue;
      }
      const next = reduce.matches ? { pose: restingAvatarPose(), moving: false } : advanceAvatarPose(state.pose, state.target, elapsed);
      state.pose = next.pose; moving ||= next.moving;
      paint(state);
      if (!next.moving && state.target.scale === 1) states.delete(element);
    }
    if (moving) frame = windowRef.requestAnimationFrame(tick);
    else lastTime = 0;
  }

  function wake() { if (!frame) frame = windowRef.requestAnimationFrame(tick); }
  function reset() { pointer = null; dirty = true; if (states.size) wake(); }
  function onPointerMove(event) {
    if (event.pointerType === "touch" || reduce.matches) return;
    pointer = { x: event.clientX, y: event.clientY }; dirty = true; wake();
  }
  function onPointerOut(event) { if (!event.relatedTarget) reset(); }
  function stop() {
    if (frame) windowRef.cancelAnimationFrame(frame);
    frame = 0; lastTime = 0; pointer = null; dirty = false;
    for (const state of states.values()) { state.pose = restingAvatarPose(); paint(state); }
    states.clear();
  }
  function onVisibility() { if (documentRef.hidden) stop(); }
  function onMotionChange() { stop(); }
  function onResize() { dirty = true; if (pointer || states.size) wake(); }
  // A dialog or hidden parent can change while the pointer and animation are idle.
  const observer = windowRef.MutationObserver ? new windowRef.MutationObserver((records) => {
    if (records.some((record) => record.attributeName === "open" && record.target.tagName === "DIALOG"
      || record.attributeName === "hidden" && [...states.keys()].some((element) => record.target.contains(element)))) stop();
  }) : null;
  observer?.observe(documentRef.documentElement, { subtree: true, attributes: true, attributeFilter: ["open", "hidden"] });
  documentRef.addEventListener("pointermove", onPointerMove, { passive: true });
  documentRef.addEventListener("pointerout", onPointerOut, { passive: true });
  documentRef.addEventListener("pointercancel", reset);
  documentRef.addEventListener("scroll", reset, true);
  documentRef.addEventListener("visibilitychange", onVisibility);
  documentRef.addEventListener("neuma:route", stop);
  windowRef.addEventListener("blur", reset);
  windowRef.addEventListener("resize", onResize);
  reduce.addEventListener("change", onMotionChange);
  const dispose = () => {
    stop(); installed.delete(documentRef);
    observer?.disconnect();
    documentRef.removeEventListener("pointermove", onPointerMove);
    documentRef.removeEventListener("pointerout", onPointerOut);
    documentRef.removeEventListener("pointercancel", reset);
    documentRef.removeEventListener("scroll", reset, true);
    documentRef.removeEventListener("visibilitychange", onVisibility);
    documentRef.removeEventListener("neuma:route", stop);
    windowRef.removeEventListener("blur", reset);
    windowRef.removeEventListener("resize", onResize);
    reduce.removeEventListener("change", onMotionChange);
  };
  installed.set(documentRef, dispose);
  return dispose;
}
