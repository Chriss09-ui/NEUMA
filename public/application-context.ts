import type { ApplicationContext, ApplicationInstance, JsonValue, TaskView } from "./ui-types.js";
import { objectFields } from "./ui-types.js";
const MAX_BYTES = 16 * 1024;
let current: (Omit<ApplicationContext, "snapshot"> & { agentId: string; snapshot: ApplicationContext["snapshot"] | null }) | null = null;

function cleanJson(value: unknown): JsonValue {
  let nodes = 0;
  const seen = new Set<object>();
  function visit(item: unknown, depth = 0): JsonValue {
    if (++nodes > 4096 || depth > 12) throw new Error("页面上下文结构过大，请只提供当前视图的必要信息。");
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string" && !item.includes("\0") && item.length <= MAX_BYTES) return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (!item || typeof item !== "object" || seen.has(item)
      || !Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error("页面上下文必须是 JSON 数据。");
    seen.add(item);
    const result: { [key: string]: JsonValue } | JsonValue[] = Array.isArray(item) ? [] : {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (Array.isArray(item) && key === "length") continue;
      if (["__proto__", "constructor", "prototype"].includes(key) || !Object.hasOwn(descriptor, "value")
        || Array.isArray(item) && !/^(0|[1-9]\d*)$/.test(key)) throw new Error("页面上下文包含不支持的字段。");
      (result as Record<string, JsonValue>)[key] = visit(descriptor.value, depth + 1);
    }
    if (Object.getOwnPropertySymbols(item).length) throw new Error("页面上下文必须是 JSON 数据。");
    seen.delete(item); return result;
  }
  return visit(value);
}

export function activateApplicationContext(agentId: string, instance: Pick<ApplicationInstance, "instanceId" | "deliveryVersion">) {
  current = { agentId, instanceId: instance.instanceId, deliveryVersion: instance.deliveryVersion, revision: 0, snapshot: null };
}

export function setApplicationContext(agentId: string, instanceId: string, snapshot: unknown) {
  if (!current || current.agentId !== agentId || current.instanceId !== instanceId) throw new Error("页面已经切换，请重新打开后再试。");
  let next: ApplicationContext["snapshot"] | null = null;
  if (snapshot !== null) {
    if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== "object"
      || Object.keys(snapshot).some((key) => !["viewId", "title", "summary", "selection", "values"].includes(key))
      || ["viewId", "title", "summary"].some((key) => typeof objectFields(snapshot)[key] !== "string")) throw new Error("页面上下文格式无效。");
    next = { viewId: objectFields(snapshot).viewId as string, title: objectFields(snapshot).title as string, summary: objectFields(snapshot).summary as string,
      selection: (objectFields(snapshot).selection ?? null) as JsonValue, values: (objectFields(snapshot).values ?? {}) as JsonValue };
  }
  const revision = current.revision + 1;
  const envelope = cleanJson({ instanceId, deliveryVersion: current.deliveryVersion, revision, snapshot: next });
  if (new TextEncoder().encode(JSON.stringify(envelope)).length > MAX_BYTES) throw new Error("页面上下文超过 16 KiB，请只提供当前视图的必要信息。");
  current = { ...current, revision, snapshot: objectFields(envelope).snapshot as ApplicationContext["snapshot"] | null };
  return { revision };
}

export const clearApplicationContext = (agentId: string, instanceId: string) => setApplicationContext(agentId, instanceId, null);

export function getApplicationContext(agentId: string | null) {
  if (current?.agentId !== agentId || !current.snapshot) return undefined;
  const { instanceId, deliveryVersion, revision, snapshot } = current;
  return structuredClone({ instanceId, deliveryVersion, revision, snapshot });
}

export function releaseApplicationContext(agentId: string, instanceId: string) {
  if (current?.agentId === agentId && current.instanceId === instanceId) current = null;
}

export function getApplicationActionContext(agentId: string | null) {
  if (current?.agentId !== agentId) return undefined;
  const { instanceId, deliveryVersion, revision } = current;
  return getApplicationContext(agentId) ?? { instanceId, deliveryVersion, revision,
    snapshot: { viewId: "", title: "", summary: "", selection: null, values: {} } };
}

export function applicationTaskEvent(agentId: string | null, task: Omit<TaskView,"source"> & {source?:{applicationContext?:Pick<ApplicationContext,"instanceId"|"deliveryVersion"|"revision">|undefined}|undefined}) {
  if (current?.agentId !== agentId || task.deliveryVersion !== current.deliveryVersion) return null;
  const source = task.source?.applicationContext;
  if (!source || source.instanceId !== current.instanceId || source.deliveryVersion !== current.deliveryVersion) return null;
  return { taskId: task.id || task.taskId, actionId: task.actionId, status: task.status,
    sequence: task.sequence, deliveryVersion: current.deliveryVersion,
    ...(source ? { contextRevision: source.revision, stale: source.revision !== current.revision } : { stale: false }) };
}
