import { recordArray } from "./helpers/m7-test-boundaries.mjs";
import type { FixtureNode, TestJson, DevelopmentPlan, DevelopmentApplication, DevelopmentCase } from "../src/contracts/development.mjs";
import type { ApplicationAction, ValueSchema } from "../src/contracts/application.mjs";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import { failureFields } from "./helpers/failure-fields.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePlan } from "../src/development/development-contract.mjs";
import { resolveTestJson, FIXTURE_LIMITS } from "../src/development/development-fixtures.mjs";
import { DevelopmentExecutor } from "../src/development/development-executor.mjs";
import { verifyManagedApplication } from "../src/development/managed-verification.mjs";
import { inspectDevelopmentCode } from "../src/development/development-workspace.mjs";
import { ManagedServiceManager } from "../src/services/managed-service-manager.mjs";
import { ServiceRuntimeStore } from "../src/services/service-runtime.mjs";
import { developmentArchitecture, developmentPlan } from "./helpers/development.mjs";

const object = (properties: Record<string, ValueSchema>): ValueSchema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const literal = (value: string|number|boolean): FixtureNode => ({ op: "value", value });
const fields = (value: Record<string,FixtureNode>): FixtureNode => ({ op: "object", fields: value });
const fixture = (value: FixtureNode): TestJson => ({ fixture: value });
const text: ValueSchema = { type: "string" }, integer: ValueSchema = { type: "integer" };
const input = (count = 240) => fixture(fields({ items: { op: "repeat", count,
  value: fields({ id: { op: "index", start: 1, step: 1 }, text: { op: "text", value: "文", count: 64 } }) } }));
const longText: FixtureNode = { op: "text", value: "ab", count: 10000 };
const action = (): ApplicationAction & Record<string,unknown> => ({ id: "summarize", title: "汇总", inputSchema: object({ items: { type: "array", maxItems: 240,
  items: object({ id: integer, text }) } }), outputSchema: object({ count: integer, total: integer, first: integer, last: integer, text, file: text }), connectionIds: [] });
const application = (): DevelopmentApplication => ({ protocolVersion: 2, runtime: "node-action", entrypoint: "actions.mjs", page: null,
  actions: [action()], stateVersion: 1, evidenceIds: [] });
const actualCase = (): DevelopmentCase & {taskId:string} => ({ id: "large", taskId: "core", acceptanceId: "acceptance", actionId: "summarize", input: input(),
  mocks: [{ capability: "files.read", argsJson: '{"file":"source.txt"}', resultJson: fixture(fields({ text: longText })) },
    { capability: "files.write", argsJson: '{"file":"report.txt","content":"240|28920"}', resultJson: '{"file":"report.txt"}' }],
  assertions: [{ path: "", expectedJson: fixture(fields({ count: literal(240), total: literal(28920), first: literal(1), last: literal(240),
    text: longText, file: literal("report.txt") })) }] });
const rejectedCase = (): DevelopmentCase & {taskId:string} => ({ id: "too_many", taskId: "core", acceptanceId: "acceptance", kind: "input-rejection", actionId: "summarize",
  input: input(241), mocks: [], assertions: [{ path: "", expectedJson: '{"rejected":true,"reason":"input_contract_rejected"}' }] });
function planFixture() {
  const architecture = developmentArchitecture(), old = developmentPlan(architecture);
  const plan: DevelopmentPlan = { ...old, schemaVersion: 2, runtime: "node-action", entrypoint: "actions.mjs", application: application(),
    tasks: old.tasks.map((item) => ({ ...item, files: [...item.files, "actions.mjs"] })),
    cases: old.cases.map((item) => ({ ...actualCase(), id: item.id, taskId: item.taskId, acceptanceId: item.acceptanceId })) };
  return { architecture, plan };
}
async function sourceFixture(t: test.TestContext, language: string) {
  const root = await mkdtemp(join(tmpdir(), "neuma-generated-fixture-")), codeDir = join(root, "source"); await mkdir(codeDir);
  const source = language === "python" ? `def run(request,ctx):
 items=request['input']['items']
 value=ctx.files.read({'file':'source.txt'})
 total=sum(item['id'] for item in items)
 saved=ctx.files.write({'file':'report.txt','content':str(len(items))+'|'+str(total)})
 return {'count':len(items),'total':total,'first':items[0]['id'],'last':items[-1]['id'],'text':value['text'],'file':saved['file']}
` : `export const actions={async summarize(input,ctx){
 const value=await ctx.files.read({file:'source.txt'}), total=input.items.reduce((sum,item)=>sum+item.id,0);
 const saved=await ctx.files.write({file:'report.txt',content:input.items.length+'|'+total});
 return {count:input.items.length,total,first:input.items[0].id,last:input.items.at(-1).id,text:value.text,file:saved.file};}};`;
  await writeFile(join(codeDir, language === "python" ? "main.py" : "actions.mjs"), source);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, codeDir, snapshot: await inspectDevelopmentCode(codeDir) };
}

