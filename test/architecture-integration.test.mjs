import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrototypeAgents } from "../agent-prototype.mjs";
import { designHash } from "../architecture-contract.mjs";
import { createRequestHandler } from "../server.mjs";
import { InputError, ProviderError } from "../core.mjs";
import { validDraft, validDesign, passingReview } from "./helpers/architecture.mjs";

const input = (id = "weekly", goal = "整理周报") => ({ id, name: "周报助手", draft: validDraft(goal) });
const turn = (agentId = "weekly", sessionId = "architecture-session-12345") => ({ agentId, sessionId, message: "整理本周进展" });
const FILE_CAPABILITIES = ["conversation", "list_workspace_files", "read_workspace_file", "write_workspace_file"]
  .map((id) => ({ id, status: "available", reason: "处理用户提供的文本并保存专属目录产物" }));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function rejectedReview(hash) {
  const review = passingReview(hash);
  review.verdict = "insufficient";
  review.checks.find((item) => item.id === "feasibility").passed = false;
  review.issues = [{ id: "missing_evidence", blocking: true, description: "关键能力缺少证据", remedy: "补充能力验证" }];
  review.summary = "关键证据不足，不能通过架构检查。";
  return review;
}

function fakeSessions(records, script) {
  return async (options) => {
    const tools = Object.fromEntries(options.customTools.map((tool) => [tool.name, tool]));
    const role = tools.submit_architecture ? "designer" : tools.submit_architecture_review ? "reviewer" : "runtime";
    const record = { role, options, tools, prompts: [], aborted: false, disposed: false };
    const session = {
      messages: [], subscribe() { return () => {}; },
      async prompt(message) {
        record.prompts.push(message);
        const payload = role === "runtime" ? message : JSON.parse(message);
        await script.before?.(record, payload);
        if (role === "designer") {
          const design = script.design ? script.design(payload) : validDesign(payload.requirements);
          await tools.submit_architecture.execute("design-fixture", design);
        } else if (role === "reviewer") {
          const review = script.review ? script.review(payload) : passingReview(payload.candidateHash);
          await tools.submit_architecture_review.execute("review-fixture", review);
        }
        session.messages.push({ role: "assistant", stopReason: record.aborted ? "aborted" : "stop" });
      },
      getLastAssistantText: () => "已按提供的记录整理周报。",
      async abort() { record.aborted = true; record.release?.(); },
      dispose() { record.disposed = true; },
    };
    record.session = session;
    records.push(record);
    return session;
  };
}

async function fixture(t, script = {}, seed) {
  const root = await mkdtemp(join(tmpdir(), "neuma-architecture-integration-"));
  const records = [];
  const options = { config: { llmConfigured: true }, cwd: root, dataDir: join(root, "data"),
    sessionFactory: fakeSessions(records, script) };
  if (seed) { await mkdir(options.dataDir); await seed(options.dataDir); }
  const agents = new PrototypeAgents(options);
  t.after(async () => { await agents.close(); await rm(root, { recursive: true, force: true }); });
  return { agents, root, options, records };
}

class ResponseSink extends EventEmitter {
  text = "";
  writableEnded = false;
  destroyed = false;
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  write(content) { this.text += content; }
  end(content = "") { this.text += content; this.writableEnded = true; }
  events() { return this.text.trim().split("\n").filter(Boolean).map(JSON.parse); }
}

function api(agents) {
  return createRequestHandler({ config: {}, providers: {}, prototypeAgents: agents,
    projects: { dispose: async () => {} }, projectAgent: { dispose: async () => {} } });
}

async function invoke(handler, method, url, body, streaming = false) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(request, { method, url, headers: body === undefined ? {} : { "content-type": "application/json" } });
  if (streaming) request.headers.accept = "application/x-ndjson";
  const response = new ResponseSink();
  await handler(request, response);
  return response;
}

test("独立评估未通过或存在关键未知时，不保存新的 Agent 执行定义", async (t) => {
  for (const [label, script, expectedStatus] of [
    ["评估未通过", { review: (payload) => rejectedReview(payload.candidateHash) }, "needs_evidence"],
    ["程序发现关键未知", { design: (payload) => validDesign(payload.requirements, {
      unknowns: [{ question: "依赖能力是否可用", blocking: true, resolution: "完成真实验证" }],
    }) }, "needs_changes"],
  ]) {
    await t.test(label, async (subtest) => {
      const { agents, options } = await fixture(subtest, script);
      const result = await agents.build(input());
      assert.equal(result.agent, null);
      assert.equal(result.architecture.status, expectedStatus);
      assert.equal(result.architecture.delivery, "blocked");
      assert.equal(await agents.get("weekly"), null);
      assert.equal((await agents.getArchitecture("weekly")).status, expectedStatus);
      await assert.rejects(readFile(join(options.dataDir, "agents.json")), { code: "ENOENT" });
      await assert.rejects(agents.prompt(turn()), /先创建/);
    });
  }
});

