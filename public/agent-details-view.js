import { developmentPhases } from "./agent-runtime.js";

export const agentIconChoices = [["📚", "书籍"], ["✍️", "写作"], ["🔎", "研究"], ["💼", "工作"], ["🧩", "工具"], ["💡", "灵感"]];

export function createDevelopmentView(state, { phase, label, busy = false, stopping = false, tasksOpen, onStart, onStop } = {}, documentRef = document) {
  const make = (tag, className, text = "") => {
    const element = documentRef.createElement(tag); element.className = className; element.textContent = text; return element;
  };
  const record = state.record, activePhase = phase || record?.phase;
  const root = make("section", "development-progress");
  root.setAttribute("aria-label", "研发进度");
  root.setAttribute("tabindex", "-1");
  root.setAttribute("aria-busy", String(busy || state.active));
  const header = make("div", "development-heading"), heading = make("strong", "", "研发进度");
  const status = make("span", "development-state", stopping ? "正在停止研发…" : busy ? "研发进行中" : state.label);
  status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  header.append(heading, status); root.append(header);
  const steps = make("ol", "development-steps"); steps.setAttribute("aria-label", "研发的五个阶段");
  for (const [index, [id, title]] of developmentPhases.entries()) {
    const step = make("li", "development-step");
    if (record?.status === "completed") step.setAttribute("data-state", "complete");
    else if (activePhase === id) { step.setAttribute("data-state", "current"); step.setAttribute("aria-current", "step"); }
    const number = make("span", "development-step-number", String(index + 1)); number.setAttribute("aria-hidden", "true");
    step.append(number, make("span", "", title)); steps.append(step);
  }
  root.append(steps, make("p", "development-summary", stopping ? "正在保存已完成的进度，已有改动会保留。" : label || state.summary));
  const tasks = (Array.isArray(record?.tasks) ? record.tasks : []).filter((task) => task && typeof task.title === "string");
  let taskDetails = null;
  if (tasks.length) {
    const completed = tasks.filter((task) => task.status === "verified").length;
    const details = make("details", "development-tasks"); details.open = tasksOpen ?? (busy || state.active); taskDetails = details;
    details.append(make("summary", "", `任务进度 · ${completed}/${tasks.length} 已通过`));
    const list = make("ul", "development-task-list");
    const labels = { pending: "待开发", active: "开发中", verified: "已通过", blocked: "受阻" };
    for (const task of tasks) {
      const item = make("li", "development-task"); item.setAttribute("data-state", task.status);
      if (task.id === record.currentTaskId) item.setAttribute("aria-current", "true");
      item.append(make("span", "", task.title), make("span", "development-task-status", labels[task.status] || "待确认"));
      list.append(item);
    }
    details.append(list); root.append(details);
  }
  const actions = make("div", "development-actions");
  let start = null, stop = null;
  if (busy || state.active) {
    stop = make("button", "secondary", stopping ? "正在停止…" : "停止研发"); stop.type = "button"; stop.disabled = stopping;
    stop.addEventListener("click", onStop); actions.append(stop);
  } else if (state.canStart || state.canResume) {
    start = make("button", "primary", state.actionLabel); start.type = "button";
    start.addEventListener("click", onStart); actions.append(start);
  }
  root.append(actions);
  return { root, start, stop, taskDetails };
}

export function fileDescription(file) {
  const size = file.size < 1024 ? `${file.size} B` : file.size < 1024 * 1024 ? `${(file.size / 1024).toFixed(1)} KB` : `${(file.size / 1024 / 1024).toFixed(1)} MB`;
  const date = new Date(file.updatedAt);
  const time = Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
  return `${/\.html?$/i.test(file.path) ? "网页" : "文本"} · ${size}${time ? ` · ${time}` : ""}`;
}

export function newestFiles(files) {
  return [...files].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) || a.path.localeCompare(b.path));
}

export function staticArtifactDocument(content, documentRef = document) {
  // The template is inert; generated HTML is only displayed inside an empty-permission sandbox.
  const template = documentRef.createElement("template");
  template.innerHTML = content;
  for (const node of template.content.querySelectorAll("script,meta,base,link,iframe,frame,object,embed,portal,noscript,template,animate,animateMotion,animateTransform,set")) node.remove();
  for (const node of template.content.querySelectorAll("*")) {
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || ["href", "xlink:href", "srcset", "action", "formaction", "ping", "target", "srcdoc", "http-equiv"].includes(name)
        || (name === "src" && !/^data:image\/(png|jpeg|gif|webp);base64,/i.test(attribute.value))) node.removeAttribute(attribute.name);
    }
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${template.innerHTML}</body></html>`;
}
