# NEUMA npm 安装、数据与发布维护

- 核对日期：2026-10-25；源码基线：主仓库 `e4f1974`（本轮文档整理前）。
- 本文描述当前源码与本地安装包流程；日常开发规则见 [AGENTS.md](../AGENTS.md)，运行与权限边界见 [ARCHITECTURE.md](../ARCHITECTURE.md)。
- 整理前的安装文档已[全文归档](history/npm-installation-chronicle-2026-10.md)。旧发布摘要、测试数量、分支状态与远程原生检查均保留为历史证据，不用于证明最新源码已经公开发布。

## 1. 当前支持与发布状态

当前仓库版本号为 `0.1.0-preview.2`，发布清单限定 `darwin/arm64`，使用 npm 的 `preview` 标签。安装范围是 Apple 芯片 Mac、macOS 14+ 和 ARM64 Node.js。推荐 Node 26+；其他支持分支为 22.22.2+（22.x）和 24.15.0+（24.x），与清单中的 `^22.22.2 || ^24.15.0 || >=26.0.0` 一致。Node 23、25 和低于 24.15.0 的 24.x 不在范围内。

材料解析原生依赖要求 macOS 14+，锁定依赖中的 `which@7` 要求上述 Node 分支。CLI 在加载应用模块前检查 Node 版本，不能用更宽的“22.22.2 或更新版本”代替这些分支。

本地源码已经完成 TypeScript M0–M8 迁移；npm 安装包包含编译后的运行程序，消费者无需 TypeScript 编译器或开发依赖。源码提交、生成本地 `.tgz` 与上传 npm 是分别进行的操作。历史文档记录了 `0.1.0-preview.2` 的一次公开发布；本轮没有查询 registry，不能据此断言现在的 `preview` 标签或公开压缩包已经包含后续迁移和整理成果。

Windows、Linux 和 Intel Mac 不属于当前发布与打包验收范围。已有跨平台源码、原生辅助程序或历史云端检查不代表这些系统已经获得完整支持，也不要求为了 Mac 试用包补做其他平台打包。

## 2. 安装、启动与更新

安装已发布的试用包并启动：

```sh
npm install -g @chrissliu/neuma@preview
neuma
```

该命令取得 npm 当时实际发布的 `preview` 包。安装需要下载锁定的生产依赖；NEUMA 自身没有 install/postinstall 自动编译或启动服务的脚本。启动后自动打开本机网页，保留终端运行；按 Ctrl+C 关闭服务及受管任务。自动打开失败时，使用终端给出的地址。

| 命令 | 作用 |
| --- | --- |
| `neuma --no-open` | 启动服务，不自动打开浏览器 |
| `neuma --port 3010` | 指定端口，保存为该数据目录的默认端口 |
| `neuma --data-dir <独立目录>` | 使用指定数据目录 |
| `neuma doctor` | 检查本机运行与隔离能力 |
| `neuma --help` / `neuma --version` | 查看命令选项或已安装版本 |

默认端口为 3000，不自动换端口。重复启动同一数据目录时复用已经就绪的实例；初始化或迁移尚未完成时提示等待。系统互斥锁使用只监听 `127.0.0.1` 的端口，进程退出后由系统释放。哈希冲突会阻止启动，不冒险重复加载同一数据目录。

更新时，先关闭运行中的服务，再执行同一安装命令并重新启动。升级和卸载程序不会删除用户数据。

源码开发使用仓库自己的严格构建入口：

```sh
npm ci --ignore-scripts
cp .env.example .env
npm start
```

`npm start` 先严格编译到 `dist/ts-build/package/` 再启动，开发数据、配置与 Agent 工作根仍指向源码仓库。安装版则从编译后的 `bin/neuma.cjs` 启动，两者的数据根规则不同。不要手改 dist，也不要将源码根直接作为 npm 安装包发布。

## 3. 数据与运行环境

安装目录只读取程序和静态资源。安装版默认数据根是用户主目录下的 `.neuma/`，其中模型设置保存在 `.env`，启动端口保存在 `installation.json`；环境变量优先于文件配置。源码版使用源码根的 `.neuma/` 和 `.env`。无模型配置也能打开网页设置页。

