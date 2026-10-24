import type { ServerMainPort, ServerCollaborationPort } from "../server-port.mjs";
import type { HttpRouteContext, SendMaterial, PublicFailure } from "../runtime/http-port.mjs";
import type { CollaborationService } from "./groups.mjs";
import type { MainAgent } from "../main/main-agent.mjs";
import type { ProviderConfig } from "../requirements/requirement-provider-port.mjs";
import { InputError } from "../requirements/core.mjs";
import { MAX_MATERIAL_BYTES } from "../materials/material-formats.mjs";

export async function routeCollaboration({ request, response, address, getCollaboration, getMainAgent, readBody, sendJson, sendMaterialFile, safeFailure, config, signal }: HttpRouteContext & { getCollaboration(): ServerCollaborationPort; getMainAgent(): ServerMainPort; sendMaterialFile: SendMaterial; safeFailure: PublicFailure; config: Partial<ProviderConfig> }) {
  const path = address.pathname, method = request.method;
  if (!(path === "/api/activity" || path.startsWith("/api/groups") || path.startsWith("/api/main/") || path === "/api/collaboration/agents")) return false;
  const groups = getCollaboration(); await groups.ready;
  const send = (value: unknown) => { if (!signal.aborted) sendJson(response, 200, value); return true; };
  if (method === "GET" && path === "/api/activity") return send(await groups.activity!());
  if (method === "GET" && path === "/api/collaboration/agents") return send({ agents: await groups.cards!() });
  if (path === "/api/groups") {
    if (method === "GET") return send(await groups.listGroups!());
    if (method === "POST") return send(await groups.createGroup!(await readBody()));
  }
  const groupConversation = path.match(/^\/api\/groups\/([\w-]+)\/conversations\/([\w-]+)\/remove$/);
  if (method === "POST" && groupConversation)
    return send(await groups.removeConversation!(groupConversation[1]!, groupConversation[2]!, await readBody()));
  const group = path.match(/^\/api\/groups\/([\w-]+)(?:\/(messages|events|share|materials))?$/);
  if (group) {
    const [, groupId, action] = group as [string, string, string?];
    if (method === "GET" && !action) return send(await groups.getGroup!(groupId));
    if (method === "POST" && !action) return send(await groups.updateGroup!(groupId, await readBody()));
    if (method === "POST" && action === "messages") return send(await groups.postMessage!(groupId, await readBody()));
    if (method === "POST" && action === "share") return send(await groups.share!(groupId, await readBody(), { signal }));
    if (method === "GET" && action === "events") {
      const raw = address.searchParams.get("after") ?? "0";
      if (!/^\d+$/.test(raw)) throw new InputError("消息续读位置无效");
      const value = await groups.events!(groupId, Number(raw));
      if (request.headers.accept?.includes("application/x-ndjson")) {
        response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
        for (const event of value.events) response.write!(`${JSON.stringify(event)}\n`);
        response.end(`${JSON.stringify({ type: "done", result: { lastSequence: value.lastSequence, latestSequence: value.latestSequence } })}\n`); return true;
      }
      return send(value);
    }
    if (method === "GET" && action === "materials") return send({ materials: (await groups.getGroup!(groupId)).materials });
    if (method === "POST" && action === "materials") {
      const length = request.headers["content-length"];
      if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > MAX_MATERIAL_BYTES)) throw new InputError("单个材料不能超过 20 MiB");
      let name = address.searchParams.get("name");
      if (!name && request.headers["x-file-name"]) { try { name = decodeURIComponent(String(request.headers["x-file-name"])); } catch { throw new InputError("文件名无效"); } }
      return send(await groups.uploadMaterial!(groupId, { name, mimeType: request.headers["content-type"], source: request, signal }));
    }
  }
  const material = path.match(/^\/api\/groups\/([\w-]+)\/materials\/([\w-]+)\/(raw|preview|image)$/);
  if (method === "GET" && material) {
    const [, groupId, materialId, action] = material as [string, string, string, string];
    await groups.requireMaterial!(groupId, materialId);
    if (action === "raw") { await sendMaterialFile(response, await groups.materials!.raw!(groupId, materialId), address.searchParams.get("download") === "1", signal); return true; }
    const offset = Number(address.searchParams.get("offset") ?? 0);
    if (action === "preview") return send(await groups.materials!.preview!(groupId, materialId, { offset, signal }));
    const image = await groups.materials!.image!(groupId, materialId, { page: Number(address.searchParams.get("page") ?? 1), signal });
    signal.throwIfAborted(); response.writeHead(200, { "content-type": image.mimeType, "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(Buffer.from(image.data, "base64")); return true;
  }
  const artifact = path.match(/^\/api\/groups\/([\w-]+)\/artifacts\/([\w-]+)$/);
  if (method === "GET" && artifact) return send(await groups.artifact!(artifact[1]!, artifact[2]!));
  const task = path.match(/^\/api\/groups\/([\w-]+)\/tasks\/([\w-]+)(?:\/(cancel))?$/);
  if (task) {
    if (method === "POST" && task[3] === "cancel") { await readBody(); return send(await groups.cancelTask!(task[1]!, task[2]!)); }
    if (method === "GET" && !task[3]) {
      const view = await groups.getGroup!(task[1]!), value = view.tasks.find((value) => value.id === task[2]!);
      if (!value) throw new InputError("任务不存在"); return send({ task: value });
    }
  }
  if (path.startsWith("/api/main/")) {
    const main = getMainAgent(); await main.ready;
    const mainMaterial = path.match(/^\/api\/main\/conversations\/([\w-]+)\/materials(?:\/([\w-]+)\/(raw|preview))?$/);
    if (mainMaterial) {
      const [, conversationId, materialId, action] = mainMaterial as [string, string, string?, string?];
      await main.getConversation!(conversationId);
      if (method === "GET" && !materialId) return send(await main.materials!.list!(conversationId));
      if (method === "POST" && !materialId) {
        const length = request.headers["content-length"];
        if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > MAX_MATERIAL_BYTES)) throw new InputError("单个材料不能超过 20 MiB");
        let name;
        try { name = decodeURIComponent(String(request.headers["x-file-name"] ?? "")); } catch { throw new InputError("文件名无效"); }
        return send(await main.materials!.upload!(conversationId, { name, mimeType: request.headers["content-type"], source: request, signal }));
      }
      if (method === "GET" && action === "raw") {
        await sendMaterialFile(response, await main.materials!.materials!.raw!(conversationId, materialId!), address.searchParams.get("download") === "1", signal); return true;
      }
      if (method === "GET" && action === "preview") return send(await main.materials!.materials!.preview!(conversationId, materialId!, { signal }));
    }
    if (path === "/api/main/conversations") {
      if (method === "GET") return send(await main.listConversations!());
      if (method === "POST") return send(await main.createConversation!(await readBody()));
    }
    const conversation = path.match(/^\/api\/main\/conversations\/([\w-]+)(?:\/(messages|cancel|requirements|remove))?$/);
    if (conversation) {
      const [, conversationId, action] = conversation as [string, string, string?];
      if (method === "GET" && !action) return send(await main.getConversation!(conversationId));
      if (method === "POST" && action === "remove") return send(await main.removeConversation!(conversationId, await readBody()));
      if (method === "POST" && action === "cancel") { await readBody(); return send(await main.cancel!(conversationId)); }
      if (method === "POST" && action === "requirements") {
        return send(await main.activateRequirements!({ ...await readBody(), conversationId }));
      }
      if (method === "POST" && action === "messages") {
        const input = { ...await readBody(), conversationId };
        if (!request.headers.accept?.includes("application/x-ndjson")) return send(await main.prompt!(input, undefined, { signal }));
        response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.flushHeaders?.();
        const write = (value: unknown) => { if (!signal.aborted && !response.destroyed && !response.writableEnded) response.write!(`${JSON.stringify(value)}\n`); };
        try { write({ type: "done", result: await main.prompt!(input, write, { signal }) }); }
        catch (error) { write({ type: "error", ...safeFailure(error, config).payload }); }
        finally { if (!response.writableEnded) response.end(); }
        return true;
      }
    }
  }
  sendJson(response, 404, { error: "页面不存在" }); return true;
}
