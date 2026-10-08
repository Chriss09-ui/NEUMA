import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevelopmentController } from "../development.mjs";
import { DevelopmentStore } from "../development-store.mjs";
import { DevelopmentWorkspace } from "../development-workspace.mjs";
import { hashValue } from "../development-contract.mjs";
import { InputError } from "../core.mjs";
import { developmentArchitecture, developmentPlan, developmentReview, developmentIssue, developmentWork } from "./helpers/development.mjs";

const submissionNames = { planner: "submit_development_plan", developer: "submit_development_work", reviewer: "submit_development_review" };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function modelFactory(records, onPrompt) {
  return async (options) => {
    const tools = Object.fromEntries(options.customTools.map((tool) => [tool.name, tool]));
    const role = Object.keys(submissionNames).find((key) => tools[submissionNames[key]]);
    assert.ok(role, "模拟模型会话必须有当前职责的结构化提交工具");
    const record = { role, options, tools, prompts: [], disposed: false, aborted: false, usagePercent: 10 };
    let listener;
    const submit = (value) => tools[submissionNames[role]].execute("fixture-submit", value);
    const session = {
      messages: [],
      subscribe(fn) { listener = fn; return () => { listener = null; }; },
      async prompt(message) {
        const payload = JSON.parse(message); record.payload = payload; record.prompts.push(payload);
        session.messages.push({ role: "user", content: message });
        const write = async () => {
          for (const path of payload.task.files) await tools.write_code_file.execute("fixture-write", {
            path, content: `// simulated model task ${payload.task.id}, prompt ${record.prompts.length}\nconsole.log(JSON.stringify({ok:true}));\n`,
          });
        };
        const respond = async () => {
          if (role === "planner") return submit(developmentPlan({ requirements: payload.requirements, design: payload.design }));
          if (role === "reviewer") return submit(developmentReview(payload.subjectHash));
          await write(); return submit(developmentWork(payload.task));
        };
        if (onPrompt) await onPrompt({ record, session, payload, submit, respond, write, emit: (event) => listener?.(event) });
        else await respond();
        session.messages.push({ role: "assistant", stopReason: "stop", content: "模拟回复，完成状态由提交工具决定" });
        listener?.({ type: "turn_end" });
      },
      getContextUsage() { return { percent: record.usagePercent }; },
      async abort() { record.aborted = true; record.release?.(); },
      dispose() { record.disposed = true; },
    };
    record.session = session; records.push(record); return session;
  };
}

// This executor deliberately simulates results. These tests verify orchestration, not generated program behavior.
function fakeExecutor({ onVerify, onProbe, onRun } = {}) {
  const calls = { probe: [], verify: [], run: [] };
  const executor = {
    calls,
    async probe(options) {
      calls.probe.push(options);
      return onProbe ? onProbe(options) : { available: true, kind: "test-fake", reason: "仅用于控制器测试的模拟隔离执行器" };
    },
    async run(options) {
      calls.run.push(options);
      return onRun ? onRun(options) : { status: "passed", exitCode: 0, stdout: '{"ok":true}', stderr: "", output: { ok: true } };
    },
    async verify(options) {
      calls.verify.push(options);
      await readFile(join(options.snapshot.path, options.entrypoint), "utf8");
      const report = { status: "passed", codeHash: options.snapshot.hash, summary: "模拟全部用例通过",
        results: options.cases.map((item) => ({ caseId: item.id, taskId: item.taskId, acceptanceId: item.acceptanceId,
          status: "passed", input: item.input, exitCode: 0, stdout: item.assertions[0].expectedJson, stderr: "",
          actual: JSON.parse(item.assertions[0].expectedJson),
          expected: item.assertions.map(({ path, expectedJson }) => ({ path, value: JSON.parse(expectedJson) })) })) };
      return onVerify ? onVerify(options, report, calls.verify.length) : report;
    },
  };
  return executor;
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-development-controller-"));
  const dataDir = join(root, "data"), sessions = [], controllers = [];
  const architecture = developmentArchitecture();
  const executor = options.executor ?? fakeExecutor(options);
  const workspace = new DevelopmentWorkspace({ dataDir });
  const config = { config: { llmConfigured: true }, cwd: root, dataDir, workspace, executor,
    sessionFactory: modelFactory(sessions, options.onPrompt), getArchitecture: options.getArchitecture ?? (async () => architecture),
    ...(options.limits ? { limits: options.limits } : {}) };
  const controller = new DevelopmentController(config); controllers.push(controller);
  t.after(async () => {
    await Promise.all(controllers.map((item) => item.close()));
    const unseal = async (path) => {
      await chmod(path, 0o700);
      for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await unseal(join(path, entry.name));
    };
    await unseal(root); await rm(root, { recursive: true, force: true });
  });
  return { root, dataDir, sessions, architecture, controller, workspace, executor, config, controllers };
}

