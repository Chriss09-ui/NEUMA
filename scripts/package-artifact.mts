import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { errorField } from "../src/runtime/type-boundary.mjs";
import { checkPreviewRelease } from "./check-preview-release.mjs";
import { assertFreshBuild, execute, SOURCE_ROOT, BUILD_PATH } from "./build.mjs";

interface PackResult { filename: string; files: { path: string }[]; [key: string]: unknown }
export async function runPackageCommand({ root = SOURCE_ROOT, command = "pack", requested }: { root?: string; command?: string; requested?: string | undefined } = {}) {
const stage = join(root, BUILD_PATH);
const output = join(root, "dist/npm");
const receipt = join(output, "pack-result.json");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";


if (command === "pack") {
    await assertFreshBuild(stage);
    const root = stage;
    const checked = await checkPreviewRelease(root, { artifact: true });
    if (!checked.ok) throw new Error(checked.failures.join("\n"));
    await assertFreshBuild(root);
    await mkdir(output, { recursive: true });
    const results: PackResult[] = JSON.parse(await execute(npm, ["pack", root, "--json", "--ignore-scripts", "--offline", "--pack-destination", output], { capture: true }));
    const result = results[0];
    if (!result) throw new Error("npm pack 未返回实际安装包");
    for (const { path } of result.files) {
      if (!/^(?:src\/|public\/|bin\/|scripts\/check-(?:preview-)?release\.mjs$|docs\/images\/readme-(?:workspace|projects)\.jpg$|package\.json$|npm-shrinkwrap\.json$|README\.md$)/.test(path)
        || /\.(?:ts|mts|cts)$/.test(path) || path.includes("..") || path.includes("node_modules") || /(?:^|\/)\.env(?:\.|$)/.test(path))
        throw new Error(`安装包文件不在允许范围：${path}`);
    }
    if (basename(result.filename) !== result.filename) throw new Error("npm pack 返回了无效路径");
    await writeFile(receipt, JSON.stringify(result, null, 2) + "\n");
    process.stdout.write(`已生成编译安装包：${join(output, result.filename)}（${result.files.length} 个文件）\n`);
  } else if (["smoke", "install"].includes(command)) {
    const archive = requested ? resolve(requested) : join(output, JSON.parse(await readFile(receipt, "utf8")).filename);
    await execute(process.execPath, [join(stage, "scripts/smoke-package.mjs"), archive, command === "install" ? "--install" : "--reuse", root]);
  } else throw new Error("命令必须为 pack、smoke 或 install");

}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await runPackageCommand({ command: process.argv[2] ?? "pack", requested: process.argv[3] }).catch((error: unknown) => {
    process.stderr.write(`${String(errorField(error, "message"))}\n`); process.exitCode = 1;
  });
