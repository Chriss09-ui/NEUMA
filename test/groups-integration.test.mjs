import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PrototypeAgents } from "../src/agents/agent-prototype.mjs";
import { CollaborationService } from "../src/collaboration/groups.mjs";
import { MainAgent } from "../src/main/main-agent.mjs";
import { createPiSession } from "../src/runtime/pi-runtime.mjs";
import { validDraft, validDesign, passingReview } from "./helpers/architecture.mjs";

const PRIVATE_MEMORY = "FIXTURE_PRIVATE_MEMORY_DO_NOT_SHARE";
const PRIVATE_MATERIAL = "FIXTURE_PRIVATE_MATERIAL_DO_NOT_SHARE";
const PRIVATE_FILE = "FIXTURE_PRIVATE_FILE_DO_NOT_SHARE";
const USER_TASK = "把整理共享报告的任务交给研究组";
const textOf = (content) => typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("");
const FILE_CAPABILITIES = ["conversation", "list_workspace_files", "read_workspace_file", "write_workspace_file"]
  .map((id) => ({ id, status: "available", reason: "仅处理用户文本并读写自己的授权工作目录" }));

function buildSessions() {
  return async ({ customTools }) => {
    const tools = Object.fromEntries(customTools.map((tool) => [tool.name, tool]));
    return { messages: [], subscribe() { return () => {}; },
      async prompt(value) {
        const payload = JSON.parse(value);
        if (tools.submit_architecture) await tools.submit_architecture.execute("design", validDesign(payload.requirements, {
          capabilities: FILE_CAPABILITIES, instructions: "处理本轮明确提供的事实，保存可核对的文本成果；不能读取未经分享的私人材料。",
        }));
        else await tools.submit_architecture_review.execute("review", passingReview(payload.candidateHash));
      }, async abort() {}, dispose() {},
    };
  };
}

function groupPayload(body) {
  const user = textOf(body.messages.find((message) => message.role === "user").content);
  const marker = "本轮协作任务与消息（资料）：\n";
  const position = user.indexOf(marker);
  assert.ok(position >= 0, "真实群运行请求必须包含平台核实的资料入口");
  return JSON.parse(user.slice(position + marker.length));
}

function toolReply(body, name, occurrence = 0) {
  const calls = body.messages.filter((message) => message.role === "assistant").flatMap((message) => message.tool_calls ?? [])
    .filter((call) => call.function.name === name);
  const call = calls[occurrence]; assert.ok(call, `必须实际调用 ${name}`);
  const reply = body.messages.find((message) => message.role === "tool" && message.tool_call_id === call.id);
  assert.ok(reply, `${name} 的真实工具结果必须进入模型后续请求`);
  return JSON.parse(textOf(reply.content));
}

