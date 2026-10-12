export const APPLICATION_CHANNEL = "neuma.application";

export function installApplicationHostBridge({ window, frame, instance, agentId, api, onTasks = () => {},
  onSettings = () => {}, onArtifacts = () => {}, selectMaterials = async () => [] }) {
  let active = true;
  const replies = new Map();
  const operations = {
    "actions.run": (params, requestId) => api.run(agentId, params.actionId, params.input ?? {},
      params.mutationId || `${instance.instanceId}-${requestId}`, instance.deliveryVersion).then((result) => { onTasks(); return result; }),
    "tasks.list": () => api.tasks(agentId),
    "tasks.get": (params) => api.task(agentId, params.taskId),
    "tasks.events": (params) => api.events(agentId, params.taskId, params.after || 0),
    "tasks.cancel": (params) => api.cancel(agentId, params.taskId).then((result) => { onTasks(); return result; }),
    "state.get": () => api.getState(agentId, instance.deliveryVersion),
    "state.save": (params) => api.saveState(agentId, params.state, params.expectedVersion, instance.deliveryVersion),
    "materials.list": () => api.materials(agentId),
    "materials.select": () => selectMaterials(agentId),
    "artifacts.open": () => { onArtifacts(); return { opened: true }; },
    "settings.open": () => { onSettings(); return { opened: true }; },
  };
  async function receive(event) {
    const message = event.data;
    if (!active || event.source !== frame.contentWindow || event.origin !== instance.origin
      || !message || message.channel !== APPLICATION_CHANNEL || message.type !== "request" || message.protocolVersion !== 1
      || message.instanceId !== instance.instanceId || message.deliveryVersion !== instance.deliveryVersion
      || typeof message.requestId !== "string" || !/^[\w-]{1,60}$/.test(message.requestId)) return;
    const params = message.params;
    if (params !== undefined && (!params || typeof params !== "object" || Array.isArray(params))) return;
    try { if (JSON.stringify(message).length > 1_048_576) return; } catch { return; }
    const operation = Object.hasOwn(operations, message.method) ? operations[message.method] : null;
    if (!replies.has(message.requestId)) {
      const result = Promise.resolve().then(() => {
        if (!operation) throw new Error("此页面能力未开放。");
        return operation(params || {}, message.requestId);
      }).then((value) => ({ result: value }), (error) => ({ error: { message: error.message || "操作未完成。", reason: error.reason, status: error.status } }));
      replies.set(message.requestId, result);
      if (replies.size > 128) replies.delete(replies.keys().next().value);
    }
    const response = await replies.get(message.requestId);
    if (!active) return;
    frame.contentWindow.postMessage({ channel: APPLICATION_CHANNEL, protocolVersion: 1, type: "response",
      instanceId: instance.instanceId, deliveryVersion: instance.deliveryVersion, requestId: message.requestId, ...response }, instance.origin);
  }
  window.addEventListener("message", receive);
  return () => { active = false; window.removeEventListener("message", receive); replies.clear(); };
}
