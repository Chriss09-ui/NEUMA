import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PLAN_V2_SCHEMA, PLAN_V3_SCHEMA, hashValue, validatePlan } from "../src/development/development-contract.mjs";
import { DevelopmentArtifacts } from "../src/development/development-artifacts.mjs";
import { diagnosePlanningPlan, pagePlanDiagnostics, planDiagnosticLedger, PLAN_DIAGNOSTIC_LIMITS, planningAdmissionFacts } from "../src/development/development-plan-diagnostics.mjs";
import { rawPlanningToolIssues } from "../src/development/development-diagnostics.mjs";
import { TEST_FIXTURE_OPERATION_GUIDE } from "../src/development/development-fixtures.mjs";

function fixture() {
  const schema = { type: "object", properties: { value: { type: "integer", minimum: 0, maximum: 10 } }, required: ["value"], additionalProperties: false };
  const architecture = { requirements: [{ id: "required" }, { id: "second" }], design: { schemaVersion: 2, connections: [], interaction: { page: false },
    acceptance: [{ id: "result", requirementIds: ["required"] }, { id: "boundary", requirementIds: ["second"] }] } };
  const plan = { summary: "实现确定的处理", schemaVersion: 2, runtime: "node-action", entrypoint: "main.mjs",
    tasks: [{ id: "core", title: "主要处理", description: "完成全部实际功能", requirementIds: ["required", "second"], acceptanceIds: ["result", "boundary"], dependsOn: [], files: ["main.mjs"] }],
    application: { protocolVersion: 2, runtime: "node-action", entrypoint: "main.mjs", page: null, stateVersion: 1, evidenceIds: [],
      actions: [{ id: "run", title: "执行", connectionIds: [], inputSchema: schema, outputSchema: schema }] },
    cases: ["result", "boundary"].map((id) => ({ id: `case_${id}`, taskId: "core", acceptanceId: id, kind: "action", actionId: "run", mocks: [], input: '{"value":1}', assertions: [{ path: "value", expectedJson: "1" }] })),
  };
  return { architecture, plan, schema: PLAN_V2_SCHEMA };
}

function managedFixture() {
  const { architecture, plan } = fixture();
  Object.assign(architecture.design, { schemaVersion: 3, execution: { language: "python", hosting: "managed" } });
  Object.assign(plan, { schemaVersion: 3, runtime: "managed-service", entrypoint: "service.py" });
  plan.tasks[0].files = [plan.entrypoint];
  Object.assign(plan.application, { protocolVersion: 3, runtime: plan.runtime, entrypoint: plan.entrypoint,
    service: { schemaVersion: 1, language: "python", host: "managed", entrypoint: plan.entrypoint,
      operations: [{ ...structuredClone(plan.application.actions[0]), visibility: "public" },
        { ...structuredClone(plan.application.actions[0]), id: "helper", visibility: "internal" }],
      dependencies: { packages: [] }, resources: {}, dataVersion: 1, capabilities: [] } });
  return { architecture, plan, schema: PLAN_V3_SCHEMA };
}

test("普通内部操作不额外要求直接用例，公开操作仍须真实执行且拒绝用例不能替代", () => {
  const { architecture, plan, schema } = managedFixture(), before = structuredClone(plan);
  assert.equal(diagnosePlanningPlan(plan, schema, { architecture }).total, 0);
  assert.deepEqual(validatePlan(plan, { architecture }), plan); assert.deepEqual(plan, before);
  plan.application.actions.push({ ...structuredClone(plan.application.actions[0]), id: "other" });
  plan.application.service.operations.push({ ...structuredClone(plan.application.service.operations[0]), id: "other" });
  const missingOperations = () => diagnosePlanningPlan(plan, schema, { architecture }).issues
    .filter((item) => item.reason === "action_missing" && item.path.startsWith("plan.application.service.operations["));
  let issues = missingOperations();
  assert.deepEqual(issues.map((item) => item.path), ["plan.application.service.operations[2]"]);
  assert.throws(() => validatePlan(plan, { architecture }), /每个动作必须有实际验收/);
  plan.cases.push({ ...structuredClone(plan.cases[0]), id: "reject_other", actionId: "other", kind: "input-rejection", input: '{"value":11}' });
  issues = missingOperations();
  assert.deepEqual(issues.map((item) => item.path), ["plan.application.service.operations[2]"]);
  assert.throws(() => validatePlan(plan, { architecture }), /每个动作必须有实际验收/);
});

