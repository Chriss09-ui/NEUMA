import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyRequirementFidelity } from "../src/architecture/requirement-fidelity.mjs";
import { ArchitectureDesigner } from "../src/architecture/architecture.mjs";
import { designHash, requirementItems, reviewSubmissionSchema, validateReview } from "../src/architecture/architecture-contract.mjs";
import { InputError } from "../src/requirements/core.mjs";
import { createPiSession } from "../src/runtime/pi-runtime.mjs";
import { fidelityChecker, fidelityResult } from "./helpers/fidelity.mjs";
import { validDraft, validDesign, passingReview } from "./helpers/architecture.mjs";
import { DESIGN_PROMPT, REVIEW_PROMPT } from "../src/architecture/architecture-prompts.mjs";
import { ACCEPTANCE_ADAPTER_GUIDE } from "../src/verification/acceptance-contract.mjs";
import { architectureStageSubmission } from "./helpers/architecture-stages.mjs";

function context() {
  return { requirements: [{ id: "input", text: "扩展名允许任意字符，长度1至16，包含点" }, { id: "delivery", text: "完整输出全部记录，不抽样" }],
    draft: { accepted: "任意字符，完整处理" }, confirmedRequirementContext: { quote: "不增加字符白名单" },
    candidate: { instructions: "采用ASCII字母数字和点的白名单；其他字符拒绝" }, runtimeCapabilities: { version: 1 } };
}
const invoke = (options) => verifyRequirementFidelity({ context: context(), config: {}, cwd: "/tmp", dataDir: "/tmp", ...options });

test("独立只读范围判断绑定完整上下文，每项原要求均核对而不改变输入", async () => {
  const current = context(), before = structuredClone(current), charges = [];
  const result = await invoke({ context: current, sessionFactory: fidelityChecker("preserved", { inspect(payload, options) {
    assert.deepEqual(options.customTools.map((item) => item.name), ["submit_requirement_fidelity"]);
    assert.match(options.systemPrompt, /role=requirement-fidelity，submitName=submit_requirement_fidelity/u);
    assert.match(options.systemPrompt, /结构化结果也是本阶段正式提交通道/u);
    assert.equal(options.reasoningMode, "off");
    assert.equal(options.maxOutputTokens, 8192, "关闭思考不改变原角色输出上限");
    assert.match(options.systemPrompt, /不要求立即提交，不跳过既有检查，也不改变预算/u);
    assert.deepEqual(payload.candidate, current.candidate); assert.deepEqual(payload.confirmedRequirementContext, current.confirmedRequirementContext);
  } }), charge(event) { charges.push(event); } });
  assert.equal(result.verdict, "preserved"); assert.equal(result.contextHash, designHash({ ...current,
    acceptanceAdapterGuide: ACCEPTANCE_ADAPTER_GUIDE, acceptanceAdapterGuideSource: "current-default" })); assert.equal(result.modelCalls, 1);
  assert.deepEqual(result.checks.map((item) => item.requirementId), ["input", "delivery"]); assert.deepEqual(current, before); assert.equal(charges.length, 1);
});

test("保守实现理由不能把已检出的新增输入限制改成preserved", async () => {
  let attempts = 0;
  const result = await invoke({ sessionFactory: async (options) => ({ modelCallAccounting: true, dispose() {},
    async prompt(text) {
      const payload = JSON.parse(text), value = fidelityResult(payload, "narrowed");
      value.restrictions[0].reason = "为了方便编码和保守实现，选择ASCII白名单";
      await options.onModelCall(); attempts++;
      await assert.rejects(options.customTools[0].execute("invalid", { ...value, verdict: "preserved" }), /新增未确认限制不能判为保持范围/);
      await options.onModelCall(); attempts++;
      await options.customTools[0].execute("corrected", value);
    } }) });
  assert.equal(result.verdict, "narrowed"); assert.equal(result.modelCalls, 2); assert.equal(attempts, 2);
});

