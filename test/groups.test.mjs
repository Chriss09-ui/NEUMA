import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollaborationService } from "../src/collaboration/groups.mjs";
import { GroupStore } from "../src/collaboration/group-store.mjs";
import { groupTools, intentTool, groupTaskAllowsNetwork } from "../src/collaboration/group-tools.mjs";

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
const conversationIntent = (reply, replyStatus = "complete") => ({ interaction: "conversation", reply, replyStatus,
  participate: false, contribution: "", willingToIntegrate: false, integratorId: "" });
const toolsFor = (service, groupId, taskId, agentId, job = { kind: "work", childId: null, id: "manual" }) => Object.fromEntries(groupTools(service,
  { groupId, taskId, agentId, generation: 1, job, signal: new AbortController().signal, capture: () => {} }).map((tool) => [tool.name, tool]));

async function fixture(t, { run, intent, route, limits } = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-groups-")), calls = [], routeCalls = [], capabilityCalls = [], holds = [], listeners = new Set();
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
      const entry = { options, payload, tools, call };
      const context = { ...entry, service, signal, cards, hold: () => { const held = deferred(); holds.push(held); return held; } };
      if (options.role === "routing") {
        routeCalls.push(entry);
        await call("submit_group_route", route ? await route(context) : { mode: "default" });
        return { reply: "", turns: 1 };
      }
      calls.push(entry);
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
  return { root, service, agents, cards, calls, routeCalls, capabilityCalls, create, post, lifecycle };
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
  const internal = (await service.store.get(group.id)).messages.filter((value) => value.visibility === "internal"), visible = view.messages.filter((value) => value.visibility !== "internal");
  assert.ok(internal.some((value) => value.kind === "negotiation"));
  assert.equal(internal.filter((value) => value.kind === "member_result").length, 2);
  assert.equal(visible.filter((value) => value.sender.type === "agent").length, 1);
  assert.equal(visible.at(-1).kind, "delivery"); assert.equal(visible.at(-1).content, task.result);
  const events = await service.events(group.id);
  assert.equal(new Set(events.events.map((value) => value.seq)).size, events.events.length);
  assert.equal(events.latestSequence, view.lastSequence);
});

test("工作预留或结果持久化持续失败时释放群 worker，恢复后不重放旧业务", { timeout: 5000 }, async (t) => {
  for (const failureAt of ["reservation", "result"]) {
    const { service, calls, create, post } = await fixture(t), start = service.start.bind(service);
    service.start = () => {};
    const { group } = await create(`persistence-${failureAt}`, ["a"]), first = await post(group.id);
    const queued = await post(group.id, "另一段排队工作", "queued-work");
    await service.store.change(group.id, (record) => {
      const task = record.tasks[0]; task.ownerId = "a"; task.phase = "execution";
      const child = service.makeChild(task, { title: "已授权工作", assigneeId: "a" });
      service.queue(task, "a", { childId: child.id });
    });
    const storage = service.store.storage, write = storage.writeJson.bind(storage), failure = new Error("disk full");
    let armed = false, failedWrites = 0, safetyStopped = false;
    storage.writeJson = async (...args) => {
      const task = args[2].tasks.find((value) => value.id === first.task.id);
      armed ||= failureAt === "reservation" ? task.jobs[0]?.status === "running" : task.children[0]?.status === "completed";
      if (!armed) return write(...args);
      if (++failedWrites > 12) {
        safetyStopped = true; service.closed = true;
        service.workers.get(group.id)?.controller.abort();
      }
      throw failure;
    };
    service.start = start;
    try {
      service.start(group.id);
      await assert.rejects(service.idle(group.id), (error) => error === failure);
      assert.equal(safetyStopped, false, "持续写入故障必须自行退出，不能依赖测试的循环保护");
      assert.ok(failedWrites <= 5, `应有界处理持久化故障，实际写入 ${failedWrites} 次`);
      assert.equal(service.workers.has(group.id), false);
      assert.equal((await service.getGroup(group.id)).tasks.find((value) => value.id === queued.task.id).status, "queued");
    } finally { storage.writeJson = write; service.closed = false; }
    await service.cancelTask(group.id, first.task.id);
    const recovered = await post(group.id, "恢复后继续", "recovered-work", { taskId: first.task.id });
    await service.idle(group.id);
    const view = await service.getGroup(group.id);
    assert.equal(view.tasks.find((value) => value.id === queued.task.id).status, "completed");
    assert.equal(view.tasks.find((value) => value.id === recovered.task.id).status, "completed");
    assert.equal(calls.filter((value) => value.options.scope.taskId === first.task.id && value.payload.kind === "work").length,
      failureAt === "reservation" ? 0 : 1, "保存失败后不能重放结果未知的旧业务");
  }
});

test("成员工作失败或显式取消不阻断同群后续排队任务", { timeout: 5000 }, async (t) => {
  for (const outcome of ["failed", "cancelled"]) {
    const entered = deferred(), release = deferred(); t.after(() => release.resolve());
    const { service, create, post } = await fixture(t, { run: async ({ payload, call, signal }) => {
      if (payload.goal === "第一段工作" && payload.kind === "work") {
        entered.resolve(); await release.promise;
        if (outcome === "failed") throw new Error("成员调用失败");
        signal.throwIfAborted();
      }
      await call("submit_group_turn", { status: "complete", result: "实际结果" });
    } });
    const { group } = await create(`queue-${outcome}`, ["a"]), first = await post(group.id, "第一段工作");
    await entered.promise;
    const next = await post(group.id, "后续排队工作", "next-work");
    if (outcome === "cancelled") await service.cancelTask(group.id, first.task.id);
    release.resolve(); await service.idle(group.id);
    const view = await service.getGroup(group.id);
    assert.equal(view.tasks.find((value) => value.id === first.task.id).status, outcome === "cancelled" ? "cancelled" : "needs_input");
    assert.equal(view.tasks.find((value) => value.id === next.task.id).status, "completed");
    assert.equal(service.workers.has(group.id), false);
  }
});

test("普通群对话只由一位成员直接回复，不创建工作或第二轮协商", async (t) => {
  const { service, calls, create, post } = await fixture(t, { intent: async ({ options }) => ({
    ...conversationIntent(options.agentId === "a" ? "你好，我在。你想聊些什么？" : "你好，我也在。"), replyAudience: { mode: "members", memberIds: ["a", "b"] } }) });
  const { group } = await create(); await post(group.id, "你好"); await service.idle(group.id);
  const view = await service.getGroup(group.id), task = view.tasks[0];
  assert.equal(task.status, "completed"); assert.equal(task.phase, "conversation"); assert.equal(task.ownerId, "a");
  assert.equal(task.result, "你好，我在。你想聊些什么？"); assert.equal(task.negotiationRound, 1);
  assert.deepEqual(task.children, []); assert.deepEqual(task.jobs, []); assert.equal(task.turnsUsed, 0);
  assert.equal(calls.length, 2); assert.equal(calls.every((entry) => entry.options.allowBusinessTools === false), true);
  const visible = view.messages.filter((value) => value.visibility !== "internal");
  assert.deepEqual(visible.map((value) => value.sender.type), ["user", "agent"]);
  assert.equal(visible[1].sender.id, "a"); assert.equal(visible[1].kind, "reply"); assert.equal(visible[1].content, task.result);
});

test("直接问题无需执行任务，点名时由被点名成员以自身身份回答", async (t) => {
  const { service, calls, create, post } = await fixture(t, { intent: async ({ options }) => conversationIntent(`我是成员 ${options.agentId}，我可以帮你整理已分享的资料。`) });
  const { group } = await create(); await post(group.id, "你可以帮我做什么？", "direct-question", { recipientId: "b" }); await service.idle(group.id);
  const view = await service.getGroup(group.id), task = view.tasks[0], reply = view.messages.find((value) => value.visibility === "public" && value.sender.type === "agent");
  assert.equal(task.status, "completed"); assert.equal(task.ownerId, "b"); assert.equal(reply.sender.id, "b"); assert.match(reply.content, /我是成员 b/);
  assert.equal(calls.length, 1); assert.deepEqual(task.children, []); assert.deepEqual(task.jobs, []);
});

