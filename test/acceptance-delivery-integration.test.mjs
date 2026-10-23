import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrototypeAgents } from "../src/agents/agent-prototype.mjs";
import { DevelopmentExecutor } from "../src/development/development-executor.mjs";
import { ACCEPTANCE_ADAPTERS, assertAcceptanceComplete, summarizeAcceptanceLedger } from "../src/verification/acceptance-contract.mjs";
import { validDraft, validDesign, passingReview } from "./helpers/architecture.mjs";
import { developmentReview, developmentWork } from "./helpers/development.mjs";
import { fidelityChecker } from "./helpers/fidelity.mjs";
import { processTurn } from "../src/requirements/core.mjs";
import { requirementItems } from "../src/architecture/architecture-contract.mjs";
import { createPlatformSnapshot } from "../src/architecture/platform-contract.mjs";
import { sufficientPreflight } from "./helpers/consultation.mjs";
import { createArchitectureStageSessionFactory } from "./helpers/architecture-stages.mjs";

const id = "acceptance-integration";
const verification = (adapterId) => ({ stage: ACCEPTANCE_ADAPTERS[adapterId].stage, owner: ACCEPTANCE_ADAPTERS[adapterId].owner, adapterId });
const output = (normalized = "", error = "") => ({ normalized, length: normalized.length, error, artifact: normalized && !error ? "result.txt" : "" });
const source = `export const actions = { async normalize(input,ctx) {
 const normalized=input.text.trim().toUpperCase();
 if(!normalized)return {normalized:'',length:0,error:'missing_input',artifact:''};
 if(normalized.length>32)return {normalized:'',length:0,error:'too_long',artifact:''};
 const file=await ctx.files.write({file:'result.txt',content:'normalized\\n'+normalized+'\\n'});
 if(!file.saved)return {normalized:'',length:0,error:'save_failed',artifact:''};
 return {normalized,length:normalized.length,error:'',artifact:'result.txt'};
} };`;
const schema = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
function design(requirements) {
  return validDesign(requirements, { schemaVersion: 3, profile: "light", rationale: "已有宿主承接文件、隔离和网关，独立动作负责精确转换。",
    interaction: { defaultEntry: "conversation", page: false, operations: true, inputs: "用户提供的文字", results: "转换统计和完整文件", persistentData: "任务产物" }, connections: [],
    instructions: "用户未提供材料时请求材料，不编造输出；处理任务调用已交付normalize动作，并按实际结果回复。",
    execution: { language: "javascript", hosting: "builtin", reason: "固定程序使用实际Node动作执行器" },
    selectionBasis: { capacity: "固定测试输入最多32字符，边界由真实动作核对", process: "业务验收及宿主验收分别执行",
      quality: "真实执行和完整产物核对", requirementIds: requirements.map((item) => item.id), assumptions: [] },
    capabilities: [{ id: "conversation", status: "available", reason: "询问用户缺少的输入" }, { id: "normalizer", status: "needs_development", reason: "精确转换并保存文件" },
      { id: "gateway_http_api", status: "available", reason: "已实现平台网关，当前配置与协议另行验收" },
      { id: "gateway_mcp", status: "available", reason: "已实现平台网关，当前配置与协议另行验收" }],
    acceptance: [
      { id: "valid", kind: "success", requirementIds: requirements.map((item) => item.id), input: "  hello  ", expected: "返回HELLO与长度5，并保存完整文件", verification: verification("action") },
      { id: "missing", kind: "missing_input", requirementIds: ["inputSource"], input: "没有提供材料", expected: "请求用户提供材料，不运行转换", verification: verification("conversation") },
      { id: "boundary", kind: "boundary", requirementIds: ["successCriteria"], input: "33个字符", expected: "明确返回too_long，不保存文件", verification: verification("action") },
      { id: "tool_failure", kind: "tool_failure", requirementIds: ["deliverable"], input: "保存能力返回未保存", expected: "返回save_failed，不声称保存成功", verification: verification("action") },
      { id: "files", kind: "success", requirementIds: ["deliverable"], input: "宿主保存文件", expected: "宿主写入、读回和下载原字节一致", verification: verification("host-files") },
      { id: "runtime", kind: "success", requirementIds: ["usage"], input: "运行环境", expected: "实际隔离运行环境通过探测", verification: verification("host-runtime") },
      { id: "gateway", kind: "success", requirementIds: ["externalAction"], input: "用户明确开启接口", expected: "已授权HTTP与MCP目录绑定当前交付", verification: verification("host-gateway") },
      { id: "business", kind: "success", requirementIds: ["task"], input: "激活前独立重跑已冻结正常及边界用例", expected: "正常输入真实转换并保存完整文件，超边界输入真实拒绝", verification: verification("host-business") },
      { id: "static", kind: "boundary", requirementIds: ["usage"], input: "独立核对完整计划与最终代码", expected: "交付只公开normalize一个动作，不增加额外公开功能", verification: verification("delivery-review") },
    ] });
}
function plan(requirements) {
  const mock = (text, saved) => [{ capability: "files.write", argsJson: JSON.stringify({ file: "result.txt", content: `normalized\n${text}\n` }), resultJson: JSON.stringify({ saved }) }];
  const caseOf = (acceptanceId, text, expected, mocks) => ({ id: `case_${acceptanceId}`, taskId: "normalize", acceptanceId, actionId: "normalize", input: JSON.stringify({ text }), mocks,
    assertions: [{ path: "", expectedJson: JSON.stringify(expected) }] });
  return { schemaVersion: 3, summary: "实现实际转换动作，由宿主分别验证其文件和接口通道", runtime: "node-action", entrypoint: "actions.mjs",
    application: { protocolVersion: 2, runtime: "node-action", entrypoint: "actions.mjs", page: null,
      actions: [{ id: "normalize", title: "转换", inputSchema: schema({ text: { type: "string" } }), outputSchema: schema({ normalized: { type: "string" },
        length: { type: "integer" }, error: { type: "string" }, artifact: { type: "string" } }), connectionIds: [] }], stateVersion: 1, evidenceIds: [] },
    tasks: [{ id: "normalize", title: "实现转换", description: "转换、边界拒绝和文件失败处理", requirementIds: requirements.map((item) => item.id), acceptanceIds: ["valid", "boundary", "tool_failure"], dependsOn: [], files: ["actions.mjs"] }],
    activationChecks: [{ acceptanceId: "business", caseIds: ["case_valid", "case_boundary"] }],
    cases: [caseOf("valid", "  hello  ", output("HELLO"), mock("HELLO", true)), caseOf("boundary", "x".repeat(33), output("", "too_long"), []),
      caseOf("tool_failure", "test", output("", "save_failed"), mock("TEST", false))] };
}

