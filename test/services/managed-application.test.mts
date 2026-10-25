import {callFixture} from "../helpers/m7-test-boundaries.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStorage } from "../../src/agents/agent-storage.mjs";
import { AgentScheduler } from "../../src/runtime/agent-scheduler.mjs";
import { ApplicationService } from "../../src/applications/application-service.mjs";
import { ApplicationTaskStore } from "../../src/applications/task-store.mjs";
import { ManagedServiceManager } from "../../src/services/managed-service-manager.mjs";
import { validateApplicationManifest } from "../../src/applications/application-contract.mjs";
import type { PathLike } from "fs";

const object = (properties: { values?: { type: string; items: { type: string; }; }|{ type: string; items: { type: string; }; }; suffix?: { type: string; }; }) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const number = { type: "number" }, string = { type: "string" };
const inputSchema = object({ values: { type: "array", items: number } });
const outputSchema = object({ values: { type: "array", items: number }, suffix: string });
async function unseal(path:string) { await chmod(path, 0o700); for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await unseal(join(path, entry.name)); }
async function fixture(t: test.TestContext, { sideEffect = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-managed-application-"));
  const codeDir = join(root, "source"); await mkdir(codeDir);
  await writeFile(join(codeDir, "main.mjs"), `let count=0; export async function run({actionId,input},ctx){
    if(actionId==='count') return ++count;
    if(actionId==='double') return ctx.connection.call({connectionId:'data',operationId:'double',input});
    if(actionId==='finish') return input;
    throw new Error('unknown action');
  }`);
  const operations = [
    { id: "process", title: "批次处理", inputSchema, outputSchema, connectionIds: ["data"] },
    { id: "count", title: "范围计数", inputSchema: number, outputSchema: number, connectionIds: [] },
    { id: "double", visibility: "internal", inputSchema: number, outputSchema: number, connectionIds: ["data"] },
    { id: "finish", visibility: "internal", inputSchema: outputSchema, outputSchema, connectionIds: [] },
  ];
  const manifest = validateApplicationManifest({ protocolVersion: 3, runtime: "managed-service", entrypoint: "main.mjs",
    page: null, actions: operations.filter((operation) => !operation.visibility), stateVersion: 1, evidenceIds: ["verified"],
    service: { schemaVersion: 1, language: "javascript", host: "managed", entrypoint: "main.mjs", operations, dataVersion: 1,
      capabilities: ["connection.call"], workflow: { schemaVersion: 1, entryActionId: "process", steps: [
        { id: "batch", actionId: "double", dependsOn: [], input: { $item: true }, batch: { inputPath: "values", maxItems: 100 }, idempotent: !sideEffect },
        { id: "finish", actionId: "finish", dependsOn: ["batch"], input: { values: { $step: "batch" }, suffix: { $response: true } },
          waitForInput: { prompt: "请填写结果标签", inputSchema: string }, idempotent: true },
      ], outputs: ["finish"] } } });
  const storage = new AgentStorage({ dataDir: root }), calls: ((unknown))[] = [], managers: ManagedServiceManager[] = [], applications: ApplicationService[] = [];
  let failure = false;
  async function create() {
    const manager = new ManagedServiceManager({ rootDir: join(root, "services") }); managers.push(manager);
    if (!(await manager.probe()).available) { t.skip("当前平台没有托管隔离运行条件"); return null; }
    await manager.prepare({ agentId: "one", deliveryVersion: "v1", manifest: manifest.service, codeDir });
    await manager.activate({ agentId: "one", deliveryVersion: "v1" });
    const agents = { storage, dataDir: root, ready: Promise.resolve(), services: manager, scheduler: new AgentScheduler(),
      onLifecycle: () => () => {}, connections: { snapshot: async () => ({ agentId: "one", version: 1, connections: [{ id: "data", version: 1 }] }), assertActive: async () => {} },
      applicationCapabilities: async () => async ({args}:{args:{input:number}}) => { calls.push(args.input); if (failure) throw new Error("unknown external result"); return args.input * 2; } };
    const service = callFixture((options:ConstructorParameters<typeof ApplicationService>[0])=>new ApplicationService(options),undefined,[{ agents, store: new ApplicationTaskStore({ storage }), resources: { closeAll: async () => {}, closeAgent: async () => {} } }]);
    Reflect.set(agents,"applications",service);
    Reflect.set(service,"descriptor",async () => ({ agent: { id: "one", revision: 1 }, manifest, snapshot: { path: codeDir }, deliveryVersion: "v1" }));
    await service.ready; await service.workflowReady; applications.push(service); return { service, manager, agents };
  }
  t.after(async () => { for (const service of applications) await service.close(); for (const manager of managers) await manager.close(); await unseal(root); await rm(root, { recursive: true, force: true }); });
  return { ...await create()!!!!!!!, create, root, calls, fail: (value: boolean) => { failure = value; }, manifest };
}

test("真实托管批次执行、等待输入、关闭重启后继续，不重放已完成步骤", async (t) => {
  const f = await fixture(t); if (!f.service) return;
  const submission = { actionId: "process", input: { values: [2, 3] }, mutationId: "workflow-first", deliveryVersion: "v1" };
  const { taskId } = await f.service.submit("one", submission);
  let task = await f.service.wait("one", taskId);
  assert.equal(task.status, "waiting_input"); assert.equal(objectFields(task.waiting).stepId, "finish"); assert.deepEqual(f.calls, [2, 3]);
  assert.equal((await f.service.submit("one", submission)).taskId, taskId);
  await f.service.close(); await f.manager!.close();
  const resumed = await f.create(); task = await resumed!.service!.store.get("one", taskId);
  assert.equal(task.status, "interrupted");
  await assert.rejects(resumed!.service!.resume("one", taskId, { input: "done", expectedVersion: task.sequence - 1, mutationId: "resume-conflict" }), /状态已变化/);
  await resumed!.service!.resume("one", taskId, { input: "done", expectedVersion: task.sequence, mutationId: "resume-correct" });
  task = await resumed!.service!.wait("one", taskId);
  assert.equal(task.status, "completed", JSON.stringify(task)); assert.deepEqual(task.result, { values: [4, 6], suffix: "done" });
  assert.deepEqual(f.calls, [2, 3]);
  await resumed!.service!.resume("one", taskId, { input: "done", expectedVersion: task.sequence - 100, mutationId: "resume-correct" });
  assert.deepEqual(f.calls, [2, 3]);
});

test("外部副作用结果不明时暂停，核实结果后继续且不重复调用", async (t) => {
  const f = await fixture(t, { sideEffect: true }); if (!f.service) return; f.fail(true);
  const { taskId } = await f.service.submit("one", { actionId: "process", input: { values: [4] }, mutationId: "effect-first", deliveryVersion: "v1" });
  let task = await f.service.wait("one", taskId); assert.equal(task.status, "needs_review", JSON.stringify(task));
  assert.deepEqual(objectFields(task.waiting).outputSchema, number);
  await assert.rejects(f.service.resume("one", taskId, { mutationId: "wrong-resume", expectedVersion: task.sequence }), /先核实/);
  await assert.rejects(f.service.resume("one", taskId, { mutationId: "wrong-result", expectedVersion: task.sequence,
    resolution: { stepId: "batch", index: 0, outcome: "completed", output: "eight" } }));
  await f.service.resume("one", taskId, { mutationId: "resolve-effect", expectedVersion: task.sequence,
    resolution: { stepId: "batch", index: 0, outcome: "completed", output: 8 } });
  task = await f.service.wait("one", taskId); assert.equal(task.status, "waiting_input"); assert.deepEqual(f.calls, [4]);
  await f.service.resume("one", taskId, { mutationId: "resolve-final", expectedVersion: task.sequence, input: "checked" });
  task = await f.service.wait("one", taskId); assert.equal(task.status, "completed"); assert.deepEqual(objectFields(task.result).values, [8]); assert.deepEqual(f.calls, [4]);
});

test("应用与群操作使用不同常驻进程，内部流程动作不能直接提交", async (t) => {
  const f = await fixture(t); if (!f.service) return;
  for (const [scope, expected] of [["private", 1], ["group:g1:t1", 1], ["private", 2], ["group:g2:t1", 1]] as const) {
    const { taskId } = await f.service.submit("one", { actionId: "count", input: 0, mutationId: `count-${scope!.replaceAll!(":", "-")}-${expected}`, deliveryVersion: "v1" }, { source: { kind: "conversation", scope } });
    assert.equal((await f.service.wait("one", taskId)).result, expected);
  }
  await assert.rejects(f.service.submit("one", { actionId: "double", input: 0, mutationId: "internal-test", deliveryVersion: "v1" }), /已验收动作/);
});