test("业务进行中或待补充时自然点名与准确艾特均由本人公开回应，不重跑业务", { timeout: 10000 }, async (t) => {
  for (const phase of ["running", "needs_input"]) for (const content of ["成员 b，你先打个招呼", "@成员 b 你先打个招呼"]) {
    const entered = deferred(), release = deferred(); t.after(() => release.resolve());
    const { service, calls, routeCalls, create, post } = await fixture(t, {
      route: async ({ payload }) => {
        assert.equal(payload.triggeringMessage.content, content);
        return { mode: "named", memberIds: ["b"] };
      },
      intent: async ({ options, payload }) => payload.kind === "update"
        ? (assert.equal(options.agentId, "b"), conversationIntent("我在，我是成员 b。"))
        : { participate: true, contribution: "整理共享资料", willingToIntegrate: true, integratorId: "a" },
      run: async ({ payload, call }) => {
        if (payload.kind === "work" && phase === "running") { entered.resolve(); await release.promise; }
        await call("submit_group_turn", payload.kind === "integration" && phase === "needs_input"
          ? { status: "needs_input", result: "已整理收到的资料。", reason: "请补充原始评分标准。" }
          : { status: "complete", result: payload.kind === "integration" ? "整理结果" : "已完成实际整理" });
      }
    });
    const { group } = await create(), initial = await post(group.id, "整理已共享资料", "initial", { recipientId: "a" });
    if (phase === "running") await entered.promise;
    else await service.idle(group.id);
    const before = (await service.getGroup(group.id)).tasks[0];
    const followup = await post(group.id, content, "followup", { taskId: initial.task.id });
    assert.equal(followup.task.id, initial.task.id);
    release.resolve(); await service.idle(group.id);
    const view = await service.getGroup(group.id), task = view.tasks[0];
    const reply = view.messages.find((value) => value.replyTo === followup.message.id && value.sender.type === "agent");
    assert.equal(reply.sender.id, "b"); assert.equal(reply.content, "我在，我是成员 b。"); assert.equal(reply.visibility, "public");
    assert.equal(calls.filter((value) => value.payload.kind === "update").length, 1);
    assert.equal(calls.find((value) => value.payload.kind === "update").options.allowBusinessTools, false);
    assert.equal(routeCalls.length, content.startsWith("@") ? 0 : 1);
    assert.equal(task.ownerId, "a"); assert.equal(task.status, phase === "needs_input" ? "needs_input" : "completed");
    assert.equal(calls.filter((value) => value.payload.kind === "integration").length, 1);
    if (phase === "needs_input") { assert.equal(task.reason, before.reason); assert.equal(task.result, before.result); }
  }
});

test("同一业务的快速连续点名逐条寻址，不用后发消息覆盖前一句", { timeout: 5000 }, async (t) => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const firstText = "成员 b，介绍一下自己", nextText = "成员 a，你也打个招呼";
  const { service, calls, create, post } = await fixture(t, {
    route: async ({ payload }) => {
      const first = payload.triggeringMessage.content === firstText;
      if (first) { entered.resolve(); await release.promise; assert.equal(payload.recentMessages.some((value) => value.content === nextText), false); }
      return { mode: "named", memberIds: [first ? "b" : "a"] };
    },
    intent: async ({ options, payload }) => payload.kind === "update" ? conversationIntent(`我在，我是成员 ${options.agentId}。`)
      : { participate: true, contribution: "整理资料", willingToIntegrate: true, integratorId: "a" },
    run: async ({ payload, call }) => call("submit_group_turn", payload.kind === "integration"
      ? { status: "needs_input", result: "保留的资料结果", reason: "还缺评分标准" } : { status: "complete", result: "已处理现有资料" })
  });
  const { group } = await create(), initial = await post(group.id, "整理资料", "start", { recipientId: "a" }); await service.idle(group.id);
  const first = await post(group.id, firstText, "followup-1", { taskId: initial.task.id }); await entered.promise;
  const next = await post(group.id, nextText, "followup-2", { taskId: initial.task.id }); release.resolve(); await service.idle(group.id);
  const view = await service.getGroup(group.id);
  assert.equal(view.messages.find((value) => value.replyTo === first.message.id && value.sender.type === "agent").sender.id, "b");
  assert.equal(view.messages.find((value) => value.replyTo === next.message.id && value.sender.type === "agent").sender.id, "a");
  const firstCall = calls.find((value) => value.payload.kind === "update" && value.payload.triggeringMessage.id === first.message.id);
  assert.equal(firstCall.payload.recentMessages.some((value) => value.content === nextText), false);
  assert.equal(view.tasks[0].status, "needs_input"); assert.equal(view.tasks[0].result, "保留的资料结果");
});

test("真实业务补充在只读判断后继续原任务，失败寻址不会中断已有结果", { timeout: 5000 }, async (t) => {
  for (const routingFails of [false, true]) {
    const { service, calls, create, post } = await fixture(t, {
      route: async () => { if (routingFails) throw new Error("模拟寻址失败"); return { mode: "default" }; },
      intent: async () => ({ participate: true, contribution: "按新增标准继续整理", willingToIntegrate: true, integratorId: "a" }),
      run: async ({ payload, call }) => call("submit_group_turn", payload.kind === "integration"
        ? { status: "needs_input", result: "保留的资料结果", reason: "需要评分标准" } : { status: "complete", result: "已接收新业务要求" })
    });
    const { group } = await create(), initial = await post(group.id, "整理资料", "original", { recipientId: "a" }); await service.idle(group.id);
    await post(group.id, "用补充的评分标准继续整理", "update", { taskId: initial.task.id }); await service.idle(group.id);
    const view = await service.getGroup(group.id), updates = calls.filter((value) => value.payload.kind === "update");
    assert.equal(view.tasks.length, 1); assert.equal(view.tasks[0].ownerId, "a"); assert.equal(view.tasks[0].status, "needs_input");
    assert.equal(view.tasks[0].result, "保留的资料结果");
    if (routingFails) { assert.equal(updates.length, 0); assert.match(view.messages.at(-1).content, /未能确定回复成员/); }
    else { assert.equal(updates.length, 2); assert.equal(updates[0].options.allowBusinessTools, false); assert.equal(updates[1].options.allowBusinessTools, true); }
  }
});

test("业务中的点名答复仍复核取消与成员版本，迟到回复不能重新发布", { timeout: 5000 }, async (t) => {
  for (const action of ["cancel", "version"]) {
    const entered = deferred(), release = deferred(); t.after(() => release.resolve());
    const { service, cards, create, post } = await fixture(t, {
      intent: async ({ payload }) => {
        if (payload.kind === "update") { entered.resolve(); await release.promise; return conversationIntent("不应出现的迟到答复"); }
        return { participate: true, contribution: "整理资料", willingToIntegrate: true, integratorId: "a" };
      }, run: async ({ payload, call }) => call("submit_group_turn", payload.kind === "integration"
        ? { status: "needs_input", result: "保留成果", reason: "需要评分标准" } : { status: "complete", result: "实际结果" })
    });
    cards[0] = capabilityCard("a"); cards[1] = capabilityCard("b");
    const { group } = await create(), initial = await post(group.id, "整理资料", "start", { recipientId: "a" }); await service.idle(group.id);
    await post(group.id, "@成员 b 介绍一下自己", "followup", { taskId: initial.task.id }); await entered.promise;
    if (action === "cancel") await service.cancelTask(group.id, initial.task.id); else cards[1].capabilityVersion = "b-new-version";
    release.resolve(); await service.idle(group.id); const view = await service.getGroup(group.id);
    assert.equal(view.messages.some((value) => value.content === "不应出现的迟到答复"), false);
    assert.equal(view.tasks[0].status, action === "cancel" ? "cancelled" : "interrupted"); assert.equal(view.tasks[0].result, "保留成果");
  }
});

test("明确邀请全员固定回复名单，完成的本人答复及时公开而不等待慢成员", async (t) => {
  let held;
  const { service, calls, routeCalls, create, post } = await fixture(t, { route: async () => ({ mode: "all" }), intent: async ({ options, hold }) => {
    if (options.agentId === "a") { held = hold(); await held.promise; }
    return { ...conversationIntent(`你好，我是成员 ${options.agentId}。`), replyAudience: options.agentId === "a"
      ? { mode: "members", memberIds: ["a", "b"] } : { mode: "single", memberIds: ["b"] } };
  } });
  const { group } = await create(); const submitted = await post(group.id, "请各位都和我打个招呼");
  await until(async () => held && (await service.store.get(group.id)).tasks[0].intents.some((intent) => intent.agentId === "b"));
  assert.deepEqual((await service.getGroup(group.id)).messages.filter((value) => value.sender.type === "agent").map((value) => value.sender.id), ["b"]);
  held.resolve(); await service.idle(group.id);
  const view = await service.getGroup(group.id), task = view.tasks[0];
  assert.equal(task.status, "completed"); assert.equal(task.phase, "conversation");
  assert.deepEqual(task.replyAudience, { mode: "members", memberIds: ["a", "b"] });
  assert.equal(task.replyRouting.mode, "all"); assert.equal(task.replyRouting.sourceMessageId, submitted.message.id); assert.equal(task.replyRouting.generation, task.generation);
  assert.deepEqual(view.messages[0].replyAudience, task.replyAudience);
  assert.deepEqual(view.messages.filter((message) => message.sender.type === "agent").map((message) => [message.sender.id, message.content]), [["b", "你好，我是成员 b。"], ["a", "你好，我是成员 a。"]]);
  assert.equal(calls.length, 2); assert.equal(calls.every((entry) => entry.options.allowBusinessTools === false), true);
  assert.equal(routeCalls.length, 1); assert.equal(routeCalls[0].options.role, "routing"); assert.equal(routeCalls[0].options.allowBusinessTools, false);
  assert.equal(routeCalls[0].tools.submit_group_intent, undefined); assert.equal(routeCalls[0].tools.send_group_message, undefined);
  assert.deepEqual(task.jobs, []); assert.deepEqual(task.children, []);
  const replay = await post(group.id, "请各位都和我打个招呼"); await service.idle(group.id);
  assert.equal(replay.message.id, submitted.message.id); assert.equal(calls.length, 2); assert.equal(routeCalls.length, 1);
  assert.equal((await service.getGroup(group.id)).messages.filter((message) => message.sender.type === "agent").length, 2);
});

