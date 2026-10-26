# 五项运行可靠性改造实施记录

日期：2026-10-26。状态：代码与文档已完成，最终全量回归通过；安装包验证见下方记录。提交与远端同步状态以 Git 记录为准。

原计划见 [五项改进计划](runtime-reliability-improvement-plan-2026-10-26.md)，现行行为以 [ARCHITECTURE.md](../ARCHITECTURE.md) 为准。保留原工作树已有的测试调整和 `domain-contract-ports.mts` 删除；本次没有恢复或覆盖这些改动。

## 用户现在可以做什么

1. 主对话、架构构建和研发先保存请求，再后台执行。刷新或重新打开后查看同一任务；停止按钮绑定当前任务代次。
2. 使用固定的合成模型脚本复现失败。多调、少调、错角色、错阶段、错工具或错上下文会明确失败。
3. 模型准入与执行资源清理有公共实现，各领域继续决定预算、授权、审批和检查点。
4. 新执行尝试分清尚未分派、已分派但结果未知、已有完成结果。HTTP/MCP 回执丢失时同次动作后续分派被阻断，动作代码吞掉异常也不能伪报成功。
5. 业务层使用 NEUMA 自有运行契约；Pi SDK、原生会话管理器及文件工具工厂收在适配边界，并有依赖检查防止重新扩散。

“后台继续”要求 NEUMA 后端进程仍在运行。进程重启只恢复查看，继续任务仍遵守原预算、会话绑定、独立评审和显式恢复规则。离线验证不证明真实模型质量或真实业务服务权限。

## M0 基线与所有权

| 调用域 | 持久接受点 | 接受后的取消所有者 | 权威状态与预算 |
| --- | --- | --- | --- |
| 主对话 | MainStore 同次写入用户消息、回复占位及 mutationId | MainAgent 当前执行实例 | 原主对话记录与原需求控制器 |
| 架构构建 / 研发 | AgentOperations 接受回执先写入，再发布当前操作索引并启动原入口 | 后台操作控制器，继续连接原构建/研发取消信号 | 原架构和研发 Store、原角色及阶段预算 |
| 群 | 原 GroupStore 原子提交任务、消息及顺序事件 | 原群后台 worker | 原群任务代次、48 轮总账及批次预留 |
| 应用 / 流程 | 原 ApplicationTaskStore 创建记录；流程原记录保存步骤与尝试 | 原 ApplicationService；heldLease 继续继承父任务信号 | 原应用任务、工作流及共享调度器 |

逻辑模型调用的持久记账与每次 HTTP 尝试检查保持分开；网络重试不重复扣领域逻辑轮次，压缩仍按原角色额度处理。接受回执、查看索引和快照不拥有审批权，不增加工作槽或恢复授权。

制作操作回执与当前索引是两次提交：先保存回执，后保存索引，再启动。中间中断时原 mutationId 仍可查询到中断回执，不自动重新执行。终结回执只保存实际领域记录引用、显示阶段和安全错误；业务能否使用始终由原领域记录决定。

## M1 回放与故障证据

- [session-replay.mts](../test/helpers/session-replay.mts)：带来源/版本的有限脚本和严格消费检查；记录白名单仅输出角色、阶段、工具名与摘要，不复制任意对象、提示词、凭据或思考正文。
- [execution-runtime.test.mts](../test/runtime/execution-runtime.test.mts)：真实 Pi + 本机模型协议回放，覆盖普通回复未提交、参数失败后修正并正式提交。
- [architecture-recorded-failures.test.mts](../test/architecture/architecture-recorded-failures.test.mts)：既有去标识失败模式接入严格回放；不改称完整原始转录。
- [development-session-recovery.test.mts](../test/development/development-session-recovery.test.mts)：保留开发者与独立评审各自恢复、同对象历史及原预算的原有主证明。
- [development-crash-recovery.test.mts](../test/development/development-crash-recovery.test.mts)：真实子进程在预算持久化后、模型请求前，以及正式规划结果保存后、消费前被 SIGKILL；新进程保持已用额度，消费原提案后继续独立评审，不把提案当作已通过计划。
- [workflow-crash-recovery.test.mts](../test/services/workflow-crash-recovery.test.mts)：prepared、dispatched、外部已生效但未保存结果、结果已保存四个真实 SIGKILL 边界。父进程持有外部测试服务并检查实际副作用次数。

真实进程测试使用测试进程内双向 IPC 门控；持久写入完成后暂停，父进程再终止，不靠固定 sleep 猜测。没有生产崩溃开关、生产历史扫描或自动收集。

## M2 / M3 运行接口与公共机制

| 主要文件 | 职责 |
| --- | --- |
| [execution-port.mts](../src/runtime/execution-port.mts) | 自有消息、事件、工具、会话、准入与能力类型；事件名沿用兼容词汇，不从 SDK 联合类型派生 |
| [execution-runtime.mts](../src/runtime/execution-runtime.mts) | 正式 Pi 适配、事件映射、上下文容量；业务对象不包含原生 manager/settings |
| [execution-history.mts](../src/runtime/execution-history.mts)、[pi-session-state.mts](../src/runtime/pi-session-state.mts) | 自有只读历史/来源接口；适配器继续执行原路径、链接、UTF-8、树结构、绑定及摘要校验 |
| [pi-file-tools.mts](../src/runtime/pi-file-tools.mts) | 原生文件工具工厂；所有实际文件操作仍通过原安全工作区实现 |
| [model-admission.mts](../src/runtime/model-admission.mts) | 持久化成功后再次检查取消，再放行请求；不读写领域预算 |
| [execution-lifecycle.mts](../src/runtime/execution-lifecycle.mts) | 幂等释放本次拥有的资源，继续清理其余资源并汇总异常 |
| [hygiene-graph.mts](../scripts/hygiene-graph.mts) | 同时限制业务的 SDK 类型/运行时依赖及原生会话管理器入口 |

