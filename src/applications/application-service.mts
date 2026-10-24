import { objectFields } from "../runtime/type-boundary.mjs";
import type { AgentDefinition, MaterialTool } from "../agents/prototype-port.mjs";
import type { DevelopmentDeliveryRecord } from "../development/development-controller-types.mjs";
import { readDevelopmentDeliveryRecord } from "../development/development-record.mjs";
import type { PrototypeAgents } from "../agents/agent-prototype.mjs";
import type { ApplicationManifest, ApplicationAction, TaskSource } from "../contracts/application.mjs";
import type { ApplicationContext } from "./application-context.mjs";
import type { RegisteredTool, NeumaTool } from "../runtime/pi-port.mjs";
import type { DevelopmentSnapshot } from "../development/development-workspace.mjs";
import type { ActionRunOptions } from "../development/development-executor.mjs";
import type { WorkflowRecord, WorkflowResolution } from "../services/service-port.mjs";
type TaskView = ReturnType<ApplicationTaskStore["view"]>;
export interface ApplicationDescriptor {
  agent: AgentDefinition;
  architecture: Awaited<ReturnType<PrototypeAgents["getArchitecture"]>>;
  record: DevelopmentDeliveryRecord;
  snapshot: DevelopmentSnapshot; manifest: ApplicationManifest; deliveryVersion: string;
}
interface SubmitOptions { source?: TaskSource; scope?: string; signal?: AbortSignal | undefined; heldLease?: boolean;
  workspaceRoot?: string | undefined; materialTools?: MaterialTool[] | undefined; allowNetwork?: boolean; validatedApplicationContext?: unknown }
interface TaskSubmissionResult { taskId: string; task: TaskView }
interface Submission { epoch: number; task: TaskView | null; done: Promise<TaskSubmissionResult> | null }
interface StateWrite { agentId: string; epoch: number; done: Promise<unknown> | null }
interface RunningTask {
  controller: AbortController; task: TaskView; descriptor: ApplicationDescriptor; action: ApplicationAction;
  connectionSnapshot: Awaited<ReturnType<PrototypeAgents["connections"]["snapshot"]>>;
  workspaceRoot: string | undefined; materialTools: MaterialTool[] | undefined; heldLease: boolean;
  done?: Promise<void> | undefined; signal?: AbortSignal | undefined; terminalStatus?: string;
  onCapability?: NonNullable<ActionRunOptions["onCapability"]>; onProgress?: (progress: unknown) => Promise<void>;
  resume?: { input: unknown; resolution: unknown };
}
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { WorkflowController } from "../services/workflow-controller.mjs";
import { InputError } from "../requirements/core.mjs";
import { ApplicationTaskStore, taskFinished } from "./task-store.mjs";
import { ApplicationResources } from "./application-resources.mjs";
import { applicationTaskInput } from "./input-framing.mjs";
import { validateApplicationManifest, validateActionInput, validateActionOutput, validateActionValue } from "./application-contract.mjs";
import { normalizeApplicationContext, applicationContextBinding, applicationInteraction, applicationActionCatalog,
  applicationConversationContext } from "./application-context.mjs";

const cleanError = (error: unknown) => error instanceof InputError ? error.message : "应用操作未完成，请检查输入、连接和运行环境后重试";

