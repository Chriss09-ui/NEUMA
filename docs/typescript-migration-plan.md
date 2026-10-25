# NEUMA TypeScript 迁移完成说明

- 状态：M0–M8 已实施并完成原定 Mac ARM64 范围的验收，不是待执行的迁移任务。
- 最近核对：2026-10-25，源码基线 `e4f1974`。本次更新核对源码、配置、文档入口与既有证据，没有重新运行迁移的全套包、浏览器或平台验收。
- 用途：说明已交付范围、当前维护入口和证据归属；日常开发遵循 [AGENTS.md](../AGENTS.md)、[ARCHITECTURE.md](../ARCHITECTURE.md) 及对应专项指南。
- [原始方案全文](history/typescript-migration-plan-2026-10-24.md) 已冻结。原文的“拟新增”、混合 JS/TS、过渡发射及工期估算只属于迁移过程，不能作为当前构建配置或新任务要求。

## 1. 已完成范围

| 阶段 | 已交付内容 | 原阶段证据 |
| --- | --- | --- |
| M0 | 记录原始工作区、既有失败、入口、运行根与测试基线 | [M0/M1 记录](typescript-m0-m1-results.md) |
| M1 | 编译、源码启动、测试产物和打包骨架，先验证一个真实 TS 模块 | [M0/M1 记录](typescript-m0-m1-results.md) |
| M2 | 共享协议、纯类型声明与低依赖边界 | [M2/M3 记录](typescript-m2-m3-results.md) |
| M3 | 持久化、模型与 SDK 适配、取消及故障边界 | [M2/M3 记录](typescript-m2-m3-results.md) |
| M4 | 需求、架构、研发与构建控制器 | [M4/M5 记录](typescript-m4-m5-results.md) |
| M5 | 服务、连接、群协作、本机项目与材料等运行领域 | [M4/M5 记录](typescript-m4-m5-results.md) |
| M6 | 前端状态、协议、DOM 与 iframe 桥 | [M6–M8 记录](typescript-m6-m8-results.md) |
| M7 | 测试、维护程序、安装模块、CLI 与诊断入口 | [M6–M8 记录](typescript-m6-m8-results.md) |
| M8 | 严格编译收口、Mac ARM64 包、三组 Node 实测与 CI 定义 | [M6–M8 记录](typescript-m6-m8-results.md) |

早期结果中保留的预算旧断言失败已在 M8 前作为独立基线修正处理；不要把 M0–M5 的阶段结果当成当前仍有同一失败。各阶段的测试数量、文件规模、摘要和发布状态保持原日期语境，不改写历史证据。

## 2. 当前源码与运行方式

- 自有后端、前端、测试、安装及维护代码全部采用严格 TypeScript；`allowJs` 关闭，不使用过渡 `noCheck` 发射。唯一自有 JS 源码例外是薄引导器 [scripts/build.mjs](../scripts/build.mjs)。
- Node `.mts`、浏览器 `.ts`、CLI `.cts` 分别编译为 `.mjs`、`.js`、`.cjs`。源码 import 继续使用运行扩展名，不能据此将引用误判为未迁移源码。
- 共享纯类型位于 `src/contracts/*.d.mts`，运行验证仍由真实契约和读取边界完成。五组正式配置分别隔离共享声明、Node、浏览器、普通脚本桥与测试；自有声明不能借用上游 `skipLibCheck` 例外。
- 编译产物位于 `dist/ts-build/package/`；安装包位于 `dist/npm/`。构建拒绝旧 JS、配置漏检、发射冲突、缺资源及陈旧产物，不手改 dist。
- 开发数据、配置与工作根绑定源码仓库；安装版使用独立用户数据目录。Python、C/C++、Shell、PowerShell、HTML/CSS、第三方资源和生成的用户程序继续使用各自格式。
- 运行包只包含编译后的程序及白名单资源；消费者不需要编译器。源码根直接打包/发布受保护，使用正式 stage 打包入口。

实现依据：[构建核心](../scripts/build-core.mts)、[包组装](../scripts/prepare-package.mts)、[实际包检查](../scripts/package-artifact.mts)、[当前包清单](../package.json)。

## 3. 当前维护与验证入口

以下命令已存在，在项目根运行；本节是复现入口，不代表每次文档更新都执行过它们。

```sh
npm run typecheck
npm run check:hygiene
npm run build
npm run test:unit
npm run test:integration
npm test
```

`npm start` 先构建再启动源码开发模式。测试命令先构建再执行产物，按领域递归发现测试；编译期反例不作为运行测试。测试目录已在后续 [仓库整理](repository-organization-plan.md) 中调整，旧结果记录中的顶层路径仅代表当时布局。

涉及安装包、入口或资源变更时，按影响执行：

```sh
npm run release:preview:check
npm run package:pack
npm run test:package:smoke
npm run test:package:install
```

公共包命令可能各自构建；需要同代次验收时，按 [Mac CI](../.github/workflows/typescript-check.yml) 在一次构建后运行对应 stage 的测试与包逻辑，核对实际产物摘要。命令定义以 `package.json` 为准。

页面检查优先使用内置浏览器。外部浏览器仅在确有需要时显式启用 `npm run test:browser`；保留 AGENTS 中的 Dia 默认及显式指定规则，不自动回退，也不把跳过或启动失败记为通过。

## 4. 已有验收与边界

- M8 已在 Mac ARM64 上完成 Node 22.22.2、24.15.0、26.3.0 的同包 smoke 和独立生产依赖安装，详见原阶段记录。最低 macOS、其他系统的完整认证不能由这些结果推导。
- 当前 Node 准入分支由 [package.json](../package.json) 和 [CLI](../bin/neuma.cts) 共同约束：22.x ≥22.22.2、24.x ≥24.15.0，或 ≥26.0.0；不是任意高于 22.22.2 的版本都支持。
- 当前发布范围仍为 Mac ARM64 preview；Linux/Windows 打包及既有原生工作流不在本次收口范围。工作流定义和历史本机实测不证明远端 CI 的当前状态。
- 源码推送、生成本地包与公开发布分别判断。原阶段文件中的“未推送”属于当时记录；是否公开发布新包必须以对应发布动作和远端证据确认，不能从本地包版本号推断。
- 原生会话、历史数据、摘要、预算、授权与激活门槛未因类型迁移而重置。后续功能改动必须继续按当前规范和相关测试验证。

## 5. 后续维护

迁移任务已经结束，不再按原 M0–M8 工期或混合期配置重复实施。后续修改按当前领域职责推进；影响类型、构建、测试或包入口时，同步 `AGENTS.md`、`ARCHITECTURE.md`、安装指南及此处实际受影响的说明。新的验证结果写成有日期和范围的记录，不把旧结果改为新结果。
