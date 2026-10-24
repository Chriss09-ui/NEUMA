import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNodeDependencies } from "../src/services/service-dependencies.mjs";
import { ServiceRuntimeStore, extractPackageTar } from "../src/services/service-runtime.mjs";
import { DockerServiceRuntime } from "../src/services/service-docker.mjs";
import { validateServiceManifest } from "../src/services/service-contract.mjs";
import type { BinaryLike } from "crypto";

function tar(files: [string, string, string?][]) {
  const blocks = [];
  for (const [name, text, type = "0"] of files) {
    const bytes = Buffer.from(text), header = Buffer.alloc(512); header.write(name, 0, 100); header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124, 12); header.write(type, 156, 1);
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
const hash = (bytes: BinaryLike|NonSharedBuffer) => createHash("sha256").update(bytes).digest("hex");
async function setup(t: test.TestContext) { const root = await mkdtemp(join(tmpdir(), "neuma-dependencies-test-")); t.after(() => rm(root, { recursive: true, force: true })); return root; }
test("official npm metadata resolver locks recursive scoped packages and independently hashes bytes", async () => {
  const metadata: Record<string, unknown> = {}, artifacts = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const [name, version, dependencies] of [["@scope/root", "1.0.0", { leaf: "^2.0.0" }], ["leaf", "2.1.0", {}]] as const) {
    const bytes = tar([["package/package.json", JSON.stringify({ name, version, dependencies })]]), url = `https://registry.npmjs.org/${name}/package.tgz`;
    metadata[name] = { versions: { [version]: { dependencies, dist: { tarball: url, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` } } } }; artifacts.set(url, new Uint8Array(bytes));
  }
  const fetchImpl: typeof fetch = async (url: Parameters<typeof fetch>[0]) => { assert.ok(typeof url === "string" || url instanceof URL); return artifacts.has(String(url)) ? new Response(artifacts.get(String(url))) : new Response(JSON.stringify(metadata[decodeURIComponent(new URL(url).pathname.slice(1))])); };
  const result = await resolveNodeDependencies([{ name: "@scope/root", version: "1.0.0" }], { fetchImpl });
  assert.equal(result.length, 2); assert.equal(result[0]!.filename, "scope-root-1.0.0.tgz"); assert.equal(result[1]!.installPath, "node_modules/@scope/root/node_modules/leaf");
  assert.equal(result[0]!.sha256, hash(artifacts.get(result[0]!.url)!));
});
test("npm archive extraction rejects traversal and all archive links", async (t) => {
  const root = await setup(t);
  await assert.rejects(extractPackageTar(tar([["package/../../outside", "bad"]]), root), { reason: "invalid_package_archive_path" });
  await assert.rejects(extractPackageTar(tar([["package/link", "", "2"]]), root), { reason: "package_links_denied" });
});
test("dependency store validates integrity and never runs lifecycle scripts", async (t) => {
  const root = await setup(t), bytes = tar([["package/package.json", JSON.stringify({ name: "unsafe", version: "1.0.0", scripts: { install: "touch outside" } })]]);
  const store = new ServiceRuntimeStore({ rootDir: root, fetchImpl: async () => new Response(bytes) });
  const pkg = { name: "unsafe", version: "1.0.0", url: "https://registry.npmjs.org/unsafe/unsafe.tgz", sha256: hash(bytes), filename: "unsafe.tgz" };
  await assert.rejects(store.prepareDependencies({ language: "javascript", host: "managed", dependencies: { packages: [pkg] } }, null), { reason: "native_dependency_requires_docker" });
  await assert.rejects(store.prepareDependencies({ language: "javascript", host: "managed", dependencies: { packages: [{ ...pkg, sha256: "a".repeat(64) }] } }, null), { reason: "dependency_digest_mismatch" });
});
test("Docker build pins image, uses isolated runtime limits and requires real canary evidence", async (t) => {
  const root = await setup(t), codeDir = join(root, "code"), packages = join(root, "packages"); await mkdir(codeDir); await mkdir(packages); await writeFile(join(codeDir, "action.mjs"), "export function run(){return null}");
  const calls: string[][] = [], imageId = `sha256:${"a".repeat(64)}`;
  const command = async (exe: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "info") return { code: 0, stdout: JSON.stringify({ OSType: "linux", Architecture: "aarch64", ServerVersion: "test" }) };
    if (args[0] === "image") return { code: 0, stdout: imageId };
    if (args[0] === "run") return { code: 0, stdout: JSON.stringify({ scratch: true, code: true, network: true, subprocess: true }) };
    return { code: 0, stdout: "" };
  };
  const docker = new DockerServiceRuntime({ ownerId: "test-owner", command });
  const manifest = validateServiceManifest({ schemaVersion: 1, language: "javascript", host: "docker", entrypoint: "action.mjs", operations: [{ id: "run", inputSchema: { type: "null" }, outputSchema: { type: "null" } }], docker: { baseImage: `node@sha256:${"b".repeat(64)}` } });
  const image = await docker.build({ directory: root, codeDir, dependencies: { path: packages }, manifest });
  assert.equal(image.imageId, imageId); assert.equal(image.isolation!.available, true);
  const build = calls.find((args) => args[0] === "build"), run = calls.find((args) => args[0] === "run");
  assert.ok(build!.includes("--network=none")); assert.ok(run!.includes("--read-only")); assert.ok(run!.includes("--memory=512m")); assert.ok(run!.includes("--cap-drop=ALL")); assert.ok(!run!.some((part) => part.includes("docker.sock")));
  const config = JSON.parse(await readFile(image.seccompPath, "utf8")); assert.ok(config.syscalls.some((item: { names: string[] }) => item.names.includes("fork")));
  const unavailable = new DockerServiceRuntime({ command: async () => ({ code: 1 }) }); assert.equal((await unavailable.probe()).reason, "docker_not_running");
});
