import { objectFields } from "../../src/runtime/type-boundary.mjs";
import { fixtureJsonObject, fixtureRequirements, fixtureString, fixtureChatRequest, type FixtureChatRequest } from "../helpers/http-model.mjs";
import { fixtureTools, recordArray, listeningAddress } from "../helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PrototypeAgents } from "../../src/agents/agent-prototype.mjs";
import { CollaborationService } from "../../src/collaboration/groups.mjs";
import { MainAgent } from "../../src/main/main-agent.mjs";
import { createPiSession } from "../../src/runtime/pi-runtime.mjs";
import { validDraft, validDesign, passingReview } from "../helpers/architecture.mjs";
import type { PiSessionOptions } from "../../src/runtime/pi-port.mjs";
import type { NeumaPiSession } from "../../src/runtime/pi-port.mjs";

const PRIVATE_MEMORY = "FIXTURE_PRIVATE_MEMORY_DO_NOT_SHARE";
const PRIVATE_MATERIAL = "FIXTURE_PRIVATE_MATERIAL_DO_NOT_SHARE";
const PRIVATE_FILE = "FIXTURE_PRIVATE_FILE_DO_NOT_SHARE";
const USER_TASK = "把整理共享报告的任务交给研究组";
const textOf = (content: string|{ [key: string]: unknown; text?: string; }[]|null|undefined) => typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("");
const FILE_CAPABILITIES = ["conversation", "list_workspace_files", "read_workspace_file", "write_workspace_file"]
  .map((id) => ({ id, status: "available", reason: "仅处理用户文本并读写自己的授权工作目录" }));

function buildSessions() {
  return async ({ customTools }: PiSessionOptions) => {
    const tools = fixtureTools(customTools);
    return { messages: [], subscribe() { return () => {}; },
      async prompt(value: string) {
        const payload = fixtureJsonObject(value);
        if (tools.submit_architecture) await tools.submit_architecture.execute("design", validDesign(fixtureRequirements(payload.requirements), {
          capabilities: FILE_CAPABILITIES, instructions: "处理本轮明确提供的事实，保存可核对的文本成果；不能读取未经分享的私人材料。",
        }));
        else await tools.submit_architecture_review!.execute("review", passingReview(fixtureString(payload.candidateHash)));
      }, async abort() {}, dispose() {},
    };
  };
}

interface GroupMessage { id?: string; content: string; sender: { type: string; id?: string }; visibility?: string }
interface GroupPayload { kind?: string; memberId?: string; goal?: string; workDirectory?: string; currentUserMessage?: string; conversationId?: string;
  triggeringMessage?: GroupMessage | null; requestedRecipientIds?: string[]; replyRouting?: {sourceMessageId?:string}; replyRequest?: {recipientId?:string};
  members?: { id: string; capabilitySchemaVersion?: unknown; capabilityVersion?: unknown; capabilities?: { id: string; availability?: string }[]; hardBoundaries?: unknown[] }[];
  recentMessages?: GroupMessage[]; tasks?: {status:string;artifactIds:string[]}[] }
interface GroupRequest { role: string; body: FixtureChatRequest; payload: GroupPayload; names: string[] }
function checkedGroupPayload(value: unknown): GroupPayload {
  const fields = objectFields(value);
  for (const key of ["kind","memberId","goal","workDirectory","currentUserMessage","conversationId"]) if(fields[key] !== undefined) assert.equal(typeof fields[key], "string");
  const strings = (value: unknown) => { assert.ok(Array.isArray(value) && value.every(item => typeof item === "string")); };
  const message = (value: unknown) => { const row = objectFields(value); assert.equal(typeof row.content,"string"); assert.equal(typeof objectFields(row.sender).type,"string"); for(const key of ["id","visibility"]) if(row[key] !== undefined) assert.equal(typeof row[key],"string"); if(objectFields(row.sender).id !== undefined) assert.equal(typeof objectFields(row.sender).id,"string"); };
  if(fields.triggeringMessage != null) message(fields.triggeringMessage);
  if(fields.recentMessages !== undefined) recordArray(fields.recentMessages).forEach(message);
  if(fields.requestedRecipientIds !== undefined) strings(fields.requestedRecipientIds);
  for(const [name, key] of [["replyRouting","sourceMessageId"],["replyRequest","recipientId"]] as const) if(fields[name] !== undefined && objectFields(fields[name])[key] !== undefined) assert.equal(typeof objectFields(fields[name])[key],"string");
  if(fields.members !== undefined) for(const row of recordArray(fields.members)) { assert.equal(typeof row.id,"string"); if(row.capabilities !== undefined) for(const item of recordArray(row.capabilities)){ assert.equal(typeof item.id,"string"); if(item.availability !== undefined) assert.equal(typeof item.availability,"string"); } if(row.hardBoundaries !== undefined) assert.ok(Array.isArray(row.hardBoundaries)); }
  if(fields.tasks !== undefined) for(const row of recordArray(fields.tasks)){assert.equal(typeof row.status,"string");strings(row.artifactIds);}
  return fields as GroupPayload;
}

function groupPayload(body: FixtureChatRequest) {
  const user = textOf(body.messages.find((message: { role: string; }) => message.role === "user")!.content);
  const marker = "本轮协作任务与消息（资料）：\n";
  const position = user.indexOf(marker);
  assert.ok(position >= 0, "真实群运行请求必须包含平台核实的资料入口");
  return checkedGroupPayload(fixtureJsonObject(user.slice(position + marker.length)));
}

function toolReply(body: FixtureChatRequest, name: string, occurrence = 0) {
  const calls = body.messages.filter((message: { role: string; }) => message.role === "assistant").flatMap((message) => message.tool_calls ?? [])
    .filter((call: { function: { name: string; }; }) => call.function.name === name);
  const call = calls[occurrence]; assert.ok(call, `必须实际调用 ${name}`);
  const reply = body.messages.find((message) => message.role === "tool" && message.tool_call_id === call.id);
  assert.ok(reply, `${name} 的真实工具结果必须进入模型后续请求`);
  return JSON.parse(textOf(reply.content));
}

