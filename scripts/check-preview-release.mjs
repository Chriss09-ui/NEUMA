import { constants } from "node:fs";
import { access, lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

const ENTRY_FILES = ["bin/neuma.cjs", "src/installation/installation-cli.mjs", "src/installation/installation-runtime.mjs",
  "src/app-metadata.mjs", "src/server.mjs", "public/index.html"];
const ALLOWED_FILES = new Set(["src/", "npm-shrinkwrap.json", "bin/", "public/", "scripts/check-release.mjs",
  "scripts/check-preview-release.mjs", "README.md", "docs/images/readme-workspace.jpg", "docs/images/readme-projects.jpg"]);
const PREVIEW_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-preview\.(0|[1-9]\d*)$/;
const SCOPED_NAME = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;

async function readJson(root, path, failures) {
  try {
    const value = JSON.parse(await readFile(join(root, path), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { failures.push(`无法读取有效的 ${path}`); return null; }
}

export async function checkPreviewRelease(root, options = {}) {
  const failures = [];
  const manifest = await readJson(root, "package.json", failures);
  const artifact = options.artifact ?? Boolean(manifest?.neumaBuild);
  const lock = artifact ? null : await readJson(root, "package-lock.json", failures);
  const shrinkwrap = await readJson(root, "npm-shrinkwrap.json", failures);
  if (manifest) {
    if (!Array.isArray(manifest.files) || !manifest.files.includes("src/"))
      failures.push("发布文件清单必须包含完整源码目录 src/");
    if (Array.isArray(manifest.files) && manifest.files.some((path) => !ALLOWED_FILES.has(path)))
      failures.push("发布文件清单只能包含已批准的程序、文档和资源路径，禁止扩大范围或加入用户数据与依赖目录");
    if (["bundleDependencies", "bundledDependencies"].some((key) => manifest[key] !== undefined
      && manifest[key] !== false && !(Array.isArray(manifest[key]) && manifest[key].length === 0)))
      failures.push("试用包禁止捆绑本机依赖，请移除 bundleDependencies 和 bundledDependencies 或保持禁用");
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
      || ["dependencies", "devDependencies", "os", "cpu", "bin"].some((key) => !isDeepStrictEqual(lock.packages?.[""]?.[key], manifest[key]))))
      failures.push("包名、版本、依赖或安装范围与 package-lock.json 不一致");
  }
  if (lock && shrinkwrap && !isDeepStrictEqual(shrinkwrap, lock))
    failures.push("npm-shrinkwrap.json 与 package-lock.json 不一致");
  if (artifact) {
    if (manifest?.neumaBuild?.format !== 1 || !/^[a-f0-9]{64}$/.test(manifest?.neumaBuild?.sourceHash ?? ""))
      failures.push("缺少有效的编译产物标识");
    if (!shrinkwrap || shrinkwrap.name !== manifest?.name || shrinkwrap.version !== manifest?.version
      || ["dependencies", "devDependencies", "os", "cpu", "bin"].some((key) => !isDeepStrictEqual(shrinkwrap.packages?.[""]?.[key], manifest?.[key])))
      failures.push("编译产物包信息与发布锁不一致");
    if (Object.keys(manifest?.scripts ?? {}).some((key) => key !== "start")) failures.push("编译产物不能包含开发构建或安装生命周期脚本");
    async function inspect(path) {
      const info = await lstat(join(root, path));
      if (info.isSymbolicLink()) { failures.push(`发布产物不允许链接：${path}`); return; }
      if (info.isDirectory()) {
        for (const name of await readdir(join(root, path))) await inspect(`${path}/${name}`);
      } else if (/\.(?:ts|mts|cts)$/.test(path) || /(?:^|\/)\.env(?:\.|$)/.test(path)) failures.push(`发布产物包含源码或配置：${path}`);
    }
    for (const path of ["src", "public", "bin"]) {
      try { await inspect(path); } catch { failures.push(`无法检查编译产物目录：${path}`); }
    }
  }
  const entries = artifact ? [...ENTRY_FILES, "src/materials/material-parser-child.mjs", "src/services/node-service-worker.mjs",
    "src/services/python-service-worker.py", "src/services/mcp-bridge.mjs", "public/application-frame-bridge.js", "public/style.css"] : ENTRY_FILES;
  for (const path of entries) {
    try {
      const info = await lstat(join(root, path));
      if (!info.isFile() || info.size < 1) throw new Error();
      await access(join(root, path), constants.R_OK);
    } catch { failures.push(`缺少可读的入口文件：${path}`); }
  }
  return { ok: failures.length === 0, failures };
}

if (process.argv[1] && await realpath(resolve(process.argv[1])).catch(() => null) === fileURLToPath(import.meta.url)) {
  const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const manifest = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
  const source = await checkPreviewRelease(sourceRoot);
  let result = source;
  if (!manifest.neumaBuild) {
    try {
      const root = join(sourceRoot, "dist/ts-build/package");
      await (await import("./build.mjs")).assertFreshBuild(root);
      const artifact = await checkPreviewRelease(root, { artifact: true });
      result = { ok: source.ok && artifact.ok, failures: [...source.failures, ...artifact.failures] };
    } catch (error) { result = { ok: false, failures: [...source.failures, `编译产物不可用：${error.message}`] }; }
  }
  if (!result.ok) {
    process.stderr.write("尚不能发布 Apple 芯片 Mac 试用版：\n" + result.failures.map((value) => `- ${value}`).join("\n") + "\n");
    process.exitCode = 1;
  } else process.stdout.write("Apple 芯片 Mac 试用版配置检查通过；此检查不代表三平台完整验收。\n");
}
