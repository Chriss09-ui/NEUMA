# npm 安装改造与发布准备

本轮已经实现命令行安装入口、独立数据目录、启动锁、就绪检查、关闭清理、显式迁移和三平台适配源码。Mac 本机与四个 Ubuntu 云端目标的核心检查通过，Linux 辅助程序已取回。Windows 辅助程序能编译，真实隔离启动仍在验证；当前不是已经公开发布的三平台完整支持版本。`package.json` 保留 `private: true`，没有上传 npm。

## 用户如何使用

计划正式支持 macOS 13+、Windows 11、Ubuntu 24.04/26.04 Desktop，x64/ARM64，前提是已经安装 Node.js 22.19 或更新版本。完整安装包携带平台辅助程序，用户无需 Docker、虚拟机或编译工具。Linux 文件夹窗口使用 Ubuntu Desktop 自带的 GIO/桌面门户；服务器环境不在桌面窗口验收范围内。

正式发布后：

```sh
npm install -g @chrissliu/neuma
neuma
```

启动后自动打开网页，保留终端运行，Ctrl+C 关闭服务与受管项目。自动打开失败时终端提供本机地址。也可以：

```sh
neuma --no-open
neuma --port 3010
neuma --data-dir <独立目录>
neuma doctor
neuma --help
neuma --version
```

默认端口 3000，不自动换端口。明确传入 `--port` 后保存为该数据目录的后续默认。重复启动同一数据目录时仅打开已经就绪的实例；另一个进程正在初始化或迁移时提示先等待或关闭。数据锁使用只监听 127.0.0.1 的系统端口，进程死亡会自动释放，不写入数据目录。罕见端口哈希冲突会阻止启动，不冒险加载同一数据目录。Mac/Windows 路径的大小写折叠采取保守互斥。

程序文件与数据分离：全局 npm 安装目录只读，默认用户数据在用户主目录的 `.neuma/`，模型设置在其中的 `.env`，启动端口在 `installation.json`。环境变量优先于文件配置。无模型配置也能打开网页设置页。升级与卸载程序不删除数据。

源码版仍用原项目 `.neuma/` 和 `.env`：

```sh
npm start
```

## 显式迁移现有源码版数据

先关闭旧服务。旧版服务可能没有数据锁，迁移不能替代这一步。新目标目录必须不存在或为空，不合并、不覆盖已有数据：

```sh
neuma migrate --from <原源码目录> --data-dir <空目标目录>
neuma --data-dir <同一目标目录>
```

复制到目标同级的临时目录，校验完成后整体发布。原文件保留；不初始化原 Store，也不修改原运行中记录。目标启动时继续按现有规则把中断研发标为可恢复。迁移保留稳定 Agent ID、需求、记忆、展示设置、主动保存的对话、研发代码、快照、预算和外部项目路径，只重定位控制器管理的快照引用。

模型配置、凭据类文件与 SDK 临时数据不复制，模型配置在新设置页重新填写。未保存的浏览器/内存对话不属于本次文件迁移。拒绝链接文件、坏元数据和快照摘要不一致；失败清理临时目录，可修正源文件后重试。默认总量 256 MiB、单文件 16 MiB、控制器 JSON 8 MiB、最多 20000 条目，64 KiB 分块复制；超限需先确认更大的迁移预算。

## 三平台实现与边界

共同的网页、Agent 流程、JSON 输入输出和验收规则不拆为三个项目。

- Mac：继续实际探测 `sandbox-exec` 后运行，路径适应 npm 安装与独立数据目录。
- Linux：随包 helper 使用 Landlock ABI ≥3、seccomp 和受信启动层；限制文件、网络、子进程与元数据修改。缺能力、缺 binary 或探测失败阻止生成程序执行。
- Windows：随包 helper 使用 LPAC、工作目录临时 ACL/完整性标签、受控 Node 副本、子进程限制和 Job Object；权限恢复使用逐级校验的文件句柄和文件 ID。原生原型暂限本地盘路径，UNC 共享路径会阻止执行；缺能力或探测失败同样阻止执行。

生成程序任务内容通过 stdin 进入固定启动层，仍作为 `process.argv[2]` 提供给业务代码。普通 Node 项目、Python 虚拟环境与已有脚本使用项目自身已安装的运行环境；NEUMA 不自动安装它们的依赖。已有本机项目保留明确启动的当前用户权限，与生成程序的隔离执行分开。

项目平台模块补 Windows 包管理器真实 Node 入口、PowerShell/批处理、Job Object 进程树、系统进程/TCP 查询和目录窗口；Linux 运行查询通过有限 `/proc` 扫描，目录窗口通过持续桌面门户连接。查询不读取进程参数和环境变量，不以端口相同猜归属，不接管外部进程。

## 构建、测试与打包

没有 install/postinstall 自动下载、编译或启动服务。辅助程序在对应真实构建系统预编译：

