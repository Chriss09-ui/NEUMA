import test from "node:test";
import assert from "node:assert/strict";
import { checkedConsultation } from "../src/requirements/consultation-storage.mjs";
import { newConsultation, validatePreflight } from "../src/requirements/consultation.mjs";
import { emptyDraft } from "../src/requirements/core.mjs";
import { TASK_DIMENSIONS } from "../src/requirements/task-spec.mjs";

test("旧咨询记录的失败历史和扩展字段按原值保留，损坏的嵌套原文不变成可信记录", () => {
  const value = { ...newConsultation(), legacyNote: "kept", assessments: [{ id: "pre_old", requirementHash: "h", platformHash: "p", evidenceHash: "e", failure: "cancelled", modelCalls: 5 }],
    evidenceMessages: [{ id: "message_old", role: "user", content: "历史原文" }] };
  const before = structuredClone(value);
  assert.equal(checkedConsultation(value), value);
  assert.equal(Object.hasOwn(value.assessments[0]!, "createdAt"), false);
  assert.deepEqual(value, before);
  const malformed = { ...value, evidenceMessages: [{ id: "message_old", role: "user", content: 42 }] };
  const badBefore = structuredClone(malformed);
  assert.throws(() => checkedConsultation(malformed), { reason: "consultation_record_invalid" });
  assert.deepEqual(malformed, badBefore);
});

test("预评估问题编号需要实际字符串，不能通过正则隐式转换提升外部对象", () => {
  const input = { verdict: "needs_input", direction: "方向", adequacy: "依据", dimensionChecks: TASK_DIMENSIONS.map(dimension => ({ dimension, status: "not_applicable", reason: "本轮不适用", requirementIds: [] })),
    issues: [{ id: { toString() { return "issue_1"; } }, owner: "user", blocking: true, question: "问题", impact: "影响", requirementIds: [] }] };
  assert.throws(() => validatePreflight(input, emptyDraft()), /问题格式无效/);
});


test("正常角色评审历史无需伪造失败字段，未知版本检查点原样保留", async () => {
  const { checkedStoredArchitectureRecord } = await import("../src/architecture/architecture-storage-boundary.mjs");
  const record = { agentId: "agent_legacy", name: "旧设计", version: 1, contractVersion: 1, sourceFingerprint: "source", status: "failed", delivery: "blocked", summary: "已有材料", createdAt: "old",
    draft: emptyDraft(), requirements: [], design: null, review: null, candidateHash: null, evidence: [], researchGaps: [], modules: [], attempts: [], issues: [],
    reviewDiagnostics: [{ role: "reviewer", phase: "evaluating", modelCalls: 5, status: "submitted" }],
    reviewProgressCheckpoint: { schemaVersion: 999, modelCalls: 25, hash: "historical", opaque: { retained: true } } };
  const serialized = JSON.stringify(record);
  assert.equal(checkedStoredArchitectureRecord(record), record);
  assert.equal(JSON.stringify(record), serialized);
  assert.throws(() => checkedStoredArchitectureRecord({ ...record, reviewDiagnostics: [{ role: "reviewer", modelCalls: "5" }] }), /架构记录格式无效/);
});
