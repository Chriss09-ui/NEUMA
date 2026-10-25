import { callFixture } from "../helpers/m7-test-boundaries.mjs";
import type { GroupChild, GroupIntent, ReplySubmission } from "../../src/contracts/collaboration.mjs";
import { toolText } from "../helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { groupTools, intentTool, normalizeReplyRequest, replyTool } from "../../src/collaboration/group-tools.mjs";
import type { TurnSubmission } from "../../src/contracts/collaboration.mjs";

const conversation = (fields = {}) => ({ interaction: "conversation", participate: false, contribution: "", willingToIntegrate: false, integratorId: "", reply: "我收到交接了。", ...fields });
const request = { recipientId: "B", kind: "confirmation" };
const signal = () => new AbortController().signal;

function workSubmission({ kind = "integration", ownerId = "A", children = [], artifacts = [] }: { kind?: string; ownerId?: string; children?: Pick<GroupChild, "id" | "required" | "status">[]; artifacts?: { id: string }[] } = {}) {
  const task = { id: "task", ownerId, children, participants: [{ id: "A", name: "甲" }, { id: "B", name: "乙" }], questions: [] };
  const record = { group: { memberIds: ["A", "B"] }, tasks: [task], artifacts };
  const submissions: TurnSubmission[] = [], service = { store: { get: async () => record }, guard: () => task, materials: { tools: () => [] } };
  const tool = callFixture(groupTools, undefined, [service, { groupId: "group", taskId: task.id, agentId: "A", generation: 1,
    job: { id: "job", kind, childId: children[0]?.id }, signal: signal(), capture: (value: TurnSubmission) => submissions.push(value) }]).find((value) => value.name === "submit_group_turn");
  return { tool, task, record, submissions };
}

test("接话请求归一化只接受一位成员与明确的公开请求类型", () => {
  assert.equal(normalizeReplyRequest(undefined), undefined);
  for (const kind of ["question", "handoff", "confirmation"]) {
    const original = { recipientId: "B", kind }, normalized = normalizeReplyRequest(original);
    assert.deepEqual(normalized, original); assert.notEqual(normalized, original);
  }
  for (const value of [null, [], {}, { recipientId: "B" }, { kind: "question" }, { recipientId: "B", kind: "mention" },
    { recipientId: "", kind: "question" }, { recipientId: "../outside", kind: "question" }, { recipientId: ["B", "C"], kind: "question" },
    { ...request, execute: true }]) assert.throws(() => normalizeReplyRequest(value));
});

test("对话意向的请求补上同一成员引用，普通引用仍然不请求接话", async () => {
  const captured: GroupIntent[] = [], tool = intentTool((value) => captured.push(value));
  const response = await tool.execute("request", conversation({ replyRequest: request }), signal());
  assert.equal(response.terminate, true); assert.equal(JSON.parse(toolText(response)).submitted, true);
  assert.equal(captured[0]!.replyRecipientId, "B"); assert.deepEqual(captured[0]!.replyRequest, request);
  await tool.execute("reference", conversation({ replyRecipientId: "B" }), signal());
  assert.equal(captured[1]!.replyRecipientId, "B"); assert.equal(Object.hasOwn(captured[1]!, "replyRequest"), false);
  await assert.rejects(tool.execute("conflict", conversation({ replyRecipientId: "C", replyRequest: request }), signal()), /必须一致/);
  assert.equal(captured.length, 2);
});

test("实际任务意向不能用公开接话绕过原协作队列，旧工作意向保持默认", async () => {
  const captured: unknown[] = [], tool = intentTool((value) => captured.push(value));
  const original = { participate: true, contribution: "整理真实资料", willingToIntegrate: true, integratorId: "A" };
  await assert.rejects(tool.execute("request", { ...original, replyRequest: request }, signal()), /只有直接对话/);
  await tool.execute("legacy", original, signal());
  assert.deepEqual(captured, [{ ...original, interaction: "task" }]);
});

test("本人接话工具独立提交只读答复，默认完成且不制造业务成果", async () => {
  const captured: unknown[] = [], tool = replyTool((value) => captured.push(value));
  const response = await tool.execute("reply", { reply: "  收到，资料来源由我来核对。  " }, signal());
  assert.equal(response.terminate, true); assert.deepEqual(captured, [{ reply: "收到，资料来源由我来核对。", replyStatus: "complete" }]);
  for (const replyStatus of ["complete", "needs_input", "declined"]) {
    await tool.execute(replyStatus, { reply: "我还需要原始材料。", replyStatus, replyRecipientId: "B" }, signal());
    assert.deepEqual(captured.at(-1), { reply: "我还需要原始材料。", replyStatus, replyRecipientId: "B" });
  }
  await tool.execute("next", { reply: "请你确认原始材料的日期。", replyRequest: { recipientId: "B", kind: "question" } }, signal());
  assert.deepEqual(captured.at(-1), { reply: "请你确认原始材料的日期。", replyStatus: "complete", replyRecipientId: "B", replyRequest: { recipientId: "B", kind: "question" } });
});

