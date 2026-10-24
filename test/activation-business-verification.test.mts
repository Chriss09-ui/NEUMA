import {fixtureTools,recordArray} from "./helpers/m7-test-boundaries.mjs";
import type {DevelopmentPlan,DevelopmentTask} from "../src/contracts/development.mjs";
import type {JsonValue} from "../src/contracts/json.mjs";
import type {DevelopmentApplication,DevelopmentCase,FixtureNode,TestJson} from "../src/contracts/development.mjs";
import type {ValueSchema} from "../src/contracts/application.mjs";
import type {ActivationBusinessHostFactory,ActivationBusinessPlan} from "../src/verification/activation-business-verification.mjs";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PrototypeAgents } from "../src/agents/agent-prototype.mjs";
import { DevelopmentExecutor } from "../src/development/development-executor.mjs";
import { inspectDevelopmentCode } from "../src/development/development-workspace.mjs";
import { ManagedServiceManager } from "../src/services/managed-service-manager.mjs";
import { ServiceRuntimeStore } from "../src/services/service-runtime.mjs";
import { verifyActivationBusiness } from "../src/verification/activation-business-verification.mjs";
import { ACCEPTANCE_ADAPTER_GUIDE, acceptanceEvidenceHash } from "../src/verification/acceptance-contract.mjs";
import { ApplicationTaskStore } from "../src/applications/task-store.mjs";
import { APPLICATION_TASK_INPUT_BYTES } from "../src/runtime/runtime-capability-contract.mjs";
import { validateActionInput } from "../src/applications/application-contract.mjs";
import { DevelopmentArtifacts } from "../src/development/development-artifacts.mjs";
import { PLAN_V3_SCHEMA, validatePlan } from "../src/development/development-contract.mjs";
import { resolveCaseValues } from "../src/development/development-fixtures.mjs";
import type { PathLike } from "fs";
import type { BinaryLike } from "crypto";

const object = (properties:Record<string,ValueSchema>):ValueSchema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const sha256 = (text:BinaryLike) => createHash("sha256").update(text).digest("hex");
const inputSchema = object({ text: { type: "string", maxLength: 100000 } });
const outputSchema = object({ text: { type: "string", maxLength: 100000 }, calls: { type: "integer" }, sha256: { type: "string" } });
const node = `async function echo(input,ctx){
 const previous=await ctx.state.get({});
 const savedState=await ctx.state.set({state:{calls:(previous.state.calls||0)+1},expectedVersion:previous.version});
 const written=await ctx.files.write({file:'reports/output.txt',content:input.text});
 if(!written.saved)throw new Error('not_saved');
 let text='',offset;let page;
 do{page=await ctx.files.read(offset===undefined?{file:'reports/output.txt'}:{file:'reports/output.txt',offset});text+=page.text;offset=page.nextOffset}while(offset!==null);
 return {text,calls:savedState.state.calls,sha256:page.integrity.sha256};
}
export const actions={echo};
export function run(request,ctx){return echo(request.input,ctx)}
`;
const python = `def run(request,ctx):
 inp=request['input'];previous=ctx.state.get({})
 saved_state=ctx.state.set(dict(state=dict(calls=previous['state'].get('calls',0)+1),expectedVersion=previous['version']))
 written=ctx.files.write(dict(file='reports/output.txt',content=inp['text']))
 if not written.get('saved'):raise RuntimeError('not_saved')
 text='';offset=None
 while True:
  args=dict(file='reports/output.txt')
  if offset is not None:args['offset']=offset
  page=ctx.files.read(args);text+=page['text'];offset=page.get('nextOffset')
  if offset is None:break
 return dict(text=text,calls=saved_state['state']['calls'],sha256=page['integrity']['sha256'])
`;

function cases(text:string, unitLength = 7):(DevelopmentCase&{taskId:string})[] {
  const value = (value:string|number):FixtureNode => ({op:"value",value}), textNode:FixtureNode = { op: "text", value: "x".repeat(unitLength), count: text.length / unitLength };
  const data = (fields:Record<string,FixtureNode>):TestJson => ({ fixture: { op: "object", fields } });
  const mocks = [
    { capability: "state.get", argsJson: "{}", resultJson: '{"state":{"calls":99},"version":99,"stateVersion":1}' },
    { capability: "state.set", argsJson: '{"state":{"calls":1},"expectedVersion":0}', resultJson: '{"state":{"calls":99},"version":99,"stateVersion":1}' },
    { capability: "files.write", argsJson: data({ file: value("reports/output.txt"), content: textNode }), resultJson: '{"saved":false}' },
    ...Array.from({ length: Math.ceil(text.length / 24000) || 1 }, (_, index) => ({ capability: "files.read",
      argsJson: JSON.stringify({ file: "reports/output.txt", ...(index ? { offset: index * 24000 } : {}) }), resultJson: '{"text":"FAKE","truncated":false,"nextOffset":null}' })),
  ];
  return ["first", "second"].map((id) => ({ id, taskId: "task", acceptanceId: "development_echo", actionId: "echo", input: data({ text: textNode }), mocks,
    assertions: [{ path: "", expectedJson: data({ text: textNode, calls: value(1), sha256: value(sha256(text)) }) }] }));
}

