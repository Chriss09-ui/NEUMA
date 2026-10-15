(() => {
  "use strict";
  const config = window.__NEUMA_APPLICATION__;
  delete window.__NEUMA_APPLICATION__;
  if (!config?.parentOrigin || !config.instanceId || config.deliveryVersion === undefined) return;
  const parentWindow = window.parent, pending = new Map();
  const subscribers = new Set(), taskSequences = new Map();
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
      || message.channel !== "neuma.application" || message.protocolVersion !== 1
      || message.instanceId !== config.instanceId || message.deliveryVersion !== config.deliveryVersion) return;
    if (message.type === "event" && message.event === "tasks.changed") {
      const task = message.data;
      if (!task || typeof task.taskId !== "string" || !Number.isSafeInteger(task.sequence) || task.sequence < 0
        || task.deliveryVersion !== config.deliveryVersion || task.sequence <= (taskSequences.get(task.taskId) ?? -1)) return;
      taskSequences.set(task.taskId, task.sequence);
      for (const subscriber of subscribers) { try { subscriber(Object.freeze({ ...task })); } catch {} }
      return;
    }
    if (message.type !== "response") return;
    const item = pending.get(message.requestId);
    if (!item) return;
    pending.delete(message.requestId); clearTimeout(item.timer);
    if (message.error) item.reject(Object.assign(new Error(message.error.message), { reason: message.error.reason, status: message.error.status }));
    else item.resolve(message.result);
  });
  Object.defineProperty(window, "neuma", { configurable: false, writable: false, value: Object.freeze({
    actions: Object.freeze({ run: (actionId, input = {}, options = {}) => call("actions.run", { actionId, input, mutationId: options.mutationId }) }),
    tasks: Object.freeze({ list: () => call("tasks.list"), get: (taskId) => call("tasks.get", { taskId }),
      events: (taskId, after = 0) => call("tasks.events", { taskId, after }), cancel: (taskId) => call("tasks.cancel", { taskId }),
      subscribe: (handler) => {
        if (typeof handler !== "function") throw new TypeError("任务订阅需要回调函数。");
        subscribers.add(handler); return () => subscribers.delete(handler);
      } }),
    assistant: Object.freeze({ setContext: (snapshot) => call("assistant.setContext", { snapshot }),
      clearContext: () => call("assistant.clearContext"), open: () => call("assistant.open") }),
    state: Object.freeze({ get: () => call("state.get"), save: (state, expectedVersion) => call("state.save", { state, expectedVersion }) }),
    materials: Object.freeze({ list: () => call("materials.list"), select: () => call("materials.select") }),
    artifacts: Object.freeze({ open: () => call("artifacts.open") }),
    settings: Object.freeze({ open: () => call("settings.open") }),
  }) });
  // Clear the previous document before business scripts publish their first snapshot.
  parentWindow.postMessage({ channel: "neuma.application", protocolVersion: 1, type: "document.ready",
    instanceId: config.instanceId, deliveryVersion: config.deliveryVersion }, config.parentOrigin);
})();
