# NEUMA 节点流程与字段说明

- 核对日期：2026-10-25；源码基线：主仓库 `6570f2b`。本文按当前源码契约整理：**每个节点收到什么、输出什么（最全形态），每个字段后附一个具体示例值**。
- 全文示例统一使用同一个贯穿场景——**客户合同审查助手**（custom 路径，3 个模块、托管服务 + 页面 + 动作），这样各节点的示例值前后衔接，可以当一条完整数据流读下来。
- 字段名与源码逐字一致（括注定义位置）；示例值仅为示意，哈希统一用 `9f86d081…0a08`（64 位 sha256），时间统一用 `2026-10-25T09:30:00.000Z`。行为规范以 [ARCHITECTURE.md](../ARCHITECTURE.md) 与源码为准。

## 一、总览：节点数量与主流程

主链路共 **6 个主节点**；"架构设计"内部含 4 个子节点（蓝图、模块×最多 3、整合、程序组装），"研发"内部含 5 个阶段节点，细分共 **13 类节点**。

```
用户消息
 → ① 需求澄清与确认        出：RequirementDraft + TaskSpecV1 + 确认回执
 → ② 架构设计（三阶段+组装） 出：ArchitectureBlueprint → ArchitectureModule → {baseHash,updates} → CandidateDraft
 → ③ 独立评审              出：ArchitectureReview（verdict 决定 status/delivery）
 → ④ 研发五阶段            出：DevelopmentPlan → 代码快照 → DevelopmentEvidence + AcceptanceLedger → DevelopmentPackage
 → ⑤ 激活                  出：AgentDefinition（mode=designed）+ ActivationTransaction
 → ⑥ 运行交付              出：ApplicationTask（result + artifacts）+ activeRuntime
```

分流：`light` 评审通过后直接生成执行定义（跳过④⑤研发部分）；`workflow`/`custom` 必须研发；旧 v1 定义按 `node-json` 兼容。

---

## 二、节点 1：需求澄清与确认（`src/requirements/`）

> 收：用户消息 + 材料 + 每轮服务端评估 → 出：需求草稿 `RequirementDraft` + 任务规格 `TaskSpecV1` + 确认回执 `RequirementReceipt`。持久化：`.neuma/agents/<id>/requirements.json`。流向：确认后把 `draft` + `requirements[]` + `deferredVerifications` 交给架构层。

### 1.1 输入（最全形态）

| 字段 | 类型 | 含义 | 示例 |
| --- | --- | --- | --- |
| `message` | string（≤12000 字符） | 用户当前消息正文 | `"帮我做一个合同审查助手，每次上传合同 PDF，提取关键条款并输出风险清单"` |
| `attachments[]` | 材料引用（≤10 项） | 本条消息引用的上传材料 ID | `["mat-8f3a2b"]` |
| `history` | 对话历史 | 此前澄清轮次（服务端保存，不重算） | 上一轮追问"每次大约处理多少份合同？" |
| `assessment` | `PreflightAssessment`（服务端生成） | 本轮交付前评估，见 1.2 输出表 | `verdict:"sufficient"` |
| `systemChecks[]` | `SystemCheck` | 平台可信只读检查结果（平台事实，不交给用户回答） | `{ id:"chk-pdf", status:"passed", message:"PDF 渲染可用", evidence:[…] }` |

### 1.2 输出（最全形态）

需求草稿 `RequirementDraft`（`src/contracts/requirements.d.mts:6`）。九个核心字段均为 `RequirementField = { value, source }`，`source` 取 `user`（用户说明）/ `inferred`（推导）/ `default`（缺省）/ `unknown`（未知）：

| 字段 | 界面含义 | 示例（取 value，source 略） |
| --- | --- | --- |
| `name` | Agent 名称 | `"合同审查助手"`（source:`"user"`） |
| `agentType` | 初步类型 | `"document_analyst"` |
| `goal` | 核心目标 | `"自动识别合同中的风险条款并输出结构化风险清单"` |
| `scenario` | 使用场景 | `"法务每周批量审查供应商合同"` |
| `inputSource` | 每次输入 | `"每次上传 1–20 份 PDF 合同，单份 ≤20 MiB"` |
| `task` | 核心任务与处理方式 | `"解析 PDF 文本，定位违约、赔偿、保密条款并分级"` |
| `deliverable` | 输出结果 | `"每份合同一份风险清单页面，可导出报告"` |
| `successCriteria` | 完成标准 | `"关键条款召回率经抽样核对不低于 95%"` |
| `routingCondition` | 建议调用场景 | `"用户上传合同并要求审查时调用"` |
| `constraints[]` | 工作限制 | `[{ text:"不得外传合同内容", source:"user" }]` |
| `usage` | 使用方式 | `{ mode:"on_demand", detail:"法务按需上传", source:"user" }` |
| `externalAction` | 对外动作 | `{ mode:"none", operation:"", target:"", scope:"", trigger:"", source:"user" }` |
| `interaction` | 交互形态 | `{ defaultEntry:"application", page:true, operations:["导出报告"], inputs:"合同 PDF", results:"风险清单", persistentData:"审查历史", assistant:{ enabled:false, purpose:"" } }` |
| `connections[]` | 外部连接 | `[]`（本例无外部连接） |
| `capabilityDependencies[]` | 能力依赖 | `["pdf-render"]` |
| `unresolved[]` | 未明确点 | `["报告是否需要 Word 格式"]` |
| `conflict` | 需求冲突 | `null` |
| `taskSpec` | 任务规格 | 见下表 |

