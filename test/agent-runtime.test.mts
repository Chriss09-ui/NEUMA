import { callFixture } from "./helpers/m7-test-boundaries.mjs";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import type { TestFailure } from "./helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { agentBuildState as checkedAgentBuildState, agentDevelopmentState as checkedAgentDevelopmentState, agentHistory, agentSourceKey as checkedAgentSourceKey, createAgentRuntime } from "../public/agent-runtime.js";
import { activeApplicationResult } from "./helpers/active-application.mjs";

const agent = { id: "one", name: "会议助手", draft: { goal: { value: "整理会议", source: "user" } }, status: "ready", revision: 1 };
const body = { agentId: "one", sessionId: "session-one", message: "整理这份记录", history: [] };
const turn = { reply: "会议记录已整理", agentId: "one", sessionId: "session-one", status: "complete" };
const ndjson = (events: unknown[]) => new Response(events.map((event: unknown) => JSON.stringify(event)).join("\n"), {
  headers: { "content-type": "application/x-ndjson" },
});
const architecture = (overrides = {}) => ({ agentId: agent.id, name: agent.name, draft: agent.draft,
  version: 2, candidateHash: "candidate-2", status: "passed", delivery: "ready", summary: "复用现有能力。", issues: [], ...overrides });
const designed = { ...agent, mode: "designed", architectureRef: { version: 2, candidateHash: "candidate-2" } };

test("耗尽的未接受规划明确开启新批次，已执行任务和不匹配回执保持原继续语义", () => {
  const record = { id: "dev-one", agentId: agent.id, architectureRef: { version: 2, candidateHash: "candidate-2" }, status: "failed", phase: "planning",
    tasks: [], currentTaskId: null, package: null, continuation: { mode: "fresh", sourceRunId: "dev-one" } };
  const current = architecture({ delivery: "needs_development" });
  const view = agentDevelopmentState(agent, { architecture: current, development: record });
  assert.equal(view.canStart, true); assert.equal(view.canResume, false); assert.equal(view.actionLabel, "新一轮研发");
  assert.match(view.summary, /进度记录已保留/u);
  for (const change of [{ continuation: { mode: "fresh", sourceRunId: "different" } }, { tasks: [{ id: "done" }] },
    { phase: "implementing" }, { status: "interrupted" }]) {
    const blocked = agentDevelopmentState(agent, { architecture: current, development: { ...record, ...change } });
    assert.equal(blocked.canRestart, false); assert.equal(blocked.canStart, false); assert.equal(blocked.canResume, true);
  }
});

test("生成、独立会话与停止使用自己的运行接口和 NDJSON 协议", async () => {
  const requests: ({ "path": (string); "options": (RequestInit | undefined); })[] = [], progress: ((unknown))[] = [];
  const api = createAgentRuntime(async (path, options) => {
    requests.push({ path, options });
    if (path === "/api/agents/build") return ndjson([{ type: "status", label: "正在生成" }, { type: "done", result: { agent: designed, architecture: architecture() } }]);
    if (path === "/api/agents/turn") return ndjson([{ type: "text-delta", delta: "会议记录" }, { type: "done", result: turn }]);
    return Response.json(path === "/api/agents/cancel" ? { cancelled: true } : { agent: designed, architecture: architecture() });
  });
  assert.equal((await api.inspect("one")).agent!.id, "one");
  assert.equal((await callFixture(api.build,api,[agent,{onProgress:(event:unknown)=>progress.push(event)}])).agent!.revision, 1);
  assert.deepEqual(await api.turn(body, { onProgress: (event: unknown) => progress.push(event) }), turn);
  await api.cancel("session-one");
  assert.deepEqual(requests.map(({ path }) => path), ["/api/agents/one", "/api/agents/build", "/api/agents/turn", "/api/agents/cancel"]);
  assert.deepEqual(JSON.parse(String(requests[1]!.options!.body)), { id: agent.id, name: agent.name, draft: agent.draft });
  assert.equal(new Headers(requests[2]!.options!.headers).get("accept"), "application/x-ndjson");
  assert.deepEqual(JSON.parse(String(requests[3]!.options!.body)), { sessionId: "session-one" });
  assert.equal(progress.length, 2);
});

