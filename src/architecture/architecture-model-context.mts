import type { UnknownRecord } from "../contracts/json.mjs";
import type { ContextEvent } from "../runtime/execution-port.mjs";
import { objectFields, isArray } from "../runtime/type-boundary.mjs";
function array(value: unknown): unknown[] { if (!isArray(value)) throw new TypeError("Model context list is invalid"); return value; }
import { modelContextPacket, MODEL_CONTEXT_INSTRUCTIONS } from "../runtime/model-context.mjs";
import { BLUEPRINT_ASSIGNMENT_RULE, CAPABILITY_VERIFICATION_RULE } from "./architecture-prompts.mjs";

const pick = (value: unknown, fields: string[]) => { const record = objectFields(value); return Object.fromEntries(fields.filter(key => record[key] !== undefined).map(key => [key, record[key]])); };
const metadata = ["type", "pipelineStage", "blueprintProtocol", "submitName", "candidateHash", "baseHash", "blueprintHash", "allowedRoots", "integrationPolicy", "revisionSource",
  "stageContract", "consultations", "moduleCapacity", "moduleLimit",
  "modelBudget", "designModelBudget", "remaining", "stageRepair", "editableSubmission", "rejectedSubmission", "lastSubmissionIssue",
  "unsubmittedDraft", "unsubmittedDraftDiagnostic", "structuredSubmissionFeedback", "repairInstruction", "instruction"];

export function deferredObligations(value: unknown, { includeResolution = false } = {}) {
  const issues = objectFields(value).issues;
  return issues == null ? value : array(issues).map(input => { const item = objectFields(input); return ({ ...pick(item, ["id", "requirementId", "requirementIds", "owner", "stage", "status", "blocking", "question", "impact", "stageDecision"]),
    ...(includeResolution && objectFields(item.resolution).reason ? { resolution: { reason: objectFields(item.resolution).reason } } : {}) }); });
}

export function platformOverview(source: UnknownRecord) {
  const platform = source.platformSnapshot;
  return { ...(source.capabilities ? { capabilities: source.capabilities } : {}),
    ...(platform ? pick(platform, ["policy", "network", "deliveryRoutes", "runtime", "managedRuntime", "unsupported"]) : {}) };
}

function reviewIndex(value: unknown) {
  const index = objectFields(value);
  if (!value) return undefined;
  const adapterRules = Object.fromEntries(array(index.acceptanceScope ?? []).map(input => { const item = objectFields(input); return [String(item.adapterId), item.adapterRulePaths]; }));
  return { ...pick(index, ["sources", "candidate", "requirements", "priorFindings"]), adapterRules,
    acceptanceScope: index.acceptanceScope == null ? undefined : array(index.acceptanceScope).map(item => pick(item, ["acceptanceId", "adapterId", "scope", "criterionPath"])) };
}

