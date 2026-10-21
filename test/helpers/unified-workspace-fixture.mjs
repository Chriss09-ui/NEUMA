import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequestHandler } from "../../src/server.mjs";
import { PrototypeAgents } from "../../src/agents/agent-prototype.mjs";
import { CollaborationService } from "../../src/collaboration/groups.mjs";
import { MainAgent } from "../../src/main/main-agent.mjs";
import { createPiSession } from "../../src/runtime/pi-runtime.mjs";
import { emptyDraft } from "../../src/requirements/core.mjs";
import { validDraft, validDesign, passingReview } from "./architecture.mjs";
import { sufficientPreflight } from "./consultation.mjs";

const textOf = (content) => typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("");
const fileCapabilities = ["conversation", "list_workspace_files", "read_workspace_file", "write_workspace_file"]
  .map((id) => ({ id, status: "available", reason: "只处理用户材料并在当前任务授权目录读写成果" }));
const listen = (server, port) => new Promise((resolve, reject) => {
  server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
});
const closeServer = async (server) => {
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
};
const userPayload = (body) => {
  const user = textOf(body.messages.findLast((message) => message.role === "user")?.content);
  const marker = "本轮协作任务与消息（资料）：\n", index = user.indexOf(marker);
  try { return JSON.parse(index >= 0 ? user.slice(index + marker.length) : user); } catch { return { raw: user }; }
};
const callsOf = (body) => body.messages.filter((message) => message.role === "assistant").flatMap((message) => message.tool_calls ?? []);
function toolReply(body, name, occurrence = 0) {
  const call = callsOf(body).filter((value) => value.function.name === name)[occurrence];
  const reply = body.messages.find((message) => message.role === "tool" && message.tool_call_id === call?.id);
  assert.ok(reply, `缺少真实工具回执 ${name}`);
  return JSON.parse(textOf(reply.content));
}

function requirementResult(input) {
  const message = input.latestUserMessage, prior = input.currentDraft;
  const name = /报表/.test(message) ? "报表助手" : prior?.name?.value || "研究助手";
  if (/帮我(?:创建|做|建)|创建一个/.test(message) && !/(?:提供|输入|输出|提炼|材料.*风险)/.test(message)) {
    const draft = emptyDraft(); draft.name = { value: name, source: "inferred" };
    draft.goal = { value: "整理用户提供的研究资料", source: "user" };
    return { draft, proposedGap: "task", question: "你会提供什么研究资料，希望它怎样处理、最后交付什么？" };
  }
  const draft = validDraft("把用户提供的研究资料整理为可核对的结论、风险和待办");
  draft.name = { value: name, source: "user" };
  draft.scenario = { value: "阅读研究资料、整理汇报时按需使用", source: "user" };
  draft.inputSource = { value: "用户在对话中提供的文字材料和共享文档", source: "user" };
  draft.task = { value: "提炼关键事实、风险与待办，并保留材料依据", source: "user" };
  draft.deliverable = { value: /三列|表格/.test(message) ? "事实、风险、待办三列表格" : "中文研究报告：关键事实、风险、待办", source: "user" };
  draft.successCriteria = { value: "只依据用户提供的材料，缺失信息明确标注，不编造事实", source: "user" };
  draft.constraints = [{ text: "不读取未经分享的私人材料，不执行外部发送", source: "user" }];
  return { draft, proposedGap: "none", question: "" };
}

