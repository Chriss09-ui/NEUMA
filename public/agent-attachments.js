export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENTS = 10;

const draftKey = (agentId, conversationId) => `${agentId}/${conversationId}`;
const statusLabel = { uploading: "正在上传…", cancelled: "上传已取消", error: "上传失败", ready: "已添加" };

export class AgentAttachments {
  constructor({ api, onChange = () => {} }) {
    this.api = api; this.onChange = onChange;
    this.drafts = new Map(); this.materials = new Map(); this.resolving = new Map();
  }

  state(agentId, conversationId) {
    const key = draftKey(agentId, conversationId);
    if (!this.drafts.has(key)) this.drafts.set(key, { items: [], error: "" });
    return this.drafts.get(key);
  }

  remember(agentId, attachment) {
    if (!attachment || typeof attachment.id !== "string" || !attachment.id) throw new Error("上传结果尚未确认，请重试。");
    if (!this.materials.has(agentId)) this.materials.set(agentId, new Map());
    this.materials.get(agentId).set(attachment.id, attachment);
    return attachment;
  }

  material(agentId, id) { return this.materials.get(agentId)?.get(id); }
  hydrate(agentId, refs) {
    for (const { id } of refs) {
      const key = `${agentId}/${id}`;
      if (this.material(agentId, id) || this.resolving.has(key)) continue;
      const operation = { controller: new AbortController() }; this.resolving.set(key, operation);
      void this.api.getAttachment(agentId, id, { signal: operation.controller.signal }).then(({ attachment }) => {
        if (this.resolving.get(key) !== operation) return;
        this.remember(agentId, attachment); this.onChange(agentId);
      }).catch(() => {}).finally(() => { if (this.resolving.get(key) === operation) this.resolving.delete(key); });
    }
  }
  refs(agentId, conversationId) { return this.state(agentId, conversationId).items.filter((item) => item.status === "ready").map((item) => ({ id: item.id })); }
  blocked(agentId, conversationId) { return this.state(agentId, conversationId).items.some((item) => item.status !== "ready"); }

  async upload(agentId, conversationId, files) {
    const state = this.state(agentId, conversationId), selected = Array.from(files || []);
    if (selected.length + state.items.length > MAX_MESSAGE_ATTACHMENTS) {
      state.error = "每条消息最多添加 10 份材料。"; this.onChange(agentId, conversationId); return;
    }
    if (selected.some((file) => !file.name || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_ATTACHMENT_BYTES)) {
      state.error = "请选择非空文件，单份材料最多 50 MiB。"; this.onChange(agentId, conversationId); return;
    }
    state.error = "";
    const items = selected.map((file) => ({ key: crypto.randomUUID(), file, name: file.name, size: file.size, status: "uploading" }));
    state.items.push(...items);
    return Promise.all(items.map((item) => this.start(agentId, conversationId, item)));
  }

  async start(agentId, conversationId, item) {
    const state = this.state(agentId, conversationId), controller = new AbortController();
    item.controller = controller; item.status = "uploading"; item.error = "";
    this.onChange(agentId, conversationId);
    const valid = () => this.drafts.get(draftKey(agentId, conversationId)) === state
      && state.items.includes(item) && item.controller === controller;
    try {
      const result = await this.api.uploadAttachment(agentId, item.file, { signal: controller.signal });
      controller.signal.throwIfAborted();
      if (!valid()) return;
      const attachment = this.remember(agentId, result.attachment);
      Object.assign(item, { id: attachment.id, name: attachment.name || item.name, status: "ready" });
      item.file = null;
    } catch (error) {
      if (!valid()) return;
      item.status = controller.signal.aborted ? "cancelled" : "error";
      item.error = controller.signal.aborted ? "" : error.message || "上传失败，请重试。";
    } finally {
      if (valid()) { item.controller = null; this.onChange(agentId, conversationId); }
    }
  }

  cancel(agentId, conversationId, item) { item.controller?.abort(); item.status = "cancelled"; this.onChange(agentId, conversationId); }
  retry(agentId, conversationId, item) { if (item.file && item.status !== "uploading") return this.start(agentId, conversationId, item); }
  remove(agentId, conversationId, item) {
    const state = this.state(agentId, conversationId);
    item.controller?.abort(); state.items = state.items.filter((entry) => entry !== item);
    state.error = ""; this.onChange(agentId, conversationId);
  }

  restore(agentId, conversationId, refs) {
    const state = this.state(agentId, conversationId);
    for (const ref of refs || []) {
      if (state.items.some((item) => item.id === ref.id)) continue;
      if (state.items.length >= MAX_MESSAGE_ATTACHMENTS) { state.error = "待发送材料已满，请先移除一些材料再重新编辑。"; break; }
      state.items.push({ key: crypto.randomUUID(), id: ref.id, name: this.material(agentId, ref.id)?.name || "已保存的附件", status: "ready" });
    }
    this.onChange(agentId, conversationId);
  }

