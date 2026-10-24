import { fixtureTools } from "./helpers/m7-test-boundaries.mjs";
import type { DevelopmentCase, TestMock, MaterialCheck } from "../src/contracts/development.mjs";
type SampleCase = DevelopmentCase & { taskId: string; actionId: string; mocks: TestMock[] };
import { callFixture } from "./helpers/m7-test-boundaries.mjs";
import { recordArray } from "./helpers/m7-test-boundaries.mjs";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import type { TestFailure } from "./helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { auditCaseMaterials } from "../src/development/development-test-material-audit.mjs";
import { resolveCaseValues } from "../src/development/development-fixtures.mjs";
import { PLAN_V2_SCHEMA, validatePlan } from "../src/development/development-contract.mjs";
import { diagnosePlanningPlan } from "../src/development/development-plan-diagnostics.mjs";
import { DevelopmentArtifacts } from "../src/development/development-artifacts.mjs";
import type { BinaryLike } from "crypto";
import type { PathLike } from "fs";

const hash = (text: BinaryLike|NonSharedBuffer) => createHash("sha256").update(text).digest("hex");
const check = (measure: MaterialCheck["measure"], expected: string | number, extra: Partial<Omit<MaterialCheck, "measure" | "expected">> = {}): MaterialCheck => ({ source: "input", pointer: "", measure, expected, ...extra });
function sample<T extends object>(extra: T): Omit<SampleCase, keyof T> & T;
function sample(): SampleCase;
function sample(extra = {}) { return ({ id: "sample", taskId: "core", acceptanceId: "result", actionId: "run", input: "{}", mocks: [], assertions: [{ path: "", expectedJson: "true" }], ...extra }); }
const write = (content: string, receipt: unknown) => ({ capability: "files.write", argsJson: JSON.stringify({ file: "result.txt", content }), resultJson: JSON.stringify(receipt) });
function fixture<T extends object>(extra: T) {
  const architecture = { requirements: [{ id: "required" }], design: { schemaVersion: 2, connections: [], interaction: { page: false },
    acceptance: [{ id: "result", requirementIds: ["required"] }] } };
  const plan = { summary: "实现明确处理", schemaVersion: 2, runtime: "node-action", entrypoint: "main.mjs",
    tasks: [{ id: "core", title: "主要处理", description: "完成处理", requirementIds: ["required"], acceptanceIds: ["result"], dependsOn: [], files: ["main.mjs"] }],
    application: { protocolVersion: 2, runtime: "node-action", entrypoint: "main.mjs", page: null, stateVersion: 1, evidenceIds: [],
      actions: [{ id: "run", title: "执行", connectionIds: [], inputSchema: { type: "object", properties: {
        rows: { type: "array", items: { type: "integer" }, maxItems: 100 } }, required: ["rows"], additionalProperties: false }, outputSchema: { type: "boolean" } }] },
    cases: [sample(extra)] };
  return { plan, architecture };
}

test("材料声明核对实际展开数量、原文本与JSON编码，不推导业务正确答案", () => {
  const item = sample({ input: { fixture: { op: "object", fields: { rows: { op: "repeat", count: 20, value: { op: "value", value: 1 } },
    text: { op: "value", value: "中😀" } } } }, materialChecks: [check("array-length", 21, { pointer: "/rows" }),
    check("utf8-bytes", 8, { pointer: "/text", encoding: "text" }), check("sha256", "0".repeat(64), { pointer: "/text", encoding: "text" })] });
  const before = structuredClone(item);
  assert.throws(() => resolveCaseValues(item), (error: TestFailure) => {
    assert.equal(error.reason, "material_fact_mismatch"); assert.equal(objectFields(error.materialIssues).length, 3);
    assert.deepEqual(recordArray(error.materialIssues).map((entry) => entry.path), ["materialChecks[0].expected", "materialChecks[1].expected", "materialChecks[2].expected"]);
    assert.equal(objectFields(objectFields(objectFields(error.materialIssues)[0]).measurement).actual, 20); assert.equal(objectFields(objectFields(objectFields(error.materialIssues)[1]).measurement).actual, 7);
    return true;
  });
  assert.deepEqual(item, before);
  item.materialChecks = [check("array-length", 20, { pointer: "/rows" }), check("utf8-bytes", 7, { pointer: "/text", encoding: "text" }),
    check("utf16-units", 3, { pointer: "/text", encoding: "text" }), check("sha256", hash("中😀"), { pointer: "/text", encoding: "text" })];
  assert.equal(objectFields(objectFields(resolveCaseValues(item).input).rows).length, 20);
  const textInput = sample({ input: JSON.stringify({ text: "a\n" }), materialChecks: [check("utf8-bytes", 4, { pointer: "/text", encoding: "json" })] });
  assert.throws(() => resolveCaseValues(textInput), /材料/);
  textInput.materialChecks[0]!.expected = 5;
  assert.equal(objectFields(resolveCaseValues(textInput).input).text, "a\n");
});

