export interface MotionStyled {style:{transform:string}}
export interface MotionAvatar {dataset:{activity?:string|undefined;shape?:string|undefined};isConnected:boolean;getBoundingClientRect():{left:number;top:number;width:number;height:number};querySelector(selector:string):unknown}
export interface MotionScope {querySelectorAll(selector:string):Iterable<MotionAvatar>}
type PointerMove=Pick<PointerEvent,"pointerType"|"clientX"|"clientY">;
type PointerOut=Pick<PointerEvent,"relatedTarget">;
interface MotionEvents {
  addEventListener(type:"pointermove",listener:(event:PointerMove)=>void,options?:{passive:boolean}):unknown;
  addEventListener(type:"pointerout",listener:(event:PointerOut)=>void,options?:{passive:boolean}):unknown;
  addEventListener(type:string,listener:()=>void,options?:boolean):unknown;
  removeEventListener(type:"pointermove",listener:(event:PointerMove)=>void):unknown;
  removeEventListener(type:"pointerout",listener:(event:PointerOut)=>void):unknown;
  removeEventListener(type:string,listener:()=>void,options?:boolean):unknown;
}
export interface MotionDocument<Root> extends MotionEvents,MotionScope {hidden:boolean;documentElement:Root;querySelector(selector:string):MotionScope|null}
export interface MotionMutation {attributeName:string|null;target:unknown}
export interface MotionWindow<Root> {matchMedia(query:string):{matches:boolean;addEventListener(type:string,listener:()=>void):unknown;removeEventListener(type:string,listener:()=>void):unknown};requestAnimationFrame(callback:(time:number)=>void):number;cancelAnimationFrame(id:number):unknown;addEventListener(type:string,listener:()=>void):unknown;removeEventListener(type:string,listener:()=>void):unknown;MutationObserver?:new(callback:(records:MotionMutation[])=>void)=>{observe(target:Root,options:MutationObserverInit):unknown;disconnect():unknown}}
type AvatarPose = { x: number; y: number; rx: number; ry: number; rz: number; scale: number; cx: number; cy: number; cr: number; sx: number; sy: number; sxy: number };
interface AvatarMotionState { element:MotionAvatar;world:MotionStyled;core:MotionStyled;shell:MotionStyled; pose: AvatarPose; target: AvatarPose; velocity: AvatarPose }
const installed = new WeakMap<object,()=>void>();
const fields = ["x", "y", "rx", "ry", "rz", "scale", "cx", "cy", "cr", "sx", "sy", "sxy"] as const;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const isBusy = (element:Pick<MotionAvatar,"dataset">) => ["thinking", "working", "queued"].includes(element.dataset.activity ?? "");
export const restingAvatarPose = (): AvatarPose => ({ x: 0, y: 0, rx: 0, ry: 0, rz: 0, scale: 1, cx: 0, cy: 0, cr: 0, sx: 1, sy: 1, sxy: 0 });
const restingAvatarVelocity = (): AvatarPose => ({ ...restingAvatarPose(), scale: 0, sx: 0, sy: 0 });

export function avatarPointerPose({ dx, dy, size, shape }: { dx: number; dy: number; size: number; shape?: string | undefined }) {
  if (![dx, dy, size].every(Number.isFinite) || size <= 0) return restingAvatarPose();
  const large = size >= 80, radius = large ? 170 : 72;
  const proximity = Math.pow(clamp(1 - Math.max(0, Math.hypot(dx, dy) - size * .42) / radius, 0, 1), 1.4);
  if (!proximity) return restingAvatarPose();
  const distance = Math.hypot(dx, dy), pull = Math.min(distance / (size * .7), 1) * proximity;
  const ux = distance ? dx / distance : 0, uy = distance ? dy / distance : 0;
  const nx = ux * pull, ny = uy * pull, tilt = large ? 14 : 10;
  const coreTravel = ["shield", "diamond"].includes(shape ?? "") ? .045 : .055;
  const stretch = (large ? .16 : .12) * pull, squeeze = .065 * pull;
  return { x: nx * size * .025, y: ny * size * .025, rx: -ny * tilt, ry: nx * tilt,
    rz: nx * 7, scale: 1 + .018 * proximity,
    cx: nx * size * coreTravel, cy: ny * size * coreTravel, cr: nx * 62 + ny * 28,
    // Stretch along the pointer direction and compress across it, including diagonals.
    sx: 1 + stretch * ux * ux - squeeze * uy * uy,
    sy: 1 + stretch * uy * uy - squeeze * ux * ux, sxy: (stretch + squeeze) * ux * uy };
}

export function advanceAvatarPose(current: AvatarPose, target: AvatarPose, elapsed: number, velocity = restingAvatarVelocity()) {
  const seconds = clamp(Number.isFinite(elapsed) ? elapsed : 16, 0, 40) / 1000;
  const frequency = 20, damping = .72, decay = Math.exp(-damping * frequency * seconds);
  const oscillation = frequency * Math.sqrt(1 - damping * damping);
  const cosine = Math.cos(oscillation * seconds), sine = Math.sin(oscillation * seconds);
  const pose = {} as AvatarPose, nextVelocity = {} as AvatarPose;
  let moving = false;
  for (const key of fields) {
    const offset = current[key] - target[key], speed = velocity[key];
    const nextOffset = decay * (offset * cosine + (speed + damping * frequency * offset) / oscillation * sine);
    const nextSpeed = decay * (speed * cosine - (damping * frequency * speed + frequency * frequency * offset) / oscillation * sine);
    const epsilon = ["scale", "sx", "sy", "sxy"].includes(key) ? .0001 : .005;
    const settled = Math.abs(nextOffset) <= epsilon && Math.abs(nextSpeed) <= epsilon * frequency;
    pose[key] = settled ? target[key] : target[key] + nextOffset;
    nextVelocity[key] = settled ? 0 : nextSpeed;
    moving ||= !settled;
  }
  return { pose, velocity: nextVelocity, moving };
}

