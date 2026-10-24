export interface SidebarMotionRect { top: number; bottom: number; left: number; right: number; width: number; height: number }
export interface SidebarMotionAnimation { finished: Promise<unknown>; cancel(): unknown }
export interface SidebarMotionElement {
  style: object; dataset: Record<string, string | undefined>; scrollTop: number; inert?: boolean; firstElementChild: unknown;
  classList: { add(...names: string[]): unknown; remove(...names: string[]): unknown; toggle(name: string, force?: boolean): unknown; contains(name: string): boolean };
  getBoundingClientRect(): SidebarMotionRect; cloneNode(deep: boolean): unknown; remove(): unknown; append(child: unknown): unknown;
  querySelector(selector: string): unknown; querySelectorAll(selector: string): Iterable<unknown>; closest(selector: string): unknown;
  getAttribute(name: string): string | null | undefined; setAttribute(name: string, value: string): unknown;
  animate?(frames: { transform: string }[], options: { duration: number; easing: string; fill: "forwards" }): SidebarMotionAnimation;
  addEventListener(name: string, listener: () => void): unknown;
}
interface MotionDocument<E> { getElementById(id: string): E | null; body: E; createElement?: unknown; addEventListener(name: string, listener: () => void): unknown }
interface MotionWindow<E> { innerWidth: number; innerHeight: number; getComputedStyle(element: E): { visibility: string }; addEventListener(name: string, listener: () => void): unknown }
interface MotionPreference { matches: boolean; addEventListener(name: string, listener: () => void): unknown }
interface AvatarFlight<E> { element: E; animation: SidebarMotionAnimation | null; hidden: Set<E> }
interface ClipBounds { top: number; bottom: number; left: number; right: number }
const expanded = "#sidebar-agent-list .sidebar-history-link, #sidebar-group-list .sidebar-history-link";
const compact = "#sidebar-agent-rail a, #sidebar-group-rail a";
const regions = ["sidebar-agent-list", "sidebar-group-list", "sidebar-agent-rail", "sidebar-group-rail"];
const regionSelector = regions.map((id) => `#${id}`).join(", ");
const easing = "cubic-bezier(.22, 1, .36, 1)";

