import { objectFields } from "../src/runtime/type-boundary.mjs";
import { fixtureTools } from "./helpers/m7-test-boundaries.mjs";
import type { Progress } from "../src/runtime/pi-port.mjs";
import type { CollaborationOptions } from "../src/agents/prototype-port.mjs";
import { toolText } from "./helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CollaborationService } from "../src/collaboration/groups.mjs";

interface GroupPayload { kind: string; goal: string; sharedMaterials: unknown[]; contextTruncated?: boolean; contextNotice: string }
interface GroupCall { agentId: string; kind: string; payload: GroupPayload; input: CollaborationOptions; tools: ReturnType<typeof fixtureTools> }
async function fixture(t: test.TestContext, execute: (call: GroupCall, context: { service: CollaborationService; signal: AbortSignal; calls: GroupCall[] }) => unknown | Promise<unknown>) {
  const root = await mkdtemp(join(tmpdir(), "neuma-group-question-")), calls: GroupCall[] = [], intentCalls: GroupCall[] = [];
  let service: CollaborationService;
  const agents = { ready: Promise.resolve(),
    async capabilityCards() { return { agents: ["A", "B", "C"].map((id) => ({ id, name: id, ready: true, revision: 1 })) }; },
    async activitySnapshot() { return { activities: [] }; },
    async executeCollaboration(input: CollaborationOptions, _progress?: Progress, { signal }: { signal?: AbortSignal | undefined } = {}) {
      assert.ok(signal);
      signal.throwIfAborted();
      const payload: GroupPayload = JSON.parse(String(input.message)), tools = fixtureTools(input.customTools);
      const call = { agentId: input.agentId, kind: payload.kind, payload, input, tools };
      if (input.role === "routing") {
        assert.equal(input.allowBusinessTools, false);
        await tools.submit_group_route!.execute("route", { mode: "default" }, signal);
        return { turns: 1 };
      }
      if (tools.submit_group_intent) {
        intentCalls.push(call);
        assert.equal(input.allowBusinessTools, false, "点名后的交互判断也不能获得业务权限");
        assert.equal(tools.submit_group_turn, undefined); assert.equal(tools.ask_group_member, undefined);
        await tools.submit_group_intent.execute("intent", { interaction: "task", participate: true, contribution: payload.goal.slice(0, 500),
          willingToIntegrate: true, integratorId: input.agentId }, signal);
        return { turns: 1 };
      }
      calls.push(call);
      await execute(call, { service, signal, calls }); return { turns: 1 };
    },
  };
  service = new CollaborationService({ dataDir: join(root, "data"), agents }); await service.ready;
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const result = await service.createGroup({ name: "提问验证组", purpose: "验证真实消息与调度", memberIds: ["A", "B", "C"], mutationId: "create_once" });
  const groupId = result.group.id;
  return { service, groupId, calls, intentCalls, async start(content = "整理报告") {
    const result = await service.postMessage(groupId, { content, recipientId: "A", mutationId: "first_task" });
    await service.idle(groupId); return (await service.getGroup(groupId)).tasks.find((task) => task.id === result.task!.id);
  } };
}

const submit = (tools: ReturnType<typeof fixtureTools>, status: string, result = "", reason = "") => tools.submit_group_turn!.execute("submit", { status, result, reason, artifactIds: [] });

