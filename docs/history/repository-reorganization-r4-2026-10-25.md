> 历史档案，非当前规范入口。本文记录仓库整理方案 R4（按领域整理测试）B4/B5 各批实施证据；测试数字为当时实际运行结果，不作为后续会话的验收数量。逐批详情见各提交说明。

# R4 按领域整理测试实施记录（B4/B5）

日期：2026-10-25。基线：R3 批次 4 提交 `35e0196`（全量回归 3225 项：3210 通过 / 0 失败 / 15 项按配置跳过；发现集合 all=250、unit=101、integration=146、browser=4，其中 98 个未分类文件经 integration 兜底运行）。

## B4 递归发现（提交 65eb4c0）

- `scripts/run-tests.mts` 新增并导出 `discoverTestFiles()`：递归遍历 `test/`，以相对 test 根的完整路径标识条目（`.test.mts` 归一为 `.test.mjs`）；发现、分类、`--list` 与实际启动共用同一集合。分层清单条目保持顶层裸名即可继续匹配，`all` 仍显式传全部文件、串行并发与 integration 兜底不变。
- `test/build/test-layers.test.mts`（时为顶层）改用共享发现函数，并新增回归用例：嵌套目录、不同目录同名文件互不冲突、helpers/fixtures/types 非测试文件不进入运行集合、空集合。
- 验证：改前后 all/unit/integration/browser 四个 `--list` 输出逐字节一致（250/101/146/4）；全量回归与基线一致。

## B5 六批迁移

| 批次 | 提交 | 目录 | 文件数 | 迁移后该批测试 |
| --- | --- | --- | --- | --- |
| B5.1 | aa8a4a4 | runtime、build、ui、installation | 44 | 529 项：528 过 / 1 跳过 |
| B5.2 | ebfce60 | requirements | 21 | 267 项全过 |
| B5.3 | 4bc1016 | architecture（含 platform-contract、requirement-fidelity 六件） | 64 | 866 项全过 |
| B5.4 | 4448078 | development（含 acceptance/verification/node-action 等；development-executor 留顶层） | 40 | 430 项：423 过 / 7 跳过 |
| B5.5 | ee637b8 | agents（含 materials、workspace-utf8-nul）、applications | 35 | 473 项：469 过 / 4 跳过 |
| B5.6 | 5f41754 | collaboration（含 main 套件、agent-collaboration-runtime）、services（含 connections-protocols）、projects | 41 | 585 项：582 过 / 3 跳过 |

- 每批流程：保存批前分层清单 → `git mv` 至领域目录 → 按旧位置解析、新位置重表达改写 `from "…"`、`import("…")`、`new URL("…", import.meta.url)` 与模板 URL → 同步改写 `run-tests.mts` 分层条目 → 重构建后用映射对比四个分层集合 → 运行该批迁移测试 → 全量回归 → 提交。
- 每批集合对比均为"逐一对应"（250/101/146/4，无丢失、无重复、无分类漂移）；每批全量回归均为 3210 通过 / 0 失败 / 15 跳过，与基线一致。
- 收尾提交补充：`run-tests.mts` 注明顶层保留原因；ARCHITECTURE.md 第 9/10 节与 README 的测试说明同步为领域目录布局。

## 迁移中的三类路径修正（均为机械重写的边界情况）

1. `new URL("…", import.meta.resolve(…))` 的基底是包根而非测试文件，不得按文件相对路径改写（pi-runtime 的 defaults.js 引用已还原）。
2. 模板字符串 URL 与以 `/` 结尾的目录 URL 需保留尾部斜杠；工具早期版本丢失斜杠，波及 B5.5 六行（agent-avatar ×3、agent-build-view、agents-ui、materials 目录）与 B5.2 一行（requirements-ui），均已修复并对迁移前原树全量审计确认无其他遗漏（installation 的 `../` URL 在 URL 语义下与无斜杠形式等价）。
3. 按层级计算的 `dirname(dirname(import.meta.url))` 需随目录深度加层（python-gateway-integration）。

## 验收对照（方案 5.7）

- 原有 250 个测试经映射后全部可发现：每批集合对比 + 最终 all=250 与迁移前总数一致；未漏测、未重复运行。
- helpers（26 个辅助/夹具文件）、fixtures、types 三个编译期反例不在运行集合（发现函数按 `.test.mts` 过滤并有回归用例锁定）。
- 断言、默认 skip 条件、浏览器策略（browser 层 4 文件、 Dia 默认、显式环境变量机制）与串行并发保持；各批跳过数与基线一致。
- 未硬编码 250：test-layers 使用共享发现结果断言覆盖。
- `.github/workflows/native-check.yml` 固定引用的 4 个编译产物路径保持顶层有效（development-executor、isolation-native、project-platform、project-runtime）；顶层第五个保留入口为 server 组装测试。
- 领域归属按测试实际导入的首要被测模块判定；界面测试明显属于业务领域的随领域放置，`test/ui/` 仅放共享界面基础测试。分类语义未在本轮重新判断（group-layout 等仍经 integration 兜底），完整登记留待 R5。
