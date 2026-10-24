interface CollaborationRecord {options:PiSessionOptions;tools:ReturnType<typeof fixtureTools>;prompts:string[];disposed:boolean;aborted:boolean;reply:string;autoCompaction?:unknown;release?:()=>void;session?:PiSessionPort}
import type {SessionEvent} from "../src/runtime/pi-port.mjs";
import { callFixture } from "./helpers/m7-test-boundaries.mjs";
import { recordArray } from "./helpers/m7-test-boundaries.mjs";
import type { FixtureModelRequest } from "./helpers/m7-test-boundaries.mjs";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import { dispatchModelEvent } from "./helpers/m7-test-boundaries.mjs";
import type { SessionMessage } from "../src/runtime/pi-port.mjs";
import type { PiSessionPort } from "../src/runtime/pi-port.mjs";
import { fixtureTools } from "./helpers/m7-test-boundaries.mjs";
import type { PiSessionOptions } from "../src/runtime/pi-port.mjs";
import { listeningAddress } from "./helpers/m7-test-boundaries.mjs";
import type { TestFailure } from "./helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrototypeAgents } from "../src/agents/agent-prototype.mjs";
import { ActivityStore } from "../src/runtime/activity-store.mjs";
import { createPiSession } from "../src/runtime/pi-runtime.mjs";
import { CAPABILITIES } from "../src/architecture/architecture-contract.mjs";
import { validDraft, validDesign, passingReview } from "./helpers/architecture.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const input = (id:string,goal?:string) => ({ id, name: `成员 ${id}`, draft: validDraft(goal) });
const round = (agentId = "a", sessionId = "collaboration-session-12345", overrides = {}) => ({ agentId, revision: 1, sessionId,
  scope: { groupId: "group-one", taskId: "task-one" }, message: "处理当前共享任务", systemContext: "只处理本群本任务", ...overrides });
const routingTools = (submit = async () => ({ content: [{ type: "text", text: "accepted" }], details: {}, terminate: true })) => [
  { name: "read_group_turn_context", parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: "text", text: "本轮公开上下文" }], details: {} }) },
  { name: "submit_group_route", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: submit },
];
const routingRound = (sessionId = "routing-session-12345", overrides = {}) => round("a", sessionId, {
  role: "routing", allowBusinessTools: false, customTools: routingTools(), ...overrides });

async function fixture(t:test.TestContext,run:(record:CollaborationRecord,session:PiSessionPort,emit:(event:SessionEvent)=>void)=>unknown|Promise<unknown>=async()=>{}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-collaboration-runtime-")), records:CollaborationRecord[]=[];
  const options = { config: { llmConfigured: true }, cwd: root, dataDir: join(root, "data"), sessionFactory: async (options: PiSessionOptions) => {
    const listeners = new Set<Parameters<NonNullable<PiSessionPort["subscribe"]>>[0]>(), tools = fixtureTools(options.customTools);
    const record:CollaborationRecord = { options, tools, prompts: [], disposed: false, aborted: false, reply: "已完成当前任务" };
    const session = { messages: [] as SessionMessage[], subscribe(listener: Parameters<NonNullable<PiSessionPort["subscribe"]>>[0]) { listeners.add(listener); return () => listeners.delete(listener); },
      setAutoCompactionEnabled(value: unknown) { record.autoCompaction = value; }, getLastAssistantText: () => record.reply,
      async abort() { record.aborted = true; record.release?.(); }, dispose() { record.disposed = true; },
      async prompt(message: string) {
        record.prompts.push(message);
        if (tools.submit_architecture) {
          const payload = JSON.parse(String(message));
          return tools.submit_architecture.execute("build", validDesign(payload.requirements, {
            capabilities: CAPABILITIES.map(({ id, scope }) => ({ id, status: "available", reason: scope })) }));
        }
        if (tools.submit_architecture_review) return tools.submit_architecture_review.execute("review", passingReview(JSON.parse(String(message)).candidateHash));
        const emit = (event: { type: string; }) => { for (const listener of listeners) dispatchModelEvent(listener, event); };
        emit({ type: "turn_start" });
        await run(record, session, emit);
        emit({ type: "turn_end" });
      } };
    record.session = session; records.push(record); return session;
  } };
  const agents = new PrototypeAgents(options);
  t.after(async () => { await agents.close(); await rm(root, { recursive: true, force: true }); });
  await agents.build(input("a"));
  return { root, records, options, agents, executions: () => records.filter((record) => !record.tools.submit_architecture && !record.tools.submit_architecture_review) };
}

