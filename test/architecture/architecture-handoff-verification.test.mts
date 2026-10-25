import { fixtureText } from "../helpers/m7-test-boundaries.mjs";
import { callFixture } from "../helpers/m7-test-boundaries.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import type { SessionMessage } from "../../src/runtime/pi-port.mjs";
import { fixtureTools } from "../helpers/m7-test-boundaries.mjs";
import { listeningAddress } from "../helpers/m7-test-boundaries.mjs";
import type { TestFailure } from "../helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { ArchitectureDesigner } from "../../src/architecture/architecture.mjs";
import { verifyArchitectureHandoff } from "../../src/architecture/architecture-handoff-verification.mjs";
import { handoffChecker } from "../helpers/handoff.mjs";
import type { PiSessionOptions,RegisteredTool, VerificationSessionFactory } from "../../src/runtime/pi-port.mjs";

const requirements = [{ id: "extension", text: "扩展名1至16字符，包含点并转小写。" }];
const proposal = () => ({ id: "allowed_characters", question: "是否只允许点和英文字母？", impact: "决定允许字符", requirementIds: ["extension"],
  references: [{ source: "requirements", path: "/0/text", quote: requirements[0]!.text }] });
const parameters = { type: "object", additionalProperties: false, required: ["done"], properties: { done: { type: "boolean" } } };

for (const wrapped of [false, true]) test(`返需复核完整JSON${wrapped ? "终止封装" : "参数正文"}首轮通过同一提交校验`, async () => {
  const prompts: ((unknown))[] = [];
  const sessionFactory = async (options: PiSessionOptions) => {
    assert.deepEqual(options.customTools!.map((tool) => tool.name), ["submit_handoff_necessity", "read_model_context"]);
    assert.match(options.systemPrompt!, /role=handoff-verifier，submitName=submit_handoff_necessity/u);
    assert.match(options.systemPrompt!, /技术问题一律不得判user_choice/);
    assert.match(options.systemPrompt!, /需求原文仍未写明用户要的业务结果/);
    assert.match(options.systemPrompt!, /结构化结果也是本阶段正式提交通道/u);
    assert.equal(options.reasoningMode, "auto");
    const session = { messages: [] as SessionMessage[], modelCallAccounting: true, dispose() {}, async prompt(text: string) {
      await options.onModelCall!({}); const payload = JSON.parse(String(text)); prompts.push(payload);
      const value = { contextHash: payload.contextHash, decisions: [{ issueId: proposal().id,
        classification: "candidate_design_issue", reason: "由当前候选核实技术条件", references: proposal().references }] };
      session.messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text",
        text: JSON.stringify(wrapped ? { submission: { name: "submit_handoff_necessity", arguments: value } } : value) }] });
    } };
    return session;
  };
  const run = () => verifyArchitectureHandoff({ issues: [proposal()], context: { requirements, draft: {}, candidate: {} }, sessionFactory });
  assert.equal((await run()).modelCalls, 1); assert.equal(prompts.length, 1);
});

async function fixture(t: test.TestContext, script: (input: { payload: unknown; options: PiSessionOptions; tools: ReturnType<typeof fixtureTools>; aborted: boolean }) => unknown | Promise<unknown>, classification = "candidate_design_issue", checker?: VerificationSessionFactory) {
  const root = await mkdtemp(join(tmpdir(), "neuma-handoff-guard-")), main: ({ "options": (PiSessionOptions); "tools": (Record<string, import("../helpers/m7-test-boundaries.mjs").FixtureTool>); "aborted": (boolean); })[] = [];
  const designer = new ArchitectureDesigner({ config: {}, cwd: root, dataDir: root, handoffSessionFactory: checker ?? handoffChecker(classification),
    sessionFactory: async (options) => {
      const tools = fixtureTools(options.customTools!);
      const record = { options, tools, aborted: false }; main.push(record);
      return { modelCallAccounting: true, messages: [] as SessionMessage[], subscribe: () => () => {}, dispose() {}, setAutoCompactionEnabled() {},
        async abort() { record.aborted = true; }, async prompt(text: string) { await callFixture(options.onModelCall!, options, []); await script({ ...record, payload: JSON.parse(String(text)) }); } };
    } });
  await designer.ready; t.after(async () => { await designer.persistence; await rm(root, { recursive: true, force: true }); });
  const run = (role = "designer") => designer.role({ role, submitName: role === "reviewer" ? "submit_architecture_review" : "submit_architecture", parameters,
    systemPrompt: "固定测试", payload: { requirements, design: { rule: "仅允许点和字母" }, confirmedRequirementContext: { sourceQuotes: [{ quote: "已给出的原始范围" }] } },
    allowHandoff: true, validate: (value: unknown) => value, onProgress() {} });
  return { designer, main, run };
}

