import type { DependencyLock, ServiceManifest } from "../contracts/service.mjs";
import type { ProgressOptions, RuntimeEnvironment, ReadyEnvironment, InstalledDependencies } from "./service-port.mjs";
import { objectFields } from "../runtime/type-boundary.mjs";
interface RuntimeLock { version: string; url: string; sha256: string; maxBytes?: number; release?: string; platform?: string; arch?: string }
interface RuntimeOptions { rootDir?: string | undefined; nodePath?: string; platform?: NodeJS.Platform; arch?: string; fetchImpl?: typeof fetch; pythonLock?: RuntimeLock; sandboxPath?: string }
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ServiceError, serviceHash } from "./service-contract.mjs";
import { atomicJSON, directoryBytes, inside, privateDirectory, readJSON } from "./service-files.mjs";
import { cleanServiceEnvironment, commandResult, managedSandboxProfile } from "./service-process.mjs";

// Pinned upstream release asset, verified against the publisher's GitHub release digest.
export const MANAGED_PYTHON = Object.freeze({ version: "3.13.16", release: "20261013", platform: "darwin", arch: "arm64",
  url: "https://github.com/astral-sh/python-build-standalone/releases/download/20261013/cpython-3.13.16%2B20261013-aarch64-apple-darwin-install_only_stripped.tar.gz",
  sha256: "16a5332fb0dcb77f163fc8f8cbccd95be1644cc53e68e5d2a79f50afd6680a0e", maxBytes: 64 * 1024 * 1024 });

async function downloadLocked(lock: Pick<DependencyLock, "url" | "sha256" | "maxBytes">, target: string, { signal, fetchImpl = fetch, onProgress = () => {} }: ProgressOptions & { fetchImpl?: typeof fetch } = {}) {
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000);
  signal?.throwIfAborted();
  const response = await fetchImpl(lock.url, { signal, redirect: "follow" });
  if (!response.ok || !response.body) throw new ServiceError("runtime_download_failed");
  if (response.url && new URL(response.url).protocol !== "https:") throw new ServiceError("insecure_runtime_download");
  const maxBytes = lock.maxBytes ?? 128 * 1024 * 1024, hash = createHash("sha256"), chunks = []; let size = 0;
  for await (const chunk of response.body) {
    signal?.throwIfAborted(); size += chunk.length;
    if (size > maxBytes) throw new ServiceError("runtime_download_limit");
    hash.update(chunk); chunks.push(chunk); await onProgress({ status: "downloading", bytes: size });
  }
  if (hash.digest("hex") !== lock.sha256) throw new ServiceError("dependency_digest_mismatch");
  await writeFile(target, Buffer.concat(chunks), { mode: 0o600, flag: "wx" });
}

// npm artifacts are extracted as regular files only; archive links and path traversal are refused.
export async function extractPackageTar(bytes: Buffer, destination: string) {
  const archive = gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 }); let offset = 0, count = 0, nextName;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512); offset += 512;
    if (header.every((byte) => byte === 0)) break;
    const text = (start: number, length: number) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const size = Number.parseInt(text(124, 12).trim() || "0", 8), type = text(156, 1), prefix = text(345, 155);
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > archive.length || ++count > 30000) throw new ServiceError("invalid_package_archive");
    const content = archive.subarray(offset, offset + size); offset += Math.ceil(size / 512) * 512;
    if (type === "x") {
      let index = 0;
      while (index < content.length) {
        const space = content.indexOf(32, index), length = Number(content.subarray(index, space).toString());
        if (!Number.isSafeInteger(length) || length < 4 || index + length > content.length) throw new ServiceError("invalid_package_archive");
        const record = content.subarray(space + 1, index + length - 1).toString("utf8");
        if (record.startsWith("path=")) nextName = record.slice(5);
        if (record.startsWith("linkpath=")) throw new ServiceError("package_links_denied");
        index += length;
      }
      continue;
    }
    if (!["", "0", "5"].includes(type)) throw new ServiceError("package_links_denied");
    let name = nextName ?? [prefix, text(0, 100)].filter(Boolean).join("/"); nextName = undefined;
    name = name.replace(/\/$/, "");
    if (!name.startsWith("package/") && name !== "package") throw new ServiceError("invalid_package_archive_root");
    name = name.slice(8); if (!name) continue;
    if (name.includes("\\") || /[\x00-\x1f]/.test(name) || name.split("/").some((part) => !part || part === "." || part === "..")) throw new ServiceError("invalid_package_archive_path");
    const target = join(destination, name); if (!inside(destination, target)) throw new ServiceError("invalid_package_archive_path");
    if (type === "5") await mkdir(target, { recursive: true, mode: 0o700 });
    else { await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, content, { flag: "wx", mode: 0o600 }); }
  }
}

