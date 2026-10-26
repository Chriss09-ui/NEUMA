import type { UnknownRecord } from "../contracts/json.mjs";
import type { WorkflowRecord, WorkflowReference, WorkflowStartOptions, WorkflowResumeOptions, WorkflowContextOptions, WorkflowActionOptions, ServiceResult } from "./service-port.mjs";
import { isWorkflowRecordEnvelope } from "./workflow-records.mjs";
import { objectFields, errorField, isRecord, isArray } from "../runtime/type-boundary.mjs";
import { randomUUID } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateActionValue } from "../applications/application-contract.mjs";
import { checkedIdentity, ServiceError, serviceHash } from "./service-contract.mjs";
import { atomicJSON, privateDirectory, readJSON } from "./service-files.mjs";
import { validateWorkflowDefinition } from "./workflow-contract.mjs";
import { createExecutionAttempt, executionOutcome, isExecutionAttempt } from "../runtime/execution-attempt.mjs";

function at(value: unknown, path = ""): unknown {
  for (const part of path.split(".").filter(Boolean)) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)) throw new ServiceError("workflow_input_reference_missing");
    value = objectFields(value)[part];
  }
  return structuredClone(value);
}
function resolveInput(value: unknown, { input, outputs, item, response }: { input: unknown; outputs: UnknownRecord; item: unknown; response: unknown }): unknown {
  if (isArray(value)) return value.map((child) => resolveInput(child, { input, outputs, item, response }));
  if (!isRecord(value)) return value;
  if (Object.hasOwn(value, "$input")) return at(input, String(value.$input));
  if (Object.hasOwn(value, "$step")) return at(outputs[String(value.$step)], String(value.path ?? ""));
  if (value.$item === true) return structuredClone(item);
  if (value.$response === true) return structuredClone(response);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveInput(child, { input, outputs, item, response })]));
}
export class WorkflowController<Context = unknown> {
  declare rootDir: string; declare runAction: (options: WorkflowActionOptions<Context>) => Promise<ServiceResult>; declare onChange: (record: WorkflowRecord) => void | Promise<void>;
  running: Map<string, { controller: AbortController; run: Promise<WorkflowRecord> }>; starting: Map<string, Promise<WorkflowRecord>>; closed: boolean;
  constructor({ rootDir, runAction, onChange = () => {} }: { rootDir?: string; runAction?: (options: WorkflowActionOptions<Context>) => Promise<ServiceResult>; onChange?: (record: WorkflowRecord) => void | Promise<void> } = {}) {
    if (!rootDir || typeof runAction !== "function") throw new TypeError("rootDir and runAction are required");
    Object.assign(this, { rootDir: resolve(rootDir), runAction, onChange }); this.running = new Map(); this.starting = new Map(); this.closed = false;
  }
  directory(id: string) { checkedIdentity(id); return join(this.rootDir, id); }
  async save(record: WorkflowRecord) { record.updatedAt = new Date().toISOString(); await atomicJSON(join(this.directory(record.id), "record.json"), record); await this.onChange(structuredClone(record)); }
  async get(id: string): Promise<WorkflowRecord> {
    const input = await readJSON(join(this.directory(id), "record.json")); if (!input) throw new ServiceError("workflow_not_found");
    const value = objectFields(input);
    if (!isWorkflowRecordEnvelope(value) || value.id !== id) throw new ServiceError("workflow_definition_changed");
    const definition = validateWorkflowDefinition(value.definition);
    if (serviceHash(definition) !== value.definitionHash) throw new ServiceError("workflow_definition_changed");
    for (const state of value.steps) for (const item of state.items) {
      if (item.executions !== undefined && (!Array.isArray(item.executions)
        || item.executions.some(attempt => !isExecutionAttempt(attempt))
        || new Set(item.executions.map(attempt => attempt.id)).size !== item.executions.length
        || item.executions.some((attempt, index, entries) => attempt.number > item.attempts || index > 0 && attempt.number <= entries[index - 1]!.number)))
        throw new ServiceError("workflow_definition_changed");
    }
    return { ...value, definition };
  }
  async resultFile(record: WorkflowRecord, value: unknown) {
    const bytes = JSON.stringify(value); if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) throw new ServiceError("workflow_result_limit");
    const hash = serviceHash(bytes), path = join(await privateDirectory(join(this.directory(record.id), "results")), `${hash}.json`);
    await writeFile(path, bytes, { mode: 0o600 }); return { sha256: hash, path: `results/${hash}.json` };
  }
  async readResult(record: WorkflowRecord, reference: WorkflowReference | null | undefined): Promise<unknown> {
    if (!reference || reference.path !== `results/${reference.sha256}.json` || !/^[a-f0-9]{64}$/.test(reference.sha256)) throw new ServiceError("invalid_workflow_result_reference");
    const bytes = await readFile(join(this.directory(record.id), reference.path));
    if (serviceHash(bytes) !== reference.sha256) throw new ServiceError("workflow_result_changed"); return JSON.parse(bytes.toString("utf8"));
  }
  async start(options: WorkflowStartOptions<Context>) {
    const id = options.id ?? `workflow_${randomUUID()}`; checkedIdentity(id);
    if (this.starting.has(id)) await this.starting.get(id);
    const pending = this.create({ ...options, id }); this.starting.set(id, pending);
    try { return await pending; } finally { if (this.starting.get(id) === pending) this.starting.delete(id); }
  }
  async create({ id, agentId, deliveryVersion, scopeId = "private", definition: inputDefinition, input, signal, context }: WorkflowStartOptions<Context> & { id: string }) {
    if (this.closed) throw new ServiceError("workflow_controller_closed");
    [agentId, deliveryVersion, scopeId].forEach(checkedIdentity); const definition = validateWorkflowDefinition(inputDefinition);
    const existingInput = await readJSON(join(this.directory(id), "record.json"));
    const existing = existingInput ? objectFields(existingInput) : null;
    if (existing) {
      if (existing.agentId !== agentId || existing.deliveryVersion !== deliveryVersion || existing.scopeId !== scopeId || existing.definitionHash !== serviceHash(definition) || objectFields(existing.inputRef).sha256 !== serviceHash(JSON.stringify(input))) throw new ServiceError("workflow_request_conflict");
      return this.get(id);
    }
    const record: WorkflowRecord = { schemaVersion: 1, id, agentId, deliveryVersion, scopeId, definition, definitionHash: serviceHash(definition), status: "pending", createdAt: new Date().toISOString(), steps: definition.steps.map((step) => ({ id: step.id, status: "pending", items: [], responseRef: null })), waiting: null, resultRefs: {} };
    await privateDirectory(this.directory(record.id)); record.inputRef = await this.resultFile(record, input); await this.save(record);
    return this.execute(record, { signal, context });
  }
  async resume({ id, input, resolution: rawResolution, signal, context }: WorkflowResumeOptions<Context>) {
    if (this.running.has(id)) throw new ServiceError("workflow_busy");
    const record = await this.get(id), resolution = objectFields(rawResolution);
    if (!["pending", "waiting_input", "interrupted", "needs_review", "failed"].includes(record.status)) throw new ServiceError("workflow_cannot_resume");
    if (record.status === "waiting_input") {
      const step = record.definition.steps.find((item) => item.id === record.waiting!.stepId), state = record.steps.find((item) => item.id === step!.id)!;
      validateActionValue(input, step!.waitForInput!.inputSchema); state.responseRef = await this.resultFile(record, input); state.status = "pending"; record.waiting = null;
    } else if (record.status === "needs_review") {
      if (typeof resolution.stepId !== "string" || typeof resolution.index !== "number" || !Number.isSafeInteger(resolution.index) || resolution.stepId !== record.waiting?.stepId || resolution.index !== record.waiting?.index) throw new ServiceError("workflow_resolution_required", "请先核实外部操作是否已经发生，再决定补记结果或重新执行");
      const state = record.steps.find((item) => item.id === resolution.stepId)!, item = state.items[resolution.index]!;
      const attempt = item.executions?.at(-1);
      if (attempt && resolution.attemptId !== attempt.id) throw new ServiceError("workflow_resolution_required", "核实请求与当前执行尝试不一致，请刷新任务");
      if (resolution.outcome === "completed") { item.resultRef = await this.resultFile(record, resolution.output); item.status = "completed";
        if (attempt) Object.assign(attempt, { phase: "completed", resultRef: item.resultRef, resolution: "verified" }); }
      else if (resolution.outcome === "retry" && resolution.explicitlyApproved === true) { item.status = "pending"; item.explicitRetry = true;
        if (attempt) attempt.resolution = "retry_approved"; }
      else throw new ServiceError("invalid_workflow_resolution");
      state.status = "pending"; record.waiting = null;
    } else {
      for (const state of record.steps) for (const item of state.items) if (["failed", "running"].includes(item.status)) {
        const step = record.definition.steps.find((entry) => entry.id === state.id);
        if (!step!.idempotent && executionOutcome(item.executions?.at(-1)) !== "not_started") throw new ServiceError("workflow_resolution_required");
        item.status = "pending"; state.status = "pending";
        // A deliberate continuation may retry an interrupted idempotent attempt once.
        // Keep the recorded attempt count; ordinary failures still exhaust their budget.
        if (record.status === "interrupted") item.explicitRetry = true;
      }
    }
    record.status = "pending"; await this.save(record); return this.execute(record, { signal, context });
  }
  async execute(record: WorkflowRecord, { signal, context }: WorkflowContextOptions<Context> = {}) {
    if (this.closed) throw new ServiceError("workflow_controller_closed");
    if (this.running.has(record.id)) throw new ServiceError("workflow_busy");
    const controller = new AbortController(), abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    const run = this.advance(record, { signal: controller.signal, context }); this.running.set(record.id, { controller, run });
    try { return await run; } finally { signal?.removeEventListener("abort", abort); this.running.delete(record.id); }
  }
  async advance(record: WorkflowRecord, { signal, context }: WorkflowContextOptions<Context> & { signal: AbortSignal }) {
    const input = await this.readResult(record, record.inputRef); record.status = "running"; await this.save(record);
    try {
      while (true) {
        signal.throwIfAborted();
        const pending = record.definition.steps.find((step) => record.steps.find((state) => state.id === step.id)!.status !== "completed" && step.dependsOn.every((id) => record.steps.find((state) => state.id === id)!.status === "completed"));
        if (!pending) {
          if (record.steps.some((state) => state.status !== "completed")) throw new ServiceError("workflow_dependency_blocked");
          record.status = "completed"; record.resultRefs = Object.fromEntries(record.definition.outputs.map((id) => [id, record.steps.find((state) => state.id === id)!.resultRef])); await this.save(record); return structuredClone(record);
        }
        const state = record.steps.find((item) => item.id === pending.id)!;
        if (pending.waitForInput && !state.responseRef) {
          record.status = "waiting_input"; record.waiting = { stepId: pending.id, prompt: pending.waitForInput.prompt, inputSchema: pending.waitForInput.inputSchema }; state.status = "waiting_input"; await this.save(record); return structuredClone(record);
        }
        const outputs: UnknownRecord = {};
        for (const id of pending.dependsOn) outputs[id] = await this.readResult(record, record.steps.find((entry) => entry.id === id)!.resultRef);
        const items = pending.batch ? at(input, pending.batch.inputPath) : [null];
        if (!Array.isArray(items) || items.length > (pending.batch?.maxItems ?? 1)) throw new ServiceError("workflow_batch_limit");
        if (!state.items.length) { state.items = items.map((_, index) => ({ index, status: "pending", attempts: 0, resultRef: null })); await this.save(record); }
        if (state.items.length !== items.length) throw new ServiceError("workflow_checkpoint_changed");
        const response = state.responseRef ? await this.readResult(record, state.responseRef) : null;
        for (const item of state.items) {
          if (item.status === "completed") continue;
          const maxAttempts = 1 + (pending.maxRetries ?? 0);
          while (item.status !== "completed") {
            signal.throwIfAborted();
            if (item.attempts >= maxAttempts && !item.explicitRetry) { record.status = "failed"; state.status = "failed"; record.reason = "workflow_retry_budget_exhausted"; await this.save(record); return structuredClone(record); }
            const args = resolveInput(pending.input ?? { $input: "" }, { input, outputs, item: items[item.index], response });
            item.explicitRetry = false; item.attempts++; item.status = "running"; state.status = "running";
            const attempt = createExecutionAttempt(serviceHash([record.id, record.agentId, record.deliveryVersion, record.scopeId, pending.id, pending.actionId, item.index, args]), item.attempts);
            (item.executions ??= []).push(attempt);
            await this.save(record);
            const execution = { id: attempt.id, beforeDispatch: async () => {
              signal.throwIfAborted();
              if (attempt.uncertain) throw new ServiceError("execution_outcome_unknown", "上次外部操作结果尚未核实，已阻止继续分派");
              if (attempt.phase === "prepared") { attempt.phase = "dispatched"; await this.save(record); }
              signal.throwIfAborted();
            }, markUnknown: async () => { attempt.uncertain = true; await this.save(record); } };
            let result;
            try { await execution.beforeDispatch(); result = await this.runAction({ agentId: record.agentId, deliveryVersion: record.deliveryVersion, scopeId: record.scopeId, actionId: pending.actionId, input: args, signal, context, workflowId: record.id, stepId: pending.id, itemIndex: item.index, execution }); }
            catch (error) { result = { status: "error", reason: signal.aborted ? "cancelled" : String(errorField(error, "reason") ?? "workflow_action_error") }; }
            if (attempt.uncertain) result = { status: "error", reason: "execution_outcome_unknown" };
            if (result.status === "passed") { item.resultRef = await this.resultFile(record, result.output); item.status = "completed";
              Object.assign(attempt, { phase: "completed", resultRef: item.resultRef }); await this.save(record); signal.throwIfAborted(); continue; }
            item.reason = result.reason ?? "workflow_action_failed"; item.status = "failed";
            if (!pending.idempotent) { record.status = "needs_review"; state.status = "needs_review"; record.waiting = { stepId: pending.id, index: item.index, attemptId: attempt.id, reason: item.reason }; await this.save(record); return structuredClone(record); }
            if (signal.aborted) throw new ServiceError("cancelled");
            await this.save(record);
          }
        }
        state.resultRef = await this.resultFile(record, pending.batch ? await Promise.all(state.items.map((item) => this.readResult(record, item.resultRef))) : await this.readResult(record, state.items[0]!.resultRef));
        state.status = "completed"; await this.save(record);
      }
    } catch (error) { record.status = signal.aborted ? "interrupted" : "failed"; record.reason = signal.aborted ? "cancelled" : String(errorField(error, "reason") ?? "workflow_failed"); await this.save(record); return structuredClone(record); }
  }
  async cancel(id: string) { const running = this.running.get(id); if (running) { running.controller.abort(); return running.run; } const record = await this.get(id); record.status = "cancelled"; await this.save(record); return record; }
  async recover() {
    await privateDirectory(this.rootDir); const changed = [];
    for (const entry of await readdir(this.rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("workflow_")) continue;
      const record = await this.get(entry.name); if (!["running", "pending"].includes(record.status)) continue;
      record.status = "interrupted";
      for (const state of record.steps) for (const item of state.items) if (item.status === "running") {
        const step = record.definition.steps.find((entry) => entry.id === state.id);
        if (!step!.idempotent && executionOutcome(item.executions?.at(-1)) !== "not_started") { record.status = "needs_review"; state.status = "needs_review"; record.waiting = { stepId: step!.id, index: item.index, ...(item.executions?.at(-1) ? { attemptId: item.executions.at(-1)!.id } : {}), reason: "execution_interrupted" }; }
      }
      await this.save(record); changed.push(record);
    }
    return changed;
  }
  async close({ permanent = false } = {}) {
    this.closed = true; for (const run of this.running.values()) run.controller.abort();
    await Promise.allSettled([...this.running.values()].map((run) => run.run)); await Promise.allSettled([...this.starting.values()]);
    if (!permanent) this.closed = false;
  }
}
