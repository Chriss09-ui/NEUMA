import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../../src/server.mjs";

async function fixture(t: test.TestContext) {
  const server = createApp({ config: {}, providers: {}, projects: {}, projectAgent: {}, prototypeAgents: {}, skillManager: {} });
  t.after(async () => {
    await server.dispose();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  });
  await server.ready;
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  return `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
}

test("Markdown 与公式库及字体使用本机固定资源，内容与安装依赖一致", async (t) => {
  const base = await fixture(t), katexRoot = dirname(fileURLToPath(import.meta.resolve("katex")));
  const assets: [string,string,string][] = [
    ["/vendor/marked.mjs", fileURLToPath(import.meta.resolve("marked")), "text/javascript; charset=utf-8"],
    ["/vendor/katex/katex.mjs", resolve(katexRoot, "katex.mjs"), "text/javascript; charset=utf-8"],
    ["/vendor/katex/katex.min.css", resolve(katexRoot, "katex.min.css"), "text/css; charset=utf-8"],
  ];
  const css = await readFile(resolve(katexRoot, "katex.min.css"), "utf8");
  const fonts = [...new Set([...css.matchAll(/url\(([^)]+)\)/g)].map((match) => match[1]!))];
  assert.ok(fonts.length > 0, "公式样式应声明本地字体");
  for (const font of fonts) {
    assert.match(font, /^fonts\/KaTeX_[A-Za-z0-9_-]+\.(woff2|woff|ttf)$/);
    const extension = font!.slice(font!.lastIndexOf(".") + 1);
    assets.push([`/vendor/katex/${font}`, resolve(katexRoot, font), `font/${extension}`]);
  }
  for (const [path, file, type] of assets) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("content-type"), type, path);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", path);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(file), path);
  }
});

test("页面通过本机 importmap 和样式加载 Markdown 与公式解析，不依赖 CDN", async (t) => {
  const base = await fixture(t), page = await (await fetch(base)).text();
  const importmap = page.match(/<script\b(?=[^>]*type=["']importmap["'])[^>]*>([\s\S]*?)<\/script>/i);
  assert.ok(importmap, "页面必须提供浏览器模块映射");
  const imports = JSON.parse(importmap[1]!).imports;
  assert.equal(imports.marked, "/vendor/marked.mjs");
  assert.equal(imports.katex, "/vendor/katex/katex.mjs");
  assert.match(page, /<link\b[^>]*href=["']\/vendor\/katex\/katex\.min\.css["']/);
  const response = await fetch(base + "/rich-text.js");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /^text\/javascript/);
  assert.equal(await response.text(), await readFile(new URL("../../public/rich-text.js", import.meta.url), "utf8"));
});

test("依赖资源白名单拒绝未知文件、路径穿越及不支持的方法", async (t) => {
  const base = await fixture(t);
  for (const path of [
    "/vendor/unknown.mjs", "/vendor/katex/package.json", "/vendor/katex/src/functions.ts",
    "/vendor/katex/fonts/KaTeX_Unknown-Regular.woff2", "/vendor/katex/fonts/KaTeX_Main-Regular.svg",
    "/vendor/katex/fonts/../../package.json", "/vendor/katex/fonts/%2e%2e/%2e%2e/package.json",
    "/vendor/katex/fonts/KaTeX_Main-Regular.woff2%2f..%2fpackage.json",
    "/vendor/katex/fonts/KaTeX_Main-Regular.woff2%5c..%5cpackage.json",
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: "页面不存在" }, path);
  }
  const response = await fetch(base + "/vendor/marked.mjs", { method: "HEAD" });
  assert.equal(response.status, 404);
});