test("内部迁移及验证动作各自必测，普通内部操作和激活专用用例不冒充其研发覆盖", () => {
  const { architecture, plan, schema } = managedFixture(), service = plan.application.service;
  service.dataVersion = plan.application.stateVersion = 2;
  service.migration = { fromVersion: 1, actionId: "migrate", verifyActionId: "verify" };
  for (const id of ["migrate", "verify"]) service.operations.push({ ...structuredClone(service.operations[1]), id });
  const missing = (value) => diagnosePlanningPlan(value, schema, { architecture }).issues.filter((item) => item.reason === "action_missing");
  assert.deepEqual(missing(plan).map((item) => item.path), ["plan.application.service.operations[2]", "plan.application.service.operations[3]"]);
  assert.throws(() => validatePlan(plan, { architecture }), /迁移与迁移验证动作必须分别/);
  for (const id of ["migrate", "verify"]) plan.cases.push({ ...structuredClone(plan.cases[0]), id: `case_${id}`, actionId: id });
  assert.equal(diagnosePlanningPlan(plan, schema, { architecture }).total, 0);
  assert.deepEqual(validatePlan(plan, { architecture }), plan);
  for (const id of ["migrate", "verify"]) {
    const changed = structuredClone(plan), target = changed.cases.find((item) => item.actionId === id);
    target.kind = "input-rejection"; target.input = '{"value":11}';
    assert.equal(missing(changed).length, 1);
    assert.throws(() => validatePlan(changed, { architecture }), /迁移与迁移验证动作必须分别/);
    changed.cases = changed.cases.filter((item) => item.actionId !== id);
    changed.activationCases = [{ ...structuredClone(target), kind: "action", input: '{"value":1}' }];
    assert.equal(missing(changed).length, 1);
    assert.throws(() => validatePlan(changed, { architecture }));
  }
});

async function material(t, previousPlan) {
  const root = await mkdtemp(join(tmpdir(), "neuma-plan-ledger-"));
  t.after(async () => {
    const unseal = async (path) => { await chmod(path, 0o700); for (const file of await readdir(path, { withFileTypes: true })) if (file.isDirectory()) await unseal(join(path, file.name)); };
    await unseal(root); await rm(root, { recursive: true, force: true });
  });
  const { architecture, plan, schema } = fixture(), artifacts = new DevelopmentArtifacts({ dataDir: root });
  const tools = await artifacts.tools("agent_one", "run_one", { casesSchema: schema.properties.cases, planSchema: schema, architecture, previousPlan });
  const call = async (name, args) => JSON.parse((await tools.find((tool) => tool.name === name).execute("test", args)).content[0].text);
  const { cases, ...index } = plan;
  return { root, architecture, plan, schema, artifacts, tools, call, index, cases, directory: await artifacts.directory("agent_one", "run_one") };
}

test("独立问题一次诊断，重复两位置、输入冲突、无页面检查与覆盖缺项不被首错遮住", () => {
  const { plan, architecture, schema } = fixture();
  plan.tasks[0].requirementIds = ["required"]; plan.tasks[0].acceptanceIds = ["result"];
  plan.cases[1] = { ...structuredClone(plan.cases[0]), input: '{"value":20}' };
  plan.cases.push({ id: "page_case", taskId: "core", acceptanceId: "result", kind: "node-check", entrypoint: "page-check.mjs", input: "", assertions: [{ path: "", expectedJson: "true" }] });
  const sources = plan.cases.map((item, index) => ({ path: index ? "cases/second.json" : "cases/first.json", fileIndex: index ? 1 : 0, localIndex: index ? index - 1 : 0, caseId: item.id }));
  const result = diagnosePlanningPlan(plan, schema, { architecture, sources });
  for (const reason of ["duplicate_id", "action_input_invalid", "node_check_invalid", "missing_coverage"]) assert.ok(result.issues.some((issue) => issue.reason === reason), reason);
  const duplicate = result.issues.find((issue) => issue.reason === "duplicate_id");
  assert.equal(duplicate.source.path, "cases/second.json"); assert.equal(duplicate.source.localIndex, 0);
  assert.deepEqual(duplicate.relatedSources, [sources[0]]); assert.equal(duplicate.duplicateConflict, true);
  assert.equal(result.total, result.retained); assert.equal(result.truncated, false);
  assert.throws(() => validatePlan(plan, { architecture }), /input/);
  const again = diagnosePlanningPlan(plan, schema, { architecture, sources });
  assert.deepEqual(again.issues.map((issue) => issue.issueId), result.issues.map((issue) => issue.issueId));
});

