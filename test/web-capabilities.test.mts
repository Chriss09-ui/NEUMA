import test from "node:test";
import assert from "node:assert/strict";
import { WebCapabilities, createWebTools, networkAllowed, validatePublicUrl } from "../src/runtime/web-capabilities.mjs";

const context = { agentId: "alpha", scope: "conversation:one" };
const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
const json = (value: { results?: never[]|{ title: string; url: string; raw_content: string; content: string; }[]; message?: string; result?: { content: { type: string; text: string; }[]; }|{ _meta: { "ai.exa/rateLimited": boolean; }; content: { type: string; text: string; }[]; }; jsonrpc?: string; id?: number; }, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const tavily = (text = "真实网页正文") => ({ results: [{ title: "Example", url: "https://example.com/a", raw_content: text, content: text }] });
const head = async () => ({ status: 200, headers: new Headers() });

test("default keyless search keeps provenance, isolated five minute cache, and refresh", async () => {
  let calls = 0, time = 1000;
  const web = new WebCapabilities({ now: () => time, lookup, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, "https://api.tavily.com/search");
    assert.equal(new Headers(options!.headers).get("X-Tavily-Access-Mode"), "keyless"); assert.equal(Object.fromEntries(new Headers(options!.headers)).authorization, undefined);
    assert.equal(options!.redirect, "manual"); return json(tavily());
  } });
  const first = await web.search({ query: "example" }, context);
  assert.equal(first.status, "ok"); assert.equal(first.results[0]!.contentType, "search_excerpt");
  assert.equal(first.results[0]!.url, "https://example.com/a"); assert.ok(first.results[0]!.fetchedAt);
  assert.equal((await web.search({ query: "example" }, context)).cached, true);
  await web.search({ query: "example" }, { ...context, agentId: "beta" });
  await web.search({ query: "example" }, { ...context, scope: "group:one" });
  await web.search({ query: "example", refresh: true }, context);
  time += 300_001; await web.search({ query: "example" }, context);
  assert.equal(calls, 5);
});

