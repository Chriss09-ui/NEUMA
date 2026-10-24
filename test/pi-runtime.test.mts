import { fixtureText } from "./helpers/m7-test-boundaries.mjs";
import { callFixture } from "./helpers/m7-test-boundaries.mjs";
import { dispatchModelEvent } from "./helpers/m7-test-boundaries.mjs";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ProjectTurn } from "../src/runtime/pi-port.mjs";
import type { FixtureModelRequest } from "./helpers/m7-test-boundaries.mjs";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import type { PiSessionPort } from "../src/runtime/pi-port.mjs";
import type { SessionMessage } from "../src/runtime/pi-port.mjs";
import { toolText } from "./helpers/m7-test-boundaries.mjs";
import { listeningAddress } from "./helpers/m7-test-boundaries.mjs";
import type { TestFailure } from "./helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiProjectAgent, createProjectTools, createProjectAnalyzer, createPiSession, classifyModelFailure } from "../src/runtime/pi-runtime.mjs";
import { ProjectManager } from "../src/projects/projects.mjs";
import { modelOutputBudget, knownModelLimits, developmentModelOutputBudget, architectureModelOutputBudget, resolvedModelProfile, modelProfileHash } from "../src/runtime/model-limits.mjs";
import { readPiStructuredSubmission } from "../src/runtime/pi-submission-contract.mjs";
import type { NeumaPiSession } from "../src/runtime/pi-port.mjs";
import type { UnknownRecord } from "../src/contracts/json.mjs";

const mimoConfig = Object.freeze({ chatUrl: "https://api.xiaomimimo.com/v1/chat/completions",
  model: "mimo-v2.6-pro", apiKey: "fixture-only" });