export async function startUnifiedWorkspaceFixture({ port = 4372 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-unified-workspace-")), dataDir = join(root, "data");
  const materialPath = join(root, "research-material.txt");
  await writeFile(materialPath, "研究资料\n已知事实：本周完成原型开发和任务测试。\n风险：尚未验证长文档解析与外部模型稳定性。\n待办：核对主聊天、需求确认、群成员认领和材料结果持久化。\n");
  const records = [], errors = [], activeStreams = new Set();
  let agents, collaboration, main, handler, server, serial = 0, closing;
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      for (const response of activeStreams) response.destroy();
      await handler?.dispose();
      if (!handler) { await main?.close(); await collaboration?.close(); await agents?.close(); }
      if (server) await closeServer(server);
      await closeServer(model);
      await rm(root, { recursive: true, force: true });
    })();
    return closing;
  }
  const model = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)), payload = userPayload(body);
      const names = (body.tools ?? []).map((value) => value.function.name);
      const calls = callsOf(body), called = calls.map((call) => call.function.name);
      let name, args, reply, slow = false, role = "private";
      assert.equal(request.url, "/v1/chat/completions");
      if (!body.stream) {
        const preflight = textOf(body.messages[0]?.content).includes("独立架构预评估者");
        role = preflight ? "preflight" : "requirements";
        const result = preflight ? await sufficientPreflight() : requirementResult(payload);
        records.push({ role, message: payload.latestUserMessage });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(result) }, finish_reason: "stop" }] })); return;
      }
      if (names.includes("submit_requirement_route")) {
        role = "requirement-routing"; name = "submit_requirement_route";
        args = { route: "continue", quote: "" };
        assert.deepEqual(names, ["submit_requirement_route"], "需求寻址不暴露业务工具");
      } else if (names.includes("submit_architecture")) {
        role = "designer"; name = "submit_architecture";
        args = validDesign(payload.requirements, { capabilities: fileCapabilities,
          schemaVersion: 3,
          interaction: { defaultEntry: "conversation", page: false, operations: false, inputs: "用户共享的固定短材料", results: "中文报告", persistentData: "生成的报告文件" },
          connections: [], execution: { language: "none", hosting: "builtin", reason: "固定短材料的模拟任务使用已有文件工具" },
          selectionBasis: { capacity: "本测试只输入一份明确的小型文字材料", process: "读取实际共享材料、核对内容并保存报告",
            quality: "核对事实风险待办与共享原文及文件内容", requirementIds: payload.requirements.map((item) => item.id), assumptions: [] },
          instructions: "处理本轮用户明确提供的研究材料，核对关键事实、风险与待办，必要时保存文本报告；缺少信息必须标注，不能声称外部发送或联网。" });
      } else if (names.includes("submit_architecture_review")) {
        role = "reviewer"; name = "submit_architecture_review"; args = passingReview(payload.candidateHash);
        if (payload.design?.schemaVersion === 3) args.checks.push(...["requirement_sufficiency", "acceptance_quality"]
          .map((id) => ({ id, passed: true, evidence: "本机固定测试材料的规模与验收条件已明确，实际文件结果由后续断言核对" })));
      } else if (names.includes("assign_group_task")) {
        role = "main"; const message = payload.currentUserMessage;
        const isRequirement = /(?:创建|做|建|修改|迭代).*(?:Agent|智能体|助手)|补充需求|三列表格/i.test(message)
          || (payload.activeContext?.type === "requirements" && !payload.activeRequirement?.confirmed && !/日常|你好|慢速|停止|群/.test(message));
        if (/慢速|停止测试/.test(message)) { reply = "正在进行停止测试。这是本机模型逐段输出的内容，点击停止可中断当前回复。"; slow = true; }
        else if (isRequirement) {
          name = "open_agent_requirements"; args = { mode: /再.*创建|另一个|新建一个/.test(message) || !payload.activeRequirement ? "new" : "continue" };
        } else if (/创建.*(?:群|组)|拉.*群/.test(message)) {
          if (!called.includes("list_agents")) { name = "list_agents"; args = {}; }
          else if (!called.includes("create_group")) { name = "create_group"; args = { name: "研究组", purpose: "核对共享研究材料并共同交付", memberIds: toolReply(body, "list_agents").agents.filter((agent) => agent.ready).slice(0, 2).map((agent) => agent.id), userRequest: message }; }
          else reply = `研究组已创建。#group/${toolReply(body, "create_group").group.id}`;
        } else if (/停止|取消/.test(message) && /群|任务/.test(message)) {
          if (!called.includes("list_groups")) { name = "list_groups"; args = {}; }
          else {
            const group = toolReply(body, "list_groups").groups.find((value) => !value.archived);
            if (!group) reply = "还没有可查看的协作群。";
            else if (!called.includes("get_group")) { name = "get_group"; args = { groupId: group.id }; }
            else {
              const task = [...toolReply(body, "get_group").tasks].reverse().find((value) => !["completed", "partial", "failed", "cancelled", "interrupted"].includes(value.status));
              if (!task) reply = `${group.name}没有正在执行的任务。#group/${group.id}`;
              else if (!called.includes("read_group_task")) { name = "read_group_task"; args = { groupId: group.id, taskId: task.id }; }
              else if (!called.includes("stop_group_task")) { name = "stop_group_task"; args = { groupId: group.id, taskId: task.id, userRequest: message }; }
              else reply = `已通过真实停止接口终止${group.name}的当前任务，已有材料与成果保留。#group/${group.id}`;
            }
          }
        } else if (/群|材料.*分析|进展/.test(message) || payload.currentMaterials.length) {
          if (!called.includes("list_groups")) { name = "list_groups"; args = {}; }
          else {
            const group = toolReply(body, "list_groups").groups.find((group) => !group.archived);
            if (!group) reply = "还没有协作群，请先创建群并选择已就绪的成员。";
            else if (/交给|转交|派|让.*(?:分析|完成|整理)|共同/.test(message)) {
              if (!called.includes("assign_group_task")) { name = "assign_group_task"; args = { groupId: group.id, message: "分析本轮明确分享的研究材料，核对关键事实、风险和待办，保存报告并整合交付。", attachmentIds: payload.currentMaterials.map((value) => value.id), userRequest: message }; }
              else reply = `任务已交给${group.name}，成员会自主认领、读取实际材料并提交成果。#group/${group.id}`;
            } else if (!called.includes("get_group")) { name = "get_group"; args = { groupId: group.id }; }
            else {
              const groupView = toolReply(body, "get_group"), task = groupView.tasks.at(-1);
              if (task && !called.includes("read_group_task")) { name = "read_group_task"; args = { groupId: group.id, taskId: task.id }; }
              else if (task) { const detail = toolReply(body, "read_group_task").task; reply = `${group.name}：${detail.status === "completed" ? "已完成" : detail.status}\n${detail.result || "成员仍在处理，右侧显示实际状态。"}\n#group/${group.id}`; }
              else reply = `${group.name}尚未开始任务。#group/${group.id}`;
            }
          }
        } else reply = "日常对话继续。你可以在这里交代工作、创建智能体，或查看群任务的实际进展。";
      } else if (names.includes("submit_group_route")) {
        role = "routing"; name = "submit_group_route"; args = { mode: "default" };
      } else if (names.includes("submit_group_intent")) {
        role = "intent"; const owner = payload.members[0].id;
        name = "submit_group_intent"; args = { participate: true, contribution: `${payload.memberId} 自愿核对共享材料并提交实际文本报告`, willingToIntegrate: payload.memberId === owner, integratorId: owner };
      } else if (names.includes("submit_group_turn")) {
        role = payload.kind;
        if (/慢速|停止测试/.test(payload.goal || "")) { slow = true; reply = `${payload.memberId} 正在进行群任务停止测试，尚未提交结果。`; }
        else if (role === "integration") {
          const artifacts = payload.tasks.flatMap((child) => child.artifactIds ?? []), count = called.filter((value) => value === "read_group_artifact").length;
          if (count < artifacts.length) { name = "read_group_artifact"; args = { id: artifacts[count] }; }
          else { name = "submit_group_turn"; args = { status: "complete", result: `已核对并整合 ${artifacts.length} 份成员真实文件。\n${artifacts.map((_id, index) => toolReply(body, "read_group_artifact", index).content).join("\n").slice(0, 9000)}`, artifactIds: artifacts }; }
        } else {
          const materials = called.includes("list_group_materials") ? toolReply(body, "list_group_materials").attachments : [];
          if (!called.includes("list_group_materials")) { name = "list_group_materials"; args = {}; }
          else if (materials.length && !called.includes("read_group_material")) { name = "read_group_material"; args = { id: materials[0].id, offset: 0 }; }
          else if (!called.includes("write_workspace_file")) {
            const material = materials.length ? toolReply(body, "read_group_material") : null;
            const source = material?.text || material?.content || "未分享材料，仅可依据本轮用户目标；需要原始事实时应补充材料。";
            name = "write_workspace_file"; args = { file: `${payload.memberId}-report.md`, content: `# ${payload.memberId} 的研究报告\n\n依据真实共享材料：\n${String(source).slice(0, 3000)}\n\n核对结论：保留已知事实，明确现存风险，并按资料列出下一步核对任务。\n` };
          } else if (!called.includes("publish_group_artifact")) { assert.equal(toolReply(body, "write_workspace_file").saved, true); name = "publish_group_artifact"; args = { path: `${payload.memberId}-report.md` }; }
          else { const artifact = toolReply(body, "publish_group_artifact"); name = "submit_group_turn"; args = { status: "complete", result: `${payload.memberId} 已读取共享材料，完成核对并发布真实报告文件。`, artifactIds: [artifact.id] }; }
        }
      } else {
        const task = payload.raw || "用户任务";
        if (/慢速|停止/.test(task)) { slow = true; reply = "正在进行智能体停止测试，点击停止即可中断本轮。"; }
        else reply = "已依据你本轮提供的材料完成整理；缺失信息会明确标注。";
      }
      const record = { role, tool: name, memberId: payload.memberId, message: payload.currentUserMessage }; records.push(record);
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      const sequence = ++serial, chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: `fixture-${sequence}`,
        object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (name) { chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${sequence}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }); chunk({}, "tool_calls"); }
      else if (slow) {
        activeStreams.add(response); chunk({ role: "assistant", content: reply }); let count = 0;
        const timer = setInterval(() => { if (++count === 60) { clearInterval(timer); chunk({}, "stop"); response.end("data: [DONE]\n\n"); } else chunk({ content: `\n进展 ${count}：仍在逐段输出，尚未完成。` }); }, 500);
        response.once("close", () => { clearInterval(timer); activeStreams.delete(response); }); return;
      } else { chunk({ role: "assistant", content: reply }); chunk({}, "stop"); }
      response.end("data: [DONE]\n\n");
    } catch (error) {
      errors.push({ message: error.message, stack: error.stack });
      if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "本机模拟模型协议失败" } }));
    }
  });
  try {
    await listen(model, 0);
    const config = { llmConfigured: true, jevConfigured: false, model: "fixture-model", apiKey: "fixture-only", chatUrl: `http://127.0.0.1:${model.address().port}/v1/chat/completions` };
    agents = new PrototypeAgents({ config, cwd: root, dataDir, sessionFactory: createPiSession });
    for (const [id, name] of [["researcher", "资料研究员"], ["reviewer", "内容核对员"]]) {
      const draft = validDraft("核对用户本轮明确分享的事实、风险和待办，并保存文本报告"); draft.name = { value: name, source: "user" };
      const built = await agents.build({ id, name, draft }); assert.equal(built.agent?.status, "ready", JSON.stringify(built.architecture));
    }
    collaboration = new CollaborationService({ dataDir, agents });
    main = new MainAgent({ config, dataDir, agents, collaboration, sessionFactory: createPiSession });
    handler = createRequestHandler({ config, dataDir, envPath: join(root, "fixture.env"), port, prototypeAgents: agents, collaboration, mainAgent: main });
    await handler.ready; server = createServer(handler); await listen(server, port);
    const url = `http://127.0.0.1:${server.address().port}`, health = await fetch(`${url}/api/health`);
    assert.equal(health.status, 200); assert.equal((await health.json()).llmConfigured, true);
    return { url, root, dataDir, materialPath, agents, main, collaboration, records, errors, close };
  } catch (error) { await close(); throw error; }
}