const failReport = (report, marker = "raw-failure") => ({ ...report, status: "failed", summary: "模拟业务断言不匹配",
  results: report.results.map((item, index) => index ? item : { ...item, status: "failed", actual: { error: marker },
    stdout: JSON.stringify({ error: marker }), stderr: `${marker}-stderr`, reason: "assertion_mismatch" }) });

test("两个任务使用独立会话，交接保留结果，评审均为全新只读会话", async (t) => {
  const { controller, sessions, architecture, executor } = await fixture(t);
  const result = await controller.run(architecture);
  assert.equal(result.status, "completed"); assert.equal(result.delivery, "needs_development");
  assert.deepEqual(sessions.map((item) => item.role), ["planner", "reviewer", "developer", "reviewer", "developer", "reviewer", "reviewer"]);
  const developers = sessions.filter((item) => item.role === "developer"), reviews = sessions.filter((item) => item.role === "reviewer");
  assert.notEqual(developers[0].session, developers[1].session);
  assert.equal(developers[0].prompts.length, 1); assert.equal(developers[1].prompts.length, 1);
  assert.equal(developers[0].payload.task.id, "core"); assert.equal(developers[1].payload.task.id, "guard");
  assert.equal(developers[1].payload.handoffs[0].taskId, "core");
  assert.equal(developers[1].payload.handoffs[0].codeHash, result.handoffs[0].codeHash);
  assert.equal(developers[1].session.messages.filter((item) => item.role === "user").length, 1);
  assert.equal(new Set(reviews.map((item) => item.session)).size, reviews.length);
  assert.ok(reviews.every((item) => !item.tools.write_code_file && !item.tools.run_development_checks));
  assert.ok(!sessions[0].tools.write_code_file, "规划会话只读");
  assert.ok(sessions.every((item) => item.disposed));
  assert.deepEqual(executor.calls.verify.map((item) => item.cases.length), [2, 4, 4], "任务验收包含前面任务的回归测试，最后整体验收");
  assert.equal(result.package.codeHash, result.reports.at(-1).codeHash);
  assert.equal(result.package.planHash, hashValue(result.plan));
  assert.equal(result.package.verificationId, result.reports.at(-1).id);
  assert.deepEqual(result.tasks.map((item) => item.status), ["verified", "verified"]);
});