test("三人提问链仅在真实答复后解锁，第三人回答重新唤起原问题", async (t) => {
  let originalQuestionId: unknown, nestedQuestionId: unknown, aWork = 0, bQuestions = 0;
  const f = await fixture(t, async ({ agentId, kind, tools, input }, { service }) => {
    if (agentId === "A" && kind === "work") {
      if (++aWork === 1) {
        const response = await tools.ask_group_member!.execute("ask-b", { agentId: "B", question: "请给我核实后的数据" });
        originalQuestionId = JSON.parse(String(toolText(response))).questionId; await submit(tools, "waiting", "等待 B 的核实数据");
      } else {
        const task = (await service.getGroup(input.scope.groupId)).tasks.find((value) => value.id === input.scope.taskId);
        assert.equal(task!.questions!.find((question) => question.id === originalQuestionId)!.status, "answered");
        await submit(tools, "complete", "报告素材已整理");
      }
    } else if (agentId === "B" && kind === "question") {
      if (++bQuestions === 1) {
        const response = await tools.ask_group_member!.execute("ask-c", { agentId: "C", question: "请核实原始数字" });
        nestedQuestionId = JSON.parse(String(toolText(response))).questionId; await submit(tools, "waiting", "等待 C 核实");
      } else {
        const task = (await service.getGroup(input.scope.groupId)).tasks.find((value) => value.id === input.scope.taskId);
        assert.equal(task!.questions!.find((question) => question.id === nestedQuestionId)!.status, "answered");
        assert.equal(task!.questions!.find((question) => question.id === originalQuestionId)!.status, "waiting");
        await submit(tools, "complete", "数字已经由 C 核实为 42");
      }
    } else if (agentId === "C" && kind === "question") {
      const task = (await service.getGroup(input.scope.groupId)).tasks.find((value) => value.id === input.scope.taskId);
      assert.equal(task!.questions!.find((question) => question.id === originalQuestionId)!.status, "waiting");
      assert.equal(task!.questions!.find((question) => question.id === nestedQuestionId)!.parentQuestionId, originalQuestionId);
      assert.equal(aWork, 1); await submit(tools, "complete", "核实数字为 42");
    } else if (kind === "integration") await submit(tools, "complete", "最终报告使用已核实数字 42");
    else assert.fail(`不应启动 ${agentId} 的 ${kind}`);
  });
  const task = await f.start();
  assert.equal(task!.status!, "completed"); assert.equal(aWork, 2); assert.equal(bQuestions, 2);
  assert.deepEqual(f.intentCalls.map((call) => call.agentId), ["A"]);
  assert.deepEqual(f.calls.map(({ agentId, kind }) => `${agentId}:${kind}`), ["A:work", "B:question", "C:question", "B:question", "A:work", "A:integration"]);
  assert.equal(task!.questions!.every((question) => question.status === "answered"), true);
});

test("被问成员缺少输入时保留待回答依赖，不能凭一段说明自动通过", async (t) => {
  let aWork = 0;
  const f = await fixture(t, async ({ agentId, kind, tools }) => {
    if (agentId === "A" && kind === "work") {
      aWork++; await tools.ask_group_member!.execute("ask-b", { agentId: "B", question: "请确认具体日期" });
      await submit(tools, "waiting", "等待日期");
    } else if (agentId === "B" && kind === "question") await submit(tools, "needs_input", "", "没有原始日期");
    else if (kind === "integration") await submit(tools, "needs_input", "", "原始日期尚未确认");
  });
  const task = await f.start();
  assert.equal(task!.status!, "needs_input"); assert.equal(aWork, 1);
  assert.equal(task!.questions![0]!.status, "needs_input"); assert.equal(task!.questions![0]!.answerId, undefined);
  assert.deepEqual(task!.children![0]!.pendingQuestions, [task!.questions![0]!.id]); assert.equal(task!.children![0]!.status, "waiting");
});

test("整合者等待答案后会重新进入整合并最终交付", async (t) => {
  let integrations = 0;
  const f = await fixture(t, async ({ agentId, kind, tools }) => {
    if (kind === "work") await submit(tools, "complete", "基础材料已经完成");
    else if (agentId === "A" && kind === "integration") {
      if (++integrations === 1) {
        await tools.ask_group_member!.execute("ask-b", { agentId: "B", question: "请确认最终数值" });
        await submit(tools, "waiting", "等待最终数值");
      } else await submit(tools, "complete", "最终数值已确认，报告完成");
    } else if (agentId === "B" && kind === "question") await submit(tools, "complete", "最终数值为 42");
    else assert.fail(`不应启动 ${agentId} 的 ${kind}`);
  });
  const task = await f.start(); assert.equal(task!.status!, "completed"); assert.equal(integrations, 2);
  assert.deepEqual(f.calls.map(({ agentId, kind }) => `${agentId}:${kind}`), ["A:work", "A:integration", "B:question", "A:integration"]);
});

