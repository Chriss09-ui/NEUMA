import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedServiceManager } from "../src/services/managed-service-manager.mjs";
import { ServiceRuntimeStore } from "../src/services/service-runtime.mjs";
import { validateServiceManifest } from "../src/services/service-contract.mjs";

const object = { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false };
const manifest = (extra = {}) => ({ schemaVersion: 1, language: "javascript", host: "managed", entrypoint: "action.mjs", operations: [{ id: "add", inputSchema: object, outputSchema: object, connectionIds: ["store"] }], ...extra });
const supported = process.platform === "darwin" && process.arch === "arm64";
async function setup(t, source, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "neuma-services-test-")), codeDir = join(directory, "source"); await mkdir(codeDir);
  await writeFile(join(codeDir, options.language === "python" ? "action.py" : "action.mjs"), source);
  const manager = new ManagedServiceManager({ rootDir: join(directory, "manager"), ...options.manager });
  t.after(async () => { await manager.close({ permanent: true }); await rm(directory, { recursive: true, force: true }); });
  return { directory, codeDir, manager };
}

test("managed manifest rejects mutable dependencies and unsafe execution paths", () => {
  assert.throws(() => validateServiceManifest(manifest({ entrypoint: "../action.mjs" })));
  assert.throws(() => validateServiceManifest(manifest({ dependencies: { packages: [{ name: "example", version: "1.0.0", url: "https://untrusted.example/file.tgz", sha256: "a".repeat(64), filename: "file.tgz" }] } })));
  assert.throws(() => validateServiceManifest(manifest({ host: "docker", docker: { baseImage: "node:latest" } })));
  assert.equal(validateServiceManifest(manifest()).resources.timeoutMs, 600000);
  assert.equal(validateServiceManifest(manifest()).resources.memoryMiB, 512);
});

test("managed runtime fails closed on unsupported systems", async (t) => {
  const { manager } = await setup(t, "", { manager: { platform: "linux", arch: "x64" } });
  assert.equal((await manager.probe()).available, false);
});

test("managed Node worker really runs twice, scopes globals, brokers capabilities, and verifies artifacts", { skip: !supported }, async (t) => {
  const { manager, codeDir } = await setup(t, `let calls=0;export async function run(request,ctx){calls++;const stored=await ctx.connection.call({connectionId:'store',operationId:'read',input:{}});return {value:request.input.value+calls+stored.value}}`);
  assert.equal((await manager.probe()).available, true);
  const id = { agentId: "agent-one", deliveryVersion: "version-one" };
  await manager.prepare({ ...id, manifest: manifest(), codeDir });
  let calls = 0;
  const capabilityHandler = async (name, args, identity) => { assert.equal(name, "connection.call"); assert.equal(args.connectionId, "store"); assert.equal(identity.agentId, id.agentId); calls++; return { value: 10 }; };
  assert.deepEqual((await manager.run({ ...id, actionId: "add", input: { value: 2 }, capabilityHandler })).output, { value: 13 });
  assert.deepEqual((await manager.run({ ...id, actionId: "add", input: { value: 2 }, capabilityHandler })).output, { value: 14 });
  assert.deepEqual((await manager.run({ ...id, scopeId: "group:other", actionId: "add", input: { value: 2 }, capabilityHandler })).output, { value: 13 });
  assert.equal(calls, 3);
  const record = await manager.getRecord(id);
  await chmod(join(record.codeDir, "action.mjs"), 0o600);
  await writeFile(join(record.codeDir, "action.mjs"), "export const changed=true");
  await assert.rejects(manager.run({ ...id, actionId: "add", input: { value: 1 } }), { reason: "service_delivery_changed" });
});

test("managed worker termination settles cancelled and timed-out calls and permits later restart", { skip: !supported }, async (t) => {
  const { manager, codeDir } = await setup(t, "export async function run(){await new Promise(resolve=>setTimeout(resolve,10000));return {value:1}}");
  const id = { agentId: "agent-one", deliveryVersion: "version-one" };
  await manager.prepare({ ...id, manifest: manifest({ resources: { timeoutMs: 100 } }), codeDir });
  const result = await manager.run({ ...id, actionId: "add", input: { value: 1 } }); assert.equal(result.reason, "service_timeout");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(manager.run({ ...id, actionId: "add", input: { value: 1 }, signal: controller.signal }));
  await manager.close();
  assert.equal((await manager.probe()).available, true);
});

