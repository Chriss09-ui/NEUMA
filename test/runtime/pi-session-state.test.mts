import { fixtureText } from "../helpers/m7-test-boundaries.mjs";
import { callFixture } from "../helpers/m7-test-boundaries.mjs";
import type { SessionMessage, PiSessionOptions } from "../../src/runtime/pi-port.mjs";
interface FixtureReply { content?: string; status?: number; tool?: { name: string; arguments: string }; usage?: unknown }
import { recordArray } from "../helpers/m7-test-boundaries.mjs";
import type { FixtureModelRequest } from "../helpers/m7-test-boundaries.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import { listeningAddress } from "../helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { createPiSession, classifyModelFailure } from "../../src/runtime/pi-runtime.mjs";
import { piSessionPolicy } from "../../src/runtime/pi-session-state.mjs";
import type { NeumaPiSession } from "../../src/runtime/pi-port.mjs";

async function fixture(t: test.TestContext, respond: (body: FixtureModelRequest, turn: number) => FixtureReply | Promise<FixtureReply> = () => ({ content: "完成" })) {
  const root = await mkdtemp(join(tmpdir(), "neuma-pi-session-state-")), requests: FixtureModelRequest[] = [], sessions: ((NeumaPiSession))[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(String(Buffer.concat(chunks))); requests.push(body);
    const result = await respond(body, requests.length);
    if (result.status) { response.writeHead(result.status, { "content-type": "application/json" }); return response.end(JSON.stringify({ error: { message: "temporary rate limit" } })); }
    const tool = result.tool;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model",
      choices: [{ index: 0, delta: { role: "assistant", ...(tool ? { tool_calls: [{ index: 0, id: `call-${requests.length}`, type: "function", function: tool }] } : { content: result.content ?? "完成" }) },
        finish_reason: tool ? "tool_calls" : "stop" }], ...(result.usage ? { usage: result.usage } : {}) })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(async () => { for (const session of sessions) session.dispose(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); await rm(root, { recursive: true, force: true }); });
  const config = { chatUrl: `http://127.0.0.1:${listeningAddress(server).port}/v1/chat/completions`, model: "fixture-model", apiKey: "private-key-fixture" };
  const create = async (options: Partial<PiSessionOptions> = {}) => {
    const session = await createPiSession({ config, cwd: root, dataDir: join(root, "data"), systemPrompt: "受控测试角色", customTools: [], ...options });
    sessions.push(session); return session;
  };
  return { root, requests, create, config };
}

test("同任务恢复记录模型能力摘要的变更，保留原生历史与宿主累计预算", async (t) => {
  const { root, requests, create, config } = await fixture(t);
  const storage = { directory: join(root, "profile-history"), binding: { run: "run-1", role: "developer" } };
  const profile = { schemaVersion: 1, target: { chatUrl: config.chatUrl, model: config.model }, api: "openai-completions",
    contextWindow: 8192, maxOutputTokens: 1024, reasoning: false, input: ["text"] };
  let charged = 0;
  const options = { config: { ...config, modelProfile: profile }, maxOutputTokens: 512, onModelCall() {
    if (charged >= 2) throw new Error("累计额度已用尽");
    charged++;
  } };
  const session = await create({ ...options, sessionStorage: storage });
  await session.prompt("同一任务首轮");
  const file = session.sessionFile!, firstHash = session.modelProfileHash;
  const entries = async () => (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(String(line)));
  const profiles = async () => (await entries()).filter((entry) => entry.customType === "neuma.model-profile.v1");
  assert.equal((await profiles()).length, 1);
  session.dispose();
  const resumedStorage = { ...storage, file: basename(file!) };
  const unchanged = await create({ ...options, sessionStorage: resumedStorage });
  assert.equal((await profiles()).length, 1, "同能力恢复不添加重复记录");
  unchanged.dispose();
  const updated = await create({ ...options, config: { ...config, modelProfile: { ...profile, contextWindow: 16384 } }, sessionStorage: resumedStorage });
  assert.notEqual(updated.modelProfileHash, firstHash);
  assert.equal(updated.sessionBindingHash, session.sessionBindingHash);
  const audit = await profiles();
  assert.deepEqual(audit.map((entry) => entry.data.profileHash), [firstHash, updated.modelProfileHash]);
  assert.ok(audit.every((entry) => entry.data.bindingHash === session.sessionBindingHash));
  assert.doesNotMatch(JSON.stringify(audit), /private-key-fixture|chatUrl|127\.0\.0\.1/);
  await updated.prompt("调整模型能力后继续原任务");
  assert.ok(recordArray(objectFields(requests[1]).messages).some((message) => message.role === "user" && JSON.stringify(message.content).includes("同一任务首轮")));
  assert.doesNotMatch(JSON.stringify(requests), /neuma.model-profile|profileHash/);
  await assert.rejects(updated.prompt("不能刷新预算"), /累计额度已用尽/);
  assert.equal(charged, 2); assert.equal(requests.length, 2);
});

