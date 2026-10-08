import { emptyDraft } from "../../core.mjs";

export function validDraft(goal = "整理周报") {
  const draft = emptyDraft();
  for (const [key, value] of Object.entries({ name: "周报助手", goal, scenario: "每周复盘工作进展",
    inputSource: "用户在对话中提供工作记录", task: "总结用户提供的进展", deliverable: "中文周报",
    successCriteria: "保留已知进展，缺少信息时明确标注" })) draft[key] = { value, source: "user" };
  return draft;
}

export function validDesign(requirements, overrides = {}) {
  return {
    profile: "light", rationale: "输入和交付均为文本，现有执行器可完成。",
    instructions: "根据用户提供的材料整理周报。缺少信息时询问，不编造进展，不执行外部动作。",
    components: [{ id: "summarize", purpose: "整理工作记录", necessity: "提取进展并保留用户限制",
      inputs: "用户提供的工作记录", outputs: "中文周报" }],
    steps: [{ id: "compose", componentId: "summarize", dependsOn: [], input: "用户的工作记录和本轮要求",
      output: "中文周报", completion: "覆盖用户提供的进展并标注缺失信息" }],
    capabilities: [{ id: "conversation", status: "available", reason: "只处理用户提供的文本" }],
    state: { mode: "task", reason: "只需本次对话上下文" },
    failureHandling: [{ scenario: "未提供工作记录", response: "请用户补充记录，不编造结果" },
      { scenario: "文件工具失败", response: "明确说明未保存成功，保留文本结果供重试" }],
    decisions: [{ id: "runtime", problem: "怎样执行文本整理", choice: "使用现有执行器",
      alternatives: [{ option: "独立程序", reason: "本需求没有独立部署或专用处理依赖" }],
      reason: "复用已有文本处理能力即可覆盖需求", evidenceIds: [], uncertainties: [] }],
    coverage: requirements.map((item) => ({ requirementId: item.id, componentIds: ["summarize"],
      verification: `核对结果满足：${item.text}` })),
    acceptance: [
      { id: "valid", kind: "success", requirementIds: requirements.map((item) => item.id),
        input: "本周完成原型，下周验证交互", expected: "基于记录给出中文周报，不添加未提供的进展" },
      { id: "empty", kind: "missing_input", requirementIds: ["inputSource"],
        input: "没有提供记录", expected: "请求用户提供记录，不编造周报" },
      { id: "boundary", kind: "boundary", requirementIds: ["externalAction"],
        input: "直接发送周报", expected: "说明尚未发送，不执行未授权的外部动作" },
      { id: "tool_failure", kind: "tool_failure", requirementIds: ["deliverable"],
        input: "保存文件失败", expected: "说明保存失败，保留文本并允许重试" },
    ],
    unknowns: [], ...overrides,
  };
}

export function passingReview(candidateHash) {
  return { candidateHash, verdict: "pass", checks: ["requirements", "feasibility", "minimality", "interfaces", "failure_handling", "verification"]
    .map((id) => ({ id, passed: true, evidence: `已核对候选中的 ${id} 字段与需求映射` })),
    issues: [], summary: "方案覆盖需求，且在现有能力范围内可执行。" };
}
