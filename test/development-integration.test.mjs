import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ARCHITECTURE_VERSION, designHash } from "../src/architecture/architecture-contract.mjs";
import { DevelopmentController } from "../src/development/development.mjs";
import { createPiSession } from "../src/runtime/pi-runtime.mjs";
import { DevelopmentExecutor } from "../src/development/development-executor.mjs";
import { DEVELOPMENT_REJECTION_EXAMPLE } from "../src/development/development-prompts.mjs";
import { VALUE_SCHEMA_DESCRIPTION } from "../src/applications/application-contract.mjs";
import { validDesign, passingReview } from "./helpers/architecture.mjs";

const SOURCE = 'const input = process.argv[2] ?? "";\nconsole.log(JSON.stringify(input ? { input } : { error: "missing_input" }));\n';
const requirements = [{ id: "echo_input", text: "原样返回输入文字" }, { id: "missing_input", text: "空输入返回明确错误码" }];
const design = validDesign(requirements, { profile: "workflow", rationale: "以独立Node入口验证研发工具交接。",
  instructions: "将输入交给独立入口，返回实际处理结果。", acceptance: [
    { id: "echo", kind: "success", requirementIds: ["echo_input"], input: "研发协议验证", expected: "原样返回输入文字" },
    { id: "empty", kind: "missing_input", requirementIds: ["missing_input"], input: "", expected: "返回missing_input错误码" },
  ] });
const candidateHash = designHash(design);
const architecture = { agentId: "sdk-development", name: "研发协议验证助手", version: 1, contractVersion: ARCHITECTURE_VERSION,
  status: "passed", delivery: "needs_development", requirements, design, candidateHash, review: passingReview(candidateHash), issues: [] };
const plan = { summary: "实现文字回显与空输入检查", runtime: "node-json", entrypoint: "main.mjs",
  tasks: [{ id: "echo", title: "实现输入检查与回显", description: "保存Node入口并明确处理空输入", requirementIds: ["echo_input", "missing_input"],
    acceptanceIds: ["echo", "empty"], dependsOn: [], files: ["main.mjs"] }],
  cases: [{ id: "echo_text", taskId: "echo", acceptanceId: "echo", input: "研发协议验证",
    assertions: [{ path: "input", expectedJson: '"研发协议验证"' }] },
  { id: "empty_text", taskId: "echo", acceptanceId: "empty", input: "", assertions: [{ path: "error", expectedJson: '"missing_input"' }] }] };
const textOf = (content) => typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("");
const legacyScenario = { architecture, plan };

async function unseal(path) {
  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await unseal(join(path, entry.name));
}

