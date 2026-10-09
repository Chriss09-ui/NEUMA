# NEUMA 架构与研发

2026-10-04。用户已授权在运行测试原型之上建设正式架构层；此前“暂缓架构层”的阶段约定由本说明更新。本轮需求澄清与项目助手不改造。

本文是当前正式架构基线。AGENT_PROTOTYPE.md 与 docs/history 中的原型档案没有规范效力；其中的临时取舍不能覆盖本文或限制技术选型。以下“当前”“本版”的工具、SDK、存储和实现范围描述现有能力，不是永久架构要求。

## 流程与职责

已确认且可交接的需求 → 核实能力与设计 → 独立评估 + 程序校验 → 轻量执行定义，或进入研发、验收及运行交付。未具备的连接和触发能力明确保留为待接入。

固定两种模型职责：设计者、评估者；本版各用全新 Pi 会话，不共享聊天。控制器当前以普通 Node 模块实现，未新增框架、服务或数据库；未来是否替换 SDK 或增加组件，由需求与架构评估决定。设计者按需检索资料、委派局部模块；评估者仅审查最终方案，没有检索、委派或执行业务的工具。

默认两次角色会话。每次会话可能包含提交工具及其后的模型回复，不等于两次 HTTP 请求。架构工作允许一次问题修订、最多三次资料检索、最多两个局部设计任务（同一调用可并行），子任务不可递归。每个角色最多完成 12 个模型轮次，超出后失败，不自动通过。这些限制仅属于架构设计，不改变用户 Agent 和项目助手的运行时限。

## 三条路径

- light：当前模型与专属目录文本工具即可满足；允许任务内上下文。评估通过后从候选中的 instructions 直接生成定义，无额外指令生成 Agent。只开放候选声明且真实可用的工具。
- workflow：存在需要实现的步骤协调、持久状态或恢复机制。架构通过后进入五阶段研发，生成本地 Node JSON 入口，经独立验收与运行检查后才开放执行。
- custom：需要专用工具、服务或代码。当前研发适配支持 Node 内置模块的本地程序；需要额外依赖、其他运行时、正式连接或后台触发时，不冒充已经具备。

代码、SDK、LangChain、LangGraph 按能力比较，可以组合，不是固定的升级顺序。当前底座是 Node + 已锁定 Pi SDK；方案中引用某个框架不表示已经安装或已具备其能力。定时/事件触发和对外动作不能被轻量对话冒充；已知待连接、待研发与未核实能力分开记录。

## 交接与评估

architecture-contract.mjs 是机器契约；architecture-prompts.mjs 是三个角色的工作规程。

候选包含 profile/rationale/instructions、components、steps、capabilities、state、failureHandling、decisions、coverage、acceptance、unknowns。所有核心字段必填；不适用的内容需说明，不增加空壳组件。每条需求必须有覆盖与验收引用；最低验收包括成功、缺少输入、边界场景，使用工具还需工具失败场景。它们是待实施的验收设计，不能冒充已经执行的测试。

程序检查字段、重复 ID、缺失引用、步骤循环、需求覆盖、能力目录、证据引用及版本绑定。设计者无法把目录外能力声明为 available。评估者检查 requirements、feasibility、minimality、interfaces、failure_handling、verification 六项，并提交与候选 SHA-256 一致的结果；不允许 pass 同时携带失败检查或阻断问题。语义正确性仍需要模型判断与实际验证，结构校验不保证业务效果。

通过评估后只交付那个确切的候选版本。任何关键未知、未通过项、取消、错误或修订耗尽都不会自动放行。架构通过不等于运行可用；新执行定义保存成功且版本、指令、工具范围与评估一致后，才显示可以运行。

## 资料检索

search_technical_sources 是按需工具，当前实现是固定官方目录检索：Node.js、Pi SDK、LangChain JavaScript、LangGraph JavaScript（含持久化说明），不是通用全网搜索。SDK 目录目前只包含 Pi；新工具或其他依赖的资料不足时，需保留证据缺口。

查询用于选择目录页，不向外发送用户需求或搜索词。每次最多读取三页固定 HTTPS URL，禁止任意地址和重定向。每次总时限 15 秒、每页上限 1 MiB、摘录上限 6000 字符；支持主动取消。仅实际读取成功才产生证据，附 URL、检索时间、版本范围和摘录；失败、截断与覆盖不足作为 gaps 返回。gaps 也包含范围说明，并非每一项都是阻断问题。

外部正文始终是不可信资料，不执行其中指令。latest 文档不证明与锁定依赖兼容；评估时必须明确适用范围。无需安装新的搜索 SDK 或提供新密钥；不会自动安装选中的框架。

