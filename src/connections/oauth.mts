import type { ExecFileOptions } from "node:child_process";
export type OAuthBrowserRunner = (command: string, args: readonly string[], options: ExecFileOptions, done: (error: Error | null) => void) => unknown;
import type { Server } from "node:http";
import type { OAuthConfiguration, OAuthTokens } from "../contracts/connection.mjs";
import { objectFields, errorField } from "../runtime/type-boundary.mjs";
interface RequestOptions { fetchImpl: typeof fetch; signal?: AbortSignal | undefined }
interface ResolvedOAuth extends OAuthConfiguration { authorizationUrl: string; tokenUrl: string }
interface PendingAuthorization<Context> { state: string; status: string; context: Context | undefined; config: OAuthConfiguration; controller: AbortController; redirectUri: string; server?: Server; timer?: NodeJS.Timeout; reason?: string }
interface OAuthManagerOptions<Context> { fetchImpl?: typeof fetch; onAuthorized(key: string, tokens: OAuthTokens, context: Context | undefined, config: OAuthConfiguration, signal: AbortSignal): Promise<void>; openBrowser?: ((url: string) => Promise<void>) | undefined }
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { readResponse } from "./http-adapter.mjs";
import { discoverOAuthProtectedResourceMetadata, discoverAuthorizationServerMetadata, registerClient } from "@modelcontextprotocol/client";

