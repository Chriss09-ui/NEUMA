# NEUMA 当前开发约定

- 修改 Agent 的架构、构建、执行、会话或交互前，先阅读 [ARCHITECTURE.md](ARCHITECTURE.md)。它是当前正式架构基线，按主题说明各领域职责、状态归属、关键约束、验证入口和跨领域不变量。本文只保留每次开发都需要知道的规则；行为细节、数量限制和恢复语义以 ARCHITECTURE.md 对应章节为准，不在两处重复维护。
- 原型文档（`AGENT_PROTOTYPE.md`）、docs/history 档案与 `本地测试记录/` 均为历史验证证据归档，没有规范效力，无需作为开发前置阅读；其中冻结的源码与文件摘要只代表记录当时的状态，不得当作当前代码、接口或规范事实，不得据此恢复临时方案或限制新架构。判断现状一律以当前源码为准。

## 文档同步是完成条件

**AI 修改代码时，必须在同一轮工作中检查并更新受影响的现行文档。代码已经改变而指导文档仍描述旧行为，属于未完成的变更，不得报告完成或提交为完整交付。** 不能用“以后再补文档”、只改核对日期或追加一条相互覆盖的说明代替正文修正；用户明确要求暂缓某份文档时，记录例外与影响。

修改前按下表确定阅读范围；修改后用实际源码、配置和相关测试逐项核对。下表要求检查影响，实际有变化的段落必须同步更新，不要求无关文件凑改动。

| 改动范围或行为 | 必须检查并按影响同步的文件 |
| --- | --- |
| 所有用户可见能力、支持范围、默认行为和使用入口 | `README.md`、`ARCHITECTURE.md`、`docs/user-guide.md`；专属功能另看下列专项文档 |
| `src/requirements/`、`src/main/`、`src/collaboration/` 的需求确认、主对话、群协作、历史保存与恢复 | `ARCHITECTURE.md`、`docs/user-guide.md`；创建或服务交付流程变化时更新 `docs/agent-capabilities-and-services.md` |
| `src/architecture/`、`src/runtime/`、模型配置的角色、额度、超时、阶段、授权、检查点与恢复 | `ARCHITECTURE.md`；影响研发交接时更新 `docs/development-layer-design.md`，影响设置或使用说明时更新 `docs/user-guide.md` |
| `src/development/`、`src/verification/` 的规划、开发、评审、材料、执行适配、验收、激活与回退 | `docs/development-layer-design.md`、`ARCHITECTURE.md`；用户能力或操作变化时同步 `README.md`、`docs/agent-capabilities-and-services.md`、`docs/user-guide.md` |
| `src/applications/`、`src/services/`、`src/agents/` 的应用动作、受管语言/依赖、服务、流程、产物、网关和生命周期 | `ARCHITECTURE.md`、`docs/agent-capabilities-and-services.md`、`docs/user-guide.md`；执行契约影响研发时更新研发设计，对外 API/MCP 变化时更新 `docs/connections-guide.md` |
| `src/connections/`、`src/agents/agent-connections.mts`、连接界面的协议、认证、配置、测试、撤销和结果读取 | `docs/connections-guide.md`、`ARCHITECTURE.md`；用户配置方式或支持能力变化时同步 `README.md`、`docs/user-guide.md`、`docs/agent-capabilities-and-services.md` |
| `src/installation/`、`bin/`、包清单/锁文件、`scripts/`、`tsconfig*.json`、CI 的 Node/系统范围、命令、构建、测试、安装、打包和发布 | `README.md`、`docs/npm-installation.md`、`ARCHITECTURE.md`；开发操作规则变化时更新本文，已有方案的完成状态变化时更新相应方案入口 |
| `public/` 的页面、路由、设置、按钮、保存与恢复方式 | `docs/user-guide.md` 及对应连接/服务专项指南；首次上手或能力范围变化时更新 `README.md`，协议或状态归属变化时更新 `ARCHITECTURE.md` |
| 文件移动、重命名、入口或测试领域目录变化 | 检索全部现行 Markdown 中的旧路径、命令、锚点与代码示例；更新失效引用，不把编译产物扩展名误当源码扩展名 |

文档维护规则：

- 当前架构、限制及恢复语义集中维护在 `ARCHITECTURE.md`；研发细节集中在研发设计，连接与安装细节分别在专项指南。其他文档只保留读者所需摘要并链接权威段落；必要的重复说明必须同时核对，不能两处各写一套规则。
- 修改已有正文以反映当前实现；旧方案或被替代的规则放入明确标记的 `docs/history/`，保留来源和适用版本。历史验证数字、发布摘要、旧授权与结果记录不能改成新的事实。完成的方案要更新状态并指向实施记录，不能继续写“待实施”“命令尚不存在”。
- 区分源码、编译产物、生成的用户程序，以及已实现、已验证、已推送、已公开发布；分别标明证据范围。只在确实核对相关内容后更新核对日期与源码基线，未核实的认证或外部发布状态如实说明。
- 验证现行文档的链接、命令和新旧说明是否矛盾；`npm run check:hygiene` 仅检查登记规则及部分链接，不证明文字与行为一致。本地 `docs/` 是独立文档库，另行核对其中的引用；不因主仓库检查通过就略过它，也不擅自改变忽略或版本管理策略。
- 交付前检查差异与旧说法残留，并在结果中列出同步的文档及验证结果；若代码变化无需改文档，说明核对了哪些入口以及不受影响的原因。遇到缺失文档或不能核实的说法，应明确记录，不能声称已完成对应同步。

