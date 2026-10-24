import { objectFields, isRecord } from "../runtime/type-boundary.mjs";
import type { ServiceCatalog, DeliveryRecord, ServiceIdentity } from "./service-port.mjs";
import { ServiceError, validateServiceManifest } from "./service-contract.mjs";
const invalid = () => new ServiceError("invalid_service_record");
function identity(value: unknown): ServiceIdentity {
  const item = objectFields(value);
  if (typeof item.agentId !== "string" || typeof item.deliveryVersion !== "string" || item.scopeId !== undefined && typeof item.scopeId !== "string") throw invalid();
  return { agentId: item.agentId, deliveryVersion: item.deliveryVersion, ...(item.scopeId !== undefined ? { scopeId: item.scopeId } : {}) };
}
export function serviceDelivery(value: unknown): DeliveryRecord {
  const item = objectFields(value), dependencies = objectFields(item.dependencies), isolation = objectFields(item.isolation);
  identity(item);
  if (item.schemaVersion !== 1 || ["directory", "codeDir", "sourceHash", "manifestHash", "createdAt"].some((key) => typeof item[key] !== "string")
    || ["path", "hash", "treeHash"].some((key) => typeof dependencies[key] !== "string") || typeof isolation.available !== "boolean") throw invalid();
  const manifest = validateServiceManifest(item.manifest);
  if (manifest.host === "docker") {
    const docker = objectFields(item.docker);
    if (["imageId", "seccompPath", "buildHash"].some((key) => typeof docker[key] !== "string")) throw invalid();
  }
  return item as typeof item & DeliveryRecord;
}
export function serviceCatalog(value: unknown): ServiceCatalog {
  const item = objectFields(value);
  if (item.schemaVersion !== 1 || !isRecord(item.deliveries) || !isRecord(item.active) || !isRecord(item.desired)) throw invalid();
  for (const record of Object.values(item.deliveries)) serviceDelivery(record);
  for (const version of Object.values(item.active)) if (typeof version !== "string") throw invalid();
  for (const desired of Object.values(item.desired)) identity(desired);
  return item as typeof item & ServiceCatalog;
}