test("没有完成事件、错误结果和错绑会话均不能标为成功", async () => {
  const api = createAgentRuntime(async () => ndjson([{ type: "text-delta", delta: "部分内容" }]));
  await assert.rejects(callFixture(api.build, api, [agent]), /尚未确认完成/);
  await assert.rejects(api.turn(body), /回复尚未完成/);
  const wrong = createAgentRuntime(async () => Response.json({ ...turn, sessionId: "another-session" }));
  await assert.rejects(wrong.turn(body), /回复尚未完成/);
  const failed = createAgentRuntime(async () => Response.json({ error: "请先配置模型" }, { status: 503 }));
  await assert.rejects(failed.turn(body), /请先配置模型/);
});

test("只有显式修复操作携带宿主绑定授权，普通生成不自动领取额外轮次", async () => {
  const requests: ((unknown))[] = [], architectureRepair = { version: 4, checkpointHash: "a".repeat(64), stageKey: "demo_generation" };
  const api = createAgentRuntime(async (_path, options) => {
    requests.push(JSON.parse(String(options!.body!)));
    return Response.json({ agent: null, architecture: architecture({ status: "failed" }) });
  });
  await callFixture(api.build,api,[agent]);
  await callFixture(api.build,api,[agent,{architectureRepair}]);
  assert.equal(Object.hasOwn(objectFields(requests[0]), "architectureRepair"), false);
  assert.deepEqual(objectFields(requests[1]).architectureRepair, architectureRepair);
});

test("架构未就绪也是完整构建结果，不能误报为连接中断", async () => {
  for (const status of ["needs_changes", "needs_evidence", "infeasible", "failed", "cancelled", "passed"]) {
    const result = { agent: null, architecture: architecture({ status, delivery: "needs_development" }) };
    const api = createAgentRuntime(async () => ndjson([{ type: "done", result }]));
    assert.deepEqual(await callFixture(api.build,api,[agent]), result);
  }
  const wrong = createAgentRuntime(async () => Response.json({ agent, architecture: architecture({ agentId: "other" }) }));
  await assert.rejects(callFixture(wrong.build, wrong, [agent]), /尚未确认完成/);
});

test("可运行状态绑定当前需求与通过的架构版本，旧定义不能借用新评估", () => {
  assert.equal(agentBuildState(agent, { agent: designed, architecture: architecture() }).status, "ready");
  for (const definition of [null, agent, { ...designed, status: "failed" },
    { ...designed, architectureRef: { version: 1, candidateHash: "candidate-2" } },
    { ...designed, architectureRef: { version: 2, candidateHash: "old-candidate" } },
    { ...designed, draft: { goal: { value: "旧需求" } } }]) {
    assert.equal(agentBuildState(agent, { agent: definition, architecture: architecture() }).status, "blocked");
  }
  for (const status of ["designing", "evaluating", "needs_changes", "needs_evidence", "infeasible", "failed", "cancelled"]) {
    assert.equal(agentBuildState(agent, { agent: designed, architecture: architecture({ status }) }).status, status);
  }
  for (const delivery of ["needs_connection", "needs_development", "blocked"]) {
    assert.equal(agentBuildState(agent, { agent: designed, architecture: architecture({ delivery }) }).status, delivery);
  }
  assert.equal(agentBuildState(agent, { agent: { ...designed, architectureRef: { candidateHash: "candidate-2" } },
    architecture: architecture({ version: undefined }) }).status, "blocked");
  const previous = architecture({ draft: { goal: { value: "旧需求" } } });
  assert.equal(agentBuildState(agent, { agent: designed, architecture: previous }).status, "stale");
  assert.equal(agentBuildState(agent, { agent: null, architecture: previous }).status, "missing");
});