test("新架构失败保留旧定义、记忆、资料和文件，但 API 与后端不能借旧版本运行", async (t) => {
  const script = { design: (payload) => validDesign(payload.requirements, { capabilities: FILE_CAPABILITIES }) };
  const { agents, records, options } = await fixture(t, script);
  const first = await agents.build(input());
  const profile = { name: "我的周报", description: "保留的展示资料", icon: "📝" };
  await agents.setMemory("weekly", "偏好简短中文");
  await agents.setProfile("weekly", profile);
  await agents.prompt(turn());
  const runtime = records.find((record) => record.role === "runtime");
  await runtime.tools.write_workspace_file.execute("file", { file: "weekly.md", content: "已保存的产物" });
  script.before = async (record) => { if (record.role === "designer") throw new Error("模拟模型连接失败"); };
  await assert.rejects(agents.build(input("weekly", "新的工作目标")), ProviderError);
  const handler = api(agents);
  const inspected = JSON.parse((await invoke(handler, "GET", "/api/agents/weekly")).text);
  assert.equal(inspected.agent.revision, first.agent.revision);
  assert.deepEqual(inspected.agent.draft, first.agent.draft);
  assert.deepEqual(inspected.agent.profile, profile);
  assert.equal(inspected.agent.memory, "偏好简短中文");
  assert.equal(inspected.architecture.version, first.architecture.version + 1);
  assert.equal(inspected.architecture.status, "failed");
  assert.equal(inspected.architecture.draft.goal.value, "新的工作目标");
  assert.equal((await agents.file("weekly", "weekly.md")).content, "已保存的产物");
  await assert.rejects(agents.prompt(turn()), /尚未生成可运行定义/);
  const response = await invoke(handler, "POST", "/api/agents/turn", turn());
  assert.equal(response.status, 400);
  assert.match(JSON.parse(response.text).error, /尚未生成可运行定义/);
  const restored = new PrototypeAgents(options);
  t.after(() => restored.close());
  assert.equal((await restored.getArchitecture("weekly")).status, "failed");
  assert.equal((await restored.getMemory("weekly")).memory, "偏好简短中文");
  await assert.rejects(restored.prompt(turn()), /尚未生成可运行定义/);
});

test("相同需求的旧 prototype 必须经过新设计和评估，不能复用未评估指令", async (t) => {
  const definition = input();
  const createdAt = "2026-10-03T00:00:00.000Z";
  const legacy = { ...definition, fingerprint: designHash({ name: definition.name, draft: definition.draft }),
    instructions: "旧版未评估指令", mode: "prototype", status: "ready", revision: 4,
    createdAt, updatedAt: createdAt, memory: "旧记忆", profile: { name: "旧昵称", description: "", icon: "" } };
  const { agents, records } = await fixture(t, {}, async (dataDir) => {
    await writeFile(join(dataDir, "agents.json"), JSON.stringify({ version: 1, agents: [legacy] }));
  });
  assert.equal(await agents.getArchitecture("weekly"), null);
  assert.equal((await agents.get("weekly")).status, "needs_architecture");
  await assert.rejects(agents.prompt(turn()), /尚未生成可运行定义/);
  assert.equal(records.length, 0);
  assert.equal((await agents.getMemory("weekly")).memory, "旧记忆");
  const result = await agents.build(definition);
  assert.deepEqual(records.map((record) => record.role), ["designer", "reviewer"]);
  assert.equal(result.agent.mode, "designed");
  assert.equal(result.agent.revision, 5);
  assert.notEqual(result.agent.instructions, legacy.instructions);
  assert.equal(result.agent.createdAt, createdAt);
  assert.equal(result.agent.memory, "旧记忆");
  assert.deepEqual(result.agent.profile, legacy.profile);
  assert.equal(result.architecture.status, "passed");
  assert.equal(result.architecture.delivery, "ready");
  await agents.build(definition);
  assert.equal(records.length, 2);
});