test("managed service validates input/output and refuses undeclared connection access", { skip: !supported }, async (t) => {
  const { manager, codeDir } = await setup(t, "export async function run(request,ctx){await ctx.connection.call({connectionId:'private',operationId:'read'});return {value:1}}");
  const id = { agentId: "agent-one", deliveryVersion: "version-one" };
  await manager.prepare({ ...id, manifest: manifest(), codeDir }); let invoked = false;
  await assert.rejects(manager.run({ ...id, actionId: "add", input: { value: "bad" } }));
  const result = await manager.run({ ...id, actionId: "add", input: { value: 1 }, capabilityHandler: async () => { invoked = true; } });
  assert.equal(result.status, "failed"); assert.equal(invoked, false);
});

test("service delivery version cannot be rebound to changed source and checksums are bound to verification", { skip: !supported }, async (t) => {
  const { manager, codeDir } = await setup(t, "export const actions={add:async input=>({value:input.value+1})}");
  const options = { agentId: "agent-one", deliveryVersion: "version-one", manifest: manifest(), codeDir };
  const report = await manager.verify({ ...options, cases: [{ id: "addition", actionId: "add", input: { value: 2 }, expected: { value: 3 } }] });
  assert.equal(report.status, "passed"); assert.match(report.sourceHash, /^[a-f0-9]{64}$/); assert.equal(report.connectionVerified, false);
  await writeFile(join(codeDir, "action.mjs"), "export const actions={add:async input=>({value:0})}");
  await assert.rejects(manager.prepare(options), { reason: "service_delivery_version_conflict" });
});

test("prepared Python performs real isolated calls when the pinned runtime is provided", { skip: !supported || !process.env.NEUMA_TEST_SERVICE_PYTHON }, async (t) => {
  const runtimeStore = new ServiceRuntimeStore({ rootDir: process.env.NEUMA_TEST_SERVICE_PYTHON });
  const { manager, codeDir } = await setup(t, "count=0\ndef run(request,ctx):\n global count\n count+=1\n saved=ctx.connection.call({'connectionId':'store','operationId':'get','input':{}})\n return {'value':request['input']['value']+count+saved['value']}\n", { language: "python", manager: { runtimeStore } });
  assert.equal((await manager.probe({ language: "python" })).available, true);
  const id = { agentId: "python-agent", deliveryVersion: "python-one" };
  await manager.prepare({ ...id, manifest: manifest({ language: "python", entrypoint: "action.py" }), codeDir });
  const capabilityHandler = async () => ({ value: 10 });
  assert.deepEqual((await manager.run({ ...id, actionId: "add", input: { value: 2 }, capabilityHandler })).output, { value: 13 });
  assert.deepEqual((await manager.run({ ...id, actionId: "add", input: { value: 2 }, capabilityHandler })).output, { value: 14 });
});

test("managed memory and scratch supervision terminate real offending workers", { skip: !supported }, async (t) => {
  const { manager, codeDir } = await setup(t, "import fs from 'node:fs';let retained;export async function run(request){if(request.input.value===1)retained=Buffer.alloc(96*1024*1024,1);else fs.writeFileSync('large-file',Buffer.alloc(2*1024*1024,1));await new Promise(resolve=>setTimeout(resolve,5000));return {value:retained?.length??0}}");
  const identity = { agentId: "resource-agent", deliveryVersion: "resource-one" };
  await manager.prepare({ ...identity, codeDir, manifest: manifest({ resources: { memoryMiB: 64, scratchMiB: 1, timeoutMs: 10000 } }) });
  const memory = await manager.run({ ...identity, actionId: "add", input: { value: 1 } }); assert.equal(memory.reason, "service_memory_limit");
  const disk = await manager.run({ ...identity, scopeId: "disk", actionId: "add", input: { value: 2 } }); assert.equal(disk.reason, "service_disk_limit");
});

test("stopped backend can restore only an activated delivery and close permits settings reload", { skip: !supported }, async (t) => {
  const { manager, codeDir, directory } = await setup(t, "export function run(request){return request.input}");
  const identity = { agentId: "active-agent", deliveryVersion: "one" };
  await manager.prepare({ ...identity, codeDir, manifest: manifest() }); await manager.activate(identity);
  await manager.close();
  const restored = await manager.restore(); assert.equal(restored.length, 1); assert.equal(restored[0].status, "ready");
  await manager.stop(identity); assert.equal((await manager.restore()).length, 0);
});