当前交付按已评审方案选择运行方式：

- **内置 Node 操作**：`node-action` 仅使用 Node 内置模块，单次最多 120 秒；旧 `node-json` 交付保留兼容。
- **受管服务**：`managed-service` 支持 JavaScript/Python，可由平台准备已锁定、来源与摘要经过校验的依赖。JavaScript 直接托管只接受无安装脚本的纯 JavaScript 包；Python 直接托管使用兼容 wheel，首次需要时准备受管 Python，无需复用系统 Python。默认每请求 10 分钟，清单允许 1 毫秒至 60 分钟，修改需独立评审。
- **Docker 托管**：需要本机已经安装并启动 Docker 引擎；使用经核实并固定摘要的镜像和锁定依赖。它是条件支持路径，实际交付前仍需环境检查与执行验收。

生成程序通过平台授予的能力访问外部服务，不直接联网、监听端口或自行安装包。已有本机项目使用其自身环境和依赖，仍按用户明确启动时的当前账户权限运行。两种权限边界不复用，隔离探测失败会阻止生成程序执行。

连接支持 HTTP 与 Streamable HTTP MCP，以及匿名、访问令牌、请求头密钥、账号密码和登录授权。具体配置与测试方式见 [连接指南](connections-guide.md)；服务、流程检查点与本机 API/MCP 接口见 [智能体能力、连接与运行](agent-capabilities-and-services.md)。

## 4. 显式迁移源码版数据

先关闭旧服务，特别是可能没有数据锁的旧版本。目标必须不存在或为空，不合并、不覆盖已有数据：

```sh
neuma migrate --from <原源码目录> --data-dir <空目标目录>
neuma --data-dir <同一目标目录>
```

迁移持有两端数据锁，复制到目标同级临时目录，校验成功后整体 rename 发布；原文件保留，不初始化原 Store 或修改其运行状态。保留稳定 Agent ID、需求、记忆、已保存对话、研发代码、快照、预算和外部项目路径，只重定位控制器管理的快照引用。目标启动后按现行控制器规则处理被中断的工作，不自动重放外部动作。

模型配置、凭据文件和 SDK 临时数据不复制，需在新设置页重新配置。未保存的浏览器或内存内容不属于文件迁移。链接文件、坏元数据、快照摘要不一致或超过预算时拒绝迁移；失败清理临时目录，可修正问题后重试。

默认迁移限制：总量 256 MiB、单文件 16 MiB、控制器 JSON 8 MiB、最多 20000 条目，按 64 KiB 分块复制。扩大限制需要先评估实际数据和迁移预算，不能通过跳过验证取得成功。

## 5. 构建、测试与打包

所有自有后端、前端、测试、安装与维护程序均以 TypeScript 维护并严格编译，关闭 `allowJs`，不使用 `noCheck`。Node `.mts`、浏览器 `.ts`、CLI `.cts` 分别发射成原 `.mjs`、`.js`、`.cjs` 路径；唯一自有 JavaScript 源码例外是薄的 `scripts/build.mjs`。原生辅助程序、Python 工作进程、Shell、HTML/CSS 和第三方资源保留对应格式。

| 命令 | 验证或产物 |
| --- | --- |
| `npm run typecheck` | 严格检查全部自有 TypeScript |
| `npm run check:hygiene` | 检查源码依赖、测试登记、维护文档链接与误生成文件 |
| `npm run build` | 编译到 `dist/ts-build/package/`，生成源码与产物摘要 |
| `npm run test:unit` / `npm run test:integration` | 先构建，再运行对应层的产物测试 |
| `npm test` | 先构建，再执行全量回归，默认不启动外部浏览器 |
| `npm run package:prepare` | 同步 shrinkwrap 并生成编译 stage |
| `npm run package:pack` | 构建并检查编译 stage，打包到 `dist/npm/` |
| `npm run test:package:smoke` | 解包实际 `.tgz`，复用开发依赖启动检查 |
| `npm run test:package:install` | 将实际 `.tgz` 安装到独立临时目录，再启动检查 |
| `npm run release:preview:check` | 检查源码配置和编译产物符合 Mac ARM64 preview 范围 |

