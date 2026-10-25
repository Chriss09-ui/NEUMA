import { fixtureNumber } from "../helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowController } from "../../src/services/workflow-controller.mjs";
import { validateWorkflowDefinition } from "../../src/services/workflow-contract.mjs";

async function setup(t: test.TestContext, runAction: (request: import("../../src/services/service-port.mjs").WorkflowActionOptions<unknown>) => Promise<import("../../src/services/service-port.mjs").ServiceResult>) {
  const rootDir = await mkdtemp(join(tmpdir(), "neuma-workflow-test-"));
  const workflow = new WorkflowController({ rootDir, runAction });
  t.after(async () => { await workflow.close(); await rm(rootDir, { recursive: true, force: true }); });
  return { rootDir, workflow };
}
const options = { agentId: "agent-one", deliveryVersion: "version-one" };
test("workflow contracts reject undeclared dependencies, cycles, and side-effect retries", () => {
  const step = { id: "a", actionId: "run", dependsOn: [], idempotent: true };
  assert.throws(() => validateWorkflowDefinition({ schemaVersion: 1, entryActionId: "whole", steps: [{ ...step, dependsOn: ["a"] }], outputs: ["a"] }));
  assert.throws(() => validateWorkflowDefinition({ schemaVersion: 1, entryActionId: "whole", steps: [{ ...step, input: { $step: "b" } }], outputs: ["a"] }));
  assert.throws(() => validateWorkflowDefinition({ schemaVersion: 1, entryActionId: "whole", steps: [{ ...step, idempotent: false, maxRetries: 1 }], outputs: ["a"] }));
});
test("workflow persists batch checkpoints, waits for user input, and resumes without repeating completed actions", async (t) => {
  const calls: ((unknown))[] = [];
  const { workflow, rootDir } = await setup(t, async (request) => { calls.push(request); return { status: "passed", output: request.actionId === "double" ? fixtureNumber(request.input) * 2 : request.input }; });
  const definition = { schemaVersion: 1, entryActionId: "whole", steps: [
    { id: "batch", actionId: "double", dependsOn: [], input: { $item: true }, batch: { inputPath: "values", maxItems: 10 }, idempotent: true },
    { id: "confirm", actionId: "report", dependsOn: ["batch"], input: { results: { $step: "batch" }, title: { $response: true } }, waitForInput: { prompt: "报告叫什么？", inputSchema: { type: "string" } }, idempotent: true }
  ], outputs: ["confirm"] };
  const first = await workflow.start({ ...options, definition, input: { values: [2, 3] } });
  assert.equal(first.status, "waiting_input"); assert.equal(calls.length, 2); assert.equal(first.steps![0]!.items.length, 2);
  const record = JSON.parse(String(await readFile(join(rootDir, first.id, "record.json"), "utf8"))); assert.equal(record.steps[0].resultRef.path.startsWith("results/"), true);
  const last = await workflow.resume({ id: first.id, input: "分析报告" });
  assert.equal(last.status, "completed"); assert.equal(calls.length, 3);
  assert.deepEqual(await workflow.readResult(last, last.resultRefs.confirm), { results: [4, 6], title: "分析报告" });
});
test("workflow never retries an uncertain external side effect and requires an explicit resolution", async (t) => {
  let calls = 0;
  const { workflow } = await setup(t, async () => { calls++; return { status: "error", reason: "connection_lost" }; });
  const definition = { schemaVersion: 1, entryActionId: "whole", steps: [{ id: "send", actionId: "send", dependsOn: [], idempotent: false }], outputs: ["send"] };
  const first = await workflow.start({ ...options, definition, input: {} });
  assert.equal(first.status, "needs_review"); assert.equal(calls, 1);
  await assert.rejects(workflow.resume({ id: first.id }), { reason: "workflow_resolution_required" });
  const resolved = await workflow.resume({ id: first.id, resolution: { stepId: "send", index: 0, outcome: "completed", output: { sent: true } } });
  assert.equal(resolved.status, "completed"); assert.equal(calls, 1);
});
test("workflow retry budget persists and recovery marks in-flight side effects for review", async (t) => {
  let calls = 0;
  const { workflow, rootDir } = await setup(t, async () => { calls++; return { status: "error", reason: "worker_crashed" }; });
  const definition = { schemaVersion: 1, entryActionId: "whole", steps: [{ id: "read", actionId: "read", dependsOn: [], idempotent: true, maxRetries: 1 }], outputs: ["read"] };
  const record = await workflow.start({ ...options, definition, input: {} });
  assert.equal(record.status, "failed"); assert.equal(calls, 2);
  const retry = await workflow.resume({ id: record.id }); assert.equal(retry.status, "failed"); assert.equal(calls, 2);
  const changed = await workflow.get(record.id); changed.status = "running"; changed.steps![0]!.items[0]!.status = "running";
  await writeFile(join(rootDir, record.id, "record.json"), JSON.stringify(changed));
  assert.equal((await workflow.recover())[0]!.status, "interrupted");
});

