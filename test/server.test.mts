import { checkedText } from "./helpers/http-assertions.mjs";
import type { Progress } from "../src/runtime/pi-port.mjs";
import type { IncomingHttpHeaders } from "node:http";
import type { ServerAgents } from "../src/server-port.mjs";
import test, { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { createRequestHandler as createHandler, type RequestHandler, type RequestHandlerOptions } from "../src/server.mjs";
import { emptyDraft, InputError, ProviderError, CONFIRMATION_QUESTION } from "../src/requirements/core.mjs";
import { createProjectAddError } from "../src/projects/project-diagnostics.mjs";
import { sufficientPreflight } from "./helpers/consultation.mjs";
import { validateActionInput, validateActionOutput } from "../src/applications/application-contract.mjs";
import { validDraft } from "./helpers/architecture.mjs";
import { REQUIREMENT_REQUEST_MAX_BYTES } from "../src/requirements/requirement-limits.mjs";
import { contentHash } from "../src/requirements/task-spec.mjs";
import type { RequirementDraft } from "../public/ui-types.js";

const fixtureRoots: string[] = [], fixtureHandlers: RequestHandler[] = [];
after(async () => {
  await Promise.allSettled(fixtureHandlers.map((handler) => handler.dispose()));
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
});
const createRequestHandler = (options: RequestHandlerOptions = {}) => {
  const dataDir = mkdtempSync(join(tmpdir(), "neuma-server-requirements-")); fixtureRoots.push(dataDir);
  const handler = createHandler({ dataDir, projects: {}, projectAgent: {}, prototypeAgents: {}, ...options,
    ...(options?.providers ? { providers: { preflight: sufficientPreflight, ...options.providers } } : {}) });
  fixtureHandlers.push(handler); return handler;
};

function request(method: string, url: string, body: unknown = undefined) {
  const input = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { headers: {} as IncomingHttpHeaders, method, url });
  input.method = method;
  input.url = url;
  input.headers = body === undefined ? {} : { "content-type": "application/json" };
  return input;
}

async function invoke(handler: RequestHandler, method: string, url: string, body: unknown = undefined) {
  const result: { status: number | null; headers: Record<string, unknown> | null; text: string; body: Buffer } = { status: null, headers: null, text: "", body: Buffer.alloc(0) };
  const response = {
    writeHead(status: number, headers: Record<string, unknown>) { result.status = status; result.headers = headers; },
    end(content?: string | Uint8Array) {
      result.body = Buffer.isBuffer(content) ? content : Buffer.from(content?.toString() ?? "");
      result.text = result.body.toString();
    },
  };
  await handler(request(method, url, body), response);
  return result;
}

test("需求对话、保存和构建入口共同接受超过旧HTTP上限的合法完整草稿，超总量不进入下游", async () => {
  const draft = validDraft(), source = `可核对的原始材料：${"据".repeat(3600)}`, received: unknown[][] = [];
  const sessionId = "req_http_capacity", requestId = "request_http_capacity";
  const messageId = `request_user_${contentHash({ sessionId, requestId }).slice(0, 32)}`;
  draft.taskSpec = { version: 1, items: Array.from({ length: 60 }, (_, index) => ({ id: `http_${index}`,
    dimension: "processing", content: `第${index + 1}条固定契约`, applicability: "applies", critical: true,
    source: { kind: "user", evidence: [{ messageId, quote: source }] } })) };
  const body = { id: "http-capacity", name: "容量测试", draft };
  assert.ok(Buffer.byteLength(JSON.stringify(body)) > 512_000);
  const handler = createRequestHandler({ config: {}, providers: { generateDraft: async ({ previousDraft: incoming }) => {
    received.push(["turn", incoming]); return { draft: incoming, proposedGap: "none", question: "" };
  } }, prototypeAgents: {
    async saveRequirements(id: unknown, value: { draft: unknown; }) { received.push(["save", value.draft]); return { id }; },
    async build(value: { draft: unknown; id: unknown; }) { received.push(["build", value.draft]); return { agent: { id: value.id } }; },
  } });
  const endpoints = ["/api/requirements/turn", "/api/agents/http-capacity/requirements", "/api/agents/build"];
  for (const path of endpoints) {
    const response = await invoke(handler, "POST", path, path.endsWith("/turn")
      ? { draft, message: source, requirementSessionId: sessionId, requestId } : body);
    assert.equal(response.status, 200, response.text);
  }
  assert.deepEqual(received.map(([stage]) => stage), ["turn", "save", "build"]);
  for (const [, value] of received) assert.deepEqual(value, draft);
  for (const path of endpoints) {
    const response = await invoke(handler, "POST", path, { ...body, excessive: "x".repeat(REQUIREMENT_REQUEST_MAX_BYTES) });
    assert.equal(response.status, 400); assert.match(JSON.parse(String(response.text)).error, /请求内容过长/);
  }
  assert.equal(received.length, 3);
});