test("小上下文能力配置使用 SDK 实际余量，过小声明在请求前拒绝", async (t) => {
  const { create, config, requests } = await fixture(t);
  const profile = { schemaVersion: 1, target: { chatUrl: config.chatUrl, model: config.model }, api: "openai-completions",
    contextWindow: 8192, maxOutputTokens: 1024, reasoning: false, input: ["text"], compat: { maxTokensField: "max_tokens" } };
  for (const contextWindow of [4096, 8191]) await assert.rejects(create({ config: { ...config,
    modelProfile: { ...profile, contextWindow } }, maxOutputTokens: 512 }), /至少 8192/);
  assert.equal(requests.length, 0);
  for (const contextWindow of [8192, 16384]) {
    const session = await create({ config: { ...config, modelProfile: { ...profile, contextWindow } }, maxOutputTokens: 512 });
    await session.prompt("完成固定的本地测试");
    const settings = session.settingsManager.getCompactionSettings(session.model);
    assert.ok(settings.reserveTokens + settings.keepRecentTokens + 512 < contextWindow);
    assert.equal(objectFields(requests.at(-1)).max_tokens, 512);
  }
  assert.equal(requests.length, 2);
});

test("真实 Pi 会话保存、恢复完整历史，绑定只以摘要保存且文件保持私有", async (t) => {
  const { root, requests, create } = await fixture(t);
  const storage = { directory: join(root, "private-sessions"), binding: { run: "run-1", role: "developer", subject: "binding-private-fixture" } };
  const session = await create({ sessionStorage: storage });
  assert.equal(session.modelCallAccounting, false);
  await session.prompt("第一轮已确认的任务");
  const file = session.sessionFile!;
  assert.ok(file!.endsWith!(".jsonl"));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(storage.directory)).mode & 0o777, 0o700);
  const saved = await readFile(file, "utf8");
  assert.match(saved, /neuma.session-binding.v1/);
  assert.doesNotMatch(saved, /binding-private-fixture|private-key-fixture/);
  session.dispose();
  const resumed = await create({ sessionStorage: { ...storage, file: basename(file!), binding: { subject: "binding-private-fixture", role: "developer", run: "run-1" } } });
  assert.equal(resumed.sessionFile, file);
  assert.equal(resumed.sessionBindingHash, session.sessionBindingHash);
  await resumed.prompt("继续同一任务");
  assert.ok(recordArray(objectFields(requests.at(-1)).messages).some((message) => message.role === "user" && JSON.stringify(message.content).includes("第一轮已确认的任务")));
  assert.ok(recordArray(objectFields(requests.at(-1)).messages).some((message) => message.role === "assistant" && message.content === "完成"));
  assert.doesNotMatch(JSON.stringify(requests), /binding-private-fixture|neuma.session-binding/);
  assert.equal(requests.length, 2);
});