const WHEEL_INSTALLER = `import json,os,sys,stat,zipfile
wheel,target=sys.argv[1:3]
with zipfile.ZipFile(wheel) as archive:
 total=0
 for info in archive.infolist():
  name=info.filename
  parts=name.rstrip('/').split('/')
  if name.startswith('/') or '\\\\' in name or any(p in ('','..','.') for p in parts) or stat.S_ISLNK(info.external_attr>>16): raise RuntimeError('unsafe_wheel')
  if name.endswith('.pth'): raise RuntimeError('wheel_startup_hooks_denied')
  if parts[0].endswith('.data'):
   if len(parts)<3 or parts[1] not in ('purelib','platlib'): continue
   parts=parts[2:]
  total+=info.file_size
  if total>536870912 or len(archive.infolist())>30000: raise RuntimeError('wheel_size_limit')
  path=os.path.join(target,*parts)
  if info.is_dir(): os.makedirs(path,exist_ok=True); continue
  os.makedirs(os.path.dirname(path),exist_ok=True)
  with open(path,'xb') as output: output.write(archive.read(info))
print(json.dumps({'installed':True}))`;

export class ServiceRuntimeStore {
  declare rootDir: string; declare nodePath: string; declare platform: NodeJS.Platform; declare arch: string; declare fetchImpl: typeof fetch; declare pythonLock: RuntimeLock; declare sandboxPath: string;
  pending: Map<string, Promise<ReadyEnvironment | InstalledDependencies>>;
  constructor({ rootDir, nodePath = process.execPath, platform = process.platform, arch = process.arch, fetchImpl = fetch, pythonLock = MANAGED_PYTHON, sandboxPath = "/usr/bin/sandbox-exec" }: RuntimeOptions = {}) {
    if (!rootDir) throw new TypeError("rootDir is required");
    Object.assign(this, { rootDir: resolve(rootDir), nodePath, platform, arch, fetchImpl, pythonLock, sandboxPath });
    this.pending = new Map();
  }
  async environment(language: string): Promise<RuntimeEnvironment> {
    if (language === "javascript") return { available: true, language, version: process.version, executable: await realpath(this.nodePath), runtimeRoot: null };
    const location = join(this.rootDir, "python", this.pythonLock.sha256), record = objectFields(await readJSON(join(location, "installation.json")));
    if (!record || record.archiveHash !== this.pythonLock.sha256) return { available: false, language, reason: "python_not_prepared", version: this.pythonLock.version };
    const runtimeRoot = await realpath(join(location, "python")), executable = await realpath(join(runtimeRoot, "bin", "python3.13"));
    if (!inside(await realpath(location), executable) || (await directoryBytes(runtimeRoot, { allowInternalLinks: true, hash: true })).hash !== record.treeHash) throw new ServiceError("python_runtime_changed");
    return { available: true, language, executable, runtimeRoot, version: this.pythonLock.version };
  }
  async prepare(language: string, { signal, onProgress = () => {} }: ProgressOptions = {}): Promise<ReadyEnvironment> {
    if (this.platform !== "darwin" || this.arch !== "arm64") throw new ServiceError("unsupported_managed_platform", "新托管运行环境目前仅验证 Apple 芯片 Mac");
    const existing = await this.environment(language); if (existing.available) return existing;
    if (language !== "python") throw new ServiceError("unsupported_service_runtime");
    if (this.pending.has(language)) return this.pending.get(language) as Promise<ReadyEnvironment>;
    const pending = this.installPython({ signal, onProgress }); this.pending.set(language, pending);
    try { return await pending; } finally { this.pending.delete(language); }
  }
  async installPython({ signal, onProgress = () => {} }: ProgressOptions): Promise<ReadyEnvironment> {
    const parent = await privateDirectory(join(this.rootDir, "python")), final = join(parent, this.pythonLock.sha256), staging = await privateDirectory(join(parent, `install-${randomUUID()}`));
    try {
      const archive = join(staging, "python.tar.gz");
      await downloadLocked(this.pythonLock, archive, { signal, fetchImpl: this.fetchImpl, onProgress });
      // Only this publisher-pinned archive may contain the official internal runtime symlinks.
      const listing = await commandResult("/usr/bin/tar", ["-tzf", archive], { signal, maxBytes: 8 * 1024 * 1024 });
      if (listing.code !== 0 || listing.stdout.split("\n").filter(Boolean).some((name) => !name.startsWith("python/") || name.split("/").includes(".."))) throw new ServiceError("invalid_python_archive");
      await onProgress({ status: "installing", version: this.pythonLock.version });
      const unpack = await commandResult("/usr/bin/tar", ["-xzf", archive, "-C", staging], { signal, timeoutMs: 60000 });
      if (unpack.code !== 0) throw new ServiceError("python_install_failed");
      await rm(archive);
      const tree = await directoryBytes(join(staging, "python"), { allowInternalLinks: true, hash: true });
      await atomicJSON(join(staging, "installation.json"), { archiveHash: this.pythonLock.sha256, treeHash: tree.hash, version: this.pythonLock.version });
      signal?.throwIfAborted(); await rename(staging, final);
      const environment = await this.environment("python"); if (!environment.available) throw new ServiceError(environment.reason); await onProgress({ status: "ready", version: environment.version }); return environment;
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  async prepareDependencies(manifest: Pick<ServiceManifest, "language" | "host" | "dependencies">, environment: ReadyEnvironment | null, { signal, onProgress = () => {} }: ProgressOptions = {}): Promise<InstalledDependencies> {
    const key = serviceHash({ language: manifest.language, host: manifest.host, packages: manifest.dependencies.packages });
    const parent = await privateDirectory(join(this.rootDir, "dependencies")), final = join(parent, key);
    const stored = await readJSON(join(final, "lock.json")), existing = stored ? objectFields(stored) : null;
    if (existing) {
      if (typeof existing.treeHash !== "string" || (await directoryBytes(join(final, "packages"), { hash: true })).hash !== existing.treeHash) throw new ServiceError("dependencies_changed");
      return { path: join(final, "packages"), hash: key, treeHash: existing.treeHash };
    }
    if (this.pending.has(key)) return this.pending.get(key) as Promise<InstalledDependencies>;
    const pending = this.installDependencies(manifest, environment, { parent, final, key, signal, onProgress }); this.pending.set(key, pending);
    try { return await pending; } finally { this.pending.delete(key); }
  }
  async installDependencies(manifest: Pick<ServiceManifest, "language" | "host" | "dependencies">, environment: ReadyEnvironment | null, { parent, final, key, signal, onProgress }: ProgressOptions & { parent: string; final: string; key: string }): Promise<InstalledDependencies> {
    const stage = await privateDirectory(join(parent, `install-${randomUUID()}`)), packages = await privateDirectory(join(stage, "packages"));
    try {
      for (const pkg of manifest.dependencies.packages) {
        signal?.throwIfAborted(); const artifact = join(stage, pkg.filename);
        await downloadLocked(pkg, artifact, { signal, fetchImpl: this.fetchImpl, onProgress });
        if (manifest.host === "docker") {
          // Docker performs the reviewed offline installation inside its build environment.
          await rename(artifact, join(packages, pkg.filename)); continue;
        }
        if (manifest.language === "javascript") {
          const target = await privateDirectory(join(packages, pkg.installPath ?? `node_modules/${pkg.name}`));
          await extractPackageTar(await readFile(artifact), target);
          const metadata = objectFields(await readJSON(join(target, "package.json")));
          if (metadata?.name !== pkg.name || metadata?.version !== pkg.version) throw new ServiceError("package_identity_mismatch");
          if (Object.keys(objectFields(metadata.scripts)).some((name) => ["preinstall", "install", "postinstall", "prepare"].includes(name)) || metadata.gypfile) throw new ServiceError("native_dependency_requires_docker");
          const checkPure = async (directory: string): Promise<void> => { for (const file of await readdir(directory, { withFileTypes: true })) { if (file.isDirectory()) await checkPure(join(directory, file.name)); else if (/\.(?:node|dylib|so|dll|exe)$/i.test(file.name)) throw new ServiceError("native_dependency_requires_docker"); } };
          await checkPure(target);
          await directoryBytes(target);
        } else {
          if (!/(?:py3|py2\.py3)-none-any\.whl$/.test(pkg.filename) && !/(?:cp313-cp313|cp3\d+-abi3)-macosx_[0-9_]+_(?:arm64|universal2)\.whl$/.test(pkg.filename)) throw new ServiceError("incompatible_python_wheel");
          if (!environment) throw new ServiceError("python_not_prepared");
          const profile = managedSandboxProfile({ executable: environment.executable, runtimeRoot: environment.runtimeRoot, codeDir: stage, workerDir: stage, scratchDir: stage });
          const installed = await commandResult(this.sandboxPath, ["-p", profile, environment.executable, "-I", "-S", "-B", "-c", WHEEL_INSTALLER, artifact, packages], { signal, cwd: stage, env: cleanServiceEnvironment(stage, environment.executable), timeoutMs: 60000 });
          if (installed.code !== 0) throw new ServiceError("wheel_install_failed");
        }
        await rm(artifact);
      }
      if (manifest.language === "javascript" && manifest.host === "managed") await writeFile(join(packages, "package.json"), '{"private":true}', { mode: 0o600 });
      const tree = await directoryBytes(packages, { hash: true });
      await atomicJSON(join(stage, "lock.json"), { key, packages: manifest.dependencies.packages, treeHash: tree.hash });
      signal?.throwIfAborted(); await rename(stage, final);
      return { path: join(final, "packages"), hash: key, treeHash: tree.hash! };
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
}
