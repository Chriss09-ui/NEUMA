import { objectFields } from "../src/runtime/type-boundary.mjs";
import { fixtureString } from "./helpers/http-model.mjs";
import { callFixture, fixtureTools, fixtureToolAt } from "./helpers/m7-test-boundaries.mjs";
import type { SessionMessage } from "../src/runtime/pi-port.mjs";
import type { PiSessionOptions } from "../src/runtime/pi-port.mjs";
import { failureFields } from "./helpers/failure-fields.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { verifyRequirementFidelity } from "../src/architecture/requirement-fidelity.mjs";
import { verifyArchitectureHandoff } from "../src/architecture/architecture-handoff-verification.mjs";

const requirements = [{ id: "input", text: "完整处理已确认的输入范围" }, { id: "delivery", text: "交付完整结果" }];
const context = { requirements, draft: {}, candidate: { instructions: "当前只读候选" }, runtimeCapabilities: { version: 1 } };
const issues = requirements.map((item) => ({ id: `choice_${item.id}`, question: "是否改变交付承诺？", impact: "改变原范围",
  requirementIds: [item.id], references: [{ source: "requirements", path: `/${requirements.indexOf(item)}/text`, quote: item.text }] }));
const controllers = {
  fidelity: { run: verifyRequirementFidelity, name: "submit_requirement_fidelity", reason: "scope_evaluation_incomplete", value: (contextHash: string) => ({
    contextHash, verdict: "narrowed", checks: requirements.map((item, index) => ({ requirementId: item.id, admissionPreserved: index !== 0,
      deliveryPreserved: true, newUnconfirmedRestriction: index === 0 })), restrictions: [{ candidatePath: "/instructions", requirementId: "input",
      source: "requirements", path: "/0/text", quote: requirements[0]!.text, reason: "固定独立判断说明当前新增限制" }],
  }), corrupt(value: { restrictions: { quote: string; }[]; }) { value.restrictions[0]!.quote = "PRIVATE_FALSE_QUOTE"; }, duplicate(value: { checks: {requirementId:string}[] }) { value.checks[1]!.requirementId = value.checks[0]!.requirementId; } },
  handoff: { run: verifyArchitectureHandoff, name: "submit_handoff_necessity", reason: "handoff_evaluation_incomplete", value: (contextHash: string) => ({
    contextHash, decisions: issues.map((issue) => ({ issueId: issue.id, classification: "candidate_design_issue",
      reason: "候选技术问题应在当前会话处理", references: structuredClone(issue.references) })),
  }), corrupt(value: { decisions: { references: { quote: string; }[]; }[]; }) { value.decisions[0]!.references[0]!.quote = "PRIVATE_FALSE_QUOTE"; }, duplicate(value: { decisions: {issueId:string}[] }) { value.decisions[1]!.issueId = value.decisions[0]!.issueId; } },
};