function modelFactory(state) {
  const stages = createArchitectureStageSessionFactory(payload => {
    const candidate = design(payload.requirements);
    if (state.managed) candidate.execution.hosting = "managed";
    return candidate;
  }, { onPrompt: ({ stage, payload }) => {
    state.stageCalls.push({ stage, requirementIds: payload.requirements.map(item => item.id) });
  } });
  return async (options) => {
    const staged = await stages(options);
    if (staged) return staged;
    if (options.customTools.some((tool) => tool.name === "submit_requirement_fidelity")) return fidelityChecker()(options);
    const tools = Object.fromEntries(options.customTools.map((tool) => [tool.name, tool]));
    const submit = ["submit_architecture", "submit_architecture_review", "submit_development_plan", "submit_development_review",
      "submit_development_work", "submit_conversation_verification"].find((name) => Object.hasOwn(tools, name));
    if (submit === "submit_conversation_verification" && state.reviewFails) throw new Error("fixture independent review unavailable");
    let text = "", listener;
    const session = { model: { contextWindow: 1_000_000 }, messages: [], setAutoCompactionEnabled() {}, getContextUsage: () => ({ percent: 1 }),
      subscribe(fn) { listener = fn; return () => { listener = null; }; },
      async prompt(message) {
        state.prompts.push({ submit: submit ?? "working", message });
        const payload = submit ? JSON.parse(message) : null;
        if (submit === "submit_architecture") {
          const candidate = design(payload.requirements);
          if (state.managed) candidate.execution.hosting = "managed";
          await tools[submit].execute("design", candidate);
        }
        else if (submit === "submit_architecture_review") await tools[submit].execute("architecture-review", passingReview(payload.candidateHash, payload.design));
        else if (submit === "submit_development_plan") {
          const value = plan(payload.requirements), { cases, ...index } = value;
          if (state.managed) {
            index.runtime = "managed-service";
            Object.assign(index.application, { protocolVersion: 3, runtime: "managed-service", service: {
              schemaVersion: 1, language: "javascript", host: "managed", entrypoint: index.entrypoint,
              operations: index.application.actions, capabilities: ["files.write"], dependencies: { packages: [] }, dataVersion: 1,
            } });
          }
          if (state.planSummary) index.summary = state.planSummary;
          await tools.save_plan_json.execute("index", { path: "index.json", value: { ...index, caseFiles: ["cases.json"] } });
          await tools.save_plan_cases.execute("cases", { path: "cases.json", cases });
          await tools[submit].execute("plan", { indexPath: "index.json" });
        } else if (submit === "submit_development_review") await tools[submit].execute("review", developmentReview(payload.subjectHash,
          payload.report?.mode === "runtime" && payload.report.status === "failed" ? { verdict: "revise", summary: "修复真实宿主执行差异后重新验收",
            issues: [{ id: "host_business_difference", kind: "code", blocking: true, description: "实际文件回执路径的结果未通过冻结断言", remedy: "修复代码并保留原断言重新真实执行" }] } : {}));
        else if (submit === "submit_development_work") {
          await tools.write.execute("source", { path: "actions.mjs", content: state.sourceForTask ? await state.sourceForTask(payload.task) : source });
          await tools[submit].execute("work", developmentWork(payload.task));
        } else if (submit === "submit_conversation_verification") {
          const triggered = payload.observation.message === "没有提供材料";
          await tools[submit].execute("conversation-review", { results: payload.acceptance.map((item) => ({ acceptanceId: item.id, triggered,
            status: triggered ? "passed" : "not_run", reason: triggered ? "实际询问材料且没有执行工具" : "本轮未触发缺少材料场景", quotes: triggered ? [
              { source: "message", quote: "没有提供材料" }, { source: "reply", quote: "请提供要处理的文字材料。" },
            ] : [] })) });
        } else if (message.endsWith("执行小写 abc")) {
          const actual = await tools.run_application_action.execute("working-action-call", { actionId: "normalize", input: { text: "abc" } });
          assert.equal(JSON.parse(actual.content[0].text).status, "completed"); text = "实际转换为 ABC，完整文件已保存。";
        } else text = "请提供要处理的文字材料。";
        if (submit) text = "模拟模型已提交，真实结果由程序验证。";
        session.messages.push({ role: "assistant", stopReason: "stop", content: text });
        listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } }); listener?.({ type: "turn_end" });
      }, getLastAssistantText: () => text, async abort() {}, dispose() {} };
    return session;
  };
}
async function unseal(path) { await chmod(path, 0o700); for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await unseal(join(path, entry.name)); }
async function fixture(t, { managed = false, largeRequirements = false } = {}) {
  const probe = await new DevelopmentExecutor().probe(); if (!probe.available) { t.skip(probe.reason); return null; }
  const root = await mkdtemp(join(tmpdir(), "neuma-acceptance-delivery-")), state = { prompts: [], stageCalls: [], reviewFails: false, managed };
  const agents = new PrototypeAgents({ config: { llmConfigured: true }, cwd: root, dataDir: join(root, "data"), sessionFactory: modelFactory(state), fidelityChecker: fidelityChecker() });
  t.after(async () => { await agents.close(); await unseal(root); await rm(root, { recursive: true, force: true }); });
  const draft = validDraft("把用户文字转换为大写并保存完整结果");
  draft.task = { value: "去掉首尾空格并转为大写，超过32字符拒绝", source: "user" };
  draft.deliverable = { value: "精确统计、完整结果文件和可选本机API/MCP", source: "user" };
  draft.interaction = { defaultEntry: "conversation", page: false, operations: ["转换文字"], inputs: "文字", results: "统计及文件", persistentData: "任务产物" };
  if (largeRequirements) {
    const message = `固定程序交接容量测试的用户依据：${"核".repeat(3600)}`;
    draft.taskSpec = { version: 1, items: Array.from({ length: 120 }, (_, index) => ({ id: `capacity_${index}`,
      dimension: "processing", content: `第${index + 1}项验收：正常转换、长度边界及文件失败均按已冻结契约检查`, applicability: "applies", critical: true,
      source: { kind: "user", evidence: [{ messageId: "capacity_source", quote: message }] } })) };
    const platform = createPlatformSnapshot({ allowNetwork: true });
    const ready = await processTurn({ message, evidenceMessages: [{ id: "capacity_source", role: "user", content: message }] }, {
      generateDraft: async () => ({ draft, proposedGap: "none" }), preflight: sufficientPreflight,
    }, { enforceConsultation: true, platform, requestId: "capacity_prepare" });
    assert.equal(ready.status, "ready");
    const confirmed = await processTurn({ message: "确认", draft: ready.draft, lastQuestion: ready.confirmationQuestion,
      consultation: ready.consultation }, {}, { enforceConsultation: true, platform, requestId: "capacity_confirm" });
    assert.equal(confirmed.confirmed, true);
    Object.assign(draft, confirmed.draft);
    await agents.saveRequirements(id, { name: "转换验收测试", draft }, confirmed);
    assert.ok(Buffer.byteLength(JSON.stringify(draft)) > 512_000);
    assert.deepEqual((await agents.getRequirements()).requirements[0].draft, draft);
  }
  const result = await agents.build({ id, name: "转换验收测试", draft });
  assert.equal(result.architecture.status, "passed", JSON.stringify(result.architecture.issues));
  assert.equal(result.development?.status, "completed", JSON.stringify(result.development));
  assert.deepEqual(result.agent.toolIds, ["run_application_action"], "平台HTTP/MCP机制不装成工作模型可直接调用的工具");
  return { agents, state, result, draft, record: () => agents.development.store.getRun(result.development.id) };
}

