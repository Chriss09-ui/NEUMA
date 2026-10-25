import { isJavaScript, sourceTreeFiles, type HygieneResult } from "./hygiene-tree.mjs";

// 源码树中允许存在的自有 JavaScript；新增或移除条目都必须写明理由，条目失效会被报告。
const ALLOWED_JAVASCRIPT = new Map([
  ["scripts/build.mjs", "唯一自有 JS 例外：严格编译前的薄引导器（AGENTS.md 约定）"],
]);

// 明确残留：检查源码树里误生成的同名产物、未迁移的自有 JavaScript 和已失效的白名单条目。
export async function checkLeftoverFiles(root: string): Promise<HygieneResult> {
  const files = await sourceTreeFiles(root);
  const present = new Set(files);
  const violations: HygieneResult["violations"] = [];
  for (const path of files) {
    if (!isJavaScript(path) || ALLOWED_JAVASCRIPT.has(path)) continue;
    const base = path.replace(/\.(?:js|mjs|cjs)$/, "");
    const twin = [".ts", ".mts", ".cts"].find((extension) => present.has(base + extension));
    if (twin) violations.push({ file: path, rule: "残留/同名覆盖", message: `与 ${base + twin} 同名的 JavaScript 会覆盖编译产物，请删除误生成文件` });
    else violations.push({ file: path, rule: "残留/未迁移JS", message: "自有 JavaScript 源码必须迁移为 TypeScript；如确属夹具请在白名单登记理由" });
  }
  for (const path of ALLOWED_JAVASCRIPT.keys())
    if (!present.has(path)) violations.push({ file: path, rule: "残留/白名单失效", message: "白名单中的 JavaScript 已不存在，请更新 scripts/hygiene-leftovers.mts" });
  return { violations, notes: [`扫描 ${files.length} 个源码文件，JavaScript 白名单：${[...ALLOWED_JAVASCRIPT.keys()].join("、")}`] };
}
