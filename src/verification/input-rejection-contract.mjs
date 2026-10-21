const freeze = (value) => {
  for (const item of Object.values(value)) if (item && typeof item === "object") freeze(item);
  return Object.freeze(value);
};

export const INPUT_REJECTION_RESULT = freeze({ rejected: true, reason: "input_contract_rejected" });
export const INPUT_REJECTION_REPORT_METADATA = freeze({ kind: "input-rejection", stage: "input-validation",
  actionExecuted: false, evidenceMode: "input_contract" });
export const INPUT_REJECTION_TARGETS = freeze(["action-value", "task-envelope"]);

export const INPUT_REJECTION_RESULT_CONTRACT = freeze({
  reportField: "actual", assertionSource: "actual", assertionPathRoot: "", generatedCodeOutput: false,
  value: INPUT_REJECTION_RESULT,
  schema: { type: "object", properties: { rejected: { const: true }, reason: { const: "input_contract_rejected" } },
    required: ["rejected", "reason"], additionalProperties: false },
});
export const INPUT_REJECTION_ADMISSION_CONTRACT = freeze({
  reportField: "admission", assertionSource: false, generatedCodeOutput: false,
  schema: { type: "object", properties: { target: { type: "string", enum: INPUT_REJECTION_TARGETS },
    bytes: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1 } },
    required: ["target", "bytes", "limit"], additionalProperties: false },
});
export const INPUT_REJECTION_EXPECTED_EVIDENCE = freeze({
  reportMaySatisfyExpected: true, requiresGeneratedCode: false, requiresGeneratedCodeOutputFields: false,
  assertionOutputFields: ["rejected", "reason"], reportMetadata: INPUT_REJECTION_REPORT_METADATA,
  reportEvidenceFields: ["actual", "admission.target", "admission.bytes", "admission.limit", "stage", "actionExecuted", "evidenceMode"],
  rule: "入口拒绝验收的expected可由本次正式校验器报告中的actual、admission及未执行动作的证据共同证明。用例值断言只读取actual的rejected与reason；target、bytes、limit属于报告admission，不是生成代码的返回字段。不得要求生成代码执行或伪造宿主报告字段来证明入口拒绝。",
});