test("写入成功模拟回执须与原字符串一致，字面占位内容本身合法", () => {
  const content = "<computed-result-json>";
  const receipt = { saved: true, file: "result.txt", characters: content.length,
    integrity: { bytes: Buffer.byteLength(content), utf16Units: content.length, sha256: hash(content) } };
  const good = sample({ mocks: [write(content, receipt)] });
  assert.equal(objectFields(resolveCaseValues(good).mocks[0]!.args).content, content);
  for (const field of ["bytes", "utf16Units", "sha256"]) {
    const bad = structuredClone(receipt); Reflect.set(bad.integrity, field, field === "sha256" ? "<computed-result-json-sha256>" : 0);
    assert.throws(() => resolveCaseValues(sample({ mocks: [callFixture(write, undefined, [content, bad])] })), (error) => {
      assert.ok(recordArray(objectFields(error).materialIssues).some((entry) => entry.path === `mocks[0].resultJson.integrity.${field}`)); return true;
    });
  }
  for (const bad of [{ ...receipt, file: "other.txt" }, { ...receipt, characters: content.length - 1 }])
    assert.throws(() => resolveCaseValues(sample({ mocks: [callFixture(write, undefined, [content, bad])] })), /模拟写入回执/);
  const unicode = "中😀";
  assert.equal(resolveCaseValues(sample({ mocks: [write(unicode, { characters: 3, integrity: { bytes: 7, utf16Units: 3, sha256: hash(unicode) } })] })).mocks.length, 1);
  for (const args of [{ file: "result.txt", content: 7 }, { file: "result.txt" }, null])
    assert.throws(() => resolveCaseValues(sample({ mocks: [{ capability: "files.write", argsJson: JSON.stringify(args),
      resultJson: '{"saved":true,"integrity":{"bytes":0}}' }] })), (error) => recordArray(objectFields(error).materialIssues).some((entry) => entry.path === "mocks[0].argsJson.content" && entry.reason === "material_type_mismatch"));
});

test("旧模拟回执缺失元数据保持兼容，失败模拟不冒充成功元数据", () => {
  for (const receipt of [{ saved: true }, { file: "result.txt" }, null, { saved: false, integrity: { bytes: 0 } },
    { error: "unavailable", integrity: { sha256: "failure-details" } }])
    assert.equal(resolveCaseValues(sample({ mocks: [write("literal", receipt)] })).mocks.length, 1);
  assert.throws(() => resolveCaseValues(sample({ mocks: [callFixture(write, undefined, ["literal", { saved: true, error: null, integrity: { bytes: 0 } }])] })), /材料/);
  assert.throws(() => resolveCaseValues(sample({ mocks: [callFixture(write, undefined, ["literal", { saved: true, ok: false, integrity: { bytes: 0 } }])] })), /材料/);
  assert.equal(auditCaseMaterials(sample(), { input: {}, mocks: [] }).hostCallsExecuted, false);
});

test("材料检查有界且严格定位，不遍历原型、不把错误编码强制转换", () => {
  for (const materialChecks of [Array.from({ length: 17 }, () => check("array-length", 0)),
    [check("array-length", "2", { pointer: "/rows" })], [check("array-length", 2, { pointer: "/__proto__" })],
    [check("utf8-bytes", 7, { pointer: "/rows", encoding: "text" })], [check("sha256", "0".repeat(64))]])
    assert.throws(() => resolveCaseValues(sample({ input: '{"rows":[1,2]}', materialChecks })), /材料/);
  const result = auditCaseMaterials(sample({ materialChecks: [check("utf8-bytes", 100, { encoding: "text" })] }),
    { input: "x".repeat(100), mocks: [] }, { budget: { textBytes: 16 * 1024 * 1024 - 50 } });
  assert.equal(result.issues![0]!.reason, "material_measurement_limit");
  const controller = new AbortController(); controller.abort();
  assert.throws(() => auditCaseMaterials(sample(), { input: {}, mocks: [] }, { signal: controller.signal }), { name: "AbortError" });
});

