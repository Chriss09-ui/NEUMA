const expanded = "#sidebar-agent-list .sidebar-history-link, #sidebar-group-list .sidebar-history-link";
const compact = "#sidebar-agent-rail a, #sidebar-group-rail a";
const regions = ["sidebar-agent-list", "sidebar-group-list", "sidebar-agent-rail", "sidebar-group-rail"];
const regionSelector = regions.map((id) => `#${id}`).join(", ");
const easing = "cubic-bezier(.22, 1, .36, 1)";

export function createSidebarAvatarMotion({ document, window, reducedMotion, duration = 320 }) {
  const shell = document.getElementById("app-shell"), sidebar = shell?.querySelector(".sidebar");
  const scroll = sidebar?.querySelector("#sidebar-scroll");
  const scrollers = ["sidebar-scroll", ...regions].map((id) => [id, sidebar?.querySelector(`#${id}`)])
    .filter(([, element]) => element);
  const flights = new Map();
  let generation = 0, expectedScroll = null;
  const cancel = () => {
    generation += 1;
    for (const { element, animation, hidden } of flights.values()) {
      for (const avatar of hidden) avatar.classList.remove("sidebar-avatar-in-flight");
      animation?.cancel(); element.remove();
    }
    flights.clear(); expectedScroll = null;
  };
  const links = (root, collapsed) => {
    const result = new Map();
    for (const link of root.querySelectorAll(collapsed ? compact : expanded)) {
      const key = link.getAttribute("href"), avatar = link.firstElementChild;
      if (key && avatar && !result.has(key)) result.set(key, avatar);
    }
    return result;
  };
  const visible = (rect, clip) => rect.width > 0 && rect.height > 0 && clip.bottom > clip.top && clip.right > clip.left
    && rect.bottom > Math.max(0, clip.top) && rect.top < Math.min(window.innerHeight, clip.bottom)
    && rect.right > Math.max(0, clip.left) && rect.left < Math.min(window.innerWidth, clip.right);
  const clipFor = (avatar, outer) => {
    const region = avatar.closest(regionSelector);
    if (!region) return outer;
    const rect = region.getBoundingClientRect();
    return { top: Math.max(outer.top, rect.top), bottom: Math.min(outer.bottom, rect.bottom),
      left: Math.max(outer.left, rect.left), right: Math.min(outer.right, rect.right) };
  };
  const measure = (collapsed) => {
    const copy = shell.cloneNode(false), side = sidebar.cloneNode(true);
    const bounds = shell.getBoundingClientRect();
    copy.classList.add("sidebar-motion-measure");
    copy.classList.toggle("sidebar-collapsed", collapsed);
    copy.classList.remove("is-panel-revealing", "is-panel-resizing");
    copy.setAttribute("aria-hidden", "true"); copy.inert = true;
    Object.assign(copy.style, { position: "fixed", left: `${bounds.left}px`, top: `${sidebar.getBoundingClientRect().top}px`,
      width: `${bounds.width}px`, height: `${window.innerHeight}px` });
    copy.append(side);
    try {
      document.body.append(copy);
      const copyScroll = side.querySelector("#sidebar-scroll");
      const copies = scrollers.map(([id, source]) => [id, side.querySelector(`#${id}`), source]);
      for (const [, target, source] of copies) target.scrollTop = source.scrollTop;
      const clip = copyScroll.getBoundingClientRect(), result = new Map();
      for (const [key, avatar] of links(side, collapsed)) {
        const rect = avatar.getBoundingClientRect();
        if (visible(rect, clipFor(avatar, clip))) result.set(key, rect);
      }
      return { positions: result, scrollTops: new Map(copies.map(([id, target]) => [id, target.scrollTop])) };
    } finally { copy.remove(); }
  };
  const prepare = (collapsed) => {
    if (!sidebar || !scroll || reducedMotion?.matches || !document.body
      || typeof document.createElement !== "function") { cancel(); return; }
    const starts = new Map(), clip = scroll.getBoundingClientRect();
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
        const element = sources.get(key).cloneNode(true);
        if (typeof element.animate !== "function") { cancel(); return; }
        element.classList.remove("sidebar-avatar-in-flight");
        element.classList.add("sidebar-avatar-flight");
        for (const part of element.querySelectorAll("[data-avatar-motion]")) part.dataset.avatarMotion = "false";
        element.setAttribute("aria-hidden", "true"); element.inert = true;
        Object.assign(element.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
        document.body.append(element);
        const hidden = new Set([sources.get(key), target]), flight = { element, animation: null, hidden };
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
