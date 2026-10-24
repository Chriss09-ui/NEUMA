import test from "node:test";
import assert from "node:assert/strict";
import { verifyRequirementFidelity } from "../src/architecture/requirement-fidelity.mjs";
import { verifyArchitectureHandoff } from "../src/architecture/architecture-handoff-verification.mjs";

const requirements = [{ id: "input", text: "完整处理已确认的输入范围" }, { id: "delivery", text: "交付完整结果" }];
const context = { requirements, draft: {}, candidate: { instructions: "当前只读候选" }, runtimeCapabilities: { version: 1 } };
const issues = requirements.map((item) => ({ id: `choice_${item.id}`, question: "是否改变交付承诺？", impact: "改变原范围",
  requirementIds: [item.id], references: [{ source: "requirements", path: `/${requirements.indexOf(item)}/text`, quote: item.text }] }));
const controllers = {
  fidelity: { run: verifyRequirementFidelity, name: "submit_requirement_fidelity", reason: "scope_evaluation_incomplete", value: (contextHash) => ({
    contextHash, verdict: "narrowed", checks: requirements.map((item, index) => ({ requirementId: item.id, admissionPreserved: index !== 0,
      deliveryPreserved: true, newUnconfirmedRestriction: index === 0 })), restrictions: [{ candidatePath: "/instructions", requirementId: "input",
      source: "requirements", path: "/0/text", quote: requirements[0].text, reason: "固定独立判断说明当前新增限制" }],
  }), corrupt(value) { value.restrictions[0].quote = "PRIVATE_FALSE_QUOTE"; }, duplicate(value) { value.checks[1].requirementId = value.checks[0].requirementId; } },
  handoff: { run: verifyArchitectureHandoff, name: "submit_handoff_necessity", reason: "handoff_evaluation_incomplete", value: (contextHash) => ({
    contextHash, decisions: issues.map((issue) => ({ issueId: issue.id, classification: "candidate_design_issue",
      reason: "候选技术问题应在当前会话处理", references: structuredClone(issue.references) })),
  }), corrupt(value) { value.decisions[0].references[0].quote = "PRIVATE_FALSE_QUOTE"; }, duplicate(value) { value.decisions[1].issueId = value.decisions[0].issueId; } },
};

function fixture(controller, respond, { signal, stale = false } = {}) {
  const payloads = [], state = { charges: 0, executions: 0, disposed: false };
  const run = () => controller.run({ context, issues, config: {}, cwd: "/tmp", dataDir: "/tmp", signal,
    charge() { state.charges++; }, sessionFactory: async (options) => {
      assert.equal(options.reasoningMode, controller === controllers.fidelity ? "off" : "auto");
      assert.deepEqual(options.customTools.map((tool) => tool.name), [controller.name, "read_model_context"]);
      assert.match(options.systemPrompt, /结构化结果也是本阶段正式提交通道/u);
      const tool = options.customTools[0], execute = tool.execute;
      state.tool = tool; state.value = controller.value(tool.parameters.properties.contextHash.const);
      tool.execute = async (...args) => { state.executions++; return execute(...args); };
      const session = { modelCallAccounting: true, messages: stale ? [{ role: "assistant", stopReason: "stop",
        content: [{ type: "text", text: JSON.stringify(state.value) }] }] : [], dispose() { state.disposed = true; }, async abort() {},
      async prompt(text) {
        await options.onModelCall(); const payload = JSON.parse(text); payloads.push(payload);
        const message = await respond({ payload, turn: payloads.length, value: structuredClone(state.value) });
        if (message) session.messages.push({ role: "assistant", stopReason: "stop", ...message });
      } };
      return session;
    } });
  return { run, state, payloads };
}
const response = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

