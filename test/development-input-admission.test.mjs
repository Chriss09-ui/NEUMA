import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStorage } from "../src/agents/agent-storage.mjs";
import { ApplicationTaskStore, validateApplicationTaskEnvelope } from "../src/applications/task-store.mjs";
import { validateActionInput } from "../src/applications/application-contract.mjs";
import { DevelopmentExecutor } from "../src/development/development-executor.mjs";
import { inspectDevelopmentCode } from "../src/development/development-workspace.mjs";
import { verifyManagedApplication } from "../src/development/managed-verification.mjs";
import { FIXTURE_LIMITS, resolveTestJson, resolveCaseValues, inputContractRejection,
  inputContractMeasurement } from "../src/development/development-fixtures.mjs";
import { ACCEPTANCE_ADAPTER_GUIDE } from "../src/verification/acceptance-contract.mjs";
import { INPUT_REJECTION_RESULT, INPUT_REJECTION_REPORT_METADATA } from "../src/verification/input-rejection-contract.mjs";

const action = { id: "echo", title: "验证", inputSchema: { type: "object", properties: { payload: {} },
  required: ["payload"], additionalProperties: false }, outputSchema: { type: "boolean" }, connectionIds: [] };
const envelope = (input) => ({ actionId: action.id, input, mutationId: "verification-input-rejection", deliveryVersion: "verification-input-rejection",
  source: { kind: "application", scope: "verification:input-rejection" }, allowNetwork: false });
const sample = (count, inputTarget = "action-value") => ({ id: "reject", kind: "input-rejection", actionId: action.id, inputTarget,
  input: { fixture: { op: "object", fields: { payload: { op: "text", value: "x".repeat(256), count } } } }, mocks: [],
  assertions: [{ path: "", expectedJson: '{"rejected":true,"reason":"input_contract_rejected"}' }] });

test("容量负例抵达对应正式校验器，动作值与整份任务信封不会混为一谈", () => {
  const taskInput = resolveCaseValues(sample(512, "task-envelope")).input;
  assert.doesNotThrow(() => validateActionInput(action, taskInput));
  assert.equal(inputContractRejection(action, taskInput).rejected, false);
  assert.equal(inputContractRejection(action, taskInput, { target: "task-envelope" }).rejected, true);
  assert.throws(() => validateApplicationTaskEnvelope(envelope(taskInput)));
  assert.deepEqual(inputContractMeasurement(action, taskInput, { target: "task-envelope" }),
    { target: "task-envelope", bytes: Buffer.byteLength(JSON.stringify(envelope(taskInput))), limit: 128 * 1024 });

  const tooLarge = resolveCaseValues(sample(4096)).input;
  assert.ok(Buffer.byteLength(JSON.stringify(tooLarge)) > 1024 * 1024);
  assert.throws(() => validateActionInput(action, tooLarge), (error) => error.validationIssue?.reason === "channel_limit");
  assert.equal(inputContractRejection(action, tooLarge).rejected, true);
  assert.equal(inputContractRejection(action, { payload: "x".repeat(105000) }, { target: "task-envelope" }).rejected, false);
  assert.equal(inputContractRejection(action, { payload: "x".repeat(1020000) }).rejected, false);
});

test("额外夹具额度只用于拒绝测试的输入，不放宽动作、断言、回执或生产限额", () => {
  const item = sample(4096);
  assert.throws(() => resolveTestJson(item.input, { maxBytes: FIXTURE_LIMITS.rejectionInputBytes }), { reason: "fixture_output_limit" });
  assert.throws(() => resolveCaseValues({ ...item, kind: "action", inputTarget: undefined }), { reason: "fixture_input_target_invalid" });
  const ordinary = { ...item, kind: "action" }; delete ordinary.inputTarget;
  assert.throws(() => resolveCaseValues(ordinary, { maxInputBytes: 1024 * 1024 }), { reason: "fixture_output_limit" });
  assert.throws(() => resolveCaseValues({ ...item, assertions: [{ path: "", expectedJson: item.input }] }), { reason: "fixture_output_limit" });
  assert.throws(() => resolveCaseValues({ ...item, mocks: [{ capability: "files.write", argsJson: item.input, resultJson: "null" }] }), { reason: "fixture_output_limit" });
  assert.throws(() => resolveCaseValues(sample(4400)), { reason: "fixture_output_limit" });
  assert.throws(() => resolveCaseValues({ ...item, inputTarget: "unknown" }), { reason: "fixture_input_target_invalid" });
  assert.throws(() => inputContractRejection(action, {}, { target: "unknown" }), /目标无效/);
});

