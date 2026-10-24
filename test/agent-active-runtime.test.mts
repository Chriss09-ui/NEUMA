import {fixtureTools,callFixture} from "./helpers/m7-test-boundaries.mjs";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import type { PiSessionOptions } from "../src/runtime/pi-port.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrototypeAgents } from "../src/agents/agent-prototype.mjs";
import { CAPABILITIES } from "../src/architecture/architecture-contract.mjs";
import { validDraft, validDesign, passingReview } from "./helpers/architecture.mjs";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "neuma-active-version-"));
  const factory = async (options: PiSessionOptions) => ({ messages: [], subscribe: () => () => {}, dispose() {}, abort() {}, getLastAssistantText: () => "旧版仍可运行。",
    async prompt(message: string) {
      const tools=fixtureTools(options.customTools!),designer = tools.submit_architecture, reviewer = tools.submit_architecture_review;
      if (designer) { const payload = JSON.parse(message); await designer.execute("design", validDesign(payload.requirements, { capabilities: CAPABILITIES.map(({ id, scope }) => ({ id, status: "available", reason: scope })) })); }
      else if (reviewer) await reviewer.execute("review", passingReview(JSON.parse(message).candidateHash));
    } });
  const options = { config: { llmConfigured: true }, cwd: root, dataDir: join(root, "data"), sessionFactory: factory };
  const agents = new PrototypeAgents(options);
  t.after(async () => { await agents.close(); await rm(root, { recursive: true, force: true }); });
  const built = await agents.build({ id: "one", name: "已有助手", draft: validDraft() });
  return { agents, options, built, factory };
}

test("升级失败后私聊恢复旧版，最新候选与已激活精确版本在重启后仍分开", async t => {
  const { agents, options, built, factory } = await fixture(t);
  agents.sessionFactory = async () => { throw new Error("controlled build failure"); };
  await assert.rejects(agents.build({ id: "one", name: "已有助手", draft: validDraft("新的目标") }));
  agents.sessionFactory = factory;
  const latest = await agents.getArchitecture("one"), active = await agents.getActiveRuntime("one");
  assert.equal(latest!.status, "failed"); assert.ok(latest!.version > active!.architecture.version);
  assert.equal(active!.architecture.version, built.agent!.architectureRef!.version);
  assert.equal((await agents.prompt({ agentId: "one", sessionId: "after-failed-upgrade-1", message: "继续旧任务" })).reply, "旧版仍可运行。");
  assert.equal((await agents.capabilityCards({ agentIds: ["one"] })).agents[0]!.ready, true);
  const collaboration = await agents.executeCollaboration({ agentId: "one", revision: built.agent!.revision, sessionId: "old-group-after-failure",
    scope: { groupId: "group-one", taskId: "task-one" }, message: "继续已有群任务", systemContext: "只处理本轮", allowBusinessTools: false });
  assert.equal(collaboration.reply, "旧版仍可运行。");
  const restored = new PrototypeAgents(options); t.after(() => restored.close());
  assert.equal((await restored.getActiveRuntime("one"))!.architecture.version, built.architecture!.version);
  assert.equal((await restored.getArchitecture("one"))!.status, "failed");
});

test("取消或研发受阻不借用新架构，构建锁仍暂停提交，错误活动引用继续拒绝", async t => {
  const { agents, built } = await fixture(t);
  for (const [index, status] of ["cancelled", "failed", "passed"].entries()) {
    await agents.architecture.save({ ...built.architecture!, version: built.architecture!.version + index + 1, status, delivery: "blocked" });
    assert.equal((await agents.getActiveArchitecture("one"))!.version, built.architecture!.version);
    assert.equal((await agents.getActiveRuntime("one"))!.architecture.version, built.architecture!.version);
  }
  callFixture(agents.builds.set,agents.builds,["one", {}]);
  await assert.rejects(agents.prompt({ agentId: "one", sessionId: "during-active-upgrade", message: "暂不执行" }), /尚未生成可运行/);
  assert.equal((await agents.capabilityCards({ agentIds: ["one"] })).agents[0]!.ready, false);
  agents.builds.delete("one");
  assert.equal((await agents.prompt({ agentId: "one", sessionId: "after-cancelled-upgrade", message: "继续" })).reply, "旧版仍可运行。");
  const original = agents.agents.get("one");
  agents.agents.set("one", { ...original!, architectureRef: { ...original!.architectureRef!, candidateHash: "wrong" } });
  assert.equal(await agents.getActiveRuntime("one"), null);
  await assert.rejects(agents.prompt({ agentId: "one", sessionId: "bad-active-reference", message: "拒绝执行" }), /尚未生成可运行/);
  agents.agents.set("one", original!);
  const source = await agents.architecture.getVersion("one", original!.architectureRef!.version);
  source!.design!.instructions += "篡改";
  assert.throws(() => agents.architecture.save(source!), /摘要不匹配/);
  agents.architecture.getVersion = async () => source;
  assert.equal(await agents.getActiveRuntime("one"), null);
  assert.equal(await agents.getActiveRuntime("never-built"), null);
});

