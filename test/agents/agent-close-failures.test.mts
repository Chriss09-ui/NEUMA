import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PrototypeAgents } from "../../src/agents/agent-prototype.mjs";
import { AgentScheduler } from "../../src/runtime/agent-scheduler.mjs";

// R6 生命周期审计：PrototypeAgents.close 的组合清理在并发、重复与组件失败下的行为。
// 夹具只替换 close() 实际触达的字段，不启动模型或进程。

function sessionDouble({ dispose = () => {} }: { dispose?: () => void } = {}) {
  const calls = { aborts: 0, disposals: 0 };
  return { calls, session: { messages: [], subscribe: () => () => {}, getLastAssistantText: () => "",
    async abort() { calls.aborts++; }, dispose() { calls.disposals++; dispose(); } } };
}

function sessionEntry(double: ReturnType<typeof sessionDouble>, { busy = false } = {}) {
  return { agentId: "alpha", revision: 1, session: double.session, busy, usedAt: Date.now(),
    controller: new AbortController(), done: Promise.resolve(), cancelled: false };
}

async function fixture(t: test.TestContext, overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-close-failures-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = { applications: 0, materials: 0, development: 0, services: 0, persistence: 0 };
  const base = {
    closing: null, runtimeEpoch: 0, builds: new Map(), sessions: new Map(), collaborationSessions: new Map(),
    scheduler: new AgentScheduler(),
    activities: { persistence: Promise.resolve().then(() => { records.persistence++; }) },
    applications: { close: async () => { records.applications++; } },
    materials: { close: async () => { records.materials++; } },
    development: { close: async () => { records.development++; } },
    services: { close: async () => { records.services++; } },
  };
  return { agents: Object.assign(Object.create(PrototypeAgents.prototype), base, overrides), records, root };
}

test("并发关闭共享同一次清理，不重复释放会话或组件", async (t) => {
  const { agents, records } = await fixture(t);
  const first = sessionDouble(), second = sessionDouble();
  agents.sessions.set("session-a", sessionEntry(first));
  agents.sessions.set("session-b", sessionEntry(second));
  const closing = agents.close(), concurrent = agents.close();
  assert.equal(concurrent, closing);
  await Promise.all([closing, concurrent]);
  assert.equal(first.calls.disposals, 1); assert.equal(second.calls.disposals, 1);
  assert.equal(first.calls.aborts, 1); assert.equal(second.calls.aborts, 1);
  assert.equal(records.applications, 1); assert.equal(records.materials, 1); assert.equal(records.development, 1);
  // services 按设计停两次：先随运行时停止，会话排空后再停一次
  assert.equal(records.services, 2);
  assert.equal(records.persistence, 1);
  assert.equal(agents.sessions.size, 0);
});

test("成功关闭后再次关闭保持幂等，不抛错也不复活状态", async (t) => {
  const { agents } = await fixture(t);
  const double = sessionDouble();
  agents.sessions.set("session-a", sessionEntry(double));
  await agents.close();
  await agents.close();
  assert.equal(double.calls.disposals, 1);
  assert.equal(agents.sessions.size, 0);
});
