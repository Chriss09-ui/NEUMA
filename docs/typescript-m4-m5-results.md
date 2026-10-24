# TypeScript M4/M5 实施与验证记录

日期：2026-10-24。状态：M4/M5 实现与统一验证已完成；全量仅保留迁移前已复现的同一项架构预算断言失败，无新增失败。本记录不代表 M6–M8 或全项目迁移完成。

## 基线与已有改动

本次从包含 M0–M3 及既有架构、模型上下文、前端和测试改动的工作区继续实施，没有 reset、stash、覆盖或丢弃这些成果。用户最终授权全部改动按逻辑批次提交；不推送、不发布。

M4/M5 起点保存 550 个安全源码、构建输入及开发说明，归档为 `dist/migration-baseline/m4-m5-20261023/source.tgz`，不含凭据、用户数据、依赖目录。归档 SHA-256：`a56a32de1d606a7f6c8f175801b8972089155a6dedeed1ad609d6c63a858e062`。该目录的 manifest 和 preservation 核验记录原始摘要与每个源码去向。

迁移前已知失败仍需单独报告：`test/architecture-review-revision.test.mjs:57` 的预算版本用例，第 66 行 `Missing expected rejection`。不通过修改额度、删除断言或跳过测试取得全绿。

## 实施范围

132 个原 JavaScript 模块改为 `.mts`，运行路径仍为 `.mjs`；没有维护并行 JS 副本。

| 目录 | 原模块数 | 内容 |
| --- | ---: | --- |
| requirements | 10 | 需求、咨询、事实、计算、预评估、模型提供方和任务规范 |
| architecture | 29 | 契约、蓝图/模块/整合管线、证据、反馈、评审、范围复核及恢复控制器 |
| development / verification | 18 / 5 | 规划、实现、独立评审、验收、会话、工件和交付 |
| agents | 4 | Prototype、能力、连接和需求系统核实 |
| main / collaboration | 6 / 10 | 主 Agent、需求路由、群消息、队列、协作和存储 |
| applications | 7 | 应用上下文、API、任务执行、资源与产物 |
| services / connections | 17 / 5 | 服务进程、worker、MCP、HTTP、OAuth、工作流及密钥存储调用端 |
| projects / materials / skills | 7 / 5 / 2 | 本机项目进程、解析子进程、材料和技能 |
| runtime / 根模块 | 4 / 3 | 调度、活动、隔离调用端、设置、元数据和 server 组装 |

另增加领域声明、最小 SDK/存储/进程端口和实际读取边界；M2/M3 的领域过渡端口已直接调用完整 TypeScript 验证器。共享领域声明使用无 Node/DOM/SDK 的独立配置检查；无自带声明的锁定 semver 包仅声明实际使用的三个 API，并纳入同一严格声明检查。

## 行为与兼容边界

- 外部工具/模型 JSON、HTTP 数据和磁盘字段以 unknown 进入读取边界，只在实际校验后提供消费字段类型。历史未接受候选使用可缺新版字段的结构投影，不能仅凭版本标签视为完整合法设计。
- 保留旧 v1 设计 3/15、v2/v3 设计 5/25、一次局部修复、评审进度 v1–v4、累计请求次数和原生会话身份；不补写缺省版本、不刷新额度、不建立替代旧会话。
- 旧反馈、拒稿和程序诊断继续是不可信参考；完整业务验证、哈希绑定、独立评审、研发、验收和激活门槛保持。类型声明不能授予通过或运行权限。
- 主对话、群、咨询、架构、研发和激活/交付记录新增嵌套形状检查，保留原对象、扩展字段和缺省字段。损坏记录明确拒绝，相关测试核对原文件不变。
- 源码发布检查兼容 `.mts/.cts/.ts` 入口，编译产物仍强制真实 JavaScript 入口；不会将 TS 源码当作可安装产物。
- MCP 取消修复为锁定 SDK 的 `context.mcpReq.signal`。真实 SDK 回归与故意回退旧取值的负对照验证取消确实向上游传播。
- Node 服务 worker 与解析/bridge 入口仍运行编译后的原路径。新增独立复制 worker 单文件到无共享依赖目录并真实启动的回归。Python/C/C++ 实现保持。
- 项目 spawner 保留同步 child 的即时登记顺序，仅对真实 thenable 等待，防止立即停止/删除在进程身份登记前插入。
- 回调的旧 fallback 仍传原空对象；临时 SDK user 消息投影所需 timestamp 不写入会话。审查中发现的递归终止和检查点处理差异已修复。