任务规格 `TaskSpecV1`（`src/contracts/versions.d.mts:11`）：

| 字段 | 类型 | 含义 | 示例 |
| --- | --- | --- | --- |
| `version` | `1` | 结构版本 | `1` |
| `items[].id` | string | 稳定条目编号 | `"req-001"` |
| `items[].dimension` | 六维度枚举 | 输入规模 `input_scale` / 处理要求 `processing` / 交付标准 `delivery` / 工作过程 `workflow` / 数据生命周期 `data_lifecycle` / 外部条件 `external_conditions` | `"input_scale"` |
| `items[].content` | string（≤25112 字符） | 需求正文 | `"单次最多 20 份合同，单份 PDF ≤20 MiB"` |
| `items[].applicability` | 枚举 | 适用性 | `"applies"` |
| `items[].critical` | boolean | 关键程度（关键项不可静默删除/降级） | `true` |
| `items[].source.kind` | 枚举 | 来源：`user` 用户说明 / `accepted` 接受建议 / `measured` 实际测量 / `inferred` 直接推导 / `unknown` 未知 | `"user"` |
| `items[].source.evidence[]` | `{messageId,quote}` | 原文证据（服务端消息 ID + 逐字摘录） | `[{ messageId:"msg-1024", quote:"每次上传合同 PDF" }]` |
| `items[].source.reason` | string? | 推导理由（inferred 时） | `"由 20 MiB 上传上限推导"` |
| `retired[]` | `{id,reason,evidence}` | 撤回记录 | `[{ id:"req-007", reason:"用户改口不需要 Word", evidence:[…] }]` |

确认与评估输出：

| 字段 | 类型 | 含义 | 示例 |
| --- | --- | --- | --- |
| `RequirementReceipt.version` | `1` | 回执版本 | `1` |
| `RequirementReceipt.requestId` | string | 确认请求编号 | `"req-9c41"` |
| `RequirementReceipt.requirementHash` / `platformHash` / `draftHash` | sha256 | 需求/平台/草稿绑定哈希 | `"9f86d081…0a08"` |
| `RequirementReceipt.assessmentId` / `confirmedAt` | string | 评估 ID / 确认时间 | `"asm-31"` / `"2026-10-25T09:30:00.000Z"` |
| `RequirementState.confirmed` | boolean | 是否已确认 | `true` |
| `RequirementState.question` / `lastQuestion` / `confirmationQuestion` | string \| null | 当前追问 / 上一追问 / 确认提问 | `null` / `"报告需要 Word 格式吗？"` / `"需求已完整，确认开始制作？"` |
| `PreflightAssessment.verdict` | 枚举 | `sufficient` / `needs_input` / `blocked` | `"sufficient"` |
| `PreflightAssessment.dimensionChecks[]` | 数组 | 每维度 `sufficient/not_applicable/unknown` | `[{ dimension:"input_scale", status:"sufficient", reason:"用户给出上限", requirementIds:["req-001"] }]` |
| `RequirementIssue.owner` | 枚举 | 问题归属：`user` 用户选择 / `system` 系统核实 / `runtime` 运行时检查 | `"user"` |
| `RequirementIssue.blocking` | boolean | 阻断性（阻断则不能创建） | `false` |

---

## 三、节点 2：架构设计（v3 阶段化管线，`src/architecture/`）

> 收：确认后的需求 + 平台快照 → 出：完整候选 `CandidateDraft`。持久化：`architecture.json` 的 `designProgressCheckpoint`。管线级状态 `DesignCheckpoint` 字段：`schemaVersion`（新建为 `3`）、`pipelineId`（UUID）、`bindingHash`/`schemaHash`（冻结输入与契约哈希，不符即作废）、`modelCalls`（≤25）、`revisionHash`、`assignmentHash`、`blueprint`/`modules[]`/`integration`（各节点状态）、`hash`（封印）、`repair?`（用户授权的 2 轮局部修复）。每节点状态 `DesignStageState`：`key`、`modelCalls`（≤5）、`sessionStartCalls`、`generation`、`sessionRef:{file}`、`result`、`resultHash`、`completedBy?`。

### 2.1 子节点：蓝图（blueprint）

**输入（最全形态）**：

| 字段 | 类型 | 含义 | 示例 |
| --- | --- | --- | --- |
| `requirements[]` | `{id,text}` | 已确认正式需求 | `[{ id:"req-001", text:"单次最多 20 份合同…" }]` |
| `draft.taskSpec` | `TaskSpecV1` | 任务规格 | 见节点 1 |
| `platformSnapshot` | 平台快照 v4 | 公共工具、能力目录、验收适配器指南 | `platformHash:"9f86d081…0a08"` |
| `designModelBudget` | `{limit,used,remaining,stageLimit}` | 预算事实提示 | `{ limit:25, used:0, remaining:25, stageLimit:5 }` |
| `blueprintProtocol` / `pipelineStage` | 标识 | 协议与阶段标识 | `"module-boundaries-v2"` / `"blueprint"` |

**输出（最全形态）** `ArchitectureBlueprint`（`src/contracts/architecture-stages.d.mts:8`）：