test("群短会话不含私人记忆/材料工具，协商只装群工具，工具提交可以无自然语言", async (t) => {
  const { agents, executions } = await fixture(t, async (record) => {
    if (record.tools.claim_work) { record.reply = ""; await record.tools.claim_work.execute("claim", {}); }
  });
  await agents.setMemory("a", "PRIVATE_MEMORY_FIXTURE");
  const claim = { name: "claim_work", parameters: { type: "object", properties: {} }, execute: async () => ({
    content: [{ type: "text", text: "accepted" }], details: {}, terminate: true }) };
  assert.deepEqual(await agents.executeCollaboration(round("a", undefined, { allowBusinessTools: false, customTools: [claim] })), { reply: "", turns: 1 });
  const first = executions()[0];
  assert.deepEqual(Object.keys(first!.tools), ["claim_work"]);
  assert.match(first!.options.systemPrompt!, /对话回复或协商/);
  assert.doesNotMatch(first!.options.systemPrompt!, /仅用于协商认领/);
  assert.doesNotMatch(JSON.stringify(first!.options.systemPrompt) + first!.prompts.join(""), /PRIVATE_MEMORY_FIXTURE|list_materials|read_material/);
  assert.equal(first!.disposed, true); assert.equal(first!.autoCompaction, false);
  await agents.executeCollaboration(round("a", "second-group-session-12345"));
  assert.deepEqual(Object.keys(executions()[1]!.tools), ["list_workspace_files", "read_workspace_file", "write_workspace_file", "web_search", "web_fetch"]);
  assert.notEqual(executions()[0]!.session, executions()[1]!.session);
  const activity = (await agents.activitySnapshot()).activities;
  assert.equal(activity.length, 2); assert.equal(activity.every((item) => item.status === "complete"), true);
  assert.deepEqual(activity[0]!.scope, { groupId: "group-one", taskId: "task-one" });
});

test("平台寻址借用配置但不继承成员身份、工作指令、私人记忆或业务工具", async (t) => {
  const { agents, executions } = await fixture(t, async (record) => {
    record.reply = "";
    await record.tools.read_group_turn_context!.execute("context", {});
    await record.tools.submit_group_route!.execute("route", {});
  });
  await agents.setMemory("a", "PRIVATE_MEMORY_FIXTURE");
  await agents.setProfile("a", { name: "PRIVATE_AGENT_NAME_FIXTURE", description: "公开简介", icon: "star:0:0" });
  agents.agents.set("a", { ...agents.agents.get("a")!, instructions: "PRIVATE_AGENT_INSTRUCTIONS_FIXTURE" });
  agents.approvedDefinition = () => true;
  agents.businessTools = async () => { throw new Error("寻址不得装配业务工具"); };
  const capabilityVersion = (await agents.capabilityCards({ agentIds: ["a"] })).agents![0]!.capabilityVersion;
  assert.deepEqual(await agents.executeCollaboration(routingRound(undefined, { capabilityVersion,
    systemContext: "只提交接收者，不生成群回复", message: "验收检查员打个招呼啊" })), { reply: "", turns: 1 });
  const record = executions()[0], prompt = record!.options.systemPrompt + record!.prompts.join("");
  assert.deepEqual(Object.keys(record!.tools), ["read_group_turn_context", "submit_group_route"]);
  assert.match(record!.options.systemPrompt!, /中立群消息寻址器/);
  assert.doesNotMatch(prompt, /PRIVATE_AGENT_NAME_FIXTURE|PRIVATE_AGENT_INSTRUCTIONS_FIXTURE|PRIVATE_MEMORY_FIXTURE|Agent 工作指令|你是 NEUMA 的群成员|web_search|list_materials/);
  assert.deepEqual(JSON.parse(String(record!.prompts[0]!.split("\n")[0]!.replace("平台核实的群范围：", ""))), {
    groupId: "group-one", taskId: "task-one", identity: "group-routing" });
  assert.equal(record!.options.config.llmConfigured, true);
  assert.equal(typeof record!.options.beforeModelRequest, "function");
  assert.equal(record!.autoCompaction, false); assert.equal(record!.disposed, true);
  assert.equal(agents.scheduler.snapshot().running, 0);
});

