import { fixtureChatRequest, type FixtureChatRequest } from "../helpers/http-model.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import { recordArray, listeningAddress, toolText } from "../helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DevelopmentController, type DevelopmentExecutorPort } from "../../src/development/development.mjs";
import { createPiSession } from "../../src/runtime/pi-runtime.mjs";
import { compactDevelopmentContext, createContextReadTool, developmentContextMessage, restoreDevelopmentContext } from "../../src/development/development-context.mjs";
import { developmentArchitecture, developmentPlan, developmentReview, developmentWork } from "../helpers/development.mjs";
import type { DevelopmentRunRecord } from "../../src/development/development-controller-types.mjs";
import type { DevelopmentTask } from "../../src/contracts/development.mjs";
import type { ContextDelivery } from "../../src/development/development-context.mjs";
import type { SessionMessage } from "../../src/runtime/pi-port.mjs";
import type { PiSessionOptions } from "../../src/runtime/pi-port.mjs";
import type { NeumaPiSession } from "../../src/runtime/pi-port.mjs";

const submitNames: Record<string, string> = { planner: "submit_development_plan", developer: "submit_development_work", reviewer: "submit_development_review" };
const textOf = (value: unknown) => typeof value === "string" ? value : Array.isArray(value)
  ? recordArray(value).filter((item) => item.type === "text").map((item) => item.text).join("\n") : JSON.stringify(value);

