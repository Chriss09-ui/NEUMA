> 历史方案原文，非现行开发指令。2026-10-25 从源码基线 `e4f1974` 对应工作区的 `docs/repository-organization-plan.md` 逐字冻结；下方原文 SHA-256：`168c8ee49e9bf0f5c3344bad3b11356a2c7d8808b72d9ebec26f12ef439689d3`。
> 文中“当前”“拟新增”“待实施”、旧源码路径和测试数字属于原方案语境，不作为今天的实现或验收状态。原始参考链接可能已因迁移失效，不据此恢复旧实现。完成状态与证据见 [归档完成说明](repository-organization-completion-2026-10-25.md)。

---

# NEUMA 仓库结构与维护整理实施方案

- 编写日期：2026-10-24
- 状态：待实施方案；本文的计划、拟新增文件和验收命令均不代表已经完成。
- 源码盘点基线：本机主仓库提交 cca9088。后续实施前应重新确认提交、工作区和测试基线。
- 项目位置：/Users/chriss/Desktop/办公智能体/neuma-requirements
- 范围：前次评估的第 1、3、4、5、6 项。
- 文档位置：现有 docs 本地文档库；本次仅新增本文，不调整主仓库与文档库的版本管理策略。

## 1. 目标与范围

本轮整理的目标是降低理解和修改 NEUMA 的成本，使当前规则容易查找、模块职责更明确、测试能够按领域定位，并让少量关键规范得到自动检查。

五项方案可以分别评审、分批实施，不要求通过一次大重构同时完成。TypeScript 迁移已经完成，本方案属于后续工程整理，不重新开展语言迁移。

| 方案编号 | 对应前次建议 | 目标 |
|---|---|---|
| R1 | 第 1 项 | 当前架构说明、开发约定和历史记录各有归属 |
| R3 | 第 3 项 | 按实际职责提取辅助模块，缩小消费者依赖 |
| R4 | 第 4 项 | 按领域组织测试，保证发现、分类和执行完整 |
| R5 | 第 5 项 | 为关键依赖、测试清单和维护文档建立自动检查 |
| R6 | 第 6 项 | 核验并补齐取消、关闭、清理失败和迟到回调的验证 |

### 1.1 明确排除

1. 排除前次第 2 项：不开展旧开发资料的批量入库，不调整 Markdown 忽略策略，不改变 docs 的独立本地仓库安排。
2. 不对 docs/development-layer-design.md 是否过时作结论，也不将其作为本轮整理的设计依据。
3. 不引入 Cordis、全插件体系、monorepo 或新的依赖注入框架。
4. 不以整理为由改变提示词、模型请求次数、预算、授权、历史数据格式、验收门槛或用户可见业务流程。
5. 发布验证继续限于 Mac ARM64；不修复、扩展或认证 Linux/Windows 打包及既有原生工作流。
6. 不重跑用户真实业务任务，不访问真实模型服务，不读取或输出密钥和用户业务数据。

需要改变业务行为才能继续某项整理时，应将该行为变化拆成单独问题、单独回归测试和单独提交，不能混入文件搬迁或函数提取。

### 1.2 依据与判断方式

当前行为通过现有实现、已有测试和用户已经确认的约定交叉核对。文档是需要核对的资料；代码能够运行也不自动证明行为正确。

发生冲突时，应记录具体条目、实现位置和测试证据。能确定的内容再写入当前说明；无法确定的内容暂记待核实，不采用“日期较新所以必然正确”的判断方式。

本文涉及的新目录、脚本和命令均注明为拟议内容。现有文件使用本机绝对路径链接；文件移动完成后，应同步更新维护中的引用。

## 2. 已核对的现状

以下是本次只读盘点结果，不是新一轮运行测试的结果。