test("全员回复连续填满并发空位，混合业务意向不会吞掉已完成的本人答复", { timeout: 5000 }, async (t) => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const { service, cards, calls, create, post } = await fixture(t, { route: async () => ({ mode: "all" }), intent: async ({ options }) => {
    if (options.agentId === "a") { entered.resolve(); await release.promise; return { participate: true, contribution: "处理真实资料", willingToIntegrate: true, integratorId: "a" }; }
    return conversationIntent(`我在，我是成员 ${options.agentId}。`);
  } });
  cards.push(card("c")); const { group } = await create("mixed-explicit", ["a", "b", "c"]);
  await post(group.id, "各位打招呼，成员 a 继续处理资料"); await entered.promise;
  await until(async () => (await service.getGroup(group.id)).messages.some((value) => value.sender.id === "c"));
  const pending = await service.getGroup(group.id);
  assert.deepEqual(pending.messages.filter((value) => value.sender.type === "agent").map((value) => value.sender.id), ["b", "c"]);
  release.resolve(); await service.idle(group.id); const view = await service.getGroup(group.id);
  assert.deepEqual(view.tasks[0].children.map((value) => value.assigneeId), ["a"]);
  assert.deepEqual(view.messages.filter((value) => value.sender.type === "agent").map((value) => value.sender.id), ["b", "c", "a"]);
  assert.equal(calls.filter((value) => value.options.allowBusinessTools).every((value) => value.options.agentId === "a"), true);
});

test("其他成员的语义判断使用公开历史，目标本人发言且不会继续触发全员循环", async (t) => {
  const { service, calls, routeCalls, cards, create, post } = await fixture(t, { route: async ({ payload }) => {
    if (payload.triggeringMessage.content === "你好") return { mode: "default" };
    assert.equal(payload.recentMessages.filter((message) => message.sender.type === "agent").at(-1).sender.id, "a");
    return { mode: "others" };
  }, intent: async ({ payload, options }) => {
    if (payload.triggeringMessage.content === "你好") return conversationIntent(`你好，我是成员 ${options.agentId}。`);
    const previous = payload.recentMessages.filter((message) => message.sender.type === "agent").at(-1);
    assert.equal(previous.sender.id, "a"); assert.equal(previous.content, "你好，我是成员 a。");
    assert.equal(payload.triggeringMessage.content, "其他两位也各自介绍一下吧");
    return { ...conversationIntent(`我叫成员 ${options.agentId}，我在这里。`), replyAudience: { mode: "members", memberIds: ["b", "c"] } };
  } });
  cards.push(card("c"));
  const { group } = await create("other-members-group", ["a", "b", "c"]), initial = await post(group.id, "你好", "other-first"); await service.idle(group.id);
  const next = await post(group.id, "其他两位也各自介绍一下吧", "other-second", { taskId: initial.task.id }); await service.idle(group.id);
  const view = await service.getGroup(group.id), task = view.tasks.find((value) => value.id === next.task.id);
  assert.deepEqual(task.replyAudience, { mode: "members", memberIds: ["b", "c"] });
  assert.equal(task.replyRouting.mode, "others"); assert.equal(task.replyRouting.sourceMessageId, next.message.id); assert.equal(routeCalls.length, 2);
  assert.deepEqual(view.messages.filter((message) => message.taskId === next.task.id && message.sender.type === "agent").map((message) => message.sender.id), ["b", "c"]);
  assert.equal(calls.length, 5); assert.deepEqual(task.jobs, []); assert.equal(task.turnsUsed, 0);
});

test("明确指定多位成员优先于模型扩张的回复对象", async (t) => {
  const { service, calls, routeCalls, cards, create, post } = await fixture(t, { route: async () => { assert.fail("明确@无需再询问模型路由"); }, intent: async ({ options, payload }) => {
    assert.deepEqual(payload.requestedRecipientIds, ["a", "b"]);
    return { ...conversationIntent(`我是成员 ${options.agentId}，我来回答。`), replyAudience: { mode: "members", memberIds: ["a", "b", "c"] } };
  } });
  cards.push(card("c"));
  const { group } = await create("selected-members-group", ["a", "b", "c"]);
  await post(group.id, "@成员 a @成员 b 你们分别说说能做什么", "selected-members"); await service.idle(group.id);
  const view = await service.getGroup(group.id), task = view.tasks[0];
  assert.deepEqual(task.replyAudience, { mode: "members", memberIds: ["a", "b"] });
  assert.deepEqual(calls.map((entry) => entry.options.agentId), ["a", "b"]);
  assert.equal(routeCalls.length, 0);
  assert.deepEqual(view.messages.filter((message) => message.sender.type === "agent").map((message) => message.sender.id), ["a", "b"]);
});

test("明确多位回复的部分目标失败仍展示成功答复，但不能伪装全员完成", async (t) => {
  const { service, calls, create, post } = await fixture(t, { route: async () => ({ mode: "all" }), intent: async ({ options }) => {
    if (options.agentId === "b") throw new Error("模型连接暂时失败");
    return { ...conversationIntent("你好，我是成员 a。"), replyAudience: { mode: "members", memberIds: ["a", "b"] } };
  } });
  const { group } = await create(); await post(group.id, "你们都各自打个招呼"); await service.idle(group.id);
  const view = await service.getGroup(group.id), task = view.tasks[0];
  assert.equal(task.status, "partial"); assert.equal(task.phase, "conversation"); assert.equal(task.result, "你好，我是成员 a。");
  assert.deepEqual(view.messages.filter((message) => message.sender.type === "agent").map((message) => message.sender.id), ["a"]);
  assert.match(view.messages.at(-1).content, /成员 b 暂时未能回复/); assert.equal(calls.length, 2);
});

test("独立全员路由包括每位成员自身，成员旧audience漏掉自己也不会少回复", async (t) => {
  const { service, cards, calls, create, post } = await fixture(t, { route: async () => ({ mode: "all" }), intent: async ({ options }) => ({
    ...conversationIntent(`我在，我是 ${options.agentId}。`), replyAudience: { mode: "members", memberIds: ["a", "b", "c"].filter((id) => id !== options.agentId) } }) });
  cards.push(card("c")); const { group } = await create("all-self-group", ["a", "b", "c"]);
  await post(group.id, "所有成员都分别和我打招呼"); await service.idle(group.id);
  const view = await service.getGroup(group.id);
  assert.deepEqual(view.messages.filter((message) => message.sender.type === "agent").map((message) => message.sender.id), ["a", "b", "c"]);
  assert.deepEqual(view.tasks[0].replyAudience.memberIds, ["a", "b", "c"]); assert.equal(view.tasks[0].status, "completed");
  assert.equal(calls.length, 3); assert.equal(calls.every((entry) => entry.options.allowBusinessTools === false), true);
});

test("其他人路由排除紧邻上一用户轮的全部公开回复成员，不只排除最后一条", async (t) => {
  const { service, cards, create, post } = await fixture(t, { route: async ({ payload }) => payload.triggeringMessage.content === "先听两位介绍"
    ? { mode: "named", memberIds: ["a", "b"] } : { mode: "others" }, intent: async ({ options }) => conversationIntent(`我叫 ${options.agentId}。`) });
  cards.push(card("c")); const { group } = await create("other-batch-group", ["a", "b", "c"]);
  const first = await post(group.id, "先听两位介绍", "other-batch-first"); await service.idle(group.id);
  const second = await post(group.id, "剩下那位也说说吧", "other-batch-second", { taskId: first.task.id }); await service.idle(group.id);
  const view = await service.getGroup(group.id), task = view.tasks.find((value) => value.id === second.task.id);
  assert.deepEqual(task.replyAudience.memberIds, ["c"]);
  assert.deepEqual(view.messages.filter((message) => message.taskId === second.task.id && message.sender.type === "agent").map((message) => message.sender.id), ["c"]);
});

