import {fixtureText,fixturePort} from "./helpers/http-model.mjs";
import type {ValueSchema} from "../src/contracts/application.mjs";
import type {DevelopmentPlan,DevelopmentService,DevelopmentApplication} from "../src/contracts/development.mjs";
import type {ServiceOperation} from "../src/contracts/service.mjs";
import type {ArchitectureDesign} from "../src/contracts/architecture.mjs";
import {readDevelopmentRunRecord} from "../src/development/development-record.mjs";
import { fixtureChatRequest } from "./helpers/http-model.mjs";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import { failureFields } from "./helpers/failure-fields.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PrototypeAgents } from "../src/agents/agent-prototype.mjs";
import { createRequestHandler } from "../src/server.mjs";
import { processTurn } from "../src/requirements/core.mjs";
import { createPlatformSnapshot } from "../src/architecture/platform-contract.mjs";
import { validDraft, validDesign, passingReview } from "./helpers/architecture.mjs";
import { sufficientPreflight } from "./helpers/consultation.mjs";
import { fidelityResult } from "./helpers/fidelity.mjs";
import { architectureStageSubmission } from "./helpers/architecture-stages.mjs";
import type { RequirementDraft } from "../public/ui-types.js";
import type { Server,IncomingMessage,ServerResponse } from "http";
import type { RequestListener } from "http";
import type { RequirementItem } from "../src/contracts/architecture.mjs";
import type { PathLike } from "fs";