| 项目 | 现状 | 对实施的影响 |
|---|---|---|
| 语言与构建 | 自有代码已经严格编译，运行产物位于 dist/ts-build/package | 复用现有构建，不新增平行流程 |
| 架构说明 | ARCHITECTURE.md 为 909 行，含大量按日期追加的历史说明 | 优先整理当前规则与历史记录 |
| 架构控制器 | architecture.mts 为 2284 行 | 先按职责检查提取机会，避免按行数机械拆分 |
| Agent 控制器 | agent-prototype.mts 为 1849 行 | 优先提取低状态辅助功能 |
| 运行测试 | 250 个顶层 .test.mts 文件 | 领域分组前先改发现机制 |
| 测试相关 TS 文件 | 278 个，含测试、辅助文件、夹具和编译期反例 | 不能将所有 TS 文件都当作运行测试 |
| 测试发现 | run-tests.mts 与 test-layers.test.mts 当前扫描顶层 | 两处需要保持一致地支持递归 |
| 测试编译 | tsconfig.test.json 已递归包含测试 | 无需放宽严格性或新建编译配置 |
| 构建扫描 | build-core.mts 已递归扫描输入与输出 | 主要补运行发现和路径验证 |
| 生命周期 | 已有多处取消、超时、进程退出和重启测试 | 先确认现有覆盖，再补组合故障 |
| 检查入口 | 现有构建引导器尚不接受 hygiene 命令 | 新入口必须处理 TS 脚本的真实启动方式 |

主要源码依据：

- [当前架构说明](/Users/chriss/Desktop/办公智能体/neuma-requirements/ARCHITECTURE.md)
- [开发约定](/Users/chriss/Desktop/办公智能体/neuma-requirements/AGENTS.md)
- [构建核心](/Users/chriss/Desktop/办公智能体/neuma-requirements/scripts/build-core.mts)
- [构建引导器](/Users/chriss/Desktop/办公智能体/neuma-requirements/scripts/build.mjs)
- [测试运行器](/Users/chriss/Desktop/办公智能体/neuma-requirements/scripts/run-tests.mts)
- [测试分层回归](/Users/chriss/Desktop/办公智能体/neuma-requirements/test/test-layers.test.mts)
- [测试编译配置](/Users/chriss/Desktop/办公智能体/neuma-requirements/tsconfig.test.json)
- [Mac 检查工作流](/Users/chriss/Desktop/办公智能体/neuma-requirements/.github/workflows/typescript-check.yml)

文件数量和行数只作为本次盘点记录，不设置为长期质量指标。

## 3. R1：整理当前架构、开发约定和历史记录

### 3.1 目标

开发者应能从架构总览直接理解当前运行方式，并找到负责某个行为的模块。根开发约定只保留每次开发都需要知道的规则，历史实施过程放在独立记录中。

### 3.2 预期结构

| 资料 | 负责的内容 | 整理方式 |
|---|---|---|
| 根 README | 产品用途、使用方式、源码开发入口、常用命令 | 保持简洁，链接深入说明 |
| 根 AGENTS | 日常开发规则、必须先读的入口、验证要求 | 删除重复过程叙述，保留现行约束 |
| 根 ARCHITECTURE | 当前职责、调用关系、状态归属和关键约束 | 改为按主题组织的总览 |
| 领域说明 | 某个领域的接口、状态和维护注意点 | 有需要时按领域建立，避免空壳说明 |
| 历史记录 | 旧方案、替代关系、迁移过程、验证记录 | 明确是历史，不作为现行规范入口 |

领域说明及新增历史记录的具体文件名在实施时按内容确定，不预先生成一批空文档。已经存在的 TypeScript 结果记录继续承载迁移证据，根文档使用链接。

### 3.3 操作步骤

1. 建立内容清单，将现有段落归为当前规则、历史记录、重复说明、待核实。
2. 对当前规则记录实现位置和相关测试，优先核对版本恢复、授权、预算、激活和隔离等容易受旧说明影响的内容。
3. 按主题重写总览，建议包括系统入口、需求、架构、研发、运行、数据、交互、构建与验证。
4. 将历史过程移到明确标识的记录中；同一事实只在一个维护位置完整解释。
5. 在 AGENTS 中保留站得住的现行规则与阅读入口，在 README 中保留使用和开发入口。
6. 核对本轮移动内容的链接及来源，避免历史细节无意变成新的产品限制。

### 3.4 约束

- 不通过文字整理修改真实业务行为。
- 不为压缩篇幅删除仍然有效的兼容或失败处理约定。
- 历史归档保留必要的适用版本和替代关系。
- 不把未知状态的旧开发文档提升为当前权威，也不借本轮判断其过时。
- 不设置机械行数上限；篇幅是否合适取决于内容归属和查找成本。

### 3.5 验收