test("普通应用任务入口保留真实输入契约字段位置，拒绝时不创建任务或执行生成代码", async () => {
  const object = (properties: { records?: { type: string; items: { type: string; properties: unknown; required: string[]; additionalProperties: boolean; }; }; bytes?: { type: string; }; PRIVATE_OUTPUT_FIELD?: { type: string; }; }) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
  const action = { inputSchema: object({ records: { type: "array", items: object({ bytes: { type: "integer" } }) } }),
    outputSchema: object({ PRIVATE_OUTPUT_FIELD: { type: "integer" } }) };
  let generatedCalls = 0; const tasks = [];
  const handler = createRequestHandler({ config: { model: "server-fixture" }, prototypeAgents: { requireAgent: async () => ({ id: "alpha" }),
    applications: { async submit(id: unknown, body: Record<string, unknown>) {
      const input = validateActionInput(action, body.input); generatedCalls++;
      validateActionOutput(action, { PRIVATE_OUTPUT_FIELD: "PRIVATE_GENERATED_OUTPUT" });
      tasks.push({ id, input }); return assert.fail("invalid output must not create a task");
    } } } });
  const submit = (input: { records: { bytes: boolean; }[]|{ bytes: number; PRIVATE_DYNAMIC_KEY: string; }[]|{ bytes: number; }[]; }) => invoke(handler, "POST", "/api/agents/alpha/tasks", { actionId: "analyze", input, mutationId: "admission_fixture", deliveryVersion: "delivery-one" });
  const rejected = await submit({ records: [{ bytes: true }] }); assert.equal(rejected.status, 400);
  const error = JSON.parse(String(rejected.text));
  assert.equal(error.reason, "input_contract_rejected");
  assert.deepEqual(error.validationIssue, { path: "input.records.0.bytes", reason: "invalid_type" });
  assert.match(error.error, /input\.records\.0\.bytes.*字段类型无效/);
  assert.deepEqual(error.diagnostic, { stage: "input", reason: "input_contract_rejected", providerModel: "server-fixture" });
  assert.equal(generatedCalls, 0); assert.equal(tasks.length, 0);
  const unknown = await submit({ records: [{ bytes: 1, PRIVATE_DYNAMIC_KEY: "PRIVATE_INPUT_VALUE" }] });
  assert.equal(unknown.status, 400); assert.equal(JSON.parse(String(unknown.text)).validationIssue.path, "input.records.0");
  assert.doesNotMatch(unknown.text, /PRIVATE_/); assert.equal(generatedCalls, 0); assert.equal(tasks.length, 0);
  const broken = await submit({ records: [{ bytes: 1 }] }); assert.equal(broken.status, 500);
  assert.deepEqual(JSON.parse(String(broken.text)), { error: "操作执行结果不符合交付契约，请检查或重新生成当前版本", reason: "output_contract_failed",
    diagnostic: { stage: "application", reason: "output_contract_failed", providerModel: "server-fixture" } });
  assert.doesNotMatch(broken.text, /PRIVATE_|output\./); assert.equal(generatedCalls, 1); assert.equal(tasks.length, 0);
});

test("普通任务入口遮蔽伪造契约错误及不安全typed路径，未知异常仍返回固定500", async () => {
  let failure: Error|{ message: string; reason: string; validationIssue: { path: string; reason: string; }; };
  const handler = createRequestHandler({ config: {}, prototypeAgents: { requireAgent: async () => ({ id: "alpha" }), applications: { async submit() { throw failure; } } } });
  const submit = () => invoke(handler, "POST", "/api/agents/alpha/tasks", { actionId: "analyze", input: {}, mutationId: "fixture" });
  for (const value of [new Error("PRIVATE_ERROR_BODY"), Object.assign(new Error("PRIVATE_ERROR_BODY"), { reason: "input_contract_rejected",
    validationIssue: { path: "input.safe", reason: "invalid_type" } }), { message: "PRIVATE_ERROR_BODY", reason: "input_contract_rejected", validationIssue: { path: "input.safe", reason: "invalid_type" } }]) {
    failure = value; const result = await submit(); assert.equal(result.status, 500);
    const body = JSON.parse(String(result.text)); assert.equal(body.diagnostic.reason, "internal_error"); assert.equal(body.validationIssue, undefined);
    assert.doesNotMatch(result.text, /PRIVATE_|input\.safe/);
  }
  for (const issue of [{ path: "input.value=PRIVATE_INPUT", reason: "invalid_type" }, { path: "input.safe", reason: "PRIVATE_REASON" },
    { path: "input.safe", reason: "invalid_type", PRIVATE_FIELD: "PRIVATE_METADATA" }]) {
    failure = Object.assign(new InputError("PRIVATE_RAW_CONTRACT_ERROR"), { reason: "input_contract_rejected", validationIssue: issue });
    const result = await submit(); assert.equal(result.status, 400);
    assert.deepEqual(JSON.parse(String(result.text)), { error: "输入不符合操作契约", reason: "input_contract_rejected",
      diagnostic: { stage: "input", reason: "input_contract_rejected", providerModel: null } });
    assert.doesNotMatch(result.text, /PRIVATE_|input\.safe/);
  }
});

