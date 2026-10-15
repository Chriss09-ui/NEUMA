import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollaborationService } from "../src/collaboration/groups.mjs";
import { message } from "../src/collaboration/group-store.mjs";
import { groupTaskAllowsNetwork } from "../src/collaboration/group-tools.mjs";

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const conversation = (reply, fields = {}) => ({ interaction: "conversation", participate: false, contribution: "", willingToIntegrate: false, integratorId: "", reply, ...fields });
const request = (recipientId, kind = "confirmation") => ({ recipientId, kind });
const publicReplies = (view) => view.messages.filter((value) => value.sender.type === "agent");
async function until(check) {
  const deadline = Date.now() + 3000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("公开接话没有在预期时间推进");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function fixture(t, { intent, reply, work, route = { mode: "default" }, limits } = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-public-replies-")), calls = [], holds = [];
  const cards = ["a", "b", "c"].map((id) => ({ id, name: `成员 ${id}`, description: `${id} 的公开能力`, ready: true, revision: 1, capabilityVersion: `${id}-v1` }));
  const materials = { list: async () => ({ attachments: [] }), resolve: async (_groupId, ids) => ids, tools: () => [], close: async () => {} };
  let service, counter = 0;
  const agents = { ready: Promise.resolve(), capabilityCards: async ({ agentIds } = {}) => ({ agents: structuredClone(agentIds ? cards.filter((value) => agentIds.includes(value.id)) : cards) }),
    activitySnapshot: async () => ({ activities: [] }),
    async executeCollaboration(options, _progress, { signal }) {
      const payload = JSON.parse(options.message), tools = Object.fromEntries(options.customTools.map((value) => [value.name, value]));
      const call = (name, value) => {
        assert.ok(tools[name], `本轮缺少 ${name}`); return tools[name].execute(`call-${++counter}`, value, signal);
      };
      const context = { options, payload, tools, call, signal, cards, service, hold: () => { const barrier = deferred(); holds.push(barrier); return barrier; } };
      if (options.role === "routing") { await call("submit_group_route", route); return { turns: 1 }; }
      calls.push(context);
      if (tools.submit_group_intent) await call("submit_group_intent", intent ? await intent(context)
        : conversation("请你确认收到交接。", { replyRequest: request("b") }));
      else if (tools.submit_group_reply) await call("submit_group_reply", reply ? await reply(context) : { reply: "收到，资料核对交给我。" });
      else if (work) await work(context);
      else assert.fail(`不应进入实际工作 ${payload.kind}`);
      return { turns: 1 };
    } };
  service = new CollaborationService({ dataDir: root, agents, materials, limits }); await service.ready;
  t.after(async () => { for (const hold of holds) hold.resolve(); await service.close(); await rm(root, { recursive: true, force: true }); });
  const { group } = await service.createGroup({ name: "公开接话验证", memberIds: cards.map((value) => value.id), mutationId: "create" });
  const post = (content = "请说明资料交接", mutationId = "first", extra = {}) => service.postMessage(group.id, { content, recipientId: "a", mutationId, ...extra });
  const read = () => service.getGroup(group.id);
  const finish = async () => { await service.idle(group.id); return read(); };
  return { root, service, agents, materials, cards, calls, groupId: group.id, post, read, finish };
}

test("普通引用和正文艾特不唤起成员，明确公开请求才进入只读接话", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { intent: async () => conversation("@成员 b 我同意刚才的结论。", { replyRecipientId: "b" }) });
  await f.post(); const view = await f.finish();
  assert.equal(f.calls.length, 1); assert.equal(view.tasks[0].replyRelay, undefined);
  assert.deepEqual(publicReplies(view).map((value) => value.sender.id), ["a"]);
  assert.equal(publicReplies(view)[0].recipientId, "b");
});