## 语言与构建

- 自有后端、前端、测试、安装和维护代码全部为严格编译的 TypeScript，关闭 `allowJs`，不使用 `noCheck`。Node 源码 `.mts`、浏览器 `.ts`、CLI `.cts` 分别发射为原 `.mjs`、`.js`、`.cjs` 路径；唯一自有 JS 源码例外是薄的 `scripts/build.mjs` 引导器。共享声明在 `src/contracts/*.d.mts`，不能用声明替代运行校验。
- 编译目录为 `dist/ts-build/package/`，不要手改 dist。开发使用 `npm start`；`npm test` 及分层测试先构建，再运行产物测试。源码根不能直接打包，使用 `npm run package:pack`。
- 历史 JSON 在对应读取边界验证消费字段；版本化检查点、授权、额度和业务状态仍由原验证器决定，不补写缺省版本或清零。`skipLibCheck` 仅限锁定 Pi 依赖的上游声明错误，不适用于自有共享声明。
- 发布验证当前只覆盖 Mac ARM64，Linux/Windows 打包与既有原生工作流不在收口范围。迁移过程与证据见 `docs/typescript-m2-m3-results.md`、`docs/typescript-m4-m5-results.md`、`docs/typescript-m6-m8-results.md`。

## 日常规则

- 品牌名称统一为 **NEUMA**（纽玛），取意音乐记谱 *neuma*；界面文案、模型自称与文档使用同一拼写。命名依据见《NEUMA 需求层产品设计报告 v1.1》开头，兼容旧数据时保留既有内部字段。
- 架构设计检查点、角色与阶段轮次、局部修复授权、历史兼容及恢复条件详见 ARCHITECTURE.md 第 4 节，修改行为时同步更新该文档。
- 研发层遵循 [docs/development-layer-design.md](docs/development-layer-design.md)：五阶段、开发与独立评审两角色。修改节点、上下文、预算、验收或交付时同步更新该文档与 ARCHITECTURE.md；状态由控制器发布，不能以模型自述通过代替真实验证。隔离执行缺少能力或探测失败均阻止执行，不提供无隔离回退。
- 涉及界面时以用户实际使用的桌面端为范围，不主动增加窄屏设计、适配或验证；此项不限制后台架构建设。
- 页面检查优先使用 Codex 内置浏览器。`npm test` 默认不启动外部浏览器；仅手动设置 `NEUMA_REQUIRE_BROWSER_TESTS=1` 或 `NEUMA_TEST_BROWSER` 时启用外部浏览器测试。macOS 默认选择 Dia，不自动回退到 Edge；Dia 当前尚未通过现有无界面测试参数的兼容验证。
- 为使修改生效而需要常规重启本机 NEUMA 后台时，直接完成重启并验证服务恢复，不再让用户代为操作或重复请求许可；不因此自动重跑用户的真实业务任务。
- 需求澄清逻辑与项目助手继续独立；正式架构源码在 `src/architecture/architecture*.mts`，评估后的构建和运行/辅助数据源码在 `src/agents/agent-prototype.mts`；运行产物扩展名仍为 `.mjs`。
- 前端使用 NEUMA 的接口和消息事件，不依赖 Pi SDK 原生事件或对象。
- 保留需求、稳定 Agent ID、独立会话、真实失败/取消状态；预算与授权先行持久、重启不重置、不重写历史数据等红线见 ARCHITECTURE.md 第 11 节。
- 没有连接的外部服务不能声称已经执行。用户 Agent 的文件工具仅操作自己的工作目录，不复用项目管理权限。
- 不读取或输出 `.env`、密钥或凭据；不添加分析、遥测或额外模型目录网络请求。用户已授权的架构资料检索仅在工具触发时访问固定官方资料，不把权限授予工作 Agent。

## 验证

- 改行为时更新相关 Node 测试，优先覆盖独立故障边界，不为凑数量重复参数组合或锁定无关的文案、class、属性顺序。日常修改先运行受影响测试，`npm run test:unit` 和 `npm run test:integration` 可按层验证；提交或推送前执行 `npm test` 全量回归。`npm run test:browser` 仅在明确需要外部浏览器验收时运行，页面检查仍优先使用 Codex 内置浏览器。技术依赖按需求、选型依据和验证结果决定；现有 Pi SDK 与原型命名不构成永久要求。
- `npm run check:hygiene` 检查模块依赖（区分运行时与类型导入、例外须登记理由）、测试登记、维护文档链接与误生成文件；只读源码树，无 dist 也可运行，已接入 Mac CI。