test("恢复拒绝错误绑定、缺失文件和目录外或符号链接记录，不悄悄创建新历史", async (t) => {
  const { root, requests, create } = await fixture(t);
  const storage = { directory: join(root, "sessions"), binding: { run: "run-1", role: "reviewer", subject: "snapshot-1" } };
  const session = await create({ sessionStorage: storage });
  await session.prompt("评审确定代码版本");
  const name = basename(session.sessionFile!); session.dispose();
  await assert.rejects(create({ sessionStorage: { ...storage, file: name, binding: { ...storage.binding, subject: "snapshot-2" } } }), /绑定不匹配/);
  await assert.rejects(create({ sessionStorage: { ...storage, file: "missing.jsonl" } }), /不存在/);
  await assert.rejects(create({ sessionStorage: { ...storage, file: "../outside.jsonl" } }), /允许目录/);
  await writeFile(join(storage.directory, "empty.jsonl"), "");
  await assert.rejects(create({ sessionStorage: { ...storage, file: "empty.jsonl" } }), /记录无效/);
  assert.equal(await readFile(join(storage.directory, "empty.jsonl"), "utf8"), "");
  await symlink(session.sessionFile!, join(storage.directory, "linked.jsonl"));
  await assert.rejects(create({ sessionStorage: { ...storage, file: "linked.jsonl" } }), /记录无效/);
  const other = join(root, "outside"); await mkdir(other);
  await symlink(other, join(root, "linked-directory"));
  await assert.rejects(create({ sessionStorage: { ...storage, directory: join(root, "linked-directory") } }), /目录无效/);
  assert.equal(requests.length, 1);
});

test("第一次模型响应未完成前也保存用户请求与绑定，可恢复而不重建摘要", async (t) => {
  const { root, requests, create } = await fixture(t);
  const storage = { directory: join(root, "interrupted"), binding: { run: "run-1", role: "developer" } };
  const stop = new Error("业务预算不足，禁止网络请求");
  const session = await create({ sessionStorage: storage, onModelCall: async () => { throw stop; } });
  assert.equal(session.modelCallAccounting, true);
  await assert.rejects(session.prompt("尚未得到第一轮模型回复"), (error) => error === stop);
  const file = session.sessionFile!; assert.match(await readFile(file, "utf8"), /尚未得到第一轮模型回复/);
  session.dispose();
  const resumed = await create({ sessionStorage: { ...storage, file: basename(file!) } });
  await resumed.prompt("继续尚未完成的工作");
  assert.equal(requests.length, 1);
  assert.ok(recordArray(objectFields(requests[0]).messages).some((message) => message.role === "user" && JSON.stringify(message.content).includes("尚未得到第一轮模型回复")));
});

test("创建后尚未开始首轮就取消，已经登记的原生会话引用仍能严格恢复", async (t) => {
  const { root, requests, create } = await fixture(t);
  const storage = { directory: join(root, "before-prompt"), binding: { run: "run-1", role: "planner" } };
  const session = await create({ sessionStorage: storage });
  const file = session.sessionFile!;
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.match(await readFile(file, "utf8"), /neuma.session-binding.v1/);
  await session.abort(); session.dispose();
  assert.equal(requests.length, 0);
  const resumed = await create({ sessionStorage: { ...storage, file: basename(file!) } });
  assert.equal(resumed.sessionFile, file);
  assert.equal(resumed.messages.filter((message) => message.role === "user").length, 0);
  await resumed.prompt("第一次有效请求");
  assert.equal(requests.length, 1);
});

test("预算在原生模型请求前扣除，工具续轮和压缩均计入，拒绝后不网络重试", async (t) => {
  const charged: ({ "purpose": (string | undefined); "retryAttempt": (unknown); "sent": (number); })[] = [], { requests, create } = await fixture(t);
  let denyCompaction = false;
  const stop = new Error("connection failure must never trigger retry for a denied business budget");
  const session = await create({ onModelCall: async (entry) => {
    if (denyCompaction && entry!.purpose === "compaction") throw stop;
    charged.push({ purpose: entry!.purpose, retryAttempt: entry!.retryAttempt, sent: requests.length });
  } });
  await session.prompt("首轮任务" + "x".repeat(2000));
  await session.prompt("第二轮任务" + "x".repeat(2000));
  session.settingsManager.applyOverrides({ compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 20 } });
  const result = await session.compact();
  assert.match(result.summary, /完成/);
  assert.deepEqual(charged.map((item) => item.purpose), ["agent", "agent", "compaction"]);
  assert.deepEqual(charged.map((item) => item.sent), [0, 1, 2]);
  await session.prompt("压缩后继续的工作" + "x".repeat(2000));
  denyCompaction = true;
  const beforeCompaction = requests.length;
  await assert.rejects(session.compact(), (error) => error === stop);
  assert.equal(requests.length, beforeCompaction);
  const denied = await create({ onModelCall: async () => { throw stop; } });
  const before = requests.length;
  await assert.rejects(denied.prompt("预算已耗尽"), (error) => error === stop);
  assert.equal(requests.length, before);
  assert.equal(denied.settingsManager.getRetryEnabled(), false);
  await assert.rejects(denied.prompt("不能靠再问重置预算"), (error) => error === stop);
  assert.equal(requests.length, before);
});