| 字段 | 类型 | 含义 | 示例 |
| --- | --- | --- | --- |
| `global.profile` | 枚举 | `light` / `workflow` / `custom` | `"custom"` |
| `global.rationale` | string ≤4000 | 方案理由 | `"需要 PDF 解析、条款分析与页面交付，属定制路径"` |
| `global.instructions` | string | 全局指令 | `"你是合同审查助手，输出分级风险清单"` |
| `global.state.mode` | 枚举 | `none` / `task` / `persistent` | `"task"` |
| `global.schemaVersion` | `3` | 候选契约版本 | `3` |
| `global.interaction` | 对象 | 交互交付 | `{ defaultEntry:"application", page:true, operations:true, inputs:"合同 PDF", results:"风险清单", persistentData:"审查历史" }` |
| `global.execution` | 对象 | 语言与托管 | `{ language:"javascript", hosting:"managed", reason:"需要常驻解析与页面服务" }` |
| `global.selectionBasis` | 对象 | 选型依据 | `{ capacity:"单文件 20 MiB", process:"解析→分析→组装", quality:"条款分级输出", requirementIds:["req-001"], assumptions:["PDF 为文本型"] }` |
| `global.connections[]` | `ConnectionDefinition` | 连接定义（本例无） | `[]` |
| `modules[].id` | string | 模块编号 | `"contract-ingest"` |
| `modules[].purpose` | string ≤2000 | 模块职责 | `"读取并解析合同 PDF，输出结构化条款文本"` |
| `modules[].requirementIds[]` | string[] | 主责需求（全模块合计与需求清单不重不漏） | `["req-001","req-002"]` |
| `modules[].dependsOn[]` | string[] | 依赖模块 | `[]`（clause-analysis 例：`["contract-ingest"]`） |
| `modules[].inputs` / `outputs` | string ≤2000 | 输入/输出边界 | `"已上传的材料 ID 列表"` / `"逐份合同的条款文本 JSON"` |

本例三个模块：`contract-ingest`（解析）、`clause-analysis`（风险分析，依赖 ingest）、`report-compose`（报告组装，依赖两者）。

### 2.2 子节点：模块设计（module，×1–3）

**输入（最全形态）**（payload，`architecture-design-pipeline.mts:479-487`）：

| 字段 | 类型 | 含义 | 示例 |
| --- | --- | --- | --- |
| `assignment` | `BlueprintAssignment` | 本模块分工 | `clause-analysis` 分工行 |
| `blueprint` / `blueprintHash` | 蓝图及其哈希 | 冻结蓝图 | `blueprintHash:"9f86d081…0a08"` |
| `dependencyInterfaces[]` | `{moduleId,components,steps}` | 仅直接依赖模块的接口摘要 | `[{ moduleId:"contract-ingest", components:[…], steps:[{id,componentId,input,output,completion}] }]` |
| `requirements[]` | `{id,text}` | 过滤后的正式需求 | 本模块主责两条 |
| `designModelBudget` / `pipelineStage` | 共享字段 | 预算与阶段 | `stageLimit:5` / `"module:clause-analysis"` |

**输出（最全形态）** `ArchitectureModule`（`architecture-stages.d.mts:9`）：

| 字段 | 类型 | 含义 | 示例 |
| --- | --- | --- | --- |
| `moduleId` | string | 等于分工 id | `"clause-analysis"` |
| `blueprintHash` | sha256 | 绑定蓝图 | `"9f86d081…0a08"` |
| `instructions` | string ≤3000 | 模块补充指令 | `"按违约/赔偿/保密三类输出 {clause,risk,level}"` |
| `components[].id/purpose/necessity/inputs/outputs` | 组件 | 内部组件 | `{ id:"risk-classifier", purpose:"条款风险分级", necessity:"分级是交付标准", inputs:"条款文本", outputs:"{level:'高|中|低'}" }` |
| `steps[].id` | string | 步骤编号（局部唯一） | `"step-score"` |
| `steps[].componentId` | `StageReference` | 所属组件（跨模块用 `{moduleId,id}`） | `"risk-classifier"` 或 `{ moduleId:"contract-ingest", id:"step-parse" }` |
| `steps[].input` / `output` / `completion` | string | 步骤输入/输出/完成判据 | `"条款文本数组"` / `"分级结果数组"` / `"每条条款均有 level"` |
| `steps[].dependsOn[]` | `StageReference[]` | 步骤依赖（无环） | `[{ moduleId:"contract-ingest", id:"step-parse" }]` |
| `capabilities[].id/status/reason` | 能力声明 | status：`available`/`needs_connection`/`needs_development`/`unverified` | `{ id:"pdf-render", status:"available", reason:"平台公共材料工具已具备" }` |
| `failureHandling[].scenario/response` | 失败处理 | `{ scenario:"扫描件无文本层", response:"标记需 OCR，不入风险统计" }` | — |
| `decisions[].*` | 决策 | `{ id:"dec-01", problem:"分级规则", choice:"三级", alternatives:[{option:"五级",reason:"过细"}], reason:"用户只要高/中/低", evidenceIds:["ev-01"], uncertainties:[] }` | — |
| `coverage[].requirementId/componentIds/verification` | 需求覆盖 | 与分工 requirementIds 相等 | `{ requirementId:"req-003", componentIds:["risk-classifier"], verification:"对照冻结用例核对分级输出" }` |
| `acceptance[].*` | 验收场景 | `{ id:"acc-01", kind:"success", requirementIds:["req-003"], input:"含违约条款的样例合同", expected:"输出 level=高 的风险项", verification:{ stage:"development", owner:"generated-code", adapterId:"action" } }`；kind 另有 `missing_input`/`boundary`/`tool_failure` | — |
| `unknowns[].question/blocking/resolution` | 未知项 | `{ question:"扫描件占比未知", blocking:false, resolution:"运行期统计" }` | — |
| `platformClaims[]` | 平台声明 | 关联平台事实字段 | `[{ id:"claim-01", source:"runtimeCapabilities", path:"/tools/pdfRender", expected:true, decisionIds:["dec-01"], acceptanceIds:["acc-01"] }]` |

