import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { checkedIdentity, ServiceError, serviceHash, validateServiceManifest } from "./service-contract.mjs";
import { atomicJSON, directoryBytes, inside, privateDirectory, readJSON } from "./service-files.mjs";

const exists = async (path) => lstat(path).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; });
const treeHash = async (path) => await exists(path) ? (await directoryBytes(path, { hash: true, maxBytes: 1024 * 1024 * 1024 })).hash : null;
async function canonicalTarget(path) {
  const remainder = []; let current = resolve(path);
  while (!await exists(current)) { remainder.unshift(basename(current)); current = dirname(current); }
  if ((await lstat(current)).isSymbolicLink()) throw new ServiceError("migration_link_denied");
  return join(await realpath(current), ...remainder);
}
const pathPart = (value) => {
  if (typeof value !== "string" || !value || value.length > 1000 || /[\\\x00-\x1f]/.test(value) || value.split("/").some((part) => !part || part.startsWith(".") || ["__proto__", "constructor", "prototype"].includes(part))) throw new ServiceError("invalid_migration_file_path");
  return value;
};

/** All generated migration work runs against copies. Only this host journal publishes data. */
export class ServiceDataMigrations {
  constructor({ rootDir, services } = {}) {
    if (!rootDir || !services) throw new TypeError("rootDir and services are required");
    this.rootDir = resolve(rootDir); this.services = services; this.locks = new Map();
  }
  directory(id) { checkedIdentity(id); return join(this.rootDir, id); }
  async save(record) { record.updatedAt = new Date().toISOString(); await atomicJSON(join(this.directory(record.id), "migration.json"), record); }
  async get(id) {
    const record = await readJSON(join(this.directory(id), "migration.json"));
    if (!record || record.id !== id || !Array.isArray(record.targets)) throw new ServiceError("migration_not_found");
    await this.validatePaths(record); return record;
  }
  async validatePaths(record) {
    const agentRoot = await realpath(record.agentRoot), directory = await realpath(this.directory(record.id));
    if (inside(agentRoot, directory)) throw new ServiceError("migration_backup_must_be_outside_agent_data");
    const approved = { business: join(agentRoot, "application", "business"), draft: join(agentRoot, "application", "draft"), workspace: join(agentRoot, "workspace") };
    for (const target of record.targets) {
      if (target.path !== approved[target.id] || target.staging !== join(directory, "staging", target.id) || target.backup !== join(directory, "backup", target.id) || target.moved !== `${target.path}.migration-${record.id}`) throw new ServiceError("invalid_migration_target");
      if (target.forward !== undefined && target.forward !== join(directory, "forward", target.id)) throw new ServiceError("invalid_migration_target");
      if (await exists(target.path) && (await lstat(target.path)).isSymbolicLink()) throw new ServiceError("migration_link_denied");
    }
  }
  serial(agentId, action) {
    const next = (this.locks.get(agentId) ?? Promise.resolve()).catch(() => {}).then(action); this.locks.set(agentId, next);
    next.finally(() => { if (this.locks.get(agentId) === next) this.locks.delete(agentId); }).catch(() => {}); return next;
  }
  async prepare(options) {
    checkedIdentity(options.agentId);
    return this.serial(options.agentId, () => this.prepareData(options));
  }
  async prepareData({ agentId, agentRoot, fromDeliveryVersion, toDeliveryVersion, fromVersion, toVersion, manifest, targets, signal, guard = async () => {} }) {
    [agentId, fromDeliveryVersion, toDeliveryVersion].forEach(checkedIdentity); manifest = validateServiceManifest(manifest);
    if (!manifest.migration || manifest.migration.fromVersion !== fromVersion || manifest.dataVersion !== toVersion || fromVersion >= toVersion) throw new ServiceError("migration_contract_missing");
    if (!Array.isArray(targets) || !targets.length || targets.length > 3 || new Set(targets.map((item) => item.id)).size !== targets.length) throw new ServiceError("invalid_migration_targets");
    agentRoot = await realpath(agentRoot); const id = `migration_${randomUUID()}`, directory = await privateDirectory(this.directory(id));
    const record = { schemaVersion: 1, id, agentId, agentRoot, fromDeliveryVersion, toDeliveryVersion, fromVersion, toVersion, manifestHash: serviceHash(manifest), migration: manifest.migration, status: "preparing", createdAt: new Date().toISOString(), targets: [] };
    for (const target of targets) {
      if (!["business", "draft", "workspace"].includes(target.id) || target.kind !== (target.id === "workspace" ? "files" : "state-records")) throw new ServiceError("invalid_migration_target");
      const path = await canonicalTarget(target.path);
      record.targets.push({ id: target.id, kind: target.kind, path, backup: join(directory, "backup", target.id), staging: join(directory, "staging", target.id), moved: `${path}.migration-${id}`, status: "pending" });
    }
    await this.validatePaths(record); signal?.throwIfAborted(); await guard(); await this.save(record);
    const scopeId = `migration:${id}`;
    try {
      for (const target of record.targets) {
        signal?.throwIfAborted(); await guard(); target.sourceHash = await treeHash(target.path); target.originalExists = target.sourceHash !== null;
        await privateDirectory(dirname(target.backup)); await privateDirectory(dirname(target.staging));
        if (target.originalExists) {
          await cp(target.path, target.backup, { recursive: true, dereference: false, errorOnExist: true, force: false });
          if (await treeHash(target.backup) !== target.sourceHash || await treeHash(target.path) !== target.sourceHash) throw new ServiceError("migration_source_changed");
          await cp(target.backup, target.staging, { recursive: true, dereference: false, errorOnExist: true, force: false });
          if (target.kind === "state-records") await this.checkStateRecords(target.backup, fromVersion);
        } else { await privateDirectory(target.backup); await privateDirectory(target.staging); }
      }
      record.status = "backed_up"; await this.save(record);
      const input = { fromVersion, toVersion }, capabilityHandler = (writable) => (capability, args) => this.fileCapability(record, capability, args, { writable, signal });
      await guard();
      const migrated = await this.services.run({ agentId, deliveryVersion: toDeliveryVersion, scopeId, actionId: manifest.migration.actionId, input, signal, persist: false, capabilityHandler: capabilityHandler(true) });
      if (migrated.status !== "passed") throw new ServiceError("data_migration_failed");
      const verified = await this.services.run({ agentId, deliveryVersion: toDeliveryVersion, scopeId, actionId: manifest.migration.verifyActionId, input, signal, persist: false, capabilityHandler: capabilityHandler(false) });
      if (verified.status !== "passed" || verified.output?.valid !== true) throw new ServiceError("data_migration_verification_failed");
      for (const target of record.targets) {
        if (target.kind === "state-records") await this.checkStateRecords(target.staging, toVersion);
        target.verifiedHash = await treeHash(target.staging);
        if (target.id === "workspace" && await treeHash(join(target.backup, "inputs")) !== await treeHash(join(target.staging, "inputs"))) throw new ServiceError("migration_input_materials_changed");
      }
      signal?.throwIfAborted(); await guard(); record.status = "verified";
      record.evidence = { migrated: true, verification: verified.output, manifestHash: record.manifestHash, sourceHash: (await this.services.getRecord({ agentId, deliveryVersion: toDeliveryVersion })).sourceHash };
      await this.save(record); return structuredClone(record);
    } catch (error) { record.status = "failed"; record.reason = signal?.aborted ? "cancelled" : error.reason ?? "data_migration_failed"; await this.save(record); throw Object.assign(error, { migrationId: id }); }
    finally { await this.services.stop({ agentId, deliveryVersion: toDeliveryVersion, scopeId }); }
  }
  async checkStateRecords(directory, stateVersion) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) throw new ServiceError("invalid_migration_state_file");
      const record = await readJSON(join(directory, entry.name));
      if (!record || record.stateVersion !== stateVersion || !Number.isSafeInteger(record.version) || record.version < 0 || !Object.hasOwn(record, "state") || Buffer.byteLength(JSON.stringify(record)) > 1024 * 1024) throw new ServiceError("invalid_migrated_state");
    }
  }
  async fileCapability(record, capability, args, { writable, signal }) {
    signal?.throwIfAborted();
    if (!["files.list", "files.read", "files.write"].includes(capability)) throw new ServiceError("migration_capability_denied");
    const value = capability === "files.list" ? args?.directory ?? "." : args?.file;
    const directory = join(this.directory(record.id), "staging");
    const target = value === "." && capability === "files.list" ? directory : join(directory, pathPart(value));
    if (!inside(directory, target)) throw new ServiceError("invalid_migration_file_path");
    const parts = value === "." ? [] : value.split("/");
    if (parts.length && !record.targets.some((item) => item.id === parts[0])) throw new ServiceError("invalid_migration_target");
    let cursor = directory;
    for (let index = 0; index < parts.length; index++) {
      cursor = join(cursor, parts[index]);
      if (!await exists(cursor)) {
        if (capability !== "files.write") throw new ServiceError("migration_file_missing");
        if (index < parts.length - 1) await mkdir(cursor, { mode: 0o700 }); continue;
      }
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || info.isFile() && info.nlink !== 1) throw new ServiceError("migration_link_denied");
    }
    if (capability === "files.list") {
      const files = (await readdir(target, { withFileTypes: true })).map((entry) => ({ name: entry.name, directory: entry.isDirectory() }));
      const offset = args?.offset ?? 0; if (!Number.isSafeInteger(offset) || offset < 0) throw new ServiceError("invalid_migration_offset");
      return { directory: value, files: files.slice(offset, offset + 120), truncated: offset + 120 < files.length, nextOffset: offset + 120 < files.length ? offset + 120 : null };
    }
    if (capability === "files.read") {
      const info = await lstat(target); if (!info.isFile() || info.size > 20 * 1024 * 1024) throw new ServiceError("migration_file_limit");
      const content = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(target));
      const offset = args?.offset ?? 0; if (!Number.isSafeInteger(offset) || offset < 0) throw new ServiceError("invalid_migration_offset");
      return { file: value, text: content.slice(offset, offset + 24000), truncated: offset + 24000 < content.length, nextOffset: offset + 24000 < content.length ? offset + 24000 : null };
    }
    if (!writable || parts.length < 2 || parts[0] === "workspace" && parts[1] === "inputs") throw new ServiceError("migration_write_denied");
    if (typeof args.content !== "string" || args.content.includes("\0") || Buffer.byteLength(args.content) > 1024 * 1024) throw new ServiceError("migration_write_limit");
    const temporary = `${target}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, args.content, { mode: 0o600, flag: "wx" }); signal?.throwIfAborted(); await rename(temporary, target); } finally { await rm(temporary, { force: true }); }
    return { file: value, saved: true };
  }
  async commit({ id, signal, guard = async () => {} }) {
    const initial = await this.get(id);
    return this.serial(initial.agentId, async () => {
      const record = await this.get(id); if (record.status === "committed") return record;
      if (record.status !== "verified") throw new ServiceError("migration_not_verified");
      const delivery = await this.services.getRecord({ agentId: record.agentId, deliveryVersion: record.toDeliveryVersion });
      if (delivery.manifestHash !== record.manifestHash || delivery.sourceHash !== record.evidence.sourceHash) throw new ServiceError("migration_delivery_changed");
      await guard(); signal?.throwIfAborted();
      for (const target of record.targets) if (await treeHash(target.path) !== target.sourceHash || await treeHash(target.staging) !== target.verifiedHash || await treeHash(target.backup) !== (target.sourceHash ?? serviceHash(""))) throw new ServiceError("migration_source_changed");
      record.status = "committing"; await this.save(record);
      try {
        for (const target of record.targets) {
          await guard(); signal?.throwIfAborted(); await privateDirectory(dirname(target.path));
          if (target.originalExists) await rename(target.path, target.moved);
          target.status = "original_moved"; await this.save(record);
          await rename(target.staging, target.path); target.status = "published"; await this.save(record);
        }
        record.status = "committed"; await this.save(record); return structuredClone(record);
      } catch (error) { await this.restoreData(record); throw Object.assign(error, { migrationId: record.id }); }
    });
  }
  async restoreData(record) {
    for (const target of record.targets) {
      const current = await treeHash(target.path), moved = await treeHash(target.moved);
      if (moved !== null && moved !== target.sourceHash) throw new ServiceError("migration_backup_changed");
      if (moved !== null && current !== null && current !== target.verifiedHash || !target.originalExists && current !== null && current !== target.verifiedHash) throw new ServiceError("data_changed_after_migration");
      if (moved === null && target.originalExists && current !== target.sourceHash) throw new ServiceError("migration_original_missing");
    }
    if (record.status === "committed") {
      const directory = await realpath(this.directory(record.id));
      for (const target of record.targets) {
        target.forward = join(directory, "forward", target.id); await privateDirectory(dirname(target.forward));
        if (!record.forwardPrepared && await exists(target.forward) && await treeHash(target.forward) !== target.verifiedHash) await rm(target.forward, { recursive: true, force: true });
        if (!await exists(target.forward)) await cp(target.path, target.forward, { recursive: true, dereference: false, errorOnExist: true, force: false });
        if (await treeHash(target.forward) !== target.verifiedHash || await treeHash(target.path) !== target.verifiedHash) throw new ServiceError("data_changed_after_migration");
      }
      record.forwardPrepared = true;
    }
    record.status = "rolling_back"; await this.save(record);
    for (const target of [...record.targets].reverse()) {
      const current = await treeHash(target.path), moved = await treeHash(target.moved);
      if (moved !== null && moved !== target.sourceHash) throw new ServiceError("migration_backup_changed");
      if (moved !== null) {
        if (current !== null && current !== target.verifiedHash) throw new ServiceError("data_changed_after_migration");
        if (current !== null) await rm(target.path, { recursive: true, force: true });
        await rename(target.moved, target.path);
      } else if (!target.originalExists && current !== null) {
        if (current !== target.verifiedHash) throw new ServiceError("data_changed_after_migration");
        await rm(target.path, { recursive: true, force: true });
      } else if (target.originalExists && current !== target.sourceHash) throw new ServiceError("migration_original_missing");
      target.status = "restored"; await this.save(record);
    }
    record.status = "rolled_back"; await this.save(record); return structuredClone(record);
  }
  async rollback({ id, guard = async () => {} }) {
    const initial = await this.get(id);
    return this.serial(initial.agentId, async () => {
      const record = await this.get(id); if (record.status === "rolled_back") return record;
      if (!["committing", "committed", "rolling_back"].includes(record.status)) throw new ServiceError("migration_not_published");
      await guard(); return this.restoreData(record);
    });
  }
  async reapply({ id, signal, guard = async () => {} }) {
    const initial = await this.get(id);
    await this.serial(initial.agentId, async () => {
      const record = await this.get(id);
      if (record.status === "committed") return;
      if (record.status !== "rolled_back" || !record.forwardPrepared) throw new ServiceError("migration_forward_copy_unavailable");
      await guard(); signal?.throwIfAborted();
      for (const target of record.targets) {
        if (await treeHash(target.path) !== target.sourceHash || !target.forward || await treeHash(target.forward) !== target.verifiedHash) throw new ServiceError("migration_source_changed");
      }
      for (const target of record.targets) {
        await rm(target.staging, { recursive: true, force: true });
        await cp(target.forward, target.staging, { recursive: true, dereference: false, errorOnExist: true, force: false });
        if (await treeHash(target.staging) !== target.verifiedHash) throw new ServiceError("migration_forward_copy_changed");
        target.status = "pending";
      }
      record.status = "verified"; await this.save(record);
    });
    return this.commit({ id, signal, guard });
  }
  async recover() {
    await privateDirectory(this.rootDir); const results = [];
    for (const entry of await readdir(this.rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("migration_")) continue;
      const record = await this.get(entry.name);
      if (["committing", "rolling_back"].includes(record.status)) results.push(await this.rollback({ id: record.id }));
      else if (["preparing", "backed_up"].includes(record.status)) { record.status = "interrupted"; await this.save(record); results.push(record); }
    }
    return results;
  }
}