async function fixture(t: test.TestContext, language:"javascript"|"python" = "javascript", managed = language === "python") {
  const executor = new DevelopmentExecutor(), available = await executor.probe();
  if (!available.available) { t.skip(available.reason); return null; }
  const root = await mkdtemp(join(tmpdir(), "neuma-host-business-test-")), codeDir = join(root, "code"); await mkdir(codeDir);
  const entrypoint = language === "python" ? "action.py" : "actions.mjs";
  await writeFile(join(codeDir, entrypoint), language === "python" ? python : node);
  const snapshot = await inspectDevelopmentCode(codeDir), action = { id: "echo", title: "固定真实通道验证", inputSchema, outputSchema, connectionIds: [] };
  const application:DevelopmentApplication = { protocolVersion: managed ? 3 : 2, runtime: managed ? "managed-service" : "node-action", entrypoint, page: null,
    actions: [action], stateVersion: 1, evidenceIds: [] };
  if (managed) application.service = { schemaVersion: 1, language, host: "managed", entrypoint, operations: [action],
    dependencies: { packages: [] }, capabilities: ["files.write", "files.read", "state.get", "state.set"], dataVersion: 1 };
  const plan:ActivationBusinessPlan&Partial<Pick<DevelopmentPlan,"summary"|"tasks">>&{runtime:"node-action"|"managed-service";application:DevelopmentApplication} = { schemaVersion: 3, runtime: application.runtime, entrypoint, application, cases: cases("x".repeat(70000)),
    activationChecks: [{ acceptanceId: "activation_matrix", caseIds: ["first", "second"] }] };
  const agents = new PrototypeAgents({ config: {}, cwd: root, dataDir: join(root, "untouched-user") }); await agents.ready;
  const user = await agents.storage.directory("original", "workspace", { create: true }); await writeFile(join(user, "sentinel.txt"), "private-data");
  const services = managed ? new ManagedServiceManager({ rootDir: join(root, "original-services"),
    runtimeStore: new ServiceRuntimeStore({ rootDir: process.env.NEUMA_TEST_SERVICE_PYTHON ?? join(root, "runtimes") }) }) : undefined;
  const hostRoots:string[] = [], createHost:ActivationBusinessHostFactory = async (options) => { hostRoots.push(options.workspaceRoot); return agents.activationBusinessHost(options); };
  t.after(async () => { await services?.close({ permanent: true }); await agents.close(); await rm(root, { recursive: true, force: true }); });
  return { root, executor, services, agents, plan, hostRoots, options: { executor, services, agentId: "original", snapshot, plan,
    acceptanceId: "activation_matrix", bindingHash: sha256("current-bound-delivery"), createHost, temporaryDir: root },
    assertClean: async () => {
      assert.equal(await readFile(join(user, "sentinel.txt"), "utf8"), "private-data");
      assert.deepEqual((await readdir(root)).filter((name) => name.startsWith("neuma-activation-business-")), []);
      if (services) assert.deepEqual((await services.catalog()).deliveries, {});
    } };
}

for (const language of ["javascript", "python"] as const) test(`host-business ${language}真实隔离重跑冻结用例，使用实际文件/状态及完整产物快照`, {
  timeout: 90000, skip: language === "python" && !process.env.NEUMA_TEST_SERVICE_PYTHON,
}, async (t) => {
  const f = await fixture(t, language); if (!f) return;
  const result = await verifyActivationBusiness(f.options);
  assert.equal(result.status, "passed", JSON.stringify(result.report)); assert.equal(result.mode, "actual");
  assert.equal(result.report.planHash, acceptanceEvidenceHash(f.plan));
  assert.equal(result.evidenceHash, acceptanceEvidenceHash(result.report));
  assert.equal(result.report.results.length, 2);
  const [first, second] = result.report.results; assert.notEqual(first!.scopeId, second!.scopeId);
  for (const item of result.report.results) {
    assert.equal(item.actionExecuted, true); assert.equal(objectFields(item.actual).calls, 1, "每用例使用不同真实状态范围，不继承上一用例");
    assert.ok(item.calls.every((call) => call.mocked === false));
    assert.equal(item.artifacts.length, 1); assert.equal(item.artifacts[0]!.size, 70000);
    assert.equal(item.artifacts[0]!.sha256, item.artifacts[0]!.downloadedSha256);
  }
  assert.equal(new Set(f.hostRoots).size, 2); await f.assertClean();
});

for (const language of ["javascript", "python"] as const) test(`host-business ${language}混用研发与激活专用冻结用例，真实执行且报告不冒充研发证据`, {
  timeout: 90000, skip: language === "python" && !process.env.NEUMA_TEST_SERVICE_PYTHON,
}, async (t) => {
  const f = await fixture(t, language, true); if (!f) return;
  const dedicated:DevelopmentCase = { ...structuredClone(f.plan.cases[1]!), id: "activation_only", acceptanceId: "activation_matrix" };
  delete dedicated.taskId;
  f.plan.activationCases = [dedicated];
  f.plan.activationChecks![0]!.caseIds = [f.plan.cases[0]!.id, dedicated.id];
  const result = await verifyActivationBusiness(f.options);
  assert.equal(result.status, "passed", JSON.stringify(result.report));
  assert.equal(result.report.planHash, acceptanceEvidenceHash(f.plan));
  assert.equal(result.evidenceHash, acceptanceEvidenceHash(result.report));
  const [development, activation] = result.report.results;
  assert.equal(development!.source, "development"); assert.equal(development!.developmentAcceptanceId, "development_echo");
  assert.equal(activation!.source, "activation"); assert.equal(activation!.acceptanceId, "activation_matrix");
  assert.equal(Object.hasOwn(activation!, "developmentAcceptanceId"), false);
  assert.equal(activation!.caseHash, acceptanceEvidenceHash(dedicated));
  for (const item of result.report.results) {
    assert.equal(item.actionExecuted, true); assert.equal(objectFields(item.actual).calls, 1);
    assert.ok(item.calls.every((call) => call.mocked === false));
    assert.equal(item.artifacts[0]!.sha256, item.artifacts[0]!.downloadedSha256);
    assert.deepEqual(item.failedAssertionPaths, []);
  }
  await f.assertClean();
});