export function architectureModelContext(source: UnknownRecord, { role, continuation = false }: { role?: string | undefined; continuation?: boolean } = {}) {
  const fields = [...metadata];
  const derived: UnknownRecord = {};
  if (!continuation) {
    fields.push("requirements", "confirmedRequirementContext", "assignment", "blueprint", "dependencyInterfaces", "blueprintBoundary", "baseCandidate", "previousDesign",
      "design", "issues", "conflicts", "deterministicIssues", "researchGaps", "reviewRetry", "developmentRevision", "requirementFidelityFeedback", "rejectedRequirementFidelitySubmission", "validationRepair", "repairPreparation", "distributedReview");
    if (objectFields(source.repairPreparation).ready === true) fields.push("roleGuide", "evidence");
    // Before a candidate exists, the designer still needs confirmed interaction and source choices.
    if (!source.baseCandidate && !source.design && !source.previousDesign) fields.push("draft");
    derived.platformOverview = platformOverview(source);
    if (source.pipelineStage === "blueprint") {
      fields.push("capabilities");
      delete objectFields(derived.platformOverview).capabilities;
    }
    if (source.deferredVerifications) derived.deferredObligations = deferredObligations(source.deferredVerifications,
      { includeResolution: source.pipelineStage === "blueprint" });
    if (source.acceptanceAdapterGuide) {
      if (role === "reviewer" || source.pipelineStage === "review_slice") fields.push("acceptanceAdapterGuide");
      else derived.acceptanceOverview = { composition: objectFields(source.acceptanceAdapterGuide).composition,
        adapters: Object.fromEntries(Object.entries(objectFields(objectFields(source.acceptanceAdapterGuide).adapters)).map(([id, item]) =>
          [id, pick(item, ["stage", "owner", "scope", "proves", "doesNotProve"])])) };
    }
    if (source.evidence) derived.evidenceCatalog = array(source.evidence).map(item => pick(item, ["id", "title", "url", "kind", "versionScope"]));
    if (source.priorFindings) derived.priorFindings = { ...pick(source.priorFindings, ["version", "source", "current", "historicalOnly", "sameReviewObject", "instruction"]),
      findings: objectFields(source.priorFindings).findings };
    if (source.revisionFeedback) fields.push("revisionFeedback");
    if (source.reviewEvidenceIndex) derived.reviewEvidenceIndex = reviewIndex(source.reviewEvidenceIndex);
    if (source.reviewReferenceHints) fields.push("reviewReferenceHints");
    // One repair draft in the first packet; the other versions remain exactly readable by path.
    if (source.latestRejectedInput) fields.push("latestRejectedInput");
    else if (objectFields(source.reviewParts).rejectedDraft) derived.reviewRepairDraft = { trust: "untrusted-reference", source: "reviewParts", pointer: "/rejectedDraft", value: objectFields(source.reviewParts).rejectedDraft };
    else if (source.reviewDraft) fields.push("reviewDraft");
  }
  if (source.reviewParts) derived.reviewParts = Object.fromEntries(Object.entries(objectFields(source.reviewParts)).filter(([key]) => !["saved", "rejectedDraft"].includes(key)));
  const packet: ReturnType<typeof modelContextPacket> & { sourceManifest?: UnknownRecord } = modelContextPacket(source, fields, derived);
  if (objectFields(source.repairPreparation).ready === true && packet.contextIndex)
    packet.contextIndex = packet.contextIndex.filter(item => !["runtimeCapabilities", "acceptanceAdapterGuide"].includes(item.section));
  if (source.stageSchema && source.pipelineStage === "blueprint" && packet.contextIndex) {
    // The final schema remains available for historical readers, but is not the blueprint's reading assignment.
    packet.contextIndex = packet.contextIndex.filter(item => item.section !== "candidateSchema");
  }
  const stageSchemaIndex = packet.contextIndex?.find(item => item.section === "stageSchema");
  if (stageSchemaIndex) Object.assign(stageSchemaIndex, { scope: "本阶段提交工具的同源参数结构，工具声明已完整提供；仅在具体字段有疑问时按pointer读取。",
    propertyKeys: Object.keys(objectFields(objectFields(source.stageSchema).properties)) });
  const candidateSchemaIndex = packet.contextIndex?.find(item => item.section === "candidateSchema");
  if (candidateSchemaIndex) Object.assign(candidateSchemaIndex, { scope: "完整方案结构；本阶段提交参数以提交工具的schema为准。",
    propertyKeys: Object.keys(objectFields(objectFields(source.candidateSchema).properties)) });
  // The frozen manifest describes storage; it must not claim omitted text was delivered to the model.
  if (source.contextManifest && !continuation) packet.sourceManifest = Object.fromEntries(Object.entries(objectFields(source.contextManifest)).map(([key, value]) =>
    [key, pick(value, ["characters", "sha256"])]));
  return packet;
}

