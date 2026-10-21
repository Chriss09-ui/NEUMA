import test from "node:test";
import assert from "node:assert/strict";
import { calculateRequirementDerivation, safeCalculationPath, safeCalculationRejection } from "../src/requirements/requirement-calculations.mjs";
import { preflightRejection, safePreflightDiagnostic } from "../src/requirements/preflight-diagnostics.mjs";
import { makeProviders } from "../src/requirements/providers.mjs";
import { createPlatformSnapshot } from "../src/architecture/platform-contract.mjs";
import { contentHash, substantiveRequirementHash } from "../src/requirements/task-spec.mjs";
import { validDraft } from "./helpers/architecture.mjs";
import { sufficientPreflight } from "./helpers/consultation.mjs";

const issue = { id: "capacity", owner: "system", stage: "requirements", blocking: true, question: "边界是否足够？", impact: "决定承载路径",
  requirementIds: ["task", "deliverable"], checks: ["platform.runtime"] };
const context = () => ({ draft: { ...validDraft(), taskSpec: { version: 1, items: [] } }, platform: createPlatformSnapshot(), issues: [issue], requirementIds: ["task", "deliverable"] });
const request = () => ({ issueId: issue.id, requirementIds: issue.requirementIds,
  premises: [{ id: "rows", value: "7", unit: "count", source: { kind: "requirement", reference: "task", detail: "待独立核实的已知范围" } }],
  expressions: [{ id: "result", unit: "count", formula: { op: "multiply", args: [{ ref: "rows" }, { value: "6" }] } }] });
function rejection(input) {
  try { calculateRequirementDerivation(input, context()); assert.fail("非法结构必须拒绝"); }
  catch (error) { if (error.code === "ERR_ASSERTION") throw error; return error; }
}
function scripted(responses) {
  const calls = [];
  const providers = makeProviders({ llmConfigured: true, chatUrl: "https://model.invalid/chat", model: "fixture", apiKey: "fixture" }, async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    const value = responses[Math.min(calls.length - 1, responses.length - 1)];
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(typeof value === "function" ? await value(body) : value) } }] }), { status: 200 });
  });
  return { ...providers, calls };
}

test("可恢复的 JSON 错误不覆盖候选或独立复核随后真正终止的原因", async (t) => {
  const assessment = { ...await sufficientPreflight(), verdict: "blocked", issues: [issue] };
  for (const role of ["assessment", "issue_review"]) await t.test(role, async () => {
    let calls = 0;
    const providers = makeProviders({ llmConfigured: true, chatUrl: "https://model.invalid/chat", model: "fixture", apiKey: "fixture" }, async () => {
      calls++;
      if (role === "issue_review" && calls <= 2)
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(assessment) } }] }));
      if (calls === (role === "assessment" ? 1 : 3)) return role === "assessment"
        ? new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }))
        : new Response("not json");
      return new Response("{}", { status: 400 });
    }, { verifySystemIssues: async ({ issues }) => issues.map((entry) => ({ id: entry.id, status: "verified", message: "只读平台事实", evidence: [
      { source: "platform", reference: "platform.runtime", detail: "当前宿主边界；业务仍待验收" },
    ] })) });
    const ctx = context();
    await assert.rejects(providers.preflight({ draft: ctx.draft, platform: ctx.platform }), (error) => {
      assert.equal(error.diagnostic.reason, "http_error");
      assert.equal(error.preflightDiagnostic.stopReason, "model_api_failed");
      assert.equal(error.preflightDiagnostic.modelTurns, calls);
      assert.deepEqual(error.preflightDiagnostic.events.slice(-2).map(({ role: eventRole, reason }) => ({ role: eventRole, reason })), [
        { role, reason: "model_invalid_json" }, { role, reason: "model_api_failed" },
      ]);
      return true;
    });
    assert.equal(calls, role === "assessment" ? 2 : 4);
  });
});

