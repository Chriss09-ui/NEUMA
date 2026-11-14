import test from "node:test";
import assert from "node:assert/strict";
import { createRepairCheckpoint, runRepairSchedule, readReviewTaskCheckpoint, runReviewTaskSchedule, readRepairCheckpoint,
  readDevelopmentTaskCheckpoint, runDevelopmentTaskSchedule, createDevelopmentTaskCheckpoint } from "../../src/runtime/repair-scheduler.mjs";
import type { RepairIssue, RepairWorker } from "../../src/runtime/repair-scheduler.mjs";

const issue = (id: string, path: string, owner = id): RepairIssue => ({ id, paths: [path], owner, description: `修复${id}`, remedy: "保留原要求" });

test("无限请求调度在结果已提交后明确拒绝续请求，不误报额度也不增加用量", async () => {
  const base = { value: null }, binding = "submitted-result";
  let checkpoint = createDevelopmentTaskCheckpoint(binding, base, [issue("value", "/value")]);
  await runDevelopmentTaskSchedule({ checkpoint, binding, base, save: async value => { checkpoint = value; }, run: async worker => {
    await worker.onSession("result.jsonl"); await worker.onCall();
    await worker.submit({ baseHash: worker.baseHash, issueIds: worker.group.issueIds, summary: "有效结果", updates: [{ path: "/value", value: "done" }] });
    await assert.rejects(worker.onCall(), /已提交有效结果/);
  } });
  assert.equal(checkpoint.calls, 1); assert.equal(checkpoint.callLimit, null); assert.ok(checkpoint.groups[0]!.result);
});
async function submit(worker: RepairWorker, value: unknown) {
  await worker.onSession(worker.group.sessionFile ?? `${worker.group.id}.jsonl`); await worker.onCall();
  await worker.submit({ baseHash: worker.baseHash, issueIds: worker.group.issueIds, summary: "局部修改，等待独立验证",
    updates: [{ path: worker.group.paths[0]!, value }] });
}

test("研发升级真实旧调度停点，保存原额度与已完成组，原子累计超过旧请求上限", async () => {
  const base = { a: "old", b: "old" }, binding = "development-upgrade";
  let legacy = createRepairCheckpoint(binding, base, [issue("a", "/a"), issue("b", "/b")], 1, 2);
  await assert.rejects(runRepairSchedule({ checkpoint: legacy, binding, base, save: async value => { legacy = value; }, run: async worker => {
    if (worker.group.issueIds.includes("a")) return submit(worker, "done-a");
    await worker.onSession("b.jsonl"); await worker.onCall(); throw new Error("controlled interruption");
  } }), /controlled interruption/);
  const original = structuredClone(legacy);
  let current = readDevelopmentTaskCheckpoint(legacy);
  const groups: string[] = [];
  const result = await runDevelopmentTaskSchedule({ checkpoint: current, binding, base, save: async value => { current = value; }, run: async worker => {
    groups.push(worker.group.id); assert.equal(worker.group.sessionFile, "b.jsonl"); assert.equal(worker.group.calls, 1);
    for (let index = 0; index < 15; index++) await worker.onCall();
    await worker.submit({ baseHash: worker.baseHash, issueIds: worker.group.issueIds, summary: "沿原会话完成读取与修复", updates: [{ path: "/b", value: "done-b" }] });
  } });
  assert.deepEqual(result, { a: "done-a", b: "done-b" }); assert.deepEqual(groups, [original.groups[1]!.id]);
  assert.equal(current.calls, 17); assert.equal(current.callLimit, null); assert.equal(current.groupCallLimit, null);
  assert.deepEqual(current.previousQuota, original); assert.deepEqual(legacy, original);
  assert.deepEqual(current.groups[0], original.groups[0]); assert.deepEqual(readDevelopmentTaskCheckpoint(current), current);
});

test("十个独立问题动态分派，最多三个子Agent同时工作，全部补丁合并", async () => {
  const base = Object.fromEntries(Array.from({ length: 10 }, (_, n) => [`field${n}`, "before"]));
  const issues = Object.keys(base).map(key => issue(key, `/${key}`));
  let checkpoint = createRepairCheckpoint("batch", base, issues, 3), active = 0, maximum = 0;
  const output = await runRepairSchedule({ checkpoint, binding: "batch", base, save: async value => { checkpoint = value; },
    run: async worker => {
      active++; maximum = Math.max(maximum, active);
      await submit(worker, "after"); active--;
    } });
  assert.deepEqual(output, Object.fromEntries(Object.keys(base).map(key => [key, "after"])));
  assert.equal(maximum, 3); assert.equal(checkpoint.calls, 10);
  assert.equal(checkpoint.groups.filter(group => group.result).length, 10);
});

