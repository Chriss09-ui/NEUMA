import test from "node:test";
import assert from "node:assert/strict";
import { chmod, link, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevelopmentArtifacts, PLAN_ARTIFACT_LIMITS } from "../src/development/development-artifacts.mjs";
import { validatePlan, hashValue, PLAN_V2_SCHEMA, PLAN_V3_SCHEMA } from "../src/development/development-contract.mjs";
import { developmentArchitecture, developmentPlan } from "./helpers/development.mjs";

async function fixture(t, { casesSchema = PLAN_V2_SCHEMA.properties.cases } = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-plan-artifacts-"));
  t.after(async () => {
    const unseal = async (path) => {
      await chmod(path, 0o700);
      for (const entry of await readdir(path, { withFileTypes: true }))
        if (entry.isDirectory() && !entry.isSymbolicLink()) await unseal(join(path, entry.name));
    };
    await unseal(root); await rm(root, { force: true, recursive: true });
  });
  const artifacts = new DevelopmentArtifacts({ dataDir: join(root, "data") });
  const tools = await artifacts.tools("agent_one", "run_one", { casesSchema });
  return { root, artifacts, tools, directory: await artifacts.directory("agent_one", "run_one") };
}
const call = async (tools, name, args, signal) => tools.find((tool) => tool.name === name).execute("test", args, signal);
const save = (tools, path, value) => call(tools, "write", { path, content: JSON.stringify(value, null, 2) });

async function savePlan(tools, plan) {
  const { cases, ...index } = plan;
  await save(tools, "index.json", { ...index, caseFiles: ["cases/first.json", "cases/rest.json"] });
  await save(tools, "cases/first.json", cases[0]);
  await save(tools, "cases/rest.json", cases.slice(1));
}

test("原生规划工具保存分批用例，封存后组装与完整旧校验一致", async (t) => {
  const { artifacts, tools } = await fixture(t), architecture = developmentArchitecture(), plan = developmentPlan(architecture);
  assert.deepEqual(tools.map((tool) => tool.name), ["read", "write", "edit", "save_plan_cases", "save_plan_json", "update_plan_json", "edit_plan_cases", "read_plan_diagnostics", "list_plan_files", "read_plan_file"]);
  await savePlan(tools, plan);
  const submitted = await artifacts.submit("agent_one", "run_one", "index.json");
  assert.deepEqual(validatePlan(submitted.plan, { architecture }), plan);
  assert.equal(hashValue(submitted.plan), hashValue(plan));
  assert.equal((await stat(join(submitted.snapshot.path, "index.json"))).mode & 0o222, 0);
  assert.deepEqual((await artifacts.validateSnapshot(submitted.snapshot)).plan, plan);
  await call(tools, "edit", { path: "index.json", edits: [{ oldText: plan.summary, newText: "修改规划摘要" }] });
  assert.equal((await artifacts.submit("agent_one", "run_one", "index.json")).plan.summary, "修改规划摘要");
  assert.equal((await artifacts.validateSnapshot(submitted.snapshot)).plan.summary, plan.summary);
  const changed = { ...plan, cases: plan.cases.map((entry, index) => index ? entry : { ...entry, input: "changed" }) };
  await savePlan(tools, changed);
  const revised = await artifacts.submit("agent_one", "run_one", "index.json");
  assert.throws(() => validatePlan(revised.plan, { architecture, previousPlan: plan }), /不能删除或替换/);
});

test("规划预览只捕获当前材料，不封存、不改变权限或接受正式计划", async (t) => {
  const { artifacts, tools, directory } = await fixture(t), architecture = developmentArchitecture(), plan = developmentPlan(architecture);
  await savePlan(tools, plan);
  const development = await artifacts.storage.directory("agent_one", "development");
  const before = await readdir(development), permissions = await stat(join(directory, "index.json"));
  const preview = await artifacts.preview("agent_one", "run_one", "index.json");
  assert.deepEqual(preview.plan, plan);
  assert.deepEqual(validatePlan(preview.plan, { architecture }), plan);
  assert.equal(preview.hash.length, 64); assert.equal(preview.files.length, 3);
  assert.deepEqual(await readdir(development), before, "预览不能创建正式规划快照或记录");
  const after = await stat(join(directory, "index.json"));
  assert.equal(after.mode, permissions.mode); assert.equal(after.mtimeMs, permissions.mtimeMs);
  const submitted = await artifacts.submit("agent_one", "run_one", "index.json");
  assert.equal(submitted.snapshot.hash, preview.hash);
  assert.deepEqual(submitted.snapshot.files, preview.files); assert.deepEqual(submitted.plan, preview.plan);
  await call(tools, "edit", { path: "index.json", edits: [{ oldText: plan.summary, newText: "继续修改但尚未提交" }] });
  const changed = await artifacts.preview("agent_one", "run_one", "index.json");
  assert.notEqual(changed.hash, preview.hash); assert.equal(preview.plan.summary, plan.summary);
  assert.equal((await artifacts.validateSnapshot(submitted.snapshot)).plan.summary, plan.summary);
});