test("上一轮回复尚未发布就连续问其他人，待前轮完成后仍只路由给剩余成员", async (t) => {
  let held;
  const { service, cards, calls, routeCalls, create, post } = await fixture(t, { route: async ({ payload }) => {
    if (payload.triggeringMessage.content === "先打个招呼") return { mode: "default" };
    assert.equal(payload.triggeringMessage.content, "其他人也各自打个招呼吧");
    assert.ok(payload.recentMessages.some((message) => message.sender.id === "a" && message.content === "我是 a，我在。"));
    return { mode: "others" };
  }, intent: async ({ payload, options, hold }) => {
    if (payload.triggeringMessage.content === "先打个招呼" && options.agentId === "a") { held = hold(); await held.promise; }
    return conversationIntent(`我是 ${options.agentId}，我在。`);
  } });
  cards.push(card("c")); const { group } = await create("fast-other-group", ["a", "b", "c"]);
  const first = await post(group.id, "先打个招呼", "fast-other-first"); await until(() => Boolean(held));
  const next = await post(group.id, "其他人也各自打个招呼吧", "fast-other-second", { taskId: first.task.id });
  assert.notEqual(next.task.id, first.task.id); assert.equal(next.task.conversationId, first.task.conversationId);
  held.resolve(); await service.idle(group.id);
  const view = await service.getGroup(group.id), firstReply = view.messages.find((message) => message.taskId === first.task.id && message.sender.type === "agent");
  const task = view.tasks.find((value) => value.id === next.task.id);
  assert.ok(next.message.seq < firstReply.seq, "补充在前轮公开答复之前真实入列");
  assert.equal(task.replyRouting.sourceMessageId, next.message.id); assert.deepEqual(task.replyAudience.memberIds, ["b", "c"]);
  assert.deepEqual(view.messages.filter((message) => message.taskId === next.task.id && message.sender.type === "agent").map((message) => message.sender.id), ["b", "c"]);
  assert.equal(routeCalls.length, 2); assert.equal(calls.length, 5);
});

test("自然点名的明显错字由独立语义路由绑定真实成员，其他成员不能代答", async (t) => {
  const { service, cards, routeCalls, create, post } = await fixture(t, { route: async ({ payload, options }) => {
    assert.equal(payload.triggeringMessage.content, "验收检察员，你还在吗？");
    assert.ok(payload.members.some((member) => member.id === "c" && member.name === "验收检查员"));
    assert.equal(options.role, "routing"); assert.equal(options.allowBusinessTools, false);
    return { mode: "named", memberIds: ["c"] };
  }, intent: async ({ options }) => ({ ...conversationIntent(options.agentId === "c" ? "我在，我是验收检查员。" : "我替他回答。"), replyAudience: { mode: "single", memberIds: ["a"] } }) });
  cards.push({ ...card("c"), name: "验收检查员" }); const { group } = await create("natural-name-group", ["a", "b", "c"]);
  const submitted = await post(group.id, "验收检察员，你还在吗？"); await service.idle(group.id);
  const view = await service.getGroup(group.id), task = view.tasks[0];
  assert.deepEqual(task.replyRouting, { mode: "named", memberIds: ["c"], sourceMessageId: submitted.message.id, generation: task.generation });
  assert.deepEqual(view.messages.filter((message) => message.sender.type === "agent").map((message) => [message.sender.id, message.content]), [["c", "我在，我是验收检查员。"]]);
  assert.equal(routeCalls.length, 1);
});

test("语义点名只调用目标，非目标的拒领或业务认领不能否决普通答复", async (t) => {
  for (const participate of [false, true]) {
    const { service, calls, create, post } = await fixture(t, { route: async () => ({ mode: "named", memberIds: ["b"] }), intent: async ({ options }) => options.agentId === "a"
      ? { interaction: "task", participate, contribution: participate ? "我准备执行业务任务。" : "我没有这项能力。", willingToIntegrate: participate, integratorId: participate ? "a" : "" }
      : conversationIntent("我在，我是你点名的成员 b。") });
    const { group } = await create(); await post(group.id, "我想听第二位说话"); await service.idle(group.id);
    const view = await service.getGroup(group.id), task = view.tasks[0];
    assert.equal(task.status, "completed"); assert.equal(task.phase, "conversation");
    assert.deepEqual(calls.map((entry) => entry.options.agentId), ["b"]); assert.deepEqual(task.jobs, []); assert.deepEqual(task.children, []);
    assert.deepEqual(view.messages.filter((message) => message.sender.type === "agent").map((message) => message.sender.id), ["b"]);
  }
});

test("被自然点名成员调用失败时显示真实失败提示，不由别人代答或编造成离线", async (t) => {
  const { service, cards, create, post } = await fixture(t, { route: async () => ({ mode: "named", memberIds: ["c"] }), intent: async ({ options }) => {
    if (options.agentId === "c") throw new Error("模拟模型调用失败");
    return conversationIntent("我可以替他说一声你好。");
  } });
  cards.push({ ...card("c"), name: "验收检查员" }); const { group } = await create("named-failure-group", ["a", "b", "c"]);
  await post(group.id, "验收检察员，回个话吧"); await service.idle(group.id);
  const view = await service.getGroup(group.id), task = view.tasks[0];
  assert.ok(["needs_input", "failed"].includes(task.status)); assert.equal(task.result, "");
  assert.equal(view.messages.some((message) => message.sender.type === "agent"), false);
  const status = view.messages.filter((message) => message.sender.type === "system").at(-1);
  assert.match(status.content, /验收检查员/); assert.match(status.content, /失败|未能|暂时/); assert.doesNotMatch(status.content, /离线|未上线|不在群里|未就绪/);
});

test("独立路由不确定时只追问，补充后重新绑定最新原话再定向本人回复", async (t) => {
  const { service, calls, routeCalls, create, post } = await fixture(t, { route: async ({ payload }) => payload.triggeringMessage.content === "那位帮我介绍一下"
    ? { mode: "clarify", question: "你想听哪一位成员介绍？" } : { mode: "named", memberIds: ["b"] }, intent: async ({ options }) => conversationIntent(`我是成员 ${options.agentId}。`) });
  const { group } = await create(), initial = await post(group.id, "那位帮我介绍一下"); await service.idle(group.id);
  let view = await service.getGroup(group.id), task = view.tasks[0];
  assert.equal(task.status, "needs_input"); assert.equal(calls.length, 0); assert.equal(view.messages.at(-1).content, "你想听哪一位成员介绍？");
  assert.equal(task.replyRouting.mode, "clarify"); assert.equal(task.replyRouting.sourceMessageId, initial.message.id);
  const next = await post(group.id, "我是说第二位", "route-clarify-answer", { taskId: initial.task.id }); await service.idle(group.id);
  view = await service.getGroup(group.id); task = view.tasks.find((value) => value.id === next.task.id);
  assert.equal(task.status, "completed"); assert.equal(task.replyRouting.sourceMessageId, next.message.id); assert.equal(routeCalls.length, 2);
  assert.deepEqual(view.messages.filter((message) => message.sender.type === "agent").map((message) => message.sender.id), ["b"]);
});

test("独立路由等待期间取消或能力变化阻止迟到路由和所有成员调用", async (t) => {
  for (const action of ["cancel", "revision"]) {
    let held;
    const { service, calls, cards, create, post } = await fixture(t, { route: async ({ hold }) => { held = hold(); await held.promise; return { mode: "all" }; },
      intent: async () => conversationIntent("迟到的问候") });
    cards[0] = capabilityCard("a"); cards[1] = capabilityCard("b");
    const { group } = await create(), submitted = await post(group.id, "各位和我打个招呼"); await until(() => Boolean(held));
    if (action === "cancel") await service.cancelTask(group.id, submitted.task.id);
    else cards[0].capabilityVersion = "a-route-new-version";
    held.resolve(); await service.idle(group.id);
    const view = await service.getGroup(group.id), task = view.tasks[0];
    assert.equal(task.status, action === "cancel" ? "cancelled" : "interrupted"); assert.equal(calls.length, 0);
    assert.equal(view.messages.some((message) => message.sender.type === "agent"), false);
  }
});

test("独立路由调用失败不能静默改成默认成员代答", async (t) => {
  const { service, calls, create, post } = await fixture(t, { route: async () => { throw new Error("模拟路由连接失败"); },
    intent: async () => conversationIntent("不应发布的代答") });
  const { group } = await create(); await post(group.id, "那位能回应一下吗"); await service.idle(group.id);
  const view = await service.getGroup(group.id);
  assert.ok(["needs_input", "failed", "interrupted"].includes(view.tasks[0].status)); assert.equal(calls.length, 0);
  assert.equal(view.messages.some((message) => message.sender.type === "agent"), false);
  assert.equal(view.messages.some((message) => message.sender.type === "system"), true);
});