const flashConfig = Object.freeze({ ...mimoConfig, model: "mimo-v2.6-flash" });
const { DEFAULT_THINKING_LEVEL }: { DEFAULT_THINKING_LEVEL: Parameters<import("@earendil-works/pi-coding-agent").AgentSession["setThinkingLevel"]>[0] } = await import(new URL("./core/defaults.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);

async function capturePiPayload(session: NeumaPiSession) {
  const payloads: ({ "model": (unknown); "thinking": (unknown); "reasoningEffort": (unknown); "maxTokens": (unknown); "thinkingBudget": (unknown); })[] = [], stream = session.agent.streamFunction;
  session.settingsManager.setRetryEnabled(false); session.setAutoCompactionEnabled(false);
  session.agent.streamFunction = (model, context, options) => stream(model, context, { ...options!, onPayload: (payload) => {
    payloads.push({ model: objectFields(payload).model, thinking: objectFields(payload).thinking, reasoningEffort: objectFields(payload).reasoning_effort,
      maxTokens: objectFields(payload).max_tokens ?? objectFields(payload).max_completion_tokens, thinkingBudget: objectFields(payload).thinking_token_budget });
    throw new Error("OFFLINE_PAYLOAD_CAPTURE");
  } });
  await session.prompt("固定的离线参数检查");
  assert.equal(payloads.length, 1);
  return payloads[0];
}

test("研发按职责选择工作输出预算，模型最大能力不冒充每轮预算", () => {
  const known = { planner: 32768, developer: 65536, reviewer: 16384 }, fallback = { planner: 8192, developer: 16384, reviewer: 4096 };
  for (const config of [mimoConfig, flashConfig]) for (const role of (Object.keys(known) as (keyof typeof known)[])) {
    assert.equal(developmentModelOutputBudget(config, role), known[role]);
    assert.ok(developmentModelOutputBudget(config, role) < knownModelLimits!(config)!.maxOutputTokens);
    assert.equal(developmentModelOutputBudget({ ...config, model: "unknown" }, role), fallback[role]);
  }
  assert.equal(modelOutputBudget(mimoConfig), 4096);
  assert.throws(() => developmentModelOutputBudget(mimoConfig, "__proto__"));
});

test("模型错误分类区分连接、流协议、上下文和输出上限且不回传原始响应", () => {
  for (const [raw, reason] of [
    ["401 Invalid API key Bearer private-key-fixture", "api_authentication"],
    ["429 too many requests private-key-fixture", "api_rate_limit"],
    ["404 model_not_found private-key-fixture", "api_not_found"],
    ["503 Service unavailable private-key-fixture", "api_unavailable"],
    ["fetch failed private-key-fixture", "api_connection"],
    ["NEUMA_MODEL_IDLE_TIMEOUT private-key-fixture", "api_idle_timeout"],
    ["模型连续未返回响应数据，已停止等待；已有进度保留", "api_idle_timeout"],
    ["Provider finish_reason: network_error private-key-fixture", "api_connection"],
    ["Context overflow recovery failed private-key-fixture", "api_context"],
    ["Truncated response recovery failed private-key-fixture", "api_output_limit"],
    ["Stream ended without finish_reason private-key-fixture", "api_stream_interrupted"],
    ["terminated private-key-fixture", "api_stream_interrupted"],
    ["invalid stream json private-key-fixture", "api_protocol"],
    ["Provider finish_reason: content_filter private-key-fixture", "api_rejected"],
  ] as const) {
    const mapped = classifyModelFailure(raw);
    assert.equal(mapped.reason, reason);
    assert.doesNotMatch(JSON.stringify(mapped), /private-key|Bearer/);
  }
});

test("运行时拒绝无效输出预算，避免把预算错误发送到模型接口", async () => {
  for (const maxOutputTokens of [0, 255, 16_385, 4096.5, "8192"]) {
    await assert.rejects(callFixture(createPiSession, undefined, [{ customTools: [], maxOutputTokens }]), /输出预算应为/);
  }
  for (const config of [mimoConfig, flashConfig]) for (const maxOutputTokens of [131_073, 131_072.5, "131072"])
    await assert.rejects(callFixture(createPiSession, undefined, [{ config, customTools: [], maxOutputTokens }]), /输出预算应为 256 到 131072/);
});

test("共享输出预算使用调用方任务预算并受模型能力上限约束", () => {
  for (const config of [mimoConfig, flashConfig]) {
    assert.equal(modelOutputBudget(config), 4096);
    assert.equal(modelOutputBudget(config, 8192), 8192);
    assert.equal(modelOutputBudget(config, 999_999), 131_072);
    assert.equal(architectureModelOutputBudget(config, "designer"), 65536);
    assert.equal(architectureModelOutputBudget(config, "reviewer"), 16384);
    assert.equal(knownModelLimits!(config)!.contextWindow, 1_048_576);
    assert.equal(knownModelLimits!(config)!.reasoning, true);
  }
  assert.notEqual(modelProfileHash(knownModelLimits(flashConfig)), modelProfileHash(knownModelLimits(mimoConfig)));
  for (const config of [{ ...mimoConfig, model: "mimo-v2.6" },
    { ...flashConfig, model: "mimo-v2.6-flash-extra" },
    { ...flashConfig, model: "MIMO-V2.6-FLASH" },
    { ...flashConfig, model: "mimo-v2.6-pro-nonexistent" },
    { ...flashConfig, chatUrl: "https://other.xiaomimimo.com/v1/chat/completions" },
    { ...flashConfig, chatUrl: "https://api.xiaomimimo.com.other.test/v1/chat/completions" },
    { ...mimoConfig, chatUrl: "https://api.xiaomimimo.com.other.test/v1/chat/completions" },
    { ...mimoConfig, chatUrl: "https://proxy.example.test/v1/chat/completions" },
    { ...mimoConfig, chatUrl: "invalid" }, {}, undefined]) {
    assert.equal(modelOutputBudget(config!), 4096);
    assert.equal(modelOutputBudget(config!, 8192), 8192);
    assert.equal(knownModelLimits(config), null);
  }
});

test("MiMo 默认发送任务预算 4096，显式短探针仍发送 512且能力上限独立保存", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-pi-max-output-"));
  const requests: FixtureModelRequest[] = [];
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(String(Buffer.concat(chunks))); requests.push(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1,
      model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "完成" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
  t.after(async () => { await new Promise<void>((done, reject) => model.close(error => error ? reject(error) : done())); await rm(root, { recursive: true, force: true }); });
  for (const config of [mimoConfig, flashConfig]) for (const maxOutputTokens of [undefined, 512]) {
    const session = await createPiSession({ config, cwd: root, dataDir: join(root, "data"),
      customTools: [], systemPrompt: "fixture", ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) });
    try {
      const expected = maxOutputTokens ?? 4096;
      assert.equal(session.model!.maxTokens, expected);
      assert.equal(session.modelProfile.maxOutputTokens, 131_072);
      assert.equal(session.modelProfileHash, modelProfileHash(resolvedModelProfile(config)));
      assert.equal(session.settingsManager.getCompactionSettings(session.model).reserveTokens,
        16_384);
      // Exercise the real SDK request with the registered MiMo profile against this local fixture.
      await session.setModel({ ...session.model!, baseUrl: `http://127.0.0.1:${listeningAddress(model).port}/v1` });
      await session.prompt("生成方案");
      const body = requests.at(-1);
      assert.equal(objectFields(body).model, config.model);
      assert.equal(objectFields(body).max_completion_tokens, expected);
      assert.equal(objectFields(body).max_tokens, undefined);
      assert.deepEqual(objectFields(body).thinking, { type: "disabled" });
      assert.equal(session.getLastAssistantText(), "完成");
    } finally { session.dispose(); }
  }
  assert.equal(requests.length, 4);
});

for (const reasoningConfig of [mimoConfig, flashConfig]) test(`${reasoningConfig.model}思考模式复用Pi原生工具循环及私有持久会话，未知模型不猜测协议`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-pi-reasoning-")), requests: FixtureModelRequest[] = [], diagnostics: ({  })[] = [];
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(String(Buffer.concat(chunks))); requests.push(body);
    const first = requests.length === 1;
    const delta = first ? { role: "assistant", reasoning_content: "fixture-only-private-reasoning", tool_calls: [{ index: 0, id: "fixture_call", type: "function",
      function: { name: "inspect_fixture", arguments: "{}" } }] } : { role: "assistant", content: "完成" };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
  t.after(async () => { model.closeAllConnections(); await new Promise<void>((done, reject) => model.close(error => error ? reject(error) : done())); await rm(root, { recursive: true, force: true }); });
  const storage = { directory: join(root, "sessions"), binding: { task: "fixed-reasoning-recovery", version: 1 } };
  const session = await createPiSession({ config: reasoningConfig, cwd: root, dataDir: root, systemPrompt: "fixture", reasoningMode: "auto", maxOutputTokens: 512,
    sessionStorage: storage,
    onToolDiagnostic: (entry) => diagnostics.push(entry), customTools: [{ name: "inspect_fixture", label: "读取固定数据", description: "读取固定数据",
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
      execute: async (): Promise<import("../src/contracts/tools.mjs").ToolResult> => ({ content: [{ type: "text", text: '{"ok":true}' }], details: {} }) }] });
  try {
    assert.equal(session.model!.reasoning, true);
    await session.setModel({ ...session.model!, baseUrl: `http://127.0.0.1:${listeningAddress(model).port}/v1` });
    await session.prompt("读取固定数据");
    assert.equal(requests.length, 2);
    for (const body of requests) {
      assert.equal(objectFields(body).model, reasoningConfig.model);
      assert.deepEqual(objectFields(body).thinking, { type: "enabled" }); assert.equal(objectFields(body).reasoning_effort, "medium");
      assert.equal(objectFields(body).max_completion_tokens, 512);
    }
    assert.equal(requests[1]!.messages.find((entry) => entry.role === "assistant")!.reasoning_content, "fixture-only-private-reasoning");
    assert.equal(session.getLastAssistantText(), "完成"); assert.doesNotMatch(JSON.stringify(diagnostics), /fixture-only-private-reasoning/u);
  } finally { session.dispose(); }
  const savedFile = session.sessionFile!;
  assert.equal((await stat(savedFile)).mode & 0o777, 0o600);
  for (const reasoningMode of ["auto", "off"] as const) {
    const before: number = requests.length;
    const resumed = await createPiSession({ config: reasoningConfig, cwd: root, dataDir: root, systemPrompt: "fixture", reasoningMode, maxOutputTokens: 512,
      sessionStorage: { ...storage, file: savedFile }, customTools: [] });
    try {
      assert.equal(resumed.sessionFile, savedFile);
      await resumed.setModel({ ...resumed.model!, baseUrl: `http://127.0.0.1:${listeningAddress(model).port}/v1` });
      await resumed.prompt("继续原任务");
      assert.equal(requests.length, before + 1);
      assert.equal(requests.at(-1)!.model, reasoningConfig.model);
      assert.deepEqual(requests.at(-1)!.thinking, { type: reasoningMode === "auto" ? "enabled" : "disabled" });
      assert.equal(requests.at(-1)!.messages.find((entry) => entry.role === "assistant")!.reasoning_content, "fixture-only-private-reasoning");
      assert.equal(resumed.getLastAssistantText(), "完成");
    } finally { resumed.dispose(); }
  }
  const unknown = await createPiSession({ config: { ...reasoningConfig, model: "unknown-fixture" }, cwd: root, dataDir: root,
    customTools: [], systemPrompt: "fixture", reasoningMode: "auto", maxOutputTokens: 512 });
  try { assert.equal(unknown.model!.reasoning, false); } finally { unknown.dispose(); }
  await assert.rejects(callFixture(createPiSession, undefined, [{ config: reasoningConfig, reasoningMode: "unsupported" }]), /思考配置/u);
});

test("auto采用锁定Pi默认档位，官方与显式网关的原生payload不强制high且输出额度不变", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-pi-default-effort-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = { chatUrl: "https://gateway.example.test/v1/chat/completions", model: "reasoning-alias" };
  const gateway = { ...target, apiKey: "fixture-only", modelProfile: { schemaVersion: 1, target, api: "openai-completions",
    contextWindow: 1_048_576, maxOutputTokens: 131_072, reasoning: true, input: ["text"],
    compat: { thinkingFormat: "deepseek", supportsReasoningEffort: true, maxTokensField: "max_completion_tokens" } } };
  let networkCalls = 0;
  for (const config of [mimoConfig, gateway]) for (const reasoningMode of ["auto", "off"] as const) {
    const session = await createPiSession({ config, cwd: root, dataDir: root, customTools: [], systemPrompt: "fixture",
      reasoningMode, maxOutputTokens: 16384, beforeModelRequest: () => { networkCalls++; throw new Error("NETWORK_FORBIDDEN"); } });
    try {
      assert.equal(session.thinkingLevel, reasoningMode === "auto" ? DEFAULT_THINKING_LEVEL : "off");
      const payload = await capturePiPayload(session);
      assert.equal(payload!.model, config.model); assert.equal(payload!.maxTokens, 16384);
      assert.deepEqual(payload!.thinking, { type: reasoningMode === "auto" ? "enabled" : "disabled" });
      assert.equal(payload!.reasoningEffort, reasoningMode === "auto" ? DEFAULT_THINKING_LEVEL : undefined);
      assert.equal(payload!.thinkingBudget, undefined, "未声明独立思考额度时不能假造正文预留");
    } finally { session.dispose(); }
  }
  assert.equal(networkCalls, 0);
});

