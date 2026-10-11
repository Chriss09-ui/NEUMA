import { button, node, notice } from "./group-view.js";

export function createGroupMaterials({ api, current, refresh, changed }) {
  const byId = (id) => document.getElementById(id), pending = new Map();
  let returnFocus = null, version = 0, objectUrl = null, busy = false;
  const id = () => current()?.group?.id;
  const key = () => id() || "";
  const selected = () => { if (!pending.has(key())) pending.set(key(), new Set()); return pending.get(key()); };
  function render() {
    const refs = selected(), materials = current()?.materials || [], target = byId("group-pending-materials");
    target.replaceChildren(); target.hidden = !refs.size;
    for (const materialId of refs) target.append(button(`${materials.find((item) => item.id === materialId)?.name || "已选材料"} ×`, () => { refs.delete(materialId); render(); }, "group-material-chip"));
    byId("group-files-count").textContent = String(materials.length + (current()?.artifacts || []).length);
    byId("group-upload").disabled = busy || !id() || current()?.group?.archived;
    byId("group-share-open").disabled = !id() || current()?.group?.archived;
    changed?.();
  }
  function attach(materialId) {
    if (selected().size >= 10 && !selected().has(materialId)) throw new Error("每轮最多使用 10 份群材料。");
    selected().add(materialId); render();
  }
  function open(dialog, trigger) { returnFocus = trigger; byId(dialog).showModal(); byId(dialog).querySelector("button")?.focus(); }
  function close(dialog) { version++; byId(dialog).close(); if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; } returnFocus?.focus(); }
  async function preview(item, artifact = false) {
    const groupId = id(), request = ++version;
    byId("group-file-title").textContent = item.name || item.path || "文件";
    byId("group-file-preview").replaceChildren(); byId("group-file-actions").replaceChildren();
    notice(byId("group-file-status"), "正在读取预览…");
    try {
      const result = artifact ? await api.artifact(groupId, item.id) : await api.materialPreview(groupId, item.id);
      if (version !== request || id() !== groupId) return;
      const content = result.content ?? result.text ?? result.preview?.text ?? result.preview?.content ?? result.material?.text ?? "";
      const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
      const target = byId("group-file-preview");
      const mime = item.mimeType || item.type || "";
      if (!artifact && mime.startsWith("image/")) { const image = node("img", "group-material-image"); image.src = api.materialUrl(groupId, item.id); image.alt = item.name || "群材料图片"; target.append(image); }
      else if (!artifact && mime === "application/pdf") { const frame = node("iframe", "group-material-frame"); frame.src = api.materialUrl(groupId, item.id); frame.title = item.name || "PDF 材料"; frame.setAttribute("sandbox", ""); target.append(frame); }
      else target.append(node("pre", "group-file-text", text || "这份文件暂时没有文本预览，可以下载原件查看。"));
      const download = node("a", "secondary collaboration-action-link", artifact ? "下载成果" : "下载原件");
      if (artifact) { if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" })); download.href = objectUrl; download.download = item.name || "成果.txt"; }
      else download.href = api.materialUrl(groupId, item.id, true);
      byId("group-file-actions").append(download);
      if (!artifact && !current()?.group?.archived) byId("group-file-actions").append(button("添加到本轮", () => {
        try { attach(item.id); close("group-files-dialog"); byId("group-message").focus(); }
        catch (error) { notice(byId("group-file-status"), error.message, true); }
      }, "secondary"));
      notice(byId("group-file-status"), result.truncated ? "仅显示部分内容。" : "");
    } catch (error) {
      if (version !== request || id() !== groupId) return;
      notice(byId("group-file-status"), error.message, true);
      if (!artifact) { const link = node("a", "text-link", "下载原件"); link.href = api.materialUrl(groupId, item.id, true); byId("group-file-actions").append(link); }
    }
  }
  function files() {
    const data = current(), target = byId("group-file-list"); target.replaceChildren();
    for (const [items, heading, artifact] of [[data?.materials || [], "共享材料", false], [data?.artifacts || [], "工作成果", true]]) {
      target.append(node("h3", "collaboration-file-section", heading));
      for (const item of items) {
        const action = button(item.name || item.path || "文件", () => void preview(item, artifact), "collaboration-file-item");
        action.append(node("small", "muted-note", artifact ? `来自 ${data.members?.find((member) => member.id === item.agentId)?.name || item.agentId || "群任务"}` : "群成员共享")); target.append(action);
      }
      if (!items.length) target.append(node("p", "muted-note small", artifact ? "完成任务后，实际成果会出现在这里。" : "上传或明确分享材料，让成员共同使用。"));
    }
    open("group-files-dialog", byId("group-files-open"));
  }
  async function upload(fileList) {
    const groupId = id(); if (!groupId || busy) return;
    busy = true; render();
    try {
      for (const file of [...fileList]) {
        if (file.size > 50 * 1024 * 1024) throw new Error(`${file.name} 超过 50 MiB，请选择较小文件。`);
        const result = await api.upload(groupId, file);
        if (id() !== groupId) return;
        const material = result.material || result.attachment;
        if (material?.id && selected().size < 10) selected().add(material.id);
      }
      await refresh(groupId); render();
    } catch (error) { if (id() === groupId) notice(byId("group-error"), error.message, true); }
    finally { busy = false; render(); byId("group-file-input").value = ""; }
  }
  async function shareList() {
    const agentId = byId("group-share-agent").value, groupId = id(), request = ++version, target = byId("group-share-list");
    target.replaceChildren(); notice(byId("group-share-status"), "正在读取可分享文件…");
    if (!agentId) return notice(byId("group-share-status"), "先选择一个智能体。");
    try {
      const results = await Promise.allSettled([api.agentMaterials(agentId), api.agentFiles(agentId)]);
      if (request !== version || id() !== groupId) return;
      for (const [index, result] of results.entries()) {
        target.append(node("h3", "collaboration-file-section", index ? "私人工作成果" : "私人材料"));
        if (result.status !== "fulfilled") { target.append(node("p", "muted-note small", result.reason.message)); continue; }
        const files = index ? result.value.files || [] : result.value.attachments || result.value.materials || [];
        for (const item of files) {
          const row = node("div", "group-share-item"); row.append(node("span", "", item.name || item.path || "材料"));
          const mutationId = crypto.randomUUID();
          const action = button("分享给群", async () => {
            action.disabled = true;
            try { await api.share(groupId, { agentId, ...(index ? { path: item.path } : { attachmentId: item.id }), mutationId });
              if (id() !== groupId) return;
              await refresh(groupId); notice(byId("group-share-status"), "已分享到群组，可在“材料与成果”查看。"); action.textContent = "已分享";
            } catch (error) { notice(byId("group-share-status"), error.message, true); action.disabled = false; }
          }, "secondary"); row.append(action); target.append(row);
        }
        if (!files.length) target.append(node("p", "muted-note small", "没有可分享的文件。"));
      }
      notice(byId("group-share-status"), "点击具体文件旁的分享按钮，将它提供给本群成员。");
    } catch (error) { if (request === version) notice(byId("group-share-status"), error.message, true); }
  }
  async function sharing() {
    open("group-share-dialog", byId("group-share-open"));
    const groupId = id();
    try {
      const result = await api.agents(); if (id() !== groupId) return;
      const select = byId("group-share-agent"); select.replaceChildren();
      for (const agent of result.agents || []) { const option = node("option", "", agent.name); option.value = agent.id; select.append(option); }
      await shareList();
    } catch (error) { notice(byId("group-share-status"), error.message, true); }
  }
  byId("group-files-open").addEventListener("click", files);
  byId("group-share-open").addEventListener("click", () => void sharing());
  byId("group-share-agent").addEventListener("change", () => void shareList());
  byId("group-upload").addEventListener("click", () => byId("group-file-input").click());
  byId("group-file-input").addEventListener("change", (event) => void upload(event.target.files));
  for (const [dialog, closeId] of [["group-files-dialog", "group-files-close"], ["group-share-dialog", "group-share-close"]]) {
    byId(closeId).addEventListener("click", () => close(dialog));
    byId(dialog).addEventListener("cancel", (event) => { event.preventDefault(); close(dialog); });
  }
  return { render, refs: () => [...selected()], busy: () => busy, consume() { selected().clear(); render(); },
    reset() { version++; for (const dialog of ["group-files-dialog", "group-share-dialog"]) if (byId(dialog).open) close(dialog); render(); } };
}
