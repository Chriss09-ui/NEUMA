import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnoseApplicationManifest } from "../src/development/application-manifest-diagnostics.mjs";
import { PLAN_V3_SCHEMA, validatePlan } from "../src/development/development-contract.mjs";
import { DevelopmentArtifacts } from "../src/development/development-artifacts.mjs";
import { validateApplicationManifest } from "../src/applications/application-contract.mjs";
import { createPiSession } from "../src/runtime/pi-runtime.mjs";
import { developmentArchitecture, developmentPlan } from "./helpers/development.mjs";

const valueSchema = () => ({ type: "object", properties: {}, required: [], additionalProperties: false });
function fixture(language = "python", host = "managed") {
  const architecture = developmentArchitecture();
  Object.assign(architecture.design, { schemaVersion: 3, connections: [], interaction: { page: false }, execution: { language, hosting: host } });
  const plan = developmentPlan(architecture), entrypoint = language === "python" ? "main.py" : "main.mjs";
  Object.assign(plan, { schemaVersion: 3, runtime: "managed-service", entrypoint, application: {
    protocolVersion: 3, runtime: "managed-service", entrypoint, page: null, stateVersion: 1, evidenceIds: [],
    actions: [{ id: "run", title: "处理", inputSchema: valueSchema(), outputSchema: valueSchema(), connectionIds: [] }],
    service: { schemaVersion: 1, language, host, entrypoint, operations: [{ id: "run", inputSchema: valueSchema(), outputSchema: valueSchema(), connectionIds: [] }],
      ...(host === "docker" ? { docker: { baseImage: `node@sha256:${"0".repeat(64)}` } } : {}) },
  } });
  for (const task of plan.tasks) task.files = [entrypoint];
  for (const item of plan.cases) Object.assign(item, { kind: "action", actionId: "run", mocks: [], input: "{}" });
  return { architecture, plan };
}
const diagnose = (plan, options = {}) => diagnoseApplicationManifest(plan.application, { schema: PLAN_V3_SCHEMA.properties.application, plan, ...options });

test("Node/Python与直接托管/Docker共用正式服务原因和入口扩展名诊断，合法清单不误报", () => {
  for (const language of ["javascript", "python"]) for (const host of ["managed", "docker"]) {
    const { plan, architecture } = fixture(language, host);
    assert.equal(diagnose(plan).valid, true); assert.doesNotThrow(() => validatePlan(plan, { architecture }));
    plan.application.service.entrypoint = language === "python" ? "PRIVATE_ENTRY.mjs" : "PRIVATE_ENTRY.py";
    const result = diagnose(plan), entry = result.issues.find((item) => item.path === "plan.application.service.entrypoint");
    assert.equal(entry.reason, "invalid_service_entrypoint");
    assert.deepEqual(entry.expectedExtensions, language === "python" ? [".py"] : [".mjs", ".js", ".cjs"]);
    assert.match(entry.remedy, /应用骨架.*同步计划、应用入口及任务文件.*不要改用例/);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ENTRY/);
    assert.throws(() => validateApplicationManifest(plan.application, { allowUnverified: true }));
  }
});

test("一轮汇总结构、入口、资源、依赖、字段边界与公开操作不一致，不回显动态名或值", () => {
  const { plan } = fixture("python", "docker"), service = plan.application.service;
  service.entrypoint = "PRIVATE_ENTRY.mjs"; plan.entrypoint = plan.application.entrypoint = service.entrypoint;
  service.resources = { memoryMiB: 1, timeoutMs: 0 };
  service.operations[0].visibility = "PRIVATE_VISIBILITY";
  service.operations[0].inputSchema = { type: "object", properties: { PRIVATE_FIELD: { type: "string", minLength: 10, maxLength: 1, pattern: "PRIVATE_PATTERN" } }, required: [], additionalProperties: false };
  service.dependencies = { packages: [{ name: "package", version: "1", sha256: "0".repeat(64), filename: "archive.tgz", url: "https://PRIVATE_ACCOUNT:PRIVATE_PASSWORD@example.com/PRIVATE_PATH" }] };
  service.docker.baseImage = "PRIVATE_IMAGE"; service.dataVersion = 2;
  const result = diagnose(plan);
  for (const [path, reason] of [
    ["plan.application.service.entrypoint", "invalid_service_entrypoint"],
    ["plan.application.service.resources.memoryMiB", "invalid_service_limits"],
    ["plan.application.service.resources.timeoutMs", "invalid_service_limits"],
    ["plan.application.service.dependencies.packages[0].url", "untrusted_dependency_source"],
    ["plan.application.service.dependencies.packages[0].filename", "unsupported_dependency_format"],
    ["plan.application.service.docker.baseImage", "docker_image_must_be_pinned"],
    ["plan.application.service.operations[0].inputSchema.properties[0].minLength", "schema_bounds_invalid"],
    ["plan.application.actions[0].inputSchema", "service_operation_mismatch"],
    ["plan.application.stateVersion", "service_data_version_mismatch"],
  ]) assert.ok(result.issues.some((item) => item.path === path && item.reason === reason), `${path}:${reason}`);
  assert.ok(result.total > 10); assert.equal(result.truncated, false); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  const bounded = diagnose(plan, { limit: 3 }); assert.equal(bounded.issues.length, 3); assert.equal(bounded.total, result.total); assert.equal(bounded.truncated, true);
});

