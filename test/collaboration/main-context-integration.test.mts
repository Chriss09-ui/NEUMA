import {pageElement} from "../../public/page-elements.js";
import {errorInfo} from "../../public/ui-types.js";
import type {PiSessionOptions} from "../../src/runtime/pi-port.mjs";
import type {TurnInput as DraftProviderInput} from "../../src/requirements/requirement-provider-port.mjs";
import type {RequirementDraft} from "../../src/contracts/requirements.mjs";
import { fixtureText } from "../helpers/m7-test-boundaries.mjs";
import { recordArray } from "../helpers/m7-test-boundaries.mjs";
import type { FixtureModelRequest } from "../helpers/m7-test-boundaries.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import { fixtureDeferred, listeningAddress } from "../helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import { MainAgent } from "../../src/main/main-agent.mjs";
import { PrototypeAgents } from "../../src/agents/agent-prototype.mjs";
import { createPiSession } from "../../src/runtime/pi-runtime.mjs";
import { emptyDraft, processTurn } from "../../src/requirements/core.mjs";
import { agentBuildState } from "../../public/agent-runtime.js";
import { validDraft } from "../helpers/architecture.mjs";
import { sufficientPreflight } from "../helpers/consultation.mjs";
import type { SavedRequirement } from "../../src/contracts/storage.mjs";
import type { NeumaPiSession } from "../../src/runtime/pi-port.mjs";

const deferred = fixtureDeferred;
const settle = async () => { for (let index = 0; index < 4; index++) await new Promise(setImmediate); };
const textOf = (content: unknown) => typeof content === "string" ? content : recordArray((content ?? [])).map((part) => part.text ?? "").join("");
const rewrite = "MODEL_REWRITE_FIXTURE_MUST_NOT_BECOME_REQUIREMENTS_REPLY";

function generate({ message, previousDraft }:Pick<DraftProviderInput,"message"|"previousDraft">) {
  if (message === "帮我创建一个研究 Agent") {
    const draft = emptyDraft(); draft.name = { value: "研究 Agent", source: "user" };
    draft.goal = { value: "整理研究资料", source: "user" };
    return { draft, proposedGap: "task", question: "希望如何处理研究资料？" };
  }
  const report = message.includes("报表") || previousDraft.name?.value === "报表 Agent";
  const draft = validDraft(report ? "处理报表" : "整理研究资料");
  draft.name = { value: report ? "报表 Agent" : "研究 Agent", source: "user" };
  draft.deliverable = { value: message.includes("三列") ? "三列表格" : report ? "中文报表" : "中文研究报告", source: "user" };
  return { draft, proposedGap: "none", question: "" };
}

