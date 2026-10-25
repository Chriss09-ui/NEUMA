import {callFixture} from "../helpers/m7-test-boundaries.mjs";
import { failureFields } from "../helpers/failure-fields.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { designHash, validateDesign, normalizeArchitectureDecisionReferences, validateArchitectureDecisionReferences } from "../../src/architecture/architecture-contract.mjs";
import { validDesign } from "../helpers/architecture.mjs";

function fixture() {
  const requirements = [{ id: "goal", text: "保留原记录事实" }, { id: "verification", text: "验证当前范围" }];
  const source = { messageId: "msg_saved", role: "user", quote: "保留原记录事实" };
  const quote = { id: `quote_${designHash(source).slice(0, 24)}`, ...source };
  const body = { taskSources: [{ requirementId: "goal", quoteIds: [quote.id] }], resolvedChoices: [], sourceQuotes: [quote] };
  const issue = { id: "sys_001", stage: "development", question: "核对范围", impact: "保留承诺", requirementIds: ["goal"], checks: [], requirementId: "verification" };
  const hash = designHash([(({ id, stage, question, impact, requirementIds, checks }) => ({ id, stage, question, impact, requirementIds, checks }))(issue)]);
  const context = { requirements, evidence: [], confirmedRequirementContext: { ...body, hash: designHash(body) },
    deferredVerifications: { issues: [issue], hash } };
  const design = validDesign(requirements); design.decisions[0]!.evidenceIds = [quote.id, issue.id];
  design.acceptance = design.acceptance.map(row => ({ ...row, requirementIds: requirements.map(item => item.id) }));
  return { context, design, quote };
}

test("决策可引用同一冻结上下文中的已确认引文与后续核实事项，仍须实际注册来源", () => {
  const f = fixture(); assert.doesNotThrow(() => validateDesign(f.design, f.context));
  for (const id of ["quote_unknown", "sys_unknown"]) {
    const design = structuredClone(f.design); design.decisions[0]!.evidenceIds.push(id);
    assert.throws(() => validateDesign(design, f.context), error => failureFields(error).validationIssue?.reason === "invalid_reference");
  }
});

test("唯一消息编号别名可规范到原引文，歧义编号、变化来源和伪造编号均拒绝", () => {
  const f = fixture(); f.design.decisions[0]!.evidenceIds = ["quote_saved", "sys_001"];
  assert.doesNotThrow(() => validateArchitectureDecisionReferences(f.design, f.context, "module"));
  const normalized = normalizeArchitectureDecisionReferences(f.design.decisions, f.context);
  assert.deepEqual(normalized[0]!.evidenceIds, [f.quote.id, "sys_001"]);
  assert.deepEqual(f.design.decisions[0]!.evidenceIds, ["quote_saved", "sys_001"]);
  assert.doesNotThrow(() => validateDesign({ ...f.design, decisions: normalized }, f.context));
  for (const change of [
(    context: { confirmedRequirementContext: { sourceQuotes: { quote: string; }[]; }; }) => { context.confirmedRequirementContext.sourceQuotes[0]!.quote = "已变化"; },
(    context: { deferredVerifications: { issues: { question: string; }[]; }; }) => { context.deferredVerifications.issues[0]!.question = "已变化"; },
(    context: { requirements: void[]; }) => { context.requirements.pop(); },
(    context:ReturnType<typeof fixture>["context"]) => {
      const confirmed = context.confirmedRequirementContext, source = { ...f.quote, quote: "同消息的另一段" };
      const { id: _id, ...body } = source; source.id = `quote_${designHash(body).slice(0, 24)}`;
      confirmed.sourceQuotes.push(source); confirmed.taskSources[0]!.quoteIds.push(source.id);
      const { hash: _hash, ...value } = confirmed; confirmed.hash = designHash(value);
    },
  ]) {
    const context = structuredClone(f.context); callFixture(change,undefined,[context]);
    assert.throws(() => validateArchitectureDecisionReferences(f.design, context, "module"), error => failureFields(error).validationIssue?.reason === "invalid_reference");
  }
});
