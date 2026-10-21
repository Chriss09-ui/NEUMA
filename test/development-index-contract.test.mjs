import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevelopmentArtifacts } from "../src/development/development-artifacts.mjs";
import { PLAN_V2_SCHEMA, PLAN_V3_SCHEMA } from "../src/development/development-contract.mjs";

const skeleton = (version = 3) => ({ schemaVersion: version, summary: "当前任务与动作骨架", runtime: "node-action", entrypoint: "actions.mjs",
  tasks: [{ id: "core", title: "处理", description: "可执行增量", requirementIds: ["input"], acceptanceIds: ["normal"], dependsOn: [], files: ["actions.mjs"] }],
  application: { protocolVersion: 2, runtime: "node-action", entrypoint: "actions.mjs", page: null, stateVersion: 1, evidenceIds: [],
    actions: [{ id: "process", title: "处理", inputSchema: { type: "object" }, outputSchema: { type: "object" }, connectionIds: [] }] },
  caseFiles: [] });
const call = (tools, name, args) => tools.find((tool) => tool.name === name).execute("test-index", args);
const parsed = (reply) => JSON.parse(reply.content[0].text);

async function fixture(t, { schema = PLAN_V3_SCHEMA, indexPath } = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-index-contract-"));
  t.after(async () => {
    const unseal = async (path) => { await chmod(path, 0o700); for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await unseal(join(path, entry.name)); };
    await unseal(root); await rm(root, { recursive: true, force: true });
  });
  const artifacts = new DevelopmentArtifacts({ dataDir: join(root, "data") });
  const tools = await artifacts.tools("index_agent", "index_run", { casesSchema: schema.properties.cases, planSchema: schema, indexPath });
  return { artifacts, tools, directory: await artifacts.directory("index_agent", "index_run") };
}

test("当轮索引schema同源约束native write/edit与save/update，拒绝后原字节和权限不变", async (t) => {
  const f = await fixture(t), original = skeleton(), path = "index.json";
  await call(f.tools, "write", { path, content: JSON.stringify(original, null, 2) + "\n" });
  const before = await readFile(join(f.directory, path)), metadata = await stat(join(f.directory, path));
  const ordinary = { ...original, cases: [], activationCases: [], PRIVATE_FIELD_NAME: "PRIVATE_FIELD_VALUE" };
  delete ordinary.schemaVersion; delete ordinary.caseFiles;
  for (const [name, args] of [
    ["write", { path, content: JSON.stringify(ordinary) }],
    ["edit", { path, edits: [{ oldText: '"schemaVersion": 3', newText: '"schemaVersion": 99' }] }],
    ["save_plan_json", { path, value: ordinary }],
    ["save_plan_json", { path, value: JSON.stringify(ordinary) }],
    ["update_plan_json", { path, updates: [{ pointer: "/schemaVersion", value: 99 }] }],
    ["update_plan_json", { path, updates: [{ pointer: "/caseFiles", value: "PRIVATE_FIELD_VALUE" }] }],
  ]) {
    await assert.rejects(call(f.tools, name, args), (error) => {
      assert.match(error.message, /规划索引骨架无效/);
      assert.doesNotMatch(error.message, /PRIVATE_FIELD_NAME|PRIVATE_FIELD_VALUE/);
      const payload = JSON.parse(error.message.slice(error.message.indexOf("{")));
      assert.equal(payload.saved, false); assert.ok(payload.issues.length);
      return true;
    }, name);
    assert.deepEqual(await readFile(join(f.directory, path)), before, name);
    const after = await stat(join(f.directory, path));
    for (const key of ["size", "mtimeMs", "mode", "ino"]) assert.equal(after[key], metadata[key], `${name}:${key}`);
  }
  const page = parsed(await call(f.tools, "read_plan_file", { path }));
  await call(f.tools, "update_plan_json", { path, expectedHash: page.fileHash, updates: [{ pointer: "/summary", value: "主动修改摘要" }] });
  await call(f.tools, "edit", { path, edits: [{ oldText: "主动修改摘要", newText: "原生编辑摘要" }] });
  assert.equal(JSON.parse(await readFile(join(f.directory, path), "utf8")).summary, "原生编辑摘要");
});

test("第一次默认索引写入即检查必填骨架，普通plan不能自动转为分文件索引", async (t) => {
  const f = await fixture(t), ordinary = { ...skeleton(), cases: [] };
  delete ordinary.schemaVersion; delete ordinary.caseFiles;
  await assert.rejects(call(f.tools, "write", { path: "index.json", content: JSON.stringify(ordinary) }), (error) => {
    const payload = JSON.parse(error.message.slice(error.message.indexOf("{")));
    const version = payload.issues.find((issue) => issue.path === "planningFiles.index.schemaVersion");
    assert.equal(version.rule, "required"); assert.deepEqual(version.allowedValues, [3]); assert.equal(version.expectedType, "integer");
    assert.ok(payload.issues.some((issue) => issue.path === "planningFiles.index.caseFiles" && issue.rule === "required"));
    const unknown = payload.issues.find((issue) => issue.rule === "additionalProperties");
    assert.ok(unknown.allowedFields.includes("schemaVersion")); assert.ok(unknown.requiredFields.includes("caseFiles"));
    assert.equal(unknown.allowedFields.includes("cases"), false);
    return true;
  });
  await assert.rejects(readFile(join(f.directory, "index.json")), { code: "ENOENT" });
});

