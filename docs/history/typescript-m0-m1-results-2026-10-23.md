# TypeScript M0/M1 实施与验证记录
> 2026-10-25 自 docs/ 根归档；本记录为 2026-10-23 迁移实施与验证的原始证据，数字与状态保持当时语境，不作为当前结果。现行规则以 [AGENTS.md](../../AGENTS.md) 与 [ARCHITECTURE.md](../../ARCHITECTURE.md) 为准。

日期：2026-10-23。范围：M0 基线与 M1 编译、启动、测试、打包骨架；未进入 M2 领域契约迁移。

## 结果

M0/M1 工程范围已完成。严格类型检查、产物测试入口、构建故障边界、源码启动、编译包、解包 smoke 和独立临时安装均已实际验证。

全量测试不是全绿：实施前已有一项架构预算规则断言失败，实施后保持同一失败。没有修改该业务规则、删减断言或跳过它来取得通过；M4 前需要单独处理这一已有问题。

## M0 基线与已有改动保护

- 基线 HEAD：`e1ba0016b3964ea73d050afac5bd1c3a5a01d624`。实际基线是该 HEAD 加当时全部有效未提交/未跟踪源码，不能只用 HEAD 代替。
- 环境：macOS ARM64，Node `26.3.0`，npm `11.16.0`。
- 快速组：1543 通过、0 失败。
- 全量：3188 项，3172 通过、1 失败、15 跳过，约 341 秒。
- 原有失败：`test/architecture-review-revision.test.mjs:57` 的“新设计二十五轮总账允许正式评审后修订，旧版和未知预算版本不能借此放宽”，第 66 行报 `Missing expected rejection`；单文件复现为 15 通过、1 失败。
- 保存了 520 个源码、资源及必要开发说明文件的快照，不含用户数据、凭据、node_modules 和构建产物。
- 原先未提交文件中 41 个 SHA-256 逐字节一致；唯一需要叠加修改的原有脏文件是 `scripts/run-tests.mjs`。其原分层清单、分类函数和浏览器环境函数在排除两条新增测试登记后与基线原文完全一致。
- 14 组静态/动态 schema JSON 和摘要在编译产物中逐项比对一致。

快照位置：`dist/migration-baseline/m0-20261023/source.tgz`。

快照 SHA-256：`a76b7c05289ac015b83f24140577b68b07d57609cb9a427f9ec91c5a9c885247`。

同目录的 `manifest.json` 包含原 Git 状态、环境和逐文件摘要，`schemas.json` 包含 schema 样本及摘要；完整日志保存在同目录。

## 修改内容

| 范围 | 文件与行为 |
| --- | --- |
| 工具链 | `package.json`、`package-lock.json`、`npm-shrinkwrap.json`：精确锁定 TypeScript `7.0.2`、`@types/node` `22.20.5`；原有包版本未改变 |
| 编译配置 | 新增 `tsconfig.base/node/browser/frame/test/contracts.json`；Node、DOM、普通脚本、测试及纯类型声明分环境检查 |
| 构建 | 新增 `scripts/build.mjs`：严格检查所有已迁移 TS，独立临时发射并按来源归属组装，复制旧 JS 原字节及资源，发布新代次并记录输入/产物摘要 |
| 首个 TS 模块 | `src/runtime/text-length.mjs` 重命名为 `.mts`，增加参数、返回值及字符串类型收窄；编译输出仍是 `.mjs`，保留原 Unicode/非法输入行为 |
| 开发启动 | 新增 `scripts/start-source.mjs`；`src/server.mjs` 新增可注入 cwd，源码数据/配置/Agent cwd 仍绑定源码根，静态资源绑定编译包根 |
| 测试入口 | `scripts/run-tests.mjs` 在原分层清单上增加自动构建、代次校验和 all 模式；测试及 VM 读取编译目录，不依赖源码树中不存在的 `.mjs` |
| 发布 | `scripts/prepare-package.mjs`、两个 release checker、新增 `scripts/package-artifact.mjs`、`scripts/source-package-guard.mjs`：分别检查源码锁和产物，拒绝源码根打包，产物不需要源码 package-lock |
| 安装检查 | `scripts/smoke-package.mjs`：实际 pack 文件名、44 个前端模块/vendor、只读程序目录、设置/重启/退出，以及独立临时生产依赖安装 |
| 测试 | 新增 build-pipeline、source-launcher 测试；更新 prepare-package、preview-release、installation 测试以验证新的故障边界与产物布局 |
| 文档 | README、AGENTS、ARCHITECTURE、安装说明、迁移方案和本记录同步现有命令与限制；开发 Markdown 按原规则本地保留 |