- 读者能找到每个主要模块的职责、入口、状态所有者和验证入口。
- 当前说明不再要求读者按日期拼接多条互相覆盖的规则。
- 整理前的有效约束都有对应去向；历史说明有清楚标识。
- 本轮明确维护的链接有效。
- 业务源码、数据和实际运行结果不因本批文档整理而改变。

## 4. R3：整理模块职责和依赖

### 4.1 目标与原则

保持现有单包和领域目录，优先提取职责完整、依赖明确、状态较少的功能。减少大型控制器承担的辅助工作，同时保留清晰的调用路径。

每次提取前记录：函数集合、直接调用方、闭包状态、导出项、错误种类、权限判断和覆盖测试。具有同一工作根或冻结上下文的一组函数优先整体移动。

不采用把整个控制器传给辅助函数、helper.call(this)、mixin 或巨型 Context 参数来降低行数。新的接口只描述真实消费者需要的方法。

### 4.2 第一批：Agent 工作目录能力

现有位置：

- [Agent 控制器](/Users/chriss/Desktop/办公智能体/neuma-requirements/src/agents/agent-prototype.mts)
- [Agent 行为测试](/Users/chriss/Desktop/办公智能体/neuma-requirements/test/agent-prototype.test.mts)
- [UTF-8 与 NUL 边界测试](/Users/chriss/Desktop/办公智能体/neuma-requirements/test/workspace-utf8-nul.test.mts)

拟新增模块：src/agents/agent-workspace.mts。此路径仅为建议命名。

提取候选为目录检查、路径约束、有界字节读取、脱敏文本读取及文件工具构造。控制器继续决定哪个 Agent 可以访问哪个工作目录，以及本次装配哪些工具。

保持工作根、检查器和读写保护的关联，避免拆散 workspaceTarget 等闭包后遗漏默认保护。

验收重点：

- 路径穿越、符号链接和不允许的目标仍拒绝。
- 原有字节、字符、分页和内容处理规则保持。
- 工具名称、schema、返回值和错误分类保持。
- 文件、预览和下载继续采用原权限判断。
- 真实调用与现有故障替身都能使用同一能力接口。

### 4.3 第二批：架构输入上下文与诊断

现有位置：

- [架构控制器](/Users/chriss/Desktop/办公智能体/neuma-requirements/src/architecture/architecture.mts)
- [模型上下文模块](/Users/chriss/Desktop/办公智能体/neuma-requirements/src/architecture/architecture-model-context.mts)
- [工具诊断模块](/Users/chriss/Desktop/办公智能体/neuma-requirements/src/architecture/architecture-tool-diagnostics.mts)

拟新增模块：src/architecture/architecture-input-context.mts。先明确它负责输入材料构造，现有 model-context 负责模型投递与按需读取，避免产生两个重复模块。

将 architectureVerificationContext、architectureConfirmedContext 及直接相关的纯辅助函数集中管理。错误规范化优先归到已有诊断模块；确有独立职责再增加文件。

首次提取保留原有公开导出的转导出，减少消费者同时改动。转导出不能引入反向运行时依赖。

验收重点是输入字段、来源引用、哈希材料和错误内容不变，并通过已有 confirmed-context、deferred-verification、tool-diagnostics 等相关测试。

### 4.4 第三批：架构恢复来源选择

拟新增模块：src/architecture/architecture-revision-source.mts。

将版本绑定核对、各类修订或评审来源选择等关系紧密的函数集中管理。先整体提取，再依据真实消费者判断是否需要细分。

本批不拆保存队列，不移动 records 的所有权，不改变 prepareRestart、save、remove 的提交顺序。

验收重点：

- 来源版本、候选和授权绑定仍被核对。
- 重启、恢复和提取代码都不能重置预算或重新签发授权。
- 原始候选和历史记录不被改写。
- 已有恢复、修订和研发引用续接测试继续通过。

### 4.5 第四批：缩小真实消费者端口

现有 [prototype-port.mts](/Users/chriss/Desktop/办公智能体/neuma-requirements/src/agents/prototype-port.mts) 和构造器注入已经提供基础，不另建容器。

先选择一个依赖方向，将具体控制器类型缩为实际调用的方法集合。默认生产实现和实例创建位置保持原状。

验收要求包括最小替身可通过类型检查，以及真实实现的集成测试通过。不能仅为方便测试而降低接口精度，也不为尚不存在的第二种实现增加扩展机制。