## 验证

最终统一命令：`npm run typecheck`、`npm run build`、`npm test`、`npm run package:pack`、`npm run test:package:smoke`、`npm run test:package:install`。另比较前后 schema/JSON/摘要，核对旧源码快照去向、worker 入口和实际 tgz 清单。

中间无检查发射只用于快速行为定位，不能替代正式严格构建。Node/test 的第三方声明例外仍沿用 M2/M3 对锁定 Pi 依赖的记录；自有共享声明不跳检查，不修改 node_modules 或扩大环境库。

| 验证 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过，203 个 TS 文件；其中 src 下 177 个实现、19 个声明，test 下 7 个文件 |
| `npm run build` | 通过，184 个实现发射为 JS；保留原运行路径 |
| `npm test` | 3224 项：3208 通过、1 项原有失败、15 跳过，约 395 秒；命令因该原有断言返回 1，没有新增失败 |
| JSON/schema/摘要兼容 | 41 组与原快照一致 |
| 字符串审计 | 132 个迁移模块使用本机 Node 内置 Acorn 比较；提示词、诊断文案及协议路径无未解释缺失。审计发现并修复诊断路径和探针名称误改；剩余计数差异是 typeof 共享辅助函数及等价分支合并 |
| 源码保留核验 | 原 550 个安全文件均有去向，132 个原 JS 模块改名；无未解释文件变更 |
| `npm run package:pack` | 通过，实际 tgz 245 个文件；未包含 TS 源码、测试、用户数据或仓库依赖 |
| `npm run test:package:smoke` | 通过，任意 cwd、只读程序目录、44 个前端模块、vendor、设置保存、重启和 Ctrl+C |
| `npm run test:package:install` | 通过，独立临时 npm 安装生产依赖，不复用仓库 node_modules |
| `npm run release:preview:check` | 通过，仅 Apple 芯片 Mac preview 配置范围 |
| `git diff --check` | 通过 |

所有新增回归使用合成数据或本机替身。最终日志和机器可读兼容/保留核验在本地 `dist/migration-baseline/m4-m5-20261023/` 及 `/tmp/neuma-m45-*`；这些证据目录不进入 Git 或安装包。没有调用用户真实模型或重放业务。

## 分批提交

按用户最后的授权提交全部已有源码改动与迁移成果，工作区内容未由旧快照覆盖。前六批的构建基础、基础模块及各 TS 代码树分别做过严格类型检查；原始 JS 成果单独保留为第一批。

| 批次 | 提交 | 内容 |
| --- | --- | --- |
| 1 | `1c1bbfe` | 迁移前已有架构、模型上下文、前端与对应测试成果 |
| 2 | `caf395c` | M0/M1：工具链、严格检查、构建、源码启动及安装包流水线 |
| 3 | `88212df` | M2/M3：共享边界、持久化、模型与 SDK 适配 |
| 4 | `215267c` | M4：需求、架构、研发/验收契约及其必要基础依赖 |
| 5 | `eb28b28` | M4/M5：Agent 交付、激活与托管服务、连接、材料接线 |
| 6 | `fe4017f` | M5：主对话、协作、项目、技能、server 与源码发布检查 |
| 7 | 本记录所在提交 | 边界及兼容回归、测试分层、README 与迁移文档 |

仅将本次修改的开发说明和迁移台账显式加入第七批；原 `.gitignore` 规则继续生效。未推送或发布。

## 后续范围

M6 前端、M7 测试/维护/安装源码、M8 发布候选与收口仍未实施。手动原生工作流的编译产物传递改造、最低 Node 版本与其他平台实测保留在后续阶段；本轮独立安装只证明当前 Apple 芯片 Mac 环境。`src/installation/` 的四个 `.mjs`、前端 JavaScript 和多数测试/脚本继续按原方式参与编译目录构建；不能据此声称全仓 TypeScript 完成。

## 修改文件清单

以下清单相对于 M2/M3 提交 `88212df`，包含 M4/M5 实现、回归与随本轮加入 Git 的文档。R 为 Git 检测的改名，A/M/D 分别为新增、修改、删除；少数较大类型化差异会显示为 D+A，原 132 个模块的逐项去向另由本地 preservation 记录核对。