test("分页首页同时显示所有独立问题分类，不让大量路径错误遮住缺失动作", () => {
  const { plan, architecture, schema } = fixture();
  plan.cases[0].assertions = Array.from({ length: 30 }, (_, index) => ({ path: `errors[${index}].code`, expectedJson: '"bad"' }));
  plan.application.actions.push({ ...structuredClone(plan.application.actions[0]), id: "second_run" });
  const before = structuredClone(plan), result = diagnosePlanningPlan(plan, schema, { architecture });
  const page = pagePlanDiagnostics(result, { limit: 2 });
  assert.equal(page.issues.length, 2); assert.ok(page.nextOffset);
  const paths = page.issueGroups.find((item) => item.reason === "assertion_path_invalid");
  assert.equal(paths.count, 30); assert.match(paths.remedy, /errors\.0\.code/u); assert.match(paths.remedy, /保留原预期值/u);
  assert.ok(page.issueGroups.some((item) => item.reason === "action_missing"));
  assert.deepEqual(plan, before); assert.throws(() => validatePlan(plan, { architecture }));
});

test("拒绝用例反馈实测正式信封字节与目标，宽松动作契约不被误称作业务拒绝", () => {
  const { plan, architecture, schema } = fixture();
  plan.cases[0] = { ...plan.cases[0], kind: "input-rejection", inputTarget: "task-envelope", input: '{"value":1}' };
  const result = diagnosePlanningPlan(plan, schema, { architecture });
  const issue = result.issues.find((item) => item.reason === "input_rejection_not_rejected");
  assert.equal(issue.measurement.target, "task-envelope"); assert.equal(issue.measurement.limit, 131072);
  const expectedEnvelope = { actionId: "run", input: { value: 1 }, mutationId: "verification-input-rejection", deliveryVersion: "verification-input-rejection",
    source: { kind: "application", scope: "verification:input-rejection" }, allowNetwork: false };
  assert.equal(issue.measurement.bytes, Buffer.byteLength(JSON.stringify(expectedEnvelope)));
  assert.match(issue.remedy, new RegExp(`${issue.measurement.bytes}字节`));
  assert.match(issue.remedy, /不执行业务校验/u);
  assert.equal(issue.schemaPath, "plan.application.actions[0].inputSchema");
  assert.throws(() => validatePlan(plan, { architecture }));
  plan.cases[0].inputTarget = "action-value"; plan.application.actions[0].inputSchema = { type: "object", properties: { value: {} }, required: ["value"], additionalProperties: false };
  const loose = diagnosePlanningPlan(plan, schema, { architecture }).issues.find((item) => item.reason === "input_rejection_not_rejected");
  assert.equal(loose.measurement.target, "action-value"); assert.equal(loose.measurement.bytes, 11);
  assert.match(loose.remedy, /所声明的inputSchema/u); assert.throws(() => validatePlan(plan, { architecture }));
});

test("配方超过count额度时反馈实际平台规则，不混作任务入口拒绝或缩小原负例", () => {
  const { plan, architecture, schema } = fixture();
  plan.cases[0] = { ...plan.cases[0], kind: "input-rejection", inputTarget: "task-envelope",
    input: { fixture: { op: "text", value: "x", count: 131073 } } };
  const before = structuredClone(plan), result = diagnosePlanningPlan(plan, schema, { architecture });
  const issue = result.issues.find((item) => item.fixtureReason === "fixture_repeat_limit");
  assert.ok(issue); assert.match(issue.remedy, /repeat和text/u); assert.match(issue.remedy, /10000/u);
  assert.match(issue.remedy, /多字符value/u); assert.match(issue.remedy, /不能仅缩小负例/u);
  assert.deepEqual(plan, before); assert.throws(() => validatePlan(plan, { architecture }));
});