test("同一任务失败修复保留开发会话，原始测试证据完整进入修复输入", async (t) => {
  const { controller, sessions, architecture } = await fixture(t, {
    onVerify: (_options, report, number) => number === 1 ? failReport(report, "unique-actual-output") : report,
    onPrompt: async ({ record, respond, payload }) => {
      if (record.role === "reviewer" && payload.mode === "task") {
        const developer = sessions.findLast((item) => item.role === "developer" && item.payload.task.id === payload.task.id);
        assert.equal(developer.disposed, false, "验收期间保留当前开发会话");
        await assert.rejects(developer.tools.write_code_file.execute("late-write", { path: "main.mjs", content: "late" }), /当前阶段/);
      }
      await respond();
    },
  });
  const result = await controller.run(architecture);
  assert.equal(result.status, "completed");
  const developers = sessions.filter((item) => item.role === "developer");
  assert.equal(developers.length, 2); assert.equal(developers[0].prompts.length, 2);
  assert.deepEqual(developers[0].prompts[1].feedback.report, result.reports[0]);
  assert.equal(developers[0].prompts[1].feedback.report.results[0].stderr, "unique-actual-output-stderr");
  assert.deepEqual(developers[0].prompts[1].feedback.report.results[0].actual, { error: "unique-actual-output" });
  assert.equal(result.reviews[1].verdict, "pass", "模拟评审误判通过也不能覆盖真实测试失败");
  assert.equal(result.tasks[0].repairs, 1); assert.equal(result.tasks[0].attempts, 2);
  assert.equal(result.budgets.corrections, 5);
});

test("整体验收失败创建新修复任务与新会话，携带完整失败证据再做整体验收", async (t) => {
  const { controller, sessions, architecture, executor } = await fixture(t, {
    onVerify: (_options, report, number) => number === 3 ? failReport(report, "integration-regression") : report,
  });
  const result = await controller.run(architecture);
  assert.equal(result.status, "completed");
  const developers = sessions.filter((item) => item.role === "developer");
  assert.equal(developers.length, 3); assert.equal(new Set(developers.map((item) => item.session)).size, 3);
  assert.equal(developers[2].payload.task.integration, true);
  assert.deepEqual(developers[2].payload.feedback.report, result.reports[2]);
  assert.equal(developers[2].payload.feedback.report.mode, "integration");
  assert.equal(result.tasks.length, 3); assert.ok(result.tasks.every((item) => item.status === "verified"));
  assert.equal(result.budgets.integrationRepairs, 1); assert.equal(result.budgets.corrections, 5);
  assert.equal(executor.calls.verify.length, 5); assert.equal(result.reports.at(-1).mode, "integration");
});

test("交付启动失败把原始证据交给新修复会话，扣一次预算并重新完整验收", async (t) => {
  const { controller, sessions, architecture, executor } = await fixture(t);
  const activations = [];
  const smoke = { status: "failed", summary: "模拟交付入口输出不符合协议", results: [{
    caseId: "runtime_start", input: "实际启动输入", status: "failed", exitCode: 1,
    stdout: "unique-smoke-stdout", stderr: "unique-smoke-stderr", reason: "stdout_must_be_one_json_value",
    actual: { output: "wrong" }, expected: { output: "structured-json" },
  }] };
  const result = await controller.run(architecture, { activate: async (record) => {
    activations.push(record);
    if (activations.length === 1) return { delivery: "blocked", summary: "需要修复启动问题", repair: smoke };
    return { delivery: "ready", summary: "模拟运行检查通过", runtimeCheck: { status: "passed", codeHash: record.package.codeHash } };
  } });
  assert.equal(result.status, "completed"); assert.equal(result.delivery, "ready"); assert.equal(activations.length, 2);
  const developers = sessions.filter((item) => item.role === "developer");
  assert.equal(developers.length, 3); assert.equal(new Set(developers.map((item) => item.session)).size, 3);
  const repair = developers[2].payload;
  assert.equal(repair.task.integration, true); assert.equal(repair.feedback.report.mode, "runtime");
  assert.deepEqual(repair.feedback.report.results, smoke.results);
  assert.equal(repair.feedback.report.codeHash, activations[0].package.codeHash);
  assert.equal(repair.remaining.corrections, 5); assert.equal(repair.remaining.integrationRepairs, 1);
  assert.equal(result.budgets.corrections, 5); assert.equal(result.budgets.integrationRepairs, 1);
  assert.equal(result.reports.filter((report) => report.mode === "runtime").length, 1);
  assert.equal(executor.calls.verify.length, 5);
  assert.deepEqual(executor.calls.verify.slice(-2).map((call) => call.cases.map((item) => item.id)),
    [result.plan.cases.map((item) => item.id), result.plan.cases.map((item) => item.id)]);
  assert.equal(result.reports.at(-1).mode, "integration"); assert.equal(result.reports.at(-1).status, "passed");
  assert.equal(result.package.verificationId, result.reports.at(-1).id);
  assert.notEqual(activations[0].package.codeHash, result.package.codeHash);
  assert.equal(result.runtimeCheck.codeHash, result.package.codeHash);
});

