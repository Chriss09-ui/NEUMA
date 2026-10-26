import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { buildDependencyGraph, checkGraphRules, runtimeCycleMembers, type DependencyEdge, type DependencyGraph } from "../../scripts/hygiene-graph.mjs";

const edge = (source: string, target: string, category: "runtime" | "type" = "runtime"): DependencyEdge =>
  ({ source, target, category, line: 1, specifier: `./${target}` });

function graphFrom(edges: DependencyEdge[], options: { declarations?: string[]; nonLiteral?: [string, number][] } = {}): DependencyGraph {
  const runtimeDeps = new Map<string, Set<string>>();
  for (const item of edges) {
    if (item.category !== "runtime") continue;
    if (!runtimeDeps.has(item.source)) runtimeDeps.set(item.source, new Set());
    runtimeDeps.get(item.source)!.add(item.target);
  }
  return { edges, runtimeDeps, externals: new Set(), declarationTargets: new Set(options.declarations ?? []),
    nonLiteralImports: new Map(options.nonLiteral ?? []), unresolved: [], scannedFiles: edges.length };
}

const normalEdges = [
  edge("src/agents/agent-prototype.mts", "src/agents/agent-workspace.mts"),
  edge("src/agents/agent-prototype.mts", "src/agents/agent-storage.mts"),
  edge("src/architecture/architecture.mts", "src/agents/agent-storage.mts"),
  edge("src/architecture/architecture.mts", "src/contracts/json.d.mts", "type"),
  edge("src/installation/installation-runtime.mts", "src/server.mts"),
  edge("src/server.mts", "src/installation/installation-runtime.mts"),
  edge("scripts/start-source.mts", "src/server.mts"),
  edge("scripts/run-tests.mts", "scripts/build.mjs"),
];
const normalNonLiteral: [string, number][] = [["src/runtime/model-profile.mts", 1], ["src/runtime/pi-runtime.mts", 4],
  ["src/services/node-service-worker.mts", 2], ["scripts/build-core.mts", 2], ["scripts/hygiene-graph.mts", 2]];

test("登记后的依赖结构通过全部规则", () => {
  assert.deepEqual(checkGraphRules(graphFrom(normalEdges, { nonLiteral: normalNonLiteral })).violations, []);
});

test("业务不能重新导入SDK类型或原生会话管理器", () => {
  const graph = graphFrom([...normalEdges, edge("src/main/main-agent.mts", "src/runtime/pi-session-state.mts")], { nonLiteral: normalNonLiteral });
  graph.externalImports = [{ source: "src/development/development.mts", target: "@earendil-works/pi-coding-agent", specifier: "@earendil-works/pi-coding-agent", line: 1, category: "type" }];
  const failures = checkGraphRules(graph).violations;
  assert.equal(failures.filter(failure => failure.rule === "依赖/运行接口").length, 2);
});

test("反向依赖、未登记入口、跨域边和契约运行时导入都被报告", () => {
  const violations = checkGraphRules(graphFrom([...normalEdges,
    edge("src/agents/agent-workspace.mts", "src/agents/agent-prototype.mts"),
    edge("src/architecture/architecture-revision-source.mts", "src/architecture/architecture.mts", "type"),
    edge("src/services/service-gateway.mts", "src/server.mts"),
    edge("src/architecture/architecture-research.mts", "src/agents/agent-library.mts"),
    edge("src/requirements/core.mts", "src/contracts/tools.d.mts"),
  ], { declarations: ["src/contracts/tools.d.mts"], nonLiteral: normalNonLiteral })).violations;
  assert.deepEqual(violations.map((violation) => `${violation.file}:${violation.rule}`).sort(), [
    "src/agents/agent-workspace.mts:依赖/反向依赖",
    "src/agents/agent-workspace.mts:依赖/运行时环",
    "src/architecture/architecture-research.mts:依赖/跨域",
    "src/architecture/architecture-revision-source.mts:依赖/反向依赖",
    "src/requirements/core.mts:依赖/契约运行时",
    "src/services/service-gateway.mts:依赖/入口",
  ]);
});

test("未登记运行时环被报告，登记环与入口/跨域例外失效时提示清理", () => {
  const unregistered = checkGraphRules(graphFrom([
    edge("src/requirements/core.mts", "src/requirements/consultation.mts"),
    edge("src/requirements/consultation.mts", "src/requirements/core.mts"),
  ])).violations;
  assert.ok(unregistered.some((violation) => violation.rule === "依赖/运行时环" && violation.message.includes("src/requirements/core.mts")));
  assert.equal(unregistered.filter((violation) => violation.rule === "依赖/运行时环例外失效").length, 0);
  const brokenPair = checkGraphRules(graphFrom([edge("src/server.mts", "src/installation/installation-runtime.mts")])).violations;
  assert.ok(brokenPair.some((violation) => violation.rule === "依赖/运行时环例外失效" && violation.file === "src/installation/installation-runtime.mts"));
  const stale = checkGraphRules(graphFrom([], { nonLiteral: normalNonLiteral })).violations;
  assert.equal(stale.filter((violation) => violation.rule === "依赖/入口例外失效").length, 2);
  assert.equal(stale.filter((violation) => violation.rule === "依赖/跨域例外失效").length, 1);
  assert.equal(stale.filter((violation) => violation.rule === "依赖/运行时环例外失效").length, 0);
});

test("非字面量动态导入按文件计数核对，未登记或数量变化都会失败", () => {
  const unknown = checkGraphRules(graphFrom(normalEdges, { nonLiteral: [...normalNonLiteral, ["src/agents/agent-prototype.mts", 1]] })).violations;
  assert.ok(unknown.some((violation) => violation.file === "src/agents/agent-prototype.mts" && violation.rule === "依赖/动态导入"));
  const changed = checkGraphRules(graphFrom(normalEdges, { nonLiteral: normalNonLiteral.map(([file, count]) => [file, file === "src/runtime/pi-runtime.mts" ? 3 : count] as [string, number]) })).violations;
  assert.ok(changed.some((violation) => violation.file === "src/runtime/pi-runtime.mts" && violation.rule === "依赖/动态导入"));
});

