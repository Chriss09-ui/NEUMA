import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HygieneResult } from "./hygiene-tree.mjs";

// 文档引用检查：只校验本轮明确维护文档中的本地 Markdown 链接目标。
// docs/ 下仅 docs/typescript-*（迁移记录，已入库跟踪）与 docs/images/（打包资源）属于仓库内目标；
// 其余 docs/ 链接指向本地文档库（独立本地仓库），不以入库状态为前提，只计数不判错。

export const MAINTAINED_DOCS = ["README.md", "AGENTS.md", "ARCHITECTURE.md"] as const;
const REPO_DOC_PREFIXES = ["docs/typescript-", "docs/images/"];

const exists = async (root: string, target: string) => access(join(root, target)).then(() => true, () => false);

export async function checkDocReferences(root: string, documents: readonly { path: string; content: string }[] = []): Promise<HygieneResult> {
  const docs = documents.length ? documents : await Promise.all(MAINTAINED_DOCS.map(async (path) => ({ path, content: await readFile(join(root, path), "utf8") })));
  const violations: HygieneResult["violations"] = [];
  let checked = 0, localLibrary = 0;
  for (const doc of docs) {
    const lines = doc.content.split("\n");
    for (let index = 0; index < lines.length; index++) {
      for (const match of lines[index]!.matchAll(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const text = match[1]!, target = match[2]!;
        if (target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        // 先分离章节再解码，使文件名中的 %23 仍按字面井号核对。
        const fragment = target.indexOf("#");
        let decoded = fragment === -1 ? target : target.slice(0, fragment);
        try { decoded = decodeURIComponent(decoded); } catch { /* 保留原样，按字面路径核对 */ }
        if (decoded.startsWith("docs/") && !REPO_DOC_PREFIXES.some((prefix) => decoded.startsWith(prefix))) { localLibrary++; continue; }
        checked++;
        if (!(await exists(root, decoded)))
          violations.push({ file: doc.path, rule: "文档/失效引用", message: `第 ${index + 1} 行链接「${text}」指向 ${target}，目标在仓库中不存在` });
      }
    }
  }
  return { violations, notes: [`校验 ${docs.length} 份维护文档的 ${checked} 个仓库内链接，本地文档库引用 ${localLibrary} 个未校验`] };
}