test("公开确认由本人自动回应来源消息，工具和上下文保持只读公开范围", { timeout: 5000 }, async (t) => {
  let triggerId;
  const f = await fixture(t, { intent: async ({ options, service }) => {
    await service.store.change(options.scope.groupId, (record) => message(record, { type: "agent", id: "c", name: "成员 c" }, "不能泄露的内部协商", {
      taskId: options.scope.taskId, visibility: "internal", kind: "coordination" }));
    return conversation("请你确认收到交接。", { replyRequest: request("b") });
  }, reply: async ({ options, payload, tools, call }) => {
    assert.equal(options.agentId, "b"); assert.equal(options.allowBusinessTools, false); assert.equal(options.taskAllowNetwork, false); assert.equal(options.maxTurns, 3);
    assert.deepEqual(Object.keys(tools).sort(), ["read_group_turn_context", "submit_group_reply"]);
    assert.equal(payload.triggeringMessage.sender.id, "a"); triggerId = payload.triggeringMessage.id;
    assert.equal(payload.triggeringMessage.replyRequest.kind, "confirmation");
    assert.equal(payload.recentMessages.some((value) => value.content === "不能泄露的内部协商"), false);
    const page = JSON.parse((await call("read_group_turn_context", { section: "recentMessages", limit: 8000 })).content[0].text);
    assert.equal(page.text.includes("不能泄露的内部协商"), false);
    return { reply: "收到，我负责核对资料来源。" };
  } });
  const first = await f.post(), view = await f.finish(), replies = publicReplies(view), task = view.tasks[0];
  assert.deepEqual(replies.map((value) => value.sender.id), ["a", "b"]);
  assert.equal(replies[1].recipientId, "a"); assert.equal(replies[1].replyTo, triggerId); assert.equal(replies[1].taskId, first.task.id);
  assert.equal(replies[0].replyRequestStatus, "completed"); assert.equal(task.status, "completed"); assert.equal(task.phase, "conversation");
  assert.equal(task.replyRelay.requests.length, 1); assert.equal(task.replyRelay.requests[0].status, "completed");
  assert.deepEqual(task.jobs, []); assert.deepEqual(task.children, []);
});

test("独立接话并行推进，慢成员不阻挡其他成员，目标本人不会并发重复进入", { timeout: 5000 }, async (t) => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const active = new Set(); let maxActive = 0, firstB = true;
  const f = await fixture(t, { route: { mode: "all" }, intent: async ({ options }) => conversation(`成员 ${options.agentId} 的交接。`, {
    replyRequest: request(options.agentId === "b" ? "c" : "b")
  }), reply: async ({ options }) => {
    assert.equal(active.has(options.agentId), false); active.add(options.agentId); maxActive = Math.max(maxActive, active.size);
    if (options.agentId === "b" && firstB) { firstB = false; entered.resolve(); await release.promise; }
    active.delete(options.agentId); return { reply: `成员 ${options.agentId} 已收到。` };
  } });
  await f.post("大家分别确认交接", "parallel", { recipientId: undefined }); await entered.promise;
  await until(async () => publicReplies(await f.read()).some((value) => value.content === "成员 c 已收到。"));
  assert.equal(firstB, false); assert.equal(active.has("b"), true);
  release.resolve(); const view = await f.finish();
  assert.equal(maxActive, 2); assert.equal(view.tasks[0].replyRelay.requests.length, 3);
  assert.equal(view.tasks[0].replyRelay.requests.every((value) => value.status === "completed"), true);
  assert.equal(view.tasks[0].status, "completed");
});

test("并发接话等待在途预算释放，不能把暂时已预留的轮次误判为永久耗尽", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { limits: { executionTurns: 3 }, route: { mode: "all" }, intent: async ({ options }) => conversation(`成员 ${options.agentId} 说明交接。`,
    options.agentId === "c" ? {} : { replyRequest: request(options.agentId === "a" ? "b" : "c") }) });
  await f.post("各位说明交接", "small-budget", { recipientId: undefined }); const view = await f.finish(), task = view.tasks[0];
  assert.equal(task.status, "completed"); assert.equal(task.turnsUsed, 2);
  assert.deepEqual(task.replyRelay.requests.map((value) => value.status), ["completed", "completed"]);
  assert.deepEqual(f.calls.filter((value) => value.tools.submit_group_reply).map((value) => value.options.agentId), ["b", "c"]);
});

test("两层公开接力允许必要追问，第三层不能循环叫回原成员", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { reply: async ({ options }) => options.agentId === "b"
    ? { reply: "我收到。请你确认日期。", replyRequest: request("c", "question") }
    : { reply: "日期需要原始材料，请你补充。", replyRequest: request("a", "question") } });
  await f.post(); const view = await f.finish(), replies = publicReplies(view), task = view.tasks[0];
  assert.deepEqual(replies.map((value) => value.sender.id), ["a", "b", "c"]);
  assert.equal(replies[1].replyTo, replies[0].id); assert.equal(replies[2].replyTo, replies[1].id); assert.equal(replies[2].recipientId, "a");
  assert.equal(replies[2].replyRequestStatus, "limited"); assert.equal(task.status, "partial");
  assert.deepEqual(task.replyRelay.requests.map((value) => value.depth), [1, 2]);
  assert.equal(view.messages.filter((value) => value.kind === "status").length, 1);
});