test("large declarative action inputs and expected values preserve old plan limits and freeze recipes", () => {
  const { architecture, plan } = planFixture();
  const accepted = validatePlan(plan, { architecture });
  assert.deepEqual(accepted, plan);
  assert.deepEqual(validatePlan(structuredClone(plan), { architecture, previousPlan: accepted }), plan);
  const expanded = resolveTestJson(plan.cases[0]!.input);
  assert.ok(expanded.fixture!.bytes > 12000); assert.ok(expanded.fixture!.bytes < 128 * 1024);
  const inline = structuredClone(plan); inline.cases[0]!.input = expanded.text;
  assert.throws(() => validatePlan(inline, { architecture }));
  const reduced = structuredClone(plan); const repeated = objectFields(objectFields(objectFields(objectFields(reduced.cases[0]!.input).fixture).fields).items); repeated.count = Number(repeated.count) - 1;
  assert.throws(() => validatePlan(reduced, { architecture, previousPlan: plan }));
  const equivalent = structuredClone(plan); equivalent.cases[0]!.assertions[0]!.expectedJson = resolveTestJson(equivalent.cases[0]!.assertions[0]!.expectedJson).text;
  assert.throws(() => validatePlan(equivalent, { architecture, previousPlan: plan }));
  const legacy = developmentPlan(architecture);
  assert.deepEqual(validatePlan(legacy, { architecture }), legacy);
  legacy.cases[0]!.input = input();
  assert.throws(() => validatePlan(legacy, { architecture }));
});

test("contract rejection is explicit, schema checked, and cannot substitute real action evidence", () => {
  const { architecture, plan } = planFixture();
  const denied = { ...rejectedCase(), taskId: plan.cases[0]!.taskId, acceptanceId: plan.cases[0]!.acceptanceId };
  plan.cases.push(denied);
  assert.equal(validatePlan(plan, { architecture }).cases.at(-1)!.kind, "input-rejection");
  const ordinary = structuredClone(plan); delete ordinary.cases.at(-1)!.kind;
  assert.throws(() => validatePlan(ordinary, { architecture }));
  const accepted = structuredClone(plan); accepted.cases.at(-1)!.input = input();
  assert.throws(() => validatePlan(accepted, { architecture }));
  const mocks = structuredClone(plan); mocks.cases.at(-1)!.mocks = actualCase().mocks!;
  assert.throws(() => validatePlan(mocks, { architecture }));
  const onlyRejections = structuredClone(plan); onlyRejections.cases = plan.cases.slice(0, -1).map((item) => ({ ...denied, id: item.id, taskId: item.taskId, acceptanceId: item.acceptanceId }));
  assert.throws(() => validatePlan(onlyRejections, { architecture }), /实际验收/);
});

test("frozen fixture input and mocks cannot reorder JSON string contents under a canonical recipe hash", () => {
  const { architecture, plan } = planFixture();
  const value = fixture({ op: "json", value: fields({ first: literal(1), second: literal(2) }) });
  plan.application.actions[0]!.inputSchema = text;
  for (const item of plan.cases) { item.input = structuredClone(value); item.mocks = [{ capability: "files.read", argsJson: structuredClone(value), resultJson: structuredClone(value) }]; }
  validatePlan(plan, { architecture });
  const reordered = (target: unknown) => { objectFields(objectFields(objectFields(target).fixture).value).fields = { second: literal(2), first: literal(1) }; };
  for (const field of ["input", "argsJson", "resultJson"] as const) {
    const revision = structuredClone(plan);
    reordered(field === "input" ? revision.cases[0]!.input : revision.cases[0]!.mocks![0]![field]);
    assert.throws(() => validatePlan(revision, { architecture, previousPlan: plan }), /不能删除或替换/);
  }
});

test("plan fixtures enforce aggregate generated bytes without loosening old inline strings", () => {
  const { architecture, plan } = planFixture();
  const giant = fixture({ op: "text", value: "x".repeat(100), count: 10000 });
  plan.cases = Array.from({ length: 18 }, (_, index) => ({ ...plan.cases[index % plan.cases.length]!, id: "large_" + index,
    assertions: [{ path: "text", expectedJson: giant }] }));
  assert.ok(resolveTestJson(giant).fixture!.bytes < FIXTURE_LIMITS.resultBytes);
  assert.throws(() => validatePlan(plan, { architecture }), (error) => failureFields(error).reason === "fixture_plan_output_limit");
  const oneCase = structuredClone(plan); oneCase.cases = [oneCase.cases[0]!];
  oneCase.cases[0]!.assertions = Array.from({ length: 5 }, (_, index) => ({ path: "part" + index, expectedJson: giant }));
  assert.throws(() => validatePlan(oneCase, { architecture }), (error) => failureFields(error).reason === "fixture_case_output_limit");
});

