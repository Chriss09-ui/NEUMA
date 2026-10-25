import { fixtureString } from "../helpers/http-model.mjs";
interface DashboardElement { value: string; textContent: string; handlers: Map<string, () => Promise<unknown>>; addEventListener(name: string, fn: () => Promise<unknown>): void }
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import { failureFields } from "../helpers/failure-fields.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import { activateApplicationContext, setApplicationContext, getApplicationContext, getApplicationActionContext,
  applicationTaskEvent, releaseApplicationContext } from "../../public/application-context.js";
import { DASHBOARD_AGENT_ID, DASHBOARD_APPLICATION_SCRIPT, DASHBOARD_METRICS, startDashboardApplicationFixture } from "../helpers/dashboard-application-fixture.mjs";
import type { Server,IncomingMessage,ServerResponse } from "http";
import type { RequirementDraft,ApplicationManifest, ApplicationSnapshot } from "../../public/ui-types.js";
import type { PrototypeAgents } from "../../src/agents/agent-prototype.mjs";
import type { AgentProfile } from "../../src/agents/prototype-port.mjs";
import type { StoredArchitectureRecord } from "../../src/architecture/architecture-controller-port.mjs";
import type { AcceptanceStatus } from "../../src/contracts/verification.mjs";
import type { ArchitectureReference,DevelopmentDiagnostic } from "../../src/development/development-controller-types.mjs";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function pageFixture(f: Awaited<ReturnType<typeof startDashboardApplicationFixture>>) {
  const instance = await f.api(`${f.route}/application/open`, { method: "POST", body: {} });
  activateApplicationContext(DASHBOARD_AGENT_ID, instance);
  const nodes = new Map<string, DashboardElement>(); let listener: ((event: unknown) => Promise<unknown>) | null | undefined;
  let nextRead: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | null | undefined;
  const get = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { value: "", textContent: "", handlers: new Map(), addEventListener(name, fn) { this.handlers.set(name, fn); } });
    return nodes.get(id)!;
  };
  const api = {
    assistant: { setContext: async (snapshot: unknown) => setApplicationContext(DASHBOARD_AGENT_ID, instance.instanceId, JSON.parse(JSON.stringify(snapshot))), open: async () => ({ opened: true }) },
    state: { get: () => f.api(`${f.route}/application/state?deliveryVersion=${encodeURIComponent(instance.deliveryVersion)}`),
      save: (state: unknown, expectedVersion: unknown) => f.api(`${f.route}/application/state`, { method: "PUT", body: { state, expectedVersion, deliveryVersion: instance.deliveryVersion } }) },
    actions: { run: (actionId: string, input: unknown, options: { mutationId: string }) => f.api(`${f.route}/tasks`, { method: "POST", body: { actionId, input,
      mutationId: options.mutationId, deliveryVersion: instance.deliveryVersion, applicationContext: getApplicationActionContext(DASHBOARD_AGENT_ID) } }) },
    tasks: { subscribe: (fn: (event: unknown) => Promise<unknown>) => { listener = fn; return () => { listener = null; }; }, get: async (id: string) => {
      const result = await f.api(`${f.route}/tasks/${id}`);
      if (nextRead) { const gate = nextRead; nextRead = null; gate.entered.resolve!(); await gate.release.promise; }
      return result;
    } },
  };
  const controller = await vm.runInNewContext(DASHBOARD_APPLICATION_SCRIPT, { document: { getElementById: get }, window: { neuma: api }, crypto: { randomUUID } });
  return { get, instance, controller, notify: (event: unknown) => listener!(event), context: () => getApplicationContext(DASHBOARD_AGENT_ID),
    pauseNextRead: () => { const gate = { entered: deferred(), release: deferred() }; nextRead = gate; return gate; },
    close: async () => { releaseApplicationContext(DASHBOARD_AGENT_ID, instance.instanceId); await f.api(`${f.route}/application/close`, { method: "POST", body: { instanceId: instance.instanceId } }); } };
}