test("验收输入和交付前提的新增约束沿原checks提交，依据须匹配原文及实际候选路径", async () => {
  const scenarios = [
    { text: "输入数量、每项字段长度和总体大小同时受已确认边界约束，总体大小不超过声明上限。",
      candidate: { instructions: "保持原受理范围", acceptance: [{ input: "合法样本必须在其他约束下达到或接近总体大小上限", expected: "完整处理" }] },
      candidatePath: "/acceptance/0/input", admissionPreserved: true,
      reason: "候选把不超过上限改为必须达到的交付条件，没有原来源或可达性依据。" },
    { text: "完整处理所有符合原边界的输入，不增加额外交付前提。",
      candidate: { instructions: "保持原受理范围", acceptance: [{ input: "符合原边界的代表输入", expected: "只有样本同时触及每项独立上限才允许交付" }] },
      candidatePath: "/acceptance/0/expected", admissionPreserved: true,
      reason: "候选expected增加了来源未确认的必须条件，独立上限不能自动证明同时可达。" },
    { text: "业务文本允许任意字符，沿用已确认长度限制，不增加字符白名单。",
      candidate: { instructions: "保持原受理范围", decisions: [{ choice: "为简化验收，排除代理对字符和控制字符，只测试其他原合法字符" }] },
      candidatePath: "/decisions/0/choice", admissionPreserved: false,
      reason: "候选通过未确认字符假设排除了原来源允许的业务字符串，方便计算不能授权此限制。" },
  ];
  for (const scenario of scenarios) {
    const current = { requirements: [{ id: "input", text: scenario.text }], draft: {}, confirmedRequirementContext: {}, candidate: scenario.candidate };
    const original = structuredClone(current); let calls = 0;
    const result = await invoke({ context: current, charge() { calls++; }, sessionFactory: async (options) => ({
      modelCallAccounting: true, dispose() {}, async prompt(text) {
        await options.onModelCall(); const payload = JSON.parse(text), tool = options.customTools[0];
        assert.deepEqual(options.customTools.map(({ name }) => name), ["submit_requirement_fidelity"]);
        assert.match(options.systemPrompt, /acceptance\.input、acceptance\.expected及decisions/u);
        assert.match(options.systemPrompt, /按交集核对样本可达性/u);
        assert.match(options.systemPrompt, /无代理对字符.*无控制字符/u);
        assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["checks", "contextHash", "restrictions", "verdict"]);
        assert.deepEqual(Object.keys(tool.parameters.properties.checks.items.properties).sort(),
          ["admissionPreserved", "deliveryPreserved", "newUnconfirmedRestriction", "requirementId"]);
        const value = fidelityResult(payload, "narrowed", { candidatePath: scenario.candidatePath });
        value.checks[0] = { requirementId: "input", admissionPreserved: scenario.admissionPreserved, deliveryPreserved: false, newUnconfirmedRestriction: true };
        value.restrictions[0].reason = scenario.reason;
        await assert.rejects(tool.execute("bad_quote", { ...value, restrictions: [{ ...value.restrictions[0], quote: "来源未曾说明的引文" }] }),
          (error) => error.validationIssues.some((issue) => issue.reason === "reference_quote_mismatch"));
        await assert.rejects(tool.execute("bad_candidate_path", { ...value, restrictions: [{ ...value.restrictions[0], candidatePath: "/acceptance/not_an_index/input" }] }),
          (error) => error.validationIssues.some((issue) => issue.reason === "candidate_path_missing"));
        await tool.execute("current_evidence", value);
      },
    }) });
    assert.equal(result.verdict, "narrowed"); assert.equal(result.modelCalls, 1); assert.equal(calls, 1);
    assert.equal(result.restrictions[0].candidatePath, scenario.candidatePath);
    assert.equal(result.restrictions[0].source, "requirements"); assert.equal(result.restrictions[0].path, "/0/text");
    assert.equal(result.restrictions[0].quote, scenario.text);
    assert.deepEqual(current, original);
  }
});

test("验收可构造性未证明可用既有unproven返回，合法自选样本不增加用户确认步骤", async () => {
  for (const classification of ["unproven", "preserved"]) {
    const current = { requirements: [{ id: "input", text: "按已确认边界完整处理合法输入。" }], draft: {}, confirmedRequirementContext: {},
      candidate: { instructions: "保持原约束，不增加字符限制。", acceptance: [{ input: classification === "unproven"
        ? "尚无可达性依据的边界组合" : "系统自行选取满足全部原约束的代表性样本", expected: "完整输出" }] } };
    let charges = 0;
    const result = await invoke({ context: current, charge() { charges++; }, sessionFactory: async (options) => ({
      modelCallAccounting: true, dispose() {}, async prompt(text) {
        await options.onModelCall(); const payload = JSON.parse(text), value = fidelityResult(payload, classification);
        assert.match(options.systemPrompt, /不要求用户提供具体样本或逐一确认可选质量提升/u);
        assert.match(options.systemPrompt, /可构造性尚无足够依据时判unproven，不能判preserved/u);
        assert.deepEqual(options.customTools.map(({ name }) => name), ["submit_requirement_fidelity"]);
        if (classification === "unproven") value.checks[0].deliveryPreserved = false;
        await options.customTools[0].execute("classification", value);
      },
    }) });
    assert.equal(result.verdict, classification); assert.equal(result.modelCalls, 1); assert.equal(charges, 1);
    assert.equal(result.restrictions.length, 0);
  }
});

test("架构设计与主评审共享验收约束可达性指导，保留系统自选样本的范围", () => {
  for (const prompt of [DESIGN_PROMPT, REVIEW_PROMPT]) {
    assert.match(prompt, /acceptance\.input、acceptance\.expected和decisions中的验收前提/u);
    assert.match(prompt, /按交集推导最大合法集合/u);
    assert.match(prompt, /无代理对字符\/无控制字符/u);
    assert.match(prompt, /不要求用户提供具体样本或逐一确认可选质量提升/u);
    assert.match(prompt, /可构造性未证明不能据此宣布范围保持/u);
  }
  assert.match(DESIGN_PROMPT, /仅当本轮宿主提供editableSubmission时/u);
  assert.match(DESIGN_PROMPT, /没有该宿主编号时，首次仍用本阶段公开的提交工具提交完整工具参数/u);
  assert.match(DESIGN_PROMPT, /untrusted-reference，不代表通过或新增授权/u);
});

test("假引文、错误候选路径、错需求引用、未对应的缩水flags和重复需求不得形成有效决定", async () => {
  for (const change of [
    (value) => { value.restrictions[0].quote = "PRIVATE_FAKE_QUOTE"; },
    (value) => { value.restrictions[0].candidatePath = "/PRIVATE_FAKE_PATH"; },
    (value, payload) => { value.restrictions[0].path = "/1/text"; value.restrictions[0].quote = payload.requirements[1].text; },
    (value) => { value.checks[0].admissionPreserved = true; value.checks[0].newUnconfirmedRestriction = false; value.checks[1].admissionPreserved = false; },
    (value) => { value.checks[1].requirementId = value.checks[0].requirementId; },
  ]) await assert.rejects(invoke({ sessionFactory: async (options) => ({ modelCallAccounting: true, dispose() {}, async prompt(text) {
    await options.onModelCall(); const payload = JSON.parse(text), value = fidelityResult(payload, "narrowed"); change(value, payload);
    await assert.rejects(options.customTools[0].execute("bad", value), (error) => !error.message.includes("PRIVATE_"));
  } }) }), (error) => error.reason === "scope_evaluation_incomplete" && !error.message.includes("PRIVATE_"));
});