test("接收者可以向原发言者追问，原发言者自动澄清后自然结束", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { reply: async ({ options }) => options.agentId === "b"
    ? { reply: "我收到。你指的是哪份原始材料？", replyRequest: request("a", "question") }
    : { reply: "我指的是刚才提到的任务说明文件。" } });
  await f.post(); const view = await f.finish(), replies = publicReplies(view), task = view.tasks[0];
  assert.deepEqual(replies.map((value) => value.sender.id), ["a", "b", "a"]);
  assert.equal(replies[1].replyTo, replies[0].id); assert.equal(replies[2].replyTo, replies[1].id); assert.equal(replies[2].recipientId, "b");
  assert.deepEqual(task.replyRelay.requests.map((value) => value.depth), [1, 2]); assert.equal(task.status, "completed");
  assert.equal(view.messages.some((value) => value.kind === "status"), false);
});

test("业务中的公开问答接力结束后恢复原工作，待输入成果也不会被确认覆盖", { timeout: 10000 }, async (t) => {
  for (const phase of ["running", "needs_input"]) {
    const entered = deferred(), release = deferred(); t.after(() => release.resolve());
    const f = await fixture(t, {
      intent: async ({ payload }) => payload.kind === "update" ? conversation("请确认收到。", { replyRequest: request("b") })
        : { participate: true, contribution: "整理资料", willingToIntegrate: true, integratorId: "a" },
      work: async ({ payload, call }) => {
        if (payload.kind === "work" && phase === "running") { entered.resolve(); await release.promise; }
        await call("submit_group_turn", payload.kind === "integration" && phase === "needs_input"
          ? { status: "needs_input", result: "保留的已有成果", reason: "请补充评分标准" }
          : { status: "complete", result: payload.kind === "integration" ? "已完成原工作" : "实际工作结果" });
      }
    });
    const initial = await f.post("整理资料");
    if (phase === "running") await entered.promise; else await f.finish();
    const input = await f.post("说明交接并让成员 b 确认", "followup", { taskId: initial.task.id });
    release.resolve(); const view = await f.finish(), task = view.tasks[0];
    const source = publicReplies(view).find((value) => value.replyTo === input.message.id);
    assert.equal(source.replyRequestStatus, "completed");
    assert.equal(task.replyRelay.sourceMessageId, input.message.id); assert.equal(task.replyRelay.status, "completed");
    assert.equal(task.status, phase === "needs_input" ? "needs_input" : "completed");
    assert.equal(task.result, phase === "needs_input" ? "保留的已有成果" : "已完成原工作");
    assert.equal(f.calls.filter((value) => value.payload.kind === "integration").length, 1);
    assert.equal(task.jobs.some((value) => ["queued", "running"].includes(value.status)), false);
  }
});

test("多位点名混合实际工作时，另一位的公开提问仍被保留并由本人接话", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { route: { mode: "all" }, intent: async ({ options }) => options.agentId === "a"
    ? { participate: true, contribution: "整理资料", willingToIntegrate: true, integratorId: "a" }
    : options.agentId === "b" ? conversation("请确认交接。", { replyRequest: request("c") }) : conversation("我在。"),
    work: async ({ payload, call }) => call("submit_group_turn", { status: "complete", result: payload.kind === "integration" ? "真实交付" : "真实工作结果" }) });
  await f.post("成员 a 处理资料，其他人说明交接", "mixed", { recipientId: undefined }); const view = await f.finish(), task = view.tasks[0];
  const source = publicReplies(view).find((value) => value.sender.id === "b");
  assert.equal(source.replyRequestStatus, "completed");
  assert.equal(publicReplies(view).find((value) => value.replyTo === source.id).sender.id, "c");
  assert.equal(task.status, "completed"); assert.equal(task.result, "真实交付");
  assert.deepEqual(task.children.map((value) => value.assigneeId), ["a"]);
});