test("旧坏索引精确诊断安全字段、必填列表及本轮版本枚举，读取不改文件", async (t) => {
  const f = await fixture(t), broken = { ...skeleton(), cases: [], activationCases: [], PRIVATE_UNKNOWN_NAME: { value: "PRIVATE_VALUE" } };
  delete broken.schemaVersion; delete broken.caseFiles; delete broken.application.actions[0].title;
  const bytes = JSON.stringify(broken, null, 2); await writeFile(join(f.directory, "index.json"), bytes);
  const result = parsed(await call(f.tools, "read_plan_diagnostics", { indexPath: "index.json", limit: 40 }));
  assert.equal(result.status, "rejected");
  const issues = result.diagnostics.issues;
  assert.ok(issues.some((issue) => issue.path === "planningFiles.index.schemaVersion" && issue.rule === "required" && issue.allowedValues[0] === 3));
  assert.ok(issues.some((issue) => issue.path === "planningFiles.index.caseFiles" && issue.rule === "required"));
  assert.ok(issues.some((issue) => issue.path === "planningFiles.index.application.actions[0].title" && issue.rule === "required"));
  assert.equal(issues.some((issue) => issue.reason === "planning_material_shape"), false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_UNKNOWN_NAME|PRIVATE_VALUE/);
  assert.equal(await readFile(join(f.directory, "index.json"), "utf8"), bytes);
  await call(f.tools, "save_plan_json", { path: "index.json", value: skeleton() });
  assert.equal(parsed(await call(f.tools, "read_plan_diagnostics", { indexPath: "index.json" })).status, "incomplete");
});

test("空caseFiles是合法草稿但不能正式封存提交，v2/v3使用各自schema版本", async (t) => {
  for (const [version, schema] of [[2, PLAN_V2_SCHEMA], [3, PLAN_V3_SCHEMA]]) {
    const f = await fixture(t, { schema }), value = skeleton(version);
    await call(f.tools, "save_plan_json", { path: "index.json", value });
    const diagnostic = await f.artifacts.diagnose("index_agent", "index_run", "index.json", { schema });
    assert.equal(diagnostic.status, "incomplete");
    assert.equal(diagnostic.diagnostics.issues.some((issue) => issue.reason === "planning_index_schema"), false);
    await assert.rejects(f.artifacts.submit("index_agent", "index_run", "index.json"), /结构无效/);
    value.schemaVersion = version === 2 ? 3 : 2;
    await assert.rejects(call(f.tools, "save_plan_json", { path: "index.json", value }), (error) => {
      assert.deepEqual(error.planningIssues.find((issue) => issue.path === "planningFiles.index.schemaVersion").allowedValues, [version]); return true;
    });
  }
});

test("自定义索引通过已识别caseFiles、显式indexPath或诊断绑定，普通JSON数据仍能读写编辑", async (t) => {
  const f = await fixture(t), custom = "draft/custom.json";
  await call(f.tools, "save_plan_json", { path: custom, value: skeleton() });
  const replaced = { ...skeleton(), cases: [] }; delete replaced.caseFiles;
  const fresh = await f.artifacts.tools("index_agent", "index_run", { casesSchema: PLAN_V3_SCHEMA.properties.cases, planSchema: PLAN_V3_SCHEMA });
  await assert.rejects(call(fresh, "write", { path: custom, content: JSON.stringify(replaced) }), /骨架无效/);
  const explicit = await fixture(t, { indexPath: "custom-plan.json" });
  await assert.rejects(call(explicit.tools, "write", { path: "custom-plan.json", content: JSON.stringify(replaced) }), /骨架无效/);
  await call(f.tools, "save_plan_json", { path: "data.json", value: { cases: [], label: "普通JSON数据" } });
  await call(f.tools, "edit", { path: "data.json", edits: [{ oldText: "普通JSON数据", newText: "更新普通数据" }] });
  await call(f.tools, "update_plan_json", { path: "data.json", updates: [{ pointer: "/cases", value: [1, 2] }] });
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, "data.json"), "utf8")), { cases: [1, 2], label: "更新普通数据" });
  await call(f.tools, "save_plan_json", { path: "declared.json", value: { plain: true } });
  await f.artifacts.diagnose("index_agent", "index_run", "declared.json", { schema: PLAN_V3_SCHEMA });
  await assert.rejects(call(f.tools, "save_plan_json", { path: "declared.json", value: { plain: false } }), /骨架无效/);
});
