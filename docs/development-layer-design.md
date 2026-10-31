# NEUMA 当前研发规范

- 核对日期：2026-10-25；源码基线：主仓库 `e4f1974`。本文按当前控制器、契约、执行器和对应测试整理，描述现有行为及维护边界。
- 总体流程和跨领域约束以 [ARCHITECTURE.md](../ARCHITECTURE.md) 第 5、6、11 节为入口，日常操作遵循 [AGENTS.md](../AGENTS.md)。实现变化时同步更新对应主题；与当前源码和测试不一致时，核实后修正文档。
- 整理前 671 行编年正文完整冻结在 [研发演进档案](history/development-chronicle-2026-10.md)，仅用于追溯。旧架构的两轮、十二轮及三阶段三轮/十五轮记录不能作为新构建默认值；上游架构预算、修订和显式续评见 ARCHITECTURE.md 第 4.1、4.3、4.5、4.6 节。

## 1. 接收条件与执行分流

研发负责把已经通过完整程序检查和独立评审的架构转为代码、实际验收证据和交付包。模块草稿、结构检查、模型自评及未完成的范围复核均不构成研发授权。稳定 Agent ID、需求、架构版本和候选摘要必须保持绑定；改变业务范围、关键接口、权限或交付选择，应回到架构层形成新版本。

无托管页面、无操作代码的轻量方案可以直接生成执行定义；`workflow`、`custom` 以及需要托管页面或操作代码的方案进入研发。v3 架构的 `execution.language="none"` 不进入代码研发，控制器保留进度并要求核对分流。旧 `buildable` 不是研发入口的唯一条件。

| 架构与计划 | 当前执行协议 | 必须核对的内容 |
|---|---|---|
| 旧 v1 | `node-json` | 按原协议读取和验证，保留历史摘要 |
| v2 | `schemaVersion=2`、`node-action` | application、动作及页面交付与已评估架构一致 |
| v3，`execution.hosting="builtin"` | `schemaVersion=3`、`node-action` | 保持已评估的内置 Node 执行选择 |
| v3，`hosting="managed"` 或 `"docker"` | `schemaVersion=3`、`managed-service` | 服务 `language`、`host` 与架构选择完全一致 |

Node 内置动作只使用 Node 内置模块和交付快照内自写模块。受管服务支持 JavaScript/Python；依赖和托管方式由已评估选择、锁定工件与实际环境检查决定。缺少执行适配或探测失败时阻塞，不提供无隔离回退。

实现：[研发入口与控制器](../src/development/development.mts)、[计划校验及版本分流](../src/development/development-contract.mts)、[架构是否需要研发的判断](../src/architecture/architecture-contract.mts)。

## 2. 五阶段、两种角色与状态归属

| 阶段 | 工作与进入下一阶段的条件 |
|---|---|
| `intake` 接收设计 | 冻结需求、已批准架构、版本及摘要，建立独立工作区，核实执行环境与隔离能力 |
| `planning` 拆分并检查任务 | 规划会话提出任务及验收材料；程序检查引用、依赖和覆盖，独立评审通过后接受计划 |
| `implementing` 开发当前任务 | 按依赖选择任务，装配精确文件授权，实现、自测并提交实际工作成果 |
| `verifying` 检查验收 | 对固定快照运行任务回归或整体验收，再进行独立评审；测试通过且没有阻断问题才放行 |
| `packaging` 整理交付 | 封装代码、应用清单、版本和证据，再核对上游；运行层另行检查和激活 |

开发角色负责规划、实现、自测和修复，但规划会话与各编码任务会话分别建立。评审角色为计划、任务代码、整体验收等精确对象建立独立只读会话，不修改代码，不继承开发者聊天。程序控制器管理阶段、任务、文件权限、预算、测试、恢复和交付，只有它能发布通过状态。

正常开发按任务顺序写代码；多问题或单个跨任务问题通过独立修复子 Agent 提交补丁，程序统一合并和写入工作区。验收读取固定快照，等待验收期间不继续写入。任务 A 通过后保存其历史与交接，再建立任务 B 的会话；接口、决定和未解决问题必须交接，A 的完整聊天不复制给 B。