test("本地拒发保留原异常，事件不归接口故障，公开诊断不含任意异常正文", async t => {
  const { requests, create } = await fixture(t), stop = new Error("fixture-private-credential-must-not-leak"), events: SessionMessage[] = [];
  Reflect.set(stop, "requestAdmission", { source: "real_test_guard", reason: "request_limit", used: 2, limit: 2,
    privateField: "fixture-private-credential-must-not-leak" });
  let calls = 0;
  const session = await create({ onModelCall: async () => { calls++; throw stop; } });
  session.subscribe(event => { if (event.type === "message_end" && event.message.role === "assistant") events.push(event.message); });
  assert.equal(session.modelRequestRejection, undefined);
  await assert.rejects(session.prompt("受控拒发"), error => error === stop);
  assert.equal(requests.length, 0); assert.equal(calls, 1);
  assert.equal(classifyModelFailure(events.at(-1)!.errorMessage).reason, "request_blocked");
  assert.deepEqual(session.modelRequestRejection, { reason: "request_blocked", requestSent: false,
    source: "real_test_guard", causeReason: "request_limit", used: 2, limit: 2, purpose: "agent", retryAttempt: 0 });
  const copy = objectFields(session.modelRequestRejection); copy.causeReason = "not-real";
  assert.equal(objectFields(session.modelRequestRejection).causeReason, "request_limit");
  assert.doesNotMatch(JSON.stringify({ events, rejection: session.modelRequestRejection }), /fixture-private-credential|privateField/u);
  assert.equal(session.settingsManager.getRetryEnabled(), false);
  await assert.rejects(session.prompt("不能再次发出"), error => error === stop);
  assert.equal(calls, 1); assert.equal(requests.length, 0);
});

test("未声明来源和原因的本地策略异常不猜测为预算耗尽或泄露字段", async t => {
  const { requests, create } = await fixture(t), stop = new Error("fixture-private-policy" );
  Reflect.set(stop, "requestAdmission", { source: "fixture-private-source", reason: "fixture-private-reason", used: "fixture-private-used", limit: -1 });
  const session = await create({ onModelCall: async () => { throw stop; } });
  await assert.rejects(session.prompt("未知本地策略"), error => error === stop);
  assert.equal(requests.length, 0);
  assert.deepEqual(session.modelRequestRejection, { reason: "request_blocked", requestSent: false,
    source: "model_call_policy", causeReason: "policy_blocked", purpose: "agent", retryAttempt: 0 });
  assert.doesNotMatch(JSON.stringify(session.modelRequestRejection), /fixture-private/u);
});

test("原生自动重试公开重试序号，宿主可以分别记录交互预算与网络尝试", async (t) => {
  const calls: ({ "purpose": (unknown); "retryAttempt": (unknown); })[] = [], { requests, create } = await fixture(t, (_body: unknown, count: number) => count === 1 ? { status: 429 } : { content: "连接恢复" });
  const session = await create({ onModelCall: async (event) => { const { purpose, retryAttempt } = event!; return calls.push({ purpose, retryAttempt }); } });
  await session.prompt("读取当前任务");
  assert.equal(requests.length, 2);
  assert.deepEqual(calls, [{ purpose: "agent", retryAttempt: 0 }, { purpose: "agent", retryAttempt: 1 }]);
});

test("分裂轮压缩的前一摘要重试结束后，后一独立摘要重新扣模型回合", async (t) => {
  const calls: ({ "purpose": (unknown); "retryAttempt": (unknown); })[] = [], { requests, create } = await fixture(t, (_body: unknown, count: number) => count === 3 ? { status: 429 }
    : { content: count === 1 ? "旧轮回复" + "x".repeat(2000) : count === 2 ? "当前回复" + "x".repeat(500) : "已整理当前摘要" });
  const session = await create({ onModelCall: async (event) => { const { purpose, retryAttempt } = event!; return calls.push({ purpose, retryAttempt }); } });
  await session.prompt("旧轮任务" + "x".repeat(2000));
  await session.prompt("当前任务" + "x".repeat(2000));
  session.settingsManager.applyOverrides({ compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 20 } });
  await session.compact();
  assert.equal(requests.length, 5, "两次普通请求和两次摘要，首个摘要另有一次网络重试");
  assert.deepEqual(calls, [{ purpose: "agent", retryAttempt: 0 }, { purpose: "agent", retryAttempt: 0 },
    { purpose: "compaction", retryAttempt: 0 }, { purpose: "compaction", retryAttempt: 1 }, { purpose: "compaction", retryAttempt: 0 }]);
});

