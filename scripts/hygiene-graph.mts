import type * as TypeScriptSync from "typescript/unstable/sync";
import type * as TypeScriptAst from "typescript/unstable/ast";
import { createRequire } from "node:module";
import { access } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isJavaScript, isTypeScript, sourceTreeFiles, type HygieneResult } from "./hygiene-tree.mjs";

// 模块依赖检查：用 TypeScript 官方 API 解析源码（只解析、不执行任何应用模块），区分运行时依赖与
// 纯类型依赖，再按显式登记的规则与例外报告违规。test/ 目录不参与依赖规则；例外必须写明理由，
// 条目失效时同样报告。动态导入在类型位置由解析器直接归为 ImportTypeNode，不会误判为运行时导入。

const SCAN_TREES = ["src", "public", "scripts", "bin", ".github/scripts"];
const PROJECTS = ["node", "browser", "frame"];

export interface DependencyEdge { source: string; target: string; category: "runtime" | "type"; line: number; specifier: string }
export interface DependencyGraph {
  edges: DependencyEdge[];
  externalImports?: DependencyEdge[];
  runtimeDeps: Map<string, Set<string>>;
  externals: Set<string>;
  declarationTargets: Set<string>;
  nonLiteralImports: Map<string, number>;
  unresolved: DependencyEdge[];
  scannedFiles: number;
}

const emittedName = (path: string) => path.replace(/\.mts$/, ".mjs").replace(/\.cts$/, ".cjs").replace(/\.ts$/, ".js");
const declarationTarget = (path: string) => path.replace(/\.d\.mts$/, ".mjs").replace(/\.d\.cts$/, ".cjs").replace(/\.d\.ts$/, ".js");
const inScanTrees = (path: string) => SCAN_TREES.some((tree) => path.startsWith(`${tree}/`));