test("120项需求及超过512KB的完整依据经确认、保存、架构、研发、激活和实际执行保持一致", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, { largeRequirements: true }); if (!f) return;
  const record = await f.record(), ids = requirementItems(f.draft).map(item => item.id);
  assert.ok(ids.length > 100);
  assert.deepEqual(f.state.stageCalls.map(call => call.stage), ["blueprint", "module", "integration"]);
  assert.ok(f.state.stageCalls.every(call => JSON.stringify(call.requirementIds) === JSON.stringify(ids)));
  assert.equal(f.result.architecture.designProgressCheckpoint.modelCalls, 3);
  assert.deepEqual(record.plan.tasks[0].requirementIds, ids);
  assert.deepEqual(record.architecture.design.coverage.map(item => item.requirementId), ids);
  assert.deepEqual(record.architecture.draft, f.draft);
  assert.equal(record.acceptanceLedger.items.find(item => item.acceptanceId === "business").status, "passed");
  const descriptor = await f.agents.applications.descriptor(id);
  const submitted = await f.agents.applications.submit(id, { actionId: "normalize", input: { text: " capacity " },
    mutationId: "capacity_actual", deliveryVersion: descriptor.deliveryVersion });
  const task = await f.agents.applications.wait(id, submitted.taskId);
  assert.equal(task.status, "completed"); assert.deepEqual(task.result, output("CAPACITY"));
  assert.equal(Buffer.from((await f.agents.readTaskArtifact(id, task.id, 0)).data, "base64").toString(), "normalized\nCAPACITY\n");
});

test("explicit验收贯穿真实研发、宿主验证、内部激活、API/MCP授权和撤权，并保留运行期待验", { timeout: 30000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const { agents, result } = f, initial = await f.record(), item = (record, acceptanceId) => record.acceptanceLedger.items.find((value) => value.acceptanceId === acceptanceId);
  assert.equal(initial.delivery, "needs_connection"); assert.equal(result.agent.status, "ready");
  assert.deepEqual(initial.package.acceptanceLedger, initial.acceptanceLedger);
  for (const acceptanceId of ["valid", "boundary", "tool_failure", "files", "runtime", "business", "static"]) assert.equal(item(initial, acceptanceId).status, "passed");
  assert.equal(item(initial, "static").evidence.kind, "independent-review");
  assert.equal(item(initial, "static").evidence.planHash, initial.planHash);
  assert.equal(item(initial, "business").evidence.scope, "isolated-business-case-execution");
  const businessEvidence = await agents.storage.readJson(id, `development/verification/${item(initial, "business").evidence.evidenceId}.json`);
  assert.equal(businessEvidence.observation.report.status, "passed");
  assert.deepEqual(businessEvidence.observation.report.results.map((entry) => entry.caseId), ["case_valid", "case_boundary"]);
  assert.ok(businessEvidence.observation.report.results.every((entry) => entry.actionExecuted));
  assert.equal(businessEvidence.observation.report.results[0].artifacts[0].sha256, businessEvidence.observation.report.results[0].artifacts[0].downloadedSha256);
  assert.equal(item(initial, "files").evidence.scope, "artifact-file-roundtrip"); assert.equal(item(initial, "runtime").evidence.scope, "isolated-runtime-health");
  assert.equal(item(initial, "gateway").status, "not_run"); assert.equal(item(initial, "missing").status, "not_run");
  assert.equal(summarizeAcceptanceLedger(initial.acceptanceLedger, { allowPendingActivationAdapters: ["host-gateway"] }).activationPermitted, true);
  assert.equal((await agents.gateway.config(id)).enabled, false);
  const descriptor = await agents.applications.descriptor(id), deliveryVersion = descriptor.deliveryVersion;
  const internal = await agents.applications.submit(id, { actionId: "normalize", input: { text: " real input " }, mutationId: "actual-internal-test", deliveryVersion });
  const internalTask = await agents.applications.wait(id, internal.taskId);
  assert.equal(internalTask.status, "completed"); assert.deepEqual(internalTask.result, output("REAL INPUT"));
  assert.equal(Buffer.from((await agents.readTaskArtifact(id, internal.taskId, 0)).data, "base64").toString(), "normalized\nREAL INPUT\n");
  const grant = await agents.gateway.configure(id, { actionIds: ["normalize"], deliveryVersion });
  assert.equal(grant.verification.status, "passed"); assert.equal(grant.verification.mode, "actual");
  const authorized = await f.record(); assert.equal(authorized.delivery, "ready"); assert.equal(item(authorized, "gateway").status, "passed");
  assert.equal(item(authorized, "missing").status, "not_run");
  const privateGrant = await agents.gateway.record(id);
  await agents.verifyGatewayAcceptance({ agentId: id, deliveryVersion, evidence: { grantId: privateGrant.grantId, actionIds: ["normalize"], mode: "mock", status: "passed", passed: true } });
  assert.equal(item(await f.record(), "gateway").status, "failed", "调用方passed不能覆盖宿主对模拟证据的拒绝");
  assert.equal((await agents.gateway.verify(id, privateGrant, grant.token)).status, "passed");
  const response = await fetch(`${grant.apiUrl}/tasks`, { method: "POST", headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json" },
    body: JSON.stringify({ actionId: "normalize", input: { text: " gateway " }, mutationId: "actual-gateway-test", deliveryVersion }) });
  assert.equal(response.status, 202); const submitted = await response.json(), task = await agents.applications.wait(id, submitted.taskId);
  assert.deepEqual(task.result, output("GATEWAY"));
  const download = await fetch(`${grant.apiUrl}/tasks/${task.id}/artifacts/0?deliveryVersion=${encodeURIComponent(deliveryVersion)}`, { headers: { authorization: `Bearer ${grant.token}` } });
  assert.equal(download.status, 200); const page = await download.json();
  assert.equal(Buffer.from(page.data, "base64").toString(), "normalized\nGATEWAY\n");
  assert.equal(Buffer.from((await agents.readTaskArtifact(id, internal.taskId, 0)).data, "base64").toString(), "normalized\nREAL INPUT\n");
  assert.doesNotMatch(JSON.stringify(await f.record()), new RegExp(grant.token));
  const evidenceDir = await agents.storage.directory(id, "development/verification");
  for (const file of await readdir(evidenceDir)) assert.doesNotMatch(await readFile(join(evidenceDir, file), "utf8"), new RegExp(grant.token));
  const rotated = await agents.gateway.configure(id, { actionIds: ["normalize"], deliveryVersion });
  assert.equal(rotated.verification.status, "passed");
  await assert.rejects(agents.verifyGatewayAcceptance({ agentId: id, deliveryVersion, evidence: { grantId: privateGrant.grantId,
    actionIds: ["normalize"], mode: "actual", status: "passed" } }), /授权已变化/);
  assert.equal(item(await f.record(), "gateway").status, "passed");
  await agents.gateway.revoke(id); const revoked = await f.record();
  assert.equal(revoked.delivery, "needs_connection"); assert.equal(item(revoked, "gateway").status, "not_run"); assert.equal((await agents.gateway.config(id)).enabled, false);
  await assert.rejects(agents.verifyGatewayAcceptance({ agentId: id, deliveryVersion: "old-version", evidence: { mode: "actual", status: "passed" } }), /版本已变化/);
  assert.equal(item(await f.record(), "gateway").status, "not_run");
});