test("非法请求地址返回安全的400，后续健康检查仍可使用", async () => {
  const handler = createRequestHandler({ config: {}, providers: {}, projects: {}, projectAgent: {}, prototypeAgents: {} });
  for (const url of ["http://[", "//[::1"]) {
    const result = await invoke(handler, "GET", url);
    assert.equal(result.status, 400);
    assert.equal(JSON.parse(String(result.text)).error, "请求地址无效");
    assert.doesNotMatch(result.text, /ERR_INVALID_URL|TypeError/);
  }
  const health = await invoke(handler, "GET", "/api/health");
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(String(health.text)).ok, true);
});

test("本地服务提供测试页面、配置状态和需求接口", async () => {
  const draft = emptyDraft();
  draft.goal = { value: "整理会议纪要", source: "user" };
  draft.scenario = { value: "会议结束后", source: "inferred" };
  draft.inputSource = { value: "用户提供的转写", source: "user" };
  draft.task = { value: "提取结论与待办", source: "user" };
  draft.deliverable = { value: "结论与待办", source: "user" };
  const handler = createRequestHandler({
    config: { llmConfigured: true, jevConfigured: false, jevModel: "jev-1.13.0" },
    providers: { generateDraft: async () => ({ draft, proposedGap: "none", question: "" }), judgeJev: null },
  });
  const page = await invoke(handler, "GET", "/");
  assert.equal(page.status, 200);
  assert.match(page.text, /Agent 运行测试版/);
  assert.match(page.text, /id="agents-list"/);
  assert.match(page.text, /id="sidebar-agent-list"/);
  assert.match(page.text, /id="page-agent"/);
  assert.match(page.text, /id="agent-runtime-status"[^>]*>智能体界面尚未加载/);
  assert.match(page.text, /id="agent-send"[^>]*disabled/);
  assert.match(page.text, /id="agent-build"[^>]*disabled/);
  assert.match(page.text, /让 NEUMA 帮我迭代/);
  assert.match(page.text, /<h1 id="main-agent-title" class="sr-only">主对话<\/h1>/);
  assert.match(page.text, /<h1 id="chat-title">创建智能体<\/h1>/);
  assert.match(page.text, /id="page-create"[^>]*data-page="legacy-create"[^>]*hidden inert/);
  assert.match(page.text, /class="main-context-slot"/);
  assert.match(page.text, /id="main-context-panel"[^>]*aria-hidden="true" inert/);
  assert.match(page.text, /id="main-history-toggle"[^>]*aria-expanded="true"/);
  assert.doesNotMatch(page.text, /id="main-activity"/);
  assert.doesNotMatch(page.text, /主\s*Agent|NUEMA/);
  const agentUi = await invoke(handler, "GET", "/agents.js");
  assert.equal(agentUi.status, 200);
  assert.match(checkedText(agentUi.headers!["content-type"]), /javascript/);
  assert.equal((await invoke(handler, "GET", "/chat-ui.js")).status, 200);
  assert.equal((await invoke(handler, "GET", "/panel-resize.js")).status, 200);
  const sidebar = await invoke(handler, "GET", "/sidebar-history.js");
  assert.equal(sidebar.status, 200);
  assert.match(sidebar.text, /export function createSidebarHistory/);
  const sidebarMotion = await invoke(handler, "GET", "/sidebar-motion.js");
  assert.equal(sidebarMotion.status, 200);
  assert.match(checkedText(sidebarMotion.headers!["content-type"]), /javascript/);
  const capabilities = await invoke(handler, "GET", "/group-capabilities.js");
  assert.equal(capabilities.status, 200);
  assert.match(checkedText(capabilities.headers!["content-type"]), /javascript/);
  const mentions = await invoke(handler, "GET", "/group-mention-composer.js");
  assert.equal(mentions.status, 200);
  assert.match(checkedText(mentions.headers!["content-type"]), /javascript/);
  assert.match(page.text, /id="reset"[^>]*>＋ 新对话/);
  assert.match(page.text, /id="diagnostics"[^>]*>导出诊断记录/);

  const health = JSON.parse(String((await invoke(handler, "GET", "/api/health")).text));
  assert.equal(health.llmConfigured, true);
  assert.equal(health.jevConfigured, false);
  assert.equal("apiKey" in health, false);

  const response = await invoke(handler, "POST", "/api/requirements/turn", { message: "整理会议纪要" });
  assert.equal(response.status, 200);
  const result = JSON.parse(String(response.text));
  assert.equal(result.status, "ready");
  assert.equal(result.question, null);
  assert.match(result.confirmationQuestion, /这份需求可以确认吗/);
  assert.equal(result.diagnostic.decision.selectedGap, "none");
  assert.equal(result.diagnostic.providerModel, null);
});

class StreamingResponse extends EventEmitter {
  declare status: number | undefined; declare headers: Record<string, unknown>;

