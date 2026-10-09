import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PrototypeAgents } from "../agent-prototype.mjs";
import { PiProjectAgent } from "../pi-runtime.mjs";
import { ProviderError } from "../core.mjs";

const turn = { agentId: "alpha", sessionId: "shutdown-session-12345", message: "处理当前任务" };
const cancelled = (error) => error instanceof ProviderError && error.diagnostic.reason === "cancelled";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function sessionFixture({ prompt = async () => {}, abort = async () => {} } = {}) {
  const calls = { prompts: 0, aborts: 0, disposals: 0 };
  return { calls, session: { messages: [], subscribe: () => () => {}, getLastAssistantText: () => "完成",
    async prompt() { calls.prompts++; await prompt(); },
    async abort() { calls.aborts++; await abort(); },
    dispose() { calls.disposals++; } } };
}

async function agentFixture(t, sessionFactory) {
  const root = await mkdtemp(join(tmpdir(), "neuma-session-shutdown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Exercise the real prompt and close methods without model construction or storage recovery.
  const agents = Object.assign(Object.create(PrototypeAgents.prototype), {
    config: { llmConfigured: true }, ready: Promise.resolve(), closing: null,
    agents: new Map([["alpha", { id: "alpha", name: "助手", revision: 1, instructions: "处理材料",
      draft: { goal: { value: "处理材料" } }, toolIds: [] }]]),
    sessions: new Map(), removing: new Set(), builds: new Map(),
    configured() {}, prune() {}, approvedDefinition: () => true,
    getArchitecture: async () => ({ delivery: "ready" }), workspace: async () => root,
    storage: { directory: async () => root }, development: { close: async () => {} }, sessionFactory,
  });
  return agents;
}

for (const boundary of ["ready", "closing", "architecture", "workspace", "storage", "factory"]) {
  test(`Agent 外部取消发生在 ${boundary} 等待期间不会启动模型或遗留晚到会话`, { timeout: 5000 }, async (t) => {
    const held = deferred(), entered = deferred(), fixture = sessionFixture();
    let factories = 0;
    const agents = await agentFixture(t, async () => { factories++; return fixture.session; });
    const awaitedRoot = await agents.storage.directory();
    const delayed = async (value) => { entered.resolve(); await held.promise; return value; };
    if (boundary === "ready" || boundary === "closing") {
      Object.defineProperty(agents, boundary, { configurable: true, get() { entered.resolve(); return held.promise; } });
    } else if (boundary === "architecture") agents.getArchitecture = () => delayed({ delivery: "ready" });
    else if (boundary === "workspace") agents.workspace = () => delayed(awaitedRoot);
    else if (boundary === "storage") agents.storage.directory = () => delayed(awaitedRoot);
    else agents.sessionFactory = async () => { factories++; return delayed(fixture.session); };
    const controller = new AbortController();
    const pending = agents.prompt(turn, undefined, { signal: controller.signal });
    const rejected = assert.rejects(pending, cancelled);
    await entered.promise;
    // In the architecture race, close takes its session snapshot before prompt registers one.
    if (boundary === "architecture") await agents.close();
    controller.abort(); held.resolve(); await rejected;
    assert.equal(fixture.calls.prompts, 0); assert.equal(agents.sessions.size, 0);
    assert.equal(factories, boundary === "factory" ? 1 : 0);
    assert.equal(fixture.calls.aborts, boundary === "factory" ? 1 : 0);
    assert.equal(fixture.calls.disposals, boundary === "factory" ? 1 : 0);
  });
}

test("Agent 正在运行时外部取消中止对应会话，其他会话保留", { timeout: 5000 }, async (t) => {
  const held = deferred(), entered = deferred();
  const fixture = sessionFixture({ prompt: async () => { entered.resolve(); await held.promise; }, abort: async () => held.resolve() });
  const agents = await agentFixture(t, async () => fixture.session), other = sessionFixture();
  agents.sessions.set("other-session-12345", { agentId: "alpha", revision: 1, session: other.session, busy: false, usedAt: Date.now() });
  const controller = new AbortController(), pending = agents.prompt(turn, undefined, { signal: controller.signal });
  const rejected = assert.rejects(pending, cancelled);
  await entered.promise; controller.abort(); await rejected;
  assert.equal(fixture.calls.aborts, 1); assert.equal(fixture.calls.disposals, 1);
  assert.equal(agents.sessions.get("other-session-12345").session, other.session);
  assert.deepEqual(other.calls, { prompts: 0, aborts: 0, disposals: 0 });
  await agents.close();
});

test("Agent 已结束请求的取消信号不会影响可复用的会话", async (t) => {
  const fixture = sessionFixture(), agents = await agentFixture(t, async () => fixture.session);
  const controller = new AbortController();
  await agents.prompt(turn, undefined, { signal: controller.signal }); controller.abort();
  assert.equal(fixture.calls.aborts, 0); assert.equal(agents.sessions.get(turn.sessionId).cancelled, false);
  await agents.prompt(turn); assert.equal(fixture.calls.prompts, 2);
  await agents.close();
});

test("项目助手取消延迟创建的旧会话不会取消重置后同名的新会话", { timeout: 5000 }, async () => {
  const held = deferred(), entered = deferred(), old = sessionFixture(), current = sessionFixture();
  let factories = 0;
  const agent = new PiProjectAgent({ config: { llmConfigured: true }, manager: { list: async () => [] },
    sessionFactory: async () => { if (++factories === 1) { entered.resolve(); await held.promise; return old.session; } return current.session; } });
  const controller = new AbortController();
  const pending = agent.prompt(turn, undefined, { signal: controller.signal }), rejected = assert.rejects(pending, cancelled);
  await entered.promise; controller.abort(); await agent.dispose();
  await agent.prompt(turn); held.resolve(); await rejected;
  assert.deepEqual(old.calls, { prompts: 0, aborts: 1, disposals: 1 });
  assert.deepEqual(current.calls, { prompts: 1, aborts: 0, disposals: 0 });
  assert.equal(agent.sessions.get(turn.sessionId).session, current.session);
  await agent.dispose();
});

test("项目助手等待模型时外部取消中止会话并清理，其他会话不受影响", { timeout: 5000 }, async () => {
  const held = deferred(), entered = deferred(), other = sessionFixture();
  const fixture = sessionFixture({ prompt: async () => { entered.resolve(); await held.promise; }, abort: async () => held.resolve() });
  const agent = new PiProjectAgent({ config: { llmConfigured: true }, manager: { list: async () => [] }, sessionFactory: async () => fixture.session });
  agent.sessions.set("other-session-12345", { session: other.session, busy: false, usedAt: Date.now(), turn: {} });
  const controller = new AbortController();
  const rejected = assert.rejects(agent.prompt(turn, undefined, { signal: controller.signal }), cancelled);
  await entered.promise; controller.abort(); await rejected;
  assert.deepEqual(fixture.calls, { prompts: 1, aborts: 1, disposals: 1 });
  assert.deepEqual(other.calls, { prompts: 0, aborts: 0, disposals: 0 });
  await agent.dispose();
});

test("项目助手在项目列表等待期间取消不会返回完成结果", { timeout: 5000 }, async () => {
  const held = deferred(), entered = deferred(), fixture = sessionFixture();
  const agent = new PiProjectAgent({ config: { llmConfigured: true },
    manager: { list: async () => { entered.resolve(); await held.promise; return []; } }, sessionFactory: async () => fixture.session });
  const controller = new AbortController(), rejected = assert.rejects(agent.prompt(turn, undefined, { signal: controller.signal }), cancelled);
  await entered.promise; controller.abort(); held.resolve(); await rejected;
  assert.equal(fixture.calls.aborts, 1); assert.equal(fixture.calls.disposals, 1); assert.equal(agent.sessions.size, 0);
});

test("项目助手已结束请求的信号不会影响会话复用，预取消不会创建会话", async () => {
  const fixture = sessionFixture();
  const agent = new PiProjectAgent({ config: { llmConfigured: true }, manager: { list: async () => [] }, sessionFactory: async () => fixture.session });
  const controller = new AbortController();
  await agent.prompt(turn, undefined, { signal: controller.signal }); controller.abort();
  assert.equal(fixture.calls.aborts, 0); await agent.prompt(turn); assert.equal(fixture.calls.prompts, 2);
  await assert.rejects(agent.prompt({ ...turn, sessionId: "cancelled-session-12345" }, undefined, { signal: controller.signal }), cancelled);
  assert.equal(agent.sessions.has("cancelled-session-12345"), false);
  await agent.dispose();
});