test("真实 Pi 与本机模拟模型跑通主 Agent 派群、认领、文件分享和整合，私人资料保持隔离", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-groups-sdk-"));
  const dataDir = join(root, "data"), requests: GroupRequest[] = [], toolCalls: {role:string;memberId:string|undefined;name:string;args:unknown}[] = [], errors: unknown[] = [], sessions: { session: NeumaPiSession; cwd: string; tools: string[]; disposed: boolean; }[] = [];
  let agents: PrototypeAgents, collaboration: CollaborationService, main: MainAgent, groupId: string;
  const model = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = fixtureChatRequest(Buffer.concat(chunks).toString("utf8"));
      assert.equal(request.url, "/v1/chat/completions"); assert.equal(request.headers.authorization, "Bearer fixture-only");
      const names = body.tools!.map((tool) => tool.function.name).sort();
      const isMain = names.includes("assign_group_task");
      const payload = isMain ? checkedGroupPayload(fixtureJsonObject(textOf(body.messages.find((message: { role: string; }) => message.role === "user")!.content))) : groupPayload(body);
      const role = isMain ? "main" : names.includes("submit_group_route") ? "routing" : names.includes("submit_group_intent") ? "intent" : payload.kind;
      const called = body.messages.filter((message: { role: string; }) => message.role === "assistant").flatMap((message) => message.tool_calls ?? []).map((call) => call.function.name);
      assert.ok(typeof role === "string"); const record = { role, body, payload, names }; requests.push(record);
      assert.doesNotMatch(JSON.stringify(body.messages), new RegExp(`${PRIVATE_MEMORY}|${PRIVATE_MATERIAL}|${PRIVATE_FILE}`));
      let name, args, reply;
      if (role === "main") {
        assert.equal(payload.currentUserMessage, USER_TASK);
        if (!called.includes("assign_group_task")) {
          name = "assign_group_task"; args = { groupId, message: "整理共同提供的事实：本周完成测试，核对两名成员的成果并汇总。", userRequest: USER_TASK };
        } else {
          const delegated = toolReply(body, "assign_group_task");
          assert.equal(delegated.task.groupId, groupId); reply = "任务已交给研究组，群内成员会继续处理。";
        }
      } else if (role === "routing") {
        assert.deepEqual(names, ["read_group_turn_context", "submit_group_route"], "中立路由只能读取本轮公开上下文并提交受众判断，不能取得成员或业务工具");
        assert.equal(payload.memberId, undefined);
        assert.equal(JSON.stringify(body.messages).includes("处理本轮明确提供的事实，保存可核对的文本成果"), false, "中立路由不能加载承载成员的工作角色指令");
        assert.equal(textOf(body.messages.find((message: { role: string; }) => message.role === "system")?.content).includes("Agent 工作指令"), false);
        const content = payload.triggeringMessage?.content ?? payload.goal;
        name = "submit_group_route";
        args = content === "这个群其他的各位呢，打声招呼" ? { mode: "others" }
          : content === "请大家各自说一下自己能做什么" ? { mode: "all" }
          : ["研究猿 b，你自己介绍一下", "研究猿 b，你来确认一下"].includes(content!) ? { mode: "named", memberIds: ["b"] }
          : content === "那个研究员呢" ? { mode: "clarify", question: "你想问研究员 a 还是研究员 b？" }
          : { mode: "default" };
      } else if (role === "intent") {
        assert.equal(names.includes("write_workspace_file"), false); assert.equal(names.includes("read_material"), false);
        assert.deepEqual(payload.members!.map((member) => member.id).sort(), ["a", "b"]);
        for (const member of payload.members!) {
          assert.equal(member.capabilitySchemaVersion, 1);
          assert.equal(typeof member.capabilityVersion, "string");
          assert.ok(member.capabilities!.some((item) => item.id === "write_workspace_file" && item.availability === "callable"));
          assert.ok(member.hardBoundaries!.length > 0);
        }
        assert.ok(names.includes("read_group_member_capabilities"));
        name = "submit_group_intent";
        if (payload.goal === "你好，介绍一下自己吧") args = { interaction: "conversation", participate: false, contribution: "", willingToIntegrate: false, integratorId: "",
          reply: `你好，我是研究员 ${payload.memberId}，我会帮你核对明确分享的事实。`, replyStatus: "complete" };
        else if (payload.goal === "我刚才请你介绍了什么？") {
          assert.ok(payload.recentMessages!.some((message: { sender: { type: string; }; content: string; }) => message.sender.type === "agent" && /^你好，我是研究员 [ab]，我会帮你核对明确分享的事实。$/.test(message.content)));
          assert.ok(payload.recentMessages!.some((message: { content: string; }) => message.content === "你好，介绍一下自己吧"));
          assert.equal(payload.recentMessages!.some((message: { content: string|string[]; }) => message.content.includes("本周完成测试")), false, "其他群对话的结果不能混入这段对话");
          args = { interaction: "conversation", participate: false, contribution: "", willingToIntegrate: false, integratorId: "",
            reply: "你刚才请我介绍自己，我说我会帮你核对明确分享的事实。", replyStatus: "complete" };
        } else if (payload.goal === "那就把刚才的回答接着说完") {
          assert.ok(payload.recentMessages!.some((message: { sender: { type: string; }; content: string; }) => message.sender.type === "agent" && message.content === "你刚才请我介绍自己，我说我会帮你核对明确分享的事实。"));
          args = { interaction: "conversation", participate: false, contribution: "", willingToIntegrate: false, integratorId: "",
            reply: "我接着说：你分享具体资料后，我会依据那些资料给你可核对的答复。", replyStatus: "complete" };
        }
        else if (payload.goal === "做摘要前，你需要知道哪些要求？") {
          const supplied = payload.recentMessages!.some((message: { content: string; }) => message.content === "不超过100字");
          args = { interaction: "conversation", participate: false, contribution: "", willingToIntegrate: false, integratorId: "",
            reply: supplied ? "好的，我会按不超过100字的要求处理你接下来分享的材料。" : "你希望摘要控制在多少字？", replyStatus: supplied ? "complete" : "needs_input" };
        } else if (payload.goal === "这个群其他的各位呢，打声招呼") {
          const previous = payload.recentMessages!.findLast((message: { sender: { type: string; }; }) => message.sender.type === "agent");
          assert.ok(previous, "其他成员的语义判断必须具有此前真实公开答复");
          args = { interaction: "conversation", participate: false, contribution: "", willingToIntegrate: false, integratorId: "",
            replyAudience: { mode: "members", memberIds: [previous.sender.id] },
            reply: `你好，我是研究员 ${payload.memberId}，我在这里，会自己回答你的问题。`, replyStatus: "complete" };
        } else if (payload.goal === "请大家各自说一下自己能做什么") {
          assert.ok(payload.recentMessages!.some((message: { content: string; }) => message.content === "这个群其他的各位呢，打声招呼"));
          args = { interaction: "conversation", participate: false, contribution: "", willingToIntegrate: false, integratorId: "",
            replyAudience: { mode: "members", memberIds: ["a"] },
            reply: `我是研究员 ${payload.memberId}，我可以核对你明确分享的事实。`, replyStatus: "complete" };
        } else if (payload.goal === "研究猿 b，你自己介绍一下") {
          args = { interaction: "conversation", participate: false, contribution: "", willingToIntegrate: false, integratorId: "",
            replyAudience: { mode: "members", memberIds: ["a"] },
            reply: `我是研究员 ${payload.memberId}，我可以直接和你交流。`, replyStatus: "complete" };
        } else if (payload.goal === "研究猿 b，你来确认一下") {
          if (payload.memberId === "b") {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: { message: "模拟被点名成员暂时无法回复" } }));
            return;
          }
          args = { interaction: "conversation", participate: false, contribution: "", willingToIntegrate: false, integratorId: "",
            replyAudience: { mode: "members", memberIds: ["a"] }, reply: "我可以说话，但这句话没有点名我。", replyStatus: "complete" };
        } else if (payload.goal === "@研究员 a，请引用研究员 b 的答复确认一下") {
          assert.deepEqual(payload.requestedRecipientIds, ["a"]);
          assert.equal(payload.memberId, "a");
          assert.equal(payload.recentMessages!.filter((message: { sender: { type: string; }; content: string; }) => message.sender.type === "agent" && message.content.startsWith("我是研究员")).length, 2);
          args = { interaction: "conversation", participate: false, contribution: "", willingToIntegrate: false, integratorId: "",
            replyAudience: { mode: "members", memberIds: ["a", "b"] }, replyRecipientId: "b",
            reply: "我看到了你的答复，我们都可以核对明确分享的事实。", replyStatus: "complete" };
        } else args = { participate: true, contribution: `${payload.memberId} 核对自己的共享事实`, willingToIntegrate: payload.memberId === "a", integratorId: "a" };
      } else if (role === "work") {
        assert.equal(payload.workDirectory, ".");
        assert.ok(names.includes("write_workspace_file")); assert.equal(names.includes("read_material"), false);
        assert.ok(names.includes("read_group_material"));
        if (!called.includes("list_workspace_files")) { name = "list_workspace_files"; args = {}; }
        else if (!called.includes("list_group_materials")) {
          assert.deepEqual(toolReply(body, "list_workspace_files").files, []);
          name = "list_group_materials"; args = {};
        } else if (!called.includes("write_workspace_file")) {
          assert.deepEqual(toolReply(body, "list_group_materials").attachments, []);
          name = "write_workspace_file"; args = { file: `${payload.memberId}.md`, content: `共享事实 ${payload.memberId}：本周完成测试。\n` };
        } else if (!called.includes("publish_group_artifact")) {
          assert.equal(toolReply(body, "write_workspace_file").saved, true);
          name = "publish_group_artifact"; args = { path: `${payload.memberId}.md` };
        } else {
          const artifact = toolReply(body, "publish_group_artifact"); assert.equal(artifact.agentId, payload.memberId);
          name = "submit_group_turn"; args = { status: "complete", result: `${payload.memberId} 的事实与文件已核对`, artifactIds: [artifact.id] };
        }
      } else if (role === "integration") {
        assert.equal(payload.memberId, "a"); assert.equal(payload.tasks!.every((child: { status: string; }) => child.status === "completed"), true);
        const artifacts = payload.tasks!.flatMap((child) => child.artifactIds), readCount = called.filter((value: string) => value === "read_group_artifact").length;
        assert.equal(artifacts.length, 2);
        if (readCount < artifacts.length) { name = "read_group_artifact"; args = { id: artifacts[readCount] }; }
        else {
          for (let index = 0; index < artifacts.length; index++) assert.match(toolReply(body, "read_group_artifact", index).content, /共享事实 [ab]：本周完成测试/);
          name = "submit_group_turn"; args = { status: "complete", result: "我已核对两份真实文件并为你汇总：本周完成测试。", artifactIds: artifacts };
        }
      } else assert.fail(`不应发起 ${role} 轮次`);

      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: { role?: string; tool_calls?: { index: number; id: string; type: string; function: { name: string; arguments: string; }; }[]; content?: string|undefined; }, finish_reason: string|null = null) => response.write(`data: ${JSON.stringify({ id: `fixture-${requests.length}`,
        object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (name) {
        toolCalls.push({ role, memberId: payload.memberId, name, args });
        chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
        chunk({}, "tool_calls");
      } else { chunk({ role: "assistant", content: reply }); chunk({}, "stop"); }
      response.end("data: [DONE]\n\n");
    } catch (error) {
      errors.push(error);
      if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "本机模拟模型协议断言失败" } }));
    }
  });
  t.after(async () => {
    await main?.close(); await collaboration?.close(); await agents?.close();
    model.closeAllConnections(); if (model.listening) await new Promise((resolve) => model.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => { model.once("error", reject); model.listen(0, "127.0.0.1", resolve); });
  const config = { llmConfigured: true, model: "fixture-model", apiKey: "fixture-only", chatUrl: `http://127.0.0.1:${listeningAddress(model).port}/v1/chat/completions` };
  agents = new PrototypeAgents({ config, cwd: root, dataDir, sessionFactory: buildSessions() });
  for (const id of ["a", "b"]) {
    const result = await agents.build({ id, name: `研究员 ${id}`, draft: validDraft("核对用户本轮明确分享的事实并保存文本结果") });
    assert.equal(result.agent!.status, "ready"); assert.equal(result.architecture!.delivery, "ready");
  }
  await agents.setMemory("a", PRIVATE_MEMORY);
  await writeFile(join(await agents.workspace("a"), "private-user.txt"), PRIVATE_FILE);
  await agents.uploadAttachment("a", { name: "private-material.txt", mimeType: "text/plain", source: Readable.from([Buffer.from(PRIVATE_MATERIAL)]) });
  const realSessions = async (options: PiSessionOptions) => {
    const session = await createPiSession(options), record = { session, cwd: options.cwd, tools: options.customTools!.map((tool) => tool.name), disposed: false };
    const dispose = session.dispose.bind(session);
    session.dispose = () => { record.disposed = true; dispose(); }; sessions.push(record); return session;
  };
  agents.sessionFactory = realSessions;
  collaboration = new CollaborationService({ dataDir, agents }); await collaboration.ready;
  groupId = (await collaboration.createGroup({ name: "研究组", purpose: "仅核对明确分享的共同事实", memberIds: ["a", "b"], mutationId: "create_fixture_group" })).group.id;
  main = new MainAgent({ config, dataDir, agents, collaboration, sessionFactory: realSessions }); await main.ready;
  const conversationId = (await main.createConversation({ mutationId: "create_main_fixture" })).conversation.id;
  const result = await main.prompt({ conversationId, message: USER_TASK, mutationId: "dispatch_fixture_group" });
  await collaboration.idle(groupId);
  assert.deepEqual<typeof errors>(errors, []);
  assert.equal(result.conversation.messages[1]!.status, "complete");
  assert.equal(result.sources.length, 1); assert.equal(result.sources[0]!.groupId, groupId);
  assert.equal(result.sources[0]!.sourceLink, `#group/${groupId}`);
  const view = await collaboration.getGroup(groupId), task = view.tasks[0];
  assert.equal(task!.status, "completed", task!.reason); assert.equal(task!.ownerId, "a");
  assert.equal(task!.children.length, 2); assert.equal(task!.children.every((child) => child.status === "completed"), true);
  assert.equal(view.messages.find((message) => message.sender.type === "main")!.content.includes("整理共同提供的事实"), true);
  assert.equal(result.sources[0]!.taskId, task!.id); assert.match(task!.result, /我已核对两份真实文件并为你汇总/);
  const publicReplies = view.messages.filter((message) => message.sender.type === "agent");
  assert.equal(publicReplies.length, 1); assert.equal(publicReplies[0]!.kind, "delivery"); assert.equal(publicReplies[0]!.content, task!.result);
  const internal = (await collaboration.store.get(groupId)).messages.filter((message) => message.visibility === "internal");
  assert.equal(internal.filter((message) => message.kind === "negotiation").length, 2);
  assert.equal(internal.filter((message) => message.kind === "member_result").length, 2);
  assert.equal(view.artifacts.length, 2); assert.equal(view.materials.length, 0);
  for (const artifact of view.artifacts) {
    const file = join(dataDir, "agents", artifact.agentId, "workspace", "group-tasks", groupId, task!.id, artifact.agentId, `${artifact.agentId}.md`);
    const actual = await readFile(file, "utf8"); assert.equal(actual, `共享事实 ${artifact.agentId}：本周完成测试。\n`);
    assert.equal((await collaboration.artifact(groupId, artifact.id)).content, actual);
  }
  assert.equal(await readFile(join(await agents.workspace("a"), "private-user.txt"), "utf8"), PRIVATE_FILE);
  assert.equal((await agents.getMemory("a")).memory, PRIVATE_MEMORY);
  const activities = (await agents.activitySnapshot()).activities;
  assert.equal(activities.length, 5 + requests.filter((request) => request.role === "routing").length); assert.equal(activities.every((activity) => activity.status === "complete"), true);
  assert.equal(activities.every((activity) => objectFields(activity.scope).groupId === groupId && objectFields(activity.scope).taskId === task!.id), true);
  assert.equal(agents.collaborationSessions.size, 0); assert.equal(main.active.size, 0);
  assert.equal(sessions.length, 6 + requests.filter((request) => request.role === "routing").length); assert.equal(sessions.every((session) => session.disposed), true);
  assert.equal(sessions.filter((session) => session.tools.includes("write_workspace_file")).every((session) => session.cwd.includes(join("group-tasks", groupId, task!.id))), true);
  assert.equal(toolCalls.filter((call) => call.name === "submit_group_intent").length, 2);
  assert.equal(toolCalls.filter((call) => call.name === "publish_group_artifact").length, 2);
  assert.equal(toolCalls.filter((call) => call.name === "read_group_artifact").length, 2);
  const saved = JSON.parse(await readFile(join(dataDir, "main", "conversations", `${conversationId}.json`), "utf8"));
  assert.equal(saved.messages[1].sources[0].taskId, task!.id);

  const greeting = await collaboration.postMessage(groupId, { content: "你好，介绍一下自己吧", mutationId: "sdk-greeting" }); await collaboration.idle(groupId);
  let conversation = (await collaboration.getGroup(groupId)).tasks.find((task) => task.id === greeting.task!.id);
  assert.equal(conversation!.status, "completed"); assert.equal(conversation!.phase, "conversation"); assert.equal(conversation!.ownerId, conversation!.participants[0]!.id);
  assert.deepEqual<NonNullable<NonNullable<typeof conversation>>["children"]>(conversation!.children, []); assert.deepEqual<NonNullable<NonNullable<typeof conversation>>["jobs"]>(conversation!.jobs, []); assert.equal(conversation!.negotiationRound, 1);
  let replies = (await collaboration.getGroup(groupId)).messages.filter((message) => message.taskId === conversation!.id && message.sender.type === "agent");
  assert.equal(replies.length, 1); assert.equal(replies[0]!.kind, "reply"); assert.equal(replies[0]!.sender.id, conversation!.ownerId); assert.equal(replies[0]!.content, `你好，我是研究员 ${conversation!.ownerId}，我会帮你核对明确分享的事实。`);
  assert.equal(requests.filter((request) => request.payload.goal === "你好，介绍一下自己吧" && request.role === "intent").length, 2);
  assert.equal(requests.filter((request) => request.payload.goal === "你好，介绍一下自己吧").every((request) => ["routing", "intent"].includes(request.role) && !request.names.includes("write_workspace_file")), true);

  const originalGreeting = structuredClone(conversation);
  const secondInput = { content: "我刚才请你介绍了什么？", taskId: greeting.task!.id, mutationId: "sdk-continuous-second" };
  const second = await collaboration.postMessage(groupId, secondInput); await collaboration.idle(groupId);
  assert.deepEqual<typeof errors>(errors, []);
  const replaySecond = await collaboration.postMessage(groupId, secondInput); assert.equal(replaySecond.message!.id, second.message!.id);
  const third = await collaboration.postMessage(groupId, { content: "那就把刚才的回答接着说完", taskId: greeting.task!.id, mutationId: "sdk-continuous-third" }); await collaboration.idle(groupId);
  const continuous = (await collaboration.getGroup(groupId)).tasks.filter((task) => task.conversationId === greeting.task!.id);
  assert.equal(continuous.length, 3); assert.equal(new Set(continuous.map((task) => task.id)).size, 3);
  assert.deepEqual(continuous.map((task) => task.status), ["completed", "completed", "completed"]);
  assert.deepEqual(continuous[0], originalGreeting, "真实 SDK 连续执行不能重新打开或改写前一轮终态");
  assert.equal(continuous[1]!.id, second.task!.id); assert.equal(continuous[2]!.id, third.task!.id);
  assert.equal(continuous[2]!.result, "我接着说：你分享具体资料后，我会依据那些资料给你可核对的答复。");
  const conversationRequests = requests.filter((request) => request.payload.conversationId === greeting.task!.id);
  assert.equal(conversationRequests.filter((request) => request.role === "intent").length, 6); assert.equal(conversationRequests.every((request) => ["routing", "intent"].includes(request.role) && !request.names.includes("write_workspace_file")), true);

  const question = await collaboration.postMessage(groupId, { content: "做摘要前，你需要知道哪些要求？", mutationId: "sdk-conversation-question" }); await collaboration.idle(groupId);
  assert.notEqual(question.task!.conversationId, greeting.task!.id);
  conversation = (await collaboration.getGroup(groupId)).tasks.find((task) => task.id === question.task!.id);
  assert.equal(conversation!.status, "needs_input"); assert.equal(conversation!.ownerId, conversation!.participants[0]!.id); assert.equal(conversation!.result, "你希望摘要控制在多少字？");
  await collaboration.postMessage(groupId, { content: "不超过100字", taskId: question.task!.id, mutationId: "sdk-conversation-answer" }); await collaboration.idle(groupId);
  conversation = (await collaboration.getGroup(groupId)).tasks.find((task) => task.id === question.task!.id);
  assert.equal(conversation!.status, "completed"); assert.deepEqual<NonNullable<NonNullable<typeof conversation>>["children"]>(conversation!.children, []); assert.deepEqual<NonNullable<NonNullable<typeof conversation>>["jobs"]>(conversation!.jobs, []);
  replies = (await collaboration.getGroup(groupId)).messages.filter((message) => message.taskId === conversation!.id && message.sender.type === "agent");
  assert.deepEqual(replies.map((reply) => reply.kind), ["clarification", "reply"]); assert.match(replies.at(-1)!.content, /^好的，我会按不超过100字/);
  assert.equal(requests.filter((request) => request.payload.goal === "做摘要前，你需要知道哪些要求？" && request.role === "intent").length, 4);
  assert.equal(requests.filter((request) => request.payload.goal === "做摘要前，你需要知道哪些要求？").every((request) => ["routing", "intent"].includes(request.role)), true);

  const others = await collaboration.postMessage(groupId, { content: "这个群其他的各位呢，打声招呼", taskId: third.task!.id, mutationId: "sdk-conversation-others" }); await collaboration.idle(groupId);
  let audienceView = await collaboration.getGroup(groupId), audienceTask = audienceView.tasks.find((task) => task.id === others.task!.id);
  let audienceReplies = audienceView.messages.filter((message) => message.taskId === audienceTask!.id && message.sender.type === "agent");
  const otherMemberId = audienceTask!.participants.find((member) => member.id !== originalGreeting!.ownerId)!.id;
  assert.equal(audienceTask!.conversationId, greeting.task!.id); assert.equal(audienceTask!.status, "completed");
  assert.deepEqual(audienceTask!.replyAudience!.memberIds, [otherMemberId]);
  assert.deepEqual(audienceReplies.map((message) => message.sender.id), [otherMemberId]);
  assert.equal(audienceReplies[0]!.content, `你好，我是研究员 ${otherMemberId}，我在这里，会自己回答你的问题。`);

  const everyone = await collaboration.postMessage(groupId, { content: "请大家各自说一下自己能做什么", taskId: others.task!.id, mutationId: "sdk-conversation-everyone" }); await collaboration.idle(groupId);
  audienceView = await collaboration.getGroup(groupId); audienceTask = audienceView.tasks.find((task) => task.id === everyone.task!.id);
  audienceReplies = audienceView.messages.filter((message) => message.taskId === audienceTask!.id && message.sender.type === "agent");
  assert.equal(audienceTask!.status, "completed"); assert.deepEqual(audienceReplies.map((message) => message.sender.id).sort(), ["a", "b"]);
  for (const message of audienceReplies) assert.equal(message.content, `我是研究员 ${message.sender.id}，我可以核对你明确分享的事实。`);
  assert.equal(audienceReplies.every((message) => message.visibility === "public" && message.kind === "reply"), true);
  assert.deepEqual<NonNullable<NonNullable<typeof audienceTask>>["children"]>(audienceTask!.children, []); assert.deepEqual<NonNullable<NonNullable<typeof audienceTask>>["jobs"]>(audienceTask!.jobs, []);

  const reference = await collaboration.postMessage(groupId, { content: "@研究员 a，请引用研究员 b 的答复确认一下", taskId: everyone.task!.id, mutationId: "sdk-conversation-reference" }); await collaboration.idle(groupId);
  audienceView = await collaboration.getGroup(groupId); audienceTask = audienceView.tasks.find((task) => task.id === reference.task!.id);
  audienceReplies = audienceView.messages.filter((message) => message.taskId === audienceTask!.id && message.sender.type === "agent");
  assert.equal(audienceTask!.status, "completed"); assert.deepEqual(audienceTask!.replyAudience, { mode: "single", memberIds: ["a"] });
  assert.deepEqual(audienceTask!.requestedRecipientIds, ["a"]); assert.deepEqual(reference.message!.mentionIds, ["a"]);
  assert.equal(audienceReplies.length, 1); assert.equal(audienceReplies[0]!.sender.id, "a"); assert.equal(audienceReplies[0]!.recipientId, "b");
  assert.equal(audienceReplies[0]!.content, "我看到了你的答复，我们都可以核对明确分享的事实。");
  const audienceRequests = requests.filter((request) => ["这个群其他的各位呢，打声招呼", "请大家各自说一下自己能做什么", "@研究员 a，请引用研究员 b 的答复确认一下"].includes((request.payload.triggeringMessage?.content ?? request.payload.goal)!));
  assert.equal(audienceRequests.filter((request) => request.role === "intent").length, 4);
  assert.equal(audienceRequests.filter((request) => request.role === "routing").length, 2);
  assert.equal(audienceRequests.every((request) => ["routing", "intent"].includes(request.role) && !request.names.includes("write_workspace_file")), true);

  const natural = await collaboration.postMessage(groupId, { content: "研究猿 b，你自己介绍一下", taskId: reference.task!.id, mutationId: "sdk-conversation-natural-name" }); await collaboration.idle(groupId);
  audienceView = await collaboration.getGroup(groupId); audienceTask = audienceView.tasks.find((task) => task.id === natural.task!.id);
  audienceReplies = audienceView.messages.filter((message) => message.taskId === audienceTask!.id && message.sender.type === "agent");
  assert.equal(audienceTask!.status, "completed"); assert.deepEqual(audienceTask!.replyAudience!.memberIds, ["b"]);
  assert.equal(audienceReplies.length, 1); assert.equal(audienceReplies[0]!.sender.id, "b");
  assert.equal(audienceReplies[0]!.content, "我是研究员 b，我可以直接和你交流。");

  const unavailable = await collaboration.postMessage(groupId, { content: "研究猿 b，你来确认一下", taskId: natural.task!.id, mutationId: "sdk-conversation-named-failure" }); await collaboration.idle(groupId);
  audienceView = await collaboration.getGroup(groupId); audienceTask = audienceView.tasks.find((task) => task.id === unavailable.task!.id);
  audienceReplies = audienceView.messages.filter((message) => message.taskId === audienceTask!.id && message.sender.type === "agent");
  assert.ok(["needs_input", "failed"].includes(audienceTask!.status), audienceTask!.status);
  assert.deepEqual<typeof audienceReplies>(audienceReplies, [], "被点名成员失败时，其他成员的可用答复也不能冒名替代");
  assert.equal(audienceView.messages.some((message) => message.taskId === audienceTask!.id && message.sender.type === "system" && /研究员 b/.test(message.content)), true);
  assert.equal(requests.some((request) => request.role === "intent" && request.payload.goal === "研究猿 b，你来确认一下" && request.payload.memberId === "a"), false, "非目标成员不能被调用来判断、认领或代答");

  const ambiguous = await collaboration.postMessage(groupId, { content: "那个研究员呢", newTask: true, mutationId: "sdk-conversation-ambiguous-name" }); await collaboration.idle(groupId);
  audienceView = await collaboration.getGroup(groupId); audienceTask = audienceView.tasks.find((task) => task.id === ambiguous.task!.id);
  assert.equal(audienceTask!.status, "needs_input");
  assert.equal(audienceView.messages.some((message) => message.taskId === audienceTask!.id && message.content === "你想问研究员 a 还是研究员 b？"), true);
  assert.equal(requests.some((request) => request.role === "intent" && request.payload.goal === "那个研究员呢"), false, "收件人不明时先澄清，不能替对方选人执行");
  assert.equal(sessions.every((session) => session.disposed), true);
  assert.deepEqual<typeof errors>(errors, []);
});