### 2.3 子节点：整合（integration）

**输入（最全形态）**：

| 字段 | 类型 | 含义 | 示例 |
| --- | --- | --- | --- |
| `baseCandidate` | `CandidateDraft` | 程序组装出的候选 | 见 2.4 输出 |
| `baseHash` | sha256 | 组装候选哈希 | `"9f86d081…0a08"` |
| `conflicts[]` | `{path,reason,relatedPaths,moduleIds}` | 跨模块冲突清单 | `[{ path:"/instructions", reason:"两模块指令重叠", relatedPaths:[], moduleIds:["contract-ingest","clause-analysis"] }]` |
| `integrationPolicy` | `{allowedRoots,frozenRoots,instruction}` | 允许/冻结的修改根字段 | `allowedRoots:["instructions","failureHandling",…]` |

**输出（最全形态）**：

| 字段 | 类型 | 含义 | 示例 |
| --- | --- | --- | --- |
| `baseHash` | sha256 | 必须与当前组装候选一致 | `"9f86d081…0a08"` |
| `updates[].path` | JSON Pointer（0–24 项） | 只能指向已存在字段，根字段限于派生字段或冲突许可路径 | `"/instructions"` |
| `updates[].value` | 任意 JSON | 替换值 | `"合并后的总指令：解析→分级→组装报告"` |

### 2.4 子节点：程序组装（宿主执行，非模型节点）

**输入**：`blueprint` + 全部已校验 `modules[]`（跨模块重名编号分配稳定全局编号）。

**输出（最全形态）** `CandidateDraft`（`architecture-stages.d.mts:6`）：

| 字段 | 类型 | 含义 | 示例 |
| --- | --- | --- | --- |
| `schemaVersion` | `2 \| 3` | 契约版本（含 taskSpec 必须 3） | `3` |
| `profile` | 枚举 | 执行形态 | `"custom"` |
| `rationale` | string ≤4000 | 方案理由 | 同蓝图 global |
| `instructions` | string ≤12000 | 总指令（global + 各模块拼接） | `"你是合同审查助手…\n按违约/赔偿/保密三级…"` |
| `components[]` | 组件（全模块合并、全局编号） | `{ id:"m2-risk-classifier", purpose:…, necessity:…, inputs:…, outputs:… }` | — |
| `steps[]` | 步骤（依赖无环、组件全覆盖） | `{ id:"m2-step-score", componentId:"m2-risk-classifier", dependsOn:["m1-step-parse"], input:…, output:…, completion:… }` | — |
| `capabilities[]` | 能力 | 最终路径实际依赖 | `[{ id:"pdf-render", status:"available", reason:"…" }]` |
| `state` | 状态模式 | `{ mode:"task", reason:"每次任务独立" }` | — |
| `failureHandling[]` | 失败处理 | `{ scenario:"扫描件无文本层", response:"标记需 OCR" }` | — |
| `decisions[]` | 决策 | 各模块 decisions 合并，evidenceIds 引用记录层证据 | — |
| `coverage[]` | 需求覆盖 | 覆盖全部正式需求 | `{ requirementId:"req-003", componentIds:["m2-risk-classifier"], verification:… }` |
| `acceptance[]` | ≥3 项验收 | 必含 success/missing_input/boundary，用工具另含 tool_failure | `[{ id:"acc-01", kind:"success",… },{ id:"acc-02", kind:"missing_input",… },{ id:"acc-03", kind:"boundary",… },{ id:"acc-04", kind:"tool_failure",… }]` |
| `unknowns[]` | 未知项 | `{ question:"扫描件占比", blocking:false, resolution:"运行期统计" }` | — |
| `interaction` | 交互交付 | `{ defaultEntry:"application", page:true, operations:true, inputs:…, results:…, persistentData:…, assistant:{enabled:false,purpose:""} }` | — |
| `connections[]` | 连接（0–40） | 本例为空 | `[]` |
| `execution` | 执行选择 | `{ language:"javascript", hosting:"managed", reason:"…" }` | — |
| `selectionBasis` | 选型依据 | `{ capacity:…, process:…, quality:…, requirementIds:[…], assumptions:[…] }` | — |
| `platformClaims[]` | 平台声明 | expected 与公开平台材料逐字相同 | `[{ id:"claim-01", source:"runtimeCapabilities", path:"/tools/pdfRender", expected:true, … }]` |

---

## 四、节点 3：独立评审（评估者角色）

> 收：完整候选 + 需求 + 证据目录 + 平台快照 → 出：`ArchitectureReview`；宿主另核候选/平台 SHA-256。持久化：`architecture.json`（`review`、`attempts[]`）。流向：pass → `status:"passed"`；revise/insufficient/infeasible/needs_input → 对应状态并走修订或返需。

### 输入（最全形态）