test("预览缺失材料及外部损坏JSON使用相同受控问题，读取未建批次不创建目录", async (t) => {
  const { artifacts, tools, directory } = await fixture(t);
  const workspaces = await artifacts.storage.directory("agent_one", "development/workspaces");
  const before = await readdir(workspaces);
  await assert.rejects(artifacts.preview("agent_one", "missing_run", "index.json"), (error) => {
    assert.deepEqual(error.artifactIssue, { indexField: "index", parseError: "missing" }); return true;
  });
  assert.deepEqual(await readdir(workspaces), before);
  await save(tools, "index.json", { caseFiles: ["case.json"] });
  await assert.rejects(artifacts.preview("agent_one", "run_one", "index.json"), (error) => {
    assert.deepEqual(error.artifactIssue, { indexField: "caseFiles", fileIndex: 0, parseError: "missing" }); return true;
  });
  await assert.rejects(call(tools, "write", { path: "case.json", content: "[{" }), /完整 JSON/);
  await assert.rejects(stat(join(directory, "case.json")), { code: "ENOENT" });
  await writeFile(join(directory, "case.json"), "[{", { mode: 0o600 });
  await assert.rejects(artifacts.preview("agent_one", "run_one", "index.json"), (error) => {
    assert.deepEqual(error.artifactIssue, { indexField: "caseFiles", fileIndex: 0, parseError: "json", location: { offset: 2, line: 1, column: 3 } }); return true;
  });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(artifacts.preview("agent_one", "run_one", "index.json", { signal: controller.signal }), { name: "AbortError" });
});

test("预览与原生编辑及封存共用整组锁，返回的字节摘要不会被后续编辑改变", async (t) => {
  const { artifacts, tools } = await fixture(t);
  await save(tools, "index.json", { caseFiles: ["case.json"] });
  await save(tools, "case.json", { id: "before" });
  const originalWrite = artifacts.write.bind(artifacts);
  let entered, release;
  const writing = new Promise((resolve) => { entered = resolve; });
  const proceed = new Promise((resolve) => { release = resolve; });
  artifacts.write = async (...args) => { entered(); await proceed; return originalWrite(...args); };
  const edit = call(tools, "edit", { path: "case.json", edits: [{ oldText: "before", newText: "after" }] });
  await writing;
  let read = false;
  const previewing = artifacts.preview("agent_one", "run_one", "index.json").then((value) => { read = true; return value; });
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(read, false);
  release(); await edit;
  const preview = await previewing;
  assert.equal(preview.plan.cases[0].id, "after");
  const submitted = await artifacts.submit("agent_one", "run_one", "index.json");
  assert.equal(submitted.snapshot.hash, preview.hash); assert.deepEqual(submitted.snapshot.files, preview.files);
  await save(tools, "case.json", { id: "later" });
  assert.equal(preview.plan.cases[0].id, "after");
  assert.notEqual((await artifacts.preview("agent_one", "run_one", "index.json")).hash, preview.hash);
});

test("规划目录拒绝代码、越界、链接、重复引用和重复用例", async (t) => {
  const { artifacts, tools, root, directory } = await fixture(t);
  for (const path of ["../outside.json", "/tmp/outside.json", "main.mjs", ".env.json", "credentials.json", "cases/../x.json"])
    await assert.rejects(call(tools, "write", { path, content: "{}" }));
  const outside = join(root, "outside.json"); await writeFile(outside, "{}", "utf8");
  await symlink(outside, join(directory, "linked.json"));
  await assert.rejects(call(tools, "read", { path: "linked.json" }), /链接/);
  await rm(join(directory, "linked.json"));
  await link(outside, join(directory, "linked.json"));
  await assert.rejects(call(tools, "edit", { path: "linked.json", edits: [{ oldText: "{}", newText: "[]" }] }), /链接/);
  await assert.rejects(artifacts.submit("agent_one", "run_one", "index.json"), /链接/);
  await rm(join(directory, "linked.json"));
  assert.equal(await readFile(outside, "utf8"), "{}");
  await save(tools, "case.json", { id: "case_one" });
  await save(tools, "index.json", { caseFiles: ["case.json", "case.json"] });
  await assert.rejects(artifacts.submit("agent_one", "run_one", "index.json"), /重复引用/);
  await save(tools, "index.json", { caseFiles: ["absent.json"] });
  await assert.rejects(artifacts.submit("agent_one", "run_one", "index.json"), /不存在/);
  await save(tools, "case.json", [{ id: "case_one" }, { id: "case_one" }]);
  await save(tools, "index.json", { caseFiles: ["case.json"] });
  await assert.rejects(artifacts.submit("agent_one", "run_one", "index.json"), (error) => {
    assert.equal(error.reason, "planning_artifact_invalid");
    assert.deepEqual(error.artifactIssue, { indexField: "caseFiles", fileIndex: 0, parseError: "duplicate" });
    return true;
  });
  await save(tools, "index.json", { caseFiles: ["../not-allowed.json"] });
  await assert.rejects(artifacts.submit("agent_one", "run_one", "index.json"), (error) => {
    assert.deepEqual(error.artifactIssue, { indexField: "caseFiles", fileIndex: 0, parseError: "path" });
    assert.equal(JSON.stringify(error.artifactIssue).includes("not-allowed"), false);
    return true;
  });
});