新v2/v3批次以 `workloadPolicyVersion:1` 启用按工作量分派。初始规划超过24条正式需求或10项验收时，先生成全局接口、任务骨架、动作归属和激活作用域，再分组设计冻结用例；骨架每任务最多24条需求、6项验收，用例组最多4项分配组合、12例。总200例、材料及夹具容量预分配到组，组内按同源契约校验，完整计划再合并校验并封存。较大评审按每24条需求、6例、8个代码文件及全局接口分组，所有独立分项完成后由程序汇总，阻断意见不能被其他组的通过覆盖。任务评审只要求当前及已完成任务的实现。分派最多3组并发，完整结果、私有会话与调用先保存；重启只继续未完成组，合并不合法时退回分组并保留用量。

计划修订、单任务修复、整体验收/交付启动修复共用动态修复调度。评审问题可附原计划 `taskIds`、`files`、`candidatePaths`；失败用例按真实 caseId 查找责任任务；同任务、相同执行诊断的失败可合组，仍保留全部逐例证据，不能据此宣称已证实同一根因。一个问题涉及其他任务也会分派。按归属分组，每组最多三个问题，长意见提前拆分，归属不明时单独分派。最多三个子会话同时提出局部补丁；原任务依赖及重叠修改按序执行，后续组读取前序已合并版本。子 Agent 不直接写共享工作区；每份提案必须带本组全部问题编号和当前基底摘要，越界、重叠补丁及过期版本拒绝。多组提交不代表问题已关闭，最终仍须完整验收与独立评审。

修复子会话优先直接获得本组字段、需求和契约，未内联原文按同源读取工具的批次及版本游标获取；末轮只开放正式提交。各批实际额度先扣除其他待办的提交预留，再分配给本批子会话；读取、纠错和提交共用原累计用量。共享调度器支持业务校验回调及坏结果退回，退回保留原结果、会话和用量，消费旧基底的下游在修正后重新绑定。代码组在完成前检查文件集合、路径、无空字符UTF-8文本、2 MiB单文件及200文件，完整合并再核对10 MiB总量，避免独立增减文件时相互阻塞；合并不合法会在原额度内退回，写入前复核，并先写缩小的文件，避免中间状态超额。

研发状态、当前阶段与运行就绪分别保存。研发可以已完成而交付仍待连接或待运行层接入；已取消、失败、阻塞和中断必须如实保留。新的失败版本不能替代旧活动版本，也不能借旧版可运行冒充新版已经交付。

## 3. 规划材料、冻结计划与历史参考

v2/v3 规划者只在独立的 `development/workspaces/<runId>/planning/` 目录写 JSON 数据。索引保留任务、运行时、入口及 application 等计划字段，用有序 `caseFiles` 引用研发用例，`activationCaseFiles` 可引用独立启用前用例；正式提交仅发送 `indexPath`。旧 v1 直接结构提交继续兼容。

规划工具及宿主检查保持以下边界：

- `save_plan_json` 接受结构化对象/数组或只严格解析一次的完整 JSON 文本；`save_plan_cases` 接受非空原生用例数组。普通字符串不自动解释成夹具，也不递归解码或修复非法文本。
- 原生 `read/write/edit`、JSON 保存及更新共用目录、链接、权限、配额、取消和原子写入检查。代码工具不能访问规划材料，开发者不能修改冻结断言。JSON Pointer 更新、按用例编号的编辑和恢复必须核对正确作用域的摘要。
- 用例批次覆盖必须保留原稳定编号；删除或替换须使用带当前文件摘要的显式编辑。不能仅用修改过的少数用例覆盖完整批次。
- 写入与正式提交均复用同源契约检查。诊断汇总独立问题，保留稳定编号、总数、截断及分页入口；局部草稿保存、预览 `valid` 或材料摘要只表示相应检查结果，不表示计划已经接受。
- 正式提交在整组锁内封存只读材料快照，组装完整计划，核对任务/验收覆盖、动作及迁移覆盖、依赖、文件、输入、替身和断言，再交独立计划评审。首次空工作区按真实调度顺序检查入口是否及时存在；已有代码的恢复不能套用空目录假设。
- 每个 `(task.id, acceptanceId)` 分配组合都须有对应执行用例。公开动作、迁移动作须有实际执行证据；集成任务、输入拒绝或专属激活用例不能替代前序任务的研发覆盖。正式修订保留冻结输入、替身、断言及验收范围。