test("本机网关实际目录检查失败记录failed，不冒充尚未配置，也不阻断独立内部动作", { timeout: 30000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const { agents } = f, descriptor = await agents.applications.descriptor(id), deliveryVersion = descriptor.deliveryVersion;
  const handle = agents.gateway.handle.bind(agents.gateway);
  agents.gateway.handle = async (agentId, request, response) => {
    if (new URL(request.url, "http://127.0.0.1").pathname.endsWith("/actions")) {
      await agents.gateway.authenticate(agentId, request);
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ deliveryVersion, actions: [] })); return;
    }
    return handle(agentId, request, response);
  };
  const grant = await agents.gateway.configure(id, { actionIds: ["normalize"], deliveryVersion });
  agents.gateway.handle = handle;
  assert.equal(grant.verification.status, "failed");
  const record = await f.record(), gateway = record.acceptanceLedger.items.find((item) => item.acceptanceId === "gateway");
  assert.equal(gateway.status, "failed"); assert.equal(record.delivery, "needs_connection");
  assert.throws(() => assertAcceptanceComplete(record.acceptanceLedger, { architecture: record.architecture, plan: record.plan,
    codeHash: record.package.codeHash, stageScope: ["development", "activation"], allowPendingActivationAdapters: ["host-gateway"] }));
  const task = await agents.applications.submit(id, { actionId: "normalize", input: { text: "internal still works" }, mutationId: "after-gateway-failure", deliveryVersion });
  assert.deepEqual((await agents.applications.wait(id, task.taskId)).result, output("INTERNAL STILL WORKS"));
  assert.equal((await agents.gateway.verify(id, await agents.gateway.record(id), grant.token)).status, "passed");
  assert.equal((await f.record()).acceptanceLedger.items.find((item) => item.acceptanceId === "gateway").status, "passed");
});

test("真实工作回复后的独立对话验收只更新触发场景，故障及不相关轮次不丢回复或抹掉旧通过", { timeout: 30000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const send = (message) => f.agents.prompt({ agentId: id, sessionId: "acceptance-conversation-session", message });
  assert.equal((await send("执行小写 abc")).reply, "实际转换为 ABC，完整文件已保存。");
  const actionReview = JSON.parse(f.state.prompts.findLast((item) => item.submit === "submit_conversation_verification").message);
  assert.match(actionReview.observation.toolEvidence, /run_application_action/);
  const first = await send("没有提供材料"); assert.equal(first.status, "complete"); assert.equal(first.reply, "请提供要处理的文字材料。");
  const missingReview = JSON.parse(f.state.prompts.findLast((item) => item.submit === "submit_conversation_verification").message);
  assert.doesNotMatch(missingReview.observation.toolEvidence, /run_application_action/, "上轮工具回执不能当成本轮观察");
  let record = await f.record(); assert.equal(record.acceptanceLedger.items.find((item) => item.acceptanceId === "missing").status, "passed");
  const firstEvidence = record.acceptanceLedger.items.find((item) => item.acceptanceId === "missing").evidence;
  await send("你好"); record = await f.record();
  assert.deepEqual(record.acceptanceLedger.items.find((item) => item.acceptanceId === "missing").evidence, firstEvidence);
  f.state.reviewFails = true;
  const last = await send("没有提供材料"); assert.equal(last.status, "complete"); assert.equal(last.reply, "请提供要处理的文字材料。");
  record = await f.record(); assert.deepEqual(record.acceptanceLedger.items.find((item) => item.acceptanceId === "missing").evidence, firstEvidence);
  f.state.reviewFails = false;
  const write = f.agents.storage.writeJson.bind(f.agents.storage);
  f.agents.storage.writeJson = async (agentId, file, ...args) => {
    if (file.startsWith("development/verification/conversation_")) throw new Error("fixture observation persistence failure");
    return write(agentId, file, ...args);
  };
  assert.equal((await send("没有提供材料")).reply, "请提供要处理的文字材料。", "独立验收记录写盘失败不应丢失已完成的正常回复");
  f.agents.storage.writeJson = write;
  assert.deepEqual((await f.record()).acceptanceLedger.items.find((item) => item.acceptanceId === "missing").evidence, firstEvidence);
  const { activities } = await f.agents.activitySnapshot(); assert.equal(activities[0].status, "complete");
});

test("explicit验收台账缺失或旧版本不能绕过激活门槛", { timeout: 30000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const original = await f.record();
  for (const mutate of [(record) => { delete record.acceptanceLedger; },
    (record) => { record.acceptanceLedger.binding.codeHash = "0".repeat(64); },
    (record) => { record.acceptanceLedger.items.find((entry) => entry.acceptanceId === "static").evidence = null; },
    (record) => { record.acceptanceLedger.items.find((entry) => entry.acceptanceId === "static").evidence.codeHash = "0".repeat(64); }]) {
    const record = structuredClone(original); mutate(record);
    await assert.rejects(f.agents.activateDevelopment(record, new AbortController().signal));
  }
  assert.equal((await f.agents.requireAgent(id)).developmentRef.codeHash, original.package.codeHash);
  assert.throws(() => assertAcceptanceComplete(original.acceptanceLedger, { architecture: original.architecture, plan: original.plan,
    codeHash: "0".repeat(64), stageScope: ["development", "activation"], allowPendingActivationAdapters: ["host-gateway"] }));
  const current = f.agents.getArchitecture.bind(f.agents);
  f.agents.getArchitecture = async (...args) => {
    const changed = structuredClone(await current(...args));
    changed.runtimeCapabilities.methods["files.write"].returns.integrity.sha256 = "changed frozen host contract";
    return changed;
  };
  await assert.rejects(f.agents.activateDevelopment(original, new AbortController().signal), /实际通过证据/);
});

const hostFault = source.replace("return {normalized,length:normalized.length,error:'',artifact:'result.txt'};",
  "if(file.integrity)return {normalized:'BROKEN',length:6,error:'',artifact:'result.txt'};return {normalized,length:normalized.length,error:'',artifact:'result.txt'};");
async function rebuild(f, goal) {
  const draft = structuredClone(f.result.agent.draft); draft.goal.value = goal;
  return f.agents.build({ id, name: "转换验收测试", draft });
}