type Controller = typeof controllers[keyof typeof controllers];
interface ResponseMessage {content: unknown[];stopReason?:string}
function fixture<C extends Controller>(controller:C, respond:(input:{payload:Record<string,unknown>;turn:number;value:ReturnType<C["value"]>})=>ResponseMessage|null|Promise<ResponseMessage|null>, { signal, stale = false }: {signal?:AbortSignal;stale?:boolean} = {}) {
  const payloads: Record<string,unknown>[] = [], state: {charges:number;executions:number;disposed:boolean;tool?:ReturnType<typeof fixtureToolAt>;value?:ReturnType<C["value"]>} = { charges: 0, executions: 0, disposed: false };
  const run = () => controller.run({ context, issues, config: {}, cwd: "/tmp", dataDir: "/tmp", signal,
    charge() { state.charges++; }, sessionFactory: async (options: PiSessionOptions) => {
      assert.equal(options.reasoningMode, controller === controllers.fidelity ? "off" : "auto");
      assert.deepEqual(options.customTools!.map((tool) => tool.name), [controller.name, "read_model_context"]);
      assert.match(options.systemPrompt!, /结构化结果也是本阶段正式提交通道/u);
      const tool = options.customTools![0], execute = tool!.execute;
      state.tool = fixtureToolAt([tool!],0); state.value = callFixture(controller.value, undefined, [fixtureString(objectFields(objectFields(objectFields(tool!.parameters).properties).contextHash).const)]) as ReturnType<C["value"]>;
      tool!.execute = async (...args: Parameters<typeof execute>) => { state.executions++; return callFixture(execute, undefined, args); };
      const session = { modelCallAccounting: true, messages: stale ? [{ role: "assistant", stopReason: "stop",
        content: [{ type: "text", text: JSON.stringify(state.value) }] }] as SessionMessage[] : [] as SessionMessage[], dispose() { state.disposed = true; }, async abort() {},
      async prompt(text: string) {
        await options.onModelCall!(); const payload = JSON.parse(text); payloads.push(payload);
        const message = await respond({ payload, turn: payloads.length, value: structuredClone(state.value!) });
        if (message) callFixture(session.messages.push, session.messages, [{ role: "assistant", stopReason: "stop", ...message }]);
      } };
      return session;
    } });
  return { run, state, payloads };
}
const response = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

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
    for (const mutate of [(value: ReturnType<Controller["value"]>) => ({ ...value, contextHash: "0".repeat(64) }), (value: ReturnType<Controller["value"]>) => ({ ...value, extra: true }),
      (value: ReturnType<Controller["value"]>) => ({ ...value, contextHash: 1 }), (value: ReturnType<Controller["value"]>) => ({ submission: { name: "read_file", arguments: value } })]) {
      const f = fixture(controller, ({ value }) => response(mutate(value)));
      await assert.rejects(f.run(), (error) => failureFields(error).reason === controller.reason && failureFields(error).modelCalls === 2);
      assert.equal(f.state.charges, 2); assert.equal(f.state.executions, 0);
    }
  });

  test(`${name}合法结构的语义错与重复编号仍反馈并只允许原第二轮纠正`, async () => {
    for (const corrupt of [controller.corrupt, controller.duplicate]) {
      const f = fixture(controller, ({ payload, turn, value }) => {
        if (turn === 1) callFixture(corrupt, undefined, [value]);
        else {
          assert.equal(payload.remainingModelCalls, 1); assert.ok(payload.lastSubmission);
          assert.doesNotMatch(JSON.stringify(payload.lastSubmission), /PRIVATE_/u);
        }
        return response(value);
      });
      const result = await f.run(); assert.equal(result.modelCalls, 2); assert.equal(f.state.charges, 2); assert.equal(f.state.executions, 2);
      const bad = fixture(controller, ({ value }) => { callFixture(corrupt, undefined, [value]); return response(value); });
      await assert.rejects(bad.run(), (error) => failureFields(error).reason === controller.reason && failureFields(error).modelCalls === 2);
      assert.equal(bad.state.charges, 2); assert.equal(bad.state.executions, 2);
    }
  });

  test(`${name}完整JSON也不接受异常结束、未知内容块或历史陈旧回复`, async () => {
    for (const stopReason of ["length", "error", "aborted"]) {
      const f = fixture(controller, ({ value }) => ({ ...response(value), stopReason }));
      await assert.rejects(f.run(), (error) => failureFields(error).reason === controller.reason && failureFields(error).modelCalls === 1);
      assert.equal(f.state.charges, 1); assert.equal(f.state.executions, 0);
    }
    const unknown = fixture(controller, ({ value }) => ({ content: [...response(value).content, { type: "toolCall", name: "write_file", arguments: {} }] }));
    await assert.rejects(unknown.run(), (error) => failureFields(error).reason === controller.reason && failureFields(error).modelCalls === 2);
    assert.equal(unknown.state.executions, 0);
    const stale = fixture(controller, () => null, { stale: true });
    await assert.rejects(stale.run(), (error) => failureFields(error).reason === controller.reason && failureFields(error).modelCalls === 1);
    assert.equal(stale.state.executions, 0);
  });

  test(`${name}取消后完整JSON和迟到工具结果均不能提交`, async () => {
    const cancellation = new AbortController(), stop = new Error("controlled cancellation");
    const f = fixture(controller, ({ value }) => { cancellation.abort(stop); return response(value); }, { signal: cancellation.signal });
    await assert.rejects(f.run(), (error) => error === stop);
    assert.equal(f.state.executions, 0); assert.equal(f.state.disposed, true);
    await assert.rejects(f.state.tool!.execute("late", f.state.value), (error) => error === stop);
  });
}

test("handoff结构化user_choice仍须已确认来源，不能只引用候选自造用户缺口", async () => {
  const f = fixture(controllers.handoff, ({ value }) => {
    value.decisions[0]!.classification = "user_choice";
    value.decisions[0]!.references = [{ source: "candidate", path: "/instructions", quote: context.candidate.instructions }];
    return response(value);
  });
  await assert.rejects(f.run(), (error) => failureFields(error).reason === "handoff_evaluation_incomplete" && failureFields(error).modelCalls === 2);
  assert.equal(f.state.charges, 2);
});
