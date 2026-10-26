import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MainStore } from "../../src/main/main-store.mjs";
import { operationView } from "../../src/runtime/operation-view.mjs";

const root = await mkdtemp(join(tmpdir(), "neuma-view-benchmark-"));
try {
  for (const bytes of [4096, 1024 * 1024, 30 * 1024 * 1024]) {
    const store = new MainStore({ dataDir: join(root, String(bytes)) });
    const record = await store.create();
    await store.update(record.id, next => { next.messages.push({ id: "synthetic", role: "assistant", content: "x".repeat(bytes), status: "complete",
      sources: [], actions: [], createdAt: next.createdAt, updatedAt: next.updatedAt }); });
    const times: number[] = [], rss = process.memoryUsage().rss;
    let encoded = 0;
    for (let sample = 0; sample < 5; sample++) {
      const start = performance.now(), snapshot = await store.get(record.id);
      encoded = Buffer.byteLength(JSON.stringify(operationView({ version: 1, domain: "main", ownerId: record.id, operationId: "synthetic", generation: "synthetic" }, snapshot.version, snapshot)));
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const retainedRssMiB = Math.max(0, process.memoryUsage().rss - rss) / 1024 / 1024;
    const medianMs = times[2]!;
    process.stdout.write(JSON.stringify({ sourceBytes: bytes, encodedBytes: encoded, medianMs: +medianMs.toFixed(2), maxMs: +times.at(-1)!.toFixed(2), retainedRssMiB: +retainedRssMiB.toFixed(2) }) + "\n");
    if (medianMs > 1500 || retainedRssMiB > 512) throw new Error("合成查看基线超过本地回归门槛（1.5秒 / 512MiB）");
  }
} finally { await rm(root, { recursive: true, force: true }); }
