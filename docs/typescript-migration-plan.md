# NEUMA TypeScript 全项目迁移方案

日期：2026-10-24。状态：M0–M8 已实施并完成本次范围内验收；Mac ARM64 包及三组支持 Node 版本实测通过。预算旧断言的基线修正单独提交。实际范围及证据见 `docs/typescript-m0-m1-results.md`、`docs/typescript-m2-m3-results.md`、`docs/typescript-m4-m5-results.md` 和 `docs/typescript-m6-m8-results.md`。

本方案依据当前工作区、`AGENTS.md`、`ARCHITECTURE.md` 最新约定及现有安装发布实现制定。当前工作区含未提交的架构、研发、模型上下文及测试改动，实施基线包含这些成果，不能直接从较旧的 HEAD 开始并遗漏它们。初版只制定方案；后续经用户授权推进 M0–M8，已安装锁定工具链、运行产物回归和独立临时安装，未调用用户真实模型或重跑业务任务。用户后续明确授权全部已有改动与迁移成果按逻辑批次提交，替代初版“不自动提交”的默认约定。

## 1. 已确定的技术路线

1. 将项目自行维护的后端、前端、测试及维护脚本逐批迁移为 TypeScript，保持现有模块职责和运行行为。
2. 后端、Node 测试和维护脚本采用 `.mts`，编译成现有 `.mjs`；浏览器源码采用 `.ts`，编译成现有 `.js`。`.mts` 是 TypeScript 的 ESM 源文件扩展名。
3. CLI 源码最终采用 `bin/neuma.cts`，产物仍为 `bin/neuma.cjs`。保留其最低 Node 版本检查及延迟加载逻辑。
4. 使用 TypeScript 编译器，保留 Node ESM 与原生浏览器模块，不在此项目中增加 bundler 或更换界面、Agent 框架。
5. 构建产物位于 `dist/ts-build/package/`，目录层级与现在的安装包一致；正式 npm 压缩包输出到 `dist/npm/`。
6. 开发和测试都运行同一套编译产物。消费者收到 JavaScript，安装时不运行 TypeScript 编译，也不要求安装开发依赖。
7. 过渡期允许 JS/TS 共存，已迁移代码必须通过严格类型检查；最终移除业务代码和测试的 JS 兼容入口。
8. 类型化期间维持现有 API、数据格式、哈希计算、原生会话绑定、预算、沙箱和独立评审规则。

“全项目迁移完成”指自有业务实现、测试及维护脚本的 TypeScript 化。C/C++ 原生辅助程序、Python worker、构建配置、HTML/CSS、第三方资源和模型生成的用户程序继续使用各自的格式。允许保留一个薄的 `scripts/build.mjs` 引导器来启动本地编译器；它只负责构建调度，不承载业务或数据迁移。

## 2. 现状与成本来源

静态统计基线：

| 范围 | 当前规模 | 迁移影响 |
| --- | --- | --- |
| 后端 | 157 个 `.mjs`，约 34,543 行；另有 81 行 Python worker | 状态、契约、存储、SDK 与进程边界是重点 |
| 前端 | 45 个 `.js`，约 10,416 行 | 14 个原生 ESM 页面入口，另有普通脚本 bridge |
| 测试 | 244 个顶层测试文件；含辅助代码约 65,906 行 | 部分直接导入前端，部分拼接源码后通过 VM 执行 |
| 构建与维护 | 5 个 scripts 模块、1 个 CLI、手动原生 CI | 当前没有 TS 编译或类型检查门槛 |
| 原生代码 | 4 个 C/C++ 文件，约 1,397 行 | 保留源码和平台验证职责 |

行数包含空行、注释、提示词和测试材料，不作为单纯按行计价的依据。现有测试数量不代表所有行为已被覆盖。

主要现存约束：

- `src/server.mjs` 从自身位置计算包根，并由此定位静态资源、默认数据和部分 Agent 的 cwd。
- `src/app-metadata.mjs` 从相邻包根读取 `package.json`。
- CLI、材料解析、MCP bridge、服务 worker、Docker 入口及原生辅助程序都有实际的相对路径约定。
- `test/agents-ui.test.mjs` 等会读取 JS 文本，删除 import/export 后交给 VM；不能改为直接执行 TS 文本。
- `public/application-frame-bridge.js` 由普通 `<script src>` 注入，不能编译成含 import/export 的模块。
- `.gitignore` 当前忽略开发 Markdown，只发布根 README；此方案沿用本地开发文档规则。

## 3. 迁移边界与兼容承诺

本次实施包含类型定义、源码扩展名、编译入口、测试加载方式、安装包组装和 CI 改造。为迁移所需的局部参数显式化可以单独提交，必须有相应回归。

以下内容保持实际语义：

- 需求澄清、架构设计、独立评审、研发、验收、交付和用户执行的职责分工。
- 稳定 Agent ID、独立会话、材料归属、文件权限、已激活版本和更新候选的分离。
- 新旧检查点各自的版本、摘要、已用轮次、原生会话、授权与恢复条件。
- API 路径、JSON 字段、浏览器模块 URL、NDJSON 消息以及 iframe 通信协议。
- 真实失败、取消和中断；重启不自动重放外部操作。
- 现有文件配额、Unicode 计数单位、输入诊断、幂等和原子保存行为。
- 当前 Mac ARM64 preview 发布范围；其他平台的构建或测试不冒充完整安装认证。