| 状态 | 文件 |
| --- | --- |
| A | `AGENTS.md` |
| A | `ARCHITECTURE.md` |
| M | `README.md` |
| A | `docs/typescript-m0-m1-results.md` |
| A | `docs/typescript-m2-m3-results.md` |
| A | `docs/typescript-m4-m5-results.md` |
| A | `docs/typescript-migration-plan.md` |
| M | `scripts/check-preview-release.mjs` |
| M | `scripts/run-tests.mjs` |
| R069 | `src/agents/agent-capabilities.mjs` → `src/agents/agent-capabilities.mts` |
| R069 | `src/agents/agent-connections.mjs` → `src/agents/agent-connections.mts` |
| R074 | `src/agents/agent-prototype.mjs` → `src/agents/agent-prototype.mts` |
| A | `src/agents/prototype-port.mts` |
| A | `src/agents/prototype-storage-boundary.mts` |
| R077 | `src/agents/requirement-verification.mjs` → `src/agents/requirement-verification.mts` |
| R100 | `src/app-metadata.mjs` → `src/app-metadata.mts` |
| R087 | `src/applications/application-api.mjs` → `src/applications/application-api.mts` |
| R059 | `src/applications/application-context.mjs` → `src/applications/application-context.mts` |
| M | `src/applications/application-contract.mts` |
| R058 | `src/applications/application-errors.mjs` → `src/applications/application-errors.mts` |
| R075 | `src/applications/application-resources.mjs` → `src/applications/application-resources.mts` |
| R068 | `src/applications/application-service.mjs` → `src/applications/application-service.mts` |
| R078 | `src/applications/input-framing.mjs` → `src/applications/input-framing.mts` |
| R071 | `src/applications/task-artifacts.mjs` → `src/applications/task-artifacts.mts` |
| M | `src/applications/task-store.mts` |
| R071 | `src/architecture/architecture-contract.mjs` → `src/architecture/architecture-contract.mts` |
| A | `src/architecture/architecture-controller-port.mts` |
| R065 | `src/architecture/architecture-design-pipeline.mjs` → `src/architecture/architecture-design-pipeline.mts` |
| R071 | `src/architecture/architecture-design-stages.mjs` → `src/architecture/architecture-design-stages.mts` |
| D | `src/architecture/architecture-development-revision.mjs` |
| A | `src/architecture/architecture-development-revision.mts` |
| R064 | `src/architecture/architecture-evidence-reader.mjs` → `src/architecture/architecture-evidence-reader.mts` |
| R063 | `src/architecture/architecture-feedback-ledger.mjs` → `src/architecture/architecture-feedback-ledger.mts` |
| A | `src/architecture/architecture-feedback-port.mts` |
| R088 | `src/architecture/architecture-fidelity-context.mjs` → `src/architecture/architecture-fidelity-context.mts` |
| R062 | `src/architecture/architecture-fidelity-progress.mjs` → `src/architecture/architecture-fidelity-progress.mts` |
| R074 | `src/architecture/architecture-fidelity-rejected-reference.mjs` → `src/architecture/architecture-fidelity-rejected-reference.mts` |
| R064 | `src/architecture/architecture-fidelity-revision.mjs` → `src/architecture/architecture-fidelity-revision.mts` |
| R071 | `src/architecture/architecture-handoff-verification.mjs` → `src/architecture/architecture-handoff-verification.mts` |
| R063 | `src/architecture/architecture-main-review-checkpoint.mjs` → `src/architecture/architecture-main-review-checkpoint.mts` |
| R068 | `src/architecture/architecture-model-context.mjs` → `src/architecture/architecture-model-context.mts` |
| R071 | `src/architecture/architecture-platform-claims.mjs` → `src/architecture/architecture-platform-claims.mts` |
| R066 | `src/architecture/architecture-prior-findings.mjs` → `src/architecture/architecture-prior-findings.mts` |
| R100 | `src/architecture/architecture-prompts.mjs` → `src/architecture/architecture-prompts.mts` |
| R065 | `src/architecture/architecture-repair-evidence.mjs` → `src/architecture/architecture-repair-evidence.mts` |
| R085 | `src/architecture/architecture-research.mjs` → `src/architecture/architecture-research.mts` |
| R068 | `src/architecture/architecture-review-binding.mjs` → `src/architecture/architecture-review-binding.mts` |
| R070 | `src/architecture/architecture-review-evidence.mjs` → `src/architecture/architecture-review-evidence.mts` |
| R056 | `src/architecture/architecture-review-parts.mjs` → `src/architecture/architecture-review-parts.mts` |
| R067 | `src/architecture/architecture-review-progress.mjs` → `src/architecture/architecture-review-progress.mts` |
| D | `src/architecture/architecture-review-protocol.mjs` |
| A | `src/architecture/architecture-review-protocol.mts` |
| R051 | `src/architecture/architecture-review-revision.mjs` → `src/architecture/architecture-review-revision.mts` |
| A | `src/architecture/architecture-storage-boundary.mts` |
| R076 | `src/architecture/architecture-submission-repair.mjs` → `src/architecture/architecture-submission-repair.mts` |
| R076 | `src/architecture/architecture-tool-diagnostics.mjs` → `src/architecture/architecture-tool-diagnostics.mts` |
| R076 | `src/architecture/architecture.mjs` → `src/architecture/architecture.mts` |
| R090 | `src/architecture/platform-contract.mjs` → `src/architecture/platform-contract.mts` |
| R072 | `src/architecture/requirement-fidelity.mjs` → `src/architecture/requirement-fidelity.mts` |
| R080 | `src/collaboration/collaboration-api.mjs` → `src/collaboration/collaboration-api.mts` |
| D | `src/collaboration/group-conversations.mjs` |
| A | `src/collaboration/group-conversations.mts` |
| R068 | `src/collaboration/group-mentions.mjs` → `src/collaboration/group-mentions.mts` |
| R088 | `src/collaboration/group-messages.mjs` → `src/collaboration/group-messages.mts` |
| A | `src/collaboration/group-record.mts` |
| R086 | `src/collaboration/group-replies.mjs` → `src/collaboration/group-replies.mts` |
| R077 | `src/collaboration/group-routing.mjs` → `src/collaboration/group-routing.mts` |
| R077 | `src/collaboration/group-runtime.mjs` → `src/collaboration/group-runtime.mts` |
| R076 | `src/collaboration/group-store.mjs` → `src/collaboration/group-store.mts` |
| R079 | `src/collaboration/group-tools.mjs` → `src/collaboration/group-tools.mts` |
| R078 | `src/collaboration/groups.mjs` → `src/collaboration/groups.mts` |
| R091 | `src/connections/connection-contract.mjs` → `src/connections/connection-contract.mts` |
| A | `src/connections/connection-port.mts` |
| A | `src/connections/connection-records.mts` |
| R062 | `src/connections/credential-vault.mjs` → `src/connections/credential-vault.mts` |
| R056 | `src/connections/http-adapter.mjs` → `src/connections/http-adapter.mts` |
| R057 | `src/connections/mcp-adapter.mjs` → `src/connections/mcp-adapter.mts` |
| R057 | `src/connections/oauth.mjs` → `src/connections/oauth.mts` |
| M | `src/contracts/application.d.mts` |
| A | `src/contracts/architecture-stages.d.mts` |
| A | `src/contracts/architecture.d.mts` |
| A | `src/contracts/collaboration.d.mts` |
| A | `src/contracts/connection.d.mts` |
| A | `src/contracts/development.d.mts` |
| A | `src/contracts/main.d.mts` |
| A | `src/contracts/material.d.mts` |
| M | `src/contracts/model.d.mts` |
| A | `src/contracts/project.d.mts` |
| A | `src/contracts/requirements.d.mts` |
| A | `src/contracts/service.d.mts` |
| A | `src/contracts/skill.d.mts` |
| M | `src/contracts/tools.d.mts` |
| A | `src/contracts/verification.d.mts` |
| M | `src/contracts/versions.d.mts` |
| R068 | `src/development/application-manifest-diagnostics.mjs` → `src/development/application-manifest-diagnostics.mts` |
| R072 | `src/development/development-artifacts.mjs` → `src/development/development-artifacts.mts` |
| R066 | `src/development/development-case-facts.mjs` → `src/development/development-case-facts.mts` |
| R071 | `src/development/development-context.mjs` → `src/development/development-context.mts` |
| R070 | `src/development/development-contract.mjs` → `src/development/development-contract.mts` |
| A | `src/development/development-controller-types.mts` |
| R078 | `src/development/development-diagnostics.mjs` → `src/development/development-diagnostics.mts` |
| R078 | `src/development/development-executor.mjs` → `src/development/development-executor.mts` |
| D | `src/development/development-file-tools.mjs` |
| A | `src/development/development-file-tools.mts` |
| R070 | `src/development/development-fixtures.mjs` → `src/development/development-fixtures.mts` |
| R074 | `src/development/development-plan-diagnostics.mjs` → `src/development/development-plan-diagnostics.mts` |
| R069 | `src/development/development-planning-blocker.mjs` → `src/development/development-planning-blocker.mts` |
| R099 | `src/development/development-prompts.mjs` → `src/development/development-prompts.mts` |
| A | `src/development/development-record.mts` |
| R063 | `src/development/development-sessions.mjs` → `src/development/development-sessions.mts` |
| R065 | `src/development/development-test-material-audit.mjs` → `src/development/development-test-material-audit.mts` |
| R068 | `src/development/development-workspace.mjs` → `src/development/development-workspace.mts` |
| R078 | `src/development/development.mjs` → `src/development/development.mts` |
| R070 | `src/development/managed-verification.mjs` → `src/development/managed-verification.mts` |
| R100 | `src/development/node-action-bootstrap.mjs` → `src/development/node-action-bootstrap.mts` |
| R075 | `src/main/main-agent.mjs` → `src/main/main-agent.mts` |
| R077 | `src/main/main-materials.mjs` → `src/main/main-materials.mts` |
| R100 | `src/main/main-prompts.mjs` → `src/main/main-prompts.mts` |
| A | `src/main/main-record.mts` |
| R067 | `src/main/main-requirements.mjs` → `src/main/main-requirements.mts` |
| R084 | `src/main/main-store.mjs` → `src/main/main-store.mts` |
| R079 | `src/main/requirement-routing.mjs` → `src/main/requirement-routing.mts` |
| R084 | `src/materials/material-archive.mjs` → `src/materials/material-archive.mts` |
| R089 | `src/materials/material-formats.mjs` → `src/materials/material-formats.mts` |
| R077 | `src/materials/material-parser-child.mjs` → `src/materials/material-parser-child.mts` |
| A | `src/materials/material-port.mts` |
| R073 | `src/materials/material-runner.mjs` → `src/materials/material-runner.mts` |
| R063 | `src/materials/material-store.mjs` → `src/materials/material-store.mts` |
| R063 | `src/projects/project-diagnostics.mjs` → `src/projects/project-diagnostics.mts` |
| R091 | `src/projects/project-folder-picker.mjs` → `src/projects/project-folder-picker.mts` |
| R074 | `src/projects/project-inspection.mjs` → `src/projects/project-inspection.mts` |
| R068 | `src/projects/project-platform.mjs` → `src/projects/project-platform.mts` |
| A | `src/projects/project-port.mts` |
| R065 | `src/projects/project-runtime.mjs` → `src/projects/project-runtime.mts` |
| R075 | `src/projects/project-script-runtime.mjs` → `src/projects/project-script-runtime.mts` |
| R075 | `src/projects/projects.mjs` → `src/projects/projects.mts` |
| A | `src/requirements/consultation-storage.mts` |
| R074 | `src/requirements/consultation.mjs` → `src/requirements/consultation.mts` |
| R071 | `src/requirements/core.mjs` → `src/requirements/core.mts` |
| R071 | `src/requirements/preflight-diagnostics.mjs` → `src/requirements/preflight-diagnostics.mts` |
| R086 | `src/requirements/providers.mjs` → `src/requirements/providers.mts` |
| R058 | `src/requirements/requirement-calculations.mjs` → `src/requirements/requirement-calculations.mts` |
| R094 | `src/requirements/requirement-capacity-guidance.mjs` → `src/requirements/requirement-capacity-guidance.mts` |
| R067 | `src/requirements/requirement-facts.mjs` → `src/requirements/requirement-facts.mts` |
| R075 | `src/requirements/requirement-progress.mjs` → `src/requirements/requirement-progress.mts` |
| A | `src/requirements/requirement-provider-port.mts` |
| M | `src/requirements/requirement-sessions.mts` |
| R075 | `src/requirements/requirement-stream.mjs` → `src/requirements/requirement-stream.mts` |
| R069 | `src/requirements/task-spec.mjs` → `src/requirements/task-spec.mts` |
| R066 | `src/runtime/activity-store.mjs` → `src/runtime/activity-store.mts` |
| R077 | `src/runtime/agent-scheduler.mjs` → `src/runtime/agent-scheduler.mts` |
| M | `src/runtime/domain-contract-ports.mts` |
| A | `src/runtime/http-port.mts` |
| R070 | `src/runtime/isolation-native.mjs` → `src/runtime/isolation-native.mts` |
| M | `src/runtime/model-context.mts` |
| M | `src/runtime/pi-port.mts` |
| M | `src/runtime/pi-runtime.mts` |
| M | `src/runtime/pi-session-state.mts` |
| M | `src/runtime/pi-submission-contract.mts` |
| A | `src/runtime/record-shape.mts` |
| R066 | `src/runtime/web-capabilities.mjs` → `src/runtime/web-capabilities.mts` |
| R081 | `src/server.mjs` → `src/server.mts` |
| R073 | `src/services/managed-service-manager.mjs` → `src/services/managed-service-manager.mts` |
| R072 | `src/services/mcp-bridge.mjs` → `src/services/mcp-bridge.mts` |
| R057 | `src/services/node-service-worker.mjs` → `src/services/node-service-worker.mts` |
| A | `src/services/semver.d.mts` |
| R060 | `src/services/service-api.mjs` → `src/services/service-api.mts` |
| R060 | `src/services/service-contract.mjs` → `src/services/service-contract.mts` |
| R073 | `src/services/service-data-migrations.mjs` → `src/services/service-data-migrations.mts` |
| R059 | `src/services/service-dependencies.mjs` → `src/services/service-dependencies.mts` |
| R077 | `src/services/service-docker.mjs` → `src/services/service-docker.mts` |
| R088 | `src/services/service-errors.mjs` → `src/services/service-errors.mts` |
| R074 | `src/services/service-files.mjs` → `src/services/service-files.mts` |
| R067 | `src/services/service-gateway.mjs` → `src/services/service-gateway.mts` |
| R070 | `src/services/service-image-resolution.mjs` → `src/services/service-image-resolution.mts` |
| A | `src/services/service-port.mts` |
| R067 | `src/services/service-process.mjs` → `src/services/service-process.mts` |
| A | `src/services/service-records.mts` |
| R100 | `src/services/service-runtime-options.mjs` → `src/services/service-runtime-options.mts` |
| R076 | `src/services/service-runtime.mjs` → `src/services/service-runtime.mts` |
| D | `src/services/workflow-contract.mjs` |
| A | `src/services/workflow-contract.mts` |
| R062 | `src/services/workflow-controller.mjs` → `src/services/workflow-controller.mts` |
| A | `src/services/workflow-records.mts` |
| R082 | `src/settings.mjs` → `src/settings.mts` |
| R081 | `src/skills/skill-api.mjs` → `src/skills/skill-api.mts` |
| R078 | `src/skills/skill-manager.mjs` → `src/skills/skill-manager.mts` |
| R082 | `src/verification/acceptance-contract.mjs` → `src/verification/acceptance-contract.mts` |
| R069 | `src/verification/activation-business-verification.mjs` → `src/verification/activation-business-verification.mts` |
| R081 | `src/verification/conversation-verification.mjs` → `src/verification/conversation-verification.mts` |
| R097 | `src/verification/input-rejection-contract.mjs` → `src/verification/input-rejection-contract.mts` |
| R066 | `src/verification/plan-review-subject.mjs` → `src/verification/plan-review-subject.mts` |
| M | `test/application-manifest-diagnostics.test.mjs` |
| M | `test/architecture-evidence-reader.test.mjs` |
| M | `test/connections-protocols.test.mjs` |
| A | `test/controller-storage-boundaries.test.mts` |
| M | `test/development.test.mjs` |
| A | `test/m4-architecture-boundaries.test.mts` |
| A | `test/m4-development-boundaries.test.mts` |
| M | `test/managed-services.test.mjs` |
| M | `test/preview-release.test.mjs` |
| M | `test/project-removal.test.mjs` |
| M | `test/service-gateway.test.mjs` |
| M | `test/service-workflows.test.mjs` |
| M | `test/skills-boundaries.test.mjs` |
| A | `test/types/m4-architecture.mts` |
| A | `test/types/m5-runtime.mts` |
| M | `tsconfig.contracts.json` |
| M | `tsconfig.test.json` |