test("缺少 mode 的历史定义也不能直跑，重启仍须正式架构评估", async (t) => {
  const definition = input();
  const legacy = { ...definition, fingerprint: designHash({ name: definition.name, draft: definition.draft }),
    instructions: "未经评估的临时指令", status: "ready", revision: 1 };
  const { agents, options, records } = await fixture(t, {}, async (dataDir) => {
    await writeFile(join(dataDir, "agents.json"), JSON.stringify({ version: 1, agents: [legacy] }));
  });
  await assert.rejects(agents.prompt(turn()), /尚未生成可运行定义/);
  assert.equal((await agents.get("weekly")).status, "needs_architecture");
  const restored = new PrototypeAgents(options); t.after(() => restored.close());
  await assert.rejects(restored.prompt(turn()), /尚未生成可运行定义/);
  assert.equal((await restored.get("weekly")).instructions, legacy.instructions);
  assert.equal(records.length, 0);
});

test("持久化与重启保持需求、Agent ID、候选哈希和评估绑定，普通对话不装配文件工具", async (t) => {
  const definition = input();
  const { agents, options, records } = await fixture(t);
  const result = await agents.build(definition);
  assert.deepEqual(result.agent.draft, definition.draft);
  assert.deepEqual(result.architecture.draft, definition.draft);
  assert.equal(result.architecture.agentId, definition.id);
  assert.equal(result.architecture.candidateHash, designHash(result.architecture.design));
  assert.equal(result.architecture.review.candidateHash, result.architecture.candidateHash);
  assert.equal(result.agent.architectureRef.candidateHash, result.architecture.candidateHash);
  assert.equal(result.agent.architectureRef.version, result.architecture.version);
  const definitions = JSON.parse(await readFile(join(options.dataDir, "agents.json"), "utf8"));
  const architectures = JSON.parse(await readFile(join(options.dataDir, "architectures.json"), "utf8"));
  assert.equal(definitions.agents[0].id, architectures.records[0].agentId);
  assert.equal(definitions.agents[0].fingerprint, architectures.records[0].sourceFingerprint);
  const restored = new PrototypeAgents(options);
  t.after(() => restored.close());
  const reply = await restored.prompt(turn());
  assert.equal(reply.status, "complete");
  const runtime = records.find((record) => record.role === "runtime");
  assert.deepEqual(runtime.options.customTools, []);
  assert.deepEqual((await restored.get("weekly")).toolIds, []);
});

test("指令或工具白名单被改变后不能运行或复用，必须重新设计并评估", async (t) => {
  for (const [label, mutate] of [
    ["工作指令", (agent) => { agent.instructions = "未经评估的新指令"; }],
    ["工具权限", (agent) => { agent.toolIds = ["write_workspace_file"]; }],
  ]) {
    await t.test(label, async (subtest) => {
      const { agents, records } = await fixture(subtest);
      const initial = await agents.build(input());
      mutate(agents.agents.get("weekly"));
      await assert.rejects(agents.prompt(turn()), /尚未生成可运行定义/);
      const rebuilt = await agents.build(input());
      assert.equal(rebuilt.agent.revision, initial.agent.revision + 1);
      assert.equal(rebuilt.architecture.version, initial.architecture.version + 1);
      assert.deepEqual(records.map((record) => record.role), ["designer", "reviewer", "designer", "reviewer"]);
      assert.deepEqual(rebuilt.agent.toolIds, []);
      assert.equal(rebuilt.agent.instructions, rebuilt.architecture.design.instructions);
    });
  }
});

test("JSON 和流 API 保留未通过或待研发状态，架构通过不冒充可运行 Agent", async (t) => {
  for (const [label, script, status, delivery] of [
    ["评估未通过", { review: (payload) => rejectedReview(payload.candidateHash) }, "needs_evidence", "blocked"],
    ["方案通过但待研发", { design: (payload) => validDesign(payload.requirements, {
      profile: "custom", rationale: "专门处理能力尚需研发，先完成方案评估。",
      capabilities: [{ id: "custom_processor", status: "needs_development", reason: "需要实现专门处理模块" }],
    }) }, "passed", "needs_development"],
  ]) {
    await t.test(label, async (subtest) => {
      const { agents } = await fixture(subtest, script);
      const handler = api(agents);
      for (const streaming of [false, true]) {
        const response = await invoke(handler, "POST", "/api/agents/build", input(), streaming);
        assert.equal(response.status, 200);
        const result = streaming ? response.events().at(-1).result : JSON.parse(response.text);
        if (streaming) assert.equal(response.events().at(-1).type, "done");
        assert.equal(result.agent, null);
        assert.equal(result.architecture.status, status);
        assert.equal(result.architecture.delivery, delivery);
        assert.notEqual(result.architecture.buildable, true);
      }
      const inspected = JSON.parse((await invoke(handler, "GET", "/api/agents/weekly")).text);
      assert.equal(inspected.agent, null);
      assert.equal(inspected.architecture.status, status);
      assert.equal(inspected.architecture.delivery, delivery);
    });
  }
});

