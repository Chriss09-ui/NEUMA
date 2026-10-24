# TypeScript M6–M8 实施与验收

日期：2026-10-24。范围：自有前端、测试、安装、CLI、维护程序及严格构建收口；本次安装包和新增 CI 仅覆盖 Apple 芯片 Mac。用户要求全部成果分批提交，不公开发布。

## 实现

- M6：`public/` 共 56 个 TS 实现和 2 个声明；覆盖原界面、状态、API、NEUMA 事件、DOM 端口及 iframe bridge。iframe 仍为普通脚本，其他页面保持原生 ESM，不引入 bundler。新增运行辅助模块 `page-elements.js`、`ui-types.js` 进入服务端静态白名单，真实包递归检查前端 import。
- M7：250 个测试文件、25 个 helper/夹具和 3 个编译期类型反例均采用 `.mts`。测试继续发现编译后的 `.test.mjs`；历史、非法输入经 unknown 边界进入原验证器，有限 DOM/SDK/HTTP/进程替身只声明实际消费接口。原断言和负向样本保留。安装四模块、CLI、九个维护/构建程序及诊断入口完成迁移。
- M8：529 个自有实现和 22 个声明全部进入严格检查，共 551 文件。关闭 `allowJs`，移除过渡 `noCheck` 发射；共享声明、Node、浏览器、iframe 与测试环境分开。仅保留薄的 `scripts/build.mjs`，它在临时目录严格编译 TS 构建核心，再执行原子构建。构建拒绝自有 JS 遗留、配置漏检、发射冲突、缺资源、失败或过期产物。
- Node 源码仍导入运行扩展名 `.mjs`，浏览器仍导入 `.js`；CLI `.cts` 编译为 `.cjs`。消费者不运行 TS 编译，不安装开发依赖。Python、C/C++、Shell、PowerShell、HTML/CSS、第三方资源和模型生成的用户代码保留原格式。
- 生产端口按实际消费字段收窄，完整业务验证、数据版本、原生会话、摘要、额度、授权、验收和沙箱门槛继续由原实现执行。没有真实模型调用或用户业务重跑。

## 验证记录

最终代码验收完成，使用 Node 26.3.0、darwin/arm64；没有通过跳过原断言、放宽产品约束或手改 dist 取得通过。

| 检查 | 实际结果 |
| --- | --- |
| 严格检查及构建 | 551 个 TS 文件检查通过，529 个实现发射；五组正式配置不使用 allowJs/noCheck |
| `npm test` | 250 文件、3225 项：3210 通过、0 失败、0 取消、15 跳过；约 415 秒 |
| Edge 浏览器层 | 4 文件、14 项全部通过，0 跳过；原超时和断言保留 |
| 额外群组布局 | 显式 Edge 运行 `group-layout.test.mjs`，1 项通过，0 跳过；覆盖原两种桌面尺寸及全部布局状态 |
| preview 检查 | 源码树及编译 stage 均通过，仅 darwin/arm64 preview 范围 |
| 实际 tgz | 259 文件，2160649 字节；无自有 TS 源码、测试或仓库依赖目录 |
| Node 26.3.0 | 同包解包 smoke、独立临时生产依赖安装全部通过 |
| Node 22.22.2 / 24.15.0 | 两组均用对应真实 Node 运行同包 smoke 和独立临时安装，全部通过 |
| 包启动细节 | 任意 cwd、只读程序目录、46 个递归前端模块、vendor、设置保存、重启与 Ctrl+C 通过 |
| 差异及端口审计 | git diff --check 通过；生产代码无 any/ts-ignore/双重断言。编译期类型反例保留原 expect-error 检查 |

全量默认跳过的 15 项为 9 项需要固定 Python 环境的检查和 6 项外部浏览器检查；后者已用显式 Edge 的 14+1 项独立运行覆盖。群组布局文件沿现有分类默认为 integration，因此浏览器层后另外显式执行，没有将未运行项算作通过。

最终提交后构建 receipt：`99fbbba9-2644-4d2d-b886-c7ab26b94ed9`。源码摘要：`1df4f1767031b43fd3cbc41b6e0f303a25b817f69bd7bb72e043c362417cada2`。实际安装包：`dist/npm/chrissliu-neuma-0.1.0-preview.2.tgz`，SHA-256：`32239d466656ee9c31584b096e2dd1d8b31a9bdfe8b86071a56530fdd3b0ce81`。

提交前全量和浏览器在 receipt `cb5a5a43-5939-4987-b31d-98560f5c3a6b` 上完成。提交检查随后仅清理一处测试行尾空格和构建核心末尾空行；重新严格构建后，582 个产物中仅 `package.json` 的源码摘要元数据变化，其余 581 个 JS/资源摘要逐项相同。对应会话状态及构建流水线 23 项测试复跑全部通过，最终 tgz 在三组 Node 上重新进行 smoke 与独立安装。摘要对照证据为 `/tmp/neuma-m68-emission-equivalence.json`，不以格式差异重复全部耗时回归。