  text = "";
  writableEnded = false;
  destroyed = false;
  writeHead(status: number, headers: Record<string, unknown>) { this.status = status; this.headers = headers; }
  write(content: string) { this.text += content; }
  end(content = "") { this.text += content; this.writableEnded = true; }
}

test("页面共享模块、小星核脚本和七张图形通过静态白名单加载，其他资源仍不可访问", async () => {
  const handler = createRequestHandler({ config: {}, providers: {} });
  for (const path of ["/agent-avatar.js", "/agent-avatar-motion.js", "/page-elements.js", "/ui-types.js"]) {
    const result = await invoke(handler, "GET", path);
    assert.equal(result.status, 200); assert.match(checkedText(result.headers!["content-type"]), /^text\/javascript/);
    assert.ok(result.text.trim());
  }
  for (const file of ["core.png", ...["cut", "shield", "trapezoid", "disc", "diamond", "pentagon"].map((shape) => `${shape}-mask.png`)]) {
    const result = await invoke(handler, "GET", `/assets/avatars/${file}`);
    assert.equal(result.status, 200); assert.equal(result.headers!["content-type"], "image/png");
    assert.ok(result.text.length > 500);
  }
  for (const path of ["/assets/avatars/unknown.png", "/assets/avatars/../../.env", "/assets/avatars/%2e%2e/%2e%2e/.env"])
    assert.equal((await invoke(handler, "GET", path)).status, 404);
});

test("左上品牌使用新图标图片，静态白名单提供有效PNG并拒绝未知品牌资源", async () => {
  const handler = createRequestHandler({ config: {}, providers: {} });
  const page = await invoke(handler, "GET", "/");
  assert.equal(page.status, 200);
  const mark = page.text.match(/<span\b[^>]*class="brand-mark"[^>]*>([\s\S]*?)<\/span>/);
  assert.ok(mark, "页面应保留左上品牌图标容器");
  assert.match(checkedText(mark[1]), /<img\b[^>]*src="\/assets\/brand\/neuma-mark\.png"/);
  assert.doesNotMatch(page.text, /<span\b[^>]*class="brand-mark"[^>]*>\s*N\s*<\/span>/);

  const image = await invoke(handler, "GET", "/assets/brand/neuma-mark.png");
  assert.equal(image.status, 200);
  assert.equal(image.headers!["content-type"], "image/png");
  assert.ok(image.body.length > 8, "品牌PNG应包含签名之外的图像数据");
  assert.deepEqual(image.body.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal((await invoke(handler, "GET", "/assets/brand/unknown.png")).status, 404);
});

test("服务关闭会取消非流式需求请求并等待其结束", async () => {
  let entered!: (value?: unknown) => void, seen;
  const started = new Promise((done) => { entered = done; });
  const handler = createRequestHandler({ config: {}, providers: {
    generateDraft: async ({ signal }) => {
      seen = signal; entered();
      await new Promise((done) => signal!.addEventListener("abort", done, { once: true }));
      signal!.throwIfAborted();
      return assert.fail("aborted operation must not continue");
    }, judgeJev: null,
  } });
  const response = new StreamingResponse();
  const pending = handler(request("POST", "/api/requirements/turn", { message: "整理会议纪要" }), response);
  await started; await handler.dispose(); await pending;
  assert.equal(seen!.aborted!, true); assert.equal(response.text, "");
});

test("运行概览只读返回快照，拒绝跨站访问并提供界面资源", async () => {
  let calls = 0;
  const snapshot = { checkedAt: "2026-10-04T00:00:00.000Z", projects: [], ports: [], summary: { total: 0 }, warnings: [] };
  const handler = createRequestHandler({ config: {}, projects: { runtime: async ({ signal }) => {
    calls++; assert.equal(signal!.aborted, false); return snapshot;
  } } });
  const response = new StreamingResponse();
  await handler(request("GET", "/api/projects/runtime"), response);
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(String(response.text)), snapshot);
  assert.equal(response.listenerCount("close"), 0);
  const foreign = request("GET", "/api/projects/runtime");
  foreign.headers.host = "127.0.0.1:3000"; foreign.headers.origin = "https://unrelated.example";
  const rejected = new StreamingResponse(); await handler(foreign, rejected);
  assert.equal(rejected.status, 403); assert.equal(calls, 1);
  for (const path of ["/runtime.js", "/runtime-view.js"]) assert.equal((await invoke(handler, "GET", path)).status, 200);
});

test("离开运行概览时取消本机查询，不返回迟到的结果", async () => {
  let entered!: (value?: unknown) => void, signal!: AbortSignal;
  const ready = new Promise((done) => { entered = done; });
  const handler = createRequestHandler({ config: {}, projects: { runtime: async (options: { signal: AbortSignal; }) => {
    signal = options.signal; entered();
    await new Promise((done) => signal!.addEventListener("abort", done, { once: true }));
    signal.throwIfAborted();
    return assert.fail("cancelled runtime query must not complete");
  } } });
  const response = new StreamingResponse();
  const pending = handler(request("GET", "/api/projects/runtime"), response); await ready;
  response.destroyed = true; response.emit("close"); await pending;
  assert.equal(signal.aborted, true); assert.equal(response.text, "");
  assert.equal(response.listenerCount("close"), 0);
});

