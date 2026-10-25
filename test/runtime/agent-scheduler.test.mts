import test from "node:test";
import assert from "node:assert/strict";
import { AgentScheduler } from "../../src/runtime/agent-scheduler.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("调度器最多两个活动 Agent，同 Agent 等待不占全局槽", async () => {
  const scheduler = new AgentScheduler();
  const first = await scheduler.acquire({ agentId: "a" });
  let secondStarted = false, fourthStarted = false;
  const second = scheduler.acquire({ agentId: "a" }).then((lease) => { secondStarted = true; return lease; });
  const third = await scheduler.acquire({ agentId: "b" });
  const fourth = scheduler.acquire({ agentId: "c" }).then((lease) => { fourthStarted = true; return lease; });
  await tick();
  assert.equal(secondStarted, false); assert.equal(fourthStarted, false);
  assert.deepEqual(scheduler.snapshot(), { running: 2, queued: 2, agentIds: ["a", "b"] });
  third.release();
  const fourthLease = await fourth;
  assert.equal(secondStarted, false);
  first.release();
  const secondLease = await second;
  first.release();
  assert.equal(scheduler.snapshot().running, 2);
  secondLease.release(); fourthLease.release();
  assert.equal(scheduler.snapshot().running, 0);
});

test("取消排队任务不执行，活动取消必须释放后才让同 Agent 下一项开始", async () => {
  const scheduler = new AgentScheduler(), queuedController = new AbortController();
  const first = await scheduler.acquire({ agentId: "a" });
  const queued = scheduler.acquire({ agentId: "a", signal: queuedController.signal });
  const rejected = assert.rejects(queued, { name: "AbortError" });
  queuedController.abort(); await rejected;
  assert.equal(scheduler.snapshot().queued, 0);
  const next = scheduler.acquire({ agentId: "a" });
  scheduler.cancelAgent("a");
  await assert.rejects(next, { name: "AbortError" });
  assert.equal(first.signal.aborted, true);
  assert.equal(scheduler.snapshot().running, 1);
  first.release();
  const restored = await scheduler.acquire({ agentId: "a" });
  restored.release();
});

test("关闭排空所有排队项并中止执行，之后仍可复用调度器", async () => {
  const scheduler = new AgentScheduler();
  const first = await scheduler.acquire({ agentId: "a" }), second = await scheduler.acquire({ agentId: "b" });
  const queued = [scheduler.acquire({ agentId: "a" }), scheduler.acquire({ agentId: "c" })];
  const failures = queued.map((promise) => assert.rejects(promise, { name: "AbortError" }));
  scheduler.cancelAll(); await Promise.all(failures);
  assert.equal(first.signal.aborted, true); assert.equal(second.signal.aborted, true);
  first.release(); second.release();
  assert.deepEqual(scheduler.snapshot(), { running: 0, queued: 0, agentIds: [] });
  const third = await scheduler.acquire({ agentId: "c" }); third.release();
});