test("明确点名的全部目标调用失败不能以其他成员回复完成", async (t) => {
  const { service, routeCalls, create, post } = await fixture(t, { intent: async () => { throw new Error("本次调用失败"); } });
  const { group } = await create(); await post(group.id, "@成员 a @成员 b 请你们各自回答"); await service.idle(group.id);
  const view = await service.getGroup(group.id);
  assert.ok(["needs_input", "failed"].includes(view.tasks[0].status)); assert.equal(view.tasks[0].result, "");
  assert.equal(view.messages.some((message) => message.sender.type === "agent"), false); assert.equal(routeCalls.length, 0);
});

test("多人直接答复保留各自追问状态，补充时读取最新触发原话", async (t) => {
  const { service, create, post } = await fixture(t, { route: async () => ({ mode: "all" }), intent: async ({ options, payload }) => ({
    ...conversationIntent(payload.triggeringMessage.content === "按100字即可" ? `我会按100字来回答，成员 ${options.agentId}。`
      : options.agentId === "a" ? "我可以整理资料。" : "你希望摘要多长？", payload.triggeringMessage.content !== "按100字即可" && options.agentId === "b" ? "needs_input" : "complete"),
    replyAudience: { mode: "members", memberIds: ["a", "b"] } }) });
  const { group } = await create(), initial = await post(group.id, "各位介绍一下需要哪些输入"); await service.idle(group.id);
  let view = await service.getGroup(group.id), task = view.tasks[0];
  assert.equal(task.status, "needs_input"); assert.equal(task.reason, "你希望摘要多长？");
  assert.deepEqual(view.messages.filter((message) => message.sender.type === "agent").map((message) => message.kind), ["reply", "clarification"]);
  await post(group.id, "按100字即可", "multi-input-followup", { taskId: initial.task.id }); await service.idle(group.id);
  view = await service.getGroup(group.id); task = view.tasks[0];
  assert.equal(task.status, "completed"); assert.equal(task.reason, "");
  assert.deepEqual(view.messages.filter((message) => message.content.startsWith("我会按100字")).map((message) => message.sender.id), ["a", "b"]);
});

test("意向中的群外回复对象和引用自身被拒绝，不会伪造收件人或唤醒成员", async (t) => {
  for (const fields of [{ replyAudience: { mode: "members", memberIds: ["outside"] } }, { replyRecipientId: "a" }]) {
    const { service, calls, create, post } = await fixture(t, { intent: async ({ options }) => ({ ...conversationIntent(`我是成员 ${options.agentId}。`),
      ...(options.agentId === "a" ? fields : {}) }) });
    const { group } = await create(); await post(group.id, "你好"); await service.idle(group.id);
    const view = await service.getGroup(group.id), reply = view.messages.find((message) => message.sender.type === "agent");
    assert.equal(reply.sender.id, "b"); assert.equal(reply.recipientId, null); assert.deepEqual(view.tasks[0].jobs, []);
    assert.equal(calls.length, 2);
  }
});

test("直接回复引用成员产生结构化展示对象，正文的艾特不会排队或代叫其他成员", async (t) => {
  const { service, calls, create, post } = await fixture(t, { intent: async ({ options }) => ({ ...conversationIntent(options.agentId === "a" ? "@成员 b 我同意刚才的判断。" : "我也同意。"),
    ...(options.agentId === "a" ? { replyRecipientId: "b" } : {}) }) });
  const { group } = await create(); await post(group.id, "回应一下刚才的判断"); await service.idle(group.id);
  const view = await service.getGroup(group.id), task = view.tasks[0], reply = view.messages.find((message) => message.sender.type === "agent");
  assert.equal(reply.recipientId, "b"); assert.equal(reply.content, "@成员 b 我同意刚才的判断。");
  assert.deepEqual(task.jobs, []); assert.equal(calls.length, 2);
});

test("连续三轮公开问答共用会话，旧执行终态不重开且旧窗口选择与重试幂等", async (t) => {
  const { service, calls, create, post } = await fixture(t, { intent: async ({ payload }) => {
    if (payload.goal === "我叫小林") return conversationIntent("你好小林，我记住你在这段对话中的称呼了。");
    if (payload.goal === "我刚才说叫什么？") {
      assert.ok(payload.recentMessages.some((message) => message.sender.type === "agent" && message.content === "你好小林，我记住你在这段对话中的称呼了。"));
      return conversationIntent("你刚才说你叫小林。");
    }
    if (payload.goal === "接着上一句再说一遍") {
      assert.ok(payload.recentMessages.some((message) => message.sender.type === "agent" && message.content === "你刚才说你叫小林。"));
      return conversationIntent("我再说一遍：你叫小林。");
    }
    assert.equal(payload.recentMessages.length, 1, "加号开启的另一段会话只含本轮消息");
    return conversationIntent("我在这段新对话里还不知道你的称呼。");
  } });
  const { group } = await create("continuous-group", ["a"]), first = await post(group.id, "我叫小林", "continuous-first"); await service.idle(group.id);
  const firstSnapshot = structuredClone((await service.getGroup(group.id)).tasks[0]);
  await service.store.change(group.id, (record) => { delete record.tasks[0].conversationId; });
  const secondInput = { content: "我刚才说叫什么？", taskId: first.task.id, mutationId: "continuous-second" };
  const second = await service.postMessage(group.id, secondInput); await service.idle(group.id);
  const replay = await service.postMessage(group.id, secondInput);
  assert.equal(replay.message.id, second.message.id); assert.equal(replay.task.id, second.task.id);
  const third = await service.postMessage(group.id, { content: "接着上一句再说一遍", taskId: first.task.id, mutationId: "continuous-third" }); await service.idle(group.id);
  const view = await service.getGroup(group.id), [oldTask, secondTask, thirdTask] = view.tasks;
  assert.equal(view.tasks.length, 3); assert.notEqual(first.task.id, second.task.id); assert.notEqual(second.task.id, third.task.id);
  assert.equal(secondTask.conversationId, first.task.id); assert.equal(thirdTask.conversationId, first.task.id);
  const { conversationId, ...expectedOld } = firstSnapshot;
  assert.deepEqual(oldTask, expectedOld, "旧数据缺省会话 ID 继续可读且原终态记录不改写");
  assert.equal(thirdTask.result, "我再说一遍：你叫小林。"); assert.equal(calls.length, 3);
  const fresh = await service.postMessage(group.id, { content: "这段知道我是谁吗？", taskId: first.task.id, newTask: true, mutationId: "continuous-plus" }); await service.idle(group.id);
  assert.equal(fresh.task.conversationId, fresh.task.id); assert.notEqual(fresh.task.conversationId, secondTask.conversationId);
  const next = (await service.getGroup(group.id)).tasks.at(-1);
  assert.equal(next.result, "我在这段新对话里还不知道你的称呼。");
});

test("认领判断期间连续快速发送每句都成为同会话后续轮，上下文不混入排队后的消息", async (t) => {
  let held;
  const { service, calls, create, post } = await fixture(t, { intent: async ({ payload, hold }) => {
    if (payload.goal === "第一句") { held = hold(); await held.promise; }
    const contents = payload.recentMessages.map((message) => message.content);
    if (payload.goal === "第一句") assert.deepEqual(contents, ["第一句"]);
    if (payload.goal === "第二句") { assert.ok(contents.includes("第一句的答复")); assert.equal(contents.includes("第三句"), false); }
    if (payload.goal === "第三句") assert.ok(contents.includes("第二句的答复"));
    return conversationIntent(`${payload.goal}的答复`);
  } });
  const { group } = await create("fast-turns-group", ["a"]), first = await post(group.id, "第一句", "fast-first"); await until(() => Boolean(held));
  const second = await service.postMessage(group.id, { content: "第二句", taskId: first.task.id, mutationId: "fast-second" });
  const third = await service.postMessage(group.id, { content: "第三句", taskId: first.task.id, mutationId: "fast-third" });
  assert.equal(second.task.conversationId, first.task.id); assert.equal(third.task.conversationId, first.task.id);
  held.resolve(); await service.idle(group.id);
  const view = await service.getGroup(group.id);
  assert.deepEqual(view.tasks.map((task) => task.status), ["completed", "completed", "completed"]);
  assert.deepEqual(view.messages.filter((message) => message.sender.type === "agent").map((message) => message.content), ["第一句的答复", "第二句的答复", "第三句的答复"]);
  assert.equal(calls.length, 3); assert.equal(view.tasks.every((task) => task.generation === 1), true);
});

