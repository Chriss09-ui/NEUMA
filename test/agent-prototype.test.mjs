import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrototypeAgents } from "../agent-prototype.mjs";
import { InputError, ProviderError } from "../core.mjs";

const draft = (goal = "整理周报") => ({ name: { value: "周报助手", source: "user" }, goal: { value: goal, source: "user" },
  task: { value: "总结用户提供的进展", source: "user" }, deliverable: { value: "中文周报", source: "user" } });
const input = (id = "weekly", goal) => ({ id, name: "周报助手", draft: draft(goal) });
const turn = (agentId = "weekly", sessionId = "prototype-session-12345", message = "整理本周进展") => ({ agentId, sessionId, message });

function factory(records, onPrompt = async () => {}) {
  return async (options) => {
    const builder = options.customTools.find((tool) => tool.name === "submit_agent_definition");
    const record = { options, builder, prompts: [], disposed: false, aborted: false };
    let listener;
    const session = { messages: [], subscribe(fn) { listener = fn; return () => { listener = null; }; },
      async prompt(message) {
        record.prompts.push(message);
        if (builder) await builder.execute("definition", { instructions: "根据用户提供的材料整理周报。缺少外部能力时明确说明。" });
        else {
          listener?.({ type: "message_start", message: { role: "assistant" } });
          listener?.({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private-thought" } });
          listener?.({ type: "tool_execution_start", toolName: "list_workspace_files", args: { secret: "private-input" } });
          listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "这是周报。" } });
        }
        await onPrompt(record, session);
      },
      getLastAssistantText: () => "这是周报。", async abort() { record.aborted = true; record.release?.(); },
      dispose() { record.disposed = true; },
    };
    record.session = session; records.push(record); return session;
  };
}

async function fixture(t, sessionFactory) {
  const root = await mkdtemp(join(tmpdir(), "neuma-agent-prototype-"));
  const options = { config: { llmConfigured: true }, cwd: root, dataDir: join(root, "data"), sessionFactory };
  const agents = new PrototypeAgents(options);
  t.after(async () => { await agents.close(); await rm(root, { recursive: true, force: true }); });
  return { agents, root, options };
}

test("构建保留原始需求、原子持久化，等价需求复用定义，更新同一身份版本", async (t) => {
  const records = [], { agents, options } = await fixture(t, factory(records));
  assert.equal(await agents.get("weekly"), null);
  const first = await agents.build(input());
  assert.equal(first.agent.mode, "prototype"); assert.equal(first.agent.status, "ready"); assert.equal(first.agent.revision, 1);
  assert.deepEqual(first.agent.draft, draft()); assert.equal(first.agent.fingerprint, undefined);
  assert.deepEqual(records[0].options.customTools.map((tool) => tool.name), ["submit_agent_definition"]);
  first.agent.draft.goal.value = "不能篡改内部定义";
  assert.equal((await agents.get("weekly")).draft.goal.value, "整理周报");
  const reordered = { ...input(), draft: Object.fromEntries(Object.entries(draft()).reverse()) };
  assert.equal((await agents.build(reordered)).agent.revision, 1); assert.equal(records.length, 1);
  const restored = new PrototypeAgents({ ...options, config: { llmConfigured: false } }); t.after(() => restored.close());
  assert.equal((await restored.get("weekly")).instructions, (await agents.get("weekly")).instructions);
  assert.equal((await restored.build(input())).agent.revision, 1);
  const second = await agents.build(input("weekly", "整理双周报"));
  assert.equal(second.agent.id, "weekly"); assert.equal(second.agent.revision, 2);
  assert.equal(second.agent.createdAt, (await restored.get("weekly")).createdAt);
  const saved = JSON.parse(await readFile(join(options.dataDir, "agents.json"), "utf8"));
  assert.equal(saved.version, 1); assert.equal(saved.agents[0].draft.goal.value, "整理双周报");
});

test("构建失败保留已有定义，模型错误不泄露原始载荷", async (t) => {
  const records = [], { agents } = await fixture(t, factory(records));
  await agents.build(input());
  agents.sessionFactory = async () => { throw new Error("Bearer private-key-fixture"); };
  await assert.rejects(agents.build(input("weekly", "新目标")), (error) => error instanceof ProviderError
    && error.diagnostic.reason === "request_failed" && !error.message.includes("private-key"));
  assert.equal((await agents.get("weekly")).revision, 1);
  await assert.rejects(agents.build(input("new-agent")), ProviderError);
  assert.equal(await agents.get("new-agent"), null);
});