test("夹具结构、执行与未知操作诊断共享新纯操作指南，不虚构动态占位能力", () => {
  const { plan, architecture, schema } = fixture();
  plan.cases[0].input = { fixture: { op: "object", fields: { value: { op: "measure", kind: "utf8-bytes",
    value: { op: "concat", items: [{ op: "value", value: "x" }] } } } } };
  assert.deepEqual(diagnosePlanningPlan(plan, schema, { architecture }).issues, []);
  assert.doesNotThrow(() => validatePlan(plan, { architecture }));
  plan.cases[0].input = { fixture: { op: "compute_business_result", code: "not executed" } };
  const diagnostic = diagnosePlanningPlan(plan, schema, { architecture });
  const issue = diagnostic.issues.find((item) => item.fixtureReason === "fixture_unknown_operation");
  assert.ok(issue); assert.equal(issue.remedy, TEST_FIXTURE_OPERATION_GUIDE);
  assert.match(issue.remedy, /concat/); assert.match(issue.remedy, /join/); assert.match(issue.remedy, /measure/);
  assert.match(issue.remedy, /不支持动态占位符/);
  plan.cases[0].input = '{"value":1}';
  plan.cases[0].assertions[0].expectedJson = { fixture: { op: "repeat", count: 10000,
    value: { op: "measure", kind: "sha256", value: { op: "text", value: "x".repeat(100), count: 10000 } } } };
  const bounded = diagnosePlanningPlan(plan, schema, { architecture }).issues.find((item) => item.fixtureReason === "fixture_text_work_limit");
  assert.ok(bounded); assert.equal(bounded.remedy, TEST_FIXTURE_OPERATION_GUIDE);
});

test("独立评审入口事实实际展开当前配方，保留目标、字节与不执行动作的边界", () => {
  const { plan } = fixture();
  plan.cases[0] = { ...plan.cases[0], kind: "input-rejection", inputTarget: "task-envelope",
    input: { fixture: { op: "text", value: "x".repeat(90), count: 3000 } } };
  const before = structuredClone(plan), facts = planningAdmissionFacts(plan);
  assert.equal(facts.length, 1); assert.equal(facts[0].rejected, true); assert.equal(facts[0].actionExecuted, false);
  assert.equal(facts[0].target, "task-envelope"); assert.ok(facts[0].bytes > facts[0].limit);
  assert.equal(facts[0].limit, 131072); assert.equal(facts[0].caseId, plan.cases[0].id);
  assert.equal(Object.hasOwn(facts[0], "input"), false); assert.deepEqual(plan, before);
});

test("空任务验收定位真实索引并明确最小数量，允许的研发编号仅在台账顶层提供一次", async (t) => {
  const f = await material(t); f.index.tasks[0].acceptanceIds = [];
  await writeFile(join(f.directory, "index.json"), JSON.stringify({ ...f.index, caseFiles: ["cases.json"] }));
  await f.tools.find((tool) => tool.name === "write").execute("seed-cases", { path: "cases.json", content: JSON.stringify(f.cases) });
  const result = await f.artifacts.diagnose("agent_one", "run_one", "index.json", { schema: f.schema, architecture: f.architecture, limit: 40 });
  const issue = result.diagnostics.issues.find((item) => item.path === "plan.tasks[0].acceptanceIds" && item.rule === "minItems");
  assert.deepEqual(issue.source, { path: "index.json" }); assert.equal(issue.minimumItems, 1); assert.equal(issue.actualCount, 0); assert.equal(issue.taskId, "core");
  assert.match(issue.remedy, /集成任务不能代替/u);
  assert.deepEqual(result.diagnostics.allowedDevelopmentAcceptanceIds, ["result", "boundary"]);
  assert.equal(result.diagnostics.allowedDevelopmentAcceptanceIdsTotal, 2); assert.equal(result.diagnostics.allowedDevelopmentAcceptanceIdsTruncated, false);
  assert.ok(result.diagnostics.issues.every((item) => !Object.hasOwn(item, "allowedDevelopmentAcceptanceIds")));
  assert.ok(result.diagnostics.issues.some((item) => item.reason === "task_acceptance_mismatch" && item.source?.path === "cases.json"));
});

test("字符串编码的fixture外壳仅在动作确实拒绝输入时提示编码错误，不二次展开或改变合法业务fixture字段", () => {
  const { plan, architecture, schema } = fixture();
  const encoded = JSON.stringify({ fixture: { op: "value", value: { value: 1 } } }); plan.cases[0].input = encoded;
  const before = structuredClone(plan), bad = diagnosePlanningPlan(plan, schema, { architecture });
  const issue = bad.issues.find((item) => item.path === "plan.cases[0].input");
  assert.equal(issue.reason, "input_encoding_mismatch"); assert.match(issue.remedy, /原生/u); assert.deepEqual(plan, before);
  assert.throws(() => validatePlan(plan, { architecture }), /input/u);
  plan.cases[0].input = JSON.parse(encoded); assert.equal(diagnosePlanningPlan(plan, schema, { architecture }).total, 0);
  assert.deepEqual(validatePlan(plan, { architecture }), plan);
  const fixtureBusinessSchema = { type: "object", properties: { fixture: { type: "object", properties: { op: { type: "string" }, value: { type: "integer" } },
    required: ["op", "value"], additionalProperties: false } }, required: ["fixture"], additionalProperties: false };
  plan.application.actions[0].inputSchema = fixtureBusinessSchema;
  plan.cases.forEach((item) => { item.input = '{"fixture":{"op":"value","value":1}}'; });
  assert.equal(diagnosePlanningPlan(plan, schema, { architecture }).total, 0);
  assert.deepEqual(validatePlan(plan, { architecture }), plan);
});

