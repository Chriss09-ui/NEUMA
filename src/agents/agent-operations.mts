import { createHash, randomUUID } from "node:crypto";
import type { JsonStoragePort } from "../runtime/storage-port.mjs";
import type { Progress } from "../runtime/execution-port.mjs";
import { operationView } from "../runtime/operation-view.mjs";
import { InputError } from "../requirements/core.mjs";
import { objectFields } from "../runtime/type-boundary.mjs";

type Kind = "build" | "development";
interface Receipt { version: 1; id: string; kind: Kind; generation: string; inputHash: string; revision: number;
  acceptedAt: string; settledAt?: string; error?: string; architectureVersion?: number; developmentId?: string; phase?: string; label?: string }
interface Running { receipt: Receipt; controller: AbortController; done: Promise<void> }
interface Owner {
  storage: JsonStoragePort;
  build(input: unknown, options: { signal: AbortSignal; onProgress: Progress }): Promise<unknown>;
  develop(id: string, options: { resume: boolean; signal: AbortSignal; onProgress: Progress }): Promise<unknown>;
  snapshot(id: string, receipt: Pick<Receipt, "architectureVersion" | "developmentId">): Promise<unknown>;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const identity = (value: unknown): string => {
  if (typeof value !== "string" || !/^[\w-]{1,100}$/.test(value)) throw new InputError("任务标识无效"); return value;
};
/** Transport receipts locate domain records. They never approve architecture or delivery. */
export class AgentOperations {
  private active = new Map<string, Running>();
  private queues = new Map<string, Promise<unknown>>();
  private closed = false;
  constructor(private readonly owner: Owner) {}
  private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const task = (this.queues.get(id) ?? Promise.resolve()).then(work);
    const settled = task.then(() => {}, () => {}); this.queues.set(id, settled);
    void settled.then(() => { if (this.queues.get(id) === settled) this.queues.delete(id); }); return task;
  }
  private file(id: string) { return `operations/${identity(id)}.json`; }
  async read(agentId: string, id: string): Promise<Receipt> {
    const value = objectFields(await this.owner.storage.readJson(identity(agentId), this.file(id)));
    if (value.version !== 1 || value.id !== id || !["build", "development"].includes(String(value.kind))
      || typeof value.generation !== "string" || typeof value.inputHash !== "string" || !/^[a-f0-9]{64}$/.test(value.inputHash)
      || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || typeof value.acceptedAt !== "string"
      || value.settledAt !== undefined && typeof value.settledAt !== "string"
      || value.error !== undefined && typeof value.error !== "string"
      || value.architectureVersion !== undefined && !Number.isSafeInteger(value.architectureVersion)
      || value.developmentId !== undefined && typeof value.developmentId !== "string") throw new InputError("任务回执不存在或已损坏");
    return value as unknown as Receipt;
  }
  async submit(agentId: string, kind: Kind, input: unknown, mutationId: unknown, signal?: AbortSignal) {
    identity(agentId); const id = identity(mutationId), inputHash = hash([kind, input]);
    await this.serial(agentId, async () => {
      signal?.throwIfAborted(); if (this.closed) throw new InputError("服务正在关闭");
      const existing = await this.owner.storage.readJson(agentId, this.file(id));
      if (existing) {
        const receipt = await this.read(agentId, id);
        if (receipt.inputHash !== inputHash || receipt.kind !== kind) throw new InputError("同一请求编号不能用于不同任务");
        return;
      }
      if (this.active.has(agentId)) throw new InputError("这个智能体已有制作任务，请先查看或停止");
      const receipt: Receipt = { version: 1, id, kind, generation: randomUUID(), inputHash, revision: 1, acceptedAt: new Date().toISOString() };
      await this.owner.storage.writeJson(agentId, this.file(id), receipt);
      await this.owner.storage.writeJson(agentId, "operations/current.json", { version: 1, id, generation: receipt.generation });
      // A receipt is durable before background work starts. A lost response can only rediscover it.
      const running: Running = { receipt, controller: new AbortController(), done: Promise.resolve() };
      this.active.set(agentId, running);
      running.done = this.execute(agentId, input, running);
      void running.done.catch(() => {});
    });
    return this.view(agentId, id);
  }
  private async execute(agentId: string, input: unknown, running: Running) {
    const { receipt, controller } = running;
    let progress = Promise.resolve();
    const onProgress: Progress = event => {
      if (controller.signal.aborted || event.type !== "status") return;
      const phase = typeof event.phase === "string" ? event.phase : undefined, label = typeof event.label === "string" ? event.label.slice(0, 500) : undefined;
      if (phase === receipt.phase && label === receipt.label) return;
      progress = progress.then(async () => {
        Object.assign(receipt, { phase, label }); receipt.revision++;
        await this.owner.storage.writeJson(agentId, this.file(receipt.id), receipt);
      });
      void progress.catch(() => controller.abort());
    };
    try {
      const result = objectFields(await (receipt.kind === "build" ? this.owner.build(input, { signal: controller.signal, onProgress })
        : this.owner.develop(agentId, { resume: objectFields(input).resume === true, signal: controller.signal, onProgress })));
      await progress;
      const architecture = objectFields(result.architecture), development = objectFields(result.development);
      if (Number.isSafeInteger(architecture.version)) receipt.architectureVersion = architecture.version as number;
      if (typeof development.id === "string") receipt.developmentId = development.id;
    } catch (error) {
      await progress.catch(() => {});
      receipt.error = controller.signal.aborted ? "任务已停止，已保存进度保留" : error instanceof InputError ? error.message : "任务未完成，请查看已保存的设计与研发进度";
    } finally {
      try {
        const result = objectFields(await this.owner.snapshot(agentId, receipt));
        const architecture = objectFields(result.architecture), development = objectFields(result.development);
        if (receipt.architectureVersion === undefined && Number.isSafeInteger(architecture.version)) receipt.architectureVersion = architecture.version as number;
        if (receipt.developmentId === undefined && typeof development.id === "string") receipt.developmentId = development.id;
      } catch { /* Preserve the execution error; viewing will still validate the domain stores. */ }
      receipt.settledAt = new Date().toISOString(); receipt.revision++;
      try { await this.owner.storage.writeJson(agentId, this.file(receipt.id), receipt); }
      finally { if (this.active.get(agentId) === running) this.active.delete(agentId); }
    }
  }
  async view(agentId: string, id: string, after?: string | null) {
    const receipt = await this.read(agentId, id), active = this.active.get(agentId);
    const result = await this.owner.snapshot(agentId, receipt);
    const running = active?.receipt.generation === receipt.generation;
    const snapshot = { running, interrupted: !running && !receipt.settledAt, error: receipt.error ?? null,
      phase: receipt.phase, label: receipt.label, result };
    // Domain writes and the receipt can commit separately; the cursor binds the entire read view.
    return operationView({ version: 1, domain: receipt.kind, ownerId: agentId, operationId: id, generation: receipt.generation }, hash(snapshot), snapshot, after);
  }
  async current(agentId: string) {
    const value = await this.owner.storage.readJson(identity(agentId), "operations/current.json");
    if (!value) return null;
    const pointer = objectFields(value);
    if (pointer.version !== 1 || typeof pointer.id !== "string" || typeof pointer.generation !== "string") throw new InputError("任务索引无效");
    const view = await this.view(agentId, pointer.id);
    if (view.operation.generation !== pointer.generation) throw new InputError("任务索引绑定不一致");
    return { ...view.operation, running: view.snapshot!.running };
  }
  async cancel(agentId: string, id: string, generation: string) {
    const receipt = await this.read(agentId, id), running = this.active.get(agentId);
    if (receipt.generation !== generation || running && running.receipt.generation !== generation) throw new InputError("任务已变化，旧窗口不能停止新任务");
    running?.controller.abort(); await running?.done; return this.view(agentId, id);
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.queues.values()]);
    for (const running of this.active.values()) running.controller.abort();
    await Promise.allSettled([...this.active.values()].map(running => running.done));
    this.closed = false;
  }
}