async function selfCheck(fixture) {
  const json = async (path, body) => {
    const response = await fetch(fixture.url + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.ok, true, JSON.stringify(value)); return value;
  };
  const prompt = async (id, message, mutationId, attachmentIds) => {
    const response = await fetch(`${fixture.url}/api/main/conversations/${id}/messages`, { method: "POST", headers: { "content-type": "application/json", accept: "application/x-ndjson" }, body: JSON.stringify({ message, mutationId, ...(attachmentIds ? { attachmentIds } : {}) }) });
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.some((event) => event.type === "error"), false, JSON.stringify(events)); return events.find((event) => event.type === "done").result;
  };
  const { conversation } = await json("/api/main/conversations", { mutationId: "self_check_create" }), id = conversation.id;
  const initial = await prompt(id, "帮我创建一个研究 Agent", "self_check_requirements"); assert.equal(initial.context.status, "needs_input");
  const ready = await prompt(id, "我会提供文字研究资料，帮我提炼关键事实、风险和待办，输出中文研究报告；只处理我提供的材料，缺失信息要标注。", "self_check_clarify"); assert.equal(ready.context.status, "ready");
  const confirmed = await prompt(id, "确认需求", "self_check_confirm"); assert.equal(confirmed.context.confirmed, true);
  const record = confirmed.context.requirement, built = await json("/api/agents/build", { id: record.id, name: record.name, draft: record.draft }); assert.equal(built.agent.status, "ready"); assert.equal(built.architecture.design.profile, "light");
  const created = await prompt(id, "帮我创建一个研究组", "self_check_group");
  const groupId = created.sources.find((source) => source.type === "group" && source.operation === "created")?.groupId;
  assert.ok(groupId); const { group } = await json(`/api/groups/${groupId}`);
  const upload = await fetch(`${fixture.url}/api/main/conversations/${id}/materials`, { method: "POST", headers: { "content-type": "text/plain", "x-file-name": encodeURIComponent("研究资料.txt") }, body: await readFile(fixture.materialPath) });
  const { attachment } = await upload.json(); assert.equal(upload.ok, true);
  const assigned = await prompt(id, "把这份材料交给研究组分析", "self_check_assign", [attachment.id]); assert.equal(assigned.context.groupId, group.id);
  await fixture.collaboration.idle(group.id);
  const detail = await json(`/api/groups/${group.id}`); assert.equal(detail.tasks[0].status, "completed", JSON.stringify(detail.tasks[0])); assert.equal(detail.artifacts.length, 2); assert.equal(detail.materials.length, 1);
  for (const artifact of detail.artifacts) { const value = await json(`/api/groups/${group.id}/artifacts/${artifact.id}`); assert.match(value.content, /本周完成原型开发/); }
  const summary = await prompt(id, "看看研究组任务进展", "self_check_progress"); assert.equal(summary.context.taskId, detail.tasks[0].id); assert.match(summary.reply, /已完成/);
  const ordinary = await prompt(id, "现在日常聊一句", "self_check_ordinary"); assert.equal(ordinary.context, null); assert.match(ordinary.reply, /日常对话继续/);
  const slowing = await fetch(`${fixture.url}/api/main/conversations/${id}/messages`, { method: "POST", headers: { "content-type": "application/json", accept: "application/x-ndjson" },
    body: JSON.stringify({ message: "慢速输出，测试停止", mutationId: "self_check_stop" }) });
  const reader = slowing.body.getReader(), decoder = new TextDecoder(); let buffer = "";
  while (!buffer.includes('"type":"text-delta"')) { const part = await reader.read(); assert.equal(part.done, false); buffer += decoder.decode(part.value, { stream: true }); }
  const stopped = await json(`/api/main/conversations/${id}/cancel`, {}); assert.equal(stopped.cancelled, true);
  await reader.cancel();
  const restored = (await json(`/api/main/conversations/${id}`)).conversation; assert.equal(restored.messages.at(-1).status, "cancelled");
  assert.equal(fixture.main.active.size, 0);
  assert.deepEqual(fixture.errors, []);
  return { mainMessages: restored.messages.length, mainStop: restored.messages.at(-1).status, requirementId: record.id, groupId: group.id, taskStatus: detail.tasks[0].status, artifacts: detail.artifacts.length,
    models: fixture.records.reduce((counts, record) => ({ ...counts, [record.role]: (counts[record.role] ?? 0) + 1 }), {}), mocked: "仅本机模型HTTP响应；SDK、需求/架构/Agent/群控制器及存储均真实" };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const checking = process.argv.includes("--self-check"), fixture = await startUnifiedWorkspaceFixture({ port: checking ? 0 : 4372 });
  if (checking) { try { console.log(JSON.stringify({ result: "PASS", ...await selfCheck(fixture) }, null, 2)); } finally { await fixture.close(); } }
  else {
    console.log(JSON.stringify({ status: "READY", health: 200, url: fixture.url, dataDir: fixture.dataDir, materialPath: fixture.materialPath,
      mocked: "仅本机模型HTTP响应；SDK与全部业务控制器真实", prompts: ["帮我创建一个研究 Agent", "我会提供文字研究资料，帮我提炼关键事实、风险和待办，输出中文研究报告；只处理我提供的材料，缺失信息要标注。", "确认需求", "帮我创建一个研究组", "把这份材料交给研究组分析", "看看研究组任务进展", "现在日常聊一句", "慢速输出，测试停止"] }, null, 2));
    let stopping = false; const stop = async () => { if (stopping) return; stopping = true; await fixture.close(); process.exit(0); };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
  }
}