test("索引加 200 个用例文件有独立额度，超额和不完整 JSON 不被修复", async (t) => {
  const { artifacts, tools, directory } = await fixture(t);
  const cases = Array.from({ length: 200 }, (_, index) => `case_${index}.json`);
  await Promise.all(cases.map((path, index) => writeFile(join(directory, path), JSON.stringify({ id: `case_${index}` }))));
  await save(tools, "index.json", { caseFiles: cases });
  const submitted = await artifacts.submit("agent_one", "run_one", "index.json");
  assert.equal(submitted.snapshot.files.length, 201); assert.equal(submitted.plan.cases.length, 200);
  await assert.rejects(save(tools, "extra.json", {}), /201/);
  const previous = await readFile(join(directory, cases[0]), "utf8");
  await assert.rejects(call(tools, "write", { path: cases[0], content: "[{" }), /完整 JSON/);
  assert.equal(await readFile(join(directory, cases[0]), "utf8"), previous);
  await writeFile(join(directory, cases[0]), "[{");
  await assert.rejects(artifacts.submit("agent_one", "run_one", "index.json"), (error) => {
    assert.deepEqual(error.artifactIssue, { indexField: "caseFiles", fileIndex: 0, parseError: "json", location: { offset: 2, line: 1, column: 3 } });
    return true;
  });
  await save(tools, cases[0], [{ id: "extra_a" }, { id: "extra_b" }]);
  await assert.rejects(artifacts.submit("agent_one", "run_one", "index.json"), /200 个用例/);
  assert.equal(PLAN_ARTIFACT_LIMITS.totalBytes, 10 * 1024 * 1024);
});

test("整个规划封存与原生编辑共锁，不读取正在修改的文件集合", async (t) => {
  const { artifacts, tools } = await fixture(t);
  await save(tools, "index.json", { caseFiles: ["case.json"] });
  await save(tools, "case.json", { id: "before" });
  const originalWrite = artifacts.write.bind(artifacts);
  let entered, release;
  const writing = new Promise((resolve) => { entered = resolve; });
  const proceed = new Promise((resolve) => { release = resolve; });
  artifacts.write = async (...args) => { entered(); await proceed; return originalWrite(...args); };
  const edit = call(tools, "edit", { path: "case.json", edits: [{ oldText: "before", newText: "after" }] });
  await writing;
  let submitted = false;
  const snapshot = artifacts.submit("agent_one", "run_one", "index.json").then((value) => { submitted = true; return value; });
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(submitted, false);
  release(); await edit;
  assert.equal((await snapshot).plan.cases[0].id, "after");
});

