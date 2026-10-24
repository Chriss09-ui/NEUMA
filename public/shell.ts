import type { UiRoute } from "./browser-events.js";
import { pageElement, type PageElements } from "./page-elements.js";
import { createSidebarAvatarMotion } from "./sidebar-motion.js";

const PAGES = ["chat", "groups", "group", "projects", "agents", "agent", "skills", "settings"] as const;
const route: UiRoute = { page: "chat", projectView: "assistant", agentId: null, groupId: null };
const byId = <K extends keyof PageElements>(id: K) => pageElement(document, id);
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const compactLayout = window.matchMedia("(max-width: 1100px)");
let panelsOpen = !compactLayout.matches;
let renderedRoute = "";
let projectBaseView = "assistant";
let modulesReady = false, pendingRequirements = false;
byId("page-create").hidden = true;
byId("page-create").inert = true;
function requestRequirements() {
  if (!modulesReady) { pendingRequirements = true; return; }
  document.dispatchEvent(new CustomEvent("neuma:main-requirements"));
}
const PROJECT_LIBRARY_KEY = "neuma-project-library-collapsed";
let projectLibraryCollapsed = false;
try { projectLibraryCollapsed = localStorage.getItem(PROJECT_LIBRARY_KEY) === "true"; } catch { /* Storage can be unavailable in private browser contexts. */ }

function setProjectLibraryCollapsed(collapsed: boolean, remember = true) {
  const body = byId("project-library-body"), toggle = byId("project-library-toggle");
  if (collapsed && body.contains(document.activeElement)) toggle.focus({ preventScroll: true });
  projectLibraryCollapsed = collapsed;
  byId("project-workspace").classList.toggle("library-collapsed", collapsed);
  body.inert = collapsed;
  toggle.setAttribute("aria-expanded", String(!collapsed));
  const label = collapsed ? "展开项目栏" : "收起项目栏";
  toggle.setAttribute("aria-label", label); toggle.title = label;
  if (remember) {
    try { localStorage.setItem(PROJECT_LIBRARY_KEY, String(collapsed)); } catch { /* The current page still works without storage. */ }
  }
}
byId("project-library-toggle").addEventListener("click", () => setProjectLibraryCollapsed(!projectLibraryCollapsed));
document.addEventListener("neuma:project-library-open", () => setProjectLibraryCollapsed(false));
setProjectLibraryCollapsed(projectLibraryCollapsed, false);

const SIDEBAR_KEY = "neuma-sidebar-collapsed";
const sidebarAvatarMotion = createSidebarAvatarMotion({ document, window, reducedMotion });
let sidebarCollapsed = false;
try { sidebarCollapsed = localStorage.getItem(SIDEBAR_KEY) === "true"; } catch { /* Use the expanded layout when storage is unavailable. */ }

function setSidebarCollapsed(collapsed: boolean, remember = true) {
  const details = byId("sidebar-details"), rails = [byId("sidebar-agent-rail"), byId("sidebar-group-rail")], toggle = byId("sidebar-toggle");
  const mainHistory = byId("main-history");
  if ((collapsed && (details.contains(document.activeElement) || (mainHistory?.contains(document.activeElement)
    && document.activeElement !== byId("sidebar-main-link")))) || (!collapsed && rails.some((rail) => rail.contains(document.activeElement)))) toggle.focus({ preventScroll: true });
  if (remember && collapsed !== sidebarCollapsed) sidebarAvatarMotion.prepare(collapsed);
  sidebarCollapsed = collapsed;
  byId("app-shell").classList.toggle("sidebar-collapsed", collapsed);
  details.inert = collapsed;
  for (const rail of rails) rail.inert = !collapsed;
  toggle.setAttribute("aria-expanded", String(!collapsed));
  const label = collapsed ? "展开主导航" : "收起主导航";
  toggle.setAttribute("aria-label", label); toggle.title = label;
  if (remember) {
    try { localStorage.setItem(SIDEBAR_KEY, String(collapsed)); } catch { /* Folding still works for this page. */ }
  }
}
byId("sidebar-toggle").addEventListener("click", () => setSidebarCollapsed(!sidebarCollapsed));
setSidebarCollapsed(sidebarCollapsed, false);

