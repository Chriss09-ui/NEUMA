# TypeScript M2/M3 实施与验证记录
> 2026-10-25 自 docs/ 根归档；本记录为 2026-10-23 迁移实施与验证的原始证据，数字与状态保持当时语境，不作为当前结果。现行规则以 [AGENTS.md](../../AGENTS.md) 与 [ARCHITECTURE.md](../../ARCHITECTURE.md) 为准。

日期：2026-10-23。M2/M3 已实施，严格检查、定向回归、最终全量、实际打包与安装验证均已完成。全量仍有一项修改前已复现的失败，未宣称全绿。范围只包含 M2/M3，不扩展到 M4–M8。

## 基线与已有改动保护

- 使用当前未提交工作区作为起点，没有 reset、stash、提交、推送或发布。
- 本轮基线保存 530 个构建输入，归档为 `dist/migration-baseline/m2-m3-20261023/source.tgz`，排除凭据、用户数据和 node_modules。
- 归档 SHA-256：`8fced160d20ed8dd6cab694cd0bdade08c7af3de55dba82fa780dca738c778e2`。
- 范围外 505 个原有输入逐字节一致。另有 20 个实现按当前有效内容迁为 `.mts`；原先对架构、研发、前端及相关测试的未提交成果保留。
- 既有源码文件中只额外修改 README、测试 runner、构建测试及 Node/test 配置五个文件。`preservation.json` 保存完整核验清单。
- 原有架构预算断言失败在修改前再次复现：`test/architecture-review-revision.test.mjs:57`，第 66 行 `Missing expected rejection`。没有修改该规则、断言或测试分类来隐藏它。
- 原 M1 tgz 和打包回执另存 `m1-package.tgz`、`m1-pack-result.json`。

## 实施内容

| 批次 | 范围与结果 |
| --- | --- |
| M2 共享边界 | 六份纯声明：JSON、应用、模型、存储、工具及版本协议；不导入 Node、DOM 或 SDK。应用输入与磁盘字段以 `unknown` 进入校验边界 |
| M2 低依赖实现 | 文件/模型/需求限制、值 schema 规则、应用契约、任务信封、结构诊断、运行能力契约、结构化提交迁为 TS；M1 的文本模块继续复用 |
| M2 大契约端口 | `runtime/domain-contract-ports.mts` 对需求、架构、研发的现有验证器建立版本与信封接口，继续执行原正式校验；不为旧数据补写版本字段 |
| M3 存储 | AgentStorage、AgentLibrary、ApplicationTaskStore、DevelopmentStore、RequirementSessions 迁为 TS，队列/Promise、未知 JSON、版本冲突和原子保存参数显式化 |
| M3 模型/SDK | Pi 原生会话读取/恢复、原始工具参数策略、运行器、模型能力/上下文/无响应检测、模型连接及探针迁为 TS；故障替身使用最小会话与存储端口 |
| 读取边界 | 任务和状态记录在消费版本/事件等元数据前检查字段类型；损坏时明确拒绝并保留原文件。业务输入、结果及未迁移领域载荷仍是 unknown，交给所属验证器 |
| SDK 适配 | SDK 事件使用当前锁定包类型；TypeBox 的类型符号与既有 JSON schema 表示差异只在 customTools 注册处保留局部表示断言。Fetch 继续按结构读取 signal/headers，兼容其他 Request 实现 |
| 测试 | 新增 TS 边界运行测试和编译反例；构建测试增加自有声明错误必须失败。runner 登记新测试，并让源码 --list 识别 .test.mts 的产物名 |
| 文档 | README、AGENTS、ARCHITECTURE、迁移方案与本记录更新本轮范围、边界及例外 |

运行 import 与编译产物仍为原 `.mjs`，没有同时维护两份 JS/TS。用户程序、worker、前端入口、CLI 和隔离实现继续使用原协议。依赖版本、锁文件、数据 schema、会话/预算/评审/激活规则未变更。

## 文件清单

本轮迁移的 20 个既有实现：

- `src/agents/agent-library.mts`（原 `src/agents/agent-library.mjs`）
- `src/agents/agent-storage.mts`（原 `src/agents/agent-storage.mjs`）
- `src/applications/application-contract.mts`（原 `src/applications/application-contract.mjs`）
- `src/applications/task-input-contract.mts`（原 `src/applications/task-input-contract.mjs`）
- `src/applications/task-store.mts`（原 `src/applications/task-store.mjs`）
- `src/applications/value-schema-rules.mts`（原 `src/applications/value-schema-rules.mjs`）
- `src/development/development-store.mts`（原 `src/development/development-store.mjs`）
- `src/model-connection.mts`（原 `src/model-connection.mjs`）
- `src/requirements/requirement-limits.mts`（原 `src/requirements/requirement-limits.mjs`）
- `src/requirements/requirement-sessions.mts`（原 `src/requirements/requirement-sessions.mjs`）
- `src/runtime/file-limits.mts`（原 `src/runtime/file-limits.mjs`）
- `src/runtime/model-context.mts`（原 `src/runtime/model-context.mjs`）
- `src/runtime/model-idle-timeout.mts`（原 `src/runtime/model-idle-timeout.mjs`）
- `src/runtime/model-limits.mts`（原 `src/runtime/model-limits.mjs`）
- `src/runtime/model-profile.mts`（原 `src/runtime/model-profile.mjs`）
- `src/runtime/pi-runtime.mts`（原 `src/runtime/pi-runtime.mjs`）
- `src/runtime/pi-session-state.mts`（原 `src/runtime/pi-session-state.mjs`）
- `src/runtime/pi-submission-contract.mts`（原 `src/runtime/pi-submission-contract.mjs`）
- `src/runtime/runtime-capability-contract.mts`（原 `src/runtime/runtime-capability-contract.mjs`）
- `src/runtime/tool-input-diagnostics.mts`（原 `src/runtime/tool-input-diagnostics.mjs`）