test("平台寻址严格拒绝角色、业务权限提升和额外工具，不创建模型会话", async (t) => {
  const { agents, executions } = await fixture(t);
  for (const role of ["router", "", null, true, {}]) await assert.rejects(
    agents.executeCollaboration(routingRound(undefined, { role })), /参数无效/);
  await assert.rejects(agents.executeCollaboration(routingRound(undefined, { allowBusinessTools: true })), /参数无效/);
  const arbitrary = { name: "arbitrary_tool", execute: async () => ({}) };
  for (const customTools of [[], routingTools().slice(0, 1), [...routingTools(), arbitrary], [routingTools()[0], arbitrary]])
    await assert.rejects(agents.executeCollaboration(routingRound(undefined, { customTools })), /群寻址仅允许/);
  await assert.rejects(agents.executeCollaboration(routingRound(undefined, {
    customTools: [...routingTools(), { name: "write_workspace_file", execute: async () => ({}) }] })), /权限冲突/);
  assert.equal(executions().length, 0); assert.equal(agents.scheduler.snapshot().running, 0);
});

test("平台寻址提交继续核实能力版本，取消后不调用提交工具", async (t) => {
  let submitCalls = 0, invalidate = true, started!:()=>void, release;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  const { agents, executions } = await fixture(t, async (record) => {
    if (invalidate) agents.config.llmConfigured = false;
    else { started(); await new Promise((resolve) => { release = resolve; }); }
    await record.tools.submit_group_route!.execute("route", {});
  });
  const capabilityVersion = (await agents.capabilityCards({ agentIds: ["a"] })).agents![0]!.capabilityVersion;
  const customTools = routingTools(async () => { submitCalls++; return { content: [], details: {}, terminate: true }; });
  await assert.rejects(agents.executeCollaboration(routingRound(undefined, { capabilityVersion, customTools })), /能力或连接配置已改变/);
  assert.equal(submitCalls, 0);
  agents.config.llmConfigured = true; invalidate = false;
  const controller = new AbortController();
  const running = agents.executeCollaboration(routingRound("cancel-routing-session-12345", { customTools }), undefined, { signal: controller.signal });
  const rejected = assert.rejects(running, (error: TestFailure) => error.diagnostic?.reason === "cancelled");
  await waiting; controller.abort(); release!(); await rejected;
  assert.equal(submitCalls, 0);
  assert.equal(executions().every((record) => record.disposed), true);
  assert.equal(agents.scheduler.snapshot().running, 0);
  assert.equal((await agents.activitySnapshot()).activities!.find((item) => item.sessionId === "cancel-routing-session-12345")!.status, "cancelled");
});

test("群业务文件工具与专用程序仅使用当前群/任务子目录，无法读取私人和其他群文件", async (t) => {
  const { agents, executions } = await fixture(t, async (record) => {
    await record.tools.write_workspace_file!.execute("file", { file: "result.txt", content: "本任务产物" });
    await assert.rejects(record.tools.read_workspace_file!.execute("private", { file: "private.txt" }), /没有找到/);
    await assert.rejects(record.tools.read_workspace_file!.execute("escape", { file: "../../../../private.txt" }), /目录外部/);
  });
  const privateRoot = await agents.workspace("a");
  await writeFile(join(privateRoot, "private.txt"), "PRIVATE_FILE_FIXTURE");
  await agents.executeCollaboration(round());
  const firstRoot = join(privateRoot, "group-tasks/group-one/task-one/a");
  assert.equal(executions()[0]!.options.cwd, firstRoot);
  assert.equal(await readFile(join(firstRoot, "result.txt"), "utf8"), "本任务产物");
  assert.equal(await readFile(join(privateRoot, "private.txt"), "utf8"), "PRIVATE_FILE_FIXTURE");
  await agents.executeCollaboration(round("a", "other-group-session-12345", { scope: { groupId: "group-two", taskId: "task-one" },
    message: "长平台材料".repeat(3000) }));
  const secondRoot = join(privateRoot, "group-tasks/group-two/task-one/a");
  assert.equal(executions()[1]!.options.cwd, secondRoot); assert.notEqual(firstRoot, secondRoot);
  let workflowRoot;
  callFixture(agents.agents.set,agents.agents,["a",{...agents.agents.get("a")!,execution:{kind:"node-json"}}]);
  agents.approvedDefinition = () => true;
  agents.developedTools = async (_agent, root) => { workflowRoot = root; return []; };
  await agents.executeCollaboration(round("a", "developed-group-session-12345"));
  assert.equal(workflowRoot, firstRoot);
});