test("压缩只剩一个模型回合时，前一摘要的成功重试不能让后一摘要绕过预算", async (t) => {
  let compactCalls = 0;
  const calls: ({ "purpose": (unknown); "retryAttempt": (unknown); })[] = [], stop = new Error("压缩模型回合已用完");
  const { requests, create } = await fixture(t, (_body: unknown, count: number) => count === 3 ? { status: 429 }
    : { content: count === 1 ? "旧轮回复" + "x".repeat(2000) : count === 2 ? "当前回复" + "x".repeat(500) : "已整理当前摘要" });
  const session = await create({ onModelCall: async (event) => { const { purpose, retryAttempt } = event!;
    calls.push({ purpose, retryAttempt });
    if (purpose === "compaction" && retryAttempt === 0 && ++compactCalls > 1) throw stop;
   } });
  await session.prompt("旧轮任务" + "x".repeat(2000));
  await session.prompt("当前任务" + "x".repeat(2000));
  session.settingsManager.applyOverrides({ compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 20 } });
  await assert.rejects(session.compact(), (error) => error === stop);
  assert.equal(requests.length, 4, "只发送首个摘要及其网络重试，第二摘要在发送前被预算拒绝");
  assert.deepEqual(calls.slice(-3), [{ purpose: "compaction", retryAttempt: 0 }, { purpose: "compaction", retryAttempt: 1 },
    { purpose: "compaction", retryAttempt: 0 }]);
  assert.equal(session.settingsManager.getRetryEnabled(), false);
});

test("参数解析前后只记录类型，结构拒绝反馈不再重传整份参数", async (t) => {
  const diagnostics: ((unknown))[] = [], rejected: ({ "toolName": (unknown); "casesType": ("string" | "number" | "bigint" | "boolean" | "symbol" | "undefined" | "object" | "function"); })[] = [], charged: ((unknown))[] = [];
  const { requests, create } = await fixture(t, (_body: unknown, count: number) => ({ tool: { name: "submit_plan", arguments: count === 1
    ? JSON.stringify({ cases: "[1,private-value-fixture", private_dynamic_field: "do-not-echo-fixture" })
    : '{"cases":[1,2]' }, usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } }));
  const session = await create({ onModelCall: async (event) => { const { purpose } = event!; return charged.push(purpose); }, onToolDiagnostic: (entry: unknown) => diagnostics.push(entry),
    toolErrorResult: ({ toolName, args }) => { rejected.push({ toolName, casesType: typeof objectFields(args).cases });
      return { content: [{ type: "text", text: "plan.cases [type]：请填写数组。" }], details: { reason: "type" } }; },
    customTools: [{ name: "submit_plan", label: "提交", description: "提交计划", parameters: { type: "object", properties: { cases: { type: "array", items: { type: "integer" } } }, required: ["cases"], additionalProperties: false },
      async execute(_id: unknown, args: unknown) : Promise<import("../../src/contracts/tools.mjs").ToolResult> { assert.deepEqual(args, { cases: [1, 2] }); return { content: [{ type: "text", text: "已保存" }], details: {}, terminate: true }; } }] });
  await session.prompt("提交测试材料");
  assert.equal(requests.length, 2);
  const feedback = recordArray(objectFields(requests[1]).messages).find((message) => message.role === "tool")!.content;
  assert.match(fixtureText(feedback), /plan.cases/); assert.doesNotMatch(fixtureText(feedback), /private-value|do-not-echo|Received arguments|private_dynamic_field/);
  assert.deepEqual(rejected, [{ toolName: "submit_plan", casesType: "string" }]);
  assert.equal(diagnostics.length, 2);
  assert.equal(objectFields(objectFields(diagnostics[0]).raw).validJson, true);
  assert.equal(objectFields(objectFields(objectFields(objectFields(objectFields(diagnostics[0]).raw).shape).fields)[0]).type, "string");
  assert.equal(objectFields(objectFields(objectFields(objectFields(diagnostics[0]).parsed).fields)[0]).type, "string");
  assert.equal(objectFields(diagnostics[0]).rawStopReason, "tool_calls");
  assert.deepEqual(objectFields(diagnostics[0]).usage, { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 });
  assert.equal(objectFields(objectFields(diagnostics[1]).raw).validJson, false);
  assert.equal(objectFields(objectFields(objectFields(objectFields(diagnostics[1]).parsed).fields)[0]).type, "array");
  assert.doesNotMatch(JSON.stringify(diagnostics), /private-value|do-not-echo|Received arguments|private_dynamic_field/);
  assert.deepEqual(charged, ["agent", "agent"]);
});