async function sdkFixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "neuma-main-context-sdk-")), requests: {body:Record<string,unknown>;payload:Record<string,unknown>}[] = [], providerCalls: ({ "message": (unknown); "previousDraft": (unknown); })[] = [], errors: ((unknown))[] = [], saves: ((unknown))[] = [];
  const sessions: ((NeumaPiSession))[] = []; let main: MainAgent, agents: PrototypeAgents;
  const providers = { preflight: sufficientPreflight, generateDraft: async (input:DraftProviderInput) => { providerCalls.push(structuredClone({ message: input.message, previousDraft: input.previousDraft })); return generate(input); } };
  const model = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(String(Buffer.concat(chunks))), payload = JSON.parse(String(textOf(body.messages.find((message: { role: string; }) => message.role === "user").content)));
      requests.push({ body, payload });
      const routing = body.tools.some((tool: { function: { name: string; }; }) => tool.function.name === "submit_requirement_route");
      if (routing) assert.deepEqual(body.tools.map((tool: { function: { name: unknown; }; }) => tool.function.name), ["submit_requirement_route"]);
      else assert.ok(body.tools.some((tool: { function: { name: string; }; }) => tool.function.name === "open_agent_requirements"));
      const priorCalls = body.messages.filter((message: { role: string; }) => message.role === "assistant").flatMap((message: { tool_calls: unknown; }) => message.tool_calls ?? []);
      assert.equal(priorCalls.length, 0, "需求工具提交后必须终止主模型，不再请求模型写回执");
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: { role?: string; tool_calls?: { index: number; id: string; type: string; function: { name: string; arguments: string; }; }[]|{ index: number; id: string; type: string; function: { name: string; arguments: string; }; }[]; content?: string; }, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({ id: `fixture-${requests.length}`, object: "chat.completion.chunk",
        created: 1, model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (routing) {
        chunk({ role: "assistant", tool_calls: [{ index: 0, id: `route_${requests.length}`, type: "function",
          function: { name: "submit_requirement_route", arguments: JSON.stringify({ route: "continue", quote: "" }) } }] }); chunk({}, "tool_calls");
      } else if (payload.currentUserMessage === "现在日常聊一句") {
        chunk({ role: "assistant", content: "日常对话继续。" }); chunk({}, "stop");
      } else {
        const mode = payload.currentUserMessage === "帮我创建一个研究 Agent" || payload.currentUserMessage.includes("再创建另一个") ? "new" : "continue";
        chunk({ role: "assistant", content: rewrite, tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function",
          function: { name: "open_agent_requirements", arguments: JSON.stringify({ mode }) } }] }); chunk({}, "tool_calls");
      }
      response.end("data: [DONE]\n\n");
    } catch (error) {
      errors.push(error);
      if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "本机统一主对话模拟接口断言失败" } }));
    }
  });
  t.after(async () => {
    await main?.close(); await agents?.close(); model.closeAllConnections();
    if (model.listening) await new Promise<void>((resolve, reject) => model.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => { model.once("error", reject); model.listen(0, "127.0.0.1", resolve); });
  const config = { llmConfigured: true, model: "fixture-model", apiKey: "fixture-only", chatUrl: `http://127.0.0.1:${listeningAddress(model).port}/v1/chat/completions` };
  const dataDir = join(root, "data");
  agents = new PrototypeAgents({ config, cwd: root, dataDir, sessionFactory: async () => assert.fail("确认需求不能冒充已经运行架构构建") });
  await agents.ready;
  const saveRequirements = agents.saveRequirements.bind(agents);
  agents.saveRequirements = async (id, value, options) => { const saved = await saveRequirements(id, value, options); saves.push(saved.requirement); return saved; };
  const collaboration = { activity: async () => ({ agents: [], groups: [], tasks: [], activities: [] }), listGroups: async () => ({ groups: [] }) };
  const sessionFactory = async (options:PiSessionOptions) => { const session = await createPiSession(options); sessions.push(session); return session; };
  main = new MainAgent({ config, dataDir, agents, collaboration, sessionFactory, getRequirementProviders: () => providers });
  await main.ready;
  const conversation = (await main.createConversation({ mutationId: "conversation-one" })).conversation;
  return { main, agents, config, dataDir, collaboration, sessionFactory, providers, conversation, requests, providerCalls, errors, saves, sessions };
}

test("真实 Pi 需求路由终止后返回 processTurn 原文，同一主聊续问和确认实际保存需求", { timeout: 20_000 }, async (t) => {
  const f = await sdkFixture(t), progress: ({  })[] = []; let streamed = "";
  const initialMessage = "帮我创建一个研究 Agent";
  const initial = await f.main.prompt({ conversationId: f.conversation.id, message: initialMessage, mutationId: "start-research" }, (event) => {
    progress.push(event); if (event.type === "text-start") streamed = ""; if (event.type === "text-delta") streamed += event.delta;
  });
  const expected = await processTurn({ message: initialMessage, draft: emptyDraft() },
    { generateDraft: async (input) => generate(input), preflight: sufficientPreflight }, { enforceConsultation: true });
  assert.equal(f.requests.length, 1); assert.equal(initial.reply, [expected.summary, expected.question ?? expected.confirmationQuestion].filter(Boolean).join("\n\n"));
  assert.equal(streamed, initial.reply); assert.doesNotMatch(initial.reply, new RegExp(rewrite));
  assert.equal(initial.context!.type, "requirements"); assert.equal(initial.context!.status, "needs_input");
  assert.equal(initial.conversation.id, f.conversation.id); assert.equal(initial.conversation.messages.length, 2);
  assert.equal(f.saves.length, 0); assert.ok(progress.some((event) => objectFields(event).type === "context" && objectFields(objectFields(event).context).type === "requirements"));
  const ready = await f.main.prompt({ conversationId: f.conversation.id, message: "资料由我提供，输出中文研究报告", mutationId: "clarify-research" });
  assert.equal(ready.context!.agentId, initial.context!.agentId); assert.equal(ready.context!.status, "ready"); assert.equal(ready.context!.confirmed, false);
  assert.equal(objectFields(objectFields(f.providerCalls[1]!.previousDraft).goal).value, "整理研究资料");
  assert.deepEqual(recordArray(objectFields(f.requests[1]!.body).tools).map((tool) => objectFields(tool.function).name), ["submit_requirement_route"]);
  assert.equal(objectFields(f.requests[1]!.payload).currentUserMessage, "资料由我提供，输出中文研究报告");
  assert.equal(objectFields(objectFields(f.requests[1]!.payload).currentRequirement).agentId, initial.context!.agentId);
  const before = f.providerCalls.length, requestsBeforeConfirmation = f.requests.length;
  const confirmed = await f.main.prompt({ conversationId: f.conversation.id, message: "确认需求", mutationId: "approve-research" });
  assert.equal(f.providerCalls.length, before, "明确确认沿用已展示需求，不再次调用需求模型");
  assert.equal(f.requests.length, requestsBeforeConfirmation, "当前待确认需求可由程序直接提交，不重新请求主模型");
  assert.equal(confirmed.context!.status, "needs_build"); assert.equal(confirmed.context!.confirmed, true);
  assert.equal(objectFields(confirmed.context!.requirement).id, initial.context!.agentId); assert.equal(f.saves.length, 1);
  assert.equal(confirmed.actions!.find((action) => action.type === "build_agent")!.agentId, initial.context!.agentId);
  assert.deepEqual(confirmed.context!.requirement, (await f.agents.getRequirements()).requirements[0]);
  assert.equal(await f.agents.get(initial.context!.agentId!), null, "需求入口已持久化，执行定义仍待正式制作");
  const count = f.requests.length;
  const replay = await f.main.prompt({ conversationId: f.conversation.id, message: "确认需求", mutationId: "approve-research" });
  assert.equal(f.requests.length, count); assert.equal(f.saves.length, 1); assert.equal(replay.reply, confirmed.reply);
  assert.equal(f.requests.length, 2); assert.deepEqual(f.errors, []);
});

test("同一主聊再创建不覆盖原 Agent，普通闲聊隐藏上下文但保留草稿和重启恢复", { timeout: 20_000 }, async (t) => {
  const f = await sdkFixture(t);
  const send = (message: string, mutationId: string) => f.main.prompt({ conversationId: f.conversation.id, message, mutationId });
  const first = await send("再创建另一个研究 Agent", "first-new");
  const firstSaved = await send("确认需求", "first-approve");
  const second = await send("再创建另一个报表 Agent", "second-new");
  assert.notEqual(first.context!.agentId, second.context!.agentId); assert.equal(second.context!.confirmed, false);
  const secondSaved = await send("确认需求", "second-approve");
  const requirements = (await f.agents.getRequirements()).requirements;
  assert.equal(requirements.length, 2);
  assert.deepEqual(requirements.find((value: { id: string|undefined; }) => value.id === first.context!.agentId), firstSaved.context!.requirement);
  assert.deepEqual(requirements.find((value: { id: string|undefined; }) => value.id === second.context!.agentId), secondSaved.context!.requirement);
  const ordinary = await send("现在日常聊一句", "ordinary-chat");
  assert.equal(ordinary.reply, "日常对话继续。"); assert.equal(ordinary.context, null);
  assert.equal(ordinary.conversation!.requirements!.length, 2); assert.equal(ordinary.conversation!.requirement!.agentId, second.context!.agentId);
  const restored = new MainAgent({ config: f.config, dataDir: f.dataDir, agents: f.agents, collaboration: f.collaboration,
    sessionFactory: f.sessionFactory, getRequirementProviders: () => f.providers }); t.after(() => restored.close()); await restored.ready;
  const record = (await restored.getConversation(f.conversation.id)).conversation;
  assert.equal(record.context, null); assert.equal(record.requirements!.length, 2);
  const continued = await restored.prompt({ conversationId: f.conversation.id, message: "继续修改刚才的报表需求，输出改为三列表格", mutationId: "revise-report" });
  assert.equal(continued.context!.agentId, second.context!.agentId); assert.equal(objectFields(objectFields(continued.context!.draft).deliverable).value, "三列表格");
  assert.equal(continued.context!.confirmed, false); assert.deepEqual(f.errors, []);
});

const contextSource = (await readFile(new URL("../../public/main-context.js", import.meta.url), "utf8")).replace(/^import[^\n]*\n/gm, "").replace(/^export /gm, "");
function contextUI(api = {}) {
  const nodes = new Map<string,Element>(), timers = new Map<number,()=>void>(), calls: ({ "type": (string); "message"?: (unknown); "agentId"?: (unknown); "requirement"?: (unknown); })[] = []; let current = { id: "conversation-one" }, serial = 0;
  class Element {
    tagName:string; constructor(tag = "div") { this.tagName = tag; }
    children: (Element|string)[] = []; listeners = new Map<string,()=>unknown>(); attributes = new Map<string,unknown>(); dataset = {}; hidden = false; inert = false; open = false; textContent = ""; className = ""; classes = new Set<string>();
    classList = { toggle: (name: string, enabled: unknown) => enabled ? this.classes.add(name) : this.classes.delete(name),
      add: (...names: string[]) => names.forEach((name) => this.classes.add(name)), remove: (...names: string[]) => names.forEach((name) => this.classes.delete(name)),
      contains: (name: string) => this.classes.has(name) || this.className.split(/\s+/).includes(name) };
    append(...children: (Element|string)[]) { this.children.push(...children); } replaceChildren(...children: (Element|string)[]) { this.children = children; }
    setAttribute(name: string, value: unknown) { this.attributes.set(name, value); }
    getAttribute(name: string) { return this.attributes.get(name) ?? null; } removeAttribute(name: string) { this.attributes.delete(name); }
    contains(value:Element):boolean { return this === value || this.children.some((child) => typeof child === "object" && child.contains(value)); }
    querySelectorAll(selector: string) { return descendants(this).filter((child: { classList: { contains: (arg0: string) => unknown; }; tagName: string; }) => selector === "*" || selector.startsWith(".")
      ? selector === "*" || child.classList.contains(selector.slice(1)) : child.tagName === selector); }
    querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
    addEventListener(type: string, listener:()=>unknown) { this.listeners.set(type, listener); }
    focus() {} click() { return this.listeners.get("click")?.(); }
  }
  const descendants = (target:Element):Element[] => target.children.flatMap((child) => typeof child === "object" ? [child, ...descendants(child)] : []);
  const get = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id)!; };
  const document = { getElementById: get, createElement: (tag: string|undefined) => new Element(tag), hidden: false };
  const node = (tag: string|undefined, className = "", text = "") => Object.assign(new Element(tag), { className, textContent: text });
  const button = (label: string|undefined, action:()=>unknown, className: string|undefined) => { const value = node("button", className, label); value.addEventListener("click", action); return value; };
  const text = (value:Element|string):string => typeof value === "string" ? value : `${value.textContent || ""}${value.children.map(text).join("")}`;
  const script = vm.createContext({ document, pageElement, errorInfo, node, button, notice(target: { textContent: unknown; }, value: unknown) { target.textContent = value; }, internalLinks: () => node("div"),
    renderTasks(target:Element, tasks:{goal:string;status:string}[]) { for (const task of tasks) target.append(node("p", "", `${task.goal} ${task.status}`)); },
    taskLabels: {}, agentBuildState, AbortController, structuredClone, clearInterval: (id:number) => timers.delete(id),
    submit: (message: unknown) => calls.push({ type: "submit", message }), edit: (message: unknown) => calls.push({ type: "edit", message }),
    build: (agentId: unknown, requirement: unknown) => calls.push({ type: "build", agentId, requirement }),
    setInterval(callback:()=>void) { const id = ++serial; timers.set(id, callback); return id; }, api, current: () => current });
  vm.runInContext(`${contextSource}\nthis.panel = createMainContext({api,current,submit,edit,build});`, script);
  return { panel: script.panel, get, timers, calls, text: (id: string) => text(get(id)), select(id: string) { current = { id }; },
    find: (className: unknown) => get("main-context-content").querySelectorAll(`.${className}`),
    button(label: string) { const value = get("main-context-content").querySelectorAll("button").find((item: { textContent: string; }) => item.textContent === label);
      assert.ok(value, `找不到 ${label} 按钮`); return value; }, textOf: text };
}