export function verificationModelContext(source: UnknownRecord) {
  return modelContextPacket(source, ["contextHash", "budget", "fidelityContextVersion", "requirements", "candidate", "proposal", "confirmedRequirementContext",
    "acceptanceAdapterGuide", "acceptanceAdapterGuideSource"], {
    inputContextVersion: 1, platformOverview: platformOverview(source),
    ...(source.deferredVerifications ? { deferredObligations: deferredObligations(source.deferredVerifications) } : {}),
  });
}

function projectUserMessages(messages: ContextEvent["messages"], project: (value: unknown) => unknown): ContextEvent["messages"] {
  return messages.map(message => {
    if (message.role !== "user") return message;
    const text = typeof message.content === "string" ? message.content
      : message.content?.length === 1 && message.content[0]?.type === "text" ? message.content[0].text : null;
    if (!text) return message;
    let value: unknown;
    try { value = JSON.parse(text); } catch { return message; }
    const projected = project(value);
    if (!projected) return message;
    const content = JSON.stringify(projected);
    return { ...message, content: typeof message.content === "string" ? content : [{ type: "text" as const, text: content }] };
  });
}

/** Request-only projection also handles existing bound sessions; persisted history stays intact. */
export function projectArchitectureMessages(messages: ContextEvent["messages"], { role, roleGuide }: { role: string; roleGuide: string }) {
  return projectUserMessages(messages, input => {
    const value = objectFields(input);
    if (!input || !Number.isSafeInteger(objectFields(value.modelBudget).limit) || value.contextIndex) return null;
    const continuation = ["resume_architecture_stage", "review_batch", "submission_required"].some(type => type === value.type);
    return architectureModelContext({ ...value, roleGuide }, { role, continuation });
  });
}

export function projectVerificationMessages(messages: ContextEvent["messages"], contextHash: string) {
  return projectUserMessages(messages, input => { const value = objectFields(input); return value.contextHash === contextHash && value.candidate && value.requirements
    && !value.inputContextVersion ? verificationModelContext(value) : null; });
}

