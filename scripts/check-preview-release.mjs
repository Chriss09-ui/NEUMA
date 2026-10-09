import { constants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

const ENTRY_FILES = ["bin/neuma.cjs", "installation-cli.mjs", "installation-runtime.mjs",
  "app-metadata.mjs", "server.mjs", "public/index.html"];
const PREVIEW_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-preview\.(0|[1-9]\d*)$/;
const SCOPED_NAME = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;

async function readJson(root, path, failures) {
  try {
    const value = JSON.parse(await readFile(join(root, path), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { failures.push(`无法读取有效的 ${path}`); return null; }
}

export async function checkPreviewRelease(root) {
  const failures = [];
  const manifest = await readJson(root, "package.json", failures);
  const lock = await readJson(root, "package-lock.json", failures);
  const shrinkwrap = await readJson(root, "npm-shrinkwrap.json", failures);
  if (manifest) {
    if (typeof manifest.name !== "string" || manifest.name.length > 214 || !SCOPED_NAME.test(manifest.name))
      failures.push("试用包需要有效的 scoped npm 包名，例如 @账号/neuma");
    if (typeof manifest.version !== "string" || !PREVIEW_VERSION.test(manifest.version))
      failures.push("试用版版本号必须使用 preview.N，不能发布稳定版版本号");
    if (manifest.private !== false) failures.push("公开试用包必须明确设置 private: false");
    if (!isDeepStrictEqual(manifest.os, ["darwin"]) || !isDeepStrictEqual(manifest.cpu, ["arm64"]))
      failures.push("本次试用版只支持 Apple 芯片 Mac：os 为 darwin，cpu 为 arm64");
    if (!isDeepStrictEqual(manifest.bin, { neuma: "bin/neuma.cjs" }))
      failures.push("命令入口必须为 neuma: bin/neuma.cjs");
    if (manifest.publishConfig?.access !== "public" || manifest.publishConfig?.tag !== "preview"
      || manifest.publishConfig?.registry !== "https://registry.npmjs.org/")
      failures.push("发布配置必须使用 public、preview 标签和官方 npm registry");
    if (!manifest.dependencies || typeof manifest.dependencies !== "object" || Array.isArray(manifest.dependencies))
      failures.push("包的 dependencies 必须明确声明");
    if (lock && (lock.name !== manifest.name || lock.version !== manifest.version
      || lock.packages?.[""]?.name !== manifest.name || lock.packages?.[""]?.version !== manifest.version
      || ["dependencies", "os", "cpu", "bin"].some((key) => !isDeepStrictEqual(lock.packages?.[""]?.[key], manifest[key]))))
      failures.push("包名、版本、依赖或安装范围与 package-lock.json 不一致");
  }
  if (lock && shrinkwrap && !isDeepStrictEqual(shrinkwrap, lock))
    failures.push("npm-shrinkwrap.json 与 package-lock.json 不一致");
  for (const path of ENTRY_FILES) {
    try {
      const info = await lstat(join(root, path));
      if (!info.isFile() || info.size < 1) throw new Error();
      await access(join(root, path), constants.R_OK);
    } catch { failures.push(`缺少可读的入口文件：${path}`); }
  }
  return { ok: failures.length === 0, failures };
}

if (process.argv[1] && await realpath(resolve(process.argv[1])).catch(() => null) === fileURLToPath(import.meta.url)) {
  const result = await checkPreviewRelease(dirname(dirname(fileURLToPath(import.meta.url))));
  if (!result.ok) {
    process.stderr.write("尚不能发布 Apple 芯片 Mac 试用版：\n" + result.failures.map((value) => `- ${value}`).join("\n") + "\n");
    process.exitCode = 1;
  } else process.stdout.write("Apple 芯片 Mac 试用版配置检查通过；此检查不代表三平台完整验收。\n");
}
