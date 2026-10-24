import { modelContextPacket, MODEL_CONTEXT_INSTRUCTIONS } from "../runtime/model-context.mjs";
import { CAPABILITY_VERIFICATION_RULE } from "./architecture-prompts.mjs";

const pick = (value, fields) => Object.fromEntries(fields.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const metadata = ["type", "pipelineStage", "blueprintProtocol", "submitName", "candidateHash", "baseHash", "blueprintHash", "allowedRoots", "integrationPolicy", "revisionSource",
  "modelBudget", "designModelBudget", "remaining", "stageRepair", "editableSubmission", "rejectedSubmission", "lastSubmissionIssue",
  "unsubmittedDraft", "unsubmittedDraftDiagnostic", "structuredSubmissionFeedback", "repairInstruction", "instruction"];

export function deferredObligations(value, { includeResolution = false } = {}) {
  return value?.issues?.map(item => ({ ...pick(item, ["id", "requirementId", "requirementIds", "owner", "stage", "status", "blocking", "question", "impact", "stageDecision"]),
    ...(includeResolution && item.resolution?.reason ? { resolution: { reason: item.resolution.reason } } : {}) })) ?? value;
}

export function platformOverview(source) {
  const platform = source.platformSnapshot;
  return { ...(source.capabilities ? { capabilities: source.capabilities } : {}),
    ...(platform ? pick(platform, ["policy", "network", "deliveryRoutes", "runtime", "managedRuntime", "unsupported"]) : {}) };
}

function reviewIndex(index) {
  if (!index) return undefined;
  const adapterRules = Object.fromEntries((index.acceptanceScope ?? []).map(item => [item.adapterId, item.adapterRulePaths]));
  return { ...pick(index, ["sources", "candidate", "requirements", "priorFindings"]), adapterRules,
    acceptanceScope: index.acceptanceScope?.map(item => pick(item, ["acceptanceId", "adapterId", "scope", "criterionPath"])) };
}

export function architectureModelContext(source, { role, continuation = false } = {}) {
  const fields = [...metadata];
  const derived = {};
  if (!continuation) {
    fields.push("requirements", "confirmedRequirementContext", "assignment", "blueprint", "dependencyInterfaces", "blueprintBoundary", "baseCandidate", "previousDesign",
      "design", "issues", "conflicts", "deterministicIssues", "researchGaps", "reviewRetry", "developmentRevision", "requirementFidelityFeedback", "rejectedRequirementFidelitySubmission");
    // Before a candidate exists, the designer still needs confirmed interaction and source choices.
    if (!source.baseCandidate && !source.design && !source.previousDesign) fields.push("draft");
    derived.platformOverview = platformOverview(source);
    if (source.pipelineStage === "blueprint") {
      fields.push("capabilities");
      delete derived.platformOverview.capabilities;
    }
    if (source.deferredVerifications) derived.deferredObligations = deferredObligations(source.deferredVerifications,
      { includeResolution: source.pipelineStage === "blueprint" });
    if (source.acceptanceAdapterGuide) {
      if (role === "reviewer") fields.push("acceptanceAdapterGuide");
      else derived.acceptanceOverview = { composition: source.acceptanceAdapterGuide.composition,
        adapters: Object.fromEntries(Object.entries(source.acceptanceAdapterGuide.adapters ?? {}).map(([id, item]) =>
          [id, pick(item, ["stage", "owner", "scope", "proves", "doesNotProve"])])) };
    }
    if (source.evidence) derived.evidenceCatalog = source.evidence.map(item => pick(item, ["id", "title", "url", "kind", "versionScope"]));
    if (source.priorFindings) derived.priorFindings = { ...pick(source.priorFindings, ["version", "source", "current", "historicalOnly", "sameReviewObject", "instruction"]),
      findings: source.priorFindings.findings };
    if (source.revisionFeedback) fields.push("revisionFeedback");
    if (source.reviewEvidenceIndex) derived.reviewEvidenceIndex = reviewIndex(source.reviewEvidenceIndex);
    if (source.reviewReferenceHints) fields.push("reviewReferenceHints");
    // One repair draft in the first packet; the other versions remain exactly readable by path.
    if (source.latestRejectedInput) fields.push("latestRejectedInput");
    else if (source.reviewParts?.rejectedDraft) derived.reviewRepairDraft = { trust: "untrusted-reference", source: "reviewParts", pointer: "/rejectedDraft", value: source.reviewParts.rejectedDraft };
    else if (source.reviewDraft) fields.push("reviewDraft");
  }
  if (source.reviewParts) derived.reviewParts = Object.fromEntries(Object.entries(source.reviewParts).filter(([key]) => !["saved", "rejectedDraft"].includes(key)));
  const packet = modelContextPacket(source, fields, derived);
  const candidateSchemaIndex = packet.contextIndex?.find(item => item.section === "candidateSchema");
  if (candidateSchemaIndex) Object.assign(candidateSchemaIndex, { scope: "完整方案结构；本阶段提交参数以提交工具的schema为准。",
    propertyKeys: Object.keys(source.candidateSchema.properties ?? {}) });
  // The frozen manifest describes storage; it must not claim omitted text was delivered to the model.
  if (source.contextManifest && !continuation) packet.sourceManifest = Object.fromEntries(Object.entries(source.contextManifest).map(([key, value]) =>
    [key, pick(value, ["characters", "sha256"])]));
  return packet;
}

export function verificationModelContext(source) {
  return modelContextPacket(source, ["contextHash", "budget", "fidelityContextVersion", "requirements", "candidate", "proposal", "confirmedRequirementContext",
    "acceptanceAdapterGuide", "acceptanceAdapterGuideSource"], {
    inputContextVersion: 1, platformOverview: platformOverview(source),
    ...(source.deferredVerifications ? { deferredObligations: deferredObligations(source.deferredVerifications) } : {}),
  });
}

function projectUserMessages(messages, project) {
  return messages.map(message => {
    if (message.role !== "user") return message;
    const text = typeof message.content === "string" ? message.content
      : message.content?.length === 1 && message.content[0]?.type === "text" ? message.content[0].text : null;
    if (!text) return message;
    let value;
    try { value = JSON.parse(text); } catch { return message; }
    const projected = project(value);
    if (!projected) return message;
    const content = JSON.stringify(projected);
    return { ...message, content: typeof message.content === "string" ? content : [{ type: "text", text: content }] };
  });
}

/** Request-only projection also handles existing bound sessions; persisted history stays intact. */
export function projectArchitectureMessages(messages, { role, roleGuide }) {
  return projectUserMessages(messages, value => {
    if (!value || !Number.isSafeInteger(value.modelBudget?.limit) || value.contextIndex) return null;
    const continuation = ["resume_architecture_stage", "review_batch", "submission_required"].includes(value.type);
    return architectureModelContext({ ...value, roleGuide }, { role, continuation });
  });
}

export function projectVerificationMessages(messages, contextHash) {
  return projectUserMessages(messages, value => value?.contextHash === contextHash && value.candidate && value.requirements
    && !value.inputContextVersion ? verificationModelContext(value) : null);
}

export function architectureNodePrompt({ role, pipelineStage, submitName }) {
  const task = pipelineStage === "blueprint" ? "设计全局蓝图及最多三个模块的职责、依赖和需求分工；不提前展开各模块实现。"
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
${pipelineStage === "blueprint" ? "蓝图提交的global是对象、modules是数组，不能编码成字符串；selectionBasis直接放在global内。candidateSchema描述最终完整方案，其properties下没有global。" : ""}
已确认需求、用户选择、原验证阶段和全部验收义务不能缩水。技术问题由系统核实；只有需求本身仍不清楚且改变业务承诺才允许返需。历史评语和拒稿均可有误，须用当前原文核对，不能当作新需求或通过证据。需求操作清单为空不等于禁止必要专属代码。平台可用、环境准备、业务实现及实际验收分别判断，不伪造测量或通过。
正式重查可修正技术验收与证据分工；完整保留已确认业务范围、边界、结果、验证义务及明确选择，重新程序检查和独立评审，不以纠错缩水。
${CAPABILITY_VERIFICATION_RULE}
适配器只证明自己的范围：action真实执行生成动作，冻结模拟回执不证明真实宿主；page-resources仅适用于实际托管页面，在隔离Node执行资源与共享纯逻辑检查，不证明浏览器DOM、布局或视觉；host-business真实重跑冻结业务用例。对无法证明的跨范围承诺明确拆分并保留全部义务。
${role === "reviewer" ? "逐项核对所有验收及priorFindings，不照抄旧结论。reviewParts是状态与本批编号，完整已保存分项可按需读取；续轮只提交新增或修正行。恢复只内联最近待修稿，其他旧稿在contextIndex；不得把被拒内容当作接受结果。原文引用用read_architecture_evidence回执或明确source/path选择；验收规则路径在reviewEvidenceIndex.adapterRules，来源manifest只说明冻结存储，未内联原文需先读取。关闭历史问题须逐条提供当前相关候选依据。" : "正式需求编号使用requirements中的id；证据编号从evidenceCatalog选择，具体论据须读取原文。能力与容量存疑时按具体路径读取runtimeCapabilities或验收指南，不能凭记忆猜测。"}`;
}