export async function buildDependencyGraph(root: string, { projects = PROJECTS, typescriptRoot = root }: { projects?: string[]; typescriptRoot?: string } = {}): Promise<DependencyGraph> {
  const files = await sourceTreeFiles(root);
  const implementations = files.filter((path) => inScanTrees(path) && isTypeScript(path));
  const declarations = files.filter((path) => inScanTrees(path) && /\.d\.[cm]?ts$/.test(path));
  const implementationIndex = new Map(implementations.map((path) => [emittedName(path), path]));
  const declarationIndex = new Map(declarations.map((path) => [declarationTarget(path), path]));

  // 从指定根解析 TypeScript 官方 API（devDependency）；夹具树自身没有 node_modules，由调用方显式传入解析根。
  const require = createRequire(join(typescriptRoot, "package.json"));
  const sync: typeof TypeScriptSync = await import(pathToFileURL(require.resolve("typescript/unstable/sync")).href);
  const ast: typeof TypeScriptAst = await import(pathToFileURL(require.resolve("typescript/unstable/ast")).href);

  const api = new sync.API({ cwd: root });
  const edges: DependencyEdge[] = [];
  const externals = new Set<string>();
  const externalImports: DependencyEdge[] = [];
  const nonLiteralImports = new Map<string, number>();
  const unresolved: DependencyEdge[] = [];
  let scannedFiles = 0;
  try {
    const snapshot = api.updateSnapshot({ openProjects: PROJECTS.map((project) => join(root, `tsconfig.${project}.json`)) });
    const programs = snapshot.getProjects().map((project) => project.program);
    const sourceFileOf = (absolute: string) => {
      for (const program of programs) { const sourceFile = program.getSourceFile(absolute); if (sourceFile) return sourceFile; }
      return undefined;
    };
    for (const file of implementations) {
      const sourceFile = sourceFileOf(join(root, file));
      if (!sourceFile) { unresolved.push({ source: file, target: file, category: "runtime", line: 0, specifier: "(文件未进入任一类型工程)" }); continue; }
      scannedFiles++;
      const imports: { specifier: string; category: "runtime" | "type"; line: number }[] = [];
      for (const statement of sourceFile.statements) {
        const isImport = statement.kind === ast.SyntaxKind.ImportDeclaration;
        if (!isImport && statement.kind !== ast.SyntaxKind.ExportDeclaration) continue;
        const declaration = statement as TypeScriptAst.ImportDeclaration | TypeScriptAst.ExportDeclaration;
        if (!declaration.moduleSpecifier || declaration.moduleSpecifier.kind !== ast.SyntaxKind.StringLiteral) continue;
        const specifier = (declaration.moduleSpecifier as TypeScriptAst.StringLiteral).text;
        let category: "runtime" | "type" = "runtime";
        if (isImport) {
          const importDeclaration = declaration as TypeScriptAst.ImportDeclaration;
          const clause = importDeclaration.importClause;
          if (!clause) category = "runtime";
          else {
            // TS7 运行时在 ImportClause 上提供 isTypeOnly（import type 声明），声明文件未列出，这里以结构读取。
            const clauseTypeOnly = (clause as unknown as { isTypeOnly?: boolean }).isTypeOnly === true;
            // verbatimModuleSyntax 下，全内联 type 的普通导入发射为 import {}，仍加载目标模块。
            category = clauseTypeOnly ? "type" : "runtime";
          }
        } else if ((declaration as TypeScriptAst.ExportDeclaration).isTypeOnly) category = "type";
        imports.push({ specifier, category, line: sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1 });
      }
      const visit = (node: TypeScriptAst.Node) => {
        if (node.kind === ast.SyntaxKind.CallExpression && (node as TypeScriptAst.CallExpression).expression.kind === ast.SyntaxKind.ImportKeyword) {
          const argument = (node as TypeScriptAst.CallExpression).arguments[0];
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          if (argument?.kind === ast.SyntaxKind.StringLiteral) imports.push({ specifier: (argument as TypeScriptAst.StringLiteral).text, category: "runtime", line });
          else nonLiteralImports.set(file, (nonLiteralImports.get(file) ?? 0) + 1);
        } else if (node.kind === ast.SyntaxKind.ImportType) {
          const argument = (node as TypeScriptAst.ImportTypeNode).argument;
          if (argument.kind === ast.SyntaxKind.LiteralType && (argument as TypeScriptAst.LiteralTypeNode).literal.kind === ast.SyntaxKind.StringLiteral)
            imports.push({ specifier: ((argument as TypeScriptAst.LiteralTypeNode).literal as TypeScriptAst.StringLiteral).text, category: "type",
              line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 });
        }
        node.forEachChild(visit);
      };
      sourceFile.forEachChild(visit);

      for (const item of imports) {
        if (!item.specifier.startsWith(".")) {
          externalImports.push({ source: file, target: item.specifier, ...item });
          externals.add(item.specifier.startsWith("@") ? item.specifier.split("/").slice(0, 2).join("/") : item.specifier.split("/")[0]!);
          continue;
        }
        const normalized = relative(root, resolve(root, dirname(file), item.specifier));
        const target = implementationIndex.get(normalized)
          ?? (isJavaScript(normalized) && await access(join(root, normalized)).then(() => true, () => false) ? normalized : undefined)
          ?? declarationIndex.get(normalized);
        if (target) { edges.push({ source: file, target, category: item.category, line: item.line, specifier: item.specifier }); continue; }
        unresolved.push({ source: file, target: normalized, category: item.category, line: item.line, specifier: item.specifier });
      }
    }
  } finally { api.close(); }

  const runtimeDeps = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.category !== "runtime") continue;
    if (!runtimeDeps.has(edge.source)) runtimeDeps.set(edge.source, new Set());
    runtimeDeps.get(edge.source)!.add(edge.target);
  }
  return { edges, externalImports, runtimeDeps, externals, declarationTargets: new Set(declarationIndex.values()), nonLiteralImports, unresolved, scannedFiles };
}

// —— 规则与例外（调整任一条都要求同步理由；例外失效同样报告） ——

const ENTRY_IMPORT_RULES: { target: string; allowed: { importer: string; reason: string }[] }[] = [
  { target: "src/server.mts", allowed: [
    { importer: "src/installation/installation-runtime.mts", reason: "独立实例服务运行时懒加载复用请求处理器" },
    { importer: "scripts/start-source.mts", reason: "开发启动器从源码树直接启动服务器" }] },
  { target: "bin/neuma.cts", allowed: [] },
];

const FORBIDDEN_REVERSE_DEPENDENCIES = [
  { source: "src/agents/agent-workspace.mts", target: "src/agents/agent-prototype.mts", reason: "R3 提取的工作目录能力不得反向依赖原控制器" },
  { source: "src/architecture/architecture-input-context.mts", target: "src/architecture/architecture.mts", reason: "R3 提取的输入上下文不得反向依赖原控制器" },
  { source: "src/architecture/architecture-revision-source.mts", target: "src/architecture/architecture.mts", reason: "R3 提取的恢复来源不得反向依赖原控制器" },
];

const CROSS_DOMAIN_RULES: { from: string; to: string; allowed: { source: string; target: string; reason: string }[] }[] = [
  { from: "src/architecture/", to: "src/agents/", allowed: [
    { source: "src/architecture/architecture.mts", target: "src/agents/agent-storage.mts", reason: "架构控制器默认构造 AgentStorage 并复用 agentId 校验" }] },
];

