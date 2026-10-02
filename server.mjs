import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InputError, ProviderError, processTurn } from "./core.mjs";
import { getProviderConfig, makeProviders } from "./providers.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/state.js", ["state.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  if (!request.headers["content-type"]?.startsWith("application/json")) {
    throw new InputError("请求必须使用 JSON 格式");
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 128_000) throw new InputError("请求内容过长");
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

export function createRequestHandler({ config = getProviderConfig(), providers = makeProviders(config) } = {}) {
  return async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    try {
      if (request.method === "GET" && path === "/api/health") {
        return sendJson(response, 200, {
          ok: true,
          llmConfigured: config.llmConfigured,
          jevConfigured: config.jevConfigured,
          jevModel: config.jevModel,
          experimental: true,
        });
      }
      if (request.method === "POST" && path === "/api/requirements/turn") {
        const body = await readJson(request);
        const result = await processTurn(body, providers);
        return sendJson(response, 200, { ...result,
          diagnostic: { ...result.diagnostic, providerModel: config.model || null } });
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
      const status = error instanceof InputError ? 400
        : error instanceof ProviderError ? 502 : 500;
      const message = error instanceof InputError || error instanceof ProviderError
        ? error.message : "服务暂时无法处理，请重试";
      const diagnostic = error instanceof ProviderError ? error.diagnostic
        : error instanceof InputError ? { stage: "input", reason: "invalid_request" }
          : { stage: "server", reason: "internal_error" };
      return sendJson(response, status, { error: message,
        diagnostic: { ...diagnostic, providerModel: config.model || null } });
    }
  };
}

export function createApp(options = {}) {
  return createServer(createRequestHandler(options));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const config = getProviderConfig();
  const server = createApp({ config });
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`NEUMA 需求层测试版：http://127.0.0.1:${port}\n`);
    process.stdout.write(`兼容模型：${config.llmConfigured ? "已配置" : "未配置"}；Jev：${config.jevConfigured ? "已配置" : "未配置"}\n`);
  });
}
