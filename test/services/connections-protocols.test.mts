import { fixtureText } from "../helpers/m7-test-boundaries.mjs";
import { callFixture } from "../helpers/m7-test-boundaries.mjs";
import type { FixtureModelRequest } from "../helpers/m7-test-boundaries.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import { listeningAddress } from "../helpers/m7-test-boundaries.mjs";
import type { TestFailure } from "../helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { AgentConnectionStore } from "../../src/agents/agent-connections.mjs";
import { OAuthManager, openOAuthBrowser } from "../../src/connections/oauth.mjs";
import { CredentialVault } from "../../src/connections/credential-vault.mjs";
import { httpCall, importOpenApi } from "../../src/connections/http-adapter.mjs";
import type { ExecFileOptionsWithBufferEncoding,ExecFileOptions,ExecFileOptionsWithStringEncoding } from "child_process";

async function fixture(t: test.TestContext, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "neuma-connector-v2-"));
  const store = new AgentConnectionStore({ dataDir, credentialKeySource: async () => Buffer.alloc(32, 3), ...options });
  t.after(async () => { await store.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { store, dataDir };
}
const requirement = (operations: { id: string; method: string; path: string; safeTest: boolean; readOnly: boolean; testInput: { collection: string; query: string; limit: number; }; inputSchema: { type: string; properties: { collection: { type: string; }; query: { type: string; }; limit: { type: string; maximum: number; }; }; required: string[]; }; outputSchema: { type: string; required: string[]; properties: { matches: { type: string; }; }; }; request: { query: { top: string; }; headers: { "X-Request-Type": { literal: string; }; }; body: { text: string; }; }; }[]|{ id: string; method: string; path: string; }[]|({ id: string; tool: string; readOnly: boolean; resourceUri?: never; }|{ id: string; resourceUri: string; readOnly: boolean; tool?: never; })[]|({ id: string; method: string; path: string; readOnly: boolean; safeTest: boolean; request?: never; }|{ id: string; method: string; path: string; request: { path: { space: { config: string; }; }; headers: { "X-Extra-Secret": { credential: string; }; }; }; readOnly?: never; safeTest?: never; })[], extra = {}) => [{ id: "data", purpose: "business", required: true, description: "资料服务", operations, ...extra }];

test("OAuth uses the system browser without shell interpolation or inherited credentials", async () => {
  const calls: ({ "command": (string); "args": (readonly string[] | null | undefined); "options": (ExecFileOptionsWithBufferEncoding | ExecFileOptions | ExecFileOptionsWithStringEncoding | null | undefined); })[] = [];
  await openOAuthBrowser("https://login.example/authorize?state=fixture", { platform: "darwin", run: (command, args, options, done) => {
    calls.push({ command, args, options }); done(null);
  } });
  assert.equal(calls[0]!.command, "/usr/bin/open"); assert.deepEqual(calls[0]!.args, ["https://login.example/authorize?state=fixture"]);
  assert.equal(calls[0]!.options!.shell, undefined); assert.deepEqual(Object.keys(objectFields(calls[0]!.options!.env)).sort(), ["LANG", "PATH"]);
  await assert.rejects(callFixture(openOAuthBrowser, undefined, ["file:///tmp/not-a-login", { run: () => assert.fail("unsafe URL opened") }]));
  await assert.rejects(callFixture(openOAuthBrowser, undefined, ["https://login.example/", { platform: "darwin", run: (_command: string, _args: readonly string[], _options: ExecFileOptions, done: (error: Error | null) => void) => done(new Error("private diagnostic")) }]),
    (error: TestFailure) => error.reason === "browser_open_failed" && !error.message.includes("private diagnostic"));
});
const save = (store: AgentConnectionStore, requirements: { id: string; purpose: string; required: boolean; description: string; operations: { id: string; method: string; path: string; safeTest: boolean; readOnly: boolean; testInput: { collection: string; query: string; limit: number; }; inputSchema: { type: string; properties: { collection: { type: string; }; query: { type: string; }; limit: { type: string; maximum: number; }; }; required: string[]; }; outputSchema: { type: string; required: string[]; properties: { matches: { type: string; }; }; }; request: { query: { top: string; }; headers: { "X-Request-Type": { literal: string; }; }; body: { text: string; }; }; }[]|{ id: string; method: string; path: string; }[]|({ id: string; tool: string; readOnly: boolean; resourceUri?: never; }|{ id: string; resourceUri: string; readOnly: boolean; tool?: never; })[]|({ id: string; method: string; path: string; readOnly: boolean; safeTest: boolean; request?: never; }|{ id: string; method: string; path: string; request: { path: { space: { config: string; }; }; headers: { "X-Extra-Secret": { credential: string; }; }; }; readOnly?: never; safeTest?: never; })[]; }[], extra = {}) => store.save("alpha", { id: "data", kind: "business", baseUrl: "http://127.0.0.1:32100/api", authType: "none", ...extra }, requirements);

test("HTTP mappings validate data, preserve authority and allow reviewed read-only POST tests", async (t) => {
  const requests: { url: unknown; options: unknown }[] = [], { store } = await fixture(t, { fetchImpl: async (url: unknown, options: unknown) => { requests.push({ url, options }); return Response.json({ matches: 2 }); } });
  const requirements = requirement([{ id: "lookup", method: "POST", path: "/collections/{collection}/query", safeTest: true, readOnly: true,
    testInput: { collection: "notes", query: "hello", limit: 2 },
    inputSchema: { type: "object", properties: { collection: { type: "string" }, query: { type: "string" }, limit: { type: "integer", maximum: 10 } }, required: ["collection", "query"] },
    outputSchema: { type: "object", required: ["matches"], properties: { matches: { type: "integer" } } },
    request: { query: { top: "limit" }, headers: { "X-Request-Type": { literal: "search" } }, body: { text: "query" } } }]);
  await save(store, requirements, { authType: "basic", username: "researcher", secret: "fixture-password" });
  assert.equal((await store.test("alpha", "data", { requirements })).verified, true);
  assert.equal(requests[0]!.url, "http://127.0.0.1:32100/api/collections/notes/query?top=2");
  assert.equal(objectFields(requests[0]!.options).body, '{"text":"hello"}');
  assert.match(fixtureText(objectFields(objectFields(requests[0]!.options).headers).authorization), /^Basic /);
  const snapshot = await store.snapshot("alpha");
  await assert.rejects(store.call(snapshot, { connectionId: "data", operationId: "lookup", input: { collection: "../private", query: "q" } }, { requirements }), { reason: "invalid_input" });
  await assert.rejects(store.call(snapshot, { connectionId: "data", operationId: "lookup", input: { collection: "notes", query: "q", limit: 100 } }, { requirements }), { reason: "invalid_input" });
  assert.equal(requests.length, 1);
});

test("multipart only resolves trusted material references; form and output checks are real", async () => {
  let seen;
  const options = { fetchImpl: async (_url: unknown, request: unknown) => { seen = request; return Response.json({ saved: true }); }, resolveFile: async (reference: unknown) => {
    assert.equal(reference, "material:123"); return { data: Buffer.from("sample"), name: "sample.txt", contentType: "text/plain" };
  } };
  const connection = { baseUrl: "http://localhost:8123", authType: "none" };
  await callFixture(httpCall, undefined, [connection, { method: "POST", path: "/upload", request: { encoding: "multipart" } }, { file: { fileRef: "material:123" }, name: "first" }, options]);
  assert.equal(await seen!.body!.get("file").text(), "sample"); assert.equal(seen!.body!.get("name"), "first");
  await assert.rejects(callFixture(httpCall, undefined, [connection, { method: "POST", path: "/upload", request: { encoding: "multipart" } }, { file: { fileRef: "/etc/passwd" } }, { fetchImpl: options.fetchImpl }]), { reason: "file_access_unavailable" });
  await callFixture(httpCall, undefined, [connection, { method: "POST", path: "/form", request: { encoding: "form" } }, { q: "a b" }, options]);
  assert.equal(seen!.body!.toString(), "q=a+b");
  await assert.rejects(callFixture(httpCall, undefined, [connection, { method: "GET", path: "/result", outputSchema: { type: "array" } }, {}, options]), { reason: "invalid_response" });
});

test("credential migration encrypts all historical versions and fails closed without a key", async (t) => {
  const { store, dataDir } = await fixture(t);
  await store.storage.writeJson("alpha", "private/connections.json", { schemaVersion: 1, agentId: "alpha", version: 1, connections: {
    model: { id: "model", currentVersion: 1, generation: "test", versions: { 1: { id: "model", kind: "model", version: 1, generation: "test", authType: "bearer", secret: "legacy-fixture" } } },
  } });
  const snapshot = await store.snapshot("alpha");
  store.vault = new CredentialVault({ storage: store.storage, keySource: async () => { throw new Error("unavailable"); } });
  await assert.rejects(store.assertActive(snapshot, "model"), { reason: "credential_vault_unavailable" });
  const path = join(dataDir, "agents/alpha/private/connections.json"); assert.match(await readFile(path, "utf8"), /legacy-fixture/);
  store.vault = new CredentialVault({ storage: store.storage, keySource: async () => Buffer.alloc(32, 3) });
  assert.equal((await store.assertActive(snapshot, "model")).secret, "legacy-fixture"); assert.doesNotMatch(await readFile(path, "utf8"), /legacy-fixture/);
  assert.equal(JSON.stringify(await store.list("alpha")).includes("legacy-fixture"), false);
});

test("large results are stored per agent and read with bounded pagination", async (t) => {
  const { store } = await fixture(t, { fetchImpl: async () => Response.json({ text: "a".repeat(150000) }) });
  const requirements = requirement([{ id: "read", method: "GET", path: "/read" }]); await save(store, requirements);
  const result = await store.call(await store.snapshot("alpha"), { connectionId: "data", operationId: "read" }, { requirements });
  assert.ok(result.resultRef); assert.equal(result.data, undefined);
  const page = await store.readResult("alpha", result.resultRef, { offset: 0, length: 100 }); assert.equal(page.content.length, 100); assert.equal(page.hasMore, true);
  await assert.rejects(store.readResult("beta", result.resultRef), { reason: "missing_result" });
  await assert.rejects(store.readResult("alpha", result.resultRef, { scope: "group:one", connectionIds: ["data"] }), { reason: "missing_result" });
  await assert.rejects(store.readResult("alpha", result.resultRef, { connectionIds: ["another"] }), { reason: "missing_result" });
  const group = await store.call(await store.snapshot("alpha"), { connectionId: "data", operationId: "read" }, { requirements, scope: "group:one" });
  await assert.rejects(callFixture(store.readResult, store, ["alpha", group.resultRef]), { reason: "missing_result" });
  assert.equal((await store.readResult("alpha", group.resultRef!, { scope: "group:one", connectionIds: ["data"] })).hasMore, true);
  await store.remove("alpha", "data"); await assert.rejects(store.readResult("alpha", result.resultRef), { reason: "connection_revoked" });
});

test("official MCP transport discovers only and invokes reviewed tools, rejecting changed schemas", async (t) => {
  let calls = 0, changed = false;
  const server = createServer(async (request, response) => {
    const mcp = new McpServer({ name: "fixture", version: "1" });
    mcp.registerTool("lookup", { inputSchema: fromJsonSchema<{text: string}>({ type: "object", properties: { text: { type: "string" }, ...(changed ? { extra: { type: "string" } } : {}) }, required: ["text"] }) }, async ({ text }) => { calls++; return { content: [{ type: "text", text }], structuredContent: { text } }; });
    mcp.registerTool("unapproved", { inputSchema: callFixture(fromJsonSchema, undefined, [{ type: "object" }]) }, async () => { calls++; return { content: [] }; });
    mcp.registerResource("guide", "fixture://guide", { mimeType: "text/plain" }, async () => ({ contents: [{ uri: "fixture://guide", text: "guide" }] }));
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on("close", () => { transport.close(); mcp.close(); }); await mcp.connect(transport); await transport.handleRequest(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const { store } = await fixture(t), requirements = requirement([{ id: "find", tool: "lookup", readOnly: true }, { id: "guide", resourceUri: "fixture://guide", readOnly: true }], { protocol: "mcp" });
  await save(store, requirements, { baseUrl: `http://127.0.0.1:${listeningAddress(server).port}/mcp`, protocol: "mcp" });
  const discovered = await store.discover("alpha", "data", { requirements }); assert.equal(discovered.tools!.length, 2); assert.equal(discovered.resources!.length, 1); assert.equal(calls, 0);
  const snapshot = await store.snapshot("alpha");
  assert.equal(objectFields(objectFields((await store.call(snapshot, { connectionId: "data", operationId: "find", input: { text: "sample" } }, { requirements })).data).structuredContent).text, "sample");
  assert.equal(objectFields(objectFields(objectFields((await store.call(snapshot, { connectionId: "data", operationId: "guide" }, { requirements })).data).contents)[0]).text, "guide");
  await assert.rejects(store.call(snapshot, { connectionId: "data", operationId: "unapproved" }, { requirements }), { reason: "operation_not_designed" });
  changed = true; await assert.rejects(store.call(snapshot, { connectionId: "data", operationId: "find", input: { text: "sample" } }, { requirements }), { reason: "connection_contract_changed" }); assert.equal(calls, 1);
  await store.discover("alpha", "data", { requirements });
  await assert.rejects(store.call(snapshot, { connectionId: "data", operationId: "find", input: { text: "sample" } }, { requirements }), { reason: "connection_contract_changed" }); assert.equal(calls, 1);
});

test("authorized resource discovery populates constrained choices and injects only chosen configuration", async (t) => {
  const requests: { url: unknown; options: unknown }[] = [], { store } = await fixture(t, { fetchImpl: async (url: string, options: unknown) => { requests.push({ url, options }); return Response.json(url.endsWith("/spaces") ? { items: [{ id: "mine", name: "我的资料" }] } : { text: "content" }); } });
  const requirements = requirement([
    { id: "spaces", method: "GET", path: "/spaces", readOnly: true, safeTest: true },
    { id: "read", method: "GET", path: "/spaces/{space}", request: { path: { space: { config: "space" } }, headers: { "X-Extra-Secret": { credential: "extraKey" } } } },
  ], { configFields: [
    { key: "space", label: "资料库", type: "select", required: true, optionsFrom: { operationId: "spaces", itemsPath: "items", valuePath: "id", labelPath: "name" } },
    { key: "extraKey", label: "附加凭据", type: "password", required: true },
  ] });
  await save(store, requirements, { values: { extraKey: "extra-fixture" } });
  await assert.rejects(store.call(await store.snapshot("alpha"), { connectionId: "data", operationId: "read" }, { requirements }), { reason: "connection_configuration_required" });
  const discovery = await store.discover("alpha", "data", { requirements }); assert.deepEqual(discovery.configurationChoices.space, [{ value: "mine", label: "我的资料" }]);
  await assert.rejects(store.save("alpha", { id: "data", values: { space: "other-account" } }, requirements), { reason: "invalid_connection" });
  await store.save("alpha", { id: "data", values: { space: "mine" } }, requirements);
  await store.call(await store.snapshot("alpha"), { connectionId: "data", operationId: "read" }, { requirements });
  assert.equal(requests.at(-1)!.url, "http://127.0.0.1:32100/api/spaces/mine"); assert.equal(objectFields(objectFields(requests.at(-1)!.options).headers)["X-Extra-Secret"], "extra-fixture");
  assert.equal(JSON.stringify(await store.list("alpha", requirements)).includes("extra-fixture"), false);
});

test("OAuth discovers official metadata and registers a public loopback client before login", async (t) => {
  let origin: string, registration;
  const service = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/.well-known/oauth-authorization-server") response.end(JSON.stringify({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] }));
    else if (request.url === "/register") { let body = ""; for await (const chunk of request) body += chunk; registration = JSON.parse(String(body)); response.end(JSON.stringify({ ...registration, client_id: "registered-fixture" })); }
    else { response.statusCode = 404; response.end("{}"); }
  });
  await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve)); origin = `http://127.0.0.1:${listeningAddress(service).port}`;
  t.after(() => new Promise((resolve) => { service.closeAllConnections(); service.close(resolve); }));
  const manager = new OAuthManager({ onAuthorized: async () => {} }); t.after(() => manager.close());
  const login = await manager.start("one", { issuer: origin });
  assert.equal(new URL(login.authorizationUrl).searchParams.get("client_id"), "registered-fixture");
  assert.deepEqual(registration!.redirect_uris!, [login.redirectUri]); assert.equal(registration!.token_endpoint_auth_method!, "none");
});