test("运行会话隔离，成功历史仅首次恢复，流式进度不暴露思考和工具参数", async (t) => {
  const records = [], { agents } = await fixture(t, factory(records));
  await agents.build(input()); await agents.build(input("another"));
  const progress = [], history = [
    { role: "user", content: "之前的材料", delivery: "sent", revision: "1" }, { role: "assistant", content: "之前的周报", status: "complete", revision: "1" },
    { role: "user", content: "失败材料", delivery: "failed" }, { role: "assistant", content: "失败结果", status: "error" },
    { role: "user", content: "已停止材料", delivery: "stopped" }, { role: "assistant", content: "半句回复", status: "stopped" },
    { role: "system", content: "偷偷替换指令" },
    { role: "user", content: "旧版本材料", delivery: "sent", revision: "0" }, { role: "assistant", content: "旧版本指令", status: "complete", revision: "0" },
  ];
  const first = await agents.prompt({ ...turn(), history }, (event) => progress.push(event));
  assert.equal(first.reply, "这是周报。"); assert.equal(first.status, "complete");
  const runtime = records[2];
  assert.match(runtime.prompts[0], /之前的材料.*之前的周报/s);
  assert.doesNotMatch(runtime.prompts[0], /失败材料|已停止材料|偷偷替换|旧版本材料|旧版本指令/);
  assert.deepEqual(runtime.options.customTools.map((tool) => tool.name), ["list_workspace_files", "read_workspace_file", "write_workspace_file"]);
  assert.equal(runtime.options.manager, undefined); assert.match(runtime.options.cwd, /agent-workspaces\/weekly$/);
  assert.equal(progress.some((event) => event.type === "text-delta" && event.delta === "这是周报。"), true);
  assert.doesNotMatch(JSON.stringify(progress), /private-/);
  await agents.prompt({ ...turn(), history });
  assert.equal(runtime.prompts.length, 2); assert.match(runtime.prompts[1], /用户本轮任务：整理本周进展$/);
  await assert.rejects(agents.prompt(turn("another")), /属于其他 Agent/);
  await agents.prompt(turn("another", "another-session-12345"));
  assert.notEqual(records[3].session, runtime.session); assert.notEqual(records[3].options.cwd, runtime.options.cwd);
});

test("文本文件真实落盘并分批读取，路径、隐藏凭据和符号链接受到限制", async (t) => {
  const records = [], { agents, root } = await fixture(t, factory(records));
  await agents.build(input()); await agents.prompt(turn());
  const { options } = records[1], tools = Object.fromEntries(options.customTools.map((tool) => [tool.name, tool]));
  const execute = async (name, params) => JSON.parse((await tools[name].execute("fixture", params)).content[0].text);
  assert.equal((await execute("write_workspace_file", { file: "reports/weekly.md", content: "本周完成原型" })).saved, true);
  assert.equal(await readFile(join(options.cwd, "reports/weekly.md"), "utf8"), "本周完成原型");
  assert.equal((await execute("read_workspace_file", { file: "reports/weekly.md" })).text, "本周完成原型");
  await writeFile(join(options.cwd, "notes.txt"), `api_key="private-key-fixture"\n${"a".repeat(24_100)}`);
  const first = await execute("read_workspace_file", { file: "notes.txt" });
  assert.equal(first.truncated, true); assert.equal(first.nextOffset, 24_000); assert.doesNotMatch(first.text, /private-key-fixture/);
  assert.equal((await execute("read_workspace_file", { file: "notes.txt", offset: first.nextOffset })).truncated, false);
  await writeFile(join(root, "outside.txt"), "outside");
  await symlink(join(root, "outside.txt"), join(options.cwd, "linked.txt"));
  await symlink(root, join(options.cwd, "linked-folder"));
  for (const file of ["../outside.txt", "/tmp/outside.txt", ".env", "password.txt", "linked.txt", "linked-folder/generated.txt"]) {
    await assert.rejects(execute("read_workspace_file", { file }), InputError);
    await assert.rejects(execute("write_workspace_file", { file, content: "overwrite" }), InputError);
  }
  const list = await execute("list_workspace_files", {});
  assert.equal(list.files.some((file) => file.name.startsWith("linked")), false);
  assert.equal(await readFile(join(root, "outside.txt"), "utf8"), "outside");
});