// The model is a local substitute; architecture, development, Pi, OS-isolated
// actions, HTTP and the generated page's update/state code execute for real.
test("通用看板通过真实交付和聊天动作更新页面，恢复草稿并拒绝旧筛选结果", { timeout: 45000 }, async (t) => {
  let f;
  try { f = await startDashboardApplicationFixture(); }
  catch (error) { if (failureFields(error).reason === "isolation_unavailable" && process.env.NEUMA_REQUIRE_ISOLATION !== "1") { t.skip(failureFields(error).message); return; } throw error; }
  t.after(() => f.close());
  assert.equal(f.result.development!.status, "completed"); assert.equal(f.result.agent!.execution!.kind, "node-action");
  assert.deepEqual((await f.api("/api/projects")).projects, []);
  const summary = await f.api(`${f.route}/application`);
  assert.equal(summary.defaultEntry, "application"); assert.equal(summary.assistant.enabled, true);
  assert.deepEqual<NonNullable<NonNullable<typeof f>["model"]>["errors"]>(f.model.errors, []);
  const page = await pageFixture(f);
  assert.equal(page.get("period").value, "month"); assert.equal(objectFields(objectFields(page.context()!.snapshot.values).metrics).revenue, 128400);
  const turn = (message: string, applicationContext: { instanceId: string; deliveryVersion: string; revision: number; snapshot: ApplicationSnapshot; }|undefined) => f.api("/api/agents/turn", { method: "POST", body: {
    agentId: DASHBOARD_AGENT_ID, sessionId: "dashboard-conversation-0001", message, applicationContext,
  } });
  const explanation = await turn("解释这里", page.context());
  assert.match(explanation.reply, /月度.*128400.*18420.*4\.8/s);
  assert.equal((await f.api(`${f.route}/tasks`)).tasks.length, 0);
  const before = page.context();
  const changed = await turn("切换到全年", before);
  assert.match(changed.reply, /已通过应用动作切换到全年/);
  const task = (await f.api(`${f.route}/tasks`)).tasks.at(-1);
  assert.equal(task.status, "completed"); assert.equal(task.source.kind, "conversation");
  assert.deepEqual(task.source.applicationContext, { instanceId: before!.instanceId, deliveryVersion: before!.deliveryVersion, revision: before!.revision });
  assert.equal(task.source.applicationContext.snapshot, undefined);
  assert.deepEqual(task.result.metrics, DASHBOARD_METRICS.year);
  const event = applicationTaskEvent(DASHBOARD_AGENT_ID, task);
  assert.equal(event!.stale, false); await page.notify(event);
  assert.equal(page.get("period").value, "year"); assert.match(page.get("revenue").textContent, /1,468,000/);
  assert.equal((await f.api(`${f.route}/application/state`)).state.period, "year");
  assert.equal(objectFields((await f.agents.applications.store.getState(DASHBOARD_AGENT_ID, { kind: "business" })).state).period, "year");
  assert.ok(f.model.requests.some(item => item.name === "run_application_action" && objectFields(objectFields(objectFields(item.applicationContext).snapshot).selection).period === "month"));

  await page.close();
  const restored = await pageFixture(f);
  assert.equal(restored.get("period").value, "year"); assert.match(restored.get("period-label").textContent, /全年/);
  const restoredExplanation = await turn("解释这里", restored.context());
  assert.match(restoredExplanation.reply, /全年.*1468000/s);
  const obsolete = restored.context();
  await turn("切换到全年", obsolete);
  const obsoleteTask = (await f.api(`${f.route}/tasks`)).tasks.at(-1);
  await restored.controller.selectPeriod("month");
  const staleEvent = applicationTaskEvent(DASHBOARD_AGENT_ID, obsoleteTask);
  assert.equal(staleEvent!.stale, true); await restored.notify(staleEvent);
  assert.equal(restored.get("period").value, "month"); assert.match(restored.get("status").textContent, /当前筛选保留/);

  await turn("切换到全年", restored.context());
  const lateTask = (await f.api(`${f.route}/tasks`)).tasks.at(-1), currentEvent = applicationTaskEvent(DASHBOARD_AGENT_ID, lateTask);
  assert.equal(currentEvent!.stale, false);
  const gate = restored.pauseNextRead(), pending = restored.notify(currentEvent);
  await gate.entered.promise; await restored.controller.selectPeriod("month"); gate.release.resolve!(); await pending;
  assert.equal(restored.get("period").value, "month"); assert.match(restored.get("status").textContent, /当前筛选保留/);
  assert.equal((await f.api(`${f.route}/application/state`)).state.period, "month");
  const noPage = await turn("解释这里", undefined);
  assert.match(noPage.reply, /当前页面上下文不可用/);
  assert.equal(f.model.requests.at(-1)!.applicationContext, null);
  assert.deepEqual<NonNullable<NonNullable<typeof f>["model"]>["errors"]>(f.model.errors, []);
  await restored.close();
});