for (const language of ["javascript", "python"] as const) test(`host-business ${language}显式共享组按顺序复用真实状态与文件并冻结每次独立产物`, {
  timeout: 90000, skip: language === "python" && !process.env.NEUMA_TEST_SERVICE_PYTHON,
}, async (t) => {
  const f = await fixture(t, language, true); if (!f) return;
  f.plan.activationCases = ["alpha", "beta"].map((text, index) => ({ id: `shared_${index}`, acceptanceId: "activation_matrix", kind: "action", actionId: "echo",
    input: JSON.stringify({ text }), mocks: [
      { capability: "state.get", argsJson: "{}", resultJson: '{"state":{"calls":99},"version":99}' },
      { capability: "state.set", argsJson: JSON.stringify({ state: { calls: index + 1 }, expectedVersion: index }), resultJson: '{"state":{"calls":99},"version":99}' },
      { capability: "files.write", argsJson: JSON.stringify({ file: "reports/output.txt", content: text }), resultJson: '{"saved":false}' },
      { capability: "files.read", argsJson: '{"file":"reports/output.txt"}', resultJson: '{"text":"FAKE"}' },
    ], assertions: [{ path: "", expectedJson: JSON.stringify({ text, calls: index + 1, sha256: sha256(text) }) }] }));
  f.plan.activationChecks![0] = { acceptanceId: "activation_matrix", executionScope: "shared", caseIds: ["shared_0", "shared_1"] };
  const result = await verifyActivationBusiness(f.options);
  assert.equal(result.status, "passed", JSON.stringify(result.report)); assert.equal(result.report.executionScope, "shared");
  const [first, second] = result.report.results;
  assert.equal(first!.scopeId, second!.scopeId); assert.equal(new Set(f.hostRoots).size, 1);
  assert.deepEqual(result.report.results.map((item) => item.actual), [
    { text: "alpha", calls: 1, sha256: sha256("alpha") }, { text: "beta", calls: 2, sha256: sha256("beta") },
  ]);
  for (const item of result.report.results) {
    assert.equal(item.source, "activation"); assert.equal(item.actionExecuted, true);
    assert.equal(item.artifacts[0]!.sha256, item.artifacts[0]!.downloadedSha256);
    assert.equal(item.artifacts[0]!.sha256, sha256(objectFields(item.actual).text as string)); assert.deepEqual(item.failedAssertionPaths, []);
  }
  assert.notEqual(first!.artifacts[0]!.sha256, second!.artifacts[0]!.sha256);
  await f.assertClean();
});

for (const language of ["javascript", "python"] as const) test(`host-business ${language}共享常驻worker能发现逐例重启掩盖的跨调用污染`, {
  timeout: 90000, skip: language === "python" && !process.env.NEUMA_TEST_SERVICE_PYTHON,
}, async (t) => {
  const f = await fixture(t, language, true); if (!f) return;
  assert.equal(ACCEPTANCE_ADAPTER_GUIDE.adapters["host-business"].executionFacts.sharedWorkerReuse[f.plan.runtime], true);
  const valueSchema = object({ value: { type: "integer" } });
  const action = { id: "sum", title: "固定累加污染检测", inputSchema: valueSchema, outputSchema: valueSchema, connectionIds: [] };
  f.plan.application!.actions = [action]; f.plan.application.service!.operations = [action]; f.plan.application.service!.capabilities = [];
  const source = language === "python" ? "total=0\ndef run(request,ctx):\n global total\n total+=request['input']['value']\n return dict(value=total)\n"
    : "let total=0;export const actions={sum:async({value})=>({value:total+=value})};\n";
  await writeFile(join(f.options.snapshot.path, f.plan.entrypoint), source);
  f.options.snapshot = await inspectDevelopmentCode(f.options.snapshot.path);
  f.plan.activationCases = [1, 2].map((value, index) => ({ id: `pollution_${index}`, acceptanceId: "activation_matrix", kind: "action", actionId: "sum",
    input: JSON.stringify({ value }), mocks: [], assertions: [{ path: "value", expectedJson: String(value) }] }));
  f.plan.activationChecks![0]!.caseIds = f.plan.activationCases.map((item) => item.id);
  const isolated = await verifyActivationBusiness(f.options);
  assert.equal(isolated.status, "passed"); assert.deepEqual(isolated.report.results.map((item) => objectFields(item.actual).value), [1, 2]);
  f.plan.activationChecks![0]!.executionScope = "shared";
  const shared = await verifyActivationBusiness(f.options);
  assert.equal(shared.status, "failed", JSON.stringify(shared.report));
  assert.deepEqual(shared.report.results.map((item) => objectFields(item.actual).value), [1, 3]);
  assert.equal(shared.report.results[0]!.scopeId, shared.report.results[1]!.scopeId);
  assert.equal(shared.report.results[1]!.reason, "activation_assertion_mismatch");
  assert.deepEqual(shared.report.results[1]!.failedAssertionPaths, ["value"]);
  await f.assertClean();
});

test("host-business内置共享组复用真实数据，仍按正式方式逐次隔离模块内存", { timeout: 30000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  assert.equal(ACCEPTANCE_ADAPTER_GUIDE.adapters["host-business"].executionFacts.sharedWorkerReuse[f.plan.runtime], false);
  await writeFile(join(f.options.snapshot.path, f.plan.entrypoint), "let calls=0;" + node.replace("calls:savedState.state.calls", "calls:savedState.state.calls,memory:++calls"));
  f.options.snapshot = await inspectDevelopmentCode(f.options.snapshot.path);
  f.plan.application!.actions[0]!.outputSchema = object({ ...outputSchema.properties, memory: { type: "integer" } });
  f.plan.activationCases = ["alpha", "beta"].map((text, index) => ({ id: `shared_${index}`, acceptanceId: "activation_matrix", kind: "action", actionId: "echo",
    input: JSON.stringify({ text }), mocks: [
      { capability: "state.get", argsJson: "{}", resultJson: "null" },
      { capability: "state.set", argsJson: JSON.stringify({ state: { calls: index + 1 }, expectedVersion: index }), resultJson: "null" },
      { capability: "files.write", argsJson: JSON.stringify({ file: "reports/output.txt", content: text }), resultJson: "null" },
      { capability: "files.read", argsJson: '{"file":"reports/output.txt"}', resultJson: "null" },
    ], assertions: [{ path: "", expectedJson: JSON.stringify({ text, calls: index + 1, memory: 1, sha256: sha256(text) }) }] }));
  f.plan.activationChecks![0] = { acceptanceId: "activation_matrix", executionScope: "shared", caseIds: f.plan.activationCases.map((item) => item.id) };
  const result = await verifyActivationBusiness(f.options);
  assert.equal(result.status, "passed", JSON.stringify(result.report));
  assert.equal(result.report.results[0]!.scopeId, result.report.results[1]!.scopeId);
  assert.equal(new Set(f.hostRoots).size, 1);
  assert.deepEqual(result.report.results.map((item) => [objectFields(item.actual).calls, objectFields(item.actual).memory]), [[1, 1], [2, 1]]);
  await f.assertClean();
});

