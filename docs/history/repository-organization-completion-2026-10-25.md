# NEUMA 仓库整理完成说明
> 2026-10-25 自 docs/repository-organization-plan.md 归档；仓库整理已完成，本文为完成状态与实施证据索引，不再随源码更新。现行结构与生命周期规则以 [AGENTS.md](../../AGENTS.md)、[ARCHITECTURE.md](../../ARCHITECTURE.md) 为准；正文链接已按归档位置调整。

- 状态：原方案 R1、R3、R4、R5、R6 已实施；当前文件是完成状态与维护入口，不是待执行的整理清单。
- 最近核对：2026-10-25，源码基线 `e4f1974`。本轮文档同步补齐当前说明，保留之前的实施及验证记录，不宣称重新执行其中全部测试或安装验收。
- [原始方案全文](repository-organization-plan-2026-10-24.md) 已逐字冻结，初始基线为 `cca9088`；原文的旧路径、数量及“拟新增”只用于追溯。
- 原先排除的第 2 项（本地文档入库和版本管理策略）仍未实施，也不属于完成前提。`docs/` 继续是独立本地文档库，主仓库忽略策略不变；研发设计文档的时效审查与更新已由用户在本轮单独授权。

## 1. 完成状态与实现入口

| 项目 | 当前成果 | 证据与入口 |
| --- | --- | --- |
| R1 当前文档与历史归位 | 架构总览按主题维护，AGENTS 保留日常约定及文档同步门槛；原编年内容冻结 | [架构基线](../../ARCHITECTURE.md)、[开发约定](../../AGENTS.md)、[R1 实施记录](repository-reorganization-r1-2026-10-25.md) |
| R3 模块职责与依赖 | 工作目录能力、架构输入上下文和恢复来源独立成模块，真实消费者通过收窄端口调用 | [工作目录](../../src/agents/agent-workspace.mts)、[输入上下文](../../src/architecture/architecture-input-context.mts)、[恢复来源](../../src/architecture/architecture-revision-source.mts)、[控制器端口](../../src/architecture/architecture-controller-port.mts)、[R3 记录](repository-reorganization-r3-2026-10-25.md) |
| R4 测试领域组织 | 递归发现、以 test 根相对路径标识，领域测试已迁移，固定顶层入口保留 | [测试运行器](../../scripts/run-tests.mts)、[分层回归](../../test/build/test-layers.test.mts)、[R4 记录](repository-reorganization-r4-2026-10-25.md) |
| R5 自动规范检查 | `npm run check:hygiene` 已实现并接入 Mac CI，包含依赖图、测试登记、部分文档链接及明确残留检查 | [入口](../../scripts/hygiene.mts)、[Mac CI](../../.github/workflows/typescript-check.yml)、[R5 记录](repository-reorganization-r5-2026-10-25.md) |
| R6 生命周期验证与修复 | 资源归属、并发关闭、故障隔离及终结顺序有对应测试；独立资源在其他清理失败后仍收尾 | [Agent 关闭测试](../../test/agents/agent-close-failures.test.mts)、[服务关闭测试](../../test/services/managed-close-failure.test.mts)、[应用关闭测试](../../test/applications/application-close-failure.test.mts)、[R6 记录](repository-organization-r6-2026-10-25.md) |

原始五项工作已落地，后续维护应围绕实际缺陷或职责变化开展，不重复建立第二套目录、依赖图或生命周期框架。

## 2. 当前结构与约束

- 保持单包和现有领域目录，控制器仍拥有原状态与持久化顺序。辅助模块提取不改变授权、预算、来源、摘要或恢复语义。
- 运行测试按领域位于 `test/requirements/`、`architecture/`、`development/`、`agents/`、`collaboration/`、`services/`、`runtime/`、`projects/`、`installation/`、`applications/`、`ui/` 和 `build/`。
- 顶层保留 `server.test.mts` 及原生工作流固定引用的 `development-executor.test.mts`、`isolation-native.test.mts`、`project-platform.test.mts`、`project-runtime.test.mts`。编译期反例在 `test/types/`；helpers/fixtures 不进入运行集合。
- unit/integration/browser 描述执行性质；`agent-build-view` 保留有理由的 integration/browser 双重登记。运行器的 integration 防漏兜底仍在，源码检查要求所有发现文件显式登记。
- 运行保持 `--test-concurrency=1`；unit/integration 清除外部浏览器开关，页面验收与显式 browser 层沿用当前开发约定。

