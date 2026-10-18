import { TASK_DIMENSIONS } from "../../src/requirements/task-spec.mjs";

// Fixed model answer for orchestration fixtures; quality judgments are tested separately.
export const sufficientPreflight = async () => ({ verdict: "sufficient", direction: "使用现有工具处理用户已明确的任务",
  adequacy: "当前固定测试任务的输入输出明确，执行结果可由指定断言核验。",
  dimensionChecks: TASK_DIMENSIONS.map((dimension) => ({ dimension, status: "sufficient",
    reason: "测试输入已经明确当前任务的交付范围", requirementIds: ["task", "deliverable"] })), issues: [] });

export const withPreflight = (providers) => ({ preflight: sufficientPreflight, ...providers });
