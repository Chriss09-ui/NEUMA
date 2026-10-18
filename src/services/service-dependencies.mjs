import semver from "semver";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ServiceError, serviceHash } from "./service-contract.mjs";
import { privateDirectory } from "./service-files.mjs";
import { cleanServiceEnvironment, commandResult } from "./service-process.mjs";

async function json(url, { signal, fetchImpl }) {
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
  const response = await fetchImpl(url, { signal });
  if (!response.ok) throw new ServiceError("dependency_metadata_unavailable");
  const text = await response.text(); if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw new ServiceError("dependency_metadata_limit");
  return JSON.parse(text);
}
function requestedPackages(packages) {
  if (!Array.isArray(packages) || !packages.length || packages.length > 80 || packages.some((pkg) => !pkg || typeof pkg.name !== "string" || !/^(?:@[a-z0-9._-]+\/)?[a-zA-Z0-9][a-zA-Z0-9._-]{0,150}$/.test(pkg.name) || typeof pkg.version !== "string" || !/^[0-9][a-zA-Z0-9.+_-]{0,99}$/.test(pkg.version))) throw new ServiceError("dependency_exact_versions_required");
}
export async function resolveNodeDependencies(packages, { signal, fetchImpl = fetch, host = "managed" } = {}) {
  requestedPackages(packages); const cache = new Map(), result = [], paths = new Set();
  const metadata = async (name) => {
    if (!cache.has(name)) cache.set(name, json(`https://registry.npmjs.org/${encodeURIComponent(name)}`, { signal, fetchImpl }));
    return cache.get(name);
  };
  const visit = async (name, range, path, ancestors) => {
    signal?.throwIfAborted();
    if (ancestors.some((ancestor) => ancestor.name === name && semver.satisfies(ancestor.version, range))) return;
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(name) || !semver.validRange(range)) throw new ServiceError("unsupported_dependency_reference");
    const data = await metadata(name), version = semver.maxSatisfying(Object.keys(data.versions ?? {}), range);
    if (!version) throw new ServiceError("dependency_version_unavailable");
    const item = data.versions[version];
    const platform = host === "docker" ? "linux" : "darwin";
    const supports = (constraints, current) => !constraints || !constraints.includes(`!${current}`) && (!constraints.some((value) => !value.startsWith("!")) || constraints.includes(current) || constraints.includes("any"));
    if (!supports(item.os, platform) || !supports(item.cpu, "arm64")) throw new ServiceError("incompatible_node_dependency");
    let url; try { url = new URL(item.dist.tarball); } catch { throw new ServiceError("invalid_dependency_metadata"); }
    if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org" || url.username || url.password) throw new ServiceError("untrusted_dependency_source");
    if (paths.has(path)) return; if (result.length >= 200 || ancestors.length > 30) throw new ServiceError("dependency_graph_limit");
    const response = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000) });
    if (!response.ok) throw new ServiceError("dependency_download_failed");
    const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > 128 * 1024 * 1024) throw new ServiceError("dependency_download_limit");
    if (typeof item.dist.integrity !== "string") throw new ServiceError("dependency_integrity_missing");
    const match = /^(sha512|sha256)-([A-Za-z0-9+/=]+)$/.exec(item.dist.integrity);
    if (!match) throw new ServiceError("dependency_integrity_missing");
    const { createHash } = await import("node:crypto");
    if (createHash(match[1]).update(bytes).digest("base64") !== match[2]) throw new ServiceError("dependency_digest_mismatch");
    paths.add(path); result.push({ name, version, url: url.href, sha256: serviceHash(bytes), filename: `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`, installPath: path });
    const next = [...ancestors, { name, version }];
    const required = { ...item.dependencies, ...item.optionalDependencies, ...Object.fromEntries(Object.entries(item.peerDependencies ?? {}).filter(([key]) => !item.peerDependenciesMeta?.[key]?.optional)) };
    for (const [dependency, constraint] of Object.entries(required).sort(([a], [b]) => a.localeCompare(b))) {
      try { await visit(dependency, constraint, `${path}/node_modules/${dependency}`, next); }
      catch (error) { if (!(Object.hasOwn(item.optionalDependencies ?? {}, dependency) && error.reason === "incompatible_node_dependency")) throw error; }
    }
  };
  for (const pkg of packages) await visit(pkg.name, pkg.version, `node_modules/${pkg.name}`, []);
  return result;
}

