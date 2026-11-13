import { callFixture, fixtureNumber } from "../helpers/m7-test-boundaries.mjs";
import type { PiSessionPort, SessionEvent } from "../../src/runtime/pi-port.mjs";
import type { DevelopmentExecutorPort } from "../../src/development/development.mjs";
import type { DevelopmentTask } from "../../src/contracts/development.mjs";
interface ContinuationPayload { requirements?: unknown; task?: DevelopmentTask; subjectHash?: string; submissionContinuation?: unknown }
interface ContinuationRequest { role: string; key: string; body: FixtureModelRequest; payload: ContinuationPayload; continuation?: unknown }
import { fixtureText } from "../helpers/m7-test-boundaries.mjs";
import { recordArray } from "../helpers/m7-test-boundaries.mjs";
import type { FixtureModelRequest } from "../helpers/m7-test-boundaries.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import type { SessionMessage } from "../../src/runtime/pi-port.mjs";
import { listeningAddress } from "../helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevelopmentController } from "../../src/development/development.mjs";
import { createPiSession } from "../../src/runtime/pi-runtime.mjs";
import { developmentArchitecture, developmentPlan, developmentReview, developmentWork } from "../helpers/development.mjs";
import type { PiSessionOptions } from "../../src/runtime/pi-port.mjs";
import type { PathLike } from "fs";

const names: Record<string, string> = { planner: "submit_development_plan", developer: "submit_development_work", reviewer: "submit_development_review" };
const textOf = (content: unknown) => typeof content === "string" ? content
  : recordArray((content ?? [])).filter((item) => item.type === "text").map((item) => item.text).join("\n");

