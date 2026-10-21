import { createServer } from "node:http";
import { validDraft, validDesign, passingReview } from "./architecture.mjs";
import { requirementItems } from "../../src/architecture/architecture-contract.mjs";

const object = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const text = { type: "string" }, bool = { type: "boolean" };
const itemSchema = object({ title: text, url: text, content: text, truncated: bool });
const itemsSchema = { type: "array", items: itemSchema, maxItems: 20 };
const outputSchema = object({ status: text, message: text, items: itemsSchema, artifact: text });
export const LINK_APPLICATION_SOURCE = `export const actions = {
 async analyze(input, ctx) {
  if (!input.url.trim()) return {status:'missing_input',message:'请先填写公开网页链接',items:[],artifact:''};
  let url;try{url=new URL(input.url);if(!['https:','http:'].includes(url.protocol))throw Error()}catch{return {status:'invalid_url',message:'请输入 HTTP(S) 网页链接',items:[],artifact:''}}
  try {
   ctx.progress({message:'正在读取提供的网页',percent:15});
   const page=await ctx.web.fetch({url:url.href,refresh:input.refresh});
   if(!page.results?.length)return {status:'unavailable',message:'网页没有返回可读取的正文',items:[],artifact:''};
   ctx.progress({message:'正在检索相关公开资料',percent:55});
   const query=page.results[0].title||url.hostname;
   const search=await ctx.web.search({query,refresh:input.refresh});
   const seen=new Set(),items=[...page.results,...(search.results||[])].filter(item=>{if(seen.has(item.url))return false;seen.add(item.url);return true}).slice(0,20).map(item=>({title:item.title,url:item.url,content:item.content,truncated:!!item.truncated}));
   ctx.progress({message:'资料整理完成',percent:100});
   return {status:'ok',message:'已读取来源网页并收集相关资料；搜索结果为摘要。',items,artifact:''};
  } catch {return {status:'unavailable',message:'网页读取或检索未完成，请检查连接或稍后重试',items:[],artifact:''}}
 },
 async exportCsv(input,ctx){
  const quote=value=>'"'+String(value).replaceAll('"','""')+'"';
  const content='标题,网址,正文或摘要,是否截断\\n'+input.items.map(item=>[item.title,item.url,item.content,String(item.truncated)].map(quote).join(',')).join('\\n');
  await ctx.files.write({file:'link-results.csv',content});
  return {status:'ok',message:'CSV 已保存到产物',items:input.items,artifact:'link-results.csv'};
 }
};`;
export const LINK_APPLICATION_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>链接资料搜寻</title><link rel="stylesheet" href="app.css"></head><body>
<main><header><span class="eyebrow">NEUMA · 资料工作台</span><h1>从一个链接，开始研究。</h1><p>读取来源网页，搜寻相关资料，保留出处与读取边界。</p></header>
<form id="form"><label for="url">公开网页链接</label><div class="input-row"><input id="url" type="url" placeholder="https://example.com/article" autocomplete="url"><button id="run" type="submit">读取并搜寻</button></div><label class="refresh"><input id="refresh" type="checkbox">刷新最新资料</label></form>
<div class="toolbar"><label>筛选结果<input id="filter" type="search" placeholder="标题、网址或内容"></label><button id="export" disabled>导出 CSV</button><button id="settings">搜索连接设置</button><button id="cancel" hidden>停止任务</button></div>
<p id="status" role="status" aria-live="polite">免费搜索默认可用，可按需配置专属服务。</p><progress id="progress" max="100" value="0" hidden></progress><section id="results" aria-label="检索结果"></section>
</main><script type="module" src="app.js"></script></body></html>`;
export const LINK_APPLICATION_CSS = `:root{font-family:ui-sans-serif,system-ui,"PingFang SC",sans-serif;color:#243342;background:#f8fafb}*{box-sizing:border-box}body{margin:0}main{max-width:1100px;margin:auto;padding:40px 42px}.eyebrow{font-size:12px;font-weight:650;letter-spacing:.12em;color:#2d7775}h1{font-size:30px;letter-spacing:-.03em;margin:14px 0 10px}header p{color:#637581;margin-bottom:30px}label{font-size:13px;color:#506271}input{border:1px solid #d5dfe3;border-radius:8px;padding:12px;font:inherit;background:white;color:#243342}input:focus,button:focus-visible{outline:3px solid #7bbab6;outline-offset:2px}.input-row{display:flex;gap:10px;margin-top:8px}.input-row input{flex:1}.refresh{display:flex;align-items:center;gap:8px;margin-top:12px}button{padding:11px 16px;border:1px solid #cbd7db;border-radius:8px;background:#fff;color:#31505b;font:inherit;cursor:pointer}button[type=submit]{background:#246765;color:white;border-color:#246765}button:disabled{opacity:.5;cursor:default}.toolbar{display:flex;align-items:end;gap:10px;margin-top:30px}.toolbar label{flex:1}.toolbar input{display:block;width:100%;margin-top:6px}#status{font-size:13px;line-height:1.8;color:#58717c}progress{width:100%;height:6px}#results{display:grid;gap:14px;margin-top:22px}.result{padding:20px;border:1px solid #dde5e8;background:white;border-radius:10px}.result h2{font-size:17px;margin:0 0 9px}.result a{color:#216c6e;overflow-wrap:anywhere}.result p{font-size:14px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}.badge{font-size:11px;padding:3px 6px;border-radius:5px;background:#fff0d9;color:#7b5924}`;
export const LINK_APPLICATION_SCRIPT = `const $=id=>document.getElementById(id);let stateVersion=0,items=[],taskId=null,timer;
function show(message){$('status').textContent=message}
function render(){const query=$('filter').value.toLowerCase();$('results').replaceChildren();for(const item of items.filter(item=>(item.title+' '+item.url+' '+item.content).toLowerCase().includes(query))){const article=document.createElement('article');article.className='result';const title=document.createElement('h2');title.textContent=item.title;const link=document.createElement('a');link.href=item.url;link.textContent=item.url;link.target='_blank';link.rel='noopener noreferrer';const body=document.createElement('p');body.textContent=item.content;article.append(title,link,body);if(item.truncated){const badge=document.createElement('span');badge.className='badge';badge.textContent='正文已截断';article.append(badge)}$('results').append(article)}$('export').disabled=!items.length}
async function saveDraft(){const reply=await window.neuma.state.save({url:$('url').value,refresh:$('refresh').checked,filter:$('filter').value},stateVersion);stateVersion=reply.version}
async function watch(id){taskId=id;$('cancel').hidden=false;$('run').disabled=true;try{const {task}=await window.neuma.tasks.get(id);show(task.progress?.message||task.summary||task.status);if(task.progress?.percent!==undefined){$('progress').hidden=false;$('progress').value=task.progress.percent}if(['completed','failed','cancelled','interrupted'].includes(task.status)){clearTimeout(timer);taskId=null;$('cancel').hidden=true;$('run').disabled=false;$('progress').hidden=true;if(task.result){items=task.result.items||[];render();show(task.result.message||task.status)}else show(task.error?.message||task.status);return}timer=setTimeout(()=>watch(id),350)}catch(error){show(error.message);$('run').disabled=false}}
$('form').addEventListener('submit',async event=>{event.preventDefault();try{await saveDraft();const result=await window.neuma.actions.run('analyze',{url:$('url').value,refresh:$('refresh').checked},{mutationId:crypto.randomUUID()});watch(result.taskId)}catch(error){show(error.message)}});
$('filter').addEventListener('input',render);$('url').addEventListener('change',()=>saveDraft().catch(error=>show(error.message)));
$('export').addEventListener('click',async()=>{try{const result=await window.neuma.actions.run('exportCsv',{items},{mutationId:crypto.randomUUID()});watch(result.taskId)}catch(error){show(error.message)}});
$('settings').addEventListener('click',()=>window.neuma.settings.open());$('cancel').addEventListener('click',async()=>{if(taskId)await window.neuma.tasks.cancel(taskId)});
try{const reply=await window.neuma.state.get();stateVersion=reply.version;$('url').value=reply.state?.url||'';$('refresh').checked=!!reply.state?.refresh;$('filter').value=reply.state?.filter||'';const {tasks}=await window.neuma.tasks.list();const last=tasks.at(-1);if(last){if(['queued','running'].includes(last.status))watch(last.id||last.taskId);else if(last.result){items=last.result.items||[];render();show(last.result.message||last.status)}}}catch(error){show(error.message)};`;
export const LINK_APPLICATION_FILES = { "actions.mjs": LINK_APPLICATION_SOURCE, "ui/index.html": LINK_APPLICATION_HTML, "ui/app.css": LINK_APPLICATION_CSS, "ui/app.js": LINK_APPLICATION_SCRIPT };

export function linkApplicationDraft() {
  const draft = validDraft("输入网页链接，读取并搜索相关公开资料，筛选结果并导出 CSV");
  for (const [key, value] of Object.entries({ name: "链接资料搜寻工具", scenario: "研究公开链接时按需使用",
    inputSource: "用户在应用页面输入公开 HTTP(S) 网页链接", task: "先读取来源页，再搜索相关公开资料，保留标题、网址、正文或摘要及截断说明",
    deliverable: "NEUMA 内的交互页面，展示进度和可筛选结果，并可导出 CSV", successCriteria: "免费联网默认可用，读取失败真实说明，结果保留来源" })) draft[key] = { value, source: "user" };
  draft.interaction = { defaultEntry: "application", page: true, operations: ["读取并搜寻", "导出 CSV"], inputs: "公开网页链接", results: "可筛选资料列表及 CSV", persistentData: "链接草稿和任务结果" };
  draft.connections = [{ purpose: "search", description: "可选专属搜索服务，未配置时使用免费搜索", required: false }];
  return draft;
}
export function linkApplicationDesign(requirements = requirementItems(linkApplicationDraft())) {
  return validDesign(requirements, { schemaVersion: 2, profile: "light", rationale: "业务步骤简单，页面与动作需进入研发交付。",
    instructions: "帮助用户搜寻链接资料，可以调用已交付动作 analyze 和 exportCsv；免费网页能力默认具备。只报告真实回执，搜索摘要不能冒充完整正文。",
    interaction: { defaultEntry: "application", page: true, operations: true, inputs: "用户网页链接", results: "资料及 CSV", persistentData: "页面草稿和任务记录" },
    connections: [{ id: "research_search", purpose: "search", required: false, description: "可选的专属搜索服务", operations: [] }],
    capabilities: [{ id: "conversation", status: "available", reason: "对话辅助" }, { id: "link_application", status: "needs_development", reason: "托管页面和后端动作" }],
    state: { mode: "task", reason: "结果由平台任务记录保存，页面草稿由平台版本状态保存" },
    acceptance: [
      { id: "valid", kind: "success", requirementIds: requirements.map(item => item.id), input: "https://example.com/article", expected: "先读取后检索返回来源列表" },
      { id: "empty", kind: "missing_input", requirementIds: ["inputSource"], input: "空网址", expected: "请求补充网址" },
      { id: "boundary", kind: "boundary", requirementIds: ["externalAction"], input: "file:///private", expected: "拒绝非HTTP网址" },
      { id: "tool_failure", kind: "tool_failure", requirementIds: ["deliverable"], input: "网页没有正文", expected: "返回真实读取失败" },
      { id: "export", kind: "success", requirementIds: ["deliverable"], input: "资料列表", expected: "按真实资料保存CSV" },
    ] });
}
const page = { title: "公开网页", url: "https://example.com/article", content: "真实协议测试使用的模拟正文", truncated: false };
const related = { title: "相关资料", url: "https://example.com/related", content: "搜索结果摘要", truncated: true };
export const LINK_APPLICATION_WEB = {
  async fetch(input) { return { status: "ok", provider: "fixture", fetchedAt: new Date().toISOString(), results: [{ ...page, url: input.url }], gaps: [] }; },
  async search() { return { status: "ok", provider: "fixture", fetchedAt: new Date().toISOString(), results: [related], gaps: [] }; },
};
export function linkApplicationPlan(requirements = requirementItems(linkApplicationDraft()), design = linkApplicationDesign(requirements)) {
  const mock = (capability, args, result) => ({ capability, argsJson: JSON.stringify(args), resultJson: JSON.stringify(result) });
  const caseOf = (id, actionId, input, mocks, path, expected) => ({ id: `case_${id}`, taskId: "application", acceptanceId: id, actionId, input: JSON.stringify(input), mocks, assertions: [{ path, expectedJson: JSON.stringify(expected) }] });
  return { schemaVersion: 2, summary: "实现公开链接资料搜寻应用", runtime: "node-action", entrypoint: "actions.mjs",
    application: { protocolVersion: 2, runtime: "node-action", entrypoint: "actions.mjs", page: { entrypoint: "ui/index.html", resources: ["ui/index.html", "ui/app.css", "ui/app.js"].map(path => ({ path, sha256: "" })) },
      actions: [{ id: "analyze", title: "读取并搜寻", inputSchema: object({ url: text, refresh: bool }), outputSchema, connectionIds: [] },
        { id: "exportCsv", title: "导出 CSV", inputSchema: object({ items: itemsSchema }), outputSchema, connectionIds: [] }], stateVersion: 1, evidenceIds: [] },
    tasks: [{ id: "application", title: "开发链接资料搜寻应用", description: "实现托管页面、网页能力桥、结果筛选及CSV保存", requirementIds: requirements.map(item => item.id), acceptanceIds: design.acceptance.map(item => item.id), dependsOn: [], files: Object.keys(LINK_APPLICATION_FILES) }],
    cases: [
      caseOf("valid", "analyze", { url: page.url, refresh: false }, [mock("web.fetch", { url: page.url, refresh: false }, { results: [page] }), mock("web.search", { query: page.title, refresh: false }, { results: [related] })], "items", [page, related]),
      caseOf("empty", "analyze", { url: "", refresh: false }, [], "status", "missing_input"),
      caseOf("boundary", "analyze", { url: "file:///private", refresh: false }, [], "status", "invalid_url"),
      caseOf("tool_failure", "analyze", { url: page.url, refresh: false }, [mock("web.fetch", { url: page.url, refresh: false }, { results: [] })], "status", "unavailable"),
      caseOf("export", "exportCsv", { items: [] }, [mock("files.write", { file: "link-results.csv", content: "标题,网址,正文或摘要,是否截断\n" }, { saved: true })], "artifact", "link-results.csv"),
    ] };
}

export async function startLinkApplicationModel({ businessArchive = false, inputRejection = false } = {}) {
  const deliveredFiles = businessArchive ? { ...LINK_APPLICATION_FILES, "actions.mjs": LINK_APPLICATION_SOURCE + `
    actions.archive=async(input,ctx)=>{await ctx.connection.call({connectionId:'archive_api',operationId:'archive',input});return {status:'ok',message:'已归档',items:input.items,artifact:''}};
  ` } : LINK_APPLICATION_FILES;
  const designOf = (requirements) => {
    const design = linkApplicationDesign(requirements);
    if (businessArchive) {
      design.connections.push({ id: "archive_api", purpose: "business", required: true, description: "将所选资料归档至业务接口",
        operations: [{ id: "archive", method: "POST", path: "/archives", input: "资料列表", output: "归档回执", safeTest: false }] });
      design.acceptance.push({ id: "archive", kind: "success", requirementIds: ["deliverable"], input: "资料列表", expected: "获得实际业务连接归档回执" });
    }
    if (inputRejection) design.acceptance.push({ id: "schema_rejection", kind: "boundary", requirementIds: ["inputSource"], input: "链接不是字符串", expected: "平台拒绝输入且不执行业务动作" });
    return design;
  };
  const planOf = (requirements, design) => {
    const plan = linkApplicationPlan(requirements, design);
    if (businessArchive) {
      plan.application.actions.push({ id: "archive", title: "归档到业务服务", inputSchema: object({ items: itemsSchema }), outputSchema, connectionIds: ["archive_api"] });
      plan.cases.push({ id: "case_archive", taskId: "application", acceptanceId: "archive", actionId: "archive", input: '{"items":[]}',
        mocks: [{ capability: "connection.call", argsJson: '{"connectionId":"archive_api","operationId":"archive","input":{"items":[]}}', resultJson: '{"accepted":true}' }],
        assertions: [{ path: "status", expectedJson: '"ok"' }] });
    }
    if (inputRejection) plan.cases.push({ id: "case_schema_rejection", taskId: "application", acceptanceId: "schema_rejection", kind: "input-rejection", actionId: "analyze", input: '{"url":17,"refresh":false}', mocks: [],
      assertions: [{ path: "", expectedJson: '{"rejected":true,"reason":"input_contract_rejected"}' }] });
    return plan;
  };
  const requests = [], errors = [];
  const model = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      const textOf = (content) => typeof content === "string" ? content : (content ?? []).map(item => item.text ?? "").join("");
      const payload = JSON.parse(textOf(body.messages.find(message => message.role === "user").content));
      const names = (body.tools ?? []).map(tool => tool.function.name), calls = body.messages.flatMap(message => message.tool_calls ?? []);
      let name, args;
      if (names.includes("submit_architecture")) { name = "submit_architecture"; args = designOf(payload.requirements); }
      else if (names.includes("submit_architecture_review")) { name = "submit_architecture_review"; args = passingReview(payload.candidateHash); }
      else if (names.includes("submit_development_plan")) {
        const { cases, ...index } = planOf(payload.requirements, payload.design);
        const files = { "index.json": { ...index, caseFiles: ["cases.json"] }, "cases.json": cases };
        const written = new Set(calls.filter(call => call.function.name === "write").map(call => JSON.parse(call.function.arguments).path));
        const path = Object.keys(files).find(path => !written.has(path));
        if (path) { name = "write"; args = { path, content: JSON.stringify(files[path], null, 2) }; }
        else { name = "submit_development_plan"; args = { indexPath: "index.json" }; }
      }
      else if (names.includes("submit_development_review")) { name = "submit_development_review"; args = { subjectHash: payload.subjectHash, verdict: "pass", issues: [], summary: "本机模拟模型评审；实际隔离用例已经执行，不代表真实业务模型质量" }; }
      else if (names.includes("submit_development_work")) {
        const written = new Set(calls.filter(call => call.function.name === "write").map(call => JSON.parse(call.function.arguments).path));
        const path = Object.keys(deliveredFiles).find(path => !written.has(path));
        if (path) { name = "write"; args = { path, content: deliveredFiles[path] }; }
        else { name = "submit_development_work"; args = { summary: "页面与后端操作已实现，提交真实验收", changedFiles: Object.keys(LINK_APPLICATION_FILES), knownIssues: [], nextAction: "", continue: false }; }
      } else throw new Error("unsupported_fixture_role");
      requests.push({ name, tools: names });
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: `fixture_${requests.length}`, object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }); chunk({}, "tool_calls"); response.end("data: [DONE]\n\n");
    } catch (error) { errors.push(error.message); if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "测试模型协议失败" } })); }
  });
  await new Promise((resolve, reject) => { model.once("error", reject); model.listen(0, "127.0.0.1", resolve); });
  return { model, requests, errors, config: { llmConfigured: true, model: "fixture-model", apiKey: "fixture-only", chatUrl: `http://127.0.0.1:${model.address().port}/v1/chat/completions` },
    close: async () => { model.closeAllConnections(); if (model.listening) await new Promise(resolve => model.close(resolve)); } };
}