export class ApplicationService {
  agents: PrototypeAgents; store: ApplicationTaskStore; resources: ApplicationResources;
  running: Map<string, RunningTask>; submitting: Set<Submission>; stateWrites: Set<StateWrite>;
  epoch: number; closing: Promise<void> | null; ready: Promise<void>; workflows: WorkflowController<{ item: RunningTask }>;
  workflowReady: Promise<unknown>; unsubscribe: () => void;
  constructor({ agents, store = new ApplicationTaskStore({ storage: agents.storage }), resources = new ApplicationResources() }: { agents: PrototypeAgents; store?: ApplicationTaskStore; resources?: ApplicationResources }) {
    this.agents = agents; this.store = store; this.resources = resources;
    this.running = new Map(); this.submitting = new Set(); this.stateWrites = new Set(); this.epoch = 0; this.closing = null; this.ready = store.ready;
    this.workflows = new WorkflowController<{ item: RunningTask }>({ rootDir: join(objectFields(agents).dataDir as string ?? agents.storage.dataDir!, "workflows"),
      runAction: (options) => this.runManaged(options.context!.item, options),
      onChange: async (record) => {
        const item = [...this.running.values()].find((item) => item.task.workflowId === record.id);
        if (item) await this.store.update(record.agentId, item.task.id,
          { progress: { message: `流程：${record.steps.filter((step) => step.status === "completed").length}/${record.steps.length} 个阶段完成` },
            checkpoint: { workflowId: record.id, status: record.status, steps: record.steps.map(({ id, status }) => ({ id, status })) } }, "checkpoint");
      } });
    this.workflowReady = this.workflows.recover(); this.workflowReady.catch(() => {});
    this.unsubscribe = agents.onLifecycle(async ({ agentId, type }) => this.interruptAgent(agentId, {
      preserveResources: type === "build" && Boolean(await agents.getActiveRuntime?.(agentId)),
    }));
  }
  async descriptor(id: string, options: { optional: true; allowBuilding?: boolean }): Promise<ApplicationDescriptor | null>;
  async descriptor(id: string, options?: { optional?: false; allowBuilding?: boolean }): Promise<ApplicationDescriptor>;
  async descriptor(id: string, { optional = false, allowBuilding = false }: { optional?: boolean; allowBuilding?: boolean } = {}): Promise<ApplicationDescriptor | null> {
    await this.agents.ready;
    const agent = this.agents.agents.get(id);
    if (!agent || !agent.execution || !["node-action", "managed-service"].includes(agent.execution.kind)) {
      if (optional) return null;
      throw new InputError("这个 Agent 尚未交付应用操作");
    }
    const architecture = await (this.agents.getActiveArchitecture?.(id) ?? this.agents.getArchitecture(id));
    if (this.agents.removing.has(id) || !allowBuilding && this.agents.builds.has(id)
      || !agent.developmentRef || !agent.architectureRef || !this.agents.approvedDefinition(agent, architecture)) throw new InputError("应用定义已更新或正在制作，请等待当前版本交付");
    const savedRecord = await this.agents.development.store.getRun(agent.developmentRef.id);
    const record = savedRecord ? readDevelopmentDeliveryRecord(savedRecord) : null;
    if (!record || record.agentId !== id || record.status !== "completed"
      || !["ready", "needs_connection"].includes(record.delivery)
      || record.package?.codeHash !== agent.execution.codeHash
      || record.planHash !== agent.developmentRef.planHash
      || record.architectureRef.version !== agent.architectureRef.version
      || record.architectureRef.candidateHash !== agent.architectureRef.candidateHash) throw new InputError("应用交付与当前 Agent 版本不一致");
    const snapshot = await this.agents.development.workspace.validateSnapshot(record.package!.snapshot, id);
    const manifest = validateApplicationManifest(record.package!.application, { snapshot });
    return { agent, architecture, record, manifest, snapshot, deliveryVersion: `${record.id}:${snapshot.hash}` };
  }
  async summary(id: string) {
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
  async validateContext(id: string, value: unknown, descriptor?: ApplicationDescriptor | null) {
    const context = normalizeApplicationContext(value);
    if (!context) return null;
    const current = descriptor ?? await this.descriptor(id);
    if (context.deliveryVersion !== current.deliveryVersion) throw new InputError("页面上下文的应用交付版本已变化，请重新打开页面");
    this.resources.assertInstance(id, context.instanceId, context.deliveryVersion);
    return context;
  }
  async conversationContext(id: string, value: unknown) {
    const descriptor = await this.descriptor(id, { optional: true });
    const context = await this.validateContext(id, value, descriptor);
    return { context, prompt: applicationConversationContext(descriptor, context) };
  }
  async open(id: string, parentOrigin: string, signal?: AbortSignal) {
    const descriptor = await this.descriptor(id, { allowBuilding: true });
    return this.resources.open({ agentId: id, ...descriptor, codeDir: descriptor.snapshot.path, parentOrigin, signal });
  }
  async state(id: string, version?: string) {
    const { manifest, deliveryVersion } = await this.descriptor(id, { allowBuilding: true });
    if (version !== undefined && version !== deliveryVersion) throw new InputError("应用交付版本已变化，请重新打开页面");
    return this.store.getState(id, { stateVersion: manifest.stateVersion });
  }
  saveState(id: string, body: Record<string, unknown>) {
    if (this.closing || this.agents.closing) return Promise.reject(new InputError("应用服务正在关闭"));
    const item: StateWrite = { agentId: id, epoch: this.epoch, done: null }; this.stateWrites.add(item);
    item.done = (async () => {
      const { manifest, deliveryVersion } = await this.descriptor(id);
      this.assertOpen(item.epoch);
      if (this.agents.builds?.has(id)) throw new InputError("智能体正在更新，请稍后保存页面草稿");
      if (body.deliveryVersion !== undefined && body.deliveryVersion !== deliveryVersion) throw new InputError("应用交付版本已变化，请重新打开页面");
      return this.store.setState(id, { ...body, state: body.state, expectedVersion: body.expectedVersion }, { stateVersion: manifest.stateVersion });
    })();
    const settled = () => this.stateWrites.delete(item); item.done.then(settled, settled); return item.done;
  }
  assertOpen(epoch: number) {
    if (this.closing || this.agents.closing || epoch !== this.epoch) throw new InputError("应用服务正在关闭或已重置，请重新提交任务");
  }
  submit(id: string, body: Record<string, unknown>, options: SubmitOptions = {}): Promise<TaskSubmissionResult> {
    if (this.closing || this.agents.closing) return Promise.reject(new InputError("应用服务正在关闭或已重置，请重新提交任务"));
    const submission: Submission = { epoch: this.epoch, task: null, done: null };
    this.submitting.add(submission);
    submission.done = this.submitTask(id, body, options, submission);
    const settled = () => this.submitting.delete(submission);
    submission.done.then(settled, settled);
    return submission.done;
  }
  async submitTask(id: string, body: Record<string, unknown>, { source = { kind: "application", scope: "private" }, signal, heldLease = false, workspaceRoot, materialTools, allowNetwork = true,
    validatedApplicationContext }: SubmitOptions = {}, submission: Submission): Promise<TaskSubmissionResult> {
    const descriptor = await this.descriptor(id);
    this.assertOpen(submission.epoch);
    if (body.deliveryVersion !== undefined && body.deliveryVersion !== descriptor.deliveryVersion) throw new InputError("应用交付版本已变化，请重新打开页面");
    // A conversation owns its already-validated snapshot even after its viewing
    // instance closes. Public submissions always take the live validation path.
    const applicationContext = validatedApplicationContext === undefined
      ? await this.validateContext(id, body.applicationContext, descriptor) : normalizeApplicationContext(validatedApplicationContext);
    this.assertOpen(submission.epoch);
    if (applicationContext && applicationContext.deliveryVersion !== descriptor.deliveryVersion)
      throw new InputError("页面上下文的应用交付版本已变化，请重新打开页面");
    const taskSource = { ...source, ...(applicationContext ? { applicationContext: applicationContextBinding(applicationContext) } : {}) };
    const action = descriptor.manifest.actions.find((action) => action.id === body.actionId);
    if (!action) throw new InputError("应用没有这个已验收动作");
    validateActionInput(action, body.input);
    const connectionSnapshot = await this.agents.connections.snapshot(id);
    this.assertOpen(submission.epoch);
    for (const connectionId of action.connectionIds) {
      await this.agents.connections.assertActive(connectionSnapshot, connectionId);
      this.assertOpen(submission.epoch);
    }
    const mutationId = body.mutationId;
    if (typeof mutationId !== "string") throw new InputError("请提供稳定的任务幂等标识");
    const { task, created } = await this.store.create(id, applicationTaskInput({ actionId: action.id, input: body.input, mutationId,
      source: taskSource, deliveryVersion: descriptor.deliveryVersion, revision: descriptor.agent.revision, connectionSnapshot, allowNetwork }));
    submission.task = task;
    this.assertOpen(submission.epoch);
    if (created) {
      const controller = new AbortController();
      const item: RunningTask = { controller, task, descriptor, action, connectionSnapshot, workspaceRoot, materialTools, heldLease };
      const abort = () => controller.abort();
      if (heldLease) { signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort(); }
      this.running.set(task.id, item);
      item.done = this.run(item).finally(() => { signal?.removeEventListener("abort", abort); this.running.delete(task.id); });
      item.done.catch(() => {});
    }
    return { taskId: task.id, task };
  }
  async check(item: RunningTask) {
    item.controller.signal.throwIfAborted();
    const current = await this.descriptor(item.task.agentId);
    if (current.deliveryVersion !== item.task.deliveryVersion) throw new InputError("任务绑定的应用版本已失效");
    const task = await this.store.get(item.task.agentId, item.task.id);
    if (taskFinished(task)) throw new DOMException("任务已停止", "AbortError");
  }
  async run(item: RunningTask) {
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
      item.signal = signal;
      item.onCapability = async (call) => {
          await this.check(item);
          try { const result = await capability(call); await this.check(item); return result; }
          catch (error) {
            if (objectFields(error).reason === "connection_persistence_failed"
              || ["state.set", "files.write"].includes(call.capability) && objectFields(error).reason !== "application_conflict") {
              item.terminalStatus = "failed"; controller.abort();
            }
            throw error;
          }
        };
      item.onProgress = async (progress) => {
          await this.check(item);
          try { await this.store.update(task.agentId, task.id, { progress }, "progress"); }
          catch (error) { item.terminalStatus = "failed"; controller.abort(); throw error; }
        };
      let run;
      if (descriptor.manifest.runtime === "managed-service") {
        const definition = descriptor.manifest.service.workflow;
        if (definition?.entryActionId === task.actionId) {
          await this.workflowReady;
          task.workflowId ??= `workflow_${task.id}`;
          await this.store.update(task.agentId, task.id, { workflowId: task.workflowId });
          const workflow = item.resume ? await this.workflows.resume({ id: task.workflowId, ...item.resume, signal, context: { item } })
            : await this.workflows.start({ id: task.workflowId, agentId: task.agentId, deliveryVersion: task.deliveryVersion,
              scopeId: task.source.scope, definition, input: task.input, signal, context: { item } });
          await this.check(item);
          if (workflow.status !== "completed") {
            const waiting = this.workflowWaiting(workflow, descriptor.manifest);
            await this.store.update(task.agentId, task.id, { status: workflow.status, waiting,
              error: workflow.reason ? "流程已暂停，检查已有结果后可继续" : null });
            return;
          }
          const outputs = await Promise.all(Object.entries(workflow.resultRefs).map(async ([id, ref]) => [id, await this.workflows.readResult(workflow, ref)]));
          run = { status: "passed", output: outputs.length === 1 ? outputs[0]![1] : Object.fromEntries(outputs) };
        } else run = await this.runManaged(item, { actionId: task.actionId, input: task.input, signal });
      } else run = await this.agents.development.executor.runAction!({ codeDir: descriptor.snapshot.path,
        entrypoint: descriptor.manifest.entrypoint, actionId: task.actionId, input: task.input, signal,
        onCapability: item.onCapability, onProgress: item.onProgress });
      await this.check(item);
      if (run.status !== "passed") throw new InputError(run.reason === "timeout" ? "操作超过已配置的时限；已有结果保留，请拆分步骤继续" : "应用程序未成功完成，实际执行结果已保留");
      validateActionOutput(action, run.output);
      await this.store.update(task.agentId, task.id, { status: "completed", result: run.output });
    } catch (error) {
      try { await this.store.update(task.agentId, task.id, { status: item.terminalStatus ?? (controller.signal.aborted || objectFields(error).name === "AbortError" ? "cancelled" : "failed"), error: cleanError(error) }); }
      finally { controller.abort(); }
    } finally { release(); }
  }
  workflowWaiting(workflow: WorkflowRecord, manifest: ApplicationManifest) {
    if (!workflow.waiting) return null;
    const step = workflow.definition.steps.find((step) => step.id === workflow.waiting!.stepId);
    const operation = manifest.service!.operations.find((operation) => operation.id === step?.actionId);
    return { ...workflow.waiting, ...(operation ? { outputSchema: operation.outputSchema } : {}) };
  }
  async runManaged(item: RunningTask, { actionId, input, signal }: { actionId: string; input: unknown; signal?: AbortSignal | undefined }) {
    const { task, descriptor } = item;
    const operation = descriptor.manifest.service!.operations.find((operation) => operation.id === actionId);
    if (!operation) throw new InputError("流程动作未经过交付验收");
    validateActionInput(operation, input);
    const result = await this.agents.services.run({ agentId: task.agentId, deliveryVersion: descriptor.deliveryVersion,
      scopeId: task.source.scope, actionId, input, signal,
      capabilityHandler: async (name: string, args: unknown, context: { signal: AbortSignal }) => {
        if (name === "connection.call" && !(operation.connectionIds ?? []).includes(objectFields(args).connectionId as string)) throw new InputError("步骤没有声明这个连接依赖");
        return item.onCapability!({ capability: name, args: objectFields(args), signal: context.signal });
      }, onProgress: item.onProgress });
    if (result.status === "passed") validateActionOutput(operation, result.output);
    return result;
  }
  resume(id: string, taskId: string, body: Record<string, unknown>, options: SubmitOptions = {}): Promise<TaskSubmissionResult> {
    if (this.closing || this.agents.closing) return Promise.reject(new InputError("应用服务正在关闭"));
    const submission: Submission = { epoch: this.epoch, task: null, done: null };
    this.submitting.add(submission);
    submission.done = this.resumeTask(id, taskId, body, options, submission);
    const settled = () => this.submitting.delete(submission); submission.done.then(settled, settled);
    return submission.done;
  }
  async resumeTask(id: string, taskId: string, body: Record<string, unknown>, { scope = "private", workspaceRoot, materialTools, heldLease = false, signal, allowNetwork = true }: SubmitOptions = {}, submission: Submission): Promise<TaskSubmissionResult> {
    const task = await this.store.get(id, taskId);
    if (task.source.scope !== scope) throw new InputError("任务范围不匹配");
    const descriptor = await this.descriptor(id);
    if (descriptor.deliveryVersion !== task.deliveryVersion) throw new InputError("请恢复任务原交付版本后再继续，不能用新版代码继续旧检查点");
    const action = descriptor.manifest.actions.find((action) => action.id === task.actionId);
    if (!task.workflowId || !action) throw new InputError("这个任务没有可继续的流程");
    await this.workflowReady;
    const workflow = await this.workflows.get(task.workflowId);
    if (workflow.agentId !== id || workflow.deliveryVersion !== task.deliveryVersion || workflow.scopeId !== scope) throw new InputError("检查点身份不匹配");
    if (workflow.status === "waiting_input") validateActionValue(body.input, workflow.waiting!.inputSchema);
    if (workflow.status === "needs_review") {
      const resolution = objectFields(body.resolution);
      if (!resolution || resolution.stepId !== workflow.waiting!.stepId || resolution.index !== workflow.waiting!.index) throw new InputError("请先核实这个步骤是否已经完成");
      if (resolution.outcome === "completed") validateActionValue(resolution.output, this.workflowWaiting(workflow, descriptor.manifest)!.outputSchema);
      else if (resolution.outcome !== "retry" || resolution.explicitlyApproved !== true) throw new InputError("重试外部操作需要明确确认");
    }
    const connectionSnapshot = await this.agents.connections.snapshot(id);
    for (const connectionId of action.connectionIds) await this.agents.connections.assertActive(connectionSnapshot, connectionId);
    this.assertOpen(submission.epoch);
    const resumed = await this.store.resume(id, taskId, { ...body, expectedVersion: body.expectedVersion, mutationId: body.mutationId }, { configVersion: connectionSnapshot.version,
      connectionProfile: connectionSnapshot.profile, connectionVersions: connectionSnapshot.connections,
      allowNetwork: task.allowNetwork !== false && allowNetwork });
    submission.task = resumed.task; this.assertOpen(submission.epoch);
    if (resumed.created) {
      const item: RunningTask = { task: resumed.task, descriptor, action, connectionSnapshot, workspaceRoot, materialTools, heldLease,
        controller: new AbortController(), resume: { input: body.input, resolution: body.resolution } };
      const abort = () => item.controller.abort();
      if (heldLease) { signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort(); }
      this.running.set(taskId, item);
      item.done = this.run(item).finally(() => { signal?.removeEventListener("abort", abort); this.running.delete(taskId); }); item.done.catch(() => {});
    }
    return { taskId, task: resumed.task };
  }
  async wait(id: string, taskId: string) {
    await this.running.get(taskId)?.done;
    return this.store.get(id, taskId);
  }
  async cancel(id: string, taskId: string, status = "cancelled") {
    const task = await this.store.get(id, taskId);
    if (!taskFinished(task)) {
      const item = this.running.get(taskId);
      if (item) { item.terminalStatus = status; item.controller.abort(); }
      if (task.workflowId && status === "cancelled") await this.workflows.cancel(task.workflowId);
      await this.store.update(id, taskId, { status, error: status === "interrupted" ? "Agent 更新或 NEUMA 关闭，任务已中断；已有产物保留" : "任务已停止；已有产物及外部操作保留" });
    }
    return { task: await this.store.get(id, taskId) };
  }
  async interruptAgent(id: string, { preserveResources = false } = {}) {
    await this.ready;
    await Promise.allSettled([...this.stateWrites].filter((item) => item.agentId === id).map((item) => item.done));
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
  close() {
    if (this.closing) return this.closing;
    this.epoch++;
    const running = [...this.running.values()], submissions = [...this.submitting];
    for (const item of running) { item.terminalStatus = "interrupted"; item.controller.abort(); }
    this.closing = (async () => {
      const [outcomes] = await Promise.all([
        Promise.allSettled(running.map((item) => this.cancel(item.task.agentId, item.task.id, "interrupted"))),
        Promise.allSettled(submissions.map((submission) => submission.done)),
      ]);
      // A task may finish its initial write after the running snapshot was taken.
      const late = submissions.map((submission) => submission.task).filter((task): task is TaskView => !!task && !running.some((item) => item.task.id === task.id));
      outcomes.push(...await Promise.allSettled(late.map((task) => this.cancel(task.agentId, task.id, "interrupted"))));
      await Promise.allSettled(running.map((item) => item.done));
      await Promise.allSettled([...this.stateWrites].map((item) => item.done));
      await this.workflows.close(); await this.resources.closeAll(); await this.store.settle();
      const failure = outcomes.find((outcome) => outcome.status === "rejected");
      if (failure) throw failure.reason;
    })().finally(() => { this.closing = null; });
    return this.closing;
  }
  async tools(agent: { id: string }, { scope = "private", workspaceRoot, materialTools, allowNetwork = () => true, getApplicationContext = () => null }: { scope?: string; workspaceRoot?: string | undefined; materialTools?: MaterialTool[] | undefined; allowNetwork?: () => boolean; getApplicationContext?: () => ApplicationContext | null } = {}): Promise<NeumaTool[]> {
    const { manifest, deliveryVersion } = await this.descriptor(agent.id);
    if (!manifest.actions.length) return [];
    return [{ name: "run_application_action", label: "执行应用操作", description: `执行已交付应用动作，与页面共用持久任务及状态。以真实任务结果回答。仅按以下动作输入契约传参：${JSON.stringify(applicationActionCatalog(manifest))}`,
      // Preserve JSON input types through SDK validation; submit enforces the selected action's schema.
      parameters: { type: "object", properties: { actionId: { type: "string", enum: manifest.actions.map((action) => action.id) },
        input: { anyOf: [{ type: "object" }, { type: "array", items: {} }, { type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }] } },
        required: ["actionId", "input"], additionalProperties: false },
      executionMode: "sequential" as const, execute: async (callId: string, params: unknown, signal?: AbortSignal) => {
        const submitted = await this.submit(agent.id, { ...objectFields(params), deliveryVersion,
          mutationId: /^[\w-]{8,100}$/.test(callId) ? callId : randomUUID() },
          { source: { kind: scope === "private" ? "conversation" : "group", scope }, heldLease: true, workspaceRoot, materialTools, signal,
            allowNetwork: allowNetwork(), validatedApplicationContext: getApplicationContext() });
        const task = await this.wait(agent.id, submitted.taskId);
        return { content: [{ type: "text" as const, text: JSON.stringify({ taskId: task.id, status: task.status, result: task.result, error: task.error,
          waiting: task.waiting, version: task.sequence }) }], details: {} };
      } }, ...(manifest.service?.workflow ? [{ name: "resume_application_task", label: "继续流程任务",
      description: "用户明确回答待补充信息后继续同一任务，不能重复提交新任务。对needs_review必须请用户核实外部结果，不能自行选择重试。",
      parameters: { type: "object", properties: { taskId: { type: "string" }, expectedVersion: { type: "integer" },
        input: {}, resolution: { type: "object", additionalProperties: true } }, required: ["taskId", "expectedVersion"], additionalProperties: false },
      executionMode: "sequential" as const, execute: async (callId: string, params: unknown, signal?: AbortSignal) => {
        const result = await this.resume(agent.id, objectFields(params).taskId as string, { ...objectFields(params), mutationId: /^[\w-]{8,100}$/.test(callId) ? callId : randomUUID() },
          { scope, workspaceRoot, materialTools, heldLease: true, signal, allowNetwork: allowNetwork() });
        const task = await this.wait(agent.id, result.taskId);
        return { content: [{ type: "text" as const, text: JSON.stringify({ taskId: task.id, status: task.status, result: task.result,
          waiting: task.waiting, version: task.sequence, error: task.error }) }], details: {} };
      } }] : [])];
  }
}