async function fixture(t: test.TestContext, { role = "planner", alwaysText = false, limits = {}, stopReason = "stop", cancel = false,
  changedArchitecture = false, accounted = true, rejectedFirst = false, draftBeforeText = false, lengthAfterReminder = false, structuredResults = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-development-continuation-")), dataDir = join(root, "data");
  const architecture = developmentArchitecture(), requests: ContinuationRequest[] = [], sessions: ({ "role": (string | undefined); "session": (PiSessionPort); "prompts": (unknown[]); "options": (PiSessionOptions); })[] = [], controllers: DevelopmentController[] = [];
  const abort = new AbortController(), attempts = new Map<string, number>(); let target: string | undefined, failedSubmission = false;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(String(Buffer.concat(chunks))), tools = body.tools.map((item: { function: { name: unknown; }; }) => item.function.name);
    const kind = Object.keys(names).find((key) => tools.includes(names[key]));
    assert.ok(kind);
    const users = body.messages.filter((message: { role: string; }) => message.role === "user").map((message: { content: unknown; }) => {
      try { return JSON.parse(String(textOf(message.content))); } catch { return {}; }
    });
    const payload = users.findLast((value: { requirements: unknown; task: unknown; subjectHash: unknown; }) => value.requirements || value.task || value.subjectHash) ?? {};
    const key = `${kind}:${payload.subjectHash ?? payload.task?.id ?? "plan"}`;
    const index = attempts.get(key) ?? 0; attempts.set(key, index + 1);
    if (kind === role && !target) target = key;
    requests.push({ role: kind, key, body, payload, continuation: users.at(-1)?.submissionContinuation });
    const calls: { name: string; arguments: string }[] = [], shouldText = !structuredResults && key === target && (alwaysText || index === (draftBeforeText ? 1 : 0) || rejectedFirst && index === 1);
    if (cancel && key === target) abort.abort();
    if (changedArchitecture && key === target) architecture.version++;
    if (!shouldText) {
      if (kind === "planner") calls.push({ name: names.planner!, arguments: JSON.stringify(developmentPlan(architecture)) });
      else if (kind === "reviewer") calls.push({ name: names.reviewer!, arguments: JSON.stringify(developmentReview(payload.subjectHash)) });
      else {
        const latestUser = body.messages.findLastIndex((message: { role: string; }) => message.role === "user");
        const writes = body.messages.slice(draftBeforeText ? 0 : latestUser + 1).flatMap((message: { tool_calls: unknown; }) => message.tool_calls ?? [])
          .filter((call: { function: { name: string; }; }) => call.function.name === "write_code_file").length;
        const path = payload.task.files[writes];
        calls.push(path ? { name: "write_code_file", arguments: JSON.stringify({ path,
          content: 'console.log(JSON.stringify({ok:true}));\n' }) }
          : { name: names.developer!, arguments: JSON.stringify(developmentWork(payload.task)) });
      }
    } else if (rejectedFirst && !failedSubmission) {
      failedSubmission = true;
      calls.push({ name: names[kind]!, arguments: JSON.stringify({ invalid: "rejected draft" }) });
    }
    const structured = structuredResults && calls.length === 1 && Object.values(names).includes(calls[0]!.name)
      ? JSON.stringify({ submission: { name: calls[0]!.name, arguments: JSON.parse(String(calls[0]!.arguments)) } }) : null;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "continuation-fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model",
      choices: [{ index: 0, delta: { role: "assistant", ...(calls.length && !structured ? { tool_calls: calls.map((call, index) => ({ index,
        id: `call-${requests.length}-${index}`, type: "function", function: call })) } : { content: structured ?? "已整理当前材料，稍后正式提交。" }) },
      finish_reason: calls.length && !structured ? "tool_calls" : key === target && (stopReason === "length" || lengthAfterReminder && index > 0) ? "length" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = { llmConfigured: true, chatUrl: `http://127.0.0.1:${listeningAddress(server).port}/v1/chat/completions`,
    model: "fixture-model", apiKey: "local-fixture-only" };
  // Only the controller and Pi transport are under test; business execution is a declared fixed substitute.
  const executor = { async probe() { return { available: true, kind: "fixture" }; },
    async verify(options: Parameters<NonNullable<DevelopmentExecutorPort["verify"]>>[0]) {
      await readFile(join(options.snapshot.path, options.entrypoint));
      return { status: "passed", codeHash: options.snapshot.hash, summary: "固定模拟业务验收",
        results: options.cases.map((item) => ({ caseId: item.id, taskId: item.taskId, acceptanceId: item.acceptanceId,
          status: "passed", actual: JSON.parse(String(item.assertions[0]!.expectedJson)), input: item.input })) };
    } };
  const sessionFactory = async (options: PiSessionOptions) => {
    let session: PiSessionPort;
    const prompts: ((unknown))[] = [], kind = Object.keys(names).find((key) => options.customTools!.some((tool) => tool.name === names[key]));
    if (stopReason === "error" || stopReason === "aborted" || !accounted) {
      let listener: ((event: SessionEvent) => void) | undefined;
      session = { messages: [] as SessionMessage[], modelCallAccounting: accounted, subscribe(fn: (event: SessionEvent) => void) { listener = fn; return () => {}; },
        async prompt(message: unknown) {
          if (accounted) await callFixture(options.onModelCall!, options, []);
          session.messages!.push({ role: "assistant", stopReason, errorMessage: "fixed model interruption", content: "未提交" });
          listener?.({ type: "turn_end" });
        }, setAutoCompactionEnabled() {}, async abort() {}, dispose() {} };
    } else session = await createPiSession(options);
    const prompt = session.prompt.bind(session);
    session.prompt = async (message: string) => { prompts.push(JSON.parse(String(message))); return prompt(message); };
    sessions.push({ role: kind, session, prompts, options }); return session;
  };
  const controller = (overrides = {}) => {
    const instance = new DevelopmentController({ config, cwd: root, dataDir, executor, sessionFactory, limits: { ...limits, ...overrides },
      getArchitecture: async () => architecture });
    controllers.push(instance); return instance;
  };
  t.after(async () => {
    await Promise.all(controllers.map((value) => value.close()));
    for (const { session } of sessions) session.dispose();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const unseal = async (path: string) => {
      await chmod(path, 0o700);
      for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await unseal(join(path, entry.name));
    };
    await unseal(root); await rm(root, { recursive: true, force: true });
  });
  return { controller, architecture, requests, sessions, signal: abort.signal, target: () => target };
}

for (const role of Object.keys(names)) test(`真实Pi ${role}正常文字结束后在原会话收到一次反馈并正式提交`, { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { role }), result = await f.controller().run(f.architecture);
  assert.equal(result.status, "completed", result.summary);
  const session = f.sessions.find((entry) => entry.role === role);
  assert.ok(session!.options.systemPrompt!.includes(`role=${role}，submitName=${names[role]}`));
  assert.match(session!.options.systemPrompt!, /结构化结果也是本阶段正式提交通道/u);
  const contract = session!.options.systemPrompt!.slice(session!.options.systemPrompt!.lastIndexOf("宿主提交契约："));
  if (session!.options.customTools!.some((tool) => tool.name === "submit_development_blocker")) assert.match(contract, /submit_development_blocker/u);
  else assert.doesNotMatch(contract, /submit_development_blocker/u);
  assert.equal(session!.prompts.length, 2); assert.equal(objectFields(session!.prompts[1]).requirements, undefined);
  const feedback = objectFields(session!.prompts[1]).submissionContinuation;
  assert.equal(objectFields(feedback).requiredTool, names[role]); assert.equal(objectFields(feedback).attempt, 1); assert.equal(objectFields(feedback).maximum, 2);
  assert.deepEqual(objectFields(feedback).modelBudget, { limit: null, used: 1, remaining: null, accountingOnly: true });
  assert.match(fixtureText(objectFields(feedback).instruction), /已保存草稿和已有工具拒绝反馈/);
  const second = f.requests.find((entry) => entry.key === f.target() && entry.continuation);
  assert.ok(recordArray(objectFields(second!.body).messages).some((message) => message.role === "assistant" && textOf(message.content).includes("稍后正式提交")));
  const reference = Object.values(result.sessions!).find((entry) => entry.file === session!.session.sessionFile!.split("/").at(-1));
  assert.equal(reference!.turns!, role === "developer" ? 3 : 2); assert.equal(reference!.submissionContinuations!, 1);
});

test("续接保留程序拒绝反馈而不重传完整需求，仍需重新正式提交", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { rejectedFirst: true }), result = await f.controller().run(f.architecture);
  assert.equal(result.status, "completed", result.summary);
  const prompts = f.sessions[0]!.prompts;
  assert.equal(prompts.length, 2); assert.equal(objectFields(prompts[1]).requirements, undefined);
  const feedback = objectFields(prompts[1]).submissionContinuation;
  assert.equal(objectFields(feedback).requiredTool, names.planner); assert.ok(fixtureNumber(objectFields(objectFields(feedback).submissionFeedback).rejected) >= 1);
  assert.ok(recordArray(objectFields(objectFields(feedback).submissionFeedback).issues).length > 0); assert.equal(objectFields(objectFields(feedback).modelBudget).used, 2);
  assert.equal(result.submissionCounts!.planner!.accepted, 1);
});