规划材料单文件最多 **2 MiB**、总计 **10 MiB**、最多 **201 文件**；研发和激活专用用例共用 **200 例**及全局唯一编号。代码工作区另限 200 文件，不能把其文件数套给规划索引。任务需求引用与正式架构共用容量；具体契约由 [共享需求限制](../src/requirements/requirement-limits.mts) 和 [计划契约](../src/development/development-contract.mts) 定义。

尚无合法计划时，规划者可用 `submit_development_blocker` 提交带冻结来源依据的技术阻断。宿主验证后保存 `blocked` 和反馈；该结果是不可信的规划意见，不是独立评审、有效计划或交付授权。

失败研发的计划、评语、规划草稿和公开工具失败可以在严格绑定下作为新轮参考。它们保持来源、摘要和不可信标记，不继承旧会话、代码、预算、权限或通过状态，不改写旧记录。已接受计划的同批次恢复仍用原预算；未接受规划且耗尽时，只有用户明确选择“新一轮研发”才建立新批次。历史草稿必须由原存储和快照核对，不从模型聊天重造。

实现：[规划材料与工具](../src/development/development-artifacts.mts)、[规划阻断](../src/development/development-planning-blocker.mts)、[历史规划失败来源](../src/development/development-sessions.mts)、[输入测量](../src/development/development-case-facts.mts)、[计划评审对象绑定](../src/verification/plan-review-subject.mts)。

## 4. 会话、上下文与有限预算

研发代码依赖 NEUMA 自有运行契约；Pi 类型、原生历史读取和文件工具工厂在适配边界内。恢复仍逐项检查原绑定，工具仍调用 NEUMA 的安全文件操作。模型上下文容量通过自有接口传递，保留原请求时投影和压缩行为。公共准入和资源清理只处理顺序与释放，不合并规划、开发、评审额度。


Pi 负责单角色模型/工具循环、原生文件编辑、会话历史和压缩；NEUMA 负责业务状态、绑定、权限、预算和验收。规划、当前开发任务以及每个精确评审对象分别绑定原生私有会话。相同对象中断后恢复原会话；计划、授权、代码或报告对象变化时重新核对对应范围，不把旧通过结论迁移为新证明。

原生历史不能自行授予验收状态或刷新预算。已知会话引用丢失、损坏或绑定不符时明确拒绝；旧记录没有保存过原生历史时按原检查点接手，不伪称恢复完整记忆。规划、评审和分组节点关闭自动压缩；开发会话只在剩余调用充足时使用 Pi 原生压缩，临近提交预留时关闭，不按固定占用比例轮换任务会话；完整需求、计划、快照和报告仍由宿主提供。

首包先按角色投影，字符额度为 `min(角色上限, max(4096, floor(contextWindow / 2)))`：角色上限开发 **24,000 字符**、规划/评审 **64,000 字符**，未知模型窗口按 32,768 处理。规划优先架构和正式需求，开发优先当前任务、验收、依赖及代码，评审优先被评对象及实际报告。完整字段标 `full`，子集或摘要标 `summary`，其他内容通过 `read_development_context` 同源读取：每项默认/最多10,000字符，一次最多8项、合计24,000字符；nextRequest绑定原文版本，旧section/pointer/offset/limit继续兼容。只有原完整消息仍在当前原生上下文且之后有成功回复时，才签发 `delivery=session` 复用；压缩移走原文后按原角色恢复资料。

当前默认模型与业务预算如下，局部及总预算以先耗尽者为准：