test("新版本可完整调度二百个独立问题，旧版本容量与预算保持不变", async () => {
  const base = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`field_${index}`, "old"]));
  const issues = Object.keys(base).map(key => issue(key, `/${key}`));
  assert.throws(() => createRepairCheckpoint("legacy", base, issues, 3), /问题或额度/);
  let checkpoint = createRepairCheckpoint("large", base, issues, 3, 2);
  const originalLimit = checkpoint.callLimit;
  const result = await runRepairSchedule({ checkpoint, binding: "large", base, save: async next => { checkpoint = next; },
    run: worker => submit(worker, "fixed") });
  assert.deepEqual(result, Object.fromEntries(Object.keys(base).map(key => [key, "fixed"])));
  assert.equal(checkpoint.calls, 200); assert.equal(checkpoint.callLimit, originalLimit);
  assert.equal(readRepairCheckpoint(checkpoint).groups.filter(group => group.result).length, 200);
  assert.equal(createRepairCheckpoint("legacy", base, issues.slice(0, 100), 3).callLimit, 120);
});

test("分项合法但合并超额时自动退回原组，在原额度内修正并保留旧提案", async () => {
  const base = { a: 1, b: 1 };
  let checkpoint = createRepairCheckpoint("combined", base, [issue("a", "/a"), issue("b", "/b")], 3, 2);
  const result = await runRepairSchedule({ checkpoint, binding: "combined", base, retryInvalidMerge: true,
    save: async value => { checkpoint = value; },
    validateCandidate: (value, final) => { const row = value as typeof base; if (final && row.a + row.b > 10) throw new Error("合计必须不超过10"); },
    run: worker => submit(worker, worker.group.history?.length ? 4 : 8) });
  assert.deepEqual(result, { a: 4, b: 4 }); assert.equal(checkpoint.calls, 4);
  assert.ok(checkpoint.groups.every(group => group.calls === 2 && group.history?.[0]?.result?.updates[0]?.value === 8));
});

test("同一模块十个问题分成有界子任务，重叠字段按已合并版本顺序修复", async () => {
  const base = { instructions: "原要求" }, issues = Array.from({ length: 10 }, (_, n) => issue(`i${n}`, "/instructions", "same"));
  let checkpoint = createRepairCheckpoint("batch", base, issues, 3);
  const assignments: string[][] = [];
  const output = await runRepairSchedule({ checkpoint, binding: "batch", base, save: async value => { checkpoint = value; },
    run: async worker => {
      assignments.push(worker.group.issueIds);
      await submit(worker, (worker.base as typeof base).instructions + ":" + worker.group.issueIds.join(","));
    } });
  assert.deepEqual(assignments.map(ids => ids.length), [3, 3, 3, 1]);
  assert.deepEqual(output, { instructions: "原要求:i0,i1,i2:i3,i4,i5:i6,i7,i8:i9" });
});

test("中断保留同层成功补丁，恢复仅继续失败子会话且累计额度不归零", async () => {
  const base = { a: "old", b: "old" }, issues = [issue("a", "/a"), issue("b", "/b")];
  let checkpoint = createRepairCheckpoint("batch", base, issues, 3);
  const options = { binding: "batch", base, save: async (value: typeof checkpoint) => { checkpoint = value; } };
  await assert.rejects(runRepairSchedule({ ...options, checkpoint, run: async worker => {
    if (worker.group.issueIds[0] === "a") return submit(worker, "new-a");
    await worker.onSession("b.jsonl"); await worker.onCall(); throw new Error("连接中断");
  } }), /连接中断/);
  assert.equal(checkpoint.calls, 2);
  const resumed: string[] = [];
  const output = await runRepairSchedule({ ...options, checkpoint: readRepairCheckpoint(JSON.parse(JSON.stringify(checkpoint))), run: async worker => {
    resumed.push(worker.group.issueIds[0]!); assert.equal(worker.group.sessionFile, "b.jsonl"); assert.equal(worker.group.calls, 1);
    await submit(worker, "new-b");
  } });
  assert.deepEqual(resumed, ["b"]); assert.deepEqual(output, { a: "new-a", b: "new-b" }); assert.equal(checkpoint.calls, 3);
});

test("越界补丁与不完整问题回执被拒，保存失败后阻止后续调用", async () => {
  const base = { a: "old", b: "protected" };
  let checkpoint = createRepairCheckpoint("batch", base, [issue("a", "/a")], 3);
  await assert.rejects(runRepairSchedule({ checkpoint, binding: "batch", base, save: async value => {
    if (value.calls) throw new Error("保存失败"); checkpoint = value;
  }, run: async worker => {
    await worker.onSession("a.jsonl");
    await assert.rejects(worker.submit({ baseHash: worker.baseHash, issueIds: ["a"], summary: "越界", updates: [{ path: "/b", value: "changed" }] }), /越过/);
    await assert.rejects(worker.submit({ baseHash: worker.baseHash, issueIds: [], summary: "遗漏", updates: [] }), /全部问题/);
    await assert.rejects(worker.onCall(), /保存失败/); await worker.onCall();
  } }), /保存失败/);
  assert.equal(checkpoint.calls, 0); assert.equal(base.b, "protected");
});

