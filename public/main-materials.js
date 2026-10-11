import { button, node, notice } from "./group-view.js";

export function createMainMaterials({ api, current, create, changed, onError }) {
  const byId = (id) => document.getElementById(id), selections = new Map(), descriptions = new Map();
  let uploading = false, sequence = 0;
  const selection = () => {
    const id = current()?.id || "";
    if (!selections.has(id)) selections.set(id, new Set());
    return selections.get(id);
  };
  const description = (id) => descriptions.get(`${current()?.id}:${id}`);
  function render() {
    const refs = selection(), target = byId("main-pending-materials"); target.replaceChildren(); target.hidden = !refs.size;
    for (const id of refs) target.append(button(`${description(id)?.name || "已选材料"} ×`, () => { refs.delete(id); render(); changed(); }, "group-material-chip"));
    byId("main-upload").disabled = uploading; byId("main-materials-open").disabled = uploading;
    byId("main-material-status").textContent = uploading ? "正在上传材料…" : refs.size ? `本轮使用 ${refs.size} 份材料` : "单份 50 MiB · 最多 10 份";
  }
  function add(attachment) {
    const refs = selection();
    descriptions.set(`${current().id}:${attachment.id}`, attachment);
    if (refs.size >= 10 && !refs.has(attachment.id)) throw new Error("本轮最多选择 10 份材料，已上传文件可在“已有材料”继续使用。");
    refs.add(attachment.id); render(); changed();
  }
  async function ensureConversation() { if (!current()) await create(); return current()?.id; }
  async function upload(files) {
    if (uploading) return;
    const id = await ensureConversation(); if (!id) return;
    uploading = true; render(); changed();
    try {
      for (const file of [...files]) {
        if (file.size > 50 * 1024 * 1024) throw new Error(`${file.name} 超过 50 MiB，请选择较小文件。`);
        const result = await api.uploadMainMaterial(id, file);
        if (current()?.id !== id) return;
        if (!result.attachment?.id) throw new Error("上传结果尚未确认，请重试。");
        add(result.attachment);
      }
    } catch (error) { if (current()?.id === id) onError(error.message); }
    finally { uploading = false; byId("main-file-input").value = ""; render(); changed(); }
  }
  function close() { sequence++; byId("main-material-dialog").close(); byId("main-materials-open").focus(); }
  async function open() {
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
        const select = button("添加到本轮", () => { try { add(attachment); close(); byId("main-message").focus(); } catch (error) { notice(byId("main-material-feedback"), error.message, true); } }, "secondary");
        actions.append(download, select); row.append(label, actions); target.append(row);
      }
      notice(byId("main-material-feedback"), result.attachments?.length ? "选择需要交给主助理的具体材料。" : "还没有材料，可以先上传一份文件。");
    } catch (error) { if (sequence === request) notice(byId("main-material-feedback"), error.message, true); }
  }
  byId("main-upload").addEventListener("click", () => byId("main-file-input").click());
  byId("main-file-input").addEventListener("change", (event) => void upload(event.target.files));
  byId("main-materials-open").addEventListener("click", () => void open());
  byId("main-material-close").addEventListener("click", close);
  byId("main-material-dialog").addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  return { render, refs: () => [...selection()], attachments: () => [...selection()].map((id) => description(id) || { id, name: "已选材料" }), busy: () => uploading,
    consume() { selection().clear(); render(); }, reset() { sequence++; if (byId("main-material-dialog").open) close(); render(); } };
}
