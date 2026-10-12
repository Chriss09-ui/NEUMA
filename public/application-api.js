export function createApplicationApi(request = fetch) {
  async function json(id, suffix, body, method = "POST", options = {}) {
    const response = await request(`/api/agents/${encodeURIComponent(id)}${suffix}`, {
      ...options, ...(body === undefined ? {} : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error || "请求未完成，请重试。");
      error.status = response.status; error.reason = result.reason;
      throw error;
    }
    return result;
  }
  const part = encodeURIComponent;
  return {
    application: (id) => json(id, "/application"),
    open: (id) => json(id, "/application/open", {}),
    close: (id, instanceId, options) => json(id, "/application/close", { instanceId }, "POST", options),
    getState: (id, deliveryVersion) => json(id, `/application/state${deliveryVersion === undefined ? "" : `?deliveryVersion=${part(deliveryVersion)}`}`),
    saveState: (id, state, expectedVersion, deliveryVersion) => json(id, "/application/state", { state, expectedVersion, deliveryVersion }, "PUT"),
    run: (id, actionId, input, mutationId, deliveryVersion) => json(id, "/tasks", { actionId, input, mutationId, deliveryVersion }),
    tasks: (id) => json(id, "/tasks"),
    task: (id, taskId) => json(id, `/tasks/${part(taskId)}`),
    events: (id, taskId, after = 0) => json(id, `/tasks/${part(taskId)}/events?after=${encodeURIComponent(after)}`),
    cancel: (id, taskId) => json(id, `/tasks/${part(taskId)}/cancel`, {}),
    materials: (id) => json(id, "/attachments"),
    connections: (id) => json(id, "/connections"),
    saveConnection: (id, connection) => json(id, "/connections", connection),
    testConnection: (id, connectionId) => json(id, `/connections/${part(connectionId)}/test`, {}),
    removeConnection: (id, connectionId, expectedVersion) => json(id, `/connections/${part(connectionId)}/remove`, { expectedVersion }),
  };
}