test("精确架构读取等待期间定义被替换时，不返回先前版本的运行依据", async t => {
  const { agents } = await fixture(t);
  let enter!:()=>void, release!:()=>void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const getVersion = agents.architecture.getVersion.bind(agents.architecture);
  agents.architecture.getVersion = async (...args) => { const snapshot = await getVersion(...args); enter(); await gate; return snapshot; };
  const pending = agents.getActiveArchitecture("one");
  await entered;
  const prior = agents.agents.get("one");
  agents.agents.set("one", { ...prior!, revision: prior!.revision + 1 });
  release!();
  assert.equal(await pending, null);
  agents.architecture.getVersion = getVersion;
  assert.equal((await agents.getActiveArchitecture("one"))!.version, prior!.architectureRef!.version);
});

test("已激活应用摘要读取旧交付，构建期间仅允许查看，完成失败后动作定义恢复", async t => {
  const { agents, built } = await fixture(t), hash = "a".repeat(64), old = agents.agents.get("one");
  const ref = { id: "delivered-build", codeHash: hash, planHash: "plan-hash" };
  const valueSchema = { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };
  const manifest = { protocolVersion: 2, runtime: "node-action", entrypoint: "actions.mjs", page: { entrypoint: "ui/index.html", resources: [{ path: "ui/index.html", sha256: hash }] },
    actions: [{ id: "echo", title: "受控动作", inputSchema: valueSchema, outputSchema: valueSchema, connectionIds: [] }], stateVersion: 1, evidenceIds: ["check-one"] };
  const record = { id: ref.id, agentId: "one", architectureRef: old!.architectureRef, status: "completed", delivery: "ready", planHash: ref.planHash,
    package: { codeHash: hash, planHash: ref.planHash, application: manifest, snapshot: { hash, path: "/controlled/snapshot", files: [{ path: "actions.mjs", hash }, { path: "ui/index.html", hash }] } } };
  callFixture(agents.agents.set,agents.agents,["one", { ...old!, developmentRef: ref, execution: { kind: "node-action", buildId: ref.id, codeHash: hash }, toolIds: [...old!.toolIds!, "run_application_action"] }]);
  Object.assign(agents.development.store,{getRun:async (id:string) => id === ref.id ? record : null});
  let verified = 0; Object.assign(agents.development.workspace,{validateSnapshot:async (snapshot:unknown) => { verified++; return snapshot; }});
  await agents.architecture.save({ ...built.architecture!, version: built.architecture!.version + 1, status: "cancelled", delivery: "blocked" });
  const summary = await agents.applications.summary("one"); assert.equal(summary.pageReady, true); assert.equal(summary.deliveryVersion, `${ref.id}:${hash}`);
  let closed = 0; agents.applications.resources.closeAgent = async () => { closed++; };
  await agents.notifyLifecycle("build", "one"); assert.equal(closed, 0, "更新开始保留已验证的旧页面实例");
  callFixture(agents.builds.set,agents.builds,["one", {}]);
  try {
    assert.equal((await agents.applications.summary("one")).pageReady, true);
    assert.deepEqual((await agents.applications.state("one", summary.deliveryVersion)).state, {});
    await assert.rejects(agents.applications.descriptor("one"), /正在制作/);
    await assert.rejects(agents.applications.saveState("one", { state: { draft: "new" }, expectedVersion: 0 }), /正在制作/);
  }
  finally { agents.builds.delete("one"); }
  assert.equal(objectFields((await agents.applications.descriptor("one")).architecture).version, built.architecture!.version); assert.ok(verified > 0);
  assert.equal(objectFields((await agents.applications.saveState("one", { state: { draft: "continued" }, expectedVersion: 0, deliveryVersion: summary.deliveryVersion }))).version, 1);
  Object.assign(agents.development.executor,{runAction:async ({input}:{input:unknown}) => ({ status: "passed", output: input })});
  const submitted = await agents.applications.submit("one", { actionId: "echo", input: { value: "continued" }, mutationId: "continued-old-action", deliveryVersion: summary.deliveryVersion });
  assert.deepEqual((await agents.applications.wait("one", submitted.taskId)).result, { value: "continued" });
  ref.id = "next-delivered-build"; record.id = ref.id;
  callFixture(agents.agents.set,agents.agents,["one", { ...agents.agents.get("one"), revision: 2, developmentRef: { ...ref }, execution: { kind: "node-action", buildId: ref.id, codeHash: hash } }]);
  await assert.rejects(agents.applications.saveState("one", { state: { draft: "stale" }, expectedVersion: 1, deliveryVersion: summary.deliveryVersion }), /版本已变化/);
  record.package.codeHash = "corrupted";
  await assert.rejects(agents.applications.summary("one"), /交付与当前/);
  assert.equal(await agents.getActiveRuntime("one"), null);
  await agents.notifyLifecycle("build", "one"); assert.equal(closed, 1, "无合法活动交付时不能保留旧实例");
});