test("激活专用用例不能跨验收绑定、碰撞研发ID或以模拟回执替代真实宿主", { timeout: 30000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const dedicated:DevelopmentCase = { ...structuredClone(f.plan.cases[0]!), id: "activation_only", acceptanceId: "activation_matrix" };
  delete dedicated.taskId; f.plan.activationCases = [dedicated]; f.plan.activationChecks![0]!.caseIds = [dedicated.id];
  for (const [mutate, reason] of [
    [(plan:ActivationBusinessPlan) => { plan.activationCases![0]!.acceptanceId = "another_activation"; }, "activation_case_acceptance_mismatch"],
    [(plan:ActivationBusinessPlan) => { plan.activationCases![0]!.id = plan.cases[0]!.id; }, "activation_case_reference_invalid"],
    [(plan:ActivationBusinessPlan) => { plan.activationChecks!.push({ acceptanceId: "another_activation", caseIds: [dedicated.id] }); }, "activation_case_acceptance_mismatch"],
  ] as const) {
    const plan = structuredClone(f.plan); mutate!(plan);
    const result = await verifyActivationBusiness({ ...f.options, plan });
    assert.equal(result.status, "error"); assert.equal(result.report.reason, reason); assert.deepEqual(result.report.results, []);
    await f.assertClean();
  }
  const fake = await verifyActivationBusiness({ ...f.options, createHost: async () => async () => ({ saved: true,
    integrity: { sha256: sha256("x".repeat(70000)), bytes: 70000 } }) });
  assert.equal(fake.status, "error"); assert.equal(fake.report.results[0]!.reason, "activation_artifact_integrity_failed");
  await f.assertClean();
});

test("激活专用用例输出错误、未处理异常和取消都不能交付或留下工作范围", { timeout: 30000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const dedicated:DevelopmentCase = { ...structuredClone(f.plan.cases[0]!), id: "activation_only", acceptanceId: "activation_matrix", mocks: [] };
  delete dedicated.taskId; f.plan.activationCases = [dedicated]; f.plan.activationChecks![0]!.caseIds = [dedicated.id];
  const entrypoint = join(f.options.snapshot.path, "actions.mjs");
  await writeFile(entrypoint, "export const actions={echo(){return {text:7,calls:1,sha256:'invalid'}}};\n");
  f.options.snapshot = await inspectDevelopmentCode(f.options.snapshot.path);
  const invalidOutput = await verifyActivationBusiness(f.options);
  assert.equal(invalidOutput.status, "failed"); assert.equal(invalidOutput.report.results[0]!.reason, "action_output_schema_mismatch");
  assert.equal(invalidOutput.report.results[0]!.source, "activation"); await f.assertClean();
  await writeFile(entrypoint, "export const actions={echo(){throw new Error('fixed unhandled failure')}};\n");
  f.options.snapshot = await inspectDevelopmentCode(f.options.snapshot.path);
  const crashed = await verifyActivationBusiness(f.options);
  assert.equal(crashed.status, "failed"); assert.equal(crashed.report.results[0]!.actionExecuted, false); await f.assertClean();
  await writeFile(entrypoint, node); f.options.snapshot = await inspectDevelopmentCode(f.options.snapshot.path);
  f.plan.activationCases![0]!.mocks = structuredClone(f.plan.cases[0]!.mocks!);
  f.plan.activationChecks![0]!.executionScope = "shared";
  const controller = new AbortController(); let entered!:()=>void, ended = false;
  const started = new Promise<void>((resolve)=>{entered=resolve;});
  const pending = verifyActivationBusiness({ ...f.options, signal: controller.signal, createHost: async () => async ({ signal }) => {
    entered(); await new Promise<void>((resolve)=>{if(signal!.aborted) resolve(); else signal!.addEventListener("abort",()=>resolve(), { once: true }); });
    ended = true; signal!.throwIfAborted();
  } });
  await started; controller.abort(); await assert.rejects(pending, { name: "AbortError" });
  assert.equal(ended, true); await f.assertClean();
});