test("OAuth binds host, state, PKCE and connection generation without exposing tokens", async (t) => {
  let tokenBody;
  const { store } = await fixture(t, { fetchImpl: async (_url: unknown, options: { body: unknown; }) => { tokenBody = options.body; return Response.json({ access_token: "oauth-fixture-secret", refresh_token: "refresh-fixture", token_type: "Bearer", expires_in: 3600 }); } });
  const requirements = requirement([{ id: "read", method: "GET", path: "/read" }]);
  await save(store, requirements, { authType: "oauth", oauth: { clientId: "fixture", authorizationUrl: "https://login.example/authorize", tokenUrl: "https://login.example/token", scopes: ["read"] } });
  const prior = await store.snapshot("alpha"), login = await store.authorize("alpha", "data", { requirements }), authorization = new URL(login.authorizationUrl);
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256"); assert.ok(authorization.searchParams.get("code_challenge"));
  const wrong = await fetch(`${login.redirectUri}?state=wrong&code=sample`); assert.equal(wrong.status, 400); assert.equal(tokenBody, undefined);
  const callback = new URL(login.redirectUri); callback.searchParams.set("state", authorization.searchParams.get("state")!); callback.searchParams.set("code", "sample");
  assert.equal((await fetch(callback)).status, 200); assert.ok(tokenBody!.get!("code_verifier"));
  assert.equal(store.authorizationStatus("alpha", "data").status, "authorized");
  await assert.rejects(store.assertActive(prior, "data"), { reason: "connection_revoked" });
  assert.equal((await store.assertActive(await store.snapshot("alpha"), "data")).secret, "oauth-fixture-secret");
  assert.equal(JSON.stringify(await store.list("alpha", requirements)).includes("oauth-fixture-secret"), false);
});

