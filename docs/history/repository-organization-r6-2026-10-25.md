# R6 生命周期与资源清理验证——审计与实施记录

- 日期：2026-10-25
- 方案：`docs/repository-organization-plan.md` 第 7 节（R6）
- 实施前基线：main 提交 ade3333（R5 完成），`npm test` 3240/3225/0/15。
- 本文档第一部分为只读审计结论（B3）；缺陷修复按问题拆分提交（B3-fix），验证结果随批次更新。

## 1. 资源归属表（方案 7.2）

| 资源 | 拥有者/状态所有者 | 创建 → 取消/等待 → 释放 → 终结发布 | 关闭与复用语义 | 清理失败时必须继续的独立资源 |
|---|---|---|---|---|
| Agent/协作会话（Pi 会话） | `PrototypeAgents.sessions` / `collaborationSessions` | 会话工厂创建；`item.controller.abort()` 与 `session.abort()` 取消；busy 项等待 `item.done`；`session.dispose()` 释放并从 map 清除 | close 后 map 清空，后续 prompt 重建会话；`runtimeEpoch++` 使旧代次完成不可回流 | applications、gateway、services、materials、development、persistence 的清理互不依赖 |
| 构建（builds） | `PrototypeAgents.builds` | 同上；`build.controller.abort()` | 同上 | 同上 |
| 应用任务/工作流/页面资源 | `ApplicationService`（自有 store/resources/workflows） | close 内：running 标记 interrupted 并 cancel → 等待 done 与 stateWrites → `workflows.close()` → `resources.closeAll()` → `store.settle()`；失败重新抛出 | close 后 `epoch++` 防旧写；组件级关闭后可再次组装 | prototype 其余组件 |
| 本机接口网关 | `ServiceGateway`（servers/transports 自有） | 临时关闭复用同端口；永久关闭不可恢复（已有测试锁定） | 临时/永久分开，恢复不得换端口 | — |
| 托管服务 worker | `ManagedServiceManager.workers` | `worker.stop(reason)`：kill 进程组、failActive、rejectReady；`closed` promise 发布终结 | `close({permanent:false})` 后允许重启；permanent 后不可 | prototype 其余组件；manager 内部 `tail` |
| 材料子进程 | `MaterialStore` → `MaterialRunner`（active/queue） | close：排队项拒绝、活动项 stop、等待 done；`drain()` 在关闭完成后允许新任务 | 关闭后可复用（已有测试锁定） | — |
| 研发执行 | `DevelopmentController.active` | close = `allSettled(cancel)` | 关闭后可新建 | — |
| 活动持久化 | `ActivityStore.persistence` 串行链 | 逐条追加，链上 catch 吞错不阻塞后续 | close 等待当前链完成 | — |

## 2. 待核验矩阵 → 现有覆盖映射（方案 7.3）

| 场景 | 现有覆盖（R4 后路径） | 结论 |
|---|---|---|
| 清理中途失败 | 无（任何组件都没有 close/dispose 异常注入） | **缺口**：prototype 组合 close 与 manager close 均未验证 |
| 并发关闭 | 无显式用例（prototype `if (this.closing) return` 语义未被测试锁定） | **缺口（锁定用例）** |
| 关闭后再次关闭 | scheduler/materials/services/gateway 各自复用测试；prototype 级无 | **缺口（锁定用例）** |
| 迟到能力回调 | `managed worker termination settles cancelled and timed-out calls`、`artifact read ... never returns a late snapshot`、`项目助手在项目列表等待期间取消不会返回完成结果` | 已覆盖 |
| 活动与排队交错 | `取消排队任务不执行…`（scheduler）、`cancels queued jobs without spawning`（materials）、executor 取消终止进程组 | 已覆盖 |
| Mac 实际资源退出 | managed-services 真实 worker/scratch、development-executor 真实隔离与进程组、gateway 端口冲突/恢复测试 | 已覆盖（本批不新增） |

## 3. 审计发现（方案 7.4 优先审计点）

`PrototypeAgents.close()`（src/agents/agent-prototype.mts）：