test("未提供错误格式化器时，SDK 校验错误仍给出安全的具体字段反馈", async (t) => {
  const { requests, create } = await fixture(t, (_body: unknown, count: number) => count === 1 ? { tool: { name: "submit_plan", arguments: '{"cases":"private-value-fixture"}' } } : { content: "等待修正" });
  const session = await create({ customTools: [{ name: "submit_plan", label: "提交", description: "提交", parameters: { type: "object", properties: { cases: { type: "array" } }, required: ["cases"] },
    async execute() { assert.fail("结构错误不能执行"); } }] });
  await session.prompt("提交");
  const feedback = recordArray(objectFields(requests.at(-1)).messages).find((message) => message.role === "tool")!.content;
  assert.match(fixtureText(feedback), /结构校验/); assert.doesNotMatch(fixtureText(feedback), /private-value|Received arguments/);
  const parsed = JSON.parse(String(feedback));
  assert.equal(parsed.executed, false); assert.equal(parsed.issues[0].path, "submit_plan.cases");
  assert.equal(parsed.issues[0].expectedType, "array"); assert.equal(parsed.issues[0].receivedType, "string");
});

test("默认SDK字段反馈进入下一真实本地请求，修改后仅执行一次", async t => {
  let executed = 0;
  const { requests, create } = await fixture(t, (_body: unknown, count: number) => count === 1
    ? { tool: { name: "edit-cases", arguments: JSON.stringify({ changes: [{ op: "PRIVATE_VALUE", index: 200 }], PRIVATE_KEY: "PRIVATE_VALUE" }) } }
    : { tool: { name: "edit-cases", arguments: JSON.stringify({ changes: [{ op: "replace", index: 3 }] }) } });
  const session = await create({ customTools: [{ name: "edit-cases", label: "修改", description: "固定本地参数测试", parameters: {
    type: "object", properties: { changes: { type: "array", items: { type: "object", properties: {
      op: { type: "string", enum: ["add", "replace", "remove", "move"] }, index: { type: "integer", maximum: 199 },
    }, required: ["op", "index"], additionalProperties: false } } }, required: ["changes"], additionalProperties: false },
    async execute(_id: unknown, args: unknown) : Promise<import("../../src/contracts/tools.mjs").ToolResult> { executed++; assert.deepEqual(args, { changes: [{ op: "replace", index: 3 }] });
      return { content: [{ type: "text", text: "已执行" }], details: {}, terminate: true }; } }] });
  await session.prompt("固定本地协议测试");
  assert.equal(requests.length, 2); assert.equal(executed, 1);
  const feedback = recordArray(objectFields(requests[1]).messages).find((message) => message.role === "tool")!.content, result = JSON.parse(String(feedback));
  assert.deepEqual(result.issues.find((issue: { path: string; }) => issue.path === "edit-cases.changes[0].op").allowedValues, ["add", "replace", "remove", "move"]);
  assert.deepEqual(result.issues.find((issue: { path: string; }) => issue.path === "edit-cases.changes[0].index").constraints, { maximum: 199 });
  assert.doesNotMatch(fixtureText(feedback), /PRIVATE_|Received arguments/u);
});

