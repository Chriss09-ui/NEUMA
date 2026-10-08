import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrototypeAgents } from "../agent-prototype.mjs";
import { ArchitectureDesigner } from "../architecture.mjs";
import { DevelopmentController } from "../development.mjs";
import { DevelopmentExecutor } from "../development-executor.mjs";
import { validDraft, validDesign, passingReview } from "./helpers/architecture.mjs";
import { developmentReview, developmentWork } from "./helpers/development.mjs";

const localMac = { skip: process.platform !== "darwin", timeout: 20000 };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const fixtureToolResult = (result) => JSON.parse(result.content[0].text);

function request(goal = "把用户提供的文本去掉首尾空白并转成大写") {
  const draft = validDraft(goal);
  for (const [key, value] of Object.entries({ name: "规范化流程测试桩", scenario: "按需检查短文本格式",
    inputSource: "用户在本轮提供的文本", task: "去掉首尾空白、转大写并处理空输入和长度上限",
    deliverable: "包含 normalized 和 length 的 JSON，拒绝场景返回明确 error",
    successCriteria: "输出具体内容和值正确；超过32字符明确拒绝；不执行对外动作" })) draft[key] = { value, source: "user" };
  return { id: "normalizer", name: "规范化流程测试桩", draft };
}

function fixtureDesign(requirements, needsConnection) {
  return validDesign(requirements, {
    profile: "workflow", rationale: "测试桩方案：需要实现独立、可执行的 Node 输入验证及转换流程。",
    instructions: "这是交付集成测试的模拟角色指令。用户提供文本时调用已验收流程，以工具实际返回值回答。不得声称调用正式外部服务。",
    state: { mode: "task", reason: "只处理本轮输入，无跨任务持久状态" },
    capabilities: [{ id: "workflow_execution", status: "needs_development", reason: "待生成并实际验证 Node JSON 入口" },
      ...(needsConnection ? [{ id: "formal_service", status: "needs_connection", reason: "正式连接未配置；测试仅验证本地转换，不代表正式服务可用" }] : [])],
    acceptance: [
      { id: "valid", kind: "success", requirementIds: requirements.map((item) => item.id), input: "  hello neuma  ", expected: "normalized为HELLO NEUMA，length为11" },
      { id: "empty", kind: "missing_input", requirementIds: ["inputSource"], input: "空字符串", expected: "error为missing_input" },
      { id: "boundary", kind: "boundary", requirementIds: ["successCriteria", "externalAction"], input: "x".repeat(33), expected: "error为input_too_long，不执行外部动作" },
      { id: "tool_failure", kind: "tool_failure", requirementIds: ["deliverable"], input: "[fixture_io_failure]", expected: "测试桩模拟依赖失败时error为upstream_unavailable，不能声称连接正式服务" },
    ],
  });
}

function fixturePlan(payload) {
  const expected = {
    valid: { normalized: "HELLO NEUMA", length: 11 }, empty: { error: "missing_input" },
    boundary: { error: "input_too_long" }, tool_failure: { error: "upstream_unavailable" },
  };
  return { summary: "测试桩计划：实现并验证输入转换与全部拒绝场景", runtime: "node-json", entrypoint: "main.mjs",
    tasks: [{ id: "normalize", title: "实现输入转换", description: "实现Node JSON入口和已固定的全部验收条件",
      requirementIds: payload.requirements.map((item) => item.id), acceptanceIds: payload.design.acceptance.map((item) => item.id),
      dependsOn: [], files: ["main.mjs"] }],
    cases: payload.design.acceptance.map((item) => ({ id: `case_${item.id}`, taskId: "normalize", acceptanceId: item.id,
      input: item.id === "empty" ? "" : item.input, assertions: [{ path: "", expectedJson: JSON.stringify(expected[item.id]) }] })) };
}

function fixtureSource(buildNumber, task) {
  return `// Explicit model fixture for delivery integration tests. Build ${buildNumber}; task ${task.id}.
const input = process.argv[2] ?? "";
const normalized = input.trim().toUpperCase();
const result = input === "[fixture_io_failure]" ? {error:"upstream_unavailable"}
  : !normalized ? {error:"missing_input"}
  : normalized.length > 32 ? {error:"input_too_long"}
  : {normalized,length:normalized.length};
console.log(JSON.stringify(result));
`;
}