test("主动续接更换会话并保留当前任务和累计回合，不提前验收", async (t) => {
  let continued = false;
  const { controller, sessions, architecture, executor } = await fixture(t, {
    onPrompt: async ({ record, payload, submit, write, respond }) => {
      if (record.role === "developer" && !continued) {
        continued = true; await write();
        return submit(developmentWork(payload.task, { continue: true, nextAction: "继续完成当前任务的输入检查" }));
      }
      await respond();
    },
  });
  const result = await controller.run(architecture);
  assert.equal(result.status, "completed");
  const developers = sessions.filter((item) => item.role === "developer");
  assert.equal(developers.length, 3);
  assert.equal(developers[0].payload.task.id, developers[1].payload.task.id);
  assert.notEqual(developers[0].session, developers[1].session);
  assert.equal(developers[1].payload.handoffs[0].continue, true);
  assert.equal(developers[1].payload.task.turns, 2);
  assert.equal(result.tasks[0].turns, 2); assert.equal(result.budgets.corrections, 6);
  assert.equal(executor.calls.verify.length, 3);
});

test("上下文接近上限时修复使用新会话，失败证据和预算保持连续", async (t) => {
  const { controller, sessions, architecture } = await fixture(t, {
    onVerify: (_options, report, number) => number === 1 ? failReport(report, "context-repair") : report,
    onPrompt: async ({ record, respond }) => {
      if (record.role === "developer") record.usagePercent = 70;
      await respond();
    },
  });
  const result = await controller.run(architecture);
  assert.equal(result.status, "completed");
  const developers = sessions.filter((item) => item.role === "developer");
  assert.equal(developers.length, 3); assert.notEqual(developers[0].session, developers[1].session);
  assert.equal(developers[1].payload.task.id, "core");
  assert.equal(developers[1].payload.task.turns, 2); assert.equal(developers[1].payload.remaining.corrections, 5);
  assert.deepEqual(developers[1].payload.feedback.report, result.reports[0]);
  assert.equal(developers[0].disposed, true);
});

test("当前任务回合达到上限后续接不能刷新预算", async (t) => {
  const { controller, architecture, sessions, executor } = await fixture(t, {
    limits: { developerTurns: 2 },
    onPrompt: async ({ record, payload, submit, respond, write }) => {
      if (record.role !== "developer") return respond();
      await write(); return submit(developmentWork(payload.task, { continue: true, nextAction: "继续同一任务" }));
    },
  });
  const result = await controller.run(architecture);
  assert.equal(result.status, "failed"); assert.match(result.summary, /回合预算/);
  assert.equal(result.tasks[0].turns, 2); assert.equal(result.package, null); assert.equal(executor.calls.verify.length, 0);
  assert.equal(sessions.filter((item) => item.role === "developer").flatMap((item) => item.prompts).length, 2);
});

test("一次模型调用内部多回合超限后，即使已经提交也不能推进", async (t) => {
  const { controller, architecture, sessions, executor } = await fixture(t, {
    limits: { developerTurns: 2 },
    onPrompt: async ({ record, respond, emit }) => {
      await respond();
      if (record.role === "developer") for (let index = 0; index < 3; index++) emit({ type: "turn_end" });
    },
  });
  const result = await controller.run(architecture);
  assert.equal(result.status, "failed"); assert.equal(result.package, null); assert.equal(executor.calls.verify.length, 0);
  assert.ok(result.tasks[0].turns > 2); assert.equal(sessions.find((item) => item.role === "developer").aborted, true);
});