test("用户补充信息后重新回答原问题，保留原问题ID并恢复提问者", async (t) => {
  let aWork = 0, bQuestions = 0, questionId: unknown;
  const f = await fixture(t, async ({ agentId, kind, tools, input }, { service }) => {
    if (agentId === "A" && kind === "work") {
      if (++aWork === 1) {
        const response = await tools.ask_group_member!.execute("ask-b", { agentId: "B", question: "请确认日期" });
        questionId = JSON.parse(String(toolText(response))).questionId; await submit(tools, "waiting", "等待日期");
      } else await submit(tools, "complete", "素材采用已核实日期");
    } else if (agentId === "B" && kind === "question") {
      if (++bQuestions === 1) await submit(tools, "needs_input", "", "缺少日期来源");
      else {
        assert.equal(JSON.parse(String(input.message)).triggeringMessage.id, questionId);
        await submit(tools, "complete", "日期为2026年10月11日");
      }
    } else if (kind === "update") await submit(tools, "complete", "已收到用户补充的日期来源");
    else if (kind === "integration") {
      const task = (await service.getGroup(input.scope.groupId)).tasks.find((value) => value.id === input.scope.taskId);
      await submit(tools, task!.children.every((child) => child.status === "completed") ? "complete" : "needs_input", "报告已整理", "等待确认日期");
    }
  });
  const paused = await f.start(); assert.equal(paused!.status!, "needs_input");
  await f.service.postMessage(f.groupId, { taskId: paused!.id!, content: "日期来源已提供，请继续", recipientId: "B", mutationId: "user_information" });
  await f.service.idle(f.groupId);
  const task = (await f.service.getGroup(f.groupId)).tasks[0];
  assert.equal(task!.status!, "completed"); assert.equal(task!.questions!.length, 1); assert.equal(task!.questions![0]!.id, questionId);
  assert.equal(task!.questions![0]!.status, "answered"); assert.equal(task!.children![0]!.pendingQuestions.length, 0);
  assert.equal(aWork, 2); assert.equal(bQuestions, 2);
});

test("整合轮次等待其他已排队工作和真实答案，不提前并行关闭任务", async (t) => {
  let aWork = 0, bAnswered = false;
  const f = await fixture(t, async ({ agentId, kind, tools, input }, { service }) => {
    if (agentId === "A" && kind === "work") {
      if (++aWork === 1) {
        await service.store.change(input.scope.groupId, (record) => {
          const task = record.tasks.find((value) => value.id === input.scope.taskId); service.queue(task!, "A", { kind: "integration" });
        });
        await tools.ask_group_member!.execute("ask-b", { agentId: "B", question: "请提供核实数据" });
        await submit(tools, "waiting", "等待核实数据");
      } else { assert.equal(bAnswered, true); await submit(tools, "complete", "数据工作完成"); }
    } else if (agentId === "B" && kind === "question") { bAnswered = true; await submit(tools, "complete", "数据已核实"); }
    else if (kind === "integration") { assert.equal(bAnswered, true); assert.equal(aWork, 2); await submit(tools, "complete", "最终报告完成"); }
  });
  const task = await f.start(); assert.equal(task!.status!, "completed");
  assert.deepEqual(f.calls.map(({ agentId, kind }) => `${agentId}:${kind}`), ["A:work", "B:question", "A:work", "A:integration"]);
});

test("执行上下文不暴露未登记到群的孤儿材料元数据", async (t) => {
  const f = await fixture(t, async ({ tools, payload }) => {
    assert.deepEqual(payload.sharedMaterials, []); await submit(tools, "complete", "没有未授权材料");
  });
  Reflect.set(f.service.materials, "list", async () => ({ attachments: [{ id: "orphan", name: "未登记的材料.txt" }] }));
  const task = await f.start(); assert.equal(task!.status!, "completed");
});

test("较长合法目标与群上下文使用受限摘要，原文可分页恢复", async (t) => {
  const goal = "长".repeat(12_000); let recovered = false;
  const f = await fixture(t, async ({ kind, payload, tools, input }) => {
    assert.ok(input.message.length <= 14_000);
    if (kind === "work") {
      assert.equal(payload.contextTruncated, true); assert.match(payload.contextNotice, /不完整摘要/);
      const first = JSON.parse(String(toolText((await tools.read_group_turn_context!.execute("page-one", { section: "goal", limit: 8000 })))));
      const second = JSON.parse(String(toolText((await tools.read_group_turn_context!.execute("page-two", { section: "goal", offset: first.nextOffset, limit: 8000 })))));
      assert.equal(JSON.parse(String(first.text + second.text)), goal); recovered = true;
    }
    await submit(tools, "complete", "真实目标已处理");
  });
  const task = await f.start(goal); assert.equal(task!.status!, "completed"); assert.equal(recovered, true);
});