test("持续无效 JSON 按原六轮终止，修复成功按实际结论记录原因", async () => {
  const ctx = context(); let calls = 0;
  const config = { llmConfigured: true, chatUrl: "https://model.invalid/chat", model: "fixture", apiKey: "fixture" };
  const malformed = () => new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }));
  const failed = makeProviders(config, async () => { calls++; return malformed(); });
  await assert.rejects(failed.preflight({ draft: ctx.draft, platform: ctx.platform }), (error) => {
    assert.equal(error.reason, "budget_exhausted"); assert.equal(error.preflightDiagnostic.stopReason, "budget_exhausted");
    assert.equal(error.preflightDiagnostic.modelTurns, 6); assert.equal(error.preflightDiagnostic.readOnlyCalls, 0);
    assert.equal(error.preflightDiagnostic.events.filter((entry) => entry.reason === "model_invalid_json").length, 6);
    return true;
  });
  assert.equal(calls, 6);
  calls = 0;
  const sufficient = await sufficientPreflight();
  const recovered = makeProviders(config, async () => {
    calls++; return calls === 1 ? malformed()
      : new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(sufficient) } }] }));
  });
  const result = await recovered.preflight({ draft: ctx.draft, platform: ctx.platform });
  assert.equal(calls, 2); assert.equal(result.verdict, "sufficient");
  assert.equal(result.preflightDiagnostic.stopReason, "sufficient"); assert.equal(result.preflightDiagnostic.modelTurns, 2);
});

test("计算结构错误准确标记顶层、来源和嵌套公式，只公开固定键", () => {
  for (const [change, path, expectedFields, missingFields, unexpectedFields] of [
    [(value) => { delete value.expressions; }, "calculate", ["issueId", "requirementIds", "premises", "expressions"], ["expressions"], false],
    [(value) => { delete value.premises[0].source.detail; }, "calculate.premises[0].source", ["kind", "reference", "detail"], ["detail"], false],
    [(value) => { value.expressions[0].formula.args[1] = { PRIVATE_DYNAMIC_KEY: "PRIVATE_RAW_VALUE" }; }, "calculate.expressions[0].formula.args[1]", ["op", "args"], ["op", "args"], true],
  ]) {
    const input = request(); change(input); const error = rejection(input);
    assert.equal(error.reason, "calculation_shape_invalid");
    assert.deepEqual(error.reject, { path, expectedFields, missingFields, unexpectedFields });
    assert.deepEqual(preflightRejection(error), { reason: error.reason, paths: [path] });
    assert.doesNotMatch(JSON.stringify({ message: error.message, ...error }), /PRIVATE_/);
  }
  const source = request(); source.premises[0].source.reference = "PRIVATE_RAW_VALUE";
  assert.equal(rejection(source).reject.path, "calculate.premises[0].source.reference");
  const number = request(); number.premises[0].value = 7;
  const error = rejection(number); assert.equal(error.reason, "calculation_integer_invalid"); assert.equal(error.reject.path, "calculate.premises[0].value");
});

test("getter和序列化钩子不执行，错误定位父结构而不泄漏动态键", () => {
  let executed = false;
  for (const key of ["reference", "PRIVATE_DYNAMIC_KEY", "toJSON"]) {
    const input = request(); Object.defineProperty(input.premises[0].source, key, { enumerable: true, get() { executed = true; return "PRIVATE_VALUE"; } });
    const error = rejection(input);
    assert.equal(error.reject.path, "calculate.premises[0].source"); assert.equal(executed, false);
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE_|toJSON/);
  }
});

test("共享路径和拒绝清理器只允许固定语法、有界索引与固定字段名", () => {
  for (const path of ["calculate", "calculate.issueId", "calculate.requirementIds[119]", "calculate.premises[31].source.reference",
    "calculate.expressions[15].formula.args[15].args[0].value"]) assert.equal(safeCalculationPath(path), path);
  for (const path of ["calculate.PRIVATE_KEY", "calculate.premises[32].id", "calculate.expressions[16].formula", "calculate.requirementIds[120]",
    "calculate.expressions[0].formula.args[16].ref", "calculate.expressions[0].formula.__proto__", "calculate.premises[01].id",
    "calculate.expressions[0].formula" + ".args[0]".repeat(13), null]) assert.equal(safeCalculationPath(path), null);
  const safe = { path: "calculate.premises[0].source", expectedFields: ["kind", "reference", "detail"], missingFields: ["detail"], unexpectedFields: true };
  assert.deepEqual(safeCalculationRejection({ ...safe, PRIVATE_KEY: "PRIVATE_VALUE" }), safe);
  assert.equal(safeCalculationRejection({ ...safe, expectedFields: ["PRIVATE_KEY"] }), null);
  assert.equal(safeCalculationRejection({ ...safe, path: "calculate.PRIVATE_KEY" }), null);
  assert.equal(safeCalculationRejection({ ...safe, missingFields: ["op"] }), null);
  const forged = { ...safe }; let executed = false; Object.defineProperty(forged, "path", { get() { executed = true; return "calculate"; } });
  assert.equal(safeCalculationRejection(forged), null); assert.equal(executed, false);
  const diagnostic = safePreflightDiagnostic({ version: 1, modelTurns: 1, events: [{ role: "calculation", reason: "calculation_shape_invalid",
    paths: [safe.path, "calculate.PRIVATE_KEY", "calculate.premises[999].source", "PRIVATE_VALUE"] }] });
  assert.deepEqual(diagnostic.events[0].paths, [safe.path]); assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_/);
});