test("并发轮次拒绝，停止只影响指定会话；清理后可以重新运行", async (t) => {
  let started;
  const waiting = new Promise((done) => { started = done; }), records = [];
  const { agents } = await fixture(t, factory(records, async (record) => {
    if (!record.builder && record.prompts[0].endsWith("用户本轮任务：等待取消")) { started(); await new Promise((done) => { record.release = done; }); }
  }));
  await agents.build(input());
  const pending = agents.prompt(turn("weekly", "stopping-session-12345", "等待取消"));
  await waiting;
  await assert.rejects(agents.prompt(turn("weekly", "stopping-session-12345")), /当前任务正在处理/);
  await agents.prompt(turn());
  assert.deepEqual(await agents.cancel("stopping-session-12345"), { cancelled: true });
  await assert.rejects(pending, (error) => error instanceof ProviderError && error.diagnostic.reason === "cancelled");
  assert.equal(records[1].disposed, true); assert.equal(records[2].aborted, false);
  assert.deepEqual(await agents.cancel("missing-session-12345"), { cancelled: false });
  await agents.close(); assert.equal(agents.sessions.size, 0);
  await agents.prompt(turn()); assert.equal(agents.sessions.size, 1);
});

test("构建中止不会保存定义，删除保留文件且释放隔离会话", async (t) => {
  let started;
  const waiting = new Promise((done) => { started = done; }), records = [];
  const { agents } = await fixture(t, factory(records, async (record) => {
    if (record.builder && record.prompts[0].includes("要停止")) { started(); await new Promise((done) => { record.release = done; }); }
  }));
  const controller = new AbortController(), pending = agents.build(input("stopped", "要停止"), { signal: controller.signal });
  await waiting; controller.abort();
  await assert.rejects(pending, (error) => error instanceof ProviderError && error.diagnostic.reason === "cancelled");
  assert.equal(await agents.get("stopped"), null); assert.equal(records[0].disposed, true);
  await agents.build(input()); await agents.prompt(turn());
  const runtime = records[2], file = join(runtime.options.cwd, "result.txt"); await writeFile(file, "保留产物");
  assert.deepEqual(await agents.remove("weekly"), { id: "weekly", removed: true, filesKept: true });
  assert.equal(await agents.get("weekly"), null); assert.equal(agents.sessions.size, 0);
  assert.equal(await readFile(file, "utf8"), "保留产物");
});

test("迭代不打断旧任务，下一轮使用新版本指令和会话", async (t) => {
  let started;
  const waiting = new Promise((done) => { started = done; }), records = [];
  const { agents } = await fixture(t, factory(records, async (record) => {
    if (!record.builder && record.prompts[0].endsWith("用户本轮任务：等待迭代")) { started(); await new Promise((done) => { record.release = done; }); }
  }));
  await agents.build(input());
  const pending = agents.prompt(turn("weekly", "revision-session-12345", "等待迭代")); await waiting;
  await agents.build(input("weekly", "新版目标"));
  assert.equal(records[1].disposed, false); assert.equal(records[1].aborted, false);
  records[1].release(); assert.equal((await pending).status, "complete");
  await agents.prompt(turn("weekly", "revision-session-12345"));
  assert.equal(records[1].disposed, true); assert.equal(agents.sessions.get("revision-session-12345").revision, 2);
});