test("正式计划与完整草稿诊断共享门槛，材料声明随原计划冻结", () => {
  const { plan, architecture } = fixture({ input: '{"rows":[1,2]}', materialChecks: [check("array-length", 3, { pointer: "/rows" })],
    mocks: [write("text", { saved: true, integrity: { bytes: 0, sha256: "0".repeat(64) } })] });
  assert.throws(() => validatePlan(plan, { architecture }), /材料/);
  const diagnosed = diagnosePlanningPlan(plan, PLAN_V2_SCHEMA, { architecture });
  assert.ok(diagnosed.issues.some((entry) => entry.path === "plan.cases[0].materialChecks[0].expected" && entry.reason === "material_fact_mismatch"));
  assert.ok(diagnosed.issues.some((entry) => entry.path === "plan.cases[0].mocks[0].resultJson.integrity.sha256"));
  plan.cases![0]!.materialChecks[0]!.expected = 2; plan.cases![0]!.mocks = [];
  const accepted = validatePlan(plan, { architecture });
  for (const change of [[], [check("array-length", 1, { pointer: "/rows" })]]) {
    const next = structuredClone(plan); next.cases![0]!.materialChecks = change;
    assert.throws(() => validatePlan(next, { architecture, previousPlan: accepted }));
  }
  assert.deepEqual(validatePlan(plan, { architecture, previousPlan: accepted }), accepted);
});

test("原子草稿保存拒绝矛盾材料，按ID局部修订后可正式封存", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-material-audit-"));
  t.after(async () => {
    const unseal = async (path: string) => { await chmod(path, 0o700); for (const file of await readdir(path, { withFileTypes: true })) if (file.isDirectory()) await unseal(join(path, file.name)); };
    await unseal(root); await rm(root, { recursive: true, force: true });
  });
  const { plan, architecture } = fixture({ input: '{"rows":[1,2]}', materialChecks: [check("array-length", 2, { pointer: "/rows" })] });
  const artifacts = new DevelopmentArtifacts({ dataDir: root });
  const tools = await artifacts.tools("agent_one", "run_one", { casesSchema: PLAN_V2_SCHEMA.properties.cases, planSchema: PLAN_V2_SCHEMA, architecture });
  const call = (name: string, args: unknown) => fixtureTools(tools)[name]!.execute("fixed", args);
  const { cases, ...index } = plan;
  await call("save_plan_json", { path: "index.json", value: { ...index, caseFiles: ["cases.json"] } });
  await call("save_plan_cases", { path: "cases.json", cases });
  const directory = await artifacts.directory("agent_one", "run_one"), path = join(directory, "cases.json"), before = await readFile(path);
  const bad = structuredClone(cases); bad[0]!.materialChecks[0]!.expected = 3;
  await assert.rejects(call("save_plan_cases", { path: "cases.json", cases: bad }), (error: TestFailure) => {
    assert.equal(error.reason, "planning_case_invalid"); assert.ok(recordArray(error.planningIssues).some((entry) => entry.reason === "material_fact_mismatch")); return true;
  });
  assert.deepEqual(await readFile(path), before);
  await call("write", { path: "cases.json", content: JSON.stringify(bad) });
  await assert.rejects(artifacts.submit("agent_one", "run_one", "index.json"), /材料/);
  const development = await artifacts.storage.directory("agent_one", "development");
  assert.equal((await readdir(development)).includes("planning-snapshots"), false);
  for (const field of ["assertions", "mocks"]) {
    const broken = structuredClone(bad); Reflect.deleteProperty(broken[0]!, field);
    await call("write", { path: "cases.json", content: JSON.stringify(broken) });
    await assert.rejects(artifacts.submit("agent_one", "run_one", "index.json"), /材料/);
    assert.equal((await readdir(development)).includes("planning-snapshots"), false);
  }
  await call("save_plan_cases", { path: "cases.json", cases });
  const updated = structuredClone(cases[0]); updated!.input! = '{"rows":[1,2,3]}'; updated!.materialChecks![0]!.expected = 3;
  await call("edit_plan_cases", { path: "cases.json", expectedHash: hash(await readFile(path)), changes: [{ op: "replace", id: updated!.id!, case: updated }] });
  const submitted = await artifacts.submit("agent_one", "run_one", "index.json");
  assert.equal(validatePlan!(submitted.plan, { architecture }).cases[0]!.materialChecks![0]!.expected, 3);
});