const WHEEL_IDENTITIES = `import json,sys,zipfile,email
result=[]
for path in sys.argv[1:]:
 with zipfile.ZipFile(path) as wheel:
  names=[name for name in wheel.namelist() if name.endswith('.dist-info/METADATA')]
  if len(names)!=1: raise RuntimeError('invalid_wheel_metadata')
  metadata=email.message_from_bytes(wheel.read(names[0]))
  result.append({'name':metadata['Name'],'version':metadata['Version'],'filename':path.rsplit('/',1)[-1]})
print(json.dumps(result))`;

export async function resolvePythonDependencies(packages, { runtimeStore, host = "managed", signal, fetchImpl = fetch } = {}) {
  requestedPackages(packages);
  const runtime = await runtimeStore.prepare("python", { signal });
  const parent = await privateDirectory(join(runtimeStore.rootDir, "resolution")), stage = await mkdtemp(join(parent, "resolve-"));
  try {
    const target = await privateDirectory(join(stage, "wheels"));
    const args = ["-I", "-B", "-m", "pip", "--isolated", "--disable-pip-version-check", "--no-input", "--keyring-provider", "disabled", "download", "--only-binary=:all:", "--no-cache-dir", "--index-url", "https://pypi.org/simple", "--dest", target];
    if (host === "docker") args.push("--platform", "manylinux_2_28_aarch64", "--platform", "manylinux_2_17_aarch64", "--python-version", "3.13", "--implementation", "cp", "--abi", "cp313");
    args.push(...packages.map((pkg) => `${pkg.name}==${pkg.version}`));
    const run = await commandResult(runtime.executable, args, { cwd: stage, env: { ...cleanServiceEnvironment(stage, runtime.executable), PIP_CONFIG_FILE: "/dev/null" }, signal, timeoutMs: 180000, maxBytes: 1024 * 1024 });
    if (run.code !== 0) throw new ServiceError("python_dependency_resolution_failed", "无法找到兼容且完整的预编译依赖；请核实版本，或选择包含所需系统组件的 Docker 运行方式");
    const files = (await readdir(target)).sort(); if (!files.length || files.length > 200 || files.some((file) => !file.endsWith(".whl"))) throw new ServiceError("invalid_python_dependency_set");
    const identities = await commandResult(runtime.executable, ["-I", "-S", "-B", "-c", WHEEL_IDENTITIES, ...files.map((file) => join(target, file))], { cwd: stage, env: cleanServiceEnvironment(stage, runtime.executable), signal, timeoutMs: 30000 });
    if (identities.code !== 0) throw new ServiceError("invalid_python_dependency_metadata");
    const result = [];
    for (const item of JSON.parse(identities.stdout)) {
      const metadata = await json(`https://pypi.org/pypi/${encodeURIComponent(item.name)}/${encodeURIComponent(item.version)}/json`, { signal, fetchImpl });
      const asset = metadata.urls?.find((url) => url.filename === item.filename);
      const bytes = await readFile(join(target, item.filename));
      if (!asset || new URL(asset.url).hostname !== "files.pythonhosted.org" || serviceHash(bytes) !== asset.digests?.sha256) throw new ServiceError("dependency_digest_mismatch");
      result.push({ ...item, url: asset.url, sha256: asset.digests.sha256, target: host === "docker" ? "linux-arm64" : "darwin-arm64" });
    }
    return result;
  } finally { await rm(stage, { recursive: true, force: true }); }
}