test("没有架构记录的定义一律停用，展示信息不能绕过架构检查", () => {
  for (const definition of [agent, { ...agent, mode: "prototype" }, { ...agent, status: "failed" },
    designed, { ...agent, draft: { goal: { value: "旧需求" } } }]) {
    const state = agentBuildState(agent, { agent: definition });
    assert.equal(state.status, "blocked");
    assert.match(state.label, /旧原型已停用，请重新设计与检查后运行/);
  }
  assert.equal(agentBuildState({ ...agent, profile: { name: "新的展示名" } }, { agent: designed, architecture: architecture() }).status, "ready");
});

test("制作状态只显示简短进度，内部方案及评审全文保留在原记录", () => {
  for (const status of ["designing", "evaluating", "needs_changes", "failed", "passed"]) {
    const saved = architecture({ status, summary: "内部方案依据".repeat(1000),
      issues: [{ description: "内部评审问题".repeat(1000), remedy: "内部修正建议".repeat(1000) }] });
    const before = structuredClone(saved);
    const state = agentBuildState(agent, { agent: designed, architecture: saved });
    assert.ok(state.label.length < 100);
    assert.doesNotMatch(state.label, /内部方案依据|内部评审问题|内部修正建议/);
    assert.deepEqual(saved, before);
  }
});

test("最新升级失败或取消时使用完整核实的已激活版本，仍单独报告升级状态", () => {
  const nextAgent = { ...agent, draft: { goal: { value: "新版需求" } } };
  for (const status of ["designing", "failed", "cancelled", "passed"]) {
    const latest = architecture({ version: 3, candidateHash: "next", draft: nextAgent.draft, status, delivery: "blocked" });
    const result = { agent: designed, architecture: latest, activeRuntime: { architecture: architecture(), development: null } };
    assert.equal(agentBuildState(nextAgent, result).status, "ready");
    assert.notEqual(agentBuildState!(nextAgent, result).updateStatus!.status, "ready");
    assert.notEqual(agentBuildState(nextAgent, { ...result, activeRuntime: { architecture: architecture({ candidateHash: "wrong" }) } }).status, "ready");
    assert.notEqual(agentBuildState(nextAgent, { ...result, agent: null }).status, "ready");
  }
});

test("完整绑定的活动应用内部可用，接口待配只引导设置；未知或错绑交付仍不放行", () => {
  for (const kind of ["node-action", "managed-service"]) {
    const result = activeApplicationResult(agent);
    result.agent.execution.kind = kind; result.activeRuntime.application.manifest.runtime = kind;
    const before = structuredClone(result), state = agentBuildState(agent, result);
    assert.equal(state.status, "ready"); assert.equal(state.gatewayPending, true); assert.ok(state.activeRuntime);
    assert.match(state.label, /内部功能.*本机接口待配置/);
    const development = agentDevelopmentState(agent, { ...result, ...state, definition: result.agent });
    assert.equal(development.canConfigure, true); assert.equal(development.canResume, false);
    assert.deepEqual(result, before, "前端不改写后台接口验收状态");
  }
  const mutations = [
    (result: { activeRuntime: null; }) => { result.activeRuntime = null; },
    (result: { agent: { execution: { kind: string; }; }; }) => { result.agent.execution.kind = "node-json"; },
    (result: { agent: { execution: { kind: string; }; }; }) => { result.agent.execution.kind = "unknown"; },
    (result: { agent: { execution: { buildId: string; }; }; }) => { result.agent.execution.buildId = "another"; },
    (result: { agent: { execution: { codeHash: string; }; }; }) => { result.agent.execution.codeHash = "0".repeat(64); },
    (result: { agent: { developmentRef: { id: string; }; }; }) => { result.agent.developmentRef.id = "another"; },
    (result: { agent: { developmentRef: { planHash: string; }; }; }) => { result.agent.developmentRef.planHash = "0".repeat(64); },
    (result: { activeRuntime: { development: { status: string; }; }; }) => { result.activeRuntime.development.status = "failed"; },
    (result: { activeRuntime: { development: { delivery: string; }; }; }) => { result.activeRuntime.development.delivery = "blocked"; },
    (result: { activeRuntime: { development: { package: null; }; }; }) => { result.activeRuntime.development.package = null; },
    (result: { activeRuntime: { development: { architectureRef: { candidateHash: string; }; }; }; }) => { result.activeRuntime.development.architectureRef.candidateHash = "0".repeat(64); },
    (result: { activeRuntime: { architecture: { issues: { blocking: boolean; }[]; }; }; }) => { result.activeRuntime.architecture.issues = [{ blocking: true }]; },
    (result: { activeRuntime: { architecture: { delivery: string; }; }; }) => { result.activeRuntime.architecture.delivery = "blocked"; },
    (result: { activeRuntime: { architecture: { draft: { goal: { value: string; }; }; }; }; }) => { result.activeRuntime.architecture.draft.goal.value = "另一需求"; },
    (result: { activeRuntime: { application: { deliveryVersion: string; }; }; }) => { result.activeRuntime.application.deliveryVersion = "another"; },
  ];
  for (const mutate of mutations) {
    const result = activeApplicationResult(agent); mutate(result);
    assert.notEqual(agentBuildState(agent, result).status, "ready");
    assert.equal(agentBuildState(agent, result).gatewayPending, false);
  }
});

