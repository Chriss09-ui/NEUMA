import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixturePort } from "../helpers/http-model.mjs";
import { WorkflowController } from "../../src/services/workflow-controller.mjs";
import { executionOutcome } from "../../src/runtime/execution-attempt.mjs";

for (const boundary of ["prepared", "dispatched", "effect", "result"]) test(`真实SIGKILL恢复：${boundary}保持执行事实且不重发外部动作`, { timeout: 15000 }, async t => {
  const rootDir = await mkdtemp(join(tmpdir(), "neuma-crash-"));
  let effects = 0, resumedCalls = 0;
  const server = createServer(async (request, response) => { for await (const _ of request) {} effects++; response.end("ok"); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const child = fork(new URL("../helpers/recovery-child.mjs", import.meta.url), [rootDir, `http://127.0.0.1:${fixturePort(server)}`, boundary], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit").catch(() => {}); }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(rootDir, { recursive: true, force: true }); });
  const [message] = await once(child, "message", { signal: AbortSignal.timeout(10000) });
  assert.deepEqual(message, { type: "ready", boundary });
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  assert.equal(effects, ["effect", "result"].includes(boundary) ? 1 : 0);
  const restored = new WorkflowController({ rootDir, runAction: async () => { resumedCalls++; throw new Error("Unexpected replay"); } });
  await restored.recover(); const record = await restored.get("workflow_crash"), attempt = record.steps[0]!.items[0]!.executions!.at(-1)!;
  assert.equal(record.steps[0]!.items[0]!.attempts, 1);
  assert.equal(executionOutcome(attempt), boundary === "prepared" ? "not_started" : boundary === "result" ? "completed" : "unknown");
  if (boundary === "result") {
    const completed = await restored.resume({ id: record.id });
    assert.equal(completed.status, "completed"); assert.deepEqual(await restored.readResult(completed, completed.resultRefs.send), { delivered: true });
  } else if (boundary !== "prepared") {
    assert.equal(record.status, "needs_review"); await assert.rejects(restored.resume({ id: record.id }), { reason: "workflow_resolution_required" });
  }
  assert.equal(resumedCalls, 0); await restored.close();
});