test("公开字段、页面资源及深层schema各自定位，拒绝访问器并允许嵌套原生JSON", () => {
  const { plan } = fixture();
  plan.application.service.operations[0].outputSchema = { type: "object", properties: { data: {} }, required: ["data"], additionalProperties: false };
  plan.application.actions[0].outputSchema = structuredClone(plan.application.service.operations[0].outputSchema);
  assert.equal(diagnose(plan).valid, true);
  plan.application.page = { entrypoint: "page.html", resources: [{ path: "PRIVATE_ASSET.exe", sha256: "PRIVATE_HASH" }] };
  plan.application.actions[0].PRIVATE_DYNAMIC_FIELD = "PRIVATE_VALUE";
  const result = diagnose(plan);
  assert.ok(result.issues.some((item) => item.path === "plan.application.actions[0]" && item.reason === "additionalProperties"));
  assert.ok(result.issues.some((item) => item.path === "plan.application.page.resources[0].path"));
  assert.ok(result.issues.some((item) => item.path === "plan.application.page.resources[0].sha256"));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  let accessed = false;
  assert.equal(diagnoseApplicationManifest({ get service() { accessed = true; throw new Error("PRIVATE"); } }).valid, false);
  assert.equal(accessed, false);
  const verified = fixture().plan;
  verified.application.evidenceIds = ["actual_test"];
  verified.application.page = { entrypoint: "page.html", resources: [{ path: "page.html", sha256: "0".repeat(64) }] };
  assert.equal(diagnose(verified, { allowUnverified: false }).valid, true, "诊断探针不能以空摘要或空证据污染正式清单");
  const unknown = fixture().plan; unknown.application.service.language = "PRIVATE_LANGUAGE"; unknown.application.service.host = "PRIVATE_HOST";
  const unsupported = diagnose(unknown);
  assert.ok(unsupported.issues.some((item) => item.path.endsWith(".language") && item.reason === "unsupported_service_runtime"));
  assert.ok(!unsupported.issues.some((item) => item.reason === "invalid_service_entrypoint"), "语言未知时不能臆定JavaScript后再误报Python扩展名");
  assert.doesNotMatch(JSON.stringify(unsupported), /PRIVATE_/);
});

test("局部合法用例可保存并同步报告索引应用错误，正式计划仍不能通过", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-app-diagnostics-")); t.after(() => rm(root, { recursive: true, force: true }));
  const { plan, architecture } = fixture(), artifacts = new DevelopmentArtifacts({ dataDir: root });
  const tools = await artifacts.tools("agent", "run", { planSchema: PLAN_V3_SCHEMA, casesSchema: PLAN_V3_SCHEMA.properties.cases, architecture });
  const call = (name, args) => tools.find((item) => item.name === name).execute("fixture", args);
  const { cases, ...index } = plan; index.application.service.entrypoint = "wrong.mjs";
  await call("save_plan_json", { path: "index.json", value: { ...index, caseFiles: ["cases.json"] } });
  await call("save_plan_json", { path: "cases.json", value: cases });
  const directory = await artifacts.directory("agent", "run"), before = await readFile(join(directory, "cases.json"));
  const saved = JSON.parse((await call("read_plan_file", { path: "cases.json" })).content[0].text);
  cases[0].assertions[0].expectedJson = '"未通过的新草稿值"';
  for (const [name, args] of [["save_plan_cases", { path: "cases.json", cases }], ["edit_plan_cases", { path: "cases.json", expectedHash: saved.hash,
    changes: [{ op: "replace", id: cases[0].id, case: cases[0] }] }]]) {
    if (name === "edit_plan_cases") args.expectedHash = JSON.parse((await call("read_plan_file", { path: "cases.json" })).content[0].text).fileHash;
    const result = JSON.parse((await call(name, args)).content[0].text);
    assert.equal(result.indexDiagnostics.status, "rejected");
    assert.ok(result.indexDiagnostics.issues.some((item) => item.path === "plan.application.service.entrypoint" && item.reason === "invalid_service_entrypoint"));
    assert.ok(result.indexDiagnostics.issues.every((item) => item.source.path === "index.json" && !item.path.startsWith("plan.cases")));
    const actual = await readFile(join(directory, "cases.json"));
    assert.notDeepEqual(actual, before); assert.deepEqual(JSON.parse(actual), cases);
    assert.throws(() => validatePlan({ ...index, cases }, { architecture }));
    const check = await artifacts.diagnose("agent", "run", "index.json", { schema: PLAN_V3_SCHEMA, architecture });
    assert.equal(check.status, "rejected");
  }
});