### 4.6 初期保留的状态所有者

| 状态或流程 | 初期保持 |
|---|---|
| 架构 records 与 persistence 串行链 | 继续由 ArchitectureDesigner 实例持有 |
| 会话 map、取消标志、运行代次 | 继续由 PrototypeAgents 实例持有 |
| 激活、回滚和数据迁移 | 生命周期保护充分前不拆 |
| stagedDesign 与 design 主编排 | 复用已有管线与评审辅助模块，不再叠一套通用 manager |
| 关闭 Promise 与资源释放顺序 | 先完成 R6 的故障验证，再决定调整 |

### 4.7 每批完成条件

严格类型检查、受影响测试和全量回归通过；对外接口、模型输入、状态发布、持久格式和错误语义保持。若需要修复行为，另开批次，先建立可失败的回归测试。

## 5. R4：按领域整理测试

### 5.1 目标目录

下面是拟议布局，实施时可按现有职责微调，不代表所有文件必须移动：

~~~text
test/
  requirements/
  architecture/
  development/
  agents/
  collaboration/
  services/
  runtime/
  projects/
  installation/
  applications/
  ui/
  build/
  helpers/
  fixtures/
  types/
  <需要保留入口路径的少量顶层测试>
~~~

领域是测试的组织方式，unit、integration、browser 仍描述执行性质。界面测试若明显属于某个业务领域，优先随领域放置；ui 只放共享界面基础测试。

### 5.2 先改发现机制

需要同步修改 [run-tests.mts](/Users/chriss/Desktop/办公智能体/neuma-requirements/scripts/run-tests.mts) 与 [test-layers.test.mts](/Users/chriss/Desktop/办公智能体/neuma-requirements/test/test-layers.test.mts)。

1. 递归发现 .test.mts 源文件或对应 .test.mjs 产物。
2. 标识使用相对于 test 根的完整路径，避免不同目录的同名文件冲突。
3. 发现、分类、--list 和实际启动共用相同集合。
4. all 继续显式传入全部运行测试文件，不改成裸 node --test 自动搜索。
5. 保留当前串行运行设置，不在整理中顺带改变并发。
6. 为嵌套目录、同名文件、非测试文件排除和空集合增加回归用例。

已有 tsconfig.test.json 和构建递归扫描可以继续使用，不增加 allowJs，不放宽严格性。

### 5.3 明确排除运行的文件

helpers、fixtures 和类型反例必须继续被编译或复制到所需位置，但不能被当作测试入口执行。

以下三个现有文件仅作为编译期反例使用：

- [m4-architecture.mts](/Users/chriss/Desktop/办公智能体/neuma-requirements/test/types/m4-architecture.mts)
- [m5-runtime.mts](/Users/chriss/Desktop/办公智能体/neuma-requirements/test/types/m5-runtime.mts)
- [migration-contracts.mts](/Users/chriss/Desktop/办公智能体/neuma-requirements/test/types/migration-contracts.mts)

有意的 ts-expect-error 必须继续由严格类型检查验证，不能改成忽略整份文件或排除编译。

### 5.4 保持分类语义

- unit、integration 默认移除外部浏览器环境变量。
- browser 保留显式启用和用户指定程序的机制。
- agent-build-view 当前包含普通状态检查和真实浏览器检查，先保留 integration/browser 双重登记。
- group-layout 当前经未分类测试的 integration 兜底发现，纯移动批次不重新判断其分类。
- 新文件未登记进入 integration 的运行兜底继续保留；完成全量登记后，R5 可在源码检查阶段报告遗漏。
- 若需拆开混合测试或调整分类，单独提交，不能混入纯移动。

### 5.5 原生工作流固定路径例外

现有 [native-check.yml](/Users/chriss/Desktop/办公智能体/neuma-requirements/.github/workflows/native-check.yml) 固定引用以下四个测试的编译产物：

- [development-executor.test.mts](/Users/chriss/Desktop/办公智能体/neuma-requirements/test/development-executor.test.mts)
- [isolation-native.test.mts](/Users/chriss/Desktop/办公智能体/neuma-requirements/test/isolation-native.test.mts)
- [project-platform.test.mts](/Users/chriss/Desktop/办公智能体/neuma-requirements/test/project-platform.test.mts)
- [project-runtime.test.mts](/Users/chriss/Desktop/办公智能体/neuma-requirements/test/project-runtime.test.mts)