test("page Node checks keep text expectations in both plan and executor validation", async (t) => {
  const { architecture, plan } = planFixture();
  plan.application.page = { entrypoint: "index.html", resources: [{ path: "index.html", sha256: "" }] };
  plan.tasks[0]!.files.push("index.html", "check.mjs");
  const checked: DevelopmentCase & {taskId:string} = { ...plan.cases[0]!, kind: "node-check", entrypoint: "check.mjs", input: "", assertions: [{ path: "", expectedJson: fixture(literal(true)) }] };
  delete checked.actionId; delete checked.mocks; plan.cases.push(checked);
  assert.throws(() => validatePlan(plan, { architecture }), /Node 检查/);
  const setup = await sourceFixture(t, "javascript");
  await writeFile(join(setup.codeDir, "index.html"), "<!doctype html><title>Test</title>");
  await writeFile(join(setup.codeDir, "check.mjs"), "console.log('true')");
  const executor = new DevelopmentExecutor();
  const report = await executor.verify({ snapshot: await inspectDevelopmentCode(setup.codeDir), entrypoint: "actions.mjs", runtime: "node-action", application: plan.application, cases: [checked] });
  assert.equal(report.status, "error");
});

test("real isolated Node actions receive generated input, large mocked values and artifacts while rejection skips code", async (t) => {
  const executor = new DevelopmentExecutor(), availability = await executor.probe();
  if (!availability.available) { if (process.env.NEUMA_REQUIRE_ISOLATION === "1") assert.fail(availability.reason); return t.skip(availability.reason); }
  const setup = await sourceFixture(t, "javascript");
  let calls = 0; const run = executor.runAction.bind(executor);
  executor.runAction = (...args) => { calls++; return run(...args); };
  const cases = [actualCase(), rejectedCase()], before = structuredClone(cases);
  const report = await executor.verify({ snapshot: setup.snapshot, entrypoint: "actions.mjs", runtime: "node-action", application: application(), cases });
  assert.equal(report.status, "passed", JSON.stringify(report)); assert.equal(calls, 1);
  assert.deepEqual(cases, before);
  assert.equal(report.connectionVerified, false);
  assert.equal(objectFields(report.results[0]!.mockCalls).length, 2); assert.equal(report.results[0]!.actionExecuted, true);
  assert.deepEqual(recordArray(report.results[0]!.fixtures).find((item) => item.field === "input"), { field: "input", ...resolveTestJson(input()).fixture });
  assert.ok(recordArray(report.results[0]!.fixtures).some((item) => item.field === "mocks[0].resultJson"));
  assert.ok(recordArray(report.results[0]!.fixtures).some((item) => item.field === "assertions[0].expectedJson"));
  assert.equal(report.results[1]!.actionExecuted, false); assert.equal(report.results[1]!.stage, "input-validation");
  const falseRejection = { ...rejectedCase(), input: input() };
  const failed = await executor.verify({ snapshot: setup.snapshot, entrypoint: "actions.mjs", runtime: "node-action", application: application(), cases: [falseRejection] });
  assert.equal(failed.status, "failed"); assert.equal(failed.results[0]!.reason, "input_was_accepted"); assert.equal(calls, 1);
});

test("real managed Python verification expands the same fixtures and synchronous capability bridge", {
  skip: process.platform !== "darwin" || process.arch !== "arm64" || !process.env.NEUMA_TEST_SERVICE_PYTHON,
}, async (t) => {
  const setup = await sourceFixture(t, "python");
  const services = new ManagedServiceManager({ rootDir: join(setup.root, "services"), runtimeStore: new ServiceRuntimeStore({ rootDir: process.env.NEUMA_TEST_SERVICE_PYTHON! }) });
  t.after(() => services.close({ permanent: true }));
  const manifest: DevelopmentApplication = { ...application(), protocolVersion: 3, runtime: "managed-service", entrypoint: "main.py",
    service: { schemaVersion: 1, language: "python", host: "managed", entrypoint: "main.py", operations: [action()],
      capabilities: ["files.read", "files.write"], dependencies: { packages: [] }, dataVersion: 1 } };
  let calls = 0; const run = services.run.bind(services);
  services.run = (...args) => { calls++; return run(...args); };
  const report = await verifyManagedApplication({ services, agentId: "fixture-python", snapshot: setup.snapshot, application: manifest, cases: [actualCase(), rejectedCase()] });
  assert.equal(report.status, "passed", JSON.stringify(report)); assert.equal(calls, 1);
  assert.equal(report.runtime!.language, "python"); assert.equal(report.connectionVerified, false);
  assert.equal(objectFields(report.results[0]!.mockCalls).length, 2); assert.equal(report.results[1]!.actionExecuted, false);
  assert.equal(objectFields(report.results[0]!.actual).total, 28920);
  assert.deepEqual(recordArray(report.results[0]!.fixtures).find((item) => item.field === "input"), { field: "input", ...resolveTestJson(input()).fixture });
  const failed = await verifyManagedApplication({ services, agentId: "fixture-python", snapshot: setup.snapshot, application: manifest, cases: [{ ...rejectedCase(), input: input() }] });
  assert.equal(failed.status, "failed"); assert.equal(failed.results[0]!.reason, "input_was_accepted"); assert.equal(calls, 1);
  assert.equal(services.workers.size, 0);
});
