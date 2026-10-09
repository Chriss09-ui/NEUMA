import { createHash } from "node:crypto";
import { createServer, request } from "node:http";
import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export class DataDirectoryBusyError extends Error {
  constructor(instance) {
    super("这个数据目录正在被另一个 NEUMA 进程使用，请先关闭它。");
    this.code = "NEUMA_DATA_BUSY";
    this.instance = instance;
  }
}

export async function canonicalDataDirectory(path) {
  let current = resolve(path);
  const missing = [];
  for (;;) {
    try { return join(await realpath(current), ...missing.reverse()); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current));
      current = parent;
    }
  }
}

function readOwner(port, key) {
  return new Promise((done) => {
    const client = request({ hostname: "127.0.0.1", port, path: `/_neuma/lock/${key}`,
      method: "GET", agent: false, timeout: 1000 }, (response) => {
      let bytes = 0;
      const chunks = [];
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 4096) response.destroy();
        else chunks.push(chunk);
      });
      response.on("error", () => done(null));
      response.on("end", () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          done(response.statusCode === 200 && value.protocol === "neuma-data-lock/1" && value.dataKey === key ? value.instance : null);
        } catch { done(null); }
      });
    });
    const deadline = setTimeout(() => client.destroy(new Error("实例探测超时")), 1000);
    client.once("close", () => clearTimeout(deadline));
    client.on("timeout", () => client.destroy());
    client.on("error", () => done(null));
    client.end();
  });
}

// A kernel-owned loopback listener avoids stale files and stays outside directories
// that migration replaces. Hash collisions fail closed instead of taking another lock.
export async function acquireDataLock(dataDir, { purpose = "service", instance = {} } = {}) {
  const canonical = await canonicalDataDirectory(dataDir);
  const identity = process.platform === "linux" ? canonical : canonical.toLowerCase();
  const digest = createHash("sha256").update(identity).digest();
  const key = digest.toString("hex");
  const port = 49152 + digest.readUInt16BE(0) % 16384;
  let info = { ...instance, pid: process.pid, purpose, state: "starting" };
  const server = createServer((req, res) => {
    if (req.method !== "GET" || req.url !== `/_neuma/lock/${key}`) {
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ protocol: "neuma-data-lock/1", dataKey: key, instance: info }));
  });
  server.maxConnections = 8;
  server.headersTimeout = 2000;
  server.requestTimeout = 2000;
  server.keepAliveTimeout = 1;
  try {
    await new Promise((done, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
        server.removeListener("error", reject); done();
      });
    });
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
    const owner = await readOwner(port, key);
    if (owner) throw new DataDirectoryBusyError(owner);
    throw new Error("NEUMA 数据锁使用的本机端口被占用，无法安全启动；请稍后重试或使用另一个数据目录。");
  }
  server.on("error", () => {});
  let release;
  return {
    dataDir: canonical,
    get info() { return { ...info }; },
    update(next) { info = { ...info, ...next }; },
    release() {
      release ??= new Promise((done, reject) => {
        server.close((error) => error ? reject(error) : done());
        server.closeAllConnections();
      });
      return release;
    },
  };
}