test("子复核至多两次实际调用、网络重试不重扣共享预算，耗尽仍是系统未完成", async () => {
  let charges = 0;
  await assert.rejects(invoke({ charge() { charges++; }, sessionFactory: async (options) => ({ modelCallAccounting: true, dispose() {}, async prompt() {
    await options.onModelCall(); await options.onModelCall({ retryAttempt: 1 }); await options.onModelCall(); await options.onModelCall();
  } }) }), (error) => error.reason === "scope_evaluation_incomplete" && error.modelCalls === 2);
  assert.equal(charges, 2);
  const stop = Object.assign(new InputError("原评审预算已用完"), { reason: "turn_limit" });
  await assert.rejects(invoke({ charge() { throw stop; }, sessionFactory: fidelityChecker() }), (error) => error === stop);
});

test("取消向独立会话传播，迟到提交不能改变已结束复核", async () => {
  const controller = new AbortController(), stop = new Error("fixture-cancelled"); let aborted = 0, disposed = 0, late, payload;
  await assert.rejects(invoke({ signal: controller.signal, sessionFactory: async (options) => ({ modelCallAccounting: true,
    async abort() { aborted++; }, dispose() { disposed++; }, async prompt(text) {
      await options.onModelCall(); payload = JSON.parse(text); late = options.customTools[0]; controller.abort(stop);
      await late.execute("cancelled", fidelityResult(payload));
    } }) }), (error) => error === stop);
  assert.equal(aborted, 1); assert.equal(disposed, 1);
  await assert.rejects(late.execute("late", fidelityResult(payload)), (error) => error === stop);
});

async function roleFixture(t, { classification = "preserved", mainCalls = 1, retry = false, childFactory, hook = true, verdict = "pass", onDiagnostics } = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-fidelity-role-")); let childSessions = 0, mainSessions = 0;
  const current = context(), candidateHash = designHash(current.candidate);
  const designer = new ArchitectureDesigner({ config: { llmConfigured: true }, cwd: root, dataDir: root,
    fidelitySessionFactory: async (options) => { childSessions++; assert.equal(options.reasoningMode, "off"); return (childFactory ?? fidelityChecker(classification))(options); },
    sessionFactory: async (options) => { mainSessions++; const tool = options.customTools.find((item) => item.name === "submit_architecture_review");
      assert.equal(options.reasoningMode, "off");
      return { modelCallAccounting: true, messages: [], subscribe: () => () => {}, dispose() {}, async abort() {}, async prompt() {
        for (let index = 0; index < mainCalls; index++) await options.onModelCall();
        if (retry) await options.onModelCall({ retryAttempt: 1 });
        const review = passingReview(candidateHash);
        if (verdict !== "pass") { review.verdict = verdict; review.checks[0].passed = false; review.issues = [{ id: "fixture_issue", blocking: true, description: "需保留原输入范围", remedy: "修正候选新增限制" }]; }
        await tool.execute("final", review);
      } }; } });
  t.after(async () => { await designer.ready; await designer.persistence; await rm(root, { recursive: true, force: true }); });
  return { designer, run: () => designer.role({ role: "reviewer", systemPrompt: "固定独立评审", submitName: "submit_architecture_review",
    parameters: reviewSubmissionSchema(), payload: { requirements: current.requirements, draft: current.draft,
      design: current.candidate, candidateHash, requireAcceptanceVerification: hook },
    validate: (value) => validateReview(value, { candidateHash }), onProgress() {}, onDiagnostics }), counts: () => ({ childSessions, mainSessions }) };
}

test("只对新需求评审pass启动复核，有效narrowed和unproven直接停止而不重抄主评审", async (t) => {
  for (const classification of ["narrowed", "unproven"]) {
    const fixture = await roleFixture(t, { classification });
    await assert.rejects(fixture.run(), (error) => error.diagnostic.reason === "scope_not_preserved"
      && error.diagnostic.modelCalls === 2 && error.diagnostic.requirementFidelity.verdict === classification);
    assert.deepEqual(fixture.counts(), { childSessions: 1, mainSessions: 1 });
  }
  for (const options of [{ hook: false }, { verdict: "revise" }]) {
    const fixture = await roleFixture(t, { ...options, childFactory: async () => { throw new Error("不得启动额外复核"); } });
    assert.equal((await fixture.run()).verdict, options.verdict ?? "pass"); assert.equal(fixture.counts().childSessions, 0);
  }
});

test("原评审与子复核共享5轮，子模型故障不能转成需求缺口或pass", async (t) => {
  const last = await roleFixture(t, { mainCalls: 4, retry: true }); assert.equal((await last.run()).verdict, "pass");
  const exhausted = await roleFixture(t, { mainCalls: 5 });
  await assert.rejects(exhausted.run(), (error) => error.diagnostic.reason === "turn_limit" && error.diagnostic.modelCalls === 5);
  const fault = await roleFixture(t, { childFactory: async () => { throw new Error("PRIVATE_PROVIDER_ERROR"); } });
  await assert.rejects(fault.run(), (error) => error.diagnostic.reason === "scope_evaluation_incomplete" && !error.message.includes("PRIVATE_"));
});