  select(agentId, conversationId, attachment) {
    this.remember(agentId, attachment); this.restore(agentId, conversationId, [{ id: attachment.id }]);
  }
  consume(agentId, conversationId) { const state = this.state(agentId, conversationId); state.items = []; state.error = ""; }
  clear(agentId, conversationId) {
    for (const [key, state] of this.drafts) if (key.startsWith(`${agentId}/`) && (!conversationId || key === draftKey(agentId, conversationId))) {
      for (const item of state.items) item.controller?.abort();
      this.drafts.delete(key);
    }
    if (!conversationId) {
      this.materials.delete(agentId);
      for (const [key, operation] of this.resolving) if (key.startsWith(`${agentId}/`)) {
        operation.controller.abort(); this.resolving.delete(key);
      }
    }
  }
}

export function createAgentAttachmentView({ document, api, attachments, onChange = () => {}, urlApi = globalThis.URL }) {
  const byId = (id) => document.getElementById(id);
  const list = byId("agent-attachment-list"), error = byId("agent-attachment-error"), chooser = byId("agent-attachment-input");
  const add = byId("agent-attachment-add"), picker = byId("agent-attachment-pick"), form = byId("agent-chat-form");
  const dialog = byId("agent-material-dialog"), materials = byId("agent-material-list"), feedback = byId("agent-material-feedback");
  const preview = byId("agent-material-preview"), name = byId("agent-material-name"), download = byId("agent-material-download");
  let context = null, generation = 0, reading = null, returnFocus = null, pageImageUrl = null;
  const node = (tag, className, text = "") => {
    const element = document.createElement(tag); element.className = className; element.textContent = text; return element;
  };
  const button = (text, handler, className = "ghost-button") => {
    const element = node("button", className, text); element.type = "button"; element.addEventListener("click", handler); return element;
  };
  const clearPreview = () => {
    preview.replaceChildren();
    if (pageImageUrl) { urlApi.revokeObjectURL(pageImageUrl); pageImageUrl = null; }
  };
  const close = () => {
    generation++; reading?.abort(); reading = null;
    if (dialog.open) { if (dialog.close) dialog.close(); else dialog.open = false; }
    clearPreview(); materials.replaceChildren(); download.hidden = true;
    name.textContent = "选择一份材料"; feedback.textContent = "";
    returnFocus?.focus?.(); returnFocus = null;
  };

  function render() {
    if (!context) return;
    const { agentId, conversationId, disabled } = context, state = attachments.state(agentId, conversationId);
    list.replaceChildren(); list.hidden = !state.items.length;
    error.textContent = state.error || ""; error.hidden = !state.error;
    add.disabled = picker.disabled = disabled || state.items.length >= MAX_MESSAGE_ATTACHMENTS;
    chooser.disabled = disabled;
    for (const item of state.items) {
      const material = attachments.material(agentId, item.id) || { name: item.name, size: item.size };
      const tag = createAttachmentCard(document, material, { className: "agent-attachment-tag", status: item.status,
        statusText: item.status === "ready" ? "" : item.error || statusLabel[item.status],
        onOpen: item.id ? () => showPreview(agentId, item.id) : undefined });
      const actions = node("div", "attachment-card-actions");
      if (item.status === "uploading") actions.append(button("取消", () => attachments.cancel(agentId, conversationId, item), "attachment-card-action"));
      if (["error", "cancelled"].includes(item.status)) actions.append(button("重试", () => attachments.retry(agentId, conversationId, item), "attachment-card-action"));
      const remove = button("×", () => attachments.remove(agentId, conversationId, item), "attachment-card-remove");
      remove.setAttribute("aria-label", `移除 ${item.name}`); actions.append(remove); tag.append(actions); list.append(tag);
    }
  }

  function openDialog(focus) {
    if (!dialog.open) {
      returnFocus = focus || document.activeElement;
      if (dialog.showModal) dialog.showModal(); else dialog.open = true;
      byId("agent-material-close").focus();
    }
  }

  async function loadMaterials() {
    if (!context || context.disabled) return;
    const captured = context, sequence = ++generation;
    reading?.abort(); reading = new AbortController();
    openDialog(picker); materials.replaceChildren(); clearPreview(); download.hidden = true;
    name.textContent = "选择一份材料"; feedback.textContent = "正在读取材料…";
    try {
      const result = await api.listAttachments(captured.agentId, { signal: reading.signal });
      if (sequence !== generation || context !== captured) return;
      if (!Array.isArray(result.attachments)) throw new Error("材料列表尚未确认，请重试。");
      feedback.textContent = result.attachments.length ? "仅显示这个智能体的材料" : "还没有材料，可以先上传文件。";
      for (const attachment of result.attachments) {
        attachments.remember(captured.agentId, attachment);
        const row = node("div", "agent-material-row");
        row.append(button(attachment.name, () => showPreview(captured.agentId, attachment.id), "agent-material-title"));
        const select = button("添加", () => {
          if (context !== captured || context.disabled) return;
          attachments.select(captured.agentId, captured.conversationId, attachment); close();
        }, "secondary");
        select.disabled = attachment.status === "failed"; row.append(select); materials.append(row);
      }
      onChange(captured.agentId);
    } catch (failure) { if (sequence === generation && context === captured) feedback.textContent = failure.message || "材料读取失败，请重试。"; }
  }

  async function showPreview(agentId, id, offset = 0, append = false, pdfPage = 1) {
    if (!id || context?.agentId !== agentId) return;
    const captured = context, sequence = ++generation, pageFocus = document.activeElement?.dataset?.pageAction;
    reading?.abort(); const controller = new AbortController(); reading = controller;
    openDialog(document.activeElement);
    if (!append) clearPreview();
    download.hidden = true; feedback.textContent = "正在读取预览…";
    try {
      const attachment = attachments.material(agentId, id) || (await api.getAttachment(agentId, id, { signal: controller.signal })).attachment;
      if (sequence !== generation || context !== captured) return;
      attachments.remember(agentId, attachment); name.textContent = attachment.name;
      download.href = api.attachmentRawUrl(agentId, id, true); download.download = attachment.name; download.hidden = false;
      if (attachment.kind === "image" || attachment.mimeType?.startsWith("image/")) {
        const image = node("img", "agent-material-image"); image.alt = attachment.name; image.src = api.attachmentImageUrl(agentId, id);
        image.addEventListener("error", () => { if (sequence === generation) feedback.textContent = "图片预览失败，可以下载原文件。"; });
        preview.append(image);
      } else if (attachment.kind === "pdf" || attachment.mimeType === "application/pdf") {
        feedback.textContent = `正在生成第 ${pdfPage} 页预览…`;
        const result = await api.readAttachmentImage(agentId, id, pdfPage, { signal: controller.signal });
        if (sequence !== generation || context !== captured) return;
        pageImageUrl = urlApi.createObjectURL(result.blob);
        const image = node("img", "agent-material-image"); image.alt = `${attachment.name}，第 ${result.page} 页`; image.src = pageImageUrl;
        const navigation = node("div", "agent-material-pages");
        const previous = button("上一页", () => showPreview(agentId, id, 0, false, result.page - 1), "secondary");
        const next = button("下一页", () => showPreview(agentId, id, 0, false, result.page + 1), "secondary");
        previous.dataset.pageAction = "previous"; next.dataset.pageAction = "next";
        previous.disabled = result.page <= 1;
        next.disabled = !result.pageCount || result.page >= result.pageCount;
        navigation.append(previous, node("span", "", `第 ${result.page}${result.pageCount ? ` / ${result.pageCount}` : ""} 页`), next);
        preview.append(navigation, image);
        if (pageFocus) {
          const focused = pageFocus === "previous" ? previous : next;
          (focused.disabled ? (focused === next ? previous : next) : focused).focus();
        }
      } else {
        const result = await api.previewAttachment(agentId, id, offset, { signal: controller.signal });
        if (sequence !== generation || context !== captured) return;
        preview.append(node("pre", "agent-file-text", result.text || "没有可预览的文字。"));
        if (Number.isSafeInteger(result.nextOffset) && result.nextOffset > offset) {
          const more = button("继续读取", () => { more.remove?.(); return showPreview(agentId, id, result.nextOffset, true); }, "secondary"); preview.append(more);
        }
      }
      feedback.textContent = "只读预览；原文件可下载";
      onChange(agentId);
    } catch (failure) { if (sequence === generation && context === captured) feedback.textContent = failure.message || "预览失败，可以下载原文件。"; }
  }

  add.addEventListener("click", () => { if (context && !context.disabled) chooser.click(); });
  chooser.addEventListener("change", () => {
    if (!context || context.disabled) return;
    const { agentId, conversationId } = context, files = Array.from(chooser.files || []); chooser.value = "";
    return attachments.upload(agentId, conversationId, files);
  });
  form.addEventListener("dragover", (event) => { event.preventDefault(); if (context && !context.disabled) form.classList.add("is-dragging"); });
  form.addEventListener("dragleave", () => form.classList.remove("is-dragging"));
  form.addEventListener("drop", (event) => {
    event.preventDefault(); form.classList.remove("is-dragging");
    if (context && !context.disabled) return attachments.upload(context.agentId, context.conversationId, event.dataTransfer?.files);
  });
  picker.addEventListener("click", loadMaterials);
  byId("agent-material-refresh").addEventListener("click", loadMaterials);
  byId("agent-material-close").addEventListener("click", close);
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  return {
    setContext(next) {
      if (context?.agentId !== next?.agentId || context?.conversationId !== next?.conversationId) { close(); context = next; }
      else if (context) context.disabled = next.disabled;
      if (context) render();
    },
    render, showPreview, close,
  };
}
import { createAttachmentCard } from "./chat-ui.js";