test("协作不接受未就绪/错误版本、工具覆盖、超过次数，执行工具时重新核实版本", async (t) => {
  let changeVersion = false;
  const { agents } = await fixture(t, async (record, _session, emit) => {
    if (record.prompts[0]!.includes("超过轮次")) { emit({ type: "turn_end" }); emit({ type: "turn_start" }); return; }
    if (changeVersion) {
      agents.agents.set("a", { ...agents.agents.get("a")!, revision: 2 });
      await record.tools.write_workspace_file!.execute("write", { file: "blocked.txt", content: "不能保存" });
    }
  });
  await assert.rejects(agents.executeCollaboration(round("a", undefined, { revision: 2 })), /定义已改变/);
  await assert.rejects(agents.executeCollaboration(round("a", undefined, { customTools: [{ name: "read_material", execute: async () => ({}) }] })), /权限冲突/);
  await assert.rejects(agents.executeCollaboration(round("a", undefined, { maxTurns: 1, message: "超过轮次" })), (error: TestFailure) => error.diagnostic?.reason === "turn_limit");
  changeVersion = true;
  await assert.rejects(agents.executeCollaboration(round()), /定义已改变/);
});

test("私聊与群共用同 Agent 队列，全局两个执行，排队取消不创建模型会话", async (t) => {
  const started = new Map();
  const { agents, executions } = await fixture(t, async (record) => {
    if (record.prompts![0]!.includes("保持等待")) {
      started.set(record.options!.cwd.split("/agents/").at(-1)!.split("/")[0], record);
      await new Promise<void>((resolve) => { record.release = resolve; });
    }
  });
  await agents.build(input("b")); await agents.build(input("c"));
  const a = agents.prompt({ agentId: "a", sessionId: "private-wait-session-12345", message: "保持等待" });
  const b = agents.executeCollaboration(round("b", "group-wait-session-12345", { message: "保持等待" }));
  while (started.size < 2) await tick();
  const controller = new AbortController();
  const waiting = agents.executeCollaboration(round("a", "queued-cancel-session-12345"), undefined, { signal: controller.signal });
  const rejected = assert.rejects(waiting, (error: TestFailure) => error.diagnostic?.reason === "cancelled");
  const c = agents.executeCollaboration(round("c", "queued-other-session-12345"));
  await tick(); assert.equal(executions().length, 2);
  controller.abort(); await rejected;
  started.get("b").release(); await b; await c;
  assert.equal(executions().length, 3);
  started.get("a").release(); await a;
  assert.equal((await agents.activitySnapshot()).activities.some((item) => item.sessionId === "queued-cancel-session-12345" && item.status === "cancelled"), true);
});

test("能力卡包含未生成成员而不泄露指令/记忆，活动摘要清理并在重启标中断", async (t) => {
  const { agents, options } = await fixture(t);
  await agents.setMemory("a", "PRIVATE_MEMORY_FIXTURE");
  const profile = { name: "成员 a", description: "公开能力简介", icon: "star:4:1" };
  await agents.setProfile("a", profile);
  await agents.saveRequirements("pending", input("pending", "等待开发"));
  const cards = (await agents.capabilityCards()).agents;
  assert.equal(cards.find!((item) => item.id === "pending")!.ready, false);
  assert.equal(cards.find!((item) => item.id === "pending")!.revision, null);
  assert.equal(cards.find!((item) => item.id === "a")!.ready, true);
  assert.deepEqual(cards.find!((item) => item.id === "a")!.profile, { icon: profile.icon });
  assert.doesNotMatch(JSON.stringify(cards), /PRIVATE_MEMORY_FIXTURE|instructions|architectureRef/);
  cards.find!((item) => item.id === "a")!.profile.icon = "star:0:0";
  assert.deepEqual((await agents.get("a"))!.profile!, profile);
  await agents.setProfile("a", { ...profile, icon: "star:2:6" });
  assert.deepEqual((await agents.capabilityCards()).agents!.find((item) => item.id === "a")!.profile, { icon: "star:2:6" });
  const pending = await agents.activities.start({ agentId: "a", sessionId: "interrupted-session-12345", revision: 1,
    scope: { groupId: "group-one", taskId: "task-one" }, message: 'Bearer private-fixture api_key="private-fixture"' });
  assert.doesNotMatch(pending.summary, /private-fixture/);
  const restored = new ActivityStore({ storage: agents.storage });
  const snapshot = await restored.snapshot();
  assert.equal(snapshot.activities!.find((item) => item.id === pending.id)!.status, "interrupted");
  const file = JSON.parse(String(await readFile(join(options.dataDir, "agents/a/activities.json"), "utf8")));
  assert.equal(file.schemaVersion, 1); assert.equal(file.activities[0].status, "interrupted");
});

