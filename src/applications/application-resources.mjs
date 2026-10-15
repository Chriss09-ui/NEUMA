import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { extname, join } from "node:path";
import { InputError } from "../requirements/core.mjs";
import { validateCodePath } from "../development/development-workspace.mjs";

const TYPES = new Map(Object.entries({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2" }));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const scriptJson = (value) => JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");

async function resourceBytes(root, resource) {
  validateCodePath(resource.path);
  let path = root;
  if (await realpath(root) !== root) throw new InputError("应用资源目录无效");
  for (const segment of resource.path.split("/")) {
    path = join(path, segment);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new InputError("应用资源不允许链接");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 2 * 1024 * 1024) throw new InputError("应用资源大小或类型无效");
    const bytes = await handle.readFile();
    if (digest(bytes) !== resource.sha256) throw new InputError("应用资源与已验收版本不一致");
    return bytes;
  } finally { await handle.close(); }
}

export class ApplicationResources {
  constructor({ bridgeSource, maxInstances = 32 } = {}) {
    this.bridgeSource = bridgeSource; this.maxInstances = maxInstances; this.instances = new Map();
    this.pending = 0; this.epoch = 0; this.generations = new Map();
  }
  async open(options) {
    if (this.instances.size + this.pending >= this.maxInstances) throw new InputError("打开的应用窗口过多，请先关闭其他应用");
    const epoch = this.epoch, generation = this.generations.get(options.agentId);
    options.signal?.throwIfAborted(); this.pending++;
    try {
      const result = await this.openReserved(options);
      if (options.signal?.aborted || epoch !== this.epoch || generation !== this.generations.get(options.agentId)) {
        await this.close(options.agentId, result.instanceId);
        throw new InputError("应用打开已取消或交付版本已更新");
      }
      return result;
    } finally { this.pending--; }
  }
  async openReserved({ agentId, deliveryVersion, manifest, codeDir, parentOrigin }) {
    let parent;
    try { parent = new URL(parentOrigin); } catch { throw new InputError("应用宿主来源无效"); }
    if (parent.origin !== parentOrigin || parent.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(parent.hostname)) throw new InputError("应用只能在本机 NEUMA 内打开");
    if (!manifest?.page) throw new InputError("这个 Agent 没有应用页面");
    const resources = new Map();
    for (const resource of manifest.page.resources) {
      if (!TYPES.has(extname(resource.path).toLowerCase())) throw new InputError("应用资源类型不受支持");
      resources.set(resource.path, await resourceBytes(codeDir, resource));
    }
    if (!resources.has(manifest.page.entrypoint)) throw new InputError("应用页面入口不在交付资源清单中");
    const instanceId = randomUUID();
    const source = this.bridgeSource ?? await readFile(new URL("../../public/application-frame-bridge.js", import.meta.url), "utf8");
    const csp = `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${parentOrigin}`;
    const server = createServer((request, response) => {
      const fail = () => { response.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" }); response.end("应用资源不存在"); };
      if (!["GET", "HEAD"].includes(request.method) || request.headers.host !== new URL(instance.origin).host) return fail();
      let path;
      try { path = decodeURIComponent((request.url ?? "").split("?")[0]); } catch { return fail(); }
      if (!path.startsWith(`/${instanceId}/`)) return fail();
      path = path.slice(instanceId.length + 2);
      if (path.split("/").some((part) => ["", ".", ".."].includes(part)) || path.includes("\\")) return fail();
      let bytes = resources.get(path), type = TYPES.get(extname(path).toLowerCase());
      if (path === "neuma-frame-bridge.js") { bytes = Buffer.from(source); type = "text/javascript; charset=utf-8"; }
      if (!bytes) return fail();
      if (type.startsWith("text/html")) {
        const config = scriptJson({ parentOrigin, deliveryVersion, instanceId });
        const injection = `<script>window.__NEUMA_APPLICATION__=${config};</script><script src="/${instanceId}/neuma-frame-bridge.js"></script>`;
        const html = bytes.toString("utf8");
        // The bridge precedes generated scripts, including scripts in the page head.
        bytes = Buffer.from(/<head(?:\s[^>]*)?>/i.test(html) ? html.replace(/<head(?:\s[^>]*)?>/i, (head) => head + injection) : injection + html);
      }
      response.writeHead(200, { "content-type": type, "content-length": bytes.length, "cache-control": "no-store",
        "content-security-policy": csp, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "permissions-policy": "camera=(), microphone=(), geolocation=()" });
      response.end(request.method === "HEAD" ? undefined : bytes);
    });
    const instance = { instanceId, agentId, deliveryVersion, manifest, server, origin: "" };
    await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
    instance.origin = `http://127.0.0.1:${server.address().port}`;
    this.instances.set(instanceId, instance);
    return { instanceId, origin: instance.origin, url: `${instance.origin}/${instanceId}/${manifest.page.entrypoint}`, deliveryVersion, manifest };
  }
  assertInstance(agentId, instanceId, deliveryVersion) {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new InputError("应用页面实例已关闭，请重新打开页面后重试");
    if (instance.agentId !== agentId) throw new InputError("应用页面实例属于其他 Agent");
    if (instance.deliveryVersion !== deliveryVersion) throw new InputError("应用页面实例的交付版本已变化，请重新打开页面");
    return { instanceId: instance.instanceId, agentId: instance.agentId, deliveryVersion: instance.deliveryVersion };
  }
  async close(agentId, instanceId) {
    const instance = this.instances.get(instanceId);
    if (!instance) return { closed: false };
    if (instance.agentId !== agentId) throw new InputError("应用资源实例属于其他 Agent");
    this.instances.delete(instanceId);
    await new Promise((done) => { instance.server.close(done); instance.server.closeAllConnections(); });
    return { closed: true };
  }
  async closeAgent(agentId) { this.generations.set(agentId, (this.generations.get(agentId) ?? 0) + 1); await Promise.all([...this.instances.values()].filter((item) => item.agentId === agentId).map((item) => this.close(agentId, item.instanceId))); }
  async closeAll() { this.epoch++; await Promise.all([...this.instances.values()].map((item) => this.close(item.agentId, item.instanceId))); }
}