for (const language of ["javascript", "python"] as const) test(`host-business ${language}原生NUL数据经规划冻结后实际交付完整JSON与CSV`, {
  timeout: 90000, skip: language === "python" && !process.env.NEUMA_TEST_SERVICE_PYTHON,
}, async (t) => {
  const f = await fixture(t, language); if (!f) return;
  const label = '部门\0,"😀尾', input = { label };
  const json = JSON.stringify({ value: label }), csv = 'label,count\r\n"' + label.replaceAll('"', '""') + '",1\r\n';
  const expected = { label, json, csv, jsonSha: sha256(json), csvSha: sha256(csv) };
  const action = { id: "export", title: "固定UTF8产物", inputSchema: object({ label: { type: "string", maxLength: 40 } }),
    outputSchema: object({ label: { type: "string" }, json: { type: "string" }, csv: { type: "string" },
      jsonSha: { type: "string" }, csvSha: { type: "string" } }), connectionIds: [] };
  const source = language === "python" ? `import json
def run(request,ctx):
 label=request['input']['label']
 json_text=json.dumps(dict(value=label),ensure_ascii=False,separators=(',',':'))
 csv_text='label,count\\r\\n"'+label.replace('"','""')+'",1\\r\\n'
 for file,content in [('reports/output.json',json_text),('reports/output.csv',csv_text)]:
  if not ctx.files.write(dict(file=file,content=content))['saved']:raise RuntimeError('not_saved')
 j=ctx.files.read(dict(file='reports/output.json'));c=ctx.files.read(dict(file='reports/output.csv'))
 return dict(label=json.loads(j['text'])['value'],json=j['text'],csv=c['text'],jsonSha=j['integrity']['sha256'],csvSha=c['integrity']['sha256'])
` : `export const actions={export:async function(input,ctx){
 const json=JSON.stringify({value:input.label}),csv='label,count\\r\\n"'+input.label.replaceAll('"','""')+'",1\\r\\n';
 for(const [file,content] of [['reports/output.json',json],['reports/output.csv',csv]]){
  if(!(await ctx.files.write({file,content})).saved)throw new Error('not_saved');
 }
 const j=await ctx.files.read({file:'reports/output.json'}),c=await ctx.files.read({file:'reports/output.csv'});
 return {label:JSON.parse(j.text).value,json:j.text,csv:c.text,jsonSha:j.integrity.sha256,csvSha:c.integrity.sha256};
}};
`;
  await writeFile(join(f.options.snapshot.path, f.plan.entrypoint), source);
  f.options.snapshot = await inspectDevelopmentCode(f.options.snapshot.path);
  f.plan.summary = "固定UTF8正文及NUL保真验收";
  f.plan.application!.actions = [action];
  if (f.plan.application!.service) Object.assign(f.plan.application!.service, { operations: [action], capabilities: ["files.write", "files.read"] });
  f.plan.tasks = [{ id: "task", title: "完整文件交付", description: "保留合法输入字段并交付原始UTF8文件",
    requirementIds: ["task", "deliverable"], acceptanceIds: ["development_export"], dependsOn: [], files: [f.plan.entrypoint] }];
  const data = (value:JsonValue):TestJson => ({ fixture: { op: "value", value } });
  f.plan.cases = [{ id: "nul_export", taskId: "task", acceptanceId: "development_export", kind: "action", actionId: action.id,
    input: data(input), mocks: [
      ...([["reports/output.json", json], ["reports/output.csv", csv]] as const).map(([file, content]) => ({ capability: "files.write",
        argsJson: data({ file, content }), resultJson: '{"saved":false}' })),
      ...["reports/output.json", "reports/output.csv"].map((file) => ({ capability: "files.read", argsJson: JSON.stringify({ file }), resultJson: '{"text":"FAKE"}' })),
    ], assertions: [{ path: "", expectedJson: data(expected) }] }];
  f.plan.activationChecks = [{ acceptanceId: "activation_matrix", caseIds: ["nul_export"] }];
  const architecture = { requirements: [{ id: "task" }, { id: "deliverable" }], design: { schemaVersion: 3,
    execution: { language, hosting: language === "python" ? "managed" : "builtin" },
    acceptance: [{ id: "development_export", requirementIds: ["task", "deliverable"], verification: { stage: "development", owner: "generated-code", adapterId: "action" } },
      { id: "activation_matrix", requirementIds: ["task", "deliverable"], verification: { stage: "activation", owner: "platform", adapterId: "host-business" } }] } };
  const artifacts = new DevelopmentArtifacts({ dataDir: join(f.root, "planning-data") });
  const tools = fixtureTools(await artifacts.tools("original", "nul_run", { casesSchema: PLAN_V3_SCHEMA.properties.cases, planSchema: PLAN_V3_SCHEMA, architecture }));
  const call = (name: string, args: unknown) => tools[name]!.execute("fixed", args);
  const { cases: caseRows, ...index } = f.plan;
  await call("save_plan_json", { path: "index.json", value: { ...index, caseFiles: ["cases/nul.json"] } });
  await call("save_plan_cases", { path: "cases/nul.json", cases: caseRows });
  const submitted = await artifacts.submit("original", "nul_run", "index.json");
  try {
    const validated=validatePlan(submitted.plan,{architecture});assert.notEqual(validated.runtime,"node-json");if(validated.runtime==="node-json")throw new Error("Expected action plan");f.options.plan=validated;
    assert.deepEqual(resolveCaseValues(f.options.plan.cases[0]).input, input);
    assert.deepEqual((await artifacts.validateSnapshot(submitted.snapshot)).plan, f.options.plan);
    const bytes = await readFile(join(submitted.snapshot.path, "cases/nul.json"));
    assert.equal(bytes.includes(0), false, "规划JSON正文以合法转义保留NUL数据，不放宽代码文本规则");
    const result = await verifyActivationBusiness(f.options);
    assert.equal(result.status, "passed", JSON.stringify(result.report));
    const item = result.report.results[0];
    assert.equal(item!.actionExecuted, true); assert.deepEqual(item!.actual, expected);
    assert.deepEqual(item!.artifacts.map(({ path, size, sha256: hash, downloadedSha256 }) => ({ path, size, hash, downloadedSha256 })),
      ([["reports/output.json", json], ["reports/output.csv", csv]] as const).map(([path, content]) => ({ path, size: Buffer.byteLength(content!), hash: sha256(content!), downloadedSha256: sha256(content!) })));
    assert.ok(item!.calls.every((entry) => entry.mocked === false));
    await f.assertClean();
  } finally {
    const unseal = async (path:string) => {
      await chmod(path, 0o700);
      for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await unseal(join(path, entry.name));
    };
    await unseal(submitted.snapshot.path);
  }
});

