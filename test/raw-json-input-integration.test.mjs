import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { PrototypeAgents } from "../src/agents/agent-prototype.mjs";
import { createPiSession } from "../src/runtime/pi-runtime.mjs";
import { DevelopmentExecutor } from "../src/development/development-executor.mjs";
import { ManagedServiceManager } from "../src/services/managed-service-manager.mjs";
import { ServiceRuntimeStore } from "../src/services/service-runtime.mjs";
import { validDraft, validDesign, passingReview } from "./helpers/architecture.mjs";
import { developmentReview } from "./helpers/development.mjs";

const object = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const tag = "😀😁", row = (value = 3) => ({ id: "r1", value, note: 'quoted " and \\ path' });
const outputSchema = object({ status: { type: "string" }, position: { type: "integer" }, count: { type: "integer" },
  canonical: { type: "string", maxLength: 200000 }, tag: { type: "string", maxLength: 2 } });
const actions = [
  { id: "inspect", title: "固定JSON测试程序", inputSchema: object({ records: {}, tag: { type: "string", maxLength: 2 } }), outputSchema, connectionIds: [] },
  { id: "inspect_rows", title: "固定数组元素测试程序", inputSchema: object({ records: { type: "array", items: {} }, tag: { type: "string", maxLength: 2 } }), outputSchema, connectionIds: [] },
];

// Fixed platform test programs, not generated business solutions or real-case acceptance.
const nodeSource = `function inspect(input){
 const records=input.records;let status='ok',position=0;
 if(!Array.isArray(records))status='not_array';
 else for(let i=0;i<records.length;i++){
  const r=records[i];
  if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).sort().join(',')!=='id,note,value'){
   status='invalid_fields';position=i+1;break;
  }
  if(typeof r.id!=='string'||typeof r.note!=='string'||typeof r.value!=='number'||!Number.isSafeInteger(r.value)){
   status='invalid_value';position=i+1;break;
  }
 }
 return {status,position,count:Array.isArray(records)?records.length:0,canonical:JSON.stringify(records),tag:input.tag};
}
export const actions={inspect,inspect_rows:inspect};
export function run(request){return inspect(request.input)}
`;
const pythonSource = `import json
def run(request,ctx):
 inp=request['input'];records=inp['records'];status='ok';position=0
 if not isinstance(records,list):status='not_array'
 else:
  for index,r in enumerate(records):
   if not isinstance(r,dict) or set(r)!=set(['id','note','value']):
    status='invalid_fields';position=index+1;break
   if not isinstance(r['id'],str) or not isinstance(r['note'],str) or type(r['value']) is not int:
    status='invalid_value';position=index+1;break
 return dict(status=status,position=position,count=len(records) if isinstance(records,list) else 0,canonical=json.dumps(records,ensure_ascii=False,separators=(',',':')),tag=inp['tag'])
`;
const expected = (records, { status = "ok", position = 0, inputTag = tag } = {}) => ({ status, position,
  count: Array.isArray(records) ? records.length : 0, canonical: JSON.stringify(records), tag: inputTag });

function candidate(requirements, language) {
  return validDesign(requirements, { schemaVersion: 3, profile: "custom", rationale: "固定平台回归，只验证JSON数据通道及实际执行",
    instructions: "固定平台测试：调用inspect或inspect_rows，不修改输入字段类型，不联网，不调用其他模型。",
    interaction: { defaultEntry: "conversation", page: false, operations: true, inputs: "原始JSON值", results: "原样序列化和业务位置", persistentData: "任务记录" },
    connections: [], execution: { language, hosting: language === "python" ? "managed" : "builtin", reason: "固定测试分别运行两种语言" },
    selectionBasis: { capacity: "完整输入仍按动作、任务和网关各自字节限额检查", process: "一次真实动作保留原值并检查业务字段",
      quality: "与独立已知输入逐字比较，布尔和错误位置不得被契约提前改写", requirementIds: requirements.map((item) => item.id), assumptions: [] },
    capabilities: [{ id: "conversation", status: "available", reason: "调用固定动作" }],
    acceptance: [
      { id: "valid", kind: "success", requirementIds: requirements.map((item) => item.id), input: "合法记录", expected: "原样输出JSON并成功检查字段" },
      { id: "empty", kind: "missing_input", requirementIds: ["inputSource"], input: "空数组", expected: "保留空数组并返回零条" },
      { id: "boundary", kind: "boundary", requirementIds: ["externalAction", "deliverable"], input: "第二条记录含布尔数值", expected: "保留布尔原值，返回错误位置2" },
    ] });
}