test("取消中迟到提交和文件写入被拒绝，状态不会变成完成", { timeout: 10_000 }, async (t) => {
  const entered = deferred(), release = deferred(); let rejected = 0;
  const { controller, sessions, architecture } = await fixture(t, {
    onPrompt: async ({ record, payload, submit, respond }) => {
      if (record.role !== "developer") return respond();
      record.release = release.resolve; entered.resolve(); await release.promise;
      await assert.rejects(submit(developmentWork(payload.task)), { name: "AbortError" }); rejected++;
      await assert.rejects(record.tools.write_code_file.execute("late", { path: "main.mjs", content: "late" }), { name: "AbortError" }); rejected++;
    },
  });
  const pending = controller.run(architecture); await entered.promise;
  assert.equal(controller.has(architecture.agentId), true);
  const cancellation = controller.cancel(architecture.agentId);
  const [result, cancelled] = await Promise.all([pending, cancellation]);
  assert.equal(rejected, 2); assert.equal(result.status, "cancelled"); assert.equal(result.delivery, "blocked");
  assert.equal(result.package, null); assert.equal(cancelled.cancelled, true);
  assert.equal((await controller.store.get(architecture.agentId)).status, "cancelled");
  assert.equal(controller.has(architecture.agentId), false); assert.ok(sessions.every((item) => item.disposed));
});

test("最终完成记录写入过程中取消，迟到的完成写入不能覆盖取消", { timeout: 10_000 }, async (t) => {
  const entered = deferred(), release = deferred();
  const { controller, architecture } = await fixture(t);
  const save = controller.store.save.bind(controller.store);
  controller.store.save = async (record, options) => {
    if (record.status === "completed") { entered.resolve(); await release.promise; }
    return save(record, options);
  };
  const pending = controller.run(architecture); await entered.promise;
  const cancelled = controller.cancel(architecture.agentId); release.resolve();
  const [result, cancellation] = await Promise.all([pending, cancelled]);
  assert.equal(result.status, "cancelled"); assert.equal(result.delivery, "blocked");
  assert.equal(cancellation.development.status, "cancelled");
  assert.equal((await controller.store.get(architecture.agentId)).status, "cancelled");
});

test("任务修复扣预算与修复调度必须在同一个持久检查点完成", async (t) => {
  const { controller, architecture } = await fixture(t, { onVerify: (_options, report, number) => number === 1 ? failReport(report) : report });
  const checkpoints = [], save = controller.store.save.bind(controller.store);
  controller.store.save = async (record, options) => {
    const saved = await save(record, options); checkpoints.push(saved); return saved;
  };
  const result = await controller.run(architecture);
  assert.equal(result.status, "completed");
  const debited = checkpoints.find((record) => record.tasks[0]?.repairs === 1);
  assert.ok(debited);
  assert.equal(debited.tasks[0].nextAction, "implement", "预算已扣时必须已经记录修复，重启不能再次验收并重复扣款");
  assert.equal(debited.tasks[0].attempts, 2);
  assert.equal(debited.budgets.corrections, 5);
});

test("整体验收修复扣预算与创建修复任务必须在同一个持久检查点完成", async (t) => {
  const { controller, architecture } = await fixture(t, { onVerify: (_options, report, number) => number === 3 ? failReport(report) : report });
  const checkpoints = [], save = controller.store.save.bind(controller.store);
  controller.store.save = async (record, options) => {
    const saved = await save(record, options); checkpoints.push(saved); return saved;
  };
  const result = await controller.run(architecture);
  assert.equal(result.status, "completed");
  const debited = checkpoints.find((record) => record.budgets.integrationRepairs === 1);
  assert.ok(debited.tasks.some((task) => task.integration && task.status === "pending"), "重启时必须能找到已经扣费的修复任务");
  assert.equal(debited.budgets.corrections, 5);
});