for (const role of ["designer", "reviewer"]) test(`${role}直接返需拒绝候选新增限制，在原会话修正后才能提交`, async (t) => {
  const f = await fixture(t, async ({ tools, options }) => {
    await assert.rejects(tools.request_requirements!.execute("handoff", { issues: [proposal()] }), /candidate_design_issue/);
    await options.onModelCall!({}); await tools[role === "reviewer" ? "submit_architecture_review" : "submit_architecture"]!.execute("submit", { done: true });
  });
  assert.deepEqual(await f.run(role), { done: true }); assert.equal(f.main.length, 1);
});

test("review needs_input同样经过必要性守卫，不能用一次评审结论绕过", async (t) => {
  const f = await fixture(t, async ({ tools }) => {
    const review = { verdict: "needs_input", issues: [{ id: "allowed_characters", blocking: true, description: "候选增加了字符限制", remedy: "请用户确认字符范围",
      references: proposal().references }] };
    await assert.rejects(tools.submit_architecture_review!.execute("review", review), /candidate_design_issue/);
    await tools.submit_architecture_review!.execute("revised", { done: true });
  });
  assert.deepEqual(await f.run("reviewer"), { done: true });
});

test("独立复核确认真实用户取舍才允许返需，并保存绑定后的必要性证据", async (t) => {
  const f = await fixture(t, async ({ tools }) => tools.request_requirements!.execute("handoff", { issues: [proposal()] }), "user_choice");
  const result = await f.run(); assert.equal(objectFields(objectFields(objectFields(result).needsInput)[0]).id, "allowed_characters");
  assert.equal(objectFields(objectFields(objectFields(objectFields(result).needsInput)[0]).necessity).classification, "user_choice"); assert.match(fixtureText(objectFields(objectFields(objectFields(objectFields(result).needsInput)[0]).necessity).contextHash), /^[a-f0-9]{64}$/);
});

for (const classification of ["already_answered", "system_verification", "runtime_input"]) test(`${classification}不转成用户新问题`, async (t) => {
  const f = await fixture(t, async ({ tools }) => {
    await assert.rejects(tools.request_requirements!.execute("handoff", { issues: [proposal()] }), new RegExp(classification));
    await tools.submit_architecture!.execute("submit", { done: true });
  }, classification);
  assert.deepEqual(await f.run(), { done: true });
});

test("检查器与主会话共享5轮，重试不重扣；耗尽保留turn_limit而非needs_input", async (t) => {
  const f = await fixture(t, async ({ tools, options }) => {
    for (let index = 0; index < 3; index++) await options.onModelCall!({});
    for (let index = 0; index < 20; index++) await options.onModelCall!({ retryAttempt: 1 });
    await assert.rejects(tools.request_requirements!.execute("handoff", { issues: [proposal()] }), /candidate_design_issue/);
    await options.onModelCall!({});
  });
  await assert.rejects(f.run(), (error: TestFailure) => error.diagnostic!.reason === "turn_limit" && error.diagnostic!.modelCalls === 5);
  assert.equal(f.main![0]!.aborted, true);
});

test("必要性模型失败与伪造引用都不能生成needs_input", async (t) => {
  const f = await fixture(t, async ({ tools }) => tools.request_requirements!.execute("handoff", { issues: [proposal()] }), "user_choice",
    async () => { throw new Error("PRIVATE_PROVIDER_SECRET"); });
  await assert.rejects(f.run(), (error: TestFailure) => error.diagnostic!.reason === "handoff_evaluation_incomplete" && !JSON.stringify(error).includes("PRIVATE_"));
  const bad = await fixture(t, async ({ tools }) => {
    const issue = proposal(); issue.references![0]!.quote = "不存在的原文";
    await assert.rejects(tools.request_requirements!.execute("handoff", { issues: [issue] }), /逐字引用/);
    await tools.submit_architecture!.execute("submit", { done: true });
  });
  assert.deepEqual(await bad.run(), { done: true });
});