本机日志：`/tmp/neuma-m68-final-tests-3.log`、`/tmp/neuma-m68-browser-last-stage.log`、`/tmp/neuma-m68-group-layout-last-stage.log`、`/tmp/neuma-m68-committed-package.log`、`/tmp/neuma-m68-committed-node-22.22.2.log`、`/tmp/neuma-m68-committed-node-24.15.0.log`。这些临时证据不进入安装包。

内置浏览器以独立临时空数据目录检查主对话、项目、技能、设置、群组、群组编辑和创建智能体面板；没有模型配置、未发送真实请求，浏览器 warning/error 为空。页面导航和面板打开/关闭正常。

Dia 在本机对原无界面参数未完成响应，连空白页探测也挂起；保留原浏览器选择规则和超时，不增加自动回退。另以显式 `NEUMA_TEST_BROWSER` 指定本机 Microsoft Edge 验证完整浏览器层，结果单独记录。

已有 Python 固定运行时测试若未提供 `NEUMA_TEST_SERVICE_PYTHON`，仍按原条件跳过，不用本机任意 Python 冒充受管固定环境。Linux/Windows 的协议拒绝测试仍可运行，但不代表这些平台打包通过。

## 基线断言修正

与迁移分批提交的既有测试修正：架构预算测试将已支持的 v3 从“未知版本”负向样本中移除，补齐 v2/v3 的 25 轮及超限覆盖，未知版本改为 v4；不改生产预算。制作视图测试为原先已经采集的 `historyInNavigation: true` 补齐预期字段，不删除检查或改变界面。侧栏夹具排除与侧栏无关的主内容最小高度，原滚动/焦点断言保留；群组夹具改检查现有消息输入入口和 `@提及` 弹层角色，替代 HEAD 已不存在的旧成员按钮。两项均在原 HEAD 独立副本复现，再单独验证修正后完整断言通过，产品 HTML/CSS 没有改动。

## Mac 发布与 CI

新增 `.github/workflows/typescript-check.yml`：Mac ARM64 上使用 Node 22.22.2、24.15.0、26.3.0，依次进行锁文件安装、严格检查、构建、同代次全量测试、preview 检查、实际打包、smoke 及独立生产依赖安装。当前仅完成本地实测与工作流定义；未推送，未声称远程 CI 已执行。

按用户明确范围，`.github/workflows/native-check.yml` 保持原样，Linux/Windows 打包和既有失败留待后续，不扩大 preview 平台或标签，不公开发布。

## 复现

```sh
npm run typecheck
npm test
NEUMA_TEST_BROWSER='/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' npm run test:browser
# 群组布局沿原分类另行显式验收（先构建，再运行产物）：
NEUMA_REQUIRE_BROWSER_TESTS=1 NEUMA_TEST_BROWSER='/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' node --test dist/ts-build/package/test/group-layout.test.mjs
npm run package:pack
npm run test:package:smoke
npm run test:package:install
```

上述公共入口各自构建。若要像本次验收一样验证同一代次，先构建，再执行该 stage 的测试与 `package-artifact.mjs` 导出入口；禁止手改 dist。


## 修改文件范围

| 文件 | 修改 |
| --- | --- |
| `public/*.ts`、`public/*.d.ts` | 前端迁移、有限 DOM/状态/事件端口；运行地址仍为 JS |
| `src/runtime/`、`src/contracts/` 及领域端口 | 按实际消费建模 HTTP/SDK/进程和依赖注入 |
| `src/server.mts` | HTTP 端口与新增运行辅助模块静态白名单 |
| `test/*.test.mts`、`test/helpers/`、`test/fixtures/materials/parser-stub.mts` | 测试、有限替身和夹具迁移 |
| `src/installation/*.mts`、`bin/neuma.cts` | 安装、迁移、实例锁、CLI |
| `scripts/*.mts`、`scripts/build.mjs`、`scripts/build.d.mts` | 严格构建、测试、包检查与薄引导器 |
| `package.json`、`tsconfig*.json` | 公共命令与隔离类型环境、关闭过渡发射 |
| `.github/scripts/diagnose-isolation.mts`、`.github/workflows/typescript-check.yml` | 诊断程序迁移、Mac ARM64 CI |
| `README.md`、`AGENTS.md`、`ARCHITECTURE.md`、迁移方案与本记录 | 当前开发约定、范围及验收证据 |

## 分批提交

| 提交 | 内容 |
| --- | --- |
| `8b67020` | test: align stale budget and browser fixture expectations |
| `4a00cd9` | refactor(types): define consumed backend and injection ports |
| `7fb6ba9` | refactor(frontend): migrate browser modules to strict TypeScript |
| `79da66e` | test(types): migrate fixtures and boundary helpers |
| `869018c` | test(types): migrate architecture and requirement suites |
| `197aab9` | test(types): migrate development and execution suites |
| `8131d0c` | test(types): migrate agent and collaboration suites |
| `0f1189e` | test(types): migrate browser and interface suites |
| `165aabf` | test(types): migrate platform and storage suites |
| `f51c825` | build: finish strict TypeScript CLI and package pipeline |
| 本记录所在提交 | Mac ARM64 CI、开发说明及 M6–M8 方案/验收记录 |

所有源码和本次文档改动按以上 11 批提交；未推送或公开发布。完整逐文件差异可用 `git diff --stat 2c74a45..HEAD` 查看。