test("重启恢复已经扣减的修复预算和任务回合，不重做规划或复用旧会话", async (t) => {
  const { controller, sessions, architecture, config, dataDir, controllers } = await fixture(t, {
    onVerify: (_options, report, number) => number === 1 ? failReport(report) : report,
    onPrompt: async ({ record, respond }) => {
      if (record.role === "developer" && record.prompts.length === 2) return;
      await respond();
    },
  });
  const stopped = await controller.run(architecture);
  assert.equal(stopped.status, "failed"); assert.equal(stopped.budgets.corrections, 5);
  assert.equal(stopped.tasks[0].repairs, 1); assert.equal(stopped.tasks[0].turns, 2);
  // Simulate process loss from the last published retry checkpoint.
  await controller.store.save({ ...stopped, status: "running" });
  const store = new DevelopmentStore({ dataDir }); await store.ready;
  assert.equal((await store.get(architecture.agentId)).status, "interrupted");
  const resumedSessions = [];
  const restarted = new DevelopmentController({ ...config, store, executor: fakeExecutor(), sessionFactory: modelFactory(resumedSessions) });
  controllers.push(restarted);
  const result = await restarted.run(architecture, { resume: true });
  assert.equal(result.status, "completed"); assert.equal(result.id, stopped.id);
  assert.equal(result.budgets.corrections, 5); assert.equal(result.tasks[0].repairs, 1); assert.equal(result.tasks[0].turns, 3);
  assert.equal(resumedSessions.some((item) => item.role === "planner"), false);
  assert.equal(resumedSessions[0].role, "developer"); assert.equal(resumedSessions[0].payload.remaining.corrections, 5);
  assert.equal(resumedSessions[0].payload.task.id, "core");
  assert.notEqual(resumedSessions[0].session, sessions.find((item) => item.role === "developer").session);
});

test("缺少已验证隔离环境时阻塞且不调用任何模型", async (t) => {
  const { controller, sessions, architecture } = await fixture(t, { onProbe: () => ({ available: false, kind: "test-fake", reason: "模拟隔离环境不可用" }) });
  const result = await controller.run(architecture);
  assert.equal(result.status, "blocked"); assert.equal(result.delivery, "blocked"); assert.equal(result.package, null);
  assert.match(result.summary, /隔离环境不可用/); assert.equal(sessions.length, 0);
  assert.deepEqual(result.budgets, { corrections: 6, planRevisions: 1, integrationRepairs: 2 });
});

test("普通模型回复不能代替规划、开发或评审的结构化提交", async (t) => {
  for (const omittedRole of ["planner", "developer", "reviewer"]) {
    const { controller, architecture } = await fixture(t, { onPrompt: async ({ record, respond }) => {
      if (record.role !== omittedRole) await respond();
    } });
    const result = await controller.run(architecture);
    assert.equal(result.status, "failed", omittedRole); assert.match(result.summary, /结构化结果/);
    assert.equal(result.package, null); assert.equal(result.delivery, "blocked");
  }
});

test("上游架构变化阻塞旧研发，不能交付旧版本", async (t) => {
  let current = developmentArchitecture();
  const { controller, architecture } = await fixture(t, { getArchitecture: async () => current,
    onVerify: (_options, report) => { current = { ...current, version: 2 }; return report; } });
  const result = await controller.run(architecture);
  assert.equal(result.status, "blocked"); assert.match(result.summary, /架构版本/); assert.equal(result.delivery, "blocked");
  assert.equal(result.package, null);
});

test("运行激活期间架构改变也不能把旧研发结果标为可运行", async (t) => {
  let current = developmentArchitecture();
  const { controller, architecture } = await fixture(t, { getArchitecture: async () => current });
  const result = await controller.run(architecture, { activate: async () => {
    current = { ...current, version: 2 };
    return { delivery: "ready", summary: "模拟运行检查通过" };
  } });
  assert.equal(result.status, "blocked"); assert.equal(result.delivery, "blocked"); assert.match(result.summary, /架构版本/);
});

