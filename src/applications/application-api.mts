import type { HttpRouteContext } from "../runtime/http-port.mjs";
import type { PrototypeAgents } from "../agents/agent-prototype.mjs";
import { InputError } from "../requirements/core.mjs";

export async function routeApplication({ request, response, address, agents, readBody, sendJson, signal }: HttpRouteContext & { agents: PrototypeAgents }) {
  const match = address.pathname.match(/^\/api\/agents\/([\w-]+)\/(connections|application|tasks)(?:\/(.*))?$/);
  if (!match) return false;
  const [, id, family, suffix = ""] = match as [string, string, string, string?], method = request.method;
  await agents.requireAgent(id);
  const send = (value: unknown) => { if (!signal?.aborted) sendJson(response, 200, value); return true; };
  if (family === "connections") {
    const store = agents.connections;
    const sets = agents.connectionRequirementSets ? await agents.connectionRequirementSets(id)
      : { active: { profile: await store.getActiveProfile?.(id) ?? "legacy", requirements: await agents.connectionRequirements(id) }, candidate: null };
    const selected = (profile: unknown) => {
      const section = profile === undefined || profile === sets.active.profile ? sets.active : sets.candidate?.profile === profile ? sets.candidate : null;
      if (!section) throw new InputError("这个连接方案尚未通过评审或已失效，请刷新后重试");
      return section;
    };
    if (!suffix && method === "GET") {
      const active = await store.list(id, sets.active.requirements, { profile: sets.active.profile });
      const candidate = sets.candidate ? await store.list(id, sets.candidate.requirements, { profile: sets.candidate.profile }) : null;
      return send({ ...active, active, candidate });
    }
    if (!suffix && ["POST", "PUT"].includes(method ?? "")) {
      const body = await readBody(), section = selected(body.profile);
      return send(await store.save(id, body, section.requirements, { profile: section.profile, expectedActiveProfile: sets.active.profile }));
    }
    const result = suffix.match(/^results\/([a-f0-9-]{36})$/);
    if (result && method === "GET") return send(await store.readResult(id, result[1]!, { offset: Number(address.searchParams.get("offset") ?? 0), length: Number(address.searchParams.get("length") ?? 32000) }));
    const operation = suffix.match(/^([A-Za-z][\w-]{0,79})(?:\/(test|remove|discover|authorize|authorization|cancel-authorization))?$/);
    if (operation) {
      const [, connectionId, action] = operation as [string, string, string?];
      const body = method === "GET" ? {} : await readBody();
      const section = selected(body.profile ?? address.searchParams.get("profile") ?? undefined), options = { requirements: section.requirements, profile: section.profile, signal };
      if (method === "POST" && action === "test") return send(await store.test(id, connectionId, options));
      if (method === "POST" && action === "discover") return send(await store.discover(id, connectionId, { ...body, ...options }));
      if (method === "POST" && action === "authorize") return send(await store.authorize(id, connectionId, options));
      if (method === "GET" && action === "authorization") return send(store.authorizationStatus(id, connectionId, options));
      if (method === "POST" && action === "cancel-authorization") return send(await store.cancelAuthorization(id, connectionId, options));
      if (method === "DELETE" || method === "POST" && action === "remove") return send(await store.remove(id, connectionId, { ...body, profile: section.profile, expectedActiveProfile: sets.active.profile }));
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
    if (suffix === "close" && method === "POST") return send(await application.resources.close(id, (await readBody()).instanceId as string));
    if (suffix === "state" && method === "GET") return send(await application.state(id, address.searchParams.get("deliveryVersion") ?? undefined));
    if (suffix === "state" && ["PUT", "POST"].includes(method ?? "")) return send(await application.saveState(id, await readBody()));
  }
  if (family === "tasks") {
    if (!suffix && method === "POST") {
      const body = await readBody();
      if (Object.keys(body).some((key) => !["actionId", "input", "mutationId", "deliveryVersion", "applicationContext"].includes(key))) throw new InputError("应用任务不能指定其他身份或任务范围");
      return send(await application.submit(id, body));
    }
    if (!suffix && method === "GET") return send({ tasks: await application.store.list(id, { scope: "private" }) });
    const artifact = suffix.match(/^([\w-]{1,80})\/artifacts\/(0|[1-9][0-9]{0,8})$/);
    if (artifact && method === "GET") {
      const [, taskId, index] = artifact as [string, string, string], task = await application.store.get(id, taskId);
      if (task.source.scope !== "private") throw new InputError("群操作产物请在对应群任务中查看");
      const offset = address.searchParams.get("offset"), limit = address.searchParams.get("limit");
      if (address.searchParams.get("preview") === "1") {
        if (offset !== null || limit !== null || address.searchParams.get("download") === "1") throw new InputError("产物预览不能同时指定下载或分页");
        return send(await agents.previewTaskArtifact(id, taskId, Number(index), { signal }));
      }
      if ([offset, limit].some((value) => value !== null && !/^(?:0|[1-9][0-9]*)$/.test(value))) throw new InputError("产物读取位置或分页大小无效");
      const options = { ...(offset === null ? {} : { offset: Number(offset) }), ...(limit === null ? {} : { limit: Number(limit) }), signal };
      const page = await agents.readTaskArtifact(id, taskId, Number(index), options);
      if (address.searchParams.get("download") !== "1") return send(page);
      if (options.offset !== undefined && options.offset !== 0) throw new InputError("下载完整产物不能指定续读位置");
      signal?.throwIfAborted();
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": page.size,
        "content-disposition": `attachment; filename="artifact"; filename*=UTF-8''${encodeURIComponent(page.name).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`,
        "cache-control": "no-store", "x-content-type-options": "nosniff" });
      let current = page;
      for (;;) {
        signal?.throwIfAborted(); response.write(Buffer.from(current.data, "base64"));
        if (current.nextOffset === null) break;
        current = await agents.readTaskArtifact(id, taskId, Number(index), { ...options, offset: current.nextOffset });
      }
      response.end(); return true;
    }
    const operation = suffix.match(/^([\w-]{1,80})(?:\/(events|cancel|resume))?$/);
    if (operation) {
      const [, taskId, action] = operation as [string, string, string?];
      const task = await application.store.get(id, taskId);
      if (task.source.scope !== "private") throw new InputError("群操作任务请在对应群任务中查看");
      if (!action && method === "GET") return send({ task });
      if (action === "cancel" && method === "POST") { await readBody(); return send(await application.cancel(id, taskId)); }
      if (action === "resume" && method === "POST") {
        const body = await readBody();
        if (Object.keys(body).some((key) => !["input", "resolution", "expectedVersion", "mutationId"].includes(key))) throw new InputError("继续任务参数无效");
        return send(await application.resume(id, taskId, body));
      }
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