test("整合正在执行时的新消息保留为同会话下一轮，旧最终提交不能取消用户后续问题", async (t) => {
  let held;
  const { service, calls, create, post } = await fixture(t, {
    intent: async ({ payload, options }) => {
      if (payload.goal === "再把刚才的结果解释一下") {
        assert.ok(payload.recentMessages.some((message) => message.sender.type === "agent" && message.content === "我已为你核对第一份材料。"));
        return conversationIntent("我接着解释：第一份材料已经核对，结论沿用刚才交付的内容。");
      }
      return { participate: true, contribution: "核对第一份材料", willingToIntegrate: options.agentId === "a", integratorId: "a" };
    },
    run: async ({ payload, call, hold }) => {
      if (payload.kind === "integration") { held = hold(); await held.promise; }
      await call("submit_group_turn", { status: "complete", result: payload.kind === "integration" ? "我已为你核对第一份材料。" : "第一份材料的实际核对结果" });
    },
  });
  const { group } = await create("during-delivery-group", ["a"]), first = await post(group.id, "核对第一份材料", "during-delivery-first");
  await until(() => Boolean(held));
  const next = await service.postMessage(group.id, { content: "再把刚才的结果解释一下", taskId: first.task.id, mutationId: "during-delivery-followup" });
  assert.notEqual(next.task.id, first.task.id); assert.equal(next.task.conversationId, first.task.id); assert.equal(next.task.status, "queued");
  const executing = (await service.getGroup(group.id)).tasks[0]; assert.equal(executing.generation, 1); assert.equal(executing.status, "running");
  assert.equal(executing.jobs.some((job) => job.kind === "update"), false);
  held.resolve(); await service.idle(group.id);
  const view = await service.getGroup(group.id), [previous, continued] = view.tasks;
  assert.equal(previous.status, "completed"); assert.equal(previous.result, "我已为你核对第一份材料。"); assert.equal(previous.generation, 1);
  assert.equal(continued.status, "completed"); assert.equal(continued.phase, "conversation");
  assert.equal(continued.result, "我接着解释：第一份材料已经核对，结论沿用刚才交付的内容。");
  assert.deepEqual(view.messages.filter((message) => message.sender.type === "agent").map((message) => message.content), [previous.result, continued.result]);
  assert.equal(view.messages.filter((message) => message.content === "再把刚才的结果解释一下").length, 1);
  assert.equal(calls.filter((call) => call.payload.goal === "再把刚才的结果解释一下").length, 1);
});

test("整合已被调度但尚未原子启动时，新补充优先处理，旧调度不能越过更新队列", async (t) => {
  const selected = deferred(), release = deferred(); t.after(() => release.resolve());
  const { service, calls, create, post } = await fixture(t, { run: async ({ payload, call }) => {
    if (payload.kind === "integration") {
      assert.ok(payload.recentMessages.some((message) => message.content === "补充：结果需要再解释一句"));
      assert.ok(payload.recentMessages.some((message) => message.content === "我已读取你的新补充。"));
    }
    await call("submit_group_turn", { status: "complete", result: payload.kind === "integration" ? "我把核对结果和你的补充一并解释了。"
      : payload.kind === "update" ? "我已读取你的新补充。" : "原材料已经核对。" });
  } });
  const { group } = await create("integration-start-race", ["a"]), validate = service.validateTaskCapabilities.bind(service); let paused = false;
  service.validateTaskCapabilities = async (...args) => {
    const task = (await service.store.get(group.id)).tasks.find((task) => task.id === args[1]);
    if (!paused && task?.phase === "integration" && task.jobs.some((job) => job.kind === "integration" && job.status === "queued")) {
      paused = true; selected.resolve(); await release.promise;
    }
    return validate(...args);
  };
  const first = await post(group.id, "核对材料", "integration-race-first"); await selected.promise;
  const update = await service.postMessage(group.id, { content: "补充：结果需要再解释一句", taskId: first.task.id, mutationId: "integration-race-update" });
  assert.equal(update.task.id, first.task.id); assert.ok(update.task.jobs.some((job) => job.kind === "update" && job.status === "queued"));
  release.resolve(); await service.idle(group.id);
  const view = await service.getGroup(group.id), task = view.tasks[0];
  assert.equal(view.tasks.length, 1); assert.equal(task.status, "completed"); assert.equal(task.generation, 1);
  assert.equal(task.result, "我把核对结果和你的补充一并解释了。");
  assert.deepEqual(calls.filter((call) => !call.tools.submit_group_intent).map((call) => call.payload.kind), ["work", "update", "integration"]);
  assert.equal(task.jobs.find((job) => job.kind === "update").status, "completed");
});

test("没有整合者的待补充任务可直接承接下一句重新判断，不强制点名", async (t) => {
  const { service, calls, create, post } = await fixture(t, { intent: async ({ payload }) => payload.recentMessages.some((message) => message.content === "不要联网，先不用做文件，我只想问你能做什么")
    ? conversationIntent("我可以帮你整理明确分享的资料。") : { participate: false, contribution: "", willingToIntegrate: false, integratorId: "" } });
  const { group } = await create("no-owner-continue", ["a"]), first = await post(group.id); await service.idle(group.id);
  assert.equal((await service.getGroup(group.id)).tasks[0].status, "needs_input");
  const next = await service.postMessage(group.id, { content: "不要联网，先不用做文件，我只想问你能做什么", taskId: first.task.id, mutationId: "no-owner-followup" }); await service.idle(group.id);
  assert.equal(next.task.id, first.task.id); const task = (await service.getGroup(group.id)).tasks[0];
  assert.equal(task.status, "completed"); assert.equal(task.phase, "conversation"); assert.equal(task.result, "我可以帮你整理明确分享的资料。");
  assert.equal(calls.at(-1).options.taskAllowNetwork, false);
});

test("完成后的续聊承接共享选材及可信禁网，另一段会话保持独立", async (t) => {
  const { service, calls, create } = await fixture(t, { intent: async () => conversationIntent("我会遵守本次对话的材料与联网范围。") });
  const { group } = await create("continuity-policy", ["a"]);
  await service.store.change(group.id, (record) => { record.group.materialIds.push("shared-one", "shared-two"); });
  const first = await service.postMessage(group.id, { content: "请在已分享材料中回答", attachmentIds: [{ id: "shared-one" }, { id: "shared-two" }], mutationId: "policy-first" }, { source: "main", taskAllowNetwork: false }); await service.idle(group.id);
  await service.store.change(group.id, (record) => { record.group.materialIds = ["shared-two"]; });
  const second = await service.postMessage(group.id, { content: "继续回答，允许联网", taskId: first.task.id, mutationId: "policy-second" }, { source: "main", taskAllowNetwork: true }); await service.idle(group.id);
  assert.deepEqual(second.task.attachmentIds, ["shared-two"]); assert.equal(second.task.taskAllowNetwork, false);
  assert.equal(calls.filter((call) => call.payload.conversationId === first.task.id).every((call) => call.options.taskAllowNetwork === false), true);
  const fresh = await service.postMessage(group.id, { content: "另一个话题", taskId: second.task.id, newTask: true, mutationId: "policy-fresh" }); await service.idle(group.id);
  assert.deepEqual(fresh.task.attachmentIds, []); assert.equal(calls.at(-1).options.taskAllowNetwork, true);
  const forbidden = await service.postMessage(group.id, { content: "不要联网，只讨论我发的内容", taskId: fresh.task.id, mutationId: "policy-user-forbids" }); await service.idle(group.id);
  const after = await service.postMessage(group.id, { content: "那接着说", taskId: forbidden.task.id, mutationId: "policy-after-forbid" }); await service.idle(group.id);
  assert.equal(after.task.taskAllowNetwork, false); assert.equal(calls.at(-1).options.taskAllowNetwork, false);
});

test("前轮分类期间收紧联网权限中断旧轮，后续队列按新约束继续且不丢新话", async (t) => {
  let held, initialSignal;
  const { service, calls, create, post } = await fixture(t, { intent: async ({ payload, hold, signal }) => {
    if (payload.goal === "先看看公开信息") { held = hold(); initialSignal = signal; await held.promise; }
    return conversationIntent("我会只依据你已分享的信息来回答。");
  } });
  const { group } = await create("restrict-queued-next", ["a"]), first = await post(group.id, "先看看公开信息", "restrict-queued-first"); await until(() => Boolean(held));
  const next = await service.postMessage(group.id, { content: "不要联网，先聊聊", taskId: first.task.id, mutationId: "restrict-queued-next" });
  assert.notEqual(next.task.id, first.task.id); assert.equal(next.task.conversationId, first.task.id); assert.equal(initialSignal.aborted, true);
  held.resolve(); await service.idle(group.id);
  const view = await service.getGroup(group.id); assert.equal(view.tasks[0].status, "interrupted"); assert.equal(view.tasks[1].status, "completed");
  assert.equal(view.messages.some((message) => message.taskId === first.task.id && message.kind === "reply"), false);
  assert.equal(view.messages.filter((message) => message.content === "不要联网，先聊聊").length, 1);
  assert.equal(calls.at(-1).options.taskAllowNetwork, false);
});

