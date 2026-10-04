import test from "node:test";
import assert from "node:assert/strict";
import { agentHistory, agentSourceKey, createAgentRuntime } from "../public/agent-runtime.js";

const agent = { id: "one", name: "会议助手", draft: { goal: { value: "整理会议", source: "user" } }, status: "ready", revision: 1 };
const body = { agentId: "one", sessionId: "session-one", message: "整理这份记录", history: [] };
const turn = { reply: "会议记录已整理", agentId: "one", sessionId: "session-one", status: "complete" };
const ndjson = (events) => new Response(events.map((event) => JSON.stringify(event)).join("\n"), {
  headers: { "content-type": "application/x-ndjson" },
});

test("生成、独立会话与停止使用自己的运行接口和 NDJSON 协议", async () => {
  const requests = [], progress = [];
  const api = createAgentRuntime(async (path, options) => {
    requests.push({ path, options });
    if (path === "/api/agents/build") return ndjson([{ type: "status", label: "正在生成" }, { type: "done", result: { agent } }]);
    if (path === "/api/agents/turn") return ndjson([{ type: "text-delta", delta: "会议记录" }, { type: "done", result: turn }]);
    return Response.json(path === "/api/agents/cancel" ? { cancelled: true } : { agent });
  });
  assert.equal((await api.inspect("one")).agent.id, "one");
  assert.equal((await api.build(agent, { onProgress: (event) => progress.push(event) })).agent.revision, 1);
  assert.deepEqual(await api.turn(body, { onProgress: (event) => progress.push(event) }), turn);
  await api.cancel("session-one");
  assert.deepEqual(requests.map(({ path }) => path), ["/api/agents/one", "/api/agents/build", "/api/agents/turn", "/api/agents/cancel"]);
  assert.deepEqual(JSON.parse(requests[1].options.body), { id: agent.id, name: agent.name, draft: agent.draft });
  assert.equal(requests[2].options.headers.accept, "application/x-ndjson");
  assert.deepEqual(JSON.parse(requests[3].options.body), { sessionId: "session-one" });
  assert.equal(progress.length, 2);
});

test("没有完成事件、错误结果和错绑会话均不能标为成功", async () => {
  const api = createAgentRuntime(async () => ndjson([{ type: "text-delta", delta: "部分内容" }]));
  await assert.rejects(api.build(agent), /尚未确认完成/);
  await assert.rejects(api.turn(body), /回复尚未完成/);
  const wrong = createAgentRuntime(async () => Response.json({ ...turn, sessionId: "another-session" }));
  await assert.rejects(wrong.turn(body), /回复尚未完成/);
  const failed = createAgentRuntime(async () => Response.json({ error: "请先配置模型" }, { status: 503 }));
  await assert.rejects(failed.turn(body), /请先配置模型/);
});

test("已取消的请求忽略迟到的完成结果，详情路径正确编码", async () => {
  const controller = new AbortController(), requests = [];
  const api = createAgentRuntime(async (path) => { requests.push(path); return Response.json(turn); });
  controller.abort();
  await assert.rejects(api.turn(body, { signal: controller.signal }), { name: "AbortError" });
  await api.inspect("one/two");
  assert.equal(requests[1], "/api/agents/one%2Ftwo");
});

test("恢复仅包含当前版本的成功问答，保留 revision 并排除预览、失败和部分内容", () => {
  const pair = (revision, delivery = "sent", status = "complete") => [
    { role: "user", content: `任务${revision}`, revision, delivery },
    { role: "assistant", content: `回复${revision}`, revision, status },
  ];
  const history = agentHistory([
    { role: "user", content: "旧预览" }, ...pair("1"), ...pair("2", "failed", "error"),
    ...pair("2", "stopped", "stopped"), ...pair("2"), ...pair("2", "pending", "writing"),
  ], 2);
  assert.deepEqual(history, [
    { role: "user", content: "任务2", revision: "2" },
    { role: "assistant", content: "回复2", revision: "2" },
  ]);
  assert.equal(agentHistory(Array.from({ length: 30 }, () => pair("2")).flat(), 2).length, 40);
  assert.equal(agentSourceKey(agent), agentSourceKey({ ...agent, revision: 2, status: "building" }));
  assert.notEqual(agentSourceKey(agent), agentSourceKey({ ...agent, name: "新的助手" }));
});

test("历史按完整问答裁剪字符和请求字节，长回复仍显示但不恢复进模型", () => {
  const pair = (character, size = 12_000) => [
    { role: "user", content: character.repeat(4000), revision: "1", delivery: "sent" },
    { role: "assistant", content: character.repeat(size), revision: "1", status: "complete" },
  ];
  const english = agentHistory(Array.from({ length: 5 }, () => pair("x")).flat(), 1);
  assert.equal(english.length, 6);
  assert.equal(english.reduce((total, entry) => total + entry.content.length, 0), 48_000);
  const chinese = agentHistory([...Array.from({ length: 5 }, () => pair("中")).flat(), ...pair("长", 12_001)], 1);
  assert.equal(chinese.length, 4);
  assert.equal(chinese.some((entry) => entry.content.includes("长")), false);
  const bytes = new TextEncoder().encode(JSON.stringify({ ...body, message: "中".repeat(4000), history: chinese })).length;
  assert.ok(bytes < 128_000);
  assert.equal(chinese[0].role, "user");
  assert.equal(chinese.at(-1).role, "assistant");
});

test("名称、记忆与历史成果使用独立接口，展示修改不进入构建请求", async () => {
  const requests = [], controller = new AbortController();
  const profile = { name: "阅读伙伴", description: "", icon: "📚" };
  const api = createAgentRuntime(async (path, options) => {
    requests.push({ path, ...options });
    if (path === "/api/agent-profiles") return Response.json({ profiles: [{ id: "one", ...profile }] });
    if (path.endsWith("/profile")) return Response.json({ profile: JSON.parse(options.body) });
    if (path.endsWith("/memory")) return Response.json({ memory: options.body ? JSON.parse(options.body).memory : "我的偏好" });
    if (path.endsWith("/files")) return Response.json({ files: [{ path: "报告/本周.md", size: 20 }] });
    if (path.includes("/file?")) return Response.json({ path: "报告/本周.md", content: "正文", truncated: true });
    return Response.json({ agent });
  });
  assert.equal((await api.listProfiles()).profiles[0].name, "阅读伙伴");
  assert.deepEqual((await api.saveProfile("one/two", profile)).profile, profile);
  assert.equal((await api.getMemory("one/two", { signal: controller.signal })).memory, "我的偏好");
  assert.equal((await api.saveMemory("one/two", "新偏好")).memory, "新偏好");
  assert.equal((await api.listFiles("one/two")).files[0].size, 20);
  assert.equal((await api.readFile("one/two", "报告/本周.md")).truncated, true);
  assert.equal(requests[1].path, "/api/agents/one%2Ftwo/profile");
  assert.deepEqual(JSON.parse(requests[1].body), profile);
  assert.equal(requests[2].signal, controller.signal);
  assert.equal(requests[5].path, `/api/agents/one%2Ftwo/file?path=${encodeURIComponent("报告/本周.md")}`);
  await api.build({ ...agent, profile });
  assert.deepEqual(JSON.parse(requests[6].body), { id: agent.id, name: agent.name, draft: agent.draft });
  assert.equal(agentSourceKey({ ...agent, profile }), agentSourceKey(agent));
  controller.abort();
  await assert.rejects(api.listProfiles({ signal: controller.signal }), { name: "AbortError" });
});