test("架构加大输出额度仍用默认medium，真实SDK参数不伪造独立思考额度", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-pi-architecture-output-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let networkCalls = 0;
  for (const role of ["designer", "specialist", "reviewer"]) {
    const session = await createPiSession({ config: mimoConfig, cwd: root, dataDir: root, customTools: [], systemPrompt: "fixture",
      reasoningMode: role === "reviewer" ? "off" : "auto", maxOutputTokens: architectureModelOutputBudget(mimoConfig, role),
      beforeModelRequest: () => { networkCalls++; throw new Error("NETWORK_FORBIDDEN"); } });
    try {
      const payload = await capturePiPayload(session);
      assert.equal(payload!.maxTokens, { designer: 65536, specialist: 32768, reviewer: 16384 }[role]);
      assert.deepEqual(payload!.thinking, { type: role === "reviewer" ? "disabled" : "enabled" });
      assert.equal(payload!.reasoningEffort, role === "reviewer" ? undefined : DEFAULT_THINKING_LEVEL);
      assert.equal(payload!.thinkingBudget, undefined);
    } finally { session.dispose(); }
  }
  assert.equal(networkCalls, 0);
});

test("旧持久会话high和off按新auto策略追加原生档位，消息绑定与已有预算metadata不重置", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-pi-old-effort-")), directory = join(root, "sessions"), binding = { task: "same-task", version: 1 };
  t.after(() => rm(root, { recursive: true, force: true }));
  let networkCalls = 0;
  const options = { config: mimoConfig, cwd: root, dataDir: root, customTools: [], systemPrompt: "fixture", maxOutputTokens: 16384,
    beforeModelRequest: () => { networkCalls++; throw new Error("NETWORK_FORBIDDEN"); } };
  const original = await createPiSession({ ...options, reasoningMode: "auto", sessionStorage: { directory, binding } });
  original.setThinkingLevel("high");
  original.sessionManager.appendCustomEntry("fixture-existing-budget", { used: 7, limit: 12 });
  original.sessionManager.appendMessage({ role: "user", content: "已有任务材料", timestamp: 1 });
  const file = original.sessionFile!, bindingHash = original.sessionBindingHash;
  original.dispose();
  for (const reasoningMode of ["auto", "off", "auto"] as const) {
    const before = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(String(line)));
    const restored = await createPiSession({ ...options, reasoningMode, sessionStorage: { directory, binding, file } });
    try {
      const expected = reasoningMode === "auto" ? DEFAULT_THINKING_LEVEL : "off";
      assert.equal(restored.sessionFile, file); assert.equal(restored.sessionBindingHash, bindingHash);
      assert.equal(restored.thinkingLevel, expected);
      const after = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(String(line)));
      assert.deepEqual(after.slice(0, before.length), before, "旧历史只能追加，不能改写或删除");
      assert.equal(after.findLast((entry) => entry.type === "thinking_level_change").thinkingLevel, expected);
      assert.deepEqual(after.find((entry) => entry.customType === "fixture-existing-budget").data, { used: 7, limit: 12 });
      assert.ok(restored.messages.some((message) => message.role === "user" && message.content === "已有任务材料"));
      const payload = await capturePiPayload(restored);
      assert.equal(payload!.reasoningEffort, reasoningMode === "auto" ? DEFAULT_THINKING_LEVEL : undefined);
      assert.equal(payload!.maxTokens, 16384); assert.equal((await stat(file)).mode & 0o777, 0o600);
    } finally { restored.dispose(); }
  }
  assert.equal(networkCalls, 0);
});

test("真实 SDK 将直接图片和工具页图传给当前模型，不被 text-only 登记省略", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-pi-images-")), requests: FixtureModelRequest[] = [];
  const image: Extract<import("../src/contracts/tools.mjs").ToolResult["content"][number], { type: "image" }> = { type: "image", mimeType: "image/png", data: (await readFile(new URL("../public/assets/brand/neuma-mark.png", import.meta.url))).toString("base64") };
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(String(Buffer.concat(chunks))); requests.push(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const toolCall = body.tools?.length && !body.messages.some((message: { role: string; }) => message.role === "tool");
    const delta = toolCall ? { role: "assistant", tool_calls: [{ index: 0, id: "page-image", type: "function",
      function: { name: "read_material_image", arguments: JSON.stringify({ page: 3 }) } }] } : { role: "assistant", content: "图像已收到" };
    response.end(`data: ${JSON.stringify({ id: "image-fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model",
      choices: [{ index: 0, delta, finish_reason: toolCall ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
  t.after(async () => { await new Promise<void>((done, reject) => model.close(error => error ? reject(error) : done())); await rm(root, { recursive: true, force: true }); });
  const chatUrl = `http://127.0.0.1:${listeningAddress(model).port}/v1/chat/completions`;
  const config = { chatUrl, model: "fixture-model", apiKey: "fixture-only", modelProfile: {
    schemaVersion: 1, target: { chatUrl, model: "fixture-model" }, api: "openai-completions", contextWindow: 32768,
    maxOutputTokens: 16384, reasoning: false, input: ["text", "image"], compat: { maxTokensField: "max_tokens" },
  } };
  const direct = await createPiSession({ config, cwd: root, dataDir: join(root, "direct"), customTools: [], systemPrompt: "fixture" });
  try {
    assert.deepEqual(direct.model!.input, ["text", "image"]);
    await direct.prompt("查看当前图片", { images: [image] });
    assert.equal(direct.getLastAssistantText(), "图像已收到");
    const content = requests[0]!.messages.findLast((message) => message.role === "user")!.content;
    assert.ok(Array.isArray(content) && content.some((value) => value.type === "image_url" && value.image_url!.url.startsWith("data:image/png;base64,")));
  } finally { direct.dispose(); }
  const page = await createPiSession({ config, cwd: root, dataDir: join(root, "page"), systemPrompt: "fixture", customTools: [{
    name: "read_material_image", label: "读取页图", description: "读取本地材料页图", parameters: { type: "object", properties: { page: { type: "integer" } }, required: ["page"] },
    execute: async (_id: string, params: unknown): Promise<import("../src/contracts/tools.mjs").ToolResult> => { assert.equal(objectFields(params).page, 3); return { content: [{ type: "text", text: "附件 file-1，第 3 页" }, image], details: {} }; },
  }] });
  try {
    await page.prompt("读取第3页图表");
    assert.equal(page.getLastAssistantText(), "图像已收到");
    const body = requests.at(-1);
    assert.ok(body!.messages.some((message) => message.role === "tool" && String(message.content).includes("第 3 页")));
    assert.ok(body!.messages.some((message) => message.role === "user" && Array.isArray(message.content)
      && message.content.some((value) => value.type === "image_url" && value.image_url!.url.startsWith("data:image/png;base64,"))));
    assert.doesNotMatch(JSON.stringify(body!.messages), /image omitted/);
  } finally { page.dispose(); }
});

test("运行层只对已核实的 MiMo 型号使用真实上下文和接口参数，未知型号保留保守容量", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-pi-limits-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [chatUrl, model, known] of [
    ["https://api.xiaomimimo.com/v1/chat/completions", "mimo-v2.6-pro", true],
    ["https://api.xiaomimimo.com/v1/chat/completions", "mimo-v2.6-flash", true],
    ["https://other.xiaomimimo.com/v1/chat/completions", "mimo-v2.6-flash", false],
    ["http://127.0.0.1:1/v1/chat/completions", "mimo-v2.6-flash", false],
    ["https://api.xiaomimimo.com/v1/chat/completions", "unknown-fixture", false],
    ["http://127.0.0.1:1/v1/chat/completions", "mimo-v2.6-pro", false],
  ] as const) {
    const session = await createPiSession({ config: { chatUrl, model, apiKey: "fixture-only" },
      cwd: root, dataDir: join(root, "data"), customTools: [], systemPrompt: "fixture", maxOutputTokens: 8192 });
    try {
      assert.equal(session.model!.contextWindow, known ? 1_048_576 : 32_768);
      assert.equal(session.model!.maxTokens, 8192);
      assert.equal(objectFields(session.model!.compat).maxTokensField, known ? undefined : "max_tokens");
      assert.equal(objectFields(session.model!.compat).requiresReasoningContentOnAssistantMessages, known ? true : undefined);
      assert.equal(objectFields(session.model!.compat).thinkingFormat, known ? "deepseek" : undefined);
      const compaction = session.settingsManager.getCompactionSettings(session.model);
      assert.equal(compaction.reserveTokens, known ? 16_384 : 12_288);
      assert.equal(compaction.keepRecentTokens, known ? 20_000 : 10_240);
      assert.ok(compaction.keepRecentTokens + session.model!.maxTokens < session.model!.contextWindow - compaction.reserveTokens);
      assert.equal(session.settingsManager.getHttpIdleTimeoutMs(), 0);
      if (!known) {
        assert.deepEqual(session.model!.input, ["text"]);
        await assert.rejects(session.prompt("图片", { images: [{ type: "image", data: "", mimeType: "image/png" }] }), /未声明支持图片/);
      }
    } finally { session.dispose(); }
  }
});

