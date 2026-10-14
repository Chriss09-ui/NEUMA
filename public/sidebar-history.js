const RECENT_LIMIT = 4;

export function createSidebarHistory({ document, id, title, href, icon, className = "", onExpand = () => {},
  onOpen = () => {}, storage }) {
  const node = (tag, name = "", text = "") => {
    const element = document.createElement(tag); element.className = name; element.textContent = text; return element;
  };
  const root = node("section", "sidebar-history"), heading = node("div", "sidebar-history-heading");
  const link = node("a", `sidebar-history-link ${className}`.trim()), label = node("span", "sidebar-history-name", title);
  link.href = href; link.title = title;
  if (icon) link.append(icon);
  link.append(label);
  const toggle = node("button", "sidebar-history-toggle"); toggle.type = "button";
  const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  arrow.setAttribute("viewBox", "0 0 24 24"); arrow.setAttribute("aria-hidden", "true");
  path.setAttribute("d", "m9 6 6 6-6 6"); arrow.append(path); toggle.append(arrow);
  const body = node("div", "sidebar-history-body"), content = node("div", "sidebar-history-content");
  body.id = id; toggle.setAttribute("aria-controls", id); link.setAttribute("aria-controls", id);
  const list = node("nav", "sidebar-history-list"), status = node("p", "sidebar-history-status");
  list.setAttribute("aria-label", `${title}的历史对话`); status.setAttribute("role", "status");
  const more = node("button", "sidebar-history-show-more", "展开显示"); more.type = "button";
  more.setAttribute("aria-controls", id); more.hidden = true;
  let expanded = false, hasPreference = false, showAll = false, current = { records: [], renderRow: () => null };
  const storageKey = `neuma.sidebar.history-open.v1.${id}`;
  try { const saved = storage?.getItem(storageKey); hasPreference = saved === "true" || saved === "false"; expanded = saved === "true"; }
  catch { /* Navigation remains usable without storage. */ }
  heading.append(link, toggle);
  content.append(list, status, more); body.append(content); root.append(heading, body);

  function layout() {
    root.classList.toggle("history-collapsed", !expanded);
    body.inert = !expanded; body.setAttribute("aria-hidden", String(!expanded));
    toggle.setAttribute("aria-expanded", String(expanded));
    link.setAttribute("aria-expanded", String(expanded));
    toggle.setAttribute("aria-label", `${expanded ? "收起" : "展开"}${label.textContent}的历史对话`);
    toggle.title = toggle.getAttribute("aria-label");
  }
  function setExpanded(open) {
    const changed = expanded !== open;
    if (!open && body.contains(document.activeElement)) toggle.focus({ preventScroll: true });
    expanded = open; hasPreference = true; layout();
    try { storage?.setItem(storageKey, String(open)); } catch { /* The current fold state still works. */ }
    if (changed) return onExpand(open);
  }
  function renderRecords() {
    const focused = document.activeElement, inside = list.contains(focused);
    const selectedId = focused?.dataset?.conversationId || focused?.dataset?.taskId;
    const focusedClass = focused?.className;
    list.replaceChildren();
    for (const record of showAll ? current.records : current.records.slice(0, RECENT_LIMIT)) {
      const row = current.renderRow(record); if (row) list.append(row);
    }
    more.hidden = current.records.length <= RECENT_LIMIT;
    more.textContent = showAll ? "收起" : "展开显示"; more.setAttribute("aria-expanded", String(showAll));
    if (focused === more && more.hidden) toggle.focus({ preventScroll: true });
    if (inside) {
      const replacement = [...list.querySelectorAll("button, a")].find((entry) => !entry.disabled &&
        (entry.dataset.conversationId || entry.dataset.taskId) === selectedId && entry.className === focusedClass);
      (replacement || (!more.hidden ? more : toggle)).focus({ preventScroll: true });
    }
  }
  toggle.addEventListener("click", () => { toggle.focus({ preventScroll: true }); return setExpanded(!expanded); });
  link.addEventListener("click", (event) => {
    const open = !expanded;
    if (!open) event.preventDefault();
    setExpanded(open);
    if (open) return onOpen();
  });
  link.addEventListener("keydown", (event) => {
    if (event.key !== " ") return;
    event.preventDefault();
    if (!event.repeat) return link.click();
  });
  heading.addEventListener("click", (event) => { if (event.target === heading) return link.click(); });
  more.addEventListener("click", () => { showAll = !showAll; renderRecords(); });
  layout();
  return { root, link, icon, toggle, body, list, status, more, get expanded() { return expanded; }, setExpanded,
    openInitially() { if (!hasPreference) return setExpanded(true); },
    update(value) {
      current = { ...current, ...value };
      if (value.title !== undefined) {
        label.textContent = value.title; link.title = value.title;
        list.setAttribute("aria-label", `${value.title}的历史对话`);
      }
      if (value.active !== undefined) {
        root.classList.toggle("is-current", value.active);
        if (value.active) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
      }
      if (value.status !== undefined) { status.textContent = value.status; status.hidden = !value.status; }
      layout();
      if (value.records !== undefined || value.renderRow !== undefined) renderRecords();
    },
  };
}
