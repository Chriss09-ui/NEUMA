> 历史档案，非当前规范入口。本文记录仓库整理方案 R3（模块职责与依赖整理）四批实施证据；测试数字为当时实际运行结果，不作为后续会话的验收数量。逐批详情见各提交说明。

# R3 模块职责提取实施记录（四批）

日期：2026-10-25。基线：R1 批次提交 `c933223`（全量回归 3225 项：3210 通过 / 0 失败 / 15 项按配置跳过）。

## 批次 1：agent-workspace.mts（提交 5d3bec6）

- 目录检查、路径约束（workspaceTarget/forbiddenName）、有界字节读取、脱敏文本读取（safeText）与文件工具构造（createWorkspaceTools）整体迁出 agent-prototype.mts；`safeText`、`forbiddenName` 因被控制器其他路径（记忆、群上下文、页面内容、目录扫描）复用而导出。
- 控制器继续决定哪个 Agent 访问哪个工作目录、装配哪些工具；工具名、schema、错误分类、权限判断不变；测试经 PrototypeAgents 访问，提取对测试透明。
- 验证：严格类型检查 552 文件；导入 agent-prototype 的全部 29 个测试文件（308 项：301 通过 / 0 失败 / 7 跳过）；全量回归与基线一致。

## 批次 2：architecture-input-context.mts（提交 2710b7e）

- `architectureVerificationContext`、`architectureConfirmedContext` 迁出 architecture.mts；新模块负责输入材料构造，architecture-model-context 继续负责模型投递与按需读取，无重复职责。
- architecture.mts 保留原公开导出的转导出，消费者（agent-prototype、测试）不变；无反向运行时依赖。输入字段、来源引用、哈希材料、错误内容逐字未改。
- 验证：严格类型检查 553 文件；直接受影响 8 个测试文件（confirmed-context、deferred-verification、evidence-pagination-capacity、architecture、architecture-integration、tool-diagnostics、agent-prototype、agent-api：138/138）；全量回归与基线一致。

## 批次 3：architecture-revision-source.mts（提交 585e0e1）

- 修订/评审来源选择函数群整体迁出 architecture.mts（2284 → 1769 行）：RevisionSeed/RevisionContext、版本绑定核对、材料重建与各类来源选择（reviewed / fidelity / rejected-fidelity / development / continued / interrupted / review-continuation / feedback-repair），连同被两处共用的 `checkedModule` 与 `moduleResultSchema`。
- 保存队列、records 所有权、prepareRestart/save/remove 提交顺序不动；预算、授权与历史语义不变。私有：绑定核对、材料种子、历史评审证据、中断原因；导出：各来源选择器、反馈修复辅助、checkedModule、moduleResultSchema、RevisionContext。
- 验证：严格类型检查 554 文件；恢复/修订/反馈相关 17 个测试文件（289/289）；全量回归与基线一致。

## 批次 4：ArchitectureControllerPort（提交 35e0196）

- 依赖方向选定 agents → architecture：PrototypeAgents 对架构控制器的依赖由具体 ArchitectureDesigner 缩为实际消费集合 `Pick<…, "get"|"getVersion"|"save"|"design"|"markReady"|"remove"|"ready"|"persistence">`（后两项为 server 组装读取），声明于 prototype-port.mts；默认实现与实例创建位置不变，不新增第二种实现的扩展机制。
- 最小替身验收落在 test/types/m4-architecture.mts（编译期检查，含与真实签名一致的 save/markReady 返回形状）；两处故意白盒访问控制器内部（内存 records 注入、storage 目录绑定）的测试在访问点显式断言具体类型。
- 验证：严格类型检查 554 文件；受影响 7 个测试文件（186/186）；全量回归与基线一致。

## 备注

- 每批均按约定在提交前完成全量回归（3225 项：3210 通过 / 0 失败 / 15 项按配置跳过，均与基线一致）；严格类型检查文件数随新模块 552 → 554。
- 未触发布局：架构 records 与 persistence 串行链仍由 ArchitectureDesigner 持有；会话 map、取消标志、运行代次仍由 PrototypeAgents 持有；激活/回滚/数据迁移未拆；关闭 Promise 顺序留待 R6 故障验证后再定。
- R3 未包含行为修复；全程未发现需要先建失败用例的缺陷。