test("rate limit falls back to real Exa MCP text, and failures remain explicit", async () => {
  const seen = [];
  const web = new WebCapabilities({ fetchImpl: async (url, options) => {
    seen.push(url);
    if (url.includes("tavily")) return json({}, 429);
    assert.equal(JSON.parse(String(options!.body)).params.name, "web_search_exa");
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Title: Example\nURL: https://example.com/a\nPublished: N/A\nAuthor: N/A\nHighlights:\nPublic excerpt" }] } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const result = await web.search({ query: "example" }, context);
  assert.equal(result.status, "ok"); assert.equal(result.fallback, true); assert.equal(result.provider, "exa");
  assert.equal(result.attempts![0]!.reason, "rate_limited"); assert.equal(seen.length, 2);
  const failed = new WebCapabilities({ fetchImpl: async () => json({}, 429) });
  const failure = await failed.search({ query: "example" }, context);
  assert.equal(failure.status, "failed"); assert.deepEqual<NonNullable<typeof failure>["results"]>(failure.results, []); assert.equal(failure.attempts!.length, 2);
});

test("public URL guards reject all private answers, mapped IPs, credentials and non HTTP", async () => {
  for (const url of ["http://127.0.0.1", "http://2130706433", "http://10.0.0.1", "http://169.254.169.254", "http://localhost/a",
    "http://x.internal", "http://[::1]", "http://[::ffff:127.0.0.1]", "http://[2002:7f00:1::1]", "file:///etc/passwd", "https://u:p@example.com"])
    await assert.rejects(validatePublicUrl(url, { lookup }));
  await assert.rejects(validatePublicUrl("https://example.com", { lookup: async () => [
    { address: "93.184.216.34", family: 4 }, { address: "192.168.1.1", family: 4 }] }), { reason: "private_address" });
  assert.equal((await validatePublicUrl("https://example.com", { lookup })).url.hostname, "example.com");
});

test("redirects are revalidated before extraction and invalid targets never reach providers", async () => {
  let requests = 0, calls = 0;
  const web = new WebCapabilities({ lookup, requestPublic: async () => {
    requests++; return { status: 302, headers: new Headers({ location: "http://127.0.0.1/private" }) };
  }, fetchImpl: async () => { calls++; return json(tavily()); } });
  await assert.rejects(web.fetch({ url: "https://example.com" }, context), { reason: "private_address" });
  assert.equal(requests, 1); assert.equal(calls, 0);
});

test("web_fetch yields actual body, explicit truncation, and authentication failure", async () => {
  const web = new WebCapabilities({ lookup, requestPublic: head, fetchImpl: async () => json(tavily("a".repeat(31_000))) });
  const result = await web.fetch({ url: "https://example.com" }, context);
  assert.equal(result.results[0]!.content.length, 30_000); assert.equal(result.results[0]!.truncated, true);
  assert.equal(result.results[0]!.contentType, "page_text");
  const protectedWeb = new WebCapabilities({ lookup, requestPublic: async () => ({ status: 401, headers: new Headers() }), fetchImpl: async () => assert.fail("must not extract") });
  await assert.rejects(protectedWeb.fetch({ url: "https://example.com" }, context), { reason: "authentication_required" });
});

test("no network requirements block tools before DNS and HTTP, cancellation blocks fallback", async () => {
  for (const text of ["不要联网", "仅使用本地资料", "禁止访问网络", "do not use the internet", "offline only"]) assert.equal(networkAllowed(text), false);
  assert.equal(networkAllowed("检索公开网页"), true);
  const web = new WebCapabilities({ lookup: () => assert.fail("DNS must not run"), fetchImpl: () => assert.fail("HTTP must not run") });
  await assert.rejects(createWebTools({ web, ...context, allowNetwork: false })[0]!.execute("id", { query: "example" }), { reason: "network_disabled" });
  const controller = new AbortController(); let calls = 0;
  const aborted = new WebCapabilities({ fetchImpl: async () => { calls++; controller.abort(); throw new Error("cancelled"); } });
  await assert.rejects(aborted.search({ query: "x" }, { ...context, signal: controller.signal }));
  assert.equal(calls, 1);
});

test("provider malformed/oversized/empty responses cannot masquerade as page reads", async () => {
  for (const response of [() => json({ results: [] }), () => json({ message: "quota exhausted" }), () => json(tavily("x".repeat(1024 * 1024 + 1)))]) {
    const web = new WebCapabilities({ lookup, requestPublic: head, fetchImpl: async (url) => url.includes("tavily") ? response() : json({ result: { content: [{ type: "text", text: "No content found." }] } }) });
    assert.equal((await web.fetch({ url: "https://example.com" }, context)).status, "failed");
  }
});

test("Exa HTTP 200 rate limit metadata is a failure and HEAD 429 can still extract", async () => {
  const limited = new WebCapabilities({ fetchImpl: async (url) => url.includes("tavily") ? json({}, 429)
    : json({ jsonrpc: "2.0", id: 1, result: { _meta: { "ai.exa/rateLimited": true }, content: [{ type: "text", text: "rate limit" }] } }) });
  const result = await limited.search({ query: "example" }, context);
  assert.equal(result.status, "failed"); assert.equal(result.reason, "rate_limited");
  const fetcher = new WebCapabilities({ lookup, requestPublic: async () => ({ status: 429, headers: new Headers() }), fetchImpl: async () => json(tavily()) });
  assert.equal((await fetcher.fetch({ url: "https://example.com" }, context)).status, "ok");
});

test("cancellation during DNS resolution returns before lookup finishes and sends no HTTP", async () => {
  const controller = new AbortController(); let finish;
  const web = new WebCapabilities({ lookup: () => new Promise((resolve) => { finish = resolve; }), fetchImpl: async () => assert.fail("must not send HTTP") });
  const pending = web.fetch({ url: "https://example.com" }, { ...context, signal: controller.signal });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  controller.abort(); await rejected;
  finish!([{ address: "93.184.216.34", family: 4 }]);
});