test("OAuth initialization respects connection cancellation, shutdown and request cancellation", async (t) => {
  for (const stop of ["connection", "shutdown", "request"] as const) await t.test(stop, async (t) => {
    let notifyEntered = () => {}, releaseDiscovery: (response: Response) => void = () => {};
    const entered = new Promise<void>((resolve) => { notifyEntered = resolve; });
    const discovery = new Promise<Response>((resolve) => { releaseDiscovery = resolve; });
    let opened = 0;
    const { store } = await fixture(t, { fetchImpl: async () => { notifyEntered(); return discovery; },
      openBrowser: async () => { opened++; } });
    const requirements = requirement([{ id: "read", method: "GET", path: "/read" }]);
    await save(store, requirements, { authType: "oauth", oauth: { issuer: "https://login.example", clientId: "fixture" } });
    const snapshot = await store.snapshot("alpha"), controller = new AbortController();
    const authorizing = store.authorize("alpha", "data", { requirements, signal: controller.signal }).then(
      (value) => ({ status: "fulfilled" as const, value }), (error: unknown) => ({ status: "rejected" as const, error }));
    await entered;
    if (stop === "connection") await store.cancelAuthorization("alpha", "data");
    else if (stop === "shutdown") await store.close();
    else controller.abort();
    // A transport can deliver an already queued response after cancellation.
    releaseDiscovery(Response.json({ issuer: "https://login.example", authorization_endpoint: "https://login.example/authorize",
      token_endpoint: "https://login.example/token", response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] }));
    const result = await authorizing;
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.equal(objectFields(result.error).name, "AbortError");
    assert.equal(opened, 0);
    await assert.rejects(store.assertActive(snapshot, "data"), { reason: "authorization_required" });
  });
});