test("不同文件仍按显式任务依赖等待，下游读取上游修复后的版本", async () => {
  const base = { upstream: "old", downstream: "old" };
  const checkpoint = createRepairCheckpoint("batch", base, [
    { ...issue("downstream", "/downstream"), afterOwners: ["upstream"] }, issue("upstream", "/upstream")], 3);
  const order: string[] = [];
  const result = await runRepairSchedule({ checkpoint, binding: "batch", base, save: async () => {}, run: async worker => {
    const id = worker.group.issueIds[0]!; order.push(id);
    if (id === "downstream") assert.equal((worker.base as typeof base).upstream, "new");
    await submit(worker, "new");
  } });
  assert.deepEqual(order, ["upstream", "downstream"]); assert.deepEqual(result, { upstream: "new", downstream: "new" });
});

test("业务校验拒绝的补丁不标完成，恢复只修未完成组并保留真实用量", async () => {
  const base = { a: "old", b: "old" };
  let checkpoint = createRepairCheckpoint("validated", base, [issue("a", "/a"), issue("b", "/b")], 3);
  const options = { binding: "validated", base, save: async (value: typeof checkpoint) => { checkpoint = value; },
    validateCandidate: (candidate: unknown) => { assert.notEqual((candidate as typeof base).a, "", "必填字段不能为空"); } };
  await assert.rejects(runRepairSchedule({ ...options, checkpoint, run: worker => submit(worker, worker.group.issueIds[0] === "a" ? "" : "new-b") }), /必填字段/u);
  assert.equal(checkpoint.groups.filter(group => group.result).length, 1);
  assert.equal(checkpoint.calls, 2);
  const resumed: string[] = [];
  const result = await runRepairSchedule({ ...options, checkpoint, run: async worker => {
    resumed.push(worker.group.issueIds[0]!); assert.equal(worker.group.calls, 1); await submit(worker, "new-a");
  } });
  assert.deepEqual(resumed, ["a"]); assert.deepEqual(result, { a: "new-a", b: "new-b" }); assert.equal(checkpoint.calls, 3);
});

test("旧已提交坏补丁退回原组，消费旧基底的下游保留历史后重绑而不清零", async () => {
  const base = { a: "old", b: "old" };
  let checkpoint = createRepairCheckpoint("legacy", base, [issue("a", "/a"), { ...issue("b", "/b"), afterOwners: ["a"] }], 3);
  const options = { binding: "legacy", base, save: async (value: typeof checkpoint) => { checkpoint = value; } };
  await runRepairSchedule({ ...options, checkpoint, run: worker => submit(worker, worker.group.issueIds[0] === "a" ? "" : "new-b") });
  const previous = structuredClone(checkpoint), resumed: string[] = [];
  const result = await runRepairSchedule({ ...options, checkpoint, validateCandidate: value => {
    assert.notEqual((value as typeof base).a, "", "必填字段不能为空");
  }, run: async worker => {
    resumed.push(worker.group.issueIds[0]!); assert.equal(worker.group.calls, 1);
    if (worker.group.issueIds[0] === "b") {
      assert.equal(worker.group.sessionFile, null); assert.equal(worker.group.history!.length, 1);
      await assert.rejects(worker.onSession(previous.groups[1]!.sessionFile!), /进度/u);
      await worker.onSession("rebased-b.jsonl"); await worker.onCall();
      await worker.submit({ baseHash: worker.baseHash, issueIds: worker.group.issueIds, summary: "核对新上游", updates: [{ path: "/b", value: "verified-b" }] });
    } else await submit(worker, "verified-a");
  } });
  assert.deepEqual(resumed, ["a", "b"]); assert.deepEqual(result, { a: "verified-a", b: "verified-b" });
  assert.equal(checkpoint.calls, 4); assert.deepEqual(checkpoint.groups[0]!.history![0]!.result, previous.groups[0]!.result);
  assert.deepEqual(readRepairCheckpoint(checkpoint), checkpoint);
});


test("已用三次的旧分组经原校验迁移并在原会话续做，其他修复调度拒绝该策略", async () => {
  const base = { field: "pending" }, issues = [issue("inspect", "/field")];
  let previous = createRepairCheckpoint("review", base, issues, 3);
  await assert.rejects(runRepairSchedule({ checkpoint: previous, binding: "review", base, save: async state => { previous = state; },
    run: async worker => {
      await worker.onSession("review.jsonl");
      for (let i = 0; i < 3; i++) await worker.onCall();
      throw new Error("connection interrupted");
    } }), /connection interrupted/);
  const original = structuredClone(previous);
  assert.throws(() => readReviewTaskCheckpoint({ ...previous, calls: 0 }));
  let migrated = readReviewTaskCheckpoint(previous);
  assert.throws(() => readRepairCheckpoint(migrated));
  const merged = await runReviewTaskSchedule({ checkpoint: migrated, binding: "review", base, save: async state => { migrated = state; },
    run: async worker => {
      assert.equal(worker.group.sessionFile, "review.jsonl");
      assert.equal(worker.group.calls, 3); assert.equal(worker.group.rejection, undefined);
      await worker.onCall(); await worker.onCall(1);
      await worker.submit({ baseHash: worker.baseHash, issueIds: ["inspect"], summary: "核对完成", updates: [{ path: "/field", value: "done" }] });
    } });
  assert.deepEqual(merged, { field: "done" }); assert.equal(migrated.calls, 4);
  assert.deepEqual(previous, original);
});
