import type {ValueSchema} from "../src/contracts/application.mjs";
import type {SessionEvent} from "../src/runtime/pi-port.mjs";
import {readDevelopmentRunRecord} from "../src/development/development-record.mjs";
import {fixtureJsonObject,fixtureString} from "./helpers/http-model.mjs";
import {callFixture} from "./helpers/m7-test-boundaries.mjs";
import type {Server} from "node:http";
interface InventoryRow {path:string;extension:string;bytes:number;lines:number}
interface PythonResult {status:string;jsonText:string;csvText:string;jsonPath:string;csvPath:string}
interface GatewayTaskResult {taskId:string;status:string;error?:unknown;result:PythonResult;artifacts:{path:string}[]}
interface GatewayPage {taskId:string;artifactIndex:number;encoding:string;sha256:string;size:number;offset:number;data:string;nextOffset:number|null}
function inventoryRows(value:unknown):InventoryRow[] {
  assert.ok(Array.isArray(value));
  for(const row of value) assert.ok(row && typeof row === "object" && typeof row.path === "string" && typeof row.extension === "string" && typeof row.bytes === "number" && typeof row.lines === "number");
  return value as InventoryRow[];
}
import { recordArray } from "./helpers/m7-test-boundaries.mjs";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import type { SessionMessage } from "../src/runtime/pi-port.mjs";
import { fixtureTools } from "./helpers/m7-test-boundaries.mjs";
import type { PiSessionOptions } from "../src/runtime/pi-port.mjs";
import { toolText } from "./helpers/m7-test-boundaries.mjs";
import { listeningAddress } from "./helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { PrototypeAgents } from "../src/agents/agent-prototype.mjs";
import { createRequestHandler } from "../src/server.mjs";
import { ManagedServiceManager } from "../src/services/managed-service-manager.mjs";
import { ServiceRuntimeStore } from "../src/services/service-runtime.mjs";
import { processTurn } from "../src/requirements/core.mjs";
import { createPlatformSnapshot } from "../src/architecture/platform-contract.mjs";
import { validDraft, validDesign, passingReview } from "./helpers/architecture.mjs";
import { sufficientPreflight } from "./helpers/consultation.mjs";
import { developmentReview } from "./helpers/development.mjs";
import type { PathLike } from "fs";
import type { RequirementItem } from "../src/contracts/architecture.mjs";

const supported = process.platform === "darwin" && process.arch === "arm64";
const object = (properties:Record<string,ValueSchema>):ValueSchema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const text:ValueSchema = { type: "string", maxLength: 120000 };
const inputSchema = object({ recordsJSON: { type: "string", maxLength: 100000 }, outputKey: { type: "string", minLength: 1, maxLength: 32 } });
const outputSchema = object(Object.fromEntries(["status", "jsonText", "csvText", "jsonPath", "csvPath"].map((key) => [key, text])));
const action = { id: "analyze", title: "固定测试程序统计源码清单", inputSchema, outputSchema, connectionIds: [] };
const csvHeader = "extension,fileCount,totalBytes,totalLines\n";
const sample = [{ path: "one.py", extension: ".py", bytes: 5, lines: 2 }];

