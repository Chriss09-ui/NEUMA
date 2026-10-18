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
    run: (id, actionId, input, mutationId, deliveryVersion, applicationContext) => json(id, "/tasks", {
      actionId, input, mutationId, deliveryVersion, ...(applicationContext ? { applicationContext } : {}),
    }),
    tasks: (id) => json(id, "/tasks"),
    task: (id, taskId) => json(id, `/tasks/${part(taskId)}`),
    events: (id, taskId, after = 0) => json(id, `/tasks/${part(taskId)}/events?after=${encodeURIComponent(after)}`),
    cancel: (id, taskId) => json(id, `/tasks/${part(taskId)}/cancel`, {}),
    resumeTask: (id, taskId, input, expectedVersion, mutationId, resolution) => json(id, `/tasks/${part(taskId)}/resume`, {
      ...(input === undefined ? {} : { input }), ...(resolution ? { resolution } : {}), expectedVersion, mutationId }),
    services: (id) => json(id, "/services"),
    prepareService: (id, language, host) => json(id, "/services/prepare", { language, host }),
    startService: (id, deliveryVersion) => json(id, "/services/start", { deliveryVersion }),
    stopService: (id, deliveryVersion) => json(id, "/services/stop", { deliveryVersion }),
    restartService: (id, deliveryVersion) => json(id, "/services/restart", { deliveryVersion }),
    serviceLogs: (id, deliveryVersion) => json(id, `/services/logs?deliveryVersion=${part(deliveryVersion)}`),
    rollbackService: (id, deliveryVersion) => json(id, "/services/rollback", { deliveryVersion }),
    gateway: (id) => json(id, "/gateway"),
    configureGateway: (id, actionIds, deliveryVersion) => json(id, "/gateway", { actionIds, deliveryVersion }),
    revokeGateway: (id) => json(id, "/gateway", {}, "DELETE"),
    materials: (id) => json(id, "/attachments"),
    connections: (id) => json(id, "/connections"),
    saveConnection: (id, connection) => json(id, "/connections", connection),
    testConnection: (id, connectionId, profile) => json(id, `/connections/${part(connectionId)}/test`, { profile }),
    discoverConnection: (id, connectionId, specification, profile) => json(id, `/connections/${part(connectionId)}/discover`, { profile, ...(specification ? { document: specification } : {}) }),
    authorizeConnection: (id, connectionId, profile) => json(id, `/connections/${part(connectionId)}/authorize`, { profile }),
    connectionAuthorization: (id, connectionId, profile) => json(id, `/connections/${part(connectionId)}/authorization${profile ? `?profile=${part(profile)}` : ""}`),
    cancelConnectionAuthorization: (id, connectionId, profile) => json(id, `/connections/${part(connectionId)}/cancel-authorization`, { profile }),
    connectionResult: (id, resultRef, offset = 0) => json(id, `/connections/results/${part(resultRef)}?offset=${offset}`),
    removeConnection: (id, connectionId, expectedVersion, profile) => json(id, `/connections/${part(connectionId)}/remove`, { expectedVersion, profile }),
  };
}
