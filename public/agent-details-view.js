export const agentIconChoices = [["📚", "书籍"], ["✍️", "写作"], ["🔎", "研究"], ["💼", "工作"], ["🧩", "工具"], ["💡", "灵感"]];

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