本轮先保留它们的顶层路径，并在目录说明或分类中注明原因。不改原生工作流，不创建会重复注册测试的包装入口，不把保留路径当作该工作流已经通过的证明。

### 5.6 每批移动流程

1. 保存移动前的 all 与分层文件集合，建立旧路径到新路径的对应表。
2. 选择一个领域或一个小子集；首批建议选不含上述固定入口的运行时测试。
3. 初期保持共享 helpers、fixtures、types 位置，减少同时变化的路径。
4. 修正相对 import、动态 import、new URL、fileURLToPath、子进程入口、复制来源和硬编码路径。
5. 重新构建，对比发现集合、分类和跳过原因，再运行该批受影响测试。
6. 完成全量回归后提交本批。断言调整和测试新增另立提交。

### 5.7 验收

- 原有测试通过映射后全部可发现，未漏测、未重复运行。
- 辅助文件、夹具和编译期反例不进入运行集合。
- 移动批次的原有断言、默认 skip 条件、浏览器策略和执行并发保持。
- 集合对比以实施时基线为准；新增测试单独记录，不能永久硬编码 250。
- 固定工作流引用保持有效，现有构建覆盖不放宽。

## 6. R5：关键仓库规范的自动检查

### 6.1 目标

增加少量能直接防止维护错误的检查，复用现有编译和产物检查，不复制参考仓库的全部工具体系。

拟新增用户入口为 npm run check:hygiene。该命令目前不存在，必须在实现和验证后才能作为实际命令使用。

### 6.2 先解决启动方式

现有 [tsconfig.bootstrap.json](/Users/chriss/Desktop/办公智能体/neuma-requirements/tsconfig.bootstrap.json) 只声明 build-core.mts，引导器又会在加载核心后移除临时目录。

因此不能只在 package.json 中加入一个源码树并不存在的 .mjs 脚本，也不能让临时模块删除后再执行相对动态导入。

建议复用现有薄引导器，增加独立的源码检查分支：

1. 在不生成产品运行目录的情况下，临时严格编译检查入口及其必要依赖。
2. 检查程序显式接收源码根，不能根据临时目录或 dist 路径猜测根目录。
3. 检查入口执行完毕后再清理临时文件。
4. 引导阶段只依赖 Node 标准库及已有 TypeScript 开发依赖，不引入领域控制器或 Pi SDK。
5. 从没有 dist 的源码树运行也能成功。
6. 不添加新的自有 JS 源码引导器，不让用户安装包依赖 TypeScript。

具体检查入口和配置文件在实施时确定，属于拟新增开发工具，不属于产品能力。

### 6.3 首期检查清单

| 检查 | 执行内容 | 错误输出 | 例外处理 |
|---|---|---|---|
| 模块依赖 | 检查明确禁止的运行时或类型依赖，区分组装入口 | 来源文件、目标、导入位置和规则 | 精确到来源与目标，附理由 |
| 测试登记 | 检查遗漏分类、失效路径、非预期重复 | 文件路径、所属层、遗漏或冲突 | 保留已解释的混合文件例外 |
| 文档引用 | 只检查本轮明确维护文档中的可校验引用 | 文档、链接位置、缺失目标 | 不以旧本地资料入库状态为前提 |
| 明确残留 | 复用或补充检查源码树中的误生成文件 | 具体文件与允许位置 | 不扫描用户业务目录或自动删除 |

发布包夹带源码、用户配置、资源遗漏和陈旧产物已由现有构建与包验证覆盖。首期复用这些检查，不再实现第二套同类规则。

### 6.4 依赖图实现要求

- 使用 TypeScript AST 读取静态 import、export-from 和可识别的动态 import，使用对应配置解析路径。
- 正确处理 .mts 导入 .mjs、浏览器 .ts 导入 .js 和 CLI .cts。
- 分开记录类型依赖与运行时依赖，不能将纯类型环直接作为运行时初始化环。
- 非字面量动态导入需要报告其存在和处理方式，不能静默遗漏。
- 检查只解析源码，不加载或执行应用模块。
- 首次建立实际依赖图后再定义规则，不无依据地要求全部领域立即构成无环图。
- 例外记录至少包含来源、目标、依赖类别和理由；已经不存在的例外也应提示清理。
- 保留现有第三方声明的有限例外，不扩大 skipLibCheck 或关闭自有声明检查。

