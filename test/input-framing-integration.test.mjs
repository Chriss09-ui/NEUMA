import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApplicationService } from "../src/applications/application-service.mjs";
import { ManagedServiceManager } from "../src/services/managed-service-manager.mjs";
import { applicationTaskInput, managedRunMessage, INPUT_FRAMING_FACTS } from "../src/applications/input-framing.mjs";
import { createRequirementSystemVerifier } from "../src/agents/requirement-verification.mjs";
import { createPlatformSnapshot } from "../src/architecture/platform-contract.mjs";
import { designHash } from "../src/architecture/architecture-contract.mjs";
import { makeProviders } from "../src/requirements/providers.mjs";
import { processTurn, emptyDraft } from "../src/requirements/core.mjs";
import { RequirementSessions } from "../src/requirements/requirement-sessions.mjs";
import { advanceRequirement, prepareRequirement } from "../src/main/main-requirements.mjs";
import { validDraft } from "./helpers/architecture.mjs";
import { sufficientPreflight } from "./helpers/consultation.mjs";

const uuid = "00000000-0000-4000-8000-000000000000";
const snapshot = (agentId) => ({ agentId, version: 9, profile: "f".repeat(64), connections: [
  { id: "PRIVATE_CONNECTION_IDENTIFIER", kind: "business", version: 8, generation: uuid, grantEpoch: 1 },
] });
const object = { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };
const issue = { id: "framing", owner: "system", stage: "requirements", blocking: true, question: "核对输入封装", impact: "决定可行承载路径",
  requirementIds: ["task"], checks: ["platform.runtime"] };
const decision = { issueId: "framing", owner: "system", stage: "requirements", status: "open", reason: "宿主事实尚不等于业务验收", evidence: [] };
const blocked = async () => ({ ...await sufficientPreflight(), verdict: "blocked", issues: [issue], issueDecisions: [decision] });
const measurement = (result) => result[0].evidence.map(({ detail }) => { try { return JSON.parse(detail); } catch { return null; } })
  .find((item) => item?.type === "current_connection_framing");
async function folder(t) { const directory = await mkdtemp(join(tmpdir(), "neuma-framing-")); t.after(() => rm(directory, { recursive: true, force: true })); return directory; }

test("真实submitTask传store.create的对象与同源框架一致，保留来源及页面绑定而不附全页面快照", async () => {
  const input = { value: '中文😀\n"\\' }, connections = snapshot("agent_bound");
  const descriptor = { deliveryVersion: "dev_example:" + "a".repeat(64), agent: { revision: 5 },
    manifest: { actions: [{ id: "execute", inputSchema: object, connectionIds: [] }] } };
  for (const source of [{ kind: "application", scope: "private", gatewayGrant: uuid }, { kind: "group", scope: "group:test" }]) {
    const applicationContext = { instanceId: "page_one", deliveryVersion: descriptor.deliveryVersion, revision: 7,
      snapshot: { viewId: "view", title: "ignored", summary: "PRIVATE_PAGE_CONTENT", selection: null, values: {} } };
    let captured;
    const service = Object.assign(Object.create(ApplicationService.prototype), { epoch: 0,
      agents: { connections: { snapshot: async () => connections } }, descriptor: async () => descriptor,
      validateContext: async () => applicationContext,
      store: { create: async (id, value) => { captured = { id, value }; return { task: { id: "task_one" }, created: false }; } } });
    const body = { actionId: "execute", input, mutationId: "mutation-fixed", deliveryVersion: descriptor.deliveryVersion };
    await service.submitTask("agent_bound", body, { source, allowNetwork: false }, { epoch: 0 });
    assert.equal(captured.id, "agent_bound");
    assert.deepEqual(captured.value, applicationTaskInput({ actionId: body.actionId, input, mutationId: body.mutationId,
      source: { ...source, applicationContext: { instanceId: "page_one", deliveryVersion: descriptor.deliveryVersion, revision: 7 } },
      deliveryVersion: descriptor.deliveryVersion, revision: 5, connectionSnapshot: connections, allowNetwork: false }));
    assert.equal(captured.value.input, input); assert.equal(captured.value.connectionVersions, connections.connections);
    assert.doesNotMatch(JSON.stringify(captured), /PRIVATE_PAGE_CONTENT|viewId/);
  }
});

