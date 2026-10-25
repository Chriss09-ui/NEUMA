import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentStorage } from "../../src/agents/agent-storage.mjs";
import { AgentScheduler } from "../../src/runtime/agent-scheduler.mjs";
import { ApplicationService } from "../../src/applications/application-service.mjs";
import type { ApplicationAgents, ApplicationResourcesPort } from "../../src/applications/application-service.mjs";
import type { ApplicationTaskStore } from "../../src/applications/task-store.mjs";
import type { WorkflowController } from "../../src/services/workflow-controller.mjs";

// R6 生命周期审计：ApplicationService.close 内 workflows/资源/存储三者互不依赖，
// 任一失败不得跳过其余收尾。夹具不启动页面或流程运行时。

test("workflows 清理失败时资源与存储仍收尾且失败可见", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "neuma-application-close-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const events: string[] = [];
  const storage = new AgentStorage({ dataDir });
  const store = { ready: Promise.resolve(), settle: async () => { events.push("store"); } } as unknown as ApplicationTaskStore;
  const workflows = { recover: async () => {}, close: async () => { events.push("workflows"); throw new Error("流程清理失败"); } } as unknown as WorkflowController<{ item: never }>;
  const resources = { closeAll: async () => { events.push("resources"); }, closeAgent: async () => {},
    assertInstance: () => { throw new Error("Unexpected instance lookup"); }, open: async () => { throw new Error("Unexpected page open"); }, close: async () => { throw new Error("Unexpected page close"); } } as ApplicationResourcesPort;
  const agents: ApplicationAgents = { ready: Promise.resolve(), scheduler: new AgentScheduler(), storage, closing: null, agents: new Map(), removing: new Set(), builds: new Map(),
    getArchitecture: async () => { throw new Error("Unexpected architecture read"); }, getActiveArchitecture: async () => null, getActiveRuntime: async () => null, approvedDefinition: () => false,
    services: { run: async () => { throw new Error("Unexpected managed execution"); } }, onLifecycle: () => () => {},
    connections: { snapshot: async () => ({ agentId: "one", version: 1, connections: [] }), assertActive: async () => {} },
    development: { store: { getRun: async () => null }, workspace: { validateSnapshot: async () => { throw new Error("Unexpected snapshot validation"); } }, executor: { runAction: async () => { throw new Error("Unexpected execution"); } } },
    applicationCapabilities: async () => async () => ({ ok: true }) };
  const service = new ApplicationService({ agents, store, resources, workflows: workflows as never });
  await service.ready;
  await assert.rejects(service.close(), /流程清理失败/);
  assert.deepEqual(events, ["workflows", "resources", "store"]);
});
