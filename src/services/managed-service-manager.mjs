import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { isDeepStrictEqual } from "node:util";
import { inspectDevelopmentCode } from "../development/development-workspace.mjs";
import { validateActionInput, validateActionOutput } from "../applications/application-contract.mjs";
import { checkedIdentity, ServiceError, serviceHash, validateServiceManifest } from "./service-contract.mjs";
import { atomicJSON, directoryBytes, inside, privateDirectory, readJSON } from "./service-files.mjs";
import { cleanServiceEnvironment, commandResult, killProcessGroup, managedSandboxProfile } from "./service-process.mjs";
import { ServiceRuntimeStore } from "./service-runtime.mjs";
import { resolveNodeDependencies, resolvePythonDependencies } from "./service-dependencies.mjs";
import { DockerServiceRuntime } from "./service-docker.mjs";
import { resolveDockerImage } from "./service-image-resolution.mjs";

const WORKER_DIR = dirname(fileURLToPath(import.meta.url));
const identityKey = ({ agentId, deliveryVersion, scopeId = "private" }) => serviceHash([checkedIdentity(agentId), checkedIdentity(deliveryVersion), checkedIdentity(scopeId)]);
const deliveryKey = ({ agentId, deliveryVersion }) => serviceHash([checkedIdentity(agentId), checkedIdentity(deliveryVersion)]);
const clone = structuredClone;
const failed = (reason) => ({ status: "error", reason, output: null });
const nodeProbe = (paths) => `import fs from 'node:fs';import net from 'node:net';import{spawnSync}from'node:child_process';
const denied=fn=>{try{fn();return false}catch(e){return ['EPERM','EACCES','EXDEV'].includes(e.code)}};
const p=${JSON.stringify(paths)};fs.writeFileSync(p.scratch+'/allowed','yes');
const networkDenied=await new Promise(resolve=>{const s=net.createServer();s.once('error',e=>resolve(['EPERM','EACCES'].includes(e.code)));s.listen(0,'127.0.0.1',()=>s.close(()=>resolve(false)))});
const child=spawnSync(process.execPath,['-e','process.exit(0)'],{timeout:1000});
let linkDenied=false;try{fs.symlinkSync(p.secret,p.scratch+'/link');linkDenied=denied(()=>fs.readFileSync(p.scratch+'/link'))}catch(e){linkDenied=['EPERM','EACCES'].includes(e.code)};
console.log(JSON.stringify({outsideRead:denied(()=>fs.readFileSync(p.secret)),outsideWrite:denied(()=>fs.writeFileSync(p.outside+'/bad','bad')),codeWrite:denied(()=>fs.writeFileSync(p.code+'/bad','bad')),hardlink:denied(()=>fs.linkSync(p.secret,p.scratch+'/hard')),metadata:denied(()=>fs.chmodSync(p.secret,0o600)),symlink:linkDenied,network:networkDenied,subprocess:['EPERM','EACCES'].includes(child.error?.code),scratch:fs.readFileSync(p.scratch+'/allowed','utf8')==='yes'}));`;
const pythonProbe = (paths) => `import os,json,socket,subprocess,sys
p=json.loads(${JSON.stringify(JSON.stringify(paths))})
def denied(fn):
 try: fn(); return False
 except OSError as e: return e.errno in (1,13,18)
with open(p['scratch']+'/allowed','w') as f:f.write('yes')
def net():
 s=socket.socket(); s.bind(('127.0.0.1',0)); s.close()
def child():subprocess.run([sys.executable,'-I','-S','-c','pass'],timeout=1,check=True)
def link():
 os.symlink(p['secret'],p['scratch']+'/link'); open(p['scratch']+'/link').read()
print(json.dumps({'outsideRead':denied(lambda:open(p['secret']).read()),'outsideWrite':denied(lambda:open(p['outside']+'/bad','w').write('bad')),'codeWrite':denied(lambda:open(p['code']+'/bad','w').write('bad')),'hardlink':denied(lambda:os.link(p['secret'],p['scratch']+'/hard')),'metadata':denied(lambda:os.chmod(p['secret'],384)),'symlink':denied(link),'network':denied(net),'subprocess':denied(child),'scratch':open(p['scratch']+'/allowed').read()=='yes'}))`;