test("save_plan_cases与完整台账对错误字符串外壳给同源编码诊断，原文件保留后模型可主动保存原生对象", async (t) => {
  const f = await material(t);
  await f.tools.find((tool) => tool.name === "write").execute("seed-index", { path: "index.json", content: JSON.stringify({ ...f.index, caseFiles: ["cases.json"] }) });
  await f.call("save_plan_cases", { path: "cases.json", cases: f.cases });
  const previous = await readFile(join(f.directory, "cases.json"), "utf8"), wrong = structuredClone(f.cases);
  wrong[0].input = JSON.stringify({ fixture: { op: "value", value: { value: 1 } } });
  await assert.rejects(f.call("save_plan_cases", { path: "cases.json", cases: wrong }), (error) => error.planningIssues?.some((item) => item.reason === "input_encoding_mismatch"));
  assert.equal(await readFile(join(f.directory, "cases.json"), "utf8"), previous);
  wrong[0].input = JSON.parse(wrong[0].input);
  await f.call("save_plan_cases", { path: "cases.json", cases: wrong });
  const result = await f.artifacts.diagnose("agent_one", "run_one", "index.json", { schema: f.schema, architecture: f.architecture });
  assert.equal(result.status, "valid"); assert.equal(typeof result.plan.cases[0].input, "object");
});

test("真实文件工具明确file/bundle摘要作用域，错误CAS拒绝不改文件，正确fileHash才能主动更新", async (t) => {
  const f = await material(t);
  const saved = await f.call("save_plan_json", { path: "index.json", value: { ...f.index, caseFiles: ["cases.json"] } });
  const cases = await f.call("save_plan_cases", { path: "cases.json", cases: f.cases });
  assert.equal(saved.fileHash, saved.hash); assert.equal(saved.hashScope, "file"); assert.equal(cases.hashScope, "file");
  const file = await f.call("read_plan_file", { path: "index.json" }), bundle = await f.call("read_plan_diagnostics", { indexPath: "index.json" });
  assert.equal(file.fileHash, file.hash); assert.equal(file.hashScope, "file"); assert.equal(bundle.bundleHash, bundle.hash); assert.equal(bundle.hashScope, "bundle");
  assert.notEqual(bundle.bundleHash, file.fileHash);
  const before = await readFile(join(f.directory, "index.json"), "utf8");
  await assert.rejects(f.call("update_plan_json", { path: "index.json", expectedHash: bundle.bundleHash, updates: [{ pointer: "/summary", value: "主动更新" }] }),
    (error) => error.reason === "wrong_hash_scope" && error.validationIssue.path === "update_plan_json.expectedHash");
  await assert.rejects(f.call("edit_plan_cases", { path: "cases.json", expectedHash: bundle.bundleHash, changes: [{ op: "move", id: f.cases[0].id }] }),
    (error) => error.reason === "wrong_hash_scope");
  await assert.rejects(f.call("read_plan_diagnostics", { indexPath: "index.json", expectedHash: file.fileHash }), (error) => error.reason === "wrong_hash_scope");
  assert.equal(await readFile(join(f.directory, "index.json"), "utf8"), before);
  const updated = await f.call("update_plan_json", { path: "index.json", expectedHash: file.fileHash, updates: [{ pointer: "/summary", value: "主动更新" }] });
  assert.equal(updated.hashScope, "file"); assert.equal(updated.fileHash, updated.hash); assert.notEqual(updated.fileHash, file.fileHash);
  await assert.rejects(f.call("update_plan_json", { path: "index.json", expectedHash: file.fileHash, updates: [{ pointer: "/summary", value: "旧摘要不能更新" }] }), /已改变/u);
});

