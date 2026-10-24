interface Lease { signal: AbortSignal; release(): void }
interface QueueItem { agentId: string; controller: AbortController; resolve(lease: Lease): void; reject(error: unknown): void; started: boolean; abort(): void; cleanup(): void }
import { InputError } from "../requirements/core.mjs";

const cancelled = () => new DOMException("Agent execution cancelled", "AbortError");

export class AgentScheduler {
  concurrency: number; maxPending: number; pending: QueueItem[]; running: Set<QueueItem>; activeAgents: Set<string>;
  constructor({ concurrency = 2, maxPending = 128 } = {}) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || !Number.isSafeInteger(maxPending) || maxPending < 1)
      throw new InputError("Agent 调度配置无效");
    this.concurrency = concurrency;
    this.maxPending = maxPending;
    this.pending = [];
    this.running = new Set();
    this.activeAgents = new Set();
  }

  acquire({ agentId, signal }: { agentId?: string; signal?: AbortSignal | undefined } = {}): Promise<Lease> {
    if (typeof agentId !== "string" || !/^[\w-]{1,80}$/.test(agentId)) return Promise.reject(new InputError("Agent 标识无效"));
    if (signal?.aborted) return Promise.reject(cancelled());
    if (this.pending.length >= this.maxPending) return Promise.reject(new InputError("等待中的 Agent 任务过多，请稍后重试"));
    return new Promise<Lease>((resolve, reject) => {
      const controller = new AbortController();
      const item: QueueItem = { agentId, controller, resolve, reject, started: false, abort: () => {}, cleanup: () => {} };
      item.abort = () => {
        controller.abort();
        if (item.started) return;
        this.pending = this.pending.filter((entry) => entry !== item);
        signal?.removeEventListener("abort", item.abort);
        reject(cancelled());
        this.drain();
      };
      item.cleanup = () => signal?.removeEventListener("abort", item.abort);
      signal?.addEventListener("abort", item.abort, { once: true });
      this.pending.push(item);
      this.drain();
    });
  }

  drain() {
    while (this.running.size < this.concurrency) {
      // A queued task for a busy Agent must not hold a slot needed by another Agent.
      const index = this.pending.findIndex((item) => !this.activeAgents.has(item.agentId));
      if (index < 0) return;
      const item = this.pending.splice(index, 1)[0]!;
      item.started = true;
      this.running.add(item);
      this.activeAgents.add(item.agentId);
      let released = false;
      item.resolve({ signal: item.controller.signal, release: () => {
        if (released) return;
        released = true;
        item.cleanup();
        this.running.delete(item);
        this.activeAgents.delete(item.agentId);
        this.drain();
      } });
    }
  }

  cancelAgent(agentId: string) {
    for (const item of [...this.pending, ...this.running]) if (item.agentId === agentId) item.abort();
  }

  cancelAll() {
    for (const item of [...this.pending, ...this.running]) item.abort();
  }

  snapshot() {
    return { running: this.running.size, queued: this.pending.length, agentIds: [...this.activeAgents] };
  }
}