class ServiceWorker {
  constructor({ child, record, scratchDir, docker, dockerName, onExit }) {
    Object.assign(this, { child, record, scratchDir, docker, dockerName, onExit });
    this.active = null; this.ready = false; this.stopped = false; this.lines = ""; this.log = ""; this.tail = Promise.resolve(); this.messageTail = Promise.resolve();
    this.decoder = new StringDecoder("utf8"); this.logDecoder = new StringDecoder("utf8"); this.logWindow = { started: Date.now(), bytes: 0 };
    this.readyPromise = new Promise((resolveReady, rejectReady) => { this.resolveReady = resolveReady; this.rejectReady = rejectReady; });
    this.readyPromise.catch(() => {});
    this.closed = new Promise((resolveClosed) => { this.resolveClosed = resolveClosed; });
    child.stdout.on("data", (bytes) => this.receive(bytes));
    child.stderr.on("data", (bytes) => {
      if (Date.now() - this.logWindow.started >= 1000) this.logWindow = { started: Date.now(), bytes: 0 };
      this.logWindow.bytes += bytes.length;
      if (this.logWindow.bytes > record.manifest.resources.logBytes) { this.stop("service_log_limit"); return; }
      this.log += this.logDecoder.write(bytes); this.log = this.log.slice(-record.manifest.resources.logBytes);
      if (this.active) { this.active.outputBytes += bytes.length; if (this.active.outputBytes > record.manifest.resources.logBytes + 2 * 1024 * 1024) this.stop("service_output_limit"); }
    });
    child.stdin.on("error", () => {});
    child.on("error", () => this.stop("service_spawn_failed"));
    child.on("close", () => {
      this.stopped = true; this.clearMonitor(); this.failActive(this.stopReason ?? "service_exited"); this.rejectReady(new ServiceError(this.stopReason ?? "service_exited"));
      this.onExit(this); this.resolveClosed();
    });
    this.startupTimer = setTimeout(() => this.stop("service_start_timeout"), 10000);
    if (!dockerName) {
      let checking = false;
      this.monitor = setInterval(async () => {
        if (checking || this.stopped) return; checking = true;
        try {
          const sample = await commandResult("/bin/ps", ["-o", "rss=", "-p", String(child.pid)], { timeoutMs: 2000 });
          if (sample.code === 0 && Number(sample.stdout.trim()) > record.manifest.resources.memoryMiB * 1024) this.stop("service_memory_limit");
          await directoryBytes(scratchDir, { maxBytes: record.manifest.resources.scratchMiB * 1024 * 1024 });
        } catch (error) { if (!this.stopped) this.stop(["service_disk_limit", "service_symlink_denied", "unsafe_service_file", "service_file_limit"].includes(error.reason) ? error.reason : "service_resource_monitor_failed"); }
        finally { checking = false; }
      }, 500); this.monitor.unref();
    }
  }
  clearMonitor() { clearTimeout(this.startupTimer); clearInterval(this.monitor); }
  send(message) {
    if (this.stopped || this.child.stdin.destroyed) throw new ServiceError("service_stopped");
    const line = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(line) > 2 * 1024 * 1024) throw new ServiceError("service_message_limit");
    this.child.stdin.write(line);
  }
  receive(bytes) {
    this.lines += this.decoder.write(bytes);
    if (Buffer.byteLength(this.lines) > 2 * 1024 * 1024) { this.stop("service_message_limit"); return; }
    if (this.active) { this.active.outputBytes += bytes.length; if (this.active.outputBytes > this.record.manifest.resources.logBytes + 4 * 1024 * 1024) { this.stop("service_output_limit"); return; } }
    for (let newline; (newline = this.lines.indexOf("\n")) >= 0;) {
      const line = this.lines.slice(0, newline); this.lines = this.lines.slice(newline + 1);
      let message; try { message = JSON.parse(line); } catch { this.stop("invalid_service_protocol"); return; }
      this.messageTail = this.messageTail.then(() => this.handle(message)).catch(() => this.stop("invalid_service_protocol"));
    }
  }
  async handle(message) {
    if (message.type === "ready" && !this.ready && !this.active && message.protocolVersion === 1) { this.ready = true; clearTimeout(this.startupTimer); this.resolveReady(); return; }
    const active = this.active;
    if (!active || message.requestId !== active.id || ++active.messages > 10000) throw new ServiceError("invalid_service_protocol");
    if (message.type === "progress") { await active.onProgress?.(clone(message.value)); return; }
    if (message.type === "call") {
      if (typeof message.id !== "string" || active.callIds.has(message.id) || active.callIds.size >= 1000 || !this.record.manifest.capabilities.includes(message.capability)) throw new ServiceError("unapproved_service_capability");
      active.callIds.add(message.id); active.inflight++;
      try {
        if (["connection.call", "connection.readResult"].includes(message.capability)) {
          const id = message.args?.connectionId ?? message.args?.id;
          if (!active.operation.connectionIds?.includes(id)) throw new ServiceError("unapproved_service_connection");
        }
        if (typeof active.capabilityHandler !== "function") throw new ServiceError("service_capability_unavailable");
        const value = await active.capabilityHandler(message.capability, clone(message.args ?? {}), { signal: active.controller.signal, requestId: active.id });
        if (this.active === active && !active.controller.signal.aborted) this.send({ type: "reply", requestId: active.id, id: message.id, ok: true, value: value ?? null });
      } catch (error) {
        if (this.active === active && !active.controller.signal.aborted) this.send({ type: "reply", requestId: active.id, id: message.id, ok: false, error: "能力调用失败", reason: /^[a-z_]{1,80}$/.test(error.reason ?? "") ? error.reason : "capability_failed" });
      } finally { active.inflight--; }
      return;
    }
    if (message.type !== "result" || active.inflight) throw new ServiceError("invalid_service_protocol");
    this.active = null; clearTimeout(active.timer); active.signal?.removeEventListener("abort", active.abort); active.controller.abort();
    if (message.ok !== true) { active.resolve({ status: "failed", reason: message.reason ?? "action_failed", output: null }); return; }
    try { const output = validateActionOutput(active.operation, message.value); active.resolve({ status: "passed", output }); }
    catch { active.resolve({ status: "failed", reason: "service_output_contract", output: null }); }
  }
  failActive(reason) {
    if (!this.active) return; const active = this.active; this.active = null;
    clearTimeout(active.timer); active.signal?.removeEventListener("abort", active.abort); active.controller.abort(); active.resolve(failed(reason));
  }
  async stop(reason = "service_stopped") {
    if (this.stopped) return this.closed;
    this.stopReason ??= reason; this.stopped = true; this.clearMonitor(); this.failActive(this.stopReason); this.rejectReady(new ServiceError(this.stopReason));
    killProcessGroup(this.child); if (this.dockerName) await this.docker.stop(this.dockerName);
    return this.closed;
  }
  run({ actionId, input, signal, capabilityHandler, onProgress }) {
    const perform = async () => {
      if (signal?.aborted) return failed("cancelled");
      await this.readyPromise; if (this.stopped) return failed(this.stopReason ?? "service_stopped");
      const operation = this.record.manifest.operations.find((item) => item.id === actionId);
      if (!operation) throw new ServiceError("unknown_service_operation");
      input = validateActionInput(operation, input);
      return new Promise((resolveRun) => {
        const active = { id: randomUUID(), resolve: resolveRun, operation, signal, capabilityHandler, onProgress, controller: new AbortController(), callIds: new Set(), inflight: 0, outputBytes: 0, messages: 0 };
        active.abort = () => this.stop("cancelled"); this.active = active;
        active.timer = setTimeout(() => this.stop("service_timeout"), this.record.manifest.resources.timeoutMs);
        signal?.addEventListener("abort", active.abort, { once: true });
        if (signal?.aborted) active.abort();
        else try { this.send({ type: "run", protocolVersion: 1, requestId: active.id, actionId, input }); } catch { this.stop("service_channel_failed"); }
      });
    };
    const result = this.tail.catch(() => {}).then(perform); this.tail = result; return result;
  }
}

