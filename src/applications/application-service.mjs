import { randomUUID } from "node:crypto";
import { InputError } from "../requirements/core.mjs";
import { ApplicationTaskStore, taskFinished } from "./task-store.mjs";
import { ApplicationResources } from "./application-resources.mjs";
import { validateApplicationManifest, validateActionInput, validateActionOutput } from "./application-contract.mjs";
import { normalizeApplicationContext, applicationContextBinding, applicationInteraction, applicationActionCatalog,
  applicationConversationContext } from "./application-context.mjs";

const cleanError = (error) => error instanceof InputError ? error.message : "应用操作未完成，请检查输入、连接和运行环境后重试";

export class ApplicationService {
  constructor({ agents, store = new ApplicationTaskStore({ storage: agents.storage }), resources = new ApplicationResources() }) {
    this.agents = agents; this.store = store; this.resources = resources;
    this.running = new Map(); this.ready = store.ready;
    this.unsubscribe = agents.onLifecycle(async ({ agentId, type }) => this.interruptAgent(agentId, {
      preserveResources: type === "build" && Boolean(await agents.getActiveRuntime?.(agentId)),
    }));
  }
  async descriptor(id, { optional = false, allowBuilding = false } = {}) {
    await this.agents.ready;
    const agent = this.agents.agents.get(id);
    if (agent?.execution?.kind !== "node-action") {
      if (optional) return null;
      throw new InputError("这个 Agent 尚未交付应用操作");
    }
    const architecture = await (this.agents.getActiveArchitecture?.(id) ?? this.agents.getArchitecture(id));
    if (this.agents.removing.has(id) || !allowBuilding && this.agents.builds.has(id)
      || !this.agents.approvedDefinition(agent, architecture)) throw new InputError("应用定义已更新或正在制作，请等待当前版本交付");
    const record = await this.agents.development.store.getRun(agent.developmentRef.id);
    if (!record || record.agentId !== id || record.status !== "completed"
      || !["ready", "needs_connection"].includes(record.delivery)
      || record.package?.codeHash !== agent.execution.codeHash
      || record.planHash !== agent.developmentRef.planHash
      || record.architectureRef.version !== agent.architectureRef.version
      || record.architectureRef.candidateHash !== agent.architectureRef.candidateHash) throw new InputError("应用交付与当前 Agent 版本不一致");
    const snapshot = await this.agents.development.workspace.validateSnapshot(record.package.snapshot, id);
    const manifest = validateApplicationManifest(record.package.application, { snapshot });
    return { agent, architecture, record, manifest, snapshot, deliveryVersion: `${record.id}:${snapshot.hash}` };
  }
  async summary(id) {
    const descriptor = await this.descriptor(id, { optional: true, allowBuilding: true });
    if (!descriptor) return { manifest: null, pageReady: false, actions: [], deliveryVersion: null, ...applicationInteraction(null) };
    const connectionSnapshot = await this.agents.connections.snapshot(id);
    const ids = new Set(connectionSnapshot.connections.map((connection) => connection.id));
    const actions = descriptor.manifest.actions.map((action) => {
      const missingConnections = action.connectionIds.filter((id) => !ids.has(id));
      return { id: action.id, title: action.title, label: action.title, ready: !missingConnections.length, missingConnections };
    });
    return { manifest: descriptor.manifest, deliveryVersion: descriptor.deliveryVersion, pageReady: Boolean(descriptor.manifest.page), actions,
      ...applicationInteraction(descriptor) };
  }
  async validateContext(id, value, descriptor) {
    const context = normalizeApplicationContext(value);
    if (!context) return null;
    const current = descriptor ?? await this.descriptor(id);
    if (context.deliveryVersion !== current.deliveryVersion) throw new InputError("页面上下文的应用交付版本已变化，请重新打开页面");
    this.resources.assertInstance(id, context.instanceId, context.deliveryVersion);
    return context;
  }
  async conversationContext(id, value) {
    const descriptor = await this.descriptor(id, { optional: true });
    const context = await this.validateContext(id, value, descriptor);
    return { context, prompt: applicationConversationContext(descriptor, context) };
  }
  async open(id, parentOrigin, signal) {
    const descriptor = await this.descriptor(id, { allowBuilding: true });
    return this.resources.open({ agentId: id, ...descriptor, codeDir: descriptor.snapshot.path, parentOrigin, signal });
  }
  async state(id, version) {
    const { manifest, deliveryVersion } = await this.descriptor(id, { allowBuilding: true });
    if (version !== undefined && version !== deliveryVersion) throw new InputError("应用交付版本已变化，请重新打开页面");
    return this.store.getState(id, { stateVersion: manifest.stateVersion });
  }
  async saveState(id, body) {
    const { manifest, deliveryVersion } = await this.descriptor(id);
    if (body.deliveryVersion !== undefined && body.deliveryVersion !== deliveryVersion) throw new InputError("应用交付版本已变化，请重新打开页面");
    return this.store.setState(id, body, { stateVersion: manifest.stateVersion });
  }
  async submit(id, body, { source = { kind: "application", scope: "private" }, signal, heldLease = false, workspaceRoot, materialTools, allowNetwork = true,
    validatedApplicationContext } = {}) {
    const descriptor = await this.descriptor(id);
    if (body.deliveryVersion !== undefined && body.deliveryVersion !== descriptor.deliveryVersion) throw new InputError("应用交付版本已变化，请重新打开页面");
    // A conversation owns its already-validated snapshot even after its viewing
    // instance closes. Public submissions always take the live validation path.
    const applicationContext = validatedApplicationContext === undefined
      ? await this.validateContext(id, body.applicationContext, descriptor) : normalizeApplicationContext(validatedApplicationContext);
    if (applicationContext && applicationContext.deliveryVersion !== descriptor.deliveryVersion)
      throw new InputError("页面上下文的应用交付版本已变化，请重新打开页面");
    const taskSource = { ...source, ...(applicationContext ? { applicationContext: applicationContextBinding(applicationContext) } : {}) };
    const action = descriptor.manifest.actions.find((action) => action.id === body.actionId);
    if (!action) throw new InputError("应用没有这个已验收动作");
    validateActionInput(action, body.input);
    const connectionSnapshot = await this.agents.connections.snapshot(id);
    for (const connectionId of action.connectionIds) await this.agents.connections.assertActive(connectionSnapshot, connectionId);
    const { task, created } = await this.store.create(id, { actionId: action.id, input: body.input, mutationId: body.mutationId,
      source: taskSource, deliveryVersion: descriptor.deliveryVersion, revision: descriptor.agent.revision,
      configVersion: connectionSnapshot.version, connectionVersions: connectionSnapshot.connections, allowNetwork });
    if (created) {
      const controller = new AbortController();
      const item = { controller, task, descriptor, action, connectionSnapshot, workspaceRoot, materialTools, heldLease };
      const abort = () => controller.abort();
      if (heldLease) { signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort(); }
      this.running.set(task.id, item);
      item.done = this.run(item).finally(() => { signal?.removeEventListener("abort", abort); this.running.delete(task.id); });
      item.done.catch(() => {});
    }
    return { taskId: task.id, task };
  }
  async check(item) {
    item.controller.signal.throwIfAborted();
    const current = await this.descriptor(item.task.agentId);
    if (current.deliveryVersion !== item.task.deliveryVersion) throw new InputError("任务绑定的应用版本已失效");
    const task = await this.store.get(item.task.agentId, item.task.id);
    if (taskFinished(task)) throw new DOMException("任务已停止", "AbortError");
  }
  async run(item) {
    const { task, descriptor, action, controller } = item;
    let release = () => {};
    try {
      let signal = controller.signal;
      if (!item.heldLease) {
        const lease = await this.agents.scheduler.acquire({ agentId: task.agentId, signal });
        release = lease.release; signal = lease.signal;
      }
      await this.check(item);
      await this.store.update(task.agentId, task.id, { status: "running", startedAt: new Date().toISOString() });
      const capability = await this.agents.applicationCapabilities({ ...item, signal, check: () => this.check(item) });
      const run = await this.agents.development.executor.runAction({ codeDir: descriptor.snapshot.path,
        entrypoint: descriptor.manifest.entrypoint, actionId: task.actionId, input: task.input, signal,
        onCapability: async (call) => {
          await this.check(item);
          try { const result = await capability(call); await this.check(item); return result; }
          catch (error) {
            if (error.reason === "connection_persistence_failed"
              || ["state.set", "files.write"].includes(call.capability) && error.reason !== "application_conflict") {
              item.terminalStatus = "failed"; controller.abort();
            }
            throw error;
          }
        }, onProgress: async (progress) => {
          await this.check(item);
          try { await this.store.update(task.agentId, task.id, { progress }, "progress"); }
          catch (error) { item.terminalStatus = "failed"; controller.abort(); throw error; }
        } });
      await this.check(item);
      if (run.status !== "passed") throw new InputError(run.reason === "timeout" ? "操作超过 120 秒时限；已有结果保留，请拆分步骤继续" : "应用程序未成功完成，实际执行结果已保留");
      validateActionOutput(action, run.output);
      await this.store.update(task.agentId, task.id, { status: "completed", result: run.output });
    } catch (error) {
      try { await this.store.update(task.agentId, task.id, { status: item.terminalStatus ?? (controller.signal.aborted || error?.name === "AbortError" ? "cancelled" : "failed"), error: cleanError(error) }); }
      finally { controller.abort(); }
    } finally { release(); }
  }
  async wait(id, taskId) {
    await this.running.get(taskId)?.done;
    return this.store.get(id, taskId);
  }
  async cancel(id, taskId, status = "cancelled") {
    const task = await this.store.get(id, taskId);
    if (!taskFinished(task)) {
      const item = this.running.get(taskId);
      if (item) { item.terminalStatus = status; item.controller.abort(); }
      await this.store.update(id, taskId, { status, error: status === "interrupted" ? "Agent 更新或 NEUMA 关闭，任务已中断；已有产物保留" : "任务已停止；已有产物及外部操作保留" });
    }
    return { task: await this.store.get(id, taskId) };
  }
  async interruptAgent(id, { preserveResources = false } = {}) {
    await this.ready;
    const running = [...this.running.values()].filter((item) => item.task.agentId === id);
    for (const item of running) { item.terminalStatus = "interrupted"; item.controller.abort(); }
    let failure;
    try {
      const pending = (await this.store.list(id)).filter((task) => !taskFinished(task));
      const results = await Promise.allSettled(pending.map((task) => this.cancel(id, task.id, "interrupted")));
      failure = results.find((result) => result.status === "rejected")?.reason;
    } catch (error) { failure = error; }
    finally {
      if (!preserveResources) await this.resources.closeAgent(id);
      await Promise.allSettled(running.map((item) => item.done));
    }
    if (failure) throw failure;
  }
  async close() {
    const running = [...this.running.values()];
    for (const item of running) { item.terminalStatus = "interrupted"; item.controller.abort(); }
    const outcomes = await Promise.allSettled(running.map((item) => this.cancel(item.task.agentId, item.task.id, "interrupted")));
    await Promise.allSettled(running.map((item) => item.done));
    await this.resources.closeAll(); await this.store.settle();
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    if (failure) throw failure.reason;
  }
  async tools(agent, { scope = "private", workspaceRoot, materialTools, allowNetwork = () => true, getApplicationContext = () => null } = {}) {
    const { manifest, deliveryVersion } = await this.descriptor(agent.id);
    if (!manifest.actions.length) return [];
    return [{ name: "run_application_action", label: "执行应用操作", description: `执行已交付应用动作，与页面共用持久任务及状态。以真实任务结果回答。仅按以下动作输入契约传参：${JSON.stringify(applicationActionCatalog(manifest))}`,
      parameters: { type: "object", properties: { actionId: { type: "string", enum: manifest.actions.map((action) => action.id) }, input: { type: "object" } }, required: ["actionId", "input"], additionalProperties: false },
      executionMode: "sequential", execute: async (callId, params, signal) => {
        const submitted = await this.submit(agent.id, { ...params, deliveryVersion,
          mutationId: /^[\w-]{8,100}$/.test(callId) ? callId : randomUUID() },
          { source: { kind: scope === "private" ? "conversation" : "group", scope }, heldLease: true, workspaceRoot, materialTools, signal,
            allowNetwork: allowNetwork(), validatedApplicationContext: getApplicationContext() });
        const task = await this.wait(agent.id, submitted.taskId);
        return { content: [{ type: "text", text: JSON.stringify({ taskId: task.id, status: task.status, result: task.result, error: task.error }) }], details: {} };
      } }];
  }
}