test("右上下文默认隐藏，关闭只停只读轮询而不会取消群任务", async () => {
  let cancellations = 0;
  const ui = contextUI({ group: async () => ({ group: { id: "group-one", name: "研究组" }, members: [], tasks: [{ id: "task-one", goal: "持续协作", status: "running" }] }),
    cancelTask: async () => { cancellations++; } });
  ui.panel.reset(null);
  assert.equal(ui.get("main-context-panel").getAttribute("aria-hidden"), "true"); assert.equal(ui.get("main-context-panel").inert, true);
  assert.equal(ui.get("main-context-open").hidden, true); assert.equal(ui.timers.size, 0);
  assert.equal(ui.get("main-context-requirement-status").hidden, true);
  ui.panel.set({ type: "group", groupId: "group-one", taskId: "task-one" }, { reveal: true }); await settle();
  assert.equal(ui.get("main-context-panel").getAttribute("aria-hidden"), "false"); assert.equal(ui.get("main-context-panel").inert, false);
  assert.match(ui.text("main-context-content"), /持续协作 running/);
  ui.get("main-context-close").click();
  assert.equal(ui.get("main-context-panel").getAttribute("aria-hidden"), "true"); assert.equal(ui.get("main-context-panel").inert, true);
  assert.equal(ui.timers.size, 0); assert.equal(cancellations, 0);
  ui.get("main-context-open").click(); await settle();
  assert.match(ui.text("main-context-content"), /持续协作 running/); assert.equal(cancellations, 0); ui.panel.reset(null);
});