/** Managed workers have no direct network, credentials, host files, or child-process access. */
export class ManagedServiceManager {
  constructor({ rootDir, nodePath = process.execPath, platform = process.platform, arch = process.arch, sandboxPath = "/usr/bin/sandbox-exec", dockerPath = "docker", runtimeStore, capabilityHandler, onProgress = () => {}, fetchImpl = fetch } = {}) {
    if (!rootDir) throw new TypeError("rootDir is required");
    Object.assign(this, { rootDir: resolve(rootDir), nodePath, platform, arch, sandboxPath, capabilityHandler, onProgress, fetchImpl });
    this.runtimeStore = runtimeStore ?? new ServiceRuntimeStore({ rootDir: join(this.rootDir, "environments"), nodePath, platform, arch, sandboxPath, fetchImpl });
    this.docker = new DockerServiceRuntime({ dockerPath, ownerId: serviceHash(this.rootDir).slice(0, 32) });
    this.workers = new Map(); this.starting = new Map(); this.preparing = new Map(); this.probes = new Map(); this.logsCache = new Map(); this.tail = Promise.resolve(); this.closed = false; this.lifecycle = new AbortController();
  }
  async catalog() { return await readJSON(join(this.rootDir, "catalog.json"), { schemaVersion: 1, deliveries: {}, active: {}, desired: {} }); }
  updateCatalog(update) {
    const next = this.tail.catch(() => {}).then(async () => { const catalog = await this.catalog(); await update(catalog); await atomicJSON(join(this.rootDir, "catalog.json"), catalog); return catalog; });
    this.tail = next; return next;
  }
  async environment() {
    const python = await this.runtimeStore.environment("python").catch((error) => ({ available: false, reason: error.reason ?? "python_invalid" }));
    return { managed: { available: this.platform === "darwin" && this.arch === "arm64", platform: this.platform, arch: this.arch, javascript: await this.runtimeStore.environment("javascript"), python }, docker: await this.docker.probe() };
  }
  async prepareEnvironment({ language = "javascript", host = "managed", signal, onProgress = this.onProgress }) {
    if (this.closed) throw new ServiceError("service_manager_closed"); signal = signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
    if (host === "docker") return this.docker.probe({ signal });
    const environment = await this.runtimeStore.prepare(language, { signal, onProgress });
    return { ...environment, isolation: await this.probe({ language, signal }) };
  }
  async resolveDependencies({ language, host = "managed", packages, signal }) {
    if (this.closed) throw new ServiceError("service_manager_closed"); signal = signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
    return language === "javascript" ? resolveNodeDependencies(packages, { signal, host, fetchImpl: this.fetchImpl })
      : language === "python" ? resolvePythonDependencies(packages, { host, signal, runtimeStore: this.runtimeStore, fetchImpl: this.fetchImpl }) : Promise.reject(new ServiceError("unsupported_service_runtime"));
  }
  async resolveDockerImage({ image, signal }) {
    if (this.closed) throw new ServiceError("service_manager_closed");
    return resolveDockerImage({ image, signal: signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal, fetchImpl: this.fetchImpl });
  }
  async probe({ language = "javascript", host = "managed", signal } = {}) {
    if (host === "docker") return this.docker.probe({ signal });
    if (this.platform !== "darwin" || this.arch !== "arm64") return { available: false, reason: "unsupported_managed_platform", kind: "macos-seatbelt" };
    let runtime; try { runtime = await this.runtimeStore.environment(language); } catch (error) { return { available: false, reason: error.reason }; }
    if (!runtime.available) return runtime;
    const key = serviceHash([language, runtime.executable, runtime.version]); if (this.probes.has(key)) return this.probes.get(key);
    const pending = this.probeIsolation(language, runtime, signal); this.probes.set(key, pending);
    const result = await pending; if (!result.available) this.probes.delete(key); return result;
  }
  async probeIsolation(language, runtime, signal) {
    const directory = await privateDirectory(join(this.rootDir, "probes", randomUUID()));
    try {
      const code = await privateDirectory(join(directory, "code")), scratch = await privateDirectory(join(directory, "scratch")), outside = await privateDirectory(join(directory, "outside"));
      const secret = join(outside, "canary"); await writeFile(secret, "private-canary", { mode: 0o600 });
      const source = language === "javascript" ? nodeProbe({ code, scratch, outside, secret }) : pythonProbe({ code, scratch, outside, secret });
      const profile = managedSandboxProfile({ executable: runtime.executable, runtimeRoot: runtime.runtimeRoot, codeDir: code, workerDir: WORKER_DIR, scratchDir: scratch });
      const args = language === "javascript" ? ["--input-type=module", "--eval", source] : ["-I", "-S", "-B", "-c", source];
      const run = await commandResult(this.sandboxPath, ["-p", profile, runtime.executable, ...args], { signal, cwd: scratch, env: cleanServiceEnvironment(scratch, runtime.executable), timeoutMs: 10000 });
      let checks; try { checks = JSON.parse(run.stdout); } catch {}
      const expected = { outsideRead: true, outsideWrite: true, codeWrite: true, hardlink: true, metadata: true, symlink: true, network: true, subprocess: true, scratch: true };
      if (run.code !== 0 || !isDeepStrictEqual(checks, expected) || await readFile(secret, "utf8") !== "private-canary") return { available: false, reason: "managed_isolation_failed", kind: "macos-seatbelt" };
      return { available: true, language, kind: "macos-seatbelt", checks, resourceEnforcement: "host-rss-and-disk-supervision" };
    } catch (error) { return { available: false, reason: signal?.aborted ? "cancelled" : error.reason ?? "managed_isolation_failed", kind: "macos-seatbelt" }; }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
  async prepare(options) {
    options = { ...options, signal: options.signal ? AbortSignal.any([options.signal, this.lifecycle.signal]) : this.lifecycle.signal };
    const key = deliveryKey(options);
    if (this.preparing.has(key)) { await this.preparing.get(key); return this.prepare(options); }
    const pending = this.prepareDelivery(options); this.preparing.set(key, pending);
    try { return await pending; } finally { this.preparing.delete(key); }
  }
  async prepareDelivery({ agentId, deliveryVersion, manifest, codeDir, signal, onProgress = this.onProgress }) {
    if (this.closed) throw new ServiceError("service_manager_closed");
    signal?.throwIfAborted(); manifest = validateServiceManifest(manifest);
    const key = deliveryKey({ agentId, deliveryVersion }), source = await inspectDevelopmentCode(codeDir), manifestHash = serviceHash(manifest);
    if (!source.files.some((file) => file.path === manifest.entrypoint)) throw new ServiceError("service_entrypoint_missing");
    const catalog = await this.catalog(), existing = catalog.deliveries[key];
    if (existing) {
      if (existing.sourceHash !== source.hash || existing.manifestHash !== manifestHash) throw new ServiceError("service_delivery_version_conflict");
      await this.checkRecord(existing); return clone(existing);
    }
    const runtime = manifest.host === "managed" ? await this.runtimeStore.prepare(manifest.language, { signal, onProgress }) : null;
    const isolation = await this.probe({ language: manifest.language, host: manifest.host, signal }); if (!isolation.available) throw new ServiceError(isolation.reason);
    const dependencies = await this.runtimeStore.prepareDependencies(manifest, runtime, { signal, onProgress });
    const directory = await privateDirectory(join(this.rootDir, "deliveries", key)), target = await privateDirectory(join(directory, "code"));
    try {
      for (const file of source.files) { signal?.throwIfAborted(); const path = join(target, file.path); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, source.contents.get(file.path), { mode: 0o400, flag: "wx" }); }
      if (manifest.language === "javascript" && manifest.host === "managed" && manifest.dependencies.packages.length) await symlink(join(dependencies.path, "node_modules"), join(directory, "node_modules"), "dir");
      const record = { schemaVersion: 1, agentId, deliveryVersion, directory, codeDir: target, sourceHash: source.hash, manifestHash, manifest, dependencies, createdAt: new Date().toISOString(), isolation };
      if (manifest.host === "docker") record.docker = await this.docker.build({ directory, codeDir: target, dependencies, manifest, signal, onProgress });
      signal?.throwIfAborted(); await atomicJSON(join(directory, "delivery.json"), record); await this.updateCatalog((current) => { current.deliveries[key] = record; });
      return clone(record);
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  }
  async checkRecord(record) {
    if (!record || !inside(await realpath(this.rootDir), record.directory) || !inside(record.directory, record.codeDir)
      || !inside(await realpath(this.runtimeStore.rootDir), record.dependencies.path)) throw new ServiceError("invalid_service_record");
    if (serviceHash(validateServiceManifest(record.manifest)) !== record.manifestHash || (await inspectDevelopmentCode(record.codeDir)).hash !== record.sourceHash) throw new ServiceError("service_delivery_changed");
    if ((await directoryBytes(record.dependencies.path, { hash: true })).hash !== record.dependencies.treeHash) throw new ServiceError("dependencies_changed");
    return record;
  }
  async getRecord(identity) {
    const record = (await this.catalog()).deliveries[deliveryKey(identity)];
    if (!record) throw new ServiceError("service_not_prepared"); return this.checkRecord(record);
  }
  async start(identity) {
    if (this.closed) throw new ServiceError("service_manager_closed");
    identity = { ...identity, signal: identity.signal ? AbortSignal.any([identity.signal, this.lifecycle.signal]) : this.lifecycle.signal };
    const key = identityKey(identity);
    if (this.starting.has(key)) return this.starting.get(key);
    const running = this.workers.get(key); if (running && !running.stopped) return this.workerInfo(key, running);
    const pending = this.startWorker(identity); this.starting.set(key, pending);
    try { return await pending; } finally { this.starting.delete(key); }
  }
  async startWorker({ agentId, deliveryVersion, scopeId = "private", signal, persist = true }) {
    signal?.throwIfAborted(); const identity = { agentId, deliveryVersion, scopeId }, key = identityKey(identity), record = await this.getRecord(identity);
    const scratchDir = await privateDirectory(join(this.rootDir, "scratch", key, randomUUID()));
    let command, args, dockerName;
    if (record.manifest.host === "managed") {
      const isolation = await this.probe({ language: record.manifest.language, signal }); if (!isolation.available) throw new ServiceError(isolation.reason);
      const runtime = await this.runtimeStore.environment(record.manifest.language);
      const profile = managedSandboxProfile({ executable: runtime.executable, runtimeRoot: runtime.runtimeRoot, codeDir: record.codeDir, dependencyDir: record.dependencies.path, workerDir: WORKER_DIR, scratchDir });
      const worker = join(WORKER_DIR, record.manifest.language === "javascript" ? "node-service-worker.mjs" : "python-service-worker.py");
      const runtimeArgs = record.manifest.language === "javascript" ? ["--disable-proto=throw", `--max-old-space-size=${Math.max(16, record.manifest.resources.memoryMiB - 64)}`, worker] : ["-I", "-S", "-B", worker];
      command = this.sandboxPath; args = ["-p", profile, runtime.executable, ...runtimeArgs, join(record.codeDir, record.manifest.entrypoint), record.dependencies.path];
    } else { command = this.docker.dockerPath; dockerName = `neuma-${key.slice(0, 32)}-${randomUUID().slice(0, 8)}`; args = this.docker.launchArguments({ record, name: dockerName }); }
    let child;
    try {
      child = spawn(command, args, { cwd: scratchDir, env: cleanServiceEnvironment(scratchDir, this.nodePath), shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      const worker = new ServiceWorker({ child, record, scratchDir, docker: this.docker, dockerName,
        onExit: (ended) => {
          if (this.workers.get(key) === ended) this.workers.delete(key);
          const log = { text: ended.log, limited: true, reason: ended.stopReason ?? "service_exited", at: new Date().toISOString() }; this.logsCache.set(key, log);
          if (!/^(?:verification|verify|migration):/.test(scopeId)) this.updateCatalog(async () => { await atomicJSON(join(this.rootDir, "logs", `${key}.json`), log); }).catch(() => {});
          rm(scratchDir, { recursive: true, force: true }).catch(() => {});
        } });
      worker.identity = identity; this.workers.set(key, worker);
      const abort = () => worker.stop("cancelled"); signal?.addEventListener("abort", abort, { once: true });
      try { await worker.readyPromise; signal?.throwIfAborted(); } finally { signal?.removeEventListener("abort", abort); }
      if (persist) await this.updateCatalog((catalog) => { catalog.desired[key] = identity; });
      return this.workerInfo(key, worker);
    } catch (error) { killProcessGroup(child); if (dockerName) await this.docker.stop(dockerName); await rm(scratchDir, { recursive: true, force: true }); throw error; }
  }
  workerInfo(key, worker) { return { id: key, ...worker.identity, language: worker.record.manifest.language, host: worker.record.manifest.host, status: worker.stopped ? "stopped" : worker.active ? "running" : "ready", pid: worker.child.pid, manifestHash: worker.record.manifestHash, sourceHash: worker.record.sourceHash, resourceEnforcement: worker.dockerName ? "container-hard-limits" : "host-rss-and-disk-supervision" }; }
  async run(options) {
    const key = identityKey(options); await this.getRecord(options); await this.start(options);
    const worker = this.workers.get(key); if (!worker) return failed("service_stopped");
    const handler = options.capabilityHandler ?? this.capabilityHandler;
    const capabilityHandler = handler ? (name, args, context) => handler(name, args, { ...context, agentId: options.agentId, deliveryVersion: options.deliveryVersion, scopeId: options.scopeId ?? "private" }) : undefined;
    return worker.run({ ...options, capabilityHandler });
  }
  async stop({ agentId, deliveryVersion, scopeId, reason = "service_stopped" }) {
    const matches = (identity) => identity.agentId === agentId && (deliveryVersion === undefined || identity.deliveryVersion === deliveryVersion) && (scopeId === undefined || identity.scopeId === scopeId);
    await this.updateCatalog((catalog) => { for (const [key, identity] of Object.entries(catalog.desired)) if (matches(identity)) delete catalog.desired[key]; });
    await Promise.all([...this.workers.values()].filter((worker) => matches(worker.identity)).map((worker) => worker.stop(reason)));
  }
  async activate({ agentId, deliveryVersion, scopeId = "private", signal }) {
    await this.start({ agentId, deliveryVersion, scopeId, signal });
    await this.updateCatalog((catalog) => { catalog.active[agentId] = deliveryVersion; });
    const old = [...this.workers.values()].filter((worker) => worker.identity.agentId === agentId && worker.identity.deliveryVersion !== deliveryVersion);
    for (const worker of old) await this.stop({ ...worker.identity, reason: "service_version_changed" });
    return { agentId, deliveryVersion, status: "ready" };
  }
  async restore({ isActive = async () => true } = {}) {
    await this.docker.cleanupOwned(); const catalog = await this.catalog(), results = [];
    for (const identity of Object.values(catalog.desired)) {
      if (catalog.active[identity.agentId] !== identity.deliveryVersion) continue;
      if (!await isActive(clone(identity))) continue;
      try { results.push(await this.start(identity)); } catch (error) { results.push({ ...identity, status: "interrupted", reason: error.reason ?? "service_restore_failed" }); }
    }
    return results;
  }
  async list({ agentId } = {}) {
    const catalog = await this.catalog();
    for (const record of Object.values(catalog.deliveries).filter((entry) => !agentId || entry.agentId === agentId)) {
      const key = identityKey({ agentId: record.agentId, deliveryVersion: record.deliveryVersion });
      if (!this.logsCache.has(key)) { const log = await readJSON(join(this.rootDir, "logs", `${key}.json`)); if (log) this.logsCache.set(key, log); }
    }
    return { environments: await this.environment(), deliveries: Object.values(catalog.deliveries).filter((record) => !agentId || record.agentId === agentId).map((record) => ({ agentId: record.agentId, deliveryVersion: record.deliveryVersion, language: record.manifest.language, host: record.manifest.host, manifestHash: record.manifestHash, active: catalog.active[record.agentId] === record.deliveryVersion })), services: [...this.workers.entries()].filter(([, worker]) => !agentId || worker.identity.agentId === agentId).map(([key, worker]) => this.workerInfo(key, worker)) };
  }
  logs(identity) { const key = identityKey(identity), worker = this.workers.get(key); return worker ? { text: worker.log, limited: true } : this.logsCache.get(key) ?? { text: "", limited: true }; }
  async verify({ agentId, deliveryVersion, manifest, codeDir, cases, signal, capabilityHandler }) {
    if (!Array.isArray(cases) || !cases.length || cases.length > 200) throw new ServiceError("invalid_service_cases");
    const record = await this.prepare({ agentId, deliveryVersion, manifest, codeDir, signal }), scopeId = `verify:${randomUUID()}`, results = [];
    try {
      for (const test of cases) {
        if (signal?.aborted) { results.push({ id: test.id, status: "error", reason: "cancelled" }); break; }
        const result = await this.run({ agentId, deliveryVersion, scopeId, actionId: test.actionId, input: test.input, signal, capabilityHandler, persist: false });
        let passed = result.status === "passed";
        if (Object.hasOwn(test, "expected")) passed &&= isDeepStrictEqual(result.output, test.expected);
        if (test.expectedError) passed = result.status === "failed" && result.reason === test.expectedError;
        results.push({ id: test.id, ...result, status: result.status === "error" ? "error" : passed ? "passed" : "failed" });
      }
      return { status: results.every((result) => result.status === "passed") ? "passed" : results.some((result) => result.status === "error") ? "error" : "failed", sourceHash: record.sourceHash, manifestHash: record.manifestHash, cases: results, evidenceMode: "isolated_service_checks", browserVerified: false, connectionVerified: false, runtime: { language: manifest.language, host: manifest.host } };
    } finally { await this.stop({ agentId, deliveryVersion, scopeId }); }
  }
  async close({ permanent = false } = {}) {
    this.closed = true; this.lifecycle.abort(); await Promise.allSettled([...this.starting.values(), ...this.preparing.values()]);
    await Promise.all([...this.workers.values()].map((worker) => worker.stop("backend_stopped"))); await this.tail;
    if (!permanent) { this.closed = false; this.lifecycle = new AbortController(); }
  }
}