| 范围 | 默认上限 |
|---|---:|
| 当前规划范围的累计模型回合 | 12 |
| 单个开发任务的累计模型回合 | 40 |
| 同一精确评审对象的累计模型回合 | 12 |
| 一次研发的自动纠错总量 | 6 |
| 计划修订 | 1 |
| 同任务初始开发后的修复 | 2 |
| 整体验收的集成修复 | 2 |
| 新批次每个修复子会话的累计模型回合 | 12 |
| v2分组修复的累计模型回合 | 组数 × 12，最多 1200；旧v1仍最多120 |
| 新分组规划的骨架 / 每个用例组 | 12 / 8 |
| 新分组独立评审的每组 | 6 |

上述自动纠错次数按整次修复批次扣减，多个子组不重复扣一次业务修复额度；子会话调用另存于该批次总账。新研发批次写入 `repairDispatchVersion:2`，分派最多400项问题，批次共享总额先预留后续组的读取/提交次数；v1历史仍保留160项/120次总额，不自动升级或重领用量。规划/评审分组使用独立持久总账，每次分派总额按已确定组数和各组上限计算（共享调度上限1200）；已知分派缺失拒绝新建。独立评审仍使用原评审额度，修复子任务不能花用评审额度。调度只读原证据，不新增联网或业务执行权限。

实际模型请求前先持久化扣数；正常调用、工具续轮、格式修正和原生压缩共用对应范围的累计额度。重建控制器、重启、取消后继续或返回节点均不刷新，同绑定恢复也不能放大已保存上限。网络重试由共享 Pi 适配层管理，当前最多五次；业务控制器不叠加重试循环，也不把网络重试重复扣成业务回合。首包和工具回执的预算提示由宿主计数，业务账本为权威。新工作量策略的最后一次请求只开放正式提交，后端也拒绝读取、写入或自测继续占用末轮。

单轮输出按 [model-limits.mts](../src/runtime/model-limits.mts) 和实际模型能力计算：非思考配置的规划/开发/评审基数为 8192/16384/4096 tokens；声明思考能力时基数乘四，并受模型输出能力及 SDK 实际上下文约束。规划和开发请求 `reasoningMode=auto`，研发独立评审请求 `off`；档位由锁定 SDK 按模型支持映射，不保证一定能关闭思考或产出正文。模式变化不重置会话、预算或提交门槛，不读取思考正文作为诊断。

模型等待只检测连续无数据，默认 90 秒；配置兼容旧命名，但不设生成总时长截止。持续收到数据可以超过该间隔，执行命令和服务调用仍各有有限超时。无响应、截断、取消、输出额度及回合耗尽保留不同原因，不能当作评审否决或验收通过。

正常结束时唯一完整 JSON 若严格匹配本轮终止提交协议，可进入与正式工具相同的校验和消费路径；普通文字、非终止工具正文、围栏、歧义或异常结束不执行。尚未提交时至多在原会话提醒一次，使用原剩余额度。原始工具参数在 SDK 类型转换前校验；相同工具、契约与参数连续三次结构拒绝后停止，不能由同回复后续调用绕过。结构诊断只保存有界安全字段，不回显参数值、陌生字段、异常正文或凭据。

实现：[控制器](../src/development/development.mts)、[上下文投递](../src/development/development-context.mts)、[会话与绑定](../src/development/development-sessions.mts)、[Pi 原生会话](../src/runtime/pi-session-state.mts)、[统一提交协议](../src/runtime/pi-submission-contract.mts)。上游角色预算及授权只在 ARCHITECTURE.md 第 4.1、4.6 节维护。

## 5. 真实验收与证明范围

开发自测与任务验收共用当前任务和所有已通过任务的冻结用例范围，未来任务缺文件不提前算失败；正式验收后再进行独立评审；全部任务完成后，对同一最终快照重新执行完整用例及整体评审。自测、单任务曾经通过和模型报告完成都不能代替这两级门槛。持久状态方案按冻结顺序复用本轮全新测试范围，普通用例保持独立；不同验收轮次重新建立范围，不借用真实用户文件。

