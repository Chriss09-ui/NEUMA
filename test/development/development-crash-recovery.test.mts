import test from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixtureChatRequest, fixturePort } from "../helpers/http-model.mjs";
import { developmentArchitecture, developmentPlan } from "../helpers/development.mjs";
import { SessionReplay } from "../helpers/session-replay.mjs";

for (const boundary of ["budget", "result"]) test(`研发真实SIGKILL：${boundary}后恢复不补预算、不重调已提交规划`, { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "neuma-development-kill-")), children: ChildProcess[] = [], roles: string[] = [];
  const replay = new SessionReplay({ version: 1, kind: "synthetic", complete: true, changes: "一轮规划后在真实持久边界强制退出", protocol: "neuma-execution-v1" },
    boundary === "budget" ? [] : [{ role: "planner", stage: "planning", tools: ["submit_development_plan"], context: ["requirements"], answer: developmentPlan(developmentArchitecture()) }]);
  let recovering = false;
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const body = fixtureChatRequest(Buffer.concat(chunks).toString()), planner = body.tools?.some(tool => tool.function.name === "submit_development_plan");
    roles.push(planner ? "planner" : "reviewer");
    if (recovering || !planner) { response.writeHead(400); response.end("Synthetic independent review stops here"); return; }
    try {
      const plan = replay.next("planner", "planning", body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "planning", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "plan", type: "function",
        function: { name: "submit_development_plan", arguments: JSON.stringify(plan) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
    } catch { response.writeHead(400); response.end("Replay mismatch"); }
  });
  model.listen(0, "127.0.0.1"); await once(model, "listening");
  const start = (mode: string) => { const child = fork(new URL("../helpers/development-recovery-child.mjs", import.meta.url), [root, `http://127.0.0.1:${fixturePort(model)}/v1/chat/completions`, boundary, mode], { stdio: ["ignore", "ignore", "pipe", "ipc"] }); children.push(child); return child; };
  t.after(async () => { for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill("SIGKILL"); await exit; }
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const crashed = start("crash"), [ready] = await once(crashed, "message", { signal: AbortSignal.timeout(12000) });
  assert.deepEqual(ready, { type: "ready", boundary }); const exit = once(crashed, "exit"); crashed.kill("SIGKILL"); await exit;
  assert.deepEqual(roles, boundary === "budget" ? [] : ["planner"]);
  recovering = true;
  const resumed = start("resume"), [result] = await once(resumed, "message", { signal: AbortSignal.timeout(12000) });
  assert.equal(result.type, "result"); assert.equal(result.plannerTurns, 1); assert.equal(result.status, "failed");
  assert.equal(result.proposalSaved, boundary === "result"); assert.equal(result.approvedPlan, false); assert.equal(result.pending, false);
  assert.deepEqual(roles, boundary === "budget" ? [] : ["planner", "reviewer"]); replay.assertConsumed();
  await once(resumed, "exit");
});
