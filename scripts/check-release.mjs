import { createHash } from "node:crypto";
import { readFile, lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const NATIVE_ARTIFACTS = [
  ...["linux-x64", "linux-arm64", "win32-x64", "win32-arm64"].map((target) =>
    `native/isolation/bin/${target}/neuma-isolation${target.startsWith("win32") ? ".exe" : ""}`),
  ...["linux-x64", "linux-arm64", "win32-x64", "win32-arm64"].map((target) =>
    `native/projects/bin/${target}/neuma-projects${target.startsWith("win32") ? ".exe" : ""}`),
];
const SYSTEMS = ["darwin-x64", "darwin-arm64", "win32-x64", "win32-arm64",
  "ubuntu-24.04-x64", "ubuntu-24.04-arm64", "ubuntu-26.04-x64", "ubuntu-26.04-arm64"];
const CHECKS = ["installedTarball", "sdkLocalModel", "dataUpgrade", "migration", "projectLifecycle", "folderPicker",
  "isolation", "cancellation", "nodeMinimum"];

export async function checkRelease(root) {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  const failures = [];
  if (!Array.isArray(manifest.files) || !manifest.files.includes("src/"))
    failures.push("发布文件清单必须包含完整源码目录 src/");
  let shrinkwrap;
  try { shrinkwrap = JSON.parse(await readFile(join(root, "npm-shrinkwrap.json"), "utf8")); }
  catch { failures.push("缺少发布锁文件，请先运行 npm run package:prepare"); }
  if (shrinkwrap && JSON.stringify(shrinkwrap) !== JSON.stringify(lock)) failures.push("发布锁文件与 package-lock.json 不一致");
  if (lock.name !== manifest.name || lock.version !== manifest.version || lock.packages?.[""]?.version !== manifest.version
    || JSON.stringify(lock.packages?.[""]?.dependencies) !== JSON.stringify(manifest.dependencies)) failures.push("包信息与依赖锁文件不一致");
  const artifacts = {};
  for (const path of NATIVE_ARTIFACTS) {
    try {
      const info = await lstat(join(root, path));
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > 32 * 1024 * 1024) throw new Error();
      if (process.platform !== "win32" && !path.endsWith(".exe") && !(info.mode & 0o111)) throw new Error();
      artifacts[path] = createHash("sha256").update(await readFile(join(root, path))).digest("hex");
    } catch { failures.push(`缺少有效辅助程序：${path}`); }
  }
  let evidence;
  try { evidence = JSON.parse(await readFile(join(root, "native", "verification.json"), "utf8")); }
  catch { failures.push("缺少真实系统验收记录 native/verification.json"); }
  if (evidence) {
    if (evidence.version !== manifest.version) failures.push("验收记录不是当前应用版本");
    for (const system of SYSTEMS) {
      const record = evidence.systems?.[system];
      if (!record || !record.checkedAt || !Number.isFinite(Date.parse(record.checkedAt)) ||
        !record.evidence || typeof record.evidence !== "string" || !record.evidence.trim() ||
        CHECKS.some((key) => record.checks?.[key] !== true)) failures.push(`缺少完整真实验收：${system}`);
    }
    for (const [path, digest] of Object.entries(artifacts)) if (evidence.artifacts?.[path] !== digest)
      failures.push(`辅助程序摘要与验收记录不一致：${path}`);
  }
  return { ok: failures.length === 0, failures };
}

if (process.argv[1] && await realpath(resolve(process.argv[1])).catch(() => null) === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkRelease(dirname(dirname(fileURLToPath(import.meta.url))));
    if (!result.ok) { process.stderr.write("尚不能发布三平台完整支持版：\n" + result.failures.map((value) => `- ${value}`).join("\n") + "\n"); process.exitCode = 1; }
    else process.stdout.write("发布检查通过；请在明确批准公开发布后移除 private 并上传。\n");
  } catch { process.stderr.write("发布配置无法读取，请检查清单和验收记录。\n"); process.exitCode = 1; }
}