const fail = (reason: string, message: string) => Object.assign(new Error(message), { reason });
export async function openOAuthBrowser(value: string, { platform = process.platform, run = execFile }: { platform?: NodeJS.Platform; run?: OAuthBrowserRunner } = {}) {
  const url = oauthEndpoint(value);
  if (platform !== "darwin") throw fail("browser_open_unavailable", "请在系统浏览器中打开登录地址");
  await new Promise<void>((resolve, reject) => run("/usr/bin/open", [url], { timeout: 10000, env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
    windowsHide: true }, (error) => error ? reject(fail("browser_open_failed", "系统浏览器未能打开，请手动打开登录地址")) : resolve()));
}
export function oauthEndpoint(value: string | URL | undefined) {
  let url; try { url = new URL(value!); } catch { throw fail("invalid_oauth", "授权服务地址无效"); }
  if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw fail("invalid_oauth", "授权地址必须使用 HTTPS 或本机回环地址");
  return url.href;
}
async function tokenRequest(config: OAuthConfiguration, values: Record<string, string>, { fetchImpl, signal }: RequestOptions): Promise<OAuthTokens> {
  let response;
  try { response = await fetchImpl(oauthEndpoint(config.tokenUrl), { method: "POST", redirect: "manual", signal: signal ?? null,
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ ...values, client_id: config.clientId!, ...(config.resource ? { resource: config.resource } : {}), ...(config.clientSecret ? { client_secret: config.clientSecret } : {}) }) }); }
  catch { if (signal?.aborted) throw signal.reason; throw fail("oauth_network_failed", "授权服务暂时无法连接，请重试或重新登录"); }
  const result = objectFields(await readResponse(response, { maxBytes: 128 * 1024, signal }));
  if (!result || typeof result.access_token !== "string" || !result.access_token || /[\r\n\0]/.test(result.access_token)
    || result.token_type && (typeof result.token_type !== "string" || result.token_type.toLowerCase() !== "bearer")) throw fail("invalid_oauth_response", "授权服务未返回可用的访问令牌");
  return { accessToken: result.access_token, refreshToken: typeof result.refresh_token === "string" ? result.refresh_token : undefined,
    expiresAt: Number.isFinite(Number(result.expires_in)) ? Date.now() + Number(result.expires_in) * 1000 : null,
    scopes: typeof result.scope === "string" ? result.scope.split(/\s+/).filter(Boolean) : config.scopes ?? [] };
}
export async function oauthMetadata(config: OAuthConfiguration, { fetchImpl = fetch, signal, resourceUrl }: { fetchImpl?: typeof fetch; signal?: AbortSignal | undefined; resourceUrl?: string | undefined } = {}): Promise<ResolvedOAuth> {
  if (config.authorizationUrl && config.tokenUrl && config.clientId) return { ...config, authorizationUrl: oauthEndpoint(config.authorizationUrl), tokenUrl: oauthEndpoint(config.tokenUrl) };
  const guardedFetch: typeof fetch = async (url, options = {}) => {
    signal?.throwIfAborted();
    oauthEndpoint(typeof url === "string" || url instanceof URL ? url : url.url);
    const response = await fetchImpl(url, { ...options, redirect: "manual", signal: signal ?? null });
    signal?.throwIfAborted();
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
export class OAuthManager<Context = unknown> {
  declare fetchImpl: typeof fetch; declare onAuthorized: OAuthManagerOptions<Context>["onAuthorized"]; declare openBrowser: OAuthManagerOptions<Context>["openBrowser"]; pending: Map<string, PendingAuthorization<Context>>;
  constructor({ fetchImpl = fetch, onAuthorized, openBrowser }: OAuthManagerOptions<Context>) { Object.assign(this, { fetchImpl, onAuthorized, openBrowser }); this.pending = new Map(); }
  async start(key: string, input: OAuthConfiguration, { signal, context, resourceUrl }: { signal?: AbortSignal | undefined; context?: Context; resourceUrl?: string } = {}) {
    signal?.throwIfAborted();
    this.cancel(key);
    const controller = new AbortController(), active = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    const state = randomBytes(32).toString("base64url"), verifier = randomBytes(48).toString("base64url");
    const record: PendingAuthorization<Context> = { state, status: "awaiting_authorization", context, config: input, controller, redirectUri: "" };
    // Register before discovery so cancellation and a superseding start own this initialization too.
    this.pending.set(key, record);
    let rejectCancellation: (reason: unknown) => void = () => {};
    const interrupted = new Promise<never>((_, reject) => { rejectCancellation = reject; });
    void interrupted.catch(() => {});
    const cleanup = () => { clearTimeout(record.timer); active.removeEventListener("abort", aborted); record.server?.close(); };
    const aborted = () => {
      record.status = errorField(active.reason, "name") === "TimeoutError" ? "expired" : "cancelled";
      cleanup(); rejectCancellation(active.reason);
    };
    const wait = <T,>(operation: Promise<T>) => Promise.race([operation, interrupted]);
    record.timer = setTimeout(() => controller.abort(new DOMException("登录授权已超时", "TimeoutError")), 10 * 60000); record.timer.unref();
    active.addEventListener("abort", aborted, { once: true });
    try {
      if (active.aborted) aborted();
      active.throwIfAborted();
      const config = await wait(oauthMetadata(input, { fetchImpl: this.fetchImpl, signal: active, resourceUrl }));
      active.throwIfAborted(); record.config = config;
      const server = createServer(async (request, response) => {
        const address = new URL(request.url!, record.redirectUri);
        if (active.aborted || request.method !== "GET" || request.headers.host !== new URL(record.redirectUri).host || address.pathname !== "/callback" || address.searchParams.get("state") !== state || record.status !== "awaiting_authorization"
          || config.issuer && (config.issuerParameterSupported || address.searchParams.has("iss")) && address.searchParams.get("iss") !== config.issuer) {
          response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }); response.end("授权请求无效，请返回 NEUMA 重新开始。"); return;
        }
        record.status = "exchanging";
        try {
          if (address.searchParams.has("error") || !address.searchParams.get("code")) throw fail("oauth_declined", "登录授权未完成");
          const tokens = await wait(tokenRequest(config, { grant_type: "authorization_code", code: address.searchParams.get("code")!, redirect_uri: record.redirectUri, code_verifier: verifier }, { fetchImpl: this.fetchImpl, signal: active }));
          active.throwIfAborted();
          await this.onAuthorized(key, tokens, context, config, active); record.status = "authorized";
          response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" }); response.end("授权完成，可以关闭此窗口并返回 NEUMA。");
        } catch (error) {
          if (!active.aborted) { record.status = "failed"; record.reason = typeof errorField(error, "reason") === "string" ? String(errorField(error, "reason")) : "oauth_failed"; }
          response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }); response.end("授权未完成，请返回 NEUMA 检查连接配置并重试。");
        } finally { cleanup(); }
      });
      record.server = server;
      await wait(new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          if (active.aborted) { server.close(); reject(active.reason); } else resolve();
        });
      }));
      active.throwIfAborted();
      const address = server.address(); if (!address || typeof address === "string") throw fail("invalid_oauth", "授权服务监听地址无效"); record.redirectUri = `http://127.0.0.1:${address.port}/callback`;
      if (!config.clientId) {
        try {
          const registration = await wait(registerClient(config.issuer!, { metadata: { issuer: config.issuer!, authorization_endpoint: config.authorizationUrl, token_endpoint: config.tokenUrl, registration_endpoint: config.registrationUrl!, response_types_supported: ["code"] },
            clientMetadata: { client_name: "NEUMA", redirect_uris: [record.redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
            fetchFn: (url, options) => { active.throwIfAborted(); return this.fetchImpl(oauthEndpoint(url), { ...options, redirect: "manual", signal: active }); } }));
          active.throwIfAborted();
          if (!registration.client_id || registration.client_secret) throw fail("oauth_client_registration_required", "此服务要求另外注册客户端，请填写服务商提供的公开客户端编号");
          config.clientId = registration.client_id;
        } catch (error) { throw errorField(error, "reason") ? error : fail("oauth_client_registration_required", "自动注册未完成，请填写服务商提供的客户端编号"); }
      }
      server.unref();
      const authorization = new URL(config.authorizationUrl);
      for (const [name, value] of Object.entries({ response_type: "code", client_id: config.clientId!, redirect_uri: record.redirectUri, state, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"), scope: (config.scopes ?? []).join(" "), ...(config.resource ? { resource: config.resource } : {}) })) authorization.searchParams.set(name, value);
      let browserOpened = false;
      active.throwIfAborted();
      if (this.openBrowser) { try { await wait(this.openBrowser(authorization.href)); browserOpened = true; } catch { /* The verified URL remains available for a manual retry. */ } }
      active.throwIfAborted();
      return { status: record.status, authorizationUrl: authorization.href, redirectUri: record.redirectUri, browserOpened };
    } catch (error) {
      cleanup();
      if (active.aborted) throw active.reason;
      record.status = "failed"; record.reason = typeof errorField(error, "reason") === "string" ? String(errorField(error, "reason")) : "oauth_failed";
      throw error;
    }
  }
  status(key: string) { const record = this.pending.get(key); return { status: record?.status ?? "idle", ...(record?.reason ? { reason: record.reason } : {}) }; }
  cancel(key: string) { const record = this.pending.get(key); if (!record) return { status: "idle" }; clearTimeout(record.timer); record.controller.abort(); record.server?.close(); record.status = "cancelled"; return { status: "cancelled" }; }
  async close() { await Promise.all([...this.pending.keys()].map((key) => this.cancel(key))); }
}
export async function refreshOAuth(config: OAuthConfiguration, tokens: OAuthTokens, options: RequestOptions) {
  if (!tokens.refreshToken) throw fail("reauthorization_required", "登录已过期，请重新连接服务");
  const next = await tokenRequest({ ...config, scopes: tokens.scopes ?? config.scopes }, { grant_type: "refresh_token", refresh_token: tokens.refreshToken }, options);
  return { ...tokens, ...next, refreshToken: next.refreshToken ?? tokens.refreshToken };
}