test("计划评审修订把拒绝版本和具体意见交回同一规划会话", async (t) => {
  let planReviews = 0;
  const { controller, architecture, sessions } = await fixture(t, {
    onPrompt: async ({ record, payload, submit, respond }) => {
      if (record.role === "reviewer" && payload.mode === "plan" && ++planReviews === 1) {
        return submit(developmentReview(payload.subjectHash, { verdict: "revise", summary: "补充缺失的范围说明", issues: [developmentIssue("plan", "plan_scope")] }));
      }
      if (record.role === "planner" && record.prompts.length === 2) {
        const plan = developmentPlan({ requirements: payload.requirements, design: payload.design });
        plan.tasks[1].description += "，明确拒绝未授权发送";
        return submit(plan);
      }
      await respond();
    },
  });
  const result = await controller.run(architecture);
  assert.equal(result.status, "completed");
  const planners = sessions.filter((item) => item.role === "planner");
  assert.equal(planners.length, 1); assert.equal(planners[0].prompts.length, 2);
  assert.equal(planners[0].prompts[1].issues.review.issues[0].id, "plan_scope");
  assert.deepEqual(planners[0].prompts[1].issues.rejectedPlan, result.planAttempts[0].plan);
  assert.equal(result.budgets.planRevisions, 0); assert.equal(result.budgets.corrections, 5);
  assert.notEqual(result.planAttempts[0].planHash, result.planAttempts[1].planHash);
});

test("测试证据绑定错误代码版本直接失败，不能进入评审或打包", async (t) => {
  const { controller, architecture, sessions } = await fixture(t, { onVerify: (_options, report) => ({ ...report, codeHash: "0".repeat(64) }) });
  const result = await controller.run(architecture);
  assert.equal(result.status, "failed"); assert.match(result.summary, /代码版本不一致/); assert.equal(result.package, null);
  assert.equal(sessions.filter((item) => item.role === "reviewer").length, 1, "只发生计划评审");
});

test("测试未执行或执行异常不能被模型评审放行", async (t) => {
  for (const status of ["not_run", "error"]) {
    const { controller, architecture, sessions } = await fixture(t, { onVerify: (_options, report) => ({ ...report, status, summary: `模拟 ${status}` }) });
    const result = await controller.run(architecture);
    assert.equal(result.status, "blocked"); assert.equal(result.package, null);
    assert.equal(result.reports[0].status, status);
    assert.equal(sessions.filter((item) => item.role === "reviewer").length, 1);
  }
});

test("修复预算耗尽保留失败证据，不能自动判定完成或重置预算", async (t) => {
  const { controller, architecture, sessions } = await fixture(t, { limits: { corrections: 1 }, onVerify: (_options, report) => failReport(report) });
  const result = await controller.run(architecture);
  assert.equal(result.status, "failed"); assert.match(result.summary, /预算/); assert.equal(result.package, null);
  assert.equal(result.budgets.corrections, 0); assert.equal(result.tasks[0].repairs, 1);
  assert.equal(result.reports.length, 2); assert.ok(result.reports.every((report) => report.status === "failed"));
  assert.equal(sessions.filter((item) => item.role === "developer").length, 1);
  assert.equal(sessions.find((item) => item.role === "developer").prompts.length, 2);
  const resumed = await controller.run(architecture, { resume: true });
  assert.equal(resumed.status, "failed"); assert.equal(resumed.budgets.corrections, 0);
  assert.equal(resumed.tasks[0].repairs, 1);
});

test("只有已经绑定独立评审的 workflow/custom 架构可以进入研发", async (t) => {
  const { controller, architecture, sessions } = await fixture(t);
  for (const invalid of [
    { ...architecture, status: "needs_changes" },
    { ...architecture, candidateHash: "0".repeat(64) },
    { ...architecture, contractVersion: 999 },
    { ...architecture, review: { ...architecture.review, verdict: "revise" } },
    { ...architecture, issues: [developmentIssue("architecture")] },
  ]) await assert.rejects(controller.run(invalid), InputError);
  assert.equal(sessions.length, 0); assert.equal(await controller.get(architecture.agentId), null);
});