## 3. 自动检查的实际范围

[依赖图](../../scripts/hygiene-graph.mts)使用 TypeScript AST 和配置解析模块，区分运行时与纯类型依赖。`import type` 不形成运行时边；普通的内联 type 导入和空导入在当前 `verbatimModuleSyntax` 下仍可保留模块加载，不能误当纯类型边。已登记的运行时环和动态导入是有理由的例外，不等于允许新的未登记例外。

[测试登记](../../scripts/hygiene-tests.mts)核对递归发现集合、层清单与混合文件例外；[残留检查](../../scripts/hygiene-leftovers.mts)拒绝自有 JS 遗留和误生成产物。

[文档链接检查](../../scripts/hygiene-docs.mts)当前仅覆盖 README、AGENTS、ARCHITECTURE 中仓库内本地链接的文件目标（含图片），带 fragment 的链接检查文件部分；不验证章节语义、正文事实，也不将独立本地文档库的引用纳入失败条件。因此 AI 仍须按 AGENTS 同步表检查本地专项文档、示例、命令和新旧说明。自动检查通过不能替代文档时效核对。

检查临时编译源码检查工具，不依赖已有 dist，不执行应用模块、不调用模型、不修改业务数据；不扩大发布白名单。

## 4. 生命周期修复后的语义

- `PrototypeAgents.close()` 对清理失败分别记录，并继续关闭其他独立组件及释放会话；并发关闭共享清理结果。
- 取消构建和会话后，等待构建及忙碌会话排空，再执行第二次服务关闭，最后释放会话；避免在仍可能启动服务的工作结束前完成最终停机。
- 托管服务保留临时关闭后可恢复、永久关闭不可恢复的差别；失败可见。应用层的流程、资源和存储关闭互不因单一失败而跳过。
- 原有取消、迟到回调、排队及进程清理约束继续生效；不回滚用户已完成副作用或删除历史数据。

后续复现入口：[会话停止](../../test/runtime/session-shutdown.test.mts)、[调度](../../test/runtime/agent-scheduler.test.mts)、[材料进程](../../test/runtime/materials-runner.test.mts)、[服务](../../test/services/managed-services.test.mts)、[网关](../../test/services/service-gateway.test.mts)。历史实施记录中的测试数字按原批次保留。

## 5. 当前验证入口

在项目根按影响执行：

```sh
npm run check:hygiene
npm run typecheck
npm run build
node dist/ts-build/package/scripts/run-tests.mjs all --list
node dist/ts-build/package/scripts/run-tests.mjs unit --list
node dist/ts-build/package/scripts/run-tests.mjs integration --list
node dist/ts-build/package/scripts/run-tests.mjs browser --list
npm run test:unit
npm run test:integration
npm test
```

涉及包内容或安装行为时，执行 `npm run release:preview:check`、`npm run package:pack`、`npm run test:package:smoke` 与 `npm run test:package:install`；同代次验收方法见 [TypeScript 完成说明](typescript-migration-completion-2026-10-25.md)及现有 Mac CI。仅在需要时显式启用外部浏览器测试；跳过项不能记作通过。

当前文件不硬编码长期测试数量；新增测试须登记。历史记录证明各自批次实际做过的验证，不能自动代表后续提交或远端 CI 的当前结果。后续交付分别记录源码基线、修改范围、实际执行命令、通过/失败/跳过及剩余边界。

## 6. 完成后的维护要求

原方案的实施顺序和估时已归档。未来移动代码或测试时更新全部现行引用；新增能力、预算、状态、恢复或安装行为时，在同一轮修改对应指导文档。旧阶段规则不继续追加进现行正文，具体同步范围和交付门槛见 [AGENTS.md](../../AGENTS.md)。