test("续聊工具只读取本会话既往公开问答和本轮协作，旧终态工具仍拒绝写入", async (t) => {
  const { service, create, post } = await fixture(t); service.start = () => {};
  const { group } = await create("scoped-read", ["a"]), first = await post(group.id, "第一段原话", "scoped-first");
  await service.store.change(group.id, (record) => {
    record.tasks[0].status = "completed"; record.tasks[0].result = "第一段答复";
    record.messages.push({ id: "first-reply", taskId: first.task.id, sender: { type: "agent", id: "a", name: "a" }, content: "第一段答复", visibility: "public", seq: ++record.group.lastSequence });
    record.messages.push({ id: "first-private", taskId: first.task.id, sender: { type: "agent", id: "a", name: "a" }, content: "上一轮后台讨论", visibility: "internal", seq: ++record.group.lastSequence });
  });
  await post(group.id, "无关另一个会话", "scoped-other");
  const second = await service.postMessage(group.id, { content: "第二段原话", taskId: first.task.id, mutationId: "scoped-second" });
  const third = await service.postMessage(group.id, { content: "排队后第三段", taskId: second.task.id, mutationId: "scoped-third" });
  const tools = toolsFor(service, group.id, second.task.id, "a"), history = parsed(await tools.read_group_messages.execute("read-scoped", {}));
  assert.deepEqual(history.messages.map((message) => message.content), ["第一段原话", "第一段答复", "第二段原话"]);
  assert.equal(history.more, false); assert.notEqual(third.task.id, second.task.id);
  await assert.rejects(toolsFor(service, group.id, first.task.id, "a").send_group_message.execute("late-terminal-write", { content: "旧终态迟到内容" }), /本轮协作已停止/);
});

test("旧窗口的任务 ID 在同一会话最新执行等待输入时仍向真实执行补充，不重新派工作", async (t) => {
  const { service, create, post } = await fixture(t); service.start = () => {};
  const { group } = await create("stale-execution-window", ["a"]), first = await post(group.id, "第一轮", "stale-first");
  await service.store.change(group.id, (record) => { record.tasks[0].status = "completed"; record.tasks[0].result = "第一轮已完成"; });
  const second = await service.postMessage(group.id, { content: "第二轮工作", taskId: first.task.id, mutationId: "stale-second" });
  await service.store.change(group.id, (record) => { const task = record.tasks[1]; task.status = "needs_input"; task.phase = "execution"; task.ownerId = "a"; });
  const update = await service.postMessage(group.id, { content: "补充第二轮资料", taskId: first.task.id, mutationId: "stale-update" });
  assert.equal(update.task.id, second.task.id); assert.equal(update.task.status, "queued"); assert.equal(update.task.jobs.length, 1);
  assert.equal(update.task.jobs[0].kind, "update"); assert.equal(update.task.jobs[0].messageId, update.message.id);
  const view = await service.getGroup(group.id); assert.equal(view.tasks.length, 2); assert.equal(view.tasks[0].status, "completed"); assert.equal(view.tasks[0].result, "第一轮已完成");
});

test("独立当前任务尚未加入记录时仍保留其可信策略、原话及发送者权限边界", () => {
  const record = { tasks: [], messages: [] };
  assert.equal(groupTaskAllowsNetwork(record, { id: "new", goal: "查询公开资料", taskAllowNetwork: false }), false);
  assert.equal(groupTaskAllowsNetwork(record, { id: "new", goal: "不要联网，读我提供的内容" }), false);
  assert.equal(groupTaskAllowsNetwork(record, { id: "new", goal: "查询公开资料" }), true);
});

test("完成、部分交付、失败、停止和中断后可以续聊，旧终态与迟到工具写入门槛不变", async (t) => {
  const { service, create, post } = await fixture(t); service.start = () => {};
  const { group } = await create("all-terminal-continuity", ["a"]);
  for (const status of ["completed", "partial", "failed", "cancelled", "interrupted"]) {
    const first = await post(group.id, `${status} 前一轮`, `terminal-${status}`);
    await service.store.change(group.id, (record) => {
      const task = record.tasks.find((task) => task.id === first.task.id);
      task.status = status; task.reason = `${status} 原因`; task.result = `${status} 已有结果`; task.generation = 3;
    });
    const snapshot = structuredClone((await service.getGroup(group.id)).tasks.find((task) => task.id === first.task.id));
    const next = await service.postMessage(group.id, { content: `${status} 后继续聊`, taskId: first.task.id, mutationId: `terminal-follow-${status}` });
    assert.notEqual(next.task.id, first.task.id); assert.equal(next.task.conversationId, first.task.id); assert.equal(next.task.generation, 1);
    assert.deepEqual((await service.getGroup(group.id)).tasks.find((task) => task.id === first.task.id), snapshot);
    await assert.rejects(toolsFor(service, group.id, first.task.id, "a").send_group_message.execute(`late-${status}`, { content: "迟到的原任务写入" }), /本轮协作已停止/);
  }
});

test("直接对话缺信息时公开追问，补充原话后仍直接回答且不执行空任务", async (t) => {
  const { service, calls, create, post } = await fixture(t, { intent: async ({ payload }) => {
    const answer = payload.recentMessages.some((value) => value.content === "按不超过 150 字即可");
    return conversationIntent(answer ? "好，我会按不超过 150 字的要求处理你接下来分享的材料。" : "你希望摘要多长？", answer ? "complete" : "needs_input");
  } });
  const { group } = await create(), posted = await post(group.id, "我准备让你帮我摘要材料，需要说清哪些要求？"); await service.idle(group.id);
  let view = await service.getGroup(group.id), task = view.tasks[0];
  assert.equal(task.status, "needs_input"); assert.equal(task.ownerId, "a"); assert.equal(task.result, "你希望摘要多长？");
  assert.equal(view.messages.filter((value) => value.visibility === "public").at(-1).kind, "clarification");
  await service.postMessage(group.id, { content: "按不超过 150 字即可", taskId: posted.task.id, mutationId: "answer-length" }); await service.idle(group.id);
  view = await service.getGroup(group.id); task = view.tasks[0];
  assert.equal(task.status, "completed"); assert.equal(task.phase, "conversation"); assert.match(task.result, /^好，我会/);
  assert.deepEqual(task.children, []); assert.deepEqual(task.jobs, []); assert.equal(calls.length, 4);
});

test("对话追问刚发布时立即补充不会被旧执行轮吞掉，仍重入只读判断", { timeout: 5000 }, async (t) => {
  const published = deferred(), release = deferred(); t.after(() => release.resolve());
  const { service, calls, create, post } = await fixture(t, { intent: async ({ payload }) => {
    const answered = payload.recentMessages.some((message) => message.content === "100字");
    return conversationIntent(answered ? "好，我会按100字的要求处理你接下来分享的材料。" : "你希望摘要多长？", answered ? "complete" : "needs_input");
  } });
  const { group } = await create("quick-answer-group", ["a"]);
  const originalChange = service.store.change.bind(service.store); let paused = false;
  service.store.change = async (...args) => {
    const result = await originalChange(...args), current = (await service.store.get(group.id)).tasks[0];
    if (!paused && current?.phase === "conversation" && current.status === "needs_input") {
      paused = true; published.resolve(); await release.promise;
    }
    return result;
  };
  const posted = await post(group.id, "做摘要前需要说清哪些要求？"); await published.promise;
  await service.postMessage(group.id, { content: "100字", taskId: posted.task.id, mutationId: "immediate-answer" });
  const queued = (await service.store.get(group.id)).tasks[0];
  assert.equal(queued.status, "queued"); assert.equal(queued.ownerId, null);
  release.resolve(); await service.idle(group.id);
  const view = await service.getGroup(group.id), task = view.tasks[0];
  assert.equal(task.status, "completed"); assert.equal(task.result, "好，我会按100字的要求处理你接下来分享的材料。");
  assert.equal(task.negotiationRound, 1); assert.equal(calls.length, 2); assert.equal(calls.every((call) => call.tools.submit_group_intent && call.options.allowBusinessTools === false), true);
  assert.deepEqual(task.children, []); assert.deepEqual(task.jobs, []);
  assert.deepEqual(view.messages.filter((message) => message.sender.type === "agent").map((message) => message.kind), ["clarification", "reply"]);
  assert.equal(view.messages.some((message) => message.sender.type === "system"), false);
});

test("混合对话与真实任务保留任务流程，对话成员不会被排入业务工作", async (t) => {
  const { service, calls, create, post } = await fixture(t, { intent: async ({ options }) => options.agentId === "b" ? { ...conversationIntent("你好，我在。"), replyAudience: { mode: "members", memberIds: ["a", "b"] } }
    : { participate: true, contribution: "整理共享报告", willingToIntegrate: true, integratorId: "a", interaction: "task" } });
  const { group } = await create(); await post(group.id); await service.idle(group.id);
  const view = await service.getGroup(group.id), task = view.tasks[0];
  assert.equal(task.status, "completed"); assert.equal(task.phase, "delivery"); assert.deepEqual(task.children.map((value) => value.assigneeId), ["a"]);
  assert.equal(calls.filter((entry) => !entry.tools.submit_group_intent).every((entry) => entry.options.agentId === "a"), true);
  const visible = view.messages.filter((value) => value.visibility !== "internal" && value.sender.type === "agent");
  assert.equal(visible.length, 1); assert.equal(visible[0].kind, "delivery"); assert.notEqual(visible[0].content, "你好，我在。");
});