test("同一host-business验收的多个冻结用例实际持久化各自正向输入，再独立执行和核对结果", { timeout: 30000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const texts = ["x".repeat(14), "x".repeat(98000)];
  f.plan.cases = texts.map((text, index) => ({ ...cases(text, 14)[index]!, kind: "action" }));
  const original=ApplicationTaskStore.prototype.create,admitted:{bytes:number;input:unknown;created:boolean}[]=[];
  t.mock.method(ApplicationTaskStore.prototype, "create", async function(this:ApplicationTaskStore,id:string,input:Parameters<ApplicationTaskStore["create"]>[1]) {
    const result = await original.call(this, id, input), persisted = await this.get(id, result.task.id);
    assert.deepEqual(persisted.input, input.input);
    admitted.push({ bytes: Buffer.byteLength(JSON.stringify(input)), input: persisted.input, created: result.created });
    return result;
  });
  const result = await verifyActivationBusiness(f.options);
  assert.equal(result.status, "passed", JSON.stringify(result.report));
  assert.deepEqual(admitted.map((entry) => objectFields(entry.input).text), texts);
  assert.ok(admitted.every((entry) => entry.created && entry.bytes < APPLICATION_TASK_INPUT_BYTES));
  assert.deepEqual(result.report.results.map((entry) => entry.caseId), ["first", "second"]);
  assert.deepEqual(result.report.results.map((entry) => objectFields(entry.actual).text), texts);
  assert.ok(result.report.results.every((entry) => entry.actionExecuted && entry.failedAssertionPaths!.length === 0));
  assert.notEqual(result.report.results[0]!.scopeId, result.report.results[1]!.scopeId);
  await f.assertClean();
});

async function workflowFixture(t: test.TestContext, { waits = true, slow = false } = {}) {
  const f = await fixture(t, "javascript", true); if (!f) return null;
  const action = { id: "whole", title: "固定分批真实流程", inputSchema: object({ texts: { type: "array", items: { type: "string" } } }),
    outputSchema: object({ parts: { type: "array", items: outputSchema }, title: { type: "string" } }), connectionIds: [] };
  const internal = { ...f.plan.application!.actions[0], visibility: "internal" };
  const finish = { id: "finish", inputSchema: action.outputSchema, outputSchema: action.outputSchema, visibility: "internal", connectionIds: [] };
  const workflow = { schemaVersion: 1, entryActionId: "whole", steps: [
    { id: "batch", actionId: "echo", dependsOn: [], idempotent: true, input: { text: { $item: true } }, batch: { inputPath: "texts", maxItems: 3 } },
    { id: "report", actionId: "finish", dependsOn: ["batch"], idempotent: true,
      input: { parts: { $step: "batch" }, title: waits ? { $response: true } : "固定标题" },
      ...(waits ? { waitForInput: { prompt: "确认标题", inputSchema: { type: "string" } } } : {}) },
  ], outputs: ["report"] };
  f.plan.application!.actions = [action];
  Object.assign(f.plan.application!.service!, { operations: [action, internal, finish], workflow,
    ...(slow ? { resources: { timeoutMs: 50 } } : {}) });
  const code = node.slice(0, node.indexOf("export const actions="))
    + `export const actions={echo,finish:async input=>{${slow ? "await new Promise(resolve=>setTimeout(resolve,1000));" : ""}return input}};\n`;
  await writeFile(join(f.options.snapshot.path, "actions.mjs"), code);
  f.options.snapshot = await inspectDevelopmentCode(f.options.snapshot.path);
  const texts = ["first", "second"];
  const mocks = texts.flatMap((text, index) => [
    { capability: "state.get", argsJson: "{}", resultJson: '{"state":{"calls":99},"version":99,"stateVersion":1}' },
    { capability: "state.set", argsJson: JSON.stringify({ state: { calls: index + 1 }, expectedVersion: index }), resultJson: '{"state":{"calls":99},"version":99,"stateVersion":1}' },
    { capability: "files.write", argsJson: JSON.stringify({ file: "reports/output.txt", content: text }), resultJson: '{"saved":false}' },
    { capability: "files.read", argsJson: '{"file":"reports/output.txt"}', resultJson: '{"text":"FAKE","truncated":false,"nextOffset":null}' },
  ]);
  f.plan.cases = ["first", "second"].map((id) => ({ id, taskId: "task", acceptanceId: "development_echo", kind: "action", actionId: "whole",
    input: JSON.stringify({ texts }), mocks, ...(waits ? { workflowInputs: [{ stepId: "report", inputJson: '"固定标题"' }] } : {}),
    assertions: [{ path: "", expectedJson: JSON.stringify({ parts: texts.map((text, index) => ({ text, calls: index + 1, sha256: sha256(text) })), title: "固定标题" }) }] }));
  return f;
}

for (const waits of [false, true]) test(`host-business通过正式流程入口执行批次${waits ? "并按冻结回复恢复等待步骤" : "，不直接调用不存在的公开函数"}`, { timeout: 30000 }, async (t) => {
  const f = await workflowFixture(t, { waits }); if (!f) return;
  const result = await verifyActivationBusiness(f.options);
  assert.equal(result.status, "passed", JSON.stringify(result.report));
  assert.notEqual(result.report.results[0]!.scopeId, result.report.results[1]!.scopeId);
  for (const item of result.report.results) {
    assert.equal(objectFields(item.workflow).status, "completed"); assert.deepEqual(objectFields(item.workflow).completedSteps, ["batch", "report"]);
    assert.equal(objectFields(item.workflow).batchItems, 3); assert.deepEqual(recordArray(objectFields(item.actual).parts).map((part) => part.calls), [1, 2]);
    assert.equal(objectFields(item.actual).title, "固定标题"); assert.equal(item.artifacts.length, 2);
    assert.notEqual(item.artifacts[0]!.sha256, item.artifacts[1]!.sha256);
    assert.ok(item.artifacts.every((artifact) => artifact.sha256 === artifact.downloadedSha256));
    assert.ok(item.calls.every((call) => call.mocked === false));
  }
  await f.assertClean();
});