async function sdkFixture(t, { invalidPlan = false, sdkInvalidPlan = false, repairSubmission = false, missingActionMocks = false, rejectionPair = false, structuredPlan = false, structuredValueString = false, structuredValuePrimitive = false, structuredRejectedValues = [], dedicatedCases = false, dedicatedStringCases = false, dedicatedCoercedCases = false, actionRootString = false, readPlanSchema = false, indexPath = "index.json", limits } = {}) {
  const architecture = structuredClone(legacyScenario.architecture), plan = structuredClone(legacyScenario.plan);
  let source = SOURCE;
  if (missingActionMocks || rejectionPair || structuredPlan || structuredValueString || structuredValuePrimitive || structuredRejectedValues.length || dedicatedCases || actionRootString) {
    architecture.contractVersion = 2; architecture.design.schemaVersion = 2;
    architecture.candidateHash = designHash(architecture.design); architecture.review = passingReview(architecture.candidateHash);
    const inputSchema = { type: "string" }, outputSchema = { type: "object", properties: { input: { type: "string" }, error: { type: "string" } }, required: [], additionalProperties: false };
    Object.assign(plan, { schemaVersion: 2, runtime: "node-action", application: { protocolVersion: 2, runtime: "node-action", entrypoint: "main.mjs", page: null,
      actions: [{ id: "echo", title: "回显", inputSchema, outputSchema, connectionIds: [] }], stateVersion: 1, evidenceIds: [] } });
    plan.cases = plan.cases.map((item) => ({ ...item, actionId: "echo", mocks: [], input: JSON.stringify(item.input) }));
    if (dedicatedCases) for (const item of plan.cases) {
      item.input = { fixture: { op: "value", value: JSON.parse(item.input) } };
      for (const assertion of item.assertions) assertion.expectedJson = { fixture: { op: "value", value: JSON.parse(assertion.expectedJson) } };
    }
    source = "export const actions={async echo(input){return input?{input}:{error:'missing_input'}}};\n";
    if (actionRootString) {
      plan.application.actions[0].inputSchema = { type: "object", properties: { payload: { type: "string" } }, required: ["payload"], additionalProperties: false };
      for (const item of plan.cases) item.input = { fixture: { op: "value", value: { payload: JSON.parse(item.input) } } };
      source = "export const actions={async echo({payload:input}){return input?{input}:{error:'missing_input'}}};\n";
    }
    if (rejectionPair) {
      architecture.design.acceptance = DEVELOPMENT_REJECTION_EXAMPLE.cases.map((item, index) => ({ id: item.acceptanceId,
        kind: ["success", "missing_input", "boundary"][index], requirementIds: [architecture.requirements[index ? 1 : 0].id], input: item.input, expected: "核对实际输出值" }));
      const action = plan.application.actions[0]; action.id = "process"; action.inputSchema = structuredClone(DEVELOPMENT_REJECTION_EXAMPLE.inputSchema);
      action.outputSchema = { type: "object", properties: { total: { type: "integer" }, error: { type: "object", properties: { code: { type: "string" }, index: { type: "integer" } }, required: ["code", "index"], additionalProperties: false } }, required: [], additionalProperties: false };
      plan.tasks[0].id = "validate"; plan.tasks[0].acceptanceIds = architecture.design.acceptance.map((item) => item.id);
      plan.cases = structuredClone(DEVELOPMENT_REJECTION_EXAMPLE.cases);
      source = "export const actions={async process({items}){const seen=new Set();for(let i=0;i<items.length;i++){if(seen.has(items[i]))return {error:{code:'duplicate_item',index:i}};seen.add(items[i])}return {total:items.reduce((a,b)=>a+b,0)}}};\n";
      architecture.candidateHash = designHash(architecture.design); architecture.review = passingReview(architecture.candidateHash);
    }
  }
  const root = await mkdtemp(join(tmpdir(), "neuma-development-sdk-"));
  const requests = [], sessions = [], toolCalls = [], errors = [], checks = [], progress = [], rejectedWriteChecks = [];
  const planSchemaPages = [];
  let readSchema;
  let controller;
  const model = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer fixture-only");
      assert.equal(body.messages[0].role, "system");
      const names = body.tools.map((tool) => tool.function.name).sort();
      const role = names.includes("submit_development_plan") ? "planner" : names.includes("submit_development_work") ? "developer" : "reviewer";
      const payload = JSON.parse(textOf(body.messages.find((message) => message.role === "user").content));
      const called = body.messages.filter((message) => message.role === "assistant")
        .flatMap((message) => message.tool_calls ?? []).map((call) => call.function.name);
      const key = role === "reviewer" ? `reviewer-${payload.mode}` : role;
      requests.push({ key, names, body, payload });
      const filesPlan = plan.schemaVersion >= 2;
      const expected = role === "planner" ? filesPlan ? ["read", "write", "edit", "save_plan_cases", "edit_plan_cases", "save_plan_json", "update_plan_json", "list_plan_files", "read_plan_diagnostics", "read_plan_file", "submit_development_blocker", "submit_development_plan"] : ["list_code_files", "read_code_file", "submit_development_blocker", "submit_development_plan"]
        : role === "developer" ? ["list_code_files", "read_code_file", "run_development_checks", "submit_development_work", ...(filesPlan ? ["read", "write", "edit"] : ["write_code_file"])]
          : payload.mode === "plan" ? ["submit_development_review"] : ["list_code_files", "read_code_file", "submit_development_review"];
      assert.deepEqual(names, [...expected, "read_development_context", ...(role === "reviewer" ? [] : ["web_search", "web_fetch"])].sort());
      if (!called.length) {
        assert.equal(body.messages.some((message) => ["assistant", "tool"].includes(message.role)), false);
        assert.doesNotMatch(JSON.stringify(body.messages), /PRIVATE_SESSION_FINISH/);
      }
      let name, args;
      if (role === "planner" && readPlanSchema) {
        for (const message of body.messages.filter((item) => item.role === "tool")) {
          let page;
          try { page = JSON.parse(textOf(message.content)); } catch { continue; }
          if (page.section !== "planSchema" || typeof page.text !== "string") continue;
          const existing = planSchemaPages.find((item) => item.offset === page.offset);
          if (existing) assert.deepEqual(page, existing);
          else {
            assert.equal(page.offset, planSchemaPages.at(-1)?.nextOffset ?? 0);
            planSchemaPages.push(page);
          }
        }
        const last = planSchemaPages.at(-1);
        if (!last || last.truncated) {
          name = "read_development_context"; args = { section: "planSchema", offset: last?.nextOffset ?? 0, limit: 8000 };
        } else readSchema = JSON.parse(planSchemaPages.map((page) => page.text).join(""));
      }
      if (!name && role === "planner" && filesPlan) {
        const repairCase = missingActionMocks || actionRootString;
        const writer = structuredPlan ? "save_plan_json" : "write";
        const allWrites = body.messages.filter((message) => message.role === "assistant").flatMap((message) => message.tool_calls ?? [])
          .filter((call) => call.function.name === writer || call.function.name === "save_plan_cases").map((call) => JSON.parse(call.function.arguments));
        const writes = structuredPlan ? allWrites.filter((item) => {
          if (Object.hasOwn(item, "cases")) return Array.isArray(item.cases);
          try { const value = typeof item.value === "string" ? JSON.parse(item.value) : item.value; return value && typeof value === "object"; }
          catch { return false; }
        }) : allWrites;
        if (dedicatedStringCases && allWrites.some((item) => item.path === "cases.json" && typeof item.cases === "string")
          && !writes.some((item) => item.path === "cases.json")) {
          const ctx = controller.active.get(architecture.agentId);
          const directory = await controller.artifacts.directory(architecture.agentId, ctx.record.id, { create: false });
          await assert.rejects(readFile(join(directory, "cases.json")), { code: "ENOENT" });
          rejectedWriteChecks.push("cases-json-string");
        }
        if (structuredRejectedValues.length && allWrites.length > 0 && allWrites.length <= structuredRejectedValues.length && !writes.length) {
          const ctx = controller.active.get(architecture.agentId);
          const directory = await controller.artifacts.directory(architecture.agentId, ctx.record.id, { create: false });
          await assert.rejects(readFile(join(directory, indexPath)), { code: "ENOENT" });
          rejectedWriteChecks.push(allWrites.length);
        }
        const { cases, ...index } = plan;
        const caseCalls = allWrites.filter((item) => item.path === "cases.json");
        if (dedicatedCoercedCases && caseCalls.length === 2) {
          const ctx = controller.active.get(architecture.agentId);
          const directory = await controller.artifacts.directory(architecture.agentId, ctx.record.id, { create: false });
          assert.deepEqual(JSON.parse(await readFile(join(directory, "cases.json"), "utf8")), cases);
          rejectedWriteChecks.push("nested-coercion");
        }
        const rejectedValues = structuredRejectedValues.length ? structuredRejectedValues : structuredValuePrimitive ? [7] : [];
        if (allWrites.length < rejectedValues.length) {
          name = "save_plan_json"; args = { path: indexPath, value: rejectedValues[allWrites.length] };
        } else if (!writes.some((item) => item.path === indexPath)) {
          name = writer; const value = { ...index, caseFiles: ["cases.json"] };
          args = { path: indexPath, ...(structuredPlan ? { value: structuredValueString ? JSON.stringify(value) : value } : { content: JSON.stringify(value) }) };
        } else if (structuredPlan && repairCase && called.includes("submit_development_plan") && !called.includes("update_plan_json")) {
          name = "update_plan_json"; args = { path: "cases.json", updates: [{ pointer: "/0", value: cases[0] }] };
        } else if (!writes.some((item) => item.path === "cases.json") || (!structuredPlan && missingActionMocks && called.includes("submit_development_plan") && writes.filter((item) => item.path === "cases.json").length < 2)) {
          name = dedicatedCases ? "save_plan_cases" : writer;
          const batch = structuredClone(cases);
          if (missingActionMocks && !called.includes("submit_development_plan")) delete batch[0].mocks;
          if (actionRootString && !called.includes("submit_development_plan")) batch[0].input = { fixture: { op: "value", value: "PRIVATE_BUSINESS_JSON" } };
          args = { path: "cases.json", ...(dedicatedCases
            ? { cases: dedicatedStringCases && !allWrites.some((item) => item.path === "cases.json") ? JSON.stringify(batch) : batch }
            : structuredPlan ? { value: structuredValueString ? JSON.stringify(batch) : batch } : { content: JSON.stringify(batch) }) };
        } else if (dedicatedCoercedCases && caseCalls.length < 3) {
          name = "save_plan_cases"; const batch = structuredClone(cases);
          if (caseCalls.length === 1) { batch[0].input = 7; batch[0].assertions[0].expectedJson = 7; }
          args = { path: "cases.json", cases: batch };
        } else if (!called.includes("submit_development_plan") || repairCase) { name = "submit_development_plan"; args = { indexPath }; }
      } else if (!name && role === "planner" && (!called.includes("submit_development_plan") || sdkInvalidPlan || missingActionMocks)) {
        name = "submit_development_plan";
        args = sdkInvalidPlan && (!repairSubmission || !called.includes("submit_development_plan"))
          ? { ...plan, summary: "PRIVATE_SUBMISSION_VALUE_".repeat(240) }
          : invalidPlan ? { ...plan, entrypoint: "outside.mjs" } : plan;
        if (missingActionMocks && !called.includes("submit_development_plan")) { args = structuredClone(plan); delete args.cases[0].mocks; }
      } else if (role === "developer") {
        const writer = filesPlan ? "write" : "write_code_file";
        if (!called.includes(writer)) { name = writer; args = { path: "main.mjs", content: source }; }
        else if (!called.includes("run_development_checks")) { name = "run_development_checks"; args = {}; }
        else if (!called.includes("submit_development_work")) {
          name = "submit_development_work"; args = { summary: "已保存入口代码并完成协议自测", changedFiles: ["main.mjs"],
            knownIssues: [], nextAction: "交给独立验收", continue: false };
        }
      } else if (role === "reviewer") {
        if (payload.mode !== "plan" && !called.includes("read_code_file")) { name = "read_code_file"; args = { path: "main.mjs" }; }
        else if (!called.includes("submit_development_review")) {
          name = "submit_development_review"; args = { subjectHash: payload.subjectHash, verdict: "pass", issues: [],
            summary: "本机协议测试：固定模拟评审通过，不代表真实业务质量验收。" };
        }
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: `fixture-${requests.length}`,
        object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (name) {
        toolCalls.push({ key, name, args });
        chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function",
          function: { name, arguments: JSON.stringify(args) } }] }); chunk({}, "tool_calls");
      } else { chunk({ role: "assistant", content: `${key}_PRIVATE_SESSION_FINISH` }); chunk({}, "stop"); }
      response.end("data: [DONE]\n\n");
    } catch (error) {
      errors.push(error);
      if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "本机模拟模型协议断言失败" } }));
    }
  });
  t.after(async () => {
    await controller?.close();
    model.closeAllConnections();
    if (model.listening) await new Promise((done) => model.close(done));
    await unseal(root); await rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { model.once("error", reject); model.listen(0, "127.0.0.1", resolve); });
  const config = { llmConfigured: true, model: "fixture-model", apiKey: "fixture-only",
    chatUrl: `http://127.0.0.1:${model.address().port}/v1/chat/completions` };
  // This suite exercises the actual Pi protocol and file tools. OS execution has its own tests.
  const executor = rejectionPair || dedicatedCases ? new DevelopmentExecutor() : { probe: async () => ({ available: true, reason: "协议测试执行替身" }),
    verify: async ({ snapshot, entrypoint, cases, signal }) => {
      signal.throwIfAborted(); assert.equal(entrypoint, "main.mjs");
      assert.equal(await readFile(join(snapshot.path, entrypoint), "utf8"), source);
      checks.push({ snapshot, entrypoint, cases });
      return { status: "passed", codeHash: snapshot.hash, summary: "协议测试执行替身；未执行生成代码。", fixture: true,
        results: cases.map((item) => ({ caseId: item.id, status: "passed", fixture: true })) };
    } };
  controller = new DevelopmentController({ config, cwd: root, dataDir: join(root, "data"), executor,
    ...(limits ? { limits } : {}),
    getArchitecture: async () => structuredClone(architecture), sessionFactory: async (options) => {
      const session = await createPiSession(options);
      assert.equal(session.messages.length, 0);
      const record = { session, tools: options.customTools.map((tool) => tool.name), disposed: false, messages: null };
      const dispose = session.dispose.bind(session);
      session.dispose = () => { record.messages = structuredClone(session.messages); record.disposed = true; dispose(); };
      sessions.push(record); return session;
    } });
  return { root, controller, requests, sessions, toolCalls, errors, checks, progress, rejectedWriteChecks, planSchemaPages, get readSchema() { return readSchema; },
    run: () => controller.run(structuredClone(architecture), { onProgress: (event) => progress.push(event) }) };
}