for (const [name, controller] of Object.entries(controllers)) {
  test(`${name}结构化终止保留opaque thinking但不读取正文，仍执行唯一原提交处理器`, async () => {
    let privateReads = 0;
    const f = fixture(controller, ({ value }) => {
      const thinking = { type: "thinking" };
      Object.defineProperty(thinking, "thinking", { get() { privateReads++; throw new Error("private thinking must stay opaque"); } });
      return { content: [thinking, ...response({ submission: { name: controller.name, arguments: value } }).content] };
    });
    const result = await f.run(); assert.equal(result.modelCalls, 1); assert.equal(f.state.charges, 1);
    assert.equal(f.state.executions, 1); assert.equal(privateReads, 0); assert.equal(f.state.disposed, true);
  });

  test(`${name}严格schema与终止工具白名单不接受错hash、额外字段、类型强转或其他工具`, async () => {
    for (const mutate of [(value) => ({ ...value, contextHash: "0".repeat(64) }), (value) => ({ ...value, extra: true }),
      (value) => ({ ...value, contextHash: 1 }), (value) => ({ submission: { name: "read_file", arguments: value } })]) {
      const f = fixture(controller, ({ value }) => response(mutate(value)));
      await assert.rejects(f.run(), (error) => error.reason === controller.reason && error.modelCalls === 2);
      assert.equal(f.state.charges, 2); assert.equal(f.state.executions, 0);
    }
  });

  test(`${name}合法结构的语义错与重复编号仍反馈并只允许原第二轮纠正`, async () => {
    for (const corrupt of [controller.corrupt, controller.duplicate]) {
      const f = fixture(controller, ({ payload, turn, value }) => {
        if (turn === 1) corrupt(value);
        else {
          assert.equal(payload.remainingModelCalls, 1); assert.ok(payload.lastSubmission);
          assert.doesNotMatch(JSON.stringify(payload.lastSubmission), /PRIVATE_/u);
        }
        return response(value);
      });
      const result = await f.run(); assert.equal(result.modelCalls, 2); assert.equal(f.state.charges, 2); assert.equal(f.state.executions, 2);
      const bad = fixture(controller, ({ value }) => { corrupt(value); return response(value); });
      await assert.rejects(bad.run(), (error) => error.reason === controller.reason && error.modelCalls === 2);
      assert.equal(bad.state.charges, 2); assert.equal(bad.state.executions, 2);
    }
  });

  test(`${name}完整JSON也不接受异常结束、未知内容块或历史陈旧回复`, async () => {
    for (const stopReason of ["length", "error", "aborted"]) {
      const f = fixture(controller, ({ value }) => ({ ...response(value), stopReason }));
      await assert.rejects(f.run(), (error) => error.reason === controller.reason && error.modelCalls === 1);
      assert.equal(f.state.charges, 1); assert.equal(f.state.executions, 0);
    }
    const unknown = fixture(controller, ({ value }) => ({ content: [...response(value).content, { type: "toolCall", name: "write_file", arguments: {} }] }));
    await assert.rejects(unknown.run(), (error) => error.reason === controller.reason && error.modelCalls === 2);
    assert.equal(unknown.state.executions, 0);
    const stale = fixture(controller, () => null, { stale: true });
    await assert.rejects(stale.run(), (error) => error.reason === controller.reason && error.modelCalls === 1);
    assert.equal(stale.state.executions, 0);
  });

  test(`${name}取消后完整JSON和迟到工具结果均不能提交`, async () => {
    const cancellation = new AbortController(), stop = new Error("controlled cancellation");
    const f = fixture(controller, ({ value }) => { cancellation.abort(stop); return response(value); }, { signal: cancellation.signal });
    await assert.rejects(f.run(), (error) => error === stop);
    assert.equal(f.state.executions, 0); assert.equal(f.state.disposed, true);
    await assert.rejects(f.state.tool.execute("late", f.state.value), (error) => error === stop);
  });
}

test("handoff结构化user_choice仍须已确认来源，不能只引用候选自造用户缺口", async () => {
  const f = fixture(controllers.handoff, ({ value }) => {
    value.decisions[0].classification = "user_choice";
    value.decisions[0].references = [{ source: "candidate", path: "/instructions", quote: context.candidate.instructions }];
    return response(value);
  });
  await assert.rejects(f.run(), (error) => error.reason === "handoff_evaluation_incomplete" && error.modelCalls === 2);
  assert.equal(f.state.charges, 2);
});