| 证据类型 | 实际能证明的内容 |
|---|---|
| `action` | 在选定输入、精确匹配并逐次消费的能力替身下，实际隔离执行代码与输出断言；不证明真实外部连接 |
| `node-check` | 独立 Node 入口实际检查资源或纯逻辑；不进入用户动作，也不证明浏览器交互或视觉效果 |
| `input-rejection` | 同源准入校验器确实拒绝动作值或任务信封；不运行代码、能力或流程，明确 `actionExecuted:false` |
| `host-business` | 按冻结启用用例在真实宿主能力及隔离 Node/Python 环境执行选定业务；未执行部分仍待验证 |
| `delivery-review` | 与当前计划、代码和真实报告绑定的独立评审；不能替代业务执行 |
| HTTP/MCP 目录、环境或文件探针 | 各自的配置、访问或往返事实；不能外推整套业务已通过 |
| 对话验收 | 当前活动交付的实际对话及工具回执，由无执行权限的独立会话核对；不以一次回复覆盖全部场景 |

程序测试区分 `passed`、`failed`、`not_run`、`error`。超时、环境异常、未处理崩溃和无关失败不能算负例通过；负例必须匹配冻结的拒绝行为、错误码及业务断言。输入结构合法但业务应拒绝的场景仍由真实动作执行，不能改成平台结构拒绝来规避实现。

`input-rejection` 的目标区分 `action-value` 和 `task-envelope`。动作输入与服务输入分别遵守原协议额度；信封拒绝只检查固定合法验证信封的 128 KiB JSON 边界，不证明任意元数据、HTTP 或 MCP 传输。报告由 [input-rejection-contract.mts](../src/verification/input-rejection-contract.mts) 统一描述实际目标、字节、限额和未执行事实，不冒充动作输出。

大样本使用声明式 `{fixture:节点}`，不要求模型逐条写满样本；普通 JSON 文本只严格解析一次。当前配方支持固定的 value、object、array、repeat、index、text、json、concat、join、measure，不执行脚本、文件、网络或业务答案推导。配方最多 12,000 UTF-8 字节、256 节点、12 层；repeat 最多 10,000，展开最多 100,000 节点；普通结果最多 1 MiB，输入拒绝样本最多 1 MiB + 64 KiB；每用例合计 4 MiB、每计划/验收合计 16 MiB，文本合成与测量另共用 16 MiB 工作额度。正式 Node 动作 128 KiB、受管服务 1 MiB 输入限制不会因夹具扩大。

`caseFacts` 和 `materialChecks` 只报告当前输入、规范 JSON、内嵌文本及明确材料的实际测量，不把模拟写入回执当真实文件。预期值需要独立依据，不能用被测输出倒填；容量上限不等于所有单项边界都可同时达到。需求侧留下的后续验证义务必须继续进入研发、激活或运行期对应台账，模拟、推迟和资料齐全都不表示已经执行。

启用前业务用例可以独立保存在 `activationCases`，不计入研发通过数。`activationChecks` 引用既有研发用例或本项专用用例；输入、替身、断言、范围及顺序随计划冻结。缺省 `executionScope="isolated"`；显式 `shared` 按冻结顺序复用数据和文件范围，受管服务同时复用后台进程，内置 Node 动作仍每次启动新隔离进程，不能证明常驻内存行为。

对话复核最多三次模型调用，保持精确引用与真实版本绑定；未触发、故障或证据不足继续待验，不相关后续对话不抹掉既有证据。完整适配器与逐项台账由 [acceptance-contract.mts](../src/verification/acceptance-contract.mts)、[启用前真实业务验证](../src/verification/activation-business-verification.mts) 定义。

实现：[Node 执行与验收](../src/development/development-executor.mts)、[受管服务验收](../src/development/managed-verification.mts)、[夹具与额度](../src/development/development-fixtures.mts)、[原始测试材料审查](../src/development/development-test-material-audit.mts)、[独立对话验收](../src/verification/conversation-verification.mts)。

## 6. 执行环境、页面与权限

Node 动作和 `node-check` 使用真实操作系统隔离，只读代码快照及受控可写临时范围；设置 cwd 或过滤命令字符串不构成隔离。生成代码通过可信 stdin/stdout NDJSON 启动层调用已授权的 `ctx` 能力，不直接联网、监听端口、启动任意子进程或读取用户凭据。运行生成的 `.mjs` / `.js` / `.cjs` 文件仍是协议允许格式，TypeScript 源码迁移不改变交付协议。