// This is an explicitly fixed test program. No real model creates or reviews it.
// Controllers, delivery validation, OS isolation, file capabilities and gateways are real.
const source = `import csv,io,json,re
def failed(status):
 return dict(status=status,jsonText='',csvText='',jsonPath='',csvPath='')
def read_all(ctx,path):
 parts=[];offset=None
 for page in range(6):
  args=dict(file=path)
  if offset is not None:args['offset']=offset
  result=ctx.files.read(args)
  if result.get('error'): raise RuntimeError('file_error')
  parts.append(result['text'])
  if not result.get('truncated'): return ''.join(parts)
  next_offset=result.get('nextOffset')
  if type(next_offset) is not int or next_offset<=(offset or 0): raise RuntimeError('file_error')
  offset=next_offset
 raise RuntimeError('file_error')
def run(request,ctx):
 inp=request['input']
 try:
  records=json.loads(inp['recordsJSON'])
  if len(inp['recordsJSON'].encode('utf-8'))>98304 or not isinstance(records,list) or len(records)>300: return failed('invalid_input')
  if not re.fullmatch('[a-zA-Z0-9_-]{1,32}',inp['outputKey']): return failed('invalid_input')
  groups={};seen=set();total_bytes=0;total_lines=0
  for row in records:
   if not isinstance(row,dict) or set(row)!=set(['path','extension','bytes','lines']): return failed('invalid_input')
   if not isinstance(row['path'],str) or not 1<=len(row['path'])<=128 or row['path'] in seen: return failed('invalid_input')
   if not isinstance(row['extension'],str) or not 1<=len(row['extension'])<=16: return failed('invalid_input')
   if any(type(row[key]) is not int or not 0<=row[key]<=10000000 for key in ['bytes','lines']): return failed('invalid_input')
   seen.add(row['path']);total_bytes+=row['bytes'];total_lines+=row['lines']
   g=groups.setdefault(row['extension'],dict(extension=row['extension'],fileCount=0,totalBytes=0,totalLines=0))
   g['fileCount']+=1;g['totalBytes']+=row['bytes'];g['totalLines']+=row['lines']
  result=dict(fileCount=len(records),totalBytes=total_bytes,totalLines=total_lines,byExtension=[groups[k] for k in sorted(groups)])
  json_text=json.dumps(result,ensure_ascii=False,separators=(',',':'))
  out=io.StringIO();writer=csv.writer(out,lineterminator='\\n');writer.writerow(['extension','fileCount','totalBytes','totalLines'])
  for row in result['byExtension']:writer.writerow([row[k] for k in ['extension','fileCount','totalBytes','totalLines']])
  csv_text=out.getvalue();paths=['reports/'+inp['outputKey']+'.json','reports/'+inp['outputKey']+'.csv']
  for path,content in zip(paths,[json_text,csv_text]):
   saved=ctx.files.write(dict(file=path,content=content))
   if saved.get('error'): return failed('file_error')
  readback=[read_all(ctx,path) for path in paths]
  return dict(status='ok',jsonText=readback[0],csvText=readback[1],jsonPath=paths[0],csvPath=paths[1])
 except (ValueError,TypeError,KeyError): return failed('invalid_input')
 except Exception: return failed('file_error')
`;

// The oracle uses a separate implementation and never runs in the Python worker.
function expected(records: readonly InventoryRow[]) {
  const extensions = [...new Set(records.map((row) => row.extension))].sort();
  const sum = (rows:readonly InventoryRow[], key:"bytes"|"lines") => rows.reduce((total,row) => total + row[key],0);
  return { fileCount: records.length, totalBytes: sum(records, "bytes"), totalLines: sum(records, "lines"),
    byExtension: extensions.map((extension) => {
      const rows = records.filter((row) => row.extension === extension);
      return { extension, fileCount: rows.length, totalBytes: sum(rows, "bytes"), totalLines: sum(rows, "lines") };
    }) };
}
const csvOf = (result: { fileCount?: unknown; totalBytes?: unknown; totalLines?: unknown; byExtension: unknown; }) => csvHeader + recordArray(result.byExtension).map((row) => [row.extension, row.fileCount, row.totalBytes, row.totalLines].join(",") + "\n").join("");
const emptyResult = (status: string) => ({ status, jsonText: "", csvText: "", jsonPath: "", csvPath: "" });
function successful(records:InventoryRow[], outputKey: string) {
  const result = expected(records);
  return { status: "ok", jsonText: JSON.stringify(result), csvText: csvOf(result), jsonPath: `reports/${outputKey}.json`, csvPath: `reports/${outputKey}.csv` };
}

