import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 与 scripts/build-core.mts 的 TREES 保持一致；hygiene 只读扫描这些源码目录，不访问用户业务数据。
export const SOURCE_TREES = ["src", "public", "test", "scripts", "bin", "native", ".github/scripts", "docs/images"] as const;

export interface HygieneViolation { file: string; rule: string; message: string }
export interface HygieneResult { violations: HygieneViolation[]; notes: string[] }

// 引导器以 ?sourceRoot= 传入源码根；从源码树或 dist 直接运行时回退到相对定位，不依赖进程工作目录。
export const hygieneSourceRoot = () =>
  fileURLToPath(new URL(import.meta.url).searchParams.get("sourceRoot") ?? new URL("../", import.meta.url));

const errorCode = (error: unknown) => error !== null && typeof error === "object" && "code" in error ? error.code : undefined;

// 递归列出源码树内的普通文件，条目使用相对仓库根的正斜杠路径，跳过隐藏项与 node_modules。
export async function sourceTreeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (relative: string) => {
    let entries;
    try { entries = await readdir(join(root, relative), { withFileTypes: true }); }
    catch (error) { if (errorCode(error) === "ENOENT") return; throw error; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  for (const tree of SOURCE_TREES) await walk(tree);
  return files.sort();
}

export const isJavaScript = (path: string) => /\.(?:js|mjs|cjs)$/.test(path);
export const isTypeScript = (path: string) => /\.(?:ts|mts|cts)$/.test(path) && !/\.d\.[cm]?ts$/.test(path);