test("真实Pi研发链执行规划、独立评审、文件写入与结构化交接，角色不继承聊天", { timeout: 20_000 }, async (t) => {
  const fixture = await sdkFixture(t);
  const result = await fixture.run();
  assert.deepEqual(fixture.errors, []);
  assert.equal(result.status, "completed", result.summary);
  assert.equal(result.delivery, "needs_development", "未配置运行层激活，不能声称已经可运行");
  assert.equal(result.tasks[0].status, "verified"); assert.equal(result.handoffs.length, 1);
  assert.equal(await readFile(join(result.package.snapshot.path, "main.mjs"), "utf8"), SOURCE);
  assert.equal(result.package.codeHash, result.handoffs[0].codeHash);
  assert.equal(result.package.planHash, result.planHash);
  assert.deepEqual(fixture.toolCalls.map(({ name }) => name), ["submit_development_plan", "submit_development_review",
    "write_code_file", "run_development_checks", "submit_development_work", "read_code_file", "submit_development_review",
    "read_code_file", "submit_development_review"]);
  assert.deepEqual(result.reviews.map(({ mode }) => mode), ["plan", "task", "integration"]);
  assert.equal(fixture.sessions.length, 5); assert.equal(new Set(fixture.sessions.map(({ session }) => session)).size, 5);
  assert.ok(fixture.sessions.every(({ disposed }) => disposed));
  assert.deepEqual(fixture.sessions.map(({ tools }) => tools.find((name) => ["submit_development_plan", "submit_development_review", "submit_development_work"].includes(name))),
    ["submit_development_plan", "submit_development_review", "submit_development_work", "submit_development_review", "submit_development_review"]);
  for (const session of fixture.sessions) {
    const markers = JSON.stringify(session.messages).match(/[a-z-]+_PRIVATE_SESSION_FINISH/g) ?? [];
    assert.equal(markers.length, 0, "有效提交后不再请求额外的模型对话收尾");
    assert.equal(session.messages.filter((message) => message.role === "user").length, 1, "每个角色从自己的独立输入开始");
  }
  const firstRequests = fixture.requests.filter(({ body }) => body.messages.every((message) => ["system", "user"].includes(message.role)));
  assert.deepEqual(firstRequests.find(({ key }) => key === "planner").payload.modelBudget, { limit: 12, used: 0, remaining: 12 });
  const developerContinuation = fixture.requests.find(({ key, body }) => key === "developer" && body.messages.some((message) => message.role === "tool"));
  const writeFeedback = developerContinuation.body.messages.find((message) => message.role === "tool");
  assert.match(textOf(writeFeedback.content), /"hostModelBudget":\{"limit":40,"used":1,"remaining":39/);
  assert.deepEqual(firstRequests.map(({ key }) => key), ["planner", "reviewer-plan", "developer", "reviewer-task", "reviewer-integration"]);
  const taskReview = firstRequests.find(({ key }) => key === "reviewer-task");
  assert.equal(taskReview.payload.report.fixture, true);
  assert.equal(taskReview.payload.codeHash, result.package.codeHash);
  assert.ok(fixture.requests.filter(({ key }) => key === "reviewer-task").some(({ body }) =>
    body.messages.some((message) => message.role === "tool" && textOf(message.content).includes("process.argv[2]"))));
  assert.equal(fixture.checks.length, 3, "开发自测、任务验收和整体验收分别取固定快照");
  assert.deepEqual([...new Set(fixture.progress.map(({ phase }) => phase))], ["intake", "planning", "implementing", "verifying", "packaging"]);
  assert.equal((await fixture.controller.get(architecture.agentId)).status, "completed");
  assert.equal(fixture.controller.has(architecture.agentId), false);
});

test("真实Pi结构化计划被程序拒绝时不能继续开发或用自然语言冒充提交", { timeout: 20_000 }, async (t) => {
  const fixture = await sdkFixture(t, { invalidPlan: true });
  const result = await fixture.run();
  assert.deepEqual(fixture.errors, []);
  assert.equal(result.status, "failed"); assert.equal(result.delivery, "blocked");
  assert.equal(result.plan, null); assert.equal(result.package, null);
  assert.equal(fixture.checks.length, 0); assert.equal(fixture.sessions.length, 1);
  assert.deepEqual(fixture.toolCalls.map(({ name }) => name), ["submit_development_plan"]);
  const rejection = fixture.requests.at(-1).body.messages.findLast((message) => message.role === "tool");
  assert.match(textOf(rejection.content), /plan\.entrypoint \[invalid_entrypoint\]/);
  assert.match(textOf(rejection.content), /所选语言.*任务 files/);
  assert.doesNotMatch(textOf(rejection.content), /outside\.mjs|Received arguments/);
  assert.equal(fixture.sessions[0].disposed, true);
  assert.deepEqual(result.submissionCounts.planner, { attempts: 1, accepted: 0, rejected: 1 });
  assert.equal(result.submissionAttempts[0].stage, "contract");
  assert.equal(result.diagnostic.submission.issues[0].reason, "invalid_entrypoint");
});

test("真实SDK在执行前拒绝的计划也保存安全诊断，修复后继续独立验收", { timeout: 20_000 }, async (t) => {
  const fixture = await sdkFixture(t, { sdkInvalidPlan: true, repairSubmission: true });
  const result = await fixture.run();
  assert.deepEqual(fixture.errors, []);
  assert.equal(result.status, "completed", result.summary);
  assert.deepEqual(result.submissionCounts.planner, { attempts: 2, accepted: 1, rejected: 1 });
  const rejected = result.submissionAttempts[0];
  assert.equal(rejected.stage, "sdk");
  assert.deepEqual(rejected.issues.map(({ path, reason }) => ({ path, reason })), [{ path: "plan.summary", reason: "maxLength" }]);
  assert.ok(fixture.requests[1].body.messages.some((message) => message.role === "tool"
    && textOf(message.content).includes("maxLength")), "真实 SDK 在 execute 前拒绝并返回安全诊断");
  assert.doesNotMatch(JSON.stringify(fixture.requests[1].body.messages.filter((message) => message.role === "tool")), /PRIVATE_SUBMISSION_VALUE|Received arguments/);
  assert.deepEqual(result.reviews.map(({ mode }) => mode), ["plan", "task", "integration"]);
  const stored = await readFile(join(fixture.root, "data", "agents", architecture.agentId, "development", "records", `${result.id}.json`), "utf8");
  assert.doesNotMatch(stored, /PRIVATE_SUBMISSION_VALUE|Received arguments/);
  assert.doesNotMatch(JSON.stringify(fixture.progress), /PRIVATE_SUBMISSION_VALUE|Received arguments/);
});

test("真实SDK连续拒绝耗尽原预算时保留字段原因，不把原始参数输出界面", { timeout: 20_000 }, async (t) => {
  const fixture = await sdkFixture(t, { sdkInvalidPlan: true, limits: { reviewerTurns: 2 } });
  const result = await fixture.run();
  assert.deepEqual(fixture.errors, []);
  assert.equal(result.status, "failed");
  assert.equal(result.plan, null); assert.equal(result.package, null);
  assert.equal(result.diagnostic.reason, "turn_limit");
  assert.ok(result.diagnostic.submission.rejected >= 2);
  assert.equal(result.diagnostic.submission.issues[0].path, "plan.summary");
  assert.equal(result.diagnostic.submission.issues[0].reason, "maxLength");
  assert.equal(result.planAttempts.length, 0);
  assert.ok(result.submissionAttempts.length >= 2);
  const summary = await fixture.controller.get(architecture.agentId);
  assert.ok(JSON.stringify(summary.diagnostic).length < 650);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SUBMISSION_VALUE|Received arguments/);
});