用户程序仍按现有 `.mjs`／`.js`、node-action、node-json、managed-service 等协议运行。宿主使用 TS 不要求模型生成 TS，也不为用户程序增加编译器或网络权限。

## 4. 源码和运行产物布局

以下标为“拟新增”的名称属于实施设计，目前尚不存在。

```text
仓库根/
├── src/**/*.mts                   后端 TypeScript，逐文件替换 .mjs
├── src/contracts/*.d.mts          拟新增：共享纯类型声明，不发射运行代码
├── src/services/python-service-worker.py
├── public/*.ts                    前端 TypeScript，逐文件替换 .js
├── public/index.html、style.css、assets/
├── test/**/*.mts                  测试与辅助程序，后期迁移
├── test/fixtures/                 保留原始材料与用户程序夹具
├── scripts/*.mts                  已迁移的维护脚本
├── scripts/build.mjs              拟新增：薄构建引导器
├── scripts/start-source.mts       拟新增：源码开发启动器
├── bin/neuma.cts
├── tsconfig.*.json                拟新增：按运行环境分开的配置
└── dist/
    ├── ts-build/package/
    │   ├── package.json、package-lock.json、npm-shrinkwrap.json
    │   ├── bin/neuma.cjs
    │   ├── src/**/*.mjs
    │   ├── src/services/python-service-worker.py
    │   ├── public/**/*.js、HTML、CSS、assets/
    │   ├── scripts/**/*.mjs
    │   ├── test/                  仅供构建产物测试，不进入 tgz
    │   └── native/                供原生测试使用，发布仍服从渠道白名单
    └── npm/*.tgz
```

保留 import 中的运行时扩展名：后端继续写 `../x.mjs`，前端继续写 `./x.js`，由 TypeScript 对应到 `.mts`／`.ts` 源文件。不引入路径别名，也不在正式产物中依赖 TS loader。

同一逻辑模块不能同时保留手工维护的 `.mjs` 和 `.mts`，也不能同时保留 `.js` 和 `.ts`。重命名后，JavaScript 只由编译生成；混合期尚未迁移的文件照常发射到产物目录。

### 4.1 区分三种根目录

| 根目录 | 用途 | 约束 |
| --- | --- | --- |
| 源码仓库根 | 开发时 `.neuma/`、`.env`、原有 Agent cwd | 不随输出目录改变 |
| 产物包根 | HTML、字体、worker、辅助程序、版本清单 | 相对层级保持原包布局 |
| 用户数据根 | 安装版默认主目录 `.neuma/` 或显式 `--data-dir` | 程序更新和构建不改动 |

已有 `runSourceApplication({ root, createHandler })`，开发启动器复用此接口，并把 `root` 显式设为源码仓库根。启动应用进程时保留原 `--env-file` 的环境加载行为；评估与构建过程不读取或打印凭据，也不将 `.env` 复制进产物。

`createRequestHandler` 当前内部传 `cwd: ROOT` 给 PiProjectAgent 和 PrototypeAgents。实施时拟新增可选参数 `cwd = ROOT`，开发启动器传入源码仓库根，安装版保留默认包根。通过包装 handler 传参，不发明当前不存在的 `NEUMA_DATA_DIR` 等环境变量。

### 4.2 独立运行入口

以下产物必须逐个验证，不仅检查 server 可以启动：

- `bin/neuma.cjs` → `src/installation/installation-cli.mjs`。
- `src/materials/material-parser-child.mjs`。
- `src/services/node-service-worker.mjs` 与 Python worker。
- `src/services/mcp-bridge.mjs`，包括向外提供的启动参数。
- 原生 isolation 和 projects 辅助程序的定位与执行权限。
- `public/application-frame-bridge.js` 的普通脚本加载。

Node service worker 当前只依赖 Node 内置模块，Docker 只复制该单文件。类型迁移后继续维持单文件运行属性，公共类型使用 `import type`，不得悄悄增加未复制的运行时依赖。

## 5. 编译器、配置与类型检查

只增加开发期编译依赖。M1 已安装、验证并精确锁定 TypeScript `7.0.2`，引擎要求 `>=16.20.0`，不使用浮动 latest。`@types/node` 先选与最低支持 Node 22 对应的精确版本，避免类型环境放行仅在更新 Node 才有的 API。编译成功不能替代最低 Node 的实际运行验证。

Pi、MCP、marked、KaTeX 当前锁定版本自带类型；先使用已有类型。只有实际缺失时才新增相应 `@types`，不凭习惯添加重复声明。

### 5.1 配置分工

拟新增配置：