test("真实Pi收到应用骨架入口诊断后原会话读索引修正，原用例不变即可保存", { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-app-diagnostics-sdk-")), { plan, architecture } = fixture();
  const artifacts = new DevelopmentArtifacts({ dataDir: root }), tools = await artifacts.tools("agent", "run", { planSchema: PLAN_V3_SCHEMA,
    casesSchema: PLAN_V3_SCHEMA.properties.cases, architecture });
  const { cases, ...index } = structuredClone(plan), requests = []; let session, calls = 0, serverFailure;
  index.entrypoint = index.application.entrypoint = index.application.service.entrypoint = "main.mjs";
  for (const task of index.tasks) task.files = ["main.mjs"];
  await tools.find((item) => item.name === "save_plan_json").execute("index", { path: "index.json", value: { ...index, caseFiles: ["cases.json"] } });
  const model = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)), turn = requests.length + 1; requests.push(turn);
      let name, args;
      if (turn === 1 || turn === 4) { name = "save_plan_cases"; args = { path: "cases.json", cases }; }
      if (turn === 2) {
        const message = body.messages.findLast((item) => item.role === "tool").content, text = typeof message === "string" ? message : JSON.stringify(message);
        assert.match(text, /plan\.application\.service\.entrypoint/); assert.match(text, /invalid_service_entrypoint/);
        assert.match(text, /expectedExtensions.*\.py/); assert.doesNotMatch(text, /action_input_invalid|plan\.cases\[/);
        name = "read_plan_file"; args = { path: "index.json" };
      }
      if (turn === 3) {
        const message = body.messages.findLast((item) => item.role === "tool").content;
        const read = JSON.parse(typeof message === "string" ? message : JSON.stringify(message)), actual = JSON.parse(read.content);
        assert.equal(actual.application.service.language, "python"); assert.equal(actual.application.service.entrypoint, "main.mjs");
        name = "update_plan_json"; args = { path: "index.json", expectedHash: read.hash, updates: [
          { pointer: "/entrypoint", value: "main.py" }, { pointer: "/application/entrypoint", value: "main.py" },
          { pointer: "/application/service/entrypoint", value: "main.py" }, ...index.tasks.map((_item, position) => ({ pointer: `/tasks/${position}/files`, value: ["main.py"] })),
        ] };
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const delta = name ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${turn}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }
        : { role: "assistant", content: "原索引和用例已保存。" };
      response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0, delta, finish_reason: name ? "tool_calls" : "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    } catch (error) { serverFailure = error; response.writeHead(500); response.end(); }
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  t.after(async () => { session?.dispose(); model.closeAllConnections(); await new Promise((resolve) => model.close(resolve)); await rm(root, { recursive: true, force: true }); });
  session = await createPiSession({ config: { llmConfigured: true, model: "fixture-model", apiKey: "fixture-only",
    chatUrl: `http://127.0.0.1:${model.address().port}/v1/chat/completions` }, cwd: root, dataDir: root,
    systemPrompt: "仅在原索引修正应用骨架，不改变用例。", customTools: tools, onModelCall() { assert.ok(++calls <= 12); } });
  session.setAutoRetryEnabled(false); session.setAutoCompactionEnabled(false);
  await session.prompt("按现有索引保存原用例，失败时读取索引并修正已知骨架问题。");
  assert.equal(serverFailure, undefined); assert.equal(calls, 5);
  const assembled = (await artifacts.preview("agent", "run", "index.json")).plan;
  assert.deepEqual(assembled.cases, cases); assert.doesNotThrow(() => validatePlan(assembled, { architecture }));
});