test("OAuth cancellation owns the connection read before the manager starts", async (t) => {
  for (const stop of ["connection", "shutdown"] as const) await t.test(stop, async (t) => {
    let notifyEntered = () => {}, releaseRead = () => {}, blocked = false, opened = 0;
    const entered = new Promise<void>((resolve) => { notifyEntered = resolve; });
    const reading = new Promise<void>((resolve) => { releaseRead = resolve; });
    const { store } = await fixture(t, { openBrowser: async () => { opened++; } });
    const requirements = requirement([{ id: "read", method: "GET", path: "/read" }]);
    await save(store, requirements, { authType: "oauth", oauth: { clientId: "fixture",
      authorizationUrl: "https://login.example/authorize", tokenUrl: "https://login.example/token" } });
    const snapshot = await store.snapshot("alpha"), originalRead = store.storage.readJson.bind(store.storage);
    store.storage.readJson = async (id, file, ...options) => {
      if (!blocked && id === "alpha" && file === "private/connections.json") { blocked = true; notifyEntered(); await reading; }
      return originalRead(id, file, ...options);
    };
    const authorizing = store.authorize("alpha", "data", { requirements }).then(
      () => ({ status: "fulfilled" as const }), (error: unknown) => ({ status: "rejected" as const, error }));
    await entered;
    if (stop === "connection") await store.cancelAuthorization("alpha", "data");
    else await store.close();
    releaseRead();
    const result = await authorizing;
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.equal(objectFields(result.error).name, "AbortError");
    assert.equal(opened, 0);
    await assert.rejects(store.assertActive(snapshot, "data"), { reason: "authorization_required" });
  });
});