async function inventory() {
  if (process.env.NEUMA_TEST_SOURCE_INVENTORY) return inventoryRows(JSON.parse(String(await readFile(process.env.NEUMA_TEST_SOURCE_INVENTORY, "utf8"))));
  const root = dirname(dirname(fileURLToPath(import.meta.url))), paths: ((string))[] = [];
  async function visit(directory: string) {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && [".mjs", ".js", ".py", ".css", ".html"].includes(extname(entry.name))) paths.push(path);
    }
  }
  for (const directory of ["src", "public", "test"]) await visit(directory);
  return Promise.all(paths.sort().slice(0, 286).map(async (path) => {
    const bytes = await readFile(join(root, path)), content = bytes.toString("utf8");
    return { path, extension: extname(path), bytes: bytes.length, lines: content ? content.split("\n").length - (content.endsWith("\n") ? 1 : 0) : 0 };
  }));
}

function candidate(requirements:readonly RequirementItem[]) {
  return validDesign(requirements, { schemaVersion: 3, profile: "custom", rationale: "固定 Python 平台测试；不评价真实模型的业务生成质量",
    instructions: "只调用已验收的固定测试动作，不联网、不调用模型。",
    interaction: { defaultEntry: "conversation", page: false, operations: true, inputs: "JSON 源码元数据", results: "完整 JSON 与 CSV", persistentData: "独立文件产物" },
    connections: [], execution: { language: "python", hosting: "managed", reason: "独立验证受管 Python 与两种接口" },
    selectionBasis: { capacity: "最多300条、96KiB", process: "确定性统计后写文件并经宿主能力读回", quality: "完整正文与独立结果比较", requirementIds: requirements.map((item) => item.id), assumptions: [] },
    capabilities: [{ id: "conversation", status: "available", reason: "展示结果" }, { id: "fixed_python", status: "needs_development", reason: "交付固定测试程序" }],
    acceptance: [
      { id: "valid", kind: "success", requirementIds: requirements.map((item) => item.id), input: "一条源码元数据", expected: "实际统计并读回已写文件" },
      { id: "empty", kind: "missing_input", requirementIds: ["inputSource"], input: "空数组", expected: "总计为零且 CSV 含表头" },
      { id: "boundary", kind: "boundary", requirementIds: ["successCriteria", "externalAction"], input: "非法负数", expected: "整体拒绝，不写文件" },
      { id: "tool_failure", kind: "tool_failure", requirementIds: ["deliverable"], input: "宿主写文件失败", expected: "明确 file_error，不声称完整交付" },
    ] });
}

function plan(payload:{requirements:RequirementItem[];design:{acceptance:{id:string}[]}}) {
  const examples = [
    { id: "valid", rows: sample, result: successful(sample, "valid") },
    { id: "empty", rows: [], result: successful([], "empty") },
    { id: "boundary", rows: [{ ...sample[0]!, bytes: -1 }], result: emptyResult("invalid_input") },
    { id: "tool_failure", rows: sample, result: emptyResult("file_error") },
  ];
  return { schemaVersion: 3, summary: "固定测试计划，仅模拟模型交接", runtime: "managed-service", entrypoint: "action.py",
    application: { protocolVersion: 3, runtime: "managed-service", entrypoint: "action.py", page: null, actions: [action], stateVersion: 1, evidenceIds: [],
      service: { schemaVersion: 1, language: "python", host: "managed", entrypoint: "action.py", operations: [{ ...action, idempotent: true }], dependencies: { packages: [] }, dataVersion: 1, capabilities: ["files.write", "files.read"] } },
    tasks: [{ id: "fixed", title: "交付固定 Python 测试程序", description: "程序来源明确为测试夹具，真实执行由平台负责", requirementIds: payload.requirements.map((item) => item.id),
      acceptanceIds: payload.design.acceptance.map((item) => item.id), dependsOn: [], files: ["action.py"] }],
    cases: examples.map(({ id, rows, result }) => {
      const mocks: ({ "capability": (string); "argsJson": (string); "resultJson": (string); })[] = [];
      if (["valid", "empty"].includes(id)) {
        for (const [file, content] of [[result.jsonPath, result.jsonText], [result.csvPath, result.csvText]]) {
          mocks.push({ capability: "files.write", argsJson: JSON.stringify({ file, content }), resultJson: '{"saved":true}' });
        }
        for (const [file, content] of [[result.jsonPath, result.jsonText], [result.csvPath, result.csvText]]) {
          mocks.push({ capability: "files.read", argsJson: JSON.stringify({ file }), resultJson: JSON.stringify({ text: content, truncated: false }) });
        }
      } else if (id === "tool_failure") {
        const wanted = successful(rows, id);
        mocks.push({ capability: "files.write", argsJson: JSON.stringify({ file: wanted.jsonPath, content: wanted.jsonText }), resultJson: '{"error":"unavailable"}' });
      }
      return { id: `case_${id}`, taskId: "fixed", acceptanceId: id, actionId: "analyze", input: JSON.stringify({ recordsJSON: JSON.stringify(rows), outputKey: id }), mocks,
        assertions: [{ path: "", expectedJson: JSON.stringify(result) }] };
    }) };
}