export function architectureNodePrompt({ role, pipelineStage, submitName }: { role: string; pipelineStage?: string | undefined; submitName: string }) {
  const task = pipelineStage === "review_slice" ? "你是独立评审者，只核对assignment指定的检查、验收范围或历史问题；完整提交本组编号，其他分项数组填空。核对真实证据及反证，不修改设计，不代替主评审作整体通过决定。"
    : pipelineStage === "blueprint" ? "按本轮工具的模块数量与每模块需求条数上限，设计全局蓝图及模块职责、依赖和需求分工；不提前展开各模块实现。"
    : pipelineStage === "module" ? "仅设计assignment负责的模块，遵守blueprint中的全局选择和接口。module-boundaries-v2协议允许自主补充内部组件和步骤；本地引用用字符串，跨模块引用用{moduleId,id}且必须来自dependencyInterfaces。frozen-ids-v1历史协议沿用原蓝图编号。"
      : pipelineStage === "integration" ? "核对已组装方案的接口和conflicts，只按integrationPolicy提交baseHash及必要updates，保留冻结组件和步骤。"
        : pipelineStage === "review_revision" ? "依据当前阻断核实并修订baseCandidate，只提交baseHash和最多24个updates；遵守allowedRoots，保留有效内容和编号。"
          : role === "reviewer" ? "独立评审当前design的需求覆盖、可行性、最简性、接口、失败处理、验收与范围。不修改候选；完整检查后提交真实结论。"
            : role === "specialist" ? "仅回答assignment中的局部设计问题，说明接口、取舍、证据和未知，不递归委派。"
              : "依据已确认需求设计最简且充分的完整方案；修订时只改相关内容，保留有效设计与编号。";
  return `你是NEUMA的${role}。${task}
${MODEL_CONTEXT_INSTRUCTIONS}
按实际公开工具schema提交${submitName}；不要复制schema或编造字段。工具及本轮modelBudget是额度依据，提交后停止。roleGuide保留本角色详细规程，遇到具体协议疑问再读取。
${pipelineStage ? "已有本节点主要资料时直接设计；只读取影响当前决定的缺项，不先通读详细规程。尽早提交完整候选，尽量预留两轮纠错；资料不足仍如实说明，不能为省轮次编造依据。" : ""}
${pipelineStage ? "本阶段提交契约已完整提供在提交工具参数中；stageSchema为同源只读参照，有具体字段疑问时按pointer定位，不先通读最终candidateSchema。" : ""}
${pipelineStage === "blueprint" ? "蓝图提交的global是对象、modules是数组，不能编码成字符串；selectionBasis直接放在global内。仅负责全局选择、职责划分与冲突裁决；模块细节留给模块设计者。存在多个独立技术难点且提供consult_architecture时，按问题及责任需求分组委派专项分析；简单任务直接提交。子分析是建议，不能替代原始需求、平台事实或正式验收。" : ""}
${pipelineStage === "blueprint" ? BLUEPRINT_ASSIGNMENT_RULE : ""}
${pipelineStage === "blueprint" ? "interaction.assistant仅指托管页面的浮窗助手，不是普通对话入口；未确认启用则不得添加，启用必须page=true且保留用途。profile=workflow表示需要持久检查点的流程，不能配builtin；单次专属代码动作按实际需求选择custom。Python不能配builtin；无代码必须none/builtin。保持已确认的默认入口、页面和操作交付。" : ""}
${pipelineStage === "module" ? "capabilities中status=available的id必须逐字来自本轮能力目录，不能为已有能力另起别名；平台交付机制不等于新工具编号。专属待开发代码单独标needs_development，不把目录已可用的运行器改标为待开发。" : ""}
${pipelineStage === "module" ? "moduleId和blueprintHash由宿主在正式提交时绑定本次assignment，无需复制历史摘要。遵守moduleCapacity的本模块条数额度，保留完整业务义务，合并重复表达而不截断内容。" : ""}
${pipelineStage ? "repairPreparation.ready=true时必要平台事实已完整内联，可直接核对；最后一次请求仅用于正式提交，不能再次读取或只保存草稿。" : ""}
已确认需求、用户选择、原验证阶段和全部验收义务不能缩水。技术问题由系统核实；只有需求本身仍不清楚且改变业务承诺才允许返需。历史评语和拒稿均可有误，须用当前原文核对，不能当作新需求或通过证据。需求操作清单为空不等于禁止必要专属代码。平台可用、环境准备、业务实现及实际验收分别判断，不伪造测量或通过。
正式重查可修正技术验收与证据分工；完整保留已确认业务范围、边界、结果、验证义务及明确选择，重新程序检查和独立评审，不以纠错缩水。
${CAPABILITY_VERIFICATION_RULE}
适配器只证明自己的范围：action真实执行生成动作，冻结模拟回执不证明真实宿主；page-resources仅适用于实际托管页面，在隔离Node执行资源与共享纯逻辑检查，不证明浏览器DOM、布局或视觉；host-business真实重跑冻结业务用例。对无法证明的跨范围承诺明确拆分并保留全部义务。
${role === "reviewer" ? "逐项核对所有验收及priorFindings，不照抄旧结论。reviewParts是状态与本批编号，完整已保存分项可按需读取；续轮只提交新增或修正行。恢复只内联最近待修稿，其他旧稿在contextIndex；不得把被拒内容当作接受结果。原文引用用read_architecture_evidence回执或明确source/path选择；验收规则路径在reviewEvidenceIndex.adapterRules，来源manifest只说明冻结存储，未内联原文需先读取。关闭历史问题须逐条提供当前相关候选依据。" : "正式需求编号使用requirements中的id；证据编号从evidenceCatalog选择，具体论据须读取原文。能力与容量存疑时按具体路径读取runtimeCapabilities或验收指南，不能凭记忆猜测。"}`;
}
