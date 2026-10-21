import { InputError } from "../requirements/core.mjs";

const inputIssueReasons = Object.freeze({ required_field: "缺少必填字段", unknown_field: "包含未声明字段", invalid_type: "字段类型无效",
  size_limit: "长度或数量超限", invalid_value: "字段取值无效", json_limit: "JSON深度或节点超限", invalid_structure: "JSON结构无效", channel_limit: "输入超过通道限制" });

export function publicInputContractFailure(error) {
  const issue = error?.validationIssue;
  if (!(error instanceof InputError) || error.reason !== "input_contract_rejected" || !issue || Object.keys(issue).length !== 2
    || !Object.hasOwn(inputIssueReasons, issue.reason) || typeof issue.path !== "string" || issue.path.length > 2048
    || !/^input(?:\.[A-Za-z][A-Za-z0-9_-]{0,79}|\.[0-9]{1,6}|\[(?:JSON|[0-9]{1,6})\])*$/u.test(issue.path)) return null;
  return { reason: "input_contract_rejected", error: `输入不符合操作契约：${issue.path}（${inputIssueReasons[issue.reason]}）`,
    validationIssue: { path: issue.path, reason: issue.reason } };
}
