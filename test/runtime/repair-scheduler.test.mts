import test from "node:test";
import assert from "node:assert/strict";
import { createRepairCheckpoint, runRepairSchedule, readRepairCheckpoint } from "../../src/runtime/repair-scheduler.mjs";
import type { RepairIssue, RepairWorker } from "../../src/runtime/repair-scheduler.mjs";

const issue = (id: string, path: string, owner = id): RepairIssue => ({ id, paths: [path], owner, description: `修复${id}`, remedy: "保留原要求" });
async function submit(worker: RepairWorker, value: unknown) {
  await worker.onSession(worker.group.sessionFile ?? `${worker.group.id}.jsonl`); await worker.onCall();
  await worker.submit({ baseHash: worker.baseHash, issueIds: worker.group.issueIds, summary: "局部修改，等待独立验证",
    updates: [{ path: worker.group.paths[0]!, value }] });
}

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
