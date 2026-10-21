import { saveArtifactDownload } from "./artifact-download.js";

const labels = { queued: "排队中", running: "处理中", completed: "已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断" };
export function createApplicationTasks({ document, api, list, status, onArtifacts = () => {}, onCompleted = () => {}, onChanged = () => {} }) {
  let agentId = null, generation = 0, timer = null, requestSequence = 0;
  let lastSnapshot = "";
  const rows = new Map(), notified = new Set(), downloading = new Set();
  const sequences = new Map();
  const node = (tag, text, className = "") => { const value = document.createElement(tag); value.textContent = text; value.className = className; return value; };
  const active = (task) => ["queued", "running"].includes(task.status);
  async function refresh() {
    const id = agentId, version = generation, sequence = ++requestSequence;
    if (!id) return;
    clearTimeout(timer);
    try {
      const result = await api.tasks(id);
      if (id !== agentId || generation !== version || sequence !== requestSequence) return;
      const tasks = result.tasks || [], running = tasks.filter(active);
      status.textContent = running.length ? `${running.length} 项任务进行中` : tasks.length ? "任务记录已同步" : "尚未开始任务";
      const snapshot = JSON.stringify(tasks);
      if (snapshot === lastSnapshot) return;
      lastSnapshot = snapshot;
      for (const task of tasks) {
        const taskId = task.id || task.taskId, sequence = task.sequence;
        if (Number.isSafeInteger(sequence) && sequence > (sequences.get(taskId) ?? -1)) {
          sequences.set(taskId, sequence); onChanged(task);
        }
      }
      const expanded = new Set([...rows].filter(([, row]) => row.result?.open).map(([id]) => id));
      let focus;
      for (const [id, row] of rows) for (const [key, control] of Object.entries(row)) if (control === document.activeElement) focus = { id, key };
      rows.clear();
      list.replaceChildren();
      if (!tasks.length) list.append(node("p", "从页面开始一项任务。切换页面后，任务会继续处理。", "muted-note small"));
      for (const task of tasks.slice(-30).reverse()) {
        const taskId = task.id || task.taskId, controls = {};
        rows.set(taskId, controls);
        const row = node("article", "", "application-task"), heading = node("div", "", "application-task-heading");
        heading.append(node("strong", task.title || task.actionId || "应用任务"), node("span", labels[task.status] || "状态待确认", "application-task-status"));
        row.append(heading);
        const progress = typeof task.progress === "string" ? task.progress : task.progress?.message || task.progress?.label;
        const error = typeof task.error === "string" ? task.error : task.error?.message;
        if (progress || error) row.append(node("p", error || progress, error ? "error small" : "muted-note small"));
        if (task.result !== undefined && task.result !== null) {
          const details = node("details", "", "application-task-result");
          controls.result = details; controls.summary = node("summary", "查看结果"); details.open = expanded.has(taskId);
          details.append(controls.summary, node("pre", (typeof task.result === "string" ? task.result : JSON.stringify(task.result, null, 2)).slice(0, 12000)));
          row.append(details);
        }
        if (active(task)) {
          const cancel = node("button", "取消任务", "ghost-button"); cancel.type = "button";
          controls.cancel = cancel;
          cancel.addEventListener("click", async () => {
            cancel.disabled = true;
            try { await api.cancel(id, taskId); await refresh(); }
            catch (error) { if (id === agentId) { status.textContent = error.message || "取消尚未确认，请重试。"; cancel.disabled = false; } }
          }); row.append(cancel);
        }
        if (task.artifacts?.length) {
          for (const [index, artifact] of task.artifacts.entries()) {
            const file = node("div"), actions = node("div", "", "application-task-heading"), path = artifact.path || artifact.name || `产物 ${index + 1}`;
            file.append(node("p", path, "muted-note small"));
            const preview = node("button", "预览", "ghost-button"), download = node("button", "下载完整文件", "ghost-button");
            const downloadKey = `${version}:${taskId}:${index}`, controlKey = `artifactDownload_${index}`;
            preview.type = download.type = "button";
            preview.setAttribute("aria-label", `预览 ${path}`); download.setAttribute("aria-label", `下载完整文件 ${path}`);
            if (downloading.has(downloadKey)) { download.disabled = true; download.textContent = "正在准备下载…"; download.setAttribute("aria-busy", "true"); }
            controls[`artifactPreview_${index}`] = preview; controls[controlKey] = download;
            preview.addEventListener("click", () => { if (id === agentId && version === generation) onArtifacts({ agentId: id, taskId, index, artifact }); });
            download.addEventListener("click", async () => {
              if (id !== agentId || version !== generation || downloading.has(downloadKey)) return;
              downloading.add(downloadKey);
              download.disabled = true; download.setAttribute("aria-busy", "true");
              download.textContent = "正在准备下载…";
              try {
                await saveArtifactDownload({ document, api, parent: list, agentId: id, taskId, index, name: path,
                  isCurrent: () => id === agentId && version === generation });
                if (id === agentId && version === generation) status.textContent = "完整文件已准备好下载。";
              } catch (error) { if (id === agentId && version === generation) status.textContent = error.message || "文件下载未完成，请重试。"; }
              finally {
                downloading.delete(downloadKey);
                const current = id === agentId && version === generation ? rows.get(taskId)?.[controlKey] : null;
                if (current) { current.disabled = false; current.setAttribute("aria-busy", "false"); current.textContent = "下载完整文件"; }
              }
            });
            actions.append(preview, download); file.append(actions); row.append(file);
          }
          if (!active(task) && !notified.has(taskId)) { notified.add(taskId); onCompleted(id); }
        }
        list.append(row);
      }
      if (focus) rows.get(focus.id)?.[focus.key]?.focus({ preventScroll: true });
    } catch (error) { if (id === agentId && version === generation && sequence === requestSequence) status.textContent = error.message || "任务记录暂时无法读取。"; }
    finally { if (id === agentId && version === generation && sequence === requestSequence) timer = setTimeout(refresh, 3000); }
  }
  return { start(id) {
    if (agentId === id) return;
    agentId = id; generation++; lastSnapshot = ""; rows.clear(); notified.clear(); sequences.clear(); downloading.clear(); list.replaceChildren();
    status.textContent = "正在读取任务…"; void refresh();
  }, refresh,
    stop() {
      agentId = null; generation++; clearTimeout(timer); rows.clear(); downloading.clear();
      list.replaceChildren(); status.textContent = "尚未开始任务";
    } };
}