测试按领域放在 `test/` 子目录，由 `scripts/run-tests.mts` 显式登记并递归发现；Node 测试文件并发为 1。构建失败、源码变化或产物摘要不匹配会阻止使用过期产物。外部浏览器只在明确启用时运行，规则见 AGENTS.md。

发布包只包括白名单中的编译后程序、前端与运行资源、命令入口、必要发布检查、README 演示图和依赖清单。实际文件检查拒绝 TypeScript 源码、用户数据、凭据、会话、材料、测试、开发日志及捆绑的本机 `node_modules`。依赖通过 npm-shrinkwrap 锁定，保留 SDK 正常 ESM 布局。

`package:pack` 本身不上传 npm。源码根直接 `npm pack` / `npm publish` 会被保护入口拒绝。独立临时安装会下载生产依赖；复用本机依赖的 smoke 检查不能代替它。每次准备发布都要检查实际包，不能用此前同名包或相同版本号代替当前产物。

## 6. 验证证据与边界

TypeScript M8 的本地验收已在 Mac ARM64 上用 Node 22.22.2、24.15.0、26.3.0 分别执行同包 smoke 和独立生产依赖安装，并检查只读程序目录、任意 cwd、网页资源、SDK、原生材料解析、设置保存、重启及 Ctrl+C。证据与当时的包摘要见 [M6–M8 实施与验收](history/typescript-m6-m8-results-2026-10-24.md)。这些是对应代码和安装包的历史结果，后续源码或依赖变化需要重新验证。

最低 Node 分支的上述安装验证已经完成；最低 macOS 与完整系统认证仍待补齐。现有受管 Python 执行证据不代表任意 Python 依赖都通过；当前文档也不声称真实 Docker 引擎验收已完成。Linux/Windows 原生历史检查不扩展当前 Mac 安装包的支持范围。

Mac CI 定义在 `.github/workflows/typescript-check.yml`：ARM64 使用同三组 Node，执行依赖安装、严格检查、hygiene、构建、同代次全量测试、preview 检查、实际打包、smoke 和独立安装。工作流定义存在不等于每次远端运行成功，需查看对应提交的实际结果。

## 7. 发布维护与源码定位

维护者发布前应递增版本、同步清单与锁文件、重新生成 shrinkwrap，并对当前实际 `.tgz` 完成所需验证。Mac 试用版使用 `preview` 标签。公开上传需要明确授权；完成本地构建、测试、提交或推送均不等于 npm 已发布。

`npm run release:check` 保留原有三平台完整发布门槛；它读取版本、辅助程序摘要及完整认证记录，不能通过手写未执行项为 true 放行。当前 Mac 试用版使用独立 preview 检查，不借此宣称三平台认证，也不因完整门槛未通过而启动其他系统的打包改造。

| 范围 | 当前源码或测试入口 |
| --- | --- |
| CLI 与实例生命周期 | `bin/neuma.cts`、`src/installation/installation-cli.mts`、`src/installation/installation-runtime.mts`、`src/installation/instance-lock.mts` |
| 数据迁移 | `src/installation/installation-migration.mts`、`test/installation/installation-migration.test.mts` |
| 源码与编译启动 | `scripts/build.mjs`、`scripts/build-core.mts`、`scripts/start-source.mts`、`test/installation/source-launcher.test.mts` |
| 打包与包验收 | `scripts/package-artifact.mts`、`scripts/smoke-package.mts`、`test/build/build-pipeline.test.mts` |
| 发布范围与完整门槛 | `scripts/check-preview-release.mts`、`scripts/check-release.mts`、`test/build/preview-release.test.mts`、`test/build/release.test.mts` |

当前安装与操作入口见 [README](../README.md)；旧 M0/M1 过渡说明、已发布包 SHA-1、旧测试数字、旧分支状态和三平台远程日志入口均保留在[安装历史档案](history/npm-installation-chronicle-2026-10.md)，不改写为本轮结果。