test("未引用JSON只是有界目录提示，不增加问题或用例；只有主动保留原引用并加入新批次才纳入计划", async (t) => {
  const f = await material(t);
  await f.call("save_plan_json", { path: "index.json", value: { ...f.index, caseFiles: ["cases.json"] } });
  await f.call("save_plan_cases", { path: "cases.json", cases: f.cases });
  const extra = { ...structuredClone(f.cases[0]), id: "extra_case" };
  for (let index = 0; index < 12; index++) await f.tools.find((tool) => tool.name === "write").execute(`extra_${index}`,
    { path: `unreferenced_${index}.json`, content: JSON.stringify(index === 0 ? [extra] : { note: index }) });
  const result = await f.artifacts.diagnose("agent_one", "run_one", "index.json", { schema: f.schema, architecture: f.architecture });
  assert.equal(result.status, "valid"); assert.equal(result.diagnostics.total, 0); assert.equal(result.plan.cases.length, 2);
  assert.equal(result.diagnostics.directoryNotice.unreferencedFiles.length, 10);
  assert.equal(result.diagnostics.directoryNotice.unreferencedFilesTotal, 12); assert.equal(result.diagnostics.directoryNotice.unreferencedFilesTruncated, true);
  assert.deepEqual((await f.artifacts.submit("agent_one", "run_one", "index.json")).plan.cases, f.cases);
  const current = await f.call("read_plan_file", { path: "index.json" });
  await f.call("update_plan_json", { path: "index.json", expectedHash: current.fileHash, updates: [{ pointer: "/caseFiles", value: ["cases.json", "unreferenced_0.json"] }] });
  const changed = await f.artifacts.submit("agent_one", "run_one", "index.json");
  assert.equal(changed.plan.cases.length, 3); assert.deepEqual(changed.plan.cases.slice(0, 2), f.cases); assert.deepEqual(changed.plan.cases[2], extra);
});

test("分阶段验收保持待验证台账，不强迫宿主和对话需求伪造研发脚本", () => {
  const { plan, architecture, schema } = fixture();
  architecture.requirements.push({ id: "host_requirement" }, { id: "conversation_requirement" });
  architecture.design.acceptance.push(
    { id: "host_acceptance", requirementIds: ["host_requirement"], verification: { stage: "activation", owner: "platform", adapterId: "host-files" } },
    { id: "conversation_acceptance", requirementIds: ["conversation_requirement"], verification: { stage: "runtime", owner: "conversation", adapterId: "conversation" } },
  );
  const result = diagnosePlanningPlan(plan, schema, { architecture });
  assert.equal(result.total, 0);
  assert.deepEqual(result.verificationAssignments.slice(-2).map(({ stage, status }) => ({ stage, status })), [{ stage: "activation", status: "not_run" }, { stage: "runtime", status: "not_run" }]);
});

test("诊断分页有明确完整总数、稳定编号和保留上限，不保存业务值或动态schema字段", () => {
  const ledger = planDiagnosticLedger();
  for (let index = 0; index < PLAN_DIAGNOSTIC_LIMITS.retained + 20; index++) ledger.add({ path: `plan.cases[${index}].input`, reason: "action_input_invalid" });
  const result = ledger.result();
  assert.equal(result.total, PLAN_DIAGNOSTIC_LIMITS.retained + 20); assert.equal(result.retained, PLAN_DIAGNOSTIC_LIMITS.retained); assert.equal(result.truncated, true);
  const first = pagePlanDiagnostics(result, { limit: 2 }); assert.equal(first.issues.length, 2); assert.equal(first.nextOffset, 2);
  assert.equal(pagePlanDiagnostics(result, { offset: result.retained - 1 }).nextOffset, null);
  assert.throws(() => pagePlanDiagnostics(result, { limit: 41 }));
  const { plan, architecture, schema } = fixture();
  plan.cases[0].input = '{"PRIVATE_INPUT":"PRIVATE_VALUE"}';
  plan.application.actions[0].outputSchema = { type: "object", properties: { PRIVATE_KEY: { type: "string", pattern: "PRIVATE_PATTERN" } }, required: [], additionalProperties: false };
  assert.doesNotMatch(JSON.stringify(diagnosePlanningPlan(plan, schema, { architecture })), /PRIVATE_/);
});