- 已正确：并发 close 返回同一 promise；applications 失败捕获后继续；运行时停止用 allSettled；会话 abort/done 等待用 allSettled；失败在末尾重新抛出（可见）。
- **缺陷 A（清理中途失败）**：`await this.materials.close()`、`await this.development.close()`、第二次 `await this.services?.close()` 均未隔离；任一拒绝会跳过其后的会话 abort/等待、`dispose()` 循环、map 清空与 persistence 等待。`dispose()` 同步抛出同样中断循环。后果：一个组件的清理失败使其他独立资源全部泄漏，且失败后的会话不再释放。
- 备注（非缺陷）：services 在一次 close 中被停两次（先随运行时停止、会话排空后再停），与"close 后允许重启"的临时关闭语义一致。

`ManagedServiceManager.close()`（src/services/managed-service-manager.mts）：

- **缺陷 B（临时关闭被固化）**：worker 停止使用 `Promise.all`；任一 `worker.stop()` 拒绝（如 docker 停止失败）会让 close 整体拒绝，`await this.tail` 被跳过，且 `closed` 保持 true、lifecycle 不重建——非永久关闭被固化成永久关闭，违反"允许恢复的组件不能被统一改成永久关闭"。

`ApplicationService.close()`（src/applications/application-service.mts）：

- **缺陷 C（组件内连锁跳过）**：`workflows.close()`、`resources.closeAll()`、`store.settle()` 顺序 await 未隔离，前者拒绝会跳过后续两者（页面资源泄漏）。prototype 层已捕获 applications 的失败、不影响其他组件，但组件内部独立资源仍应继续清理。

## 4. 实施批次

| 批次 | 内容 | 提交 | 状态 |
|---|---|---|---|
| B3 | 本审计 + 通过性锁定用例（并发关闭、成功后再次关闭）`test/agents/agent-close-failures.test.mts` | 5ad9ede | 完成 |
| B3-fix-1 | 缺陷 A：prototype close 失败隔离（3 个失败用例 + 最小修复）`src/agents/agent-prototype.mts` | 09a9e7f | 完成 |
| B3-fix-2 | 缺陷 B：manager close 临时关闭不被固化（2 个用例，其中 1 个先失败 + 最小修复）`src/services/managed-service-manager.mts` | 105cff9 | 完成 |
| B3-fix-3 | 缺陷 C：ApplicationService.close 内部隔离（失败用例 + 最小修复；workflows 构造参数可注入）`src/applications/application-service.mts` | 8b6dae0 | 完成 |

## 5. 验证记录

- B3 锁定用例：2 项通过（并发关闭共享同一次清理——会话 dispose 各一次、组件 close 各一次、services 按设计停两次；成功关闭后再次关闭幂等）；全量回归 3242/3227/0/15（typecheck 565）。
- B3-fix-1：materials 清理失败、services 第二次停止失败、单个会话 dispose 抛出三个用例在修复前全部失败（证实审计缺陷 A），修复后通过；失败优先级保持 applications 优先；受影响测试（session-shutdown、agent-scheduler、agent-prototype、server 69 项）通过；全量回归 3245/3230/0/15（typecheck 565）。
- B3-fix-2：worker 停止失败用例修复前失败（closed 固化为 true、lifecycle 未重建），修复后临时关闭失败可恢复、再次 close 重试成功、失败可见；永久关闭语义不变；managed-services 12 项通过（1 项既有 Python 环境跳过）；全量回归 3247/3232/0/15（typecheck 566）。
- B3-fix-3：workflows 清理失败用例在仅回退隔离改动的版本上失败（resources/store 被跳过），修复后按序收尾且失败可见；应用域 27 项测试通过；全量回归 3248/3233/0/15（typecheck 567）。
- 行为影响：三处修复都只改变"清理失败时其余独立资源继续释放、失败仍然可见"的路径，正常关闭路径的顺序、复用语义与失败优先级不变；无用户产物或已完成副作用回滚。
- 本批测试全部使用替身与临时目录（t.after 清理），不创建进程、端口或真实模型调用；测试结束无遗留。
- 方案 11 总体条件中 R6 项：现有覆盖与补充覆盖有据可查（本文第 2 节映射），必要故障修复单独提交（三个 fix 提交）。
