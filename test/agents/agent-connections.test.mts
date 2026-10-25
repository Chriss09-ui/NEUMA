import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentConnectionStore } from "../../src/agents/agent-connections.mjs";
import { WebCapabilities } from "../../src/runtime/web-capabilities.mjs";

const json = (value: { id?: string; echoed?: string; authorization?: string; ok?: boolean; results?: { title: string; url: string; content: string; }[]; }, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const requirements = [{ id: "orders", purpose: "business", required: true, description: "订单服务", operations: [
  { id: "list", method: "GET", path: "/orders", input: "limit number", output: "orders array", safeTest: true },
  { id: "create", method: "POST", path: "/orders", input: "name string", output: "id string", safeTest: false },
] }];
async function fixture(t: test.TestContext, options: Partial<ConstructorParameters<typeof AgentConnectionStore>[0]> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "neuma-connections-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { dataDir, store: new AgentConnectionStore({ dataDir, credentialKeySource: async () => Buffer.alloc(32, 7), ...options }) };
}

test("connections stay per agent, redacted and private; failed save preserves prior state", async (t) => {
  const { store, dataDir } = await fixture(t);
  const secret = "test-credential-not-a-real-key";
  const saved = await store.save("alpha", { id: "search", kind: "search", provider: "tavily", secret });
  assert.equal(saved.connections[0]!.hasSecret, true); assert.equal(JSON.stringify(saved).includes(secret), false);
  assert.deepEqual((await store.list("beta")).connections, []);
  assert.equal(JSON.stringify(await store.snapshot("alpha")).includes(secret), false);
  const path = join(dataDir, "agents/alpha/private/connections.json");
  assert.equal((await stat(path)).mode & 0o777, 0o600); assert.equal((await readFile(path, "utf8")).includes(secret), false);
  await assert.rejects(store.save("alpha", { id: "search", kind: "search", provider: "tavily", secret: "changed", expectedVersion: 0 }), { reason: "connection_conflict" });
  const write = store.storage.writeJson; store.storage.writeJson = async () => { throw new Error("disk failed"); };
  await assert.rejects(store.save("alpha", { id: "search", kind: "search", provider: "tavily", secret: "changed" }));
  store.storage.writeJson = write;
  assert.equal((await store.resolveKind(await store.snapshot("alpha"), "search"))!.secret, secret);
});

test("new tasks use updated versions while revocation also blocks older versions after re-add", async (t) => {
  const { store } = await fixture(t);
  await store.save("alpha", { id: "model", kind: "model", baseUrl: "http://127.0.0.1:43120/v1", model: "first", secret: "first-secret" });
  const old = await store.snapshot("alpha");
  await store.save("alpha", { id: "model", model: "second", secret: "second-secret" });
  const current = await store.snapshot("alpha"), platform = { model: "platform", apiKey: "platform-key" };
  assert.equal((await store.modelConfig(old, platform)).model, "first");
  assert.equal((await store.modelConfig(current, platform)).model, "second");
  assert.deepEqual(await store.modelConfig(await store.snapshot("beta"), platform), platform);
  await store.remove("alpha", "model");
  await assert.rejects(store.modelConfig(old, platform), { reason: "connection_revoked" });
  await store.save("alpha", { id: "model", kind: "model", baseUrl: "http://127.0.0.1:43120/v1", model: "third", secret: "third-secret" });
  await assert.rejects(store.modelConfig(current, platform), { reason: "connection_revoked" });
});

test("business calls use only designed operations and inject auth outside arguments", async (t) => {
  const requests: { url: string | URL | Request; options: RequestInit | undefined }[] = [];
  const { store } = await fixture(t, { fetchImpl: async (url, options) => {
    requests.push({ url, options }); return json({ id: "one", echoed: "business-test-key", authorization: "must disappear" });
  } });
  await assert.rejects(store.save("alpha", { id: "orders", kind: "business", baseUrl: "http://localhost:8123/v1", secret: "business-test-key" }), { reason: "connection_not_designed" });
  await store.save("alpha", { id: "orders", kind: "business", baseUrl: "http://localhost:8123/v1", authType: "header", headerName: "X-Service-Key", secret: "business-test-key" }, requirements);
  const snapshot = await store.snapshot("alpha");
  const result = await store.call(snapshot, { connectionId: "orders", operationId: "list", input: { limit: 2 } }, { requirements });
  assert.equal(requests[0]!.url, "http://localhost:8123/v1/orders?limit=2");
  assert.equal(new Headers(requests[0]!.options!.headers).get("X-Service-Key"), "business-test-key");
  assert.equal(requests[0]!.options!.redirect, "manual"); assert.equal(JSON.stringify(result).includes("business-test-key"), false);
  await assert.rejects(store.call(snapshot, { connectionId: "orders", operationId: "arbitrary" }, { requirements }), { reason: "operation_not_designed" });
  await assert.rejects(store.call(snapshot, { connectionId: "orders", operationId: "create" }, { requirements, test: true }), { reason: "unsafe_connection_test" });
  assert.equal(requests.length, 1);
});

test("connection tests do not write and report configured-but-unverified without safe GET", async (t) => {
  let calls = 0;
  const { store } = await fixture(t, { fetchImpl: async () => { calls++; return json({ ok: true }); } });
  await store.save("alpha", { id: "orders", kind: "business", baseUrl: "http://localhost:8123", authType: "none" }, requirements);
  const unverified = await store.test("alpha", "orders", { requirements: [{ ...requirements[0]!, operations: [requirements[0]!.operations[1]!] }] });
  assert.equal(unverified.status, "configured"); assert.equal(calls, 0);
  const verified = await store.test("alpha", "orders", { requirements });
  assert.equal(verified.status, "verified"); assert.equal(calls, 1);
  store.fetchImpl = async () => json({}, 401);
  assert.equal((await store.test("alpha", "orders", { requirements })).status, "failed");
});

test("dedicated search only falls back with consent and cached calls honor revocation", async (t) => {
  const { store } = await fixture(t); let calls = 0;
  await store.save("alpha", { id: "search", kind: "search", provider: "tavily", secret: "dedicated-key" });
  const web = new WebCapabilities({ connectionStore: store, fetchImpl: async (_url, options) => {
    calls++;
    if (new Headers(options!.headers).get("authorization")) return json({}, 401);
    return json({ results: [{ title: "public", url: "https://example.com", content: "excerpt" }] });
  } });
  const context = { agentId: "alpha", scope: "private:one", connectionSnapshot: await store.snapshot("alpha") };
  assert.equal((await web.search({ query: "example" }, context)).status, "failed"); assert.equal(calls, 1);
  await store.save("alpha", { id: "search", allowFallback: true });
  context.connectionSnapshot = await store.snapshot("alpha");
  const fallback = await web.search({ query: "example" }, context);
  assert.equal(fallback.status, "ok"); assert.equal(fallback.fallback, true); assert.equal(calls, 3);
  assert.equal((await web.search({ query: "example" }, context)).cached, true);
  await store.remove("alpha", "search");
  await assert.rejects(web.search({ query: "example" }, context), { reason: "connection_revoked" });
  assert.equal(calls, 3);
});

test("business redirects never forward credentials and late revoked results are rejected", async (t) => {
  const { store } = await fixture(t, { fetchImpl: async () => new Response("", { status: 302, headers: { location: "https://other.example" } }) });
  await store.save("alpha", { id: "orders", kind: "business", baseUrl: "http://localhost:8123", secret: "key" }, requirements);
  const snapshot = await store.snapshot("alpha");
  await assert.rejects(store.call(snapshot, { connectionId: "orders", operationId: "list" }, { requirements }), { reason: "redirect_rejected" });
  store.fetchImpl = async () => { await store.remove("alpha", "orders"); return json({ ok: true }); };
  await assert.rejects(store.call(snapshot, { connectionId: "orders", operationId: "list" }, { requirements }), { reason: "connection_revoked" });
});

test("successful business side effect followed by metadata write failure is not retried or marked failed", async (t) => {
  let requests = 0, writes = 0;
  const { store } = await fixture(t, { fetchImpl: async () => { requests++; return json({ id: "created" }); } });
  await store.save("alpha", { id: "orders", kind: "business", baseUrl: "http://localhost:8123", authType: "none" }, requirements);
  const snapshot = await store.snapshot("alpha");
  store.storage.writeJson = async () => { writes++; throw new Error("fixture-disk-error"); };
  await assert.rejects(store.call(snapshot, { connectionId: "orders", operationId: "create" }, { requirements }), (error) => {
    assert.ok(error instanceof Error && "reason" in error); assert.equal(error.reason, "connection_persistence_failed"); assert.doesNotMatch(error.message, /fixture-disk-error/); return true;
  });
  assert.equal(requests, 1); assert.equal(writes, 1);
  assert.equal((await store.list("alpha")).connections[0]!.status, "configured");
});

test("model without a safe list endpoint remains configured and does not issue a completion probe", async (t) => {
  const seen: {url: string | URL | Request; method: string | undefined}[] = [];
  const { store } = await fixture(t, { fetchImpl: async (url, options) => { seen.push({ url, method: options?.method }); return json({}, 404); } });
  await store.save("alpha", { id: "model", kind: "model", baseUrl: "http://localhost:8123/v1", model: "local", authType: "none" });
  const result = await store.test("alpha", "model");
  assert.equal(result.status, "configured"); assert.equal(result.verified, false);
  assert.deepEqual(seen, [{ url: "http://localhost:8123/v1/models", method: "GET" }]);
  assert.equal((await store.list("alpha")).connections[0]!.status, "configured");
});