test("构建期间取消已有会话和新设计，保留已写文件与旧定义且不保存新版本", async (t) => {
  const designStarted = deferred(), runtimeStarted = deferred();
  let slowDesign = false, slowRuntime = false;
  const script = {
    design: (payload) => validDesign(payload.requirements, { capabilities: FILE_CAPABILITIES }),
    before: async (record) => {
      if (record.role === "runtime" && slowRuntime) {
        await record.tools.write_workspace_file.execute("file", { file: "before-cancel.md", content: "取消前已保存" });
        const waiting = new Promise((done) => { record.release = done; });
        runtimeStarted.resolve(); await waiting;
      }
      if (record.role === "designer" && slowDesign) {
        const waiting = new Promise((done) => { record.release = done; });
        designStarted.resolve(); await waiting;
      }
    },
  };
  const { agents, records } = await fixture(t, script);
  const initial = await agents.build(input());
  slowRuntime = true;
  const pendingTurn = agents.prompt(turn());
  const rejectedTurn = assert.rejects(pendingTurn, (error) => error instanceof ProviderError && error.diagnostic.reason === "cancelled");
  await runtimeStarted.promise;
  slowDesign = true;
  const controller = new AbortController();
  const pendingBuild = agents.build(input("weekly", "更新需求"), { signal: controller.signal });
  const rejectedBuild = assert.rejects(pendingBuild, (error) => error instanceof ProviderError && error.diagnostic.reason === "cancelled");
  await designStarted.promise;
  assert.deepEqual(await agents.cancel(turn().sessionId), { cancelled: true });
  await rejectedTurn;
  controller.abort();
  await rejectedBuild;
  assert.equal((await agents.file("weekly", "before-cancel.md")).content, "取消前已保存");
  assert.equal((await agents.get("weekly")).revision, initial.agent.revision);
  assert.equal((await agents.getArchitecture("weekly")).status, "cancelled");
  assert.equal((await agents.getArchitecture("weekly")).delivery, "blocked");
  assert.equal(records.filter((record) => record.aborted && record.disposed).length, 2);
});

test("同时构建同一 Agent ID 只接受一次，第二次不能越过异步检查进入设计", async (t) => {
  const started = deferred(), hold = deferred();
  const { agents, records } = await fixture(t, { before: async (record) => {
    if (record.role === "designer") { record.release = hold.resolve; started.resolve(); await hold.promise; }
  } });
  const pending = Promise.allSettled([agents.build(input()), agents.build(input())]);
  await started.promise;
  await new Promise(setImmediate);
  hold.resolve();
  const results = await pending;
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.match(rejected.reason.message, /正在创建/);
  assert.deepEqual(records.map((record) => record.role), ["designer", "reviewer"]);
  assert.equal((await agents.get("weekly")).revision, 1);
  assert.equal((await agents.getArchitecture("weekly")).version, 1);
});

test("定义先保存但激活失败或取消时恢复旧定义，保留期间更新的记忆和展示资料", async (t) => {
  for (const stop of ["error", "cancel"]) {
    await t.test(stop, async (subtest) => {
      const { agents, options } = await fixture(subtest);
      const initial = await agents.build(input());
      await agents.setMemory("weekly", "旧记忆");
      const controller = new AbortController();
      const markReady = agents.architecture.markReady.bind(agents.architecture);
      const profile = { name: "更新中的展示名称", description: "应当保留", icon: "📝" };
      agents.architecture.markReady = async (record) => {
        assert.equal((await agents.get("weekly")).revision, initial.agent.revision + 1,
          "进入激活步骤前应先保存被 blocked 架构约束的新定义");
        assert.equal((await agents.getArchitecture("weekly")).delivery, "blocked");
        await agents.setMemory("weekly", "激活期间编辑的记忆");
        await agents.setProfile("weekly", profile);
        if (stop === "error") throw new Error("模拟审核记录持久化失败");
        const activated = await markReady(record);
        controller.abort();
        return activated;
      };
      await assert.rejects(agents.build(input("weekly", "新需求"), { signal: controller.signal }), ProviderError);
      const retained = await agents.get("weekly");
      assert.equal(retained.revision, initial.agent.revision);
      assert.equal(retained.instructions, initial.agent.instructions);
      assert.deepEqual(retained.draft, initial.agent.draft);
      assert.deepEqual(retained.architectureRef, initial.agent.architectureRef);
      assert.equal(retained.memory, "激活期间编辑的记忆");
      assert.deepEqual(retained.profile, profile);
      const architecture = await agents.getArchitecture("weekly");
      assert.equal(architecture.status, stop === "cancel" ? "cancelled" : "failed");
      assert.equal(architecture.delivery, "blocked");
      await assert.rejects(agents.prompt(turn()), /尚未生成可运行定义/);
      const restarted = new PrototypeAgents(options); subtest.after(() => restarted.close());
      assert.deepEqual(await restarted.get("weekly"), retained);
      await assert.rejects(restarted.prompt(turn()), /尚未生成可运行定义/);
    });
  }
});