test("32k 未知模型的 18k 输入不会被旧压缩阈值提前摘要或挤占 8192 输出预算", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-pi-input-budget-"));
  const message = "x".repeat(72_000);
  const requests: FixtureModelRequest[] = [];
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(String(Buffer.concat(chunks))); requests.push(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1,
      model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant", content: "完成" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 18_000, completion_tokens: 1, total_tokens: 18_001 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
  const session = await createPiSession({ config: { chatUrl: `http://127.0.0.1:${listeningAddress(model).port}/v1/chat/completions`, model: "fixture-model", apiKey: "fixture-only" },
    cwd: root, dataDir: join(root, "data"), customTools: [], systemPrompt: "fixture", maxOutputTokens: 8192 });
  t.after(async () => { session.dispose(); await new Promise<void>((done, reject) => model.close(error => error ? reject(error) : done())); await rm(root, { recursive: true, force: true }); });
  await session.prompt(message);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.max_tokens, 8192);
  assert.ok(requests[0]!.messages.some((entry) => entry.role === "user"
    && (typeof entry.content === "string" ? entry.content : entry.content.map((block) => block.text || "").join("")) === message));
  assert.equal(session.getLastAssistantText(), "完成");
});

test("DeepSeek、GLM 和网关别名共用原生能力参数，保留不支持关闭思考的声明", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-pi-generic-profile-")), requests: FixtureModelRequest[] = [];
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(String(Buffer.concat(chunks))); requests.push(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { content: "完成" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
  t.after(async () => { model.closeAllConnections(); await new Promise<void>((done, reject) => model.close(error => error ? reject(error) : done())); await rm(root, { recursive: true, force: true }); });
  const local = `http://127.0.0.1:${listeningAddress(model).port}/v1`;
  const aliasTarget = { chatUrl: local + "/chat/completions", model: "gateway-alias" };
  for (const config of [
    { chatUrl: "https://api.deepseek.com/chat/completions", model: "deepseek-v4-pro" },
    { chatUrl: "https://api.z.ai/api/coding/paas/v4/chat/completions", model: "glm-5.3" },
    { ...aliasTarget, modelProfile: { schemaVersion: 1, target: aliasTarget, api: "openai-completions", contextWindow: 65536,
      maxOutputTokens: 9000, reasoning: true, input: ["text"], compat: { maxTokensField: "max_tokens", thinkingFormat: "zai", supportsReasoningEffort: false } } },
  ]) for (const reasoningMode of ["auto", "off"] as const) {
    const session = await createPiSession({ config: { ...config, apiKey: "fixture-only" }, cwd: root, dataDir: root,
      customTools: [], systemPrompt: "fixture", maxOutputTokens: 512, reasoningMode });
    try {
      assert.equal(session.model!.reasoning, true); assert.deepEqual(session.model!.input, ["text"]);
      await session.setModel({ ...session.model!, baseUrl: local });
      await session.prompt("固定本地请求");
      const body = requests.at(-1);
      assert.equal(objectFields(body).max_tokens, 512); assert.equal(objectFields(body).max_completion_tokens, undefined);
      const forcedThinking = config.model === "glm-5.3";
      assert.equal(objectFields(objectFields(body).thinking).type, reasoningMode === "auto" || forcedThinking ? "enabled" : "disabled");
      if (forcedThinking) {
        assert.equal(session.modelProfile!.thinkingLevelMap!.off, null);
        assert.equal(session.modelProfile!.thinkingLevelMap![DEFAULT_THINKING_LEVEL], null);
        assert.equal(session.thinkingLevel, reasoningMode === "auto" ? "high" : "low");
        assert.equal(objectFields(body).reasoning_effort, session.thinkingLevel);
      }
      assert.equal(session.getLastAssistantText(), "完成");
    } finally { session.dispose(); }
  }
  assert.equal(requests.length, 6);
});

test("能力配置不能绕过完整结束标志，完整JSON正文缺finish_reason仍不能提交", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-profile-finish-reason-"));
  let calls = 0, submissions = 0;
  const model = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the fixed request. */ }
    calls++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0,
      delta: { content: '{"value":true}' }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
  t.after(async () => { model.closeAllConnections(); await new Promise<void>((done, reject) => model.close(error => error ? reject(error) : done())); await rm(root, { recursive: true, force: true }); });
  const target = { chatUrl: `http://127.0.0.1:${listeningAddress(model).port}/v1/chat/completions`, model: "fixture-model" };
  const tool = { name: "submit_result", label: "提交", description: "提交", parameters: {
    type: "object", properties: { value: { type: "boolean" } }, required: ["value"], additionalProperties: false },
  execute: async () => { submissions++; return { content: [], details: {}, terminate: true }; } };
  const config = { ...target, apiKey: "fixture-only", modelProfile: { schemaVersion: 1, target, api: "openai-completions",
    contextWindow: 32768, maxOutputTokens: 8192, reasoning: false, input: ["text"], compat: { supportsFinishReason: true } } };
  const session = await createPiSession({ config, cwd: root, dataDir: root, customTools: [tool], systemPrompt: "fixture" });
  try {
    session.settingsManager.setRetryEnabled(false);
    assert.equal(objectFields(session.model!.compat).supportsFinishReason, true);
    assert.equal(session.modelProfile.platformRequirements.completeResponseFinishReason, true);
    await session.prompt("固定提交");
    const last = session.messages.findLast((message) => message.role === "assistant");
    assert.equal(last!.stopReason!, "error");
    assert.equal(readPiStructuredSubmission(last, { tools: [tool] }), null);
    assert.equal(calls, 1); assert.equal(submissions, 0);
  } finally { session.dispose(); }
});