test("OAuth refresh without a scope response preserves the existing grant and current task", async (t) => {
  let refreshes = 0, calls = 0;
  const { store } = await fixture(t, { fetchImpl: async (url: string) => {
    if (url === "https://login.example/token") {
      refreshes++;
      return Response.json({ access_token: "refreshed", token_type: "Bearer", expires_in: 3600 });
    }
    calls++; return Response.json({ items: [] });
  } });
  const requirements = requirement([{ id: "read", method: "GET", path: "/read" }]);
  await save(store, requirements, { authType: "oauth", oauth: { clientId: "fixture",
    authorizationUrl: "https://login.example/authorize", tokenUrl: "https://login.example/token" } });
  await store.update("alpha", async (record) => { record.connections.data!.versions[1]!.credentialRef = await store.vault.put("alpha",
    { tokens: { accessToken: "expired", refreshToken: "refresh", expiresAt: 1, scopes: ["read", "write"] } }); });
  const snapshot = await store.snapshot("alpha");
  assert.equal((await store.call(snapshot, { connectionId: "data", operationId: "read" }, { requirements })).status, "ok");
  assert.equal((await store.call(snapshot, { connectionId: "data", operationId: "read" }, { requirements })).status, "ok");
  assert.equal(refreshes, 1); assert.equal(calls, 2);
  const current = (await store.read("alpha")).connections.data!;
  const credentials = await store.vault.get("alpha", current.versions[current.currentVersion]!.credentialRef);
  assert.deepEqual(credentials.tokens!.scopes, ["read", "write"]);
  assert.deepEqual(await store.snapshot("alpha"), snapshot);
});