test("host-business流程缺少回复、回复顺序错误和实际步骤超时均不得通过", { timeout: 30000 }, async (t) => {
  const f = await workflowFixture(t); if (!f) return;
  f.plan.activationChecks![0]!.caseIds = ["first"];
  const missing = structuredClone(f.plan); missing.cases[0]!.workflowInputs = [];
  const waiting = await verifyActivationBusiness({ ...f.options, plan: missing });
  assert.equal(waiting.status, "failed"); assert.equal(objectFields(waiting.report.results[0]!.workflow).status, "waiting_input");
  assert.equal(waiting.report.results[0]!.reason, "workflow_input_fixture_missing"); await f.assertClean();
  const wrong = structuredClone(f.plan); wrong.cases[0]!.workflowInputs![0]!.stepId = "batch";
  const outOfOrder = await verifyActivationBusiness({ ...f.options, plan: wrong });
  assert.equal(outOfOrder.status, "error"); assert.equal(outOfOrder.report.reason, "activation_workflow_input_order_mismatch"); await f.assertClean();
  const slow = await workflowFixture(t, { waits: false, slow: true }); if (!slow) return;
  slow.plan.activationChecks![0]!.caseIds = ["first"];
  const timeout = await verifyActivationBusiness(slow.options);
  assert.equal(timeout.status, "failed", JSON.stringify(timeout.report)); assert.equal(objectFields(timeout.report.results[0]!.workflow).status, "failed");
  assert.equal(timeout.report.results[0]!.reason, "workflow_retry_budget_exhausted"); await slow.assertClean();
});

test("host-business流程取消沿现有调度器终止真实步骤，回收工作进程和私有临时范围", { timeout: 30000 }, async (t) => {
  const f = await workflowFixture(t); if (!f) return;
  const controller = new AbortController(); let entered!:()=>void, ended = false;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const pending = verifyActivationBusiness({ ...f.options, signal: controller.signal, createHost: async () => async ({ signal }) => {
    entered(); await new Promise<void>((resolve) => { if (signal!.aborted) resolve(); else signal!.addEventListener("abort", () => resolve(), { once: true }); });
    ended = true; signal!.throwIfAborted();
  } });
  await started; controller.abort(); await assert.rejects(pending, { name: "AbortError" });
  assert.equal(ended, true); await f.assertClean();
});

test("host-business不返回模拟回执，缺真实文件、断言失败、未使用调用和外部能力均保留阻断", { timeout: 30000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const fake = await verifyActivationBusiness({ ...f.options, createHost: async () => async () => ({ saved: true, integrity: { sha256: sha256("x".repeat(70000)), bytes: 70000 } }) });
  assert.equal(fake.status, "error"); assert.equal(fake.report.results[0]!.reason, "activation_artifact_integrity_failed"); await f.assertClean();
  const wrong = structuredClone(f.plan); wrong.cases[0]!.assertions = [{ path: "calls", expectedJson: "99" }];
  const mismatch = await verifyActivationBusiness({ ...f.options, plan: wrong });
  assert.equal(mismatch.status, "failed"); assert.equal(mismatch.report.results[0]!.reason, "activation_assertion_mismatch"); await f.assertClean();
  const unused = structuredClone(f.plan); unused.cases[0]!.mocks!.push({ capability: "files.list", argsJson: "{}", resultJson: '{"files":[]}' });
  const notCalled = await verifyActivationBusiness({ ...f.options, plan: unused });
  assert.equal(notCalled.status, "failed"); assert.equal(notCalled.report.results[0]!.reason, "activation_capability_unused");
  const external = structuredClone(f.plan); external.cases[0]!.mocks = [{ capability: "connection.call", argsJson: '{"connectionId":"private","operationId":"write","input":{}}', resultJson: '{"written":true}' }];
  external.activationChecks![0]!.caseIds = ["first"];
  const unsupported = await verifyActivationBusiness({ ...f.options, plan: external, createHost: () => { throw new Error("must not call any host"); } });
  assert.equal(unsupported.status, "not_run"); assert.equal(unsupported.report.results[0]!.reason, "activation_capability_unsupported"); await f.assertClean();
});

test("host-business入口拒绝复用正式校验器，不执行生成动作或宿主能力", async (t) => {
  const f = await fixture(t); if (!f) return;
  const plan = structuredClone(f.plan);
  plan.cases = [{ id: "bad_input", taskId: "task", acceptanceId: "admission", kind: "input-rejection", actionId: "echo",
    input: '{"text":true}', mocks: [], assertions: [{ path: "", expectedJson: '{"rejected":true,"reason":"input_contract_rejected"}' }] }];
  plan.activationChecks![0]!.caseIds = ["bad_input"];
  const result = await verifyActivationBusiness({ ...f.options, plan, createHost: () => { throw new Error("must not run"); } });
  assert.equal(result.status, "passed"); assert.equal(result.report.results[0]!.actionExecuted, false);
  assert.deepEqual(result.report.results[0]!.calls, []); await f.assertClean();
});

