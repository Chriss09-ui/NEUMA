import { hygieneSourceRoot, type HygieneResult } from "./hygiene-tree.mjs";
import { checkLeftoverFiles } from "./hygiene-leftovers.mjs";
import { checkModuleDependencies } from "./hygiene-graph.mjs";
import { checkTestRegistration } from "./hygiene-tests.mjs";

// 仓库规范检查入口。由 scripts/build.mjs 的 hygiene 分支临时严格编译后调用，也可以从 dist 产物直接运行。
// 每个检查只读源码树，不启动后台、模型或外部服务，不修改任何文件。
const CHECKS: { name: string; run: (root: string) => Promise<HygieneResult> }[] = [
  { name: "模块依赖", run: checkModuleDependencies },
  { name: "测试登记", run: checkTestRegistration },
  { name: "明确残留", run: checkLeftoverFiles },
];

export async function runHygiene(root = hygieneSourceRoot()): Promise<boolean> {
  process.stdout.write(`仓库规范检查（源码根：${root}）\n`);
  let clean = true;
  for (const check of CHECKS) {
    const result = await check.run(root);
    for (const note of result.notes) process.stdout.write(`  · ${note}\n`);
    for (const violation of result.violations) {
      clean = false;
      process.stdout.write(`  ✗ ${violation.file}【${violation.rule}】${violation.message}\n`);
    }
    process.stdout.write(`- ${check.name}：${result.violations.length ? `${result.violations.length} 个问题` : "通过"}\n`);
  }
  process.stdout.write(clean ? "仓库规范检查通过。\n" : "仓库规范检查未通过，请按上述位置修复或在对应检查模块登记例外。\n");
  return clean;
}

if (process.argv[1] && process.argv[1].endsWith("hygiene.mjs"))
  runHygiene().then((clean) => { if (!clean) process.exitCode = 1; }, (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
