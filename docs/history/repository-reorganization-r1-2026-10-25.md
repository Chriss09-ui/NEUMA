> 历史档案，非当前规范入口。本文记录仓库整理方案（docs/repository-organization-plan.md）B0 基线与 B1（R1 文档归位）批次的实施证据；记录中的测试数字为当时实际运行结果，不作为后续会话的验收数量。

# R1 文档归位实施记录（B0/B1）

日期：2026-10-25。

## B0 基线

- 主仓库 HEAD：`2e2961e`（docs(agents): declare 本地测试记录 as frozen historical evidence），工作区干净；方案盘点基线为 `cca9088`，其间仅多该 docs 提交。
- 提交前全量回归（本批文档修改前运行）：`npm test` 3225 项，3210 通过、0 失败、15 项按默认配置跳过（外部浏览器用例），耗时约 410 秒，退出码 0。
- 代码引用核对：`test/`、`scripts/`、`src/` 中仅 `README.md` 与 `docs/images/readme-*.jpg` 被构建与预发布检查引用（`scripts/build-core.mts` ROOT_FILES、`scripts/check-preview-release.mts`、`test/preview-release.test.mts`）；ARCHITECTURE.md 与 AGENTS.md 无代码或测试引用其内容，重组不影响测试。

## B1 变更范围

仅以下三个主仓库跟踪文件被修改；`src/`、`test/`、`public/`、`scripts/` 无任何改动：

1. **ARCHITECTURE.md**：由按日期倒序追加的编年版（910 行）重写为按主题组织的现行基线：总览、系统入口与生命周期、需求层、架构层（角色与预算／平台契约／v3 阶段化设计／独立评审与范围复核／修订路径／恢复与例外授权／输入投影与提交通道／存储状态／官方检索）、研发层、运行与交付、群协作与主 Agent、数据与存储、前端与交互、构建与验证、跨领域不变量、文档地图。各节标注实现模块与验证测试入口。
2. **AGENTS.md**：删除与 ARCHITECTURE.md 重复的 v3 检查点长段和 M2–M8 迁移过程叙述，压缩为"语言与构建／日常规则／验证"三节现行约定与阅读入口；关键数量约束保留一行摘要并指向 ARCHITECTURE.md 对应章节，同一事实只在一处完整解释。
3. **README.md**：补齐 `src/` 目录树缺失的领域目录（main、collaboration、connections、services、materials、skills、verification、contracts），新增"文档"一节链接深入说明。

## 历史归档

- **docs/history/architecture-chronicle-2026-10.md**：R1 整理前根 ARCHITECTURE.md 的编年原文，以 `git show HEAD:ARCHITECTURE.md` 逐字冻结（910 行）加 3 行档案声明。文内"此规则取代下文"的内部覆盖关系在档案内阅读时仍成立；当前规范以重写后的根 ARCHITECTURE.md 为准。
- 原 ARCHITECTURE.md 中"目录说明见 README.md#文档与开发"指向不存在的锚点，重写后不再引用；本轮维护的三份文档链接经脚本核对全部有效。

## 内容去向说明

- 编年版中的现行规则（v3 检查点、轮次与授权、恢复路径、容量与文字单位、隔离边界、存储与兼容等）合并去重后进入新 ARCHITECTURE.md 对应主题章节；关键数字与 AGENTS.md 现行约定及编年版最新覆盖条目交叉核对一致（每节点五轮／整条二十五轮、独立评审五轮、研发 12/40/12、群 48/12、托管服务十分钟/512 MiB、应用 120 秒等）。
- 各日期段中的过程叙述（当时验证数量、改动文件清单、服务重启记录、"本轮验证"段落）与旧链接不进入新基线，仅保留于编年档案。
- `AGENT_PROTOTYPE.md`、`本地测试记录/`、docs/history 既有档案维持原状；docs/development-layer-design.md 未作任何判断或修改（按方案 1.1 排除项 2）。

## 验证

- 提交前再次执行 `npm test` 全量回归（结果见提交说明；纯 Markdown 变更，构建与测试输入不受影响）。
- 链接核对：ARCHITECTURE.md、AGENTS.md、README.md 中全部相对链接目标存在。
- git status 确认主仓库仅三份根文档变更；docs/ 新增文件属嵌套本地文档库工作区，不改变主仓库与文档库的版本管理安排。