for (const stage of ["history", "service"]) test(`激活末端${stage}失败撤销新版就绪状态并保留可执行旧版`, { timeout: 30000 }, async (t) => {
  const f = await fixture(t, { managed: stage === "service" }); if (!f) return;
  const previous = f.agents.agents.get(id), previousRecord = await f.record();
  if (stage === "history") {
    const remember = f.agents.rememberDelivery.bind(f.agents);
    f.agents.rememberDelivery = async (agent, ...args) => {
      if (agent.developmentRef.id !== previous.developmentRef.id) throw new Error("fixed new-history persistence failure");
      return remember(agent, ...args);
    };
  } else {
    const activate = f.agents.services.activate.bind(f.agents.services);
    f.agents.services.activate = async (options) => {
      if (options.deliveryVersion !== `${previous.developmentRef.id}:${previous.execution.codeHash}`)
        throw new Error("fixed new-service activation failure");
      return activate(options);
    };
  }
  const failed = await rebuild(f, `固定更新：激活末端${stage}失败必须完整撤销`);
  assert.equal(failed.development.status, "failed"); assert.equal(failed.development.delivery, "blocked");
  assert.equal(failed.architecture.delivery, "blocked"); assert.equal(failed.architecture.developmentRef, undefined);
  assert.deepEqual(f.agents.agents.get(id).developmentRef, previous.developmentRef);
  assert.equal(await f.agents.storage.readJson(id, "application/activation.json"), null);
  const active = await f.agents.getActiveRuntime(id);
  assert.equal(active.development.id, previous.developmentRef.id);
  assert.deepEqual((await f.agents.development.store.getRun(previousRecord.id)).package, previousRecord.package);
  const descriptor = await f.agents.applications.descriptor(id);
  const submitted = await f.agents.applications.submit(id, { actionId: "normalize", input: { text: "still old" },
    mutationId: `old_version_after_${stage}_failure`, deliveryVersion: descriptor.deliveryVersion });
  const task = await f.agents.applications.wait(id, submitted.taskId);
  assert.equal(task.status, "completed"); assert.deepEqual(task.result, output("STILL OLD"));
});

test("最终激活确认保存失败撤销已完成的新研发记录和对应交付，不影响旧版实际执行", { timeout: 30000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const previous = await f.agents.get(id), previousRecord = await f.record();
  const write = f.agents.storage.writeJson.bind(f.agents.storage); let injected = 0;
  f.agents.storage.writeJson = async (agentId, path, value, ...args) => {
    if (path === "application/activation.json" && value.status === "completed") { injected++; throw new Error("fixed final marker failure"); }
    return write(agentId, path, value, ...args);
  };
  await assert.rejects(rebuild(f, "固定更新：最终激活确认保存失败"), { reason: "activation_commit_failed" });
  const failed = await f.agents.development.store.get(id);
  assert.equal(injected, 1); assert.equal(failed.status, "failed"); assert.equal(failed.delivery, "blocked");
  assert.equal(failed.diagnostic.reason, "activation_not_committed"); assert.equal(failed.deliveries.at(-1).status, "blocked");
  assert.equal(failed.deliveries.at(-1).package.id, failed.package.id);
  assert.equal((await f.agents.getArchitecture(id)).delivery, "blocked");
  assert.deepEqual((await f.agents.get(id)).developmentRef, previous.developmentRef);
  assert.deepEqual(await f.agents.development.store.getRun(previousRecord.id), previousRecord);
  assert.equal(await f.agents.storage.readJson(id, "application/activation.json"), null);
  const descriptor = await f.agents.applications.descriptor(id);
  const submitted = await f.agents.applications.submit(id, { actionId: "normalize", input: { text: "old remains" },
    mutationId: "old_after_final_marker_failure", deliveryVersion: descriptor.deliveryVersion });
  assert.deepEqual((await f.agents.applications.wait(id, submitted.taskId)).result, output("OLD REMAINS"));
});

test("研发成功记录已写入但激活确认前取消仍撤销新版，不返回假就绪", { timeout: 30000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const previous = await f.agents.get(id), controller = new AbortController(), draft = structuredClone(f.result.agent.draft);
  draft.goal.value = "固定更新：最终激活确认前取消";
  await assert.rejects(f.agents.build({ id, name: "转换验收测试", draft }, { signal: controller.signal,
    onProgress(event) { if (event.development?.status === "completed") controller.abort(); } }), (error) => error.diagnostic?.reason === "cancelled");
  const cancelled = await f.agents.development.store.get(id);
  assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.delivery, "blocked");
  assert.equal(cancelled.deliveries.at(-1).status, "blocked"); assert.equal(cancelled.diagnostic.reason, "cancelled");
  assert.deepEqual((await f.agents.get(id)).developmentRef, previous.developmentRef);
  assert.equal(await f.agents.storage.readJson(id, "application/activation.json"), null);
  assert.equal((await f.agents.getActiveRuntime(id)).development.id, previous.developmentRef.id);
});

test("激活撤销持续保存失败保留绑定事务并禁止假成功续接，恢复可重试且不重放业务", { timeout: 30000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const previous = await f.agents.get(id), previousRecord = await f.record(), write = f.agents.storage.writeJson.bind(f.agents.storage);
  let failRecords = false;
  f.agents.storage.writeJson = async (agentId, path, value, ...args) => {
    if (path === "application/activation.json" && value.status === "completed") { failRecords = true; throw new Error("fixed marker failure"); }
    if (failRecords && path.startsWith("development/records/") && value.id !== previousRecord.id) throw new Error("fixed record write failure");
    return write(agentId, path, value, ...args);
  };
  await assert.rejects(rebuild(f, "固定更新：撤销保存失败后需要恢复核对"), { reason: "activation_recovery_required" });
  const incomplete = await f.agents.development.store.get(id), pending = await f.agents.storage.readJson(id, "application/activation.json");
  assert.equal(incomplete.status, "completed", "持续存储故障确实发生在成功记录已写入之后");
  assert.equal(pending.status, "preparing"); assert.equal(pending.developmentBinding.packageId, incomplete.package.id);
  assert.deepEqual(pending.developmentBinding.architectureRef, incomplete.architectureRef);
  assert.equal((await f.agents.getDevelopment(id)).delivery, "blocked");
  assert.deepEqual((await f.agents.get(id)).developmentRef, previous.developmentRef);
  const calls = f.state.prompts.length;
  await assert.rejects(f.agents.develop(id, { resume: true }), { reason: "activation_recovery_required" });
  assert.equal(f.state.prompts.length, calls);
  await f.agents.close();
  const blocked = new PrototypeAgents({ config: { llmConfigured: true }, cwd: f.agents.cwd, dataDir: f.agents.dataDir,
    storage: f.agents.storage, sessionFactory: modelFactory(f.state), fidelityChecker: fidelityChecker() });
  await assert.rejects(blocked.ready, /研发记录未能保存/u);
  assert.deepEqual(await blocked.storage.readJson(id, "application/activation.json"), pending);
  assert.equal((await blocked.getDevelopment(id)).delivery, "blocked");
  await assert.rejects(blocked.close());
  f.agents.storage.writeJson = write;
  const restored = new PrototypeAgents({ config: { llmConfigured: true }, cwd: f.agents.cwd, dataDir: f.agents.dataDir,
    sessionFactory: modelFactory(f.state), fidelityChecker: fidelityChecker() });
  t.after(() => restored.close()); await restored.ready;
  const recovered = await restored.development.store.getRun(incomplete.id);
  assert.equal(recovered.status, "failed"); assert.equal(recovered.delivery, "blocked"); assert.equal(recovered.deliveries.at(-1).status, "blocked");
  assert.deepEqual(recovered.budgets, incomplete.budgets); assert.deepEqual(recovered.reports, incomplete.reports);
  assert.deepEqual(await restored.development.store.getRun(previousRecord.id), previousRecord);
  assert.equal((await restored.getActiveRuntime(id)).development.id, previousRecord.id);
  assert.equal(await restored.storage.readJson(id, "application/activation.json"), null);
  assert.equal(f.state.prompts.length, calls, "故障恢复不重新调用模型或重放业务动作");
});