test("能力卡按成员投影，无模型会话、联网探测或任务目录创建，连接健康不改变能力身份", async (t) => {
  const { agents, options, records } = await fixture(t);
  await agents.saveRequirements("pending", input("pending", "等待开发"));
  const count = records.length, calls: ((string))[] = [], original = agents.connections.list.bind(agents.connections);
  agents.connections.list = async (id, ...args) => { calls.push(id); return original(id, ...args); };
  const snapshot = (await agents.capabilityCards({ agentIds: ["a"] })).agents;
  assert.deepEqual(snapshot.map((item) => item.id), ["a"]);
  assert.deepEqual(calls, ["a"]);
  assert.equal(records.length, count);
  await assert.rejects(lstat(join(options.dataDir, "agents/a/workspace")), { code: "ENOENT" });
  await assert.rejects(lstat(join(options.dataDir, "agents/pending/private")), { code: "ENOENT" });
  await agents.connections.save("a", { id: "model", kind: "model", provider: "openai-compatible", authType: "none",
    baseUrl: "https://private-fixture.invalid", model: "PRIVATE_MODEL_FIXTURE" });
  const configured = (await agents.capabilityCards({ agentIds: ["a"] })).agents[0];
  assert.notEqual(configured!.capabilityVersion!, snapshot[0]!.capabilityVersion);
  assert.doesNotMatch(JSON.stringify(configured), /PRIVATE_MODEL_FIXTURE|private-fixture|baseUrl|provider|modelAuthType/);
  await agents.connections.recordResult(await agents.connections.snapshot("a"), "model", false, "PRIVATE_DIAGNOSTIC_FIXTURE");
  const failed = (await agents.capabilityCards({ agentIds: ["a"] })).agents[0];
  assert.equal(failed!.capabilityVersion!, configured!.capabilityVersion!);
  assert.equal(failed!.capabilities!.find((item) => item.id === "conversation")!.availability, "callable");
  assert.equal(failed!.capabilities!.find((item) => item.id === "conversation")!.verification.status, "last_call_failed");
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_DIAGNOSTIC_FIXTURE/);
  assert.equal(records.length, count);
});

test("当前应用交付无法核对时公开卡不借旧 ready 声称群业务可执行，错误原文不公开", async (t) => {
  const { agents } = await fixture(t);
  callFixture(agents.agents.set,agents.agents,["a",{...agents.agents.get("a")!,execution:{kind:"node-action"}}]);
  agents.approvedDefinition = () => true;
  agents.applications.descriptor = async () => { throw new Error("PRIVATE_DELIVERY_DIAGNOSTIC_FIXTURE"); };
  const card = (await agents.capabilityCards({ agentIds: ["a"] })).agents[0];
  assert.equal(card!.ready!, false);
  assert.equal(card!.capabilities!.every((item) => item.availability === "unavailable"), true);
  assert.doesNotMatch(JSON.stringify(card), /PRIVATE_DELIVERY_DIAGNOSTIC_FIXTURE/);
});