export function createSidebarAvatarMotion<E extends SidebarMotionElement = HTMLElement>({ document, window, reducedMotion, duration = 320 }: { document: MotionDocument<E>; window: MotionWindow<NoInfer<E>>; reducedMotion?: MotionPreference | undefined; duration?: number | undefined }) {
  const shell = document.getElementById("app-shell"), sidebar = shell?.querySelector(".sidebar") as E | null | undefined;
  const scroll = sidebar?.querySelector("#sidebar-scroll") as E | null | undefined;
  const scrollers = ["sidebar-scroll", ...regions].map((id): [string, E | null | undefined] => [id, sidebar?.querySelector(`#${id}`) as E | null | undefined])
    .filter((pair): pair is [string, E] => Boolean(pair[1]));
  const flights = new Map<string, AvatarFlight<E>>();
  let generation = 0, expectedScroll: Map<string, number> | null = null;
  const cancel = () => {
    generation += 1;
    for (const { element, animation, hidden } of flights.values()) {
      for (const avatar of hidden) avatar.classList.remove("sidebar-avatar-in-flight");
      animation?.cancel(); element.remove();
    }
    flights.clear(); expectedScroll = null;
  };
  const links = (root: E, collapsed: boolean) => {
    const result = new Map<string, E>();
    for (const link of root.querySelectorAll(collapsed ? compact : expanded) as Iterable<E>) {
      const key = link.getAttribute("href"), avatar = link.firstElementChild as E | null;
      if (key && avatar && !result.has(key)) result.set(key, avatar);
    }
    return result;
  };
  const visible = (rect: SidebarMotionRect, clip: ClipBounds) => rect.width > 0 && rect.height > 0 && clip.bottom > clip.top && clip.right > clip.left
    && rect.bottom > Math.max(0, clip.top) && rect.top < Math.min(window.innerHeight, clip.bottom)
    && rect.right > Math.max(0, clip.left) && rect.left < Math.min(window.innerWidth, clip.right);
  const clipFor = (avatar: E, outer: ClipBounds) => {
    const region = avatar.closest(regionSelector) as E | null;
    if (!region) return outer;
    const rect = region.getBoundingClientRect();
    return { top: Math.max(outer.top, rect.top), bottom: Math.min(outer.bottom, rect.bottom),
      left: Math.max(outer.left, rect.left), right: Math.min(outer.right, rect.right) };
  };
  const measure = (collapsed: boolean) => {
    const copy = shell!.cloneNode(false) as E, side = sidebar!.cloneNode(true) as E;
    const bounds = shell!.getBoundingClientRect();
    copy.classList.add("sidebar-motion-measure");
    copy.classList.toggle("sidebar-collapsed", collapsed);
    copy.classList.remove("is-panel-revealing", "is-panel-resizing");
    copy.setAttribute("aria-hidden", "true"); copy.inert = true;
    Object.assign(copy.style, { position: "fixed", left: `${bounds.left}px`, top: `${sidebar!.getBoundingClientRect().top}px`,
      width: `${bounds.width}px`, height: `${window.innerHeight}px` });
    copy.append(side);
    try {
      document.body.append(copy);
      const copyScroll = side.querySelector("#sidebar-scroll") as E;
      const copies = scrollers.map(([id, source]): [string, E, E] => [id, side.querySelector(`#${id}`) as E, source]);
      for (const [, target, source] of copies) target.scrollTop = source.scrollTop;
      const clip = copyScroll.getBoundingClientRect(), result = new Map<string, SidebarMotionRect>();
      for (const [key, avatar] of links(side, collapsed)) {
        const rect = avatar.getBoundingClientRect();
        if (visible(rect, clipFor(avatar, clip))) result.set(key, rect);
      }
      return { positions: result, scrollTops: new Map(copies.map(([id, target]) => [id, target.scrollTop])) };
    } finally { copy.remove(); }
  };
  const prepare = (collapsed: boolean) => {
    if (!shell || !sidebar || !scroll || reducedMotion?.matches || !document.body
      || typeof document.createElement !== "function") { cancel(); return; }
    const starts = new Map<string, SidebarMotionRect>(), clip = scroll.getBoundingClientRect();
    const sources = links(sidebar, shell.classList.contains("sidebar-collapsed"));
    for (const [key, avatar] of sources) {
      const flight = flights.get(key), rect = (flight?.element ?? avatar).getBoundingClientRect();
      if (flight || (visible(rect, clipFor(avatar, clip)) && window.getComputedStyle(avatar).visibility !== "hidden")) starts.set(key, rect);
    }
    cancel();
    if (!starts.size) return;
    const token = generation;
    try {
      const targets = links(sidebar, collapsed), measured = measure(collapsed);
      expectedScroll = measured.scrollTops;
      for (const [key, from] of starts) {
        const target = targets.get(key), to = measured.positions.get(key);
        if (!target || !to) continue;
        const element = sources.get(key)!.cloneNode(true) as E;
        if (typeof element.animate !== "function") { cancel(); return; }
        element.classList.remove("sidebar-avatar-in-flight");
        element.classList.add("sidebar-avatar-flight");
        for (const part of element.querySelectorAll("[data-avatar-motion]") as Iterable<E>) part.dataset.avatarMotion = "false";
        element.setAttribute("aria-hidden", "true"); element.inert = true;
        Object.assign(element.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
        document.body.append(element);
        const hidden = new Set([sources.get(key)!, target]), flight: AvatarFlight<E> = { element, animation: null, hidden };
        flights.set(key, flight);
        const animation = element.animate([
          { transform: "translate(0px, 0px) scale(1, 1)" },
          { transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width}, ${to.height / from.height})` },
        ], { duration, easing, fill: "forwards" });
        flight.animation = animation;
        for (const avatar of hidden) avatar.classList.add("sidebar-avatar-in-flight");
        animation.finished.then(() => {
          if (generation !== token || flights.get(key)?.element !== element) return;
          for (const avatar of hidden) avatar.classList.remove("sidebar-avatar-in-flight");
          animation.cancel(); element.remove(); flights.delete(key);
        }, () => {});
      }
    } catch { cancel(); }
  };
  window.addEventListener("resize", cancel);
  window.addEventListener("scroll", cancel);
  for (const [id, element] of scrollers) element.addEventListener("scroll", () => {
    if (flights.size && element.scrollTop !== expectedScroll?.get(id)) cancel();
  });
  document.addEventListener("visibilitychange", cancel);
  document.addEventListener("neuma:route", cancel);
  reducedMotion?.addEventListener("change", () => { if (reducedMotion.matches) cancel(); });
  return { prepare, cancel };
}