test("已完成研发的未完成激活在重启时撤销，不把已写入的成功状态当作提交完成", { timeout: 30000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const previousRecord = await f.record(), next = await rebuild(f, "固定更新：已完成研发仍可能未确认激活");
  const completed = await f.agents.development.store.getRun(next.development.id);
  const pending = { ...await f.agents.storage.readJson(id, "application/activation.json"), status: "preparing" };
  await f.agents.storage.writeJson(id, "application/activation.json", pending);
  const memory = "激活待核对期间补充的记忆", profile = { name: "恢复前修改的名称", description: "这份展示资料必须保留", icon: "✨" };
  await f.agents.setMemory(id, memory); await f.agents.setProfile(id, profile); await f.agents.close();
  const restored = new PrototypeAgents({ config: { llmConfigured: true }, cwd: f.agents.cwd, dataDir: f.agents.dataDir,
    sessionFactory: modelFactory(f.state), fidelityChecker: fidelityChecker() });
  t.after(() => restored.close()); await restored.ready;
  const failed = await restored.development.store.getRun(completed.id);
  assert.equal(failed.status, "failed"); assert.equal(failed.delivery, "blocked"); assert.equal(failed.deliveries.at(-1).status, "blocked");
  assert.deepEqual(failed.reports, completed.reports); assert.deepEqual(failed.budgets, completed.budgets);
  assert.equal((await restored.getActiveRuntime(id)).development.id, previousRecord.id);
  assert.deepEqual(await restored.development.store.getRun(previousRecord.id), previousRecord);
  assert.equal((await restored.getMemory(id)).memory, memory); assert.deepEqual((await restored.get(id)).profile, profile);
});

for (const fault of ["binding", "record"]) test(`旧激活事务先保存真实绑定再恢复，${fault}单次写入失败后第二次启动仍能完成`, { timeout: 30000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const previousRecord = await f.record(), next = await rebuild(f, "固定更新：旧事务恢复允许重试");
  const record = await f.agents.development.store.getRun(next.development.id), transaction = await f.agents.storage.readJson(id, "application/activation.json");
  const { developmentBinding, ...legacy } = transaction; legacy.status = "preparing";
  await f.agents.storage.writeJson(id, "application/activation.json", legacy);
  const definition = await f.agents.storage.readJson(id, "definition.json"), calls = f.state.prompts.length;
  await f.agents.close();
  const write = f.agents.storage.writeJson.bind(f.agents.storage); let failures = 0;
  f.agents.storage.writeJson = async (agentId, path, value, ...args) => {
    if (!failures && (fault === "binding" ? path === "application/activation.json" && value.developmentBinding
      : path === `development/records/${record.id}.json` && value.diagnostic?.reason === "activation_not_committed")) {
      failures++; throw new Error("fixed one-shot recovery write failure");
    }
    return write(agentId, path, value, ...args);
  };
  const interrupted = new PrototypeAgents({ config: { llmConfigured: true }, cwd: f.agents.cwd, dataDir: f.agents.dataDir,
    storage: f.agents.storage, sessionFactory: modelFactory(f.state), fidelityChecker: fidelityChecker() });
  await assert.rejects(interrupted.ready); assert.equal(failures, 1);
  const pending = await f.agents.storage.readJson(id, "application/activation.json");
  assert.equal(pending.status, "preparing");
  if (fault === "binding") {
    assert.deepEqual(await f.agents.storage.readJson(id, "definition.json"), definition);
    assert.equal(pending.developmentBinding, undefined, "绑定尚未持久化时不改活动定义");
  } else {
    assert.deepEqual(pending.developmentBinding, developmentBinding);
    assert.equal((await f.agents.storage.readJson(id, "definition.json")).agent.developmentRef.id, previousRecord.id);
  }
  await assert.rejects(interrupted.close());
  const restored = new PrototypeAgents({ config: { llmConfigured: true }, cwd: f.agents.cwd, dataDir: f.agents.dataDir,
    storage: f.agents.storage, sessionFactory: modelFactory(f.state), fidelityChecker: fidelityChecker() });
  t.after(() => restored.close()); await restored.ready;
  const recovered = await restored.development.store.getRun(record.id);
  assert.equal(recovered.status, "failed"); assert.equal(recovered.delivery, "blocked"); assert.equal(recovered.deliveries.at(-1).status, "blocked");
  assert.deepEqual(recovered.budgets, record.budgets); assert.deepEqual(recovered.reports, record.reports);
  assert.deepEqual(await restored.development.store.getRun(previousRecord.id), previousRecord);
  assert.equal((await restored.getActiveRuntime(id)).development.id, previousRecord.id);
  assert.equal(await restored.storage.readJson(id, "application/activation.json"), null);
  assert.equal(f.state.prompts.length, calls);
});

for (const managed of [false, true]) test(`${managed ? "受管" : "内置"}已内部可用的同一交付继续时不重研，实际配置后可直接就绪`, { timeout: 30000 }, async (t) => {
  const f = await fixture(t, { managed }); if (!f) return;
  const original = await f.record(), architecture = await f.agents.getArchitecture(id), active = await f.agents.getActiveRuntime(id);
  assert.equal(original.delivery, "needs_connection"); assert.equal(active.development.id, original.id);
  const write = f.agents.storage.writeJson.bind(f.agents.storage); let markerWrites = 0;
  f.agents.storage.writeJson = async (agentId, path, value, ...args) => {
    if (path === "application/activation.json" && value.status === "completed") { markerWrites++; throw new Error("fixed same-delivery marker trap"); }
    return write(agentId, path, value, ...args);
  };
  const calls = f.state.prompts.length, result = await f.agents.develop(id, { resume: true });
  assert.equal(markerWrites, 0); assert.equal(f.state.prompts.length, calls); assert.deepEqual(await f.record(), original);
  assert.equal(result.development.id, original.id); assert.equal(result.development.delivery, "needs_connection");
  assert.deepEqual(await f.agents.getArchitecture(id), architecture);
  assert.equal((await f.agents.getActiveRuntime(id)).development.id, original.id);
  const descriptor = await f.agents.applications.descriptor(id);
  const submitted = await f.agents.applications.submit(id, { actionId: "normalize", input: { text: "same active" },
    mutationId: "same_delivery_resume", deliveryVersion: descriptor.deliveryVersion });
  assert.deepEqual((await f.agents.applications.wait(id, submitted.taskId)).result, output("SAME ACTIVE"));
  const configured = await f.agents.gateway.configure(id, { actionIds: ["normalize"], deliveryVersion: descriptor.deliveryVersion });
  assert.equal(configured.verification.status, "passed"); assert.equal((await f.record()).delivery, "ready");
  const configuredRecord = await f.record();
  assert.equal((await f.agents.develop(id, { resume: true })).development.delivery, "ready");
  assert.deepEqual(await f.record(), configuredRecord); assert.equal(markerWrites, 0); assert.equal(f.state.prompts.length, calls);
});

