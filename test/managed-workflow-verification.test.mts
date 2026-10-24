import type { DevelopmentCase, TestMock } from "../src/contracts/development.mjs";
import { recordArray } from "./helpers/m7-test-boundaries.mjs";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedServiceManager } from "../src/services/managed-service-manager.mjs";
import { inspectDevelopmentCode } from "../src/development/development-workspace.mjs";
import { verifyManagedApplication } from "../src/development/managed-verification.mjs";

const supported = process.platform === "darwin" && process.arch === "arm64";
const integer = { type: "integer" }, text = { type: "string" }, integers = { type: "array", items: integer };
const object = (properties: { values?: { type: string; items: { type: string; }; }; title?: { type: string; }; }) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "neuma-managed-workflow-")), codeDir = join(root, "code"); await mkdir(codeDir);
  await writeFile(join(codeDir, "actions.mjs"), `export const actions={read:async(input,ctx)=>{const result=await ctx.connection.call({connectionId:'store',operationId:'read',input:{value:input}});return result.value},finish:async input=>input}`);
  const services = new ManagedServiceManager({ rootDir: join(root, "services") });
  t.after(async () => { await services.close({ permanent: true }); await rm(root, { recursive: true, force: true }); });
  const entry = { id: "whole", title: "批次报告", inputSchema: object({ values: integers }), outputSchema: object({ values: integers, title: text }), connectionIds: ["store"] };
  const operations = [entry, { id: "read", inputSchema: integer, outputSchema: integer, visibility: "internal", connectionIds: ["store"] }, { id: "finish", inputSchema: entry.outputSchema, outputSchema: entry.outputSchema, visibility: "internal", connectionIds: [] }];
  const workflow = { schemaVersion: 1, entryActionId: "whole", steps: [
    { id: "batch", actionId: "read", dependsOn: [], idempotent: true, input: { $item: true }, batch: { inputPath: "values", maxItems: 10 } },
    { id: "report", actionId: "finish", dependsOn: ["batch"], idempotent: true, input: { values: { $step: "batch" }, title: { $response: true } }, waitForInput: { prompt: "报告标题", inputSchema: text } }
  ], outputs: ["report"] };
  const application = { protocolVersion: 3, runtime: "managed-service", entrypoint: "actions.mjs", page: null, actions: [entry], stateVersion: 1, evidenceIds: [], service: { schemaVersion: 1, language: "javascript", host: "managed", entrypoint: "actions.mjs", operations, workflow } };
  const snapshot = await inspectDevelopmentCode(codeDir);
  const item: DevelopmentCase & { mocks: TestMock[] } = { id: "batch_report", taskId: "task", acceptanceId: "acceptance", kind: "action", actionId: "whole", input: JSON.stringify({ values: [2, 3] }),
    mocks: [2, 3].map((value) => ({ capability: "connection.call", argsJson: JSON.stringify({ connectionId: "store", operationId: "read", input: { value } }), resultJson: JSON.stringify({ value: value * 2 }) })),
    workflowInputs: [{ stepId: "report", inputJson: JSON.stringify("已确认的标题") }], assertions: [{ path: "", expectedJson: JSON.stringify({ values: [4, 6], title: "已确认的标题" }) }] };
  return { services, agentId: "workflow-agent", application, snapshot, item };
}

test("managed verification executes internal batch steps and explicit user replies through actual workers", { skip: !supported }, async (t) => {
  const setup = await fixture(t), report = await verifyManagedApplication({ ...setup, cases: [setup.item] });
  assert.equal(report.status, "passed", JSON.stringify(report)); assert.equal(recordArray(report.results[0]!.mockCalls).length, 2);
  assert.deepEqual(objectFields(report.results[0]!.workflow).completedSteps, ["batch", "report"]);
  assert.equal(objectFields(report.results[0]!.workflow).batchItems, 3); assert.equal(report.connectionVerified, false); assert.equal(setup.services.workers.size, 0);
});
test("workflow verification never invents user approval or ignores unused capability fixtures", { skip: !supported }, async (t) => {
  const setup = await fixture(t);
  const missing = await verifyManagedApplication({ ...setup, cases: [{ ...setup.item, workflowInputs: [] }] });
  assert.equal(missing.status, "failed"); assert.equal(missing.results[0]!.reason, "workflow_input_fixture_missing");
  const extra = await verifyManagedApplication({ ...setup, cases: [{ ...setup.item, mocks: [...setup.item.mocks, setup.item.mocks[0]!] }] });
  assert.equal(extra.status, "failed"); assert.equal(extra.results[0]!.reason, "unused_capability_mocks");
  const duplicate = await verifyManagedApplication({ ...setup, cases: [{ ...setup.item, workflowInputs: [...setup.item.workflowInputs!, ...setup.item.workflowInputs!] }] });
  assert.equal(duplicate.status, "error");
});