interface RecoveryPayload { task?: Pick<DevelopmentTask, "id" | "title" | "files"> | null; requirements?: unknown; mode?: string; subjectHash?: string; report?: { id?: unknown }; submissionFeedback?: { issues?: {reason?: unknown}[] } }
function recoveryPayload(input: unknown): RecoveryPayload {
  const value = objectFields(input);
  if (value.task !== undefined && value.task !== null) { const task = objectFields(value.task); assert.equal(typeof task.id, "string"); assert.equal(typeof task.title, "string"); assert.ok(Array.isArray(task.files) && task.files.every(file => typeof file === "string")); }
  for (const key of ["mode", "subjectHash"]) if (value[key] !== undefined) assert.equal(typeof value[key], "string");
  if (value.report !== undefined) assert.ok(typeof value.report === "object" && value.report !== null);
  if (value.submissionFeedback !== undefined) { const feedback = objectFields(value.submissionFeedback); if (feedback.issues !== undefined) recordArray(feedback.issues); }
  return value as RecoveryPayload;
}
async function fixture(t: test.TestContext, { interruptDeveloper = false, interruptReviewer = false, compactDeveloper = false, crashAfterDeveloperSubmit = false,
  rejectDeveloperFiles = false, developerTurns = 40, materialPadding = false, compactBeforeResume = false, compactDuringResume = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-development-persistent-")), architecture = developmentArchitecture();
  if (materialPadding) architecture.requirements[0]!.text += "完整冻结要求仍按原文保留。".repeat(800);
  const requests: { body: FixtureChatRequest; role: string|undefined; payload: RecoveryPayload; }[] = [], sessions: { options: PiSessionOptions; session: NeumaPiSession; }[] = [], controllers: DevelopmentController[] = [], executionCalls: {codeHash: string;caseIds: string[]}[] = [];
  let interrupted = false, compacted = false, crashed = false, invalidWorkSubmitted = false, codeSource = 'console.log(JSON.stringify({ok:true}));\n';
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = fixtureChatRequest(Buffer.concat(chunks).toString("utf8")), tools = body.tools?.map((item) => item.function.name) ?? [];
    const role = Object.keys(submitNames).find((kind) => tools.includes(submitNames[kind]!));
    const payload = (() => {
      let current: RecoveryPayload = {};
      for (const message of body.messages.filter((item: { role: string; }) => item.role === "user")) {
        try { const data = JSON.parse(textOf(message.content)); if (data.requirements || data.task || data.subjectHash || data.contextReuse) current = recoveryPayload({ ...current, ...data }); } catch { /* Native compaction has a prose request. */ }
      }
      return current;
    })();
    requests.push({ body, role, payload });
    let tool, content;
    if (!role) content = "当前任务范围和冻结验收保持；尚未提交开发结果。";
    else if (textOf(body.messages.findLast((message: { role: string; }) => message.role === "user")?.content) === "native-compaction-checkpoint") content = "已保存本地测试检查点，未提交工作。";
    else if (role === "planner") tool = { name: submitNames.planner, arguments: JSON.stringify(developmentPlan(architecture)) };
    else if (role === "reviewer") {
      if (interruptReviewer && !interrupted && payload.mode === "task") { interrupted = true; content = "reviewer-interruption-history-marker"; }
      else tool = { name: submitNames.reviewer, arguments: JSON.stringify(developmentReview(payload.subjectHash!)) };
    } else if (interruptDeveloper && !interrupted) { interrupted = true; content = "developer-interruption-history-marker"; }
    else if (compactDeveloper && !compacted) content = "仍在整理既定任务的说明，尚未提交结果。";
    else {
      const latestUser = body.messages.findLastIndex((item: { role: string; }) => item.role === "user");
      const writes = (compactBeforeResume || compactDuringResume ? body.messages : body.messages.slice(latestUser + 1))
        .flatMap((item) => item.tool_calls ?? []).filter((call: { function: { name: string; }; }) => call.function.name === "write_code_file");
      const nextFile = payload.task!.files[writes.length];
      const invalidFiles = rejectDeveloperFiles && !invalidWorkSubmitted && !nextFile;
      if (invalidFiles) invalidWorkSubmitted = true;
      tool = nextFile ? { name: "write_code_file", arguments: JSON.stringify({ path: nextFile, content: codeSource }) }
        : { name: submitNames.developer, arguments: JSON.stringify(developmentWork(payload.task!, invalidFiles ? { changedFiles: ["mistaken.mjs"] } : {})) };
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model",
      choices: [{ index: 0, delta: { role: "assistant", ...(tool ? { tool_calls: [{ index: 0, id: `call-${requests.length}`, type: "function", function: tool }] } : { content }) },
        finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const dataDir = join(root, "data"), config = { llmConfigured: true, chatUrl: `http://127.0.0.1:${listeningAddress(server).port}/v1/chat/completions`, model: "fixture-model", apiKey: "local-fixture-only" };
  const executor: DevelopmentExecutorPort = {
    async probe() { return { available: true, kind: "fixture", reason: "只验证恢复编排，执行器使用固定模拟结果" }; },
    async verify(options) {
      executionCalls.push({ codeHash: options.snapshot.hash, caseIds: options.cases.map((item) => item.id) });
      return { status: "passed", codeHash: options.snapshot.hash, summary: "固定模拟验收报告",
        results: options.cases.map((item) => ({ caseId: item.id, taskId: item.taskId, acceptanceId: item.acceptanceId, input: item.input,
          status: "passed", exitCode: 0, stdout: item.assertions[0]!.expectedJson, stderr: "", actual: JSON.parse(String(item.assertions[0]!.expectedJson)),
          expected: item.assertions.map(({ path, expectedJson }) => ({ path, value: JSON.parse(String(expectedJson)) })) })) };
    },
    async run() { return { status: "passed", exitCode: 0, stdout: "{}", stderr: "", output: {} }; },
  };
  const sessionFactory = async (options: PiSessionOptions) => {
    const session = await createPiSession(options); sessions.push({ options, session });
    if ((compactBeforeResume || compactDuringResume) && interrupted && objectFields(options.sessionStorage!.binding).role === "developer" && !compacted) {
      const prompt = session.prompt.bind(session);
      session.settingsManager.applyOverrides({ compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 20 } });
      if (compactBeforeResume) session.prompt = async (...args) => { compacted = true; await session.compact(); return prompt(...args); };
      else {
        let armed = false;
        // The native boundary compacts between the first resumed tool and its next model request.
        const unsubscribe = session.subscribe((event) => {
          if (!armed && event.type === "tool_execution_end") {
            armed = true;
            session.settingsManager.applyOverrides({ compaction: { enabled: true, reserveTokens: 32760, keepRecentTokens: 20 } });
            compacted = true;
          }
          if (armed && event.type === "compaction_end") {
            session.settingsManager.applyOverrides({ compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 20 } });
            unsubscribe();
          }
        });
      }
    }
    if (crashAfterDeveloperSubmit && options.customTools!.some((tool: { name: string; }) => tool.name === submitNames.developer) && !crashed) {
      const prompt = session.prompt.bind(session);
      session.prompt = async (...args) => { await prompt(...args); crashed = true; throw new Error("模拟提交已保存、消费检查点之前的运行中断"); };
    }
    if (compactDeveloper && options.customTools!.some((tool: { name: string; }) => tool.name === submitNames.developer) && !compacted) {
      const prompt = session.prompt.bind(session);
      session.prompt = async (...args) => {
        await prompt(...args);
        await prompt("继续整理既定任务，尚未提交。" + "补充上下文。".repeat(500));
        compacted = true;
        session.settingsManager.applyOverrides({ compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 20 } });
        await session.compact();
      };
    }
    if ((interruptDeveloper || interruptReviewer) && !compactDeveloper) {
      const prompt = session.prompt.bind(session);
      session.prompt = async (...args) => {
        await prompt(...args);
        const last = session.messages.findLast((message) => message.role === "assistant");
        // This fixture tests a persisted-history interruption, not a normal text-only stop.
        if (/^(?:developer|reviewer)-interruption-history-marker$/.test(textOf(last?.content))) {
          if (compactBeforeResume || compactDuringResume) await prompt("native-compaction-checkpoint");
          throw new Error("模拟研发进程在保存回复后中断");
        }
      };
    }
    return session;
  };
  const controller = () => {
    const value = new DevelopmentController({ config, cwd: root, dataDir, executor, sessionFactory,
      limits: { developerTurns }, getArchitecture: async () => architecture });
    controllers.push(value); return value;
  };
  t.after(async () => {
    await Promise.all(controllers.map((item) => item.close()));
    for (const { session } of sessions) session.dispose();
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    const unseal = async (path: string) => { await chmod(path, 0o700); for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await unseal(join(path, entry.name)); };
    await unseal(root); await rm(root, { recursive: true, force: true });
  });
  return { root, architecture, requests, sessions, executionCalls, controller, setSource: (source: string) => { codeSource = source; } };
}

test("真实 Pi 开发会话在控制器重建后续接原历史，同任务不重新建立交接摘要", async (t) => {
  const f = await fixture(t, { interruptDeveloper: true });
  const firstController = f.controller(), first = await firstController.run(f.architecture);
  assert.equal(first.status, "failed"); assert.equal(first.currentTaskId, "core");
  const original = f.sessions.find((entry) => entry.options.customTools!.some((tool: { name: string; }) => tool.name === submitNames.developer));
  const reference = Object.values(first.sessions!).find((entry) => entry.role === "developer");
  assert.equal(reference!.turns, 1); assert.ok(reference!.file);
  const resumedController = f.controller(), resumed = await resumedController.run(f.architecture, { resume: true });
  assert.equal(resumed.status, "completed", resumed.summary);
  const developerSessions = f.sessions.filter((entry) => entry.options.customTools!.some((tool: { name: string; }) => tool.name === submitNames.developer));
  assert.equal(developerSessions[1]!.session.sessionFile, original!.session.sessionFile);
  const resumedRequest = f.requests.filter((entry) => entry.role === "developer")[1];
  assert.ok(resumedRequest!.body.messages.some((message) => message.role === "assistant" && textOf(message.content).includes("developer-interruption-history-marker")));
  assert.equal(resumed.tasks[0]!.attempts, 1);
  assert.ok(Object.values(resumed.sessions!).find((entry) => entry.file === reference!.file)!.turns > reference!.turns);
});

test("真实 Pi 同绑定恢复复用已完整投递的材料，原历史及预算不变", async (t) => {
  const f = await fixture(t, { interruptDeveloper: true, materialPadding: true });
  const initial = await f.controller().run(f.architecture);
  assert.equal(initial.status, "failed");
  const original = Object.values(initial.sessions!).find((entry) => entry.role === "developer");
  assert.ok(original!.contextDelivery!.sections.some((item) => item.section === "requirements"));
  const resumed = await f.controller().run(f.architecture, { resume: true });
  assert.equal(resumed.status, "completed", resumed.summary);
  const requests = f.requests.filter((entry) => entry.role === "developer" && entry.payload.task!.id === "core");
  const raw = JSON.parse(textOf(requests[1]!.body.messages.findLast((message: { role: string; }) => message.role === "user")!.content));
  assert.ok(raw.contextReuse.sections.includes("requirements"));
  assert.equal(Object.hasOwn(raw, "requirements"), false);
  assert.equal(raw.contextSections.find((item: { section: string; }) => item.section === "requirements").delivery, "session");
  assert.equal(raw.modelBudget.used, original!.turns);
  assert.deepEqual(requests[1]!.payload.requirements, f.architecture.requirements);
  assert.ok(requests[1]!.body.messages.some((message) => message.role === "assistant" && textOf(message.content).includes("developer-interruption-history-marker")));
  assert.ok(Object.values(resumed.sessions!).find((entry) => entry.file === original!.file)!.turns > original!.turns);
});

for (const boundary of ["compactBeforeResume", "compactDuringResume"]) test(`真实 Pi ${boundary}移除已复用原文时，同一次请求恢复完整事实`, async (t) => {
  const f = await fixture(t, { interruptDeveloper: true, materialPadding: true, [boundary]: true });
  const initial = await f.controller().run(f.architecture);
  assert.equal(initial.status, "failed");
  const reference = Object.values(initial.sessions!).find((entry) => entry.role === "developer");
  assert.equal(reference!.turns, 2);
  const resumed = await f.controller().run(f.architecture, { resume: true });
  assert.equal(resumed.status, "completed", resumed.summary);
  const sessions = f.sessions.filter((entry) => objectFields(entry.options.sessionStorage!.binding).role === "developer"
    && objectFields(objectFields(entry.options.sessionStorage!.binding).scope).taskId === "core");
  assert.equal(sessions.length, 2); assert.equal(sessions[0]!.session.sessionFile, sessions[1]!.session.sessionFile);
  assert.match(await readFile(sessions[1]!.session.sessionFile!, "utf8"), /"type":"compaction"/);
  const requests = f.requests.filter((entry) => entry.role === "developer" && entry.payload.task?.id === "core");
  const final = requests.at(-1), latest = JSON.parse(textOf(final!.body.messages.findLast((message: { role: string; }) => message.role === "user")!.content));
  assert.deepEqual(latest.requirements, f.architecture.requirements, "实际送出请求必须含完整当前事实，不依赖被压缩的回执");
  assert.equal(latest.contextReuse, undefined);
  assert.ok(Object.values(resumed.sessions!).find((entry) => entry.file === reference!.file)!.compactions! >= 1);
});

test("同会话材料回执只复用完全相同的当前字段，新反馈和精确分页保持原文", async () => {
  const payload = { architectureRef: { version: 1 }, requirements: [{ id: "goal", text: "完整业务要求".repeat(2000) }],
    design: { rationale: "确定架构".repeat(1000) }, feedback: { reason: "旧反馈" }, modelBudget: { used: 0, remaining: 12 } };
  const reference: {bindingHash:string;file:string;turns:number;contextDelivery?: ContextDelivery|undefined} = { bindingHash: "a".repeat(64), file: "native.jsonl", turns: 1 };
  const first = developmentContextMessage(payload, 128000, { reference, messages: [] });
  reference.contextDelivery = first.delivery;
  const messages: SessionMessage[] = [{ role: "user", content: [{ type: "text", text: first.message }] }, { role: "assistant", stopReason: "toolUse", content: [] }];
  const current = { ...payload, feedback: { reason: "本轮实际失败" }, modelBudget: { used: 1, remaining: 11 } };
  const next = developmentContextMessage(current, 128000, { reference, messages }), sent = JSON.parse(next.message);
  assert.ok(sent.contextReuse.sections.includes("requirements")); assert.equal(sent.requirements, undefined);
  assert.deepEqual(sent.feedback, current.feedback); assert.deepEqual(sent.modelBudget, current.modelBudget);
  assert.ok(next.message.length < first.message.length / 3);
  const afterCompaction = [{ role: "compactionSummary", summary: "仅摘要" }, { role: "user", content: next.message },
    { role: "assistant", stopReason: "toolUse", content: [] }, { role: "toolResult", toolCallId: "local-tool", content: [] }];
  const projected = restoreDevelopmentContext(afterCompaction, current, 128000, next);
  assert.deepEqual(JSON.parse(textOf(projected[1]!.content)).requirements, current.requirements);
  assert.equal(projected[2], afterCompaction[2]); assert.equal(projected[3], afterCompaction[3]);
  assert.equal(restoreDevelopmentContext(messages, current, 128000, next), messages, "原文仍在时不重复注入");
  const page = JSON.parse(toolText((await createContextReadTool(() => current).execute("precise", { section: "requirements", limit: 8000 }))));
  assert.equal(page.text, JSON.stringify(current.requirements).slice(0, 8000));
  reference.contextDelivery = next.delivery;
  messages.push({ role: "user", content: next.message }, { role: "assistant", stopReason: "stop", content: [] });
  const third = developmentContextMessage(current, 128000, { reference, messages });
  assert.ok(JSON.parse(third.message).contextReuse.sections.includes("requirements"), "增量回执继续引用仍在场的原完整消息");
  assert.equal(JSON.stringify(third.delivery).includes("完整业务要求"), false, "回执只记录宿主摘要，不再存一份工作材料");
});

test("材料回执缺失、绑定变化、未完成回复或压缩移除原文时保守重传", () => {
  const payload = { architectureRef: { version: 1 }, requirements: [{ id: "goal", text: "完整要求".repeat(2000) }] };
  const reference: {bindingHash:string;file:string;turns:number;contextDelivery?: ContextDelivery|undefined} = { bindingHash: "a".repeat(64), file: "native.jsonl", turns: 1 };
  const first = developmentContextMessage(payload, 128000, { reference, messages: [] });
  const native: SessionMessage[] = [{ role: "user", content: first.message }, { role: "assistant", stopReason: "stop", content: [] }];
  const variants: [ {bindingHash:string;file:string|null;turns:number;contextDelivery?:ContextDelivery|undefined}, SessionMessage[] ][] = [
    [{ ...reference }, native],
    [{ ...reference, contextDelivery: first.delivery, file: null }, native],
    [{ ...reference, contextDelivery: first.delivery, bindingHash: "b".repeat(64) }, native],
    [{ ...reference, contextDelivery: first.delivery }, [Object.assign({ role: "compactionSummary" }, { summary: "材料已被压缩" }), native[1]!]],
    [{ ...reference, contextDelivery: first.delivery }, [native[0]!, { role: "assistant", stopReason: "aborted", content: [] }]],
    [{ ...reference, contextDelivery: first.delivery }, [{ ...native[0]!, content: first.message + " " }, native[1]!]],
  ];
  for (const [changed, messages] of variants) {
    const result = JSON.parse(developmentContextMessage(payload, 128000, { reference: changed, messages }).message);
    assert.equal(result.contextReuse, undefined); assert.deepEqual(result.requirements, payload.requirements);
  }
});

test("首轮剩余空间可容纳规划结构时直接提供，当前需求及计划优先保留", () => {
  const payload = { architectureRef: { version: 1 }, requirements: [{ id: "goal", text: "完整需求".repeat(400) }],
    plan: { summary: "当前计划", tasks: [], cases: [] }, planSchema: { description: "公开结构".repeat(400) },
    platformSnapshot: { large: "其他事实".repeat(10000) } };
  const compact = compactDevelopmentContext(payload, 16000);
  assert.deepEqual(compact.requirements, payload.requirements); assert.deepEqual(compact.plan, payload.plan);
  assert.deepEqual(compact.planSchema, payload.planSchema);
  assert.equal(compact.contextSections!.find((item) => item.section === "planSchema")!.delivery, "full");
  assert.ok(JSON.stringify(compact).length <= 16000);
});

test("真实 Pi 独立评审中断后沿用同一对象和报告，恢复不重跑已保存的验收", async (t) => {
  const f = await fixture(t, { interruptReviewer: true }), initial = await f.controller().run(f.architecture);
  assert.equal(initial.status, "failed"); assert.equal(initial.pendingReview!.mode, "task");
  assert.equal(initial.reports.length, 1); const report = initial.reports[0], pending = initial.pendingReview;
  const original = f.sessions.findLast((entry) => entry.options.customTools!.some((tool: { name: string; }) => tool.name === submitNames.reviewer));
  const resumed = await f.controller().run(f.architecture, { resume: true });
  assert.equal(resumed.status, "completed", resumed.summary);
  const taskReviews = f.requests.filter((entry) => entry.role === "reviewer" && entry.payload.mode === "task" && entry.payload.task!.id === "core");
  assert.equal(taskReviews.length, 2); assert.equal(taskReviews[1]!.payload.subjectHash, pending!.subjectHash);
  assert.equal(taskReviews[1]!.payload.report!.id, report!.id);
  assert.ok(taskReviews[1]!.body.messages.some((message) => message.role === "assistant" && textOf(message.content).includes("reviewer-interruption-history-marker")));
  const matching = f.executionCalls.filter((entry) => entry.codeHash === report!.codeHash && JSON.stringify(entry.caseIds) === JSON.stringify(report!.results.map((item) => item.caseId)));
  assert.equal(matching.length, 1, "已保存同一代码和用例的真实执行证据不重复跑");
  const resumedSession = f.sessions.find((entry) => entry !== original && entry.session.sessionFile === original!.session.sessionFile);
  assert.ok(resumedSession);
});

test("模型与原生压缩在发请求前持久扣预算，控制器重建后不重置", async (t) => {
  const f = await fixture(t, { interruptDeveloper: true, compactDeveloper: true, developerTurns: 3 });
  const initial = await f.controller().run(f.architecture), reference = Object.values(initial.sessions!).find((entry) => entry.role === "developer");
  assert.equal(initial.status, "failed"); assert.equal(reference!.turns, 3, initial.summary); assert.equal(reference!.compactions, 1);
  assert.equal(initial.tasks[0]!.turns, 3);
  const before = f.requests.length, resumed = await f.controller().run(f.architecture, { resume: true });
  assert.equal(resumed.status, "failed"); assert.equal(resumed.diagnostic!.reason, "turn_limit");
  assert.equal(f.requests.length, before, "预算耗尽时恢复不得再发模型或压缩请求");
  assert.equal(Object.values(resumed.sessions!).find((entry) => entry.file === reference!.file)!.turns, 3);
  const runtime = f.sessions.find((entry) => entry.options.customTools!.some((tool: { name: string; }) => tool.name === submitNames.developer));
  assert.match(await readFile(runtime!.session.sessionFile!, "utf8"), /compaction/);
});

test("恢复不允许把已保存的研发会话接到新架构版本", async (t) => {
  const f = await fixture(t, { interruptDeveloper: true });
  const initial = await f.controller().run(f.architecture); assert.equal(initial.status, "failed");
  const changed = structuredClone(f.architecture); changed.version++;
  const before = f.requests.length;
  await assert.rejects(f.controller().run(changed, { resume: true }), /可恢复研发记录|架构版本/);
  assert.equal(f.requests.length, before);
});

test("恢复前核对计划摘要与授权文件，合法结构的错配记录也不能接入旧开发历史", async (t) => {
  const changes: ((record: DevelopmentRunRecord) => void)[] = [
    (record) => { record.plan!.tasks[0]!.description += "新增未绑定范围"; },
    (record) => { record.tasks[0]!.files = ["outside.mjs"]; },
    (record) => { record.tasks[0]!.taskHash = "0".repeat(64); },
  ];
  for (const change of changes) {
    const f = await fixture(t, { interruptDeveloper: true }), controller = f.controller(), initial = await controller.run(f.architecture);
    assert.equal(initial.status, "failed"); change(initial); await controller.store.save(initial);
    const before = f.requests.length, resumed = await f.controller().run(f.architecture, { resume: true });
    assert.equal(resumed.status, "failed"); assert.match(resumed.summary, /计划.*不一致|任务.*不一致/);
    assert.equal(f.requests.length, before, "错配记录必须在调用模型之前拒绝");
  }
});

test("代码改变后不复用旧代码的评审会话或执行报告", async (t) => {
  const f = await fixture(t, { interruptReviewer: true }), controller = f.controller(), initial = await controller.run(f.architecture);
  const original = initial.pendingReview, oldReport = initial.reports[0];
  f.setSource('console.log(JSON.stringify({changed:true}));\n');
  const tools = await controller.workspace.tools(initial.agentId, initial.id, { allowedFiles: ["main.mjs"] });
  await tools.find((tool) => tool.name === "write_code_file")!.execute("external-change", { path: "main.mjs", content: 'console.log(JSON.stringify({changed:true}));\n' });
  const resumed = await f.controller().run(f.architecture, { resume: true });
  assert.equal(resumed.status, "completed", resumed.summary);
  const reviews = f.requests.filter((entry) => entry.role === "reviewer" && entry.payload.mode === "task" && entry.payload.task!.id === "core");
  assert.equal(reviews.length, 2); assert.notEqual(reviews[1]!.payload.subjectHash, original!.subjectHash);
  assert.notEqual(reviews[1]!.payload.report!.id, oldReport!.id);
  assert.ok(!reviews[1]!.body.messages.some((message) => textOf(message.content).includes("reviewer-interruption-history-marker")));
});

test("最后一轮的有效提交已持久化时，崩溃后直接消费结果，不加模型回合也不重复开发", async (t) => {
  const f = await fixture(t, { crashAfterDeveloperSubmit: true, developerTurns: 2 }), initial = await f.controller().run(f.architecture);
  assert.equal(initial.status, "failed"); assert.equal(initial.tasks[0]!.turns, 2);
  const reference = Object.values(initial.sessions!).find((item) => item.role === "developer");
  assert.equal(reference!.turns, 2); assert.ok(reference!.pendingResult);
  const beforeCore = f.requests.filter((entry) => entry.role === "developer" && entry.payload.task!.id === "core").length;
  const resumed = await f.controller().run(f.architecture, { resume: true });
  assert.equal(resumed.status, "completed", resumed.summary);
  const afterCore = f.requests.filter((entry) => entry.role === "developer" && entry.payload.task!.id === "core").length;
  assert.equal(afterCore, beforeCore, "有效提交恢复必须在回合上限检查前消费，不能要求新模型请求");
  assert.equal(Object.values(resumed.sessions!).find((item) => item.file === reference!.file)!.pendingResult, undefined);
  assert.equal(resumed.tasks[0]!.turns, 2);
});

test("未授权的改动声明在保存阶段结果前拒绝，真实 Pi 原会话可以立即纠正", async (t) => {
  const f = await fixture(t, { rejectDeveloperFiles: true }), result = await f.controller().run(f.architecture);
  assert.equal(result.status, "completed", result.summary);
  const core = f.requests.filter((entry) => entry.role === "developer" && entry.payload.task!.id === "core");
  assert.equal(core.length, 3, "写入、被拒提交、修正提交使用同一开发会话的三个原模型回合");
  const feedback = core.at(-1)!.body.messages.filter((message: { role: string; }) => message.role === "tool").map((message) => textOf(message.content)).join("\n");
  assert.match(feedback, /work\.changedFiles.*work_file_unauthorized/);
  assert.equal(f.sessions.filter((entry) => objectFields(entry.options.sessionStorage!.binding).role === "developer"
    && objectFields(objectFields(entry.options.sessionStorage!.binding).scope).taskId === "core").length, 1);
  const rejected = result.submissionAttempts!.find((entry) => entry.role === "developer" && entry.status === "rejected");
  assert.equal(rejected!.issues[0]!.path, "work.changedFiles");
  assert.equal(result.tasks[0]!.turns, 3);
});

test("旧记录的越权声明待消费结果只清理该提交，恢复原历史并保留已用预算", async (t) => {
  const f = await fixture(t, { crashAfterDeveloperSubmit: true, developerTurns: 4 }), controller = f.controller();
  const initial = await controller.run(f.architecture), reference = Object.values(initial.sessions!).find((item) => item.role === "developer");
  assert.equal(initial.status, "failed"); assert.equal(reference!.turns, 2);
  objectFields(reference!.pendingResult!.result).changedFiles = ["mistaken.mjs"];
  await controller.store.save(initial);
  const resumed = await f.controller().run(f.architecture, { resume: true });
  assert.equal(resumed.status, "completed", resumed.summary);
  const coreSessions = f.sessions.filter((entry) => objectFields(entry.options.sessionStorage!.binding).role === "developer"
    && objectFields(objectFields(entry.options.sessionStorage!.binding).scope).taskId === "core");
  assert.equal(coreSessions.length, 2); assert.equal(coreSessions[0]!.session.sessionFile, coreSessions[1]!.session.sessionFile);
  const core = f.requests.filter((entry) => entry.role === "developer" && entry.payload.task!.id === "core");
  assert.equal(core.length, 4); assert.equal(resumed.tasks[0]!.turns, 4, "清理旧坏提交不能归零已用回合");
  assert.equal(core[2]!.payload.submissionFeedback!.issues![0]!.reason, "work_file_unauthorized");
  assert.ok(core[2]!.body.messages.some((message) => message.tool_calls?.some((call: { function: { name: string; }; }) => call.function.name === submitNames.developer)),
    "已保存的原会话开发历史继续可见");
  assert.equal(Object.values(resumed.sessions!).find((item) => item.file === reference!.file)!.pendingResult, undefined);
});

test("越权声明旧提交清理后预算耗尽仍停止，不新开会话、不重复调用或放行", async (t) => {
  const f = await fixture(t, { crashAfterDeveloperSubmit: true, developerTurns: 2 }), controller = f.controller();
  const initial = await controller.run(f.architecture), reference = Object.values(initial.sessions!).find((item) => item.role === "developer");
  objectFields(reference!.pendingResult!.result).changedFiles = ["mistaken.mjs"];
  await controller.store.save(initial);
  const before = f.requests.length, resumed = await f.controller().run(f.architecture, { resume: true });
  assert.equal(resumed.status, "failed"); assert.equal(resumed.diagnostic!.reason, "turn_limit");
  assert.equal(f.requests.length, before); assert.equal(resumed.tasks[0]!.turns, 2);
  const saved = Object.values(resumed.sessions!).find((item) => item.file === reference!.file);
  assert.equal(saved!.pendingResult, undefined); assert.equal(saved!.turns, 2);
  assert.equal(resumed.package, null); assert.equal(resumed.tasks[0]!.status, "active");
  const again = await f.controller().run(f.architecture, { resume: true });
  assert.equal(again.diagnostic!.reason, "turn_limit"); assert.equal(f.requests.length, before);
  assert.equal(Object.values(again.sessions!).filter((item) => item.role === "developer").length, 1);
});

test("待消费结果的结构或对象代码绑定损坏仍严格拒绝，不按旧越权声明清理", async (t) => {
  const mutations: ((pending: NonNullable<NonNullable<DevelopmentRunRecord["sessions"]>[string]["pendingResult"]>) => void)[] = [
    (pending) => { objectFields(pending.result).changedFiles = "mistaken.mjs"; },
    (pending) => { pending.subjectHash = "0".repeat(64); },
    (pending) => { pending.planHash = "0".repeat(64); },
    (pending) => { pending.codeHash = "0".repeat(64); },
  ];
  for (const mutate of mutations) {
    const f = await fixture(t, { crashAfterDeveloperSubmit: true, developerTurns: 4 }), controller = f.controller();
    const initial = await controller.run(f.architecture), reference = Object.values(initial.sessions!).find((item) => item.role === "developer");
    objectFields(reference!.pendingResult!.result).changedFiles = ["mistaken.mjs"];
    mutate(reference!.pendingResult!); await controller.store.save(initial);
    const before = f.requests.length, resumed = await f.controller().run(f.architecture, { resume: true });
    assert.equal(resumed.status, "failed"); assert.equal(resumed.diagnostic!.reason, "invalid_result");
    assert.equal(f.requests.length, before, "损坏结构或错配对象必须在新模型请求前拒绝");
    const saved = Object.values(resumed.sessions!).find((item) => item.file === reference!.file);
    assert.deepEqual(saved!.pendingResult, reference!.pendingResult, "不能把其他损坏归入可恢复的授权声明错误");
    assert.equal(saved!.turns, 2); assert.equal(resumed.package, null);
  }
});
