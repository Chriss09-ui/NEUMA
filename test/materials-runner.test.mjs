import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { MaterialRunner } from "../src/materials/material-runner.mjs";

const entry = fileURLToPath(new URL("./fixtures/materials/parser-stub.mjs", import.meta.url));

test("fixed child process pool limits concurrency to two and cancels queued jobs without spawning", async (t) => {
  let active = 0, maximum = 0, spawned = 0;
  const runner = new MaterialRunner({ entry, spawnProcess(...args) { const child = spawn(...args); spawned++; active++; maximum = Math.max(maximum, active); child.once("close", () => active--); return child; } });
  t.after(() => runner.close());
  const first = runner.run({ value: 1, delay: 150 }), second = runner.run({ value: 2, delay: 150 });
  const controller = new AbortController(), queued = runner.run({ value: 3 }, { signal: controller.signal });
  controller.abort(); await assert.rejects(queued, { name: "AbortError" });
  assert.deepEqual((await Promise.all([first, second])).map((result) => result.value), [1, 2]);
  assert.equal(maximum, 2); assert.equal(spawned, 2); assert.equal(active, 0);
});

test("timeout and cancellation terminate child processes, and close permits future jobs", async (t) => {
  const runner = new MaterialRunner({ entry, timeoutMs: 80 }); t.after(() => runner.close());
  await assert.rejects(runner.run({ delay: 10000, ignoreTermination: true }), (error) => error.reason === "material_timeout");
  assert.equal(runner.active.size, 0);
  const controller = new AbortController(), running = runner.run({ delay: 10000 }, { signal: controller.signal });
  await delay(10); controller.abort(); await assert.rejects(running, { name: "AbortError" }); assert.equal(runner.active.size, 0);
  const stopped = runner.run({ delay: 10000 }); const rejection = assert.rejects(stopped, { name: "AbortError" }); await runner.close(); await rejection;
  // Recovery should not depend on cold process startup fitting the timeout used above.
  runner.timeoutMs = 2000;
  assert.deepEqual(await runner.run({ value: "after-close" }), { value: "after-close" });
});