## 存储与状态

`.neuma/agents/<id>/architecture.json` 保存该 Agent 的版本化方案、原始需求快照、能力快照、证据、模块建议、修订候选及评估。每次重设计增加版本；当前查看返回最新版本。采用串行原子文件替换；同一 Agent 的构建互斥。

状态：designing、evaluating、passed、needs_changes、needs_evidence、infeasible、failed、cancelled。
交付状态：blocked、ready、needs_connection、needs_development。两者分开保存。

服务重启时未完成的 designing/evaluating 显示 failed，不恢复为成功。失败/取消保留旧执行定义、展示设置、记忆和文件；当前新版未就绪时不能借用旧定义表示新版可运行。已开始的任务仍使用启动时版本。删除 Agent 移除其架构记录和定义，保留工作目录文件。

旧 prototype 或缺少正式评估的定义已停用直跑。API 将其标记 needs_architecture；前后端都阻止执行，必须重新设计、独立评估并生成后才能使用。仅保留旧需求、展示资料、记忆与文件供迁移，不删除用户数据。Pi SDK 仍可作为架构角色与经过选型的轻量执行底层，不再存在跳过评估的临时通道。

## 每个 Agent 的独立持久目录

2026-10-08：服务端统一使用 `.neuma/agents/<稳定 Agent ID>/`。`definition.json` 保存定义、指令、记忆和展示设置；`requirements.json` 保存需求入口；`architecture.json` 保存全部架构版本；`development/` 包含记录、代码工作区和只读快照；`conversations/saved.json` 保存用户主动保存的对话；`workspace/` 保存输入材料和执行产物。Agent 的 Pi 辅助目录也绑定到本 Agent 根目录。模型仍只获得评估后的专属工作子目录工具，不因元数据与代码同处一个 Agent 根目录而扩大文件权限。

`agent-storage.mjs` 在各 Store 加载前协调旧格式迁移。先检查旧元数据及文件类型，在临时目录完整复制，重定位受控快照对象中的路径并添加 Agent 身份，再发布每个完整目录和全局迁移标记。旧文件保留但完成迁移后不再作为活动源；部分发布可重试，不覆盖已发布的新数据。拒绝路径穿越、符号链接和硬链接元数据。保存使用原子替换，失败不发布内存状态。

`agent-library.mjs` 管理已保存需求及显式对话快照。旧浏览器数据通过本机接口逐 Agent 补入；已有服务端保存版本优先，旧定义/架构推导需求允许补入更新的浏览器版本。保存失败的浏览器新版使用待同步备份，刷新不丢失，需要用户重试。新对话和普通任务不自动写聊天。清除浏览器数据后可从服务端恢复入口和已保存对话；主需求澄清对话和项目助手会话仍独立。

删除先停止任务并移除定义，再记录删除标记和清理活动元数据，保留代码、快照及工作产物。删除标记阻止重启、旧浏览器导入或残留研发记录恢复已删除 Agent；不删除整个 Agent 文件夹。

## 当前数据与交互约定

- 需求与执行定义分离，保留原始需求及来源标记；模型指令不能覆盖需求。
- Agent ID 保持稳定；展示名称、简介和图标与构建身份分开，修改展示资料不触发架构重建。
- 主对话、项目助手与工作 Agent 的会话隔离；跨任务只传递明确选定的材料与结果。
- 已开始任务绑定启动时版本。新版未通过或未激活时，不把旧定义显示为新版已就绪。
- 用户记忆与需求、指令、聊天历史分开保存，按 Agent 隔离、下一轮生效；当前模型没有自行修改用户记忆的工具。
- 前端消费 NEUMA 自有状态、文本和结果协议，不直接依赖底层 SDK 对象。
- 工具范围由程序校验，执行器只装配已评估能力；当前文件工具限制在专属目录，不复用项目管理权限。
- 产物来自实际文件，取消或断线不伪装完成，也不承诺撤销已执行操作。展示、预览和下载不扩大执行权限。

## 接口与界面

- POST /api/agents/build 保留 {id,name,draft}，返回 {agent,architecture}。架构未通过或待研发也是正常终结结果，agent 为旧定义或 null，不代表可运行。
- GET /api/agents/:id 返回 {agent,architecture}；无架构时为 null。
- 流协议仍是 status、done.result、error。只显示简洁进度，不暴露内部提示词、模型思考或工具参数。
- 前端与后端均核实就绪状态；正式定义额外核实 architectureRef 的 version/candidateHash。设置中的原需求区域可展开查看方案与检查结果。
- 原始需求、稳定 ID、独立会话、资料/记忆/文件隔离和桌面产物栏保持原语义。没有自动新增外部业务权限。