function plan(payload, language) {
  const python = language === "python", entrypoint = python ? "action.py" : "actions.mjs", runtime = python ? "managed-service" : "node-action";
  const application = { protocolVersion: python ? 3 : 2, runtime, entrypoint, page: null, actions, stateVersion: 1, evidenceIds: [] };
  if (python) application.service = { schemaVersion: 1, language, host: "managed", entrypoint,
    operations: actions.map((action) => ({ ...action, idempotent: true })), dependencies: { packages: [] }, capabilities: [], dataVersion: 1 };
  const caseOf = (id, acceptanceId, actionId, records, result) => ({ id, taskId: "fixed", acceptanceId, actionId,
    input: JSON.stringify({ records, tag }), mocks: [], assertions: [{ path: "", expectedJson: JSON.stringify(result) }] });
  const bad = [row(), row(true)];
  return { schemaVersion: 3, summary: "固定JSON测试计划，业务实现不是模型生成", runtime, entrypoint, application,
    tasks: [{ id: "fixed", title: "固定测试程序", description: "交付后由真实通道独立测试大JSON、类型和长度",
      requirementIds: payload.requirements.map((item) => item.id), acceptanceIds: payload.design.acceptance.map((item) => item.id), dependsOn: [], files: [entrypoint] }],
    cases: [caseOf("valid", "valid", "inspect", [row()], expected([row()])), caseOf("typed_array", "valid", "inspect_rows", [row()], expected([row()])),
      caseOf("empty", "empty", "inspect", [], expected([])), caseOf("bad_bool", "boundary", "inspect", bad, expected(bad, { status: "invalid_value", position: 2 }))] };
}

async function hydrate(payload, tools) {
  if (!payload.contextTruncated) return;
  for (const section of ["requirements", "design"]) {
    const parts = []; let offset = 0;
    for (;;) {
      const reply = await tools.read_development_context.execute(`read_${section}`, { section, offset, limit: 8000 });
      const page = JSON.parse(reply.content[0].text); parts.push(page.text);
      if (page.nextOffset === null) break;
      assert.ok(page.nextOffset > offset); offset = page.nextOffset;
    }
    payload[section] = JSON.parse(parts.join(""));
  }
}

function fixedRoles(language) {
  return async (options) => {
    const tools = Object.fromEntries(options.customTools.map((tool) => [tool.name, tool]));
    const submit = ["submit_architecture", "submit_architecture_review", "submit_development_plan", "submit_development_review", "submit_development_work"].find((name) => tools[name]);
    if (!submit) return createPiSession(options);
    let listener;
    const session = { messages: [], model: { contextWindow: 1000000 }, setAutoCompactionEnabled() {}, getContextUsage: () => ({ percent: 1 }),
      subscribe(fn) { listener = fn; return () => { listener = null; }; },
      async prompt(message) {
        const payload = JSON.parse(message); let value;
        if (submit === "submit_architecture") value = candidate(payload.requirements, language);
        else if (submit === "submit_architecture_review") value = passingReview(payload.candidateHash, payload.design);
        else if (submit === "submit_development_plan") {
          await hydrate(payload, tools);
          const { cases, ...index } = plan(payload, language);
          await tools.save_plan_json.execute("save_index", { path: "index.json", value: { ...index, caseFiles: ["cases.json"] } });
          await tools.save_plan_cases.execute("save_cases", { path: "cases.json", cases });
          value = { indexPath: "index.json" };
        } else if (submit === "submit_development_review") value = developmentReview(payload.subjectHash);
        else {
          const path = language === "python" ? "action.py" : "actions.mjs";
          await tools.write.execute("save_fixed_source", { path, content: language === "python" ? pythonSource : nodeSource });
          value = { summary: "固定源码写入，结果等待真实执行", changedFiles: [path], knownIssues: [], nextAction: "", continue: false };
        }
        await tools[submit].execute("fixed_submit", value);
        session.messages.push({ role: "assistant", stopReason: "stop", content: "固定测试角色提交。" }); listener?.({ type: "turn_end" });
      }, getLastAssistantText: () => "固定测试角色提交。", async abort() {}, dispose() {} };
    return session;
  };
}