test("开发先保存代码再文字结束，续接直接提交同一草稿，不重写或丢失文件", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { role: "developer", draftBeforeText: true }), result = await f.controller().run(f.architecture);
  assert.equal(result.status, "completed", result.summary);
  const session = f.sessions.find((entry) => entry.role === "developer"), messages = session!.session.messages!;
  assert.equal(session!.prompts.length, 2); assert.equal(objectFields(objectFields(objectFields(session!.prompts[1]).submissionContinuation).modelBudget).used, 2);
  const writes = messages.filter((message) => message.role === "assistant")
    .flatMap((message) => typeof message.content === "string" ? [] : message.content ?? []).filter((item) => item.type === "toolCall" && item.name === "write_code_file");
  assert.equal(writes.length, 1);
  assert.equal(await readFile(join(result.package!.snapshot.path, "main.mjs"), "utf8"), 'console.log(JSON.stringify({ok:true}));\n');
});

for (const role of Object.keys(names)) test(`${role}连续三次仅文字后停止并保留格式计数`, { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { role, alwaysText: true }), result = await f.controller().run(f.architecture);
  assert.equal(result.status, "failed"); assert.equal(result.diagnostic!.reason, "repeated_tool_error");
  assert.equal(result.diagnostic!.role, role);
  assert.equal(f.requests.filter((entry) => entry.key === f.target()).length, 3);
  assert.equal(f.sessions.find((entry) => entry.role === role)!.prompts.length, 3);
  assert.equal(Object.values(result.sessions!).find((entry) => entry.role === role)!.turns, 3);
});