test("真实 Pi 协议将公开接话交给被请求成员，只读回应并限制接力，普通提及和后台分工不唤起", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-group-public-reply-sdk-"));
  const dataDir = join(root, "data"), requests: GroupRequest[] = [], errors: unknown[] = [], sessions: { tools: string[]; disposed: boolean; }[] = [];
  const scenarios: { reference:string;confirmation:string;chain:string;failure:string;declined:string;delivery:string;waiting:string;[key:string]:string } = {
    reference: "只引用伙伴，不请他回答", confirmation: "说明资料交接并请伙伴确认", chain: "请伙伴逐级澄清",
    failure: "请伙伴确认但连接失败", declined: "请伙伴说明自己是否能回答", delivery: "核对这一句并请伙伴确认", waiting: "整理已有资料并等待评分标准",
  };
  let agents: PrototypeAgents, collaboration: CollaborationService, groupId;
  const model = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = fixtureChatRequest(Buffer.concat(chunks).toString("utf8"));
      assert.equal(request.url, "/v1/chat/completions"); assert.equal(request.headers.authorization, "Bearer fixture-only");
      const payload = groupPayload(body), names = body.tools!.map((tool) => tool.function.name).sort();
      const role = names.includes("submit_group_route") ? "routing" : names.includes("submit_group_intent") ? "intent" : payload.kind;
      const called = body.messages.filter((message: { role: string; }) => message.role === "assistant").flatMap((message) => message.tool_calls ?? []).map((call) => call.function.name);
      assert.ok(typeof role === "string"); requests.push({ role, body, payload, names });
      assert.doesNotMatch(JSON.stringify(body.messages), new RegExp(`${PRIVATE_MEMORY}|${PRIVATE_MATERIAL}|${PRIVATE_FILE}`));
      let name, args;
      if (role === "routing") {
        assert.equal(payload.triggeringMessage!.content, "研究员 b，请你说明交接并让研究员 c 确认");
        assert.deepEqual(names, ["read_group_turn_context", "submit_group_route"]);
        name = "submit_group_route"; args = { mode: "named", memberIds: ["b"] };
      } else if (role === "intent") {
        assert.equal(names.includes("write_workspace_file"), false);
        name = "submit_group_intent";
        if (payload.kind === "update") {
          assert.equal(payload.memberId, "b"); assert.equal(payload.replyRouting!.sourceMessageId, payload.triggeringMessage!.id);
          args = { interaction: "conversation", participate: false, contribution: "", willingToIntegrate: false, integratorId: "",
            reply: "我来说明交接：资料由我整理，请你确认核对范围。", replyRequest: { recipientId: "c", kind: "confirmation" } };
        } else if ([scenarios.delivery, scenarios.waiting].includes(payload.goal!)) args = { participate: payload.memberId === "a", contribution: "INTERNAL_RELAY_NEGOTIATION",
          willingToIntegrate: payload.memberId === "a", integratorId: "a" };
        else {
          assert.equal(payload.memberId, "a", "明确接收者不应被其他成员替答");
          args = { interaction: "conversation", participate: false, contribution: "", willingToIntegrate: false, integratorId: "",
            reply: payload.goal === scenarios.reference ? "我引用你的资料整理能力，这句话无需确认。" : "资料与来源的核对交给你，请确认是否收到。",
            replyStatus: "complete", replyRecipientId: "b",
            ...(payload.goal === scenarios.reference ? {} : { replyRequest: { recipientId: "b", kind: payload.goal === scenarios.chain ? "question" : "confirmation" } }) };
        }
      } else if (role === "work") {
        assert.ok([scenarios.delivery, scenarios.waiting].includes(payload.goal!)); assert.equal(payload.memberId, "a");
        assert.ok(names.includes("write_workspace_file"));
        name = "submit_group_turn"; args = { status: "complete", result: "INTERNAL_RELAY_WORK_RESULT", artifactIds: [],
          ...(!called.includes("submit_group_turn") ? { replyRequest: { recipientId: "c", kind: "confirmation" } } : {}) };
        if (called.includes("submit_group_turn")) {
          const errorReply = body.messages.find((message: { role: string; }) => message.role === "tool"); assert.ok(errorReply);
          assert.doesNotMatch(textOf(errorReply.content), /"submitted"\s*:\s*true/, "后台工作中的公开接话请求必须明确拒绝后重新提交");
        }
      } else if (role === "integration") {
        assert.ok([scenarios.delivery, scenarios.waiting].includes(payload.goal!)); assert.equal(payload.memberId, "a");
        name = "submit_group_turn"; args = payload.goal === scenarios.waiting
          ? { status: "needs_input", result: "现有资料已整理。", reason: "请补充评分标准。" }
          : { status: "complete", result: "我核对了你提供的这句话，结论已经给你。请确认收到。", artifactIds: [], replyRequest: { recipientId: "b", kind: "confirmation" } };
      } else if (role === "public_reply") {
        assert.deepEqual(names, ["read_group_turn_context", "submit_group_reply"], "自动接话不能取得业务、联网或后台协作工具");
        assert.equal(textOf(body.messages.find((message: { role: string; }) => message.role === "system")?.content).includes("Agent 工作指令"), true, "被请求成员仍以自己的身份回应");
        assert.ok(payload.triggeringMessage?.id); assert.equal(payload.triggeringMessage!.sender.type, "agent");
        assert.deepEqual(payload.members!.map((member) => member.id).sort(), ["a", "b", "c"]);
        assert.equal(payload.triggeringMessage!.visibility, "public");
        assert.equal(JSON.stringify(payload).includes("INTERNAL_RELAY_"), false, "公开接话不能读到后台分工或工作结果");
        assert.equal((payload.recentMessages ?? []).every((message) => message.visibility !== "internal"), true);
        assert.equal(payload.replyRequest!.recipientId, payload.memberId);
        if (payload.goal === scenarios.failure) {
          assert.equal(payload.memberId, "b");
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "模拟被请求成员调用失败" } })); return;
        }
        if (!called.includes("read_group_turn_context")) { name = "read_group_turn_context"; args = { section: "triggeringMessage", limit: 8000 }; }
        else {
          const page = toolReply(body, "read_group_turn_context");
          assert.equal(JSON.parse(page.text).id, payload.triggeringMessage!.id);
          name = "submit_group_reply";
          args = payload.goal === scenarios.declined ? { reply: "这项确认超出我目前掌握的信息，我现在无法给出判断。", replyStatus: "declined" }
            : { reply: payload.memberId === "b" ? "收到，资料和来源的核对交给我。" : "我确认了，缺失项会逐条说明。", replyStatus: "complete",
              ...(payload.goal === scenarios.chain ? { replyRequest: { recipientId: payload.memberId === "b" ? "c" : "a", kind: "question" } } : {}) };
        }
      } else assert.fail(`公开接话测试不应发起 ${role} 轮次`);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: { role?: string; tool_calls?: { index: number; id: string; type: string; function: { name: string; arguments: string; }; }[]; }, finish_reason: string|null = null) => response.write(`data: ${JSON.stringify({ id: `relay-fixture-${requests.length}`,
        object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: `relay_call_${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
      chunk({}, "tool_calls"); response.end("data: [DONE]\n\n");
    } catch (error) {
      errors.push(error);
      if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "本机公开接话模型协议断言失败" } }));
    }
  });
  t.after(async () => {
    await collaboration?.close(); await agents?.close();
    model.closeAllConnections(); if (model.listening) await new Promise((resolve) => model.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => { model.once("error", reject); model.listen(0, "127.0.0.1", resolve); });
  const config = { llmConfigured: true, model: "fixture-model", apiKey: "fixture-only", chatUrl: `http://127.0.0.1:${listeningAddress(model).port}/v1/chat/completions` };
  agents = new PrototypeAgents({ config, cwd: root, dataDir, sessionFactory: buildSessions() });
  for (const id of ["a", "b", "c"]) {
    const result = await agents.build({ id, name: `研究员 ${id}`, draft: validDraft("核对本轮明确分享的事实并直接回答") });
    assert.equal(result.agent!.status, "ready");
  }
  await agents.setMemory("b", PRIVATE_MEMORY);
  await writeFile(join(await agents.workspace("b"), "private-user.txt"), PRIVATE_FILE);
  await agents.uploadAttachment("b", { name: "private-material.txt", mimeType: "text/plain", source: Readable.from([Buffer.from(PRIVATE_MATERIAL)]) });
  agents.sessionFactory = async (options: PiSessionOptions) => {
    const session = await createPiSession(options), record = { tools: options.customTools!.map((tool) => tool.name), disposed: false };
    const dispose = session.dispose.bind(session); session.dispose = () => { record.disposed = true; dispose(); }; sessions.push(record); return session;
  };
  collaboration = new CollaborationService({ dataDir, agents }); await collaboration.ready;
  groupId = (await collaboration.createGroup({ name: "公开接话协议验收", purpose: "仅验证已发布消息的自动回复", memberIds: ["a", "b", "c"], mutationId: "sdk-public-relay-group" })).group.id;
  const run = async (scenario: string, options = {}) => {
    const start = requests.length;
    const posted = await collaboration.postMessage(groupId, { content: scenarios[scenario], newTask: true, recipientId: "a", mutationId: `sdk-public-relay-${scenario}`, ...options });
    await collaboration.idle(groupId); assert.deepEqual<typeof errors>(errors, []);
    const view = await collaboration.getGroup(groupId), task = view.tasks.find((task) => task.id === posted.task!.id);
    return { task, messages: view.messages.filter((message) => message.taskId === task!.id), calls: requests.slice(start) };
  };
  const reference = await run("reference");
  assert.equal(reference.task!.status, "completed");
  assert.deepEqual(reference.messages.filter((message) => message.sender.type === "agent").map((message) => message.sender.id), ["a"]);
  assert.equal(reference.calls.some((request) => request.role === "public_reply"), false, "头像与名称引用不能自行安排新回复");

  const confirmation = await run("confirmation"), confirmationReplies = confirmation.messages.filter((message) => message.sender.type === "agent");
  assert.equal(confirmation.task!.status, "completed"); assert.deepEqual(confirmationReplies.map((message) => message.sender.id), ["a", "b"]);
  assert.deepEqual(confirmationReplies[0]!.replyRequest, { recipientId: "b", kind: "confirmation" });
  assert.equal(confirmationReplies[1]!.replyTo, confirmationReplies[0]!.id); assert.equal(confirmationReplies[1]!.recipientId, "a");
  assert.equal(confirmationReplies[1]!.content, "收到，资料和来源的核对交给我。");
  assert.equal(confirmation.calls.filter((request) => request.role === "public_reply" && !request.body.messages.some((message: { role: string; }) => message.role === "tool")).length, 1);
  assert.equal(confirmation.messages.filter((message) => message.sender.type === "user").length, 1, "一条用户消息即可完成成员间交接，不需要补催");
  assert.deepEqual<NonNullable<NonNullable<NonNullable<typeof confirmation>["task"]>>["children"]>(confirmation.task!.children, []); assert.deepEqual<NonNullable<NonNullable<NonNullable<typeof confirmation>["task"]>>["jobs"]>(confirmation.task!.jobs, []);

  const chain = await run("chain"), chainReplies = chain.messages.filter((message) => message.sender.type === "agent");
  assert.equal(chain.task!.status, "partial"); assert.deepEqual(chainReplies.map((message) => message.sender.id), ["a", "b", "c"]);
  assert.equal(chainReplies[2]!.replyTo, chainReplies[1]!.id); assert.equal(chainReplies[2]!.recipientId, "a", "继续向新成员提问时，前缀展示新接收者，回复链仍关联来源消息");
  assert.deepEqual(chain.calls.filter((request) => request.role === "public_reply" && !request.body.messages.some((message: { role: string; }) => message.role === "tool")).map((request) => request.payload.memberId), ["b", "c"], "第二层之后或本链已发言的成员不能被递归唤起");

  const failure = await run("failure");
  assert.equal(failure.task!.status, "partial");
  assert.deepEqual(failure.messages.filter((message) => message.sender.type === "agent").map((message) => message.sender.id), ["a"]);
  assert.equal(failure.messages.some((message) => message.sender.type === "system" && /研究员 b/.test(message.content)), true, "调用失败应如实显示目标，不找其他成员代答");

  const declined = await run("declined"), declinedReplies = declined.messages.filter((message) => message.sender.type === "agent");
  assert.deepEqual(declinedReplies.map((message) => message.sender.id), ["a", "b"]);
  assert.equal(declinedReplies[1]!.content, "这项确认超出我目前掌握的信息，我现在无法给出判断。");
  assert.equal(declined.calls.some((request) => request.role === "work"), false, "无法回答不会自动转为实际工作");

  const delivery = await run("delivery"), deliveryReplies = delivery.messages.filter((message) => message.sender.type === "agent");
  assert.equal(delivery.task!.status, "completed"); assert.deepEqual(deliveryReplies.map((message) => [message.sender.id, message.kind]), [["a", "delivery"], ["b", "reply"]]);
  assert.equal(deliveryReplies[1]!.replyTo, deliveryReplies[0]!.id); assert.equal(deliveryReplies[1]!.recipientId, "a");
  assert.equal(delivery.calls.filter((request) => request.role === "work").length, 2, "工作先收到不允许公开接话的工具错误，再提交普通结果");
  assert.equal(delivery.calls.some((request) => request.role === "public_reply" && request.payload.memberId === "c"), false, "后台工作中的请求不公开派发");
  assert.equal(delivery.calls.filter((request) => request.role === "public_reply").every((request) => !request.names.includes("write_workspace_file")), true, "最终交付中的接话仍不继承工作权限");
  const waiting = await run("waiting"), updateStart = requests.length;
  const update = await collaboration.postMessage(groupId, { content: "研究员 b，请你说明交接并让研究员 c 确认", taskId: waiting.task!.id, mutationId: "sdk-waiting-conversation" });
  await collaboration.idle(groupId); assert.deepEqual<typeof errors>(errors, []);
  const updated = await collaboration.getGroup(groupId), original = updated.tasks.find((value) => value.id === waiting.task!.id);
  const statement = updated.messages.find((value) => value.replyTo === update.message!.id && value.sender.type === "agent");
  assert.equal(statement!.sender.id, "b"); assert.equal(statement!.replyRequestStatus, "completed");
  assert.equal(updated.messages.find((value) => value.replyTo === statement!.id)!.sender.id, "c");
  assert.equal(original!.status, "needs_input"); assert.equal(original!.reason, waiting.task!.reason); assert.equal(original!.result, waiting.task!.result);
  assert.equal(requests.slice(updateStart).some((value) => ["work", "integration"].includes(value.role)), false);
  assert.equal(requests.slice(updateStart).every((value) => !value.names.includes("write_workspace_file")), true);
  assert.equal(sessions.every((session) => session.disposed), true); assert.deepEqual<typeof errors>(errors, []);
});