受管服务的 manifest 固定语言、host、入口、公开/内部操作、schema、连接、依赖锁、资源、数据版本及可选 workflow。直接托管依赖只接受允许来源的纯 JavaScript 包或匹配平台的 Python wheel，解析结果须有真实版本、下载地址及摘要，安装器验证工件；复杂系统依赖走受控 Docker。Python 必须由实际 Python 进程验证；本机没有真实 Docker 引擎验证时不能宣称容器已交付。

服务按 Agent、交付版本和私聊/群范围隔离，沿用全局工作槽及同 Agent 串行规则。默认请求上限 **600,000 ms**、内存 **512 MiB**；主机监控和容器硬限制分别报告，不互相冒充。服务的临时范围和日志有界，关闭网页不停止后端服务；后台退出负责回收进程与受管容器。停止时台账保存失败仍执行全部匹配进程的终止；验收收尾分别尝试关闭流程控制器、停止各服务作用域和删除临时流程目录，最后报告清理错误。实际环境和依赖由 [服务管理器](../src/services/managed-service-manager.mts)、[服务契约](../src/services/service-contract.mts) 及 [依赖管理](../src/services/service-dependencies.mts) 处理。

流程控制器保存冻结步骤、依赖、尝试次数、检查点和结果引用。等待用户输入不持续占用工作进程；继续时核对版本及幂等编号。非幂等步骤在失败或重启后无法确认副作用时进入 `needs_review`，需要核实完成结果或明确授权重试，不自动重放或扩大动作权限。新记录保存唯一尝试编号、分派阶段与结果引用；新核实请求须携带当前 attemptId。网络回执丢失后，同一次动作内再次分派也会被阻止。实现见 [workflow-controller.mts](../src/services/workflow-controller.mts)。

页面由 application 清单列出入口与资源并绑定快照，可调用 `window.neuma.actions/tasks/state/materials/artifacts/settings`。页面需要 AI 助手时复用宿主助手桥，不另造模型凭据通道。`setContext` 的页面上下文信封最多 16 KiB；任务订阅需核对上下文 revision、交付版本和真实任务结果，迟到结果不能覆盖新选择。页面重开通过宿主 `state/tasks` 恢复，独立 origin 的 localStorage/sessionStorage 不作为跨次权威存储。前端协议源码见 [application-frame-bridge.ts](../public/application-frame-bridge.ts)。

页面、Node 动作与检查可以相对导入同一快照内自写的纯 ESM 模块，浏览器模块列入资源清单；共享模块不能混入 DOM、Node 专属 API 或凭据。页面 CSP 禁止 eval、Function 和远程脚本。资源与 Node 逻辑检查必须明确 `browserVerified:false`，不能宣称已经做过真实浏览器或视觉验收。

上传材料的权威原件保存在 `attachments/<材料 ID>/original/`，`workspace/inputs/` 只提供工作副本。工作目录操作不改变材料服务的原件；公共工具保护登记输入副本，结果另存产物。材料和运行文件单文件最多 **20 MiB**，保持路径、普通文件、符号链接及硬链接检查；代码单文件 **2 MiB**、总计 **10 MiB**、最多 **200 文件**。历史超限材料保留记录，但读取、转交及运行明确拒绝。

## 7. 检查点、恢复与关闭

制作/研发页面先取得持久操作回执，再独立查看。关闭页面只解绑查看；明确停止才取消真实执行。操作索引保存架构版本和研发编号，不产生第二套业务终态或调度额度；重启不自动 resume。接口与快照规则见 [用户指南](user-guide.md)。


本地记录、工作区及快照按 Agent 归属：

| 相对 Agent 存储根的位置 | 内容 |
|---|---|
| `development/records/` | 业务检查点、计划、任务、预算、交接、报告及交付引用 |
| `development/workspaces/<runId>/code/`、同级 `planning/` | 实际代码与候选规划数据 |
| `development/snapshots/<hash>/` | 固定代码快照 |
| `development/planning-snapshots/<hash>/` | 正式规划材料快照 |
| `development/planning-draft-snapshots/` | 未接受规划的私有历史草稿 |
| `development/sessions/<runId>/<bindingHash>/` | 私有原生 JSONL 会话及绑定 |
| `development/repair-sessions/<runId>/<batchHash>/` | 修复子 Agent 的独立原生会话 |
| `development/repair-planning/<runId>/<candidateHash>/` | 合并规划的材料暂存，正式结果仍封存到 planning-snapshots |