test("新定义落盘到激活之间重启，架构仍是 blocked 而不会提前声明已交付", async (t) => {
  const { agents, options } = await fixture(t);
  const reachedActivation = deferred(), release = deferred();
  const markReady = agents.architecture.markReady.bind(agents.architecture);
  agents.architecture.markReady = async (record) => {
    reachedActivation.resolve(); await release.promise;
    return markReady(record);
  };
  const pending = agents.build(input());
  try {
    await reachedActivation.promise;
    const definitions = JSON.parse(await readFile(join(options.dataDir, "agents.json"), "utf8"));
    const architectures = JSON.parse(await readFile(join(options.dataDir, "architectures.json"), "utf8"));
    assert.equal(definitions.agents[0].id, "weekly");
    assert.equal(architectures.records[0].delivery, "blocked");
    const restarted = new PrototypeAgents(options); t.after(() => restarted.close());
    await assert.rejects(restarted.prompt(turn()), /尚未生成可运行定义/);
  } finally { release.resolve(); }
  assert.equal((await pending).architecture.delivery, "ready");
});

test("删除定义落盘失败时保留架构记录，旧 prototype 不得重新绕过审核", async (t) => {
  const definition = input();
  const legacy = { ...definition, fingerprint: designHash({ name: definition.name, draft: definition.draft }),
    instructions: "旧版未评估指令", mode: "prototype", status: "ready", revision: 1,
    createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z" };
  const { agents, options } = await fixture(t, { review: (payload) => rejectedReview(payload.candidateHash) }, async (dataDir) => {
    await writeFile(join(dataDir, "agents.json"), JSON.stringify({ version: 1, agents: [legacy] }));
  });
  await agents.build(definition);
  const architectureBefore = await agents.getArchitecture("weekly");
  await assert.rejects(agents.prompt(turn()), /尚未生成可运行定义/);
  const commit = agents.commit.bind(agents);
  agents.commit = async () => { throw new InputError("模拟定义文件无法保存"); };
  await assert.rejects(agents.remove("weekly"), /无法保存/);
  agents.commit = commit;
  assert.equal((await agents.get("weekly")).mode, "prototype");
  assert.deepEqual(await agents.getArchitecture("weekly"), architectureBefore);
  await assert.rejects(agents.prompt(turn()), /尚未生成可运行定义/);
  const restarted = new PrototypeAgents(options); t.after(() => restarted.close());
  assert.deepEqual(await restarted.getArchitecture("weekly"), architectureBefore);
  await assert.rejects(restarted.prompt(turn()), /尚未生成可运行定义/);
});

test("正在等待审核快照的任务不能在 Agent 删除完成后用旧定义启动", async (t) => {
  const { agents, records } = await fixture(t);
  await agents.build(input());
  const reading = deferred(), release = deferred();
  const getArchitecture = agents.getArchitecture.bind(agents);
  agents.getArchitecture = async (id) => {
    const snapshot = await getArchitecture(id);
    reading.resolve(); await release.promise;
    return snapshot;
  };
  const pending = agents.prompt(turn());
  const rejected = assert.rejects(pending, InputError);
  await reading.promise;
  await agents.remove("weekly");
  release.resolve();
  await rejected;
  assert.equal(await agents.get("weekly"), null);
  assert.equal(records.filter((record) => record.role === "runtime").length, 0);
  assert.equal(agents.sessions.size, 0);
});