test("接口待配的旧活动应用保留对话，失败候选仍提供原研发继续入口", () => {
  const result = activeApplicationResult(agent), next = { ...agent, draft: { goal: { value: "新版需求" } } };
  result.architecture = architecture({ ...next, agentId: agent.id, version: 3, status: "failed", delivery: "blocked" });
  const state = agentBuildState(next, result);
  assert.equal(state.status, "ready"); assert.equal(state.updateStatus!.status, "failed");
  assert.equal(state.gatewayPending, true);
  result.architecture.status = "passed";
  result.development = { ...result.development, id: "dev_update", architectureRef: { version: 3, candidateHash: result.architecture.candidateHash }, status: "failed", delivery: "blocked" };
  const updating = agentBuildState(next, result);
  const development = agentDevelopmentState(next, { ...result, ...updating, definition: result.agent });
  assert.equal(development.canConfigure, false); assert.equal(development.canResume, true);
});

test("已取消的请求忽略迟到的完成结果，详情路径正确编码", async () => {
  const controller = new AbortController(), requests: ((string))[] = [];
  const api = createAgentRuntime(async (path) => { requests.push(path); return Response.json(turn); });
  controller.abort();
  await assert.rejects(api.turn(body, { signal: controller.signal }), { name: "AbortError" });
  await api.inspect("one/two");
  assert.equal(requests[1], "/api/agents/one%2Ftwo");
});