| 文件 | 用途 | 核心约束 |
| --- | --- | --- |
| `tsconfig.base.json` | 类型检查共同规则 | strict、verbatimModuleSyntax、forceConsistentCasingInFileNames |
| `tsconfig.contracts.json` | 自有共享纯类型声明 | 无 Node/DOM；noEmit，skipLibCheck false，声明也要检查 |
| `tsconfig.node.json` | 后端、Node 维护代码 | NodeNext，ES2022，lib ES2022，types node |
| `tsconfig.browser.json` | 原生 ESM 前端 | NodeNext 解析，ES2022，DOM/DOM.Iterable，types [] |
| `tsconfig.frame.json` | 普通脚本 bridge | module none、moduleDetection legacy、DOM/DOM.Iterable、types []；独立根文件集合 |
| `tsconfig.test.json` | Node 测试、假 DOM 及辅助程序 | Node 环境；按实际需要引入 DOM 类型，不能反向影响后端配置 |
| `tsconfig.emit.*.json` | 对应环境的产物发射 | rootDir 为仓库根，各环境独立临时 outDir；按路径所有权组装 |

Node 与浏览器配置禁止互相泄露 Node/DOM 全局。共享 DTO 必须能在无 Node 全局的环境中检查，浏览器只通过 `import type` 引入共享契约，不引入后端控制器、SDK、文件或凭据模块。

共享纯类型放在 `.d.mts`，避免多个编译项目重复发射空运行模块；对应使用 `import type ... from "../contracts/名称.mjs"`，编译后该引用被擦除。带有实际校验或常量的实现仍留在有明确运行归属的 `.mts` 模块中。共享声明单独关闭 skipLibCheck 检查，不能因使用声明文件而跳过自有类型验收。

普通脚本 bridge 的全局声明放入专属 `.d.ts`，类型引用不产生运行时 import。配置和检查须保证编译后的 bridge 没有 `import`、`export`、`require` 或 Node 全局依赖。

### 5.2 严格度策略

