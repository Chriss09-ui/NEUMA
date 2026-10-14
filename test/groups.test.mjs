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
const capabilityCard = (id, version = `${id}-capabilities-v1`) => ({ ...card(id), capabilitySchemaVersion: 1, capabilityVersion: version,
  capabilities: [{ id: "action:verify", label: "核对", description: "核对共享资料", scope: "group_task", availability: "callable", requirements: [], reason: "可调用",
    verification: { status: "unverified", checkedAt: null, description: "结果需逐次核验" } }], hardBoundaries: [{ id: "group-only", label: "群共享资料", reason: "不能访问私聊材料" }] });
const toolsFor = (service, groupId, taskId, agentId, job = { kind: "work", childId: null, id: "manual" }) => Object.fromEntries(groupTools(service,
  { groupId, taskId, agentId, generation: 1, job, signal: new AbortController().signal, capture: () => {} }).map((tool) => [tool.name, tool]));

async function fixture(t, { run, intent, limits } = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-groups-")), calls = [], capabilityCalls = [], holds = [], listeners = new Set();
  const cards = [card("a"), card("b"), card("outside")];
  let service, toolCalls = 0;
  const materials = { list: async () => ({ attachments: [] }), resolve: async (_groupId, refs) => refs,
    tools: () => [], close: async () => {} };
  const agents = { ready: Promise.resolve(), capabilityCards: async (options) => {
    capabilityCalls.push(structuredClone(options));
    return { agents: structuredClone(options?.agentIds ? cards.filter((card) => options.agentIds.includes(card.id)) : cards) };
  }, activitySnapshot: async () => ({ activities: [] }),
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
  return { root, service, agents, cards, calls, capabilityCalls, create, post, lifecycle };
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

test("显式能力求助完整读卡后才排队，保留交接信息并拒绝不可调用能力", async (t) => {
  const { service, cards, create, post } = await fixture(t); service.start = () => {};
  cards[0] = capabilityCard("a"); cards[1] = capabilityCard("b");
  cards[1].boundaries = ["限制".repeat(6000)];
  for (const availability of ["conditional", "unavailable", "forbidden", "unknown"]) cards[1].capabilities.push({
    ...cards[1].capabilities[0], id: `action:${availability}`, availability, reason: "执行条件未满足" });
  const { group } = await create(), posted = await post(group.id), tools = toolsFor(service, group.id, posted.task.id, "a");
  const request = { agentId: "b", title: "资料核对", description: "核对已分享的数字", capabilityId: "action:verify", capabilityVersion: cards[1].capabilityVersion,
    inputs: "本群材料中的表格", expectedOutput: "数字核对结果", acceptance: "列出差异及来源" };
  await assert.rejects(tools.request_group_help.execute("before-read", request), /完整当前能力卡/);
  let page = parsed(await tools.read_group_member_capabilities.execute("first-page", { agentId: "b", limit: 2000 })), source = page.text;
  const readSnapshot = structuredClone(cards[1]);
  cards[1].capabilities[0].verification.description = "读取期间更新的验证记录";
  assert.notEqual(page.nextOffset, null);
  await assert.rejects(tools.request_group_help.execute("partial-read", request), /完整当前能力卡/);
  while (page.nextOffset !== null) {
    page = parsed(await tools.read_group_member_capabilities.execute("next-page", { agentId: "b", offset: page.nextOffset, limit: 8000 })); source += page.text;
  }
  assert.deepEqual(JSON.parse(source), readSnapshot, "验证记录变动不能把分页卡片拼成不同快照");
  for (const availability of ["conditional", "unavailable", "forbidden", "unknown"]) await assert.rejects(
    tools.request_group_help.execute(`denied-${availability}`, { ...request, capabilityId: `action:${availability}` }), /不能用于群任务/);
  await assert.rejects(tools.propose_group_task.execute("unavailable-proposal", { title: "缺条件的工作", description: "不能排入认领", capabilityId: "action:conditional" }), /没有已完整读取.*可调用成员/);
  await assert.rejects(tools.request_group_help.execute("unknown-action", { ...request, capabilityId: "action:invented" }), /没有这项公开能力/);
  await assert.rejects(tools.read_group_member_capabilities.execute("outside", { agentId: "outside" }), /只能读取本群成员/);
  const response = parsed(await tools.request_group_help.execute("valid-help", request));
  const task = (await service.getGroup(group.id)).tasks[0], child = task.children.find((value) => value.id === response.taskId);
  for (const field of ["capabilityId", "capabilityVersion", "inputs", "expectedOutput", "acceptance"]) assert.equal(child[field], request[field]);
  assert.equal(task.jobs.length, 1); assert.equal(task.jobs[0].agentId, "b"); assert.equal(child.status, "queued");
});

test("不指定能力版本的提议允许不同卡版本成员自愿认领，实际认领绑定本人版本", async (t) => {
  const { service, cards, create, post } = await fixture(t); service.start = () => {};
  cards[0] = capabilityCard("a", "a-version"); cards[1] = capabilityCard("b", "b-version");
  const { group } = await create(), posted = await post(group.id);
  const a = toolsFor(service, group.id, posted.task.id, "a"), b = toolsFor(service, group.id, posted.task.id, "b");
  await a.read_group_member_capabilities.execute("read-a", { agentId: "a" });
  const proposed = parsed(await a.propose_group_task.execute("propose-capability", { title: "自愿核对", description: "由合适成员核对", capabilityId: "action:verify", inputs: "共享表格" }));
  let task = (await service.getGroup(group.id)).tasks[0];
  assert.deepEqual(task.jobs.map((value) => value.agentId), ["a", "b"]);
  await assert.rejects(b.claim_group_task.execute("claim-before-read", { taskId: proposed.taskId }), /完整当前能力卡/);
  await b.read_group_member_capabilities.execute("read-b", { agentId: "b" });
  assert.equal(parsed(await b.claim_group_task.execute("claim-b", { taskId: proposed.taskId })).claimed, true);
  task = (await service.getGroup(group.id)).tasks[0];
  assert.equal(task.children[0].assigneeId, "b"); assert.equal(task.children[0].capabilityVersion, "b-version");
});

test("群能力版本变化中断旧任务并保留成果，验证记录变化不改变绑定", async (t) => {
  const { service, cards, create, post } = await fixture(t); service.start = () => {};
  cards[0] = capabilityCard("a"); cards[1] = capabilityCard("b");
  const { group } = await create(), posted = await post(group.id);
  assert.equal(posted.task.participants[0].capabilityVersion, cards[0].capabilityVersion);
  await service.store.change(group.id, (record) => {
    const task = record.tasks[0], child = service.makeChild(task, { title: "已有结果", assigneeId: "a" });
    child.status = "completed"; child.result = "已核对的数据";
    service.makeChild(task, { title: "等待工作", assigneeId: "b" }); service.queue(task, "b", { childId: task.children[1].id });
  });
  cards[1].capabilities[0].verification = { status: "last_call_failed", checkedAt: new Date().toISOString(), description: "本次网络失败" };
  await service.validateTaskCapabilities(group.id, posted.task.id, 1);
  assert.equal((await service.getGroup(group.id)).tasks[0].status, "queued");
  cards[1].capabilityVersion = "b-config-changed";
  await assert.rejects(service.validateTaskCapabilities(group.id, posted.task.id, 1), /能力、执行条件或定义已变化/);
  const task = (await service.getGroup(group.id)).tasks[0];
  assert.equal(task.status, "interrupted"); assert.match(task.reason, /能力/); assert.equal(task.generation, 2);
  assert.equal(task.children[0].result, "已核对的数据"); assert.equal(task.children[0].status, "completed"); assert.equal(task.jobs[0].status, "interrupted");
});

test("认领与工作请求都传递绑定的能力版本，不因已可调用开放认领业务权限", async (t) => {
  const { service, cards, calls, create, post } = await fixture(t);
  cards[0] = capabilityCard("a"); cards[1] = capabilityCard("b");
  const { group } = await create(); await post(group.id); await service.idle(group.id);
  assert.equal((await service.getGroup(group.id)).tasks[0].status, "completed");
  assert.ok(calls.some((entry) => entry.tools.submit_group_intent));
  assert.equal(calls.every(({ options }) => options.capabilityVersion === cards.find((value) => value.id === options.agentId).capabilityVersion), true);
  assert.equal(calls.filter((entry) => entry.tools.submit_group_intent).every(({ options, tools }) => options.allowBusinessTools === false && tools.read_group_member_capabilities), true);
});

test("长群资料保留全部成员及未就绪成员索引，完整边界可按成员分页恢复", async (t) => {
  let recovered = false;
  const { service, cards, create, post } = await fixture(t, { intent: async ({ payload, call }) => {
    assert.equal(payload.contextTruncated, true); assert.match(payload.contextNotice, /省略.*边界/);
    assert.equal(payload.members.length, 27); assert.equal(payload.members.at(-1).id, "member-26"); assert.equal(payload.members.at(-1).ready, false);
    if (!recovered) {
      let page = parsed(await call("read_group_member_capabilities", { agentId: "member-26" })), source = page.text;
      while (page.nextOffset !== null) { page = parsed(await call("read_group_member_capabilities", { agentId: "member-26", offset: page.nextOffset })); source += page.text; }
      assert.equal(JSON.parse(source).boundaries[0], "不能读取私聊".repeat(2500)); recovered = true;
    }
    return { participate: false, contribution: "", willingToIntegrate: false, integratorId: "" };
  } });
  cards.splice(0, cards.length, ...Array.from({ length: 27 }, (_, index) => capabilityCard(`member-${index}`)));
  cards.at(-1).ready = false; cards.at(-1).boundaries = ["不能读取私聊".repeat(2500)];
  const { group } = await create("many-members", cards.map((value) => value.id)); await post(group.id); await service.idle(group.id);
  assert.equal(recovered, true); assert.equal((await service.getGroup(group.id)).tasks[0].status, "needs_input");
});

test("任务联网策略只来自用户及主 Agent 原话，不被其他成员禁网资料污染", async (t) => {
  const { service, cards, calls, create, post } = await fixture(t);
  cards[0] = capabilityCard("a"); cards[1] = capabilityCard("b");
  cards[1].boundaries = ["禁止联网，仅使用离线资料"];
  const { group } = await create(); await post(group.id, "查询公开资料", "online-task"); await service.idle(group.id);
  assert.equal(calls.every(({ options }) => options.taskAllowNetwork === true), true);
  calls.length = 0;
  await post(group.id, "不得联网，只整理本地资料", "offline-task"); await service.idle(group.id);
  assert.equal(calls.every(({ options }) => options.taskAllowNetwork === false), true);
  service.start = () => {};
  for (const card of cards.slice(0, 2)) card.capabilities.push({ ...card.capabilities[0], id: "web_search", label: "公共搜索" });
  const posted = await post(group.id, "仅离线整理", "offline-explicit");
  const tools = toolsFor(service, group.id, posted.task.id, "a");
  await tools.read_group_member_capabilities.execute("read-online-member", { agentId: "b" });
  await assert.rejects(tools.request_group_help.execute("blocked-web-help", { agentId: "b", title: "公开搜索", description: "搜索公开资料", capabilityId: "web_search", capabilityVersion: cards[1].capabilityVersion }), /本次用户任务禁止联网/);
  await assert.rejects(tools.propose_group_task.execute("blocked-web-proposal", { title: "公开搜索", description: "搜索公开资料", capabilityId: "web_search" }), /本次用户任务禁止联网/);
  assert.equal((await service.getGroup(group.id)).tasks.at(-1).jobs.length, 0);
});

test("能力执行期间变更报为中断，已完成子任务结果不被后续错误覆盖", async (t) => {
  let changed = false;
  const { service, cards, create, post } = await fixture(t, { run: async ({ payload }) => {
    if (payload.kind === "work" && !changed) { changed = true; cards[1].capabilityVersion = "new-b-version"; throw new Error("执行器检测到能力版本变化"); }
  } });
  cards[0] = capabilityCard("a"); cards[1] = capabilityCard("b");
  service.start = () => {};
  const { group } = await create(), posted = await post(group.id, "继续已有成果", "late-capability-change", { recipientId: "a" });
  await service.store.change(group.id, (record) => {
    const task = record.tasks[0], done = service.makeChild(task, { title: "已有成果", assigneeId: "a" });
    done.status = "completed"; done.result = "已经保存的真实结果";
    const pending = service.makeChild(task, { title: "后续工作", assigneeId: "b" }); service.queue(task, "b", { childId: pending.id });
    task.ownerId = "a"; task.phase = "execution";
  });
  delete service.start; service.start(group.id); await service.idle(group.id);
  const task = (await service.getGroup(group.id)).tasks.find((value) => value.id === posted.task.id);
  assert.equal(task.status, "interrupted"); assert.match(task.reason, /能力/);
  assert.equal(task.children[0].status, "completed"); assert.equal(task.children[0].result, "已经保存的真实结果");
  assert.equal(task.children[1].status, "interrupted");
});

test("显式能力求助接收者可以说明缺输入，交接要求不会被当成已完成成果", async (t) => {
  let requested = false;
  const { service, cards, calls, create, post } = await fixture(t, { run: async ({ options, payload, call }) => {
    if (payload.kind === "work" && options.agentId === "a" && !requested) {
      requested = true; await call("read_group_member_capabilities", { agentId: "b" });
      await call("request_group_help", { agentId: "b", title: "核对预算", description: "需要原始预算表", capabilityId: "action:verify", capabilityVersion: cards[1].capabilityVersion,
        inputs: "待用户提供预算表", expectedOutput: "逐项核对结果", acceptance: "差异对应原始行号" });
      await call("submit_group_turn", { status: "waiting", result: "", reason: "等待预算核对" });
    } else if (payload.kind === "work" && options.agentId === "b") {
      assert.equal(payload.child.inputs, "待用户提供预算表"); assert.equal(payload.child.expectedOutput, "逐项核对结果"); assert.equal(payload.child.acceptance, "差异对应原始行号");
      await call("submit_group_turn", { status: "needs_input", result: "", reason: "共享材料没有原始预算表" });
    } else if (payload.kind === "integration") await call("submit_group_turn", { status: "needs_input", result: "", reason: "缺少预算表，无法交付" });
    else assert.fail(`不应执行 ${options.agentId}:${payload.kind}`);
  } });
  cards[0] = capabilityCard("a"); cards[1] = capabilityCard("b");
  const { group } = await create(); await post(group.id, "核对预算", "missing-budget", { recipientId: "a" }); await service.idle(group.id);
  const task = (await service.getGroup(group.id)).tasks[0], child = task.children.find((value) => value.title === "核对预算" && value.assigneeId === "b");
  assert.equal(task.status, "needs_input"); assert.equal(child.status, "needs_input"); assert.equal(child.result, ""); assert.match(child.reason, /没有原始预算表/);
  assert.equal(calls.filter((entry) => entry.options.agentId === "b").length, 1);
});

test("群详情与任务版本复核只投影当前成员，公开全体列表仍兼容", async (t) => {
  const { service, capabilityCalls, create, post } = await fixture(t); service.start = () => {};
  const { group } = await create(), posted = await post(group.id);
  capabilityCalls.length = 0;
  await service.groupMemberCards(group.id);
  await service.validateTaskCapabilities(group.id, posted.task.id, 1);
  await service.getGroup(group.id);
  assert.equal(capabilityCalls.length, 3);
  assert.equal(capabilityCalls.every((value) => value.agentIds.join(",") === "a,b"), true);
  assert.equal((await service.cards()).some((member) => member.id === "outside"), true);
  assert.equal(capabilityCalls.at(-1), undefined);
});

test("长子任务摘要保留能力引用及截断交接，完整输入输出和验收条件可分页恢复", async (t) => {
  let recovered = false;
  const inputs = "共享输入".repeat(1000), expectedOutput = "预期输出".repeat(1000), acceptance = "完成条件".repeat(1000);
  const { service, cards, create, post } = await fixture(t, { run: async ({ payload, call }) => {
    if (payload.kind === "work") {
      assert.equal(payload.contextTruncated, true); assert.match(payload.contextNotice, /section:'child'/);
      assert.equal(payload.child.capabilityId, "action:verify"); assert.equal(payload.child.capabilityVersion, cards[0].capabilityVersion);
      for (const field of ["inputs", "expectedOutput", "acceptance"]) assert.match(payload.child[field], /已截断/);
      let page = parsed(await call("read_group_turn_context", { section: "child", limit: 8000 })), source = page.text;
      while (page.nextOffset !== null) { page = parsed(await call("read_group_turn_context", { section: "child", offset: page.nextOffset, limit: 8000 })); source += page.text; }
      const full = JSON.parse(source); assert.equal(full.inputs, inputs); assert.equal(full.expectedOutput, expectedOutput); assert.equal(full.acceptance, acceptance);
      recovered = true;
    }
    await call("submit_group_turn", { status: "complete", result: "已经读取完整交接并完成" });
  } });
  cards[0] = capabilityCard("a"); cards[1] = capabilityCard("b"); service.start = () => {};
  const { group } = await create(), posted = await post(group.id);
  await service.store.change(group.id, (record) => {
    const task = record.tasks[0]; task.ownerId = "a"; task.phase = "execution";
    const child = service.makeChild(task, { title: "长交接核对", description: "核对说明".repeat(1000), assigneeId: "a", capabilityId: "action:verify", capabilityVersion: cards[0].capabilityVersion,
      inputs, expectedOutput, acceptance });
    service.queue(task, "a", { childId: child.id });
  });
  delete service.start; service.start(group.id); await service.idle(group.id);
  assert.equal(recovered, true); assert.equal((await service.getGroup(group.id)).tasks.find((value) => value.id === posted.task.id).status, "completed");
});

test("离线任务按 requiresNetwork 拒绝业务联网能力，并只向本地候选发认领机会", async (t) => {
  const { service, cards, create, post } = await fixture(t); service.start = () => {};
  cards[0] = capabilityCard("a"); cards[1] = capabilityCard("b"); cards[1].capabilities[0].requiresNetwork = true;
  const { group } = await create(), posted = await post(group.id, "只使用离线资料", "offline-action");
  const a = toolsFor(service, group.id, posted.task.id, "a"), b = toolsFor(service, group.id, posted.task.id, "b");
  await a.read_group_member_capabilities.execute("read-network-b", { agentId: "b" });
  await assert.rejects(a.request_group_help.execute("block-business-network", { agentId: "b", title: "业务核对", description: "依赖业务连接", capabilityId: "action:verify", capabilityVersion: cards[1].capabilityVersion }), /本次用户任务禁止联网/);
  await a.read_group_member_capabilities.execute("read-local-a", { agentId: "a" });
  const proposed = parsed(await a.propose_group_task.execute("local-candidate", { title: "本地核对", description: "合适成员认领", capabilityId: "action:verify" }));
  assert.deepEqual((await service.getGroup(group.id)).tasks[0].jobs.map((value) => value.agentId), ["a"]);
  await b.read_group_member_capabilities.execute("b-read-self", { agentId: "b" });
  await assert.rejects(b.claim_group_task.execute("b-cannot-claim", { taskId: proposed.taskId }), /本次用户任务禁止联网/);
  assert.equal((await service.getGroup(group.id)).tasks[0].children[0].assigneeId, null);
});

test("主 Agent 可信禁网策略持久约束，HTTP 输入及后续允许联网不能放宽", async (t) => {
  const { service, cards, calls, create } = await fixture(t, { intent: async () => ({ participate: false, contribution: "", willingToIntegrate: false, integratorId: "" }) });
  cards[0] = capabilityCard("a"); cards[1] = capabilityCard("b"); cards[1].capabilities[0].requiresNetwork = true;
  const { group } = await create();
  const input = { content: "整理公开资料", mutationId: "main-trusted-offline", taskAllowNetwork: true };
  const posted = await service.postMessage(group.id, input, { source: "main", taskAllowNetwork: false }); await service.idle(group.id);
  assert.equal((await service.getGroup(group.id)).tasks[0].taskAllowNetwork, false);
  assert.equal(calls.every(({ options }) => options.taskAllowNetwork === false), true);
  assert.equal((await service.postMessage(group.id, input, { source: "main", taskAllowNetwork: false })).task.id, posted.task.id);
  await assert.rejects(service.postMessage(group.id, input, { source: "main", taskAllowNetwork: true }), (error) => error.reason === "collaboration_conflict");
  service.start = () => {};
  await service.postMessage(group.id, { content: "继续完成资料整理", taskId: posted.task.id, recipientId: "a", mutationId: "main-followup", taskAllowNetwork: true }, { source: "main", taskAllowNetwork: true });
  assert.equal((await service.getGroup(group.id)).tasks[0].taskAllowNetwork, false);
  assert.equal((await service.getGroup(group.id)).tasks[0].generation, 1, "原本已经禁网的普通补充不应中断任务");
  const tools = toolsFor(service, group.id, posted.task.id, "a");
  await tools.read_group_member_capabilities.execute("read-business-b", { agentId: "b" });
  await assert.rejects(tools.request_group_help.execute("trusted-policy-blocks-action", { agentId: "b", title: "核对资料", description: "需要业务联网", capabilityId: "action:verify", capabilityVersion: cards[1].capabilityVersion }), /本次用户任务禁止联网/);
  for (const invalid of [true, "false"]) await assert.rejects(service.postMessage(group.id, { content: "客户端不能设可信联网策略", mutationId: `invalid-${invalid}` }, { taskAllowNetwork: invalid }), /可信任务联网策略/);
  await assert.rejects(service.postMessage(group.id, { content: "类型必须正确", mutationId: "invalid-main-policy" }, { source: "main", taskAllowNetwork: "false" }), /可信任务联网策略/);
});

test("运行期间收紧用户联网限制立即中断信号，保存新原话及已有成果而不重放旧工作", async (t) => {
  let held, runningSignal, lateRejected = 0;
  const { service, calls, create, post } = await fixture(t, { run: async ({ payload, call, hold, signal }) => {
    if (payload.kind === "integration") {
      held = hold(); runningSignal = signal; await held.promise;
      await assert.rejects(call("submit_group_turn", { status: "complete", result: "旧政策下的迟到结果" })); lateRejected++;
    } else await call("submit_group_turn", { status: "complete", result: "已经保存的材料核对结果" });
  } });
  const { group } = await create(), posted = await post(group.id, "查询并整理公开资料", "online-before-change", { recipientId: "a" });
  await until(() => Boolean(held));
  const agentTools = toolsFor(service, group.id, posted.task.id, "a");
  await agentTools.send_group_message.execute("member-network-boundary", { content: "我的能力要求不要联网" });
  assert.equal(runningSignal.aborted, false, "成员资料不能代替用户更新权限");
  const input = { content: "接下来不要联网", taskId: posted.task.id, mutationId: "user-restricts-network" };
  const changed = await service.postMessage(group.id, input);
  assert.equal(runningSignal.aborted, true); assert.equal(changed.task.status, "interrupted"); assert.match(changed.task.reason, /联网限制已更新.*创建新任务/);
  const replay = await service.postMessage(group.id, input);
  assert.equal(replay.message.id, changed.message.id); assert.equal(replay.task.generation, changed.task.generation);
  let view = await service.getGroup(group.id), task = view.tasks[0];
  assert.equal(view.messages.filter((value) => value.content === input.content).length, 1);
  assert.equal(task.children[0].status, "completed"); assert.equal(task.children[0].result, "已经保存的材料核对结果");
  assert.equal(task.jobs.some((value) => value.status === "queued"), false);
  held.resolve(); await service.idle(group.id); assert.equal(lateRejected, 1); assert.equal(calls.length, 2);

  held = null; runningSignal = null;
  const next = await post(group.id, "整理第二份公开资料", "online-main-policy-change", { recipientId: "a" });
  await until(() => Boolean(held));
  await service.postMessage(group.id, { content: "继续整理资料", taskId: next.task.id, mutationId: "main-restricts-network", taskAllowNetwork: true }, { source: "main", taskAllowNetwork: false });
  assert.equal(runningSignal.aborted, true);
  view = await service.getGroup(group.id); task = view.tasks.find((value) => value.id === next.task.id);
  assert.equal(task.status, "interrupted"); assert.equal(task.taskAllowNetwork, false); assert.match(task.reason, /联网限制已更新/);
  assert.equal(task.children[0].result, "已经保存的材料核对结果");
  held.resolve(); await service.idle(group.id); assert.equal(lateRejected, 2);
});

test("64个合法长ID长名称成员使用完整安全索引，名称可从详情恢复而不中断协商", async (t) => {
  let restoredName = false;
  const { service, cards, calls, create, post } = await fixture(t, { intent: async ({ options, payload, call }) => {
    assert.equal(payload.contextTruncated, true); assert.equal(options.message.length <= 14_000, true);
    assert.deepEqual(payload.members.map((member) => member.id), cards.map((member) => member.id));
    assert.equal(payload.members.every((member) => member.id.length === 80 && member.ready === true), true);
    assert.equal(payload.members.some((member) => /已截断/.test(member.name)), true);
    assert.match(payload.contextNotice, /完整 ID.*名称可能带截断标记/);
    if (!restoredName) {
      const page = parsed(await call("read_group_member_capabilities", { agentId: cards.at(-1).id }));
      assert.equal(page.nextOffset, null); assert.equal(JSON.parse(page.text).name, cards.at(-1).name); restoredName = true;
    }
    return { participate: false, contribution: "", willingToIntegrate: false, integratorId: "" };
  } });
  cards.splice(0, cards.length, ...Array.from({ length: 64 }, (_, index) => ({ ...capabilityCard(`member-${String(index).padStart(3, "0")}${"x".repeat(70)}`), name: `${"名".repeat(117)}${String(index).padStart(3, "0")}` })));
  const { group } = await create("max-members", cards.map((member) => member.id)); await post(group.id); await service.idle(group.id);
  const task = (await service.getGroup(group.id)).tasks[0];
  assert.equal(restoredName, true); assert.equal(task.status, "needs_input"); assert.equal(task.negotiationRound, 2);
  assert.equal(task.intents.length, 64); assert.equal(task.intents.some((intent) => intent.failed), false); assert.equal(calls.length, 128);
});