test("默认模型关闭和服务重载改变公开能力身份，定义与已保存产物保留，专属模型身份不受影响", async (t) => {
  const { agents, options, records } = await fixture(t);
  const definitionPath = join(options.dataDir, "agents/a/definition.json"), definition = await readFile(definitionPath, "utf8");
  const file = join(await agents.workspace("a"), "saved-result.txt");
  await writeFile(file, "已保存成果");
  const initial = (await agents.capabilityCards({ agentIds: ["a"] })).agents[0], count = records.length;
  await agents.close();
  const closed = (await agents.capabilityCards({ agentIds: ["a"] })).agents[0];
  assert.notEqual(closed!.capabilityVersion!, initial!.capabilityVersion!);
  assert.equal(closed!.revision!, initial!.revision!);
  assert.equal(closed!.ready!, true);
  await assert.rejects(agents.executeCollaboration(round("a", "old-default-model-session-12345", {
    capabilityVersion: initial!.capabilityVersion! })), (error: TestFailure) => error.reason === "capability_changed");
  const restored = new PrototypeAgents(options);
  try {
    const restarted = (await restored.capabilityCards({ agentIds: ["a"] })).agents[0];
    assert.notEqual(restarted!.capabilityVersion!, closed!.capabilityVersion!);
    assert.equal(restarted!.revision!, initial!.revision!);
    assert.equal(restarted!.ready!, true);
  } finally { await restored.close(); }
  await agents.connections.save("a", { id: "model", kind: "model", authType: "none",
    baseUrl: "https://private-fixture.invalid", model: "PRIVATE_MODEL_FIXTURE" });
  const dedicated = (await agents.capabilityCards({ agentIds: ["a"] })).agents[0];
  await agents.close();
  assert.equal((await agents.capabilityCards({ agentIds: ["a"] })).agents![0]!.capabilityVersion, dedicated!.capabilityVersion!);
  const dedicatedRestored = new PrototypeAgents(options);
  try {
    assert.equal((await dedicatedRestored.capabilityCards({ agentIds: ["a"] })).agents![0]!.capabilityVersion, dedicated!.capabilityVersion!);
  } finally { await dedicatedRestored.close(); }
  assert.equal(await readFile(definitionPath, "utf8"), definition);
  assert.equal(await readFile(file, "utf8"), "已保存成果");
  assert.equal(records.length, count);
  assert.doesNotMatch(JSON.stringify(closed), new RegExp(agents.modelCapabilityInstance));
});

test("群执行绑定能力版本，配置变化阻止后续工具并保留已经写入的成果", async (t) => {
  const { agents, options, executions } = await fixture(t, async (record) => {
    await record.tools.write_workspace_file!.execute("first", { file: "prior.txt", content: "变化前已完成的成果" });
    agents.config.llmConfigured = false;
    await record.tools.write_workspace_file!.execute("second", { file: "blocked.txt", content: "不能写入" });
  });
  const capabilityVersion = (await agents.capabilityCards({ agentIds: ["a"] })).agents![0]!.capabilityVersion;
  await assert.rejects(agents.executeCollaboration(round("a", "changed-capability-session-12345", { capabilityVersion })), /能力或连接配置已改变/);
  const root = join(options.dataDir, "agents/a/workspace/group-tasks/group-one/task-one/a");
  assert.equal(await readFile(join(root, "prior.txt"), "utf8"), "变化前已完成的成果");
  await assert.rejects(lstat(join(root, "blocked.txt")), { code: "ENOENT" });
  assert.equal(executions()[0]!.disposed, true);
  const count = executions().length;
  await assert.rejects(agents.executeCollaboration(round("a", "stale-capability-session-12345", { capabilityVersion })), /能力或连接配置已改变/);
  assert.equal(executions().length, count);
  assert.equal(agents.scheduler.snapshot().running, 0);
});

test("群联网权限来自可信任务政策，其他成员能力卡文本不能误禁联网或绕过自身限制", async (t) => {
  const policies: ((boolean))[] = [];
  const { agents } = await fixture(t, async (record) => { await record.tools.web_search!.execute("search", { query: "群任务公开资料" }); });
  agents.web.search = async (_input, options) => { policies.push(options!.allowNetwork!); return { status: "fixture" }; };
  await agents.executeCollaboration(round("a", "other-policy-session-12345", { taskAllowNetwork: true,
    message: JSON.stringify({ task: "搜索公开资料", members: [{ id: "offline-agent", boundaries: ["禁止联网"] }] }) }));
  await agents.executeCollaboration(round("a", "user-policy-session-12345", { taskAllowNetwork: false, message: "请处理群任务资料" }));
  await agents.build(input("a", "仅使用离线材料整理信息"));
  await agents.executeCollaboration(round("a", "own-policy-session-12345", { revision: 2, taskAllowNetwork: true, message: "群任务资料" }));
  assert.deepEqual(policies, [true, false, false]);
  await assert.rejects(agents.executeCollaboration(round("a", "invalid-policy-session-12345", { revision: 2, taskAllowNetwork: "true" })), /参数无效/);
});

