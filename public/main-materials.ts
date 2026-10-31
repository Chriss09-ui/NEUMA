import type { CollaborationApi } from "./ui-api-types.js";
import type { Material } from "./ui-types.js";
import { pageElement, type PageElements } from "./page-elements.js";
import { errorInfo } from "./ui-types.js";
import { button, node, notice } from "./group-view.js";

export function createMainMaterials({ api, current, create, changed, onError }: { api: CollaborationApi; current: () => { id: string } | null; create: () => Promise<unknown>; changed: () => unknown; onError: (message?: string) => unknown }) {
  const byId = <K extends keyof PageElements>(id: K) => pageElement(document, id), selections = new Map<string, Set<string>>(), descriptions = new Map<string, Material>();
  const menuToggle = byId("main-attachment-menu-toggle"), menu = byId("main-attachment-menu");
  const uploadButton = byId("main-upload"), picker = byId("main-materials-open");
  let uploading = false, disabled = false, sequence = 0;
  const unavailable = () => disabled || uploading;
  function closeMenu({ restoreFocus = false } = {}) {
    menu.hidden = true; menuToggle.setAttribute("aria-expanded", "false");
    if (restoreFocus && !menuToggle.disabled) menuToggle.focus({ preventScroll: true });
  }
  function openMenu(last = false) {
    if (unavailable()) return;
    menu.hidden = false; menuToggle.setAttribute("aria-expanded", "true");
    (last ? picker : uploadButton).focus({ preventScroll: true });
  }
  function syncControls() {
    const blocked = unavailable(), focusedInMenu = menu.contains(document.activeElement);
    menuToggle.disabled = uploadButton.disabled = picker.disabled = byId("main-file-input").disabled = blocked;
    if (blocked) {
      closeMenu();
      if (focusedInMenu && !byId("main-message").disabled) byId("main-message").focus({ preventScroll: true });
    }
  }
  closeMenu(); uploadButton.tabIndex = picker.tabIndex = -1;
  const selection = () => {
    const id = current()?.id || "";
    if (!selections.has(id)) selections.set(id, new Set());
    return selections.get(id)!;
  };
  const description = (id: string) => descriptions.get(`${current()?.id}:${id}`);
  function render() {
    const refs = selection(), target = byId("main-pending-materials"); target.replaceChildren(); target.hidden = !refs.size;
    for (const id of refs) target.append(button(`${description(id)?.name || "已选材料"} ×`, () => { refs.delete(id); render(); changed(); }, "group-material-chip"));
    syncControls();
    byId("main-material-status").textContent = uploading ? "正在上传材料…" : refs.size ? `本轮使用 ${refs.size} 份材料` : "单个文件不超过 20 MiB，每次最多 10 个";
  }
  function add(attachment: Material) {
    const refs = selection();
    descriptions.set(`${current()!.id}:${attachment.id}`, attachment);
    if (refs.size >= 10 && !refs.has(attachment.id)) throw new Error("本轮最多选择 10 份材料，已上传文件可在“选择已有材料”继续使用。");
    refs.add(attachment.id); render(); changed();
  }
  async function ensureConversation() { if (!current()) await create(); return current()?.id; }
  async function upload(files: FileList | null) {
    if (unavailable() || !files?.length) return;
    const id = await ensureConversation(); if (!id) return;
    uploading = true; render(); changed();
    try {
      for (const file of [...files]) {
        if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name} 超过 20 MiB，请选择较小文件。`);
        const result = await api.uploadMainMaterial(id, file);
        if (current()?.id !== id) return;
        if (!result.attachment?.id) throw new Error("上传结果尚未确认，请重试。");
        add(result.attachment);
      }
    } catch (caught) { const error = errorInfo(caught); if (current()?.id === id) onError(error.message); }
    finally { uploading = false; byId("main-file-input").value = ""; render(); changed(); }
  }
  function close(restoreFocus = true) {
    sequence++; byId("main-material-dialog").close();
    if (restoreFocus) byId(menuToggle.disabled ? "main-message" : "main-attachment-menu-toggle").focus();
  }
  async function open() {
    if (unavailable()) return;
    closeMenu();
    const id = await ensureConversation(); if (!id) return;
    const request = ++sequence; byId("main-material-dialog").showModal(); byId("main-material-close").focus();
    byId("main-material-list").replaceChildren(); notice(byId("main-material-feedback"), "正在读取材料…");
    try {
      const result = await api.mainMaterials(id);
      if (sequence !== request || current()?.id !== id) return;
      const target = byId("main-material-list");
      for (const attachment of result.attachments || []) {
        descriptions.set(`${id}:${attachment.id}`, attachment);
        const row = node("div", "group-share-item"), label = node("span", "", attachment.name || "材料");
        const actions = node("div", "collaboration-links"), download = node("a", "text-link small", "下载");
        download.href = api.mainMaterialUrl(id, attachment.id); download.download = attachment.name || "材料";
        const select = button("添加到本轮", () => { try { add(attachment); close(); byId("main-message").focus(); } catch (caught) { const error = errorInfo(caught); notice(byId("main-material-feedback"), error.message, true); } }, "secondary");
        actions.append(download, select); row.append(label, actions); target.append(row);
      }
      notice(byId("main-material-feedback"), result.attachments?.length ? "选择需要交给主助理的具体材料。" : "还没有材料，可以先上传一份文件。");
    } catch (caught) { const error = errorInfo(caught); if (sequence === request) notice(byId("main-material-feedback"), error.message, true); }
  }
  menuToggle.addEventListener("click", () => menu.hidden ? openMenu() : closeMenu({ restoreFocus: true }));
  menuToggle.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || unavailable()) return;
    event.preventDefault(); openMenu(event.key === "ArrowUp" || event.key === "End");
  });
  const outsideMenu = (event: Event) => {
    if (!menu.hidden && !menuToggle.contains(event.target as Node | null) && !menu.contains(event.target as Node | null)) closeMenu();
  };
  document.addEventListener("click", outsideMenu);
  document.addEventListener("focusin", outsideMenu);
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || menu.hidden) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu({ restoreFocus: true }); return; }
    if (event.key === "Tab") { closeMenu(); return; }
    if (!menu.contains(event.target as Node | null) || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [uploadButton, picker], index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    event.preventDefault(); items[next]!.focus({ preventScroll: true });
  });
  document.addEventListener("neuma:route", (event) => { if (event.detail.page !== "chat") closeMenu(); });
  uploadButton.addEventListener("click", () => {
    if (unavailable()) return;
    closeMenu({ restoreFocus: true }); byId("main-file-input").click();
  });
  byId("main-file-input").addEventListener("change", (event) => void upload((event.target as HTMLInputElement).files));
  picker.addEventListener("click", () => void open());
  byId("main-material-close").addEventListener("click", () => close());
  byId("main-material-dialog").addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  return { render, setDisabled(value: boolean) { disabled = value; syncControls(); },
    refs: () => [...selection()], attachments: () => [...selection()].map((id) => description(id) || { id, name: "已选材料" }), busy: () => uploading,
    consume() { selection().clear(); render(); }, reset() { sequence++; closeMenu(); if (byId("main-material-dialog").open) close(false); render(); } };
}