test("恢复仅包含当前版本的成功问答，保留 revision 并排除预览、失败和部分内容", () => {
  const pair = (revision: string, delivery = "sent", status = "complete") => [
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
  const pair = (character: string, size = 12_000) => [
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
  assert.equal(chinese[0]!.role, "user");
  assert.equal(chinese.at!(-1)!.role, "assistant");
});

test("名称、记忆与历史成果使用独立接口，展示修改不进入构建请求", async () => {
  const requests:(RequestInit & {path:string})[] = [], controller = new AbortController();
  const profile = { name: "阅读伙伴", description: "", icon: "📚" };
  const api = createAgentRuntime(async (path, options) => {
    requests.push({ path, ...options! });
    if (path === "/api/agent-profiles") return Response.json({ profiles: [{ id: "one", ...profile }] });
    if (path.endsWith("/profile")) return Response.json({ profile: JSON.parse(String(options!.body!)) });
    if (path.endsWith("/memory")) return Response.json({ memory: options!.body! ? JSON.parse(String(options!.body!)).memory : "我的偏好" });
    if (path.endsWith("/files")) return Response.json({ files: [{ path: "报告/本周.md", size: 20 }] });
    if (path.includes("/file?")) return Response.json({ path: "报告/本周.md", content: "正文", truncated: true });
    return Response.json({ agent: designed, architecture: architecture() });
  });
  assert.equal((await api.listProfiles()).profiles[0]!.name, "阅读伙伴");
  assert.deepEqual((await api.saveProfile("one/two", profile)).profile, profile);
  assert.equal((await api.getMemory("one/two", { signal: controller.signal })).memory, "我的偏好");
  assert.equal((await api.saveMemory("one/two", "新偏好")).memory, "新偏好");
  assert.equal((await api.listFiles("one/two")).files[0]!.size, 20);
  assert.equal((await api.readFile("one/two", "报告/本周.md")).truncated, true);
  assert.equal(requests[1]!.path, "/api/agents/one%2Ftwo/profile");
  assert.deepEqual(JSON.parse(String(requests[1]!.body)), profile);
  assert.equal(requests[2]!.signal, controller.signal);
  assert.equal(requests[5]!.path, `/api/agents/one%2Ftwo/file?path=${encodeURIComponent("报告/本周.md")}`);
  await callFixture(api.build,api,[{...agent,profile}]);
  assert.deepEqual(JSON.parse(String(requests[6]!.body)), { id: agent.id, name: agent.name, draft: agent.draft });
  assert.equal(agentSourceKey({ ...agent, profile }), agentSourceKey(agent));
  controller.abort();
  await assert.rejects(api.listProfiles({ signal: controller.signal }), { name: "AbortError" });
});

test("Agent 需求与手动保存对话使用独立持久接口，并传递迁移及取消参数", async () => {
  const requests:(RequestInit & {path:string})[] = [], controller = new AbortController();
  const requirement = { name: "阅读助手", draft: { goal: { value: "阅读材料" } }, importOnly: true };
  const conversation = { schemaVersion: 2, messages: [{ role: "user", content: "材料" }], importOnly: true };
  const api = createAgentRuntime(async (path, options) => {
    requests.push({ path, ...options! });
    return Response.json(path === "/api/agent-requirements" ? { requirements: [] }
      : path.endsWith("/requirements") ? { requirement: { id: "one/two", ...requirement } }
        : { conversation: options!.body! ? JSON.parse(String(options!.body!)) : null });
  });
  assert.deepEqual(await api.listRequirements(), { requirements: [] });
  assert.equal((await api.saveRequirements("one/two", requirement)).requirement.id, "one/two");
  assert.deepEqual(await api.getConversation("one/two", { signal: controller.signal }), { conversation: null });
  assert.deepEqual((await api.saveConversation("one/two", conversation)).conversation, conversation);
  assert.deepEqual(requests.map(({ path }) => path), ["/api/agent-requirements", "/api/agents/one%2Ftwo/requirements",
    "/api/agents/one%2Ftwo/conversation", "/api/agents/one%2Ftwo/conversation"]);
  assert.deepEqual(JSON.parse(String(requests[1]!.body)), requirement);
  assert.equal(requests[2]!.signal, controller.signal);
  controller.abort();
  await assert.rejects(api.getConversation("one/two", { signal: controller.signal }), { name: "AbortError" });
});

test("历史对话使用独立ID接口，保存传递版本、幂等键，删除使用POST并支持取消", async () => {
  const requests:(RequestInit & {path:string})[] = [], controller = new AbortController();
  const conversation = { schemaVersion: 3, messages: [{ role: "user", content: "材料" }], expectedVersion: 2, mutationId: "same-request" };
  const api = createAgentRuntime(async (path, options) => {
    requests.push({ path, ...options! });
    return Response.json(path.endsWith("/remove") ? { deleted: true, id: "chat/one" }
      : path.endsWith("/conversations") ? { conversations: [] } : { conversation });
  });
  assert.deepEqual(await api.listConversations("one/two"), { conversations: [] });
  assert.deepEqual(await api.getHistoryConversation("one/two", "chat/one", { signal: controller.signal }), { conversation });
  assert.deepEqual(await api.saveHistoryConversation("one/two", "chat/one", conversation), { conversation });
  assert.deepEqual(await api.removeConversation("one/two", "chat/one"), { deleted: true, id: "chat/one" });
  assert.deepEqual(requests.map((item) => item.path), ["/api/agents/one%2Ftwo/conversations",
    "/api/agents/one%2Ftwo/conversations/chat%2Fone", "/api/agents/one%2Ftwo/conversations/chat%2Fone",
    "/api/agents/one%2Ftwo/conversations/chat%2Fone/remove"]);
  assert.deepEqual(JSON.parse(String(requests[2]!.body)), conversation);
  assert.equal(requests[3]!.method, "POST");
  assert.equal(requests[1]!.signal, controller.signal);
  controller.abort();
  await assert.rejects(api.listConversations("one/two", { signal: controller.signal }), { name: "AbortError" });
});

test("历史保存冲突和删除错误保留HTTP状态与原因供界面保留本机内容", async () => {
  for (const reason of ["conversation_conflict", "conversation_deleted"]) {
    const api = createAgentRuntime(async () => Response.json({ error: "对话已更新", reason }, { status: 409 }));
    await assert.rejects(callFixture(api.saveHistoryConversation, api, ["one", "chat", {}]), (error: TestFailure) => error.status === 409
      && error.reason === reason && error.message === "对话已更新");
  }
});

test("材料上传保持二进制body并编码Agent和文件名，预览与下载限制在同一Agent", async () => {
  const requests:(RequestInit & {path:string})[] = [], file = new File(["fixture"], "论文 与图.pdf", { type: "application/pdf" });
  const api = createAgentRuntime(async (path, options = {}) => {
    requests.push({ path, ...options }); return Response.json({ attachment: { id: "material-one" }, text: "正文", nextOffset: null });
  });
  await api.uploadAttachment("one/two", file);
  assert.equal(requests[0]!.body, file);
  assert.equal(new Headers(requests[0]!.headers).get("content-type"), "application/octet-stream");
  assert.equal(requests[0]!.path, `/api/agents/one%2Ftwo/attachments?name=${encodeURIComponent(file.name)}&mimeType=application%2Fpdf`);
  await api.previewAttachment("one/two", "material-one", 100);
  assert.equal(requests[1]!.path, "/api/agents/one%2Ftwo/attachments/material-one/preview?offset=100");
  assert.equal(api.attachmentRawUrl("one/two", "material-one", true), "/api/agents/one%2Ftwo/attachments/material-one/raw?download=1");
  assert.equal(api.attachmentImageUrl("one", "material-one", 2, "figure/one"), "/api/agents/one/attachments/material-one/image?page=2&imageId=figure%2Fone");
});

test("成功的纯附件问答恢复ID引用，失败和无效引用不能进入模型历史", () => {
  const pair = (attachments: { id: string; data: string; }[]|{ id: string; }[]) => [{ role: "user", content: "", attachments, delivery: "sent", revision: "1" },
    { role: "assistant", content: "已分析", status: "complete", revision: "1" }];
  assert.deepEqual(agentHistory(pair([{ id: "material-one", data: "不应保存" }]), 1), [
    { role: "user", content: "", attachments: [{ id: "material-one" }], revision: "1" },
    { role: "assistant", content: "已分析", revision: "1" },
  ]);
  assert.deepEqual(agentHistory(pair([{ id: "../other" }]), 1), []);
});

test("PDF页图读取二进制及页数响应头，取消不交付迟到页图", async () => {
  const requests:(RequestInit & {path:string})[] = [], controller = new AbortController();
  const api = createAgentRuntime(async (path, options) => {
    requests.push({ path, ...options! }); return new Response(Uint8Array.of(1, 2, 3), {
      headers: { "content-type": "image/png", "x-material-page": "2", "x-material-page-count": "3" },
    });
  });
  const result = await api.readAttachmentImage("one/two", "material-one", 2);
  assert.equal(result.page, 2); assert.equal(result.pageCount, 3);
  assert.equal(result.blob.type, "image/png"); assert.equal(result.blob.size, 3);
  assert.equal(requests[0]!.path, "/api/agents/one%2Ftwo/attachments/material-one/image?page=2");
  controller.abort();
  await assert.rejects(api.readAttachmentImage("one", "material-one", 1, { signal: controller.signal }), { name: "AbortError" });
});

function agentBuildState(...args:unknown[]){return callFixture(checkedAgentBuildState,undefined,args);}

function agentDevelopmentState(...args:unknown[]){return callFixture(checkedAgentDevelopmentState,undefined,args);}

function agentSourceKey(...args:unknown[]){return callFixture(checkedAgentSourceKey,undefined,args);}