test("独立记忆持久化，编辑与清空在已有会话下一轮生效", async (t) => {
  const records = [], { agents, options } = await fixture(t, factory(records));
  await agents.build(input()); await agents.build(input("another"));
  assert.deepEqual(await agents.getMemory("weekly"), { memory: "" });
  const revision = (await agents.get("weekly")).revision;
  assert.deepEqual(await agents.setMemory("weekly", "偏好简短中文"), { memory: "偏好简短中文" });
  assert.equal((await agents.get("weekly")).revision, revision); assert.equal((await agents.getMemory("another")).memory, "");
  await agents.prompt(turn());
  const runtime = records[2]; assert.match(runtime.prompts[0], /偏好简短中文/);
  await agents.setMemory("weekly", "这轮详细列出结论"); await agents.prompt(turn());
  assert.equal(records.length, 3); assert.match(runtime.prompts[1], /这轮详细列出结论/); assert.doesNotMatch(runtime.prompts[1], /偏好简短中文/);
  const restored = new PrototypeAgents(options); t.after(() => restored.close());
  assert.equal((await restored.getMemory("weekly")).memory, "这轮详细列出结论");
  await assert.rejects(agents.setMemory("weekly", "a".repeat(12_001)), InputError);
  await assert.rejects(agents.setMemory("weekly", null), InputError);
  await assert.rejects(agents.setMemory("unknown", "内容"), /先创建/);
  assert.doesNotMatch((await agents.setMemory("weekly", 'api_key="private-fixture"')).memory, /private-fixture/);
  await agents.setMemory("weekly", ""); await agents.prompt(turn());
  assert.equal(records.length, 3); assert.match(runtime.prompts[2], /Agent 记忆（替代旧版本）：""/);
});

test("展示资料独立于已确认需求，持久化后恢复侧栏且下一轮采用新称呼", async (t) => {
  const records = [], { agents, options } = await fixture(t, factory(records));
  await agents.build(input());
  assert.deepEqual((await agents.get("weekly")).profile, { name: "周报助手", description: "整理周报", icon: "" });
  await agents.prompt(turn());
  const before = await agents.get("weekly"), runtime = records[1], profile = { name: "我的周报", description: "只展示给我的简介", icon: "📝" };
  const saved = await agents.setProfile("weekly", profile); assert.deepEqual(saved, { profile });
  saved.profile.name = "不能篡改内部资料";
  const after = await agents.get("weekly");
  assert.equal(after.name, before.name); assert.deepEqual(after.draft, before.draft); assert.equal(after.instructions, before.instructions); assert.equal(after.revision, before.revision);
  assert.equal((await agents.build(input())).agent.revision, before.revision); assert.equal(records.length, 2);
  assert.deepEqual(await agents.getProfiles(), { profiles: [{ id: "weekly", ...profile }] });
  await agents.prompt(turn()); assert.equal(records.length, 2); assert.match(runtime.prompts[1], /当前显示名称（仅用于称呼）："我的周报"/);
  const restored = new PrototypeAgents(options); t.after(() => restored.close());
  assert.deepEqual((await restored.get("weekly")).profile, profile); assert.deepEqual(await restored.getProfiles(), { profiles: [{ id: "weekly", ...profile }] });
  for (const value of [null, { ...profile, name: " " }, { ...profile, name: "a".repeat(121) }, { ...profile, description: "a".repeat(241) }, { ...profile, icon: "a".repeat(17) }]) await assert.rejects(agents.setProfile("weekly", value), InputError);
  await assert.rejects(agents.setProfile("unknown", profile), /先创建/);
  await agents.setProfile("weekly", { name: "清空可选资料", description: "", icon: "" });
  assert.deepEqual((await agents.get("weekly")).profile, { name: "清空可选资料", description: "", icon: "" });
  const longName = "长".repeat(120);
  const longAgent = (await agents.build({ ...input("long-name"), name: longName })).agent;
  const iconOnly = await agents.setProfile("long-name", { ...longAgent.profile, icon: "✨" });
  assert.equal(iconOnly.profile.name, longName); assert.equal(iconOnly.profile.icon, "✨");
});

test("构建期间编辑记忆和展示资料，提交新定义不会覆盖最新内容", async (t) => {
  let started;
  const waiting = new Promise((done) => { started = done; }), records = [];
  const { agents } = await fixture(t, factory(records, async (record) => {
    if (record.builder && record.prompts[0].includes("等待新定义")) { started(); await new Promise((done) => { record.release = done; }); }
  }));
  await agents.build(input()); await agents.setMemory("weekly", "旧记忆");
  const pending = agents.build(input("weekly", "等待新定义")); await waiting;
  const profile = { name: "新显示名", description: "新简介", icon: "✨" };
  await Promise.all([agents.setMemory("weekly", "刚保存的新记忆"), agents.setProfile("weekly", profile)]);
  records[1].release(); await pending;
  assert.equal((await agents.getMemory("weekly")).memory, "刚保存的新记忆"); assert.deepEqual((await agents.get("weekly")).profile, profile);
  assert.equal((await agents.get("weekly")).revision, 2);
  await agents.build(input("weekly", "第三版需求"));
  assert.deepEqual((await agents.get("weekly")).profile, profile); assert.equal((await agents.getMemory("weekly")).memory, "刚保存的新记忆");
});