const supported = process.platform === "darwin" && process.arch === "arm64";
const object=(properties:Record<string,ValueSchema>):ValueSchema=>({type:"object",properties,required:Object.keys(properties),additionalProperties:false});
const inputSchema = object({ text: { type: "string" } });
const outputSchema = object({ status: { type: "string" }, text: { type: "string" }, edition: { type: "integer" } });
const textOf=fixtureText;
const listen = (server: Server) => new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
async function close(server: Server) { if (!server) return; server.closeAllConnections(); if (server.listening) await new Promise((resolve) => server.close(resolve)); }
async function unseal(path:string) { await chmod(path, 0o700); for (const item of await readdir(path, { withFileTypes: true })) if (item.isDirectory()) await unseal(join(path, item.name)); }
const source = (edition: number, dataVersion = 1) => `export const actions={normalize:async(input,ctx)=>{
 if(!input.text.trim())return {status:'missing_input',text:'',edition:${edition}};
 if(input.text==='SEND')return {status:'not_sent',text:'',edition:${edition}};
 if(input.text==='READ'){const result=await ctx.files.read({file:'input.txt'});return {status:result.error?'missing_file':'ok',text:result.text||'',edition:${edition}}}
 return {status:'ok',text:input.text.toUpperCase(),edition:${edition}};
}};` + (dataVersion === 2 ? `
export async function run({actionId,input},ctx){
 for(const directory of ['business','draft']){
  for(const file of (await ctx.files.list({directory})).files){
   const path=directory+'/'+file.name;
   const record=JSON.parse((await ctx.files.read({file:path})).text);
   if(actionId==='migrate'){record.stateVersion=input.toVersion;record.version++;await ctx.files.write({file:path,content:JSON.stringify(record)})}
   else if(record.stateVersion!==input.toVersion)return {valid:false};
  }
 }
 return actionId==='migrate'?{migrated:true}:{valid:true};
}` : '');
function candidate(requirements:RequirementItem[]) {
  return validDesign(requirements, { schemaVersion: 3, profile: "custom", rationale: "用真实隔离的专属操作验证固定文本处理与交付恢复",
    interaction: { defaultEntry: "conversation", page: false, operations: true, inputs: "文字", results: "规范化结果", persistentData: "任务记录" },
    connections: [], execution: { language: "javascript", hosting: "managed", reason: "固定专属操作使用受管隔离进程" },
    selectionBasis: { capacity: "测试使用固定小型文字输入", process: "执行已验收操作，输入缺失和边界情况明确返回",
      quality: "实际输出与冻结断言一致", requirementIds: requirements.map((item) => item.id), assumptions: [] },
    capabilities: [{ id: "conversation", status: "available", reason: "展示结果" }, { id: "normalize_service", status: "needs_development", reason: "需要编写并验收专属操作" }],
    acceptance: [
      { id: "valid", kind: "success", requirementIds: requirements.map((item) => item.id), input: "abc", expected: "实际动作返回ok、ABC和当前代码版本" },
      { id: "empty", kind: "missing_input", requirementIds: ["inputSource"], input: "空文字", expected: "实际动作返回missing_input和空文字，不编造规范化内容" },
      { id: "boundary", kind: "boundary", requirementIds: ["externalAction"], input: "SEND", expected: "实际动作返回not_sent和空文字，不执行发送" },
      { id: "tool_failure", kind: "tool_failure", requirementIds: ["deliverable"], input: "READ且文件读取失败", expected: "实际动作返回missing_file和空文字，不声称读取成功" },
    ],
  });
}
function plan(requirements:RequirementItem[],design:ArchitectureDesign, edition: number, invalid: boolean, dataVersion = 1) {
  const operation:ServiceOperation & {title:string} = { id: "normalize", title: "规范化文字", inputSchema, outputSchema, connectionIds: [], idempotent: true };
  const examples = [{ id: "valid", input: "abc", expected: { status: "ok", text: "ABC", edition } },
    { id: "empty", input: "", expected: { status: "missing_input", text: "", edition } },
    { id: "boundary", input: "SEND", expected: { status: "not_sent", text: "", edition } },
    { id: "tool_failure", input: "READ", expected: { status: "missing_file", text: "", edition } }];
  const result:DevelopmentPlan&{runtime:"managed-service";schemaVersion:3;application:DevelopmentApplication&{service:DevelopmentService}} = { schemaVersion: 3, summary: "实现固定文本规范化操作", runtime: "managed-service", entrypoint: invalid ? "outside.mjs" : "actions.mjs",
    application: { protocolVersion: 3, runtime: "managed-service", entrypoint: "actions.mjs", page: null, actions: [{ id: operation.id, title: operation.title, inputSchema, outputSchema, connectionIds: [] }], stateVersion: dataVersion, evidenceIds: [],
      service: { schemaVersion: 1, language: "javascript", host: "managed", entrypoint: "actions.mjs", operations: [operation],
        dependencies: { packages: [] }, dataVersion, capabilities: ["files.list", "files.read", "files.write"] } },
    tasks: [{ id: "implement", title: "实现规范化操作", description: "固定代码和实际输入输出检查", requirementIds: requirements.map((item) => item.id),
      acceptanceIds: design.acceptance.map((item) => item.id), dependsOn: [], files: ["actions.mjs"] }],
    cases: examples.map(({ id, input, expected }) => ({ id: `case_${id}`, taskId: "implement", acceptanceId: id, actionId: "normalize",
      input: JSON.stringify({ text: input }), mocks: id === "tool_failure" ? [{ capability: "files.read", argsJson: '{"file":"input.txt"}', resultJson: '{"error":"not_found"}' }] : [],
      assertions: [{ path: "", expectedJson: JSON.stringify(expected) }] })) };
  if(dataVersion===2){
    result.application.service.migration={fromVersion:1,actionId:'migrate',verifyActionId:'verify'};
    for(const actionId of ['migrate','verify']){
      const expected=actionId==='migrate'?{migrated:true}:{valid:true};
      result.application.service.operations.push({id:actionId,visibility:'internal',inputSchema:object({fromVersion:{type:'integer'},toVersion:{type:'integer'}}),outputSchema:object(Object.fromEntries(Object.keys(expected).map(key=>[key,{type:'boolean'}]))),connectionIds:[]});
      result.cases.push({id:'test_'+actionId,taskId:'implement',acceptanceId:'valid',actionId,input:JSON.stringify({fromVersion:1,toVersion:2}),mocks:['business','draft'].map(directory=>({capability:'files.list',argsJson:JSON.stringify({directory}),resultJson:JSON.stringify({files:[]})})),assertions:[{path:'',expectedJson:JSON.stringify(expected)}]});
    }
  }
  return result;
}