test("真实 Pi 与本机模拟模型跑通主 Agent 派群、认领、文件分享和整合，私人资料保持隔离", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-groups-sdk-"));
  const dataDir = join(root, "data"), requests = [], toolCalls = [], errors = [], sessions = [];
  let agents, collaboration, main, groupId;
  const model = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      assert.equal(request.url, "/v1/chat/completions"); assert.equal(request.headers.authorization, "Bearer fixture-only");
      const names = body.tools.map((tool) => tool.function.name).sort();
      const isMain = names.includes("assign_group_task");
      const payload = isMain ? JSON.parse(textOf(body.messages.find((message) => message.role === "user").content)) : groupPayload(body);
      const role = isMain ? "main" : names.includes("submit_group_intent") ? "intent" : payload.kind;
      const called = body.messages.filter((message) => message.role === "assistant").flatMap((message) => message.tool_calls ?? []).map((call) => call.function.name);
      const record = { role, body, payload, names }; requests.push(record);
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
      } else if (role === "intent") {
        assert.equal(names.includes("write_workspace_file"), false); assert.equal(names.includes("read_material"), false);
        assert.deepEqual(payload.members.map((member) => member.id).sort(), ["a", "b"]);
        for (const member of payload.members) {
          assert.equal(member.capabilitySchemaVersion, 1);
          assert.equal(typeof member.capabilityVersion, "string");
          assert.ok(member.capabilities.some((item) => item.id === "write_workspace_file" && item.availability === "callable"));
          assert.ok(member.hardBoundaries.length > 0);
        }
        assert.ok(names.includes("read_group_member_capabilities"));
        name = "submit_group_intent"; args = { participate: true, contribution: `${payload.memberId} 核对自己的共享事实`,
          willingToIntegrate: payload.memberId === "a", integratorId: "a" };
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
        assert.equal(payload.memberId, "a"); assert.equal(payload.tasks.every((child) => child.status === "completed"), true);
        const artifacts = payload.tasks.flatMap((child) => child.artifactIds), readCount = called.filter((value) => value === "read_group_artifact").length;
        assert.equal(artifacts.length, 2);
        if (readCount < artifacts.length) { name = "read_group_artifact"; args = { id: artifacts[readCount] }; }
        else {
          for (let index = 0; index < artifacts.length; index++) assert.match(toolReply(body, "read_group_artifact", index).content, /共享事实 [ab]：本周完成测试/);
          name = "submit_group_turn"; args = { status: "complete", result: "两名成员的真实文件已核对并整合：本周完成测试。", artifactIds: artifacts };
        }
      } else assert.fail(`不应发起 ${role} 轮次`);

      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: `fixture-${requests.length}`,
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
  await new Promise((resolve, reject) => { model.once("error", reject); model.listen(0, "127.0.0.1", resolve); });
  const config = { llmConfigured: true, model: "fixture-model", apiKey: "fixture-only", chatUrl: `http://127.0.0.1:${model.address().port}/v1/chat/completions` };
  agents = new PrototypeAgents({ config, cwd: root, dataDir, sessionFactory: buildSessions() });
  for (const id of ["a", "b"]) {
    const result = await agents.build({ id, name: `研究员 ${id}`, draft: validDraft("核对用户本轮明确分享的事实并保存文本结果") });
    assert.equal(result.agent.status, "ready"); assert.equal(result.architecture.delivery, "ready");
  }
  await agents.setMemory("a", PRIVATE_MEMORY);
  await writeFile(join(await agents.workspace("a"), "private-user.txt"), PRIVATE_FILE);
  await agents.uploadAttachment("a", { name: "private-material.txt", mimeType: "text/plain", source: Readable.from([Buffer.from(PRIVATE_MATERIAL)]) });
  const realSessions = async (options) => {
    const session = await createPiSession(options), record = { session, cwd: options.cwd, tools: options.customTools.map((tool) => tool.name), disposed: false };
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
  assert.deepEqual(errors, []);
  assert.equal(result.conversation.messages[1].status, "complete");
  assert.equal(result.sources.length, 1); assert.equal(result.sources[0].groupId, groupId);
  assert.equal(result.sources[0].sourceLink, `#group/${groupId}`);
  const view = await collaboration.getGroup(groupId), task = view.tasks[0];
  assert.equal(task.status, "completed", task.reason); assert.equal(task.ownerId, "a");
  assert.equal(task.children.length, 2); assert.equal(task.children.every((child) => child.status === "completed"), true);
  assert.equal(view.messages.find((message) => message.sender.type === "main").content.includes("整理共同提供的事实"), true);
  assert.equal(result.sources[0].taskId, task.id); assert.match(task.result, /真实文件已核对并整合/);
  assert.equal(view.artifacts.length, 2); assert.equal(view.materials.length, 0);
  for (const artifact of view.artifacts) {
    const file = join(dataDir, "agents", artifact.agentId, "workspace", "group-tasks", groupId, task.id, artifact.agentId, `${artifact.agentId}.md`);
    const actual = await readFile(file, "utf8"); assert.equal(actual, `共享事实 ${artifact.agentId}：本周完成测试。\n`);
    assert.equal((await collaboration.artifact(groupId, artifact.id)).content, actual);
  }
  assert.equal(await readFile(join(await agents.workspace("a"), "private-user.txt"), "utf8"), PRIVATE_FILE);
  assert.equal((await agents.getMemory("a")).memory, PRIVATE_MEMORY);
  const activities = (await agents.activitySnapshot()).activities;
  assert.equal(activities.length, 5); assert.equal(activities.every((activity) => activity.status === "complete"), true);
  assert.equal(activities.every((activity) => activity.scope.groupId === groupId && activity.scope.taskId === task.id), true);
  assert.equal(agents.collaborationSessions.size, 0); assert.equal(main.active.size, 0);
  assert.equal(sessions.length, 6); assert.equal(sessions.every((session) => session.disposed), true);
  assert.equal(sessions.filter((session) => session.tools.includes("write_workspace_file")).every((session) => session.cwd.includes(join("group-tasks", groupId, task.id))), true);
  assert.equal(toolCalls.filter((call) => call.name === "submit_group_intent").length, 2);
  assert.equal(toolCalls.filter((call) => call.name === "publish_group_artifact").length, 2);
  assert.equal(toolCalls.filter((call) => call.name === "read_group_artifact").length, 2);
  const saved = JSON.parse(await readFile(join(dataDir, "main", "conversations", `${conversationId}.json`), "utf8"));
  assert.equal(saved.messages[1].sources[0].taskId, task.id);
});