test("独立复核保留完整确认证据，取消仍传播原cancelled原因", async (t) => {
  const controller = new AbortController(); let entered = false;
  const f = await fixture(t, async ({ tools }) => tools.request_requirements!.execute("handoff", { issues: [proposal()] }), "user_choice", async (options: PiSessionOptions) => ({
    modelCallAccounting: true, setAutoCompactionEnabled() {}, dispose() {}, async abort() {},
    async prompt(text: string) { await options.onModelCall!({}); const payload = JSON.parse(String(text)); entered = true;
      assert.equal(payload.confirmedRequirementContext.sourceQuotes[0].quote, "已给出的原始范围"); controller.abort(); },
  }));
  await assert.rejects(callFixture(f.designer.role, f.designer, [{ role: "designer", submitName: "submit_architecture", parameters, systemPrompt: "测试", payload: { requirements,
    confirmedRequirementContext: { sourceQuotes: [{ quote: "已给出的原始范围" }] } }, allowHandoff: true, validate: (value: unknown) => value,
    signal: controller.signal, onProgress() {} }]), (error: TestFailure) => error.diagnostic!.reason === "cancelled");
  assert.equal(entered, true);
});

test("真实Pi主会话返需先触发独立检查，被认定候选新增限制后当轮改设计", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-handoff-pi-")), requests: (("checker" | "main"))[] = [];
  let alwaysInvalid = false;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(String(Buffer.concat(chunks))), checker = body.tools.some((tool: { function: { name: string; }; }) => tool.function.name === "submit_handoff_necessity");
    requests.push(checker ? "checker" : "main");
    const content = body.messages.findLast((message: { role: string; }) => message.role === "user").content;
    const payload = JSON.parse(String(typeof content === "string" ? content : content.filter((entry: { type: string; }) => entry.type === "text").map((entry: { text: unknown; }) => entry.text).join("")));
    let name, value;
    if (checker) {
      assert.deepEqual(body.tools.map((tool: { function: { name: unknown; }; }) => tool.function.name), ["submit_handoff_necessity", "read_model_context"]);
      const retry = body.messages.some((message: { role: string; }) => message.role === "tool");
      name = "submit_handoff_necessity"; value = { contextHash: payload.contextHash, decisions: [{ issueId: "allowed_characters", classification: "candidate_design_issue",
        reason: "用户只规定长度及小写，字母白名单由候选自行增加。", references: retry && !alwaysInvalid ? proposal().references : [{ source: "requirements", path: "/0/text", quote: "不存在的证据" }] }] };
    } else if (!body.messages.some((message: { role: string; }) => message.role === "tool")) { name = "request_requirements"; value = { issues: [proposal()] }; }
    else { assert.match(body.messages.findLast((message: { role: string; }) => message.role === "tool").content, /candidate_design_issue/); name = "submit_architecture"; value = { done: true }; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "guard-fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(value) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const designer = new ArchitectureDesigner({ config: { chatUrl: `http://127.0.0.1:${listeningAddress(server).port}/v1/chat/completions`, model: "fixture-model", apiKey: "fixture-only" }, cwd: root, dataDir: root });
  await designer.ready; t.after(async () => { await designer.persistence; server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(root, { recursive: true, force: true }); });
  const result = await designer.role({ role: "designer", submitName: "submit_architecture", parameters, systemPrompt: "固定测试", payload: { requirements, previousDesign: { rule: "只允许字母和点" } }, allowHandoff: true, validate: (value: unknown) => value, onProgress() {} });
  assert.deepEqual(result, { done: true }); assert.deepEqual(requests, ["main", "checker", "checker", "main"]);
  alwaysInvalid = true;
  await assert.rejects(callFixture(designer.role, designer, [{ role: "designer", submitName: "submit_architecture", parameters, systemPrompt: "固定测试", payload: { requirements }, allowHandoff: true,
    validate: (value: unknown) => value, onProgress() {} }]), (error: TestFailure) => error.diagnostic!.reason === "handoff_evaluation_incomplete" && error.diagnostic!.modelCalls === 3);
  assert.deepEqual(requests.slice(4), ["main", "checker", "checker"], "检查器第3次格式修复在发送前阻止，不能增开额度");
});