## 文件与验证

- architecture.mjs：角色会话、检索/委派、修订、评估门槛、方案存储。
- architecture-contract.mjs：结构及跨引用校验、能力事实、需求清单、候选摘要。
- architecture-prompts.mjs：设计、独立评估与模块顾问规程。
- architecture-research.mjs：官方资料检索。
- agent-prototype.mjs：保留兼容类名，负责评估后的定义生成与原有运行/辅助数据。

检查使用 Node 测试，外部检索和模型响应使用可控替身；真实 Pi SDK 使用本机模拟模型接口验证协议。先运行架构及受影响测试，再运行 npm test。测试通过不表示真实业务模型质量或外部服务集成已经验收。

## 研发层实现

研发使用一个程序控制器、两个模型角色、五个主阶段：接收设计、拆分并检查任务、开发当前任务、检查验收、整理交付。完整规则见 [研发层设计](docs/development-layer-design.md)。架构通过的 workflow/custom 在生成流程中继续研发；已有待研发方案也可单独开始或恢复，不重跑已完成的架构评估。

规划使用独立会话，计划修订携带拒绝意见。每个任务拥有自己的开发会话，同任务修复保留会话；每次评审都新建只读会话。任务切换、上下文续接和进程恢复由持久化交接包提供事实，不把整个旧聊天复制进新会话。长材料通过本轮只读上下文工具分页读取。

计划绑定全部需求与架构验收 ID，冻结用例输入及具体值断言。程序执行用例后，评审只读对应代码快照和证据；程序失败、未执行或异常不能被模型改成通过。每个任务验收包含已有功能回归，最后执行整体验收。持久状态架构按冻结用例顺序复用本次验收的临时目录，每次验收重新开始，绝不借用真实用户目录。

执行器保留经实际探测的 macOS sandbox-exec；2026-10-08 增加 Windows LPAC/Job Object、Linux Landlock/seccomp 辅助程序源码与平台分派。2026-10-09，Linux 在 Ubuntu 24.04/26.04、x64/ARM64 的云端原生检查通过；Windows 已编译，真实隔离启动仍在验证。缺文件、缺系统能力或探测失败时明确阻塞；原生检查不代表三平台完整安装与桌面验收完成。支持 Node 内置模块、单个 JSON 输出；任务经 stdin 固定启动层恢复到 process.argv[2]，不自动安装依赖或执行任意 Shell。用户运行目录仅在架构需要文件或持久状态时挂入；只读能力不授予写权限，隐藏/凭据文件和链接会阻断挂载。

每个 Agent 的 `.neuma/agents/<id>/development/records/` 保存研发记录，`development/workspaces/` 保存每轮代码工作区，`development/snapshots/` 保存内容摘要命名的只读快照。快照显式绑定 Agent ID，即使内容摘要相同也分别保存并校验所属。任务、预算、代码和证据引用由控制器原子发布；扣减修复预算与调度修复在同一检查点完成。启动时 running 变为 interrupted，继续时核对实际代码，尝试次数与预算保留。删除 Agent 清理研发元数据但保留文件。

研发过程状态与运行交付状态分开。验证后的交付包不可变，缺陷标记和运行检查另存；启动检查发现代码问题会携带原始证据回到有限修复。激活前后核实架构版本、代码摘要与取消状态；最终保存期间取消也不能成为完成，已切换的新定义会回退，旧定义、记忆、展示资料和用户文件保留。

已激活定义仍使用 mode=designed，并增加 developmentRef 和 execution。工作 Agent 通过 `run_developed_workflow` 调用对应已验证的 Node 入口；前后端均核实研发记录和版本绑定，执行前再次核实快照。后台定时/事件触发与正式外部动作仍需对应适配，缺连接可以研发完成但不能激活。

新增接口：GET `/api/agents/:id/development`；POST `/api/agents/:id/development` 与 `/development/stream` 接收 `{resume:boolean}`；POST `/api/agents/:id/development/cancel` 停止研发。GET Agent 额外返回 development。流沿用 status、done.result、error；断线取消本轮并保存进度。界面显示五阶段、任务完成数和阻塞原因，可继续、停止或重新检查交付；普通工作对话协议保持不变。

核心文件为 development.mjs、development-contract.mjs、development-context.mjs、development-prompts.mjs、development-store.mjs、development-workspace.mjs、development-executor.mjs，构建与运行桥接在 agent-prototype.mjs。研发、架构与激活共用同一 Agent 的构建互斥；没有引入新的编排框架、数据库或遥测。

