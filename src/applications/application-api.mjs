import { InputError } from "../requirements/core.mjs";

export async function routeApplication({ request, response, address, agents, readBody, sendJson, signal }) {
  const match = address.pathname.match(/^\/api\/agents\/([\w-]+)\/(connections|application|tasks)(?:\/(.*))?$/);
  if (!match) return false;
  const [, id, family, suffix = ""] = match, method = request.method;
  await agents.requireAgent(id);
  const send = (value) => { if (!signal?.aborted) sendJson(response, 200, value); return true; };
  if (family === "connections") {
    const requirements = await agents.connectionRequirements(id), store = agents.connections;
    if (!suffix && method === "GET") return send(await store.list(id, requirements));
    if (!suffix && ["POST", "PUT"].includes(method)) return send(await store.save(id, await readBody(), requirements));
    const operation = suffix.match(/^([A-Za-z][\w-]{0,79})(?:\/(test|remove))?$/);
    if (operation) {
      const [, connectionId, action] = operation;
      if (method === "POST" && action === "test") { await readBody(); return send(await store.test(id, connectionId, { requirements, signal })); }
      if (method === "DELETE" || method === "POST" && action === "remove") return send(await store.remove(id, connectionId, await readBody()));
    }
  }
  const application = agents.applications;
  if (family === "application") {
    if (!suffix && method === "GET") return send(await application.summary(id));
    if (suffix === "open" && method === "POST") {
      await readBody();
      const host = request.headers.host;
      const instance = await application.open(id, `http://${host}`, signal);
      if (signal?.aborted) { await application.resources.close(id, instance.instanceId); return true; }
      return send(instance);
    }
    if (suffix === "close" && method === "POST") return send(await application.resources.close(id, (await readBody()).instanceId));
    if (suffix === "state" && method === "GET") return send(await application.state(id, address.searchParams.get("deliveryVersion") ?? undefined));
    if (suffix === "state" && ["PUT", "POST"].includes(method)) return send(await application.saveState(id, await readBody()));
  }
  if (family === "tasks") {
    if (!suffix && method === "POST") {
      const body = await readBody();
      if (Object.keys(body).some((key) => !["actionId", "input", "mutationId", "deliveryVersion"].includes(key))) throw new InputError("应用任务不能指定其他身份或任务范围");
      return send(await application.submit(id, body));
    }
    if (!suffix && method === "GET") return send({ tasks: await application.store.list(id, { scope: "private" }) });
    const operation = suffix.match(/^([\w-]{1,80})(?:\/(events|cancel))?$/);
    if (operation) {
      const [, taskId, action] = operation;
      const task = await application.store.get(id, taskId);
      if (task.source.scope !== "private") throw new InputError("群操作任务请在对应群任务中查看");
      if (!action && method === "GET") return send({ task });
      if (action === "cancel" && method === "POST") { await readBody(); return send(await application.cancel(id, taskId)); }
      if (action === "events" && method === "GET") {
        const value = await application.store.events(id, taskId, Number(address.searchParams.get("after") ?? 0));
        if (request.headers.accept?.includes("application/x-ndjson")) {
          response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
          for (const event of value.events) response.write(`${JSON.stringify(event)}\n`);
          response.end(`${JSON.stringify({ type: "done", result: { lastSequence: value.lastSequence, latestSequence: value.latestSequence } })}\n`);
          return true;
        }
        return send(value);
      }
    }
  }
  sendJson(response, 404, { error: "应用接口不存在" }); return true;
}