// Only model behavior is simulated. All file tools, controllers, persistence,
// snapshots, subprocess verification and runtime execution use real code.
function modelFixture(records, { needsConnection = false } = {}) {
  let buildNumber = 0;
  return async (options) => {
    const tools = Object.fromEntries(options.customTools.map((tool) => [tool.name, tool]));
    const submit = ["submit_architecture", "submit_architecture_review", "submit_development_plan", "submit_development_review", "submit_development_work"]
      .find((name) => tools[name]);
    const role = submit ?? "runtime";
    const record = { role, tools, options, prompts: [], disposed: false, aborted: false, toolResults: [] };
    records.push(record);
    let listener, lastText = "";
    const session = { messages: [], subscribe(fn) { listener = fn; return () => { listener = null; }; },
      setAutoCompactionEnabled() {}, getContextUsage() { return { percent: 10 }; },
      async prompt(message) {
        if (!submit) {
          assert.ok(tools.run_developed_workflow, "运行会话必须获得真实交付工具");
          record.prompts.push(message);
          const input = message.slice(message.lastIndexOf("用户本轮任务：") + "用户本轮任务：".length);
          const actual = fixtureToolResult(await tools.run_developed_workflow.execute("fixture-runtime-call", { input }));
          record.toolResults.push(actual);
          lastText = `测试桩转述真实流程结果：${JSON.stringify(actual.result)}`;
          listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: lastText } });
        } else {
          const payload = JSON.parse(message); record.prompts.push(payload);
          if (submit === "submit_architecture") {
            buildNumber++;
            await tools[submit].execute("fixture-design", fixtureDesign(payload.requirements, needsConnection));
          } else if (submit === "submit_architecture_review") {
            await tools[submit].execute("fixture-design-review", passingReview(payload.candidateHash));
          } else if (submit === "submit_development_plan") {
            await tools[submit].execute("fixture-plan", fixturePlan(payload));
          } else if (submit === "submit_development_review") {
            assert.equal(Boolean(tools.write_code_file), false);
            if (payload.mode !== "plan") {
              const code = fixtureToolResult(await tools.read_code_file.execute("fixture-review-read", { path: "main.mjs" }));
              assert.match(code.content, /process\.argv\[2\]/);
              record.toolResults.push(code);
            }
            await tools[submit].execute("fixture-review", developmentReview(payload.subjectHash));
          } else {
            await tools.write_code_file.execute("fixture-code-write", { path: "main.mjs", content: fixtureSource(buildNumber, payload.task) });
            const checks = fixtureToolResult(await tools.run_development_checks.execute("fixture-self-test", {}));
            assert.equal(checks.status, "passed", JSON.stringify(checks)); record.toolResults.push(checks);
            await tools[submit].execute("fixture-work", developmentWork(payload.task, { summary: "测试桩已写入实际代码并完成真实隔离自测" }));
          }
          lastText = "模拟模型已提交；是否通过由真实程序检查决定。";
        }
        session.messages.push({ role: "assistant", stopReason: "stop", content: lastText });
        listener?.({ type: "turn_end" });
      },
      getLastAssistantText: () => lastText,
      async abort() { record.aborted = true; }, dispose() { record.disposed = true; },
    };
    record.session = session; return session;
  };
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-delivery-integration-"));
  const dataDir = join(root, "data"), sessions = [];
  const agents = new PrototypeAgents({ config: { llmConfigured: true }, cwd: root, dataDir,
    sessionFactory: modelFixture(sessions, options) });
  t.after(async () => {
    await agents.close();
    const unseal = async (path) => {
      await chmod(path, 0o700);
      for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await unseal(join(path, entry.name));
    };
    await unseal(root); await rm(root, { recursive: true, force: true });
  });
  assert.ok(agents.architecture instanceof ArchitectureDesigner);
  assert.ok(agents.development instanceof DevelopmentController);
  assert.ok(agents.development.executor instanceof DevelopmentExecutor);
  const probe = await agents.development.executor.probe();
  assert.equal(probe.available, true, `本机真实系统隔离必须可用：${probe.reason}`);
  return { agents, root, dataDir, sessions, executor: agents.development.executor };
}