test("添加和重新识别共用项目检查流程，流式发送进度和最终配置", async () => {
  for (const path of ["/api/projects", "/api/projects/fixture/inspect"]) {
    let seen;
    const configure = async (input: unknown, { onProgress, signal }: { onProgress?: Progress; signal?: AbortSignal | undefined }) => {
      seen = input; assert.equal(signal!.aborted, false);
      onProgress!({ type: "status", label: "正在检查入口…" });
      return { id: "fixture", canLaunch: true, setup: { status: "ready" } };
    };
    const handler = createRequestHandler({ config: {}, projects: { add: configure, inspect: configure } });
    const input = request("POST", path, { path: "/demo/project" }); input.headers.accept = "application/x-ndjson";
    const response = new StreamingResponse(); await handler(input, response);
    const events = response.text.trim().split("\n").map((text) => JSON.parse(text));
    assert.equal(events.at(-1).result.project.canLaunch, true);
    assert.ok(events.some((event) => event.label === "正在检查入口…"));
    assert.deepEqual(seen, path.endsWith("inspect") ? "fixture" : { path: "/demo/project" });
    assert.equal(response.listenerCount("close"), 0);
  }
});

test("新项目添加失败返回明确错误，流式接口不发送已添加结果", async () => {
  const handler = createRequestHandler({ config: {}, projects: {
    pendingAdds: new Map([["/checking", {}]]), list: async () => [],
    add: async () => { throw createProjectAddError({ stage: "validation", reason: "unsupported_launcher", message: "未能确认启动脚本", retries: 5 }); },
  } });
  const normal = await invoke(handler, "POST", "/api/projects", { path: "/demo/new" });
  assert.equal(normal.status, 400); assert.match(JSON.parse(String(normal.text)).error, /添加失败/);
  assert.match(JSON.parse(String(normal.text)).error, /未能确认启动脚本/);
  assert.deepEqual(JSON.parse(String(normal.text)).diagnostic, { stage: "validation", reason: "unsupported_launcher", retries: 5, providerModel: null });
  const input = request("POST", "/api/projects", { path: "/demo/new" }); input.headers.accept = "application/x-ndjson";
  const response = new StreamingResponse(); await handler(input, response);
  const events = response.text.trim().split("\n").map((text) => JSON.parse(text));
  assert.equal(events.at(-1).type, "error"); assert.equal(events.some((event) => event.type === "done"), false);
  assert.equal(events.at(-1).diagnostic.reason, "unsupported_launcher");
  const list = JSON.parse(String((await invoke(handler, "GET", "/api/projects")).text));
  assert.deepEqual(list.projects, []); assert.equal(list.pendingAdditions, 1);
});

test("失败记录提供独立只读接口且拒绝跨站访问", async () => {
  let calls = 0;
  const records = [{ id: "failure-1", name: "测试项目", message: "添加失败：未能确认启动入口。项目未加入列表。" }];
  const handler = createRequestHandler({ config: {}, projects: { failures: async (options: unknown) => {
    calls++; assert.deepEqual(options, { limit: 10 }); return records;
  } } });
  const result = await invoke(handler, "GET", "/api/projects/failures");
  assert.equal(result.status, 200); assert.deepEqual(JSON.parse(String(result.text)), { failures: records });
  const foreign = request("GET", "/api/projects/failures");
  foreign.headers = { host: "127.0.0.1:3000", origin: "https://unrelated.example" };
  const response = new StreamingResponse(); await handler(foreign, response);
  assert.equal(response.status, 403); assert.equal(calls, 1);
});

test("断开添加检查会传递取消信号，不发送迟到的成功事件", async () => {
  let entered!: (value?: unknown) => void, signal!: AbortSignal;
  const ready = new Promise((done) => { entered = done; });
  const handler = createRequestHandler({ config: {}, projects: { add: async (_body: unknown, options: { signal: AbortSignal; }) => {
    signal = options.signal; entered(); await new Promise((done) => signal!.addEventListener("abort", done, { once: true }));
    return { setup: { status: "failed" } };
  } } });
  const input = request("POST", "/api/projects", { path: "/demo/project" }); input.headers.accept = "application/x-ndjson";
  const response = new StreamingResponse(); const pending = handler(input, response); await ready;
  response.destroyed = true; response.emit("close"); await pending;
  assert.equal(signal.aborted, true); assert.doesNotMatch(response.text, /"type":"done"/);
});

test("选择文件夹接口只回填路径，不登记或启动项目", async () => {
  let picks = 0;
  const handler = createRequestHandler({ config: {},
    pickProjectFolder: async () => { picks++; return { cancelled: false, path: "/demo/project", name: "project" }; },
    projects: { add: async () => assert.fail("选择文件夹时不应登记项目"), start: async () => assert.fail("不应启动项目") },
  });
  const response = new StreamingResponse();
  await handler(request("POST", "/api/projects/pick-folder", {}), response);
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(String(response.text)), { cancelled: false, path: "/demo/project", name: "project" });
  assert.equal(picks, 1);
  assert.equal(response.listenerCount("close"), 0);
});

