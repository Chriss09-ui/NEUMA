# NEUMA 当前开发约定

- 修改 Agent 的架构、构建、执行、会话或交互前，先阅读 [ARCHITECTURE.md](ARCHITECTURE.md)。它是当前正式架构基线，按主题说明各领域职责、状态归属、关键约束、验证入口和跨领域不变量。本文只保留每次开发都需要知道的规则；行为细节、数量限制和恢复语义以 ARCHITECTURE.md 对应章节为准，不在两处重复维护。
- 原型文档（`AGENT_PROTOTYPE.md`）、docs/history 档案与 `本地测试记录/` 均为历史验证证据归档，没有规范效力，无需作为开发前置阅读；其中冻结的源码与文件摘要只代表记录当时的状态，不得当作当前代码、接口或规范事实，不得据此恢复临时方案或限制新架构。判断现状一律以当前源码为准。

## 语言与构建

- 自有后端、前端、测试、安装和维护代码全部为严格编译的 TypeScript，关闭 `allowJs`，不使用 `noCheck`。Node 源码 `.mts`、浏览器 `.ts`、CLI `.cts` 分别发射为原 `.mjs`、`.js`、`.cjs` 路径；唯一自有 JS 源码例外是薄的 `scripts/build.mjs` 引导器。共享声明在 `src/contracts/*.d.mts`，不能用声明替代运行校验。
- 编译目录为 `dist/ts-build/package/`，不要手改 dist。开发使用 `npm start`；`npm test` 及分层测试先构建，再运行产物测试。源码根不能直接打包，使用 `npm run package:pack`。
- 历史 JSON 在对应读取边界验证消费字段；版本化检查点、授权、额度和业务状态仍由原验证器决定，不补写缺省版本或清零。`skipLibCheck` 仅限锁定 Pi 依赖的上游声明错误，不适用于自有共享声明。
- 发布验证当前只覆盖 Mac ARM64，Linux/Windows 打包与既有原生工作流不在收口范围。迁移过程与证据见 `docs/typescript-m2-m3-results.md`、`docs/typescript-m4-m5-results.md`、`docs/typescript-m6-m8-results.md`。

## 日常规则

- 品牌名称统一为 **NEUMA**（纽玛），取意音乐记谱 *neuma*；界面文案、模型自称与文档使用同一拼写。命名依据见《NEUMA 需求层产品设计报告 v1.1》开头，兼容旧数据时保留既有内部字段。
- 架构设计检查点、轮次、授权与恢复规则（v3 蓝图/模块/整合、每节点默认五轮、整条最多二十五轮、整条一次最多两轮的显式局部修复、旧 v1 检查点按三轮/十五轮恢复、整合耗尽后的程序恢复条件）详见 ARCHITECTURE.md 第 4 节，修改行为时同步更新该文档。
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