test("产物只列出自己的文本，内容隐藏凭据，拒绝越界和符号链接", async (t) => {
  const records = [], { agents, root } = await fixture(t, factory(records));
  await agents.build(input()); await agents.build(input("another")); await agents.prompt(turn());
  const workspace = records[2].options.cwd, writer = records[2].options.customTools.find((tool) => tool.name === "write_workspace_file");
  await writer.execute("html", { file: "pages/result.html", content: "<main>产物</main><script>fetch('/api/settings')</script>" });
  await writeFile(join(workspace, "notes.txt"), 'api_key="private-fixture"\n文本产物');
  await writeFile(join(workspace, "binary.dat"), Buffer.from([0, 1, 255]));
  await writeFile(join(workspace, ".env"), "不应读取"); await writeFile(join(workspace, "api-key.txt"), "不应读取");
  await writeFile(join(root, "outside.txt"), "外部材料"); await symlink(join(root, "outside.txt"), join(workspace, "linked.txt"));
  const listed = await agents.files("weekly"); assert.deepEqual(listed.files.map((file) => file.path), ["notes.txt", "pages/result.html"]);
  assert.equal(listed.truncated, false); assert.ok(listed.files.every((file) => file.size > 0 && !Number.isNaN(Date.parse(file.updatedAt))));
  assert.deepEqual((await agents.files("another")).files, []);
  const html = await agents.file("weekly", "pages/result.html"); assert.equal(html.path, "pages/result.html"); assert.match(html.content, /<script>/); assert.equal(html.truncated, false);
  assert.doesNotMatch((await agents.file("weekly", "notes.txt")).content, /private-fixture/);
  for (const path of ["../outside.txt", "/tmp/outside.txt", ".env", "api-key.txt", "linked.txt", "binary.dat"]) await assert.rejects(agents.file("weekly", path), InputError);
  await writeFile(join(workspace, "long.txt"), "a".repeat(120_010));
  const long = await agents.file("weekly", "long.txt"); assert.equal(long.content.length, 120_000); assert.equal(long.truncated, true);
  await Promise.all(Array.from({ length: 125 }, (_value, index) => writeFile(join(workspace, `report-${index}.txt`), "文本")));
  const capped = await agents.files("weekly"); assert.equal(capped.files.length, 120); assert.equal(capped.truncated, true);
});

test("真实 Pi SDK 构建后调用专属文件工具，回复可以连续运行", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-agent-sdk-")), requests = [];
  const model = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
    const names = body.tools.map((tool) => tool.function.name), builder = names.includes("submit_agent_definition");
    assert.deepEqual(names.sort(), builder ? ["submit_agent_definition"] : ["list_workspace_files", "read_workspace_file", "write_workspace_file"]);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model",
      choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (requests.length === 1 || requests.length === 3) {
      const name = builder ? "submit_agent_definition" : "write_workspace_file";
      const arguments_ = builder ? { instructions: "将用户材料保存为周报，回复文件名。" } : { file: "weekly.md", content: "真实工具产物" };
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(arguments_) } }] }); chunk({}, "tool_calls");
    } else { chunk({ role: "assistant", content: builder ? "定义已提交。" : "周报已保存。" }); chunk({}, "stop"); }
    response.end("data: [DONE]\n\n");
  });
  await new Promise((done) => model.listen(0, "127.0.0.1", done));
  const agents = new PrototypeAgents({ config: { llmConfigured: true, chatUrl: `http://127.0.0.1:${model.address().port}/v1/chat/completions`, model: "fixture-model", apiKey: "fixture-only" },
    cwd: root, dataDir: join(root, "data") });
  t.after(async () => { await agents.close(); await new Promise((done) => model.close(done)); await rm(root, { recursive: true, force: true }); });
  assert.equal((await agents.build(input())).agent.status, "ready");
  assert.equal((await agents.prompt(turn())).reply, "周报已保存。");
  assert.equal(await readFile(join(root, "data/agent-workspaces/weekly/weekly.md"), "utf8"), "真实工具产物");
  assert.equal((await agents.prompt(turn())).status, "complete");
  assert.equal(requests.length, 5);
});