function updatePanels() {
  for (const [layoutId, panelId] of [["chat-requirements", "requirements-panel"]] as const) {
    byId(layoutId).classList.toggle("panel-collapsed", !panelsOpen);
    byId(panelId).hidden = !panelsOpen;
  }
  byId("chat-panel-toggle").setAttribute("aria-expanded", String(panelsOpen));
}

for (const id of ["chat-panel-toggle"] as const) {
  byId(id).addEventListener("click", () => {
    panelsOpen = !panelsOpen;
    updatePanels();
    if (panelsOpen && compactLayout.matches) byId(byId(id).getAttribute("aria-controls") as "requirements-panel").scrollIntoView({ behavior: reducedMotion.matches ? "instant" : "smooth", block: "start" });
  });
}
document.addEventListener("keydown", (event) => {
  const activeToggle = route.page === "create" ? "chat-panel-toggle" : null;
  if (event.key !== "Escape" || !panelsOpen || !activeToggle) return;
  const toggle = byId(activeToggle);
  panelsOpen = false;
  updatePanels();
  toggle.focus({ preventScroll: true });
});
compactLayout.addEventListener("change", () => { panelsOpen = !compactLayout.matches; updatePanels(); });

function parse(hash: string): Partial<UiRoute> & { requirements?: boolean | undefined } {
  const [page, sub] = hash.replace(/^#\/?/, "").split("/");
  // Keep existing bookmarks working after moving projects out of the main Agent.
  if (page === "add") return { page: "projects", projectView: "add" };
  if (page === "manage") return sub === "agents" ? { page: "agents" } : { page: "projects", projectView: "list" };
  if (page === "chat" && sub === "projects") return { page: "projects", projectView: "assistant" };
  if (page === "create" || (page === "chat" && sub === "requirements")) return { page: "chat", requirements: true };
  if (page === "projects") return { page, projectView: ["list", "assistant", "add"].includes(sub!) ? sub : "assistant" };
  if (!PAGES.includes(page as typeof PAGES[number])) return { page: "chat" };
  if (page === "agent") {
    try { return { page, agentId: decodeURIComponent(sub ?? "") }; }
    catch { return { page, agentId: null }; }
  }
  if (page === "group") {
    try { return { page, groupId: decodeURIComponent(sub ?? "") }; }
    catch { return { page: "groups", groupId: null }; }
  }
  return { page: page! };
}

function canonical() {
  if (route.page === "agent") return `#agent/${encodeURIComponent(route.agentId ?? "")}`;
  if (route.page === "group") return `#group/${encodeURIComponent(route.groupId ?? "")}`;
  if (route.page === "projects") return `#projects/${route.projectView}`;
  return `#${route.page}`;
}

function focusComposer() {
  if (route.page === "chat") byId("main-message").focus({ preventScroll: true });
  if (route.page === "group") byId("group-message").focus({ preventScroll: true });
  if (route.page === "projects" && route.projectView === "assistant") byId("project-message").focus({ preventScroll: true });
  if (route.page === "projects" && route.projectView === "add") byId("project-path").focus({ preventScroll: true });
  if (route.page === "agent") byId("agent-message").focus({ preventScroll: true });
  if (route.page === "skills") byId("skills-search").focus({ preventScroll: true });
}

function apply(focusInput = false) {
  for (const page of PAGES) byId(`page-${page}`).hidden = page !== route.page;
  for (const link of document.querySelectorAll<HTMLElement>(".nav-item, .sidebar-manage")) {
    if (link.dataset.page === route.page || (route.page === "group" && link.dataset.page === "groups")) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  if (route.page === "projects" && route.projectView !== "add") projectBaseView = route.projectView!;
  byId("manage-projects").hidden = projectBaseView !== "list";
  byId("chat-projects").hidden = projectBaseView !== "assistant";
  byId("project-assistant-home").setAttribute("aria-pressed", String(projectBaseView === "assistant"));
  const dialog = byId("project-add-panel");
  if (route.page === "projects" && route.projectView === "add") {
    if (!dialog.open) dialog.showModal();
  } else if (dialog.open) dialog.close();
  updatePanels();
  document.dispatchEvent(new CustomEvent("neuma:route", { detail: { ...route } }));
  for (const textarea of byId(`page-${route.page}` as keyof PageElements).querySelectorAll(".composer textarea")) textarea.dispatchEvent(new Event("input"));
  if (focusInput) focusComposer();
}

function renderRoute(focusInput = false) {
  const key = canonical();
  // Update navigation synchronously; CSS handles the visual transition independently.
  if (location.hash !== key) history.replaceState(null, "", key);
  if (key === renderedRoute) {
    if (focusInput) focusComposer();
    return;
  }
  renderedRoute = key;
  apply(focusInput);
}

function fromLocation() {
  const { requirements, ...next } = parse(location.hash);
  Object.assign(route, next);
  renderRoute(route.page === "projects" && route.projectView === "add");
  if (requirements) requestRequirements();
}

function navigate(next: Partial<UiRoute>, focusInput = false) {
  const requirements = next.page === "create";
  if (requirements) next = { ...next, page: "chat" };
  Object.assign(route, next);
  if (location.hash !== canonical()) history.pushState(null, "", canonical());
  renderRoute(focusInput);
  if (requirements) requestRequirements();
}

document.addEventListener("neuma:navigate", (event) => navigate(event.detail ?? {}, true));
window.addEventListener("hashchange", fromLocation);
window.addEventListener("popstate", fromLocation);
byId("project-assistant-home").addEventListener("click", () => navigate({ page: "projects", projectView: "assistant" }, true));
function dismissProjectDialog() {
  navigate({ page: "projects", projectView: projectBaseView });
  byId("project-add-link").focus({ preventScroll: true });
}
byId("project-add-panel").addEventListener("cancel", (event) => { event.preventDefault(); dismissProjectDialog(); });
for (const id of ["project-add-close", "project-add-cancel"] as const) byId(id).addEventListener("click", dismissProjectDialog);

async function checkHealth() {
  const banners = [byId("setup-banner"), byId("project-setup-banner")];
  try {
    const response = await fetch("/api/health");
    if (!response.ok) throw new Error();
    const health = await response.json();
    for (const banner of banners) {
      banner.firstElementChild!.textContent = "模型服务尚未配置，对话暂时无法使用。";
      banner.hidden = health.llmConfigured;
    }
  } catch {
    for (const banner of banners) {
      banner.firstElementChild!.textContent = "本地服务未连接，请确认 npm start 正在运行。";
      banner.hidden = false;
    }
  }
}
document.addEventListener("neuma:settings-changed", () => { void checkHealth(); });

for (const textarea of document.querySelectorAll<HTMLTextAreaElement>(".composer textarea")) {
  const resize = () => {
    if (textarea.closest("[hidden]")) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  };
  textarea.addEventListener("input", resize);
  textarea.addEventListener("keydown", (event) => {
    const choosingMention = textarea.getAttribute("aria-autocomplete") === "list" && textarea.getAttribute("aria-expanded") === "true";
    if (event.defaultPrevented || choosingMention || event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    textarea.form!.requestSubmit();
  });
  new MutationObserver(resize).observe(textarea, { attributes: true, attributeFilter: ["disabled"] });
  if (["agent-message", "group-message"].includes(textarea.id) && typeof ResizeObserver !== "undefined") {
    let previousWidth: number | null | undefined = null;
    new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width;
      if (!Number.isFinite(width) || width === previousWidth) return;
      previousWidth = width;
      resize();
    }).observe(textarea);
  }
}

fromLocation();
// Later module scripts register their route listeners after this one runs.
document.addEventListener("DOMContentLoaded", () => {
  modulesReady = true;
  document.dispatchEvent(new CustomEvent("neuma:route", { detail: { ...route } }));
  if (pendingRequirements) { pendingRequirements = false; requestRequirements(); }
});
void checkHealth();