### 6.5 测试登记的渐进启用

先保留运行器的 integration 兜底；建立完整登记时，将现有未分类文件显式登记为原来的 integration，不借此改变执行性质。

完成清单基线后，源码 hygiene 可以拒绝新遗漏，而运行器仍保留防漏测兜底。两者分别负责“提醒维护者补分类”和“保证直接运行时不静默漏测”。

### 6.6 CI 与安装包

- 接入现有 Mac TypeScript 检查工作流，不调用要求三平台完整证据的 release 检查。
- 源码检查可以先运行；静态资源、发射入口、tarball 内容继续在构建后验证。
- 编译测试暂存目录允许有开发检查工具，不表示实际 npm 包应包含它们。
- 不扩大发布白名单，不把 TypeScript 移入生产依赖，不要求安装用户执行 hygiene。
- 本轮不引入必须安装的 Git hooks；日常命令和 CI 先保持一致。

### 6.7 验收

每类规则至少有一个真实违规样例，确认修改后会失败并提供明确位置；正常样例通过。从无 dist 的源码环境可运行，切换工作目录不会检查错根。检查只读，不启动后台或模型，不修改源码。

## 7. R6：生命周期与资源清理验证

### 7.1 现有覆盖

以下用例已经存在。本方案没有重新运行它们，也不将它们重复列为待建设功能。

| 已有测试 | 已覆盖的主题 |
|---|---|
| [session-shutdown](/Users/chriss/Desktop/办公智能体/neuma-requirements/test/session-shutdown.test.mts) | 多个异步等待位置取消、迟到会话隔离、活动会话中止 |
| [agent-scheduler](/Users/chriss/Desktop/办公智能体/neuma-requirements/test/agent-scheduler.test.mts) | 同 Agent 串行、取消后槽位释放、关闭排队项与复用 |
| [materials-runner](/Users/chriss/Desktop/办公智能体/neuma-requirements/test/materials-runner.test.mts) | 材料子进程池、取消、超时、关闭后恢复 |
| [managed-services](/Users/chriss/Desktop/办公智能体/neuma-requirements/test/managed-services.test.mts) | worker 中止、重启、scratch 监督、服务恢复 |
| [development-executor](/Users/chriss/Desktop/办公智能体/neuma-requirements/test/development-executor.test.mts) | 研发执行取消及进程组终止 |
| [service-gateway](/Users/chriss/Desktop/办公智能体/neuma-requirements/test/service-gateway.test.mts) | MCP 取消、临时关闭与永久关闭、授权撤销后的迟到读取 |

### 7.2 先建立资源归属表

对 Agent、材料进程、托管服务和网关分别记录：

- 哪个实例拥有该资源。
- 谁创建、取消、等待、释放和发布终结状态。
- 关闭是否允许复用；临时关闭和永久关闭是否不同。
- 清理发生错误时，哪些独立资源仍必须继续清理。
- 哪些已完成副作用需要保留，哪些临时状态应移除。

资源归属表直接服务于待补测试，不扩展为全局资源管理框架。

### 7.3 待核验矩阵

| 场景 | 触发方式 | 需要观察的结果 |
|---|---|---|
| 清理中途失败 | 注入一个 close 或 dispose 的异常 | 其他独立资源继续清理，失败可见，没有无人处理的 rejection |
| 并发关闭 | 运行中同时调用两次 close | 不提前报告结束，不重复执行破坏性清理 |
| 关闭后再次关闭 | 已完成或曾失败后再次调用 | 遵守所属组件现有复用与重试语义 |
| 迟到能力回调 | 旧请求在取消或关闭后才完成 | 不向旧 worker 回写，不修改新任务，不发布旧任务成功 |
| 活动与排队交错 | 一个任务结束前取消或关闭排队项 | 槽位与终结状态一致，不启动已取消工作 |
| Mac 实际资源退出 | 使用临时服务、进程和目录 | 后代进程退出，端口释放，scratch 清理，用户输入及已保存产物保留 |

这些是审计候选，不表示每项都缺少测试。实施时先查覆盖，只有缺口才新增。