test("真实 SDK 遇到半截响应会重试当前模型轮，完整提交只执行一次并直接结束", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-pi-stream-retry-"));
  const requests: FixtureModelRequest[] = [];
  let submissions = 0;
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(String(Buffer.concat(chunks))));
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: { role?: string; tool_calls?: { index: number; id: string; type: string; function: { name: string; arguments: string; }; }[]; }, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1,
      model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: "assistant", tool_calls: [{ index: 0, id: `submit-${requests.length}`, type: "function",
      function: { name: "submit_result", arguments: JSON.stringify({ result: requests.length === 1 ? "partial-fixture" : "complete" }) } }] });
    if (requests.length > 1) chunk({}, "tool_calls");
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
  const session = await createPiSession({ config: { chatUrl: `http://127.0.0.1:${listeningAddress(model).port}/v1/chat/completions`, model: "fixture-model", apiKey: "fixture-only" },
    cwd: root, dataDir: join(root, "data"), systemPrompt: "fixture", customTools: [{ name: "submit_result", label: "提交", description: "提交",
      parameters: { type: "object", properties: { result: { type: "string" } }, required: ["result"] },
      async execute(_id: unknown, args: unknown) : Promise<import("../src/contracts/tools.mjs").ToolResult> { submissions++; assert.equal(objectFields(args).result, "complete"); return { content: [{ type: "text", text: "saved" }], details: {}, terminate: true }; } }] });
  t.after(async () => { session.dispose(); await new Promise<void>((done, reject) => model.close(error => error ? reject(error) : done())); await rm(root, { recursive: true, force: true }); });
  const events: ((import("@earendil-works/pi-coding-agent").AgentSessionEvent))[] = []; session.subscribe((event) => events.push(event));
  await session.prompt("生成方案");
  assert.equal(requests.length, 2); assert.equal(submissions, 1);
  assert.equal(JSON.stringify(requests[1]!.messages).includes("partial-fixture"), false);
  assert.equal(events.filter((event) => event.type === "auto_retry_start").length, 1);
  assert.ok(events.some((event) => event.type === "auto_retry_end" && event.success));
  assert.equal(session.messages!.at(-1)!.role, "toolResult");
});

test("真实 SDK 对 429 暂时限流重试，对认证错误直接结束，均不叠加底层重试", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-pi-http-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const status of [429, 401]) {
    let requests = 0;
    const model = createServer(async (request, response) => {
      for await (const _chunk of request) {} requests++;
      if (requests === 1) {
        response.writeHead(status, { "content-type": "application/json" });
        return response.end(JSON.stringify({ error: { message: status === 429 ? "rate limit exceeded" : "authentication failed", type: "fixture-error" } }));
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model",
        choices: [{ index: 0, delta: { role: "assistant", content: "完成" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
    const session = await createPiSession({ config: { chatUrl: `http://127.0.0.1:${listeningAddress(model).port}/v1/chat/completions`, model: "fixture-model", apiKey: "fixture-only" },
      cwd: root, dataDir: join(root, "data"), customTools: [], systemPrompt: "fixture" });
    try {
      const events: ((import("@earendil-works/pi-coding-agent").AgentSessionEvent))[] = []; session.subscribe((event) => events.push(event));
      await session.prompt("生成方案");
      assert.equal(requests, status === 429 ? 2 : 1);
      assert.equal(events.filter((event) => event.type === "auto_retry_start").length, status === 429 ? 1 : 0);
      assert.equal(objectFields(session.messages!.at(-1)!).stopReason, status === 429 ? "stop" : "error");
    } finally { session.dispose(); await new Promise<void>((done, reject) => model.close(error => error ? reject(error) : done())); }
  }
});

test("真实SDK读取停滞的错误正文时按无响应停止，不重复付费请求", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-pi-idle-error-"));
  let requests = 0;
  const model = createServer(async (request, response) => {
    for await (const _chunk of request) {} requests++;
    response.writeHead(401, { "content-type": "application/json" }); response.flushHeaders();
  });
  await new Promise<void>(done => model.listen(0, "127.0.0.1", done));
  t.after(async () => { model.closeAllConnections(); await new Promise<void>((done, reject) => model.close(error => error ? reject(error) : done())); await rm(root, { recursive: true, force: true }); });
  const session = await createPiSession({ config: { chatUrl: `http://127.0.0.1:${listeningAddress(model).port}/v1/chat/completions`,
    model: "fixture-model", apiKey: "fixture-only", llmIdleTimeoutMs: 100 },
    cwd: root, dataDir: root, customTools: [], systemPrompt: "fixture" });
  const events: (("agent_end" | "agent_start" | "turn_start" | "turn_end" | "message_start" | "message_update" | "message_end" | "tool_execution_start" | "tool_execution_update" | "tool_execution_end" | "agent_settled" | "queue_update" | "compaction_start" | "entry_appended" | "session_info_changed" | "thinking_level_changed" | "compaction_end" | "auto_retry_start" | "auto_retry_end" | "summarization_retry_scheduled" | "summarization_retry_attempt_start" | "summarization_retry_finished" | "bash_execution_update"))[] = []; session.subscribe(event => events.push(event.type));
  try {
    await assert.rejects(session.prompt("fixture"), (error: TestFailure) => error.diagnostic?.reason === "api_idle_timeout");
    assert.equal(requests, 1); assert.equal(events.filter(type => type === "auto_retry_start").length, 0);
  } finally { session.dispose(); }
});

test("真实 Pi SDK 接通兼容模型流、调用登记工具并连续查询", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-pi-test-"));
  const app = join(root, "app"); await mkdir(app); await writeFile(join(app, "index.html"), "<p>fixture</p>");
  const requests: FixtureModelRequest[] = [];
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(String(Buffer.concat(chunks))); requests.push(body);
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer fixture-only");
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.max_tokens, 4096);
    assert.deepEqual(body.tools.map((item: { function: { name: unknown; }; }) => item.function.name).sort(), ["add_project", "get_runtime_status", "inspect_project", "list_ports", "list_project_failures", "list_projects", "remove_project", "start_project", "stop_project"]);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: { role?: string; tool_calls?: { index: number; id: string; type: string; function: { name: string; arguments: string; }; }[]; content?: string; }, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1,
      model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    const count = requests.length;
    if (count === 1 || count === 3) {
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${count}`, type: "function",
        function: { name: count === 1 ? "add_project" : "list_projects", arguments: count === 1 ? JSON.stringify({ path: app, name: "测试网页" }) : "{}" } }] });
      chunk({}, "tool_calls");
    } else { chunk({ role: "assistant", content: count === 2 ? "已添加测试网页。" : "项目仍然在列表中。" }); chunk({}, "stop"); }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
  const manager = new ProjectManager({ dataDir: join(root, "data") });
  const agent = fixtureProjectAgent({ config: { llmConfigured: true, chatUrl: `http://127.0.0.1:${listeningAddress(model).port}/v1/chat/completions`,
    model: "fixture-model", apiKey: "fixture-only", llmTimeoutMs: 5000 }, manager, cwd: root, dataDir: join(root, "data") });
  t.after(async () => { await agent.dispose(); await manager.dispose(); await new Promise<void>((done, reject) => model.close(error => error ? reject(error) : done())); await rm(root, { recursive: true, force: true }); });
  const progress: Record<string, unknown>[] = [];
  const first = await agent.prompt({ message: `添加 ${app}`, sessionId: "fixture-session-12345" }, (event) => progress.push(event));
  const actualSession = agent.sessions!.get("fixture-session-12345")!.session!; assert.ok(actualSession instanceof AgentSession);
  const settings = actualSession.settingsManager;
  assert.equal(settings.getRetrySettings().enabled, true);
  assert.equal(settings.getRetrySettings().maxRetries, 5);
  assert.equal(settings.getHttpIdleTimeoutMs(), 0);
  assert.equal(first.engine, "pi"); assert.equal(first.projects.length, 1);
  assert.equal(first.actions![0]!.tool, "add_project"); assert.match(fixtureText(first.reply), /已添加/);
  const second = await agent.prompt({ message: "看看刚才的项目", sessionId: "fixture-session-12345" });
  assert.equal(second.projects.length, 1); assert.match(fixtureText(second.reply), /仍然/);
  assert.ok(requests[2]!.messages.some((entry) => entry.role === "tool"));
  assert.equal(first.projects![0]!.allowLaunch, false);
  assert.ok(progress.some((event) => event.type === "text-delta" && fixtureText(event.delta).includes("已添加")));
  assert.ok(progress.some((event) => event.type === "status" && event.label === "正在添加并配置项目…"));
});