test("文件夹选择拒绝跨站与非 JSON 请求，GET 不会弹出窗口", async () => {
  const handler = createRequestHandler({ config: {}, pickProjectFolder: async () => assert.fail("不应打开系统窗口") });
  assert.equal((await invoke(handler, "GET", "/api/projects/pick-folder")).status, 404);
  assert.equal((await invoke(handler, "POST", "/api/projects/pick-folder")).status, 400);
  const input = request("POST", "/api/projects/pick-folder", {});
  input.headers.host = "127.0.0.1:3000"; input.headers.origin = "https://unrelated.example";
  const response = new StreamingResponse();
  await handler(input, response);
  assert.equal(response.status, 403);
});

test("退出选择页面中断请求，关闭系统选择窗口且不返回迟到的路径", async () => {
  let started!: (value?: unknown) => void, seenSignal;
  const ready = new Promise((resolve) => { started = resolve; });
  const handler = createRequestHandler({ config: {}, pickProjectFolder: async ({ signal } = {}) => {
    seenSignal = signal; started();
    await new Promise((resolve) => signal!.addEventListener("abort", resolve, { once: true }));
    signal!.throwIfAborted();
    return assert.fail("aborted picker must not continue");
  } });
  const response = new StreamingResponse();
  const pending = handler(request("POST", "/api/projects/pick-folder", {}), response);
  await ready;
  response.destroyed = true; response.emit("close");
  await pending;
  assert.equal(seenSignal!.aborted!, true);
  assert.equal(response.text, "");
  assert.equal(response.listenerCount("close"), 0);
});

function requirementStream(handler: RequestHandler, body: unknown = { message: "创建助手" }) {
  const input = request("POST", "/api/requirements/turn", body);
  input.headers.accept = "application/x-ndjson";
  const response = new StreamingResponse();
  return { response, pending: handler(input, response), events: () => response.text.trim().split("\n").filter(Boolean).map((text) => JSON.parse(text)) };
}

test("主 Agent 先核对需求再真正送出回复片段，最后追加规则选定的问题", async () => {
  let release!: (value?: unknown) => void, started!: (value?: unknown) => void;
  const hold = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { started = resolve; });
  const draft = emptyDraft();
  let checked = false;
  const handler = createRequestHandler({ config: {}, providers: {
    generateDraft: async () => ({ draft, proposedGap: "invalid", answeredPoint: "goal", question: "不能显示的模型候选问题" }),
    judgeJev: async () => { checked = true; throw new Error("暂时不可用"); },
    async streamReply({ summary, onDelta }) {
      assert.equal(checked, true);
      assert.equal(summary, "我先确认你最想解决的事。");
      onDelta!("我们先从"); started();
      await hold;
      onDelta!("最想解决的事情开始。");
    },
  } });
  const stream = requirementStream(handler);
  await ready;
  assert.equal(stream.response.writableEnded, false);
  assert.equal(stream.events().some((e) => e.delta === "我们先从"), true);
  assert.equal(stream.events().some((e) => e.type === "done"), false);
  release!(); await stream.pending;
  const events = stream.events(), result = events.at(-1).result;
  assert.equal(result.question, "你最希望这个 Agent 先帮你完成哪一件具体的事？");
  assert.equal(result.reply, `我们先从最想解决的事情开始。\n\n${result.question}`);
  assert.equal(events.filter((e) => e.type === "text-delta").map((e) => e.delta).join(""), result.reply);
  assert.equal(stream.response.text.includes("不能显示的模型候选问题"), true); // Diagnostic only, never reply text.
  assert.equal(result.reply.includes("不能显示的模型候选问题"), false);
  assert.equal(result.diagnostic.reply.mode, "stream");
});

test("首字前失败使用已校验回复；已有文字后失败不重播或提交需求", async () => {
  for (const output of ["", "\n  ", "我们先梳理"]) {
    let calls = 0;
    const handler = createRequestHandler({ config: {}, providers: {
      generateDraft: async () => ({ draft: emptyDraft(), proposedGap: "goal", question: "你最想做什么？" }),
      async streamReply({ onDelta }) {
        calls++;
        if (output) onDelta!(output);
        throw new Error("private-upstream-data");
      },
    } });
    const stream = requirementStream(handler);
    await stream.pending;
    const events = stream.events();
    assert.equal(calls, 1);
    assert.equal(stream.response.text.includes("private-upstream-data"), false);
    if (output.trim()) {
      assert.equal(events.at(-1).type, "error");
      assert.equal(events.some((e) => e.type === "done"), false);
      assert.equal(events.filter((e) => e.type === "text-delta").length, 1);
    } else {
      assert.equal(events.at(-1).result.reply, "我先确认你最想解决的事。\n\n你最想做什么？");
      assert.equal(events.at(-1).result.diagnostic.reply.mode, "fallback");
    }
  }
});

