import { isPlainRecord, isArray, isInteger, objectFields } from "../runtime/type-boundary.mjs";
import type { UnknownRecord } from "../contracts/json.mjs";
import type { ServiceManifest, ServiceOperation, DependencyLock, ServiceHost, ServiceLanguage } from "../contracts/service.mjs";
import type { ToolSchema } from "../contracts/tools.mjs";
import { createHash } from "node:crypto";
import { validateValueSchema } from "../applications/application-contract.mjs";
import { VALUE_SCHEMA_DESCRIPTION } from "../applications/value-schema-rules.mjs";
import { validateWorkflowDefinition, WORKFLOW_SCHEMA } from "./workflow-contract.mjs";
import { SERVICE_HOSTS, SERVICE_LANGUAGES } from "./service-runtime-options.mjs";

export const SERVICE_DEFAULTS = Object.freeze({ timeoutMs: 600000, memoryMiB: 512, scratchMiB: 100, logBytes: 131072 });
export const SERVICE_CAPABILITIES = Object.freeze(["web.search", "web.fetch", "model.call", "connection.call", "connection.readResult", "material.list", "material.read", "material.image", "files.list", "files.read", "files.write", "state.get", "state.set"]);
export class ServiceError extends Error {
  reason: string;
  constructor(reason: string, message = reason) { super(message); this.name = "ServiceError"; this.reason = reason; }
}
const plain = isPlainRecord;
export const serviceHash = (value: unknown) => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
export const checkedIdentity = (value: unknown) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value) || value.includes("..")) throw new ServiceError("invalid_identity");
  return value;
};
function keys(value: unknown, allowed: string[]): asserts value is UnknownRecord {
  if (!plain(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new ServiceError("invalid_service_manifest");
};
function integer(value: unknown, min: number, max: number) {
  if (!isInteger(value) || value < min || value > max) throw new ServiceError("invalid_service_limits");
  return value;
}

export function validateServiceManifest(input: unknown): ServiceManifest {
  keys(input, ["schemaVersion", "language", "host", "entrypoint", "operations", "dependencies", "resources", "docker", "dataVersion", "capabilities", "workflow", "migration"]);
  if (input.schemaVersion !== 1 || typeof input.language !== "string" || !SERVICE_LANGUAGES.includes(input.language) || typeof input.host !== "string" || !SERVICE_HOSTS.includes(input.host)) throw new ServiceError("unsupported_service_runtime");
  if (typeof input.entrypoint !== "string" || input.entrypoint.length > 500 || /[\\\x00-\x1f\x7f:*?"<>|]/.test(input.entrypoint) || input.entrypoint.split("/").some((part) => !part || part.startsWith(".") || /^(?:metadata|node_modules|credentials?|secrets?|tokens?|passwords?)$/i.test(part))) throw new ServiceError("invalid_service_entrypoint");
  if (input.language === "python" ? !input.entrypoint.endsWith(".py") : !/\.(mjs|js|cjs)$/.test(input.entrypoint)) throw new ServiceError("invalid_service_entrypoint");
  if (!isArray(input.operations) || !input.operations.length || input.operations.length > 80) throw new ServiceError("invalid_service_operations");
  const operations = input.operations.map((operation) => {
    keys(operation, ["id", "title", "inputSchema", "outputSchema", "connectionIds", "idempotent", "visibility"]);
    if (typeof operation.id !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(operation.id) || ["constructor", "prototype", "__proto__"].includes(operation.id)) throw new ServiceError("invalid_service_operation");
    validateValueSchema(operation.inputSchema); validateValueSchema(operation.outputSchema);
    if (operation.idempotent !== undefined && typeof operation.idempotent !== "boolean") throw new ServiceError("invalid_service_operation");
    if (operation.visibility !== undefined && (typeof operation.visibility !== "string" || !["public", "internal"].includes(operation.visibility))) throw new ServiceError("invalid_service_operation_visibility");
    if (operation.connectionIds !== undefined && (!Array.isArray(operation.connectionIds) || operation.connectionIds.some((id) => typeof id !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(id)))) throw new ServiceError("invalid_service_connections");
    return structuredClone(operation) as ServiceOperation;
  });
  if (new Set(operations.map((operation) => operation.id)).size !== operations.length) throw new ServiceError("duplicate_service_operation");
  keys(input.resources ?? {}, Object.keys(SERVICE_DEFAULTS));
  const resources = { ...SERVICE_DEFAULTS, ...objectFields(input.resources) };
  integer(resources.timeoutMs, 1, 3600000); integer(resources.memoryMiB, 32, 8192);
  integer(resources.scratchMiB, 1, 2048); integer(resources.logBytes, 1024, 1048576);
  keys(input.dependencies ?? {}, ["packages"]);
  const packages = objectFields(input.dependencies).packages ?? [];
  if (!isArray(packages) || packages.length > 200) throw new ServiceError("invalid_service_dependencies");
  const dependencies = packages.map((pkg) => {
    keys(pkg, ["name", "version", "url", "sha256", "filename", "target", "installPath"]);
    if (typeof pkg.name !== "string" || !/^(?:@[a-z0-9._-]+\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/.test(pkg.name)
      || typeof pkg.version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,99}$/.test(pkg.version)
      || typeof pkg.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(pkg.sha256) || typeof pkg.filename !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.+-]{0,250}$/.test(pkg.filename)) throw new ServiceError("invalid_dependency_lock");
    let url; try { url = new URL(String(pkg.url)); } catch { throw new ServiceError("invalid_dependency_url"); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash || !["registry.npmjs.org", "files.pythonhosted.org"].includes(url.hostname)) throw new ServiceError("untrusted_dependency_source");
    if (input.language === "python" ? !pkg.filename.endsWith(".whl") : !/\.(tgz|tar.gz)$/.test(pkg.filename)) throw new ServiceError("unsupported_dependency_format", "直接托管只安装已锁定的 wheel 或无安装脚本的 npm 包；需要编译的依赖请选择 Docker");
    if (pkg.installPath !== undefined && (input.language !== "javascript" || typeof pkg.installPath !== "string" || !/^(?:node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)(?:\/node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)*$/.test(pkg.installPath) || pkg.installPath.includes(".."))) throw new ServiceError("invalid_dependency_path");
    return structuredClone({ ...pkg, url: String(pkg.url) }) as DependencyLock;
  });
  if (new Set(dependencies.map((pkg) => pkg.installPath ?? pkg.name.toLowerCase().replaceAll("_", "-"))).size !== packages.length) throw new ServiceError("duplicate_dependency");
  const artifacts = new Map();
  for (const pkg of dependencies) { if (artifacts.has(pkg.filename) && artifacts.get(pkg.filename) !== pkg.sha256) throw new ServiceError("dependency_filename_collision"); artifacts.set(pkg.filename, pkg.sha256); }
  const capabilities = input.capabilities ?? SERVICE_CAPABILITIES;
  if (!Array.isArray(capabilities) || capabilities.some((value) => typeof value !== "string" || !SERVICE_CAPABILITIES.includes(value)) || new Set(capabilities).size !== capabilities.length) throw new ServiceError("invalid_service_capabilities");
  if (input.host === "docker") {
    keys(input.docker, ["baseImage", "buildSteps"]);
    if (typeof input.docker.baseImage !== "string" || !/^(?:(?:docker\.io\/)?library\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*@sha256:[a-f0-9]{64}$/.test(input.docker.baseImage)) throw new ServiceError("docker_image_must_be_pinned", "当前只支持经过核实并固定摘要的 Docker Hub 官方 library 镜像");
    if (input.docker.buildSteps !== undefined && (!Array.isArray(input.docker.buildSteps) || input.docker.buildSteps.length > 20 || input.docker.buildSteps.some((step) => !Array.isArray(step) || !step.length || step.length > 40 || step.some((part) => typeof part !== "string" || part.length > 4000 || /[\0\r\n]/.test(part))))) throw new ServiceError("invalid_docker_build_steps");
  } else if (input.docker !== undefined) throw new ServiceError("unexpected_docker_configuration");
  const result: ServiceManifest = { schemaVersion: 1, language: input.language as ServiceLanguage, host: input.host as ServiceHost, entrypoint: input.entrypoint, operations,
    dependencies: { packages: dependencies }, resources, capabilities: [...capabilities], dataVersion: integer(input.dataVersion ?? 1, 1, 1000000) };
  if (input.docker) result.docker = structuredClone(input.docker) as NonNullable<ServiceManifest["docker"]>;
  if (input.workflow) {
    result.workflow = validateWorkflowDefinition(input.workflow, { operationIds: operations.map((operation) => operation.id) });
    const entry = operations.find((operation) => operation.id === result.workflow!.entryActionId);
    if (entry!.visibility === "internal") throw new ServiceError("workflow_entry_must_be_public");
    for (const step of result.workflow.steps) {
      const operation = operations.find((operation) => operation.id === step.actionId);
      if (operation!.connectionIds?.some((id) => !entry!.connectionIds?.includes(id))) throw new ServiceError("workflow_entry_connections_incomplete");
    }
  }
  if (input.migration) {
    keys(input.migration, ["fromVersion", "actionId", "verifyActionId"]);
    const fromVersion = integer(input.migration.fromVersion, 1, 1000000);
    if (fromVersion >= result.dataVersion || input.migration.actionId === input.migration.verifyActionId) throw new ServiceError("invalid_data_migration");
    for (const id of [input.migration.actionId, input.migration.verifyActionId]) {
      const operation = operations.find((operation) => operation.id === id);
      if (!operation || operation.visibility !== "internal" || operation.connectionIds?.length) throw new ServiceError("migration_must_be_internal_and_offline");
    }
    result.migration = structuredClone(input.migration) as NonNullable<ServiceManifest["migration"]>;
  }
  return result;
}
export const hashServiceManifest = (manifest: unknown) => serviceHash(validateServiceManifest(manifest));

const objectSchema = (properties: Record<string, ToolSchema>, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const valueSchema = { type: "object", additionalProperties: true, description: VALUE_SCHEMA_DESCRIPTION };
const text = { type: "string" }, number = { type: "integer" };
export const SERVICE_MANIFEST_SCHEMA = objectSchema({
  schemaVersion: { type: "integer", const: 1 }, language: { type: "string", enum: [...SERVICE_LANGUAGES] }, host: { type: "string", enum: [...SERVICE_HOSTS] }, entrypoint: text,
  operations: { type: "array", minItems: 1, maxItems: 80, items: objectSchema({ id: text, title: text, inputSchema: valueSchema, outputSchema: valueSchema, connectionIds: { type: "array", items: text }, idempotent: { type: "boolean" }, visibility: { type: "string", enum: ["public", "internal"] } }, ["id", "inputSchema", "outputSchema"]) },
  dependencies: objectSchema({ packages: { type: "array", items: objectSchema({ name: text, version: text, url: text, sha256: text, filename: text, target: text, installPath: text }, ["name", "version", "url", "sha256", "filename"]) } }),
  resources: objectSchema({ timeoutMs: number, memoryMiB: number, scratchMiB: number, logBytes: number }, []),
  capabilities: { type: "array", items: { type: "string", enum: [...SERVICE_CAPABILITIES] } }, dataVersion: number,
  docker: objectSchema({ baseImage: text, buildSteps: { type: "array", items: { type: "array", items: text } } }, ["baseImage"]),
  workflow: WORKFLOW_SCHEMA,
  migration: objectSchema({ fromVersion: number, actionId: text, verifyActionId: text })
}, ["schemaVersion", "language", "host", "entrypoint", "operations"]);