test("同一交付快速续接必须匹配当前架构、代码、计划和活动身份，未激活旧执行协议仍走原流程", { timeout: 30000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const record = await f.record(), architecture = await f.agents.getArchitecture(id), previous = f.agents.agents.get(id);
  const run = f.agents.development.run.bind(f.agents.development), get = f.agents.development.store.get.bind(f.agents.development.store);
  const stopped = { ...record, status: "blocked", delivery: "blocked" }; let runs = 0;
  f.agents.development.run = async () => { runs++; return structuredClone(stopped); };
  try {
    const changed = [
      ["record", (value) => { value.architectureRef.candidateHash = "0".repeat(64); }],
      ["record", (value) => { value.package.codeHash = "0".repeat(64); }],
      ["record", (value) => { value.planHash = "0".repeat(64); }],
      ["record", (value) => { value.package.runtime = "node-json"; }],
      ["definition", (value) => { value.developmentRef.id = "dev_other_active"; }],
      ["architecture", (value) => { value.version++; }],
    ];
    for (const [target, change] of changed) {
      const candidate = structuredClone(record), definition = structuredClone(previous), design = structuredClone(architecture);
      change(target === "record" ? candidate : target === "definition" ? definition : design);
      f.agents.development.store.get = async () => candidate; f.agents.agents.set(id, definition);
      const before = runs;
      assert.equal((await f.agents.executeDevelopment(design, { resume: true })).status, "blocked");
      assert.equal(runs, before + 1, "绑定不同或旧协议不能借用活动交付的快速路径");
    }
  } finally {
    f.agents.development.run = run; f.agents.development.store.get = get; f.agents.agents.set(id, previous);
  }
});

test("陈旧激活事务不能在重启时覆盖后来的活动版本，也不能撤销另一绑定的研发产物", { timeout: 30000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  await rebuild(f, "固定更新：留下旧激活事务");
  const stale = { ...await f.agents.storage.readJson(id, "application/activation.json"), status: "preparing" };
  const latest = await rebuild(f, "固定更新：后来的有效交付");
  const record = await f.agents.development.store.getRun(latest.development.id), definition = await f.agents.storage.readJson(id, "definition.json");
  const architecture = await f.agents.getArchitecture(id);
  for (const binding of [{ ...stale.developmentBinding, id: record.id }, { ...stale.developmentBinding, packageId: record.package.id }])
    await assert.rejects(f.agents.rollbackDevelopmentActivation(id, binding), { reason: "activation_recovery_binding_mismatch" });
  assert.deepEqual(await f.agents.development.store.getRun(record.id), record);
  await f.agents.storage.writeJson(id, "application/activation.json", stale); await f.agents.close();
  const restored = new PrototypeAgents({ config: { llmConfigured: true }, cwd: f.agents.cwd, dataDir: f.agents.dataDir,
    sessionFactory: modelFactory(f.state), fidelityChecker: fidelityChecker() });
  await assert.rejects(restored.ready, { reason: "activation_recovery_binding_mismatch" });
  assert.deepEqual(await restored.storage.readJson(id, "definition.json"), definition);
  assert.deepEqual(await restored.getArchitecture(id), architecture);
  assert.deepEqual(await restored.development.store.getRun(record.id), record);
  assert.deepEqual(await restored.storage.readJson(id, "application/activation.json"), stale);
  await assert.rejects(restored.close());
});

test("撤销研发状态的保存沿用版本校验，不能覆盖读取之后出现的新记录", { timeout: 30000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const record = await f.record(), binding = (await f.agents.storage.readJson(id, "application/activation.json")).developmentBinding;
  const save = f.agents.development.store.save.bind(f.agents.development.store); let later;
  f.agents.development.store.save = async (value, ...args) => {
    if (value.diagnostic?.reason === "activation_not_committed") {
      later = await save({ ...record, summary: "固定并发写入：较新的记录必须保留" });
    }
    return save(value, ...args);
  };
  await assert.rejects(f.agents.rollbackDevelopmentActivation(id, binding), { code: "DEVELOPMENT_REVISION_CONFLICT" });
  assert.deepEqual(await f.agents.development.store.getRun(record.id), later);
  assert.equal(later.status, "completed"); assert.equal(later.delivery, record.delivery);
});

test("激活撤销必须精确绑定版本、候选和研发编号，不覆盖后来的架构状态", { timeout: 30000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const current = await f.agents.getArchitecture(id), record = await f.record();
  const read = f.agents.getArchitecture.bind(f.agents), save = f.agents.architecture.save.bind(f.agents.architecture);
  try {
    for (const update of [{ version: current.version + 1 }, { candidateHash: "0".repeat(64) },
      { developmentRef: { ...current.developmentRef, id: "dev_later_delivery" } }]) {
      const later = { ...structuredClone(current), ...update }; let writes = 0;
      f.agents.getArchitecture = async () => structuredClone(later);
      f.agents.architecture.save = async () => { writes++; };
      await f.agents.rollbackArchitectureActivation(record);
      assert.equal(writes, 0);
      assert.deepEqual(await f.agents.getArchitecture(id), later);
    }
  } finally { f.agents.getArchitecture = read; f.agents.architecture.save = save; }
});

test("重启恢复未完成激活时同步撤销新版就绪状态，旧版仍可执行", { timeout: 30000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const previous = structuredClone(f.agents.agents.get(id)), previousProfile = await f.agents.connections.getActiveProfile(id);
  const next = await rebuild(f, "固定更新：模拟激活末尾中断后的重启恢复");
  assert.equal(next.development.status, "completed");
  const pending = await f.agents.development.store.getRun(next.development.id);
  pending.status = "running"; await f.agents.development.store.save(pending);
  await f.agents.storage.writeJson(id, "application/activation.json", { status: "preparing", prior: previous, previousProfile,
    deliveryVersion: `${next.development.id}:${next.agent.execution.codeHash}` });
  await f.agents.close();
  const restored = new PrototypeAgents({ config: { llmConfigured: true }, cwd: f.agents.cwd, dataDir: f.agents.dataDir,
    sessionFactory: modelFactory(f.state), fidelityChecker: fidelityChecker() });
  t.after(() => restored.close());
  await restored.ready;
  assert.deepEqual(restored.agents.get(id).developmentRef, previous.developmentRef);
  const latest = await restored.getArchitecture(id);
  assert.equal(latest.delivery, "blocked"); assert.equal(latest.developmentRef, undefined);
  assert.equal(await restored.storage.readJson(id, "application/activation.json"), null);
  assert.equal((await restored.development.store.getRun(next.development.id)).status, "interrupted");
  const descriptor = await restored.applications.descriptor(id);
  const submitted = await restored.applications.submit(id, { actionId: "normalize", input: { text: "restored old" },
    mutationId: "old_version_after_restart_recovery", deliveryVersion: descriptor.deliveryVersion });
  const task = await restored.applications.wait(id, submitted.taskId);
  assert.equal(task.status, "completed"); assert.deepEqual(task.result, output("RESTORED OLD"));
});