| 字段 | 类型 | 含义 | 示例 |
| --- | --- | --- | --- |
| `candidate` | `CandidateDraft` | 被评审候选 | 见 2.4 |
| `requirements[]` | `{id,text}` | 正式需求清单 | `[{ id:"req-001", … }]` |
| `evidence[]` | `EvidenceItem` | 证据目录（decisions 引用） | `[{ id:"ev-01", … }]` |
| `platformSnapshot` | 平台快照 v4 | 能力目录与适配器指南 | `platformHash:"9f86d081…0a08"` |
| `acceptanceAdapterGuide` | 指南 | 九类适配器能力边界 | — |

### 输出（最全形态）`ArchitectureReview`（schema `architecture-contract.mts:181-201`）

| 字段 | 类型 | 含义 | 示例 |
| --- | --- | --- | --- |
| `candidateHash` | sha256 | 被评候选哈希 | `"9f86d081…0a08"` |
| `verdict` | 枚举 | `pass` / `revise` / `insufficient` / `infeasible` / `needs_input` | `"pass"` |
| `checks[].id` | 六/八项 | 基础六项 `requirements`、`feasibility`、`minimality`、`interfaces`、`failure_handling`、`verification`；v3 另加 `requirement_sufficiency`、`acceptance_quality` | `"requirements"` |
| `checks[].passed` | boolean | 该项是否通过 | `true` |
| `checks[].evidence` | string ≤4000 | 判断依据 | `"req-001~006 均有 coverage 行"` |
| `issues[].id/blocking/description/remedy` | 问题 | `{ id:"iss-01", blocking:false, description:"unknowns 未给占比来源", remedy:"运行期统计即可" }` | — |
| `issues[].checkId/kind/candidatePaths/references/factClaims` | 证据属性 | kind：`design`/`platform`/`context`；candidatePaths 为 JSON Pointer | `candidatePaths:["/unknowns/0"]` |
| `summary` | string ≤4000 | 结论摘要 | `"方案可行、最小，验收可区分质量"` |
| `acceptanceScopeChecks[]` | 每项验收一行 | `{ acceptanceId:"acc-01", adapterId:"action", scope:"动作执行断言", sufficient:true, reason:…, criterionQuote:…, adapterQuote:… }` | — |
| `priorFindingDecisions[]` | 历史问题处置 | `{ findingId:"f-07", status:"resolved", reason:…, checkIds:[…], candidatePaths:[…] }` | — |

记录状态流转（`architecture.json`）：`status`：`designing`→`evaluating`→`passed` / `needs_changes` / `needs_evidence` / `infeasible` / `needs_input` / `failed` / `cancelled` / `pending`；`delivery`：`blocked`→`ready` / `needs_connection` / `needs_development`。本例通过后 `delivery:"needs_development"`（custom 需研发）。

---

## 五、节点 4：研发（五阶段，`src/development/`）

> 收：已通过架构 → 出：交付包 `DevelopmentPackage`。持久化：`.neuma/agents/<id>/development/`（`records/`、`workspaces/<runId>/code|planning/`、`snapshots/`、`sessions/`）。研发记录 `DevelopmentRunRecord`（`development-controller-types.mts:41-56`）关键字段：`id`（runId）、`agentId`、`version`、`revision`、`architectureRef:{version,candidateHash}`、`status`（`running`/`interrupted`/`blocked`/`completed`/`failed`/`cancelled`）、`phase`、`delivery`、`budgets:{corrections,planRevisions,integrationRepairs}`、`planning.turns`（≤12）、`tasks[]`、`plan/planHash`、`reviews[]`、`reports[]`、`handoffs[]`、`snapshot/verifiedSnapshot`、`package/deliveries[]`、`acceptanceLedger`、`sessions`。

### 4.1 阶段节点：intake 接收设计

**输入（最全形态）** `PassedDevelopmentArchitecture`：`agentId:"agent-7c9e"`、`version:3`、`candidateHash:"9f86d081…0a08"`、`requirements:[…]`、`design`（含 `execution:{language:"javascript",hosting:"managed"}`、`acceptance:[…]`）、`deferredVerifications`（需求阶段保留义务）、平台快照。
**输出**：status=`"running"`、phase=`"intake"` 的研发记录 + 独立工作区 `workspaces/<runId>/`。

### 4.2 阶段节点：planning 规划

**输入**：冻结架构 + 正式需求 +（可选）历史规划失败参考。
**输出（最全形态）** `DevelopmentPlan`（`src/contracts/development.d.mts:33`）：

