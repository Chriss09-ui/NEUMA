import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationResources } from "../../src/applications/application-resources.mjs";
import vm from "node:vm";
import type { BinaryLike } from "crypto";
const hash = (value: BinaryLike) => createHash("sha256").update(value).digest("hex");
async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "neuma-app-resources-")));
  const service = new ApplicationResources();
  t.after(async () => { await service.closeAll(); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, "ui")); const html = '<!doctype html><html><head><script>window.started=typeof window.neuma?.actions.run==="function"</script></head><body>Application</body></html>';
  await writeFile(join(root, "ui/index.html"), html); await writeFile(join(root, "backend.mjs"), "export const actions={};");
  const config = { agentId: "agent-a", deliveryVersion: "build:hash", codeDir: root, parentOrigin: "http://localhost:3000",
    manifest: { page: { entrypoint: "ui/index.html", resources: [{ path: "ui/index.html", sha256: hash(html) }] } } };
  return { root, service, config };
}
test("resources use distinct origins, only serve manifest and inject bound bridge", async (t) => {
  const { service, config } = await fixture(t);
  const first = await service.open(config), second = await service.open({ ...config, agentId: "agent-b" });
  assert.notEqual(first.origin, second.origin);
  assert.deepEqual(service.assertInstance("agent-a", first.instanceId, config.deliveryVersion),
    { instanceId: first.instanceId, agentId: "agent-a", deliveryVersion: config.deliveryVersion });
  assert.throws(() => service.assertInstance("agent-b", first.instanceId, config.deliveryVersion), /其他 Agent/);
  assert.throws(() => service.assertInstance("agent-a", first.instanceId, "old-version"), /版本/);
  const response = await fetch(first.url), html = await response.text();
  assert.equal(response.status, 200);
  const ready: { message: { type: string; instanceId: string; deliveryVersion: string }; origin: string }[] = [];
  const frame = { started: false, parent: { postMessage(message: typeof ready[number]["message"], origin: string) { ready.push({ message, origin }); } }, addEventListener() {} };
  const context = vm.createContext({ window: frame, setTimeout, clearTimeout });
  let bridgeLoaded = false;
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const src = /\bsrc\s*=\s*(["'])(.*?)\1/i.exec(script[1]!)?.[2];
    if (src !== undefined) {
      const url = new URL(src, first.url);
      assert.equal(url.origin, first.origin);
      assert.equal(url.pathname, `/${first.instanceId}/neuma-frame-bridge.js`);
      const bridge = await fetch(url);
      assert.equal(bridge.status, 200);
      assert.match(bridge.headers.get("content-type")!, /^text\/javascript/);
      vm.runInContext(await bridge.text(), context);
      bridgeLoaded = true;
    } else vm.runInContext(script[2]!, context);
  }
  assert.equal(bridgeLoaded, true, "交付页面必须实际引用可读取的桥接脚本");
  assert.equal(frame.started, true, "桥接应在页面业务脚本之前初始化公开 API");
  assert.equal(ready.length, 1);
  assert.equal(ready[0]!.origin, config.parentOrigin);
  assert.equal(ready[0]!.message.type, "document.ready");
  assert.equal(ready[0]!.message.instanceId, first.instanceId);
  assert.equal(ready[0]!.message.deliveryVersion, config.deliveryVersion);
  assert.match(response.headers.get("content-security-policy")!, /connect-src 'none'/);
  assert.match(response.headers.get("content-security-policy")!, /frame-ancestors http:\/\/localhost:3000/);
  for (const path of ["backend.mjs", "..%2fbackend.mjs", "config.json", "%2e%2e%2fui/index.html"]) {
    assert.equal((await fetch(`${first.origin}/${first.instanceId}/${path}`)).status, 404);
  }
  await assert.rejects(service.close("agent-b", first.instanceId), /其他 Agent/);
  await service.close("agent-a", first.instanceId);
  assert.throws(() => service.assertInstance("agent-a", first.instanceId, config.deliveryVersion), /已关闭/);
  await assert.rejects(fetch(first.url));
  assert.equal((await fetch(second.url)).status, 200);
});
test("unverified resource hashes and symbolic resources cannot be opened", async (t) => {
  const { root, service, config } = await fixture(t);
  await writeFile(join(root, "ui/index.html"), "changed after verification");
  await assert.rejects(service.open(config), /版本不一致/);
  await rm(join(root, "ui/index.html")); await symlink(join(root, "backend.mjs"), join(root, "ui/index.html"));
  await assert.rejects(service.open(config), /链接/);
  await assert.rejects(service.open({ ...config, parentOrigin: "https://evil.example" }), /本机/);
});
