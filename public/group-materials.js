import { button, node, notice } from "./group-view.js";
import { renderAgentAvatar } from "./agent-avatar.js";
import { createSelectMenu } from "./select-menu.js";

export function createGroupMaterials({ api, current, refresh, changed }) {
  const byId = (id) => document.getElementById(id), pending = new Map();
  let returnFocus = null, version = 0, objectUrl = null, busy = false;
  let shareAgents = [];
  const shareMenu = createSelectMenu({ select: byId("group-share-agent"), trigger: byId("group-share-agent-trigger"),
    menu: byId("group-share-agent-menu"), value: byId("group-share-agent-value"), icon: byId("group-share-agent-icon"),
    renderIcon: (target, option) => renderAgentAvatar(target, shareAgents.find((agent) => agent.id === option.value)
      ?? { id: option.value }, { motion: false }), document, window });
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
  function close(dialog) { version++; shareMenu.close(); byId(dialog).close(); if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; } returnFocus?.focus(); }
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
        if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name} 超过 20 MiB，请选择较小文件。`);
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
    target.replaceChildren(); byId("group-share-count").textContent = "0";
    notice(byId("group-share-status"), "");
    if (!agentId) return shareEmpty("还没有可选择的智能体", "创建智能体后，可以在这里分享它的文件。");
    shareEmpty("正在读取文件…");
    try {
      const results = await Promise.allSettled([api.agentMaterials(agentId), api.agentFiles(agentId)]);
      if (request !== version || id() !== groupId) return;
      target.replaceChildren();
      let count = 0; const warnings = [];
      for (const [index, result] of results.entries()) {
        if (result.status !== "fulfilled") { warnings.push(`${index ? "工作成果" : "材料"}读取失败：${result.reason?.message || "请稍后重试"}`); continue; }
        const files = index ? result.value.files || [] : result.value.attachments || result.value.materials || [];
        if (result.value.truncated) warnings.push(`${index ? "工作成果" : "材料"}仅显示部分文件。`);
        for (const item of files) {
          const name = item.name || item.path || "文件", extension = name.match(/\.([a-z0-9]{1,5})$/i)?.[1]?.toUpperCase();
          const row = node("div", "group-share-item"); row.setAttribute("role", "listitem");
          const badge = node("span", "group-share-file-icon", extension || "FILE"); badge.setAttribute("aria-hidden", "true");
          const copy = node("div", "group-share-file-copy"), title = node("strong", "group-share-file-name", name);
          title.title = name;
          const size = Number.isFinite(item.size) && item.size >= 0 ? item.size < 1024 ? `${item.size} B`
            : item.size < 1024 * 1024 ? `${(item.size / 1024).toFixed(1)} KB` : `${(item.size / (1024 * 1024)).toFixed(1)} MB` : "";
          copy.append(title, node("span", "group-share-file-meta", [index ? "工作成果" : "材料", size].filter(Boolean).join(" · ")));
          row.append(badge, copy);
          const mutationId = crypto.randomUUID();
          const action = button("分享", async () => {
            if (action.disabled || id() !== groupId || current()?.group?.archived) return;
            action.disabled = true; action.textContent = "分享中…";
            try { await api.share(groupId, { agentId, ...(index ? { path: item.path } : { attachmentId: item.id }), mutationId });
              if (id() !== groupId) return;
              await refresh(groupId);
              if (request !== version) return;
              notice(byId("group-share-status"), "已分享到群组，可在“材料与成果”查看。");
              action.textContent = "✓ 已分享"; action.dataset.state = "shared";
              action.setAttribute("aria-label", `已分享 ${name}`);
            } catch (error) {
              if (request !== version || id() !== groupId) return;
              notice(byId("group-share-status"), error.message, true); action.disabled = false; action.textContent = "分享";
            }
          }, "primary group-share-action");
          action.setAttribute("aria-label", `分享 ${name} 给当前群组`);
          row.append(action); target.append(row); count++;
        }
      }
      byId("group-share-count").textContent = String(count);
      if (!count) shareEmpty(warnings.length ? "文件暂时无法读取" : "这个智能体还没有文件", "可以选择其他智能体，或先在它的对话中上传材料、生成成果。");
      notice(byId("group-share-status"), warnings.join(" "), Boolean(warnings.length));
    } catch (error) { if (request === version) notice(byId("group-share-status"), error.message, true); }
  }
  function shareEmpty(title, description = "") {
    const state = node("div", "group-share-empty"); state.setAttribute("role", "status");
    state.append(node("strong", "", title));
    if (description) state.append(node("p", "", description));
    byId("group-share-list").replaceChildren(state);
  }
  async function sharing() {
    const groupId = id(), request = ++version;
    shareMenu.close(); shareAgents = [];
    const select = byId("group-share-agent"); select.replaceChildren(); select.disabled = true; shareMenu.refresh();
    byId("group-share-agent-value").textContent = "正在读取智能体…";
    byId("group-share-destination").textContent = current()?.group?.name || "当前群组";
    byId("group-share-count").textContent = "0"; notice(byId("group-share-status"), ""); shareEmpty("正在读取文件…");
    open("group-share-dialog", byId("group-share-open"));
    try {
      const result = await api.agents(); if (id() !== groupId || request !== version) return;
      shareAgents = result.agents || [];
      for (const agent of shareAgents) { const option = node("option", "", agent.name); option.value = agent.id; select.append(option); }
      select.value = shareAgents[0]?.id || "";
      select.disabled = !shareAgents.length; shareMenu.refresh();
      if (!shareAgents.length) byId("group-share-agent-value").textContent = "暂无智能体";
      await shareList();
    } catch (error) {
      if (request !== version || id() !== groupId) return;
      byId("group-share-agent-value").textContent = "智能体暂时无法读取";
      shareEmpty("暂时无法读取文件", "关闭后重新打开，可再次尝试。"); notice(byId("group-share-status"), error.message, true);
    }
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