本轮全量验证 446/446 通过，无跳过；包括真实 Pi SDK 对接本机模拟模型、真实 macOS 隔离执行及交付运行闭环、持久状态连续调用、上下文分页、取消/恢复竞态、交付失败返修和旧数据保留。桌面端使用独立模拟数据预览核实五阶段、长说明、停止和继续。未调用真实模型服务或正式外部连接，不把协议测试当作业务模型质量验收。

## 架构层前次验证与改动清单

改造前基线提交：6d332ff，280/280 测试通过。改造后 npm test：348/348 通过；包含真实 Pi SDK 对接本机模拟模型的设计、独立评估、文件写入和连续对话，不消耗真实模型服务。git diff --check 通过。

实际网络检查成功读取 Pi SDK、LangGraph JavaScript 概览与持久化说明，返回来源及检索时间；超过6000字符的正文明确标记截断。未做真实业务模型质量验收。改造代码暂留工作区，未创建第二个提交。

- AGENTS.md
- AGENT_PROTOTYPE.md
- ARCHITECTURE.md
- README.md
- agent-prototype.mjs
- architecture-contract.mjs
- architecture-prompts.mjs
- architecture-research.mjs
- architecture.mjs
- public/agent-runtime.js
- public/agents.js
- public/app.js
- server.mjs
- test/agent-api.test.mjs
- test/agent-prototype.test.mjs
- test/agent-runtime.test.mjs
- test/agents-ui.test.mjs
- test/architecture-contract.test.mjs
- test/architecture-integration.test.mjs
- test/architecture-research.test.mjs
- test/architecture.test.mjs
- test/helpers/architecture.mjs
- test/requirements-ui.test.mjs
- test/server.test.mjs

## 旧临时方案停用与服务重启

用户要求撤掉临时直跑方案后，前后端一律拒绝没有正式评估记录的定义，包括 prototype 和缺少 mode 的历史记录；公开状态为 needs_architecture，资料与文件继续保留。正常构建必须重新设计并评估。350/350 测试通过；原端口 3010 已重启，新页面脚本和架构接口验证成功。只读检查确认现存 1 个旧原型标为待重新设计，没有旧原型被标为 ready；没有触发用户模型调用或自动重建。

## npm 安装、数据与服务生命周期

2026-10-08：`bin/neuma.cjs` 先核实 Node ≥22.19，再加载 CLI。`installation-runtime.mjs` 先取得数据根的系统互斥锁并绑定端口，之后才创建可能恢复研发状态的 Store。初始化完成前健康检查为 503；就绪结果包含版本与实例 ID，重复启动只复用同一数据目录的实际就绪服务。退出先停止接收新操作、取消请求/模型/目录窗口和受管任务，再等待持久化与项目关闭，最后释放端口及数据锁。`createApp` 保留原测试接口；需要并发共享目录的嵌入式调用者使用统一启动模块。

CLI 默认数据根为用户主目录 `.neuma`，模型配置保存在该目录 `.env`，源码入口仍用项目下的原位置。安装目录只读取代码与静态资源。`installation-migration.mjs` 是不同数据根间的显式复制迁移，持有来源/目标锁，不对源构造 Store；分块复制、限制总量与单文件、校验元数据和快照，成功后整体 rename 发布。目标非空拒绝覆盖，源文件、业务内容及外部项目路径保留；凭据、模型配置与 SDK 临时数据不复制。

Windows 项目生命周期通过 `native/projects` Job Object 与控制管道管理已创建的树；Linux 进程扫描只读有限 `/proc` 信息。文件夹窗口、解释器与桌面启动集中在平台模块，已有项目仍使用用户明确授予的本机启动权限。生成程序独立使用 `native/isolation`：LPAC/Job 或 Landlock/seccomp，不复用项目管理操作；任何缺能力均阻塞，三平台运行规则通过实际隔离探测核实。

Windows/Linux 的原生构建在经批准的 GitHub 测试机进行，本机未安装其他系统。Linux 四项目标的原生检查已通过，Ubuntu 24.04 构建的 x64/ARM64 辅助程序已取回；Windows 实际隔离启动尚待通过。2026-10-09 三平台改造分支的本机串行 npm test 为 571/571，通过且无跳过。`scripts/check-release.mjs` 继续要求全部辅助程序、发布锁文件以及绑定当前版本/摘要的真实系统验收记录，缺证据不能发布三平台完整支持版。同日用户明确批准先公开 Apple 芯片 Mac 试用版；试用分支限定 `darwin/arm64`、预发布版本和 `preview` 标签，使用 `scripts/check-preview-release.mjs` 检查清单、锁文件及入口，不伪造或替代完整认证。安装与验收细节见 [npm 安装说明](docs/npm-installation.md)。