### 7.4 优先审计点

[PrototypeAgents.close](/Users/chriss/Desktop/办公智能体/neuma-requirements/src/agents/agent-prototype.mts:1826) 组合了会话、应用、网关、服务、材料、研发和持久化等待，其中部分步骤采用顺序 await。

优先通过故障注入验证某个步骤拒绝后，其他需要清理的资源能否完成收尾。阅读源码不足以直接判定存在缺陷，更不能预先写成“已修复”。

同时核验关闭 Promise、runtimeEpoch、取消信号与迟到完成之间的关系。允许恢复的组件不能被统一改成永久关闭，永久关闭的组件也不能意外恢复。

### 7.5 测试方法

- 使用 deferred 或 barrier 明确控制“进入等待、发出取消、允许完成”的顺序。
- 固定睡眠仅用于必要的真实进程时限验证，不用于制造不确定竞态。
- 使用 t.after 等现有机制兜底释放测试资源，失败路径也执行。
- 有意义的断言检查实际状态、资源或输出，不能只检查内部方法调用次数。
- 真实模型与外网调用继续用已有可控边界替身代替。
- 发现真实缺陷时先建立失败用例，再做最小修复；修复与控制器提取分开提交。

### 7.6 验收

相关新场景可稳定复现并验证；取消和关闭不会让旧任务污染新任务；清理失败可见；测试结束没有本批创建的遗留进程、监听端口或临时目录。已有用户产物和已完成副作用不被错误回滚。

## 8. 实施顺序与提交批次

执行顺序需要兼顾依赖，五项方案不按编号一次性完成。

| 批次 | 内容 | 前置条件 | 独立完成条件 |
|---|---|---|---|
| B0 | 记录工作区、测试集合和现有检查基线 | 实施开始 | 基线完整，区分旧失败与新变化 |
| B1 | R1 当前文档与历史内容归位 | B0 | 当前说明可查，业务源码不变 |
| B2 | R5 源码检查启动入口与依赖盘点 | B0 | 无 dist 可运行，规则有失败样例 |
| B3 | R6 覆盖审计及必要回归测试 | B0 | 已有覆盖明确，关键故障可验证 |
| B3-fix | R6 发现的真实缺陷修复，按问题拆分 | 对应失败用例 | 最小修复通过，单独记录行为影响 |
| B4 | R4 递归发现与集合对比 | B2 的基础检查可用 | 顶层行为保持，嵌套测试被正确发现 |
| B5 | R4 小领域试迁，再逐领域迁移 | B4 | 每批集合对应、断言与分类保持 |
| B6 | R3 工作目录能力、架构输入提取 | 相关测试保护就绪 | 每组职责分别验证与提交 |
| B7 | R3 恢复来源选择、消费者端口 | B3 及相关恢复回归通过 | 状态所有者不变，依赖方向明确 |
| B8 | 补齐 R5 清单检查、更新维护入口 | B5 至 B7 的相应部分完成 | 无过期例外、无静默遗漏 |
| B9 | 总体验收与最终记录 | 必需批次完成 | 全量回归、相关 Mac 包验证和文档一致 |

实施原则：

1. 每个逻辑独立的变化单独提交；一次大领域迁移可以再拆小批。
2. 文件移动、测试新增、业务修复和模块提取尽量分开。
3. 提交前审阅差异，不能把已有用户改动或本地数据混入本批。
4. 保留已有提交，不重写已有历史。实施时按现有约定完成提交前回归。
5. 提交和推送分别记录；完成本地批次不自动等同于已经推送或发布。
6. 本地 docs 文档库沿用现有安排；本方案不新增跨仓库同步或提交规则。

## 9. 验证命令与证据

### 9.1 当前已有命令

以下命令在项目根执行。它们是后续实施建议，本次编写文档没有运行这些构建与测试。

最快的类型检查：

~~~sh
npm run typecheck
~~~

一次构建后核对实际运行集合：

~~~sh
npm run build
node dist/ts-build/package/scripts/run-tests.mjs all --list
node dist/ts-build/package/scripts/run-tests.mjs unit --list
node dist/ts-build/package/scripts/run-tests.mjs integration --list
node dist/ts-build/package/scripts/run-tests.mjs browser --list
~~~

按层运行与全量回归：

