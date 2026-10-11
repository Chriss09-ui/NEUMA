import { node } from "./project-view.js";

const attachmentTypes = {
  pdf: ["PDF", "PDF 文档", "pdf"], doc: ["DOC", "Word 文档", "document"], docx: ["DOCX", "Word 文档", "document"],
  rtf: ["RTF", "文本文档", "document"], xls: ["XLS", "Excel 表格", "table"], xlsx: ["XLSX", "Excel 表格", "table"],
  csv: ["CSV", "数据表格", "table"], tsv: ["TSV", "数据表格", "table"], ppt: ["PPT", "演示文稿", "slides"], pptx: ["PPTX", "演示文稿", "slides"],
  md: ["MD", "Markdown 文档", "text"], markdown: ["MD", "Markdown 文档", "text"], txt: ["TXT", "文本文档", "text"],
  py: ["PY", "Python 文件", "code"], js: ["JS", "JavaScript 文件", "code"], ts: ["TS", "TypeScript 文件", "code"],
  png: ["PNG", "图片", "image"], jpg: ["JPG", "图片", "image"], jpeg: ["JPG", "图片", "image"],
  webp: ["WEBP", "图片", "image"], gif: ["GIF", "图片", "image"], tif: ["TIFF", "图片", "image"], tiff: ["TIFF", "图片", "image"],
};

export function createAttachmentCard(document, attachment = {}, { className = "", status = "", statusText = "", onOpen } = {}) {
  const element = (tag, className, text = "") => {
    const value = document.createElement(tag); value.className = className; value.textContent = text; return value;
  };
  const name = attachment.name || "已保存的附件", extension = name.split(".").at(-1).toLowerCase();
  const [symbol, type, tone] = attachmentTypes[extension] || (/^[a-z\d]{1,8}$/i.test(extension)
    ? [extension.toUpperCase(), "文件", "file"] : ["FILE", "附件", "file"]);
  const details = [type];
  if (Number.isSafeInteger(attachment.size) && attachment.size > 0) {
    const unit = Math.min(3, Math.floor(Math.log(attachment.size) / Math.log(1024)));
    details.push(`${Number((attachment.size / 1024 ** unit).toFixed(1))} ${["B", "KB", "MB", "GB"][unit]}`);
  }
  const card = element("div", `attachment-card ${className}`.trim());
  card.dataset.tone = tone;
  if (status) card.dataset.status = status;
  const open = element("button", "attachment-card-open"); open.type = "button"; open.disabled = !onOpen; open.title = name;
  open.setAttribute("aria-label", onOpen ? `预览 ${name}` : name);
  if (onOpen) open.addEventListener("click", onOpen);
  const icon = element("span", "attachment-card-icon", symbol); icon.setAttribute("aria-hidden", "true");
  const body = element("span", "attachment-card-body");
  body.append(element("span", "attachment-card-name", name), element("span", "attachment-card-meta", details.join(" · ")));
  if (statusText) {
    const state = element("span", "attachment-card-status", statusText); state.setAttribute("role", "status"); body.append(state);
  }
  open.append(icon, body); card.append(open);
  return card;
}

export function mountWelcome(container, welcome, hasMessages) {
  if (!hasMessages) container.append(welcome);
}

export function addUserMessage(messages, content, attachments = []) {
  const last = messages.at(-1);
  const previous = last?.role === "assistant" && ["error", "stopped"].includes(last.status) ? messages.at(-2) : last;
  if (previous?.role === "user" && ["failed", "stopped"].includes(previous.delivery) && previous.content === content
    && JSON.stringify(previous.attachments || []) === JSON.stringify(attachments)) {
    if (last !== previous) messages.pop();
    previous.delivery = "pending";
    return previous;
  }
  const message = { role: "user", content, delivery: "pending", ...(attachments.length ? { attachments: attachments.map(({ id }) => ({ id })) } : {}) };
  messages.push(message);
  return message;
}

