import { node } from "./project-view.js";

export function mountWelcome(container, welcome, hasMessages) {
  if (!hasMessages) container.append(welcome);
}

export function addUserMessage(messages, content) {
  const last = messages.at(-1);
  const previous = last?.role === "assistant" && ["error", "stopped"].includes(last.status) ? messages.at(-2) : last;
  if (previous?.role === "user" && ["failed", "stopped"].includes(previous.delivery) && previous.content === content) {
    if (last !== previous) messages.pop();
    previous.delivery = "pending";
    return previous;
  }
  const message = { role: "user", content, delivery: "pending" };
  messages.push(message);
  return message;
}

export function recoverInput(input, content) {
  if (!input.value.trim()) input.value = content;
  else if (input.value.trim() !== content) input.value += `\n\n${content}`;
  input.dispatchEvent(new Event("input"));
  input.focus();
}

export function renderUserMessage(message, input) {
  const row = node("div", "message user");
  row.append(node("div", "message-label", "你"), node("div", "bubble", message.content));
  if (["failed", "stopped"].includes(message.delivery)) {
    const footer = node("div", "message-recovery");
    const edit = node("button", "link-button", "重新编辑"); edit.type = "button";
    edit.addEventListener("click", () => recoverInput(input, message.content));
    footer.append(node("span", "", message.delivery === "stopped" ? "回复已停止" : "本轮未完成"), edit);
    row.append(footer);
  }
  return row;
}

export function createReplyView(label) {
  const row = node("div", "message assistant");
  const bubble = node("div", "bubble");
  const activity = node("div", "reply-activity"); activity.setAttribute("role", "status");
  const indicator = node("span", "thinking-indicator"); indicator.setAttribute("aria-hidden", "true");
  const caption = node("span", "thinking-label");
  const error = node("p", "reply-error");
  activity.append(indicator, caption);
  row.append(node("div", "message-label", label), bubble, activity, error);
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
  return error;
}

export async function readReply(response, onProgress) {
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
    if (!result || typeof result.reply !== "string") throw new Error("连接中断，回复尚未完成。已执行的项目操作可能保留，请先查看项目状态。");
    return result;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
