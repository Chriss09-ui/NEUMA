(() => {
  "use strict";
  const config = window.__NEUMA_APPLICATION__;
  delete window.__NEUMA_APPLICATION__;
  if (!config?.parentOrigin || !config.instanceId || config.deliveryVersion === undefined) return;
  const parentWindow = window.parent, pending = new Map();
  let sequence = 0;
  function call(method, params = {}) {
    const requestId = `${Date.now().toString(36)}-${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("操作回执超时，请在任务记录中核实结果。")); }, 130_000);
      pending.set(requestId, { resolve, reject, timer });
      parentWindow.postMessage({ channel: "neuma.application", protocolVersion: 1, type: "request",
        instanceId: config.instanceId, deliveryVersion: config.deliveryVersion, requestId, method, params }, config.parentOrigin);
    });
  }
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== parentWindow || event.origin !== config.parentOrigin || !message
      || message.channel !== "neuma.application" || message.protocolVersion !== 1 || message.type !== "response"
      || message.instanceId !== config.instanceId || message.deliveryVersion !== config.deliveryVersion) return;
    const item = pending.get(message.requestId);
    if (!item) return;
    pending.delete(message.requestId); clearTimeout(item.timer);
    if (message.error) item.reject(Object.assign(new Error(message.error.message), { reason: message.error.reason, status: message.error.status }));
    else item.resolve(message.result);
  });
  Object.defineProperty(window, "neuma", { configurable: false, writable: false, value: Object.freeze({
    actions: Object.freeze({ run: (actionId, input = {}, options = {}) => call("actions.run", { actionId, input, mutationId: options.mutationId }) }),
    tasks: Object.freeze({ list: () => call("tasks.list"), get: (taskId) => call("tasks.get", { taskId }),
      events: (taskId, after = 0) => call("tasks.events", { taskId, after }), cancel: (taskId) => call("tasks.cancel", { taskId }) }),
    state: Object.freeze({ get: () => call("state.get"), save: (state, expectedVersion) => call("state.save", { state, expectedVersion }) }),
    materials: Object.freeze({ list: () => call("materials.list"), select: () => call("materials.select") }),
    artifacts: Object.freeze({ open: () => call("artifacts.open") }),
    settings: Object.freeze({ open: () => call("settings.open") }),
  }) });
})();