- 从第一批 TS 文件起启用 `strict`，不把关闭 strict 作为过关办法。
- 混合期 `allowJs: true`、`checkJs: false`；它们只容纳尚未迁移的文件。
- 完成迁移的纯叶子与共享契约率先启用 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`；各批按目录完成后扩大，收口时生产代码全部启用。
- 每一阶段记录尚未迁移的文件列表、临时类型适配器及负责人；它们是待办，不能计入已完成类型覆盖。
- 禁止以 `any`、`as unknown as T`、整文件 `@ts-nocheck`、宽泛的第三方模块声明掩盖业务错误。
- 罕见第三方声明缺陷允许在单个适配边界使用有解释、可删除的局部兼容声明。测试故意构造非法数据时，使用 `unknown` 和明确的负向入口；必要的 `@ts-expect-error` 必须有具体原因和可验证预期。
- M3 已遇到锁定 `pi-ai@1.0.0` 的 JSON import 属性及 `@google/genai@2.21.0` 的旧 MCP/DOM 声明问题，Node/test 暂以 `skipLibCheck` 跳过声明体，自有共享声明仍以独立配置严格检查；收口时关闭后验证，若确有上游缺陷则记录精确包版本和有限例外。

### 5.3 发射与类型检查分开

混合树可能包含尚未类型化的 JS 和旧测试，构建发射可以使用单独的 `noCheck` 配置保持可运行。该模式仅证明语法和发射过程成功。

`npm run typecheck` 必须使用 `noEmit: true`、`noCheck: false` 的严格配置，检查所有已迁移 TS 及其实际依赖闭包。不能通过缩窄 include、排除被 import 的问题模块或只检查一个空入口取得“通过”。

发布前必须同时满足严格类型检查、干净构建和行为测试。迁移收口后删除过渡 noCheck 发射方式，采用类型检查通过才生成正式产物的配置。不要把一次发射成功或较高文件改名比例称为类型安全完成。

## 6. 构建与打包流程

拟新增的 build 引导器通过本地已安装的 TypeScript 执行编译，不使用 `npx` 在线临时下载。

构建顺序：

1. 确认源码根、受控构建根和文件清单；拒绝输入输出冲突与同名 JS/TS 模块。
2. 严格检查已迁移的类型项目；普通开发可选只发射，但测试和打包必须检查。
3. 在 `dist/ts-build/` 内创建新的临时构建目录，后端、前端、bridge、测试各自发射到独立子目录，不能直接写共同的最终目录。
4. 按运行路径所有权组装：Node 项目提供 src/scripts/bin 和 `.github/scripts` 下的自有 Node 工具，浏览器项目提供 public 模块，frame 项目单独提供普通脚本 bridge，测试项目仅提供 test。测试编译器可能因 import 额外发射生产依赖，这些重复输出不采纳；每个实际采纳路径必须且只能有一个所有者。include/exclude 不能隔断 import 依赖闭包，不能据此声称没有重复发射。
5. 按清单复制 HTML、CSS、图片、Python worker、原生辅助程序和测试材料；保留所需权限，不复制链接、用户数据或凭据。
6. 生成产物 manifest 和内部 build 清单，校验所有入口及其相对资源；核对每个 TS 源文件的类型检查归属，以及每个运行入口的唯一产物归属。
7. 全部完成后发布这一构建代次；失败时返回非零，不允许测试或启动悄悄使用上一次成功产物。
8. 测试 runner 只接受刚完成的代次，不复用陈旧文件。CI 总从干净目录构建。

清理范围仅限专用 `dist/ts-build/`，不删除 `dist/` 下既有压缩包、验收证据或其他工作成果。构建清单保留源码/编译器版本和输入摘要，作为构建证据，不增加产品遥测。

### 6.1 npm manifest 与锁文件

- 以 `package-lock.json` 为源码 canonical lock。由于 npm 可能优先采用已有 shrinkwrap，新增编译器依赖时不直接对根目录无约束地执行 install 后忽略另一份锁：在受控临时目录仅放 manifest 与 canonical lock，不放 shrinkwrap，使用固定 npm 版本和 `--package-lock-only --ignore-scripts` 更新锁及精确 devDependencies；验证完成后同批同步源码 manifest、package-lock 和由同一规范序列化生成的 shrinkwrap。此操作是明确的依赖更新阶段，允许解析所选依赖；普通构建和发布组装不解析依赖。
- 同步后再执行源码侧 `npm ci --ignore-scripts`。一致性检查同时覆盖 dependencies、devDependencies、包身份、平台和 CLI 等字段，不能沿用目前只检查运行 dependencies 的局部判断。锁同步工具可以确定性修正发布锁，纯检查命令仍应拒绝不一致；第一轮引入编译器前执行这一受控流程，不要求尚未可用的 TS 工具自行引导。
- 源码侧先检查 `package.json`、`package-lock.json`、`npm-shrinkwrap.json` 一致性。
- stage 保留包名、版本、运行依赖、engines、bin、files、os/cpu 和发布标签；devDependencies 元数据可原样保留以减少锁投影变化，它们不会作为依赖包自身的开发依赖安装给消费者。
- stage 的 scripts 使用显式投影，只保留产物内可独立执行的命令，禁止携带需要 tsc 的 prepare/install/postinstall 或仓库构建递归。
- 锁文件从源码侧确定性复制，不在组装产物时联网重新解析依赖。
- `package-lock.json` 可留在 stage 供打包前检查，但不假定它存在于 tgz 或消费者安装目录。
- 解包后校验只依赖 manifest、shrinkwrap 和实际产物；不得要求安装包中带源码仓库锁文件。
- 当前 Mac preview 的发布白名单和平台范围继续执行。测试用的 native、test、fixture 目录存在于 stage，不意味着进入 preview 压缩包。
- 源码根增加 prepack/prepublishOnly 保护，正常命令拒绝直接打包或发布未编译源码；唯一支持的打包入口针对 stage。另对最终 tgz 检查入口与文件清单，防止使用 `--ignore-scripts` 绕过钩子后误交付源码。

### 6.2 拟提供的命令

下列脚本名是实施目标，目前尚未全部存在。它们要保持现有 test 分层和浏览器政策。

| 命令 | 实施后语义 |
| --- | --- |
| `npm start` | 构建并启动源码开发模式；数据、配置和 Agent cwd 仍绑定源码根 |
| `npm run build` | 生成完整的新代次产物，失败禁止继续使用旧代次 |
| `npm run typecheck` | 严格检查所有迁移项目，不生成运行文件 |
| `npm run test:unit` | 类型检查/构建后，运行产物目录的模块与 VM 测试 |
| `npm run test:integration` | 同一代次产物下运行模拟模型、真实 SDK、进程、存储与隔离测试 |
| `npm test` | 同一代次产物的全量回归，默认不启动外部浏览器 |
| `npm run test:browser` | 显式启用已有外部浏览器检查，不自动更换浏览器 |
| `npm run package:prepare` | 校验源码锁文件并准备可打包 stage |
| `npm run release:preview:check` | 校验源码约束及真正待发布的 Mac preview 产物 |
| `npm run package:pack` | 对 stage 执行 npm pack，将 JSON 回执和实际文件名保存到 dist/npm |
| `npm run test:package:smoke` | 使用实际 pack 输出路径完成解包启动检查 |
| `npm run test:package:install` | 独立临时安装生产依赖并验证 CLI，使用合成数据 |

默认 test 命令应自行保证构建有效，避免开发者忘记先编译。CI 需要一次构建多层复用时，可增加内部 `--built` 模式，但必须核对构建代次和输入摘要，不能静默跳过检查。

## 7. 核心类型模型

拟在 `src/contracts/` 按职责组织类型；名称为本方案建议，不是声称现有 API。共享类型只包含跨边界必需的数据，自有模块的内部类型就近定义，避免形成一个巨大的公共类型文件。

| 类型领域 | 建模重点 | 校验与约束 |
| --- | --- | --- |
| JSON 与标识 | JsonValue、AgentId、ConversationId、摘要、版本引用 | 品牌类型只在真实校验之后创建；不能替代归属和权限检查 |
| 需求 | 正式需求、来源引文、系统事项、确认上下文、后续验证义务 | 需求文本、编号、容量、来源与阶段保持原语义 |
| 架构候选 | 旧版与当前版本、能力与平台快照、覆盖与验收 | 不给旧数据补 schemaVersion；归一化视图与存储原文分开 |
| 阶段检查点 | 蓝图、模块、整合、依赖接口、会话和额度账本 | 检查点版本与候选契约版本分别建模，不混用 version 字段 |
| 评审 | wire 提交、原始拒稿、规范草稿、接受分项、历史问题 | 紧凑 wire 引用与 canonical 持久结构分别定义 |
| 研发 | 存储记录、当前控制器记录、五阶段任务、验收、交付包 | 宽松历史记录与已验证的当前运行记录分层 |
| 应用任务 | 输入、幂等、事件序列、终态、产物、状态版本 | 取消、中断和完成分开；依赖真实事件和持久化 |
| 对外投影 | HTTP DTO、NDJSON 事件、主/群/工作 Agent 展示状态 | 前端消费 NEUMA 自有协议，不能直接导出 Pi 对象 |
| iframe | request/response/event、实例与交付代次 | MessageEvent.data 先为 unknown，保留 source/origin/代次校验 |
| 依赖适配 | Pi 会话、MCP、材料解析器、文件与进程接口 | 限定边界，不向业务层扩散 SDK 类型或裸异常 |

### 7.1 历史兼容的具体做法

1. 读入文件、网络数据和模型参数时先视为 `unknown`，沿现有验证器检查后再获得可操作类型。
2. `schemaVersion` 缺省属于已有旧版契约，类型联合可以表达缺省分支；不能向旧文件写入 `schemaVersion: 1` 来方便判别。
3. `DevelopmentStore` 当前对历史 status 只要求非空字符串。存储边界使用可保留未知状态的 StoredDevelopmentRecord；当前控制器的严格状态视图单独建立，不因类型迁移收紧旧数据准入。
4. 在已有运行流程使用的边界提取可靠视图，不为凑类型新增会改变序列化的默认字段、重排数组或重算已冻结摘要。
5. 版本引用、候选摘要、实际轮次和累计预算作为显式字段传递，避免以布尔 ready 或 completed 替代多项真实就绪条件。

### 7.2 Schema 与 TypeScript 的一致性

当前项目同时使用 JSON Schema、Ajv 和手写验证器，不能把它们误认为同一套自动推导机制。

- 现存 schema 和语义校验继续作为外部输入与历史存储准入的运行时依据。
- 固定、简单 schema 可使用 `satisfies` 或 Ajv 的类型工具检查一致性。
- 动态 enum、条件 allOf、历史联合及自定义引用规则，先定义准确的领域类型并为现有验证器提供真实的类型收窄接口；不能仅用断言把验证器声明成检查了它实际没有检查的字段。
- 若旧验证器只保证较弱结构，应返回较弱的“已检查视图”，后续领域校验再收窄；不要假装一次校验已证明完整业务正确。
- 复用正反例与历史夹具验证 schema 接受/拒绝集合；增加有限的编译期类型用例验证字段、版本和事件分支，不用大量与实现同形的测试凑覆盖。
- 不在迁移中更换验证库、统一清洗旧记录、重写 canonical JSON、改变 hash 输入或自动修正模型提交。

动态 schema 本身也参与会话/检查点绑定。M0 固定代表性需求夹具的实际 schema JSON 及摘要；每次迁移比较结构、顺序及摘要。即使只增加 `$id`、`description`、`default`，或调整 `required`／`enum` 数组顺序，也可能破坏旧 `schemaHash`，不能以“校验结果等价”代替摘要兼容。

## 8. 分阶段实施与验收

每批遵循：明确文件范围 → 最小重命名与类型建模 → 最快的类型检查和受影响测试 → 对应集成检查 → 评审。避免在迁移提交中混入文案改写、全仓格式化、巨型模块拆分或 SDK 升级。

### M0：冻结基线与迁移清单（约 1–2 人日）

工作：梳理当前未提交成果，固定可重现的代码基线；记录 Node/npm、锁定依赖、测试分层、实际通过/失败/跳过；列出动态入口和资源路径。旧源码基线保留为独立可复查版本，不在活动工作区留两套生产源码。

验证：先运行 `npm run test:unit`，再运行受影响集成及 `npm test`；浏览器跳过照实记录。若基线已有失败，区分已有缺陷和迁移回归，在进入相应批次前明确处理，不通过削减测试掩盖失败。

退出条件：基线可重现、阻断项已明确、目标文件与路径清单齐全；未触及真实用户数据或业务任务。

### M1：先搭建构建、测试和打包骨架（约 3–5 人日）

拟改：`package.json`、锁文件、`scripts/prepare-package.mjs`、两个 release checker、`scripts/run-tests.mjs`、`scripts/smoke-package.mjs`、源码启动器、server 的 cwd 注入、测试基础设施；新增编译配置和 build 引导器。

第一步仍保留所有现有业务 JS，用编译镜像与资产复制验证布局。随后只选一个叶子文件完成真实 `.mts` 迁移，证明类型检查和 Node 运行都走产物。

测试 VM 必须读取产物 JS。统一必要的加载适配器，兼容编译生成的模块标记及多行 import/export；保留原测试行为断言，不在本批批量改造界面测试架构。

退出条件：全量旧业务能在新构建目录运行；删除一个 worker/资源会失败；故意引入类型错误时 typecheck 会失败；构建失败不会测试旧代次；开发仍使用原数据/cwd；CLI 与静态入口可从 stage 启动。

### M2：共享协议与低依赖模块（约 3–5 人日；已实施）

优先处理 `runtime/text-length`、`file-limits`、`model-limits`、`applications/*-contract`、`value-schema-rules`、结构诊断与共享 DTO 的类型边界。按实际 import 闭包迁移，文件名带 contract 不代表依赖少。

需求、架构、研发三组大契约先建立版本类型与现有验证器接口，完整实现分别在后续业务批次迁移，不强求一次改完。

代表测试：`unicode-text-contract`、`value-schema-rules`、`task-spec-schema`、`tool-input-diagnostics`、`application-contract-errors`。

退出条件：共享类型不依赖 Node/DOM/SDK；未知输入不能未经校验流入可信 DTO；序列化、错误 reason 和字符/字节限制不变。

### M3：持久化、模型与 SDK 适配（约 4–6 人日；已实施）

范围：`agents/agent-storage`、`agent-library`，`applications/task-store`，`development/development-store`，需求会话存储，`runtime/pi-session-state`、`pi-runtime`、model-context/profile/limits 和模型连接；按存储与运行适配两个可评审批次推进。

重点：明确 readJson 的未知输入、验证后的记录、原子保存、队列/Promise 类型、错误收窄、取消信号、SDK 事件投影及依赖注入端口。故障测试用端口接口，不要求替身实现整个 SDK 类。

代表测试：`agent-storage`、`agent-library`、`application-store`、`development-store`、`requirement-sessions`、`pi-session-state`、`pi-runtime`、`model-context-native`、`model-connection`。

退出条件：旧文件读回、删除标记、版本冲突、并发原子替换、保存失败、重启中断、SDK 流式/工具调用/取消保持原行为；不输出原始敏感异常。

### M4：需求、架构与研发控制器（约 8–12 人日；已实施）

按依赖分为三个连续子批次：

1. `requirements/`、`main/requirement-routing`：需求事实、任务规范、来源与澄清状态。
2. `architecture/`：先类型化契约与诊断，再阶段管线、模块依赖、拼装、评审检查点、恢复，最后主控制器。
3. `development/`、`verification/`、`agents/agent-prototype`：需求交接、五阶段、独立验收、交付绑定及激活。

`architecture.mjs`、`agent-prototype.mjs`、`development.mjs` 等大文件先保持职责和执行顺序，允许提取纯类型，不同时重构整个控制流。新状态转换接口只能在原校验处引入，不新增自动推进或修复。

代表测试：架构各 contract/design-stages/design-pipeline/review/recovery/handoff 测试、`architecture-recorded-failures`、`requirement-fidelity-*`、研发 planning/session-recovery/activation/delivery 测试，以及既有大型需求交付集成。

退出条件包括：新 v3 蓝图边界及直接上游引用保持；旧检查点不升级/补数；评审原始拒稿与接受成果分开；取消与迟到提交不提升状态；哈希绑定不变；架构通过仍须满足真实研发与激活条件。

明确版本矩阵：设计管线 checkpoint v1 保留每节点 3 轮／整条 15 轮，v2/v3 保留 5／25；评审进度覆盖 v1–v4。字段缺失与已存在字段损坏分别测试；损坏的现代检查点不能退回旧诊断、替代会话或零预算。研发旧用例中缺省 kind 仍保留原 action 含义，不为类型判别补写历史字段。

### M5：服务、连接、协作与本机项目（约 4–6 人日；已实施）

范围：`services/`、`connections/`、`collaboration/`、`projects/`、`materials/`、`skills/`、主 Agent 和 server API 组装。可按各自依赖闭包拆批，集成前冻结共享 DTO。

重点：HTTP/MCP 类型、worker 单文件属性、受限网络/能力桥、路径与归属、消息序列、队列、进程退出、超时和取消；Python/C/C++ 实现保持，调用端 TypeScript 化。

代表测试：`connections-protocols`、`service-gateway`、`managed-services`、`service-workflows`、`python-gateway-integration`、`groups-integration`、`project-runtime`、`materials-runner`、`skills-boundaries`。

退出条件：单独运行的 bridge/parser/worker 使用编译产物成功；沙箱目录授权与缺能力拒绝保持；没有因新增共享 import 破坏 Docker；群序列和本机项目进程身份不变。

### M6：前端状态、协议与界面（已实施）

顺序：

1. `application-context`、state、纯视图辅助函数。
2. application/collaboration API 和 chat-ui 流式协议。
3. agent-runtime、build-view、details-view、对话/材料/历史状态。
4. iframe host/frame 桥成对迁移；前者 ESM，后者普通脚本。
5. 主 Agent、群组、Agent 入口、项目、设置、skills、侧栏及拖拽逻辑。

建立 NEUMA 自有 CustomEvent detail 类型。DOM 元素和 Map/集合显式建模；required 元素缺失走已有错误路径，可选元素保留空值处理，不用全局非空断言消除错误。

退出条件：14 个入口及递归 import 可加载；本机 marked/KaTeX/字体正常；bridge 普通脚本可执行；旧 localStorage/配额失败/损坏恢复正常；NDJSON 分块、非完整流、错误和取消正常；桌面端主要路径完成实际检查。

### M7：测试与维护代码完整迁移（已实施）

测试夹具及 helpers 随对应生产批次逐步类型化，本阶段完成剩余 `.test.mts`、helpers、scripts、CLI `.cts` 和 `.github/scripts` 中自有 Node 程序的迁移。保留 shell/PowerShell/C++ 脚本本身。

测试中的 fake DOM、伪 SDK 使用只覆盖实际操作的端口接口；负向测试可显式传 unknown。不要把替身强制断言成完整 Document 或 SDK 对象。

少量依赖函数文本切片的测试，先运行等价编译 JS；确实因发射形式不稳定的条目，在独立提交中改为现有公开行为或最小注入端口测试，不顺便全仓重写测试。

退出条件：测试发现仍按产物 `.test.mjs` 名称分层，不漏新文件；自有源码没有双份 JS/TS；生产目录关闭 allowJs；临时适配台账清空或只剩有证据的第三方有限例外。

### M8：发布候选与收口（已实施，仅 Mac ARM64）

执行严格类型检查、干净构建、全量回归、桌面验收、实际 tgz 检查、解包 smoke、独立临时生产依赖安装和最低 Node 验证。

至少覆盖 Node 22.22.2、24.15.0 与已验证的 Node 26 环境；不因编译 target 为 ES2022 就声称各版本支持。用户本次明确只处理 Mac 打包，因此新增 Mac ARM64 代码与包检查 CI；Linux/Windows 打包与既有手动原生工作流保持不动，不计入本次完成条件。

退出条件：下节完整验收清单通过，迁移文档与实际入口一致，删除过渡 noCheck/旧源码测试入口，产物可独立安装；是否公开发布按用户明确指令执行。

## 9. 验证矩阵与回归重点

| 边界 | 必须验证的故障场景 | 证据 |
| --- | --- | --- |
| 编译 | 错误类型、输入冲突、缺静态资源、旧产物残留 | 失败返回码、构建代次和产物清单 |
| 开发启动 | 构建根变化、不同 cwd、中文/空格路径 | 数据/配置/Agent cwd 仍定位源码根 |
| 旧数据 | 缺省版本、旧状态、删除标记、损坏和错绑 | 不补写字段、不清预算、不借旧候选放行 |
| 存储 | 原子替换并发、迟到写入、保存失败、幂等冲突 | 原记录保留，失败不发布内存状态 |
| 模型/SDK | 原始参数错误、半截流、超时、重复拒绝、取消 | 安全诊断、实际轮次与终态一致 |
| 架构与研发 | 来源/摘要/引用错误、旧会话恢复、修复授权耗尽 | 程序门槛与独立评审仍实际执行 |
| 静态资源 | 所有 ESM import、vendor/字体、未知/穿越路径 | 200/MIME 正确；静态白名单和原拒绝策略保持 |
| iframe | 错 origin/source、旧代次、重复/迟到消息、超时 | 不越权更新状态，bridge 保持普通脚本 |
| 进程与隔离 | worker 缺失、模块未复制、缺原生能力、停止 | 明确失败；无无隔离回退 |
| npm 包 | 漏 worker/资产、带 TS 源码、依赖开发目录、源码根误打包 | 检查实际 tgz，独立临时安装运行 |

常规顺序为：受影响类型检查 → 受影响测试 → 对应集成组 → 批次全量回归。提交或推送前执行现有约定的 `npm test`；完成一次必要验证后不无理由重复消耗。

默认测试不启动外部浏览器，模块/集成命令继续移除外部浏览器开关。桌面页面检查优先 Codex 内置浏览器。显式 `test:browser` 仍按现有 Dia/指定浏览器规则执行，未运行或不兼容项照实记录，不自动换 Chromium，不增加窄屏验收范围。

模型协议测试使用本机替身和合成材料，不重跑用户真实业务。干净安装需要解析已有生产依赖，与解包 smoke 分别记录；复用仓库 node_modules 的启动不算干净安装。

## 10. CI 改造

已新增常规代码校验工作流 `.github/workflows/typescript-check.yml`。

常规 PR 构建作业使用当前根包允许的 Mac ARM64 环境，并在开始时核对实际 Node 平台/架构。流程：锁文件安装 → typecheck → 干净 build → 产物 unit/integration/默认全量测试 → stage 发布校验 → 实际 tgz 清单与 smoke。CI 可复用已经验证的同一构建代次，禁止为每一步悄悄运行不同树。

Mac 原生隔离与安装检查必须在具备相应能力的运行器执行。通用运行器不能通过放宽沙箱能力检查来取得绿灯；将平台专属检查分配给对应真实环境。干净安装和最低 Node 矩阵至少在发布候选运行。

按用户后续范围修订，本次不调整 `.github/workflows/native-check.yml`，不修复 Linux/Windows 的既有失败，也不声称这些平台安装通过。新增 `.github/workflows/typescript-check.yml` 仅在 Mac ARM64 验证三组 Node 版本、严格编译、产物全量测试、preview 检查以及同代次打包、smoke、独立生产依赖安装。未来处理其他平台时，另行设计产物传递与原生验证链。

## 11. 批次管理、回退与交付

- 一个批次尽量只覆盖一个依赖闭包或一个基础设施问题。纯重命名/类型变更与因真实缺陷导致的行为修复分开评审。
- 不对现有未提交成果执行 reset 或覆盖；用户已授权全部成果按逻辑批次提交，保持基线修正与迁移分开。
- 每批记录源版本、编译器/锁文件版本、文件清单、类型门槛、测试结果、已知例外和回退点。
- 产物构建目录从不承载用户数据；只备份合成测试数据和必要的代码/构建证据，不复制凭据进归档。
- 发现 API/摘要变化、预算恢复异常、cwd 漂移、worker 失效、无隔离回退或陈旧产物假绿时，暂停该批，恢复上一可验证代码版本并重新构建。
- 因本次不改变用户数据 schema，正常回退无需反向数据迁移。运行过真实任务时先正常停止服务，保留已发生的业务结果；不能为回退自动重放、清空或撤销外部动作。

每批交付：小范围差异、迁移后的类型接口、对应测试、命令与结果、迁移台账更新。最终交付：TypeScript 源码、锁定工具链、可重现构建、独立安装 tgz、验收记录及更新后的开发文档。

## 12. 工期、资源与不确定性

按一名熟悉当前代码的开发者连续实施估算，M0–M8 合计约 35–55 人日，即约 7–11 个工作周。它是立项量级，不是已经测量的工期承诺；并行审查可以节省等待，不能消除共享契约、集成和安装验证的依赖。

影响工期最大的三项是动态契约的准确建模、VM/源码切片测试适配，以及当前工作区和平台验证的基线质量。实施完 M1 并完成 M2 中一个完整契约闭包后，用实际错误数、第三方声明问题、测试适配量和批次吞吐重新估算。

首个投入窗口建议为 4–7 人日：M0 + M1。该窗口应交付可运行的构建/测试/打包骨架和一个严格类型化模块，以此评估后续预算；这只是实施检查点，整体目标仍是完成全部自有应用和测试的迁移。

不预先承诺性能提升或业务成功率提升。可衡量收益应是：字段/事件/版本错误能在提交前被检查出，接口改动能定位受影响代码，构建和发布保持可验证。

## 13. 最终完成清单

- [x] 自有后端、前端、测试和维护代码全部进入 TS；只剩已说明的薄构建引导器及其他语言组件。
- [x] 无重复手改 JS/TS；生产类型检查不依赖 allowJs 或 noCheck。
- [x] strict、索引访问和可选属性规则按目标启用；无未解释 any、双重断言或整文件忽略。
- [x] Node、浏览器、普通脚本与测试类型环境分开；SDK 类型不泄漏给浏览器。
- [x] 旧数据、原生会话、检查点、预算、哈希和激活绑定回归通过。
- [x] 编译产物下的现有测试及必要新增边界测试通过；浏览器通过/跳过/失败准确记录。
- [x] 开发模式继续使用源码根数据和 cwd，安装版继续使用独立用户数据根。
- [x] parser、worker、MCP、iframe bridge 和原生程序路径已独立验证。
- [x] 实际 tgz 不含自有 `.ts/.mts/.cts` 源文件、测试、用户数据、凭据或仓库依赖目录；运行不依赖开发编译器。
- [x] 解包 smoke 与独立安装分别完成；最低支持 Node 实测结果齐全。
- [x] preview 平台和发布标签符合现有约定；其他平台不扩大支持声明。
- [x] README、AGENTS、ARCHITECTURE、研发设计和安装文档同步实际路径及命令。正式架构文档只在对应实现落地后更新，不把本方案提前声明成已实现行为。

## 14. 参考与证据

仓库证据以文档日期的工作区为准；实施前再次核对，不能据此覆盖后续新增行为。

- `package.json`、`bin/neuma.cjs`：现有 ESM、版本限制、CLI 与发布白名单。
- `src/server.mjs:29,290,300–301,640`：包根、数据根、cwd 和静态资源定位。
- `src/installation/installation-runtime.mjs:151–157`：已有源码开发启动接口。
- `src/architecture/architecture-contract.mjs:146`：基于当前需求动态生成提交 schema。
- `src/development/development-store.mjs:11–21`：历史记录的实际准入条件。
- `src/applications/application-resources.mjs:64–79`：普通脚本 bridge 资源及注入顺序。
- `test/agents-ui.test.mjs:12–14`：VM 源码拼接；其他同类测试需全部登记。
- `scripts/run-tests.mjs`、两个 release checker、`scripts/smoke-package.mjs`：测试分层与发布校验职责。
- [TypeScript 模块模式](https://www.typescriptlang.org/tsconfig/module.html)：NodeNext 及运行环境对应。
- [TypeScript 渐进迁移](https://www.typescriptlang.org/docs/handbook/migrating-from-javascript.html)、[allowJs](https://www.typescriptlang.org/tsconfig/allowJs.html)：JS/TS 混合期。
- [TypeScript noCheck](https://www.typescriptlang.org/tsconfig/noCheck.html)：发射成功不代表类型检查通过。
- [Node TypeScript 支持](https://nodejs.org/api/typescript.html)：原生类型剥离不执行类型检查，不能替代交付编译与验证。
- [Ajv TypeScript 支持](https://ajv.js.org/guide/typescript.html)：类型收窄与复杂联合的限制。
- [npm pack](https://docs.npmjs.com/cli/v11/commands/npm-pack/)、[npm 生命周期](https://docs.npmjs.com/cli/v11/using-npm/scripts/)：打包与消费者安装分工。