test("OAuth refresh is serialized and a narrower grant invalidates existing tasks", async (t) => {
  let refreshes = 0;
  const { store } = await fixture(t, { fetchImpl: async () => { refreshes++; return Response.json({ access_token: "refreshed", token_type: "Bearer", expires_in: 3600, scope: "read" }); } });
  const requirements = requirement([{ id: "read", method: "GET", path: "/read" }]);
  await save(store, requirements, { authType: "oauth", oauth: { clientId: "fixture", authorizationUrl: "https://login.example/authorize", tokenUrl: "https://login.example/token", scopes: ["read", "write"] } });
  await store.update("alpha", async (record) => { const value = record.connections!.data!.versions[1]; value!.credentialRef! = await store.vault.put("alpha", { tokens: { accessToken: "expired", refreshToken: "refresh", expiresAt: 1, scopes: ["read", "write"] } }); });
  const snapshot = await store.snapshot("alpha"), results = await Promise.allSettled([store.assertActive(snapshot, "data"), store.assertActive(snapshot, "data")]);
  assert.equal(refreshes, 1); assert.equal(results.every((result) => result.status === "rejected" && result.reason.reason === "connection_revoked"), true);
  assert.equal((await store.assertActive(await store.snapshot("alpha"), "data")).secret, "refreshed");
});

