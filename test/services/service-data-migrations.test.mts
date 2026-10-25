import { fixtureText } from "../helpers/m7-test-boundaries.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedServiceManager } from "../../src/services/managed-service-manager.mjs";
import { ServiceDataMigrations } from "../../src/services/service-data-migrations.mjs";

const supported = process.platform === "darwin" && process.arch === "arm64";
const schema = (properties: { fromVersion?: { type: string; }; toVersion?: { type: string; }; migrated?: { type: string; }; valid?: { type: string; }; }) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
async function setup(t: test.TestContext, { valid = true, empty = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-migration-test-")), agentRoot = join(root, "agent"), codeDir = join(root, "code");
  const business = join(agentRoot, "application", "business"), workspace = join(agentRoot, "workspace"), stateFile = `${"a".repeat(64)}.json`;
  await mkdir(business, { recursive: true }); await mkdir(join(workspace, "inputs"), { recursive: true }); await mkdir(codeDir);
  await writeFile(join(business, stateFile), JSON.stringify({ state: { count: 2 }, version: 4, stateVersion: 1 }));
  await writeFile(join(workspace, "note.txt"), "old"); await writeFile(join(workspace, "inputs", "original.txt"), "keep");
  const inputSchema = schema({ fromVersion: { type: "integer" }, toVersion: { type: "integer" } });
  const manifest = { schemaVersion: 1, language: "javascript", host: "managed", entrypoint: "actions.mjs", dataVersion: 2, operations: [
    { id: "read", inputSchema: { type: "null" }, outputSchema: { type: "null" } },
    { id: "migrate", inputSchema, outputSchema: schema({ migrated: { type: "boolean" } }), visibility: "internal" },
    { id: "verify", inputSchema, outputSchema: schema({ valid: { type: "boolean" } }), visibility: "internal" }
  ], migration: { fromVersion: 1, actionId: "migrate", verifyActionId: "verify" } };
  await writeFile(join(codeDir, "actions.mjs"), empty ? "export const actions={read:()=>null,migrate:()=>({migrated:true}),verify:()=>({valid:true})}" : `export const actions={read:()=>null,migrate:async(input,ctx)=>{const files=await ctx.files.list({directory:'business'});for(const file of files.files){const path='business/'+file.name;const value=JSON.parse((await ctx.files.read({file:path})).text);value.state.label='upgraded';value.stateVersion=input.toVersion;value.version++;await ctx.files.write({file:path,content:JSON.stringify(value)})}await ctx.files.write({file:'workspace/note.txt',content:'new'});return {migrated:true}},verify:async(input,ctx)=>{const data=JSON.parse((await ctx.files.read({file:'business/${stateFile}'})).text);return {valid:${valid}&&data.stateVersion===input.toVersion&&data.state.count===2}}}`);
  if (empty) await rm(business, { recursive: true });
  const services = new ManagedServiceManager({ rootDir: join(root, "services") }), migrations = new ServiceDataMigrations({ rootDir: join(root, "migrations"), services });
  await services.prepare({ agentId: "agent", deliveryVersion: "v2", manifest, codeDir });
  t.after(async () => { await services.close({ permanent: true }); await rm(root, { recursive: true, force: true }); });
  const options = { agentId: "agent", agentRoot, fromDeliveryVersion: "v1", toDeliveryVersion: "v2", fromVersion: 1, toVersion: 2, manifest, targets: [{ id: "business", path: business, kind: "state-records" }, { id: "workspace", path: workspace, kind: "files" }] };
  return { root, business, workspace, stateFile, migrations, options };
}
test("data migration backs up, executes and verifies copies, then commits and restores both state and files", { skip: !supported }, async (t) => {
  const { business, workspace, stateFile, migrations, options } = await setup(t);
  const record = await migrations.prepare(options); assert.equal(record.status, "verified");
  assert.equal(JSON.parse(String(await readFile(join(business, stateFile)))).stateVersion, 1); assert.equal(await readFile(join(workspace, "note.txt"), "utf8"), "old");
  const committed = await migrations.commit({ id: record.id }); assert.equal(committed.status, "committed");
  const state = JSON.parse(String(await readFile(join(business, stateFile)))); assert.equal(state.stateVersion, 2); assert.equal(state.state.label, "upgraded");
  assert.equal(await readFile(join(workspace, "note.txt"), "utf8"), "new"); assert.equal(await readFile(join(workspace, "inputs", "original.txt"), "utf8"), "keep");
  await migrations.rollback({ id: record.id }); assert.equal(JSON.parse(String(await readFile(join(business, stateFile)))).stateVersion, 1); assert.equal(await readFile(join(workspace, "note.txt"), "utf8"), "old");
  await migrations.reapply({ id: record.id }); assert.equal(JSON.parse(String(await readFile(join(business, stateFile)))).stateVersion, 2); assert.equal(await readFile(join(workspace, "note.txt"), "utf8"), "new");
});
test("migration verifier failure leaves live data untouched and preserves the backup ID", { skip: !supported }, async (t) => {
  const { business, stateFile, migrations, options } = await setup(t, { valid: false });
  let failure; try { await migrations.prepare(options); } catch (error) { failure = error; }
  assert.equal(objectFields(failure).reason, "data_migration_verification_failed"); assert.match(fixtureText(objectFields(failure).migrationId), /^migration_/);
  assert.equal((await migrations.get(fixtureText(objectFields(failure).migrationId))).status, "failed"); assert.equal(JSON.parse(String(await readFile(join(business, stateFile)))).stateVersion, 1);
});
test("migration refuses stale source and rollback refuses to discard newer data in any target", { skip: !supported }, async (t) => {
  const { workspace, migrations, options, business, stateFile } = await setup(t);
  const stale = await migrations.prepare(options); await writeFile(join(workspace, "note.txt"), "edited");
  await assert.rejects(migrations.commit({ id: stale.id }), { reason: "migration_source_changed" });
  const fresh = await migrations.prepare(options); await migrations.commit({ id: fresh.id });
  await writeFile(join(business, stateFile), JSON.stringify({ state: { count: 99 }, version: 6, stateVersion: 2 }));
  await assert.rejects(migrations.rollback({ id: fresh.id }), { reason: "data_changed_after_migration" });
  assert.equal(await readFile(join(workspace, "note.txt"), "utf8"), "new");
});
test("migration recovery restores a crash between moving original data and publishing the new directory", { skip: !supported }, async (t) => {
  const { migrations, options, business, stateFile } = await setup(t);
  const record = await migrations.prepare(options); record.status = "committing";
  await migrations.save(record); await rename(record.targets![0]!.path, record.targets![0]!.moved);
  const recovered = await migrations.recover(); assert.equal(recovered[0]!.status, "rolled_back");
  assert.equal(JSON.parse(String(await readFile(join(business, stateFile)))).stateVersion, 1);
});
test("migration handles previously nonexistent state directories without inventing a source hash", { skip: !supported }, async (t) => {
  const { migrations, options, business } = await setup(t, { empty: true });
  const prepared = await migrations.prepare(options); assert.equal(prepared.targets![0]!.sourceHash, null);
  await migrations.commit({ id: prepared.id });
  await migrations.rollback({ id: prepared.id });
  await assert.rejects(readFile(join(business, "anything")), { code: "ENOENT" });
});