```sh
sh native/isolation/build-linux.sh
sh native/projects/build-linux.sh
```

Windows 从对应架构的 Visual Studio 开发者终端运行：

```powershell
powershell -NoProfile -File native/isolation/build-windows.ps1
powershell -NoProfile -File native/projects/build-windows.ps1 -Architecture x64
```

ARM64 开发者终端把项目辅助程序的 `-Architecture x64` 改为 `-Architecture arm64`。这些是维护者构建命令，不能在 Mac 上证明 Windows/Linux 兼容。本轮远程构建已经用户批准；本机不下载或启动 Windows/Linux 系统、不安装编译工具链。大体积下载与公开发布仍需用户事先批准。

本机测试采用单文件并发与 256 MiB Node 堆限制：

```sh
NODE_OPTIONS=--max-old-space-size=256 npm test
npm run package:prepare
npm pack --ignore-scripts --offline --pack-destination dist
node scripts/smoke-package.mjs dist/chrissliu-neuma-0.1.0.tgz
npm run release:check
```

本地 `.tgz` 只供审查当前改造，缺少辅助程序时不能当作三平台完整发布包。发布文件使用白名单，不包含用户数据、`.env`、测试或开发日志。Pi SDK 保留正常 ESM 依赖布局；从现有 package-lock 生成 npm-shrinkwrap，不用单文件打包破坏 SDK 资源。真实干净安装可能下载较大的现有 SDK 依赖，需要先批准相应下载，不能用复用本机 node_modules 假装已通过。

每个认证系统/架构需要从真实 `.tgz` 安装、最低 Node 版本、模拟模型 SDK、隔离越界/网络/子进程、取消/失败产物、项目生命周期、目录选择、迁移和升级保留数据验收。Windows 的 Node `child.kill('SIGINT')` 是强制终止，不能替代真实终端 Ctrl+C 验收。完整验收记录写入 `native/verification.json`，包含当前版本、每个系统的时间和可追溯证据、各项 checks=true、辅助程序 SHA-256；`scripts/check-release.mjs` 定义所需字段并阻止缺证据发布。不能手工把未运行项填为通过。

## 后续更新

维护者每次发布递增版本、更新锁文件、重新生成 shrinkwrap，并完成受影响的平台验收。验收记录必须绑定当前包版本与实际辅助程序摘要。公开上传作为独立批准步骤，使用 npm 的正常发布流程。

用户更新后重启：

```sh
npm install -g @chrissliu/neuma@latest
neuma
```

