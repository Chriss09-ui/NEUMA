import { InputError } from "../requirements/core.mjs";
import { serviceErrorMessage } from "./service-errors.mjs";

export async function serviceSummary(agents, id) {
  const descriptor = await agents.applications.descriptor(id, { optional: true, allowBuilding: true });
  const managed = await agents.services.list({ agentId: id });
  const deliveryVersion = descriptor?.deliveryVersion ?? null;
  const workflows = [];
  for (const task of await agents.applications.store.list(id, { scope: "private" })) {
    if (!task.workflowId) continue;
    let waiting = task.waiting;
    try {
      const record = await agents.applications.workflows.get(task.workflowId);
      if (descriptor?.manifest.service) waiting = agents.applications.workflowWaiting(record, descriptor.manifest);
      if (record.status === "needs_review") task.status = "needs_review";
    } catch { /* A failed first checkpoint remains an interrupted task. */ }
    workflows.push({ ...task, version: task.sequence, waiting });
  }
  const history = (await agents.deliveryHistory(id)).map(({ deliveryVersion: version, language, host }) =>
    ({ deliveryVersion: version, active: version === deliveryVersion, language, host }));
  return { environment: managed.environments, deliveryVersion, actions: descriptor?.manifest.actions ?? [],
    service: descriptor?.manifest.service ? { ...descriptor.manifest.service,
      operations: descriptor.manifest.actions, status: managed.services.some((worker) => worker.deliveryVersion === deliveryVersion) ? "ready" : "stopped" } : null,
    workers: managed.services.filter((worker) => worker.deliveryVersion === deliveryVersion), history,
    gateway: await agents.gateway.config(id), workflowTasks: workflows };
}

async function routeServicesInner({ request, response, address, agents, readBody, sendJson, signal }) {
  const match = address.pathname.match(/^\/api\/agents\/([\w-]+)\/(services|gateway)(?:\/(\w+))?$/);
  if (!match) return false;
  const [, id, family, action = ""] = match;
  if (!await agents.get(id) && !await agents.storage.readJson(id, "requirements.json")) throw new InputError("没有找到这个智能体");
  const send = (value) => { sendJson(response, 200, value); return true; };
  if (family === "gateway") {
    if (!action && request.method === "GET") return send(await agents.gateway.config(id));
    if (!action && request.method === "POST") return send(await agents.gateway.configure(id, await readBody()));
    if (!action && request.method === "DELETE" || action === "revoke" && request.method === "POST") {
      await readBody(); return send(await agents.gateway.revoke(id));
    }
  } else {
    if (!action && request.method === "GET") return send(await serviceSummary(agents, id));
    if (action === "logs" && request.method === "GET") {
      const descriptor = await agents.applications.descriptor(id, { allowBuilding: true });
      if (address.searchParams.get("deliveryVersion") !== descriptor.deliveryVersion) throw new InputError("交付版本已变化，请刷新后读取记录");
      return send(agents.services.logs({ agentId: id, deliveryVersion: descriptor.deliveryVersion, scopeId: "private" }));
    }
    if (request.method === "POST") {
      const body = await readBody();
      if (action === "prepare") {
        if (Object.keys(body).some((key) => !["language", "host"].includes(key)) || !["javascript", "python"].includes(body.language)
          || !["managed", "docker"].includes(body.host)) throw new InputError("环境准备选项无效");
        return send(await agents.services.prepareEnvironment({ ...body, signal }));
      }
      if (Object.keys(body).some((key) => key !== "deliveryVersion")) throw new InputError("运行操作参数无效");
      if (action === "rollback") return send(await agents.rollbackDelivery(id, body.deliveryVersion, { signal }));
      if (["start", "stop", "restart"].includes(action)) return send(await agents.changeService(id, async (activeSignal) => {
        const descriptor = await agents.applications.descriptor(id, { allowBuilding: true });
        if (body.deliveryVersion !== descriptor.deliveryVersion || descriptor.manifest.runtime !== "managed-service") throw new InputError("需要当前有效的服务交付版本");
        const identity = { agentId: id, deliveryVersion: descriptor.deliveryVersion, scopeId: "private", signal: activeSignal };
        if (action !== "start") await agents.services.stop({ agentId: id, deliveryVersion: descriptor.deliveryVersion });
        if (action !== "stop") await agents.services.activate(identity);
        return { deliveryVersion: descriptor.deliveryVersion, status: action === "stop" ? "stopped" : "ready" };
      }, { signal }));
    }
  }
  sendJson(response, 404, { error: "运行接口不存在" }); return true;
}

export async function routeServices(options) {
  try { return await routeServicesInner(options); }
  catch (error) {
    if (!(error instanceof InputError) && typeof error.reason === "string" && /^[a-z_]{1,80}$/.test(error.reason))
      throw Object.assign(new InputError(serviceErrorMessage(error.reason)), { reason: error.reason });
    throw error;
  }
}