构建只操作 `dist/ts-build/`，不会清理 `dist/` 中的旧归档和 M0 证据。构建失败会移除旧代次的有效标记；测试和打包检查源内容及输出摘要，不能悄悄使用陈旧产物。stage 不复制用户配置或 node_modules；正式包的 manifest 去掉开发构建生命周期，消费者不需要 TypeScript 编译器。

配置本身独立保存，发射使用同一配置的 CLI 覆盖参数，避免再维护一组重复 emit JSON。M1 只对唯一已迁移实现启用严格检查，未迁移 JS 不宣称已获类型安全；后续目录中新增 TS 若漏入检查配置会直接失败。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| `npm run typecheck` | 1 个真实 TS 实现严格检查通过；strict、索引与可选属性规则启用 |
| `npm run build` | 原包层级、worker、普通脚本 bridge 和静态入口完整 |
| 构建专项 | 4 项通过：真实类型错误、检查遗漏/同名冲突/桥模块化、过期与篡改、缺 worker/失败不复用/归档保留 |
| 产物快速回归 | 一次快速组 1544 通过、0 失败；此后新增的两项发布检查也在最终全量通过 |
| 最终 `npm test` | 3196 项：3180 通过、1 项原有失败、15 跳过，约 363 秒；比 M0 新增 8 项均通过 |
| schema 兼容 | 14 组 JSON/摘要与基线相同 |
| 原有未提交成果 | 41 个文件逐字节保留；原测试分层和浏览器环境规则原文保留 |
| 源码启动器实测 | 从任意 cwd、显式临时根启动，临时根 `.neuma/`、health 与 SIGINT 关闭通过；cwd 参数另有独立测试 |
| Mac preview 检查 | 通过，平台与标签范围保持原约定 |
| 源码直接 `npm pack --dry-run` | 按设计拒绝，提示使用 `package:pack` |
| 实际 tgz | 221 个文件，2,100,766 字节；无 TS 源文件、测试、node_modules 或用户配置 |
| 解包 smoke | 只读程序目录、中文/空格数据目录、任意 cwd、44 个前端模块、vendor、设置、重启与 Ctrl+C 通过；明确复用开发依赖 |
| 独立临时安装 | 使用 tgz 安装生产依赖后完成相同启动检查，通过；未复用仓库 node_modules |
| `git diff --check` | 通过 |

测试使用本机模拟接口和合成材料，没有调用用户真实模型服务、迁移用户数据或重放业务任务。默认未开启外部浏览器；15 项跳过与 M0 相同。实际环境验证仅代表本机 Node 26，最低 Node 与其他系统完整认证仍属于后续收口。

安装包位置：`dist/npm/chrissliu-neuma-0.1.0-preview.2.tgz`；`dist/npm/pack-result.json` 保存实际文件清单和 npm 摘要。版本未公开发布，也没有提交、推送或清理用户现有改动。

## 后续入口

开发使用 `npm start`；检查使用 `npm run typecheck`、`npm run test:unit`、`npm run test:integration` 和 `npm test`；本地打包使用 `npm run package:pack`。

M2 起按原方案迁移共享契约与低依赖模块。原有预算规则断言失败应独立修复并审查，不能当作 TypeScript 工具链问题自动改写。