test("主 Agent 委派来源只接可信调用参数，普通请求正文不能注入且记录可恢复", async (t) => {
  const { agents } = await fixture(t);
  await agents.prompt({ agentId: "a", sessionId: "main-delegation-session-12345", message: "处理明确委派" }, undefined,
    { activityScope: { kind: "main", conversationId: "main-conversation-one" } });
  await agents.prompt({ agentId: "a", sessionId: "private-normal-session-12345", message: "正常私聊",
    activityScope: { kind: "main", conversationId: "spoofed-main" }, source: { kind: "main", conversationId: "spoofed-main" } });
  const snapshot = (await agents.activitySnapshot()).activities;
  assert.deepEqual(snapshot.find!((value) => value.sessionId === "main-delegation-session-12345")!.scope,
    { kind: "main", conversationId: "main-conversation-one" });
  assert.deepEqual(snapshot.find!((value) => value.sessionId === "private-normal-session-12345")!.scope,
    { kind: "private", sessionId: "private-normal-session-12345" });
  const restored = await new ActivityStore({ storage: agents.storage }).snapshot();
  assert.equal(objectFields(restored.activities!.find((value) => objectFields(value.scope).kind === "main")!.scope).conversationId, "main-conversation-one");
  for (const activityScope of [{ kind: "main", conversationId: "../outside" }, { kind: "main", conversationId: "valid", arbitrary: "must-not-save" },
    { kind: "group", groupId: "other-group" }]) await assert.rejects(callFixture(agents.prompt, agents, [{ agentId: "a", sessionId: "invalid-source-session-12345", message: "不能执行" }, undefined, { activityScope }]));
});

test("构建与移除开始通知监听器，移除会取消群执行和队列", async (t) => {
  let started!:()=>void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const { agents } = await fixture(t, async (record) => { started(); await new Promise<void>((resolve) => { record.release = resolve; }); });
  const events: ({ "type": (string); "agentId": (string); })[] = [], stop = agents.onLifecycle((event) => { events.push(event); });
  await agents.build(input("b"));
  assert.deepEqual(events[0], { type: "build", agentId: "b" });
  const running = agents.executeCollaboration(round());
  const failed = assert.rejects(running, (error: TestFailure) => error.diagnostic?.reason === "cancelled");
  await ready;
  const queued = agents.executeCollaboration(round("a", "remove-queued-session-12345"));
  const queueFailed = assert.rejects(queued, (error: TestFailure) => error.diagnostic?.reason === "cancelled");
  await tick(); await agents.remove("a"); await Promise.all([failed, queueFailed]);
  assert.equal(events.some((event) => event.type === "remove" && event.agentId === "a"), true);
  stop();
  assert.equal(agents.scheduler.snapshot().running, 0);
});

test("活动保留最近200条，原子保存失败不发布内存状态", async () => {
  let published, fail = false;
  const store = new ActivityStore({ storage: { readJson:async()=>null,agentIds: async () => [], async writeJson(_id, _file, value) {
    if (fail) throw new Error("fixture-storage-failure");
    published = structuredClone(value);
  } } });
  for (let index = 0; index < 201; index++) {
    const record = await store.start({ agentId: "a", sessionId: `session-${index}`, revision: 1,
      scope: { kind: "private", sessionId: `session-${index}` }, message: `任务 ${index}` });
    await store.update("a", record.id, { status: "complete" });
  }
  assert.equal((await store.snapshot()).activities.length, 200); assert.equal(published!.activities!.length, 200);
  fail = true;
  await assert.rejects(store.start({ agentId: "a", sessionId: "failed-save", revision: 1,
    scope: { kind: "private", sessionId: "failed-save" }, message: "不能发布" }));
  assert.equal((await store.snapshot()).activities.some((item) => item.sessionId === "failed-save"), false);
});