test("真实任务因能力不足拒领时不能用另一位的普通回复伪装已经完成", async (t) => {
  const { service, calls, create, post } = await fixture(t, { intent: async ({ options }) => options.agentId === "a"
    ? { interaction: "task", participate: false, contribution: "我没有执行这项操作的能力。", willingToIntegrate: false, integratorId: "" }
    : conversationIntent("我在，可以继续聊。") });
  const { group } = await create(); await post(group.id, "执行需要当前成员尚未具备能力的任务"); await service.idle(group.id);
  const view = await service.getGroup(group.id), task = view.tasks[0];
  assert.equal(task.status, "needs_input"); assert.equal(task.result, ""); assert.equal(task.negotiationRound, 2);
  assert.deepEqual(task.jobs, []); assert.deepEqual(task.children, []); assert.equal(calls.length, 4);
  assert.equal(view.messages.some((message) => message.kind === "reply" || message.sender.type === "agent"), false);
  assert.equal(view.messages.at(-1).kind, "clarification");
});

test("普通单人回复不被无关成员意向失败阻挡，保留成功成员本人答复", async (t) => {
  const { service, calls, create, post } = await fixture(t, { intent: async ({ options }) => {
    if (options.agentId === "b") throw new Error("模型连接暂时失败");
    return conversationIntent("你好，我在。");
  } });
  const { group } = await create(); await post(group.id, "你好"); await service.idle(group.id);
  const view = await service.getGroup(group.id), task = view.tasks[0];
  assert.equal(task.status, "completed"); assert.equal(task.result, "你好，我在。"); assert.equal(calls.length, 2); assert.deepEqual(task.children, []);
  assert.deepEqual(view.messages.filter((value) => value.sender.type === "agent").map((value) => value.sender.id), ["a"]);
  assert.equal(view.messages.some((value) => value.visibility === "public" && value.sender.type === "system"), false);
});

test("对话回复发布前重验能力版本，迟到的普通回复不能越过停工边界", async (t) => {
  let held;
  const { service, cards, create, post } = await fixture(t, { intent: async ({ options, hold }) => {
    if (options.agentId === "a") { held = hold(); await held.promise; }
    return conversationIntent("你好，我在。");
  } });
  cards[0] = capabilityCard("a"); cards[1] = capabilityCard("b");
  const { group } = await create(); await post(group.id, "你好"); await until(() => Boolean(held));
  cards[0].capabilityVersion = "a-new-execution-conditions"; held.resolve(); await service.idle(group.id);
  const view = await service.getGroup(group.id), task = view.tasks[0];
  assert.equal(task.status, "interrupted"); assert.equal(task.result, "");
  assert.equal(view.messages.some((value) => value.visibility === "public" && value.kind === "reply"), false);
  assert.equal(view.messages.some((value) => value.visibility === "public" && value.kind === "status"), true);
});

test("对话意向等待期间权限收紧或显式取消均阻止迟到公开回复", async (t) => {
  for (const action of ["restrict", "cancel"]) {
    let held;
    const { service, create, post } = await fixture(t, { intent: async ({ options, hold }) => {
      if (options.agentId === "a" && !held) { held = hold(); await held.promise; }
      return { ...conversationIntent("我可以直接回答你的问题。"), replyAudience: { mode: "members", memberIds: ["a", "b"] } };
    } });
    const { group } = await create(), posted = await post(group.id, "你能介绍一下自己吗？"); await until(() => Boolean(held));
    if (action === "restrict") await service.postMessage(group.id, { content: "接下来不要联网", taskId: posted.task.id, mutationId: "restrict-late-reply" });
    else await service.cancelTask(group.id, posted.task.id);
    held.resolve(); await service.idle(group.id);
    const view = await service.getGroup(group.id), task = view.tasks[0];
    assert.equal(task.status, action === "restrict" ? "interrupted" : "cancelled"); assert.equal(task.result, "");
    assert.equal(view.messages.some((value) => value.taskId === posted.task.id && value.visibility === "public" && value.kind === "reply"), false);
    assert.equal(view.messages.some((value) => value.visibility === "public" && value.kind === "status"), true);
  }
});

test("对话意向严格拒绝业务认领、空回复和无效状态，旧意向仍按实际任务处理", async () => {
  const tool = intentTool(() => {}), signal = new AbortController().signal;
  for (const input of [{ participate: true, contribution: "假执行" }, { willingToIntegrate: true }, { integratorId: "a" }, { reply: "" }, { replyStatus: "partial" }, { interaction: "invented" },
    { replyAudience: { mode: "all", memberIds: ["a"] } }, { replyAudience: { mode: "members", memberIds: [] } }, { replyAudience: { mode: "single", memberIds: ["a", "b"] } },
    { replyAudience: { mode: "members", memberIds: ["a"], extra: "untrusted" } }]) {
    await assert.rejects(tool.execute("invalid", { ...conversationIntent("你好，我在。"), ...input }, signal));
  }
  let captured;
  await intentTool((value) => { captured = value; }).execute("legacy", { participate: true, contribution: "真实工作", willingToIntegrate: true, integratorId: "a" }, signal);
  assert.equal(captured.interaction, "task"); assert.equal(captured.participate, true); assert.equal("reply" in captured, false);
});

test("真实最终回复失败仍公开简短提示，保留成员成果且不冒充完成", async (t) => {
  const { service, create, post } = await fixture(t, { run: async ({ payload, call }) => {
    if (payload.kind === "integration") throw new Error("模型暂时无法完成最终回复");
    await call("submit_group_turn", { status: "complete", result: "已经保存的真实核对结果" });
  } });
  const { group } = await create(); await post(group.id); await service.idle(group.id);
  const view = await service.getGroup(group.id), task = view.tasks[0];
  assert.equal(task.status, "needs_input"); assert.equal(task.result, ""); assert.equal(task.children.every((child) => child.result === "已经保存的真实核对结果"), true);
  assert.equal(view.messages.some((message) => message.sender.type === "agent"), false);
  const hint = view.messages.find((message) => message.visibility === "public" && message.kind === "status");
  assert.match(hint.content, /暂时没能完成最终回复.*已有成果都保留/);
});

test("真实任务追问补充经 update 恢复业务工作，公开的仍是具体问题与最后结果", async (t) => {
  let supplied = false;
  const { service, calls, create, post } = await fixture(t, { run: async ({ payload, call }) => {
    if (payload.kind === "update") { supplied = true; await call("submit_group_turn", { status: "complete", result: "补充已经收到，继续内部核对" }); }
    else if (!supplied) await call("submit_group_turn", { status: "needs_input", result: payload.kind === "integration" ? "你能分享原始预算表吗？" : "", reason: "缺少预算表" });
    else await call("submit_group_turn", { status: "complete", result: payload.kind === "integration" ? "我核对过你分享的预算表，总额是 100。" : "预算表已核对" });
  } });
  const { group } = await create(), posted = await post(group.id, "核对预算表", "initial-budget-task", { recipientId: "a" }); await service.idle(group.id);
  let view = await service.getGroup(group.id), task = view.tasks[0];
  assert.equal(task.status, "needs_input"); assert.equal(task.phase, "integration");
  await service.postMessage(group.id, { content: "原始表里的预算总额是 100", taskId: posted.task.id, mutationId: "supply-budget" }); await service.idle(group.id);
  view = await service.getGroup(group.id); task = view.tasks[0];
  assert.equal(task.status, "completed"); assert.equal(task.result, "我核对过你分享的预算表，总额是 100。");
  assert.ok(calls.some((call) => call.payload.kind === "update"));
  const replies = view.messages.filter((message) => message.sender.type === "agent");
  assert.deepEqual(replies.map((message) => message.kind), ["clarification", "delivery"]);
  assert.equal(replies[0].content, "你能分享原始预算表吗？"); assert.equal(replies[1].content, task.result);
  const internal = (await service.store.get(group.id)).messages.find((message) => message.content === "补充已经收到，继续内部核对");
  assert.equal(internal.visibility, "internal"); assert.equal(internal.kind, "coordination");
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
  const messages = (await service.store.get(group.id)).messages;
  for (const value of messages.filter((value) => value.recipientId || value.kind === "member_result")) assert.equal(value.visibility, "internal");
  assert.equal(messages.find((value) => value.content === "预算为100，请继续分析").kind, "coordination");
  assert.equal((await service.getGroup(group.id)).messages.some((value) => value.content === "预算为100，请继续分析"), false);
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
  held.resolve(); await service.idle(group.id); assert.equal(lateRejected, 1); assert.equal(calls.length, 3);

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
