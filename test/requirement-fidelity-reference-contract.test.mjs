import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseRequirementFidelitySubmission, verifyRequirementFidelity } from "../src/architecture/requirement-fidelity.mjs";
import { ACCEPTANCE_ADAPTER_GUIDE } from "../src/verification/acceptance-contract.mjs";
import { fidelityChecker, fidelityResult } from "./helpers/fidelity.mjs";

function context() {
  return { requirements: [{ id: "input", text: "完整处理原边界内的全部业务输入。" }, { id: "delivery", text: "完整交付结果，不增加额外交付前提。" }],
    draft: { task: "完整处理原边界内的全部业务输入。" }, confirmedRequirementContext: { text: "保留原业务承诺。" },
    candidate: { instructions: "候选自行增加字符白名单。",
      decisions: [{ id: "D3_capacity", choice: "按真实可达容量验证", uncertainties: ["需要验证构造依据"] }],
      acceptance: [{ id: "A12_input_contract_reject", input: "原合法输入", expected: "候选自行增加字符白名单。" }] } };
}

function narrowed(current = context()) {
  return fidelityResult({ ...current, contextHash: diagnoseRequirementFidelitySubmission(current, {}).contextHash }, "narrowed");
}

const referenceIndex = (prompt) => JSON.parse(prompt.split("引用位置索引（entries为[id,JSON Pointer]，候选编号只定位数组元素）：")[1].split("\n")[0]);

test("引用说明及有界真实索引不改canonical schema、上下文摘要或原首包", async () => {
  const current = context(), before = structuredClone(current);
  const baseline = diagnoseRequirementFidelitySubmission(current, {});
  assert.equal(baseline.contextHash, "3c4e8e5f08aaa7f2fc8bc69083b7aafc5ec190df81f9e5a6a64115e8b508c0fe");
  assert.equal(baseline.schemaHash, "04e1bc4c756837ddc1b71ccf8fbc178189036dabef40b845308596e667c4637c");
  const result = await verifyRequirementFidelity({ context: current, config: {}, cwd: "/tmp", dataDir: "/tmp",
    sessionFactory: fidelityChecker("narrowed", { inspect(payload, options) {
      assert.deepEqual(payload, { ...current, acceptanceAdapterGuide: ACCEPTANCE_ADAPTER_GUIDE,
        acceptanceAdapterGuideSource: "current-default", contextHash: baseline.contextHash });
      assert.match(options.systemPrompt, /根相对JSON Pointer/u);
      assert.match(options.systemPrompt, /数组下标从0开始/u);
      assert.match(options.systemPrompt, /字段名里的~写成~0、\/写成~1/u);
      assert.match(options.systemPrompt, /source=draft指本轮已确认的真实需求草稿，不是candidate设计稿/u);
      assert.match(options.customTools[0].description, /quote须来自原来源/u);
      const index = referenceIndex(options.systemPrompt);
      assert.deepEqual(index.requirements.entries, [["input", "/0/text"], ["delivery", "/1/text"]]);
      assert.deepEqual(index.candidate.entries, [["A12_input_contract_reject", "/acceptance/0"], ["D3_capacity", "/decisions/0"]]);
      assert.deepEqual(index.candidateRoots.find((item) => item.path === "/instructions"), { path: "/instructions", type: "string" });
      assert.ok(Buffer.byteLength(JSON.stringify(index), "utf8") <= 6000);
    } }) });
  assert.equal(result.verdict, "narrowed"); assert.deepEqual(current, before);
});

test("点号、编号和字符串行号仍被拒，反馈只给真实JSON Pointer索引", () => {
  const current = context();
  for (const [path, pointer] of [["decisions[D3_capacity].uncertainties[0]", "/decisions/0"],
    ["acceptance[A12_input_contract_reject].expected", "/acceptance/0"], ["instructions.2", null]]) {
    const value = narrowed(current); value.restrictions[0].candidatePath = path;
    const before = structuredClone(value), feedback = diagnoseRequirementFidelitySubmission(current, value);
    assert.equal(feedback.valid, false);
    assert.ok(feedback.issues.some((item) => item.reason === "candidate_path_missing"));
    assert.ok(feedback.referenceHints.candidateRoots.some((item) => item.path === "/instructions" && item.type === "string"));
    if (pointer) assert.ok(feedback.referenceHints.candidate.some((row) => row[1] === pointer));
    assert.deepEqual(value, before, "提示不能自动更正参数");
    assert.doesNotMatch(JSON.stringify(feedback), /instructions\.2|uncertainties\[0\]|候选自行/u);
  }
});

