import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import { objectFields } from "../runtime/type-boundary.mjs";
export type MaterialSpawner = (command: string, args: readonly string[], options: SpawnOptions & { stdio: ["pipe", "pipe", "pipe"] }) => ChildProcessWithoutNullStreams;
interface Task { request: unknown; signal?: AbortSignal | undefined; resolve(value: unknown): void; reject(error: unknown): void; started: boolean; abort(): void; stop(error: Error): void; done: Promise<void>; finish(): void }
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MAX_PARSER_RESPONSE, materialFailure } from "./material-formats.mjs";

const parserEntry = fileURLToPath(new URL("./material-parser-child.mjs", import.meta.url));
const cancelled = () => new DOMException("材料读取已停止", "AbortError");

export class MaterialRunner {
  concurrency: number; timeoutMs: number; entry: string; spawnProcess: MaterialSpawner; queue: Task[]; active: Set<Task>; closing: Promise<void[]> | null;
  constructor({ concurrency = 2, timeoutMs = 60_000, entry = parserEntry, spawnProcess = spawn }: { concurrency?: number; timeoutMs?: number; entry?: string; spawnProcess?: MaterialSpawner } = {}) {
    this.concurrency = concurrency; this.timeoutMs = timeoutMs; this.entry = entry; this.spawnProcess = spawnProcess;
    this.queue = []; this.active = new Set(); this.closing = null;
  }

  run(request: unknown, { signal }: { signal?: AbortSignal | undefined } = {}): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      const task: Task = { request, signal, resolve, reject, started: false, abort: () => {}, stop: () => {}, done: Promise.resolve(), finish: () => {} };
      task.abort = () => {
        if (task.started) task.stop?.(cancelled());
        else { this.queue = this.queue.filter((item) => item !== task); signal?.removeEventListener("abort", task.abort); reject(cancelled()); }
      };
      signal?.addEventListener("abort", task.abort, { once: true });
      this.queue.push(task); this.drain();
    });
  }

  drain() {
    if (this.closing) return;
    while (this.queue.length && this.active.size < this.concurrency) {
      const task = this.queue.shift()!;
      if (task.signal?.aborted) { task.abort(); continue; }
      this.start(task);
    }
  }

  start(task: Task) {
    task.started = true; this.active.add(task);
    task.done = new Promise<void>((resolve) => { task.finish = resolve; });
    let child: ChildProcessWithoutNullStreams | undefined, timeout: NodeJS.Timeout | undefined, escalation: NodeJS.Timeout | undefined, stopped: Error | undefined, chunks: Buffer[] = [], bytes = 0;
    const finish = (error?: Error | null, result?: unknown) => {
      clearTimeout(timeout); clearTimeout(escalation);
      task.signal?.removeEventListener("abort", task.abort);
      this.active.delete(task); task.finish();
      if (error) task.reject(error); else task.resolve(result);
      this.drain();
    };
    task.stop = (error) => {
      if (stopped) return;
      stopped = error;
      child?.kill("SIGTERM");
      escalation = setTimeout(() => child?.kill("SIGKILL"), 100);
      escalation.unref?.();
    };
    try {
      const env = Object.fromEntries(["PATH", "LANG", "LC_ALL", "TMPDIR", "SystemRoot"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
      child = this.spawnProcess(process.execPath, ["--max-old-space-size=256", this.entry], { stdio: ["pipe", "pipe", "pipe"], env, windowsHide: true });
      child.stdout.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_PARSER_RESPONSE) { task.stop(materialFailure("material_output_limit", "解析结果超过大小限制，请拆分文件后重试")); return; }
        chunks.push(chunk);
      });
      child.stderr.resume();
      child.stdin.on("error", () => task.stop(materialFailure("material_parser_failed", "文件解析进程无法接收材料")));
      child.on("error", () => { stopped ||= materialFailure("material_parser_failed", "无法启动文件解析进程"); });
      child.once("close", (code) => {
        if (stopped) return finish(stopped);
        if (code !== 0) return finish(materialFailure("material_parser_failed", "文件解析未完成，请检查文件是否损坏或加密"));
        let payload: Record<string, unknown>;
        try { payload = objectFields(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { return finish(materialFailure("material_parser_failed", "文件解析返回了无效结果")); }
        chunks = [];
        if (payload?.ok !== true || !payload.result || typeof payload.result !== "object")
          return finish(materialFailure(typeof payload?.reason === "string" ? payload.reason : "material_parser_failed", typeof payload?.message === "string" ? payload.message : "文件无法解析，请检查文件是否损坏或加密"));
        finish(null, payload.result);
      });
      timeout = setTimeout(() => task.stop(materialFailure("material_timeout", "文件解析超过 60 秒，请拆分文件后重试")), this.timeoutMs);
      timeout.unref?.();
      child.stdin.end(JSON.stringify(task.request));
      if (task.signal?.aborted) task.stop(cancelled());
    } catch { finish(materialFailure("material_parser_failed", "无法启动文件解析进程")); }
  }

  async close(): Promise<void[] | undefined> {
    if (this.closing) return this.closing;
    const queued = this.queue.splice(0);
    for (const task of queued) { task.signal?.removeEventListener("abort", task.abort); task.reject(cancelled()); }
    const active = [...this.active];
    this.closing = Promise.all(active.map((task) => { task.stop(cancelled()); return task.done; }));
    try { await this.closing; } finally { this.closing = null; this.drain(); }
  }
}
