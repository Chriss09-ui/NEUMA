import { createServer } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InputError, ProviderError, processTurn } from "./core.mjs";
import { getProviderConfig, makeProviders } from "./providers.mjs";
import { ProjectManager } from "./projects.mjs";
import { createProjectFolderPicker } from "./project-folder-picker.mjs";
import { PiProjectAgent, createProjectAnalyzer } from "./pi-runtime.mjs";
import { PrototypeAgents } from "./agent-prototype.mjs";
import { configEnv, settingsUpdates, settingsView, writeEnvFile } from "./settings.mjs";
import { APP_VERSION } from "./app-metadata.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/agents.js", ["agents.js", "text/javascript; charset=utf-8"]],
  ["/agent-runtime.js", ["agent-runtime.js", "text/javascript; charset=utf-8"]],
  ["/agent-details.js", ["agent-details.js", "text/javascript; charset=utf-8"]],
  ["/agent-details-view.js", ["agent-details-view.js", "text/javascript; charset=utf-8"]],
  ["/state.js", ["state.js", "text/javascript; charset=utf-8"]],
  ["/shell.js", ["shell.js", "text/javascript; charset=utf-8"]],
  ["/settings.js", ["settings.js", "text/javascript; charset=utf-8"]],
  ["/projects.js", ["projects.js", "text/javascript; charset=utf-8"]],
  ["/project-view.js", ["project-view.js", "text/javascript; charset=utf-8"]],
  ["/runtime.js", ["runtime.js", "text/javascript; charset=utf-8"]],
  ["/runtime-view.js", ["runtime-view.js", "text/javascript; charset=utf-8"]],
  ["/chat-ui.js", ["chat-ui.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function safeFailure(error, config) {
  const status = error instanceof InputError ? 400 : error instanceof ProviderError ? 502 : 500;
  const message = error instanceof InputError || error instanceof ProviderError ? error.message : "服务暂时无法处理，请重试";
  const diagnostic = error instanceof ProviderError || (error instanceof InputError && error.code === "PROJECT_ADD_FAILED" && error.diagnostic) ? error.diagnostic : error instanceof InputError
    ? { stage: "input", reason: "invalid_request" } : { stage: "server", reason: "internal_error" };
  return { status, payload: { error: message, diagnostic: { ...diagnostic, providerModel: config.model || null },
    ...(error instanceof InputError && error.code === "PROJECT_REMOVE_STOP_FAILED" ? { code: error.code } : {}) } };
}

async function streamProjectReply(response, agent, body, config, signal) {
  response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.flushHeaders?.();
  const write = (event) => {
    if (!signal?.aborted && !response.destroyed && !response.writableEnded) response.write(`${JSON.stringify(event)}\n`);
  };
  const disconnected = () => {
    if (!response.writableEnded) void agent.cancel(body.sessionId).catch(() => {});
  };
  response.on("close", disconnected);
  try {
    if (response.destroyed) return;
    signal?.throwIfAborted();
    const result = await agent.prompt(body, write, { signal });
    write({ type: "done", result });
  } catch (error) {
    write({ type: "error", ...safeFailure(error, config).payload });
  } finally {
    response.removeListener("close", disconnected);
    response.end();
  }
}

async function streamProjectSetup(response, action, config, externalSignal) {
  const controller = new AbortController();
  const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
  const disconnected = () => { if (!response.writableEnded) controller.abort(); };
  response.on("close", disconnected);
  response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
  response.flushHeaders?.();
  const write = (event) => {
    if (!controller.signal.aborted && !response.destroyed && !response.writableEnded) response.write(`${JSON.stringify(event)}\n`);
  };
  try {
    if (response.destroyed) return;
    signal.throwIfAborted();
    write({ type: "status", label: "正在添加并检查项目…" });
    const project = await action({ signal, onProgress: write });
    write({ type: "done", result: { project } });
  } catch (error) { write({ type: "error", ...safeFailure(error, config).payload }); }
  finally { response.removeListener("close", disconnected); response.end(); }
}

function requirementReply(result) {
  if (result.confirmed) return `需求已确认：\n${result.summary}\n\n已加入左侧“我的智能体”，正在设计与检查方案。通过检查并生成执行定义后即可使用；缺少能力时会说明下一步。`;
  if (result.status === "ready") return `我整理出的需求是：\n${result.summary}\n\n${result.confirmationQuestion}`;
  return `${result.summary}\n\n${result.question}`;
}

async function buildAgentReply(request, response, agents, body, config, forceStreaming = false, externalSignal) {
  const controller = new AbortController();
  const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
  const streaming = forceStreaming || request.headers.accept?.includes("application/x-ndjson");
  const disconnected = () => { if (!response.writableEnded) controller.abort(); };
  response.on?.("close", disconnected);
  const write = (event) => {
    if (!signal.aborted && !response.destroyed && !response.writableEnded) response.write(`${JSON.stringify(event)}\n`);
  };
  try {
    signal.throwIfAborted();
    if (streaming) {
      response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
      response.flushHeaders?.();
    }
    const result = await agents.build(body, { signal, onProgress: streaming ? write : () => {} });
    if (!signal.aborted && !response.destroyed) {
      if (streaming) write({ type: "done", result });
      else sendJson(response, 200, result);
    }
  } catch (error) {
    if (!signal.aborted && !response.destroyed) {
      const failure = safeFailure(error, config);
      if (streaming) write({ type: "error", ...failure.payload });
      else sendJson(response, failure.status, failure.payload);
    }
  } finally {
    response.removeListener?.("close", disconnected);
    if (streaming) response.end();
  }
}

async function streamRequirementReply(response, providers, body, config, externalSignal) {
  const controller = new AbortController();
  const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
  const disconnected = () => {
    if (!response.writableEnded) controller.abort();
  };
  response.on("close", disconnected);
  response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.flushHeaders?.();
  const write = (event) => {
    if (!response.destroyed && !response.writableEnded && !signal.aborted) response.write(`${JSON.stringify(event)}\n`);
  };
  let reply = "";
  const append = (delta) => {
    signal.throwIfAborted();
    if (typeof delta !== "string" || !delta) return;
    if (!reply && !delta.trim()) return;
    if (!reply) write({ type: "text-start" });
    reply += delta;
    write({ type: "text-delta", delta });
  };
  try {
    if (response.destroyed) return;
    write({ type: "status", phase: "thinking", label: "正在整理需求…" });
    const result = await processTurn(body, providers, { signal, onProgress: write });
    signal.throwIfAborted();
    let replyDiagnostic = { mode: "direct" };
    // Confirmation text stays exact; ordinary replies may rephrase only the checked summary.
    if (result.status === "needs_input" && result.diagnostic.model.used !== false
        && typeof providers.streamReply === "function") {
      write({ type: "status", phase: "writing", label: "正在组织回复…" });
      try {
        await providers.streamReply({ summary: result.summary, signal, onDelta: append });
        signal.throwIfAborted();
        if (!reply.trim()) throw new ProviderError("模型未返回回复文字", { stage: "llm", reason: "missing_content" });
        append(`\n\n${result.question}`);
        replyDiagnostic = { mode: "stream" };
      } catch (error) {
        signal.throwIfAborted();
        // Before any visible text, the validated response is a safe fallback. Never replay a partial reply.
        if (reply) throw error;
        append(requirementReply(result));
        replyDiagnostic = { mode: "fallback", failure: safeFailure(error, config).payload.diagnostic };
      }
    } else {
      append(requirementReply(result));
    }
    write({ type: "done", result: { ...result, reply,
      diagnostic: { ...result.diagnostic, reply: replyDiagnostic, providerModel: config.model || null } } });
  } catch (error) {
    if (!signal.aborted) write({ type: "error", ...safeFailure(error, config).payload });
  } finally {
    response.removeListener("close", disconnected);
    response.end();
  }
}

async function readJson(request, maxBytes = 128_000) {
  if (!request.headers["content-type"]?.startsWith("application/json")) {
    throw new InputError("请求必须使用 JSON 格式");
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new InputError("请求内容过长");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new InputError("请求 JSON 无效");
  }
}

export function createRequestHandler({ config = getProviderConfig(), providers: injectedProviders,
  dataDir = resolve(ROOT, ".neuma"), envPath = resolve(ROOT, ".env"),
  port = Number(process.env.PORT || 3000), instanceId = null,
  pickProjectFolder = createProjectFolderPicker(),
  projects = new ProjectManager({ dataDir, blockedPort: port,
    analyzeProject: createProjectAnalyzer({ config, dataDir }) }),
  projectAgent = new PiProjectAgent({ config, manager: projects, cwd: ROOT, dataDir }),
  prototypeAgents = new PrototypeAgents({ config, cwd: ROOT, dataDir }) } = {}) {
  let providers = injectedProviders ?? makeProviders(config);
  let settingsQueue = Promise.resolve();
  let state = "starting";
  const activeRequests = new Map();
  const beginRequest = () => {
    const controller = new AbortController();
    let settled;
    activeRequests.set(controller, new Promise((done) => { settled = done; }));
    return { controller, release: () => { activeRequests.delete(controller); settled(); } };
  };
  const saveSettings = (updates) => {
    const result = settingsQueue.then(async () => {
      try { await writeEnvFile(envPath, updates); }
      catch { throw new InputError("无法写入本机 .env 文件，请检查文件权限"); }
      Object.assign(config, getProviderConfig({ ...configEnv(config), ...updates }));
      if (!injectedProviders) providers = makeProviders(config);
      // Keep the file, active config and session reset in the same save order.
      await projectAgent.dispose?.();
      await prototypeAgents.close();
      return settingsView(config);
    });
    settingsQueue = result.catch(() => {});
    return result;
  };
  const handler = async (request, response) => {
    if (["stopping", "stopped"].includes(state)) return sendJson(response, 503, { ok: false, state, version: APP_VERSION, instanceId });
    const { controller: requestController, release: releaseRequest } = beginRequest();
    const stopRequest = () => { request.destroy?.(); response.destroy?.(); };
    const requestDisconnected = () => { if (!response.writableEnded) requestController.abort(); };
    requestController.signal.addEventListener("abort", stopRequest, { once: true });
    response.on?.("close", requestDisconnected);
    try {
      let address;
      try { address = new URL(request.url ?? "/", "http://localhost"); }
      catch { throw new InputError("请求地址无效"); }
      const path = address.pathname;
      if (path.startsWith("/api/")) {
        const host = request.headers.host;
        const origin = request.headers.origin;
        const validHost = !host || ["localhost", "127.0.0.1", "[::1]"].includes(new URL(`http://${host}`).hostname);
        if (!validHost || (origin && origin !== `http://${host}`) || request.headers["sec-fetch-site"] === "cross-site") {
          return sendJson(response, 403, { error: "项目操作仅允许从本机 NUEMA 页面发起" });
        }
      }
      if (request.method === "GET" && path === "/api/health") {
        return sendJson(response, state === "ready" ? 200 : 503, {
          ok: state === "ready", version: APP_VERSION, state, instanceId,
          llmConfigured: config.llmConfigured,
          jevConfigured: config.jevConfigured,
          jevModel: config.jevModel,
          experimental: true,
          pi: { engine: "pi", configured: config.llmConfigured },
        });
      }
      await handler.ready;
      if (request.method === "GET" && path === "/api/settings") {
        return sendJson(response, 200, settingsView(config));
      }
      if (request.method === "POST" && path === "/api/settings") {
        const updates = settingsUpdates(await readJson(request));
        return sendJson(response, 200, await saveSettings(updates));
      }
      if (request.method === "GET" && path === "/api/agent-requirements") return sendJson(response, 200, await prototypeAgents.getRequirements());
      const agentRequirement = path.match(/^\/api\/agents\/([\w-]+)\/requirements$/);
      if (request.method === "POST" && agentRequirement)
        return sendJson(response, 200, await prototypeAgents.saveRequirements(agentRequirement[1], await readJson(request, 512_000)));
      const agentConversation = path.match(/^\/api\/agents\/([\w-]+)\/conversation$/);
      if (agentConversation && request.method === "GET")
        return sendJson(response, 200, await prototypeAgents.getConversation(agentConversation[1]));
      if (agentConversation && request.method === "POST")
        return sendJson(response, 200, await prototypeAgents.saveConversation(agentConversation[1], await readJson(request, 20_000_000)));
      if (request.method === "POST" && path === "/api/agents/build") {
        return await buildAgentReply(request, response, prototypeAgents, await readJson(request), config, false, requestController.signal);
      }
      if (request.method === "POST" && path === "/api/agents/turn") {
        const body = await readJson(request);
        if (request.headers.accept?.includes("application/x-ndjson")) return await streamProjectReply(response, prototypeAgents, body, config, requestController.signal);
        const result = await prototypeAgents.prompt(body, undefined, { signal: requestController.signal });
        if (!requestController.signal.aborted) return sendJson(response, 200, result);
        return;
      }
      if (request.method === "POST" && path === "/api/agents/cancel") {
        return sendJson(response, 200, await prototypeAgents.cancel((await readJson(request)).sessionId));
      }
      if (request.method === "GET" && path === "/api/agent-profiles") return sendJson(response, 200, await prototypeAgents.getProfiles());
      const developmentQuery = path.match(/^\/api\/agents\/([\w-]+)\/development(?:\/(stream|cancel))?$/);
      if (developmentQuery) {
        const [, id, action] = developmentQuery;
        if (request.method === "GET" && !action) return sendJson(response, 200, { development: await prototypeAgents.getDevelopment(id) });
        if (request.method === "POST") {
          const body = await readJson(request);
          if (Object.keys(body).some((key) => key !== "resume") || (body.resume !== undefined && typeof body.resume !== "boolean"))
            throw new InputError("研发请求只接受布尔类型的 resume 参数");
          if (action === "cancel") return sendJson(response, 200, await prototypeAgents.cancelDevelopment(id));
          return await buildAgentReply(request, response, { build: (_body, options) => prototypeAgents.develop(id, { resume: body.resume ?? false, ...options }) },
            body, config, action === "stream", requestController.signal);
        }
      }
      const agentQuery = path.match(/^\/api\/agents\/([\w-]+)$/);
      if (request.method === "GET" && agentQuery) return sendJson(response, 200, { agent: await prototypeAgents.get(agentQuery[1]),
        architecture: await prototypeAgents.getArchitecture?.(agentQuery[1]) ?? null,
        ...(prototypeAgents.getDevelopment ? { development: await prototypeAgents.getDevelopment(agentQuery[1]) } : {}) });
      const agentProfile = path.match(/^\/api\/agents\/([\w-]+)\/profile$/);
      if (request.method === "POST" && agentProfile) return sendJson(response, 200, await prototypeAgents.setProfile(agentProfile[1], await readJson(request)));
      const agentMemory = path.match(/^\/api\/agents\/([\w-]+)\/memory$/);
      if (request.method === "GET" && agentMemory) return sendJson(response, 200, await prototypeAgents.getMemory(agentMemory[1]));
      if (request.method === "POST" && agentMemory) return sendJson(response, 200, await prototypeAgents.setMemory(agentMemory[1], (await readJson(request)).memory));
      const agentFiles = path.match(/^\/api\/agents\/([\w-]+)\/files$/);
      if (request.method === "GET" && agentFiles) return sendJson(response, 200, await prototypeAgents.files(agentFiles[1]));
      const agentFile = path.match(/^\/api\/agents\/([\w-]+)\/file$/);
      if (request.method === "GET" && agentFile) return sendJson(response, 200, await prototypeAgents.file(agentFile[1], address.searchParams.get("path")));
      const agentRemoval = path.match(/^\/api\/agents\/([\w-]+)\/remove$/);
      if (request.method === "POST" && agentRemoval) {
        await readJson(request);
        return sendJson(response, 200, await prototypeAgents.remove(agentRemoval[1]));
      }
      if (request.method === "GET" && path === "/api/projects") {
        return sendJson(response, 200, { projects: await projects.list(), pendingAdditions: projects.pendingAdds?.size ?? 0 });
      }
      if (request.method === "GET" && path === "/api/projects/failures") {
        return sendJson(response, 200, { failures: await projects.failures({ limit: 10 }) });
      }
      if (request.method === "GET" && path === "/api/projects/runtime") {
        const { controller, release } = beginRequest();
        const disconnected = () => { if (!response.writableEnded) controller.abort(); };
        response.on("close", disconnected);
        try {
          if (response.destroyed) return;
          const snapshot = await projects.runtime({ signal: controller.signal });
          if (!controller.signal.aborted) sendJson(response, 200, snapshot);
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        } finally { response.removeListener("close", disconnected); release(); }
        return;
      }
      if (request.method === "POST" && path === "/api/projects/pick-folder") {
        await readJson(request);
        const { controller, release } = beginRequest();
        const disconnected = () => { if (!response.writableEnded) controller.abort(); };
        response.on("close", disconnected);
        try {
          if (response.destroyed) return;
          const result = await pickProjectFolder({ signal: controller.signal });
          if (!controller.signal.aborted) sendJson(response, 200, result);
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        } finally {
          response.removeListener("close", disconnected);
          release();
        }
        return;
      }
      if (request.method === "POST" && path === "/api/projects/turn") {
        const body = await readJson(request);
        if (request.headers.accept?.includes("application/x-ndjson")) return await streamProjectReply(response, projectAgent, body, config, requestController.signal);
        const result = await projectAgent.prompt(body, undefined, { signal: requestController.signal });
        if (!requestController.signal.aborted) return sendJson(response, 200, result);
        return;
      }
      if (request.method === "POST" && path === "/api/projects/cancel") {
        const body = await readJson(request);
        return sendJson(response, 200, await projectAgent.cancel(body.sessionId));
      }
      if (request.method === "POST" && path === "/api/projects") {
        const body = await readJson(request);
        if (request.headers.accept?.includes("application/x-ndjson")) return await streamProjectSetup(response, (options) => projects.add(body, options), config, requestController.signal);
        return sendJson(response, 200, { project: await projects.add(body, { signal: requestController.signal }) });
      }
      const operation = path.match(/^\/api\/projects\/([\w-]+)\/(configure|inspect|start|stop|remove)$/);
      if (request.method === "POST" && operation) {
        const body = await readJson(request), [, id, action] = operation;
        if (action === "remove" && body.confirm !== true) throw new InputError("请确认移除项目记录");
        if (action === "inspect" && request.headers.accept?.includes("application/x-ndjson")) return await streamProjectSetup(response, (options) => projects.inspect(id, options), config, requestController.signal);
        const project = action === "configure" ? await projects.configure(id, body)
          : action === "remove" ? await projects.remove(id, { removeOnly: body.removeOnly ?? false }) : await projects[action](id, action === "inspect" ? { signal: requestController.signal } : undefined);
        return sendJson(response, 200, { project });
      }
      if (request.method === "POST" && path === "/api/requirements/turn") {
        const body = await readJson(request);
        const { controller, release } = beginRequest();
        const disconnected = () => { if (!response.writableEnded) controller.abort(); };
        response.on?.("close", disconnected);
        try {
          if (request.headers.accept?.includes("application/x-ndjson"))
            return await streamRequirementReply(response, providers, body, config, controller.signal);
          const result = await processTurn(body, providers, { signal: controller.signal });
          if (!controller.signal.aborted) return sendJson(response, 200, { ...result,
            diagnostic: { ...result.diagnostic, providerModel: config.model || null } });
        } catch (error) { if (!controller.signal.aborted) throw error; }
        finally { response.removeListener?.("close", disconnected); release(); }
        return;
      }
      const asset = request.method === "GET" ? PUBLIC.get(path) : null;
      if (asset) {
        const [name, contentType] = asset;
        const content = await readFile(resolve(ROOT, "public", name));
        response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
        return response.end(content);
      }
      return sendJson(response, 404, { error: "页面不存在" });
    } catch (error) {
      if (requestController.signal.aborted || response.destroyed) return;
      const { status, payload } = safeFailure(error, config);
      return sendJson(response, status, payload);
    } finally {
      response.removeListener?.("close", requestDisconnected);
      requestController.signal.removeEventListener("abort", stopRequest);
      releaseRequest();
    }
  };
  const initialization = [prototypeAgents.ready, prototypeAgents.storage?.ready,
    prototypeAgents.architecture?.ready, prototypeAgents.development?.store?.ready];
  if (projects.load) initialization.push(projects.load());
  if (initialization.every((item) => item === undefined)) state = "ready";
  handler.ready = Promise.all(initialization).then(() => { if (state === "starting") state = "ready"; });
  handler.ready.catch(() => { if (state === "starting") state = "failed"; });
  let disposal;
  handler.dispose = () => {
    disposal ??= (async () => {
      state = "stopping";
      for (const controller of activeRequests.keys()) controller.abort();
      await handler.ready.catch(() => {});
      const failures = [];
      const cancelled = [() => prototypeAgents.close?.(), () => projectAgent.dispose?.(), () => projects.dispose?.()]
        .map((close) => { try { return close(); } catch (error) { return Promise.reject(error); } });
      for (const result of await Promise.allSettled(cancelled)) if (result.status === "rejected") failures.push(result.reason);
      for (const close of [() => settingsQueue, () => prototypeAgents.persistence,
        () => prototypeAgents.architecture?.persistence, () => prototypeAgents.development?.store?.persistence,
        () => Promise.allSettled([...activeRequests.values()])]) {
        try { await close(); } catch (error) { failures.push(error); }
      }
      state = "stopped";
      if (failures.length) throw new AggregateError(failures, "关闭 NEUMA 时未能完成全部清理");
    })();
    return disposal;
  };
  return handler;
}

export function createApp(options = {}) {
  const handler = createRequestHandler(options);
  const server = createServer(handler);
  server.on("close", () => { void handler.dispose().catch(() => {}); });
  server.ready = handler.ready;
  server.dispose = handler.dispose;
  return server;
}

if (process.argv[1] && await realpath(resolve(process.argv[1])).catch(() => null) === fileURLToPath(import.meta.url)) {
  const { runSourceApplication } = await import("./installation-runtime.mjs");
  await runSourceApplication({ root: ROOT, createHandler: createRequestHandler });
}
