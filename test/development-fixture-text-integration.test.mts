import { recordArray } from "./helpers/m7-test-boundaries.mjs";
import type { FixtureNode, TestJson, DevelopmentPlan, DevelopmentApplication, DevelopmentCase } from "../src/contracts/development.mjs";
import type { ApplicationAction, ValueSchema } from "../src/contracts/application.mjs";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DevelopmentExecutor } from "../src/development/development-executor.mjs";
import { inspectDevelopmentCode } from "../src/development/development-workspace.mjs";
import { resolveTestJson } from "../src/development/development-fixtures.mjs";
import { validatePlan } from "../src/development/development-contract.mjs";
import { ACCEPTANCE_ADAPTER_GUIDE } from "../src/verification/acceptance-contract.mjs";

const literal = (value: string): FixtureNode => ({ op: "value", value });
const object = (fields: Record<string,FixtureNode>): FixtureNode => ({ op: "object", fields });
const fixture = (value: FixtureNode): TestJson => ({ fixture: value });
const measure = (kind: "sha256"|"utf8-bytes"|"utf16-units", value: FixtureNode): FixtureNode => ({ op: "measure", kind, value });
const schema = (properties: Record<string,ValueSchema>): ValueSchema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const text: ValueSchema = { type: "string" }, integer: ValueSchema = { type: "integer" };
const content: FixtureNode = { op: "concat", items: [literal("label,value\n"), { op: "join", separator: "\n", value: { op: "repeat", count: 2000,
  value: { op: "concat", items: [{ op: "index", start: 0, step: 1, prefix: "entry-" }, literal(",中😀")] } } }, literal("\n")] };
function setup() {
  const application: DevelopmentApplication = { protocolVersion: 2, runtime: "node-action", entrypoint: "actions.mjs", page: null, stateVersion: 1, evidenceIds: [],
    actions: [{ id: "store", title: "保存明确文本", connectionIds: [], inputSchema: schema({ text }),
      outputSchema: schema({ digest: text, actualHash: text, bytes: integer, units: integer }) }] };
  const testCase: DevelopmentCase & {taskId:string} = { id: "complete_text", taskId: "store", acceptanceId: "exact_text", kind: "action", actionId: "store",
    input: fixture(object({ text: content })), mocks: [{ capability: "files.write",
      argsJson: fixture(object({ file: literal("complete.txt"), content })),
      resultJson: fixture(object({ integrity: object({ sha256: measure("sha256", content), bytes: measure("utf8-bytes", content), units: measure("utf16-units", content) }) })) }],
    assertions: [{ path: "digest", expectedJson: fixture(measure("sha256", content)) }, { path: "actualHash", expectedJson: fixture(measure("sha256", content)) },
      { path: "bytes", expectedJson: fixture(measure("utf8-bytes", content)) }, { path: "units", expectedJson: fixture(measure("utf16-units", content)) }] };
  const architecture = { requirements: [{ id: "content" }], design: { acceptance: [{ id: "exact_text" }] } };
  const plan: DevelopmentPlan = { schemaVersion: 2, summary: "验证完整文本及计量契约", runtime: "node-action", entrypoint: "actions.mjs", application,
    tasks: [{ id: "store", title: "保存文本", description: "逐字保存并核对原文计量", requirementIds: ["content"], acceptanceIds: ["exact_text"], dependsOn: [], files: ["actions.mjs"] }],
    cases: [testCase] };
  return { application, testCase, architecture, plan };
}

test("新文本夹具经过完整计划契约，冻结后不能以等价结果替换配方或替身", () => {
  const { architecture, plan } = setup();
  assert.doesNotThrow(() => validatePlan(plan, { architecture }));
  assert.doesNotThrow(() => validatePlan(structuredClone(plan), { architecture, previousPlan: plan }));
  const expected = structuredClone(plan);
  expected.cases[0]!.assertions[0]!.expectedJson = JSON.stringify(resolveTestJson(plan.cases[0]!.assertions[0]!.expectedJson).value);
  assert.throws(() => validatePlan(expected, { architecture, previousPlan: plan }), /不能删除或放宽已确认的验收断言/);
  const mocks = structuredClone(plan), args = objectFields(objectFields(objectFields(mocks.cases[0]!.mocks![0]!.argsJson).fixture).fields), original = args.content;
  args.content = { op: "concat", items: [original] };
  assert.deepEqual(resolveTestJson(mocks.cases[0]!.mocks![0]!.argsJson).value, resolveTestJson(plan.cases[0]!.mocks![0]!.argsJson).value);
  assert.throws(() => validatePlan(mocks, { architecture, previousPlan: plan }), /不能删除或替换/);
});

test("真实隔离动作严格匹配大文本替身，原文字节摘要一致且computed占位不会自动展开", async (t) => {
  const executor = new DevelopmentExecutor(), availability = await executor.probe();
  if (!availability.available) { if (process.env.NEUMA_REQUIRE_ISOLATION === "1") assert.fail(availability.reason); return t.skip(availability.reason); }
  const root = await mkdtemp(join(tmpdir(), "neuma-text-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "actions.mjs"), `import {createHash} from 'node:crypto';
export const actions={async store(input,ctx){
 const saved=await ctx.files.write({file:'complete.txt',content:input.text});
 return {digest:saved.integrity.sha256,actualHash:createHash('sha256').update(input.text).digest('hex'),bytes:Buffer.byteLength(input.text),units:input.text.length};
}};`);
  const { application, testCase } = setup(), before = structuredClone(testCase), snapshot = await inspectDevelopmentCode(root);
  const report = await executor.verify({ snapshot, entrypoint: "actions.mjs", runtime: "node-action", application, cases: [testCase] });
  assert.equal(report.status, "passed", JSON.stringify(report)); assert.equal(report.results[0]!.actionExecuted, true);
  assert.equal(objectFields(report.results[0]!.mockCalls).length, 1); assert.deepEqual(testCase, before);
  const actual = "label,value\n" + Array.from({ length: 2000 }, (_, index) => `entry-${index},中😀`).join("\n") + "\n";
  assert.equal(objectFields(report.results[0]!.actual).actualHash, createHash("sha256").update(actual).digest("hex"));
  assert.equal(objectFields(report.results[0]!.actual).bytes, Buffer.byteLength(actual)); assert.equal(objectFields(report.results[0]!.actual).units, actual.length);
  assert.ok(Number(recordArray(report.results[0]!.fixtures).find((item) => item.field === "mocks[0].argsJson")!.bytes) > 12000);
  const placeholder = structuredClone(testCase);
  const placeholderContent = literal("<computed-content>");
  placeholder.mocks![0]!.argsJson = fixture(object({ file: literal("complete.txt"), content: placeholderContent }));
  // Keep the mock internally consistent so the action still reaches strict argument matching.
  placeholder.mocks![0]!.resultJson = fixture(object({ integrity: object({ sha256: measure("sha256", placeholderContent),
    bytes: measure("utf8-bytes", placeholderContent), units: measure("utf16-units", placeholderContent) }) }));
  const rejected = await executor.verify({ snapshot, entrypoint: "actions.mjs", runtime: "node-action", application, cases: [placeholder] });
  assert.equal(rejected.status, "failed"); assert.equal(objectFields(rejected.results[0]!.mockCalls).length, 0);
  assert.equal(ACCEPTANCE_ADAPTER_GUIDE.adapters.action.executionFacts.dynamicPlaceholders, false);
  assert.equal(ACCEPTANCE_ADAPTER_GUIDE.adapters.action.executionFacts.fixtureConstruction.mockArgumentMatching, "deep-strict-equal-expanded-values");
});