test("切换主会话后迟到群详情不能污染新会话的需求面板", async () => {
  const held = deferred(); let signal;
  const ui = contextUI({ async group(_id: unknown, options: { signal: unknown; }) { signal = options.signal; return held.promise; } });
  ui.panel.set({ type: "group", groupId: "old-group" }, { reveal: true }); await settle();
  ui.select("conversation-two"); ui.panel.reset({ type: "requirements", agentId: "new-agent", draft: validDraft("新会话需求"), confirmed: false, status: "needs_input" });
  assert.equal(signal!.aborted!, true);
  held.resolve!({ group: { id: "old-group", name: "迟到旧群信息" }, members: [], tasks: [] }); await settle();
  assert.match(ui.text("main-context-content"), /新会话需求/); assert.doesNotMatch(ui.text("main-context-content"), /迟到旧群信息/);
  assert.equal(ui.get("main-context-title").textContent, "需求说明"); ui.panel.reset(null);
});

test("需求说明恢复十五字段、来源提示和保存与导出折叠", () => {
  const draft = validDraft("分析研究资料");
  draft.agentType = { value: "Analysis Agent", source: "inferred" };
  for (const key of ["inputSource", "task", "deliverable", "successCriteria"] as const) draft[key].source = "inferred";
  draft.routingCondition = { value: "用户要求核对资料时调用", source: "inferred" };
  draft.usage = { mode: "on_demand", detail: "按需整理资料", source: "user" };
  draft.externalAction = { mode: "requested", operation: "发送报告", target: "研究组", scope: "仅本次报告", trigger: "用户确认后", source: "user" };
  draft.constraints = [{ text: "保留材料出处", source: "user" }];
  draft.capabilityDependencies = ["经用户授权的外部连接"]; draft.unresolved = ["核实上传格式"];
  const ui = contextUI(); ui.panel.set({ type: "requirements", agentId: "analyst", draft, status: "needs_input", confirmed: false }, { reveal: true });
  assert.equal(ui.get("main-context-title").textContent, "需求说明");
  assert.equal(ui.get("main-context-panel").classList.contains("side-panel"), true);
  assert.equal(ui.get("main-context-panel").classList.contains("main-requirements-panel"), true);
  assert.equal(ui.get("main-context-requirement-status").hidden, false);
  assert.equal(ui.find("draft-content").length, 1);
  const fields = ui.find("draft-field"), labels = fields.map((field) => ui.textOf(field.querySelector(".field-label")!.children[0]!));
  assert.deepEqual(labels, ["Agent 名称", "初步类型", "核心目标", "使用场景", "每次输入", "核心任务与处理方式", "输出结果", "完成标准",
    "工作限制", "建议调用场景", "使用方式", "对外动作", "能力连接状态", "能力依赖", "未解决事项"]);
  for (const label of ["每次输入", "核心任务与处理方式", "输出结果", "完成标准"]) {
    const field = fields[labels.indexOf(label)]!; assert.equal(field.querySelector(".source")!.textContent, "建议，待核对");
    assert.ok(field.querySelector(".field-value")!.textContent);
  }
  assert.match(ui.text("main-context-content"), /分析类|Analysis Agent/);
  assert.match(ui.text("main-context-content"), /用户要求核对资料时调用/);
  assert.match(ui.text("main-context-content"), /发送报告.*研究组.*仅本次报告.*用户确认后/);
  assert.match(ui.text("main-context-content"), /经用户授权的外部连接.*核实上传格式/);
  const disclosure = ui.get("main-context-content").querySelectorAll("details").find((item) => /保存与导出/.test(ui.textOf(item.querySelector("summary")!)));
  assert.ok(disclosure); assert.equal(disclosure.open, false);
  assert.equal(disclosure.contains(ui.button("继续修改")), true); assert.equal(disclosure.contains(ui.button("导出需求 JSON")), true);
  ui.button("继续修改").click(); assert.equal(ui.calls.at(-1)!.type, "edit"); assert.match(fixtureText(ui.calls.at(-1)!.message), /需求/);
  ui.panel.reset(null);
});

