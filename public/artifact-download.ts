import type { DownloadElement, DownloadDocument } from "./application-dom.js";
import type { createApplicationApi } from "./application-api.js";
export async function saveArtifactDownload<E extends DownloadElement<E> = HTMLElement>({ document, api, parent, agentId, taskId, index, name, isCurrent = () => true }: { document: DownloadDocument<E>; api: Pick<ReturnType<typeof createApplicationApi>, "downloadArtifact">; parent: NoInfer<E>; agentId: string; taskId: string; index: number; name: string; isCurrent?: (() => boolean) | undefined }) {
  return saveFileDownload({ document, parent, name, isCurrent, read: () => api.downloadArtifact(agentId, taskId, index) });
}

export async function saveFileDownload<E extends DownloadElement<E> = HTMLElement>({ document, parent, name, read, isCurrent = () => true }: { document: DownloadDocument<E>; parent: NoInfer<E>; name: string; read: () => Promise<Blob>; isCurrent?: (() => boolean) | undefined }) {
  const blob = await read();
  if (!isCurrent()) return;
  const view = document.defaultView || globalThis, url = view.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = name.split("/").at(-1) || "artifact"; link.hidden = true;
  try { (document.querySelector?.("dialog[open]") || parent).append(link); link.click(); }
  finally { link.remove(); view.setTimeout(() => view.URL.revokeObjectURL(url), 30_000); }
}
