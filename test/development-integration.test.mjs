import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ARCHITECTURE_VERSION, designHash } from "../architecture-contract.mjs";
import { DevelopmentController } from "../development.mjs";
import { createPiSession } from "../pi-runtime.mjs";
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

async function unseal(path) {
  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await unseal(join(path, entry.name));
}

async function sdkFixture(t, { invalidPlan = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-development-sdk-"));
  const requests = [], sessions = [], toolCalls = [], errors = [], checks = [], progress = [];
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
      const expected = role === "planner" ? ["list_code_files", "read_code_file", "submit_development_plan"]
        : role === "developer" ? ["list_code_files", "read_code_file", "run_development_checks", "submit_development_work", "write_code_file"]
          : payload.mode === "plan" ? ["submit_development_review"] : ["list_code_files", "read_code_file", "submit_development_review"];
      assert.deepEqual(names, [...expected, "read_development_context"].sort());
      if (!called.length) {
        assert.equal(body.messages.some((message) => ["assistant", "tool"].includes(message.role)), false);
        assert.doesNotMatch(JSON.stringify(body.messages), /PRIVATE_SESSION_FINISH/);
      }
      let name, args;
      if (role === "planner" && !called.includes("submit_development_plan")) {
        name = "submit_development_plan"; args = invalidPlan ? { ...plan, entrypoint: "outside.mjs" } : plan;
      } else if (role === "developer") {
        if (!called.includes("write_code_file")) { name = "write_code_file"; args = { path: "main.mjs", content: SOURCE }; }
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
  const executor = { probe: async () => ({ available: true, reason: "协议测试执行替身" }),
    verify: async ({ snapshot, entrypoint, cases, signal }) => {
      signal.throwIfAborted(); assert.equal(entrypoint, "main.mjs");
      assert.equal(await readFile(join(snapshot.path, entrypoint), "utf8"), SOURCE);
      checks.push({ snapshot, entrypoint, cases });
      return { status: "passed", codeHash: snapshot.hash, summary: "协议测试执行替身；未执行生成代码。", fixture: true,
        results: cases.map((item) => ({ caseId: item.id, status: "passed", fixture: true })) };
    } };
  controller = new DevelopmentController({ config, cwd: root, dataDir: join(root, "data"), executor,
    getArchitecture: async () => structuredClone(architecture), sessionFactory: async (options) => {
      const session = await createPiSession(options);
      assert.equal(session.messages.length, 0);
      const record = { session, tools: options.customTools.map((tool) => tool.name), disposed: false, messages: null };
      const dispose = session.dispose.bind(session);
      session.dispose = () => { record.messages = structuredClone(session.messages); record.disposed = true; dispose(); };
      sessions.push(record); return session;
    } });
  return { root, controller, requests, sessions, toolCalls, errors, checks, progress,
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
  assert.deepEqual(fixture.sessions.map(({ tools }) => tools.find((name) => name.startsWith("submit_"))),
    ["submit_development_plan", "submit_development_review", "submit_development_work", "submit_development_review", "submit_development_review"]);
  for (const session of fixture.sessions) {
    const markers = JSON.stringify(session.messages).match(/[a-z-]+_PRIVATE_SESSION_FINISH/g) ?? [];
    assert.equal(new Set(markers).size, 1, "每个角色只保留自己的对话收尾");
  }
  const firstRequests = fixture.requests.filter(({ body }) => body.messages.every((message) => ["system", "user"].includes(message.role)));
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
  assert.match(JSON.stringify(fixture.requests.at(-1).body.messages), /入口必须是任务文件清单/);
  assert.equal(fixture.sessions[0].disposed, true);
});