function fixedModel(errors:unknown[]) {
  return async (options: PiSessionOptions) => {
    const tools = fixtureTools(options.customTools!);
    const submit = ["submit_architecture", "submit_architecture_review", "submit_requirement_fidelity", "submit_development_plan", "submit_development_review", "submit_development_work"].find((name) => tools[name]);
    assert.ok(submit, "业务执行不应调用模拟或真实模型");
    let listener:((event:SessionEvent)=>void)|null;
    const session = { messages: [] as SessionMessage[], subscribe(fn:(event:SessionEvent)=>void) { listener = fn; return () => { listener = null; }; }, setAutoCompactionEnabled() {}, getContextUsage: () => ({ percent: 10 }),
      async prompt(message: string) {
        try {
          const payload = JSON.parse(String(message));
          if (submit === "submit_development_plan" && payload.contextTruncated) {
            for (const section of ["requirements", "design"]) {
              const parts: ((unknown))[] = [];
              let offset = 0;
              for (;;) {
                const result = await tools.read_development_context!.execute("fixed_context", { section, offset, limit: 8000 });
                const page = JSON.parse(String(toolText(result)));
                parts.push(page.text);
                if (page.nextOffset === null) break;
                if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) throw new Error("固定角色上下文分页没有前进");
                offset = page.nextOffset;
              }
              payload[section] = JSON.parse(String(parts.join("")));
            }
          }
          let value;
          if (submit === "submit_architecture") value = candidate(payload.requirements);
          else if (submit === "submit_architecture_review") {
            value = passingReview(payload.candidateHash, payload.design);
          } else if (submit === "submit_requirement_fidelity") {
            value = { contextHash: payload.contextHash, verdict: "preserved", restrictions: [],
              checks: payload.requirements.map((item:{id:string}) => ({ requirementId: item.id, admissionPreserved: true, deliveryPreserved: true, newUnconfirmedRestriction: false })) };
          } else if (submit === "submit_development_plan") {
            const { cases, ...index } = plan(payload);
            await tools.write!.execute("fixed_plan_index", { path: "index.json", content: JSON.stringify({ ...index, caseFiles: ["cases.json"] }, null, 2) });
            await tools.write!.execute("fixed_plan_cases", { path: "cases.json", content: JSON.stringify(cases, null, 2) });
            value = { indexPath: "index.json" };
          }
          else if (submit === "submit_development_review") value = developmentReview(payload.subjectHash);
          else {
            await tools.write!.execute("fixed_write", { path: "action.py", content: source });
            value = { summary: "固定测试源码已写入，等待真实验收", changedFiles: ["action.py"], knownIssues: [], nextAction: "", continue: false };
          }
          await tools[submit]!.execute("fixed_submit", value);
          session.messages.push({ role: "assistant", stopReason: "stop", content: "固定测试角色交接完成，真实控制器决定验收状态。" });
          listener?.({ type: "turn_end" });
        } catch (error) { errors.push(objectFields(error).message); throw error; }
      }, getLastAssistantText: () => "固定测试角色", async abort() {}, dispose() {} };
    return session;
  };
}

