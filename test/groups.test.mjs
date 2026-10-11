import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollaborationService } from "../src/collaboration/groups.mjs";
import { GroupStore } from "../src/collaboration/group-store.mjs";
import { groupTools } from "../src/collaboration/group-tools.mjs";

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function until(check) {
  const deadline = Date.now() + 3000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("群服务没有在预期时间推进");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
const parsed = (result) => JSON.parse(result.content[0].text);
const card = (id) => ({ id, name: `成员 ${id}`, description: `${id} 的公开功能`, task: "处理共享任务", input: "群共享资料",
  output: "明确结果", boundaries: ["只处理本群共享资料"], ready: true, revision: 1 });

async function fixture(t, { run, intent, limits } = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-groups-")), calls = [], holds = [], listeners = new Set();
  const cards = [card("a"), card("b"), card("outside")];
  let service, toolCalls = 0;
  const materials = { list: async () => ({ attachments: [] }), resolve: async (_groupId, refs) => refs,
    tools: () => [], close: async () => {} };
  const agents = { ready: Promise.resolve(), capabilityCards: async () => ({ agents: structuredClone(cards) }), activitySnapshot: async () => ({ activities: [] }),
    onLifecycle(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    file: async (_agentId, path) => ({ path, content: `实际产物：${path}`, truncated: false }),
    async executeCollaboration(options, _progress, { signal }) {
      const payload = JSON.parse(options.message), tools = Object.fromEntries(options.customTools.map((tool) => [tool.name, tool]));
      const call = async (name, input) => {
        assert.ok(tools[name], `必须提供 ${name}`);
        return tools[name].execute(`fixture-${++toolCalls}`, input, signal);
      };
      const entry = { options, payload, tools, call }; calls.push(entry);
      const context = { ...entry, service, signal, cards, hold: () => { const held = deferred(); holds.push(held); return held; } };
      if (tools.submit_group_intent) {
        const owner = payload.members[0].id;
        await call("submit_group_intent", intent ? await intent(context) : { participate: true, contribution: `${options.agentId} 的互补贡献`,
          willingToIntegrate: options.agentId === owner, integratorId: owner });
      } else if (run) await run(context);
      else await call("submit_group_turn", { status: "complete", result: payload.kind === "integration" ? "群成果已整合" : `${options.agentId} 的实际结果` });
      return { reply: "", turns: 1 };
    },
  };
  service = new CollaborationService({ dataDir: root, agents, materials, limits });
  t.after(async () => { for (const held of holds) held.resolve(); await service.close(); await rm(root, { recursive: true, force: true }); });
  await service.ready;
  const create = (mutationId = "create-one", memberIds = ["a", "b"]) => service.createGroup({ name: "长期团队", purpose: "共同处理材料", memberIds, mutationId });
  const post = (groupId, content = "完成一份共同成果", mutationId = "post-one", extra = {}) => service.postMessage(groupId, { content, mutationId, ...extra });
  const lifecycle = async (value) => { await Promise.all([...listeners].map((listener) => listener(value))); };
  return { root, service, agents, cards, calls, create, post, lifecycle };
}

test("全员初始认领，成员一致选临时整合者，互补分工后提交最终成果", { timeout: 5000 }, async (t) => {
  const { service, calls, create, post } = await fixture(t);
  const { group, members } = await create();
  assert.deepEqual(members.map((value) => value.id), ["a", "b"]);
  assert.equal(members.every((value) => value.description.endsWith("的公开功能")), true);
  const posted = await post(group.id); await service.idle(group.id);
  const view = await service.getGroup(group.id), task = view.tasks[0];
  assert.equal(task.id, posted.task.id); assert.equal(task.status, "completed"); assert.equal(task.ownerId, "a");
  assert.equal(task.result, "群成果已整合");
  assert.deepEqual(task.children.map((value) => value.assigneeId).sort(), ["a", "b"]);
  assert.equal(task.children.every((value) => value.status === "completed"), true);
  const intentions = calls.filter((entry) => entry.tools.submit_group_intent);
  assert.deepEqual(intentions.map((entry) => entry.options.agentId).sort(), ["a", "b"]);
  assert.equal(intentions.every((entry) => entry.options.allowBusinessTools === false), true);
  assert.equal(calls.filter((entry) => entry.payload.kind === "integration").length, 1);
  assert.equal(calls.every((entry) => entry.options.agentId !== "main"), true);
  const events = await service.events(group.id);
  assert.equal(new Set(events.events.map((value) => value.seq)).size, events.events.length);
  assert.equal(events.latestSequence, view.lastSequence);
});

test("两轮仍无一致整合者时等待用户，不强派或继续实际工作", { timeout: 5000 }, async (t) => {
  const { service, calls, create, post } = await fixture(t, { intent: async ({ options }) => ({ participate: true,
    contribution: `${options.agentId} 的贡献`, willingToIntegrate: true, integratorId: options.agentId }) });
  const { group } = await create(); await post(group.id); await service.idle(group.id);
  const task = (await service.getGroup(group.id)).tasks[0];
  assert.equal(task.status, "needs_input"); assert.equal(task.negotiationRound, 2); assert.equal(task.ownerId, null);
  assert.equal(calls.length, 4); assert.equal(calls.every((entry) => entry.tools.submit_group_intent), true);
});

test("A 请求 B 协助，B 问 A 资料问题，回答后自动恢复双方工作且不循环等待", { timeout: 5000 }, async (t) => {
  let askedHelp = false, askedQuestion = false;
  const { service, calls, create, post } = await fixture(t, { run: async ({ options, payload, call }) => {
    if (payload.kind === "question") {
      assert.equal(options.agentId, "a");
      await call("submit_group_turn", { status: "complete", result: "预算为100，请继续分析" }); return;
    }
    if (payload.kind === "work" && options.agentId === "a" && !askedHelp) {
      askedHelp = true;
      await call("request_group_help", { agentId: "b", title: "预算核对", description: "核对预算与建议" });
      await call("submit_group_turn", { status: "waiting", result: "", reason: "等待预算核对" }); return;
    }
    if (payload.kind === "work" && payload.child.title === "预算核对" && !askedQuestion) {
      askedQuestion = true;
      await call("ask_group_member", { agentId: "a", question: "预算是多少？" });
      await call("submit_group_turn", { status: "waiting", result: "", reason: "等待预算数据" }); return;
    }
    await call("submit_group_turn", { status: "complete", result: payload.kind === "integration" ? "已综合预算与各项分析" : "已完成当前工作" });
  } });
  const { group } = await create(); await post(group.id); await service.idle(group.id);
  const task = (await service.getGroup(group.id)).tasks[0];
  assert.equal(task.status, "completed"); assert.equal(askedHelp, true); assert.equal(askedQuestion, true);
  assert.equal(task.questions.every((value) => value.status === "answered"), true);
  assert.equal(task.children.every((value) => value.status === "completed" && value.pendingQuestions.length === 0), true);
  assert.equal(calls.filter((entry) => entry.payload.kind === "question").length, 1);
  assert.ok(calls.length < 12, "请求与恢复是有限短轮次");
});

test("发送/创建幂等，重用操作ID而内容不同报告冲突", { timeout: 5000 }, async (t) => {
  const { service, create, post } = await fixture(t);
  const first = await create(), replay = await create(); assert.equal(first.group.id, replay.group.id);
  const [one, two] = await Promise.all([post(first.group.id), post(first.group.id)]);
  assert.equal(one.task.id, two.task.id); assert.equal(one.message.id, two.message.id);
  await service.idle(first.group.id);
  const view = await service.getGroup(first.group.id);
  assert.equal(view.tasks.length, 1); assert.equal(view.messages.filter((value) => value.sender.type === "user").length, 1);
  await assert.rejects(post(first.group.id, "不同内容"), (error) => error.reason === "collaboration_conflict");
});

test("同群任务串行，另一群可独立推进", { timeout: 5000 }, async (t) => {
  let held, entered = false;
  const { service, calls, create, post } = await fixture(t, { run: async ({ payload, call, hold }) => {
    if (payload.goal === "任务一" && payload.kind === "work" && !entered) { entered = true; held = hold(); await held.promise; }
    await call("submit_group_turn", { status: "complete", result: `${payload.goal} 的结果` });
  } });
  const one = await create(), two = await create("create-two");
  const first = await post(one.group.id, "任务一", "first"); await until(() => Boolean(held));
  const second = await post(one.group.id, "任务二", "second");
  await post(two.group.id, "独立群任务", "independent"); await service.idle(two.group.id);
  assert.equal((await service.getGroup(two.group.id)).tasks[0].status, "completed");
  assert.equal(calls.some((entry) => entry.options.scope.taskId === second.task.id), false);
  assert.equal((await service.getGroup(one.group.id)).tasks.find((value) => value.id === second.task.id).status, "queued");
  held.resolve(); await service.idle(one.group.id);
  const tasks = (await service.getGroup(one.group.id)).tasks;
  assert.equal(tasks.every((value) => value.status === "completed"), true);
  const lastFirst = calls.map((entry) => entry.options.scope.taskId).lastIndexOf(first.task.id);
  const firstSecond = calls.findIndex((entry) => entry.options.scope.taskId === second.task.id);
  assert.ok(firstSecond > lastFirst);
});

test("停止后拒绝迟到工具结果，原任务不变成完成", { timeout: 5000 }, async (t) => {
  let held, lateRejected = false;
  const { service, create, post } = await fixture(t, { run: async ({ payload, call, hold }) => {
    if (payload.kind === "integration") {
      held = hold(); await held.promise;
      await assert.rejects(call("submit_group_turn", { status: "complete", result: "迟到最终成果" })); lateRejected = true; return;
    }
    await call("submit_group_turn", { status: "complete", result: "实际子任务成果" });
  } });
  const { group } = await create(), posted = await post(group.id); await until(() => Boolean(held));
  await service.cancelTask(group.id, posted.task.id); held.resolve(); await service.idle(group.id);
  const task = (await service.getGroup(group.id)).tasks[0];
  assert.equal(task.status, "cancelled"); assert.equal(task.result, ""); assert.equal(lateRejected, true);
  assert.equal(task.children.every((value) => value.result === "实际子任务成果"), true);
});

test("服务重启将未完成任务标为中断，不自动重放任务", { timeout: 5000 }, async (t) => {
  const { root, service, calls, agents, create, post } = await fixture(t);
  service.start = () => {};
  const { group } = await create(), posted = await post(group.id);
  const store = new GroupStore({ dataDir: root }); await store.ready;
  const restored = new CollaborationService({ dataDir: root, store, agents,
    materials: { list: async () => ({ attachments: [] }), close: async () => {} } });
  t.after(() => restored.close());
  const task = (await restored.getGroup(group.id)).tasks[0];
  assert.equal(task.status, "interrupted"); assert.equal(task.generation, posted.task.generation + 1);
  assert.equal(calls.length, 0);
  const saved = JSON.parse(await readFile(join(root, "groups", group.id, "group.json"), "utf8"));
  assert.equal(saved.tasks[0].status, "interrupted"); assert.equal(saved.group.activeTaskId, null);
});

test("成员更新或删除时等待用户的任务也失效，不能继续使用旧参与版本", { timeout: 5000 }, async (t) => {
  const { service, cards, lifecycle, create, post } = await fixture(t, { intent: async () => ({ participate: false,
    contribution: "", willingToIntegrate: false, integratorId: "" }) });
  const { group } = await create(), posted = await post(group.id); await service.idle(group.id);
  assert.equal((await service.getGroup(group.id)).tasks[0].status, "needs_input");
  cards[0].revision = 2; await lifecycle({ type: "build", agentId: "a" });
  const updated = (await service.getGroup(group.id)).tasks[0];
  assert.equal(updated.status, "interrupted"); assert.ok(updated.generation > posted.task.generation);
  const second = await post(group.id, "另一项工作", "post-two"); await service.idle(group.id);
  assert.equal((await service.getGroup(group.id)).tasks.find((value) => value.id === second.task.id).status, "needs_input");
  cards.splice(1, 1); await lifecycle({ type: "remove", agentId: "b" });
  assert.equal((await service.getGroup(group.id)).tasks.find((value) => value.id === second.task.id).status, "interrupted");
});

test("自动轮次预算耗尽后等待用户，不能继续调用整合轮次", { timeout: 5000 }, async (t) => {
  const { service, calls, create, post } = await fixture(t, { limits: { executionTurns: 1, turnLimit: 1 } });
  const { group } = await create(); await post(group.id); await service.idle(group.id);
  const task = (await service.getGroup(group.id)).tasks[0], executions = calls.filter((entry) => !entry.tools.submit_group_intent);
  assert.equal(task.status, "needs_input"); assert.match(task.reason, /轮次/); assert.equal(task.turnsUsed, 1);
  assert.equal(executions.length, 1); assert.equal(executions[0].options.maxTurns, 1);
  assert.equal(calls.some((entry) => entry.payload.kind === "integration"), false);
});

test("同一子任务认领原子互斥，群外成员与主 Agent 不能被群工具直接唤起", { timeout: 5000 }, async (t) => {
  const { service, create, post } = await fixture(t); service.start = () => {};
  const { group } = await create(), posted = await post(group.id);
  const signal = new AbortController().signal;
  const tools = (agentId) => Object.fromEntries(groupTools(service, { groupId: group.id, taskId: posted.task.id, agentId,
    generation: 1, job: { kind: "work", childId: null }, signal, capture: () => {} }).map((tool) => [tool.name, tool]));
  const a = tools("a"), b = tools("b");
  const proposed = parsed(await a.propose_group_task.execute("propose", { title: "唯一工作", description: "只能由一个主执行者承担" }, signal));
  const claims = await Promise.all([a.claim_group_task.execute("claim-a", { taskId: proposed.taskId }, signal), b.claim_group_task.execute("claim-b", { taskId: proposed.taskId }, signal)]);
  assert.equal(claims.map(parsed).filter((value) => value.claimed).length, 1);
  const child = (await service.getGroup(group.id)).tasks[0].children[0];
  assert.equal(child.assigneeId, "a");
  for (const recipientId of ["outside", "main"]) await assert.rejects(a.send_group_message.execute("outside", { recipientId, content: "请直接工作" }, signal), /本轮已就绪的群成员/);
  const announced = parsed(await a.send_group_message.execute("public", { content: "公开资料信息" }, signal));
  assert.equal(announced.queued, false);
});

test("补充子任务认领仍只装协作工具，实际工作由后续独立轮次执行", { timeout: 5000 }, async (t) => {
  let proposed = false;
  const { service, calls, create, post } = await fixture(t, { run: async ({ payload, options, call }) => {
    if (payload.kind === "claim") {
      assert.equal(options.allowBusinessTools, false, "子任务认领不应拥有业务工具");
      const claim = parsed(await call("claim_group_task", { taskId: payload.child.id }));
      await call("submit_group_turn", { status: "complete", result: claim.claimed ? "自愿承担补充工作" : "已有成员认领" }); return;
    }
    if (payload.kind === "work" && options.agentId === "a" && !proposed) {
      proposed = true;
      await call("propose_group_task", { title: "补充复核", description: "请合适成员自愿复核" });
    }
    await call("submit_group_turn", { status: "complete", result: payload.kind === "integration" ? "各项工作与复核已整合" : "实际结果" });
  } });
  const { group } = await create(); await post(group.id); await service.idle(group.id);
  const task = (await service.getGroup(group.id)).tasks[0];
  assert.equal(task.status, "completed"); assert.equal(task.children.length, 3);
  assert.equal(task.children.find((value) => value.title === "补充复核").status, "completed");
  assert.ok(calls.some((entry) => entry.payload.kind === "claim"));
});

test("群产物发布只接本任务相对路径，公开结果为真实文件快照", { timeout: 5000 }, async (t) => {
  const fileCalls = [];
  const { service, agents, create, post } = await fixture(t, { run: async ({ options, payload, call }) => {
    if (payload.kind === "work") {
      for (const path of ["../private.txt", "/tmp/private.txt"]) await assert.rejects(call("publish_group_artifact", { path }));
      const artifact = parsed(await call("publish_group_artifact", { path: `${options.agentId}.md` }));
      await call("submit_group_turn", { status: "complete", result: "工作文件已发布", artifactIds: [artifact.id] }); return;
    }
    await call("submit_group_turn", { status: "complete", result: "已读取并整合群成果" });
  } });
  agents.file = async (agentId, path) => { fileCalls.push({ agentId, path }); return { path, content: "实际文件内容", truncated: false }; };
  const { group } = await create(), posted = await post(group.id); await service.idle(group.id);
  const view = await service.getGroup(group.id);
  assert.equal(view.tasks[0].status, "completed"); assert.equal(view.artifacts.length, 2);
  assert.equal(fileCalls.every((value) => value.path === `group-tasks/${group.id}/${posted.task.id}/${value.agentId}/${value.agentId}.md`), true);
  assert.equal(view.artifacts.some((value) => "content" in value), false);
  assert.equal((await service.artifact(group.id, view.artifacts[0].id)).content, "实际文件内容");
});