test("激活专用入口拒绝区分真实动作值和完整任务信封限额，不创建任务或执行业务", async (t) => {
  const f = await fixture(t); if (!f) return;
  f.plan.application!.actions[0]!.inputSchema = object({ payload: {} });
  f.plan.activationCases = ([["action-value", 105], ["task-envelope", 14]] as const).map(([inputTarget, width], index) => ({
    id: `admission_${index}`, acceptanceId: "activation_matrix", kind: "input-rejection", inputTarget, actionId: "echo",
    input: { fixture: { op: "object", fields: { payload: { op: "text", value: "x".repeat(width!), count: 10000 } } } },
    mocks: [], assertions: [{ path: "", expectedJson: '{"rejected":true,"reason":"input_contract_rejected"}' }],
  }));
  f.plan.activationChecks![0]!.caseIds = f.plan.activationCases!.map((item) => item.id);
  let creates = 0, executions = 0;
  t.mock.method(ApplicationTaskStore.prototype, "create", async () => { creates++; throw new Error("must not create task"); });
  t.mock.method(f.executor, "runAction", async () => { executions++; throw new Error("must not run action"); });
  const result = await verifyActivationBusiness({ ...f.options, createHost: () => { throw new Error("must not call host"); } });
  assert.equal(result.status, "passed", JSON.stringify(result.report));
  assert.equal(creates, 0); assert.equal(executions, 0);
  assert.deepEqual(result.report.results.map((item) => objectFields(item.admission).target), ["action-value", "task-envelope"]);
  assert.deepEqual(result.report.results.map((item) => objectFields(item.admission).limit), [1024 * 1024, APPLICATION_TASK_INPUT_BYTES]);
  for (const item of result.report.results) {
    assert.equal(item.source, "activation"); assert.equal(item.actionExecuted, false);
    const admission=objectFields(item.admission); assert.ok(typeof admission.bytes === "number" && typeof admission.limit === "number" && admission.bytes > admission.limit); assert.deepEqual(item.calls, []); assert.deepEqual(item.artifacts, []);
  }
  await f.assertClean();
});

test("host-business真实创建合法输入任务并执行约定业务拒绝，未处理异常不能冒充正确拒绝", { timeout: 30000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const action = { id: "check", title: "固定业务拒绝验证", connectionIds: [],
    inputSchema: object({ records: { type: "array", items: object({ amountCents: { type: "integer" } }) } }),
    outputSchema: object({ accepted: { type: "boolean" }, totalCents: { type: "integer" },
      error: object({ code: { type: "string" }, recordIndex: { type: "integer" } }) }) };
  const input = { records: [{ amountCents: 5 }, { amountCents: -1 }] };
  const expected = { accepted: false, totalCents: 0, error: { code: "negative_amount", recordIndex: 1 } };
  assert.deepEqual(validateActionInput(action, input), input, "结构准入不等于业务已接受");
  f.plan.application!.actions = [action];
  f.plan.cases = [{ id: "business_rejection", taskId: "task", acceptanceId: "controlled_rejection", kind: "action",
    actionId: action.id, input: JSON.stringify(input), mocks: [], assertions: [{ path: "", expectedJson: JSON.stringify(expected) }] }];
  f.plan.activationChecks![0]!.caseIds = ["business_rejection"];
  const entrypoint = join(f.options.snapshot.path, "actions.mjs");
  await writeFile(entrypoint, `export const actions={check(input){
    let totalCents=0;
    for(let index=0;index<input.records.length;index++){
      const amount=input.records[index].amountCents;
      if(amount<0)return {accepted:false,totalCents:0,error:{code:'negative_amount',recordIndex:index}};
      totalCents+=amount;
    }
    return {accepted:true,totalCents,error:{code:'',recordIndex:-1}};
  }};\n`);
  f.options.snapshot = await inspectDevelopmentCode(f.options.snapshot.path);
  const original = ApplicationTaskStore.prototype.create, admissions:{input:unknown;[key:string]:unknown}[] = [];
  t.mock.method(ApplicationTaskStore.prototype, "create", async function(this:ApplicationTaskStore,id:string,request:Parameters<ApplicationTaskStore["create"]>[1]) {
    const created = await original.call(this, id, request), persisted = await this.get(id, created.task.id);
    admissions.push({ created: created.created, input: persisted.input }); return created;
  });
  const result = await verifyActivationBusiness(f.options), actual = result.report.results[0];
  assert.equal(result.status, "passed", JSON.stringify(result.report));
  assert.deepEqual(admissions, [{ created: true, input }]);
  assert.equal(actual!.actionExecuted, true); assert.deepEqual(actual!.actual, expected);
  assert.equal(actual!.assertionCount, 1); assert.deepEqual(actual!.failedAssertionPaths, []);
  assert.deepEqual(actual!.calls, []); assert.deepEqual(actual!.artifacts, []); await f.assertClean();
  await writeFile(entrypoint, "export const actions={check(){throw new Error('fixed unhandled business fault')}};\n");
  f.options.snapshot = await inspectDevelopmentCode(f.options.snapshot.path);
  const crashed = await verifyActivationBusiness(f.options);
  assert.equal(crashed.status, "failed"); assert.equal(crashed.report.results[0]!.actionExecuted, false);
  assert.deepEqual(crashed.report.results[0]!.failedAssertionPaths, [""]);
  assert.deepEqual(admissions, [{ created: true, input }, { created: true, input }]); await f.assertClean();
});

test("host-business拒绝旧快照和不存在用例，取消后等待真实宿主调用退出并清理临时范围", { timeout: 30000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const stale = await verifyActivationBusiness({ ...f.options, snapshot: { ...f.options.snapshot, hash: sha256("old-code") } });
  assert.equal(stale.status, "error"); assert.equal(stale.report.reason, "activation_snapshot_changed");
  const missing = structuredClone(f.plan); missing.activationChecks![0]!.caseIds.push("absent");
  assert.equal((await verifyActivationBusiness({ ...f.options, plan: missing })).status, "error");
  const controller = new AbortController(); let entered!:()=>void, ended = false;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const pending = verifyActivationBusiness({ ...f.options, signal: controller.signal, createHost: async () => async ({ signal }) => {
    entered(); await new Promise<void>((resolve) => { if (signal!.aborted) resolve(); else signal!.addEventListener("abort", () => resolve(), { once: true }); });
    ended = true; signal!.throwIfAborted();
  } });
  await started; controller.abort(); await assert.rejects(pending, { name: "AbortError" });
  assert.equal(ended, true); await f.assertClean();
});