会话目录 0700、文件 0600，私有路径和绑定元数据不进入模型业务上下文。旧格式只在统一存储边界迁移，不能重算旧摘要、预算或证据；删除标记阻止残留记录恢复。每轮使用独立研发工作区，不把工作 Agent 的用户文件或记忆目录当代码生成目录。

阶段结果先校验、再保存 `pendingResult`，随后由控制器消费并落盘业务迁移。最后允许回合后的崩溃恢复，先核对对象、计划、代码摘要和授权，再消费已有有效结果，无需新请求或刷新额度。旧越权 `changedFiles` 提交仅在精确识别后清理该错误结果，保留原历史及用量；其他损坏不能用这条兼容路径掩盖。

恢复研发必须重验当前架构、计划摘要、任务定义、授权、规划快照、实际代码和会话绑定。独立评审只有同一 `codeHash`、`planHash`、`reportId` 和 subject 才能复用既有报告与会话；工作区有未记录改动时保留新快照并标记未验证。测试中断不算完成，可重复的隔离测试可以重跑；副作用未知的操作先核实。

取消停止新调度，终止在途模型和受管执行，保留已有改动、检查点和真实原因。每次结果写入前核对运行标识及取消状态，迟到结果不能推进成功，也不承诺撤销已经发生的外部操作。关闭需等待在途工作、记录持久化及资源回收，独立清理边界的失败不能阻止其余资源释放；具体所有权由当前控制器及服务实现管理。

实现：[研发存储](../src/development/development-store.mts)、[工作区及快照](../src/development/development-workspace.mts)、[Agent 存储边界](../src/agents/agent-storage.mts)、[会话绑定](../src/development/development-sessions.mts)。

## 8. 失败流转、交付与激活

| 情况 | 后续动作 |
|---|---|
| 当前实现或已完成功能回归失败 | 多问题或单个跨任务问题按原责任文件分派；单个本任务问题沿原会话修复。缺入口、代码超时/输出超限等已识别执行错误保留error证据并进入有限修复，之后完整重验 |
| 整体集成失败 | 保存绑定原需求和证据的修复任务；新批次多问题交动态调度，子组提交后重新整体验收 |
| 任务遗漏或依赖错误 | 在剩余计划及总修订次数内修订；新批次多问题分组提交计划补丁，保留已接受的冻结用例并完整校验、封存和复评 |
| 架构、业务范围或权限矛盾 | 保存阻断与依据，返回架构层；不由开发者删除需求或降低门槛 |
| 环境、模型或执行异常 | 保存真实分类及检查点，按各自受限策略处理；不记成业务通过 |
| 只缺最终运行连接 | 可以完成隔离研发，运行状态仍如实待连接 |
| 回合或纠错预算耗尽、同参数错误锁定 | 保存失败或阻塞及已有成果；无法直接恢复时标记blocked continuation，不显示无效继续入口。未接受规划耗尽仍须显式新一轮；不能自动通过、重领额度或静默新建批次 |

交付包绑定 Agent、需求、架构版本和候选摘要、计划、代码及验证版本。资源和应用清单与同一代码快照绑定，真实报告可追溯。运行层先核实实际运行能力、入口、依赖、配置、授权、快照及必要证据，再通过受控启动检查激活；不使用可能产生外部副作用的正式 Node 动作随意冒烟。

研发完成、运行就绪、真实连接调用和业务效果分别表达。缺连接不伪装已验证；无安全测试操作的已配置连接可以保留未验证，只有已设计的真实调用和实际回执能形成相应证明。HTTP/MCP 网关默认关闭，只开放已验收动作和显式授权范围，配置与目录检查不能外推业务通过。对可选网关未配置的活动应用，内部功能可以保持可用，外部台账仍待配置或待验证。

