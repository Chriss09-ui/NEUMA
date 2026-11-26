import type { RequirementDraft } from "../contracts/requirements.mjs";
import { normalizeDraft, resolvedRoutingCondition } from "../requirements/core.mjs";

// Compare the user-facing commitments. Evidence references can change between turns
// without changing what the user has asked the assistant to do.
function rows(draft: RequirementDraft) {
  const result = new Map<string, { label: string; text: string }>();
  const add = (key: string, label: string, text: string | undefined) => {
    if (text) result.set(key, { label, text });
  };
  const list = (label: string, values: (string | undefined)[]) => {
    for (const text of values) add(`${label}/${text}`, label, text);
  };
  for (const [key, label] of [
    ["name", "名称"], ["agentType", "类型"], ["goal", "目标"], ["scenario", "使用场景"], ["inputSource", "输入"],
    ["task", "处理方式"], ["deliverable", "输出"], ["successCriteria", "完成标准"],
  ] as const) add(key, label, draft[key].value);
  add("routingCondition", "适用场景", resolvedRoutingCondition(draft).value);
  list("工作约束", draft.constraints.map(item => item.text ?? item.value));
  list("能力依赖", draft.capabilityDependencies);
  const trigger = { on_demand: "按需", scheduled: "定时", event: "事件触发", unclear: "待明确" };
  add("usage", "触发方式", [trigger[draft.usage.mode], draft.usage.detail].filter(Boolean).join("，"));
  const action = draft.externalAction;
  add("externalAction", "对外动作", action.mode === "none" ? "不执行对外动作" :
    [action.mode === "possible" ? "待明确" : "执行", action.operation, action.target, action.scope, action.trigger].filter(Boolean).join("，"));
  const interaction = draft.interaction;
  if (interaction) {
    add("entry", "默认入口", interaction.defaultEntry === "application" ? "应用页面" : "对话");
    add("page", "专属页面", interaction.page ? "有" : "无");
    add("inputs", "交互输入", interaction.inputs);
    add("results", "交互结果", interaction.results);
    add("data", "保存的数据", interaction.persistentData);
    if (interaction.assistant?.enabled) add("assistant", "页面助手", interaction.assistant.purpose || "启用");
    list("专属操作", interaction.operations);
  }
  const purpose = { business: "业务", search: "搜索", model: "模型" };
  list("服务连接", (draft.connections ?? []).map(c => `${purpose[c.purpose]}（${c.required ? "必需" : "可选"}）· ${c.description}`));
  const dimensions = { input_scale: "输入与规模", processing: "处理要求", delivery: "交付要求", workflow: "工作流程",
    data_lifecycle: "数据使用", external_conditions: "外部条件" };
  for (const item of draft.taskSpec?.items ?? []) {
    const qualifier = item.applicability === "unknown" ? "待明确" : item.applicability === "not_applicable" ? "不适用" : item.critical ? "必需" : "一般";
    add(`spec/${item.id}`, dimensions[item.dimension], `${item.content}（${qualifier}）`);
  }
  return result;
}

export function requirementChanges(saved: unknown, draft: RequirementDraft): string[] {
  const before = rows(normalizeDraft(saved)), after = rows(normalizeDraft(draft)), changes = new Set<string>();
  for (const [key, { label, text }] of after) {
    const previous = before.get(key);
    if (!previous) changes.add(`新增${label}：${text}`);
    else if (previous.text !== text || previous.label !== label) {
      const suffix = text.startsWith(previous.text) ? text.slice(previous.text.length) : "";
      if (/^[，,；;。\s]/u.test(suffix) && previous.label === label) changes.add(`补充${label}：${suffix.replace(/^[，,；;。\s]+/u, "") || text}`);
      else changes.add(`${label}改为：${text}`);
    }
  }
  for (const [key, row] of before) if (!after.has(key)) changes.add(`移除${row.label}：${row.text}`);
  return [...changes];
}