async function unseal(path:string) {
  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await unseal(join(path, entry.name));
}

test("固定程序平台验收：真实 Python 隔离、交付、文件桥、HTTP 与官方 MCP 返回完整 JSON/CSV", {
  skip: !supported || !process.env.NEUMA_TEST_SERVICE_PYTHON, timeout: 120000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-python-gateway-")), dataDir = join(root, "data");
  const runtimeStore = new ServiceRuntimeStore({ rootDir: process.env.NEUMA_TEST_SERVICE_PYTHON! });
  const services = new ManagedServiceManager({ rootDir: join(dataDir, "services"), runtimeStore });
  const config = { llmConfigured: true }, agentId = "fixed_python_gateway", fixtureErrors:unknown[] = [], gatewayFailures: ({ "name": (unknown); "code": (unknown); "reason": (unknown); "message": (string | undefined); "stack": (string | undefined); })[] = [];
  const agents = new PrototypeAgents({ config, cwd: root, dataDir, services, sessionFactory: fixedModel(fixtureErrors), enforceRequirementConfirmation: true });
  let gatewayToken:string|undefined;
  const handleGateway = agents.gateway.handle.bind(agents.gateway);
  agents.gateway.handle = async (...args) => {
    try { return await handleGateway(...args); }
    catch (error) {
      const clean = (value:unknown) => typeof value === "string" ? (gatewayToken ? value.replaceAll(gatewayToken, "[redacted]") : value).slice(0, 4000) : undefined;
      gatewayFailures.push({ name: objectFields(error).name, code: objectFields(error).code, reason: objectFields(error).reason, message: clean(objectFields(error).message), stack: clean(objectFields(error).stack) });
      throw error;
    }
  };
  let server:Server|undefined, handler:ReturnType<typeof createRequestHandler>|undefined, client:Client|undefined;
  t.after(async () => {
    await client?.close();
    await handler?.dispose(); if (!handler) await agents.close();
    server?.closeAllConnections(); if (server?.listening) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    await unseal(root); await rm(root, { recursive: true, force: true });
  });
  await agents.ready;
  const prepared = await services.prepareEnvironment({ language: "python", host: "managed" });
  assert.equal(prepared.available, true);
  assert.ok("isolation" in prepared);
  assert.equal(prepared.isolation.available, true);
  assert.equal(objectFields(prepared.isolation.checks).network, true);
  assert.equal(objectFields(prepared.isolation.checks).outsideRead, true);
  handler = callFixture(createRequestHandler,undefined,[{ config, dataDir, prototypeAgents: agents, projects: {}, projectAgent: {} }]); await handler.ready;
  server = createServer(handler); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${listeningAddress(server).port}`;
  async function json<T extends object=Record<string,unknown>>(url:string, body?:unknown, token?:string):Promise<T> {
    const response = await fetch(url, { ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    const result = fixtureJsonObject(await response.text()); assert.equal(response.ok, true,
      `接口失败：${response.status} ${result.reason ?? ""} ${result.error ?? ""}; gateway=${JSON.stringify(gatewayFailures.at(-1) ?? null)}`); return result as T;
  }
  const draft = { ...validDraft("固定平台测试：不联网，程序统计 JSON 元数据并返回完整 JSON 与 CSV"), taskSpec: { version: 1, items: [] } };
  draft.name.value = "固定 Python 平台测试";
  const provider = { generateDraft: async () => ({ draft, proposedGap: "none", question: "" }), preflight: sufficientPreflight, getPlatform: () => createPlatformSnapshot({ allowNetwork: false }) };
  const ready = await processTurn({ message: draft.goal.value, draft }, provider, { enforceConsultation: true, requestId: "fixed_start" });
  const confirmed = await processTurn({ message: "确认", draft: ready.draft, consultation: ready.consultation, lastQuestion: ready.confirmationQuestion }, provider, { enforceConsultation: true, requestId: "fixed_confirm" });
  assert.equal(confirmed.confirmed, true);
  await agents.saveRequirements(agentId, { name: draft.name.value, draft: confirmed.draft }, { confirmation: confirmed.confirmation, consultation: confirmed.consultation });
  const build = await json<{development:{id:string;status:string;delivery:string}}>(`${baseUrl}/api/agents/build`, { id: agentId, name: draft.name.value, draft: confirmed.draft });
  assert.deepEqual(fixtureErrors, []);
  assert.equal(build.development?.status, "completed", JSON.stringify(build.development));
  assert.equal(build.development.delivery, "ready");
  const record = readDevelopmentRunRecord(await agents.development.store.getRun(build.development.id));
  assert.equal(record!.planningArtifact!.indexPath, "index.json");
  assert.deepEqual((await agents.development.artifacts.validateSnapshot(record!.planningArtifact!, agentId)).plan, record!.plan!);
  assert.equal(record!.package!.application!.service!.language, "python");
  assert.equal(await readFile(join(record!.package!.snapshot.path, "action.py"), "utf8"), source);
  assert.ok(record!.reports.length > 0 && record!.reports.every((report) => report.status === "passed"));
  const { deliveryVersion } = await json<{deliveryVersion:string}>(`${baseUrl}/api/agents/${agentId}/services`);
  const grant = await json<{token:string;apiUrl:string;mcpUrl:string;verification:{status:string}}>(`${baseUrl}/api/agents/${agentId}/gateway`, { actionIds: ["analyze"], deliveryVersion });
  gatewayToken = grant.token;
  assert.ok(grant.token);
  assert.equal(grant.verification.status, "passed");
  assert.equal((await json(`${baseUrl}/api/agents/${agentId}/gateway`)).token, undefined);
  client = new Client({ name: "fixed-python-platform-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(grant.mcpUrl), { requestInit: { headers: { authorization: `Bearer ${grant.token}` } } }));
  assert.ok((await client.listTools()).tools.some((tool) => tool.name === "run_analyze"));
  const actual = await inventory(); assert.equal(actual.length, 286);
  assert.ok(Buffer.byteLength(JSON.stringify(actual)) <= 98304);
  const maximum = Array.from({ length: 300 }, (_, index) => ({ path: `p${String(index).padStart(3, "0")}`.padEnd(128, "x"), extension: `.${String(index).padStart(15, "0")}`, bytes: 10000000, lines: 10000000 }));
  assert.ok(Buffer.byteLength(JSON.stringify(maximum)) <= 98304);
  const cases = [
    ["source286", actual], ["small", [{ path: "b.js", extension: ".js", bytes: 17, lines: 3 }, ...sample]],
    ["empty", []], ["reverse", [...actual].reverse()], ["maximum300", maximum],
    ["bad", [{ ...sample[0]!, bytes: true }]], ["duplicate", [sample[0], sample[0]]], ["over301", [...maximum, { ...sample[0]! }]], ["after_error", sample],
  ] as const;
  async function call(transport: string, id: string, records: unknown) {
    const outputKey = `${transport}_${id}`, body = { input: { recordsJSON: JSON.stringify(records), outputKey }, mutationId: `fixed_${transport}_${id}`, deliveryVersion };
    const mcp = async <T extends object>(name: string, args: { input?: { recordsJSON: string; outputKey: string; }; mutationId?: string; deliveryVersion: unknown; taskId?: unknown; artifactIndex?: unknown; offset?: number; limit?: number; }) => {
      const response = await client!.callTool({ name, arguments: args });
      assert.notEqual(response.isError, true, `${id}: ${JSON.stringify(response.content)}`);
      assert.ok(response.structuredContent, `${id}: MCP response missing structured result`);
      return response.structuredContent as T;
    };
    const submitted = transport === "rest" ? await json<{taskId:string}>(`${grant.apiUrl}/tasks`, { actionId: "analyze", ...body }, grant.token)
      : await mcp<{taskId:string}>("run_analyze", body);
    assert.ok(submitted.taskId);
    let task!:GatewayTaskResult;
    for (let attempt = 0; attempt < 500; attempt++) {
      task = transport === "rest" ? await json<GatewayTaskResult>(`${grant.apiUrl}/tasks/${submitted.taskId}?deliveryVersion=${deliveryVersion}`, undefined, grant.token)
        : await mcp<GatewayTaskResult>("get_task", { taskId: submitted.taskId, deliveryVersion });
      if (!["queued", "running"].includes(task.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(task.status, "completed", `${transport}/${id}: ${task.error ?? task.status}`);
    if (["bad", "duplicate", "over301"].includes(id)) {
      assert.deepEqual(task.result, emptyResult("invalid_input")); assert.equal(task.artifacts.length, 0); return;
    }
    const rows=inventoryRows(records);
    assert.equal(objectFields(task.result).status, "ok", `${transport}/${id} status`);
    assert.deepEqual(JSON.parse(String(objectFields(task.result).jsonText)), expected(rows), `${transport}/${id} JSON`);
    assert.equal(objectFields(task.result).csvText, csvOf(expected(rows)), `${transport}/${id} CSV`);
    assert.deepEqual(task.artifacts.map((item) => item.path).sort(), [task.result.jsonPath, task.result.csvPath].sort());
    async function artifact(path: unknown) {
      const index = task.artifacts.findIndex((item) => item.path === path), pages = [];
      assert.ok(index >= 0); let offset = 0, sha256, size;
      for (;;) {
        const page = transport === "rest" ? await json<GatewayPage>(`${grant.apiUrl}/tasks/${task.taskId}/artifacts/${index}?deliveryVersion=${deliveryVersion}&offset=${offset}&limit=8192`, undefined, grant.token)
          : await mcp<GatewayPage>("read_artifact", { taskId: task.taskId, artifactIndex: index, deliveryVersion, offset, limit: 8192 });
        assert.equal(page.taskId, task.taskId); assert.equal(page.artifactIndex, index); assert.equal(page.encoding, "base64");
        sha256 ??= page.sha256; size ??= page.size;
        assert.equal(page.sha256, sha256); assert.equal(page.size, size); assert.equal(page.offset, offset);
        pages.push(Buffer.from(page.data, "base64"));
        if (page.nextOffset === null) break;
        assert.ok(page.nextOffset > offset); offset = page.nextOffset;
      }
      const bytes = Buffer.concat(pages);
      assert.equal(bytes.length, size); assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256);
      return bytes.toString("utf8");
    }
    assert.deepEqual(JSON.parse(String(await artifact(task.result.jsonPath))), expected(rows), `${transport}/${id} downloaded JSON`);
    assert.equal(await artifact(task.result.csvPath), csvOf(expected(rows)), `${transport}/${id} downloaded CSV`);
    // Disk evidence only corroborates the gateway's independently downloaded immutable snapshots.
    const workspace = await agents.workspace(agentId);
    assert.equal(await readFile(join(workspace, task.result.jsonPath), "utf8"), objectFields(task.result).jsonText);
    assert.equal(await readFile(join(workspace, task.result.csvPath), "utf8"), objectFields(task.result).csvText);
  }
  for (const transport of ["rest", "mcp"]) for (const [id, records] of cases) await call(transport, id, records);
  t.diagnostic(JSON.stringify({ program: "fixed-test-program", model: "simulated", python: prepared.version,
    sourceInventory: expected(actual), transports: ["http", "official-mcp"], casesPerTransport: cases.length,
    completeResultTransport: "grant-bound HTTP/MCP task artifact snapshots with byte pages and SHA-256", nativeArtifactDownloadRoute: true }));
  await json(`${baseUrl}/api/agents/${agentId}/gateway/revoke`, {});
  await assert.rejects(fetch(`${grant.apiUrl}/actions`, { headers: { authorization: `Bearer ${grant.token}` } }));
});
