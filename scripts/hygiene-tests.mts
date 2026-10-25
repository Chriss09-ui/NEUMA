import { discoverTestFiles, TEST_LAYERS } from "./run-tests.mjs";
import type { HygieneResult } from "./hygiene-tree.mjs";

// 测试登记检查：发现集合与 TEST_LAYERS 必须完全对应——遗漏分类、失效路径和非预期重复都算违规。
// 运行器保留 integration 兜底以防直接运行时静默漏测；本检查负责提醒维护者补齐登记，两者职责不同。

// 同一文件登记到多个层是例外，必须写明理由。
const ALLOWED_MIXED: { file: string; layers: string[]; reason: string }[] = [
  { file: "agents/agent-build-view.test.mjs", layers: ["integration", "browser"], reason: "同一文件同时包含普通状态检查与真实浏览器检查（R4 方案 5.4）" },
];

export type TestLayers = Record<string, readonly string[]>;

export function checkTestRegistrationLists(layers: TestLayers, discovered: readonly string[]): HygieneResult {
  const violations: HygieneResult["violations"] = [];
  const layerNames = Object.keys(layers);
  const registered = new Map<string, string[]>();
  for (const layer of layerNames)
    for (const file of layers[layer]!) {
      if (!registered.has(file)) registered.set(file, []);
      registered.get(file)!.push(layer);
    }
  const known = new Set(registered.keys());
  for (const file of discovered)
    if (!known.has(file)) violations.push({ file, rule: "登记/遗漏", message: "测试文件未登记到任何层；新集成测试请在 TEST_LAYERS.integration 显式登记" });
  for (const [file] of registered)
    if (!discovered.includes(file)) violations.push({ file, rule: "登记/失效", message: "登记的测试文件已不存在，请清理 TEST_LAYERS" });
  for (const [file, fileLayers] of registered) {
    if (fileLayers.length < 2) continue;
    const allowed = ALLOWED_MIXED.find((entry) => entry.file === file);
    const sorted = [...fileLayers].sort();
    if (allowed && JSON.stringify(sorted) === JSON.stringify([...allowed.layers].sort())) continue;
    violations.push({ file, rule: "登记/重复", message: `同时登记到 ${fileLayers.join("、")}；混合层文件必须在 ALLOWED_MIXED 登记理由` });
  }
  for (const entry of ALLOWED_MIXED) {
    const fileLayers = registered.get(entry.file);
    if (!fileLayers || [...fileLayers].sort().join(",") !== [...entry.layers].sort().join(","))
      violations.push({ file: entry.file, rule: "登记/混合例外失效", message: `登记层与混合例外声明不一致（期望 ${entry.layers.join("、")}）：${entry.reason}` });
  }
  return { violations, notes: [`发现 ${discovered.length} 个测试、登记 ${registered.size} 个唯一条目（${layerNames.map((layer) => `${layer} ${layers[layer]!.length}`).join("、")}）`] };
}

export async function checkTestRegistration(root: string): Promise<HygieneResult> {
  return checkTestRegistrationLists(TEST_LAYERS, await discoverTestFiles(root));
}