test("同一用户轮在初始接话后完成业务并再次交接，重开接力保留总预算且正常结束", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { route: { mode: "all" }, intent: async ({ options }) => options.agentId === "a"
    ? { participate: true, contribution: "整理资料", willingToIntegrate: true, integratorId: "a" }
    : options.agentId === "b" ? conversation("请确认开始交接。", { replyRequest: request("c") }) : conversation("我在。"),
    work: async ({ payload, call }) => call("submit_group_turn", { status: "complete", result: payload.kind === "integration" ? "真实交付，请确认收到。" : "真实工作结果",
      ...(payload.kind === "integration" ? { replyRequest: request("b") } : {}) }) });
  await f.post("成员 a 处理资料，其他人确认交接", "two-relays", { recipientId: undefined }); const view = await f.finish(), task = view.tasks[0];
  assert.equal(task.status, "completed"); assert.equal(task.phase, "delivery"); assert.equal(task.replyRelay.status, "completed");
  assert.equal(task.replyRelay.requests.length, 2); assert.equal(task.replyRelay.requests.every((value) => value.status === "completed"), true);
  assert.equal(task.replyRelay.completion.phase, "delivery"); assert.equal(task.result, "真实交付，请确认收到。");
});

test("原业务接话期间收到新输入，停止旧接力后继续待做工作而不遗留运行状态", { timeout: 5000 }, async (t) => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const f = await fixture(t, { route: { mode: "all" }, intent: async ({ options, payload }) => payload.kind === "update"
    ? conversation("我收到你的新消息了。") : options.agentId === "a"
      ? { participate: true, contribution: "整理资料", willingToIntegrate: true, integratorId: "a" }
      : options.agentId === "b" ? conversation("请确认交接。", { replyRequest: request("c") }) : conversation("我在。"),
    reply: async () => { entered.resolve(); await release.promise; return { reply: "不应迟到的旧接话" }; },
    work: async ({ payload, call }) => call("submit_group_turn", { status: "complete", result: payload.kind === "integration" ? "原工作已完成" : "真实工作结果" }) });
  const initial = await f.post("成员 a 处理资料，其他人说明交接", "business", { recipientId: undefined }); await entered.promise;
  const next = await f.post("收到，继续原工作", "continue-business", { taskId: initial.task.id });
  assert.equal(next.task.id, initial.task.id); release.resolve(); const view = await f.finish(), task = view.tasks[0];
  assert.equal(task.status, "completed"); assert.equal(task.result, "原工作已完成");
  assert.equal(task.jobs.some((value) => ["queued", "running"].includes(value.status)), false);
  assert.equal(view.messages.some((value) => value.content === "不应迟到的旧接话"), false);
  assert.equal(f.calls.filter((value) => value.payload.kind === "work").length, 1);
});

test("每条接力链中的成员最多自动一次，增加深度预算仍不能重复唤起", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { limits: { publicReplyDepth: 10 }, reply: async ({ options }) => options.agentId === "b"
    ? { reply: "我收到，请你确认日期。", replyRequest: request("c", "question") }
    : { reply: "日期仍缺来源，请你再核对。", replyRequest: request("b", "question") } });
  await f.post(); const view = await f.finish();
  assert.deepEqual(publicReplies(view).map((value) => value.sender.id), ["a", "b", "c"]);
  assert.equal(view.tasks[0].replyRelay.requests.length, 2); assert.equal(view.tasks[0].status, "partial");
  assert.equal(publicReplies(view).at(-1).replyRequestStatus, "limited");
});

test("失败也消耗全局接话预算，多条公开来源合计最多四次调用", { timeout: 5000 }, async (t) => {
  let attempts = 0;
  const f = await fixture(t, { route: { mode: "all" }, intent: async ({ options }) => conversation(`我是 ${options.agentId}，请确认。`, {
    replyRequest: request({ a: "b", b: "c", c: "a" }[options.agentId]) }), reply: async ({ payload }) => {
    attempts++; if (attempts === 1) throw new Error("模拟成员连接失败");
    return payload.replyRequest.depth === 1 ? { reply: "我收到，请你核对一下。", replyRequest: request("b", "question") } : { reply: "我会核对。" };
  } });
  await f.post("各位分别确认交接", "all", { recipientId: undefined }); const view = await f.finish(), task = view.tasks[0];
  assert.equal(attempts, 4); assert.equal(task.replyRelay.requests.length, 4); assert.equal(task.replyRelay.requests[0].status, "failed");
  assert.equal(task.status, "partial"); assert.equal(task.replyRelay.limited, true);
  assert.equal(view.messages.some((value) => value.sender.type === "system" && value.status === "failed"), true);
});

