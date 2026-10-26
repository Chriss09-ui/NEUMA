> 历史档案，非当前开发指令。2026-10-18 三阶段改造交付记录；所述 .mjs 源码布局与 1772 项测试规模均为当时状态，现已被 TypeScript 迁移（M0–M8）后的代码取代，详见 docs/typescript-m6-m8-results.md。

# NEUMA 三阶段改造交付记录

日期：2026-10-18。工作区内实现，尚未提交或推送。

## 已落实

1. 需求与架构协同：版本化通用任务要求、原话依据校验、材料测量、预算受限的只读预评估、动态追问、服务端统一确认、幂等保存回执，以及正式架构返需。架构选型先检查是否足以交付，覆盖表和研发验收纳入新要求。
2. 通用连接：HTTP 参数映射、JSON/表单/授权文件上传、MCP 发现/调用/资源、OAuth 授权码与 PKCE、本机回调与系统浏览器、刷新与撤权、加密凭据仓库、动态配置表单。候选和当前运行版本使用独立连接方案；未验证、模拟通过、实际调用通过分别记录。
3. 本机运行：隔离 Node/Python 常驻进程、固定摘要的 CPython 3.13.16、依赖锁和完整性检查、可选 Docker 构建与生命周期、流程批次/检查点/等待/继续、受控重试、本机 API/MCP 网关、版本恢复与数据迁移事务。

普通迭代保持既有聊天与旧定义的兼容规则。数据格式迁移时，先等待已开始的页面保存，再暂停相关任务和写入。数据迁移包含副本执行、独立核验、备份、摘要核对和中断恢复；跨数据版本回退会先核验数据是否已有新写入，不能直接覆盖新数据。接口仅在用户开启并选择动作后绑定本机回环地址，公开任务与内部动作的权限分开。

## 验证证据

- 模拟模型与本机模拟业务服务；未调用真实模型或真实业务账号。
- Node 与受管 Python 均实际执行，包括作用域隔离、取消、内存/临时目录额度、文件和能力调用。
- 完整模拟模型链路通过需求确认、架构评审、真实研发和验收、激活、HTTP 执行、新版失败保留旧版、代码与数据回退。
- 实际官方 SDK 客户端验证 HTTP MCP 和标准本地 stdio 桥接；OAuth 使用本机模拟服务验证回调、刷新、取消和撤权。
- 内置浏览器走通需求澄清、确认和制作，查看连接与运行入口；修复窄窗口中导航和面板相互挤压。
- `npm run release:preview:check` 通过；不表示未经验证的平台也已通过。
- 最终全量测试：1772 项，1766 通过，0 失败，6 项按环境条件跳过；命令为 `NEUMA_TEST_SERVICE_PYTHON=/tmp/neuma-managed-service-verification/environments npm test`。该变量仅为本轮隔离测试指定已校验的受管 Python 缓存，不改变项目或用户 PATH。
- 最终测试日志：`/tmp/neuma-three-stage-accepted.log`；页面截图：`/tmp/neuma-services-ui.png`。

## 明确边界

- 新托管能力的正式支持平台为 Apple 芯片 Mac；旧运行通道仍保留。
- Docker 程序实现和模拟命令测试已完成，但这台电脑的 Docker 引擎未运行，未声称完成真实容器部署验收。
- 真实服务商账号、真实模型输出质量及钥匙串的实际交互，仍需真实业务环境验证。
- 不提供云部署、公网发布、任意第三方 stdio 启动命令或数据库原生驱动。
- 工作区原有四处界面修改和个人启动脚本均保留；文档沿用本机的 Git 忽略规则。

## 文件清单

以下包含本轮实现涉及的文件，以及保留在同一工作区内的既有界面修改。

- `npm-shrinkwrap.json`
- `package-lock.json`
- `package.json`
- `public/agent-connections.js`
- `public/agent-details.js`
- `public/agent-runtime.js`
- `public/agent-services.js`
- `public/agents.js`
- `public/app.js`
- `public/application-api.js`
- `public/index.html`
- `public/main-context.js`
- `public/state.js`
- `public/style.css`
- `src/agents/agent-capabilities.mjs`
- `src/agents/agent-connections.mjs`
- `src/agents/agent-library.mjs`
- `src/agents/agent-prototype.mjs`
- `src/applications/application-api.mjs`
- `src/applications/application-contract.mjs`
- `src/applications/application-service.mjs`
- `src/applications/task-store.mjs`
- `src/architecture/architecture-contract.mjs`
- `src/architecture/architecture-prompts.mjs`
- `src/architecture/architecture.mjs`
- `src/architecture/platform-contract.mjs`
- `src/collaboration/group-tools.mjs`
- `src/connections/connection-contract.mjs`
- `src/connections/credential-vault.mjs`
- `src/connections/http-adapter.mjs`
- `src/connections/mcp-adapter.mjs`
- `src/connections/oauth.mjs`
- `src/development/development-contract.mjs`
- `src/development/development-prompts.mjs`
- `src/development/development.mjs`
- `src/development/managed-verification.mjs`
- `src/development/node-action-bootstrap.mjs`
- `src/main/main-agent.mjs`
- `src/main/main-materials.mjs`
- `src/main/main-requirements.mjs`
- `src/main/main-store.mjs`
- `src/requirements/consultation.mjs`
- `src/requirements/core.mjs`
- `src/requirements/providers.mjs`
- `src/requirements/requirement-sessions.mjs`
- `src/requirements/task-spec.mjs`
- `src/server.mjs`
- `src/services/managed-service-manager.mjs`
- `src/services/mcp-bridge.mjs`
- `src/services/node-service-worker.mjs`
- `src/services/python-service-worker.py`
- `src/services/service-api.mjs`
- `src/services/service-contract.mjs`
- `src/services/service-data-migrations.mjs`
- `src/services/service-dependencies.mjs`
- `src/services/service-docker.mjs`
- `src/services/service-errors.mjs`
- `src/services/service-files.mjs`
- `src/services/service-gateway.mjs`
- `src/services/service-image-resolution.mjs`
- `src/services/service-process.mjs`
- `src/services/service-runtime.mjs`
- `src/services/workflow-contract.mjs`
- `src/services/workflow-controller.mjs`
- `test/agent-connections.test.mjs`
- `test/agent-prototype.test.mjs`
- `test/agent-services-ui.test.mjs`
- `test/agent-web-runtime.test.mjs`
- `test/application-ui.test.mjs`
- `test/architecture-consultation.test.mjs`
- `test/architecture-platform.test.mjs`
- `test/architecture.test.mjs`
- `test/collaboration-ui.test.mjs`
- `test/connections-protocols.test.mjs`
- `test/development-integration.test.mjs`
- `test/development.test.mjs`
- `test/helpers/consultation.mjs`
- `test/helpers/unified-workspace-fixture.mjs`
- `test/installation.test.mjs`
- `test/main-agent.test.mjs`
- `test/main-context-focus.test.mjs`
- `test/main-context-integration.test.mjs`
- `test/main-requirements.test.mjs`
- `test/managed-application.test.mjs`
- `test/managed-development-integration.test.mjs`
- `test/managed-services.test.mjs`
- `test/managed-workflow-verification.test.mjs`
- `test/platform-contract.test.mjs`
- `test/requirement-consultation.test.mjs`
- `test/requirement-sessions.test.mjs`
- `test/server.test.mjs`
- `test/service-data-migrations.test.mjs`
- `test/service-dependencies.test.mjs`
- `test/service-gateway.test.mjs`
- `test/service-workflows.test.mjs`