test("项目进度只发送显示文本与操作状态，不转发思考原文或工具参数", async () => {
  let listener: Parameters<NonNullable<PiSessionPort["subscribe"]>>[0];
  const progress: Record<string, unknown>[] = [];
  const session = {
    subscribe(fn: Parameters<NonNullable<PiSessionPort["subscribe"]>>[0]) { listener = fn; return () => {}; },
    async prompt() {
      dispatchModelEvent(listener, { type: "message_start", message: { role: "assistant" } });
      dispatchModelEvent(listener, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private-thought" } });
      dispatchModelEvent(listener, { type: "tool_execution_start", toolName: "list_projects", args: { secret: "private-tool-input" } });
      dispatchModelEvent(listener, { type: "tool_execution_end", result: { secret: "private-tool-result" } });
      dispatchModelEvent(listener, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "项目已列出。" } });
    },
    messages: [] as SessionMessage[], getLastAssistantText: () => "项目已列出。", dispose() {}, async abort() {},
  };
  const agent = fixtureProjectAgent({ config: { llmConfigured: true }, manager: { list: async () => [] }, sessionFactory: async () => session });
  await agent.prompt({ message: "查看项目", sessionId: "stream-session-12345" }, (event) => progress.push(event));
  assert.equal(JSON.stringify(progress).includes("private-"), false);
  assert.ok(progress.some((event) => event.label === "正在查看项目…"));
  assert.equal(progress.at(-1)!.delta, "项目已列出。");
  await agent.dispose();
});

test("模型不能借项目文字登记用户本轮没有提供的路径", async () => {
  let added = false;
  const turn: ProjectTurn & { toolCalls?: number } = { message: "看看已有项目", toolCalls: 0, actions: [] };
  const tools = createProjectTools({ add: async () => { added = true; assert.fail("无授权路径不能调用添加"); } }, turn);
  await assert.rejects(tools.find!((item) => item.name === "add_project")!.execute("call", { path: "/tmp/unrequested" }), /本轮明确提供/);
  assert.equal(added, false);
});

test("新项目添加失败不会报告已登记或生成成功操作，也不会自行再试", async () => {
  let listener: Parameters<NonNullable<PiSessionPort["subscribe"]>>[0], calls = 0;
  const manager = { list: async () => [], add: async () => {
    calls++;
    throw Object.assign(new Error("private-api-payload"), { code: "PROJECT_ADD_FAILED", reason: "api_error" });
  } };
  const agent = fixtureProjectAgent({ config: { llmConfigured: true }, manager,
    sessionFactory: async ({ turn }) => {
      const add = createProjectTools(manager, turn!).find((tool) => tool.name === "add_project");
      return { messages: [{ role: "assistant", stopReason: "aborted" }], subscribe(fn: Parameters<NonNullable<PiSessionPort["subscribe"]>>[0]) { listener = fn; return () => {}; },
        dispose() {}, async abort() {},
        async prompt() {
          const result = JSON.parse(String(toolText((await add!.execute!("add", { path: "/new/project" })))));
          assert.equal(result.added, false); assert.equal(result.id, undefined);
          dispatchModelEvent(listener, { type: "tool_execution_end" });
          await assert.rejects(add!.execute!("repeat", { path: "/new/project" }), /等待用户/);
        },
      };
    },
  });
  const result = await agent.prompt({ message: "添加 /new/project", sessionId: "failed-new-project-session" });
  assert.equal(calls, 1); assert.equal(result.projects.length, 0); assert.equal(result.actions.length, 0);
  assert.match(fixtureText(result.reply), /添加失败.*稍后再试/); assert.doesNotMatch(fixtureText(result.reply), /private-api-payload|已经添加|已登记/);
  assert.equal(agent.sessions.size, 0);
});

test("项目助手删除要求明确确认与有效目标，返回已删除记录和文件保留结果", async () => {
  const removed: ((unknown))[] = [], turn: ProjectTurn = { message: "删除会议纪要", actions: [] };
  const tool = createProjectTools({ list: async () => [{ id: "one", name: "会议纪要" }],
    remove: async (id) => { removed.push(id); return { removed: true }; } }, turn).find((tool) => tool.name === "remove_project");
  await assert.rejects(tool!.execute!("call", { id: "one", confirm: false }), /先确认/);
  await assert.rejects(tool!.execute!("call", { id: "missing", confirm: true }), /没有找到/);
  assert.deepEqual(removed, []);
  const result = JSON.parse(String(toolText((await tool!.execute!("call", { id: "one", confirm: true })))));
  assert.deepEqual(removed, ["one"]);
  assert.deepEqual(result, { removed: true, id: "one", name: "会议纪要", filesKept: true });
  assert.equal(turn.actions![0]!.tool, "remove_project");
});