test("接话失败、缺输入和拒绝分别保留真实结果，不以确认冒充整体成功", { timeout: 5000 }, async (t) => {
  for (const outcome of ["failed", "needs_input", "declined"]) {
    const f = await fixture(t, { reply: async () => {
      if (outcome === "failed") throw new Error("模拟本次调用失败");
      return { reply: outcome === "needs_input" ? "我需要原始资料才能确认。" : "这超出了我的能力范围。", replyStatus: outcome };
    } });
    await f.post(); const view = await f.finish(), task = view.tasks[0];
    assert.equal(task.status, outcome === "needs_input" ? "needs_input" : "partial");
    assert.equal(publicReplies(view)[0].content, "请你确认收到交接。"); assert.equal(task.result, "请你确认收到交接。");
    assert.equal(task.replyRelay.requests[0].status, outcome === "failed" ? "failed" : "completed");
    if (outcome !== "failed") assert.equal(publicReplies(view).at(-1).kind, "clarification");
    else assert.equal(publicReplies(view).length, 1);
  }
});

test("同一发送的网络重试复用消息与接话请求，不重复发布或调用本人", { timeout: 5000 }, async (t) => {
  const f = await fixture(t); const first = await f.post(); await f.finish();
  const retry = await f.post(); const view = await f.finish();
  assert.equal(first.message.id, retry.message.id); assert.equal(first.task.id, retry.task.id);
  assert.equal(view.tasks.length, 1); assert.equal(view.tasks[0].replyRelay.requests.length, 1);
  assert.deepEqual(publicReplies(view).map((value) => value.sender.id), ["a", "b"]); assert.equal(f.calls.length, 2);
});

test("接话中用户续发同会话新执行，中止旧接力并阻止迟到结果污染新轮", { timeout: 5000 }, async (t) => {
  const entered = deferred(), release = deferred(); let oldSignal, lateRejected = false;
  t.after(() => release.resolve());
  const f = await fixture(t, { intent: async ({ payload }) => payload.goal === "继续说说材料要求" ? conversation("我会继续说明材料要求。")
    : conversation("请确认交接。", { replyRequest: request("b") }), reply: async ({ signal, call }) => {
    oldSignal = signal; entered.resolve(); await release.promise;
    await assert.rejects(call("submit_group_reply", { reply: "不应出现的旧确认" })); lateRejected = true;
    return { reply: "不应出现的旧确认" };
  } });
  const initial = await f.post(); await entered.promise;
  const next = await f.post("继续说说材料要求", "next", { taskId: initial.task.id });
  assert.notEqual(next.task.id, initial.task.id); assert.equal(next.task.conversationId, initial.task.conversationId); assert.equal(oldSignal.aborted, true);
  release.resolve(); const view = await f.finish(), old = view.tasks.find((value) => value.id === initial.task.id);
  assert.equal(lateRejected, true); assert.equal(old.replyRelay.status, "superseded"); assert.equal(old.replyRelay.requests[0].status, "superseded");
  assert.ok(old.generation > initial.task.generation); assert.equal(view.messages.some((value) => value.content === "不应出现的旧确认"), false);
  assert.equal(view.tasks.find((value) => value.id === next.task.id).status, "completed");
});

test("旧意向迟到发布时发现用户已续发，不再启动过时的公开接力", { timeout: 5000 }, async (t) => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const f = await fixture(t, { intent: async ({ payload }) => {
    if (payload.goal === "继续说说材料要求") return conversation("我来继续回答。");
    entered.resolve(); await release.promise; return conversation("旧轮交接说明。", { replyRequest: request("b") });
  } });
  const initial = await f.post(); await entered.promise;
  const next = await f.post("继续说说材料要求", "next", { taskId: initial.task.id }); release.resolve();
  const view = await f.finish();
  assert.notEqual(next.task.id, initial.task.id); assert.equal(next.task.conversationId, initial.task.conversationId);
  const source = publicReplies(view).find((value) => value.taskId === initial.task.id);
  assert.equal(source.replyRequestStatus, "superseded"); assert.equal(f.calls.some((value) => value.tools.submit_group_reply), false);
  assert.equal(view.tasks.find((value) => value.id === initial.task.id).replyRelay, undefined);
});