test("refresh transport failures and echoed encoded credentials never expose secrets", async (t) => {
  const { store } = await fixture(t, { fetchImpl: async () => { throw new Error("refresh-fixture-sensitive"); } });
  const requirements = requirement([{ id: "read", method: "GET", path: "/read" }]);
  await save(store, requirements, { authType: "oauth", oauth: { clientId: "fixture", authorizationUrl: "https://login.example/authorize", tokenUrl: "https://login.example/token" } });
  await store.update("alpha", async (record) => { record.connections!.data!.versions[1]!.credentialRef = await store.vault.put("alpha", { tokens: { accessToken: "expired", refreshToken: "refresh-fixture-sensitive", expiresAt: 1 } }); });
  await assert.rejects(store.assertActive(await store.snapshot("alpha"), "data"), (error: TestFailure) => { assert.equal(error.reason, "oauth_network_failed"); assert.doesNotMatch(error.message, /refresh-fixture-sensitive/); return true; });
  await store.save("alpha", { id: "data", authType: "basic", username: "account", secret: "password-fixture" }, requirements);
  const encoded = Buffer.from("account:password-fixture").toString("base64"); store.fetchImpl = async () => Response.json({ echoed: encoded });
  const response = await store.call(await store.snapshot("alpha"), { connectionId: "data", operationId: "read" }, { requirements });
  assert.equal(JSON.stringify(response).includes(encoded), false);
});

test("cancelled OAuth cannot commit a late token response", async (t) => {
  let release, authorized = 0;
  const manager = new OAuthManager({ fetchImpl: async () => new Promise((resolve) => { release = resolve; }), onAuthorized: async () => { authorized++; } }); t.after(() => manager.close());
  const login = await manager.start("one", { authorizationUrl: "https://login.example/auth", tokenUrl: "https://login.example/token", clientId: "fixture" });
  const state = new URL(login.authorizationUrl).searchParams.get("state"), callback = fetch(`${login.redirectUri}?state=${state}&code=x`);
  for (let n = 0; n < 50 && !release; n++) await new Promise((resolve) => setTimeout(resolve, 5));
  await manager.cancel("one"); release!(Response.json({ access_token: "late", token_type: "Bearer" })); await callback;
  assert.equal(authorized, 0);
});

test("OpenAPI import produces review candidates and never grants discovered operations", () => {
  const result = importOpenApi({ openapi: "3.1.0", paths: { "/items/{id}": { get: { operationId: "read", parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }] } } } });
  assert.equal(result.requiresReview, true); assert.equal(result.operations![0]!.safeTest, false); assert.equal(result.operations![0]!.request!.path!.id, "id");
});

test("candidate connection profiles isolate edits, activate explicitly and keep old task bindings", async (t) => {
  const { store, dataDir } = await fixture(t), requirements = requirement([{ id: "read", method: "GET", path: "/read" }]), profile = "a".repeat(64);
  await save(store, requirements, { authType: "bearer", secret: "active-fixture" });
  const before = await readFile(join(dataDir, "agents/alpha/private/connections.json"), "utf8"), old = await store.snapshot("alpha");
  const candidate = await store.list("alpha", requirements, { profile }); assert.equal(candidate.connections![0]!.hasSecret, true);
  assert.equal(await readFile(join(dataDir, "agents/alpha/private/connections.json"), "utf8"), before);
  await store.save("alpha", { id: "data", baseUrl: "http://127.0.0.1:32101", secret: "candidate-fixture" }, requirements, { profile });
  assert.equal((await store.assertActive(old, "data")).secret, "active-fixture");
  assert.equal((await store.assertActive(await store.snapshot("alpha", { profile }), "data")).secret, "candidate-fixture");
  assert.equal(await store.getActiveProfile("alpha"), "legacy");
  await store.activateProfile("alpha", profile); assert.equal(await store.getActiveProfile("alpha"), profile);
  assert.equal((await store.assertActive(await store.snapshot("alpha"), "data")).secret, "candidate-fixture");
  assert.equal((await store.assertActive(old, "data")).secret, "active-fixture");
  await store.activateProfile("alpha", "legacy"); assert.equal((await store.assertActive(await store.snapshot("alpha"), "data")).secret, "active-fixture");
});