test("主 Agent 在提取、核对、输出期间断开都取消上游且不发送完成事件", async () => {
  for (const phase of ["draft", "judge", "reply"]) {
    let started!: (value?: unknown) => void, seenSignal;
    const ready = new Promise((resolve) => { started = resolve; });
    const pendingUntilAbort = async (signal?: AbortSignal) => {
      seenSignal = signal; started();
      await new Promise((resolve) => signal!.addEventListener("abort", resolve, { once: true }));
      signal!.throwIfAborted();
    };
    const handler = createRequestHandler({ config: {}, providers: {
      async generateDraft({ signal }) {
        if (phase === "draft") await pendingUntilAbort(signal);
        return { draft: emptyDraft(), proposedGap: "goal", answeredPoint: "goal", question: "你最想做什么？" };
      },
      async judgeJev({ signal }) {
        if (phase === "judge") await pendingUntilAbort(signal);
        throw new Error("不可用");
      },
      async streamReply({ signal, onDelta }) {
        onDelta!("先来了解你的想法。");
        if (phase === "reply") await pendingUntilAbort(signal);
      },
    } });
    const stream = requirementStream(handler);
    await ready;
    stream.response.destroyed = true;
    stream.response.emit("close");
    await stream.pending;
    assert.equal(seenSignal!.aborted!, true);
    assert.equal(stream.events().some((e) => ["done", "error"].includes(e.type)), false);
    assert.equal(stream.response.listenerCount("close"), 0);
  }
});

test("确认清单与明确确认保持原文，无需额外调用模型", async () => {
  const draft = emptyDraft();
  for (const key of ["goal", "scenario", "inputSource", "task", "deliverable"] as const) draft[key] = { value: key, source: "user" };
  let replyCalls = 0, draftCalls = 0;
  const handler = createRequestHandler({ config: {}, providers: {
    async generateDraft() { draftCalls++; return { draft, proposedGap: "none", question: "" }; },
    async streamReply() { replyCalls++; },
  } });
  const preview = requirementStream(handler);
  await preview.pending;
  const previewResult = preview.events().at(-1).result;
  assert.equal(previewResult.reply, `我整理出的需求是：\n${previewResult.summary}\n\n${CONFIRMATION_QUESTION}`);
  assert.equal(previewResult.confirmed, false);
  const approved = requirementStream(handler, { message: "确认", requirementSessionId: previewResult.requirementSessionId,
    requirementVersion: previewResult.requirementVersion });
  await approved.pending;
  const approvedResult = approved.events().at(-1).result;
  assert.equal(approvedResult.confirmed, true);
  assert.match(approvedResult.reply, /正在设计与检查方案/);
  assert.equal(draftCalls, 1);
  assert.equal(replyCalls, 0);
});

test("主 Agent 流式输入与模型提取错误不进入回复阶段", async () => {
  let replyCalls = 0;
  const handler = createRequestHandler({ config: {}, providers: {
    async generateDraft() { throw new Error("private-payload"); },
    async streamReply() { replyCalls++; },
  } });
  for (const message of ["", "创建助手"]) {
    const stream = requirementStream(handler, { message });
    await stream.pending;
    const events = stream.events();
    assert.equal(events.at(-1).type, "error");
    assert.equal(events.some((e) => e.type === "done"), false);
    assert.equal(stream.response.text.includes("private-payload"), false);
  }
  assert.equal(replyCalls, 0);
});

test("项目流在整轮结束前送出进度，最后返回完整结果", async () => {
  let release!: (value?: unknown) => void, started!: (value?: unknown) => void;
  const hold = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { started = resolve; });
  const handler = createRequestHandler({ config: {}, projectAgent: {
    async prompt(body: unknown, progress?: Progress) {
      progress!({ type: "status", phase: "thinking" }); started();
      await hold;
      progress!({ type: "text-delta", delta: "你好" });
      return { reply: "你好", projects: [], actions: [] };
    },
  } });
  const input = request("POST", "/api/projects/turn", { message: "你好", sessionId: "stream-session-12345" });
  input.headers.accept = "application/x-ndjson";
  const response = new StreamingResponse();
  const pending = handler(input, response);
  await ready;
  assert.equal(response.writableEnded, false);
  assert.match(checkedText(response.headers["content-type"]), /ndjson/);
  assert.equal(JSON.parse(String(response.text.trim())).phase, "thinking");
  release!(); await pending;
  const events = response.text.trim().split("\n").map((text) => JSON.parse(text));
  assert.equal(events[1].delta, "你好");
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.at(-1).result.reply, "你好");
});

test("流中异常只发送安全错误，不泄露 SDK 原始内容", async () => {
  const handler = createRequestHandler({ config: {}, projectAgent: { prompt: async () => { throw new Error("private-provider-payload"); } } });
  const input = request("POST", "/api/projects/turn", { message: "你好" }); input.headers.accept = "application/x-ndjson";
  const response = new StreamingResponse();
  await handler(input, response);
  assert.equal(response.text.includes("private-provider-payload"), false);
  assert.equal(JSON.parse(String(response.text)).type, "error");
  assert.equal(response.writableEnded, true);
});