test("取消和能力版本变化终止接话，迟到的本人答复不会重新发布", { timeout: 5000 }, async (t) => {
  for (const action of ["cancel", "version"]) {
    const entered = deferred(), release = deferred(); t.after(() => release.resolve());
    const f = await fixture(t, { reply: async () => { entered.resolve(); await release.promise; return { reply: "迟到的接话" }; } });
    const initial = await f.post(); await entered.promise;
    if (action === "cancel") await f.service.cancelTask(f.groupId, initial.task.id);
    else f.cards.find((value) => value.id === "b").capabilityVersion = "b-v2";
    release.resolve(); const view = await f.finish(), task = view.tasks[0];
    assert.equal(task.status, action === "cancel" ? "cancelled" : "interrupted");
    assert.equal(task.replyRelay.status, action === "cancel" ? "cancelled" : "interrupted");
    assert.equal(view.messages.some((value) => value.content === "迟到的接话"), false);
    assert.equal(publicReplies(view).length, 1);
  }
});

test("接话期间禁网补充停止旧接力，新执行继承禁网且不重放旧答复", { timeout: 5000 }, async (t) => {
  for (const replyStatus of ["complete", "needs_input"]) {
    const entered = deferred(), release = deferred(); t.after(() => release.resolve()); let oldSignal;
    const f = await fixture(t, { intent: async ({ payload }) => payload.goal === "接下来不要联网，继续说明" ? conversation("我会按你的要求说明。")
      : conversation("请确认交接。", { replyStatus, replyRequest: request("b") }), reply: async ({ signal }) => { oldSignal = signal; entered.resolve(); await release.promise; return { reply: "旧接话" }; } });
    const initial = await f.post(); await entered.promise;
    const next = await f.post("接下来不要联网，继续说明", "restricted", { taskId: initial.task.id });
    assert.notEqual(next.task.id, initial.task.id); assert.equal(next.task.conversationId, initial.task.conversationId);
    assert.equal(oldSignal.aborted, true); release.resolve(); const view = await f.finish(), raw = await f.service.store.get(f.groupId);
    assert.equal(view.tasks.find((value) => value.id === initial.task.id).replyRelay.status, "superseded");
    assert.equal(groupTaskAllowsNetwork(raw, raw.tasks.find((value) => value.id === next.task.id)), false);
    assert.equal(view.messages.some((value) => value.content === "旧接话"), false);
  }
});

test("最终交付后的确认不重跑整合，不覆盖原部分交付和待输入状态", { timeout: 5000 }, async (t) => {
  for (const status of ["complete", "partial", "needs_input"]) {
    const f = await fixture(t, { intent: async () => ({ interaction: "task", participate: true, contribution: "整理共享资料", willingToIntegrate: true, integratorId: "a" }),
      work: async ({ payload, call }) => call("submit_group_turn", payload.kind === "integration"
        ? { status, result: "真实整合交付", reason: status === "complete" ? "" : "尚缺原始资料", replyRequest: request("b") }
        : { status: "complete", result: "真实成员结果" }) });
    await f.post(); const view = await f.finish(), task = view.tasks[0];
    assert.equal(task.status, status === "complete" ? "completed" : status); assert.equal(task.result, "真实整合交付");
    if (status !== "complete") assert.equal(task.reason, "尚缺原始资料");
    assert.deepEqual(publicReplies(view).map((value) => value.sender.id), ["a", "b"]);
    assert.equal(f.calls.filter((value) => value.payload.kind === "integration").length, 1);
  }
});

test("服务重启将未完成接话标为中断，保留公开原话且不自动重放模型", { timeout: 5000 }, async (t) => {
  const entered = deferred();
  const f = await fixture(t, { reply: async ({ hold }) => { const held = hold(); entered.resolve(); await held.promise; return { reply: "旧进程稍后返回的接话" }; } });
  await f.post(); await entered.promise;
  const recoveryRoot = await mkdtemp(join(tmpdir(), "neuma-reply-recovery-")); t.after(() => rm(recoveryRoot, { recursive: true, force: true }));
  await mkdir(join(recoveryRoot, "groups", f.groupId), { recursive: true });
  await cp(join(f.root, "groups", f.groupId, "group.json"), join(recoveryRoot, "groups", f.groupId, "group.json"));
  const priorCalls = f.calls.length, restarted = new CollaborationService({ dataDir: recoveryRoot, agents: f.agents, materials: f.materials });
  try {
    await restarted.ready; const view = await restarted.getGroup(f.groupId), task = view.tasks[0];
    assert.equal(task.status, "interrupted"); assert.equal(task.replyRelay.status, "interrupted"); assert.equal(task.replyRelay.requests[0].status, "interrupted");
    assert.equal(f.calls.length, priorCalls); assert.equal(publicReplies(view).length, 1); assert.equal(restarted.workers.size, 0);
  } finally { await restarted.close(); }
});