test("真实工作进程stdin按同源run框架发送JSON加LF，不混入版本/来源/连接字段", async (t) => {
  const rootDir = await folder(t), manager = new ManagedServiceManager({ rootDir, dockerPath: process.execPath });
  const outputSchema = { type: "object", properties: { wire: { type: "string" } }, required: ["wire"], additionalProperties: false };
  const record = { manifest: { host: "docker", language: "javascript", operations: [{ id: "execute", inputSchema: object, outputSchema }],
    capabilities: [], resources: { timeoutMs: 5000, logBytes: 65536 } } };
  manager.getRecord = async () => record;
  // Fixed trusted protocol responder exercises the real child stdin, not Docker or isolation readiness.
  manager.docker.launchArguments = () => ["--input-type=module", "--eval", `import{createInterface}from'node:readline';process.stdout.write(JSON.stringify({type:'ready',protocolVersion:1})+'\\n');createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);process.stdout.write(JSON.stringify({type:'result',requestId:m.requestId,ok:true,value:{wire:line+'\\n'}})+'\\n')})`];
  manager.docker.stop = async () => {};
  t.after(() => manager.close({ permanent: true }));
  const identity = { agentId: "agent_bound", deliveryVersion: "delivery_one", scopeId: "verify:framing" };
  await manager.startWorker({ ...identity, persist: false });
  const input = { value: '中文😀\n"\\' }, result = await manager.run({ ...identity, actionId: "execute", input });
  assert.equal(result.status, "passed");
  const wire = result.output.wire, parsed = JSON.parse(wire);
  assert.match(parsed.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(wire, JSON.stringify(managedRunMessage({ requestId: parsed.requestId, actionId: "execute", input })) + "\n");
  assert.deepEqual(Object.keys(parsed), ["type", "protocolVersion", "requestId", "actionId", "input"]);
  assert.ok(Buffer.byteLength(wire) - Buffer.byteLength(JSON.stringify(input)) <= INPUT_FRAMING_FACTS.managedRun.metadataUpperBoundBytes);
});

test("当前连接只读测量复用一次，标注版本/摘要且不泄露值或改变冻结平台", async () => {
  let reads = 0;
  const platform = createPlatformSnapshot(), hash = designHash(platform);
  const verify = createRequirementSystemVerifier({ connections: { snapshot: async (id) => { reads++; return snapshot(id); } } });
  const result = await verify({ platform, verificationContext: { agentId: "server_bound" }, issues: [issue, { ...issue, id: "second" }] });
  assert.equal(reads, 1); assert.equal(measurement(result).status, "measured"); assert.equal(measurement(result).configVersion, 9);
  assert.match(measurement(result).sha256, /^[a-f0-9]{64}$/); assert.equal(measurement(result).connectionCount, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CONNECTION_IDENTIFIER|server_bound|f{64}/);
  assert.equal(designHash(platform), hash); assert.equal(platform.version, 4);
  assert.ok(result.flatMap(({ evidence }) => evidence).every(({ detail, reference }) => detail.length <= 3000 && reference === "platform.runtime"));
});

test("无绑定/坏类型/读取错误不假定空配置，取消立即结束且原异常不泄露", async () => {
  let reads = 0;
  const platform = createPlatformSnapshot(), verify = createRequirementSystemVerifier({ connections: { snapshot: async (id) => { reads++; return snapshot(id); } } });
  assert.equal(measurement(await verify({ platform, issues: [issue] })).status, "unknown"); assert.equal(reads, 0);
  for (const connections of [{ snapshot: async () => ({ ...snapshot("server_bound"), version: "broken" }) },
    { snapshot: async () => { throw new Error("PRIVATE_READ_ERROR"); } }]) {
    const result = await createRequirementSystemVerifier({ connections })({ platform, issues: [issue], verificationContext: { agentId: "server_bound" } });
    assert.equal(measurement(result).status, "unknown"); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_READ_ERROR|broken|server_bound/);
  }
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; }), pending = new Promise((resolve) => { release = resolve; });
  const controller = new AbortController(), slow = createRequirementSystemVerifier({ connections: { snapshot: async () => { entered(); return pending; } } });
  const result = slow({ platform, issues: [issue], verificationContext: { agentId: "server_bound" }, signal: controller.signal });
  await started; controller.abort(); await assert.rejects(result, { name: "AbortError" }); release(snapshot("server_bound"));
  let legacyRead = false;
  await createRequirementSystemVerifier({ connections: { snapshot: async () => { legacyRead = true; return snapshot("server_bound"); } } })({
    platform: createPlatformSnapshot({ version: 3 }), issues: [issue], verificationContext: { agentId: "server_bound" } });
  assert.equal(legacyRead, false);
});