test("requirements错误根前缀给同一需求的合法位置，不能用draft冒充candidate", () => {
  const current = context(), value = narrowed(current);
  value.restrictions[0].path = "requirements[input].text";
  let feedback = diagnoseRequirementFidelitySubmission(current, value);
  assert.ok(feedback.issues.some((item) => item.reason === "source_path_missing"));
  assert.ok(feedback.issues.some((item) => item.reason === "source_requirement_mismatch"));
  assert.deepEqual(feedback.referenceHints.requirements, [["input", "/0/text"]]);
  value.restrictions[0] = { ...value.restrictions[0], source: "draft", path: "draft.instructions", quote: current.candidate.instructions };
  const before = structuredClone(value); feedback = diagnoseRequirementFidelitySubmission(current, value);
  assert.equal(feedback.valid, false);
  assert.ok(feedback.issues.some((item) => item.reason === "source_path_missing"));
  assert.deepEqual(feedback.referenceHints.restrictions, [{ index: 0, source: "draft", quoteAtSelectedSource: "path_missing" }]);
  assert.match(feedback.referenceHints.reminder, /候选自述不能当作原需求引文/u);
  assert.deepEqual(value, before); assert.doesNotMatch(JSON.stringify(feedback), /候选自行增加字符白名单|draft\.instructions/u);
});

test("原来源位置存在但候选自述不在其中时明确拒绝，不自动换来源", () => {
  const current = context(), value = narrowed(current);
  value.restrictions[0] = { ...value.restrictions[0], source: "draft", path: "/task", quote: current.candidate.instructions };
  const feedback = diagnoseRequirementFidelitySubmission(current, value);
  assert.equal(feedback.valid, false);
  assert.ok(feedback.issues.some((item) => item.reason === "reference_quote_mismatch" && /不能作为该处原需求/u.test(item.remedy)));
  assert.deepEqual(feedback.referenceHints.restrictions, [{ index: 0, source: "draft", quoteAtSelectedSource: "not_found" }]);
  assert.equal(value.restrictions[0].source, "draft"); assert.equal(value.restrictions[0].path, "/task");
  value.restrictions[0] = { ...value.restrictions[0], source: "requirements", path: "/0/text", quote: current.requirements[0].text };
  assert.equal(diagnoseRequirementFidelitySubmission(current, value).valid, true);
});

test("合法转义指针保持原校验，路径提示不补造缺失的缩水依据", () => {
  const current = context(); current.draft["field/~name"] = current.requirements[0].text;
  current.candidate.decisions[0]["field/~name"] = "待核实技术限制";
  const value = narrowed(current);
  value.restrictions[0] = { ...value.restrictions[0], source: "draft", path: "/field~1~0name", candidatePath: "/decisions/0/field~1~0name" };
  assert.equal(diagnoseRequirementFidelitySubmission(current, value).valid, true);
  value.checks[1].deliveryPreserved = false;
  assert.ok(diagnoseRequirementFidelitySubmission(current, value).issues.some((item) => item.reason === "restriction_missing_for_requirement"));
});

test("较大编号表和拒绝提示有界，不复制业务原文或提交者陌生字段", async () => {
  const current = context();
  current.requirements = Array.from({ length: 160 }, (_, index) => ({ id: `R${index}${"x".repeat(70)}`, text: "PRIVATE_REQUIREMENT_TEXT" }));
  current.candidate.acceptance = Array.from({ length: 160 }, (_, index) => ({ id: `A${index}${"y".repeat(70)}`, expected: "PRIVATE_CANDIDATE_TEXT" }));
  await verifyRequirementFidelity({ context: current, config: {}, cwd: "/tmp", dataDir: "/tmp",
    sessionFactory: fidelityChecker("unproven", { inspect(_payload, options) {
      const index = referenceIndex(options.systemPrompt);
      assert.ok(Buffer.byteLength(JSON.stringify(index), "utf8") <= 6000);
      assert.equal(index.requirements.total, 160); assert.equal(index.requirements.truncated, true);
      assert.equal(index.candidate.total, 161); assert.equal(index.candidate.truncated, true);
      assert.doesNotMatch(JSON.stringify(index), /PRIVATE_/u);
    } }) });
  const value = narrowed(current);
  value.restrictions = Array.from({ length: 40 }, () => ({ ...value.restrictions[0], candidatePath: "/PRIVATE_CANDIDATE_PATH",
    path: "/PRIVATE_SOURCE_PATH", quote: "PRIVATE_SUBMITTED_QUOTE" }));
  const feedback = diagnoseRequirementFidelitySubmission(current, value);
  assert.equal(feedback.valid, false); assert.ok(feedback.referenceHints.restrictions.length <= 8);
  const { contextHash: _contextHash, schemaHash: _schemaHash, ...safeFeedback } = feedback;
  assert.equal(feedback.referenceHints.truncated, true); assert.ok(JSON.stringify(safeFeedback).length <= 14000);
  assert.doesNotMatch(JSON.stringify(feedback), /PRIVATE_/u);
});
