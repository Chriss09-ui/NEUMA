import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ManagedServiceManager } from "../../src/services/managed-service-manager.mjs";

// R6 生命周期审计：worker 停止失败不得把临时关闭固化成永久关闭。
// 夹具只注入假 worker，不启动真实进程。

test("worker 停止失败时临时关闭仍可恢复且失败可见", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-managed-close-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new ManagedServiceManager({ rootDir: root });
  const stops: string[] = [];
  manager.workers.set("delivery-x", { stop: async (reason: string) => {
    stops.push(reason);
    if (stops.length === 1) throw new Error("worker 停止失败");
  } } as never);
  await assert.rejects(manager.close(), /worker 停止失败/);
  assert.equal(manager.closed, false, "临时关闭失败后必须恢复可用状态");
  assert.equal(manager.lifecycle.signal.aborted, false, "临时关闭失败后必须重建生命周期信号");
  await manager.close();
  assert.deepEqual(stops, ["backend_stopped", "backend_stopped"]);
});

test("永久关闭保持不可恢复，失败同样可见", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-managed-close-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new ManagedServiceManager({ rootDir: root });
  manager.workers.set("delivery-x", { stop: async () => { throw new Error("worker 停止失败"); } } as never);
  await assert.rejects(manager.close({ permanent: true }), /worker 停止失败/);
  assert.equal(manager.closed, true, "永久关闭语义不受清理失败影响");
});
