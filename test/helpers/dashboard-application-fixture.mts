import assert from "node:assert/strict";
import type { ValueSchema } from "../../src/contracts/application.mjs";
import type { DevelopmentPlan } from "../../src/contracts/development.mjs";
import type { RequirementItem, ArchitectureDesign, ArchitectureAcceptance } from "../../src/contracts/architecture.mjs";
import type { RequirementDraft } from "../../src/contracts/requirements.mjs";
import { fixtureChatRequest, fixtureText, fixturePort, fixtureJsonObject, fixtureRequirements, fixtureAcceptanceIds, fixtureString } from "./http-model.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import { failureFields } from "./failure-fields.mjs";
import { createServer } from "node:http";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PrototypeAgents } from "../../src/agents/agent-prototype.mjs";
import { DevelopmentExecutor } from "../../src/development/development-executor.mjs";
import { createApp } from "../../src/server.mjs";
import { requirementItems } from "../../src/architecture/architecture-contract.mjs";
import { validDraft, validDesign, passingReview } from "./architecture.mjs";
import type { Server,IncomingMessage,ServerResponse } from "http";
import type { PathLike } from "fs";

export const DASHBOARD_AGENT_ID = "business-dashboard";
const object = (properties: Record<string, ValueSchema>): ValueSchema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const text: ValueSchema = { type: "string" }, number: ValueSchema = { type: "number" };
const metricsSchema = object({ revenue: number, visitors: number, conversion: number });
const outputSchema = object({ status: text, period: text, message: text, metrics: metricsSchema });
export const DASHBOARD_METRICS = { month: { revenue: 128400, visitors: 18420, conversion: 4.8 }, year: { revenue: 1468000, visitors: 218600, conversion: 5.2 } };
export const DASHBOARD_APPLICATION_SOURCE = `const metrics=${JSON.stringify(DASHBOARD_METRICS)};
const failure=(status,message)=>({status,period:'',message,metrics:{revenue:0,visitors:0,conversion:0}});
export const actions={async setPeriod(input,ctx){
 if(!input.period)return failure('missing_input','请选择月度或全年');
 if(!Object.hasOwn(metrics,input.period))return failure('invalid_period','仅支持月度或全年');
 try{ctx.progress({message:'正在更新看板筛选',percent:40});const previous=await ctx.state.get({});
  if(!Number.isSafeInteger(previous.version))return failure('unavailable','状态读取未完成');
  await ctx.state.set({state:{period:input.period},expectedVersion:previous.version});
  return {status:'ok',period:input.period,message:input.period==='year'?'已切换到全年':'已切换到月度',metrics:metrics[input.period]};
 }catch{return failure('unavailable','状态保存未完成，原筛选保留')}
}};`;
export const DASHBOARD_APPLICATION_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>经营数据看板</title><link rel="stylesheet" href="app.css"></head><body>
<main><header><span class="eyebrow">NEUMA · 演示数据</span><h1>经营概览</h1><p>查看关键指标，随时让助手解释当前筛选或执行切换。</p></header>
<section class="filters" aria-label="看板筛选"><label for="period">统计周期</label><select id="period"><option value="month">月度</option><option value="year">全年</option></select><button id="apply">更新看板</button><button id="assistant">询问助手</button><span id="period-label">月度数据</span></section>
<section class="metrics" aria-label="关键指标"><article><p>营业收入</p><strong id="revenue"></strong><span>人民币 · 示例数据</span></article><article><p>访问人数</p><strong id="visitors"></strong><span>去重访问人数</span></article><article><p>转化率</p><strong id="conversion"></strong><span>访问至购买</span></article></section>
<section class="insight"><span>当前观察</span><h2 id="insight"></h2><p>所有指标均为固定演示数据，用于验证页面与助手联动。</p></section><p id="status" role="status" aria-live="polite">正在恢复看板…</p>
</main><script src="app.js"></script></body></html>`;
export const DASHBOARD_APPLICATION_CSS = `:root{font-family:ui-sans-serif,system-ui,"PingFang SC",sans-serif;background:#f5f4ef;color:#23312c}*{box-sizing:border-box}body{margin:0}main{max-width:1160px;margin:auto;padding:38px 42px}.eyebrow{font-size:12px;letter-spacing:.13em;color:#567764}h1{font-size:36px;letter-spacing:-.04em;margin:12px 0}header p{color:#6c7871;font-size:14px}.filters{display:flex;align-items:center;gap:12px;margin:30px 0 26px;font-size:13px}.filters>span{margin-left:auto;color:#63776a}select,button{font:inherit;border:1px solid #cbd4c9;background:#fffefb;border-radius:8px;padding:10px 14px;color:#2b4635}button{cursor:pointer}button#apply{background:#2b6149;color:white;border-color:#2b6149}button:disabled{opacity:.5}select:focus,button:focus-visible{outline:3px solid #a8c6ae;outline-offset:2px}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}.metrics article{background:#fffefb;border:1px solid #dde2d7;padding:24px;border-radius:14px}.metrics p{margin:0 0 18px;color:#68796c;font-size:13px}.metrics strong{display:block;font-size:35px;letter-spacing:-.04em;font-weight:600}.metrics span{display:block;font-size:12px;color:#8a948c;margin-top:14px}.insight{padding:26px 30px;background:#e7eee3;border-radius:14px;margin-top:22px}.insight>span{font-size:12px;color:#5b765e}.insight h2{font-size:21px;font-weight:500}.insight p,#status{font-size:13px;line-height:1.7;color:#6a7a6d}#status{min-height:24px;margin-top:20px}`;
export const DASHBOARD_APPLICATION_SCRIPT = `(async()=>{
 const $=id=>document.getElementById(id),api=window.neuma,defaults=${JSON.stringify(DASHBOARD_METRICS)};
 let stateVersion=0,period='month',shownPeriod='month',metrics={...defaults.month},contextRevision=null,publishing=0;
 let saveQueue=Promise.resolve();const received=new Map();
 const snapshot=()=>({viewId:'overview',title:'经营数据看板',summary:'已展示'+(shownPeriod==='year'?'全年':'月度')+'数据；当前选择'+(period==='year'?'全年':'月度'),selection:{period},values:{displayedPeriod:shownPeriod,metrics:{...metrics}}});
 function show(message){$('status').textContent=message}
 function render(){ $('period').value=period;$('period-label').textContent=(shownPeriod==='year'?'全年':'月度')+'数据';$('revenue').textContent='¥'+metrics.revenue.toLocaleString('zh-CN');$('visitors').textContent=metrics.visitors.toLocaleString('zh-CN');$('conversion').textContent=metrics.conversion+'%';$('insight').textContent=shownPeriod==='year'?'全年转化率达到 5.2%，高于本月表现。':'本月收入 12.84 万元，转化率为 4.8%。'; }
 async function publish(){const request=++publishing;contextRevision=null;const reply=await api.assistant.setContext(snapshot());if(request===publishing)contextRevision=reply.revision;return reply.revision}
 function save(){const state={period,shownPeriod,metrics:{...metrics}};saveQueue=saveQueue.catch(()=>{}).then(async()=>{const result=await api.state.save(state,stateVersion);stateVersion=result.version});return saveQueue}
 async function selectPeriod(value){period=value;render();await publish();await save()}
 async function applyTask(event){
  if(event.actionId!=='setPeriod'||!['completed','failed','cancelled','interrupted'].includes(event.status))return;
  if(event.stale||contextRevision===null||event.contextRevision!==contextRevision){show('结果已保存在任务记录，当前筛选保留。');return}
  if((received.get(event.taskId)||0)>=event.sequence)return;
  const expected=contextRevision;const {task}=await api.tasks.get(event.taskId);
  if(contextRevision!==expected||event.contextRevision!==contextRevision){show('结果已保存在任务记录，当前筛选保留。');return}
  received.set(event.taskId,event.sequence);
  if(task.status!=='completed'||task.result?.status!=='ok'){show(task.error||task.result?.message||'任务未完成，原筛选保留。');return}
  period=shownPeriod=task.result.period;metrics={...task.result.metrics};render();await publish();await save();show(task.result.message);
 }
 $('period').addEventListener('change',()=>selectPeriod($('period').value).catch(error=>show(error.message)));
 $('apply').addEventListener('click',async()=>{try{if(contextRevision===null)await publish();const reply=await api.actions.run('setPeriod',{period},{mutationId:crypto.randomUUID()});show('任务已提交，等待看板更新。');return reply}catch(error){show(error.message)}});
 $('assistant').addEventListener('click',()=>api.assistant.open().catch(error=>show(error.message)));
 api.tasks.subscribe(event=>applyTask(event).catch(error=>show(error.message)));
 try{const saved=await api.state.get();stateVersion=saved.version;const state=saved.state;if(['month','year'].includes(state?.period))period=state.period;if(['month','year'].includes(state?.shownPeriod)){shownPeriod=state.shownPeriod;metrics={...defaults[shownPeriod]}}render();await publish();show('可询问“解释这里”，或让助手“切换到全年”。')}catch(error){render();show(error.message)}
 return {selectPeriod,applyTask,snapshot,contextRevision:()=>contextRevision};
})();`;
export const DASHBOARD_APPLICATION_FILES = { "actions.mjs": DASHBOARD_APPLICATION_SOURCE, "ui/index.html": DASHBOARD_APPLICATION_HTML,
  "ui/app.css": DASHBOARD_APPLICATION_CSS, "ui/app.js": DASHBOARD_APPLICATION_SCRIPT };

export function dashboardApplicationDraft() {
  const draft = validDraft("使用经营看板查看月度和全年指标，并让助手解释当前页面或切换筛选");
  for (const [key, value] of Object.entries({ name: "经营数据看板", scenario: "复盘固定演示指标", inputSource: "页面的月度或全年选择与助手文字请求",
    task: "展示收入、访问人数和转化率，解释当前页面，通过已交付动作切换统计周期", deliverable: "NEUMA 内的看板页面与可选助手，保存当前筛选", successCriteria: "页面与助手上下文一致，旧结果不得覆盖新筛选" })) draft[key as keyof Pick<RequirementDraft, "name" | "scenario" | "inputSource" | "task" | "deliverable" | "successCriteria">] = { value, source: "user" };
  draft.interaction = { defaultEntry: "application", page: true, operations: ["切换统计周期"], inputs: "month 或 year", results: "三项指标与解释", persistentData: "当前筛选和展示结果",
    assistant: { enabled: true, purpose: "解释当前看板的筛选与指标，并通过已交付动作切换统计周期" } };
  return draft;
}
export function dashboardApplicationDesign(requirements = requirementItems(dashboardApplicationDraft())): Extract<ArchitectureDesign, { schemaVersion: 2 }> {
  return validDesign(requirements, { schemaVersion: 2, profile: "light", rationale: "固定示例指标和单个受控动作即可完成看板交互。",
    instructions: "你是经营看板助手。根据本轮页面快照解释当前筛选和示例指标。用户要求切换周期时调用 setPeriod 动作，依据真实任务结果回答；不能将示例数据称为真实经营数据。",
    interaction: { defaultEntry: "application", page: true, operations: true, inputs: "月度或全年", results: "收入、访问人数、转化率", persistentData: "筛选草稿与业务状态",
      assistant: { enabled: true, purpose: "解释当前看板的筛选与指标，并通过已交付动作切换统计周期" } }, connections: [],
    capabilities: [{ id: "conversation", status: "available", reason: "解释当前页面" }, { id: "dashboard_application", status: "needs_development", reason: "托管页面和周期切换动作" }],
    state: { mode: "persistent", reason: "保存当前筛选及展示结果" },
    acceptance: [
      { id: "valid", kind: "success", requirementIds: requirements.map(item => item.id), input: "year", expected: "返回全年指标并保存周期" },
      { id: "empty", kind: "missing_input", requirementIds: ["inputSource"], input: "空周期", expected: "请求选择周期" },
      { id: "boundary", kind: "boundary", requirementIds: ["externalAction"], input: "week", expected: "拒绝未支持周期" },
      { id: "tool_failure", kind: "tool_failure", requirementIds: ["deliverable"], input: "状态读取失败", expected: "不声称已切换，保留原状态" },
    ] });
}
export function dashboardApplicationPlan(requirements: RequirementItem[], design: { acceptance: Pick<ArchitectureAcceptance, "id">[] }): Extract<DevelopmentPlan, { schemaVersion: 2 }> {
  const mock = (capability: string, args: { state?: { period: string; }; expectedVersion?: number; }, result: { state?: {}|{ period: string; }; version?: number; stateVersion?: number; unavailable?: boolean; }) => ({ capability, argsJson: JSON.stringify(args), resultJson: JSON.stringify(result) });
  const cases = (id: string, period: string, mocks: { capability: string; argsJson: string; resultJson: string; }[], status: string) => ({ id: `case_${id}`, taskId: "dashboard", acceptanceId: id, actionId: "setPeriod", input: JSON.stringify({ period }), mocks,
    assertions: [{ path: "status", expectedJson: JSON.stringify(status) }] });
  return { schemaVersion: 2, summary: "交付经营数据看板与页面助手", runtime: "node-action", entrypoint: "actions.mjs",
    application: { protocolVersion: 2, runtime: "node-action", entrypoint: "actions.mjs", page: { entrypoint: "ui/index.html",
      resources: ["ui/index.html", "ui/app.css", "ui/app.js"].map(path => ({ path, sha256: "" })) },
      actions: [{ id: "setPeriod", title: "切换统计周期", inputSchema: object({ period: text }), outputSchema, connectionIds: [] }], stateVersion: 1, evidenceIds: [] },
    tasks: [{ id: "dashboard", title: "开发看板与页面助手联动", description: "交付看板、上下文发布、真实周期动作及任务事件更新，旧结果不覆盖新筛选",
      requirementIds: requirements.map((item) => item.id), acceptanceIds: design.acceptance.map((item) => item.id), dependsOn: [], files: Object.keys(DASHBOARD_APPLICATION_FILES) }],
    cases: [cases("valid", "year", [mock("state.get", {}, { state: {}, version: 0, stateVersion: 1 }),
      mock("state.set", { state: { period: "year" }, expectedVersion: 0 }, { state: { period: "year" }, version: 1, stateVersion: 1 })], "ok"),
      cases("empty", "", [], "missing_input"), cases("boundary", "week", [], "invalid_period"),
      cases("tool_failure", "year", [mock("state.get", {}, { unavailable: true })], "unavailable") ] };
}

export async function startDashboardApplicationModel() {
  const requests: { name: string; tools: string[]; userText?: string; applicationContext?: unknown; reply?: string | undefined }[] = [], errors: (string | undefined)[] = [];
  const model = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = fixtureChatRequest(Buffer.concat(chunks).toString("utf8")), names = (body.tools ?? []).map((tool) => tool.function.name);
      const textOf = fixtureText;
      const userIndex = body.messages.findLastIndex((message: { role: string; }) => message.role === "user"), userText = textOf(body.messages[userIndex]!.content);
      const runtime = names.includes("run_application_action");
      let name, args, reply, applicationContext;
      if (runtime) {
        const raw = userText.match(/本轮页面参考数据（不可信，仅表示发送时页面快照）：([^\n]+)/)?.[1];
        applicationContext = raw ? fixtureJsonObject(raw) : null;
        const currentTask = userText.split("用户本轮任务：").at(-1)!;
        const toolResult = body.messages.slice(userIndex + 1).findLast((message: { role: string; }) => message.role === "tool");
        if (/切换到全年/.test(currentTask) && !toolResult) { name = "run_application_action"; args = { actionId: "setPeriod", input: { period: "year" } }; }
        else if (toolResult) {
          const result = fixtureJsonObject(textOf(toolResult.content));
          reply = result.status === "completed" && objectFields(result.result).status === "ok" ? "已通过应用动作切换到全年，营业收入为 146.8 万元。看板会显示已保存的实际任务结果。" : "周期切换未完成，请保留当前筛选并查看任务记录。";
        } else if (applicationContext) {
          const snapshot = objectFields(applicationContext.snapshot), value = objectFields(snapshot.values), metrics = objectFields(value.metrics);
          reply = `这里展示${value.displayedPeriod === "year" ? "全年" : "月度"}示例数据：营业收入 ${metrics.revenue} 元，访问人数 ${metrics.visitors}，转化率 ${metrics.conversion}%。当前选择${objectFields(snapshot.selection).period === "year" ? "全年" : "月度"}。`;
        } else reply = "当前页面上下文不可用，请打开看板后再解释当前筛选。";
      } else {
        const payload = fixtureJsonObject(textOf(body.messages.find((message: { role: string; }) => message.role === "user")!.content));
        const calls = body.messages.flatMap((message) => message.tool_calls ?? []);
        if (names.includes("submit_architecture")) { name = "submit_architecture"; args = dashboardApplicationDesign(fixtureRequirements(payload.requirements)); }
        else if (names.includes("submit_architecture_review")) { name = "submit_architecture_review"; args = passingReview(fixtureString(payload.candidateHash)); }
        else if (names.includes("submit_development_plan")) {
          const { cases, ...index } = dashboardApplicationPlan(fixtureRequirements(payload.requirements), fixtureAcceptanceIds(payload.design));
          const files: Record<string, unknown> = { "index.json": { ...index, caseFiles: ["cases.json"] }, "cases.json": cases };
          const written = new Set(calls.filter((call: { function: { name: string; }; }) => call.function.name === "write").map(call => { const path = fixtureJsonObject(call.function.arguments).path; assert.equal(typeof path, "string"); return path as string; }));
          const path = Object.keys(files).find(path => !written.has(path));
          if (path) { name = "write"; args = { path, content: JSON.stringify(files[path], null, 2) }; }
          else { name = "submit_development_plan"; args = { indexPath: "index.json" }; }
        }
        else if (names.includes("submit_development_review")) { name = "submit_development_review"; args = { subjectHash: payload.subjectHash, verdict: "pass", issues: [], summary: "固定看板验收的本机模拟评审，实际隔离用例已执行" }; }
        else if (names.includes("submit_development_work")) {
          const written = new Set(calls.filter((call: { function: { name: string; }; }) => call.function.name === "write").map(call => { const path = fixtureJsonObject(call.function.arguments).path; assert.equal(typeof path, "string"); return path as string; }));
          const path = Object.keys(DASHBOARD_APPLICATION_FILES).find(path => !written.has(path));
          if (path) { name = "write"; args = { path, content: DASHBOARD_APPLICATION_FILES[path as keyof typeof DASHBOARD_APPLICATION_FILES] }; }
          else { name = "submit_development_work"; args = { summary: "看板与动作已实现，提交隔离验收", changedFiles: Object.keys(DASHBOARD_APPLICATION_FILES), knownIssues: [], nextAction: "", continue: false }; }
        } else throw new Error("unsupported_dashboard_fixture_role");
      }
      requests.push({ name: name ?? "reply", tools: names, ...(runtime ? { userText, applicationContext, reply } : {}) });
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: { role?: string; tool_calls?: { index: number; id: string; type: string; function: { name: string; arguments: string; }; }[]; content?: string|undefined; }, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({ id: `dashboard_${requests.length}`, object: "chat.completion.chunk", created: 1,
        model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (name) { chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }); chunk({}, "tool_calls"); }
      else { chunk({ role: "assistant", content: reply }); chunk({}, "stop"); }
      response.end("data: [DONE]\n\n");
    } catch (error) { errors.push(failureFields(error).message); if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "看板测试模型协议失败" } })); }
  });
  await new Promise<void>((done, reject) => { model.once("error", reject); model.listen(0, "127.0.0.1", done); });
  return { requests, errors, config: { llmConfigured: true, model: "fixture-model", apiKey: "fixture-only", chatUrl: `http://127.0.0.1:${fixturePort(model)}/v1/chat/completions` },
    close: async () => { model.closeAllConnections(); if (model.listening) await new Promise<void>(done => model.close(() => done())); } };
}