| 字段 | 类型 | 含义 | 示例 |
| --- | --- | --- | --- |
| `schemaVersion` | `2 \| 3` | 计划版本（旧 v1 无此字段，runtime 固定 `node-json`） | `3` |
| `runtime` | 枚举 | `node-json` / `node-action` / `managed-service` | `"managed-service"` |
| `summary` | string | 计划摘要 | `"三个任务：解析、分析、报告"` |
| `entrypoint` | string | 入口 | `"src/main.js"` |
| `tasks[].id/title/description` | 任务 | 编号/标题/描述 | `{ id:"task-2", title:"条款风险分析", description:"实现分级器" }` |
| `tasks[].requirementIds[]` / `acceptanceIds[]` | 引用 | 覆盖需求 / 验收项 | `["req-003"]` / `["acc-01"]` |
| `tasks[].dependsOn[]` / `files[]` | 依赖/文件 | 前置任务 / 涉及文件 | `["task-1"]` / `["src/classify.js"]` |
| `cases[].id` | string | 全局唯一用例编号（研发+激活共 ≤200） | `"case-cls-001"` |
| `cases[].taskId/acceptanceId` | 引用 | 所属任务/验收项 | `"task-2"` / `"acc-01"` |
| `cases[].kind` | 枚举 | `action`（真实动作）/ `node-check`（只读检查）/ `input-rejection`（输入拒绝） | `"action"` |
| `cases[].input` | `TestJson` | JSON 字符串或 `{fixture:FixtureNode}` 声明式夹具 | `{ fixture:{ op:"object", fields:{ contractId:{op:"index",start:1,step:1,prefix:"CT-"}, clauses:{op:"array",items:[{op:"value",value:"乙方逾期每日千分之五违约金"}]} } } }` |
| `cases[].assertions[]` | `{path,expectedJson}` | 输出断言 | `[{ path:"/risks/0/level", expectedJson:"\"高\"" }]` |
| `cases[].actionId` / `entrypoint` / `inputTarget` | 定位 | 动作 / node-check 入口 / 拒绝目标（`action-value`/`task-envelope`） | `"analyze_contract"` |
| `cases[].mocks[]` | 能力替身 | `{capability,argsJson,resultJson}` | `[{ capability:"pdf-render", argsJson:"{}", resultJson:"\"文本已提取\"" }]` |
| `cases[].materialChecks[]` | 材料度量 | `{source:"input",pointer,measure,expected}` | `[{ source:"input", pointer:"/files/0", measure:"utf8-bytes", expected:2048 }]` |
| `activationChecks[]` | 启用前检查 | `{acceptanceId,executionScope:"isolated"\|"shared",caseIds[]}` | `[{ acceptanceId:"acc-host-01", executionScope:"isolated", caseIds:["case-act-001"] }]` |
| `activationCases[]` | 启用前专用用例 | 绑定 host-business 验收，不计研发覆盖 | `[{ id:"case-act-001", acceptanceId:"acc-host-01", input:…, assertions:… }]` |
| `application` | `DevelopmentApplication` | 应用清单（见节点 6） | `{ protocolVersion:3, runtime:"managed-service", entrypoint:"src/main.js", page:{…}, actions:[…], stateVersion:1, evidenceIds:["ev-01"], service:{…} }` |

规划材料目录（v2/v3）：`index.json`（`PlanIndex:{caseFiles:["cases-batch-1.json"],activationCaseFiles:["activation-batch-1.json"]}`）+ 用例批次文件；冻结快照 `PlanningSnapshot:{agentId,runId,path,hash,files[],indexPath}`。计划经独立评审 `DevelopmentReview`：`{subjectHash:"9f86d081…0a08", verdict:"pass", summary:"覆盖完整", issues:[{id,blocking,kind:"plan",description,remedy}]}`（verdict：`pass`/`revise`/`blocked`；issue kind：`code`/`plan`/`architecture`/`environment`）。

### 4.3 阶段节点：implementing 开发（每任务一个会话）

**输入**：当前任务（按依赖选择）+ 精确文件授权 + 上游交接。
**输出（最全形态）**：

| 字段 | 类型 | 含义 | 示例 |
| --- | --- | --- | --- |
| `TaskProgress.status` | string | 任务状态 | `"passed"` |
| `TaskProgress.attempts/repairs/turns` | int | 尝试/修复次数/已用回合（≤40） | `1` / `0` / `6` |
| `TaskProgress.taskHash` / `verifiedCodeHash` | sha256 | 任务/已验证代码哈希 | `"9f86d081…0a08"` |
| `TaskProgress.nextAction` / `summary` | string | 下一步 / 摘要 | `"等待验收"` / `"分级器已实现并自测"` |
| `handoffs[].summary/changedFiles/knownIssues/nextAction/continue` | `DevelopmentWork` 交接（`development.d.mts:39`） | 给下一任务的接口与未决问题 | `{ summary:"分级器完成", changedFiles:["src/classify.js"], knownIssues:["长合同截断待观察"], nextAction:"接入报告组装", continue:true }` |
| `snapshot` | `DevelopmentSnapshot` | 代码快照 files 清单 | `[{ path:"src/classify.js", hash:"9f86d081…0a08", … }]` |

### 4.4 阶段节点：verifying 验收

**输入**：固定代码快照 + 冻结用例（任务回归；全部完成后整体验收）。
**输出（最全形态）**：

| 字段 | 类型 | 含义 | 示例 |
| --- | --- | --- | --- |
| `DevelopmentEvidence.id/status` | 报告 | 报告 ID / 状态 | `"rpt-12"` / `"passed"` |
| `DevelopmentEvidence.codeHash/planHash` | sha256 | 绑定代码与计划 | `"9f86d081…0a08"` |
| `DevelopmentEvidence.results[]` | 用例结果 | `{caseId,status,…}`，status：`passed`/`failed`/`not_run`/`error` | `[{ caseId:"case-cls-001", status:"passed" }]` |
| `AcceptanceLedger.binding` | 五方绑定 | `{agentId,architectureVersion,architectureHash,requirementsHash,planHash,codeHash}` | `architectureVersion:3, codeHash:"9f86d081…0a08"` |
| `AcceptanceLedger.status` | 枚举 | `passed`/`failed`/`not_run`/`error` | `"passed"` |
| `AcceptanceLedger.items[].acceptanceId/requirementIds` | 引用 | 架构验收项 | `"acc-01"` / `["req-003"]` |
| `items[].verification` | 对象 | `{stage:"development"\|"activation"\|"runtime", owner:"generated-code"\|"platform"\|"conversation", adapterId}` | `{ stage:"development", owner:"generated-code", adapterId:"action" }` |
| `items[].adapterId` | 九类适配器 | `action`/`input-contract`/`page-resources`/`host-files`/`host-runtime`/`host-business`/`host-gateway`/`delivery-review`/`conversation` | `"host-business"`（激活期真实业务） |
| `items[].status/evidence` | 状态与证据 | `{kind,bindingHash,reportId,caseIds,…}` | `evidence:{ kind:"development-report", reportId:"rpt-12", caseIds:["case-cls-001"] }` |