test("candidate removal leaves active configuration intact while active revocation reaches inherited profiles", async (t) => {
  const { store } = await fixture(t), requirements = requirement([{ id: "read", method: "GET", path: "/read" }]), profile = "b".repeat(64);
  await save(store, requirements, { authType: "bearer", secret: "active-fixture" });
  await store.save("alpha", { id: "data" }, requirements, { profile });
  const inherited = await store.snapshot("alpha", { profile });
  await store.remove("alpha", "data", { profile });
  assert.equal((await store.assertActive(await store.snapshot("alpha"), "data")).secret, "active-fixture");
  await store.save("alpha", { id: "data", kind: "business", baseUrl: "http://127.0.0.1:32100", secret: "different" }, requirements, { profile });
  await assert.rejects(store.assertActive(inherited, "data"), { reason: "connection_revoked" });
  const another = "c".repeat(64); await store.save("alpha", { id: "data" }, requirements, { profile: another }); const shared = await store.snapshot("alpha", { profile: another });
  await store.remove("alpha", "data"); await assert.rejects(store.assertActive(shared, "data"), { reason: "connection_revoked" });
});

test("nested connection records are checked without rewriting valid legacy fields or damaged bytes", async (t) => {
  const { store, dataDir } = await fixture(t);
  const valid = { schemaVersion: 1, agentId: "alpha", version: 1, connections: { model: { id: "model", currentVersion: 1,
    generation: "fixture", versions: { 1: { id: "model", kind: "model", version: 1, generation: "fixture", authType: "none" } } } } };
  const file = join(dataDir, "agents/alpha/private/connections.json");
  await store.storage.writeJson("alpha", "private/connections.json", valid);
  assert.deepEqual(await store.readRoot("alpha"), valid);
  for (const corrupt of [
    (record: { connections: { model: { versions: never[]; }; }; }) => { record.connections.model.versions = []; },
    (record: { connections: { model: { versions: { oauth: { scopes: number[]; }; }[]; }; }; }) => { record.connections!.model.versions[1]!.oauth = { scopes: [42] }; },
    (record: { connections: { model: { versions: { values: never[]; }[]; }; }; }) => { record.connections!.model.versions[1]!.values = []; },
    (record: { connections: { model: { versions: { discovery: { tools: { name: string; inputSchema: never[]; contractHash: string; }[]; }; }[]; }; }; }) => { record.connections!.model.versions[1]!.discovery = { tools: [{ name: "tool", inputSchema: [], contractHash: "fixture" }] }; },
    (record: { connections: { model: { versions: { configurationChoices: { region: { label: string; value: number; }[]; }; }[]; }; }; }) => { record.connections!.model.versions[1]!.configurationChoices = { region: [{ label: "Region", value: 42 }] }; },
    (record: { profiles: { candidate: { schemaVersion: number; agentId: string; version: number; connections: null; }; }; }) => { record.profiles = { candidate: { schemaVersion: 1, agentId: "alpha", version: 1, connections: null } }; },
    (record: { revokedGenerations: { fixture: string; }; }) => { record.revokedGenerations = { fixture: "yes" }; },
  ]) {
    const damaged = structuredClone(valid); callFixture(corrupt, undefined, [damaged]);
    await store.storage.writeJson("alpha", "private/connections.json", damaged);
    const bytes = await readFile(file, "utf8");
    await assert.rejects(store.list("alpha"), { reason: "invalid_connection_record" });
    assert.equal(await readFile(file, "utf8"), bytes);
  }
});