test("真实Pi假引文在原复核纠正，有效范围否定直接给设计者修订后才重新完整评审", { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-fidelity-sdk-")), requests = [];
  let designs = 0, reviewers = 0, fidelities = 0, serverFailure, fixedCandidate;
  const draft = validDraft();
  draft.taskSpec = { version: 1, items: [{ id: "characters", dimension: "processing", content: "扩展名允许任意字符，长度1至16，包含点",
    applicability: "applies", critical: true, source: { kind: "user", evidence: [{ messageId: "scope", quote: "允许任意字符" }] } }] };
  const model = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)), names = body.tools.map((item) => item.function.name);
      const name = ["submit_requirement_fidelity", "submit_architecture_blueprint", "submit_architecture_module",
        "submit_architecture_integration", "submit_architecture_review"].find((name) => names.includes(name));
      assert.ok(name, "每个原生请求须明确对应实际阶段或独立复核工具");
      requests.push(name); const content = body.messages.findLast((message) => message.role === "user").content;
      const payload = JSON.parse(typeof content === "string" ? content : content.filter((item) => item.type === "text").map((item) => item.text).join(""));
      let value;
      if (["submit_architecture_blueprint", "submit_architecture_module", "submit_architecture_integration"].includes(name)) {
        if (name === "submit_architecture_blueprint") fixedCandidate = validDesign(payload.requirements, { schemaVersion: 3, connections: [],
          interaction: { defaultEntry: "conversation", page: false, operations: false, inputs: "记录", results: "完整汇总", persistentData: "无" },
          execution: { language: "none", hosting: "builtin", reason: "使用现有文本处理" },
          selectionBasis: { capacity: "固定测试输入", process: "完整处理", quality: "逐项核对", requirementIds: payload.requirements.map((item) => item.id), assumptions: [] },
          instructions: "为方便实现保守地只接收ASCII字母数字和点，其他字符拒绝。" });
        const candidate = structuredClone(fixedCandidate);
        if (name === "submit_architecture_integration" && ++designs > 1)
          candidate.instructions = "扩展名允许任意字符，长度1至16，包含点；完整处理全部记录，不增加白名单。";
        const submission = architectureStageSubmission({ tools: body.tools.map((item) => item.function), payload, candidate });
        assert.equal(submission.name, name); value = submission.args;
      } else if (name === "submit_requirement_fidelity") {
        fidelities++; assert.deepEqual(names, ["submit_requirement_fidelity"]);
        const requirement = payload.requirements.find((item) => item.text.includes("允许任意字符")); assert.ok(requirement);
        if (fidelities === 1) {
          const system = body.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
          assert.match(system, /根相对JSON Pointer/u);
          assert.match(system, /source=draft指本轮已确认的真实需求草稿，不是candidate设计稿/u);
          const index = JSON.parse(system.split("引用位置索引（entries为[id,JSON Pointer]，候选编号只定位数组元素）：")[1].split("\n")[0]);
          assert.ok(index.requirements.entries.some(([id, path]) => id === requirement.id
            && path === `/${payload.requirements.indexOf(requirement)}/text`));
        }
        const narrowed = designs === 1;
        assert.equal(payload.candidate.instructions.includes("ASCII"), narrowed);
        value = fidelityResult(payload, narrowed ? "narrowed" : "preserved", { requirementId: requirement.id });
        if (fidelities === 1) value.restrictions[0] = { candidatePath: "/instructions", requirementId: requirement.id,
          source: "draft", path: "/taskSpec/items/0/content", quote: "PRIVATE_FAKE_QUOTE", reason: value.restrictions[0].reason };
        if (fidelities === 2) {
          const text = body.messages.findLast((message) => message.role === "tool").content;
          const feedback = typeof text === "string" ? text : JSON.stringify(text);
          assert.match(feedback, /"reason":"reference_quote_mismatch"/u);
          assert.match(feedback, /"quoteAtSelectedSource":"not_found"/u);
        }
      } else {
        reviewers++; value = passingReview(payload.candidateHash, payload.design, payload.priorFindings);
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0,
        delta: { role: "assistant", tool_calls: [{ index: 0, id: `fixture_${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(value) } }] }, finish_reason: "tool_calls" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    } catch (error) { serverFailure = error; response.writeHead(500); response.end(); }
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  const designer = new ArchitectureDesigner({ config: { llmConfigured: true, apiKey: "fixture-only", model: "fixture-model",
    chatUrl: `http://127.0.0.1:${model.address().port}/v1/chat/completions` }, cwd: root, dataDir: root, sessionFactory: async (options) => {
    const session = await createPiSession(options); session.setAutoRetryEnabled(false); session.setAutoCompactionEnabled(false); return session; } });
  t.after(async () => { await designer.ready; await designer.persistence; model.closeAllConnections(); await new Promise((resolve) => model.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const definition = { id: "characters", name: "材料助手", draft, fingerprint: "fidelity-fixture" };
  await assert.rejects(designer.design(definition), (error) => error.diagnostic.reason === "scope_not_preserved");
  const negative = await designer.get(definition.id);
  assert.equal(negative.review, null); assert.equal(negative.mainReviewCheckpoint.fidelityStatus, "not_preserved");
  assert.equal(negative.mainReviewCheckpoint.modelCalls, 3); assert.equal(negative.requirementFidelity.verdict, "narrowed");
  const result = await designer.design(definition);
  assert.equal(serverFailure, undefined); assert.equal(result.status, "passed"); assert.equal(result.attempts.length, 1);
  assert.equal(result.requirementFidelity.verdict, "preserved"); assert.equal(result.revisionSource.reviewRepair.modelCalls, 3);
  assert.notEqual(result.candidateHash, negative.candidateHash);
  assert.deepEqual(requests, ["submit_architecture_blueprint", "submit_architecture_module", "submit_architecture_integration",
    "submit_architecture_review", "submit_requirement_fidelity", "submit_requirement_fidelity",
    "submit_architecture_integration", "submit_architecture_review", "submit_requirement_fidelity"]);
  assert.equal(designs, 2); assert.equal(reviewers, 2); assert.equal(fidelities, 3);
  assert.equal(result.designProgressCheckpoint.blueprint.modelCalls, 1, "仅指令修订复用已保存蓝图");
  assert.equal(result.designProgressCheckpoint.modules[0].modelCalls, 1, "仅指令修订复用已保存模块");
  assert.equal(result.designProgressCheckpoint.integration.modelCalls, 2, "整合修订沿用原已用次数");
});

async function rejectedFeedback(change) {
  let feedback, thrown;
  try {
    await invoke({ sessionFactory: async (options) => ({ modelCallAccounting: true, dispose() {}, async prompt(text) {
      await options.onModelCall(); const payload = JSON.parse(text), value = fidelityResult(payload, "narrowed"); change(value, payload);
      const call = { toolName: "submit_requirement_fidelity", toolCallId: "fixed_rejection", args: value };
      const raw = await options.rawInputValidators.submit_requirement_fidelity(call);
      if (!raw.valid) feedback = JSON.parse(raw.reason);
      try { await options.customTools[0].execute(call.toolCallId, value); }
      catch (error) { thrown = error; }
      if (raw.valid) feedback = JSON.parse((await options.toolErrorResult(call)).content[0].text);
    } }) });
  } catch (error) { return { feedback, thrown, outer: error }; }
  assert.fail("非法范围判断不得通过");
}

test("范围复核的结构和语义诊断区分具体声明字段，不回显提交值或陌生键", async () => {
  for (const [change, stage, path, reason] of [
    [(value) => { value.checks[0].admissionPreserved = "PRIVATE_WRONG_TYPE"; }, "schema", "fidelity.checks[0].admissionPreserved", "invalid_type"],
    [(value) => { value.PRIVATE_UNKNOWN_KEY = "PRIVATE_UNKNOWN_VALUE"; }, "schema", "fidelity", "unknown_field"],
    [(value) => { value.restrictions[0].candidatePath = "/PRIVATE_PATH"; }, "semantic", "fidelity.restrictions[0].candidatePath", "candidate_path_missing"],
    [(value) => { value.restrictions[0].path = "/PRIVATE_SOURCE"; }, "semantic", "fidelity.restrictions[0].path", "source_path_missing"],
    [(value) => { value.restrictions[0].quote = "PRIVATE_QUOTE"; }, "semantic", "fidelity.restrictions[0].quote", "reference_quote_mismatch"],
    [(value, payload) => { value.restrictions[0].path = "/1/text"; value.restrictions[0].quote = payload.requirements[1].text; }, "semantic", "fidelity.restrictions[0].requirementId", "source_requirement_mismatch"],
    [(value) => { value.checks[1].requirementId = value.checks[0].requirementId; }, "semantic", "fidelity.checks[1].requirementId", "duplicate_requirement"],
    [(value) => { value.verdict = "preserved"; }, "semantic", "fidelity.restrictions", "preserved_has_restrictions"],
    [(value) => { value.restrictions = []; }, "semantic", "fidelity.restrictions", "narrowed_restriction_missing"],
  ]) {
    const { feedback, thrown, outer } = await rejectedFeedback(change);
    assert.equal(feedback.stage, stage); assert.ok(feedback.issues.some((item) => item.path === path && item.reason === reason));
    assert.equal(thrown.validationIssueTotal, feedback.total); assert.equal(outer.reason, "scope_evaluation_incomplete");
    assert.equal(outer.fidelityDiagnostic.lastSubmission.stage, stage); assert.equal(outer.fidelityDiagnostic.modelCalls, 1);
    assert.equal(outer.fidelityDiagnostic.submissionAttempts, 1);
    assert.doesNotMatch(JSON.stringify([feedback, thrown, outer.fidelityDiagnostic]), /PRIVATE_|任意字符|ASCII|不抽样/u);
  }
});

test("范围复核完整列出独立语义问题，诊断有界且当前编号表只提供一次", async () => {
  const { feedback, outer } = await rejectedFeedback((value) => {
    value.restrictions = Array.from({ length: 40 }, () => ({ candidatePath: "/PRIVATE_PATH", requirementId: "input", source: "requirements",
      path: "/PRIVATE_SOURCE", quote: " ", reason: " " }));
  });
  assert.equal(feedback.stage, "semantic"); assert.equal(feedback.total, 200); assert.equal(feedback.issues.length, 40); assert.equal(feedback.truncated, true);
  assert.deepEqual(feedback.allowedRequirementIds, ["input", "delivery"]);
  assert.equal(feedback.allowedRequirementIdsTotal, 2); assert.equal(feedback.allowedRequirementIdsTruncated, false);
  assert.ok(feedback.issues.every((item) => !Object.hasOwn(item, "allowedRequirementIds")));
  assert.equal(outer.fidelityDiagnostic.lastSubmission.total, 200);
  assert.doesNotMatch(JSON.stringify(outer.fidelityDiagnostic), /PRIVATE_/u);
});

test("超过120个正式需求时编号提示显式标总数与截断，完整schema仍接受后续编号且反馈维持额度", async () => {
  const draft = validDraft();
  draft.taskSpec = { version: 1, items: Array.from({ length: 120 }, (_, index) => ({ id: `item_${index}`, dimension: "processing",
    content: `固定测试要求${index}`, applicability: "applies", critical: false,
    source: { kind: "user", evidence: [{ messageId: "fixed", quote: "固定测试原文" }] } })) };
  const actualRequirements = requirementItems(draft); assert.equal(actualRequirements.length, 128);
  for (const requirements of [actualRequirements, actualRequirements.map((item, index) => ({ ...item, id: `r${String(index).padStart(3, "0")}${"x".repeat(76)}` }))]) {
    const current = { ...context(), requirements }; let feedback, schemaIds;
    await assert.rejects(invoke({ context: current, sessionFactory: async (options) => ({ modelCallAccounting: true, dispose() {}, async prompt(text) {
      await options.onModelCall(); const payload = JSON.parse(text);
      schemaIds = options.customTools[0].parameters.properties.checks.items.properties.requirementId.enum;
      const value = { contextHash: payload.contextHash, verdict: "preserved", restrictions: [], checks: requirements.map(() => ({
        requirementId: requirements[0].id, admissionPreserved: true, deliveryPreserved: true, newUnconfirmedRestriction: false,
      })) };
      try { await options.customTools[0].execute("large-requirement-list", value); }
      catch (error) { feedback = JSON.parse(error.message.slice(error.message.indexOf("{"))); }
    } }) }), (error) => error.reason === "scope_evaluation_incomplete");
    assert.equal(feedback.allowedRequirementIds.length, 120); assert.equal(feedback.allowedRequirementIdsTotal, 128);
    assert.equal(feedback.allowedRequirementIdsTruncated, true); assert.equal(feedback.total, 254);
    assert.equal(feedback.truncated, true); assert.ok(feedback.issues.length <= 40);
    assert.ok(JSON.stringify(feedback).length <= 14000);
    assert.equal(schemaIds.length, 128); assert.ok(schemaIds.includes(requirements.at(-1).id));
    assert.ok(!feedback.allowedRequirementIds.includes(requirements.at(-1).id));
    assert.ok(feedback.issues.every((issue) => issue.remedy.includes("完整允许集合以本轮schema枚举为准")));
  }
});

test("子范围复核两次语义失败的具体受控诊断进入父评审回执，仍占用原共享预算", async (t) => {
  const reviewDiagnostics = [];
  const f = await roleFixture(t, { onDiagnostics: (entry) => reviewDiagnostics.push(entry), childFactory: async (options) => ({
    modelCallAccounting: true, dispose() {}, async prompt(text) {
      const payload = JSON.parse(text);
      for (let attempt = 0; attempt < 2; attempt++) {
        await options.onModelCall(); const value = fidelityResult(payload, "narrowed");
        value.restrictions[0].quote = "PRIVATE_FAKE_QUOTE"; value.restrictions[0].candidatePath = "/PRIVATE_PATH";
        await assert.rejects(options.customTools[0].execute(`failure_${attempt}`, value));
      }
    },
  }) });
  await assert.rejects(f.run(), (error) => error.diagnostic.reason === "scope_evaluation_incomplete" && error.diagnostic.modelCalls === 3);
  const diagnostic = reviewDiagnostics[0].fidelityDiagnostic;
  assert.equal(diagnostic.modelCalls, 2); assert.equal(diagnostic.submissionAttempts, 2); assert.equal(diagnostic.semanticRejections, 2);
  assert.equal(diagnostic.stopReason, "submission_rejected"); assert.equal(diagnostic.lastSubmission.total, 2);
  assert.deepEqual(diagnostic.lastSubmission.issues.map(({ path, reason }) => ({ path, reason })), [
    { path: "fidelity.restrictions[0].candidatePath", reason: "candidate_path_missing" },
    { path: "fidelity.restrictions[0].quote", reason: "reference_quote_mismatch" },
  ]);
  assert.doesNotMatch(JSON.stringify(reviewDiagnostics), /PRIVATE_|任意字符|ASCII|不抽样/u);
});

async function localFidelityModel(t, respond, { retry = false, onEvent } = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-fidelity-feedback-")), requests = []; let failure;
  const model = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); requests.push(body); const next = await respond(body, requests.length);
      if (next.error) { response.writeHead(503, { "content-type": "application/json" }); response.end('{"error":{"message":"fixture-only"}}'); return; }
      if (next.shortStream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"partial"}}]}\n\ndata: [DONE]\n\n'); return;
      }
      const delta = next.value ? { role: "assistant", tool_calls: [{ index: 0, id: `feedback_${requests.length}`, type: "function",
        function: { name: "submit_requirement_fidelity", arguments: JSON.stringify(next.value) } }] } : { role: "assistant", content: next.text ?? "完整性尚未证明" };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ id: "feedback", choices: [{ index: 0, delta, finish_reason: next.value ? "tool_calls" : next.finishReason ?? "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    } catch (error) { failure = error; response.writeHead(500, { "content-type": "application/json" }); response.end('{"error":{"message":"fixture failed"}}'); }
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  t.after(async () => { model.closeAllConnections(); await new Promise((resolve) => model.close(resolve)); await rm(root, { recursive: true, force: true }); assert.equal(failure, undefined); });
  const config = { llmConfigured: true, model: "fixture-model", apiKey: "fixture-only", chatUrl: `http://127.0.0.1:${model.address().port}/v1/chat/completions` };
  return { requests, run: (options = {}) => invoke({ config, cwd: root, dataDir: root, ...options, sessionFactory: async (settings) => {
    const session = await createPiSession(settings); session.setAutoRetryEnabled(retry);
    if (retry) {
      const retrySettings = session.settingsManager.getRetrySettings.bind(session.settingsManager);
      t.mock.method(session.settingsManager, "getRetrySettings", () => ({ ...retrySettings(), maxRetries: 1, baseDelayMs: 5, maxAgentDelayMs: 5 }));
    }
    if (onEvent) session.subscribe(onEvent);
    return session;
  } }) };
}
const textContent = (content) => typeof content === "string" ? content : content.filter((item) => item.type === "text").map((item) => item.text).join("\n");

for (const wrapped of [false, true]) test(`真实Pi范围复核完整JSON${wrapped ? "终止封装" : "参数正文"}首轮通过同一提交校验`, { timeout: 15000 }, async (t) => {
  const f = await localFidelityModel(t, (body, turn) => {
    assert.equal(body.tool_choice, undefined);
    assert.deepEqual(body.tools.map((item) => item.function.name), ["submit_requirement_fidelity"]);
    const payload = JSON.parse(textContent(body.messages.findLast((item) => item.role === "user").content));
    assert.equal(turn, 1);
    const value = fidelityResult(payload, "preserved");
    return { text: JSON.stringify(wrapped ? { submission: { name: "submit_requirement_fidelity", arguments: value } } : value) };
  });
  const result = await f.run(); assert.equal(result.verdict, "preserved"); assert.equal(result.modelCalls, 1);
  assert.equal(result.fidelityDiagnostic.submissionAttempts, 1); assert.equal(f.requests.length, 1);
});

test("真实Pi结构化范围判断语义失败后保留精确反馈，在原第二轮纠正", { timeout: 15000 }, async (t) => {
  let valid;
  const f = await localFidelityModel(t, (body, turn) => {
    const payload = JSON.parse(textContent(body.messages.findLast((item) => item.role === "user").content));
    if (turn === 1) {
      valid = fidelityResult(payload, "narrowed");
      const invalid = structuredClone(valid); invalid.restrictions[0].quote = "PRIVATE_FALSE_QUOTE";
      return { text: JSON.stringify(invalid) };
    }
    assert.equal(turn, 2); assert.equal(payload.remainingModelCalls, 1);
    assert.equal(payload.lastSubmission.stage, "semantic");
    assert.equal(payload.lastSubmission.issues[0].reason, "reference_quote_mismatch");
    assert.doesNotMatch(JSON.stringify(payload.lastSubmission), /PRIVATE_/u);
    return { text: JSON.stringify({ submission: { name: "submit_requirement_fidelity", arguments: valid } }) };
  });
  const result = await f.run(); assert.equal(result.verdict, "narrowed"); assert.equal(result.modelCalls, 2);
  assert.equal(result.fidelityDiagnostic.submissionAttempts, 2); assert.equal(result.fidelityDiagnostic.semanticRejections, 1);
  assert.equal(f.requests.length, 2);
});

for (const stage of ["schema", "semantic"]) test(`真实Pi首轮${stage}拒绝后按精确字段反馈修正，仍只用原两次调用`, { timeout: 15000 }, async (t) => {
  let charges = 0;
  const f = await localFidelityModel(t, (body, turn) => {
    const payload = JSON.parse(textContent(body.messages.findLast((item) => item.role === "user").content));
    const value = fidelityResult(payload, "narrowed");
    if (turn === 1) {
      if (stage === "semantic") value.restrictions[0].quote = "PRIVATE_FAKE_QUOTE";
      else value.checks[0].admissionPreserved = "PRIVATE_WRONG_TYPE";
    } else {
      assert.equal(turn, 2);
      const feedback = textContent(body.messages.findLast((item) => item.role === "tool").content);
      assert.ok(feedback.includes(`"stage":"${stage}"`));
      assert.ok(feedback.includes(stage === "semantic" ? '"path":"fidelity.restrictions[0].quote"' : '"path":"fidelity.checks[0].admissionPreserved"'));
      assert.ok(feedback.includes(stage === "semantic" ? '"reason":"reference_quote_mismatch"' : '"reason":"invalid_type"'));
      assert.doesNotMatch(feedback, /PRIVATE_/u);
    }
    return { value };
  });
  const result = await f.run({ charge: () => { charges++; } });
  assert.equal(result.verdict, "narrowed"); assert.equal(result.modelCalls, 2); assert.equal(charges, 2); assert.equal(f.requests.length, 2);
  assert.equal(result.fidelityDiagnostic.stopReason, "submitted"); assert.equal(result.fidelityDiagnostic.submissionAttempts, 2);
  assert.equal(result.fidelityDiagnostic.lastSubmission.stage, stage);
  assert.equal(result.fidelityDiagnostic.lastSubmission.issues[0].reason, stage === "semantic" ? "reference_quote_mismatch" : "invalid_type");
  assert.doesNotMatch(JSON.stringify(result.fidelityDiagnostic), /PRIVATE_/u);
});

test("真实Pi短行摘录收到具体数字类型纠正后直接提交，不切换为冲突的详细引用", { timeout: 15000 }, async (t) => {
  const current = { ...context(), fidelityContextVersion: "full-v2" }; let charges = 0;
  const f = await localFidelityModel(t, (body, turn) => {
    const payload = JSON.parse(textContent(body.messages.findLast((item) => item.role === "user").content));
    const value = fidelityResult(payload, "narrowed");
    value.restrictions[0].claimRef = { ...value.restrictions[0].claimRef, offset: turn === 1 ? "PRIVATE_OFFSET" : 0, length: 5 };
    if (turn === 2) {
      const feedback = textContent(body.messages.findLast((item) => item.role === "tool").content);
      assert.match(feedback, /"path":"fidelity\.restrictions\[0\]\.claimRef\.offset"/u);
      assert.match(feedback, /"expectedType":"integer"/u); assert.match(feedback, /"receivedType":"string"/u);
      assert.doesNotMatch(feedback, /PRIVATE_|required_field|unknown_field/u);
    }
    assert.ok(turn <= 2); return { value };
  });
  const result = await f.run({ context: current, charge() { charges++; } });
  assert.equal(result.verdict, "narrowed"); assert.equal(result.modelCalls, 2); assert.equal(charges, 2);
  assert.equal(f.requests.length, 2); assert.equal(result.fidelityDiagnostic.schemaRejections, 1);
  assert.equal(result.fidelityDiagnostic.stopReason, "submitted");
  assert.equal(result.restrictions[0].quote, current.requirements[0].text.slice(0, 5));
  assert.doesNotMatch(JSON.stringify(result.fidelityDiagnostic), /PRIVATE_/u);
});

for (const fault of ["length", "error", "cancelled"]) test(`真实Pi范围复核${fault}保持失败且不追加复核调用`, { timeout: 15000 }, async (t) => {
  const controller = new AbortController();
  const f = await localFidelityModel(t, () => {
    if (fault === "cancelled") controller.abort(new Error("fixture-cancelled"));
    return fault === "error" ? { error: true } : { finishReason: fault === "length" ? "length" : "stop" };
  });
  await assert.rejects(f.run({ signal: controller.signal }), (error) => fault === "cancelled" ? error === controller.signal.reason
    : error.reason === "scope_evaluation_incomplete" && error.modelCalls === 1 && error.fidelityDiagnostic.stopReason === (fault === "length" ? "output_limit" : "model_error"));
  assert.equal(f.requests.length, 1);
});

for (const fault of ["http503", "shortStream"]) test(`真实Pi ${fault}原生网络重试成功后立即接受当前有效提交，不重复扣业务预算`, { timeout: 15000 }, async (t) => {
  const events = []; let charges = 0;
  const f = await localFidelityModel(t, (body, turn) => {
    if (turn === 1) return fault === "http503" ? { error: true } : { shortStream: true };
    assert.equal(turn, 2);
    const payload = JSON.parse(textContent(body.messages.findLast((item) => item.role === "user").content));
    return { value: fidelityResult(payload, "narrowed") };
  }, { retry: true, onEvent: (event) => {
    if (event.type === "message_end" && event.message?.role === "assistant") events.push(event.message.stopReason);
    if (event.type === "auto_retry_start") events.push("retry_start");
    if (event.type === "auto_retry_end") events.push(event.success ? "retry_succeeded" : "retry_failed");
    if (event.type === "tool_execution_end") events.push(event.isError ? "tool_failed" : "tool_submitted");
  } });
  const result = await f.run({ charge: () => { charges++; } });
  assert.equal(result.verdict, "narrowed"); assert.equal(result.modelCalls, 1); assert.equal(charges, 1); assert.equal(f.requests.length, 2);
  assert.deepEqual(events, ["error", "retry_start", "toolUse", "retry_succeeded", "tool_submitted"]);
  assert.equal(result.fidelityDiagnostic.stopReason, "submitted"); assert.equal(result.fidelityDiagnostic.submissionAttempts, 1);
});

test("真实Pi原生重试成功但当前响应截断时仍拒绝，不把网络恢复当完整结果", { timeout: 15000 }, async (t) => {
  const events = [];
  const f = await localFidelityModel(t, (_body, turn) => turn === 1 ? { error: true } : { finishReason: "length" }, {
    retry: true, onEvent: (event) => { if (event.type === "auto_retry_end") events.push(event.success); },
  });
  await assert.rejects(f.run(), (error) => error.reason === "scope_evaluation_incomplete" && error.modelCalls === 1
    && error.fidelityDiagnostic.stopReason === "output_limit" && error.fidelityDiagnostic.submissionAttempts === 0);
  assert.deepEqual(events, [true]); assert.equal(f.requests.length, 2);
});

test("真实Pi原生重试最终失败时保留终端错误，不人工追加业务轮次", { timeout: 15000 }, async (t) => {
  const events = []; let charges = 0;
  const f = await localFidelityModel(t, () => ({ error: true }), { retry: true,
    onEvent: (event) => { if (event.type === "auto_retry_end") events.push(event.success); } });
  await assert.rejects(f.run({ charge: () => { charges++; } }), (error) => error.reason === "scope_evaluation_incomplete"
    && error.modelCalls === 1 && error.fidelityDiagnostic.stopReason === "model_error");
  assert.deepEqual(events, [false]); assert.equal(charges, 1); assert.equal(f.requests.length, 2);
});

test("真实Pi原生网络重试等待中取消不发重试请求、不接受迟到结果", { timeout: 15000 }, async (t) => {
  const controller = new AbortController(); let charges = 0;
  const f = await localFidelityModel(t, () => ({ error: true }), { retry: true, onEvent: (event) => {
    if (event.type === "auto_retry_start") queueMicrotask(() => controller.abort(new Error("fixture-retry-cancelled")));
  } });
  await assert.rejects(f.run({ signal: controller.signal, charge: () => { charges++; } }), (error) => error === controller.signal.reason);
  assert.equal(charges, 1); assert.equal(f.requests.length, 1);
});