test("精确分页保留超长单行，取消及快照改写不能冒充有效计划", async (t) => {
  const { artifacts, tools } = await fixture(t);
  const text = JSON.stringify({ id: "long_case", expected: "中".repeat(60000) });
  await call(tools, "write", { path: "case.json", content: text });
  const native = await call(tools, "read", { path: "case.json" });
  assert.match(native.content[0].text, /exceeds|KB|KiB|large/i);
  let actual = "", offset = 0;
  do {
    const page = JSON.parse((await call(tools, "read_plan_file", { path: "case.json", offset, limit: 40000 })).content[0].text);
    actual += page.content; offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(actual, text);
  await save(tools, "index.json", { caseFiles: ["case.json"] });
  const { snapshot } = await artifacts.submit("agent_one", "run_one", "index.json");
  await assert.rejects(artifacts.validateSnapshot(snapshot, "agent_two"), /标识/);
  await chmod(join(snapshot.path, "case.json"), 0o600); await writeFile(join(snapshot.path, "case.json"), "{}");
  await assert.rejects(artifacts.validateSnapshot(snapshot), /改变/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(call(tools, "write", { path: "cancelled.json", content: "{}" }, controller.signal), { name: "AbortError" });
  await assert.rejects(artifacts.submit("agent_one", "run_one", "index.json", { signal: controller.signal }), { name: "AbortError" });
});

test("专用用例批次保存保留夹具及特殊字符，字段更新不改变其他材料或冻结验收", async (t) => {
  const { artifacts, tools, directory } = await fixture(t), architecture = developmentArchitecture(), plan = developmentPlan(architecture);
  Object.assign(architecture.design, { schemaVersion: 2, connections: [], interaction: { page: false } });
  Object.assign(plan, { schemaVersion: 2, runtime: "node-action", application: { protocolVersion: 2, runtime: "node-action", entrypoint: plan.entrypoint,
    page: null, stateVersion: 1, evidenceIds: [], actions: [{ id: "run", title: "处理", connectionIds: [],
      inputSchema: { type: "object", properties: { payload: { type: "string" } }, required: ["payload"], additionalProperties: false },
      outputSchema: { type: "object", properties: { scenario: { type: "string" }, verified: { type: "boolean" } }, required: ["scenario", "verified"], additionalProperties: false } }] } });
  for (const item of plan.cases) Object.assign(item, { kind: "action", actionId: "run", mocks: [],
    input: { fixture: { op: "value", value: { payload: item.input } } },
    assertions: item.assertions.map((assertion) => ({ ...assertion, expectedJson: { fixture: { op: "value", value: JSON.parse(assertion.expectedJson) } } })) });
  const { cases, ...index } = plan;
  cases[0].input.fixture.value.payload = '引号"、反斜线\\、换行\n和表情😀';
  const saving = async (path, value) => JSON.parse((await call(tools, "save_plan_json", { path, value })).content[0].text);
  await saving("index.json", { ...index, caseFiles: ["cases/all.json"] });
  const saved = JSON.parse((await call(tools, "save_plan_cases", { path: "cases/all.json", cases })).content[0].text);
  assert.equal(saved.serialized, true); assert.equal(saved.hash.length, 64); assert.equal(saved.inputEncoding, "structured");
  assert.deepEqual(JSON.parse(await readFile(join(directory, "cases/all.json"), "utf8")), cases);
  const accepted = await artifacts.submit("agent_one", "run_one", "index.json");
  assert.deepEqual(validatePlan(accepted.plan, { architecture }), plan);
  const encoded = await saving("cases/all.json", JSON.stringify(cases));
  assert.equal(encoded.inputEncoding, "json-text"); assert.equal(encoded.hash, saved.hash);
  const textSubmitted = await artifacts.submit("agent_one", "run_one", "index.json");
  assert.deepEqual(validatePlan(textSubmitted.plan, { architecture }), plan);
  assert.equal(textSubmitted.snapshot.hash, accepted.snapshot.hash, "公开文本协议与结构化协议封存同一规范材料，不改变用例或特殊字符");
  const originalIndex = await readFile(join(directory, "index.json"), "utf8");
  const changedInput = { fixture: { op: "value", value: { payload: "new input" } } };
  const updated = JSON.parse((await call(tools, "update_plan_json", { path: "cases/all.json", expectedHash: saved.hash,
    updates: [{ pointer: "/0/input", value: changedInput }] })).content[0].text);
  assert.equal(updated.updated, 1); assert.notEqual(updated.hash, saved.hash);
  const revised = await artifacts.submit("agent_one", "run_one", "index.json");
  assert.deepEqual(revised.plan.cases[0].input, changedInput);
  assert.equal(await readFile(join(directory, "index.json"), "utf8"), originalIndex);
  assert.deepEqual((await artifacts.validateSnapshot(accepted.snapshot)).plan, plan);
  assert.throws(() => validatePlan(revised.plan, { architecture, previousPlan: plan }), /不能删除或替换/);
});

test("专用批次工具复用当轮v2/v3用例schema，字符串与坏批次拒绝且不创建或覆盖材料", async (t) => {
  for (const casesSchema of [PLAN_V2_SCHEMA.properties.cases, PLAN_V3_SCHEMA.properties.cases]) {
    const { tools, directory } = await fixture(t, { casesSchema });
    const tool = tools.find((item) => item.name === "save_plan_cases");
    assert.equal(tool.parameters.properties.cases, casesSchema);
    const cases = [{ id: "one", taskId: "core", acceptanceId: "accept", kind: "action", actionId: "run", mocks: [],
      input: { fixture: { op: "value", value: { text: '引号"和换行\n' } } },
      assertions: [{ path: "", expectedJson: { fixture: { op: "value", value: { result: true } } } }],
      ...(casesSchema === PLAN_V3_SCHEMA.properties.cases ? { workflowInputs: [] } : {}) }];
    await assert.rejects(call(tools, "save_plan_cases", { path: "cases.json", cases: JSON.stringify(cases) }), /cases须为/);
    await assert.rejects(stat(join(directory, "cases.json")), { code: "ENOENT" });
    const saved = JSON.parse((await call(tools, "save_plan_cases", { path: "cases.json", cases })).content[0].text);
    assert.equal(saved.caseCount, 1); assert.equal(saved.inputEncoding, "structured");
    const before = await readFile(join(directory, "cases.json"), "utf8");
    assert.deepEqual(JSON.parse(before), cases);
    for (const rejected of [JSON.stringify(cases), [], [{}], Array.from({ length: 201 }, () => cases[0])]) {
      await assert.rejects(call(tools, "save_plan_cases", { path: "cases.json", cases: rejected }), /cases须为/);
      assert.equal(await readFile(join(directory, "cases.json"), "utf8"), before);
    }
    const controller = new AbortController(); controller.abort();
    await assert.rejects(call(tools, "save_plan_cases", { path: "cases.json", cases }, controller.signal), { name: "AbortError" });
    assert.equal(await readFile(join(directory, "cases.json"), "utf8"), before);
  }
});

test("整批保存不能用局部数组静默遗漏原用例，显式局部删除及坏JSON修复仍可用", async (t) => {
  const { tools, directory } = await fixture(t);
  const base = { taskId: "core", acceptanceId: "accept", kind: "action", actionId: "run", mocks: [], input: "{}", assertions: [{ path: "", expectedJson: "true" }] };
  const cases = Array.from({ length: 26 }, (_, index) => ({ ...base, id: `case_${index}` }));
  const original = JSON.parse((await call(tools, "save_plan_cases", { path: "cases.json", cases })).content[0].text);
  const before = await readFile(join(directory, "cases.json"));
  await assert.rejects(call(tools, "save_plan_cases", { path: "cases.json", cases: cases.slice(0, 2) }), (error) => {
    assert.equal(error.reason, "planning_case_loss"); assert.match(error.message, /case_25/); assert.match(error.message, new RegExp(original.fileHash)); return true;
  });
  assert.deepEqual(await readFile(join(directory, "cases.json")), before);
  const edited = await call(tools, "edit_plan_cases", { path: "cases.json", expectedHash: original.fileHash, changes: [{ op: "remove", id: "case_25" }] });
  assert.equal(JSON.parse(edited.content[0].text).updated, 1);
  assert.equal(JSON.parse(await readFile(join(directory, "cases.json"), "utf8")).length, 25);
  await writeFile(join(directory, "cases.json"), "[{");
  await call(tools, "save_plan_cases", { path: "cases.json", cases: cases.slice(0, 2) });
  assert.deepEqual(JSON.parse(await readFile(join(directory, "cases.json"), "utf8")), cases.slice(0, 2));
  await writeFile(join(directory, "cases.json"), JSON.stringify([cases[0], cases[0]]));
  await call(tools, "save_plan_cases", { path: "cases.json", cases: [cases[0]] });
  assert.deepEqual(JSON.parse(await readFile(join(directory, "cases.json"), "utf8")), [cases[0]], "同ID重复草稿仍可明确修复，不要求保留重复项");
});

test("历史草稿精确分页与同名CAS恢复复用原字节，不自动提交或重写当前索引", async (t) => {
  const { artifacts, tools, directory } = await fixture(t);
  const oldTools = await artifacts.tools("agent_one", "old_run", { casesSchema: PLAN_V2_SCHEMA.properties.cases });
  const base = { taskId: "core", acceptanceId: "accept", kind: "action", actionId: "run", mocks: [], input: "{}", assertions: [{ path: "", expectedJson: '"原始断言\\n保持"' }] };
  await save(oldTools, "index.json", { caseFiles: ["cases.json"], summary: "旧索引" });
  await call(oldTools, "save_plan_cases", { path: "cases.json", cases: [{ ...base, id: "one" }, { ...base, id: "two" }] });
  const snapshot = await artifacts.captureDraft("agent_one", "old_run", "index.json");
  await save(tools, "index.json", { caseFiles: ["cases.json"], summary: "当前索引" });
  await call(tools, "save_plan_cases", { path: "cases.json", cases: [{ ...base, id: "changed" }] });
  const bound = await artifacts.tools("agent_one", "run_one", { casesSchema: PLAN_V2_SCHEMA.properties.cases, historicalDraft: snapshot });
  const sourceBytes = await readFile(join(snapshot.path, "cases.json"));
  let offset = 0, text = "", historical;
  do {
    historical = JSON.parse((await call(bound, "read_plan_file", { path: "cases.json", source: "previous", offset, limit: 17 })).content[0].text);
    text += historical.content; offset = historical.nextOffset;
  } while (historical.truncated);
  assert.equal(text, sourceBytes.toString("utf8")); assert.equal(historical.trust, "unverified"); assert.equal(historical.sourceRunId, "old_run");
  const current = JSON.parse((await call(bound, "read_plan_file", { path: "cases.json" })).content[0].text);
  for (const expectedHash of [null, snapshot.hash, "0".repeat(64)])
    await assert.rejects(call(bound, "restore_plan_file", { path: "cases.json", expectedSourceHash: historical.fileHash, expectedHash }), /已改变|状态不符/u);
  await assert.rejects(call(bound, "restore_plan_file", { path: "cases.json", expectedSourceHash: snapshot.hash, expectedHash: current.fileHash }), /源文件.*摘要/u);
  const restored = JSON.parse((await call(bound, "restore_plan_file", { path: "cases.json", expectedSourceHash: historical.fileHash, expectedHash: current.fileHash })).content[0].text);
  assert.equal(restored.restored, true); assert.equal(restored.trust, "unverified");
  assert.deepEqual(await readFile(join(directory, "cases.json")), sourceBytes);
  await assert.rejects(call(bound, "restore_plan_file", { path: "cases.json", expectedSourceHash: historical.fileHash, expectedHash: null }), (error) => {
    assert.equal(error.reason, "planning_restore_conflict");
    assert.equal(error.restoreState.restored, false); assert.equal(error.restoreState.currentMatchesSource, true);
    assert.equal(error.restoreState.currentFileHash, historical.fileHash);
    assert.match(error.message, /无需恢复/u); return true;
  });
  assert.equal(JSON.parse(await readFile(join(directory, "index.json"), "utf8")).summary, "当前索引");
  assert.deepEqual(await readFile(join(snapshot.path, "cases.json")), sourceBytes);
  await assert.rejects(call(bound, "restore_plan_file", { path: "cases.json", expectedSourceHash: historical.fileHash, expectedHash: current.fileHash }), /已改变/u);
  await call(tools, "save_plan_cases", { path: "cases.json", cases: [{ ...base, id: "one" }, { ...base, id: "two", input: '{"changed":true}' }] });
  const parallelBase = JSON.parse((await call(bound, "read_plan_file", { path: "cases.json" })).content[0].text);
  const contenders = await Promise.allSettled(Array.from({ length: 2 }, () => call(bound, "restore_plan_file", {
    path: "cases.json", expectedSourceHash: historical.fileHash, expectedHash: parallelBase.fileHash })));
  assert.equal(contenders.filter((item) => item.status === "fulfilled").length, 1, "并发恢复共用规划锁，只有一个旧CAS能成功");
  await rm(join(directory, "cases.json"));
  await call(bound, "restore_plan_file", { path: "cases.json", expectedSourceHash: historical.fileHash, expectedHash: null });
  assert.deepEqual(await readFile(join(directory, "cases.json")), sourceBytes);
  await assert.rejects(call(bound, "read_plan_file", { path: "../outside.json", source: "previous" }));
  await assert.rejects(call(bound, "read_plan_file", { path: "absent.json", source: "previous" }), /没有此文件/u);
  await assert.rejects(call(tools, "read_plan_file", { path: "cases.json", source: "previous" }), /没有绑定/u);
  assert.equal(tools.some((tool) => tool.name === "restore_plan_file"), false);
  await assert.rejects(artifacts.tools("other_agent", "run_one", { casesSchema: PLAN_V2_SCHEMA.properties.cases, historicalDraft: snapshot }), /标识/u);
  const frozen = await artifacts.tools("agent_one", "run_one", { casesSchema: PLAN_V2_SCHEMA.properties.cases, historicalDraft: snapshot, previousPlan: { cases: [] } });
  assert.equal(frozen.some((tool) => tool.name === "restore_plan_file"), false, "已接受计划不开放历史恢复");
  await assert.rejects(artifacts.tools("agent_one", "run_one", { casesSchema: PLAN_V2_SCHEMA.properties.cases,
    historicalDraft: { ...snapshot, path: join(directory, "other.json") } }), /不属于/u);
  await chmod(snapshot.path, 0o700); await chmod(join(snapshot.path, "cases.json"), 0o600);
  const outside = join(directory, "outside.json"); await writeFile(outside, '{"private":"unrelated"}');
  await rm(join(snapshot.path, "cases.json")); await symlink(outside, join(snapshot.path, "cases.json"));
  await assert.rejects(call(bound, "read_plan_file", { path: "cases.json", source: "previous" }), /链接/u);
  await rm(join(snapshot.path, "cases.json")); await writeFile(join(snapshot.path, "cases.json"), sourceBytes);
  await writeFile(join(snapshot.path, "cases.json"), "[]");
  await assert.rejects(call(bound, "read_plan_file", { path: "cases.json", source: "previous" }), /已改变/u);
  await assert.rejects(call(bound, "restore_plan_file", { path: "cases.json", expectedSourceHash: historical.fileHash, expectedHash: historical.fileHash }), /已改变/u);
});

test("结构化更新拒绝越界、原型键、重叠和旧摘要，失败不替换文件", async (t) => {
  const { tools, directory } = await fixture(t);
  await call(tools, "save_plan_json", { path: "case.json", value: [{ id: "one", input: { "a/b": { "~key": 1 } } }] });
  const before = await readFile(join(directory, "case.json"), "utf8");
  const badUpdates = [
    [{ pointer: "/0/__proto__", value: {} }], [{ pointer: "/0/input/constructor", value: {} }],
    [{ pointer: "/1", value: {} }], [{ pointer: "/00/id", value: "two" }], [{ pointer: "/-", value: {} }],
    [{ pointer: "/0/missing", value: 1 }], [{ pointer: "/0/input/~2", value: 1 }],
    [{ pointer: "/0/id", value: "two" }, { pointer: "/0/id", value: "three" }],
    [{ pointer: "/0/input", value: {} }, { pointer: "/0/input/a~1b", value: 2 }],
    Array.from({ length: 41 }, (_, i) => ({ pointer: `/0/input/${i}`, value: i })),
  ];
  for (const updates of badUpdates) {
    await assert.rejects(call(tools, "update_plan_json", { path: "case.json", updates }));
    assert.equal(await readFile(join(directory, "case.json"), "utf8"), before);
  }
  await assert.rejects(call(tools, "update_plan_json", { path: "case.json", expectedHash: "0".repeat(64), updates: [{ pointer: "/0/id", value: "two" }] }), /已改变/);
  await call(tools, "update_plan_json", { path: "case.json", updates: [{ pointer: "/0/input/a~1b/~0key", value: 2 }] });
  assert.equal(JSON.parse(await readFile(join(directory, "case.json"), "utf8"))[0].input["a/b"]["~key"], 2);
});

test("带BOM材料的分页摘要匹配原始文件，结构化更新仍拒绝真正过期的摘要", async (t) => {
  const { tools, directory } = await fixture(t);
  await call(tools, "write", { path: "case.json", content: '\uFEFF{"id":"before"}' });
  const page = JSON.parse((await call(tools, "read_plan_file", { path: "case.json", offset: 0, limit: 6 })).content[0].text);
  assert.equal(page.content, '{"id":');
  assert.equal(page.nextOffset, 6);
  const updated = JSON.parse((await call(tools, "update_plan_json", { path: "case.json", expectedHash: page.hash,
    updates: [{ pointer: "/id", value: "after" }] })).content[0].text);
  assert.notEqual(updated.hash, page.hash);
  const after = await readFile(join(directory, "case.json"), "utf8");
  assert.equal(JSON.parse(after).id, "after");
  await assert.rejects(call(tools, "update_plan_json", { path: "case.json", expectedHash: page.hash,
    updates: [{ pointer: "/id", value: "stale" }] }), /已改变/);
  assert.equal(await readFile(join(directory, "case.json"), "utf8"), after);
});

test("结构化工具不执行访问器并拒绝过深、过大、非JSON、链接和越界写入", async (t) => {
  const { tools, directory, root } = await fixture(t);
  let accessed = false;
  const getter = Object.defineProperty({}, "value", { enumerable: true, get() { accessed = true; return "secret"; } });
  const toJSON = { toJSON() { accessed = true; return {}; } };
  let deep = {}; for (let i = 0; i < 34; i++) deep = { child: deep };
  for (const value of [getter, toJSON, deep, { value: undefined }, { value: Infinity }, { value: 1n }, { value: "x".repeat(PLAN_ARTIFACT_LIMITS.fileBytes + 1) }, new Date(), [, 1]])
    await assert.rejects(call(tools, "save_plan_json", { path: "denied.json", value }));
  assert.equal(accessed, false); await assert.rejects(stat(join(directory, "denied.json")), { code: "ENOENT" });
  const data = JSON.parse('{"__proto__":{"polluted":true},"constructor":"ordinary data","toJSON":"ordinary field"}');
  await call(tools, "save_plan_json", { path: "data.json", value: data });
  assert.deepEqual(JSON.parse(await readFile(join(directory, "data.json"), "utf8")), data);
  assert.equal({}.polluted, undefined);
  for (const path of ["../outside.json", ".env.json", "main.mjs"])
    await assert.rejects(call(tools, "save_plan_json", { path, value: {} }));
  const outside = join(root, "outside.json"); await writeFile(outside, "{}"); await symlink(outside, join(directory, "linked.json"));
  await assert.rejects(call(tools, "save_plan_json", { path: "linked.json", value: {} }), /链接/);
  assert.equal(await readFile(outside, "utf8"), "{}");
});

test("结构化更新与预览串行，取消在原子写前保留旧文件和快照依据", async (t) => {
  const { artifacts, tools } = await fixture(t);
  await call(tools, "save_plan_json", { path: "index.json", value: { caseFiles: ["case.json"] } });
  await call(tools, "save_plan_json", { path: "case.json", value: { id: "before" } });
  const original = artifacts.write.bind(artifacts), controller = new AbortController();
  let enter, release;
  const entered = new Promise((resolve) => { enter = resolve; }), resume = new Promise((resolve) => { release = resolve; });
  artifacts.write = async (...args) => { enter(); await resume; return original(...args); };
  const updating = call(tools, "update_plan_json", { path: "case.json", updates: [{ pointer: "/id", value: "after" }] }, controller.signal);
  await entered;
  let observed = false;
  const preview = artifacts.preview("agent_one", "run_one", "index.json").then((value) => { observed = true; return value; });
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(observed, false);
  controller.abort(); release();
  await assert.rejects(updating, { name: "AbortError" });
  assert.equal((await preview).plan.cases[0].id, "before");
});

test("坏JSON定位仅公开解析器数字，结构化重存可恢复而不自动接受计划", async (t) => {
  const { artifacts, tools, directory } = await fixture(t);
  await save(tools, "index.json", { caseFiles: ["case.json"] });
  const bad = '[\n  {"PRIVATE_VALUE": 1,}\n]';
  await writeFile(join(directory, "case.json"), bad, { mode: 0o600 });
  await assert.rejects(artifacts.preview("agent_one", "run_one", "index.json"), (error) => {
    assert.equal(error.artifactIssue.parseError, "json");
    assert.equal(error.artifactIssue.location.line, 2);
    assert.ok(error.artifactIssue.location.column > 1);
    assert.doesNotMatch(error.message + JSON.stringify(error.artifactIssue), /PRIVATE_VALUE/); return true;
  });
  await call(tools, "save_plan_json", { path: "case.json", value: { id: "case_one" } });
  const candidate = await artifacts.submit("agent_one", "run_one", "index.json");
  assert.throws(() => validatePlan(candidate.plan, { architecture: developmentArchitecture() }), /研发契约无效/);
});

test("原生write/edit不能把有效规划改坏，拒绝保留原文后仍能精确更新", async (t) => {
  const { artifacts, tools, directory } = await fixture(t);
  await save(tools, "index.json", { caseFiles: ["case.json"] });
  await save(tools, "case.json", { id: "before", details: { count: 1 } });
  const file = join(directory, "case.json"), before = await readFile(file, "utf8");
  const check = (error) => {
    assert.equal(error.reason, "planning_artifact_invalid"); assert.equal(error.artifactIssue.parseError, "json");
    assert.ok(error.artifactIssue.location.line >= 1); assert.ok(error.artifactIssue.location.column >= 1);
    assert.doesNotMatch(error.message + JSON.stringify(error.artifactIssue), /PRIVATE_CONTENT/); return true;
  };
  await assert.rejects(call(tools, "write", { path: "case.json", content: '{\n"PRIVATE_CONTENT":1,\n}' }), check);
  assert.equal(await readFile(file, "utf8"), before);
  await assert.rejects(call(tools, "edit", { path: "case.json", edits: [{ oldText: '"id": "before"', newText: '"id": "PRIVATE_CONTENT",' }] }), check);
  assert.equal(await readFile(file, "utf8"), before);
  for (const content of ["null", "7", "false", '"text"'])
    await assert.rejects(call(tools, "write", { path: "new.json", content }), /结构无效/);
  await assert.rejects(stat(join(directory, "new.json")), { code: "ENOENT" });
  await call(tools, "update_plan_json", { path: "case.json", updates: [{ pointer: "/details/count", value: 2 }] });
  assert.deepEqual((await artifacts.preview("agent_one", "run_one", "index.json")).plan.cases[0], { id: "before", details: { count: 2 } });
  await call(tools, "write", { path: "draft.json", content: "{}" });
  assert.deepEqual(JSON.parse(await readFile(join(directory, "draft.json"), "utf8")), {}, "渐进材料只检查JSON语法与根类型，不提前要求完整计划");
});

test("公开JSON文本保存只解析一次，不修坏文本、不接受基本值并保持相同数据额度", async (t) => {
  const { tools, directory } = await fixture(t);
  await call(tools, "save_plan_json", { path: "case.json", value: { id: "before" } });
  const original = await readFile(join(directory, "case.json"), "utf8");
  const malformed = '[\n{"PRIVATE_CONTENT":1,}\n]';
  await assert.rejects(call(tools, "save_plan_json", { path: "case.json", value: malformed }), (error) => {
    assert.equal(error.artifactIssue.parseError, "json"); assert.equal(error.artifactIssue.location.line, 2);
    assert.doesNotMatch(error.message + JSON.stringify(error.artifactIssue), /PRIVATE_CONTENT/); return true;
  });
  for (const value of ["null", "false", "7", JSON.stringify("ordinary string"), JSON.stringify(JSON.stringify({ id: "twice" }))]) {
    await assert.rejects(call(tools, "save_plan_json", { path: "case.json", value }), /只解码一次/);
    assert.equal(await readFile(join(directory, "case.json"), "utf8"), original);
  }
  let deep = {}; for (let i = 0; i < 34; i++) deep = { child: deep };
  for (const value of [JSON.stringify(deep), JSON.stringify({ items: Array(100001).fill(0) }), JSON.stringify({ text: "x".repeat(PLAN_ARTIFACT_LIMITS.fileBytes) })]) {
    await assert.rejects(call(tools, "save_plan_json", { path: "case.json", value }));
    assert.equal(await readFile(join(directory, "case.json"), "utf8"), original);
  }
});

test("结构对象与JSON文本按同一内容根计算深度和节点，参数外壳不改变额度", async (t) => {
  const { tools, directory } = await fixture(t);
  const nested = (depth) => { let value = {}; for (let i = 0; i < depth; i++) value = { child: value }; return value; };
  for (const value of [nested(32), { items: Array(99998).fill(0) }]) {
    for (const [inputEncoding, input] of [["structured", value], ["json-text", JSON.stringify(value)]]) {
      const reply = JSON.parse((await call(tools, "save_plan_json", { path: "boundary.json", value: input })).content[0].text);
      assert.equal(reply.inputEncoding, inputEncoding);
      assert.deepEqual(JSON.parse(await readFile(join(directory, "boundary.json"), "utf8")), value);
    }
  }
  const before = await readFile(join(directory, "boundary.json"), "utf8");
  for (const value of [nested(33), { items: Array(99999).fill(0) }]) for (const input of [value, JSON.stringify(value)]) {
    await assert.rejects(call(tools, "save_plan_json", { path: "boundary.json", value: input }), /深度或节点额度/);
    assert.equal(await readFile(join(directory, "boundary.json"), "utf8"), before);
  }
  let accessed = false;
  const getter = () => { accessed = true; return { id: "unsafe" }; };
  for (const params of [
    Object.defineProperty({ path: "boundary.json" }, "value", { enumerable: true, get: getter }),
    Object.defineProperty({ value: {} }, "path", { enumerable: true, get: getter }),
    Object.assign(Object.create({ inherited: true }), { path: "boundary.json", value: {} }),
    { path: "boundary.json", value: {}, [Symbol("extra")]: true },
  ]) await assert.rejects(call(tools, "save_plan_json", params));
  assert.equal(accessed, false);
  assert.equal(await readFile(join(directory, "boundary.json"), "utf8"), before);
});