test("浏览器中断流会取消对应的项目会话", async () => {
  let started!: (value?: unknown) => void, finish!: (value?: unknown) => void;
  const ready = new Promise((resolve) => { started = resolve; });
  const cancelled: unknown[] = [];
  const handler = createRequestHandler({ config: {}, projectAgent: {
    async prompt() { started(); await new Promise((resolve) => { finish = resolve; }); return { reply: "已停止" }; },
    async cancel(id: unknown) { cancelled.push(id); finish(); },
  } });
  const input = request("POST", "/api/projects/turn", { message: "你好", sessionId: "stream-session-12345" }); input.headers.accept = "application/x-ndjson";
  const response = new StreamingResponse(), pending = handler(input, response);
  await ready;
  response.destroyed = true; response.emit("close");
  await pending;
  assert.deepEqual(cancelled, ["stream-session-12345"]);
  assert.equal(response.text, "");
});

test("失败响应提供安全错误类别，不输出密钥或原始接口响应", async () => {
  const handler = createRequestHandler({
    config: { model: "mimo-v2.6-pro", llmConfigured: true, jevConfigured: false },
    providers: { generateDraft: async () => {
      throw new ProviderError("兼容模型域名暂时无法解析",
        { stage: "llm", reason: "dns", attempts: 3, causeCode: "ENOTFOUND" });
    }, judgeJev: null },
  });
  const response = await invoke(handler, "POST", "/api/requirements/turn",
    { message: "做一个助手" });
  const payload = JSON.parse(String(response.text));
  assert.equal(response.status, 502);
  assert.deepEqual(payload.diagnostic, { stage: "llm", reason: "dns",
    attempts: 3, causeCode: "ENOTFOUND", providerModel: "mimo-v2.6-pro" });
  assert.equal("draft" in payload, false);
});

test("项目接口拒绝外部网页请求与非本机 Host，不执行任何项目操作", async () => {
  let calls = 0;
  const handler = createRequestHandler({ config: {}, projects: { list: async () => { calls++; return []; } } });
  for (const headers of [
    { host: "127.0.0.1:3000", origin: "https://outside.example" },
    { host: "outside.example:3000" },
    { host: "127.0.0.1:3000", origin: "null" },
    { host: "127.0.0.1:3000", "sec-fetch-site": "cross-site" },
  ]) {
    const input = request("GET", "/api/projects"); input.headers = headers;
    const result: { status: number | null } = { status: null };
    await handler(input, { writeHead(status: number, headers: Record<string, unknown>) { result.status = status; }, end() {} });
    assert.equal(result.status, 403);
  }
  assert.equal(calls, 0);
});

test("项目变更要求 JSON 和明确移除确认，项目对话使用独立接口", async () => {
  let removed = false;
  const handler = createRequestHandler({ config: {},
    projects: { list: async () => [], remove: async () => { removed = true; return {}; } },
    projectAgent: { prompt: async (body: { message: unknown; }) => ({ engine: "pi", reply: body.message, projects: [] }) },
  });
  assert.equal((await invoke(handler, "POST", "/api/projects/test/remove", {})).status, 400);
  assert.equal(removed, false);
  assert.equal((await invoke(handler, "POST", "/api/projects/test/start")).status, 400);
  const result = await invoke(handler, "POST", "/api/projects/turn", { message: "查看项目", sessionId: "fixture-session-12345" });
  assert.equal(result.status, 200); assert.equal(JSON.parse(String(result.text)).engine, "pi");
});

test("删除失败透出恢复代码，仅移除记录仍要求确认并明确传给管理器", async () => {
  const calls: unknown[] = [];
  const handler = createRequestHandler({ config: {}, projects: { remove: async (id: unknown, options: { removeOnly: unknown; }) => {
    calls.push({ id, ...options });
    if (!options.removeOnly) throw Object.assign(new InputError("停止脚本不存在"), { code: "PROJECT_REMOVE_STOP_FAILED" });
    return { removed: true, servicesMayBeRunning: true };
  } } });
  const failed = await invoke(handler, "POST", "/api/projects/test/remove", { confirm: true });
  assert.equal(failed.status, 400); assert.equal(JSON.parse(String(failed.text)).code, "PROJECT_REMOVE_STOP_FAILED");
  assert.equal((await invoke(handler, "POST", "/api/projects/test/remove", { removeOnly: true })).status, 400);
  const result = await invoke(handler, "POST", "/api/projects/test/remove", { confirm: true, removeOnly: true });
  assert.equal(result.status, 200); assert.equal(JSON.parse(String(result.text)).project.servicesMayBeRunning, true);
  assert.deepEqual(calls, [{ id: "test", removeOnly: false }, { id: "test", removeOnly: true }]);
});