test("workflow request IDs are idempotent and preserve input and delivery bindings", async (t) => {
  let calls = 0; const { workflow } = await setup(t, async () => { calls++; return { status: "passed", output: 4 }; });
  const definition = { schemaVersion: 1, entryActionId: "whole", steps: [{ id: "read", actionId: "read", dependsOn: [], idempotent: true }], outputs: ["read"] };
  const request = { ...options, id: "workflow_application-task", definition, input: { value: 2 } };
  const [first, duplicate] = await Promise.all([workflow.start(request), workflow.start(request)]);
  assert.equal(first.id, duplicate.id); assert.equal(calls, 1);
  await assert.rejects(workflow.start({ ...request, input: { value: 3 } }), { reason: "workflow_request_conflict" });
  await assert.rejects(workflow.start({ ...request, deliveryVersion: "two" }), { reason: "workflow_request_conflict" });
  await workflow.close(); assert.equal((await workflow.start({ ...request, id: "workflow_second" })).status, "completed");
});

test("explicit continuation retries an interrupted idempotent step without resetting automatic retry budgets", async (t) => {
  const controller = new AbortController(); let calls = 0;
  const { workflow } = await setup(t, async () => {
    calls++;
    if (calls === 1) { controller.abort(); return { status: "error", reason: "cancelled" }; }
    return { status: "passed", output: "complete" };
  });
  const definition = { schemaVersion: 1, entryActionId: "whole", steps: [{ id: "read", actionId: "read", dependsOn: [], idempotent: true }], outputs: ["read"] };
  const first = await workflow.start({ ...options, definition, input: {}, signal: controller.signal });
  assert.equal(first.status, "interrupted"); assert.equal(first.steps![0]!.items[0]!.attempts, 1);
  const resumed = await workflow.resume({ id: first.id });
  assert.equal(resumed.status, "completed"); assert.equal(calls, 2); assert.equal(resumed.steps![0]!.items[0]!.attempts, 2);
});

test("damaged nested workflow checkpoints cannot resume actions or rewrite the journal", async (t) => {
  let calls = 0;
  const { workflow, rootDir } = await setup(t, async () => { calls++; return { status: "passed", output: null }; });
  const first = await workflow.start({ ...options, input: {}, definition: { schemaVersion: 1, entryActionId: "whole",
    steps: [{ id: "confirm", actionId: "run", dependsOn: [], idempotent: true, waitForInput: { prompt: "确认", inputSchema: { type: "string" } } }], outputs: ["confirm"] } });
  const file = join(rootDir, first.id, "record.json"), valid = JSON.parse(String(await readFile(file, "utf8")));
  for (const corrupt of [
    (record: { steps: { items: { index: number; status: string; attempts: string; resultRef: null; }[]; }[]; }) => { record.steps![0]!.items = [{ index: 0, status: "pending", attempts: "bad", resultRef: null }]; },
    (record: { steps: { responseRef: { sha256: never[]; path: string; }; }[]; }) => { record.steps![0]!.responseRef = { sha256: [], path: "results/fixture.json" }; },
    (record: { waiting: { index: string; }; }) => { record.waiting.index = "bad"; },
    (record: { resultRefs: { confirm: { sha256: string; path: number; }; }; }) => { record.resultRefs = { confirm: { sha256: "fixture", path: 42 } }; },
  ]) {
    const damaged = structuredClone(valid); corrupt(damaged);
    const bytes = JSON.stringify(damaged, null, 2); await writeFile(file, bytes);
    await assert.rejects(workflow.resume({ id: first.id, input: "confirmed" }), { reason: "workflow_definition_changed" });
    assert.equal(await readFile(file, "utf8"), bytes); assert.equal(calls, 0);
  }
});