test("同一用例中独立JSON字段全部定位，重排无关用例不改变问题编号", () => {
  const { plan, architecture, schema } = fixture();
  plan.cases[0].mocks = [{ capability: "files.write", argsJson: "PRIVATE_BAD_ARGS", resultJson: "PRIVATE_BAD_RESULT" }];
  plan.cases[0].assertions.push({ path: "more", expectedJson: "PRIVATE_BAD_EXPECTED" });
  const source = (entry, localIndex) => ({ path: "cases.json", localIndex, caseId: entry.id });
  const first = diagnosePlanningPlan(plan, schema, { architecture, sources: plan.cases.map(source) });
  for (const field of ["mocks[0].argsJson", "mocks[0].resultJson", "assertions[1].expectedJson"])
    assert.ok(first.issues.some((issue) => issue.path === `plan.cases[0].${field}`), field);
  plan.cases.reverse();
  const second = diagnosePlanningPlan(plan, schema, { architecture, sources: plan.cases.map(source) });
  for (const issue of first.issues.filter((entry) => entry.reason === "invalid_json" && entry.source))
    assert.ok(second.issues.some((entry) => entry.issueId === issue.issueId), issue.path);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_/);
  const guarded = { ...plan, get forbidden() { throw new Error("accessor executed"); } };
  assert.equal(diagnosePlanningPlan(guarded, schema, { architecture }).issues[0].reason, "planning_diagnostic_limit");
});

test("材料诊断跨缺失与重复继续检查，并用同一整组摘要分页拒绝迟到读取", async (t) => {
  const { artifacts, call, index, cases, architecture, schema } = await material(t);
  await call("save_plan_json", { path: "index.json", value: { ...index, caseFiles: ["cases/a.json", "absent.json", "cases/b.json"] } });
  await call("save_plan_json", { path: "cases/a.json", value: cases });
  await call("save_plan_json", { path: "cases/b.json", value: [{ ...cases[0], input: '{"value":20}' }] });
  const result = await artifacts.diagnose("agent_one", "run_one", "index.json", { schema, architecture, limit: 40 });
  assert.equal(result.status, "incomplete");
  for (const reason of ["planning_material_missing", "duplicate_id", "action_input_invalid"]) assert.ok(result.diagnostics.issues.some((issue) => issue.reason === reason), reason);
  assert.equal(result.sources[2].fileIndex, 2); assert.equal(result.sources[2].localIndex, 0);
  const page = await call("read_plan_diagnostics", { indexPath: "index.json", expectedHash: result.hash, limit: 1 });
  assert.equal(page.hash, result.hash); assert.equal(page.diagnostics.total, result.diagnostics.total); assert.equal(page.diagnostics.nextOffset, 1);
  await call("save_plan_json", { path: "cases/b.json", value: [{ ...cases[0], id: "different_case" }] });
  await assert.rejects(call("read_plan_diagnostics", { indexPath: "index.json", expectedHash: result.hash, offset: 1 }), /材料已改变/);
});

test("结构化用例须先有索引动作骨架，保存即拒绝跨文件重号及入口冲突并保留旧文件", async (t) => {
  const { call, index, cases, directory } = await material(t);
  await assert.rejects(call("save_plan_cases", { path: "cases/a.json", cases }), /planning_index_required/);
  await assert.rejects(stat(join(directory, "cases/a.json")), { code: "ENOENT" });
  await call("save_plan_json", { path: "index.json", value: { ...index, caseFiles: ["cases/a.json", "cases/b.json"] } });
  await call("save_plan_cases", { path: "cases/a.json", cases });
  await assert.rejects(call("save_plan_cases", { path: "cases/b.json", cases: [cases[0]] }), /duplicate_id.*cases\/b.json.*cases\/a.json/);
  await assert.rejects(stat(join(directory, "cases/b.json")), { code: "ENOENT" });
  const before = await readFile(join(directory, "cases/a.json"), "utf8");
  await assert.rejects(call("save_plan_cases", { path: "cases/a.json", cases: [{ ...cases[0], input: '{"value":20}' }] }), /action_input_invalid/);
  assert.equal(await readFile(join(directory, "cases/a.json"), "utf8"), before);
  await assert.rejects(call("save_plan_cases", { path: "cases/a.json", cases: cases.map((entry) => ({ ...entry, taskId: "not_declared" })) }), (error) => {
    assert.ok(error.planningIssues.some((item) => item.reason === "invalid_reference"));
    const feedback = JSON.parse(error.message.slice(error.message.indexOf("{")));
    assert.deepEqual(feedback.taskAssignments.allowedTaskIds, ["core"]);
    assert.deepEqual(feedback.taskAssignments.tasks[0].acceptanceIds, index.tasks[0].acceptanceIds);
    assert.deepEqual(feedback.taskAssignments.tasks[0].requirementIds, index.tasks[0].requirementIds); return true;
  });
  assert.equal(await readFile(join(directory, "cases/a.json"), "utf8"), before);
  const page = { id: "page", taskId: "core", acceptanceId: "result", kind: "node-check", entrypoint: "check.mjs", input: "", assertions: [{ path: "", expectedJson: "true" }] };
  await assert.rejects(call("save_plan_cases", { path: "cases/b.json", cases: [page] }), /node_check_invalid/);
});

