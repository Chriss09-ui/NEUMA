# R5 关键仓库规范自动检查——实施记录

- 日期：2026-10-25
- 方案：`docs/repository-organization-plan.md` 第 6 节（R5）
- 实施前基线：main 提交 1f214f1（R4 完成），`npm test` 3225/3210/0/15，typecheck 554 文件，测试分层 unit 102 / integration 147（含兜底 99）/ browser 4，all 252。

## 提交批次

| 批次 | 提交 | 内容 |
|---|---|---|
| R5-1 | 59c2b6e | `npm run check:hygiene` 启动入口（build.mjs 独立 hygiene 分支 + tsconfig.hygiene.json 临时严格编译，显式 sourceRoot、用后清理、无 dist 可运行）与"明确残留"检查（同名 JS 产物、未迁移自有 JS、白名单失效） |
| R5-2 | d09034b | 模块依赖图检查：TypeScript 7 官方 sync API 解析（只解析不执行），运行时/类型边区分，规则与例外登记 |
| R5-3 | 66a3fcb | 测试登记基线：99 个未分类文件显式登记 integration（147 条），`integration --list` 与登记前逐字节一致、未分类警告消失、运行器兜底保留；测试登记检查 |
| R5-4 | ade3333 | 文档引用检查（README/AGENTS/ARCHITECTURE 仓库内链接，本地文档库引用不判错）+ Mac CI 接入 + 三份维护文档更新 |

## 启动方式（方案 6.2 的解法）

- `scripts/build.mjs` 新增独立分支：命令为 `hygiene` 时不加载 build-core、不生成产品目录，临时严格编译 `tsconfig.hygiene.json`（extends tsconfig.node，`skipLibCheck: false`、`allowJs: false`，include 仅 `scripts/hygiene.mts` 及其依赖闭包），以 `?sourceRoot=` 显式传入源码根，入口执行完 finally 清理临时目录。
- 引导期只依赖 Node 标准库与既有 typescript devDependency；不新增自有 JS 引导器；`files` 白名单未扩大，安装包不含检查工具与 TypeScript。
- 验证：dist 存在与移除（`mv dist dist.hold`）两种状态均通过；工作目录切到 /tmp 运行仍检查正确源码根；批次 1 与批次 4 各验证一次。

## 依赖图实现要点（方案 6.4）

- typescript@7.0.2 无经典 `ts.createSourceFile` JS API；AST 经 `typescript/unstable/sync`（`new API({cwd}).updateSnapshot({openProjects:[node,browser,frame]})` → Program → SourceFile）与 `typescript/unstable/ast`（SyntaxKind、节点谓词）获得。检查模块运行时经 `createRequire(源码根/package.json).resolve` 解析这两个子路径（临时目录与 dist 上下文都验证可用）。Node 自带 `forEachChild` 递归遍历。
- 分类：`import type`/全 type-only 具名导入/`export type from` 为类型边；默认导入、命名空间导入、副作用导入、值绑定、字面量动态 `import()` 为运行时边；类型位置 `import("...")` 由解析器归为 ImportTypeNode（类型边），`src/development/node-action-bootstrap.mts` 生成代码字符串中的 import 不会误报。
- 解析顺序：实现文件索引 → 存在的自有 JS（`scripts/build.mjs` 有同名 `build.d.mts` 声明，真实 JS 优先）→ 声明索引（`src/contracts/*.d.mts` 的运行时名字为 `.mjs`）→ 否则未解析违规。运行时边指向仅声明文件为独立违规（产物中不存在该模块）。
- 真实图（登记时）：260 个实现文件、1586 条自有依赖边、31 项外部依赖、运行时环 2 组（21 成员跨域契约环 + server↔installation-runtime 懒加载环）。规则：未解析、契约运行时、R3 提取模块反向依赖（3 对）、组装入口导入者（server 允许 installation-runtime 与 start-source；bin/neuma 无导入者）、`src/architecture/`→`src/agents/` 跨域运行时边界（唯一例外 architecture.mts→agent-storage，默认构造 AgentStorage 并复用 agentId）、运行时环登记、非字面量动态导入按文件计数登记（model-profile 1、pi-runtime 4、node-service-worker 2、build-core 2、hygiene-graph 2）。全部例外含理由；例外失效（入口/跨域/环/动态导入/白名单）均报错。
- 教训：初次诊断探针曾报 6 个环（含 connections 组），与最终模块的稳定输出（2 组）不一致；用真实模块重复运行四次数值一致并人工抽查 agent-storage/agent-connections 的出入边源码复核后否定探针结果。期间一次"路径尾部斜杠 + slice 偏移"造成全部导入未解析（1589 个违规），改为 `relative(root, resolve(...))` 规范化。tsgo 有跨进程构建缓存，源码变化后首轮结果以内容变化后的为准。

## 测试登记（方案 6.5）

- 99 个未分类文件（含 R4 后新增的 hygiene-graph.test）显式登记为 integration（原兜底语义不变）；登记后 `integration --list` 输出与登记前逐字节一致，运行时兜底与 stderr 提示保留。
- 检查规则：发现集合与 TEST_LAYERS 完全对应——遗漏、失效路径、未说明理由的重复登记、混合层例外（agent-build-view，integration+browser）层集合不一致均报错。
- `discoverTestFiles` 增加显式 root 参数，hygiene 与运行器共用同一实现。

## 文档引用（方案 6.3）

- 维护文档集合：README.md、AGENTS.md、ARCHITECTURE.md。仓库内目标：根文档互链与 `docs/typescript-*`、`docs/images/`；其余 `docs/` 链接为本地文档库引用（独立本地仓库），不以入库状态为前提，只计数（当前 17 个）不判错。外部 URL 与锚点跳过。
- 当前状态：8 个仓库内链接全部有效。

## 验证证据

| 项 | 结果 |
|---|---|
| R5-1 全量回归 | 3229/3214/0/15（+4 残留检查测试） |
| R5-2 全量回归 | 3235/3220/0/15（+6 依赖图测试，integration 层） |
| R5-3 全量回归 | 3238/3223/0/15（+3 登记测试） |
| R5-4 全量回归 | 3240/3225/0/15（+2 文档测试；typecheck 564 文件） |
| 负例（入口级） | 残留：临时 `src/agents/stray-artifact.mjs` → exit 1 且精确报位置；依赖：临时跨域导入 `architecture-prompts → agent-storage` → 报文件/目标/行号/类别；登记：临时移除 `ui/sidebar-motion` 登记 → 报遗漏与补登记指引；文档：临时改 ARCHITECTURE 链接 → 两处失效链接各报行号 |
| 无 dist 运行 | 批次 1（单项检查）与批次 4（四项检查）均从 /tmp 工作目录以移除 dist 的源码树运行通过，exit 0 |
| 层列表一致性 | integration 逐字节一致；unit/all 仅新增本批测试条目 |

## 后续事项

- 运行时环登记（2 组）是防增长基线，不是消环承诺；消环属于后续独立重构。
- hygiene 检查模块属开发工具，npm 安装包不含；CI 在 typecheck 后、build 前执行 `npm run check:hygiene`（typescript-check.yml，三 Node 版本矩阵）。
- R6（生命周期与资源清理验证）尚未实施。
