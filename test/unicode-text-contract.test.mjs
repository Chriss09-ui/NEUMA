import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeEvidence, normalizeTaskSpec, taskSpecDiagnostic, taskSpecSchema } from "../src/requirements/task-spec.mjs";
import { REQUIREMENT_DRAFT_MAX_BYTES } from "../src/requirements/requirement-limits.mjs";
import { preflightSchema, validatePreflight } from "../src/requirements/consultation.mjs";
import { checkedSystemProgress, systemProgressSchema } from "../src/requirements/requirement-progress.mjs";
import { checkedFactProgress, trustedFactProgressSchema } from "../src/requirements/requirement-facts.mjs";
import { calculateRequirementDerivation, calculationRequestSchema } from "../src/requirements/requirement-calculations.mjs";
import { replyTool } from "../src/collaboration/group-tools.mjs";
import { createTechnicalResearch, RESEARCH_PARAMETERS } from "../src/architecture/architecture-research.mjs";
import { ArchitectureDesigner } from "../src/architecture/architecture.mjs";
import { validateHandoffProposal } from "../src/architecture/architecture-handoff-verification.mjs";
import { validDraft, validDesign, passingReview } from "./helpers/architecture.mjs";
import { sufficientPreflight } from "./helpers/consultation.mjs";
import { fidelityChecker } from "./helpers/fidelity.mjs";

const ajv = new Ajv({ strict: false, allErrors: true });
const astral = (length) => "𠮷".repeat(length);

test("任务内容、推导和依据按Unicode字符与公开结构同界，保存不截断", () => {
  const value = { version: 1, items: [{ id: "input", dimension: "input_scale", content: astral(2000),
    applicability: "applies", critical: true, source: { kind: "inferred", reason: astral(2000),
      evidence: [{ messageId: "user_1", quote: astral(4000) }] } }],
  retired: [{ id: "old", reason: astral(2000), evidence: [{ messageId: "user_1", quote: astral(4000) }] }] };
  const validate = ajv.compile(taskSpecSchema());
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  assert.deepEqual(normalizeTaskSpec(value), value);
  const messages = [{ id: "user_1", role: "user", content: astral(16000) }];
  assert.deepEqual(mergeEvidence([], messages), messages);
  for (const mutate of [
    (entry) => { entry.items[0].content += "𠮷"; },
    (entry) => { entry.items[0].source.reason += "𠮷"; },
    (entry) => { entry.items[0].source.evidence[0].quote += "𠮷"; },
    (entry) => { entry.retired[0].reason += "𠮷"; },
  ]) {
    const invalid = structuredClone(value); mutate(invalid);
    assert.equal(validate(invalid), false); assert.throws(() => normalizeTaskSpec(invalid));
  }
});

test("预评估各级文案的Unicode上限与模型可见结构一致", async () => {
  const draft = validDraft(), value = await sufficientPreflight();
  value.verdict = "needs_input";
  value.direction = value.adequacy = astral(3000);
  for (const check of value.dimensionChecks) check.reason = astral(3000);
  value.issues = [{ id: "choice", owner: "user", blocking: true, question: astral(1000),
    impact: astral(3000), requirementIds: ["goal"] }];
  const validate = ajv.compile(preflightSchema(draft));
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  assert.deepEqual(validatePreflight(value, draft), value);
  for (const mutate of [
    (entry) => { entry.direction += "𠮷"; },
    (entry) => { entry.dimensionChecks[0].reason += "𠮷"; },
    (entry) => { entry.issues[0].question += "𠮷"; },
    (entry) => { entry.issues[0].impact += "𠮷"; },
  ]) {
    const invalid = structuredClone(value); mutate(invalid);
    assert.equal(validate(invalid), false); assert.throws(() => validatePreflight(invalid, draft));
  }
});

test("合法单项叠加超出公开总量时原子拒绝并保留准确大小诊断", () => {
  const value = { version: 1, items: Array.from({ length: 45 }, (_, index) => ({ id: `item_${index}`,
    dimension: "input_scale", content: "保留完整处理范围", applicability: "applies", critical: true,
    source: { kind: "user", evidence: Array.from({ length: 12 }, () => ({ messageId: "user_1", quote: "字".repeat(4000) })) } })) };
  assert.equal(ajv.compile(taskSpecSchema())(value), true);
  const before = JSON.stringify(value);
  assert.throws(() => normalizeTaskSpec(value), (error) => {
    const diagnostic = taskSpecDiagnostic(error);
    assert.deepEqual(diagnostic, { rejection: "task_spec_too_large", paths: ["taskSpec"],
      bytes: Buffer.byteLength(before), limitBytes: REQUIREMENT_DRAFT_MAX_BYTES });
    assert.ok(diagnostic.bytes > diagnostic.limitBytes); return true;
  });
  assert.equal(JSON.stringify(value), before);
});