async function unseal(path) {
  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await unseal(join(path, entry.name));
}

async function fixture(t, language) {
  const probe = await new DevelopmentExecutor().probe(); if (!probe.available) { t.skip(probe.reason); return null; }
  const root = await mkdtemp(join(tmpdir(), `neuma-raw-json-${language}-`)), state = { input: null, requests: [], observed: [] };
  const model = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); state.requests.push(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const first = body.messages.at(-1).role === "user";
    const delta = first ? { role: "assistant", tool_calls: [{ index: 0, id: `raw_json_call_${state.requests.length}`, type: "function",
      function: { name: "run_application_action", arguments: JSON.stringify({ actionId: "inspect", input: state.input }) } }] }
      : { role: "assistant", content: "固定测试工具调用结束。" };
    response.end(`data: ${JSON.stringify({ id: "raw-json", object: "chat.completion.chunk", created: 1, model: "fixture-model",
      choices: [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  const dataDir = join(root, "data"), services = language === "python" ? new ManagedServiceManager({ rootDir: join(dataDir, "services"),
    runtimeStore: new ServiceRuntimeStore({ rootDir: process.env.NEUMA_TEST_SERVICE_PYTHON }) }) : undefined;
  const agents = new PrototypeAgents({ config: { llmConfigured: true, model: "fixture-model", apiKey: "local-fixture-only",
    chatUrl: `http://127.0.0.1:${model.address().port}/v1/chat/completions` }, cwd: root, dataDir, services, sessionFactory: fixedRoles(language) });
  let client;
  t.after(async () => {
    await client?.close(); await agents.close(); model.closeAllConnections(); await new Promise((resolve) => model.close(resolve));
    await unseal(root); await rm(root, { recursive: true, force: true });
  });
  const id = `raw_json_${language}`, draft = validDraft("固定平台回归：保持原始JSON字段并由程序报告错误位置，不联网");
  draft.interaction = { defaultEntry: "conversation", page: false, operations: ["检查原始JSON"], inputs: "JSON值", results: "原样数据和错误位置", persistentData: "任务记录" };
  const build = await agents.build({ id, name: "固定JSON平台测试", draft });
  assert.equal(build.architecture.status, "passed", JSON.stringify(build.architecture.issues));
  assert.equal(build.development?.status, "completed", JSON.stringify(build.development));
  const descriptor = await agents.applications.descriptor(id), deliveryVersion = descriptor.deliveryVersion;
  const grant = await agents.gateway.configure(id, { actionIds: actions.map((action) => action.id), deliveryVersion });
  assert.equal(grant.verification.status, "passed");
  client = new Client({ name: "raw-json-platform-fixture", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(grant.mcpUrl), { requestInit: { headers: { authorization: `Bearer ${grant.token}` } } }));
  const submit = agents.applications.submit.bind(agents.applications);
  agents.applications.submit = async (...args) => {
    const observed = structuredClone(args[1]); state.observed.push(observed);
    const result = await submit(...args); observed.taskId = result.taskId; return result;
  };
  return { agents, client, id, state, grant, deliveryVersion };
}

function escapedRecords() {
  const records = Array.from({ length: 75 }, (_, index) => ({ id: `r${index}`, value: index, note: '"\\'.repeat(240) }));
  records[0].note += "x".repeat(75 * 1024 - Buffer.byteLength(JSON.stringify(records)));
  assert.equal(Buffer.byteLength(JSON.stringify(records)), 75 * 1024);
  return records;
}

async function call(f, transport, actionId, input, mutationId) {
  let submitted;
  if (transport === "http") {
    const response = await fetch(`${f.grant.apiUrl}/tasks`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.grant.token}` },
      body: JSON.stringify({ actionId, input, mutationId, deliveryVersion: f.deliveryVersion }) });
    const value = await response.json(); return { accepted: response.ok, value, status: response.status };
  }
  submitted = await f.client.callTool({ name: `run_${actionId}`, arguments: { input, mutationId, deliveryVersion: f.deliveryVersion } });
  return { accepted: submitted.isError !== true, value: submitted.structuredContent, status: submitted.isError ? "error" : "ok" };
}

async function completed(f, transport, taskId) {
  await f.agents.applications.wait(f.id, taskId);
  if (transport === "http") {
    const response = await fetch(`${f.grant.apiUrl}/tasks/${taskId}?deliveryVersion=${f.deliveryVersion}`, { headers: { authorization: `Bearer ${f.grant.token}` } });
    assert.equal(response.status, 200); return response.json();
  }
  const result = await f.client.callTool({ name: "get_task", arguments: { taskId, deliveryVersion: f.deliveryVersion } });
  assert.notEqual(result.isError, true); return result.structuredContent;
}

for (const language of ["javascript", "python"]) test(`固定平台程序：${language}原始JSON经HTTP/MCP/实际Pi工具保真，业务错误位置由程序判定`, {
  timeout: 120000, skip: language === "python" && !process.env.NEUMA_TEST_SERVICE_PYTHON,
}, async (t) => {
  const f = await fixture(t, language); if (!f) return;
  const records = escapedRecords(), largeInput = { records, tag };
  for (const transport of ["http", "mcp"]) {
    for (const actionId of ["inspect", "inspect_rows"]) {
      const result = await call(f, transport, actionId, largeInput, `${transport}_${actionId}_large`);
      assert.equal(result.accepted, true, `${transport} structured input rejected`);
      const task = await completed(f, transport, result.value.taskId);
      assert.equal(task.status, "completed", JSON.stringify(task.error)); assert.deepEqual(task.result, expected(records));
      assert.deepEqual((await f.agents.applications.store.get(f.id, result.value.taskId)).input, largeInput);
    }
    for (const [label, rows, status, position = 2] of [["bool", [row(), row(true)], "invalid_value"],
      ["string", [row(), row("3")], "invalid_value"], ["fields", [row(), { ...row(), unexpected: false }], "invalid_fields"],
      ["nested", [row(), { ...row(), note: { items: [null, false, 3, "x"] } }], "invalid_value"],
      ["nul", [row(), { ...row(), note: "A\0B" }], "ok", 0]]) {
      const input = { records: rows, tag }, result = await call(f, transport, "inspect", input, `raw_${transport}_${label}`);
      assert.equal(result.accepted, true, `${transport}/${label} input rejected`);
      const task = await completed(f, transport, result.value.taskId);
      assert.equal(task.status, "completed"); assert.deepEqual(task.result, expected(rows, { status, position }));
      assert.deepEqual(f.state.observed.at(-1).input, input, "入口不把布尔/字符串改写为数字，也不丢业务未知字段");
    }
    const before = (await f.agents.applications.store.list(f.id)).length;
    const wrapped = { records: JSON.stringify(records), tag };
    assert.ok(Buffer.byteLength(JSON.stringify(wrapped)) > 128 * 1024 && Buffer.byteLength(JSON.stringify(wrapped)) < 256 * 1024);
    const tooLarge = await call(f, transport, "inspect", wrapped, `${transport}_double_encoded`);
    assert.equal(tooLarge.accepted, false, "双重编码后的实际封装仍受128KiB任务限制");
    const tooLong = await call(f, transport, "inspect", { records: [], tag: tag + "😃" }, `${transport}_three_codepoints`);
    assert.equal(tooLong.accepted, false, "三码点不能进入maxLength2契约");
    assert.equal((await f.agents.applications.store.list(f.id)).length, before);
  }
  for (const [label, rows, status] of [["bool", [row(), row(true)], "invalid_value"], ["fields", [row(), { ...row(), unexpected: true }], "invalid_fields"]]) {
    f.state.input = { records: rows, tag };
    const before = f.state.observed.length;
    const answer = await f.agents.prompt({ agentId: f.id, sessionId: `raw-json-${language}-${label}`, message: "运行固定JSON参数保真测试" });
    assert.equal(answer.status, "complete"); assert.equal(f.state.observed.length, before + 1);
    const actual = f.state.observed.at(-1); assert.deepEqual(actual.input, f.state.input, "实际Pi SDK执行的参数仍保留原布尔值与未知业务字段");
    const task = await f.agents.applications.store.get(f.id, actual.taskId);
    assert.deepEqual(task.result, expected(rows, { status, position: 2 }));
  }
  assert.ok(f.state.requests.some((request) => request.messages.some((message) => message.role === "tool")), "实际Pi工具循环完成并收到真实任务结果");
});