test("严格工具原参数绑定当前助手及唯一callId，同轮隔离、恢复重验，缺失或冲突均拒绝", async () => {
  let branch: { type: string; message: { role: string; content: { type: string; id: string; name: string; arguments: unknown }[] } }[] = [], checks = 0;
  const context = { sessionManager: { getBranch: () => branch } };
  const create = () => {
    const handlers: Record<string, (...args: never[]) => unknown> = {};
    const policy = piSessionPolicy({ customTools: [{ name: "strict" }, { name: "legacy" }], halt(error) { throw error; },
      rawInputValidators: { strict: ({ args }) => { checks++; return typeof objectFields(args).input === "string" ? { valid: true }
        : { valid: false, reason: "strict.input [type]：须为字符串" }; } } });
    callFixture(policy.factory, undefined, [{ on(name: string, handler: (...args: never[]) => unknown) { objectFields(handlers)[name] = handler; } }]);
    return handlers;
  };
  const assistant = { role: "assistant", content: [
    { type: "toolCall", id: "bad", name: "strict", arguments: { input: 7 } },
    { type: "toolCall", id: "good", name: "strict", arguments: { input: "7" } },
    { type: "toolCall", id: "old", name: "legacy", arguments: { input: 7 } },
  ] };
  const handlers = create(); await callFixture(handlers.message_end!, undefined, [{ message: assistant }, context]);
  branch = [{ type: "message", message: assistant }];
  assert.equal(checks, 2);
  assert.equal(objectFields(await callFixture(handlers.tool_call!, undefined, [{ toolName: "strict", toolCallId: "bad", input: { input: "7" } }, context])).block, true);
  assert.equal(await callFixture(handlers.tool_call!, undefined, [{ toolName: "strict", toolCallId: "good", input: { input: "7" } }, context]), undefined);
  assert.equal(await callFixture(handlers.tool_call!, undefined, [{ toolName: "legacy", toolCallId: "old", input: { input: "7" } }, context]), undefined);
  assert.equal(checks, 2, "同轮缓存只保留校验结果，不能用event.input的已转换值重新放行");
  const restored = create();
  assert.equal(await callFixture(restored.tool_call!, undefined, [{ toolName: "strict", toolCallId: "good", input: {} }, context]), undefined);
  assert.equal(checks, 3, "恢复时从当前私有会话原调用重新校验，不依赖进程缓存");
  const current = { role: "assistant", content: [{ type: "toolCall", id: "new", name: "strict", arguments: { input: "valid" } }] };
  branch.push({ type: "message", message: current });
  assert.equal(objectFields((await callFixture(restored.tool_call!, undefined, [{ toolName: "strict", toolCallId: "good", input: {} }, context]))).block, true, "不能回查旧助手消息放行");
  assert.equal(objectFields((await callFixture(restored.tool_call!, undefined, [{ toolName: "strict", toolCallId: "new", parentToolCallId: "parent", input: {} }, context]))).block, true);
  current.content.push({ type: "toolCall", id: "new", name: "legacy", arguments: { input: "valid" } });
  assert.equal(objectFields((await callFixture(restored.tool_call!, undefined, [{ toolName: "strict", toolCallId: "new", input: {} }, context]))).block, true, "重复id即使跨工具也拒绝");
  branch = [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "same", name: "legacy", arguments: {} }] } }];
  assert.equal(objectFields((await callFixture(restored.tool_call!, undefined, [{ toolName: "strict", toolCallId: "same", input: {} }, context]))).block, true);
  branch = [];
  assert.equal(objectFields((await callFixture(restored.tool_call!, undefined, [{ toolName: "strict", toolCallId: "missing", input: {} }, context]))).block, true);
});

test("未选择严格校验的旧工具继续使用SDK既有类型转换", async (t) => {
  const { create } = await fixture(t, (_body: unknown, count: number) => count === 1 ? { tool: { name: "legacy", arguments: '{"input":7}' } } : { content: "完成" });
  let value;
  const session = await create({ customTools: [{ name: "legacy", label: "旧工具", description: "验证旧行为", parameters: {
    type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false },
    async execute(_id: unknown, args: { input: unknown; }) : Promise<import("../../src/contracts/tools.mjs").ToolResult> { value = args.input; return { content: [{ type: "text", text: "已执行" }], details: {} }; } }] });
  await session.prompt("执行固定本地协议测试"); assert.equal(value, "7");
});