test("系统依据续接和事实缺口文案用同一Unicode结构边界", () => {
  const basisHash = "a".repeat(64), progress = { basisHash, established: astral(3000), missing: astral(3000),
    nextAction: { kind: "review", detail: astral(3000) } };
  const basis = { basisHash, checks: [], derivationIds: [] }, issue = { id: "capacity", question: "核实当前范围" };
  const decision = { reason: "仍需独立核实", progress };
  const validate = ajv.compile(systemProgressSchema(basisHash));
  assert.equal(validate(progress), true);
  assert.equal(checkedSystemProgress(issue, decision, basis, { required: true }).established, progress.established);
  const facts = [{ id: `fact_${"b".repeat(32)}`, status: "unknown" }];
  const missingFacts = [{ factId: facts[0].id, status: "unknown", detail: astral(3000) }];
  const withFacts = { ...progress, missingFacts }, factOptions = { required: true };
  assert.equal(ajv.compile(trustedFactProgressSchema(systemProgressSchema(basisHash), facts, factOptions))(withFacts), true);
  assert.deepEqual(checkedFactProgress(withFacts, facts, factOptions), { missingFacts });
  const invalid = structuredClone(progress); invalid.nextAction.detail += "𠮷";
  assert.equal(validate(invalid), false);
  assert.throws(() => checkedSystemProgress(issue, { ...decision, progress: invalid }, basis, { required: true }));
  assert.throws(() => checkedFactProgress({ ...progress, missingFacts: [{ ...missingFacts[0], detail: `${missingFacts[0].detail}𠮷` }] }, facts, factOptions));
});

test("只读算式前提说明的Unicode上限与计算工具结构一致", () => {
  const context = { draft: validDraft(), platform: {}, requirementIds: ["task"],
    issues: [{ id: "capacity", owner: "system", requirementIds: ["task"] }] };
  const request = { issueId: "capacity", requirementIds: ["task"], premises: [{ id: "rows", value: "12", unit: "count",
    source: { kind: "requirement", reference: "task", detail: astral(1000) } }],
  expressions: [{ id: "result", unit: "count", formula: { ref: "rows" } }] };
  const validate = ajv.compile(calculationRequestSchema(context));
  assert.equal(validate(request), true, JSON.stringify(validate.errors));
  assert.equal(calculateRequirementDerivation(request, context).expressions[0].value, "12");
  const invalid = structuredClone(request); invalid.premises[0].source.detail += "𠮷";
  assert.equal(validate(invalid), false); assert.throws(() => calculateRequirementDerivation(invalid, context));
});

test("正式返需的Unicode问题和影响保持原文并接受同界交接", () => {
  const context = { requirements: [{ id: "task", text: "仍需业务取舍" }] };
  const proposal = { id: "choice", question: astral(1000), impact: astral(2000), requirementIds: ["task"],
    references: [{ source: "requirements", path: "/0/text", quote: "业务取舍" }] };
  assert.deepEqual(validateHandoffProposal([proposal], context), [proposal]);
  for (const field of ["question", "impact"]) assert.throws(() => validateHandoffProposal([{ ...proposal, [field]: `${proposal[field]}𠮷` }], context));
});

test("群接话公开结构接受的Unicode边界可以实际提交，超一字符仍拒绝", async () => {
  let captured;
  const tool = replyTool((value) => { captured = value; }), validate = ajv.compile(tool.parameters);
  const value = { reply: astral(4000) };
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  await tool.execute("unicode-reply", value);
  assert.equal(captured.reply, value.reply);
  const invalid = { reply: `${value.reply}𠮷` };
  assert.equal(validate(invalid), false); await assert.rejects(tool.execute("too-long", invalid));
  await assert.rejects(tool.execute("nul", { reply: "不能\0存储" }));
});

test("只读研究查询用Unicode字符校验，边界不触发真实联网", async () => {
  const research = createTechnicalResearch({ fetchImpl: () => assert.fail("不匹配目录时不得联网") });
  const validate = ajv.compile(RESEARCH_PARAMETERS), value = { query: astral(1000) };
  assert.equal(validate(value), true);
  assert.deepEqual((await research.search(value)).sources, []);
  const invalid = { query: `${value.query}𠮷` };
  assert.equal(validate(invalid), false); await assert.rejects(research.search(invalid), TypeError);
});

test("架构委派和模块正式提交按各自公开Unicode边界完成交接", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-unicode-module-"));
  const assignment = { question: astral(2000), boundary: astral(2000), benefit: astral(2000) };
  const module = { proposal: astral(8000), interfaces: astral(4000), tradeoffs: astral(4000), evidenceIds: [], unknowns: [astral(2000)] };
  const roles = [];
  const sessionFactory = async (options) => {
    const tools = Object.fromEntries(options.customTools.map((tool) => [tool.name, tool]));
    const execute = async (name, value) => {
      const validate = ajv.compile(tools[name].parameters);
      assert.equal(validate(value), true, JSON.stringify(validate.errors));
      return tools[name].execute(`unicode-${name}`, value);
    };
    return { messages: [], subscribe: () => () => {}, dispose() {}, async abort() {}, async prompt(message) {
      const payload = JSON.parse(message);
      if (tools.submit_module_design) {
        roles.push("specialist");
        await assert.rejects(tools.submit_module_design.execute("over-interface-limit", { ...module, interfaces: `${module.interfaces}𠮷` }));
        return execute("submit_module_design", structuredClone(module));
      }
      if (tools.submit_architecture) {
        roles.push("designer");
        await execute("delegate_module", { modules: [structuredClone(assignment)] });
        return execute("submit_architecture", validDesign(payload.requirements));
      }
      roles.push("reviewer");
      return execute("submit_architecture_review", passingReview(payload.candidateHash, payload.design));
    } };
  };
  const designer = new ArchitectureDesigner({ config: { llmConfigured: true }, cwd: root, dataDir: join(root, "data"),
    sessionFactory, fidelitySessionFactory: fidelityChecker() });
  t.after(async () => { await designer.persistence; await rm(root, { recursive: true, force: true }); });
  const record = await designer.design({ id: "unicode", name: "字符边界", draft: validDraft(), fingerprint: "unicode-contract" });
  assert.equal(record.status, "passed");
  assert.deepEqual(record.modules, [{ assignment, result: module }]);
  assert.deepEqual(roles, ["designer", "specialist", "reviewer"]);
});