### 4.5 阶段节点：packaging 打包

**输入**：`verifiedSnapshot` + `AcceptanceLedger` + 应用清单。
**输出（最全形态）** `DevelopmentPackage`（`development-controller-types.mts:36`）：

| 字段 | 类型 | 含义 | 示例 |
| --- | --- | --- | --- |
| `id` / `buildId` | string | 交付包 / 构建 ID | `"pkg-31"` / `"bld-77"` |
| `architectureRef` | 引用 | `{version:3, candidateHash:"9f86d081…0a08"}` | — |
| `codeHash` / `planHash` | sha256 | 代码 / 计划哈希 | `"9f86d081…0a08"` |
| `entrypoint` / `runtime` | 执行入口/协议 | `"src/main.js"` / `"managed-service"` | — |
| `snapshot` | 快照 | 交付代码快照 | `files:[…]` |
| `application` | `ApplicationManifest` | 应用清单（见节点 6） | — |
| `verificationId` | string | 验收报告引用 | `"rpt-15"` |
| `acceptanceLedger` | 台账 | 随包冻结 | 见 4.4 |
| `deliveries[].status/failureReportId` | 交付历史 | 状态 / 失败报告 | `"delivered"` / 无 |

---

## 六、节点 5：激活（运行层核验切换）

> 收：交付包 + 激活检查证据（含 `host-business` 真实执行）→ 出：`AgentDefinition`（mode=designed）。持久化：`definition.json`。缺证据或失败阻止激活；回退与架构可用状态共同撤销。

### 输入（最全形态）

| 字段 | 类型 | 含义 | 示例 |
| --- | --- | --- | --- |
| `package` | `DevelopmentPackage` | 待激活交付包 | 见 4.5 |
| `activationChecks[]` | 冻结检查 | 引用研发/专用用例 | `[{ acceptanceId:"acc-host-01", caseIds:["case-act-001"] }]` |
| `activationEvidence` | 证据 | 真实隔离环境执行结果（非替身） | `{ kind:"host-integration", caseIds:["case-act-001"], status:"passed" }` |

### 输出（最全形态）`AgentDefinition`（`src/agents/prototype-port.mts:18`）

| 字段 | 类型 | 含义 | 示例 |
| --- | --- | --- | --- |
| `id` / `name` | string | 稳定 Agent ID / 名称 | `"agent-7c9e"` / `"合同审查助手"` |
| `profile` | 对象 | 展示资料（不触发重建） | `{ name:"合同审查助手", description:"审查合同风险", icon:"📄" }` |
| `draft` / `fingerprint` | 草稿/指纹 | 原始需求 | 见节点 1 |
| `instructions` / `memory?` | string | 总指令 / 记忆 | 候选 instructions |
| `revision` | int | 定义修订号 | `4` |
| `mode` | string | `designed`（已激活；旧无架构定义为 `needs_architecture`） | `"designed"` |
| `status` | string | 就绪状态 | `"ready"` |
| `architectureRef` | 引用 | 精确架构版本 | `{ version:3, candidateHash:"9f86d081…0a08" }` |
| `developmentRef` | 引用 | 精确研发批次 | `{ id:"run-20261025-01", codeHash:"9f86d081…0a08", planHash:"9f86d081…0a08" }` |
| `execution` | 对象 | 执行适配 | `{ kind:"managed-service", buildId:"bld-77", codeHash:"9f86d081…0a08", entrypoint:"src/main.js" }` |
| `ActivationTransaction` | 激活事务 | `{status,direction,prior,deliveryVersion:"dlv-9",migrationId?,developmentBinding:{id,architectureRef,codeHash,planHash,packageId:"pkg-31"}}` | — |
| `DeliveryHistoryEntry` | 交付历史 | `{deliveryVersion:"dlv-9",agent,stateVersion:1,dataVersion:1,language:"javascript",host:"managed"}` | — |

---

## 七、节点 6：运行交付（`src/applications/`、`src/services/`）

> 收：任务请求 `ApplicationTaskInput` → 出：`ApplicationTask`（result + artifacts）。`light` 无页面/动作路径评估通过后直接生成定义进入本节点。

### 输入（最全形态）`ApplicationTaskInput`（`src/contracts/application.d.mts:22`）

| 字段 | 类型 | 含义 | 示例 |
| --- | --- | --- | --- |
| `actionId` | string | 要执行的动作 | `"analyze_contract"` |
| `input` | 任意 JSON（动作输入 ≤128 KiB，受管 1 MiB） | 动作输入（按 inputSchema 校验） | `{ contractId:"CT-0001", clauses:["乙方逾期每日千分之五违约金"] }` |
| `mutationId` | string | 幂等标识（同 id 不同输入被拒） | `"mut-5521"` |
| `deliveryVersion` | string | 绑定的交付版本 | `"dlv-9"` |
| `source` | `{scope,kind?}` | 来源（私聊/群/API/MCP） | `{ scope:"conversation", kind:"chat" }` |