test("真实交付闭环：架构评估→研发隔离验收→激活→运行工具返回实际变换结果", localMac, async (t) => {
  const { agents, sessions, dataDir } = await fixture(t);
  const build = await agents.build(request());
  assert.equal(build.architecture.status, "passed"); assert.equal(build.architecture.delivery, "ready");
  assert.equal(build.development.status, "completed"); assert.equal(build.development.delivery, "ready");
  assert.equal(build.agent.execution.kind, "node-json");
  const record = await agents.development.store.getRun(build.development.id);
  assert.equal(record.execution.available, true);
  assert.equal(record.reports.at(-1).status, "passed"); assert.equal(record.reports.at(-1).mode, "integration");
  assert.equal(record.runtimeCheck.status, "passed");
  assert.equal(record.package.codeHash, build.agent.execution.codeHash);
  assert.equal(record.package.snapshot.hash, build.agent.developmentRef.codeHash);
  assert.equal(record.package.planHash, build.agent.developmentRef.planHash);
  assert.deepEqual(build.agent.architectureRef, record.architectureRef);
  assert.deepEqual(new Set(record.plan.cases.map((item) => item.acceptanceId)), new Set(build.architecture.design.acceptance.map((item) => item.id)));
  assert.deepEqual(record.reports.at(-1).results[0].actual, { normalized: "HELLO NEUMA", length: 11 });
  assert.ok(record.reports.at(-1).results.every((item) => item.status === "passed" && item.exitCode === 0));
  assert.equal((await agents.development.workspace.validateSnapshot(record.package.snapshot)).hash, record.package.codeHash);
  const persisted = JSON.parse(await readFile(join(dataDir, "agents", "normalizer", "definition.json"), "utf8"));
  assert.equal(persisted.agent.execution.codeHash, record.package.codeHash);
  const roleSessions = sessions.filter((item) => item.role !== "runtime");
  assert.equal(new Set(roleSessions.map((item) => item.session)).size, roleSessions.length);
  assert.ok(roleSessions.every((item) => item.disposed));
  const runtime = await agents.prompt({ agentId: "normalizer", sessionId: "delivery-runtime-session-1", message: "ship this code" });
  assert.equal(runtime.status, "complete"); assert.match(runtime.reply, /"normalized":"SHIP THIS CODE","length":14/);
  const runtimeSession = sessions.find((item) => item.role === "runtime");
  assert.deepEqual(runtimeSession.toolResults, [{ status: "completed", result: { normalized: "SHIP THIS CODE", length: 14 } }]);
  assert.deepEqual(Object.keys(runtimeSession.tools), ["run_developed_workflow"]);
});

test("首轮交付启动失败携带原始证据进入新修复会话，重验后激活新快照", localMac, async (t) => {
  const { agents, sessions, executor } = await fixture(t);
  const realVerify = executor.verify.bind(executor), realRun = executor.run.bind(executor);
  let verifying = 0, injected = false;
  const runtimeChecks = [];
  executor.verify = async (options) => { verifying++; try { return await realVerify(options); } finally { verifying--; } };
  executor.run = async (options) => {
    const actual = await realRun(options);
    if (verifying) return actual;
    runtimeChecks.push({ codeDir: options.codeDir, input: options.input, actual });
    assert.equal(actual.status, "passed", "故障注入前仍实际执行隔离启动");
    if (!injected) {
      injected = true;
      return { ...actual, status: "failed", exitCode: 1, stderr: "fixture-only startup defect", reason: "fixture_startup_failure" };
    }
    return actual;
  };
  const build = await agents.build(request());
  assert.equal(build.development.status, "completed"); assert.equal(build.development.delivery, "ready");
  const record = await agents.development.store.getRun(build.development.id);
  const developers = sessions.filter((item) => item.role === "submit_development_work");
  assert.equal(developers.length, 2); assert.notEqual(developers[0].session, developers[1].session);
  assert.equal(developers[1].prompts[0].task.integration, true);
  const feedback = developers[1].prompts[0].feedback;
  assert.equal(feedback.report.mode, "runtime"); assert.equal(feedback.report.status, "failed");
  assert.equal(feedback.report.results[0].caseId, "runtime_start");
  assert.equal(feedback.report.results[0].input, "  hello neuma  ");
  assert.equal(feedback.report.results[0].stderr, "fixture-only startup defect");
  assert.equal(feedback.report.results[0].reason, "fixture_startup_failure");
  assert.deepEqual(feedback.report.results[0].output, { normalized: "HELLO NEUMA", length: 11 });
  assert.equal(record.budgets.corrections, 5); assert.equal(record.budgets.integrationRepairs, 1);
  assert.equal(runtimeChecks.length, 2); assert.notEqual(runtimeChecks[0].codeDir, runtimeChecks[1].codeDir);
  assert.notEqual(record.package.codeHash, feedback.report.codeHash);
  assert.equal(record.package.codeHash, build.agent.developmentRef.codeHash);
  assert.equal(record.package.codeHash, record.reports.at(-1).codeHash);
  assert.equal(record.reports.at(-1).mode, "integration"); assert.equal(record.reports.at(-1).status, "passed");
  const finalSource = await readFile(join(record.package.snapshot.path, "main.mjs"), "utf8");
  assert.match(finalSource, /task integration_/);
});