test("旧请求配置为一轮也允许三次格式纠错，重建后保留格式锁定", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { alwaysText: true, limits: { reviewerTurns: 1 } });
  const initial = await f.controller().run(f.architecture);
  assert.equal(initial.status, "failed"); assert.equal(initial.diagnostic!.reason, "repeated_tool_error");
  assert.equal(f.requests.length, 3); assert.equal(f.sessions[0]!.prompts.length, 3);
  const before = f.requests.length, resumed = await f.controller({ reviewerTurns: 12 }).run(f.architecture, { resume: true });
  assert.equal(resumed.status, "failed"); assert.equal(resumed.diagnostic!.reason, "repeated_tool_error");
  assert.equal(f.requests.length, before);
  const reference = Object.values(resumed.sessions!).find((entry) => entry.role === "planner");
  assert.equal(reference!.turns!, 3); assert.equal(reference!.limit!, undefined); assert.equal(reference!.submissionContinuations!, 2);
});

test("重启保留三次格式错误、累计请求和同一个原生会话文件", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { alwaysText: true, limits: { reviewerTurns: 2 } });
  const initial = await f.controller().run(f.architecture), original = Object.values(initial.sessions!)[0];
  assert.equal(initial.diagnostic!.reason, "repeated_tool_error"); assert.equal(original!.turns!, 3);
  const resumed = await f.controller().run(f.architecture, { resume: true }), current = Object.values(resumed.sessions!)[0];
  assert.equal(resumed.diagnostic!.reason, "repeated_tool_error"); assert.equal(f.requests.length, 3);
  assert.equal(current!.turns!, 3); assert.equal(current!.file!, original!.file!); assert.equal(current!.submissionContinuations!, 2);
});

for (const stopReason of ["error", "aborted"]) test(`${stopReason}停止不触发提交续接`, { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { stopReason }), result = await f.controller().run(f.architecture);
  assert.equal(result.status, "failed"); assert.equal(f.sessions[0]!.prompts.length, 1);
  assert.equal(Object.values(result.sessions!)[0]!.turns, 1);
  assert.equal(Object.values(result.sessions!)[0]!.submissionContinuations, undefined);
  assert.notEqual(result.diagnostic!.reason, "repeated_tool_error");
});

test("提醒后的原生length计入独立格式纠错，第三次失败停止", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { alwaysText: true, lengthAfterReminder: true }), result = await f.controller().run(f.architecture);
  assert.equal(result.status, "failed"); assert.equal(result.diagnostic!.reason, "repeated_tool_error");
  assert.equal(f.requests.length, 3); assert.equal(f.sessions[0]!.prompts.length, 3);
  assert.equal(Object.values(result.sessions!)[0]!.turns, 3);
});

test("真实取消和架构版本守卫都在续接前停止，不将技术中断改成业务缺口", { timeout: 15000 }, async (t) => {
  for (const options of [{ cancel: true }, { changedArchitecture: true }]) {
    const f = await fixture(t, options), result = await f.controller().run(f.architecture, { signal: f.signal });
    assert.equal(result.status, options.cancel ? "cancelled" : "blocked");
    assert.equal(f.requests.length, 1); assert.equal(f.sessions[0]!.prompts.length, 1);
    assert.notEqual(result.diagnostic!.reason, "repeated_tool_error");
  }
});

test("旧注入会话每次prompt只扣一轮，续接不因turn_end重复扣费", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { accounted: false }), result = await f.controller().run(f.architecture);
  assert.equal(result.diagnostic!.reason, "repeated_tool_error");
  assert.equal(f.sessions[0]!.prompts.length, 3); assert.equal(Object.values(result.sessions!)[0]!.turns, 3);
});

for (const role of Object.keys(names)) test(`通用结构化提交通道保留${role}真实工具工作和独立评审，无多余提交回合`, { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { role, structuredResults: true, alwaysText: false }), result = await f.controller().run(f.architecture);
  assert.equal(result.status, "completed", result.summary);
  for (const entry of f.sessions) assert.equal(entry.prompts.length, 1);
  assert.ok(f.requests.some(entry => entry.role === "developer" && recordArray(objectFields(entry.body).messages).some((message) => recordArray(message.tool_calls ?? []).some((call) => objectFields(call.function).name === "write_code_file"))));
  assert.ok(result.plan && result.package);
});