test("真实 Pi 群工具终止无额外回执，上限阻止第二个模型请求", async (t) => {
  const { agents } = await fixture(t);
  let requests = 0;
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(String(Buffer.concat(chunks))); requests++;
    assert.deepEqual(body.tools.map((tool: { function: { name: unknown; }; }) => tool.function.name), ["claim_work"]);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: { role?: string; tool_calls?: { index: number; id: string; type: string; function: { name: string; arguments: string; }; }[]; }, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1,
      model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${requests}`, type: "function", function: { name: "claim_work", arguments: "{}" } }] });
    chunk({}, "tool_calls"); response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve, reject) => { model.once("error", reject); model.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise<void>((resolve, reject) => model.close(error => error ? reject(error) : resolve())));
  Object.assign(agents.config, { chatUrl: `http://127.0.0.1:${listeningAddress(model).port}/v1/chat/completions`, model: "fixture-model", apiKey: "fixture-only" });
  agents.sessionFactory = createPiSession;
  const tool = (terminate: boolean) => ({ name: "claim_work", label: "认领任务", description: "提交认领", parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: "text", text: "accepted" }], details: {}, ...(terminate ? { terminate: true } : {}) }) });
  assert.deepEqual(await agents.executeCollaboration(round("a", "real-claim-session-12345", {
    allowBusinessTools: false, maxTurns: 1, customTools: [tool(true)] })), { reply: "", turns: 1 });
  assert.equal(requests, 1);
  await assert.rejects(agents.executeCollaboration(round("a", "real-limit-session-12345", {
    allowBusinessTools: false, maxTurns: 1, customTools: [tool(false)] })), (error: TestFailure) => error.diagnostic?.reason === "turn_limit");
  assert.equal(requests, 2, "两个群轮次各发一个请求，上限不允许自动发第二次请求");
  assert.equal(agents.scheduler.snapshot().running, 0);
});

test("真实 Pi 平台寻址请求仅包含中立系统身份与两个只读决策工具", async (t) => {
  const { agents } = await fixture(t), requests: FixtureModelRequest[] = [];
  await agents.setMemory("a", "PRIVATE_MEMORY_FIXTURE");
  await agents.setProfile("a", { name: "PRIVATE_AGENT_NAME_FIXTURE", description: "公开简介", icon: "star:0:0" });
  agents.agents.set("a", { ...agents.agents.get("a")!, instructions: "PRIVATE_AGENT_INSTRUCTIONS_FIXTURE" });
  agents.approvedDefinition = () => true;
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(String(Buffer.concat(chunks))));
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: { role?: string; tool_calls?: { index: number; id: string; type: string; function: { name: string; arguments: string; }; }[]; }, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({ id: "routing-fixture", object: "chat.completion.chunk", created: 1,
      model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: "assistant", tool_calls: [{ index: 0, id: "route", type: "function", function: { name: "submit_group_route", arguments: "{}" } }] });
    chunk({}, "tool_calls"); response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve, reject) => { model.once("error", reject); model.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise<void>((resolve, reject) => model.close(error => error ? reject(error) : resolve())));
  Object.assign(agents.config, { chatUrl: `http://127.0.0.1:${listeningAddress(model).port}/v1/chat/completions`, model: "fixture-model", apiKey: "fixture-only" });
  agents.sessionFactory = createPiSession;
  assert.deepEqual(await agents.executeCollaboration(routingRound("real-routing-session-12345", { maxTurns: 1 })), { reply: "", turns: 1 });
  assert.equal(requests.length, 1, "寻址提交后不再请求模型生成成员回执");
  assert.deepEqual(recordArray(objectFields(requests[0]).tools).map((tool) => objectFields(tool.function).name), ["read_group_turn_context", "submit_group_route"]);
  assert.match(JSON.stringify(objectFields(requests[0]).messages), /中立群消息寻址器|group-routing/);
  assert.doesNotMatch(JSON.stringify(objectFields(requests[0]).messages), /PRIVATE_AGENT_NAME_FIXTURE|PRIVATE_AGENT_INSTRUCTIONS_FIXTURE|PRIVATE_MEMORY_FIXTURE|Agent 工作指令|你是 NEUMA 的群成员|web_search|list_materials/);
  assert.equal(agents.scheduler.snapshot().running, 0);
});