新增共享声明：`src/contracts/{json,application,model,storage,tools,versions}.d.mts`。

新增 Node 边界：`src/runtime/{type-boundary,storage-port,pi-port,domain-contract-ports}.mts`。

新增测试：`test/typescript-boundaries.test.mts`、`test/types/migration-contracts.mts`；后者为编译期反例，不登记为运行测试。

配置与既有文件：`tsconfig.node.json`、`tsconfig.test.json`、`scripts/run-tests.mjs`、`test/build-pipeline.test.mjs`、README；本地开发文档按项目既有忽略规则保留。

## 类型检查及过渡台账

- 33 个 TS 文件：25 个生产模块（包含 M1 文本模块及 4 个新增边界）、6 份共享声明、2 个测试/类型反例。strict、索引访问和精确可选属性规则继续开启。
- Node/test 的库声明目标设为 ES2023，匹配项目原来已经使用的 findLast；生成 target 保持 ES2022，运行支持声明仍按现有 Node engines，不扩展平台认证。
- 实测关闭 skipLibCheck 后有 49 个第三方声明错误、自有实现错误为 0。`pi-ai@1.0.0` 的模型目录声明缺 JSON import 属性；`@google/genai@2.21.0` 引用未安装的旧 MCP 路径及 DOM 全局。
- 因此仅 Node/test 暂使用 skipLibCheck；SDK 导出接口仍用于自有调用检查。`tsconfig.contracts.json` 继续独立关闭 skipLibCheck 且 types=[]。新增反向测试证明自有声明中的未知类型仍会阻断构建。
- 需求、架构、研发契约的完整嵌套实现和控制器仍由 M4 负责。domain-contract-ports 的三个已验证返回值表示断言是明确过渡适配；不将其下游 JS 计为已迁移。负责人：M4 实施批次。
- 未迁移 JS 与 noCheck 发射仍遵循 M1 过渡安排，不能宣称全项目已经类型安全。第三方声明例外在 M8 收口重新核验，不修改 node_modules、不加宽泛模块声明、不把 DOM 放入后端配置。

## 验证记录

| 检查 | 已确认结果 |
| --- | --- |
| 严格类型检查与构建 | 33 个 TS 文件通过；输入归属及产物检查通过 |
| M2 首批定向组 | 32 项通过 |
| 存储定向组 | 63 项通过 |
| 会话/模型能力/上下文 | 28 项通过 |
| 运行器/模型连接/取消 | 90 项通过 |
| 构建、声明与边界收口 | 33 项通过 |
| 存储读取元数据收口 | 14 项通过 |
| Fetch 兼容修正后定向组 | 82 项通过，含结构化取消信号反例 |
| 单元组 | 收口前一轮 1550 项通过、0 失败、0 跳过；最终新增反例继续纳入全量运行 |
| 首轮全量 | 3201 项，3185 通过、1 项原有失败、15 跳过；随后复查修正 Fetch 结构访问并新增回归 |
| 最终全量 | 3202 项：3186 通过、1 项原有失败、15 跳过，约 346 秒；6 项新增运行测试均通过 |
| 兼容比较 | 41 组 JSON/摘要逐字节一致，包含原 14 组静态/动态 schema（与 M0 和本轮基线分别核对）、能力目录、输入封装、提示词、三种模型配置/摘要与上下文投影 |
| Mac preview | 配置检查通过；不代表其他平台完整验收 |
| tgz / smoke / 独立安装 | 225 文件、2,105,868 字节；无 TS/测试/配置泄漏。解包 smoke 及独立生产依赖安装均通过，44 个前端模块可加载。正式命令生成的包与已测包 SHA-1 一致 |
| git diff --check | 通过 |

测试使用本机模拟接口与合成材料，未读取凭据、迁移用户数据、调用用户真实供应商或重放真实任务。源码快照、兼容比较、文件保护及测试日志在 `dist/migration-baseline/m2-m3-20261023/`。


正式安装包：`dist/npm/chrissliu-neuma-0.1.0-preview.2.tgz`。

SHA-1：`b27f1123bea7f83c1fb76059eeedfc114ddf33a9`。完整清单、npm integrity 及机器可读验证结论见证据目录的 `final-pack-result.json`、`results.json`；后续可用 `node dist/migration-baseline/m2-m3-20261023/compatibility-check.mjs` 重跑兼容比较。

可复用命令：

```sh
npm run typecheck
npm run test:unit
npm test
npm run package:pack
npm run test:package:smoke
npm run test:package:install
```

下一批仍为 M4。进入架构预算控制器迁移前，应独立核查原有失败，保留当前预算/历史恢复约束，不能为了迁移绿灯放宽该规则。
