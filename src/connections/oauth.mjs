import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { readResponse } from "./http-adapter.mjs";
import { discoverOAuthProtectedResourceMetadata, discoverAuthorizationServerMetadata, registerClient } from "@modelcontextprotocol/client";

const fail = (reason, message) => Object.assign(new Error(message), { reason });
export async function openOAuthBrowser(value, { platform = process.platform, run = execFile } = {}) {
  const url = oauthEndpoint(value);
  if (platform !== "darwin") throw fail("browser_open_unavailable", "请在系统浏览器中打开登录地址");
  await new Promise((resolve, reject) => run("/usr/bin/open", [url], { timeout: 10000, env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
    windowsHide: true }, (error) => error ? reject(fail("browser_open_failed", "系统浏览器未能打开，请手动打开登录地址")) : resolve()));
}
export function oauthEndpoint(value) {
  let url; try { url = new URL(value); } catch { throw fail("invalid_oauth", "授权服务地址无效"); }
  if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw fail("invalid_oauth", "授权地址必须使用 HTTPS 或本机回环地址");
  return url.href;
}
async function tokenRequest(config, values, { fetchImpl, signal }) {
  let response;
  try { response = await fetchImpl(oauthEndpoint(config.tokenUrl), { method: "POST", redirect: "manual", signal,
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ ...values, client_id: config.clientId, ...(config.resource ? { resource: config.resource } : {}), ...(config.clientSecret ? { client_secret: config.clientSecret } : {}) }) }); }
  catch { if (signal?.aborted) throw signal.reason; throw fail("oauth_network_failed", "授权服务暂时无法连接，请重试或重新登录"); }
  const result = await readResponse(response, { maxBytes: 128 * 1024, signal });
  if (!result || typeof result.access_token !== "string" || !result.access_token || /[\r\n\0]/.test(result.access_token)
    || result.token_type && result.token_type.toLowerCase() !== "bearer") throw fail("invalid_oauth_response", "授权服务未返回可用的访问令牌");
  return { accessToken: result.access_token, refreshToken: result.refresh_token,
    expiresAt: Number.isFinite(Number(result.expires_in)) ? Date.now() + Number(result.expires_in) * 1000 : null,
    scopes: typeof result.scope === "string" ? result.scope.split(/\s+/).filter(Boolean) : config.scopes ?? [] };
}
export async function oauthMetadata(config, { fetchImpl = fetch, signal, resourceUrl } = {}) {
  if (config.authorizationUrl && config.tokenUrl && config.clientId) return { ...config, authorizationUrl: oauthEndpoint(config.authorizationUrl), tokenUrl: oauthEndpoint(config.tokenUrl) };
  const guardedFetch = async (url, options = {}) => {
    oauthEndpoint(typeof url === "string" || url instanceof URL ? url : url.url);
    const response = await fetchImpl(url, { ...options, redirect: "manual", signal });
    if (response.status >= 300 && response.status < 400) throw fail("redirect_rejected", "授权发现不接受跨地址重定向");
    return response;
  };
  if (!config.issuer && resourceUrl) {
    let resource;
    try { resource = await discoverOAuthProtectedResourceMetadata(resourceUrl, {}, guardedFetch); }
    catch { throw fail("oauth_configuration_required", "无法发现官方授权入口，请填写服务商提供的授权配置"); }
    if (!resource?.authorization_servers?.length || resource.resource && new URL(resource.resource).origin !== new URL(resourceUrl).origin) throw fail("oauth_resource_mismatch", "授权资源信息与已配置的服务不一致");
    config = { ...config, issuer: resource.authorization_servers[0], resource: resource.resource ?? resourceUrl };
  }
  if (!config.issuer) throw fail("oauth_configuration_required", "请填写官方授权服务和客户端注册信息");
  const issuer = new URL(oauthEndpoint(config.issuer));
  let metadata;
  try { metadata = await discoverAuthorizationServerMetadata(issuer, { fetchFn: guardedFetch }); }
  catch { throw fail("oauth_issuer_mismatch", "授权服务声明的身份与配置不一致或无法读取"); }
  if (!metadata) throw fail("oauth_configuration_required", "未找到授权服务说明，请填写服务商提供的授权地址");
  if (metadata.code_challenge_methods_supported && !metadata.code_challenge_methods_supported.includes("S256")) throw fail("oauth_pkce_unavailable", "授权服务不支持所需的安全登录方式");
  if (!config.clientId && !metadata.registration_endpoint) throw fail("oauth_client_registration_required", "请先在服务商注册本机应用，并填写客户端编号");
  return { ...config, issuerParameterSupported: metadata.authorization_response_iss_parameter_supported === true,
    ...(metadata.registration_endpoint ? { registrationUrl: oauthEndpoint(metadata.registration_endpoint) } : {}),
    authorizationUrl: oauthEndpoint(metadata.authorization_endpoint), tokenUrl: oauthEndpoint(metadata.token_endpoint) };
}
export class OAuthManager {
  constructor({ fetchImpl = fetch, onAuthorized, openBrowser }) { Object.assign(this, { fetchImpl, onAuthorized, openBrowser }); this.pending = new Map(); }
  async start(key, config, { signal, context, resourceUrl } = {}) {
    await this.cancel(key);
    const controller = new AbortController(), active = AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60000), ...(signal ? [signal] : [])]);
    config = await oauthMetadata(config, { fetchImpl: this.fetchImpl, signal: active, resourceUrl });
    const state = randomBytes(32).toString("base64url"), verifier = randomBytes(48).toString("base64url");
    const record = { state, status: "awaiting_authorization", context, config, controller };
    const server = createServer(async (request, response) => {
      const address = new URL(request.url, record.redirectUri);
      if (request.method !== "GET" || request.headers.host !== new URL(record.redirectUri).host || address.pathname !== "/callback" || address.searchParams.get("state") !== state || record.status !== "awaiting_authorization"
        || config.issuer && (config.issuerParameterSupported || address.searchParams.has("iss")) && address.searchParams.get("iss") !== config.issuer) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }); response.end("授权请求无效，请返回 NEUMA 重新开始。"); return;
      }
      record.status = "exchanging";
      try {
        if (address.searchParams.has("error") || !address.searchParams.get("code")) throw fail("oauth_declined", "登录授权未完成");
        const tokens = await tokenRequest(config, { grant_type: "authorization_code", code: address.searchParams.get("code"), redirect_uri: record.redirectUri, code_verifier: verifier }, { fetchImpl: this.fetchImpl, signal: active });
        active.throwIfAborted();
        await this.onAuthorized(key, tokens, context, config, active); record.status = "authorized";
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" }); response.end("授权完成，可以关闭此窗口并返回 NEUMA。");
      } catch (error) { record.status = "failed"; record.reason = error.reason ?? "oauth_failed"; response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }); response.end("授权未完成，请返回 NEUMA 检查连接配置并重试。"); }
      finally { clearTimeout(record.timer); server.close(); }
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    record.server = server; record.redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
    if (!config.clientId) {
      try {
        const registration = await registerClient(config.issuer, { metadata: { issuer: config.issuer, authorization_endpoint: config.authorizationUrl, token_endpoint: config.tokenUrl, registration_endpoint: config.registrationUrl, response_types_supported: ["code"] },
          clientMetadata: { client_name: "NEUMA", redirect_uris: [record.redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
          fetchFn: (url, options) => this.fetchImpl(oauthEndpoint(url), { ...options, redirect: "manual", signal: active }) });
        if (!registration.client_id || registration.client_secret) throw fail("oauth_client_registration_required", "此服务要求另外注册客户端，请填写服务商提供的公开客户端编号");
        config.clientId = registration.client_id;
      } catch (error) { server.close(); throw error.reason ? error : fail("oauth_client_registration_required", "自动注册未完成，请填写服务商提供的客户端编号"); }
    }
    record.timer = setTimeout(() => { if (["awaiting_authorization", "exchanging"].includes(record.status)) { record.status = "expired"; server.close(); } }, 10 * 60000); record.timer.unref(); server.unref();
    const authorization = new URL(config.authorizationUrl);
    for (const [name, value] of Object.entries({ response_type: "code", client_id: config.clientId, redirect_uri: record.redirectUri, state, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"), scope: (config.scopes ?? []).join(" "), ...(config.resource ? { resource: config.resource } : {}) })) authorization.searchParams.set(name, value);
    this.pending.set(key, record);
    let browserOpened = false;
    if (this.openBrowser) { try { await this.openBrowser(authorization.href); browserOpened = true; } catch { /* The verified URL remains available for a manual retry. */ } }
    active.throwIfAborted();
    return { status: record.status, authorizationUrl: authorization.href, redirectUri: record.redirectUri, browserOpened };
  }
  status(key) { const record = this.pending.get(key); return { status: record?.status ?? "idle", ...(record?.reason ? { reason: record.reason } : {}) }; }
  async cancel(key) { const record = this.pending.get(key); if (!record) return { status: "idle" }; clearTimeout(record.timer); record.controller.abort(); record.server?.close(); record.status = "cancelled"; return { status: "cancelled" }; }
  async close() { await Promise.all([...this.pending.keys()].map((key) => this.cancel(key))); }
}
export async function refreshOAuth(config, tokens, options) {
  if (!tokens.refreshToken) throw fail("reauthorization_required", "登录已过期，请重新连接服务");
  const next = await tokenRequest(config, { grant_type: "refresh_token", refresh_token: tokens.refreshToken }, options);
  return { ...tokens, ...next, refreshToken: next.refreshToken ?? tokens.refreshToken };
}