### 输出（最全形态）`ApplicationTask`（`application.d.mts:27`）

| 字段 | 类型 | 含义 | 示例 |
| --- | --- | --- | --- |
| `id` / `agentId` / `sequence` | 标识 | 任务 ID / 智能体 / 序号 | `"task-9f21"` / `"agent-7c9e"` / `12` |
| `status` | 状态机 | `queued`→`running`→（`waiting_input`/`needs_review`）→终态 `completed`/`failed`/`cancelled`/`interrupted` | `"completed"` |
| `requestHash` | sha256 | 请求哈希 | `"9f86d081…0a08"` |
| `progress` / `result` | 进度/结果 | 执行进度与动作结果 | `result:{ risks:[{clause:"…",level:"高"}] }` |
| `artifacts[]` | 产物 | `{path,snapshotId,name,size,sha256}`（不可变快照） | `[{ path:"reports/CT-0001.html", snapshotId:"snap-3", name:"风险清单", size:20480, sha256:"9f86d081…0a08" }]` |
| `events[]` | 事件 | `{type,seq,at,taskId}` | `[{ type:"completed", seq:5, at:"2026-10-25T09:30:00.000Z", taskId:"task-9f21" }]` |
| `allowNetwork?` / `workflowId?` / `resumeReceipts?` / `error?` / `finishedAt?` | 其他 | 联网授权 / 流程 / 恢复回执 / 错误 / 完成时间 | `finishedAt:"2026-10-25T09:30:12.000Z"` |

运行配置结构（激活时随清单交付）：

- `ApplicationManifest`（`application.d.mts:18`）：`{ protocolVersion:3, runtime:"managed-service", entrypoint:"src/main.js", page:{ entrypoint:"index.html", resources:[{path:"index.html",sha256:"9f86d081…0a08"}] }, actions:[{ id:"analyze_contract", title:"审查合同", inputSchema:{type:"object",…}, outputSchema:{type:"object",…}, connectionIds:[] }], stateVersion:1, evidenceIds:["ev-01"], service:{…} }`。
- `ServiceManifest`（`service.d.mts:9`）：`{ schemaVersion:1, language:"javascript", host:"managed", entrypoint:"src/main.js", operations:[{ id:"analyze_contract", title:"审查合同", inputSchema:…, outputSchema:…, idempotent:false, visibility:"public" }], dependencies:{ packages:[{ name:"pdf-parse", version:"1.1.1", url:"…", sha256:"9f86d081…0a08", filename:"pdf-parse-1.1.1.tgz" }] }, resources:{ timeoutMs:600000, memoryMiB:512, scratchMiB:256, logBytes:1048576 }, capabilities:["pdf-render"], dataVersion:1, workflow:{ schemaVersion:1, entryActionId:"analyze_contract", steps:[{ id:"s1", actionId:"analyze_contract", dependsOn:[], idempotent:false, maxRetries:1 }], outputs:["risks"] } }`。
- `ApplicationState`：`{ state:{…}, version:3, stateVersion:1 }`（写入带 `expectedVersion` 乐观锁）。
- `activeRuntime`（`agent-prototype.mts:321`）：`{ architecture, development, application }`，仅定义已批准且 `delivery:"ready"` 时非空。

---

## 八、速查：节点 → 输入 → 输出 → 存哪里

| 节点 | 输入 | 输出 | 持久化 |
| --- | --- | --- | --- |
| 1 需求澄清与确认 | 用户消息 + 材料 + 评估 | `RequirementDraft` + `TaskSpecV1` + `RequirementReceipt` | `requirements.json` |
| 2.1 蓝图 | requirements + taskSpec + 平台快照 + 预算 | `ArchitectureBlueprint` | `architecture.json`→checkpoint.blueprint |
| 2.2 模块 ×1–3 | assignment + blueprint + dependencyInterfaces + requirements | `ArchitectureModule` | →checkpoint.modules[] |
| 2.3 整合 | baseCandidate + baseHash + conflicts + policy | `{baseHash, updates[]}` | →checkpoint.integration |
| 2.4 程序组装 | blueprint + modules | `CandidateDraft` | architecture.json 候选 |
| 3 独立评审 | CandidateDraft + requirements + evidence + 平台 | `ArchitectureReview`（verdict） | →review/attempts |
| 4.1 intake | PassedDevelopmentArchitecture | running/intake 记录 + 工作区 | development/records/ |
| 4.2 planning | 冻结架构 + 需求 | `DevelopmentPlan` + 规划材料 + 计划评审 | workspaces/<runId>/planning/ |
| 4.3 implementing | 任务 + 授权 + 交接 | `TaskProgress` + `DevelopmentWork` + 快照 | development/ 各目录 |
| 4.4 verifying | 固定快照 + 冻结用例 | `DevelopmentEvidence` + `AcceptanceLedger` | 研发记录 |
| 4.5 packaging | verifiedSnapshot + 台账 + 清单 | `DevelopmentPackage` + deliveries | 研发记录 |
| 5 激活 | package + activationChecks + 激活证据 | `AgentDefinition`（designed）+ 事务 | definition.json |
| 6 运行交付 | `ApplicationTaskInput` | `ApplicationTask`（result + artifacts） | 任务存储（`TaskRecord`） |