const KNOWN_RUNTIME_CYCLES: { members: string[]; reason: string }[] = [
  { reason: "跨域共享契约与运行时校验的既有互引形态（M2–M5 迁移后冻结），调整任一边需先更新登记",
    members: ["src/agents/requirement-verification.mts",
      "src/applications/application-contract.mts", "src/applications/task-input-contract.mts",
      "src/architecture/architecture-contract.mts", "src/architecture/architecture-platform-claims.mts", "src/architecture/architecture-review-binding.mts",
      "src/architecture/architecture-review-evidence.mts", "src/architecture/platform-contract.mts",
      "src/development/development-contract.mts", "src/development/development-fixtures.mts", "src/development/development-test-material-audit.mts",
      "src/requirements/consultation.mts", "src/requirements/core.mts", "src/requirements/preflight-diagnostics.mts",
      "src/requirements/requirement-calculations.mts", "src/runtime/runtime-capability-contract.mts",
      "src/runtime/web-capabilities.mts", "src/services/service-contract.mts", "src/services/workflow-contract.mts",
      "src/verification/acceptance-contract.mts", "src/verification/plan-review-subject.mts"] },
  { reason: "服务器与独立实例运行时互相懒加载（入口例外已单独登记）", members: ["src/installation/installation-runtime.mts", "src/server.mts"] },
];

const NON_LITERAL_IMPORT_REGISTRY: { file: string; count: number; reason: string }[] = [
  { file: "src/runtime/model-profile.mts", count: 1, reason: "从本机 provider 清单解析导出路径后加载模型目录" },
  { file: "src/runtime/pi-runtime.mts", count: 4, reason: "按 Pi SDK 子清单解析 core/adapter/lazy/extensions 实际路径后加载" },
  { file: "src/services/node-service-worker.mts", count: 2, reason: "按运行时传入的应用服务入口路径加载用户模块" },
  { file: "scripts/build-core.mts", count: 2, reason: "构建完成后从产物目录动态导入打包与发布检查入口" },
  { file: "scripts/hygiene-graph.mts", count: 2, reason: "从源码根解析 TypeScript 官方 API 子路径后加载（本检查自身）" },
];

const cycleKey = (members: string[]) => [...members].sort().join("|");

// 只在 src 运行时子图上求强连通分量（Tarjan，迭代实现）；纯类型环不算运行时初始化环。
export function runtimeCycleMembers(graph: DependencyGraph): string[][] {
  const nodes = new Set<string>();
  for (const [source, targets] of graph.runtimeDeps) {
    if (!source.startsWith("src/")) continue;
    nodes.add(source);
    for (const target of targets) if (target.startsWith("src/")) nodes.add(target);
  }
  const index = new Map<string, number>(), low = new Map<string, number>(), onStack = new Set<string>(), stack: string[] = [], cycles: string[][] = [];
  let counter = 0;
  for (const start of nodes) {
    if (index.has(start)) continue;
    const work: [string, number][] = [[start, 0]];
    index.set(start, counter); low.set(start, counter); counter++;
    stack.push(start); onStack.add(start);
    while (work.length) {
      const current = work[work.length - 1]!;
      const successors = [...(graph.runtimeDeps.get(current[0]) ?? [])].filter((target) => target.startsWith("src/"));
      if (current[1] < successors.length) {
        current[1]++;
        const next = successors[current[1] - 1]!;
        if (!index.has(next)) {
          index.set(next, counter); low.set(next, counter); counter++;
          stack.push(next); onStack.add(next); work.push([next, 0]);
        } else if (onStack.has(next)) low.set(current[0], Math.min(low.get(current[0])!, index.get(next)!));
      } else {
        work.pop();
        if (work.length) { const parent = work[work.length - 1]!; low.set(parent[0], Math.min(low.get(parent[0])!, low.get(current[0])!)); }
        if (low.get(current[0]) === index.get(current[0])) {
          const component: string[] = [];
          let popped: string;
          do { popped = stack.pop()!; onStack.delete(popped); component.push(popped); } while (popped !== current[0]);
          if (component.length > 1) cycles.push(component);
        }
      }
    }
  }
  return cycles;
}

