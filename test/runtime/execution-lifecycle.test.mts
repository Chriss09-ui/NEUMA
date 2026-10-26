import test from "node:test";
import assert from "node:assert/strict";
import { ExecutionLifecycle } from "../../src/runtime/execution-lifecycle.mjs";
import { admitModelRequest } from "../../src/runtime/model-admission.mjs";

test("关闭一次执行尝试清理所有所属资源，失败不跳过其余释放，重复关闭共享结果", async () => {
  const scope = new ExecutionLifecycle(), released: string[] = [];
  scope.own("slot", () => { released.push("slot"); });
  scope.own("session", () => { released.push("session"); throw new Error("synthetic release failure"); });
  scope.own("listener", () => { released.push("listener"); });
  const first = scope.close(), duplicate = scope.close();
  assert.equal(first, duplicate); await assert.rejects(first, AggregateError);
  assert.deepEqual(released, ["listener", "session", "slot"]);
});
test("准入保存失败或保存期间取消，不能进入后续绑定检查和分派", async () => {
  for (const reason of ["failed", "cancelled"]) {
    const controller = new AbortController(); let checked = false, sent = false;
    await assert.rejects(async () => {
      await admitModelRequest({ signal: controller.signal, persist: async () => {
        if (reason === "failed") throw new Error("synthetic persistence failure"); controller.abort();
      }, check: () => { checked = true; } }); sent = true;
    });
    assert.equal(checked, false); assert.equal(sent, false);
  }
});