test("项目助手可以只读查询失败原因，不重新添加项目", async () => {
  const records = [{ name: "示例项目", message: "添加失败：缺少启动入口。项目未加入列表。" }];
  const turn: ProjectTurn & { toolCalls?: number } = { actions: [] };
  const tool = createProjectTools({ failures: async ({ limit }) => { assert.equal(limit, 3); return records; } }, turn)
    .find((item) => item.name === "list_project_failures");
  const result = JSON.parse(String(toolText((await tool!.execute!("failures", { limit: 3 })))));
  assert.deepEqual(result.failures, records); assert.deepEqual(turn.actions, []);
});

test("运行查询按快照筛选外部运行与未运行项目，保留不确定性且不记录为操作", async () => {
  const controller = new AbortController();
  const snapshot = { checkedAt: "2026-10-04T00:00:00.000Z", summary: { total: 3, running: 1, stopped: 1, unknown: 1 },
    warnings: ["部分进程不可见"], projects: [
      { id: "outside", status: "stopped", runtime: { state: "running", source: "external" } },
      { id: "idle", runtime: { state: "stopped", source: "none" } },
      { id: "hidden", runtime: { state: "unknown", source: "none" } },
    ] };
  const turn: ProjectTurn & { toolCalls?: number } = { actions: [] };
  const tool = createProjectTools({ runtime: async ({ signal }) => {
    assert.equal(signal, controller.signal); return snapshot;
  } }, turn).find((tool) => tool.name === "get_runtime_status");
  const result = JSON.parse(String(toolText((await tool!.execute!("query", { state: "running" }, controller.signal)))));
  assert.deepEqual(result.projects.map((item: { id: unknown; }) => item.id), ["outside"]);
  assert.equal(result.projects[0].runtime.source, "external");
  assert.deepEqual(result.warnings, snapshot.warnings);
  assert.deepEqual(result.summary, snapshot.summary);
  assert.deepEqual(turn.actions, []);
  await assert.rejects(tool!.execute!("invalid", { state: "invented" }), /有效的项目状态/);
});

test("端口查询可组合端口和名称条件，空结果保留范围与警告，不执行项目操作", async () => {
  let reads = 0;
  const turn: ProjectTurn & { toolCalls?: number } = { actions: [] };
  const tool = createProjectTools({ runtime: async () => {
    reads++;
    return { checkedAt: "2026-10-04T00:00:00.000Z", warnings: ["仅当前用户可见"], ports: [
      { port: 3000, pid: 12, processName: "node", projects: [{ id: "a", name: "网站" }] },
      { port: 5173, pid: 13, processName: "node", projects: [] },
    ] };
  } }, turn).find((tool) => tool.name === "list_ports");
  const matching = JSON.parse(String(toolText((await tool!.execute!("ports", { port: 3000, query: "网站" })))));
  assert.deepEqual(matching.ports.map((item: { pid: unknown; }) => item.pid), [12]);
  const empty = JSON.parse(String(toolText((await tool!.execute!("ports", { port: 3001 })))));
  assert.deepEqual(empty.ports, []); assert.match(empty.scope, /TCP 监听/);
  assert.deepEqual(empty.warnings, ["仅当前用户可见"]);
  await assert.rejects(tool!.execute!("invalid", { port: 65536 }), /端口号/);
  assert.equal(reads, 2); assert.deepEqual(turn.actions, []);
});

test("Pi 不输出 SDK 原始错误或凭据，未配置时返回明确缺口", async () => {
  const options = { manager: {}, cwd: tmpdir(), dataDir: tmpdir() };
  const unconfigured = fixtureProjectAgent({ ...options, config: { llmConfigured: false } });
  await assert.rejects(unconfigured.prompt({ message: "查看项目", sessionId: "fixture-session-12345" }), /先配置/);
  const failing = fixtureProjectAgent({ ...options, config: { llmConfigured: true }, sessionFactory: async () => { throw new Error("Bearer fixture-secret"); } });
  await assert.rejects(failing.prompt({ message: "查看项目", sessionId: "fixture-session-12345" }), (error: TestFailure) => {
    assert.equal(error.message.includes("fixture-secret"), false); assert.equal(error.diagnostic!.reason, "request_failed"); return true;
  });
});

test("同一对话拒绝并发提交，取消后明确返回已停止并释放会话", async () => {
  let entered: (value?: unknown) => void, finish: (value?: unknown) => void;
  const started = new Promise((done) => { entered = done; });
  let disposed = false;
  const agent = fixtureProjectAgent({ config: { llmConfigured: true, llmTimeoutMs: 1000 }, manager: {},
    sessionFactory: async () => ({
      subscribe: () => () => {}, messages: [] as SessionMessage[],
      prompt: async () => { entered(); await new Promise((done) => { finish = done; }); },
      abort: async () => { finish?.(); }, dispose: () => { disposed = true; }, getLastAssistantText: () => "已停止",
    }),
  });
  const first = agent.prompt({ message: "查看项目", sessionId: "concurrent-session-12345" });
  const rejected = assert.rejects(first, (error: TestFailure) => error.diagnostic?.reason === "cancelled");
  await started;
  await assert.rejects(agent.prompt({ message: "再查看", sessionId: "concurrent-session-12345" }), /正在处理/);
  await agent.cancel("concurrent-session-12345"); await rejected;
  assert.equal(disposed, true); assert.equal(agent.sessions.size, 0);
});

test("预览地址中的查询凭据不进入模型工具结果", async () => {
  const turn: ProjectTurn & { toolCalls?: number } = { message: "查看项目", toolCalls: 0, actions: [] };
  const tools = createProjectTools({ list: async () => [{ id: "fixture", url: "http://127.0.0.1:8888/?token=fixture-private" }] }, turn);
  const result = await tools.find!((item) => item.name === "list_projects")!.execute("call", {});
  assert.equal(toolText(result).includes("fixture-private"), false);
  assert.equal(JSON.parse(String(toolText(result)))[0].previewReady, true);
});

test("真实 Pi SDK 检查项目文件、提交方案并自动启用，文件内容回填模型", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-pi-setup-"));
  const app = join(root, "app"); await mkdir(app);
  await writeFile(join(app, "package.json"), JSON.stringify({ scripts: { dev: "vite" }, packageManager: "pnpm@10.0.0" }));
  let count = 0;
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(String(Buffer.concat(chunks))); count++;
    assert.deepEqual(body.tools.map((item: { function: { name: unknown; }; }) => item.function.name).sort(), ["list_project_files", "read_project_file", "submit_launch_plan"]);
    if (count === 3) assert.ok(body.messages.some((message: { role: string; content: string|string[]; }) => message.role === "tool" && message.content.includes("pnpm@10.0.0")));
    const call = count === 1 ? ["list_project_files", {}] : count === 2 ? ["read_project_file", { file: "package.json" }]
      : count === 3 ? ["submit_launch_plan", { status: "ready", summary: "已识别 pnpm 开发入口。", command: "pnpm", args: ["run", "dev"] }] : null;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: { role?: string; tool_calls?: { index: number; id: string; type: string; function: { name: string|{}|{ file: string; }|{ status: string; summary: string; command: string; args: string[]; }|undefined; arguments: string; }; }[]; content?: string; }, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1,
      model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (call) {
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: `setup_${count}`, type: "function", function: { name: call[0], arguments: JSON.stringify(call[1]) } }] });
      chunk({}, "tool_calls");
    } else { chunk({ role: "assistant", content: "已配置。" }); chunk({}, "stop"); }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
  const config = { llmConfigured: true, chatUrl: `http://127.0.0.1:${listeningAddress(model).port}/v1/chat/completions`,
    model: "fixture-model", apiKey: "fixture-only", llmTimeoutMs: 5000 };
  const manager = new ProjectManager({ dataDir: join(root, "data"), analyzeProject: createProjectAnalyzer({ config, dataDir: join(root, "data") }) });
  t.after(async () => { await manager.dispose(); await new Promise<void>((done, reject) => model.close(error => error ? reject(error) : done())); await rm(root, { recursive: true, force: true }); });
  const project = await manager.add({ path: app });
  assert.equal(count, 3); assert.equal(project.canLaunch, true); assert.equal(project.launch!.command, "pnpm");
  assert.deepEqual(project.launch!.args, ["run", "dev"]); assert.equal(project.setup!.status, "ready");
});

