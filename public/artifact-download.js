export async function saveArtifactDownload({ document, api, parent, agentId, taskId, index, name, isCurrent = () => true }) {
  return saveFileDownload({ document, parent, name, isCurrent, read: () => api.downloadArtifact(agentId, taskId, index) });
}

export async function saveFileDownload({ document, parent, name, read, isCurrent = () => true }) {
  const blob = await read();
  if (!isCurrent()) return;
  const view = document.defaultView || globalThis, url = view.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = name.split("/").at(-1) || "artifact"; link.hidden = true;
  try { (document.querySelector?.("dialog[open]") || parent).append(link); link.click(); }
  finally { link.remove(); view.setTimeout(() => view.URL.revokeObjectURL(url), 30_000); }
}