test("主对话绑定身份贯穿原模型/宿主预算，模型和草稿不能改写核实目标", async () => {
  const requirement = await prepareRequirement({ record: {}, conversationId: "conversation", mutationId: "new", mode: "new" }, {});
  const requests = [], seen = [], responses = [await blocked(), await blocked(), { decisions: [decision] }];
  responses[0].verificationContext = { agentId: "model_forged" };
  const providers = makeProviders({ llmConfigured: true, chatUrl: "https://model.invalid/chat", model: "fixture", apiKey: "fixture" }, async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const result = structuredClone(responses[requests.length - 1]), context = JSON.parse(requests.at(-1).messages[1].content);
    if (context.knownIssues) result.decisions[0].progress = { basisHash: context.systemBases[0].basisHash,
      proofScopeHash: context.proofScope.bindingHash, established: "已读取当前绑定智能体的封装事实。",
      missing: "当前任务的具体输入输出容量计算尚未完成。", nextAction: { kind: "calculate", detail: "按当前任务核对实际输入输出上界。" },
      unsupportedScope: { requirementId: "task", quote: context.draft.task.value, target: "required_current_behavior", detail: "仍需当前任务的容量推导，不要求未来无限配置。" } };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }), { status: 200 });
  }, { verifySystemIssues: createRequirementSystemVerifier({ connections: { snapshot: async (id) => { seen.push(id); return snapshot(id); } } }) });
  providers.generateDraft = async () => ({ draft: { ...validDraft(), taskSpec: { version: 1, items: [] }, verificationContext: { agentId: "draft_forged" } }, proposedGap: "none" });
  const preflight = providers.preflight; let diagnostic;
  providers.preflight = async (input) => { const value = await preflight(input); diagnostic = value.preflightDiagnostic; return value; };
  const result = await advanceRequirement(requirement, "创建处理助手", providers);
  assert.deepEqual(seen, [requirement.agentId]); assert.equal(requests.length, 3);
  assert.equal(diagnostic.readOnlyCalls, 1); assert.equal(diagnostic.modelTurns, 3);
  for (const body of requests) {
    const payload = JSON.parse(body.messages[1].content);
    assert.equal(Object.hasOwn(payload, "verificationContext"), false);
  }
  assert.equal(Object.hasOwn(result.requirement.draft, "verificationContext"), false);
  assert.equal(result.requirement.confirmed, false);
});

test("core仅接受服务端选项；旧会话只用已核实boundAgentId，忽略未绑定body与后续换号", async (t) => {
  const contexts = [], providers = { generateDraft: async () => ({ draft: validDraft(), proposedGap: "none" }), preflight: async (input) => {
    contexts.push(input.verificationContext); return sufficientPreflight();
  } };
  await processTurn({ message: "创建处理助手", draft: emptyDraft(), verificationContext: { agentId: "request_forged" } }, providers,
    { enforceConsultation: true, requestId: "plain", platform: createPlatformSnapshot() });
  assert.equal(contexts.pop(), undefined);
  await processTurn({ message: "创建处理助手", draft: emptyDraft(), verificationContext: { agentId: "request_forged" } }, providers,
    { enforceConsultation: true, requestId: "bound", platform: createPlatformSnapshot(), verificationContext: { agentId: "server_bound", secret: "PRIVATE_VALUE" } });
  assert.deepEqual(contexts.pop(), { agentId: "server_bound" });
  const agents = { getRequirements: async () => ({ requirements: [{ id: "server_bound", draft: validDraft() }] }) };
  const sessions = new RequirementSessions({ dataDir: await folder(t), agents }); t.after(() => sessions.close());
  await sessions.turn({ requirementSessionId: "unbound", requestId: "one", message: "创建处理助手", verificationContext: { agentId: "request_forged" },
    draft: { ...validDraft(), agentId: "draft_forged" } }, providers);
  assert.equal(contexts.pop(), undefined);
  const first = await sessions.turn({ requirementSessionId: "bound", requestId: "first", message: "修改处理助手", agentId: "server_bound" }, providers);
  assert.deepEqual(contexts.pop(), { agentId: "server_bound" });
  providers.generateDraft = async () => ({ draft: validDraft("更改后的处理任务"), proposedGap: "none" });
  await sessions.turn({ requirementSessionId: "bound", requestId: "second", requirementVersion: first.requirementVersion,
    message: "改成另一种交付格式", agentId: "request_forged", verificationContext: { agentId: "request_forged" } }, providers);
  assert.deepEqual(contexts.pop(), { agentId: "server_bound" });
});