参考：[npm 包清单](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)、[Node 进程启动](https://nodejs.org/api/child_process.html)、[Windows AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)、[Landlock](https://www.kernel.org/doc/html/v6.2/userspace-api/landlock.html)。

## 本轮本机验证记录

2026-10-09，macOS ARM64，Node.js 26.3.0。全量 `npm test`：571/571 通过，0 失败、0 跳过，单文件并发、Node 堆限制 256 MiB，23.38 秒；`/usr/bin/time -l` 记录最大 RSS 213073920 字节（约 213 MB）、交换次数 0。这个数值是工具记录，不代表设置了整机或所有进程的总内存硬上限。

包含真实 Mac 隔离探测、真实 Pi SDK 对接本机模拟模型、实际 CLI 重复启动/退出，以及迁移和取消竞态测试。未调用用户的真实模型服务，未迁移真实用户数据。本机未安装软件、下载 SDK 依赖或启动 Windows/Linux 虚拟机；Windows/Linux 构建与测试在 GitHub 云端进行。

实际 `.tgz` 解包后，在只读程序目录、独立临时数据目录、不同工作目录启动；网页与资源、设置保存、端口保存、重启和 Ctrl+C 通过。没有执行干净 `npm install` 下载 SDK，不把这个启动检查当作完整依赖安装验收。`doctor` 的 Mac 实际隔离探测通过。发布检查要求全部八份辅助程序及完整真实系统记录，当前证据不齐，保持阻止发布。

## 改动文件清单

| 范围 | 文件 |
| --- | --- |
| 命令行与启动 | `bin/neuma.cjs`、`app-metadata.mjs`、`installation-cli.mjs`、`installation-runtime.mjs`、`instance-lock.mjs`、`server.mjs`、`settings.mjs` |
| 迁移与取消 | `installation-migration.mjs`、`agent-storage.mjs`、`agent-prototype.mjs`、`pi-runtime.mjs` |
| 安全执行 | `development-executor.mjs`、`isolation-native.mjs`、`native/isolation/linux.c`、`windows.cpp`、`windows.manifest`、`build-linux.sh`、`build-windows.ps1` |
| 项目平台 | `projects.mjs`、`project-platform.mjs`、`project-runtime.mjs`、`project-script-runtime.mjs`、`project-inspection.mjs`、`project-folder-picker.mjs`、`native/projects/windows.cpp`、`linux-portal.c`、两份构建脚本 |
| 包与文档 | `package.json`、`package-lock.json`、`npm-shrinkwrap.json`、`.gitignore`、`scripts/prepare-package.mjs`、`check-release.mjs`、`smoke-package.mjs`、`README.md`、`AGENTS.md`、`ARCHITECTURE.md`、`docs/development-layer-design.md`、本说明 |
| 新增测试 | `test/installation.test.mjs`、`installation-migration.test.mjs`、`isolation-native.test.mjs`、`project-platform.test.mjs`、`release.test.mjs`、`session-shutdown.test.mjs` |
| 更新测试 | `test/development-executor.test.mjs`、`project-folder-picker.test.mjs`、`project-runtime.test.mjs`、`server.test.mjs`、`settings.test.mjs` |
| 云端原生检查 | `.github/workflows/native-check.yml`、`.github/scripts/diagnose-isolation.mjs`、`.github/scripts/windows-loader.cpp` |

改动已提交并上传到独立分支 [`codex/npm-cli-three-platform`](https://github.com/Chriss09-ui/NEUMA/tree/codex/npm-cli-three-platform)，可审查；`main` 只新增及更新手动测试流程，应用改造未合并。本轮产生的本地 `.tgz` 在 `dist/`，该目录不进入 Git 或再次打包。

## 已批准的远程原生验证

新增 `.github/workflows/native-check.yml`，仅支持手动触发。目标为 Ubuntu 24.04/26.04 的 x64/ARM64、Windows Server 2025 x64、Windows 11 ARM64；任务串行运行，每个最多 8 分钟，Node 固定最低版本 22.19.0、单文件测试并发、堆限制 256 MiB。支持 `target=all` 或 `target=windows`，已通过的 Linux 无需随 Windows 修正重复测试。使用预装编译器；缺 GIO 开发文件时仅在云端按现有 apt 索引补齐 `libglib2.0-dev`，预检官方 Ubuntu 下载源、下载不超过 32 MiB、额外磁盘不超过 128 MiB，不执行 apt update。Linux x64 的实际下载为 2872696 字节。没有 npm/SDK 安装或编译器下载。产物打成保留执行权限的 tar 包，远程保存一天；`.github/scripts/diagnose-isolation.mjs` 仅输出固定状态、布尔检查、数字错误及经过白名单过滤的 DLL 文件名，诊断日志限制 16 KiB、128 行，不公开环境或完整路径，不生成完整产品验收记录。

现有远程仓库是公开的 `Chriss09-ui/NEUMA`。按[GitHub 官方说明](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories)，公开仓库的标准测试机器免费。计算与 Node 下载发生在 GitHub 的机器上，本机不下载或启动 Windows/Linux 系统。

2026-10-09 用户已经批准上传源码及启动远程任务。源码放在独立分支，只给 main 新增及更新手动流程文件，再选择源码分支运行。[GitHub 要求手动流程首先位于默认分支](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow#configuring-a-workflow-to-run-manually)。未上传配置、依赖目录或用户数据，没有公开 npm 发布。

Linux 四个目标在[第四轮云端任务](https://github.com/Chriss09-ui/NEUMA/actions/runs/37865332609)全部通过；x64 日志明确记录 39/39、0 失败、0 跳过及真实隔离探测通过。Ubuntu 24.04 编译的 x64/ARM64 隔离与项目辅助程序已经取回，分别位于 `native/isolation/bin/linux-*` 和 `native/projects/bin/linux-*`。Ubuntu 26.04 当前验证的是同源代码在各自系统构建的产物，尚未把 Ubuntu 24.04 的发行产物放到 26.04 做完整安装认证。

Windows 两个平台已经能编译两个辅助程序，[第八轮 Windows 任务](https://github.com/Chriss09-ui/NEUMA/actions/runs/37868454098)均未通过。x64 诊断记录隔离 Node 的退出码为 3221225794（0xC0000142，DLL 初始化失败），尚未确定具体失败的 DLL；不能据此签发完整发布验收记录。

本轮补充仅用于云端的 `windows-loader.cpp`，通过 Windows 原生调试事件记录有限的 DLL 文件名和数字状态，不进入 npm 包，也不放宽生产隔离权限。DLL 加载记录不等于该 DLL 初始化失败的证据。按用户“本轮改完就停止”的要求，此工具尚未在 Windows 编译或运行，不启动第九轮云端测试，后续验证待用户要求继续。

Windows Server x64 测试不能代替 Windows 11 x64 认证，服务器 Ubuntu 不能代替真实桌面门户窗口验证。Mac 13/x64、桌面目录窗口、真实控制台 Ctrl+C、SDK 干净安装及完整产品测试仍需后续补齐；远程辅助程序测试成功也不会自动打开 npm 发布门槛。