test("缺少正式连接仍完成真实本地验收和打包，但不激活运行定义", localMac, async (t) => {
  const { agents, sessions } = await fixture(t, { needsConnection: true });
  const input = request(); input.draft.capabilityDependencies = ["正式服务连接，当前仅验证本地转换逻辑"];
  const build = await agents.build(input);
  assert.equal(build.architecture.status, "passed"); assert.equal(build.architecture.delivery, "needs_connection");
  assert.equal(build.development.status, "completed"); assert.equal(build.development.delivery, "needs_connection");
  assert.equal(build.agent, null); assert.equal(await agents.get("normalizer"), null);
  const record = await agents.development.store.getRun(build.development.id);
  assert.ok(record.package); assert.equal(record.reports.at(-1).status, "passed");
  assert.equal(record.runtimeCheck, null);
  assert.match(record.summary, /连接.*正式服务/);
  await assert.rejects(agents.prompt({ agentId: "normalizer", sessionId: "not-connected-session-1", message: "hello" }), /请先创建/);
  assert.equal(sessions.some((item) => item.role === "runtime"), false);
});

test("最终完成记录写入期间取消：新版不成功，旧定义、用户资料及原交付包保留", localMac, async (t) => {
  const { agents, dataDir } = await fixture(t);
  const first = await agents.build(request());
  assert.equal(first.development.delivery, "ready");
  await agents.setMemory("normalizer", "保留这段用户记忆");
  await agents.setProfile("normalizer", { name: "用户的旧名称", description: "保留展示资料", icon: "N" });
  const userDirectory = await agents.workspace("normalizer"); await writeFile(join(userDirectory, "keep.txt"), "用户已有文件");
  const previous = await agents.get("normalizer");
  const previousRecord = await agents.development.store.getRun(previous.developmentRef.id);
  const entered = deferred(), release = deferred(), controller = new AbortController();
  const store = agents.development.store, originalSave = store.save.bind(store);
  let blocked = false, completingRecord;
  store.save = async (value, options) => {
    if (!blocked && value.id !== previous.developmentRef.id && value.status === "completed") {
      blocked = true; completingRecord = structuredClone(value); entered.resolve(); await release.promise;
    }
    return originalSave(value, options);
  };
  const pending = agents.build(request("把短文本去空白转大写，保留新需求版本标记"), { signal: controller.signal });
  let result;
  try {
    await Promise.race([entered.promise, pending.then(() => { throw new Error("未进入最终完成记录写入点"); })]);
    assert.notEqual(completingRecord.id, previous.developmentRef.id);
    assert.notEqual(completingRecord.package.codeHash, previous.developmentRef.codeHash);
    controller.abort(); release.resolve(); result = await pending;
  } finally { release.resolve(); await pending.catch(() => {}); store.save = originalSave; }
  assert.equal(result.development.status, "cancelled"); assert.equal(result.development.delivery, "blocked");
  assert.deepEqual(await agents.get("normalizer"), previous);
  const saved = await agents.get("normalizer");
  const persisted = JSON.parse(await readFile(join(dataDir, "agents", "normalizer", "definition.json"), "utf8")).agent;
  assert.deepEqual(persisted.developmentRef, previous.developmentRef);
  assert.deepEqual(saved.developmentRef, previous.developmentRef); assert.equal(saved.revision, previous.revision);
  assert.equal(saved.memory, "保留这段用户记忆"); assert.deepEqual(saved.profile, previous.profile);
  assert.equal(await readFile(join(userDirectory, "keep.txt"), "utf8"), "用户已有文件");
  assert.deepEqual((await agents.development.store.getRun(previous.developmentRef.id)).package, previousRecord.package);
  assert.equal((await agents.development.store.getRun(result.development.id)).status, "cancelled");
  assert.equal((await agents.getArchitecture("normalizer")).delivery, "blocked");
  await assert.rejects(agents.prompt({ agentId: "normalizer", sessionId: "cancelled-new-version-session", message: "hello" }), /尚未生成可运行定义/);
});