test("真实host-business失败进入原开发修复，旧版保留，修改后重新真实通过才激活", { timeout: 30000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const original = await f.record(), oldCodeHash = original.package.codeHash, attempts = [];
  f.state.planSummary = "新的固定计划：验证真实宿主差异的修复链";
  f.state.sourceForTask = (task) => task.id.startsWith("integration_") ? source + "\n// repaired fixed candidate\n" : hostFault;
  const activate = f.agents.activateDevelopment.bind(f.agents);
  f.agents.activateDevelopment = async (record, signal) => {
    const result = await activate(record, signal);
    attempts.push({ codeHash: record.package.codeHash, repaired: Boolean(result.repair), result });
    if (result.repair) {
      assert.equal(f.agents.agents.get(id).developmentRef.codeHash, oldCodeHash, "失败候选不得替换旧活动定义");
      assert.equal(result.repair.status, "failed");
      assert.ok(result.repair.results.some((entry) => entry.reason === "activation_assertion_mismatch"));
    }
    return result;
  };
  const built = await rebuild(f, "固定更新：真实宿主失败必须修复和重验");
  assert.equal(built.development.status, "completed", JSON.stringify(built.development));
  assert.deepEqual(attempts.map((entry) => entry.repaired), [true, false]);
  assert.notEqual(attempts[0].codeHash, attempts[1].codeHash); assert.notEqual(built.agent.developmentRef.codeHash, oldCodeHash);
  const current = await f.agents.development.store.getRun(built.development.id);
  assert.equal(current.tasks.filter((task) => task.integration).length, 1);
  assert.equal(current.budgets.integrationRepairs, original.budgets.integrationRepairs - 1);
  assert.ok(current.deliveries.some((entry) => entry.status === "defective" && entry.failureReportId));
  assert.ok(current.reports.some((report) => report.mode === "runtime" && report.status === "failed" && report.codeHash === attempts[0].codeHash));
  const business = current.acceptanceLedger.items.find((entry) => entry.acceptanceId === "business");
  assert.equal(business.status, "passed");
  const evidence = await f.agents.storage.readJson(id, `development/verification/${business.evidence.evidenceId}.json`);
  assert.equal(evidence.observation.report.codeHash, built.agent.developmentRef.codeHash);
  assert.equal(evidence.observation.report.status, "passed");
  assert.ok(evidence.observation.report.results.every((entry) => entry.actionExecuted));
  const staticItem = current.acceptanceLedger.items.find((entry) => entry.acceptanceId === "static");
  assert.equal(staticItem.evidence.codeHash, built.agent.developmentRef.codeHash);
  assert.equal(staticItem.evidence.planHash, current.planHash);
});

test("真实宿主错误未修复时耗尽原修复预算也不激活，旧活动版仍可真实执行", { timeout: 30000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const old = f.result.agent.developmentRef, attempts = [];
  f.state.sourceForTask = () => hostFault;
  const activate = f.agents.activateDevelopment.bind(f.agents);
  f.agents.activateDevelopment = async (...args) => { const value = await activate(...args); attempts.push(value); return value; };
  const failed = await rebuild(f, "固定更新：不能用耗尽预算放行真实宿主错误");
  assert.equal(failed.development.status, "failed");
  assert.deepEqual(failed.agent.developmentRef, old);
  assert.ok(attempts.length > 1 && attempts.every((entry) => entry.repair?.status === "failed"));
  const record = await f.agents.development.store.getRun(failed.development.id);
  assert.equal(record.budgets.integrationRepairs, 0); assert.ok(record.deliveries.every((entry) => entry.status !== "activated"));
  const descriptor = await f.agents.applications.descriptor(id);
  assert.equal(descriptor.agent.developmentRef.codeHash, old.codeHash);
  const submitted = await f.agents.applications.submit(id, { actionId: "normalize", input: { text: "still old" }, mutationId: "old_version_after_failed_repair", deliveryVersion: descriptor.deliveryVersion });
  const task = await f.agents.applications.wait(id, submitted.taskId);
  assert.equal(task.status, "completed"); assert.deepEqual(task.result, output("STILL OLD"));
});

test("真实Node输出契约错误同样反馈开发修复，保留实际错误输出且重验后才激活", { timeout: 30000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const invalidOutput = source.replace("return {normalized,length:normalized.length,error:'',artifact:'result.txt'};",
    "if(file.integrity)return {normalized,length:'wrong-type',error:'',artifact:'result.txt'};return {normalized,length:normalized.length,error:'',artifact:'result.txt'};");
  f.state.sourceForTask = (task) => task.id.startsWith("integration_") ? source + "\n// output contract repaired\n" : invalidOutput;
  const activate = f.agents.activateDevelopment.bind(f.agents), repairs = [];
  f.agents.activateDevelopment = async (...args) => {
    const result = await activate(...args);
    if (result.repair) {
      repairs.push(result.repair);
      assert.equal(f.agents.agents.get(id).developmentRef.codeHash, f.result.agent.developmentRef.codeHash);
    }
    return result;
  };
  const built = await rebuild(f, "固定更新：输出契约错误必须进入修复");
  assert.equal(built.development.status, "completed", JSON.stringify(built.development));
  assert.equal(repairs.length, 1);
  const failed = repairs[0].results.find((entry) => entry.caseId === "case_valid");
  assert.equal(failed.status, "failed"); assert.equal(failed.reason, "action_output_schema_mismatch");
  assert.equal(failed.actionExecuted, true); assert.equal(failed.actual.length, "wrong-type");
  const record = await f.agents.development.store.getRun(built.development.id);
  assert.equal(record.acceptanceLedger.items.find((entry) => entry.acceptanceId === "business").status, "passed");
});

test("delivery-review在真实controller拒绝旧计划或旧代码的独立评审，候选不得打包激活", { timeout: 30000 }, async (t) => {
  for (const kind of ["plan", "integration"]) await t.test(kind, async (t) => {
    const f = await fixture(t); if (!f) return;
    const old = await f.record(), review = f.agents.development.review.bind(f.agents.development);
    f.state.planSummary = `new fixed plan for ${kind}`; f.state.sourceForTask = () => source + "\n// current candidate code\n";
    f.agents.development.review = async (ctx, mode, payload, snapshot) => {
      const result = await review(ctx, mode, payload, snapshot);
      if (mode === kind) {
        const saved = ctx.record.reviews.at(-1);
        if (kind === "plan") saved.planHash = old.planHash;
        else saved.codeHash = old.package.codeHash;
      }
      return result;
    };
    const failed = await rebuild(f, `固定更新：拒绝陈旧${kind}评审`);
    assert.equal(failed.development.status, "failed");
    assert.deepEqual(failed.agent.developmentRef, f.result.agent.developmentRef);
    const record = await f.agents.development.store.getRun(failed.development.id);
    assert.equal(record.package, null); assert.match(record.summary, /独立评审/);
  });
});