test("草稿用例按ID局部增改删重排，摘要并发保护与冻结规则不受影响", async (t) => {
  const { call, index, cases, directory } = await material(t);
  await call("save_plan_json", { path: "index.json", value: { ...index, caseFiles: ["cases/a.json"] } });
  const saved = await call("save_plan_cases", { path: "cases/a.json", cases });
  const added = { ...cases[0], id: "added_case" };
  const changed = await call("edit_plan_cases", { path: "cases/a.json", expectedHash: saved.hash, changes: [
    { op: "add", id: added.id, case: added },
    { op: "replace", id: "case_result", expectedCaseHash: hashValue(cases[0]), case: { ...cases[0], input: '{"value":2}' } },
    { op: "move", id: added.id, beforeId: "case_result" },
    { op: "remove", id: "case_boundary" },
  ] });
  const actual = JSON.parse(await readFile(join(directory, "cases/a.json"), "utf8"));
  assert.deepEqual(actual.map((entry) => entry.id), ["added_case", "case_result"]); assert.equal(actual[1].input, '{"value":2}');
  assert.deepEqual(changed.cases.map((entry) => entry.hash), actual.map(hashValue));
  await assert.rejects(call("edit_plan_cases", { path: "cases/a.json", expectedHash: saved.hash, changes: [{ op: "remove", id: "case_result" }] }), /已改变/);
  const before = await readFile(join(directory, "cases/a.json"), "utf8");
  await assert.rejects(call("edit_plan_cases", { path: "cases/a.json", expectedHash: changed.hash, changes: [
    { op: "remove", id: "added_case" }, { op: "replace", id: "absent_case", case: cases[0] },
  ] }));
  assert.equal(await readFile(join(directory, "cases/a.json"), "utf8"), before, "整次局部修改失败保留原文件");
  const frozen = await material(t, fixture().plan);
  await frozen.call("save_plan_json", { path: "index.json", value: { ...frozen.index, caseFiles: ["cases/a.json"] } });
  const receipt = await frozen.call("save_plan_cases", { path: "cases/a.json", cases: frozen.cases });
  await assert.rejects(frozen.call("edit_plan_cases", { path: "cases/a.json", expectedHash: receipt.hash, changes: [{ op: "remove", id: "case_result" }] }), /冻结/);
});

test("局部草稿工具原始参数拒绝隐式转换，反馈字段不回显用例正文", async (t) => {
  const { tools } = await material(t), tool = tools.find((entry) => entry.name === "edit_plan_cases");
  const issues = rawPlanningToolIssues({ path: "cases.json", expectedHash: "0".repeat(64), changes: "PRIVATE_ENCODED_CASES" }, tool.parameters, tool.name);
  assert.equal(issues.length, 1); assert.equal(issues[0].path, "edit_plan_cases.changes"); assert.equal(issues[0].receivedType, "string");
  assert.match(issues[0].remedy, /稳定id.*不把数组编码成JSON字符串/); assert.doesNotMatch(JSON.stringify(issues), /PRIVATE_/);
});

test("既有重复草稿可按编号及局部位置精确修正，不自动选择冲突断言", async (t) => {
  const { call, index, cases, directory } = await material(t);
  await call("save_plan_json", { path: "index.json", value: { ...index, caseFiles: ["cases/a.json"] } });
  await call("save_plan_json", { path: "cases/a.json", value: [cases[0], { ...cases[0], input: '{"value":2}' }, cases[1]] });
  const page = await call("read_plan_file", { path: "cases/a.json" });
  await assert.rejects(call("edit_plan_cases", { path: "cases/a.json", expectedHash: page.hash, changes: [{ op: "remove", id: "case_result" }] }), /目标须唯一/);
  await call("edit_plan_cases", { path: "cases/a.json", expectedHash: page.hash, changes: [{ op: "remove", id: "case_result", localIndex: 1 }] });
  assert.deepEqual(JSON.parse(await readFile(join(directory, "cases/a.json"), "utf8")), cases);
  const current = await call("read_plan_file", { path: "cases/a.json" });
  const emptied = await call("edit_plan_cases", { path: "cases/a.json", expectedHash: current.hash,
    changes: cases.map((entry) => ({ op: "remove", id: entry.id })) });
  assert.equal(emptied.incomplete, true); assert.deepEqual(JSON.parse(await readFile(join(directory, "cases/a.json"), "utf8")), []);
});