test("需求说明空态与澄清确认生成步骤对应当前上下文，确认和制作动作仍可用", async () => {
  const ui = contextUI({ inspectAgent: async () => ({ agent: null, architecture: null }) });
  const currentStep = () => { const list = ui.find("brief-steps")[0]; assert.ok(list);
    const items = list.querySelectorAll("li"), current = items.filter((item) => item.getAttribute("aria-current") === "step");
    assert.equal(current.length, 1); return items.indexOf(current[0]!); };
  ui.panel.set({ type: "requirements", agentId: "first", draft: null, status: "needs_input", confirmed: false }, { reveal: true });
  assert.equal(ui.find("brief-empty").length, 1); assert.equal(currentStep(), 0);
  const draft = validDraft("核对第二项需求"), ready = { type: "requirements", agentId: "second", draft, status: "ready", confirmed: false };
  ui.panel.set(ready, { reveal: true });
  assert.equal(currentStep(), 1); assert.equal(ui.get("main-context-requirement-status").textContent, "待你确认");
  ui.button("确认需求并开始制作").click(); assert.deepEqual(ui.calls.at(-1), { type: "submit", message: "确认需求" });
  const requirement = { id: "second", name: "第二项需求", draft };
  ui.panel.set({ ...ready, confirmed: true, status: "needs_build", requirement }, { reveal: true }); await settle();
  assert.equal(currentStep(), 2); assert.equal(ui.get("main-context-requirement-status").textContent, "需求已确认");
  ui.button("制作智能体").click(); assert.deepEqual(ui.calls.at(-1), { type: "build", agentId: "second", requirement });
  assert.equal(ui.find("brief-empty").length, 0); ui.panel.reset(null);
});

test("需求说明切换群任务后隐藏状态标记并清理需求面板样式与字段", async () => {
  const ui = contextUI({ group: async () => ({ group: { id: "research", name: "研究组" }, members: [], tasks: [] }) });
  ui.panel.set({ type: "requirements", agentId: "analyst", draft: validDraft("研究需求"), status: "ready", confirmed: false }, { reveal: true });
  assert.equal(ui.get("main-context-requirement-status").hidden, false);
  ui.panel.set({ type: "group", groupId: "research" }, { reveal: true }); await settle();
  assert.equal(ui.get("main-context-panel").getAttribute("aria-hidden"), "false"); assert.equal(ui.get("main-context-panel").inert, false);
  assert.equal(ui.get("main-context-title").textContent, "研究组");
  assert.equal(ui.get("main-context-requirement-status").hidden, true);
  assert.equal(ui.get("main-context-panel").classList.contains("side-panel"), false);
  assert.equal(ui.get("main-context-panel").classList.contains("main-requirements-panel"), false);
  assert.equal(ui.find("draft-field").length, 0); assert.equal(ui.find("brief-steps").length, 0); ui.panel.reset(null);
});