test("结构化文件计划在动作缺少mocks时先拒绝，精确替换后沿原预算完成研发交接", { timeout: 20_000 }, async (t) => {
  const fixture = await sdkFixture(t, { missingActionMocks: true, structuredPlan: true, limits: { corrections: 3, planRevisions: 1 } });
  const result = await fixture.run();
  assert.deepEqual(fixture.errors, []); assert.equal(result.status, "completed", result.summary);
  assert.deepEqual(result.submissionCounts.planner, { attempts: 2, accepted: 1, rejected: 1 });
  assert.equal(result.submissionAttempts[0].stage, "contract");
  assert.ok(result.planDraftChecks.some((check) => check.status === "incomplete"));
  assert.ok(result.planDraftChecks.some((check) => check.status === "rejected" && check.issues.some((issue) => issue.path === "plan.cases[0].mocks")));
  assert.equal(result.planDraftChecks.at(-1).status, "valid");
  assert.equal(result.planDraftChecks.at(-1).total, 0);
  assert.equal(result.planDraftChecks.at(-1).truncated, false);
  assert.equal(result.planDraftChecks.at(-1).nextOffset, null);
  const earlyFeedback = fixture.requests.filter((item) => item.key === "planner")[2].body.messages.findLast((item) => item.role === "tool");
  assert.match(textOf(earlyFeedback.content), /planDraftCheck.*rejected.*mocks/);
  assert.match(textOf(earlyFeedback.content), /"fileState":\{"path":"cases\.json","fileHash":"[a-f0-9]{64}","hashScope":"file"/u);
  assert.ok(result.submissionAttempts[0].issues.some((item) => item.path === "plan.cases[0].mocks" && item.reason === "required"));
  const toolReply = fixture.requests.filter((item) => item.key === "planner")[3].body.messages.findLast((item) => item.role === "tool");
  assert.match(textOf(toolReply.content), /mocks/);
  assert.equal(result.planAttempts.length, 1, "被拒绝的文件候选未交给独立评审作为有效计划");
  assert.equal(result.plan.schemaVersion, 2); assert.deepEqual(result.plan.cases[0].mocks, []);
  assert.ok(fixture.toolCalls.some((item) => item.name === "save_plan_json"));
  assert.ok(fixture.toolCalls.some((item) => item.name === "update_plan_json"));
  assert.deepEqual(result.reviews.map((item) => item.mode), ["plan", "task", "integration"]);
  assert.equal(result.budgets.planRevisions, 1); assert.equal(result.budgets.corrections, 3);
});

test("真实Pi精确拒绝基本值工具参数及夹具根类型，原会话纠正为对象后继续正式验收", { timeout: 20_000 }, async (t) => {
  const fixture = await sdkFixture(t, { structuredPlan: true, structuredValuePrimitive: true, actionRootString: true });
  const result = await fixture.run();
  assert.deepEqual(fixture.errors, []); assert.equal(result.status, "completed", result.summary);
  const requests = fixture.requests.filter((item) => item.key === "planner");
  const feedback = requests[1].body.messages.filter((message) => message.role === "tool");
  assert.match(textOf(feedback.at(-1).content), /save_plan_json\.value/);
  assert.match(textOf(feedback.at(-1).content), /"receivedType":"number"/);
  assert.match(textOf(feedback.at(-1).content), /不接受数值.*严格解析一次/);
  assert.doesNotMatch(textOf(feedback.at(-1).content), /PRIVATE_JSON_VALUE|Received arguments/);
  assert.equal(fixture.toolCalls[0].name, "save_plan_json"); assert.equal(typeof fixture.toolCalls[0].args.value, "number");
  assert.equal(typeof fixture.toolCalls[1].args.value, "object", "原会话纠正非法基本值，宿主不改写该值");
  const draftFeedback = requests.flatMap((item) => item.body.messages.filter((message) => message.role === "tool")).map((message) => textOf(message.content))
    .find((text) => text.includes("action_input_invalid") && text.includes("完整动作入参对象"));
  assert.ok(draftFeedback); assert.match(draftFeedback, /"expectedType":"object".*"receivedType":"string"/);
  assert.doesNotMatch(draftFeedback, /PRIVATE_BUSINESS_JSON/);
  const planner = fixture.sessions[0];
  const history = (await readFile(planner.session.sessionFile, "utf8")).trim().split("\n").map(JSON.parse);
  const rejection = history.find((entry) => entry.message?.role === "toolResult" && entry.message.toolName === "save_plan_json" && entry.message.isError);
  assert.ok(rejection); assert.match(textOf(rejection.message.content), /save_plan_json\.value/);
  assert.doesNotMatch(textOf(rejection.message.content), /PRIVATE_JSON_VALUE|Received arguments/);
  assert.equal(result.planning.turns, 6); assert.equal(Object.values(result.sessions).find((entry) => entry.role === "planner").limit, 12);
  assert.deepEqual(result.submissionCounts.planner, { attempts: 2, accepted: 1, rejected: 1 });
  assert.deepEqual(result.reviews.map((item) => item.mode), ["plan", "task", "integration"]);
});

test("真实Pi拒绝基本值根且无文件写入，连续JSON文本保存后沿原预算正式验收", { timeout: 20_000 }, async (t) => {
  const rejectedValues = [7, null, true, "7", "null", "false", JSON.stringify("PRIVATE_JSON_VALUE"), JSON.stringify(JSON.stringify({ id: "PRIVATE_JSON_VALUE" }))];
  const fixture = await sdkFixture(t, { structuredPlan: true, structuredValueString: true, structuredRejectedValues: rejectedValues });
  const result = await fixture.run();
  assert.deepEqual(fixture.errors, []); assert.equal(result.status, "completed", result.summary);
  const saves = fixture.toolCalls.filter((entry) => entry.name === "save_plan_json");
  assert.equal(saves.length, rejectedValues.length + 2); assert.ok(saves.slice(-2).every((entry) => typeof entry.args.value === "string"));
  assert.deepEqual(fixture.rejectedWriteChecks, rejectedValues.map((_, index) => index + 1));
  const planner = fixture.sessions[0];
  const replies = planner.messages.filter((message) => message.role === "toolResult" && message.toolName === "save_plan_json");
  assert.equal(replies.length, rejectedValues.length + 2); assert.ok(replies.slice(0, -2).every((message) => message.isError));
  assert.doesNotMatch(replies.slice(0, -2).map((message) => textOf(message.content)).join("\n"), /PRIVATE_JSON_VALUE|Received arguments/);
  assert.ok(replies.slice(-2).every((message) => textOf(message.content).includes('"inputEncoding":"json-text"')));
  assert.equal(result.planning.turns, rejectedValues.length + 3); assert.equal(Object.values(result.sessions).find((entry) => entry.role === "planner").limit, 12);
  assert.deepEqual(result.submissionCounts.planner, { attempts: 1, accepted: 1, rejected: 0 });
  assert.deepEqual(result.reviews.map((item) => item.mode), ["plan", "task", "integration"]);
});

test("真实Pi保存自定义索引时对象与JSON文本均由宿主识别并完成同一写后预检", { timeout: 20_000 }, async (t) => {
  for (const structuredValueString of [false, true]) await t.test(structuredValueString ? "json-text" : "structured", async (t) => {
    const indexPath = "plans/custom.json";
    const fixture = await sdkFixture(t, { structuredPlan: true, structuredValueString, indexPath });
    const result = await fixture.run();
    assert.deepEqual(fixture.errors, []); assert.equal(result.status, "completed", result.summary);
    assert.equal(result.planningIndexPath, indexPath);
    assert.deepEqual(result.planDraftChecks.map((entry) => entry.status), ["incomplete", "valid"]);
    assert.equal(result.planningArtifact.indexPath, indexPath);
    assert.deepEqual(result.reviews.map((entry) => entry.mode), ["plan", "task", "integration"]);
    const reply = fixture.sessions[0].messages.find((message) => message.role === "toolResult" && message.toolName === "save_plan_json");
    const saved = JSON.parse(reply.content[0].text);
    assert.equal(saved.planningIndex, true); assert.equal(saved.path, indexPath);
    assert.equal(saved.inputEncoding, structuredValueString ? "json-text" : "structured");
  });
});

test("真实SDK与隔离动作区分平台结构拒绝和带位置的业务拒绝，所有角色读取同源规则", { timeout: 20_000 }, async (t) => {
  const availability = await new DevelopmentExecutor().probe();
  if (!availability.available) { if (process.env.NEUMA_REQUIRE_ISOLATION === "1") assert.fail(availability.reason); return t.skip(availability.reason); }
  const fixture = await sdkFixture(t, { rejectionPair: true, readPlanSchema: true }), result = await fixture.run();
  assert.deepEqual(fixture.errors, []); assert.equal(result.status, "completed", result.summary);
  assert.deepEqual(result.plan.cases, DEVELOPMENT_REJECTION_EXAMPLE.cases);
  const first = fixture.requests.filter(({ body }) => body.messages.every((item) => ["system", "user"].includes(item.role)));
  assert.deepEqual([...new Set(first.map((item) => item.key.split("-")[0]))].sort(), ["developer", "planner", "reviewer"]);
  for (const request of first) {
    assert.equal(request.payload.valueSchemaGuide, undefined);
    const guide = request.payload.contextSections.find(item => item.section === "valueSchemaGuide");
    assert.equal(guide.delivery, "paged"); assert.equal(guide.totalChars, JSON.stringify(VALUE_SCHEMA_DESCRIPTION).length);
  }
  const tool = first.find((item) => item.key === "planner").body.tools.find((item) => item.function.name === "submit_development_plan");
  assert.ok(tool.function.parameters.properties.indexPath);
  const fullSchema = fixture.readSchema;
  assert.equal(fixture.planSchemaPages.length, Math.ceil(fixture.planSchemaPages[0].totalChars / 8000));
  assert.equal(fixture.planSchemaPages.at(-1).nextOffset, null);
  assert.equal(fixture.toolCalls.filter((item) => item.name === "read_development_context" && item.args.section === "planSchema").length, fixture.planSchemaPages.length);
  assert.equal(fullSchema.properties.application.properties.actions.items.properties.inputSchema.description, VALUE_SCHEMA_DESCRIPTION);
  const report = result.reports.at(-1);
  assert.equal(report.status, "passed");
  assert.deepEqual(report.results.find((item) => item.caseId === "reject_business").actual, { error: { code: "duplicate_item", index: 1 } });
  const rejected = report.results.find((item) => item.caseId === "reject_shape");
  assert.equal(rejected.actionExecuted, false); assert.deepEqual(rejected.actual, { rejected: true, reason: "input_contract_rejected" });
  assert.equal(Object.hasOwn(result.package.application.actions[0].inputSchema, "description"), false);
  assert.deepEqual(result.submissionCounts.planner, { attempts: 1, accepted: 1, rejected: 0 });
});

test("真实Pi专用用例数组拒绝外层字符串，保留夹具后正式提交并真实隔离执行验收", { timeout: 20_000 }, async (t) => {
  const availability = await new DevelopmentExecutor().probe();
  if (!availability.available) { if (process.env.NEUMA_REQUIRE_ISOLATION === "1") assert.fail(availability.reason); return t.skip(availability.reason); }
  const fixture = await sdkFixture(t, { structuredPlan: true, dedicatedCases: true, dedicatedStringCases: true, readPlanSchema: true });
  const result = await fixture.run();
  assert.deepEqual(fixture.errors, []); assert.equal(result.status, "completed", result.summary);
  assert.deepEqual(fixture.rejectedWriteChecks, ["cases-json-string"]);
  const planner = fixture.sessions[0], replies = planner.messages.filter((message) => message.role === "toolResult" && message.toolName === "save_plan_cases");
  assert.equal(replies.length, 2); assert.equal(replies[0].isError, true); assert.equal(replies[1].isError, false);
  assert.match(textOf(replies[0].content), /save_plan_cases\.cases.*cases须直接传非空JSON数组/);
  assert.match(textOf(replies[0].content), /"receivedType":"string"/);
  assert.doesNotMatch(textOf(replies[0].content), /研发协议验证|Received arguments/);
  const first = fixture.requests.find((entry) => entry.key === "planner");
  const schema = first.body.tools.find((item) => item.function.name === "save_plan_cases").function.parameters.properties.cases;
  assert.equal(first.payload.valueSchemaGuide, undefined);
  assert.equal(first.payload.contextSections.find(item => item.section === "valueSchemaGuide").delivery, "paged");
  assert.equal(fixture.planSchemaPages.length, Math.ceil(fixture.planSchemaPages[0].totalChars / 8000));
  assert.equal(fixture.planSchemaPages.at(-1).nextOffset, null);
  assert.equal(fixture.toolCalls.filter((item) => item.name === "read_development_context" && item.args.section === "planSchema").length, fixture.planSchemaPages.length);
  assert.deepEqual(schema, fixture.readSchema.properties.cases, "专用工具与实际分页读取的完整case schema一致");
  assert.equal(result.plan.cases[0].input.fixture.op, "value"); assert.equal(result.plan.cases[0].input.fixture.value, "研发协议验证");
  assert.equal(result.plan.cases[0].assertions[0].expectedJson.fixture.value, "研发协议验证");
  const report = result.reports.at(-1); assert.equal(report.status, "passed");
  assert.deepEqual(report.results.find((item) => item.caseId === "echo_text").actual, { input: "研发协议验证" });
  assert.deepEqual(report.results.find((item) => item.caseId === "empty_text").actual, { error: "missing_input" });
  assert.deepEqual(result.reviews.map((item) => item.mode), ["plan", "task", "integration"]);
  assert.equal(result.planning.turns, 4 + fixture.planSchemaPages.length); assert.equal(Object.values(result.sessions).find((entry) => entry.role === "planner").limit, 12);
  assert.deepEqual(result.submissionCounts.planner, { attempts: 1, accepted: 1, rejected: 0 });
});

test("真实Pi用例原参数禁止SDK把内层数值转字符串，写前拒绝且原会话继续合法夹具", { timeout: 20_000 }, async (t) => {
  const availability = await new DevelopmentExecutor().probe();
  if (!availability.available) { if (process.env.NEUMA_REQUIRE_ISOLATION === "1") assert.fail(availability.reason); return t.skip(availability.reason); }
  const fixture = await sdkFixture(t, { structuredPlan: true, dedicatedCases: true, dedicatedCoercedCases: true });
  const result = await fixture.run();
  assert.deepEqual(fixture.errors, []); assert.equal(result.status, "completed", result.summary);
  assert.deepEqual(fixture.rejectedWriteChecks, ["nested-coercion"]);
  const calls = fixture.toolCalls.filter((entry) => entry.name === "save_plan_cases");
  assert.equal(calls.length, 3); assert.equal(calls[1].args.cases[0].input, 7); assert.equal(calls[1].args.cases[0].assertions[0].expectedJson, 7);
  const replies = fixture.sessions[0].messages.filter((message) => message.role === "toolResult" && message.toolName === "save_plan_cases");
  assert.equal(replies[1].isError, true);
  const feedback = textOf(replies[1].content);
  assert.match(feedback, /save_plan_cases\.cases\[0\]\.input/);
  assert.match(feedback, /save_plan_cases\.cases\[0\]\.assertions\[0\]\.expectedJson/);
  assert.match(feedback, /"receivedType":"number"/);
  assert.doesNotMatch(feedback, /研发协议验证|Received arguments/);
  const history = (await readFile(fixture.sessions[0].session.sessionFile, "utf8")).trim().split("\n").map(JSON.parse);
  const stored = history.find((entry) => entry.message?.role === "toolResult" && entry.message.toolName === "save_plan_cases" && entry.message.isError);
  assert.ok(stored); assert.doesNotMatch(textOf(stored.message.content), /研发协议验证|Received arguments/);
  assert.equal(result.plan.cases[0].input.fixture.value, "研发协议验证");
  assert.deepEqual(result.reports.at(-1).results.find((item) => item.caseId === "echo_text").actual, { input: "研发协议验证" });
  assert.equal(result.planning.turns, 5); assert.equal(Object.values(result.sessions).find((entry) => entry.role === "planner").limit, 12);
  assert.deepEqual(result.submissionCounts.planner, { attempts: 1, accepted: 1, rejected: 0 });
});
