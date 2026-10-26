> 历史档案，非当前开发指令。2026-10-15 页面主交互与浮窗改造验收记录；代码范围中的 public/*.js 文件现已迁移为 TypeScript。

# Agent 页面主交互与可选助手验收

日期：2026-10-15。实施依据：用户确认的《Agent 页面主交互与 AI 浮窗改造计划》。只做相关模块增量修改，保留工作区已有群聊改动。

## 实现

- 复用 interaction，增加可选 assistant；HTML 下载产物、页面入口、是否需要助手分别判断。旧缺省不回填。
- 宿主使用原私聊控制器，360×64 输入条可展开到400×440，支持拖动、边缘拉伸、键盘、重置、按 Agent 保存几何位置。填充透明度42%、背景模糊22px，文字不透明，页面宽度不受浮窗挤压。
- 上下文由页面显式提供，限制16KiB，按当轮发送冻结并核对Agent/会话/实例/交付；文档重载清空旧快照。任务通知含版本和修订，页面读取真实回执后再次核对。
- 纯页面允许空公开动作，私有node-check读取真实快照与共用逻辑；资源、Node逻辑、公开动作和浏览器证据分开记录。
- 运行按definition.architectureRef读取精确已激活架构；最新候选只用于构建和进度。失败、取消和未完成更新保留旧运行依据，构建期间仍暂停新提交。错误引用/摘要/快照仍拒绝。
- 同一动作重试的幂等比较不包含页面上下文元数据，原任务绑定不重写；输入、版本和来源身份变化仍冲突。
- 未发送输入沿原会话本地备份保存，输入时同步落盘，按Agent和会话恢复；不会进入服务端消息或模型历史。清空、发送和删除均清理对应旧草稿。

## 代码范围

前端：public/agent-runtime.js、agents.js、agent-conversations.js、state.js、application-api.js、application-bridge.js、application-frame-bridge.js、application-tasks.js、application-workspace.js、application-context.js（新增）、application-assistant.js（新增）、index.html、style.css。

需求与架构：src/requirements/core.mjs、providers.mjs；src/architecture/architecture-contract.mjs、architecture-prompts.mjs、architecture.mjs、platform-contract.mjs。保留v1/v2平台快照，新增v3。

运行与应用：src/agents/agent-prototype.mjs、agent-capabilities.mjs；src/applications/application-api.mjs、application-contract.mjs、application-resources.mjs、application-service.mjs、application-context.mjs（新增）、task-store.mjs；src/server.mjs。

研发：src/development/development-contract.mjs、development-executor.mjs、development-prompts.mjs。

回归：新增application-assistant-ui、application-context-ui、application-context、agent-active-runtime、dashboard-application-integration及其fixture；更新需求/架构/研发/应用/会话/运行与UI对应测试及scripts/run-tests.mjs分类。详细文件以当前差异为准；同工作区的其他群聊修改不属于本次范围。

说明：ARCHITECTURE.md、docs/development-layer-design.md及本文。

## 自动化证据

2026-10-15最终全量回归结果：1625项，1620通过、0失败、5项外部浏览器用例按默认配置跳过。日志：/tmp/neuma-page-final-validation-4.log。包含输入草稿刷新修复后的回归。

回归覆盖：需求意图不自动推导助手、旧快照兼容、纯页面检查、上下文大小/结构边界、跨Agent和旧实例/旧版本、重载清空、迟到回执、幂等、失败/取消、活动版本恢复、删除及替换竞态。

## 浏览器证据

使用Codex内置浏览器，桌面1280×720；不启动外部浏览器。

通用经营看板：真实托管iframe、任务和隔离动作执行，配本机模型替身。解释当前指标不创建任务；自然语言切换全年后真实任务完成并更新指标。拖动跨iframe、键盘/角点拉伸、收起、设置开合、刷新几何恢复通过，控制台无警告/错误。截图：../.neuma/verification/glass-dashboard-2026-10-15.jpg。

微积分托管QA：只使用临时数据和明确标记的测试审批占位，未把该占位写入生产。测试模型替身不能证明生产模型回答质量；ApplicationService、草稿存储、任务、OS隔离动作、资源桥和宿主UI为真实实现。六个源码文件与正式冻结快照逐项摘要一致，codeHash为04b34aca9b8b83f356c8f4f5a0f14b63f7d26d0f4e4c0f5b779c78174f08603d。

已验证：上下文准确解释导数/x²/x0=1/h=0.5；动作改变x0=2后割线斜率4.5；刷新产生新origin/实例并恢复参数；切换积分得到n=20、有向中点和2.665；新建聊天保留页面实例和积分状态。浮窗移动、400×440→500×519拉伸、设置隐藏/恢复、刷新恢复尺寸均通过。输入“刷新后仍保留的学习问题”立即整页重载，原输入草稿和学习参数同时恢复。证据和真实回执：../.neuma/verification/calculus-hosted-browser-evidence-2026-10-15.json；截图：../.neuma/verification/calculus-hosted-qa-2026-10-15.png。

IAB对跨来源iframe的部分点击/键盘操作返回目标不可用，因此未将其记为通过；托管状态改变通过真实宿主聊天→动作→任务回执链路验收。相同源码的独立页面另外验证了本地公式/数字/滑块、三类图形、无效公式保留原图、负小数输入及未改参数不漂移。

## 生产微积分升级

稳定ID：90ce76f0-e624-4542-9c73-fedf5957e1b4。架构v13、研发计划、任务代码及整体验收均通过真实独立评估；冻结源码12/12隔离验收通过，运行检查后正式激活revision2，研发状态completed、交付ready。前次代码评审对数值及整对象断言作了与原始报告不符的判断；后续提供完整原始报告、源码与绑定同一摘要的独立浏览器证据复核，保留历史评审，不伪造或改写通过状态。

真实配置模型在原Agent上正确解释了x²、x0=1、h=0.5、割线斜率2.5和切线斜率约2；随后真实调用change_demo将x0改为2，保留其他参数，托管页面显示割线斜率4.5与切线估计约4。正常服务重启后新页面实例恢复x0=2/h=0.5。桌面1280×720验收，控制台无警告/错误；没有增加竖屏或窄屏适配。最终证据：../.neuma/verification/calculus-production-evidence-2026-10-15.json；截图：../.neuma/verification/calculus-page-final-2026-10-15.png。

保留核对：升级前原会话文件和原HTML逐字节一致，稳定ID、记忆和资料未变。核对报告：../.neuma/verification/calculus-preservation-2026-10-15.json。备份位于.neuma/backups/，新版本仅通过正式控制器激活。

记录整理：首次真实模型讲解验收误追加到原会话。核对原消息前缀和本轮两条验收消息后，将验收消息归入独立会话ea67a1d6-feae-4f03-aea0-111aff9454af，从升级前备份逐字恢复原会话文件；操作前两份记录另外备份。最终核对及浏览器历史列表均确认原“你好”会话内容和时间保留。