test("接话提交显式拒绝任务认领、业务产物、无效正文和未知协议字段", async () => {
  const captured = [], tool = replyTool((value) => captured.push(value));
  for (const fields of [{ interaction: "task" }, { participate: true }, { willingToIntegrate: true }, { integratorId: "A" }, { artifactIds: ["artifact"] },
    { result: "伪造工作成果" }, { status: "complete" }, { reply: "" }, { reply: " ", replyStatus: "needs_input" }, { reply: "字".repeat(4001) },
    { replyStatus: "partial" }, { replyStatus: null }, { replyRecipientId: false }, { replyRecipientId: "" }, { replyRequest: null },
    { replyRecipientId: "C", replyRequest: request }]) {
    await assert.rejects(tool.execute("invalid", { reply: "我知道了。", ...fields }, signal()));
  }
  for (const value of [undefined, null, []]) await assert.rejects(tool.execute("invalid-object", value, signal()));
  assert.equal(captured.length, 0);
});

test("向同伴追问与请人补充区分，不能让已被同伴回答的问题永久停在待输入", async () => {
  let captured: ReplySubmission | undefined; const tool = replyTool((value) => { captured = value; });
  await assert.rejects(tool.execute("ambiguous", { reply: "你指哪一份资料？", replyStatus: "needs_input", replyRequest: { recipientId: "B", kind: "question" } }), /complete 加 replyRequest/);
  assert.equal(captured, undefined);
  await tool.execute("peer-question", { reply: "你指哪一份资料？", replyStatus: "complete", replyRequest: { recipientId: "B", kind: "question" } });
  assert.equal(captured!.replyStatus, "complete"); assert.equal(captured!.replyRequest!.recipientId, "B");
});

test("最终公开整合可提交定向接话，仍保留真实完成状态及成果引用", async () => {
  const { tool, submissions } = workSubmission({ artifacts: [{ id: "artifact" }] });
  await tool!.execute("final", { status: "complete", result: "已发布实际核对结果，请你确认交接。", artifactIds: ["artifact"], replyRequest: request });
  assert.deepEqual(submissions, [{ status: "complete", result: "已发布实际核对结果，请你确认交接。", reason: "", artifactIds: ["artifact"], replyRecipientId: "B", replyRequest: request }]);
  await tool!.execute("reference", { status: "partial", result: "这里只交付已核实部分。", replyRecipientId: "B" });
  assert.equal(submissions[1]!.replyRecipientId, "B"); assert.equal(Object.hasOwn(submissions[1]!, "replyRequest"), false);
  await assert.rejects(tool!.execute("conflict", { status: "complete", result: "结果", replyRecipientId: "C", replyRequest: request }), /必须一致/);
  assert.equal(submissions.length, 2);
});

test("后台工作和等待状态不能发起公开接话或改变内部问题语义", async () => {
  for (const kind of ["work", "question", "message", "update", "claim", "integration"]) {
    const { tool, submissions } = workSubmission({ kind });
    for (const references of [{ replyRequest: request }, { replyRecipientId: "B" }]) {
      await assert.rejects(tool!.execute("request", { status: kind === "integration" ? "waiting" : "complete", result: "等待内部协作", ...references }), /只有最终整合/);
    }
    await tool!.execute("legacy", { status: "waiting", result: "等待已经发出的内部请求。" });
    assert.deepEqual(submissions, [{ status: "waiting", result: "等待已经发出的内部请求。", reason: "", artifactIds: [] }]);
  }
});

test("公开接话请求不放宽整合者、必需子任务和真实产物校验", async () => {
  for (const { fixture, value, message } of [
    { fixture: { ownerId: "B" }, value: {}, message: /只有本任务临时整合者/ },
    { fixture: { children: [{ id: "child", required: true, status: "waiting" }] }, value: {}, message: /必需子任务尚未完成/ },
    { fixture: {}, value: { artifactIds: ["invented"] }, message: /只能引用本群已发布的成果/ },
  ]) {
    const { tool, submissions } = workSubmission(fixture);
    await assert.rejects(tool!.execute("invalid", { status: "complete", result: "交付结果", replyRequest: request, ...value }), message);
    assert.equal(submissions.length, 0);
  }
});

test("最终交付的普通引用也必须是真实本轮其他成员，不能引用自身或群外身份", async () => {
  for (const replyRecipientId of ["A", "outside", "former"]) {
    const { tool, record, submissions } = workSubmission();
    record.group.memberIds.push("former");
    await assert.rejects(tool!.execute("invalid-reference", { status: "complete", result: "实际交付", replyRecipientId }));
    assert.deepEqual<typeof submissions>(submissions, []);
  }
});

test("取消信号阻止三种提交工具捕获新的接话或最终结果", async () => {
  const captured: unknown[] = [], controller = new AbortController(); controller.abort();
  await assert.rejects(intentTool((value) => captured.push(value)).execute("intent", conversation({ replyRequest: request }), controller.signal));
  await assert.rejects(replyTool((value) => captured.push(value)).execute("reply", { reply: "我收到。", replyRequest: request }, controller.signal));
  const { tool, submissions } = workSubmission();
  await assert.rejects(tool!.execute("final", { status: "complete", result: "已完成", replyRequest: request }, controller.signal));
  assert.deepEqual<typeof captured>(captured, []); assert.deepEqual<typeof submissions>(submissions, []);
});