async function unseal(path: string) {
  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await unseal(join(path, entry.name));
}
export async function startDashboardApplicationFixture() {
  const probe = await new DevelopmentExecutor().probe();
  if (!probe.available) throw Object.assign(new Error(probe.reason), { reason: "isolation_unavailable" });
  const root = await mkdtemp(join(tmpdir(), "neuma-dashboard-fixture-")), dataDir = join(root, "data"), model = await startDashboardApplicationModel();
  const agents = new PrototypeAgents({ config: model.config, cwd: root, dataDir });
  let server: ReturnType<typeof createApp>, closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    try { if (server) { await server.dispose(); server.closeAllConnections(); if (server.listening) await new Promise<void>(done => server.close(() => done())); } else await agents.close(); }
    finally { await model.close(); await unseal(root); await rm(root, { recursive: true, force: true }); }
  };
  try {
    const result = await agents.build({ id: DASHBOARD_AGENT_ID, name: "经营数据看板", draft: dashboardApplicationDraft() });
    if (result.development?.status !== "completed" || result.agent?.execution?.kind !== "node-action") throw new Error(`看板夹具未交付：${JSON.stringify({ development: result.development, architecture: result.architecture?.status, errors: model.errors })}`);
    server = createApp({ config: model.config, dataDir, envPath: join(root, "fixture-settings"), prototypeAgents: agents, providers: {},
      projects: { dispose: async () => {}, list: async () => [], failures: async () => [], runtime: async () => ({ checkedAt: new Date().toISOString(),
        ports: [], projects: [], summary: { total: 0, running: 0, stopped: 0, unknown: 0 }, warnings: [] }) },
      projectAgent: { dispose: async () => {} }, skillManager: { dispose: async () => {} } });
    await server.ready;
    await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
    const base = `http://127.0.0.1:${fixturePort(server)}`, route = `/api/agents/${DASHBOARD_AGENT_ID}`;
    const api = async (path: string, { method = "GET", body }: { method?: string; body?: unknown } = {}) => {
      const response = await fetch(base + path, { method, headers: { origin: base, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json();
      if (!response.ok) throw Object.assign(new Error(value.error || "看板测试请求失败"), { status: response.status, reason: value.reason });
      return value;
    };
    return { base, route, url: `${base}/#agent/${DASHBOARD_AGENT_ID}`, root, dataDir, agents, model, server, result, api, close };
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const fixture = await startDashboardApplicationFixture();
  process.stdout.write(`${JSON.stringify({ url: fixture.url, temporaryData: fixture.root, agentId: DASHBOARD_AGENT_ID })}\n`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => fixture.close().then(() => process.exit(0)));
}