test("任务拒绝验证与真实仓库在边界逐字一致，越界不留下任务", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-input-admission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = new AgentStorage({ dataDir: root }), store = new ApplicationTaskStore({ storage });
  await store.ready;
  const empty = { payload: "" }, base = inputContractMeasurement(action, empty, { target: "task-envelope" });
  const boundary = { payload: "x".repeat(base.limit - base.bytes) };
  const over = { payload: boundary.payload + "x" };
  assert.equal(Buffer.byteLength(JSON.stringify(envelope(boundary))), base.limit);
  assert.equal(inputContractRejection(action, boundary, { target: "task-envelope" }).rejected, false);
  assert.equal(inputContractRejection(action, over, { target: "task-envelope" }).rejected, true);
  await assert.rejects(store.create("probe", envelope(over)), /大小限制/);
  assert.deepEqual(await store.list("probe"), []);
  const result = await store.create("probe", envelope(boundary));
  assert.equal(result.created, true); assert.equal(result.task.input.payload.length, boundary.payload.length);
  await store.settle();
});

test("真实Node验收记录目标和实测字节，拒绝超限输入时不执行生成动作", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-input-rejection-executor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codeDir = join(root, "code"); await mkdir(codeDir);
  await writeFile(join(codeDir, "main.mjs"), 'throw new Error("REJECTED_INPUT_MUST_NOT_LOAD_MODULE");');
  const executor = new DevelopmentExecutor();
  const probe = await executor.probe(); assert.equal(probe.available, true, probe.reason);
  const cases = [sample(512, "task-envelope"), { ...sample(4096), id: "action_limit" }];
  const report = await executor.verify({ snapshot: await inspectDevelopmentCode(codeDir), entrypoint: "main.mjs", runtime: "node-action",
    application: { protocolVersion: 2, runtime: "node-action", entrypoint: "main.mjs", page: null,
      actions: [action], stateVersion: 1, evidenceIds: [] }, cases });
  assert.equal(report.status, "passed", JSON.stringify(report));
  for (const [index, result] of report.results.entries()) {
    assert.equal(result.actionExecuted, false); assert.equal(result.admission.target, cases[index].inputTarget);
    assert.ok(result.admission.bytes > result.admission.limit);
    assert.deepEqual(result.actual, INPUT_REJECTION_RESULT);
    assert.deepEqual(result.actual, ACCEPTANCE_ADAPTER_GUIDE.adapters["input-contract"].executionFacts.resultContract.value);
    assert.deepEqual(Object.fromEntries(Object.keys(INPUT_REJECTION_REPORT_METADATA).map((key) => [key, result[key]])), INPUT_REJECTION_REPORT_METADATA);
    assert.deepEqual(Object.keys(result.admission).sort(), ["bytes", "limit", "target"]);
  }
  const metadataAssertion = { id: "report_is_not_action_output", kind: "input-rejection", actionId: action.id, input: "{}", mocks: [],
    assertions: [{ path: "admission.target", expectedJson: '"action-value"' }] };
  const invalid = await executor.verify({ snapshot: await inspectDevelopmentCode(codeDir), entrypoint: "main.mjs", runtime: "node-action",
    application: { protocolVersion: 2, runtime: "node-action", entrypoint: "main.mjs", page: null, actions: [action], stateVersion: 1, evidenceIds: [] },
    cases: [metadataAssertion] });
  assert.equal(invalid.status, "failed"); assert.equal(invalid.results[0].reason, "assertion_mismatch: admission.target");
  assert.deepEqual(invalid.results[0].actual, INPUT_REJECTION_RESULT);
  assert.equal(invalid.results[0].admission.target, "action-value", "准入测量属于独立报告，不成为生成代码返回字段");
});

const managedApplication = () => ({ protocolVersion: 3, runtime: "managed-service", entrypoint: "service_main.py", page: null,
  actions: [structuredClone(action)], stateVersion: 1, evidenceIds: [], service: { schemaVersion: 1, language: "python", host: "managed",
    entrypoint: "service_main.py", operations: [{ ...structuredClone(action), idempotent: true }], dependencies: { packages: [] },
    dataVersion: 1, capabilities: [] } });