激活前再核对上游版本和当前活动对象，以持久事务切换。新版失败、取消或未完成恢复不能覆盖旧有效交付；撤销必须精确绑定本次架构、候选和研发记录，不能误撤后续版本。新包存在缺陷时标记并保留历史，沿原预算进入修复，重新验收后生成新包。用户数据与已有运行任务的版本绑定继续保留。

跨数据版本激活必须声明迁移动作及独立验证动作，纳入冻结验收。在副本上备份、迁移并核对状态版本及目录摘要；先持久记录激活事务，再分步发布迁移数据、启动服务并切换连接配置与活动定义，最后记录完成。失败或重启时按事务状态核对并回滚或恢复；跨版本回退只允许匹配备份且数据没有后续写入的条件，不因回退代码静默覆盖业务数据。实现见 [激活入口](../src/agents/agent-prototype.mts)、[service-data-migrations.mts](../src/services/service-data-migrations.mts)、[应用运行层](../src/applications/application-service.mts) 和 [服务网关](../src/services/service-gateway.mts)。

## 9. 维护与验证入口

改节点、上下文、预算、计划材料、验收或交付行为时，同步更新本文对应主题与 ARCHITECTURE.md 第 5、6 节；上游架构专属协议在其第 4 节维护，不再按日期追加相互覆盖的规则。新增历史记录放入 `docs/history/` 并注明无规范效力，当前正文不能依赖外部本机仓库或冻结旧路径才能解释。

| 核对主题 | 当前测试入口 |
|---|---|
| 分组规划/评审与恢复、代码错误归属 | [development-work-dispatch.test.mts](../test/development/development-work-dispatch.test.mts)、[development-recovery-routing.test.mts](../test/development/development-recovery-routing.test.mts) |
| 五阶段与有限修复、计划契约 | [development.test.mts](../test/development/development.test.mts)、[development-contract.test.mts](../test/development/development-contract.test.mts) |
| 规划材料、索引、诊断、历史草稿 | [development-artifacts.test.mts](../test/development/development-artifacts.test.mts)、[development-index-contract.test.mts](../test/development/development-index-contract.test.mts)、[development-planning-draft-recovery.test.mts](../test/development/development-planning-draft-recovery.test.mts) |
| 会话、上下文、预算与待消费提交恢复 | [development-session-recovery.test.mts](../test/development/development-session-recovery.test.mts)、[development-context.test.mts](../test/development/development-context.test.mts) |
| 夹具、输入拒绝与证据范围 | [development-fixtures.test.mts](../test/development/development-fixtures.test.mts)、[development-input-admission.test.mts](../test/development/development-input-admission.test.mts)、[acceptance-execution-facts.test.mts](../test/development/acceptance-execution-facts.test.mts) |
| 隔离 Node、受管程序与流程 | [development-executor.test.mts](../test/development-executor.test.mts)、[managed-development-integration.test.mts](../test/development/managed-development-integration.test.mts)、[managed-workflow-verification.test.mts](../test/development/managed-workflow-verification.test.mts) |
| 真实启用前业务、交付、迁移与关闭 | [activation-business-verification.test.mts](../test/development/activation-business-verification.test.mts)、[development-delivery.test.mts](../test/development/development-delivery.test.mts)、[service-data-migrations.test.mts](../test/services/service-data-migrations.test.mts)、[managed-close-failure.test.mts](../test/services/managed-close-failure.test.mts) |

源码测试先通过 `npm run build` 编译，再运行 `dist/ts-build/package/test/` 下对应 `.mjs`；日常按受影响领域选择，`npm run test:unit` / `npm run test:integration` 可按层验证，提交或推送前按 AGENTS.md 执行全量回归。`npm run check:hygiene` 检查其配置范围内的依赖、登记、链接及残留，不代表本文每个行为已通过测试。

真实模型、真实外部连接及代表性业务验收另存当次用途、范围和用量证据。固定模型、模拟服务、源码核对、单元回归和旧历史记录都不能宣称本轮真实业务已交付。当前打包与发布验收范围为 Mac ARM64，其他平台的历史原生验证不扩大此范围。