test("外层项目对话不再受聊天超时、模型轮数或工具次数上限打断", async () => {
  let listener: Parameters<NonNullable<PiSessionPort["subscribe"]>>[0], calls = 0, aborted = false;
  const manager = { list: async () => { calls++; return []; } };
  const agent = fixtureProjectAgent({ config: { llmConfigured: true, llmTimeoutMs: 1 }, manager,
    sessionFactory: async ({ turn }) => {
      const list = createProjectTools(manager, turn!).find((tool) => tool.name === "list_projects");
      return { messages: [] as SessionMessage[], getLastAssistantText: () => "检查完成", subscribe(fn: Parameters<NonNullable<PiSessionPort["subscribe"]>>[0]) { listener = fn; return () => {}; },
        dispose() {}, async abort() { aborted = true; },
        async prompt() {
          await new Promise((done) => setTimeout(done, 20));
          for (let index = 0; index < 25; index++) {
            dispatchModelEvent(listener, { type: "turn_start" });
            await list!.execute!(`list-${index}`, {});
          }
        },
      };
    },
  });
  const result = await agent.prompt({ message: "仔细查看项目", sessionId: "no-old-limits-session" });
  assert.equal(result.reply, "检查完成"); assert.equal(calls, 26); assert.equal(aborted, false);
  await agent.dispose();
});

test("内部检查连接失败后结束本轮对话，不能自动重复检查绕过重试次数", async () => {
  let listener: Parameters<NonNullable<PiSessionPort["subscribe"]>>[0], aborts = 0;
  const project = { id: "large", name: "大项目", setup: { status: "failed", reason: "api_error", summary: "模型接口已重连 5 次仍未恢复。" } };
  const manager = { add: async () => project, list: async () => [project] };
  const agent = fixtureProjectAgent({ config: { llmConfigured: true }, manager,
    sessionFactory: async ({ turn }) => {
      const add = createProjectTools(manager, turn!).find((tool) => tool.name === "add_project");
      return { messages: [{ role: "assistant", stopReason: "aborted" }], subscribe(fn: Parameters<NonNullable<PiSessionPort["subscribe"]>>[0]) { listener = fn; return () => {}; },
        dispose() {}, async abort() { aborts++; },
        async prompt() {
          await add!.execute!("add", { path: "/large/project" });
          dispatchModelEvent(listener, { type: "tool_execution_end" });
          await assert.rejects(add!.execute!("repeat", { path: "/large/project" }), /等待用户/);
        },
      };
    },
  });
  const result = await agent.prompt({ message: "添加 /large/project", sessionId: "failed-project-session" });
  assert.match(fixtureText(result.reply), /重连 5 次/); assert.equal(objectFields(result.projects![0]!.setup).status, "failed"); assert.equal(aborts, 1);
  assert.equal(agent.sessions.size, 0);
  await agent.dispose();
});

test("更新设置关闭旧会话后，迟到的会话不调用模型并且不删除同标识的新会话", async () => {
  let entered: (value?: unknown) => void, release, factories = 0, oldPrompts = 0, oldDisposals = 0, newDisposals = 0;
  const ready = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const currentSession = { subscribe: () => () => {}, messages: [] as SessionMessage[], async prompt() {},
    getLastAssistantText: () => "新配置已生效", async abort() {}, dispose() { newDisposals++; } };
  const agent = fixtureProjectAgent({ config: { llmConfigured: true }, manager: { list: async () => [] },
    sessionFactory: async () => {
      factories++;
      if (factories > 1) return currentSession;
      entered(); await gate;
      return { subscribe: () => () => {}, messages: [] as SessionMessage[], async prompt() { oldPrompts++; },
        getLastAssistantText: () => "旧会话", async abort() {}, dispose() { oldDisposals++; } };
    } });
  const sessionId = "settings-late-session-12345";
  const pending = agent.prompt({ message: "查看项目", sessionId });
  const stopped = assert.rejects(pending, (error: TestFailure) => error.diagnostic?.reason === "cancelled");
  await ready;
  await agent.dispose();
  const fresh = await agent.prompt({ message: "再查看项目", sessionId });
  assert.equal(fresh.reply, "新配置已生效");
  release!(); await stopped;
  assert.equal(oldPrompts, 0); assert.equal(oldDisposals, 1);
  assert.equal(agent.sessions!.get(sessionId)!.session, currentSession);
  assert.equal(newDisposals, 0);
  await agent.dispose();
  assert.equal(newDisposals, 1);
});

for (const operation of ["dispose", "cancel"]) for (const failedOperation of [false, true]) {
  test(`获取项目列表期间 ${operation}，${failedOperation ? "操作失败" : "正常回复"}分支不返回迟到成功`, async () => {
    let entered: (value?: unknown) => void, release, disposals = 0;
    const ready = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const agent = fixtureProjectAgent({ config: { llmConfigured: true },
      manager: { list: async () => { entered(); await gate; return []; } },
      sessionFactory: async ({ turn }) => ({ subscribe: () => () => {}, messages: [] as SessionMessage[],
        async prompt() { if (failedOperation) turn!.failedOperation! = { setup: { summary: "操作未完成" } }; },
        getLastAssistantText: () => "项目已列出", async abort() {}, dispose() { disposals++; } }),
    });
    const sessionId = "late-project-list-session-12345";
    const pending = agent.prompt({ message: "查看项目", sessionId });
    const stopped = assert.rejects(pending, (error: TestFailure) => error.diagnostic?.reason === "cancelled");
    await ready;
    if (operation === "dispose") await agent.dispose();
    else assert.equal((await agent.cancel(sessionId)).cancelled, true);
    release!(); await stopped;
    assert.equal(disposals, 1); assert.equal(agent.sessions.size, 0);
    await agent.dispose();
  });
}

function fixtureProjectAgent(options: Omit<ConstructorParameters<typeof PiProjectAgent>[0], "cwd" | "dataDir"> & Partial<Pick<ConstructorParameters<typeof PiProjectAgent>[0], "cwd" | "dataDir">>): PiProjectAgent {
  const agent: unknown = Reflect.construct(PiProjectAgent, [options]); assert.ok(agent instanceof PiProjectAgent); return agent;
}
