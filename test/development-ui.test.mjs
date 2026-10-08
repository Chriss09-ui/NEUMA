import test from "node:test";
import assert from "node:assert/strict";
import { agentBuildState, agentDevelopmentState, createAgentRuntime } from "../public/agent-runtime.js";
import { createDevelopmentView } from "../public/agent-details-view.js";

const agent = { id: "one", name: "资料助手", draft: { goal: { value: "整理资料" } } };
const architecture = { agentId: agent.id, name: agent.name, draft: agent.draft, status: "passed", delivery: "needs_development",
  version: 2, candidateHash: "candidate-2" };
const development = (overrides = {}) => ({ id: "dev-1", agentId: "one", status: "interrupted", phase: "implementing",
  architectureRef: { version: 2, candidateHash: "candidate-2" }, delivery: "needs_development", summary: "进度已保存。",
  codeHash: "code-2", planHash: "plan-2", tasks: [{ id: "read", title: "读取资料", status: "verified" },
    { id: "report", title: "输出报告", status: "active" }], currentTaskId: "report", ...overrides });
const definition = { ...agent, status: "ready", revision: 2, mode: "designed", architectureRef: { version: 2, candidateHash: "candidate-2" },
  developmentRef: { id: "dev-1", codeHash: "code-2", planHash: "plan-2" } };
const ndjson = (events) => new Response(events.map((event) => JSON.stringify(event)).join("\n"), { headers: { "content-type": "application/x-ndjson" } });

test("研发入口只接受当前通过的架构，恢复不会把完成或旧版本研发当作可续接", () => {
  assert.equal(agentDevelopmentState(agent, { architecture }).canStart, true);
  for (const status of ["blocked", "failed", "cancelled", "interrupted"]) {
    const state = agentDevelopmentState(agent, { architecture, development: development({ status }) });
    assert.equal(state.canResume, true); assert.equal(state.actionLabel, "继续研发");
  }
  for (const status of ["completed", "running"]) assert.equal(agentDevelopmentState(agent, { architecture,
    development: development({ status, delivery: "ready" }) }).canResume, false);
  for (const delivery of ["needs_connection", "needs_development"]) {
    const state = agentDevelopmentState(agent, { architecture, development: development({ status: "completed", delivery }) });
    assert.equal(state.canResume, true); assert.equal(state.actionLabel, "重新检查交付"); assert.match(state.label, /研发已完成/);
  }
  assert.equal(agentDevelopmentState(agent, { architecture: { ...architecture, delivery: "ready" } }).visible, false);
  assert.equal(agentDevelopmentState(agent, { architecture: { ...architecture, status: "failed" } }).canStart, false);
  assert.equal(agentDevelopmentState({ ...agent, draft: { goal: { value: "新需求" } } }, { architecture,
    development: development() }).visible, false);
  const outdated = development({ architectureRef: { version: 1, candidateHash: "old" } });
  const state = agentDevelopmentState(agent, { architecture, development: outdated });
  assert.equal(state.record, null); assert.equal(state.canStart, true); assert.equal(state.canResume, false);
});

test("研发完成与运行就绪分开，失败、取消或不同代码版本不能借用旧定义运行", () => {
  const ready = { ...architecture, delivery: "ready" };
  const completed = development({ status: "completed", delivery: "ready" });
  assert.equal(agentBuildState(agent, { agent: definition, architecture: ready, development: completed }).status, "ready");
  assert.equal(agentBuildState(agent, { agent: definition, architecture: ready,
    development: { ...completed, codeHash: undefined, planHash: undefined, package: { codeHash: "code-2", planHash: "plan-2" } } }).status, "ready");
  for (const record of [undefined, development(), development({ status: "failed" }), development({ status: "cancelled" }),
    { ...completed, codeHash: "other" }, { ...completed, planHash: "other" }, { ...completed, id: "other" }]) {
    assert.notEqual(agentBuildState(agent, { agent: definition, architecture: ready, development: record }).status, "ready");
  }
  const connection = { ...completed, delivery: "needs_connection" };
  assert.equal(agentBuildState(agent, { agent: definition, architecture: ready, development: connection }).status, "needs_connection");
  assert.match(agentDevelopmentState(agent, { architecture, development: connection }).label, /研发已完成.*待连接/);
  const { developmentRef, ...light } = definition;
  assert.equal(agentBuildState(agent, { agent: light, architecture: ready }).status, "ready");
});

test("研发接口沿用NDJSON，传递恢复选项并拒绝缺失终态、错归属与取消后结果", async () => {
  const requests = [], progress = [], result = { agent: null, architecture, development: development({ status: "blocked" }) };
  const api = createAgentRuntime(async (path, options) => {
    requests.push({ path, options });
    return path.endsWith("/stream") ? ndjson([{ type: "status", phase: "planning", label: "正在检查任务计划" }, { type: "done", result }])
      : Response.json({ cancelled: true, development: result.development });
  });
  assert.deepEqual(await api.develop("one", { resume: true, onProgress: (event) => progress.push(event) }), result);
  await api.getDevelopment("one/two"); await api.cancelDevelopment("one/two");
  assert.deepEqual(requests.map(({ path }) => path), ["/api/agents/one/development/stream", "/api/agents/one%2Ftwo/development", "/api/agents/one%2Ftwo/development/cancel"]);
  assert.deepEqual(JSON.parse(requests[0].options.body), { resume: true }); assert.equal(progress[0].phase, "planning");
  const partial = createAgentRuntime(async () => ndjson([{ type: "status", phase: "implementing" }]));
  await assert.rejects(partial.develop("one"), /研发连接中断/);
  const wrong = createAgentRuntime(async () => Response.json({ ...result, development: development({ agentId: "two" }) }));
  await assert.rejects(wrong.develop("one"), /研发连接中断/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(api.develop("one", { signal: controller.signal }), { name: "AbortError" });
});

test("研发进度用文字呈现五阶段、验收数和任务状态，模型文本只作为文本节点", () => {
  const document = { createElement: (tag) => ({ tag, children: [], attributes: new Map(), listeners: new Map(),
    append(...nodes) { this.children.push(...nodes); }, setAttribute(key, value) { this.attributes.set(key, value); },
    addEventListener(name, fn) { this.listeners.set(name, fn); } }) };
  const record = development({ status: "running", summary: "<script>不可执行</script>" });
  const state = agentDevelopmentState(agent, { architecture, development: record });
  const view = createDevelopmentView(state, { onStop: () => {} }, document);
  const text = (node) => [node.textContent, ...node.children.map(text)].join(" ");
  assert.match(text(view.root), /接收设计.*拆分任务.*开发任务.*检查验收.*整理交付/);
  assert.match(text(view.root), /1\/2 已通过.*读取资料.*已通过.*输出报告.*开发中/s);
  assert.match(text(view.root), /<script>不可执行<\/script>/);
  assert.equal(view.root.children[1].children[2].attributes.get("aria-current"), "step");
  assert.equal(view.stop.textContent, "停止研发"); assert.equal(view.start, null);
  const stopped = createDevelopmentView(state, { stopping: true }, document);
  assert.equal(stopped.stop.disabled, true);
});