test("合法计算回执的内容与摘要保持原协议，不附加错误诊断", () => {
  const input = request(), ctx = context();
  const binding = { issueId: input.issueId, requirementIds: input.requirementIds, requirementHash: substantiveRequirementHash(ctx.draft),
    platformHash: contentHash(ctx.platform), requestHash: contentHash(input) };
  const expected = { id: `calculation_${contentHash(binding).slice(0, 32)}`, status: "calculated", ...binding, premises: input.premises,
    expressions: [{ ...input.expressions[0], value: "42" }], scope: "只证明给定前提和公式的精确整数计算；前提数值、单位、完整性及适用性仍须独立复核，不证明程序或业务已通过验收。" };
  assert.deepEqual(calculateRequirementDerivation(input, ctx), expected);
});

test("模型收到精确安全拒绝后在原预算修正，失败没有回执且诊断路径一致", async () => {
  const invalid = request(); delete invalid.premises[0].source.detail; invalid.premises[0].source.PRIVATE_KEY = "PRIVATE_VALUE";
  let receipt;
  const assessment = { ...await sufficientPreflight(), verdict: "blocked", issues: [issue] };
  const real = scripted([{ calculate: invalid }, { calculate: request() }, assessment, (body) => {
    const payload = JSON.parse(body.messages[1].content); receipt = payload.derivations[0];
    return { decisions: [{ issueId: issue.id, owner: "system", status: "open", stage: "requirements", checks: ["platform.runtime"],
      derivationIds: [receipt.id], evidence: [], reason: "算术有效，但前提仍需可信依据，不自动关闭" }] };
  }]);
  const ctx = context(), output = await real.preflight({ draft: ctx.draft, platform: ctx.platform, previousIssues: [issue] });
  assert.equal(real.calls.length, 4); assert.equal(output.preflightDiagnostic.calculationCalls, 1); assert.equal(output.preflightDiagnostic.readOnlyCalls, 1);
  const feedback = JSON.parse(real.calls[1].messages.at(-1).content).calculation;
  assert.equal(feedback.receiptGenerated, false); assert.equal(feedback.error, "calculation_shape_invalid");
  assert.equal(feedback.reject.path, "calculate.premises[0].source"); assert.deepEqual(feedback.reject.missingFields, ["detail"]); assert.equal(feedback.reject.unexpectedFields, true);
  assert.match(feedback.message, /未生成计算回执/); assert.match(feedback.message, /原剩余预算/);
  assert.doesNotMatch(JSON.stringify(feedback), /PRIVATE_/);
  assert.equal(output.derivations.length, 1); assert.equal(receipt.status, "calculated"); assert.equal(receipt.expressions[0].value, "42");
  const failed = output.preflightDiagnostic.events.find((entry) => entry.reason === "calculation_shape_invalid");
  assert.deepEqual(failed.paths, [feedback.reject.path]); assert.doesNotMatch(JSON.stringify(output.preflightDiagnostic), /PRIVATE_/);
});

test("重复结构失败只消耗原六回合，不占实际只读额度；额外外层字段不回传名称", async () => {
  const malformed = request(); delete malformed.expressions;
  const real = scripted([{ calculate: malformed, PRIVATE_OUTER_KEY: "PRIVATE_VALUE" }]), ctx = context();
  await assert.rejects(real.preflight({ draft: ctx.draft, platform: ctx.platform, previousIssues: [issue] }), (error) => {
    assert.equal(error.preflightDiagnostic.modelTurns, 6); assert.equal(error.preflightDiagnostic.calculationCalls, undefined);
    assert.equal(error.preflightDiagnostic.readOnlyCalls, 0); assert.doesNotMatch(JSON.stringify(error.preflightDiagnostic), /PRIVATE_/); return true;
  });
  assert.equal(real.calls.length, 6);
  const feedback = JSON.parse(real.calls[1].messages.at(-1).content).calculation;
  assert.equal(feedback.receiptGenerated, false); assert.deepEqual(feedback.reject, { path: "calculate", expectedFields: ["calculate"], missingFields: [], unexpectedFields: true });
  assert.doesNotMatch(JSON.stringify(feedback), /PRIVATE_/);
});