export function checkGraphRules(graph: DependencyGraph): HygieneResult {
  const violations: HygieneResult["violations"] = [];
  const message = (rule: string, file: string, text: string) => violations.push({ file, rule: `依赖/${rule}`, message: text });
  const edgeText = (edge: DependencyEdge) => `${edge.specifier}（第 ${edge.line} 行，${edge.category === "runtime" ? "运行时" : "类型"}）`;

  for (const edge of graph.unresolved)
    message(edge.specifier === "(文件未进入任一类型工程)" ? "未编译" : "未解析", edge.source,
      edge.specifier === "(文件未进入任一类型工程)" ? "文件没有进入任何类型工程，无法解析依赖" : `导入 ${edgeText(edge)} 解析不到自有源码模块`);

  for (const edge of graph.edges)
    if (edge.category === "runtime" && graph.declarationTargets.has(edge.target))
      message("契约运行时", edge.source, `运行时导入 ${edgeText(edge)} 指向仅声明文件 ${edge.target}，产物中不存在该模块`);

  const sdkAdapters = new Set(["src/runtime/pi-port.mts", "src/runtime/pi-runtime.mts", "src/runtime/pi-session-state.mts",
    "src/runtime/pi-file-tools.mts", "src/runtime/pi-skill-parser.mts", "src/runtime/model-profile.mts"]);
  for (const edge of graph.externalImports ?? [])
    if (edge.specifier.startsWith("@earendil-works/pi-") && !sdkAdapters.has(edge.source))
      message("运行接口", edge.source, "业务模块必须使用 NEUMA execution-port，不得导入 Pi SDK 类型或实现");
  for (const edge of graph.edges)
    if (edge.source.startsWith("src/") && !edge.source.startsWith("src/runtime/")
      && ["src/runtime/pi-port.mts", "src/runtime/pi-session-state.mts"].includes(edge.target))
      message("运行接口", edge.source, "业务必须使用 execution-port 和 execution-history，不得取得原生会话管理器");

  for (const rule of ENTRY_IMPORT_RULES) {
    const importers = graph.edges.filter((edge) => edge.target === rule.target);
    for (const edge of importers)
      if (!rule.allowed.some((entry) => entry.importer === edge.source))
        message("入口", edge.source, `组装入口 ${rule.target} 被导入 ${edgeText(edge)}，未登记的导入者必须移除或说明理由`);
    for (const entry of rule.allowed)
      if (!importers.some((edge) => edge.source === entry.importer))
        message("入口例外失效", entry.importer, `入口 ${rule.target} 的例外导入者已不再导入，请清理登记`);
  }

  for (const rule of FORBIDDEN_REVERSE_DEPENDENCIES)
    for (const edge of graph.edges.filter((edge) => edge.source === rule.source && edge.target === rule.target))
      message("反向依赖", edge.source, `${edgeText(edge)} 违反提取方向：${rule.reason}`);

  for (const rule of CROSS_DOMAIN_RULES) {
    const matching = graph.edges.filter((edge) => edge.source.startsWith(rule.from) && edge.target.startsWith(rule.to));
    for (const edge of matching)
      if (!rule.allowed.some((entry) => entry.source === edge.source && entry.target === edge.target))
        message("跨域", edge.source, `${edgeText(edge)} 越出 ${rule.from} → ${rule.to} 的登记边界`);
    for (const entry of rule.allowed)
      if (!matching.some((edge) => edge.source === entry.source && edge.target === entry.target))
        message("跨域例外失效", entry.source, `${entry.source} → ${entry.target} 已不存在，请清理登记`);
  }

  const cycles = runtimeCycleMembers(graph);
  const cycleKeys = new Set(cycles.map(cycleKey));
  const knownFiles = new Set<string>();
  for (const item of graph.edges) { knownFiles.add(item.source); knownFiles.add(item.target); }
  for (const cycle of cycles)
    if (!KNOWN_RUNTIME_CYCLES.some((entry) => cycleKey(entry.members) === cycleKey(cycle)))
      message("运行时环", cycle[0]!, `未登记的运行时依赖环（${cycle.length} 个成员）：${[...cycle].sort().join("、")}`);
  // 登记环的成员未全部出现在图中时不判失效（合成图/部分扫描）；成员都在却不构成该环才是需要清理的过期登记。
  for (const entry of KNOWN_RUNTIME_CYCLES)
    if (!cycleKeys.has(cycleKey(entry.members)) && entry.members.every((member) => knownFiles.has(member)))
      message("运行时环例外失效", entry.members[0]!, `登记的环已不成立或成员已变化，请更新登记：${entry.reason}`);

  const registry = new Map(NON_LITERAL_IMPORT_REGISTRY.map((entry) => [entry.file, entry]));
  for (const [file, count] of graph.nonLiteralImports) {
    const entry = registry.get(file);
    if (!entry) message("动态导入", file, `发现 ${count} 处非字面量动态导入且未登记处理方式`);
    else if (entry.count !== count) message("动态导入", file, `非字面量动态导入数量 ${count} 与登记的 ${entry.count} 不一致：${entry.reason}`);
  }
  for (const entry of registry)
    if (!graph.nonLiteralImports.has(entry[0]))
      message("动态导入例外失效", entry[0], `登记的非字面量动态导入已不存在，请清理登记：${entry[1].reason}`);

  return { violations, notes: [`解析 ${graph.scannedFiles} 个实现文件、${graph.edges.length} 条自有依赖边，运行时环 ${cycles.length} 组，外部依赖 ${graph.externals.size} 项`] };
}

export async function checkModuleDependencies(root: string): Promise<HygieneResult> {
  return checkGraphRules(await buildDependencyGraph(root));
}