export function installAvatarMotion<Root>(documentRef:MotionDocument<Root>,windowRef:MotionWindow<Root>) {
  if (installed.has(documentRef)) return installed.get(documentRef);
  if (!documentRef?.querySelectorAll || !windowRef?.requestAnimationFrame || !windowRef?.matchMedia) return () => {};
  const reduce = windowRef.matchMedia("(prefers-reduced-motion: reduce)");
  const states = new Map<MotionAvatar,AvatarMotionState>();
  let pointer: { x: number; y: number } | null = null, dirty = false, frame = 0, lastTime = 0;

  function paint(state: AvatarMotionState) {
    const p = state.pose;
    state.world.style.transform = `translate3d(${p.x.toFixed(3)}px, ${p.y.toFixed(3)}px, 0) rotateX(${p.rx.toFixed(3)}deg) rotateY(${p.ry.toFixed(3)}deg) rotateZ(${p.rz.toFixed(3)}deg) scale(${p.scale.toFixed(5)})`;
    state.core.style.transform = `translate3d(${p.cx.toFixed(3)}px, ${p.cy.toFixed(3)}px, 4px) rotate(${p.cr.toFixed(3)}deg)`;
    state.shell.style.transform = `matrix(${p.sx.toFixed(5)}, ${p.sxy.toFixed(5)}, ${p.sxy.toFixed(5)}, ${p.sy.toFixed(5)}, 0, 0)`;
  }

  function updateTargets() {
    for (const state of states.values()) state.target = restingAvatarPose();
    if (!pointer || reduce.matches) return;
    const scope = documentRef.querySelector("dialog[open]") || documentRef;
    for (const element of scope.querySelectorAll('[data-star-avatar][data-avatar-motion="true"]')) {
      if (isBusy(element)) continue;
      const bounds = element.getBoundingClientRect();
      if (!bounds.width || !bounds.height) continue;
      const target = avatarPointerPose({ dx: pointer.x - bounds.left - bounds.width / 2,
        dy: pointer.y - bounds.top - bounds.height / 2, size: bounds.width, shape: element.dataset.shape });
      if (target.scale === 1) continue;
      let state = states.get(element);
      if (!state) {
        state = { element, world: element.querySelector(".star-avatar-world") as MotionStyled, core: element.querySelector(".star-avatar-core") as MotionStyled,
          shell: element.querySelector(".star-avatar-shell") as MotionStyled, pose: restingAvatarPose(), target, velocity: restingAvatarVelocity() };
        states.set(element, state);
      }
      state.target = target;
    }
  }

  function tick(time: number) {
    frame = 0;
    if (dirty) { dirty = false; updateTargets(); }
    const elapsed = lastTime ? time - lastTime : 16;
    lastTime = time;
    let moving = false;
    for (const [element, state] of states) {
      if (isBusy(element) || !element.isConnected || !element.getBoundingClientRect().width) {
        state.pose = restingAvatarPose(); paint(state); states.delete(element); continue;
      }
      const next = reduce.matches ? { pose: restingAvatarPose(), velocity: restingAvatarVelocity(), moving: false }
        : advanceAvatarPose(state.pose, state.target, elapsed, state.velocity);
      state.pose = next.pose; state.velocity = next.velocity; moving ||= next.moving;
      paint(state);
      if (!next.moving && state.target.scale === 1) states.delete(element);
    }
    if (moving) frame = windowRef.requestAnimationFrame(tick);
    else lastTime = 0;
  }

  function wake() { if (!frame) frame = windowRef.requestAnimationFrame(tick); }
  function reset() { pointer = null; dirty = true; if (states.size) wake(); }
  function onPointerMove(event: PointerMove) {
    if (event.pointerType === "touch" || reduce.matches) return;
    pointer = { x: event.clientX, y: event.clientY }; dirty = true; wake();
  }
  function onPointerOut(event: PointerOut) { if (!event.relatedTarget) reset(); }
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
    if (records.some((record) => record.attributeName === "open" && (record.target as {tagName:string}).tagName === "DIALOG"
      || record.attributeName === "hidden" && [...states.keys()].some((element) => (record.target as {contains(element:MotionAvatar):boolean}).contains(element)))) stop();
    for (const record of records) {
      if (record.attributeName !== "data-activity" || !isBusy(record.target as MotionAvatar)) continue;
      const state = states.get(record.target as MotionAvatar);
      if (state) { state.pose = restingAvatarPose(); paint(state); states.delete(record.target as MotionAvatar); }
    }
  }) : null;
  observer?.observe(documentRef.documentElement, { subtree: true, attributes: true, attributeFilter: ["open", "hidden", "data-activity"] });
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
