import type { ToolSchema } from "../contracts/tools.mjs";
import type { DevelopmentArchitecture } from "../contracts/development.mjs";
import type { SubmissionIssue } from "./development-diagnostics.mjs";
import { objectFields } from "../runtime/type-boundary.mjs";
import { ACTION_CAPABILITIES } from "./node-action-bootstrap.mjs";

export const TEST_CAPABILITY_GUIDE = "测试能力见testCapabilities。mocks只能替换代码实际通过ctx调用的平台工具回执；待开发代码、架构能力编号、组件名和内部函数不能作为工具名，也不能用mock替换被测代码本身。普通计算和输入检查直接执行代码，未调用工具时mocks=[]。故障测试须有真实可执行的触发方式；工具失败仅在该工具确被调用且与原需求一致时模拟。不能为测试新增业务连接或隐藏开关，平台启动失败也不能冒充业务错误返回。规划先核对测试可行性；用例发现上游要求做不到时指出负责的任务/验收与缺少的手段，由规划或架构修正，不编造工具、不删原义务。清单表示平台测试支持范围，实际使用仍受本任务权限、连接和服务声明约束。";

export function developmentTestCapabilities() {
  return { mockableTools: [...ACTION_CAPABILITIES], guide: TEST_CAPABILITY_GUIDE };
}

export function testCapabilityIssue(capability: unknown, path: string, architecture?: DevelopmentArchitecture): SubmissionIssue | undefined {
  if (typeof capability !== "string" || capability.length > 100 || ACTION_CAPABILITIES.includes(capability)) return;
  const designCapabilities = objectFields(architecture?.design).capabilities;
  const entry = Array.isArray(designCapabilities) ? designCapabilities.map(objectFields).find(row => row.id === capability) : undefined;
  const meaning = entry?.status === "needs_development" ? "是架构中的待开发代码编号，不是平台工具"
    : entry ? "是架构能力编号，不是可模拟的平台工具" : "不支持，平台没有这个可模拟的工具";
  return { path, reason: "mock_capability_invalid",
    remedy: `${JSON.stringify(capability)}${meaning}。mocks仅支持：${ACTION_CAPABILITIES.join("、")}。仅模拟代码实际调用且本任务获准使用的工具；纯计算直接运行代码、mocks=[]。若上游要求用不存在的工具制造故障，指出对应任务/验收并交回规划核对；不能随意改成其他工具或新增连接。` };
}

export function testingCapabilityIssues(input: unknown, architecture?: DevelopmentArchitecture): SubmissionIssue[] {
  const plan = objectFields(input), issues: SubmissionIssue[] = [];
  for (const group of ["cases", "activationCases"]) {
    const cases = plan[group];
    if (!Array.isArray(cases)) continue;
    for (const [index, row] of cases.slice(0, 200).entries()) {
      const mocks = objectFields(row).mocks;
      if (!Array.isArray(mocks)) continue;
      for (const [mockIndex, mock] of mocks.slice(0, 100).entries()) {
        const issue = testCapabilityIssue(objectFields(mock).capability, `plan.${group}[${index}].mocks[${mockIndex}].capability`, architecture);
        if (issue) issues.push(issue);
        if (issues.length === 12) return issues;
      }
    }
  }
  return issues;
}

/** Tool descriptions are refreshed at delivery; persisted assignment schemas keep their original binding. */
export function withTestCapabilityGuide(schema: ToolSchema): ToolSchema {
  const copy = structuredClone(schema);
  const visit = (rule: ToolSchema | boolean | undefined, depth: number) => {
    if (!rule || typeof rule === "boolean" || depth > 32) return;
    const capability = rule.properties?.mocks?.items?.properties?.capability;
    if (capability?.type === "string") capability.description = `仅支持 ${ACTION_CAPABILITIES.join(", ")}。填写真实ctx工具名；待开发代码和组件编号不能作测试替身。详见testCapabilities。`;
    for (const child of Object.values(rule.properties ?? {})) visit(child, depth + 1);
    visit(rule.items, depth + 1);
    for (const child of [...rule.anyOf ?? [], ...rule.oneOf ?? [], ...rule.allOf ?? []]) visit(child, depth + 1);
  };
  visit(copy, 0);
  return copy;
}