test("TS 解析区分运行时、类型导入、字面量与非字面量动态导入", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-hygiene-graph-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, "src"), { recursive: true });
  for (const name of ["other", "second", "third", "fourth", "side", "default", "plain", "mixed", "star", "dyn", "inline"])
    await writeFile(join(root, `src/${name}.mts`), "export const Value = 1;\nexport type Port = string;\nexport type Only = string;\nexport type Thing = string;\nexport default Value;\n");
  await writeFile(join(root, "tsconfig.node.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "es2023",
    module: "nodenext", moduleResolution: "nodenext", verbatimModuleSyntax: true, allowJs: false, skipLibCheck: false }, include: ["src/**/*.mts"] }));
  await writeFile(join(root, "src/sample.mts"), `import type { Port } from "./other.mjs";
import { type Only } from "./second.mjs";
import { Value } from "./third.mjs";
import * as all from "./fourth.mjs";
import "./side.mjs";
import plainDefault from "./default.mjs";
export type { Port } from "./plain.mjs";
export { Value } from "./mixed.mjs";
export * from "./star.mjs";
const dyn = await import("./dyn.mjs");
declare const somePath: string;
const computed = await import(somePath);
type Inline = import("./inline.mjs").Thing;
`);
  const sourceRoot = JSON.parse(String(await readFile(new URL("../../.neuma-build.json", import.meta.url), "utf8"))).sourceRoot;
  const graph = await buildDependencyGraph(root, { projects: ["node"], typescriptRoot: sourceRoot });
  const categories = (target: string) => graph.edges.filter((item) => item.source === "src/sample.mts" && item.target === `src/${target}.mts`).map((item) => item.category);
  assert.deepEqual(categories("other"), ["type"]);
  assert.deepEqual(categories("second"), ["runtime"]);
  assert.deepEqual(categories("third"), ["runtime"]);
  assert.deepEqual(categories("fourth"), ["runtime"]);
  assert.deepEqual(categories("side"), ["runtime"]);
  assert.deepEqual(categories("default"), ["runtime"]);
  assert.deepEqual(categories("plain"), ["type"]);
  assert.deepEqual(categories("mixed"), ["runtime"]);
  assert.deepEqual(categories("star"), ["runtime"]);
  assert.deepEqual(categories("dyn"), ["runtime"]);
  assert.deepEqual(categories("inline"), ["type"]);
  assert.equal(graph.nonLiteralImports.get("src/sample.mts"), 1);
  assert.deepEqual(graph.unresolved, []);
});

test("内联 type 与空导入按真实编译产物保留运行时环，声明级类型导入不参与", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-hygiene-import-emit-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, "src"));
  await writeFile(join(root, "tsconfig.node.json"), JSON.stringify({ compilerOptions: { strict: true, target: "es2023",
    module: "nodenext", moduleResolution: "nodenext", verbatimModuleSyntax: true, allowJs: false, skipLibCheck: false,
    rootDir: "src", outDir: "output" }, include: ["src/**/*.mts"] }));
  await writeFile(join(root, "src/a.mts"), `import { type Port } from "./b.mjs";
import {} from "./c.mjs";
import type { Label } from "./d.mjs";
type Hint = import("./e.mjs").Hint;
export function run(input: Port): Label | Hint { return input; }
`);
  for (const [name, type] of [["b", "Port"], ["c", "Empty"], ["d", "Label"], ["e", "Hint"]])
    await writeFile(join(root, `src/${name}.mts`), `import { run } from "./a.mjs";\nexport type ${type} = string;\nexport const link = () => run;\n`);
  const sourceRoot = JSON.parse(String(await readFile(new URL("../../.neuma-build.json", import.meta.url), "utf8"))).sourceRoot;
  const require = createRequire(join(sourceRoot, "package.json"));
  const compiler = join(dirname(require.resolve("typescript/package.json")), "bin/tsc");
  await promisify(execFile)(process.execPath, [compiler, "-p", join(root, "tsconfig.node.json")], { cwd: root });
  const emitted = await readFile(join(root, "output/a.mjs"), "utf8");
  assert.match(emitted, /import\s*\{\s*\}\s*from\s*["']\.\/b\.mjs["']/);
  assert.match(emitted, /import\s*\{\s*\}\s*from\s*["']\.\/c\.mjs["']/);
  assert.doesNotMatch(emitted, /["']\.\/[de]\.mjs["']/);

  const graph = await buildDependencyGraph(root, { projects: ["node"], typescriptRoot: sourceRoot });
  assert.deepEqual(graph.unresolved, []);
  assert.deepEqual(runtimeCycleMembers(graph).map((members) => members.sort()), [["src/a.mts", "src/b.mts", "src/c.mts"]]);
  const violations = checkGraphRules(graph).violations.filter((violation) => violation.rule === "依赖/运行时环");
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /src\/a\.mts/);
});

test("真实源码树依赖图通过全部规则", async () => {
  const sourceRoot = JSON.parse(String(await readFile(new URL("../../.neuma-build.json", import.meta.url), "utf8"))).sourceRoot;
  const graph = await buildDependencyGraph(sourceRoot);
  assert.ok(graph.scannedFiles > 200);
  assert.deepEqual(graph.unresolved, []);
  assert.equal(runtimeCycleMembers(graph).length, 2);
  assert.deepEqual(checkGraphRules(graph).violations, []);
});