export function recoverInput(input, content) {
  if (content.trim()) {
    if (!input.value.trim()) input.value = content;
    else if (input.value.trim() !== content) input.value += `\n\n${content}`;
  }
  input.dispatchEvent(new Event("input"));
  input.focus();
}

export function renderUserMessage(message, input, { attachmentLabel = () => "已保存的附件", attachmentInfo, onAttachment, onRecover } = {}) {
  const row = node("div", "message user");
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", "发送的消息");
  if (message.attachments?.length) {
    const files = node("div", "message-attachments");
    files.setAttribute("role", "group"); files.setAttribute("aria-label", "发送的附件");
    for (const attachment of message.attachments) {
      const file = createAttachmentCard(document, attachmentInfo?.(attachment) || { name: attachmentLabel(attachment) }, {
        className: "message-attachment", onOpen: onAttachment ? () => onAttachment(attachment) : undefined,
      });
      files.append(file);
    }
    row.append(files);
  }
  if (message.content) row.append(node("div", "bubble", message.content));
  if (["failed", "stopped"].includes(message.delivery)) {
    const footer = node("div", "message-recovery");
    const edit = node("button", "link-button", "重新编辑"); edit.type = "button";
    edit.addEventListener("click", () => { recoverInput(input, message.content); onRecover?.(message); });
    footer.append(node("span", "", message.delivery === "stopped" ? "回复已停止" : "本轮未完成"), edit);
    row.append(footer);
  }
  return row;
}

export function createReplyView(label) {
  const row = node("div", "message assistant");
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", `${label}的回复`);
  const bubble = node("div", "bubble");
  const activity = node("div", "reply-activity"); activity.setAttribute("role", "status");
  const indicator = node("span", "thinking-indicator"); indicator.setAttribute("aria-hidden", "true");
  const caption = node("span", "thinking-label");
  const error = node("p", "reply-error");
  activity.append(indicator, caption);
  row.append(bubble, activity, error);
  return {
    row,
    update(message) {
      if (bubble.textContent !== message.content) bubble.textContent = message.content || "";
      bubble.hidden = !message.content;
      const pending = !["complete", "error", "stopped"].includes(message.status);
      bubble.classList.toggle("streaming", pending && Boolean(message.content));
      bubble.setAttribute("aria-live", pending ? "off" : "polite");
      activity.hidden = message.status === "complete";
      activity.classList.toggle("settled", !pending);
      const text = message.status === "stopped" ? "已停止回复" : message.status === "error" ? "回复未完成"
        : message.status === "stopping" ? "正在停止…" : message.status === "writing" ? "正在回复…"
          : message.label || "正在思考…";
      if (caption.textContent !== text) caption.textContent = text;
      error.textContent = message.error || "";
      error.hidden = !message.error;
    },
  };
}

function replyError(payload) {
  const error = new Error(payload.error || "回复中断，请检查连接后重试。");
  error.reason = payload.diagnostic?.reason;
  error.diagnostic = payload.diagnostic ?? null;
  return error;
}

export async function readReply(response, onProgress, {
  incompleteMessage = "连接中断，回复尚未完成。已执行的项目操作可能保留，请先查看项目状态。",
  isComplete = (result) => typeof result?.reply === "string",
} = {}) {
  if (!response.headers.get("content-type")?.includes("application/x-ndjson")) {
    const result = await response.json();
    if (!response.ok) throw replyError(result);
    return result;
  }
  if (!response.body) throw new Error("无法读取回复，请重试。");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "", result;
  const processLine = (line) => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); }
    catch { throw new Error("回复数据不完整，请检查连接后重试。"); }
    if (event.type === "error") throw replyError(event);
    if (event.type === "done") result = event.result;
    else onProgress(event);
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        processLine(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      }
      if (done) break;
    }
    processLine(buffer);
    if (!isComplete(result)) throw new Error(incompleteMessage);
    return result;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