test("托管入口拒绝验收不要求尚未生成的Python入口，不探测或准备服务", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-rejection-without-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [], services = Object.fromEntries(["probe", "prepare", "run", "stop"].map((name) => [name, async () => {
    calls.push(name); throw new Error("SERVICE_MUST_NOT_BE_USED_FOR_INPUT_REJECTION");
  }]));
  const report = await verifyManagedApplication({ services, executor: { run() { throw new Error("CODE_MUST_NOT_RUN"); } },
    agentId: "input_only", snapshot: await inspectDevelopmentCode(root), application: managedApplication(), validateResources: false,
    cases: [sample(512, "task-envelope"), { ...sample(4096), id: "action_limit" }] });
  assert.equal(report.status, "passed", JSON.stringify(report)); assert.equal(report.servicePrepared, false);
  assert.deepEqual(calls, []); assert.equal(report.results.length, 2);
  for (const item of report.results) { assert.equal(item.actionExecuted, false); assert.ok(item.admission.bytes > item.admission.limit); }
});

test("托管真实动作仍须准备服务，缺少入口不会被入口拒绝路径放行", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-action-needs-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [], services = { async probe() { calls.push("probe"); return { available: true }; },
    async prepare() { calls.push("prepare"); throw Object.assign(new Error("missing"), { reason: "service_entrypoint_missing" }); },
    async run() { calls.push("run"); throw new Error("MISSING_ENTRY_MUST_NOT_RUN"); }, async stop() { calls.push("stop"); } };
  const report = await verifyManagedApplication({ services, agentId: "needs_service", snapshot: await inspectDevelopmentCode(root),
    application: managedApplication(), validateResources: false, cases: [{ id: "normal", kind: "action", actionId: action.id,
      input: '{"payload":"x"}', mocks: [], assertions: [{ path: "", expectedJson: "true" }] }] });
  assert.equal(report.status, "error"); assert.equal(report.reason, "service_entrypoint_missing");
  assert.equal(report.servicePrepared, false); assert.deepEqual(calls, ["probe", "prepare"]);
});

test("托管页面的独立Node资源检查实际执行，不提前准备无关Python服务", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-page-check-without-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "ui")); await mkdir(join(root, "checks"));
  await writeFile(join(root, "ui/index.html"), '<main id="sample">页面资料</main>');
  await writeFile(join(root, "checks/page.mjs"), 'import {readFileSync} from "node:fs";process.stdout.write(JSON.stringify({found:readFileSync(new URL("../ui/index.html",import.meta.url),"utf8").includes("sample")}));');
  const application = managedApplication();
  application.page = { entrypoint: "ui/index.html", resources: [{ path: "ui/index.html", sha256: "" }] };
  const executor = new DevelopmentExecutor(), probe = await executor.probe();
  assert.equal(probe.available, true, probe.reason);
  const calls = [], services = Object.fromEntries(["probe", "prepare", "run", "stop"].map((name) => [name, async () => {
    calls.push(name); throw new Error("PYTHON_SERVICE_MUST_NOT_RUN_FOR_NODE_RESOURCE_CHECK");
  }]));
  const report = await verifyManagedApplication({ services, executor, agentId: "page_only", snapshot: await inspectDevelopmentCode(root),
    application, validateResources: false, cases: [{ id: "page", kind: "node-check", entrypoint: "checks/page.mjs", input: "",
      assertions: [{ path: "found", expectedJson: "true" }] }] });
  assert.equal(report.status, "passed", JSON.stringify(report)); assert.equal(report.servicePrepared, false);
  assert.deepEqual(calls, []); assert.equal(report.results[0].kind, "node-check");
  assert.equal(report.results[0].browserVerified, false); assert.deepEqual(report.results[0].actual, { found: true });
});

test("托管动作返回后发生取消，底层验收也不宣布整体通过并清理服务", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-managed-late-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "service_main.py"), "def run(request, ctx): return True\n");
  const controller = new AbortController(), calls = [];
  const services = { async probe() { calls.push("probe"); return { available: true }; }, async prepare() { calls.push("prepare"); },
    async run() { calls.push("run"); controller.abort(new Error("fixture-late-cancel")); return { status: "passed", output: true }; },
    async stop() { calls.push("stop"); } };
  const report = await verifyManagedApplication({ services, agentId: "late_cancel", snapshot: await inspectDevelopmentCode(root),
    application: managedApplication(), signal: controller.signal, cases: [{ id: "normal", kind: "action", actionId: action.id,
      input: '{"payload":"x"}', mocks: [], assertions: [{ path: "", expectedJson: "true" }] }] });
  assert.equal(report.status, "error"); assert.equal(report.summary, "服务验收已取消");
  assert.equal(report.servicePrepared, true); assert.deepEqual(calls, ["probe", "prepare", "run", "stop"]);
});