主对话、工作 Agent、架构、研发和独立复核已改用自有契约。主对话、架构、研发、私聊当次资源和群执行使用公共清理；长期成功私聊会话仍由原所有者复用。兼容 pi-port 和原始 createPiSession 保留给既有 SDK 层测试/集成；项目助手的既有独立请求语义未扩大为后台操作。

## M4 执行结果核实

[execution-attempt.mts](../src/runtime/execution-attempt.mts) 提供版本化尝试及分类。新字段可嵌入现有领域记录，不批量重写旧历史。

- prepared：屏障尚未放行，才可解释为未执行。
- dispatched：已有分派事实，没有持久完成结果时保守视为未知。
- completed：保存结果引用，恢复消费原结果，不重复执行。
- 旧记录缺字段：按原保守规则处理，不能补写成 prepared。

流程 item 保存 executions 历史；应用动作保存自己的 execution。流程动作及其嵌套连接沿用同一个所有者，HTTP/MCP 仅调用传入的屏障和未知结果回调。外部调用后的超时、断线或结果校验失败会保存 uncertain；后续分派受阻，外层动作返回 passed 也不能覆盖该事实。只有原设计已声明的幂等步骤仍可使用原重试额度。

非幂等流程沿用 needs_review。新记录的人工核实绑定 task/version/step/index/attemptId；确认完成记录核实结果，明确重试保留原尝试和已用次数。旧记录没有 attemptId 时保持原协议。普通应用任务不自动重启，未知结果通过原任务记录保留。

独立证明见 [service-workflows.test.mts](../test/services/service-workflows.test.mts)：真实 HTTP 服务已生效但连接中断，动作代码连续尝试两次并吞掉异常，外部调用仍只发生一次，流程留在待核实。

## M5 / M6 查看协议与页面

- [MainAgent](../src/main/main-agent.mts) 提供 submit / operation / cancel；[AgentOperations](../src/agents/agent-operations.mts) 提供构建与研发的接受、查询和精确停止。
- [operation-view.mts](../src/runtime/operation-view.mts) 返回操作身份、代次与已提交快照游标；游标相同省略正文，变化或过期时 reset 并返回完整快照。
- [operation-view.ts](../public/operation-view.ts) 串行观察、核对身份、取消监听与有限断线重试。前端用快照替换内容，避免重复拼接；主对话重新打开时依据原请求恢复查看，制作页面通过 operationReference 找到后台任务。
- 群和应用有相同快照格式的 view 入口，复用原 Store、事件序号、作用范围及调度；旧 events 接口保持兼容。
- 原主 messages、agents/build、development/stream 等接口继续保留既有语义。默认桌面入口已切换新后台协议；完整路径见 [用户指南](user-guide.md)。

本轮采用持久快照重同步，未增加独立的逐 token 日志。已有定时保存和领域事件是权威来源，因此不需要处理两套“成功状态”一致性。查看接口不会启动任务，重启不会自动恢复模型或外部动作。

## 验证结果

- `npm run typecheck`：通过。
- `npm run check:hygiene`：通过，263 个测试文件完整登记；依赖与源码残留检查通过。
- 最终 `npm test`：3,286 项，3,271 通过，0 失败，15 项因既有浏览器/平台条件跳过，耗时约 418 秒。
- 新增六个真实 SIGKILL 场景：通过。未调用真实模型服务或真实业务账户。
- 桌面内置浏览器：独立临时数据目录、本机合成模型；刷新仍显示同一条运行任务，切到群页后重新打开显示完整结果；第二条显式停止后刷新仍显示部分正文和“已停止”。磁盘保存恰好两条请求，终态分别 complete / cancelled。临时服务及数据已清理。
- 安装包：`npm run package:pack`、`npm run test:package:smoke`、`npm run test:package:install` 均通过。实际 tgz 包含新增后台操作、查看协议和运行模块；解包后在任意工作目录及只读程序目录启动，47 个前端模块、vendor、设置保存、重启与 Ctrl+C 检查通过。独立临时安装使用自身生产依赖，没有复用仓库 node_modules。包保存在 `dist/npm/chrissliu-neuma-0.1.0-preview.2.tgz`，未发布。

### 查看性能基线

命令：构建后运行 `node dist/ts-build/package/test/helpers/runtime-view-benchmark.mjs`。本机 Apple 芯片 Mac / Node 26.3.0，合成合法主对话记录，每组 5 次；测量实际 MainStore 快照复制和 HTTP JSON 序列化，不包含浏览器绘制。

| 正文大小 | 中位耗时 | 最大耗时 | 测量期间 RSS 增量 |
| --- | ---: | ---: | ---: |
| 4 KiB | 0.02 ms | 0.05 ms | 0.36 MiB |
| 1 MiB | 1.00 ms | 1.08 ms | 9.13 MiB |
| 30 MiB | 38.48 ms | 39.45 ms | 210.11 MiB |

该手动基线固定本机回归门槛为中位 1.5 秒、RSS 增量 512 MiB，避免把其他机器的时间差误判成业务错误。浏览器完成普通桌面交互验收，没有声称 30 MiB 内容的浏览器绘制耗时也经过测量。

## 文档与回退

同步 README、ARCHITECTURE、用户指南、研发规范、连接指南、能力说明和原计划完成状态。新协议继续沿用原数据身份、额度与授权；回退时保留接受回执和执行尝试。需要重启的已接受工作只显示中断；新尝试格式必须由能保守识别它的版本读取，不能删除记录来重置结果或预算。
