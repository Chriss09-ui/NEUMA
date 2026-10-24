import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { preparePackage } from "./prepare-package.mjs";
import { checkPreviewRelease } from "./check-preview-release.mjs";
import { assertFreshBuild, execute, SOURCE_ROOT } from "./build.mjs";

const output = join(SOURCE_ROOT, "dist/npm");
const receipt = join(output, "pack-result.json");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const [command = "pack", requested] = process.argv.slice(2);

try {
  if (command === "pack") {
    const root = await preparePackage();
    const checked = await checkPreviewRelease(root, { artifact: true });
    if (!checked.ok) throw new Error(checked.failures.join("\n"));
    await assertFreshBuild(root);
    await mkdir(output, { recursive: true });
    const results = JSON.parse(await execute(npm, ["pack", root, "--json", "--ignore-scripts", "--offline", "--pack-destination", output], { capture: true }));
    const result = results[0];
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
    await execute(process.execPath, [join(SOURCE_ROOT, "scripts/smoke-package.mjs"), archive, ...(command === "install" ? ["--install"] : [])]);
  } else throw new Error("命令必须为 pack、smoke 或 install");
} catch (error) {
  process.stderr.write(`${error.message}\n`); process.exitCode = 1;
}
