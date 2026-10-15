const MAX_BYTES = 16 * 1024;
let current = null;

function cleanJson(value) {
  let nodes = 0;
  const seen = new Set();
  function visit(item, depth = 0) {
    if (++nodes > 4096 || depth > 12) throw new Error("页面上下文结构过大，请只提供当前视图的必要信息。");
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string" && !item.includes("\0") && item.length <= MAX_BYTES) return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (!item || typeof item !== "object" || seen.has(item)
      || !Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error("页面上下文必须是 JSON 数据。");
    seen.add(item);
    const result = Array.isArray(item) ? [] : {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (Array.isArray(item) && key === "length") continue;
      if (["__proto__", "constructor", "prototype"].includes(key) || !Object.hasOwn(descriptor, "value")
        || Array.isArray(item) && !/^(0|[1-9]\d*)$/.test(key)) throw new Error("页面上下文包含不支持的字段。");
      result[key] = visit(descriptor.value, depth + 1);
    }
    if (Object.getOwnPropertySymbols(item).length) throw new Error("页面上下文必须是 JSON 数据。");
    seen.delete(item); return result;
  }
  return visit(value);
}

export function activateApplicationContext(agentId, instance) {
  current = { agentId, instanceId: instance.instanceId, deliveryVersion: instance.deliveryVersion, revision: 0, snapshot: null };
}

export function setApplicationContext(agentId, instanceId, snapshot) {
  if (!current || current.agentId !== agentId || current.instanceId !== instanceId) throw new Error("页面已经切换，请重新打开后再试。");
  let next = null;
  if (snapshot !== null) {
    if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== "object"
      || Object.keys(snapshot).some((key) => !["viewId", "title", "summary", "selection", "values"].includes(key))
      || ["viewId", "title", "summary"].some((key) => typeof snapshot[key] !== "string")) throw new Error("页面上下文格式无效。");
    next = { viewId: snapshot.viewId, title: snapshot.title, summary: snapshot.summary,
      selection: snapshot.selection ?? null, values: snapshot.values ?? {} };
  }
  const revision = current.revision + 1;
  const envelope = cleanJson({ instanceId, deliveryVersion: current.deliveryVersion, revision, snapshot: next });
  if (new TextEncoder().encode(JSON.stringify(envelope)).length > MAX_BYTES) throw new Error("页面上下文超过 16 KiB，请只提供当前视图的必要信息。");
  current = { ...current, revision, snapshot: envelope.snapshot };
  return { revision };
}

export const clearApplicationContext = (agentId, instanceId) => setApplicationContext(agentId, instanceId, null);

export function getApplicationContext(agentId) {
  if (current?.agentId !== agentId || !current.snapshot) return undefined;
  const { instanceId, deliveryVersion, revision, snapshot } = current;
  return structuredClone({ instanceId, deliveryVersion, revision, snapshot });
}

export function releaseApplicationContext(agentId, instanceId) {
  if (current?.agentId === agentId && current.instanceId === instanceId) current = null;
}

export function getApplicationActionContext(agentId) {
  if (current?.agentId !== agentId) return undefined;
  const { instanceId, deliveryVersion, revision } = current;
  return getApplicationContext(agentId) ?? { instanceId, deliveryVersion, revision,
    snapshot: { viewId: "", title: "", summary: "", selection: null, values: {} } };
}

export function applicationTaskEvent(agentId, task) {
  if (current?.agentId !== agentId || task.deliveryVersion !== current.deliveryVersion) return null;
  const source = task.source?.applicationContext;
  if (!source || source.instanceId !== current.instanceId || source.deliveryVersion !== current.deliveryVersion) return null;
  return { taskId: task.id || task.taskId, actionId: task.actionId, status: task.status,
    sequence: task.sequence, deliveryVersion: current.deliveryVersion,
    ...(source ? { contextRevision: source.revision, stale: source.revision !== current.revision } : { stale: false }) };
}