test("真实Pi与OS隔离完成schema3服务研发、HTTP任务、失败保留与版本回退", { skip: !supported, timeout: 60000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-managed-development-")), requests: { name: string|undefined; edition: number; }[] = [], errors:string[] = [];
  const stageCandidates = new Map();
  let edition = 1, invalid = false, dataVersion = 1, agents: PrototypeAgents, handler:ReturnType<typeof createRequestHandler>|undefined, server: Server;
  const model = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = fixtureChatRequest(Buffer.concat(chunks).toString("utf8")), payload = JSON.parse(textOf(body.messages.find((item) => item.role === "user")!.content));
      const names = (body.tools || []).map((item) => item.function.name), calls = body.messages.flatMap((item) => item.tool_calls || []);
      let name, args;
      if (names.includes("submit_development_plan") && payload.contextTruncated) {
        const pages = body.messages.filter((item) => item.role === "tool").flatMap((item) => {
          try { const page = JSON.parse(textOf(item.content)); return typeof page.section === "string" && typeof page.text === "string" ? [page] : []; }
          catch { return []; }
        });
        for (const section of ["requirements", "design"]) {
          if (payload.contextSections?.find((item:{section:string;delivery?:string}) => item.section === section)?.delivery === "full") continue;
          const selected = [...new Map(pages.filter((page) => page.section === section).map((page) => [page.offset, page])).values()].sort((a, b) => Number(objectFields(a).offset)-Number(objectFields(b).offset));
          const last = selected.at(-1);
          if (!last || last.nextOffset !== null) { name = "read_development_context"; args = { section, offset: objectFields(last)?.nextOffset ?? 0, limit: 8000 }; break; }
          payload[section] = JSON.parse(selected.map((page) => objectFields(page).text).join(""));
        }
      }
      if (name) { /* The fixed model reads the same paged contract as a real planner. */ }
      else if (names.some((name) => ["submit_architecture_blueprint", "submit_architecture_module", "submit_architecture_integration"].includes(name))) {
        if (names.includes("submit_architecture_blueprint")) stageCandidates.set(edition, candidate(payload.requirements));
        const fixed = stageCandidates.get(edition);
        assert.ok(fixed, "模块与整合须使用本版蓝图阶段的同一固定候选");
        const submission = architectureStageSubmission({ tools: body.tools!.map((item) => item.function), payload, candidate: fixed });
        assert.ok(submission); name = submission.name; args = submission.args;
      }
      else if (names.includes("submit_architecture")) { name = "submit_architecture"; args = candidate(payload.requirements); }
      else if (names.includes("submit_architecture_review")) {
        name = "submit_architecture_review"; args = passingReview(payload.candidateHash, payload.design);
      } else if (names.includes("submit_requirement_fidelity")) {
        assert.deepEqual(names, ["submit_requirement_fidelity", "read_model_context"], "范围复核只有提交及当前冻结材料读取");
        name = "submit_requirement_fidelity"; args = fidelityResult(payload, "preserved");
      } else if (names.includes("submit_development_plan")) {
        if (!invalid || !calls.some((call) => call.function.name === "submit_development_plan")) {
          const { cases, ...index } = plan(payload.requirements, payload.design, edition, invalid, dataVersion);
          const files:Record<string,unknown> = { "index.json": { ...index, caseFiles: ["cases.json"] }, "cases.json": cases };
          const written = new Set(calls.filter((call) => call.function.name === "write").map((call) => JSON.parse(call.function.arguments).path));
          const path = Object.keys(files).find((path) => !written.has(path));
          if (path) { name = "write"; args = { path, content: JSON.stringify(files[path], null, 2) }; }
          else { name = "submit_development_plan"; args = { indexPath: "index.json" }; }
        }
      } else if (names.includes("submit_development_review")) {
        name = "submit_development_review"; args = { subjectHash: payload.subjectHash, verdict: "pass", issues: [], summary: "模型替身仅检查协议，真实执行结果由控制器独立核实" };
      } else if (names.includes("submit_development_work")) {
        if (!calls.some((call) => call.function.name === "write")) { name = "write"; args = { path: "actions.mjs", content: source(edition, dataVersion) }; }
        else { name = "submit_development_work"; args = { summary: "固定源码已写入，请执行真实验收", changedFiles: ["actions.mjs"], knownIssues: [], nextAction: "", continue: false }; }
      } else throw new Error("unexpected_role");
      requests.push({ name, edition }); response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: { role?: string; tool_calls?: { index: number; id: string; type: string; function: { name: string; arguments: string; }; }[]; content?: string; }, finish_reason:string|null = null) => response.write(`data: ${JSON.stringify({ id: `fixture_${requests.length}`, object: "chat.completion.chunk", created: 1,
        model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (name) { chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }); chunk({}, "tool_calls"); }
      else { chunk({ role: "assistant", content: "错误计划未能提交，保留失败状态。" }); chunk({}, "stop"); }
      response.end("data: [DONE]\n\n");
    } catch (error) { errors.push(failureFields(error).message!); response.writeHead(500); response.end("fixture_failed"); }
  });
  t.after(async () => { await handler?.dispose(); if (!handler) await agents?.close(); await close(server); await close(model); await unseal(root); await rm(root, { recursive: true, force: true }); });
  await listen(model);
  const config = { llmConfigured: true, model: "fixture-model", apiKey: "fixture-only", chatUrl: `http://127.0.0.1:${fixturePort(model)}/v1/chat/completions` }, dataDir = join(root, "data");
  agents = new PrototypeAgents({ config, cwd: root, dataDir, enforceRequirementConfirmation: true }); await agents.ready;
  assert.equal((await agents.services.probe({ language: "javascript", host: "managed" })).available, true, "支持平台必须具备真实受管隔离");
  handler = createRequestHandler({ config, dataDir, prototypeAgents: agents, projects: {}, projectAgent: {} }); await handler.ready;
  server = createServer(handler); await listen(server); const url = `http://127.0.0.1:${fixturePort(server)}`;
  const json = async (path: string, body?: { id?: string; name?: string; draft?: RequirementDraft; actionId?: string; input?: { text: string; }; mutationId?: string; deliveryVersion?: string; }) => { const response = await fetch(url + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json(); assert.equal(response.ok, true, JSON.stringify(result)); return result; };
  async function build() {
    const draft = { ...validDraft(`规范化文字，第${edition}版`), taskSpec: { version: 1, items: [] } };
    draft.name.value = "固定服务助手";
    const provider = { generateDraft: async () => ({ draft, proposedGap: "none", question: "" }), preflight: sufficientPreflight, getPlatform: () => createPlatformSnapshot() };
    const ready = await processTurn({ message: "创建文字规范化功能", draft }, provider, { enforceConsultation: true, requestId: `start_${edition}` });
    const confirmed = await processTurn({ message: "确认", draft: ready.draft, consultation: ready.consultation, lastQuestion: ready.confirmationQuestion }, provider,
      { enforceConsultation: true, requestId: `confirm_${edition}` });
    await agents.saveRequirements("managed", { name: draft.name.value, draft: confirmed.draft }, { confirmation: confirmed.confirmation, consultation: confirmed.consultation });
    return json("/api/agents/build", { id: "managed", name: draft.name.value, draft: confirmed.draft });
  }
  async function run(deliveryVersion: string, expectedEdition: number) {
    const submission = { actionId: "normalize", input: { text: "actual" }, mutationId: `run_managed_${expectedEdition}_${requests.length}`, deliveryVersion };
    const submitted = await json("/api/agents/managed/tasks", submission); await agents.applications.wait("managed", submitted.taskId);
    const { task } = await json(`/api/agents/managed/tasks/${submitted.taskId}`);
    assert.equal(task.status, "completed", JSON.stringify(task)); assert.deepEqual(task.result, { status: "ok", text: "ACTUAL", edition: expectedEdition });
  }
  const first = await build(); assert.equal(first.architecture.design.schemaVersion, 3); assert.equal(first.architecture.design.profile, "custom");
  assert.deepEqual(requests.filter((entry) => ["submit_architecture_blueprint", "submit_architecture_module", "submit_architecture_integration"].includes(entry.name!))
    .map((entry) => entry.name), ["submit_architecture_blueprint", "submit_architecture_module", "submit_architecture_integration"]);
  assert.equal(first.architecture.designProgressCheckpoint.modelCalls, 3, "真实阶段请求分别累计且保存后才进入原独立评审和研发");
  assert.equal(first.development.status, "completed", JSON.stringify(first.development)); assert.equal(first.development.delivery, "ready");
  assert.equal(first.agent.execution.kind, "managed-service");
  const firstRecord = readDevelopmentRunRecord(await agents.development.store.getRun(first.agent.developmentRef.id));
  assert.equal(firstRecord!.planningArtifact!.indexPath, "index.json");
  assert.deepEqual((await agents.development.artifacts.validateSnapshot(firstRecord!.planningArtifact!, "managed")).plan, firstRecord!.plan);
  assert.equal(firstRecord!.package!.runtime, "managed-service"); assert.equal(firstRecord!.package!.application!.service!.language, "javascript");
  assert.equal(await readFile(join(firstRecord!.package!.snapshot.path, "actions.mjs"), "utf8"), source(1));
  assert.ok(firstRecord!.reports.every((report) => report.status === "passed"));
  const firstVersion = (await agents.applications.descriptor("managed")).deliveryVersion; await run(firstVersion, 1);
  edition = 2; const second = await build(); assert.equal(second.development.delivery, "ready", JSON.stringify(second.development));
  const secondVersion = (await agents.applications.descriptor("managed")).deliveryVersion; assert.notEqual(secondVersion, firstVersion); await run(secondVersion, 2);
  edition = 3; invalid = true; const failed = await build(); assert.equal(failed.development.status, "failed");
  assert.equal(failed.agent.developmentRef.id, second.agent.developmentRef.id); await run(secondVersion, 2);
  const overview = await json("/api/agents/managed/services"); assert.ok(overview.history.some((entry:{deliveryVersion:string}) => entry.deliveryVersion === firstVersion));
  await json("/api/agents/managed/services/rollback", { deliveryVersion: firstVersion });
  assert.equal((await agents.applications.descriptor("managed")).deliveryVersion, firstVersion); await run(firstVersion, 1);
  await agents.applications.store.setState('managed',{state:{text:'keep-business'},expectedVersion:0},{kind:'business',stateVersion:1});
  await agents.applications.store.setState('managed',{state:{text:'keep-draft'},expectedVersion:0},{kind:'draft',stateVersion:1});
  await writeFile(join(await agents.workspace('managed'),'saved.txt'),'keep-workspace');
  edition=4;invalid=false;dataVersion=2;
  const upgraded=await build();assert.equal(upgraded.development.status,'completed',JSON.stringify(upgraded.development));
  const upgradedVersion=(await agents.applications.descriptor('managed')).deliveryVersion;
  assert.ok(upgraded.agent.dataMigrationRef);
  assert.deepEqual((await agents.applications.store.getState('managed',{kind:'business',stateVersion:2})).state,{text:'keep-business'});
  await run(upgradedVersion,4);
  await json('/api/agents/managed/services/rollback',{deliveryVersion:firstVersion});
  assert.deepEqual((await agents.applications.store.getState('managed',{kind:'business',stateVersion:1})).state,{text:'keep-business'});
  assert.equal(await readFile(join(await agents.workspace('managed'),'saved.txt'),'utf8'),'keep-workspace');
  await run(firstVersion,1);
  assert.deepEqual(errors, []);
});