~~~sh
npm run test:unit
npm run test:integration
npm test
~~~

单个受影响测试可在有效构建后，通过 node --test --test-concurrency=1 加实际编译文件路径运行。移动前后路径以当批映射表为准，不照抄已经失效的旧路径。

涉及包内容、入口或安装行为时运行 Mac 验证：

~~~sh
npm run release:preview:check
npm run package:pack
npm run test:package:smoke
npm run test:package:install
~~~

上述现有 npm 包命令各自可能执行构建，逐条运行不等于证明使用同一编译代次。需要同代次验收时，应沿用现有 Mac CI 在一次构建后调用编译后的检查及 package-artifact 逻辑，并记录实际产物摘要。

仅当修改确实涉及浏览器行为并需要外部浏览器验收时运行：

~~~sh
npm run test:browser
~~~

页面检查仍优先使用 Codex 内置浏览器；外部浏览器保留现有显式选择机制与 Dia 默认约定，不增加自动回退。跳过、未运行或浏览器启动失败不能记作通过。

### 9.2 拟新增命令

~~~sh
npm run check:hygiene
~~~

此入口必须完成 R5 实现、负例验证和 CI 接入后才可执行。文档、源码检查和产物检查各自说明输入，不能只用一个“全部通过”掩盖未执行部分。

### 9.3 每批保留的证据

- 源码提交和本批修改范围。
- 测试移动的旧路径到新路径映射。
- all 与分层集合，说明有意的交集和固定入口例外。
- 类型检查、受影响测试、全量回归的实际结果。
- 通过、失败、跳过和取消的数量及必要原因。
- 涉及包验证时的构建代次、tarball 摘要和实际平台。
- 新增规则对应的正常与违规样例结果。
- 尚未核实的项目，不能记为已完成。

不提交包含凭据、真实业务正文或本机运行数据的日志。证据只保留评审所需信息。

## 10. 风险与回退

| 变化 | 主要风险 | 控制方式 |
|---|---|---|
| 文档归位 | 丢失有效约束或错误认定旧规则 | 内容去向清单、实现和测试交叉核对 |
| 辅助模块提取 | 丢失闭包状态、权限默认值或初始化顺序 | 关系紧密函数整体移动，保留原状态所有者 |
| 恢复逻辑提取 | 改变来源、哈希、预算或授权绑定 | 原材料对比、现有恢复测试、单独提交 |
| 测试搬迁 | 漏测、重复、夹具和 CI 路径失效 | 先递归发现，再逐批移动和集合映射 |
| hygiene | 误报、依赖旧产物、引入检查框架负担 | 少量明确规则、精确例外、无 dist 验证 |
| 关闭流程修复 | 提前释放资源、吞错、错误永久关闭 | 故障注入、确定时序、保留组件语义 |

回退以单个逻辑提交为单位，按依赖逆序撤回需要回退的代码。遇到冲突只处理相关差异，不使用全局 reset 或清理忽略文件来恢复工作区。

本轮不计划数据迁移，回退代码也不删除已有数据、会话、检查点、累计用量或已完成产物。无法以这种方式保持行为的变化应拆为新的独立方案。

## 11. 总体完成条件

- [ ] R1 当前说明与历史记录归属明确，重要现行约束都有去向。
- [ ] R3 选定职责已提取，实际消费者依赖缩小，状态所有者清楚。
- [ ] R4 测试按领域可定位，发现与运行集合完整，固定入口例外保留。
- [ ] R5 关键规范有实际检查入口、违规样例与 Mac CI 接入。
- [ ] R6 现有覆盖与补充覆盖有据可查，必要故障修复单独提交。
- [ ] 严格编译、受影响测试和全量回归通过；原有跳过项没有被冒充通过。
- [ ] 涉及安装包的变化完成相关 Mac ARM64 验证。
- [ ] 无新增业务权限、模型调用、预算变化或历史数据重写。
- [ ] 每批修改可以独立审阅，提交与实际验证结果一致。
- [ ] 排除的第 2 项及 Linux/Windows 打包不被作为本轮完成前提。

## 12. 本文交付状态

本文已经整理为可评审的实施方案。它不表示 R1、R3、R4、R5、R6 已经实施，也不表示其中的构建、测试、故障注入或包验证已经执行。实际实施结果应在完成各批后另行记录。
