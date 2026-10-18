import { randomUUID } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateActionValue } from "../applications/application-contract.mjs";
import { checkedIdentity, ServiceError, serviceHash } from "./service-contract.mjs";
import { atomicJSON, privateDirectory, readJSON } from "./service-files.mjs";
import { validateWorkflowDefinition } from "./workflow-contract.mjs";

function at(value, path = "") {
  for (const part of path.split(".").filter(Boolean)) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)) throw new ServiceError("workflow_input_reference_missing");
    value = value[part];
  }
  return structuredClone(value);
}
function resolveInput(value, { input, outputs, item, response }) {
  if (Array.isArray(value)) return value.map((child) => resolveInput(child, { input, outputs, item, response }));
  if (!value || typeof value !== "object") return value;
  if (Object.hasOwn(value, "$input")) return at(input, value.$input);
  if (Object.hasOwn(value, "$step")) return at(outputs[value.$step], value.path ?? "");
  if (value.$item === true) return structuredClone(item);
  if (value.$response === true) return structuredClone(response);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveInput(child, { input, outputs, item, response })]));
}
export class WorkflowController {
  constructor({ rootDir, runAction, onChange = () => {} } = {}) {
    if (!rootDir || typeof runAction !== "function") throw new TypeError("rootDir and runAction are required");
    Object.assign(this, { rootDir: resolve(rootDir), runAction, onChange }); this.running = new Map(); this.starting = new Map(); this.closed = false;
  }
  directory(id) { checkedIdentity(id); return join(this.rootDir, id); }
  async save(record) { record.updatedAt = new Date().toISOString(); await atomicJSON(join(this.directory(record.id), "record.json"), record); await this.onChange(structuredClone(record)); }
  async get(id) {
    const record = await readJSON(join(this.directory(id), "record.json")); if (!record) throw new ServiceError("workflow_not_found");
    if (serviceHash(validateWorkflowDefinition(record.definition)) !== record.definitionHash) throw new ServiceError("workflow_definition_changed");
    return record;
  }
  async resultFile(record, value) {
    const bytes = JSON.stringify(value); if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) throw new ServiceError("workflow_result_limit");
    const hash = serviceHash(bytes), path = join(await privateDirectory(join(this.directory(record.id), "results")), `${hash}.json`);
    await writeFile(path, bytes, { mode: 0o600 }); return { sha256: hash, path: `results/${hash}.json` };
  }
  async readResult(record, reference) {
    if (!reference || reference.path !== `results/${reference.sha256}.json` || !/^[a-f0-9]{64}$/.test(reference.sha256)) throw new ServiceError("invalid_workflow_result_reference");
    const bytes = await readFile(join(this.directory(record.id), reference.path));
    if (serviceHash(bytes) !== reference.sha256) throw new ServiceError("workflow_result_changed"); return JSON.parse(bytes);
  }
  async start(options) {
    const id = options.id ?? `workflow_${randomUUID()}`; checkedIdentity(id);
    if (this.starting.has(id)) await this.starting.get(id);
    const pending = this.create({ ...options, id }); this.starting.set(id, pending);
    try { return await pending; } finally { if (this.starting.get(id) === pending) this.starting.delete(id); }
  }
  async create({ id, agentId, deliveryVersion, scopeId = "private", definition, input, signal, context }) {
    if (this.closed) throw new ServiceError("workflow_controller_closed");
    [agentId, deliveryVersion, scopeId].forEach(checkedIdentity); definition = validateWorkflowDefinition(definition);
    const existing = await readJSON(join(this.directory(id), "record.json"));
    if (existing) {
      if (existing.agentId !== agentId || existing.deliveryVersion !== deliveryVersion || existing.scopeId !== scopeId || existing.definitionHash !== serviceHash(definition) || existing.inputRef?.sha256 !== serviceHash(JSON.stringify(input))) throw new ServiceError("workflow_request_conflict");
      return this.get(id);
    }
    const record = { schemaVersion: 1, id, agentId, deliveryVersion, scopeId, definition, definitionHash: serviceHash(definition), status: "pending", createdAt: new Date().toISOString(), steps: definition.steps.map((step) => ({ id: step.id, status: "pending", items: [], responseRef: null })), waiting: null, resultRefs: {} };
    await privateDirectory(this.directory(record.id)); record.inputRef = await this.resultFile(record, input); await this.save(record);
    return this.execute(record, { signal, context });
  }
  async resume({ id, input, resolution, signal, context }) {
    if (this.running.has(id)) throw new ServiceError("workflow_busy");
    const record = await this.get(id);
    if (!["pending", "waiting_input", "interrupted", "needs_review", "failed"].includes(record.status)) throw new ServiceError("workflow_cannot_resume");
    if (record.status === "waiting_input") {
      const step = record.definition.steps.find((item) => item.id === record.waiting.stepId), state = record.steps.find((item) => item.id === step.id);
      validateActionValue(input, step.waitForInput.inputSchema); state.responseRef = await this.resultFile(record, input); state.status = "pending"; record.waiting = null;
    } else if (record.status === "needs_review") {
      if (!resolution || resolution.stepId !== record.waiting?.stepId || resolution.index !== record.waiting?.index) throw new ServiceError("workflow_resolution_required", "请先核实外部操作是否已经发生，再决定补记结果或重新执行");
      const state = record.steps.find((item) => item.id === resolution.stepId), item = state.items[resolution.index];
      if (resolution.outcome === "completed") { item.resultRef = await this.resultFile(record, resolution.output); item.status = "completed"; }
      else if (resolution.outcome === "retry" && resolution.explicitlyApproved === true) { item.status = "pending"; item.explicitRetry = true; }
      else throw new ServiceError("invalid_workflow_resolution");
      state.status = "pending"; record.waiting = null;
    } else {
      for (const state of record.steps) for (const item of state.items) if (["failed", "running"].includes(item.status)) {
        const step = record.definition.steps.find((entry) => entry.id === state.id);
        if (!step.idempotent) throw new ServiceError("workflow_resolution_required");
        item.status = "pending"; state.status = "pending";
        // A deliberate continuation may retry an interrupted idempotent attempt once.
        // Keep the recorded attempt count; ordinary failures still exhaust their budget.
        if (record.status === "interrupted") item.explicitRetry = true;
      }
    }
    record.status = "pending"; await this.save(record); return this.execute(record, { signal, context });
  }
  async execute(record, { signal, context } = {}) {
    if (this.closed) throw new ServiceError("workflow_controller_closed");
    if (this.running.has(record.id)) throw new ServiceError("workflow_busy");
    const controller = new AbortController(), abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    const run = this.advance(record, { signal: controller.signal, context }); this.running.set(record.id, { controller, run });
    try { return await run; } finally { signal?.removeEventListener("abort", abort); this.running.delete(record.id); }
  }
  async advance(record, { signal, context }) {
    const input = await this.readResult(record, record.inputRef); record.status = "running"; await this.save(record);
    try {
      while (true) {
        signal.throwIfAborted();
        const pending = record.definition.steps.find((step) => record.steps.find((state) => state.id === step.id).status !== "completed" && step.dependsOn.every((id) => record.steps.find((state) => state.id === id).status === "completed"));
        if (!pending) {
          if (record.steps.some((state) => state.status !== "completed")) throw new ServiceError("workflow_dependency_blocked");
          record.status = "completed"; record.resultRefs = Object.fromEntries(record.definition.outputs.map((id) => [id, record.steps.find((state) => state.id === id).resultRef])); await this.save(record); return structuredClone(record);
        }
        const state = record.steps.find((item) => item.id === pending.id);
        if (pending.waitForInput && !state.responseRef) {
          record.status = "waiting_input"; record.waiting = { stepId: pending.id, prompt: pending.waitForInput.prompt, inputSchema: pending.waitForInput.inputSchema }; state.status = "waiting_input"; await this.save(record); return structuredClone(record);
        }
        const outputs = {};
        for (const id of pending.dependsOn) outputs[id] = await this.readResult(record, record.steps.find((entry) => entry.id === id).resultRef);
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
            item.explicitRetry = false; item.attempts++; item.status = "running"; state.status = "running"; await this.save(record);
            const args = resolveInput(pending.input ?? { $input: "" }, { input, outputs, item: items[item.index], response });
            let result;
            try { result = await this.runAction({ agentId: record.agentId, deliveryVersion: record.deliveryVersion, scopeId: record.scopeId, actionId: pending.actionId, input: args, signal, context, workflowId: record.id, stepId: pending.id, itemIndex: item.index }); }
            catch (error) { result = { status: "error", reason: signal.aborted ? "cancelled" : error.reason ?? "workflow_action_error" }; }
            if (result.status === "passed" && !signal.aborted) { item.resultRef = await this.resultFile(record, result.output); item.status = "completed"; await this.save(record); continue; }
            item.reason = result.reason ?? "workflow_action_failed"; item.status = "failed";
            if (!pending.idempotent) { record.status = "needs_review"; state.status = "needs_review"; record.waiting = { stepId: pending.id, index: item.index, reason: item.reason }; await this.save(record); return structuredClone(record); }
            if (signal.aborted) throw new ServiceError("cancelled");
            await this.save(record);
          }
        }
        state.resultRef = await this.resultFile(record, pending.batch ? await Promise.all(state.items.map((item) => this.readResult(record, item.resultRef))) : await this.readResult(record, state.items[0].resultRef));
        state.status = "completed"; await this.save(record);
      }
    } catch (error) { record.status = signal.aborted ? "interrupted" : "failed"; record.reason = signal.aborted ? "cancelled" : error.reason ?? "workflow_failed"; await this.save(record); return structuredClone(record); }
  }
  async cancel(id) { const running = this.running.get(id); if (running) { running.controller.abort(); return running.run; } const record = await this.get(id); record.status = "cancelled"; await this.save(record); return record; }
  async recover() {
    await privateDirectory(this.rootDir); const changed = [];
    for (const entry of await readdir(this.rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("workflow_")) continue;
      const record = await this.get(entry.name); if (!["running", "pending"].includes(record.status)) continue;
      record.status = "interrupted";
      for (const state of record.steps) for (const item of state.items) if (item.status === "running") {
        const step = record.definition.steps.find((entry) => entry.id === state.id);
        if (!step.idempotent) { record.status = "needs_review"; state.status = "needs_review"; record.waiting = { stepId: step.id, index: item.index, reason: "execution_interrupted" }; }
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
